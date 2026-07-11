/**
 * Rate limiting and concurrency control middleware.
 *
 * Implements:
 * 1. RPM (Requests Per Minute) — sliding window in-memory counter
 * 2. TPM (Tokens Per Minute) — sliding window with token counts
 * 3. Concurrency — in-memory active request counter
 *
 * Admin users bypass all limits.
 * A limit value of 0 means unlimited.
 */

import type { Request, Response, NextFunction } from "express";
import { config } from "../config.js";
import { getCachedEffectiveLimits, type EffectiveLimits } from "../db/database.js";

// ---------------------------------------------------------------------------
// In-memory tracking structures
// ---------------------------------------------------------------------------

/** key -> array of request timestamps (ms) within the last 60 seconds */
const rpmWindows = new Map<string, number[]>();

/** key -> array of { time, tokens } within the last 60 seconds */
const tpmWindows = new Map<string, Array<{ time: number; tokens: number }>>();

/** key -> current active request count */
const concurrencyCounts = new Map<string, number>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function limiterKey(userId: string, apiKeyId: string): string {
  return `${userId}:${apiKeyId}`;
}

/** Remove entries older than 60 seconds from an RPM window */
function pruneRpmWindow(key: string, now: number): number[] {
  const cutoff = now - 60_000;
  const timestamps = rpmWindows.get(key) ?? [];
  const recent = timestamps.filter((t) => t > cutoff);
  if (recent.length > 0) {
    rpmWindows.set(key, recent);
  } else {
    rpmWindows.delete(key);
  }
  return recent;
}

/** Remove entries older than 60 seconds from a TPM window */
function pruneTpmWindow(key: string, now: number): Array<{ time: number; tokens: number }> {
  const cutoff = now - 60_000;
  const entries = tpmWindows.get(key) ?? [];
  const recent = entries.filter((e) => e.time > cutoff);
  if (recent.length > 0) {
    tpmWindows.set(key, recent);
  } else {
    tpmWindows.delete(key);
  }
  return recent;
}

/**
 * Record token usage for a request.
 * Should be called by server.ts after the response completes (when token counts are known).
 */
export function recordTokenUsage(userId: string, apiKeyId: string, tokens: number): void {
  if (tokens <= 0) return;
  const key = limiterKey(userId, apiKeyId);
  const now = Date.now();
  const entries = tpmWindows.get(key) ?? [];
  entries.push({ time: now, tokens });
  tpmWindows.set(key, entries);
}

/**
 * Release a concurrency slot.
 * Called automatically when the response closes.
 */
function releaseConcurrency(key: string): void {
  const current = concurrencyCounts.get(key) ?? 0;
  if (current > 0) {
    concurrencyCounts.set(key, current - 1);
  }
  if (current <= 1) {
    concurrencyCounts.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Periodic cleanup (every 2 minutes, remove stale entries)
// ---------------------------------------------------------------------------

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key] of rpmWindows) {
    pruneRpmWindow(key, now);
  }
  for (const [key] of tpmWindows) {
    pruneTpmWindow(key, now);
  }
}, 120_000);

// Prevent timer from keeping process alive on exit
cleanupTimer.unref?.();

// ---------------------------------------------------------------------------
// Express middleware
// ---------------------------------------------------------------------------

export async function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const auth = req.auth;
  // No auth info means authMiddleware hasn't run yet — skip
  if (!auth) {
    next();
    return;
  }

  // Admin bypasses all rate limits
  if (auth.isAdmin) {
    next();
    return;
  }

  let limits: EffectiveLimits;
  try {
    limits = await getCachedEffectiveLimits(Number(auth.userId), Number(auth.apiKeyId));
  } catch (err) {
    // If we can't read limits, allow the request (fail-open)
    console.error("[rateLimiter] Failed to get effective limits:", err);
    next();
    return;
  }

  // Share limits with downstream middleware (avoids duplicate DB query)
  res.locals.effectiveLimits = limits;

  // --- Check expiry ---
  if (limits.expiresAt) {
    try {
      const expiry = new Date(limits.expiresAt + (limits.expiresAt.endsWith("Z") ? "" : "Z"));
      if (expiry.getTime() < Date.now()) {
        res.status(403).json({
          error: {
            message: "Your access has expired. Please contact the administrator.",
            type: "expired_access",
            code: "access_expired",
            expired_at: limits.expiresAt,
          },
        });
        return;
      }
    } catch {
      // Invalid date format — ignore expiry check
    }
  }

  const key = limiterKey(auth.userId, auth.apiKeyId);
  const now = Date.now();

  // --- Check RPM ---
  if (limits.rpm > 0) {
    const recent = pruneRpmWindow(key, now);
    if (recent.length >= limits.rpm) {
      const oldest = recent[0];
      const retryAfter = Math.ceil((oldest + 60_000 - now) / 1000);
      res.status(429).json({
        error: {
          message: `Rate limit exceeded: ${limits.rpm} requests per minute. Retry after ${retryAfter}s.`,
          type: "rate_limit_error",
          code: "rpm_exceeded",
          retry_after: retryAfter,
        },
      });
      return;
    }
    recent.push(now);
    rpmWindows.set(key, recent);
  }

  // --- Check TPM (current window tokens) ---
  if (limits.tpm > 0) {
    const entries = pruneTpmWindow(key, now);
    const currentTokens = entries.reduce((sum, e) => sum + e.tokens, 0);
    if (currentTokens >= limits.tpm) {
      res.status(429).json({
        error: {
          message: `Token rate limit exceeded: ${limits.tpm} tokens per minute. Please slow down.`,
          type: "rate_limit_error",
          code: "tpm_exceeded",
        },
      });
      return;
    }
  }

  // --- Check concurrency ---
  if (limits.concurrency > 0) {
    const current = concurrencyCounts.get(key) ?? 0;
    if (current >= limits.concurrency) {
      res.status(429).json({
        error: {
          message: `Concurrency limit exceeded: ${limits.concurrency} simultaneous requests. Please retry shortly.`,
          type: "rate_limit_error",
          code: "concurrency_exceeded",
          retry_after: 5,
        },
      });
      return;
    }
    concurrencyCounts.set(key, current + 1);

    // Release concurrency when response finishes or closes
    const release = (): void => releaseConcurrency(key);
    res.on("close", release);
  }

  next();
}

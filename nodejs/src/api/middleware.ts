/**
 * API Key authentication middleware for Express.
 *
 * Validates API keys with format "sk-s12ryt-..." against the database.
 * Accepts OpenAI-compatible Authorization Bearer, Anthropic-compatible x-api-key,
 * and Google-compatible x-goog-api-key / ?key= authentication.
 * Uses LRU cache to avoid DB queries on repeated requests.
 */

import { Request, Response, NextFunction } from "express";
import { lookupApiKeyCached, getWebUserById, WEB_USER_TG_ID_OFFSET } from "../db/database.js";
import { config } from "../config.js";

const KEY_PREFIX = "sk-s12ryt-";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuthInfo {
  userId: string;
  apiKeyId: string;
  tgUserId: number;
  isAdmin: boolean;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthInfo;
    }
  }
}

// ---------------------------------------------------------------------------
// Public paths that skip authentication
// ---------------------------------------------------------------------------

const PUBLIC_PATHS = new Set(["/", "/health", "/docs"]);

function firstHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function firstQueryValue(value: unknown): string {
  if (Array.isArray(value)) return firstQueryValue(value[0]);
  return typeof value === "string" ? value : "";
}

function extractApiToken(req: Request): { token?: string; error?: string } {
  const authHeader = firstHeaderValue(req.headers.authorization).trim();
  if (authHeader) {
    const parts = authHeader.split(" ", 2);
    if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") {
      return { error: "Invalid Authorization header format" };
    }
    return { token: parts[1].trim() };
  }

  const anthropicApiKey = firstHeaderValue(req.headers["x-api-key"]).trim();
  if (anthropicApiKey) return { token: anthropicApiKey };

  const googleApiKey = firstHeaderValue(req.headers["x-goog-api-key"]).trim();
  if (googleApiKey) return { token: googleApiKey };

  const queryApiKey = firstQueryValue(req.query.key).trim();
  if (queryApiKey) return { token: queryApiKey };

  return { error: "Missing Authorization, x-api-key, x-goog-api-key, or key query" };
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

export async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (PUBLIC_PATHS.has(req.path) || req.method === "OPTIONS") {
    next();
    return;
  }

  // Web panel paths use their own session-based auth — skip API key check
  if (req.path === "/web" || req.path.startsWith("/web/")) {
    next();
    return;
  }

  const { token, error } = extractApiToken(req);
  if (error) {
    res.status(401).json({
      error: { message: error, type: "auth_error" },
    });
    return;
  }

  if (!token?.startsWith(KEY_PREFIX)) {
    res.status(401).json({
      error: { message: "Invalid API key format", type: "auth_error" },
    });
    return;
  }

  try {
    const keyInfo = await lookupApiKeyCached(token);
    if (!keyInfo) {
      res.status(401).json({
        error: { message: "Invalid or inactive API key", type: "auth_error" },
      });
      return;
    }

    // 判斷 admin：telegram 模式比較 ADMIN_ID；password 模式查 web_user is_admin
    let isAdmin = false;
    if (keyInfo.tgUserId === config.ADMIN_ID) {
      isAdmin = true;
    } else if (keyInfo.tgUserId >= WEB_USER_TG_ID_OFFSET) {
      const webUser = await getWebUserById(keyInfo.tgUserId - WEB_USER_TG_ID_OFFSET);
      isAdmin = webUser ? Number(webUser.is_admin) === 1 : false;
    }
    req.auth = {
      userId: String(keyInfo.userId),
      apiKeyId: String(keyInfo.apiKeyId),
      tgUserId: keyInfo.tgUserId,
      isAdmin,
    };
    next();
  } catch (err) {
    console.error("Auth lookup error:", err);
    res.status(500).json({
      error: { message: "Internal authentication error", type: "server_error" },
    });
  }
}

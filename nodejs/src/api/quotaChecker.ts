/**
 * Quota checking middleware.
 *
 * Checks daily/monthly token and cost quotas before processing requests.
 * If any quota is exceeded, returns 429 with a descriptive error.
 *
 * Admin users bypass all quota checks.
 * A limit value of 0 means unlimited.
 *
 * Note: Quotas are checked BEFORE the request is processed, so the current
 * request's token usage is not yet counted. The next request will reflect
 * this request's usage. This is by design — we can't know output tokens
 * until the upstream provider responds.
 */

import type { Request, Response, NextFunction } from "express";
import { config } from "../config.js";
import {
  getEffectiveLimits,
  getDailyUsage,
  getMonthlyUsage,
  type EffectiveLimits,
} from "../db/database.js";

export function quotaCheckMiddleware(req: Request, res: Response, next: NextFunction): void {
  const auth = req.auth;
  if (!auth) {
    next();
    return;
  }

  // Admin bypasses all quota checks
  if (auth.tgUserId === config.ADMIN_ID) {
    next();
    return;
  }

  let limits: EffectiveLimits;
  try {
    limits = getEffectiveLimits(Number(auth.userId), Number(auth.apiKeyId));
  } catch (err) {
    console.error("[quotaChecker] Failed to get effective limits:", err);
    next();
    return;
  }

  // --- Check daily token quota ---
  if (limits.dailyTokenLimit > 0) {
    const daily = getDailyUsage(Number(auth.userId), Number(auth.apiKeyId));
    if (daily.totalTokens >= limits.dailyTokenLimit) {
      res.status(429).json({
        error: {
          message: `Daily token quota exceeded (${daily.totalTokens}/${limits.dailyTokenLimit}). Resets at midnight UTC.`,
          type: "quota_error",
          code: "daily_token_exceeded",
          used: daily.totalTokens,
          limit: limits.dailyTokenLimit,
        },
      });
      return;
    }
  }

  // --- Check monthly token quota ---
  if (limits.monthlyTokenLimit > 0) {
    const monthly = getMonthlyUsage(Number(auth.userId), Number(auth.apiKeyId));
    if (monthly.totalTokens >= limits.monthlyTokenLimit) {
      res.status(429).json({
        error: {
          message: `Monthly token quota exceeded (${monthly.totalTokens}/${limits.monthlyTokenLimit}). Resets at the start of next month.`,
          type: "quota_error",
          code: "monthly_token_exceeded",
          used: monthly.totalTokens,
          limit: limits.monthlyTokenLimit,
        },
      });
      return;
    }
  }

  // --- Check daily cost quota ---
  if (limits.dailyCostLimit > 0) {
    const daily = getDailyUsage(Number(auth.userId), Number(auth.apiKeyId));
    if (daily.totalCost >= limits.dailyCostLimit) {
      res.status(429).json({
        error: {
          message: `Daily cost quota exceeded ($${daily.totalCost.toFixed(4)}/$${limits.dailyCostLimit}). Resets at midnight UTC.`,
          type: "quota_error",
          code: "daily_cost_exceeded",
          used: daily.totalCost,
          limit: limits.dailyCostLimit,
        },
      });
      return;
    }
  }

  // --- Check monthly cost quota ---
  if (limits.monthlyCostLimit > 0) {
    const monthly = getMonthlyUsage(Number(auth.userId), Number(auth.apiKeyId));
    if (monthly.totalCost >= limits.monthlyCostLimit) {
      res.status(429).json({
        error: {
          message: `Monthly cost quota exceeded ($${monthly.totalCost.toFixed(4)}/$${limits.monthlyCostLimit}). Resets at the start of next month.`,
          type: "quota_error",
          code: "monthly_cost_exceeded",
          used: monthly.totalCost,
          limit: limits.monthlyCostLimit,
        },
      });
      return;
    }
  }

  next();
}

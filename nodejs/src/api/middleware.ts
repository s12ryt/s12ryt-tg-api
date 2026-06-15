/**
 * API Key authentication middleware for Express.
 *
 * Validates Bearer tokens with format "sk-s12ryt-..." against the database.
 * Uses LRU cache to avoid DB queries on repeated requests.
 */

import { Request, Response, NextFunction } from "express";
import { lookupApiKeyCached } from "../db/database.js";

const KEY_PREFIX = "sk-s12ryt-";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuthInfo {
  userId: string;
  apiKeyId: string;
  tgUserId: number;
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

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (PUBLIC_PATHS.has(req.path) || req.method === "OPTIONS") {
    next();
    return;
  }

  // Web panel paths use their own session-based auth — skip API key check
  if (req.path === "/web" || req.path.startsWith("/web/")) {
    next();
    return;
  }

  const authHeader = req.headers.authorization ?? "";

  if (!authHeader) {
    res.status(401).json({
      error: { message: "Missing Authorization header", type: "auth_error" },
    });
    return;
  }

  const parts = authHeader.split(" ", 2);
  if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") {
    res.status(401).json({
      error: { message: "Invalid Authorization header format", type: "auth_error" },
    });
    return;
  }

  const token = parts[1].trim();

  if (!token.startsWith(KEY_PREFIX)) {
    res.status(401).json({
      error: { message: "Invalid API key format", type: "auth_error" },
    });
    return;
  }

  try {
    const keyInfo = lookupApiKeyCached(token);
    if (!keyInfo) {
      res.status(401).json({
        error: { message: "Invalid or inactive API key", type: "auth_error" },
      });
      return;
    }

    req.auth = {
      userId: String(keyInfo.userId),
      apiKeyId: String(keyInfo.apiKeyId),
      tgUserId: keyInfo.tgUserId,
    };
    next();
  } catch (err) {
    console.error("Auth lookup error:", err);
    res.status(500).json({
      error: { message: "Internal authentication error", type: "server_error" },
    });
  }
}

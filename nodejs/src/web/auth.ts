/**
 * Web 控制台認證系統
 *
 * 兩階段認證流程：
 *   1. Bot 側呼叫 generateLoginToken(tgUserId) → 產生一次性 OTP（5 分鐘有效）
 *   2. 前端帶 OTP 呼叫 POST /web/api/auth/login → 換取 Session Token（24 小時有效）
 *   3. 後續 API 請求帶 Authorization: Bearer {sessionToken}
 *
 * 安全設計：
 *   - OTP 使用後立即失效（一次性）
 *   - Session 24 小時有效，過期自動清除
 *   - 每 10 分鐘清理過期的 OTP 和 Session
 *   - exchangeToken 與每次請求時重新檢查用戶是否仍為 active
 */

import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";
import { config } from "../config.js";
import { getUserByTgId } from "../db/database.js";

// ---------------------------------------------------------------------------
// 常數
// ---------------------------------------------------------------------------

const OTP_TTL_MS = 5 * 60 * 1000;       // OTP 有效期：5 分鐘
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // Session 有效期：24 小時
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 清理間隔：10 分鐘

// ---------------------------------------------------------------------------
// 內部資料結構
// ---------------------------------------------------------------------------

interface OtpEntry {
  tgUserId: number;
  createdAt: number;
}

interface SessionEntry {
  tgUserId: number;
  isAdmin: boolean;
  createdAt: number;
}

/** OTP token → entry（一次性，用後即刪） */
const otpStore = new Map<string, OtpEntry>();

/** Session token → entry（24h 有效） */
const sessionStore = new Map<string, SessionEntry>();

// ---------------------------------------------------------------------------
// 核心函數
// ---------------------------------------------------------------------------

/**
 * 為指定 Telegram User ID 產生一次性登入 OTP token。
 *
 * 由 Bot handler 呼叫（如 webHandlers.ts），產生的 token 嵌入登入 URL。
 * 同一用戶重複呼叫會產生新 OTP，舊 OTP 不會自動刪除（5 分鐘後自然過期）。
 *
 * @returns 一次性 OTP token 字串
 */
export function generateLoginToken(tgUserId: number): string {
  const token = crypto.randomUUID();
  otpStore.set(token, { tgUserId, createdAt: Date.now() });
  return token;
}

/**
 * 用 OTP token 換取 Session token。
 *
 * 驗證流程：
 *   1. OTP 存在且未過期
 *   2. 用戶在 DB 中仍存在且 is_active（管理員免查）
 *   3. 產生 session token，刪除 OTP（一次性）
 *
 * @returns Session info 或 null（OTP 無效/過期/用戶已停用）
 */
export function exchangeToken(otpToken: string): { sessionToken: string; tgUserId: number; isAdmin: boolean } | null {
  const entry = otpStore.get(otpToken);
  if (!entry) return null;

  // 過期檢查
  if (Date.now() - entry.createdAt > OTP_TTL_MS) {
    otpStore.delete(otpToken);
    return null;
  }

  // 一次性：立即刪除
  otpStore.delete(otpToken);

  const isAdmin = entry.tgUserId === config.ADMIN_ID;

  // 非管理員需確認用戶仍有效
  if (!isAdmin) {
    const user = getUserByTgId(entry.tgUserId);
    if (!user || Number(user.is_active) !== 1) {
      return null;
    }
  }

  // 產生 session
  const sessionToken = crypto.randomUUID();
  sessionStore.set(sessionToken, {
    tgUserId: entry.tgUserId,
    isAdmin,
    createdAt: Date.now(),
  });

  return { sessionToken, tgUserId: entry.tgUserId, isAdmin };
}

/**
 * 取得 session 資訊（不銷毀）。
 *
 * 供中間件和路由使用，返回 null 表示 session 無效/過期。
 */
export function getSessionInfo(sessionToken: string): SessionEntry | null {
  const entry = sessionStore.get(sessionToken);
  if (!entry) return null;

  // 過期檢查
  if (Date.now() - entry.createdAt > SESSION_TTL_MS) {
    sessionStore.delete(sessionToken);
    return null;
  }

  return entry;
}

/**
 * 登出（銷毀 session）。
 */
export function destroySession(sessionToken: string): void {
  sessionStore.delete(sessionToken);
}

// ---------------------------------------------------------------------------
// Express 中間件
// ---------------------------------------------------------------------------

/** 擴充 res.locals 以攜帶認證資訊 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      webAuth?: {
        tgUserId: number;
        isAdmin: boolean;
      };
    }
  }
}

/**
 * Web API 認證中間件。
 *
 * 從 Authorization: Bearer {token} 提取 session token 並驗證。
 * 成功時注入 req.webAuth = { tgUserId, isAdmin }，失敗返回 401。
 */
export function webAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    res.status(401).json({ error: "未提供認證 token" });
    return;
  }

  const token = auth.slice(7);
  const info = getSessionInfo(token);
  if (!info) {
    res.status(401).json({ error: "認證已過期，請重新登入" });
    return;
  }

  // 每次請求重新校驗 isAdmin，不信任 session 創建時快取的值
  // 確保 ADMIN_ID 變更後權限能即時生效
  const isAdmin = info.tgUserId === config.ADMIN_ID;

  if (!isAdmin) {
    const user = getUserByTgId(info.tgUserId);
    if (!user || Number(user.is_active) !== 1) {
      destroySession(token);
      res.status(401).json({ error: "帳號已停用，請重新登入" });
      return;
    }
  }

  req.webAuth = { tgUserId: info.tgUserId, isAdmin };
  next();
}

/**
 * 管理員專用中間件（需在 webAuthMiddleware 之後使用）。
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.webAuth?.isAdmin) {
    res.status(403).json({ error: "需要管理員權限" });
    return;
  }
  next();
}

// ---------------------------------------------------------------------------
// 定期清理
// ---------------------------------------------------------------------------

let cleanupTimer: NodeJS.Timeout | null = null;

/**
 * 啟動定期清理任務，移除過期的 OTP 和 Session。
 *
 * 在應用啟動時呼叫一次即可。
 */
export function startCleanupTimer(): void {
  if (cleanupTimer) return; // 避免重複啟動

  cleanupTimer = setInterval(() => {
    const now = Date.now();

    // 清理過期 OTP
    for (const [token, entry] of otpStore) {
      if (now - entry.createdAt > OTP_TTL_MS) {
        otpStore.delete(token);
      }
    }

    // 清理過期 Session
    for (const [token, entry] of sessionStore) {
      if (now - entry.createdAt > SESSION_TTL_MS) {
        sessionStore.delete(token);
      }
    }
  }, CLEANUP_INTERVAL_MS);

  // 不阻止進程退出
  cleanupTimer.unref();
}

/**
 * 停止清理任務（測試用）。
 */
export function stopCleanupTimer(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

/**
 * 清除所有 OTP 和 Session（測試用）。
 */
export function clearAllAuth(): void {
  otpStore.clear();
  sessionStore.clear();
}

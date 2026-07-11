/**
 * Web 控制台認證系統（雙模式）
 *
 * ## telegram 模式（預設）
 * 兩階段認證：
 *   1. Bot 側呼叫 generateLoginToken(tgUserId) → 產生一次性 OTP（5 分鐘有效）
 *   2. 前端帶 OTP 呼叫 POST /web/api/auth/login → 換取 Session Token（24 小時有效）
 *
 * ## password 模式（WEB_AUTH_MODE=password）
 * 帳密獨立登入：
 *   1. 前端帶 username + password 呼叫 POST /web/api/auth/login
 *   2. 後端驗證密碼 → 換取 Session Token（24 小時有效）
 *   3. Bot 不啟動，不需要 Telegram
 *
 * 安全設計：
 *   - OTP 使用後立即失效（一次性）
 *   - Session 24 小時有效，過期自動清除
 *   - 每 10 分鐘清理過期的 OTP 和 Session
 *   - exchangeToken / exchangePasswordCredentials 與每次請求時重新檢查用戶是否仍為 active
 */

import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";
import { config } from "../config.js";
import {
  getUserByTgId,
  getWebUserByUsername,
  getWebUserById,
  WEB_USER_TG_ID_OFFSET,
} from "../db/database.js";
import { verifyPassword } from "./password.js";

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
  /** 用戶類型：telegram OTP 登入或 password 帳密登入 */
  userType: "telegram" | "password";
  /** Telegram User ID（telegram 模式為真實 ID；password 模式為虛擬 ID） */
  tgUserId: number;
  /** Web User ID（僅 password 模式） */
  webUserId?: number;
  /** 用戶名（僅 password 模式） */
  username?: string;
  isAdmin: boolean;
  createdAt: number;
}

/** OTP token → entry（一次性，用後即刪） */
const otpStore = new Map<string, OtpEntry>();

/** Session token → entry（24h 有效） */
const sessionStore = new Map<string, SessionEntry>();

// ---------------------------------------------------------------------------
// 核心函數 — Telegram OTP 模式
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
export async function exchangeToken(otpToken: string): Promise<{ sessionToken: string; tgUserId: number; isAdmin: boolean } | null> {
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
    const user = await getUserByTgId(entry.tgUserId);
    if (!user || Number(user.is_active) !== 1) {
      return null;
    }
  }

  // 產生 session
  const sessionToken = crypto.randomUUID();
  sessionStore.set(sessionToken, {
    userType: "telegram",
    tgUserId: entry.tgUserId,
    isAdmin,
    createdAt: Date.now(),
  });

  return { sessionToken, tgUserId: entry.tgUserId, isAdmin };
}

// ---------------------------------------------------------------------------
// 核心函數 — Password 帳密模式
// ---------------------------------------------------------------------------

/**
 * 用帳號密碼換取 Session token。
 *
 * 驗證流程：
 *   1. 查找 web_user by username
 *   2. 驗證密碼（scrypt + constant-time compare）
 *   3. 確認 is_active
 *   4. 產生 session token
 *
 * @returns Session info 或 null（用戶不存在/密碼錯誤/已停用）
 */
export async function exchangePasswordCredentials(
  username: string,
  password: string,
): Promise<{ sessionToken: string; tgUserId: number; isAdmin: boolean; webUserId: number; username: string } | null> {
  const webUser = await getWebUserByUsername(username);
  if (!webUser) return null;

  // 確認帳號啟用
  if (Number(webUser.is_active) !== 1) return null;

  // 驗證密碼
  const valid = await verifyPassword(password, webUser.password_hash);
  if (!valid) return null;

  const isAdmin = Number(webUser.is_admin) === 1;

  // 查找對應的虛擬 users 記錄（addWebUser 時建立）
  // 使用 WEB_USER_TG_ID_OFFSET + web_user_id 來計算虛擬 tg_user_id
  const virtualTgUserId = WEB_USER_TG_ID_OFFSET + webUser.id;

  // 確保虛擬記錄存在
  let user = await getUserByTgId(virtualTgUserId);
  if (!user) {
    // 可能是舊版本建立的 web_user 沒有對應虛擬記錄，嘗試透過 username 查找
    // 這裡不自動建立，因為 addWebUser 應該已經建立了
    return null;
  }

  const sessionToken = crypto.randomUUID();
  sessionStore.set(sessionToken, {
    userType: "password",
    tgUserId: virtualTgUserId,
    webUserId: webUser.id,
    username: webUser.username,
    isAdmin,
    createdAt: Date.now(),
  });

  return {
    sessionToken,
    tgUserId: virtualTgUserId,
    isAdmin,
    webUserId: webUser.id,
    username: webUser.username,
  };
}

// ---------------------------------------------------------------------------
// Session 管理
// ---------------------------------------------------------------------------

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

/** 擴充 Request 以攜帶認證資訊 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      webAuth?: {
        /** 用戶類型 */
        userType: "telegram" | "password";
        /** Telegram User ID（telegram 模式為真實 ID；password 模式為虛擬 ID） */
        tgUserId: number;
        /** Web User ID（僅 password 模式） */
        webUserId?: number;
        /** 用戶名（僅 password 模式） */
        username?: string;
        isAdmin: boolean;
      };
    }
  }
}

/**
 * Web API 認證中間件。
 *
 * 從 Authorization: Bearer {token} 提取 session token 並驗證。
 * 成功時注入 req.webAuth，失敗返回 401。
 *
 * 每次請求重新校驗用戶是否仍為 active：
 *   - telegram 模式：檢查 isAdmin + getUserByTgId
 *   - password 模式：檢查 web_user is_active（透過虛擬 users 記錄的 is_active 同步）
 */
export async function webAuthMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
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

  // 每次請求重新校驗權限
  let isAdmin: boolean;
  if (info.userType === "telegram") {
    // telegram 模式：isAdmin = tgUserId === ADMIN_ID
    isAdmin = info.tgUserId === config.ADMIN_ID;

    if (!isAdmin) {
      const user = await getUserByTgId(info.tgUserId);
      if (!user || Number(user.is_active) !== 1) {
        destroySession(token);
        res.status(401).json({ error: "帳號已停用，請重新登入" });
        return;
      }
    }
  } else {
    // password 模式：重新檢查 web_user active + is_admin（不依賴 session 快取）
    const user = await getUserByTgId(info.tgUserId);
    if (!user || Number(user.is_active) !== 1) {
      destroySession(token);
      res.status(401).json({ error: "帳號已停用，請重新登入" });
      return;
    }
    // 重查 web_user is_admin（管理員降級後立即生效）
    if (info.webUserId) {
      const webUser = await getWebUserById(info.webUserId);
      isAdmin = webUser ? Number(webUser.is_admin) === 1 : false;
    } else {
      isAdmin = false;
    }
  }

  req.webAuth = {
    userType: info.userType,
    tgUserId: info.tgUserId,
    webUserId: info.webUserId,
    username: info.username,
    isAdmin,
  };
  next();
  } catch (err) {
    next(err);
  }
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

/**
 * 銷毀指定 web_user 的所有 session（密碼修改後踢出其他設備）。
 */
export function destroySessionsByWebUserId(webUserId: number, exceptToken?: string): void {
  for (const [token, entry] of sessionStore) {
    if (entry.webUserId === webUserId && token !== exceptToken) {
      sessionStore.delete(token);
    }
  }
}

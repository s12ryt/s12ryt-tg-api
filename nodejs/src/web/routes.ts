/**
 * Web 控制台 API 路由
 *
 * 所有路由掛載在 /web 下（由 server.ts 掛載），在 API auth/rate/quota 中間件之前。
 *
 * 路由結構：
 *   POST /web/api/auth/login      — OTP 換 session（公開）
 *   POST /web/api/auth/logout     — 登出（需認證）
 *   GET  /web/api/auth/me         — 當前用戶資訊（需認證）
 *
 *   GET  /web/api/models          — 可用模型列表（需認證）
 *   GET  /web/api/keys            — 我的 API Keys
 *   POST /web/api/keys            — 新增 API Key
 *   DELETE /web/api/keys/:id      — 刪除 API Key
 *   GET  /web/api/usage           — 我的用量
 *   GET  /web/api/coding          — 我的 Coding 設定
 *   PUT  /web/api/coding          — 更新 Coding 設定
 *   GET  /web/api/limits          — 我的有效限制 + 今日/月用量
 *   GET  /web/api/restrictions    — 我的模型限制
 *   GET  /web/api/url             — API 端點 URL
 *
 *   GET    /web/api/admin/providers           — 供應商列表
 *   POST   /web/api/admin/providers           — 新增供應商
 *   PUT    /web/api/admin/providers/:id       — 更新供應商
 *   DELETE /web/api/admin/providers           — 刪除供應商（body: {ids:[]})
 *   GET    /web/api/admin/provider-prices/:id — 供應商的模型定價
 *   PUT    /web/api/admin/provider-prices/:id — 批量更新定價
 *   GET    /web/api/admin/users               — 用戶列表
 *   POST   /web/api/admin/users               — 新增用戶
 *   PUT    /web/api/admin/users/:id/status    — 更新用戶狀態
 *   PUT    /web/api/admin/users/:id/tg-id     — 更新用戶 TG ID
 *   DELETE /web/api/admin/users/:id           — 刪除用戶
 *   GET    /web/api/admin/users/:id/keys      — 用戶的 API Keys
 *   DELETE /web/api/admin/users/:id/keys/:keyId — 刪除用戶 API Key
 *   GET    /web/api/admin/users/:id/limits    — 用戶限制詳情
 *   PUT    /web/api/admin/users/:id/limits    — 設定用戶分組+覆蓋
 *   GET    /web/api/admin/users/:id/restrictions — 用戶模型限制
 *   PUT    /web/api/admin/users/:id/restrictions — 設定模型限制
 *   GET    /web/api/admin/keys/:id/limits     — API Key 限制詳情
 *   PUT    /web/api/admin/keys/:id/limits     — 設定 API Key 覆蓋
 *   GET    /web/api/admin/groups              — 用戶分組列表
 *   POST   /web/api/admin/groups              — 新增分組
 *   PUT    /web/api/admin/groups/:id          — 更新分組
 *   DELETE /web/api/admin/groups/:id          — 刪除分組
 *   GET    /web/api/admin/usage               — 全部用量統計
 *   GET    /web/api/admin/system-usage        — 系統與程式資源佔用
 *   GET    /web/api/admin/plugins             — Node.js 插件列表
 *   POST   /web/api/admin/plugins/upload      — 從 Web 上傳安裝 Node.js 插件
 *   POST   /web/api/admin/plugins/github      — 從 GitHub 連結安裝 Node.js 插件
 *   GET    /web/api/admin/settings            — 系統設定
 *   PUT    /web/api/admin/settings            — 更新系統設定
 */

import { Router, type Request, type Response } from "express";
import os from "os";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import {
  exchangeToken,
  exchangePasswordCredentials,
  destroySession,
  destroySessionsByWebUserId,
  webAuthMiddleware,
  requireAdmin,
  startCleanupTimer,
} from "./auth.js";
import { hashPassword, verifyPassword, validatePasswordStrength, validateUsername } from "./password.js";
import { getPanelPath, regenerateWebPanelUuid } from "./panelUuid.js";
import { config } from "../config.js";
import { getEffectiveApiUrl, getRawConfiguredApiUrl, getEffectiveApiUrlWithSource } from "../apiUrl.js";
import { getTunnelUrl } from "../tunnel.js";
import { parseApiKeys } from "../api/keySelector.js";
import {
  detectApiProtocols,
  fetchProviderModels,
  fetchModelsNoAuth,
  fetchModelsPricing,
} from "../bot/handlers/modelFetcher.js";
import {
  getCurrentVersion,
  fetchAndCheckUpdate,
  performUpdate,
  restartProcess,
  isWorkingDirClean,
  getBackupList,
  rollbackAndRestart,
} from "../updater.js";
import { getApiLogs } from "../api/apiLogStore.js";
import { invalidateUserAgentCache } from "../api/userAgentCache.js";
import { installNodeJsPluginFromContent, listNodeJsPlugins } from "../plugins/index.js";
import {
  // providers
  getProviders, addProvider, updateProvider, deleteProvider,
  getModelPricesByProvider, batchUpsertModelPrices, cleanupModelPrices,
  // users
  getUsers, addUser, getUserByTgId, getUserById, updateUserStatus, deleteUser, updateUserTgId,
  // web users (password mode)
  addWebUser, getWebUserCount, getWebUsers, getWebUserById, getWebUserByUsername,
  updateWebUserStatus, updateWebUserPassword, deleteWebUser,
  // api keys
  addApiKey, getKeysByUser, deleteApiKey,
  // usage
  getUsageByUser, getTotalUsage, getDailyUsage, getMonthlyUsage,
  // coding
  getCodingConfigByTgId, setCodingConfig,
  // model restrictions
  getModelRestrictionsForUser, setModelRestriction, deleteModelRestriction,
  // limits
  getEffectiveLimits, getUserWithLimits, setUserGroup, setUserOverrides,
  getApiKeyWithLimits, setApiKeyOverrides, invalidateEffectiveLimitsCache,
  // groups
  getUserGroups, addUserGroup, updateUserGroup, deleteUserGroup, getDefaultUserGroup, setDefaultUserGroup,
  // settings
  getSetting, setSetting, deleteSetting,
  // cache
  getAllCachedModelNames,
  // model mappings
  getModelMappings, replaceModelMappings,
  restartKeepaliveTimer, isCloudDatabase,
} from "../db/database.js";

// ---------------------------------------------------------------------------
// Router & cleanup
// ---------------------------------------------------------------------------

const router = Router();

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------
/** 設定 web_session cookie（僅 LOGIN_WEB_PATH 模式下生效） */
function setSessionCookie(res: Response, sessionToken: string): void {
  if (!config.LOGIN_WEB_PATH) return;
  res.setHeader("Set-Cookie", `web_session=${sessionToken}; HttpOnly; Path=/; Max-Age=86400; SameSite=Lax`);
}

/** 清除 web_session cookie */
function clearSessionCookie(res: Response): void {
  if (!config.LOGIN_WEB_PATH) return;
  res.setHeader("Set-Cookie", "web_session=; HttpOnly; Path=/; Max-Age=0");
}

function sanitizeProviderTestUrl(url: string, apiType: string): string {
  if (apiType !== "google") return url;
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has("key")) {
      parsed.searchParams.set("key", "REDACTED");
    }
    return parsed.toString();
  } catch {
    return url.replace(/([?&]key=)[^&]+/i, "$1REDACTED");
  }
}

const PROVIDER_DEFAULT_USER_AGENT_SETTING = "provider_default_user_agent";
const MAX_USER_AGENT_LENGTH = 256;
const MAX_PLUGIN_SOURCE_BYTES = 10 * 1024 * 1024;

type ResolvedGitHubPlugin = {
  rawUrl: string;
  filename: string;
  sourceUrl: string;
};

function sanitizeUserAgent(value: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: "" };
  if (typeof value !== "string") return { ok: false, error: "User-Agent 必須是文字" };
  const trimmed = value.trim();
  if (trimmed.length > MAX_USER_AGENT_LENGTH) {
    return { ok: false, error: `User-Agent 長度不可超過 ${MAX_USER_AGENT_LENGTH} 字元` };
  }
  if (/[\r\n]/.test(trimmed)) {
    return { ok: false, error: "User-Agent 不可包含換行字元" };
  }
  return { ok: true, value: trimmed };
}

async function getProviderDefaultUserAgent(): Promise<string> {
  const sanitized = sanitizeUserAgent(await getSetting(PROVIDER_DEFAULT_USER_AGENT_SETTING));
  return sanitized.ok ? sanitized.value : "";
}

async function buildUserAgentHeader(providerUserAgent: unknown): Promise<Record<string, string>> {
  const sanitizedProvider = sanitizeUserAgent(providerUserAgent);
  const userAgent = sanitizedProvider.ok && sanitizedProvider.value
    ? sanitizedProvider.value
    : await getProviderDefaultUserAgent();
  return userAgent ? { "User-Agent": userAgent } : {};
}

function assertPluginEntryFilename(filename: string): void {
  const ext = path.extname(filename).toLowerCase();
  if (ext !== ".js" && ext !== ".mjs") {
    throw new Error("插件入口必須是 .js 或 .mjs 檔案");
  }
}

function getFilenameFromPathname(pathname: string): string {
  const filename = path.basename(pathname);
  assertPluginEntryFilename(filename);
  return filename;
}

function buildRawGitHubUrl(owner: string, repo: string, ref: string, filePath: string): string {
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath}`;
}

async function fetchTextWithLimit(url: string, timeoutMs = 15000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "s12ryt-tg-api-plugin-installer" },
    });
    if (!response.ok) throw new Error(`下載失敗: HTTP ${response.status}`);
    const length = response.headers.get("content-length");
    if (length && Number(length) > MAX_PLUGIN_SOURCE_BYTES) {
      throw new Error("插件檔案超過 10MB 上限");
    }
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_PLUGIN_SOURCE_BYTES) {
      throw new Error("插件檔案超過 10MB 上限");
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveRepoPluginSource(owner: string, repo: string, ref: string | null, sourceUrl: string): Promise<ResolvedGitHubPlugin> {
  const refs = ref ? [ref] : ["main", "master"];
  let lastError: unknown = null;

  for (const candidateRef of refs) {
    const manifestUrl = buildRawGitHubUrl(owner, repo, candidateRef, "plugin.json");
    try {
      const manifest = JSON.parse(await fetchTextWithLimit(manifestUrl)) as { main?: unknown };
      if (typeof manifest.main !== "string" || !manifest.main.trim()) {
        throw new Error("plugin.json 缺少 main 欄位");
      }
      const entry = manifest.main.replace(/^\.\//, "");
      const filename = getFilenameFromPathname(entry);
      return {
        rawUrl: buildRawGitHubUrl(owner, repo, candidateRef, entry),
        filename,
        sourceUrl,
      };
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(`找不到可用的 plugin.json 入口: ${String((lastError as Error | null)?.message ?? lastError)}`);
}

async function resolveGitHubPluginSource(value: unknown): Promise<ResolvedGitHubPlugin> {
  if (typeof value !== "string" || !value.trim()) throw new Error("GitHub 連結不能為空");
  const sourceUrl = value.trim();
  const url = new URL(sourceUrl);
  if (url.protocol !== "https:") throw new Error("只支援 https GitHub 連結");

  if (url.hostname === "raw.githubusercontent.com") {
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length < 4) throw new Error("raw GitHub 連結格式不正確");
    return {
      rawUrl: `https://raw.githubusercontent.com/${segments.join("/")}`,
      filename: getFilenameFromPathname(url.pathname),
      sourceUrl,
    };
  }

  if (url.hostname !== "github.com") throw new Error("只支援 github.com 或 raw.githubusercontent.com");

  const segments = url.pathname.split("/").filter(Boolean);
  const [owner, repo, action, ref, ...fileParts] = segments;
  if (!owner || !repo) throw new Error("GitHub repo 連結格式不正確");

  if ((action === "blob" || action === "raw") && ref && fileParts.length > 0) {
    const filePath = fileParts.join("/");
    return {
      rawUrl: buildRawGitHubUrl(owner, repo, ref, filePath),
      filename: getFilenameFromPathname(filePath),
      sourceUrl,
    };
  }

  if (!action) return resolveRepoPluginSource(owner, repo, null, sourceUrl);
  if (action === "tree" && ref) return resolveRepoPluginSource(owner, repo, ref, sourceUrl);

  throw new Error("GitHub 連結需是 .js/.mjs 檔案、repo 根目錄，或 tree 連結");
}

type CpuTimesSnapshot = { idle: number; total: number };
type ProcessCpuSnapshot = { usage: NodeJS.CpuUsage; timestamp: bigint };

let lastSystemCpuSnapshot: CpuTimesSnapshot | null = null;
let lastProcessCpuSnapshot: ProcessCpuSnapshot | null = null;

function roundUsage(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function bytesToMb(bytes: number): number {
  return roundUsage(bytes / 1024 / 1024, 2);
}

function bytesToGb(bytes: number): number {
  return roundUsage(bytes / 1024 / 1024 / 1024, 2);
}

function getCpuTimesSnapshot(): CpuTimesSnapshot {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;

  for (const cpu of cpus) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }

  return { idle, total };
}

function calculateSystemCpuPercent(current: CpuTimesSnapshot): number | null {
  if (!lastSystemCpuSnapshot) {
    lastSystemCpuSnapshot = current;
    return null;
  }

  const idleDelta = current.idle - lastSystemCpuSnapshot.idle;
  const totalDelta = current.total - lastSystemCpuSnapshot.total;
  lastSystemCpuSnapshot = current;

  if (totalDelta <= 0) return null;
  return roundUsage(clampPercent((1 - idleDelta / totalDelta) * 100), 2);
}

function calculateProcessCpuPercent(cpuCount: number): number | null {
  const current = { usage: process.cpuUsage(), timestamp: process.hrtime.bigint() };
  if (!lastProcessCpuSnapshot) {
    lastProcessCpuSnapshot = current;
    return null;
  }

  const usageDelta = process.cpuUsage(lastProcessCpuSnapshot.usage);
  const elapsedMicros = Number(current.timestamp - lastProcessCpuSnapshot.timestamp) / 1000;
  lastProcessCpuSnapshot = current;

  if (elapsedMicros <= 0 || cpuCount <= 0) return null;
  const usedMicros = usageDelta.user + usageDelta.system;
  return roundUsage(clampPercent((usedMicros / elapsedMicros / cpuCount) * 100), 2);
}

function getSystemUsageSnapshot() {
  const cpus = os.cpus();
  const cpuCount = cpus.length || 1;
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = Math.max(0, totalMem - freeMem);
  const memoryUsage = process.memoryUsage();
  const heapUsedPercent = memoryUsage.heapTotal > 0
    ? roundUsage((memoryUsage.heapUsed / memoryUsage.heapTotal) * 100, 2)
    : null;

  return {
    timestamp: new Date().toISOString(),
    system: {
      platform: os.platform(),
      arch: os.arch(),
      hostname: os.hostname(),
      uptimeSec: Math.round(os.uptime()),
      cpuCount,
      loadAverage: os.loadavg().map((value) => roundUsage(value, 2)),
      cpuPercent: calculateSystemCpuPercent(getCpuTimesSnapshot()),
      memory: {
        totalBytes: totalMem,
        usedBytes: usedMem,
        freeBytes: freeMem,
        usedPercent: totalMem > 0 ? roundUsage((usedMem / totalMem) * 100, 2) : null,
        totalGb: bytesToGb(totalMem),
        usedGb: bytesToGb(usedMem),
        freeGb: bytesToGb(freeMem),
      },
    },
    process: {
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      cpuPercent: calculateProcessCpuPercent(cpuCount),
      memory: {
        rssBytes: memoryUsage.rss,
        heapTotalBytes: memoryUsage.heapTotal,
        heapUsedBytes: memoryUsage.heapUsed,
        externalBytes: memoryUsage.external,
        arrayBuffersBytes: memoryUsage.arrayBuffers,
        rssMb: bytesToMb(memoryUsage.rss),
        heapTotalMb: bytesToMb(memoryUsage.heapTotal),
        heapUsedMb: bytesToMb(memoryUsage.heapUsed),
        externalMb: bytesToMb(memoryUsage.external),
        arrayBuffersMb: bytesToMb(memoryUsage.arrayBuffers),
        heapUsedPercent,
      },
      versions: {
        node: process.version,
        v8: process.versions.v8,
      },
    },
  };
}

// 啟動 OTP/Session 清理任務
startCleanupTimer();

// ---------------------------------------------------------------------------
// Auth routes（公開 — login / config / setup 不需要 session）
// ---------------------------------------------------------------------------

/**
 * GET /web/api/auth/config — 前端偵測認證模式（公開）
 *
 * 讓前端在載入時知道：
 *   - authMode: "telegram" | "password"
 *   - needsSetup: password 模式下是否需要初始化（無 web_user 時）
 */
router.get("/api/auth/config", async (_req: Request, res: Response) => {
  const authMode = config.WEB_AUTH_MODE;
  let needsSetup = false;
  if (authMode === "password") {
    const count = await getWebUserCount();
    needsSetup = count === 0;
  }
  res.json({ authMode, needsSetup, loginPath: config.LOGIN_WEB_PATH || null });
});

/**
 * POST /web/api/auth/setup — 首次初始化管理員帳號（公開，僅 password 模式 + 無用戶時可用）
 *
 * 建立第一個 is_admin=1 的 web_user。
 * 之後所有呼叫都會返回 403（已有用戶）或 400（非 password 模式）。
 */
router.post("/api/auth/setup", async (req: Request, res: Response) => {
  if (config.WEB_AUTH_MODE !== "password") {
    res.status(400).json({ error: "此功能僅在 WEB_AUTH_MODE=password 時可用" });
    return;
  }

  // 安全檢查：已有 web_user 時拒絕
  const existingCount = await getWebUserCount();
  if (existingCount > 0) {
    res.status(403).json({ error: "系統已初始化，請使用一般登入" });
    return;
  }

  const { username, password } = req.body;
  if (typeof username !== "string" || typeof password !== "string") {
    res.status(400).json({ error: "請提供 username 和 password" });
    return;
  }

  const usernameError = validateUsername(username);
  if (usernameError) {
    res.status(400).json({ error: usernameError });
    return;
  }

  const passwordError = validatePasswordStrength(password);
  if (passwordError) {
    res.status(400).json({ error: passwordError });
    return;
  }

  try {
    const passwordHash = await hashPassword(password);
    await addWebUser(username, passwordHash, 1); // is_admin = 1

    // 立即登入
    const result = await exchangePasswordCredentials(username, password);
    if (!result) {
      res.status(500).json({ error: "初始化成功但自動登入失敗，請手動登入" });
      return;
    }
    setSessionCookie(res, result.sessionToken);
    res.json({
      sessionToken: result.sessionToken,
      isAdmin: result.isAdmin,
      username: result.username,
    });
  } catch (err) {
    // UNIQUE constraint 衝突（跨 DB 方言通用比對）
    const msg = err instanceof Error ? err.message : String(err);
    if (/unique|duplicate/i.test(msg)) {
      res.status(409).json({ error: "使用者名稱已存在" });
      return;
    }
    console.error("[web] setup error:", err);
    res.status(500).json({ error: "初始化失敗" });
  }
});

/**
 * POST /web/api/auth/login — 登入（根據 WEB_AUTH_MODE 分叉）
 *
 * telegram 模式：{ token: "OTP" } → exchangeToken
 * password 模式：{ username, password } → exchangePasswordCredentials
 */
router.post("/api/auth/login", async (req: Request, res: Response) => {
  if (config.WEB_AUTH_MODE === "password") {
    // ---- password 模式 ----
    const { username, password } = req.body;
    if (typeof username !== "string" || typeof password !== "string") {
      res.status(400).json({ error: "請提供 username 和 password" });
      return;
    }

    const result = await exchangePasswordCredentials(username, password);
    if (!result) {
      // 統一錯誤訊息防止用戶名枚舉
      res.status(401).json({ error: "帳號或密碼錯誤" });
      return;
    }

    setSessionCookie(res, result.sessionToken);
    res.json({
      sessionToken: result.sessionToken,
      tgUserId: result.tgUserId,
      isAdmin: result.isAdmin,
      username: result.username,
    });
    return;
  }

  // ---- telegram 模式（預設）----
  const { token } = req.body;
  if (!token || typeof token !== "string") {
    res.status(400).json({ error: "缺少 token 參數" });
    return;
  }

  const result = await exchangeToken(token);
  if (!result) {
    res.status(401).json({ error: "登入連結已過期或無效，請重新產生" });
    return;
  }

  setSessionCookie(res, result.sessionToken);
  res.json({
    sessionToken: result.sessionToken,
    tgUserId: result.tgUserId,
    isAdmin: result.isAdmin,
  });
});

// 以下路由都需要認證
router.use(webAuthMiddleware);

/** POST /web/api/auth/logout */
router.post("/api/auth/logout", async (req: Request, res: Response) => {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    destroySession(auth.slice(7));
  }
  clearSessionCookie(res);
  res.json({ ok: true });
});

/** GET /web/api/auth/me — 當前用戶資訊 */
router.get("/api/auth/me", async (req: Request, res: Response) => {
  const { tgUserId, isAdmin, userType, username } = req.webAuth!;
  const user = await getUserByTgId(tgUserId);
  const panelPath = await getPanelPath();
  res.json({
    tgUserId,
    isAdmin,
    userType,
    panelPath,
    username: userType === "password" ? (username ?? null) : (user?.username ?? null),
    isActive: user ? Number(user.is_active) === 1 : true,
  });
});

/** PUT /web/api/auth/password — 修改自己的密碼（僅 password 模式） */
router.put("/api/auth/password", async (req: Request, res: Response) => {
  const webAuth = req.webAuth!;
  if (webAuth.userType !== "password" || !webAuth.webUserId) {
    res.status(400).json({ error: "此功能僅在帳密模式下可用" });
    return;
  }

  const { currentPassword, newPassword } = req.body;
  if (typeof currentPassword !== "string" || typeof newPassword !== "string") {
    res.status(400).json({ error: "請提供 currentPassword 和 newPassword" });
    return;
  }

  const passwordError = validatePasswordStrength(newPassword);
  if (passwordError) {
    res.status(400).json({ error: passwordError });
    return;
  }

  // 驗證舊密碼
  const webUser = await getWebUserById(webAuth.webUserId);
  if (!webUser) {
    res.status(404).json({ error: "用戶不存在" });
    return;
  }

  const valid = await verifyPassword(currentPassword, webUser.password_hash);
  if (!valid) {
    res.status(401).json({ error: "目前密碼錯誤" });
    return;
  }

  try {
    const newHash = await hashPassword(newPassword);
    await updateWebUserPassword(webAuth.webUserId, newHash);
    // 銷毀其他設備的 session（保留當前 session）
    const currentToken = req.headers.authorization?.slice(7);
    destroySessionsByWebUserId(webAuth.webUserId, currentToken);
    res.json({ ok: true });
  } catch (err) {
    console.error("[web] changePassword error:", err);
    res.status(500).json({ error: "修改密碼失敗" });
  }
});
/** POST /web/api/admin/regenerate-panel-path — 重新生成 /{uuid}/web 路徑（管理員） */
router.post("/api/admin/regenerate-panel-path", requireAdmin, async (req: Request, res: Response) => {
  if (!config.LOGIN_WEB_PATH) {
    res.status(400).json({ error: "此功能僅在設定 LOGIN_WEB_PATH 時可用" });
    return;
  }
  const newPanelPath = await regenerateWebPanelUuid();
  // 銷毀當前 session + 清除 cookie，強制完全重新登入
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    destroySession(auth.slice(7));
  }
  clearSessionCookie(res);
  res.json({ panelPath: newPanelPath, loginPath: config.LOGIN_WEB_PATH });
});

// ---------------------------------------------------------------------------
// Web 用戶管理路由（僅 password 模式 + 管理員）
// ---------------------------------------------------------------------------

/** GET /web/api/admin/web-users — 列出所有 Web 用戶（password 模式） */
router.get("/api/admin/web-users", requireAdmin, async (_req: Request, res: Response) => {
  if (config.WEB_AUTH_MODE !== "password") {
    res.status(400).json({ error: "此功能僅在 WEB_AUTH_MODE=password 時可用" });
    return;
  }
  const users = await getWebUsers();
  res.json({ users });
});

/** POST /web/api/admin/web-users — 新增 Web 用戶（password 模式） */
router.post("/api/admin/web-users", requireAdmin, async (req: Request, res: Response) => {
  if (config.WEB_AUTH_MODE !== "password") {
    res.status(400).json({ error: "此功能僅在 WEB_AUTH_MODE=password 時可用" });
    return;
  }
  const { username, password, isAdmin } = req.body;
  if (typeof username !== "string" || typeof password !== "string") {
    res.status(400).json({ error: "請提供 username 和 password" });
    return;
  }
  const usernameError = validateUsername(username);
  if (usernameError) {
    res.status(400).json({ error: usernameError });
    return;
  }
  const passwordError = validatePasswordStrength(password);
  if (passwordError) {
    res.status(400).json({ error: passwordError });
    return;
  }

  try {
    const passwordHash = await hashPassword(password);
    await addWebUser(username, passwordHash, isAdmin ? 1 : 0);
    res.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/unique|duplicate/i.test(msg)) {
      res.status(409).json({ error: "使用者名稱已存在" });
      return;
    }
    console.error("[web] addWebUser error:", err);
    res.status(500).json({ error: "新增用戶失敗" });
  }
});

/** PUT /web/api/admin/web-users/:id/status — 停用/啟用 Web 用戶（password 模式） */
router.put("/api/admin/web-users/:id/status", requireAdmin, async (req: Request, res: Response) => {
  if (config.WEB_AUTH_MODE !== "password") {
    res.status(400).json({ error: "此功能僅在 WEB_AUTH_MODE=password 時可用" });
    return;
  }
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "無效的用戶 ID" });
    return;
  }
  const { isActive } = req.body;
  if (typeof isActive !== "boolean") {
    res.status(400).json({ error: "請提供 isActive 布林值" });
    return;
  }

  const webUser = await getWebUserById(id);
  if (!webUser) {
    res.status(404).json({ error: "用戶不存在" });
    return;
  }

  // 安全：停用自己時拒絕
  const webAuth = req.webAuth!;
  if (webAuth.webUserId === id && !isActive) {
    res.status(400).json({ error: "無法停用自己的帳號" });
    return;
  }

  await updateWebUserStatus(id, isActive ? 1 : 0);
  // 停用時銷毀該用戶所有 session
  if (!isActive) {
    destroySessionsByWebUserId(id);
  }
  res.json({ ok: true });
});

/** PUT /web/api/admin/web-users/:id/password — 管理員重設密碼（password 模式） */
router.put("/api/admin/web-users/:id/password", requireAdmin, async (req: Request, res: Response) => {
  if (config.WEB_AUTH_MODE !== "password") {
    res.status(400).json({ error: "此功能僅在 WEB_AUTH_MODE=password 時可用" });
    return;
  }
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "無效的用戶 ID" });
    return;
  }
  const { newPassword } = req.body;
  if (typeof newPassword !== "string") {
    res.status(400).json({ error: "請提供 newPassword" });
    return;
  }
  const passwordError = validatePasswordStrength(newPassword);
  if (passwordError) {
    res.status(400).json({ error: passwordError });
    return;
  }

  const webUser = await getWebUserById(id);
  if (!webUser) {
    res.status(404).json({ error: "用戶不存在" });
    return;
  }

  try {
    const newHash = await hashPassword(newPassword);
    await updateWebUserPassword(id, newHash);
    // 銷毀該用戶所有 session（強制重新登入）
    destroySessionsByWebUserId(id);
    res.json({ ok: true });
  } catch (err) {
    console.error("[web] adminResetPassword error:", err);
    res.status(500).json({ error: "重設密碼失敗" });
  }
});

/** DELETE /web/api/admin/web-users/:id — 刪除 Web 用戶（password 模式） */
router.delete("/api/admin/web-users/:id", requireAdmin, async (req: Request, res: Response) => {
  if (config.WEB_AUTH_MODE !== "password") {
    res.status(400).json({ error: "此功能僅在 WEB_AUTH_MODE=password 時可用" });
    return;
  }
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "無效的用戶 ID" });
    return;
  }

  // 安全：不能刪除自己
  const webAuth = req.webAuth!;
  if (webAuth.webUserId === id) {
    res.status(400).json({ error: "無法刪除自己的帳號" });
    return;
  }

  const webUser = await getWebUserById(id);
  if (!webUser) {
    res.status(404).json({ error: "用戶不存在" });
    return;
  }

  try {
    // 先銷毀該用戶所有 session
    destroySessionsByWebUserId(id);
    await deleteWebUser(id);
    res.json({ ok: true });
  } catch (err) {
    console.error("[web] deleteWebUser error:", err);
    res.status(500).json({ error: "刪除用戶失敗" });
  }
});

// ---------------------------------------------------------------------------
// 用戶功能路由（普通用戶可存取自己的資料）
// ---------------------------------------------------------------------------

/** GET /web/api/models — 可用模型列表 */
router.get("/api/models", async (req: Request, res: Response) => {
  const allModels = getAllCachedModelNames();
  // 目前對所有用戶返回全部模型（前端不強制限制模型列表顯示）
  res.json({ models: allModels });
});

/** GET /web/api/keys — 我的 API Keys */
router.get("/api/keys", async (req: Request, res: Response) => {
  const { tgUserId } = req.webAuth!;
  const keys = await getKeysByUser(tgUserId);
  // 遮蔽完整 key（只顯示前後部分）
  res.json({
    keys: keys.map((k) => ({
      ...k,
      // 只回傳 key 的末 12 碼用於顯示，完整 key 在新增時一次性返回
      keyPreview: k.key.length > 16 ? `...${k.key.slice(-12)}` : k.key,
    })),
  });
});

/** POST /web/api/keys — 新增 API Key */
router.post("/api/keys", async (req: Request, res: Response) => {
  const { tgUserId } = req.webAuth!;
  try {
    // 管理員/新用戶可能尚無 users 表記錄，建立第一個 Key 時自動補建
    if (!(await getUserByTgId(tgUserId))) {
      await addUser(tgUserId);
    }
    const result = await addApiKey(tgUserId);
    res.json({ key: result.key });
  } catch (err) {
    console.error("[web] addApiKey error:", err);
    res.status(500).json({ error: "新增 API Key 失敗" });
  }
});

/** GET /web/api/keys/:id — 查看單個 API Key 的完整值 */
router.get("/api/keys/:id", async (req: Request, res: Response) => {
  const { tgUserId } = req.webAuth!;
  const keyId = parseInt(req.params.id, 10);
  if (isNaN(keyId)) {
    res.status(400).json({ error: "無效的 Key ID" });
    return;
  }

  // 驗證 key 確實屬於當前用戶
  const userKeys = await getKeysByUser(tgUserId);
  const key = userKeys.find((k) => k.id === keyId);
  if (!key) {
    res.status(403).json({ error: "無權操作此 Key" });
    return;
  }

  res.json({ key: { id: key.id, key: key.key, created_at: key.created_at } });
});

/** DELETE /web/api/keys/:id — 刪除 API Key */
router.delete("/api/keys/:id", async (req: Request, res: Response) => {
  const { tgUserId } = req.webAuth!;
  const keyId = parseInt(req.params.id, 10);
  if (isNaN(keyId)) {
    res.status(400).json({ error: "無效的 Key ID" });
    return;
  }

  // 驗證 key 確實屬於當前用戶
  const userKeys = await getKeysByUser(tgUserId);
  if (!userKeys.some((k) => k.id === keyId)) {
    res.status(403).json({ error: "無權操作此 Key" });
    return;
  }

  try {
    await deleteApiKey(keyId);
    res.json({ ok: true });
  } catch (err) {
    console.error("[web] deleteApiKey error:", err);
    res.status(500).json({ error: "刪除 API Key 失敗" });
  }
});

/** GET /web/api/usage — 我的用量 */
router.get("/api/usage", async (req: Request, res: Response) => {
  const { tgUserId } = req.webAuth!;
  const records = await getUsageByUser(tgUserId);
  // 按 API Key 分組統計
  const byKey = new Map<number, { inputTokens: number; outputTokens: number; inputCost: number; outputCost: number; count: number }>();
  for (const r of records) {
    const agg = byKey.get(r.api_key_id) ?? { inputTokens: 0, outputTokens: 0, inputCost: 0, outputCost: 0, count: 0 };
    agg.inputTokens += Number(r.input_tokens) || 0;
    agg.outputTokens += Number(r.output_tokens) || 0;
    agg.inputCost += Number(r.input_cost) || 0;
    agg.outputCost += Number(r.output_cost) || 0;
    agg.count++;
    byKey.set(r.api_key_id, agg);
  }
  res.json({
    records: records.slice(-200), // 最近 200 筆
    summary: Object.fromEntries(byKey),
  });
});

/** GET /web/api/coding — 我的 Coding 設定 */
router.get("/api/coding", async (req: Request, res: Response) => {
  const { tgUserId } = req.webAuth!;
  const cfg = await getCodingConfigByTgId(tgUserId);
  res.json({ config: cfg });
});

/** PUT /web/api/coding — 更新 Coding 設定 */
router.put("/api/coding", async (req: Request, res: Response) => {
  const { tgUserId } = req.webAuth!;
  const user = await getUserByTgId(tgUserId);
  if (!user) {
    res.status(404).json({ error: "用戶不存在" });
    return;
  }

  const { isActive, fallbackModels, maxRetries } = req.body;
  const opts: { isActive?: number; fallbackModels?: string; maxRetries?: number } = {};
  if (isActive !== undefined) opts.isActive = isActive ? 1 : 0;
  if (fallbackModels !== undefined) opts.fallbackModels = String(fallbackModels);
  if (maxRetries !== undefined) opts.maxRetries = parseInt(maxRetries, 10) || 3;

  try {
    const result = await setCodingConfig(user.id, opts);
    res.json({ config: result });
  } catch (err) {
    console.error("[web] setCodingConfig error:", err);
    res.status(500).json({ error: "更新 Coding 設定失敗" });
  }
});

/** GET /web/api/limits — 我的有效限制 + 今日/月用量 */
router.get("/api/limits", async (req: Request, res: Response) => {
  const { tgUserId } = req.webAuth!;
  const user = await getUserByTgId(tgUserId);
  if (!user) {
    res.status(404).json({ error: "用戶不存在" });
    return;
  }

  const limits = await getEffectiveLimits(user.id, null);
  const daily = await getDailyUsage(user.id, null);
  const monthly = await getMonthlyUsage(user.id, null);
  res.json({ limits, daily, monthly });
});

/** GET /web/api/restrictions — 我的模型限制 */
router.get("/api/restrictions", async (req: Request, res: Response) => {
  const { tgUserId } = req.webAuth!;
  const user = await getUserByTgId(tgUserId);
  if (!user) {
    res.status(404).json({ error: "用戶不存在" });
    return;
  }
  const restrictions = await getModelRestrictionsForUser(user.id);
  res.json({ restrictions });
});

/** GET /web/api/url — API 端點 URL */
router.get("/api/url", async (_req: Request, res: Response) => {
  const apiUrl = await getEffectiveApiUrl();
  res.json({ url: apiUrl });
});

// ---------------------------------------------------------------------------
// 管理員路由
// ---------------------------------------------------------------------------

router.use("/api/admin", requireAdmin);

/** GET /web/api/admin/system-usage — 系統與程式資源佔用 */
router.get("/api/admin/system-usage", requireAdmin, async (_req: Request, res: Response) => {
  res.json({ usage: getSystemUsageSnapshot() });
});

/** GET /web/api/admin/plugins — Node.js 插件列表 */
router.get("/api/admin/plugins", requireAdmin, async (_req: Request, res: Response) => {
  res.json({ plugins: await listNodeJsPlugins() });
});

/** POST /web/api/admin/plugins/upload — 從 Web 上傳安裝 Node.js 插件 */
router.post("/api/admin/plugins/upload", requireAdmin, async (req: Request, res: Response) => {
  const { filename, content } = req.body as { filename?: unknown; content?: unknown };
  if (typeof filename !== "string" || typeof content !== "string") {
    res.status(400).json({ error: "缺少必要欄位: filename, content" });
    return;
  }

  try {
    const plugin = await installNodeJsPluginFromContent({ filename, content, kind: "upload" });
    res.json({ ok: true, plugin, plugins: await listNodeJsPlugins() });
  } catch (err) {
    console.error("[web] install uploaded plugin error:", err);
    res.status(400).json({ error: err instanceof Error ? err.message : "插件安裝失敗" });
  }
});

/** POST /web/api/admin/plugins/github — 從 GitHub 連結安裝 Node.js 插件 */
router.post("/api/admin/plugins/github", requireAdmin, async (req: Request, res: Response) => {
  try {
    const source = await resolveGitHubPluginSource((req.body as { url?: unknown }).url);
    const content = await fetchTextWithLimit(source.rawUrl);
    const plugin = await installNodeJsPluginFromContent({
      filename: source.filename,
      content,
      kind: "github",
      url: source.sourceUrl,
    });
    res.json({ ok: true, plugin, rawUrl: source.rawUrl, plugins: await listNodeJsPlugins() });
  } catch (err) {
    console.error("[web] install GitHub plugin error:", err);
    res.status(400).json({ error: err instanceof Error ? err.message : "GitHub 插件安裝失敗" });
  }
});

// --- Providers ---

/** GET /web/api/admin/providers — 供應商列表 */
router.get("/api/admin/providers", requireAdmin, async (_req: Request, res: Response) => {
  const providers = await getProviders(false);
  // 解析 api_key 為陣列但不回傳完整 key
  res.json({
    providers: await Promise.all(providers.map(async (p) => ({
      ...p,
      api_keys: p.api_key ? parseApiKeys(p.api_key) : [],
      models_list: p.models ? p.models.split(",").map((m: string) => m.trim()).filter(Boolean) : [],
      model_prices: (await getModelPricesByProvider(p.id)).map((mp) => ({
        model: mp.model,
        input_price: mp.input_price,
        output_price: mp.output_price,
      })),
    })))
  });
});

/** POST /web/api/admin/providers — 新增供應商 */
router.post("/api/admin/providers", requireAdmin, async (req: Request, res: Response) => {
  const { name, api_type, base_url, api_key, user_agent, models, model_prices, input_price, output_price, key_strategy } = req.body;
  if (!name || !api_type || !base_url) {
    res.status(400).json({ error: "缺少必要欄位: name, api_type, base_url" });
    return;
  }

  const sanitizedUserAgent = sanitizeUserAgent(user_agent);
  if (!sanitizedUserAgent.ok) {
    res.status(400).json({ error: sanitizedUserAgent.error });
    return;
  }

  try {
    // api_key: 前端傳逗號分隔字串，後端存 JSON 陣列
    const keysArray = api_key
      ? String(api_key).split(",").map((k: string) => k.trim()).filter(Boolean)
      : [];
    const modelsStr = models ? String(models) : "";
    const strategy = key_strategy ? String(key_strategy) : "failover";
    await addProvider({
      name,
      api_type,
      base_url: String(base_url).replace(/\/+$/, ""),
      api_key: JSON.stringify(keysArray),
      user_agent: sanitizedUserAgent.value,
      key_strategy: strategy,
      models: modelsStr,
      input_price: input_price != null ? Number(input_price) : null,
      output_price: output_price != null ? Number(output_price) : null,
    });

    // 取得新建立的 provider ID（addProvider 不返回 ID，從列表取最後一筆）
    if (Array.isArray(model_prices) && model_prices.length > 0) {
      const allProviders = await getProviders(false);
      const newProvider = allProviders[allProviders.length - 1];
      if (newProvider) {
        const entries = model_prices
          .filter((mp: { model?: string }) => mp.model && String(mp.model).trim())
          .map((mp: { model: string; input_price?: string | number | null; output_price?: string | number | null }) => ({
            model: String(mp.model).trim(),
            input_price: mp.input_price != null && mp.input_price !== "" ? Number(mp.input_price) : null,
            output_price: mp.output_price != null && mp.output_price !== "" ? Number(mp.output_price) : null,
          }));
        if (entries.length > 0) {
          await batchUpsertModelPrices(newProvider.id, entries);
        }
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("[web] addProvider error:", err);
    res.status(500).json({ error: "新增供應商失敗" });
  }
});

/** PUT /web/api/admin/providers/:id — 更新供應商 */
router.put("/api/admin/providers/:id", requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "無效的 ID" });
    return;
  }

  const data: Record<string, unknown> = {};
  const { name, api_type, base_url, api_key, user_agent, models, model_prices, enabled, input_price, output_price, key_strategy } = req.body;

  if (name !== undefined) data.name = String(name);
  if (api_type !== undefined) data.api_type = String(api_type);
  if (base_url !== undefined) data.base_url = String(base_url).replace(/\/+$/, "");
  if (api_key !== undefined) {
    const keysArray = String(api_key).split(",").map((k: string) => k.trim()).filter(Boolean);
    data.api_key = JSON.stringify(keysArray);
  }
  if (key_strategy !== undefined) data.key_strategy = String(key_strategy);
  if (user_agent !== undefined) {
    const sanitizedUserAgent = sanitizeUserAgent(user_agent);
    if (!sanitizedUserAgent.ok) {
      res.status(400).json({ error: sanitizedUserAgent.error });
      return;
    }
    data.user_agent = sanitizedUserAgent.value;
  }
  if (models !== undefined) data.models = String(models);
  if (enabled !== undefined) data.enabled = enabled ? 1 : 0;
  if (input_price !== undefined) data.input_price = input_price != null ? Number(input_price) : null;
  if (output_price !== undefined) data.output_price = output_price != null ? Number(output_price) : null;

  try {
    await updateProvider(id, data);

    // 處理 per-model 定價
    if (Array.isArray(model_prices)) {
      const entries = model_prices
        .filter((mp: { model?: string }) => mp.model && String(mp.model).trim())
        .map((mp: { model: string; input_price?: string | number | null; output_price?: string | number | null }) => ({
          model: String(mp.model).trim(),
          input_price: mp.input_price != null && mp.input_price !== "" ? Number(mp.input_price) : null,
          output_price: mp.output_price != null && mp.output_price !== "" ? Number(mp.output_price) : null,
        }));
      const modelNames = entries.map((e: { model: string }) => e.model);
      await cleanupModelPrices(id, modelNames);
      if (entries.length > 0) {
        await batchUpsertModelPrices(id, entries);
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("[web] updateProvider error:", err);
    res.status(500).json({ error: "更新供應商失敗" });
  }
});

/** DELETE /web/api/admin/providers — 刪除供應商（body: {ids:[]}） */
router.delete("/api/admin/providers", requireAdmin, async (req: Request, res: Response) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: "需要 ids 陣列" });
    return;
  }
  try {
    await deleteProvider(ids.map((id: unknown) => parseInt(String(id), 10)).filter((n: number) => !isNaN(n)));
    res.json({ ok: true });
  } catch (err) {
    console.error("[web] deleteProvider error:", err);
    res.status(500).json({ error: "刪除供應商失敗" });
  }
});

/** GET /web/api/admin/provider-prices/:id — 供應商的模型定價 */
router.get("/api/admin/provider-prices/:id", requireAdmin, async (req: Request, res: Response) => {
  const providerId = parseInt(req.params.id, 10);
  if (isNaN(providerId)) {
    res.status(400).json({ error: "無效的 ID" });
    return;
  }
  const prices = await getModelPricesByProvider(providerId);
  res.json({ prices });
});

/** PUT /web/api/admin/provider-prices/:id — 批量更新定價 */
router.put("/api/admin/provider-prices/:id", requireAdmin, async (req: Request, res: Response) => {
  const providerId = parseInt(req.params.id, 10);
  if (isNaN(providerId)) {
    res.status(400).json({ error: "無效的 ID" });
    return;
  }
  const { entries } = req.body;
  if (!Array.isArray(entries)) {
    res.status(400).json({ error: "需要 entries 陣列" });
    return;
  }
  try {
    await batchUpsertModelPrices(providerId, entries.map((e: { model: string; input_price: number | null; output_price: number | null }) => ({
      model: String(e.model),
      input_price: e.input_price != null ? Number(e.input_price) : null,
      output_price: e.output_price != null ? Number(e.output_price) : null,
    })));
    res.json({ ok: true });
  } catch (err) {
    console.error("[web] batchUpsertModelPrices error:", err);
    res.status(500).json({ error: "更新定價失敗" });
  }
});

// --- Users ---

/** GET /web/api/admin/users — 用戶列表（排除管理員自己） */
router.get("/api/admin/users", requireAdmin, async (_req: Request, res: Response) => {
  const users = await getUsers();
  res.json({
    users: users.map((u) => ({
      ...u,
      is_admin: Number(u.tg_user_id) === config.ADMIN_ID,
    })),
  });
});

/** POST /web/api/admin/users — 新增用戶 */
router.post("/api/admin/users", requireAdmin, async (req: Request, res: Response) => {
  const { tgUserId, username } = req.body;
  if (!tgUserId || isNaN(parseInt(tgUserId, 10))) {
    res.status(400).json({ error: "需要有效的 tgUserId" });
    return;
  }
  const uid = parseInt(tgUserId, 10);

  // 檢查是否已存在
  if (await getUserByTgId(uid)) {
    res.status(409).json({ error: "該用戶已存在" });
    return;
  }

  try {
    await addUser(uid, username ? String(username) : null);
    // 新用戶自動歸入預設分組
    const defaultGroup = await getDefaultUserGroup();
    if (defaultGroup) {
      const newUser = await getUserByTgId(uid);
      if (newUser) {
        await setUserGroup(newUser.id, defaultGroup.id);
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("[web] addUser error:", err);
    res.status(500).json({ error: "新增用戶失敗" });
  }
});

/** PUT /web/api/admin/users/:id/status — 更新用戶狀態 */
router.put("/api/admin/users/:id/status", requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "無效的 ID" });
    return;
  }
  const { isActive } = req.body;
  try {
    await updateUserStatus(id, isActive ? 1 : 0);
    res.json({ ok: true });
  } catch (err) {
    console.error("[web] updateUserStatus error:", err);
    res.status(500).json({ error: "更新用戶狀態失敗" });
  }
});

/** PUT /web/api/admin/users/:id/tg-id — 更新用戶 TG ID */
router.put("/api/admin/users/:id/tg-id", requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "無效的 ID" });
    return;
  }
  const { newTgId } = req.body;
  if (!newTgId || isNaN(parseInt(newTgId, 10))) {
    res.status(400).json({ error: "需要有效的 newTgId" });
    return;
  }
  try {
    const user = await getUserById(id);
    if (!user) {
      res.status(404).json({ error: "用戶不存在" });
      return;
    }
    await updateUserTgId(user.tg_user_id, parseInt(newTgId, 10));
    res.json({ ok: true });
  } catch (err) {
    console.error("[web] updateUserTgId error:", err);
    res.status(500).json({ error: "更新 TG ID 失敗" });
  }
});

/** DELETE /web/api/admin/users/:id — 刪除用戶 */
router.delete("/api/admin/users/:id", requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "無效的 ID" });
    return;
  }
  try {
    await deleteUser(id);
    res.json({ ok: true });
  } catch (err) {
    console.error("[web] deleteUser error:", err);
    res.status(500).json({ error: "刪除用戶失敗" });
  }
});

/** GET /web/api/admin/users/:id/keys — 用戶的 API Keys */
router.get("/api/admin/users/:id/keys", requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "無效的 ID" });
    return;
  }
  const user = await getUserById(id);
  if (!user) {
    res.status(404).json({ error: "用戶不存在" });
    return;
  }
  const keys = await getKeysByUser(user.tg_user_id);
  res.json({ keys });
});

/** DELETE /web/api/admin/users/:id/keys/:keyId — 刪除用戶 API Key */
router.delete("/api/admin/users/:id/keys/:keyId", requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  const keyId = parseInt(req.params.keyId, 10);
  if (isNaN(id) || isNaN(keyId)) {
    res.status(400).json({ error: "無效的 ID" });
    return;
  }
  try {
    // 驗證用戶存在
    const user = await getUserById(id);
    if (!user) {
      res.status(404).json({ error: "用戶不存在" });
      return;
    }
    // 驗證 key 確實屬於該用戶（路徑語義一致性，防止跨用戶誤刪）
    const userKeys = await getKeysByUser(user.tg_user_id);
    if (!userKeys.some((k) => k.id === keyId)) {
      res.status(404).json({ error: "該用戶沒有此 Key" });
      return;
    }
    await deleteApiKey(keyId);
    res.json({ ok: true });
  } catch (err) {
    console.error("[web] deleteApiKey (admin) error:", err);
    res.status(500).json({ error: "刪除 API Key 失敗" });
  }
});

/** GET /web/api/admin/users/:id/limits — 用戶限制詳情 */
router.get("/api/admin/users/:id/limits", requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "無效的 ID" });
    return;
  }
  const userWithLimits = await getUserWithLimits(id);
  if (!userWithLimits) {
    res.status(404).json({ error: "用戶不存在" });
    return;
  }
  const limits = await getEffectiveLimits(id, null);
  const daily = await getDailyUsage(id, null);
  const monthly = await getMonthlyUsage(id, null);
  res.json({ user: userWithLimits, effectiveLimits: limits, daily, monthly });
});

/** PUT /web/api/admin/users/:id/limits — 設定用戶分組+覆蓋 */
router.put("/api/admin/users/:id/limits", requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "無效的 ID" });
    return;
  }

  const { groupId, overrides } = req.body;

  try {
    if (groupId !== undefined) {
      const gid = parseInt(groupId, 10);
      if (!isNaN(gid)) {
        await setUserGroup(id, gid);
      }
    }
    if (overrides && typeof overrides === "object") {
      // 清理 null/undefined 以外都傳入
      const clean: Record<string, unknown> = {};
      const fields = [
        "expires_at", "rpm_override", "tpm_override", "concurrency_override",
        "daily_token_override", "monthly_token_override",
        "daily_cost_override", "monthly_cost_override",
      ];
      for (const f of fields) {
        if (f in overrides) {
          clean[f] = overrides[f];
        }
      }
      if (Object.keys(clean).length > 0) {
        await setUserOverrides(id, clean);
      }
    }
    invalidateEffectiveLimitsCache(id);
    res.json({ ok: true });
  } catch (err) {
    console.error("[web] setUserLimits error:", err);
    res.status(500).json({ error: "設定限制失敗" });
  }
});

/** GET /web/api/admin/users/:id/restrictions — 用戶模型限制 */
router.get("/api/admin/users/:id/restrictions", requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "無效的 ID" });
    return;
  }
  const restrictions = await getModelRestrictionsForUser(id);
  res.json({ restrictions });
});

/** PUT /web/api/admin/users/:id/restrictions — 設定用戶模型限制 */
router.put("/api/admin/users/:id/restrictions", requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "無效的 ID" });
    return;
  }
  const { apiKeyId, mode, models, action } = req.body;

  try {
    if (action === "delete") {
      const keyId = apiKeyId != null ? parseInt(apiKeyId, 10) : null;
      await deleteModelRestriction(id, keyId);
    } else {
      if (!mode || !models) {
        res.status(400).json({ error: "需要 mode 和 models" });
        return;
      }
      const keyId = apiKeyId != null ? parseInt(apiKeyId, 10) : null;
      await setModelRestriction(id, keyId, mode === "whitelist" ? "whitelist" : "blacklist", String(models));
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("[web] setUserRestriction error:", err);
    res.status(500).json({ error: "設定模型限制失敗" });
  }
});

// --- API Key Limits ---

/** GET /web/api/admin/keys/:id/limits — API Key 限制詳情 */
router.get("/api/admin/keys/:id/limits", requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "無效的 ID" });
    return;
  }
  const keyWithLimits = await getApiKeyWithLimits(id);
  if (!keyWithLimits) {
    res.status(404).json({ error: "API Key 不存在" });
    return;
  }
  res.json({ key: keyWithLimits });
});

/** PUT /web/api/admin/keys/:id/limits — 設定 API Key 覆蓋 */
router.put("/api/admin/keys/:id/limits", requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "無效的 ID" });
    return;
  }
  const { overrides } = req.body;

  if (!overrides || typeof overrides !== "object") {
    res.status(400).json({ error: "需要 overrides 物件" });
    return;
  }

  try {
    const clean: Record<string, unknown> = {};
    const fields = [
      "expires_at", "rpm_override", "tpm_override", "concurrency_override",
      "daily_token_override", "monthly_token_override",
      "daily_cost_override", "monthly_cost_override",
    ];
    for (const f of fields) {
      if (f in overrides) {
        clean[f] = overrides[f];
      }
    }
    if (Object.keys(clean).length > 0) {
      await setApiKeyOverrides(id, clean);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("[web] setApiKeyLimits error:", err);
    res.status(500).json({ error: "設定 API Key 限制失敗" });
  }
});

// --- Groups ---

/** GET /web/api/admin/groups — 用戶分組列表 */
router.get("/api/admin/groups", requireAdmin, async (_req: Request, res: Response) => {
  const groups = await getUserGroups();
  res.json({ groups });
});

/** POST /web/api/admin/groups — 新增分組 */
router.post("/api/admin/groups", requireAdmin, async (req: Request, res: Response) => {
  const { name, display_name, ...limits } = req.body;
  if (!name) {
    res.status(400).json({ error: "需要 name" });
    return;
  }
  try {
    await addUserGroup({ name: String(name), display_name: display_name ?? null, ...limits });
    res.json({ ok: true });
  } catch (err) {
    console.error("[web] addUserGroup error:", err);
    res.status(500).json({ error: "新增分組失敗" });
  }
});

/** PUT /web/api/admin/groups/:id — 更新分組 */
router.put("/api/admin/groups/:id", requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "無效的 ID" });
    return;
  }
  try {
    await updateUserGroup(id, req.body);
    res.json({ ok: true });
  } catch (err) {
    console.error("[web] updateUserGroup error:", err);
    res.status(500).json({ error: "更新分組失敗" });
  }
});

/** DELETE /web/api/admin/groups/:id — 刪除分組 */
router.delete("/api/admin/groups/:id", requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "無效的 ID" });
    return;
  }
  try {
    await deleteUserGroup(id);
    res.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "刪除分組失敗";
    console.error("[web] deleteUserGroup error:", err);
    if (msg.includes("default")) {
      res.status(400).json({ error: msg });
    } else {
      res.status(500).json({ error: msg });
    }
  }
});

/** PUT /web/api/admin/groups/:id/default — 設為預設分組 */
router.put("/api/admin/groups/:id/default", requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "無效的 ID" });
    return;
  }
  try {
    await setDefaultUserGroup(id);
    res.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "設定預設分組失敗";
    console.error("[web] setDefaultUserGroup error:", err);
    res.status(500).json({ error: msg });
  }
});

// --- Usage (admin) ---

/** GET /web/api/admin/usage — 全部用量統計 */
router.get("/api/admin/usage", requireAdmin, async (req: Request, res: Response) => {
  const { byUser } = req.query;

  if (byUser) {
    // 按用戶統計
    const tgId = parseInt(String(byUser), 10);
    if (!isNaN(tgId)) {
      const records = await getUsageByUser(tgId);
      res.json({ records: records.slice(-200) });
      return;
    }
  }

  const total = await getTotalUsage();
  res.json({ total });
});

// --- Settings ---

/** GET /web/api/admin/settings — 系統設定 */
router.get("/api/admin/settings", requireAdmin, async (_req: Request, res: Response) => {
  const rawApiUrl = await getRawConfiguredApiUrl();
  const info = await getEffectiveApiUrlWithSource();
  const kaEnabled = (await getSetting("keepalive_enabled")) === "1";
  const kaInterval = Number(await getSetting("keepalive_interval")) || 5;
  res.json({
    settings: {
      // raw admin-configured value (null when cleared / never set). Front-end
      // forms should bind to this so saving without changes doesn't strand a
      // tunnel URL into the persistent settings.
      api_url: rawApiUrl,
      // computed value actually shown to users (= raw ?? tunnel ?? default).
      effective_api_url: info.url,
      // provenance hint for the UI: "configured" | "tunnel" | "tunnel-pending" | "default"
      api_url_source: info.source,
      // raw Cloudflare quick-tunnel URL or null (kept for backward compat).
      tunnel_url: getTunnelUrl(),
      provider_default_user_agent: await getProviderDefaultUserAgent(),
      is_cloud_db: isCloudDatabase(),
      keepalive_enabled: kaEnabled,
      keepalive_interval: kaInterval,
    },
  });
});

/** PUT /web/api/admin/settings — 更新系統設定 */
router.put("/api/admin/settings", requireAdmin, async (req: Request, res: Response) => {
  const { api_url, provider_default_user_agent, keepalive_enabled, keepalive_interval } = req.body;

  if (api_url !== undefined) {
    // Empty/whitespace string means "clear back to auto" (tunnel/default).
    // Non-empty string is trimmed of trailing slashes and stored verbatim.
    const trimmed = typeof api_url === "string" ? api_url.trim().replace(/\/+$/, "") : "";
    if (trimmed) {
      await setSetting("api_url", trimmed);
    } else {
      await deleteSetting("api_url");
    }
  }

  if (provider_default_user_agent !== undefined) {
    const sanitizedUserAgent = sanitizeUserAgent(provider_default_user_agent);
    if (!sanitizedUserAgent.ok) {
      res.status(400).json({ error: sanitizedUserAgent.error });
      return;
    }
    await setSetting(PROVIDER_DEFAULT_USER_AGENT_SETTING, sanitizedUserAgent.value);
    invalidateUserAgentCache();
  }

  let kaChanged = false;
  if (keepalive_enabled !== undefined) {
    await setSetting("keepalive_enabled", keepalive_enabled ? "1" : "0");
    kaChanged = true;
  }
  if (keepalive_interval !== undefined) {
    const kaMin = Math.max(1, Math.floor(Number(keepalive_interval)) || 5);
    await setSetting("keepalive_interval", String(kaMin));
    kaChanged = true;
  }
  if (kaChanged) {
    await restartKeepaliveTimer();
  }

  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// API Test — 協議偵測
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Protocol Test — 用真實模型測試全部協議
// ---------------------------------------------------------------------------

/** POST /web/api/admin/protocol-test — 用真實模型測試 4 種 API 協議 */
router.post("/api/admin/protocol-test", requireAdmin, async (req: Request, res: Response) => {
  const { baseUrl, apiKey, model, message } = req.body;
  if (!baseUrl || typeof baseUrl !== "string") {
    res.status(400).json({ error: "缺少 baseUrl" });
    return;
  }
  if (!model || typeof model !== "string") {
    res.status(400).json({ error: "缺少 model" });
    return;
  }
  if (!apiKey || typeof apiKey !== "string") {
    res.status(400).json({ error: "缺少 apiKey" });
    return;
  }

  const msg = typeof message === "string" && message.trim() ? message : "Hello!";
  const base = baseUrl.replace(/\/+$/, "");

  // Helper: build request per protocol
  type ProtoReq = { url: string; headers: Record<string, string>; body: Record<string, unknown> };
  const buildReq = (proto: string): ProtoReq => {
    switch (proto) {
      case "openai_chat":
        return {
          url: `${base}/chat/completions`,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: { model, messages: [{ role: "user", content: msg }], max_tokens: 100 },
        };
      case "openai_response":
        return {
          url: `${base}/responses`,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: { model, input: msg, max_output_tokens: 100 },
        };
      case "anthropic": {
        const anthropicBase = base.includes("/v1") ? base : `${base}/v1`;
        return {
          url: `${anthropicBase}/messages`,
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: { model, max_tokens: 100, messages: [{ role: "user", content: msg }] },
        };
      }
      case "google":
        return {
          url: `${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
          headers: { "Content-Type": "application/json" },
          body: { contents: [{ parts: [{ text: msg }] }] },
        };
      default:
        return { url: "", headers: {}, body: {} };
    }
  };

  // Helper: parse response content per protocol
  const parseContent = (proto: string, data: any): string => {
    switch (proto) {
      case "openai_chat":
        return data.choices?.[0]?.message?.content ?? "";
      case "openai_response":
        return data.output_text ?? data.output?.[0]?.content?.[0]?.text ?? "";
      case "anthropic":
        return Array.isArray(data.content) ? data.content.map((b: any) => b.text ?? "").join("") : "";
      case "google":
        return Array.isArray(data.candidates?.[0]?.content?.parts)
          ? data.candidates[0].content.parts.map((p: any) => p.text ?? "").join("")
          : "";
      default:
        return "";
    }
  };

  const protocols = ["openai_chat", "openai_response", "anthropic", "google"];

  // Test all protocols in parallel
  const results = await Promise.all(
    protocols.map(async (proto) => {
      const req = buildReq(proto);
      const t0 = Date.now();
      try {
        const resp = await fetch(req.url, {
          method: "POST",
          headers: req.headers,
          body: JSON.stringify(req.body),
          signal: AbortSignal.timeout(30_000),
        });
        const latencyMs = Date.now() - t0;

        if (!resp.ok) {
          const errorText = await resp.text().catch(() => "");
          return {
            protocol: proto,
            success: false,
            latencyMs,
            status: resp.status,
            error: `HTTP ${resp.status}: ${errorText.slice(0, 300)}`,
          };
        }

        const data: any = await resp.json();
        const content = parseContent(proto, data);
        return {
          protocol: proto,
          success: true,
          latencyMs,
          status: resp.status,
          content: content.slice(0, 500),
        };
      } catch (err) {
        const latencyMs = Date.now() - t0;
        return {
          protocol: proto,
          success: false,
          latencyMs,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    })
  );

  // Recommend: first successful protocol with lowest latency
  const successful = results.filter((r) => r.success);
  let recommended = "";
  if (successful.length > 0) {
    successful.sort((a, b) => (a.latencyMs || 0) - (b.latencyMs || 0));
    recommended = successful[0].protocol;
  }

  res.json({ results, recommended });
});

// ---------------------------------------------------------------------------
// Model Catch — 模型抓取
// ---------------------------------------------------------------------------

/** POST /web/api/admin/model-catch — 抓取模型列表（有/無 API Key） */
router.post("/api/admin/model-catch", requireAdmin, async (req: Request, res: Response) => {
  const { baseUrl, apiKey, apiType } = req.body;
  if (!baseUrl || typeof baseUrl !== "string") {
    res.status(400).json({ error: "缺少 baseUrl" });
    return;
  }

  try {
    if (apiKey && typeof apiKey === "string") {
      const models = await fetchProviderModels(baseUrl, apiKey, apiType || "openai_chat");
      res.json({ models, needsAuth: false });
    } else {
      const { models, needsAuth } = await fetchModelsNoAuth(baseUrl);
      res.json({ models, needsAuth });
    }
  } catch (err) {
    console.error("[web] model-catch error:", err);
    res.status(500).json({ error: "抓取失敗：" + (err instanceof Error ? err.message : String(err)) });
  }
});

// ---------------------------------------------------------------------------
// Provider Helper — 表單用：偵測協議 + 抓取模型 + 定價
// ---------------------------------------------------------------------------

/** POST /web/api/admin/provider-models — 抓取模型列表（需 API Key） */
router.post("/api/admin/provider-models", requireAdmin, async (req: Request, res: Response) => {
  const { baseUrl, apiKey, apiType } = req.body;
  if (!baseUrl || typeof baseUrl !== "string") {
    res.status(400).json({ error: "缺少 baseUrl" });
    return;
  }
  if (!apiKey || typeof apiKey !== "string") {
    res.status(400).json({ error: "抓取模型需要 API Key" });
    return;
  }

  try {
    const models = await fetchProviderModels(baseUrl, apiKey, apiType || "openai_chat");
    res.json({ models: models.map((m) => m.id) });
  } catch (err) {
    console.error("[web] provider-models error:", err);
    res.status(500).json({ error: "抓取失敗：" + (err instanceof Error ? err.message : String(err)) });
  }
});

/** POST /web/api/admin/provider-pricing — 從 models.dev 取得模型定價 */
router.post("/api/admin/provider-pricing", requireAdmin, async (req: Request, res: Response) => {
  const { models } = req.body;
  if (!Array.isArray(models) || models.length === 0) {
    res.json({ pricing: {} });
    return;
  }

  try {
    const priceMap = await fetchModelsPricing(models);
    const pricing: Record<string, { input: number | null; output: number | null }> = {};
    for (const [k, v] of priceMap) {
      pricing[k] = v;
    }
    res.json({ pricing });
  } catch (err) {
    console.error("[web] provider-pricing error:", err);
    res.status(500).json({ error: "定價查詢失敗：" + (err instanceof Error ? err.message : String(err)) });
  }
});

/** POST /web/api/admin/providers/:id/test-model — 按供應商 api_type 發測試請求 */
router.post("/api/admin/providers/:id/test-model", requireAdmin, async (req: Request, res: Response) => {
  const providerId = Number(req.params.id);
  const { model, message } = req.body;

  if (!model || typeof model !== "string") {
    res.status(400).json({ error: "缺少 model 參數" });
    return;
  }
  const msg = typeof message === "string" && message.trim() ? message : "Hello!";

  const providers = await getProviders(false);
  const provider = providers.find((p) => p.id === providerId);
  if (!provider) {
    res.status(404).json({ error: "供應商不存在" });
    return;
  }

  const keys = parseApiKeys(provider.api_key);
  if (keys.length === 0) {
    res.status(400).json({ error: "此供應商沒有設定 API Key" });
    return;
  }
  const apiKey = keys[0];
  const baseUrl = (provider.base_url || "").replace(/\/+$/, "");
  const apiType = provider.api_type;

  if (!baseUrl) {
    res.status(400).json({ error: "供應商缺少 base_url" });
    return;
  }

  let url: string;
  let headers: Record<string, string>;
  let body: Record<string, unknown>;

  switch (apiType) {
    case "openai_chat":
      url = `${baseUrl}/chat/completions`;
      headers = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
      body = { model, messages: [{ role: "user", content: msg }], max_tokens: 100 };
      break;

    case "openai_response":
      url = `${baseUrl}/responses`;
      headers = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
      body = { model, input: msg, max_output_tokens: 100 };
      break;

    case "anthropic": {
      // baseUrl 可能含 /v1 也可能不含
      const anthropicBase = baseUrl.includes("/v1") ? baseUrl : `${baseUrl}/v1`;
      url = `${anthropicBase}/messages`;
      headers = {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      };
      body = { model, max_tokens: 100, messages: [{ role: "user", content: msg }] };
      break;
    }

    case "google":
      url = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      headers = { "Content-Type": "application/json" };
      body = { contents: [{ parts: [{ text: msg }] }] };
      break;

    default:
      res.status(400).json({ error: `不支援的 API 類型: ${apiType}` });
      return;
  }

  const userAgentHeaders = await buildUserAgentHeader(provider.user_agent);
  const requestHeaders = { ...headers, ...userAgentHeaders };
  const t0 = Date.now();
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    const latencyMs = Date.now() - t0;

    if (!resp.ok) {
      const errorText = await resp.text().catch(() => "");
      res.json({
        success: false,
        latencyMs,
        status: resp.status,
        error: `HTTP ${resp.status}: ${errorText.slice(0, 500)}`,
        url: sanitizeProviderTestUrl(url, apiType),
        apiType,
      });
      return;
    }

    const data: any = await resp.json();
    let content = "";

    switch (apiType) {
      case "openai_chat":
        content = data.choices?.[0]?.message?.content ?? "";
        break;
      case "openai_response":
        content = data.output_text ?? data.output?.[0]?.content?.[0]?.text ?? "";
        break;
      case "anthropic":
        content = Array.isArray(data.content)
          ? data.content.map((b: any) => b.text ?? "").join("")
          : "";
        break;
      case "google":
        content = Array.isArray(data.candidates?.[0]?.content?.parts)
          ? data.candidates[0].content.parts.map((p: any) => p.text ?? "").join("")
          : "";
        break;
    }

    res.json({ success: true, content, latencyMs, status: resp.status });
  } catch (err) {
    const latencyMs = Date.now() - t0;
    res.json({
      success: false,
      latencyMs,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

// ---------------------------------------------------------------------------
// System — 版本 / 更新 / 重啟
// ---------------------------------------------------------------------------

/** GET /web/api/admin/version — 當前版本 */
router.get("/api/admin/version", requireAdmin, async (_req: Request, res: Response) => {
  try {
    const version = getCurrentVersion();
    const workingDirClean = isWorkingDirClean();
    res.json({ version, workingDirClean });
  } catch (err) {
    console.error("[web] version error:", err);
    res.status(500).json({ error: "取得版本失敗" });
  }
});

/** GET /web/api/admin/check-update — 檢查更新 */
router.get("/api/admin/check-update", requireAdmin, async (_req: Request, res: Response) => {
  try {
    const result = await fetchAndCheckUpdate();
    res.json(result);
  } catch (err) {
    console.error("[web] check-update error:", err);
    res.status(500).json({ error: "檢查更新失敗：" + (err instanceof Error ? err.message : String(err)) });
  }
});

/** POST /web/api/admin/update — 執行更新 */
router.post("/api/admin/update", requireAdmin, async (req: Request, res: Response) => {
  try {
    // 接受前端指定更新方法（auto / prebuilt / blue-green），非法值回退 auto
    const rawMethod = req.body?.method;
    const method: "auto" | "prebuilt" | "blue-green" =
      rawMethod === "prebuilt" || rawMethod === "blue-green" ? rawMethod : "auto";
    const result = await performUpdate(undefined, method);
    // 如果成功且需要重啟
    if (result.success && req.body.restart !== false) {
      res.json({ ...result, willRestart: true });
      restartProcess(2000);
    } else {
      res.json({ ...result, willRestart: false });
    }
  } catch (err) {
    console.error("[web] update error:", err);
    res.status(500).json({ error: "更新失敗：" + (err instanceof Error ? err.message : String(err)) });
  }
});

/** POST /web/api/admin/restart — 重啟進程 */
router.post("/api/admin/restart", requireAdmin, async (req: Request, res: Response) => {
  try {
    const delay = typeof req.body?.delay === "number" ? req.body.delay : 2000;
    res.json({ ok: true, message: `將在 ${delay}ms 後重啟` });
    restartProcess(delay);
  } catch (err) {
    console.error("[web] restart error:", err);
    res.status(500).json({ error: "重啟失敗：" + (err instanceof Error ? err.message : String(err)) });
  }
});

// ---------------------------------------------------------------------------
// 版本回滾 (Blue-Green Rollback)
// ---------------------------------------------------------------------------

/** GET /web/api/admin/backups — 取得可用備份列表 */
router.get("/api/admin/backups", requireAdmin, async (_req: Request, res: Response) => {
  try {
    const backups = getBackupList();
    res.json({ backups });
  } catch (err) {
    console.error("[web] get backups error:", err);
    res.status(500).json({ error: "取得備份列表失敗：" + (err instanceof Error ? err.message : String(err)) });
  }
});

/** POST /web/api/admin/rollback — 回滾到最近的備份版本並重啟 */
router.post("/api/admin/rollback", requireAdmin, async (_req: Request, res: Response) => {
  try {
    res.json({ ok: true, message: "即將回滾到上一個版本並重啟" });
    rollbackAndRestart();
  } catch (err) {
    console.error("[web] rollback error:", err);
    res.status(500).json({ error: "回滾失敗：" + (err instanceof Error ? err.message : String(err)) });
  }
});

// --- Model Mappings ---

/** GET /web/api/admin/model-mappings — 模型映射列表 */
router.get("/api/admin/model-mappings", requireAdmin, async (_req: Request, res: Response) => {
  res.json({ mappings: await getModelMappings() });
});

/** PUT /web/api/admin/model-mappings — 批量替換模型映射 */
router.put("/api/admin/model-mappings", requireAdmin, async (req: Request, res: Response) => {
  const { mappings } = req.body;
  if (!Array.isArray(mappings)) {
    res.status(400).json({ error: "mappings 必須是陣列" });
    return;
  }

  // Validate entries
  const valid: Array<{ provider_id: number; original_model: string; display_name: string }> = [];
  for (const m of mappings) {
    const pid = Number(m.provider_id);
    const original = String(m.original_model || "").trim();
    const display = String(m.display_name || "").trim();
    if (!Number.isFinite(pid) || !original || !display) continue;
    // Skip mappings where display name equals original (no-op)
    if (original === display) continue;
    valid.push({ provider_id: pid, original_model: original, display_name: display });
  }

  try {
    await replaceModelMappings(valid);
    res.json({ ok: true, count: valid.length });
  } catch (err) {
    res.status(500).json({ error: "保存失敗：" + (err instanceof Error ? err.message : String(err)) });
  }
});

// --- API Logs ---

/** GET /web/api/admin/api-logs — 近期 API 調用日誌 */
router.get("/api/admin/api-logs", requireAdmin, async (_req: Request, res: Response) => {
  res.json({ logs: getApiLogs() });
});

// ---------------------------------------------------------------------------
// Favicon — suppress browser auto-request noise (204 No Content)
// ---------------------------------------------------------------------------
router.get("/favicon.ico", async (_req: Request, res: Response) => {
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// API 404 catch-all — return JSON for any unmatched /api/* route
// ---------------------------------------------------------------------------
router.use("/api", async (_req: Request, res: Response) => {
  res.status(404).json({ error: "未知的 API 端點" });
});

// ---------------------------------------------------------------------------
// SPA fallback — serve index.html for non-API GET requests (deep linking)
// ---------------------------------------------------------------------------
router.get("*", async (_req: Request, res: Response) => {
  const indexPath = path.join(process.cwd(), "web", "index.html");
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send("Web 控制台檔案未找到");
  }
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export default router;

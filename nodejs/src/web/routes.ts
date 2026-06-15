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
 *   GET    /web/api/admin/settings            — 系統設定
 *   PUT    /web/api/admin/settings            — 更新系統設定
 */

import { Router, type Request, type Response } from "express";
import {
  exchangeToken,
  destroySession,
  webAuthMiddleware,
  requireAdmin,
  startCleanupTimer,
} from "./auth.js";
import { config } from "../config.js";
import { parseApiKeys } from "../api/keySelector.js";
import {
  detectApiProtocols,
  detectProtocolsNoAuth,
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
} from "../updater.js";
import {
  // providers
  getProviders, addProvider, updateProvider, deleteProvider,
  getModelPricesByProvider, batchUpsertModelPrices, cleanupModelPrices,
  // users
  getUsers, addUser, getUserByTgId, getUserById, updateUserStatus, deleteUser, updateUserTgId,
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
  getUserGroups, addUserGroup, updateUserGroup, deleteUserGroup, getDefaultUserGroup,
  // settings
  getSetting, setSetting,
  // cache
  getAllCachedModelNames,
} from "../db/database.js";

// ---------------------------------------------------------------------------
// Router & cleanup
// ---------------------------------------------------------------------------

const router = Router();

// 啟動 OTP/Session 清理任務
startCleanupTimer();

// ---------------------------------------------------------------------------
// Auth routes（公開 — login 不需要 session）
// ---------------------------------------------------------------------------

/** POST /web/api/auth/login — OTP 換 session */
router.post("/api/auth/login", (req: Request, res: Response) => {
  const { token } = req.body;
  if (!token || typeof token !== "string") {
    res.status(400).json({ error: "缺少 token 參數" });
    return;
  }

  const result = exchangeToken(token);
  if (!result) {
    res.status(401).json({ error: "登入連結已過期或無效，請重新產生" });
    return;
  }

  res.json({
    sessionToken: result.sessionToken,
    tgUserId: result.tgUserId,
    isAdmin: result.isAdmin,
  });
});

// 以下路由都需要認證
router.use(webAuthMiddleware);

/** POST /web/api/auth/logout */
router.post("/api/auth/logout", (req: Request, res: Response) => {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    destroySession(auth.slice(7));
  }
  res.json({ ok: true });
});

/** GET /web/api/auth/me — 當前用戶資訊 */
router.get("/api/auth/me", (req: Request, res: Response) => {
  const { tgUserId, isAdmin } = req.webAuth!;
  const user = getUserByTgId(tgUserId);
  res.json({
    tgUserId,
    isAdmin,
    username: user?.username ?? null,
    isActive: user ? Number(user.is_active) === 1 : true,
  });
});

// ---------------------------------------------------------------------------
// 用戶功能路由（普通用戶可存取自己的資料）
// ---------------------------------------------------------------------------

/** GET /web/api/models — 可用模型列表 */
router.get("/api/models", (req: Request, res: Response) => {
  const { isAdmin } = req.webAuth!;
  const allModels = getAllCachedModelNames();
  // 管理員可看全部；普通用戶暫時也返回全部（前端不強制限制模型列表顯示）
  res.json({ models: isAdmin ? allModels : allModels });
});

/** GET /web/api/keys — 我的 API Keys */
router.get("/api/keys", (req: Request, res: Response) => {
  const { tgUserId } = req.webAuth!;
  const keys = getKeysByUser(tgUserId);
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
router.post("/api/keys", (req: Request, res: Response) => {
  const { tgUserId } = req.webAuth!;
  try {
    const result = addApiKey(tgUserId);
    res.json({ key: result.key });
  } catch (err) {
    console.error("[web] addApiKey error:", err);
    res.status(500).json({ error: "新增 API Key 失敗" });
  }
});

/** DELETE /web/api/keys/:id — 刪除 API Key */
router.delete("/api/keys/:id", (req: Request, res: Response) => {
  const { tgUserId } = req.webAuth!;
  const keyId = parseInt(req.params.id, 10);
  if (isNaN(keyId)) {
    res.status(400).json({ error: "無效的 Key ID" });
    return;
  }

  // 驗證 key 確實屬於當前用戶
  const userKeys = getKeysByUser(tgUserId);
  if (!userKeys.some((k) => k.id === keyId)) {
    res.status(403).json({ error: "無權操作此 Key" });
    return;
  }

  try {
    deleteApiKey(keyId);
    res.json({ ok: true });
  } catch (err) {
    console.error("[web] deleteApiKey error:", err);
    res.status(500).json({ error: "刪除 API Key 失敗" });
  }
});

/** GET /web/api/usage — 我的用量 */
router.get("/api/usage", (req: Request, res: Response) => {
  const { tgUserId } = req.webAuth!;
  const records = getUsageByUser(tgUserId);
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
router.get("/api/coding", (req: Request, res: Response) => {
  const { tgUserId } = req.webAuth!;
  const cfg = getCodingConfigByTgId(tgUserId);
  res.json({ config: cfg });
});

/** PUT /web/api/coding — 更新 Coding 設定 */
router.put("/api/coding", (req: Request, res: Response) => {
  const { tgUserId } = req.webAuth!;
  const user = getUserByTgId(tgUserId);
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
    const result = setCodingConfig(user.id, opts);
    res.json({ config: result });
  } catch (err) {
    console.error("[web] setCodingConfig error:", err);
    res.status(500).json({ error: "更新 Coding 設定失敗" });
  }
});

/** GET /web/api/limits — 我的有效限制 + 今日/月用量 */
router.get("/api/limits", (req: Request, res: Response) => {
  const { tgUserId } = req.webAuth!;
  const user = getUserByTgId(tgUserId);
  if (!user) {
    res.status(404).json({ error: "用戶不存在" });
    return;
  }

  const limits = getEffectiveLimits(user.id, null);
  const daily = getDailyUsage(user.id, null);
  const monthly = getMonthlyUsage(user.id, null);
  res.json({ limits, daily, monthly });
});

/** GET /web/api/restrictions — 我的模型限制 */
router.get("/api/restrictions", (req: Request, res: Response) => {
  const { tgUserId } = req.webAuth!;
  const user = getUserByTgId(tgUserId);
  if (!user) {
    res.status(404).json({ error: "用戶不存在" });
    return;
  }
  const restrictions = getModelRestrictionsForUser(user.id);
  res.json({ restrictions });
});

/** GET /web/api/url — API 端點 URL */
router.get("/api/url", (_req: Request, res: Response) => {
  const apiUrl = getSetting("api_url") ?? config.DEFAULT_API_URL;
  res.json({ url: apiUrl });
});

// ---------------------------------------------------------------------------
// 管理員路由
// ---------------------------------------------------------------------------

router.use("/api/admin", requireAdmin);

// --- Providers ---

/** GET /web/api/admin/providers — 供應商列表 */
router.get("/api/admin/providers", (_req: Request, res: Response) => {
  const providers = getProviders(false);
  // 解析 api_key 為陣列但不回傳完整 key
  res.json({
    providers: providers.map((p) => ({
      ...p,
      api_keys: p.api_key ? parseApiKeys(p.api_key) : [],
      models_list: p.models ? p.models.split(",").map((m: string) => m.trim()).filter(Boolean) : [],
      model_prices: getModelPricesByProvider(p.id).map((mp) => ({
        model: mp.model,
        input_price: mp.input_price,
        output_price: mp.output_price,
      })),
    })),
  });
});

/** POST /web/api/admin/providers — 新增供應商 */
router.post("/api/admin/providers", (req: Request, res: Response) => {
  const { name, api_type, base_url, api_key, models, model_prices, input_price, output_price } = req.body;
  if (!name || !api_type || !base_url) {
    res.status(400).json({ error: "缺少必要欄位: name, api_type, base_url" });
    return;
  }

  try {
    // api_key: 前端傳逗號分隔字串，後端存 JSON 陣列
    const keysArray = api_key
      ? String(api_key).split(",").map((k: string) => k.trim()).filter(Boolean)
      : [];
    const modelsStr = models ? String(models) : "";
    addProvider({
      name,
      api_type,
      base_url: String(base_url).replace(/\/+$/, ""),
      api_key: JSON.stringify(keysArray),
      models: modelsStr,
      input_price: input_price != null ? Number(input_price) : null,
      output_price: output_price != null ? Number(output_price) : null,
    });

    // 取得新建立的 provider ID（addProvider 不返回 ID，從列表取最後一筆）
    if (Array.isArray(model_prices) && model_prices.length > 0) {
      const allProviders = getProviders(false);
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
          batchUpsertModelPrices(newProvider.id, entries);
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
router.put("/api/admin/providers/:id", (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "無效的 ID" });
    return;
  }

  const data: Record<string, unknown> = {};
  const { name, api_type, base_url, api_key, models, model_prices, enabled, input_price, output_price } = req.body;

  if (name !== undefined) data.name = String(name);
  if (api_type !== undefined) data.api_type = String(api_type);
  if (base_url !== undefined) data.base_url = String(base_url).replace(/\/+$/, "");
  if (api_key !== undefined) {
    const keysArray = String(api_key).split(",").map((k: string) => k.trim()).filter(Boolean);
    data.api_key = JSON.stringify(keysArray);
  }
  if (models !== undefined) data.models = String(models);
  if (enabled !== undefined) data.enabled = enabled ? 1 : 0;
  if (input_price !== undefined) data.input_price = input_price != null ? Number(input_price) : null;
  if (output_price !== undefined) data.output_price = output_price != null ? Number(output_price) : null;

  try {
    updateProvider(id, data);

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
      cleanupModelPrices(id, modelNames);
      if (entries.length > 0) {
        batchUpsertModelPrices(id, entries);
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("[web] updateProvider error:", err);
    res.status(500).json({ error: "更新供應商失敗" });
  }
});

/** DELETE /web/api/admin/providers — 刪除供應商（body: {ids:[]}） */
router.delete("/api/admin/providers", (req: Request, res: Response) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: "需要 ids 陣列" });
    return;
  }
  try {
    deleteProvider(ids.map((id: unknown) => parseInt(String(id), 10)).filter((n: number) => !isNaN(n)));
    res.json({ ok: true });
  } catch (err) {
    console.error("[web] deleteProvider error:", err);
    res.status(500).json({ error: "刪除供應商失敗" });
  }
});

/** GET /web/api/admin/provider-prices/:id — 供應商的模型定價 */
router.get("/api/admin/provider-prices/:id", (req: Request, res: Response) => {
  const providerId = parseInt(req.params.id, 10);
  if (isNaN(providerId)) {
    res.status(400).json({ error: "無效的 ID" });
    return;
  }
  const prices = getModelPricesByProvider(providerId);
  res.json({ prices });
});

/** PUT /web/api/admin/provider-prices/:id — 批量更新定價 */
router.put("/api/admin/provider-prices/:id", (req: Request, res: Response) => {
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
    batchUpsertModelPrices(providerId, entries.map((e: { model: string; input_price: number | null; output_price: number | null }) => ({
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
router.get("/api/admin/users", (_req: Request, res: Response) => {
  const users = getUsers();
  res.json({
    users: users.map((u) => ({
      ...u,
      is_admin: Number(u.tg_user_id) === config.ADMIN_ID,
    })),
  });
});

/** POST /web/api/admin/users — 新增用戶 */
router.post("/web/api/admin/users", (req: Request, res: Response) => {
  const { tgUserId, username } = req.body;
  if (!tgUserId || isNaN(parseInt(tgUserId, 10))) {
    res.status(400).json({ error: "需要有效的 tgUserId" });
    return;
  }
  const uid = parseInt(tgUserId, 10);

  // 檢查是否已存在
  if (getUserByTgId(uid)) {
    res.status(409).json({ error: "該用戶已存在" });
    return;
  }

  try {
    addUser(uid, username ? String(username) : null);
    // 新用戶自動歸入預設分組
    const defaultGroup = getDefaultUserGroup();
    if (defaultGroup) {
      const newUser = getUserByTgId(uid);
      if (newUser) {
        setUserGroup(newUser.id, defaultGroup.id);
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("[web] addUser error:", err);
    res.status(500).json({ error: "新增用戶失敗" });
  }
});

/** PUT /web/api/admin/users/:id/status — 更新用戶狀態 */
router.put("/api/admin/users/:id/status", (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "無效的 ID" });
    return;
  }
  const { isActive } = req.body;
  try {
    updateUserStatus(id, isActive ? 1 : 0);
    res.json({ ok: true });
  } catch (err) {
    console.error("[web] updateUserStatus error:", err);
    res.status(500).json({ error: "更新用戶狀態失敗" });
  }
});

/** PUT /web/api/admin/users/:id/tg-id — 更新用戶 TG ID */
router.put("/api/admin/users/:id/tg-id", (req: Request, res: Response) => {
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
    const user = getUserById(id);
    if (!user) {
      res.status(404).json({ error: "用戶不存在" });
      return;
    }
    updateUserTgId(user.tg_user_id, parseInt(newTgId, 10));
    res.json({ ok: true });
  } catch (err) {
    console.error("[web] updateUserTgId error:", err);
    res.status(500).json({ error: "更新 TG ID 失敗" });
  }
});

/** DELETE /web/api/admin/users/:id — 刪除用戶 */
router.delete("/api/admin/users/:id", (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "無效的 ID" });
    return;
  }
  try {
    deleteUser(id);
    res.json({ ok: true });
  } catch (err) {
    console.error("[web] deleteUser error:", err);
    res.status(500).json({ error: "刪除用戶失敗" });
  }
});

/** GET /web/api/admin/users/:id/keys — 用戶的 API Keys */
router.get("/api/admin/users/:id/keys", (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "無效的 ID" });
    return;
  }
  const user = getUserById(id);
  if (!user) {
    res.status(404).json({ error: "用戶不存在" });
    return;
  }
  const keys = getKeysByUser(user.tg_user_id);
  res.json({ keys });
});

/** DELETE /web/api/admin/users/:id/keys/:keyId — 刪除用戶 API Key */
router.delete("/api/admin/users/:id/keys/:keyId", (req: Request, res: Response) => {
  const keyId = parseInt(req.params.keyId, 10);
  if (isNaN(keyId)) {
    res.status(400).json({ error: "無效的 Key ID" });
    return;
  }
  try {
    deleteApiKey(keyId);
    res.json({ ok: true });
  } catch (err) {
    console.error("[web] deleteApiKey (admin) error:", err);
    res.status(500).json({ error: "刪除 API Key 失敗" });
  }
});

/** GET /web/api/admin/users/:id/limits — 用戶限制詳情 */
router.get("/api/admin/users/:id/limits", (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "無效的 ID" });
    return;
  }
  const userWithLimits = getUserWithLimits(id);
  if (!userWithLimits) {
    res.status(404).json({ error: "用戶不存在" });
    return;
  }
  const limits = getEffectiveLimits(id, null);
  const daily = getDailyUsage(id, null);
  const monthly = getMonthlyUsage(id, null);
  res.json({ user: userWithLimits, effectiveLimits: limits, daily, monthly });
});

/** PUT /web/api/admin/users/:id/limits — 設定用戶分組+覆蓋 */
router.put("/api/admin/users/:id/limits", (req: Request, res: Response) => {
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
        setUserGroup(id, gid);
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
        setUserOverrides(id, clean);
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
router.get("/api/admin/users/:id/restrictions", (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "無效的 ID" });
    return;
  }
  const restrictions = getModelRestrictionsForUser(id);
  res.json({ restrictions });
});

/** PUT /web/api/admin/users/:id/restrictions — 設定用戶模型限制 */
router.put("/api/admin/users/:id/restrictions", (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "無效的 ID" });
    return;
  }
  const { apiKeyId, mode, models, action } = req.body;

  try {
    if (action === "delete") {
      const keyId = apiKeyId != null ? parseInt(apiKeyId, 10) : null;
      deleteModelRestriction(id, keyId);
    } else {
      if (!mode || !models) {
        res.status(400).json({ error: "需要 mode 和 models" });
        return;
      }
      const keyId = apiKeyId != null ? parseInt(apiKeyId, 10) : null;
      setModelRestriction(id, keyId, mode === "whitelist" ? "whitelist" : "blacklist", String(models));
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("[web] setUserRestriction error:", err);
    res.status(500).json({ error: "設定模型限制失敗" });
  }
});

// --- API Key Limits ---

/** GET /web/api/admin/keys/:id/limits — API Key 限制詳情 */
router.get("/api/admin/keys/:id/limits", (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "無效的 ID" });
    return;
  }
  const keyWithLimits = getApiKeyWithLimits(id);
  if (!keyWithLimits) {
    res.status(404).json({ error: "API Key 不存在" });
    return;
  }
  res.json({ key: keyWithLimits });
});

/** PUT /web/api/admin/keys/:id/limits — 設定 API Key 覆蓋 */
router.put("/api/admin/keys/:id/limits", (req: Request, res: Response) => {
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
      setApiKeyOverrides(id, clean);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("[web] setApiKeyLimits error:", err);
    res.status(500).json({ error: "設定 API Key 限制失敗" });
  }
});

// --- Groups ---

/** GET /web/api/admin/groups — 用戶分組列表 */
router.get("/api/admin/groups", (_req: Request, res: Response) => {
  const groups = getUserGroups();
  res.json({ groups });
});

/** POST /web/api/admin/groups — 新增分組 */
router.post("/api/admin/groups", (req: Request, res: Response) => {
  const { name, display_name, ...limits } = req.body;
  if (!name) {
    res.status(400).json({ error: "需要 name" });
    return;
  }
  try {
    addUserGroup({ name: String(name), display_name: display_name ?? null, ...limits });
    res.json({ ok: true });
  } catch (err) {
    console.error("[web] addUserGroup error:", err);
    res.status(500).json({ error: "新增分組失敗" });
  }
});

/** PUT /web/api/admin/groups/:id — 更新分組 */
router.put("/api/admin/groups/:id", (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "無效的 ID" });
    return;
  }
  try {
    updateUserGroup(id, req.body);
    res.json({ ok: true });
  } catch (err) {
    console.error("[web] updateUserGroup error:", err);
    res.status(500).json({ error: "更新分組失敗" });
  }
});

/** DELETE /web/api/admin/groups/:id — 刪除分組 */
router.delete("/api/admin/groups/:id", (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "無效的 ID" });
    return;
  }
  try {
    deleteUserGroup(id);
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

// --- Usage (admin) ---

/** GET /web/api/admin/usage — 全部用量統計 */
router.get("/api/admin/usage", (req: Request, res: Response) => {
  const { byUser } = req.query;

  if (byUser) {
    // 按用戶統計
    const tgId = parseInt(String(byUser), 10);
    if (!isNaN(tgId)) {
      const records = getUsageByUser(tgId);
      res.json({ records: records.slice(-200) });
      return;
    }
  }

  const total = getTotalUsage();
  res.json({ total });
});

// --- Settings ---

/** GET /web/api/admin/settings — 系統設定 */
router.get("/api/admin/settings", (_req: Request, res: Response) => {
  const apiUrl = getSetting("api_url") ?? config.DEFAULT_API_URL;
  res.json({ settings: { api_url: apiUrl } });
});

/** PUT /web/api/admin/settings — 更新系統設定 */
router.put("/api/admin/settings", (req: Request, res: Response) => {
  const { api_url } = req.body;
  if (api_url !== undefined) {
    setSetting("api_url", String(api_url).replace(/\/+$/, ""));
  }
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// API Test — 協議偵測
// ---------------------------------------------------------------------------

/** POST /web/api/admin/api-test — 偵測 API 協議（有/無 API Key） */
router.post("/api/admin/api-test", async (req: Request, res: Response) => {
  const { baseUrl, apiKey } = req.body;
  if (!baseUrl || typeof baseUrl !== "string") {
    res.status(400).json({ error: "缺少 baseUrl" });
    return;
  }

  try {
    if (apiKey && typeof apiKey === "string") {
      const result = await detectApiProtocols(baseUrl, apiKey);
      res.json({ result, usedAuth: true });
    } else {
      const { result, allUnreachable } = await detectProtocolsNoAuth(baseUrl);
      res.json({ result, usedAuth: false, allUnreachable });
    }
  } catch (err) {
    console.error("[web] api-test error:", err);
    res.status(500).json({ error: "偵測失敗：" + (err instanceof Error ? err.message : String(err)) });
  }
});

// ---------------------------------------------------------------------------
// Model Catch — 模型抓取
// ---------------------------------------------------------------------------

/** POST /web/api/admin/model-catch — 抓取模型列表（有/無 API Key） */
router.post("/api/admin/model-catch", async (req: Request, res: Response) => {
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

/** POST /web/api/admin/provider-detect — 偵測協議（僅協議，不含模型/定價） */
router.post("/api/admin/provider-detect", async (req: Request, res: Response) => {
  const { baseUrl, apiKey } = req.body;
  if (!baseUrl || typeof baseUrl !== "string") {
    res.status(400).json({ error: "缺少 baseUrl" });
    return;
  }

  try {
    const key = apiKey || "";
    const detection = await detectApiProtocols(baseUrl, key);
    res.json({ detection });
  } catch (err) {
    console.error("[web] provider-detect error:", err);
    res.status(500).json({ error: "偵測失敗：" + (err instanceof Error ? err.message : String(err)) });
  }
});

/** POST /web/api/admin/provider-models — 抓取模型列表（需 API Key） */
router.post("/api/admin/provider-models", async (req: Request, res: Response) => {
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
router.post("/api/admin/provider-pricing", async (req: Request, res: Response) => {
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

// ---------------------------------------------------------------------------
// System — 版本 / 更新 / 重啟
// ---------------------------------------------------------------------------

/** GET /web/api/admin/version — 當前版本 */
router.get("/api/admin/version", (_req: Request, res: Response) => {
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
router.get("/api/admin/check-update", async (_req: Request, res: Response) => {
  try {
    const result = await fetchAndCheckUpdate();
    res.json(result);
  } catch (err) {
    console.error("[web] check-update error:", err);
    res.status(500).json({ error: "檢查更新失敗：" + (err instanceof Error ? err.message : String(err)) });
  }
});

/** POST /web/api/admin/update — 執行更新 */
router.post("/api/admin/update", async (req: Request, res: Response) => {
  try {
    const result = await performUpdate();
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
router.post("/api/admin/restart", (req: Request, res: Response) => {
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
// Export
// ---------------------------------------------------------------------------

export default router;

/**
 * Comprehensive Node.js plugin example for s12ryt-tg-api (v2.0.0)
 *
 * Showcases ALL six context.services capabilities:
 *   1. auth        — admin/trusted checks, request auth
 *   2. storage     — plugin-scoped JSON KV store
 *   3. events      — in-process pub/sub event bus
 *   4. scheduler   — managed timers (auto-cleanup on stop)
 *   5. providers   — read-only provider/model/price/mapping queries
 *   6. db          — read-only user/usage/limits queries (masked keys)
 *
 * Plus multi-service integration scenarios:
 *   - GET /dashboard     (auth + db + providers + storage)
 *   - /my_usage command  (bot handler + db)
 *   - lifecycle hooks    (events + scheduler cleanup)
 *
 * NOTE: All async service calls are properly awaited.
 *       The old v1 example had a bug where getUserByTelegramId was
 *       called without await — this version fixes that.
 */

import type { NodeJsPlugin } from "../../nodejs/src/plugins/types.js";

// ---------------------------------------------------------------------------
// Module-level state (persists for the plugin's lifetime)
// ---------------------------------------------------------------------------

const startedAt = new Date();

/** Tracks timer IDs created via scheduler so we can list/clear them. */
const activeTimers = new Map<string, { type: "timeout" | "interval"; note: string; createdAt: string }>();

/** Rolling log of events received by this plugin's listeners. */
const eventLog: { name: string; payload: unknown; at: string }[] = [];
const MAX_EVENT_LOG = 20;

/** Rolling log of scheduler fire records. */
const schedulerLog: { timerId: string; note: string; at: string }[] = [];
const MAX_SCHEDULER_LOG = 20;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deep-clone via JSON to avoid sending non-serializable values in responses. */
function toSafeJson(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value ?? null));
  } catch {
    return null;
  }
}

/** Wraps an async Express handler so rejections are forwarded to Express error handling. */
function asyncHandler(
  fn: (req: any, res: any, next?: any) => Promise<void>,
): (req: any, res: any, next: any) => void {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function recordEvent(name: string, payload: unknown): void {
  eventLog.unshift({ name, payload: toSafeJson(payload), at: new Date().toISOString() });
  if (eventLog.length > MAX_EVENT_LOG) eventLog.length = MAX_EVENT_LOG;
}

function recordSchedulerFire(timerId: string, note: string): void {
  schedulerLog.unshift({ timerId, note, at: new Date().toISOString() });
  if (schedulerLog.length > MAX_SCHEDULER_LOG) schedulerLog.length = MAX_SCHEDULER_LOG;
}

/** Full route map for /status output and documentation. */
const ROUTE_GROUPS = [
  {
    group: "base",
    description: "插件狀態與綜合儀表板",
    routes: ["GET /status", "GET /dashboard"],
  },
  {
    group: "auth",
    description: "services.auth — 認證資訊與權限檢查",
    routes: ["GET /auth/me"],
  },
  {
    group: "storage",
    description: "services.storage — 插件專屬 JSON KV 儲存",
    routes: ["GET /storage", "GET /storage/:key", "POST /storage/:key", "DELETE /storage/:key"],
  },
  {
    group: "events",
    description: "services.events — 程序內事件匯流排",
    routes: ["POST /events/emit", "GET /events/listeners/:name", "GET /events/log"],
  },
  {
    group: "scheduler",
    description: "services.scheduler — 受控計時器",
    routes: [
      "POST /scheduler/timeout",
      "POST /scheduler/interval",
      "DELETE /scheduler/:id",
      "GET /scheduler/active",
    ],
  },
  {
    group: "providers",
    description: "services.providers — 只讀供應商/模型查詢",
    routes: [
      "GET /providers/list",
      "GET /providers/models",
      "GET /providers/lookup/:model",
      "GET /providers/:id/prices",
      "GET /providers/mappings",
    ],
  },
  {
    group: "db",
    description: "services.db — 只讀用戶/用量/限制查詢",
    routes: [
      "GET /db/me",
      "GET /db/keys",
      "GET /db/limits",
      "GET /db/usage/daily",
      "GET /db/usage/monthly",
      "GET /db/models/allowed",
    ],
  },
] as const;

const BOT_COMMANDS = ["/plugin_example", "/my_usage", "/plugin_data"] as const;

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const PLUGIN_DESCRIPTION =
  "Comprehensive Node.js plugin example — showcases all 6 plugin services + multi-service scenarios";

const plugin: NodeJsPlugin = {
  name: "nodejs-example",
  version: "2.0.0",
  description: PLUGIN_DESCRIPTION,

  setup(context) {
    const { router, services, logger } = context;

    logger.info("setup hook called — registering routes, middleware, events, and bot commands");

    // ================================================================
    // Middleware (usePluginMiddleware)
    // ================================================================
    context.usePluginMiddleware((_req, res, next) => {
      res.setHeader("X-Plugin-Name", context.name);
      res.setHeader("X-Plugin-Version", context.version);
      next();
    });

    // ================================================================
    // Event listeners (services.events.on)
    // Registered at setup so they're active before onStart fires.
    // ================================================================
    services.events.on("plugin:demo", (payload) => {
      recordEvent("plugin:demo", payload);
      logger.info("event received: plugin:demo");
    });
    services.events.on("plugin:started", (payload) => {
      recordEvent("plugin:started", payload);
    });
    services.events.on("plugin:stopped", (payload) => {
      recordEvent("plugin:stopped", payload);
    });

    // ================================================================
    // Base routes
    // ================================================================

    /** GET /status — plugin overview with full route map. */
    router.get("/status", (_req, res) => {
      res.json({
        plugin: context.name,
        version: context.version,
        description: PLUGIN_DESCRIPTION,
        startedAt: startedAt.toISOString(),
        uptimeSec: Math.round((Date.now() - startedAt.getTime()) / 1000),
        state: {
          activeTimers: activeTimers.size,
          eventLogEntries: eventLog.length,
          schedulerLogEntries: schedulerLog.length,
        },
        routeGroups: ROUTE_GROUPS,
        botCommands: BOT_COMMANDS,
      });
    });

    // ================================================================
    // Auth routes (services.auth)
    // Demonstrates: requireRequestAuth, isAdminTelegramUser,
    //               isTrustedTelegramUser (async)
    // ================================================================

    /** GET /auth/me — full auth breakdown for the current request. */
    router.get(
      "/auth/me",
      asyncHandler(async (req, res) => {
        const auth = services.auth.requireRequestAuth(req);
        const isTrusted = await services.auth.isTrustedTelegramUser(auth.tgUserId);
        res.json({
          plugin: context.name,
          auth,
          checks: {
            isAdmin: services.auth.isAdminTelegramUser(auth.tgUserId),
            isTrusted,
          },
        });
      }),
    );

    // ================================================================
    // Storage routes (services.storage) — all synchronous
    // Demonstrates: keys, has, get, set, delete
    // ================================================================

    /** GET /storage — list all keys for this plugin. */
    router.get("/storage", (_req, res) => {
      res.json({ plugin: context.name, keys: services.storage.keys() });
    });

    /** GET /storage/:key — read a value. */
    router.get("/storage/:key", (req, res) => {
      const key = req.params.key;
      const exists = services.storage.has(key);
      const value = services.storage.get(key);
      res.json({ plugin: context.name, key, exists, value });
    });

    /** POST /storage/:key — write a value. Body: { "value": <any JSON> } */
    router.post("/storage/:key", (req, res) => {
      const key = req.params.key;
      const value = req.body?.value ?? null;
      services.storage.set(key, value);
      res.json({ plugin: context.name, key, stored: true, value });
    });

    /** DELETE /storage/:key — delete a value. */
    router.delete("/storage/:key", (req, res) => {
      const key = req.params.key;
      const existed = services.storage.delete(key);
      res.json({ plugin: context.name, key, deleted: existed });
    });

    // ================================================================
    // Events routes (services.events)
    // Demonstrates: emit (async), listenerCount
    // ================================================================

    /** POST /events/emit — publish an event. Body: { "name": "...", "payload": <any> } */
    router.post(
      "/events/emit",
      asyncHandler(async (req, res) => {
        const eventName = req.body?.name;
        if (!eventName || typeof eventName !== "string") {
          res.status(400).json({ error: "body.name (string) is required" });
          return;
        }
        const payload = req.body?.payload ?? null;
        await services.events.emit(eventName, payload);
        res.json({
          plugin: context.name,
          emitted: eventName,
          listeners: services.events.listenerCount(eventName),
        });
      }),
    );

    /** GET /events/listeners/:name — check how many listeners are registered. */
    router.get("/events/listeners/:name", (req, res) => {
      const name = req.params.name;
      res.json({ plugin: context.name, event: name, listeners: services.events.listenerCount(name) });
    });

    /** GET /events/log — recent events received by this plugin's listeners. */
    router.get("/events/log", (_req, res) => {
      res.json({ plugin: context.name, events: eventLog });
    });

    // ================================================================
    // Scheduler routes (services.scheduler)
    // Demonstrates: setTimeout, setInterval, clear, clearAll
    // ================================================================

    /** POST /scheduler/timeout — schedule a one-shot timer. Body: { "delayMs": 5000, "note": "..." } */
    router.post("/scheduler/timeout", (req, res) => {
      const delayMs = Number(req.body?.delayMs);
      const note = String(req.body?.note ?? "(no note)");
      if (!Number.isFinite(delayMs) || delayMs < 1000) {
        res.status(400).json({ error: "body.delayMs must be a number >= 1000 (ms)" });
        return;
      }
      const timerId = services.scheduler.setTimeout(async () => {
        recordSchedulerFire(timerId, note);
        logger.info(`scheduler timeout fired: ${note}`);
        await services.events.emit("plugin:scheduler:timeout", { timerId, note });
      }, delayMs);
      activeTimers.set(timerId, { type: "timeout", note, createdAt: new Date().toISOString() });
      res.json({ plugin: context.name, timerId, type: "timeout", delayMs, note });
    });

    /** POST /scheduler/interval — schedule a recurring timer. Body: { "intervalMs": 10000, "note": "..." } */
    router.post("/scheduler/interval", (req, res) => {
      const intervalMs = Number(req.body?.intervalMs);
      const note = String(req.body?.note ?? "(no note)");
      if (!Number.isFinite(intervalMs) || intervalMs < 1000) {
        res.status(400).json({ error: "body.intervalMs must be a number >= 1000 (ms)" });
        return;
      }
      const timerId = services.scheduler.setInterval(async () => {
        recordSchedulerFire(timerId, note);
        logger.info(`scheduler interval fired: ${note}`);
        await services.events.emit("plugin:scheduler:interval", { timerId, note });
      }, intervalMs);
      activeTimers.set(timerId, { type: "interval", note, createdAt: new Date().toISOString() });
      res.json({ plugin: context.name, timerId, type: "interval", intervalMs, note });
    });

    /** DELETE /scheduler/:id — cancel a timer. */
    router.delete("/scheduler/:id", (req, res) => {
      const timerId = req.params.id;
      const cleared = services.scheduler.clear(timerId);
      activeTimers.delete(timerId);
      res.json({ plugin: context.name, timerId, cleared });
    });

    /** GET /scheduler/active — list active timers + recent fire log. */
    router.get("/scheduler/active", (_req, res) => {
      res.json({
        plugin: context.name,
        active: [...activeTimers.entries()].map(([id, info]) => ({ id, ...info })),
        recentFires: schedulerLog,
      });
    });

    // ================================================================
    // Providers routes (services.providers)
    // Demonstrates: list (async), listModels (sync), lookupModel (sync),
    //               getModelPrices (async), getModelMappings (async)
    // ================================================================

    /** GET /providers/list — list providers. ?enabled=true for enabled only. */
    router.get(
      "/providers/list",
      asyncHandler(async (req, res) => {
        const enabledOnly = req.query.enabled === "true";
        const providers = await services.providers.list({ enabledOnly });
        res.json({ plugin: context.name, count: providers.length, providers });
      }),
    );

    /** GET /providers/models — all cached model names (synchronous). */
    router.get("/providers/models", (_req, res) => {
      const models = services.providers.listModels();
      res.json({ plugin: context.name, count: models.length, models });
    });

    /** GET /providers/lookup/:model — find which provider serves a model. */
    router.get("/providers/lookup/:model", (req, res) => {
      const model = req.params.model;
      const result = services.providers.lookupModel(model);
      if (!result) {
        res.status(404).json({ plugin: context.name, error: `No provider found for model: ${model}` });
        return;
      }
      res.json({ plugin: context.name, model, provider: result });
    });

    /** GET /providers/:id/prices — model prices for a provider. */
    router.get(
      "/providers/:id/prices",
      asyncHandler(async (req, res) => {
        const providerId = Number(req.params.id);
        if (!Number.isFinite(providerId) || providerId <= 0) {
          res.status(400).json({ error: "provider id must be a positive number" });
          return;
        }
        const prices = await services.providers.getModelPrices(providerId);
        res.json({ plugin: context.name, providerId, count: prices.length, prices });
      }),
    );

    /** GET /providers/mappings — all model display-name mappings. */
    router.get(
      "/providers/mappings",
      asyncHandler(async (_req, res) => {
        const mappings = await services.providers.getModelMappings();
        res.json({ plugin: context.name, count: mappings.length, mappings });
      }),
    );

    // ================================================================
    // DB routes (services.db) — all async, properly awaited
    // Demonstrates: getUserByTelegramId, listApiKeyPreviewsByTelegramId,
    //               getEffectiveLimits, getDailyUsage, getMonthlyUsage,
    //               getAllowedModels
    // ================================================================

    /** GET /db/me — current user info via Telegram ID. */
    router.get(
      "/db/me",
      asyncHandler(async (req, res) => {
        const auth = services.auth.requireRequestAuth(req);
        const user = await services.db.getUserByTelegramId(auth.tgUserId);
        res.json({ plugin: context.name, user });
      }),
    );

    /** GET /db/keys — API key previews for the current user. */
    router.get(
      "/db/keys",
      asyncHandler(async (req, res) => {
        const auth = services.auth.requireRequestAuth(req);
        const keys = await services.db.listApiKeyPreviewsByTelegramId(auth.tgUserId);
        res.json({ plugin: context.name, count: keys.length, keys });
      }),
    );

    /** GET /db/limits — effective limits for the current user + key. */
    router.get(
      "/db/limits",
      asyncHandler(async (req, res) => {
        const auth = services.auth.requireRequestAuth(req);
        const limits = await services.db.getEffectiveLimits(auth.userId, auth.apiKeyId);
        res.json({ plugin: context.name, limits });
      }),
    );

    /** GET /db/usage/daily — today's token/cost usage. */
    router.get(
      "/db/usage/daily",
      asyncHandler(async (req, res) => {
        const auth = services.auth.requireRequestAuth(req);
        const usage = await services.db.getDailyUsage(auth.userId, auth.apiKeyId);
        res.json({ plugin: context.name, period: "daily", usage });
      }),
    );

    /** GET /db/usage/monthly — this month's token/cost usage. */
    router.get(
      "/db/usage/monthly",
      asyncHandler(async (req, res) => {
        const auth = services.auth.requireRequestAuth(req);
        const usage = await services.db.getMonthlyUsage(auth.userId, auth.apiKeyId);
        res.json({ plugin: context.name, period: "monthly", usage });
      }),
    );

    /** GET /db/models/allowed — models the current user is allowed to use. */
    router.get(
      "/db/models/allowed",
      asyncHandler(async (req, res) => {
        const auth = services.auth.requireRequestAuth(req);
        const allModels = services.providers.listModels();
        const isAdmin = services.auth.isAdminTelegramUser(auth.tgUserId);
        const allowed = await services.db.getAllowedModels(
          auth.userId,
          auth.apiKeyId,
          allModels,
          isAdmin,
        );
        res.json({
          plugin: context.name,
          totalModels: allModels.length,
          allowedCount: allowed.length,
          allowed,
        });
      }),
    );

    // ================================================================
    // Dashboard route — multi-service integration scenario
    // Combines: auth + db (user, usage) + providers (models, providers)
    //         + storage (preferences)
    // ================================================================

    /** GET /dashboard — aggregated view using 4 services in parallel. */
    router.get(
      "/dashboard",
      asyncHandler(async (req, res) => {
        const auth = services.auth.requireRequestAuth(req);
        const isAdmin = services.auth.isAdminTelegramUser(auth.tgUserId);

        // Parallel queries for efficiency
        const [user, dailyUsage, monthlyUsage, allModels, enabledProviders] = await Promise.all([
          services.db.getUserByTelegramId(auth.tgUserId),
          services.db.getDailyUsage(auth.userId, auth.apiKeyId),
          services.db.getMonthlyUsage(auth.userId, auth.apiKeyId),
          services.providers.listModels(),
          services.providers.list({ enabledOnly: true }),
        ]);

        // Read preferences from storage (synchronous)
        const preferences = services.storage.get("preferences");

        res.json({
          plugin: context.name,
          generatedAt: new Date().toISOString(),
          user,
          isAdmin,
          summary: {
            totalModels: allModels.length,
            enabledProviders: enabledProviders.length,
            dailyUsage,
            monthlyUsage,
          },
          preferences,
          activeTimers: activeTimers.size,
          uptimeSec: Math.round((Date.now() - startedAt.getTime()) / 1000),
        });
      }),
    );

    // ================================================================
    // Bot commands
    // ================================================================

    context.registerBotCommand({
      command: "plugin_example",
      description: "查看插件資訊與可用路由",
      async handler(ctx) {
        const lines = [
          `🔌 ${context.name} v${context.version}`,
          "",
          "📋 可用 API 路由（需 API Key 認證）：",
          "  GET  /plugins/nodejs-example/status",
          "  GET  /plugins/nodejs-example/dashboard",
          "  GET  /plugins/nodejs-example/auth/me",
          "  GET  /plugins/nodejs-example/storage",
          "  POST /plugins/nodejs-example/events/emit",
          "  GET  /plugins/nodejs-example/providers/models",
          "  GET  /plugins/nodejs-example/db/usage/daily",
          "",
          "🤖 Bot 指令：",
          "  /plugin_example — 本說明",
          "  /my_usage — 查看今日/本月用量",
          "  /plugin_data — 查看 storage 資料",
          "",
          `⏱ 運行時間：${Math.round((Date.now() - startedAt.getTime()) / 1000)} 秒`,
        ];
        await ctx.reply(lines.join("\n"));
      },
    });

    context.registerBotCommand({
      command: "my_usage",
      description: "查看自己的 API 用量統計",
      async handler(ctx) {
        // Permission check: must be a trusted user
        const tgUserId = ctx.from?.id ?? null;
        await services.auth.requireTrustedTelegramUser(tgUserId);

        const user = await services.db.getUserByTelegramId(tgUserId!);
        if (!user) {
          await ctx.reply("❌ 找不到你的用戶資料。");
          return;
        }

        const daily = await services.db.getDailyUsage(user.id);
        const monthly = await services.db.getMonthlyUsage(user.id);

        const lines = [
          `📊 用量統計 — ${user.username ?? `ID:${user.id}`}`,
          "",
          `📅 今日：`,
          `  Input: ${daily.total_input_tokens ?? 0} / Output: ${daily.total_output_tokens ?? 0}`,
          `  費用: $${Number(daily.total_cost ?? 0).toFixed(4)}`,
          "",
          `📅 本月：`,
          `  Input: ${monthly.total_input_tokens ?? 0} / Output: ${monthly.total_output_tokens ?? 0}`,
          `  費用: $${Number(monthly.total_cost ?? 0).toFixed(4)}`,
        ];
        await ctx.reply(lines.join("\n"));
      },
    });

    context.registerBotCommand({
      command: "plugin_data",
      description: "查看插件的 storage 資料",
      async handler(ctx) {
        services.auth.requireAdminTelegramUser(ctx.from?.id ?? null);

        const keys = services.storage.keys();
        if (keys.length === 0) {
          await ctx.reply("📦 Storage 目前是空的。");
          return;
        }

        const entries = keys.map((k) => {
          const v = services.storage.get(k);
          const str = JSON.stringify(v);
          return `  ${k}: ${str.length > 100 ? str.slice(0, 100) + "…" : str}`;
        });
        await ctx.reply(["📦 Storage 資料：", "", ...entries].join("\n"));
      },
    });

    // Record setup completion in storage
    services.storage.set("lastSetupAt", new Date().toISOString());
    services.storage.set("setupCount", (services.storage.get<number>("setupCount") ?? 0) + 1);

    logger.info("setup complete — all routes and commands registered");
  },

  // ================================================================
  // Lifecycle hooks
  // ================================================================

  async onStart(context) {
    const { services, logger } = context;
    logger.info("onStart hook called");

    // Record start info in storage
    services.storage.set("startedAt", startedAt.toISOString());

    // Publish a lifecycle event (demonstrates events.emit in lifecycle)
    await services.events.emit("plugin:started", {
      name: context.name,
      version: context.version,
      at: startedAt.toISOString(),
    });

    logger.info("plugin started successfully");
  },

  async onStop(context) {
    const { services, logger } = context;

    // Publish stop event before cleanup
    await services.events.emit("plugin:stopped", {
      name: context.name,
      at: new Date().toISOString(),
    });

    // Clean up all timers (scheduler.clearAll handles this, but we also
    // clear our local tracking map)
    services.scheduler.clearAll();
    activeTimers.clear();

    // Record uptime
    services.storage.set("lastStoppedAt", new Date().toISOString());
    services.storage.set(
      "lastUptimeSec",
      Math.round((Date.now() - startedAt.getTime()) / 1000),
    );

    logger.info("plugin stopped — all timers and events cleaned up");
  },
};

export default plugin;

/**
 * s12ryt-tg-api — Main entry point.
 *
 * Starts:
 *   1. SQLite database
 *   2. grammY Telegram Bot (with conversations plugin)
 *   3. Express API proxy server
 */

import { config } from "./config.js";
import { initDbAsync, closeDb } from "./db/database.js";
import { startServer } from "./api/server.js";
import { startTunnel, stopTunnel } from "./tunnel.js";
import { registerUserHandlers } from "./bot/handlers/userHandlers.js";
import { registerAdminHandlers } from "./bot/handlers/adminHandlers.js";
import { registerLimitHandlers } from "./bot/handlers/limitHandlers.js";
import { registerUpdateHandlers } from "./bot/handlers/updateHandlers.js";
import { registerWebHandlers } from "./bot/handlers/webHandlers.js";
import { registerBackupHandlers } from "./bot/handlers/backupHandlers.js";
import {
  getPluginBotCommands,
  initializeNodeJsPlugins,
  loadNodeJsPlugins,
  shutdownNodeJsPlugins,
  startNodeJsPlugins,
} from "./plugins/index.js";

import { Bot, Context, session } from "grammy";
import type { BotCommand } from "grammy/types";
import { conversations, ConversationFlavor } from "@grammyjs/conversations";

// ---------------------------------------------------------------------------
// Custom context type
// ---------------------------------------------------------------------------

type MyContext = Context & ConversationFlavor;
type MyBot = Bot<MyContext>;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateConfig(): void {
  if (config.WEB_AUTH_MODE === "telegram") {
    // telegram 模式需要 BOT_TOKEN + ADMIN_ID
    if (!config.BOT_TOKEN) {
      throw new Error("BOT_TOKEN is required in WEB_AUTH_MODE=telegram. Check your .env file.");
    }
    if (config.ADMIN_ID === null || isNaN(config.ADMIN_ID)) {
      throw new Error("ADMIN_ID must be a valid number in WEB_AUTH_MODE=telegram. Check your .env file.");
    }
  }
  // password 模式不需要 BOT_TOKEN / ADMIN_ID，Bot 不會啟動
}

// ---------------------------------------------------------------------------
// Set bot commands
// ---------------------------------------------------------------------------

async function setBotCommands(bot: MyBot, pluginCommands: BotCommand[] = []): Promise<void> {
  // 普通用戶指令
  const userCommands: BotCommand[] = [
    { command: "start", description: "開始使用 Bot" },
    { command: "url", description: "獲取 API 接口地址" },
    { command: "key", description: "API Key 管理（查看/新增/刪除）" },
    { command: "usage", description: "查詢 Token 用量" },
    { command: "coding", description: "Coding 模式管理（開關/設定）" },
    { command: "model_catch", description: "抓取 API 模型列表" },
    { command: "my_limits", description: "查看我的限制和用量" },
    { command: "web", description: "取得 Web 控制台登入連結" },
    { command: "cancel", description: "取消當前進行中的操作" },
  ];

  // 管理員指令
  const adminCommands: BotCommand[] = [
    { command: "provider", description: "供應商管理（新增/刪除/編輯/列表）" },
    { command: "uu", description: "查詢用戶用量" },
    { command: "admin_user", description: "用戶管理（新增/停用/刪除/編輯/移除Key）" },
    { command: "sub_url", description: "修改 API 接口地址" },
    { command: "api_test", description: "測試 API 協議連通性" },
    { command: "limits", description: "權限管理（分組/限制/配額）" },
    { command: "version", description: "查看程式版本" },
    { command: "update", description: "檢查並更新程式" },
    { command: "restart", description: "重啟進程" },
    { command: "backup", description: "備份/還原資料庫" },
  ];

  try {
    // 設置所有私人聊天可見的指令（用戶 + 管理員全部）
    const commands = new Map<string, BotCommand>();
    for (const command of [...userCommands, ...adminCommands, ...pluginCommands]) {
      commands.set(command.command, command);
    }
    await bot.api.setMyCommands([...commands.values()]);
    console.log("[bot] Command menu set successfully");
  } catch (err: any) {
    console.error(`[bot] Failed to set commands: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== s12ryt-tg-api ===");
  console.log(`[config] WEB_AUTH_MODE=${config.WEB_AUTH_MODE}`);

  // 1. Validate configuration
  try {
    validateConfig();
    console.log("[config] Configuration validated.");
  } catch (err: any) {
    console.error(`[config] ${err.message}`);
    process.exit(1);
  }

  // 2. Initialize database
  try {
    await initDbAsync(config.DATABASE_PATH);
    console.log(`[db] Database initialized at: ${config.DATABASE_PATH}`);
  } catch (err: any) {
    console.error(`[db] Failed to initialize database: ${err.message}`);
    process.exit(1);
  }

  // 載入 Node.js 插件（兩種模式都需要，Express route 插件在 password 模式仍有用）
  await loadNodeJsPlugins(config.NODEJS_PLUGIN_PATHS);

  // 3. Telegram Bot（僅 telegram 模式啟動）
  let bot: MyBot | null = null;
  if (config.WEB_AUTH_MODE === "telegram") {
    bot = new Bot<MyContext>(config.BOT_TOKEN);

    // Install session middleware (required by conversations plugin)
    bot.use(session({ initial: () => ({}) }));

    // Install conversations plugin
    bot.use(conversations());

    // -----------------------------------------------------------------------
    // Global /cancel handler — MUST be after conversations() but before any
    // createConversation() registration, so it intercepts /cancel BEFORE
    // the conversation middleware can consume the update.
    // -----------------------------------------------------------------------
    bot.use(async (ctx, next) => {
      const text = ctx.msg?.text?.trim() ?? "";
      const firstWord = text.split(/\s/)[0] ?? "";
      if (firstWord === "/cancel" || firstWord.startsWith("/cancel@")) {
        const active = await ctx.conversation.active();
        const count = Object.values(active).reduce((s, n) => s + n, 0);
        if (count > 0) {
          await ctx.conversation.exit();
          await ctx.reply("✅ 已取消當前操作。");
        } else {
          await ctx.reply("ℹ️ 目前沒有進行中的操作。");
        }
        return;
      }
      await next();
    });

    // -----------------------------------------------------------------------
    // Command logging middleware
    // -----------------------------------------------------------------------
    bot.use(async (ctx, next) => {
      const entities = ctx.msg?.entities;
      if (entities?.some((e) => e.type === "bot_command")) {
        const text = ctx.msg?.text ?? "";
        const command = text.split(/\s/)[0] ?? "/?";
        const args = text.slice(command.length).trim();
        const user = ctx.from;
        console.log(
          `[CMD] user=${user?.id ?? "?"} (@${user?.username ?? ""}) ` +
          `${command}${args ? " args=" + args : ""}`
        );
      }
      await next();
    });

    // Register bot handlers
    registerUserHandlers(bot);
    registerAdminHandlers(bot);
    registerLimitHandlers(bot);
    registerUpdateHandlers(bot);
    registerWebHandlers(bot);
    registerBackupHandlers(bot);

    await initializeNodeJsPlugins(bot);
    await setBotCommands(bot, getPluginBotCommands());
  } else {
    console.log("[bot] Skipped — WEB_AUTH_MODE=password, Bot not started.");
  }

  // 4. Start Express API server
  try {
    await startServer(config.API_PORT);
    console.log(`[api] API proxy server listening on port ${config.API_PORT}`);
    await startNodeJsPlugins();
  } catch (err: any) {
    console.error(`[api] Failed to start API server: ${err.message}`);
    process.exit(1);
  }

  // 4.5 Start Cloudflare Tunnel (optional)
  try {
    await startTunnel(config.API_PORT);
  } catch (err: any) {
    console.error(`[tunnel] Failed to start tunnel: ${err.message}`);
  }

  // 5. Start Telegram Bot polling（僅 telegram 模式）
  if (bot) {
    try {
      await bot.start({
        onStart: (info) => {
          console.log(
            `[bot] Logged in as @${info.username} (id: ${info.id})`
          );
          console.log("--- All systems operational ---");
        },
      });
    } catch (err: any) {
      console.error(`[bot] Failed to start bot: ${err.message}`);
      process.exit(1);
    }
  } else {
    console.log("--- Web-only mode operational (Bot disabled) ---");
  }
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function setupGracefulShutdown(): void {
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[shutdown] Received ${signal}, exiting gracefully...`);
    void shutdownNodeJsPlugins().finally(() => {
      stopTunnel();
      closeDb();
      process.exit(0);
    });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// ---------------------------------------------------------------------------
// Unhandled error handlers
// ---------------------------------------------------------------------------

process.on("uncaughtException", (err) => {
  console.error("[fatal] Uncaught exception:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("[fatal] Unhandled rejection:", reason);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

setupGracefulShutdown();
main().catch((err) => {
  console.error("[fatal] Startup failed:", err);
  process.exit(1);
});

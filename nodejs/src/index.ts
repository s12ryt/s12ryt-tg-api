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
import { registerUserHandlers } from "./bot/handlers/userHandlers.js";
import { registerAdminHandlers } from "./bot/handlers/adminHandlers.js";
import { registerLimitHandlers } from "./bot/handlers/limitHandlers.js";

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
  if (!config.BOT_TOKEN) {
    throw new Error("BOT_TOKEN is required but empty. Check your .env file.");
  }
  if (!config.ADMIN_ID || isNaN(config.ADMIN_ID)) {
    throw new Error("ADMIN_ID must be a valid number. Check your .env file.");
  }
}

// ---------------------------------------------------------------------------
// Set bot commands
// ---------------------------------------------------------------------------

async function setBotCommands(bot: MyBot): Promise<void> {
  // 普通用戶指令
  const userCommands: BotCommand[] = [
    { command: "start", description: "開始使用 Bot" },
    { command: "url", description: "獲取 API 接口地址" },
    { command: "key", description: "API Key 管理（查看/新增/刪除）" },
    { command: "usage", description: "查詢 Token 用量" },
    { command: "coding", description: "Coding 模式管理（開關/設定）" },
    { command: "model_catch", description: "抓取 API 模型列表" },
    { command: "my_limits", description: "查看我的限制和用量" },
  ];

  // 管理員指令
  const adminCommands: BotCommand[] = [
    { command: "provider", description: "供應商管理（新增/刪除/編輯/列表）" },
    { command: "uu", description: "查詢用戶用量" },
    { command: "admin_user", description: "用戶管理（新增/停用/刪除/編輯/移除Key）" },
    { command: "sub_url", description: "修改 API 接口地址" },
    { command: "api_test", description: "測試 API 協議連通性" },
    { command: "limits", description: "權限管理（分組/限制/配額）" },
  ];

  try {
    // 設置所有私人聊天可見的指令（用戶 + 管理員全部）
    await bot.api.setMyCommands([...userCommands, ...adminCommands]);
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

  // 3. Create and configure Telegram Bot
  const bot: MyBot = new Bot<MyContext>(config.BOT_TOKEN);

  // Install session middleware (required by conversations plugin)
  bot.use(session({ initial: () => ({}) }));

  // Install conversations plugin
  bot.use(conversations());

  // -----------------------------------------------------------------------
  // Command logging middleware — runs before all handlers
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

  // 3.5 Set bot commands menu
  await setBotCommands(bot);

  // 4. Start Express API server
  try {
    await startServer(config.API_PORT);
    console.log(`[api] API proxy server listening on port ${config.API_PORT}`);
  } catch (err: any) {
    console.error(`[api] Failed to start API server: ${err.message}`);
    process.exit(1);
  }

  // 5. Start Telegram Bot
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
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function setupGracefulShutdown(): void {
  const shutdown = (signal: string) => {
    console.log(`\n[shutdown] Received ${signal}, exiting gracefully...`);
    closeDb();
    process.exit(0);
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

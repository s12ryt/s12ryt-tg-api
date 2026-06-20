/**
 * Backup & Restore handlers for the Telegram Bot.
 *
 * - `/backup`  → export the entire database as a JSON file and send it to the admin.
 * - Send a `.json` file back to the bot → parse, show summary, confirm → restore.
 *
 * Admin-only. Non-admin users are silently ignored.
 */

import type { Bot, Context } from "grammy";
import { InlineKeyboard, InputFile } from "grammy";
import type { ConversationFlavor } from "@grammyjs/conversations";
import { config } from "../../config.js";
import { isAdmin } from "../filters.js";
import {
  exportDatabase,
  importDatabase,
  getBackupSummary,
  type BackupData,
} from "../../db/database.js";

type MyContext = Context & ConversationFlavor;

// ---------------------------------------------------------------------------
// Pending restore state
// ---------------------------------------------------------------------------

interface PendingRestore {
  data: BackupData;
  expiresAt: number;
}

/** Per-user pending restore, keyed by Telegram user ID. */
const pendingRestores = new Map<number, PendingRestore>();
const RESTORE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB — Telegram Bot API getFile download limit

/** Garbage-collect expired pending restores. */
function cleanExpiredRestores(): void {
  const now = Date.now();
  for (const [id, entry] of pendingRestores) {
    if (entry.expiresAt < now) {
      pendingRestores.delete(id);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a timestamped backup filename.
 * Format: s12ryt-tg-api-{年-月-日-時-分}.json
 */
function getBackupFilename(): string {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const ts = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}-${p(now.getMinutes())}`;
  return `s12ryt-tg-api-${ts}.json`;
}

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

export function registerBackupHandlers(bot: Bot<MyContext>): void {
  // -----------------------------------------------------------------------
  // /backup command — export database as JSON file
  // -----------------------------------------------------------------------
  bot.command("backup", async (ctx) => {
    if (!isAdmin(ctx)) return;

    await ctx.reply("📤 正在匯出資料庫...");

    try {
      const data = exportDatabase();
      const jsonStr = JSON.stringify(data, null, 2);
      const filename = getBackupFilename();
      const input = new InputFile(Buffer.from(jsonStr, "utf-8"), filename);

      await ctx.api.sendDocument(ctx.chat.id, input, {
        caption: `📦 資料庫備份完成\n檔名：${filename}\n導出時間：${data.exportedAt}`,
      });
    } catch (err) {
      await ctx.reply(
        `❌ 匯出失敗：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  // -----------------------------------------------------------------------
  // Document receiver — parse JSON backup and show confirmation prompt
  // -----------------------------------------------------------------------
  bot.on("message:document", async (ctx) => {
    if (!isAdmin(ctx)) return;

    const doc = ctx.message.document;

    // Accept only JSON files (by MIME type or .json extension)
    const isJson =
      doc.mime_type === "application/json" ||
      (doc.file_name?.toLowerCase().endsWith(".json") ?? false);

    if (!isJson) return; // Ignore non-JSON documents silently

    // Reject oversized files
    if (doc.file_size && doc.file_size > MAX_FILE_SIZE) {
      await ctx.reply("❌ 檔案過大（超過 20MB），無法處理。");
      return;
    }

    await ctx.reply("📥 正在下載並解析檔案...");

    try {
      // Download file via Telegram Bot API
      const fileInfo = await ctx.api.getFile(doc.file_id);
      if (!fileInfo.file_path) {
        await ctx.reply("❌ 無法取得檔案路徑。");
        return;
      }

      const url = `https://api.telegram.org/file/bot${config.BOT_TOKEN}/${fileInfo.file_path}`;
      const response = await fetch(url);

      if (!response.ok) {
        await ctx.reply(`❌ 下載失敗：HTTP ${response.status}`);
        return;
      }

      const text = await response.text();

      // Parse JSON
      let data: BackupData;
      try {
        data = JSON.parse(text) as BackupData;
      } catch {
        await ctx.reply("❌ 無法解析 JSON，請確認檔案格式正確。");
        return;
      }

      // Validate backup structure
      if (
        !data ||
        typeof data !== "object" ||
        typeof data.tables !== "object" ||
        data.tables === null
      ) {
        await ctx.reply("❌ 備份格式無效：缺少 tables 物件。");
        return;
      }

      // Show summary and ask for confirmation
      const summary = getBackupSummary(data);
      cleanExpiredRestores();

      // Store pending restore (overwrite any previous pending restore for this user)
      pendingRestores.set(ctx.from.id, {
        data,
        expiresAt: Date.now() + RESTORE_TIMEOUT_MS,
      });

      // Format summary
      const lines: string[] = [
        "📋 備份內容摘要",
        "",
        `導出時間：${summary.exportedAt}`,
        `版本：v${summary.version}`,
        "",
        "資料筆數：",
      ];
      for (const [table, count] of Object.entries(summary.counts)) {
        lines.push(`  • ${table}: ${count} 筆`);
      }
      lines.push("");
      lines.push("⚠️ 確認還原將覆蓋目前所有資料，此操作不可逆！");

      const keyboard = new InlineKeyboard()
        .text("✅ 確認還原", "restore_confirm")
        .text("❌ 取消", "restore_cancel");

      await ctx.reply(lines.join("\n"), { reply_markup: keyboard });
    } catch (err) {
      await ctx.reply(
        `❌ 處理檔案時發生錯誤：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  // -----------------------------------------------------------------------
  // Restore confirm callback
  // -----------------------------------------------------------------------
  bot.callbackQuery("restore_confirm", async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCallbackQuery();
      return;
    }

    await ctx.answerCallbackQuery();

    cleanExpiredRestores();
    const pending = pendingRestores.get(ctx.from.id);

    if (!pending) {
      await ctx.editMessageText("❌ 找不到待還原的備份資料（可能已過期）。");
      return;
    }

    await ctx.editMessageText("⏳ 正在還原資料庫...");

    try {
      importDatabase(pending.data);
      const summary = getBackupSummary(pending.data);
      pendingRestores.delete(ctx.from.id);

      const lines: string[] = [
        "✅ 資料庫還原成功！",
        "",
        "已還原的資料：",
      ];
      for (const [table, count] of Object.entries(summary.counts)) {
        lines.push(`  • ${table}: ${count} 筆`);
      }

      await ctx.reply(lines.join("\n"));
    } catch (err) {
      await ctx.reply(
        `❌ 還原失敗：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  // -----------------------------------------------------------------------
  // Restore cancel callback
  // -----------------------------------------------------------------------
  bot.callbackQuery("restore_cancel", async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCallbackQuery();
      return;
    }

    await ctx.answerCallbackQuery();

    pendingRestores.delete(ctx.from.id);
    await ctx.editMessageText("🚫 已取消還原操作。");
  });
}

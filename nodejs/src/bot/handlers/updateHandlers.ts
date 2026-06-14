/**
 * /version  — 查看當前程式版本
 * /update   — 檢查更新 + 確認後執行更新（git pull → tarball 備援）+ 重啟
 * /restart  — 立即重啟進程
 *
 * 以上指令僅限管理員使用。
 */

import type { Bot, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import type { ConversationFlavor } from "@grammyjs/conversations";
import { isAdmin } from "../filters.js";
import {
  getCurrentVersion,
  fetchAndCheckUpdate,
  performUpdate,
  restartProcess,
  isWorkingDirClean,
} from "../../updater.js";

type MyContext = Context & ConversationFlavor;

// ========================
// 輔助函數
// ========================

/** 格式化日期顯示 */
function formatDate(isoDate: string): string {
  if (!isoDate) return "—";
  try {
    const d = new Date(isoDate);
    return d.toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
  } catch {
    return isoDate;
  }
}

// ========================
// /version — 查看當前版本
// ========================

async function versionCommand(ctx: MyContext): Promise<void> {
  try {
    const version = getCurrentVersion();
    await ctx.reply(
      `📦 *目前版本*\n\n` +
      (version.tag ? `🏷️ Release：\`${version.tag}\`\n` : "") +
      `🔖 Commit：\`${version.hash}\`\n` +
      `📝 訊息：${version.message}\n` +
      `🕐 時間：${formatDate(version.date)}`,
      { parse_mode: "Markdown" },
    );
  } catch (err: any) {
    await ctx.reply(`❌ 取得版本失敗：${err.message}`);
  }
}

// ========================
// /update — 檢查更新 + 確認執行
// ========================

async function updateCommand(ctx: MyContext): Promise<void> {
  try {
    await ctx.reply("⏳ 正在檢查更新...");

    const result = await fetchAndCheckUpdate();

    if (!result.hasUpdate) {
      await ctx.reply(
        `✅ 已是最新版本！\n\n` +
        (result.current.tag ? `🏷️ Release：\`${result.current.tag}\`\n` : "") +
        `🔖 Commit：\`${result.current.hash}\`\n` +
        `📝 ${result.current.message}\n` +
        `🕐 ${formatDate(result.current.date)}`,
        { parse_mode: "Markdown" },
      );
      return;
    }

    // 有更新可用
    let msg =
      `🔄 *有新版本可用！*\n\n` +
      `📍 *當前版本*\n` +
      (result.current.tag ? `🏷️ \`${result.current.tag}\`\n` : "") +
      `🔖 \`${result.current.hash}\`\n` +
      `📝 ${result.current.message}\n` +
      `🕐 ${formatDate(result.current.date)}\n\n`;

    // 顯示 GitHub Release 資訊
    if (result.latestRelease) {
      msg +=
        `🆕 *GitHub 最新 Release*\n` +
        `🏷️ \`${result.latestRelease.tag}\`` +
        (result.latestRelease.prerelease ? " *(預發布)*" : " *(穩定版)*") + `\n` +
        `📝 ${result.latestRelease.name}\n` +
        `🕐 ${formatDate(result.latestRelease.publishedAt)}\n`;

      if (result.current.tag && result.latestRelease.tag) {
        msg += `🔗 [查看 Release](${result.latestRelease.htmlUrl})\n`;
      }
      msg += "\n";
    }

    // 顯示落後 commit 數量
    if (result.commitsBehind > 0) {
      msg += `📊 落後 ${result.commitsBehind} 個提交\n`;
      const display = result.newCommits.slice(0, 10);
      if (display.length > 0) {
        msg += `\n📜 *新增提交：*\n${display.join("\n")}`;
        if (result.newCommits.length > 10) {
          msg += `\n... 還有 ${result.newCommits.length - 10} 條`;
        }
      }
    }

    // 檢查工作目錄
    const clean = isWorkingDirClean();
    if (!clean) {
      msg += "\n\n⚠️ *警告：工作目錄有未提交的更改！*\n更新將改用 tarball 下載方式。";
    }

    const keyboard = new InlineKeyboard()
      .text("✅ 確認更新", "update_confirm")
      .text("❌ 取消", "update_cancel");

    await ctx.reply(msg, {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });
  } catch (err: any) {
    await ctx.reply(`❌ 檢查更新失敗：${err.message}`);
  }
}

// ========================
// /restart — 立即重啟
// ========================

async function restartCommand(ctx: MyContext): Promise<void> {
  await ctx.reply(
    "🔄 *正在重啟進程...*\n\nBot 將在 2 秒後重新上線。",
    { parse_mode: "Markdown" },
  );

  console.log("[restart] 由管理員觸發重啟");
  restartProcess(2000);
}

// ========================
// Callback Query 處理
// ========================

async function handleUpdateConfirm(ctx: MyContext): Promise<void> {
  try {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      "⏳ 正在更新程式碼...\n\n嘗試 git pull，失敗則改用 tarball 下載。",
    );

    const result = await performUpdate();

    if (result.success) {
      const methodText = result.method === "tarball" ? "📦 tarball 下載" : "📥 git pull";
      await ctx.editMessageText(
        `✅ ${result.message}\n\n` +
        `🔧 更新方式：${methodText}\n\n` +
        `🔄 正在重啟進程...\nBot 將在 2 秒後重新上線。`,
      );

      console.log("[update] 更新成功，正在重啟...");
      restartProcess(2000);
    } else {
      await ctx.editMessageText(`❌ ${result.message}`);
    }
  } catch (err: any) {
    try {
      await ctx.answerCallbackQuery();
    } catch { /* ignore */ }
    await ctx.editMessageText(`❌ 更新失敗：${err.message}`);
  }
}

async function handleUpdateCancel(ctx: MyContext): Promise<void> {
  try {
    await ctx.answerCallbackQuery({ text: "已取消更新" });
    await ctx.editMessageText("🚫 已取消更新。");
  } catch { /* ignore */ }
}

// ========================
// 註冊 Handler
// ========================

export function registerUpdateHandlers(bot: Bot<MyContext>): void {
  // Admin-only wrapper
  const adminOnly = (
    handler: (ctx: MyContext) => Promise<void>,
  ) => async (ctx: MyContext) => {
    if (!isAdmin(ctx)) {
      await ctx.reply("⛔ 此指令僅限管理員使用。");
      return;
    }
    await handler(ctx);
  };

  bot.command("version", adminOnly(versionCommand));
  bot.command("update", adminOnly(updateCommand));
  bot.command("restart", adminOnly(restartCommand));

  // Callback queries
  bot.callbackQuery("update_confirm", adminOnly(handleUpdateConfirm));
  bot.callbackQuery("update_cancel", adminOnly(handleUpdateCancel));
}

/**
 * Web 控制台入口 Handler
 *
 * 提供 /web 指令顯示功能列表，讓用戶一鍵開啟 Web 控制台。
 * 其他 handler 可透過 buildWebPageUrl() 在選單中嵌入 Web 按鈕。
 *
 * 流程：
 *   1. 用戶執行 /web 或其他指令的選單中點擊 Web 按鈕
 *   2. 呼叫 generateLoginToken(tgUserId) 產生一次性 OTP token（5 分鐘有效）
 *   3. 回覆帶 InlineKeyboard URL 按鈕的訊息，URL 格式：{webBaseUrl}?token={token}#{page}
 *   4. 用戶點擊按鈕 → 瀏覽器開啟 Web → 前端用 token 換 session → hash 路由到對應頁面
 */

import { Bot, Context, InlineKeyboard } from "grammy";
import type { ConversationFlavor } from "@grammyjs/conversations";
import { config } from "../../config.js";
import { getSetting } from "../../db/database.js";
import { generateLoginToken } from "../../web/auth.js";
import { isTrustedUser } from "../filters.js";

type MyContext = Context & ConversationFlavor;
type MyBot = Bot<MyContext>;

/**
 * 推導 Web 控制台的基底 URL。
 *
 * 邏輯與 /url 指令一致：優先使用 DB 中的 api_url setting，
 * 回退到 config.DEFAULT_API_URL。
 *
 * 若設定了 LOGIN_WEB_PATH（自定義登入路徑），則使用該路徑作為前端入口；
 * 否則使用預設的 /web。
 */
async function getWebBaseUrl(): Promise<string> {
  const base = ((await getSetting("api_url")) ?? config.DEFAULT_API_URL).replace(/\/+$/, "");
  return config.LOGIN_WEB_PATH ? `${base}${config.LOGIN_WEB_PATH}` : `${base}/web`;
}

/**
 * 檢查 URL 是否可被 Telegram InlineKeyboard URL 按鈕接受。
 *
 * Telegram 拒絕 localhost 和純 IP 位址（如 127.0.0.1、192.168.x.x），
 * 只接受包含有效域名（如 example.com）的 http/https URL。
 */
export function isTelegramValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (host === "localhost") return false;
    // IPv4
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
    // IPv6 (如 [::1])
    if (host.startsWith("[")) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * 為指定 tgUserId 產生登入 URL（含一次性 token）。
 *
 * 匯出供其他 handler（如 /start）重用，避免重複邏輯。
 */
export async function buildWebLoginUrl(tgUserId: number): Promise<string> {
  const token = generateLoginToken(tgUserId);
  return `${await getWebBaseUrl()}?token=${token}`;
}

/**
 * 為指定 tgUserId 產生帶 hash 頁面的 Web URL。
 *
 * 用於在對話式指令的選單中嵌入 Web 按鈕，點擊後直接跳轉到對應頁面。
 *
 * @param tgUserId Telegram User ID
 * @param page     hash 頁面名稱（對應前端路由，如 "keys", "coding", "usage" 等）
 * @returns 完整 URL，格式：{baseUrl}?token={token}#{page}
 */
export async function buildWebPageUrl(tgUserId: number, page?: string): Promise<string> {
  const base = await buildWebLoginUrl(tgUserId);
  return page ? `${base}#${page}` : base;
}

/**
 * 快速構建一個帶 Web URL 按鈕的 InlineKeyboard。
 *
 * @param tgUserId Telegram User ID
 * @param page     可選，目標頁面 hash
 * @param label    按鈕文字，預設「🌐 Web 操作」
 * @returns InlineKeyboard 實例
 */
export async function webButton(tgUserId: number, page?: string, label = "🌐 Web 操作"): Promise<InlineKeyboard | undefined> {
  const url = await buildWebPageUrl(tgUserId, page);
  if (!isTelegramValidUrl(url)) return undefined;
  return new InlineKeyboard().url(label, url);
}

/**
 * /web 指令 — 顯示功能列表 + Web 登入按鈕。
 *
 * 僅限信任用戶使用（與 /key /usage 等指令一致）。
 */
async function webCommand(ctx: MyContext): Promise<void> {
  const tgUserId = ctx.from?.id;
  if (!tgUserId) return;

  try {
    const loginUrl = await buildWebLoginUrl(tgUserId);
    const canUseButton = isTelegramValidUrl(loginUrl);
    const isAdminUser = tgUserId === config.ADMIN_ID;

    let text = "🌐 *Web 控制台*\n\n";
    text += "📋 _功能列表：_\n";
    text += "• 📊 儀表板 — 總覽\n";
    text += "• 🔑 API Key 管理\n";
    text += "• 📈 用量統計\n";
    text += "• 💻 Coding 模式設定\n";
    text += "• ⚙️ 使用限制查看\n";
    text += "• 🔒 模型存取限制\n";

    if (isAdminUser) {
      text += "\n🔧 _管理員功能：_\n";
      text += "• 📦 Provider 管理（新增 / 刪除 / 編輯 / 定價）\n";
      text += "• 👥 用戶管理（新增 / 停用 / 刪除 / 限制）\n";
      text += "• 📂 用戶分組管理\n";
      text += "• 📊 全域用量統計\n";
      text += "• 🔧 系統設定\n";
    }

    text += "\n⚡ 連結有效期 5 分鐘，登入後 Session 有效 24 小時。\n";

    const opts: { parse_mode: "Markdown"; reply_markup?: InlineKeyboard } = {
      parse_mode: "Markdown",
    };

    if (canUseButton) {
      opts.reply_markup = new InlineKeyboard().url("🌐 開啟 Web 控制台", loginUrl);
    } else {
      // localhost / IP 位址無法作為 Telegram 按鈕 URL，改為純文字顯示
      text += `\n🔗 請複製以下連結到瀏覽器開啟：\n\`${loginUrl}\``;
    }

    await ctx.reply(text, opts);
  } catch (err) {
    console.error("[web] Failed to generate login URL:", err);
    await ctx.reply("❌ 產生 Web 登入連結失敗，請稍後再試。");
  }
}

/**
 * 註冊 Web 相關 Handler。
 */
export function registerWebHandlers(bot: MyBot): void {
  // /web — 任何信任用戶都可使用
  bot.command("web", async (ctx) => {
    if (!(await isTrustedUser(ctx))) return;
    await webCommand(ctx);
  });
}

import { Bot, Context } from "grammy";
import {
  type ConversationFlavor,
  type Conversation,
  conversations,
  createConversation,
} from "@grammyjs/conversations";
import { config } from "../../config.js";
import {
  getUserByTgId,
  addUser,
  addApiKey,
  getKeysByUser,
  deleteApiKey,
  getUsageByUser,
  getSetting,
  getCodingConfigByTgId,
  setCodingConfig,
  resetCodingSessionStats,
  getAllCachedModelNames,
} from "../../db/database.js";
import { isTrustedUser } from "../filters.js";
import { fetchModelsNoAuth, fetchProviderModels } from "./modelFetcher.js";
import { safeReplyModels } from "./adminHandlers.js";
import { buildWebLoginUrl, webButton } from "./webHandlers.js";

// ========================
// 型別定義
// ========================

type MyContext = Context & ConversationFlavor;
type MyConversation = Conversation<MyContext>;

// ========================
// 選單文字常數
// ========================

const KEY_MENU_TEXT =
  "🔑 API Key 管理\n\n" +
  "1. 查看 Key\n" +
  "2. 新增 Key\n" +
  "3. 刪除 Key\n\n" +
  "請輸入數字選擇操作，或 /cancel 取消：\n\n" +
  "💡 也可使用 /web 在網頁操作";

const CODING_MENU_TEXT =
  "💻 Coding 模式管理\n\n" +
  "1. 開關 Coding 模式\n" +
  "2. 設定 Coding 模式（Fallback 模型鏈）\n\n" +
  "請輸入數字選擇操作，或 /cancel 取消：\n\n" +
  "💡 也可使用 /web 在網頁操作";

// ========================
// /start
// ========================

async function handleStart(ctx: MyContext): Promise<void> {
  const tgUserId = ctx.from?.id;
  if (!tgUserId) {
    await ctx.reply("你好!");
    return;
  }

  try {
    const loginUrl = buildWebLoginUrl(tgUserId);
    const wb = webButton(tgUserId, undefined, "🌐 開啟 Web 控制台");

    const intro =
      "你好！我是你的 AI API 管理助手。\n\n" +
      "📦 我能幫你：\n" +
      "• 管理 API Key（/key）\n" +
      "• 查看 Token 用量（/usage）\n" +
      "• 設定 Coding 模式（/coding）\n" +
      "• 查看使用限制（/my_limits）\n\n" +
      "🌐 也可以使用 Web 控制台（功能更完整）：";

    if (wb) {
      await ctx.reply(intro, { reply_markup: wb });
    } else {
      // localhost / IP 位址無法作為 Telegram 按鈕 URL
      await ctx.reply(intro + `\n\n🔗 請複製以下連結到瀏覽器開啟（5 分鐘有效）：\n\`${loginUrl}\``, {
        parse_mode: "Markdown",
      });
    }
  } catch (err) {
    console.error("[start] Failed to generate Web login URL:", err);
    await ctx.reply("你好！我是你的 AI API 管理助手。");
  }
}

// ========================
// /url
// ========================

async function handleUrl(ctx: MyContext): Promise<void> {
  const url = getSetting("api_url") ?? config.DEFAULT_API_URL;
  await ctx.reply(`API URL: ${url}`);
}

// ========================
// /key — 統一 API Key 管理對話
// ========================

async function keyConversation(
  conversation: MyConversation,
  ctx: MyContext
): Promise<void> {
  const tgId = ctx.from!.id;
  await conversation.external(() => { ensureUserExists(tgId, ctx.from!.username); });

  while (true) {
    await ctx.reply(KEY_MENU_TEXT, { reply_markup: webButton(tgId, "keys") });
    ctx = await conversation.wait();
    const choice = ctx.msg?.text?.trim() ?? "";

    if (choice === "/cancel") return;

    if (choice === "1") {
      // ── 查看 Key ──
      const keys = getKeysByUser(tgId);
      const activeKeys = keys.filter((k) => Number(k.is_active) === 1);

      if (activeKeys.length === 0) {
        const { key } = await conversation.external(() => addApiKey(tgId));
        await ctx.reply(
          `✅ 已自動建立 key：\`${key}\``,
          { parse_mode: "Markdown" }
        );
      } else {
        const lines = activeKeys
          .map((k, i) => `${i + 1}. \`${k.key}\``)
          .join("\n");
        await ctx.reply(
          `您的 key：\n${lines}`,
          { parse_mode: "Markdown" }
        );
      }
      continue;
    }

    if (choice === "2") {
      // ── 新增 Key ──
      const { key } = await conversation.external(() => addApiKey(tgId));
      await ctx.reply(
        `✅ 新增 key：\`${key}\``,
        { parse_mode: "Markdown" }
      );
      continue;
    }

    if (choice === "3") {
      // ── 刪除 Key ──
      const activeKeys = getKeysByUser(tgId).filter(
        (k) => Number(k.is_active) === 1
      );

      if (activeKeys.length === 0) {
        await ctx.reply("您目前沒有可刪除的 key。");
        continue;
      }

      const listText = activeKeys
        .map((k, i) => `${i + 1}. \`${k.key}\``)
        .join("\n");
      await ctx.reply(
        `請選擇要刪除的 key（回覆編號，多個用逗號分隔，例如 1,3）：\n\n${listText}\n\n或輸入 0 返回選單：`,
        { parse_mode: "Markdown" }
      );

      ctx = await conversation.wait();
      const delText = ctx.msg?.text?.trim() ?? "";

      if (delText === "0" || delText === "/cancel") {
        continue;
      }

      const indices = delText
        .split(/[,，\s]+/)
        .map((s: string) => parseInt(s, 10))
        .filter(
          (n: number) => !isNaN(n) && n >= 1 && n <= activeKeys.length
        );

      if (indices.length === 0) {
        await ctx.reply("❌ 無效的選擇。");
        continue;
      }

      const uniqueIndices = [...new Set(indices)];
      let deleted = 0;
      for (const idx of uniqueIndices) {
        const key = activeKeys[Number(idx) - 1];
        await conversation.external(() => { deleteApiKey(key.id); });
        deleted++;
      }

      await ctx.reply(
        `✅ 已成功刪除 ${deleted} 個 key。`
      );
      continue;
    }

    // 無效選項
    await ctx.reply("❌ 請輸入 1-3 選擇操作。");
  }
}

// ========================
// /usage
// ========================

async function handleUsage(ctx: MyContext): Promise<void> {
  const tgId = ctx.from!.id;
  const usageRecords = getUsageByUser(tgId);

  if (usageRecords.length === 0) {
    await ctx.reply("目前沒有使用紀錄。", { reply_markup: webButton(tgId, "usage") });
    return;
  }

  // 按 api_key_id 分組
  const grouped = new Map<
    number,
    {
      apiKey: string;
      inputTokens: number;
      outputTokens: number;
      inputCost: number;
      outputCost: number;
    }
  >();

  for (const r of usageRecords) {
    const existing = grouped.get(r.api_key_id);
    if (existing) {
      existing.inputTokens += r.input_tokens;
      existing.outputTokens += r.output_tokens;
      existing.inputCost += r.input_cost;
      existing.outputCost += r.output_cost;
    } else {
      grouped.set(r.api_key_id, {
        apiKey: maskKey(r.api_key),
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        inputCost: r.input_cost,
        outputCost: r.output_cost,
      });
    }
  }

  const lines: string[] = [];
  for (const [, data] of grouped) {
    const totalCost = (data.inputCost + data.outputCost).toFixed(4);
    lines.push(
      `🔑 ${data.apiKey}\n` +
        `  輸入 tokens: ${data.inputTokens.toLocaleString()}\n` +
        `  輸出 tokens: ${data.outputTokens.toLocaleString()}\n` +
        `  費用: $${totalCost}`
    );
  }

  await ctx.reply(lines.join("\n\n"), {
    reply_markup: webButton(tgId, "usage"),
  });
}

// ========================
// /coding — 統一 Coding 模式管理對話
// ========================

async function codingConversation(
  conversation: MyConversation,
  ctx: MyContext
): Promise<void> {
  const tgId = ctx.from!.id;
  const user = getUserByTgId(tgId);
  if (!user) {
    await ctx.reply("❌ 您尚未註冊，請先使用 /key 創建 API key。");
    return;
  }

  while (true) {
    await ctx.reply(CODING_MENU_TEXT, { reply_markup: webButton(tgId, "coding") });
    ctx = await conversation.wait();
    const choice = ctx.msg?.text?.trim() ?? "";

    if (choice === "/cancel") return;

    if (choice === "1") {
      // ── 開關 Coding 模式 ──
      const codingConfig = getCodingConfigByTgId(tgId);

      if (codingConfig && codingConfig.is_active === 1) {
        // 關閉 + 顯示 session 統計
        const sIn = codingConfig.session_input_tokens || 0;
        const sOut = codingConfig.session_output_tokens || 0;
        const sInCost = codingConfig.session_input_cost || 0;
        const sOutCost = codingConfig.session_output_cost || 0;
        const sReqs = codingConfig.session_requests || 0;

        await conversation.external(() => { setCodingConfig(user.id, { isActive: 0 }); });

        if (sReqs > 0) {
          const totalCost = sInCost + sOutCost;
          let modelBreakdown = "";
          const modelCounts: Record<string, number> = codingConfig.session_model_counts
            ? JSON.parse(codingConfig.session_model_counts)
            : {};
          const modelEntries = Object.entries(modelCounts);
          if (modelEntries.length > 0) {
            modelBreakdown =
              "\n\n📋 模型調用統計：\n" +
              modelEntries
                .map(([m, c]) => `   ${m}: ${c} 次`)
                .join("\n");
          }
          await ctx.reply(
            `🔴 Coding 模式已關閉。\n\n` +
              `📊 本次 Coding Session 統計：\n` +
              `   調用次數：${sReqs}\n` +
              `   輸入 Token：${sIn.toLocaleString()}\n` +
              `   輸出 Token：${sOut.toLocaleString()}\n` +
              `   輸入費用：$${sInCost.toFixed(6)}\n` +
              `   輸出費用：$${sOutCost.toFixed(6)}\n` +
              `   總費用：$${totalCost.toFixed(6)}` +
              modelBreakdown
          );
        } else {
          await ctx.reply(
            "🔴 Coding 模式已關閉。\n\n📊 本次 Session 無請求記錄。"
          );
        }
      } else {
        // 開啟
        if (codingConfig && codingConfig.fallback_models) {
          await conversation.external(() => {
            setCodingConfig(user.id, { isActive: 1 });
            resetCodingSessionStats(user.id);
          });
          const list = codingConfig.fallback_list
            .map((m: string, i: number) => `   ${i + 1}. ${m}`)
            .join("\n");
          await ctx.reply(
            `🟢 Coding 模式已開啟！\n\n📋 當前 Fallback 模型鏈：\n${list}\n\n最大重試次數：${codingConfig.max_retries}`
          );
        } else {
          await conversation.external(() => { setCodingConfig(user.id, { isActive: 1 }); });
          await ctx.reply(
            "🟢 Coding 模式已開啟，但尚未設定 Fallback 模型。\n請選擇 2 設定 Fallback 模型鏈。"
          );
        }
      }
      continue;
    }

    if (choice === "2") {
      // ── 設定 Coding 模式 ──
      const codingConfig = getCodingConfigByTgId(tgId);
      const availableModels = getAllCachedModelNames();

      // 顯示當前設定或可用模型
      if (codingConfig && codingConfig.fallback_models) {
        await ctx.reply(
          `📋 當前 Coding 模式設定：\n` +
            `   Fallback 模型：${codingConfig.fallback_models}\n` +
            `   最大重試次數：${codingConfig.max_retries}\n` +
            `   狀態：${codingConfig.is_active ? "🟢 開啟" : "🔴 關閉"}\n\n` +
            "請輸入新的 Fallback 模型鏈（用逗號分隔，按順序排列）：\n" +
            "例如：claude-4-sonnet,gpt-4o,deepseek-v3\n\n" +
            "或輸入 skip 保持不變："
        );
      } else {
        const modelList = availableModels
          .slice(0, 30)
          .map((m) => `   ${m}`)
          .join("\n");
        const suffix =
          availableModels.length > 30
            ? `\n   ...還有 ${availableModels.length - 30} 個`
            : "";
        await ctx.reply(
          "🔧 設定 Coding 模式 — Fallback 模型鏈\n\n" +
            "當主模型報錯時，會按順序嘗試以下模型：\n\n" +
            `📦 可用模型：\n${modelList}${suffix}\n\n` +
            "請輸入 Fallback 模型鏈（用逗號分隔，按優先順序排列）：\n" +
            "例如：claude-4-sonnet,gpt-4o,deepseek-v3"
        );
      }

      // 等待 Fallback 模型輸入
      let fallbackCtx = await conversation.wait();
      const fallbackText =
        fallbackCtx.msg?.text?.trim().toLowerCase() ?? "";

      let fallbackModels: string | undefined;

      if (fallbackText !== "skip") {
        const allModels = new Set(getAllCachedModelNames());
        const models = fallbackText
          .split(",")
          .map((m: string) => m.trim())
          .filter(Boolean);
        const invalid = models.filter((m: string) => !allModels.has(m));

        if (invalid.length > 0) {
          await fallbackCtx.reply(
            `❌ 以下模型不存在：${invalid.join(", ")}\n\n請重新選擇操作。`
          );
          continue;
        }
        fallbackModels = models.join(",");
      }

      // 詢問最大重試次數
      await (fallbackCtx ?? ctx).reply(
        "請輸入最大重試次數（1-10），或輸入 skip 保持預設（3）："
      );

      const retriesCtx = await conversation.wait();
      const retriesText =
        retriesCtx.msg?.text?.trim().toLowerCase() ?? "";

      let maxRetries = 3;
      if (retriesText !== "skip") {
        const parsed = parseInt(retriesText, 10);
        if (isNaN(parsed) || parsed < 1 || parsed > 10) {
          await retriesCtx.reply(
            "❌ 請輸入 1-10 之間的數字。已取消設定。"
          );
          continue;
        }
        maxRetries = parsed;
      }

      // 取得當前設定以保留 fallback_models（如果 skip）
      const currentConfig = getCodingConfigByTgId(tgId);
      const finalFallback =
        fallbackModels ?? (currentConfig?.fallback_models ?? "");

      await conversation.external(() => {
        setCodingConfig(user.id, {
          isActive: 1,
          fallbackModels: finalFallback,
          maxRetries,
        });
      });

      const finalList = finalFallback
        .split(",")
        .map((m: string) => m.trim())
        .filter(Boolean);
      const listText = finalList
        .map((m: string, i: number) => `   ${i + 1}. ${m}`)
        .join("\n");

      await retriesCtx.reply(
        "✅ Coding 模式設定完成！\n\n" +
          `📋 Fallback 模型鏈：\n${listText}\n\n` +
          `最大重試次數：${maxRetries}\n` +
          "狀態：🟢 已開啟"
      );
      continue;
    }

    // 無效選項
    await ctx.reply("❌ 請輸入 1 或 2 選擇操作。");
  }
}

// ========================
// 輔助函式
// ========================

/**
 * 確保使用者存在於 DB，不存在則自動建立
 */
function ensureUserExists(tgUserId: number, username?: string): void {
  const existing = getUserByTgId(tgUserId);
  if (!existing) {
    addUser(tgUserId, username ?? null);
  }
}

/**
 * 遮蔽 key 中間部分，只顯示前後幾位
 */
function maskKey(key: string): string {
  if (key.length <= 16) return key;
  return key.slice(0, 12) + "..." + key.slice(-4);
}

// ========================
// /model_catch conversation
// ========================

async function modelCatchConversation(conversation: MyConversation, ctx: MyContext): Promise<void> {
  await ctx.reply(
    "🔍 請輸入要抓取模型的 API URL：\n\n" +
    "例如：https://api.example.com/v1"
  );

  const urlCtx = await conversation.wait();
  if (!urlCtx.message?.text) return;
  const url = urlCtx.message.text.trim();

  await urlCtx.reply("⏳ 正在嘗試抓取模型列表（不帶 Key）...");

  const { models, needsAuth } = await conversation.external(() => fetchModelsNoAuth(url));

  if (needsAuth) {
    await urlCtx.reply(
      "🔒 伺服器要求認證（401/403）。\n" +
      "請輸入 API Key，或輸入 /cancel 取消："
    );

    const keyCtx = await conversation.wait();
    if (!keyCtx.message?.text) return;
    const apiKey = keyCtx.message.text.trim();

    await keyCtx.reply("⏳ 正在使用 Key 重新抓取模型列表...");

    // Try openai_chat format first (most common)
    let fetchedModels = await conversation.external(() => fetchProviderModels(url, apiKey, "openai_chat"));
    if (!fetchedModels.length) {
      fetchedModels = await conversation.external(() => fetchProviderModels(url, apiKey, "google"));
    }

    if (!fetchedModels.length) {
      await keyCtx.reply(
        "❌ 即使使用 Key 也無法獲取模型列表。\n" +
        "請確認 URL 和 Key 是否正確。"
      );
      return;
    }

    const header = `✅ 找到 ${fetchedModels.length} 個模型：`;
    await safeReplyModels(keyCtx, fetchedModels, header, "");
    return;
  }

  if (!models.length) {
    await urlCtx.reply(
      "❌ 無法從該 URL 獲取模型列表。\n" +
      "可能原因：URL 不正確、伺服器無回應、或回應格式不支援。\n\n" +
      "請確認 URL 格式後重新嘗試。"
    );
    return;
  }

  const header = `✅ 找到 ${models.length} 個模型：`;
  await safeReplyModels(urlCtx, models, header, "");
}

/**
 * 註冊所有使用者指令與對話
 */
export function registerUserHandlers(bot: Bot<MyContext>): void {
  // Register conversations
  bot.use(createConversation(keyConversation, "key"));
  bot.use(createConversation(codingConversation, "coding"));
  bot.use(createConversation(modelCatchConversation, "modelCatch"));

  // /start
  bot.command("start", async (ctx) => {
    if (!isTrustedUser(ctx)) return;
    await handleStart(ctx);
  });

  // /url
  bot.command("url", async (ctx) => {
    if (!isTrustedUser(ctx)) return;
    await handleUrl(ctx);
  });

  // /key — unified key management
  bot.command("key", async (ctx) => {
    if (!isTrustedUser(ctx)) return;
    await ctx.conversation.enter("key");
  });

  // /usage
  bot.command("usage", async (ctx) => {
    if (!isTrustedUser(ctx)) return;
    await handleUsage(ctx);
  });

  // /coding — unified coding management
  bot.command("coding", async (ctx) => {
    if (!isTrustedUser(ctx)) return;
    await ctx.conversation.enter("coding");
  });

  // /model_catch → 進入對話
  bot.command("model_catch", async (ctx) => {
    if (!isTrustedUser(ctx)) return;
    await ctx.conversation.enter("modelCatch");
  });
}

import { Bot, Context, InlineKeyboard } from "grammy";
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

// ========================
// 型別定義
// ========================

type MyContext = Context & ConversationFlavor;
type MyConversation = Conversation<MyContext>;

// ========================
// /start
// ========================

async function handleStart(ctx: MyContext): Promise<void> {
  await ctx.reply("你好!");
}

// ========================
// /url
// ========================

async function handleUrl(ctx: MyContext): Promise<void> {
  const url = getSetting("api_url") ?? config.DEFAULT_API_URL;
  await ctx.reply(`API URL: ${url}`);
}

// ========================
// /key
// ========================

async function handleKey(ctx: MyContext): Promise<void> {
  const tgId = ctx.from!.id;
  ensureUserExists(tgId, ctx.from!.username);

  const keys = getKeysByUser(tgId);

  const activeKeys = keys.filter((k) => Number(k.is_active) === 1);

  if (activeKeys.length === 0) {
    const { key } = addApiKey(tgId);
    await ctx.reply(`您的 key: ${key}`);
    return;
  }

  const lines = activeKeys.map((k, i) => `${i + 1}. \`${k.key}\``).join("\n");
  await ctx.reply(`您擁有的 key:\n${lines}`, { parse_mode: "Markdown" });
}

// ========================
// /usage
// ========================

async function handleUsage(ctx: MyContext): Promise<void> {
  const tgId = ctx.from!.id;
  const usageRecords = getUsageByUser(tgId);

  if (usageRecords.length === 0) {
    await ctx.reply("目前沒有使用紀錄。");
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

  await ctx.reply(lines.join("\n\n"));
}

// ========================
// /key-add
// ========================

async function handleKeyAdd(ctx: MyContext): Promise<void> {
  const tgId = ctx.from!.id;
  ensureUserExists(tgId, ctx.from!.username);

  const { key } = addApiKey(tgId);
  await ctx.reply(`您的 key: ${key}`);
}

// ========================
// /key-del 對話
// ========================

async function keyDelConversation(
  conversation: MyConversation,
  ctx: MyContext
): Promise<void> {
  const tgId = ctx.from!.id;
  const activeKeys = getKeysByUser(tgId).filter((k) => Number(k.is_active) === 1);

  if (activeKeys.length === 0) {
    await ctx.reply("您目前沒有可刪除的 key。");
    return;
  }

  // 列出所有 key 並附上編號
  const listText = activeKeys
    .map((k, i) => `${i + 1}. \`${k.key}\``)
    .join("\n");
  await ctx.reply(`請選擇要刪除的 key（回覆編號，多個用逗號分隔，例如 1,3）:\n\n${listText}`, {
    parse_mode: "Markdown",
  });

  // 等待使用者回覆
  const response = await conversation.wait();
  const text = response.msg?.text?.trim();

  if (!text) {
    await response.reply("已取消刪除操作。");
    return;
  }

  // 解析 "1,2,3" 格式
  const indices = text
    .split(/[,，\s]+/)
    .map((s: string) => parseInt(s, 10))
    .filter((n: number) => !isNaN(n) && n >= 1 && n <= activeKeys.length);

  if (indices.length === 0) {
    await response.reply("無效的選擇，已取消刪除操作。");
    return;
  }

  // 去重
  const uniqueIndices = [...new Set(indices)];

  let deleted = 0;
  for (const idx of uniqueIndices) {
    const key = activeKeys[Number(idx) - 1];
    deleteApiKey(key.id);
    deleted++;
  }

  await response.reply(`已成功刪除 ${deleted} 個 key。`);
}

// ========================
// /start-coding - Toggle coding mode
// ========================

async function handleStartCoding(ctx: MyContext): Promise<void> {
  const tgId = ctx.from!.id;
  const user = getUserByTgId(tgId);
  if (!user) {
    await ctx.reply("❌ 您尚未註冊，請先使用 /key 創建 API key。");
    return;
  }

  const config = getCodingConfigByTgId(tgId);
  if (config && config.is_active === 1) {
    // Capture stats before deactivating
    const sIn = config.session_input_tokens || 0;
    const sOut = config.session_output_tokens || 0;
    const sInCost = config.session_input_cost || 0;
    const sOutCost = config.session_output_cost || 0;
    const sReqs = config.session_requests || 0;

    setCodingConfig(user.id, { isActive: 0 });

    if (sReqs > 0) {
      const totalCost = sInCost + sOutCost;
      // Build per-model breakdown
      let modelBreakdown = "";
      const modelCounts: Record<string, number> = config.session_model_counts
        ? JSON.parse(config.session_model_counts)
        : {};
      const modelEntries = Object.entries(modelCounts);
      if (modelEntries.length > 0) {
        modelBreakdown = "\n\n📋 模型調用統計：\n" +
          modelEntries.map(([m, c]) => `   ${m}: ${c} 次`).join("\n");
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
      await ctx.reply("🔴 Coding 模式已關閉。\n\n📊 本次 Session 無請求記錄。");
    }
  } else {
    if (config && config.fallback_models) {
      setCodingConfig(user.id, { isActive: 1 });
      resetCodingSessionStats(user.id);
      const list = config.fallback_list.map((m, i) => `   ${i + 1}. ${m}`).join("\n");
      await ctx.reply(
        `🟢 Coding 模式已開啟！\n\n📋 當前 Fallback 模型鏈：\n${list}\n\n最大重試次數：${config.max_retries}`
      );
    } else {
      setCodingConfig(user.id, { isActive: 1 });
      await ctx.reply(
        "🟢 Coding 模式已開啟，但尚未設定 Fallback 模型。\n請使用 /set_coding 設定 Fallback 模型鏈。"
      );
    }
  }
}

// ========================
// /set-coding 多輪對話
// ========================

async function setCodingConversation(
  conversation: MyConversation,
  ctx: MyContext
): Promise<void> {
  const tgId = ctx.from!.id;
  const user = getUserByTgId(tgId);
  if (!user) {
    await ctx.reply("❌ 您尚未註冊，請先使用 /key 創建 API key。");
    return;
  }

  // Show current config + available models
  const config = getCodingConfigByTgId(tgId);
  const availableModels = getAllCachedModelNames();

  if (config && config.fallback_models) {
    await ctx.reply(
      `📋 當前 Coding 模式設定：\n` +
      `   Fallback 模型：${config.fallback_models}\n` +
      `   最大重試次數：${config.max_retries}\n` +
      `   狀態：${config.is_active ? "🟢 開啟" : "🔴 關閉"}\n\n` +
      "請輸入新的 Fallback 模型鏈（用逗號分隔，按順序排列）：\n" +
      "例如：claude-4-sonnet,gpt-4o,deepseek-v3\n\n" +
      "或輸入 skip 保持不變："
    );
  } else {
    const modelList = availableModels.slice(0, 30).map((m) => `   ${m}`).join("\n");
    const suffix = availableModels.length > 30 ? `\n   ...還有 ${availableModels.length - 30} 個` : "";
    await ctx.reply(
      "🔧 設定 Coding 模式 — Fallback 模型鏈\n\n" +
      "當主模型報錯時，會按順序嘗試以下模型：\n\n" +
      `📦 可用模型：\n${modelList}${suffix}\n\n` +
      "請輸入 Fallback 模型鏈（用逗號分隔，按優先順序排列）：\n" +
      "例如：claude-4-sonnet,gpt-4o,deepseek-v3"
    );
  }

  // Wait for fallback models input
  const fallbackResp = await conversation.wait();
  const fallbackText = fallbackResp.msg?.text?.trim().toLowerCase() ?? "";

  let fallbackModels: string | undefined;

  if (fallbackText !== "skip") {
    // Validate models exist
    const allModels = new Set(getAllCachedModelNames());
    const models = fallbackText.split(",").map((m: string) => m.trim()).filter(Boolean);
    const invalid = models.filter((m: string) => !allModels.has(m));

    if (invalid.length > 0) {
      await fallbackResp.reply(
        `❌ 以下模型不存在：${invalid.join(", ")}\n\n請重新使用 /set-coding 設定。`
      );
      return;
    }
    fallbackModels = models.join(",");
  }

  // Ask for max retries
  await (fallbackResp ?? ctx).reply("請輸入最大重試次數（1-10），或輸入 skip 保持預設（3）：");

  const retriesResp = await conversation.wait();
  const retriesText = retriesResp.msg?.text?.trim().toLowerCase() ?? "";

  let maxRetries = 3;
  if (retriesText !== "skip") {
    const parsed = parseInt(retriesText, 10);
    if (isNaN(parsed) || parsed < 1 || parsed > 10) {
      await retriesResp.reply("❌ 請輸入 1-10 之間的數字。已取消設定。");
      return;
    }
    maxRetries = parsed;
  }

  // Get current config to preserve fallback_models if skipped
  const currentConfig = getCodingConfigByTgId(tgId);
  const finalFallback = fallbackModels ?? (currentConfig?.fallback_models ?? "");

  setCodingConfig(user.id, {
    isActive: 1,
    fallbackModels: finalFallback,
    maxRetries,
  });

  const finalList = finalFallback.split(",").map((m: string) => m.trim()).filter(Boolean);
  const listText = finalList.map((m: string, i: number) => `   ${i + 1}. ${m}`).join("\n");

  await retriesResp.reply(
    "✅ Coding 模式設定完成！\n\n" +
    `📋 Fallback 模型鏈：\n${listText}\n\n` +
    `最大重試次數：${maxRetries}\n` +
    "狀態：🟢 已開啟\n\n" +
    "使用 /start-coding 可以開關 Coding 模式。"
  );
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

/**
 * 註冊所有使用者指令與對話
 */
export function registerUserHandlers(bot: Bot<MyContext>): void {
  // Note: conversations() plugin is installed in index.ts (only once)
  bot.use(createConversation(keyDelConversation, "keyDel"));
  bot.use(createConversation(setCodingConversation, "setCoding"));

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

  // /key
  bot.command("key", async (ctx) => {
    if (!isTrustedUser(ctx)) return;
    await handleKey(ctx);
  });

  // /usage
  bot.command("usage", async (ctx) => {
    if (!isTrustedUser(ctx)) return;
    await handleUsage(ctx);
  });

  // /key-add
  bot.command("key_add", async (ctx) => {
    if (!isTrustedUser(ctx)) return;
    await handleKeyAdd(ctx);
  });

  // /key-del → 進入對話
  bot.command("key_del", async (ctx) => {
    if (!isTrustedUser(ctx)) return;
    await ctx.conversation.enter("keyDel");
  });

  // /start-coding - toggle coding mode
  bot.command("start_coding", async (ctx) => {
    if (!isTrustedUser(ctx)) return;
    await handleStartCoding(ctx);
  });

  // /set-coding → 進入對話
  bot.command("set_coding", async (ctx) => {
    if (!isTrustedUser(ctx)) return;
    await ctx.conversation.enter("setCoding");
  });
}

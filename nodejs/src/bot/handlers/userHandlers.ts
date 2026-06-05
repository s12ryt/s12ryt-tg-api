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
  console.log(`[debug /key] tgId=${tgId}, keys.length=${keys.length}`);
  for (const k of keys) {
    console.log(`[debug /key] key=${k.key}, is_active=${k.is_active} (${typeof k.is_active})`);
  }

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
  // Register key-del conversation
  bot.use(createConversation(keyDelConversation, "keyDel"));

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
}

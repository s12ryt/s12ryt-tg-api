import { Bot, Context } from "grammy";
import { Conversation, ConversationFlavor, createConversation } from "@grammyjs/conversations";
import { config } from "../../config.js";
import { getRawConfiguredApiUrl, getEffectiveApiUrlWithSource } from "../../apiUrl.js";
import { webButton } from "./webHandlers.js";
import {
  addProvider,
  getProviders,
  updateProvider,
  deleteProvider,
  getUsers,
  addUser,
  updateUserStatus,
  deleteUser,
  updateUserTgId,
  getAllKeys,
  deleteApiKey,
  getUsageByProvider,
  getUsageByUser,
  setSetting,
  deleteSetting,
  batchUpsertModelPrices,
  getModelPricesByProvider,
  getKeysByUser,
  getUserByTgId,
  getModelRestrictionsForUser,
  getModelRestriction,
  setModelRestriction,
  deleteModelRestriction,
  getAllCachedModelNames,
  type Provider,
  type User,
} from "../../db/database.js";
import { fetchProviderModels, fetchModelsPricing, detectApiProtocols, detectProtocolsNoAuth, type DetectionResult, type ProbeDetail, type FetchedModel } from "./modelFetcher.js";
import { parseApiKeys, getFirstKey } from "../../api/keySelector.js";

// ========================
// Types
// ========================

type MyContext = Context & ConversationFlavor;
type MyConversation = Conversation<MyContext>;

// ========================
// Admin guard
// ========================

function isAdmin(ctx: Context): boolean {
  return ctx.from?.id === config.ADMIN_ID;
}

// ========================
// Helper: parse multi-select "1,2,3" → number[]
// ========================

function parseIndices(input: string): number[] {
  return input
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => parseInt(s, 10))
    .filter((n) => !isNaN(n));
}

// ========================
// Helpers: Safe model list reply + search
// ========================

const MAX_MSG_LEN = 3800;

/** Split model list into multiple messages to stay under Telegram's 4096 char limit */
export async function safeReplyModels(
  ctx: Context,
  models: FetchedModel[],
  header: string,
  footer: string,
): Promise<void> {
  if (models.length === 0) {
    await ctx.reply(header + "\n（無模型）\n" + footer);
    return;
  }

  const modelLines = models.map((m, i) => `${i + 1}. ${m.name || m.id}`);
  // First batch: header + as many models as fit
  let firstMsg = header + "\n";
  const batches: string[] = [];
  let currentBatch = firstMsg;
  let shown = 0;

  for (const line of modelLines) {
    if (currentBatch.length + line.length + 2 > MAX_MSG_LEN && currentBatch !== firstMsg) {
      batches.push(currentBatch);
      currentBatch = "";
    }
    currentBatch += line + "\n";
    shown++;
  }

  // Append footer to last batch
  if (currentBatch.length + footer.length + 2 > MAX_MSG_LEN) {
    batches.push(currentBatch);
    currentBatch = "";
  }
  currentBatch += footer;
  batches.push(currentBatch);

  // Send first batch (with header)
  await ctx.reply(batches[0]);
  // Send remaining batches
  for (let i = 1; i < batches.length; i++) {
    await ctx.reply(batches[i]);
  }
}

/** Build the selection prompt header + footer */
function buildModelSelectionPrompt(
  total: number,
  isSearch: boolean,
  searchKeyword?: string,
): { header: string; footer: string } {
  const header = isSearch
    ? `🔍 搜尋「${searchKeyword}」找到 ${total} 個模型：`
    : `✅ 獲取到 ${total} 個模型：`;

  const footer = isSearch
    ? `\n請選擇：\n• 輸入編號（從搜尋結果中選擇，多選用逗號分隔）\n• 輸入 "all" 全選搜尋結果\n• 輸入 "manual" 手動輸入\n• 輸入新關鍵字繼續搜尋\n• 輸入 "back" 返回完整列表`
    : `\n請選擇：\n• 輸入編號（多選用逗號分隔）\n• 輸入 "all" 全選\n• 輸入 "manual" 手動輸入\n• 輸入關鍵字搜尋模型（例如：gpt）`;

  return { header, footer };
}

/** Case-insensitive substring match against model id and name */
function filterModels(models: FetchedModel[], keyword: string): FetchedModel[] {
  const lk = keyword.toLowerCase();
  return models.filter(
    (m) => m.id.toLowerCase().includes(lk) || (m.name && m.name.toLowerCase().includes(lk)),
  );
}

// ========================
// Provider menu text
// ========================

const PROVIDER_MENU_TEXT =
  "📦 Provider 管理\n\n" +
  "1. 新增 Provider\n" +
  "2. 刪除 Provider\n" +
  "3. 編輯 Provider\n" +
  "4. 列出所有 Provider\n\n" +
  "請輸入數字選擇操作，或 /cancel 取消：";

// ========================
// /provider — 統一 Provider 管理對話
// ========================

async function providerConversation(
  conversation: MyConversation,
  ctx: MyContext
): Promise<void> {
  while (true) {
    await ctx.reply(PROVIDER_MENU_TEXT, {
      reply_markup: await webButton(ctx.from!.id, "providers"),
    });
    ctx = await conversation.wait();
    const choice = ctx.msg?.text?.trim() ?? "";

    if (choice === "/cancel") return;

    if (choice === "1") {
      // ── 新增 Provider ──
      await doAddProvider(conversation, ctx);
      continue;
    }

    if (choice === "2") {
      // ── 刪除 Provider ──
      await doDelProvider(conversation, ctx);
      continue;
    }

    if (choice === "3") {
      // ── 編輯 Provider ──
      await doEditProvider(conversation, ctx);
      continue;
    }

    if (choice === "4") {
      // ── 列出 Provider ──
      await doListProviders(ctx);
      continue;
    }

    // 無效選項
    await ctx.reply("❌ 請輸入 1-4 選擇操作。\n\n" + PROVIDER_MENU_TEXT);
  }
}

// ========================
// Provider 子功能：新增
// ========================

async function doAddProvider(
  conversation: MyConversation,
  ctx: MyContext
): Promise<void> {
  // Step 1: Provider name
  await ctx.reply("請輸入 Provider 名稱：");
  ctx = await conversation.wait();
  const name = ctx.msg?.text?.trim();
  if (!name) {
    await ctx.reply("❌ 名稱不能為空，已取消新增。");
    return;
  }

  // Step 2: Base URL
  await ctx.reply("請輸入 Base URL：");
  ctx = await conversation.wait();
  const baseUrl = ctx.msg?.text?.trim();
  if (!baseUrl) {
    await ctx.reply("❌ Base URL 不能為空，已取消新增。");
    return;
  }

  // Step 3: API key
  await ctx.reply("請輸入 API Key（可使用 , 分隔多個 API Key）：");
  ctx = await conversation.wait();
  const apiKeyRaw = ctx.msg?.text?.trim();
  if (!apiKeyRaw) {
    await ctx.reply("❌ API Key 不能為空，已取消新增。");
    return;
  }
  // Parse comma-separated keys → JSON array
  const apiKey = JSON.stringify(apiKeyRaw.split(",").map((k: string) => k.trim()).filter(Boolean));

  // Step 4: Auto-detect API protocols (v2: precise status code analysis)
  await ctx.reply("🔍 正在偵測 API 端點支持的協議...");
  let detection: DetectionResult;
  try {
    detection = await conversation.external(() => detectApiProtocols(baseUrl, apiKey));
  } catch {
    detection = { protocols: {}, recommended: null };
  }

  const typeMap: Record<string, string> = {
    "1": "openai_chat",
    "2": "openai_response",
    "3": "anthropic",
    "4": "google",
  };
  const VALID_TYPES = ["openai_chat", "openai_response", "anthropic", "google"];

  // Build protocol status display with confidence levels and reasons
  const protocolLabels: Record<string, string> = {
    openai_chat: "OpenAI (Chat Completions)",
    openai_response: "OpenAI (Responses API)",
    anthropic: "Anthropic (Messages)",
    google: "Google (Gemini)",
  };
  const confIcon: Record<string, string> = { high: "✅", medium: "⚠️", low: "❓" };

  const protocolLines = Object.entries(protocolLabels).map(([key, label]) => {
    const detail: ProbeDetail = detection.protocols[key] ?? { supported: false, confidence: "low", reason: "" };
    if (detail.supported) {
      const icon = confIcon[detail.confidence] ?? "❓";
      return `${label}：${icon} ${detail.reason}`;
    }
    return `${label}：❌ ${detail.reason}`;
  });

  const anySupported = Object.values(detection.protocols).some((d) => d.supported);
  const recommended = detection.recommended;
  const recLine = recommended
    ? `\n💡 建議選擇：${protocolLabels[recommended] ?? recommended}`
    : "";

  const noticeLine = anySupported
    ? ""
    : "\n⚠️ 所有協議都不支援，請手動確認後選擇類型。";

  await ctx.reply(
    `📡 API 端點偵測結果：\n\n${protocolLines.join("\n")}${recLine}${noticeLine}\n\n` +
    `請選擇 API 類型：\n1️⃣ openai_chat (Chat Completions)\n2️⃣ openai_response (Responses API)\n3️⃣ anthropic\n4️⃣ google\n\n請輸入 1/2/3/4：`
  );

  ctx = await conversation.wait();
  const typeInput = ctx.msg?.text?.trim();
  const apiType = typeMap[typeInput ?? ""] ?? typeInput;
  if (!VALID_TYPES.includes(apiType)) {
    await ctx.reply("❌ 無效的 API 類型，已取消新增。");
    return;
  }

  // ── Step 5: Models ──────────────────────────────────────────
  await ctx.reply("🔍 正在從提供商獲取模型列表...");
  let models = "";
  let fetchedModels = await conversation.external(() => fetchProviderModels(baseUrl, apiKey, apiType));

  if (fetchedModels.length > 0) {
    // Show list with safe pagination
    const { header, footer } = buildModelSelectionPrompt(fetchedModels.length, false);
    await safeReplyModels(ctx, fetchedModels, header, footer);

    // Search loop
    let searchResults: FetchedModel[] | null = null;
    let done = false;

    while (!done) {
      ctx = await conversation.wait();
      const modelInput = (ctx.msg?.text?.trim() ?? "").toLowerCase();

      if (modelInput === "all") {
        const pool = searchResults ?? fetchedModels;
        models = pool.map((m) => m.id).join(",");
        done = true;
      } else if (modelInput === "manual") {
        await ctx.reply("請手動輸入模型（用逗號分隔，例如：gpt-4o,gpt-4o-mini）：");
        ctx = await conversation.wait();
        models = ctx.msg?.text?.trim() ?? "";
        done = true;
      } else if (modelInput === "back") {
        // Exit search, show full list again
        searchResults = null;
        const { header: h, footer: f } = buildModelSelectionPrompt(fetchedModels.length, false);
        await safeReplyModels(ctx, fetchedModels, h, f);
      } else {
        // Try parse as indices first
        const pool = searchResults ?? fetchedModels;
        const indices = parseIndices(modelInput).filter(
          (n) => n >= 1 && n <= pool.length,
        );
        if (indices.length > 0) {
          const uniqueIndices = [...new Set(indices)];
          models = uniqueIndices.map((i) => pool[i - 1].id).join(",");
          done = true;
        } else {
          // Treat as search keyword
          const filtered = filterModels(fetchedModels, modelInput);
          if (filtered.length === 0) {
            await ctx.reply(`🔍 搜尋「${modelInput}」沒有找到任何模型，請換個關鍵字試試。`);
          } else {
            searchResults = filtered;
            const { header: h, footer: f } = buildModelSelectionPrompt(filtered.length, true, modelInput);
            await safeReplyModels(ctx, filtered, h, f);
          }
        }
      }
    }
  } else {
    // Failed to fetch, ask for manual input
    await ctx.reply(
      "⚠️ 無法從提供商獲取模型列表。\n請手動輸入模型（用逗號分隔，例如：gpt-4o,gpt-4o-mini）："
    );
    ctx = await conversation.wait();
    models = ctx.msg?.text?.trim() ?? "";
  }

  // ── Step 6: Pricing ─────────────────────────────────────────
  // Auto-fetch from models.dev — per-model pricing
  const modelList = models.split(",").map((m) => m.trim()).filter(Boolean);
  // Collect per-model pricing: model → { input, output } (per 1M tokens)
  const modelPricingEntries: Array<{ model: string; input_price: number | null; output_price: number | null }> = [];

  if (modelList.length > 0) {
    await ctx.reply("🔍 正在從 models.dev 獲取每個模型的定價...");
    const pricingMap = await conversation.external(() => fetchModelsPricing(modelList));

    // Build per-model pricing lines for display
    const pricingLines: string[] = [];
    let hasAnyPricing = false;

    for (const modelId of modelList) {
      const p = pricingMap.get(modelId);
      if (p && (p.input !== null || p.output !== null)) {
        modelPricingEntries.push({ model: modelId, input_price: p.input, output_price: p.output });
        pricingLines.push(`   ${modelId}：輸入 $${p.input ?? "—"} / 輸出 $${p.output ?? "—"}（每 1M tokens）`);
        hasAnyPricing = true;
      } else {
        modelPricingEntries.push({ model: modelId, input_price: null, output_price: null });
        pricingLines.push(`   ${modelId}：未找到定價`);
      }
    }

    if (hasAnyPricing) {
      await ctx.reply(
        `📋 從 models.dev 獲取到以下定價（每 1M tokens）：\n\n${pricingLines.join("\n")}\n\n` +
        `1️⃣ 使用 models.dev 的定價\n` +
        `2️⃣ 為所有模型手動設定統一定價\n` +
        `3️⃣ 逐個設定每個模型的定價\n` +
        `4️⃣ 跳過\n\n請選擇 1/2/3/4：`
      );

      ctx = await conversation.wait();
      const priceChoice = ctx.msg?.text?.trim() ?? "4";

      if (priceChoice === "2") {
        // Manual: ask for a uniform price for all models
        await ctx.reply("請輸入統一定價（格式：輸入價格,輸出價格，每 1M tokens）：");
        ctx = await conversation.wait();
        const manualPricing = ctx.msg?.text?.trim() ?? "";
        const parts = manualPricing.split(",");
        if (parts.length >= 2) {
          const inp = parseFloat(parts[0].trim());
          const out = parseFloat(parts[1].trim());
          if (!isNaN(inp) && !isNaN(out)) {
            for (const entry of modelPricingEntries) {
              entry.input_price = inp;
              entry.output_price = out;
            }
          }
        }
      } else if (priceChoice === "3") {
        // Per-model manual pricing — iterate
        const manualEntries: Array<{ model: string; input_price: number; output_price: number }> = [];
        for (const modelId of modelList) {
          await ctx.reply(
            `📌 模型「${modelId}」\n` +
            "請輸入定價（格式：輸入價格,輸出價格，每 1M tokens）\n" +
            "或輸入 skip 跳過此模型："
          );
          ctx = await conversation.wait();
          const modelInput = ctx.msg?.text?.trim() ?? "";
          if (modelInput.toLowerCase() === "skip") continue;
          const mParts = modelInput.split(",");
          if (mParts.length >= 2) {
            const mInp = parseFloat(mParts[0].trim());
            const mOut = parseFloat(mParts[1].trim());
            if (!isNaN(mInp) && !isNaN(mOut)) {
              manualEntries.push({ model: modelId, input_price: mInp, output_price: mOut });
            } else {
              await ctx.reply(`❌ 格式錯誤，跳過「${modelId}」。`);
            }
          } else {
            await ctx.reply(`❌ 格式錯誤，跳過「${modelId}」。`);
          }
        }
        // Merge manual entries into modelPricingEntries
        const entryMap = new Map(manualEntries.map((e) => [e.model, e]));
        for (const mpe of modelPricingEntries) {
          const me = entryMap.get(mpe.model);
          if (me) {
            mpe.input_price = me.input_price;
            mpe.output_price = me.output_price;
          }
        }
        if (manualEntries.length > 0) {
          const savedLines = manualEntries.map((e) => `   ${e.model}：$${e.input_price}/$${e.output_price}`).join("\n");
          await ctx.reply(`✅ 已設定 ${manualEntries.length} 個模型的定價：\n${savedLines}`);
        } else {
          await ctx.reply("未設定任何定價。");
        }
      } else if (priceChoice === "4") {
        // Skip — clear all pricing
        for (const entry of modelPricingEntries) {
          entry.input_price = null;
          entry.output_price = null;
        }
      }
      // priceChoice === "1" → keep the fetched per-model pricing
    } else {
      // No pricing found for any model — per-model manual mode
      const manualEntries: Array<{ model: string; input_price: number; output_price: number }> = [];
      for (const modelId of modelList) {
        await ctx.reply(
          `⚠️ 未從 models.dev 獲取到任何定價。\n\n` +
          `📌 模型「${modelId}」\n` +
          "請輸入定價（格式：輸入價格,輸出價格，每 1M tokens）\n" +
          "或輸入 skip 跳過此模型："
        );
        ctx = await conversation.wait();
        const modelInput = ctx.msg?.text?.trim() ?? "";
        if (modelInput.toLowerCase() === "skip") continue;
        const mParts = modelInput.split(",");
        if (mParts.length >= 2) {
          const mInp = parseFloat(mParts[0].trim());
          const mOut = parseFloat(mParts[1].trim());
          if (!isNaN(mInp) && !isNaN(mOut)) {
            manualEntries.push({ model: modelId, input_price: mInp, output_price: mOut });
          } else {
            await ctx.reply(`❌ 格式錯誤，跳過「${modelId}」。`);
          }
        } else {
          await ctx.reply(`❌ 格式錯誤，跳過「${modelId}」。`);
        }
      }
      // Merge manual entries
      const entryMap = new Map(manualEntries.map((e) => [e.model, e]));
      for (const mpe of modelPricingEntries) {
        const me = entryMap.get(mpe.model);
        if (me) {
          mpe.input_price = me.input_price;
          mpe.output_price = me.output_price;
        }
      }
    }
  }

  // Save to DB
  try {
    await conversation.external(async () => {
      await addProvider({
        name,
        api_type: apiType as Provider["api_type"],
        base_url: baseUrl,
        api_key: apiKey,
        models,
        input_price: null, // Provider-level pricing no longer used for calculation
        output_price: null,
      });

      // Get the newly created provider's ID
      const newProvider = (await getProviders()).find((p) => p.name === name);
      if (newProvider && modelPricingEntries.length > 0) {
        await batchUpsertModelPrices(newProvider.id, modelPricingEntries);
      }
    });

    // Build summary
    const summaryLines = modelPricingEntries
      .filter((e) => e.input_price !== null || e.output_price !== null)
      .map((e) => `${e.model}：$${e.input_price}/${e.output_price}`);
    const pricingSummary = summaryLines.length > 0
      ? summaryLines.join("\n   ")
      : "（無定價）";

    await ctx.reply(
      `✅ Provider「${name}」新增成功！\n` +
      `   類型：${apiType}\n` +
      `   模型：${models}\n` +
      `   每模型定價（每 1M tokens）：\n   ${pricingSummary}`
    );
  } catch (err) {
    await ctx.reply(`❌ 新增失敗：${(err as Error).message}`);
  }
}

// ========================
// Provider 子功能：刪除
// ========================

async function doDelProvider(
  conversation: MyConversation,
  ctx: MyContext
): Promise<void> {
  const providers = await getProviders();
  if (providers.length === 0) {
    await ctx.reply("📭 目前沒有任何 Provider。");
    return;
  }

  const lines = providers.map(
    (p, i) => `${i + 1}. ${p.name} (${p.api_type}) — ${p.base_url}`
  );
  await ctx.reply(
    `請選擇要刪除的 Provider（輸入編號，多選用逗號分隔，例如：1,3）：\n\n${lines.join("\n")}`
  );

  ctx = await conversation.wait();
  const indices = parseIndices(ctx.msg?.text ?? "");
  const selectedIds = indices
    .map((i) => providers[i - 1]?.id)
    .filter((id): id is number => id !== undefined);

  if (selectedIds.length === 0) {
    await ctx.reply("❌ 沒有有效的選擇，已取消刪除。");
    return;
  }

  try {
    await conversation.external(async () => { await deleteProvider(selectedIds); });
    await ctx.reply(`✅ 已刪除 ${selectedIds.length} 個 Provider。`);
  } catch (err) {
    await ctx.reply(`❌ 刪除失敗：${(err as Error).message}`);
  }
}

// ========================
// Provider 子功能：列出
// ========================

async function doListProviders(ctx: MyContext): Promise<void> {
  const providers = await getProviders();
  if (providers.length === 0) {
    await ctx.reply("📭 目前沒有任何 Provider。");
    return;
  }

  const lines: string[] = [];

  for (const p of providers) {
    const usage = await getUsageByProvider(p.id);
    const totalInputTokens = usage.reduce((s, u) => s + u.input_tokens, 0);
    const totalOutputTokens = usage.reduce((s, u) => s + u.output_tokens, 0);
    const totalInputCost = usage.reduce((s, u) => s + u.input_cost, 0);
    const totalOutputCost = usage.reduce((s, u) => s + u.output_cost, 0);

    // Get per-model pricing
    const modelPrices = await getModelPricesByProvider(p.id);
    const priceLines = modelPrices.length > 0
      ? modelPrices.map((mp) => `     ${mp.model}：輸入 $${mp.input_price ?? "—"} / 輸出 $${mp.output_price ?? "—"}`).join("\n")
      : `     （無模型定價）`;

    lines.push(
      `📦 *${p.name}* (${p.api_type})`,
      `   狀態：${p.enabled ? "✅ 啟用" : "⛔ 停用"}`,
      `   Base URL：${p.base_url}`,
      `   API Key：${p.api_key.slice(0, 8)}...`,
      `   模型：${p.models || "(無)"}`,
      `   模型定價（每 1M tokens）：`,
      priceLines,
      `   使用量：輸入 ${totalInputTokens.toLocaleString()} tokens / 輸出 ${totalOutputTokens.toLocaleString()} tokens`,
      `   費用：輸入 $${totalInputCost.toFixed(4)} / 輸出 $${totalOutputCost.toFixed(4)}`,
      ""
    );
  }

  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
}

// ========================
// Provider 子功能：編輯
// ========================

async function doEditProvider(
  conversation: MyConversation,
  ctx: MyContext
): Promise<void> {
  const providers = await getProviders();
  if (providers.length === 0) {
    await ctx.reply("📭 目前沒有任何 Provider。");
    return;
  }

  // Step 1: List providers, user picks one
  const lines = providers.map(
    (p, i) => `${i + 1}. ${p.name} (${p.api_type}) — ${p.base_url}`
  );
  await ctx.reply(
    `請選擇要編輯的 Provider（輸入編號）：\n\n${lines.join("\n")}`
  );

  ctx = await conversation.wait();
  const idx = parseInt(ctx.msg?.text?.trim() ?? "", 10);
  const provider = providers[idx - 1];
  if (!provider) {
    await ctx.reply("❌ 無效的編號，已取消編輯。");
    return;
  }

  // Step 2: Show editable fields, user picks one
  const editableFields = [
    { key: "name", label: "名稱", current: provider.name },
    { key: "api_type", label: "API 類型", current: provider.api_type },
    { key: "base_url", label: "Base URL", current: provider.base_url },
    { key: "api_key", label: "API Key", current: (() => { const keys = parseApiKeys(provider.api_key); return keys.length > 1 ? `${keys.length} 個 Key (${keys[0].slice(0,8)}...)` : provider.api_key.slice(0, 8) + "..."; })() },
    { key: "models", label: "模型", current: provider.models || "(無)" },
    { key: "pricing", label: "模型定價", current: "（每個模型獨立定價）" },
    { key: "enabled", label: "啟用狀態", current: provider.enabled ? "啟用 (1)" : "停用 (0)" },
  ];

  const fieldLines = editableFields.map(
    (f, i) => `${i + 1}. ${f.label}：${f.current}`
  );
  await ctx.reply(
    `📦 Provider「${provider.name}」的欄位：\n\n${fieldLines.join("\n")}\n\n請輸入要修改的欄位編號：`
  );

  ctx = await conversation.wait();
  const fieldIdx = parseInt(ctx.msg?.text?.trim() ?? "", 10);
  const field = editableFields[fieldIdx - 1];
  if (!field) {
    await ctx.reply("❌ 無效的編號，已取消編輯。");
    return;
  }

  // Step 3: Ask for new value (special handling for models field)
  let processedValue: string | number | null = null;

  if (field.key === "models") {
    // Auto-fetch models from provider
    await ctx.reply("🔍 正在從提供商獲取模型列表...");
    const fetchedModels = await conversation.external(() =>
      fetchProviderModels(provider.base_url, provider.api_key, provider.api_type)
    );

    if (fetchedModels.length > 0) {
      // Show list with safe pagination
      const { header, footer } = buildModelSelectionPrompt(fetchedModels.length, false);
      await safeReplyModels(ctx, fetchedModels, header, footer);

      // Search loop
      let searchResults: FetchedModel[] | null = null;
      let done = false;

      while (!done) {
        ctx = await conversation.wait();
        const modelInput = (ctx.msg?.text?.trim() ?? "").toLowerCase();

        if (modelInput === "all") {
          const pool = searchResults ?? fetchedModels;
          processedValue = pool.map((m) => m.id).join(",");
          done = true;
        } else if (modelInput === "manual") {
          await ctx.reply("請手動輸入模型（用逗號分隔）：");
          ctx = await conversation.wait();
          processedValue = ctx.msg?.text?.trim() ?? "";
          done = true;
        } else if (modelInput === "back") {
          searchResults = null;
          const { header: h, footer: f } = buildModelSelectionPrompt(fetchedModels.length, false);
          await safeReplyModels(ctx, fetchedModels, h, f);
        } else {
          const pool = searchResults ?? fetchedModels;
          const indices = parseIndices(modelInput).filter(
            (n) => n >= 1 && n <= pool.length,
          );
          if (indices.length > 0) {
            processedValue = [...new Set(indices)].map((i) => pool[i - 1].id).join(",");
            done = true;
          } else {
            const filtered = filterModels(fetchedModels, modelInput);
            if (filtered.length === 0) {
              await ctx.reply(`🔍 搜尋「${modelInput}」沒有找到任何模型，請換個關鍵字試試。`);
            } else {
              searchResults = filtered;
              const { header: h, footer: f } = buildModelSelectionPrompt(filtered.length, true, modelInput);
              await safeReplyModels(ctx, filtered, h, f);
            }
          }
        }
      }
    } else {
      await ctx.reply("⚠️ 無法獲取模型列表，請手動輸入模型（用逗號分隔）：");
      ctx = await conversation.wait();
      processedValue = ctx.msg?.text?.trim() ?? "";
    }

    // ── Auto-fetch pricing from models.dev after model selection ──
    const newModelList = String(processedValue).split(",").map((m) => m.trim()).filter(Boolean);
    if (newModelList.length > 0) {
      await ctx.reply("🔍 正在從 models.dev 獲取每個新模型的定價...");
      const pricingMap = await conversation.external(() => fetchModelsPricing(newModelList));

      // Show current DB model prices for comparison
      const dbPrices = await getModelPricesByProvider(provider.id);
      const dbPriceMap = new Map(dbPrices.map((p) => [p.model, p]));

      const pricingEntries: Array<{ model: string; input_price: number | null; output_price: number | null }> = [];
      const lines: string[] = [];
      let hasAnyPricing = false;

      for (const modelId of newModelList) {
        const devP = pricingMap.get(modelId);
        const dbP = dbPriceMap.get(modelId);
        const currentInput = dbP?.input_price ?? "—";
        const currentOutput = dbP?.output_price ?? "—";

        if (devP && (devP.input !== null || devP.output !== null)) {
          lines.push(
            `${modelId}：\n` +
            `   models.dev：輸入 $${devP.input ?? "—"} / 輸出 $${devP.output ?? "—"}\n` +
            `   當前資料庫：輸入 $${currentInput} / 輸出 $${currentOutput}`
          );
          pricingEntries.push({ model: modelId, input_price: devP.input, output_price: devP.output });
          hasAnyPricing = true;
        } else {
          lines.push(
            `${modelId}：未找到 models.dev 定價（當前：輸入 $${currentInput} / 輸出 $${currentOutput}）`
          );
        }
      }

      if (hasAnyPricing) {
        await ctx.reply(
          `📋 模型定價對比（每 1M tokens）：\n\n${lines.join("\n\n")}\n\n` +
          `1️⃣ 使用 models.dev 的定價更新全部\n` +
          `2️⃣ 為所有模型手動設定統一定價\n` +
          `3️⃣ 逐個設定每個模型的定價\n` +
          `4️⃣ 只更新模型，不動定價\n\n請選擇 1/2/3/4：`
        );

        ctx = await conversation.wait();
        const priceChoice = ctx.msg?.text?.trim() ?? "4";

        if (priceChoice === "1") {
          // Update models + models.dev pricing
          await conversation.external(() => updateProvider(provider.id, { models: String(processedValue) }));
          try {
            const validEntries = pricingEntries.filter((e) => e.input_price !== null || e.output_price !== null);
            await conversation.external(async () => { await batchUpsertModelPrices(provider.id, validEntries); });
            await ctx.reply(`✅ 已更新模型和 ${validEntries.length} 個模型的定價。`);
          } catch (err) {
            await ctx.reply(`⚠️ 定價更新失敗：${(err as Error).message}`);
          }
          return;
        } else if (priceChoice === "2") {
          // Uniform manual pricing
          await conversation.external(() => updateProvider(provider.id, { models: String(processedValue) }));
          await ctx.reply("請輸入統一定價（格式：輸入價格,輸出價格，每 1M tokens）：");
          ctx = await conversation.wait();
          const manualPricing = ctx.msg?.text?.trim() ?? "";
          const parts = manualPricing.split(",");
          if (parts.length >= 2) {
            const inp = parseFloat(parts[0].trim());
            const out = parseFloat(parts[1].trim());
            if (!isNaN(inp) && !isNaN(out)) {
              const uniformEntries = newModelList.map((m) => ({ model: m, input_price: inp, output_price: out }));
              try {
                await conversation.external(async () => { await batchUpsertModelPrices(provider.id, uniformEntries); });
                await ctx.reply(`✅ 已為 ${newModelList.length} 個模型設定統一定價：$${inp}/$${out}（每 1M tokens）`);
              } catch (err) {
                await ctx.reply(`❌ 更新失敗：${(err as Error).message}`);
              }
            }
          }
          return;
        } else if (priceChoice === "3") {
          // Per-model manual pricing
          await conversation.external(() => updateProvider(provider.id, { models: String(processedValue) }));
          const manualEntries: Array<{ model: string; input_price: number; output_price: number }> = [];
          for (const modelId of newModelList) {
            await ctx.reply(
              `📌 模型「${modelId}」\n` +
              "請輸入定價（格式：輸入價格,輸出價格，每 1M tokens）\n" +
              "或輸入 skip 跳過此模型："
            );
            ctx = await conversation.wait();
            const modelInput = ctx.msg?.text?.trim() ?? "";
            if (modelInput.toLowerCase() === "skip") continue;
            const mParts = modelInput.split(",");
            if (mParts.length >= 2) {
              const mInp = parseFloat(mParts[0].trim());
              const mOut = parseFloat(mParts[1].trim());
              if (!isNaN(mInp) && !isNaN(mOut)) {
                manualEntries.push({ model: modelId, input_price: mInp, output_price: mOut });
              } else {
                await ctx.reply(`❌ 格式錯誤，跳過「${modelId}」。`);
              }
            } else {
              await ctx.reply(`❌ 格式錯誤，跳過「${modelId}」。`);
            }
          }
          if (manualEntries.length > 0) {
            try {
              await conversation.external(async () => { await batchUpsertModelPrices(provider.id, manualEntries); });
              const savedLines = manualEntries.map((e) => `   ${e.model}：$${e.input_price}/$${e.output_price}`).join("\n");
              await ctx.reply(`✅ 已設定 ${manualEntries.length} 個模型的定價：\n${savedLines}`);
            } catch (err) {
              await ctx.reply(`❌ 更新失敗：${(err as Error).message}`);
            }
          } else {
            await ctx.reply("未設定任何定價。");
          }
          return;
        }
        // priceChoice === "4" or other → only update models, fall through
      } else {
        await ctx.reply("⚠️ 未從 models.dev 獲取到這些模型的定價，定價保持不變。");
      }
    }
  } else if (field.key === "pricing") {
    // ── Per-model pricing management ──
    const currentModels = provider.models ? provider.models.split(",").map((m) => m.trim()).filter(Boolean) : [];

    if (currentModels.length === 0) {
      await ctx.reply("⚠️ 此 Provider 尚無模型，請先設定模型列表。");
      return;
    }

    await ctx.reply("🔍 正在從 models.dev 獲取每個模型的定價...");
    const pricingMap = await conversation.external(() => fetchModelsPricing(currentModels));

    // Show current model_prices from DB vs models.dev
    const dbPrices = await getModelPricesByProvider(provider.id);
    const dbPriceMap = new Map(dbPrices.map((p) => [p.model, p]));

    const lines: string[] = [];
    const pricingEntries: Array<{ model: string; input_price: number | null; output_price: number | null }> = [];
    let hasAnyDevPricing = false;

    for (const modelId of currentModels) {
      const devP = pricingMap.get(modelId);
      const dbP = dbPriceMap.get(modelId);
      const currentInput = dbP?.input_price ?? "—";
      const currentOutput = dbP?.output_price ?? "—";

      if (devP && (devP.input !== null || devP.output !== null)) {
        lines.push(
          `${modelId}：\n` +
          `   models.dev：輸入 $${devP.input ?? "—"} / 輸出 $${devP.output ?? "—"}\n` +
          `   當前資料庫：輸入 $${currentInput} / 輸出 $${currentOutput}`
        );
        pricingEntries.push({ model: modelId, input_price: devP.input, output_price: devP.output });
        hasAnyDevPricing = true;
      } else {
        lines.push(
          `${modelId}：未找到 models.dev 定價（當前：輸入 $${currentInput} / 輸出 $${currentOutput}）`
        );
      }
    }

    if (hasAnyDevPricing) {
      await ctx.reply(
        `📋 模型定價對比（每 1M tokens）：\n\n${lines.join("\n\n")}\n\n` +
        `1️⃣ 使用 models.dev 的定價更新全部\n` +
        `2️⃣ 為所有模型手動設定統一定價\n` +
        `3️⃣ 逐個設定每個模型的定價\n` +
        `4️⃣ 跳過\n\n請選擇 1/2/3/4：`
      );

      ctx = await conversation.wait();
      const priceChoice = ctx.msg?.text?.trim() ?? "4";

      if (priceChoice === "1") {
        try {
          await conversation.external(async () => { await batchUpsertModelPrices(provider.id, pricingEntries); });
          await ctx.reply("✅ 已從 models.dev 更新所有模型定價。");
        } catch (err) {
          await ctx.reply(`❌ 更新失敗：${(err as Error).message}`);
        }
        return;
      } else if (priceChoice === "2") {
        // Uniform manual pricing
        await ctx.reply("請輸入統一定價（格式：input_price,output_price，每 1M tokens）：");
        ctx = await conversation.wait();
        const manualPricing = ctx.msg?.text?.trim() ?? "";
        const parts = manualPricing.split(",");
        if (parts.length === 2) {
          const inp = parseFloat(parts[0].trim());
          const out = parseFloat(parts[1].trim());
          if (!isNaN(inp) && !isNaN(out)) {
            const uniformEntries = currentModels.map((m) => ({ model: m, input_price: inp, output_price: out }));
            try {
              await conversation.external(async () => { await batchUpsertModelPrices(provider.id, uniformEntries); });
              await ctx.reply(`✅ 已為 ${currentModels.length} 個模型設定統一定價：$${inp}/$${out}（每 1M tokens）`);
            } catch (err) {
              await ctx.reply(`❌ 更新失敗：${(err as Error).message}`);
            }
          } else {
            await ctx.reply("❌ 價格格式錯誤。");
          }
        }
        return;
      } else if (priceChoice === "3") {
        // Per-model manual pricing — iterate
        const manualEntries: Array<{ model: string; input_price: number; output_price: number }> = [];
        for (const modelId of currentModels) {
          await ctx.reply(
            `📌 模型「${modelId}」\n` +
            "請輸入定價（格式：input_price,output_price，每 1M tokens）\n" +
            "或輸入 skip 跳過此模型："
          );
          ctx = await conversation.wait();
          const modelInput = ctx.msg?.text?.trim() ?? "";
          if (modelInput.toLowerCase() === "skip") continue;
          const mParts = modelInput.split(",");
          if (mParts.length >= 2) {
            const mInp = parseFloat(mParts[0].trim());
            const mOut = parseFloat(mParts[1].trim());
            if (!isNaN(mInp) && !isNaN(mOut)) {
              manualEntries.push({ model: modelId, input_price: mInp, output_price: mOut });
            } else {
              await ctx.reply(`❌ 格式錯誤，跳過「${modelId}」。`);
            }
          } else {
            await ctx.reply(`❌ 格式錯誤，跳過「${modelId}」。`);
          }
        }
        if (manualEntries.length > 0) {
          try {
            await conversation.external(async () => { await batchUpsertModelPrices(provider.id, manualEntries); });
            const savedLines = manualEntries.map((e) => `   ${e.model}：$${e.input_price}/$${e.output_price}`).join("\n");
            await ctx.reply(`✅ 已設定 ${manualEntries.length} 個模型的定價：\n${savedLines}`);
          } catch (err) {
            await ctx.reply(`❌ 更新失敗：${(err as Error).message}`);
          }
        } else {
          await ctx.reply("未設定任何定價。");
        }
        return;
      } else {
        await ctx.reply("已跳過，定價保持不變。");
        return;
      }
    } else {
      // No models.dev pricing found — per-model manual pricing
      await ctx.reply("⚠️ 未從 models.dev 獲取到任何定價。開始逐個設定模型定價。");

      const manualEntries: Array<{ model: string; input_price: number; output_price: number }> = [];
      for (const modelId of currentModels) {
        await ctx.reply(
          `📌 模型「${modelId}」\n` +
          "請輸入定價（格式：input_price,output_price，每 1M tokens）\n" +
          "或輸入 skip 跳過此模型："
        );
        ctx = await conversation.wait();
        const modelInput = ctx.msg?.text?.trim() ?? "";
        if (modelInput.toLowerCase() === "skip") continue;
        const mParts = modelInput.split(",");
        if (mParts.length >= 2) {
          const mInp = parseFloat(mParts[0].trim());
          const mOut = parseFloat(mParts[1].trim());
          if (!isNaN(mInp) && !isNaN(mOut)) {
            manualEntries.push({ model: modelId, input_price: mInp, output_price: mOut });
          } else {
            await ctx.reply(`❌ 格式錯誤，跳過「${modelId}」。`);
          }
        } else {
          await ctx.reply(`❌ 格式錯誤，跳過「${modelId}」。`);
        }
      }
      if (manualEntries.length > 0) {
        try {
          await conversation.external(async () => { await batchUpsertModelPrices(provider.id, manualEntries); });
          const savedLines = manualEntries.map((e) => `   ${e.model}：$${e.input_price}/$${e.output_price}`).join("\n");
          await ctx.reply(`✅ 已設定 ${manualEntries.length} 個模型的定價：\n${savedLines}`);
        } catch (err) {
          await ctx.reply(`❌ 更新失敗：${(err as Error).message}`);
        }
      } else {
        await ctx.reply("未設定任何定價。");
      }
      return;
    }
  } else {
    // Normal field edit
    if (field.key === "api_key") {
      await ctx.reply(`請輸入「${field.label}」的新值（可使用 , 分隔多個 API Key）：`);
    } else {
      await ctx.reply(`請輸入「${field.label}」的新值：`);
    }
    ctx = await conversation.wait();
    const newValue = ctx.msg?.text?.trim();
    if (!newValue) {
      await ctx.reply("❌ 值不能為空，已取消編輯。");
      return;
    }

    if (field.key === "api_key") {
      // Parse comma-separated → JSON array
      processedValue = JSON.stringify(newValue.split(",").map((k: string) => k.trim()).filter(Boolean));
    } else if (field.key === "enabled") {
      processedValue = newValue === "1" ? 1 : 0;
    } else {
      processedValue = newValue;
    }
  }

  try {
    await conversation.external(async () => { await updateProvider(provider.id, { [field.key]: processedValue }); });
    await ctx.reply(`✅ 已更新「${provider.name}」的${field.label}。`);
  } catch (err) {
    await ctx.reply(`❌ 更新失敗：${(err as Error).message}`);
  }
}

// ========================
// /uu — Show all users' API key usage
// ========================

async function uuCommand(ctx: MyContext): Promise<void> {
  const users = await getUsers();
  if (users.length === 0) {
    await ctx.reply("📭 目前沒有任何使用者。");
    return;
  }

  const lines: string[] = ["👥 *使用者用量統計*\n"];

  for (const user of users) {
    const usage = await getUsageByUser(user.tg_user_id);
    const totalInputTokens = usage.reduce((s, u) => s + u.input_tokens, 0);
    const totalOutputTokens = usage.reduce((s, u) => s + u.output_tokens, 0);
    const totalInputCost = usage.reduce((s, u) => s + u.input_cost, 0);
    const totalOutputCost = usage.reduce((s, u) => s + u.output_cost, 0);
    const totalCost = totalInputCost + totalOutputCost;

    const displayName = user.username ? `@${user.username}` : "無使用者名稱";
    lines.push(
      `👤 ${displayName} (TG ID: \`${user.tg_user_id}\`) — ${user.is_active ? "✅" : "⛔"}`,
      `   輸入：${totalInputTokens.toLocaleString()} tokens ($${totalInputCost.toFixed(4)})`,
      `   輸出：${totalOutputTokens.toLocaleString()} tokens ($${totalOutputCost.toFixed(4)})`,
      `   總費用：$${totalCost.toFixed(4)}`,
      ""
    );
  }

  await ctx.reply(lines.join("\n"), {
    parse_mode: "Markdown",
    reply_markup: await webButton(ctx.from!.id, "all-usage"),
  });
}

// ========================
// /sub_url — Set API URL (2-step)
// ========================

async function subUrlConversation(
  conversation: MyConversation,
  ctx: MyContext
): Promise<void> {
  // 顯示「管理員手動設定的值」（可能是 null=未設定）和「目前實際使用值」
  // 兩者分開，避免管理員誤把 tunnel URL 當成持久設定。
  const rawConfigured = await conversation.external(() => getRawConfiguredApiUrl());
  const info = await conversation.external(() => getEffectiveApiUrlWithSource());
  const lines: string[] = [`目前實際使用 API URL：${info.url}`];
  if (info.source === "tunnel") {
    lines.push("⚠️ 此 URL 來自 Cloudflare 快速隧道，重啟後會變更。");
  } else if (info.source === "tunnel-pending") {
    lines.push("⏳ 隧道連線中，暫時顯示預設 URL，請稍後再試。");
  } else if (info.source === "default") {
    lines.push("ℹ️ 未設定且無隧道，使用 DEFAULT_API_URL。");
  }
  lines.push(
    rawConfigured
      ? `管理員手動設定值：${rawConfigured}（會覆蓋自動來源）`
      : "管理員手動設定值：（未設定，使用自動來源）"
  );
  lines.push("");
  lines.push("請選擇操作：");
  lines.push("  1. 設定新的 URL");
  lines.push("  2. 清除手動設定（回復 tunnel / 預設）");
  lines.push("  其他輸入取消");

  await ctx.reply(lines.join("\n"), {
    reply_markup: await webButton(ctx.from!.id, "settings"),
  });

  ctx = await conversation.wait();
  const choice = ctx.msg?.text?.trim() ?? "";

  if (choice === "2") {
    try {
      await conversation.external(async () => { await deleteSetting("api_url"); });
      await ctx.reply("✅ 已清除手動 API URL 設定，將使用 tunnel / 預設 URL。");
    } catch (err) {
      await ctx.reply(`❌ 清除失敗：${(err as Error).message}`);
    }
    return;
  }

  if (choice !== "1") {
    await ctx.reply("已取消。");
    return;
  }

  await ctx.reply("請輸入新的 API URL：");
  ctx = await conversation.wait();
  const newUrl = ctx.msg?.text?.trim() ?? "";
  if (!newUrl) {
    await ctx.reply("❌ URL 不能為空，已取消。");
    return;
  }

  try {
    await conversation.external(async () => {
      await setSetting("api_url", newUrl.replace(/\/+$/, ""));
    });
    await ctx.reply(`✅ API URL 已更新為：${newUrl}`);
  } catch (err) {
    await ctx.reply(`❌ 更新失敗：${(err as Error).message}`);
  }
}

// ========================
// /admin_user — Unified user management (menu loop)
// ========================

const ADMIN_USER_MENU_TEXT =
  "👤 用戶管理\n\n" +
  "1. 新增用戶\n" +
  "2. 停用用戶\n" +
  "3. 刪除用戶\n" +
  "4. 編輯用戶 TG ID\n" +
  "5. 移除用戶 API Key\n" +
  "6. 模型限制管理\n\n" +
  "請輸入編號選擇操作（/cancel 結束）：";

async function adminUserConversation(
  conversation: MyConversation,
  ctx: MyContext
): Promise<void> {
  while (true) {
    await ctx.reply(ADMIN_USER_MENU_TEXT, {
      reply_markup: await webButton(ctx.from!.id, "users"),
    });
    ctx = await conversation.wait();
    const choice = ctx.msg?.text?.trim() ?? "";

    if (choice === "/cancel") return;

    if (choice === "1") {
      // ── 新增用戶 ──
      await ctx.reply("請輸入新使用者的 TG User ID：");
      ctx = await conversation.wait();
      const tgUserId = parseInt(ctx.msg?.text?.trim() ?? "", 10);
      if (isNaN(tgUserId)) {
        await ctx.reply("❌ 無效的 TG User ID。");
        continue;
      }
      try {
        await conversation.external(async () => { await addUser(tgUserId); });
        await ctx.reply(`✅ 已新增使用者 (TG ID: ${tgUserId})。`);
      } catch (err) {
        await ctx.reply(`❌ 新增失敗：${(err as Error).message}`);
      }
      continue;
    }

    if (choice === "2") {
      // ── 停用用戶 ──
      const users = await getUsers(config.ADMIN_ID ?? undefined);
      if (users.length === 0) {
        await ctx.reply("📭 沒有可停用的使用者（排除管理員）。");
        continue;
      }
      const lines = users.map(
        (u, i) =>
          `${i + 1}. ${u.username ? "@" + u.username : "無名"} (TG: ${u.tg_user_id}) — ${u.is_active ? "✅ 啟用" : "⛔ 已停用"}`
      );
      await ctx.reply(
        `請選擇要停用的使用者（輸入編號，多選用逗號分隔，例如：1,3）：\n\n${lines.join("\n")}`
      );
      ctx = await conversation.wait();
      const indices = parseIndices(ctx.msg?.text ?? "");
      const selectedUsers = indices
        .map((i) => users[i - 1])
        .filter((u): u is User => u !== undefined);
      if (selectedUsers.length === 0) {
        await ctx.reply("❌ 沒有有效的選擇。");
        continue;
      }
      for (const user of selectedUsers) {
        try {
          await conversation.external(async () => { await updateUserStatus(user.id, 0); });
          try {
            await ctx.api.sendMessage(user.tg_user_id, "你的帳號已被管理員停用");
          } catch { /* user may have blocked the bot */ }
        } catch (err) {
          await ctx.reply(`❌ 停用 ${user.tg_user_id} 失敗：${(err as Error).message}`);
        }
      }
      await ctx.reply(`✅ 已停用 ${selectedUsers.length} 個使用者。`);
      continue;
    }

    if (choice === "3") {
      // ── 刪除用戶 ──
      const users = await getUsers(config.ADMIN_ID ?? undefined);
      if (users.length === 0) {
        await ctx.reply("📭 沒有可刪除的使用者（排除管理員）。");
        continue;
      }
      const lines = users.map(
        (u, i) =>
          `${i + 1}. ${u.username ? "@" + u.username : "無名"} (TG: ${u.tg_user_id})`
      );
      await ctx.reply(
        `請選擇要刪除的使用者（輸入編號，多選用逗號分隔，例如：1,3）：\n\n${lines.join("\n")}`
      );
      ctx = await conversation.wait();
      const indices = parseIndices(ctx.msg?.text ?? "");
      const selectedUsers = indices
        .map((i) => users[i - 1])
        .filter((u): u is User => u !== undefined);
      if (selectedUsers.length === 0) {
        await ctx.reply("❌ 沒有有效的選擇。");
        continue;
      }
      for (const user of selectedUsers) {
        try {
          await conversation.external(async () => { await deleteUser(user.id); });
        } catch (err) {
          await ctx.reply(`❌ 刪除 ${user.tg_user_id} 失敗：${(err as Error).message}`);
        }
      }
      await ctx.reply(`✅ 已刪除 ${selectedUsers.length} 個使用者。`);
      continue;
    }

    if (choice === "4") {
      // ── 編輯用戶 TG ID ──
      const users = await getUsers();
      if (users.length === 0) {
        await ctx.reply("📭 目前沒有任何使用者。");
        continue;
      }
      const lines = users.map(
        (u, i) =>
          `${i + 1}. ${u.username ? "@" + u.username : "無名"} (TG: ${u.tg_user_id}) — ${u.is_active ? "✅" : "⛔"}`
      );
      await ctx.reply(
        `請選擇要編輯的使用者（輸入編號）：\n\n${lines.join("\n")}`
      );
      ctx = await conversation.wait();
      const idx = parseInt(ctx.msg?.text?.trim() ?? "", 10);
      const user = users[idx - 1];
      if (!user) {
        await ctx.reply("❌ 無效的編號。");
        continue;
      }
      await ctx.reply(
        "已收到您的請求,請在下則訊息給出完整用戶id且不要包含其他內容"
      );
      ctx = await conversation.wait();
      const newTgId = parseInt(ctx.msg?.text?.trim() ?? "", 10);
      if (isNaN(newTgId)) {
        await ctx.reply("❌ 無效的 TG User ID。");
        continue;
      }
      try {
        await conversation.external(async () => { await updateUserTgId(user.tg_user_id, newTgId); });
        await ctx.reply(`✅ 已更新使用者 TG ID：${user.tg_user_id} → ${newTgId}`);
      } catch (err) {
        await ctx.reply(`❌ 更新失敗：${(err as Error).message}`);
      }
      continue;
    }

    if (choice === "5") {
      // ── 移除用戶 API Key ──
      const keys = await getAllKeys();
      if (keys.length === 0) {
        await ctx.reply("📭 目前沒有任何 API Key。");
        continue;
      }
      const lines = keys.map(
        (k, i) =>
          `${i + 1}. ${k.key.slice(0, 12)}... — TG: ${k.tg_user_id} (${k.username ?? "無名"}) ${k.is_active ? "✅" : "⛔"}`
      );
      await ctx.reply(
        `請選擇要刪除的 API Key（輸入編號，多選用逗號分隔，例如：1,3）：\n\n${lines.join("\n")}`
      );
      ctx = await conversation.wait();
      const indices = parseIndices(ctx.msg?.text ?? "");
      const selectedIds = indices
        .map((i) => keys[i - 1]?.id)
        .filter((id): id is number => id !== undefined);
      if (selectedIds.length === 0) {
        await ctx.reply("❌ 沒有有效的選擇。");
        continue;
      }
      try {
        await conversation.external(async () => {
            for (const id of selectedIds) {
              await deleteApiKey(id);
          }
        });
        await ctx.reply(`✅ 已刪除 ${selectedIds.length} 個 API Key。`);
      } catch (err) {
        await ctx.reply(`❌ 刪除失敗：${(err as Error).message}`);
      }
      continue;
    }

    if (choice === "6") {
      // ── 模型限制管理 ──
      const users = await getUsers();
      if (users.length === 0) {
        await ctx.reply("📭 沒有可管理的使用者。");
        continue;
      }
      const lines = users.map(
        (u, i) => {
          const isAdmin = u.tg_user_id === config.ADMIN_ID;
          const tag = isAdmin ? " 👑管理員" : "";
          return `${i + 1}. ${u.username ? "@" + u.username : "無名"} (TG: ${u.tg_user_id}) — ${u.is_active ? "✅" : "⛔"}${tag}`;
        }
      );
      await ctx.reply(
        `📋 請選擇要管理模型限制的使用者（輸入編號）：\n\n${lines.join("\n")}`
      );
      ctx = await conversation.wait();
      const userIndex = parseInt(ctx.msg?.text?.trim() ?? "", 10);
      const selectedUser = users[userIndex - 1];
      if (!selectedUser) {
        await ctx.reply("❌ 無效的選擇。");
        continue;
      }

      // Show current restrictions for this user
      const restrictions = await getModelRestrictionsForUser(selectedUser.id);
      const userKeys = await getKeysByUser(selectedUser.tg_user_id);
      let infoMsg = `📋 用戶 ${selectedUser.username ? "@" + selectedUser.username : selectedUser.tg_user_id} 的模型限制：\n\n`;

      // User-level restriction
      const userRestriction = restrictions.find((r) => r.api_key_id === null);
      if (userRestriction) {
        infoMsg += `🔹 用戶級別：模式=${userRestriction.mode}，模型=${userRestriction.models || "(空)"}\n`;
      } else {
        infoMsg += `🔹 用戶級別：未設定（預設拒絕所有模型）\n`;
      }

      // Key-level restrictions
      for (const key of userKeys) {
        const keyRestriction = restrictions.find((r) => r.api_key_id === key.id);
        const keyLabel = `sk-...${key.key.slice(-6)}`;
        if (keyRestriction) {
          infoMsg += `🔸 Key ${keyLabel}：模式=${keyRestriction.mode}，模型=${keyRestriction.models || "(空)"}\n`;
        } else {
          infoMsg += `🔸 Key ${keyLabel}：未設定（繼承用戶級別）\n`;
        }
      }

      infoMsg += `\n請選擇操作：\n1. 設定用戶級別限制\n2. 設定 API Key 級別限制\n3. 刪除限制\n4. 返回`;

      await ctx.reply(infoMsg);
      ctx = await conversation.wait();
      const subChoice = ctx.msg?.text?.trim() ?? "";

      if (subChoice === "4" || subChoice === "/cancel") {
        continue;
      }

      if (subChoice === "1") {
        // Set user-level restriction
        await ctx.reply(
          `請輸入模式（whitelist=白名單 / blacklist=黑名單）：`
        );
        ctx = await conversation.wait();
        const mode = ctx.msg?.text?.trim().toLowerCase() ?? "";
        if (mode !== "whitelist" && mode !== "blacklist") {
          await ctx.reply("❌ 無效的模式，請輸入 whitelist 或 blacklist。");
          continue;
        }

        const allModels = getAllCachedModelNames();
        await ctx.reply(
          `📋 可用模型（共 ${allModels.length} 個）：\n${allModels.join(", ")}\n\n` +
          `請輸入模型名稱（逗號分隔），或輸入 * 表示所有模型：`
        );
        ctx = await conversation.wait();
        const modelInput = ctx.msg?.text?.trim() ?? "";
        const models = modelInput === "*" ? allModels.join(",") : modelInput;

        try {
          await conversation.external(async () => { await setModelRestriction(selectedUser.id, null, mode as "whitelist" | "blacklist", models); });
          await ctx.reply("✅ 已設定用戶級別模型限制。");
        } catch (err) {
          await ctx.reply(`❌ 設定失敗：${(err as Error).message}`);
        }
        continue;
      }

      if (subChoice === "2") {
        // Set key-level restriction
        if (userKeys.length === 0) {
          await ctx.reply("📭 該使用者沒有 API Key。");
          continue;
        }
        const keyLines = userKeys.map(
          (k, i) => `${i + 1}. sk-...${k.key.slice(-6)} ${k.is_active ? "✅" : "⛔"}`
        );
        await ctx.reply(`請選擇 API Key：\n\n${keyLines.join("\n")}`);
        ctx = await conversation.wait();
        const keyIndex = parseInt(ctx.msg?.text?.trim() ?? "", 10);
        const selectedKey = userKeys[keyIndex - 1];
        if (!selectedKey) {
          await ctx.reply("❌ 無效的選擇。");
          continue;
        }

        await ctx.reply(
          `請輸入模式（whitelist=白名單 / blacklist=黑名單）：`
        );
        ctx = await conversation.wait();
        const mode = ctx.msg?.text?.trim().toLowerCase() ?? "";
        if (mode !== "whitelist" && mode !== "blacklist") {
          await ctx.reply("❌ 無效的模式，請輸入 whitelist 或 blacklist。");
          continue;
        }

        const allModels = getAllCachedModelNames();
        await ctx.reply(
          `📋 可用模型（共 ${allModels.length} 個）：\n${allModels.join(", ")}\n\n` +
          `請輸入模型名稱（逗號分隔），或輸入 * 表示所有模型：`
        );
        ctx = await conversation.wait();
        const modelInput = ctx.msg?.text?.trim() ?? "";
        const models = modelInput === "*" ? allModels.join(",") : modelInput;

        try {
          await conversation.external(async () => { await setModelRestriction(selectedUser.id, selectedKey.id, mode as "whitelist" | "blacklist", models); });
          await ctx.reply("✅ 已設定 API Key 級別模型限制。");
        } catch (err) {
          await ctx.reply(`❌ 設定失敗：${(err as Error).message}`);
        }
        continue;
      }

      if (subChoice === "3") {
        // Delete restriction
        const deleteOpts: string[] = [];
        const deleteTargets: Array<{ apiKeyId: number | null; label: string }> = [];

        const userRestriction = restrictions.find((r) => r.api_key_id === null);
        if (userRestriction) {
          deleteTargets.push({ apiKeyId: null, label: "用戶級別限制" });
          deleteOpts.push(`${deleteOpts.length + 1}. 用戶級別限制`);
        }
        for (let i = 0; i < userKeys.length; i++) {
          const k = userKeys[i];
          const keyRestriction = restrictions.find((r) => r.api_key_id === k.id);
          if (keyRestriction) {
            deleteTargets.push({ apiKeyId: k.id, label: `Key sk-...${k.key.slice(-6)}` });
            deleteOpts.push(`${deleteOpts.length + 1}. Key sk-...${k.key.slice(-6)}`);
          }
        }
        if (deleteOpts.length === 0) {
          await ctx.reply("📭 沒有可刪除的限制。");
          continue;
        }
        await ctx.reply(`請選擇要刪除的限制：\n\n${deleteOpts.join("\n")}`);
        ctx = await conversation.wait();
        const delIndex = parseInt(ctx.msg?.text?.trim() ?? "", 10);
        if (delIndex < 1 || delIndex > deleteOpts.length) {
          await ctx.reply("❌ 無效的選擇。");
          continue;
        }

        const target = deleteTargets[delIndex - 1];
        try {
          await conversation.external(async () => { await deleteModelRestriction(selectedUser.id, target.apiKeyId); });
          await ctx.reply(`✅ 已刪除模型限制（${target.label}）。`);
        } catch (err) {
          await ctx.reply(`❌ 刪除失敗：${(err as Error).message}`);
        }
        continue;
      }

      await ctx.reply("❌ 無效的選擇。");
      continue;
    }

    // Invalid choice
    await ctx.reply("❌ 請輸入 1-6 選擇操作，或 /cancel 結束。");
  }
}

// ========================
// /api_test — API protocol detection test (admin only)
// ========================

function formatProtocolStatus(detection: DetectionResult): string {
  const protocolLabels: Record<string, string> = {
    openai_chat: "OpenAI (Chat Completions)",
    openai_response: "OpenAI (Responses API)",
    anthropic: "Anthropic (Messages)",
    google: "Google (Gemini)",
  };
  const confIcon: Record<string, string> = { high: "✅", medium: "⚠️", low: "❓" };
  const lines: string[] = [];

  for (const [proto, detail] of Object.entries(detection.protocols)) {
    const label = protocolLabels[proto] || proto;
    if (detail.supported) {
      const icon = confIcon[detail.confidence] ?? "❓";
      lines.push(`  ${icon} ${label} — ${detail.reason}`);
    } else {
      lines.push(`  ❌ ${label} — ${detail.reason}`);
    }
  }

  if (detection.recommended) {
    const recLabel = protocolLabels[detection.recommended] ?? detection.recommended;
    lines.push(`\n  💡 建議：${recLabel}`);
  }

  return lines.join("\n");
}

async function apiTestConversation(
  conversation: MyConversation,
  ctx: MyContext
): Promise<void> {
  // Step 1: Ask for URL (or URL,Key)
  await ctx.reply(
    "🧪 API 協議測試\n\n" +
    "請輸入要測試的 API URL（可附帶 Key）：\n\n" +
    "格式：`URL` 或 `URL,API-KEY`\n\n" +
    "例如：\n" +
    "  `https://api.example.com/v1`\n" +
    "  `https://api.example.com/v1,sk-xxxx`",
    { parse_mode: "Markdown" }
  );

  const urlCtx = await conversation.wait();
  if (!urlCtx.message?.text) return;
  const raw = urlCtx.message.text.trim();

  // Parse "url,key" format — split on the FIRST comma only
  const commaIdx = raw.indexOf(",");
  const url = (commaIdx >= 0 ? raw.substring(0, commaIdx) : raw).trim();
  const apiKey = commaIdx >= 0 ? raw.substring(commaIdx + 1).trim() : "";

  // If Key provided → directly test with auth
  if (apiKey) {
    await ctx.reply("⏳ 正在使用 Key 偵測 API 協議...");

    const detectionWithKey = await conversation.external(() =>
      detectApiProtocols(url, apiKey)
    );

    const resultText = formatProtocolStatus(detectionWithKey);
    const supportedCount = Object.values(detectionWithKey.protocols).filter((d) => d.supported).length;
    const totalCount = Object.keys(detectionWithKey.protocols).length;
    await ctx.reply(
      `📊 偵測結果（帶 Key）：\n\n${resultText}\n\n` +
      `共 ${supportedCount}/${totalCount} 個協議支援。`
    );
    return;
  }

  // URL only → test without auth first
  // Step 2: Test protocols without auth
  await ctx.reply("⏳ 正在偵測 API 協議（不帶 Key）...");
  const { result: detection, allUnreachable } = await conversation.external(() =>
    detectProtocolsNoAuth(url)
  );

  if (allUnreachable) {
    // Step 3: Ask for API key
    await ctx.reply(
      "⚠️ 所有協議都無法連通。\n" +
      "可能是網路問題或需要認證。\n\n" +
      "請輸入 API Key 重試，或輸入 /cancel 取消："
    );

    const keyCtx = await conversation.wait();
    if (!keyCtx.message?.text) return;
    const retryKey = keyCtx.message.text.trim();

    // Step 4: Retry with key
    await ctx.reply("⏳ 正在使用 Key 重新偵測 API 協議...");
    const detectionWithKey = await conversation.external(() =>
      detectApiProtocols(url, retryKey)
    );

    const resultText = formatProtocolStatus(detectionWithKey);
    const supportedCount = Object.values(detectionWithKey.protocols).filter((d) => d.supported).length;
    const totalCount = Object.keys(detectionWithKey.protocols).length;
    await ctx.reply(
      `📊 偵測結果（帶 Key）：\n\n${resultText}\n\n` +
      `共 ${supportedCount}/${totalCount} 個協議支援。`
    );
    return;
  }

  // Display results without auth
  const resultText = formatProtocolStatus(detection);
  const supportedCount = Object.values(detection.protocols).filter((d) => d.supported).length;
  const totalCount = Object.keys(detection.protocols).length;
  await ctx.reply(
    `📊 偵測結果（不帶 Key）：\n\n${resultText}\n\n` +
    `共 ${supportedCount}/${totalCount} 個協議支援。`
  );
}

// ========================
// Register all admin handlers
// ========================

export function registerAdminHandlers(bot: Bot<MyContext>): void {
  // Register all admin conversations
  bot.use(createConversation(providerConversation, "providerConversation"));
  bot.use(createConversation(subUrlConversation, "subUrlConversation"));
  bot.use(createConversation(adminUserConversation, "adminUserConversation"));
  bot.use(createConversation(apiTestConversation, "apiTestConversation"));

  // Admin-only middleware wrapper
  const adminOnly = (
    handler: (ctx: MyContext) => Promise<void>
  ) => async (ctx: MyContext) => {
    if (!isAdmin(ctx)) {
      await ctx.reply("⛔ 此指令僅限管理員使用。");
      return;
    }
    await handler(ctx);
  };

  // Provider management — unified conversation
  bot.command("provider", adminOnly(async (ctx) => {
    await ctx.conversation.enter("providerConversation");
  }));

  // Other conversations
  bot.command("sub_url", adminOnly(async (ctx) => {
    await ctx.conversation.enter("subUrlConversation");
  }));

  bot.command("admin_user", adminOnly(async (ctx) => {
    await ctx.conversation.enter("adminUserConversation");
  }));

  bot.command("api_test", adminOnly(async (ctx) => {
    await ctx.conversation.enter("apiTestConversation");
  }));

  // Single-message commands
  bot.command("uu", adminOnly(uuCommand));
}

import { Bot, Context } from "grammy";
import { Conversation, ConversationFlavor, createConversation } from "@grammyjs/conversations";
import { config } from "../../config.js";
import {
  addProvider,
  getProviders,
  getProviderById,
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
  getSetting,
  setSetting,
  batchUpsertModelPrices,
  getModelPricesByProvider,
  type Provider,
  type User,
  type ApiKey,
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
    await ctx.reply(PROVIDER_MENU_TEXT);
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
    detection = await detectApiProtocols(baseUrl, apiKey);
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
  let fetchedModels = await fetchProviderModels(baseUrl, apiKey, apiType);

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
    const pricingMap = await fetchModelsPricing(modelList);

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
    addProvider({
      name,
      api_type: apiType as Provider["api_type"],
      base_url: baseUrl,
      api_key: apiKey,
      models,
      input_price: null, // Provider-level pricing no longer used for calculation
      output_price: null,
    });

    // Get the newly created provider's ID
    const newProvider = getProviders().find((p) => p.name === name);
    if (newProvider && modelPricingEntries.length > 0) {
      batchUpsertModelPrices(newProvider.id, modelPricingEntries);
    }

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
  const providers = getProviders();
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
    deleteProvider(selectedIds);
    await ctx.reply(`✅ 已刪除 ${selectedIds.length} 個 Provider。`);
  } catch (err) {
    await ctx.reply(`❌ 刪除失敗：${(err as Error).message}`);
  }
}

// ========================
// Provider 子功能：列出
// ========================

async function doListProviders(ctx: MyContext): Promise<void> {
  const providers = getProviders();
  if (providers.length === 0) {
    await ctx.reply("📭 目前沒有任何 Provider。");
    return;
  }

  const lines: string[] = [];

  for (const p of providers) {
    const usage = getUsageByProvider(p.id);
    const totalInputTokens = usage.reduce((s, u) => s + u.input_tokens, 0);
    const totalOutputTokens = usage.reduce((s, u) => s + u.output_tokens, 0);
    const totalInputCost = usage.reduce((s, u) => s + u.input_cost, 0);
    const totalOutputCost = usage.reduce((s, u) => s + u.output_cost, 0);

    // Get per-model pricing
    const modelPrices = getModelPricesByProvider(p.id);
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
  const providers = getProviders();
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
    const fetchedModels = await fetchProviderModels(
      provider.base_url, provider.api_key, provider.api_type
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
      const pricingMap = await fetchModelsPricing(newModelList);

      // Show current DB model prices for comparison
      const dbPrices = getModelPricesByProvider(provider.id);
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
          updateProvider(provider.id, { models: String(processedValue) });
          try {
            const validEntries = pricingEntries.filter((e) => e.input_price !== null || e.output_price !== null);
            batchUpsertModelPrices(provider.id, validEntries);
            await ctx.reply(`✅ 已更新模型和 ${validEntries.length} 個模型的定價。`);
          } catch (err) {
            await ctx.reply(`⚠️ 定價更新失敗：${(err as Error).message}`);
          }
          return;
        } else if (priceChoice === "2") {
          // Uniform manual pricing
          updateProvider(provider.id, { models: String(processedValue) });
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
                batchUpsertModelPrices(provider.id, uniformEntries);
                await ctx.reply(`✅ 已為 ${newModelList.length} 個模型設定統一定價：$${inp}/$${out}（每 1M tokens）`);
              } catch (err) {
                await ctx.reply(`❌ 更新失敗：${(err as Error).message}`);
              }
            }
          }
          return;
        } else if (priceChoice === "3") {
          // Per-model manual pricing
          updateProvider(provider.id, { models: String(processedValue) });
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
              batchUpsertModelPrices(provider.id, manualEntries);
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
    const pricingMap = await fetchModelsPricing(currentModels);

    // Show current model_prices from DB vs models.dev
    const dbPrices = getModelPricesByProvider(provider.id);
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
          batchUpsertModelPrices(provider.id, pricingEntries);
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
              batchUpsertModelPrices(provider.id, uniformEntries);
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
            batchUpsertModelPrices(provider.id, manualEntries);
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
          batchUpsertModelPrices(provider.id, manualEntries);
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
    updateProvider(provider.id, { [field.key]: processedValue });
    await ctx.reply(`✅ 已更新「${provider.name}」的${field.label}。`);
  } catch (err) {
    await ctx.reply(`❌ 更新失敗：${(err as Error).message}`);
  }
}

// ========================
// /uu — Show all users' API key usage
// ========================

async function uuCommand(ctx: MyContext): Promise<void> {
  const users = getUsers();
  if (users.length === 0) {
    await ctx.reply("📭 目前沒有任何使用者。");
    return;
  }

  const lines: string[] = ["👥 *使用者用量統計*\n"];

  for (const user of users) {
    const usage = getUsageByUser(user.tg_user_id);
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

  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
}

// ========================
// /sub_url — Set API URL (2-step)
// ========================

async function subUrlConversation(
  conversation: MyConversation,
  ctx: MyContext
): Promise<void> {
  const currentUrl = getSetting("api_url") ?? config.DEFAULT_API_URL;
  await ctx.reply(`目前 API URL：${currentUrl}\n\n請輸入新的 URL：`);

  ctx = await conversation.wait();
  const newUrl = ctx.msg?.text?.trim();
  if (!newUrl) {
    await ctx.reply("❌ URL 不能為空，已取消。");
    return;
  }

  try {
    setSetting("api_url", newUrl);
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
  "5. 移除用戶 API Key\n\n" +
  "請輸入編號選擇操作（/cancel 結束）：";

async function adminUserConversation(
  conversation: MyConversation,
  ctx: MyContext
): Promise<void> {
  while (true) {
    await ctx.reply(ADMIN_USER_MENU_TEXT);
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
        addUser(tgUserId);
        await ctx.reply(`✅ 已新增使用者 (TG ID: ${tgUserId})。`);
      } catch (err) {
        await ctx.reply(`❌ 新增失敗：${(err as Error).message}`);
      }
      continue;
    }

    if (choice === "2") {
      // ── 停用用戶 ──
      const users = getUsers(config.ADMIN_ID);
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
          updateUserStatus(user.id, 0);
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
      const users = getUsers(config.ADMIN_ID);
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
          deleteUser(user.id);
        } catch (err) {
          await ctx.reply(`❌ 刪除 ${user.tg_user_id} 失敗：${(err as Error).message}`);
        }
      }
      await ctx.reply(`✅ 已刪除 ${selectedUsers.length} 個使用者。`);
      continue;
    }

    if (choice === "4") {
      // ── 編輯用戶 TG ID ──
      const users = getUsers();
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
        updateUserTgId(user.tg_user_id, newTgId);
        await ctx.reply(`✅ 已更新使用者 TG ID：${user.tg_user_id} → ${newTgId}`);
      } catch (err) {
        await ctx.reply(`❌ 更新失敗：${(err as Error).message}`);
      }
      continue;
    }

    if (choice === "5") {
      // ── 移除用戶 API Key ──
      const keys = getAllKeys();
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
        for (const id of selectedIds) {
          deleteApiKey(id);
        }
        await ctx.reply(`✅ 已刪除 ${selectedIds.length} 個 API Key。`);
      } catch (err) {
        await ctx.reply(`❌ 刪除失敗：${(err as Error).message}`);
      }
      continue;
    }

    // Invalid choice
    await ctx.reply("❌ 請輸入 1-5 選擇操作，或 /cancel 結束。");
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

  // Legacy aliases: /add, /del, /edit, /list → all enter provider conversation
  bot.command("add", adminOnly(async (ctx) => {
    await ctx.conversation.enter("providerConversation");
  }));

  bot.command("del", adminOnly(async (ctx) => {
    await ctx.conversation.enter("providerConversation");
  }));

  bot.command("edit", adminOnly(async (ctx) => {
    await ctx.conversation.enter("providerConversation");
  }));

  bot.command("list", adminOnly(async (ctx) => {
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

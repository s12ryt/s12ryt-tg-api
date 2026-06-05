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
  getUserByTgId,
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
import { fetchProviderModels, fetchModelsPricing } from "./modelFetcher.js";

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
// /add — Add a new provider (6-step conversation)
// ========================

async function addConversation(
  conversation: MyConversation,
  ctx: MyContext
): Promise<void> {
  // Step 1: Provider name
  await ctx.reply("請輸入 Provider 名稱：");
  ctx = await conversation.wait();
  const name = ctx.msg?.text?.trim();
  if (!name) {
    await ctx.reply("❌ 名稱不能為空，已取消。");
    return;
  }

  // Step 2: API type
  await ctx.reply("請選擇 API 類型：\n1️⃣ openai\n2️⃣ anthropic\n3️⃣ google\n\n請輸入 1/2/3：");
  ctx = await conversation.wait();
  const typeInput = ctx.msg?.text?.trim();
  const typeMap: Record<string, string> = {
    "1": "openai",
    "2": "anthropic",
    "3": "google",
  };
  const apiType = typeMap[typeInput ?? ""] ?? typeInput;
  if (apiType !== "openai" && apiType !== "anthropic" && apiType !== "google") {
    await ctx.reply("❌ 無效的 API 類型，已取消。");
    return;
  }

  // Step 3: Base URL
  await ctx.reply("請輸入 Base URL：");
  ctx = await conversation.wait();
  const baseUrl = ctx.msg?.text?.trim();
  if (!baseUrl) {
    await ctx.reply("❌ Base URL 不能為空，已取消。");
    return;
  }

  // Step 4: API key
  await ctx.reply("請輸入 API Key：");
  ctx = await conversation.wait();
  const apiKey = ctx.msg?.text?.trim();
  if (!apiKey) {
    await ctx.reply("❌ API Key 不能為空，已取消。");
    return;
  }

  // ── Step 5: Models ──────────────────────────────────────────
  // Auto-fetch from provider's /v1/models endpoint
  await ctx.reply("🔍 正在從提供商獲取模型列表...");
  let models = "";
  let fetchedModels = await fetchProviderModels(baseUrl, apiKey, apiType);

  if (fetchedModels.length > 0) {
    // Show list for user to select
    const modelLines = fetchedModels
      .slice(0, 50) // Limit to 50 to avoid message too long
      .map((m, i) => `${i + 1}. ${m.id}`);
    await ctx.reply(
      `✅ 獲取到 ${fetchedModels.length} 個模型：\n\n${modelLines.join("\n")}` +
        (fetchedModels.length > 50 ? `\n...還有 ${fetchedModels.length - 50} 個` : "") +
        `\n\n請選擇模型（輸入編號，多選用逗號分隔，例如：1,3,5）\n或輸入 "all" 全選\n或輸入 "manual" 手動輸入：`
    );

    ctx = await conversation.wait();
    const modelInput = ctx.msg?.text?.trim() ?? "";

    if (modelInput.toLowerCase() === "all") {
      models = fetchedModels.map((m) => m.id).join(",");
    } else if (modelInput.toLowerCase() === "manual") {
      await ctx.reply("請手動輸入模型（用逗號分隔，例如：gpt-4o,gpt-4o-mini）：");
      ctx = await conversation.wait();
      models = ctx.msg?.text?.trim() ?? "";
    } else {
      // Parse indices
      const indices = parseIndices(modelInput).filter(
        (n) => n >= 1 && n <= fetchedModels.length
      );
      if (indices.length === 0) {
        await ctx.reply("❌ 無效的選擇，已取消。");
        return;
      }
      const uniqueIndices = [...new Set(indices)];
      models = uniqueIndices.map((i) => fetchedModels[i - 1].id).join(",");
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
        `📋 從 models.dev 獲取到以下定價：\n\n${pricingLines.join("\n")}\n\n` +
        `1️⃣ 使用以上定價\n2️⃣ 全部手動輸入\n3️⃣ 跳過\n\n請選擇 1/2/3：`
      );

      ctx = await conversation.wait();
      const priceChoice = ctx.msg?.text?.trim() ?? "1";

      if (priceChoice === "2") {
        // Manual: ask for a uniform price for all models
        await ctx.reply('請輸入統一定價（格式：input_price,output_price）：\n例如：2.5,10（每 1M tokens）');
        ctx = await conversation.wait();
        const manualPricing = ctx.msg?.text?.trim() ?? "";
        const parts = manualPricing.split(",");
        if (parts.length === 2) {
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
        // Skip — clear all pricing
        for (const entry of modelPricingEntries) {
          entry.input_price = null;
          entry.output_price = null;
        }
      }
      // priceChoice === "1" → keep the fetched per-model pricing
    } else {
      // No pricing found for any model
      await ctx.reply(
        "⚠️ 未從 models.dev 獲取到任何定價。\n" +
        '請輸入統一定價（格式：input_price,output_price），或輸入 "skip" 跳過：\n' +
        "例如：2.5,10（每 1M tokens）"
      );
      ctx = await conversation.wait();
      const manualPricing = ctx.msg?.text?.trim() ?? "";
      if (manualPricing.toLowerCase() !== "skip") {
        const parts = manualPricing.split(",");
        if (parts.length === 2) {
          const inp = parseFloat(parts[0].trim());
          const out = parseFloat(parts[1].trim());
          if (!isNaN(inp) && !isNaN(out)) {
            for (const entry of modelPricingEntries) {
              entry.input_price = inp;
              entry.output_price = out;
            }
          }
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
// /del — Delete providers (multi-select)
// ========================

async function delConversation(
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
    await ctx.reply("❌ 沒有有效的選擇，已取消。");
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
// /list — List all providers with usage stats
// ========================

async function listCommand(ctx: MyContext): Promise<void> {
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
// /edit — Edit a provider (3-step conversation)
// ========================

async function editConversation(
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
    await ctx.reply("❌ 無效的編號，已取消。");
    return;
  }

  // Step 2: Show editable fields, user picks one
  const editableFields = [
    { key: "name", label: "名稱", current: provider.name },
    { key: "api_type", label: "API 類型", current: provider.api_type },
    { key: "base_url", label: "Base URL", current: provider.base_url },
    { key: "api_key", label: "API Key", current: provider.api_key.slice(0, 8) + "..." },
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
    await ctx.reply("❌ 無效的編號，已取消。");
    return;
  }

  // Step 3: Ask for new value (special handling for models field)
  let processedValue: string | number | null;

  if (field.key === "models") {
    // Auto-fetch models from provider
    await ctx.reply("🔍 正在從提供商獲取模型列表...");
    const fetchedModels = await fetchProviderModels(
      provider.base_url, provider.api_key, provider.api_type
    );

    if (fetchedModels.length > 0) {
      const modelLines = fetchedModels
        .slice(0, 50)
        .map((m, i) => `${i + 1}. ${m.id}`);
      await ctx.reply(
        `✅ 獲取到 ${fetchedModels.length} 個模型：\n\n${modelLines.join("\n")}` +
        (fetchedModels.length > 50 ? `\n...還有 ${fetchedModels.length - 50} 個` : "") +
        `\n\n請選擇模型（輸入編號，多選用逗號分隔）\n或輸入 "all" 全選\n或輸入 "manual" 手動輸入：`
      );

      ctx = await conversation.wait();
      const modelInput = ctx.msg?.text?.trim() ?? "";

      if (modelInput.toLowerCase() === "all") {
        processedValue = fetchedModels.map((m) => m.id).join(",");
      } else if (modelInput.toLowerCase() === "manual") {
        await ctx.reply("請手動輸入模型（用逗號分隔）：");
        ctx = await conversation.wait();
        processedValue = ctx.msg?.text?.trim() ?? "";
      } else {
        const indices = parseIndices(modelInput).filter(
          (n) => n >= 1 && n <= fetchedModels.length
        );
        if (indices.length === 0) {
          await ctx.reply("❌ 無效的選擇，已取消。");
          return;
        }
        processedValue = [...new Set(indices)].map((i) => fetchedModels[i - 1].id).join(",");
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

      // Build per-model pricing
      const pricingEntries: Array<{ model: string; input_price: number | null; output_price: number | null }> = [];
      const pricingLines: string[] = [];
      let hasAnyPricing = false;

      for (const modelId of newModelList) {
        const p = pricingMap.get(modelId);
        if (p && (p.input !== null || p.output !== null)) {
          pricingEntries.push({ model: modelId, input_price: p.input, output_price: p.output });
          pricingLines.push(`   ${modelId}：輸入 $${p.input ?? "—"} / 輸出 $${p.output ?? "—"}`);
          hasAnyPricing = true;
        } else {
          pricingEntries.push({ model: modelId, input_price: null, output_price: null });
          pricingLines.push(`   ${modelId}：未找到定價`);
        }
      }

      if (hasAnyPricing) {
        await ctx.reply(
          `📋 從 models.dev 獲取到以下定價（每 1M tokens）：\n\n${pricingLines.join("\n")}\n\n` +
          `是否同時更新這些模型的定價？\n1️⃣ 是，使用以上定價\n2️⃣ 否，只更新模型`
        );

        ctx = await conversation.wait();
        const priceChoice = ctx.msg?.text?.trim() ?? "2";

        if (priceChoice === "1") {
          try {
            batchUpsertModelPrices(provider.id, pricingEntries);
            const updated = pricingEntries.filter((e) => e.input_price !== null || e.output_price !== null);
            await ctx.reply(`✅ 已更新 ${updated.length} 個模型的定價。`);
          } catch (err) {
            await ctx.reply(`⚠️ 定價更新失敗：${(err as Error).message}`);
          }
        }
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
    await ctx.reply(`請輸入「${field.label}」的新值：`);
    ctx = await conversation.wait();
    const newValue = ctx.msg?.text?.trim();
    if (!newValue) {
      await ctx.reply("❌ 值不能為空，已取消。");
      return;
    }

    processedValue = newValue;

    if (field.key === "enabled") {
      processedValue = newValue === "1" ? 1 : 0;
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
// /admin_rm_userkey — Remove API keys (multi-select)
// ========================

async function adminRmUserkeyConversation(
  conversation: MyConversation,
  ctx: MyContext
): Promise<void> {
  const keys = getAllKeys();
  if (keys.length === 0) {
    await ctx.reply("📭 目前沒有任何 API Key。");
    return;
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
    await ctx.reply("❌ 沒有有效的選擇，已取消。");
    return;
  }

  try {
    for (const id of selectedIds) {
      deleteApiKey(id);
    }
    await ctx.reply(`✅ 已刪除 ${selectedIds.length} 個 API Key。`);
  } catch (err) {
    await ctx.reply(`❌ 刪除失敗：${(err as Error).message}`);
  }
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
// /add_user — Add a user (2-step)
// ========================

async function addUserConversation(
  conversation: MyConversation,
  ctx: MyContext
): Promise<void> {
  await ctx.reply("請輸入新使用者的 TG User ID：");

  ctx = await conversation.wait();
  const tgUserId = parseInt(ctx.msg?.text?.trim() ?? "", 10);
  if (isNaN(tgUserId)) {
    await ctx.reply("❌ 無效的 TG User ID，已取消。");
    return;
  }

  try {
    addUser(tgUserId);
    await ctx.reply(`✅ 已新增使用者 (TG ID: ${tgUserId})。`);
  } catch (err) {
    await ctx.reply(`❌ 新增失敗：${(err as Error).message}`);
  }
}

// ========================
// /stop_user — Stop users (multi-select)
// ========================

async function stopUserConversation(
  conversation: MyConversation,
  ctx: MyContext
): Promise<void> {
  const users = getUsers(config.ADMIN_ID);
  if (users.length === 0) {
    await ctx.reply("📭 沒有可停用的使用者（排除管理員）。");
    return;
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
    await ctx.reply("❌ 沒有有效的選擇，已取消。");
    return;
  }

  for (const user of selectedUsers) {
    try {
      updateUserStatus(user.id, 0);
      // Try to notify the stopped user
      try {
        await ctx.api.sendMessage(
          user.tg_user_id,
          "你的帳號已被管理員停用"
        );
      } catch {
        // User may have blocked the bot, ignore
      }
    } catch (err) {
      await ctx.reply(
        `❌ 停用 ${user.tg_user_id} 失敗：${(err as Error).message}`
      );
    }
  }

  await ctx.reply(
    `✅ 已停用 ${selectedUsers.length} 個使用者。`
  );
}

// ========================
// /del_user — Delete users (multi-select)
// ========================

async function delUserConversation(
  conversation: MyConversation,
  ctx: MyContext
): Promise<void> {
  const users = getUsers(config.ADMIN_ID);
  if (users.length === 0) {
    await ctx.reply("📭 沒有可刪除的使用者（排除管理員）。");
    return;
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
    await ctx.reply("❌ 沒有有效的選擇，已取消。");
    return;
  }

  for (const user of selectedUsers) {
    try {
      deleteUser(user.id);
    } catch (err) {
      await ctx.reply(
        `❌ 刪除 ${user.tg_user_id} 失敗：${(err as Error).message}`
      );
    }
  }

  await ctx.reply(
    `✅ 已刪除 ${selectedUsers.length} 個使用者。`
  );
}

// ========================
// /edit_user — Edit user TG ID (3-step)
// ========================

async function editUserConversation(
  conversation: MyConversation,
  ctx: MyContext
): Promise<void> {
  const users = getUsers();
  if (users.length === 0) {
    await ctx.reply("📭 目前沒有任何使用者。");
    return;
  }

  // Step 1: List users, pick one
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
    await ctx.reply("❌ 無效的編號，已取消。");
    return;
  }

  // Step 2: Ask for new TG user ID
  await ctx.reply(
    "已收到您的請求,請在下則訊息給出完整用戶id且不要包含其他內容"
  );

  // Step 3: Wait for new ID
  ctx = await conversation.wait();
  const newTgId = parseInt(ctx.msg?.text?.trim() ?? "", 10);
  if (isNaN(newTgId)) {
    await ctx.reply("❌ 無效的 TG User ID，已取消。");
    return;
  }

  try {
    updateUserTgId(user.tg_user_id, newTgId);
    await ctx.reply(
      `✅ 已更新使用者 TG ID：${user.tg_user_id} → ${newTgId}`
    );
  } catch (err) {
    await ctx.reply(`❌ 更新失敗：${(err as Error).message}`);
  }
}

// ========================
// Register all admin handlers
// ========================

export function registerAdminHandlers(bot: Bot<MyContext>): void {
  // Register all admin conversations
  bot.use(createConversation(addConversation, "addConversation"));
  bot.use(createConversation(delConversation, "delConversation"));
  bot.use(createConversation(editConversation, "editConversation"));
  bot.use(createConversation(adminRmUserkeyConversation, "adminRmUserkeyConversation"));
  bot.use(createConversation(subUrlConversation, "subUrlConversation"));
  bot.use(createConversation(addUserConversation, "addUserConversation"));
  bot.use(createConversation(stopUserConversation, "stopUserConversation"));
  bot.use(createConversation(delUserConversation, "delUserConversation"));
  bot.use(createConversation(editUserConversation, "editUserConversation"));

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

  // Conversation commands
  bot.command("add", adminOnly(async (ctx) => {
    await ctx.conversation.enter("addConversation");
  }));

  bot.command("del", adminOnly(async (ctx) => {
    await ctx.conversation.enter("delConversation");
  }));

  bot.command("edit", adminOnly(async (ctx) => {
    await ctx.conversation.enter("editConversation");
  }));

  bot.command("admin_rm_userkey", adminOnly(async (ctx) => {
    await ctx.conversation.enter("adminRmUserkeyConversation");
  }));

  bot.command("sub_url", adminOnly(async (ctx) => {
    await ctx.conversation.enter("subUrlConversation");
  }));

  bot.command("add_user", adminOnly(async (ctx) => {
    await ctx.conversation.enter("addUserConversation");
  }));

  bot.command("stop_user", adminOnly(async (ctx) => {
    await ctx.conversation.enter("stopUserConversation");
  }));

  bot.command("del_user", adminOnly(async (ctx) => {
    await ctx.conversation.enter("delUserConversation");
  }));

  bot.command("edit_user", adminOnly(async (ctx) => {
    await ctx.conversation.enter("editUserConversation");
  }));

  // Single-message commands
  bot.command("list", adminOnly(listCommand));
  bot.command("uu", adminOnly(uuCommand));
}

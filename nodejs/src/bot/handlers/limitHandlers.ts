/**
 * /limits — 管理員權限管理指令（分組 CRUD + 用戶/API Key 限制設定）
 * /my_limits — 用戶查看自己的有效限制和用量
 */

import { Bot, Context } from "grammy";
import { webButton } from "./webHandlers.js";
import {
  type ConversationFlavor,
  type Conversation,
  createConversation,
} from "@grammyjs/conversations";
import {
  getUserGroups,
  addUserGroup,
  updateUserGroup,
  deleteUserGroup,
  getUsers,
  getUserWithLimits,
  setUserGroup,
  setUserOverrides,
  getKeysByUser,
  getApiKeyWithLimits,
  setApiKeyOverrides,
  getEffectiveLimits,
  getDailyUsage,
  getMonthlyUsage,
  isExpired,
  getUserByTgId,
} from "../../db/database.js";
import { isAdmin, isTrustedUser } from "../filters.js";

// ========================
// 型別定義
// ========================

type MyContext = Context & ConversationFlavor;
type MyConversation = Conversation<MyContext>;

// ========================
// 輔助函數
// ========================

function formatLimit(value: number): string {
  return value === 0 ? "∞ (無限制)" : String(value);
}

function formatExpiry(expiresAt: string | null): string {
  if (!expiresAt) return "永不過期";
  if (isExpired(expiresAt)) return `❌ 已過期 (${expiresAt})`;
  return expiresAt;
}

function formatCost(value: number): string {
  return `$${value.toFixed(4)}`;
}

/** 將 "inherit" / 空字串 / "-" 轉為 null，數字字串轉為數字 */
function parseOverride(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed === "" || trimmed === "-" || trimmed.toLowerCase() === "inherit" || trimmed.toLowerCase() === "繼承") {
    return null;
  }
  const num = parseInt(trimmed, 10);
  return isNaN(num) ? null : num;
}

/** 顯示有效限制的文字 */
function effectiveLimitsText(limits: ReturnType<typeof getEffectiveLimits>): string {
  const lines: string[] = [];
  lines.push(`📊 **有效限制**`);
  lines.push(`  RPM: ${formatLimit(limits.rpm)}`);
  lines.push(`  TPM: ${formatLimit(limits.tpm)}`);
  lines.push(`  並發: ${formatLimit(limits.concurrency)}`);
  lines.push(`  日 Token: ${formatLimit(limits.dailyTokenLimit)}`);
  lines.push(`  月 Token: ${formatLimit(limits.monthlyTokenLimit)}`);
  lines.push(`  日費用: ${limits.dailyCostLimit === 0 ? "∞ (無限制)" : formatCost(limits.dailyCostLimit)}`);
  lines.push(`  月費用: ${limits.monthlyCostLimit === 0 ? "∞ (無限制)" : formatCost(limits.monthlyCostLimit)}`);
  lines.push(`  過期: ${formatExpiry(limits.expiresAt)}`);
  return lines.join("\n");
}

// ========================
// 選單文字常量
// ========================

const LIMITS_MENU_TEXT =
  "⚙️ **權限管理**\n\n" +
  "1. 📋 分組管理\n" +
  "2. 👤 用戶限制設定\n" +
  "3. 🔑 API Key 限制設定\n" +
  "4. 📊 查看用戶有效限制\n\n" +
  "請輸入數字選擇操作，或 /cancel 取消：";

// ========================
// 子對話 1: 分組管理
// ========================

async function groupManagement(
  conversation: MyConversation,
  ctx: MyContext
): Promise<void> {
  const groups = await conversation.external(() => getUserGroups());

  let text = "📋 **分組列表**\n\n";
  for (const g of groups) {
    text +=
      `ID: ${g.id} | ${g.display_name} (${g.name})${g.is_default ? " [預設]" : ""}\n` +
      `  RPM: ${formatLimit(g.rpm_limit)}, TPM: ${formatLimit(g.tpm_limit)}, 並發: ${formatLimit(g.concurrency_limit)}\n` +
      `  日Token: ${formatLimit(g.daily_token_limit)}, 月Token: ${formatLimit(g.monthly_token_limit)}\n` +
      `  日費用: ${g.daily_cost_limit === 0 ? "∞" : formatCost(g.daily_cost_limit)}, 月費用: ${g.monthly_cost_limit === 0 ? "∞" : formatCost(g.monthly_cost_limit)}\n\n`;
  }
  text +=
    "操作：\n" +
    "1. 新增分組\n" +
    "2. 編輯分組\n" +
    "3. 刪除分組\n\n" +
    "輸入數字或 /back 返回主選單：";

  await ctx.reply(text);
  const resp = await conversation.wait();
  const input = resp.message?.text?.trim();

  if (!input || input === "/cancel" || input === "/back") return;

  if (input === "1") {
    await createGroupFlow(conversation, ctx);
  } else if (input === "2") {
    await editGroupFlow(conversation, ctx);
  } else if (input === "3") {
    await deleteGroupFlow(conversation, ctx);
  }
}

async function createGroupFlow(
  conversation: MyConversation,
  ctx: MyContext
): Promise<void> {
  // 名稱
  await ctx.reply("輸入分組名稱（英文識別碼，如 free / pro / vip）：");
  let r = await conversation.wait();
  const name = r.message?.text?.trim();
  if (!name || name === "/cancel") return;

  // 顯示名稱
  await ctx.reply("輸入顯示名稱（如：免費版 / 專業版）：");
  r = await conversation.wait();
  const displayName = r.message?.text?.trim() || name;

  // RPM
  await ctx.reply("RPM 上限（0=無限制）：");
  r = await conversation.wait();
  const rpm = parseInt(r.message?.text?.trim() || "0", 10) || 0;

  // TPM
  await ctx.reply("TPM 上限（0=無限制）：");
  r = await conversation.wait();
  const tpm = parseInt(r.message?.text?.trim() || "0", 10) || 0;

  // 並發
  await ctx.reply("並發上限（0=無限制）：");
  r = await conversation.wait();
  const concurrency = parseInt(r.message?.text?.trim() || "0", 10) || 0;

  // 日 Token
  await ctx.reply("每日 Token 上限（0=無限制）：");
  r = await conversation.wait();
  const dailyToken = parseInt(r.message?.text?.trim() || "0", 10) || 0;

  // 月 Token
  await ctx.reply("每月 Token 上限（0=無限制）：");
  r = await conversation.wait();
  const monthlyToken = parseInt(r.message?.text?.trim() || "0", 10) || 0;

  // 日費用
  await ctx.reply("每日費用上限 USD（0=無限制）：");
  r = await conversation.wait();
  const dailyCost = parseFloat(r.message?.text?.trim() || "0") || 0;

  // 月費用
  await ctx.reply("每月費用上限 USD（0=無限制）：");
  r = await conversation.wait();
  const monthlyCost = parseFloat(r.message?.text?.trim() || "0") || 0;

  try {
    await conversation.external(() =>
      addUserGroup({
        name,
        display_name: displayName,
        rpm_limit: rpm,
        tpm_limit: tpm,
        concurrency_limit: concurrency,
        daily_token_limit: dailyToken,
        monthly_token_limit: monthlyToken,
        daily_cost_limit: dailyCost,
        monthly_cost_limit: monthlyCost,
        })
    );
    await ctx.reply(`✅ 分組「${displayName}」已建立！`);
  } catch (err: any) {
    await ctx.reply(`❌ 建立失敗：${err.message}`);
  }
}

async function editGroupFlow(
  conversation: MyConversation,
  ctx: MyContext
): Promise<void> {
  const groups = await conversation.external(() => getUserGroups());
  let text = "選擇要編輯的分組 ID：\n\n";
  for (const g of groups) {
    text += `${g.id}. ${g.display_name} (${g.name})${g.is_default ? " [預設]" : ""}\n`;
  }
  await ctx.reply(text);

  const r = await conversation.wait();
  const groupId = parseInt(r.message?.text?.trim() || "0", 10);
  if (!groupId) return;

  const group = groups.find((g) => g.id === groupId);
  if (!group) {
    await ctx.reply("❌ 找不到此分組 ID");
    return;
  }

  await ctx.reply(
    `編輯「${group.display_name}」，逐項輸入新值（直接 Enter 保持原值）：\n\n` +
    `目前 RPM: ${formatLimit(group.rpm_limit)}\n新 RPM（Enter 保持）：`
  );
  let resp = await conversation.wait();
  const rpm = resp.message?.text?.trim();
  if (rpm === "/cancel") return;

  await ctx.reply(`目前 TPM: ${formatLimit(group.tpm_limit)}\n新 TPM（Enter 保持）：`);
  resp = await conversation.wait();
  const tpm = resp.message?.text?.trim();
  if (tpm === "/cancel") return;

  await ctx.reply(`目前並發: ${formatLimit(group.concurrency_limit)}\n新並發（Enter 保持）：`);
  resp = await conversation.wait();
  const concurrency = resp.message?.text?.trim();
  if (concurrency === "/cancel") return;

  await ctx.reply(`目前日 Token: ${formatLimit(group.daily_token_limit)}\n新日 Token（Enter 保持）：`);
  resp = await conversation.wait();
  const dailyToken = resp.message?.text?.trim();
  if (dailyToken === "/cancel") return;

  await ctx.reply(`目前月 Token: ${formatLimit(group.monthly_token_limit)}\n新月 Token（Enter 保持）：`);
  resp = await conversation.wait();
  const monthlyToken = resp.message?.text?.trim();
  if (monthlyToken === "/cancel") return;

  await ctx.reply(`目前日費用: ${group.daily_cost_limit === 0 ? "∞" : formatCost(group.daily_cost_limit)}\n新日費用 USD（Enter 保持）：`);
  resp = await conversation.wait();
  const dailyCost = resp.message?.text?.trim();
  if (dailyCost === "/cancel") return;

  await ctx.reply(`目前月費用: ${group.monthly_cost_limit === 0 ? "∞" : formatCost(group.monthly_cost_limit)}\n新月費用 USD（Enter 保持）：`);
  resp = await conversation.wait();
  const monthlyCost = resp.message?.text?.trim();
  if (monthlyCost === "/cancel") return;

  const updates: Record<string, number> = {};
  if (rpm) updates.rpm_limit = parseInt(rpm, 10) || 0;
  if (tpm) updates.tpm_limit = parseInt(tpm, 10) || 0;
  if (concurrency) updates.concurrency_limit = parseInt(concurrency, 10) || 0;
  if (dailyToken) updates.daily_token_limit = parseInt(dailyToken, 10) || 0;
  if (monthlyToken) updates.monthly_token_limit = parseInt(monthlyToken, 10) || 0;
  if (dailyCost) updates.daily_cost_limit = parseFloat(dailyCost) || 0;
  if (monthlyCost) updates.monthly_cost_limit = parseFloat(monthlyCost) || 0;

  try {
    await conversation.external(() => updateUserGroup(groupId, updates));
    await ctx.reply(`✅ 分組「${group.display_name}」已更新！`);
  } catch (err: any) {
    await ctx.reply(`❌ 更新失敗：${err.message}`);
  }
}

async function deleteGroupFlow(
  conversation: MyConversation,
  ctx: MyContext
): Promise<void> {
  const groups = await conversation.external(() =>
    getUserGroups().filter((g) => !g.is_default)
  );

  if (groups.length === 0) {
    await ctx.reply("沒有可刪除的分組（預設分組不可刪除）。");
    return;
  }

  let text = "選擇要刪除的分組 ID（用戶會被移回預設分組）：\n\n";
  for (const g of groups) {
    text += `${g.id}. ${g.display_name} (${g.name})\n`;
  }
  await ctx.reply(text);

  const r = await conversation.wait();
  const groupId = parseInt(r.message?.text?.trim() || "0", 10);
  if (!groupId) return;

  const group = groups.find((g) => g.id === groupId);
  if (!group) {
    await ctx.reply("❌ 找不到此分組 ID");
    return;
  }

  await ctx.reply(`確認刪除「${group.display_name}」？(yes/no)`);
  const confirm = await conversation.wait();
  if (confirm.message?.text?.trim().toLowerCase() !== "yes") {
    await ctx.reply("已取消。");
    return;
  }

  try {
    await conversation.external(() => deleteUserGroup(groupId));
    await ctx.reply(`✅ 分組「${group.display_name}」已刪除！`);
  } catch (err: any) {
    await ctx.reply(`❌ 刪除失敗：${err.message}`);
  }
}

// ========================
// 子對話 2: 用戶限制設定
// ========================

async function userLimitsSetting(
  conversation: MyConversation,
  ctx: MyContext
): Promise<void> {
  const users = await conversation.external(() => getUsers());

  if (users.length === 0) {
    await ctx.reply("沒有用戶。");
    return;
  }

  let text = "選擇用戶 ID：\n\n";
  for (const u of users) {
    text += `${u.id}. ${u.username || "?"} (TG: ${u.tg_user_id})${Number(u.is_active) === 1 ? "" : " [停用]"}\n`;
  }
  text += "\n輸入用戶 ID：";
  await ctx.reply(text);

  const r = await conversation.wait();
  const userId = r.message?.text?.trim();
  if (!userId || userId === "/cancel") return;

  const user = await conversation.external(() => getUserWithLimits(parseInt(userId, 10)));
  if (!user) {
    await ctx.reply("❌ 找不到此用戶");
    return;
  }

  const groups = await conversation.external(() => getUserGroups());
  let groupText = `目前分組: ${user.group_id ? (groups.find(g => g.id === user.group_id)?.display_name || "?") : "未設定"}\n\n可選分組：\n`;
  for (const g of groups) {
    groupText += `${g.id}. ${g.display_name}${g.is_default ? " [預設]" : ""}\n`;
  }
  groupText += "\n選擇操作：\n1. 設定分組\n2. 設定過期時間\n3. 設定限制覆寫\n輸入數字或 /back：";
  await ctx.reply(groupText);

  const r2 = await conversation.wait();
  const action = r2.message?.text?.trim();
  if (!action || action === "/cancel" || action === "/back") return;

  if (action === "1") {
    // 設定分組
    await ctx.reply("輸入分組 ID：");
    const r3 = await conversation.wait();
    const groupId = parseInt(r3.message?.text?.trim() || "0", 10);
    if (!groupId) return;

    try {
      await conversation.external(() => setUserGroup(parseInt(userId, 10), groupId));
      await ctx.reply(`✅ 已將用戶 ${userId} 設定為分組 ${groupId}`);
    } catch (err: any) {
      await ctx.reply(`❌ 設定失敗：${err.message}`);
    }
  } else if (action === "2") {
    // 設定過期時間
    await ctx.reply(
      "輸入過期時間（格式 YYYY-MM-DD），或輸入 'clear' 清除過期："
    );
    const r3 = await conversation.wait();
    const dateInput = r3.message?.text?.trim();
    if (!dateInput || dateInput === "/cancel") return;

    let expiresAt: string | null = null;
    if (dateInput.toLowerCase() !== "clear") {
      expiresAt = dateInput;
    }

    try {
      await conversation.external(() =>
        setUserOverrides(parseInt(userId, 10), { expires_at: expiresAt })
      );
      await ctx.reply(`✅ 過期時間已${expiresAt ? `設定為 ${expiresAt}` : "清除"}`);
    } catch (err: any) {
      await ctx.reply(`❌ 設定失敗：${err.message}`);
    }
  } else if (action === "3") {
    // 設定限制覆寫
    await ctx.reply(
      "逐項輸入覆寫值（輸入 - 或 inherit 表示繼承分組設定，0 表示無限制）：\n\n" +
      `目前 RPM 覆寫: ${user.rpm_override === null ? "繼承" : formatLimit(user.rpm_override)}\n新 RPM（- = 繼承）：`
    );
    let resp = await conversation.wait();
    const rpm = parseOverride(resp.message?.text || "inherit");
    if (resp.message?.text?.trim() === "/cancel") return;

    await ctx.reply(`目前 TPM 覆寫: ${user.tpm_override === null ? "繼承" : formatLimit(user.tpm_override)}\n新 TPM（- = 繼承）：`);
    resp = await conversation.wait();
    const tpm = parseOverride(resp.message?.text || "inherit");
    if (resp.message?.text?.trim() === "/cancel") return;

    await ctx.reply(`目前並發覆寫: ${user.concurrency_override === null ? "繼承" : formatLimit(user.concurrency_override)}\n新並發（- = 繼承）：`);
    resp = await conversation.wait();
    const concurrency = parseOverride(resp.message?.text || "inherit");
    if (resp.message?.text?.trim() === "/cancel") return;

    await ctx.reply(`目前日Token覆寫: ${user.daily_token_override === null ? "繼承" : formatLimit(user.daily_token_override)}\n新日Token（- = 繼承）：`);
    resp = await conversation.wait();
    const dailyToken = parseOverride(resp.message?.text || "inherit");
    if (resp.message?.text?.trim() === "/cancel") return;

    await ctx.reply(`目前月Token覆寫: ${user.monthly_token_override === null ? "繼承" : formatLimit(user.monthly_token_override)}\n新月Token（- = 繼承）：`);
    resp = await conversation.wait();
    const monthlyToken = parseOverride(resp.message?.text || "inherit");
    if (resp.message?.text?.trim() === "/cancel") return;

    try {
      await conversation.external(() =>
        setUserOverrides(parseInt(userId, 10), {
          rpm_override: rpm,
          tpm_override: tpm,
          concurrency_override: concurrency,
          daily_token_override: dailyToken,
          monthly_token_override: monthlyToken,
        })
      );
      await ctx.reply(`✅ 用戶 ${userId} 限制覆寫已更新！`);
    } catch (err: any) {
      await ctx.reply(`❌ 設定失敗：${err.message}`);
    }
  }
}

// ========================
// 子對話 3: API Key 限制設定
// ========================

async function apiKeyLimitsSetting(
  conversation: MyConversation,
  ctx: MyContext
): Promise<void> {
  const users = await conversation.external(() => getUsers());

  if (users.length === 0) {
    await ctx.reply("沒有用戶。");
    return;
  }

  let text = "選擇用戶 ID：\n\n";
  for (const u of users) {
    text += `${u.id}. ${u.username || "?"} (TG: ${u.tg_user_id})\n`;
  }
  text += "\n輸入用戶 ID：";
  await ctx.reply(text);

  const r = await conversation.wait();
  const userId = r.message?.text?.trim();
  if (!userId || userId === "/cancel") return;

  const keys = await conversation.external(() => getKeysByUser(parseInt(userId, 10)));

  if (keys.length === 0) {
    await ctx.reply("此用戶沒有 API Key。");
    return;
  }

  let keyText = "選擇 API Key：\n\n";
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    keyText += `${k.id}. ${k.key.substring(0, 20)}...${Number(k.is_active) === 1 ? "" : " [停用]"}\n`;
  }
  keyText += "\n輸入 Key ID：";
  await ctx.reply(keyText);

  const r2 = await conversation.wait();
  const keyId = parseInt(r2.message?.text?.trim() || "0", 10);
  if (!keyId) return;

  const key = keys.find((k) => k.id === keyId);
  if (!key) {
    await ctx.reply("❌ 找不到此 Key ID");
    return;
  }

  const keyWithLimits = await conversation.external(() => getApiKeyWithLimits(keyId));
  if (!keyWithLimits) {
    await ctx.reply("❌ 無法取得 Key 資訊");
    return;
  }

  await ctx.reply(
    "選擇操作：\n1. 設定過期時間\n2. 設定限制覆寫\n輸入數字或 /back："
  );
  const r3 = await conversation.wait();
  const action = r3.message?.text?.trim();
  if (!action || action === "/cancel" || action === "/back") return;

  if (action === "1") {
    await ctx.reply("輸入過期時間（YYYY-MM-DD），或 'clear' 清除：");
    const r4 = await conversation.wait();
    const dateInput = r4.message?.text?.trim();
    if (!dateInput || dateInput === "/cancel") return;

    let expiresAt: string | null = null;
    if (dateInput.toLowerCase() !== "clear") {
      expiresAt = dateInput;
    }

    try {
      await conversation.external(() =>
        setApiKeyOverrides(keyId, { expires_at: expiresAt })
      );
      await ctx.reply(`✅ Key ${keyId} 過期時間已${expiresAt ? `設定為 ${expiresAt}` : "清除"}`);
    } catch (err: any) {
      await ctx.reply(`❌ 設定失敗：${err.message}`);
    }
  } else if (action === "2") {
    await ctx.reply(
      `目前 RPM 覆寫: ${keyWithLimits.rpm_override === null ? "繼承" : formatLimit(keyWithLimits.rpm_override)}\n新 RPM（- = 繼承）：`
    );
    let resp = await conversation.wait();
    const rpm = parseOverride(resp.message?.text || "inherit");
    if (resp.message?.text?.trim() === "/cancel") return;

    await ctx.reply(`目前 TPM 覆寫: ${keyWithLimits.tpm_override === null ? "繼承" : formatLimit(keyWithLimits.tpm_override)}\n新 TPM（- = 繼承）：`);
    resp = await conversation.wait();
    const tpm = parseOverride(resp.message?.text || "inherit");
    if (resp.message?.text?.trim() === "/cancel") return;

    await ctx.reply(`目前並發覆寫: ${keyWithLimits.concurrency_override === null ? "繼承" : formatLimit(keyWithLimits.concurrency_override)}\n新並發（- = 繼承）：`);
    resp = await conversation.wait();
    const concurrency = parseOverride(resp.message?.text || "inherit");
    if (resp.message?.text?.trim() === "/cancel") return;

    try {
      await conversation.external(() =>
        setApiKeyOverrides(keyId, {
          rpm_override: rpm,
          tpm_override: tpm,
          concurrency_override: concurrency,
        })
      );
      await ctx.reply(`✅ Key ${keyId} 限制覆寫已更新！`);
    } catch (err: any) {
      await ctx.reply(`❌ 設定失敗：${err.message}`);
    }
  }
}

// ========================
// 子對話 4: 查看用戶有效限制
// ========================

async function viewUserLimits(
  conversation: MyConversation,
  ctx: MyContext
): Promise<void> {
  const users = await conversation.external(() => getUsers());

  if (users.length === 0) {
    await ctx.reply("沒有用戶。");
    return;
  }

  let text = "選擇用戶 ID：\n\n";
  for (const u of users) {
    text += `${u.id}. ${u.username || "?"} (TG: ${u.tg_user_id})\n`;
  }
  text += "\n輸入用戶 ID：";
  await ctx.reply(text);

  const r = await conversation.wait();
  const userId = r.message?.text?.trim();
  if (!userId || userId === "/cancel") return;

  const user = await conversation.external(() => getUserByTgId(parseInt(r.message!.text!.trim(), 10)));
  // Fallback: might have entered internal user ID instead of TG ID
  let internalUserId = parseInt(userId, 10);
  const userWithLimits = await conversation.external(() => getUserWithLimits(internalUserId));

  if (!userWithLimits) {
    await ctx.reply("❌ 找不到此用戶");
    return;
  }

  // Show user-level limits
  const userLimits = await conversation.external(() =>
    getEffectiveLimits(internalUserId, null)
  );

  const dailyUsage = await conversation.external(() =>
    getDailyUsage(internalUserId)
  );
  const monthlyUsage = await conversation.external(() =>
    getMonthlyUsage(internalUserId)
  );

  let text2 = `👤 用戶 ${userWithLimits.username || "?"} (ID: ${internalUserId})\n\n`;
  text2 += effectiveLimitsText(userLimits);
  text2 += `\n\n📊 **今日用量**: ${dailyUsage.totalTokens} tokens, ${formatCost(dailyUsage.totalCost)}`;
  text2 += `\n📊 **本月用量**: ${monthlyUsage.totalTokens} tokens, ${formatCost(monthlyUsage.totalCost)}`;

  // Show per-key limits
  const keys = await conversation.external(() => getKeysByUser(internalUserId));
  if (keys.length > 0) {
    text2 += "\n\n🔑 **API Keys 有效限制：**\n";
    for (const k of keys) {
      const keyLimits = await conversation.external(() =>
        getEffectiveLimits(internalUserId, k.id)
      );
      text2 += `\nKey #${k.id} (${k.key.substring(0, 15)}...):\n`;
      text2 += `  RPM: ${formatLimit(keyLimits.rpm)}, 並發: ${formatLimit(keyLimits.concurrency)}\n`;
      text2 += `  過期: ${formatExpiry(keyLimits.expiresAt)}\n`;
    }
  }

  await ctx.reply(text2);
}

// ========================
// /limits 主對話
// ========================

async function limitsConversation(
  conversation: MyConversation,
  ctx: MyContext
): Promise<void> {
  await ctx.reply(LIMITS_MENU_TEXT, {
    reply_markup: webButton(ctx.from!.id, "groups"),
  });

  const r = await conversation.wait();
  const input = r.message?.text?.trim();

  if (!input || input === "/cancel") return;

  switch (input) {
    case "1":
      await groupManagement(conversation, ctx);
      break;
    case "2":
      await userLimitsSetting(conversation, ctx);
      break;
    case "3":
      await apiKeyLimitsSetting(conversation, ctx);
      break;
    case "4":
      await viewUserLimits(conversation, ctx);
      break;
    default:
      await ctx.reply("❌ 無效選項");
  }
}

// ========================
// /my_limits 用戶指令
// ========================

async function handleMyLimits(ctx: MyContext): Promise<void> {
  const tgId = ctx.from?.id;
  if (!tgId) return;

  const user = getUserByTgId(tgId);
  if (!user) {
    await ctx.reply("❌ 找不到你的用戶資料");
    return;
  }

  const userId = Number(user.id);
  const userLimits = getEffectiveLimits(userId, null);
  const dailyUsage = getDailyUsage(userId);
  const monthlyUsage = getMonthlyUsage(userId);

  let text = `📊 **我的限制**\n\n`;
  text += effectiveLimitsText(userLimits);
  text += `\n\n📈 **今日用量**: ${dailyUsage.totalTokens} tokens, ${formatCost(dailyUsage.totalCost)}`;
  text += `\n📈 **本月用量**: ${monthlyUsage.totalTokens} tokens, ${formatCost(monthlyUsage.totalCost)}`;

  const keys = getKeysByUser(userId);
  if (keys.length > 0) {
    text += "\n\n🔑 **API Keys：**\n";
    for (const k of keys) {
      const keyLimits = getEffectiveLimits(userId, k.id);
      const keyDaily = getDailyUsage(userId, k.id);
      text += `\nKey #${k.id} (${k.key.substring(0, 15)}...):\n`;
      text += `  RPM: ${formatLimit(keyLimits.rpm)}, 並發: ${formatLimit(keyLimits.concurrency)}\n`;
      text += `  過期: ${formatExpiry(keyLimits.expiresAt)}\n`;
      text += `  今日: ${keyDaily.totalTokens} tokens, ${formatCost(keyDaily.totalCost)}\n`;
    }
  }

  await ctx.reply(text, { reply_markup: webButton(tgId, "limits") });
}

// ========================
// 註冊
// ========================

export function registerLimitHandlers(bot: Bot<MyContext>): void {
  // Register conversation
  bot.use(createConversation(limitsConversation, "limits"));

  // /limits — admin only
  bot.command("limits", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.conversation.enter("limits");
  });

  // /my_limits — any trusted user
  bot.command("my_limits", async (ctx) => {
    if (!isTrustedUser(ctx)) return;
    await handleMyLimits(ctx);
  });
}

import type { Context } from "grammy";
import { config } from "../config.js";
import { getUserByTgId } from "../db/database.js";

/**
 * 檢查是否為管理員
 */
export function isAdmin(ctx: Context): boolean {
  return ctx.from?.id === config.ADMIN_ID;
}

/**
 * 檢查是否為信任使用者（DB 中存在且 is_active，管理員永遠是信任的）
 */
export function isTrustedUser(ctx: Context): boolean {
  if (isAdmin(ctx)) return true;

  const tgId = ctx.from?.id;
  if (!tgId) return false;

  const user = getUserByTgId(tgId);
  return user !== undefined && Number(user.is_active) === 1;
}

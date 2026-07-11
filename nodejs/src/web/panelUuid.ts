/**
 * Web Panel UUID 管理（共用模組）
 *
 * 管理存於 DB settings 中的 web_panel_uuid，用於 /{uuid}/web 認證入口。
 * 首次生成後永不變更，除非管理員呼叫 regenerateWebPanelUuid()。
 *
 * 此模組同時被 server.ts（panel path 中間件）和 routes.ts（API 路由）使用，
 * 確保兩處共用同一份記憶體快取，避免不一致。
 */

import crypto from "crypto";
import { getSetting, setSetting } from "../db/database.js";
import { config } from "../config.js";

let _cache: string | null = null;

/**
 * 取得 Web Panel UUID。
 * 若 DB 中尚無記錄，生成一個 crypto.randomUUID() 並存入 DB。
 * 後續呼叫直接返回記憶體快取。
 */
export async function getOrCreateWebPanelUuid(): Promise<string> {
  if (_cache) return _cache;
  const existing = await getSetting("web_panel_uuid");
  if (existing) {
    _cache = existing;
    return existing;
  }
  const uuid = crypto.randomUUID();
  await setSetting("web_panel_uuid", uuid);
  _cache = uuid;
  return uuid;
}

/**
 * 取得 panel path（/{uuid}/web）。
 * 未設定 LOGIN_WEB_PATH 時返回 null（傳統模式不需要 UUID）。
 */
export async function getPanelPath(): Promise<string | null> {
  if (!config.LOGIN_WEB_PATH) return null;
  const uuid = await getOrCreateWebPanelUuid();
  return `/${uuid}/web`;
}

/**
 * 重新生成 UUID 並更新 DB + 快取。
 * 舊的 /{old-uuid}/web 路徑立即失效。
 *
 * @returns 新的 panel path（/{new-uuid}/web），或 null（未設定 LOGIN_WEB_PATH）
 */
export async function regenerateWebPanelUuid(): Promise<string | null> {
  if (!config.LOGIN_WEB_PATH) return null;
  const uuid = crypto.randomUUID();
  await setSetting("web_panel_uuid", uuid);
  _cache = uuid;
  return `/${uuid}/web`;
}

/**
 * 清除記憶體快取，下次呼叫 getOrCreateWebPanelUuid 會重新從 DB 讀取。
 * 用於 backup/restore 後確保快取與 DB 一致。
 */
export function invalidatePanelUuidCache(): void {
  _cache = null;
}

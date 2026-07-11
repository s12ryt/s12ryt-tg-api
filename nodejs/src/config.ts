import dotenv from "dotenv";
import { getConfiguredMemoryMB } from "./memory.js";
dotenv.config();

/** Web 面板認證模式。telegram = OTP 連結登入（預設）；password = 帳密獨立登入。 */
export type WebAuthMode = "telegram" | "password";

export interface Config {
  BOT_TOKEN: string;
  ADMIN_ID: number | null;
  API_PORT: number;
  DATABASE_PATH: string;
  DEFAULT_API_URL: string;
  NODEJS_PLUGIN_PATHS: string[];
  MEMORY_LIMIT_MB: number | null;
  CLOUDFLARE_TUNNEL: string;
  CLOUDFLARE_TOKEN: string;
  GITHUB_MIRROR: string;
  NPM_REGISTRY: string;
  /** Web 面板認證模式。 */
  WEB_AUTH_MODE: WebAuthMode;
  /** 自定義 Web 登入路徑（防爬蟲別名），空字串表示不啟用。 */
  LOGIN_WEB_PATH: string;
}

function parseListEnv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[;,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseWebAuthMode(): WebAuthMode {
  const raw = (process.env.WEB_AUTH_MODE ?? "telegram").trim().toLowerCase();
  if (raw === "password") return "password";
  if (raw === "telegram") return "telegram";
  throw new Error(
    `Invalid WEB_AUTH_MODE "${raw}": must be "telegram" or "password".`,
  );
}

function parseLoginWebPath(): string {
  const raw = (process.env.LOGIN_WEB_PATH ?? "").trim();
  if (!raw) return "";
  // 確保以 / 開頭，去掉尾部 /
  const normalized = ("/" + raw.replace(/^\/+|\/+$/g, "")).replace(/^\/+/, "/");
  // /web 是前端靜態檔案和 API 路由的掛載點，不能用作自定義登入路徑
  if (normalized === "/web") {
    throw new Error(
      `Invalid LOGIN_WEB_PATH "${raw}": must not be "/web" (reserved for static files and API routes).`,
    );
  }
  return normalized;
}

export const config: Config = {
  BOT_TOKEN: process.env.BOT_TOKEN ?? "",
  ADMIN_ID: process.env.ADMIN_ID
    ? parseInt(process.env.ADMIN_ID, 10)
    : null,
  API_PORT: parseInt(process.env.API_PORT ?? "8000", 10),
  DATABASE_PATH: process.env.DATABASE_PATH ?? "./data/bot.db",
  DEFAULT_API_URL: process.env.DEFAULT_API_URL ?? "http://localhost:8000",
  NODEJS_PLUGIN_PATHS: parseListEnv(process.env.NODEJS_PLUGIN_PATHS),
  MEMORY_LIMIT_MB: getConfiguredMemoryMB(),
  CLOUDFLARE_TUNNEL: process.env.CLOUDFLARE_TUNNEL ?? "",
  CLOUDFLARE_TOKEN: process.env.CLOUDFLARE_TOKEN ?? "",
  GITHUB_MIRROR: process.env.GITHUB_MIRROR ?? "",
  NPM_REGISTRY: process.env.NPM_REGISTRY ?? "",
  WEB_AUTH_MODE: parseWebAuthMode(),
  LOGIN_WEB_PATH: parseLoginWebPath(),
};

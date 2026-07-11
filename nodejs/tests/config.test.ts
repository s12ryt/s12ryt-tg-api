/**
 * Unit tests for src/config.ts
 *
 * Strategy:
 * - config.ts reads env vars at module load time via dotenv.
 * - We mock dotenv to prevent loading the real .env file,
 *   then control process.env manually for each test.
 * - vi.resetModules() + dynamic import() isolates each test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock dotenv so config.ts doesn't load the real .env file
vi.mock("dotenv", () => ({
  default: { config: () => {} },
}));

describe("Config", () => {
  beforeEach(() => {
    // Delete the env vars that config.ts reads
    delete process.env.BOT_TOKEN;
    delete process.env.ADMIN_ID;
    delete process.env.API_PORT;
    delete process.env.DATABASE_PATH;
    delete process.env.DEFAULT_API_URL;
    delete process.env.memory;
    delete process.env.MAX_OLD_SPACE;
    delete process.env.WEB_AUTH_MODE;
    delete process.env.LOGIN_WEB_PATH;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("should default BOT_TOKEN to empty string when not set", async () => {
    // Only set ADMIN_ID, not BOT_TOKEN
    process.env.ADMIN_ID = "123456";

    const { config } = await import("../src/config.js");
    expect(config.BOT_TOKEN).toBe("");
  });

  it("should default ADMIN_ID to null when not set", async () => {
    // Only set BOT_TOKEN, not ADMIN_ID
    process.env.BOT_TOKEN = "test-token-123";

    const { config } = await import("../src/config.js");
    expect(config.ADMIN_ID).toBeNull();
  });

  it("should create config with required and default values", async () => {
    process.env.BOT_TOKEN = "my-bot-token";
    process.env.ADMIN_ID = "789";

    const { config } = await import("../src/config.js");

    expect(config.BOT_TOKEN).toBe("my-bot-token");
    expect(config.ADMIN_ID).toBe(789);
    expect(config.API_PORT).toBe(8000);
    expect(config.DATABASE_PATH).toBe("./data/bot.db");
    expect(config.DEFAULT_API_URL).toBe("http://localhost:8000");
    expect(config.MEMORY_LIMIT_MB).toBeNull();
    expect(config.WEB_AUTH_MODE).toBe("telegram");
    expect(config.LOGIN_WEB_PATH).toBe("");
  });

  it("should use custom API_PORT from env", async () => {
    process.env.BOT_TOKEN = "tok";
    process.env.ADMIN_ID = "1";
    process.env.API_PORT = "3000";

    const { config } = await import("../src/config.js");

    expect(config.API_PORT).toBe(3000);
  });

  it("should use custom DATABASE_PATH from env", async () => {
    process.env.BOT_TOKEN = "tok";
    process.env.ADMIN_ID = "1";
    process.env.DATABASE_PATH = "/custom/path/db.sqlite";

    const { config } = await import("../src/config.js");

    expect(config.DATABASE_PATH).toBe("/custom/path/db.sqlite");
  });

  it("should use custom DEFAULT_API_URL from env", async () => {
    process.env.BOT_TOKEN = "tok";
    process.env.ADMIN_ID = "1";
    process.env.DEFAULT_API_URL = "https://api.example.com";

    const { config } = await import("../src/config.js");

    expect(config.DEFAULT_API_URL).toBe("https://api.example.com");
  });

  it("should parse ADMIN_ID as integer", async () => {
    process.env.BOT_TOKEN = "tok";
    process.env.ADMIN_ID = "42";

    const { config } = await import("../src/config.js");

    expect(config.ADMIN_ID).toBe(42);
    expect(typeof config.ADMIN_ID).toBe("number");
  });

  it("should expose memory limit from lowercase memory env", async () => {
    process.env.BOT_TOKEN = "tok";
    process.env.ADMIN_ID = "1";
    process.env.memory = "256.5";

    const { config } = await import("../src/config.js");

    expect(config.MEMORY_LIMIT_MB).toBe(256);
  });

  it("should fall back to MAX_OLD_SPACE when memory is invalid", async () => {
    process.env.BOT_TOKEN = "tok";
    process.env.ADMIN_ID = "1";
    process.env.memory = "128.55";
    process.env.MAX_OLD_SPACE = "384";

    const { config } = await import("../src/config.js");

    expect(config.MEMORY_LIMIT_MB).toBe(384);
  });

  it("should return null for invalid memory values without fallback", async () => {
    process.env.BOT_TOKEN = "tok";
    process.env.ADMIN_ID = "1";
    process.env.memory = "128mb";

    const { config } = await import("../src/config.js");

    expect(config.MEMORY_LIMIT_MB).toBeNull();
  });

  it("should accept WEB_AUTH_MODE=password", async () => {
    process.env.BOT_TOKEN = "tok";
    process.env.ADMIN_ID = "1";
    process.env.WEB_AUTH_MODE = "password";

    const { config } = await import("../src/config.js");
    expect(config.WEB_AUTH_MODE).toBe("password");
  });

  it("should accept WEB_AUTH_MODE case-insensitively", async () => {
    process.env.BOT_TOKEN = "tok";
    process.env.ADMIN_ID = "1";
    process.env.WEB_AUTH_MODE = "PASSWORD";

    const { config } = await import("../src/config.js");
    expect(config.WEB_AUTH_MODE).toBe("password");
  });

  it("should throw on invalid WEB_AUTH_MODE", async () => {
    process.env.BOT_TOKEN = "tok";
    process.env.ADMIN_ID = "1";
    process.env.WEB_AUTH_MODE = "invalid";

    await expect(import("../src/config.js")).rejects.toThrow(
      "Invalid WEB_AUTH_MODE"
    );
  });

  it("should normalize LOGIN_WEB_PATH with leading and trailing slashes", async () => {
    process.env.BOT_TOKEN = "tok";
    process.env.ADMIN_ID = "1";
    process.env.LOGIN_WEB_PATH = "///secret///";

    const { config } = await import("../src/config.js");
    expect(config.LOGIN_WEB_PATH).toBe("/secret");
  });

  it("should reject LOGIN_WEB_PATH=/web (reserved)", async () => {
    process.env.BOT_TOKEN = "tok";
    process.env.ADMIN_ID = "1";
    process.env.LOGIN_WEB_PATH = "/web";

    await expect(import("../src/config.js")).rejects.toThrow(
      'must not be "/web"'
    );
  });
});

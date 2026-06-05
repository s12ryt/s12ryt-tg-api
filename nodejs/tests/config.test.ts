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
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("should throw if BOT_TOKEN is missing", async () => {
    // Only set ADMIN_ID, not BOT_TOKEN
    process.env.ADMIN_ID = "123456";

    await expect(import("../src/config.js")).rejects.toThrow(
      "Missing required environment variable: BOT_TOKEN"
    );
  });

  it("should throw if ADMIN_ID is missing", async () => {
    // Only set BOT_TOKEN, not ADMIN_ID
    process.env.BOT_TOKEN = "test-token-123";

    await expect(import("../src/config.js")).rejects.toThrow(
      "Missing required environment variable: ADMIN_ID"
    );
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
});

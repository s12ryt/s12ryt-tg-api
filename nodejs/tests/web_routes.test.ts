/**
 * Integration tests for src/web/routes.ts
 *
 * Tests all web console API endpoints:
 *   - Auth: login, logout, me
 *   - User: models, keys (CRUD), usage, coding, limits, restrictions, url
 *   - Admin: version, check-update, update, restart, backups, rollback
 *   - Access control: 401 without session, 403 non-admin on admin routes
 *
 * Uses REAL auth.ts (tested in auth.test.ts) with mocked DB/updater.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import express from "express";
import request from "supertest";

// ===========================================================================
// Hoisted constants
// ===========================================================================

const { MOCK_ADMIN_ID } = vi.hoisted(() => ({
  MOCK_ADMIN_ID: 12345,
}));

// ===========================================================================
// Mock: config.js
// ===========================================================================

vi.mock("../src/config.js", () => ({
  config: {
    BOT_TOKEN: "test-token",
    ADMIN_ID: MOCK_ADMIN_ID,
    API_PORT: 8000,
    DATABASE_PATH: "./data/test.db",
    DEFAULT_API_URL: "http://localhost:8000",
  },
}));

// ===========================================================================
// Mock: database.js
// ===========================================================================

vi.mock("../src/db/database.js", () => ({
  // Providers
  getProviders: vi.fn(() => []),
  addProvider: vi.fn(),
  updateProvider: vi.fn(),
  deleteProvider: vi.fn(),
  getModelPricesByProvider: vi.fn(() => []),
  batchUpsertModelPrices: vi.fn(),
  cleanupModelPrices: vi.fn(),
  // Users
  getUsers: vi.fn(() => []),
  addUser: vi.fn(),
  getUserByTgId: vi.fn(() => undefined),
  getUserById: vi.fn(() => undefined),
  updateUserStatus: vi.fn(),
  deleteUser: vi.fn(),
  updateUserTgId: vi.fn(),
  // API Keys
  addApiKey: vi.fn(() => ({ key: "sk-s12ryt-newkey-1234567890" })),
  getKeysByUser: vi.fn(() => []),
  deleteApiKey: vi.fn(),
  // Usage
  getUsageByUser: vi.fn(() => []),
  getTotalUsage: vi.fn(() => []),
  getDailyUsage: vi.fn(() => ({ totalTokens: 0, totalCost: 0 })),
  getMonthlyUsage: vi.fn(() => ({ totalTokens: 0, totalCost: 0 })),
  // Coding
  getCodingConfigByTgId: vi.fn(() => null),
  setCodingConfig: vi.fn(() => ({ is_active: 1, fallback_models: "", max_retries: 3 })),
  // Model restrictions
  getModelRestrictionsForUser: vi.fn(() => []),
  setModelRestriction: vi.fn(),
  deleteModelRestriction: vi.fn(),
  // Limits
  getEffectiveLimits: vi.fn(() => ({
    rpm: 0, tpm: 0, concurrency: 0,
    dailyTokenLimit: 0, monthlyTokenLimit: 0,
    dailyCostLimit: 0, monthlyCostLimit: 0, expiresAt: 0,
  })),
  getUserWithLimits: vi.fn(),
  setUserGroup: vi.fn(),
  setUserOverrides: vi.fn(),
  getApiKeyWithLimits: vi.fn(),
  setApiKeyOverrides: vi.fn(),
  invalidateEffectiveLimitsCache: vi.fn(),
  // Groups
  getUserGroups: vi.fn(() => []),
  addUserGroup: vi.fn(),
  updateUserGroup: vi.fn(),
  deleteUserGroup: vi.fn(),
  getDefaultUserGroup: vi.fn(() => null),
  // Settings
  getSetting: vi.fn(() => null),
  setSetting: vi.fn(),
  // Cache
  getAllCachedModelNames: vi.fn(() => ["gpt-4o", "claude-3.5-sonnet"]),
}));

// ===========================================================================
// Mock: updater.js
// ===========================================================================

vi.mock("../src/updater.js", () => ({
  getCurrentVersion: vi.fn(() => ({
    hash: "abc1234",
    date: "2024-01-01T00:00:00+08:00",
    message: "test commit",
    tag: "v1.0.0",
  })),
  fetchAndCheckUpdate: vi.fn(async () => ({
    hasUpdate: false,
    current: { hash: "abc1234", date: "2024-01-01", message: "test", tag: "v1.0.0" },
    latestRelease: null,
    commitsBehind: 0,
    newCommits: [],
  })),
  performUpdate: vi.fn(async () => ({
    success: true,
    message: "Blue-Green 更新成功！",
    method: "blue-green" as const,
  })),
  restartProcess: vi.fn(),
  isWorkingDirClean: vi.fn(() => true),
  getBackupList: vi.fn(() => []),
  rollbackAndRestart: vi.fn(() => ({ success: true, message: "已回滾" })),
}));

// ===========================================================================
// Mock: keySelector.js
// ===========================================================================

vi.mock("../src/api/keySelector.js", () => ({
  parseApiKeys: vi.fn((raw: string) => {
    try { return JSON.parse(raw); } catch { return []; }
  }),
}));

// ===========================================================================
// Mock: modelFetcher.js
// ===========================================================================

vi.mock("../src/bot/handlers/modelFetcher.js", () => ({
  detectApiProtocols: vi.fn(async () => ({ supported: [], unsupported: [] })),
  detectProtocolsNoAuth: vi.fn(async () => ({ supported: [], unsupported: [] })),
  fetchProviderModels: vi.fn(async () => []),
  fetchModelsNoAuth: vi.fn(async () => []),
  fetchModelsPricing: vi.fn(async () => []),
}));

// ===========================================================================
// Import AFTER all mocks
// ===========================================================================

import router from "../src/web/routes.js";
import {
  generateLoginToken,
  exchangeToken,
  clearAllAuth,
  stopCleanupTimer,
} from "../src/web/auth.js";
import * as db from "../src/db/database.js";
import * as updater from "../src/updater.js";

// ===========================================================================
// Test app setup
// ===========================================================================

const app = express();
app.use(express.json());
app.use("/web", router);

afterAll(() => {
  stopCleanupTimer();
});

// ===========================================================================
// Helpers
// ===========================================================================

/** Get a valid admin session token */
function adminSession(): string {
  clearAllAuth();
  const otp = generateLoginToken(MOCK_ADMIN_ID);
  return exchangeToken(otp)!.sessionToken;
}

/** Get a valid non-admin user session token (requires getUserByTgId mock) */
function userSession(tgUserId = 99999): string {
  clearAllAuth();
  vi.mocked(db.getUserByTgId).mockReturnValue({
    id: 1, tg_user_id: tgUserId, username: "testuser", is_active: 1,
  });
  const otp = generateLoginToken(tgUserId);
  return exchangeToken(otp)!.sessionToken;
}

// ===========================================================================
// Auth Routes
// ===========================================================================

describe("Auth Routes", () => {
  beforeEach(() => {
    clearAllAuth();
    vi.mocked(db.getUserByTgId).mockReset();
    vi.mocked(db.getUserByTgId).mockReturnValue(undefined);
  });

  describe("POST /web/api/auth/login", () => {
    it("exchanges valid OTP for session", async () => {
      const otp = generateLoginToken(MOCK_ADMIN_ID);
      const res = await request(app)
        .post("/web/api/auth/login")
        .send({ token: otp });

      expect(res.status).toBe(200);
      expect(res.body.sessionToken).toBeTruthy();
      expect(res.body.tgUserId).toBe(MOCK_ADMIN_ID);
      expect(res.body.isAdmin).toBe(true);
    });

    it("returns 400 when token missing", async () => {
      const res = await request(app)
        .post("/web/api/auth/login")
        .send({});

      expect(res.status).toBe(400);
    });

    it("returns 401 for invalid token", async () => {
      const res = await request(app)
        .post("/web/api/auth/login")
        .send({ token: "invalid-otp" });

      expect(res.status).toBe(401);
    });

    it("returns 400 when token is not a string", async () => {
      const res = await request(app)
        .post("/web/api/auth/login")
        .send({ token: 12345 });

      expect(res.status).toBe(400);
    });
  });

  describe("POST /web/api/auth/logout", () => {
    it("destroys session", async () => {
      const session = adminSession();
      const res = await request(app)
        .post("/web/api/auth/logout")
        .set("Authorization", `Bearer ${session}`);

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });

  describe("GET /web/api/auth/me", () => {
    it("returns admin info without DB record", async () => {
      vi.mocked(db.getUserByTgId).mockReturnValue(undefined);
      const session = adminSession();
      const res = await request(app)
        .get("/web/api/auth/me")
        .set("Authorization", `Bearer ${session}`);

      expect(res.status).toBe(200);
      expect(res.body.tgUserId).toBe(MOCK_ADMIN_ID);
      expect(res.body.isAdmin).toBe(true);
      expect(res.body.isActive).toBe(true); // admin defaults to active
      expect(res.body.username).toBeNull();
    });

    it("returns user info with DB record", async () => {
      vi.mocked(db.getUserByTgId).mockReturnValue({
        id: 1, tg_user_id: 99999, username: "testuser", is_active: 1,
      });
      const session = userSession(99999);
      const res = await request(app)
        .get("/web/api/auth/me")
        .set("Authorization", `Bearer ${session}`);

      expect(res.status).toBe(200);
      expect(res.body.username).toBe("testuser");
      expect(res.body.isActive).toBe(true);
    });
  });
});

// ===========================================================================
// User Routes — Models
// ===========================================================================

describe("User Routes — Models", () => {
  it("returns cached model list", async () => {
    vi.mocked(db.getAllCachedModelNames).mockReturnValue(["gpt-4o", "claude-3.5-sonnet"]);
    const session = adminSession();
    const res = await request(app)
      .get("/web/api/models")
      .set("Authorization", `Bearer ${session}`);

    expect(res.status).toBe(200);
    expect(res.body.models).toContain("gpt-4o");
  });
});

// ===========================================================================
// User Routes — Keys
// ===========================================================================

describe("User Routes — Keys", () => {
  beforeEach(() => {
    clearAllAuth();
    vi.mocked(db.getUserByTgId).mockReset();
    vi.mocked(db.addUser).mockReset();
    vi.mocked(db.addApiKey).mockReset();
    vi.mocked(db.getKeysByUser).mockReset();
    vi.mocked(db.deleteApiKey).mockReset();
  });

  describe("GET /web/api/keys", () => {
    it("returns empty list when no keys", async () => {
      vi.mocked(db.getKeysByUser).mockReturnValue([]);
      const session = adminSession();
      const res = await request(app)
        .get("/web/api/keys")
        .set("Authorization", `Bearer ${session}`);

      expect(res.status).toBe(200);
      expect(res.body.keys).toEqual([]);
    });

    it("masks key preview in response", async () => {
      vi.mocked(db.getKeysByUser).mockReturnValue([
        { id: 1, key: "sk-s12ryt-verylongkey1234567890", is_active: 1, created_at: "2024-01-01" },
      ]);
      const session = adminSession();
      const res = await request(app)
        .get("/web/api/keys")
        .set("Authorization", `Bearer ${session}`);

      expect(res.status).toBe(200);
      expect(res.body.keys[0].keyPreview).toContain("...");
      expect(res.body.keys[0].keyPreview).not.toContain("verylongkey");
    });
  });

  describe("POST /web/api/keys — auto-create user fix", () => {
    it("auto-creates user record for admin without DB entry", async () => {
      // Admin has no DB record
      vi.mocked(db.getUserByTgId).mockReturnValue(undefined);
      vi.mocked(db.addApiKey).mockReturnValue({ key: "sk-new-key-12345" });

      const session = adminSession();
      const res = await request(app)
        .post("/web/api/keys")
        .set("Authorization", `Bearer ${session}`);

      expect(res.status).toBe(200);
      expect(res.body.key).toBeTruthy();
      // Critical: addUser must have been called to create the record
      expect(db.addUser).toHaveBeenCalledWith(MOCK_ADMIN_ID);
      expect(db.addApiKey).toHaveBeenCalledWith(MOCK_ADMIN_ID);
    });

    it("does NOT call addUser when user already exists", async () => {
      vi.mocked(db.getUserByTgId).mockReturnValue({
        id: 5, tg_user_id: MOCK_ADMIN_ID, is_active: 1,
      });
      vi.mocked(db.addApiKey).mockReturnValue({ key: "sk-new-key-67890" });

      const session = adminSession();
      const res = await request(app)
        .post("/web/api/keys")
        .set("Authorization", `Bearer ${session}`);

      expect(res.status).toBe(200);
      expect(db.addUser).not.toHaveBeenCalled();
      expect(db.addApiKey).toHaveBeenCalledWith(MOCK_ADMIN_ID);
    });

    it("returns 500 when addApiKey throws", async () => {
      vi.mocked(db.getUserByTgId).mockReturnValue({
        id: 1, tg_user_id: MOCK_ADMIN_ID, is_active: 1,
      });
      vi.mocked(db.addApiKey).mockImplementation(() => {
        throw new Error("DB error");
      });

      const session = adminSession();
      const res = await request(app)
        .post("/web/api/keys")
        .set("Authorization", `Bearer ${session}`);

      expect(res.status).toBe(500);
    });
  });

  describe("DELETE /web/api/keys/:id", () => {
    it("returns 400 for invalid key ID", async () => {
      const session = adminSession();
      const res = await request(app)
        .delete("/web/api/keys/abc")
        .set("Authorization", `Bearer ${session}`);

      expect(res.status).toBe(400);
    });

    it("returns 403 when key belongs to another user", async () => {
      vi.mocked(db.getKeysByUser).mockReturnValue([
        { id: 1, key: "sk-key1", is_active: 1 },
      ]);
      const session = adminSession();
      const res = await request(app)
        .delete("/web/api/keys/999")
        .set("Authorization", `Bearer ${session}`);

      expect(res.status).toBe(403);
    });

    it("deletes own key successfully", async () => {
      vi.mocked(db.getKeysByUser).mockReturnValue([
        { id: 5, key: "sk-key5", is_active: 1 },
      ]);
      vi.mocked(db.deleteApiKey).mockReturnValue(undefined);
      const session = adminSession();
      const res = await request(app)
        .delete("/web/api/keys/5")
        .set("Authorization", `Bearer ${session}`);

      expect(res.status).toBe(200);
      expect(db.deleteApiKey).toHaveBeenCalledWith(5);
    });
  });
});

// ===========================================================================
// User Routes — Usage
// ===========================================================================

describe("User Routes — Usage", () => {
  it("returns usage records and summary", async () => {
    vi.mocked(db.getUsageByUser).mockReturnValue([]);
    const session = adminSession();
    const res = await request(app)
      .get("/web/api/usage")
      .set("Authorization", `Bearer ${session}`);

    expect(res.status).toBe(200);
    expect(res.body.records).toEqual([]);
    expect(res.body.summary).toEqual({});
  });
});

// ===========================================================================
// User Routes — Coding
// ===========================================================================

describe("User Routes — Coding", () => {
  beforeEach(() => {
    clearAllAuth();
    vi.mocked(db.getUserByTgId).mockReset();
    vi.mocked(db.getCodingConfigByTgId).mockReset();
    vi.mocked(db.setCodingConfig).mockReset();
  });

  describe("GET /web/api/coding", () => {
    it("returns null config when no coding config", async () => {
      vi.mocked(db.getCodingConfigByTgId).mockReturnValue(null);
      const session = adminSession();
      const res = await request(app)
        .get("/web/api/coding")
        .set("Authorization", `Bearer ${session}`);

      expect(res.status).toBe(200);
      expect(res.body.config).toBeNull();
    });
  });

  describe("PUT /web/api/coding", () => {
    it("returns 404 when user does not exist", async () => {
      vi.mocked(db.getUserByTgId).mockReturnValue(undefined);
      const session = adminSession();
      const res = await request(app)
        .put("/web/api/coding")
        .set("Authorization", `Bearer ${session}`)
        .send({ isActive: true });

      expect(res.status).toBe(404);
    });

    it("updates coding config for existing user", async () => {
      vi.mocked(db.getUserByTgId).mockReturnValue({
        id: 1, tg_user_id: MOCK_ADMIN_ID, is_active: 1,
      });
      vi.mocked(db.setCodingConfig).mockReturnValue({
        is_active: 1, fallback_models: "", max_retries: 3,
      });
      const session = adminSession();
      const res = await request(app)
        .put("/web/api/coding")
        .set("Authorization", `Bearer ${session}`)
        .send({ isActive: true, maxRetries: 5 });

      expect(res.status).toBe(200);
      expect(db.setCodingConfig).toHaveBeenCalled();
    });
  });
});

// ===========================================================================
// User Routes — Limits & Restrictions
// ===========================================================================

describe("User Routes — Limits", () => {
  it("returns 404 when user does not exist", async () => {
    vi.mocked(db.getUserByTgId).mockReturnValue(undefined);
    const session = adminSession();
    const res = await request(app)
      .get("/web/api/limits")
      .set("Authorization", `Bearer ${session}`);

    expect(res.status).toBe(404);
  });

  it("returns limits for existing user", async () => {
    vi.mocked(db.getUserByTgId).mockReturnValue({
      id: 1, tg_user_id: MOCK_ADMIN_ID, is_active: 1,
    });
    const session = adminSession();
    const res = await request(app)
      .get("/web/api/limits")
      .set("Authorization", `Bearer ${session}`);

    expect(res.status).toBe(200);
    expect(res.body.limits).toBeDefined();
    expect(res.body.daily).toBeDefined();
    expect(res.body.monthly).toBeDefined();
  });
});

describe("User Routes — Restrictions", () => {
  it("returns 404 when user does not exist", async () => {
    vi.mocked(db.getUserByTgId).mockReturnValue(undefined);
    const session = adminSession();
    const res = await request(app)
      .get("/web/api/restrictions")
      .set("Authorization", `Bearer ${session}`);

    expect(res.status).toBe(404);
  });

  it("returns restrictions for existing user", async () => {
    vi.mocked(db.getUserByTgId).mockReturnValue({
      id: 1, tg_user_id: MOCK_ADMIN_ID, is_active: 1,
    });
    vi.mocked(db.getModelRestrictionsForUser).mockReturnValue([]);
    const session = adminSession();
    const res = await request(app)
      .get("/web/api/restrictions")
      .set("Authorization", `Bearer ${session}`);

    expect(res.status).toBe(200);
    expect(res.body.restrictions).toEqual([]);
  });
});

// ===========================================================================
// User Routes — URL
// ===========================================================================

describe("User Routes — URL", () => {
  it("returns API URL from settings", async () => {
    vi.mocked(db.getSetting).mockReturnValue("http://custom-api.example.com");
    const session = adminSession();
    const res = await request(app)
      .get("/web/api/url")
      .set("Authorization", `Bearer ${session}`);

    expect(res.status).toBe(200);
    expect(res.body.url).toBe("http://custom-api.example.com");
  });

  it("falls back to DEFAULT_API_URL when setting missing", async () => {
    vi.mocked(db.getSetting).mockReturnValue(null);
    const session = adminSession();
    const res = await request(app)
      .get("/web/api/url")
      .set("Authorization", `Bearer ${session}`);

    expect(res.status).toBe(200);
    expect(res.body.url).toBe("http://localhost:8000");
  });
});

// ===========================================================================
// Admin Routes — Version / Update / Restart
// ===========================================================================

describe("Admin Routes — Version & Update", () => {
  beforeEach(() => {
    vi.mocked(updater.getCurrentVersion).mockReset();
    vi.mocked(updater.isWorkingDirClean).mockReset();
    vi.mocked(updater.fetchAndCheckUpdate).mockReset();
    vi.mocked(updater.performUpdate).mockReset();
    vi.mocked(updater.restartProcess).mockReset();
  });

  describe("GET /web/api/admin/version", () => {
    it("returns version info for admin", async () => {
      vi.mocked(updater.getCurrentVersion).mockReturnValue({
        hash: "abc1234", date: "2024-01-01", message: "feat: test", tag: "v1.2.0",
      });
      vi.mocked(updater.isWorkingDirClean).mockReturnValue(true);
      const session = adminSession();
      const res = await request(app)
        .get("/web/api/admin/version")
        .set("Authorization", `Bearer ${session}`);

      expect(res.status).toBe(200);
      expect(res.body.version.tag).toBe("v1.2.0");
      expect(res.body.workingDirClean).toBe(true);
    });
  });

  describe("GET /web/api/admin/check-update", () => {
    it("returns update check result", async () => {
      vi.mocked(updater.fetchAndCheckUpdate).mockResolvedValue({
        hasUpdate: true,
        current: { hash: "abc", date: "", message: "", tag: "v1.0.0" },
        latestRelease: {
          tag: "v1.1.0", name: "Release 1.1.0", prerelease: false,
          publishedAt: "2024-06-01", htmlUrl: "https://github.com/...", tarballUrl: "https://...",
        },
        commitsBehind: 3,
        newCommits: ["feat: a", "fix: b", "docs: c"],
      });
      const session = adminSession();
      const res = await request(app)
        .get("/web/api/admin/check-update")
        .set("Authorization", `Bearer ${session}`);

      expect(res.status).toBe(200);
      expect(res.body.hasUpdate).toBe(true);
      expect(res.body.commitsBehind).toBe(3);
    });

    it("returns 500 when fetchAndCheckUpdate throws", async () => {
      vi.mocked(updater.fetchAndCheckUpdate).mockRejectedValue(new Error("network"));
      const session = adminSession();
      const res = await request(app)
        .get("/web/api/admin/check-update")
        .set("Authorization", `Bearer ${session}`);

      expect(res.status).toBe(500);
    });
  });

  describe("POST /web/api/admin/update", () => {
    it("triggers update and sets willRestart=true by default", async () => {
      vi.mocked(updater.performUpdate).mockResolvedValue({
        success: true, message: "ok", method: "blue-green",
      });
      const session = adminSession();
      const res = await request(app)
        .post("/web/api/admin/update")
        .set("Authorization", `Bearer ${session}`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.willRestart).toBe(true);
      expect(updater.restartProcess).toHaveBeenCalled();
    });

    it("does NOT restart when restart=false", async () => {
      vi.mocked(updater.performUpdate).mockResolvedValue({
        success: true, message: "ok", method: "blue-green",
      });
      const session = adminSession();
      const res = await request(app)
        .post("/web/api/admin/update")
        .set("Authorization", `Bearer ${session}`)
        .send({ restart: false });

      expect(res.status).toBe(200);
      expect(res.body.willRestart).toBe(false);
      expect(updater.restartProcess).not.toHaveBeenCalled();
    });
  });

  describe("POST /web/api/admin/restart", () => {
    it("restarts with default delay", async () => {
      const session = adminSession();
      const res = await request(app)
        .post("/web/api/admin/restart")
        .set("Authorization", `Bearer ${session}`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(updater.restartProcess).toHaveBeenCalledWith(2000);
    });

    it("restarts with custom delay", async () => {
      const session = adminSession();
      const res = await request(app)
        .post("/web/api/admin/restart")
        .set("Authorization", `Bearer ${session}`)
        .send({ delay: 5000 });

      expect(res.status).toBe(200);
      expect(updater.restartProcess).toHaveBeenCalledWith(5000);
    });
  });
});

// ===========================================================================
// Admin Routes — Backups & Rollback
// ===========================================================================

describe("Admin Routes — Backups & Rollback", () => {
  beforeEach(() => {
    vi.mocked(updater.getBackupList).mockReset();
    vi.mocked(updater.rollbackAndRestart).mockReset();
  });

  describe("GET /web/api/admin/backups", () => {
    it("returns backup list", async () => {
      vi.mocked(updater.getBackupList).mockReturnValue([
        { name: ".backup-1718534400000", timestamp: 1718534400000, createdAt: new Date(1718534400000) },
      ]);
      const session = adminSession();
      const res = await request(app)
        .get("/web/api/admin/backups")
        .set("Authorization", `Bearer ${session}`);

      expect(res.status).toBe(200);
      expect(res.body.backups).toHaveLength(1);
      expect(res.body.backups[0].name).toContain(".backup-");
    });

    it("returns empty list when no backups", async () => {
      vi.mocked(updater.getBackupList).mockReturnValue([]);
      const session = adminSession();
      const res = await request(app)
        .get("/web/api/admin/backups")
        .set("Authorization", `Bearer ${session}`);

      expect(res.status).toBe(200);
      expect(res.body.backups).toEqual([]);
    });
  });

  describe("POST /web/api/admin/rollback", () => {
    it("triggers rollback and restart", async () => {
      vi.mocked(updater.rollbackAndRestart).mockReturnValue({
        success: true, message: "已回滾到備份",
      });
      const session = adminSession();
      const res = await request(app)
        .post("/web/api/admin/rollback")
        .set("Authorization", `Bearer ${session}`);

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(updater.rollbackAndRestart).toHaveBeenCalled();
    });
  });
});

// ===========================================================================
// Access Control
// ===========================================================================

describe("Access Control", () => {
  it("returns 401 for all protected routes without session", async () => {
    const res = await request(app).get("/web/api/auth/me");
    expect(res.status).toBe(401);
  });

  it("returns 401 without auth header on user route", async () => {
    const res = await request(app).get("/web/api/keys");
    expect(res.status).toBe(401);
  });

  it("returns 403 when non-admin accesses admin route", async () => {
    vi.mocked(db.getUserByTgId).mockReturnValue({
      id: 1, tg_user_id: 99999, username: "user", is_active: 1,
    });
    clearAllAuth();
    const otp = generateLoginToken(99999);
    const { sessionToken } = exchangeToken(otp)!;

    const res = await request(app)
      .get("/web/api/admin/version")
      .set("Authorization", `Bearer ${sessionToken}`);

    expect(res.status).toBe(403);
  });

  it("non-admin can access user routes", async () => {
    vi.mocked(db.getUserByTgId).mockReturnValue({
      id: 1, tg_user_id: 99999, username: "user", is_active: 1,
    });
    vi.mocked(db.getKeysByUser).mockReturnValue([]);
    clearAllAuth();
    const otp = generateLoginToken(99999);
    const { sessionToken } = exchangeToken(otp)!;

    const res = await request(app)
      .get("/web/api/keys")
      .set("Authorization", `Bearer ${sessionToken}`);

    expect(res.status).toBe(200);
  });
});

// ===========================================================================
// Error Handling
// ===========================================================================

describe("Error Handling", () => {
  it("returns 404 for unknown /api/* route", async () => {
    const session = adminSession();
    const res = await request(app)
      .get("/web/api/nonexistent")
      .set("Authorization", `Bearer ${session}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("未知");
  });

  it("returns 204 for favicon.ico (with auth)", async () => {
    const session = adminSession();
    const res = await request(app)
      .get("/web/favicon.ico")
      .set("Authorization", `Bearer ${session}`);
    expect(res.status).toBe(204);
  });
});

/**
 * Unit tests for src/web/auth.ts
 *
 * Tests the two-stage auth flow:
 *   1. generateLoginToken(tgUserId) → OTP
 *   2. exchangeToken(otp) → session
 *   3. webAuthMiddleware / requireAdmin
 *
 * Mocks: config.js (ADMIN_ID), database.js (getUserByTgId)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

// ---------------------------------------------------------------------------
// Hoisted values — available inside vi.mock() factories
// ---------------------------------------------------------------------------

const { MOCK_ADMIN_ID, mockGetUserByTgId } = vi.hoisted(() => ({
  MOCK_ADMIN_ID: 12345,
  mockGetUserByTgId: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock: config.js
// ---------------------------------------------------------------------------

vi.mock("../src/config.js", () => ({
  config: {
    BOT_TOKEN: "test-token",
    ADMIN_ID: MOCK_ADMIN_ID,
    API_PORT: 8000,
    DATABASE_PATH: "./data/test.db",
    DEFAULT_API_URL: "http://localhost:8000",
  },
}));

// ---------------------------------------------------------------------------
// Mock: database.js
// ---------------------------------------------------------------------------

vi.mock("../src/db/database.js", () => ({
  getUserByTgId: mockGetUserByTgId,
  closeDb: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import AFTER mocks
// ---------------------------------------------------------------------------

import {
  generateLoginToken,
  exchangeToken,
  getSessionInfo,
  destroySession,
  webAuthMiddleware,
  requireAdmin,
  clearAllAuth,
} from "../src/web/auth.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use(webAuthMiddleware);
  app.get("/test", (req, res) => {
    res.json({ webAuth: req.webAuth ?? null });
  });
  app.get("/admin-only", requireAdmin, (req, res) => {
    res.json({ ok: true });
  });
  return app;
}

// ===========================================================================
// generateLoginToken
// ===========================================================================

describe("generateLoginToken", () => {
  beforeEach(() => clearAllAuth());

  it("returns a non-empty string token", () => {
    const token = generateLoginToken(999);
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
  });

  it("generates unique tokens on each call", () => {
    const t1 = generateLoginToken(999);
    const t2 = generateLoginToken(999);
    expect(t1).not.toBe(t2);
  });
});

// ===========================================================================
// exchangeToken
// ===========================================================================

describe("exchangeToken", () => {
  beforeEach(() => {
    clearAllAuth();
    mockGetUserByTgId.mockReset();
  });

  it("exchanges valid OTP for session (admin bypass)", () => {
    const otp = generateLoginToken(MOCK_ADMIN_ID);
    const result = exchangeToken(otp);
    expect(result).not.toBeNull();
    expect(result!.tgUserId).toBe(MOCK_ADMIN_ID);
    expect(result!.isAdmin).toBe(true);
    expect(typeof result!.sessionToken).toBe("string");
  });

  it("admin does not require DB record", () => {
    mockGetUserByTgId.mockReturnValue(undefined);
    const otp = generateLoginToken(MOCK_ADMIN_ID);
    const result = exchangeToken(otp);
    expect(result).not.toBeNull();
    expect(result!.isAdmin).toBe(true);
    // DB should NOT be queried for admin
    expect(mockGetUserByTgId).not.toHaveBeenCalled();
  });

  it("non-admin with active user succeeds", () => {
    mockGetUserByTgId.mockReturnValue({
      id: 1,
      tg_user_id: 88888,
      is_active: 1,
    });
    const otp = generateLoginToken(88888);
    const result = exchangeToken(otp);
    expect(result).not.toBeNull();
    expect(result!.tgUserId).toBe(88888);
    expect(result!.isAdmin).toBe(false);
  });

  it("non-admin with inactive user returns null", () => {
    mockGetUserByTgId.mockReturnValue({
      id: 2,
      tg_user_id: 77777,
      is_active: 0,
    });
    const otp = generateLoginToken(77777);
    const result = exchangeToken(otp);
    expect(result).toBeNull();
  });

  it("non-admin with no DB record returns null", () => {
    mockGetUserByTgId.mockReturnValue(undefined);
    const otp = generateLoginToken(66666);
    const result = exchangeToken(otp);
    expect(result).toBeNull();
  });

  it("OTP is one-time use (second call returns null)", () => {
    const otp = generateLoginToken(MOCK_ADMIN_ID);
    const first = exchangeToken(otp);
    const second = exchangeToken(otp);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it("invalid OTP token returns null", () => {
    const result = exchangeToken("totally-invalid-uuid");
    expect(result).toBeNull();
  });

  it("empty string OTP returns null", () => {
    const result = exchangeToken("");
    expect(result).toBeNull();
  });

  it("expired OTP returns null", () => {
    const otp = generateLoginToken(MOCK_ADMIN_ID);
    // Manually expire by manipulating time
    vi.useFakeTimers();
    vi.advanceTimersByTime(6 * 60 * 1000); // 6 minutes (> 5 min TTL)
    const result = exchangeToken(otp);
    expect(result).toBeNull();
    vi.useRealTimers();
  });
});

// ===========================================================================
// getSessionInfo
// ===========================================================================

describe("getSessionInfo", () => {
  beforeEach(() => {
    clearAllAuth();
    mockGetUserByTgId.mockReset();
  });

  it("returns session info for valid token", () => {
    const otp = generateLoginToken(MOCK_ADMIN_ID);
    const { sessionToken } = exchangeToken(otp)!;
    const info = getSessionInfo(sessionToken);
    expect(info).not.toBeNull();
    expect(info!.tgUserId).toBe(MOCK_ADMIN_ID);
    expect(info!.isAdmin).toBe(true);
  });

  it("returns null for invalid token", () => {
    expect(getSessionInfo("invalid")).toBeNull();
  });

  it("returns null for empty token", () => {
    expect(getSessionInfo("")).toBeNull();
  });
});

// ===========================================================================
// destroySession
// ===========================================================================

describe("destroySession", () => {
  beforeEach(() => {
    clearAllAuth();
  });

  it("removes session so getSessionInfo returns null", () => {
    const otp = generateLoginToken(MOCK_ADMIN_ID);
    const { sessionToken } = exchangeToken(otp)!;
    expect(getSessionInfo(sessionToken)).not.toBeNull();

    destroySession(sessionToken);
    expect(getSessionInfo(sessionToken)).toBeNull();
  });

  it("does not throw for non-existent session", () => {
    expect(() => destroySession("nonexistent")).not.toThrow();
  });
});

// ===========================================================================
// webAuthMiddleware
// ===========================================================================

describe("webAuthMiddleware", () => {
  let app: express.Application;

  beforeEach(() => {
    clearAllAuth();
    mockGetUserByTgId.mockReset();
    app = createTestApp();
  });

  it("returns 401 when no Authorization header", async () => {
    const res = await request(app).get("/test");
    expect(res.status).toBe(401);
    expect(res.body.error).toContain("token");
  });

  it("returns 401 for non-Bearer scheme", async () => {
    const res = await request(app).get("/test").set("Authorization", "Basic abc");
    expect(res.status).toBe(401);
  });

  it("returns 401 for invalid/expired session token", async () => {
    const res = await request(app)
      .get("/test")
      .set("Authorization", "Bearer invalid-session");
    expect(res.status).toBe(401);
    expect(res.body.error).toContain("過期");
  });

  it("injects req.webAuth on valid session", async () => {
    const otp = generateLoginToken(MOCK_ADMIN_ID);
    const { sessionToken } = exchangeToken(otp)!;
    const res = await request(app)
      .get("/test")
      .set("Authorization", `Bearer ${sessionToken}`);
    expect(res.status).toBe(200);
    expect(res.body.webAuth.tgUserId).toBe(MOCK_ADMIN_ID);
    expect(res.body.webAuth.isAdmin).toBe(true);
  });
});

// ===========================================================================
// requireAdmin
// ===========================================================================

describe("requireAdmin", () => {
  let app: express.Application;

  beforeEach(() => {
    clearAllAuth();
    mockGetUserByTgId.mockReset();
    app = createTestApp();
  });

  it("allows admin to access", async () => {
    const otp = generateLoginToken(MOCK_ADMIN_ID);
    const { sessionToken } = exchangeToken(otp)!;
    const res = await request(app)
      .get("/admin-only")
      .set("Authorization", `Bearer ${sessionToken}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("returns 403 for non-admin", async () => {
    mockGetUserByTgId.mockReturnValue({ id: 1, tg_user_id: 88888, is_active: 1 });
    const otp = generateLoginToken(88888);
    const { sessionToken } = exchangeToken(otp)!;
    const res = await request(app)
      .get("/admin-only")
      .set("Authorization", `Bearer ${sessionToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("管理員");
  });
});

// ===========================================================================
// clearAllAuth
// ===========================================================================

describe("clearAllAuth", () => {
  it("clears all active sessions", () => {
    const otp = generateLoginToken(MOCK_ADMIN_ID);
    const { sessionToken } = exchangeToken(otp)!;
    expect(getSessionInfo(sessionToken)).not.toBeNull();

    clearAllAuth();
    expect(getSessionInfo(sessionToken)).toBeNull();
  });
});

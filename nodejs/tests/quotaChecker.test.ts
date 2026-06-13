/**
 * Unit tests for src/api/quotaChecker.ts
 *
 * Tests the quotaCheckMiddleware in isolation by mocking database and config.
 * Verifies daily/monthly token and cost quota checks, admin bypass,
 * and unlimited (0) bypass behavior.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";

// Mock config before importing the module
vi.mock("../src/config.js", () => ({
  config: {
    ADMIN_ID: 123456,
    BOT_TOKEN: "test-token",
    API_PORT: 8000,
    DATABASE_PATH: ":memory:",
    DEFAULT_API_URL: "http://localhost:8000",
  },
}));

// Track mock state
let mockLimits = {
  rpm: 0,
  tpm: 0,
  concurrency: 0,
  dailyTokenLimit: 0,
  monthlyTokenLimit: 0,
  dailyCostLimit: 0,
  monthlyCostLimit: 0,
  expiresAt: null as string | null,
};

let mockDailyUsage = { totalTokens: 0, totalCost: 0 };
let mockMonthlyUsage = { totalTokens: 0, totalCost: 0 };

vi.mock("../src/db/database.js", () => ({
  getEffectiveLimits: vi.fn(() => ({ ...mockLimits })),
  getDailyUsage: vi.fn(() => ({ ...mockDailyUsage })),
  getMonthlyUsage: vi.fn(() => ({ ...mockMonthlyUsage })),
}));

// Import after mocks are set
import { quotaCheckMiddleware } from "../src/api/quotaChecker.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockAuth {
  userId: string;
  apiKeyId: string;
  tgUserId: number;
}

function makeReq(auth: MockAuth | null): Partial<Request> {
  return { auth: auth ?? undefined } as Partial<Request>;
}

function makeRes(): Response & {
  _statusCode: number;
  _jsonBody: unknown;
  _ended: boolean;
} {
  const res = {
    _statusCode: 0,
    _jsonBody: null as unknown,
    _ended: false,
    status(code: number) {
      this._statusCode = code;
      return this;
    },
    json(body: unknown) {
      this._jsonBody = body;
      this._ended = true;
      return this;
    },
  };
  return res as unknown as Response & {
    _statusCode: number;
    _jsonBody: unknown;
    _ended: boolean;
  };
}

function makeNext(): NextFunction & { called: boolean } {
  const fn = (() => {
    (fn as unknown as { called: boolean }).called = true;
  }) as unknown as NextFunction & { called: boolean };
  fn.called = false;
  return fn;
}

const TEST_AUTH: MockAuth = { userId: "1", apiKeyId: "1", tgUserId: 99999 };
const ADMIN_AUTH: MockAuth = { userId: "0", apiKeyId: "0", tgUserId: 123456 };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("quotaCheckMiddleware", () => {
  beforeEach(() => {
    mockLimits = {
      rpm: 0,
      tpm: 0,
      concurrency: 0,
      dailyTokenLimit: 0,
      monthlyTokenLimit: 0,
      dailyCostLimit: 0,
      monthlyCostLimit: 0,
      expiresAt: null,
    };
    mockDailyUsage = { totalTokens: 0, totalCost: 0 };
    mockMonthlyUsage = { totalTokens: 0, totalCost: 0 };
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should call next() when no auth is present", () => {
    const req = makeReq(null);
    const res = makeRes();
    const next = makeNext();

    quotaCheckMiddleware(req as Request, res, next);

    expect(next.called).toBe(true);
    expect(res._ended).toBe(false);
  });

  it("should bypass for admin users", () => {
    const req = makeReq(ADMIN_AUTH);
    const res = makeRes();
    const next = makeNext();

    quotaCheckMiddleware(req as Request, res, next);

    expect(next.called).toBe(true);
  });

  it("should allow request when all quotas are 0 (unlimited)", () => {
    const req = makeReq(TEST_AUTH);
    const res = makeRes();
    const next = makeNext();

    quotaCheckMiddleware(req as Request, res, next);

    expect(next.called).toBe(true);
    expect(res._ended).toBe(false);
  });

  it("should return 429 when daily token quota is exceeded", () => {
    mockLimits.dailyTokenLimit = 1000;
    mockDailyUsage.totalTokens = 1500;

    const req = makeReq(TEST_AUTH);
    const res = makeRes();
    const next = makeNext();

    quotaCheckMiddleware(req as Request, res, next);

    expect(res._statusCode).toBe(429);
    expect(next.called).toBe(false);
    const body = res._jsonBody as { error: { code: string; used: number; limit: number } };
    expect(body.error.code).toBe("daily_token_exceeded");
    expect(body.error.used).toBe(1500);
    expect(body.error.limit).toBe(1000);
  });

  it("should allow request when daily token usage is within quota", () => {
    mockLimits.dailyTokenLimit = 1000;
    mockDailyUsage.totalTokens = 500;

    const req = makeReq(TEST_AUTH);
    const res = makeRes();
    const next = makeNext();

    quotaCheckMiddleware(req as Request, res, next);

    expect(next.called).toBe(true);
  });

  it("should return 429 when monthly token quota is exceeded", () => {
    mockLimits.monthlyTokenLimit = 10000;
    mockMonthlyUsage.totalTokens = 12000;

    const req = makeReq(TEST_AUTH);
    const res = makeRes();
    const next = makeNext();

    quotaCheckMiddleware(req as Request, res, next);

    expect(res._statusCode).toBe(429);
    const body = res._jsonBody as { error: { code: string; used: number; limit: number } };
    expect(body.error.code).toBe("monthly_token_exceeded");
    expect(body.error.used).toBe(12000);
    expect(body.error.limit).toBe(10000);
  });

  it("should return 429 when daily cost quota is exceeded", () => {
    mockLimits.dailyCostLimit = 1.0;
    mockDailyUsage.totalCost = 1.5;

    const req = makeReq(TEST_AUTH);
    const res = makeRes();
    const next = makeNext();

    quotaCheckMiddleware(req as Request, res, next);

    expect(res._statusCode).toBe(429);
    const body = res._jsonBody as { error: { code: string } };
    expect(body.error.code).toBe("daily_cost_exceeded");
  });

  it("should return 429 when monthly cost quota is exceeded", () => {
    mockLimits.monthlyCostLimit = 10.0;
    mockMonthlyUsage.totalCost = 15.0;

    const req = makeReq(TEST_AUTH);
    const res = makeRes();
    const next = makeNext();

    quotaCheckMiddleware(req as Request, res, next);

    expect(res._statusCode).toBe(429);
    const body = res._jsonBody as { error: { code: string } };
    expect(body.error.code).toBe("monthly_cost_exceeded");
  });

  it("should check daily token before other quotas", () => {
    mockLimits.dailyTokenLimit = 100;
    mockLimits.monthlyTokenLimit = 1000;
    mockDailyUsage.totalTokens = 150;
    mockMonthlyUsage.totalTokens = 500;

    const req = makeReq(TEST_AUTH);
    const res = makeRes();
    const next = makeNext();

    quotaCheckMiddleware(req as Request, res, next);

    // Should fail on daily token first
    expect(res._statusCode).toBe(429);
    const body = res._jsonBody as { error: { code: string } };
    expect(body.error.code).toBe("daily_token_exceeded");
  });
});

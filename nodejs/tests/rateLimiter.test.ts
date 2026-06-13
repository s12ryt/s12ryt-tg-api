/**
 * Unit tests for src/api/rateLimiter.ts
 *
 * Tests the rateLimitMiddleware in isolation by mocking database and config.
 * Verifies RPM, TPM, concurrency limits, expiry checks, admin bypass,
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

vi.mock("../src/db/database.js", () => ({
  getEffectiveLimits: vi.fn(() => ({ ...mockLimits })),
}));

// Import after mocks are set
import { rateLimitMiddleware, recordTokenUsage } from "../src/api/rateLimiter.js";

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
    on: vi.fn(),
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

describe("rateLimitMiddleware", () => {
  beforeEach(() => {
    // Reset mock limits to unlimited
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
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should call next() when no auth is present", () => {
    const req = makeReq(null);
    const res = makeRes();
    const next = makeNext();

    rateLimitMiddleware(req as Request, res, next);

    expect(next.called).toBe(true);
    expect(res._ended).toBe(false);
  });

  it("should bypass for admin users", () => {
    const req = makeReq(ADMIN_AUTH);
    const res = makeRes();
    const next = makeNext();

    rateLimitMiddleware(req as Request, res, next);

    expect(next.called).toBe(true);
    expect(res._ended).toBe(false);
  });

  it("should allow request when all limits are 0 (unlimited)", () => {
    const req = makeReq(TEST_AUTH);
    const res = makeRes();
    const next = makeNext();

    rateLimitMiddleware(req as Request, res, next);

    expect(next.called).toBe(true);
    expect(res._ended).toBe(false);
  });

  it("should return 403 when access is expired", () => {
    mockLimits.expiresAt = "2000-01-01T00:00:00";
    const req = makeReq(TEST_AUTH);
    const res = makeRes();
    const next = makeNext();

    rateLimitMiddleware(req as Request, res, next);

    expect(res._statusCode).toBe(403);
    expect(res._ended).toBe(true);
    expect(next.called).toBe(false);
    const body = res._jsonBody as { error: { code: string } };
    expect(body.error.code).toBe("access_expired");
  });

  it("should allow request when expiry is in the future", () => {
    mockLimits.expiresAt = "2099-12-31T23:59:59";
    const req = makeReq(TEST_AUTH);
    const res = makeRes();
    const next = makeNext();

    rateLimitMiddleware(req as Request, res, next);

    expect(next.called).toBe(true);
  });

  it("should return 429 when RPM limit is exceeded", () => {
    mockLimits.rpm = 2;
    const req = makeReq(TEST_AUTH);
    const res = makeRes();
    const next = makeNext();

    // First request passes
    rateLimitMiddleware(req as Request, makeRes(), makeNext());
    // Second request passes
    rateLimitMiddleware(req as Request, makeRes(), makeNext());
    // Third request should be blocked
    rateLimitMiddleware(req as Request, res, next);

    expect(res._statusCode).toBe(429);
    expect(next.called).toBe(false);
    const body = res._jsonBody as { error: { code: string; retry_after: number } };
    expect(body.error.code).toBe("rpm_exceeded");
    expect(body.error.retry_after).toBeGreaterThan(0);
  });

  it("should allow requests within RPM limit", () => {
    mockLimits.rpm = 10;
    const req = makeReq(TEST_AUTH);

    // Make 5 requests, all should pass
    for (let i = 0; i < 5; i++) {
      const res = makeRes();
      const next = makeNext();
      rateLimitMiddleware(req as Request, res, next);
      expect(next.called).toBe(true);
      expect(res._ended).toBe(false);
    }
  });

  it("should return 429 when TPM limit is exceeded", () => {
    mockLimits.tpm = 100;
    const req = makeReq(TEST_AUTH);

    // Record 150 tokens of usage
    recordTokenUsage("1", "1", 150);

    const res = makeRes();
    const next = makeNext();
    rateLimitMiddleware(req as Request, res, next);

    expect(res._statusCode).toBe(429);
    const body = res._jsonBody as { error: { code: string } };
    expect(body.error.code).toBe("tpm_exceeded");
  });

  it("should return 429 when concurrency limit is exceeded", () => {
    mockLimits.concurrency = 1;
    const req = makeReq(TEST_AUTH);

    // First request occupies the concurrency slot (but res.on('close') won't fire in mock)
    const res1 = makeRes();
    rateLimitMiddleware(req as Request, res1, makeNext());

    // Second request should be blocked (concurrency slot still occupied)
    const res2 = makeRes();
    const next2 = makeNext();
    rateLimitMiddleware(req as Request, res2, next2);

    expect(res2._statusCode).toBe(429);
    const body = res2._jsonBody as { error: { code: string } };
    expect(body.error.code).toBe("concurrency_exceeded");
  });
});

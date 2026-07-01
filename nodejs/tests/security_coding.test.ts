/**
 * Security & Coding Mode tests for the Express API server.
 *
 * Covers previously untested critical flows:
 *   - Model access restrictions (whitelist/blacklist → 403)
 *   - Coding Mode fallback chain (retry, all-fail)
 *   - BUG-1: blocked fallback model is skipped (model restriction enforced)
 *   - BUG-2: reportSuccess/reportFailure called in coding-mode path
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// ---------------------------------------------------------------------------
// Hoisted values — available inside vi.mock() factories
// ---------------------------------------------------------------------------

const {
  mockChatCompletion,
  mockCheckModelAllowed,
  mockGetActiveCoding,
  mockReportSuccess,
  mockReportFailure,
  mockGetAllowedModels,
  mockGetTgUserId,
  VALID_KEY,
} = vi.hoisted(() => {
  const chatFn = vi.fn(() =>
    Promise.resolve({
      id: "chatcmpl-test123",
      object: "chat.completion",
      created: 1700000000,
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hello from mock!" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
  );
  return {
    mockChatCompletion: chatFn,
    // Default: allow all models
    mockCheckModelAllowed: vi.fn(() => true),
    // Default: coding mode off
    mockGetActiveCoding: vi.fn(() => null),
    // Default: return all models (no filtering)
    mockGetAllowedModels: vi.fn((_u: number, _k: number | null, models: string[]) => models),
    mockReportSuccess: vi.fn(),
    mockReportFailure: vi.fn(),
    // Default: non-admin user (tgUserId 99999)
    mockGetTgUserId: vi.fn(() => 99999),
    VALID_KEY: "sk-s12ryt-valid-test-key",
  };
});

// ---------------------------------------------------------------------------
// Mock: database.js
// ---------------------------------------------------------------------------

const MOCK_OPENAI_PROVIDER = {
  providerType: "openai_chat",
  providerId: 1,
  providerName: "Test OpenAI",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "test-key",
  keyStrategy: "failover",
  originalModel: "gpt-4o",
  inputPrice: 0.005,
  outputPrice: 0.015,
};

const MOCK_ANTHROPIC_PROVIDER = {
  providerType: "anthropic",
  providerId: 2,
  providerName: "Test Anthropic",
  baseUrl: "https://api.anthropic.com/v1",
  apiKey: "test-key",
  keyStrategy: "failover",
  originalModel: "claude-3.5-sonnet",
  inputPrice: 0.003,
  outputPrice: 0.015,
};

vi.mock("../src/db/database.js", () => {
  return {
    getProviders: vi.fn((_enabledOnly?: boolean) => []),
    getKeyByValue: vi.fn((key: string) => {
      if (key === "sk-s12ryt-valid-test-key") {
        return { id: 1, user_id: 1, key: key, is_active: 1, created_at: "2024-01-01" };
      }
      return undefined;
    }),
    getUserById: vi.fn(() => ({
      id: 1,
      tg_user_id: 99999,
      username: "testuser",
      is_active: 1,
      created_at: "2024-01-01",
    })),
    recordUsage: vi.fn(),
    getSetting: vi.fn(() => null),
    initDbAsync: vi.fn(() => Promise.resolve({})),
    onProviderCacheRebuild: vi.fn(),
    rebuildProviderCache: vi.fn(),
    getAllowedModels: mockGetAllowedModels,
    checkModelAllowed: mockCheckModelAllowed,
    lookupApiKeyCached: vi.fn((token: string) => {
      if (token === "sk-s12ryt-valid-test-key") {
        return { apiKeyId: 1, userId: 1, tgUserId: mockGetTgUserId(), is_active: true, user_is_active: true };
      }
      return null;
    }),
    lookupModelCached: vi.fn((modelName: string) => {
      if (modelName === "gpt-4o" || modelName === "gpt-4o-mini") {
        return { ...MOCK_OPENAI_PROVIDER, originalModel: modelName };
      }
      if (modelName === "claude-3.5-sonnet" || modelName === "claude-3-haiku") {
        return { ...MOCK_ANTHROPIC_PROVIDER, originalModel: modelName };
      }
      return undefined;
    }),
    getAllCachedModelNames: vi.fn(() => ["gpt-4o", "gpt-4o-mini", "claude-3.5-sonnet", "claude-3-haiku"]),
    getUserByTgId: vi.fn(() => undefined),
    getActiveCodingForApiKey: mockGetActiveCoding,
    incrementCodingSessionStats: vi.fn(),
    getEffectiveLimits: vi.fn(() => ({
      rpm: 0, tpm: 0, concurrency: 0,
      dailyTokenLimit: 0, monthlyTokenLimit: 0,
      dailyCostLimit: 0, monthlyCostLimit: 0,
      expiresAt: 0,
    })),
    getCachedEffectiveLimits: vi.fn(() => ({
      rpm: 0, tpm: 0, concurrency: 0,
      dailyTokenLimit: 0, monthlyTokenLimit: 0,
      dailyCostLimit: 0, monthlyCostLimit: 0,
      expiresAt: 0,
    })),
    getDailyUsage: vi.fn(() => ({ total_input_tokens: 0, total_output_tokens: 0, total_cost: 0 })),
    getMonthlyUsage: vi.fn(() => ({ total_input_tokens: 0, total_output_tokens: 0, total_cost: 0 })),
  };
});

// ---------------------------------------------------------------------------
// Mock: keySelector.js  (keyIndex: 0 so BUG-2 tracking is exercised)
// ---------------------------------------------------------------------------

vi.mock("../src/api/keySelector.js", () => ({
  selectKey: vi.fn((_providerId: number, apiKey: string) => ({ key: apiKey, keyIndex: 0 })),
  reportSuccess: mockReportSuccess,
  reportFailure: mockReportFailure,
}));

// ---------------------------------------------------------------------------
// Mock: provider modules
// ---------------------------------------------------------------------------

vi.mock("../src/api/providers/openai.js", () => ({ chatCompletion: mockChatCompletion }));
vi.mock("../src/api/providers/openaiResponse.js", () => ({
  chatCompletion: mockChatCompletion,
  responsesApi: vi.fn(() => Promise.resolve({})),
}));
vi.mock("../src/api/providers/anthropic.js", () => ({ chatCompletion: mockChatCompletion }));
vi.mock("../src/api/providers/google.js", () => ({ chatCompletion: mockChatCompletion }));

// ---------------------------------------------------------------------------
// Import the app — AFTER all mocks
// ---------------------------------------------------------------------------

import app from "../src/api/server.js";
import { config } from "../src/config.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUTH_HEADER = `Bearer ${VALID_KEY}`;

const CHAT_BODY = (model: string) => ({
  model,
  messages: [{ role: "user", content: "Hello!" }],
  stream: false,
});

// ===========================================================================
// Test suites
// ===========================================================================

describe("TestModelAccessRestrictions", () => {
  beforeEach(() => {
    mockChatCompletion.mockClear();
    mockCheckModelAllowed.mockClear();
    mockGetActiveCoding.mockClear();
    mockCheckModelAllowed.mockReturnValue(true);
    mockGetActiveCoding.mockReturnValue(null);
  });

  it("blocked_model_returns_403", async () => {
    mockCheckModelAllowed.mockReturnValue(false);

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", AUTH_HEADER)
      .send(CHAT_BODY("gpt-4o"));

    expect(res.status).toBe(403);
    expect(mockChatCompletion).not.toHaveBeenCalled();
  });

  it("allowed_model_passes", async () => {
    mockCheckModelAllowed.mockReturnValue(true);

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", AUTH_HEADER)
      .send(CHAT_BODY("gpt-4o"));

    expect(res.status).toBe(200);
    expect(mockChatCompletion).toHaveBeenCalledTimes(1);
  });

  it("models_endpoint_filters_restricted", async () => {
    // Block gpt-4o, allow rest
    mockGetAllowedModels.mockImplementation(
      (_u: number, _k: number | null, models: string[]) => models.filter((m) => m !== "gpt-4o"),
    );

    const res = await request(app)
      .get("/v1/models")
      .set("Authorization", AUTH_HEADER);

    expect(res.status).toBe(200);
    const modelIds = res.body.data.map((m: any) => m.id);
    expect(modelIds).not.toContain("gpt-4o");
    expect(modelIds).toContain("gpt-4o-mini");

    // Reset for other tests
    mockGetAllowedModels.mockImplementation((_u: number, _k: number | null, models: string[]) => models);
  });

  it("/v1/responses blocks restricted model and returns 403", async () => {
    mockCheckModelAllowed.mockReturnValue(false);

    const res = await request(app)
      .post("/v1/responses")
      .set("Authorization", AUTH_HEADER)
      .send({ model: "gpt-4o", input: "Hello!" });

    expect(res.status).toBe(403);
  });

  it("/v1/messages blocks restricted model and returns 403", async () => {
    mockCheckModelAllowed.mockReturnValue(false);

    const res = await request(app)
      .post("/v1/messages")
      .set("Authorization", AUTH_HEADER)
      .send({ model: "gpt-4o", messages: [{ role: "user", content: "Hello!" }], max_tokens: 100 });

    expect(res.status).toBe(403);
  });

  it("admin request passes isAdmin=true to checkModelAllowed (bypass user-level restriction)", async () => {
    // Admin user: tgUserId === config.ADMIN_ID (set globally in setup.ts)
    mockGetTgUserId.mockReturnValue(config.ADMIN_ID);
    try {
      mockCheckModelAllowed.mockReturnValue(true);
      mockCheckModelAllowed.mockClear();

      const res = await request(app)
        .post("/v1/chat/completions")
        .set("Authorization", AUTH_HEADER)
        .send(CHAT_BODY("gpt-4o"));

      expect(res.status).toBe(200);
      // checkModelAllowed should receive isAdmin=true as 4th argument
      expect(mockCheckModelAllowed).toHaveBeenCalled();
      const lastCall = mockCheckModelAllowed.mock.calls.at(-1)!;
      expect(lastCall[3]).toBe(true);
    } finally {
      // Always reset to non-admin for subsequent tests
      mockGetTgUserId.mockReturnValue(99999);
    }
  });
});

describe("TestCodingModeFallback", () => {
  beforeEach(() => {
    mockChatCompletion.mockClear();
    mockCheckModelAllowed.mockClear();
    mockGetActiveCoding.mockClear();
    mockReportSuccess.mockClear();
    mockReportFailure.mockClear();
    mockCheckModelAllowed.mockReturnValue(true);
    mockGetActiveCoding.mockReturnValue(null);
    // Reset chatCompletion to success
    mockChatCompletion.mockResolvedValue({
      id: "chatcmpl-test123",
      object: "chat.completion",
      created: 1700000000,
      model: "gpt-4o",
      choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  });

  it("not_configured_returns_error", async () => {
    mockGetActiveCoding.mockReturnValue(null);

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", AUTH_HEADER)
      .send(CHAT_BODY("coding-mode"));

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(mockChatCompletion).not.toHaveBeenCalled();
  });

  it("first_model_succeeds", async () => {
    mockGetActiveCoding.mockReturnValue({ fallback_list: ["gpt-4o"] });

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", AUTH_HEADER)
      .send(CHAT_BODY("coding-mode"));

    expect(res.status).toBe(200);
    expect(mockChatCompletion).toHaveBeenCalledTimes(1);
  });

  it("fallback_to_second_model", async () => {
    mockGetActiveCoding.mockReturnValue({ fallback_list: ["gpt-4o", "claude-3.5-sonnet"] });

    // First call fails, second succeeds
    mockChatCompletion
      .mockRejectedValueOnce(new Error("upstream error"))
      .mockResolvedValueOnce({
        id: "chatcmpl-test456",
        object: "chat.completion",
        created: 1700000000,
        model: "claude-3.5-sonnet",
        choices: [{ index: 0, message: { role: "assistant", content: "OK from Claude" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", AUTH_HEADER)
      .send(CHAT_BODY("coding-mode"));

    expect(res.status).toBe(200);
    expect(mockChatCompletion).toHaveBeenCalledTimes(2);
  });

  it("all_models_fail_returns_error", async () => {
    mockGetActiveCoding.mockReturnValue({ fallback_list: ["gpt-4o", "claude-3.5-sonnet"] });
    mockChatCompletion.mockRejectedValue(new Error("all upstreams down"));

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", AUTH_HEADER)
      .send(CHAT_BODY("coding-mode"));

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(mockChatCompletion).toHaveBeenCalledTimes(2);
  });
});

describe("TestBug1CodingModeModelRestriction", () => {
  beforeEach(() => {
    mockChatCompletion.mockClear();
    mockCheckModelAllowed.mockClear();
    mockGetActiveCoding.mockClear();
    mockReportSuccess.mockClear();
    mockReportFailure.mockClear();
    mockChatCompletion.mockResolvedValue({
      id: "chatcmpl-test123",
      object: "chat.completion",
      created: 1700000000,
      model: "gpt-4o",
      choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  });

  it("blocked_fallback_model_is_skipped", async () => {
    // gpt-4o is blocked, claude-3.5-sonnet is allowed
    mockCheckModelAllowed.mockImplementation(
      (_u: number, _k: number | null, modelName: string) => modelName !== "gpt-4o",
    );
    mockGetActiveCoding.mockReturnValue({ fallback_list: ["gpt-4o", "claude-3.5-sonnet"] });

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", AUTH_HEADER)
      .send(CHAT_BODY("coding-mode"));

    // Should succeed via claude-3.5-sonnet (gpt-4o skipped)
    expect(res.status).toBe(200);
    // chatCompletion called only once (for claude, not gpt-4o)
    expect(mockChatCompletion).toHaveBeenCalledTimes(1);
  });
});

describe("TestBug2CodingModeKeyHealth", () => {
  beforeEach(() => {
    mockChatCompletion.mockClear();
    mockCheckModelAllowed.mockClear();
    mockGetActiveCoding.mockClear();
    mockReportSuccess.mockClear();
    mockReportFailure.mockClear();
    mockCheckModelAllowed.mockReturnValue(true);
  });

  it("report_failure_on_coding_mode_error", async () => {
    mockGetActiveCoding.mockReturnValue({ fallback_list: ["gpt-4o", "claude-3.5-sonnet"] });
    mockChatCompletion
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValueOnce({
        id: "chatcmpl-ok",
        object: "chat.completion",
        created: 1700000000,
        model: "claude-3.5-sonnet",
        choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", AUTH_HEADER)
      .send(CHAT_BODY("coding-mode"));

    expect(res.status).toBe(200);
    // First model failed → reportFailure should have been called
    expect(mockReportFailure).toHaveBeenCalled();
  });

  it("report_success_on_coding_mode_success", async () => {
    mockGetActiveCoding.mockReturnValue({ fallback_list: ["gpt-4o"] });
    mockChatCompletion.mockResolvedValue({
      id: "chatcmpl-ok",
      object: "chat.completion",
      created: 1700000000,
      model: "gpt-4o",
      choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", AUTH_HEADER)
      .send(CHAT_BODY("coding-mode"));

    expect(res.status).toBe(200);
    expect(mockReportSuccess).toHaveBeenCalled();
  });
});

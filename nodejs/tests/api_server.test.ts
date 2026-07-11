/**
 * Integration tests for the Express API server.
 *
 * Uses vi.hoisted() + vi.mock() to intercept database and provider module
 * imports, then uses supertest to exercise the HTTP endpoints.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { EventEmitter } from "events";

// ---------------------------------------------------------------------------
// Hoisted values — available inside vi.mock() factories
// ---------------------------------------------------------------------------

const { mockChatCompletion, mockMessagesApi, VALID_KEY, INACTIVE_USER_KEY } = vi.hoisted(() => {
  const mockFn = vi.fn(() =>
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
  // Native Anthropic Messages API response (for fast path /v1/messages → anthropic)
  const mockMsgFn = vi.fn(() =>
    Promise.resolve({
      id: "msg_test123",
      type: "message",
      role: "assistant",
      model: "claude-3.5-sonnet",
      content: [{ type: "text", text: "Hello from mock!" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
  );
  return {
    mockChatCompletion: mockFn,
    mockMessagesApi: mockMsgFn,
    VALID_KEY: "sk-s12ryt-valid-test-key",
    INACTIVE_USER_KEY: "sk-s12ryt-inactive-user-key",
  };
});

// ---------------------------------------------------------------------------
// Mock: database.js  (used by middleware.ts → auth)
// ---------------------------------------------------------------------------

vi.mock("../src/db/database.js", () => {
  const MOCK_OPENAI_PROVIDER = {
    providerType: "openai_chat",
    providerId: 1,
    providerName: "Test OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "test-key",
    keyStrategy: "failover",
    userAgent: "ProviderUA/1.0",
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

  return {
    getProviders: vi.fn((_enabledOnly?: boolean) => [
      {
        id: 1,
        name: "Test OpenAI",
        api_type: "openai_chat",
        base_url: "https://api.openai.com/v1",
        api_key: "test-key",
        models: "gpt-4o, gpt-4o-mini",
        enabled: 1,
        input_price: 0.005,
        output_price: 0.015,
        created_at: "2024-01-01",
        updated_at: "2024-01-01",
      },
      {
        id: 2,
        name: "Test Anthropic",
        api_type: "anthropic",
        base_url: "https://api.anthropic.com/v1",
        api_key: "test-key",
        models: "claude-3.5-sonnet, claude-3-haiku",
        enabled: 1,
        input_price: 0.003,
        output_price: 0.015,
        created_at: "2024-01-01",
        updated_at: "2024-01-01",
      },
    ]),
    getKeyByValue: vi.fn((key: string) => {
      if (key === "sk-s12ryt-valid-test-key") {
        return {
          id: 1,
          user_id: 1,
          key: "sk-s12ryt-valid-test-key",
          is_active: 1,
          created_at: "2024-01-01",
        };
      }
      if (key === "sk-s12ryt-inactive-user-key") {
        return {
          id: 2,
          user_id: 2,
          key: "sk-s12ryt-inactive-user-key",
          is_active: 1,
          created_at: "2024-01-01",
        };
      }
      return undefined;
    }),
    getUserById: vi.fn((id: number) => {
      if (id === 1) {
        return {
          id: 1,
          tg_user_id: 99999,
          username: "testuser",
          is_active: 1,
          created_at: "2024-01-01",
        };
      }
      if (id === 2) {
        return {
          id: 2,
          tg_user_id: 88888,
          username: "inactiveuser",
          is_active: 0,
          created_at: "2024-01-01",
        };
      }
      return undefined;
    }),
    recordUsage: vi.fn(),
    getSetting: vi.fn(() => null),
    initDbAsync: vi.fn(() => Promise.resolve({})),
    onProviderCacheRebuild: vi.fn(),
    rebuildProviderCache: vi.fn(),
    getAllowedModels: vi.fn((_userId: number, _apiKeyId: number | null, allModelNames: string[], _isAdmin: boolean) => {
      return allModelNames;
    }),
    checkModelAllowed: vi.fn((_userId: number, _apiKeyId: number | null, _modelName: string, _isAdmin: boolean) => {
      return true;
    }),
    lookupApiKeyCached: vi.fn((token: string) => {
      if (token === "sk-s12ryt-valid-test-key") {
        return { apiKeyId: 1, userId: 1, tgUserId: 99999, is_active: true, user_is_active: true };
      }
      // Real lookupApiKeyCached returns null when user_is_active is false (checked at DB layer)
      if (token === "sk-s12ryt-inactive-user-key") {
        return null;
      }
      return null;
    }),
    lookupModelCached: vi.fn((modelName: string) => {
      if (modelName === "alias-gpt") {
        return { ...MOCK_OPENAI_PROVIDER, originalModel: "gpt-4o" };
      }
      if (modelName === "gpt-4o" || modelName === "gpt-4o-mini") {
        return { ...MOCK_OPENAI_PROVIDER, originalModel: modelName };
      }
      if (modelName === "claude-3.5-sonnet" || modelName === "claude-3-haiku") {
        return { ...MOCK_ANTHROPIC_PROVIDER, originalModel: modelName };
      }
      return undefined;
    }),
    getAllCachedModelNames: vi.fn(() => ["alias-gpt", "gpt-4o", "gpt-4o-mini", "claude-3.5-sonnet", "claude-3-haiku"]),
    getUserByTgId: vi.fn(() => undefined),
    getActiveCodingForApiKey: vi.fn(() => null),
    incrementCodingSessionStats: vi.fn(),
    // Permission system mocks — all zeros = unlimited (no restrictions in tests)
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
    WEB_USER_TG_ID_OFFSET: 9_000_000_000,
    getWebUserById: vi.fn(() => undefined),
  };
});

// ---------------------------------------------------------------------------
// Mock: keySelector.js  (used by server.ts for multi-key selection)
// ---------------------------------------------------------------------------

vi.mock("../src/api/keySelector.js", () => ({
  selectKey: vi.fn((_providerId: number, apiKey: string) => ({ key: apiKey, keyIndex: null })),
  reportSuccess: vi.fn(),
  reportFailure: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock: provider modules  (all share the same mockChatCompletion)
// ---------------------------------------------------------------------------

vi.mock("../src/api/providers/openai.js", () => ({
  chatCompletion: mockChatCompletion,
}));

vi.mock("../src/api/providers/openaiResponse.js", () => ({
  chatCompletion: mockChatCompletion,
  responsesApi: vi.fn(() =>
    Promise.resolve({
      id: "resp-test123",
      object: "response",
      status: "completed",
      model: "gpt-4o",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Hello from mock!" }],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    }),
  ),
}));

vi.mock("../src/api/providers/anthropic.js", () => ({
  chatCompletion: mockChatCompletion,
  messagesApi: mockMessagesApi,
}));

vi.mock("../src/api/providers/google.js", () => ({
  chatCompletion: mockChatCompletion,
}));

// ---------------------------------------------------------------------------
// Import the app — AFTER all mocks are declared (vitest hoists vi.mock)
// ---------------------------------------------------------------------------

import app, { forwardStreamAndExtractUsage, extractUsageFromProviderStream } from "../src/api/server.js";
import { clearApiLogs, getApiLogs } from "../src/api/apiLogStore.js";

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const AUTH_HEADER = `Bearer ${VALID_KEY}`;

const MOCK_CHAT_RESPONSE = {
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
};

// ===========================================================================
// Test suites
// ===========================================================================

// ---------------------------------------------------------------------------
// TestHealthEndpoint
// ---------------------------------------------------------------------------

describe("TestHealthEndpoint", () => {
  it("test_health_returns_ok", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("test_health_needs_no_auth", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// TestAuthMiddleware
// ---------------------------------------------------------------------------

describe("TestAuthMiddleware", () => {
  it("test_no_auth_header_returns_401", async () => {
    const res = await request(app).get("/v1/models");
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe(
      "Missing Authorization, x-api-key, x-goog-api-key, or key query",
    );
  });

  it("test_invalid_format_returns_401", async () => {
    const res = await request(app)
      .get("/v1/models")
      .set("Authorization", "Token abc");
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe(
      "Invalid Authorization header format",
    );
  });

  it("test_wrong_prefix_returns_401", async () => {
    const res = await request(app)
      .get("/v1/models")
      .set("Authorization", "Bearer sk-other-key");
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe("Invalid API key format");
  });

  it("test_nonexistent_key_returns_401", async () => {
    const res = await request(app)
      .get("/v1/models")
      .set("Authorization", "Bearer sk-s12ryt-nonexistent");
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe("Invalid or inactive API key");
  });

  it("test_valid_key_active_user_returns_200", async () => {
    const res = await request(app)
      .get("/v1/models")
      .set("Authorization", AUTH_HEADER);
    expect(res.status).toBe(200);
  });

  it("test_valid_x_api_key_header_returns_200", async () => {
    const res = await request(app)
      .get("/v1/models")
      .set("x-api-key", VALID_KEY);
    expect(res.status).toBe(200);
  });

  it("test_invalid_x_api_key_prefix_returns_401", async () => {
    const res = await request(app)
      .get("/v1/models")
      .set("x-api-key", "sk-other-key");
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe("Invalid API key format");
  });

  it("test_valid_x_goog_api_key_header_returns_200", async () => {
    const res = await request(app)
      .get("/v1/models")
      .set("x-goog-api-key", VALID_KEY);
    expect(res.status).toBe(200);
  });

  it("test_valid_key_query_returns_200", async () => {
    const res = await request(app)
      .get("/v1/models")
      .query({ key: VALID_KEY });
    expect(res.status).toBe(200);
  });

  it("test_invalid_key_query_prefix_returns_401", async () => {
    const res = await request(app)
      .get("/v1/models")
      .query({ key: "sk-other-key" });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe("Invalid API key format");
  });

  it("test_inactive_user_key_returns_401", async () => {
    const res = await request(app)
      .get("/v1/models")
      .set("Authorization", `Bearer ${INACTIVE_USER_KEY}`);
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe("Invalid or inactive API key");
  });

  it("test_options_preflight_skips_auth", async () => {
    const res = await request(app).options("/v1/chat/completions");
    expect(res.status).not.toBe(401);
  });
});

// ---------------------------------------------------------------------------
// TestModelsEndpoint
// ---------------------------------------------------------------------------

describe("TestModelsEndpoint", () => {
  it("test_list_models_returns_list", async () => {
    const res = await request(app)
      .get("/v1/models")
      .set("Authorization", AUTH_HEADER);
    expect(res.status).toBe(200);
    expect(res.body.object).toBe("list");
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
  });

  it("test_model_objects_have_required_fields", async () => {
    const res = await request(app)
      .get("/v1/models")
      .set("Authorization", AUTH_HEADER);
    expect(res.status).toBe(200);

    for (const model of res.body.data) {
      expect(model).toHaveProperty("id");
      expect(model).toHaveProperty("object", "model");
      expect(model).toHaveProperty("created");
      expect(model).toHaveProperty("owned_by");
    }
  });

  it("test_known_models_present", async () => {
    const res = await request(app)
      .get("/v1/models")
      .set("Authorization", AUTH_HEADER);
    expect(res.status).toBe(200);

    const ids: string[] = res.body.data.map((m: { id: string }) => m.id);
    expect(ids).toContain("gpt-4o");
    expect(ids).toContain("claude-3.5-sonnet");
  });
});

// ---------------------------------------------------------------------------
// TestChatCompletionsValidation
// ---------------------------------------------------------------------------

describe("TestChatCompletionsValidation", () => {
  it("test_missing_model_returns_400", async () => {
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", AUTH_HEADER)
      .send({ messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("model is required");
  });

  it("test_empty_model_returns_400", async () => {
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", AUTH_HEADER)
      .send({ model: "", messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("model is required");
  });

  it("test_unknown_model_returns_400", async () => {
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", AUTH_HEADER)
      .send({
        model: "nonexistent-model",
        messages: [{ role: "user", content: "hi" }],
      });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("Unknown model");
  });
});

// ---------------------------------------------------------------------------
// TestChatCompletionsSuccess
// ---------------------------------------------------------------------------

describe("TestChatCompletionsSuccess", () => {
  beforeEach(() => {
    mockChatCompletion.mockReset();
    mockChatCompletion.mockResolvedValue(MOCK_CHAT_RESPONSE);
  });

  it("test_successful_non_streaming", async () => {
    clearApiLogs();

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", AUTH_HEADER)
      .set("User-Agent", "s12ryt-test-client/1.0")
      .set("X-Forwarded-For", "203.0.113.10, 10.0.0.1")
      .send({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
      });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("chatcmpl-test123");
    expect(res.body.choices[0].message.content).toBe("Hello from mock!");
    expect(res.body.usage.total_tokens).toBe(15);

    // Verify provider was called with correct config
    expect(mockChatCompletion).toHaveBeenCalledTimes(1);
    const [bodyArg, configArg] = mockChatCompletion.mock.calls[0];
    expect(bodyArg.model).toBe("gpt-4o");
    expect(configArg.baseUrl).toBe("https://api.openai.com/v1");
    expect(configArg.apiKey).toBe("test-key");
    expect(configArg.extraHeaders).toEqual({ "User-Agent": "ProviderUA/1.0" });

    const [log] = getApiLogs();
    expect(log.path).toBe("/v1/chat/completions");
    expect(log.username).toBe("99999");
    expect(log.userId).toBe("1");
    expect(log.apiKeyId).toBe("1");
    expect(log.ip).toBe("203.0.113.10");
    expect(log.userAgent).toBe("s12ryt-test-client/1.0");
  });

  it("test_provider_error_returns_502", async () => {
    mockChatCompletion.mockRejectedValueOnce(new Error("Provider timeout"));

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", AUTH_HEADER)
      .send({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
      });

    expect(res.status).toBe(502);
    expect(res.body.error.message).toBe("Provider timeout");
    expect(res.body.error.type).toBe("upstream_error");
  });

  it("test_anthropic_model_routes_correctly", async () => {
    mockChatCompletion.mockResolvedValueOnce({
      ...MOCK_CHAT_RESPONSE,
      model: "claude-3.5-sonnet",
    });

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", AUTH_HEADER)
      .send({
        model: "claude-3.5-sonnet",
        messages: [{ role: "user", content: "Hello" }],
      });

    expect(res.status).toBe(200);
    const configArg = mockChatCompletion.mock.calls[0][1];
    expect(configArg.baseUrl).toBe("https://api.anthropic.com/v1");
  });
});

// ---------------------------------------------------------------------------
// TestModelMappingApiLogs
// ---------------------------------------------------------------------------

describe("TestModelMappingApiLogs", () => {
  beforeEach(() => {
    mockChatCompletion.mockReset();
    mockChatCompletion.mockResolvedValue(MOCK_CHAT_RESPONSE);
    clearApiLogs();
  });

  it("test_chat_logs_upstream_model_for_mapped_alias", async () => {
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", AUTH_HEADER)
      .send({
        model: "alias-gpt",
        messages: [{ role: "user", content: "Hello" }],
      });

    expect(res.status).toBe(200);
    expect(mockChatCompletion).toHaveBeenCalledTimes(1);
    expect(mockChatCompletion.mock.calls[0][0].model).toBe("gpt-4o");

    const [log] = getApiLogs();
    expect(log.path).toBe("/v1/chat/completions");
    expect(log.model).toBe("alias-gpt");
    expect(log.actualModel).toBe("gpt-4o");
    expect(log.body.model).toBe("alias-gpt");
  });

  it("test_responses_logs_upstream_model_for_mapped_alias", async () => {
    const res = await request(app)
      .post("/v1/responses")
      .set("Authorization", AUTH_HEADER)
      .send({ model: "alias-gpt", input: "Hello" });

    expect(res.status).toBe(200);
    expect(res.body.model).toBe("alias-gpt");
    expect(mockChatCompletion).toHaveBeenCalledTimes(1);
    expect(mockChatCompletion.mock.calls[0][0].model).toBe("gpt-4o");

    const [log] = getApiLogs();
    expect(log.path).toBe("/v1/responses");
    expect(log.model).toBe("alias-gpt");
    expect(log.actualModel).toBe("gpt-4o");
    expect(log.body.model).toBe("alias-gpt");
  });

  it("test_messages_logs_upstream_model_for_mapped_alias", async () => {
    const res = await request(app)
      .post("/v1/messages")
      .set("Authorization", AUTH_HEADER)
      .send({
        model: "alias-gpt",
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 100,
      });

    expect(res.status).toBe(200);
    expect(res.body.model).toBe("alias-gpt");
    expect(mockChatCompletion).toHaveBeenCalledTimes(1);
    expect(mockChatCompletion.mock.calls[0][0].model).toBe("gpt-4o");

    const [log] = getApiLogs();
    expect(log.path).toBe("/v1/messages");
    expect(log.model).toBe("alias-gpt");
    expect(log.actualModel).toBe("gpt-4o");
    expect(log.body.model).toBe("alias-gpt");
  });
});

// ---------------------------------------------------------------------------
// TestResponsesEndpointValidation
// ---------------------------------------------------------------------------

describe("TestResponsesEndpointValidation", () => {
  it("test_missing_model_returns_400", async () => {
    const res = await request(app)
      .post("/v1/responses")
      .set("Authorization", AUTH_HEADER)
      .send({ input: "Hello" });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("model is required");
  });

  it("test_missing_input_returns_400", async () => {
    const res = await request(app)
      .post("/v1/responses")
      .set("Authorization", AUTH_HEADER)
      .send({ model: "gpt-4o" });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("input is required");
  });

  it("test_unknown_model_returns_400", async () => {
    const res = await request(app)
      .post("/v1/responses")
      .set("Authorization", AUTH_HEADER)
      .send({ model: "nonexistent-model", input: "Hello" });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("Unknown model");
  });

  it("test_responses_success_non_streaming", async () => {
    mockChatCompletion.mockResolvedValueOnce(MOCK_CHAT_RESPONSE);

    const res = await request(app)
      .post("/v1/responses")
      .set("Authorization", AUTH_HEADER)
      .send({ model: "gpt-4o", input: "Hello" });

    expect(res.status).toBe(200);
    expect(res.body.object).toBe("response");
    expect(res.body.status).toBe("completed");
    expect(res.body.model).toBe("gpt-4o");
    expect(res.body.output).toBeDefined();
    expect(Array.isArray(res.body.output)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TestAnthropicMessagesValidation
// ---------------------------------------------------------------------------

describe("TestAnthropicMessagesValidation", () => {
  it("test_missing_model_returns_400", async () => {
    const res = await request(app)
      .post("/v1/messages")
      .set("Authorization", AUTH_HEADER)
      .send({
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 100,
      });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("model is required");
  });

  it("test_missing_messages_returns_400", async () => {
    const res = await request(app)
      .post("/v1/messages")
      .set("Authorization", AUTH_HEADER)
      .send({ model: "claude-3.5-sonnet", max_tokens: 100 });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("messages");
  });

  it("test_empty_messages_returns_400", async () => {
    const res = await request(app)
      .post("/v1/messages")
      .set("Authorization", AUTH_HEADER)
      .send({ model: "claude-3.5-sonnet", messages: [], max_tokens: 100 });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("messages");
  });

  it("test_unknown_model_returns_400", async () => {
    const res = await request(app)
      .post("/v1/messages")
      .set("Authorization", AUTH_HEADER)
      .send({
        model: "nonexistent-model",
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 100,
      });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("Unknown model");
  });

  it("test_anthropic_success_non_streaming", async () => {
    mockChatCompletion.mockResolvedValueOnce(MOCK_CHAT_RESPONSE);

    const res = await request(app)
      .post("/v1/messages")
      .set("Authorization", AUTH_HEADER)
      .send({
        model: "claude-3.5-sonnet",
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 100,
      });

    expect(res.status).toBe(200);
    expect(res.body.type).toBe("message");
    expect(res.body.role).toBe("assistant");
    expect(res.body.content).toBeDefined();
    expect(Array.isArray(res.body.content)).toBe(true);
    expect(res.body.model).toBe("claude-3.5-sonnet");
  });

  it("test_anthropic_x_api_key_auth_success_non_streaming", async () => {
    const res = await request(app)
      .post("/v1/messages")
      .set("x-api-key", VALID_KEY)
      .send({
        model: "claude-3.5-sonnet",
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 100,
      });

    expect(res.status).toBe(200);
    expect(res.body.type).toBe("message");
    expect(res.body.model).toBe("claude-3.5-sonnet");
    expect(mockMessagesApi).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// TestPublicPaths
// ---------------------------------------------------------------------------

describe("TestPublicPaths", () => {
  it("test_root_path_no_auth", async () => {
    const res = await request(app).get("/");
    expect(res.status).not.toBe(401);
  });

  it("test_health_no_auth", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
  });

  it("test_docs_no_auth", async () => {
    const res = await request(app).get("/docs");
    expect(res.status).not.toBe(401);
  });
});

// ---------------------------------------------------------------------------
// TestStreamClientDisconnect — verify upstream is aborted when client closes
// ---------------------------------------------------------------------------

/** SSE chunk with usage so countTokensAccurate fallback is never triggered. */
const USAGE_CHUNK = new TextEncoder().encode(
  `data: {"usage":{"prompt_tokens":5,"completion_tokens":3}}\n\n`,
);

/** Lightweight mock Response — only needs EventEmitter's on/off + emit. */
function mockRes(): Response {
  return new EventEmitter() as unknown as Response;
}

describe("TestStreamClientDisconnect", () => {
  // ---- forwardStreamAndExtractUsage ----

  it("forwardStream: consumes all chunks and extracts usage when client stays", async () => {
    const TOTAL = 3;
    let yieldCount = 0;
    let returnCalled = false;

    async function* gen(): AsyncGenerator<Uint8Array> {
      try {
        for (let i = 0; i < TOTAL; i++) {
          yieldCount++;
          yield USAGE_CHUNK;
        }
      } finally {
        returnCalled = true;
      }
    }

    const written: Uint8Array[] = [];
    const usage = await forwardStreamAndExtractUsage(
      gen(), (c) => written.push(c),
      undefined, undefined, undefined, undefined,
      mockRes(),
    );

    expect(yieldCount).toBe(TOTAL);
    expect(returnCalled).toBe(true);
    expect(written.length).toBe(TOTAL);
    expect(usage.input_tokens).toBe(5);
    expect(usage.output_tokens).toBe(3);
  });

  it("forwardStream: aborts upstream and stops consuming on client disconnect", async () => {
    const TOTAL = 20;
    let yieldCount = 0;
    let returnCalled = false;

    async function* gen(): AsyncGenerator<Uint8Array> {
      try {
        for (let i = 0; i < TOTAL; i++) {
          yieldCount++;
          yield USAGE_CHUNK;
          await new Promise((r) => setTimeout(r, 10));
        }
      } finally {
        returnCalled = true;
      }
    }

    const res = mockRes();
    const promise = forwardStreamAndExtractUsage(
      gen(), () => {},
      undefined, undefined, undefined, undefined,
      res,
    );

    // Let ~3 chunks flow, then disconnect
    await new Promise((r) => setTimeout(r, 35));
    res.emit("close");

    await promise;

    expect(returnCalled).toBe(true); // generator's finally ran
    expect(yieldCount).toBeLessThan(TOTAL); // did NOT consume everything
    expect(yieldCount).toBeGreaterThanOrEqual(1); // consumed at least one
  });

  it("forwardStream: resolves without throwing on client disconnect", async () => {
    async function* infiniteGen(): AsyncGenerator<Uint8Array> {
      for (;;) {
        yield USAGE_CHUNK;
        await new Promise((r) => setTimeout(r, 5));
      }
    }

    const res = mockRes();
    const promise = forwardStreamAndExtractUsage(
      infiniteGen(), () => {},
      undefined, undefined, undefined, undefined,
      res,
    );

    setTimeout(() => res.emit("close"), 20);

    await expect(promise).resolves.toBeDefined();
  });

  // ---- extractUsageFromProviderStream ----

  it("extractUsage: completes normally when client stays connected", async () => {
    const TOTAL = 3;
    let returnCalled = false;

    async function* gen(): AsyncGenerator<Uint8Array> {
      try {
        for (let i = 0; i < TOTAL; i++) {
          yield USAGE_CHUNK;
          await new Promise((r) => setTimeout(r, 1));
        }
      } finally {
        returnCalled = true;
      }
    }

    let consumed = 0;
    await extractUsageFromProviderStream(
      gen(),
      async (passThrough) => { for await (const _ of passThrough) consumed++; },
      undefined, undefined, undefined, undefined,
      mockRes(),
    );

    expect(consumed).toBe(TOTAL);
    expect(returnCalled).toBe(true);
  });

  it("extractUsage: cancels provider stream on client disconnect", async () => {
    const TOTAL = 20;
    let yieldCount = 0;
    let returnCalled = false;

    async function* gen(): AsyncGenerator<Uint8Array> {
      try {
        for (let i = 0; i < TOTAL; i++) {
          yieldCount++;
          yield USAGE_CHUNK;
          await new Promise((r) => setTimeout(r, 10));
        }
      } finally {
        returnCalled = true;
      }
    }

    const res = mockRes();
    let consumed = 0;
    const promise = extractUsageFromProviderStream(
      gen(),
      async (passThrough) => { for await (const _ of passThrough) consumed++; },
      undefined, undefined, undefined, undefined,
      res,
    );

    await new Promise((r) => setTimeout(r, 35));
    res.emit("close");

    await promise;

    expect(returnCalled).toBe(true);
    expect(yieldCount).toBeLessThan(TOTAL);
  });

  // ---- Usage chunk injection (provider omits usage) ----

  it("forwardStream: injects synthetic usage before [DONE] when provider omits usage", async () => {
    const enc = new TextEncoder();
    async function* gen(): AsyncGenerator<Uint8Array> {
      yield enc.encode('data: {"choices":[{"delta":{"content":"Hello world output"}}]}\n\n');
      yield enc.encode('data: [DONE]\n\n');
    }

    const written: Uint8Array[] = [];
    const usage = await forwardStreamAndExtractUsage(
      gen(), (c) => written.push(c),
      "test input text", undefined, undefined, "test-model",
      mockRes(),
    );

    const allOutput = written.map((c) => new TextDecoder().decode(c)).join("");

    // Original content forwarded
    expect(allOutput).toContain("Hello world output");
    // [DONE] forwarded
    expect(allOutput).toContain("[DONE]");
    // Synthetic usage chunk injected (provider didn't return one)
    expect(allOutput).toContain("prompt_tokens");
    expect(allOutput).toContain("completion_tokens");
    // Usage appears BEFORE [DONE]
    expect(allOutput.indexOf("prompt_tokens")).toBeLessThan(allOutput.indexOf("[DONE]"));
    // Usage values are non-zero (estimated from fallback)
    expect(usage.input_tokens).toBeGreaterThan(0);
    expect(usage.output_tokens).toBeGreaterThan(0);
  });

  it("forwardStream: does NOT inject usage when provider already returned it", async () => {
    const enc = new TextEncoder();
    async function* gen(): AsyncGenerator<Uint8Array> {
      yield enc.encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n');
      yield enc.encode('data: {"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n');
      yield enc.encode('data: [DONE]\n\n');
    }

    const written: Uint8Array[] = [];
    const usage = await forwardStreamAndExtractUsage(
      gen(), (c) => written.push(c),
      "Hi", undefined, undefined, "test-model",
      mockRes(),
    );

    const allOutput = written.map((c) => new TextDecoder().decode(c)).join("");

    // Provider returned usage — values used directly
    expect(usage.input_tokens).toBe(10);
    expect(usage.output_tokens).toBe(5);
    // Only ONE usage chunk (the provider's), no synthetic injection
    const promptTokenMatches = allOutput.match(/prompt_tokens/g) || [];
    expect(promptTokenMatches.length).toBe(1);
  });

  it("forwardStream (anthropic): injects message_delta with usage before message_stop when provider omits usage", async () => {
    const enc = new TextEncoder();
    async function* gen(): AsyncGenerator<Uint8Array> {
      yield enc.encode('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello anthropic output text"}}\n\n');
      yield enc.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    }

    const written: Uint8Array[] = [];
    const usage = await forwardStreamAndExtractUsage(
      gen(), (c) => written.push(c),
      "test input text", undefined, undefined, "claude-test",
      mockRes(),
    );

    const allOutput = written.map((c) => new TextDecoder().decode(c)).join("");

    // Content forwarded
    expect(allOutput).toContain("Hello anthropic output text");
    // message_stop forwarded
    expect(allOutput).toContain("message_stop");
    // Synthetic message_delta with usage injected (provider didn't return one)
    expect(allOutput).toContain("input_tokens");
    expect(allOutput).toContain("output_tokens");
    // Usage message_delta appears BEFORE message_stop
    expect(allOutput.indexOf("message_delta")).toBeLessThan(allOutput.indexOf("message_stop"));
    // Usage values are non-zero (estimated from fallback)
    expect(usage.input_tokens).toBeGreaterThan(0);
    expect(usage.output_tokens).toBeGreaterThan(0);
  });

  it("forwardStream (anthropic): does NOT inject message_delta when provider already returned usage", async () => {
    const enc = new TextEncoder();
    async function* gen(): AsyncGenerator<Uint8Array> {
      yield enc.encode('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n');
      yield enc.encode('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":10,"output_tokens":5}}\n\n');
      yield enc.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    }

    const written: Uint8Array[] = [];
    const usage = await forwardStreamAndExtractUsage(
      gen(), (c) => written.push(c),
      "Hi", undefined, undefined, "claude-test",
      mockRes(),
    );

    const allOutput = written.map((c) => new TextDecoder().decode(c)).join("");

    // Provider returned usage — values used directly
    expect(usage.input_tokens).toBe(10);
    expect(usage.output_tokens).toBe(5);
    // Only ONE output_tokens occurrence (the provider's message_delta), no synthetic injection
    const outputTokenMatches = allOutput.match(/output_tokens/g) || [];
    expect(outputTokenMatches.length).toBe(1);
  });

  // ---- OpenAI Responses direct path: response.completed patching ----

  it("forwardStream (responses): patches usage into response.completed when provider omits usage", async () => {
    const enc = new TextEncoder();
    async function* gen(): AsyncGenerator<Uint8Array> {
      yield enc.encode('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello world test"}\n\n');
      yield enc.encode('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[],"usage":null}}\n\n');
    }

    const written: Uint8Array[] = [];
    const usage = await forwardStreamAndExtractUsage(
      gen(), (c) => written.push(c),
      "test input prompt", undefined, undefined, "gpt-4o",
      mockRes(),
    );

    const allOutput = written.map((c) => new TextDecoder().decode(c)).join("");

    // response.completed forwarded
    expect(allOutput).toContain("response.completed");
    // Usage patched into the response.completed payload
    expect(allOutput).toContain('"input_tokens"');
    expect(allOutput).toContain('"output_tokens"');
    // Fallback counted tokens
    expect(usage.input_tokens).toBeGreaterThan(0);
  });

  it("forwardStream (responses): does NOT patch usage when provider already returned it", async () => {
    const enc = new TextEncoder();
    async function* gen(): AsyncGenerator<Uint8Array> {
      yield enc.encode('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hi there"}\n\n');
      yield enc.encode('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[],"usage":{"input_tokens":15,"output_tokens":8}}}\n\n');
    }

    const written: Uint8Array[] = [];
    const usage = await forwardStreamAndExtractUsage(
      gen(), (c) => written.push(c),
      "test input", undefined, undefined, "gpt-4o",
      mockRes(),
    );

    const allOutput = written.map((c) => new TextDecoder().decode(c)).join("");

    // Provider usage used directly
    expect(usage.input_tokens).toBe(15);
    expect(usage.output_tokens).toBe(8);
    // input_tokens appears exactly once (the provider's value, forwarded as-is)
    const matches = allOutput.match(/input_tokens/g) || [];
    expect(matches.length).toBe(1);
  });

  // ---- Transform path (extractUsageFromProviderStream): fake usage injection ----

  it("extractUsage: injects fake usage chunk into passThrough when provider omits usage", async () => {
    const enc = new TextEncoder();
    async function* gen(): AsyncGenerator<Uint8Array> {
      // Chat completions chunks WITHOUT usage
      yield enc.encode('data: {"choices":[{"delta":{"content":"Hello world"}}]}\n\n');
      yield enc.encode('data: [DONE]\n\n');
    }

    const passThroughChunks: string[] = [];
    const usage = await extractUsageFromProviderStream(
      gen(),
      async (passThrough) => {
        const dec = new TextDecoder();
        for await (const chunk of passThrough) {
          passThroughChunks.push(dec.decode(chunk));
        }
      },
      "test input prompt", undefined, undefined, "gpt-4o",
      mockRes(),
    );

    const allPassThrough = passThroughChunks.join("");
    // The fake usage chunk should be injected before stream ends
    expect(allPassThrough).toContain("chatcmpl-usage-fallback");
    expect(allPassThrough).toContain('"prompt_tokens"');
    expect(allPassThrough).toContain('"completion_tokens"');
    // Fallback tokens computed
    expect(usage.input_tokens).toBeGreaterThan(0);
    expect(usage.output_tokens).toBeGreaterThan(0);
  });

  it("extractUsage: does NOT inject fake usage when provider already returned it", async () => {
    const enc = new TextEncoder();
    async function* gen(): AsyncGenerator<Uint8Array> {
      yield enc.encode('data: {"choices":[{"delta":{"content":"Hi there"}}]}\n\n');
      yield enc.encode('data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n');
      yield enc.encode('data: [DONE]\n\n');
    }

    const passThroughChunks: string[] = [];
    const usage = await extractUsageFromProviderStream(
      gen(),
      async (passThrough) => {
        const dec = new TextDecoder();
        for await (const chunk of passThrough) {
          passThroughChunks.push(dec.decode(chunk));
        }
      },
      "test input", undefined, undefined, "gpt-4o",
      mockRes(),
    );

    const allPassThrough = passThroughChunks.join("");
    // No fake chunk injected
    expect(allPassThrough).not.toContain("chatcmpl-usage-fallback");
    // Provider usage used
    expect(usage.input_tokens).toBe(10);
    expect(usage.output_tokens).toBe(5);
  });
});

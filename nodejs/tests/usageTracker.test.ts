/**
 * Unit tests for usageTracker token extraction and estimation.
 *
 * Mocks database.js and rateLimiter.js (module-level imports in usageTracker)
 * so we can test the pure functions without DB / Redis side effects.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../src/db/database.js", () => ({
  recordUsage: vi.fn(),
}));

vi.mock("../src/api/rateLimiter.js", () => ({
  recordTokenUsage: vi.fn(),
}));

import { extractInputTextFromBody, estimateTokens } from "../src/api/usageTracker.js";

// ---------------------------------------------------------------------------
// extractInputTextFromBody
// ---------------------------------------------------------------------------

describe("extractInputTextFromBody", () => {
  it("returns empty string for undefined body", () => {
    expect(extractInputTextFromBody(undefined)).toBe("");
  });

  it("extracts chat completions messages content", () => {
    const body = { messages: [{ role: "user", content: "Hello world" }] };
    expect(extractInputTextFromBody(body)).toContain("Hello world");
  });

  it("extracts multimodal text parts from messages", () => {
    const body = {
      messages: [
        { role: "user", content: [{ type: "text", text: "image please" }] },
      ],
    };
    expect(extractInputTextFromBody(body)).toContain("image please");
  });

  it("extracts responses API input as string", () => {
    const body = { input: "simple prompt" };
    expect(extractInputTextFromBody(body)).toContain("simple prompt");
  });

  it("extracts responses API input array with input_text parts", () => {
    const body = {
      input: [
        { role: "user", content: [{ type: "input_text", text: "Hi there" }] },
      ],
    };
    expect(extractInputTextFromBody(body)).toContain("Hi there");
  });

  it("extracts instructions (system prompt)", () => {
    const body = { instructions: "You are helpful." };
    expect(extractInputTextFromBody(body)).toContain("You are helpful.");
  });

  // ---- The key fix: tools definitions ----

  it("includes tools definitions in extracted text", () => {
    const tools = [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get the weather for a city",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      },
    ];
    const body = {
      messages: [{ role: "user", content: "What's the weather?" }],
      tools,
    };
    const text = extractInputTextFromBody(body);

    // Message content still present
    expect(text).toContain("What's the weather?");
    // Tool definition content present
    expect(text).toContain("get_weather");
    expect(text).toContain("Get the weather for a city");
  });

  it("includes legacy functions definitions", () => {
    const functions = [
      { name: "calculate", description: "Do math", parameters: { type: "object" } },
    ];
    const body = {
      messages: [{ role: "user", content: "Calculate 1+1" }],
      functions,
    };
    const text = extractInputTextFromBody(body);
    expect(text).toContain("calculate");
    expect(text).toContain("Do math");
  });

  it("does not add tools section when tools array is empty", () => {
    const body = {
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    };
    const text = extractInputTextFromBody(body);
    expect(text).toBe("hi");
  });

  it("tools contribute significant token estimate (agentic workload)", () => {
    // Simulate 50 tool definitions like a real agentic workload
    const tools = Array.from({ length: 50 }, (_, i) => ({
      type: "function",
      function: {
        name: `tool_${i}`,
        description: `This is tool number ${i} that does something useful with a fairly long description to simulate real-world tool definitions.`,
        parameters: {
          type: "object",
          properties: {
            arg1: { type: "string", description: "First argument" },
            arg2: { type: "number", description: "Second argument" },
          },
        },
      },
    }));

    const bodyWithoutTools = {
      messages: [{ role: "user", content: "Run the tools" }],
    };
    const bodyWithTools = { ...bodyWithoutTools, tools };

    const textWithout = extractInputTextFromBody(bodyWithoutTools);
    const textWith = extractInputTextFromBody(bodyWithTools);

    const tokensWithout = estimateTokens(textWithout);
    const tokensWith = estimateTokens(textWith);

    // Tools should add a significant number of tokens
    const toolTokens = tokensWith - tokensWithout;
    expect(toolTokens).toBeGreaterThan(500);
  });
});

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

describe("estimateTokens", () => {
  it("returns 0 for null/undefined/empty", () => {
    expect(estimateTokens(null)).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
    expect(estimateTokens("")).toBe(0);
  });

  it("estimates ASCII text (~4 chars per token)", () => {
    const text = "Hello world, this is a test"; // 27 chars
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(15); // ~27/4 ≈ 7
  });

  it("estimates CJK text with higher ratio", () => {
    const text = "你好世界這是一個測試"; // 10 CJK chars
    const tokens = estimateTokens(text);
    // CJK * 1.2 = 12
    expect(tokens).toBe(12);
  });
});

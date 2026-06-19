/**
 * Unit tests for thinkingParser.ts — thinking effort / reasoning intensity feature.
 *
 * Tests cover:
 * 1. Model suffix parsing: "o3(high)" → ("o3", "high")
 * 2. Extract thinking level from body params (reasoning_effort / thinking_effort / anthropic reverse-map)
 * 3. Full preprocessThinking pipeline (suffix + param resolution)
 * 4. Provider-specific injection: Anthropic, OpenAI Chat, OpenAI Response, Google
 * 5. Edge cases: no level, invalid level, max_tokens enforcement
 */

import { describe, it, expect } from "vitest";
import {
  parseModelThinkingSuffix,
  extractThinkingLevel,
  preprocessThinking,
  injectForAnthropic,
  injectForOpenAIChat,
  injectForOpenAIResponse,
  injectForGoogle,
  ANTHROPIC_THINKING_BUDGET,
  GOOGLE_THINKING_BUDGET,
  GOOGLE_THINKING_LEVEL,
} from "../src/api/thinkingParser.js";

// ---------------------------------------------------------------------------
// parseModelThinkingSuffix
// ---------------------------------------------------------------------------

describe("parseModelThinkingSuffix", () => {
  it("parses basic suffix", () => {
    expect(parseModelThinkingSuffix("o3(high)")).toEqual({ model: "o3", thinkingLevel: "high" });
  });

  it("parses medium suffix", () => {
    expect(parseModelThinkingSuffix("claude-sonnet(medium)")).toEqual({ model: "claude-sonnet", thinkingLevel: "medium" });
  });

  it("parses low suffix", () => {
    expect(parseModelThinkingSuffix("gemini-2.5-pro(low)")).toEqual({ model: "gemini-2.5-pro", thinkingLevel: "low" });
  });

  it("parses xhigh suffix", () => {
    expect(parseModelThinkingSuffix("gpt-5.1(xhigh)")).toEqual({ model: "gpt-5.1", thinkingLevel: "xhigh" });
  });

  it("parses minimal suffix", () => {
    expect(parseModelThinkingSuffix("gpt-5(minimal)")).toEqual({ model: "gpt-5", thinkingLevel: "minimal" });
  });

  it("parses none suffix", () => {
    expect(parseModelThinkingSuffix("gpt-4o(none)")).toEqual({ model: "gpt-4o", thinkingLevel: "none" });
  });

  it("is case insensitive", () => {
    expect(parseModelThinkingSuffix("o3(HIGH)")).toEqual({ model: "o3", thinkingLevel: "high" });
    expect(parseModelThinkingSuffix("o3(High)")).toEqual({ model: "o3", thinkingLevel: "high" });
    expect(parseModelThinkingSuffix("o3(XHIGH)")).toEqual({ model: "o3", thinkingLevel: "xhigh" });
  });

  it("handles whitespace in parens", () => {
    expect(parseModelThinkingSuffix("o3( high )")).toEqual({ model: "o3", thinkingLevel: "high" });
    expect(parseModelThinkingSuffix("o3(  low  )")).toEqual({ model: "o3", thinkingLevel: "low" });
  });

  it("returns undefined level for no suffix", () => {
    const result = parseModelThinkingSuffix("gpt-4o");
    expect(result.model).toBe("gpt-4o");
    expect(result.thinkingLevel).toBeUndefined();
  });

  it("returns invalidLevel for unrecognized suffix word", () => {
    const result = parseModelThinkingSuffix("model(custom)");
    expect(result.model).toBe("model");
    expect(result.thinkingLevel).toBeUndefined();
    expect(result.invalidLevel).toBe("custom");
  });

  it("handles model with special chars", () => {
    expect(parseModelThinkingSuffix("deepseek-r1(high)")).toEqual({ model: "deepseek-r1", thinkingLevel: "high" });
  });

  it("handles trailing space after parens", () => {
    expect(parseModelThinkingSuffix("o3(high)  ")).toEqual({ model: "o3", thinkingLevel: "high" });
  });
});

// ---------------------------------------------------------------------------
// extractThinkingLevel
// ---------------------------------------------------------------------------

describe("extractThinkingLevel", () => {
  it("extracts from reasoning_effort", () => {
    expect(extractThinkingLevel({ reasoning_effort: "high" })).toBe("high");
    expect(extractThinkingLevel({ reasoning_effort: "low" })).toBe("low");
  });

  it("extracts new levels from reasoning_effort", () => {
    expect(extractThinkingLevel({ reasoning_effort: "xhigh" })).toBe("xhigh");
    expect(extractThinkingLevel({ reasoning_effort: "minimal" })).toBe("minimal");
    expect(extractThinkingLevel({ reasoning_effort: "none" })).toBe("none");
  });

  it("extracts from thinking_effort", () => {
    expect(extractThinkingLevel({ thinking_effort: "medium" })).toBe("medium");
  });

  it("reasoning_effort takes priority over thinking_effort", () => {
    expect(extractThinkingLevel({ reasoning_effort: "high", thinking_effort: "low" })).toBe("high");
  });

  it("is case insensitive", () => {
    expect(extractThinkingLevel({ reasoning_effort: "HIGH" })).toBe("high");
    expect(extractThinkingLevel({ reasoning_effort: "XHIGH" })).toBe("xhigh");
  });

  it("ignores invalid level", () => {
    expect(extractThinkingLevel({ reasoning_effort: "ultra" })).toBeUndefined();
    expect(extractThinkingLevel({ thinking_effort: "extreme" })).toBeUndefined();
  });

  it("returns undefined when no level present", () => {
    expect(extractThinkingLevel({ model: "gpt-4o" })).toBeUndefined();
    expect(extractThinkingLevel({})).toBeUndefined();
  });

  it("reverse-maps anthropic budget_tokens xhigh (>=48000)", () => {
    expect(
      extractThinkingLevel({ thinking: { type: "enabled", budget_tokens: 64000 } })
    ).toBe("xhigh");
  });

  it("reverse-maps anthropic budget_tokens high (>=24000)", () => {
    expect(
      extractThinkingLevel({ thinking: { type: "enabled", budget_tokens: 32048 } })
    ).toBe("high");
  });

  it("reverse-maps anthropic budget_tokens medium (>=10000)", () => {
    expect(
      extractThinkingLevel({ thinking: { type: "enabled", budget_tokens: 16000 } })
    ).toBe("medium");
  });

  it("reverse-maps anthropic budget_tokens low (>=3000)", () => {
    expect(
      extractThinkingLevel({ thinking: { type: "enabled", budget_tokens: 5000 } })
    ).toBe("low");
  });

  it("reverse-maps anthropic budget_tokens minimal (<3000)", () => {
    expect(
      extractThinkingLevel({ thinking: { type: "enabled", budget_tokens: 1024 } })
    ).toBe("minimal");
  });

  it("maps disabled anthropic thinking to none", () => {
    expect(
      extractThinkingLevel({ thinking: { type: "disabled", budget_tokens: 32048 } })
    ).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// preprocessThinking
// ---------------------------------------------------------------------------

describe("preprocessThinking", () => {
  it("strips suffix and sets thinking_effort", () => {
    const body: Record<string, unknown> = { model: "o3(high)", messages: [] };
    preprocessThinking(body);
    expect(body.model).toBe("o3");
    expect(body.thinking_effort).toBe("high");
  });

  it("suffix overrides body param", () => {
    const body: Record<string, unknown> = { model: "o3(high)", reasoning_effort: "low" };
    preprocessThinking(body);
    expect(body.model).toBe("o3");
    expect(body.thinking_effort).toBe("high");
  });

  it("no suffix uses body param", () => {
    const body: Record<string, unknown> = { model: "gpt-4o", reasoning_effort: "medium" };
    preprocessThinking(body);
    expect(body.model).toBe("gpt-4o");
    expect(body.thinking_effort).toBe("medium");
  });

  it("no suffix no param → no thinking_effort", () => {
    const body: Record<string, unknown> = { model: "gpt-4o" };
    preprocessThinking(body);
    expect(body.model).toBe("gpt-4o");
    expect(body.thinking_effort).toBeUndefined();
  });

  it("empty model string → no thinking_effort", () => {
    const body: Record<string, unknown> = { model: "" };
    preprocessThinking(body);
    expect(body.thinking_effort).toBeUndefined();
  });

  it("missing model → no thinking_effort", () => {
    const body: Record<string, unknown> = { messages: [] };
    preprocessThinking(body);
    expect(body.thinking_effort).toBeUndefined();
  });

  it("non-string model → no thinking_effort", () => {
    const body: Record<string, unknown> = { model: 12345 };
    preprocessThinking(body);
    expect(body.thinking_effort).toBeUndefined();
  });

  it("throws on invalid suffix level", () => {
    const body: Record<string, unknown> = { model: "gpt-4o(extreme)" };
    expect(() => preprocessThinking(body)).toThrow(/Invalid thinking level/);
  });

  it("strips model even when throwing on invalid level", () => {
    const body: Record<string, unknown> = { model: "gpt-4o(extreme)" };
    expect(() => preprocessThinking(body)).toThrow();
    // model should still be stripped to real name even though it throws
    expect(body.model).toBe("gpt-4o");
  });

  it("handles new levels via suffix", () => {
    const body: Record<string, unknown> = { model: "gpt-5.1(xhigh)" };
    preprocessThinking(body);
    expect(body.model).toBe("gpt-5.1");
    expect(body.thinking_effort).toBe("xhigh");
  });

  it("handles none level via suffix", () => {
    const body: Record<string, unknown> = { model: "gpt-4o(none)" };
    preprocessThinking(body);
    expect(body.model).toBe("gpt-4o");
    expect(body.thinking_effort).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// injectForAnthropic
// ---------------------------------------------------------------------------

describe("injectForAnthropic", () => {
  it("sets thinking with budget for high", () => {
    const body: Record<string, unknown> = { max_tokens: 4096 };
    injectForAnthropic(body, "high");
    expect(body.thinking).toEqual({
      type: "enabled",
      budget_tokens: ANTHROPIC_THINKING_BUDGET.high,
    });
  });

  it("sets thinking with budget for medium", () => {
    const body: Record<string, unknown> = {};
    injectForAnthropic(body, "medium");
    expect((body.thinking as Record<string, unknown>).budget_tokens).toBe(
      ANTHROPIC_THINKING_BUDGET.medium
    );
  });

  it("sets disabled for none level", () => {
    const body: Record<string, unknown> = {};
    injectForAnthropic(body, "none");
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  it("sets minimal budget (1024)", () => {
    const body: Record<string, unknown> = {};
    injectForAnthropic(body, "minimal");
    expect(body.thinking).toEqual({
      type: "enabled",
      budget_tokens: ANTHROPIC_THINKING_BUDGET.minimal,
    });
    expect(ANTHROPIC_THINKING_BUDGET.minimal).toBe(1024);
  });

  it("sets xhigh budget", () => {
    const body: Record<string, unknown> = {};
    injectForAnthropic(body, "xhigh");
    expect(body.thinking).toEqual({
      type: "enabled",
      budget_tokens: ANTHROPIC_THINKING_BUDGET.xhigh,
    });
  });

  it("does not set max_tokens for none level", () => {
    const body: Record<string, unknown> = { max_tokens: 100 };
    injectForAnthropic(body, "none");
    expect(body.max_tokens).toBe(100);
  });

  it("raises max_tokens if too small", () => {
    const body: Record<string, unknown> = { max_tokens: 100 };
    injectForAnthropic(body, "high");
    expect(body.max_tokens as number).toBeGreaterThan(ANTHROPIC_THINKING_BUDGET.high);
  });

  it("does not raise max_tokens if sufficient", () => {
    const body: Record<string, unknown> = { max_tokens: 65536 };
    injectForAnthropic(body, "low");
    expect(body.max_tokens).toBe(65536);
  });

  it("sets max_tokens if missing", () => {
    const body: Record<string, unknown> = {};
    injectForAnthropic(body, "high");
    expect(body.max_tokens).toBeDefined();
    expect(body.max_tokens as number).toBeGreaterThan(ANTHROPIC_THINKING_BUDGET.high);
  });
});

// ---------------------------------------------------------------------------
// injectForOpenAIChat
// ---------------------------------------------------------------------------

describe("injectForOpenAIChat", () => {
  it("sets reasoning_effort", () => {
    const body: Record<string, unknown> = { model: "o3" };
    injectForOpenAIChat(body, "high");
    expect(body.reasoning_effort).toBe("high");
  });

  it("sets medium", () => {
    const body: Record<string, unknown> = {};
    injectForOpenAIChat(body, "medium");
    expect(body.reasoning_effort).toBe("medium");
  });

  it("sets xhigh", () => {
    const body: Record<string, unknown> = {};
    injectForOpenAIChat(body, "xhigh");
    expect(body.reasoning_effort).toBe("xhigh");
  });

  it("sets none", () => {
    const body: Record<string, unknown> = {};
    injectForOpenAIChat(body, "none");
    expect(body.reasoning_effort).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// injectForOpenAIResponse
// ---------------------------------------------------------------------------

describe("injectForOpenAIResponse", () => {
  it("sets reasoning object", () => {
    const body: Record<string, unknown> = { model: "o3" };
    injectForOpenAIResponse(body, "high");
    expect(body.reasoning).toEqual({ effort: "high" });
  });

  it("sets low", () => {
    const body: Record<string, unknown> = {};
    injectForOpenAIResponse(body, "low");
    expect((body.reasoning as Record<string, unknown>).effort).toBe("low");
  });

  it("sets minimal", () => {
    const body: Record<string, unknown> = {};
    injectForOpenAIResponse(body, "minimal");
    expect(body.reasoning).toEqual({ effort: "minimal" });
  });
});

// ---------------------------------------------------------------------------
// injectForGoogle
// ---------------------------------------------------------------------------

describe("injectForGoogle", () => {
  it("creates nested generationConfig with budget", () => {
    const body: Record<string, unknown> = {};
    injectForGoogle(body, "high");
    expect(
      (body.generationConfig as Record<string, unknown>).thinkingConfig
    ).toEqual({ thinkingBudget: GOOGLE_THINKING_BUDGET.high, thinkingLevel: GOOGLE_THINKING_LEVEL.high });
  });

  it("preserves existing generationConfig", () => {
    const body: Record<string, unknown> = {
      generationConfig: { temperature: 0.7 },
    };
    injectForGoogle(body, "medium");
    const gc = body.generationConfig as Record<string, unknown>;
    expect(gc.temperature).toBe(0.7);
    const tc = gc.thinkingConfig as Record<string, unknown>;
    expect(tc.thinkingBudget).toBe(GOOGLE_THINKING_BUDGET.medium);
    expect(tc.thinkingLevel).toBe(GOOGLE_THINKING_LEVEL.medium);
  });

  it("preserves existing thinkingConfig fields", () => {
    const body: Record<string, unknown> = {
      generationConfig: { thinkingConfig: { includeThoughts: true } },
    };
    injectForGoogle(body, "high");
    const tc = (
      (body.generationConfig as Record<string, unknown>).thinkingConfig as Record<string, unknown>
    );
    expect(tc.includeThoughts).toBe(true);
    expect(tc.thinkingBudget).toBe(GOOGLE_THINKING_BUDGET.high);
  });

  it("low level sets budget and thinkingLevel", () => {
    const body: Record<string, unknown> = {};
    injectForGoogle(body, "low");
    const tc = (
      (body.generationConfig as Record<string, unknown>).thinkingConfig as Record<string, unknown>
    );
    expect(tc.thinkingBudget).toBe(GOOGLE_THINKING_BUDGET.low);
    expect(tc.thinkingLevel).toBe(GOOGLE_THINKING_LEVEL.low);
  });

  it("none level sets budget to 0 without thinkingLevel", () => {
    const body: Record<string, unknown> = {};
    injectForGoogle(body, "none");
    const tc = (
      (body.generationConfig as Record<string, unknown>).thinkingConfig as Record<string, unknown>
    );
    expect(tc.thinkingBudget).toBe(0);
    expect(tc.thinkingLevel).toBeUndefined();
  });

  it("xhigh level maps to high thinkingLevel", () => {
    const body: Record<string, unknown> = {};
    injectForGoogle(body, "xhigh");
    const tc = (
      (body.generationConfig as Record<string, unknown>).thinkingConfig as Record<string, unknown>
    );
    expect(tc.thinkingBudget).toBe(GOOGLE_THINKING_BUDGET.xhigh);
    expect(tc.thinkingLevel).toBe("high");
  });

  it("minimal level sets minimal thinkingLevel", () => {
    const body: Record<string, unknown> = {};
    injectForGoogle(body, "minimal");
    const tc = (
      (body.generationConfig as Record<string, unknown>).thinkingConfig as Record<string, unknown>
    );
    expect(tc.thinkingBudget).toBe(GOOGLE_THINKING_BUDGET.minimal);
    expect(tc.thinkingLevel).toBe("minimal");
  });
});

// ---------------------------------------------------------------------------
// Budget value sanity checks
// ---------------------------------------------------------------------------

describe("Budget value ordering", () => {
  it("anthropic budgets are ordered xhigh > high > medium > low > minimal", () => {
    expect(ANTHROPIC_THINKING_BUDGET.xhigh).toBeGreaterThan(ANTHROPIC_THINKING_BUDGET.high);
    expect(ANTHROPIC_THINKING_BUDGET.high).toBeGreaterThan(ANTHROPIC_THINKING_BUDGET.medium);
    expect(ANTHROPIC_THINKING_BUDGET.medium).toBeGreaterThan(ANTHROPIC_THINKING_BUDGET.low);
    expect(ANTHROPIC_THINKING_BUDGET.low).toBeGreaterThan(ANTHROPIC_THINKING_BUDGET.minimal);
  });

  it("google budgets are ordered xhigh > high > medium > low > minimal > none", () => {
    expect(GOOGLE_THINKING_BUDGET.xhigh).toBeGreaterThan(GOOGLE_THINKING_BUDGET.high);
    expect(GOOGLE_THINKING_BUDGET.high).toBeGreaterThan(GOOGLE_THINKING_BUDGET.medium);
    expect(GOOGLE_THINKING_BUDGET.medium).toBeGreaterThan(GOOGLE_THINKING_BUDGET.low);
    expect(GOOGLE_THINKING_BUDGET.low).toBeGreaterThan(GOOGLE_THINKING_BUDGET.minimal);
    expect(GOOGLE_THINKING_BUDGET.minimal).toBeGreaterThan(GOOGLE_THINKING_BUDGET.none);
  });
});

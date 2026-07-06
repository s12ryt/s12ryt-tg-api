/**
 * Token usage tracking and cost calculation.
 *
 * Handles provider-specific usage extraction, cost calculation, and recording.
 * Usage recording is non-blocking — enqueues to a write queue for batched DB writes.
 */

import { encode } from "gpt-tokenizer";
import { recordUsage as dbRecordUsage } from "../db/database.js";
import { recordTokenUsage } from "./rateLimiter.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

/** Minimal provider config for remote token-counting API calls. */
export interface ProviderConfig {
  baseUrl?: string;
  apiKey: string;
}

export interface Cost {
  input_cost: number;
  output_cost: number;
}

export interface UsageRecordParams {
  apiKeyId: string;
  userId?: string;
  providerId: string;
  inputTokens: number;
  outputTokens: number;
  inputCost: number;
  outputCost: number;
  model: string;
}

// ---------------------------------------------------------------------------
// Usage extraction
// ---------------------------------------------------------------------------

/**
 * Extract input/output token counts from a provider response.
 *
 * All provider adapters already convert responses to OpenAI format,
 * so we can rely on the standard `usage` field.
 */
export function extractUsage(
  providerType: string,
  responseData: Record<string, any>
): Usage {
  const usage = responseData.usage ?? {};

  // OpenAI format (native or already converted)
  let inputTokens: number = usage.prompt_tokens ?? 0;
  let outputTokens: number = usage.completion_tokens ?? 0;

  // Fallback: some responses may use different key names
  if (!inputTokens) inputTokens = usage.input_tokens ?? 0;
  if (!outputTokens) outputTokens = usage.output_tokens ?? 0;

  return { input_tokens: inputTokens, output_tokens: outputTokens };
}

/**
 * Extract usage from a provider response, falling back to accurate token counting
 * when the provider did not return any usage data (input_tokens and output_tokens both 0).
 *
 * Accuracy depends on providerType:
 * - OpenAI (openai_chat / openai_response): local BPE tokenizer (gpt-tokenizer)
 * - Anthropic: POST /v1/messages/count_tokens API (requires providerConfig)
 * - Google: POST :countTokens API (requires providerConfig)
 * - Any API failure → falls back to CJK-aware heuristic (estimateTokens)
 *
 * @param body             The original request body (used to extract input text).
 * @param providerConfig   Provider connection config (baseUrl, apiKey) for remote counting.
 * @param modelName        Upstream model name (for selecting the correct tokenizer encoding).
 */
export async function extractUsageWithFallback(
  providerType: string,
  responseData: Record<string, any>,
  body?: Record<string, any>,
  providerConfig?: ProviderConfig,
  modelName?: string,
): Promise<Usage> {
  const usage = extractUsage(providerType, responseData);

  // Count input/output independently — some providers return only one of the two
  if (usage.input_tokens === 0 && body) {
    const inputText = extractInputTextFromBody(body);
    if (inputText) {
      usage.input_tokens = await countTokensAccurate(providerType, inputText, providerConfig, modelName);
    }
  }
  if (usage.output_tokens === 0) {
    const outputText = extractOutputTextFromResponse(responseData);
    if (outputText) {
      usage.output_tokens = await countTokensAccurate(providerType, outputText, providerConfig, modelName);
    }
  }

  return usage;
}

// ---------------------------------------------------------------------------
// Token estimation (CJK-aware heuristic, zero dependencies)
// ---------------------------------------------------------------------------

/**
 * Roughly estimate token count from text.
 *
 * Uses a CJK-aware heuristic: CJK characters (including Hiragana, Katakana,
 * and Hangul) are counted at ~1.2 tokens each; all other characters at ~0.25
 * tokens each (4 chars per token).  This is accurate enough for cost tracking
 * when the upstream provider does not return usage data.
 */
export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (
      (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
      (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
      (code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility Ideographs
      (code >= 0x3040 && code <= 0x309f) || // Hiragana
      (code >= 0x30a0 && code <= 0x30ff) || // Katakana
      (code >= 0xac00 && code <= 0xd7af)   // Hangul Syllables
    ) {
      cjk++;
    } else {
      other++;
    }
  }
  return Math.ceil(cjk * 1.2 + other / 4);
}

// ---------------------------------------------------------------------------
// Accurate token counting (provider-specific)
// ---------------------------------------------------------------------------

/** Cache for cl100k_base encoding (lazy loaded on first use). */
let _cl100kEncode: ((text: string) => number[]) | null = null;

/**
 * Map an OpenAI model name to its BPE encoding.
 * - o200k_base: gpt-4o, o1, o3, o4, gpt-4.1, gpt-4.5, gpt-5 and newer
 * - cl100k_base: gpt-4 (non-4o), gpt-3.5 and older
 */
function getOpenAIEncoding(model: string): "o200k_base" | "cl100k_base" {
  const m = model.toLowerCase();
  if (
    m.startsWith("gpt-4o") ||
    m.startsWith("gpt-4.1") ||
    m.startsWith("gpt-4.5") ||
    m.startsWith("gpt-5") ||
    m.startsWith("o1") ||
    m.startsWith("o3") ||
    m.startsWith("o4")
  ) {
    return "o200k_base";
  }
  if (m.startsWith("gpt-4") || m.startsWith("gpt-3.5")) {
    return "cl100k_base";
  }
  // Default to o200k_base for unknown modern models
  return "o200k_base";
}

/**
 * Count tokens using OpenAI's BPE tokenizer (local, zero network).
 * Uses gpt-tokenizer with the model-appropriate encoding.
 */
async function countTokensOpenAI(text: string, model: string): Promise<number> {
  const encoding = getOpenAIEncoding(model);
  if (encoding === "o200k_base") {
    // Default import uses o200k_base
    return encode(text).length;
  }
  // Lazy-load cl100k_base encoding (only needed for gpt-4 / gpt-3.5)
  if (!_cl100kEncode) {
    const mod = await import("gpt-tokenizer/encoding/cl100k_base");
    _cl100kEncode = mod.encode;
  }
  return _cl100kEncode(text).length;
}

/**
 * Count tokens via Anthropic's count_tokens API.
 * POST {baseUrl}/v1/messages/count_tokens
 */
async function countTokensAnthropic(
  text: string,
  model: string,
  config: ProviderConfig,
): Promise<number> {
  const baseUrl = (config.baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
  const resp = await fetch(`${baseUrl}/v1/messages/count_tokens`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: text }],
      max_tokens: 1,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`Anthropic count_tokens HTTP ${resp.status}`);
  const data = (await resp.json()) as { input_tokens: number };
  return data.input_tokens;
}

/**
 * Count tokens via Google's countTokens API.
 * POST {baseUrl}/v1beta/models/{model}:countTokens?key={apiKey}
 */
async function countTokensGoogle(
  text: string,
  model: string,
  config: ProviderConfig,
): Promise<number> {
  const baseUrl = (config.baseUrl || "https://generativelanguage.googleapis.com").replace(/\/+$/, "");
  const resp = await fetch(
    `${baseUrl}/v1beta/models/${model}:countTokens?key=${config.apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text }] }],
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!resp.ok) throw new Error(`Google countTokens HTTP ${resp.status}`);
  const data = (await resp.json()) as { totalTokens: number };
  return data.totalTokens;
}

/**
 * Accurately count tokens using the provider-appropriate method.
 *
 * - OpenAI: local BPE tokenizer (gpt-tokenizer) — zero network
 * - Anthropic: POST /v1/messages/count_tokens API
 * - Google: POST :countTokens API
 *
 * Falls back to CJK-aware heuristic (estimateTokens) on any error or
 * when provider config is missing.
 */
export async function countTokensAccurate(
  providerType: string,
  text: string,
  config?: ProviderConfig,
  modelName?: string,
): Promise<number> {
  try {
    if (providerType === "openai_chat" || providerType === "openai_response") {
      if (modelName) return await countTokensOpenAI(text, modelName);
    }
    if (providerType === "anthropic" && config?.apiKey && modelName) {
      return await countTokensAnthropic(text, modelName, config);
    }
    if (providerType === "google" && config?.apiKey && modelName) {
      return await countTokensGoogle(text, modelName, config);
    }
  } catch (err) {
    console.warn(`[token-count] Accurate counting failed, using heuristic: ${err}`);
  }
  return estimateTokens(text);
}

/**
 * Extract input text from a request body.
 *
 * Supports three API formats:
 * - Chat Completions: body.messages[].content (string or multimodal array)
 * - Responses API: body.input (string or array of {role, content})
 * - Responses API: body.instructions (system prompt string)
 */
export function extractInputTextFromBody(body: Record<string, any> | undefined): string {
  if (!body) return "";
  const parts: string[] = [];

  // Chat Completions format: messages[].content
  const messages = body.messages;
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      if (!msg) continue;
      const content = msg.content;
      if (typeof content === "string") {
        parts.push(content);
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (!part) continue;
          if (part.type === "text" && typeof part.text === "string") {
            parts.push(part.text);
          } else if (part.type === "tool_result") {
            // Anthropic tool_result: content can be a string or array of text blocks
            const trContent = part.content;
            if (typeof trContent === "string") {
              parts.push(trContent);
            } else if (Array.isArray(trContent)) {
              for (const tp of trContent) {
                if (tp?.type === "text" && typeof tp.text === "string") parts.push(tp.text);
              }
            }
          } else if (part.type === "tool_use") {
            // Anthropic tool_use: name + input are part of conversation context
            if (typeof part.name === "string") parts.push(part.name);
            if (part.input != null) parts.push(JSON.stringify(part.input));
          }
        }
      }
    }
  }

  // Responses API format: input as string
  const input = body.input;
  if (typeof input === "string") {
    parts.push(input);
  } else if (Array.isArray(input)) {
    // Responses API format: input as array of {role, content}
    for (const item of input) {
      if (!item) continue;
      const content = item.content;
      if (typeof content === "string") {
        parts.push(content);
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (typeof part === "string") {
            parts.push(part);
          } else if (part?.type === "text" || part?.type === "input_text") {
            if (typeof part.text === "string") parts.push(part.text);
          }
        }
      }
    }
  }

  // Responses API format: instructions (system prompt)
  if (typeof body.instructions === "string") {
    parts.push(body.instructions);
  }

  // Anthropic Messages API format: system prompt
  // Can be a string or an array of content blocks [{type: "text", text: "..."}]
  const system = body.system;
  if (typeof system === "string") {
    parts.push(system);
  } else if (Array.isArray(system)) {
    for (const part of system) {
      if (part?.type === "text" && typeof part.text === "string") {
        parts.push(part.text);
      }
    }
  }

  // Tool / function definitions — providers count these as input tokens
  // but they are not captured by message content extraction above.
  // We serialize the full schema so the tokenizer can approximate the cost.
  const tools = body.tools;
  if (Array.isArray(tools) && tools.length > 0) {
    parts.push(JSON.stringify(tools));
  }
  // Legacy OpenAI function calling (deprecated but still used by some clients)
  const functions = body.functions;
  if (Array.isArray(functions) && functions.length > 0) {
    parts.push(JSON.stringify(functions));
  }

  return parts.join(" ");
}

/**
 * Extract output text from a non-streaming response.
 *
 * Supports two API response formats:
 * - Chat Completions: choices[].message.content + reasoning_content
 * - Responses API: output[].content[] (with type output_text/text)
 */
export function extractOutputTextFromResponse(responseData: Record<string, any>): string {
  const parts: string[] = [];

  // Chat Completions format: choices[].message.content + reasoning_content
  const choices = responseData.choices;
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      const msg = choice?.message;
      if (!msg) continue;
      if (typeof msg.content === "string") parts.push(msg.content);
      if (typeof msg.reasoning_content === "string") parts.push(msg.reasoning_content);
    }
  }

  // Responses API format: output[].content[]
  const outputItems = responseData.output;
  if (Array.isArray(outputItems)) {
    for (const item of outputItems) {
      if (!item) continue;
      const content = item.content;
      if (typeof content === "string") {
        parts.push(content);
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (typeof part === "string") {
            parts.push(part);
          } else if (part && typeof part.text === "string") {
            // type can be "output_text", "text", etc.
            parts.push(part.text);
          }
        }
      }
    }
  }

  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Cost calculation
// ---------------------------------------------------------------------------

/**
 * Calculate cost in USD based on per-token prices.
 *
 * @param inputPrice   USD per 1M input tokens (from model_prices or providers table)
 * @param outputPrice  USD per 1M output tokens (from model_prices or providers table)
 */
export function calculateCost(
  inputPrice: number | null | undefined,
  outputPrice: number | null | undefined,
  inputTokens: number,
  outputTokens: number,
): Cost {
  const inPrice = inputPrice ?? 0;
  const outPrice = outputPrice ?? 0;

  const inputCost = (inputTokens / 1_000_000) * inPrice;
  const outputCost = (outputTokens / 1_000_000) * outPrice;

  return {
    input_cost: roundTo(inputCost, 8),
    output_cost: roundTo(outputCost, 8),
  };
}

// ---------------------------------------------------------------------------
// Usage recording — enqueues to write queue (non-blocking)
// ---------------------------------------------------------------------------

/**
 * Record a usage event — enqueues for batched DB writing.
 * This is non-blocking and returns immediately.
 */
export async function recordUsage(params: UsageRecordParams): Promise<void> {
  const {
    apiKeyId,
    userId,
    providerId,
    inputTokens,
    outputTokens,
    inputCost,
    outputCost,
    model,
  } = params;

  const totalCost = roundTo(inputCost + outputCost, 8);

  console.log(
    `[usage] api_key=${apiKeyId} provider=${providerId} model=${model} ` +
      `in=${inputTokens} out=${outputTokens} cost=$${totalCost.toFixed(8)}`
  );

  // Record token usage for TPM rate limiting (in-memory sliding window)
  if (userId) {
    recordTokenUsage(userId, apiKeyId, inputTokens + outputTokens);
  }

  // Enqueue for batched writing — no DB I/O here
  dbRecordUsage(
    parseInt(apiKeyId, 10),
    parseInt(providerId, 10),
    inputTokens,
    outputTokens,
    inputCost,
    outputCost,
    model
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function roundTo(n: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(n * factor) / factor;
}

/**
 * Token usage tracking and cost calculation.
 *
 * Handles provider-specific usage extraction, cost calculation, and recording.
 * Usage recording is non-blocking — enqueues to a write queue for batched DB writes.
 */

import { recordUsage as dbRecordUsage } from "../db/database.js";
import { recordTokenUsage } from "./rateLimiter.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Usage {
  input_tokens: number;
  output_tokens: number;
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
 * Extract usage from a provider response, falling back to text-based estimation
 * when the provider did not return any usage data (input_tokens and output_tokens both 0).
 *
 * @param body  The original request body (used to extract input text for estimation).
 */
export function extractUsageWithFallback(
  providerType: string,
  responseData: Record<string, any>,
  body?: Record<string, any>,
): Usage {
  const usage = extractUsage(providerType, responseData);

  // Estimate input/output independently — some providers return only one of the two
  if (usage.input_tokens === 0 && body) {
    const inputText = extractInputTextFromBody(body);
    if (inputText) usage.input_tokens = estimateTokens(inputText);
  }
  if (usage.output_tokens === 0) {
    const outputText = extractOutputTextFromResponse(responseData);
    if (outputText) usage.output_tokens = estimateTokens(outputText);
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
          if (part?.type === "text" && typeof part.text === "string") {
            parts.push(part.text);
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

/**
 * Token usage tracking and cost calculation.
 *
 * Handles provider-specific usage extraction, cost calculation, and recording.
 * Usage recording is non-blocking — enqueues to a write queue for batched DB writes.
 */

import { recordUsage as dbRecordUsage } from "../db/database.js";

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

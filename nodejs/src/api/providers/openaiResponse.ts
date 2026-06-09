/**
 * OpenAI Responses API provider adapter.
 *
 * Handles requests to OpenAI Responses API compatible endpoints.
 * This provider sends requests to the /v1/responses endpoint instead of /chat/completions.
 *
 * Exposes two public functions:
 * - responsesApi():   Direct pass-through for Responses API format.
 * - chatCompletion(): Converts Chat Completions → Responses → sends → converts back.
 */

import {
  convertMessagesToResponsesInput,
  convertChatToolsToResponsesTools,
  convertResponsesToChatCompletion,
  streamChatFromResponses,
} from "../responses.js";

const DEFAULT_TIMEOUT = 120_000;
const MAX_RETRIES = 2;
const RETRY_DELAY = 500; // ms

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  extraHeaders?: Record<string, string>;
  timeout?: number;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send a Responses API request directly to upstream.
 *
 * Used when our /v1/responses endpoint receives a request
 * and the provider is openai_response type — pass through directly.
 */
export async function responsesApi(
  requestData: Record<string, any>,
  providerConfig: ProviderConfig
): Promise<Record<string, any> | AsyncGenerator<Uint8Array>> {
  const baseUrl = providerConfig.baseUrl.replace(/\/+$/, "");
  const apiKey = providerConfig.apiKey;
  const timeout = providerConfig.timeout ?? DEFAULT_TIMEOUT;
  const extraHeaders = providerConfig.extraHeaders ?? {};
  const isStream = requestData.stream === true;

  const url = `${baseUrl}/responses`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    ...extraHeaders,
  };

  return doRequest(url, headers, requestData, timeout, isStream);
}

/**
 * Send a chat completion request via the Responses API.
 *
 * Converts Chat Completions format → Responses API format,
 * sends to upstream /v1/responses,
 * then converts the result back to Chat Completions format.
 */
export async function chatCompletion(
  requestData: Record<string, any>,
  providerConfig: ProviderConfig
): Promise<Record<string, any> | AsyncGenerator<Uint8Array>> {
  const messages = requestData.messages ?? [];
  const model = requestData.model ?? "";
  const isStream = requestData.stream === true;

  // Convert chat messages to Responses API input
  const { inputItems, instructions } = convertMessagesToResponsesInput(messages as any[]);

  // Build Responses API request body
  const responsesBody: Record<string, any> = {
    model,
    input: inputItems,
    stream: isStream,
  };

  // Copy over compatible parameters
  if (instructions) responsesBody.instructions = instructions;
  if (requestData.temperature != null) responsesBody.temperature = requestData.temperature;
  if (requestData.top_p != null) responsesBody.top_p = requestData.top_p;
  if (requestData.max_output_tokens != null) {
    responsesBody.max_output_tokens = requestData.max_output_tokens;
  } else if (requestData.max_tokens != null) {
    responsesBody.max_output_tokens = requestData.max_tokens;
  }

  // Convert tools if present
  if (requestData.tools) {
    responsesBody.tools = convertChatToolsToResponsesTools(requestData.tools);
  }

  // Send via responsesApi
  const result = await responsesApi(responsesBody, providerConfig);

  // Convert result back to Chat Completions format
  if (isStream) {
    return streamChatFromResponses(
      result as AsyncGenerator<Uint8Array>,
      model
    );
  }

  return convertResponsesToChatCompletion(
    result as Record<string, any>,
    model
  );
}

// ---------------------------------------------------------------------------
// Usage extraction (for usage tracker compatibility)
// ---------------------------------------------------------------------------

export function extractUsage(responseData: Record<string, any>): Usage {
  const usage = responseData.usage ?? {};
  return {
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Internal: HTTP request with retry
// ---------------------------------------------------------------------------

async function doRequest(
  url: string,
  headers: Record<string, string>,
  body: Record<string, any>,
  timeout: number,
  isStream: boolean
): Promise<Record<string, any> | AsyncGenerator<Uint8Array>> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (isStream) {
        return streamResponse(url, headers, body, timeout);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!resp.ok) {
        const errorBody = await resp.text();
        const error = new Error(`OpenAI Responses API error ${resp.status}: ${errorBody}`);
        (error as any).status = resp.status;
        throw error;
      }

      return (await resp.json()) as Record<string, any>;
    } catch (err: any) {
      lastError = err;
      const status: number | undefined = err.status;

      // Don't retry client errors (4xx) except 429
      if (status && status >= 400 && status < 500 && status !== 429) {
        throw wrapError(err);
      }

      if (attempt < MAX_RETRIES) {
        console.warn(
          `OpenAI Responses request failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${err} – retrying`
        );
        await sleep(RETRY_DELAY * (attempt + 1));
        continue;
      }

      throw wrapError(err);
    }
  }

  throw wrapError(lastError!);
}

// ---------------------------------------------------------------------------
// Internal: Streaming
// ---------------------------------------------------------------------------

async function* streamResponse(
  url: string,
  headers: Record<string, string>,
  body: Record<string, any>,
  timeout: number
): AsyncGenerator<Uint8Array> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: controller.signal,
  });
  clearTimeout(timer);

  if (!resp.ok) {
    const errorBody = await resp.text();
    throw new Error(`OpenAI Responses API error ${resp.status}: ${errorBody}`);
  }

  const reader = resp.body?.getReader();
  if (!reader) throw new Error("No response body for streaming");

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wrapError(err: Error): Error {
  if (err.name === "AbortError") {
    return new Error("OpenAI Responses API request timed out");
  }
  return err;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

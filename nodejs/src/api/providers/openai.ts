/**
 * OpenAI-compatible provider adapter.
 *
 * Handles requests to OpenAI and OpenAI-compatible APIs (Azure, local models, etc.).
 * Input/Output: Standard OpenAI chat completion format.
 */

// RequestInit type from the Fetch API standard
type FetchRequestInit = globalThis.RequestInit;

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
  /** Azure-specific */
  azureDeployment?: string;
  azureApiVersion?: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: Array<{
    role: "system" | "user" | "assistant" | "tool";
    content: string | unknown[];
  }>;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string | string[];
  [key: string]: unknown;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send a chat completion request to an OpenAI-compatible endpoint.
 *
 * @returns Parsed JSON for non-streaming, ReadableStream<Uint8Array> for streaming.
 */
export async function chatCompletion(
  requestData: ChatCompletionRequest,
  providerConfig: ProviderConfig
): Promise<Record<string, unknown> | AsyncGenerator<Uint8Array>> {
  const baseUrl = providerConfig.baseUrl.replace(/\/+$/, "");
  const apiKey = providerConfig.apiKey;
  const timeout = providerConfig.timeout ?? DEFAULT_TIMEOUT;
  const extraHeaders = providerConfig.extraHeaders ?? {};
  const isStream = requestData.stream === true;

  let url = `${baseUrl}/chat/completions`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...extraHeaders,
  };

  // Azure OpenAI uses a different URL pattern and auth header.
  if (providerConfig.azureDeployment) {
    const deployment = providerConfig.azureDeployment;
    const apiVersion = providerConfig.azureApiVersion ?? "2024-02-15-preview";
    url = `${baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
    headers["api-key"] = apiKey;
  } else {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  return doRequest(url, headers, requestData, timeout, isStream);
}

// ---------------------------------------------------------------------------
// Internal: HTTP request with retry
// ---------------------------------------------------------------------------

async function doRequest(
  url: string,
  headers: Record<string, string>,
  body: ChatCompletionRequest,
  timeout: number,
  isStream: boolean
): Promise<Record<string, unknown> | AsyncGenerator<Uint8Array>> {
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
        const error = new Error(`OpenAI API error ${resp.status}: ${errorBody}`);
        (error as any).status = resp.status;
        throw error;
      }

      return (await resp.json()) as Record<string, unknown>;
    } catch (err: any) {
      lastError = err;
      const status: number | undefined = err.status;

      // Don't retry client errors (4xx) except 429
      if (status && status >= 400 && status < 500 && status !== 429) {
        throw wrapError(err);
      }

      if (attempt < MAX_RETRIES) {
        console.warn(
          `OpenAI request failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${err} – retrying`
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
  body: ChatCompletionRequest,
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
    throw new Error(`OpenAI API error ${resp.status}: ${errorBody}`);
  }

  const reader = resp.body?.getReader();
  if (!reader) throw new Error("No response body for streaming");

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("data: ")) {
          const data = trimmed.slice(6);
          if (data.trim() === "[DONE]") {
            yield new TextEncoder().encode("data: [DONE]\n\n");
            return;
          }
          yield new TextEncoder().encode(`data: ${data}\n\n`);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  // Process any remaining buffer
  if (buffer.trim().startsWith("data: ")) {
    const data = buffer.trim().slice(6);
    if (data.trim() === "[DONE]") {
      yield new TextEncoder().encode("data: [DONE]\n\n");
    } else {
      yield new TextEncoder().encode(`data: ${data}\n\n`);
    }
  }
}

// ---------------------------------------------------------------------------
// Usage extraction
// ---------------------------------------------------------------------------

export function extractUsage(responseData: Record<string, any>): Usage {
  const usage = responseData.usage ?? {};
  return {
    input_tokens: usage.prompt_tokens ?? 0,
    output_tokens: usage.completion_tokens ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wrapError(err: Error): Error {
  if (err.name === "AbortError") {
    return new Error("OpenAI API request timed out");
  }
  return err;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

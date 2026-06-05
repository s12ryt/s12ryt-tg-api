/**
 * Anthropic (Claude) provider adapter.
 *
 * Converts between OpenAI and Anthropic API formats.
 */

import { v4 as uuidv4 } from "uuid";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProviderConfig {
  baseUrl?: string;
  apiKey: string;
  extraHeaders?: Record<string, string>;
  timeout?: number;
}

export interface ChatCompletionRequest {
  model: string;
  messages: Array<{
    role: string;
    content: string | any[];
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
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT = 120_000;
const MAX_RETRIES = 2;
const RETRY_DELAY = 500;
const ANTHROPIC_VERSION = "2023-06-01";

const MODEL_MAP: Record<string, string> = {
  "claude-3-opus": "claude-3-opus-20240229",
  "claude-3-sonnet": "claude-3-sonnet-20240229",
  "claude-3-haiku": "claude-3-haiku-20240307",
  "claude-3.5-sonnet": "claude-3-5-sonnet-20241022",
  "claude-3.5-haiku": "claude-3-5-haiku-20241022",
  "claude-4-opus": "claude-opus-4-20250514",
  "claude-4-sonnet": "claude-sonnet-4-20250514",
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function chatCompletion(
  requestData: ChatCompletionRequest,
  providerConfig: ProviderConfig
): Promise<Record<string, unknown> | AsyncGenerator<Uint8Array>> {
  const baseUrl = (providerConfig.baseUrl ?? "https://api.anthropic.com").replace(
    /\/+$/,
    ""
  );
  const apiKey = providerConfig.apiKey;
  const timeout = providerConfig.timeout ?? DEFAULT_TIMEOUT;
  const extraHeaders = providerConfig.extraHeaders ?? {};
  const isStream = requestData.stream === true;

  const anthropicBody = toAnthropicRequest(requestData);
  const url = `${baseUrl}/v1/messages`;

  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
    "Content-Type": "application/json",
    ...extraHeaders,
  };

  return doRequest(url, headers, anthropicBody, timeout, isStream, requestData.model);
}

// ---------------------------------------------------------------------------
// Format conversion: OpenAI -> Anthropic
// ---------------------------------------------------------------------------

function toAnthropicRequest(openaiReq: ChatCompletionRequest): Record<string, any> {
  const model = openaiReq.model ?? "claude-3-sonnet";
  const mappedModel = MODEL_MAP[model] ?? model;

  const messagesRaw = openaiReq.messages ?? [];

  let systemText = "";
  const anthropicMessages: Array<{ role: string; content: any }> = [];

  for (const msg of messagesRaw) {
    const role = msg.role ?? "user";
    const content = msg.content;

    if (role === "system") {
      if (Array.isArray(content)) {
        const parts = content
          .filter((p: any) => p.type === "text")
          .map((p: any) => p.text ?? "");
        systemText += parts.join("\n");
      } else {
        systemText += content + "\n";
      }
    } else {
      const anthropicContent = convertContent(content);
      anthropicMessages.push({ role, content: anthropicContent });
    }
  }

  // Merge consecutive same-role messages (Anthropic requirement)
  const merged: Array<{ role: string; content: any }> = [];
  for (const msg of anthropicMessages) {
    if (merged.length > 0 && merged[merged.length - 1].role === msg.role) {
      const prev = merged[merged.length - 1].content;
      const curr = msg.content;
      merged[merged.length - 1].content =
        (typeof prev === "string" ? prev : String(prev)) +
        "\n" +
        (typeof curr === "string" ? curr : String(curr));
    } else {
      merged.push({ role: msg.role, content: msg.content });
    }
  }

  const body: Record<string, any> = {
    model: mappedModel,
    messages: merged,
    max_tokens: openaiReq.max_tokens ?? 4096,
  };

  if (systemText.trim()) {
    body.system = systemText.trim();
  }

  if (openaiReq.temperature !== undefined) body.temperature = openaiReq.temperature;
  if (openaiReq.top_p !== undefined) body.top_p = openaiReq.top_p;
  if (openaiReq.stop !== undefined) {
    body.stop_sequences = Array.isArray(openaiReq.stop)
      ? openaiReq.stop
      : [openaiReq.stop];
  }
  if (openaiReq.stream !== undefined) body.stream = openaiReq.stream;

  return body;
}

function convertContent(content: any): any {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: Array<Record<string, any>> = [];
    for (const part of content) {
      const ptype = part.type ?? "text";
      if (ptype === "text") {
        parts.push({ type: "text", text: part.text ?? "" });
      } else if (ptype === "image_url") {
        const url: string = part.image_url?.url ?? "";
        if (url.startsWith("data:")) {
          const mediaType = url.includes(":") ? url.split(";")[0].split(":")[1] : "image/png";
          const b64data = url.includes(",") ? url.split(",", 2)[1] : "";
          parts.push({
            type: "image",
            source: { type: "base64", media_type: mediaType, data: b64data },
          });
        }
      }
    }
    return parts.length > 0 ? parts : String(content);
  }
  return String(content);
}

// ---------------------------------------------------------------------------
// Format conversion: Anthropic -> OpenAI
// ---------------------------------------------------------------------------

function toOpenAIResponse(
  anthropicResp: Record<string, any>,
  originalModel: string
): Record<string, any> {
  const contentBlocks: Array<Record<string, any>> = anthropicResp.content ?? [];
  const textParts: string[] = [];
  for (const block of contentBlocks) {
    if (block.type === "text") textParts.push(block.text ?? "");
  }
  const text = textParts.join("");

  const usageIn = anthropicResp.usage ?? {};
  const inputTokens = usageIn.input_tokens ?? 0;
  const outputTokens = usageIn.output_tokens ?? 0;

  const stopReason = anthropicResp.stop_reason ?? "end_turn";
  const finishReason = mapStopReason(stopReason);

  return {
    id: `chatcmpl-${uuidv4().replace(/-/g, "").slice(0, 24)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: originalModel,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}

function mapStopReason(reason: string): string {
  const mapping: Record<string, string> = {
    end_turn: "stop",
    max_tokens: "length",
    stop_sequence: "stop",
  };
  return mapping[reason] ?? "stop";
}

// ---------------------------------------------------------------------------
// HTTP request with retry
// ---------------------------------------------------------------------------

async function doRequest(
  url: string,
  headers: Record<string, string>,
  body: Record<string, any>,
  timeout: number,
  isStream: boolean,
  originalModel: string
): Promise<Record<string, unknown> | AsyncGenerator<Uint8Array>> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (isStream) {
        return streamResponse(url, headers, body, timeout, originalModel);
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
        const error = new Error(`Anthropic API error ${resp.status}: ${errorBody}`);
        (error as any).status = resp.status;
        throw error;
      }

      const data = await resp.json();
      return toOpenAIResponse(data, originalModel);
    } catch (err: any) {
      lastError = err;
      const status: number | undefined = err.status;

      if (status && status >= 400 && status < 500 && status !== 429) {
        throw wrapError(err);
      }

      if (attempt < MAX_RETRIES) {
        console.warn(
          `Anthropic request failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${err} – retrying`
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
// Streaming: Anthropic SSE -> OpenAI SSE
// ---------------------------------------------------------------------------

async function* streamResponse(
  url: string,
  headers: Record<string, string>,
  body: Record<string, any>,
  timeout: number,
  originalModel: string
): AsyncGenerator<Uint8Array> {
  const completionId = `chatcmpl-${uuidv4().replace(/-/g, "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();

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
    throw new Error(`Anthropic API error ${resp.status}: ${errorBody}`);
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
        if (!trimmed.startsWith("data: ")) continue;
        const payload = trimmed.slice(6).trim();
        if (!payload) continue;

        let event: Record<string, any>;
        try {
          event = JSON.parse(payload);
        } catch {
          continue;
        }

        const eventType = event.type ?? "";

        if (eventType === "content_block_delta") {
          const deltaText = event.delta?.text ?? "";
          const chunk = buildStreamChunk(completionId, created, originalModel, deltaText);
          yield encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`);
        } else if (eventType === "message_stop") {
          const chunk = buildStreamChunk(
            completionId, created, originalModel, "", "stop"
          );
          yield encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`);
          yield encoder.encode("data: [DONE]\n\n");
          return;
        } else if (eventType === "message_delta") {
          const stopReason = event.delta?.stop_reason ?? "end_turn";
          const finish = mapStopReason(stopReason);
          const usage = event.usage ?? {};
          const chunk = buildStreamChunk(
            completionId, created, originalModel, "", finish, usage
          );
          yield encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`);
        } else if (eventType === "error") {
          const err = event.error ?? {};
          throw new Error(
            `Anthropic stream error: ${err.type ?? "unknown"}: ${err.message ?? "unknown error"}`
          );
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  yield encoder.encode("data: [DONE]\n\n");
}

function buildStreamChunk(
  completionId: string,
  created: number,
  model: string,
  text: string,
  finishReason: string | null = null,
  usage?: Record<string, any>
): Record<string, any> {
  const chunk: Record<string, any> = {
    id: completionId,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: text ? { content: text } : {},
        finish_reason: finishReason,
      },
    ],
  };

  if (usage) {
    chunk.usage = {
      prompt_tokens: usage.input_tokens ?? 0,
      completion_tokens: usage.output_tokens ?? 0,
      total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
    };
  }

  return chunk;
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
    return new Error("Anthropic API request timed out");
  }
  return err;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

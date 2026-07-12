/**
 * Google Gemini provider adapter.
 *
 * Converts between OpenAI and Google Gemini API formats.
 */

import { v4 as uuidv4 } from "uuid";
import { injectForGoogle, type ThinkingLevel } from "../thinkingParser.js";
import { createRequestTimeout, isAbortError, withRequestTimeout } from "./requestTimeout.js";
import { ProviderHttpError } from "./errors.js";

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
  presence_penalty?: number;
  frequency_penalty?: number;
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

const MODEL_MAP: Record<string, string> = {
  "gemini-pro": "gemini-1.5-pro",
  "gemini-1.5-pro": "gemini-1.5-pro-latest",
  "gemini-1.5-flash": "gemini-1.5-flash-latest",
  "gemini-2.0-flash": "gemini-2.0-flash",
  "gemini-2.5-pro": "gemini-2.5-pro-preview-05-06",
  "gemini-2.5-flash": "gemini-2.5-flash-preview-05-20",
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function chatCompletion(
  requestData: ChatCompletionRequest,
  providerConfig: ProviderConfig
): Promise<Record<string, unknown> | AsyncGenerator<Uint8Array>> {
  const baseUrl = (
    providerConfig.baseUrl ?? "https://generativelanguage.googleapis.com"
  ).replace(/\/+$/, "");
  const apiKey = providerConfig.apiKey;
  const timeout = providerConfig.timeout ?? DEFAULT_TIMEOUT;
  const extraHeaders = providerConfig.extraHeaders ?? {};
  const isStream = requestData.stream === true;

  const geminiBody = toGeminiRequest(requestData);
  const model = geminiBody._model as string;
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete (geminiBody as Record<string, unknown>)._model;

  const endpoint = isStream
    ? `${baseUrl}/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`
    : `${baseUrl}/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...extraHeaders,
  };

  return doRequest(endpoint, headers, geminiBody, timeout, isStream, requestData.model);
}

// ---------------------------------------------------------------------------
// Format conversion: OpenAI -> Gemini
// ---------------------------------------------------------------------------

function toGeminiRequest(
  openaiReq: ChatCompletionRequest
): Record<string, any> & { _model: string } {
  const model = openaiReq.model ?? "gemini-1.5-pro";
  const mappedModel = MODEL_MAP[model] ?? model;

  const messagesRaw = openaiReq.messages ?? [];

  const systemInstructionParts: Array<Record<string, any>> = [];
  const contents: Array<Record<string, any>> = [];

  for (const msg of messagesRaw) {
    const role = msg.role ?? "user";
    const content = msg.content;

    if (role === "system") {
      systemInstructionParts.push(...buildParts(content));
      continue;
    }

    const geminiRole = role === "user" || role === "tool" ? "user" : "model";
    const parts = buildParts(content);
    contents.push({ role: geminiRole, parts });
  }

  // Gemini requires first message to be from user
  if (contents.length > 0 && contents[0].role !== "user") {
    contents.unshift({ role: "user", parts: [{ text: "" }] });
  }

  // Ensure alternating roles
  const merged = mergeConsecutive(contents);

  const body: Record<string, any> & { _model: string } = {
    _model: mappedModel,
    contents: merged,
  };

  if (systemInstructionParts.length > 0) {
    body.systemInstruction = { parts: systemInstructionParts };
  }

  // Generation config
  const genConfig: Record<string, any> = {};
  if (openaiReq.temperature !== undefined) genConfig.temperature = openaiReq.temperature;
  if (openaiReq.top_p !== undefined) genConfig.topP = openaiReq.top_p;
  if (openaiReq.max_tokens !== undefined) genConfig.maxOutputTokens = openaiReq.max_tokens;
  if (openaiReq.stop !== undefined) {
    genConfig.stopSequences = Array.isArray(openaiReq.stop)
      ? openaiReq.stop
      : [openaiReq.stop];
  }
  if (openaiReq.presence_penalty !== undefined)
    genConfig.presencePenalty = openaiReq.presence_penalty;
  if (openaiReq.frequency_penalty !== undefined)
    genConfig.frequencyPenalty = openaiReq.frequency_penalty;

  if (Object.keys(genConfig).length > 0) {
    body.generationConfig = genConfig;
  }

  // --- thinking budget (Gemini thinkingConfig) ---
  if (openaiReq.thinking_effort) {
    injectForGoogle(body, openaiReq.thinking_effort as ThinkingLevel);
  }

  return body;
}

function buildParts(content: any): Array<Record<string, any>> {
  if (typeof content === "string") return [{ text: content }];
  if (Array.isArray(content)) {
    const parts: Array<Record<string, any>> = [];
    for (const part of content) {
      const ptype = part.type ?? "text";
      if (ptype === "text") {
        parts.push({ text: part.text ?? "" });
      } else if (ptype === "image_url") {
        const url: string = part.image_url?.url ?? "";
        if (url.startsWith("data:")) {
          const [header, b64data] = url.split(",", 2);
          const mime = header.includes(":")
            ? header.split(";")[0].split(":")[1]
            : "image/png";
          parts.push({ inlineData: { mimeType: mime, data: b64data } });
        }
      }
    }
    return parts.length > 0 ? parts : [{ text: "" }];
  }
  return [{ text: String(content) }];
}

function mergeConsecutive(
  contents: Array<Record<string, any>>
): Array<Record<string, any>> {
  const merged: Array<Record<string, any>> = [];
  for (const msg of contents) {
    if (merged.length > 0 && merged[merged.length - 1].role === msg.role) {
      merged[merged.length - 1].parts.push(...msg.parts);
    } else {
      merged.push({ role: msg.role, parts: [...msg.parts] });
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Format conversion: Gemini -> OpenAI
// ---------------------------------------------------------------------------

function toOpenAIResponse(
  geminiResp: Record<string, any>,
  originalModel: string
): Record<string, any> {
  const candidates = geminiResp.candidates ?? [];
  let text = "";
  let finishReason = "stop";

  if (candidates.length > 0) {
    const candidate = candidates[0];
    const parts = candidate.content?.parts ?? [];
    text = parts.filter((p: any) => "text" in p).map((p: any) => p.text).join("");

    finishReason = mapFinishReason(candidate.finishReason ?? "STOP") ?? "stop";
  }

  const usageMeta = geminiResp.usageMetadata ?? {};
  const promptTokens = usageMeta.promptTokenCount ?? 0;
  const completionTokens = usageMeta.candidatesTokenCount ?? 0;

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
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
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

      return await withRequestTimeout(timeout, async (signal) => {
        const resp = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal,
        });

        if (!resp.ok) {
          const errorBody = await resp.text();
          throw new ProviderHttpError(`Gemini API error ${resp.status}: ${errorBody}`, resp.status);
        }

        const data = await resp.json();
        return toOpenAIResponse(data, originalModel);
      });
    } catch (err: any) {
      lastError = err;
      const status: number | undefined = err.status;

      if (status && status >= 400 && status < 500 && status !== 429) {
        throw wrapError(err);
      }

      if (attempt < MAX_RETRIES) {
        console.warn(
          `Gemini request failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${err} – retrying`
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
// Streaming: Gemini SSE -> OpenAI SSE
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

  const requestTimeout = createRequestTimeout(timeout);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let completed = false;

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: requestTimeout.signal,
    });

    if (!resp.ok) {
      const errorBody = await resp.text();
      throw new Error(`Gemini API error ${resp.status}: ${errorBody}`);
    }

    reader = resp.body?.getReader();
    if (!reader) throw new Error("No response body for streaming");

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }

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

        // Check for errors
        if (event.error) {
          const err = event.error;
          throw new Error(
            `Gemini stream error: ${err.code ?? "unknown"}: ${err.message ?? "unknown error"}`
          );
        }

        const candidates = event.candidates ?? [];
        if (candidates.length === 0) continue;

        const candidate = candidates[0];
        const parts = candidate.content?.parts ?? [];
        const text = parts
          .filter((p: any) => "text" in p)
          .map((p: any) => p.text)
          .join("");

        let finishReason: string | null = null;
        const reason = candidate.finishReason;
        if (reason) {
          finishReason = mapFinishReason(reason);
        }

        const chunk: Record<string, any> = {
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model: originalModel,
          choices: [
            {
              index: 0,
              delta: text ? { content: text } : {},
              finish_reason: finishReason,
            },
          ],
        };

        const usageMeta = event.usageMetadata;
        if (usageMeta && finishReason) {
          chunk.usage = {
            prompt_tokens: usageMeta.promptTokenCount ?? 0,
            completion_tokens: usageMeta.candidatesTokenCount ?? 0,
            total_tokens: usageMeta.totalTokenCount ?? 0,
          };
        }

        yield encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`);
      }
    }
  } catch (err) {
    if (isAbortError(err) || requestTimeout.signal.aborted) {
      throw new Error("Gemini API request timed out");
    }
    throw err;
  } finally {
    requestTimeout.clear();
    if (reader) {
      if (!completed) {
        requestTimeout.abort();
        await reader.cancel().catch(() => undefined);
      }
      reader.releaseLock();
    }
  }

  yield encoder.encode("data: [DONE]\n\n");
}

function mapFinishReason(reason: string): string | null {
  if (reason === "MAX_TOKENS") return "length";
  if (reason === "SAFETY") return "content_filter";
  if (reason === "STOP") return "stop";
  return "stop";
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
    return new Error("Gemini API request timed out");
  }
  return err;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

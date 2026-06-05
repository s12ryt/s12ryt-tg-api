/**
 * Express application – API proxy / aggregation server.
 *
 * Accepts OpenAI-compatible requests and routes them to the correct provider.
 * All provider/model lookups are database-driven.
 */

import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import http from "http";
import { authMiddleware } from "./middleware.js";
import * as openaiProvider from "./providers/openai.js";
import * as anthropicProvider from "./providers/anthropic.js";
import * as googleProvider from "./providers/google.js";
import { extractUsage, calculateCost, recordUsage } from "./usageTracker.js";
import {
  convertResponsesInputToMessages,
  convertChatCompletionToResponses,
  streamResponsesApi,
  convertResponsesToolsToChatTools,
} from "./responses.js";
import {
  convertAnthropicInputToMessages,
  convertChatCompletionToAnthropic,
  streamAnthropicApi,
} from "./anthropic_out.js";
import { getProviders, lookupModelCached, rebuildProviderCache, onProviderCacheRebuild, type Provider } from "../db/database.js";

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "10mb" }));
app.use(authMiddleware);

// ---------------------------------------------------------------------------
// Helper: write SSE chunk and immediately flush the socket
// ---------------------------------------------------------------------------

function writeAndFlush(res: Response, data: Uint8Array | string): void {
  res.write(data);
  // Force-flush the underlying socket so chunks are not held in Node's buffer
  const socket = (res as any).socket;
  if (socket && typeof socket.write === "function") {
    // The res.write already called socket.write internally, but we ensure
    // the TCP buffer is flushed by calling writev with empty if needed.
    // More importantly, disable Nagle's algorithm for this connection.
    socket.setNoDelay(true);
  }
}

// ---------------------------------------------------------------------------
// Provider modules
// ---------------------------------------------------------------------------

const PROVIDER_MODULES: Record<string, { chatCompletion: (data: any, config: any) => Promise<any> }> = {
  openai: openaiProvider,
  anthropic: anthropicProvider,
  google: googleProvider,
};

// ---------------------------------------------------------------------------
// Database-driven model resolution (optimized with in-memory cache)
// ---------------------------------------------------------------------------

interface ResolvedProvider {
  providerType: string;
  providerId: number;
  providerName: string;
  config: { baseUrl: string; apiKey: string };
  inputPrice: number | null;
  outputPrice: number | null;
}

/**
 * Fast model lookup — uses in-memory provider cache (zero DB queries).
 * Falls back to full DB scan + cache rebuild on cache miss.
 */
function lookupModelDb(modelName: string): ResolvedProvider {
  const cached = lookupModelCached(modelName);
  if (cached) {
    return {
      providerType: cached.providerType,
      providerId: cached.providerId,
      providerName: cached.providerName,
      config: { baseUrl: cached.baseUrl, apiKey: cached.apiKey },
      inputPrice: cached.inputPrice,
      outputPrice: cached.outputPrice,
    };
  }

  // Cache miss — rebuild and retry once
  rebuildProviderCache();
  const retry = lookupModelCached(modelName);
  if (retry) {
    return {
      providerType: retry.providerType,
      providerId: retry.providerId,
      providerName: retry.providerName,
      config: { baseUrl: retry.baseUrl, apiKey: retry.apiKey },
      inputPrice: retry.inputPrice,
      outputPrice: retry.outputPrice,
    };
  }

  throw new Error(`Unknown model: ${modelName}`);
}

interface ModelEntry {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

/** Cached model list — rebuilt when provider cache is rebuilt. */
let cachedModelList: ModelEntry[] | null = null;

function getAllModelsFromDb(): ModelEntry[] {
  if (cachedModelList) return cachedModelList;

  const providers = getProviders(true);
  const models: ModelEntry[] = [];
  const now = Math.floor(Date.now() / 1000);

  for (const p of providers) {
    const modelNames = p.models
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean);

    for (const name of modelNames) {
      models.push({
        id: name,
        object: "model",
        created: now,
        owned_by: p.api_type,
      });
    }
  }

  cachedModelList = models;
  return models;
}

// Invalidate model list cache when provider cache is rebuilt
onProviderCacheRebuild(() => { cachedModelList = null; });

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Streaming helper: forward SSE chunks while extracting usage from the last chunk
// ---------------------------------------------------------------------------

async function forwardStreamAndExtractUsage(
  stream: AsyncIterable<Uint8Array>,
  write: (chunk: Uint8Array) => void,
): Promise<{ input_tokens: number; output_tokens: number }> {
  const decoder = new TextDecoder();
  let inputTokens = 0;
  let outputTokens = 0;

  for await (const chunk of stream) {
    write(chunk);

    // Try to extract usage from SSE data lines
    const text = decoder.decode(chunk, { stream: true });
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;
      const payload = trimmed.slice(6).trim();
      if (!payload || payload === "[DONE]") continue;

      try {
        const parsed = JSON.parse(payload);
        if (parsed.usage) {
          if (parsed.usage.prompt_tokens) inputTokens = parsed.usage.prompt_tokens;
          if (parsed.usage.completion_tokens) outputTokens = parsed.usage.completion_tokens;
          // Fallback key names
          if (!inputTokens && parsed.usage.input_tokens) inputTokens = parsed.usage.input_tokens;
          if (!outputTokens && parsed.usage.output_tokens) outputTokens = parsed.usage.output_tokens;
        }
      } catch {
        // Not JSON – skip
      }
    }
  }

  return { input_tokens: inputTokens, output_tokens: outputTokens };
}

/**
 * Extract usage from a raw OpenAI SSE provider stream while also passing
 * chunks through to a transform (e.g. streamResponsesApi, streamAnthropicApi).
 *
 * Returns the extracted usage after the stream is fully consumed by the transform.
 */
async function extractUsageFromProviderStream(
  providerStream: AsyncIterable<Uint8Array>,
  transformAndWrite: (providerStream: AsyncIterable<Uint8Array>) => Promise<void>,
): Promise<{ input_tokens: number; output_tokens: number }> {
  const decoder = new TextDecoder();
  let inputTokens = 0;
  let outputTokens = 0;

  // Create a "tee" by buffering chunks
  const chunkQueue: Uint8Array[] = [];
  const resolveHolder: { fn: ((value: IteratorResult<Uint8Array>) => void) | null } = { fn: null };
  let streamDone = false;

  // Producer: consume providerStream, extract usage, push to queue
  const producer = (async () => {
    for await (const chunk of providerStream) {
      // Extract usage
      const text = decoder.decode(chunk, { stream: true });
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const payload = trimmed.slice(6).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const parsed = JSON.parse(payload);
          if (parsed.usage) {
            if (parsed.usage.prompt_tokens) inputTokens = parsed.usage.prompt_tokens;
            if (parsed.usage.completion_tokens) outputTokens = parsed.usage.completion_tokens;
            if (!inputTokens && parsed.usage.input_tokens) inputTokens = parsed.usage.input_tokens;
            if (!outputTokens && parsed.usage.output_tokens) outputTokens = parsed.usage.output_tokens;
          }
        } catch { /* skip */ }
      }

      chunkQueue.push(chunk);
      if (resolveHolder.fn) {
        const r = resolveHolder.fn;
        resolveHolder.fn = null;
        r({ value: chunkQueue.shift()!, done: false });
      }
    }
    streamDone = true;
    if (resolveHolder.fn) {
      const r = resolveHolder.fn;
      resolveHolder.fn = null;
      r({ value: undefined as any, done: true });
    }
  })();

  // Create a pass-through async iterable for the transform
  const passThrough: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<Uint8Array>> {
          if (chunkQueue.length > 0) {
            return Promise.resolve({ value: chunkQueue.shift()!, done: false });
          }
          if (streamDone) {
            return Promise.resolve({ value: undefined as any, done: true });
          }
          return new Promise((resolve) => { resolveHolder.fn = resolve; });
        },
        return(): Promise<IteratorResult<Uint8Array>> {
          return Promise.resolve({ value: undefined as any, done: true });
        },
      };
    },
  };

  await transformAndWrite(passThrough);
  await producer;

  return { input_tokens: inputTokens, output_tokens: outputTokens };
}

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

app.get("/v1/models", (_req: Request, res: Response) => {
  const models = getAllModelsFromDb();
  res.json({ object: "list", data: models });
});

app.post(
  "/v1/chat/completions",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body;
      const now = new Date();
      console.log(`[${now.getHours().toString().padStart(2,"0")}:${now.getMinutes().toString().padStart(2,"0")}:${now.getSeconds().toString().padStart(2,"0")}] POST /v1/chat/completions model=${body.model ?? "?"} stream=${body.stream === true}`);

      const modelName: string = body.model ?? "";
      if (!modelName) {
        res.status(400).json({
          error: { message: "model is required", type: "invalid_request_error" },
        });
        return;
      }

      let providerType: string;
      let providerId: number;
      let providerConfig: { baseUrl: string; apiKey: string };
      let inputPrice: number | null;
      let outputPrice: number | null;

      try {
        const resolved = lookupModelDb(modelName);
        providerType = resolved.providerType;
        providerId = resolved.providerId;
        providerConfig = resolved.config;
        inputPrice = resolved.inputPrice;
        outputPrice = resolved.outputPrice;
      } catch (err: any) {
        res.status(400).json({
          error: { message: err.message, type: "invalid_request_error" },
        });
        return;
      }

      const providerModule = PROVIDER_MODULES[providerType];
      if (!providerModule) {
        res.status(500).json({
          error: {
            message: `Unknown provider type: ${providerType}`,
            type: "server_error",
          },
        });
        return;
      }

      const isStream = body.stream === true;

      let result: any;
      try {
        result = await providerModule.chatCompletion(body, providerConfig);
      } catch (err: any) {
        console.error(`Provider ${providerType} error for model ${modelName}:`, err);
        res.status(502).json({
          error: { message: err.message, type: "upstream_error" },
        });
        return;
      }

      // Streaming response
      if (isStream && result && typeof result[Symbol.asyncIterator] === "function") {
        console.log("[DEBUG] Entering streaming path for /v1/chat/completions");
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();

        try {
          let chunkCount = 0;
          const streamUsage = await forwardStreamAndExtractUsage(
            result as AsyncIterable<Uint8Array>,
            (chunk) => { chunkCount++; writeAndFlush(res, chunk); },
          );
          console.log(`[DEBUG] Stream finished, ${chunkCount} chunks sent, usage=${JSON.stringify(streamUsage)}`);

          // Record streaming usage
          if (streamUsage.input_tokens > 0 || streamUsage.output_tokens > 0) {
            try {
              const cost = calculateCost(inputPrice, outputPrice, streamUsage.input_tokens, streamUsage.output_tokens);
              const auth = req.auth;
              if (auth) {
                await recordUsage({
                  apiKeyId: auth.apiKeyId,
                  providerId: String(providerId),
                  inputTokens: streamUsage.input_tokens,
                  outputTokens: streamUsage.output_tokens,
                  inputCost: cost.input_cost,
                  outputCost: cost.output_cost,
                  model: modelName,
                });
              }
            } catch (err) {
              console.error("Failed to record streaming usage:", err);
            }
          }
        } catch (err: any) {
          console.error("Stream error:", err);
        } finally {
          res.end();
        }
        return;
      }

      // Non-streaming: extract usage and record
      if (result && typeof result === "object") {
        try {
          const usage = extractUsage(providerType, result);
          const cost = calculateCost(inputPrice, outputPrice, usage.input_tokens, usage.output_tokens);

          const auth = req.auth;
          if (auth) {
            await recordUsage({
              apiKeyId: auth.apiKeyId,
              providerId: String(providerId),
              inputTokens: usage.input_tokens,
              outputTokens: usage.output_tokens,
              inputCost: cost.input_cost,
              outputCost: cost.output_cost,
              model: modelName,
            });
          }
        } catch (err) {
          console.error("Failed to record usage:", err);
        }

        res.json(result);
        return;
      }

      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// POST /v1/responses – OpenAI Responses API
// ---------------------------------------------------------------------------

app.post(
  "/v1/responses",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body;
      const now = new Date();
      console.log(`[${now.getHours().toString().padStart(2,"0")}:${now.getMinutes().toString().padStart(2,"0")}:${now.getSeconds().toString().padStart(2,"0")}] POST /v1/responses model=${body.model ?? "?"} stream=${body.stream === true}`);

      // Validate required fields
      const modelName: string = body.model ?? "";
      const input = body.input;

      if (!modelName) {
        res.status(400).json({
          error: { message: "model is required", type: "invalid_request_error" },
        });
        return;
      }

      if (input === undefined || input === null) {
        res.status(400).json({
          error: { message: "input is required", type: "invalid_request_error" },
        });
        return;
      }

      // Resolve model → provider
      let providerType: string;
      let providerId: number;
      let providerConfig: { baseUrl: string; apiKey: string };
      let inputPrice: number | null;
      let outputPrice: number | null;

      try {
        const resolved = lookupModelDb(modelName);
        providerType = resolved.providerType;
        providerId = resolved.providerId;
        providerConfig = resolved.config;
        inputPrice = resolved.inputPrice;
        outputPrice = resolved.outputPrice;
      } catch (err: any) {
        res.status(400).json({
          error: { message: err.message, type: "invalid_request_error" },
        });
        return;
      }

      const providerModule = PROVIDER_MODULES[providerType];
      if (!providerModule) {
        res.status(500).json({
          error: {
            message: `Unknown provider type: ${providerType}`,
            type: "server_error",
          },
        });
        return;
      }

      // Convert Responses input → Chat Completions messages
      const instructions: string | undefined = body.instructions;
      const messages = convertResponsesInputToMessages(input, instructions);

      // Safety: ensure at least one user message exists
      if (messages.length === 0) {
        res.status(400).json({
          error: { message: "input resulted in empty messages", type: "invalid_request_error" },
        });
        return;
      }

      // Build Chat Completions request
      const chatBody: Record<string, unknown> = {
        model: modelName,
        messages,
        stream: body.stream === true,
      };

      if (body.temperature !== undefined) chatBody.temperature = body.temperature;
      if (body.top_p !== undefined) chatBody.top_p = body.top_p;
      if (body.max_output_tokens !== undefined) chatBody.max_tokens = body.max_output_tokens;
      if (body.presence_penalty !== undefined) chatBody.presence_penalty = body.presence_penalty;
      if (body.frequency_penalty !== undefined) chatBody.frequency_penalty = body.frequency_penalty;
      if (body.stop !== undefined) chatBody.stop = body.stop;

      // Convert Responses API tools → Chat Completions tools format
      if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
        chatBody.tools = convertResponsesToolsToChatTools(body.tools);
      }
      if (body.tool_choice !== undefined) {
        chatBody.tool_choice = body.tool_choice;
      }

      const isStream = chatBody.stream === true;

      let result: any;
      try {
        result = await providerModule.chatCompletion(chatBody, providerConfig);
      } catch (err: any) {
        console.error(`Provider ${providerType} error for model ${modelName}:`, err);
        res.status(502).json({
          error: { message: err.message, type: "upstream_error" },
        });
        return;
      }

      // Streaming: convert Chat Completions SSE → Responses API SSE
      if (isStream && result && typeof result[Symbol.asyncIterator] === "function") {
        console.log("[DEBUG] Entering streaming path for /v1/responses");
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();

        try {
          let chunkCount = 0;
          const streamUsage = await extractUsageFromProviderStream(
            result as AsyncIterable<Uint8Array>,
            async (passThrough) => {
              const responsesStream = streamResponsesApi(passThrough, modelName, {
                instructions,
                previousResponseId: body.previous_response_id,
                temperature: body.temperature,
                top_p: body.top_p,
              });
              for await (const chunk of responsesStream) {
                chunkCount++;
                writeAndFlush(res, chunk);
              }
            },
          );
          console.log(`[DEBUG] /v1/responses stream finished, ${chunkCount} chunks sent, usage=${JSON.stringify(streamUsage)}`);

          // Record streaming usage
          if (streamUsage.input_tokens > 0 || streamUsage.output_tokens > 0) {
            try {
              const cost = calculateCost(inputPrice, outputPrice, streamUsage.input_tokens, streamUsage.output_tokens);
              const auth = req.auth;
              if (auth) {
                await recordUsage({
                  apiKeyId: auth.apiKeyId,
                  providerId: String(providerId),
                  inputTokens: streamUsage.input_tokens,
                  outputTokens: streamUsage.output_tokens,
                  inputCost: cost.input_cost,
                  outputCost: cost.output_cost,
                  model: modelName,
                });
              }
            } catch (err) {
              console.error("Failed to record streaming usage:", err);
            }
          }
        } catch (err: any) {
          console.error("Responses stream error:", err);
        } finally {
          res.end();
        }
        return;
      }

      // Non-streaming: convert Chat Completions → Responses format
      if (result && typeof result === "object") {
        const responsesResult = convertChatCompletionToResponses(result, modelName, {
          instructions,
          previousResponseId: body.previous_response_id,
          temperature: body.temperature,
          top_p: body.top_p,
        });

        // Extract usage and record
        try {
          const usage = extractUsage(providerType, result);
          const cost = calculateCost(inputPrice, outputPrice, usage.input_tokens, usage.output_tokens);

          const auth = req.auth;
          if (auth) {
            await recordUsage({
              apiKeyId: auth.apiKeyId,
              providerId: String(providerId),
              inputTokens: usage.input_tokens,
              outputTokens: usage.output_tokens,
              inputCost: cost.input_cost,
              outputCost: cost.output_cost,
              model: modelName,
            });
          }
        } catch (err) {
          console.error("Failed to record usage:", err);
        }

        res.json(responsesResult);
        return;
      }

      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// POST /v1/messages – Anthropic Messages API
// ---------------------------------------------------------------------------

app.post(
  "/v1/messages",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body;
      const now = new Date();
      console.log(`[${now.getHours().toString().padStart(2,"0")}:${now.getMinutes().toString().padStart(2,"0")}:${now.getSeconds().toString().padStart(2,"0")}] POST /v1/messages model=${body.model ?? "?"} stream=${body.stream === true}`);

      // Validate required fields
      const modelName: string = body.model ?? "";
      if (!modelName) {
        res.status(400).json({
          type: "error",
          error: { type: "invalid_request_error", message: "model is required" },
        });
        return;
      }

      const messages = body.messages;
      if (!messages || !Array.isArray(messages) || messages.length === 0) {
        res.status(400).json({
          type: "error",
          error: { type: "invalid_request_error", message: "messages: must be a non-empty array" },
        });
        return;
      }

      // Resolve model → provider
      let providerType: string;
      let providerId: number;
      let providerConfig: { baseUrl: string; apiKey: string };
      let inputPrice: number | null;
      let outputPrice: number | null;

      try {
        const resolved = lookupModelDb(modelName);
        providerType = resolved.providerType;
        providerId = resolved.providerId;
        providerConfig = resolved.config;
        inputPrice = resolved.inputPrice;
        outputPrice = resolved.outputPrice;
      } catch (err: any) {
        res.status(400).json({
          type: "error",
          error: { type: "invalid_request_error", message: err.message },
        });
        return;
      }

      const providerModule = PROVIDER_MODULES[providerType];
      if (!providerModule) {
        res.status(500).json({
          type: "error",
          error: { type: "server_error", message: `Unknown provider type: ${providerType}` },
        });
        return;
      }

      // Convert Anthropic Messages API → OpenAI Chat Completions format
      const chatBody = convertAnthropicInputToMessages(body);

      // Safety: ensure at least one message exists
      if (!chatBody.messages || chatBody.messages.length === 0) {
        res.status(400).json({
          type: "error",
          error: { type: "invalid_request_error", message: "input resulted in empty messages" },
        });
        return;
      }

      const isStream = chatBody.stream === true;

      let result: any;
      try {
        result = await providerModule.chatCompletion(chatBody, providerConfig);
      } catch (err: any) {
        console.error(`Provider ${providerType} error for model ${modelName}:`, err);
        res.status(502).json({
          type: "error",
          error: { type: "api_error", message: err.message },
        });
        return;
      }

      // Streaming: convert OpenAI SSE → Anthropic SSE
      if (isStream && result && typeof result[Symbol.asyncIterator] === "function") {
        console.log("[DEBUG] Entering streaming path for /v1/messages");
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();

        try {
          let chunkCount = 0;
          const streamUsage = await extractUsageFromProviderStream(
            result as AsyncIterable<Uint8Array>,
            async (passThrough) => {
              const anthropicStream = streamAnthropicApi(passThrough, modelName);
              for await (const chunk of anthropicStream) {
                chunkCount++;
                writeAndFlush(res, chunk);
              }
            },
          );
          console.log(`[DEBUG] /v1/messages stream finished, ${chunkCount} chunks sent, usage=${JSON.stringify(streamUsage)}`);

          // Record streaming usage
          if (streamUsage.input_tokens > 0 || streamUsage.output_tokens > 0) {
            try {
              const cost = calculateCost(inputPrice, outputPrice, streamUsage.input_tokens, streamUsage.output_tokens);
              const auth = req.auth;
              if (auth) {
                await recordUsage({
                  apiKeyId: auth.apiKeyId,
                  providerId: String(providerId),
                  inputTokens: streamUsage.input_tokens,
                  outputTokens: streamUsage.output_tokens,
                  inputCost: cost.input_cost,
                  outputCost: cost.output_cost,
                  model: modelName,
                });
              }
            } catch (err) {
              console.error("Failed to record streaming usage:", err);
            }
          }
        } catch (err: any) {
          console.error("Anthropic stream error:", err);
        } finally {
          res.end();
        }
        return;
      }

      // Non-streaming: convert OpenAI → Anthropic Messages API format
      if (result && typeof result === "object") {
        const anthropicResult = convertChatCompletionToAnthropic(result, modelName);

        // Extract usage and record
        try {
          const usage = extractUsage(providerType, result);
          const cost = calculateCost(inputPrice, outputPrice, usage.input_tokens, usage.output_tokens);

          const auth = req.auth;
          if (auth) {
            await recordUsage({
              apiKeyId: auth.apiKeyId,
              providerId: String(providerId),
              inputTokens: usage.input_tokens,
              outputTokens: usage.output_tokens,
              inputCost: cost.input_cost,
              outputCost: cost.output_cost,
              model: modelName,
            });
          }
        } catch (err) {
          console.error("Failed to record usage:", err);
        }

        res.json(anthropicResult);
        return;
      }

      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Unhandled error:", err);
  res.status(500).json({
    error: { message: "Internal server error", type: "server_error" },
  });
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

export function startServer(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);

    server.on("error", (err: any) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(`Port ${port} is already in use`));
      } else {
        reject(err);
      }
    });

    server.listen(port, () => {
      resolve();
    });
  });
}

export default app;

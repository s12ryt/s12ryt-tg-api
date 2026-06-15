/**
 * Express application – API proxy / aggregation server.
 *
 * Accepts OpenAI-compatible requests and routes them to the correct provider.
 * All provider/model lookups are database-driven.
 */

import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import http from "http";
import path from "path";
import { authMiddleware } from "./middleware.js";
import { rateLimitMiddleware } from "./rateLimiter.js";
import { quotaCheckMiddleware } from "./quotaChecker.js";
import * as openaiProvider from "./providers/openai.js";
import * as openaiResponseProvider from "./providers/openaiResponse.js";
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
import { getProviders, lookupModelCached, rebuildProviderCache, onProviderCacheRebuild, type Provider, getActiveCodingForApiKey, incrementCodingSessionStats, checkModelAllowed, getAllowedModels, getUserByTgId } from "../db/database.js";
import { config } from "../config.js";
import { preprocessThinking, parseModelThinkingSuffix } from "./thinkingParser.js";
import webRouter from "../web/routes.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a Date as HH:MM:SS for log prefixing. */
function formatTimestamp(date: Date = new Date()): string {
  return date.toLocaleTimeString("en-GB", { hour12: false });
}

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "10mb" }));

// Web panel — mounted before API auth/rate/quota middleware so /web/* is exempt
app.use("/web", express.static(path.join(process.cwd(), "web")));
app.use("/web", webRouter);

app.use(authMiddleware);
app.use(rateLimitMiddleware);
app.use(quotaCheckMiddleware);

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

const PROVIDER_MODULES: Record<string, any> = {
  openai_chat: openaiProvider,
  openai_response: openaiResponseProvider,
  anthropic: anthropicProvider,
  google: googleProvider,
};

// ---------------------------------------------------------------------------
// Database-driven model resolution (optimized with in-memory cache)
// ---------------------------------------------------------------------------

import { selectKey, reportSuccess, reportFailure } from "./keySelector.js";

interface ResolvedProvider {
  providerType: string;
  providerId: number;
  providerName: string;
  config: { baseUrl: string; apiKey: string; _keyIndex: number | null };
  inputPrice: number | null;
  outputPrice: number | null;
}

/**
 * Fast model lookup — uses in-memory provider cache (zero DB queries).
 * Falls back to full DB scan + cache rebuild on cache miss.
 * Selects best available API key from multi-key JSON array.
 */
function lookupModelDb(modelName: string): ResolvedProvider {
  const cached = lookupModelCached(modelName);
  if (cached) {
    const { key, keyIndex } = selectKey(cached.providerId, cached.apiKey);
    return {
      providerType: cached.providerType,
      providerId: cached.providerId,
      providerName: cached.providerName,
      config: { baseUrl: cached.baseUrl, apiKey: key ?? cached.apiKey, _keyIndex: keyIndex },
      inputPrice: cached.inputPrice,
      outputPrice: cached.outputPrice,
    };
  }

  // Cache miss — rebuild and retry once
  rebuildProviderCache();
  const retry = lookupModelCached(modelName);
  if (retry) {
    const { key, keyIndex } = selectKey(retry.providerId, retry.apiKey);
    return {
      providerType: retry.providerType,
      providerId: retry.providerId,
      providerName: retry.providerName,
      config: { baseUrl: retry.baseUrl, apiKey: key ?? retry.apiKey, _keyIndex: keyIndex },
      inputPrice: retry.inputPrice,
      outputPrice: retry.outputPrice,
    };
  }

  throw new Error(`Unknown model: ${modelName}`);
}

interface DispatchResult {
  result: any;
  modelName: string;
  providerType: string;
  providerId: number;
  providerConfig: { baseUrl: string; apiKey: string; _keyIndex: number | null };
  inputPrice: number | null;
  outputPrice: number | null;
}

/**
 * Dispatch a request.
 * - model == 'coding-mode': use the user's fallback chain, try each model on error
 * - model != 'coding-mode': direct call, no fallback
 */
async function dispatchWithFallback(
  modelName: string,
  body: Record<string, any>,
  apiKeyId: number | undefined,
): Promise<DispatchResult> {
  const isCodingMode = modelName === "coding-mode";

  if (isCodingMode) {
    // Resolve user's fallback chain
    if (!apiKeyId) {
      throw new Error("coding-mode requires an API key");
    }

    const codingConfig = getActiveCodingForApiKey(apiKeyId);
    if (!codingConfig || codingConfig.fallback_list.length === 0) {
      throw new Error(
        "coding-mode 未設定：請先使用 /set_coding 設定 Fallback 模型鏈"
      );
    }

    let lastError: any = new Error("coding-mode: no fallback models available");

    for (const fbModelRaw of codingConfig.fallback_list) {
      // Parse thinking suffix from fallback model name (e.g. "o3(high)")
      const { model: fbModel, thinkingLevel: fbThinkingLevel } = parseModelThinkingSuffix(fbModelRaw);
      try {
        const fbResolved = lookupModelDb(fbModel);
        const fbModule = PROVIDER_MODULES[fbResolved.providerType];
        if (!fbModule) continue;

        console.log(`Coding mode: trying model ${fbModel}`);
        const fbBody: Record<string, any> = { ...body, model: fbModel };
        if (fbThinkingLevel) fbBody.thinking_effort = fbThinkingLevel;
        const result = await fbModule.chatCompletion(fbBody, fbResolved.config);

        return {
          result,
          modelName: fbModel,
          providerType: fbResolved.providerType,
          providerId: fbResolved.providerId,
          providerConfig: fbResolved.config,
          inputPrice: fbResolved.inputPrice,
          outputPrice: fbResolved.outputPrice,
        };
      } catch (fbError: any) {
        console.warn(`Coding mode model ${fbModel} failed:`, fbError.message);
        lastError = fbError;
      }
    }

    throw lastError;
  } else {
    // Normal request — direct call, no fallback
    const resolved = lookupModelDb(modelName);
    const providerModule = PROVIDER_MODULES[resolved.providerType];
    if (!providerModule) {
      throw new Error(`Unknown provider type: ${resolved.providerType}`);
    }

    try {
      const result = await providerModule.chatCompletion(body, resolved.config);
      // Report success for multi-key failover tracking
      if (resolved.config._keyIndex != null) {
        reportSuccess(resolved.providerId, resolved.config._keyIndex);
      }
      return {
        result,
        modelName,
        providerType: resolved.providerType,
        providerId: resolved.providerId,
        providerConfig: resolved.config,
        inputPrice: resolved.inputPrice,
        outputPrice: resolved.outputPrice,
      };
    } catch (err: any) {
      // Report failure for multi-key failover tracking
      if (resolved.config._keyIndex != null) {
        reportFailure(resolved.providerId, resolved.config._keyIndex);
      }
      throw err;
    }
  }
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

  // Always include the coding-mode virtual model
  models.push({
    id: "coding-mode",
    object: "model",
    created: now,
    owned_by: "system",
  });

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
// Model restriction helper
// ---------------------------------------------------------------------------

/**
 * Check if the requested model is allowed for the authenticated user/apiKey.
 * Returns true if allowed (or no auth), false if denied.
 * For coding-mode, always allow (the fallback chain handles individual model checks).
 */
function isModelAllowedForRequest(
  auth: { userId: string; apiKeyId: string; tgUserId: number } | undefined,
  modelName: string,
): boolean {
  if (!auth) return true; // no auth → public paths only (middleware handles this)
  if (modelName === "coding-mode") return true; // coding-mode handled by fallback

  const userId = parseInt(auth.userId, 10);
  const apiKeyId = parseInt(auth.apiKeyId, 10);
  const isAdmin = auth.tgUserId === config.ADMIN_ID;

  return checkModelAllowed(userId, apiKeyId, modelName, isAdmin);
}

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

app.get("/v1/models", (req: Request, res: Response) => {
  const allModels = getAllModelsFromDb();

  // Filter models based on auth + model restrictions
  const auth = req.auth;
  if (auth) {
    const userId = parseInt(auth.userId, 10);
    const apiKeyId = parseInt(auth.apiKeyId, 10);
    const isAdmin = auth.tgUserId === config.ADMIN_ID;

    const allModelNames = allModels.map((m) => m.id);
    const allowedNames = new Set(getAllowedModels(userId, apiKeyId, allModelNames, isAdmin));

    // Always include coding-mode virtual model if user has any models allowed
    if (allowedNames.size > 0 || isAdmin) {
      allowedNames.add("coding-mode");
    }

    const filteredModels = allModels.filter((m) => allowedNames.has(m.id));
    res.json({ object: "list", data: filteredModels });
  } else {
    // No auth → return all (shouldn't happen since middleware blocks unauthenticated)
    res.json({ object: "list", data: allModels });
  }
});

app.post(
  "/v1/chat/completions",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body;
      // Parse thinking level from model suffix (e.g. "o3(high)") or body params
      preprocessThinking(body);
      console.log(`[${formatTimestamp()}] POST /v1/chat/completions model=${body.model ?? "?"} stream=${body.stream === true}`);

      const modelName: string = body.model ?? "";
      if (!modelName) {
        res.status(400).json({
          error: { message: "model is required", type: "invalid_request_error" },
        });
        return;
      }

      // Check model restriction
      if (!isModelAllowedForRequest(req.auth, modelName)) {
        res.status(403).json({
          error: { message: `Model '${modelName}' is not allowed for this API key`, type: "permission_error" },
        });
        return;
      }

      // Dispatch with coding mode fallback
      const originalModel = modelName;
      let dispatch: DispatchResult;
      const apiKeyId = req.auth ? parseInt(req.auth.apiKeyId, 10) : undefined;
      try {
        dispatch = await dispatchWithFallback(modelName, body, apiKeyId);
      } catch (err: any) {
        const statusCode = err.message?.includes("Unknown model") || err.message?.includes("coding-mode") ? 400 : 502;
        res.status(statusCode).json({
          error: { message: err.message, type: statusCode === 400 ? "invalid_request_error" : "upstream_error" },
        });
        return;
      }

      const { result, modelName: actualModel, providerType, providerId, providerConfig, inputPrice, outputPrice } = dispatch;
      const isCodingMode = originalModel === "coding-mode";

      const isStream = body.stream === true;

      // Streaming response
      if (isStream && result && typeof result[Symbol.asyncIterator] === "function") {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();

        console.log(`[DEBUG] Entering streaming for /v1/chat/completions model=${actualModel}`);

        try {
          let chunkCount = 0;
          const streamUsage = await forwardStreamAndExtractUsage(
            result as AsyncIterable<Uint8Array>,
            (chunk) => { chunkCount++; writeAndFlush(res, chunk); },
          );

          // Record streaming usage
          if (streamUsage.input_tokens > 0 || streamUsage.output_tokens > 0) {
            try {
              const cost = calculateCost(inputPrice, outputPrice, streamUsage.input_tokens, streamUsage.output_tokens);
              const auth = req.auth;
              if (auth) {
                await recordUsage({
                  apiKeyId: auth.apiKeyId, userId: auth.userId,
                  providerId: String(providerId),
                  inputTokens: streamUsage.input_tokens,
                  outputTokens: streamUsage.output_tokens,
                  inputCost: cost.input_cost,
                  outputCost: cost.output_cost,
                  model: actualModel,
                });
                // Coding session stats
                if (isCodingMode && auth.userId) {
                  try { incrementCodingSessionStats(parseInt(auth.userId), streamUsage.input_tokens, streamUsage.output_tokens, cost.input_cost, cost.output_cost, actualModel); } catch (e) { console.error("[coding-stats] Failed to increment:", e); }
                }
              }
            } catch (err) {
              console.error("Failed to record streaming usage:", err);
            }
          }

          console.log(`[DEBUG] Stream finished for /v1/chat/completions model=${actualModel}`);
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
              apiKeyId: auth.apiKeyId, userId: auth.userId,
              providerId: String(providerId),
              inputTokens: usage.input_tokens,
              outputTokens: usage.output_tokens,
              inputCost: cost.input_cost,
              outputCost: cost.output_cost,
              model: actualModel,
            });
            // Coding session stats
            if (isCodingMode && auth.userId) {
              try { incrementCodingSessionStats(parseInt(auth.userId), usage.input_tokens, usage.output_tokens, cost.input_cost, cost.output_cost, actualModel); } catch (e) { console.error("[coding-stats] Failed to increment:", e); }
            }
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
      // Parse thinking level from model suffix (e.g. "o3(high)") or body params
      preprocessThinking(body);
      console.log(`[${formatTimestamp()}] POST /v1/responses model=${body.model ?? "?"} stream=${body.stream === true}`);

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

      // Check model restriction
      if (!isModelAllowedForRequest(req.auth, modelName)) {
        res.status(403).json({
          error: { message: `Model '${modelName}' is not allowed for this API key`, type: "permission_error" },
        });
        return;
      }

      // Optimization: for openai_response providers in non-coding mode, pass through directly
      const isCodingResp = modelName === "coding-mode";
      const isStreamResp = body.stream === true;

      if (!isCodingResp) {
        let _resolved: ResolvedProvider;
        try {
          _resolved = lookupModelDb(modelName);
        } catch (err: any) {
          const statusCode = err.message?.includes("Unknown model") ? 400 : 502;
          res.status(statusCode).json({
            error: { message: err.message, type: statusCode === 400 ? "invalid_request_error" : "upstream_error" },
          });
          return;
        }

        if (_resolved.providerType === "openai_response") {
          try {
            const result = await openaiResponseProvider.responsesApi(body, _resolved.config);

            if (isStreamResp && result && Symbol.asyncIterator in Object(result)) {
              res.setHeader("Content-Type", "text/event-stream");
              res.setHeader("Cache-Control", "no-cache");
              res.setHeader("Connection", "keep-alive");
              res.setHeader("X-Accel-Buffering", "no");
              res.flushHeaders();

              try {
                const streamUsage = await forwardStreamAndExtractUsage(
                  result as AsyncIterable<Uint8Array>,
                  (chunk) => { writeAndFlush(res, chunk); },
                );
                if (streamUsage.input_tokens > 0 || streamUsage.output_tokens > 0) {
                  try {
                    const cost = calculateCost(_resolved.inputPrice, _resolved.outputPrice, streamUsage.input_tokens, streamUsage.output_tokens);
                    const auth = req.auth;
                    if (auth) {
                      await recordUsage({
                        apiKeyId: auth.apiKeyId, userId: auth.userId,
                        providerId: String(_resolved.providerId),
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
                console.error("Responses direct stream error:", err);
              } finally {
                res.end();
              }
              return;
            }

            if (result && typeof result === "object") {
              const _u = (result as any).usage ?? {};
              const _inT: number = _u.input_tokens ?? 0;
              const _outT: number = _u.output_tokens ?? 0;
              try {
                if (_inT > 0 || _outT > 0) {
                  const cost = calculateCost(_resolved.inputPrice, _resolved.outputPrice, _inT, _outT);
                  const auth = req.auth;
                  if (auth) {
                    await recordUsage({
                      apiKeyId: auth.apiKeyId, userId: auth.userId,
                      providerId: String(_resolved.providerId),
                      inputTokens: _inT,
                      outputTokens: _outT,
                      inputCost: cost.input_cost,
                      outputCost: cost.output_cost,
                      model: modelName,
                    });
                  }
                }
              } catch (err) {
                console.error("Failed to record usage:", err);
              }
              res.json(result);
              return;
            }
          } catch (err: any) {
            res.status(502).json({
              error: { message: err.message, type: "upstream_error" },
            });
            return;
          }
        }
      }

      // Standard flow: convert Responses → Chat → dispatch → convert back
      let providerType: string;
      let providerId: number;
      let providerConfig: { baseUrl: string; apiKey: string };
      let inputPrice: number | null;
      let outputPrice: number | null;

      // Convert Responses input → Chat Completions messages first
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

      // Preserve thinking_effort for provider injection (set by preprocessThinking)
      if (body.thinking_effort !== undefined) {
        chatBody.thinking_effort = body.thinking_effort;
      }

      const isStream = chatBody.stream === true;

      // Dispatch with coding mode fallback
      const originalModelResp = modelName;
      let dispatch: DispatchResult;
      const apiKeyIdResp = req.auth ? parseInt(req.auth.apiKeyId, 10) : undefined;
      try {
        dispatch = await dispatchWithFallback(modelName, chatBody as Record<string, any>, apiKeyIdResp);
      } catch (err: any) {
        const statusCode = err.message?.includes("Unknown model") || err.message?.includes("coding-mode") ? 400 : 502;
        res.status(statusCode).json({
          error: { message: err.message, type: statusCode === 400 ? "invalid_request_error" : "upstream_error" },
        });
        return;
      }

      const { result, modelName: actualModel, providerType: pt, providerId: pid, providerConfig: pcfg, inputPrice: ip, outputPrice: op } = dispatch;
      providerType = pt;
      providerId = pid;
      providerConfig = pcfg;
      inputPrice = ip;
      outputPrice = op;
      const isCodingModeResp = originalModelResp === "coding-mode";

      let result2: any = result;

      // Streaming: convert Chat Completions SSE → Responses API SSE
      if (isStream && result2 && typeof result2[Symbol.asyncIterator] === "function") {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();

        console.log(`[DEBUG] Entering streaming for /v1/responses model=${actualModel}`);

        try {
          let chunkCount = 0;
          const streamUsage = await extractUsageFromProviderStream(
            result2 as AsyncIterable<Uint8Array>,
            async (passThrough) => {
              const responsesStream = streamResponsesApi(passThrough, actualModel, {
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

          // Record streaming usage
          if (streamUsage.input_tokens > 0 || streamUsage.output_tokens > 0) {
            try {
              const cost = calculateCost(inputPrice, outputPrice, streamUsage.input_tokens, streamUsage.output_tokens);
              const auth = req.auth;
              if (auth) {
                await recordUsage({
                  apiKeyId: auth.apiKeyId, userId: auth.userId,
                  providerId: String(providerId),
                  inputTokens: streamUsage.input_tokens,
                  outputTokens: streamUsage.output_tokens,
                  inputCost: cost.input_cost,
                  outputCost: cost.output_cost,
                  model: actualModel,
                });
                if (isCodingModeResp && auth.userId) {
                  try { incrementCodingSessionStats(parseInt(auth.userId), streamUsage.input_tokens, streamUsage.output_tokens, cost.input_cost, cost.output_cost, actualModel); } catch (e) { console.error("[coding-stats] Failed to increment:", e); }
                }
              }
            } catch (err) {
              console.error("Failed to record streaming usage:", err);
            }
          }

          console.log(`[DEBUG] Stream finished for /v1/responses model=${actualModel}`);
        } catch (err: any) {
          console.error("Responses stream error:", err);
        } finally {
          res.end();
        }
        return;
      }

      // Non-streaming: convert Chat Completions → Responses format
      if (result2 && typeof result2 === "object") {
        const responsesResult = convertChatCompletionToResponses(result2, actualModel, {
          instructions,
          previousResponseId: body.previous_response_id,
          temperature: body.temperature,
          top_p: body.top_p,
        });

        // Extract usage and record
        try {
          const usage = extractUsage(providerType, result2);
          const cost = calculateCost(inputPrice, outputPrice, usage.input_tokens, usage.output_tokens);

          const auth = req.auth;
          if (auth) {
            await recordUsage({
              apiKeyId: auth.apiKeyId, userId: auth.userId,
              providerId: String(providerId),
              inputTokens: usage.input_tokens,
              outputTokens: usage.output_tokens,
              inputCost: cost.input_cost,
              outputCost: cost.output_cost,
              model: actualModel,
            });
            if (isCodingModeResp && auth.userId) {
              try { incrementCodingSessionStats(parseInt(auth.userId), usage.input_tokens, usage.output_tokens, cost.input_cost, cost.output_cost, actualModel); } catch (e) { console.error("[coding-stats] Failed to increment:", e); }
            }
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
      // Parse thinking level from model suffix (e.g. "claude-sonnet(high)") or body params
      preprocessThinking(body);
      console.log(`[${formatTimestamp()}] POST /v1/messages model=${body.model ?? "?"} stream=${body.stream === true}`);

      // Validate required fields
      const modelName: string = body.model ?? "";
      if (!modelName) {
        res.status(400).json({
          type: "error",
          error: { type: "invalid_request_error", message: "model is required" },
        });
        return;
      }

      // Check model restriction
      if (!isModelAllowedForRequest(req.auth, modelName)) {
        res.status(403).json({
          type: "error",
          error: { type: "permission_error", message: `Model '${modelName}' is not allowed for this API key` },
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

      // Dispatch with coding mode fallback
      const originalModelMsg = modelName;
      let dispatch: DispatchResult;
      const apiKeyIdMsg = req.auth ? parseInt(req.auth.apiKeyId, 10) : undefined;
      try {
        dispatch = await dispatchWithFallback(modelName, chatBody as Record<string, any>, apiKeyIdMsg);
      } catch (err: any) {
        const statusCode = err.message?.includes("Unknown model") || err.message?.includes("coding-mode") ? 400 : 502;
        const errorType = statusCode === 400 ? "invalid_request_error" : "api_error";
        res.status(statusCode).json({
          type: "error",
          error: { type: errorType, message: err.message },
        });
        return;
      }

      const { result, modelName: actualModel, providerType, providerId, providerConfig, inputPrice, outputPrice } = dispatch;
      const isCodingModeMsg = originalModelMsg === "coding-mode";

      // Streaming: convert OpenAI SSE → Anthropic SSE
      if (isStream && result && typeof result[Symbol.asyncIterator] === "function") {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();

        console.log(`[DEBUG] Entering streaming for /v1/messages model=${actualModel}`);

        try {
          let chunkCount = 0;
          const streamUsage = await extractUsageFromProviderStream(
            result as AsyncIterable<Uint8Array>,
            async (passThrough) => {
              const anthropicStream = streamAnthropicApi(passThrough, actualModel);
              for await (const chunk of anthropicStream) {
                chunkCount++;
                writeAndFlush(res, chunk);
              }
            },
          );

          // Record streaming usage
          if (streamUsage.input_tokens > 0 || streamUsage.output_tokens > 0) {
            try {
              const cost = calculateCost(inputPrice, outputPrice, streamUsage.input_tokens, streamUsage.output_tokens);
              const auth = req.auth;
              if (auth) {
                await recordUsage({
                  apiKeyId: auth.apiKeyId, userId: auth.userId,
                  providerId: String(providerId),
                  inputTokens: streamUsage.input_tokens,
                  outputTokens: streamUsage.output_tokens,
                  inputCost: cost.input_cost,
                  outputCost: cost.output_cost,
                  model: actualModel,
                });
                if (isCodingModeMsg && auth.userId) {
                  try { incrementCodingSessionStats(parseInt(auth.userId), streamUsage.input_tokens, streamUsage.output_tokens, cost.input_cost, cost.output_cost, actualModel); } catch (e) { console.error("[coding-stats] Failed to increment:", e); }
                }
              }
            } catch (err) {
              console.error("Failed to record streaming usage:", err);
            }
          }

          console.log(`[DEBUG] Stream finished for /v1/messages model=${actualModel}`);
        } catch (err: any) {
          console.error("Anthropic stream error:", err);
        } finally {
          res.end();
        }
        return;
      }

      // Non-streaming: convert OpenAI → Anthropic Messages API format
      if (result && typeof result === "object") {
        const anthropicResult = convertChatCompletionToAnthropic(result, actualModel);

        // Extract usage and record
        try {
          const usage = extractUsage(providerType, result);
          const cost = calculateCost(inputPrice, outputPrice, usage.input_tokens, usage.output_tokens);

          const auth = req.auth;
          if (auth) {
            await recordUsage({
              apiKeyId: auth.apiKeyId, userId: auth.userId,
              providerId: String(providerId),
              inputTokens: usage.input_tokens,
              outputTokens: usage.output_tokens,
              inputCost: cost.input_cost,
              outputCost: cost.output_cost,
              model: actualModel,
            });
            if (isCodingModeMsg && auth.userId) {
              try { incrementCodingSessionStats(parseInt(auth.userId), usage.input_tokens, usage.output_tokens, cost.input_cost, cost.output_cost, actualModel); } catch (e) { console.error("[coding-stats] Failed to increment:", e); }
            }
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

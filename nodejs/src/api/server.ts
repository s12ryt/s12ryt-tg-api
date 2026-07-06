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
import { extractUsage, extractUsageWithFallback, calculateCost, recordUsage, countTokensAccurate, extractInputTextFromBody, type ProviderConfig } from "./usageTracker.js";
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
import { getProviders, getSetting, lookupModelCached, rebuildProviderCache, onProviderCacheRebuild, getAllCachedModelNames, type Provider, getActiveCodingForApiKey, incrementCodingSessionStats, checkModelAllowed, getAllowedModels, getUserByTgId } from "../db/database.js";
import { config } from "../config.js";
import { preprocessThinking, parseModelThinkingSuffix } from "./thinkingParser.js";
import { addApiLog, type ApiLogEntry } from "./apiLogStore.js";
import webRouter from "../web/routes.js";
import { bindPluginApp, getPluginRootRouter } from "../plugins/index.js";

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

// Node.js plugins are opt-in and inherit the normal API auth/rate/quota chain.
bindPluginApp(app);
app.use("/plugins", getPluginRootRouter());

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
// SSE helpers
// ---------------------------------------------------------------------------

/** Set standard SSE headers and flush.  Eliminates 4× duplication across routes. */
function setupSSEHeaders(res: Response): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
}

/**
 * Calculate cost, record usage, and optionally increment coding session stats.
 * Eliminates ~8× duplicated try/catch blocks across all route handlers.
 */
async function recordUsageAndCost(
  auth: any,
  providerId: string | number,
  modelName: string,
  inTokens: number,
  outTokens: number,
  inPrice: number | null,
  outPrice: number | null,
  isCodingMode: boolean = false,
): Promise<void> {
  // Note: tokens may be estimated (non-zero) even when the provider returned no usage.
  // Skip only when there is genuinely nothing to record.
  if (inTokens <= 0 && outTokens <= 0) return;
  try {
    const cost = calculateCost(inPrice, outPrice, inTokens, outTokens);
    if (!auth) return;
    await recordUsage({
      apiKeyId: auth.apiKeyId, userId: auth.userId,
      providerId: String(providerId),
      inputTokens: inTokens,
      outputTokens: outTokens,
      inputCost: cost.input_cost,
      outputCost: cost.output_cost,
      model: modelName,
    });
    if (isCodingMode && auth.userId) {
      try {
        incrementCodingSessionStats(parseInt(auth.userId), inTokens, outTokens, cost.input_cost, cost.output_cost, modelName);
      } catch (e) {
        console.error("[coding-stats] Failed to increment:", e);
      }
    }
  } catch (err) {
    console.error("Failed to record usage:", err);
  }
}

const MAX_API_LOG_IP_LENGTH = 128;
const MAX_API_LOG_USER_AGENT_LENGTH = 256;

type ApiLogSourceField = "username" | "userId" | "apiKeyId" | "ip" | "userAgent";
type ApiLogPayload = Omit<ApiLogEntry, "id" | ApiLogSourceField>;

function cleanLogHeaderValue(value: unknown, maxLength: number): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return "";
  return raw.replace(/[\r\n]/g, " ").trim().slice(0, maxLength);
}

function getClientIp(req: Request): string {
  const forwardedFor = cleanLogHeaderValue(req.headers["x-forwarded-for"], MAX_API_LOG_IP_LENGTH);
  const forwardedIp = forwardedFor.split(",")[0]?.trim() ?? "";
  return forwardedIp
    || cleanLogHeaderValue(req.headers["cf-connecting-ip"], MAX_API_LOG_IP_LENGTH)
    || cleanLogHeaderValue(req.headers["x-real-ip"], MAX_API_LOG_IP_LENGTH)
    || cleanLogHeaderValue(req.ip, MAX_API_LOG_IP_LENGTH)
    || cleanLogHeaderValue(req.socket.remoteAddress, MAX_API_LOG_IP_LENGTH);
}

function getApiLogSource(req: Request): Pick<ApiLogEntry, ApiLogSourceField> {
  const auth = req.auth;
  const userAgent = cleanLogHeaderValue(req.get("user-agent"), MAX_API_LOG_USER_AGENT_LENGTH);
  const ip = getClientIp(req);
  return {
    username: auth ? String(auth.tgUserId) : "unknown",
    userId: auth?.userId !== undefined ? String(auth.userId) : undefined,
    apiKeyId: auth?.apiKeyId !== undefined ? String(auth.apiKeyId) : undefined,
    ip: ip || undefined,
    userAgent: userAgent || undefined,
  };
}

function writeApiLog(req: Request, entry: ApiLogPayload): void {
  addApiLog({ ...entry, ...getApiLogSource(req) });
}

// ---------------------------------------------------------------------------
// Database-driven model resolution (optimized with in-memory cache)
// ---------------------------------------------------------------------------

import { selectKey, reportSuccess, reportFailure } from "./keySelector.js";

const PROVIDER_DEFAULT_USER_AGENT_SETTING = "provider_default_user_agent";
const MAX_USER_AGENT_LENGTH = 256;

type ResolvedProviderConfig = {
  baseUrl: string;
  apiKey: string;
  _keyIndex: number | null;
  extraHeaders?: Record<string, string>;
};

interface ResolvedProvider {
  providerType: string;
  providerId: number;
  providerName: string;
  config: ResolvedProviderConfig;
  inputPrice: number | null;
  outputPrice: number | null;
  originalModel: string;
}

function normalizeUserAgent(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_USER_AGENT_LENGTH || /[\r\n]/.test(trimmed)) return "";
  return trimmed;
}

function buildUserAgentHeaders(providerUserAgent: unknown): Record<string, string> | undefined {
  const userAgent = normalizeUserAgent(providerUserAgent)
    || normalizeUserAgent(getSetting(PROVIDER_DEFAULT_USER_AGENT_SETTING));
  return userAgent ? { "User-Agent": userAgent } : undefined;
}

/**
 * Fast model lookup — uses in-memory provider cache (zero DB queries).
 * Falls back to full DB scan + cache rebuild on cache miss.
 * Selects best available API key from multi-key JSON array.
 */
function lookupModelDb(modelName: string): ResolvedProvider {
  const cached = lookupModelCached(modelName)
    ?? (rebuildProviderCache(), lookupModelCached(modelName)); // rebuild + retry once on miss
  if (!cached) throw new Error(`Unknown model: ${modelName}`);

  const { key, keyIndex } = selectKey(cached.providerId, cached.apiKey, cached.keyStrategy);
  const extraHeaders = buildUserAgentHeaders(cached.userAgent);
  return {
    providerType: cached.providerType,
    providerId: cached.providerId,
    providerName: cached.providerName,
    config: {
      baseUrl: cached.baseUrl,
      apiKey: key ?? cached.apiKey,
      _keyIndex: keyIndex,
      ...(extraHeaders ? { extraHeaders } : {}),
    },
    inputPrice: cached.inputPrice,
    outputPrice: cached.outputPrice,
    originalModel: cached.originalModel ?? modelName,
  };
}

interface DispatchResult {
  result: any;
  modelName: string;
  upstreamModelName: string;
  providerName: string;
  providerType: string;
  providerId: number;
  providerConfig: ResolvedProviderConfig;
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
  auth?: { userId: string; apiKeyId: string; tgUserId: number },
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

      // BUG-1 fix: enforce model access restrictions (whitelist/blacklist) for fallback models
      if (auth && !isModelAllowedForRequest(auth, fbModel)) {
        continue;
      }

      let fbResolved: ReturnType<typeof lookupModelDb> | undefined;
      try {
        fbResolved = lookupModelDb(fbModel);
        const fbModule = PROVIDER_MODULES[fbResolved.providerType];
        if (!fbModule) continue;

        console.log(`Coding mode: trying model ${fbModel}`);
        const fbBody: Record<string, any> = { ...body, model: fbResolved.originalModel };
        if (fbThinkingLevel) fbBody.thinking_effort = fbThinkingLevel;
        const result = await fbModule.chatCompletion(fbBody, fbResolved.config);

        // BUG-2 fix: report success for multi-key failover tracking
        if (fbResolved.config._keyIndex != null) {
          reportSuccess(fbResolved.providerId, fbResolved.config._keyIndex);
        }

        return {
          result,
          modelName: fbModel,
          upstreamModelName: fbResolved.originalModel,
          providerName: fbResolved.providerName,
          providerType: fbResolved.providerType,
          providerId: fbResolved.providerId,
          providerConfig: fbResolved.config,
          inputPrice: fbResolved.inputPrice,
          outputPrice: fbResolved.outputPrice,
        };
      } catch (fbError: any) {
        // BUG-2 fix: report failure for multi-key failover tracking
        if (fbResolved && fbResolved.config._keyIndex != null) {
          reportFailure(fbResolved.providerId, fbResolved.config._keyIndex);
        }
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
      // Replace body.model with the original model name for upstream calls
      body.model = resolved.originalModel;
      const result = await providerModule.chatCompletion(body, resolved.config);
      // Report success for multi-key failover tracking
      if (resolved.config._keyIndex != null) {
        reportSuccess(resolved.providerId, resolved.config._keyIndex);
      }
      return {
        result,
        modelName,
        upstreamModelName: resolved.originalModel,
        providerName: resolved.providerName,
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

  const names = getAllCachedModelNames();
  const models: ModelEntry[] = [];
  const now = Math.floor(Date.now() / 1000);

  // Always include the coding-mode virtual model
  models.push({
    id: "coding-mode",
    object: "model",
    created: now,
    owned_by: "system",
  });

  // Use cache keys (display names) as model IDs so model mappings are reflected
  for (const displayName of names) {
    const cached = lookupModelCached(displayName);
    models.push({
      id: displayName,
      object: "model",
      created: now,
      owned_by: cached ? cached.providerType : "unknown",
    });
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

export async function forwardStreamAndExtractUsage(
  stream: AsyncIterable<Uint8Array>,
  write: (chunk: Uint8Array) => void,
  inputText?: string,
  providerType?: string,
  providerConfig?: ProviderConfig,
  modelName?: string,
  res?: Response,
): Promise<{ input_tokens: number; output_tokens: number }> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let inputTokens = 0;
  let outputTokens = 0;
  let sseBuffer = "";
  let outputText = "";
  let providerReturnedUsage = false;
  let donePending = false; // [DONE] intercepted; forwarded after usage injection
  let messageStopPending = false; // Anthropic message_stop intercepted
  let anthropicStopEventSeen = false; // "event: message_stop" seen, awaiting data line
  // OpenAI Responses: the terminal "response.completed" event carries usage
  // inside its JSON payload. We hold it so we can patch usage in if missing.
  let responseCompletedPending = false; // response.completed data intercepted
  let responseCompletedEventSeen = false; // "event: response.completed" seen, awaiting data
  let responseCompletedData = ""; // raw payload of the held response.completed data line

  // --- Client disconnect handling ---
  // When the downstream client closes the connection, proactively terminate
  // the upstream provider generator by calling its return(). This triggers
  // the provider's finally block (requestTimeout.abort() + reader.cancel()),
  // immediately releasing the upstream socket/fd instead of waiting for the
  // provider timeout to fire.
  const iterator = stream[Symbol.asyncIterator]();
  let clientClosed = false;
  const onClientClose = (): void => {
    clientClosed = true;
    iterator.return?.().catch(() => undefined);
  };
  if (res) res.on("close", onClientClose);

  try {
    let result = await iterator.next();
    while (!result.done) {
      const chunk = result.value;
      sseBuffer += decoder.decode(chunk, { stream: true });
      const lines = sseBuffer.split("\n");
      sseBuffer = lines.pop() ?? ""; // keep incomplete trailing line

      // Forward lines as-is, but intercept terminal signals so we can inject a
      // usage event before the stream ends. Three protocols are handled:
      //   - OpenAI chat: "data: [DONE]"
      //   - Anthropic:   "event: message_stop" + data with "type":"message_stop"
      // Each terminal is held and re-emitted after the synthetic usage chunk.
      let toForward = "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === "data: [DONE]") {
          donePending = true; // hold [DONE] until after usage injection
        } else if (trimmed === "event: message_stop") {
          anthropicStopEventSeen = true; // hold event line, await matching data
        } else if (anthropicStopEventSeen && trimmed.includes('"type":"message_stop"')) {
          messageStopPending = true; // hold message_stop until after usage injection
          anthropicStopEventSeen = false;
        } else if (trimmed === "event: response.completed") {
          responseCompletedEventSeen = true; // hold, await matching data line
        } else if (responseCompletedEventSeen && trimmed.startsWith("data: ") && trimmed.includes('"type":"response.completed"')) {
          responseCompletedData = trimmed.slice(6); // stash payload for patching
          responseCompletedPending = true;
          responseCompletedEventSeen = false;
          extractUsageFromSSE(trimmed); // capture provider usage if present
        } else {
          if (anthropicStopEventSeen) {
            // Edge case: event line seen but next line wasn't the matching data.
            // Release the held event line to preserve stream integrity.
            toForward += "event: message_stop\n";
            anthropicStopEventSeen = false;
          }
          if (responseCompletedEventSeen) {
            toForward += "event: response.completed\n";
            responseCompletedEventSeen = false;
          }
          toForward += line + "\n";
          extractUsageFromSSE(trimmed);
        }
      }
      if (toForward) write(encoder.encode(toForward));

      if (clientClosed) break; // stop consuming once client is gone
      result = await iterator.next();
    }

    // Flush decoder + remaining buffer (skip if client disconnected mid-stream)
    if (!clientClosed) {
      sseBuffer += decoder.decode();
      if (sseBuffer) {
        let toForward = "";
        for (const line of sseBuffer.split("\n")) {
          const trimmed = line.trim();
          if (trimmed === "data: [DONE]") {
            donePending = true;
          } else if (trimmed === "event: message_stop") {
            anthropicStopEventSeen = true;
          } else if (anthropicStopEventSeen && trimmed.includes('"type":"message_stop"')) {
            messageStopPending = true;
            anthropicStopEventSeen = false;
          } else if (trimmed === "event: response.completed") {
            responseCompletedEventSeen = true;
          } else if (responseCompletedEventSeen && trimmed.startsWith("data: ") && trimmed.includes('"type":"response.completed"')) {
            responseCompletedData = trimmed.slice(6);
            responseCompletedPending = true;
            responseCompletedEventSeen = false;
            extractUsageFromSSE(trimmed);
          } else {
            if (anthropicStopEventSeen) {
              toForward += "event: message_stop\n";
              anthropicStopEventSeen = false;
            }
            if (responseCompletedEventSeen) {
              toForward += "event: response.completed\n";
              responseCompletedEventSeen = false;
            }
            toForward += line + "\n";
            extractUsageFromSSE(trimmed);
          }
        }
        if (toForward) write(encoder.encode(toForward));
        sseBuffer = "";
      }
    }

    // Fallback: count tokens accurately when provider returns no usage
    if (!outputTokens && outputText) outputTokens = await countTokensAccurate(providerType ?? "", outputText, providerConfig, modelName);
    if (!inputTokens && inputText) inputTokens = await countTokensAccurate(providerType ?? "", inputText, providerConfig, modelName);

    // Inject synthetic usage chunk if the provider didn't return one.
    // [DONE] only exists in OpenAI chat completions format, so donePending
    // effectively gates this to that path. We emit the usage chunk before
    // forwarding the intercepted [DONE] so the client receives it in order.
    if (!clientClosed && donePending && !providerReturnedUsage && (inputTokens > 0 || outputTokens > 0)) {
      const usageChunk = `data: ${JSON.stringify({
        id: `chatcmpl-usage-${Date.now()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: modelName ?? "",
        choices: [],
        usage: {
          prompt_tokens: inputTokens,
          completion_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
        },
      })}\n\n`;
      write(encoder.encode(usageChunk));
    }

    // Forward the intercepted [DONE] terminal signal
    if (!clientClosed && donePending) {
      write(encoder.encode("data: [DONE]\n\n"));
    }

    // Anthropic: inject synthetic message_delta with usage before message_stop.
    // message_stop is the terminal signal for the Anthropic Messages SSE format.
    // We emit the usage-bearing message_delta first, then the held message_stop.
    if (!clientClosed && messageStopPending && !providerReturnedUsage && (inputTokens > 0 || outputTokens > 0)) {
      const deltaChunk = `event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      })}\n\n`;
      write(encoder.encode(deltaChunk));
    }

    // Forward the intercepted Anthropic message_stop terminal signal
    if (!clientClosed && messageStopPending) {
      write(encoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'));
    }

    // OpenAI Responses: patch usage into the held response.completed event.
    // The terminal event carries usage at response.usage in its JSON payload;
    // we inject fallback values there if the provider omitted them.
    if (!clientClosed && responseCompletedPending) {
      if (!providerReturnedUsage && (inputTokens > 0 || outputTokens > 0)) {
        try {
          const parsed = JSON.parse(responseCompletedData);
          if (parsed.response) {
            parsed.response.usage = { input_tokens: inputTokens, output_tokens: outputTokens };
          }
          write(encoder.encode(`event: response.completed\ndata: ${JSON.stringify(parsed)}\n\n`));
        } catch {
          // JSON parse failed — forward the original payload unchanged
          write(encoder.encode(`event: response.completed\ndata: ${responseCompletedData}\n\n`));
        }
      } else {
        // Provider already returned usage, or no tokens to inject — forward as-is
        write(encoder.encode(`event: response.completed\ndata: ${responseCompletedData}\n\n`));
      }
    }
  } catch (err) {
    // If the client disconnected, upstream AbortErrors are expected — swallow them.
    if (!clientClosed) throw err;
  } finally {
    if (res) res.off("close", onClientClose);
    // Safety net: ensure the provider generator's finally runs even if we
    // exited via the clientClosed break (idempotent if return() was already called).
    await iterator.return?.().catch(() => undefined);
  }

  return { input_tokens: inputTokens, output_tokens: outputTokens };

  /** Parse a single SSE data line and update token counters in closure. */
  function extractUsageFromSSE(trimmed: string): void {
    if (!trimmed.startsWith("data: ")) return;
    const payload = trimmed.slice(6).trim();
    if (!payload || payload === "[DONE]") return;
    try {
      const parsed = JSON.parse(payload);
      // Standard OpenAI usage (chat completions with include_usage)
      // or Anthropic message_delta usage (parsed.usage)
      // or Anthropic message_start usage (parsed.message.usage)
      const usage = parsed.usage ?? parsed.response?.usage ?? parsed.message?.usage;
      if (usage) {
        providerReturnedUsage = true;
        if (usage.prompt_tokens) inputTokens = usage.prompt_tokens;
        if (usage.completion_tokens) outputTokens = usage.completion_tokens;
        if (!inputTokens && usage.input_tokens) inputTokens = usage.input_tokens;
        if (!outputTokens && usage.output_tokens) outputTokens = usage.output_tokens;
      }
      // Accumulate output text for fallback estimation
      const choices = parsed.choices;
      if (Array.isArray(choices)) {
        for (const choice of choices) {
          const delta = choice.delta ?? choice.message;
          if (delta) {
            if (typeof delta.content === "string") outputText += delta.content;
            if (typeof delta.reasoning_content === "string") outputText += delta.reasoning_content;
            if (typeof delta.reasoning === "string") outputText += delta.reasoning;
          }
        }
      }
      // Anthropic content_block_delta format
      if (parsed.type === "content_block_delta" && parsed.delta) {
        if (typeof parsed.delta.text === "string") outputText += parsed.delta.text;
        if (typeof parsed.delta.thinking === "string") outputText += parsed.delta.thinking;
      }
    } catch { /* not JSON – skip */ }
  }
}

/**
 * Extract usage from a raw OpenAI SSE provider stream while also passing
 * chunks through to a transform (e.g. streamResponsesApi, streamAnthropicApi).
 *
 * Returns the extracted usage after the stream is fully consumed by the transform.
 */
export async function extractUsageFromProviderStream(
  providerStream: AsyncIterable<Uint8Array>,
  transformAndWrite: (providerStream: AsyncIterable<Uint8Array>) => Promise<void>,
  inputText?: string,
  providerType?: string,
  providerConfig?: ProviderConfig,
  modelName?: string,
  res?: Response,
): Promise<{ input_tokens: number; output_tokens: number }> {
  const decoder = new TextDecoder();
  let inputTokens = 0;
  let outputTokens = 0;
  let sseBuffer = "";
  let outputText = "";
  let decoderFlushed = false;
  let streamDone = false;
  let cancelled = false;
  let providerReturnedUsage = false; // provider included usage in SSE
  let usageInjected = false; // fake usage chunk already injected into passThrough
  const fallbackEncoder = new TextEncoder();
  const providerIterator = providerStream[Symbol.asyncIterator]();

  function parseChunk(chunk: Uint8Array): void {
    sseBuffer += decoder.decode(chunk, { stream: true });
    const lines = sseBuffer.split("\n");
    sseBuffer = lines.pop() ?? "";

    for (const line of lines) {
      extractUsageFromSSE(line.trim());
    }
  }

  function flushDecoder(): void {
    if (decoderFlushed) return;
    decoderFlushed = true;
    sseBuffer += decoder.decode();
    for (const line of sseBuffer.split("\n")) {
      extractUsageFromSSE(line.trim());
    }
  }

  function extractUsageFromSSE(trimmed: string): void {
    if (!trimmed.startsWith("data: ")) return;
    const payload = trimmed.slice(6).trim();
    if (!payload || payload === "[DONE]") return;
    try {
      const parsed = JSON.parse(payload);
      const usage = parsed.usage ?? parsed.response?.usage ?? parsed.message?.usage;
      if (usage) {
        providerReturnedUsage = true;
        if (usage.prompt_tokens) inputTokens = usage.prompt_tokens;
        if (usage.completion_tokens) outputTokens = usage.completion_tokens;
        if (!inputTokens && usage.input_tokens) inputTokens = usage.input_tokens;
        if (!outputTokens && usage.output_tokens) outputTokens = usage.output_tokens;
      }
      // Accumulate output text for fallback estimation
      const choices = parsed.choices;
      if (Array.isArray(choices)) {
        for (const choice of choices) {
          const delta = choice?.delta;
          if (delta) {
            if (typeof delta.content === "string") outputText += delta.content;
            if (typeof delta.reasoning_content === "string") outputText += delta.reasoning_content;
            if (typeof delta.reasoning === "string") outputText += delta.reasoning;
          }
        }
      }
      // Anthropic SSE format
      if (parsed.type === "content_block_delta" && parsed.delta) {
        if (typeof parsed.delta.text === "string") outputText += parsed.delta.text;
        if (typeof parsed.delta.thinking === "string") outputText += parsed.delta.thinking;
      }
    } catch { /* skip */ }
  }

  async function cancelProviderStream(): Promise<void> {
    if (cancelled) return;
    cancelled = true;
    if (providerIterator.return) {
      await providerIterator.return().catch(() => undefined);
    }
  }

  // Demand-driven pass-through: the transform's reads pull from the upstream
  // provider stream directly, preserving backpressure without an unbounded queue.
  const passThrough: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<Uint8Array>> {
          if (streamDone || cancelled) {
            return { value: undefined as any, done: true };
          }
          const result = await providerIterator.next();
          if (result.done) {
            streamDone = true;
            flushDecoder();
            // If the provider omitted usage, compute fallback tokens now and
            // inject a synthetic chat-completions usage chunk into the stream.
            // The downstream transform (streamResponsesApi / streamAnthropicApi)
            // will read this and embed the usage into its terminal event, so
            // the client receives accurate usage even for providers that omit it.
            if (!providerReturnedUsage && !usageInjected && !cancelled) {
              usageInjected = true;
              if (!outputTokens && outputText) {
                outputTokens = await countTokensAccurate(providerType ?? "", outputText, providerConfig, modelName);
              }
              if (!inputTokens && inputText) {
                inputTokens = await countTokensAccurate(providerType ?? "", inputText, providerConfig, modelName);
              }
              if (inputTokens > 0 || outputTokens > 0) {
                const fakeChunk = `data: ${JSON.stringify({
                  id: "chatcmpl-usage-fallback",
                  object: "chat.completion.chunk",
                  choices: [],
                  usage: {
                    prompt_tokens: inputTokens,
                    completion_tokens: outputTokens,
                    total_tokens: inputTokens + outputTokens,
                  },
                })}\n\n`;
                return { value: fallbackEncoder.encode(fakeChunk), done: false };
              }
            }
            return { value: undefined as any, done: true };
          }
          parseChunk(result.value);
          return { value: result.value, done: false };
        },
        async return(): Promise<IteratorResult<Uint8Array>> {
          streamDone = true;
          await cancelProviderStream();
          flushDecoder();
          return { value: undefined as any, done: true };
        },
        async throw(error?: unknown): Promise<IteratorResult<Uint8Array>> {
          streamDone = true;
          await cancelProviderStream();
          flushDecoder();
          throw error;
        },
      };
    },
  };

  // --- Client disconnect handling ---
  // Mirror forwardStreamAndExtractUsage: when the downstream client closes,
  // cancel the provider stream so the upstream generator's finally runs
  // (aborting the fetch and releasing the socket).
  const onClientClose = (): void => { cancelProviderStream(); };
  if (res) res.on("close", onClientClose);

  try {
    await transformAndWrite(passThrough);
  } finally {
    if (res) res.off("close", onClientClose);
    if (!streamDone) {
      await cancelProviderStream();
    }
    flushDecoder();
  }

  // Fallback: count tokens accurately when provider returns no usage
  if (!outputTokens && outputText) outputTokens = await countTokensAccurate(providerType ?? "", outputText, providerConfig, modelName);
  if (!inputTokens && inputText) inputTokens = await countTokensAccurate(providerType ?? "", inputText, providerConfig, modelName);

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
    // 無認證：深度防禦，返回空列表（middleware 理論上已擋住未認證請求）
    res.json({ object: "list", data: [] });
  }
});

app.post(
  "/v1/chat/completions",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body;
      // Parse thinking level from model suffix (e.g. "o3(high)") or body params
      try {
        preprocessThinking(body);
      } catch (thinkErr) {
        res.status(400).json({
          error: {
            message: thinkErr instanceof Error ? thinkErr.message : String(thinkErr),
            type: "invalid_request_error",
          },
        });
        return;
      }
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

      // Ensure usage data is included in streaming responses (OpenAI requires stream_options)
      if (body.stream === true) {
        body.stream_options = { ...(body.stream_options || {}), include_usage: true };
      }

      // Dispatch with coding mode fallback
      const originalModel = modelName;
      const logStart = Date.now();
      let dispatch: DispatchResult;
      const apiKeyId = req.auth ? parseInt(req.auth.apiKeyId, 10) : undefined;
      try {
        dispatch = await dispatchWithFallback(modelName, body, apiKeyId, req.auth);
      } catch (err: any) {
        const statusCode = err.message?.includes("Unknown model") || err.message?.includes("coding-mode") ? 400 : 502;
        writeApiLog(req, { timestamp: new Date().toISOString(),
        path: "/v1/chat/completions",
        model: originalModel,
        actualModel: originalModel,
        providerName: "-",
        body: { ...body, model: originalModel },
        responseStatus: statusCode,
        error: err.message,
        latencyMs: Date.now() - logStart, });
        res.status(statusCode).json({
          error: { message: err.message, type: statusCode === 400 ? "invalid_request_error" : "upstream_error" },
        });
        return;
      }

      const { result, modelName: actualModel, upstreamModelName, providerName: dispProviderName, providerType, providerId, providerConfig, inputPrice, outputPrice } = dispatch;
      const isCodingMode = originalModel === "coding-mode";

      const isStream = body.stream === true;

      // Streaming response
      if (isStream && result && typeof result[Symbol.asyncIterator] === "function") {
        setupSSEHeaders(res);

        try {
          let chunkCount = 0;
          const streamUsage = await forwardStreamAndExtractUsage(
            result as AsyncIterable<Uint8Array>,
            (chunk) => { chunkCount++; writeAndFlush(res, chunk); },
            extractInputTextFromBody(body),
            providerType, providerConfig, actualModel,
            res,
          );

          // Record streaming usage
          await recordUsageAndCost(req.auth, providerId, actualModel,
            streamUsage.input_tokens, streamUsage.output_tokens, inputPrice, outputPrice, isCodingMode);
          writeApiLog(req, { timestamp: new Date().toISOString(),
          path: "/v1/chat/completions",
          model: originalModel,
          actualModel: upstreamModelName,
          providerName: dispProviderName,
          body: { ...body, model: originalModel },
          responseStatus: 200,
          inputTokens: streamUsage.input_tokens,
          outputTokens: streamUsage.output_tokens,
          latencyMs: Date.now() - logStart, });
        } catch (err: any) {
          console.error("Stream error:", err);
          writeApiLog(req, { timestamp: new Date().toISOString(),
          path: "/v1/chat/completions",
          model: originalModel,
          actualModel: upstreamModelName,
          providerName: dispProviderName,
          body: { ...body, model: originalModel },
          responseStatus: 502,
          error: err.message,
          latencyMs: Date.now() - logStart, });
        } finally {
          res.end();
        }
        return;
      }

      // Non-streaming: extract usage and record
      if (result && typeof result === "object") {
        try {
          const usage = await extractUsageWithFallback(providerType, result, body, providerConfig, actualModel);
          await recordUsageAndCost(req.auth, providerId, actualModel,
            usage.input_tokens, usage.output_tokens, inputPrice, outputPrice, isCodingMode);
          writeApiLog(req, { timestamp: new Date().toISOString(),
          path: "/v1/chat/completions",
          model: originalModel,
          actualModel: upstreamModelName,
          providerName: dispProviderName,
          body: { ...body, model: originalModel },
          responseStatus: 200,
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          latencyMs: Date.now() - logStart, });
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
      try {
        preprocessThinking(body);
      } catch (thinkErr) {
        res.status(400).json({
          error: {
            message: thinkErr instanceof Error ? thinkErr.message : String(thinkErr),
            type: "invalid_request_error",
          },
        });
        return;
      }
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
      const logStart = Date.now();
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
            // Replace body.model with the original model name for upstream calls
            body.model = _resolved.originalModel;
            const result = await openaiResponseProvider.responsesApi(body, _resolved.config);

            if (isStreamResp && result && Symbol.asyncIterator in Object(result)) {
              setupSSEHeaders(res);

              try {
                const streamUsage = await forwardStreamAndExtractUsage(
                  result as AsyncIterable<Uint8Array>,
                  (chunk) => { writeAndFlush(res, chunk); },
                  extractInputTextFromBody(body),
                  "openai_response", _resolved.config, modelName,
                  res,
                );
                await recordUsageAndCost(
                  req.auth, String(_resolved.providerId), modelName,
                  streamUsage.input_tokens, streamUsage.output_tokens,
                  _resolved.inputPrice, _resolved.outputPrice,
                );
                writeApiLog(req, { timestamp: new Date().toISOString(),
                path: "/v1/responses",
                model: modelName,
                actualModel: _resolved.originalModel,
                providerName: _resolved.providerName,
                body: { ...body, model: modelName },
                responseStatus: 200,
                inputTokens: streamUsage.input_tokens,
                outputTokens: streamUsage.output_tokens,
                latencyMs: Date.now() - logStart, });
              } catch (err: any) {
                console.error("Responses direct stream error:", err);
                writeApiLog(req, { timestamp: new Date().toISOString(),
                path: "/v1/responses",
                model: modelName,
                actualModel: _resolved.originalModel,
                providerName: _resolved.providerName,
                body: { ...body, model: modelName },
                responseStatus: 502,
                error: err.message,
                latencyMs: Date.now() - logStart, });
              } finally {
                res.end();
              }
              return;
            }

            if (result && typeof result === "object") {
              const _usage = await extractUsageWithFallback("openai_response", result as Record<string, any>, body, _resolved.config, modelName);
              const _inT = _usage.input_tokens;
              const _outT = _usage.output_tokens;
              await recordUsageAndCost(
                req.auth, String(_resolved.providerId), modelName,
                _inT, _outT,
                _resolved.inputPrice, _resolved.outputPrice,
              );
              writeApiLog(req, { timestamp: new Date().toISOString(),
              path: "/v1/responses",
              model: modelName,
              actualModel: _resolved.originalModel,
              providerName: _resolved.providerName,
              body: { ...body, model: modelName },
              responseStatus: 200,
              inputTokens: _inT,
              outputTokens: _outT,
              latencyMs: Date.now() - logStart, });
              res.json(result);
              return;
            }
          } catch (err: any) {
            writeApiLog(req, { timestamp: new Date().toISOString(),
            path: "/v1/responses",
            model: modelName,
            actualModel: _resolved.originalModel,
            providerName: _resolved.providerName,
            body: { ...body, model: modelName },
            responseStatus: 502,
            error: err.message,
            latencyMs: Date.now() - logStart, });
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

      // Ensure usage data is included in streaming responses (OpenAI requires stream_options)
      if (isStream) {
        chatBody.stream_options = { ...((chatBody.stream_options as Record<string, unknown>) || {}), include_usage: true };
      }

      // Dispatch with coding mode fallback
      const originalModelResp = modelName;
      let dispatch: DispatchResult;
      const apiKeyIdResp = req.auth ? parseInt(req.auth.apiKeyId, 10) : undefined;
      try {
        dispatch = await dispatchWithFallback(modelName, chatBody as Record<string, any>, apiKeyIdResp, req.auth);
      } catch (err: any) {
        const statusCode = err.message?.includes("Unknown model") || err.message?.includes("coding-mode") ? 400 : 502;
        writeApiLog(req, { timestamp: new Date().toISOString(),
        path: "/v1/responses",
        model: originalModelResp,
        actualModel: originalModelResp,
        providerName: "-",
        body: { ...body },
        responseStatus: statusCode,
        error: err.message,
        latencyMs: Date.now() - logStart, });
        res.status(statusCode).json({
          error: { message: err.message, type: statusCode === 400 ? "invalid_request_error" : "upstream_error" },
        });
        return;
      }

      const { result, modelName: actualModel, upstreamModelName, providerName: respProviderName, providerType: pt, providerId: pid, providerConfig: pcfg, inputPrice: ip, outputPrice: op } = dispatch;
      providerType = pt;
      providerId = pid;
      providerConfig = pcfg;
      inputPrice = ip;
      outputPrice = op;
      const isCodingModeResp = originalModelResp === "coding-mode";

      let result2: any = result;

      // Streaming: convert Chat Completions SSE → Responses API SSE
      if (isStream && result2 && typeof result2[Symbol.asyncIterator] === "function") {
        setupSSEHeaders(res);

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
            extractInputTextFromBody(body),
            providerType, providerConfig, actualModel,
            res,
          );

          // Record streaming usage
          await recordUsageAndCost(req.auth, String(providerId), actualModel, streamUsage.input_tokens, streamUsage.output_tokens, inputPrice, outputPrice, isCodingModeResp);
          writeApiLog(req, { timestamp: new Date().toISOString(),
          path: "/v1/responses",
          model: originalModelResp,
          actualModel: upstreamModelName,
          providerName: respProviderName,
          body: { ...body },
          responseStatus: 200,
          inputTokens: streamUsage.input_tokens,
          outputTokens: streamUsage.output_tokens,
          latencyMs: Date.now() - logStart, });

        } catch (err: any) {
          console.error("Responses stream error:", err);
          writeApiLog(req, { timestamp: new Date().toISOString(),
          path: "/v1/responses",
          model: originalModelResp,
          actualModel: upstreamModelName,
          providerName: respProviderName,
          body: { ...body },
          responseStatus: 502,
          error: err.message,
          latencyMs: Date.now() - logStart, });
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
          const usage = await extractUsageWithFallback(providerType, result2, body, providerConfig, actualModel);
          await recordUsageAndCost(req.auth, String(providerId), actualModel, usage.input_tokens, usage.output_tokens, inputPrice, outputPrice, isCodingModeResp);
          writeApiLog(req, { timestamp: new Date().toISOString(),
          path: "/v1/responses",
          model: originalModelResp,
          actualModel: upstreamModelName,
          providerName: respProviderName,
          body: { ...body },
          responseStatus: 200,
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          latencyMs: Date.now() - logStart, });
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
      try {
        preprocessThinking(body);
      } catch (thinkErr) {
        res.status(400).json({
          type: "error",
          error: {
            type: "invalid_request_error",
            message: thinkErr instanceof Error ? thinkErr.message : String(thinkErr),
          },
        });
        return;
      }
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

      // Optimization: for anthropic providers in non-coding mode, pass through directly
      // without converting Anthropic Messages → Chat Completions → Anthropic Messages.
      const logStart = Date.now();
      const isCodingMsg = modelName === "coding-mode";
      const isStreamMsg = body.stream === true;

      if (!isCodingMsg) {
        let _resolved: ResolvedProvider;
        try {
          _resolved = lookupModelDb(modelName);
        } catch (err: any) {
          const statusCode = err.message?.includes("Unknown model") ? 400 : 502;
          res.status(statusCode).json({
            type: "error",
            error: { type: statusCode === 400 ? "invalid_request_error" : "api_error", message: err.message },
          });
          return;
        }

        if (_resolved.providerType === "anthropic") {
          try {
            // Replace body.model with the original model name for upstream calls
            body.model = _resolved.originalModel;
            const result = await anthropicProvider.messagesApi(body, _resolved.config);

            if (isStreamMsg && result && Symbol.asyncIterator in Object(result)) {
              setupSSEHeaders(res);

              try {
                const streamUsage = await forwardStreamAndExtractUsage(
                  result as AsyncIterable<Uint8Array>,
                  (chunk) => { writeAndFlush(res, chunk); },
                  extractInputTextFromBody(body),
                  "anthropic", _resolved.config, modelName,
                  res,
                );
                await recordUsageAndCost(
                  req.auth, String(_resolved.providerId), modelName,
                  streamUsage.input_tokens, streamUsage.output_tokens,
                  _resolved.inputPrice, _resolved.outputPrice,
                );
                writeApiLog(req, { timestamp: new Date().toISOString(),
                path: "/v1/messages",
                model: modelName,
                actualModel: _resolved.originalModel,
                providerName: _resolved.providerName,
                body: { ...body, model: modelName },
                responseStatus: 200,
                inputTokens: streamUsage.input_tokens,
                outputTokens: streamUsage.output_tokens,
                latencyMs: Date.now() - logStart, });
              } catch (err: any) {
                console.error("Messages direct stream error:", err);
                writeApiLog(req, { timestamp: new Date().toISOString(),
                path: "/v1/messages",
                model: modelName,
                actualModel: _resolved.originalModel,
                providerName: _resolved.providerName,
                body: { ...body, model: modelName },
                responseStatus: 502,
                error: err.message,
                latencyMs: Date.now() - logStart, });
              } finally {
                res.end();
              }
              return;
            }

            if (result && typeof result === "object") {
              const _usage = await extractUsageWithFallback("anthropic", result as Record<string, any>, body, _resolved.config, modelName);
              const _inT = _usage.input_tokens;
              const _outT = _usage.output_tokens;
              await recordUsageAndCost(
                req.auth, String(_resolved.providerId), modelName,
                _inT, _outT,
                _resolved.inputPrice, _resolved.outputPrice,
              );
              writeApiLog(req, { timestamp: new Date().toISOString(),
              path: "/v1/messages",
              model: modelName,
              actualModel: _resolved.originalModel,
              providerName: _resolved.providerName,
              body: { ...body, model: modelName },
              responseStatus: 200,
              inputTokens: _inT,
              outputTokens: _outT,
              latencyMs: Date.now() - logStart, });
              res.json(result);
              return;
            }
          } catch (err: any) {
            writeApiLog(req, { timestamp: new Date().toISOString(),
            path: "/v1/messages",
            model: modelName,
            actualModel: _resolved.originalModel,
            providerName: _resolved.providerName,
            body: { ...body, model: modelName },
            responseStatus: 502,
            error: err.message,
            latencyMs: Date.now() - logStart, });
            res.status(502).json({
              type: "error",
              error: { type: "api_error", message: err.message },
            });
            return;
          }
        }
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

      // Ensure streaming requests include usage in the final SSE chunk
      if (isStream) {
        (chatBody as typeof chatBody & { stream_options?: Record<string, unknown> }).stream_options = {
          ...((chatBody as typeof chatBody & { stream_options?: Record<string, unknown> }).stream_options || {}),
          include_usage: true,
        };
      }

      // Dispatch with coding mode fallback
      const originalModelMsg = modelName;
      let dispatch: DispatchResult;
      const apiKeyIdMsg = req.auth ? parseInt(req.auth.apiKeyId, 10) : undefined;
      try {
        dispatch = await dispatchWithFallback(modelName, chatBody as Record<string, any>, apiKeyIdMsg, req.auth);
      } catch (err: any) {
        const statusCode = err.message?.includes("Unknown model") || err.message?.includes("coding-mode") ? 400 : 502;
        const errorType = statusCode === 400 ? "invalid_request_error" : "api_error";
        writeApiLog(req, { timestamp: new Date().toISOString(),
        path: "/v1/messages",
        model: originalModelMsg,
        actualModel: originalModelMsg,
        providerName: "-",
        body: { ...body },
        responseStatus: statusCode,
        error: err.message,
        latencyMs: Date.now() - logStart, });
        res.status(statusCode).json({
          type: "error",
          error: { type: errorType, message: err.message },
        });
        return;
      }

      const { result, modelName: actualModel, upstreamModelName, providerName: msgProviderName, providerType, providerId, providerConfig, inputPrice, outputPrice } = dispatch;
      const isCodingModeMsg = originalModelMsg === "coding-mode";

      // Streaming: convert OpenAI SSE → Anthropic SSE
      if (isStream && result && typeof result[Symbol.asyncIterator] === "function") {
        setupSSEHeaders(res);

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
            extractInputTextFromBody(body),
            providerType, providerConfig, actualModel,
            res,
          );

          await recordUsageAndCost(req.auth, String(providerId), actualModel, streamUsage.input_tokens, streamUsage.output_tokens, inputPrice, outputPrice, isCodingModeMsg);
          writeApiLog(req, { timestamp: new Date().toISOString(),
          path: "/v1/messages",
          model: originalModelMsg,
          actualModel: upstreamModelName,
          providerName: msgProviderName,
          body: { ...body },
          responseStatus: 200,
          inputTokens: streamUsage.input_tokens,
          outputTokens: streamUsage.output_tokens,
          latencyMs: Date.now() - logStart, });
        } catch (err: any) {
          console.error("Anthropic stream error:", err);
          writeApiLog(req, { timestamp: new Date().toISOString(),
          path: "/v1/messages",
          model: originalModelMsg,
          actualModel: upstreamModelName,
          providerName: msgProviderName,
          body: { ...body },
          responseStatus: 502,
          error: err.message,
          latencyMs: Date.now() - logStart, });
        } finally {
          res.end();
        }
        return;
      }

      // Non-streaming: convert OpenAI → Anthropic Messages API format
      if (result && typeof result === "object") {
        const anthropicResult = convertChatCompletionToAnthropic(result, actualModel);

        try {
          const usage = await extractUsageWithFallback(providerType, result, body, providerConfig, actualModel);
          await recordUsageAndCost(req.auth, String(providerId), actualModel, usage.input_tokens, usage.output_tokens, inputPrice, outputPrice, isCodingModeMsg);
          writeApiLog(req, { timestamp: new Date().toISOString(),
          path: "/v1/messages",
          model: originalModelMsg,
          actualModel: upstreamModelName,
          providerName: msgProviderName,
          body: { ...body },
          responseStatus: 200,
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          latencyMs: Date.now() - logStart, });
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

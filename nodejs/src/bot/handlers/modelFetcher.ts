/**
 * Utility: fetch provider model list and pricing from external APIs.
 *
 * 1. Fetches models from the provider's base_url + /models endpoint
 * 2. Fetches pricing from https://models.dev/api.json
 */

import { getFirstKey } from "../../api/keySelector.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ModelsDevCost {
  input?: number;
  output?: number;
}

interface ModelsDevModel {
  id: string;
  name?: string;
  cost?: ModelsDevCost;
}

interface ModelsDevProvider {
  id: string;
  models: Record<string, ModelsDevModel>;
}

type ModelsDevData = Record<string, ModelsDevProvider>;

export interface FetchedModel {
  id: string;
  name?: string;
}

export interface FetchedPricing {
  input: number | null;
  output: number | null;
}

// ---------------------------------------------------------------------------
// Cache for models.dev data (refreshed every hour)
// ---------------------------------------------------------------------------

let modelsDevCache: { data: ModelsDevData; timestamp: number } | null = null;
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function getModelsDevData(): Promise<ModelsDevData> {
  const now = Date.now();
  if (modelsDevCache && now - modelsDevCache.timestamp < CACHE_TTL) {
    return modelsDevCache.data;
  }

  try {
    const resp = await fetch("https://models.dev/api.json");
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const data = (await resp.json()) as ModelsDevData;
    modelsDevCache = { data, timestamp: now };
    return data;
  } catch (err) {
    console.error("[models.dev] Failed to fetch pricing data:", err);
    // Return stale cache if available
    if (modelsDevCache) return modelsDevCache.data;
    return {};
  }
}

// ---------------------------------------------------------------------------
// Fetch model list from provider's /models endpoint
// ---------------------------------------------------------------------------

export async function fetchProviderModels(
  baseUrl: string,
  apiKey: string,
  apiType: string
): Promise<FetchedModel[]> {
  // Extract single key from possible JSON array for API calls
  const singleKey = getFirstKey(apiKey);
  try {
    // Build models endpoint: baseUrl + /models (or + models if trailing /)
    let modelsUrl: string;
    if (baseUrl.endsWith("/")) {
      modelsUrl = `${baseUrl}models`;
    } else {
      modelsUrl = `${baseUrl}/models`;
    }

    // Set authentication headers / URL params based on apiType
    const headers: Record<string, string> = {};
    if (apiType === "google") {
      const separator = modelsUrl.includes("?") ? "&" : "?";
      modelsUrl = `${modelsUrl}${separator}key=${encodeURIComponent(singleKey)}`;
    } else if (apiType === "anthropic") {
      headers["x-api-key"] = singleKey;
      headers["anthropic-version"] = "2023-06-01";
    } else {
      headers["Authorization"] = `Bearer ${singleKey}`;
    }

    const resp = await fetch(modelsUrl, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      console.warn(`[fetchModels] ${modelsUrl} returned HTTP ${resp.status}, skipping model list`);
      return [];
    }

    const json = await resp.json() as any;

    // OpenAI-compatible format: { data: [{ id: "gpt-4o", ... }] }
    if (json.data && Array.isArray(json.data)) {
      return json.data
        .map((m: any) => ({ id: m.id, name: m.id }))
        .filter((m: FetchedModel) => !!m.id);
    }

    // Google format: { models: [{ name: "models/gemini-pro", ... }] }
    if (json.models && Array.isArray(json.models)) {
      return json.models
        .map((m: any) => {
          // Google model names are like "models/gemini-pro" → extract "gemini-pro"
          const id = m.name?.replace(/^models\//, "") ?? m.id;
          return { id, name: m.displayName ?? id };
        })
        .filter((m: FetchedModel) => !!m.id);
    }

    return [];
  } catch (err) {
    console.error("[fetchModels] Failed:", err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Fetch pricing from models.dev
// ---------------------------------------------------------------------------

/**
 * Look up pricing for a list of models from models.dev.
 *
 * Searches across all providers for matching model IDs.
 * Returns a map: modelId → { input, output } (per 1M tokens, USD).
 */
export async function fetchModelsPricing(
  modelIds: string[]
): Promise<Map<string, FetchedPricing>> {
  const result = new Map<string, FetchedPricing>();

  if (modelIds.length === 0) return result;

  try {
    const data = await getModelsDevData();

    // Build a flat map of all models across all providers
    for (const provider of Object.values(data)) {
      for (const [modelId, modelInfo] of Object.entries(provider.models)) {
        // Only look for models we care about
        for (const targetId of modelIds) {
          if (
            !result.has(targetId) &&
            (modelId === targetId ||
              modelId.includes(targetId) ||
              targetId.includes(modelId))
          ) {
            const cost = modelInfo.cost;
            result.set(targetId, {
              input: cost?.input ?? null,
              output: cost?.output ?? null,
            });
          }
        }
      }
    }
  } catch (err) {
    console.error("[fetchPricing] Failed:", err);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Detect supported API protocols by probing endpoints (v2 — precise analysis)
// ---------------------------------------------------------------------------

export interface ProbeDetail {
  supported: boolean;
  confidence: "high" | "medium" | "low";
  reason: string;
}

export interface DetectionResult {
  protocols: Record<string, ProbeDetail>;
  recommended: string | null;
}

function buildUrl(baseUrl: string, path: string): string {
  if (baseUrl.endsWith("/")) {
    return `${baseUrl}${path.replace(/^\//, "")}`;
  }
  return `${baseUrl}/${path.replace(/^\//, "")}`;
}

/**
 * Send a probe request. Returns { status, bodySnippet } or nulls on error.
 */
async function detailedProbe(
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: Record<string, unknown>,
  timeoutMs = 15_000
): Promise<{ status: number | null; bodySnippet: string | null }> {
  try {
    const opts: RequestInit = {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (method === "POST") {
      opts.method = "POST";
      opts.body = JSON.stringify(body ?? {});
    }
    const resp = await fetch(url, opts);
    const text = await resp.text();
    return { status: resp.status, bodySnippet: text.slice(0, 500) || null };
  } catch {
    return { status: null, bodySnippet: null };
  }
}

/**
 * Analyze a probe's HTTP status code to determine protocol support.
 */
function analyzeStatus(statusCode: number | null, _body: string | null): ProbeDetail {
  if (statusCode === null) {
    return { supported: false, confidence: "high", reason: "連線失敗（無法連接到伺服器）" };
  }
  if (statusCode === 404) {
    return { supported: false, confidence: "high", reason: "端點不存在（404 Not Found）" };
  }
  if (statusCode >= 200 && statusCode < 300) {
    return { supported: true, confidence: "high", reason: "端點正常回應" };
  }
  if (statusCode === 400 || statusCode === 422) {
    return { supported: true, confidence: "high", reason: "端點存在（請求格式有誤）" };
  }
  if (statusCode === 401 || statusCode === 403) {
    return { supported: true, confidence: "medium", reason: "端點存在但需要認證" };
  }
  if (statusCode === 405) {
    return { supported: true, confidence: "low", reason: "端點可能存在（方法不允許）" };
  }
  if (statusCode >= 500) {
    return { supported: true, confidence: "low", reason: "伺服器錯誤（端點可能存在）" };
  }
  return { supported: false, confidence: "low", reason: `未預期的狀態碼 (${statusCode})` };
}

/**
 * Pick the better of two ProbeDetails (higher confidence + supported wins).
 */
function pickBetter(a: ProbeDetail, b: ProbeDetail): ProbeDetail {
  if (a.supported && !b.supported) return a;
  if (b.supported && !a.supported) return b;
  if (!a.supported && !b.supported) return a;
  const rank: Record<string, number> = { high: 3, medium: 2, low: 1 };
  return (rank[a.confidence] ?? 0) >= (rank[b.confidence] ?? 0) ? a : b;
}

/**
 * Auto-recommend an api_type based on detection results.
 */
function recommendType(protocols: Record<string, ProbeDetail>): string | null {
  const high = Object.entries(protocols)
    .filter(([, v]) => v.supported && v.confidence === "high")
    .map(([k]) => k);
  if (high.length === 1) return high[0];
  if (high.length > 1) return high.includes("openai_chat") ? "openai_chat" : high[0];

  const medium = Object.entries(protocols)
    .filter(([, v]) => v.supported && (v.confidence === "high" || v.confidence === "medium"))
    .map(([k]) => k);
  if (medium.length === 1) return medium[0];
  if (medium.length > 1) return medium.includes("openai_chat") ? "openai_chat" : medium[0];

  return null;
}

/**
 * Probe the provider to detect which API protocols are supported.
 *
 * v2: Uses precise HTTP status code analysis instead of binary reachable/unreachable.
 * Returns a DetectionResult with per-protocol ProbeDetail and an auto-recommended api_type.
 */
export async function detectApiProtocols(
  baseUrl: string,
  apiKey: string
): Promise<DetectionResult> {
  // Extract single key from possible JSON array for API probes
  const singleKey = getFirstKey(apiKey);
  const bearer: Record<string, string> = { Authorization: `Bearer ${singleKey}` };
  const bearerJson: Record<string, string> = {
    ...bearer,
    "content-type": "application/json",
  };
  const anthropicHeaders: Record<string, string> = {
    "x-api-key": singleKey,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };

  // Run all probes in parallel
  // Note: openai_chat detection uses ONLY POST /chat/completions (NOT GET /models,
  // because /models is a generic listing endpoint that doesn't indicate chat support)
  // For anthropic, try BOTH /v1/messages AND /messages (handle /v1 prefix in baseUrl)
  const [
    chatPost,
    responsePost,
    anthropicV1,
    anthropicNoV1,
    googleGet,
  ] = await Promise.all([
    // openai_chat: POST /chat/completions
    detailedProbe("POST", buildUrl(baseUrl, "/chat/completions"), bearerJson, {}),
    // openai_response: POST /responses
    detailedProbe("POST", buildUrl(baseUrl, "/responses"), bearerJson, {}),
    // anthropic: POST /v1/messages (standard — baseUrl doesn't include /v1)
    detailedProbe("POST", buildUrl(baseUrl, "/v1/messages"), anthropicHeaders, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    }),
    // anthropic: POST /messages (baseUrl already includes /v1)
    detailedProbe("POST", buildUrl(baseUrl, "/messages"), anthropicHeaders, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    }),
    // google: GET /models?key=
    detailedProbe(
      "GET",
      `${buildUrl(baseUrl, "/models")}?key=${encodeURIComponent(singleKey)}`,
      {}
    ),
  ]);

  // openai_chat: POST /chat/completions only (NOT GET /models)
  const openaiChat = analyzeStatus(chatPost.status, chatPost.bodySnippet);

  // openai_response: POST /responses
  const openaiResponse = analyzeStatus(responsePost.status, responsePost.bodySnippet);

  // anthropic: pick the better of /v1/messages and /messages
  const anthropic = pickBetter(analyzeStatus(anthropicV1.status, anthropicV1.bodySnippet), analyzeStatus(anthropicNoV1.status, anthropicNoV1.bodySnippet));

  // google: GET /models?key=
  const google = analyzeStatus(googleGet.status, googleGet.bodySnippet);

  const protocols: Record<string, ProbeDetail> = {
    openai_chat: openaiChat,
    openai_response: openaiResponse,
    anthropic,
    google,
  };

  const recommended = recommendType(protocols);

  return { protocols, recommended };
}

// ---------------------------------------------------------------------------
// Fetch model list without auth (for /model_catch)
// ---------------------------------------------------------------------------

/**
 * Try to fetch models without authentication.
 * Returns { models, needsAuth }.
 */
export async function fetchModelsNoAuth(
  baseUrl: string
): Promise<{ models: FetchedModel[]; needsAuth: boolean }> {
  try {
    const url = baseUrl.endsWith("/") ? `${baseUrl}models` : `${baseUrl}/models`;

    const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });

    if (resp.status === 401 || resp.status === 403) {
      return { models: [], needsAuth: true };
    }

    if (!resp.ok) {
      return { models: [], needsAuth: false };
    }

    const json = (await resp.json()) as any;
    const models: FetchedModel[] = [];

    // OpenAI-compatible format
    if (json.data && Array.isArray(json.data)) {
      for (const m of json.data) {
        if (m?.id) models.push({ id: m.id, name: m.id });
      }
    }
    // Google format
    else if (json.models && Array.isArray(json.models)) {
      for (const m of json.models) {
        const rawName: string = m.name || "";
        const modelId = rawName ? rawName.replace("models/", "") : m.id || "";
        if (modelId) {
          models.push({ id: modelId, name: m.displayName || modelId });
        }
      }
    }

    return { models, needsAuth: false };
  } catch (e) {
    console.warn("[fetchModelsNoAuth] Failed:", (e as Error).message);
    return { models: [], needsAuth: false };
  }
}

// ---------------------------------------------------------------------------
// Detect protocols without auth (for /api_test)
// ---------------------------------------------------------------------------

/**
 * Probe API protocols without authentication.
 * Returns { result, allUnreachable }.
 */
export async function detectProtocolsNoAuth(
  baseUrl: string
): Promise<{ result: DetectionResult; allUnreachable: boolean }> {
  const result = await detectApiProtocols(baseUrl, "");
  const allUnreachable = Object.values(result.protocols).every(
    (d) => !d.supported && d.confidence === "high"
  );
  return { result, allUnreachable };
}

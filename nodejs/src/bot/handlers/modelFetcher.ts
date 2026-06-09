/**
 * Utility: fetch provider model list and pricing from external APIs.
 *
 * 1. Fetches models from the provider's base_url + /model endpoint
 * 2. Fetches pricing from https://models.dev/api.json
 */

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
// Fetch model list from provider's /model endpoint
// ---------------------------------------------------------------------------

export async function fetchProviderModels(
  baseUrl: string,
  apiKey: string,
  apiType: string
): Promise<FetchedModel[]> {
  try {
    // Build models endpoint: baseUrl + /model (or + model if trailing /)
    let modelsUrl: string;
    if (baseUrl.endsWith("/")) {
      modelsUrl = `${baseUrl}model`;
    } else {
      modelsUrl = `${baseUrl}/model`;
    }

    // Set authentication headers / URL params based on apiType
    const headers: Record<string, string> = {};
    if (apiType === "google") {
      const separator = modelsUrl.includes("?") ? "&" : "?";
      modelsUrl = `${modelsUrl}${separator}key=${encodeURIComponent(apiKey)}`;
    } else if (apiType === "anthropic") {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else {
      headers["Authorization"] = `Bearer ${apiKey}`;
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
// Detect supported API protocols by probing endpoints
// ---------------------------------------------------------------------------

export interface ProtocolStatus {
  openai_chat: boolean;
  openai_response: boolean;
  anthropic: boolean;
  google: boolean;
}

function buildUrl(baseUrl: string, path: string): string {
  if (baseUrl.endsWith("/")) {
    return `${baseUrl}${path.replace(/^\//, "")}`;
  }
  return `${baseUrl}/${path.replace(/^\//, "")}`;
}

async function probeGet(url: string, headers: Record<string, string>): Promise<boolean> {
  try {
    await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    return true;
  } catch {
    return false;
  }
}

async function probePost(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>
): Promise<boolean> {
  try {
    await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Probe the provider to detect which API protocols are supported.
 *
 * Sends GET + POST requests in parallel with 15s timeout per protocol.
 * A protocol is "reachable" if the server returns ANY HTTP response
 * (including 4xx) — only network-level failures count as unreachable.
 */
export async function detectApiProtocols(
  baseUrl: string,
  apiKey: string
): Promise<ProtocolStatus> {
  const bearer: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
  const bearerJson: Record<string, string> = {
    ...bearer,
    "content-type": "application/json",
  };
  const anthropicHeaders: Record<string, string> = {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };

  // Run all probes in parallel
  const [chatGet, chatPost, responsePost, anthropicPost, googleGet] = await Promise.all([
    // openai_chat: GET /models + POST /chat/completions
    probeGet(buildUrl(baseUrl, "/models"), bearer),
    probePost(buildUrl(baseUrl, "/chat/completions"), bearerJson, {}),

    // openai_response: POST /responses
    probePost(buildUrl(baseUrl, "/responses"), bearerJson, {}),

    // anthropic: POST /v1/messages (minimal body)
    probePost(buildUrl(baseUrl, "/v1/messages"), anthropicHeaders, {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    }),

    // google: GET /models?key=
    probeGet(
      `${buildUrl(baseUrl, "/models")}?key=${encodeURIComponent(apiKey)}`,
      {}
    ),
  ]);

  return {
    openai_chat: chatGet || chatPost,
    openai_response: responsePost,
    anthropic: anthropicPost,
    google: googleGet,
  };
}

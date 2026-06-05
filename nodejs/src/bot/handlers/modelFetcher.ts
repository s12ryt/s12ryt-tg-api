/**
 * Utility: fetch provider model list and pricing from external APIs.
 *
 * 1. Fetches /v1/models from the provider's base_url + api_key
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
// Fetch model list from provider's /v1/models endpoint
// ---------------------------------------------------------------------------

export async function fetchProviderModels(
  baseUrl: string,
  apiKey: string,
  apiType: string
): Promise<FetchedModel[]> {
  try {
    // Normalize base URL: strip trailing slashes and /v1 suffix
    let cleanBase = baseUrl.replace(/\/+$/, "");
    if (cleanBase.endsWith("/v1")) {
      cleanBase = cleanBase.slice(0, -3);
    }

    // Build the models endpoint URL
    let modelsUrl: string;
    if (apiType === "google") {
      modelsUrl = `${cleanBase}/v1beta/models?key=${apiKey}`;
    } else {
      modelsUrl = `${cleanBase}/v1/models`;
    }

    const headers: Record<string, string> = {};
    if (apiType === "anthropic") {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else if (apiType === "google") {
      // Key is in URL already
    } else {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const resp = await fetch(modelsUrl, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
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

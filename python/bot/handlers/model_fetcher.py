"""
Utility: fetch provider model list and pricing from external APIs.

1. Fetches /v1/models from the provider's base_url + api_key
2. Fetches pricing from https://models.dev/api.json
"""

from __future__ import annotations

import time
from typing import Any

import httpx

# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------

FetchedModel = dict[str, str]  # {"id": "...", "name": "..."}

FetchedPricing = dict[str, float | None]  # {"input": ..., "output": ...}

# ---------------------------------------------------------------------------
# Cache for models.dev data (refreshed every hour)
# ---------------------------------------------------------------------------

_models_dev_cache: dict[str, Any] | None = None
_cache_timestamp: float = 0.0
_CACHE_TTL = 3600.0  # 1 hour


async def _get_models_dev_data() -> dict[str, Any]:
    global _models_dev_cache, _cache_timestamp

    now = time.time()
    if _models_dev_cache is not None and now - _cache_timestamp < _CACHE_TTL:
        return _models_dev_cache

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get("https://models.dev/api.json")
            resp.raise_for_status()
            data = resp.json()
            _models_dev_cache = data
            _cache_timestamp = now
            return data
    except Exception as e:
        print(f"[models.dev] Failed to fetch pricing data: {e}")
        if _models_dev_cache is not None:
            return _models_dev_cache
        return {}


# ---------------------------------------------------------------------------
# Fetch model list from provider's /v1/models endpoint
# ---------------------------------------------------------------------------


async def fetch_provider_models(
    base_url: str,
    api_key: str,
    api_type: str,
) -> list[FetchedModel]:
    """Fetch the list of models from a provider's API endpoint."""
    try:
        # Normalize base URL: strip trailing slashes and /v1 suffix
        base_url = base_url.rstrip("/")
        if base_url.endswith("/v1"):
            base_url = base_url[:-3]

        if api_type == "google":
            url = f"{base_url}/v1beta/models?key={api_key}"
            headers: dict[str, str] = {}
        elif api_type == "anthropic":
            url = f"{base_url}/v1/models"
            headers = {
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
            }
        else:
            # openai-compatible
            url = f"{base_url}/v1/models"
            headers = {"Authorization": f"Bearer {api_key}"}

        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(url, headers=headers)
            resp.raise_for_status()
            json_data = resp.json()

        models: list[FetchedModel] = []

        # OpenAI-compatible format: { "data": [{ "id": "gpt-4o" }] }
        if "data" in json_data and isinstance(json_data["data"], list):
            for m in json_data["data"]:
                if isinstance(m, dict) and m.get("id"):
                    models.append({"id": m["id"], "name": m["id"]})

        # Google format: { "models": [{ "name": "models/gemini-pro" }] }
        elif "models" in json_data and isinstance(json_data["models"], list):
            for m in json_data["models"]:
                if isinstance(m, dict):
                    raw_name = m.get("name", "")
                    # Strip "models/" prefix
                    model_id = raw_name.replace("models/", "") if raw_name else m.get("id", "")
                    if model_id:
                        models.append({
                            "id": model_id,
                            "name": m.get("displayName", model_id),
                        })

        return models
    except Exception as e:
        print(f"[fetch_provider_models] Failed: {e}")
        return []


# ---------------------------------------------------------------------------
# Fetch pricing from models.dev
# ---------------------------------------------------------------------------


async def fetch_models_pricing(
    model_ids: list[str],
) -> dict[str, FetchedPricing]:
    """
    Look up pricing for a list of models from models.dev.

    Returns a dict: model_id → {"input": float|None, "output": float|None}
    (per 1M tokens, USD).
    """
    result: dict[str, FetchedPricing] = {}

    if not model_ids:
        return result

    try:
        data = await _get_models_dev_data()

        for provider_data in data.values():
            if not isinstance(provider_data, dict):
                continue
            provider_models = provider_data.get("models", {})
            if not isinstance(provider_models, dict):
                continue

            for model_id, model_info in provider_models.items():
                if not isinstance(model_info, dict):
                    continue

                for target_id in model_ids:
                    if target_id in result:
                        continue

                    # Match by exact, contains, or reverse-contains
                    if (
                        model_id == target_id
                        or model_id in target_id
                        or target_id in model_id
                    ):
                        cost = model_info.get("cost", {})
                        result[target_id] = {
                            "input": cost.get("input") if isinstance(cost, dict) else None,
                            "output": cost.get("output") if isinstance(cost, dict) else None,
                        }
    except Exception as e:
        print(f"[fetch_models_pricing] Failed: {e}")

    return result

"""
Utility: fetch provider model list and pricing from external APIs.

1. Fetches models from the provider's base_url + /model endpoint
2. Fetches pricing from https://models.dev/api.json
3. Detects supported API protocols by probing endpoints
"""

from __future__ import annotations

import asyncio
import time
import urllib.parse
from typing import Any

import httpx

# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------

FetchedModel = dict[str, str]  # {"id": "...", "name": "..."}

FetchedPricing = dict[str, float | None]  # {"input": ..., "output": ...}

ProtocolStatus = dict[str, bool]  # {"openai_chat": True, "anthropic": False, ...}

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
# Fetch model list from provider's /model endpoint
# ---------------------------------------------------------------------------


async def fetch_provider_models(
    base_url: str,
    api_key: str,
    api_type: str,
) -> list[FetchedModel]:
    """Fetch the list of models from a provider's API endpoint.

    Constructs the models URL by appending '/model' (or 'model' if the
    base_url already ends with '/') to the user-provided base_url, then
    authenticates according to the provider's api_type.
    """
    try:
        # Build models endpoint: base_url + /model (or + model if trailing /)
        if base_url.endswith("/"):
            url = f"{base_url}model"
        else:
            url = f"{base_url}/model"

        # Set authentication headers / URL params based on api_type
        headers: dict[str, str] = {}
        if api_type == "google":
            separator = "&" if "?" in url else "?"
            url = f"{url}{separator}key={urllib.parse.quote(api_key, safe='')}"
        elif api_type == "anthropic":
            headers = {
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
            }
        else:
            # openai-compatible
            headers = {"Authorization": f"Bearer {api_key}"}

        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(url, headers=headers)
            if resp.status_code >= 400:
                print(f"[fetch_provider_models] {url} returned HTTP {resp.status_code}, skipping model list")
                return []
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


# ---------------------------------------------------------------------------
# Detect supported API protocols by probing endpoints
# ---------------------------------------------------------------------------


def _build_url(base_url: str, path: str) -> str:
    """Join base_url and path, handling trailing slashes."""
    if base_url.endswith("/"):
        return f"{base_url}{path.lstrip('/')}"
    return f"{base_url}/{path.lstrip('/')}"


async def _probe_get(url: str, headers: dict[str, str], timeout: float = 15.0) -> bool:
    """GET probe — returns True if the server responded (any HTTP status)."""
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            await client.get(url, headers=headers)
        return True
    except Exception:
        return False


async def _probe_post(url: str, headers: dict[str, str], body: dict, timeout: float = 15.0) -> bool:
    """POST probe — returns True if the server responded (any HTTP status)."""
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            await client.post(url, headers=headers, json=body)
        return True
    except Exception:
        return False


async def detect_api_protocols(base_url: str, api_key: str) -> ProtocolStatus:
    """Probe the provider to detect which API protocols are supported.

    Sends GET + POST requests in parallel with 15s timeout per protocol.
    A protocol is considered "reachable" if the server returns ANY HTTP
    response (including 4xx errors) — only network-level failures count as unreachable.

    Returns a dict mapping protocol name to bool (True = reachable).
    """
    bearer = {"Authorization": f"Bearer {api_key}"}
    anthropic_headers = {
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }

    # Build probe tasks — each protocol gets both GET and POST attempts
    tasks: dict[str, asyncio.Task] = {}

    # openai_chat: GET /models + POST /chat/completions (empty body)
    tasks["openai_chat_get"] = asyncio.create_task(
        _probe_get(_build_url(base_url, "/models"), bearer)
    )
    tasks["openai_chat_post"] = asyncio.create_task(
        _probe_post(_build_url(base_url, "/chat/completions"), {**bearer, "content-type": "application/json"}, {})
    )

    # openai_response: GET /models (reuse result) + POST /responses (empty body)
    # POST /responses is the key differentiator
    tasks["openai_response_post"] = asyncio.create_task(
        _probe_post(_build_url(base_url, "/responses"), {**bearer, "content-type": "application/json"}, {})
    )

    # anthropic: POST /v1/messages (minimal body to see if endpoint exists)
    tasks["anthropic_post"] = asyncio.create_task(
        _probe_post(_build_url(base_url, "/v1/messages"), anthropic_headers, {
            "model": "claude-3-5-sonnet-20241022",
            "max_tokens": 1,
            "messages": [{"role": "user", "content": "hi"}],
        })
    )

    # google: GET /models?key=
    google_url = _build_url(base_url, "/models")
    google_url = f"{google_url}?key={urllib.parse.quote(api_key, safe='')}"
    tasks["google_get"] = asyncio.create_task(
        _probe_get(google_url, {})
    )

    # Wait for all tasks
    await asyncio.gather(*tasks.values())

    # Compile results — protocol is reachable if ANY of its probes succeeded
    result: ProtocolStatus = {
        "openai_chat": tasks["openai_chat_get"].result() or tasks["openai_chat_post"].result(),
        "openai_response": tasks["openai_response_post"].result(),
        "anthropic": tasks["anthropic_post"].result(),
        "google": tasks["google_get"].result(),
    }

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

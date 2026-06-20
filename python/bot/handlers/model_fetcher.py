"""
Utility: fetch provider model list and pricing from external APIs.

1. Fetches models from the provider's base_url + /models endpoint
2. Fetches pricing from https://models.dev/api.json
3. Detects supported API protocols by probing endpoints
"""

from __future__ import annotations

import asyncio
import logging
import time
import urllib.parse
from typing import Any

import httpx

logger = logging.getLogger(__name__)

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
        logger.warning("Failed to fetch models.dev pricing data: %s", e)
        if _models_dev_cache is not None:
            return _models_dev_cache
        return {}


# ---------------------------------------------------------------------------
# Fetch model list from provider's /models endpoint
# ---------------------------------------------------------------------------


async def fetch_provider_models(
    base_url: str,
    api_key: str,
    api_type: str,
) -> list[FetchedModel]:
    """Fetch the list of models from a provider's API endpoint.

    Constructs the models URL by appending '/models' (or 'models' if the
    base_url already ends with '/') to the user-provided base_url, then
    authenticates according to the provider's api_type.
    """
    try:
        # Build models endpoint: base_url + /models (or + models if trailing /)
        if base_url.endswith("/"):
            url = f"{base_url}models"
        else:
            url = f"{base_url}/models"

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
                logger.warning("fetch_provider_models: %s returned HTTP %s, skipping model list", url, resp.status_code)
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
        logger.warning("fetch_provider_models failed: %s", e)
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
        logger.warning("fetch_models_pricing failed: %s", e)

    return result


# ---------------------------------------------------------------------------
# Fetch model list without auth (for /model_catch)
# ---------------------------------------------------------------------------


async def fetch_models_no_auth(
    base_url: str,
) -> tuple[list[FetchedModel], bool]:
    """Try to fetch models without authentication.

    Returns (models, needs_auth):
      - models: list of fetched models (may be empty)
      - needs_auth: True if server returned 401/403 (auth required)
    """
    try:
        if base_url.endswith("/"):
            url = f"{base_url}models"
        else:
            url = f"{base_url}/models"

        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(url)

        if resp.status_code in (401, 403):
            return [], True

        if resp.status_code >= 400:
            return [], False

        json_data = resp.json()
        models: list[FetchedModel] = []

        # OpenAI-compatible format
        if "data" in json_data and isinstance(json_data["data"], list):
            for m in json_data["data"]:
                if isinstance(m, dict) and m.get("id"):
                    models.append({"id": m["id"], "name": m["id"]})

        # Google format
        elif "models" in json_data and isinstance(json_data["models"], list):
            for m in json_data["models"]:
                if isinstance(m, dict):
                    raw_name = m.get("name", "")
                    model_id = raw_name.replace("models/", "") if raw_name else m.get("id", "")
                    if model_id:
                        models.append({
                            "id": model_id,
                            "name": m.get("displayName", model_id),
                        })

        return models, False

    except Exception as e:
        logger.warning("fetch_models_no_auth failed: %s", e)
        return [], False


# ---------------------------------------------------------------------------
# Detect supported API protocols by probing endpoints (v2 — precise analysis)
# ---------------------------------------------------------------------------

# --- Types ---

ProbeDetail = dict[str, Any]  # {"supported": bool, "confidence": str, "reason": str}
# confidence: "high" | "medium" | "low"

DetectionResult = dict[str, Any]  # {"protocols": dict[str, ProbeDetail], "recommended": str | None}


# --- Helpers ---


def _build_url(base_url: str, path: str) -> str:
    """Join base_url and path, handling trailing slashes."""
    if base_url.endswith("/"):
        return f"{base_url}{path.lstrip('/')}"
    return f"{base_url}/{path.lstrip('/')}"


async def _detailed_probe(
    method: str,
    url: str,
    headers: dict[str, str],
    body: dict | None = None,
    timeout: float = 15.0,
) -> tuple[int | None, str | None]:
    """Send a probe request. Returns (status_code, body_snippet) or (None, None) on error."""
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            if method == "GET":
                resp = await client.get(url, headers=headers)
            else:
                resp = await client.post(url, headers=headers, json=body or {})
            body_text = resp.text[:500] if resp.text else None
            return resp.status_code, body_text
    except Exception:
        return None, None


def _analyze_status(status_code: int | None, body: str | None) -> ProbeDetail:
    """Analyze a probe's HTTP status code to determine protocol support.

    Returns a ProbeDetail with:
      - supported: whether the protocol is supported
      - confidence: "high" / "medium" / "low"
      - reason: human-readable explanation
    """
    # Connection failed completely (DNS, timeout, TCP reset, etc.)
    if status_code is None:
        return {"supported": False, "confidence": "high", "reason": "連線失敗（無法連接到伺服器）"}

    # 404 = endpoint doesn't exist
    if status_code == 404:
        return {"supported": False, "confidence": "high", "reason": "端點不存在（404 Not Found）"}

    # 200-level = endpoint works normally
    if 200 <= status_code < 300:
        return {"supported": True, "confidence": "high", "reason": "端點正常回應"}

    # 400/422 = endpoint exists, request format was bad (valid indicator)
    if status_code in (400, 422):
        return {"supported": True, "confidence": "high", "reason": "端點存在（請求格式有誤）"}

    # 401/403 = endpoint exists but auth is required
    if status_code in (401, 403):
        return {"supported": True, "confidence": "medium", "reason": "端點存在但需要認證"}

    # 405 = endpoint might exist but doesn't accept this method
    if status_code == 405:
        return {"supported": True, "confidence": "low", "reason": "端點可能存在（方法不允許）"}

    # 5xx = server error, endpoint likely exists
    if status_code >= 500:
        return {"supported": True, "confidence": "low", "reason": "伺服器錯誤（端點可能存在）"}

    # Other / unknown status codes
    return {"supported": False, "confidence": "low", "reason": f"未預期的狀態碼 ({status_code})"}


def _pick_better(a: ProbeDetail, b: ProbeDetail) -> ProbeDetail:
    """Pick the better of two ProbeDetails (higher confidence + supported wins)."""
    if a["supported"] and not b["supported"]:
        return a
    if b["supported"] and not a["supported"]:
        return b
    if not a["supported"] and not b["supported"]:
        return a  # both unsupported, doesn't matter
    # Both supported — compare confidence
    conf_rank = {"high": 3, "medium": 2, "low": 1}
    return a if conf_rank.get(a["confidence"], 0) >= conf_rank.get(b["confidence"], 0) else b


def _recommend_type(protocols: dict[str, ProbeDetail]) -> str | None:
    """Auto-recommend an api_type based on detection results."""
    # Priority 1: exactly one high-confidence supported protocol
    high = [k for k, v in protocols.items() if v["supported"] and v["confidence"] == "high"]
    if len(high) == 1:
        return high[0]
    if len(high) > 1:
        # Multiple high confidence — prefer openai_chat (most common)
        if "openai_chat" in high:
            return "openai_chat"
        return high[0]

    # Priority 2: exactly one medium+ confidence
    medium = [k for k, v in protocols.items() if v["supported"] and v["confidence"] in ("high", "medium")]
    if len(medium) == 1:
        return medium[0]
    if len(medium) > 1:
        if "openai_chat" in medium:
            return "openai_chat"
        return medium[0]

    return None


# --- Main detection functions ---


async def detect_api_protocols(base_url: str, api_key: str) -> DetectionResult:
    """Probe the provider to detect which API protocols are supported.

    v2: Uses precise HTTP status code analysis instead of binary reachable/unreachable.
    Returns a DetectionResult with per-protocol ProbeDetail and an auto-recommended api_type.
    """
    bearer = {"Authorization": f"Bearer {api_key}"}
    bearer_json = {**bearer, "content-type": "application/json"}
    anthropic_headers = {
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }

    # Run all probes in parallel
    # For anthropic, try BOTH /v1/messages AND /messages (handle /v1 prefix in base_url)
    results = await asyncio.gather(
        # openai_chat: GET /models
        _detailed_probe("GET", _build_url(base_url, "/models"), bearer),
        # openai_chat: POST /chat/completions
        _detailed_probe("POST", _build_url(base_url, "/chat/completions"), bearer_json, {}),
        # openai_response: POST /responses
        _detailed_probe("POST", _build_url(base_url, "/responses"), bearer_json, {}),
        # anthropic: POST /v1/messages (standard — base_url doesn't include /v1)
        _detailed_probe("POST", _build_url(base_url, "/v1/messages"), anthropic_headers, {
            "model": "claude-3-5-sonnet-20241022",
            "max_tokens": 1,
            "messages": [{"role": "user", "content": "hi"}],
        }),
        # anthropic: POST /messages (base_url already includes /v1)
        _detailed_probe("POST", _build_url(base_url, "/messages"), anthropic_headers, {
            "model": "claude-3-5-sonnet-20241022",
            "max_tokens": 1,
            "messages": [{"role": "user", "content": "hi"}],
        }),
        # google: GET /models?key=
        _detailed_probe("GET", f"{_build_url(base_url, '/models')}?key={urllib.parse.quote(api_key, safe='')}", {}),
    )

    models_get, chat_post, response_post, anthropic_v1, anthropic_no_v1, google_get = results

    # openai_chat: combine GET /models and POST /chat/completions (pick best)
    openai_chat = _pick_better(_analyze_status(*models_get), _analyze_status(*chat_post))

    # openai_response: POST /responses
    openai_response = _analyze_status(*response_post)

    # anthropic: pick the better of /v1/messages and /messages
    anthropic = _pick_better(_analyze_status(*anthropic_v1), _analyze_status(*anthropic_no_v1))

    # google: GET /models?key=
    google = _analyze_status(*google_get)

    protocols = {
        "openai_chat": openai_chat,
        "openai_response": openai_response,
        "anthropic": anthropic,
        "google": google,
    }

    recommended = _recommend_type(protocols)

    return {"protocols": protocols, "recommended": recommended}


async def detect_protocols_no_auth(
    base_url: str,
) -> tuple[DetectionResult, bool]:
    """Probe API protocols without authentication.

    Returns (result, all_unreachable):
      - result: DetectionResult with protocol details and recommendation
      - all_unreachable: True if ALL protocols failed to get ANY HTTP response
    """
    result = await detect_api_protocols(base_url, "")
    all_unreachable = all(
        not d["supported"] and d["confidence"] == "high"
        for d in result["protocols"].values()
    )
    return result, all_unreachable

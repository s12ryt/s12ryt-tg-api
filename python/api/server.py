"""
FastAPI application – API proxy / aggregation server.

Accepts OpenAI-compatible requests and routes them to the correct provider.
"""

from __future__ import annotations

import logging
import time
from typing import Any, AsyncIterator

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

from .middleware import AuthMiddleware
from .rate_limiter import RateLimitMiddleware, record_token_usage
from .quota_checker import QuotaCheckMiddleware
from . import providers as prov
from .thinking_parser import preprocess_thinking, parse_model_thinking_suffix
from .usage_tracker import (
    extract_usage,
    extract_usage_with_fallback,
    calculate_cost,
    record_usage,
    estimate_tokens,
    extract_input_text_from_body,
)
from config import Config
from .responses import (
    convert_responses_input_to_messages,
    convert_chat_completion_to_responses,
    stream_responses_api,
    convert_responses_tools_to_chat_tools,
)
from .anthropic_out import (
    convert_anthropic_input_to_messages,
    convert_chat_completion_to_anthropic,
    stream_anthropic_api,
)

logger = logging.getLogger(__name__)

app = FastAPI(title="s12ryt API Proxy", version="1.0.0")

# ---------------------------------------------------------------------------
# Middleware
# ---------------------------------------------------------------------------

# Starlette add_middleware inserts at position 0 (last added = outermost = runs first).
# Request flow: Auth → RateLimit → QuotaCheck → CORS → endpoint
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(QuotaCheckMiddleware)
app.add_middleware(RateLimitMiddleware)
app.add_middleware(AuthMiddleware)

# ---------------------------------------------------------------------------
# Provider registry
# ---------------------------------------------------------------------------

# model_name -> (provider_type, provider_id)
# **Replace** with database-driven lookups in production.
MODEL_REGISTRY: dict[str, tuple[str, str]] = {
    # OpenAI
    "gpt-4o": ("openai_chat", "openai-main"),
    "gpt-4o-mini": ("openai_chat", "openai-main"),
    "gpt-4-turbo": ("openai_chat", "openai-main"),
    "gpt-3.5-turbo": ("openai_chat", "openai-main"),
    # Anthropic
    "claude-3.5-sonnet": ("anthropic", "anthropic-main"),
    "claude-3.5-haiku": ("anthropic", "anthropic-main"),
    "claude-4-opus": ("anthropic", "anthropic-main"),
    "claude-4-sonnet": ("anthropic", "anthropic-main"),
    # Google
    "gemini-2.5-pro": ("google", "google-main"),
    "gemini-2.5-flash": ("google", "google-main"),
    "gemini-2.0-flash": ("google", "google-main"),
}

# provider_id -> provider_config (api_key, base_url, etc.)
# **Replace** with database-driven lookups in production.
PROVIDER_CONFIGS: dict[str, dict[str, Any]] = {
    "openai-main": {
        "base_url": "https://api.openai.com/v1",
        "api_key": "sk-PLACEHOLDER",
    },
    "anthropic-main": {
        "base_url": "https://api.anthropic.com",
        "api_key": "sk-ant-PLACEHOLDER",
    },
    "google-main": {
        "base_url": "https://generativelanguage.googleapis.com",
        "api_key": "AIza-PLACEHOLDER",
    },
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

PROVIDER_MODULES = {
    "openai_chat": prov.openai,
    "openai_response": prov.openai_response,
    "anthropic": prov.anthropic,
    "google": prov.google,
}


# ---------------------------------------------------------------------------
# Model restriction helpers
# ---------------------------------------------------------------------------

async def _is_model_allowed_for_request(request: Request, model_name: str) -> bool:
    """Check if the requested model is allowed based on auth & restrictions.

    Returns True for:
    - No auth (public endpoints)
    - coding-mode (virtual model)
    - Model passes restriction check
    """
    user_id = getattr(request.state, "user_id", None)
    api_key_id = getattr(request.state, "api_key_id", None)

    # No auth or coding-mode → always allowed
    if not user_id or not api_key_id:
        return True
    if model_name == "coding-mode":
        return True

    # Determine admin status from cached tg_user_id (no DB query needed)
    from db.database import check_model_allowed
    tg_user_id = getattr(request.state, "tg_user_id", None)
    is_admin = tg_user_id is not None and tg_user_id == Config.ADMIN_ID

    return await check_model_allowed(user_id, api_key_id, model_name, is_admin)


# ---------------------------------------------------------------------------
# Streaming usage extraction helpers
# ---------------------------------------------------------------------------

def _extract_usage_from_sse_text(raw: str) -> tuple[int, int, str]:
    """Parse SSE text and return (input_tokens, output_tokens, output_text).

    Accumulates output text from streaming deltas for fallback estimation.
    """
    import json as _json
    input_tokens = 0
    output_tokens = 0
    output_text_parts: list[str] = []
    for line in raw.split("\n"):
        trimmed = line.strip()
        if not trimmed.startswith("data: "):
            continue
        payload = trimmed[6:].strip()
        if not payload or payload == "[DONE]":
            continue
        try:
            parsed = _json.loads(payload)
            # Extract usage data
            if "usage" in parsed:
                u = parsed["usage"]
                if u.get("prompt_tokens"):
                    input_tokens = u["prompt_tokens"]
                if u.get("completion_tokens"):
                    output_tokens = u["completion_tokens"]
                if not input_tokens and u.get("input_tokens"):
                    input_tokens = u["input_tokens"]
                if not output_tokens and u.get("output_tokens"):
                    output_tokens = u["output_tokens"]
            # Accumulate output text from OpenAI-format deltas
            choices = parsed.get("choices")
            if isinstance(choices, list):
                for choice in choices:
                    if not isinstance(choice, dict):
                        continue
                    delta = choice.get("delta", {})
                    if isinstance(delta, dict):
                        for field in ("content", "reasoning_content", "reasoning"):
                            text = delta.get(field)
                            if isinstance(text, str) and text:
                                output_text_parts.append(text)
            # Accumulate output text from Anthropic-format deltas
            if parsed.get("type") == "content_block_delta":
                delta = parsed.get("delta", {})
                if isinstance(delta, dict):
                    for field in ("text", "thinking"):
                        text = delta.get(field)
                        if isinstance(text, str) and text:
                            output_text_parts.append(text)
        except Exception:
            pass
    return input_tokens, output_tokens, "".join(output_text_parts)


async def _stream_with_usage_raw(
    provider_stream: AsyncIterator[bytes],
    request: Request,
    provider_type: str,
    provider_id: str,
    model_name: str,
    input_price: float | None = None,
    output_price: float | None = None,
    is_coding_mode: bool = False,
    input_text: str = "",
) -> AsyncIterator[bytes]:
    """Forward raw provider stream while extracting usage. Records usage when done."""
    total_in = 0
    total_out = 0
    output_text = ""
    async for chunk in provider_stream:
        yield chunk
        raw = chunk.decode("utf-8") if isinstance(chunk, bytes) else str(chunk)
        i, o, txt = _extract_usage_from_sse_text(raw)
        if i: total_in = i
        if o: total_out = o
        if txt: output_text += txt

    # Fallback estimation when provider didn't return usage
    if not total_out and output_text:
        total_out = estimate_tokens(output_text)
    if not total_in and input_text:
        total_in = estimate_tokens(input_text)

    # Record usage
    if total_in > 0 or total_out > 0:
        try:
            cost = calculate_cost(input_price, output_price, total_in, total_out)
            user_id = getattr(request.state, "user_id", None)
            api_key_id = getattr(request.state, "api_key_id", None)
            if user_id and api_key_id:
                await record_usage(
                    api_key_id=api_key_id,
                    provider_id=provider_id,
                    input_tokens=total_in,
                    output_tokens=total_out,
                    input_cost=cost["input_cost"],
                    output_cost=cost["output_cost"],
                    model=model_name,
                )
                record_token_usage(int(user_id), int(api_key_id), total_in + total_out)
                # Increment coding session stats
                if is_coding_mode and user_id:
                    try:
                        from db.database import increment_coding_session_stats
                        await increment_coding_session_stats(
                            user_id, total_in, total_out,
                            cost["input_cost"], cost["output_cost"],
                            model_name,
                        )
                    except Exception:
                        logger.exception("Failed to increment coding session stats")
        except Exception:
            logger.exception("Failed to record streaming usage")


async def _stream_with_usage_transform(
    provider_stream: AsyncIterator[bytes],
    transform_fn,
    request: Request,
    provider_type: str,
    provider_id: str,
    model_name: str,
    input_price: float | None = None,
    output_price: float | None = None,
    is_coding_mode: bool = False,
    input_text: str = "",
) -> AsyncIterator[bytes]:
    """Forward provider stream through a transform while extracting usage from raw chunks.

    transform_fn should be an async generator factory: (source) -> AsyncIterator[bytes]
    Raw chunks are intercepted before the transform to extract OpenAI-format usage.
    """
    total_in = 0
    total_out = 0
    output_text = ""

    # Intercept raw chunks via a peekable wrapper
    async def _peek_source():
        nonlocal total_in, total_out, output_text
        async for chunk in provider_stream:
            raw = chunk.decode("utf-8") if isinstance(chunk, bytes) else str(chunk)
            i, o, txt = _extract_usage_from_sse_text(raw)
            if i: total_in = i
            if o: total_out = o
            if txt: output_text += txt
            yield chunk

    transformed = transform_fn(_peek_source())
    async for t_chunk in transformed:
        yield t_chunk

    # Fallback estimation when provider didn't return usage
    if not total_out and output_text:
        total_out = estimate_tokens(output_text)
    if not total_in and input_text:
        total_in = estimate_tokens(input_text)

    # Record usage after all chunks are yielded
    if total_in > 0 or total_out > 0:
        try:
            cost = calculate_cost(input_price, output_price, total_in, total_out)
            user_id = getattr(request.state, "user_id", None)
            api_key_id = getattr(request.state, "api_key_id", None)
            if user_id and api_key_id:
                await record_usage(
                    api_key_id=api_key_id,
                    provider_id=provider_id,
                    input_tokens=total_in,
                    output_tokens=total_out,
                    input_cost=cost["input_cost"],
                    output_cost=cost["output_cost"],
                    model=model_name,
                )
                record_token_usage(int(user_id), int(api_key_id), total_in + total_out)
                # Increment coding session stats
                if is_coding_mode and user_id:
                    try:
                        from db.database import increment_coding_session_stats
                        await increment_coding_session_stats(
                            user_id, total_in, total_out,
                            cost["input_cost"], cost["output_cost"],
                            model_name,
                        )
                    except Exception:
                        logger.exception("Failed to increment coding session stats")
        except Exception:
            logger.exception("Failed to record streaming usage")


def _resolve_model(model_name: str) -> tuple[str, str, dict[str, Any]]:
    """Return (provider_type, provider_id, provider_config) for a model."""
    if model_name not in MODEL_REGISTRY:
        raise ValueError(f"Unknown model: {model_name}")

    provider_type, provider_id = MODEL_REGISTRY[model_name]

    if provider_id not in PROVIDER_CONFIGS:
        raise ValueError(f"Provider not configured: {provider_id}")

    return provider_type, provider_id, PROVIDER_CONFIGS[provider_id]


async def _lookup_model_db(model_name: str) -> tuple[str, str, dict[str, Any], float | None, float | None] | None:
    """Look up model routing from cache → DB.

    Returns (provider_type, provider_id, config, input_price, output_price) or None.
    Prices are per-model from model_prices table, falling back to provider-level.
    Config includes a single selected api_key (from multi-key failover selector).
    """
    from db.database import get_provider_cache, CachedProvider, get_model_price, get_providers
    from api.key_selector import select_key

    # 1. Try in-memory cache first
    cache = get_provider_cache()
    cached: CachedProvider | None = cache.get(model_name)
    if cached:
        # Try model-specific pricing from DB (only if not in cache)
        model_price = await get_model_price(cached.provider_id, model_name)
        input_price = model_price.get("input_price") if model_price else cached.input_price
        output_price = model_price.get("output_price") if model_price else cached.output_price

        # Select a single key from multi-key JSON array
        selected_key, key_index = select_key(
            cached.provider_id, cached.api_key, getattr(cached, "key_strategy", "failover")
        )

        return (
            cached.provider_type,
            str(cached.provider_id),
            {"base_url": cached.base_url, "api_key": selected_key or "", "_key_index": key_index},
            input_price,
            output_price,
        )

    # 2. Fallback: full DB scan (and rebuild cache)
    providers = await get_providers(enabled_only=True)
    for p in providers:
        models = [m.strip() for m in (p.get("models") or "").split(",") if m.strip()]
        if model_name in models:
            model_price = await get_model_price(p["id"], model_name)
            if model_price:
                input_price = model_price.get("input_price")
                output_price = model_price.get("output_price")
            else:
                input_price = p.get("input_price")
                output_price = p.get("output_price")

            # Select a single key from multi-key JSON array
            selected_key, key_index = select_key(p["id"], p["api_key"], p.get("key_strategy", "failover"))

            return (
                p["api_type"],
                str(p["id"]),
                {"base_url": p["base_url"], "api_key": selected_key or "", "_key_index": key_index},
                input_price,
                output_price,
            )
    return None


async def _resolve_model_full(model_name: str) -> tuple[str, str, dict[str, Any], float | None, float | None]:
    """Resolve model with fallback from DB → static registry.

    Returns (provider_type, provider_id, config, input_price, output_price).
    Raises ValueError if model not found.
    """
    resolved = await _lookup_model_db(model_name)
    if resolved:
        return resolved
    provider_type, provider_id, provider_config = _resolve_model(model_name)
    return provider_type, provider_id, provider_config, None, None


async def _try_model_request(
    model_name: str,
    body: dict[str, Any],
    provider_module: Any,
    provider_config: dict[str, Any],
) -> Any:
    """Try a single model request. Returns result or raises the exception."""
    # Build a body with the requested model
    req_body = {**body, "model": model_name}
    return await provider_module.chat_completion(req_body, provider_config)


async def _dispatch_with_fallback(
    model_name: str,
    body: dict[str, Any],
    request: Request,
    endpoint_type: str = "chat",
) -> tuple[Any, str, str, str, dict[str, Any], float | None, float | None]:
    """Dispatch a request. If model is 'coding-mode', uses the user's fallback chain.

    - model_name == 'coding-mode': resolve first fallback model, try each on error
    - model_name != 'coding-mode': direct call, no fallback

    Returns:
        (result, actual_model, provider_type, provider_id, provider_config, input_price, output_price)
    """
    is_coding_mode = (model_name == "coding-mode")

    if is_coding_mode:
        # Resolve the user's fallback chain
        api_key_id = getattr(request.state, "api_key_id", None)
        if not api_key_id:
            raise ValueError("coding-mode requires an API key")

        from db.database import get_active_coding_for_api_key
        coding_config = await get_active_coding_for_api_key(api_key_id)
        if not coding_config or not coding_config.get("fallback_list"):
            raise ValueError(
                "coding-mode 未設定：請先使用 /set_coding 設定 Fallback 模型鏈"
            )

        fallback_models = coding_config["fallback_list"]
        max_retries = coding_config.get("max_retries", 3)
        last_error: Exception | None = None

        for fb_model in fallback_models:
            try:
                # Parse thinking suffix from fallback model name (e.g. "o3(high)")
                fb_parsed = parse_model_thinking_suffix(fb_model)
                fb_real_model = fb_parsed["model"]
                fb_level = fb_parsed.get("thinking_level")
                # BUG-1 fix: enforce model access restrictions on fallback models
                # (prevents bypassing whitelist/blacklist via coding-mode chain)
                if not await _is_model_allowed_for_request(request, fb_real_model):
                    logger.info("Coding mode: model %s not allowed, skipping", fb_real_model)
                    continue
                fb_type, fb_id, fb_config, fb_in_price, fb_out_price = await _resolve_model_full(fb_real_model)
                fb_module = PROVIDER_MODULES.get(fb_type)
                if fb_module is None:
                    continue

                fb_body = {**body, "model": fb_real_model}
                if fb_level:
                    fb_body["thinking_effort"] = fb_level
                logger.info("Coding mode: trying model %s", fb_real_model)
                fb_key_index = fb_config.get("_key_index")
                try:
                    result = await fb_module.chat_completion(fb_body, fb_config)
                    # BUG-2 fix: track key health for circuit breaker
                    if fb_key_index is not None:
                        from api.key_selector import report_success
                        report_success(int(fb_id), fb_key_index)
                    return result, fb_real_model, fb_type, fb_id, fb_config, fb_in_price, fb_out_price
                except Exception as chat_exc:
                    # BUG-2 fix: track key health for circuit breaker
                    if fb_key_index is not None:
                        from api.key_selector import report_failure
                        report_failure(int(fb_id), fb_key_index)
                    raise
            except Exception as fb_exc:
                logger.warning("Coding mode model %s failed: %s", fb_model, fb_exc)
                last_error = fb_exc

        raise last_error or ValueError("coding-mode: all fallback models failed")

    else:
        # Normal request — direct call, no fallback
        provider_type, provider_id, provider_config, input_price, output_price = await _resolve_model_full(model_name)
        provider_module = PROVIDER_MODULES.get(provider_type)
        if provider_module is None:
            raise ValueError(f"Unknown provider type: {provider_type}")

        key_index = provider_config.get("_key_index")
        try:
            result = await provider_module.chat_completion(body, provider_config)
            # Report success to key selector
            if key_index is not None:
                from api.key_selector import report_success
                report_success(int(provider_id), key_index)
            return result, model_name, provider_type, provider_id, provider_config, input_price, output_price
        except Exception:
            # Report failure to key selector
            if key_index is not None:
                from api.key_selector import report_failure
                report_failure(int(provider_id), key_index)
            raise


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/v1/models")
async def list_models(request: Request):
    """List all available models aggregated from enabled providers (cached).
    Always includes 'coding-mode' virtual model. Filters by model restrictions if auth present."""
    from db.database import get_provider_cache, get_user_by_id, get_allowed_models

    cache = get_provider_cache()
    all_model_names = list(cache.keys())

    # Check auth for model restriction filtering
    user_id = getattr(request.state, "user_id", None)
    api_key_id = getattr(request.state, "api_key_id", None)

    if user_id and api_key_id:
        # Determine admin status from cached tg_user_id (no DB query needed)
        tg_user_id = getattr(request.state, "tg_user_id", None)
        is_admin = tg_user_id is not None and tg_user_id == Config.ADMIN_ID
        allowed = await get_allowed_models(user_id, api_key_id, all_model_names, is_admin)
        allowed_set = set(allowed)
    else:
        allowed_set = set()  # No auth → return empty (defense-in-depth, matches Node.js)

    models: list[dict[str, Any]] = []

    # Always include the coding-mode virtual model
    models.append({
        "id": "coding-mode",
        "object": "model",
        "created": int(time.time()),
        "owned_by": "system",
    })

    for model_name, cached in cache.items():
        if model_name in allowed_set:
            models.append({
                "id": model_name,
                "object": "model",
                "created": int(time.time()),
                "owned_by": cached.provider_type,
            })

    return {"object": "list", "data": models}


@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    """Main endpoint – authenticate, route, proxy, track usage."""
    from datetime import datetime
    now = datetime.now()
    logger.info(f"[{now.strftime('%H:%M:%S')}] POST /v1/chat/completions")

    # 1. Parse request body
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(
            status_code=400,
            content={"error": {"message": "Invalid JSON body", "type": "invalid_request_error"}},
        )

    # Parse thinking level from model suffix or request params (e.g. "o3(high)")
    try:
        preprocess_thinking(body)
    except ValueError as e:
        return JSONResponse(
            status_code=400,
            content={"error": {"message": str(e), "type": "invalid_request_error"}},
        )

    model_name = body.get("model", "")
    if not model_name:
        return JSONResponse(
            status_code=400,
            content={"error": {"message": "model is required", "type": "invalid_request_error"}},
        )

    # Model restriction check
    if not await _is_model_allowed_for_request(request, model_name):
        return JSONResponse(
            status_code=403,
            content={"error": {"message": f"Model '{model_name}' is not allowed for this API key", "type": "permission_error"}},
        )

    original_model = model_name  # remember for coding-mode detection

    # 2. Resolve model -> provider with fallback support
    input_price: float | None = None
    output_price: float | None = None
    try:
        result, model_name, provider_type, provider_id, provider_config, input_price, output_price = \
            await _dispatch_with_fallback(model_name, body, request)
    except ValueError as exc:
        return JSONResponse(
            status_code=400,
            content={"error": {"message": str(exc), "type": "invalid_request_error"}},
        )
    except Exception as exc:
        logger.exception("All providers failed for model %s", model_name)
        return JSONResponse(
            status_code=502,
            content={"error": {"message": str(exc), "type": "upstream_error"}},
        )

    # 3. Handle streaming vs non-streaming
    is_coding = original_model == "coding-mode"
    is_stream = body.get("stream", False)
    if is_stream and isinstance(result, AsyncIterator):
        wrapped = _stream_with_usage_raw(
            result,
            request=request,
            provider_type=provider_type,
            provider_id=provider_id,
            model_name=model_name,
            input_price=input_price,
            output_price=output_price,
            is_coding_mode=is_coding,
            input_text=extract_input_text_from_body(body),
        )
        return StreamingResponse(
            wrapped,
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    # 5. Non-streaming: extract usage and record
    if isinstance(result, dict):
        try:
            usage = extract_usage_with_fallback(provider_type, result, body)
            cost = calculate_cost(input_price, output_price, usage["input_tokens"], usage["output_tokens"])

            user_id = getattr(request.state, "user_id", None)
            api_key_id = getattr(request.state, "api_key_id", None)

            if user_id and api_key_id:
                await record_usage(
                    api_key_id=api_key_id,
                    provider_id=provider_id,
                    input_tokens=usage["input_tokens"],
                    output_tokens=usage["output_tokens"],
                    input_cost=cost["input_cost"],
                    output_cost=cost["output_cost"],
                    model=model_name,
                )
                record_token_usage(int(user_id), int(api_key_id), usage["input_tokens"] + usage["output_tokens"])
                # Increment coding session stats
                if is_coding and user_id:
                    try:
                        from db.database import increment_coding_session_stats
                        await increment_coding_session_stats(
                            user_id, usage["input_tokens"], usage["output_tokens"],
                            cost["input_cost"], cost["output_cost"],
                            model_name,
                        )
                    except Exception:
                        logger.exception("Failed to increment coding session stats")
        except Exception:
            logger.exception("Failed to record usage")

        return JSONResponse(content=result)

    # Fallback
    return result


@app.post("/v1/responses")
async def responses_endpoint(request: Request):
    """OpenAI Responses API endpoint – convert input, route to provider, convert output."""
    from datetime import datetime
    now = datetime.now()
    logger.info(f"[{now.strftime('%H:%M:%S')}] POST /v1/responses")

    # 1. Parse request body
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(
            status_code=400,
            content={"error": {"message": "Invalid JSON body", "type": "invalid_request_error"}},
        )

    # Parse thinking level from model suffix or request params (e.g. "o3(high)")
    try:
        preprocess_thinking(body)
    except ValueError as e:
        return JSONResponse(
            status_code=400,
            content={"error": {"message": str(e), "type": "invalid_request_error"}},
        )

    model_name = body.get("model", "")
    if not model_name:
        return JSONResponse(
            status_code=400,
            content={"error": {"message": "model is required", "type": "invalid_request_error"}},
        )

    # Model restriction check
    if not await _is_model_allowed_for_request(request, model_name):
        return JSONResponse(
            status_code=403,
            content={"error": {"message": f"Model '{model_name}' is not allowed for this API key", "type": "permission_error"}},
        )

    original_model = model_name  # remember for coding-mode detection

    input_data = body.get("input")
    if input_data is None:
        return JSONResponse(
            status_code=400,
            content={"error": {"message": "input is required", "type": "invalid_request_error"}},
        )

    # 2a. Optimization: for openai_response providers, pass through directly (no conversion)
    is_coding = original_model == "coding-mode"
    is_stream = body.get("stream", False)

    if not is_coding:
        try:
            _pt, _pid, _pcfg, _ip, _op = await _resolve_model_full(model_name)
        except ValueError as exc:
            return JSONResponse(
                status_code=400,
                content={"error": {"message": str(exc), "type": "invalid_request_error"}},
            )
        except Exception as exc:
            logger.exception("Provider lookup failed for model %s", model_name)
            return JSONResponse(
                status_code=502,
                content={"error": {"message": str(exc), "type": "upstream_error"}},
            )

        if _pt == "openai_response":
            try:
                result = await prov.openai_response.responses_api(body, _pcfg)
            except Exception as exc:
                logger.exception("Provider request failed for model %s", model_name)
                return JSONResponse(
                    status_code=502,
                    content={"error": {"message": str(exc), "type": "upstream_error"}},
                )

            if is_stream and isinstance(result, AsyncIterator):
                wrapped = _stream_with_usage_raw(
                    result,
                    request=request,
                    provider_type=_pt,
                    provider_id=_pid,
                    model_name=model_name,
                    input_price=_ip,
                    output_price=_op,
                    is_coding_mode=False,
                    input_text=extract_input_text_from_body(body),
                )
                return StreamingResponse(
                    wrapped,
                    media_type="text/event-stream",
                    headers={
                        "Cache-Control": "no-cache",
                        "Connection": "keep-alive",
                        "X-Accel-Buffering": "no",
                    },
                )

            if isinstance(result, dict):
                _usage = extract_usage_with_fallback("openai_response", result, body)
                _in_t = _usage["input_tokens"]
                _out_t = _usage["output_tokens"]
                try:
                    if _in_t > 0 or _out_t > 0:
                        cost = calculate_cost(_ip, _op, _in_t, _out_t)
                        user_id = getattr(request.state, "user_id", None)
                        api_key_id = getattr(request.state, "api_key_id", None)
                        if user_id and api_key_id:
                            await record_usage(
                                api_key_id=api_key_id,
                                provider_id=_pid,
                                input_tokens=_in_t,
                                output_tokens=_out_t,
                                input_cost=cost["input_cost"],
                                output_cost=cost["output_cost"],
                                model=model_name,
                            )
                            record_token_usage(int(user_id), int(api_key_id), _in_t + _out_t)
                except Exception:
                    logger.exception("Failed to record usage")

                return JSONResponse(content=result)

    # 2b. Standard flow: convert Responses → Chat → dispatch → convert back
    instructions = body.get("instructions")
    messages = convert_responses_input_to_messages(input_data, instructions)

    # 3. Build Chat Completions request
    chat_body: dict[str, Any] = {
        "model": model_name,
        "messages": messages,
        "stream": body.get("stream", False),
    }

    if "temperature" in body:
        chat_body["temperature"] = body["temperature"]
    if "top_p" in body:
        chat_body["top_p"] = body["top_p"]
    if "max_output_tokens" in body:
        chat_body["max_tokens"] = body["max_output_tokens"]
    if "presence_penalty" in body:
        chat_body["presence_penalty"] = body["presence_penalty"]
    if "frequency_penalty" in body:
        chat_body["frequency_penalty"] = body["frequency_penalty"]
    if "stop" in body:
        chat_body["stop"] = body["stop"]

    # Convert Responses API tools → Chat Completions tools format
    if body.get("tools"):
        chat_body["tools"] = convert_responses_tools_to_chat_tools(body["tools"])
    if "tool_choice" in body:
        chat_body["tool_choice"] = body["tool_choice"]

    # Preserve thinking_effort for provider injection (set by preprocess_thinking)
    if body.get("thinking_effort") is not None:
        chat_body["thinking_effort"] = body["thinking_effort"]

    is_stream = chat_body.get("stream", False)

    # 4. Resolve model -> provider with fallback support
    input_price: float | None = None
    output_price: float | None = None
    try:
        result, model_name, provider_type, provider_id, provider_config, input_price, output_price = \
            await _dispatch_with_fallback(model_name, chat_body, request)
    except ValueError as exc:
        return JSONResponse(
            status_code=400,
            content={"error": {"message": str(exc), "type": "invalid_request_error"}},
        )
    except Exception as exc:
        logger.exception("All providers failed for model %s", model_name)
        return JSONResponse(
            status_code=502,
            content={"error": {"message": str(exc), "type": "upstream_error"}},
        )

    # 6. Handle streaming: convert Chat Completions SSE → Responses API SSE
    is_coding = original_model == "coding-mode"
    if is_stream and isinstance(result, AsyncIterator):
        wrapped = _stream_with_usage_transform(
            result,
            transform_fn=lambda src: stream_responses_api(
                src, model_name,
                instructions=instructions,
                previous_response_id=body.get("previous_response_id"),
                temperature=body.get("temperature"),
                top_p=body.get("top_p"),
            ),
            request=request,
            provider_type=provider_type,
            provider_id=provider_id,
            model_name=model_name,
            input_price=input_price,
            output_price=output_price,
            is_coding_mode=is_coding,
            input_text=extract_input_text_from_body(body),
        )
        return StreamingResponse(
            wrapped,
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    # 7. Non-streaming: convert Chat Completions → Responses format
    if isinstance(result, dict):
        responses_result = convert_chat_completion_to_responses(
            result,
            model_name,
            instructions=instructions,
            previous_response_id=body.get("previous_response_id"),
            temperature=body.get("temperature"),
            top_p=body.get("top_p"),
        )

        # Extract usage and record
        try:
            usage = extract_usage_with_fallback(provider_type, result, body)
            cost = calculate_cost(input_price, output_price, usage["input_tokens"], usage["output_tokens"])

            user_id = getattr(request.state, "user_id", None)
            api_key_id = getattr(request.state, "api_key_id", None)

            if user_id and api_key_id:
                await record_usage(
                    api_key_id=api_key_id,
                    provider_id=provider_id,
                    input_tokens=usage["input_tokens"],
                    output_tokens=usage["output_tokens"],
                    input_cost=cost["input_cost"],
                    output_cost=cost["output_cost"],
                    model=model_name,
                )
                record_token_usage(int(user_id), int(api_key_id), usage["input_tokens"] + usage["output_tokens"])
                # Increment coding session stats
                if is_coding and user_id:
                    try:
                        from db.database import increment_coding_session_stats
                        await increment_coding_session_stats(
                            user_id, usage["input_tokens"], usage["output_tokens"],
                            cost["input_cost"], cost["output_cost"],
                            model_name,
                        )
                    except Exception:
                        logger.exception("Failed to increment coding session stats")
        except Exception:
            logger.exception("Failed to record usage")

        return JSONResponse(content=responses_result)

    # Fallback
    return result


# ---------------------------------------------------------------------------
# POST /v1/messages – Anthropic Messages API
# ---------------------------------------------------------------------------


@app.post("/v1/messages")
async def anthropic_messages_endpoint(request: Request):
    """Anthropic Messages API endpoint – convert input, route to provider, convert output."""

    from datetime import datetime
    now = datetime.now()
    logger.info(f"[{now.strftime('%H:%M:%S')}] POST /v1/messages")

    # 1. Parse request body
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(
            status_code=400,
            content={"type": "error", "error": {"type": "invalid_request_error", "message": "Invalid JSON body"}},
        )

    # Parse thinking level from model suffix or request params (e.g. "o3(high)")
    try:
        preprocess_thinking(body)
    except ValueError as e:
        return JSONResponse(
            status_code=400,
            content={"type": "error", "error": {"type": "invalid_request_error", "message": str(e)}},
        )

    # 2. Validate required fields
    model_name: str = body.get("model", "")
    if not model_name:
        return JSONResponse(
            status_code=400,
            content={"type": "error", "error": {"type": "invalid_request_error", "message": "model is required"}},
        )

    # Model restriction check
    if not await _is_model_allowed_for_request(request, model_name):
        return JSONResponse(
            status_code=403,
            content={"type": "error", "error": {"type": "permission_error", "message": f"Model '{model_name}' is not allowed for this API key"}},
        )

    original_model = model_name  # remember for coding-mode detection

    messages = body.get("messages")
    if not messages or not isinstance(messages, list) or len(messages) == 0:
        return JSONResponse(
            status_code=400,
            content={"type": "error", "error": {"type": "invalid_request_error", "message": "messages: must be a non-empty array"}},
        )

    # 3. Convert Anthropic Messages API → OpenAI Chat Completions format
    chat_body = convert_anthropic_input_to_messages(body)

    if not chat_body.get("messages"):
        return JSONResponse(
            status_code=400,
            content={"type": "error", "error": {"type": "invalid_request_error", "message": "input resulted in empty messages"}},
        )

    is_stream = chat_body.get("stream", False)

    # 4. Resolve model -> provider with fallback support
    input_price: float | None = None
    output_price: float | None = None
    try:
        result, model_name, provider_type, provider_id, provider_config, input_price, output_price = \
            await _dispatch_with_fallback(model_name, chat_body, request)
    except ValueError as exc:
        return JSONResponse(
            status_code=400,
            content={"type": "error", "error": {"type": "invalid_request_error", "message": str(exc)}},
        )
    except Exception as exc:
        logger.exception("All providers failed for model %s", model_name)
        return JSONResponse(
            status_code=502,
            content={"type": "error", "error": {"type": "api_error", "message": str(exc)}},
        )

    # 6. Streaming: convert OpenAI SSE → Anthropic SSE
    is_coding = original_model == "coding-mode"
    if is_stream and hasattr(result, "__aiter__"):
        wrapped = _stream_with_usage_transform(
            result,
            transform_fn=lambda src: stream_anthropic_api(src, model_name),
            request=request,
            provider_type=provider_type,
            provider_id=provider_id,
            model_name=model_name,
            input_price=input_price,
            output_price=output_price,
            is_coding_mode=is_coding,
            input_text=extract_input_text_from_body(body),
        )
        return StreamingResponse(
            wrapped,
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    # 7. Non-streaming: convert OpenAI → Anthropic Messages API format
    if isinstance(result, dict):
        anthropic_result = convert_chat_completion_to_anthropic(result, model_name)

        # Extract usage and record
        try:
            usage = extract_usage_with_fallback(provider_type, result, body)
            cost = calculate_cost(input_price, output_price, usage["input_tokens"], usage["output_tokens"])

            user_id = getattr(request.state, "user_id", None)
            api_key_id = getattr(request.state, "api_key_id", None)

            if user_id and api_key_id:
                await record_usage(
                    api_key_id=api_key_id,
                    provider_id=provider_id,
                    input_tokens=usage["input_tokens"],
                    output_tokens=usage["output_tokens"],
                    input_cost=cost["input_cost"],
                    output_cost=cost["output_cost"],
                    model=model_name,
                )
                record_token_usage(int(user_id), int(api_key_id), usage["input_tokens"] + usage["output_tokens"])
                # Increment coding session stats
                if is_coding and user_id:
                    try:
                        from db.database import increment_coding_session_stats
                        await increment_coding_session_stats(
                            user_id, usage["input_tokens"], usage["output_tokens"],
                            cost["input_cost"], cost["output_cost"],
                            model_name,
                        )
                    except Exception:
                        logger.exception("Failed to increment coding session stats")
        except Exception:
            logger.exception("Failed to record usage")

        return JSONResponse(content=anthropic_result)

    return result

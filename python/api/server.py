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
from . import providers as prov
from .usage_tracker import extract_usage, calculate_cost, record_usage
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

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(AuthMiddleware)

# ---------------------------------------------------------------------------
# Provider registry
# ---------------------------------------------------------------------------

# model_name -> (provider_type, provider_id)
# **Replace** with database-driven lookups in production.
MODEL_REGISTRY: dict[str, tuple[str, str]] = {
    # OpenAI
    "gpt-4o": ("openai", "openai-main"),
    "gpt-4o-mini": ("openai", "openai-main"),
    "gpt-4-turbo": ("openai", "openai-main"),
    "gpt-3.5-turbo": ("openai", "openai-main"),
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
    "openai": prov.openai,
    "anthropic": prov.anthropic,
    "google": prov.google,
}


# ---------------------------------------------------------------------------
# Streaming usage extraction helpers
# ---------------------------------------------------------------------------

def _extract_usage_from_sse_text(raw: str) -> tuple[int, int]:
    """Parse SSE text and return (input_tokens, output_tokens) from any usage chunk."""
    import json as _json
    input_tokens = 0
    output_tokens = 0
    for line in raw.split("\n"):
        trimmed = line.strip()
        if not trimmed.startswith("data: "):
            continue
        payload = trimmed[6:].strip()
        if not payload or payload == "[DONE]":
            continue
        try:
            parsed = _json.loads(payload)
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
        except Exception:
            pass
    return input_tokens, output_tokens


async def _stream_with_usage_raw(
    provider_stream: AsyncIterator[bytes],
    request: Request,
    provider_type: str,
    provider_id: str,
    model_name: str,
    input_price: float | None = None,
    output_price: float | None = None,
) -> AsyncIterator[bytes]:
    """Forward raw provider stream while extracting usage. Records usage when done."""
    total_in = 0
    total_out = 0
    async for chunk in provider_stream:
        yield chunk
        raw = chunk.decode("utf-8") if isinstance(chunk, bytes) else str(chunk)
        i, o = _extract_usage_from_sse_text(raw)
        if i: total_in = i
        if o: total_out = o

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
) -> AsyncIterator[bytes]:
    """Forward provider stream through a transform while extracting usage from raw chunks.

    transform_fn should be an async generator factory: (source) -> AsyncIterator[bytes]
    Raw chunks are intercepted before the transform to extract OpenAI-format usage.
    """
    total_in = 0
    total_out = 0

    # Intercept raw chunks via a peekable wrapper
    async def _peek_source():
        nonlocal total_in, total_out
        async for chunk in provider_stream:
            raw = chunk.decode("utf-8") if isinstance(chunk, bytes) else str(chunk)
            i, o = _extract_usage_from_sse_text(raw)
            if i: total_in = i
            if o: total_out = o
            yield chunk

    transformed = transform_fn(_peek_source())
    async for t_chunk in transformed:
        yield t_chunk

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
    """
    from db.database import get_provider_cache, CachedProvider, get_model_price, get_providers

    # 1. Try in-memory cache first
    cache = get_provider_cache()
    cached: CachedProvider | None = cache.get(model_name)
    if cached:
        # Try model-specific pricing from DB (only if not in cache)
        model_price = await get_model_price(cached.provider_id, model_name)
        input_price = model_price.get("input_price") if model_price else cached.input_price
        output_price = model_price.get("output_price") if model_price else cached.output_price

        return (
            cached.provider_type,
            str(cached.provider_id),
            {"base_url": cached.base_url, "api_key": cached.api_key},
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

            return (
                p["api_type"],
                str(p["id"]),
                {"base_url": p["base_url"], "api_key": p["api_key"]},
                input_price,
                output_price,
            )
    return None


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/v1/models")
async def list_models(request: Request):
    """List all available models aggregated from enabled providers (cached)."""
    from db.database import get_provider_cache

    cache = get_provider_cache()
    models: list[dict[str, Any]] = []

    for model_name, cached in cache.items():
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

    model_name = body.get("model", "")
    if not model_name:
        return JSONResponse(
            status_code=400,
            content={"error": {"message": "model is required", "type": "invalid_request_error"}},
        )

    # 2. Resolve model -> provider
    input_price: float | None = None
    output_price: float | None = None
    try:
        # Try DB lookup first, fall back to static registry
        resolved = await _lookup_model_db(model_name)
        if resolved:
            provider_type, provider_id, provider_config, input_price, output_price = resolved
        else:
            provider_type, provider_id, provider_config = _resolve_model(model_name)
    except ValueError as exc:
        return JSONResponse(
            status_code=400,
            content={"error": {"message": str(exc), "type": "invalid_request_error"}},
        )

    # 3. Route to provider adapter
    provider_module = PROVIDER_MODULES.get(provider_type)
    if provider_module is None:
        return JSONResponse(
            status_code=500,
            content={"error": {"message": f"Unknown provider type: {provider_type}", "type": "server_error"}},
        )

    is_stream = body.get("stream", False)

    try:
        result = await provider_module.chat_completion(body, provider_config)
    except Exception as exc:
        logger.exception("Provider %s error for model %s", provider_type, model_name)
        return JSONResponse(
            status_code=502,
            content={"error": {"message": str(exc), "type": "upstream_error"}},
        )

    # 4. Handle streaming vs non-streaming
    if is_stream and isinstance(result, AsyncIterator):
        wrapped = _stream_with_usage_raw(
            result,
            request=request,
            provider_type=provider_type,
            provider_id=provider_id,
            model_name=model_name,
            input_price=input_price,
            output_price=output_price,
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
            usage = extract_usage(provider_type, result)
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

    model_name = body.get("model", "")
    if not model_name:
        return JSONResponse(
            status_code=400,
            content={"error": {"message": "model is required", "type": "invalid_request_error"}},
        )

    input_data = body.get("input")
    if input_data is None:
        return JSONResponse(
            status_code=400,
            content={"error": {"message": "input is required", "type": "invalid_request_error"}},
        )

    # 2. Resolve model -> provider
    input_price: float | None = None
    output_price: float | None = None
    try:
        resolved = await _lookup_model_db(model_name)
        if resolved:
            provider_type, provider_id, provider_config, input_price, output_price = resolved
        else:
            provider_type, provider_id, provider_config = _resolve_model(model_name)
    except ValueError as exc:
        return JSONResponse(
            status_code=400,
            content={"error": {"message": str(exc), "type": "invalid_request_error"}},
        )

    # 3. Route to provider adapter
    provider_module = PROVIDER_MODULES.get(provider_type)
    if provider_module is None:
        return JSONResponse(
            status_code=500,
            content={"error": {"message": f"Unknown provider type: {provider_type}", "type": "server_error"}},
        )

    # 4. Convert Responses input → Chat Completions messages
    instructions = body.get("instructions")
    messages = convert_responses_input_to_messages(input_data, instructions)

    # 5. Build Chat Completions request
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

    is_stream = chat_body.get("stream", False)

    try:
        result = await provider_module.chat_completion(chat_body, provider_config)
    except Exception as exc:
        logger.exception("Provider %s error for model %s", provider_type, model_name)
        return JSONResponse(
            status_code=502,
            content={"error": {"message": str(exc), "type": "upstream_error"}},
        )

    # 6. Handle streaming: convert Chat Completions SSE → Responses API SSE
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
            usage = extract_usage(provider_type, result)
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

    # 2. Validate required fields
    model_name: str = body.get("model", "")
    if not model_name:
        return JSONResponse(
            status_code=400,
            content={"type": "error", "error": {"type": "invalid_request_error", "message": "model is required"}},
        )

    messages = body.get("messages")
    if not messages or not isinstance(messages, list) or len(messages) == 0:
        return JSONResponse(
            status_code=400,
            content={"type": "error", "error": {"type": "invalid_request_error", "message": "messages: must be a non-empty array"}},
        )

    # 3. Resolve model → provider
    input_price: float | None = None
    output_price: float | None = None
    try:
        resolved = await _lookup_model_db(model_name)
        if resolved:
            provider_type, provider_id, provider_config, input_price, output_price = resolved
        else:
            provider_type, provider_id, provider_config = _resolve_model(model_name)
    except ValueError as exc:
        return JSONResponse(
            status_code=400,
            content={"type": "error", "error": {"type": "invalid_request_error", "message": str(exc)}},
        )

    provider_fn = PROVIDER_MODULES.get(provider_type)
    if not provider_fn:
        return JSONResponse(
            status_code=500,
            content={"type": "error", "error": {"type": "server_error", "message": f"Unknown provider type: {provider_type}"}},
        )

    # 4. Convert Anthropic Messages API → OpenAI Chat Completions format
    chat_body = convert_anthropic_input_to_messages(body)

    if not chat_body.get("messages"):
        return JSONResponse(
            status_code=400,
            content={"type": "error", "error": {"type": "invalid_request_error", "message": "input resulted in empty messages"}},
        )

    is_stream = chat_body.get("stream", False)

    # 5. Call provider
    try:
        result = await provider_fn(chat_body, provider_config)
    except Exception as exc:
        logger.exception("Provider %s error for model %s", provider_type, model_name)
        return JSONResponse(
            status_code=502,
            content={"type": "error", "error": {"type": "api_error", "message": str(exc)}},
        )

    # 6. Streaming: convert OpenAI SSE → Anthropic SSE
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
            usage = extract_usage(provider_type, result)
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
        except Exception:
            logger.exception("Failed to record usage")

        return JSONResponse(content=anthropic_result)

    return result

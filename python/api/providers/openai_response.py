"""
OpenAI Responses API provider adapter.

Handles requests to OpenAI Responses API compatible endpoints.
This provider sends requests to the /v1/responses endpoint instead of /chat/completions.

Exposes two public functions:
- responses_api(): Direct pass-through for Responses API format.
- chat_completion(): Converts Chat Completions → Responses → sends → converts back.
"""

from __future__ import annotations

import json
import logging
import asyncio
from typing import Any, AsyncIterator

import httpx

from ..responses import (
    convert_messages_to_responses_input,
    convert_chat_tools_to_responses_tools,
    convert_responses_to_chat_completion,
    stream_chat_from_responses,
)

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 120.0
MAX_RETRIES = 2
RETRY_DELAY = 0.5


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

async def responses_api(
    request_data: dict[str, Any],
    provider_config: dict[str, Any],
) -> dict[str, Any] | AsyncIterator[bytes]:
    """Send a Responses API request directly to upstream.

    Used when our /v1/responses endpoint receives a request
    and the provider is openai_response type — pass through directly.
    """
    base_url = provider_config["base_url"].rstrip("/")
    api_key = provider_config["api_key"]
    timeout = provider_config.get("timeout", DEFAULT_TIMEOUT)
    extra_headers = provider_config.get("extra_headers", {})
    is_stream = request_data.get("stream", False)

    url = f"{base_url}/responses"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        **extra_headers,
    }

    return await _do_request(url, headers, request_data, timeout, is_stream)


async def chat_completion(
    request_data: dict[str, Any],
    provider_config: dict[str, Any],
) -> dict[str, Any] | AsyncIterator[bytes]:
    """Send a chat completion request via the Responses API.

    Converts Chat Completions format → Responses API format,
    sends to upstream /v1/responses,
    then converts the result back to Chat Completions format.
    """
    messages = request_data.get("messages", [])
    model = request_data.get("model", "")
    is_stream = request_data.get("stream", False)

    # Convert chat messages to Responses API input
    input_items, instructions = convert_messages_to_responses_input(messages)

    # Build Responses API request body
    responses_body: dict[str, Any] = {
        "model": model,
        "input": input_items,
        "stream": is_stream,
    }

    # Copy over compatible parameters
    if instructions:
        responses_body["instructions"] = instructions
    if "temperature" in request_data:
        responses_body["temperature"] = request_data["temperature"]
    if "top_p" in request_data:
        responses_body["top_p"] = request_data["top_p"]
    if "max_output_tokens" in request_data:
        responses_body["max_output_tokens"] = request_data["max_output_tokens"]
    elif "max_tokens" in request_data:
        responses_body["max_output_tokens"] = request_data["max_tokens"]

    # Convert tools if present
    if "tools" in request_data:
        responses_body["tools"] = convert_chat_tools_to_responses_tools(
            request_data["tools"]
        )

    # Send via responses_api
    result = await responses_api(responses_body, provider_config)

    # Convert result back to Chat Completions format
    if is_stream:
        return stream_chat_from_responses(result, model)

    return convert_responses_to_chat_completion(result, model)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

async def _do_request(
    url: str,
    headers: dict[str, str],
    body: dict[str, Any],
    timeout: float,
    is_stream: bool,
) -> dict[str, Any] | AsyncIterator[bytes]:
    """Execute the HTTP request with basic retry logic."""

    last_exc: Exception | None = None

    for attempt in range(MAX_RETRIES + 1):
        try:
            if is_stream:
                return _stream_response(url, headers, body, timeout)

            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.post(url, headers=headers, json=body)
                resp.raise_for_status()
                return resp.json()

        except (httpx.HTTPStatusError, httpx.ConnectError, httpx.ReadTimeout) as exc:
            last_exc = exc
            status = getattr(getattr(exc, "response", None), "status_code", None)

            # Don't retry client errors (4xx) except 429
            if status is not None and 400 <= status < 500 and status != 429:
                raise _wrap_error(exc) from exc

            if attempt < MAX_RETRIES:
                logger.warning(
                    "OpenAI Responses request failed (attempt %d/%d): %s – retrying",
                    attempt + 1,
                    MAX_RETRIES + 1,
                    exc,
                )
                await asyncio.sleep(RETRY_DELAY * (attempt + 1))
                continue

            raise _wrap_error(exc) from exc

    # Should never reach here
    raise _wrap_error(last_exc) from last_exc  # type: ignore[arg-type]


async def _stream_response(
    url: str,
    headers: dict[str, str],
    body: dict[str, Any],
    timeout: float,
) -> AsyncIterator[bytes]:
    """Yield raw bytes from a Responses API streaming response.

    Unlike the chat completions streaming (which only forwards ``data:`` lines),
    Responses API uses ``event:`` + ``data:`` pairs.  We forward ALL bytes
    so that callers (pass-through or conversion) can parse them correctly.
    """
    async with httpx.AsyncClient(timeout=timeout) as client:
        async with client.stream("POST", url, headers=headers, json=body) as resp:
            resp.raise_for_status()
            async for chunk in resp.aiter_bytes():
                yield chunk


# ---------------------------------------------------------------------------
# Error helpers
# ---------------------------------------------------------------------------

def _wrap_error(exc: Exception) -> Exception:
    """Wrap upstream errors into a consistent format."""
    if isinstance(exc, httpx.HTTPStatusError):
        body = ""
        try:
            body = exc.response.text
        except Exception:  # noqa: BLE001
            pass
        return Exception(
            f"OpenAI Responses API error {exc.response.status_code}: {body}"
        )
    if isinstance(exc, httpx.ReadTimeout):
        return Exception("OpenAI Responses API request timed out")
    return exc

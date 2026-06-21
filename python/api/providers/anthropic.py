"""
Anthropic (Claude) provider adapter.

Converts between OpenAI and Anthropic API formats.
"""

from __future__ import annotations

import json
import logging
import asyncio
import time
import uuid
from typing import Any, AsyncIterator

import httpx

from api.thinking_parser import inject_for_anthropic

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 120.0
MAX_RETRIES = 2
RETRY_DELAY = 0.5

ANTHROPIC_VERSION = "2023-06-01"

# Map common OpenAI model names to Anthropic model IDs.
MODEL_MAP: dict[str, str] = {
    "claude-3-opus": "claude-3-opus-20240229",
    "claude-3-sonnet": "claude-3-sonnet-20240229",
    "claude-3-haiku": "claude-3-haiku-20240307",
    "claude-3.5-sonnet": "claude-3-5-sonnet-20241022",
    "claude-3.5-haiku": "claude-3-5-haiku-20241022",
    "claude-4-opus": "claude-opus-4-20250514",
    "claude-4-sonnet": "claude-sonnet-4-20250514",
}


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

async def chat_completion(
    request_data: dict[str, Any],
    provider_config: dict[str, Any],
) -> dict[str, Any] | AsyncIterator[bytes]:
    """Send a chat completion request to Anthropic.

    Parameters
    ----------
    request_data:
        OpenAI-format request body.
    provider_config:
        {
            "base_url": "https://api.anthropic.com",  # optional override
            "api_key": "sk-ant-...",
            "extra_headers": {},
            "timeout": 120,
        }
    """
    base_url = provider_config.get("base_url", "https://api.anthropic.com").rstrip("/")
    api_key = provider_config["api_key"]
    timeout = provider_config.get("timeout", DEFAULT_TIMEOUT)
    extra_headers = provider_config.get("extra_headers", {})
    is_stream = request_data.get("stream", False)

    anthropic_body = _to_anthropic_request(request_data)
    url = f"{base_url}/v1/messages"

    headers = {
        "x-api-key": api_key,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
        **extra_headers,
    }

    return await _do_request(url, headers, anthropic_body, timeout, is_stream, request_data)


# ---------------------------------------------------------------------------
# Format conversion: OpenAI -> Anthropic
# ---------------------------------------------------------------------------

def _to_anthropic_request(openai_req: dict[str, Any]) -> dict[str, Any]:
    """Convert an OpenAI chat completion request to Anthropic format."""

    model = openai_req.get("model", "claude-3-sonnet")
    mapped_model = MODEL_MAP.get(model, model)

    messages_raw: list[dict[str, Any]] = openai_req.get("messages", [])

    # Separate system message from the rest.
    system_text = ""
    anthropic_messages: list[dict[str, Any]] = []

    for msg in messages_raw:
        role = msg.get("role", "user")
        content = msg.get("content", "")

        if role == "system":
            # Accumulate system messages.
            if isinstance(content, list):
                parts = [p.get("text", "") for p in content if p.get("type") == "text"]
                system_text += "\n".join(parts)
            else:
                system_text += content + "\n"
        else:
            # Anthropic uses "user" and "assistant" roles.
            if role == "tool":
                # Convert tool messages to user role for simplicity.
                anthropic_messages.append({"role": "user", "content": str(content)})
            else:
                anthropic_content = _convert_content(content)
                anthropic_messages.append({
                    "role": role,
                    "content": anthropic_content,
                })

    # Merge consecutive same-role messages (Anthropic requirement).
    merged: list[dict[str, Any]] = []
    for msg in anthropic_messages:
        if merged and merged[-1]["role"] == msg["role"]:
            # Concatenate content
            prev = merged[-1]["content"]
            curr = msg["content"]
            if isinstance(prev, str) and isinstance(curr, str):
                merged[-1]["content"] = prev + "\n" + curr
            else:
                merged[-1]["content"] = str(prev) + "\n" + str(curr)
        else:
            merged.append(msg)

    body: dict[str, Any] = {
        "model": mapped_model,
        "messages": merged,
        "max_tokens": openai_req.get("max_tokens", 4096),
    }

    if system_text.strip():
        body["system"] = system_text.strip()

    # Optional parameters
    if "temperature" in openai_req:
        body["temperature"] = openai_req["temperature"]
    if "top_p" in openai_req:
        body["top_p"] = openai_req["top_p"]
    if "stop" in openai_req:
        stop = openai_req["stop"]
        if isinstance(stop, str):
            stop = [stop]
        body["stop_sequences"] = stop
    if "stream" in openai_req:
        body["stream"] = openai_req["stream"]

    # Inject thinking params if thinking_effort is set
    if openai_req.get("thinking_effort") is not None:
        inject_for_anthropic(body, openai_req["thinking_effort"])

    return body


def _convert_content(content: Any) -> Any:
    """Convert OpenAI content to Anthropic content format."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        # OpenAI multi-part content
        parts: list[dict[str, Any]] = []
        for part in content:
            ptype = part.get("type", "text")
            if ptype == "text":
                parts.append({"type": "text", "text": part.get("text", "")})
            elif ptype == "image_url":
                url = part.get("image_url", {}).get("url", "")
                if url.startswith("data:"):
                    # base64 image
                    media_type = url.split(";")[0].split(":")[1] if ":" in url else "image/png"
                    b64data = url.split(",", 1)[1] if "," in url else ""
                    parts.append({
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": media_type,
                            "data": b64data,
                        },
                    })
        return parts if parts else str(content)
    return str(content)


# ---------------------------------------------------------------------------
# Format conversion: Anthropic -> OpenAI
# ---------------------------------------------------------------------------

def _to_openai_response(
    anthropic_resp: dict[str, Any],
    original_model: str,
) -> dict[str, Any]:
    """Convert an Anthropic response to OpenAI format."""

    content_blocks = anthropic_resp.get("content", [])
    text_parts: list[str] = []
    thinking_parts: list[str] = []
    for block in content_blocks:
        if block.get("type") == "text":
            text_parts.append(block.get("text", ""))
        elif block.get("type") == "thinking":
            thinking_parts.append(block.get("thinking", ""))

    text = "".join(text_parts)
    reasoning_content = "".join(thinking_parts) if thinking_parts else None

    usage_in = anthropic_resp.get("usage", {})
    input_tokens = usage_in.get("input_tokens", 0)
    output_tokens = usage_in.get("output_tokens", 0)

    stop_reason = anthropic_resp.get("stop_reason", "end_turn")
    finish_reason = _map_stop_reason(stop_reason)

    message: dict[str, Any] = {
        "role": "assistant",
        "content": text,
    }
    if reasoning_content is not None:
        message["reasoning_content"] = reasoning_content

    return {
        "id": f"chatcmpl-{uuid.uuid4().hex[:24]}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": original_model,
        "choices": [
            {
                "index": 0,
                "message": message,
                "finish_reason": finish_reason,
            }
        ],
        "usage": {
            "prompt_tokens": input_tokens,
            "completion_tokens": output_tokens,
            "total_tokens": input_tokens + output_tokens,
        },
    }


def _map_stop_reason(reason: str) -> str:
    mapping = {
        "end_turn": "stop",
        "max_tokens": "length",
        "stop_sequence": "stop",
    }
    return mapping.get(reason, "stop")


# ---------------------------------------------------------------------------
# HTTP request with retry
# ---------------------------------------------------------------------------

async def _do_request(
    url: str,
    headers: dict[str, str],
    body: dict[str, Any],
    timeout: float,
    is_stream: bool,
    original_request: dict[str, Any],
) -> dict[str, Any] | AsyncIterator[bytes]:

    original_model = original_request.get("model", body.get("model", ""))
    last_exc: Exception | None = None

    for attempt in range(MAX_RETRIES + 1):
        try:
            if is_stream:
                return _stream_response(url, headers, body, timeout, original_model)

            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.post(url, headers=headers, json=body)
                resp.raise_for_status()
                data = resp.json()
                return _to_openai_response(data, original_model)

        except (httpx.HTTPStatusError, httpx.ConnectError, httpx.ReadTimeout) as exc:
            last_exc = exc
            status = getattr(getattr(exc, "response", None), "status_code", None)

            if status is not None and 400 <= status < 500 and status != 429:
                raise _wrap_error(exc) from exc

            if attempt < MAX_RETRIES:
                logger.warning(
                    "Anthropic request failed (attempt %d/%d): %s – retrying",
                    attempt + 1,
                    MAX_RETRIES + 1,
                    exc,
                )
                await asyncio.sleep(RETRY_DELAY * (attempt + 1))
                continue

            raise _wrap_error(exc) from exc

    raise _wrap_error(last_exc) from last_exc  # type: ignore[arg-type]


async def _stream_response(
    url: str,
    headers: dict[str, str],
    body: dict[str, Any],
    timeout: float,
    original_model: str,
) -> AsyncIterator[bytes]:
    """Convert Anthropic SSE stream to OpenAI SSE stream."""

    completion_id = f"chatcmpl-{uuid.uuid4().hex[:24]}"
    created = int(time.time())

    async with httpx.AsyncClient(timeout=timeout) as client:
        async with client.stream("POST", url, headers=headers, json=body) as resp:
            resp.raise_for_status()

            async for line in resp.aiter_lines():
                if not line.startswith("data: "):
                    continue
                payload = line[len("data: "):]
                if not payload.strip():
                    continue

                try:
                    event = json.loads(payload)
                except json.JSONDecodeError:
                    continue

                event_type = event.get("type", "")

                if event_type == "content_block_delta":
                    delta = event.get("delta", {})
                    delta_type = delta.get("type", "")
                    if delta_type == "thinking_delta":
                        # Anthropic thinking content: delta.thinking
                        thinking_text = delta.get("thinking", "")
                        if thinking_text:
                            chunk = _build_stream_chunk(
                                completion_id, created, original_model, "",
                                reasoning_content=thinking_text,
                            )
                            yield f"data: {json.dumps(chunk)}\n\n".encode("utf-8")
                    elif delta_type == "signature_delta":
                        # Signature is a security token, no need to forward
                        pass
                    else:
                        # text_delta or other: delta.text
                        delta_text = delta.get("text", "")
                        if delta_text:
                            chunk = _build_stream_chunk(
                                completion_id, created, original_model, delta_text
                            )
                            yield f"data: {json.dumps(chunk)}\n\n".encode("utf-8")

                elif event_type == "message_stop":
                    # Send final chunk with finish_reason
                    chunk = _build_stream_chunk(
                        completion_id, created, original_model, "",
                        finish_reason="stop",
                    )
                    yield f"data: {json.dumps(chunk)}\n\n".encode("utf-8")
                    yield b"data: [DONE]\n\n"
                    return

                elif event_type == "message_delta":
                    # Final delta with stop_reason
                    stop_reason = event.get("delta", {}).get("stop_reason", "end_turn")
                    finish = _map_stop_reason(stop_reason)
                    usage = event.get("usage", {})
                    chunk = _build_stream_chunk(
                        completion_id, created, original_model, "",
                        finish_reason=finish,
                        usage=usage,
                    )
                    yield f"data: {json.dumps(chunk)}\n\n".encode("utf-8")

                elif event_type == "error":
                    err = event.get("error", {})
                    raise Exception(
                        f"Anthropic stream error: {err.get('type', 'unknown')}: "
                        f"{err.get('message', 'unknown error')}"
                    )

    yield b"data: [DONE]\n\n"


def _build_stream_chunk(
    completion_id: str,
    created: int,
    model: str,
    text: str,
    finish_reason: str | None = None,
    usage: dict[str, Any] | None = None,
    reasoning_content: str | None = None,
) -> dict[str, Any]:
    """Build a single OpenAI-format streaming chunk."""
    delta: dict[str, Any] = {}
    if text:
        delta["content"] = text
    if reasoning_content:
        delta["reasoning_content"] = reasoning_content

    chunk: dict[str, Any] = {
        "id": completion_id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": [
            {
                "index": 0,
                "delta": delta,
                "finish_reason": finish_reason,
            }
        ],
    }
    if usage:
        chunk["usage"] = {
            "prompt_tokens": usage.get("input_tokens", 0),
            "completion_tokens": usage.get("output_tokens", 0),
            "total_tokens": usage.get("input_tokens", 0) + usage.get("output_tokens", 0),
        }
    return chunk


# ---------------------------------------------------------------------------
# Error helpers
# ---------------------------------------------------------------------------

def _wrap_error(exc: Exception) -> Exception:
    if isinstance(exc, httpx.HTTPStatusError):
        body = ""
        try:
            body = exc.response.text
        except Exception:  # noqa: BLE001
            pass
        return Exception(f"Anthropic API error {exc.response.status_code}: {body}")
    if isinstance(exc, httpx.ReadTimeout):
        return Exception("Anthropic API request timed out")
    return exc

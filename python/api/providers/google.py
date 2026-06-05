"""
Google Gemini provider adapter.

Converts between OpenAI and Google Gemini API formats.
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from typing import Any, AsyncIterator

import httpx

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 120.0
MAX_RETRIES = 2
RETRY_DELAY = 0.5

# Map common model aliases to Gemini model IDs.
MODEL_MAP: dict[str, str] = {
    "gemini-pro": "gemini-1.5-pro",
    "gemini-1.5-pro": "gemini-1.5-pro-latest",
    "gemini-1.5-flash": "gemini-1.5-flash-latest",
    "gemini-2.0-flash": "gemini-2.0-flash",
    "gemini-2.5-pro": "gemini-2.5-pro-preview-05-06",
    "gemini-2.5-flash": "gemini-2.5-flash-preview-05-20",
}


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

async def chat_completion(
    request_data: dict[str, Any],
    provider_config: dict[str, Any],
) -> dict[str, Any] | AsyncIterator[bytes]:
    """Send a chat completion request to Google Gemini.

    Parameters
    ----------
    request_data:
        OpenAI-format request body.
    provider_config:
        {
            "base_url": "https://generativelanguage.googleapis.com",  # optional
            "api_key": "AIza...",
            "extra_headers": {},
            "timeout": 120,
        }
    """
    base_url = provider_config.get(
        "base_url", "https://generativelanguage.googleapis.com"
    ).rstrip("/")
    api_key = provider_config["api_key"]
    timeout = provider_config.get("timeout", DEFAULT_TIMEOUT)
    extra_headers = provider_config.get("extra_headers", {})
    is_stream = request_data.get("stream", False)

    gemini_body = _to_gemini_request(request_data)
    model = gemini_body.get("_model", "gemini-1.5-pro-latest")
    del gemini_body["_model"]

    if is_stream:
        endpoint = f"{base_url}/v1beta/models/{model}:streamGenerateContent?alt=sse&key={api_key}"
    else:
        endpoint = f"{base_url}/v1beta/models/{model}:generateContent?key={api_key}"

    headers = {"Content-Type": "application/json", **extra_headers}

    return await _do_request(
        endpoint, headers, gemini_body, timeout, is_stream,
        request_data.get("model", model),
    )


# ---------------------------------------------------------------------------
# Format conversion: OpenAI -> Gemini
# ---------------------------------------------------------------------------

def _to_gemini_request(openai_req: dict[str, Any]) -> dict[str, Any]:
    """Convert OpenAI-format request to Gemini generateContent format."""

    model = openai_req.get("model", "gemini-1.5-pro")
    mapped_model = MODEL_MAP.get(model, model)

    messages_raw: list[dict[str, Any]] = openai_req.get("messages", [])

    system_instruction: dict[str, Any] | None = None
    contents: list[dict[str, Any]] = []

    for msg in messages_raw:
        role = msg.get("role", "user")
        content = msg.get("content", "")

        if role == "system":
            system_instruction = _build_content_part(content)
            continue

        gemini_role = "user" if role in ("user", "tool") else "model"
        parts = _build_parts(content)
        contents.append({"role": gemini_role, "parts": parts})

    # Gemini requires alternating user/model roles.
    # If the first message isn't from user, insert a placeholder.
    if contents and contents[0]["role"] != "user":
        contents.insert(0, {"role": "user", "parts": [{"text": ""}]})

    # Ensure alternating roles: merge consecutive same-role messages.
    contents = _merge_consecutive(contents)

    body: dict[str, Any] = {
        "_model": mapped_model,
        "contents": contents,
    }

    if system_instruction:
        body["systemInstruction"] = system_instruction

    # Generation config
    gen_config: dict[str, Any] = {}
    if "temperature" in openai_req:
        gen_config["temperature"] = openai_req["temperature"]
    if "top_p" in openai_req:
        gen_config["topP"] = openai_req["top_p"]
    if "max_tokens" in openai_req:
        gen_config["maxOutputTokens"] = openai_req["max_tokens"]
    if "stop" in openai_req:
        stop = openai_req["stop"]
        if isinstance(stop, str):
            stop = [stop]
        gen_config["stopSequences"] = stop
    if "presence_penalty" in openai_req:
        gen_config["presencePenalty"] = openai_req["presence_penalty"]
    if "frequency_penalty" in openai_req:
        gen_config["frequencyPenalty"] = openai_req["frequency_penalty"]

    if gen_config:
        body["generationConfig"] = gen_config

    return body


def _build_parts(content: Any) -> list[dict[str, Any]]:
    """Convert OpenAI content to Gemini parts."""
    if isinstance(content, str):
        return [{"text": content}]
    if isinstance(content, list):
        parts: list[dict[str, Any]] = []
        for part in content:
            ptype = part.get("type", "text")
            if ptype == "text":
                parts.append({"text": part.get("text", "")})
            elif ptype == "image_url":
                url = part.get("image_url", {}).get("url", "")
                if url.startswith("data:"):
                    # data:image/png;base64,xxxx
                    header, b64data = url.split(",", 1)
                    mime = header.split(";")[0].split(":")[1] if ":" in header else "image/png"
                    parts.append({
                        "inlineData": {
                            "mimeType": mime,
                            "data": b64data,
                        }
                    })
        return parts if parts else [{"text": ""}]
    return [{"text": str(content)}]


def _build_content_part(content: Any) -> dict[str, Any]:
    """Build a system instruction content block."""
    if isinstance(content, str):
        return {"parts": [{"text": content}]}
    if isinstance(content, list):
        texts = []
        for part in content:
            if part.get("type") == "text":
                texts.append(part.get("text", ""))
        return {"parts": [{"text": "\n".join(texts)}]}
    return {"parts": [{"text": str(content)}]}


def _merge_consecutive(contents: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Merge consecutive messages with the same role."""
    merged: list[dict[str, Any]] = []
    for msg in contents:
        if merged and merged[-1]["role"] == msg["role"]:
            # Merge parts
            merged[-1]["parts"].extend(msg["parts"])
        else:
            merged.append({"role": msg["role"], "parts": list(msg["parts"])})
    return merged


# ---------------------------------------------------------------------------
# Format conversion: Gemini -> OpenAI
# ---------------------------------------------------------------------------

def _to_openai_response(
    gemini_resp: dict[str, Any],
    original_model: str,
) -> dict[str, Any]:
    """Convert Gemini generateContent response to OpenAI format."""

    candidates = gemini_resp.get("candidates", [])
    text = ""
    finish_reason = "stop"

    if candidates:
        candidate = candidates[0]
        content = candidate.get("content", {})
        parts = content.get("parts", [])
        text_parts = [p.get("text", "") for p in parts if "text" in p]
        text = "".join(text_parts)

        reason = candidate.get("finishReason", "STOP")
        if reason == "MAX_TOKENS":
            finish_reason = "length"
        elif reason == "SAFETY":
            finish_reason = "content_filter"

    usage_meta = gemini_resp.get("usageMetadata", {})
    prompt_tokens = usage_meta.get("promptTokenCount", 0)
    completion_tokens = usage_meta.get("candidatesTokenCount", 0)

    return {
        "id": f"chatcmpl-{uuid.uuid4().hex[:24]}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": original_model,
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": text,
                },
                "finish_reason": finish_reason,
            }
        ],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        },
    }


# ---------------------------------------------------------------------------
# HTTP request with retry
# ---------------------------------------------------------------------------

async def _do_request(
    url: str,
    headers: dict[str, str],
    body: dict[str, Any],
    timeout: float,
    is_stream: bool,
    original_model: str,
) -> dict[str, Any] | AsyncIterator[bytes]:

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
                    "Gemini request failed (attempt %d/%d): %s – retrying",
                    attempt + 1,
                    MAX_RETRIES + 1,
                    exc,
                )
                time.sleep(RETRY_DELAY * (attempt + 1))
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
    """Convert Gemini SSE stream to OpenAI SSE stream."""

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

                # Check for errors
                if "error" in event:
                    err = event["error"]
                    raise Exception(
                        f"Gemini stream error: {err.get('code', 'unknown')}: "
                        f"{err.get('message', 'unknown error')}"
                    )

                candidates = event.get("candidates", [])
                if not candidates:
                    continue

                candidate = candidates[0]
                content = candidate.get("content", {})
                parts = content.get("parts", [])
                text = "".join(p.get("text", "") for p in parts if "text" in p)

                finish_reason = None
                reason = candidate.get("finishReason")
                if reason:
                    finish_reason = "length" if reason == "MAX_TOKENS" else "stop"

                chunk = {
                    "id": completion_id,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": original_model,
                    "choices": [
                        {
                            "index": 0,
                            "delta": {"content": text} if text else {},
                            "finish_reason": finish_reason,
                        }
                    ],
                }

                # Include usage in final chunk if present
                usage_meta = event.get("usageMetadata")
                if usage_meta and finish_reason:
                    chunk["usage"] = {
                        "prompt_tokens": usage_meta.get("promptTokenCount", 0),
                        "completion_tokens": usage_meta.get("candidatesTokenCount", 0),
                        "total_tokens": usage_meta.get("totalTokenCount", 0),
                    }

                yield f"data: {json.dumps(chunk)}\n\n".encode("utf-8")

    yield b"data: [DONE]\n\n"


# ---------------------------------------------------------------------------
# Usage extraction
# ---------------------------------------------------------------------------

def extract_usage(response_data: dict[str, Any]) -> dict[str, int]:
    """Extract token usage from an already-converted OpenAI-format response."""
    usage = response_data.get("usage", {})
    return {
        "input_tokens": usage.get("prompt_tokens", 0),
        "output_tokens": usage.get("completion_tokens", 0),
    }


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
        return Exception(f"Gemini API error {exc.response.status_code}: {body}")
    if isinstance(exc, httpx.ReadTimeout):
        return Exception("Gemini API request timed out")
    return exc

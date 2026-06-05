"""
OpenAI-compatible provider adapter.

Handles requests to OpenAI and OpenAI-compatible APIs (Azure, local models, etc.).
Input/Output: Standard OpenAI chat completion format.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any, AsyncIterator

import httpx

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 120.0
MAX_RETRIES = 2
RETRY_DELAY = 0.5


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

async def chat_completion(
    request_data: dict[str, Any],
    provider_config: dict[str, Any],
) -> dict[str, Any] | AsyncIterator[bytes]:
    """Send a chat completion request to an OpenAI-compatible endpoint.

    Parameters
    ----------
    request_data:
        The full OpenAI-format request body (already in native format).
    provider_config:
        {
            "base_url": "https://api.openai.com/v1",  # or custom URL
            "api_key": "sk-...",
            "extra_headers": {},        # optional extra headers
            "timeout": 120,             # optional per-request timeout
        }

    Returns
    -------
    dict for non-streaming, AsyncIterator[bytes] for streaming.
    """
    base_url = provider_config["base_url"].rstrip("/")
    api_key = provider_config["api_key"]
    timeout = provider_config.get("timeout", DEFAULT_TIMEOUT)
    extra_headers = provider_config.get("extra_headers", {})
    is_stream = request_data.get("stream", False)

    url = f"{base_url}/chat/completions"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        **extra_headers,
    }

    # If there's an azure_deployment in config, switch to Azure-style URL
    if "azure_deployment" in provider_config:
        deployment = provider_config["azure_deployment"]
        api_version = provider_config.get("azure_api_version", "2024-02-15-preview")
        url = (
            f"{base_url}/openai/deployments/{deployment}/chat/completions"
            f"?api-version={api_version}"
        )
        # Azure uses api-key header instead of Bearer
        headers.pop("Authorization", None)
        headers["api-key"] = api_key

    return await _do_request(url, headers, request_data, timeout, is_stream)


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
                    "OpenAI request failed (attempt %d/%d): %s – retrying",
                    attempt + 1,
                    MAX_RETRIES + 1,
                    exc,
                )
                time.sleep(RETRY_DELAY * (attempt + 1))
                continue

            raise _wrap_error(exc) from exc

    # Should never reach here, but just in case
    raise _wrap_error(last_exc) from last_exc  # type: ignore[arg-type]


async def _stream_response(
    url: str,
    headers: dict[str, str],
    body: dict[str, Any],
    timeout: float,
) -> AsyncIterator[bytes]:
    """Yield SSE chunks from an OpenAI streaming response."""

    async with httpx.AsyncClient(timeout=timeout) as client:
        async with client.stream("POST", url, headers=headers, json=body) as resp:
            resp.raise_for_status()

            async for line in resp.aiter_lines():
                # SSE lines: keep data: lines, forward everything else as-is
                if line.startswith("data: "):
                    data = line[len("data: "):]
                    if data.strip() == "[DONE]":
                        yield b"data: [DONE]\n\n"
                        return
                    yield f"data: {data}\n\n".encode("utf-8")
                elif line.strip():
                    # Could be a comment or something else; skip
                    continue


# ---------------------------------------------------------------------------
# Usage extraction
# ---------------------------------------------------------------------------

def extract_usage(response_data: dict[str, Any]) -> dict[str, int]:
    """Extract token usage from an OpenAI-format response."""
    usage = response_data.get("usage", {})
    return {
        "input_tokens": usage.get("prompt_tokens", 0),
        "output_tokens": usage.get("completion_tokens", 0),
    }


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
            f"OpenAI API error {exc.response.status_code}: {body}"
        )
    if isinstance(exc, httpx.ReadTimeout):
        return Exception("OpenAI API request timed out")
    return exc

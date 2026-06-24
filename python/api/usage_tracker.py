"""
Token usage tracking and cost calculation.

Handles provider-specific usage extraction, cost calculation, and recording.
"""

from __future__ import annotations

import logging
import math
from typing import Any

import httpx

try:
    import tiktoken
    _HAS_TIKTOKEN = True
except ImportError:
    _HAS_TIKTOKEN = False

logger = logging.getLogger(__name__)

# Provider configuration for accurate token counting
ProviderConfig = dict[str, str]

# ---------------------------------------------------------------------------
# Usage extraction
# ---------------------------------------------------------------------------

def extract_usage(
    provider_type: str,
    response_data: dict[str, Any],
) -> dict[str, int]:
    """Extract input/output token counts from a provider response.

    All provider adapters already convert responses to OpenAI format,
    so we can rely on the standard ``usage`` field.
    """
    usage = response_data.get("usage", {})

    # OpenAI format (native or already converted)
    input_tokens = usage.get("prompt_tokens", 0)
    output_tokens = usage.get("completion_tokens", 0)

    # Fallback: some responses may use different key names
    if not input_tokens:
        input_tokens = usage.get("input_tokens", 0)
    if not output_tokens:
        output_tokens = usage.get("output_tokens", 0)

    return {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
    }


# ---------------------------------------------------------------------------
# Token estimation fallback (when providers don't return usage data)
# ---------------------------------------------------------------------------

def estimate_tokens(text: str) -> int:
    """Estimate token count from text.

    Uses a simple heuristic:
    - CJK characters: ~1.2 tokens per character
    - Latin/ASCII characters: ~0.25 tokens per character (≈4 chars/token)
    """
    if not text:
        return 0

    cjk_count = 0
    other_count = 0
    for ch in text:
        code = ord(ch)
        # CJK Unified Ideographs + common CJK ranges
        if (
            0x4E00 <= code <= 0x9FFF        # CJK Unified Ideographs
            or 0x3400 <= code <= 0x4DBF     # CJK Extension A
            or 0x3040 <= code <= 0x30FF     # Hiragana + Katakana
            or 0xAC00 <= code <= 0xD7AF     # Hangul Syllables
            or 0xFF00 <= code <= 0xFFEF     # Fullwidth Forms
        ):
            cjk_count += 1
        else:
            other_count += 1

    return max(1, math.ceil(cjk_count * 1.2 + other_count * 0.25))


def extract_input_text_from_body(body: dict[str, Any]) -> str:
    """Extract concatenated input text from a request body.

    Supports three API formats:
    - Chat Completions: body.messages[].content (string or multimodal array)
    - Responses API: body.input (string or array of {role, content})
    - Responses API: body.instructions (system prompt string)
    """
    parts: list[str] = []

    # Chat Completions format: messages[].content
    messages = body.get("messages")
    if isinstance(messages, list):
        for msg in messages:
            if not isinstance(msg, dict):
                continue
            content = msg.get("content")
            if isinstance(content, str):
                parts.append(content)
            elif isinstance(content, list):
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "text":
                        parts.append(block.get("text", ""))
                    elif isinstance(block, str):
                        parts.append(block)

    # Responses API format: input as string or array of {role, content}
    input_data = body.get("input")
    if isinstance(input_data, str):
        parts.append(input_data)
    elif isinstance(input_data, list):
        for item in input_data:
            if not isinstance(item, dict):
                continue
            content = item.get("content")
            if isinstance(content, str):
                parts.append(content)
            elif isinstance(content, list):
                for block in content:
                    if isinstance(block, str):
                        parts.append(block)
                    elif isinstance(block, dict):
                        if block.get("type") in ("text", "input_text"):
                            parts.append(block.get("text", ""))

    # Responses API format: instructions (system prompt)
    instructions = body.get("instructions")
    if isinstance(instructions, str):
        parts.append(instructions)

    return " ".join(parts)


def extract_output_text_from_response(response_data: dict[str, Any]) -> str:
    """Extract concatenated output text from a response.

    Supports two API response formats:
    - Chat Completions: choices[].message.content + reasoning_content
    - Responses API: output[].content[] (with type output_text/text)
    """
    parts: list[str] = []

    # Chat Completions format: choices[].message.content + reasoning_content
    choices = response_data.get("choices")
    if isinstance(choices, list):
        for choice in choices:
            if not isinstance(choice, dict):
                continue
            message = choice.get("message", {})
            if isinstance(message, dict):
                content = message.get("content")
                if isinstance(content, str) and content:
                    parts.append(content)
                reasoning = message.get("reasoning_content")
                if isinstance(reasoning, str) and reasoning:
                    parts.append(reasoning)

    # Responses API format: output[].content[]
    output_items = response_data.get("output")
    if isinstance(output_items, list):
        for item in output_items:
            if not isinstance(item, dict):
                continue
            content = item.get("content")
            if isinstance(content, str):
                parts.append(content)
            elif isinstance(content, list):
                for block in content:
                    if isinstance(block, str):
                        parts.append(block)
                    elif isinstance(block, dict):
                        text = block.get("text")
                        if isinstance(text, str) and text:
                            # type can be "output_text", "text", etc.
                            parts.append(text)

    return " ".join(parts)


# ---------------------------------------------------------------------------
# Accurate token counting (tiktoken / count_tokens API)
# ---------------------------------------------------------------------------

def _get_openai_encoding(model_name: str):
    """Get tiktoken encoding for an OpenAI model, with fallback to cl100k_base."""
    if not _HAS_TIKTOKEN:
        raise ImportError("tiktoken not installed")
    try:
        return tiktoken.encoding_for_model(model_name)
    except KeyError:
        return tiktoken.get_encoding("cl100k_base")


def count_tokens_openai(text: str, model_name: str | None = None) -> int:
    """Count tokens using tiktoken (OpenAI BPE tokenizer)."""
    if not text or not _HAS_TIKTOKEN:
        return 0
    encoding = _get_openai_encoding(model_name or "gpt-4o")
    return len(encoding.encode(text))


async def count_tokens_anthropic(
    text: str,
    provider_config: ProviderConfig,
    model_name: str | None = None,
) -> int:
    """Count tokens via Anthropic count_tokens API."""
    if not text:
        return 0
    base_url = provider_config.get("base_url", "").rstrip("/")
    api_key = provider_config.get("api_key", "")
    if not base_url or not api_key:
        return 0
    model = model_name or "claude-sonnet-4-20250514"
    url = f"{base_url}/v1/messages/count_tokens"
    headers = {
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    body = {
        "model": model,
        "max_tokens": 1,
        "messages": [{"role": "user", "content": text}],
    }
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(url, json=body, headers=headers)
        resp.raise_for_status()
        data = resp.json()
        return data.get("input_tokens", 0)


async def count_tokens_google(
    text: str,
    provider_config: ProviderConfig,
    model_name: str | None = None,
) -> int:
    """Count tokens via Google countTokens API."""
    if not text:
        return 0
    base_url = provider_config.get("base_url", "").rstrip("/")
    api_key = provider_config.get("api_key", "")
    if not base_url or not api_key:
        return 0
    model = model_name or "gemini-2.0-flash"
    url = f"{base_url}/v1beta/models/{model}:countTokens?key={api_key}"
    body = {"contents": [{"parts": [{"text": text}]}]}
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(url, json=body)
        resp.raise_for_status()
        data = resp.json()
        return data.get("totalTokens", 0)


async def count_tokens_accurate(
    provider_type: str,
    text: str,
    provider_config: ProviderConfig | None = None,
    model_name: str | None = None,
) -> int:
    """Dispatch to provider-specific accurate token counter.

    Returns 0 on any error (caller should fall back to estimate_tokens).
    """
    if not text:
        return 0
    try:
        if provider_type in ("openai", "openai_chat", "openai_response"):
            return count_tokens_openai(text, model_name)
        elif provider_type == "anthropic":
            if not provider_config:
                return 0
            return await count_tokens_anthropic(text, provider_config, model_name)
        elif provider_type == "google":
            if not provider_config:
                return 0
            return await count_tokens_google(text, provider_config, model_name)
    except Exception:
        logger.debug("Accurate token counting failed, falling back to heuristic")
    return 0


async def extract_usage_with_fallback(
    provider_type: str,
    response_data: dict[str, Any],
    body: dict[str, Any] | None = None,
    provider_config: ProviderConfig | None = None,
    model_name: str | None = None,
) -> dict[str, int]:
    """Extract usage; if no usage data, count accurately or estimate."""
    usage = extract_usage(provider_type, response_data)

    # Count input/output independently — some providers return only one of the two
    if usage["input_tokens"] == 0 and body:
        input_text = extract_input_text_from_body(body)
        if input_text:
            count = await count_tokens_accurate(provider_type, input_text, provider_config, model_name)
            usage["input_tokens"] = count if count else estimate_tokens(input_text)
    if usage["output_tokens"] == 0:
        output_text = extract_output_text_from_response(response_data)
        if output_text:
            count = await count_tokens_accurate(provider_type, output_text, provider_config, model_name)
            usage["output_tokens"] = count if count else estimate_tokens(output_text)

    return usage


# ---------------------------------------------------------------------------
# Cost calculation
# ---------------------------------------------------------------------------

def calculate_cost(
    input_price: float | None,
    output_price: float | None,
    input_tokens: int,
    output_tokens: int,
) -> dict[str, float]:
    """Calculate cost in USD based on per-token prices from the database.

    Parameters
    ----------
    input_price:
        USD per 1M input tokens (from model_prices or providers table).
    output_price:
        USD per 1M output tokens (from model_prices or providers table).
    input_tokens:
        Number of input (prompt) tokens.
    output_tokens:
        Number of output (completion) tokens.

    Returns
    -------
    {"input_cost": float, "output_cost": float} in USD.
    """
    in_price = input_price or 0.0
    out_price = output_price or 0.0

    input_cost = (input_tokens / 1_000_000.0) * in_price
    output_cost = (output_tokens / 1_000_000.0) * out_price

    return {
        "input_cost": round(input_cost, 8),
        "output_cost": round(output_cost, 8),
    }


# ---------------------------------------------------------------------------
# Usage recording
# ---------------------------------------------------------------------------

async def record_usage(
    api_key_id: int,
    provider_id: int,
    input_tokens: int,
    output_tokens: int,
    input_cost: float,
    output_cost: float,
    model: str,
) -> None:
    """Enqueue a usage event for batch writing to the database.

    The actual DB write happens in a background flush (every 5s or at 100 entries).
    """
    from db.database import enqueue_usage

    total_cost = round(input_cost + output_cost, 8)

    logger.info(
        "Usage: api_key=%s provider=%s model=%s in=%d out=%d cost=$%.8f",
        api_key_id,
        provider_id,
        model,
        input_tokens,
        output_tokens,
        total_cost,
    )

    enqueue_usage(
        api_key_id=api_key_id,
        provider_id=int(provider_id),
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        input_cost=input_cost,
        output_cost=output_cost,
        model=model,
    )

"""
Token usage tracking and cost calculation.

Handles provider-specific usage extraction, cost calculation, and recording.
"""

from __future__ import annotations

import logging
import math
from typing import Any

logger = logging.getLogger(__name__)

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
    """Extract concatenated input text from a request body (Chat Completions format).

    Handles both string content and multimodal content arrays.
    """
    parts: list[str] = []
    messages = body.get("messages", [])
    if not isinstance(messages, list):
        return ""
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
    return " ".join(parts)


def extract_output_text_from_response(response_data: dict[str, Any]) -> str:
    """Extract concatenated output text from a response (OpenAI format)."""
    parts: list[str] = []
    choices = response_data.get("choices", [])
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
    return " ".join(parts)


def extract_usage_with_fallback(
    provider_type: str,
    response_data: dict[str, Any],
    body: dict[str, Any] | None = None,
) -> dict[str, int]:
    """Extract usage; if no usage data, estimate from request/response text."""
    usage = extract_usage(provider_type, response_data)

    if usage["input_tokens"] == 0 and usage["output_tokens"] == 0:
        output_text = extract_output_text_from_response(response_data)
        if output_text:
            usage["output_tokens"] = estimate_tokens(output_text)
        if body:
            input_text = extract_input_text_from_body(body)
            if input_text:
                usage["input_tokens"] = estimate_tokens(input_text)

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

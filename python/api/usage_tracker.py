"""
Token usage tracking and cost calculation.

Handles provider-specific usage extraction, cost calculation, and recording.
"""

from __future__ import annotations

import logging
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

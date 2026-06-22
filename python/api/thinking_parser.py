"""
Thinking effort / reasoning intensity parser and provider mapper.

Supports two input methods:
1. Model name suffix: "o3(high)", "claude-sonnet(medium)", "gemini-2.5-pro(low)"
2. Request body parameter: reasoning_effort or thinking_effort

Six unified levels: xhigh / high / medium / low / minimal / none

Normalizes to a unified ``thinking_effort`` field on the body, then each provider
maps it to the upstream-specific format:
- OpenAI Chat      -> reasoning_effort: "high"  (direct 1:1 for all 6 levels)
- OpenAI Responses -> reasoning: { effort: "high" }
- Anthropic        -> thinking: { type: "enabled", budget_tokens: N } or { type: "disabled" } for none
- Google Gemini    -> generationConfig.thinkingConfig.thinkingBudget + thinkingLevel (Gemini 3.x)
"""

from __future__ import annotations

import re
from typing import Any, Literal, Optional


# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------

ThinkingLevel = Literal["xhigh", "high", "medium", "low", "minimal", "none"]

_VALID_LEVELS: set[str] = {"xhigh", "high", "medium", "low", "minimal", "none"}


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Regex for model suffix: model_name(level) -- allows optional whitespace
_MODEL_SUFFIX_RE = re.compile(
    r"^(.+?)\s*\(\s*(xhigh|high|medium|low|minimal|none)\s*\)\s*$",
    re.IGNORECASE,
)

# Regex to detect ANY (word) suffix -- used to flag invalid thinking levels
_ANY_SUFFIX_RE = re.compile(r"^(.+?)\s*\(\s*([a-zA-Z]+)\s*\)\s*$")

# Anthropic thinking budget_tokens for each level.
# Anthropic requires max_tokens > budget_tokens.
# minimal uses 1024 (Anthropic minimum).
# "none" is handled separately as { type: "disabled" }.
ANTHROPIC_THINKING_BUDGET: dict[str, int] = {
    "xhigh": 64000,
    "high": 32048,
    "medium": 16000,
    "low": 5000,
    "minimal": 1024,
}

# Google Gemini thinkingBudget for each level (Gemini 2.5 models).
# 0 = disabled.
GOOGLE_THINKING_BUDGET: dict[str, int] = {
    "xhigh": 32768,
    "high": 24576,
    "medium": 12288,
    "low": 2048,
    "minimal": 512,
    "none": 0,
}

# Google Gemini thinkingLevel enum (Gemini 3.x models).
# Mapped from our unified levels. 'none' has no thinkingLevel (uses budget=0).
# 'xhigh' maps to "high" (Gemini max available).
GOOGLE_THINKING_LEVEL: dict[str, str] = {
    "xhigh": "high",
    "high": "high",
    "medium": "medium",
    "low": "low",
    "minimal": "minimal",
}


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------


def parse_model_thinking_suffix(
    model: str,
) -> dict[str, Any]:
    """Parse a model name that may contain a thinking-level suffix.

    Examples:
        ``"o3(high)"``              -> ``{"model": "o3", "thinking_level": "high"}``
        ``"claude-sonnet(medium)"`` -> ``{"model": "claude-sonnet", "thinking_level": "medium"}``
        ``"gemini-2.5-pro( low )"`` -> ``{"model": "gemini-2.5-pro", "thinking_level": "low"}``
        ``"gpt-5.1(xhigh)"``        -> ``{"model": "gpt-5.1", "thinking_level": "xhigh"}``
        ``"gpt-4o(none)"``          -> ``{"model": "gpt-4o", "thinking_level": "none"}``
        ``"model(extreme)"``        -> ``{"model": "model", "invalid_level": "extreme"}``
        ``"gpt-4o"``                -> ``{"model": "gpt-4o"}``
    """
    match = _MODEL_SUFFIX_RE.match(model)
    if match:
        return {
            "model": match.group(1).strip(),
            "thinking_level": match.group(2).lower(),
        }

    # Detect any (word) suffix that looks like a thinking level attempt
    any_match = _ANY_SUFFIX_RE.match(model)
    if any_match:
        return {
            "model": any_match.group(1).strip(),
            "invalid_level": any_match.group(2),
        }

    return {"model": model}


def extract_thinking_level(body: dict[str, Any]) -> Optional[ThinkingLevel]:
    """Extract thinking level from a request body (without model suffix parsing).

    Priority:
        1. ``reasoning_effort`` (OpenAI standard field)
        2. ``thinking_effort``  (custom unified field)
        3. ``thinking.budget_tokens`` (Anthropic format -- reverse-map to level)

    Returns ``None`` if no thinking level is specified.
    """
    # 1. reasoning_effort (OpenAI standard)
    reasoning_effort = body.get("reasoning_effort")
    if isinstance(reasoning_effort, str):
        lvl = reasoning_effort.lower()
        if lvl in _VALID_LEVELS:
            return lvl  # type: ignore[return-value]

    # 2. Custom thinking_effort (our unified field)
    thinking_effort = body.get("thinking_effort")
    if isinstance(thinking_effort, str):
        lvl = thinking_effort.lower()
        if lvl in _VALID_LEVELS:
            return lvl  # type: ignore[return-value]

    # 3. Anthropic thinking format -- reverse-map budget_tokens to level
    thinking = body.get("thinking")
    if isinstance(thinking, dict):
        if thinking.get("type") == "disabled":
            return "none"
        if thinking.get("type") == "enabled":
            budget = thinking.get("budget_tokens")
            if isinstance(budget, (int, float)):
                if budget >= 48000:
                    return "xhigh"
                if budget >= 24000:
                    return "high"
                if budget >= 10000:
                    return "medium"
                if budget >= 3000:
                    return "low"
                return "minimal"

    return None


# ---------------------------------------------------------------------------
# Unified preprocessing -- call at every endpoint entry point
# ---------------------------------------------------------------------------


def preprocess_thinking(body: dict[str, Any]) -> None:
    """Process a request body at the server entry point.

    1. Parse model suffix (e.g. ``"o3(high)"`` -> model=``"o3"`` + thinking_effort=``"high"``)
    2. If no suffix, try to extract thinking level from body params
    3. Set ``body["model"]`` to the real model name (suffix stripped)
    4. Set ``body["thinking_effort"]`` to the resolved level (if any)

    Raises ``ValueError`` if the model suffix contains an invalid thinking level
    (e.g. ``"model(extreme)"`` -> raises ``ValueError("Invalid thinking level 'extreme'...")``).

    This MUST be called BEFORE model DB lookup / dispatch / permission checks,
    because those use ``body["model"]`` for DB lookup.

    Mutates ``body`` in-place.
    """
    raw_model = body.get("model")
    if not isinstance(raw_model, str) or not raw_model:
        return

    # Step 1: Parse model suffix
    parsed = parse_model_thinking_suffix(raw_model)
    real_model: str = parsed["model"]
    suffix_level: Optional[str] = parsed.get("thinking_level")
    invalid_level: Optional[str] = parsed.get("invalid_level")

    if suffix_level or invalid_level:
        body["model"] = real_model

    # Raise on invalid level suffix
    if invalid_level:
        raise ValueError(
            f'Invalid thinking level "{invalid_level}". '
            "Supported levels: xhigh, high, medium, low, minimal, none"
        )

    # Step 2: Resolve thinking level -- suffix takes priority over body params
    level: Optional[str] = (
        suffix_level if suffix_level else extract_thinking_level(body)
    )

    if level:
        body["thinking_effort"] = level


# ---------------------------------------------------------------------------
# Provider-specific injection
# ---------------------------------------------------------------------------


def inject_for_anthropic(body: dict[str, Any], level: ThinkingLevel) -> None:
    """Inject thinking params into an Anthropic (Claude) request body.

    Maps thinking_effort -> ``thinking: { type: "enabled", budget_tokens: N }``
                          or ``thinking: { type: "disabled" }`` for "none"
    Ensures ``max_tokens > budget_tokens`` (Anthropic requirement).
    """
    if level == "none":
        body["thinking"] = {"type": "disabled"}
        return

    budget_tokens = ANTHROPIC_THINKING_BUDGET[level]
    body["thinking"] = {"type": "enabled", "budget_tokens": budget_tokens}

    # Anthropic requires max_tokens > budget_tokens
    current_max = body.get("max_tokens")
    if not isinstance(current_max, (int, float)):
        current_max = 4096
    if current_max <= budget_tokens:
        body["max_tokens"] = budget_tokens + 8192


def inject_for_openai_chat(body: dict[str, Any], level: ThinkingLevel) -> None:
    """Inject thinking params into an OpenAI Chat Completions request body.

    Maps thinking_effort -> ``reasoning_effort: "high"``
    OpenAI natively supports all 6 levels.
    """
    body["reasoning_effort"] = level


def inject_for_openai_response(body: dict[str, Any], level: ThinkingLevel) -> None:
    """Inject thinking params into an OpenAI Responses API request body.

    Maps thinking_effort -> ``reasoning: { effort: "high" }``
    OpenAI natively supports all 6 levels.
    """
    body["reasoning"] = {"effort": level}


def inject_for_google(body: dict[str, Any], level: ThinkingLevel) -> None:
    """Inject thinking params into a Google Gemini request body.

    Maps thinking_effort -> ``generationConfig.thinkingConfig.thinkingBudget`` (Gemini 2.5)
                         + ``generationConfig.thinkingConfig.thinkingLevel`` (Gemini 3.x)
    """
    if "generationConfig" not in body:
        body["generationConfig"] = {}
    if "thinkingConfig" not in body["generationConfig"]:
        body["generationConfig"]["thinkingConfig"] = {}

    # Set thinkingBudget (for Gemini 2.5 models)
    body["generationConfig"]["thinkingConfig"]["thinkingBudget"] = (
        GOOGLE_THINKING_BUDGET[level]
    )

    # Set thinkingLevel (for Gemini 3.x models) -- skip for 'none'
    thinking_level = GOOGLE_THINKING_LEVEL.get(level)
    if thinking_level:
        body["generationConfig"]["thinkingConfig"]["thinkingLevel"] = thinking_level

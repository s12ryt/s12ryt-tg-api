"""
Unit tests for thinking_parser.py — thinking effort / reasoning intensity feature.

Tests cover:
1. Model suffix parsing: "o3(high)" → {"model": "o3", "thinking_level": "high"}
2. Extract thinking level from body params (reasoning_effort / thinking_effort / anthropic reverse-map)
3. Full preprocess_thinking pipeline (suffix + param resolution + invalid level error)
4. Provider-specific injection: Anthropic, OpenAI Chat, OpenAI Response, Google
5. Edge cases: no level, invalid suffix, max_tokens enforcement, none level, all 6 levels
"""

import os

# Set env vars before any project import (same pattern as other test files)
os.environ.setdefault("BOT_TOKEN", "test-bot-token")
os.environ.setdefault("ADMIN_ID", "123456")
os.environ.setdefault("API_PORT", "8000")
os.environ.setdefault("DATABASE_PATH", "./data/test_bot.db")
os.environ.setdefault("DEFAULT_API_URL", "http://localhost:8000")

import pytest

from api.thinking_parser import (
    parse_model_thinking_suffix,
    extract_thinking_level,
    preprocess_thinking,
    inject_for_anthropic,
    inject_for_openai_chat,
    inject_for_openai_response,
    inject_for_google,
    ANTHROPIC_THINKING_BUDGET,
    GOOGLE_THINKING_BUDGET,
    GOOGLE_THINKING_LEVEL,
)


# ---------------------------------------------------------------------------
# parse_model_thinking_suffix
# ---------------------------------------------------------------------------

class TestParseModelSuffix:
    def test_basic_suffix(self):
        assert parse_model_thinking_suffix("o3(high)") == {"model": "o3", "thinking_level": "high"}

    def test_medium_suffix(self):
        assert parse_model_thinking_suffix("claude-sonnet(medium)") == {"model": "claude-sonnet", "thinking_level": "medium"}

    def test_low_suffix(self):
        assert parse_model_thinking_suffix("gemini-2.5-pro(low)") == {"model": "gemini-2.5-pro", "thinking_level": "low"}

    def test_xhigh_suffix(self):
        assert parse_model_thinking_suffix("o3(xhigh)") == {"model": "o3", "thinking_level": "xhigh"}

    def test_minimal_suffix(self):
        assert parse_model_thinking_suffix("o3(minimal)") == {"model": "o3", "thinking_level": "minimal"}

    def test_none_suffix(self):
        assert parse_model_thinking_suffix("o3(none)") == {"model": "o3", "thinking_level": "none"}

    def test_case_insensitive(self):
        assert parse_model_thinking_suffix("o3(HIGH)") == {"model": "o3", "thinking_level": "high"}
        assert parse_model_thinking_suffix("o3(High)") == {"model": "o3", "thinking_level": "high"}

    def test_whitespace_in_parens(self):
        assert parse_model_thinking_suffix("o3( high )") == {"model": "o3", "thinking_level": "high"}
        assert parse_model_thinking_suffix("o3(  low  )") == {"model": "o3", "thinking_level": "low"}

    def test_no_suffix(self):
        result = parse_model_thinking_suffix("gpt-4o")
        assert result == {"model": "gpt-4o"}

    def test_empty_string(self):
        result = parse_model_thinking_suffix("")
        assert result == {"model": ""}

    def test_model_with_invalid_suffix_level(self):
        """Invalid suffix level is detected and reported."""
        result = parse_model_thinking_suffix("model(custom)")
        assert result["model"] == "model"
        assert result["invalid_level"] == "custom"

    def test_model_with_special_chars(self):
        assert parse_model_thinking_suffix("deepseek-r1(high)") == {"model": "deepseek-r1", "thinking_level": "high"}

    def test_trailing_space_after_parens(self):
        assert parse_model_thinking_suffix("o3(high)  ") == {"model": "o3", "thinking_level": "high"}


# ---------------------------------------------------------------------------
# extract_thinking_level
# ---------------------------------------------------------------------------

class TestExtractThinkingLevel:
    def test_from_reasoning_effort(self):
        assert extract_thinking_level({"reasoning_effort": "high"}) == "high"
        assert extract_thinking_level({"reasoning_effort": "low"}) == "low"

    def test_from_thinking_effort(self):
        assert extract_thinking_level({"thinking_effort": "medium"}) == "medium"

    def test_all_six_levels(self):
        for level in ("xhigh", "high", "medium", "low", "minimal", "none"):
            assert extract_thinking_level({"reasoning_effort": level}) == level

    def test_reasoning_effort_takes_priority(self):
        """reasoning_effort should win over thinking_effort."""
        body = {"reasoning_effort": "high", "thinking_effort": "low"}
        assert extract_thinking_level(body) == "high"

    def test_case_insensitive(self):
        assert extract_thinking_level({"reasoning_effort": "HIGH"}) == "high"

    def test_invalid_level_ignored(self):
        assert extract_thinking_level({"reasoning_effort": "ultra"}) is None
        assert extract_thinking_level({"thinking_effort": "extreme"}) is None

    def test_no_level_present(self):
        assert extract_thinking_level({"model": "gpt-4o"}) is None
        assert extract_thinking_level({}) is None

    def test_anthropic_reverse_map_xhigh(self):
        """Anthropic thinking.budget_tokens ≥ 48000 → xhigh."""
        body = {"thinking": {"type": "enabled", "budget_tokens": 64000}}
        assert extract_thinking_level(body) == "xhigh"

    def test_anthropic_reverse_map_high(self):
        """Anthropic thinking.budget_tokens ≥ 24000 → high."""
        body = {"thinking": {"type": "enabled", "budget_tokens": 32048}}
        assert extract_thinking_level(body) == "high"

    def test_anthropic_reverse_map_medium(self):
        """Anthropic thinking.budget_tokens ≥ 10000 → medium."""
        body = {"thinking": {"type": "enabled", "budget_tokens": 16000}}
        assert extract_thinking_level(body) == "medium"

    def test_anthropic_reverse_map_low(self):
        """Anthropic thinking.budget_tokens ≥ 3000 → low."""
        body = {"thinking": {"type": "enabled", "budget_tokens": 5000}}
        assert extract_thinking_level(body) == "low"

    def test_anthropic_reverse_map_minimal(self):
        """Anthropic thinking.budget_tokens < 3000 → minimal."""
        body = {"thinking": {"type": "enabled", "budget_tokens": 1024}}
        assert extract_thinking_level(body) == "minimal"

    def test_anthropic_disabled_returns_none_level(self):
        """Anthropic thinking.type == disabled → none level."""
        body = {"thinking": {"type": "disabled", "budget_tokens": 32048}}
        assert extract_thinking_level(body) == "none"

    def test_non_string_reasoning_effort(self):
        assert extract_thinking_level({"reasoning_effort": 123}) is None
        assert extract_thinking_level({"reasoning_effort": None}) is None


# ---------------------------------------------------------------------------
# preprocess_thinking
# ---------------------------------------------------------------------------

class TestPreprocessThinking:
    def test_suffix_strips_and_sets_level(self):
        body = {"model": "o3(high)", "messages": []}
        preprocess_thinking(body)
        assert body["model"] == "o3"
        assert body["thinking_effort"] == "high"

    def test_suffix_priority_over_param(self):
        """Model suffix should override body params."""
        body = {"model": "o3(high)", "reasoning_effort": "low"}
        preprocess_thinking(body)
        assert body["model"] == "o3"
        assert body["thinking_effort"] == "high"

    def test_no_suffix_uses_param(self):
        body = {"model": "gpt-4o", "reasoning_effort": "medium"}
        preprocess_thinking(body)
        assert body["model"] == "gpt-4o"
        assert body["thinking_effort"] == "medium"

    def test_no_suffix_no_param(self):
        body = {"model": "gpt-4o"}
        preprocess_thinking(body)
        assert body["model"] == "gpt-4o"
        assert "thinking_effort" not in body

    def test_empty_model(self):
        body = {"model": ""}
        preprocess_thinking(body)
        assert "thinking_effort" not in body

    def test_missing_model(self):
        body = {"messages": []}
        preprocess_thinking(body)
        assert "thinking_effort" not in body

    def test_non_string_model(self):
        body = {"model": 12345}
        preprocess_thinking(body)
        assert "thinking_effort" not in body

    def test_invalid_suffix_raises_error(self):
        """Invalid suffix level should raise ValueError."""
        body = {"model": "o3(extreme)"}
        with pytest.raises(ValueError, match="extreme"):
            preprocess_thinking(body)

    def test_none_level_suffix(self):
        body = {"model": "o3(none)"}
        preprocess_thinking(body)
        assert body["model"] == "o3"
        assert body["thinking_effort"] == "none"


# ---------------------------------------------------------------------------
# inject_for_anthropic
# ---------------------------------------------------------------------------

class TestInjectAnthropic:
    def test_high_level(self):
        body = {"max_tokens": 4096}
        inject_for_anthropic(body, "high")
        assert body["thinking"] == {"type": "enabled", "budget_tokens": ANTHROPIC_THINKING_BUDGET["high"]}

    def test_medium_level(self):
        body = {}
        inject_for_anthropic(body, "medium")
        assert body["thinking"]["budget_tokens"] == ANTHROPIC_THINKING_BUDGET["medium"]

    def test_low_level(self):
        body = {}
        inject_for_anthropic(body, "low")
        assert body["thinking"]["budget_tokens"] == ANTHROPIC_THINKING_BUDGET["low"]

    def test_xhigh_level(self):
        body = {"max_tokens": 128000}
        inject_for_anthropic(body, "xhigh")
        assert body["thinking"]["budget_tokens"] == ANTHROPIC_THINKING_BUDGET["xhigh"]

    def test_minimal_level(self):
        body = {}
        inject_for_anthropic(body, "minimal")
        assert body["thinking"]["budget_tokens"] == ANTHROPIC_THINKING_BUDGET["minimal"]

    def test_none_level(self):
        body = {"max_tokens": 4096}
        inject_for_anthropic(body, "none")
        assert body["thinking"] == {"type": "disabled"}

    def test_max_tokens_raised_if_too_small(self):
        """If max_tokens ≤ budget_tokens, it should be raised."""
        body = {"max_tokens": 100}
        inject_for_anthropic(body, "high")
        budget = ANTHROPIC_THINKING_BUDGET["high"]
        assert body["max_tokens"] > budget

    def test_max_tokens_not_raised_if_sufficient(self):
        """If max_tokens > budget_tokens, it should be unchanged."""
        body = {"max_tokens": 65536}
        inject_for_anthropic(body, "low")
        assert body["max_tokens"] == 65536

    def test_max_tokens_set_if_missing(self):
        """If max_tokens is missing, it should be set."""
        body = {}
        inject_for_anthropic(body, "high")
        assert "max_tokens" in body
        assert body["max_tokens"] > ANTHROPIC_THINKING_BUDGET["high"]


# ---------------------------------------------------------------------------
# inject_for_openai_chat
# ---------------------------------------------------------------------------

class TestInjectOpenAIChat:
    def test_sets_reasoning_effort(self):
        body = {"model": "o3"}
        inject_for_openai_chat(body, "high")
        assert body["reasoning_effort"] == "high"

    def test_medium(self):
        body = {}
        inject_for_openai_chat(body, "medium")
        assert body["reasoning_effort"] == "medium"

    def test_xhigh(self):
        body = {}
        inject_for_openai_chat(body, "xhigh")
        assert body["reasoning_effort"] == "xhigh"

    def test_none(self):
        body = {}
        inject_for_openai_chat(body, "none")
        assert body["reasoning_effort"] == "none"


# ---------------------------------------------------------------------------
# inject_for_openai_response
# ---------------------------------------------------------------------------

class TestInjectOpenAIResponse:
    def test_sets_reasoning_object(self):
        body = {"model": "o3"}
        inject_for_openai_response(body, "high")
        assert body["reasoning"] == {"effort": "high"}

    def test_low(self):
        body = {}
        inject_for_openai_response(body, "low")
        assert body["reasoning"]["effort"] == "low"

    def test_none(self):
        body = {}
        inject_for_openai_response(body, "none")
        assert body["reasoning"] == {"effort": "none"}


# ---------------------------------------------------------------------------
# inject_for_google
# ---------------------------------------------------------------------------

class TestInjectGoogle:
    def test_creates_nested_config(self):
        body = {}
        inject_for_google(body, "high")
        assert body["generationConfig"]["thinkingConfig"]["thinkingBudget"] == GOOGLE_THINKING_BUDGET["high"]

    def test_preserves_existing_config(self):
        body = {"generationConfig": {"temperature": 0.7}}
        inject_for_google(body, "medium")
        assert body["generationConfig"]["temperature"] == 0.7
        assert body["generationConfig"]["thinkingConfig"]["thinkingBudget"] == GOOGLE_THINKING_BUDGET["medium"]

    def test_preserves_existing_thinking_config(self):
        body = {"generationConfig": {"thinkingConfig": {"includeThoughts": True}}}
        inject_for_google(body, "high")
        assert body["generationConfig"]["thinkingConfig"]["includeThoughts"] is True
        assert body["generationConfig"]["thinkingConfig"]["thinkingBudget"] == GOOGLE_THINKING_BUDGET["high"]

    def test_low_budget_is_2048(self):
        """Google low level = 2048 (not 0, that's none)."""
        body = {}
        inject_for_google(body, "low")
        assert body["generationConfig"]["thinkingConfig"]["thinkingBudget"] == GOOGLE_THINKING_BUDGET["low"]
        assert GOOGLE_THINKING_BUDGET["low"] == 2048

    def test_none_budget_is_zero(self):
        """Google none level = 0."""
        body = {}
        inject_for_google(body, "none")
        assert body["generationConfig"]["thinkingConfig"]["thinkingBudget"] == 0

    def test_thinking_level_set(self):
        """Google should set thinkingLevel for levels other than none."""
        body = {}
        inject_for_google(body, "high")
        assert body["generationConfig"]["thinkingConfig"]["thinkingLevel"] == GOOGLE_THINKING_LEVEL["high"]

    def test_none_no_thinking_level(self):
        """Google none level should not set thinkingLevel."""
        body = {}
        inject_for_google(body, "none")
        assert "thinkingLevel" not in body.get("generationConfig", {}).get("thinkingConfig", {})


# ---------------------------------------------------------------------------
# Budget value sanity checks
# ---------------------------------------------------------------------------

class TestBudgetValues:
    def test_anthropic_budget_ordering(self):
        levels = ["xhigh", "high", "medium", "low", "minimal"]
        for i in range(len(levels) - 1):
            assert ANTHROPIC_THINKING_BUDGET[levels[i]] > ANTHROPIC_THINKING_BUDGET[levels[i + 1]]

    def test_google_budget_ordering(self):
        levels = ["xhigh", "high", "medium", "low", "minimal", "none"]
        for i in range(len(levels) - 1):
            assert GOOGLE_THINKING_BUDGET[levels[i]] > GOOGLE_THINKING_BUDGET[levels[i + 1]]

    def test_google_thinking_level_dict(self):
        assert GOOGLE_THINKING_LEVEL["xhigh"] == "high"
        assert GOOGLE_THINKING_LEVEL["high"] == "high"
        assert GOOGLE_THINKING_LEVEL["medium"] == "medium"
        assert GOOGLE_THINKING_LEVEL["low"] == "low"
        assert GOOGLE_THINKING_LEVEL["minimal"] == "minimal"
        assert "none" not in GOOGLE_THINKING_LEVEL

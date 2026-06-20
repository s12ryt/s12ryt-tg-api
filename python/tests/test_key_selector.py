"""
Tests for api/key_selector.py — Multi API-Key Selector with Circuit Breaker.

Covers:
  - parse_api_keys (JSON array / legacy single / empty / invalid)
  - select_key (first available / skip suspended / all-suspended fallback)
  - Circuit Breaker (3 consecutive failures → 60s suspension → auto-recovery)
  - report_success / report_failure
  - get_key_status / get_first_key
"""

import json
import time
import pytest

from api.key_selector import (
    parse_api_keys,
    select_key,
    report_success,
    report_failure,
    get_key_status,
    get_first_key,
    MAX_CONSECUTIVE_FAILURES,
    SUSPEND_DURATION_SECONDS,
)


# ── Fixtures ────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def _reset_state():
    """Clear in-memory state before each test."""
    import api.key_selector as ks
    ks._state.clear()
    yield
    ks._state.clear()


# ── Constants ───────────────────────────────────────────────────

class TestConstants:
    def test_threshold_matches_docs(self):
        assert MAX_CONSECUTIVE_FAILURES == 3

    def test_suspend_duration_matches_docs(self):
        assert SUSPEND_DURATION_SECONDS == 60


# ── parse_api_keys ──────────────────────────────────────────────

class TestParseApiKeys:
    def test_json_array(self):
        raw = json.dumps(["key1", "key2", "key3"])
        assert parse_api_keys(raw) == ["key1", "key2", "key3"]

    def test_single_key_legacy(self):
        assert parse_api_keys("sk-legacy-key") == ["sk-legacy-key"]

    def test_empty_string(self):
        assert parse_api_keys("") == []

    def test_none_input(self):
        assert parse_api_keys(None) == []

    def test_invalid_json_fallback_to_legacy(self):
        assert parse_api_keys("not-json-at-all") == ["not-json-at-all"]

    def test_strips_whitespace(self):
        raw = json.dumps(["  key1  ", "  key2  "])
        assert parse_api_keys(raw) == ["key1", "key2"]

    def test_filters_empty_strings(self):
        raw = json.dumps(["key1", "", "  ", "key2"])
        assert parse_api_keys(raw) == ["key1", "key2"]

    def test_filters_non_string_items(self):
        raw = json.dumps(["key1", 123, True, "key2"])
        assert parse_api_keys(raw) == ["key1", "key2"]


# ── select_key ──────────────────────────────────────────────────

class TestSelectKey:
    KEYS_JSON = json.dumps(["key-a", "key-b", "key-c"])

    def test_selects_first_key(self):
        key, idx = select_key(1, self.KEYS_JSON)
        assert key == "key-a"
        assert idx == 0

    def test_empty_keys_returns_none(self):
        key, idx = select_key(1, json.dumps([]))
        assert key is None
        assert idx is None

    def test_skips_suspended_key(self):
        """After 3 failures on key 0, select_key should pick key 1."""
        for _ in range(MAX_CONSECUTIVE_FAILURES):
            report_failure(1, 0)
        key, idx = select_key(1, self.KEYS_JSON)
        assert key == "key-b"
        assert idx == 1

    def test_all_suspended_returns_soonest(self):
        """When all keys are suspended, returns the one recovering soonest."""
        # Suspend all keys at slightly different times
        report_failure(1, 0)
        report_failure(1, 0)
        report_failure(1, 0)  # key 0 suspended now
        report_failure(1, 1)
        report_failure(1, 1)
        report_failure(1, 1)  # key 1 suspended slightly later
        report_failure(1, 2)
        report_failure(1, 2)
        report_failure(1, 2)  # key 2 suspended latest
        key, idx = select_key(1, self.KEYS_JSON)
        # Key 0 was suspended first → recovers soonest → forced recovery
        assert key == "key-a"
        assert idx == 0


# ── Circuit Breaker ─────────────────────────────────────────────

class TestCircuitBreaker:
    KEYS_JSON = json.dumps(["key-a", "key-b"])

    def test_failures_below_threshold_not_suspended(self):
        """2 failures < 3 threshold → key still active."""
        report_failure(1, 0)
        report_failure(1, 0)
        key, idx = select_key(1, self.KEYS_JSON)
        assert idx == 0  # still selects key 0
        assert key == "key-a"

    def test_threshold_triggers_suspension(self):
        """3 consecutive failures → key suspended → selects next."""
        for _ in range(MAX_CONSECUTIVE_FAILURES):
            report_failure(1, 0)
        key, idx = select_key(1, self.KEYS_JSON)
        assert idx == 1  # switched to key 1

    def test_report_success_resets_count(self):
        """Success resets fail count, preventing suspension."""
        report_failure(1, 0)
        report_failure(1, 0)
        report_success(1, 0)
        # Now fail twice more — should NOT trigger suspension (count was reset)
        report_failure(1, 0)
        report_failure(1, 0)
        key, idx = select_key(1, self.KEYS_JSON)
        assert idx == 0  # still key 0, not suspended

    def test_independent_provider_state(self):
        """Failures on provider A don't affect provider B."""
        for _ in range(MAX_CONSECUTIVE_FAILURES):
            report_failure(1, 0)  # provider 1, key 0 suspended
        # Provider 2 unaffected
        key, idx = select_key(2, self.KEYS_JSON)
        assert idx == 0

    def test_independent_key_index_state(self):
        """Failures on key 0 don't affect key 1."""
        for _ in range(MAX_CONSECUTIVE_FAILURES):
            report_failure(1, 0)
        # Key 1 should have zero failures
        status = get_key_status(1, self.KEYS_JSON)
        assert status[0]["fail_count"] == MAX_CONSECUTIVE_FAILURES
        assert status[0]["is_suspended"] is True
        assert status[1]["fail_count"] == 0
        assert status[1]["is_suspended"] is False

    def test_suspension_recovery_after_expiry(self, monkeypatch):
        """After SUSPEND_DURATION_SECONDS, key auto-recovers."""
        base_time = time.time()
        monkeypatch.setattr("api.key_selector.time.time", lambda: base_time)

        # Trigger suspension
        for _ in range(MAX_CONSECUTIVE_FAILURES):
            report_failure(1, 0)

        # Still suspended at base_time
        status = get_key_status(1, self.KEYS_JSON)
        assert status[0]["is_suspended"] is True

        # Advance time past suspension
        monkeypatch.setattr("api.key_selector.time.time", lambda: base_time + SUSPEND_DURATION_SECONDS + 1)
        key, idx = select_key(1, self.KEYS_JSON)
        assert idx == 0  # recovered, selects key 0 again
        assert key == "key-a"

    def test_suspension_duration_set_correctly(self, monkeypatch):
        """Verify suspended_until is exactly now + SUSPEND_DURATION_SECONDS."""
        base_time = 1_000_000.0
        monkeypatch.setattr("api.key_selector.time.time", lambda: base_time)

        for _ in range(MAX_CONSECUTIVE_FAILURES):
            report_failure(1, 0)

        status = get_key_status(1, self.KEYS_JSON)
        assert status[0]["suspended_until"] == pytest.approx(
            base_time + SUSPEND_DURATION_SECONDS
        )


# ── get_key_status ──────────────────────────────────────────────

class TestGetKeyStatus:
    KEYS_JSON = json.dumps(["key-a", "key-b"])

    def test_clean_state(self):
        status = get_key_status(1, self.KEYS_JSON)
        assert len(status) == 2
        assert all(s["fail_count"] == 0 for s in status)
        assert all(s["is_suspended"] is False for s in status)
        assert all(s["suspended_until"] is None for s in status)

    def test_key_prefix_truncation(self):
        status = get_key_status(1, json.dumps(["very-long-key-name"]))
        assert status[0]["key_prefix"] == "very-lon..."

    def test_short_key_not_truncated(self):
        status = get_key_status(1, json.dumps(["short"]))
        assert status[0]["key_prefix"] == "short"

    def test_index_values(self):
        status = get_key_status(1, self.KEYS_JSON)
        assert status[0]["index"] == 0
        assert status[1]["index"] == 1


# ── get_first_key ───────────────────────────────────────────────

class TestGetFirstKey:
    def test_returns_first(self):
        assert get_first_key(json.dumps(["key-a", "key-b"])) == "key-a"

    def test_empty_returns_empty_string(self):
        assert get_first_key(json.dumps([])) == ""

    def test_legacy_single_key(self):
        assert get_first_key("legacy-key") == "legacy-key"

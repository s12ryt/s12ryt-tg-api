"""
Multi API-Key Selector with Failover Tracking

Storage format in DB: providers.api_key stores JSON array string
  e.g. '["sk-xxx1","sk-xxx2","sk-xxx3"]'
  Legacy single key: "sk-xxx1" (auto-migrated on startup)

Selection strategy:
  - Pick first non-suspended key
  - Track consecutive failures per (provider_id, key_index)
  - After 3 consecutive failures → suspend for 60 seconds
  - On success → reset fail count
"""

import json
import time
import random
import threading
from typing import Optional


# ── Configuration ──────────────────────────────────────────────
MAX_CONSECUTIVE_FAILURES = 3
SUSPEND_DURATION_SECONDS = 60  # 60 seconds


# ── In-memory state ────────────────────────────────────────────
# { provider_id: { key_index: (fail_count, suspended_until_timestamp) } }
_lock = threading.Lock()
_state: dict[int, dict[int, tuple[int, float]]] = {}
_round_robin_index: dict[int, int] = {}


# ── Public API ─────────────────────────────────────────────────

def parse_api_keys(api_key_json: str) -> list[str]:
    """Parse api_key field into list of keys.
    
    Accepts:
      - JSON array string: '["k1","k2"]'
      - Legacy single string: "k1" (wrapped into ["k1"])
    Returns list of non-empty key strings.
    """
    if not api_key_json:
        return []
    try:
        parsed = json.loads(api_key_json)
        if isinstance(parsed, list):
            return [k.strip() for k in parsed if isinstance(k, str) and k.strip()]
    except (json.JSONDecodeError, TypeError):
        pass
    # Legacy single key
    key = api_key_json.strip()
    return [key] if key else []


def select_key(
    provider_id: int, api_key_json: str, strategy: str = "failover"
) -> tuple[Optional[str], Optional[int]]:
    """Select the best available API key for a provider.

    Args:
        provider_id: Provider ID for state tracking
        api_key_json: JSON array string of keys (or legacy single key)
        strategy: Selection strategy — 'failover' (first available),
                  'round_robin' (rotate cursor), 'random' (random pick)

    Returns:
        (selected_key, key_index) or (None, None) if no keys available
    """
    keys = parse_api_keys(api_key_json)
    if not keys:
        return None, None

    now = time.time()
    num_keys = len(keys)

    with _lock:
        provider_state = _state.get(provider_id, {})

        # Build iteration order based on strategy
        if strategy == "round_robin":
            cursor = _round_robin_index.get(provider_id, 0)
            order = [(cursor + i) % num_keys for i in range(num_keys)]
            _round_robin_index[provider_id] = (cursor + 1) % num_keys
        elif strategy == "random":
            order = list(range(num_keys))
            random.shuffle(order)
        else:  # failover (default)
            order = list(range(num_keys))

        # Try keys in determined order, skip suspended ones
        for idx in order:
            key = keys[idx]
            fail_count, suspended_until = provider_state.get(idx, (0, 0.0))

            # Check if suspension has expired
            if suspended_until > 0 and now >= suspended_until:
                # Auto-recover: reset fail count
                provider_state[idx] = (0, 0.0)
                _state[provider_id] = provider_state
                return key, idx

            # Not suspended
            if suspended_until <= 0:
                return key, idx

        # All keys suspended — use the one that recovers soonest
        soonest_idx = None
        soonest_time = float("inf")
        for idx in range(num_keys):
            _, suspended_until = provider_state.get(idx, (0, 0.0))
            if suspended_until < soonest_time:
                soonest_time = suspended_until
                soonest_idx = idx

        if soonest_idx is not None:
            # Force recover the soonest one
            provider_state[soonest_idx] = (0, 0.0)
            _state[provider_id] = provider_state
            return keys[soonest_idx], soonest_idx

        # Fallback: return first key
        return keys[0], 0


def report_success(provider_id: int, key_index: int) -> None:
    """Report a successful API call — reset fail count."""
    with _lock:
        provider_state = _state.get(provider_id, {})
        if key_index in provider_state:
            provider_state[key_index] = (0, 0.0)
            _state[provider_id] = provider_state


def report_failure(provider_id: int, key_index: int) -> None:
    """Report a failed API call — increment fail count, suspend if threshold reached."""
    with _lock:
        provider_state = _state.setdefault(provider_id, {})
        fail_count, suspended_until = provider_state.get(key_index, (0, 0.0))
        
        fail_count += 1
        
        if fail_count >= MAX_CONSECUTIVE_FAILURES:
            # Suspend this key
            suspended_until = time.time() + SUSPEND_DURATION_SECONDS
            provider_state[key_index] = (fail_count, suspended_until)
        else:
            provider_state[key_index] = (fail_count, suspended_until)
        
        _state[provider_id] = provider_state


def get_key_status(provider_id: int, api_key_json: str) -> list[dict]:
    """Get status of all keys for display purposes.
    
    Returns list of dicts:
        [{index, key_prefix, fail_count, is_suspended, suspended_until}, ...]
    """
    keys = parse_api_keys(api_key_json)
    now = time.time()
    
    with _lock:
        provider_state = _state.get(provider_id, {})
        
        result = []
        for idx, key in enumerate(keys):
            fail_count, suspended_until = provider_state.get(idx, (0, 0.0))
            is_suspended = suspended_until > now
            
            result.append({
                "index": idx,
                "key_prefix": key[:8] + "..." if len(key) > 8 else key,
                "fail_count": fail_count,
                "is_suspended": is_suspended,
                "suspended_until": suspended_until if is_suspended else None,
            })
        
        return result


def clear_provider_key_state(provider_id: int) -> None:
    """Remove all in-memory state for a provider.

    Called when a provider is deleted to prevent orphaned entries in
    _state and _round_robin_index from accumulating (memory leak).
    """
    with _lock:
        _state.pop(provider_id, None)
        _round_robin_index.pop(provider_id, None)


def get_first_key(api_key_json: str) -> str:
    """Get the first API key from JSON string (for model fetching, detection, etc).
    
    Returns empty string if no keys.
    """
    keys = parse_api_keys(api_key_json)
    return keys[0] if keys else ""

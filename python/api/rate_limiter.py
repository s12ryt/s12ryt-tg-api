"""
Rate limiting and concurrency control middleware for FastAPI.

Implements:
1. RPM (Requests Per Minute) — sliding window in-memory counter
2. TPM (Tokens Per Minute) — sliding window with token counts
3. Concurrency — in-memory active request counter

Admin users bypass all limits.
A limit value of 0 means unlimited.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import defaultdict
from typing import Any

from fastapi import Request, Response
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint

from config import Config

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# In-memory tracking structures
# ---------------------------------------------------------------------------

# key -> list of request timestamps (monotonic) within the last 60 seconds
_rpm_windows: dict[str, list[float]] = defaultdict(list)

# key -> list of (timestamp, tokens) within the last 60 seconds
_tpm_windows: dict[str, list[tuple[float, int]]] = defaultdict(list)

# key -> current active request count
_concurrency_counts: dict[str, int] = defaultdict(int)

_WINDOW_SECONDS = 60.0


def _limiter_key(user_id: int, api_key_id: int) -> str:
    return f"{user_id}:{api_key_id}"


def _prune_rpm_window(key: str, now: float) -> list[float]:
    cutoff = now - _WINDOW_SECONDS
    timestamps = _rpm_windows.get(key, [])
    recent = [t for t in timestamps if t > cutoff]
    if recent:
        _rpm_windows[key] = recent
    else:
        _rpm_windows.pop(key, None)
    return recent


def _prune_tpm_window(key: str, now: float) -> list[tuple[float, int]]:
    cutoff = now - _WINDOW_SECONDS
    entries = _tpm_windows.get(key, [])
    recent = [(t, tok) for t, tok in entries if t > cutoff]
    if recent:
        _tpm_windows[key] = recent
    else:
        _tpm_windows.pop(key, None)
    return recent


def record_token_usage(user_id: int, api_key_id: int, tokens: int) -> None:
    """Record token usage for a request.

    Should be called by server.py after the response completes
    (when token counts are known).
    """
    if tokens <= 0:
        return
    key = _limiter_key(user_id, api_key_id)
    now = time.monotonic()
    _tpm_windows[key].append((now, tokens))


def _release_concurrency(key: str) -> None:
    current = _concurrency_counts.get(key, 0)
    if current > 0:
        _concurrency_counts[key] = current - 1
    if current <= 1:
        _concurrency_counts.pop(key, None)


# ---------------------------------------------------------------------------
# Periodic cleanup (every 2 minutes)
# ---------------------------------------------------------------------------

_cleanup_started = False


def _start_cleanup() -> None:
    global _cleanup_started
    if _cleanup_started:
        return
    _cleanup_started = True

    async def _cleanup_loop():
        while True:
            await asyncio.sleep(120)
            now = time.monotonic()
            for key in list(_rpm_windows.keys()):
                _prune_rpm_window(key, now)
            for key in list(_tpm_windows.keys()):
                _prune_tpm_window(key, now)

    try:
        loop = asyncio.get_running_loop()
        loop.create_task(_cleanup_loop())
    except RuntimeError:
        pass


# ---------------------------------------------------------------------------
# Middleware
# ---------------------------------------------------------------------------

class RateLimitMiddleware(BaseHTTPMiddleware):
    """Rate limiting, concurrency control, and expiry checking middleware."""

    PUBLIC_PATHS: set[str] = {"/", "/health", "/docs", "/openapi.json", "/redoc"}

    async def dispatch(
        self, request: Request, call_next: RequestResponseEndpoint
    ) -> Response:
        _start_cleanup()

        # Skip for public paths
        if request.url.path in self.PUBLIC_PATHS or request.method == "OPTIONS":
            return await call_next(request)

        user_id = getattr(request.state, "user_id", None)
        api_key_id = getattr(request.state, "api_key_id", None)

        # No auth info → auth middleware hasn't attached user → skip
        if not user_id or not api_key_id:
            return await call_next(request)

        # Admin bypasses all rate limits (no DB query needed — tg_user_id cached in middleware)
        tg_user_id = getattr(request.state, "tg_user_id", None)
        if tg_user_id is not None and tg_user_id == Config.ADMIN_ID:
            return await call_next(request)

        # Get effective limits
        from db.database import get_effective_limits, is_expired
        try:
            limits = await get_effective_limits(user_id, api_key_id)
        except Exception:
            logger.exception("[rate_limiter] Failed to get effective limits")
            return await call_next(request)

        # Share limits with quota_checker to avoid duplicate DB query
        request.state.effective_limits = limits

        # --- Check expiry ---
        if limits.get("expires_at"):
            if is_expired(limits["expires_at"]):
                return JSONResponse(
                    status_code=403,
                    content={
                        "error": {
                            "message": "Your access has expired. Please contact the administrator.",
                            "type": "expired_access",
                            "code": "access_expired",
                            "expired_at": limits["expires_at"],
                        }
                    },
                )

        key = _limiter_key(user_id, api_key_id)
        now = time.monotonic()

        # --- Check RPM ---
        rpm_limit = limits["rpm"]
        if rpm_limit > 0:
            recent = _prune_rpm_window(key, now)
            if len(recent) >= rpm_limit:
                oldest = recent[0]
                retry_after = int(oldest + _WINDOW_SECONDS - now) + 1
                return JSONResponse(
                    status_code=429,
                    content={
                        "error": {
                            "message": f"Rate limit exceeded: {rpm_limit} requests per minute. Retry after {retry_after}s.",
                            "type": "rate_limit_error",
                            "code": "rpm_exceeded",
                            "retry_after": retry_after,
                        }
                    },
                )
            recent.append(now)
            _rpm_windows[key] = recent

        # --- Check TPM (current window tokens) ---
        tpm_limit = limits["tpm"]
        if tpm_limit > 0:
            entries = _prune_tpm_window(key, now)
            current_tokens = sum(tok for _, tok in entries)
            if current_tokens >= tpm_limit:
                return JSONResponse(
                    status_code=429,
                    content={
                        "error": {
                            "message": f"Token rate limit exceeded: {tpm_limit} tokens per minute. Please slow down.",
                            "type": "rate_limit_error",
                            "code": "tpm_exceeded",
                        }
                    },
                )

        # --- Check concurrency ---
        concurrency_limit = limits["concurrency"]
        if concurrency_limit > 0:
            current = _concurrency_counts.get(key, 0)
            if current >= concurrency_limit:
                return JSONResponse(
                    status_code=429,
                    content={
                        "error": {
                            "message": f"Concurrency limit exceeded: {concurrency_limit} simultaneous requests. Please retry shortly.",
                            "type": "rate_limit_error",
                            "code": "concurrency_exceeded",
                            "retry_after": 5,
                        }
                    },
                )
            _concurrency_counts[key] = current + 1

            # Release concurrency after the response completes
            async def _call_next_and_release():
                try:
                    return await call_next(request)
                finally:
                    _release_concurrency(key)

            return await _call_next_and_release()

        return await call_next(request)

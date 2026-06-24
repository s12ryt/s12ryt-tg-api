"""
Quota checking middleware for FastAPI.

Checks daily/monthly token and cost quotas.
Admin users bypass all quotas.
A quota limit of 0 means unlimited.

Check order: daily token → monthly token → daily cost → monthly cost.
"""

from __future__ import annotations

import logging

from fastapi import Request, Response
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint

from config import Config

logger = logging.getLogger(__name__)


class QuotaCheckMiddleware(BaseHTTPMiddleware):
    """Daily/monthly token and cost quota checking middleware."""

    PUBLIC_PATHS: set[str] = {"/", "/health", "/docs", "/openapi.json", "/redoc"}

    async def dispatch(
        self, request: Request, call_next: RequestResponseEndpoint
    ) -> Response:
        if request.url.path in self.PUBLIC_PATHS or request.method == "OPTIONS":
            return await call_next(request)

        user_id = getattr(request.state, "user_id", None)
        api_key_id = getattr(request.state, "api_key_id", None)

        if not user_id or not api_key_id:
            return await call_next(request)

        # Admin bypasses all quotas (no DB query needed — tg_user_id cached in middleware)
        tg_user_id = getattr(request.state, "tg_user_id", None)
        if tg_user_id is not None and tg_user_id == Config.ADMIN_ID:
            return await call_next(request)

        from db.database import get_effective_limits, get_daily_usage, get_monthly_usage

        # Reuse effective_limits from rate_limiter if available (avoids duplicate DB query)
        limits = getattr(request.state, "effective_limits", None)
        if limits is None:
            try:
                limits = await get_effective_limits(user_id, api_key_id)
            except Exception:
                logger.exception("[quota_checker] Failed to get effective limits")
                return await call_next(request)

        # Only query usage when relevant limits are set (> 0 means limited)
        need_daily = limits["daily_token_limit"] > 0 or limits["daily_cost_limit"] > 0
        need_monthly = limits["monthly_token_limit"] > 0 or limits["monthly_cost_limit"] > 0
        daily = await get_daily_usage(user_id, api_key_id) if need_daily else {"total_tokens": 0, "total_cost": 0.0}
        monthly = await get_monthly_usage(user_id, api_key_id) if need_monthly else {"total_tokens": 0, "total_cost": 0.0}

        # --- Daily token quota ---
        daily_token_limit = limits["daily_token_limit"]
        if daily_token_limit > 0 and daily["total_tokens"] >= daily_token_limit:
            return JSONResponse(
                status_code=429,
                content={
                    "error": {
                        "message": f"Daily token quota exceeded: {daily['total_tokens']}/{daily_token_limit} tokens used today.",
                        "type": "quota_error",
                        "code": "daily_token_exceeded",
                        "used": daily["total_tokens"],
                        "limit": daily_token_limit,
                    }
                },
            )

        # --- Monthly token quota ---
        monthly_token_limit = limits["monthly_token_limit"]
        if monthly_token_limit > 0 and monthly["total_tokens"] >= monthly_token_limit:
            return JSONResponse(
                status_code=429,
                content={
                    "error": {
                        "message": f"Monthly token quota exceeded: {monthly['total_tokens']}/{monthly_token_limit} tokens used this month.",
                        "type": "quota_error",
                        "code": "monthly_token_exceeded",
                        "used": monthly["total_tokens"],
                        "limit": monthly_token_limit,
                    }
                },
            )

        # --- Daily cost quota ---
        daily_cost_limit = limits["daily_cost_limit"]
        if daily_cost_limit > 0 and daily["total_cost"] >= daily_cost_limit:
            return JSONResponse(
                status_code=429,
                content={
                    "error": {
                        "message": f"Daily cost quota exceeded: ${daily['total_cost']:.4f}/${daily_cost_limit:.4f} used today.",
                        "type": "quota_error",
                        "code": "daily_cost_exceeded",
                        "used": daily["total_cost"],
                        "limit": daily_cost_limit,
                    }
                },
            )

        # --- Monthly cost quota ---
        monthly_cost_limit = limits["monthly_cost_limit"]
        if monthly_cost_limit > 0 and monthly["total_cost"] >= monthly_cost_limit:
            return JSONResponse(
                status_code=429,
                content={
                    "error": {
                        "message": f"Monthly cost quota exceeded: ${monthly['total_cost']:.4f}/${monthly_cost_limit:.4f} used this month.",
                        "type": "quota_error",
                        "code": "monthly_cost_exceeded",
                        "used": monthly["total_cost"],
                        "limit": monthly_cost_limit,
                    }
                },
            )

        return await call_next(request)

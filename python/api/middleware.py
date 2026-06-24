"""
API Key authentication middleware for FastAPI.

Validates Bearer tokens with format "sk-s12ryt-..." against the database.
"""

from __future__ import annotations

import logging
from typing import Any, Callable

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint

logger = logging.getLogger(__name__)

KEY_PREFIX = "sk-s12ryt-"


# ---------------------------------------------------------------------------
# Database lookup with LRU cache
# ---------------------------------------------------------------------------

async def _lookup_api_key(key: str) -> dict[str, Any] | None:
    """Look up an API key in the database with LRU cache.

    Returns a dict with at least ``{"user_id", "api_key_id"}``
    or ``None`` when the key does not exist.
    """
    from db.database import lookup_api_key_cached
    return await lookup_api_key_cached(key)


# ---------------------------------------------------------------------------
# Middleware
# ---------------------------------------------------------------------------

class AuthMiddleware(BaseHTTPMiddleware):
    """Validate ``Authorization: Bearer sk-s12ryt-...`` on protected routes."""

    # Paths that skip authentication.
    PUBLIC_PATHS: set[str] = {"/", "/health", "/docs", "/openapi.json", "/redoc"}

    async def dispatch(
        self, request: Request, call_next: RequestResponseEndpoint
    ) -> Response:
        # Skip auth for public paths and preflight requests.
        if request.url.path in self.PUBLIC_PATHS or request.method == "OPTIONS":
            return await call_next(request)

        auth_header = request.headers.get("Authorization", "")

        if not auth_header:
            return JSONResponse(
                status_code=401,
                content={"error": {"message": "Missing Authorization header", "type": "auth_error"}},
            )

        # Expect "Bearer <token>"
        parts = auth_header.split(" ", 1)
        if len(parts) != 2 or parts[0].lower() != "bearer":
            return JSONResponse(
                status_code=401,
                content={"error": {"message": "Invalid Authorization header format", "type": "auth_error"}},
            )

        token = parts[1].strip()

        # Validate prefix
        if not token.startswith(KEY_PREFIX):
            return JSONResponse(
                status_code=401,
                content={"error": {"message": "Invalid API key format", "type": "auth_error"}},
            )

        # Look up in database
        key_info = await _lookup_api_key(token)
        if key_info is None:
            return JSONResponse(
                status_code=401,
                content={"error": {"message": "Invalid or inactive API key", "type": "auth_error"}},
            )

        # Attach user info to request state for downstream handlers.
        request.state.user_id = key_info["user_id"]
        request.state.api_key_id = key_info["api_key_id"]
        request.state.tg_user_id = key_info.get("tg_user_id")

        return await call_next(request)


# ---------------------------------------------------------------------------
# Convenience: dependency injection version (alternative to middleware)
# ---------------------------------------------------------------------------

async def require_auth(request: Request) -> dict[str, Any]:
    """FastAPI dependency that validates the Bearer token.

    Use with ``Depends(require_auth)`` on individual routes.
    """
    auth_header = request.headers.get("Authorization", "")

    if not auth_header:
        raise _auth_error("Missing Authorization header")

    parts = auth_header.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise _auth_error("Invalid Authorization header format")

    token = parts[1].strip()

    if not token.startswith(KEY_PREFIX):
        raise _auth_error("Invalid API key format")

    key_info = await _lookup_api_key(token)
    if key_info is None:
        raise _auth_error("Invalid or inactive API key")

    request.state.user_id = key_info["user_id"]
    request.state.api_key_id = key_info["api_key_id"]

    return key_info


def _auth_error(message: str):
    from fastapi import HTTPException
    return HTTPException(
        status_code=401,
        detail={"error": {"message": message, "type": "auth_error"}},
    )

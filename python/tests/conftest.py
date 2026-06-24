"""
Shared pytest fixtures for all test modules.
Uses a temporary SQLite database for each test to ensure isolation.
"""

import os

import aiosqlite
import pytest
import pytest_asyncio

# IMPORTANT: Set safe env vars BEFORE any project imports, because
# .env may contain non-numeric ADMIN_ID that crashes config.py at import time.
os.environ.setdefault("BOT_TOKEN", "test-bot-token")
os.environ.setdefault("ADMIN_ID", "123456")
os.environ.setdefault("API_PORT", "8000")
os.environ.setdefault("DATABASE_PATH", "./data/test_bot.db")
os.environ.setdefault("DEFAULT_API_URL", "http://localhost:8000")

# Patch aiosqlite.Connection.__aenter__ to avoid the thread-reuse bug.
#
# aiosqlite 0.20+ Connection.__aenter__ does `return await self`,
# which calls __await__, which calls self._thread.start().
# But if the connection was already obtained via `await aiosqlite.connect(...)`
# (which also calls __await__), the thread is already started, causing:
#   RuntimeError: threads can only be started once
#
# Fix: make __aenter__ return self directly if the worker thread is
# already running (meaning the connection was already awaited).
# For the `async with aiosqlite.connect(...)` case (no prior await),
# thread is NOT alive yet, so we call `await self` to start it normally.

_original_aenter = aiosqlite.core.Connection.__aenter__


async def _safe_aenter(self):
    try:
        if self._thread.is_alive():
            return self
    except RuntimeError:
        pass
    # Thread not started yet — start it via original __aenter__
    return await _original_aenter(self)


aiosqlite.core.Connection.__aenter__ = _safe_aenter

# Now safe to import
from db import database  # noqa: E402


@pytest.fixture(autouse=True)
def _isolate_db_path(tmp_path, monkeypatch):
    """Override Config.DATABASE_PATH to use a temp file for every test."""
    db_file = str(tmp_path / "test.db")
    monkeypatch.setattr(database.Config, "DATABASE_PATH", db_file)
    # Clear module-level caches so stale entries from prior tests
    # don't bleed into this test's fresh database.
    database._usage_queue.clear()
    database._effective_limits_cache.clear()
    return db_file


@pytest_asyncio.fixture
async def db_conn(_isolate_db_path):
    """Return the path to an initialised temp database."""
    await database.init_db()
    return _isolate_db_path

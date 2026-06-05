from __future__ import annotations

import asyncio
import logging
import os
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Optional

import aiosqlite
import uuid_utils

from config import Config
from db.models import ALL_TABLES

logger = logging.getLogger(__name__)


# ============================================================
# LRU Cache
# ============================================================

class LRUCache[K, V]:
    """Simple LRU cache with max size."""

    def __init__(self, maxsize: int = 256) -> None:
        self._cache: OrderedDict[K, V] = OrderedDict()
        self._maxsize = maxsize

    def get(self, key: K) -> Optional[V]:
        if key in self._cache:
            self._cache.move_to_end(key)
            return self._cache[key]
        return None

    def put(self, key: K, value: V) -> None:
        if key in self._cache:
            self._cache.move_to_end(key)
            self._cache[key] = value
        else:
            self._cache[key] = value
            if len(self._cache) > self._maxsize:
                self._cache.popitem(last=False)

    def invalidate(self, key: K) -> None:
        self._cache.pop(key, None)

    def clear(self) -> None:
        self._cache.clear()


# ============================================================
# Provider routing cache
# ============================================================

@dataclass
class CachedProvider:
    """Cached provider info for fast model routing."""
    provider_type: str
    provider_id: int
    base_url: str
    api_key: str
    input_price: Optional[float]
    output_price: Optional[float]


# model_name -> CachedProvider
_provider_cache: dict[str, CachedProvider] = {}
_cache_rebuild_scheduled: bool = False


def get_provider_cache() -> dict[str, CachedProvider]:
    """Get the current provider routing cache (read-only for callers)."""
    return _provider_cache


async def rebuild_provider_cache() -> None:
    """Rebuild the provider routing cache from DB.

    Called on init and after any provider mutation.
    """
    global _provider_cache
    providers = await get_providers(enabled_only=True)
    cache: dict[str, CachedProvider] = {}

    for p in providers:
        models = [m.strip() for m in (p.get("models") or "").split(",") if m.strip()]
        for model_name in models:
            cache[model_name] = CachedProvider(
                provider_type=p["api_type"],
                provider_id=p["id"],
                base_url=p["base_url"],
                api_key=p["api_key"],
                input_price=p.get("input_price"),
                output_price=p.get("output_price"),
            )

    _provider_cache = cache
    logger.debug("Provider cache rebuilt: %d models", len(cache))

    # Notify listeners
    for cb in _on_cache_rebuild_callbacks:
        try:
            cb()
        except Exception:
            pass


_on_cache_rebuild_callbacks: list[Any] = field(default_factory=list)


def on_provider_cache_rebuild(callback) -> None:
    """Register a callback invoked after provider cache is rebuilt."""
    _on_cache_rebuild_callbacks.append(callback)


def invalidate_provider_cache() -> None:
    """Mark cache dirty and schedule a rebuild via asyncio."""
    global _cache_rebuild_scheduled
    if _cache_rebuild_scheduled:
        return
    _cache_rebuild_scheduled = True

    async def _do_rebuild():
        global _cache_rebuild_scheduled
        await rebuild_provider_cache()
        _cache_rebuild_scheduled = False

    try:
        loop = asyncio.get_running_loop()
        loop.call_soon(lambda: asyncio.ensure_future(_do_rebuild()))
    except RuntimeError:
        pass


# ============================================================
# API Key cache
# ============================================================

_api_key_cache: LRUCache[str, Optional[dict]] = LRUCache(maxsize=256)


async def lookup_api_key_cached(key: str) -> Optional[dict]:
    """Look up API key with LRU cache.

    Returns dict with {user_id, api_key_id} or None.
    """
    cached = _api_key_cache.get(key)
    if cached is not None:
        return cached

    # DB lookup
    key_record = await get_key_by_value(key)
    if not key_record or not key_record.get("is_active"):
        _api_key_cache.put(key, None)
        return None

    # Check user is active
    user = await get_user_by_id(key_record["user_id"])
    if not user or not user.get("is_active"):
        _api_key_cache.put(key, None)
        return None

    result = {
        "user_id": key_record["user_id"],
        "api_key_id": key_record["id"],
    }
    _api_key_cache.put(key, result)
    return result


def invalidate_api_key_cache(key: Optional[str] = None) -> None:
    """Invalidate API key cache. If key is None, clear all."""
    if key:
        _api_key_cache.invalidate(key)
    else:
        _api_key_cache.clear()


# ============================================================
# Usage write queue
# ============================================================

_usage_queue: list[dict] = []
_flush_task: Optional[asyncio.Task] = None
_FLUSH_INTERVAL = 5.0  # seconds
_FLUSH_THRESHOLD = 100  # entries


def enqueue_usage(
    api_key_id: int,
    provider_id: int,
    input_tokens: int,
    output_tokens: int,
    input_cost: float,
    output_cost: float,
    model: str,
) -> None:
    """Add a usage record to the write queue. Flushed periodically."""
    _usage_queue.append({
        "api_key_id": api_key_id,
        "provider_id": provider_id,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "input_cost": input_cost,
        "output_cost": output_cost,
        "model": model,
        "created_at": datetime.utcnow().isoformat(),
    })

    if len(_usage_queue) >= _FLUSH_THRESHOLD:
        asyncio.ensure_future(_flush_usage_queue())


async def _flush_usage_queue() -> None:
    """Flush all queued usage records to DB in a single transaction."""
    global _usage_queue
    if not _usage_queue:
        return

    batch = _usage_queue[:]
    _usage_queue = []

    try:
        async with await get_connection() as db:
            await db.execute("BEGIN")
            for entry in batch:
                await db.execute(
                    """
                    INSERT INTO usage (api_key_id, provider_id, input_tokens, output_tokens,
                                       input_cost, output_cost, model, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        entry["api_key_id"],
                        entry["provider_id"],
                        entry["input_tokens"],
                        entry["output_tokens"],
                        entry["input_cost"],
                        entry["output_cost"],
                        entry["model"],
                        entry["created_at"],
                    ),
                )
            await db.commit()
        logger.debug("Flushed %d usage records", len(batch))
    except Exception:
        logger.exception("Failed to flush usage queue, re-enqueue %d records", len(batch))
        _usage_queue = batch + _usage_queue


async def start_usage_flush_timer() -> None:
    """Start the periodic usage queue flush timer."""
    global _flush_task
    async def _timer():
        while True:
            await asyncio.sleep(_FLUSH_INTERVAL)
            if _usage_queue:
                await _flush_usage_queue()

    _flush_task = asyncio.ensure_future(_timer())


# ============================================================
# Database connection
# ============================================================


async def get_connection() -> aiosqlite.Connection:
    """Get an aiosqlite connection to the database."""
    db_path = Config.DATABASE_PATH
    db_dir = os.path.dirname(db_path)
    if db_dir:
        os.makedirs(db_dir, exist_ok=True)
    conn = await aiosqlite.connect(db_path)
    conn.row_factory = aiosqlite.Row
    await conn.execute("PRAGMA foreign_keys = ON")
    return conn


async def init_db() -> None:
    """Create all tables if they don't exist, then rebuild caches."""
    db_path = Config.DATABASE_PATH
    db_dir = os.path.dirname(db_path)
    if db_dir:
        os.makedirs(db_dir, exist_ok=True)

    async with aiosqlite.connect(db_path) as db:
        await db.execute("PRAGMA foreign_keys = ON")
        for table_sql in ALL_TABLES:
            await db.execute(table_sql)
        await db.commit()

    # Rebuild provider cache and start usage flush timer
    await rebuild_provider_cache()
    await start_usage_flush_timer()


# ============================================================
# Providers CRUD
# ============================================================


async def add_provider(
    name: str,
    api_type: str,
    base_url: str,
    api_key: str,
    models: str = "",
    input_price: float = 0,
    output_price: float = 0,
) -> Optional[dict]:
    """Add a new API provider."""
    async with await get_connection() as db:
        try:
            now = datetime.utcnow().isoformat()
            cursor = await db.execute(
                """
                INSERT INTO providers (name, api_type, base_url, api_key, models, input_price, output_price, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (name, api_type, base_url, api_key, models, input_price, output_price, now, now),
            )
            await db.commit()
            result = await get_provider_by_id(cursor.lastrowid)
            invalidate_provider_cache()
            return result
        except aiosqlite.IntegrityError:
            return None


async def get_providers(enabled_only: bool = False) -> list[dict]:
    """Get all providers."""
    async with await get_connection() as db:
        if enabled_only:
            cursor = await db.execute("SELECT * FROM providers WHERE enabled = 1 ORDER BY id")
        else:
            cursor = await db.execute("SELECT * FROM providers ORDER BY id")
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]


async def get_provider_by_id(provider_id: int) -> Optional[dict]:
    """Get a provider by ID."""
    async with await get_connection() as db:
        cursor = await db.execute("SELECT * FROM providers WHERE id = ?", (provider_id,))
        row = await cursor.fetchone()
        return dict(row) if row else None


async def update_provider(provider_id: int, **kwargs) -> Optional[dict]:
    """Update a provider's fields."""
    allowed_fields = {
        "name", "api_type", "base_url", "api_key", "models",
        "enabled", "input_price", "output_price",
    }
    updates = {k: v for k, v in kwargs.items() if k in allowed_fields}
    if not updates:
        return await get_provider_by_id(provider_id)

    updates["updated_at"] = datetime.utcnow().isoformat()
    set_clause = ", ".join(f"{k} = ?" for k in updates)
    values = list(updates.values()) + [provider_id]

    async with await get_connection() as db:
        await db.execute(
            f"UPDATE providers SET {set_clause} WHERE id = ?",
            values,
        )
        await db.commit()
        invalidate_provider_cache()
        return await get_provider_by_id(provider_id)


async def delete_provider(provider_id: int) -> bool:
    """Delete a provider by ID."""
    async with await get_connection() as db:
        cursor = await db.execute("DELETE FROM providers WHERE id = ?", (provider_id,))
        await db.commit()
        invalidate_provider_cache()
        return cursor.rowcount > 0


# ============================================================
# Users CRUD
# ============================================================


async def add_user(tg_user_id: int, username: str = "") -> Optional[dict]:
    """Add a new user."""
    async with await get_connection() as db:
        try:
            now = datetime.utcnow().isoformat()
            cursor = await db.execute(
                """
                INSERT INTO users (tg_user_id, username, is_active, created_at)
                VALUES (?, ?, 1, ?)
                """,
                (tg_user_id, username, now),
            )
            await db.commit()
            return await get_user_by_tg_id(tg_user_id)
        except aiosqlite.IntegrityError:
            return None


async def get_users(active_only: bool = False) -> list[dict]:
    """Get all users."""
    async with await get_connection() as db:
        if active_only:
            cursor = await db.execute("SELECT * FROM users WHERE is_active = 1 ORDER BY id")
        else:
            cursor = await db.execute("SELECT * FROM users ORDER BY id")
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]


async def get_user_by_tg_id(tg_user_id: int) -> Optional[dict]:
    """Get a user by Telegram user ID."""
    async with await get_connection() as db:
        cursor = await db.execute("SELECT * FROM users WHERE tg_user_id = ?", (tg_user_id,))
        row = await cursor.fetchone()
        return dict(row) if row else None


async def get_user_by_id(user_id: int) -> Optional[dict]:
    """Get a user by internal ID."""
    async with await get_connection() as db:
        cursor = await db.execute("SELECT * FROM users WHERE id = ?", (user_id,))
        row = await cursor.fetchone()
        return dict(row) if row else None


async def update_user_status(tg_user_id: int, is_active: int) -> Optional[dict]:
    """Update a user's active status."""
    async with await get_connection() as db:
        await db.execute(
            "UPDATE users SET is_active = ? WHERE tg_user_id = ?",
            (is_active, tg_user_id),
        )
        await db.commit()
        return await get_user_by_tg_id(tg_user_id)


async def update_user_tg_id(old_tg_user_id: int, new_tg_user_id: int) -> Optional[dict]:
    """Update a user's Telegram user ID."""
    async with await get_connection() as db:
        try:
            await db.execute(
                "UPDATE users SET tg_user_id = ? WHERE tg_user_id = ?",
                (new_tg_user_id, old_tg_user_id),
            )
            await db.commit()
            return await get_user_by_tg_id(new_tg_user_id)
        except aiosqlite.IntegrityError:
            return None


async def delete_user(tg_user_id: int) -> bool:
    """Delete a user by Telegram user ID."""
    async with await get_connection() as db:
        cursor = await db.execute("DELETE FROM users WHERE tg_user_id = ?", (tg_user_id,))
        await db.commit()
        return cursor.rowcount > 0


# ============================================================
# API Keys CRUD
# ============================================================


async def add_api_key(tg_user_id: int) -> Optional[dict]:
    """Generate and add a new API key for a user. Format: sk-s12ryt-{uuid7}"""
    # Ensure the user exists first
    user = await get_user_by_tg_id(tg_user_id)
    if not user:
        user = await add_user(tg_user_id)
        if not user:
            return None

    new_key = f"sk-s12ryt-{uuid_utils.uuid7()}"
    now = datetime.utcnow().isoformat()

    async with await get_connection() as db:
        try:
            cursor = await db.execute(
                """
                INSERT INTO api_keys (user_id, key, is_active, created_at)
                VALUES (?, ?, 1, ?)
                """,
                (user["id"], new_key, now),
            )
            await db.commit()
            return {
                "id": cursor.lastrowid,
                "user_id": user["id"],
                "key": new_key,
                "is_active": 1,
                "created_at": now,
            }
        except aiosqlite.IntegrityError:
            return None


async def get_keys_by_user(tg_user_id: int) -> list[dict]:
    """Get all API keys for a user by their Telegram user ID."""
    async with await get_connection() as db:
        cursor = await db.execute(
            """
            SELECT ak.* FROM api_keys ak
            JOIN users u ON ak.user_id = u.id
            WHERE u.tg_user_id = ?
            ORDER BY ak.created_at DESC
            """,
            (tg_user_id,),
        )
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]


async def get_key_by_value(key: str) -> Optional[dict]:
    """Get an API key record by the key string value."""
    async with await get_connection() as db:
        cursor = await db.execute("SELECT * FROM api_keys WHERE key = ?", (key,))
        row = await cursor.fetchone()
        return dict(row) if row else None


async def delete_api_key(key_id: int) -> bool:
    """Delete an API key by ID."""
    async with await get_connection() as db:
        cursor = await db.execute("DELETE FROM api_keys WHERE id = ?", (key_id,))
        await db.commit()
        return cursor.rowcount > 0


async def get_all_keys() -> list[dict]:
    """Get all API keys with user info."""
    async with await get_connection() as db:
        cursor = await db.execute(
            """
            SELECT ak.*, u.tg_user_id, u.username
            FROM api_keys ak
            JOIN users u ON ak.user_id = u.id
            ORDER BY ak.created_at DESC
            """
        )
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]


# ============================================================
# Usage CRUD
# ============================================================


async def record_usage(
    api_key_id: int,
    provider_id: int,
    input_tokens: int,
    output_tokens: int,
    input_cost: float,
    output_cost: float,
    model: str,
) -> Optional[dict]:
    """Record API usage for a key and provider."""
    now = datetime.utcnow().isoformat()
    async with await get_connection() as db:
        cursor = await db.execute(
            """
            INSERT INTO usage (api_key_id, provider_id, input_tokens, output_tokens, input_cost, output_cost, model, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (api_key_id, provider_id, input_tokens, output_tokens, input_cost, output_cost, model, now),
        )
        await db.commit()
        return {
            "id": cursor.lastrowid,
            "api_key_id": api_key_id,
            "provider_id": provider_id,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "input_cost": input_cost,
            "output_cost": output_cost,
            "model": model,
            "created_at": now,
        }


async def get_usage_by_key(api_key_id: int) -> list[dict]:
    """Get all usage records for a specific API key."""
    async with await get_connection() as db:
        cursor = await db.execute(
            "SELECT * FROM usage WHERE api_key_id = ? ORDER BY created_at DESC",
            (api_key_id,),
        )
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]


async def get_usage_by_provider(provider_id: int) -> list[dict]:
    """Get all usage records for a specific provider."""
    async with await get_connection() as db:
        cursor = await db.execute(
            "SELECT * FROM usage WHERE provider_id = ? ORDER BY created_at DESC",
            (provider_id,),
        )
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]


async def get_total_usage() -> dict[str, Any]:
    """Get aggregated total usage across all keys and providers."""
    async with await get_connection() as db:
        cursor = await db.execute(
            """
            SELECT
                COUNT(*) as total_requests,
                SUM(input_tokens) as total_input_tokens,
                SUM(output_tokens) as total_output_tokens,
                SUM(input_cost) as total_input_cost,
                SUM(output_cost) as total_output_cost
            FROM usage
            """
        )
        row = await cursor.fetchone()
        if row:
            result = dict(row)
            # Ensure None values become 0
            for k, v in result.items():
                if v is None:
                    result[k] = 0
            return result
        return {
            "total_requests": 0,
            "total_input_tokens": 0,
            "total_output_tokens": 0,
            "total_input_cost": 0,
            "total_output_cost": 0,
        }


# ============================================================
# Settings CRUD
# ============================================================


async def get_setting(key: str) -> Optional[str]:
    """Get a setting value by key."""
    async with await get_connection() as db:
        cursor = await db.execute("SELECT value FROM settings WHERE key = ?", (key,))
        row = await cursor.fetchone()
        return row["value"] if row else None


async def set_setting(key: str, value: str) -> None:
    """Set a setting value (upsert)."""
    async with await get_connection() as db:
        await db.execute(
            """
            INSERT INTO settings (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """,
            (key, value),
        )
        await db.commit()


# ============================================================
# Model Prices CRUD
# ============================================================


async def get_model_price(provider_id: int, model: str) -> Optional[dict]:
    """Get price for a specific model under a provider. Returns dict or None."""
    async with await get_connection() as db:
        cursor = await db.execute(
            "SELECT * FROM model_prices WHERE provider_id = ? AND model = ?",
            (provider_id, model),
        )
        row = await cursor.fetchone()
        return dict(row) if row else None


async def get_model_prices_by_provider(provider_id: int) -> list[dict]:
    """Get all model prices for a provider."""
    async with await get_connection() as db:
        cursor = await db.execute(
            "SELECT * FROM model_prices WHERE provider_id = ? ORDER BY model",
            (provider_id,),
        )
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]


async def upsert_model_price(
    provider_id: int,
    model: str,
    input_price: Optional[float],
    output_price: Optional[float],
) -> None:
    """Upsert a model price record. Prices in USD per 1M tokens."""
    async with await get_connection() as db:
        await db.execute(
            """
            INSERT INTO model_prices (provider_id, model, input_price, output_price)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(provider_id, model) DO UPDATE SET
                input_price = excluded.input_price,
                output_price = excluded.output_price,
                updated_at = datetime('now')
            """,
            (provider_id, model, input_price, output_price),
        )
        await db.commit()


async def batch_upsert_model_prices(
    provider_id: int,
    entries: list[dict],
) -> None:
    """Batch upsert model prices in a single transaction. Each entry: {model, input_price, output_price}."""
    async with await get_connection() as db:
        await db.execute("BEGIN")
        for entry in entries:
            await db.execute(
                """
                INSERT INTO model_prices (provider_id, model, input_price, output_price)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(provider_id, model) DO UPDATE SET
                    input_price = excluded.input_price,
                    output_price = excluded.output_price,
                    updated_at = datetime('now')
                """,
                (provider_id, entry["model"], entry.get("input_price"), entry.get("output_price")),
            )
        await db.commit()
    invalidate_provider_cache()


async def cleanup_model_prices(provider_id: int, current_models: list[str]) -> None:
    """Delete model prices for models no longer in the provider's model list."""
    async with await get_connection() as db:
        if not current_models:
            await db.execute("DELETE FROM model_prices WHERE provider_id = ?", (provider_id,))
        else:
            placeholders = ",".join(["?"] * len(current_models))
            await db.execute(
                f"DELETE FROM model_prices WHERE provider_id = ? AND model NOT IN ({placeholders})",
                [provider_id] + current_models,
            )
        await db.commit()
    invalidate_provider_cache()


async def delete_model_prices_by_provider(provider_id: int) -> None:
    """Delete all model prices for a provider."""
    async with await get_connection() as db:
        await db.execute("DELETE FROM model_prices WHERE provider_id = ?", (provider_id,))
        await db.commit()
    invalidate_provider_cache()

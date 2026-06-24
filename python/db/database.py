from __future__ import annotations

import asyncio
import logging
import os
import time
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime, timezone
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
    key_strategy: str = "failover"


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
                key_strategy=p.get("key_strategy", "failover"),
            )

    _provider_cache = cache
    logger.debug("Provider cache rebuilt: %d models", len(cache))

    # Notify listeners
    for cb in _on_cache_rebuild_callbacks:
        try:
            cb()
        except Exception as e:
            logger.warning("Provider cache rebuild callback failed: %s", e)


_on_cache_rebuild_callbacks: list[Any] = []


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
        "tg_user_id": user["tg_user_id"],
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
        "created_at": datetime.now(timezone.utc).isoformat(),
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

        # Migration: add session stats columns to coding_configs (idempotent)
        session_columns = [
            "session_input_tokens INTEGER DEFAULT 0",
            "session_output_tokens INTEGER DEFAULT 0",
            "session_input_cost REAL DEFAULT 0.0",
            "session_output_cost REAL DEFAULT 0.0",
            "session_requests INTEGER DEFAULT 0",
            "session_model_counts TEXT DEFAULT '{}'",
        ]
        for col_def in session_columns:
            col_name = col_def.split()[0]
            try:
                await db.execute(f"ALTER TABLE coding_configs ADD COLUMN {col_def}")
            except aiosqlite.OperationalError:
                pass  # Column already exists

        # Migration: add key_strategy column to providers
        try:
            await db.execute("ALTER TABLE providers ADD COLUMN key_strategy TEXT DEFAULT 'failover'")
        except aiosqlite.OperationalError:
            pass

        # Migration: openai → openai_chat (split api_type)
        async with db.execute(
            "SELECT value FROM settings WHERE key = 'migration_openai_split'"
        ) as cur:
            row = await cur.fetchone()
        if not row:
            logger.info("Running migration: openai → openai_chat")
            await db.execute("PRAGMA foreign_keys = OFF")

            # Recreate providers table with updated CHECK constraint
            await db.execute("""
                CREATE TABLE IF NOT EXISTS providers_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT UNIQUE NOT NULL,
                    api_type TEXT NOT NULL CHECK(api_type IN ('openai_chat', 'openai_response', 'anthropic', 'google')),
                    base_url TEXT NOT NULL,
                    api_key TEXT NOT NULL,
                    models TEXT DEFAULT '',
                    enabled INTEGER DEFAULT 1,
                    input_price REAL DEFAULT 0,
                    output_price REAL DEFAULT 0,
                    created_at TEXT DEFAULT (datetime('now')),
                    updated_at TEXT DEFAULT (datetime('now'))
                )
            """)
            await db.execute("""
                INSERT INTO providers_new
                SELECT id, name,
                    CASE WHEN api_type = 'openai' THEN 'openai_chat' ELSE api_type END,
                    base_url, api_key, models, enabled, input_price, output_price, created_at, updated_at
                FROM providers
            """)
            await db.execute("DROP TABLE providers")
            await db.execute("ALTER TABLE providers_new RENAME TO providers")

            await db.execute("PRAGMA foreign_keys = ON")
            await db.execute(
                "INSERT INTO settings (key, value) VALUES ('migration_openai_split', '1')"
            )
            await db.commit()
            logger.info("Migration complete: openai → openai_chat")

        # Migration: single api_key → JSON array for multi-key support
        async with db.execute(
            "SELECT value FROM settings WHERE key = 'migration_multi_key'"
        ) as cur:
            row = await cur.fetchone()
        if not row:
            logger.info("Running migration: single api_key → JSON array")
            async with db.execute("SELECT id, api_key FROM providers") as cur:
                rows = await cur.fetchall()
            for row in rows:
                pid, key = row[0], row[1]
                if not key.startswith("["):
                    import json
                    wrapped = json.dumps([key])
                    await db.execute("UPDATE providers SET api_key = ? WHERE id = ?", (wrapped, pid))
            await db.execute(
                "INSERT INTO settings (key, value) VALUES ('migration_multi_key', '1')"
            )
            await db.commit()
            logger.info("Migration complete: %d providers migrated to multi-key format", len(rows))

        # Migration: permission system columns on users + api_keys
        user_perm_columns = [
            "group_id INTEGER",
            "expires_at TEXT",
            "rpm_override INTEGER",
            "tpm_override INTEGER",
            "concurrency_override INTEGER",
            "daily_token_override INTEGER",
            "monthly_token_override INTEGER",
            "daily_cost_override REAL",
            "monthly_cost_override REAL",
        ]
        for col_def in user_perm_columns:
            col_name = col_def.split()[0]
            try:
                await db.execute(f"ALTER TABLE users ADD COLUMN {col_def}")
            except aiosqlite.OperationalError:
                pass  # Column already exists

        api_key_perm_columns = [
            "expires_at TEXT",
            "rpm_override INTEGER",
            "tpm_override INTEGER",
            "concurrency_override INTEGER",
            "daily_token_override INTEGER",
            "monthly_token_override INTEGER",
            "daily_cost_override REAL",
            "monthly_cost_override REAL",
        ]
        for col_def in api_key_perm_columns:
            col_name = col_def.split()[0]
            try:
                await db.execute(f"ALTER TABLE api_keys ADD COLUMN {col_def}")
            except aiosqlite.OperationalError:
                pass  # Column already exists

        # Seed default user group if not exists
        cursor = await db.execute("SELECT id FROM user_groups WHERE is_default = 1")
        existing_default = await cursor.fetchone()
        if not existing_default:
            now = datetime.now(timezone.utc).isoformat()
            await db.execute(
                """
                INSERT INTO user_groups (name, display_name, is_default, created_at, updated_at)
                VALUES ('default', 'Default Group', 1, ?, ?)
                """,
                (now, now),
            )
            logger.info("Seeded default user group")

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
            now = datetime.now(timezone.utc).isoformat()
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

    updates["updated_at"] = datetime.now(timezone.utc).isoformat()
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
        from api.key_selector import clear_provider_key_state
        clear_provider_key_state(provider_id)
        invalidate_provider_cache()
        return cursor.rowcount > 0


# ============================================================
# Users CRUD
# ============================================================


async def add_user(tg_user_id: int, username: str = "") -> Optional[dict]:
    """Add a new user."""
    async with await get_connection() as db:
        try:
            now = datetime.now(timezone.utc).isoformat()
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
    now = datetime.now(timezone.utc).isoformat()

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
    now = datetime.now(timezone.utc).isoformat()
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


# ============================================================
# Coding mode configuration
# ============================================================

async def get_coding_config(user_id: int) -> dict | None:
    """Get coding mode config for a user. Returns dict or None."""
    async with await get_connection() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT * FROM coding_configs WHERE user_id = ?", (user_id,)
        )
        row = await cursor.fetchone()
        if row:
            return dict(row)
    return None


async def get_coding_config_by_tg_id(tg_user_id: int) -> dict | None:
    """Get coding mode config by Telegram user ID."""
    user = await get_user_by_tg_id(tg_user_id)
    if not user:
        return None
    return await get_coding_config(user["id"])


async def set_coding_config(
    user_id: int,
    is_active: int | None = None,
    fallback_models: str | None = None,
    max_retries: int | None = None,
) -> dict:
    """Create or update coding config for a user. Returns the updated config."""
    async with await get_connection() as db:
        # Check if exists
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT id FROM coding_configs WHERE user_id = ?", (user_id,)
        )
        existing = await cursor.fetchone()

        if existing:
            # Update
            sets: list[str] = []
            params: list[Any] = []
            if is_active is not None:
                sets.append("is_active = ?")
                params.append(is_active)
            if fallback_models is not None:
                sets.append("fallback_models = ?")
                params.append(fallback_models)
            if max_retries is not None:
                sets.append("max_retries = ?")
                params.append(max_retries)
            if sets:
                sets.append("updated_at = datetime('now')")
                params.append(user_id)
                await db.execute(
                    f"UPDATE coding_configs SET {', '.join(sets)} WHERE user_id = ?",
                    params,
                )
                await db.commit()
        else:
            # Insert
            await db.execute(
                """INSERT INTO coding_configs (user_id, is_active, fallback_models, max_retries)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET
                    is_active = excluded.is_active,
                    fallback_models = excluded.fallback_models,
                    max_retries = excluded.max_retries,
                    updated_at = datetime('now')
                """,
                (
                    user_id,
                    is_active if is_active is not None else 0,
                    fallback_models if fallback_models is not None else "",
                    max_retries if max_retries is not None else 3,
                ),
            )
            await db.commit()

        # Return updated config
        cursor = await db.execute(
            "SELECT * FROM coding_configs WHERE user_id = ?", (user_id,)
        )
        row = await cursor.fetchone()
        return dict(row) if row else {}


async def get_active_coding_for_api_key(api_key_id: int) -> dict | None:
    """Given an api_key_id, return the user's active coding config (if any).

    Used by the API server to check if the request should use fallback logic.
    """
    async with await get_connection() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            """
            SELECT cc.* FROM coding_configs cc
            JOIN api_keys ak ON ak.user_id = cc.user_id
            WHERE ak.id = ? AND cc.is_active = 1
            """,
            (api_key_id,),
        )
        row = await cursor.fetchone()
        if row:
            config = dict(row)
            # Parse fallback_models into a list
            if config.get("fallback_models"):
                config["fallback_list"] = [m.strip() for m in config["fallback_models"].split(",") if m.strip()]
            else:
                config["fallback_list"] = []
            return config
    return None


async def increment_coding_session_stats(
    user_id: int,
    input_tokens: int,
    output_tokens: int,
    input_cost: float,
    output_cost: float,
    actual_model: str,
) -> None:
    """Increment coding mode session stats after a successful coding-mode request."""
    import json
    async with await get_connection() as db:
        # Read current model counts
        row = await db.execute_fetchall(
            "SELECT session_model_counts FROM coding_configs WHERE user_id = ?",
            (user_id,),
        )
        counts: dict = {}
        if row and row[0]["session_model_counts"]:
            try:
                counts = json.loads(row[0]["session_model_counts"])
            except (json.JSONDecodeError, TypeError):
                counts = {}
        counts[actual_model] = counts.get(actual_model, 0) + 1

        await db.execute(
            """
            UPDATE coding_configs SET
                session_input_tokens = session_input_tokens + ?,
                session_output_tokens = session_output_tokens + ?,
                session_input_cost = session_input_cost + ?,
                session_output_cost = session_output_cost + ?,
                session_requests = session_requests + 1,
                session_model_counts = ?,
                updated_at = datetime('now')
            WHERE user_id = ?
            """,
            (input_tokens, output_tokens, input_cost, output_cost, json.dumps(counts), user_id),
        )
        await db.commit()


async def reset_coding_session_stats(user_id: int) -> None:
    """Reset coding mode session stats to zero (called when coding mode is activated)."""
    async with await get_connection() as db:
        await db.execute(
            """
            UPDATE coding_configs SET
                session_input_tokens = 0,
                session_output_tokens = 0,
                session_input_cost = 0.0,
                session_output_cost = 0.0,
                session_requests = 0,
                session_model_counts = '{}',
                updated_at = datetime('now')
            WHERE user_id = ?
            """,
            (user_id,),
        )
        await db.commit()


# ============================================================
# Model Restrictions CRUD
# ============================================================


def _normalize_models(models_str: str) -> list[str]:
    """Normalize comma-separated model names into a sorted list."""
    return sorted(m.strip() for m in models_str.split(",") if m.strip())


async def get_model_restriction(user_id: int, api_key_id: int | None = None) -> dict | None:
    """Get a single model restriction by user_id and api_key_id.

    api_key_id=None means user-level restriction.
    """
    async with await get_connection() as db:
        if api_key_id is None:
            cursor = await db.execute(
                "SELECT * FROM model_restrictions WHERE user_id = ? AND api_key_id IS NULL",
                (user_id,),
            )
        else:
            cursor = await db.execute(
                "SELECT * FROM model_restrictions WHERE user_id = ? AND api_key_id = ?",
                (user_id, api_key_id),
            )
        row = await cursor.fetchone()
        return dict(row) if row else None


async def get_model_restrictions_for_user(user_id: int) -> list[dict]:
    """Get all model restrictions for a user (user-level first, then key-level)."""
    async with await get_connection() as db:
        cursor = await db.execute(
            "SELECT * FROM model_restrictions WHERE user_id = ? ORDER BY api_key_id IS NULL DESC, api_key_id ASC",
            (user_id,),
        )
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]


async def set_model_restriction(
    user_id: int,
    api_key_id: int | None,
    mode: str,
    models: str,
) -> dict:
    """Create or update a model restriction. mode: 'whitelist' or 'blacklist'."""
    normalized = ",".join(_normalize_models(models))
    now = datetime.now(timezone.utc).isoformat()

    async with await get_connection() as db:
        # Check existing
        if api_key_id is None:
            cursor = await db.execute(
                "SELECT id FROM model_restrictions WHERE user_id = ? AND api_key_id IS NULL",
                (user_id,),
            )
        else:
            cursor = await db.execute(
                "SELECT id FROM model_restrictions WHERE user_id = ? AND api_key_id = ?",
                (user_id, api_key_id),
            )
        existing = await cursor.fetchone()

        if existing:
            await db.execute(
                """
                UPDATE model_restrictions
                SET mode = ?, models = ?, updated_at = ?
                WHERE id = ?
                """,
                (mode, normalized, now, existing["id"]),
            )
        else:
            await db.execute(
                """
                INSERT INTO model_restrictions (user_id, api_key_id, mode, models, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (user_id, api_key_id, mode, normalized, now, now),
            )
        await db.commit()

    # Return the upserted record
    result = await get_model_restriction(user_id, api_key_id)
    return result or {}


async def delete_model_restriction(user_id: int, api_key_id: int | None) -> bool:
    """Delete a model restriction by user_id and api_key_id."""
    async with await get_connection() as db:
        if api_key_id is None:
            cursor = await db.execute(
                "DELETE FROM model_restrictions WHERE user_id = ? AND api_key_id IS NULL",
                (user_id,),
            )
        else:
            cursor = await db.execute(
                "DELETE FROM model_restrictions WHERE user_id = ? AND api_key_id = ?",
                (user_id, api_key_id),
            )
        await db.commit()
        return cursor.rowcount > 0


def _apply_restriction(model_name: str, mode: str, models_list: list[str]) -> bool:
    """Apply a single restriction to a model name.

    whitelist: allow only if model is in the list
    blacklist: deny if model is in the list
    Empty list: whitelist → deny all, blacklist → allow all
    """
    if mode == "whitelist":
        return model_name in models_list if models_list else False
    else:  # blacklist
        return model_name not in models_list if models_list else True


async def check_model_allowed(user_id: int, api_key_id: int | None, model_name: str, is_admin: bool = False) -> bool:
    """Check if a model is allowed for the given user/key combination.

    Logic:
    1. If key-level restriction exists → apply it (even for admin)
    2. Else if user-level restriction exists → apply it (admin bypasses user-level)
    3. No restriction → deny for non-admin, allow for admin
    """
    # Check key-level first
    key_restriction = await get_model_restriction(user_id, api_key_id) if api_key_id else None
    if key_restriction:
        models_list = _normalize_models(key_restriction.get("models", ""))
        return _apply_restriction(model_name, key_restriction["mode"], models_list)

    # Check user-level
    user_restriction = await get_model_restriction(user_id)
    if user_restriction:
        if is_admin:
            return True  # Admin bypasses user-level restriction
        models_list = _normalize_models(user_restriction.get("models", ""))
        return _apply_restriction(model_name, user_restriction["mode"], models_list)

    # No restriction → admin allowed, non-admin denied
    return is_admin


async def get_allowed_models(
    user_id: int,
    api_key_id: int | None,
    all_models: list[str],
    is_admin: bool = False,
) -> list[str]:
    """Get the list of allowed models for a user/key, mirroring check_model_allowed logic."""
    # Key-level
    key_restriction = await get_model_restriction(user_id, api_key_id) if api_key_id else None
    if key_restriction:
        models_list = _normalize_models(key_restriction.get("models", ""))
        return [m for m in all_models if _apply_restriction(m, key_restriction["mode"], models_list)]

    # User-level
    user_restriction = await get_model_restriction(user_id)
    if user_restriction:
        if is_admin:
            return list(all_models)  # Admin bypasses
        models_list = _normalize_models(user_restriction.get("models", ""))
        return [m for m in all_models if _apply_restriction(m, user_restriction["mode"], models_list)]

    # No restriction → admin gets all, non-admin gets nothing
    return list(all_models) if is_admin else []


# ============================================================
# Permission System — User Groups
# ============================================================


async def get_user_groups() -> list[dict]:
    """Get all user groups, default first."""
    async with await get_connection() as db:
        cursor = await db.execute(
            "SELECT * FROM user_groups ORDER BY is_default DESC, name ASC"
        )
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]


async def get_user_group_by_id(group_id: int) -> dict | None:
    """Get a user group by ID."""
    async with await get_connection() as db:
        cursor = await db.execute("SELECT * FROM user_groups WHERE id = ?", (group_id,))
        row = await cursor.fetchone()
        return dict(row) if row else None


async def get_user_group_by_name(name: str) -> dict | None:
    """Get a user group by name."""
    async with await get_connection() as db:
        cursor = await db.execute("SELECT * FROM user_groups WHERE name = ?", (name,))
        row = await cursor.fetchone()
        return dict(row) if row else None


async def get_default_user_group() -> dict | None:
    """Get the default user group."""
    async with await get_connection() as db:
        cursor = await db.execute("SELECT * FROM user_groups WHERE is_default = 1")
        row = await cursor.fetchone()
        return dict(row) if row else None


async def add_user_group(
    name: str,
    display_name: str | None = None,
    rpm_limit: int = 0,
    tpm_limit: int = 0,
    concurrency_limit: int = 0,
    daily_token_limit: int = 0,
    monthly_token_limit: int = 0,
    daily_cost_limit: float = 0,
    monthly_cost_limit: float = 0,
) -> dict | None:
    """Add a new user group. Returns the created group or None on conflict."""
    now = datetime.now(timezone.utc).isoformat()
    async with await get_connection() as db:
        try:
            await db.execute(
                """
                INSERT INTO user_groups
                    (name, display_name, rpm_limit, tpm_limit, concurrency_limit,
                     daily_token_limit, monthly_token_limit, daily_cost_limit, monthly_cost_limit,
                     is_default, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
                """,
                (name, display_name, rpm_limit, tpm_limit, concurrency_limit,
                 daily_token_limit, monthly_token_limit, daily_cost_limit, monthly_cost_limit,
                 now, now),
            )
            await db.commit()
        except aiosqlite.IntegrityError:
            return None
    invalidate_effective_limits_cache()
    return await get_user_group_by_name(name)


async def update_user_group(group_id: int, **kwargs) -> dict | None:
    """Update a user group's fields."""
    allowed_fields = {
        "name", "display_name", "rpm_limit", "tpm_limit", "concurrency_limit",
        "daily_token_limit", "monthly_token_limit", "daily_cost_limit", "monthly_cost_limit",
    }
    updates = {k: v for k, v in kwargs.items() if k in allowed_fields}
    if not updates:
        return await get_user_group_by_id(group_id)

    updates["updated_at"] = datetime.now(timezone.utc).isoformat()
    set_clause = ", ".join(f"{k} = ?" for k in updates)
    values = list(updates.values()) + [group_id]

    async with await get_connection() as db:
        await db.execute(f"UPDATE user_groups SET {set_clause} WHERE id = ?", values)
        await db.commit()
    invalidate_effective_limits_cache()
    return await get_user_group_by_id(group_id)


async def delete_user_group(group_id: int) -> None:
    """Delete a user group. Prevents deleting the default group.
    Moves all users in this group to the default group."""
    group = await get_user_group_by_id(group_id)
    if group and group["is_default"] == 1:
        raise ValueError("Cannot delete the default user group")

    default_group = await get_default_user_group()
    if default_group and default_group["id"] != group_id:
        async with await get_connection() as db:
            await db.execute(
                "UPDATE users SET group_id = ? WHERE group_id = ?",
                (default_group["id"], group_id),
            )
            await db.execute("DELETE FROM user_groups WHERE id = ?", (group_id,))
            await db.commit()
    else:
        async with await get_connection() as db:
            await db.execute("DELETE FROM user_groups WHERE id = ?", (group_id,))
            await db.commit()
    invalidate_effective_limits_cache()


# ============================================================
# Permission System — User & API Key limits management
# ============================================================


async def get_user_with_limits(user_id: int) -> dict | None:
    """Get a user with all permission columns."""
    async with await get_connection() as db:
        cursor = await db.execute("SELECT * FROM users WHERE id = ?", (user_id,))
        row = await cursor.fetchone()
        return dict(row) if row else None


async def set_user_group(user_id: int, group_id: int) -> None:
    """Set a user's group."""
    async with await get_connection() as db:
        await db.execute(
            "UPDATE users SET group_id = ? WHERE id = ?", (group_id, user_id)
        )
        await db.commit()
    invalidate_effective_limits_cache(user_id)


async def set_user_overrides(
    user_id: int,
    expires_at: str | None = None,
    rpm_override: int | None = None,
    tpm_override: int | None = None,
    concurrency_override: int | None = None,
    daily_token_override: int | None = None,
    monthly_token_override: int | None = None,
    daily_cost_override: float | None = None,
    monthly_cost_override: float | None = None,
) -> None:
    """Set user-level limit overrides. Only provided values are updated."""
    allowed = {
        "expires_at": expires_at,
        "rpm_override": rpm_override,
        "tpm_override": tpm_override,
        "concurrency_override": concurrency_override,
        "daily_token_override": daily_token_override,
        "monthly_token_override": monthly_token_override,
        "daily_cost_override": daily_cost_override,
        "monthly_cost_override": monthly_cost_override,
    }
    fields = []
    values = []
    for k, v in allowed.items():
        if v is not None:
            fields.append(f"{k} = ?")
            values.append(v)
    if not fields:
        return
    values.append(user_id)
    async with await get_connection() as db:
        await db.execute(
            f"UPDATE users SET {', '.join(fields)} WHERE id = ?", values
        )
        await db.commit()
    invalidate_effective_limits_cache(user_id)


async def get_api_key_with_limits(api_key_id: int) -> dict | None:
    """Get an API key with all permission columns."""
    async with await get_connection() as db:
        cursor = await db.execute("SELECT * FROM api_keys WHERE id = ?", (api_key_id,))
        row = await cursor.fetchone()
        return dict(row) if row else None


async def set_api_key_overrides(
    api_key_id: int,
    expires_at: str | None = None,
    rpm_override: int | None = None,
    tpm_override: int | None = None,
    concurrency_override: int | None = None,
    daily_token_override: int | None = None,
    monthly_token_override: int | None = None,
    daily_cost_override: float | None = None,
    monthly_cost_override: float | None = None,
) -> None:
    """Set API key-level limit overrides. Only provided values are updated."""
    allowed = {
        "expires_at": expires_at,
        "rpm_override": rpm_override,
        "tpm_override": tpm_override,
        "concurrency_override": concurrency_override,
        "daily_token_override": daily_token_override,
        "monthly_token_override": monthly_token_override,
        "daily_cost_override": daily_cost_override,
        "monthly_cost_override": monthly_cost_override,
    }
    fields = []
    values = []
    for k, v in allowed.items():
        if v is not None:
            fields.append(f"{k} = ?")
            values.append(v)
    if not fields:
        return
    values.append(api_key_id)
    async with await get_connection() as db:
        await db.execute(
            f"UPDATE api_keys SET {', '.join(fields)} WHERE id = ?", values
        )
        await db.commit()
    invalidate_effective_limits_cache()


# ============================================================
# Permission System — Effective limits calculation
# ============================================================


def _pick_limit(
    api_key_override: int | float | None,
    user_override: int | float | None,
    group_limit: int | float | None,
) -> int | float:
    """Pick first non-null value. null = inherit, 0 = unlimited."""
    if api_key_override is not None:
        return api_key_override
    if user_override is not None:
        return user_override
    if group_limit is not None:
        return group_limit
    return 0  # unlimited


# --- TTL cache for get_effective_limits (mirrors Node.js effectiveLimitsCache) ---
_EFFECTIVE_LIMITS_TTL = 60  # seconds
_EFFECTIVE_LIMITS_CACHE_MAX = 512
_effective_limits_cache: dict[tuple[int, int | None], tuple[float, dict]] = {}


async def _compute_effective_limits(
    user_id: int,
    api_key_id: int | None = None,
) -> dict:
    """Compute effective limits for a given user + API key (uncached).

    Priority: apiKey override > user override > user group limit > 0 (unlimited).

    Returns dict with keys: rpm, tpm, concurrency, daily_token_limit,
    monthly_token_limit, daily_cost_limit, monthly_cost_limit, expires_at.
    A value of 0 means unlimited.
    """
    user = await get_user_with_limits(user_id)

    group = None
    if user and user.get("group_id"):
        group = await get_user_group_by_id(user["group_id"])
    if not group:
        group = await get_default_user_group()

    api_key = None
    if api_key_id is not None:
        api_key = await get_api_key_with_limits(api_key_id)

    return {
        "rpm": _pick_limit(
            api_key.get("rpm_override") if api_key else None,
            user.get("rpm_override") if user else None,
            group.get("rpm_limit") if group else None,
        ),
        "tpm": _pick_limit(
            api_key.get("tpm_override") if api_key else None,
            user.get("tpm_override") if user else None,
            group.get("tpm_limit") if group else None,
        ),
        "concurrency": _pick_limit(
            api_key.get("concurrency_override") if api_key else None,
            user.get("concurrency_override") if user else None,
            group.get("concurrency_limit") if group else None,
        ),
        "daily_token_limit": _pick_limit(
            api_key.get("daily_token_override") if api_key else None,
            user.get("daily_token_override") if user else None,
            group.get("daily_token_limit") if group else None,
        ),
        "monthly_token_limit": _pick_limit(
            api_key.get("monthly_token_override") if api_key else None,
            user.get("monthly_token_override") if user else None,
            group.get("monthly_token_limit") if group else None,
        ),
        "daily_cost_limit": _pick_limit(
            api_key.get("daily_cost_override") if api_key else None,
            user.get("daily_cost_override") if user else None,
            group.get("daily_cost_limit") if group else None,
        ),
        "monthly_cost_limit": _pick_limit(
            api_key.get("monthly_cost_override") if api_key else None,
            user.get("monthly_cost_override") if user else None,
            group.get("monthly_cost_limit") if group else None,
        ),
        "expires_at": (
            (api_key.get("expires_at") if api_key else None)
            or (user.get("expires_at") if user else None)
            or None
        ),
    }


async def get_effective_limits(
    user_id: int,
    api_key_id: int | None = None,
) -> dict:
    """Get effective limits with 60s TTL cache (mirrors Node.js getCachedEffectiveLimits).

    Use invalidate_effective_limits_cache() when limits are modified.
    """
    key = (user_id, api_key_id)
    now = time.monotonic()

    # Check cache
    cached = _effective_limits_cache.get(key)
    if cached is not None:
        ts, limits = cached
        if now - ts < _EFFECTIVE_LIMITS_TTL:
            # LRU re-insertion on hit
            del _effective_limits_cache[key]
            _effective_limits_cache[key] = (now, limits)
            return limits
        else:
            del _effective_limits_cache[key]

    # Cache miss — compute
    limits = await _compute_effective_limits(user_id, api_key_id)

    # Evict oldest if at capacity
    while len(_effective_limits_cache) >= _EFFECTIVE_LIMITS_CACHE_MAX:
        oldest_key = next(iter(_effective_limits_cache))
        del _effective_limits_cache[oldest_key]

    _effective_limits_cache[key] = (now, limits)
    return limits


def invalidate_effective_limits_cache(user_id: int | None = None) -> None:
    """Invalidate the effective limits cache.

    If user_id is provided, only invalidates entries for that user.
    Otherwise clears the entire cache.
    """
    if user_id is None:
        _effective_limits_cache.clear()
    else:
        keys_to_delete = [k for k in _effective_limits_cache if k[0] == user_id]
        for k in keys_to_delete:
            del _effective_limits_cache[k]


# ============================================================
# Permission System — Quota queries
# ============================================================


async def _get_period_usage(
    period: str, user_id: int, api_key_id: int | None = None
) -> dict[str, float]:
    """Get usage for a time period (day or month)."""
    # Use substr() because created_at may be stored as ISO 8601 with timezone
    # offset (e.g. 2026-01-01T12:00:00.123456+00:00), which SQLite's date()
    # and strftime() cannot parse, returning NULL.
    if period == "day":
        date_cond = "substr(created_at, 1, 10) = date('now')"
    else:
        date_cond = "substr(created_at, 1, 7) = strftime('%Y-%m', 'now')"

    async with await get_connection() as db:
        if api_key_id is not None:
            cursor = await db.execute(
                f"""
                SELECT
                    COALESCE(SUM(input_tokens + output_tokens), 0) AS total_tokens,
                    COALESCE(SUM(input_cost + output_cost), 0) AS total_cost
                FROM usage
                WHERE api_key_id = ? AND {date_cond}
                """,
                (api_key_id,),
            )
        else:
            cursor = await db.execute(
                f"""
                SELECT
                    COALESCE(SUM(u.input_tokens + u.output_tokens), 0) AS total_tokens,
                    COALESCE(SUM(u.input_cost + u.output_cost), 0) AS total_cost
                FROM usage u
                JOIN api_keys ak ON u.api_key_id = ak.id
                WHERE ak.user_id = ? AND {date_cond.replace('created_at', 'u.created_at')}
                """,
                (user_id,),
            )
        row = await cursor.fetchone()
        if row:
            return {
                "total_tokens": row["total_tokens"] or 0,
                "total_cost": row["total_cost"] or 0,
            }
        return {"total_tokens": 0, "total_cost": 0}


async def get_daily_usage(
    user_id: int, api_key_id: int | None = None
) -> dict[str, float]:
    """Get today's token usage and cost."""
    return await _get_period_usage("day", user_id, api_key_id)


async def get_monthly_usage(
    user_id: int, api_key_id: int | None = None
) -> dict[str, float]:
    """Get this month's token usage and cost."""
    return await _get_period_usage("month", user_id, api_key_id)


def is_expired(expires_at: str | None) -> bool:
    """Check if an expiry date has passed. Returns True if expired."""
    if not expires_at:
        return False
    try:
        # Treat as UTC if no timezone suffix
        dt_str = expires_at if expires_at.endswith("Z") or "+" in expires_at else expires_at + "Z"
        expiry = datetime.fromisoformat(dt_str)
        return expiry.timestamp() < time.time()
    except Exception:
        return False

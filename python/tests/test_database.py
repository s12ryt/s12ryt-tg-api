"""
Unit tests for db/database.py
Covers: init_db, Providers/Users/API Keys/Usage/Settings CRUD operations.
"""

import os
import re

import pytest

# Set safe env vars before importing project code (conftest.py also does this,
# but test files are loaded first in some collection orders)
os.environ.setdefault("BOT_TOKEN", "test-bot-token")
os.environ.setdefault("ADMIN_ID", "123456")
os.environ.setdefault("API_PORT", "8000")
os.environ.setdefault("DATABASE_PATH", "./data/test_bot.db")
os.environ.setdefault("DEFAULT_API_URL", "http://localhost:8000")

from db import database  # noqa: E402


# ------------------------------------------------------------------ #
# init_db
# ------------------------------------------------------------------ #


class TestInitDb:
    @pytest.mark.asyncio
    async def test_tables_created(self, db_conn):
        """init_db should create all 5 tables without error."""
        import aiosqlite

        async with aiosqlite.connect(db_conn) as db:
            cursor = await db.execute(
                "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
            )
            tables = {row[0] for row in await cursor.fetchall()}

        expected = {"providers", "users", "api_keys", "usage", "settings"}
        assert expected.issubset(tables)

    @pytest.mark.asyncio
    async def test_init_db_idempotent(self, db_conn):
        """Calling init_db twice should not raise."""
        await database.init_db()
        # No exception means success


# ------------------------------------------------------------------ #
# Providers CRUD
# ------------------------------------------------------------------ #


class TestProviders:
    @pytest.mark.asyncio
    async def test_add_provider(self, db_conn):
        result = await database.add_provider(
            name="openai-main",
            api_type="openai_chat",
            base_url="https://api.openai.com",
            api_key="sk-test123",
            models="gpt-4,gpt-3.5",
            input_price=0.03,
            output_price=0.06,
        )
        assert result is not None
        assert result["name"] == "openai-main"
        assert result["api_type"] == "openai_chat"
        assert result["base_url"] == "https://api.openai.com"
        assert result["api_key"] == "sk-test123"
        assert result["models"] == "gpt-4,gpt-3.5"
        assert result["input_price"] == 0.03
        assert result["output_price"] == 0.06
        assert result["enabled"] == 1

    @pytest.mark.asyncio
    async def test_add_provider_duplicate_name(self, db_conn):
        await database.add_provider(
            name="dup", api_type="openai_chat", base_url="https://a.com", api_key="k"
        )
        result = await database.add_provider(
            name="dup", api_type="openai_chat", base_url="https://b.com", api_key="k2"
        )
        assert result is None

    @pytest.mark.asyncio
    async def test_get_providers(self, db_conn):
        await database.add_provider("p1", "openai_chat", "https://a.com", "k1")
        await database.add_provider("p2", "anthropic", "https://b.com", "k2")
        providers = await database.get_providers()
        assert len(providers) == 2
        assert providers[0]["name"] == "p1"
        assert providers[1]["name"] == "p2"

    @pytest.mark.asyncio
    async def test_get_providers_enabled_only(self, db_conn):
        await database.add_provider("enabled", "openai_chat", "https://a.com", "k1")
        await database.add_provider("disabled", "anthropic", "https://b.com", "k2")
        await database.update_provider(2, enabled=0)
        providers = await database.get_providers(enabled_only=True)
        assert len(providers) == 1
        assert providers[0]["name"] == "enabled"

    @pytest.mark.asyncio
    async def test_get_provider_by_id(self, db_conn):
        await database.add_provider("target", "google", "https://c.com", "k3")
        result = await database.get_provider_by_id(1)
        assert result is not None
        assert result["name"] == "target"
        assert result["api_type"] == "google"

    @pytest.mark.asyncio
    async def test_get_provider_by_id_not_found(self, db_conn):
        result = await database.get_provider_by_id(999)
        assert result is None

    @pytest.mark.asyncio
    async def test_update_provider(self, db_conn):
        await database.add_provider("orig", "openai_chat", "https://a.com", "k1")
        updated = await database.update_provider(1, name="renamed", enabled=0)
        assert updated is not None
        assert updated["name"] == "renamed"
        assert updated["enabled"] == 0

    @pytest.mark.asyncio
    async def test_update_provider_no_fields(self, db_conn):
        await database.add_provider("orig", "openai_chat", "https://a.com", "k1")
        updated = await database.update_provider(1)
        assert updated is not None
        assert updated["name"] == "orig"

    @pytest.mark.asyncio
    async def test_delete_provider(self, db_conn):
        await database.add_provider("to-delete", "openai_chat", "https://a.com", "k1")
        assert await database.delete_provider(1) is True
        assert await database.get_provider_by_id(1) is None

    @pytest.mark.asyncio
    async def test_delete_provider_non_existent(self, db_conn):
        assert await database.delete_provider(999) is False


# ------------------------------------------------------------------ #
# Users CRUD
# ------------------------------------------------------------------ #


class TestUsers:
    @pytest.mark.asyncio
    async def test_add_user(self, db_conn):
        result = await database.add_user(tg_user_id=100, username="alice")
        assert result is not None
        assert result["tg_user_id"] == 100
        assert result["username"] == "alice"
        assert result["is_active"] == 1

    @pytest.mark.asyncio
    async def test_add_user_duplicate_tg_id(self, db_conn):
        await database.add_user(tg_user_id=200, username="bob")
        result = await database.add_user(tg_user_id=200, username="bob2")
        assert result is None

    @pytest.mark.asyncio
    async def test_get_users(self, db_conn):
        await database.add_user(301, "u1")
        await database.add_user(302, "u2")
        users = await database.get_users()
        assert len(users) == 2

    @pytest.mark.asyncio
    async def test_get_users_active_only(self, db_conn):
        await database.add_user(401, "active")
        await database.add_user(402, "inactive")
        await database.update_user_status(402, 0)
        users = await database.get_users(active_only=True)
        assert len(users) == 1
        assert users[0]["tg_user_id"] == 401

    @pytest.mark.asyncio
    async def test_get_user_by_tg_id(self, db_conn):
        await database.add_user(500, "charlie")
        user = await database.get_user_by_tg_id(500)
        assert user is not None
        assert user["username"] == "charlie"

    @pytest.mark.asyncio
    async def test_get_user_by_tg_id_not_found(self, db_conn):
        assert await database.get_user_by_tg_id(9999) is None

    @pytest.mark.asyncio
    async def test_update_user_status(self, db_conn):
        await database.add_user(600, "dave")
        updated = await database.update_user_status(600, 0)
        assert updated is not None
        assert updated["is_active"] == 0

    @pytest.mark.asyncio
    async def test_update_user_tg_id(self, db_conn):
        await database.add_user(700, "eve")
        updated = await database.update_user_tg_id(700, 701)
        assert updated is not None
        assert updated["tg_user_id"] == 701

    @pytest.mark.asyncio
    async def test_update_user_tg_id_conflict(self, db_conn):
        await database.add_user(800, "a")
        await database.add_user(801, "b")
        result = await database.update_user_tg_id(800, 801)
        assert result is None

    @pytest.mark.asyncio
    async def test_delete_user(self, db_conn):
        await database.add_user(900, "frank")
        assert await database.delete_user(900) is True
        assert await database.get_user_by_tg_id(900) is None

    @pytest.mark.asyncio
    async def test_delete_user_non_existent(self, db_conn):
        assert await database.delete_user(9999) is False


# ------------------------------------------------------------------ #
# API Keys CRUD
# ------------------------------------------------------------------ #


class TestApiKeys:
    @pytest.mark.asyncio
    async def test_add_api_key_auto_creates_user(self, db_conn):
        """add_api_key should auto-create a user if it doesn't exist."""
        result = await database.add_api_key(tg_user_id=1001)
        assert result is not None
        assert result["key"].startswith("sk-s12ryt-")
        assert result["is_active"] == 1
        # Verify user was created
        user = await database.get_user_by_tg_id(1001)
        assert user is not None

    @pytest.mark.asyncio
    async def test_add_api_key_format(self, db_conn):
        """API key should follow sk-s12ryt-{uuid-v7} format."""
        result = await database.add_api_key(tg_user_id=1002)
        assert result is not None
        key = result["key"]
        assert key.startswith("sk-s12ryt-")
        # UUID v7 is a standard 32-char hex string (with hyphens = 36 chars)
        uuid_part = key[len("sk-s12ryt-"):]
        uuid_pattern = re.compile(
            r"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
            re.IGNORECASE,
        )
        assert uuid_pattern.match(uuid_part), f"UUID part '{uuid_part}' does not match UUID v7 format"

    @pytest.mark.asyncio
    async def test_get_keys_by_user(self, db_conn):
        await database.add_api_key(1101)
        await database.add_api_key(1101)
        keys = await database.get_keys_by_user(1101)
        assert len(keys) == 2
        assert all(k["key"].startswith("sk-s12ryt-") for k in keys)

    @pytest.mark.asyncio
    async def test_get_key_by_value(self, db_conn):
        created = await database.add_api_key(1201)
        found = await database.get_key_by_value(created["key"])
        assert found is not None
        assert found["key"] == created["key"]

    @pytest.mark.asyncio
    async def test_get_key_by_value_not_found(self, db_conn):
        assert await database.get_key_by_value("nonexistent-key") is None

    @pytest.mark.asyncio
    async def test_delete_api_key(self, db_conn):
        created = await database.add_api_key(1301)
        assert await database.delete_api_key(created["id"]) is True
        assert await database.get_key_by_value(created["key"]) is None

    @pytest.mark.asyncio
    async def test_delete_api_key_non_existent(self, db_conn):
        assert await database.delete_api_key(9999) is False

    @pytest.mark.asyncio
    async def test_get_all_keys(self, db_conn):
        await database.add_api_key(1401)
        await database.add_api_key(1402)
        keys = await database.get_all_keys()
        assert len(keys) == 2
        # Should include user info
        for k in keys:
            assert "tg_user_id" in k
            assert "username" in k


# ------------------------------------------------------------------ #
# Usage CRUD
# ------------------------------------------------------------------ #


class TestUsage:
    @pytest.mark.asyncio
    async def _setup_provider_and_key(self):
        """Helper: create a provider and API key, return (provider_id, api_key_id)."""
        provider = await database.add_provider(
            "test-prov", "openai_chat", "https://a.com", "pk"
        )
        key = await database.add_api_key(2001)
        return provider["id"], key["id"]

    async def test_record_usage(self, db_conn):
        provider_id, key_id = await self._setup_provider_and_key()
        result = await database.record_usage(
            api_key_id=key_id,
            provider_id=provider_id,
            input_tokens=100,
            output_tokens=50,
            input_cost=0.01,
            output_cost=0.02,
            model="gpt-4",
        )
        assert result is not None
        assert result["input_tokens"] == 100
        assert result["output_tokens"] == 50
        assert result["input_cost"] == 0.01
        assert result["output_cost"] == 0.02
        assert result["model"] == "gpt-4"

    async def test_get_usage_by_key(self, db_conn):
        provider_id, key_id = await self._setup_provider_and_key()
        await database.record_usage(key_id, provider_id, 100, 50, 0.01, 0.02, "gpt-4")
        await database.record_usage(key_id, provider_id, 200, 100, 0.02, 0.04, "gpt-4")
        records = await database.get_usage_by_key(key_id)
        assert len(records) == 2

    async def test_get_usage_by_provider(self, db_conn):
        provider_id, key_id = await self._setup_provider_and_key()
        await database.record_usage(key_id, provider_id, 100, 50, 0.01, 0.02, "gpt-4")
        records = await database.get_usage_by_provider(provider_id)
        assert len(records) == 1
        assert records[0]["model"] == "gpt-4"

    async def test_get_total_usage(self, db_conn):
        provider_id, key_id = await self._setup_provider_and_key()
        await database.record_usage(key_id, provider_id, 100, 50, 0.01, 0.02, "gpt-4")
        await database.record_usage(key_id, provider_id, 200, 100, 0.02, 0.04, "gpt-4")
        total = await database.get_total_usage()
        assert total["total_requests"] == 2
        assert total["total_input_tokens"] == 300
        assert total["total_output_tokens"] == 150
        assert abs(total["total_input_cost"] - 0.03) < 1e-9
        assert abs(total["total_output_cost"] - 0.06) < 1e-9

    async def test_get_total_usage_empty(self, db_conn):
        """When no usage records exist, should return zeros."""
        total = await database.get_total_usage()
        assert total["total_requests"] == 0
        assert total["total_input_tokens"] == 0
        assert total["total_output_tokens"] == 0
        assert total["total_input_cost"] == 0
        assert total["total_output_cost"] == 0


# ------------------------------------------------------------------ #
# Settings CRUD
# ------------------------------------------------------------------ #


class TestSettings:
    @pytest.mark.asyncio
    async def test_get_setting_non_existent(self, db_conn):
        assert await database.get_setting("no_such_key") is None

    @pytest.mark.asyncio
    async def test_set_and_get_setting(self, db_conn):
        await database.set_setting("theme", "dark")
        value = await database.get_setting("theme")
        assert value == "dark"

    @pytest.mark.asyncio
    async def test_set_setting_upsert(self, db_conn):
        """Updating an existing key should overwrite the value."""
        await database.set_setting("lang", "en")
        await database.set_setting("lang", "zh-TW")
        value = await database.get_setting("lang")
        assert value == "zh-TW"

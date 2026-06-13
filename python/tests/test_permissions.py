"""
Unit tests for the permission system.
Covers: User Groups CRUD, Effective Limits calculation, Quota Queries, is_expired.
"""

import os

import pytest

os.environ.setdefault("BOT_TOKEN", "test-bot-token")
os.environ.setdefault("ADMIN_ID", "123456")
os.environ.setdefault("API_PORT", "8000")
os.environ.setdefault("DATABASE_PATH", "./data/test_bot.db")
os.environ.setdefault("DEFAULT_API_URL", "http://localhost:8000")

from db import database  # noqa: E402


# ------------------------------------------------------------------ #
# User Groups CRUD
# ------------------------------------------------------------------ #


class TestUserGroups:
    @pytest.mark.asyncio
    async def test_default_group_seeded(self, db_conn):
        """init_db should seed a default user group."""
        default = await database.get_default_user_group()
        assert default is not None
        assert default["name"] == "default"
        assert default["is_default"] == 1

    @pytest.mark.asyncio
    async def test_get_user_groups(self, db_conn):
        """get_user_groups should return all groups with default first."""
        await database.add_user_group("premium", display_name="Premium")
        groups = await database.get_user_groups()
        assert len(groups) >= 2
        assert groups[0]["is_default"] == 1  # default first
        names = {g["name"] for g in groups}
        assert "default" in names
        assert "premium" in names

    @pytest.mark.asyncio
    async def test_get_group_by_id(self, db_conn):
        group = await database.add_user_group("basic", display_name="Basic")
        assert group is not None
        fetched = await database.get_user_group_by_id(group["id"])
        assert fetched is not None
        assert fetched["name"] == "basic"

    @pytest.mark.asyncio
    async def test_get_group_by_name(self, db_conn):
        await database.add_user_group("vip", display_name="VIP")
        fetched = await database.get_user_group_by_name("vip")
        assert fetched is not None
        assert fetched["display_name"] == "VIP"

    @pytest.mark.asyncio
    async def test_add_duplicate_group_returns_none(self, db_conn):
        first = await database.add_user_group("test_dup", display_name="Test")
        assert first is not None
        second = await database.add_user_group("test_dup", display_name="Test")
        assert second is None

    @pytest.mark.asyncio
    async def test_update_group(self, db_conn):
        group = await database.add_user_group("editable", rpm_limit=10)
        updated = await database.update_user_group(group["id"], rpm_limit=60, tpm_limit=10000)
        assert updated["rpm_limit"] == 60
        assert updated["tpm_limit"] == 10000

    @pytest.mark.asyncio
    async def test_delete_group_moves_users_to_default(self, db_conn):
        """Deleting a non-default group moves its users to the default group."""
        default = await database.get_default_user_group()
        group = await database.add_user_group("temp_group")

        user = await database.add_user(tg_user_id=11111)
        await database.set_user_group(user["id"], group["id"])

        await database.delete_user_group(group["id"])

        # User should now be in default group
        updated_user = await database.get_user_with_limits(user["id"])
        assert updated_user["group_id"] == default["id"]

    @pytest.mark.asyncio
    async def test_cannot_delete_default_group(self, db_conn):
        default = await database.get_default_user_group()
        with pytest.raises(ValueError, match="Cannot delete the default"):
            await database.delete_user_group(default["id"])


# ------------------------------------------------------------------ #
# Effective Limits
# ------------------------------------------------------------------ #


class TestEffectiveLimits:
    @pytest.mark.asyncio
    async def test_all_zero_unlimited(self, db_conn):
        """With default group (all 0), effective limits should be 0 (unlimited)."""
        user = await database.add_user(tg_user_id=22222)
        key = await database.add_api_key(user["id"])
        limits = await database.get_effective_limits(user["id"], key["id"])
        assert limits["rpm"] == 0
        assert limits["tpm"] == 0
        assert limits["concurrency"] == 0
        assert limits["daily_token_limit"] == 0
        assert limits["monthly_token_limit"] == 0
        assert limits["daily_cost_limit"] == 0
        assert limits["monthly_cost_limit"] == 0
        assert limits["expires_at"] is None

    @pytest.mark.asyncio
    async def test_group_limits_apply(self, db_conn):
        group = await database.add_user_group("limited", rpm_limit=30, tpm_limit=5000)
        user = await database.add_user(tg_user_id=33333)
        await database.set_user_group(user["id"], group["id"])
        key = await database.add_api_key(user["id"])

        limits = await database.get_effective_limits(user["id"], key["id"])
        assert limits["rpm"] == 30
        assert limits["tpm"] == 5000

    @pytest.mark.asyncio
    async def test_user_override_beats_group(self, db_conn):
        group = await database.add_user_group("g1", rpm_limit=30)
        user = await database.add_user(tg_user_id=44444)
        await database.set_user_group(user["id"], group["id"])
        await database.set_user_overrides(user["id"], rpm_override=100)
        key = await database.add_api_key(user["id"])

        limits = await database.get_effective_limits(user["id"], key["id"])
        assert limits["rpm"] == 100  # user override wins

    @pytest.mark.asyncio
    async def test_api_key_override_beats_user_and_group(self, db_conn):
        group = await database.add_user_group("g2", rpm_limit=30)
        user = await database.add_user(tg_user_id=55555)
        await database.set_user_group(user["id"], group["id"])
        await database.set_user_overrides(user["id"], rpm_override=100)
        key = await database.add_api_key(user["id"])
        await database.set_api_key_overrides(key["id"], rpm_override=200)

        limits = await database.get_effective_limits(user["id"], key["id"])
        assert limits["rpm"] == 200  # api key override wins

    @pytest.mark.asyncio
    async def test_expiry_from_user(self, db_conn):
        user = await database.add_user(tg_user_id=66666)
        await database.set_user_overrides(user["id"], expires_at="2099-12-31T23:59:59Z")
        key = await database.add_api_key(user["id"])

        limits = await database.get_effective_limits(user["id"], key["id"])
        assert limits["expires_at"] == "2099-12-31T23:59:59Z"

    @pytest.mark.asyncio
    async def test_api_key_expiry_overrides_user(self, db_conn):
        user = await database.add_user(tg_user_id=77777)
        await database.set_user_overrides(user["id"], expires_at="2099-12-31T23:59:59Z")
        key = await database.add_api_key(user["id"])
        await database.set_api_key_overrides(key["id"], expires_at="2025-06-30T00:00:00Z")

        limits = await database.get_effective_limits(user["id"], key["id"])
        assert limits["expires_at"] == "2025-06-30T00:00:00Z"


# ------------------------------------------------------------------ #
# Quota Queries
# ------------------------------------------------------------------ #


class TestQuotaQueries:
    @pytest.mark.asyncio
    async def test_zero_usage_for_new_user(self, db_conn):
        user = await database.add_user(tg_user_id=88888)
        daily = await database.get_daily_usage(user["id"])
        monthly = await database.get_monthly_usage(user["id"])
        assert daily["total_tokens"] == 0
        assert daily["total_cost"] == 0
        assert monthly["total_tokens"] == 0
        assert monthly["total_cost"] == 0

    @pytest.mark.asyncio
    async def test_daily_usage_calculated(self, db_conn):
        user = await database.add_user(tg_user_id=99999)
        key = await database.add_api_key(user["tg_user_id"])
        # Add a provider for the usage record
        provider = await database.add_provider(
            name="test-provider",
            api_type="openai_chat",
            base_url="https://api.test.com",
            api_key="sk-test-123",
            models="gpt-4o",
        )
        await database.record_usage(
            api_key_id=key["id"],
            provider_id=provider["id"],
            input_tokens=100,
            output_tokens=50,
            input_cost=0.001,
            output_cost=0.002,
            model="gpt-4o",
        )
        await database._flush_usage_queue()

        daily = await database.get_daily_usage(user["id"])
        assert daily["total_tokens"] == 150
        assert daily["total_cost"] == pytest.approx(0.003)

    @pytest.mark.asyncio
    async def test_usage_filtered_by_api_key(self, db_conn):
        user = await database.add_user(tg_user_id=11112)
        key1 = await database.add_api_key(user["tg_user_id"])
        key2 = await database.add_api_key(user["tg_user_id"])
        provider = await database.add_provider(
            name="test-provider2",
            api_type="openai_chat",
            base_url="https://api.test.com",
            api_key="sk-test-456",
            models="gpt-4o",
        )
        await database.record_usage(
            api_key_id=key1["id"],
            provider_id=provider["id"],
            input_tokens=100,
            output_tokens=50,
            input_cost=0.001,
            output_cost=0.002,
            model="gpt-4o",
        )
        await database.record_usage(
            api_key_id=key2["id"],
            provider_id=provider["id"],
            input_tokens=200,
            output_tokens=100,
            input_cost=0.002,
            output_cost=0.004,
            model="gpt-4o",
        )
        await database._flush_usage_queue()

        daily_key1 = await database.get_daily_usage(user["id"], key1["id"])
        assert daily_key1["total_tokens"] == 150

        daily_all = await database.get_daily_usage(user["id"])
        assert daily_all["total_tokens"] == 450


# ------------------------------------------------------------------ #
# is_expired
# ------------------------------------------------------------------ #


class TestIsExpired:
    def test_none_not_expired(self):
        assert database.is_expired(None) is False

    def test_future_not_expired(self):
        assert database.is_expired("2099-12-31T23:59:59Z") is False

    def test_past_expired(self):
        assert database.is_expired("2020-01-01T00:00:00Z") is True

    def test_invalid_string_not_expired(self):
        assert database.is_expired("not-a-date") is False

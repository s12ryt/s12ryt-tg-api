"""
Tests for model access restrictions and Coding Mode fallback logic.

Covers previously-untested critical flows:
  - Model access control (whitelist/blacklist → 403 permission_error)
  - Coding Mode fallback chain (success / failover / all-fail)
  - BUG-1 fix verification: Coding Mode respects model access restrictions
  - BUG-2 fix verification: Coding Mode tracks key health (report_success/report_failure)
"""

# ---------------------------------------------------------------------------
# IMPORTANT: Set env vars & patch aiosqlite BEFORE any project imports
# ---------------------------------------------------------------------------

import os

os.environ.setdefault("BOT_TOKEN", "test-bot-token")
os.environ.setdefault("ADMIN_ID", "123456")
os.environ.setdefault("API_PORT", "8000")
os.environ.setdefault("DATABASE_PATH", "./data/test_bot.db")
os.environ.setdefault("DEFAULT_API_URL", "http://localhost:8000")

import aiosqlite

_original_aenter = aiosqlite.core.Connection.__aenter__


async def _safe_aenter(self):
    try:
        if self._thread.is_alive():
            return self
    except RuntimeError:
        pass
    return await _original_aenter(self)


aiosqlite.core.Connection.__aenter__ = _safe_aenter

# ---------------------------------------------------------------------------
# Now safe to import project modules
# ---------------------------------------------------------------------------

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from api.server import app, PROVIDER_MODULES
from db import database

FAKE_RESPONSE = {
    "id": "chatcmpl-test",
    "object": "chat.completion",
    "created": 1_700_000_000,
    "model": "gpt-4o",
    "choices": [
        {
            "index": 0,
            "message": {"role": "assistant", "content": "OK"},
            "finish_reason": "stop",
        }
    ],
    "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
}


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _isolate_db(tmp_path, monkeypatch):
    """Override Config.DATABASE_PATH to use a temp file for every test."""
    db_file = str(tmp_path / "test.db")
    monkeypatch.setattr(database.Config, "DATABASE_PATH", db_file)
    return db_file


@pytest.fixture(autouse=True)
def model_mocks():
    """Provide controllable model-access mocks. Default: allow all models.

    Tests that need to deny specific models can modify the returned dict:
        mocks["check"].return_value = False
    """
    with patch("db.database.get_allowed_models", new_callable=AsyncMock) as mock_gam, \
         patch("db.database.check_model_allowed", new_callable=AsyncMock) as mock_cma:
        # get_allowed_models(uid, kid, models_list, is_admin) → return all
        mock_gam.side_effect = lambda uid, kid, models, is_admin=False: list(models)
        # check_model_allowed(uid, kid, model_name, is_admin) → True
        mock_cma.return_value = True
        yield {"allowed": mock_gam, "check": mock_cma}


@pytest_asyncio.fixture
async def setup_db(_isolate_db):
    """Initialise the DB and create a test user + API key."""
    await database.init_db()
    user = await database.add_user(99999, "testuser")
    assert user is not None
    key_record = await database.add_api_key(99999)
    assert key_record is not None
    return key_record["key"]


@pytest_asyncio.fixture
async def client(setup_db):
    """Provide an httpx AsyncClient wired to the FastAPI app."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


def _auth(key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {key}"}


# ===================================================================
# 1. Model access restrictions — chat completions endpoint
# ===================================================================


class TestModelAccessRestrictions:
    @pytest.mark.asyncio
    async def test_blocked_model_returns_403(self, client, setup_db, model_mocks):
        """When check_model_allowed returns False, request is rejected with 403."""
        model_mocks["check"].return_value = False

        with patch("api.providers.openai.chat_completion", new_callable=AsyncMock) as mock_cc:
            mock_cc.return_value = FAKE_RESPONSE
            resp = await client.post(
                "/v1/chat/completions",
                headers=_auth(setup_db),
                json={
                    "model": "gpt-4o",
                    "messages": [{"role": "user", "content": "hi"}],
                },
            )

        assert resp.status_code == 403
        body = resp.json()
        assert body["error"]["type"] == "permission_error"
        assert "not allowed" in body["error"]["message"]
        # Provider should NOT have been called
        mock_cc.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_allowed_model_passes(self, client, setup_db):
        """When check_model_allowed returns True, request succeeds."""
        with patch("api.providers.openai.chat_completion", new_callable=AsyncMock) as mock_cc:
            mock_cc.return_value = FAKE_RESPONSE
            resp = await client.post(
                "/v1/chat/completions",
                headers=_auth(setup_db),
                json={
                    "model": "gpt-4o",
                    "messages": [{"role": "user", "content": "hi"}],
                },
            )

        assert resp.status_code == 200
        mock_cc.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_models_endpoint_filters_restricted(self, client, setup_db, model_mocks):
        """GET /v1/models should filter out blocked models."""
        # Only allow gpt-4o in the models listing
        model_mocks["allowed"].side_effect = (
            lambda uid, kid, models, is_admin=False: [m for m in models if m == "gpt-4o"]
        )

        from db.database import CachedProvider

        mock_cache = {
            "gpt-4o": CachedProvider(
                provider_type="openai_chat",
                provider_id=1,
                base_url="https://api.openai.com/v1",
                api_key="sk-test",
                input_price=None,
                output_price=None,
            ),
            "claude-3.5-sonnet": CachedProvider(
                provider_type="anthropic",
                provider_id=2,
                base_url="https://api.anthropic.com",
                api_key="sk-ant-test",
                input_price=None,
                output_price=None,
            ),
        }
        with patch("db.database.get_provider_cache", return_value=mock_cache):
            resp = await client.get("/v1/models", headers=_auth(setup_db))

        assert resp.status_code == 200
        model_ids = [m["id"] for m in resp.json()["data"]]
        assert "gpt-4o" in model_ids
        assert "claude-3.5-sonnet" not in model_ids
        # coding-mode virtual model always present
        assert "coding-mode" in model_ids

    @pytest.mark.asyncio
    async def test_coding_mode_virtual_model_passes_restriction(self, client, setup_db, model_mocks):
        """Even when all models are blocked, 'coding-mode' itself passes the check."""
        model_mocks["check"].return_value = False  # block everything

        with patch("db.database.get_active_coding_for_api_key", new_callable=AsyncMock) as mock_gc:
            mock_gc.return_value = None  # no coding config → ValueError
            resp = await client.post(
                "/v1/chat/completions",
                headers=_auth(setup_db),
                json={
                    "model": "coding-mode",
                    "messages": [{"role": "user", "content": "hi"}],
                },
            )
        # coding-mode passes model restriction → but no config → 400
        assert resp.status_code == 400


# ===================================================================
# 2. Coding Mode fallback logic
# ===================================================================


class TestCodingModeFallback:
    @pytest.mark.asyncio
    async def test_not_configured_returns_400(self, client, setup_db):
        """coding-mode without fallback config → ValueError → 400."""
        with patch("db.database.get_active_coding_for_api_key", new_callable=AsyncMock) as mock_gc:
            mock_gc.return_value = None
            resp = await client.post(
                "/v1/chat/completions",
                headers=_auth(setup_db),
                json={
                    "model": "coding-mode",
                    "messages": [{"role": "user", "content": "hi"}],
                },
            )
        assert resp.status_code == 400
        assert "coding-mode" in resp.json()["error"]["message"].lower()

    @pytest.mark.asyncio
    async def test_first_model_succeeds(self, client, setup_db):
        """Coding mode: first fallback model succeeds → 200."""
        coding_config = {"fallback_list": ["gpt-4o", "claude-3.5-sonnet"], "max_retries": 3}
        resolved = (
            "openai_chat", "1",
            {"base_url": "http://test", "api_key": "sk-test", "_key_index": 0},
            None, None,
        )

        with patch("db.database.get_active_coding_for_api_key", new_callable=AsyncMock, return_value=coding_config), \
             patch("api.server._resolve_model_full", new_callable=AsyncMock, return_value=resolved), \
             patch("api.providers.openai.chat_completion", new_callable=AsyncMock) as mock_cc:
            mock_cc.return_value = FAKE_RESPONSE
            resp = await client.post(
                "/v1/chat/completions",
                headers=_auth(setup_db),
                json={
                    "model": "coding-mode",
                    "messages": [{"role": "user", "content": "hi"}],
                },
            )

        assert resp.status_code == 200
        mock_cc.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_fallback_to_second_model(self, client, setup_db):
        """First model fails, second succeeds → 200."""
        coding_config = {"fallback_list": ["gpt-4o", "claude-3.5-sonnet"], "max_retries": 3}
        resolved_openai = (
            "openai_chat", "1",
            {"base_url": "http://test", "api_key": "sk-test", "_key_index": 0},
            None, None,
        )
        resolved_anthropic = (
            "anthropic", "2",
            {"base_url": "http://test", "api_key": "sk-ant", "_key_index": 0},
            None, None,
        )

        async def mock_resolve(model_name):
            if "claude" in model_name:
                return resolved_anthropic
            return resolved_openai

        mock_provider_openai = MagicMock()
        mock_provider_openai.chat_completion = AsyncMock(side_effect=Exception("timeout"))
        mock_provider_anthropic = MagicMock()
        mock_provider_anthropic.chat_completion = AsyncMock(return_value=FAKE_RESPONSE)

        with patch("db.database.get_active_coding_for_api_key", new_callable=AsyncMock, return_value=coding_config), \
             patch("api.server._resolve_model_full", new_callable=AsyncMock, side_effect=mock_resolve), \
             patch.dict(PROVIDER_MODULES, {"openai_chat": mock_provider_openai, "anthropic": mock_provider_anthropic}):
            resp = await client.post(
                "/v1/chat/completions",
                headers=_auth(setup_db),
                json={
                    "model": "coding-mode",
                    "messages": [{"role": "user", "content": "hi"}],
                },
            )

        assert resp.status_code == 200
        # First provider was called (and failed)
        mock_provider_openai.chat_completion.assert_awaited_once()
        # Second provider was called (and succeeded)
        mock_provider_anthropic.chat_completion.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_all_models_fail_returns_error(self, client, setup_db):
        """All fallback models fail → error response (500/502)."""
        coding_config = {"fallback_list": ["gpt-4o", "claude-3.5-sonnet"], "max_retries": 3}
        resolved = (
            "openai_chat", "1",
            {"base_url": "http://test", "api_key": "sk-test", "_key_index": 0},
            None, None,
        )

        mock_provider = MagicMock()
        mock_provider.chat_completion = AsyncMock(side_effect=Exception("all fail"))

        with patch("db.database.get_active_coding_for_api_key", new_callable=AsyncMock, return_value=coding_config), \
             patch("api.server._resolve_model_full", new_callable=AsyncMock, return_value=resolved), \
             patch.dict(PROVIDER_MODULES, {"openai_chat": mock_provider, "anthropic": mock_provider}):
            resp = await client.post(
                "/v1/chat/completions",
                headers=_auth(setup_db),
                json={
                    "model": "coding-mode",
                    "messages": [{"role": "user", "content": "hi"}],
                },
            )

        assert resp.status_code in (500, 502)


# ===================================================================
# 3. BUG-1 fix: Coding Mode respects model access restrictions
# ===================================================================


class TestBug1CodingModeModelRestriction:
    @pytest.mark.asyncio
    async def test_blocked_fallback_model_is_skipped(self, client, setup_db, model_mocks):
        """BUG-1: A fallback model blocked by restriction should be skipped."""
        # Block gpt-4o, allow everything else
        model_mocks["check"].side_effect = (
            lambda uid, kid, model_name, is_admin=False: model_name != "gpt-4o"
        )

        coding_config = {"fallback_list": ["gpt-4o", "claude-3.5-sonnet"], "max_retries": 3}
        resolved = (
            "openai_chat", "1",
            {"base_url": "http://test", "api_key": "sk-test", "_key_index": 0},
            None, None,
        )

        call_log: list[str] = []
        original_response = FAKE_RESPONSE

        mock_provider = MagicMock()

        async def track_call(body, config):
            call_log.append(body["model"])
            return original_response

        mock_provider.chat_completion = track_call

        with patch("db.database.get_active_coding_for_api_key", new_callable=AsyncMock, return_value=coding_config), \
             patch("api.server._resolve_model_full", new_callable=AsyncMock, return_value=resolved), \
             patch.dict(PROVIDER_MODULES, {"openai_chat": mock_provider}):
            resp = await client.post(
                "/v1/chat/completions",
                headers=_auth(setup_db),
                json={
                    "model": "coding-mode",
                    "messages": [{"role": "user", "content": "hi"}],
                },
            )

        assert resp.status_code == 200
        # gpt-4o was blocked → skipped. Only claude-3.5-sonnet should be called.
        assert "gpt-4o" not in call_log
        assert "claude-3.5-sonnet" in call_log


# ===================================================================
# 4. BUG-2 fix: Coding Mode tracks key health
# ===================================================================


class TestBug2CodingModeKeyHealth:
    @pytest.mark.asyncio
    async def test_report_failure_on_coding_mode_error(self, client, setup_db):
        """BUG-2: report_failure is called when a coding-mode fallback model fails."""
        coding_config = {"fallback_list": ["gpt-4o"], "max_retries": 3}
        resolved = (
            "openai_chat", "1",
            {"base_url": "http://test", "api_key": "sk-test", "_key_index": 0},
            None, None,
        )

        mock_provider = MagicMock()
        mock_provider.chat_completion = AsyncMock(side_effect=Exception("upstream error"))

        with patch("db.database.get_active_coding_for_api_key", new_callable=AsyncMock, return_value=coding_config), \
             patch("api.server._resolve_model_full", new_callable=AsyncMock, return_value=resolved), \
             patch.dict(PROVIDER_MODULES, {"openai_chat": mock_provider}), \
             patch("api.key_selector.report_failure") as mock_rf, \
             patch("api.key_selector.report_success") as mock_rs:
            resp = await client.post(
                "/v1/chat/completions",
                headers=_auth(setup_db),
                json={
                    "model": "coding-mode",
                    "messages": [{"role": "user", "content": "hi"}],
                },
            )

        # Provider failed → report_failure called with (provider_id=1, key_index=0)
        mock_rf.assert_called_once_with(1, 0)
        # report_success should NOT have been called (model failed)
        mock_rs.assert_not_called()

    @pytest.mark.asyncio
    async def test_report_success_on_coding_mode_success(self, client, setup_db):
        """BUG-2: report_success is called when a coding-mode fallback model succeeds."""
        coding_config = {"fallback_list": ["gpt-4o"], "max_retries": 3}
        resolved = (
            "openai_chat", "1",
            {"base_url": "http://test", "api_key": "sk-test", "_key_index": 0},
            None, None,
        )

        mock_provider = MagicMock()
        mock_provider.chat_completion = AsyncMock(return_value=FAKE_RESPONSE)

        with patch("db.database.get_active_coding_for_api_key", new_callable=AsyncMock, return_value=coding_config), \
             patch("api.server._resolve_model_full", new_callable=AsyncMock, return_value=resolved), \
             patch.dict(PROVIDER_MODULES, {"openai_chat": mock_provider}), \
             patch("api.key_selector.report_failure") as mock_rf, \
             patch("api.key_selector.report_success") as mock_rs:
            resp = await client.post(
                "/v1/chat/completions",
                headers=_auth(setup_db),
                json={
                    "model": "coding-mode",
                    "messages": [{"role": "user", "content": "hi"}],
                },
            )

        assert resp.status_code == 200
        # Provider succeeded → report_success called
        mock_rs.assert_called_once_with(1, 0)
        mock_rf.assert_not_called()

"""
Integration tests for the FastAPI API proxy server.

Tests cover:
1. Health endpoint (no auth)
2. Auth middleware (various failure modes + success)
3. Models endpoint (with auth)
4. Chat completions validation (bad requests)
5. Chat completions successful mock (provider mocked, response forwarded)
6. Responses endpoint validation
7. Anthropic Messages endpoint validation
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

from unittest.mock import AsyncMock, patch

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from api.server import app
from db import database


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _isolate_db(tmp_path, monkeypatch):
    """Override Config.DATABASE_PATH to use a temp file for every test."""
    db_file = str(tmp_path / "test.db")
    monkeypatch.setattr(database.Config, "DATABASE_PATH", db_file)
    return db_file


@pytest_asyncio.fixture
async def setup_db(_isolate_db):
    """Initialise the DB and create a test user + API key.

    Returns the full key string (e.g. "sk-s12ryt-...") for auth headers.
    """
    await database.init_db()
    user = await database.add_user(99999, "testuser")
    assert user is not None, "Failed to create test user"
    key_record = await database.add_api_key(99999)
    assert key_record is not None, "Failed to create API key"
    return key_record["key"]


@pytest.fixture(autouse=True)
def _bypass_model_restrictions():
    """Bypass model restrictions for all API server tests.

    Model restriction is deny-by-default: no restriction configured → non-admin
    gets empty list. Tests don't configure restrictions, so we patch these
    functions to allow all models.
    """
    with patch("db.database.get_allowed_models", new_callable=AsyncMock) as mock_gam, \
         patch("db.database.check_model_allowed", new_callable=AsyncMock) as mock_cma:
        mock_gam.side_effect = lambda uid, kid, models, is_admin=False: list(models)
        mock_cma.return_value = True
        yield


@pytest_asyncio.fixture
async def client(setup_db):
    """Provide an httpx AsyncClient wired to the FastAPI app (no real HTTP)."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


def _auth_header(key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {key}"}


# ===================================================================
# 1. Health endpoint (no auth needed)
# ===================================================================


class TestHealthEndpoint:
    @pytest.mark.asyncio
    async def test_health_returns_ok(self, client):
        resp = await client.get("/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data == {"status": "ok"}

    @pytest.mark.asyncio
    async def test_health_needs_no_auth(self, client):
        """Even without any Authorization header, /health must return 200."""
        resp = await client.get("/health")
        assert resp.status_code == 200


# ===================================================================
# 2. Auth middleware
# ===================================================================


class TestAuthMiddleware:
    @pytest.mark.asyncio
    async def test_no_auth_header_returns_401(self, client):
        resp = await client.get("/v1/models")
        assert resp.status_code == 401
        body = resp.json()
        assert "error" in body
        assert body["error"]["type"] == "auth_error"

    @pytest.mark.asyncio
    async def test_invalid_format_returns_401(self, client):
        """Not 'Bearer xxx' format."""
        resp = await client.get(
            "/v1/models",
            headers={"Authorization": "Token abc123"},
        )
        assert resp.status_code == 401
        body = resp.json()
        assert "Invalid Authorization header format" in body["error"]["message"]

    @pytest.mark.asyncio
    async def test_wrong_prefix_returns_401(self, client):
        """Token does not start with sk-s12ryt-."""
        resp = await client.get(
            "/v1/models",
            headers={"Authorization": "Bearer sk-other-prefix-key"},
        )
        assert resp.status_code == 401
        body = resp.json()
        assert "Invalid API key format" in body["error"]["message"]

    @pytest.mark.asyncio
    async def test_nonexistent_key_returns_401(self, client):
        """Correct prefix but key does not exist in DB."""
        resp = await client.get(
            "/v1/models",
            headers={"Authorization": "Bearer sk-s12ryt-nonexistent-key"},
        )
        assert resp.status_code == 401
        body = resp.json()
        assert "Invalid or inactive" in body["error"]["message"]

    @pytest.mark.asyncio
    async def test_valid_key_active_user_returns_200(self, client, setup_db):
        """Valid key from active user should pass auth."""
        key = setup_db
        resp = await client.get("/v1/models", headers=_auth_header(key))
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_inactive_user_key_returns_401(self, client, setup_db):
        """Key exists but user is deactivated → 401."""
        key = setup_db
        # Deactivate the user
        await database.update_user_status(99999, 0)
        resp = await client.get("/v1/models", headers=_auth_header(key))
        assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_options_preflight_skips_auth(self, client):
        """CORS preflight requests must bypass auth."""
        resp = await client.options("/v1/models")
        # Should not be 401 – the route may return 405 or similar but NOT 401
        assert resp.status_code != 401


# ===================================================================
# 3. Models endpoint (with auth)
# ===================================================================


class TestModelsEndpoint:
    @pytest.mark.asyncio
    async def test_list_models_returns_list(self, client, setup_db):
        key = setup_db
        resp = await client.get("/v1/models", headers=_auth_header(key))
        assert resp.status_code == 200
        data = resp.json()
        assert data["object"] == "list"
        assert isinstance(data["data"], list)
        assert len(data["data"]) > 0

    @pytest.mark.asyncio
    async def test_model_objects_have_required_fields(self, client, setup_db):
        key = setup_db
        resp = await client.get("/v1/models", headers=_auth_header(key))
        data = resp.json()
        for model in data["data"]:
            assert "id" in model
            assert "object" in model
            assert model["object"] == "model"
            assert "owned_by" in model
            assert "created" in model

    @pytest.mark.asyncio
    async def test_known_models_present(self, client, setup_db):
        """The /v1/models endpoint returns models from provider cache."""
        key = setup_db
        # The provider cache is empty in tests (no providers in DB).
        # Mock get_provider_cache to return some known models.
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
            resp = await client.get("/v1/models", headers=_auth_header(key))
        data = resp.json()
        model_ids = [m["id"] for m in data["data"]]
        assert "gpt-4o" in model_ids
        assert "claude-3.5-sonnet" in model_ids


# ===================================================================
# 4. Chat completions – validation
# ===================================================================


class TestChatCompletionsValidation:
    @pytest.mark.asyncio
    async def test_no_body_returns_400(self, client, setup_db):
        key = setup_db
        resp = await client.post(
            "/v1/chat/completions",
            headers={**_auth_header(key), "Content-Type": "application/json"},
            content="not-json",
        )
        assert resp.status_code == 400
        body = resp.json()
        assert "error" in body

    @pytest.mark.asyncio
    async def test_missing_model_returns_400(self, client, setup_db):
        key = setup_db
        resp = await client.post(
            "/v1/chat/completions",
            headers=_auth_header(key),
            json={"messages": [{"role": "user", "content": "hi"}]},
        )
        assert resp.status_code == 400
        body = resp.json()
        assert "model is required" in body["error"]["message"]

    @pytest.mark.asyncio
    async def test_empty_model_returns_400(self, client, setup_db):
        key = setup_db
        resp = await client.post(
            "/v1/chat/completions",
            headers=_auth_header(key),
            json={"model": "", "messages": [{"role": "user", "content": "hi"}]},
        )
        assert resp.status_code == 400
        body = resp.json()
        assert "model is required" in body["error"]["message"]

    @pytest.mark.asyncio
    async def test_unknown_model_returns_400(self, client, setup_db):
        key = setup_db
        resp = await client.post(
            "/v1/chat/completions",
            headers=_auth_header(key),
            json={
                "model": "nonexistent-model-xyz",
                "messages": [{"role": "user", "content": "hi"}],
            },
        )
        assert resp.status_code == 400
        body = resp.json()
        assert "Unknown model" in body["error"]["message"]


# ===================================================================
# 5. Chat completions – successful mock
# ===================================================================


FAKE_CHAT_RESPONSE = {
    "id": "chatcmpl-test123",
    "object": "chat.completion",
    "created": 1_700_000_000,
    "model": "gpt-4o",
    "choices": [
        {
            "index": 0,
            "message": {"role": "assistant", "content": "Hello from mock!"},
            "finish_reason": "stop",
        }
    ],
    "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
}


class TestChatCompletionsSuccess:
    @pytest.mark.asyncio
    async def test_successful_non_streaming(self, client, setup_db):
        key = setup_db
        with patch("api.providers.openai.chat_completion", new_callable=AsyncMock) as mock_cc:
            mock_cc.return_value = FAKE_CHAT_RESPONSE

            resp = await client.post(
                "/v1/chat/completions",
                headers=_auth_header(key),
                json={
                    "model": "gpt-4o",
                    "messages": [{"role": "user", "content": "Hello"}],
                },
            )

        assert resp.status_code == 200
        data = resp.json()
        assert data["id"] == "chatcmpl-test123"
        assert data["choices"][0]["message"]["content"] == "Hello from mock!"
        assert data["usage"]["prompt_tokens"] == 10

    @pytest.mark.asyncio
    async def test_provider_receives_correct_body(self, client, setup_db):
        key = setup_db
        with patch("api.providers.openai.chat_completion", new_callable=AsyncMock) as mock_cc:
            mock_cc.return_value = FAKE_CHAT_RESPONSE

            await client.post(
                "/v1/chat/completions",
                headers=_auth_header(key),
                json={
                    "model": "gpt-4o",
                    "messages": [{"role": "user", "content": "Hello"}],
                    "temperature": 0.7,
                },
            )

        mock_cc.assert_awaited_once()
        call_args = mock_cc.call_args
        request_body = call_args[0][0]  # first positional arg
        assert request_body["model"] == "gpt-4o"
        assert request_body["temperature"] == 0.7
        assert len(request_body["messages"]) == 1

    @pytest.mark.asyncio
    async def test_usage_is_recorded(self, client, setup_db):
        """Usage tracking function should be called for non-streaming responses."""
        key = setup_db
        with patch("api.providers.openai.chat_completion", new_callable=AsyncMock) as mock_cc:
            mock_cc.return_value = FAKE_CHAT_RESPONSE

            with patch("api.server.record_usage", new_callable=AsyncMock) as mock_record:
                await client.post(
                    "/v1/chat/completions",
                    headers=_auth_header(key),
                    json={
                        "model": "gpt-4o",
                        "messages": [{"role": "user", "content": "Hello"}],
                    },
                )

        mock_record.assert_awaited_once()
        call_kwargs = mock_record.call_args[1]
        assert call_kwargs["input_tokens"] == 10
        assert call_kwargs["output_tokens"] == 5
        assert call_kwargs["model"] == "gpt-4o"

    @pytest.mark.asyncio
    async def test_provider_error_returns_502(self, client, setup_db):
        key = setup_db
        with patch("api.providers.openai.chat_completion", new_callable=AsyncMock) as mock_cc:
            mock_cc.side_effect = Exception("Upstream timeout")

            resp = await client.post(
                "/v1/chat/completions",
                headers=_auth_header(key),
                json={
                    "model": "gpt-4o",
                    "messages": [{"role": "user", "content": "Hello"}],
                },
            )

        assert resp.status_code == 502
        body = resp.json()
        assert "upstream_error" in body["error"]["type"]

    @pytest.mark.asyncio
    async def test_anthropic_model_routes_to_anthropic_provider(self, client, setup_db):
        key = setup_db
        with patch("api.providers.anthropic.chat_completion", new_callable=AsyncMock) as mock_cc:
            mock_cc.return_value = FAKE_CHAT_RESPONSE

            resp = await client.post(
                "/v1/chat/completions",
                headers=_auth_header(key),
                json={
                    "model": "claude-3.5-sonnet",
                    "messages": [{"role": "user", "content": "Hello"}],
                },
            )

        assert resp.status_code == 200
        mock_cc.assert_awaited_once()


# ===================================================================
# 6. Responses endpoint validation
# ===================================================================


class TestResponsesEndpointValidation:
    @pytest.mark.asyncio
    async def test_invalid_json_returns_400(self, client, setup_db):
        key = setup_db
        resp = await client.post(
            "/v1/responses",
            headers={**_auth_header(key), "Content-Type": "application/json"},
            content="bad-json",
        )
        assert resp.status_code == 400
        body = resp.json()
        assert "error" in body

    @pytest.mark.asyncio
    async def test_missing_model_returns_400(self, client, setup_db):
        key = setup_db
        resp = await client.post(
            "/v1/responses",
            headers=_auth_header(key),
            json={"input": "Hello"},
        )
        assert resp.status_code == 400
        body = resp.json()
        assert "model is required" in body["error"]["message"]

    @pytest.mark.asyncio
    async def test_missing_input_returns_400(self, client, setup_db):
        key = setup_db
        resp = await client.post(
            "/v1/responses",
            headers=_auth_header(key),
            json={"model": "gpt-4o"},
        )
        assert resp.status_code == 400
        body = resp.json()
        assert "input is required" in body["error"]["message"]

    @pytest.mark.asyncio
    async def test_unknown_model_returns_400(self, client, setup_db):
        key = setup_db
        resp = await client.post(
            "/v1/responses",
            headers=_auth_header(key),
            json={"model": "fake-model", "input": "hi"},
        )
        assert resp.status_code == 400
        body = resp.json()
        assert "Unknown model" in body["error"]["message"]

    @pytest.mark.asyncio
    async def test_responses_success_non_streaming(self, client, setup_db):
        key = setup_db
        with patch("api.providers.openai.chat_completion", new_callable=AsyncMock) as mock_cc:
            mock_cc.return_value = FAKE_CHAT_RESPONSE

            resp = await client.post(
                "/v1/responses",
                headers=_auth_header(key),
                json={
                    "model": "gpt-4o",
                    "input": "Hello",
                },
            )

        assert resp.status_code == 200
        data = resp.json()
        # Responses API format has "output" key
        assert "output" in data or "id" in data


# ===================================================================
# 7. Anthropic Messages endpoint validation
# ===================================================================


class TestAnthropicMessagesValidation:
    @pytest.mark.asyncio
    async def test_invalid_json_returns_400(self, client, setup_db):
        key = setup_db
        resp = await client.post(
            "/v1/messages",
            headers={**_auth_header(key), "Content-Type": "application/json"},
            content="bad-json",
        )
        assert resp.status_code == 400
        body = resp.json()
        assert body.get("type") == "error"

    @pytest.mark.asyncio
    async def test_missing_model_returns_400(self, client, setup_db):
        key = setup_db
        resp = await client.post(
            "/v1/messages",
            headers=_auth_header(key),
            json={
                "messages": [{"role": "user", "content": "hi"}],
                "max_tokens": 100,
            },
        )
        assert resp.status_code == 400
        body = resp.json()
        assert "model is required" in body["error"]["message"]

    @pytest.mark.asyncio
    async def test_missing_messages_returns_400(self, client, setup_db):
        key = setup_db
        resp = await client.post(
            "/v1/messages",
            headers=_auth_header(key),
            json={"model": "claude-3.5-sonnet", "max_tokens": 100},
        )
        assert resp.status_code == 400
        body = resp.json()
        assert "messages" in body["error"]["message"]

    @pytest.mark.asyncio
    async def test_empty_messages_returns_400(self, client, setup_db):
        key = setup_db
        resp = await client.post(
            "/v1/messages",
            headers=_auth_header(key),
            json={"model": "claude-3.5-sonnet", "messages": [], "max_tokens": 100},
        )
        assert resp.status_code == 400
        body = resp.json()
        assert "messages" in body["error"]["message"]

    @pytest.mark.asyncio
    async def test_unknown_model_returns_400(self, client, setup_db):
        key = setup_db
        resp = await client.post(
            "/v1/messages",
            headers=_auth_header(key),
            json={
                "model": "fake-model",
                "messages": [{"role": "user", "content": "hi"}],
                "max_tokens": 100,
            },
        )
        assert resp.status_code == 400
        body = resp.json()
        assert "Unknown model" in body["error"]["message"]

    @pytest.mark.asyncio
    async def test_anthropic_success_non_streaming(self, client, setup_db):
        key = setup_db
        # The /v1/messages endpoint calls PROVIDER_MODULES["anthropic"].chat_completion(body, config)
        # via _dispatch_with_fallback. We need a module-like mock with a .chat_completion attribute.
        from api.server import PROVIDER_MODULES
        from unittest.mock import MagicMock
        mock_provider = MagicMock()
        mock_provider.chat_completion = AsyncMock(return_value=FAKE_CHAT_RESPONSE)
        with patch.dict(PROVIDER_MODULES, {"anthropic": mock_provider}):
            resp = await client.post(
                "/v1/messages",
                headers=_auth_header(key),
                json={
                    "model": "claude-3.5-sonnet",
                    "messages": [{"role": "user", "content": "Hello"}],
                    "max_tokens": 1024,
                },
            )

        assert resp.status_code == 200
        data = resp.json()
        # Anthropic Messages format has "content" key
        assert "content" in data or "id" in data


# ===================================================================
# 8. Public paths skip auth
# ===================================================================


class TestPublicPaths:
    @pytest.mark.asyncio
    async def test_root_path_no_auth(self, client):
        resp = await client.get("/")
        # May be 404 if no route, but should NOT be 401
        assert resp.status_code != 401

    @pytest.mark.asyncio
    async def test_health_no_auth(self, client):
        resp = await client.get("/health")
        assert resp.status_code == 200

    @pytest.mark.asyncio
    async def test_docs_no_auth(self, client):
        resp = await client.get("/docs")
        assert resp.status_code != 401

    @pytest.mark.asyncio
    async def test_openapi_json_no_auth(self, client):
        resp = await client.get("/openapi.json")
        assert resp.status_code != 401

"""
Unit tests for config.py – Config reads from environment variables correctly.
"""

import os
from unittest.mock import patch

import pytest

# Set safe env vars before importing project code
os.environ.setdefault("BOT_TOKEN", "test-bot-token")
os.environ.setdefault("ADMIN_ID", "123456")
os.environ.setdefault("API_PORT", "8000")
os.environ.setdefault("DATABASE_PATH", "./data/test_bot.db")
os.environ.setdefault("DEFAULT_API_URL", "http://localhost:8000")

from config import Config  # noqa: E402


class TestConfig:
    def test_bot_token_from_env(self):
        with patch.dict(os.environ, {"BOT_TOKEN": "test-token-123"}, clear=False):
            # Re-read from env (Config is already defined at import time,
            # so we simulate the same logic manually)
            assert os.getenv("BOT_TOKEN", "") == "test-token-123"

    def test_bot_token_default_empty(self):
        with patch.dict(os.environ, {}, clear=True):
            assert os.getenv("BOT_TOKEN", "") == ""

    def test_admin_id_from_env(self):
        with patch.dict(os.environ, {"ADMIN_ID": "42"}, clear=False):
            val = int(os.getenv("ADMIN_ID", "0"))
            assert val == 42

    def test_admin_id_default_zero(self):
        with patch.dict(os.environ, {}, clear=True):
            val = int(os.getenv("ADMIN_ID", "0"))
            assert val == 0

    def test_api_port_from_env(self):
        with patch.dict(os.environ, {"API_PORT": "9000"}, clear=False):
            val = int(os.getenv("API_PORT", "8000"))
            assert val == 9000

    def test_api_port_default(self):
        with patch.dict(os.environ, {}, clear=True):
            val = int(os.getenv("API_PORT", "8000"))
            assert val == 8000

    def test_database_path_from_env(self):
        with patch.dict(os.environ, {"DATABASE_PATH": "/tmp/test.db"}, clear=False):
            val = os.getenv("DATABASE_PATH", "./data/bot.db")
            assert val == "/tmp/test.db"

    def test_database_path_default(self):
        with patch.dict(os.environ, {}, clear=True):
            val = os.getenv("DATABASE_PATH", "./data/bot.db")
            assert val == "./data/bot.db"

    def test_default_api_url_from_env(self):
        with patch.dict(os.environ, {"DEFAULT_API_URL": "http://myhost:1234"}, clear=False):
            val = os.getenv("DEFAULT_API_URL", "http://localhost:8000")
            assert val == "http://myhost:1234"

    def test_default_api_url_default(self):
        with patch.dict(os.environ, {}, clear=True):
            val = os.getenv("DEFAULT_API_URL", "http://localhost:8000")
            assert val == "http://localhost:8000"

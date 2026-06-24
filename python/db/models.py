# Table creation SQL statements

CREATE_TABLE_PROVIDERS = """
CREATE TABLE IF NOT EXISTS providers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    api_type TEXT NOT NULL CHECK(api_type IN ('openai_chat', 'openai_response', 'anthropic', 'google')),
    base_url TEXT NOT NULL,
    api_key TEXT NOT NULL,
    models TEXT DEFAULT '',
    key_strategy TEXT DEFAULT 'failover' CHECK(key_strategy IN ('failover', 'round_robin', 'random')),
    enabled INTEGER DEFAULT 1,
    input_price REAL DEFAULT 0,
    output_price REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);
"""

CREATE_TABLE_USERS = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_user_id INTEGER UNIQUE NOT NULL,
    username TEXT DEFAULT '',
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
);
"""

CREATE_TABLE_API_KEYS = """
CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key TEXT UNIQUE NOT NULL,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
);
"""

CREATE_TABLE_USAGE = """
CREATE TABLE IF NOT EXISTS usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    api_key_id INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
    provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    input_cost REAL DEFAULT 0,
    output_cost REAL DEFAULT 0,
    model TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
);
"""

CREATE_TABLE_SETTINGS = """
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);
"""

CREATE_TABLE_MODEL_PRICES = """
CREATE TABLE IF NOT EXISTS model_prices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    input_price REAL,
    output_price REAL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(provider_id, model)
);
"""

CREATE_TABLE_CODING_CONFIGS = """
CREATE TABLE IF NOT EXISTS coding_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    is_active INTEGER DEFAULT 0,
    fallback_models TEXT DEFAULT '',
    max_retries INTEGER DEFAULT 3,
    session_input_tokens INTEGER DEFAULT 0,
    session_output_tokens INTEGER DEFAULT 0,
    session_input_cost REAL DEFAULT 0.0,
    session_output_cost REAL DEFAULT 0.0,
    session_requests INTEGER DEFAULT 0,
    session_model_counts TEXT DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id)
);
"""

CREATE_TABLE_MODEL_RESTRICTIONS = """
CREATE TABLE IF NOT EXISTS model_restrictions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    api_key_id INTEGER REFERENCES api_keys(id) ON DELETE CASCADE,
    mode TEXT NOT NULL CHECK(mode IN ('whitelist', 'blacklist')) DEFAULT 'whitelist',
    models TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, api_key_id)
);
"""

CREATE_TABLE_USER_GROUPS = """
CREATE TABLE IF NOT EXISTS user_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    display_name TEXT,
    rpm_limit INTEGER DEFAULT 0,
    tpm_limit INTEGER DEFAULT 0,
    concurrency_limit INTEGER DEFAULT 0,
    daily_token_limit INTEGER DEFAULT 0,
    monthly_token_limit INTEGER DEFAULT 0,
    daily_cost_limit REAL DEFAULT 0,
    monthly_cost_limit REAL DEFAULT 0,
    is_default INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);
"""

ALL_TABLES = [
    CREATE_TABLE_PROVIDERS,
    CREATE_TABLE_USERS,
    CREATE_TABLE_API_KEYS,
    CREATE_TABLE_USAGE,
    CREATE_TABLE_SETTINGS,
    CREATE_TABLE_MODEL_PRICES,
    CREATE_TABLE_CODING_CONFIGS,
    CREATE_TABLE_MODEL_RESTRICTIONS,
    CREATE_TABLE_USER_GROUPS,
]

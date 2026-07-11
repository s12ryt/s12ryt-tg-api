/**
 * PostgreSQL DDL for migration 001_base_schema.
 *
 * Translation rules from the authoritative SQLite DDL (createTables):
 * - INTEGER PRIMARY KEY AUTOINCREMENT  ->  SERIAL PRIMARY KEY
 * - TEXT                               ->  TEXT (timestamps stored as TEXT, JSON as TEXT)
 * - REAL                               ->  DOUBLE PRECISION (matches SQLite 8-byte float)
 * - datetime('now')                    ->  to_char(NOW(),'YYYY-MM-DD HH24:MI:SS')
 *   (keeps TEXT format identical to SQLite's 'YYYY-MM-DD HH:MM:SS')
 * - boolean columns (is_active, enabled, is_default)  ->  INTEGER (0/1, three-way consistency)
 *
 * Booleans use INTEGER for cross-dialect consistency: SQLite stores 0/1, and we
 * want identical wire format in backups. PostgresDriver.toPgValue converts
 * boolean -> 0/1 accordingly.
 *
 * Run once on a fresh PG database (guarded by schema_migrations).
 */

export const PG_DDL = `
CREATE TABLE providers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  api_type TEXT NOT NULL CHECK(api_type IN ('openai_chat', 'openai_response', 'anthropic', 'google')),
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  user_agent TEXT NOT NULL DEFAULT '',
  models TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  input_price DOUBLE PRECISION,
  output_price DOUBLE PRECISION,
  created_at TEXT NOT NULL DEFAULT to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT NOT NULL DEFAULT to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS'),
  key_strategy TEXT NOT NULL DEFAULT 'failover'
);

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  tg_user_id BIGINT NOT NULL UNIQUE,
  username TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS'),
  group_id INTEGER,
  expires_at TEXT,
  rpm_override INTEGER,
  tpm_override INTEGER,
  concurrency_override INTEGER,
  daily_token_override INTEGER,
  monthly_token_override INTEGER,
  daily_cost_override DOUBLE PRECISION,
  monthly_cost_override DOUBLE PRECISION
);

CREATE TABLE web_users (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE api_keys (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  key TEXT NOT NULL UNIQUE,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS'),
  expires_at TEXT,
  rpm_override INTEGER,
  tpm_override INTEGER,
  concurrency_override INTEGER,
  daily_token_override INTEGER,
  monthly_token_override INTEGER,
  daily_cost_override DOUBLE PRECISION,
  monthly_cost_override DOUBLE PRECISION,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE usage (
  id SERIAL PRIMARY KEY,
  api_key_id INTEGER NOT NULL,
  provider_id INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  input_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  output_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS'),
  FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE,
  FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE model_prices (
  id SERIAL PRIMARY KEY,
  provider_id INTEGER NOT NULL,
  model TEXT NOT NULL,
  input_price DOUBLE PRECISION,
  output_price DOUBLE PRECISION,
  created_at TEXT NOT NULL DEFAULT to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT NOT NULL DEFAULT to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS'),
  FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE,
  UNIQUE(provider_id, model)
);

CREATE TABLE coding_configs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  is_active INTEGER DEFAULT 0,
  fallback_models TEXT DEFAULT '',
  max_retries INTEGER DEFAULT 3,
  session_input_tokens INTEGER DEFAULT 0,
  session_output_tokens INTEGER DEFAULT 0,
  session_input_cost DOUBLE PRECISION DEFAULT 0.0,
  session_output_cost DOUBLE PRECISION DEFAULT 0.0,
  session_requests INTEGER DEFAULT 0,
  session_model_counts TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT NOT NULL DEFAULT to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS'),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id)
);

CREATE TABLE model_restrictions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  api_key_id INTEGER REFERENCES api_keys(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK(mode IN ('whitelist', 'blacklist')) DEFAULT 'whitelist',
  models TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT NOT NULL DEFAULT to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE(user_id, api_key_id)
);

CREATE TABLE user_groups (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  display_name TEXT DEFAULT '',
  rpm_limit INTEGER NOT NULL DEFAULT 0,
  tpm_limit INTEGER NOT NULL DEFAULT 0,
  concurrency_limit INTEGER NOT NULL DEFAULT 0,
  daily_token_limit INTEGER NOT NULL DEFAULT 0,
  monthly_token_limit INTEGER NOT NULL DEFAULT 0,
  daily_cost_limit DOUBLE PRECISION NOT NULL DEFAULT 0,
  monthly_cost_limit DOUBLE PRECISION NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT NOT NULL DEFAULT to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS'),
  allowed_models TEXT NOT NULL DEFAULT ''
);

CREATE TABLE model_mappings (
  id SERIAL PRIMARY KEY,
  provider_id INTEGER NOT NULL,
  original_model TEXT NOT NULL,
  display_name TEXT NOT NULL,
  UNIQUE(provider_id, original_model)
);
`;

export const PG_INDEXES = `
CREATE INDEX idx_model_restrictions_user ON model_restrictions(user_id, api_key_id);
CREATE INDEX idx_usage_api_key_created ON usage(api_key_id, created_at);
CREATE INDEX idx_usage_created_at ON usage(created_at);
CREATE INDEX idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX idx_users_group_id ON users(group_id);
`;

/**
 * Seed the default user group (idempotent — safe to re-run).
 * Mirrors createTables() seeding for SQLite.
 */
export const PG_SEED_DEFAULT_GROUP = `
INSERT INTO user_groups (name, display_name, is_default)
SELECT 'default', 'Default (unlimited)', 1
WHERE NOT EXISTS (SELECT 1 FROM user_groups WHERE is_default = 1);
`;

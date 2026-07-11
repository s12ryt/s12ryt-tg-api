/**
 * MySQL DDL for migration 001_base_schema.
 *
 * Translation rules from the authoritative SQLite DDL (createTables) /
 * Postgres DDL (schema/postgres.ts):
 * - INTEGER PRIMARY KEY AUTOINCREMENT  ->  INTEGER AUTO_INCREMENT PRIMARY KEY
 * - SERIAL PRIMARY KEY                 ->  INTEGER AUTO_INCREMENT PRIMARY KEY
 * - TEXT (no UNIQUE/PK)                ->  TEXT
 * - TEXT used in UNIQUE or PRIMARY KEY ->  VARCHAR(255)
 *   (MySQL TEXT/BLOB cannot be a UNIQUE or PK without a prefix length;
 *    VARCHAR(255) keeps schema parity and is plenty for names/keys/models.)
 * - REAL / DOUBLE PRECISION            ->  DOUBLE
 * - BIGINT                             ->  BIGINT
 * - datetime('now') / to_char(NOW())   ->  no DDL DEFAULT
 *   (MySQL TEXT columns cannot have a function DEFAULT; every INSERT/UPDATE
 *    in database.ts supplies NOW() via the dialect map, and the seed below
 *    includes NOW() explicitly. NOT NULL is kept for schema parity.)
 * - TEXT DEFAULT '' / TEXT DEFAULT '{}'->  TEXT (no DEFAULT)
 *   (MySQL TEXT columns cannot have any DEFAULT value. Columns that were
 *    NOT NULL in PG keep NOT NULL here — every INSERT must supply a value.
 *    Columns that allowed NULL in PG still allow NULL here.)
 * - boolean columns                    ->  INTEGER (0/1)
 * - CHECK constraints                  ->  kept (requires MySQL 8.0.16+)
 *
 * Booleans use INTEGER for cross-dialect consistency: SQLite stores 0/1, and we
 * want identical wire format in backups. MysqlDriver.toMysqlValue converts
 * boolean -> 0/1 accordingly.
 *
 * Each table uses ENGINE=InnoDB so that FOREIGN KEY constraints are enforced
 * (the default MyISAM engine silently ignores FKs). Requires MySQL 8.0+ for
 * CHECK constraint enforcement.
 *
 * Run once on a fresh MySQL database (guarded by schema_migrations).
 */

export const MYSQL_DDL = `
CREATE TABLE providers (
  id INTEGER AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  api_type VARCHAR(32) NOT NULL,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  user_agent TEXT NOT NULL,
  models TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  input_price DOUBLE,
  output_price DOUBLE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  key_strategy TEXT NOT NULL,
  UNIQUE(name),
  CHECK(api_type IN ('openai_chat', 'openai_response', 'anthropic', 'google'))
) ENGINE=InnoDB;
CREATE TABLE users (
  id INTEGER AUTO_INCREMENT PRIMARY KEY,
  tg_user_id BIGINT NOT NULL,
  username TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  group_id INTEGER,
  expires_at TEXT,
  rpm_override INTEGER,
  tpm_override INTEGER,
  concurrency_override INTEGER,
  daily_token_override INTEGER,
  monthly_token_override INTEGER,
  daily_cost_override DOUBLE,
  monthly_cost_override DOUBLE,
  UNIQUE(tg_user_id)
) ENGINE=InnoDB;
CREATE TABLE web_users (
  id INTEGER AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(255) NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE(username)
) ENGINE=InnoDB;
CREATE TABLE api_keys (
  id INTEGER AUTO_INCREMENT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  \`key\` VARCHAR(255) NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  rpm_override INTEGER,
  tpm_override INTEGER,
  concurrency_override INTEGER,
  daily_token_override INTEGER,
  monthly_token_override INTEGER,
  daily_cost_override DOUBLE,
  monthly_cost_override DOUBLE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(\`key\`)
) ENGINE=InnoDB;
CREATE TABLE usage (
  id INTEGER AUTO_INCREMENT PRIMARY KEY,
  api_key_id INTEGER NOT NULL,
  provider_id INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  input_cost DOUBLE NOT NULL DEFAULT 0,
  output_cost DOUBLE NOT NULL DEFAULT 0,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE,
  FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE TABLE settings (
  \`key\` VARCHAR(255) PRIMARY KEY,
  value TEXT
) ENGINE=InnoDB;
CREATE TABLE model_prices (
  id INTEGER AUTO_INCREMENT PRIMARY KEY,
  provider_id INTEGER NOT NULL,
  model VARCHAR(255) NOT NULL,
  input_price DOUBLE,
  output_price DOUBLE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE,
  UNIQUE(provider_id, model)
) ENGINE=InnoDB;
CREATE TABLE coding_configs (
  id INTEGER AUTO_INCREMENT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  is_active INTEGER DEFAULT 0,
  fallback_models TEXT,
  max_retries INTEGER DEFAULT 3,
  session_input_tokens INTEGER DEFAULT 0,
  session_output_tokens INTEGER DEFAULT 0,
  session_input_cost DOUBLE DEFAULT 0,
  session_output_cost DOUBLE DEFAULT 0,
  session_requests INTEGER DEFAULT 0,
  session_model_counts TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id)
) ENGINE=InnoDB;
CREATE TABLE model_restrictions (
  id INTEGER AUTO_INCREMENT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  api_key_id INTEGER,
  mode VARCHAR(16) NOT NULL DEFAULT 'whitelist',
  models TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE,
  UNIQUE(user_id, api_key_id),
  CHECK(mode IN ('whitelist', 'blacklist'))
) ENGINE=InnoDB;
CREATE TABLE user_groups (
  id INTEGER AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  display_name TEXT,
  rpm_limit INTEGER NOT NULL DEFAULT 0,
  tpm_limit INTEGER NOT NULL DEFAULT 0,
  concurrency_limit INTEGER NOT NULL DEFAULT 0,
  daily_token_limit INTEGER NOT NULL DEFAULT 0,
  monthly_token_limit INTEGER NOT NULL DEFAULT 0,
  daily_cost_limit DOUBLE NOT NULL DEFAULT 0,
  monthly_cost_limit DOUBLE NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  allowed_models TEXT NOT NULL,
  UNIQUE(name)
) ENGINE=InnoDB;
CREATE TABLE model_mappings (
  id INTEGER AUTO_INCREMENT PRIMARY KEY,
  provider_id INTEGER NOT NULL,
  original_model VARCHAR(255) NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  UNIQUE(provider_id, original_model)
) ENGINE=InnoDB;
`;

export const MYSQL_INDEXES = `
CREATE INDEX idx_model_restrictions_user ON model_restrictions(user_id, api_key_id);
CREATE INDEX idx_usage_api_key_created ON usage(api_key_id, created_at);
CREATE INDEX idx_usage_created_at ON usage(created_at);
CREATE INDEX idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX idx_users_group_id ON users(group_id);
`;

/**
 * Seed the default user group (idempotent — safe to re-run).
 * Mirrors createTables() seeding for SQLite. Includes created_at/updated_at
 * explicitly because MySQL TEXT columns have no function DEFAULT.
 */
export const MYSQL_SEED_DEFAULT_GROUP = `
INSERT INTO user_groups (name, display_name, is_default, created_at, updated_at, allowed_models)
SELECT 'default', 'Default (unlimited)', 1, NOW(), NOW(), ''
WHERE NOT EXISTS (SELECT 1 FROM user_groups WHERE is_default = 1);
`;

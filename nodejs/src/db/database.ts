/**
 * Database layer (async, dialect-agnostic via DbDriver).
 *
 * Stage 2 of the cloud-DB migration: all DB-touching functions are async and
 * route through the {@link DbDriver} abstraction. SQLite-specific schema setup
 * (createTables) and backup/restore shadow-DB logic still operate on the raw
 * sql.js handle retrieved from {@link SqliteDriver.getRawDatabase}.
 *
 * Performance optimizations preserved:
 * 1. Provider/model routing cache (hot path reads stay sync).
 * 2. API Key LRU cache (cache-miss falls back to async DB query).
 * 3. Effective-limits TTL cache (cache-miss falls back to async DB query).
 * 4. Usage write queue — batches inserts, flushes periodically.
 */

import { type Database as SqlJsDatabase, type SqlValue } from "sql.js";
import { v7 as uuidv7 } from "uuid";
import { clearProviderKeyState } from "../api/keySelector.js";
import type { DbDriver, SqlParam } from "./driver/types.js";
import { createDriver } from "./driver/factory.js";
import { NOW, periodCondition, buildUpsertSql, quoteIdent, castAsText } from "./dialect.js";
import { BACKUP_TABLES, TABLE_COLUMNS } from "./schema/tables.js";
import { PG_DDL, PG_INDEXES, PG_SEED_DEFAULT_GROUP } from "./schema/postgres.js";
import { MYSQL_DDL, MYSQL_INDEXES, MYSQL_SEED_DEFAULT_GROUP } from "./schema/mysql.js";

/**
 * Active driver (owns the connection lifecycle). Assigned by initDbAsync.
 * Cloud drivers (stage 3/4) replace this transparently.
 */
let driver: DbDriver | null = null;

/**
 * Raw sql.js handle, only populated for the SQLite dialect. Used by the
 * SQLite-only backup/restore shadow-DB preflight and createTables. null on
 * cloud backends.
 */
let db: SqlJsDatabase | null = null;

let dbPath: string = "";

/** Return the active driver or throw a contract error if not initialised. */
function drv(): DbDriver {
  if (!driver) {
    throw new Error("Database not initialized. Call initDbAsync() first.");
  }
  return driver;
}

/** Current-timestamp SQL expression for the active dialect. */
function nowExpr(): string {
  return NOW[drv().dialect];
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

export function getDb(): SqlJsDatabase {
  if (!db) {
    throw new Error("Database not initialized. Call initDb() first.");
  }
  return db;
}

export function initDb(_databasePath: string): SqlJsDatabase {
  throw new Error(
    "Use initDbAsync() instead. sql.js requires async initialization."
  );
}

/**
 * Async database initialization.
 *
 * Creates the dialect driver (SQLite now, Postgres/MySQL in stage 3/4), runs
 * the SQLite schema setup when on SQLite, primes the provider cache, and
 * starts the usage write-queue flush timer. Auto-save to disk is managed
 * internally by the SQLite driver (30s cadence).
 */
export async function initDbAsync(databasePath: string, databaseUrl?: string): Promise<SqlJsDatabase | null> {
  dbPath = databasePath;
  driver = await createDriver({ sqlitePath: databasePath, databaseUrl });

  if (driver.dialect === "sqlite") {
    // SQLite path: build/migrate schema on the raw sql.js handle.
    // createTables is synchronous by design (DDL + legacy migrations are SQLite-specific).
    const { SqliteDriver } = await import("./driver/sqliteDriver.js");
    if (!(driver instanceof SqliteDriver)) {
      throw new Error("Driver dialect is sqlite but instance is not SqliteDriver");
    }
    const sqliteDb = driver.getRawDatabase();
    db = sqliteDb;
    createTables(sqliteDb);
    await driver.sync();
  } else {
    // Cloud backend (PostgreSQL/MySQL): no raw sql.js handle.
    // Schema is managed via async migrations through the driver.
    db = null;
    await runMigrations(driver);
  }

  await rebuildProviderCache();
  startUsageFlushTimer();
  await startKeepaliveTimer();

  return db;
}



function createTables(db: SqlJsDatabase): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS providers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      api_type TEXT NOT NULL CHECK(api_type IN ('openai_chat', 'openai_response', 'anthropic', 'google')),
      base_url TEXT NOT NULL,
      api_key TEXT NOT NULL,
      user_agent TEXT NOT NULL DEFAULT '',
      models TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      input_price REAL,
      output_price REAL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tg_user_id INTEGER NOT NULL UNIQUE,
      username TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      key TEXT NOT NULL UNIQUE,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      api_key_id INTEGER NOT NULL,
      provider_id INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      input_cost REAL NOT NULL DEFAULT 0,
      output_cost REAL NOT NULL DEFAULT 0,
      model TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE,
      FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS model_prices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_id INTEGER NOT NULL,
      model TEXT NOT NULL,
      input_price REAL,
      output_price REAL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE,
      UNIQUE(provider_id, model)
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS coding_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      is_active INTEGER DEFAULT 0,
      fallback_models TEXT DEFAULT '',
      max_retries INTEGER DEFAULT 3,
      session_input_tokens INTEGER DEFAULT 0,
      session_output_tokens INTEGER DEFAULT 0,
      session_input_cost REAL DEFAULT 0.0,
      session_output_cost REAL DEFAULT 0.0,
      session_requests INTEGER DEFAULT 0,
      session_model_counts TEXT DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id)
    );
  `);

  // Migration: add session stats columns to coding_configs (idempotent)
  const sessionColumns = [
    "session_input_tokens INTEGER DEFAULT 0",
    "session_output_tokens INTEGER DEFAULT 0",
    "session_input_cost REAL DEFAULT 0.0",
    "session_output_cost REAL DEFAULT 0.0",
    "session_requests INTEGER DEFAULT 0",
    "session_model_counts TEXT DEFAULT '{}'",
  ];
  for (const col of sessionColumns) {
    try {
      db.run(`ALTER TABLE coding_configs ADD COLUMN ${col}`);
    } catch {
      // Column already exists — ignore
    }
  }

  db.run(`
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
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_model_restrictions_user ON model_restrictions(user_id, api_key_id)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS user_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      display_name TEXT DEFAULT '',
      rpm_limit INTEGER NOT NULL DEFAULT 0,
      tpm_limit INTEGER NOT NULL DEFAULT 0,
      concurrency_limit INTEGER NOT NULL DEFAULT 0,
      daily_token_limit INTEGER NOT NULL DEFAULT 0,
      monthly_token_limit INTEGER NOT NULL DEFAULT 0,
      daily_cost_limit REAL NOT NULL DEFAULT 0,
      monthly_cost_limit REAL NOT NULL DEFAULT 0,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const userLimitColumns = [
    "group_id INTEGER",
    "expires_at TEXT",
    "rpm_override INTEGER",
    "tpm_override INTEGER",
    "concurrency_override INTEGER",
    "daily_token_override INTEGER",
    "monthly_token_override INTEGER",
    "daily_cost_override REAL",
    "monthly_cost_override REAL",
  ];
  for (const col of userLimitColumns) {
    try {
      db.run(`ALTER TABLE users ADD COLUMN ${col}`);
    } catch {
      // Column already exists — ignore
    }
  }

  const apiKeyLimitColumns = [
    "expires_at TEXT",
    "rpm_override INTEGER",
    "tpm_override INTEGER",
    "concurrency_override INTEGER",
    "daily_token_override INTEGER",
    "monthly_token_override INTEGER",
    "daily_cost_override REAL",
    "monthly_cost_override REAL",
  ];
  for (const col of apiKeyLimitColumns) {
    try {
      db.run(`ALTER TABLE api_keys ADD COLUMN ${col}`);
    } catch {
      // Column already exists — ignore
    }
  }

  try {
    db.run("ALTER TABLE user_groups ADD COLUMN allowed_models TEXT NOT NULL DEFAULT ''");
  } catch {
    // Column already exists — ignore
  }

  // Seed default group if none exists
  const defaultGroup = db.exec("SELECT id FROM user_groups WHERE is_default = 1 LIMIT 1");
  if (!defaultGroup.length) {
    db.run(`INSERT INTO user_groups (name, display_name, is_default) VALUES ('default', 'Default (unlimited)', 1)`);
  }

  db.run(`
    UPDATE users
    SET group_id = (SELECT id FROM user_groups WHERE is_default = 1 LIMIT 1)
    WHERE group_id IS NOT NULL
      AND group_id NOT IN (SELECT id FROM user_groups)
  `);

  // Migration: openai → openai_chat (split api_type)
  const migrationRow = db.exec(
    "SELECT value FROM settings WHERE key = 'migration_openai_split'"
  );
  if (!migrationRow.length) {
    console.log("[db] Running migration: openai → openai_chat");
    db.run("PRAGMA foreign_keys = OFF");

    db.run(`
      CREATE TABLE IF NOT EXISTS providers_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        api_type TEXT NOT NULL CHECK(api_type IN ('openai_chat', 'openai_response', 'anthropic', 'google')),
        base_url TEXT NOT NULL,
        api_key TEXT NOT NULL,
        models TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        input_price REAL,
        output_price REAL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.run(`
      INSERT INTO providers_new
      SELECT id, name,
        CASE WHEN api_type = 'openai' THEN 'openai_chat' ELSE api_type END,
        base_url, api_key, models, enabled, input_price, output_price, created_at, updated_at
      FROM providers
    `);
    db.run("DROP TABLE providers");
    db.run("ALTER TABLE providers_new RENAME TO providers");

    db.run("PRAGMA foreign_keys = ON");
    db.run(
      buildUpsertSql(drv().dialect, "settings", ["key", "value"], ["key"], ["value"], false)
    );
    console.log("[db] Migration complete: openai → openai_chat");
  }

  // Migration: single api_key → JSON array
  const multiKeyRow = db.exec(
    "SELECT value FROM settings WHERE key = 'migration_multi_key'"
  );
  if (!multiKeyRow.length) {
    console.log("[db] Running migration: single api_key → JSON array");
    const providers = db.exec("SELECT id, api_key FROM providers");
    for (const result of providers) {
      for (const row of result.values) {
        const id = row[0] as number;
        const apiKey = row[1] as string;
        if (apiKey && !apiKey.startsWith("[")) {
          const wrapped = JSON.stringify([apiKey]);
          db.run("UPDATE providers SET api_key = ? WHERE id = ?", [wrapped, id]);
        }
      }
    }
    db.run(buildUpsertSql(drv().dialect, "settings", ["key", "value"], ["key"], ["value"], false));
    console.log("[db] Migration complete: single api_key → JSON array");
  }

  try {
    db.run(`ALTER TABLE providers ADD COLUMN key_strategy TEXT NOT NULL DEFAULT 'failover'`);
    console.log("[db] Migration complete: providers.key_strategy column added");
  } catch {
    // Column already exists — ignore
  }

  try {
    db.run(`ALTER TABLE providers ADD COLUMN user_agent TEXT NOT NULL DEFAULT ''`);
    console.log("[db] Migration complete: providers.user_agent column added");
  } catch {
    // Column already exists — ignore
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS model_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_id INTEGER NOT NULL,
      original_model TEXT NOT NULL,
      display_name TEXT NOT NULL,
      UNIQUE(provider_id, original_model)
    );
  `);

  // Clean up historical orphan provider children.
  db.run(`DELETE FROM model_prices WHERE provider_id NOT IN (SELECT id FROM providers)`);
  db.run(`DELETE FROM model_mappings WHERE provider_id NOT IN (SELECT id FROM providers)`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_usage_api_key_created ON usage(api_key_id, created_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_usage_created_at ON usage(created_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_users_group_id ON users(group_id)`);
  // Persistence is handled by the driver after createTables returns (see initDbAsync).
}

/**
 * Cloud schema setup (PostgreSQL/MySQL). Runs migrations tracked in the
 * `schema_migrations` table. SQLite uses createTables() on the raw handle
 * (legacy settings-based migrations remain in createTables for zero regression).
 *
 * Currently applies migration 001_base_schema (full PG DDL + indexes + seed).
 * Future migrations append below and are gated by their ids.
 */
async function runMigrations(d: DbDriver): Promise<void> {
  await d.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (id VARCHAR(255) PRIMARY KEY, applied_at TEXT NOT NULL)"
  );
  const applied = await d.query<{ id: string }>("SELECT id FROM schema_migrations");
  if (applied.rows.some((r) => r.id === "001_base_schema")) return;
  console.log("[db] Running cloud migration 001_base_schema");
  if (d.dialect === "postgres") {
    await d.exec(PG_DDL);
    await d.exec(PG_INDEXES);
    await d.exec(PG_SEED_DEFAULT_GROUP);
  } else {
    await d.exec(MYSQL_DDL);
    await d.exec(MYSQL_INDEXES);
    await d.exec(MYSQL_SEED_DEFAULT_GROUP);
  }
  await d.run("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)", [
    "001_base_schema",
    new Date().toISOString(),
  ]);
  console.log("[db] Cloud migration 001_base_schema complete");
}

// ---------------------------------------------------------------------------
// Persistence & shutdown
// ---------------------------------------------------------------------------

/**
 * Force-flush pending writes to disk (SQLite). On cloud drivers this is a
 * no-op (statements commit immediately). Kept for callers that historically
 * invoked saveDb() directly after critical writes.
 */
export async function saveDb(): Promise<void> {
  if (!driver) return;
  await driver.sync();
}

export async function closeDb(): Promise<void> {
  // Flush pending usage writes before tearing down.
  if (driver) {
    try {
      await flushUsageQueue();
    } catch (err) {
      console.error("[db] flushUsageQueue during closeDb failed:", err);
    }
  }
  if (usageFlushTimer) {
    clearInterval(usageFlushTimer);
    stopKeepaliveTimer();
    usageFlushTimer = null;
  }
  if (driver) {
    await driver.close();
  }
  driver = null;
  db = null;
  dbPath = "";
  // Drop in-memory caches so a fresh init starts clean.
  providerCache = new Map<string, CachedProvider>();
  allProvidersCache = null;
  apiKeyCache.clear();
  effectiveLimitsCache.clear();
}

// ---------------------------------------------------------------------------
// Helper: async query/run wrappers over the driver
// ---------------------------------------------------------------------------

async function queryAll(sql: string, params: SqlValue[] = []): Promise<Record<string, SqlValue>[]> {
  const result = await drv().query<Record<string, SqlValue>>(sql, params as SqlParam[]);
  return result.rows;
}

async function queryOne(sql: string, params: SqlValue[] = []): Promise<Record<string, SqlValue> | undefined> {
  const rows = await queryAll(sql, params);
  return rows[0];
}

/**
 * Run a write SQL statement. The driver marks the DB dirty; durability is
 * handled by auto-save (SQLite) or immediate commit (cloud).
 */
async function runSql(sql: string, params: SqlValue[] = []): Promise<void> {
  try {
    await drv().run(sql, params as SqlParam[]);
  } catch (err) {
    console.error("[db] SQL error:", sql, params, err);
    throw err;
  }
}

/**
 * Run a write SQL statement AND immediately persist (critical writes only).
 */
async function runSqlAndSave(sql: string, params: SqlValue[] = []): Promise<void> {
  const d = drv();
  try {
    await d.run(sql, params as SqlParam[]);
    await d.sync();
  } catch (err) {
    console.error("[db] SQL error:", sql, params, err);
    throw err;
  }
}

// ===========================================================================
// OPTIMIZATION 1: Provider / Model routing cache
// ===========================================================================

interface CachedProvider {
  providerType: string;
  providerId: number;
  providerName: string;
  baseUrl: string;
  apiKey: string;
  userAgent: string;
  keyStrategy: string;
  inputPrice: number | null;
  outputPrice: number | null;
  originalModel: string;
}

/** model_name -> CachedProvider */
let providerCache = new Map<string, CachedProvider>();

/** All cached providers (for /list etc.) */
let allProvidersCache: Provider[] | null = null;

/**
 * Rebuild the model→provider routing cache from DB.
 * Called on init and after any provider add/update/delete. Async because it
 * scans providers + model mappings + model_prices.
 */
export async function rebuildProviderCache(): Promise<void> {
  if (!driver) return; // Guard: skip if DB not initialized (e.g. during test teardown)
  const newCache = new Map<string, CachedProvider>();
  const providers = await queryAll("SELECT * FROM providers WHERE enabled = 1 ORDER BY id");

  const mappingRows = await queryAll("SELECT provider_id, original_model, display_name FROM model_mappings");
  const mappingMap = new Map<string, string>();
  for (const m of mappingRows) {
    mappingMap.set(`${Number(m.provider_id)}:${String(m.original_model)}`, String(m.display_name));
  }

  for (const p of providers) {
    const pid = Number(p.id);
    const models = String(p.models || "")
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean);

    for (const modelName of models) {
      const mp = await queryOne(
        "SELECT input_price, output_price FROM model_prices WHERE provider_id = ? AND model = ?",
        [pid, modelName]
      );
      const inputPrice = mp ? (mp.input_price as number | null) : (p.input_price as number | null);
      const outputPrice = mp ? (mp.output_price as number | null) : (p.output_price as number | null);

      const displayName = mappingMap.get(`${pid}:${modelName}`) ?? modelName;

      newCache.set(displayName, {
        providerType: String(p.api_type),
        providerId: pid,
        providerName: String(p.name),
        baseUrl: String(p.base_url),
        apiKey: String(p.api_key),
        userAgent: String(p.user_agent ?? ""),
        keyStrategy: String(p.key_strategy ?? "failover"),
        inputPrice,
        outputPrice,
        originalModel: modelName,
      });
    }
  }

  providerCache = newCache;
  allProvidersCache = null; // invalidate
  console.log(`[cache] Provider routing cache rebuilt: ${providerCache.size} model entries`);
  notifyProviderCacheRebuild();
}

/**
 * Fast model lookup for API routing — reads in-memory cache, zero DB queries.
 */
export function lookupModelCached(modelName: string): CachedProvider | undefined {
  return providerCache.get(modelName);
}

/**
 * Get all model names from the provider cache.
 */
export function getAllCachedModelNames(): string[] {
  return Array.from(providerCache.keys()).sort();
}

// ===========================================================================
// Model Mappings — display name aliases for provider models
// ===========================================================================

export interface ModelMapping {
  provider_id: number;
  provider_name: string;
  original_model: string;
  display_name: string;
}

/** Get all model mappings joined with provider names. */
export async function getModelMappings(): Promise<ModelMapping[]> {
  if (!driver) return [];
  const rows = await queryAll(
    `SELECT mm.provider_id, p.name as provider_name, mm.original_model, mm.display_name
     FROM model_mappings mm
     JOIN providers p ON mm.provider_id = p.id
     ORDER BY p.name, mm.original_model`
  );
  return rows.map((r) => ({
    provider_id: Number(r.provider_id),
    provider_name: String(r.provider_name),
    original_model: String(r.original_model),
    display_name: String(r.display_name),
  }));
}

/** Insert or update a model mapping. */
export async function upsertModelMapping(providerId: number, originalModel: string, displayName: string): Promise<void> {
  if (!driver) return;
  if (!(await getProviderById(providerId))) {
    throw new Error("Provider not found");
  }
  const d = drv();
  await d.run(
    buildUpsertSql(drv().dialect, "model_mappings", ["provider_id", "original_model", "display_name"], ["provider_id", "original_model"], ["display_name"], false),
    [providerId, originalModel, displayName]
  );
  await d.sync();
  invalidateProviderCache();
}

/** Delete a model mapping. */
export async function deleteModelMapping(providerId: number, originalModel: string): Promise<void> {
  if (!driver) return;
  const d = drv();
  await d.run(
    "DELETE FROM model_mappings WHERE provider_id = ? AND original_model = ?",
    [providerId, originalModel]
  );
  await d.sync();
  invalidateProviderCache();
}

/** Replace all model mappings (batch operation). */
export async function replaceModelMappings(mappings: Array<{ provider_id: number; original_model: string; display_name: string }>): Promise<void> {
  if (!driver) return;
  const providers = await getProviders(false);
  const providerIds = new Set(providers.map((p) => p.id));
  const invalid = mappings.find((m) => !providerIds.has(m.provider_id));
  if (invalid) {
    throw new Error(`Provider not found for model mapping: ${invalid.provider_id}`);
  }
  const d = drv();
  await d.transaction(async () => {
    await d.run("DELETE FROM model_mappings");
    for (const m of mappings) {
      await d.run(
        "INSERT INTO model_mappings (provider_id, original_model, display_name) VALUES (?, ?, ?)",
        [m.provider_id, m.original_model, m.display_name]
      );
    }
  });
  await d.sync();
  invalidateProviderCache();
}

let rebuildCachePending = false;

/**
 * Invalidate provider caches — call after any provider/model/price mutation.
 * Synchronous: clears the cache immediately and schedules a fire-and-forget
 * rebuild on next tick (batched across multiple mutations).
 */
function invalidateProviderCache(): void {
  allProvidersCache = null;
  if (!rebuildCachePending) {
    rebuildCachePending = true;
    process.nextTick(() => {
      // Fire-and-forget; errors are logged but never crash the caller.
      void rebuildProviderCache()
        .catch((err) => console.error("[cache] rebuildProviderCache failed:", err))
        .finally(() => { rebuildCachePending = false; });
    });
  }
}

/** Register a callback to be called whenever provider cache is rebuilt.
 *  Returns an unsubscribe function to remove the listener (prevents leak). */
const providerCacheListeners: Array<() => void> = [];

export function onProviderCacheRebuild(fn: () => void): () => void {
  providerCacheListeners.push(fn);
  return () => {
    const i = providerCacheListeners.indexOf(fn);
    if (i >= 0) providerCacheListeners.splice(i, 1);
  };
}

function notifyProviderCacheRebuild(): void {
  for (const fn of providerCacheListeners) {
    try { fn(); } catch { /* ignore */ }
  }
}

// ===========================================================================
// OPTIMIZATION 2: API Key LRU cache
// ===========================================================================

const API_KEY_CACHE_SIZE = 256;

interface CachedApiKey {
  apiKeyId: number;
  userId: number;
  tgUserId: number;
  is_active: boolean;
  user_is_active: boolean;
}

const apiKeyCache = new Map<string, CachedApiKey>();

/**
 * Lookup API key with LRU cache.
 * Cache hit returns synchronously-wrapped value; cache miss falls back to
 * async DB queries for the api_key and user rows.
 * Returns null if key not found or inactive.
 */
export async function lookupApiKeyCached(key: string): Promise<CachedApiKey | null> {
  const cached = apiKeyCache.get(key);
  if (cached) {
    // Move to end (LRU)
    apiKeyCache.delete(key);
    apiKeyCache.set(key, cached);
    if (cached.is_active && cached.user_is_active) return cached;
    return null;
  }

  // Cache miss — query DB
  const apiKeyRow = await queryOne(`SELECT * FROM api_keys WHERE ${quoteIdent("key", drv().dialect)} = ?`, [key]);
  if (!apiKeyRow || Number(apiKeyRow.is_active) !== 1) return null;

  const user = await queryOne("SELECT * FROM users WHERE id = ?", [apiKeyRow.user_id]);
  if (!user || Number(user.is_active) !== 1) return null;

  const entry: CachedApiKey = {
    apiKeyId: Number(apiKeyRow.id),
    userId: Number(user.id),
    tgUserId: Number(user.tg_user_id),
    is_active: true,
    user_is_active: true,
  };

  // Evict oldest if at capacity
  if (apiKeyCache.size >= API_KEY_CACHE_SIZE) {
    const oldest = apiKeyCache.keys().next().value;
    if (oldest !== undefined) apiKeyCache.delete(oldest);
  }
  apiKeyCache.set(key, entry);
  return entry;
}

/**
 * Invalidate a specific API key from cache (e.g. after deletion/deactivation).
 */
export function invalidateApiKeyCache(key: string): void {
  apiKeyCache.delete(key);
}

/**
 * Invalidate all API key cache entries for a user.
 */
export function invalidateUserApiKeyCache(tgUserId: number): void {
  // Simple: clear all — user mutations are rare
  apiKeyCache.clear();
}

// ===========================================================================
// OPTIMIZATION 3: Usage write queue
// ===========================================================================

interface PendingUsage {
  api_key_id: number;
  provider_id: number;
  input_tokens: number;
  output_tokens: number;
  input_cost: number;
  output_cost: number;
  model: string;
}

const usageQueue: PendingUsage[] = [];
let usageFlushTimer: ReturnType<typeof setInterval> | null = null;
const USAGE_FLUSH_INTERVAL_MS = 5_000;
const USAGE_MAX_QUEUE_SIZE = 100;

function startUsageFlushTimer(): void {
  usageFlushTimer = setInterval(() => {
    void flushUsageQueue().catch((err) => console.error("[usage-queue] timer flush failed:", err));
  }, USAGE_FLUSH_INTERVAL_MS);
}

/**
 * Flush all pending usage records to DB atomically.
 */

/**
 * Cloud database keepalive ??prevents idle cloud databases (e.g. Supabase
 * free-tier) from sleeping by periodically writing and deleting a throwaway
 * row. Only active for PostgreSQL / MySQL; SQLite returns immediately.
 *
 * Settings (in the `settings` table):
 *   keepalive_enabled   ??"1" to enable, absent/other to disable
 *   keepalive_interval  ??minutes between pings (default 5, min 1)
 */
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

/** Write+delete a throwaway row to keep the cloud DB connection active. */
async function keepalivePing(): Promise<void> {
  const d = drv();
  if (d.dialect === "sqlite") return;
  try {
    if (d.dialect === "postgres") {
      await d.exec("CREATE TABLE IF NOT EXISTS _db_keepalive (id SERIAL PRIMARY KEY, pinged_at TEXT NOT NULL)");
    } else {
      await d.exec("CREATE TABLE IF NOT EXISTS _db_keepalive (id INTEGER AUTO_INCREMENT PRIMARY KEY, pinged_at TEXT NOT NULL) ENGINE=InnoDB");
    }
    await d.run("DELETE FROM _db_keepalive");
    await d.run(`INSERT INTO _db_keepalive (pinged_at) VALUES (${NOW[d.dialect]})`);
  } catch (err) {
    console.error("[keepalive] ping failed:", err);
  }
}

function stopKeepaliveTimer(): void {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
}

/** Read keepalive settings and start the timer if enabled (cloud DB only). */
async function startKeepaliveTimer(): Promise<void> {
  stopKeepaliveTimer();
  const d = drv();
  if (d.dialect === "sqlite") return;
  const enabled = await getSetting("keepalive_enabled");
  if (enabled !== "1") return;
  const intervalMinutes = Math.max(1, Number(await getSetting("keepalive_interval")) || 5);
  void keepalivePing();
  keepaliveTimer = setInterval(() => void keepalivePing(), intervalMinutes * 60_000);
}

/** Restart the keepalive timer after settings change (called from web routes). */
export async function restartKeepaliveTimer(): Promise<void> {
  await startKeepaliveTimer();
}

/** Whether the active driver is a cloud backend (PG/MySQL). */
export function isCloudDatabase(): boolean {
  if (!driver) return false;
  return driver.dialect !== "sqlite";
}
export async function flushUsageQueue(): Promise<void> {
  if (usageQueue.length === 0) return;

  const batch = usageQueue.splice(0, usageQueue.length);
  if (batch.length === 0) return;

  const d = drv();
  try {
    await d.transaction(async () => {
      for (const u of batch) {
        await d.run(
          `INSERT INTO usage (api_key_id, provider_id, input_tokens, output_tokens, input_cost, output_cost, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ${nowExpr()})`,
          [u.api_key_id, u.provider_id, u.input_tokens, u.output_tokens, u.input_cost, u.output_cost, u.model]
        );
      }
    });
    console.log(`[usage-queue] Flushed ${batch.length} records to DB`);
  } catch (err) {
    console.error("[usage-queue] Batch insert failed:", err);
    // Put records back at the front of the queue for retry on next flush.
    usageQueue.unshift(...batch);
  }
}

/**
 * Queue a usage record for batched writing. Non-blocking; flushes immediately
 * once the queue reaches USAGE_MAX_QUEUE_SIZE (fire-and-forget).
 */
export function enqueueUsage(record: PendingUsage): void {
  usageQueue.push(record);
  if (usageQueue.length >= USAGE_MAX_QUEUE_SIZE) {
    void flushUsageQueue().catch((err) => console.error("[usage-queue] overflow flush failed:", err));
  }
}

// ========================
// Providers CRUD
// ========================

export interface Provider {
  id: number;
  name: string;
  api_type: "openai_chat" | "openai_response" | "anthropic" | "google";
  base_url: string;
  api_key: string;
  user_agent: string;
  key_strategy: string;
  models: string;
  enabled: number;
  input_price: number | null;
  output_price: number | null;
  created_at: string;
  updated_at: string;
}

export async function addProvider(
  provider: Omit<Provider, "id" | "enabled" | "created_at" | "updated_at" | "key_strategy" | "user_agent"> & { key_strategy?: string; user_agent?: string }
): Promise<void> {
  console.log(`[db] addProvider: name=${provider.name}, type=${provider.api_type}, models=${provider.models}`);
  await runSql(
    `INSERT INTO providers (name, api_type, base_url, api_key, user_agent, key_strategy, models, input_price, output_price, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${nowExpr()}, ${nowExpr()})`,
    [
      provider.name,
      provider.api_type,
      provider.base_url,
      provider.api_key,
      provider.user_agent ?? "",
      provider.key_strategy ?? "failover",
      provider.models,
      provider.input_price ?? null,
      provider.output_price ?? null,
    ] as SqlValue[]
  );
  invalidateProviderCache();
}

export async function getProviders(enabledOnly = false): Promise<Provider[]> {
  if (enabledOnly) {
    if (!allProvidersCache) {
      allProvidersCache = (await queryAll("SELECT * FROM providers WHERE enabled = 1 ORDER BY id")) as unknown as Provider[];
    }
    return allProvidersCache;
  }
  return (await queryAll("SELECT * FROM providers ORDER BY id")) as unknown as Provider[];
}

export async function getProviderById(id: number): Promise<Provider | undefined> {
  return (await queryOne("SELECT * FROM providers WHERE id = ?", [id])) as unknown as Provider | undefined;
}

export async function updateProvider(
  id: number,
  data: Partial<Omit<Provider, "id" | "created_at">>
): Promise<void> {
  const fields: string[] = [];
  const values: SqlValue[] = [];

  for (const [key, value] of Object.entries(data)) {
    fields.push(`${key} = ?`);
    values.push(value as SqlValue);
  }

  if (fields.length === 0) {
    throw new Error("No fields to update");
  }

  fields.push(`updated_at = ${nowExpr()}`);
  values.push(id);

  await runSql(`UPDATE providers SET ${fields.join(", ")} WHERE id = ?`, values);
  invalidateProviderCache();
}

export async function deleteProvider(ids: number[]): Promise<void> {
  if (ids.length === 0) return;

  const placeholders = ids.map(() => "?").join(",");
  await runSql(`DELETE FROM model_mappings WHERE provider_id IN (${placeholders})`, ids);
  await runSql(`DELETE FROM model_prices WHERE provider_id IN (${placeholders})`, ids);
  await runSql(`DELETE FROM providers WHERE id IN (${placeholders})`, ids);
  for (const id of ids) clearProviderKeyState(id);
  invalidateProviderCache();
}

// ========================
// Users CRUD
// ========================

export interface User {
  id: number;
  tg_user_id: number;
  username: string | null;
  is_active: number;
  created_at: string;
}

export async function addUser(tgUserId: number, username: string | null = null): Promise<void> {
  await runSql(
    `INSERT INTO users (tg_user_id, username, created_at) VALUES (?, ?, ${nowExpr()})`,
    [tgUserId, username]
  );
}

export async function getUsers(excludeAdminId?: number): Promise<User[]> {
  if (excludeAdminId !== undefined) {
    return (await queryAll("SELECT * FROM users WHERE tg_user_id != ? ORDER BY id", [excludeAdminId])) as unknown as User[];
  }
  return (await queryAll("SELECT * FROM users ORDER BY id")) as unknown as User[];
}

export async function getUserByTgId(tgUserId: number): Promise<User | undefined> {
  return (await queryOne("SELECT * FROM users WHERE tg_user_id = ?", [tgUserId])) as unknown as User | undefined;
}

export async function getUserById(id: number): Promise<User | undefined> {
  return (await queryOne("SELECT * FROM users WHERE id = ?", [id])) as unknown as User | undefined;
}

export async function updateUserStatus(id: number, isActive: number): Promise<void> {
  await runSql("UPDATE users SET is_active = ? WHERE id = ?", [isActive, id]);
  invalidateUserApiKeyCache(0);
}

export async function deleteUser(id: number): Promise<void> {
  await runSql("DELETE FROM users WHERE id = ?", [id]);
  apiKeyCache.clear();
}

export async function updateUserTgId(oldTgUserId: number, newTgUserId: number): Promise<void> {
  await runSql("UPDATE users SET tg_user_id = ? WHERE tg_user_id = ?", [newTgUserId, oldTgUserId]);
}

// ========================
// API Keys CRUD
// ========================

export interface ApiKey {
  id: number;
  user_id: number;
  key: string;
  is_active: number;
  created_at: string;
}

export async function addApiKey(tgUserId: number): Promise<{ key: string }> {
  const user = await getUserByTgId(tgUserId);
  if (!user) {
    throw new Error(`User with tg_user_id ${tgUserId} not found`);
  }

  const key = `sk-s12ryt-${uuidv7()}`;
  await runSqlAndSave(`INSERT INTO api_keys (user_id, ${quoteIdent("key", drv().dialect)}, created_at) VALUES (?, ?, ${nowExpr()})`, [user.id, key]);
  return { key };
}

export async function getKeysByUser(tgUserId: number): Promise<ApiKey[]> {
  return (await queryAll(
    `SELECT ak.* FROM api_keys ak
     JOIN users u ON ak.user_id = u.id
     WHERE u.tg_user_id = ?
     ORDER BY ak.id`,
    [tgUserId]
  )) as unknown as ApiKey[];
}

export async function getKeyByValue(key: string): Promise<ApiKey | undefined> {
  return (await queryOne(`SELECT * FROM api_keys WHERE ${quoteIdent("key", drv().dialect)} = ?`, [key])) as unknown as ApiKey | undefined;
}

export async function deleteApiKey(id: number): Promise<void> {
  await runSqlAndSave("DELETE FROM api_keys WHERE id = ?", [id]);
  apiKeyCache.clear();
}

export async function getAllKeys(): Promise<(ApiKey & { tg_user_id: number; username: string | null })[]> {
  return (await queryAll(
    `SELECT ak.*, u.tg_user_id, u.username
     FROM api_keys ak
     JOIN users u ON ak.user_id = u.id
     ORDER BY ak.id`
  )) as unknown as (ApiKey & { tg_user_id: number; username: string | null })[];
}

// ========================
// Usage CRUD
// ========================

export interface UsageRecord {
  id: number;
  api_key_id: number;
  provider_id: number;
  input_tokens: number;
  output_tokens: number;
  input_cost: number;
  output_cost: number;
  model: string;
  created_at: string;
}

export interface UsageWithDetails extends UsageRecord {
  provider_name: string;
  api_key: string;
}

/**
 * Record usage — enqueues for batched writing.
 * Non-blocking: returns immediately, no DB I/O on the hot path.
 */
export function recordUsage(
  apiKeyId: number,
  providerId: number,
  inputTokens: number,
  outputTokens: number,
  inputCost: number,
  outputCost: number,
  model: string
): void {
  enqueueUsage({
    api_key_id: apiKeyId,
    provider_id: providerId,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    input_cost: inputCost,
    output_cost: outputCost,
    model,
  });
}

export async function getUsageByUser(tgUserId: number): Promise<UsageWithDetails[]> {
  return (await queryAll(
    `SELECT u.*, p.name as provider_name, ak.${quoteIdent("key", drv().dialect)} as api_key
     FROM usage u
     JOIN api_keys ak ON u.api_key_id = ak.id
     JOIN users us ON ak.user_id = us.id
     JOIN providers p ON u.provider_id = p.id
     WHERE us.tg_user_id = ?
     ORDER BY u.created_at DESC`,
    [tgUserId]
  )) as unknown as UsageWithDetails[];
}

export async function getUsageByProvider(providerId: number): Promise<UsageWithDetails[]> {
  return (await queryAll(
    `SELECT u.*, p.name as provider_name, ak.${quoteIdent("key", drv().dialect)} as api_key
     FROM usage u
     JOIN api_keys ak ON u.api_key_id = ak.id
     JOIN providers p ON u.provider_id = p.id
     WHERE u.provider_id = ?
     ORDER BY u.created_at DESC`,
    [providerId]
  )) as unknown as UsageWithDetails[];
}

export interface UsageBreakdown {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cost: number;
}

export interface TotalUsage {
  total_input_tokens: number;
  total_output_tokens: number;
  total_input_cost: number;
  total_output_cost: number;
  total_cost: number;
  record_count: number;
  total_requests: number;
  by_provider: Record<string, UsageBreakdown>;
  by_user: Record<string, UsageBreakdown>;
}

export async function getTotalUsage(): Promise<TotalUsage> {
  const row = await queryOne(
    `SELECT
       COALESCE(SUM(input_tokens), 0) as total_input_tokens,
       COALESCE(SUM(output_tokens), 0) as total_output_tokens,
       COALESCE(SUM(input_cost), 0) as total_input_cost,
       COALESCE(SUM(output_cost), 0) as total_output_cost,
       COUNT(*) as record_count
     FROM usage`
  );

  const recordCount = row ? Number(row.record_count) : 0;
  const totalInputCost = row ? Number(row.total_input_cost) : 0;
  const totalOutputCost = row ? Number(row.total_output_cost) : 0;

  const providerRows = await queryAll(
    `SELECT
       COALESCE(p.name, 'Unknown') as name,
       COUNT(*) as requests,
       COALESCE(SUM(u.input_tokens), 0) as input_tokens,
       COALESCE(SUM(u.output_tokens), 0) as output_tokens,
       COALESCE(SUM(u.input_cost), 0) as input_cost,
       COALESCE(SUM(u.output_cost), 0) as output_cost
     FROM usage u
     LEFT JOIN providers p ON u.provider_id = p.id
     GROUP BY u.provider_id, p.name
     ORDER BY input_cost + output_cost DESC`
  );

  const by_provider: Record<string, UsageBreakdown> = {};
  for (const pr of providerRows) {
    const inputCost = Number(pr.input_cost) || 0;
    const outputCost = Number(pr.output_cost) || 0;
    by_provider[String(pr.name)] = {
      requests: Number(pr.requests) || 0,
      input_tokens: Number(pr.input_tokens) || 0,
      output_tokens: Number(pr.output_tokens) || 0,
      cost: inputCost + outputCost,
    };
  }

  const userRows = await queryAll(
    `SELECT
       COALESCE(us.username, ${castAsText("us.tg_user_id", drv().dialect)}, 'Unknown') as name,
       COUNT(*) as requests,
       COALESCE(SUM(u.input_tokens), 0) as input_tokens,
       COALESCE(SUM(u.output_tokens), 0) as output_tokens,
       COALESCE(SUM(u.input_cost), 0) as input_cost,
       COALESCE(SUM(u.output_cost), 0) as output_cost
     FROM usage u
     JOIN api_keys ak ON u.api_key_id = ak.id
     LEFT JOIN users us ON ak.user_id = us.id
     GROUP BY ak.user_id, us.username, us.tg_user_id
     ORDER BY input_cost + output_cost DESC`
  );

  const by_user: Record<string, UsageBreakdown> = {};
  for (const ur of userRows) {
    const inputCost = Number(ur.input_cost) || 0;
    const outputCost = Number(ur.output_cost) || 0;
    by_user[String(ur.name)] = {
      requests: Number(ur.requests) || 0,
      input_tokens: Number(ur.input_tokens) || 0,
      output_tokens: Number(ur.output_tokens) || 0,
      cost: inputCost + outputCost,
    };
  }

  return {
    total_input_tokens: row ? Number(row.total_input_tokens) : 0,
    total_output_tokens: row ? Number(row.total_output_tokens) : 0,
    total_input_cost: totalInputCost,
    total_output_cost: totalOutputCost,
    total_cost: totalInputCost + totalOutputCost,
    record_count: recordCount,
    total_requests: recordCount,
    by_provider,
    by_user,
  };
}

// ========================
// Settings CRUD
// ========================

export async function getSetting(key: string): Promise<string | null> {
  const row = await queryOne(`SELECT value FROM settings WHERE ${quoteIdent("key", drv().dialect)} = ?`, [key]);
  return (row?.value as string) ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await runSql(
    buildUpsertSql(drv().dialect, "settings", ["key", "value"], ["key"], ["value"], false),
    [key, value]
  );
}

// ========================
// Model Prices CRUD
// ========================

export interface ModelPrice {
  id: number;
  provider_id: number;
  model: string;
  input_price: number | null;
  output_price: number | null;
  created_at: string;
  updated_at: string;
}

/**
 * Get price for a specific model under a provider.
 * Returns undefined if no record exists.
 */
export async function getModelPrice(providerId: number, modelName: string): Promise<ModelPrice | undefined> {
  return (await queryOne(
    "SELECT * FROM model_prices WHERE provider_id = ? AND model = ?",
    [providerId, modelName]
  )) as unknown as ModelPrice | undefined;
}

/**
 * Get all model prices for a provider.
 */
export async function getModelPricesByProvider(providerId: number): Promise<ModelPrice[]> {
  return (await queryAll(
    "SELECT * FROM model_prices WHERE provider_id = ? ORDER BY model",
    [providerId]
  )) as unknown as ModelPrice[];
}

/**
 * Upsert a model price record. If a record for (provider_id, model) exists, update it.
 * Prices are in USD per 1M tokens.
 */
export async function upsertModelPrice(
  providerId: number,
  modelName: string,
  inputPrice: number | null,
  outputPrice: number | null
): Promise<void> {
  await runSql(
    buildUpsertSql(drv().dialect, "model_prices", ["provider_id", "model", "input_price", "output_price"], ["provider_id", "model"], ["input_price", "output_price"], true),
    [providerId, modelName, inputPrice, outputPrice]
  );
  invalidateProviderCache();
}

/**
 * Batch upsert model prices using a single transaction.
 */
export async function batchUpsertModelPrices(
  providerId: number,
  entries: Array<{ model: string; input_price: number | null; output_price: number | null }>
): Promise<void> {
  if (entries.length === 0) return;

  const d = drv();
  try {
    await d.transaction(async () => {
      for (const entry of entries) {
        await d.run(
          buildUpsertSql(drv().dialect, "model_prices", ["provider_id", "model", "input_price", "output_price"], ["provider_id", "model"], ["input_price", "output_price"], true),
          [providerId, entry.model, entry.input_price ?? null, entry.output_price ?? null]
        );
      }
    });
  } catch (err) {
    console.error("[db] batchUpsertModelPrices error:", err);
    throw err;
  }
  invalidateProviderCache();
}

/**
 * Delete model prices for models no longer in the provider's model list.
 */
export async function cleanupModelPrices(providerId: number, currentModels: string[]): Promise<void> {
  if (currentModels.length === 0) {
    await runSql("DELETE FROM model_prices WHERE provider_id = ?", [providerId]);
    return;
  }
  const placeholders = currentModels.map(() => "?").join(",");
  await runSql(
    `DELETE FROM model_prices WHERE provider_id = ? AND model NOT IN (${placeholders})`,
    [providerId, ...currentModels]
  );
  invalidateProviderCache();
}

/**
 * Delete all model prices for a provider.
 */
export async function deleteModelPricesByProvider(providerId: number): Promise<void> {
  await runSql("DELETE FROM model_prices WHERE provider_id = ?", [providerId]);
  invalidateProviderCache();
}

// ---------------------------------------------------------------------------
// Coding mode configuration
// ---------------------------------------------------------------------------

export interface CodingConfig {
  id: number;
  user_id: number;
  is_active: number;
  fallback_models: string;
  max_retries: number;
  fallback_list: string[];
  session_input_tokens: number;
  session_output_tokens: number;
  session_input_cost: number;
  session_output_cost: number;
  session_requests: number;
  session_model_counts: string;
}

function rowToCodingConfig(row: Record<string, unknown>): CodingConfig {
  const config = row as Record<string, SqlValue>;
  return {
    id: config.id as number,
    user_id: config.user_id as number,
    is_active: config.is_active as number,
    fallback_models: (config.fallback_models as string) || "",
    max_retries: (config.max_retries as number) || 3,
    fallback_list: ((config.fallback_models as string) || "").split(",").map((m: string) => m.trim()).filter(Boolean),
    session_input_tokens: (config.session_input_tokens as number) || 0,
    session_output_tokens: (config.session_output_tokens as number) || 0,
    session_input_cost: (config.session_input_cost as number) || 0,
    session_output_cost: (config.session_output_cost as number) || 0,
    session_requests: (config.session_requests as number) || 0,
    session_model_counts: (config.session_model_counts as string) || "{}",
  };
}

/**
 * Get coding config for a user by internal user_id.
 */
export async function getCodingConfig(userId: number): Promise<CodingConfig | null> {
  const row = await queryOne("SELECT * FROM coding_configs WHERE user_id = ?", [userId]);
  if (!row) return null;
  return rowToCodingConfig(row);
}

/**
 * Get coding config by Telegram user ID.
 */
export async function getCodingConfigByTgId(tgUserId: number): Promise<CodingConfig | null> {
  const user = await getUserByTgId(tgUserId);
  if (!user) return null;
  return getCodingConfig(user.id);
}

/**
 * Set (upsert) coding config for a user.
 */
export async function setCodingConfig(
  userId: number,
  opts: { isActive?: number; fallbackModels?: string; maxRetries?: number }
): Promise<CodingConfig | null> {
  const existing = await queryOne("SELECT id FROM coding_configs WHERE user_id = ?", [userId]);
  const now = nowExpr();

  if (existing) {
    const sets: string[] = [];
    const params: SqlValue[] = [];
    if (opts.isActive !== undefined) { sets.push("is_active = ?"); params.push(opts.isActive); }
    if (opts.fallbackModels !== undefined) { sets.push("fallback_models = ?"); params.push(opts.fallbackModels); }
    if (opts.maxRetries !== undefined) { sets.push("max_retries = ?"); params.push(opts.maxRetries); }
    if (sets.length > 0) {
      sets.push(`updated_at = ${now}`);
      params.push(userId);
      await runSql(`UPDATE coding_configs SET ${sets.join(", ")} WHERE user_id = ?`, params);
    }
  } else {
    await runSql(
      buildUpsertSql(drv().dialect, "coding_configs", ["user_id", "is_active", "fallback_models", "max_retries"], ["user_id"], ["is_active", "fallback_models", "max_retries"], true),
      [
        userId,
        opts.isActive ?? 0,
        opts.fallbackModels ?? "",
        opts.maxRetries ?? 3,
      ]
    );
  }

  return getCodingConfig(userId);
}

/**
 * Given an api_key_id, return the user's active coding config (if any).
 * Used by the API server to check fallback logic.
 */
export async function getActiveCodingForApiKey(apiKeyId: number): Promise<CodingConfig | null> {
  const row = await queryOne(
    `SELECT cc.* FROM coding_configs cc
     JOIN api_keys ak ON ak.user_id = cc.user_id
     WHERE ak.id = ? AND cc.is_active = 1`,
    [apiKeyId]
  );
  if (!row) return null;
  return rowToCodingConfig(row);
}

/**
 * Increment coding mode session stats after a successful coding-mode request.
 */
export async function incrementCodingSessionStats(
  userId: number,
  inputTokens: number,
  outputTokens: number,
  inputCost: number,
  outputCost: number,
  actualModel: string,
): Promise<void> {
  const row = await queryOne(`SELECT session_model_counts FROM coding_configs WHERE user_id = ?`, [userId]);
  let counts: Record<string, number> = {};
  try {
    counts = row?.session_model_counts ? JSON.parse(row.session_model_counts as string) : {};
  } catch { counts = {}; }
  counts[actualModel] = (counts[actualModel] || 0) + 1;

  const now = nowExpr();
  await runSql(
    `UPDATE coding_configs SET
       session_input_tokens = session_input_tokens + ?,
       session_output_tokens = session_output_tokens + ?,
       session_input_cost = session_input_cost + ?,
       session_output_cost = session_output_cost + ?,
       session_requests = session_requests + 1,
       session_model_counts = ?,
       updated_at = ${now}
     WHERE user_id = ?`,
    [inputTokens, outputTokens, inputCost, outputCost, JSON.stringify(counts), userId]
  );
}

/**
 * Reset coding mode session stats to zero (called when coding mode is activated).
 */
export async function resetCodingSessionStats(userId: number): Promise<void> {
  const now = nowExpr();
  await runSql(
    `UPDATE coding_configs SET
       session_input_tokens = 0,
       session_output_tokens = 0,
       session_input_cost = 0.0,
       session_output_cost = 0.0,
       session_requests = 0,
       session_model_counts = '{}',
       updated_at = ${now}
     WHERE user_id = ?`,
    [userId]
  );
}

// ===========================================================================
// Model Restrictions (per user / per API key)
// ===========================================================================

export interface ModelRestriction {
  id: number;
  user_id: number;
  api_key_id: number | null;
  mode: "whitelist" | "blacklist";
  models: string;
  created_at: string;
  updated_at: string;
}

/**
 * Get model restriction for a specific user or API key.
 * api_key_id = null → user-level; api_key_id = number → key-level.
 */
export async function getModelRestriction(
  userId: number,
  apiKeyId: number | null,
): Promise<ModelRestriction | null> {
  if (apiKeyId !== null) {
    return (await queryOne(
      "SELECT * FROM model_restrictions WHERE user_id = ? AND api_key_id = ?",
      [userId, apiKeyId],
    )) as unknown as ModelRestriction | null;
  }
  return (await queryOne(
    "SELECT * FROM model_restrictions WHERE user_id = ? AND api_key_id IS NULL",
    [userId],
  )) as unknown as ModelRestriction | null;
}

/**
 * Get ALL restrictions for a user (both user-level and key-level).
 */
export async function getModelRestrictionsForUser(
  userId: number,
): Promise<ModelRestriction[]> {
  return (await queryAll(
    "SELECT * FROM model_restrictions WHERE user_id = ? ORDER BY api_key_id IS NULL DESC, api_key_id ASC",
    [userId],
  )) as unknown as ModelRestriction[];
}

/**
 * Set (upsert) model restriction.
 * mode: 'whitelist' = only these models allowed; 'blacklist' = these models blocked.
 */
export async function setModelRestriction(
  userId: number,
  apiKeyId: number | null,
  mode: "whitelist" | "blacklist",
  models: string,
): Promise<void> {
  const modelsStr = models
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean)
    .join(",");

  const existing = await getModelRestriction(userId, apiKeyId);
  const now = nowExpr();
  if (existing) {
    await runSql(
      `UPDATE model_restrictions SET mode = ?, models = ?, updated_at = ${now} WHERE id = ?`,
      [mode, modelsStr, existing.id],
    );
  } else {
    await runSql(
      `INSERT INTO model_restrictions (user_id, api_key_id, mode, models, created_at, updated_at) VALUES (?, ?, ?, ?, ${nowExpr()}, ${nowExpr()})`,
      [userId, apiKeyId, mode, modelsStr],
    );
  }
}

/**
 * Delete a model restriction.
 */
export async function deleteModelRestriction(
  userId: number,
  apiKeyId: number | null,
): Promise<boolean> {
  const existing = await getModelRestriction(userId, apiKeyId);
  if (!existing) return false;
  await runSql("DELETE FROM model_restrictions WHERE id = ?", [existing.id]);
  return true;
}

/**
 * Check if a specific model is allowed for the given user/apiKey.
 *
 * Priority:
 * 1. Key-level restriction (model_restrictions with specific apiKeyId)
 *    → If exists, apply it (whitelist/blacklist).
 * 2. Admin bypass (admin always allowed, except key-level above).
 * 3. User-level restriction (model_restrictions with apiKeyId = NULL)
 *    → If exists, apply it.
 * 4. Group-level allowed_models (user_groups.allowed_models)
 *    → If non-empty, acts as whitelist for that model.
 * 5. If no restriction at all → default allow (return true).
 */
export async function checkModelAllowed(
  userId: number,
  apiKeyId: number | null,
  modelName: string,
  isAdmin: boolean,
): Promise<boolean> {
  // 1. Try key-level restriction (always applies, even for admin)
  if (apiKeyId !== null) {
    const keyRestriction = await getModelRestriction(userId, apiKeyId);
    if (keyRestriction) {
      return applyRestriction(keyRestriction, modelName);
    }
  }

  // 2. Admin bypasses user-level restrictions
  if (isAdmin) return true;

  // 3. Check user-level restriction
  const userRestriction = await getModelRestriction(userId, null);
  if (userRestriction) {
    return applyRestriction(userRestriction, modelName);
  }

  // 4. Check group-level allowed_models (whitelist from user group)
  const limits = await getCachedEffectiveLimits(userId, apiKeyId);
  if (limits.allowedModels.length > 0) {
    return limits.allowedModels.includes(modelName);
  }

  // 5. No restriction found → default allow for non-admin
  return true;
}

function applyRestriction(
  restriction: ModelRestriction,
  modelName: string,
): boolean {
  const models = restriction.models.split(",").map((m) => m.trim()).filter(Boolean);
  if (models.length === 0) return false; // empty list → deny all

  if (restriction.mode === "whitelist") {
    return models.includes(modelName);
  } else {
    // blacklist
    return !models.includes(modelName);
  }
}

/**
 * Get the list of allowed models for a user/apiKey from the full model list.
 * Used by /v1/models endpoint.
 */
export async function getAllowedModels(
  userId: number,
  apiKeyId: number | null,
  allModels: string[],
  isAdmin: boolean,
): Promise<string[]> {
  // 1. Try key-level restriction
  if (apiKeyId !== null) {
    const keyRestriction = await getModelRestriction(userId, apiKeyId);
    if (keyRestriction) {
      return filterModelsByRestriction(keyRestriction, allModels);
    }
  }

  // 2. Admin bypasses user-level
  if (isAdmin) return allModels;

  // 3. User-level restriction
  const userRestriction = await getModelRestriction(userId, null);
  if (userRestriction) {
    return filterModelsByRestriction(userRestriction, allModels);
  }

  // 4. Check group-level allowed_models (whitelist from user group)
  const limits = await getCachedEffectiveLimits(userId, apiKeyId);
  if (limits.allowedModels.length > 0) {
    return allModels.filter((m) => limits.allowedModels.includes(m));
  }

  // 5. No restriction found → allow all for non-admin
  return allModels;
}

function filterModelsByRestriction(
  restriction: ModelRestriction,
  allModels: string[],
): string[] {
  const restrictedModels = new Set(
    restriction.models.split(",").map((m) => m.trim()).filter(Boolean),
  );
  if (restrictedModels.size === 0) return [];

  if (restriction.mode === "whitelist") {
    return allModels.filter((m) => restrictedModels.has(m));
  } else {
    return allModels.filter((m) => !restrictedModels.has(m));
  }
}

// ===========================================================================
// User Groups & Limits Management
// ===========================================================================

export interface UserGroup {
  id: number;
  name: string;
  display_name: string | null;
  rpm_limit: number;
  tpm_limit: number;
  concurrency_limit: number;
  daily_token_limit: number;
  monthly_token_limit: number;
  daily_cost_limit: number;
  monthly_cost_limit: number;
  is_default: number;
  allowed_models: string;
  created_at: string;
  updated_at: string;
}

export interface UserWithLimits extends User {
  group_id: number | null;
  expires_at: string | null;
  rpm_override: number | null;
  tpm_override: number | null;
  concurrency_override: number | null;
  daily_token_override: number | null;
  monthly_token_override: number | null;
  daily_cost_override: number | null;
  monthly_cost_override: number | null;
}

export interface ApiKeyWithLimits extends ApiKey {
  expires_at: string | null;
  rpm_override: number | null;
  tpm_override: number | null;
  concurrency_override: number | null;
  daily_token_override: number | null;
  monthly_token_override: number | null;
  daily_cost_override: number | null;
  monthly_cost_override: number | null;
}

/**
 * Effective limits for a user + API key combination.
 * A value of 0 means unlimited.
 */
export interface EffectiveLimits {
  rpm: number;
  tpm: number;
  concurrency: number;
  dailyTokenLimit: number;
  monthlyTokenLimit: number;
  dailyCostLimit: number;
  monthlyCostLimit: number;
  expiresAt: string | null;
  allowedModels: string[];
}

// --- User Groups CRUD ---

export async function getUserGroups(): Promise<UserGroup[]> {
  return (await queryAll("SELECT * FROM user_groups ORDER BY is_default DESC, name ASC")) as unknown as UserGroup[];
}

export async function getUserGroupById(id: number): Promise<UserGroup | undefined> {
  return (await queryOne("SELECT * FROM user_groups WHERE id = ?", [id])) as unknown as UserGroup | undefined;
}

export async function getUserGroupByName(name: string): Promise<UserGroup | undefined> {
  return (await queryOne("SELECT * FROM user_groups WHERE name = ?", [name])) as unknown as UserGroup | undefined;
}

export async function getDefaultUserGroup(): Promise<UserGroup | undefined> {
  return (await queryOne("SELECT * FROM user_groups WHERE is_default = 1")) as unknown as UserGroup | undefined;
}

export interface UserGroupInput {
  name: string;
  display_name?: string | null;
  rpm_limit?: number;
  tpm_limit?: number;
  concurrency_limit?: number;
  daily_token_limit?: number;
  monthly_token_limit?: number;
  daily_cost_limit?: number;
  monthly_cost_limit?: number;
  allowed_models?: string;
}

export async function addUserGroup(data: UserGroupInput): Promise<void> {
  await runSql(
    `INSERT INTO user_groups (name, display_name, rpm_limit, tpm_limit, concurrency_limit,
      daily_token_limit, monthly_token_limit, daily_cost_limit, monthly_cost_limit, allowed_models)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.name,
      data.display_name ?? null,
      data.rpm_limit ?? 0,
      data.tpm_limit ?? 0,
      data.concurrency_limit ?? 0,
      data.daily_token_limit ?? 0,
      data.monthly_token_limit ?? 0,
      data.daily_cost_limit ?? 0,
      data.monthly_cost_limit ?? 0,
      data.allowed_models ?? "",
    ] as SqlValue[]
  );
  invalidateEffectiveLimitsCache();
}

export async function updateUserGroup(id: number, data: Partial<UserGroupInput>): Promise<void> {
  const fields: string[] = [];
  const values: SqlValue[] = [];

  const allowedFields: (keyof UserGroupInput)[] = [
    "name", "display_name", "rpm_limit", "tpm_limit", "concurrency_limit",
    "daily_token_limit", "monthly_token_limit", "daily_cost_limit", "monthly_cost_limit",
    "allowed_models"
  ];

  for (const key of allowedFields) {
    if (key in data && data[key] !== undefined) {
      fields.push(`${key} = ?`);
      values.push(data[key] as SqlValue);
    }
  }

  if (fields.length === 0) return;

  fields.push(`updated_at = ${nowExpr()}`);
  values.push(id);

  await runSql(`UPDATE user_groups SET ${fields.join(", ")} WHERE id = ?`, values);
  invalidateEffectiveLimitsCache();
}

export async function deleteUserGroup(id: number): Promise<void> {
  const group = await getUserGroupById(id);
  if (group && group.is_default === 1) {
    throw new Error("Cannot delete the default user group");
  }
  const defaultGroup = await getDefaultUserGroup();
  if (defaultGroup && defaultGroup.id !== id) {
    await runSql("UPDATE users SET group_id = ? WHERE group_id = ?", [defaultGroup.id, id]);
  }
  await runSql("DELETE FROM user_groups WHERE id = ?", [id]);
  invalidateEffectiveLimitsCache();
}

export async function setDefaultUserGroup(id: number): Promise<void> {
  const group = await getUserGroupById(id);
  if (!group) throw new Error("User group not found");
  await runSql("UPDATE user_groups SET is_default = 0");
  await runSql("UPDATE user_groups SET is_default = 1 WHERE id = ?", [id]);
  invalidateEffectiveLimitsCache();
}

// --- User limits management ---

export async function getUserWithLimits(id: number): Promise<UserWithLimits | undefined> {
  return (await queryOne("SELECT * FROM users WHERE id = ?", [id])) as unknown as UserWithLimits | undefined;
}

export async function setUserGroup(userId: number, groupId: number): Promise<void> {
  if (!(await getUserGroupById(groupId))) {
    throw new Error("User group not found");
  }
  await runSql("UPDATE users SET group_id = ? WHERE id = ?", [groupId, userId]);
  invalidateEffectiveLimitsCache(userId);
}

export interface UserOverridesInput {
  expires_at?: string | null;
  rpm_override?: number | null;
  tpm_override?: number | null;
  concurrency_override?: number | null;
  daily_token_override?: number | null;
  monthly_token_override?: number | null;
  daily_cost_override?: number | null;
  monthly_cost_override?: number | null;
}

export async function setUserOverrides(userId: number, overrides: UserOverridesInput): Promise<void> {
  const fields: string[] = [];
  const values: SqlValue[] = [];

  const allowedFields: (keyof UserOverridesInput)[] = [
    "expires_at", "rpm_override", "tpm_override", "concurrency_override",
    "daily_token_override", "monthly_token_override", "daily_cost_override", "monthly_cost_override"
  ];

  for (const key of allowedFields) {
    if (key in overrides && overrides[key] !== undefined) {
      fields.push(`${key} = ?`);
      values.push(overrides[key] as SqlValue);
    }
  }

  if (fields.length === 0) return;
  values.push(userId);

  await runSql(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`, values);
  invalidateEffectiveLimitsCache(userId);
}

// --- API Key limits management ---

export async function getApiKeyWithLimits(id: number): Promise<ApiKeyWithLimits | undefined> {
  return (await queryOne("SELECT * FROM api_keys WHERE id = ?", [id])) as unknown as ApiKeyWithLimits | undefined;
}

export interface ApiKeyOverridesInput {
  expires_at?: string | null;
  rpm_override?: number | null;
  tpm_override?: number | null;
  concurrency_override?: number | null;
  daily_token_override?: number | null;
  monthly_token_override?: number | null;
  daily_cost_override?: number | null;
  monthly_cost_override?: number | null;
}

export async function setApiKeyOverrides(apiKeyId: number, overrides: ApiKeyOverridesInput): Promise<void> {
  const fields: string[] = [];
  const values: SqlValue[] = [];

  const allowedFields: (keyof ApiKeyOverridesInput)[] = [
    "expires_at", "rpm_override", "tpm_override", "concurrency_override",
    "daily_token_override", "monthly_token_override", "daily_cost_override", "monthly_cost_override"
  ];

  for (const key of allowedFields) {
    if (key in overrides && overrides[key] !== undefined) {
      fields.push(`${key} = ?`);
      values.push(overrides[key] as SqlValue);
    }
  }

  if (fields.length === 0) return;
  values.push(apiKeyId);

  await runSql(`UPDATE api_keys SET ${fields.join(", ")} WHERE id = ?`, values);
  // API key overrides affect any user that holds this key — clear entire cache
  invalidateEffectiveLimitsCache();
}

// --- Effective limits calculation ---

/**
 * Helper: pick first non-null value from overrides → group → 0.
 * null = not set (inherit), 0 = explicitly unlimited, >0 = specific limit.
 */
function pickLimit(
  apiKeyOverride: number | null | undefined,
  userOverride: number | null | undefined,
  groupLimit: number | null | undefined,
): number {
  if (apiKeyOverride !== null && apiKeyOverride !== undefined) return apiKeyOverride;
  if (userOverride !== null && userOverride !== undefined) return userOverride;
  if (groupLimit !== null && groupLimit !== undefined) return groupLimit;
  return 0; // unlimited
}

/**
 * Calculate effective limits for a given user + API key.
 * Priority: apiKey override > user override > user group limit > 0 (unlimited).
 *
 * Uses a single JOIN query instead of 3 separate SELECTs.
 */
export async function getEffectiveLimits(userId: number, apiKeyId: number | null): Promise<EffectiveLimits> {
  const row = await queryOne(
    `SELECT
       u.rpm_override AS u_rpm, u.tpm_override AS u_tpm,
       u.concurrency_override AS u_conc, u.daily_token_override AS u_dt,
       u.monthly_token_override AS u_mt, u.daily_cost_override AS u_dc,
       u.monthly_cost_override AS u_mc, u.expires_at AS u_exp,
       COALESCE(g.rpm_limit, dg.rpm_limit) AS g_rpm,
       COALESCE(g.tpm_limit, dg.tpm_limit) AS g_tpm,
       COALESCE(g.concurrency_limit, dg.concurrency_limit) AS g_conc,
       COALESCE(g.daily_token_limit, dg.daily_token_limit) AS g_dt,
       COALESCE(g.monthly_token_limit, dg.monthly_token_limit) AS g_mt,
       COALESCE(g.daily_cost_limit, dg.daily_cost_limit) AS g_dc,
       COALESCE(g.monthly_cost_limit, dg.monthly_cost_limit) AS g_mc,
       COALESCE(NULLIF(g.allowed_models, ''), NULLIF(dg.allowed_models, '')) AS g_models,
       ak.rpm_override AS ak_rpm, ak.tpm_override AS ak_tpm,
       ak.concurrency_override AS ak_conc, ak.daily_token_override AS ak_dt,
       ak.monthly_token_override AS ak_mt, ak.daily_cost_override AS ak_dc,
       ak.monthly_cost_override AS ak_mc, ak.expires_at AS ak_exp
     FROM users u
     LEFT JOIN user_groups g ON u.group_id = g.id
     LEFT JOIN user_groups dg ON dg.is_default = 1
     LEFT JOIN api_keys ak ON ak.id = ?
     WHERE u.id = ?`,
    [apiKeyId, userId],
  );

  if (!row) {
    // User not found — return unlimited defaults
    return {
      rpm: 0, tpm: 0, concurrency: 0,
      dailyTokenLimit: 0, monthlyTokenLimit: 0,
      dailyCostLimit: 0, monthlyCostLimit: 0,
      expiresAt: null,
      allowedModels: [],
    };
  }

  return {
    rpm: pickLimit(row.ak_rpm as number | null, row.u_rpm as number | null, row.g_rpm as number | null),
    tpm: pickLimit(row.ak_tpm as number | null, row.u_tpm as number | null, row.g_tpm as number | null),
    concurrency: pickLimit(row.ak_conc as number | null, row.u_conc as number | null, row.g_conc as number | null),
    dailyTokenLimit: pickLimit(row.ak_dt as number | null, row.u_dt as number | null, row.g_dt as number | null),
    monthlyTokenLimit: pickLimit(row.ak_mt as number | null, row.u_mt as number | null, row.g_mt as number | null),
    dailyCostLimit: pickLimit(row.ak_dc as number | null, row.u_dc as number | null, row.g_dc as number | null),
    monthlyCostLimit: pickLimit(row.ak_mc as number | null, row.u_mc as number | null, row.g_mc as number | null),
    expiresAt: (row.ak_exp as string | null) ?? (row.u_exp as string | null) ?? null,
    allowedModels: ((row.g_models as string | null) ?? "")
      .split(",").map((m) => m.trim()).filter(Boolean),
  };
}

// --- Effective limits TTL cache (60s) ---

const EFFECTIVE_LIMITS_TTL = 60_000;
const EFFECTIVE_LIMITS_CACHE_MAX = 512;
const effectiveLimitsCache = new Map<string, { limits: EffectiveLimits; expiresAt: number }>();

function effectiveLimitsCacheKey(userId: number, apiKeyId: number | null): string {
  return `${userId}:${apiKeyId ?? "null"}`;
}

/**
 * Cached version of getEffectiveLimits.
 * Cache hit returns synchronously-wrapped value; cache miss falls back to
 * async DB query. LRU eviction when over capacity.
 */
export async function getCachedEffectiveLimits(userId: number, apiKeyId: number | null): Promise<EffectiveLimits> {
  const key = effectiveLimitsCacheKey(userId, apiKeyId);
  const cached = effectiveLimitsCache.get(key);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    // LRU: move to end (most recently used) by re-inserting
    effectiveLimitsCache.delete(key);
    effectiveLimitsCache.set(key, cached);
    return cached.limits;
  }
  const limits = await getEffectiveLimits(userId, apiKeyId);
  effectiveLimitsCache.set(key, { limits, expiresAt: now + EFFECTIVE_LIMITS_TTL });
  if (effectiveLimitsCache.size > EFFECTIVE_LIMITS_CACHE_MAX) {
    const oldestKey = effectiveLimitsCache.keys().next().value;
    if (oldestKey !== undefined) effectiveLimitsCache.delete(oldestKey);
  }
  return limits;
}

/**
 * Invalidate the effective limits cache.
 * Call after any mutation to user groups, user overrides, or API key overrides.
 * @param userId If provided, invalidates only entries for this user. Otherwise clears all.
 */
export function invalidateEffectiveLimitsCache(userId?: number): void {
  if (userId === undefined) {
    effectiveLimitsCache.clear();
    return;
  }
  const prefix = `${userId}:`;
  for (const key of effectiveLimitsCache.keys()) {
    if (key.startsWith(prefix)) {
      effectiveLimitsCache.delete(key);
    }
  }
}

// --- Quota queries (aggregate from usage table) ---

export interface UsageQuota {
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost: number;
}

/**
 * Get today's token usage and cost for a user or specific API key.
 */
export async function getDailyUsage(userId: number, apiKeyId: number | null = null): Promise<UsageQuota> {
  return getPeriodUsage("day", userId, apiKeyId);
}

/**
 * Get this month's token usage and cost for a user or specific API key.
 */
export async function getMonthlyUsage(userId: number, apiKeyId: number | null = null): Promise<UsageQuota> {
  return getPeriodUsage("month", userId, apiKeyId);
}

/**
 * Period-based usage aggregate.
 *
 * The date comparison is dialect-aware (see `periodCondition` in dialect.ts):
 * SQLite uses date()/strftime(), Postgres uses ::date casts, MySQL uses
 * DATE()/DATE_FORMAT().
 */
async function getPeriodUsage(period: "day" | "month", userId: number, apiKeyId: number | null): Promise<UsageQuota> {
  const col = apiKeyId !== null ? "created_at" : "u.created_at";
  const dateCondition = periodCondition(period, drv().dialect, col);

  let sql: string;
  let params: SqlValue[];

  if (apiKeyId !== null) {
    sql = `SELECT
             COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
             COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
             COALESCE(SUM(input_cost + output_cost), 0) AS total_cost
           FROM usage
           WHERE api_key_id = ? AND ${dateCondition}`;
    params = [apiKeyId];
  } else {
    sql = `SELECT
             COALESCE(SUM(u.input_tokens), 0) AS total_input_tokens,
             COALESCE(SUM(u.output_tokens), 0) AS total_output_tokens,
             COALESCE(SUM(u.input_cost + u.output_cost), 0) AS total_cost
           FROM usage u
           JOIN api_keys ak ON u.api_key_id = ak.id
           WHERE ak.user_id = ? AND ${dateCondition}`;
    params = [userId];
  }

  const row = await queryOne(sql, params);
  return {
    total_input_tokens: Number(row?.total_input_tokens ?? 0),
    total_output_tokens: Number(row?.total_output_tokens ?? 0),
    total_cost: Number(row?.total_cost ?? 0),
  };
}

/**
 * Check if a user/API key has expired.
 * Returns true if expired, false otherwise.
 */
export function isExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  const expiry = new Date(expiresAt + "Z"); // treat as UTC
  return expiry.getTime() < Date.now();
}

// ---------------------------------------------------------------------------
// Backup / Restore (SQLite-only in stage 2; cloud flow arrives in stage 3/4)
// ---------------------------------------------------------------------------

/* BACKUP_TABLES is imported from schema/tables.js (shared across dialects). */

export interface BackupData {
  version: 1;
  exportedAt: string;
  tables: Record<string, Record<string, unknown>[]>;
}

export interface BackupSummary {
  version: number;
  exportedAt: string;
  counts: Record<string, number>;
}

/**
 * Convert a SqlValue to a JSON-serializable value.
 * bigint → number (SQLite integers fit in JS safe-integer range for this project)
 * Uint8Array (BLOB) → number[] (round-tripped via toSqlValue on import)
 */
function toJsonValue(val: SqlValue): unknown {
  if (val === null) return null;
  if (typeof val === "bigint") return Number(val);
  if (val instanceof Uint8Array) return Array.from(val);
  return val;
}

/**
 * Convert a deserialized JSON value back to a SqlValue for INSERT.
 */
function toSqlValue(val: unknown): SqlValue {
  if (val === null || val === undefined) return null;
  if (typeof val === "boolean") return val ? 1 : 0;
  if (typeof val === "number") return val;
  if (typeof val === "string") return val;
  if (Array.isArray(val)) return new Uint8Array(val);
  // Fallback: stringify anything unexpected
  return String(val);
}

/**
 * Export all backup tables as a JSON-serializable object.
 * Flushes pending usage writes first to ensure completeness.
 */
export async function exportDatabase(): Promise<BackupData> {
  await flushUsageQueue();
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const table of BACKUP_TABLES) {
    const rows = await queryAll(`SELECT * FROM ${table}`);
    tables[table] = rows.map((row) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) {
        out[k] = toJsonValue(v);
      }
      return out;
    });
  }
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    tables,
  };
}

/**
 * Extract a compact summary from backup data for display.
 */
export function getBackupSummary(data: BackupData): BackupSummary {
  const counts: Record<string, number> = {};
  for (const [table, rows] of Object.entries(data.tables)) {
    counts[table] = Array.isArray(rows) ? rows.length : 0;
  }
  return {
    version: data.version ?? 1,
    exportedAt: data.exportedAt ?? "unknown",
    counts,
  };
}

/**
 * Get column names for a table.
 * Uses a compile-time constant map (TABLE_COLUMNS) instead of PRAGMA so this
 * works identically across SQLite/PG/MySQL without dialect-specific introspection.
 */
function getTableColumns(tableName: string): string[] {
  const cols = TABLE_COLUMNS[tableName];
  return cols ? [...cols] : [];
}

function assertNoForeignKeyViolations(d: SqlJsDatabase): void {
  const result = d.exec("PRAGMA foreign_key_check");
  const violations = result[0]?.values ?? [];
  if (violations.length === 0) return;

  const samples = violations.slice(0, 5).map((row) => {
    const [table, rowId, parent, fkId] = row;
    return `${table}.${rowId} -> ${parent} (fk ${fkId})`;
  });
  const suffix = violations.length > samples.length
    ? `; and ${violations.length - samples.length} more`
    : "";
  throw new Error(`Invalid backup: foreign key violations detected: ${samples.join(", ")}${suffix}`);
}

function createRestoreShadowDb(): SqlJsDatabase {
  const DatabaseCtor = getDb().constructor as unknown as { new (): SqlJsDatabase };
  const shadow = new DatabaseCtor();
  createTables(shadow);
  return shadow;
}

function validateBackupAgainstSchema(data: BackupData): void {
  const shadow = createRestoreShadowDb();
  try {
    shadow.exec("PRAGMA foreign_keys = OFF");
    shadow.exec("BEGIN");

    for (const table of BACKUP_TABLES) {
      shadow.exec(`DELETE FROM ${table}`);
      try {
        shadow.exec(`DELETE FROM sqlite_sequence WHERE name = '${table}'`);
      } catch {
        // sqlite_sequence may not exist yet — ignore
      }
    }

    for (const table of BACKUP_TABLES) {
      const rows = (data.tables as Record<string, unknown>)[table];
      if (!Array.isArray(rows) || rows.length === 0) continue;

      const columns = getTableColumns(table);
      if (columns.length === 0) continue;

      for (const row of rows) {
        if (typeof row !== "object" || row === null) continue;
        const rowRecord = row as Record<string, unknown>;
        const presentCols = columns.filter((c) => c in rowRecord);
        if (presentCols.length === 0) continue;
        const colList = presentCols.map((c) => `"${c}"`).join(", ");
        const placeholders = presentCols.map(() => "?").join(", ");
        const sql = `INSERT INTO ${table} (${colList}) VALUES (${placeholders})`;
        const values: SqlValue[] = presentCols.map((c) => toSqlValue(rowRecord[c]));
        shadow.run(sql, values);
      }
    }

    assertNoForeignKeyViolations(shadow);
    shadow.exec("ROLLBACK");
  } catch (err) {
    try {
      shadow.exec("ROLLBACK");
    } catch {
      // Ignore rollback errors
    }
    throw err;
  } finally {
    try {
      shadow.exec("PRAGMA foreign_keys = ON");
    } catch {
      // Ignore
    }
    try {
      shadow.close();
    } catch {
      // Ignore
    }
  }
}

/**
 * SQLite restore path: shadow-DB preflight + raw sql.js handle bulk insert.
 * Preserves the original behaviour (zero regression for existing SQLite users).
 */
async function importDatabaseSqlite(data: BackupData): Promise<void> {
  // Preflight: validate backup on a shadow DB before touching the live database.
  validateBackupAgainstSchema(data);

  const d = getDb();

  try {
    d.exec("PRAGMA foreign_keys = OFF");
    d.exec("BEGIN");

    // Wipe all backup tables and reset AUTOINCREMENT sequences
    for (const table of BACKUP_TABLES) {
      d.exec(`DELETE FROM ${table}`);
      try {
        d.exec(`DELETE FROM sqlite_sequence WHERE name = '${table}'`);
      } catch {
        // sqlite_sequence table might not exist yet — ignore
      }
    }

    // Re-insert rows for each table
    for (const table of BACKUP_TABLES) {
      const rows = (data.tables as Record<string, unknown>)[table];
      if (!Array.isArray(rows) || rows.length === 0) continue;

      const columns = getTableColumns(table);
      if (columns.length === 0) continue;

      for (const row of rows) {
        if (typeof row !== "object" || row === null) continue;
        const rowRecord = row as Record<string, unknown>;
        // Only include columns present in both the schema and the row.
        // Missing columns let SQLite use schema DEFAULT values
        // (e.g. key_strategy='failover' for backward-compatible old backups).
        const presentCols = columns.filter((c) => c in rowRecord);
        if (presentCols.length === 0) continue;
        const colList = presentCols.map((c) => `"${c}"`).join(", ");
        const placeholders = presentCols.map(() => "?").join(", ");
        const sql = `INSERT INTO ${table} (${colList}) VALUES (${placeholders})`;
        const values: SqlValue[] = presentCols.map((c) => toSqlValue(rowRecord[c]));
        d.run(sql, values);
      }
    }

    assertNoForeignKeyViolations(d);
    d.exec("COMMIT");
  } catch (err) {
    try {
      d.exec("ROLLBACK");
    } catch {
      // Ignore rollback errors
    }
    throw err;
  } finally {
    try {
      d.exec("PRAGMA foreign_keys = ON");
    } catch {
      // Ignore
    }
  }
}

/**
 * Cloud (Postgres/MySQL) restore path.
 *
 * Uses a driver transaction: TRUNCATE all backup tables (RESTART IDENTITY to
 * reset sequences, CASCADE to honour FK), bulk INSERT rows preserving original
 * ids, then reset sequences past max(id) so subsequent inserts don't collide.
 * Foreign-key integrity is enforced by the DB at COMMIT.
 *
 * MySQL-specific syntax (no RESTART IDENTITY, AUTO_INCREMENT reset) will be
 * wired up in stage 4.
 */
async function importDatabaseCloud(data: BackupData): Promise<void> {
  await drv().transaction(async () => {
    for (const table of BACKUP_TABLES) {
      const truncateSql = drv().dialect === "postgres"
          ? `TRUNCATE TABLE ${table} RESTART IDENTITY CASCADE`
          : `DELETE FROM ${table}`;
        await runSql(truncateSql);
    }
    for (const table of BACKUP_TABLES) {
      const rows = (data.tables as Record<string, unknown>)[table];
      if (!Array.isArray(rows) || rows.length === 0) continue;
      const columns = getTableColumns(table);
      if (columns.length === 0) continue;
      for (const row of rows) {
        if (typeof row !== "object" || row === null) continue;
        const rowRecord = row as Record<string, unknown>;
        const presentCols = columns.filter((c) => c in rowRecord);
        if (presentCols.length === 0) continue;
        const colList = presentCols.map((c) => `"${c}"`).join(", ");
        const placeholders = presentCols.map(() => "?").join(", ");
        const sql = `INSERT INTO ${table} (${colList}) VALUES (${placeholders})`;
        const values: SqlValue[] = presentCols.map((c) => toSqlValue(rowRecord[c]));
        await runSql(sql, values);
      }
    }
    // Reset sequences past max(id) so new inserts don't collide.
    if (drv().dialect === "postgres") {
      for (const table of BACKUP_TABLES) {
        if (!TABLE_COLUMNS[table]?.includes("id")) continue;
        await runSql(
          `SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 0) + 1, false)`,
        );
      }
    }
  });
}
/**
 * Import (restore) a backup, overwriting all existing data.
 *
 * Uses a single transaction with foreign_keys disabled during bulk insert,
 * validates referential integrity before commit, and rolls back on error.
 * After success: rebuilds provider cache, clears circuit-breaker state, saves to disk.
 *
 * SQLite-only in stage 2 (operates on the raw sql.js handle). Cloud drivers
 * will use a transaction-based equivalent in stage 3/4.
 *
 * @throws Error if the backup format is invalid or the restore fails.
 */
export async function importDatabase(data: BackupData): Promise<void> {
  if (!data || typeof data !== "object" || typeof data.tables !== "object" || data.tables === null) {
    throw new Error("Invalid backup format: missing or invalid 'tables' object");
  }

  // Flush pending writes before overwriting
  await flushUsageQueue();

  // Preflight + restore: SQLite uses a shadow-DB preflight + raw sql.js handle;
  // cloud drivers use a transaction-based equivalent.
  if (drv().dialect !== "sqlite") {
    await importDatabaseCloud(data);
  } else {
    await importDatabaseSqlite(data);
  }
  // Post-restore: rebuild caches and persist
  await rebuildProviderCache();
  // Clear circuit-breaker state for all restored providers (fresh start)
  const restoredProviders = data.tables["providers"];
  if (Array.isArray(restoredProviders)) {
    for (const row of restoredProviders) {
      if (row && typeof row === "object" && typeof row.id === "number") {
        clearProviderKeyState(row.id);
      }
    }
  }
  await driver!.sync();
}

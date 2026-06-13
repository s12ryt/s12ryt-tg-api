/**
 * Database layer using sql.js (pure WASM SQLite).
 *
 * Performance optimizations:
 * 1. `runSql()` no longer calls `saveDb()` after every write — relies on 30s auto-save.
 * 2. Provider/model routing cache — avoids full-table scan per API request.
 * 3. API Key LRU cache — avoids 2 DB queries per auth check.
 * 4. Usage write queue — batches inserts, flushes periodically.
 */

import initSqlJs, { type Database as SqlJsDatabase, type SqlValue } from "sql.js";
import path from "path";
import fs from "fs";
import { v7 as uuidv7 } from "uuid";

let db: SqlJsDatabase | null = null;
let dbPath: string = "";

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
 * Async database initialization (required by sql.js).
 */
export async function initDbAsync(databasePath: string): Promise<SqlJsDatabase> {
  dbPath = databasePath;
  const dir = path.dirname(databasePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const SQL = await initSqlJs();

  // Load existing database from file if it exists
  if (fs.existsSync(databasePath)) {
    const fileBuffer = fs.readFileSync(databasePath);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  createTables(db);
  rebuildProviderCache();
  startUsageFlushTimer();

  // Save to disk periodically
  setupAutoSave(db);

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
    const colName = col.split(" ")[0];
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

  // Index for fast lookup
  db.run(`CREATE INDEX IF NOT EXISTS idx_model_restrictions_user ON model_restrictions(user_id, api_key_id)`);

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
      "INSERT INTO settings (key, value) VALUES ('migration_openai_split', '1')"
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
    db.run("INSERT INTO settings (key, value) VALUES ('migration_multi_key', '1')");
    console.log("[db] Migration complete: single api_key → JSON array");
  }

  saveDb();
}

// ---------------------------------------------------------------------------
// Auto-save to disk
// ---------------------------------------------------------------------------

let saveTimer: ReturnType<typeof setInterval> | null = null;
let dirty = false;

function setupAutoSave(db: SqlJsDatabase): void {
  saveTimer = setInterval(() => {
    if (dirty) {
      saveDb();
      dirty = false;
    }
  }, 30_000);
}

export function saveDb(): void {
  if (!db || !dbPath) return;
  try {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbPath, buffer);
  } catch (err) {
    console.error("[db] Failed to save database:", err);
  }
}

export function closeDb(): void {
  // Flush pending usage writes
  flushUsageQueue();
  if (saveTimer) {
    clearInterval(saveTimer);
    saveTimer = null;
  }
  if (usageFlushTimer) {
    clearInterval(usageFlushTimer);
    usageFlushTimer = null;
  }
  if (db) {
    saveDb();
    db.close();
    db = null;
  }
}

// ---------------------------------------------------------------------------
// Helper: run query and return results as array of objects
// ---------------------------------------------------------------------------

function queryAll(sql: string, params: SqlValue[] = []): Record<string, SqlValue>[] {
  const d = getDb();
  const stmt = d.prepare(sql);
  stmt.bind(params);

  const results: Record<string, SqlValue>[] = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

function queryOne(sql: string, params: SqlValue[] = []): Record<string, SqlValue> | undefined {
  const results = queryAll(sql, params);
  return results[0];
}

/**
 * Run a write SQL statement.
 * Marks DB as dirty for the next auto-save cycle — does NOT call saveDb() immediately.
 */
function runSql(sql: string, params: SqlValue[] = []): void {
  const d = getDb();
  try {
    d.run(sql, params);
    dirty = true;
  } catch (err) {
    console.error("[db] SQL error:", sql, params, err);
    throw err;
  }
}

/**
 * Run a write SQL statement AND immediately save to disk.
 * Use only for critical writes (e.g. key generation).
 */
function runSqlAndSave(sql: string, params: SqlValue[] = []): void {
  const d = getDb();
  try {
    d.run(sql, params);
    saveDb();
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
  inputPrice: number | null;
  outputPrice: number | null;
}

/** model_name -> CachedProvider */
let providerCache = new Map<string, CachedProvider>();

/** All cached providers (for /list etc.) */
let allProvidersCache: Provider[] | null = null;

/**
 * Rebuild the model->provider routing cache from DB.
 * Called on init and after any provider add/update/delete.
 */
export function rebuildProviderCache(): void {
  if (!db) return; // Guard: skip if DB not initialized (e.g. during test teardown)
  const newCache = new Map<string, CachedProvider>();
  const providers = queryAll("SELECT * FROM providers WHERE enabled = 1 ORDER BY id");

  for (const p of providers) {
    const pid = Number(p.id);
    const models = String(p.models || "")
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean);

    for (const modelName of models) {
      // Try model-specific pricing first
      const mp = queryOne(
        "SELECT input_price, output_price FROM model_prices WHERE provider_id = ? AND model = ?",
        [pid, modelName]
      );
      const inputPrice = mp ? (mp.input_price as number | null) : (p.input_price as number | null);
      const outputPrice = mp ? (mp.output_price as number | null) : (p.output_price as number | null);

      newCache.set(modelName, {
        providerType: String(p.api_type),
        providerId: pid,
        providerName: String(p.name),
        baseUrl: String(p.base_url),
        apiKey: String(p.api_key),
        inputPrice,
        outputPrice,
      });
    }
  }

  providerCache = newCache;
  allProvidersCache = null; // invalidate
  console.log(`[cache] Provider routing cache rebuilt: ${providerCache.size} model entries`);
  notifyProviderCacheRebuild();
}

/**
 * Fast model lookup for API routing — uses in-memory cache, zero DB queries.
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

/**
 * Invalidate provider caches — call after any provider/model/price mutation.
 */
function invalidateProviderCache(): void {
  allProvidersCache = null;
  // Defer full rebuild to next tick to batch multiple mutations
  if (!rebuildCachePending) {
    rebuildCachePending = true;
    process.nextTick(() => {
      rebuildProviderCache();
      rebuildCachePending = false;
    });
  }
}
let rebuildCachePending = false;

/** Register a callback to be called whenever provider cache is rebuilt. */
const providerCacheListeners: Array<() => void> = [];

export function onProviderCacheRebuild(fn: () => void): void {
  providerCacheListeners.push(fn);
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
 * Returns null if key not found or inactive.
 */
export function lookupApiKeyCached(key: string): CachedApiKey | null {
  // Check cache first
  const cached = apiKeyCache.get(key);
  if (cached) {
    // Move to end (LRU)
    apiKeyCache.delete(key);
    apiKeyCache.set(key, cached);
    if (cached.is_active && cached.user_is_active) return cached;
    return null;
  }

  // Cache miss — query DB
  const apiKeyRow = queryOne("SELECT * FROM api_keys WHERE key = ?", [key]);
  if (!apiKeyRow || Number(apiKeyRow.is_active) !== 1) return null;

  const user = queryOne("SELECT * FROM users WHERE id = ?", [apiKeyRow.user_id]);
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
const USAGE_FLUSH_INTERVAL_MS = 5_000; // flush every 5 seconds
const USAGE_MAX_QUEUE_SIZE = 100; // force flush if queue gets too large

function startUsageFlushTimer(): void {
  usageFlushTimer = setInterval(() => {
    flushUsageQueue();
  }, USAGE_FLUSH_INTERVAL_MS);
}

/**
 * Flush all pending usage records to DB in a single batch.
 */
export function flushUsageQueue(): void {
  if (usageQueue.length === 0) return;

  // Drain the queue
  const batch = usageQueue.splice(0, usageQueue.length);
  if (batch.length === 0) return;

  const d = getDb();
  try {
    // Use a single transaction for the entire batch
    d.run("BEGIN TRANSACTION");
    const stmt = d.prepare(
      `INSERT INTO usage (api_key_id, provider_id, input_tokens, output_tokens, input_cost, output_cost, model)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const u of batch) {
      stmt.bind([u.api_key_id, u.provider_id, u.input_tokens, u.output_tokens, u.input_cost, u.output_cost, u.model]);
      stmt.step();
      stmt.reset();
    }
    stmt.free();
    d.run("COMMIT");
    dirty = true;
    console.log(`[usage-queue] Flushed ${batch.length} records to DB`);
  } catch (err) {
    console.error("[usage-queue] Batch insert failed:", err);
    try { d.run("ROLLBACK"); } catch { /* ignore */ }
    // Put records back at the front of the queue
    usageQueue.unshift(...batch);
  }
}

/**
 * Queue a usage record for batched writing.
 * Returns immediately — no DB I/O.
 */
export function enqueueUsage(record: PendingUsage): void {
  usageQueue.push(record);
  // Force flush if queue is too large
  if (usageQueue.length >= USAGE_MAX_QUEUE_SIZE) {
    flushUsageQueue();
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
  models: string;
  enabled: number;
  input_price: number | null;
  output_price: number | null;
  created_at: string;
  updated_at: string;
}

export function addProvider(
  provider: Omit<Provider, "id" | "enabled" | "created_at" | "updated_at">
): void {
  console.log(`[db] addProvider: name=${provider.name}, type=${provider.api_type}, models=${provider.models}`);
  runSql(
    `INSERT INTO providers (name, api_type, base_url, api_key, models, input_price, output_price)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      provider.name,
      provider.api_type,
      provider.base_url,
      provider.api_key,
      provider.models,
      provider.input_price ?? null,
      provider.output_price ?? null,
    ] as SqlValue[]
  );
  invalidateProviderCache();
}

export function getProviders(enabledOnly = false): Provider[] {
  // Try cache for enabled-only queries
  if (enabledOnly) {
    if (!allProvidersCache) {
      allProvidersCache = queryAll("SELECT * FROM providers WHERE enabled = 1 ORDER BY id") as unknown as Provider[];
    }
    return allProvidersCache;
  }
  const sql = "SELECT * FROM providers ORDER BY id";
  return queryAll(sql) as unknown as Provider[];
}

export function getProviderById(id: number): Provider | undefined {
  return queryOne("SELECT * FROM providers WHERE id = ?", [id]) as unknown as Provider | undefined;
}

export function updateProvider(
  id: number,
  data: Partial<Omit<Provider, "id" | "created_at">>
): void {
  const fields: string[] = [];
  const values: SqlValue[] = [];

  for (const [key, value] of Object.entries(data)) {
    fields.push(`${key} = ?`);
    values.push(value as SqlValue);
  }

  if (fields.length === 0) {
    throw new Error("No fields to update");
  }

  fields.push("updated_at = datetime('now')");
  values.push(id);

  runSql(`UPDATE providers SET ${fields.join(", ")} WHERE id = ?`, values);
  invalidateProviderCache();
}

export function deleteProvider(ids: number[]): void {
  const placeholders = ids.map(() => "?").join(",");
  runSql(`DELETE FROM providers WHERE id IN (${placeholders})`, ids);
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

export function addUser(tgUserId: number, username: string | null = null): void {
  runSql(
    "INSERT INTO users (tg_user_id, username) VALUES (?, ?)",
    [tgUserId, username]
  );
}

export function getUsers(excludeAdminId?: number): User[] {
  if (excludeAdminId !== undefined) {
    return queryAll("SELECT * FROM users WHERE tg_user_id != ? ORDER BY id", [excludeAdminId]) as unknown as User[];
  }
  return queryAll("SELECT * FROM users ORDER BY id") as unknown as User[];
}

export function getUserByTgId(tgUserId: number): User | undefined {
  return queryOne("SELECT * FROM users WHERE tg_user_id = ?", [tgUserId]) as unknown as User | undefined;
}

export function getUserById(id: number): User | undefined {
  return queryOne("SELECT * FROM users WHERE id = ?", [id]) as unknown as User | undefined;
}

export function updateUserStatus(id: number, isActive: number): void {
  runSql("UPDATE users SET is_active = ? WHERE id = ?", [isActive, id]);
  invalidateUserApiKeyCache(0); // clear all key caches on user status change
}

export function deleteUser(id: number): void {
  runSql("DELETE FROM users WHERE id = ?", [id]);
  apiKeyCache.clear();
}

export function updateUserTgId(oldTgUserId: number, newTgUserId: number): void {
  runSql("UPDATE users SET tg_user_id = ? WHERE tg_user_id = ?", [newTgUserId, oldTgUserId]);
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

export function addApiKey(tgUserId: number): { key: string } {
  const user = getUserByTgId(tgUserId);
  if (!user) {
    throw new Error(`User with tg_user_id ${tgUserId} not found`);
  }

  const key = `sk-s12ryt-${uuidv7()}`;
  runSqlAndSave("INSERT INTO api_keys (user_id, key) VALUES (?, ?)", [user.id, key]);
  return { key };
}

export function getKeysByUser(tgUserId: number): ApiKey[] {
  return queryAll(
    `SELECT ak.* FROM api_keys ak
     JOIN users u ON ak.user_id = u.id
     WHERE u.tg_user_id = ?
     ORDER BY ak.id`,
    [tgUserId]
  ) as unknown as ApiKey[];
}

export function getKeyByValue(key: string): ApiKey | undefined {
  return queryOne("SELECT * FROM api_keys WHERE key = ?", [key]) as unknown as ApiKey | undefined;
}

export function deleteApiKey(id: number): void {
  runSqlAndSave("DELETE FROM api_keys WHERE id = ?", [id]);
  apiKeyCache.clear();
}

export function getAllKeys(): (ApiKey & { tg_user_id: number; username: string | null })[] {
  return queryAll(
    `SELECT ak.*, u.tg_user_id, u.username
     FROM api_keys ak
     JOIN users u ON ak.user_id = u.id
     ORDER BY ak.id`
  ) as unknown as (ApiKey & { tg_user_id: number; username: string | null })[];
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
 * This is non-blocking and returns immediately.
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

export function getUsageByUser(tgUserId: number): UsageWithDetails[] {
  return queryAll(
    `SELECT u.*, p.name as provider_name, ak.key as api_key
     FROM usage u
     JOIN api_keys ak ON u.api_key_id = ak.id
     JOIN users us ON ak.user_id = us.id
     JOIN providers p ON u.provider_id = p.id
     WHERE us.tg_user_id = ?
     ORDER BY u.created_at DESC`,
    [tgUserId]
  ) as unknown as UsageWithDetails[];
}

export function getUsageByProvider(providerId: number): UsageWithDetails[] {
  return queryAll(
    `SELECT u.*, p.name as provider_name, ak.key as api_key
     FROM usage u
     JOIN api_keys ak ON u.api_key_id = ak.id
     JOIN providers p ON u.provider_id = p.id
     WHERE u.provider_id = ?
     ORDER BY u.created_at DESC`,
    [providerId]
  ) as unknown as UsageWithDetails[];
}

export interface TotalUsage {
  total_input_tokens: number;
  total_output_tokens: number;
  total_input_cost: number;
  total_output_cost: number;
  total_cost: number;
  record_count: number;
}

export function getTotalUsage(): TotalUsage {
  const row = queryOne(
    `SELECT
       COALESCE(SUM(input_tokens), 0) as total_input_tokens,
       COALESCE(SUM(output_tokens), 0) as total_output_tokens,
       COALESCE(SUM(input_cost), 0) as total_input_cost,
       COALESCE(SUM(output_cost), 0) as total_output_cost,
       COUNT(*) as record_count
     FROM usage`
  );

  if (!row) {
    return {
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_input_cost: 0,
      total_output_cost: 0,
      total_cost: 0,
      record_count: 0,
    };
  }

  return {
    total_input_tokens: Number(row.total_input_tokens),
    total_output_tokens: Number(row.total_output_tokens),
    total_input_cost: Number(row.total_input_cost),
    total_output_cost: Number(row.total_output_cost),
    total_cost: Number(row.total_input_cost) + Number(row.total_output_cost),
    record_count: Number(row.record_count),
  };
}

// ========================
// Settings CRUD
// ========================

export function getSetting(key: string): string | null {
  const row = queryOne("SELECT value FROM settings WHERE key = ?", [key]);
  return (row?.value as string) ?? null;
}

export function setSetting(key: string, value: string): void {
  runSql(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?",
    [key, value, value]
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
export function getModelPrice(providerId: number, modelName: string): ModelPrice | undefined {
  return queryOne(
    "SELECT * FROM model_prices WHERE provider_id = ? AND model = ?",
    [providerId, modelName]
  ) as unknown as ModelPrice | undefined;
}

/**
 * Get all model prices for a provider.
 */
export function getModelPricesByProvider(providerId: number): ModelPrice[] {
  return queryAll(
    "SELECT * FROM model_prices WHERE provider_id = ? ORDER BY model",
    [providerId]
  ) as unknown as ModelPrice[];
}

/**
 * Upsert a model price record. If a record for (provider_id, model) exists, update it.
 * Prices are in USD per 1M tokens.
 */
export function upsertModelPrice(
  providerId: number,
  modelName: string,
  inputPrice: number | null,
  outputPrice: number | null
): void {
  runSql(
    `INSERT INTO model_prices (provider_id, model, input_price, output_price)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(provider_id, model) DO UPDATE SET
       input_price = excluded.input_price,
       output_price = excluded.output_price,
       updated_at = datetime('now')`,
    [providerId, modelName, inputPrice, outputPrice]
  );
  invalidateProviderCache();
}

/**
 * Batch upsert model prices using a single transaction.
 * Each entry: { model, input_price, output_price }
 * Prices are in USD per 1M tokens.
 */
export function batchUpsertModelPrices(
  providerId: number,
  entries: Array<{ model: string; input_price: number | null; output_price: number | null }>
): void {
  if (entries.length === 0) return;

  const d = getDb();
  try {
    d.run("BEGIN TRANSACTION");
    const stmt = d.prepare(
      `INSERT INTO model_prices (provider_id, model, input_price, output_price)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(provider_id, model) DO UPDATE SET
         input_price = excluded.input_price,
         output_price = excluded.output_price,
         updated_at = datetime('now')`
    );
    for (const entry of entries) {
      stmt.bind([providerId, entry.model, entry.input_price ?? null, entry.output_price ?? null]);
      stmt.step();
      stmt.reset();
    }
    stmt.free();
    d.run("COMMIT");
    dirty = true;
  } catch (err) {
    console.error("[db] batchUpsertModelPrices error:", err);
    try { d.run("ROLLBACK"); } catch { /* ignore */ }
    throw err;
  }
  invalidateProviderCache();
}

/**
 * Delete model prices for models that are no longer in the provider's model list.
 */
export function cleanupModelPrices(providerId: number, currentModels: string[]): void {
  if (currentModels.length === 0) {
    runSql("DELETE FROM model_prices WHERE provider_id = ?", [providerId]);
    return;
  }
  const placeholders = currentModels.map(() => "?").join(",");
  runSql(
    `DELETE FROM model_prices WHERE provider_id = ? AND model NOT IN (${placeholders})`,
    [providerId, ...currentModels]
  );
  invalidateProviderCache();
}

/**
 * Delete all model prices for a provider.
 */
export function deleteModelPricesByProvider(providerId: number): void {
  runSql("DELETE FROM model_prices WHERE provider_id = ?", [providerId]);
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

/**
 * Get coding config for a user by internal user_id.
 */
export function getCodingConfig(userId: number): CodingConfig | null {
  const row = queryOne("SELECT * FROM coding_configs WHERE user_id = ?", [userId]) as Record<string, unknown> | undefined;
  if (!row) return null;
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
 * Get coding config by Telegram user ID.
 */
export function getCodingConfigByTgId(tgUserId: number): CodingConfig | null {
  const user = getUserByTgId(tgUserId);
  if (!user) return null;
  return getCodingConfig(user.id);
}

/**
 * Set (upsert) coding config for a user.
 */
export function setCodingConfig(
  userId: number,
  opts: { isActive?: number; fallbackModels?: string; maxRetries?: number }
): CodingConfig | null {
  const existing = queryOne("SELECT id FROM coding_configs WHERE user_id = ?", [userId]);

  if (existing) {
    const sets: string[] = [];
    const params: SqlValue[] = [];
    if (opts.isActive !== undefined) { sets.push("is_active = ?"); params.push(opts.isActive); }
    if (opts.fallbackModels !== undefined) { sets.push("fallback_models = ?"); params.push(opts.fallbackModels); }
    if (opts.maxRetries !== undefined) { sets.push("max_retries = ?"); params.push(opts.maxRetries); }
    if (sets.length > 0) {
      sets.push("updated_at = datetime('now')");
      params.push(userId);
      runSql(`UPDATE coding_configs SET ${sets.join(", ")} WHERE user_id = ?`, params);
    }
  } else {
    runSql(
      `INSERT INTO coding_configs (user_id, is_active, fallback_models, max_retries)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         is_active = excluded.is_active,
         fallback_models = excluded.fallback_models,
         max_retries = excluded.max_retries,
         updated_at = datetime('now')`,
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
export function getActiveCodingForApiKey(apiKeyId: number): CodingConfig | null {
  const row = queryOne(
    `SELECT cc.* FROM coding_configs cc
     JOIN api_keys ak ON ak.user_id = cc.user_id
     WHERE ak.id = ? AND cc.is_active = 1`,
    [apiKeyId]
  ) as Record<string, unknown> | undefined;
  if (!row) return null;
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
 * Increment coding mode session stats after a successful coding-mode request.
 */
export function incrementCodingSessionStats(
  userId: number,
  inputTokens: number,
  outputTokens: number,
  inputCost: number,
  outputCost: number,
  actualModel: string,
): void {
  // Read current model counts, update, write back
  const row = queryOne(`SELECT session_model_counts FROM coding_configs WHERE user_id = ?`, [userId]);
  let counts: Record<string, number> = {};
  try {
    counts = row?.session_model_counts ? JSON.parse(row.session_model_counts as string) : {};
  } catch { counts = {}; }
  counts[actualModel] = (counts[actualModel] || 0) + 1;

  runSql(
    `UPDATE coding_configs SET
       session_input_tokens = session_input_tokens + ?,
       session_output_tokens = session_output_tokens + ?,
       session_input_cost = session_input_cost + ?,
       session_output_cost = session_output_cost + ?,
       session_requests = session_requests + 1,
       session_model_counts = ?,
       updated_at = datetime('now')
     WHERE user_id = ?`,
    [inputTokens, outputTokens, inputCost, outputCost, JSON.stringify(counts), userId]
  );
}

/**
 * Reset coding mode session stats to zero (called when coding mode is activated).
 */
export function resetCodingSessionStats(userId: number): void {
  runSql(
    `UPDATE coding_configs SET
       session_input_tokens = 0,
       session_output_tokens = 0,
       session_input_cost = 0.0,
       session_output_cost = 0.0,
       session_requests = 0,
       session_model_counts = '{}',
       updated_at = datetime('now')
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
  models: string;       // comma-separated
  created_at: string;
  updated_at: string;
}

/**
 * Get model restriction for a specific user or API key.
 * api_key_id = null → user-level; api_key_id = number → key-level.
 */
export function getModelRestriction(
  userId: number,
  apiKeyId: number | null,
): ModelRestriction | null {
  if (apiKeyId !== null) {
    return queryOne(
      "SELECT * FROM model_restrictions WHERE user_id = ? AND api_key_id = ?",
      [userId, apiKeyId],
    ) as unknown as ModelRestriction | null;
  }
  return queryOne(
    "SELECT * FROM model_restrictions WHERE user_id = ? AND api_key_id IS NULL",
    [userId],
  ) as unknown as ModelRestriction | null;
}

/**
 * Get ALL restrictions for a user (both user-level and key-level).
 */
export function getModelRestrictionsForUser(
  userId: number,
): ModelRestriction[] {
  return queryAll(
    "SELECT * FROM model_restrictions WHERE user_id = ? ORDER BY api_key_id IS NULL DESC, api_key_id ASC",
    [userId],
  ) as unknown as ModelRestriction[];
}

/**
 * Set (upsert) model restriction.
 * mode: 'whitelist' = only these models allowed; 'blacklist' = these models blocked.
 */
export function setModelRestriction(
  userId: number,
  apiKeyId: number | null,
  mode: "whitelist" | "blacklist",
  models: string,
): void {
  const modelsStr = models
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean)
    .join(",");

  const existing = getModelRestriction(userId, apiKeyId);
  if (existing) {
    runSql(
      `UPDATE model_restrictions SET mode = ?, models = ?, updated_at = datetime('now') WHERE id = ?`,
      [mode, modelsStr, existing.id],
    );
  } else {
    runSql(
      `INSERT INTO model_restrictions (user_id, api_key_id, mode, models) VALUES (?, ?, ?, ?)`,
      [userId, apiKeyId, mode, modelsStr],
    );
  }
}

/**
 * Delete a model restriction.
 */
export function deleteModelRestriction(
  userId: number,
  apiKeyId: number | null,
): boolean {
  const existing = getModelRestriction(userId, apiKeyId);
  if (!existing) return false;
  runSql("DELETE FROM model_restrictions WHERE id = ?", [existing.id]);
  return true;
}

/**
 * Check if a specific model is allowed for the given user/apiKey.
 * Returns true if allowed, false if denied.
 *
 * Logic:
 * 1. If apiKeyId is provided, check key-level restriction first.
 *    - If key-level exists → apply it (ignore user-level).
 * 2. If no key-level, check user-level restriction.
 *    - If user-level exists → apply it.
 * 3. If no restriction at all → default deny (return false) for non-admin.
 *
 * For admin users (tgUserId matches ADMIN_ID), skip user-level restrictions
 * but still apply key-level if set.
 */
export function checkModelAllowed(
  userId: number,
  apiKeyId: number | null,
  modelName: string,
  isAdmin: boolean,
): boolean {
  // 1. Try key-level restriction (always applies, even for admin)
  if (apiKeyId !== null) {
    const keyRestriction = getModelRestriction(userId, apiKeyId);
    if (keyRestriction) {
      return applyRestriction(keyRestriction, modelName);
    }
  }

  // 2. Admin bypasses user-level restrictions
  if (isAdmin) return true;

  // 3. Check user-level restriction
  const userRestriction = getModelRestriction(userId, null);
  if (userRestriction) {
    return applyRestriction(userRestriction, modelName);
  }

  // 4. No restriction found → default deny for non-admin
  return false;
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
export function getAllowedModels(
  userId: number,
  apiKeyId: number | null,
  allModels: string[],
  isAdmin: boolean,
): string[] {
  // 1. Try key-level restriction
  if (apiKeyId !== null) {
    const keyRestriction = getModelRestriction(userId, apiKeyId);
    if (keyRestriction) {
      return filterModelsByRestriction(keyRestriction, allModels);
    }
  }

  // 2. Admin bypasses user-level
  if (isAdmin) return allModels;

  // 3. User-level restriction
  const userRestriction = getModelRestriction(userId, null);
  if (userRestriction) {
    return filterModelsByRestriction(userRestriction, allModels);
  }

  // 4. No restriction → deny all for non-admin
  return [];
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

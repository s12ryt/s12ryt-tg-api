/**
 * Unit tests for src/db/database.ts
 *
 * Strategy:
 * - Each test suite uses its own temporary database file via await initDbAsync().
 * - beforeEach creates a fresh DB; afterEach closes it.
 * - await saveDb() is spied on to suppress filesystem writes during tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import os from "os";
import fs from "fs";

// We must import * to access module-level state and override it
import {
  initDbAsync,
  closeDb,
  getDb,
  saveDb,
  // Provider CRUD
  addProvider,
  getProviders,
  getProviderById,
  updateProvider,
  deleteProvider,
  batchUpsertModelPrices,
  getModelPricesByProvider,
  getModelMappings,
  upsertModelMapping,
  replaceModelMappings,
  // User CRUD
  addUser,
  getUsers,
  getUserByTgId,
  getUserById,
  updateUserStatus,
  deleteUser,
  updateUserTgId,
  // API Key CRUD
  addApiKey,
  getKeysByUser,
  getKeyByValue,
  deleteApiKey,
  getAllKeys,
  // Usage CRUD
  recordUsage,
  flushUsageQueue,
  getUsageByUser,
  getUsageByProvider,
  getTotalUsage,
  // Settings CRUD
  getSetting,
  setSetting,
  // Permission system — User Groups
  getUserGroups,
  getUserGroupById,
  getUserGroupByName,
  getDefaultUserGroup,
  addUserGroup,
  updateUserGroup,
  deleteUserGroup,
  // Permission system — User & API Key limits
  getUserWithLimits,
  setUserGroup,
  setUserOverrides,
  getApiKeyWithLimits,
  setApiKeyOverrides,
  // Permission system — Effective limits & quotas
  getEffectiveLimits,
  getDailyUsage,
  getMonthlyUsage,
  isExpired,
  // Backup / Restore
  exportDatabase,
  importDatabase,
  getBackupSummary,
  // Types
  type Provider,
  type User,
  type ApiKey,
  type UsageRecord,
  type TotalUsage,
  type BackupData,
} from "../src/db/database.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let dbFile: string;

/** Create a fresh temporary database path for each test */
function makeTempDbPath(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "s12ryt-test-"));
  dbFile = path.join(tmpDir, "test.db");
  return dbFile;
}

/** Clean up temp directory */
function cleanupTempDir(): void {
  try {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  } catch {
    // ignore cleanup errors
  }
}

// Suppress console.log / console.error noise during tests
beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
});

// ===========================================================================
// Provider Tests
// ===========================================================================
describe("Provider CRUD", async () => {
  beforeEach(async () => {
    await initDbAsync(makeTempDbPath());
  });

  afterEach(async () => {
    await closeDb();
    cleanupTempDir();
  });

  it("should add a provider and retrieve it", async () => {
    await addProvider({
      name: "OpenAI",
      api_type: "openai_chat",
      base_url: "https://api.openai.com/v1",
      api_key: "sk-test-key",
      user_agent: "s12ryt-test/1.0",
      models: "gpt-4o,gpt-4o-mini",
      input_price: 0.005,
      output_price: 0.015,
    });

    const providers = await getProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0].name).toBe("OpenAI");
    expect(providers[0].api_type).toBe("openai_chat");
    expect(providers[0].base_url).toBe("https://api.openai.com/v1");
    expect(providers[0].api_key).toBe("sk-test-key");
    expect(providers[0].user_agent).toBe("s12ryt-test/1.0");
    expect(providers[0].models).toBe("gpt-4o,gpt-4o-mini");
    expect(providers[0].enabled).toBe(1);
    expect(providers[0].input_price).toBe(0.005);
    expect(providers[0].output_price).toBe(0.015);
  });

  it("should reject duplicate provider name", async () => {
    await addProvider({
      name: "OpenAI",
      api_type: "openai_chat",
      base_url: "https://api.openai.com/v1",
      api_key: "sk-key1",
      models: "gpt-4o",
      input_price: null,
      output_price: null,
    });

    await expect(addProvider({
        name: "OpenAI",
        api_type: "openai_chat",
        base_url: "https://api.openai.com/v2",
        api_key: "sk-key2",
        models: "gpt-4o",
        input_price: null,
        output_price: null,
      })
    ).rejects.toThrow();
  });

  it("should get provider by id", async () => {
    await addProvider({
      name: "Anthropic",
      api_type: "anthropic",
      base_url: "https://api.anthropic.com",
      api_key: "sk-ant-key",
      models: "claude-3-5-sonnet",
      input_price: 0.003,
      output_price: 0.015,
    });

    const provider = await getProviderById(1);
    expect(provider).toBeDefined();
    expect(provider!.name).toBe("Anthropic");
    expect(provider!.api_type).toBe("anthropic");
  });

  it("should return undefined for non-existent provider id", async () => {
    const provider = await getProviderById(999);
    expect(provider).toBeUndefined();
  });

  it("should update a provider", async () => {
    await addProvider({
      name: "Google",
      api_type: "google",
      base_url: "https://generativelanguage.googleapis.com",
      api_key: "google-key",
      models: "gemini-pro",
      input_price: null,
      output_price: null,
    });

    await updateProvider(1, { name: "Google AI", enabled: 0, models: "gemini-pro,gemini-ultra" });

    const updated = await getProviderById(1);
    expect(updated).toBeDefined();
    expect(updated!.name).toBe("Google AI");
    expect(updated!.enabled).toBe(0);
    expect(updated!.models).toBe("gemini-pro,gemini-ultra");
  });

  it("should throw when updating with no fields", async () => {
    await addProvider({
      name: "OpenAI",
      api_type: "openai_chat",
      base_url: "https://api.openai.com/v1",
      api_key: "sk-key",
      models: "gpt-4o",
      input_price: null,
      output_price: null,
    });

    await expect(updateProvider(1, {})).rejects.toThrow("No fields to update");
  });

  it("should delete a provider by id", async () => {
    await addProvider({
      name: "OpenAI",
      api_type: "openai_chat",
      base_url: "https://api.openai.com/v1",
      api_key: "sk-key",
      models: "gpt-4o",
      input_price: null,
      output_price: null,
    });
    await addProvider({
      name: "Anthropic",
      api_type: "anthropic",
      base_url: "https://api.anthropic.com",
      api_key: "sk-ant",
      models: "claude-3",
      input_price: null,
      output_price: null,
    });

    await deleteProvider([1]);

    const remaining = await getProviders();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].name).toBe("Anthropic");
  });

  it("should enable foreign key enforcement after initialization", async () => {
    const result = getDb().exec("PRAGMA foreign_keys");
    expect(result[0].values[0][0]).toBe(1);
  });

  it("should delete model prices when deleting a provider", async () => {
    await addProvider({
      name: "OpenAI",
      api_type: "openai_chat",
      base_url: "https://api.openai.com/v1",
      api_key: "sk-key",
      models: "gpt-4o",
      input_price: null,
      output_price: null,
    });
    await batchUpsertModelPrices(1, [
      { model: "gpt-4o", input_price: 1.25, output_price: 5 },
    ]);

    expect(await getModelPricesByProvider(1)).toHaveLength(1);

    getDb().run("PRAGMA foreign_keys = OFF");
    try {
      await deleteProvider([1]);
    } finally {
      getDb().run("PRAGMA foreign_keys = ON");
    }

    expect(await getProviders()).toHaveLength(0);
    expect(await getModelPricesByProvider(1)).toHaveLength(0);
  });

  it("should delete model mappings when deleting a provider", async () => {
    await addProvider({
      name: "OpenAI",
      api_type: "openai_chat",
      base_url: "https://api.openai.com/v1",
      api_key: "sk-key",
      models: "gpt-4o",
      input_price: null,
      output_price: null,
    });
    await upsertModelMapping(1, "gpt-4o", "public-gpt");

    expect(await getModelMappings()).toHaveLength(1);

    await deleteProvider([1]);

    expect(await getProviders()).toHaveLength(0);
    expect(await getModelMappings()).toHaveLength(0);
    expect((await exportDatabase()).tables.model_mappings).toHaveLength(0);
  });

  it("should reject model mappings for missing providers", async () => {
    await expect(upsertModelMapping(999, "ghost-model", "public-ghost")).rejects.toThrow("Provider not found");
    expect(await getModelMappings()).toHaveLength(0);
  });

  it("should reject invalid batch model mappings without clearing existing mappings", async () => {
    await addProvider({
      name: "OpenAI",
      api_type: "openai_chat",
      base_url: "https://api.openai.com/v1",
      api_key: "sk-key",
      models: "gpt-4o",
      input_price: null,
      output_price: null,
    });
    await upsertModelMapping(1, "gpt-4o", "public-gpt");

    await expect(replaceModelMappings([
      { provider_id: 999, original_model: "ghost-model", display_name: "public-ghost" },
    ])).rejects.toThrow("Provider not found for model mapping: 999");

    expect(await getModelMappings()).toEqual([
      {
        provider_id: 1,
        provider_name: "OpenAI",
        original_model: "gpt-4o",
        display_name: "public-gpt",
      },
    ]);
  });

  it("should clean orphan model mappings during initialization", async () => {
    getDb().run(
      "INSERT INTO model_mappings (provider_id, original_model, display_name) VALUES (?, ?, ?)",
      [999, "ghost-model", "public-ghost"]
    );
    await saveDb();

    await closeDb();
    await initDbAsync(dbFile);

    expect((await exportDatabase()).tables.model_mappings).toHaveLength(0);
  });

  it("should delete multiple providers", async () => {
    await addProvider({ name: "P1", api_type: "openai_chat", base_url: "https://p1", api_key: "k1", models: "", input_price: null, output_price: null });
    await addProvider({ name: "P2", api_type: "openai_chat", base_url: "https://p2", api_key: "k2", models: "", input_price: null, output_price: null });
    await addProvider({ name: "P3", api_type: "openai_chat", base_url: "https://p3", api_key: "k3", models: "", input_price: null, output_price: null });

    await deleteProvider([1, 3]);

    const remaining = await getProviders();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].name).toBe("P2");
  });

  it("should filter providers by enabled status", async () => {
    await addProvider({ name: "Enabled1", api_type: "openai_chat", base_url: "https://e1", api_key: "k1", models: "", input_price: null, output_price: null });
    await addProvider({ name: "Disabled1", api_type: "openai_chat", base_url: "https://d1", api_key: "k2", models: "", input_price: null, output_price: null });

    await updateProvider(2, { enabled: 0 });

    const all = await getProviders(false);
    const enabled = await getProviders(true);

    expect(all).toHaveLength(2);
    expect(enabled).toHaveLength(1);
    expect(enabled[0].name).toBe("Enabled1");
  });

  it("should allow null prices for provider", async () => {
    await addProvider({
      name: "FreeProvider",
      api_type: "google",
      base_url: "https://free",
      api_key: "free-key",
      models: "free-model",
      input_price: null,
      output_price: null,
    });

    const provider = await getProviderById(1);
    expect(provider!.input_price).toBeNull();
    expect(provider!.output_price).toBeNull();
  });
});

// ===========================================================================
// User Tests
// ===========================================================================
describe("User CRUD", async () => {
  beforeEach(async () => {
    await initDbAsync(makeTempDbPath());
  });

  afterEach(async () => {
    await closeDb();
    cleanupTempDir();
  });

  it("should add a user and retrieve by tg_user_id", async () => {
    await addUser(12345678, "testuser");

    const user = await getUserByTgId(12345678);
    expect(user).toBeDefined();
    expect(user!.tg_user_id).toBe(12345678);
    expect(user!.username).toBe("testuser");
    expect(user!.is_active).toBe(1);
  });

  it("should add user with null username", async () => {
    await addUser(99999);

    const user = await getUserByTgId(99999);
    expect(user).toBeDefined();
    expect(user!.username).toBeNull();
  });

  it("should reject duplicate tg_user_id", async () => {
    await addUser(11111, "user1");

    await expect(addUser(11111, "user2")).rejects.toThrow();
  });

  it("should get user by id", async () => {
    await addUser(22222, "byIdUser");

    const user = await getUserById(1);
    expect(user).toBeDefined();
    expect(user!.username).toBe("byIdUser");
  });

  it("should return undefined for non-existent user id", async () => {
    const user = await getUserById(999);
    expect(user).toBeUndefined();
  });

  it("should return undefined for non-existent tg_user_id", async () => {
    const user = await getUserByTgId(999999);
    expect(user).toBeUndefined();
  });

  it("should get all users", async () => {
    await addUser(100, "userA");
    await addUser(200, "userB");
    await addUser(300, "userC");

    const users = await getUsers();
    expect(users).toHaveLength(3);
    expect(users[0].tg_user_id).toBe(100);
    expect(users[2].tg_user_id).toBe(300);
  });

  it("should get users excluding admin id", async () => {
    await addUser(1000, "admin");
    await addUser(2000, "user1");
    await addUser(3000, "user2");

    const users = await getUsers(1000);
    expect(users).toHaveLength(2);
    expect(users.every((u) => u.tg_user_id !== 1000)).toBe(true);
  });

  it("should update user status", async () => {
    await addUser(55555, "statusUser");

    await updateUserStatus(1, 0);

    const user = await getUserByTgId(55555);
    expect(user!.is_active).toBe(0);
  });

  it("should delete a user", async () => {
    await addUser(77777, "deleteMe");
    await addUser(88888, "keepMe");

    await deleteUser(1);

    const users = await getUsers();
    expect(users).toHaveLength(1);
    expect(users[0].tg_user_id).toBe(88888);
  });

  it("should update user tg_user_id", async () => {
    await addUser(10000, "migrateMe");

    await updateUserTgId(10000, 20000);

    const oldUser = await getUserByTgId(10000);
    expect(oldUser).toBeUndefined();

    const newUser = await getUserByTgId(20000);
    expect(newUser).toBeDefined();
    expect(newUser!.username).toBe("migrateMe");
  });
});

// ===========================================================================
// API Key Tests
// ===========================================================================
describe("API Key CRUD", async () => {
  beforeEach(async () => {
    await initDbAsync(makeTempDbPath());
    // Add a user that most tests depend on
    await addUser(12345, "keyuser");
  });

  afterEach(async () => {
    await closeDb();
    cleanupTempDir();
  });

  it("should add an API key for existing user", async () => {
    const result = await addApiKey(12345);

    expect(result.key).toMatch(/^sk-s12ryt-/);

    const keys = await getKeysByUser(12345);
    expect(keys).toHaveLength(1);
    expect(keys[0].key).toBe(result.key);
    expect(keys[0].is_active).toBe(1);
  });

  it("should throw when adding key for non-existent user", async () => {
    await expect(addApiKey(99999)).rejects.toThrow("User with tg_user_id 99999 not found");
  });

  it("should get key by value", async () => {
    const { key } = await addApiKey(12345);

    const found = await getKeyByValue(key);
    expect(found).toBeDefined();
    expect(found!.key).toBe(key);
  });

  it("should return undefined for non-existent key value", async () => {
    const found = await getKeyByValue("sk-s12ryt-nonexistent");
    expect(found).toBeUndefined();
  });

  it("should delete an API key", async () => {
    await addApiKey(12345);

    const keys = await getKeysByUser(12345);
    expect(keys).toHaveLength(1);

    await deleteApiKey(keys[0].id);

    const keysAfterDelete = await getKeysByUser(12345);
    expect(keysAfterDelete).toHaveLength(0);
  });

  it("should get all keys with user info", async () => {
    await addUser(67890, "anotheruser");
    await addApiKey(12345);
    await addApiKey(67890);

    const allKeys = await getAllKeys();
    expect(allKeys).toHaveLength(2);

    // First key belongs to keyuser (tg 12345)
    expect(allKeys[0].tg_user_id).toBe(12345);
    expect(allKeys[0].username).toBe("keyuser");

    // Second key belongs to anotheruser (tg 67890)
    expect(allKeys[1].tg_user_id).toBe(67890);
    expect(allKeys[1].username).toBe("anotheruser");
  });

  it("should generate unique keys", async () => {
    const key1 = await addApiKey(12345);
    const key2 = await addApiKey(12345);

    expect(key1.key).not.toBe(key2.key);
    expect(await getKeysByUser(12345)).toHaveLength(2);
  });
});

// ===========================================================================
// Usage Tests
// ===========================================================================
describe("Usage CRUD", async () => {
  let providerId: number;
  let apiKeyId: number;

  beforeEach(async () => {
    await initDbAsync(makeTempDbPath());

    // Set up prerequisite data
    await addUser(11111, "usageUser");
    await addProvider({
      name: "TestProvider",
      api_type: "openai_chat",
      base_url: "https://test",
      api_key: "test-key",
      models: "gpt-4o",
      input_price: 0.005,
      output_price: 0.015,
    });

    providerId = 1; // first provider
    const { key } = await addApiKey(11111);
    const apiKeyRecord = await getKeyByValue(key);
    apiKeyId = apiKeyRecord!.id;
  });

  afterEach(async () => {
    await closeDb();
    cleanupTempDir();
  });

  it("should record usage", async () => {
    recordUsage(apiKeyId, providerId, 100, 50, 0.5, 0.75, "gpt-4o");
    await flushUsageQueue();

    const usage = await getUsageByUser(11111);
    expect(usage).toHaveLength(1);
    expect(usage[0].input_tokens).toBe(100);
    expect(usage[0].output_tokens).toBe(50);
    expect(usage[0].input_cost).toBe(0.5);
    expect(usage[0].output_cost).toBe(0.75);
    expect(usage[0].model).toBe("gpt-4o");
    expect(usage[0].provider_name).toBe("TestProvider");
  });

  it("should get usage by provider", async () => {
    recordUsage(apiKeyId, providerId, 200, 100, 1.0, 1.5, "gpt-4o");
    await flushUsageQueue();

    const usage = await getUsageByProvider(providerId);
    expect(usage).toHaveLength(1);
    expect(usage[0].input_tokens).toBe(200);
    expect(usage[0].provider_name).toBe("TestProvider");
  });

  it("should return empty array for user with no usage", async () => {
    await addUser(22222, "noUsageUser");
    const usage = await getUsageByUser(22222);
    expect(usage).toHaveLength(0);
  });

  it("should return empty array for provider with no usage", async () => {
    await addProvider({
      name: "EmptyProvider",
      api_type: "anthropic",
      base_url: "https://empty",
      api_key: "empty-key",
      models: "claude-3",
      input_price: null,
      output_price: null,
    });

    const usage = await getUsageByProvider(2);
    expect(usage).toHaveLength(0);
  });

  it("should get total usage with no records", async () => {
    const total = await getTotalUsage();
    expect(total.total_input_tokens).toBe(0);
    expect(total.total_output_tokens).toBe(0);
    expect(total.total_input_cost).toBe(0);
    expect(total.total_output_cost).toBe(0);
    expect(total.total_cost).toBe(0);
    expect(total.record_count).toBe(0);
    expect(total.total_requests).toBe(0);
    expect(total.by_provider).toEqual({});
    expect(total.by_user).toEqual({});
  });

  it("should calculate total usage correctly", async () => {
    recordUsage(apiKeyId, providerId, 100, 50, 0.5, 0.75, "gpt-4o");
    recordUsage(apiKeyId, providerId, 200, 100, 1.0, 1.5, "gpt-4o-mini");
    await flushUsageQueue();

    const total = await getTotalUsage();
    expect(total.total_input_tokens).toBe(300);
    expect(total.total_output_tokens).toBe(150);
    expect(total.total_input_cost).toBe(1.5);
    expect(total.total_output_cost).toBe(2.25);
    expect(total.total_cost).toBeCloseTo(3.75, 5);
    expect(total.record_count).toBe(2);
    expect(total.total_requests).toBe(2);
    // by_provider breakdown
    expect(Object.keys(total.by_provider)).toHaveLength(1);
    expect(total.by_provider["TestProvider"].requests).toBe(2);
    expect(total.by_provider["TestProvider"].input_tokens).toBe(300);
    expect(total.by_provider["TestProvider"].output_tokens).toBe(150);
    expect(total.by_provider["TestProvider"].cost).toBeCloseTo(3.75, 5);
    // by_user breakdown
    expect(Object.keys(total.by_user)).toHaveLength(1);
    expect(total.by_user["usageUser"].requests).toBe(2);
    expect(total.by_user["usageUser"].cost).toBeCloseTo(3.75, 5);
  });

  it("should break down total usage by provider and user", async () => {
    // Second provider + second user
    await addUser(22222, "secondUser");
    await addProvider({
      name: "OtherProvider",
      api_type: "anthropic",
      base_url: "https://other",
      api_key: "other-key",
      models: "claude-3",
      input_price: null,
      output_price: null,
    });
    const { key: key2 } = await addApiKey(22222);
    const apiKey2 = (await getKeyByValue(key2))!.id;

    // User 1 → TestProvider
    recordUsage(apiKeyId, 1, 100, 50, 0.5, 0.75, "gpt-4o");
    // User 2 → OtherProvider
    recordUsage(apiKey2, 2, 300, 200, 2.0, 3.0, "claude-3");
    await flushUsageQueue();

    const total = await getTotalUsage();
    expect(total.record_count).toBe(2);
    expect(total.total_requests).toBe(2);

    // by_provider: two providers
    expect(Object.keys(total.by_provider)).toHaveLength(2);
    expect(total.by_provider["TestProvider"].requests).toBe(1);
    expect(total.by_provider["TestProvider"].input_tokens).toBe(100);
    expect(total.by_provider["OtherProvider"].requests).toBe(1);
    expect(total.by_provider["OtherProvider"].cost).toBeCloseTo(5.0, 5);

    // by_user: two users
    expect(Object.keys(total.by_user)).toHaveLength(2);
    expect(total.by_user["usageUser"].requests).toBe(1);
    expect(total.by_user["secondUser"].requests).toBe(1);
    expect(total.by_user["secondUser"].cost).toBeCloseTo(5.0, 5);
  });
});

// ===========================================================================
// Settings Tests
// ===========================================================================
describe("Settings CRUD", async () => {
  beforeEach(async () => {
    await initDbAsync(makeTempDbPath());
  });

  afterEach(async () => {
    await closeDb();
    cleanupTempDir();
  });

  it("should return null for non-existent setting", async () => {
    const value = await getSetting("nonexistent");
    expect(value).toBeNull();
  });

  it("should set and get a setting", async () => {
    await setSetting("test_key", "test_value");
    expect(await getSetting("test_key")).toBe("test_value");
  });

  it("should upsert a setting (update existing key)", async () => {
    await setSetting("my_setting", "value1");
    expect(await getSetting("my_setting")).toBe("value1");

    await setSetting("my_setting", "value2");
    expect(await getSetting("my_setting")).toBe("value2");
  });

  it("should handle multiple different settings", async () => {
    await setSetting("key_a", "alpha");
    await setSetting("key_b", "beta");
    await setSetting("key_c", "gamma");

    expect(await getSetting("key_a")).toBe("alpha");
    expect(await getSetting("key_b")).toBe("beta");
    expect(await getSetting("key_c")).toBe("gamma");
  });
});

// ===========================================================================
// Database Lifecycle Tests
// ===========================================================================
describe("Database lifecycle", async () => {
  it("should throw if getDb() called before init", async () => {
    // Ensure no DB is active - close if any
    try { await closeDb(); } catch { /* ok */ }

    // We need to re-import or the module-level db is still null
    // Since closeDb sets db=null, getDb should throw
    // But there's a catch - the module might have been initialized by other tests
    // So we'll test initDb sync throws
    const { getDb } = await import("../src/db/database.js");
    // After close, db is null
    try { await closeDb(); } catch { /* ok */ }

    expect(() => getDb()).toThrow("Database not initialized");
  });

  it("should persist data across close and reopen", async () => {
    const dbPath = makeTempDbPath();

    // First session: add data
    await initDbAsync(dbPath);
    await addUser(55555, "persistent_user");
    await setSetting("persisted", "yes");
    await closeDb();

    // Second session: verify data persisted
    await initDbAsync(dbPath);
    const user = await getUserByTgId(55555);
    expect(user).toBeDefined();
    expect(user!.username).toBe("persistent_user");
    expect(await getSetting("persisted")).toBe("yes");
    await closeDb();

    cleanupTempDir();
  });
});

// ===========================================================================
// Permission System — User Groups CRUD
// ===========================================================================
describe("Permission System — User Groups", async () => {
  beforeEach(async () => {
    await initDbAsync(makeTempDbPath());
  });

  afterEach(async () => {
    await closeDb();
    cleanupTempDir();
  });

  it("should seed a default user group on init", async () => {
    const groups = await getUserGroups();
    expect(groups.length).toBeGreaterThanOrEqual(1);

    const defaultGroup = await getDefaultUserGroup();
    expect(defaultGroup).toBeDefined();
    expect(defaultGroup!.name).toBe("default");
    expect(defaultGroup!.is_default).toBe(1);
    expect(defaultGroup!.rpm_limit).toBe(0);
  });

  it("should add a user group and retrieve it", async () => {
    await addUserGroup({ name: "vip", display_name: "VIP Users", rpm_limit: 100, tpm_limit: 50000 });
    const group = await getUserGroupByName("vip");
    expect(group).toBeDefined();
    expect(group!.display_name).toBe("VIP Users");
    expect(group!.rpm_limit).toBe(100);
    expect(group!.tpm_limit).toBe(50000);
    expect(group!.is_default).toBe(0);
  });

  it("should get user group by id", async () => {
    await addUserGroup({ name: "premium", rpm_limit: 200 });
    const group = await getUserGroupByName("premium");
    const byId = await getUserGroupById(group!.id);
    expect(byId).toBeDefined();
    expect(byId!.name).toBe("premium");
  });

  it("should update a user group", async () => {
    await addUserGroup({ name: "basic", rpm_limit: 10 });
    const group = await getUserGroupByName("basic");
    await updateUserGroup(group!.id, { rpm_limit: 50, tpm_limit: 10000 });
    const updated = await getUserGroupById(group!.id);
    expect(updated!.rpm_limit).toBe(50);
    expect(updated!.tpm_limit).toBe(10000);
  });

  it("should not delete the default group", async () => {
    const defaultGroup = await getDefaultUserGroup();
    await expect(deleteUserGroup(defaultGroup!.id)).rejects.toThrow("Cannot delete the default user group");
  });

  it("should delete a non-default group and move users to default", async () => {
    await addUserGroup({ name: "temp-group" });
    const tempGroup = await getUserGroupByName("temp-group");
    const defaultGroup = await getDefaultUserGroup();

    // Add user and assign to temp group
    await addUser(11111, "testuser");
    const user = await getUserByTgId(11111);
    await setUserGroup(user!.id, tempGroup!.id);

    await deleteUserGroup(tempGroup!.id);

    // User should now be in default group
    const afterUser = await getUserWithLimits(user!.id);
    expect(afterUser!.group_id).toBe(defaultGroup!.id);

    // temp-group should no longer exist
    expect(await getUserGroupByName("temp-group")).toBeUndefined();
  });

  it("should reject assigning a missing user group", async () => {
    await addUser(22222, "invalid-group-user");
    const user = await getUserByTgId(22222);

    await expect(setUserGroup(user!.id, 999)).rejects.toThrow("User group not found");
    expect((await getUserWithLimits(user!.id))!.group_id).toBeNull();
  });

  it("should repair missing user group references during initialization", async () => {
    const defaultGroup = await getDefaultUserGroup();
    await addUser(33333, "orphan-group-user");
    const user = await getUserByTgId(33333);

    getDb().run("UPDATE users SET group_id = ? WHERE id = ?", [999, user!.id]);
    await saveDb();
    await closeDb();

    await initDbAsync(dbFile);

    const repairedUser = await getUserWithLimits(user!.id);
    expect(repairedUser!.group_id).toBe(defaultGroup!.id);
  });
});

// ===========================================================================
// Permission System — Effective Limits Calculation
// ===========================================================================
describe("Permission System — Effective Limits", async () => {
  beforeEach(async () => {
    await initDbAsync(makeTempDbPath());
  });

  afterEach(async () => {
    await closeDb();
    cleanupTempDir();
  });

  it("should return unlimited (all zeros) for user in default group with no overrides", async () => {
    await addUser(22222, "limitless-user");
    const user = await getUserByTgId(22222);
    const limits = await getEffectiveLimits(user!.id, null);
    expect(limits.rpm).toBe(0);
    expect(limits.tpm).toBe(0);
    expect(limits.concurrency).toBe(0);
    expect(limits.dailyTokenLimit).toBe(0);
    expect(limits.monthlyTokenLimit).toBe(0);
    expect(limits.dailyCostLimit).toBe(0);
    expect(limits.monthlyCostLimit).toBe(0);
    expect(limits.expiresAt).toBeNull();
  });

  it("should apply group limits when user is in a group", async () => {
    await addUserGroup({ name: "rate-limited", rpm_limit: 30, tpm_limit: 10000, concurrency_limit: 5 });
    const group = await getUserGroupByName("rate-limited");

    await addUser(33333, "limited-user");
    const user = await getUserByTgId(33333);
    await setUserGroup(user!.id, group!.id);

    const limits = await getEffectiveLimits(user!.id, null);
    expect(limits.rpm).toBe(30);
    expect(limits.tpm).toBe(10000);
    expect(limits.concurrency).toBe(5);
  });

  it("should let user override take priority over group", async () => {
    await addUserGroup({ name: "standard", rpm_limit: 60, tpm_limit: 20000 });
    const group = await getUserGroupByName("standard");

    await addUser(44444, "override-user");
    const user = await getUserByTgId(44444);
    await setUserGroup(user!.id, group!.id);
    await setUserOverrides(user!.id, { rpm_override: 10 }); // stricter override

    const limits = await getEffectiveLimits(user!.id, null);
    expect(limits.rpm).toBe(10); // override wins
    expect(limits.tpm).toBe(20000); // from group
  });

  it("should let API key override take priority over user and group", async () => {
    await addUserGroup({ name: "tier2", rpm_limit: 60 });
    const group = await getUserGroupByName("tier2");

    await addUser(55555, "apikey-override-user");
    const user = await getUserByTgId(55555);
    await setUserGroup(user!.id, group!.id);
    await setUserOverrides(user!.id, { rpm_override: 30 });

    // Create an API key for the user
    const keyResult = await addApiKey(55555);
    const apiKey = await getKeyByValue(keyResult.key);
    await setApiKeyOverrides(apiKey!.id, { rpm_override: 5 }); // API key override wins

    const limits = await getEffectiveLimits(user!.id, apiKey!.id);
    expect(limits.rpm).toBe(5);
  });

  it("should resolve expiry date from user level", async () => {
    const futureDate = "2099-12-31T23:59:59";
    await addUser(66666, "expiring-user");
    const user = await getUserByTgId(66666);
    await setUserOverrides(user!.id, { expires_at: futureDate });

    const limits = await getEffectiveLimits(user!.id, null);
    expect(limits.expiresAt).toBe(futureDate);
  });

  it("should let API key expiry override user expiry", async () => {
    const userFuture = "2099-12-31T23:59:59";
    const apiKeyPast = "2000-01-01T00:00:00";

    await addUser(77777, "dual-expiry-user");
    const user = await getUserByTgId(77777);
    await setUserOverrides(user!.id, { expires_at: userFuture });

    const keyResult = await addApiKey(77777);
    const apiKey = await getKeyByValue(keyResult.key);
    await setApiKeyOverrides(apiKey!.id, { expires_at: apiKeyPast });

    const limits = await getEffectiveLimits(user!.id, apiKey!.id);
    expect(limits.expiresAt).toBe(apiKeyPast);
  });
});

// ===========================================================================
// Permission System — Quota Queries
// ===========================================================================
describe("Permission System — Quota Queries", async () => {
  beforeEach(async () => {
    await initDbAsync(makeTempDbPath());
  });

  afterEach(async () => {
    await closeDb();
    cleanupTempDir();
  });

  it("should return zero usage for new user", async () => {
    await addUser(88888, "no-usage-user");
    const user = await getUserByTgId(88888);

    const daily = await getDailyUsage(user!.id, null);
    expect(daily.total_input_tokens + daily.total_output_tokens).toBe(0);
    expect(daily.total_cost).toBe(0);

    const monthly = await getMonthlyUsage(user!.id, null);
    expect(monthly.total_input_tokens + monthly.total_output_tokens).toBe(0);
    expect(monthly.total_cost).toBe(0);
  });

  it("should calculate daily usage from usage table", async () => {
    // Setup: user, provider, api key
    await addUser(99990, "quota-user");
    const user = await getUserByTgId(99990);
    await addProvider({
      name: "TestProvider",
      api_type: "openai_chat",
      base_url: "https://example.com/v1",
      api_key: "sk-provider-key",
      models: "gpt-4o",
    });
    const provider = (await getProviders())[0];
    const keyResult = await addApiKey(99990);
    const apiKey = await getKeyByValue(keyResult.key);

    // Record usage
    recordUsage(apiKey!.id, provider!.id, 1000, 500, 0.01, 0.02, "gpt-4o");
    recordUsage(apiKey!.id, provider!.id, 2000, 1000, 0.02, 0.04, "gpt-4o");
    await flushUsageQueue();

    const daily = await getDailyUsage(user!.id, null);
    expect(daily.total_input_tokens + daily.total_output_tokens).toBe(4500); // (1000+500) + (2000+1000)
    expect(daily.total_cost).toBeCloseTo(0.09, 5); // (0.01+0.02) + (0.02+0.04)
  });

  it("should filter usage by specific api key", async () => {
    await addUser(99991, "multi-key-user");
    const user = await getUserByTgId(99991);
    await addProvider({
      name: "Provider2",
      api_type: "openai_chat",
      base_url: "https://example.com/v1",
      api_key: "sk-provider-key2",
      models: "gpt-4o",
    });
    const provider = (await getProviders())[0];

    const key1 = await addApiKey(99991);
    const apiKey1 = await getKeyByValue(key1.key);
    const key2 = await addApiKey(99991);
    const apiKey2 = await getKeyByValue(key2.key);

    recordUsage(apiKey1!.id, provider!.id, 3000, 1000, 0.05, 0.05, "gpt-4o");
    recordUsage(apiKey2!.id, provider!.id, 5000, 2000, 0.10, 0.10, "gpt-4o");
    await flushUsageQueue();

    // Per-key usage
    const key1Daily = await getDailyUsage(user!.id, apiKey1!.id);
    expect(key1Daily.total_input_tokens + key1Daily.total_output_tokens).toBe(4000); // 3000+1000 only from key1
    expect(key1Daily.total_cost).toBeCloseTo(0.10, 5);

    // Total user usage (all keys)
    const totalDaily = await getDailyUsage(user!.id, null);
    expect(totalDaily.total_input_tokens + totalDaily.total_output_tokens).toBe(11000); // 4000 + 7000
    expect(totalDaily.total_cost).toBeCloseTo(0.30, 5);
  });
});

// ===========================================================================
// Permission System — isExpired helper
// ===========================================================================
describe("Permission System — isExpired", async () => {
  it("should return false for null expiry", async () => {
    expect(isExpired(null)).toBe(false);
  });

  it("should return false for future date", async () => {
    expect(isExpired("2099-12-31T23:59:59")).toBe(false);
  });

  it("should return true for past date", async () => {
    expect(isExpired("2000-01-01T00:00:00")).toBe(true);
  });
});

// ===========================================================================
// Backup / Restore
// ===========================================================================
describe("Backup / Restore", async () => {
  beforeEach(async () => {
    await initDbAsync(makeTempDbPath());
  });

  afterEach(async () => {
    await closeDb();
    cleanupTempDir();
  });

  it("exportDatabase returns all 11 backup tables with version 1", async () => {
    const data = await exportDatabase();
    expect(data.version).toBe(1);
    expect(typeof data.exportedAt).toBe("string");
    // All 11 tables should be present (even if empty)
    const expectedTables = [
      "api_keys", "coding_configs", "model_mappings", "model_prices",
      "model_restrictions", "providers", "settings", "usage",
      "user_groups", "users", "web_users",
    ];
    expect(Object.keys(data.tables).sort()).toEqual(expectedTables);
    // Empty DB → all tables are empty arrays
    for (const table of expectedTables) {
      expect(Array.isArray(data.tables[table])).toBe(true);
    }
  });

  it("exportDatabase includes inserted data", async () => {
    await addProvider({
      name: "OpenAI",
      api_type: "openai_chat",
      base_url: "https://api.openai.com/v1",
      api_key: "sk-test",
      models: "gpt-4o",
      input_price: 0.005,
      output_price: 0.015,
    });
    await addUser(111, "alice");
    await setSetting("api_url", "http://example.com");

    const data = await exportDatabase();
    expect(data.tables.providers).toHaveLength(1);
    expect(data.tables.providers[0].name).toBe("OpenAI");
    expect(data.tables.users).toHaveLength(1);
    expect(data.tables.users[0].tg_user_id).toBe(111);
    // Settings may contain defaults from initDbAsync; verify our specific setting
    const apiUrlSetting = data.tables.settings.find((s) => s.key === "api_url");
    expect(apiUrlSetting).toBeDefined();
    expect(apiUrlSetting!.value).toBe("http://example.com");
  });

  it("getBackupSummary returns correct counts and metadata", async () => {
    const data: BackupData = {
      version: 1,
      exportedAt: "2024-06-15T12:00:00.000Z",
      tables: {
        providers: [{ id: 1 }, { id: 2 }],
        users: [{ id: 1 }],
        api_keys: [],
        usage: [],
        settings: [],
        model_prices: [],
        coding_configs: [],
        model_restrictions: [],
        user_groups: [],
        model_mappings: [],
      },
    };

    const summary = getBackupSummary(data);
    expect(summary.version).toBe(1);
    expect(summary.exportedAt).toBe("2024-06-15T12:00:00.000Z");
    expect(summary.counts.providers).toBe(2);
    expect(summary.counts.users).toBe(1);
    expect(summary.counts.api_keys).toBe(0);
  });

  it("importDatabase restores data and overwrites existing (round-trip)", async () => {
    // Setup initial data
    await addProvider({
      name: "P1",
      api_type: "openai_chat",
      base_url: "http://localhost",
      api_key: "key1",
      models: "gpt-4o",
      input_price: 1,
      output_price: 2,
    });
    await addUser(111, "alice");

    // Export
    const data = await exportDatabase();

    // Add extra data that should be wiped on import
    await addProvider({
      name: "Extra",
      api_type: "anthropic",
      base_url: "http://localhost",
      api_key: "key2",
      models: "claude-3",
      input_price: 3,
      output_price: 4,
    });

    // Import original backup (should wipe "Extra")
    await importDatabase(data);

    const providers = await getProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0].name).toBe("P1");

    const users = await getUsers();
    expect(users).toHaveLength(1);
    expect((users[0] as Record<string, unknown>).tg_user_id).toBe(111);
  });

  it("importDatabase clears all data when importing empty backup", async () => {
    await addProvider({
      name: "P1",
      api_type: "openai_chat",
      base_url: "http://localhost",
      api_key: "key1",
      models: "gpt-4o",
      input_price: 1,
      output_price: 2,
    });

    const emptyBackup: BackupData = {
      version: 1,
      exportedAt: "2024-01-01T00:00:00.000Z",
      tables: {
        providers: [], users: [], api_keys: [], usage: [],
        settings: [], model_prices: [], coding_configs: [],
        model_restrictions: [], user_groups: [], model_mappings: [],
      },
    };

    await importDatabase(emptyBackup);

    expect(await getProviders()).toHaveLength(0);
    expect(await getUsers()).toHaveLength(0);
  });

  it("importDatabase rejects foreign key violations and rolls back", async () => {
    await addUser(111, "alice");
    await addApiKey(111);
    const data = await exportDatabase();
    const tampered: BackupData = JSON.parse(JSON.stringify(data));
    tampered.tables.api_keys[0].user_id = 999999;

    await expect(importDatabase(tampered)).rejects.toThrow(/foreign key violations|Invalid backup/);
    expect(await getKeysByUser(111)).toHaveLength(1);
  });

  it("importDatabase rejects orphan model prices and rolls back", async () => {
    await addProvider({
      name: "OpenAI",
      api_type: "openai_chat",
      base_url: "https://api.openai.com/v1",
      api_key: "sk-key",
      models: "gpt-4o",
      input_price: null,
      output_price: null,
    });

    const orphanBackup: BackupData = {
      version: 1,
      exportedAt: "2024-01-01T00:00:00.000Z",
      tables: {
        providers: [],
        users: [],
        api_keys: [],
        usage: [],
        settings: [],
        model_prices: [{
          id: 1,
          provider_id: 999,
          model: "ghost-model",
          input_price: 1,
          output_price: 2,
          created_at: "2024-01-01 00:00:00",
          updated_at: "2024-01-01 00:00:00",
        }],
        coding_configs: [],
        model_restrictions: [],
        user_groups: [],
        model_mappings: [],
      },
    };

    await expect(importDatabase(orphanBackup)).rejects.toThrow(/model_prices.*providers|foreign key violations|Invalid backup/);
    expect(await getProviders()).toHaveLength(1);
  });

  it("importDatabase throws on invalid format", async () => {
    await expect(importDatabase(null as unknown as BackupData)).rejects.toThrow();
    await expect(importDatabase({} as BackupData)).rejects.toThrow();
    await expect(importDatabase({ version: 1, exportedAt: "", tables: null } as unknown as BackupData),
    ).rejects.toThrow();
    await expect(importDatabase({ version: 1, exportedAt: "", tables: "not-object" } as unknown as BackupData),
    ).rejects.toThrow();
  });

  it("importDatabase handles rows with missing columns (backward compat)", async () => {
    // Simulate old backup missing newer columns (e.g., key_strategy)
    const data: BackupData = {
      version: 1,
      exportedAt: "2024-01-01T00:00:00.000Z",
      tables: {
        providers: [{
          id: 1,
          name: "OldProvider",
          api_type: "openai_chat",
          base_url: "http://localhost",
          api_key: "key1",
          models: "gpt-4o",
          enabled: 1,
          input_price: 1,
          output_price: 2,
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-01T00:00:00Z",
          // key_strategy deliberately missing — should default to null
        }],
        users: [], api_keys: [], usage: [],
        settings: [], model_prices: [], coding_configs: [],
        model_restrictions: [], user_groups: [], model_mappings: [],
      },
    };

    await importDatabase(data);

    const providers = await getProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0].name).toBe("OldProvider");
  });

  it("importDatabase ignores unknown columns in backup (forward compat)", async () => {
    const data: BackupData = {
      version: 1,
      exportedAt: "2024-01-01T00:00:00.000Z",
      tables: {
        providers: [{
          id: 1,
          name: "P1",
          api_type: "openai_chat",
          base_url: "http://localhost",
          api_key: "key1",
          models: "gpt-4o",
          enabled: 1,
          input_price: 1,
          output_price: 2,
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-01T00:00:00Z",
          future_unknown_column: "should-be-ignored",
        }],
        users: [], api_keys: [], usage: [],
        settings: [], model_prices: [], coding_configs: [],
        model_restrictions: [], user_groups: [], model_mappings: [],
      },
    };

    // Should not throw — unknown columns silently dropped
    await expect(importDatabase(data)).resolves.toBeUndefined();
    expect(await getProviders()).toHaveLength(1);
  });

  it("full round-trip: export → clear → import → export produces same data", async () => {
    await addProvider({
      name: "P1",
      api_type: "openai_chat",
      base_url: "http://localhost",
      api_key: "key1",
      models: "gpt-4o",
      input_price: 1.5,
      output_price: 2.5,
    });
    await addProvider({
      name: "P2",
      api_type: "anthropic",
      base_url: "http://localhost",
      api_key: "key2",
      models: "claude-3",
      input_price: 3,
      output_price: 4,
    });
    await addUser(111, "alice");
    await addUser(222, "bob");
    await setSetting("api_url", "http://example.com");

    const data1 = await exportDatabase();

    // Wipe and re-import
    const emptyBackup: BackupData = {
      version: 1, exportedAt: "",
      tables: {
        providers: [], users: [], api_keys: [], usage: [],
        settings: [], model_prices: [], coding_configs: [],
        model_restrictions: [], user_groups: [], model_mappings: [],
      },
    };
    await importDatabase(emptyBackup);
    await importDatabase(data1);

    const data2 = await exportDatabase();

    // Compare table counts
    for (const table of Object.keys(data1.tables)) {
      expect(data2.tables[table]).toHaveLength(data1.tables[table].length);
    }
    // Spot-check specific values
    expect(data2.tables.providers).toHaveLength(2);
    // Verify our specific setting survived the round-trip (settings count
    // may include initDbAsync defaults; already checked in loop above)
    const apiUrlSetting = data2.tables.settings.find((s) => s.key === "api_url");
    expect(apiUrlSetting).toBeDefined();
    expect(apiUrlSetting!.value).toBe("http://example.com");
  });
});

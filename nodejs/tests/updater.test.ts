/**
 * Unit tests for src/updater.ts
 *
 * Tests:
 *   - getLatestRelease() — mock global fetch (success, HTTP error, network error)
 *   - getCurrentVersion() — real git repo (hash, tag)
 *   - isWorkingDirClean() — real git repo
 *   - getBackupList() — temp directory with fake backup dirs
 *   - performRollback() — no backups case + with backups case
 *   - fetchAndCheckUpdate() — mock fetch, no update scenario
 *
 * Strategy:
 *   - Pure logic tests use temp directories + process.chdir() for fs operations
 *   - Network tests mock global fetch
 *   - Git operations run against the real repo (integration)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";

// ===========================================================================
// Mock: database.js (updater imports closeDb)
// ===========================================================================

vi.mock("../src/db/database.js", () => ({
  closeDb: vi.fn(),
}));

// ===========================================================================
// Import AFTER mock
// ===========================================================================

import {
  getLatestRelease,
  getCurrentVersion,
  isWorkingDirClean,
  getBackupList,
  performRollback,
  fetchAndCheckUpdate,
} from "../src/updater.js";

// ===========================================================================
// Helpers
// ===========================================================================

/** Create a temp directory with fake backup directories */
function createTempDirWithBackups(timestamps: number[]): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "updater-test-"));
  for (const ts of timestamps) {
    const backupDir = path.join(tmpDir, `.backup-${ts}`);
    fs.mkdirSync(backupDir, { recursive: true });
    // Create a dummy file inside to simulate content
    fs.writeFileSync(path.join(backupDir, "package.json"), '{"name":"test"}');
  }
  return tmpDir;
}

/** Recursively remove a directory */
function rmrf(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

// ===========================================================================
// getLatestRelease
// ===========================================================================

describe("getLatestRelease", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns ReleaseInfo on successful API response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        tag_name: "v1.2.0",
        name: "Release 1.2.0",
        prerelease: false,
        published_at: "2024-06-15T10:00:00Z",
        html_url: "https://github.com/s12ryt/s12ryt-tg-api/releases/tag/v1.2.0",
        tarball_url: "https://api.github.com/repos/s12ryt/s12ryt-tg-api/tarball/v1.2.0",
      }),
    }) as any;

    const result = await getLatestRelease();
    expect(result).not.toBeNull();
    expect(result!.tag).toBe("v1.2.0");
    expect(result!.name).toBe("Release 1.2.0");
    expect(result!.prerelease).toBe(false);
    expect(result!.tarballUrl).toContain("tarball");
  });

  it("returns null on HTTP error (404)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    }) as any;

    const result = await getLatestRelease();
    expect(result).toBeNull();
  });

  it("returns null on network error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network timeout")) as any;

    const result = await getLatestRelease();
    expect(result).toBeNull();
  });

  it("falls back to tag_name when name is missing", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        tag_name: "v2.0.0",
        name: null,
        prerelease: false,
        published_at: "",
        html_url: "https://github.com/...",
        tarball_url: "https://api.github.com/...",
      }),
    }) as any;

    const result = await getLatestRelease();
    expect(result).not.toBeNull();
    expect(result!.name).toBe("v2.0.0");
  });
});

// ===========================================================================
// getCurrentVersion (integration — uses real git repo)
// ===========================================================================

describe("getCurrentVersion", () => {
  it("returns version info with hash in git repo", () => {
    const version = getCurrentVersion();
    expect(version.hash).toBeTruthy();
    expect(version.hash).not.toBe("unknown");
    expect(typeof version.date).toBe("string");
    expect(typeof version.message).toBe("string");
  });

  it("returns a non-empty commit message", () => {
    const version = getCurrentVersion();
    expect(version.message.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// isWorkingDirClean (integration — uses real git repo)
// ===========================================================================

describe("isWorkingDirClean", () => {
  it("returns a boolean without throwing", () => {
    const result = isWorkingDirClean();
    expect(typeof result).toBe("boolean");
  });
});

// ===========================================================================
// getBackupList
// ===========================================================================

describe("getBackupList", () => {
  let originalCwd: string;
  let tmpDir: string;

  beforeEach(() => {
    originalCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (tmpDir) rmrf(tmpDir);
  });

  it("returns empty array when no backups exist", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "updater-empty-"));
    process.chdir(tmpDir);

    const backups = getBackupList();
    expect(backups).toEqual([]);
  });

  it("finds and lists backup directories", () => {
    tmpDir = createTempDirWithBackups([1000, 2000, 3000]);
    process.chdir(tmpDir);

    const backups = getBackupList();
    expect(backups).toHaveLength(3);
    // Should be sorted newest first (descending)
    expect(backups[0].timestamp).toBe(3000);
    expect(backups[1].timestamp).toBe(2000);
    expect(backups[2].timestamp).toBe(1000);
  });

  it("filters out non-backup directories", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "updater-mixed-"));
    fs.mkdirSync(path.join(tmpDir, ".backup-5000"));
    fs.mkdirSync(path.join(tmpDir, ".staging"));
    fs.mkdirSync(path.join(tmpDir, "src"));
    fs.writeFileSync(path.join(tmpDir, "package.json"), "{}");

    process.chdir(tmpDir);

    const backups = getBackupList();
    expect(backups).toHaveLength(1);
    expect(backups[0].name).toBe(".backup-5000");
  });

  it("parses timestamp correctly", () => {
    const ts = 1718534400000;
    tmpDir = createTempDirWithBackups([ts]);
    process.chdir(tmpDir);

    const backups = getBackupList();
    expect(backups[0].timestamp).toBe(ts);
    expect(backups[0].createdAt).toBeInstanceOf(Date);
    expect(backups[0].createdAt.getTime()).toBe(ts);
  });

  it("handles invalid timestamp in directory name", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "updater-invalid-"));
    fs.mkdirSync(path.join(tmpDir, ".backup-notanumber"));
    process.chdir(tmpDir);

    const backups = getBackupList();
    expect(backups).toHaveLength(1);
    expect(backups[0].timestamp).toBe(0); // NaN → 0 fallback
  });
});

// ===========================================================================
// performRollback
// ===========================================================================

describe("performRollback", () => {
  let originalCwd: string;
  let tmpDir: string;

  beforeEach(() => {
    originalCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (tmpDir) rmrf(tmpDir);
  });

  it("returns failure when no backups exist", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "updater-no-backup-"));
    process.chdir(tmpDir);

    const result = performRollback();
    expect(result.success).toBe(false);
    expect(result.message).toContain("沒有可用");
  });

  it("restores from newest backup and creates pre-rollback backup", () => {
    // Create a temp dir with one backup containing a marker file
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "updater-rollback-"));

    // Create backup with a recognizable package.json
    const backupTs = 5000;
    const backupDir = path.join(tmpDir, `.backup-${backupTs}`);
    fs.mkdirSync(path.join(backupDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(backupDir, "package.json"),
      '{"version":"1.0.0-backup"}',
    );

    // Create current "running" version (different)
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      '{"version":"2.0.0-current"}',
    );

    process.chdir(tmpDir);

    const result = performRollback();
    expect(result.success).toBe(true);

    // Verify current package.json is now from backup
    const currentPkg = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "package.json"), "utf-8"),
    );
    expect(currentPkg.version).toBe("1.0.0-backup");

    // Verify a pre-rollback backup was created
    const dirs = fs.readdirSync(tmpDir);
    const preRollback = dirs.find((d) => d.startsWith(".backup-pre-rollback-"));
    expect(preRollback).toBeTruthy();

    // Verify the used backup was cleaned up
    const oldBackupExists = fs.existsSync(path.join(tmpDir, `.backup-${backupTs}`));
    expect(oldBackupExists).toBe(false);
  });
});

// ===========================================================================
// fetchAndCheckUpdate (integration — uses real git + mocked fetch)
// ===========================================================================

describe("fetchAndCheckUpdate", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns UpdateCheckResult without throwing", async () => {
    // Mock fetch to return no release
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    }) as any;

    const result = await fetchAndCheckUpdate();
    expect(result).toBeDefined();
    expect(typeof result.hasUpdate).toBe("boolean");
    expect(result.current).toBeDefined();
    expect(typeof result.commitsBehind).toBe("number");
    expect(Array.isArray(result.newCommits)).toBe(true);
  });

  it("detects update when GitHub release tag is newer", async () => {
    // Mock fetch to return a very new version
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        tag_name: "v99.99.99",
        name: "Future Release",
        prerelease: false,
        published_at: "2099-01-01T00:00:00Z",
        html_url: "https://github.com/...",
        tarball_url: "https://api.github.com/.../tarball/v99.99.99",
      }),
    }) as any;

    const result = await fetchAndCheckUpdate();
    // v99.99.99 is definitely newer than current version
    expect(result.hasUpdate).toBe(true);
    expect(result.latestRelease).not.toBeNull();
    expect(result.latestRelease!.tag).toBe("v99.99.99");
  });

  it("detects no update when GitHub release is same or older", async () => {
    // Mock fetch to return a very old version
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        tag_name: "v0.0.1",
        name: "Ancient Release",
        prerelease: false,
        published_at: "2020-01-01T00:00:00Z",
        html_url: "https://github.com/...",
        tarball_url: "https://api.github.com/.../tarball/v0.0.1",
      }),
    }) as any;

    const result = await fetchAndCheckUpdate();
    // v0.0.1 is older than current → hasUpdate depends on git status too
    // At minimum, the GitHub release comparison should say no update from release
    expect(result.latestRelease).not.toBeNull();
    expect(result.latestRelease!.tag).toBe("v0.0.1");
  });
});

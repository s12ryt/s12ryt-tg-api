/**
 * 程式內置更新模組
 *
 * 功能：
 *   - 透過 GitHub Releases API 查詢最新版本
 *   - 執行更新：git pull（主要）→ tarball 下載（備援）
 *   - 自動重啟進程
 */

import { spawn, execFileSync, type SpawnOptions } from "node:child_process";
import {
  utimesSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
  mkdirSync,
  renameSync,
  createWriteStream,
  statfsSync,
} from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { pipeline } from "node:stream/promises";
import { closeDb } from "./db/database.js";
import { getConfiguredMemoryMB } from "./memory.js";
import { fetchWithRetry, fetchGithub, applyMirror, diagnoseConnectivity } from "./net.js";
export { parseMemoryLimitMB, getConfiguredMemoryMB } from "./memory.js";
export { diagnoseConnectivity } from "./net.js";
export type { ConnectivityReport } from "./net.js";

// ========================
// 常數
// ========================

const GITHUB_OWNER = "s12ryt";
const GITHUB_REPO = "s12ryt-tg-api";
const GITHUB_API_BASE = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`;

// ========================
// Blue-Green 更新常數
// ========================

/** 需要原子交換的項目（這些會被 staging 版本替換） */
const SWAP_ITEMS = [
  "src", "dist", "web", "scripts",
  "node_modules", "package.json", "package-lock.json", "tsconfig.json",
] as const;

/** tarball 中不需要部署到執行環境的項目 */
const STAGING_SKIP_ITEMS = new Set(["data", ".env", "node_modules", ".git", "tests"]);

/** 暫存目錄名稱（新版本在此下載、安裝、編譯） */
const STAGING_DIR = ".staging";

/** 備份目錄前綴（舊版本保存於此，用於回滾） */
const BACKUP_PREFIX = ".backup-";

/** 最大保留備份數量 */
const MAX_BACKUPS = 2;

/** 更新前最低建議可用空間（Blue-Green 需要暫存新版本 + node_modules + dist + 備份） */
const MIN_UPDATE_FREE_BYTES = 768 * 1024 * 1024;

/** 更新前最低建議可用 inode 數，避免小檔案過多導致 ENOSPC */
const MIN_UPDATE_FREE_INODES = 10_000;

const BYTES_PER_MB = 1024 * 1024;

export interface DiskSpaceInfo {
  availableBytes: number;
  freeInodes: number | null;
}

export interface DiskSpaceThresholds {
  minFreeBytes: number;
  minFreeInodes: number;
}

export interface DiskPreflightResult {
  ok: boolean;
  info: DiskSpaceInfo | null;
  message: string | null;
}

const DEFAULT_UPDATE_DISK_THRESHOLDS: DiskSpaceThresholds = {
  minFreeBytes: MIN_UPDATE_FREE_BYTES,
  minFreeInodes: MIN_UPDATE_FREE_INODES,
};

// ========================
// 低資源環境輔助函數
// ========================

/**
 * 偵測系統總記憶體（MB）。
 * 在容器中，os.totalmem() 會受 cgroup 限制自動回傳正確值。
 */
function getTotalMemMB(): number {
  return Math.floor(os.totalmem() / 1024 / 1024);
}

/**
 * 根據可用記憶體計算 V8 堆疊上限（--max-old-space-size）。
 *
 * 策略：取總記憶體的 50%，但限制在 [128, 512] MB 範圍內。
 *   - 256MB 容器 → 128MB（留 128MB 給系統 + 主進程 + sql.js）
 *   - 512MB 容器 → 256MB
 *   - 1GB+       → 512MB（上限，避免無謂分配）
 *
 * 用戶可通過 memory（優先）或 MAX_OLD_SPACE（相容舊設定）環境變數覆蓋。
 */
function getOptimalHeapSize(): number {
  const configured = getConfiguredMemoryMB();
  if (configured !== null) return configured;

  const totalMB = getTotalMemMB();
  const calculated = Math.floor(totalMB * 0.5);
  return Math.max(128, Math.min(512, calculated));
}

/**
 * 低資源環境的 timeout 倍數。
 *
 * 在低 CPU / 低記憶體環境中，npm install 和 tsc 等操作需要更多時間。
 * 根據記憶體量判斷資源受限程度：
 *   - ≤ 512MB → 3 倍（嚴重受限）
 *   - ≤ 1024MB → 2 倍（中度受限）
 *   - > 1024MB → 1 倍（正常）
 */
function getTimeoutMultiplier(): number {
  const totalMB = getTotalMemMB();
  if (totalMB <= 512) return 3;
  if (totalMB <= 1024) return 2;
  return 1;
}

/** 快取倍數結果（啟動時計算一次，後續直接使用） */
const TIMEOUT_MULT = getTimeoutMultiplier();
/** 快取堆疊大小（啟動時計算一次） */
const OPTIMAL_HEAP = getOptimalHeapSize();

// ========================
// 型別定義
// ========================

export interface VersionInfo {
  /** 短 commit hash，例如 "abc1234" */
  hash: string;
  /** ISO 8601 提交時間，例如 "2024-01-15T10:30:00+08:00" */
  date: string;
  /** 提交訊息第一行 */
  message: string;
  /** 最近的 git tag（例如 "v1.2.0"），沒有則為 null */
  tag: string | null;
}

export interface ReleaseInfo {
  /** Release tag 名稱，例如 "v1.2.0" */
  tag: string;
  /** Release 標題 */
  name: string;
  /** 是否為預發布版本 */
  prerelease: boolean;
  /** 發布時間 (ISO 8601) */
  publishedAt: string;
  /** Release 頁面 URL */
  htmlUrl: string;
  /** Tarball 下載 URL */
  tarballUrl: string;
}

export interface UpdateCheckResult {
  /** 是否有更新 */
  hasUpdate: boolean;
  /** 當前版本 */
  current: VersionInfo;
  /** GitHub 最新 Release 資訊 */
  latestRelease: ReleaseInfo | null;
  /** 落後的 commit 數量 */
  commitsBehind: number;
  /** 落後的 commit 列表（每行一條） */
  newCommits: string[];
  /** 網路錯誤訊息（GitHub API 或 git fetch 失敗時記錄，供上層診斷用） */
  networkError: string | null;
}

export interface UpdateResult {
  success: boolean;
  message: string;
  /** 更新方式：blue-green、git 或 tarball */
  method?: "git" | "tarball" | "blue-green";
  /** 更新後的 commit hash */
  newHash?: string;
}

export interface BackupInfo {
  /** 備份目錄名稱（例如 ".backup-1718534400000"） */
  name: string;
  /** 備份建立時間戳（毫秒） */
  timestamp: number;
  /** 備份建立時間 */
  createdAt: Date;
}

// ========================
// Git 輔助函數
// ========================

function execGit(args: string[]): string {
  try {
    const result = execFileSync("git", args, {
      cwd: process.cwd(),
      encoding: "utf-8",
      timeout: 30_000 * TIMEOUT_MULT,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return result.trim();
  } catch (err: any) {
    const stderr = err.stderr?.toString()?.trim() ?? "";
    const stdout = err.stdout?.toString()?.trim() ?? "";
    throw new Error(stderr || stdout || err.message || "git command failed");
  }
}

/** 判斷當前目錄是否為 git 倉庫 */
function isGitRepo(): boolean {
  try {
    execGit(["rev-parse", "--git-dir"]);
    return true;
  } catch {
    return false;
  }
}

function parseVersionInfo(ref: string): VersionInfo {
  const hash = execGit(["rev-parse", "--short", ref]);
  const date = execGit(["log", "-1", "--format=%cI", ref]);
  const message = execGit(["log", "-1", "--format=%s", ref]);
  let tag: string | null = null;
  try {
    tag = execGit(["describe", "--tags", "--abbrev=0", ref]);
  } catch {
    // 沒有 tag，正常情況
  }
  return { hash, date, message, tag };
}

function formatBytes(bytes: number): string {
  return `${Math.max(0, bytes / BYTES_PER_MB).toFixed(0)} MB`;
}

function buildDiskCleanupHint(): string {
  return "請在 Node.js 目錄清理更新暫存/備份與 npm 快取：rm -rf .staging .backup-* && npm cache clean --force；再用 df -h / df -i 檢查磁碟與 inode。不要刪除 data/ 或 .env。";
}

export function shouldStageItem(entry: string): boolean {
  return !STAGING_SKIP_ITEMS.has(entry);
}

function buildDiskSpaceMessage(reason: string, info: DiskSpaceInfo | null): string {
  const current = info
    ? `目前可用空間 ${formatBytes(info.availableBytes)}，可用 inode ${info.freeInodes ?? "未知"}。`
    : "目前無法讀取磁碟容量資訊。";
  return `${reason}${current}${buildDiskCleanupHint()}`;
}

export function evaluateDiskSpace(
  info: DiskSpaceInfo,
  thresholds: DiskSpaceThresholds = DEFAULT_UPDATE_DISK_THRESHOLDS,
): DiskPreflightResult {
  if (info.availableBytes < thresholds.minFreeBytes) {
    return {
      ok: false,
      info,
      message: buildDiskSpaceMessage(
        `更新前可用空間不足，至少需要 ${formatBytes(thresholds.minFreeBytes)}。`,
        info,
      ),
    };
  }

  if (info.freeInodes !== null && info.freeInodes < thresholds.minFreeInodes) {
    return {
      ok: false,
      info,
      message: buildDiskSpaceMessage(
        `更新前可用 inode 不足，至少需要 ${thresholds.minFreeInodes}。`,
        info,
      ),
    };
  }

  return { ok: true, info, message: null };
}

export function getDiskSpaceInfo(path = process.cwd()): DiskSpaceInfo | null {
  try {
    const stat = statfsSync(path);
    const availableBytes = Number(stat.bavail) * Number(stat.bsize);
    const freeInodes = Number.isFinite(Number(stat.ffree)) ? Number(stat.ffree) : null;
    return { availableBytes, freeInodes };
  } catch {
    return null;
  }
}

export function checkUpdateDiskSpace(path = process.cwd()): DiskPreflightResult {
  const info = getDiskSpaceInfo(path);
  if (!info) return { ok: true, info: null, message: null };
  return evaluateDiskSpace(info);
}

export function isNoSpaceError(err: any): boolean {
  const text = [err?.code, err?.message, err?.stderr, err?.stdout]
    .map((value) => String(value ?? "").toLowerCase())
    .join("\n");
  return text.includes("enospc") || text.includes("no space left on device");
}

function buildNoSpaceErrorMessage(info: DiskSpaceInfo | null): string {
  return buildDiskSpaceMessage(
    "磁碟空間或 inode 不足（ENOSPC）。Blue-Green 更新會同時保留目前版本、暫存新版本、node_modules、dist 與備份。",
    info,
  );
}

// ========================
// SemVer 工具
// ========================

interface ParsedSemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

function parseSemVer(version: string): ParsedSemVer {
  // 移除前綴 'v'
  const clean = version.replace(/^v/, "");
  // 分離 prerelease
  const [mainPart, prePart] = clean.split("-", 2);
  const [major, minor, patch] = (mainPart || "0.0.0").split(".").map((n) => parseInt(n, 10) || 0);
  return {
    major,
    minor,
    patch,
    prerelease: prePart ?? null,
  };
}

/**
 * 比較兩個 SemVer 版本
 * @returns 正數表示 a 較新，負數表示 b 較新，0 表示相等
 */
function compareSemVer(a: string, b: string): number {
  const pa = parseSemVer(a);
  const pb = parseSemVer(b);

  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;

  // 沒有 prerelease 的比有 prerelease 的新
  if (!pa.prerelease && pb.prerelease) return 1;
  if (pa.prerelease && !pb.prerelease) return -1;
  if (pa.prerelease && pb.prerelease) {
    return pa.prerelease < pb.prerelease ? -1 : pa.prerelease > pb.prerelease ? 1 : 0;
  }
  return 0;
}

// ========================
// GitHub API
// ========================

/** GitHub REST API /releases/latest 回應結構（僅取必要欄位） */
interface GitHubReleaseApiResponse {
  tag_name: string;
  name: string | null;
  prerelease: boolean;
  published_at: string | null;
  created_at: string | null;
  html_url: string;
  tarball_url: string;
}

/**
 * 取得最新 stable Release（非 prerelease）
 *
 * 使用 fetchWithRetry 支援代理 + 重試 + 鏡像。
 * 失敗時仍返回 null，但會在 console 輸出具體錯誤原因。
 */
export async function getLatestRelease(): Promise<ReleaseInfo | null> {
  const apiUrl = `${GITHUB_API_BASE}/releases/latest`;
  try {
    const resp = await fetchGithub(apiUrl, {
      timeoutMs: 30_000,
      retries: 2,
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `${GITHUB_OWNER}-${GITHUB_REPO}-updater`,
      },
    });

    if (!resp.ok) {
      console.warn(`[updater] GitHub API 返回 HTTP ${resp.status}`);
      return null;
    }

    const data = await resp.json() as GitHubReleaseApiResponse;
    return {
      tag: data.tag_name,
      name: data.name || data.tag_name,
      prerelease: data.prerelease ?? false,
      publishedAt: data.published_at || data.created_at || "",
      htmlUrl: data.html_url,
      tarballUrl: data.tarball_url,
    };
  } catch (err) {
    console.warn(`[updater] GitHub API 請求失敗：${(err as Error).message}`);
    return null;
  }
}

// ========================
// 公開 API
// ========================

/**
 * 取得當前版本資訊
 */
export function getCurrentVersion(): VersionInfo {
  if (!isGitRepo()) {
    // Fallback: git 不可用時（tarball 安裝、Docker），從 package.json 讀版本
    try {
      const pkg = JSON.parse(
        readFileSync(join(process.cwd(), "package.json"), "utf-8"),
      );
      return { hash: "unknown", date: "", message: "", tag: `v${pkg.version}` };
    } catch {
      return { hash: "unknown", date: "", message: "", tag: null };
    }
  }
  return parseVersionInfo("HEAD");
}

/**
 * 檢查是否有更新可用
 *
 * 同時透過 GitHub Releases API 取得最新版本資訊，
 * 以及 git fetch 取得落後的 commit 數量。
 */
export async function fetchAndCheckUpdate(): Promise<UpdateCheckResult> {
  const current = getCurrentVersion();

  // Step 1: 透過 GitHub API 取得最新 Release
  const latestRelease = await getLatestRelease();

  // Step 2: Git fetch 取得遠端最新狀態
  let commitsBehind = 0;
  let newCommits: string[] = [];
  let gitHasUpdate = false;
  let gitFetchError: string | null = null;

  if (isGitRepo()) {
    try {
      execGit(["fetch", "origin", "main"]);

      const currentFull = execGit(["rev-parse", "HEAD"]);
      const latestFull = execGit(["rev-parse", "origin/main"]);
      gitHasUpdate = currentFull !== latestFull;

      if (gitHasUpdate) {
        const logOutput = execGit([
          "log", "--oneline", "--no-decorate",
          "HEAD..origin/main",
        ]);
        if (logOutput) {
          newCommits = logOutput.split("\n").filter(Boolean);
          commitsBehind = newCommits.length;
        }
      }
    } catch (err) {
      // git fetch 失敗（網路問題），記錄原因供診斷
      gitFetchError = `git fetch 失敗：${(err as Error).message}`;
      console.warn(`[updater] ${gitFetchError}`);
    }
  }

  // Step 3: 判斷是否有更新
  let hasUpdate = gitHasUpdate;

  // 如果 GitHub API 顯示有更新的 tag 版本，也算有更新
  if (latestRelease && current.tag) {
    if (compareSemVer(latestRelease.tag, current.tag) > 0) {
      hasUpdate = true;
    }
  } else if (latestRelease && !current.tag) {
    // 當前沒有 tag，但有 GitHub Release → 有更新
    hasUpdate = true;
  }

  // 組裝 networkError：如果 GitHub API 和 git fetch 都失敗
  let networkError: string | null = null;
  if (!latestRelease && gitFetchError) {
    networkError = `GitHub API 和 git fetch 均失敗。${gitFetchError}`;
  } else if (!latestRelease) {
    networkError = "GitHub API 請求失敗（詳見日誌）";
  } else if (gitFetchError) {
    networkError = gitFetchError;
  }

  return {
    hasUpdate,
    current,
    latestRelease,
    commitsBehind,
    newCommits,
    networkError,
  };
}

/**
 * 檢查工作目錄是否乾淨（沒有未提交的更改）
 */
export function isWorkingDirClean(): boolean {
  if (!isGitRepo()) return true;
  const status = execGit(["status", "--porcelain"]);
  return status.length === 0;
}

// ========================
// Blue-Green 更新核心函數
// ========================

/**
 * 下載 tarball 並解壓到暫存目錄
 *
 * GitHub tarball 結構：owner-repo-hash/nodejs/{src,dist,web,...}
 * 提取 nodejs/ 子目錄內容到 staging 根目錄。
 */
async function downloadAndExtract(
  tarballUrl: string,
  stagingDir: string,
): Promise<void> {
  // 清理舊的暫存目錄
  if (existsSync(stagingDir)) {
    rmSync(stagingDir, { recursive: true, force: true });
  }
  mkdirSync(stagingDir, { recursive: true });

  const tmpDir = join(stagingDir, ".tmp");
  mkdirSync(tmpDir, { recursive: true });

  // Step 1: 下載 tarball（使用代理 + 重試 + 自動鏡像 fallback）
  console.log(`[updater] 正在下載 ${tarballUrl}...`);
  const resp = await fetchGithub(tarballUrl, {
    timeoutMs: 180_000 * TIMEOUT_MULT,
    retries: 2,
    headers: { "User-Agent": `${GITHUB_OWNER}-${GITHUB_REPO}-updater` },
  });
  if (!resp.ok) {
    throw new Error(`下載失敗：HTTP ${resp.status}`);
  }
  // 流式下載到磁碟（避免將整個 tarball 載入記憶體）
  const tarballPath = join(tmpDir, "release.tar.gz");
  if (resp.body) {
    await pipeline(resp.body, createWriteStream(tarballPath));
  } else {
    // fallback：某些環境 resp.body 為 null（如 undici 邊界情況）
    const buf = Buffer.from(await resp.arrayBuffer());
    writeFileSync(tarballPath, buf);
  }

  // Step 2: 解壓縮
  console.log("[updater] 正在解壓縮...");
  execFileSync("tar", ["-xzf", tarballPath, "-C", tmpDir], {
    timeout: 60_000 * TIMEOUT_MULT,
    stdio: "inherit",
  });

  // Step 3: 找到解壓後的根目錄（owner-repo-hash/）
  const extractedName = readdirSync(tmpDir).find(
    (d) => d !== "release.tar.gz" && existsSync(join(tmpDir, d)),
  );
  if (!extractedName) {
    throw new Error("解壓縮失敗：找不到解壓目錄");
  }
  const extractedRoot = join(tmpDir, extractedName);

  // Step 4: 找到 nodejs/ 子目錄
  let sourceDir = extractedRoot;
  const nodejsPath = join(extractedRoot, "nodejs");
  if (existsSync(nodejsPath)) {
    sourceDir = nodejsPath;
  }

  // Step 5: 將需要的項目移動到 staging 根目錄（同檔案系統 = renameSync 原子操作）
  // 跳過 data/、.env、node_modules/、.git、tests（這些不從 tarball 覆蓋/部署）
  for (const entry of readdirSync(sourceDir)) {
    if (!shouldStageItem(entry)) continue;
    renameSync(join(sourceDir, entry), join(stagingDir, entry));
  }

  // 清理暫存解壓目錄
  rmSync(tmpDir, { recursive: true, force: true });
}

/**
 * 原子交換：當前 → 備份，暫存 → 當前
 *
 * Phase 1: 當前 SWAP_ITEMS → .backup-{timestamp}/
 * Phase 2: 暫存 SWAP_ITEMS → 當前目錄
 *
 * Phase 2 失敗時嘗試回滾。
 */
function atomicSwap(stagingDir: string): string {
  const cwd = process.cwd();
  const timestamp = Date.now();
  const backupDir = `${BACKUP_PREFIX}${timestamp}`;
  const backupPath = join(cwd, backupDir);
  mkdirSync(backupPath, { recursive: true });

  // Phase 1: 當前 → 備份
  console.log(`[updater] Phase 1：備份當前版本到 ${backupDir}/...`);
  const movedToBackup: string[] = [];
  for (const item of SWAP_ITEMS) {
    const currentPath = join(cwd, item);
    if (existsSync(currentPath)) {
      try {
        renameSync(currentPath, join(backupPath, item));
        movedToBackup.push(item);
      } catch (e) {
        console.warn(`[updater] 無法備份 ${item}：${(e as Error).message}`);
      }
    }
  }

  // Phase 2: 暫存 → 當前
  console.log("[updater] Phase 2：部署新版本...");
  const movedToCurrent: string[] = [];
  for (const item of SWAP_ITEMS) {
    const stagingPath = join(stagingDir, item);
    if (existsSync(stagingPath)) {
      try {
        renameSync(stagingPath, join(cwd, item));
        movedToCurrent.push(item);
      } catch (e) {
        console.error(`[updater] 無法部署 ${item}：${(e as Error).message}`);
        // 嘗試回滾
        console.error("[updater] 嘗試回滾...");
        for (const restored of movedToCurrent) {
          try {
            renameSync(join(cwd, restored), join(stagingDir, restored));
          } catch { /* ignore */ }
        }
        for (const backed of movedToBackup) {
          try {
            renameSync(join(backupPath, backed), join(cwd, backed));
          } catch { /* ignore */ }
        }
        rmSync(backupPath, { recursive: true, force: true });
        throw new Error(`原子交換失敗：無法部署 ${item}`);
      }
    }
  }

  // 清理空的暫存目錄
  try {
    rmSync(stagingDir, { recursive: true, force: true });
  } catch { /* ignore */ }

  return backupDir;
}

/**
 * 清理舊備份，只保留最新的指定數量
 */
function cleanOldBackups(maxBackups = MAX_BACKUPS): void {
  const cwd = process.cwd();
  try {
    const entries = readdirSync(cwd);
    const backups = entries
      .filter((d) => d.startsWith(BACKUP_PREFIX))
      .map((name) => {
        const tsStr = name.slice(BACKUP_PREFIX.length);
        const timestamp = parseInt(tsStr, 10);
        return { name, timestamp: isNaN(timestamp) ? 0 : timestamp };
      })
      .sort((a, b) => b.timestamp - a.timestamp);

    for (let i = maxBackups; i < backups.length; i++) {
      console.log(`[updater] 清理舊備份：${backups[i].name}`);
      rmSync(join(cwd, backups[i].name), { recursive: true, force: true });
    }
  } catch { /* ignore */ }
}

function prepareUpdateWorkspace(cwd: string, stagingPath: string): void {
  try {
    rmSync(stagingPath, { recursive: true, force: true });
  } catch { /* ignore */ }

  // 低容量環境先只保留最新一份備份，避免舊備份卡住更新暫存空間。
  cleanOldBackups(1);

  const diskCheck = checkUpdateDiskSpace(cwd);
  if (!diskCheck.ok) {
    throw new Error(diskCheck.message ?? buildNoSpaceErrorMessage(diskCheck.info));
  }
}

/** 偵測錯誤是否為 OOM（記憶體不足被系統終止） */
function isOOMError(err: any): boolean {
  return err?.signal === "SIGKILL" ||
    String(err?.message ?? "").includes("Killed") ||
    String(err?.stderr ?? "").includes("Killed");
}

/** npm registry 備用鏡像列表（主源失敗時按順序嘗試） */
const NPM_REGISTRY_FALLBACKS = [
  "https://registry.npmmirror.com", // 淘寶 npm 鏡像
];

/**
 * 記憶體受限環境的 npm 環境變數（限制 V8 堆疊 + 關閉非必要功能）
 *
 * 同時自動注入代理和 registry 鏡像，解決容器中 npm install 卡住問題：
 *   - NPM_REGISTRY：自定義 registry（如 https://registry.npmmirror.com）
 *   - HTTPS_PROXY / HTTP_PROXY → npm_config_https_proxy / npm_config_proxy
 *
 * @param registryOverride 強制使用的 registry（用於 fallback 重試）
 */
function buildNpmEnv(registryOverride?: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--max-old-space-size=${OPTIMAL_HEAP}`]
      .filter(Boolean).join(" "),
    // 低資源環境限制 npm 並發下載數，避免記憶體/CPU 突刺
    npm_config_maxsockets: "2",
  };

  // Registry：override > NPM_REGISTRY env > npm 預設
  const registry = registryOverride ?? process.env.NPM_REGISTRY;
  if (registry) {
    env.npm_config_registry = registry;
  }

  // 代理：npm 使用 npm_config_* 前綴讀取代理設定
  const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const httpProxy = process.env.HTTP_PROXY || process.env.http_proxy;
  if (httpsProxy && !env.npm_config_https_proxy) {
    env.npm_config_https_proxy = httpsProxy;
  }
  if (httpProxy && !env.npm_config_proxy) {
    env.npm_config_proxy = httpProxy;
  }

  return env;
}

/**
 * 判斷錯誤是否為網路/超時問題（值得用備用 registry 重試）
 */
function isNpmNetworkError(err: any): boolean {
  if (isOOMError(err)) return false; // OOM 不是網路問題
  const msg = String(err?.message ?? "").toLowerCase();
  return msg.includes("timeout") ||
    msg.includes("etimedout") ||
    msg.includes("enotfound") ||
    msg.includes("econnrefused") ||
    msg.includes("econnreset") ||
    msg.includes("eai_again") ||
    msg.includes("network");
}

/**
 * 在指定目錄執行 npm install/ci，針對低記憶體容器優化
 *
 * 策略：
 *   1. npm ci（更快更省記憶體）→ 失敗回退 npm install → OOM 偵測
 *   2. 網路失敗時自動切換到備用 registry 鏡像重試
 */
function runNpmInstall(cwd: string, timeoutMs = 180_000 * TIMEOUT_MULT): void {
  const hasLockfile = existsSync(join(cwd, "package-lock.json"));
  const flags = ["--no-audit", "--no-fund", "--prefer-offline"];

  /** 嘗試用指定 registry 執行 npm ci/install */
  function tryInstall(env: Record<string, string | undefined>): void {
    try {
      if (hasLockfile) {
        execFileSync("npm", ["ci", ...flags], {
          cwd, timeout: timeoutMs, stdio: "inherit", env,
        });
      } else {
        execFileSync("npm", ["install", ...flags], {
          cwd, timeout: timeoutMs, stdio: "inherit", env,
        });
      }
    } catch (err: any) {
      // npm ci 失敗（lockfile 不同步等）→ 回退到 npm install
      if (hasLockfile && !isOOMError(err)) {
        console.warn("[updater] npm ci 失敗，回退到 npm install...");
        execFileSync("npm", ["install", ...flags], {
          cwd, timeout: timeoutMs, stdio: "inherit", env,
        });
        return;
      }
      throw err; // 重新拋出，由外層判斷是否切 registry
    }
  }

  // 主源：NPM_REGISTRY 環境變數或 npm 預設
  const primaryEnv = buildNpmEnv();
  const primaryLabel = process.env.NPM_REGISTRY ?? "registry.npmjs.org（預設）";

  try {
    console.log(`[updater] npm install（registry: ${primaryLabel}）`);
    tryInstall(primaryEnv);
    return;
  } catch (err: any) {
    // OOM 不是網路問題，直接報錯
    if (isOOMError(err)) {
      throw new Error(
        "npm install 因記憶體不足被系統終止 (OOM Kill)。請增加容器記憶體限制（建議 ≥512MB）。",
      );
    }

    // 非網路錯誤（如 lockfile 問題）→ 直接報錯
    if (!isNpmNetworkError(err)) {
      throw new Error(`npm install 失敗：${err.message}`);
    }

    // 網路錯誤 → 嘗試備用 registry
    console.warn(`[updater] npm install 失敗（網路問題）：${err.message}`);
  }

  // Fallback：逐一嘗試備用 registry 鏡像
  for (const mirror of NPM_REGISTRY_FALLBACKS) {
    // 用戶自訂的 NPM_REGISTRY 如果就是這個鏡像，跳過
    if (process.env.NPM_REGISTRY === mirror) continue;

    try {
      console.log(`[updater] 重試 npm install（registry: ${mirror}）`);
      const env = buildNpmEnv(mirror);
      tryInstall(env);
      console.log(`[updater] ✓ npm install 成功（使用 ${mirror}）`);
      return;
    } catch (err: any) {
      if (isOOMError(err)) {
        throw new Error(
          "npm install 因記憶體不足被系統終止 (OOM Kill)。請增加容器記憶體限制（建議 ≥512MB）。",
        );
      }
      console.warn(`[updater] ${mirror} 也失敗了：${err.message}`);
    }
  }

  // 所有 registry 都失敗
  throw new Error(
    `npm install 失敗：所有 registry（包括 ${NPM_REGISTRY_FALLBACKS.length} 個備用鏡像）都無法連接。\n` +
    "請檢查網路或手動設定 NPM_REGISTRY / HTTPS_PROXY 環境變數。",
  );
}

function pruneDevDependencies(cwd: string, timeoutMs = 120_000 * TIMEOUT_MULT): void {
  if (!existsSync(join(cwd, "node_modules"))) return;

  try {
    console.log("[updater] npm prune --omit=dev（移除 staging devDependencies）");
    execFileSync("npm", ["prune", "--omit=dev", "--no-audit", "--no-fund"], {
      cwd,
      timeout: timeoutMs,
      stdio: "inherit",
      env: buildNpmEnv(),
    });
  } catch (err: any) {
    if (isNoSpaceError(err)) throw err;
    console.warn(`[updater] npm prune --omit=dev 失敗，保留完整 node_modules：${err.message}`);
  }
}

/** 進度回調型別 — 用於向調用方報告更新進度 */
export type ProgressCallback = (step: string) => void;

/**
 * 執行 Blue-Green 更新
 *
 * 流程：下載 → npm install → npm run build → 驗證 → 原子交換 → 清理
 */
export async function performBlueGreenUpdate(
  tarballUrl: string,
  onProgress?: ProgressCallback,
): Promise<UpdateResult> {
  const cwd = process.cwd();
  const stagingPath = join(cwd, STAGING_DIR);

  try {
    // Step 0: 清理舊暫存/過舊備份並檢查磁碟空間
    onProgress?.("🧹 正在清理舊暫存並檢查磁碟空間...");
    prepareUpdateWorkspace(cwd, stagingPath);

    // Step 1: 下載並解壓
    onProgress?.("📥 正在下載新版本...");
    await downloadAndExtract(tarballUrl, stagingPath);
    console.log("[updater] 下載解壓完成");

    // Step 2: npm install（在暫存目錄中）— 記憶體優化
    onProgress?.("📦 正在安裝依賴（這可能需要幾分鐘）...");
    console.log("[updater] 正在安裝依賴 (npm install)...");
    runNpmInstall(stagingPath);

    // Step 3: 判斷啟動模式
    const tsxMode = isTsxWatchMode();
    console.log(`[updater] 啟動模式：${tsxMode ? "tsx watch" : "production"}`);

    // Step 4: npm run build
    // production 模式必須成功編譯（dist/index.js）；tsx watch 模式不需要 dist/
    onProgress?.("🔨 正在編譯程式碼...");
    console.log("[updater] 正在編譯 (npm run build)...");
    let buildFailed = false;
    try {
      execFileSync("npm", ["run", "build"], {
        cwd: stagingPath,
        timeout: 120_000 * TIMEOUT_MULT,
        stdio: "inherit",
        env: buildNpmEnv(),
      });
    } catch {
      buildFailed = true;
      if (tsxMode) {
        console.warn("[updater] 編譯失敗（tsx watch 模式，可忽略）");
      } else {
        throw new Error(
          "編譯失敗：production 模式（node dist/）需要 dist/，無法繼續",
        );
      }
    }

    // Step 5: build 完成後移除 staging devDependencies，降低部署與備份體積
    onProgress?.("🧹 正在移除暫存 devDependencies...");
    pruneDevDependencies(stagingPath);

    // Step 6: 驗證 — production 必須有 dist/index.js；tsx 模式必須有 src/index.ts
    const hasDist = existsSync(join(stagingPath, "dist", "index.js"));
    const hasSrc = existsSync(join(stagingPath, "src", "index.ts"));
    const hasNodeModules = existsSync(join(stagingPath, "node_modules"));
    const entryOk = tsxMode ? hasSrc : hasDist;
    if (!hasNodeModules || !entryOk) {
      throw new Error(
        `驗證失敗：node_modules=${hasNodeModules}, ${tsxMode ? "src" : "dist"}=${entryOk}, buildFailed=${buildFailed}`,
      );
    }
    console.log("[updater] 驗證通過");

    // Step 7: 原子交換
    onProgress?.("🔄 正在切換版本...");
    const backupName = atomicSwap(stagingPath);
    console.log(`[updater] 交換完成，備份：${backupName}`);

    // Step 8: 清理舊備份
    cleanOldBackups();

    return {
      success: true,
      message: `Blue-Green 更新成功！`,
      method: "blue-green",
    };
  } catch (err: any) {
    // 清理暫存目錄
    try {
      rmSync(stagingPath, { recursive: true, force: true });
    } catch { /* ignore */ }
    const message = isNoSpaceError(err)
      ? buildNoSpaceErrorMessage(getDiskSpaceInfo(cwd))
      : err.message;
    return {
      success: false,
      message: `Blue-Green 更新失敗：${message}`,
    };
  }
}

/**
 * 執行更新（Blue-Green 方式）
 */
export async function performUpdate(
  onProgress?: ProgressCallback,
): Promise<UpdateResult> {
  const release = await getLatestRelease();
  const tarballUrl = release?.tarballUrl ?? `${GITHUB_API_BASE}/tarball/main`;
  return performBlueGreenUpdate(tarballUrl, onProgress);
}

/**
 * 偵測是否運行在容器中
 */
function isContainer(): boolean {
  // 環境變數明確指定
  if (process.env.CONTAINER !== undefined)
    return process.env.CONTAINER === "true";
  // /.dockerenv 存在表示 Docker 容器
  return existsSync("/.dockerenv");
}

/**
 * 偵測是否運行在 tsx watch 模式
 */
function isTsxWatchMode(): boolean {
  const argvStr = process.argv.slice(1).join(" ");
  return (
    (argvStr.includes("tsx") && argvStr.includes("watch")) ||
    process.env.TSX_WATCH === "true"
  );
}

/**
 * 重啟進程
 *
 * 分三種模式處理：
 *   1. tsx watch 模式：觸發 entry file 的 mtime 變化，tsx watcher 會自動重啟
 *   2. 容器模式：直接退出進程，依賴容器編排器（Docker restart policy / k8s）自動重啟
 *   3. 生產模式（node dist/...）：spawn 新進程（detached），然後 exit 舊進程
 *
 * 延遲時間確保 Telegram 訊息能先送達。
 */
export function restartProcess(delayMs = 2000): void {
  console.log(`[updater] 將在 ${delayMs}ms 後重啟...`);

  setTimeout(() => {
    // 關閉資料庫（所有模式都需要）
    try {
      closeDb();
    } catch (e) {
      console.error("[updater] 關閉資料庫失敗：", e);
    }

    const tsxMode = isTsxWatchMode();
    const container = isContainer();

    if (tsxMode) {
      // tsx watch 模式：觸發 file change 讓 watcher 自動重啟
      console.log("[updater] tsx watch 模式：觸發 watcher 重啟...");
      try {
        const entryFile = process.argv[process.argv.length - 1];
        const now = new Date();
        utimesSync(entryFile, now, now);
      } catch (e) {
        console.error("[updater] 觸發 watcher 重啟失敗，直接退出：", e);
      }
      console.log("[updater] 舊進程正在退出...");
      process.exit(0);
      return;
    }

    if (container) {
      // 容器模式：直接退出，依賴容器編排器自動重啟
      // （detached spawn 在容器中不可靠，因為 PID 1 退出後整個容器終止）
      console.log("[updater] 容器模式：退出進程，等待容器自動重啟...");
      process.exit(0);
      return;
    }

    // 生產模式（非容器）：spawn 新的 detached 進程
    console.log("[updater] 正在啟動新進程...");
    // 確保新進程也帶有 V8 heap 限制（即使當前進程是直接 node 啟動而非 start.js）
    const childEnv = { ...process.env };
    childEnv.NODE_OPTIONS = [
      process.env.NODE_OPTIONS,
      `--max-old-space-size=${OPTIMAL_HEAP}`,
    ]
      .filter(Boolean)
      .join(" ");
    const child = spawn(
      process.execPath,
      process.argv.slice(1),
      {
        detached: true,
        stdio: "inherit",
        cwd: process.cwd(),
        env: childEnv,
      } satisfies SpawnOptions,
    );
    child.unref();

    console.log("[updater] 舊進程正在退出...");
    process.exit(0);
  }, delayMs);
}

/**
 * 取得備份列表（按時間倒序）
 */
export function getBackupList(): BackupInfo[] {
  const cwd = process.cwd();
  try {
    return readdirSync(cwd)
      .filter((d) => d.startsWith(BACKUP_PREFIX))
      .map((name) => {
        const tsStr = name.slice(BACKUP_PREFIX.length);
        const timestamp = parseInt(tsStr, 10);
        return {
          name,
          timestamp: isNaN(timestamp) ? 0 : timestamp,
          createdAt: new Date(isNaN(timestamp) ? 0 : timestamp),
        };
      })
      .sort((a, b) => b.timestamp - a.timestamp);
  } catch {
    return [];
  }
}

/**
 * 回滾到最近的備份
 *
 * 當前版本保存為 pre-rollback 備份，最近備份還原為當前。
 */
export function performRollback(): { success: boolean; message: string } {
  const cwd = process.cwd();
  const backups = getBackupList();
  if (backups.length === 0) {
    return { success: false, message: "沒有可用的備份" };
  }

  const target = backups[0];
  const targetPath = join(cwd, target.name);

  // 當前版本 → pre-rollback 備份
  const rollbackTs = Date.now();
  const preRollbackDir = `${BACKUP_PREFIX}pre-rollback-${rollbackTs}`;
  const preRollbackPath = join(cwd, preRollbackDir);
  mkdirSync(preRollbackPath, { recursive: true });

  for (const item of SWAP_ITEMS) {
    const currentPath = join(cwd, item);
    if (existsSync(currentPath)) {
      try {
        renameSync(currentPath, join(preRollbackPath, item));
      } catch { /* ignore */ }
    }
  }

  // 從備份還原
  for (const item of SWAP_ITEMS) {
    const backupItemPath = join(targetPath, item);
    if (existsSync(backupItemPath)) {
      try {
        renameSync(backupItemPath, join(cwd, item));
      } catch (e) {
        console.error(`[updater] 無法還原 ${item}：${(e as Error).message}`);
      }
    }
  }

  // 清理已用完的備份目錄
  try {
    rmSync(targetPath, { recursive: true, force: true });
  } catch { /* ignore */ }

  cleanOldBackups();

  return {
    success: true,
    message: `已回滾到備份（${target.createdAt.toLocaleString("zh-TW")}）`,
  };
}

/**
 * 回滾並重啟
 */
export function rollbackAndRestart(): { success: boolean; message: string } {
  const result = performRollback();
  if (result.success) {
    restartProcess(2000);
  }
  return result;
}

/**
 * 更新並重啟
 */
export async function updateAndRestart(
  onProgress?: ProgressCallback,
): Promise<UpdateResult> {
  const result = await performUpdate(onProgress);
  if (result.success) {
    restartProcess(2000);
  }
  return result;
}

/**
 * 執行更新系統連通性診斷（供 /update 失敗時呼叫）。
 *
 * 測試 GitHub API、tarball 下載、git fetch 三個環節，
 * 並返回具體錯誤和建議。
 */
export async function runConnectivityDiagnosis() {
  return diagnoseConnectivity(
    `${GITHUB_API_BASE}/releases/latest`,
    `${GITHUB_API_BASE}/tarball/main`,
  );
}

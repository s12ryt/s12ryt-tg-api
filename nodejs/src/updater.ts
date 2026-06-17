/**
 * 程式內置更新模組
 *
 * 功能：
 *   - 透過 GitHub Releases API 查詢最新版本
 *   - 執行更新：git pull（主要）→ tarball 下載（備援）
 *   - 自動重啟進程
 */

import { spawn, execSync, execFileSync, type SpawnOptions } from "node:child_process";
import {
  utimesSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { closeDb } from "./db/database.js";

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
  "src", "dist", "web", "tests", "scripts",
  "node_modules", "package.json", "package-lock.json", "tsconfig.json",
] as const;

/** 暫存目錄名稱（新版本在此下載、安裝、編譯） */
const STAGING_DIR = ".staging";

/** 備份目錄前綴（舊版本保存於此，用於回滾） */
const BACKUP_PREFIX = ".backup-";

/** 最大保留備份數量 */
const MAX_BACKUPS = 2;

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
    const result = execSync(`git ${args.join(" ")}`, {
      cwd: process.cwd(),
      encoding: "utf-8",
      timeout: 30_000,
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
 * 如果沒有 stable release，回傳 null
 */
export async function getLatestRelease(): Promise<ReleaseInfo | null> {
  try {
    const resp = await fetch(`${GITHUB_API_BASE}/releases/latest`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `${GITHUB_OWNER}-${GITHUB_REPO}-updater`,
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) return null;

    const data = await resp.json() as GitHubReleaseApiResponse;
    return {
      tag: data.tag_name,
      name: data.name || data.tag_name,
      prerelease: data.prerelease ?? false,
      publishedAt: data.published_at || data.created_at || "",
      htmlUrl: data.html_url,
      tarballUrl: data.tarball_url,
    };
  } catch {
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
    } catch {
      // git fetch 失敗（網路問題），但 GitHub API 可能成功
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

  return {
    hasUpdate,
    current,
    latestRelease,
    commitsBehind,
    newCommits,
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

  // Step 1: 下載 tarball
  console.log(`[updater] 正在下載 ${tarballUrl}...`);
  const resp = await fetch(tarballUrl, {
    headers: { "User-Agent": `${GITHUB_OWNER}-${GITHUB_REPO}-updater` },
    signal: AbortSignal.timeout(120_000),
  });
  if (!resp.ok) {
    throw new Error(`下載失敗：HTTP ${resp.status}`);
  }
  const buffer = Buffer.from(await resp.arrayBuffer());
  const tarballPath = join(tmpDir, "release.tar.gz");
  writeFileSync(tarballPath, buffer);

  // Step 2: 解壓縮
  console.log("[updater] 正在解壓縮...");
  execSync(`tar -xzf "${tarballPath}" -C "${tmpDir}"`, {
    timeout: 60_000,
    stdio: ["pipe", "pipe", "pipe"],
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
  // 跳過 data/、.env、node_modules/、.git（這些不從 tarball 覆蓋）
  const skipItems = new Set(["data", ".env", "node_modules", ".git"]);
  for (const entry of readdirSync(sourceDir)) {
    if (skipItems.has(entry)) continue;
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
 * 清理舊備份，只保留最新的 MAX_BACKUPS 個
 */
function cleanOldBackups(): void {
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

    for (let i = MAX_BACKUPS; i < backups.length; i++) {
      console.log(`[updater] 清理舊備份：${backups[i].name}`);
      rmSync(join(cwd, backups[i].name), { recursive: true, force: true });
    }
  } catch { /* ignore */ }
}

/** 偵測錯誤是否為 OOM（記憶體不足被系統終止） */
function isOOMError(err: any): boolean {
  return err?.signal === "SIGKILL" ||
    String(err?.message ?? "").includes("Killed") ||
    String(err?.stderr ?? "").includes("Killed");
}

/** 記憶體受限環境的 npm 環境變數（限制 V8 堆疊 + 關閉非必要功能） */
function buildNpmEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, "--max-old-space-size=384"]
      .filter(Boolean).join(" "),
  };
}

/**
 * 在指定目錄執行 npm install/ci，針對低記憶體容器優化
 *
 * 策略：npm ci（更快更省記憶體）→ 失敗回退 npm install → OOM 偵測
 */
function runNpmInstall(cwd: string, timeoutMs = 180_000): void {
  const env = buildNpmEnv();
  const hasLockfile = existsSync(join(cwd, "package-lock.json"));
  const flags = ["--no-audit", "--no-fund", "--prefer-offline"];

  try {
    // 優先使用 npm ci（跳過依賴解析，更快更省記憶體）
    if (hasLockfile) {
      execFileSync("npm", ["ci", ...flags], {
        cwd, timeout: timeoutMs, stdio: ["pipe", "pipe", "pipe"], env,
      });
    } else {
      execFileSync("npm", ["install", ...flags], {
        cwd, timeout: timeoutMs, stdio: ["pipe", "pipe", "pipe"], env,
      });
    }
  } catch (err: any) {
    // npm ci 失敗（lockfile 不同步等）→ 回退到 npm install
    if (hasLockfile && !isOOMError(err)) {
      console.warn("[updater] npm ci 失敗，回退到 npm install...");
      execFileSync("npm", ["install", ...flags], {
        cwd, timeout: timeoutMs, stdio: ["pipe", "pipe", "pipe"], env,
      });
      return;
    }
    // OOM 或 npm install 也失敗 → 清晰的錯誤訊息
    throw new Error(
      isOOMError(err)
        ? "npm install 因記憶體不足被系統終止 (OOM Kill)。請增加容器記憶體限制（建議 ≥512MB）。"
        : `npm install 失敗：${err.message}`,
    );
  }
}

/**
 * 執行 Blue-Green 更新
 *
 * 流程：下載 → npm install → npm run build → 驗證 → 原子交換 → 清理
 */
export async function performBlueGreenUpdate(
  tarballUrl: string,
): Promise<UpdateResult> {
  const cwd = process.cwd();
  const stagingPath = join(cwd, STAGING_DIR);

  try {
    // Step 1: 下載並解壓
    await downloadAndExtract(tarballUrl, stagingPath);
    console.log("[updater] 下載解壓完成");

    // Step 2: npm install（在暫存目錄中）— 記憶體優化
    console.log("[updater] 正在安裝依賴 (npm install)...");
    runNpmInstall(stagingPath);

    // Step 3: 判斷啟動模式
    const tsxMode = isTsxWatchMode();
    console.log(`[updater] 啟動模式：${tsxMode ? "tsx watch" : "production"}`);

    // Step 4: npm run build
    // production 模式必須成功編譯（dist/index.js）；tsx watch 模式不需要 dist/
    console.log("[updater] 正在編譯 (npm run build)...");
    let buildFailed = false;
    try {
      execFileSync("npm", ["run", "build"], {
        cwd: stagingPath,
        timeout: 120_000,
        stdio: ["pipe", "pipe", "pipe"],
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

    // Step 5: 驗證 — production 必須有 dist/index.js；tsx 模式必須有 src/index.ts
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

    // Step 6: 原子交換
    const backupName = atomicSwap(stagingPath);
    console.log(`[updater] 交換完成，備份：${backupName}`);

    // Step 7: 清理舊備份
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
    return {
      success: false,
      message: `Blue-Green 更新失敗：${err.message}`,
    };
  }
}

/**
 * 執行更新（Blue-Green 方式）
 */
export async function performUpdate(): Promise<UpdateResult> {
  const release = await getLatestRelease();
  const tarballUrl = release?.tarballUrl ?? `${GITHUB_API_BASE}/tarball/main`;
  return performBlueGreenUpdate(tarballUrl);
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
    const child = spawn(
      process.execPath,
      process.argv.slice(1),
      {
        detached: true,
        stdio: "inherit",
        cwd: process.cwd(),
        env: process.env,
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
export async function updateAndRestart(): Promise<UpdateResult> {
  const result = await performUpdate();
  if (result.success) {
    restartProcess(2000);
  }
  return result;
}

/**
 * 程式內置更新模組
 *
 * 功能：
 *   - 透過 GitHub Releases API 查詢最新版本
 *   - 執行更新：git pull（主要）→ tarball 下載（備援）
 *   - 自動重啟進程
 */

import { spawn, execSync, type SpawnOptions } from "node:child_process";
import {
  utimesSync,
  writeFileSync,
  existsSync,
  readdirSync,
  cpSync,
  rmSync,
  mkdtempSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "./db/database.js";

// ========================
// 常數
// ========================

const GITHUB_OWNER = "s12ryt";
const GITHUB_REPO = "s12ryt-tg-api";
const GITHUB_API_BASE = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`;

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
  /** 更新方式：git 或 tarball */
  method?: "git" | "tarball";
  /** 更新後的 commit hash */
  newHash?: string;
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

    const data = await resp.json() as any;
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
    return { hash: "unknown", date: "", message: "", tag: null };
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

/**
 * 方法 1：透過 git pull 更新
 */
function updateViaGit(): UpdateResult {
  try {
    if (!isGitRepo()) {
      return { success: false, message: "不是 git 倉庫，無法使用 git pull。" };
    }
    if (!isWorkingDirClean()) {
      return {
        success: false,
        message: "工作目錄有未提交的更改，請先處理後再更新。",
      };
    }
    execGit(["pull", "origin", "main"]);
    const newHash = execGit(["rev-parse", "--short", "HEAD"]);
    return {
      success: true,
      message: `git pull 更新成功！新版本：${newHash}`,
      method: "git",
      newHash,
    };
  } catch (err: any) {
    return { success: false, message: `git pull 失敗：${err.message}` };
  }
}

/**
 * 方法 2：透過下載 Release tarball 更新（備援方案）
 *
 * 下載 GitHub tarball → 解壓 → 複製原始碼（保留 data/ 目錄）
 */
async function updateViaTarball(tarballUrl: string): Promise<UpdateResult> {
  const tempDir = mkdtempSync(join(tmpdir(), "s12ryt-update-"));

  try {
    // Step 1: 下載 tarball
    const resp = await fetch(tarballUrl, {
      headers: { "User-Agent": `${GITHUB_OWNER}-${GITHUB_REPO}-updater` },
      signal: AbortSignal.timeout(60_000),
    });
    if (!resp.ok) {
      throw new Error(`下載失敗：HTTP ${resp.status}`);
    }
    const buffer = Buffer.from(await resp.arrayBuffer());
    const tarballPath = join(tempDir, "release.tar.gz");
    writeFileSync(tarballPath, buffer);

    // Step 2: 解壓縮
    execSync(`tar -xzf "${tarballPath}" -C "${tempDir}"`, {
      timeout: 30_000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Step 3: 找到解壓後的目錄（GitHub tarball 會解壓為 owner-repo-hash/）
    const extractedName = readdirSync(tempDir).find(
      (d) => d !== "release.tar.gz" && existsSync(join(tempDir, d)),
    );
    if (!extractedName) {
      throw new Error("解壓縮失敗：找不到解壓目錄");
    }
    const extractedPath = join(tempDir, extractedName);

    // Step 4: 複製檔案，保留 data/ 目錄
    const cwd = process.cwd();
    const entries = readdirSync(extractedPath);
    for (const entry of entries) {
      const srcPath = join(extractedPath, entry);
      const destPath = join(cwd, entry);

      if (entry === "nodejs" || entry === "python") {
        // 這些目錄包含 data/ 子目錄，需要謹慎複製
        syncDirPreservingData(srcPath, destPath);
      } else if (entry === ".git" || entry === "data") {
        // 跳過 .git 和根層 data 目錄
        continue;
      } else {
        // 其他檔案/目錄：直接替換
        if (existsSync(destPath)) {
          rmSync(destPath, { recursive: true, force: true });
        }
        cpSync(srcPath, destPath, { recursive: true });
      }
    }

    // Step 5: 取得新版本資訊
    let newHash = "unknown";
    try {
      newHash = execGit(["rev-parse", "--short", "HEAD"]);
    } catch {
      // 非 git 倉庫也沒關係
    }

    return {
      success: true,
      message: `Tarball 下載更新成功！`,
      method: "tarball",
      newHash,
    };
  } catch (err: any) {
    return { success: false, message: `Tarball 更新失敗：${err.message}` };
  } finally {
    // 清理暫存目錄
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
}

/**
 * 複製目錄內容，但保留 data/ 子目錄
 */
function syncDirPreservingData(src: string, dest: string): void {
  const entries = readdirSync(src);
  for (const entry of entries) {
    if (entry === "data") continue; // 保留 data/ 目錄
    if (entry === "node_modules") continue; // 保留 node_modules/

    const srcPath = join(src, entry);
    const destPath = join(dest, entry);

    if (existsSync(destPath)) {
      rmSync(destPath, { recursive: true, force: true });
    }
    cpSync(srcPath, destPath, { recursive: true });
  }
}

/**
 * 執行更新：先嘗試 git pull，失敗則下載 tarball
 */
export async function performUpdate(): Promise<UpdateResult> {
  // 方法 1: git pull
  const gitResult = updateViaGit();
  if (gitResult.success) return gitResult;

  console.warn(`[updater] git pull 失敗，嘗試 tarball 下載...`);

  // 方法 2: tarball 下載
  // 取得最新 Release 的 tarball URL
  const release = await getLatestRelease();
  if (release) {
    const tarballResult = await updateViaTarball(release.tarballUrl);
    if (tarballResult.success) return tarballResult;

    return {
      success: false,
      message: `兩種更新方式都失敗。\ngit: ${gitResult.message}\ntarball: ${tarballResult.message}`,
    };
  }

  // 沒有 Release 可用，嘗試下載 main 分支的 tarball
  try {
    const branchTarballUrl = `${GITHUB_API_BASE}/tarball/main`;
    const tarballResult = await updateViaTarball(branchTarballUrl);
    if (tarballResult.success) return tarballResult;

    return {
      success: false,
      message: `兩種更新方式都失敗。\ngit: ${gitResult.message}\ntarball: ${tarballResult.message}`,
    };
  } catch (err: any) {
    return {
      success: false,
      message: `兩種更新方式都失敗。\ngit: ${gitResult.message}\ntarball: ${err.message}`,
    };
  }
}

/**
 * 重啟進程
 *
 * 分兩種模式處理：
 *   1. tsx watch 模式：觸發 entry file 的 mtime 變化，tsx watcher 會自動重啟
 *   2. 生產模式（node dist/...）：spawn 新進程（detached），然後 exit 舊進程
 *
 * 延遲時間確保 Telegram 訊息能先送達。
 */
export function restartProcess(delayMs = 2000): void {
  console.log(`[updater] 將在 ${delayMs}ms 後重啟...`);

  setTimeout(() => {
    const argvStr = process.argv.slice(1).join(" ");
    const isWatch =
      (argvStr.includes("tsx") && argvStr.includes("watch")) ||
      process.env.TSX_WATCH === "true";

    // 關閉資料庫（兩種模式都需要）
    try {
      closeDb();
    } catch (e) {
      console.error("[updater] 關閉資料庫失敗：", e);
    }

    if (isWatch) {
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

    // 生產模式：spawn 新的 detached 進程
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
 * 更新並重啟
 */
export async function updateAndRestart(): Promise<UpdateResult> {
  const result = await performUpdate();
  if (result.success) {
    restartProcess(2000);
  }
  return result;
}

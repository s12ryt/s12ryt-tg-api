/**
 * 一鍵發版腳本
 *
 * 用法：
 *   npm run release -- patch          # 1.2.0 → 1.2.1
 *   npm run release -- minor          # 1.2.0 → 1.3.0
 *   npm run release -- major          # 1.2.0 → 2.0.0
 *   npm run release -- patch --dry-run  # 預覽，不執行 git 操作
 *
 * 功能：
 *   1. 從 git tag 讀取當前版本號
 *   2. 根據參數計算下一版（patch/minor/major）
 *   3. 解析自上次 tag 以來的 conventional commits，自動分類生成 changelog
 *   4. 更新 package.json + VERSION 檔案
 *   5. 更新 CHANGELOG.md（前置新版本段落）
 *   6. git commit + tag + push（tag annotation 帶 changelog 供 CI 使用）
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

// ─── 路徑常數 ──────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const NODEJS_DIR = join(__dirname, "..");
const REPO_ROOT = join(NODEJS_DIR, "..");

// ─── Git 輔助 ──────────────────────────────────────────────

function git(args: string[], cwd = REPO_ROOT): string {
  return execSync(`git ${args.join(" ")}`, {
    cwd,
    encoding: "utf-8",
    timeout: 30_000,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function gitOrEmpty(args: string[], cwd = REPO_ROOT): string {
  try {
    return git(args, cwd);
  } catch {
    return "";
  }
}

// ─── SemVer ────────────────────────────────────────────────

interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

function parseSemVer(version: string): SemVer {
  const clean = version.replace(/^v/, "");
  const [major, minor, patch] = clean.split(".").map((n) => parseInt(n, 10) || 0);
  return { major, minor, patch };
}

function bumpVersion(v: SemVer, level: "patch" | "minor" | "major"): SemVer {
  switch (level) {
    case "major":
      return { major: v.major + 1, minor: 0, patch: 0 };
    case "minor":
      return { major: v.major, minor: v.minor + 1, patch: 0 };
    case "patch":
      return { major: v.major, minor: v.minor, patch: v.patch + 1 };
  }
}

function versionString(v: SemVer): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

// ─── Conventional Commits 解析 ─────────────────────────────

interface CommitEntry {
  hash: string;
  type: string;        // feat, fix, docs, refactor, perf, test, chore, ci, style, build, other
  scope: string | null;
  breaking: boolean;
  description: string;
}

interface ChangelogSections {
  breaking: string[];
  features: string[];
  fixes: string[];
  perf: string[];
  refactor: string[];
  docs: string[];
  test: string[];
  ci: string[];
  other: string[];
}

/** 從 git log 取得自上次 tag 以來的 commit 列表 */
function getCommitsSinceTag(lastTag: string): CommitEntry[] {
  // 格式: %H%x09%s  → hash<TAB>subject
  const range = lastTag ? `${lastTag}..HEAD` : "HEAD~30..HEAD";
  const raw = gitOrEmpty(["log", range, "--pretty=format:%h%x09%s", "--no-merges"]);
  if (!raw) return [];

  const commits: CommitEntry[] = [];
  for (const line of raw.split("\n")) {
    const [hash, ...subjectParts] = line.split("\t");
    const subject = subjectParts.join("\t");
    if (!hash || !subject) continue;

    // 跳過 release commits（由本腳本產生）
    if (subject.startsWith("release:") || subject.startsWith("chore(release):")) continue;

    commits.push(parseCommit(hash, subject));
  }
  return commits;
}

/** 解析單條 commit message */
function parseCommit(hash: string, subject: string): CommitEntry {
  // Pattern: type(scope)!: description  或  type!: description  或  type: description
  const match = subject.match(/^(feat|fix|docs|refactor|perf|test|chore|ci|style|build)(?:\(([^)]+)\))?(!)?:\s*(.+)$/i);
  if (!match) {
    return { hash, type: "other", scope: null, breaking: false, description: subject };
  }
  const [, typeRaw, scope, bang, desc] = match;
  return {
    hash,
    type: typeRaw.toLowerCase(),
    scope: scope || null,
    breaking: bang === "!",
    description: desc.trim(),
  };
}

/** 將 commits 分類 */
function categorizeCommits(commits: CommitEntry[]): ChangelogSections {
  const sections: ChangelogSections = {
    breaking: [],
    features: [],
    fixes: [],
    perf: [],
    refactor: [],
    docs: [],
    test: [],
    ci: [],
    other: [],
  };

  for (const c of commits) {
    const line = `- ${c.description} (${c.hash})`;
    if (c.breaking) {
      sections.breaking.push(line);
      continue;
    }
    switch (c.type) {
      case "feat":     sections.features.push(line); break;
      case "fix":      sections.fixes.push(line); break;
      case "perf":     sections.perf.push(line); break;
      case "refactor": sections.refactor.push(line); break;
      case "docs":     sections.docs.push(line); break;
      case "test":     sections.test.push(line); break;
      case "ci":       sections.ci.push(line); break;
      case "chore":
      case "style":
      case "build":
      case "other":    sections.other.push(line); break;
    }
  }
  return sections;
}

/** 生成 Markdown changelog 段落（不含標題行） */
function generateChangelogSection(sections: ChangelogSections): string {
  const parts: string[] = [];

  if (sections.breaking.length) {
    parts.push("### 💥 Breaking Changes\n" + sections.breaking.map((l) => l).join("\n"));
  }
  if (sections.features.length) {
    parts.push("### ✨ Features\n" + sections.features.join("\n"));
  }
  if (sections.fixes.length) {
    parts.push("### 🐛 Bug Fixes\n" + sections.fixes.join("\n"));
  }
  if (sections.perf.length) {
    parts.push("### ⚡ Performance\n" + sections.perf.join("\n"));
  }
  if (sections.refactor.length) {
    parts.push("### ♻️ Refactor\n" + sections.refactor.join("\n"));
  }
  if (sections.docs.length) {
    parts.push("### 📝 Documentation\n" + sections.docs.join("\n"));
  }
  if (sections.test.length) {
    parts.push("### ✅ Tests\n" + sections.test.join("\n"));
  }
  if (sections.ci.length) {
    parts.push("### 🔧 CI\n" + sections.ci.join("\n"));
  }
  if (sections.other.length) {
    parts.push("### 📦 Other\n" + sections.other.join("\n"));
  }

  if (parts.length === 0) {
    return "- 維護更新";
  }
  return parts.join("\n\n");
}

// ─── 檔案更新 ──────────────────────────────────────────────

/** 更新 package.json 版本號 */
function updatePackageJson(newVersion: string): void {
  const pkgPath = join(NODEJS_DIR, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  pkg.version = newVersion;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
}

/** 更新 VERSION 檔案（Python fallback 用） */
function updateVersionFile(newVersion: string): void {
  writeFileSync(join(REPO_ROOT, "VERSION"), newVersion + "\n", "utf-8");
}

/** 更新 CHANGELOG.md（前置新版本段落） */
function updateChangelog(version: string, date: string, sectionBody: string): void {
  const changelogPath = join(REPO_ROOT, "CHANGELOG.md");
  const header = "# Changelog\n\n所有版本變更記錄。本檔案由 `npm run release` 自動維護。\n\n";
  const newSection = `## [${version}] - ${date}\n\n${sectionBody}\n\n`;

  let existing = "";
  if (existsSync(changelogPath)) {
    existing = readFileSync(changelogPath, "utf-8");
    // 移除舊的 header（保留版本段落）
    const headerEnd = existing.indexOf("## [");
    if (headerEnd > 0) {
      existing = existing.slice(headerEnd);
    } else {
      existing = ""; // 檔案只有 header 或為空
    }
  }

  writeFileSync(changelogPath, header + newSection + existing, "utf-8");
}

// ─── 主流程 ────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const level = args.find((a) => ["patch", "minor", "major"].includes(a)) as
    | "patch"
    | "minor"
    | "major"
    | undefined;

  if (!level) {
    console.error("❌ 請指定版本級別：patch | minor | major");
    console.error("   用法：npm run release -- patch");
    console.error("   預覽：npm run release -- patch --dry-run");
    process.exit(1);
  }

  // 1. 取得當前版本
  const lastTag = gitOrEmpty(["describe", "--tags", "--abbrev=0", "HEAD"]);
  const currentVersion = lastTag
    ? parseSemVer(lastTag)
    : parseSemVer(JSON.parse(readFileSync(join(NODEJS_DIR, "package.json"), "utf-8")).version);

  // 2. 計算新版本
  const newVersion = bumpVersion(currentVersion, level);
  const newVersionStr = versionString(newVersion);
  const newTag = `v${newVersionStr}`;

  console.log(`\n🚀 Release: ${lastTag || "(init)"} → ${newTag}  (${level})`);

  if (dryRun) {
    console.log("   ⚡ DRY RUN — 不執行 git 操作\n");
  }

  // 3. 解析 commits，生成 changelog
  const commits = getCommitsSinceTag(lastTag);
  const sections = categorizeCommits(commits);
  const changelogBody = generateChangelogSection(sections);
  const today = new Date().toISOString().split("T")[0];

  console.log(`   📝 掃描到 ${commits.length} 條 commit：`);
  if (sections.breaking.length) console.log(`      💥 Breaking: ${sections.breaking.length}`);
  if (sections.features.length) console.log(`      ✨ Features: ${sections.features.length}`);
  if (sections.fixes.length)    console.log(`      🐛 Fixes:    ${sections.fixes.length}`);
  if (sections.perf.length)     console.log(`      ⚡ Perf:     ${sections.perf.length}`);
  if (sections.refactor.length) console.log(`      ♻️ Refactor: ${sections.refactor.length}`);
  if (sections.docs.length)     console.log(`      📝 Docs:     ${sections.docs.length}`);
  if (sections.other.length)    console.log(`      📦 Other:    ${sections.other.length}`);

  console.log(`\n   ── CHANGELOG 預覽 ──\n`);
  console.log(`   ## [${newVersionStr}] - ${today}\n`);
  console.log(changelogBody.split("\n").map((l) => `   ${l}`).join("\n"));
  console.log("\n");

  if (dryRun) {
    console.log("✅ Dry run 完成。加上真實參數執行實際發版。");
    return;
  }

  // 4. 更新檔案
  console.log("📦 更新檔案...");
  updatePackageJson(newVersionStr);
  updateVersionFile(newVersionStr);
  updateChangelog(newVersionStr, today, changelogBody);
  console.log("   ✅ package.json");
  console.log("   ✅ VERSION");
  console.log("   ✅ CHANGELOG.md");

  // 5. Git commit + tag + push
  console.log("\n🔖 Git 操作...");

  // Stage 所有改動
  git(["add", "-A"]);

  // Commit
  git(["commit", "-m", `release: v${newVersionStr}`]);
  console.log("   ✅ commit");

  // Annotated tag（帶 changelog）
  const tmpFile = mkdtempSync(join(tmpdir(), "release-tag-"));
  const tagMsgPath = join(tmpFile, "tagmsg.txt");
  writeFileSync(tagMsgPath, changelogBody, "utf-8");
  git(["tag", "-a", newTag, "-F", tagMsgPath]);
  rmSync(tmpFile, { recursive: true, force: true });
  console.log(`   ✅ tag ${newTag}`);

  // Push commit + tag
  git(["push", "origin", "main"]);
  git(["push", "origin", newTag]);
  console.log("   ✅ push");

  console.log(`\n🎉 發版完成！${newTag}`);
  console.log(`   GitHub Actions 將自動建立 stable Release。`);
  console.log(`   https://github.com/s12ryt/s12ryt-tg-api/releases/tag/${newTag}`);
}

main();

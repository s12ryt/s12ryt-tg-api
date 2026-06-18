/**
 * 通用啟動檔案 — 適用於無法自訂啟動指令的 Node.js 容器（如 Pterodactyl 面板）
 *
 * 使用方式：
 *   將容器的 MAIN_FILE 設為此檔案路徑（例如 "nodejs/start.js" 或 "start.js"）
 *
 * 自動偵測流程：
 *   1. 切換到此檔所在目錄為工作目錄（CWD）
 *   2. 檢查 node_modules，不存在則自動 npm install
 *   3. 偵測啟動模式：
 *      - 有 dist/index.js      → 生產模式（node dist/index.js）
 *      - 無 dist/ 但有 src/    → 嘗試 npm run build，成功走生產，失敗則 tsx 執行
 *      - 兩者都沒有            → 報錯退出
 *
 * 環境變數：
 *   FORCE_DEV=1  → 強制使用 tsx 開發模式（跳過 dist/ 偵測）
 *   SKIP_INSTALL=1 → 跳過自動 npm install
 */

import { existsSync } from "fs";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import os from "os";

// ── ESM 下 __dirname 的等價寫法 ──────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── 切換到此檔所在目錄（確保 data/ .env 等路徑正確）──────────────────────
const appDir = __dirname;
process.chdir(appDir);

const IS_WIN = process.platform === "win32";

// ── 低資源容器輔助函數 ──────────────────────────────────────────────────
function getTotalMemMB() {
  return Math.floor(os.totalmem() / 1024 / 1024);
}

function getOptimalHeapSize() {
  const override = parseInt(process.env.MAX_OLD_SPACE ?? "", 10);
  if (!isNaN(override) && override >= 64) return override;
  const totalMB = getTotalMemMB();
  // 取總記憶體 50%，限制在 [128, 512]MB
  return Math.max(128, Math.min(512, Math.floor(totalMB * 0.5)));
}

const OPTIMAL_HEAP = getOptimalHeapSize();

// 設定全域 NODE_OPTIONS — 讓所有子進程（node / npx / npm）自動繼承 V8 heap 限制。
// 這樣 spawnInherit 不傳 env 時（如 node dist/index.js），子進程也會帶上 heap flag。
process.env.NODE_OPTIONS = [
  process.env.NODE_OPTIONS,
  `--max-old-space-size=${OPTIMAL_HEAP}`,
]
  .filter(Boolean)
  .join(" ");

function buildNpmEnv() {
  const env = { ...process.env }; // 已繼承 NODE_OPTIONS（含 heap 限制）
  env.npm_config_maxsockets = "2";

  // 代理注入
  const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const httpProxy = process.env.HTTP_PROXY || process.env.http_proxy;
  if (httpsProxy && !env.npm_config_https_proxy) env.npm_config_https_proxy = httpsProxy;
  if (httpProxy && !env.npm_config_proxy) env.npm_config_proxy = httpProxy;
  const registry = process.env.NPM_REGISTRY;
  if (registry) env.npm_config_registry = registry;
  return env;
}

function log(msg) {
  console.log(`[start] ${msg}`);
}

/**
 * 啟動子進程，繼承 stdio。
 * @param {string} cmd
 * @param {string[]} args
 * @param {(code: number, signal?: string) => void} [onExit]
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 */
function spawnInherit(cmd, args, onExit, opts = {}) {
  const child = spawn(cmd, args, {
    cwd: appDir,
    stdio: "inherit",
    shell: IS_WIN,
    env: opts.env,
  });
  child.on("error", (err) => {
    console.error(`[start] 無法啟動 '${cmd}': ${err.message}`);
    process.exit(1);
  });
  if (onExit) {
    child.on("exit", (code, signal) => onExit(code ?? 1, signal));
  }
  return child;
}

// ── 步驟 1：確保依賴已安裝 ──────────────────────────────────────────────
function ensureDependencies(callback) {
  if (process.env.SKIP_INSTALL === "1") {
    callback();
    return;
  }
  if (existsSync(path.join(appDir, "node_modules"))) {
    callback();
    return;
  }
  if (!existsSync(path.join(appDir, "package.json"))) {
    console.error(`[start] 在 ${appDir} 找不到 package.json`);
    process.exit(1);
  }
  log(`node_modules 不存在，正在執行 npm install...（記憶體限制：${OPTIMAL_HEAP}MB，系統總記憶體：${getTotalMemMB()}MB）`);
  spawnInherit("npm", ["install", "--no-audit", "--no-fund", "--prefer-offline"], (code, signal) => {
    if (signal === "SIGKILL") {
      console.error(`[start] ❌ npm install 因記憶體不足被系統終止 (OOM Kill)！`);
      console.error(`[start] 系統總記憶體：${getTotalMemMB()}MB，V8 堆疊限制：${OPTIMAL_HEAP}MB`);
      console.error(`[start] 建議：增加容器記憶體限制（≥512MB），或設定 MAX_OLD_SPACE 環境變數。`);
      process.exit(1);
    }
    if (code !== 0) {
      console.error(`[start] npm install 失敗（退出碼 ${code}）`);
      process.exit(1);
    }
    log("npm install 完成。");
    callback();
  }, { env: buildNpmEnv() });
}

// ── 步驟 2：啟動應用 ────────────────────────────────────────────────────
function startApp() {
  const distEntry = path.join(appDir, "dist", "index.js");
  const srcEntry = path.join(appDir, "src", "index.ts");

  // 強制開發模式
  if (process.env.FORCE_DEV === "1" && existsSync(srcEntry)) {
    log("強制開發模式（FORCE_DEV=1）: npx tsx src/index.ts");
    spawnInherit("npx", ["tsx", srcEntry], (c) => process.exit(c));
    return;
  }

  // 生產模式 — dist/index.js 已存在
  if (existsSync(distEntry)) {
    log("生產模式: node dist/index.js");
    spawnInherit("node", [distEntry], (c) => process.exit(c));
    return;
  }

  // 找不到入口
  if (!existsSync(srcEntry)) {
    console.error(`[start] 在 ${appDir} 找不到 dist/index.js 或 src/index.ts`);
    process.exit(1);
  }

  // 有 src 但沒有 dist — 嘗試編譯
  const hasTsconfig = existsSync(path.join(appDir, "tsconfig.json"));
  if (hasTsconfig) {
    log("dist/ 不存在，嘗試 npm run build...");
    spawnInherit("npm", ["run", "build"], (code, signal) => {
      if (signal === "SIGKILL") {
        console.error(`[start] ❌ npm run build 因記憶體不足被系統終止 (OOM Kill)！`);
        console.error(`[start] 系統總記憶體：${getTotalMemMB()}MB，V8 堆疊限制：${OPTIMAL_HEAP}MB`);
        console.error(`[start] 建議：增加容器記憶體限制（≥512MB），或使用 FORCE_DEV=1 以 tsx 開發模式啟動。`);
        process.exit(1);
      }
      if (code === 0 && existsSync(distEntry)) {
        log("編譯成功，以生產模式啟動。");
        spawnInherit("node", [distEntry], (c) => process.exit(c));
      } else {
        log("編譯失敗或不完整，改用 tsx 開發模式啟動。");
        spawnInherit("npx", ["tsx", srcEntry], (c) => process.exit(c));
      }
    }, { env: buildNpmEnv() });
  } else {
    log("開發模式: npx tsx src/index.ts");
    spawnInherit("npx", ["tsx", srcEntry], (c) => process.exit(c));
  }
}

// ── 啟動 ────────────────────────────────────────────────────────────────
log(`系統資源：${getTotalMemMB()}MB 記憶體，V8 堆疊限制：${OPTIMAL_HEAP}MB`);
ensureDependencies(startApp);

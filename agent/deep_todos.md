# Deep Todos

## 2026-07-05 - 全專案盤點與 agent 文件更新

- [x] 盤點 tracked file 清單；本環境沒有 `rg`，改用 `git ls-files`、glob 與 targeted read。
- [x] 閱讀根目錄文件與部署設定：`README.md`、`CHANGELOG.md`、`VERSION`、`Dockerfile`、`docker-compose.yml`、`.dockerignore`、`.gitignore`、`.node-version`、`.nvmrc`、GitHub Actions workflows、`scripts/vps.sh`。
- [x] 閱讀 Node.js 主線設定與啟動流程：`nodejs/package.json`、`tsconfig.json`、`vitest.config.ts`、`.env.example`、`.npmrc`、`start.js`、`scripts/with-memory.mjs`、`scripts/release.ts`。
- [x] 閱讀 Node.js 主要後端模組：`src/index.ts`、`config.ts`、`memory.ts`、`net.ts`、`tunnel.ts`、`updater.ts`、`db/database.ts`。
- [x] 閱讀 API proxy 層：`server.ts`、auth/rate/quota middleware、key selector、usage tracker、Responses/Anthropic conversion、thinking parser、provider adapters、API log store。
- [x] 閱讀 Bot/Web 管理層：user/admin/limit/update/web/backup handlers、model fetcher、Web auth/routes、前端 `index.html`/`app.js`/`style.css`。
- [x] 閱讀插件系統：`plugins/types.ts`、`services.ts`、`manager.ts`、`plugin-example/` package/manifest/src/dist/README。
- [x] 閱讀 Node.js 測試分佈：API、auth、config、database、plugin manager/services、providers、quota/rate、responses、security coding、thinking parser、updater、web routes、backup/Anthropic 相關測試。
- [x] 補讀 Python 停止維護區的 `requirements.txt`、`.env.example`、`main.py`、`pytest.ini`，僅記錄歷史狀態。
- [x] 刻意不讀任何真實 `.env` 檔，避免接觸 secret。
- [x] 更新 `agent/deep_todos.md`、`agent/項目表.md`、`agent/memory.md` 作為後續接手依據。

## 2026-07-05 - Docker Compose 範例

- [x] 新增根目錄 `docker-compose.yml` 範例，預設使用 `ghcr.io/s12ryt/s12ryt-tg-api:latest`。
- [x] Compose 範例使用 `BOT_TOKEN`、`ADMIN_ID` 等 `.env` 變數，並掛載 `./nodejs/data:/app/nodejs/data` 保留資料。
- [x] 在 README 補上 Docker Compose 使用方式。
- [x] 執行 `docker compose config` 與 `git diff --check` 驗證。

## 2026-07-05 - 插件路徑載入防呆

- [x] 追查 `ERR_MODULE_NOT_FOUND` 來源，確認是 `NODEJS_PLUGIN_PATHS` 指向不存在的 `/nodejs/plugin`。
- [x] 在插件 manager 匯入前加入路徑 preflight，缺路徑、非一般檔案與錯副檔名改為 concise skip warning。
- [x] 支援目錄型插件入口解析：`plugin.json` main、`package.json` module/main、`index.mjs`、`index.js`。
- [x] 補上 `pluginManager` 回歸測試，覆蓋缺路徑、錯副檔名與目錄入口載入。
- [x] 更新 `.env.example` 與插件範例 README，說明 `NODEJS_PLUGIN_PATHS` 合法入口格式。
- [x] 執行 LSP、`npm test -- pluginManager` 與 `npm run build` 驗證。

## 2026-07-05 - Linux VPS 一鍵部署腳本

- [x] 盤點 Node.js 啟動、build、Dockerfile、`.env.example` 與部署相關檔案。
- [x] 新增 `scripts/vps.sh`，支援安裝與更新、systemd 與 docker 兩種部署模式。
- [x] 腳本支援互動填寫 `.env` 或讀取目前 shell 環境變數。
- [x] systemd 模式自動準備 Node.js 22、build 專案、建立 service，並使用非 root service user 執行。
- [x] docker 模式自動準備 Docker、pull GHCR image、重建 container，並掛載 `nodejs/data`，不再 clone 倉庫或在 VPS 上 build。
- [x] 補強 docker/systemd 分支防呆：Docker 選項改為第一項、預設資料目錄改為 `/opt/s12ryt-tg-api-docker`、`sync_repo()` 加 systemd-only guard。
- [x] README 新增 VPS 一鍵部署入口與使用方式。
- [x] 完成 shell 語法、安全與文件驗證。

## 2026-07-05 - 根 README 閱讀性重整

- [x] 盤點根 README 現有章節、快速開始、API、Bot、Web、插件、更新備份與授權資訊。
- [x] 將 README 改為先導覽、快速開始、第一次設定，再提供 API 與管理細節的閱讀順序。
- [x] 收斂過長架構與專案結構段落，改用表格與短概覽提高掃讀效率。
- [x] 保留 Python 停止維護、plugin-example 位置、獨立插件倉庫、備份還原安全等重要資訊。
- [x] 檢查連結目標與 placeholder，確認沒有真實 token 或 secret。

## 2026-07-04 - PluginContext 穩定內部服務接口

- [x] 盤點插件 manager、types、DB/provider API 與測試慣例。
- [x] 新增 `context.services`，包含 auth、storage、events、scheduler、providers、db facade。
- [x] 將插件服務注入 `PluginContext`，並在插件 shutdown 時清理事件 listener 與 timer。
- [x] 補上 `pluginServices` 測試，覆蓋 storage namespace、auth、events、scheduler、provider sanitization 與 API key preview masking。
- [x] 將 services 使用範例落在 `plugin-example/` 的 `src/index.ts`、`dist/index.js`、`plugin.json` 與 README。
- [x] 執行完整 build 與回歸測試後收尾。

## 2026-07-04 - 發布 plugin-example 獨立倉庫

- [x] 盤點 `plugin-example/` 內容與主 README。
- [x] 建立 GitHub 倉庫 `s12ryt/s12ryt-nodejs-plugin-example`。
- [x] 推送 `plugin-example/` 的 README、package、plugin manifest、dist 與 src。
- [x] 更新主 README，加入獨立插件倉庫連結。
- [x] 更新插件 README，加入主倉庫與插件倉庫連結。
- [x] 執行驗證：`npm run check` 或等效語法檢查。

## 2026-07-04 - Python 停止維護標示

- [x] 將 `python/` 目錄改名為 `python(not-supported)/`。
- [x] 在根 README 最上方標示 Python 版本已停止維護。
- [x] 更新 README 中的快速開始、工程描述、專案結構與技術棧。
- [x] 更新插件範例 README 中對 Python 版本的描述。
- [x] 執行文件搜尋驗證，確認舊 `cd python` / `python/` 路徑未殘留於 Markdown 文件。

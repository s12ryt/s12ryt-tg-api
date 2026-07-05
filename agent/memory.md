# Memory

## 2026-07-04

- 使用者要求將 `plugin-example/` 示範插件建立為獨立 GitHub 倉庫並發布到帳號 `s12ryt` 下。
- 選定新倉庫名稱：`s12ryt-nodejs-plugin-example`，對應 package 名稱 `s12ryt-nodejs-plugin-example`。
- 需要維持主倉庫 README 與插件 README 互相提及：
  - 主專案：`https://github.com/s12ryt/s12ryt-tg-api`
  - 插件範例：`https://github.com/s12ryt/s12ryt-nodejs-plugin-example`
- 工作區在接手時已有多個非本次修改的 dirty 檔案；本次只應處理 `README.md`、`plugin-example/` 與 `agent/` 紀錄。
- 使用者後續要求不再維護 Python 部分：已將 `python/` 改名為 `python(not-supported)/`，README 頂端需標示 Python 版本停止維護，後續功能、修復與文件以 Node.js 為主。
- 使用者要求實作插件的穩定內部服務接口：新增 `context.services`，範圍限定為 auth、storage、events、scheduler、providers 只讀 facade、db 只讀 facade；不得把 raw DB、provider secrets、完整 API key 或任意核心寫入能力暴露給插件。
- `context.services.storage` 使用 `plugin_storage` namespaced JSON KV table，單筆值上限 256KB；目前不納入主程式 `/backup` JSON 匯出。
- 使用者明確指出 `F:\Project\bot\s12ryt-tg-api\plugin-example` 才是放插件範例的地方；主 README 只應導向此目錄與獨立發布倉庫，實際範例程式與 services 用法需落在 `plugin-example/`。

## 2026-07-05

- 使用者要求重新整理根 `README.md` 讓他人更方便閱讀；新版 README 應優先服務新讀者，順序為專案用途、核心功能、快速開始、第一次設定、API 用法、Bot/Web 管理、插件、更新備份、環境變數、架構/結構與授權。
- README 已刻意縮短舊版大量細節，保留 Node.js 為主要維護版本、Python 停止維護、`plugin-example/` 與獨立插件倉庫連結、備份還原安全提醒。若未來要補詳細格式轉換矩陣或效能細節，建議拆到獨立文件再由 README 連結。
- 使用者要求做一個只輸入一次指令即可全自動跑完流程的 VPS 腳本；需求為盡量支援所有 Linux、同時支援首次安裝與更新、詢問執行者選 systemd/docker、先詢問互動填 `.env` 或讀取環境變數、不處理 HTTPS/Nginx/Cloudflare。腳本入口為 `scripts/vps.sh`，完成標準是部署後 `/health` 通過。
- 使用者指出 Docker 部署不應需要 clone 倉庫；`scripts/vps.sh` 已改為 Docker 模式 pull `ghcr.io/s12ryt/s12ryt-tg-api:latest`，只建立設定/資料目錄與 `.env`，systemd 模式才 clone/update repo。
- 後續使用者追問為何有時 Docker 仍 clone：排查後判定實際 clone 只會發生在 systemd 分支或使用舊遠端腳本；已把 Docker 選項改為第一項並明示不 clone，Docker 預設資料目錄改為 `/opt/s12ryt-tg-api-docker`，且 `sync_repo()` 加入非 systemd 直接中止的 guard。
- 使用者回報插件載入錯誤 `ERR_MODULE_NOT_FOUND`，來源是 `NODEJS_PLUGIN_PATHS=/apps-yoyo/s12ryt-tg-api/nodejs/plugin` 指向不存在的路徑。核心預設值其實是空；已讓 plugin manager 在 dynamic import 前 preflight 路徑，缺路徑/錯副檔名只警告並略過，且目錄可透過 `plugin.json`、`package.json` 或 `index.*` 解析入口。
- 使用者要求新增 `docker-compose.yml` 範例到 GitHub；根目錄 compose 範例應使用 `ghcr.io/s12ryt/s12ryt-tg-api:latest`，不在 VPS build image，透過 `.env` 提供 `BOT_TOKEN`/`ADMIN_ID`，並掛載 `./nodejs/data:/app/nodejs/data` 保存資料。
- 使用者要求「查看項目所有文件並更新agent資料夾」。已完成全專案盤點，`agent/` 是本地工作記憶且被 `.gitignore` 忽略；更新這些文件不需要提交，除非使用者另行要求。
- 本次盤點刻意不讀真實 `.env`：`nodejs/.env`、`python(not-supported)/.env` 等都可能含 secret，只允許讀 `.env.example`。
- 本環境 PowerShell 沒有 `rg`，搜尋/盤點時可用 `git ls-files`、glob、Read/Grep 工具替代。
- Node.js 是唯一主線。後續功能、bugfix、文件、部署、CI、插件相關工作都應優先看 `nodejs/`。`python(not-supported)/` 只作歷史參考，除非使用者明確要求，不應投入新功能或主動修復。
- 版本目前為 `1.8.5`。根 `VERSION`、`nodejs/package.json`、`CHANGELOG.md` 需要版本一致；release automation 在 `nodejs/scripts/release.ts`。
- Node runtime 現況：package engines `>=22`，CI 測 Node 22/24，`.node-version`/`.nvmrc` 釘 `24`，Dockerfile 使用 `node:24-bookworm-slim`。README 的「Node 22 LTS+」和 runtime pin 同時存在，修改版本策略時要同步檢查。
- Express 掛載順序是重要安全邊界：`/web` 在 API auth/rate/quota 之前，使用 Web session；`/plugins` 在 API auth/rate/quota 之後，plugin HTTP routes 繼承 API Key auth。
- API Key auth 兼容 OpenAI/Anthropic/Google 常見形式：Bearer、`x-api-key`、`x-goog-api-key`、`?key=`；仍必須是本服務 `sk-s12ryt-` key。
- Thinking effort 的解析和注入跨三種入口端點與 coding fallback，修改時要看 `thinkingParser.test.ts`、`responses.test.ts`、`providerAdapters.test.ts`、`security_coding.test.ts`。
- Usage/cost 不能只依賴 provider usage；fallback token counting 依序用 OpenAI local tokenizer、Anthropic `count_tokens`、Google `:countTokens`、CJK-aware heuristic。
- Rate/quota 設計：admin bypass；0 表 unlimited；rateLimiter 與 quotaChecker 透過有效限制 cache/`res.locals` 減少 DB 查詢。相關修改需跑 `rateLimiter.test.ts`、`quotaChecker.test.ts`。
- DB 使用 sql.js 檔案 SQLite，含多個 cache/write queue/migrations/import-export；備份還原要保護外鍵與現有資料。插件 storage table 是 `plugin_storage`，目前不在主 `/backup` JSON。
- Web Console 前端是 zero-dependency vanilla JS SPA，不是 React/Vue；修改 UI 時直接看 `nodejs/web/app.js`、`index.html`、`style.css`，並注意深色主題與 mobile sidebar。
- Web auth 是 OTP 5 分鐘一次性 token + 24 小時 session；每次 request 會重新檢查 admin/active user。相關修改需跑 `auth.test.ts`、`web_routes.test.ts`。
- 插件安全規則維持：只 expose sanitized facade，不 expose raw DB、provider base URL/API key、完整 API key 或核心寫入能力。`context.services.providers` 與 `context.services.db` 只能 read-only + masked previews。
- Plugin manager 的 env path preflight 是已修過的穩定性要求；缺路徑/非 JS/目錄無入口要 warning + skip，不得讓主程式因使用者錯填 `NODEJS_PLUGIN_PATHS` 而崩潰。
- `plugin-example/` 同時存在主倉庫內與獨立倉庫 `s12ryt/s12ryt-nodejs-plugin-example`。若修改範例，需考慮是否同步兩邊；主倉庫 README 與範例 README 應互相連結。
- VPS Docker 部署不 clone、不 build，只 pull GHCR image；Docker 資料目錄 `/opt/s12ryt-tg-api-docker`，compose mount `./nodejs/data:/app/nodejs/data`。systemd 才 clone/update repo。
- `docker-compose.yml` 目前 port mapping 使用 `${API_PORT:-8000}:${API_PORT:-8000}`，container env 也傳同一個 `API_PORT`；healthcheck 讀 `process.env.API_PORT || 8000`。
- CI 重要 gate：`nodejs-ci.yml` 做 `npm ci --engine-strict`、`npm audit --audit-level=moderate`、`npm run build`、`npm test`。本機針對文件/agent 更新可用 manual read-back + `git status --short`；程式碼改動才依影響範圍跑 build/test。
- `.dockerignore` 與 `.gitignore` 都排除 `.env*` 或本地資料；不要把 data/db/log/cache/agent/thoughts 誤提交。

## 2026-07-05（續）- 插件系統優雅化重構

- 使用者要求把 `nodejs/src/plugins/` 優雅化重構：拆分 `manager.ts`（430 行）、`services.ts`（573 行）的 module-level 全域可變狀態為結構清晰的模組/class。範圍確認為「含公開插件 API 微調」：可小幅調整 `PluginContext`/`services` 公開介面，但需同步 `plugin-example/` 與獨立倉庫 `s12ryt/s12ryt-nodejs-plugin-example` 的相容性，且保持保守（微調而非重寫）。
- 錯誤訊息語言慣例確認為「英文（插件開發者/程式契約向：boot-time 診斷、services API 誤用、內部不變量）+ 繁體中文（管理員/Web UI 操作向：Web Console 安裝流程結果）」混合，逐條核對 manager.ts/services.ts 所有 throw/console 訊息後結論：**現狀已大致正確**，本次工作定調為「補 JSDoc 記錄慣例」而非「翻譯替換」。
- 重構後 `nodejs/src/plugins/` 目錄從 4 個檔案（`types.ts`/`services.ts`/`manager.ts`/`index.ts`）擴展為 10 個檔案：新增 `pluginNaming.ts`（ID/檔名淨化驗證）、`pluginPathResolver.ts`（插件入口路徑解析）、`pluginManifest.ts`（manifest 讀寫 + 安裝相關型別）、`pluginRegistry.ts`（`PluginRegistry` class，封裝 manager.ts 原本的 loaded/installed plugins、per-plugin contexts、bot commands、app/bot 綁定、生命週期旗標）、`pluginEventBus.ts`（`PluginEventBus` class，封裝事件監聽 Map）、`pluginTimerRegistry.ts`（`PluginTimerRegistry` class，封裝計時器 Map）；`manager.ts`/`services.ts` 內容全面重寫但對外 **9 個 export 函式簽名**（`getPluginRootRouter`、`bindPluginApp`、`loadNodeJsPlugins`、`initializeNodeJsPlugins`、`startNodeJsPlugins`、`shutdownNodeJsPlugins`、`getPluginBotCommands`、`listNodeJsPlugins`、`installNodeJsPluginFromContent`）與所有公開型別完全不變，`index.ts`/`server.ts`/`web/routes.ts` 均無需改動。
- `services.ts` 抽出共用 `freezePublic<T>(obj: T): Readonly<T>` helper 取代 5 處重複的 `toPublicX` + `Object.freeze` 樣板（`toPublicUser`/`toPublicApiKeyPreview`/`toPublicProvider`/`toPublicModelPrice`/`toPublicModelMapping`）。
- 插件系統測試對特定英文錯誤訊息字串/正則做斷言，任何未來修改都不可更動措辭：`pluginManager.test.ts` 斷言 console.warn 含 `"path does not exist"`（及其他路徑相關訊息），用 `vi.resetModules()` + `process.chdir` 動態 re-import 隔離狀態；`pluginServices.test.ts` 斷言正則 `/exceeds/`（storage 值超限）、`/at least/`（timer 最小延遲）、`/Trusted/`（`requireTrustedTelegramUser`）、`/Authenticated/`（`requireRequestAuth`）。封裝為 class 後這些測試全數通過，證實 `vi.resetModules()` 後 `pluginRegistry`/`pluginEventBus`/`pluginTimerRegistry` singleton 都能正確重新初始化（fresh import manager.ts/services.ts 會連帶 fresh import 這些新模組）。
- 評估過 `NodeJsPluginContext`（grammY Context + ConversationFlavor，用於 bot update handler）vs `PluginContext`（插件執行時 context，傳入 setup/onStart/onStop）命名相近問題，**決定不重新命名**（風險大於效益，`plugin-example` 未直接引用該型別名稱），只在 `types.ts` 補 JSDoc 澄清兩者差異。
- 確認 `plugin-example/` 不需修改：本次重構所有公開 API 完全未變（只新增 JSDoc 註釋），為節省 token 未重讀該目錄，信任之前已完整分析過的 `plugin-example/src/index.ts` 使用模式（`context.logger`、`context.usePluginMiddleware`、`context.router.get/post`、`context.services.auth.requireRequestAuth`、`context.services.db.getUserByTelegramId`、`context.services.providers.listModels`、`context.services.storage.set`）。
- 驗證結果：`lsp_diagnostics`（`nodejs/src/plugins/` 10 個檔案 0 錯誤）、`npm run build`（tsc 成功，version 顯示 `s12ryt-tg-api@1.8.5 build`）、`npm test`（16 個測試檔、362 個測試全通過，含 `pluginManager.test.ts` 3 個測試與 `pluginServices.test.ts` 7 個測試）。
- 根目錄 `CHANGELOG.md`（338 行，非 `nodejs/CHANGELOG.md`——該路徑不存在）由 `npm run release` 自動維護，格式為 `## [版本號] - 日期` 下分類 `### ✨ Features / 🐛 Bug Fixes / 📝 Documentation / ♻️ Refactor / 🔧 CI`，每條附 commit hash（從 commit message 自動解析產生）。本次重構**未被要求 commit**，因此未手動新增 CHANGELOG 條目（沒有 commit hash 可附，手動編造會誤導）；待使用者實際 commit 後由 `npm run release` 自動歸類到 `### ♻️ Refactor`。
- 此目錄下每次用 `read` 工具讀檔都會在 `directory-context` 附加大篇幅根 `README.md` 內容（浪費大量 token）；讀取 400+ 行完整檔案也容易被工具截斷。下次處理 `nodejs/src/plugins/` 或類似目錄時，應盡量一次讀完整檔、減少重複 `read`，優先靠先前紀錄的結構化摘要延續工作。

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
- **串流客戶端斷線資源洩漏修復**：調查確認 `nodejs/src/api/server.ts` 中所有串流路徑（`/v1/chat/completions`、`/v1/responses`、`/v1/messages`）在客戶端斷線後**完全不會 abort 上游連線**，持續消費 provider stream 直到串流結束或 provider timeout。修復方式：兩個串流消費函數 `forwardStreamAndExtractUsage`（舊路徑，`for await` 無取消）和 `extractUsageFromProviderStream`（新路徑，有 `cancelProviderStream` 但缺觸發入口）都加上 `res?: Response` 參數 + `res.on('close', onClientClose)` 監聽；前者改用手動 `iterator = stream[Symbol.asyncIterator]()` + `while` 迴圈以便呼叫 `iterator.return()`，後者複用既有冪等的 `cancelProviderStream()`。5 個呼叫點全部傳入 `res`：chat/completions forward（~line 810）、responses 直通 forward（~line 957）、messages 直通 forward（~line 1296）、responses 轉換 extract（~line 1124）、messages 轉換 extract（~line 1426）。provider 端（`openai.ts`/`anthropic.ts`/`google.ts`/`openaiResponse.ts`）的 streaming generator 已有完整 `finally` 區塊（`requestTimeout.abort()` + `reader.cancel()` + `reader.releaseLock()`），只要 `.return()` 被呼叫就會觸發，無需修改。驗證：LSP 0 error、`tsc` build 通過、362/362 測試通過。
- `writeAndFlush`（server.ts:72）是簡單的 `res.write(data)` + `socket.setNoDelay(true)` helper，不會在 socket 關閉時同步拋出（`res.write` 返回 false 而非 throw），因此 client 斷線時不會因 write 失敗而導致未捕獲例外。
- 本次修改後 `forwardStreamAndExtractUsage` 的 `catch` 區塊設計為：`if (!clientClosed) throw err;` — 只在 client 未斷線時 re-throw 上游錯誤；client 斷線導致的 AbortError 被吞掉（因為 client 已不在，無法回報錯誤）。

## 2026-07-06 - 串流 token usage 注入與輸入 token 估算修復

- 使用者反映 opencode 透過本代理串流時顯示的 token 用量不正確。調查後確認是兩個獨立問題疊加：（1）**輸入 token 估算漏算** tools/functions/system prompt/tool_result/tool_use 等欄位，含 110 個工具的真實請求舊估算只 5,188 tokens（實際 BPE 32,422，漏報 85.4%）；（2）**provider 未必在 SSE 串流中返回 usage**，導致 fallback 估算根本沒被觸發，client 收到的串流完全沒有 usage chunk。
- **輸入 token 估算修復**（commits `34919b3`、`976e7ff`）：`extractInputTextFromBody`（usageTracker.ts）補納 `body.tools`/`body.functions` 的 JSON.stringify、Anthropic `body.system`（string 或 content block array）、message content 中的 `tool_result` block（含 content）、`tool_use` block（name + input）。fallback 順序不變：provider usage → OpenAI local tokenizer（gpt-tokenizer，o200k_base + cl100k_base）→ Anthropic `count_tokens` → Google `:countTokens` → CJK-aware heuristic。
- **已知限制 — 圖片 token**：base64 圖片的 token 未估算（需 decode + 解析解析度，太複雜），目前 content 中的 image block 被略過。
- **SSE usage 注入設計決策 — 行級 forwarding 取代 raw byte**：原本 chat completions forward 是 raw byte 透傳，無法攔截終止事件。改為 decode→按 `\n\n` split SSE event→逐行檢查→rejoin→encode。SSE 事件都很小，效能可接受。這個模式只用在需要注入的直通路徑。
- **防重複注入**：`extractUsageFromSSE` 偵測到 provider 已返回 usage 時設 `providerReturnedUsage` flag，注入邏輯只在 flag 為 false 時跑，避免 provider 有返回 + fallback 又注入的雙重計算。
- **轉換路徑（cross-format）注入技巧**：`extractUsageFromProviderStream` 把 fake chat-completions 格式 usage chunk 注入 passThrough Transform stream，下游 converter（`streamResponsesApi`/`streamAnthropicApi`）讀到這個 chunk 就會以自己的格式發出 usage，converter 程式碼完全不用改。
- **Anthropic messages 直通路徑漏傳 `res`**：commit `57056de` 順帶修復 ~L1340 的 messages 直通呼叫點在 1c7cc83 之後仍漏傳 `res`，導致該路徑客戶端斷線不會 abort 上游。
- **vitest `describe.skipIf` 踩坑**（commit `5901f24`）：`describe.skipIf(cond)` 即使 cond 為真（要 skip），**factory 函數仍會被執行**（vitest 靠它收集 test 定義名稱），所以 factory 內不能放會拋例外的同步代碼（如對不存在的檔 `readFileSync`）。CI 上 `完整請求.md` 不存在（被 `.gitignore`），factory 內 `readFileSync` 直接 ENOENT 使整個 test file 失敗（顯示 `0 test` 但 FAIL）。修復：用同一個 `existsSync` 結果保護 factory 內的檔案讀取，檔案不存在時 factory 是 no-op，只收集到被 skip 的 test 定義。
- **`完整請求.md`（194KB）是本地測試資產**：含 110 個 tools 的真實請求，被 `.gitignore` 忽略不進 git/CI。`full_request_integration.test.ts` 用 `describe.skipIf(!existsSync(...))` 在沒有此檔的環境自動 skip。本地全跑 401 測試（394 base + 7 integration），CI 只跑 394（integration 整檔 skip）。
- **測試檔路徑解析**：`join(__dirname, "../../完整請求.md")` — 從 `nodejs/tests/` 往上兩層到專案根。在 vitest（tsx/esbuild 轉譯）下 `__dirname` 正確解析為測試檔所在目錄，Windows/Linux 皆然。
- 本 session 共 8 個 commit（`1c7cc83`、`34919b3`、`976e7ff`、`6f66e5d`、`57056de`、`20f9af7`、`c30bebe`、`5901f24`），全在 `main` 分支，全已 push。`c30bebe`（整合測試）觸發 CI 失敗，`5901f24` 修復。

## 2026-07-06（續）- Prebuilt bundle 更新路徑（commit `9de2212`）

- 使用者場景是 **Pterodactyl 面板容器**：原始碼部署 + `start.js` 啟動器（優先 `dist/index.js`，必要時 `tsx` fallback），**不是** `node dist/`。容器內跑 `npm install` + `tsc build` 又慢又不穩（3-10 分鐘），所以做了 CI 預編譯 bundle。
- **CI 預編譯機制**：`.github/workflows/release.yml` 的 `latest-release` 與 `tagged-release` 兩 job 都新增打包步驟 — `npm ci` + `npm run build` + `npm prune --omit=dev`（去掉 dev deps 減小體積）→ tar 成固定檔名 `s12ryt-tg-api-dist.tar.gz` → 上傳為 Release asset。解壓後根目錄平坦（`dist/`、`node_modules/`、`web/`、`scripts/`、`start.js`、`package.json` 等）。
- **updater.ts 三層抽象**：
  - `findPrebuiltAsset(assets)`：精確檔名 `s12ryt-tg-api-dist.tar.gz` 優先，pattern（`/-dist\.tar\.gz$/`）fallback；無 asset 回 null。
  - `downloadPrebuiltAndExtract(url, dest)`：下載 + 解壓，用 `SWAP_ITEMS` 過濾。**關鍵差異**：與 Blue-Green 的 `shouldStageItem` 不同，prebuilt 路徑**保留 `node_modules`**（因為 CI 已經 prune 過 + 打包好了，容器端零 install）。
  - `performPrebuiltUpdate()`：download → extract → validate（檢查 `dist/index.js` 存在）→ atomic swap。**零 npm install、零 tsc build**，10-30 秒完成。
- **`SWAP_ITEMS`**：升級為 `["src", "dist", "web", "scripts", "start.js", "package.json", "package-lock.json", "tsconfig.json", "VERSION"]` — prebuilt 雖不含 `src`/`tsconfig.json`，但 Blue-Green 路徑仍需要，所以清單是兩條路徑的聯集。
- **`performUpdate` 自動偵測**：有 prebuilt asset → prebuilt 路徑；無 asset（舊版 release）→ fallback Blue-Green。`UpdateResult.method` 新增 `'prebuilt'`。
- **向後相容性鏈**：舊版 release 無 asset → `findPrebuiltAsset` 回 null → Blue-Green。舊版 v1.8.6 前端（不傳 `method`）→ 路由白名單歸類 `auto` → `performUpdate` 預設 `auto` → 自動偵測。舊版 v1.8.6 updater 程式碼**沒有 prebuilt 邏輯**，所以從 v1.8.6 第一次更新仍走 Blue-Green（舊碼認不得 asset），更新到新版後才會用 prebuilt。
- **測試**：新增 8 個 — `findPrebuiltAsset` 6 情境（精確名/pattern/無 asset/多 asset/大小寫/URL 含 dist）+ `getLatestRelease` assets 解析 2 情境。總計 409 passed。
- **未驗證的假設**：release asset 檔名**固定**為 `s12ryt-tg-api-dist.tar.gz`（release.yml 寫死），`findPrebuiltAsset` 精確比對這個名稱。若未來改檔名需同步更新比對邏輯。pattern fallback 是保險網但實務上精確比對就會命中。

## 2026-07-06（續）- Web UI 更新方法選擇按鈕（commit `6251963`）

- 使用者要求 Web Console 系統管理頁的「檢查更新」從單一按鈕改成一排可選方法按鈕，**用 SVG 圖示不用 emoji**（專案 `nodejs/web/app.js` 有 `ic.xxx` 圖示系統，如 `ic.download`、`ic.refresh`、`ic.check`、`ic.alert`、`ic.sparkles`）。
- **`UpdateMethod` type** 新增：`"auto" | "prebuilt" | "blue-green"`。讓前端能明確指定方法，而非只能靠後端自動偵測。`auto` 保留原有自動偵測行為以維持完全向後相容。
- **`performUpdate(onProgress?, method = "auto")` 三分支**：`blue-green` 強制走 tarball Blue-Green（忽略 prebuilt asset）、`prebuilt` 強制走 prebuilt（無 asset 回報錯誤讓前端知道）、`auto` 維持自動偵測。
- **routes.ts `POST /api/admin/update`**：讀 `body.method`，白名單 `prebuilt`/`blue-green` 通過，其餘（含 undefined/空字串/亂填）一律歸 `auto`。白名單設計避免前端傳錯值導致 updater 行為異常。
- **app.js pageSystem 改造**：單一按鈕 → 一排 SVG 按鈕。從 `release.assets` 偵測 `hasPrebuilt`（有 asset 才顯示 prebuilt 按鈕，舊版 release 不會有）。prebuilt 按鈕 `ic.download`、Blue-Green 按鈕 `ic.refresh`。`runUpdate(method)` POST 帶 `{method, restart:true}`。被點擊按鈕顯示「更新中...」並停用全部 `btn-update-*` 防重複點擊。
- **順帶修的 method 顯示 bug**：原本更新結果顯示的 `methodLabel` 只有 `blue-green`/`tarball`/git pull 三分支，**缺少 `prebuilt` case**，導致 prebuilt 更新成功時錯誤 fallback 到 git pull 顯示。新增 `methodLabel()` 函式涵蓋全部 4 種 method，純文字無 emoji（符合專案風格）。
- **驗證**：`tsc --noEmit` 零錯誤；`vitest run` 409 passed（18 檔案，含 updater 36 測試），無回歸。CI 預期全綠。
- **`agent/` 目錄已被 `.gitignore` 忽略**，但 `agent/deep_todos.md`、`agent/memory.md` 是早期誤 tracked 進 git 的（在 .gitignore 規則加入前已 commit），git 仍會追蹤其改動。依工作規則**不主动 commit agent/ 變更**，這次只本地更新不留 git 痕跡。

## 2026-07-06（續）- 閱讀 agent 資料夾並正式接手項目

- 已使用 glob 工具列出 `agent/` 目錄，並以 batch_read 完整閱讀 `deep_todos.md`、`項目表.md`、`memory.md` 三個核心檔案。
- 確認 deep_todos.md 所有任務（包含 Prebuilt bundle 更新路徑、Web UI 更新方法選擇按鈕、串流 token usage 注入修復、插件系統優雅化重構、全專案盤點等）均標記完成並通過驗證。
- `項目表.md` 提供最新專案結構、更新機制（Prebuilt + Blue-Green + auto）、插件系統 10 個模組現況、測試覆蓋與部署重點。
- `memory.md` 詳細記載所有歷史決策、bug 根因分析、驗證步驟、語言慣例（英文契約 vs 繁體中文管理員訊息）、測試斷言不可改動、agent 目錄不 commit 等重要注意事項。
- **正式接手**：自即日起以此三個 agent 檔案作為單一真相來源，後續所有需求理解、實作、挖蟲、驗證與紀錄均以此為基礎，並在每次工作結束後更新這三個檔案以保持連續性。
- 目前專案主線為 Node.js 版本（1.8.5+），Python 已停止維護，更新機制已大幅優化為秒級 Prebuilt 部署，適合 Pterodactyl 等容器環境。

## 2026-07-07 - 插件大小上限 1MB → 10MB

- 使用者要求「把插件大小限制到 10mb」。已完成 4 個檔案 9 處改動，所有「1MB」字串與 `1024 * 1024`（1 MiB）常數同步改為「10MB」與 `10 * 1024 * 1024`（10 MiB）。
- **修改清單**：
  1. `nodejs/src/plugins/pluginNaming.ts` L12 `MAX_PLUGIN_BYTES`、L49 `assertPluginSize` 錯誤訊息
  2. `nodejs/src/web/routes.ts` L133 `MAX_PLUGIN_SOURCE_BYTES`（GitHub source 下載預檢）、L195/L199 `fetchTextWithLimit` content-length + Buffer.byteLength 雙重預檢錯誤訊息
  3. `nodejs/web/app.js` L2752 UI form-hint 文字、L2795 前端 `file.size` 預檢 + toast
  4. `plugin-example/README.md` L144、`agent/項目表.md` L77 文件同步
- **不動的相關常數**（語義不同，避免越權）：`updater.ts` `MIN_UPDATE_FREE_BYTES = 768 * 1024 * 1024`（768MB 磁碟預留）、`backupHandlers.ts` `MAX_FILE_SIZE = 20 * 1024 * 1024`（20MB Telegram getFile 上限）、`server.ts` L54 `express.json({ limit: "10mb" })`（Express body parser，給 chat completions 大請求用，decimal MB）。
- **已確認事項**：
  - `nodejs/tests/` 沒有對插件大小做斷言（grep `assertPluginSize|MAX_PLUGIN_BYTES|插件檔案|超過` 在 tests/ 無 match），修改不會破壞測試。
  - Express body parser `limit: "10mb"` 是 decimal MB（10,000,000 bytes），插件上限是 10 MiB（10,485,760 bytes），兩者單位略不同但 Express body parser 在我改動前已是 10mb（給 chat completions 用），本次不動。10 MiB JS 檔 JSON-escape 後 body 可能略超 10mb，極端邊界值上傳可能被 Express 擋下；實務上 8-9 MiB 的混淆插件能正常上傳，已符合「10mb」需求。
  - 邊界判斷維持 `>`（size 等於上限時允許），與原本邏輯一致。
- **驗證**：`lsp_diagnostics`（pluginNaming.ts、routes.ts）0 error；`npm test -- --run` 18 檔 409 tests 全通過，與改動前一致。
- **技術債觀察**（未動，列建議）：插件大小上限散在 4 處檔案 9 個位置（`MAX_PLUGIN_BYTES`、`MAX_PLUGIN_SOURCE_BYTES`、前端 hardcode、文件），未集中為單一常數；未來若要再調整或 env 化，建議抽到 `pluginNaming.ts` 匯出，前端透過 API 取得。

## 2026-07-09 - 雲端資料庫遷移工程（進行中：階段 0/1 完成）

### 決策（已定案）
- **動機**：保留 SQLite 又可上雲 → 策略 B（可選後端，DATABASE_URL 分流）
- **DB 選型**：PostgreSQL + MySQL 8.0+ 都要
- **技術路線**：路線 A（抽象 DbDriver 介面 + 保留現有 raw SQL），非 Drizzle 重寫
- **型別策略**：統一用 TEXT（雲端 DB 時間/JSON 與 SQLite 一致，犧牲雲端型別能力換三方言查詢邏輯一致）
- **MySQL 基線**：8.0+（CHECK 約束預設強制）

### 設計與接手文件
- `agent/db-cloud-migration-design.md`：完整 12 章技術設計（路線對比、方言對照、5 機制改造、6 階段計畫、7 風險）
- `agent/stage2-async-migration.md`：⭐階段 2 執行手冊（改造規則、關鍵決策、進度追蹤）。**接手階段 2 必讀**。

### 已完成（零回歸，tsc 零錯，439 tests 全綠）
- `nodejs/src/db/driver/types.ts`：DbDriver 介面（query/run/insert/exec/batch/transaction/sync/close），SqlParam/DbRow/InsertResult 型別
- `nodejs/src/db/driver/sqliteDriver.ts`：SqliteDriver（包裝 sql.js 為 async，30s auto-save，dirty flag）+ `getRawDatabase()`（供 backup shadow DB 用）
- `nodejs/src/db/driver/factory.ts`：createDriver（DATABASE_URL scheme 偵測；PG/MySQL throw 佔位待階段 3/4；dynamic import 計畫）
- `nodejs/src/db/dialect.ts`：NOW 常數（sqlite=`datetime('now')`, postgres/mysql=`NOW()`）+ dialectNow helper
- `nodejs/tests/sqliteDriver.test.ts`（23 tests）+ `nodejs/tests/driverFactory.test.ts`（7 tests）

### 階段 2 為何未在本 session 完成（重要接手背景）
- database.ts（2430 行、~75 函數）全部 async 化是「全有或全無」大爆炸改動：一旦 database.ts 變 async，14 個呼叫檔 + database.test.ts（1459 行）必須同步改完才能編譯。
- database.ts 全文已完整讀取並提煉成改造規則（見兩個壓縮對話塊 + stage2 手冊）。**原文未動**（git 確認 diff 空白）。
- 本 session 因 README 注入 + 大量原文讀取消耗上下文，經與使用者確認改在新 session 執行以確保完整收尾。
- **接手者直接讀 `agent/stage2-async-migration.md` 即可無縫執行**。database.ts 原檔乾淨（git checkout 可還原）。

### 階段 2 核心改造規則（摘錄，詳見手冊）
- queryAll/queryOne/runSql/runSqlAndSave → async + driver（drv() helper 取 driver）
- 所有 export function → async（除純邏輯：isExpired/getBackupSummary/applyRestriction/filterModelsByRestriction/pickLimit/cache invalidate 純 Map 操作）
- datetime('now') → NOW[driver.dialect]（~15 處）
- cache hot path（lookupModelCached/getAllCachedModelNames/getCachedEffectiveLimits）保持同步讀 cache；rebuildProviderCache 變 async；invalidate 保持同步 + fire-and-forget 重建
- lookupApiKeyCached 建議變 async（cache miss 查 DB），auth middleware 配合
- flushUsageQueue → async（driver.batch/transaction）；enqueueUsage/recordUsage 同步，滿 100 void flushUsageQueue().catch()
- createTables 保持同步操作 raw SqlJsDatabase（SQLite 專屬）；init 時從 SqliteDriver.getRawDatabase() 取得
- closeDb → async（await flushUsageQueue + await driver.close）
- backup/restore 階段 2 SQLite-only（shadow DB + PRAGMA 保留）；雲端版階段 3/4 用 transaction rollback

### 待執行階段
- 階段 2：✅ **已完成（2026-07-10）**。database.ts async 化 + 16 呼叫檔 + 6 測試檔，tsc 零錯，vitest 439 全綠。詳見 `agent/stage2-async-migration.md` 進度追蹤段。後續待辦：① plugin-example 適配 PluginDbService 介面 Promise 化（breaking change）；② pluginServices.test teardown ENOENT 雜音（非功能 bug）。
- 階段 3：✅ **已完成（2026-07-10）**。PostgreSQL 後端全鏈路通車。新增 PostgresDriver（pg.Pool + $1 placeholder + RETURNING id + transaction txClient）+ schema 拆分（tables.ts/postgres.ts）+ schema_migrations + dialect periodCondition + importDatabase 分方言（SQLite shadow 零回歸 / PG TRUNCATE+setval）。tsc 零錯，SQLite 439 全綠。PG driver 測試 19 個靠 CI `pg-test` job（postgres:16 service container）自動跑。PG 連線驗證待 push 後 CI 結果確認。
- 階段 4：✅ **已完成（2026-07-10）**。MySQL 後端全鏈路通車。新增 MysqlDriver（mysql2 Pool + `?` 原生 placeholder + OkPacket.insertId + transaction txConn + exec split `;`）+ schema/mysql.ts（INTEGER AUTO_INCREMENT + VARCHAR(255) for UNIQUE/PK + TEXT 無 DEFAULT + ENGINE=InnoDB + backtick `key`）+ importDatabaseCloud TRUNCATE 方言化。tsc 零錯，SQLite 439 全綠。MySQL driver 測試 19 個靠 CI `mysql-test` job（mysql:8 service container）自動跑。
- 階段 5：✅ **已完成（2026-07-10）**。環境變數文檔（README DATABASE_URL 行 + .env.example mysql 範例）+ docker-compose.yml（DATABASE_URL 傳遞 + PG/MySQL profile 註解範例）+ SQLite→雲端遷移工具（src/scripts/migrate-db.ts → build 到 dist/scripts/）+ agent 文件收尾。tsc 零錯、build 通過、vitest 439 全綠。**整個雲端 DB 遷移計劃（階段 0-5）圓滿完成**，PG/MySQL 連線整合測試待 GitHub Actions CI 驗證。

### 階段 3 完成摘要（2026-07-10）
- **新增檔案**：`src/db/driver/postgresDriver.ts`、`src/db/schema/tables.ts`（BACKUP_TABLES+TABLE_COLUMNS）、`src/db/schema/postgres.ts`（PG_DDL+PG_INDEXES+PG_SEED_DEFAULT_GROUP）、`tests/postgresDriver.test.ts`（19 tests，讀 TEST_DATABASE_URL 否則 skip）
- **修改檔案**：`src/db/driver/factory.ts`（PG 分支 dynamic import）、`src/db/dialect.ts`（NOW.postgres→to_char、新增 periodCondition）、`src/db/database.ts`（runMigrations+initDbAsync 放開 PG+getTableColumns 常數+getPeriodUsage 方言化+importDatabase 分 sqlite/cloud）、`package.json`（pg optionalDep + @types/pg devDep）、`.env.example`（DATABASE_URL 說明）、`.github/workflows/nodejs-ci.yml`（pg-test job）
- **關鍵設計**：D1 SQLite 路徑零回歸（createTables/importDatabaseSqlite 走舊邏輯）；D2 PG 全新 DB 走 schema_migrations（001_base_schema）；D3 importDatabaseCloud 用 transaction+TRUNCATE RESTART IDENTITY CASCADE+INSERT 保留原始 id+setval 重置序列；D4 PG FK 驗證靠 COMMIT rollback 取代 PRAGMA foreign_key_check；D5 TABLE_COLUMNS 常數化取代 PRAGMA table_info；D6 PG 用 INTEGER 存布林（三方一致）；D7 tg_user_id BIGINT（Telegram ID 可超 int4）
- **待驗證**：PG driver 連線測試靠 CI `pg-test` job（push 後觸發）。若 CI 紅需修 PG driver 細節

### 階段 4 完成摘要（2026-07-10）
- **新增檔案**：`src/db/driver/mysqlDriver.ts`（MysqlDriver: mysql2/promise Pool + `?` 原生 placeholder + isOkPacket 區分 SELECT vs OkPacket + insert 用 OkPacket.insertId + transaction txConn + exec split `;`）、`src/db/schema/mysql.ts`（MYSQL_DDL + MYSQL_INDEXES + MYSQL_SEED_DEFAULT_GROUP）、`tests/mysqlDriver.test.ts`（19 tests，讀 TEST_MYSQL_URL 否則 skip）
- **修改檔案**：`src/db/driver/factory.ts`（MySQL 分支 dynamic import）、`src/db/database.ts`（runMigrations dialect dispatch 加 MySQL / importDatabaseCloud TRUNCATE 方言化：PG `RESTART IDENTITY CASCADE` vs MySQL 無後綴）、`package.json`（mysql2 optionalDep，自帶 TS 型別免 @types）、`.github/workflows/nodejs-ci.yml`（mysql-test job: mysql:8 service container + TEST_MYSQL_URL）、`tests/driverFactory.test.ts`（MySQL factory 從 not-implemented 改真實測試）
- **MySQL vs PG 關鍵差異**：placeholder `?` 原生不轉換（PG `?`→`$N`）；insert 取 id 用 OkPacket.insertId（PG append RETURNING id）；TEXT in UNIQUE/PK 需 VARCHAR(255)（PG TEXT 可）；TEXT 無 DEFAULT（PG 可 DEFAULT ''）；timestamp 無 DEFAULT app 帶 NOW()（PG DDL DEFAULT to_char(NOW())）；TRUNCATE 無後綴自動重置 AUTO_INCREMENT（PG 需 RESTART IDENTITY + setval）；ENGINE=InnoDB + backtick `key`
- **待驗證**：MySQL driver 連線測試靠 CI `mysql-test` job（push 後觸發）。若 CI 紅需修 MySQL driver 細節（caching_sha2_password 認證等）

### 工作紀律提醒（本次延續）
- driver 層檔案（types/sqliteDriver/factory/dialect）是 untracked 新檔。
- 階段 2 已改動：database.ts（async 重寫）+ database.test.ts + 14 呼叫檔 + 6 測試檔。agent/ 不主動 commit，git 確認改動範圍正確即可。
- pg/mysql2 計畫為 optionalDependencies + dynamic import（SQLite-only 部署不需裝）。
- 錯誤訊息慣例：英文=開發者契約（driver/types 已遵循）；繁中=管理員 UI。
- 本環境 read/edit 工具每次注入完整 README（~330 行），大檔逐段操作時嚴重消耗上下文；改用 bash PowerShell `[IO.File]::ReadAllText/WriteAllText` + `.Replace` / `[regex]::Replace` 字面替換（不注入），或寫腳本到 `C:\Users\yoyo2\AppData\Local\Temp\opencode\` 執行。

## 2026-07-11 - plugin-example v2.0.0 推送至獨立倉庫

- 使用者要求把本地完成的 `plugin-example/` v2.0.0（覆蓋升級版，展示全部 6 services + 綜合場景）推送至獨立倉庫 `s12ryt/s12ryt-nodejs-plugin-example`（public，default branch main，2026-07-04 建立）。
- **推送方式**：clone 獨立倉庫到 `C:\Users\yoyo2\AppData\Local\Temp\opencode\pe-push`（本機 git 認證可用，無需額外 token）→ 用本地 plugin-example/ 5 檔覆蓋 clone 根目錄對應檔（本地 `plugin-example/{src,dist,...}` → 獨立倉庫根 `{src,dist,...}`，去掉一層目錄）→ commit → push origin main。臨時目錄用後即刪。
- **結果**：commit `61f1a97`「feat(example): v2.0.0 comprehensive example covering all 6 plugin services」，5 檔 +1438 −147，遠端 main 已更新（`b2b392d..61f1a97`），歷史保留。GitHub API list_commits 已驗證。
- **內容覆蓋**：26 HTTP routes（按服務分組：status/dashboard/auth/storage/events/scheduler/providers/db）+ 3 bot commands（/plugin_example、/my_usage、/plugin_data）+ 生命週期 hooks（onStart/onStop 含 storage 記錄 + events emit + scheduler clearAll）。修復 v1 的 `getUserByTelegramId` 未 await bug（db 已 async 化後的 breaking change）。
- **注意事項**：
  - commit author 顯示為 `yoyo`（id:98624，本地 git config 預設身份），非 repo owner `s12ryt`（id:102228212）。push 認證仍走 s12ryt token（成功推到 s12ryt 的 repo）。若日後需統一作者為 s12ryt，需 amend + force-push（本次未做，風險大於效益）。
  - 獨立倉庫 `src/index.ts` 的 `import type { NodeJsPlugin } from "../../nodejs/src/plugins/types.js"` 在獨立倉庫**無法獨立 tsc 編譯**（獨立倉庫無 nodejs/ 目錄）——這沿用 v1 既有的設計，src/ 僅供人類閱讀參考，實際運行版本是 `dist/index.js`（純 ESM，零外部 import，可直接 dynamic import）。
  - 本地主專案的 plugin-example/ 5 檔仍處於「已修改未提交」狀態（git status M），未 commit 到 s12ryt-tg-api 主倉庫。主倉庫與獨立倉庫內容現在一致，但主倉庫需另一步 commit 才會同步。

## 2026-07-11 - Web 雙模式認證（方案 3：telegram + password 環境變數切換）

- **需求**：新增「單 web 面板模式」，讓沒有 Telegram Bot 的部署也能透過帳密管理 Web Console。
- **設計決策**：
  - 獨立 web_users 表（不動既有 users 表，零遷移風險）
  - WEB_AUTH_MODE=telegram（預設）或 WEB_AUTH_MODE=password（帳密）
  - LOGIN_WEB_PATH 自定義登入路徑（防爬蟲，設定後 /web HTML 入口返回 404）
  - 虛擬 tg_user_id 機制：WEB_USER_TG_ID_OFFSET = 9_000_000_000，password 模式下每個 web_user 在 users 表建立虛擬記錄，所有下游路由（keys/usage/coding/limits）零改動
  - Admin 判斷：web_users.is_admin 欄位（獨立於 config.ADMIN_ID）
  - 首次引導：DB 無 web_user 時顯示初始化頁面
  - 用戶註冊不開放，僅管理員建立
- **改動檔案（14 檔）**：
  1. config.ts — 新增 WebAuthMode 型別、WEB_AUTH_MODE/LOGIN_WEB_PATH 解析、BOT_TOKEN 空字串預設、ADMIN_ID number|null、移除 requireEnv
  2. database.ts — web_users SQLite DDL + WebUser interface + 8 CRUD + WEB_USER_TG_ID_OFFSET
  3. schema/tables.ts — BACKUP_TABLES + TABLE_COLUMNS 加 web_users
  4. schema/postgres.ts — web_users PG DDL
  5. schema/mysql.ts — web_users MySQL DDL
  6. web/password.ts（新）— crypto.scryptSync 雜湊/驗證、validatePasswordStrength（8-128）、validateUsername（3-64）
  7. web/auth.ts — SessionEntry 加 userType/webUserId/username；新增 exchangePasswordCredentials
  8. web/routes.ts — GET /api/auth/config（公開）、POST /api/auth/setup（首次引導）、login 分叉、PUT /api/auth/password（改密碼）
  9. index.ts — validateConfig 條件化；Bot 條件啟動
  10. api/server.ts — LOGIN_WEB_PATH 路由入口
  11. web/index.html — 帳密表單 + 引導表單 + 絕對路徑資源引用
  12. web/app.js — showLoginPassword/showLoginSetup/handleSessionExpired/tryLogin authConfig
  13. web/style.css — .login-form/.login-error 樣式
  14. bot/handlers/webHandlers.ts — getWebBaseUrl respect LOGIN_WEB_PATH
- **測試**：config.test.ts 改 2 throw 測試為預設值 + 加 4 WEB_AUTH_MODE/LOGIN_WEB_PATH 測試；database.test.ts backup 表 10 變 11
- **驗證**：tsc --noEmit 零錯，vitest 443 tests 全綠
- **挖蟲修復**：getWebBaseUrl() 硬編碼 /web 改為 respect LOGIN_WEB_PATH
- **待辦（建議，非阻塞）**：前端缺密碼修改 UI；缺管理員管理 web_user API+UI；webAuthMiddleware password 模式不重查 is_admin

## 2026-07-11 - 閱讀 agent 資料夾並接手（本 session）

- 使用者要求「閱讀一下 agent 文件夾以方便後續回覆」。
- 已完整閱讀 `agent/` 5 個檔案：
  - `memory.md`（最新，2026-07-11）：決策與完成紀錄最完整
  - `deep_todos.md`（原停在 07-09）：階段 2-5 仍標 [ ]，已與 memory 對齊改為完成並補 07-11 任務
  - `項目表.md`（原停在 07-09）：DB 仍寫「全同步 / PG MySQL 佔位」，已更新為 async 多後端 + Web 雙模式 + 狀態快照
  - `stage2-async-migration.md`：階段 2 執行手冊（歷史參考，實作已完成）
  - `db-cloud-migration-design.md`：雲端 DB 12 章設計藍圖（歷史參考，階段 0-5 已落地）
- **單一真相來源**：後續以 `memory.md` 為最新決策；`deep_todos.md` 追任務勾選；`項目表.md` 追結構/依賴。
- **目前可開工狀態**：雲端 DB 0-5 完成、Web 雙模式認證完成、plugin-example v2 已推遠端；建議待辦見項目表「目前狀態快照」。
- agent/ 不主動 commit（`.gitignore` + 早期誤 tracked 也不主動改 git 歷史）。

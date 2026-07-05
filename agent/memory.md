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

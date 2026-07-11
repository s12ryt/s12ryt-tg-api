# s12ryt-tg-api

透過 Telegram Bot 與 Web 控制台管理多個 AI API 供應商，並對外提供 OpenAI / Anthropic 相容 API 的聚合代理服務。

> **維護狀態**：目前主要維護 **Node.js 版本**。Python 版本已停止維護，僅保留在 [`python(not-supported)/`](python(not-supported)/) 作為歷史參考。

## 目錄

- [適合誰使用](#適合誰使用)
- [核心功能](#核心功能)
- [快速開始](#快速開始)
- [VPS 一鍵部署](#vps-一鍵部署)
- [第一次設定流程](#第一次設定流程)
- [API 使用方式](#api-使用方式)
- [Telegram Bot 指令](#telegram-bot-指令)
- [Web 控制台](#web-控制台)
- [插件系統](#插件系統)
- [更新與備份](#更新與備份)
- [環境變數](#環境變數)
- [架構概覽](#架構概覽)
- [專案結構](#專案結構)
- [技術棧](#技術棧)
- [授權](#授權)

## 適合誰使用

- 想把 OpenAI、Anthropic、Google 或其他相容 API 統一成一組服務入口。
- 想為不同 Telegram 用戶發放不同 API Key、限制模型、配額、速率與有效期限。
- 想用 Telegram Bot 或 Web 控制台管理供應商、模型、用戶與用量。
- 想在低配 VPS 或容器環境部署可自動更新、可備份還原的 AI API 代理服務。

## 核心功能

| 分類 | 功能 |
|------|------|
| API 代理 | OpenAI Chat Completions、OpenAI Responses、Anthropic Messages，相容 `/v1/chat/completions`、`/v1/responses`、`/v1/messages` |
| 供應商聚合 | OpenAI / Anthropic / Google / 相容端點，多供應商、多 API Key、模型映射、自動協議偵測 |
| 格式轉換 | Chat Completions / Responses / Messages 可跨格式轉換並路由到任意供應商 |
| 推理強度 | 支援 model 後綴與請求參數指定 `xhigh` / `high` / `medium` / `low` / `minimal` / `none` |
| 用量與計費 | Token 用量、費用統計、每模型定價、精確 token count fallback |
| 權限控制 | 用戶分組、API Key 限制、RPM / TPM / 並發 / 日月 token 與費用配額、模型白黑名單 |
| 高可用 | 多金鑰 `failover` / `round_robin` / `random`、Circuit Breaker、Coding Mode fallback 模型鏈 |
| 管理介面 | Telegram Bot 選單式管理、Web 控制台、API 日誌、版本更新、備份還原 |
| 擴充 | Node.js 插件系統，支援 Express route、grammY command 與 `context.services` 穩定內部接口 |

## 快速開始

### Node.js 版本（建議）

需求：Node.js 22 LTS 以上。

```bash
cd nodejs
npm install
cp .env.example .env
npm run dev
```

啟動前請先編輯 `nodejs/.env`，至少填入：

```env
BOT_TOKEN=你的 Telegram Bot Token
ADMIN_ID=你的 Telegram User ID
API_PORT=8000
DEFAULT_API_URL=http://localhost:8000
```

## VPS 一鍵部署

如果要在 Linux VPS 上部署 Node.js 版本，可以使用根目錄的互動式腳本。腳本會自動詢問安裝或更新、部署方式、環境變數填寫方式，並在最後檢查 `/health`。

推薦直接在 VPS 執行以下其中一種方式。

方式一：最短的一行指令，直接把遠端腳本交給 Bash 執行。

```bash
curl -fsSL https://raw.githubusercontent.com/s12ryt/s12ryt-tg-api/main/scripts/vps.sh | bash
```

方式二：明確用 Bash process substitution 執行，適合已確認 shell 支援 `<(...)` 的環境。

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/s12ryt/s12ryt-tg-api/main/scripts/vps.sh)
```

如果已經 clone 專案，也可以在專案根目錄執行 `bash scripts/vps.sh`。

腳本支援：

- 安裝或更新既有部署。
- `docker` 部署：自動準備 Docker、pull GHCR image、重建 container，預設只使用 `/opt/s12ryt-tg-api-docker` 存放 `.env` 與 `nodejs/data`；不會 clone 倉庫。
- `systemd` 部署：自動準備 Node.js 22、clone/update 倉庫、安裝依賴、build、建立 service，並以非 root 使用者執行。
- 互動填寫 `.env`，或讀取目前 shell 的 `BOT_TOKEN`、`ADMIN_ID`、`API_PORT` 等環境變數。

腳本不會設定 HTTPS、Nginx 或 Cloudflare Tunnel；如需對外網域與 TLS，請在服務通過健康檢查後另外配置反向代理。

### Docker Compose 範例

專案根目錄提供 [`docker-compose.yml`](docker-compose.yml)，預設使用 `ghcr.io/s12ryt/s12ryt-tg-api:latest`，不會在 VPS 上 build image。

```bash
cp nodejs/.env.example .env
# 編輯 .env，至少填入 BOT_TOKEN 與 ADMIN_ID
docker compose up -d
docker compose logs -f
```

Compose 會把 `./nodejs/data` 掛載到容器的 `/app/nodejs/data`，資料庫與 Web 安裝的插件資料會保留在主機上。

### Python 版本（停止維護）

不建議新部署使用；以下只保留給需要查閱舊版行為的人。

```bash
cd "python(not-supported)"
pip install -r requirements.txt
cp .env.example .env
python main.py
```

## 第一次設定流程

1. 到 [@BotFather](https://t.me/BotFather) 建立 Telegram Bot，取得 `BOT_TOKEN`。
2. 取得你的 Telegram User ID，填入 `ADMIN_ID`。
3. 啟動 Node.js 服務後，在 Telegram 對 Bot 發送 `/start`。
4. 管理員使用 `/provider` 或 Web 控制台新增 AI 供應商。
5. 用 `/admin_user` 新增可信任用戶，或用 `/key` 建立自己的 API Key。
6. 使用 `/url` 取得 API base URL，搭配 `sk-s12ryt-...` API Key 呼叫代理端點。

## API 使用方式

### 端點

| 端點 | 說明 |
|------|------|
| `POST /v1/chat/completions` | OpenAI Chat Completions API，支援串流 |
| `POST /v1/responses` | OpenAI Responses API |
| `POST /v1/messages` | Anthropic Messages API，相容 Anthropic SDK |
| `GET /v1/models` | 列出所有可用模型 |
| `GET /health` | 健康檢查 |

### 認證

OpenAI 相容用戶端使用：

```http
Authorization: Bearer sk-s12ryt-your-key
```

Anthropic 相容用戶端也可使用：

```http
x-api-key: sk-s12ryt-your-key
```

Google Gemini 相容用戶端也可使用：

```http
x-goog-api-key: sk-s12ryt-your-key
```

或：

```text
?key=sk-s12ryt-your-key
```

### 請求範例

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Authorization: Bearer sk-s12ryt-your-key-here" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'
```

串流請求只要把 `stream` 設為 `true`。

### Thinking Effort

可用 model 後綴或請求參數指定推理強度，支援等級：`xhigh`、`high`、`medium`、`low`、`minimal`、`none`。

| 方式 | 範例 | 優先級 |
|------|------|--------|
| Model 名稱後綴 | `"model": "o3(high)"` | 最高 |
| `reasoning_effort` | `"reasoning_effort": "high"` | 中 |
| `thinking_effort` | `"thinking_effort": "high"` | 最低 |

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Authorization: Bearer sk-s12ryt-your-key-here" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4(high)",
    "messages": [{"role": "user", "content": "分析這段程式碼"}]
  }'
```

## Telegram Bot 指令

所有指令採用選單式多輪對話設計。一般用戶需先由管理員加入可信任用戶。

### 一般用戶

| 指令 | 說明 |
|------|------|
| `/start` | 顯示歡迎訊息與 Web 控制台登入按鈕 |
| `/url` | 取得目前 API 端點 URL |
| `/key` | 查看、新增、刪除自己的 API Key |
| `/usage` | 查看 Token 用量與費用 |
| `/coding` | 管理 Coding Mode fallback 模型鏈 |
| `/model_catch` | 抓取任意 API 的模型列表 |
| `/my_limits` | 查看自己的有效限制與用量 |
| `/web` | 取得 Web 控制台一次性登入連結 |

### 管理員

| 指令 | 說明 |
|------|------|
| `/provider` | 新增、刪除、編輯、列表供應商，含 API 協議偵測與模型定價 |
| `/admin_user` | 新增、停用、刪除、編輯用戶與 API Key，設定模型存取限制 |
| `/uu` | 查看所有用戶的 API Key 用量 |
| `/sub_url` | 設定或覆蓋 API 端點 URL |
| `/api_test` | 測試供應商 API 協議連通性 |
| `/limits` | 管理用戶分組、用戶限制與 API Key 限制 |
| `/version` | 查看版本、commit hash、tag 與日期 |
| `/update` | 從 GitHub Release 一鍵更新 |
| `/restart` | 重啟進程 |

## Web 控制台

Node.js 版本提供瀏覽器管理面板。使用者從 Telegram `/web` 取得一次性登入連結，前端用 OTP 換取 24 小時 Session。

| 頁面 | 一般用戶 | 管理員 | 說明 |
|------|:--------:|:------:|------|
| 儀表板 | 是 | 是 | 模型數量、Key 數量、今日用量摘要 |
| API Key 管理 | 是 | 是 | 新增、複製、刪除自己的 Key |
| 用量統計 | 是 | 是 | 按 Key 分組的 Token 與費用 |
| Coding 模式 | 是 | 是 | 開關與 fallback 模型鏈 |
| 使用限制 | 是 | 是 | RPM / TPM / 並發 / 配額與用量 |
| 模型存取限制 | 是 | 是 | 白名單與黑名單查看 |
| Provider 管理 | 否 | 是 | 供應商 CRUD、模型抓取、協議偵測、定價 |
| 用戶管理 | 否 | 是 | 用戶、API Key、限制設定 |
| 用戶分組 | 否 | 是 | 分組 CRUD 與預設限制模板 |
| 全域用量 | 否 | 是 | 所有用戶用量統計 |
| 系統管理 | 否 | 是 | API URL、Provider User-Agent、版本、更新、回滾、重啟 |

## 插件系統

本專案支援 Node.js 插件。插件可註冊：

- Express route：掛載於 `/plugins/<plugin-id>`。
- grammY Bot command：接入核心 Bot middleware。
- `context.services`：穩定內部服務接口，包含 auth、storage、events、scheduler、providers、db facade。

本倉庫內建範例位於 [`plugin-example/`](plugin-example/)。此範例也獨立發布於 [`s12ryt/s12ryt-nodejs-plugin-example`](https://github.com/s12ryt/s12ryt-nodejs-plugin-example)，方便直接透過 Web Console 從 GitHub 安裝。

詳細插件介面、路由範例與安全注意事項請看 [`plugin-example/README.md`](plugin-example/README.md)。

## 更新與備份

### 更新

`/update` 與 Web 控制台「系統管理 → 檢查更新」支援三種更新路徑，可手動選擇或自動偵測：

| 方式 | 說明 | 耗時 | 適用場景 |
|------|------|------|----------|
| **Prebuilt**（預編譯） | 直接下載 CI 預編譯好的 `dist` + `node_modules` bundle，解壓後原子切換，**免 npm install、免 tsc build** | 約 10-30 秒 | 容器環境（Pterodactyl 面板）、`start.js` 啟動器部署 |
| **Blue-Green** | 下載原始碼到 `.staging` → `npm install` → `tsc build` → 驗證 → 原子切換 | 約 3-10 分鐘 | 一般 VPS、systemd 部署 |
| **Auto**（預設） | 自動偵測：Release 含 prebuilt asset 走 Prebuilt，否則 fallback 到 Blue-Green | 視情況 | 不確定時的預設選擇 |

Web 控制台會從 Release assets 偵測是否提供 prebuilt bundle，並顯示對應按鈕（下載圖示 = Prebuilt、重新整理圖示 = Blue-Green）；只有該 Release 實際提供 prebuilt asset 時才會出現 Prebuilt 按鈕。舊版前端未指定方式時自動套用 `Auto`，完全向後相容。

**安全保證（所有路徑通用）**：

- 更新前會清理舊 `.staging` 與過舊 `.backup-*`，並檢查磁碟空間。
- `data/`、`.env`、`.git` 不會被覆蓋；`node_modules` 在 Blue-Green 路徑保留並重新安裝，在 Prebuilt 路徑則直接覆蓋為預編譯版本。
- 切換採原子交換（atomic swap），舊版本備份至 `.backup-*`，可透過 Web 控制台的回滾功能還原。
- 低配 VPS 建議保留約 `2.0~2.5x` 的 `nodejs/` 目錄可用空間。

### 備份還原

- `/backup` 匯出的 JSON 包含 providers、users、api_keys、usage、settings、model_prices 等核心表。
- 還原前會先用 shadow DB 匯入並執行 `PRAGMA foreign_key_check`。
- 若備份有孤兒外鍵，會在正式 DB 被改動前失敗。
- 不要匯入不可信來源的備份；備份可合法覆蓋 provider URL、API Key、users 與 quota 等敏感資料。
- 備份 JSON 跨後端通用：可從 SQLite `/backup` 匯出，再匯入 PostgreSQL 或 MySQL。`nodejs/scripts/migrate-db.ts` 提供一鍵遷移；雲端 DB 匯入以 transaction 包裹 TRUNCATE + INSERT，靠 FK constraint 驗證完整性。

## 環境變數

| 變數 | 必填 | 預設值 | 說明 |
|------|------|--------|------|
| WEB_AUTH_MODE | 否 | 	elegram | Web 控制台認證模式。	elegram（預設）：透過 Telegram Bot /web OTP 連結登入，需設定 BOT_TOKEN 與 ADMIN_ID。password：獨立 Web 部署模式，Bot 不啟動，首次訪問顯示初始化頁面建立管理員帳號，BOT_TOKEN 與 ADMIN_ID 不再需要。 |
| LOGIN_WEB_PATH | 否 | /web/login | 自定義 Web 登入路徑（防爬蟲）。設定後預設的 /web/ 入口返回 404，面板僅可由自定義路徑進入。必須以 / 開頭。 |
| BOT_TOKEN | 條件 | - | Telegram Bot Token。WEB_AUTH_MODE=telegram 時必填；password 模式不需要。 |
| ADMIN_ID | 條件 | - | 管理員 Telegram User ID。WEB_AUTH_MODE=telegram 時必填；password 模式不需要。 |
| `API_PORT` | 否 | `8000` | API 代理伺服器監聽埠 |
| `DATABASE_PATH` | 否 | `./data/bot.db` | SQLite 資料庫檔案路徑 |
| `DATABASE_URL` | 否 | - | 雲端資料庫連線字串（`postgres://`、`postgresql://` → PostgreSQL；`mysql://`、`mariadb://` → MySQL）。未設定時使用本機 SQLite（`DATABASE_PATH`）。`pg`/`mysql2` 為 optional dependencies，SQLite-only 部署不需安裝。需 PostgreSQL 9.5+ 或 MySQL 5.7+。 |
| `DEFAULT_API_URL` | 否 | `http://localhost:8000` | 顯示給用戶的預設 API 端點 URL |
| `memory` | 否 | 自動偵測 | Node.js V8 heap 上限，單位 MB，支援小數點後一位 |
| `CLOUDFLARE_TUNNEL` | 否 | - | `quick` 臨時 URL 或 `token` 命名隧道 |
| `CLOUDFLARE_TOKEN` | 否 | - | Cloudflare 命名隧道 Token |
| `GITHUB_MIRROR` | 否 | - | GitHub 下載與 clone 的鏡像 URL |
| `NPM_REGISTRY` | 否 | - | npm registry mirror URL |
| `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` | 否 | - | 對外網路請求使用的代理 |

## 架構概覽

```text
Telegram / Web Console
        |
        v
Bot handlers / Web routes
        |
        v
SQLite DB <----> API Proxy <----> AI Providers
                  |
                  +-- /v1/chat/completions
                  +-- /v1/responses
                  +-- /v1/messages
```

## 專案結構

```text
s12ryt-tg-api/
├── nodejs/                  # 主要維護版本：Express + grammY + TypeScript
│   ├── src/
│   │   ├── api/             # API 代理、middleware、provider adapters
│   │   ├── bot/             # Telegram Bot handlers 與 conversations
│   │   ├── db/              # sql.js SQLite database layer
│   │   ├── plugins/         # Node.js plugin manager 與 services
│   │   └── web/             # Web 控制台後端 routes / auth
│   ├── web/                 # Web 控制台前端靜態檔案
│   ├── tests/               # Node.js 測試
│   └── package.json
├── plugin-example/          # Node.js 插件範例
├── python(not-supported)/   # 已停止維護的 Python 版本，僅作歷史參考
├── CHANGELOG.md
├── LICENSE
└── README.md
```

## 技術棧

| 項目 | Node.js 版本 | Python 版本 |
|------|--------------|-------------|
| 維護狀態 | 主要維護 | 停止維護 |
| 語言 | TypeScript / Node.js 22+ | Python 3.10+ |
| Bot | grammY | python-telegram-bot |
| Web/API | Express | FastAPI + Uvicorn |
| Web 控制台 | Vanilla JS SPA | 無 |
| DB | sql.js / SQLite | aiosqlite / SQLite |
| 測試 | Vitest | 舊測試保留，不作主要支援承諾 |

## 授權

本專案採用 **GNU Affero General Public License v3.0 (AGPL-3.0)** 授權。

Copyright (C) 2026 s12ryt

你可以自由使用、修改、散布本程式；若你修改本程式並透過網路提供服務，依 AGPL-3.0 第 13 條，必須向使用該服務的使用者公開修改後的完整原始碼。任何衍生作品都必須以相同授權釋出。

完整條款請見 [`LICENSE`](./LICENSE)，或參閱 <https://www.gnu.org/licenses/agpl-3.0.html>。

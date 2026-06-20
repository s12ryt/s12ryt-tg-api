# s12ryt-tg-api

透過 Telegram Bot 和 Web 控制台管理多個 AI API 供應商的聚合代理服務。支援 OpenAI、Anthropic、Google 等供應商，並對外提供統一的 OpenAI 相容 API 端點，讓你能用一套 API 金鑰存取所有 AI 模型。

提供 **Python** 和 **Node.js** 兩種實作版本（Web 控制台目前僅 Node.js 版本支援）。

## 特色

### API 代理核心
- **多供應商聚合** — 統一管理 OpenAI / Anthropic / Google 等 AI API
- **OpenAI 相容 API** — 對外暴露 `/v1/chat/completions`、`/v1/responses` 端點，可直接替換現有 OpenAI 客戶端
- **Anthropic 相容 API** — 提供 `/v1/messages` 端點，相容 Anthropic Messages API 格式
- **格式自動轉換** — 三種 API 格式（Chat Completions / Responses / Messages）之間自動雙向轉換，任一端點可路由到任意供應商
- **Thinking Effort（推理強度）** — 支援透過 model 名稱後綴（如 `o3(high)`）或請求參數（`reasoning_effort` / `thinking_effort`）指定推理強度（6 級：`xhigh` / `high` / `medium` / `low` / `minimal` / `none`），自動映射到各供應商的原生格式
- **API 協議自動偵測** — 新增供應商時自動 ping 各端點，以 HTTP 狀態碼 + 信心等級（high/medium/low）分析，並自動推薦最佳類型
- **串流支援 (SSE)** — 支援 Server-Sent Events 即時串流回應

### 計費與用量
- **每模型獨立定價** — 自動從 [models.dev](https://models.dev) 獲取各模型定價（USD / 1M tokens），支援 per-model 計費
- **Token 用量追蹤** — 自動記錄每個 API Key 的輸入/輸出 Token 數與費用

### 高可用性
- **多金鑰負載均衡** — 每個供應商可設定多個 API Key（逗號分隔），支援 3 種選擇策略：`failover`（預設，首鍵優先，失敗才切）、`round_robin`（輪詢）、`random`（隨機），搭配 Circuit Breaker 故障轉移（連續失敗 ≥3 次 → 60 秒冷卻排除）
- **Coding Mode** — 用戶可設定 fallback 模型鏈，API 報錯時自動按順序重試下一個模型
- **模型映射**（僅 Node.js）— 為每個供應商設定模型顯示名稱映射（`model_mappings`），對外顯示自訂名稱，內部自動路由到真實模型

### 權限與安全
- **權限管理系統** — 速率限制（RPM/TPM）、並發上限、配額管理（日/月 Token 與費用）、使用期限、用戶分組，API Key 可覆蓋用戶設定
- **模型存取限制** — 用戶級別 + API Key 級別的白名單/黑名單控制，Key 級別覆蓋用戶級別
- **API Key 認證** — `sk-s12ryt-{uuid-v7}` 格式，時間排序、唯一性保證

### 管理
- **Telegram Bot 管理** — 所有操作透過 Telegram Bot 完成
- **Web 控制台**（僅 Node.js）— 瀏覽器版管理面板，功能比 Bot 指令更完整直觀，OTP 一次性登入 + Session 認證
- **API 日誌**（僅 Node.js）— 記憶體中保留最近 50 筆 API 請求日誌（環形緩衝區，不持久化），可用於除錯與監控
- **指令統合設計** — 選單式多輪對話，少量指令完成所有操作
- **模型抓取** — `/model_catch` 指令可抓取任意 API 的模型列表
- **內置更新系統** — `/update` 指令直接從 GitHub Release 更新程式（git pull + tarball 備援）
- **Cloudflare Tunnel**（僅 Node.js）— 內置隧道支援，一鍵暴露本地服務到公網（`quick` 臨時 URL / `token` 命名隧道）

### 效能
- **Provider routing 快取** — 記憶體中維護 `model_name → provider` 映射，避免每次請求查 DB
- **API Key LRU 快取** — 256 條目的 LRU cache，認證時省去 2 次 DB 查詢
- **用量寫入佇列** — 每 5 秒或累積 100 筆批量刷入 DB（單一交易），降低 SQLite 寫入瓶頸
- **權限查詢優化** — 單次 LEFT JOIN + 60s TTL 快取，每請求 DB 查詢從 ~10 降至 0-2

### 工程
- **雙語言實作** — Python (FastAPI + python-telegram-bot) 與 Node.js (Express + grammY)
- **完整測試** — 304 個單元 + 整合測試全部通過
- **CI/CD** — GitHub Actions 自動發布 Release（push to main 更新 `latest`，tag v*.*.* 建立 stable）
- **低資源容器優化**（僅 Node.js）— 自動偵測可用記憶體，動態調整 V8 heap size（50% 記憶體，[128, 512]MB 區間）、npm 並發連接數（maxsockets=2）和操作超時倍率（≤512MB→3x、≤1024MB→2x），適配 256MB 等低配 VPS / 容器

## 架構

```
┌──────────────┐                                                       ┌──────────────────┐
│  Telegram    │──▶ Bot Handlers ────┐                                 │  AI Providers    │
│  User / Admin│                     │                                 │                  │
└──────────────┘                     ├──▶ SQLite DB ◀──▶ API Proxy ──▶ ├──────────────────┤
                                      │                     (/v1/chat/...)│  OpenAI Chat     │
┌──────────────┐                     │        (API Key 驗證 & 用量記錄) ├──────────────────┤
│  Web 瀏覽器   │──▶ Web Routes ─────┘                                 │  OpenAI Response │
│  (控制台)     │    OTP + Session 認證                                ├──────────────────┤
└──────────────┘    (/web)                                            │  Anthropic       │
                                                                     ├──────────────────┤
                                                                     │  Google          │
                                                                     └──────────────────┘
```

## Bot 指令

所有指令採用**選單式多輪對話**設計，一個指令即可完成多種操作。

### 一般用戶指令

需為管理員加入的信任用戶才能使用。

| 指令 | 說明 |
|------|------|
| `/start` | 顯示歡迎訊息 + Web 控制台登入按鈕 |
| `/url` | 取得目前 API 端點 URL |
| `/key` | API Key 管理（查看現有 / 新增 / 多選刪除），首次使用自動建立，格式 `sk-s12ryt-{uuid-v7}` |
| `/usage` | 查看各 API Key 的 Token 用量與費用 |
| `/coding` | Coding 模式管理（開關 / 設定 fallback 模型鏈，API 報錯時自動重試下一個模型） |
| `/model_catch` | 抓取任意 API 的模型列表（輸入 URL → 不帶 key 嘗試 → 401/403 再問 key） |
| `/my_limits` | 查看自己的有效限制（RPM/TPM/並發/配額）與今日/月用量 |
| `/web` | 取得 Web 控制台一次性登入連結（OTP 5 分鐘有效，登入後 Session 24 小時） |

### 管理員指令

僅限 `ADMIN_ID` 對應的用戶使用。

| 指令 | 說明 |
|------|------|
| `/provider` | 供應商管理選單：**新增**（名稱 → 端點 → Key（逗號分隔多個）→ 自動偵測協議 → 模型 → 定價）/ **刪除**（多選）/ **編輯**（逐欄修改）/ **列表**（含用量統計） |
| `/admin_user` | 用戶管理選單：**新增** / **停用**（多選，停用後通知）/ **刪除**（多選）/ **編輯** TG ID / **移除 API Key**（多選）/ **模型存取限制**（白名單/黑名單，用戶級 + Key 級） |
| `/uu` | 查看所有用戶的 API Key 用量 |
| `/sub_url` | 設定/覆蓋 API 端點 URL |
| `/api_test` | 測試 API 協議連通性（偵測 openai_chat / openai_response / anthropic / google，顯示信心等級 + 推薦） |
| `/limits` | 權限管理選單：用戶分組 CRUD / 用戶限制設定 / API Key 限制設定（RPM/TPM/並發/日月配額/期限） |
| `/version` | 查看當前程式版本（commit hash + tag + 日期） |
| `/update` | 檢查 GitHub Release 更新並一鍵更新（git pull + tarball 備援） |
| `/restart` | 重啟進程 |

## Web 控制台（僅 Node.js）

除了 Telegram Bot 指令外，Node.js 版本提供完整的瀏覽器管理面板，操作更直觀、支援即時預覽和批量操作。

### 認證流程

Web 控制台採用 **OTP + Session** 兩階段認證，無需獨立帳號密碼：

```
1. 用戶在 Telegram 執行 /web 或點擊選單中的 Web 按鈕
2. Bot 產生一次性 OTP token（5 分鐘有效）
3. 用戶點擊連結 → 瀏覽器開啟 Web 控制台 → 前端用 OTP 換取 Session Token
4. Session Token（24 小時有效）用於後續所有 API 請求
```

> 管理員透過 `/web` 或各管理指令選單中的 Web 按鈕進入，普通用戶只能看到自己的資料。

### 功能頁面

| 頁面 | 一般用戶 | 管理員 | 說明 |
|------|:--------:|:------:|------|
| 儀表板 | ✅ | ✅ | 總覽：模型數量、Key 數量、今日用量摘要 |
| API Key 管理 | ✅ | ✅ | 新增 / 複製 / 刪除自己的 Key |
| 用量統計 | ✅ | ✅ | 按Key 分組的 Token 用量與費用 |
| Coding 模式 | ✅ | ✅ | 開關、設定 fallback 模型鏈 |
| 使用限制 | ✅ | ✅ | 有效限制（RPM/TPM/並發/配額）+ 今日/月用量 |
| 模型存取限制 | ✅ | ✅ | 白名單/黑名單查看 |
| Provider 管理 | — | ✅ | 供應商 CRUD、每模型定價、協議偵測、模型抓取 |
| 用戶管理 | — | ✅ | 新增/停用/刪除用戶、編輯 TG ID、Key 管理、限制設定 |
| 用戶分組 | — | ✅ | 分組 CRUD、預設限制模板 |
| 全域用量 | — | ✅ | 所有用戶用量統計 |
| 系統設定 | — | ✅ | API URL 設定 |
| 版本/更新 | — | ✅ | 查看版本、檢查更新、一鍵更新、重啟 |

### 技術設計

- **前端**：Vanilla JS SPA（無框架），單頁應用，hash 路由，Lucide 風格 SVG 圖標系統，暗色主題 + 響應式設計（手機/桌面自適應）
- **後端 API**：Express Router 掛載於 `/web/api/*`，在 API auth/rate/quota 中間件之前，使用獨立的 session 認證中間件
- **安全**：OTP 一次性使用（用後即刪）、Session 24h 過期、每 10 分鐘自動清理過期 token、API Key 只回傳末 12 碼預覽

## 快速開始

### Python 版本

```bash
cd python
pip install -r requirements.txt
cp .env.example .env   # 編輯 .env 填入你的設定值
python main.py
```

### Node.js 版本

```bash
cd nodejs
npm install
cp .env.example .env   # 編輯 .env 填入你的設定值
npm run dev
```

## 環境變數

| 變數 | 必填 | 預設值 | 說明 |
|------|------|--------|------|
| `BOT_TOKEN` | ✅ | — | Telegram Bot Token（從 [@BotFather](https://t.me/BotFather) 取得） |
| `ADMIN_ID` | ✅ | — | 管理員的 Telegram User ID |
| `API_PORT` | ❌ | `8000` | API 代理伺服器監聽埠 |
| `DATABASE_PATH` | ❌ | `./data/bot.db` | SQLite 資料庫檔案路徑 |
| `DEFAULT_API_URL` | ❌ | `http://localhost:8000` | 顯示給用戶的預設 API 端點 URL |
| `CLOUDFLARE_TUNNEL` | ❌ | — | Cloudflare 隧道模式：`quick`（臨時 trycloudflare URL）或 `token`（命名隧道，需搭配 `CLOUDFLARE_TOKEN`）（僅 Node.js） |
| `CLOUDFLARE_TOKEN` | ❌ | — | Cloudflare 命名隧道 Token（`CLOUDFLARE_TUNNEL=token` 時必填）（僅 Node.js） |
| `GITHUB_MIRROR` | ❌ | — | GitHub 代理鏡像 URL（用於 `git clone` / 下載 Release 時走鏡像，應對網路限制）（僅 Node.js） |
| `NPM_REGISTRY` | ❌ | — | npm registry mirror URL（`npm install` 時使用自訂源）（僅 Node.js） |
| `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` | ❌ | — | HTTP/HTTPS 代理（自動偵測系統環境變數，用於所有對外網路請求）（僅 Node.js） |

## API 代理使用方式

### 端點

| 端點 | 說明 |
|------|------|
| `POST /v1/chat/completions` | OpenAI Chat Completions API（含串流） |
| `POST /v1/responses` | OpenAI Responses API |
| `POST /v1/messages` | Anthropic Messages API（自動轉換格式） |
| `GET /v1/models` | 列出所有可用模型 |
| `GET /health` | 健康檢查 |

### 認證

在請求標頭帶入 API Key：

```
Authorization: Bearer sk-s12ryt-{your-key}
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

### 串流範例

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Authorization: Bearer sk-s12ryt-your-key-here" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

回應格式完全相容 OpenAI API，可直接搭配現有 OpenAI SDK 或任何相容用戶端使用。Token 用量會自動追蹤記錄。

### Thinking Effort（推理強度）

透過三種方式指定推理強度（6 級：`xhigh` / `high` / `medium` / `low` / `minimal` / `none`），系統會自動映射到各供應商的原生格式。無效的後綴（如 `model(extreme)`）會返回 HTTP 400 錯誤而非靜默失敗：

| 方式 | 範例 | 優先級 |
|------|------|--------|
| **Model 名稱後綴** | `"model": "o3(high)"` | 最高 |
| **`reasoning_effort` 參數** | `"reasoning_effort": "high"` | 中 |
| **`thinking_effort` 參數** | `"thinking_effort": "high"` | 最低 |

> 後綴語法：在 model 名稱後加 `(level)`，如 `claude-sonnet-4(high)`、`o3-mini(medium)`、`gemini-2.5-flash(low)`。系統會自動剝離後綴還原真實 model 名稱。

**各供應商映射：**

OpenAI 系（Chat / Responses）直接 1:1 傳遞 level 字串；Anthropic 用 `budget_tokens` 連續值（`none` → `{type:"disabled"}`）；Google 同時設 `thinkingBudget`（2.5）和 `thinkingLevel`（3.x）。

| 供應商 | xhigh | high | medium | low | minimal | none |
|--------|-------|------|--------|-----|---------|------|
| OpenAI Chat | `"xhigh"` | `"high"` | `"medium"` | `"low"` | `"minimal"` | `"none"` |
| OpenAI Responses | `effort:"xhigh"` | `"high"` | `"medium"` | `"low"` | `"minimal"` | `"none"` |
| Anthropic budget | `64000` | `32048` | `16000` | `5000` | `1024` | `disabled` |
| Google budget | `32768` | `24576` | `12288` | `2048` | `512` | `0` |
| Google level | `"high"` | `"high"` | `"medium"` | `"low"` | `"minimal"` | — |

> Anthropic 供應商會自動確保 `max_tokens > budget_tokens`（必要時提升 max_tokens）。`none` 等級對 Anthropic 設為 `{type:"disabled"}`，對 Google 設 `thinkingBudget:0`（不安裝 thinkingLevel）。

**範例 — 使用 model 後綴：**

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Authorization: Bearer sk-s12ryt-your-key-here" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "o3(high)",
    "messages": [{"role": "user", "content": "証明費馬最後定理"}]
  }'
```

**範例 — 使用請求參數：**

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Authorization: Bearer sk-s12ryt-your-key-here" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4",
    "messages": [{"role": "user", "content": "分析這段程式碼的時間複雜度"}],
    "thinking_effort": "high"
  }'
```

此功能在所有三個端點（`/v1/chat/completions`、`/v1/responses`、`/v1/messages`）和 Coding Mode fallback 中均生效，跨格式轉換時也會保留設定。

## 效能優化

| 優化項目 | 說明 |
|----------|------|
| **Provider routing 快取** | 記憶體中維護 `model_name → provider` 映射，避免每次請求查 DB |
| **API Key LRU 快取** | 256 條目的 LRU cache，認證時省去 2 次 DB 查詢 |
| **用量寫入佇列** | 每 5 秒或累積 100 筆批量刷入 DB（單一交易），降低 SQLite 寫入瓶頸 |
| **Model Prices 單一交易** | `batch_upsert_model_prices` 在同一交易中完成所有 upsert |
| **快取自動失效** | Provider 增刪改時自動重建快取（`process.nextTick` / `asyncio.ensure_future` 批次化） |
| **Multi-Key 負載均衡** | 加權隨機選擇金鑰 + Circuit Breaker（連續失敗 ≥3 次 → 60 秒冷卻排除） |
| **DB 複合索引** | usage / api_keys / users 表新增 4 個複合索引，查詢 O(n) → O(log n) |
| **有效限制快取** | `getEffectiveLimits` 合併為單次 LEFT JOIN（原 3 次 SELECT）+ 60s TTL 快取 + 6 處失效點，每請求 DB 查詢從 ~10 降至 0-2 |
| **中間件共享結果** | rateLimiter → quotaChecker 透過 `res.locals` / context 共享已查詢結果，避免重複查詢 |
| **低資源容器適配**（僅 Node.js）| 啟動時偵測記憶體動態設定 V8 heap 上限 + npm 並發限制 + 超時倍率；更新流程改用流式下載（`pipeline`）避免 OOM；API 日誌截斷長請求體；DB 寫入去掉 Buffer 拷貝 |

## 支援的供應商

| 供應商 | API 類型 | 說明 | 認證方式 |
|--------|----------|------|----------|
| OpenAI (Chat Completions) | `openai_chat` | OpenAI 相容 `/chat/completions` 端點 | `Authorization: Bearer {key}` |
| OpenAI (Responses API) | `openai_response` | OpenAI 新版 `/responses` 端點 | `Authorization: Bearer {key}` |
| Anthropic | `anthropic` | Anthropic Messages API | `x-api-key: {key}` 標頭 |
| Google | `google` | Google Gemini API | `?key={key}` 查詢參數 |

> 💡 新增供應商時，系統會自動偵測端點支援的 API 協議，以 HTTP 狀態碼 + 信心等級（high/medium/low）分析並推薦最佳類型。三種 API 格式之間會自動轉換，你只需要關注上游供應商實際支援的協議。

### 格式轉換矩陣

所有路徑以 **OpenAI Chat Completions 為中間樞紐格式（Hub）**，括號內為格式轉換次數（越少越高效）。

| 請求端點 | openai_chat | openai_response | anthropic | google |
|----------|-------------|-----------------|-----------|--------|
| `/v1/chat/completions` | ✅ 直接轉發（0次） | chat→responses→chat（2次） | chat→messages→chat（2次） | chat→gemini→chat（2次） |
| `/v1/responses` | responses→chat→responses（2次） | ✅ 直接轉發（0次）＊ | responses→chat→messages→responses（4次） | responses→chat→gemini→chat→responses（4次） |
| `/v1/messages` | messages→chat→messages（2次） | messages→chat→responses→messages（4次） | ✅ 直接轉發（0次） | messages→chat→gemini→chat→messages（4次） |

> ＊ `/v1/responses → openai_response` 在非 Coding Mode 下有直通優化（`server.ts` fast-path），跳過 Chat 中間格式。
>
> 💡 **效率建議**：讓入口端點格式與供應商原生格式一致可獲得最佳效率（0 次轉換）。跨兩種格式鴻溝的路徑（4 次）延遲與資訊流失風險最高，應儘量避免。

## 專案結構

```
s12ryt-tg-api/
├── .github/
│   └── workflows/
│       ├── release.yml              # GitHub Actions 自動發布（tag → Release + assets）
│       └── nodejs-ci.yml            # Node.js CI（build + test + npm audit gate）
├── python/                          # Python 版本
│   ├── main.py                      # 程式進入點
│   ├── config.py                    # 環境變數配置
│   ├── updater.py                   # 自動更新工具（從 GitHub Releases 拉取最新版）
│   ├── requirements.txt             # Python 依賴
│   ├── .env.example                 # 環境變數範本
│   ├── api/                         # API 代理伺服器
│   │   ├── server.py                # FastAPI 路由定義
│   │   ├── key_selector.py          # 多金鑰選擇 + Circuit Breaker
│   │   ├── middleware.py            # 認證中間件
│   │   ├── rate_limiter.py          # 速率限制中間件（RPM/TPM 配額管控）
│   │   ├── quota_checker.py         # 配額檢查中間件（有效模型限制檢查 + 快取）
│   │   ├── usage_tracker.py         # 用量追蹤
│   │   ├── responses.py             # 回應格式處理
│   │   ├── anthropic_out.py         # Anthropic 輸出轉換
│   │   ├── thinking_parser.py       # Thinking Effort 推理強度解析與注入
│   │   └── providers/               # 各供應商適配器
│   │       ├── openai.py            #   openai_chat (Chat Completions)
│   │       ├── openai_response.py   #   openai_response (Responses API)
│   │       ├── anthropic.py
│   │       └── google.py
│   ├── bot/                         # Telegram Bot
│   │   ├── filters.py               # 消息過濾器
│   │   ├── keyboards.py             # 鍵盤 UI 元件
│   │   ├── handlers/                # 指令處理器
│   │   │   ├── admin_handlers.py    #   管理員指令（/provider /admin_user 等）
│   │   │   ├── user_handlers.py     #   用戶指令（/url /key /usage /coding 等）
│   │   │   ├── model_fetcher.py     #   模型清單抓取
│   │   │   ├── limit_handlers.py    #   模型限制管理（/limits /my_limits）
│   │   │   └── update_handlers.py   #   版本更新（/version /update /restart）
│   │   └── conversations/           # 多輪對話流程
│   ├── db/                          # 資料庫
│   │   ├── database.py              # SQLite 操作
│   │   └── models.py                # 資料模型
│   └── tests/                       # 測試（219 tests）
│
├── nodejs/                          # Node.js 版本
│   ├── src/
│   │   ├── index.ts                 # 程式進入點
│   │   ├── config.ts                # 環境變數配置
│   │   ├── updater.ts               # 自動更新工具（從 GitHub Releases 拉取最新版）
│   │   ├── net.ts                   # 網路工具（代理/鏡像注入、連通性診斷）
│   │   ├── tunnel.ts                # Cloudflare Tunnel 隧道（quick 臨時 URL / token 命名隧道）
│   │   ├── api/                     # API 代理伺服器
│   │   │   ├── server.ts            #   Express 主程式（掛載 Web 靜態檔 + 路由）
│   │   │   ├── apiLogStore.ts       #   API 請求日誌（環形緩衝區，記憶體中保留最近 50 筆）
│   │   │   ├── keySelector.ts       #   多金鑰選擇 + Circuit Breaker（failover / round_robin / random）
│   │   │   ├── middleware.ts        #   認證中間件（/web 路徑豁免 API Key 檢查）
│   │   │   ├── rateLimiter.ts       #   速率限制中間件（RPM/TPM 配額管控）
│   │   │   ├── quotaChecker.ts      #   配額檢查中間件（有效模型限制檢查 + 快取）
│   │   │   ├── usageTracker.ts
│   │   │   ├── responses.ts
│   │   │   ├── anthropic_out.ts
│   │   │   ├── thinkingParser.ts    #   Thinking Effort 推理強度解析與注入
│   │   │   └── providers/           #   各供應商適配器
│   │   │       ├── openai.ts        #     openai_chat (Chat Completions)
│   │   │       ├── openaiResponse.ts#     openai_response (Responses API)
│   │   │       ├── anthropic.ts
│   │   │       └── google.ts
│   │   ├── bot/                     # Telegram Bot
│   │   │   ├── filters.ts
│   │   │   ├── keyboards.ts
│   │   │   ├── handlers/
│   │   │   │   ├── adminHandlers.ts #   管理員指令（內嵌 Web 按鈕）
│   │   │   │   ├── userHandlers.ts  #   用戶指令（/start 含 Web 登入連結）
│   │   │   │   ├── modelFetcher.ts  #   模型清單抓取（協議偵測 + 模型 + 定價）
│   │   │   │   ├── limitHandlers.ts #   模型限制管理（內嵌 Web 按鈕）
│   │   │   │   ├── webHandlers.ts   #   /web 指令 + OTP 登入連結產生
│   │   │   │   └── updateHandlers.ts#   版本更新
│   │   │   └── conversations/
│   │   ├── web/                     # Web 控制台後端
│   │   │   ├── routes.ts            #   /web/api/* REST API 路由
│   │   │   └── auth.ts              #   OTP + Session 認證系統
│   │   └── db/
│   │       └── database.ts
│   ├── web/                         # Web 控制台前端（靜態檔案）
│   │   ├── index.html               #   HTML 骨架 + SVG 導航圖標
│   │   ├── app.js                   #   Vanilla JS SPA（hash 路由 + API 呼叫）
│   │   └── style.css                #   暗色主題 CSS（響應式設計）
│   ├── start.js                     # 容器通用啟動腳本（自動偵測模式）
│   ├── package.json
│   ├── tsconfig.json
│   ├── .npmrc                       # npm 配置（低記憶體容器優化）
│   ├── .env.example
│   ├── CHANGELOG.md                 # 版本變更記錄
│   ├── VERSION                      # 當前版本號
│   ├── .node-version                # Node.js 版本釘定（Active LTS）
│   ├── .nvmrc                       # nvm 版本指定
│   └── scripts/
│       └── release.ts               # 發布腳本（版本管理 + tag + GitHub Release）
│
└── README.md
```

## 技術棧

| | Python 版本 | Node.js 版本 |
|---|---|---|
| Bot 框架 | python-telegram-bot | grammY |
| Web 框架 | FastAPI + Uvicorn | Express |
| Web 控制台前端 | — | Vanilla JS SPA（無框架，hash 路由） |
| HTTP 用戶端 | httpx | — |
| 資料庫 | aiosqlite (SQLite) | sql.js (WASM SQLite) |
| UUID | uuid-utils | uuid |
| 語言 | Python 3.10+ | TypeScript / Node.js 22 LTS+ |

## License

MIT

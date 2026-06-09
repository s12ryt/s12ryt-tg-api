# s12ryt-tg-api

透過 Telegram Bot 管理多個 AI API 供應商的聚合代理服務。支援 OpenAI、Anthropic、Google 等供應商，並對外提供統一的 OpenAI 相容 API 端點，讓你能用一套 API 金鑰存取所有 AI 模型。

提供 **Python** 和 **Node.js** 兩種實作版本。

## 特色

- **多供應商聚合** — 統一管理 OpenAI / Anthropic / Google 等 AI API
- **OpenAI 相容 API** — 對外暴露 `/v1/chat/completions`、`/v1/responses` 端點，可直接替換現有 OpenAI 客戶端
- **Anthropic 相容 API** — 提供 `/v1/messages` 端點，相容 Anthropic Messages API 格式
- **格式自動轉換** — 三種 API 格式（Chat Completions / Responses / Messages）之間自動雙向轉換，任一端點可路由到任意供應商
- **API 協議自動偵測** — 新增供應商時自動 ping 各端點，顯示連通狀態輔助選擇類型
- **Telegram Bot 管理** — 所有操作透過 Telegram Bot 完成，無需 Web 後台
- **每模型獨立定價** — 自動從 [models.dev](https://models.dev) 獲取各模型定價（USD / 1M tokens），支援 per-model 計費
- **Token 用量追蹤** — 自動記錄每個 API Key 的輸入/輸出 Token 數與費用
- **串流支援 (SSE)** — 支援 Server-Sent Events 即時串流回應
- **效能優化** — Provider routing 快取、API Key LRU 快取、用量寫入佇列批量刷入
- **雙語言實作** — Python (FastAPI + python-telegram-bot) 與 Node.js (Express + grammY)

## 架構

```
┌──────────────┐     ┌───────────────┐     ┌───────────┐     ┌──────────────────┐     ┌──────────────────┐
│  Telegram    │────▶│  Bot Handlers │────▶│ SQLite DB │     │  API Proxy       │────▶│  AI Providers    │
│  User / Admin│     │  (指令處理)    │     │           │     │  (/v1/chat/...)  │     │                  │
└──────────────┘     └───────────────┘     └─────┬─────┘     └────────┬─────────┘     ├──────────────────┤
                           ▲                     │                    │               │  OpenAI Chat     │
                           │                     └────────────────────┘               ├──────────────────┤
                           │                     (API Key 驗證 & 用量記錄)              │  OpenAI Response │
                           └──────────────────────────────────────────────────────────├──────────────────┤
                                                                                       │  Anthropic       │
                                                                                       ├──────────────────┤
                                                                                       │  Google          │
                                                                                       └──────────────────┘
```

## Bot 指令

### 一般用戶指令

需為管理員加入的信任用戶才能使用。

| 指令 | 說明 |
|------|------|
| `/start` | 顯示歡迎訊息 |
| `/url` | 取得目前 API 端點 URL |
| `/key` | 取得現有 API Key（首次使用自動建立，格式：`sk-s12ryt-{uuid-v7}`） |
| `/usage` | 查看各 API Key 的 Token 用量與費用 |
| `/key_add` | 新增一組 API Key |
| `/key_del` | 刪除 API Key（支援多選，回覆 `1,2` 即可刪除多個） |

### 管理員指令

僅限 `ADMIN_ID` 對應的用戶使用。

| 指令 | 說明 |
|------|------|
| `/add` | 新增 AI 供應商（多輪對話：名稱 → 端點 → Key → 自動偵測協議 → 選擇類型 → 模型 → 定價） |
| `/del` | 刪除供應商（支援多選） |
| `/list` | 列出所有供應商及其用量統計 |
| `/edit` | 編輯供應商設定（多輪對話） |
| `/uu` | 查看所有用戶的 API Key 用量 |
| `/admin_rm_userkey` | 移除任意用戶的 API Key（支援多選） |
| `/sub_url` | 設定/覆蓋 API 端點 URL |
| `/add_user` | 新增信任用戶 |
| `/stop_user` | 停用信任用戶（支援多選，停用後會通知被停用戶） |
| `/del_user` | 刪除信任用戶（支援多選） |
| `/edit_user` | 編輯用戶的 Telegram ID |

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

## 效能優化

| 優化項目 | 說明 |
|----------|------|
| **Provider routing 快取** | 記憶體中維護 `model_name → provider` 映射，避免每次請求查 DB |
| **API Key LRU 快取** | 256 條目的 LRU cache，認證時省去 2 次 DB 查詢 |
| **用量寫入佇列** | 每 5 秒或累積 100 筆批量刷入 DB（單一交易），降低 SQLite 寫入瓶頸 |
| **Model Prices 單一交易** | `batch_upsert_model_prices` 在同一交易中完成所有 upsert |
| **快取自動失效** | Provider 增刪改時自動重建快取（`process.nextTick` / `asyncio.ensure_future` 批次化） |

## 支援的供應商

| 供應商 | API 類型 | 說明 | 認證方式 |
|--------|----------|------|----------|
| OpenAI (Chat Completions) | `openai_chat` | OpenAI 相容 `/chat/completions` 端點 | `Authorization: Bearer {key}` |
| OpenAI (Responses API) | `openai_response` | OpenAI 新版 `/responses` 端點 | `Authorization: Bearer {key}` |
| Anthropic | `anthropic` | Anthropic Messages API | `x-api-key: {key}` 標頭 |
| Google | `google` | Google Gemini API | `?key={key}` 查詢參數 |

> 💡 新增供應商時，系統會自動偵測端點支援的 API 協議並顯示連通狀態（✅/❌），輔助你選擇正確的類型。三種 API 格式之間會自動轉換，你只需要關注上游供應商實際支援的協議。

### 格式轉換矩陣

| 請求端點 | openai_chat 供應商 | openai_response 供應商 | anthropic 供應商 | google 供應商 |
|----------|-------------------|----------------------|-----------------|--------------|
| `/v1/chat/completions` | 直接轉發 | chat→responses→chat | chat→messages→chat | 直接轉發 |
| `/v1/responses` | responses→chat→responses | 直接轉發 | responses→chat→messages→responses | responses→chat→responses |
| `/v1/messages` | messages→chat→messages | messages→chat→responses→messages | 直接轉發 | messages→chat→messages |

## 專案結構

```
s12ryt-tg-api/
├── python/                          # Python 版本
│   ├── main.py                      # 程式進入點
│   ├── config.py                    # 環境變數配置
│   ├── requirements.txt             # Python 依賴
│   ├── .env.example                 # 環境變數範本
│   ├── api/                         # API 代理伺服器
│   │   ├── server.py                # FastAPI 路由定義
│   │   ├── middleware.py            # 認證中間件
│   │   ├── usage_tracker.py         # 用量追蹤
│   │   ├── responses.py             # 回應格式處理
│   │   ├── anthropic_out.py         # Anthropic 輸出轉換
│   │   └── providers/               # 各供應商適配器
│   │       ├── openai.py            #   openai_chat (Chat Completions)
│   │       ├── openai_response.py   #   openai_response (Responses API)
│   │       ├── anthropic.py
│   │       └── google.py
│   ├── bot/                         # Telegram Bot
│   │   ├── filters.py               # 消息過濾器
│   │   ├── keyboards.py             # 鍵盤 UI 元件
│   │   ├── handlers/                # 指令處理器
│   │   │   ├── admin_handlers.py
│   │   │   ├── user_handlers.py
│   │   │   └── model_fetcher.py
│   │   └── conversations/           # 多輪對話流程
│   ├── db/                          # 資料庫
│   │   ├── database.py              # SQLite 操作
│   │   └── models.py                # 資料模型
│   └── tests/                       # 測試
│
├── nodejs/                          # Node.js 版本
│   ├── src/
│   │   ├── index.ts                 # 程式進入點
│   │   ├── config.ts                # 環境變數配置
│   │   ├── api/                     # API 代理伺服器
│   │   │   ├── server.ts
│   │   │   ├── middleware.ts
│   │   │   ├── usageTracker.ts
│   │   │   ├── responses.ts
│   │   │   ├── anthropic_out.ts
│   │   │   └── providers/           # 各供應商適配器
│   │   │       ├── openai.ts        #   openai_chat (Chat Completions)
│   │   │       ├── openaiResponse.ts#   openai_response (Responses API)
│   │   │       ├── anthropic.ts
│   │   │       └── google.ts
│   │   ├── bot/                     # Telegram Bot
│   │   │   ├── filters.ts
│   │   │   ├── keyboards.ts
│   │   │   ├── handlers/
│   │   │   │   ├── adminHandlers.ts
│   │   │   │   ├── userHandlers.ts
│   │   │   │   └── modelFetcher.ts
│   │   │   └── conversations/
│   │   └── db/
│   │       └── database.ts
│   ├── package.json
│   ├── tsconfig.json
│   └── .env.example
│
└── README.md
```

## 技術棧

| | Python 版本 | Node.js 版本 |
|---|---|---|
| Bot 框架 | python-telegram-bot | grammY |
| Web 框架 | FastAPI + Uvicorn | Express |
| HTTP 用戶端 | httpx | — |
| 資料庫 | aiosqlite (SQLite) | sql.js (WASM SQLite) |
| UUID | uuid-utils | uuid |
| 語言 | Python 3.10+ | TypeScript / Node.js 18+ |

## License

MIT

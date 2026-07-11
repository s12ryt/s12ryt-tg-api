# Node.js 插件範例 (v2.0.0)

這個資料夾是一個可直接啟用的 Node.js-only 插件範例，完整展示 `s12ryt-tg-api` 插件系統的**全部六大服務**（auth、storage、events、scheduler、providers、db）以及多服務串接的綜合場景。

## v1 → v2 變更摘要

| 項目 | v1.0.0 | v2.0.0 |
|------|--------|--------|
| 展示服務 | auth、db、providers（部分） | **全部 6 大服務** |
| API 路由 | 3 個（status、me、echo） | **26 個**（逐項展示 + 綜合儀表板） |
| Bot 指令 | 1 個 | **3 個**（info、用量查詢、storage 查看） |
| async 修正 | `getUserByTelegramId` 未 await（bug） | 所有 async 呼叫正確 await |
| 生命週期 | 只 log | onStart 發事件、onStop 清理計時器 |
| 錯誤處理 | 無 | asyncHandler 包裝 + 輸入驗證 |

## 相關倉庫

- 主專案：[`s12ryt/s12ryt-tg-api`](https://github.com/s12ryt/s12ryt-tg-api)
- 獨立插件範例：[`s12ryt/s12ryt-nodejs-plugin-example`](https://github.com/s12ryt/s12ryt-nodejs-plugin-example)

## 檔案結構

```text
./
├── dist/index.js      # 可被主程式直接載入的 ESM 插件（純 JS）
├── src/index.ts       # TypeScript 撰寫版本，含核心型別標注
├── package.json       # 範例插件套件資訊
├── plugin.json        # 插件描述檔，供人工或工具讀取
└── README.md          # 本說明文件
```

## 安裝方式

### Web Console（建議）

管理員登入 Web Console 後進入「插件管理」，可以用兩種方式安裝：

1. 匯入本機檔案：選擇 `dist/index.js`，按「安裝檔案」。
2. 從 GitHub 安裝：貼上 GitHub repo、tree、blob 或 raw 連結。若貼 repo/tree 連結，系統會讀取 `plugin.json` 的 `main` 欄位取得入口檔。

### 環境變數（進階備援）

```env
NODEJS_PLUGIN_PATHS=../plugin-example/dist/index.js
```

支援逗號或分號分隔多個插件，也可指向包含 `plugin.json` 的目錄。

## API 路由總覽

所有路由掛在 `/plugins/nodejs-example/` 下，沿用核心 API Key 認證、速率限制與配額檢查。

### Base

| 方法 | 路徑 | 說明 | 展示的服務 |
|------|------|------|------------|
| `GET` | `/status` | 插件完整狀態 + 路由清單 | — |
| `GET` | `/dashboard` | 綜合儀表板（4 服務並行查詢） | auth + db + providers + storage |

### Auth（services.auth）

| 方法 | 路徑 | 說明 | async |
|------|------|------|:-----:|
| `GET` | `/auth/me` | 認證資訊 + admin/trusted 判斷 | ✓ |

### Storage（services.storage）

| 方法 | 路徑 | 說明 | async |
|------|------|------|:-----:|
| `GET` | `/storage` | 列出所有 keys | |
| `GET` | `/storage/:key` | 讀取值 | |
| `POST` | `/storage/:key` | 寫入值（body: `{"value": <any>}`） | |
| `DELETE` | `/storage/:key` | 刪除值 | |

### Events（services.events）

| 方法 | 路徑 | 說明 | async |
|------|------|------|:-----:|
| `POST` | `/events/emit` | 發布事件（body: `{"name": "...", "payload": <any>}`） | ✓ |
| `GET` | `/events/listeners/:name` | 查看監聽器數量 | |
| `GET` | `/events/log` | 查看近期事件記錄 | |

### Scheduler（services.scheduler）

| 方法 | 路徑 | 說明 | async |
|------|------|------|:-----:|
| `POST` | `/scheduler/timeout` | 延遲任務（body: `{"delayMs": 5000, "note": "..."}`） | |
| `POST` | `/scheduler/interval` | 定時任務（body: `{"intervalMs": 10000, "note": "..."}`） | |
| `DELETE` | `/scheduler/:id` | 取消計時器 | |
| `GET` | `/scheduler/active` | 查看活躍計時器 + 近期觸發記錄 | |

### Providers（services.providers）

| 方法 | 路徑 | 說明 | async |
|------|------|------|:-----:|
| `GET` | `/providers/list` | 供應商列表（`?enabled=true` 僅啟用） | ✓ |
| `GET` | `/providers/models` | 所有模型名稱 | |
| `GET` | `/providers/lookup/:model` | 查找模型對應的供應商 | |
| `GET` | `/providers/:id/prices` | 供應商的模型定價 | ✓ |
| `GET` | `/providers/mappings` | 模型顯示名映射 | ✓ |

### DB（services.db）

| 方法 | 路徑 | 說明 | async |
|------|------|------|:-----:|
| `GET` | `/db/me` | 當前用戶資訊 | ✓ |
| `GET` | `/db/keys` | API Key 預覽列表（末 12 碼） | ✓ |
| `GET` | `/db/limits` | 有效限制（RPM/TPM/配額） | ✓ |
| `GET` | `/db/usage/daily` | 今日用量 | ✓ |
| `GET` | `/db/usage/monthly` | 本月用量 | ✓ |
| `GET` | `/db/models/allowed` | 允許使用的模型清單 | ✓ |

## 範例請求

```bash
# 插件狀態
curl http://localhost:8000/plugins/nodejs-example/status \
  -H "Authorization: Bearer sk-s12ryt-your-key-here"

# 綜合儀表板
curl http://localhost:8000/plugins/nodejs-example/dashboard \
  -H "Authorization: Bearer sk-s12ryt-your-key-here"

# 寫入 storage
curl -X POST http://localhost:8000/plugins/nodejs-example/storage/myKey \
  -H "Authorization: Bearer sk-s12ryt-your-key-here" \
  -H "Content-Type: application/json" \
  -d '{"value": {"hello": "world"}}'

# 發布事件
curl -X POST http://localhost:8000/plugins/nodejs-example/events/emit \
  -H "Authorization: Bearer sk-s12ryt-your-key-here" \
  -H "Content-Type: application/json" \
  -d '{"name": "plugin:demo", "payload": {"msg": "hello"}}'

# 設定延遲任務（5 秒後觸發）
curl -X POST http://localhost:8000/plugins/nodejs-example/scheduler/timeout \
  -H "Authorization: Bearer sk-s12ryt-your-key-here" \
  -H "Content-Type: application/json" \
  -d '{"delayMs": 5000, "note": "test timer"}'

# 查看允許的模型
curl http://localhost:8000/plugins/nodejs-example/db/models/allowed \
  -H "Authorization: Bearer sk-s12ryt-your-key-here"
```

## Bot 指令

| 指令 | 權限 | 說明 |
|------|------|------|
| `/plugin_example` | 所有人 | 顯示插件資訊與可用路由 |
| `/my_usage` | Trusted User | 查看今日/本月 API 用量（展示 bot handler + services.db） |
| `/plugin_data` | Admin | 查看 storage 中儲存的資料 |

實務插件的業務權限需要插件自行檢查。核心系統只負責把插件命令接入 grammY middleware 鏈。

## 綜合場景

### Dashboard（4 服務並行）

`GET /dashboard` 在單一請求中並行查詢 5 個 async 操作 + 1 個 sync 操作：

```text
auth.requireRequestAuth     → 取得 AuthInfo
auth.isAdminTelegramUser    → 判斷管理員
db.getUserByTelegramId      → 用戶資料      ┐
db.getDailyUsage            → 今日用量      │ Promise.all
db.getMonthlyUsage          → 本月用量      │ 並行查詢
providers.listModels        → 全部模型      │
providers.list(enabledOnly) → 啟用供應商    ┘
storage.get("preferences")  → 儲存偏好      （同步）
```

### 生命週期事件 + 計時器清理

- `onStart`：記錄啟動時間到 storage，發布 `plugin:started` 事件。
- `onStop`：發布 `plugin:stopped` 事件，呼叫 `scheduler.clearAll()` 清理所有計時器，記錄運行時間。

### Bot 指令中的權限檢查 + DB 查詢

`/my_usage` 展示了在 grammY handler 中：
1. `auth.requireTrustedTelegramUser()` — 權限檢查（async）
2. `db.getUserByTelegramId()` — 查用戶（async）
3. `db.getDailyUsage()` + `db.getMonthlyUsage()` — 查用量（async）

## 插件介面

每個插件預設匯出一個物件：

```ts
import type { NodeJsPlugin } from "../../nodejs/src/plugins/types.js";

const plugin: NodeJsPlugin = {
  name: "nodejs-example",
  version: "2.0.0",
  setup(context) {
    // 註冊路由、middleware、事件監聽器、Bot 指令
    context.usePluginMiddleware((_req, res, next) => {
      res.setHeader("X-Plugin-Name", context.name);
      next();
    });

    context.router.get("/status", (_req, res) => {
      res.json({ ok: true });
    });
  },
  async onStart(context) {
    // 插件啟動後執行（可用 await）
    await context.services.events.emit("plugin:started", {});
  },
  async onStop(context) {
    // 清理資源
    context.services.scheduler.clearAll();
  },
};

export default plugin;
```

### context.services 方法速查

| 服務 | 方法 | 回傳 | async |
|------|------|------|:-----:|
| **auth** | `requireRequestAuth(req)` | `AuthInfo` | |
| | `isAdminTelegramUser(tgId)` | `boolean` | |
| | `isTrustedTelegramUser(tgId)` | `Promise<boolean>` | ✓ |
| | `requireTrustedTelegramUser(tgId)` | `Promise<void>` | ✓ |
| **storage** | `get(key)` / `set(key, val)` / `delete(key)` | 同步 | |
| | `has(key)` / `keys()` / `clear()` | 同步 | |
| **events** | `on(name, handler)` / `once(name, handler)` | unsubscribe | |
| | `emit(name, payload)` | `Promise<void>` | ✓ |
| | `listenerCount(name)` | `number` | |
| **scheduler** | `setTimeout(fn, ms)` / `setInterval(fn, ms)` | timerId | |
| | `clear(id)` / `clearAll()` | 同步 | |
| **providers** | `list({enabledOnly})` / `getById(id)` | `Promise<...>` | ✓ |
| | `getModelPrices(id)` / `getModelMappings()` | `Promise<...>` | ✓ |
| | `listModels()` / `lookupModel(name)` | 同步 | |
| **db** | `getUserByTelegramId(tgId)` / `getUserById(id)` | `Promise<...>` | ✓ |
| | `listApiKeyPreviewsByTelegramId(tgId)` | `Promise<...>` | ✓ |
| | `getEffectiveLimits(userId, apiKeyId)` | `Promise<...>` | ✓ |
| | `getDailyUsage(userId, keyId?)` / `getMonthlyUsage(...)` | `Promise<...>` | ✓ |
| | `checkModelAllowed(...)` / `getAllowedModels(...)` | `Promise<...>` | ✓ |

> **重要**：標記 ✓ 的方法回傳 Promise，**必須 await**。忘記 await 是最常見的 bug。
> v1 範例就有這個問題（`getUserByTelegramId` 未 await），v2 已修正。

### async 路由的正確寫法

Express 不會自動捕捉 async handler 的 rejection。使用包裝器：

```ts
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

router.get("/db/me", asyncHandler(async (req, res) => {
  const auth = services.auth.requireRequestAuth(req);
  const user = await services.db.getUserByTelegramId(auth.tgUserId); // ← await!
  res.json({ user });
}));
```

## 安全注意事項

- 插件只在 Node.js 版本中載入，不依賴已停止維護的 Python 版本。
- 插件可由 Web Console 管理員匯入檔案或 GitHub 連結；`NODEJS_PLUGIN_PATHS` 僅作為進階手動載入方式。
- 插件檔案會在主程式程序內執行，請只載入可信任程式碼。
- Web 安裝目前限制 `.js` / `.mjs` 入口檔，大小上限 10MB。
- 插件路由預設沿用 API Key 認證、rate limit 與 quota middleware。
- 插件 Bot 指令的業務權限需要插件自行檢查。
- `context.services.providers` 和 `context.services.db` 會遮蔽 API Key、provider base URL 等敏感資料；不要改用核心內部 DB 函式繞過這層限制。
- `context.services.storage` 資料目前不會進入主程式 `/backup` JSON，若插件需要備份請自行提供匯出流程。
- 不要在插件回應中輸出 API Key、Bot Token、資料庫路徑或其他敏感設定。

## 開發建議

- 將插件名稱視為公開路由的一部分，發布後不要隨意改名。
- 在 `setup()` 中只做路由與指令註冊，長時間任務放到 `onStart()`。
- 在 `onStop()` 清理計時器、連線、檔案 handle。
- 避免直接 import 核心內部模組；優先使用 `PluginContext` 暴露的穩定能力。
- 優先使用 `context.services.scheduler` 建立計時器，讓核心能在插件停止時清理資源。
- **所有標記 async 的 services 方法都必須 await**，否則會得到 Promise 物件而非實際資料。
- async Express handler 需用 `asyncHandler` 包裝，避免未捕捉的 rejection。
- 多個獨立的 async 操作用 `Promise.all` 並行執行以提升效能。

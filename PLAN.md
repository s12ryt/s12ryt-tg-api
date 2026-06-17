# 實作計劃：模型映射 + API 日誌

## 概覽

兩個獨立的 Web 管理員功能，各自獨立的導航頁面：

| 功能 | 目標 |
|------|------|
| **模型映射** | 管理員可為每個供應商的每個模型設定顯示名稱（display name），對外 `/v1/models` 顯示 display name，對上游調用使用原始名稱 |
| **API 日誌** | 內存保存近期 50 條 API 詳細調用記錄（含系統提示詞和參數），管理員可查看 |

---

## 功能 1：模型映射

### 設計決策

1. **無映射 = 透明**：模型沒有設定映射時，display name = original name（完全向後相容）
2. **cache key 改為 display name**：providerCache 的 key 從 original name 改為 display name，`CachedProvider` 新增 `originalModel` 欄位記住真實名
3. **dispatch 時替換**：`dispatchWithFallback()` 內部將 `body.model` 替換為 `resolved.originalModel`，確保發給上游的是真實模型名
4. **display name 衝突**：如果兩個 provider 映射成同名 display name，後載入的覆蓋先載入的（與目前 cache 行為一致）。前端會提示衝突但不阻止

### 改動清單

#### 1.1 `database.ts` — 資料層 + 快取

**新增表**：
```sql
CREATE TABLE IF NOT EXISTS model_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id INTEGER NOT NULL,
  original_model TEXT NOT NULL,
  display_name TEXT NOT NULL,
  UNIQUE(provider_id, original_model)
);
```

**修改 `CachedProvider` interface**：新增 `originalModel: string`

**修改 `rebuildProviderCache()`**：
- 先載入所有 model_mappings 到 `Map<"pid:originalModel", displayName>`
- 對每個 provider 的每個 model：
  - 查映射表，有映射 → cache key = display_name，`originalModel` = original
  - 無映射 → cache key = original name，`originalModel` = original（透明）

**新增 CRUD 函數**：
- `getModelMappings(): { provider_id, provider_name, original_model, display_name }[]`
- `upsertModelMapping(providerId, originalModel, displayName): void`
- `deleteModelMapping(providerId, originalModel): void`
- 變動後呼叫 `invalidateProviderCache()`

#### 1.2 `server.ts` — 路由層

**修改 `ResolvedProvider` interface**：新增 `originalModel: string`

**修改 `lookupModelDb()`**：返回值帶上 `cached.originalModel`

**修改 `dispatchWithFallback()`**：
- Normal 模式 (line 244-273)：`body.model = resolved.originalModel` 後再傳給 `providerModule.chatCompletion()`
- Coding 模式 (line 214-240)：每個 fallback model lookup 後 `fbBody.model = fbResolved.originalModel`

**修改 `/v1/responses` 直通路徑** (line 665-720)：
- openai_response 直通時 `body.model = _resolved.originalModel`

#### 1.3 `web/routes.ts` — 管理員端點

- `GET /api/admin/model-mappings`：返回所有映射列表（含 provider 名稱）
- `PUT /api/admin/model-mappings`：接收 `{ mappings: [{ provider_id, original_model, display_name }] }`，批量 upsert + 刪除不在列表中的

#### 1.4 `web/app.js` — 前端頁面

**路由**：`#/model-mapping` → `pageModelMapping()`

**頁面邏輯**：
1. 載入所有 providers + 現有 mappings
2. 遍歷每個 provider 的每個 model，顯示為可編輯表格：
   - 欄位：「供應商 / 模型名稱」（格式：`供應商名稱/原始模型名稱`，唯讀）+「顯示名稱」（可編輯 input）
3. 底部「保存」按鈕 → 批量 PUT

#### 1.5 `web/index.html` — 導航

在 `#admin-nav` 新增導航項：
```html
<a href="#/model-mapping" class="nav-item" data-route="model-mapping">
  <span class="nav-icon">...</span>
  模型映射
</a>
```

---

## 功能 2：API 日誌

### 設計決策

1. **內存環形緩衝區**：50 條，不持久化（重啟清空），符合「近期」需求
2. **只記錄到達 dispatch 的請求**：驗證失敗（缺 model、model 不允許等）的請求不記錄，避免噪音
3. **記錄完整 body**：含 messages、system prompt、所有參數（body 不含 API key，安全無虞）
4. **記錄的欄位**：timestamp, path, method, model(display name), actualModel(original), providerName, username, body, responseStatus, error, inputTokens, outputTokens, latencyMs

### 改動清單

#### 2.1 新建模組 `api/apiLogStore.ts`

```typescript
interface ApiLogEntry {
  id: number;
  timestamp: string;       // ISO 8601
  path: string;            // /v1/chat/completions 等
  model: string;           // 用戶請求的 model（display name）
  actualModel: string;     // 實際調用的 original model
  providerName: string;
  username: string;        // tgUserId 轉換的用戶名
  body: Record<string, any>; // 完整請求體
  responseStatus: number;  // 200 / 400 / 502 等
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
}

// API:
export function addApiLog(entry: Omit<ApiLogEntry, "id">): void;
export function getApiLogs(): ApiLogEntry[];
```

環形緩衝區實作：固定大小陣列 + 迴卷索引。

#### 2.2 `server.ts` — 三個路由攔截

在 `/v1/chat/completions`、`/v1/responses`、`/v1/messages` 中：

**進入時**（dispatch 前建立記錄起點）：
```typescript
const logStart = Date.now();
```

**成功時**（dispatch 後、發送 response 前後）：
```typescript
addApiLog({
  timestamp: new Date().toISOString(),
  path: "/v1/chat/completions",
  model: modelName,
  actualModel: actualModel,
  providerName: dispatch.providerName (需在 DispatchResult 中加入),
  username: req.auth ? String(req.auth.tgUserId) : "unknown",
  body: { ...body },
  responseStatus: 200,
  inputTokens: usage.input_tokens,
  outputTokens: usage.output_tokens,
  latencyMs: Date.now() - logStart,
});
```

**失敗時**（dispatch catch 中）：
```typescript
addApiLog({
  ...,
  responseStatus: statusCode,
  error: err.message,
  latencyMs: Date.now() - logStart,
});
```

**需要修改 `DispatchResult`**：加入 `providerName: string`

**流式回應**：在 `finally` 區塊記錄（streamUsage 可取得 tokens）

#### 2.3 `web/routes.ts` — 管理員端點

- `GET /api/admin/api-logs`：返回 `ApiLogEntry[]`（按時間倒序）

#### 2.4 `web/app.js` — 前端頁面

**路由**：`#/api-logs` → `pageApiLogs()`

**頁面邏輯**：
1. 載入日誌列表
2. 表格顯示：時間 / 路徑 / 模型 / 供應商 / 用戶 / Tokens / 延遲 / 狀態
3. 每行有「查看詳情」按鈕 → Modal 顯示完整 body（JSON 格式化，含系統提示詞）

#### 2.5 `web/index.html` — 導航

在 `#admin-nav` 新增：
```html
<a href="#/api-logs" class="nav-item" data-route="api-logs">
  <span class="nav-icon">...</span>
  API 日誌
</a>
```

---

## 檔案改動總覽

| 檔案 | 功能1（模型映射） | 功能2（API日誌） |
|------|:-:|:-:|
| `src/db/database.ts` | ✅ 表+快取+CRUD | — |
| `src/api/server.ts` | ✅ dispatch 替換 model | ✅ 三路由記錄 |
| `src/api/apiLogStore.ts` | — | ✅ 新建模組 |
| `src/web/routes.ts` | ✅ 管理員端點 | ✅ 管理員端點 |
| `web/app.js` | ✅ 頁面+路由 | ✅ 頁面+路由 |
| `web/index.html` | ✅ 導航項 | ✅ 導航項 |

## 驗證策略

1. `tsc --noEmit` — 零型別錯誤
2. `vitest run` — 既有測試全通過 + 新增測試（模型映射快取、API Log 環形緩衝區）
3. 多角度挖蟲：display name 衝突、空映射、API Log 記憶體洩漏、body 淺拷貝

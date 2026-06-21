# Changelog

所有版本變更記錄。本檔案由 `npm run release` 自動維護。

## [1.7.10] - 2026-06-21

### 🐛 Bug Fixes
- preserve thinking content in streaming and non-streaming responses (ad3d5d4)

## [1.7.9] - 2026-06-21

- 維護更新

## [1.7.8] - 2026-06-20

- 維護更新

## [1.7.7] - 2026-06-20

### ✨ Features
- add /backup command with JSON file restore flow (6969007)
- add database export/import for backup and restore (46b7a59)
- add messages API direct pass-through and preserve reasoning blocks (8b004fd)

### 🐛 Bug Fixes
- misc reliability fixes across key selector, model fetcher, update handlers, and database (e56d8e7)
- harden /v1/models endpoint and enforce model restrictions in coding-mode fallback (7331b6e)
- validate key ownership on admin key deletion and simplify models route (85b3aa0)
- re-check admin status per-request in web auth middleware (dcac023)

### 📝 Documentation
- add API format conversion matrix to README (9ca943a)

### ✅ Tests
- add IDOR and model access restriction tests for Node.js (b6290b0)

## [1.7.6] - 2026-06-19

### 🐛 Bug Fixes
- align UsageQuota fields with frontend expectations (v1.7.6) (5ad8dca)

## [1.7.6] - 2026-06-20

### 🐛 Bug Fixes
- fix dashboard showing all zeros — align `UsageQuota` interface fields with frontend expectations (`total_input_tokens` / `total_output_tokens` / `total_cost` instead of camelCase `totalTokens` / `totalCost`), split `getPeriodUsage` SQL into separate `SUM(input_tokens)` and `SUM(output_tokens)`

## [1.7.5] - 2026-06-19

### 🐛 Bug Fixes
- fix streaming requests not recording token usage — inject `stream_options.include_usage` on all three endpoints (`/v1/chat/completions`, `/v1/responses`, `/v1/messages`) and extract nested `response.usage` from SSE chunks (49ae69e)

## [1.7.4] - 2026-06-19

### 🐛 Bug Fixes
- repair admin global usage page and per-model cost calculation (3f43bde)

## [1.7.3] - 2026-06-19

### ✨ Features
- expand thinking effort to 6 levels (xhigh/high/medium/low/minimal/none) (5a6dc87)
- support Node.js 22 LTS (broaden engines, CI matrix 22+24) (bda6620)

### 🐛 Bug Fixes
- add BUILD_ONLY mode for CI/Netlify build environments (04128e3)
- add global setup for env vars in CI (d20727b)
- correct .nvmrc path for setup-node action (8f48599)

### 📦 Other
- Revert "fix(start): add BUILD_ONLY mode for CI/Netlify build environments" (d4294c7)

## [1.7.2] - 2026-06-18

### ✨ Features
- auto-fallback to built-in mirrors on network failure (d7c7ff3)
- add proxy, mirror, retry and connectivity diagnostics (2c922fc)

### 🐛 Bug Fixes
- remediate npm audit advisories (9d881f6)
- inject proxy and registry mirror into npm install (c246e66)

### ⚡ Performance
- optimize for low-resource containers (da0d102)

### 📝 Documentation
- document supported lts runtime (f1b5977)

### 🔧 CI
- add build test audit gate (4ed50b1)

### 📦 Other
- pin active lts runtime version (2cae433)

## [Unreleased]

### ✨ Features
- expand thinking effort from 3 levels (high/medium/low) to 6 (xhigh/high/medium/low/minimal/none) with full OpenAI/Anthropic/Google mapping
- return HTTP 400 with clear error message for invalid thinking level suffix (e.g. `model(extreme)`) instead of silent failure
- support Node.js 22 LTS (broaden engines from >=24 to >=22, CI matrix tests 22+24)

### ⚡ Performance
- optimize updater and start.js for low-resource containers (memory-adaptive heap sizing, timeout scaling, streaming download)
- reduce API log memory footprint with request body truncation (keep first 3 + last 1 message)
- avoid buffer copy in database saveDb (direct Uint8Array write to disk)
- constrain npm concurrency in low-memory environments (maxsockets=2, fund/audit disabled)

### 🐛 Bug Fixes
- clear provider key state on provider deletion (prevents stale state memory leak)
- propagate NODE_OPTIONS heap flag to restarted process in Blue-Green update
- return unsubscribe function from onProviderCacheRebuild (proper cleanup)
- fix admin global usage page showing empty (getTotalUsage now returns `total_requests`, `by_provider`, and `by_user` breakdown matching frontend expectations)
- fix per-model cost showing 0 in user usage page (operator precedence: `(a + b) || 0` → `(a || 0) + (b || 0)`)

## [1.7.1] - 2026-06-17

### ✨ Features
- integrate Cloudflare Tunnel for public API access (f029b41)

### 📦 Other
- add cloudflared dependency (10654c4)
- Delete PLAN.md (f4be2af)

## [1.7.0] - 2026-06-17

### ✨ Features
- add model mapping and API log pages to web console (6937325)
- add model mapping and API log admin endpoints to web routes (b2c39fe)
- add model name remapping and API request logging to server (50d8947)
- add in-memory API log ring buffer store (1e0a1fd)
- add model mapping table and cache support to database (286af7e)

### 🐛 Bug Fixes
- use display names in /v1/models response via provider cache (17ce867)

## [1.6.0] - 2026-06-17

### ✨ Features
- improve web console API key and provider form UI (9cbdcfa)
- add API key view/copy endpoint and key strategy to web routes (be1862b)
- add key selection strategy (round-robin, random, failover) backend (e3d73f3)

## [1.5.0] - 2026-06-17

### ✨ Features
- add group management UI with model picker to web console (139c99b)
- add group model restriction and set-default-group backend (83c1bac)

## [1.4.1] - 2026-06-17

### 🐛 Bug Fixes
- print all update subprocess output to console (da442f1)
- optimize npm install for low-memory containers in Blue-Green update (66344d8)

## [1.4.0] - 2026-06-17

- 維護更新

## [1.3.0] - 2026-06-17

### ✨ Features
- add universal container startup file with auto mode detection (6015700)
- add rollback support to Bot commands and Web console (f0f49ab)
- implement Blue-Green update mechanism with atomic swap and rollback (b4f7e62)
- integrate version fallback in Node.js and Python updaters (e73f0a7)
- add version management system with release script and CI workflow (3361cb5)

### 🐛 Bug Fixes
- auto-create user record when admin generates first API key (9fb37a7)
- add global /cancel interceptor to escape grammY conversations (6b002a1)
- convert start.js to ESM to support type:module package.json (73d92ee)

### ♻️ Refactor
- replace as any with typed interface for GitHub API response (7337c45)
- remove unused imports in bot handlers (dd60964)

### ✅ Tests
- add auth, web routes, and updater test suites (82 tests) (b858a40)

## [1.2.0] - 2025-06-16

### ✨ Features
- API 串流 SSE 跨 chunk 緩衝區修復，避免 JSON 在 TCP 邊界斷裂時遺失資料 (b255f5a)
- Web 控制台完整功能：12 個頁面、暗色主題、響應式設計 (3fa2bfa)
- 模型測試功能 + API 協議偵測頁面重新設計 (79a6298)
- Thinking Effort 推理強度支援（model 後綴 / reasoning_effort / thinking_effort）
- Toggle Switch 自定義 UI 組件 (3fa2bfa)

### 🐛 Bug Fixes
- SSE cross-chunk buffer bug in responses.ts, anthropic_out.ts, server.ts (b255f5a)
- seqCounter race condition（並發串流序號污染）(b255f5a)
- POST /web/api/admin/users 雙重 /web/ 前綴導致 404 (b255f5a)
- API.call 401 雙重觸發 bug（登入畫面 + 錯誤提示同時出現）(b255f5a)
- keySelector.ts Circuit Breaker 參數與 README 規格不符（5/300s → 3/60s）(b255f5a)

### ⚡ Performance
- TextEncoder 提升至模組級共享（responses.ts + anthropic_out.ts）(b255f5a)
- recordUsageAndCost() 提取消除 8 處重複用量記錄邏輯 (b255f5a)
- setupSSEHeaders() 提取消除 4 處重複 SSE 標頭設定 (b255f5a)
- lookupModelDb() 簡化快取命中/未命中路徑 (b255f5a)
- API.call AbortController 30s 超時 + 友善網路錯誤訊息 (b255f5a)

## [1.1.0] - 2025-06-15

### ✨ Features
- Web 控制台（OTP 認證、12 個功能頁面、暗色主題 SPA）
- 模型測試功能（供應商級 + 全協議偵測）
- API 協議偵測頁面重新設計（真實模型測試 4 種協議）
- Toggle Switch 自定義開關（替代原生 checkbox）
- SVG 圖標系統（24 個 Lucide 風格圖標）
- Thinking Effort 推理強度支援

## [1.0.0] - 2025-06-14

### ✨ Features
- 初始版本
- 多供應商聚合代理（OpenAI / Anthropic / Google）
- 三種 API 格式雙向轉換（Chat Completions / Responses / Messages）
- Telegram Bot 管理介面
- 權限管理系統（RPM/TPM/配額/模型限制）
- Coding Mode fallback 模型鏈
- 多金鑰負載均衡 + Circuit Breaker
- 內置更新系統（git pull + tarball 備援）

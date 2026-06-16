# Changelog

所有版本變更記錄。本檔案由 `npm run release` 自動維護。

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

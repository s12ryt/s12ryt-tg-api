/**
 * Tests for backup & restore handlers.
 *
 * Strategy: vi.mock all external dependencies (database, config, filters, grammy),
 * capture registered handlers via a mock Bot, then invoke them with mock contexts.
 *
 * The module-level `pendingRestores` Map in backupHandlers.ts persists across
 * tests within this file, so each restore test uses a unique userId to avoid
 * interference.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ═══════════════════════════════════════════════════════════════════════════
// Hoisted mocks — must run before vi.mock factory evaluation
// ═══════════════════════════════════════════════════════════════════════════

const mocks = vi.hoisted(() => {
  /** Handlers registered by registerBackupHandlers, keyed by "command:x" / "on:x" / "callbackQuery:x". */
  const capturedHandlers: Record<string, (...args: any[]) => Promise<void> | void> = {};
  const mockExportDatabase = vi.fn();
  const mockImportDatabase = vi.fn();
  const mockGetBackupSummary = vi.fn();
  const mockIsAdmin = vi.fn().mockReturnValue(true);
  return { capturedHandlers, mockExportDatabase, mockImportDatabase, mockGetBackupSummary, mockIsAdmin };
});

vi.mock("../src/db/database.js", () => ({
  exportDatabase: mocks.mockExportDatabase,
  importDatabase: mocks.mockImportDatabase,
  getBackupSummary: mocks.mockGetBackupSummary,
}));

vi.mock("../src/bot/filters.js", () => ({
  isAdmin: mocks.mockIsAdmin,
}));

vi.mock("../src/config.js", () => ({
  config: {
    BOT_TOKEN: "test-bot-token",
    ADMIN_ID: 123456789,
  },
}));

vi.mock("grammy", () => ({
  Bot: class {
    command(name: string, handler: any) {
      mocks.capturedHandlers[`command:${name}`] = handler;
    }
    on(filter: string, handler: any) {
      mocks.capturedHandlers[`on:${filter}`] = handler;
    }
    callbackQuery(name: string, handler: any) {
      mocks.capturedHandlers[`callbackQuery:${name}`] = handler;
    }
  },
  InlineKeyboard: class {
    buttons: { text: string; data: string }[] = [];
    text(label: string, data: string) {
      this.buttons.push({ text: label, data });
      return this;
    }
  },
  InputFile: class {
    data: unknown;
    name: string;
    constructor(data: unknown, name: string) {
      this.data = data;
      this.name = name;
    }
  },
}));

// ═══════════════════════════════════════════════════════════════════════════
// Imports — must come after vi.mock declarations
// ═══════════════════════════════════════════════════════════════════════════

import { registerBackupHandlers } from "../src/bot/handlers/backupHandlers.js";
import { Bot } from "grammy";

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

interface MockCtxOptions {
  userId?: number;
  document?: {
    file_id?: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  } | null;
}

/** Create a mock grammY context object. */
function makeCtx(opts: MockCtxOptions = {}): any {
  return {
    from: { id: opts.userId ?? 123456789 },
    chat: { id: opts.userId ?? 123456789 },
    message: { document: opts.document ?? {} },
    reply: vi.fn().mockResolvedValue(undefined),
    editMessageText: vi.fn().mockResolvedValue(undefined),
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    api: {
      sendDocument: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn().mockResolvedValue({ file_path: "backups/test.json" }),
    },
  };
}

/** Sample valid BackupData JSON string. */
const VALID_BACKUP_JSON = JSON.stringify({
  version: 1,
  exportedAt: "2025-06-21T12:00:00Z",
  tables: {
    providers: [{ id: 1, name: "OpenAI", api_type: "openai_chat" }],
    users: [{ id: 1, tg_user_id: 123456789 }],
  },
});

/** Default summary returned by mocked getBackupSummary. */
const DEFAULT_SUMMARY = {
  version: 1,
  exportedAt: "2025-06-21T12:00:00Z",
  counts: { providers: 2, users: 1 },
};

/** Set global.fetch to return the given body. */
function mockFetchResponse(body: string, ok = true): void {
  (global as any).fetch = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 404,
    text: () => Promise.resolve(body),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("Backup Handlers", () => {
  beforeEach(() => {
    // Clear captured handlers
    for (const key of Object.keys(mocks.capturedHandlers)) {
      delete mocks.capturedHandlers[key];
    }
    // Reset all mocks
    vi.clearAllMocks();
    mocks.mockIsAdmin.mockReturnValue(true);

    // Re-register handlers on a fresh mock Bot
    const bot = new Bot("dummy") as any;
    registerBackupHandlers(bot);

    // Default fetch mock (valid JSON)
    mockFetchResponse(VALID_BACKUP_JSON);
    // Default summary mock
    mocks.mockGetBackupSummary.mockReturnValue(DEFAULT_SUMMARY);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // /backup command
  // ─────────────────────────────────────────────────────────────────────────

  describe("/backup command", () => {
    it("admin: exports database and sends document", async () => {
      const backupData = { version: 1, exportedAt: "2025-06-21T12:00:00Z", tables: {} };
      mocks.mockExportDatabase.mockReturnValue(backupData);

      const ctx = makeCtx();
      await mocks.capturedHandlers["command:backup"](ctx);

      expect(mocks.mockExportDatabase).toHaveBeenCalledOnce();
      expect(ctx.api.sendDocument).toHaveBeenCalledOnce();
      // First arg is chat id
      expect(ctx.api.sendDocument.mock.calls[0][0]).toBe(ctx.chat.id);
      // Second arg is InputFile with correct filename pattern
      const inputFile = ctx.api.sendDocument.mock.calls[0][1];
      expect(inputFile.name).toMatch(/^s12ryt-tg-api-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.json$/);
    });

    it("non-admin: silently ignored", async () => {
      mocks.mockIsAdmin.mockReturnValue(false);

      const ctx = makeCtx();
      await mocks.capturedHandlers["command:backup"](ctx);

      expect(mocks.mockExportDatabase).not.toHaveBeenCalled();
      expect(ctx.reply).not.toHaveBeenCalled();
      expect(ctx.api.sendDocument).not.toHaveBeenCalled();
    });

    it("exportDatabase throws: sends error message", async () => {
      mocks.mockExportDatabase.mockImplementation(() => {
        throw new Error("DB locked");
      });

      const ctx = makeCtx();
      await mocks.capturedHandlers["command:backup"](ctx);

      expect(ctx.api.sendDocument).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("匯出失敗"));
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // message:document (restore file upload)
  // ─────────────────────────────────────────────────────────────────────────

  describe("message:document (file upload for restore)", () => {
    it("admin sends valid JSON backup: shows summary with confirm buttons", async () => {
      const ctx = makeCtx({
        document: { file_id: "f1", file_name: "backup.json", mime_type: "application/json", file_size: 1024 },
      });
      await mocks.capturedHandlers["on:message:document"](ctx);

      expect(ctx.api.getFile).toHaveBeenCalledWith("f1");
      expect(mocks.mockGetBackupSummary).toHaveBeenCalledOnce();

      // Summary is the last reply call (first is "downloading...")
      const lastCall = ctx.reply.mock.calls.at(-1);
      expect(lastCall[0]).toContain("備份內容摘要");
      expect(lastCall[1]?.reply_markup).toBeDefined();
    });

    it("non-admin: silently ignored", async () => {
      mocks.mockIsAdmin.mockReturnValue(false);

      const ctx = makeCtx({
        document: { file_id: "f1", file_name: "backup.json", mime_type: "application/json" },
      });
      await mocks.capturedHandlers["on:message:document"](ctx);

      expect(ctx.reply).not.toHaveBeenCalled();
    });

    it("non-JSON file: silently ignored", async () => {
      const ctx = makeCtx({
        document: { file_id: "f1", file_name: "photo.png", mime_type: "image/png" },
      });
      await mocks.capturedHandlers["on:message:document"](ctx);

      expect(ctx.reply).not.toHaveBeenCalled();
    });

    it("oversized file (>20MB): rejects with error", async () => {
      const ctx = makeCtx({
        document: {
          file_id: "f1",
          file_name: "big.json",
          mime_type: "application/json",
          file_size: 21 * 1024 * 1024,
        },
      });
      await mocks.capturedHandlers["on:message:document"](ctx);

      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("20MB"));
      expect(ctx.api.getFile).not.toHaveBeenCalled();
    });

    it("invalid JSON content: shows parse error", async () => {
      mockFetchResponse("{ this is not valid json");

      const ctx = makeCtx({
        document: { file_id: "f1", file_name: "bad.json", mime_type: "application/json", file_size: 100 },
      });
      await mocks.capturedHandlers["on:message:document"](ctx);

      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("無法解析 JSON"));
    });

    it("JSON without tables object: shows format error", async () => {
      mockFetchResponse(JSON.stringify({ version: 1, exportedAt: "x" }));

      const ctx = makeCtx({
        document: { file_id: "f1", file_name: "notable.json", mime_type: "application/json", file_size: 100 },
      });
      await mocks.capturedHandlers["on:message:document"](ctx);

      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("缺少 tables"));
    });

    it("fetch fails (HTTP error): shows download error", async () => {
      mockFetchResponse("", false);

      const ctx = makeCtx({
        document: { file_id: "f1", file_name: "backup.json", mime_type: "application/json", file_size: 100 },
      });
      await mocks.capturedHandlers["on:message:document"](ctx);

      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("下載失敗"));
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // restore_confirm callback
  // ─────────────────────────────────────────────────────────────────────────

  describe("restore_confirm callback", () => {
    it("admin confirms with pending restore: imports and shows success", async () => {
      // Step 1: upload a valid file to set pending state (userId 800)
      const uploadCtx = makeCtx({
        userId: 800,
        document: { file_id: "f1", file_name: "backup.json", mime_type: "application/json", file_size: 1024 },
      });
      await mocks.capturedHandlers["on:message:document"](uploadCtx);

      // Step 2: confirm restore with same userId
      const confirmCtx = makeCtx({ userId: 800 });
      await mocks.capturedHandlers["callbackQuery:restore_confirm"](confirmCtx);

      expect(mocks.mockImportDatabase).toHaveBeenCalledOnce();
      // Success message via reply (after editMessageText "restoring...")
      expect(confirmCtx.editMessageText).toHaveBeenCalledWith(expect.stringContaining("還原"));
      const lastReply = confirmCtx.reply.mock.calls.at(-1);
      expect(lastReply[0]).toContain("還原成功");
    });

    it("admin confirms without pending restore: shows not found", async () => {
      // Use a userId that has never uploaded
      const ctx = makeCtx({ userId: 999 });
      await mocks.capturedHandlers["callbackQuery:restore_confirm"](ctx);

      expect(mocks.mockImportDatabase).not.toHaveBeenCalled();
      expect(ctx.editMessageText).toHaveBeenCalledWith(expect.stringContaining("找不到"));
    });

    it("non-admin: only answers callback, does not import", async () => {
      // Set pending for userId 700
      const uploadCtx = makeCtx({
        userId: 700,
        document: { file_id: "f1", file_name: "b.json", mime_type: "application/json", file_size: 100 },
      });
      await mocks.capturedHandlers["on:message:document"](uploadCtx);

      // Non-admin tries to confirm
      mocks.mockIsAdmin.mockReturnValue(false);
      const ctx = makeCtx({ userId: 700 });
      await mocks.capturedHandlers["callbackQuery:restore_confirm"](ctx);

      expect(ctx.answerCallbackQuery).toHaveBeenCalledOnce();
      expect(mocks.mockImportDatabase).not.toHaveBeenCalled();
    });

    it("importDatabase throws: shows error message", async () => {
      // Set pending for userId 600
      const uploadCtx = makeCtx({
        userId: 600,
        document: { file_id: "f1", file_name: "b.json", mime_type: "application/json", file_size: 100 },
      });
      await mocks.capturedHandlers["on:message:document"](uploadCtx);

      // Make importDatabase throw
      mocks.mockImportDatabase.mockImplementation(() => {
        throw new Error("Import failed");
      });

      const ctx = makeCtx({ userId: 600 });
      await mocks.capturedHandlers["callbackQuery:restore_confirm"](ctx);

      const lastReply = ctx.reply.mock.calls.at(-1);
      expect(lastReply[0]).toContain("還原失敗");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // restore_cancel callback
  // ─────────────────────────────────────────────────────────────────────────

  describe("restore_cancel callback", () => {
    it("admin cancels: shows cancelled message and clears pending", async () => {
      // Set pending for userId 500
      const uploadCtx = makeCtx({
        userId: 500,
        document: { file_id: "f1", file_name: "b.json", mime_type: "application/json", file_size: 100 },
      });
      await mocks.capturedHandlers["on:message:document"](uploadCtx);

      // Cancel
      const cancelCtx = makeCtx({ userId: 500 });
      await mocks.capturedHandlers["callbackQuery:restore_cancel"](cancelCtx);

      expect(cancelCtx.answerCallbackQuery).toHaveBeenCalledOnce();
      expect(cancelCtx.editMessageText).toHaveBeenCalledWith(expect.stringContaining("取消"));

      // Verify pending was cleared: confirm now finds nothing
      const confirmCtx = makeCtx({ userId: 500 });
      await mocks.capturedHandlers["callbackQuery:restore_confirm"](confirmCtx);
      expect(confirmCtx.editMessageText).toHaveBeenCalledWith(expect.stringContaining("找不到"));
    });

    it("non-admin: only answers callback", async () => {
      mocks.mockIsAdmin.mockReturnValue(false);

      const ctx = makeCtx({ userId: 400 });
      await mocks.capturedHandlers["callbackQuery:restore_cancel"](ctx);

      expect(ctx.answerCallbackQuery).toHaveBeenCalledOnce();
      expect(ctx.editMessageText).not.toHaveBeenCalled();
    });
  });
});

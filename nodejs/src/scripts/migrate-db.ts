#!/usr/bin/env node
/**
 * SQLite -> Cloud (PostgreSQL/MySQL) database migration tool.
 *
 * Exports all tables from a SQLite source database, then imports them into a
 * cloud destination (PostgreSQL or MySQL). The backup JSON format is
 * backend-agnostic, so the data can flow across any supported driver.
 *
 * Usage (after `npm run build`):
 *   node dist/scripts/migrate-db.js --from ./data/bot.db --to postgres://user:pass@host:5432/db
 *   node dist/scripts/migrate-db.js --from ./data/bot.db --to mysql://user:pass@host:3306/db
 *
 * The destination schema is created automatically (via runMigrations) on first
 * connect. The import overwrites all existing destination rows (TRUNCATE +
 * INSERT inside a single transaction; rolled back on any error so the
 * destination is left untouched on failure).
 */

import { initDbAsync, exportDatabase, importDatabase, closeDb } from "../db/database.js";

interface CliArgs {
  from: string;
  to: string;
}

function printUsage(): void {
  console.error("Usage: migrate-db --from <sqlite-path> --to <database-url>");
  console.error("");
  console.error("Examples:");
  console.error("  migrate-db --from ./data/bot.db --to postgres://user:pass@host:5432/db");
  console.error("  migrate-db --from ./data/bot.db --to mysql://user:pass@host:3306/db");
}

/** Mask the password in a connection URL for safe logging. */
function redactUrl(url: string): string {
  return url.replace(/\/\/([^:]+):([^@]+)@/, "//$1:***@");
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  let from = "";
  let to = "";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--from" && i + 1 < args.length) {
      from = args[++i];
    } else if (a === "--to" && i + 1 < args.length) {
      to = args[++i];
    } else if (a === "-h" || a === "--help") {
      printUsage();
      process.exit(0);
    } else {
      console.error(`Error: Unknown argument "${a}".`);
      printUsage();
      process.exit(1);
    }
  }
  if (!from || !to) {
    console.error("Error: --from and --to are both required.");
    printUsage();
    process.exit(1);
  }
  return { from, to };
}

function summarize(data: { tables: Record<string, Record<string, unknown>[]> }): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [table, rows] of Object.entries(data.tables)) {
    counts[table] = rows.length;
  }
  return counts;
}

async function main(): Promise<void> {
  const { from, to } = parseArgs(process.argv);
  console.log(`[migrate-db] Source:      ${from}`);
  console.log(`[migrate-db] Destination: ${redactUrl(to)}`);

  // Phase 1: open SQLite source and export.
  console.log("[migrate-db] Opening SQLite source ...");
  await initDbAsync(from);
  const data = await exportDatabase();
  const counts = summarize(data);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`[migrate-db] Exported ${total} rows: ${JSON.stringify(counts)}`);
  await closeDb();
  console.log("[migrate-db] SQLite source closed.");

  // Phase 2: open cloud destination (schema auto-created on first connect) and import.
  console.log("[migrate-db] Opening cloud destination ...");
  await initDbAsync("", to);
  console.log("[migrate-db] Importing data (overwrites existing rows) ...");
  await importDatabase(data);
  await closeDb();
  console.log(`[migrate-db] Migration complete. Imported ${total} rows: ${JSON.stringify(counts)}`);
}

main().catch((err: unknown) => {
  console.error("[migrate-db] Migration failed:", err);
  process.exit(1);
});

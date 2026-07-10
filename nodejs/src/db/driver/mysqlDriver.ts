/**
 * MySQL driver backed by `mysql2`.
 *
 * Implements the dialect-agnostic {@link DbDriver} contract on top of a
 * `mysql2` connection pool. Cloud writes commit immediately (each statement
 * is its own implicit transaction), so {@link MysqlDriver.sync} is a no-op.
 *
 * Responsibilities (engine layer only):
 *  - connection pooling via `mysql2.createPool`
 *  - SQL execution (query/run/insert/exec/batch/transaction)
 *  - cross-dialect value coercion (bigint, boolean, Uint8Array)
 *
 * NOT handled here (kept in `database.ts` as business logic):
 *  - schema (CREATE TABLE / migrations), provider cache, usage flush.
 *
 * Placeholder convention:
 *  MySQL uses `?` natively, exactly matching the cross-dialect {@link SqlParam}
 *  convention — so no `$N` conversion is needed (unlike the Postgres driver).
 *
 * Transaction model (single-level, NOT nested):
 *  {@link MysqlDriver.transaction} checks out a dedicated pooled connection,
 *  stores it on `this.txConn`, and runs BEGIN/COMMIT/ROLLBACK on it. While
 *  a txConn is active, every query/run/insert/exec reuses the same connection
 *  so statements execute within the transaction. Nested transactions are not
 *  supported (the inner call runs on the outer connection without a savepoint).
 */

import type {
  BatchStatement,
  DbDriver,
  DbDialect,
  DbRow,
  InsertResult,
  QueryResult,
  RunResult,
  SqlParam,
} from "./types.js";

/**
 * Dynamically import `mysql2/promise` so SQLite-only deployments never require it.
 *
 * We import only the types statically; the runtime module is loaded inside
 * {@link MysqlDriver.create}.
 */
type MysqlPool = {
  getConnection(): Promise<MysqlPoolConnection>;
  query(sql: string, values?: unknown[]): Promise<[MysqlQueryResult, unknown]>;
  end(): Promise<void>;
};
type MysqlPoolConnection = {
  query(sql: string, values?: unknown[]): Promise<[MysqlQueryResult, unknown]>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
};
/** A query result is either a row array (SELECT) or an OkPacket (write). */
type MysqlOkPacket = {
  affectedRows: number;
  insertId: number;
  changedRows?: number;
};
type MysqlQueryResult = MysqlOkPacket | Record<string, unknown>[];

/** Constructor options for {@link MysqlDriver.create}. */
export interface MysqlDriverOptions {
  /** Full MySQL connection URL (e.g. `mysql://user:pass@host:3306/db`). */
  connectionString: string;
}

/**
 * Convert a cross-dialect {@link SqlParam} into a `mysql2`-native bind value.
 *
 * - bigint -> string: keeps 64-bit ids lossless across the wire.
 * - boolean -> 0/1: columns are declared INTEGER across all dialects so that
 *   SQLite, Postgres and MySQL store booleans identically.
 * - Uint8Array -> Buffer: `mysql2` expects Buffer for BLOB columns.
 */
function toMysqlValue(p: SqlParam): unknown {
  if (typeof p === "bigint") return p.toString();
  if (typeof p === "boolean") return p ? 1 : 0;
  if (p instanceof Uint8Array) return Buffer.from(p);
  return p; // string | number | null
}

function toMysqlValues(params?: SqlParam[]): unknown[] | undefined {
  return params ? params.map(toMysqlValue) : undefined;
}

/** True when the result is a write OkPacket (has affectedRows). */
function isOkPacket(r: MysqlQueryResult): r is MysqlOkPacket {
  return (
    !Array.isArray(r) &&
    typeof (r as MysqlOkPacket).affectedRows === "number"
  );
}

export class MysqlDriver implements DbDriver {
  readonly dialect: DbDialect = "mysql";

  private pool: MysqlPool | null = null;
  /** Active transaction connection, or null when not inside a transaction. */
  private txConn: MysqlPoolConnection | null = null;

  private constructor() {
    // Use {@link MysqlDriver.create} for initialisation.
  }

  /**
   * Create and initialise a driver for the given connection URL.
   *
   * `mysql2/promise` is loaded via dynamic import so that deployments without
   * the `mysql2` package (SQLite-only) never trigger the require.
   */
  static async create(
    options: MysqlDriverOptions,
  ): Promise<MysqlDriver> {
    const driver = new MysqlDriver();
    await driver.init(options.connectionString);
    return driver;
  }

  private async init(connectionString: string): Promise<void> {
    // Dynamic import keeps `mysql2` optional for SQLite-only deployments.
    // multipleStatements stays false (default) — exec() splits statements itself.
    const mysqlModule = (await import("mysql2/promise")) as {
      // mysql2 createPool accepts a URI string directly; the object form
      // { connectionString } is silently ignored (only { uri } or a bare
      // string works). multipleStatements stays false (default).
      createPool: (config: string | object) => MysqlPool;
    };
    this.pool = mysqlModule.createPool(connectionString);
  }

  /** Ensure the pool is open and return it, or throw a contract error. */
  private p(): MysqlPool {
    const current = this.pool;
    if (!current) {
      throw new Error("MysqlDriver is not initialised or has been closed");
    }
    return current;
  }

  /**
   * Run a parameterised statement on the active connection: the dedicated
   * transaction connection when inside {@link transaction}, otherwise the pool.
   */
  private async runQuery(
    sql: string,
    params?: SqlParam[],
  ): Promise<MysqlQueryResult> {
    const conn = this.txConn;
    const values = toMysqlValues(params);
    if (conn) {
      const [result] = await conn.query(sql, values);
      return result;
    }
    const [result] = await this.p().query(sql, values);
    return result;
  }

  async query<T = DbRow>(
    sql: string,
    params?: SqlParam[],
  ): Promise<QueryResult<T>> {
    const result = await this.runQuery(sql, params);
    // SELECT returns a row array; a write OkPacket would be an unusual result
    // for query(), but we guard defensively.
    const rows = Array.isArray(result) ? result : [];
    return { rows: rows as T[] };
  }

  async run(sql: string, params?: SqlParam[]): Promise<RunResult> {
    const result = await this.runQuery(sql, params);
    const changes = isOkPacket(result) ? result.affectedRows : 0;
    return { changes };
  }

  async insert(sql: string, params?: SqlParam[]): Promise<InsertResult> {
    const result = await this.runQuery(sql, params);
    // mysql2 returns insertId in the OkPacket for INSERT statements.
    // Non-INSERT writes return insertId 0 -> null.
    const id = isOkPacket(result) && result.insertId > 0 ? result.insertId : null;
    return { id };
  }

  async exec(sql: string): Promise<void> {
    // mysql2 with multipleStatements=false cannot run several statements in one
    // call; split on ';' for our DDL/migration text (same as the Postgres driver).
    for (const stmt of this.splitStatements(sql)) {
      await this.runQuery(stmt);
    }
  }

  /**
   * Split a multi-statement SQL string on top-level `;` separators.
   *
   * This is deliberately simple: our DDL and migration text never contains
   * `;` inside string literals or function bodies. Each non-empty fragment is
   * returned trimmed.
   */
  private splitStatements(sql: string): string[] {
    const out: string[] = [];
    for (const raw of sql.split(";")) {
      const stmt = raw.trim();
      if (stmt.length > 0) out.push(stmt);
    }
    return out;
  }

  async batch(statements: BatchStatement[]): Promise<void> {
    // Reuse transaction() so all statements commit or roll back atomically.
    await this.transaction(async () => {
      for (const stmt of statements) {
        await this.run(stmt.sql, stmt.params);
      }
    });
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    // Nested calls reuse the outer transaction connection (no savepoint).
    if (this.txConn) {
      return fn();
    }
    const conn = await this.p().getConnection();
    this.txConn = conn;
    try {
      await conn.beginTransaction();
      const result = await fn();
      await conn.commit();
      return result;
    } catch (err) {
      try {
        await conn.rollback();
      } catch {
        /* ignore rollback failure; the original error is more useful */
      }
      throw err;
    } finally {
      this.txConn = null;
      conn.release();
    }
  }

  async sync(): Promise<void> {
    // No-op: cloud drivers commit each statement immediately.
  }

  async close(): Promise<void> {
    const pool = this.pool;
    if (pool) {
      this.pool = null;
      await pool.end();
    }
    this.txConn = null;
  }
}

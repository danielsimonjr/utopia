/**
 * The "ask my data" query engine: an engine-agnostic trait seam (same
 * approach as `BlobStore`), plus a safety gate that does not trust the
 * model.
 *
 * Engines grow by wire protocol family, not by product name: Postgres
 * (this file) covers Greenplum/Timescale for free; a MySQL-protocol
 * engine would cover TiDB/OceanBase/Doris/StarRocks; an HTTP-protocol
 * family would cover ClickHouse and Trino — the latter alone reaches the
 * whole Iceberg/Delta/Hive lakehouse ecosystem. The mount model and the
 * registry do not care which engine is behind them, so adding one needs
 * no migration.
 *
 * Defense in depth (never trust the model):
 * 1. A real SQL parser: only a single SELECT/WITH (including a CTE)
 *    passes; DML/DDL, multiple statements, and SELECT INTO are rejected.
 * 2. An outer LIMIT is always added (cap+1, to detect truncation).
 * 3. A read-only session plus a statement timeout (the engine's own
 *    mechanism, in case the parser ever misses something).
 * 4. Results always come back as JSON Lines (every engine has a native
 *    JSON row output, and it is also the format a model digests best).
 */

import postgres from "postgres";
import { Parser as SqlParser } from "node-sql-parser";

/** Row cap (an outer LIMIT of cap+1; the 201st row is only used to detect truncation). */
export const ROW_CAP = 200;
const STATEMENT_TIMEOUT_SECS = 10;

export type QueryResult = {
  /** One JSON object of text per row (key order = the query's column order). */
  rows: string[];
  truncated: boolean;
};

export type SchemaColumn = {
  schema: string;
  table: string;
  column: string;
  data_type: string;
  comment: string | null;
};

export interface QueryEngine {
  test(): Promise<void>;
  fetchSchema(): Promise<SchemaColumn[]>;
  /** Runs a SELECT that already passed the gate. Implementations must still enforce a read-only session and a timeout themselves (defense in depth). */
  execute(sql: string): Promise<QueryResult>;
}

/** The engine factory. Connection credentials only ever flow through the server. */
export function engineFor(engine: string, conn: string): QueryEngine {
  if (engine === "postgres") {
    return new PostgresEngine(conn);
  }
  throw new Error(`Unsupported engine: ${engine}`);
}

const sqlParser = new SqlParser();

/** Safety gate, layer 1: parse and validate, and return the cleaned-up statement text. */
export function guardSql(sql: string): string {
  const cleaned = sql.trim().replace(/;+\s*$/, "").trim();
  if (cleaned === "") {
    throw new Error("Empty SQL");
  }
  let ast: unknown;
  try {
    ast = sqlParser.astify(cleaned, { database: "postgresql" });
  } catch (e) {
    throw new Error(`SQL parse error: ${e instanceof Error ? e.message : String(e)}`);
  }
  const statements = Array.isArray(ast) ? ast : [ast];
  if (statements.length !== 1) {
    throw new Error("Exactly one statement is allowed");
  }
  const stmt = statements[0] as { type?: string; into?: { expr?: unknown } | null };
  if (stmt.type !== "select") {
    throw new Error(`Read-only: only SELECT/WITH queries are allowed (got ${statementKind(stmt.type)})`);
  }
  if (stmt.into && stmt.into.expr) {
    throw new Error("Read-only: only SELECT/WITH queries are allowed (got SELECT INTO)");
  }
  return cleaned;
}

function statementKind(t: string | undefined): string {
  switch (t) {
    case "insert":
      return "INSERT";
    case "update":
      return "UPDATE";
    case "delete":
      return "DELETE";
    case "drop":
      return "DROP";
    case "create":
      return "CREATE";
    case "alter":
      return "ALTER";
    case "truncate":
      return "TRUNCATE";
    default:
      return "a non-SELECT statement";
  }
}

// ---------------------------------------------------------------------------
// The Postgres family (also covers Greenplum/Timescale and other PG-compatible engines)
// ---------------------------------------------------------------------------

class PostgresEngine implements QueryEngine {
  constructor(private readonly conn: string) {}

  private pool(): postgres.Sql {
    return postgres(this.conn, { max: 1, connect_timeout: 5, onnotice: () => {} });
  }

  async test(): Promise<void> {
    const pool = this.pool();
    try {
      await pool.unsafe("SELECT 1");
    } finally {
      await pool.end({ timeout: 1 });
    }
  }

  async fetchSchema(): Promise<SchemaColumn[]> {
    const pool = this.pool();
    try {
      const rows = await pool.unsafe<{
        table_schema: string;
        table_name: string;
        column_name: string;
        data_type: string;
        description: string | null;
      }[]>(
        `SELECT c.table_schema, c.table_name, c.column_name,
                c.data_type, pgd.description
         FROM information_schema.columns c
         LEFT JOIN pg_catalog.pg_statio_all_tables st
           ON st.schemaname = c.table_schema AND st.relname = c.table_name
         LEFT JOIN pg_catalog.pg_description pgd
           ON pgd.objoid = st.relid AND pgd.objsubid = c.ordinal_position
         WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
         ORDER BY c.table_schema, c.table_name, c.ordinal_position`,
      );
      return rows.map((r) => ({
        schema: r.table_schema,
        table: r.table_name,
        column: r.column_name,
        data_type: r.data_type,
        comment: r.description,
      }));
    } finally {
      await pool.end({ timeout: 1 });
    }
  }

  async execute(sql: string): Promise<QueryResult> {
    const pool = this.pool();
    try {
      // Defense in depth, layer 3: a read-only session plus a timeout, in
      // case the parser lets something through unnoticed.
      await pool.unsafe("SET default_transaction_read_only = on");
      await pool.unsafe(`SET statement_timeout = '${STATEMENT_TIMEOUT_SECS}s'`);
      // Layer 2: an outer LIMIT; row_to_json hands type -> JSON conversion
      // entirely to Postgres, and the text form keeps the column order.
      const wrapped = `SELECT row_to_json(_q)::text AS _j FROM ( ${sql} ) AS _q LIMIT ${ROW_CAP + 1}`;
      const fetched = await pool.unsafe<{ _j: string }[]>(wrapped);
      const truncated = fetched.length > ROW_CAP;
      const rows = fetched.slice(0, ROW_CAP).map((r) => r._j ?? "{}");
      return { rows, truncated };
    } finally {
      await pool.end({ timeout: 1 });
    }
  }
}

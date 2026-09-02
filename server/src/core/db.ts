/**
 * Postgres access.
 *
 * Default pool size is 32. Worker count can be higher.
 * Workers wait on the model most of the time. The pool covers short queries.
 *
 * Acquire timeout is 10 seconds. Fail fast when the pool is too small.
 */

import postgres from "postgres";
import { log } from "./log";
import { AppError } from "./errors";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Sql = postgres.Sql;

/**
 * Anything the query helpers below can run against: a live connection, or
 * a transaction handle from `sql.begin`. `postgres.TransactionSql` does
 * not extend `postgres.Sql` (it has no `begin` of its own), so this union
 * is required for `q`/`qOne`/`qOpt`/`exec` to accept a transaction.
 */
export type Queryable = Sql | postgres.TransactionSql;

const DEFAULT_MAX = 32;

export function connect(databaseUrl: string, maxConnections?: number): Sql {
  const max = Math.max(maxConnections ?? DEFAULT_MAX, 2);
  const sql = postgres(databaseUrl, {
    max,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {},
  });
  log.info("database pool ready", { max_connections: max });
  return sql;
}

export async function q<T>(sql: Queryable, text: string, params: unknown[] = []): Promise<T[]> {
  try {
    const rows = await sql.unsafe(text, params as postgres.ParameterOrJSON<never>[]);
    return rows as unknown as T[];
  } catch (e) {
    throw mapDbError(e);
  }
}

export async function qOne<T>(sql: Queryable, text: string, params: unknown[] = []): Promise<T> {
  const rows = await q<T>(sql, text, params);
  if (!rows[0]) throw AppError.notFound();
  return rows[0];
}

export async function qOpt<T>(
  sql: Queryable,
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await q<T>(sql, text, params);
  return rows[0] ?? null;
}

export async function exec(
  sql: Queryable,
  text: string,
  params: unknown[] = [],
): Promise<{ count: number }> {
  try {
    const rows = await sql.unsafe(text, params as postgres.ParameterOrJSON<never>[]);
    return { count: rows.count };
  } catch (e) {
    throw mapDbError(e);
  }
}

function mapDbError(e: unknown): AppError {
  const msg = e instanceof Error ? e.message : String(e);
  if (/unique|duplicate key/i.test(msg)) {
    return AppError.conflict(msg);
  }
  return AppError.db(e);
}

/**
 * Run SQL files in `migrations/` in name order.
 *
 * Track applied versions in `schema_migrations`.
 * Also skip versions already in `_sqlx_migrations` from older installs.
 */
export async function migrate(sql: Sql, migrationsDir: string): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version bigint PRIMARY KEY,
      name text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const applied = new Set<number>();
  const ours = await sql.unsafe("SELECT version FROM schema_migrations");
  for (const row of ours) applied.add(Number(row.version));

  try {
    const sqlx = await sql.unsafe("SELECT version FROM _sqlx_migrations WHERE success = true");
    for (const row of sqlx) applied.add(Number(row.version));
  } catch {
    // Table does not exist on a new install.
  }

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const version = Number(file.split("_")[0]);
    if (!Number.isFinite(version)) continue;
    if (applied.has(version)) continue;
    const body = readFileSync(join(migrationsDir, file), "utf8");
    log.info("apply migration", { file });
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx.unsafe("INSERT INTO schema_migrations (version, name) VALUES ($1, $2)", [
        version,
        file,
      ]);
    });
  }
  log.info("database migrations complete");
}

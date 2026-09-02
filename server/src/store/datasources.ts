/**
 * Query-data data sources: registered system-wide (credentials
 * centralized, reusable across KBs) plus mounted per knowledge base
 * (permissions follow the KB). The safety gates for running a query
 * (read-only session, SQL parser allowlist, LIMIT/timeout) live on the
 * server side.
 */

import { q, qOpt, exec, type Sql } from "../core/db";
import { AppError } from "../core/errors";
import { newId, type Uuid } from "../core/ids";

/** Query-data data source list view: the connection string is never sent down (credentials go in, never out), only a host:port/db summary. */
export type DataSourceView = {
  id: Uuid;
  name: string;
  engine: string;
  /** connection summary (host:port/db, no credentials) */
  summary: string;
  created_at: Date;
  last_test_at: Date | null;
  last_test_ok: boolean | null;
};

type DataSourceRow = {
  id: Uuid;
  name: string;
  engine: string;
  conn_string: string;
  created_at: Date;
  last_test_at: Date | null;
  last_test_ok: boolean | null;
};

/** Connection string -> a credential-free summary (host:port/db). Falls back to a placeholder on parse failure, and never echoes the original string. */
export function connSummary(conn: string): string {
  try {
    const u = new URL(conn);
    const port = u.port || "5432";
    return `${u.hostname}:${port}${u.pathname}`;
  } catch {
    return "(unparsed)";
  }
}

/** Row -> view. The connection string is swapped for its credential-free summary right here — the one gate keeping it from leaking, shared by all four queries so nobody forgets it on a new one. */
function rowToView(row: DataSourceRow): DataSourceView {
  return {
    id: row.id,
    name: row.name,
    engine: row.engine,
    summary: connSummary(row.conn_string),
    created_at: row.created_at,
    last_test_at: row.last_test_at,
    last_test_ok: row.last_test_ok,
  };
}

/**
 * Every source in the deployment. For the system admin registry only.
 * The mountable list used to go through here too; 0014 closed that
 * door — the KB side now goes through `grantedToWorkspace`.
 */
export async function list(sql: Sql): Promise<DataSourceView[]> {
  const rows = await q<DataSourceRow>(
    sql,
    `SELECT id, name, engine, conn_string, created_at, last_test_at, last_test_ok
         FROM data_sources ORDER BY name`,
  );
  return rows.map(rowToView);
}

export async function create(
  sql: Sql,
  name: string,
  engine: string,
  connString: string,
  createdBy: Uuid,
): Promise<Uuid> {
  if (name.trim().length === 0) {
    throw AppError.invalid("ds_name_required", "Data source name is required");
  }
  if (engine !== "postgres") {
    throw AppError.invalid("only_postgres", "Only the postgres engine is supported for now");
  }
  if (!connString.startsWith("postgres://") && !connString.startsWith("postgresql://")) {
    throw AppError.invalid("bad_conn_string", "Connection string must start with postgres://");
  }
  const id = newId();
  await exec(
    sql,
    `INSERT INTO data_sources (id, name, engine, conn_string, created_by)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, name.trim(), engine, connString.trim(), createdBy],
  );
  return id;
}

export async function del(sql: Sql, id: Uuid): Promise<void> {
  const res = await exec(sql, `DELETE FROM data_sources WHERE id = $1`, [id]);
  if (res.count === 0) throw AppError.notFound();
}

/** The connection string only ever flows inside the server (test connection / running a query). */
export async function connString(sql: Sql, id: Uuid): Promise<string> {
  const row = await qOpt<{ conn_string: string }>(
    sql,
    `SELECT conn_string FROM data_sources WHERE id = $1`,
    [id],
  );
  if (!row) throw AppError.notFound();
  return row.conn_string;
}

export async function recordTest(sql: Sql, id: Uuid, ok: boolean): Promise<void> {
  await exec(sql, `UPDATE data_sources SET last_test_at = now(), last_test_ok = $2 WHERE id = $1`, [
    id,
    ok,
  ]);
}

// ---------------------------------------------------------------------------
// KB mounting
// ---------------------------------------------------------------------------

export async function mount(sql: Sql, kbId: Uuid, dataSourceId: Uuid): Promise<void> {
  await exec(
    sql,
    `INSERT INTO kb_data_sources (kb_id, data_source_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [kbId, dataSourceId],
  );
}

export async function unmount(sql: Sql, kbId: Uuid, dataSourceId: Uuid): Promise<void> {
  await exec(sql, `DELETE FROM kb_data_sources WHERE kb_id = $1 AND data_source_id = $2`, [
    kbId,
    dataSourceId,
  ]);
}

export async function mounted(sql: Sql, kbId: Uuid): Promise<DataSourceView[]> {
  const rows = await q<DataSourceRow>(
    sql,
    `SELECT d.id, d.name, d.engine, d.conn_string, d.created_at,
                d.last_test_at, d.last_test_ok
         FROM kb_data_sources m JOIN data_sources d ON d.id = m.data_source_id
         WHERE m.kb_id = $1 ORDER BY d.name`,
    [kbId],
  );
  return rows.map(rowToView);
}

/** (engine, conn_string): for running a query / testing / pulling a schema (credentials never leave the server). */
export async function engineAndConn(sql: Sql, id: Uuid): Promise<[string, string]> {
  const row = await qOpt<{ engine: string; conn_string: string }>(
    sql,
    `SELECT engine, conn_string FROM data_sources WHERE id = $1`,
    [id],
  );
  if (!row) throw AppError.notFound();
  return [row.engine, row.conn_string];
}

/**
 * The sources this workspace is authorized to use (0014).
 *
 * The mountable list now goes through here, not `list`. It used to go
 * through `datasources.list(sql)` — every source in the whole
 * deployment, unfiltered — so any KB admin could mount any production
 * source into their own KB, and once mounted, every Viewer in that KB
 * could run read-only SQL against it.
 */
export async function grantedToWorkspace(sql: Sql, workspaceId: Uuid): Promise<DataSourceView[]> {
  const rows = await q<DataSourceRow>(
    sql,
    `SELECT d.id, d.name, d.engine, d.conn_string, d.created_at,
            d.last_test_at, d.last_test_ok
       FROM data_source_grants g JOIN data_sources d ON d.id = g.data_source_id
      WHERE g.workspace_id = $1 ORDER BY d.name`,
    [workspaceId],
  );
  return rows.map(rowToView);
}

/** Which workspaces this source has been granted to. The admin console reads it. */
export async function grantsForSource(
  sql: Sql,
  dataSourceId: Uuid,
): Promise<[Uuid, string][]> {
  const rows = await q<{ id: Uuid; name: string }>(
    sql,
    `SELECT w.id, w.name FROM data_source_grants g
       JOIN workspaces w ON w.id = g.workspace_id
      WHERE g.data_source_id = $1 ORDER BY w.name`,
    [dataSourceId],
  );
  return rows.map((r) => [r.id, r.name]);
}

/** Grants a workspace use of this source. Idempotent. */
export async function grant(
  sql: Sql,
  dataSourceId: Uuid,
  workspaceId: Uuid,
  actor: Uuid,
): Promise<void> {
  await exec(
    sql,
    `INSERT INTO data_source_grants (data_source_id, workspace_id, granted_by)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [dataSourceId, workspaceId, actor],
  );
}

/**
 * Revokes a grant, **along with unmounting whatever that workspace has
 * already mounted**.
 *
 * Deleting only the grant row is not enough: `mounted` reads
 * `kb_data_sources`, and running a query reads it too. Leaving it
 * mounted means the grant was revoked while access carries on — a
 * permission revocation that does not take effect is worse than none.
 *
 * Done in one transaction: if it crashes between the two DELETEs, what
 * is left is exactly "mounted without a grant", the state this
 * migration exists to eliminate.
 */
export async function revoke(
  sql: Sql,
  dataSourceId: Uuid,
  workspaceId: Uuid,
): Promise<number> {
  return sql.begin(async (tx) => {
    const unmountedRes = await exec(
      tx,
      `DELETE FROM kb_data_sources
        WHERE data_source_id = $1
          AND kb_id IN (SELECT id FROM knowledge_bases WHERE workspace_id = $2)`,
      [dataSourceId, workspaceId],
    );
    await exec(
      tx,
      `DELETE FROM data_source_grants WHERE data_source_id = $1 AND workspace_id = $2`,
      [dataSourceId, workspaceId],
    );
    return unmountedRes.count;
  });
}

/**
 * Whether this source has ever been granted to this knowledge base.
 * Must be checked before mounting — the guard cannot live only on the
 * list side: filtering the list stops what is visible, while the mount
 * endpoint is called by id, and anyone can construct one themselves.
 */
export async function isGranted(sql: Sql, kbId: Uuid, dataSourceId: Uuid): Promise<boolean> {
  const found = await qOpt<{ one: number }>(
    sql,
    `SELECT 1 AS one FROM data_source_grants g
       JOIN knowledge_bases kb ON kb.workspace_id = g.workspace_id
      WHERE kb.id = $1 AND g.data_source_id = $2`,
    [kbId, dataSourceId],
  );
  return found != null;
}

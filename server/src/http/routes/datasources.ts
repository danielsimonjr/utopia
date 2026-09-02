/**
 * "Ask my data" data sources: system-level registration (admin only,
 * credentials only ever flow in, never out) plus per-KB mounting (KB
 * admin).
 *
 * Mounting, and a manual refresh, ingest the target database's schema as
 * markdown into the KB (updated in place under the same key), so Chat can
 * retrieve table structure before it writes SQL. The safety gate for
 * actually running a query lives in the `query_data` tool, not here.
 */

import type { Hono } from "hono";
import type { AppState } from "../../state";
import * as store from "../../store";
import * as auth from "../../auth";
import { AppError } from "../../core/errors";
import type { Uuid } from "../../core/ids";
import { uuidParam } from "../context";
import { engineFor } from "../../query_engine";
import { ingestItem } from "../../ingest_sources";
import { observeSchemaSyncFailure } from "../../alerting";

function requireAdmin(user: { is_admin: boolean }): void {
  if (!user.is_admin) throw AppError.forbidden();
}

const MAX_TABLES = 200;

/** Pulls `information_schema` and turns it into markdown, then ingests it through the three-way sync path (updates in place under the same key). The document is filed under a per-KB "Data schemas" folder source. */
async function syncSchemaDoc(state: AppState, kbId: Uuid, dsId: Uuid): Promise<number> {
  const all = await store.datasources.list(state.sql);
  const found = all.find((d) => d.id === dsId);
  if (!found) throw new Error("Data source not found");
  const [engine, conn] = await store.datasources.engineAndConn(state.sql, dsId);
  const cols = await engineFor(engine, conn).fetchSchema();

  let md = `# Data source: ${found.name}\n\nTables and columns available for SQL queries against this source.\n`;
  let current = "";
  let tables = 0;
  for (const c of cols) {
    const key = `${c.schema}.${c.table}`;
    if (key !== current) {
      if (tables >= MAX_TABLES) {
        md += "\n(further tables omitted)\n";
        break;
      }
      current = key;
      tables += 1;
      md += `\n## ${key}\n`;
    }
    md += `- ${c.column} (${c.data_type})${c.comment ? ` — ${c.comment}` : ""}\n`;
  }

  const sources = await store.sources.list(state.sql, kbId);
  const existingFolder = sources.find((s) => s.kind === "folder" && s.name === "Data schemas");
  const folder = existingFolder
    ? existingFolder
    : await store.sources.create(state.sql, kbId, "folder", "Data schemas", {}, "database", null, null);
  await ingestItem(
    state,
    kbId,
    folder.id,
    `datasource:${dsId}:schema`,
    `${found.name}-schema.md`,
    "text/markdown",
    new TextEncoder().encode(md),
    null,
  );
  state.emitSource(kbId);
  return tables;
}

async function sourceName(state: AppState, dsId: Uuid): Promise<string> {
  try {
    const all = await store.datasources.list(state.sql);
    return all.find((d) => d.id === dsId)?.name ?? dsId;
  } catch {
    return dsId;
  }
}

export function registerDataSourceRoutes(api: Hono, state: AppState): void {
  // --- System level: register / test / delete --------------------------

  api.get("/admin/data-sources", async (c) => {
    const user = await auth.requireUser(c, state);
    requireAdmin(user);
    const dataSources = await store.datasources.list(state.sql);
    return c.json({ data_sources: dataSources });
  });

  api.post("/admin/data-sources", async (c) => {
    const user = await auth.requireUser(c, state);
    requireAdmin(user);
    const body = await c.req.json<{ name: string; engine?: string; conn_string: string }>();
    const id = await store.datasources.create(
      state.sql,
      body.name,
      body.engine ?? "postgres",
      body.conn_string,
      user.id,
    );
    return c.json({ id });
  });

  api.delete("/admin/data-sources/:id", async (c) => {
    const user = await auth.requireUser(c, state);
    requireAdmin(user);
    const id = uuidParam(c, "id");
    await store.datasources.del(state.sql, id);
    return c.json({ ok: true });
  });

  api.post("/admin/data-sources/:id/test", async (c) => {
    const user = await auth.requireUser(c, state);
    requireAdmin(user);
    const id = uuidParam(c, "id");
    const [engine, conn] = await store.datasources.engineAndConn(state.sql, id);
    let ok: boolean;
    try {
      await engineFor(engine, conn).test();
      ok = true;
    } catch {
      ok = false;
    }
    await store.datasources.recordTest(state.sql, id, ok);
    return c.json({ ok });
  });

  // --- KB level: mount / unmount / schema refresh -----------------------

  api.get("/kbs/:id/data-sources", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    await store.access.requireKb(state.sql, user, kbId, "viewer");
    const dataSources = await store.datasources.mounted(state.sql, kbId);
    return c.json({ data_sources: dataSources });
  });

  // Only sources granted to this workspace (0014): listing everyone's
  // registered sources would let any KB admin see, and mount, someone
  // else's production database.
  api.get("/kbs/:id/data-sources/available", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    const kb = await store.access.requireKb(state.sql, user, kbId, "admin");
    const granted = await store.datasources.grantedToWorkspace(state.sql, kb.workspace_id);
    return c.json({ data_sources: granted });
  });

  api.put("/kbs/:id/data-sources/:ds_id", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    const dsId = uuidParam(c, "ds_id");
    await store.access.requireKb(state.sql, user, kbId, "admin");
    // The listing filter is not the guard: it only hides what is out of
    // view; this endpoint is called by id, and anyone can type in a UUID.
    // Authorization is checked again here.
    if (!(await store.datasources.isGranted(state.sql, kbId, dsId))) {
      throw AppError.invalid("source_not_granted", "This data source is not available to this workspace");
    }
    await store.datasources.mount(state.sql, kbId, dsId);
    // Mounting ingests the schema right away, so Chat can retrieve table
    // structure before it writes SQL.
    //
    // A failure here must not be reported as a mount failure — the mount
    // itself already succeeded (the line above), so a bare error would
    // read as "did not mount" when it did; the fix is to say the mount
    // succeeded, the schema did not, and raise it in the alert center,
    // because from then on it is a silent gap (0009).
    try {
      const synced = await syncSchemaDoc(state, kbId, dsId);
      return c.json({ ok: true, schema_tables: synced });
    } catch (e) {
      const name = await sourceName(state, dsId);
      await observeSchemaSyncFailure(state, kbId, dsId, name, e);
      return c.json({ ok: true, schema_tables: 0, schema_error: e instanceof Error ? e.message : String(e) });
    }
  });

  api.delete("/kbs/:id/data-sources/:ds_id", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    const dsId = uuidParam(c, "ds_id");
    await store.access.requireKb(state.sql, user, kbId, "admin");
    await store.datasources.unmount(state.sql, kbId, dsId);
    return c.json({ ok: true });
  });

  // A manual refresh. **The error still goes straight back to the
  // caller** here — the person who clicked is watching, and nothing else
  // happened partway. It still raises an alert too: the fallout is the
  // same as a failed mount (the source stays mounted with a stale or
  // empty schema), and the person who clicked may not be who needs to
  // know that.
  api.post("/kbs/:id/data-sources/:ds_id/sync-schema", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    const dsId = uuidParam(c, "ds_id");
    await store.access.requireKb(state.sql, user, kbId, "admin");
    try {
      const synced = await syncSchemaDoc(state, kbId, dsId);
      return c.json({ ok: true, schema_tables: synced });
    } catch (e) {
      const name = await sourceName(state, dsId);
      await observeSchemaSyncFailure(state, kbId, dsId, name, e);
      throw AppError.other(e);
    }
  });

  // Agentic exploration: a background task reads a mounted source's
  // schema and proposes metric/dimension -> column mappings (low
  // confidence goes to review). Not implemented in this build; the job
  // is queued so it becomes a no-op success rather than a 500.
  api.post("/kbs/:id/data-sources/explore", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    await store.access.requireKb(state.sql, user, kbId, "admin");
    if ((await store.datasources.mounted(state.sql, kbId)).length === 0) {
      throw AppError.invalid("no_data_sources", "No data sources mounted");
    }
    await store.jobs.enqueue(state.sql, "explore_mappings", { kb_id: kbId });
    return c.json({ ok: true });
  });

  // --- System level: grants (0014) --------------------------------------

  api.get("/admin/data-sources/:id/grants", async (c) => {
    const user = await auth.requireUser(c, state);
    requireAdmin(user);
    const id = uuidParam(c, "id");
    const rows = await store.datasources.grantsForSource(state.sql, id);
    const workspaces = rows.map(([wid, name]) => ({ id: wid, name }));
    return c.json({ workspaces });
  });

  api.put("/admin/data-sources/:id/grants/:workspace_id", async (c) => {
    const user = await auth.requireUser(c, state);
    requireAdmin(user);
    const id = uuidParam(c, "id");
    const workspaceId = uuidParam(c, "workspace_id");
    await store.datasources.grant(state.sql, id, workspaceId, user.id);
    await store.audit.record(state.sql, null, user.id, "data_source.granted", "data_source", id, {
      workspace_id: workspaceId,
    });
    return c.json({ ok: true });
  });

  // Revoking a grant also unmounts it everywhere in that workspace: only
  // deleting the grant row would leave `kb_data_sources` untouched, so the
  // revoke would have no real effect. Returns how many got unmounted, so
  // the UI can say "also unmounted from 3 knowledge bases" instead of
  // silently cutting a connection.
  api.delete("/admin/data-sources/:id/grants/:workspace_id", async (c) => {
    const user = await auth.requireUser(c, state);
    requireAdmin(user);
    const id = uuidParam(c, "id");
    const workspaceId = uuidParam(c, "workspace_id");
    const unmounted = await store.datasources.revoke(state.sql, id, workspaceId);
    await store.audit.record(state.sql, null, user.id, "data_source.revoked", "data_source", id, {
      workspace_id: workspaceId,
      unmounted,
    });
    return c.json({ ok: true, unmounted });
  });
}

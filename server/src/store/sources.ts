/** Ingest source store: "a source is a folder" — a source is a container holding the documents it ingested, optionally synced on a schedule. */

import { Cron } from "croner";
import { q, qOne, qOpt, exec, type Sql } from "../core/db";
import { AppError } from "../core/errors";
import { newId, type Uuid } from "../core/ids";
import type { Role, Source } from "../core/models";
import * as alerts from "./alerts";

/** A source sync run record (channel audit trail). */
export type SyncRun = {
  id: Uuid;
  started_at: Date;
  finished_at: Date | null;
  /** running | ok | failed */
  status: string;
  created_docs: number;
  updated_docs: number;
  error: string | null;
};

/**
 * folder = a plain container (drop files in, no sync semantics); url/rss
 * = pull-based; api = push-based. Watching a local directory
 * (watch_folder) has been vetoed — a self-hosted user cannot see the
 * server's disk; the future shape of "watch" is object storage / cloud
 * drives (a P5 connector, paired with the BlobStore seam). custom = a
 * custom puller: any URL implementing the Utopia ingest interface
 * (returning an items JSON) can be pulled on a schedule. github_issues /
 * jira_issues = tickets: a ticket, together with its status-change
 * history, becomes one document.
 *
 * Changing this list means changing the frontend's copy too (the
 * create-source dialog in `Library.tsx` and `SourceView["kind"]` in
 * `api.ts`). When the two drift, the symptom is: the UI offers it, and
 * creating it fails with "kind must be one of…" — neither unit tests
 * nor tsc catch this, only an end-to-end test would.
 */
export const KINDS = ["folder", "url", "rss", "api", "custom", "github_issues", "jira_issues"];

/** Validates and normalizes a standard 5-field cron expression. */
export function validateCron(expr: string): string {
  const normalized = expr.trim().split(/\s+/).join(" ");
  const fields = normalized.split(" ").length;
  if (fields !== 5) {
    throw AppError.invalid(
      "bad_cron_fields",
      "Cron expression must have 5 fields (minute hour day month weekday)",
      `got ${fields}`,
    );
  }
  try {
    new Cron(normalized);
  } catch (e) {
    throw AppError.invalid(
      "bad_cron",
      "Invalid cron expression",
      e instanceof Error ? e.message : String(e),
    );
  }
  return normalized;
}

/** The cron's next trigger time (server local timezone). */
function cronNextAfter(expr: string, after: Date): Date | null {
  try {
    return new Cron(expr).nextRun(after);
  } catch {
    return null;
  }
}

/** A source list row (list & mounted share this shape). config strips `auth_header`: a custom puller's credentials are never sent to any client. */
export type SourceView = {
  id: Uuid;
  kind: string;
  name: string;
  config: unknown;
  icon: string | null;
  sync_interval_minutes: number | null;
  sync_cron: string | null;
  last_sync_at: Date | null;
  last_sync_status: string;
  last_sync_error: string | null;
  last_sync_added: number;
  doc_count: number;
  missing_count: number;
};

export async function list(sql: Sql, kbId: Uuid): Promise<SourceView[]> {
  return q<SourceView>(
    sql,
    `SELECT s.id, s.kind, s.name, s.config - 'auth_header' AS config, s.icon,
            s.sync_interval_minutes, s.sync_cron,
            s.last_sync_at, s.last_sync_status, s.last_sync_error, s.last_sync_added,
            (SELECT count(*) FROM documents d WHERE d.source_id = s.id) AS doc_count,
            (SELECT count(*) FROM documents d
             WHERE d.source_id = s.id AND d.missing_since IS NOT NULL) AS missing_count
     FROM sources s WHERE s.kb_id = $1 ORDER BY s.created_at`,
    [kbId],
  );
}

export async function get(sql: Sql, id: Uuid): Promise<Source> {
  const row = await qOpt<Source>(sql, `SELECT * FROM sources WHERE id = $1`, [id]);
  if (!row) throw AppError.notFound();
  return row;
}

export async function create(
  sql: Sql,
  kbId: Uuid,
  kind: string,
  name: string,
  config: unknown,
  icon: string | null,
  syncIntervalMinutes: number | null,
  syncCron: string | null,
): Promise<Source> {
  if (!KINDS.includes(kind)) {
    throw AppError.validation(`kind must be one of: ${KINDS.join(", ")}`);
  }
  if (name.trim().length === 0) {
    throw AppError.invalid("source_name_required", "Source name is required");
  }
  // Mutually exclusive: cron wins (the UI only ever sends one of them).
  const cronNorm = syncCron != null ? validateCron(syncCron) : null;
  const interval = cronNorm != null ? null : syncIntervalMinutes;
  // A serde-style JSON null would land in the database as jsonb null,
  // and the frontend reading config.x would blow up right away —
  // normalize it to an empty object.
  const normalizedConfig = config == null ? {} : config;
  return qOne<Source>(
    sql,
    `INSERT INTO sources (id, kb_id, kind, name, config, icon, sync_interval_minutes, sync_cron)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [newId(), kbId, kind, name.trim(), normalizedConfig, icon, interval, cronNorm],
  );
}

/** Sets an api source's push secret (on creation / rotation). */
export async function setIngestToken(sql: Sql, sourceId: Uuid, token: string): Promise<void> {
  const res = await exec(sql, `UPDATE sources SET ingest_token = $2 WHERE id = $1`, [
    sourceId,
    token,
  ]);
  if (res.count === 0) throw AppError.notFound();
}

/** Updates the schedule: interval and cron are mutually exclusive; setting either overwrites both. */
export async function update(
  sql: Sql,
  id: Uuid,
  name: string | null,
  config: unknown | undefined,
  icon: string | null,
  schedule: { interval: number | null; cron: string | null } | null,
): Promise<Source> {
  let scheduleNorm: { interval: number | null; cron: string | null } | null = null;
  if (schedule) {
    const cronNorm = schedule.cron != null ? validateCron(schedule.cron) : null;
    const interval = cronNorm != null ? null : schedule.interval;
    scheduleNorm = { interval, cron: cronNorm };
  }
  const row = await qOpt<Source>(
    sql,
    `UPDATE sources SET
        name = COALESCE($2, name),
        config = COALESCE($3, config),
        icon = COALESCE($4, icon),
        sync_interval_minutes = CASE WHEN $5 THEN $6 ELSE sync_interval_minutes END,
        sync_cron = CASE WHEN $5 THEN $7 ELSE sync_cron END
     WHERE id = $1 RETURNING *`,
    [
      id,
      name,
      config ?? null,
      icon,
      scheduleNorm != null,
      scheduleNorm?.interval ?? null,
      scheduleNorm?.cron ?? null,
    ],
  );
  if (!row) throw AppError.notFound();
  return row;
}

/** Deletes a source; its documents remain (source_id set to NULL, falling back into the Uploads group). */
export async function del(sql: Sql, id: Uuid): Promise<void> {
  const res = await exec(sql, `DELETE FROM sources WHERE id = $1`, [id]);
  if (res.count === 0) throw AppError.notFound();
}

/**
 * Sources due for a sync (the scheduler scans every minute). The
 * interval kind is decided in SQL; the cron kind is fetched back and
 * its next trigger time computed here, then filtered.
 */
export async function dueSources(sql: Sql): Promise<Source[]> {
  const rows = await q<Source>(
    sql,
    `SELECT * FROM sources
     WHERE last_sync_status NOT IN ('queued', 'running')
       AND ((sync_interval_minutes IS NOT NULL
             AND (last_sync_at IS NULL
                  OR last_sync_at + make_interval(mins => sync_interval_minutes) <= now()))
            OR sync_cron IS NOT NULL)`,
  );

  const now = new Date();
  return rows.filter((s) => {
    if (s.sync_cron == null) return true; // the interval kind is already filtered in SQL
    // The anchor is the last sync time (or creation time if never
    // synced): a missed trigger point is caught on the next scan.
    const anchor = s.last_sync_at ?? s.created_at;
    const next = cronNextAfter(s.sync_cron, anchor);
    return next != null && next <= now;
  });
}

/** Marks queued (idempotent: already queued/running returns false, avoiding a duplicate enqueue). */
export async function markQueued(sql: Sql, id: Uuid): Promise<boolean> {
  const res = await exec(
    sql,
    `UPDATE sources SET last_sync_status = 'queued'
     WHERE id = $1 AND last_sync_status NOT IN ('queued', 'running')`,
    [id],
  );
  return res.count > 0;
}

export async function markRunning(sql: Sql, id: Uuid): Promise<void> {
  await exec(sql, `UPDATE sources SET last_sync_status = 'running' WHERE id = $1`, [id]);
}

/**
 * Wraps up one sync. On failure it records an alert; on success it does
 * nothing — whether things are fine right now is not this module's
 * question, the source page already shows it.
 *
 * The return value says whether it recorded anything; the caller uses it
 * to decide whether to push an event.
 */
export async function finishSync(
  sql: Sql,
  id: Uuid,
  error: string | null,
  added: number,
): Promise<boolean> {
  const row = await qOpt<{ kb_id: Uuid; name: string }>(
    sql,
    `UPDATE sources SET last_sync_status = $2, last_sync_error = $3,
            last_sync_added = $4, last_sync_at = now()
     WHERE id = $1
     RETURNING kb_id, name`,
    [id, error != null ? "failed" : "ok", error, added],
  );
  if (!row) return false;
  if (error == null) return false;
  await alerts.raise(sql, {
    kb_id: row.kb_id,
    severity: "error",
    kind: alerts.kind.SOURCE_SYNC_FAILED,
    // Content roles get this too, not only admins: an admin needs to
    // know the connection needs fixing, but whoever configured this
    // source needs even more to know their content did not come in.
    min_role: "editor" as Role,
    subject_type: "source",
    subject_id: id,
    // The name is stored once here: once the source is deleted,
    // subject_id no longer resolves to a name, and the alert should
    // still keep it.
    detail: { name: row.name, error },
  });
  return true;
}

/**
 * Tags a document (replaces the whole set).
 *
 * Zero call sites, kept on purpose: no route, no entry point in the UI.
 * Tags would be the one dimension a person hand-labels on a document —
 * the source says where it came from, name and status come from the
 * system, and neither can express "this batch needs redacting", a
 * grouping that cuts across sources and only a person would know.
 * Whether this dimension should exist is still undecided — the full
 * case for both sides is written in `migrations/0002_ingest.sql`'s
 * `tags` column comment; do not delete it as dead code.
 */
export async function setDocumentTags(
  sql: Sql,
  kbId: Uuid,
  documentId: Uuid,
  tags: string[],
): Promise<void> {
  const cleaned = tags.map((t) => t.trim()).filter((t) => t.length > 0);
  const res = await exec(
    sql,
    `UPDATE documents SET tags = $3, updated_at = now() WHERE id = $1 AND kb_id = $2`,
    [documentId, kbId, cleaned],
  );
  if (res.count === 0) throw AppError.notFound();
}

/** Dedup helper for sync: whether this KB already has a document with identical content. */
export async function documentExistsBySha(sql: Sql, kbId: Uuid, sha256: string): Promise<boolean> {
  const row = await qOpt<{ id: Uuid }>(
    sql,
    `SELECT id FROM documents WHERE kb_id = $1 AND sha256 = $2 LIMIT 1`,
    [kbId, sha256],
  );
  return row != null;
}

/** Records the sync time (avoids the scheduler re-triggering during a long sync and again right after). */
export async function touchSyncTime(sql: Sql, id: Uuid, at: Date): Promise<void> {
  await exec(sql, `UPDATE sources SET last_sync_at = $2 WHERE id = $1`, [id, at]);
}

// ---------------------------------------------------------------------------
// Sync run history (channel audit trail)
// ---------------------------------------------------------------------------

export async function startRun(sql: Sql, sourceId: Uuid): Promise<Uuid> {
  const id = newId();
  await exec(sql, `INSERT INTO source_sync_runs (id, source_id) VALUES ($1, $2)`, [
    id,
    sourceId,
  ]);
  return id;
}

export async function finishRun(
  sql: Sql,
  runId: Uuid,
  sourceId: Uuid,
  error: string | null,
  createdDocs: number,
  updatedDocs: number,
): Promise<void> {
  await exec(
    sql,
    `UPDATE source_sync_runs SET finished_at = now(), status = $2, error = $3,
            created_docs = $4, updated_docs = $5
     WHERE id = $1`,
    [runId, error != null ? "failed" : "ok", error, createdDocs, updatedDocs],
  );
  // Keep only the most recent 50 runs per source.
  await exec(
    sql,
    `DELETE FROM source_sync_runs WHERE source_id = $1 AND id NOT IN
     (SELECT id FROM source_sync_runs WHERE source_id = $1
      ORDER BY started_at DESC LIMIT 50)`,
    [sourceId],
  );
}

export async function listRuns(sql: Sql, sourceId: Uuid, limit: number): Promise<SyncRun[]> {
  return q<SyncRun>(
    sql,
    `SELECT id, started_at, finished_at, status, created_docs, updated_docs, error
     FROM source_sync_runs WHERE source_id = $1
     ORDER BY started_at DESC LIMIT $2`,
    [sourceId, limit],
  );
}

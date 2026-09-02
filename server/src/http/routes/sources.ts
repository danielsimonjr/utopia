/**
 * Source management API, plus text-push ingest.
 */

import type { Hono } from "hono";
import type { AppState } from "../../state";
import * as store from "../../store";
import * as auth from "../../auth";
import { AppError } from "../../core/errors";
import type { Source } from "../../core/models";
import type { Uuid } from "../../core/ids";
import { uuidParam } from "../context";
import { ingestUpload, ingestItem, type IngestAction } from "../../ingest_sources";

/** Generates an api source's push secret. */
function newIngestToken(): string {
  return `utp_${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`;
}

function actionStr(action: IngestAction): string {
  switch (action) {
    case "Created":
      return "created";
    case "Updated":
      return "updated";
    case "Moved":
      return "moved";
    case "Unchanged":
      return "unchanged";
    case "Tombstoned":
      return "marked_missing";
  }
}

/** Strips credentials before a response leaves the server (`auth_header` goes in, never comes back out). */
function maskSecrets(source: Source): Source {
  if (source.config && typeof source.config === "object" && !Array.isArray(source.config)) {
    const { auth_header: _drop, ...rest } = source.config as Record<string, unknown>;
    return { ...source, config: rest as Source["config"] };
  }
  return source;
}

export function registerSourceRoutes(api: Hono, state: AppState): void {
  api.get("/kbs/:id/sources", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    await store.access.requireKb(state.sql, user, kbId, "viewer");
    const sources = await store.sources.list(state.sql, kbId);
    return c.json({ sources });
  });

  api.post("/kbs/:id/sources", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    await store.access.requireKb(state.sql, user, kbId, "editor");
    const body = (await c.req.json()) as {
      kind: string;
      name: string;
      config?: unknown;
      icon?: string;
      sync_interval_minutes?: number;
      sync_cron?: string;
    };
    const source = await store.sources.create(
      state.sql,
      kbId,
      body.kind,
      body.name,
      body.config ?? {},
      body.icon ?? null,
      body.sync_interval_minutes ?? null,
      body.sync_cron ?? null,
    );
    // A pull-based source syncs once right after creation: it already has
    // a config to act on, no need to wait for the next scheduled tick.
    if (source.kind === "url" || source.kind === "rss" || source.kind === "custom") {
      await store.sources.markQueued(state.sql, source.id).catch(() => {});
      await store.jobs.enqueue(state.sql, "sync_source", { source_id: source.id });
    }
    // An api source gets its own push secret (viewable later through get_token).
    let ingestToken: string | null = null;
    if (source.kind === "api") {
      const token = newIngestToken();
      await store.sources.setIngestToken(state.sql, source.id, token);
      ingestToken = token;
    }
    state.emitSource(kbId);
    await store.audit
      .record(state.sql, kbId, user.id, "source.created", "source", source.id, {
        kind: source.kind,
        name: source.name,
      })
      .catch(() => {});
    return c.json({ source: maskSecrets(source), ingest_token: ingestToken });
  });

  // Views an api source's push secret (editor; the list response never carries it).
  api.get("/kbs/:id/sources/:source_id/token", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    const sourceId = uuidParam(c, "source_id");
    await store.access.requireKb(state.sql, user, kbId, "editor");
    const source = await store.sources.get(state.sql, sourceId);
    if (source.kb_id !== kbId || source.kind !== "api") throw AppError.notFound();
    return c.json({ ingest_token: source.ingest_token });
  });

  // Rotates an api source's push secret: the old secret stops working immediately.
  api.post("/kbs/:id/sources/:source_id/rotate-token", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    const sourceId = uuidParam(c, "source_id");
    await store.access.requireKb(state.sql, user, kbId, "editor");
    const source = await store.sources.get(state.sql, sourceId);
    if (source.kb_id !== kbId || source.kind !== "api") throw AppError.notFound();
    const token = newIngestToken();
    await store.sources.setIngestToken(state.sql, sourceId, token);
    return c.json({ ingest_token: token });
  });

  api.patch("/kbs/:id/sources/:source_id", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    const sourceId = uuidParam(c, "source_id");
    await store.access.requireKb(state.sql, user, kbId, "editor");
    const body = (await c.req.json()) as {
      name?: string;
      config?: Record<string, unknown>;
      icon?: string;
      schedule?: { sync_interval_minutes?: number | null; sync_cron?: string | null };
    };
    // Credentials go in, never come back out: the response never echoes
    // `auth_header`, so a blank field on the form means "keep the value already stored".
    let config = body.config;
    if (config) {
      const raw = config.auth_header;
      const blank = typeof raw !== "string" || raw.trim() === "";
      if (blank) {
        delete config.auth_header;
        const existing = await store.sources.get(state.sql, sourceId);
        const prevHeader = (existing.config as Record<string, unknown> | null)?.auth_header;
        if (typeof prevHeader === "string") config.auth_header = prevHeader;
      }
    }
    const source = await store.sources.update(
      state.sql,
      sourceId,
      body.name ?? null,
      config,
      body.icon ?? null,
      body.schedule ? { interval: body.schedule.sync_interval_minutes ?? null, cron: body.schedule.sync_cron ?? null } : null,
    );
    state.emitSource(kbId);
    // Credentials never land in the audit log: config is recorded as "changed", not by value.
    await store.audit
      .record(state.sql, kbId, user.id, "source.updated", "source", sourceId, {
        name: body.name ?? null,
        config_changed: config !== undefined,
      })
      .catch(() => {});
    return c.json({ source: maskSecrets(source) });
  });

  // Bulk-deletes every document under this source that is "not in the source" (flagged by a URL reconciliation or a custom puller's tombstone list).
  api.post("/kbs/:id/sources/:source_id/missing/cleanup", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    const sourceId = uuidParam(c, "source_id");
    await store.access.requireKb(state.sql, user, kbId, "editor");
    const ids = await store.documents.listMissing(state.sql, sourceId);
    for (const id of ids) {
      await store.documents.del(state.sql, id);
      await state.search.deleteDocument(id);
    }
    state.emitSource(kbId);
    return c.json({ deleted: ids.length });
  });

  api.delete("/kbs/:id/sources/:source_id", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    const sourceId = uuidParam(c, "source_id");
    await store.access.requireKb(state.sql, user, kbId, "editor");
    // The Memory source is permanent: memory space does not evaporate
    // because someone tidied up sources (the memory documents themselves
    // can be deleted individually from Library).
    const source = await store.sources.get(state.sql, sourceId);
    if (source.kind === store.memory.MEMORY_SOURCE_KIND) {
      throw AppError.invalid("memory_source_permanent", "The Memory source is permanent.");
    }
    await store.sources.del(state.sql, sourceId);
    state.emitSource(kbId);
    await store.audit.record(state.sql, kbId, user.id, "source.deleted", "source", sourceId, {}).catch(() => {});
    return c.json({ ok: true });
  });

  // Sync run history (channel audit trail).
  api.get("/kbs/:id/sources/:source_id/runs", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    const sourceId = uuidParam(c, "source_id");
    await store.access.requireKb(state.sql, user, kbId, "viewer");
    const runs = await store.sources.listRuns(state.sql, sourceId, 20);
    return c.json({ runs });
  });

  api.post("/kbs/:id/sources/:source_id/sync", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    const sourceId = uuidParam(c, "source_id");
    await store.access.requireKb(state.sql, user, kbId, "editor");
    const queued = await store.sources.markQueued(state.sql, sourceId);
    if (queued) {
      await store.jobs.enqueue(state.sql, "sync_source", { source_id: sourceId });
      state.emitSource(kbId);
    }
    return c.json({ queued });
  });

  // KB-level text push (session auth): plain-upload semantics — lands in
  // Uploads, no identity tracking. When "same id pushed again = update"
  // semantics are needed, create an api source and push with its secret instead.
  api.post("/kbs/:id/ingest", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    await store.access.requireKb(state.sql, user, kbId, "editor");
    const body = (await c.req.json()) as {
      filename: string;
      content: string;
      doc_time?: string;
      external_id?: string;
      deleted?: boolean;
    };
    if (body.deleted) {
      throw AppError.validation("tombstones need identity tracking — push to an api source instead");
    }
    if (!body.filename?.trim() || !body.content?.trim()) {
      throw AppError.validation("filename and content are required");
    }
    const action = await ingestUpload(
      state,
      kbId,
      body.filename.trim(),
      "text/plain",
      new TextEncoder().encode(body.content),
      body.doc_time ? new Date(body.doc_time) : null,
    );
    return c.json({ action: actionStr(action) });
  });

  // api source push (source-specific secret auth, no session): three-way
  // identity semantics — new external_id -> created; same id, same
  // content -> no-op; same id, new content -> in-place update + version
  // record. Every authenticated push gets one run recorded (including
  // format errors — integration debugging relies entirely on this).
  // An unauthenticated request writes nothing (no storage path for anonymous traffic).
  api.post("/sources/:source_id/ingest", async (c) => {
    const sourceId = uuidParam(c, "source_id");
    const source = await store.sources.get(state.sql, sourceId);
    if (source.kind !== "api") throw AppError.notFound();

    const authHeader = c.req.header("authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    if (!token) throw AppError.unauthorized();
    if (source.ingest_token !== token) throw AppError.unauthorized();

    const bytes = new Uint8Array(await c.req.arrayBuffer());
    const run = await store.sources.startRun(state.sql, source.id);
    try {
      const action = await handlePush(state, source, bytes);
      const [created, updated] = actionCounts(action);
      await store.sources.finishRun(state.sql, run, source.id, null, created, updated);
      // The source row mirrors "last push" too: the toolbar/status dot works off it directly.
      await store.sources.finishSync(state.sql, source.id, null, created);
      state.emitSource(source.kb_id);
      return c.json({ action: actionStr(action) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await store.sources.finishRun(state.sql, run, source.id, msg, 0, 0);
      await store.sources.finishSync(state.sql, source.id, msg, 0);
      state.emitSource(source.kb_id);
      throw AppError.validation(msg);
    }
  });

  // Source-scoped full re-extraction (incremental semantics): every ready
  // document under this source runs back through extraction. Goes
  // through the normal pipeline — entity resolution, fact dedup, and
  // temporal conflicts all apply as usual, and every prior human decision is kept.
  api.post("/kbs/:id/sources/:source_id/re-extract", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    const sourceId = uuidParam(c, "source_id");
    await store.access.requireKb(state.sql, user, kbId, "editor");
    const source = await store.sources.get(state.sql, sourceId);
    if (source.kb_id !== kbId) throw AppError.notFound();
    const ids = await store.documents.queueExtraction(state.sql, kbId, sourceId);
    for (const id of ids) state.emitDocument(kbId, id);
    await store.audit
      .record(state.sql, kbId, user.id, "source.re_extract", "source", sourceId, {
        name: source.name,
        documents: ids.length,
      })
      .catch(() => {});
    return c.json({ queued: ids.length });
  });
}

function actionCounts(action: IngestAction): [number, number] {
  switch (action) {
    case "Created":
      return [1, 0];
    case "Updated":
    case "Moved":
      return [0, 1];
    case "Unchanged":
    case "Tombstoned":
      return [0, 0];
  }
}

/** Post-authentication push handling: parse + validate + ingest/tombstone. Errors are always returned as text (recorded on the run). */
async function handlePush(state: AppState, source: Source, bytes: Uint8Array): Promise<IngestAction> {
  let body: { filename?: string; content?: string; doc_time?: string; external_id?: string; deleted?: boolean };
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) {
    throw new Error(`Invalid JSON payload: ${e instanceof Error ? e.message : String(e)}`);
  }
  const identity = body.external_id?.trim() || body.filename?.trim() || "";
  if (!identity) throw new Error("external_id or filename is required");
  const key = `api:${identity}`;

  // Tombstone: flag "not in the source" (same path as custom's deleted[]); content may be omitted.
  if (body.deleted) {
    await store.documents.markMissingKeys(state.sql, source.id, [key]);
    return "Tombstoned";
  }

  if (!body.filename?.trim() || !body.content?.trim()) {
    throw new Error("filename and content are required");
  }
  const action = await ingestItem(
    state,
    source.kb_id,
    source.id,
    key,
    body.filename.trim(),
    "text/plain",
    new TextEncoder().encode(body.content),
    body.doc_time ? new Date(body.doc_time) : null,
  );
  // Found again: an identity once flagged tombstoned, pushed normally
  // again, has its "missing" flag lifted.
  await store.documents.clearMissingKeys(state.sql, source.id, [key]);
  return action;
}
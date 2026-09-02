/**
 * Document upload, listing, and per-document operations.
 */

import type { Hono } from "hono";
import type { AppState } from "../../state";
import * as store from "../../store";
import * as auth from "../../auth";
import { AppError, isAppError } from "../../core/errors";
import type { Document } from "../../core/models";
import type { Uuid } from "../../core/ids";
import { uuidParam, queryStr, queryInt, clampLimit, clampOffset } from "../context";

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** `undefined` = all, `null` = only documents without a source, a Uuid = one source. Mirrors the query string convention used throughout the library API. */
function parseScope(raw: string | undefined): Uuid | null | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (raw === "none") return null;
  return raw;
}

function sha256Hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

export function registerDocumentRoutes(api: Hono, state: AppState): void {
  api.post("/kbs/:id/documents", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    await store.access.requireKb(state.sql, user, kbId, "editor");

    const sourceParam = queryStr(c, "source");
    let targetSource: Uuid | null = null;
    if (sourceParam) {
      const src = await store.sources.get(state.sql, sourceParam);
      if (src.kb_id !== kbId || src.kind !== "folder") {
        throw AppError.invalid(
          "upload_needs_folder",
          "Uploads can only target a folder source in this knowledge base",
        );
      }
      targetSource = sourceParam;
    }

    let body: Record<string, unknown>;
    try {
      body = await c.req.parseBody({ all: true });
    } catch (e) {
      throw AppError.invalid("bad_upload", "Malformed upload", String(e));
    }
    const raw = body.files;
    const files = Array.isArray(raw) ? raw : raw !== undefined ? [raw] : [];

    const created: Document[] = [];
    const skipped: Record<string, unknown>[] = [];

    for (const field of files) {
      if (!(field instanceof File)) continue;
      const filename = field.name;
      const mime = field.type || "application/octet-stream";
      const bytes = new Uint8Array(await field.arrayBuffer());
      if (bytes.byteLength === 0) {
        skipped.push({ filename, reason: "empty file" });
        continue;
      }
      if (bytes.byteLength > MAX_UPLOAD_BYTES) {
        skipped.push({ filename, reason: "file too large" });
        continue;
      }

      const sha256 = sha256Hex(bytes);
      await state.blob.put(sha256, bytes);

      try {
        const doc = await store.documents.create(
          state.sql,
          kbId,
          filename,
          mime,
          bytes.byteLength,
          sha256,
          targetSource,
          null,
          null,
        );
        await store.jobs.enqueue(state.sql, "process_document", { document_id: doc.id });
        created.push(doc);
      } catch (e) {
        if (isAppError(e) && e.kind === "Conflict") {
          skipped.push({ filename, reason: "duplicate content" });
        } else {
          throw e;
        }
      }
    }

    if (created.length === 0 && skipped.length === 0) {
      throw AppError.invalid("no_files", "No files received");
    }
    return c.json({ created, skipped });
  });

  api.get("/kbs/:id/documents", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    await store.access.requireKb(state.sql, user, kbId, "viewer");
    const page = await store.documents.page(
      state.sql,
      kbId,
      parseScope(queryStr(c, "source")),
      queryStr(c, "q")?.trim() || null,
      queryStr(c, "graph") || null,
      clampLimit(queryInt(c, "limit"), 15, 200),
      clampOffset(queryInt(c, "offset")),
    );
    return c.json(page);
  });

  api.post("/kbs/:id/documents/retry-failed", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    await store.access.requireKb(state.sql, user, kbId, "editor");
    const ids = await store.documents.failedIds(state.sql, kbId, parseScope(queryStr(c, "source")));
    let queued = 0;
    for (const id of ids) {
      try {
        await store.documents.queueExtractionOne(state.sql, id);
        queued += 1;
      } catch {
        // One failing document must not stop the rest of the batch.
      }
    }
    if (queued > 0 && ids[0]) {
      state.emitDocument(kbId, ids[0]);
    }
    return c.json({ queued, found: ids.length });
  });

  api.get("/kbs/:id/extraction-drops", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    await store.access.requireKb(state.sql, user, kbId, "viewer");
    const drops = await store.extractionDrops.forKb(state.sql, kbId);
    return c.json({ drops });
  });

  api.get("/documents/:id", async (c) => {
    const user = await auth.requireUser(c, state);
    const id = uuidParam(c, "id");
    const doc = await store.documents.get(state.sql, id);
    await store.access.requireKb(state.sql, user, doc.kb_id, "viewer");
    const chunks = await store.documents.chunksFull(state.sql, id);
    return c.json({ document: doc, chunks });
  });

  api.get("/documents/:id/extractions", async (c) => {
    const user = await auth.requireUser(c, state);
    const id = uuidParam(c, "id");
    const doc = await store.documents.get(state.sql, id);
    await store.access.requireKb(state.sql, user, doc.kb_id, "viewer");
    const facts = await store.graph.document_extractions(state.sql, id);
    return c.json({ facts });
  });

  api.delete("/documents/:id", async (c) => {
    const user = await auth.requireUser(c, state);
    const id = uuidParam(c, "id");
    const doc = await store.documents.get(state.sql, id);
    await store.access.requireKb(state.sql, user, doc.kb_id, "editor");
    await store.documents.del(state.sql, id);
    await state.search.deleteDocument(id);
    await store.audit.record(state.sql, doc.kb_id, user.id, "document.deleted", "document", id, {
      filename: doc.filename,
    });
    return c.json({ ok: true });
  });

  api.post("/documents/:id/reprocess", async (c) => {
    const user = await auth.requireUser(c, state);
    const id = uuidParam(c, "id");
    const doc = await store.documents.get(state.sql, id);
    await store.access.requireKb(state.sql, user, doc.kb_id, "editor");
    await store.documents.setStatus(state.sql, id, "pending");
    const jobId = await store.jobs.enqueue(state.sql, "process_document", { document_id: id });
    return c.json({ job_id: jobId });
  });
}

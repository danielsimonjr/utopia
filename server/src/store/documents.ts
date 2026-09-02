import { q, qOne, qOpt, exec, type Sql } from "../core/db";
import { AppError, isAppError } from "../core/errors";
import { newId, type Uuid } from "../core/ids";
import type { ChunkView, Document } from "../core/models";

/** A piece produced by the chunker (see `ingest/chunker`). */
export type ChunkPiece = {
  seq: number;
  text: string;
  char_start: number;
  char_end: number;
};

/**
 * A page of the library, plus stats beyond that page.
 *
 * The stats are not affected by the name/status filters: `ready` /
 * `extracting` / `failed` describe how many exist in this source, which
 * is the scope of the bulk-action buttons — unrelated to whatever is
 * currently being searched for.
 */
export type DocumentPage = {
  docs: Document[];
  /** Total matching the filters (the pager uses this) */
  total: number;
  ready: number;
  extracting: number;
  failed: number;
};

/** A document viewer chunk view. */
export type ChunkFull = {
  id: Uuid;
  seq: number;
  text: string;
};

/** An extraction-ready chunk: text plus the embedding already computed at ingest time (reused by resolution v2, zero extra embed calls). */
export type ChunkForExtract = {
  id: Uuid;
  seq: number;
  text: string;
  embedding: number[] | null;
};

function toVectorParam(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

/** postgres.js has no built-in pgvector codec; a vector column comes back as its text form. */
function parseVector(v: unknown): number[] | null {
  if (v == null) return null;
  if (Array.isArray(v)) return v as number[];
  if (typeof v === "string") {
    const inner = v.trim().replace(/^\[/, "").replace(/\]$/, "");
    return inner === "" ? [] : inner.split(",").map(Number);
  }
  return null;
}

export async function create(
  sql: Sql,
  kbId: Uuid,
  filename: string,
  mime: string,
  sizeBytes: number,
  sha256: string,
  sourceId: Uuid | null,
  docTime: Date | null,
  externalKey: string | null,
): Promise<Document> {
  try {
    return await qOne<Document>(
      sql,
      `INSERT INTO documents (id, kb_id, filename, mime, size_bytes, sha256, source_id,
                              doc_time, doc_time_source, external_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, now()), $9, $10) RETURNING *`,
      [
        newId(),
        kbId,
        filename,
        mime,
        sizeBytes,
        sha256,
        sourceId,
        docTime,
        docTime != null ? "source" : "upload_time",
        externalKey,
      ],
    );
  } catch (e) {
    if (isAppError(e) && e.kind === "Conflict") {
      throw AppError.conflict(`File already exists (identical content): ${filename}`);
    }
    throw e;
  }
}

export async function list(sql: Sql, kbId: Uuid): Promise<Document[]> {
  return q<Document>(sql, `SELECT * FROM documents WHERE kb_id = $1 ORDER BY created_at DESC`, [
    kbId,
  ]);
}

/**
 * A page of the library, with filters and stats.
 *
 * It used to be `SELECT * FROM documents WHERE kb_id = $1` with no cap,
 * client-side paginated. 27 documents were fine; twenty thousand would
 * push the whole table into the browser — and client-side filtering has
 * a subtler flaw: it can only filter what has already been fetched.
 *
 * Stats are computed separately, and **scoped only by source, not by
 * the name/status filters**: "how many in this source can be
 * extracted" is the scope of those two bulk buttons, unrelated to
 * whatever is currently being searched for.
 */
export async function page(
  sql: Sql,
  kbId: Uuid,
  // undefined = all; null = only docs without a source; a Uuid = one source
  source: Uuid | null | undefined,
  q_: string | null,
  graphStatus: string | null,
  limit: number,
  offset: number,
): Promise<DocumentPage> {
  // All three filters are written as "no-op when the parameter is
  // absent"; one query covers every combination. `$2 = 'any'` means "do
  // not filter by source", `'none'` means "only docs without a
  // source" — two sentinel strings instead of two nullable parameters,
  // because NULL is ambiguous here: it could mean "no filter" or
  // "filter for source_id IS NULL".
  const where = `WHERE kb_id = $1
         AND ($2 = 'any'
              OR ($2 = 'none' AND source_id IS NULL)
              OR source_id::text = $2)
         AND ($3::text IS NULL OR filename ILIKE '%' || $3 || '%')
         AND ($4::text IS NULL OR graph_status = $4)`;
  const scope = source === undefined ? "any" : source === null ? "none" : source;

  const docs = await q<Document>(
    sql,
    `SELECT * FROM documents ${where} ORDER BY created_at DESC LIMIT $5 OFFSET $6`,
    [kbId, scope, q_, graphStatus, limit, offset],
  );

  const total = await qOne<{ count: string }>(
    sql,
    `SELECT count(*) FROM documents ${where}`,
    [kbId, scope, q_, graphStatus],
  );

  // Stats are scoped only by source: those two bulk buttons act on the
  // whole source, not on whatever was just searched for.
  const stats = await qOne<{ ready: string; extracting: string; failed: string }>(
    sql,
    `SELECT
       count(*) FILTER (WHERE status = 'ready') AS ready,
       count(*) FILTER (WHERE graph_status IN ('queued', 'extracting')) AS extracting,
       count(*) FILTER (WHERE graph_status = 'failed') AS failed
     FROM documents
     WHERE kb_id = $1
           AND ($2 = 'any'
                OR ($2 = 'none' AND source_id IS NULL)
                OR source_id::text = $2)`,
    [kbId, scope],
  );

  return {
    docs,
    total: Number(total.count),
    ready: Number(stats.ready),
    extracting: Number(stats.extracting),
    failed: Number(stats.failed),
  };
}

/** The ids of documents in this source (or the whole KB) whose extraction failed. A one-click retry needs exactly this list. */
export async function failedIds(
  sql: Sql,
  kbId: Uuid,
  source: Uuid | null | undefined,
): Promise<Uuid[]> {
  const scope = source === undefined ? "any" : source === null ? "none" : source;
  const rows = await q<{ id: Uuid }>(
    sql,
    `SELECT id FROM documents
      WHERE kb_id = $1 AND graph_status = 'failed'
        AND ($2 = 'any'
             OR ($2 = 'none' AND source_id IS NULL)
             OR source_id::text = $2)`,
    [kbId, scope],
  );
  return rows.map((r) => r.id);
}

export async function get(sql: Sql, id: Uuid): Promise<Document> {
  const row = await qOpt<Document>(sql, `SELECT * FROM documents WHERE id = $1`, [id]);
  if (!row) throw AppError.notFound();
  return row;
}

/** Finds a document by its logical identity within a source (used for the three-way sync decision). */
export async function findByExternalKey(
  sql: Sql,
  sourceId: Uuid,
  externalKey: string,
): Promise<Document | null> {
  return qOpt<Document>(
    sql,
    `SELECT * FROM documents WHERE source_id = $1 AND external_key = $2`,
    [sourceId, externalKey],
  );
}

/** Finds a document by source + content hash (used to detect a rename/move). */
export async function findBySourceSha(
  sql: Sql,
  sourceId: Uuid,
  sha256: string,
): Promise<Document | null> {
  return qOpt<Document>(
    sql,
    `SELECT * FROM documents WHERE source_id = $1 AND sha256 = $2 LIMIT 1`,
    [sourceId, sha256],
  );
}

/** Claims a pre-migration legacy document (no external_key) by filename — a one-time fallback for rows created before 0008. */
export async function findLegacyByFilename(
  sql: Sql,
  sourceId: Uuid,
  filename: string,
): Promise<Document | null> {
  return qOpt<Document>(
    sql,
    `SELECT * FROM documents
     WHERE source_id = $1 AND external_key IS NULL AND filename = $2 LIMIT 1`,
    [sourceId, filename],
  );
}

/** Backfills a logical identity onto a legacy document. */
export async function adoptExternalKey(sql: Sql, id: Uuid, externalKey: string): Promise<void> {
  await exec(sql, `UPDATE documents SET external_key = $2, updated_at = now() WHERE id = $1`, [
    id,
    externalKey,
  ]);
}

/** Change: replaces a document's content in place (new sha), state back to pending to rerun the pipeline. */
export async function replaceContent(
  sql: Sql,
  id: Uuid,
  filename: string,
  mime: string,
  sizeBytes: number,
  sha256: string,
  docTime: Date | null,
): Promise<void> {
  await exec(
    sql,
    `UPDATE documents SET filename = $2, mime = $3, size_bytes = $4, sha256 = $5,
            doc_time = COALESCE($6, doc_time),
            status = 'pending', graph_status = 'none', error = NULL,
            missing_since = NULL, updated_at = now()
     WHERE id = $1`,
    [id, filename, mime, sizeBytes, sha256, docTime],
  );
}

/** Move/rename: same content, new path — only the identity is updated, the pipeline does not rerun. */
export async function updateLocation(
  sql: Sql,
  id: Uuid,
  filename: string,
  externalKey: string,
): Promise<void> {
  await exec(
    sql,
    `UPDATE documents SET filename = $2, external_key = $3, missing_since = NULL,
            updated_at = now() WHERE id = $1`,
    [id, filename, externalKey],
  );
}

/** Records a content version (auto-incrementing version number). */
export async function recordVersion(
  sql: Sql,
  documentId: Uuid,
  sha256: string,
  sizeBytes: number,
): Promise<void> {
  await exec(
    sql,
    `INSERT INTO document_versions (id, document_id, version, sha256, size_bytes)
     VALUES ($1, $2,
             (SELECT coalesce(max(version), 0) + 1 FROM document_versions WHERE document_id = $2),
             $3, $4)`,
    [newId(), documentId, sha256, sizeBytes],
  );
}

/**
 * Full reconciliation (only for source kinds that can see the source's
 * complete current state, like a url source's config list): keys seen
 * this round have their missing flag cleared, keys not seen get flagged.
 * rss (a sliding window) and custom's incremental response (?since=) may
 * not use this — absence there does not mean deletion.
 */
export async function reconcileMissing(
  sql: Sql,
  sourceId: Uuid,
  seenKeys: string[],
): Promise<void> {
  await clearMissingKeys(sql, sourceId, seenKeys);
  await exec(
    sql,
    `UPDATE documents SET missing_since = now(), updated_at = now()
     WHERE source_id = $1 AND missing_since IS NULL
       AND external_key IS NOT NULL AND NOT (external_key = ANY($2))`,
    [sourceId, seenKeys],
  );
}

/** Clears the missing flag for entries seen this round (an item reappeared). */
export async function clearMissingKeys(
  sql: Sql,
  sourceId: Uuid,
  keys: string[],
): Promise<void> {
  await exec(
    sql,
    `UPDATE documents SET missing_since = NULL, updated_at = now()
     WHERE source_id = $1 AND missing_since IS NOT NULL AND external_key = ANY($2)`,
    [sourceId, keys],
  );
}

/** Explicit tombstones (a custom response's deleted[]): flag only when the source declares a deletion, never inferred from absence. */
export async function markMissingKeys(
  sql: Sql,
  sourceId: Uuid,
  keys: string[],
): Promise<number> {
  const res = await exec(
    sql,
    `UPDATE documents SET missing_since = now(), updated_at = now()
     WHERE source_id = $1 AND missing_since IS NULL AND external_key = ANY($2)`,
    [sourceId, keys],
  );
  return res.count;
}

/** Every document id already flagged missing under this source (used for bulk cleanup). */
export async function listMissing(sql: Sql, sourceId: Uuid): Promise<Uuid[]> {
  const rows = await q<{ id: Uuid }>(
    sql,
    `SELECT id FROM documents WHERE source_id = $1 AND missing_since IS NOT NULL`,
    [sourceId],
  );
  return rows.map((r) => r.id);
}

export async function setStatus(sql: Sql, id: Uuid, status: string): Promise<void> {
  await exec(
    sql,
    `UPDATE documents SET status = $2, error = NULL, updated_at = now() WHERE id = $1`,
    [id, status],
  );
}

export async function setFailed(sql: Sql, id: Uuid, error: string): Promise<void> {
  await exec(
    sql,
    `UPDATE documents SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`,
    [id, error],
  );
}

export async function setReady(
  sql: Sql,
  id: Uuid,
  textLen: number,
  chunkCount: number,
): Promise<void> {
  await exec(
    sql,
    `UPDATE documents SET status = 'ready', error = NULL, text_len = $2, chunk_count = $3,
            updated_at = now() WHERE id = $1`,
    [id, textLen, chunkCount],
  );
}

export async function del(sql: Sql, id: Uuid): Promise<void> {
  const res = await exec(sql, `DELETE FROM documents WHERE id = $1`, [id]);
  if (res.count === 0) throw AppError.notFound();
}

/**
 * Rebuilds a document's chunks (inside a transaction, idempotent).
 * Returns (chunk_id, text) pairs for the full-text index.
 *
 * Adopt-based incremental update: new chunks first look for a text
 * match among the current chunks — a match is "adopted" (the row only
 * gets its sequence/offsets/version updated; identity carries over:
 * embedding, extracted_at, evidence links all stay fresh, and an
 * unchanged paragraph is neither re-extracted nor wrongly flagged as
 * stale evidence). Anything without a match is inserted new. Old chunks
 * that lost out (no match in the new version) are soft-deleted
 * (stamped with `superseded_at`) rather than physically deleted —
 * `fact_evidence` references stay unbroken, an old version can still be
 * replayed, and the embedding is cleared (an old version does not
 * participate in retrieval, and vectors are the storage-heavy part, no
 * reason to keep them).
 */
export async function replaceChunks(
  sql: Sql,
  kbId: Uuid,
  documentId: Uuid,
  pieces: ChunkPiece[],
): Promise<[string, string][]> {
  return sql.begin(async (tx) => {
    const versionRow = await qOne<{ version: number }>(
      tx,
      `SELECT COALESCE(MAX(version), 1) AS version FROM document_versions WHERE document_id = $1`,
      [documentId],
    );
    const version = versionRow.version;

    // Adoption pool: current chunks grouped by text (duplicate text
    // within the same document is paired as a multiset, each occurrence
    // adopted independently).
    const old = await q<{ id: Uuid; text: string }>(
      tx,
      `SELECT id, text FROM chunks WHERE document_id = $1 AND superseded_at IS NULL`,
      [documentId],
    );
    const claimPool = new Map<string, Uuid[]>();
    for (const row of old) {
      const list = claimPool.get(row.text);
      if (list) list.push(row.id);
      else claimPool.set(row.text, [row.id]);
    }

    // Phase one: adopt (update in place) and build the insert list — new
    // chunks must wait for the soft-delete pass, otherwise the "lost"
    // check would soft-delete chunks that were just inserted this round.
    const adopted: Uuid[] = [];
    const toInsert: [Uuid, ChunkPiece][] = [];
    const out: [string, string][] = [];
    for (const piece of pieces) {
      const claims = claimPool.get(piece.text);
      const claimed = claims?.pop();
      if (claimed) {
        await exec(
          tx,
          `UPDATE chunks SET seq = $2, char_start = $3, char_end = $4, doc_version = $5
           WHERE id = $1`,
          [claimed, piece.seq, piece.char_start, piece.char_end, version],
        );
        adopted.push(claimed);
        out.push([claimed, piece.text]);
      } else {
        const id = newId();
        toInsert.push([id, piece]);
        out.push([id, piece.text]);
      }
    }

    // Phase two: soft-delete old chunks that lost out (no text match in
    // the new version).
    await exec(
      tx,
      `UPDATE chunks SET superseded_at = now(), embedding = NULL
       WHERE document_id = $1 AND superseded_at IS NULL AND NOT (id = ANY($2))`,
      [documentId, adopted],
    );

    // Phase three: insert new chunks.
    for (const [id, piece] of toInsert) {
      await exec(
        tx,
        `INSERT INTO chunks
            (id, kb_id, document_id, seq, text, char_start, char_end, doc_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, kbId, documentId, piece.seq, piece.text, piece.char_start, piece.char_end, version],
      );
    }
    return out;
  });
}

/** Flags a chunk as extracted once extraction finishes (an adopted chunk carries the flag forward, skipping re-extraction; this also lets an interrupted extraction resume). */
export async function markChunkExtracted(sql: Sql, chunkId: Uuid): Promise<void> {
  await exec(sql, `UPDATE chunks SET extracted_at = now() WHERE id = $1`, [chunkId]);
}

/**
 * Queues one document for a full re-extraction (manual Extract = forced,
 * full re-run): clears the incremental flag, dismisses any in-flight
 * task, sets queued, creates an extraction task — same semantics as
 * `queueExtraction`, only scoped to one document. Returns the job id.
 *
 * All one transaction. Doing these steps separately would leave a half
 * state if any one failed: the flag cleared without the epoch bumped,
 * so the old task cannot tell it has been replaced; or queued set
 * without a task actually created, leaving the document stuck forever
 * with no worker to pick it up.
 */
export async function queueExtractionOne(sql: Sql, documentId: Uuid): Promise<number> {
  return sql.begin(async (tx) => {
    await exec(
      tx,
      `UPDATE chunks SET extracted_at = NULL
       WHERE document_id = $1 AND superseded_at IS NULL`,
      [documentId],
    );
    // Any old task that has not started yet is dropped: clicking
    // Extract twice should not end up with two tasks extracting the
    // same document.
    await exec(
      tx,
      `DELETE FROM jobs WHERE kind = 'extract_document' AND status = 'queued'
         AND payload->>'document_id' = $1`,
      [documentId],
    );
    await exec(
      tx,
      `UPDATE documents SET graph_status = 'queued', graph_error = NULL,
              extract_epoch = extract_epoch + 1
       WHERE id = $1`,
      [documentId],
    );
    const job = await qOne<{ id: number }>(
      tx,
      `INSERT INTO jobs (kind, payload)
       VALUES ('extract_document', jsonb_build_object('document_id', $1::text))
       RETURNING id`,
      [documentId],
    );
    return job.id;
  });
}

/** Document viewer: every chunk, in order. */
export async function chunksFull(sql: Sql, documentId: Uuid): Promise<ChunkFull[]> {
  return q<ChunkFull>(
    sql,
    `SELECT id, seq, text FROM chunks
     WHERE document_id = $1 AND superseded_at IS NULL ORDER BY seq`,
    [documentId],
  );
}

export async function chunksForExtraction(
  sql: Sql,
  documentId: Uuid,
): Promise<ChunkForExtract[]> {
  // Only unextracted chunks: an adopted, unchanged paragraph carries
  // extracted_at forward and is skipped (incremental extraction +
  // resumable extraction).
  const rows = await q<{ id: Uuid; seq: number; text: string; embedding: unknown }>(
    sql,
    `SELECT id, seq, text, embedding FROM chunks
     WHERE document_id = $1 AND superseded_at IS NULL AND extracted_at IS NULL
     ORDER BY seq`,
    [documentId],
  );
  return rows.map((r) => ({ id: r.id, seq: r.seq, text: r.text, embedding: parseVector(r.embedding) }));
}

/** Advances the extraction state (clearing the previous failure reason along the way — a rerun turns the page). */
export async function setGraphStatus(sql: Sql, id: Uuid, status: string): Promise<void> {
  await exec(
    sql,
    `UPDATE documents SET graph_status = $2, graph_error = NULL, updated_at = now()
     WHERE id = $1`,
    [id, status],
  );
}

/** This document's not-yet-embedded chunks (id + text). */
export async function chunksPendingEmbedding(
  sql: Sql,
  documentId: Uuid,
): Promise<[Uuid, string][]> {
  const rows = await q<{ id: Uuid; text: string }>(
    sql,
    `SELECT id, text FROM chunks
     WHERE document_id = $1 AND embedding IS NULL AND superseded_at IS NULL ORDER BY seq`,
    [documentId],
  );
  return rows.map((r) => [r.id, r.text]);
}

export async function setEmbeddings(sql: Sql, items: [Uuid, number[]][]): Promise<void> {
  await sql.begin(async (tx) => {
    for (const [id, emb] of items) {
      await exec(tx, `UPDATE chunks SET embedding = $2::vector WHERE id = $1`, [
        id,
        toVectorParam(emb),
      ]);
    }
  });
}

/** Vector nearest-neighbor search (cosine distance, sequential scan; enough for P1 scale). */
export async function vectorSearch(
  sql: Sql,
  kbId: Uuid,
  embedding: number[],
  limit: number,
): Promise<Uuid[]> {
  const rows = await q<{ id: Uuid }>(
    sql,
    `SELECT id FROM chunks
     WHERE kb_id = $1 AND embedding IS NOT NULL AND superseded_at IS NULL
       AND vector_dims(embedding) = vector_dims($2::vector)
     ORDER BY embedding <=> $2::vector
     LIMIT $3`,
    [kbId, toVectorParam(embedding), limit],
  );
  return rows.map((r) => r.id);
}

/** Fetches chunks by id set (with the document name), preserving the input order. */
export async function chunksByIds(sql: Sql, kbId: Uuid, ids: Uuid[]): Promise<ChunkView[]> {
  const rows = await q<ChunkView>(
    sql,
    `SELECT c.id, c.document_id, c.seq, c.text, d.filename
     FROM chunks c JOIN documents d ON d.id = c.document_id
     WHERE c.kb_id = $1 AND c.id = ANY($2)`,
    [kbId, ids],
  );
  // Restore RRF rank order.
  const byId = new Map(rows.map((c) => [c.id, c]));
  const out: ChunkView[] = [];
  for (const id of ids) {
    const c = byId.get(id);
    if (c) out.push(c);
  }
  return out;
}

/**
 * Bulk-queues a full re-extraction: ready documents get their
 * incremental flag cleared, graph_status=queued, an extraction task
 * created; returns the ids queued. `sourceId` limits it to that source
 * when given, otherwise the whole KB.
 *
 * Documents already extracting are re-queued too — bumping the epoch
 * "dismisses" whatever task is in flight (see `extract_epoch`), no need
 * to skip them and no risk of two workers extracting the same document.
 * Any extract task that has not started yet is also dropped (payload is
 * compared as text: historically dirty payloads cannot be cast to
 * uuid).
 *
 * Creating tasks and setting status happen in the same transaction:
 * doing them separately would leave a batch of graph_status=queued
 * documents with no task if it failed partway through — no worker
 * would ever pick them up, and the UI would show "queued" forever.
 */
export async function queueExtraction(
  sql: Sql,
  kbId: Uuid,
  sourceId: Uuid | null,
): Promise<Uuid[]> {
  return sql.begin(async (tx) => {
    const rows = await q<{ id: Uuid }>(
      tx,
      `SELECT id FROM documents
       WHERE kb_id = $1 AND status = 'ready' AND ($2::uuid IS NULL OR source_id = $2)
       ORDER BY created_at`,
      [kbId, sourceId],
    );
    const ids = rows.map((r) => r.id);
    if (ids.length === 0) {
      return ids;
    }

    await exec(
      tx,
      `DELETE FROM jobs WHERE kind = 'extract_document' AND status = 'queued'
         AND payload->>'document_id' = ANY($1)`,
      [ids.map((id) => id.toString())],
    );
    await exec(
      tx,
      `UPDATE chunks SET extracted_at = NULL
       WHERE document_id = ANY($1) AND superseded_at IS NULL`,
      [ids],
    );
    await exec(
      tx,
      `UPDATE documents SET graph_status = 'queued', graph_error = NULL,
              extract_epoch = extract_epoch + 1
       WHERE id = ANY($1)`,
      [ids],
    );
    // The payload shape matches jobs.enqueue(json!({"document_id": id})): the uuid serializes as a string.
    await exec(
      tx,
      `INSERT INTO jobs (kind, payload)
       SELECT 'extract_document', jsonb_build_object('document_id', id::text)
       FROM unnest($1::uuid[]) AS t(id)`,
      [ids],
    );
    return ids;
  });
}

/** Extraction failed: state and reason land together, so the UI has something to show. */
export async function setGraphFailed(sql: Sql, id: Uuid, error: string): Promise<void> {
  await exec(
    sql,
    `UPDATE documents SET graph_status = 'failed', graph_error = $2, updated_at = now()
     WHERE id = $1`,
    [id, error],
  );
}

/**
 * The extraction task's ownership token: bumped every time "a new round
 * of extraction" starts.
 *
 * Claiming by `graph_status` alone is not reliable: when an old task
 * reads back its status, the new task that replaced it may already have
 * written it back to extracting, and the old task would wrongly believe
 * it is still on duty. The epoch increases monotonically, so an old task
 * can tell at a glance that it has been superseded.
 */
export async function extractEpoch(sql: Sql, id: Uuid): Promise<number> {
  const row = await qOne<{ extract_epoch: number }>(
    sql,
    `SELECT extract_epoch FROM documents WHERE id = $1`,
    [id],
  );
  return row.extract_epoch;
}

/**
 * Whether this KB still has extraction queued or running.
 *
 * Cold-start auto-extending the ontology has to wait for a whole batch
 * to finish extracting: looking only at the first document would let
 * whichever one finishes first monopolize the vocabulary. The last task
 * to finish is responsible for triggering it.
 */
export async function extractionIdle(sql: Sql, kbId: Uuid): Promise<boolean> {
  const row = await qOne<{ count: string }>(
    sql,
    `SELECT count(*) FROM documents
     WHERE kb_id = $1 AND graph_status IN ('queued', 'extracting')`,
    [kbId],
  );
  return Number(row.count) === 0;
}

/**
 * Every chunk across the whole deployment, grouped by document, for
 * rebuilding the search index.
 *
 * A single full fetch: this only runs at startup when the index is
 * found empty, and at that point everything really is wanted; it never
 * runs again after that.
 */
export async function allChunksForIndex(sql: Sql): Promise<[Uuid, Uuid, Uuid, string][]> {
  const rows = await q<{ kb_id: Uuid; document_id: Uuid; id: Uuid; text: string }>(
    sql,
    `SELECT kb_id, document_id, id, text FROM chunks
      WHERE superseded_at IS NULL
      ORDER BY document_id, seq`,
  );
  return rows.map((r) => [r.kb_id, r.document_id, r.id, r.text]);
}

/** How many live chunks are in use across the deployment. Used at startup to reconcile against the index. */
export async function liveChunkCount(sql: Sql): Promise<number> {
  const row = await qOne<{ count: string }>(
    sql,
    `SELECT count(*) FROM chunks WHERE superseded_at IS NULL`,
  );
  return Number(row.count);
}

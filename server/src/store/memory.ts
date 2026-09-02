/**
 * Agent/conversation memory: an episodes fast path.
 *
 * Design (zero new machinery): a memory space is the knowledge base
 * itself; each episode is a chunk appended to an implicit "Memory"
 * source's "Memory log" document (with the event timestamp embedded in
 * the text). This reuses the whole pipeline end to end: the chunk enters
 * the full-text/vector index (memory is searchable), `fact_evidence`
 * points at the chunk (a memory fact can be traced back to what was
 * said), `extracted_at` means incremental extraction only touches new
 * episodes, a fact's valid_from takes the event time, and a contradiction
 * with an existing functional fact closes automatically through the
 * temporal engine — "liked A last month, B this month" naturally becomes
 * two intervals. Ledger discipline: episodes are append-only, never
 * rewritten.
 */

import { q, qOpt, exec, type Sql } from "../core/db";
import { newId, type Uuid } from "../core/ids";

export const MEMORY_SOURCE_KIND = "memory";
const MEMORY_DOC_KEY = "memory:log";

/** Each KB's implicit Memory source (undeletable; visible in the Library — memory transparency is a feature). */
export async function getOrCreateMemorySource(sql: Sql, kbId: Uuid): Promise<Uuid> {
  const existing = await qOpt<{ id: Uuid }>(
    sql,
    `SELECT id FROM sources WHERE kb_id = $1 AND kind = $2 LIMIT 1`,
    [kbId, MEMORY_SOURCE_KIND],
  );
  if (existing) return existing.id;
  const id = newId();
  await exec(
    sql,
    `INSERT INTO sources (id, kb_id, kind, name, config) VALUES ($1, $2, $3, 'Memory', '{}')`,
    [id, kbId, MEMORY_SOURCE_KIND],
  );
  return id;
}

/** The memory log document (one per KB). Bypasses `documents.create`'s same-content dedup — it is not a content-addressed file, so sha256 gets a sentinel value. */
export async function getOrCreateMemoryDoc(sql: Sql, kbId: Uuid): Promise<Uuid> {
  const existing = await qOpt<{ id: Uuid }>(
    sql,
    `SELECT id FROM documents WHERE kb_id = $1 AND external_key = $2 LIMIT 1`,
    [kbId, MEMORY_DOC_KEY],
  );
  if (existing) return existing.id;
  const sourceId = await getOrCreateMemorySource(sql, kbId);
  const id = newId();
  await exec(
    sql,
    `INSERT INTO documents
        (id, kb_id, source_id, filename, mime, size_bytes, sha256,
         status, graph_status, external_key, doc_time_source)
     VALUES ($1, $2, $3, 'memory-log.md', 'text/markdown', 0, 'memory:log',
             'ready', 'done', $4, 'none')`,
    [id, kbId, sourceId, MEMORY_DOC_KEY],
  );
  return id;
}

/**
 * Appends one episode: a new chunk (extracted_at empty -> incremental
 * extraction picks it up; embedding empty -> memory_ingest fills it in).
 * The event time is embedded in the first line of the text, and the
 * extraction model derives valid_from from it.
 */
export async function appendEpisode(
  sql: Sql,
  kbId: Uuid,
  text: string,
  occurredAt: Date,
): Promise<[Uuid, Uuid]> {
  const docId = await getOrCreateMemoryDoc(sql, kbId);
  const stamped = `[${formatStamp(occurredAt)}] ${text.trim()}`;
  const chunkId = newId();
  await sql.begin(async (tx) => {
    await exec(
      tx,
      `INSERT INTO chunks (id, kb_id, document_id, seq, text, char_start, char_end, doc_version)
       VALUES ($1, $2, $3,
               (SELECT COALESCE(MAX(seq), -1) + 1 FROM chunks
                WHERE document_id = $3 AND superseded_at IS NULL),
               $4, 0, $5, 1)`,
      [chunkId, kbId, docId, stamped, [...stamped].length],
    );
    await exec(
      tx,
      `UPDATE documents SET chunk_count = chunk_count + 1, size_bytes = size_bytes + $2,
              updated_at = now() WHERE id = $1`,
      [docId, Buffer.byteLength(stamped, "utf8")],
    );
  });
  return [docId, chunkId];
}

function formatStamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Whether this document is the memory log.
 *
 * Extraction uses this to decide whether a fact needs a person's
 * confirmation (0015): a memory is something said in conversation on
 * purpose, one at a time, with the person right there — confirming it
 * costs almost nothing. An ingested document can carry tens of
 * thousands of facts at once, confirming each one individually is not
 * possible, so that path still writes optimistically and reviews after
 * the fact.
 */
export async function isMemoryDocument(sql: Sql, documentId: Uuid): Promise<boolean> {
  const found = await q<{ one: number }>(
    sql,
    `SELECT 1 AS one FROM documents d JOIN sources s ON s.id = d.source_id
      WHERE d.id = $1 AND s.kind = $2`,
    [documentId, MEMORY_SOURCE_KIND],
  );
  return found.length > 0;
}

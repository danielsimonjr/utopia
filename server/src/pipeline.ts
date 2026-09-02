/**
 * Ingest pipeline: parse -> chunk -> full-text index -> embedding
 * (optional) -> ready. Every step is idempotent — rerunning it first
 * clears old chunks and old index entries.
 */

import type { AppState } from "./state";
import * as store from "./store";
import { parse, chunkText } from "./ingest";
import { LlmClient } from "./llm";
import { embedReady, chatReady } from "./core/models";
import { log } from "./core/log";
import type { Uuid } from "./core/ids";

const EMBED_BATCH = 16;

export async function processDocument(state: AppState, documentId: Uuid): Promise<void> {
  try {
    await run(state, documentId);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    try {
      await store.documents.setFailed(state.sql, documentId, message);
    } catch {
      // The document row is what we are trying to update; give up quietly.
    }
    try {
      const doc = await store.documents.get(state.sql, documentId);
      state.emitDocument(doc.kb_id, documentId);
    } catch {
      // Nothing to notify if the document itself cannot be found anymore.
    }
    throw e;
  }
}

async function run(state: AppState, documentId: Uuid): Promise<void> {
  const doc = await store.documents.get(state.sql, documentId);

  // 1. Parse (can be CPU-heavy for large files; Bun runs it on the event
  // loop here — acceptable at this project's scale, unlike a
  // spawn_blocking in the Rust build).
  await store.documents.setStatus(state.sql, documentId, "parsing");
  state.emitDocument(doc.kb_id, documentId);
  const bytes = await state.blob.get(doc.sha256);
  const parsed = await parse(doc.filename, bytes);
  const textLen = [...parsed.text].length;

  // 2. Chunk + store.
  const pieces = chunkText(parsed.text).map((p) => ({
    seq: p.seq,
    text: p.text,
    char_start: p.charStart,
    char_end: p.charEnd,
  }));
  const chunkPairs = await store.documents.replaceChunks(state.sql, doc.kb_id, documentId, pieces);
  const chunkCount = chunkPairs.length;

  // 3. Full-text index.
  await store.documents.setStatus(state.sql, documentId, "indexing");
  state.emitDocument(doc.kb_id, documentId);
  await state.search.reindexDocument(doc.kb_id, documentId, chunkPairs);

  // 4. Embedding (only when the workspace has an embedding model
  // configured; without one the document is still ready, just BM25-only).
  const kbRow = await store.kbs.get(state.sql, doc.kb_id);
  const settings = await store.settings.get(state.sql, kbRow.workspace_id);
  if (settings && embedReady(settings)) {
    await store.documents.setStatus(state.sql, documentId, "embedding");
    state.emitDocument(doc.kb_id, documentId);
    const client = new LlmClient(
      settings.embed_base_url!,
      settings.embed_api_key,
      settings.embed_model!,
    );
    const pending = await store.documents.chunksPendingEmbedding(state.sql, documentId);
    for (let i = 0; i < pending.length; i += EMBED_BATCH) {
      const batch = pending.slice(i, i + EMBED_BATCH);
      const texts = batch.map(([, text]) => text);
      const embeddings = await client.embed(texts);
      if (embeddings.length !== batch.length) {
        throw new Error("Embedding count mismatch");
      }
      const items: [Uuid, number[]][] = batch.map(([id], idx) => [id, embeddings[idx]!]);
      await store.documents.setEmbeddings(state.sql, items);
    }
  }

  await store.documents.setReady(state.sql, documentId, textLen, chunkCount);

  // Two-phase: once the index is ready, queue graph extraction when a
  // chat model is configured (it never blocks search/chat availability).
  if (settings && chatReady(settings)) {
    await store.documents.setGraphStatus(state.sql, documentId, "queued");
    await store.jobs.enqueue(state.sql, "extract_document", { document_id: documentId });
  }
  state.emitDocument(doc.kb_id, documentId);

  log.info("document processed", { document_id: documentId, chunks: chunkCount });
}

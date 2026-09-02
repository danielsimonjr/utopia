/**
 * Hybrid retrieval: BM25 (MiniSearch) + vector (pgvector) -> RRF fusion.
 *
 * Falls back to BM25 alone, silently, when embedding is not configured or
 * the call fails.
 */

import type { AppState } from "./state";
import * as store from "./store";
import { LlmClient } from "./llm";
import { rrfFuse } from "./search";
import { embedReady } from "./core/models";
import { log } from "./core/log";
import type { ChunkView } from "./core/models";
import type { Uuid } from "./core/ids";

const RECALL_PER_CHANNEL = 24;

export async function hybrid(
  state: AppState,
  kbId: Uuid,
  workspaceId: Uuid,
  query: string,
  topK: number,
): Promise<ChunkView[]> {
  const lists: string[][] = [];

  const bm25 = state.search.search(kbId, query, RECALL_PER_CHANNEL);
  lists.push(bm25.map((h) => h.chunkId));

  const settings = await store.settings.get(state.sql, workspaceId);
  if (settings && embedReady(settings)) {
    const client = new LlmClient(
      settings.embed_base_url!,
      settings.embed_api_key,
      settings.embed_model!,
    );
    try {
      const embeddings = await client.embed([query]);
      if (embeddings.length > 0) {
        const ids = await store.documents.vectorSearch(
          state.sql,
          kbId,
          embeddings[0]!,
          RECALL_PER_CHANNEL,
        );
        lists.push(ids.map((id) => id.toString()));
      }
    } catch (e) {
      log.warn("query embedding failed, falling back to BM25 only", { error: String(e) });
    }
  }

  const fused = rrfFuse(lists, topK);
  return store.documents.chunksByIds(state.sql, kbId, fused);
}

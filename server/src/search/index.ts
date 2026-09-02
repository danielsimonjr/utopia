/**
 * utopia-search: a full-text index (MiniSearch, CJK-aware tokenizer) with
 * RRF fusion.
 *
 * One index holds every knowledge base; `kb_id` is a filter field. Chunk
 * text lives in Postgres — the index only stores the id mapping.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import MiniSearch, { type AsPlainObject } from "minisearch";
import { tokenizeCjkAware } from "./tokenize";

export { DocsIndex, type DocsSection } from "./docs";

export type Hit = { chunkId: string; score: number };

type IndexedDoc = {
  id: string;
  chunkId: string;
  kbId: string;
  documentId: string;
  text: string;
};

function minisearchOptions() {
  return {
    idField: "id",
    fields: ["text"],
    storeFields: ["chunkId", "kbId", "documentId"],
    tokenize: tokenizeCjkAware,
    searchOptions: { combineWith: "OR" as const },
  };
}

export class SearchIndex {
  private mini: MiniSearch<IndexedDoc>;
  private readonly docs: Map<string, IndexedDoc>;
  private readonly filePath: string;

  private constructor(mini: MiniSearch<IndexedDoc>, docs: Map<string, IndexedDoc>, filePath: string) {
    this.mini = mini;
    this.docs = docs;
    this.filePath = filePath;
  }

  static async open(dir: string): Promise<SearchIndex> {
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, "index.json");
    const file = Bun.file(filePath);
    if (await file.exists()) {
      const parsed = JSON.parse(await file.text()) as { mini: AsPlainObject; docs: IndexedDoc[] };
      const mini = MiniSearch.loadJS<IndexedDoc>(parsed.mini, minisearchOptions());
      const docs = new Map(parsed.docs.map((d) => [d.chunkId, d]));
      return new SearchIndex(mini, docs, filePath);
    }
    return new SearchIndex(new MiniSearch<IndexedDoc>(minisearchOptions()), new Map(), filePath);
  }

  /** Writes the current index to disk. All mutating calls do this — write-then-read-back, no async reload window. */
  private async commit(): Promise<void> {
    const snapshot = { mini: this.mini.toJSON(), docs: [...this.docs.values()] };
    await Bun.write(this.filePath, JSON.stringify(snapshot));
  }

  /** Rebuilds one document's index entries (delete then add — idempotent), then commits. */
  async reindexDocument(kbId: string, documentId: string, chunks: [chunkId: string, text: string][]): Promise<void> {
    this.removeDocumentEntries(documentId);
    for (const [chunkId, text] of chunks) {
      const doc: IndexedDoc = { id: chunkId, chunkId, kbId, documentId, text };
      this.mini.add(doc);
      this.docs.set(chunkId, doc);
    }
    await this.commit();
  }

  async deleteDocument(documentId: string): Promise<void> {
    this.removeDocumentEntries(documentId);
    await this.commit();
  }

  private removeDocumentEntries(documentId: string): void {
    for (const doc of [...this.docs.values()]) {
      if (doc.documentId !== documentId) continue;
      this.mini.remove(doc);
      this.docs.delete(doc.chunkId);
    }
  }

  /**
   * How many chunks are in the index. Check this against the database
   * count at startup — the index directory is a file store independent of
   * the database (a machine change, an unmounted volume, or corruption can
   * all make it come up empty), and search then silently returns nothing
   * with no visible sign in the UI.
   */
  len(): number {
    return this.mini.documentCount;
  }

  isEmpty(): boolean {
    return this.len() === 0;
  }

  /**
   * A ranked search, limited to one knowledge base.
   *
   * The query is tokenized with the same CJK-aware tokenizer used at index
   * time, and terms are OR-combined — a plain word-boundary tokenizer
   * would treat a whole CJK sentence as one phrase query (requiring the
   * words to appear consecutively), and recall would drop to zero.
   */
  search(kbId: string, query: string, limit: number): Hit[] {
    const results = this.mini.search(query, {
      filter: (r) => r.kbId === kbId,
    });
    return results.slice(0, limit).map((r) => ({ chunkId: r.chunkId as string, score: r.score }));
  }
}

/** Reciprocal Rank Fusion: merges the rankings of several result lists (k=60 is an empirical constant). */
export function rrfFuse(lists: string[][], limit: number): string[] {
  const K = 60;
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (K + rank + 1));
    });
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id);
}

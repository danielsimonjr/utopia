/**
 * An in-memory index of the built-in docs (the Charter). It is built once
 * at startup from the bundled markdown and stays read-only for the life
 * of the process. It is protocol-neutral: both the chat `search_docs`
 * tool arm and any future MCP tool surface share this one entry point.
 */

import MiniSearch from "minisearch";
import { tokenizeCjkAware } from "./tokenize";

/** One section of a doc (split on h2; the anchor uses the same rule as the frontend Docs page heading anchors). */
export type DocsSection = {
  slug: string;
  title: string;
  heading: string;
  anchor: string;
  body: string;
};

type IndexedSection = DocsSection & { id: number; text: string };

export class DocsIndex {
  private readonly mini: MiniSearch<IndexedSection>;

  private constructor(mini: MiniSearch<IndexedSection>) {
    this.mini = mini;
  }

  static build(sections: DocsSection[]): DocsIndex {
    const mini = new MiniSearch<IndexedSection>({
      idField: "id",
      // The search field is heading + body; heading terms naturally get
      // extra weight from appearing twice (once on their own, once inside
      // the concatenated text).
      fields: ["text"],
      storeFields: ["slug", "title", "heading", "anchor", "body"],
      tokenize: tokenizeCjkAware,
      searchOptions: { combineWith: "OR" },
    });
    sections.forEach((s, id) => {
      mini.add({ ...s, id, text: `${s.heading}\n${s.body}` });
    });
    return new DocsIndex(mini);
  }

  /** A ranked search. Tokenized the same way as {@link SearchIndex} (manual OR, to dodge the CJK phrase-query trap). */
  search(query: string, limit: number): DocsSection[] {
    const results = this.mini.search(query);
    return results.slice(0, limit).map((r) => ({
      slug: r.slug as string,
      title: r.title as string,
      heading: r.heading as string,
      anchor: r.anchor as string,
      body: r.body as string,
    }));
  }
}

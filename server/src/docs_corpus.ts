/**
 * The Charter corpus: the same markdown as the frontend Docs page (a
 * single source of truth, upgraded with the binary). Adding an article
 * means adding one line to the frontend `Docs.tsx` list and one line to
 * `ARTICLES` here.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DocsIndex, type DocsSection } from "./search";

/** (slug, title, body). The slug must match the frontend's DOCS list — a `/docs/{slug}` reference link depends on it. */
const ARTICLES: readonly [string, string, string][] = [
  ["ingest", "Ingest interfaces", readWebDoc("ingest.md")],
];

function readWebDoc(filename: string): string {
  // Mirrors the Rust build's `include_str!("../../../web/src/docs/...")`:
  // both servers read the frontend's own markdown as their single source
  // of truth, rather than keeping a second copy in sync by hand.
  const path = join(import.meta.dir, "..", "..", "web", "src", "docs", filename);
  return readFileSync(path, "utf-8");
}

/** Builds the index at startup; the corpus is a build-time constant, so a failure here is a programming error and should fail loudly. */
export function buildIndex(): DocsIndex {
  return DocsIndex.build(sections());
}

/** Splits on h2: one index record per section, so a hit returns the specific section, not the whole article. The preamble before the first h2 becomes the "title section" (empty anchor, links to the top of the article). */
function sections(): DocsSection[] {
  const out: DocsSection[] = [];
  for (const [slug, title, body] of ARTICLES) {
    let heading = title;
    let anchor = "";
    let buf: string[] = [];
    const flush = (h: string, a: string) => {
      const text = buf.join("\n").trim();
      if (text !== "") {
        out.push({ slug, title, heading: h, anchor: a, body: text });
      }
      buf = [];
    };
    for (const line of body.split("\n")) {
      if (line.startsWith("## ")) {
        flush(heading, anchor);
        // Cleaned the same way as the frontend's `tocOf`: strip inline code/emphasis marks.
        heading = line.slice(3).replace(/[`*]/g, "").trim();
        anchor = slugify(heading);
      } else if (!line.startsWith("# ")) {
        buf.push(line);
      }
    }
    flush(heading, anchor);
  }
  return out;
}

/** Character-for-character aligned with the frontend's `Docs.tsx` slugify (anchor jumps depend on both sides matching): lowercase, then any run outside [a-z0-9\u4e00-\u9fa5] folds to a single '-', then leading/trailing '-' are trimmed. */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/(^-+|-+$)/g, "");
}

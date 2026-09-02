#!/usr/bin/env node
// This picks a few entries out of a corpus and writes them to a new corpus.
//
// This script exists because `wiki-history` takes too long to run in full: 219
// snapshots, about 7,000 chunks, six to seven hours at the measured rate, and it hits
// the endpoint's per-minute token quota. **The two questions this corpus answers have
// different requirements:**
//
// - "Does a zero violation rate hold up?" is a statistics question. 60 chunks produce
//   149 checkable facts. Using the rule of three, the confidence upper bound for zero
//   violations is `3/n`. A few hundred chunks already give a conclusive answer, and
//   running more chunks adds no information.
// - "Does the graph actually change its mind?" is a structural question, and
//   statistics cannot answer it. It requires **the whole chain of snapshots for one
//   entry, in `doc_time` order,** because `supersedes` only happens between adjacent
//   snapshots of the same entry.
//
// So this script **takes whole entries, not individual chunks.** Sampling chunks at
// random would satisfy the first question but would ruin the second one entirely.
// Picking a few entries that reference each other is more useful than running a few
// thousand more chunks.
//
// The output sorts in ascending `doc_time` order. The order facts load in is the order
// understanding grows in, and a graph loaded out of order carries no meaning on the
// provenance-and-time axis.
//
// Usage: node scripts/bench/subset-corpus.mjs <corpus.json> <entry,entry,...> > new-corpus.json
//
// Example (the November 2023 OpenAI events, seven entries sharing entities):
//   node scripts/bench/subset-corpus.mjs scripts/bench/corpora/wiki-history.json \
//     openai,removal-of-sam-altman-from-openai,sam-altman,ilya-sutskever,\
//     mira-murati,greg-brockman,emmett-shear \
//     > scripts/bench/corpora/wiki-nov2023.json
//
// With no entry argument, this only lists the source corpus's entries and how many
// snapshots each one has, and writes no corpus.

import fs from "node:fs";

const [, , src, titlesRaw] = process.argv;
if (!src) {
  console.error("Usage: subset-corpus.mjs <corpus.json> [entry,entry,...]");
  console.error("      With no entry argument, this only lists the source corpus's entries.");
  process.exit(2);
}

const corpus = JSON.parse(fs.readFileSync(src, "utf8"));
if (!Array.isArray(corpus.docs)) {
  console.error(`${src} has no docs array; this does not look like a corpus file`);
  process.exit(2);
}

/// A filename looks like `openai@2023-11-19.txt`. The part before `@` is the entry name.
/// The current corpus format (fetch-ai-timeline) has no `@`, so the whole filename is
/// the entry name.
const titleOf = (filename) => filename.replace(/@.*$/, "").replace(/\.txt$/, "");

// The entry list, with a snapshot count and size for each. This is for the user to
// review before choosing entries.
const groups = new Map();
for (const [filename, text] of corpus.docs) {
  const t = titleOf(filename);
  const g = groups.get(t) || { n: 0, chars: 0 };
  g.n += 1;
  g.chars += text.length;
  groups.set(t, g);
}

if (!titlesRaw) {
  const rows = [...groups].sort((a, b) => b[1].chars - a[1].chars);
  const total = rows.reduce((s, [, g]) => s + g.chars, 0);
  for (const [t, g] of rows) {
    const pct = ((100 * g.chars) / total).toFixed(1).padStart(5);
    console.error(
      `${String(g.n).padStart(4)} snapshots  ${String(Math.round(g.chars / 1000)).padStart(6)}k  ${pct}%  ${t}`,
    );
  }
  console.error(`\n${rows.length} entries, ${corpus.docs.length} snapshots, ${(total / 1e6).toFixed(2)}M characters total`);
  process.exit(0);
}

const wanted = new Set(titlesRaw.split(",").map((t) => t.trim()).filter(Boolean));

// **An unrecognized entry name must raise an error, not silently produce a smaller
// corpus.** A single typo would drop an entry, and the missing entry could be the one
// that shares entities with the others, so the graph would fall apart into
// disconnected clusters. In the result, that failure would look only like "the result
// is not as good", with no way to trace it back to the cause.
const unknown = [...wanted].filter((t) => !groups.has(t));
if (unknown.length) {
  console.error(`These entries are not in the source corpus: ${unknown.join(", ")}`);
  console.error(`Run this script again with no entry argument to see the full list.`);
  process.exit(2);
}

const docs = corpus.docs
  .filter(([filename]) => wanted.has(titleOf(filename)))
  // Sorts in ascending doc_time order. When the third element is missing (the current
  // corpus format), this falls back to sorting by filename, which is at least
  // deterministic.
  .sort((a, b) => String(a[2] ?? a[0]).localeCompare(String(b[2] ?? b[0])));

const chars = docs.reduce((s, d) => s + d[1].length, 0);

process.stdout.write(
  JSON.stringify({
    name: `${corpus.name}-subset`,
    note:
      `A subset of ${corpus.name}, entries: ${[...wanted].join(", ")}. ` +
      `This keeps each whole entry, sorted in ascending doc_time order, because ` +
      `supersedes only happens between adjacent snapshots of the same entry.` +
      (corpus.note ? ` Source corpus note: ${corpus.note}` : ""),
    source: corpus.source,
    license: corpus.license,
    sampling: corpus.sampling,
    subset_of: corpus.name,
    docs,
  }),
);

// This writes stats to stderr, so stdout can redirect directly to a corpus file.
console.error(
  `${docs.length} snapshots, ${Math.round(chars / 1000)}k characters, ` +
    // A 1,200-character budget with 150-character overlap; see chunk_text in utopia-ingest.
    `about ${Math.round(chars / 1050)} chunks`,
);

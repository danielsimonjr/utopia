#!/usr/bin/env node
// This cuts the schema.org TTL file down to a subset of the first N classes, for the
// degradation curve.
//
// The curve answers one question: **how much vocabulary can extraction inline before
// it starts dropping facts?** That curve sets `ONTOLOGY_PROMPT_BUDGET` and the number
// of candidates retrieved per chunk. Without this measurement, those values are a guess.
//
// This does not import the full vocabulary and then limit the inline count, because
// that approach would measure how well retrieval selects candidates, mixing in
// retrieval quality. Cutting a subset and inlining all of it measures pure scale
// effects instead.
//
// Usage: node scripts/bench/subset.mjs /tmp/schemaorg.ttl 100 > /tmp/schemaorg-100.ttl

import fs from "node:fs";

const [, , src, nRaw] = process.argv;
const N = Number(nRaw);
if (!src || !Number.isFinite(N)) {
  console.error("Usage: subset.mjs <schemaorg.ttl> <class count>");
  process.exit(2);
}

const text = fs.readFileSync(src, "utf8");
const lines = text.split("\n");

// This keeps the prefix block unchanged. Cutting it would break parsing of the file.
const prefixEnd = lines.findIndex((l) => l.startsWith("@prefix") === false && l.trim() && !l.startsWith("#"));
const prefixes = lines.slice(0, prefixEnd).join("\n");

// This splits the file into blocks at blank lines, but **it must track whether it is
// inside a triple-quoted string.**
//
// Two earlier versions of this script failed here. Splitting on a line ending in
// `/\.\s*$/` did not work: some schema.org rdfs:comment values end in a line that ends
// with a period, so a block split apart in the middle of a description, and import
// reported `Accountancy is not a valid subject`. Splitting on blank lines alone also
// did not work: a `"""…"""` string can contain a real blank line, which split a block
// apart the same way, and import reported `A is not a valid subject`, where "A" was
// the first word of the BreadcrumbList description.
//
// Splitting this file correctly requires tracking this lexical context: this counts
// how many `"""` markers have appeared, and treats the position as outside a string
// only when that count is even.
const blocks = [];
{
  let cur = [];
  let inLiteral = false;
  for (const line of lines.slice(prefixEnd)) {
    const quotes = (line.match(/"""/g) || []).length;
    if (!inLiteral && quotes % 2 === 0 && !line.trim() && cur.length) {
      blocks.push(cur.join("\n").trim());
      cur = [];
      continue;
    }
    cur.push(line);
    if (quotes % 2 === 1) inLiteral = !inLiteral;
  }
  if (cur.length) blocks.push(cur.join("\n").trim());
}

const subjectOf = (b) => (b.match(/^\s*(\S+)\s+a\s/m) || [])[1] || "";
const isClass = (b) => /\ba\s+rdfs:Class\b/.test(b);
const isProp = (b) => /\ba\s+rdf:Property\b/.test(b);

// This takes the first N classes. **It keeps the original order instead of choosing
// randomly,** so the same N always produces the same subset, and a difference between
// two runs can be attributed to something other than the subset.
const classes = blocks.filter(isClass);
const keep = new Set(classes.slice(0, N).map(subjectOf).filter(Boolean));

// Keeps a property when its domainIncludes value falls inside a kept class. Keeping a
// property that points to a cut class serves no purpose, because that domain would
// not resolve, and import would skip it anyway.
const props = blocks.filter(isProp).filter((b) => {
  const m = b.match(/schema:domainIncludes([^;.]*)/);
  if (!m) return false;
  return m[1]
    .split(",")
    .map((x) => x.trim().replace(/[.;]$/, ""))
    .some((x) => keep.has(x));
});

const kept = blocks.filter((b) => isClass(b) && keep.has(subjectOf(b)));
process.stdout.write(prefixes + "\n\n" + kept.concat(props).join("\n\n") + "\n");
process.stderr.write(`Kept ${kept.length} classes and ${props.length} properties\n`);

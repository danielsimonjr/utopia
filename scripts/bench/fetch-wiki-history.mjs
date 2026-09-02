#!/usr/bin/env node
// This fetches the "Wikipedia article history" corpus: versions of the same article at
// different points in time, converted to the bench corpus format.
//
// **The difference from fetch-ai-timeline.mjs is the whole reason this corpus exists.**
// That script fetches each article's **current** version: 15 articles, each a
// retrospective summary. Loading one file such as openai.txt reveals its whole
// 2015-to-today timeline at once. That corpus shows world time (a sentence carries a
// date), but it cannot show **cognitive time**: every document loads at the same
// moment, so `recorded_at` values all bunch together, and `supersedes` can only happen
// within one article, never between articles.
//
// Bitemporal modeling has two axes, and that earlier corpus demonstrates only one.
//
// This script fetches **historical versions** instead. Each snapshot captures "what
// people knew at that moment". Loaded in `doc_time` order, the graph actually grows
// over time and actually changes its mind:
//
//   The OpenAI article was 1,317 bytes (a stub) when created on 2015-12-12, and grew
//   past 60KB by 2026.
//   In the Removal of Sam Altman article's version from November 19, Murati is interim
//   CEO. In the version from November 22, Altman is back.
//
// **Sampling follows how much the article changed, not the calendar.** Early on, the
// article changed about once a month; later, it went half a year without a change.
// Sampling by fixed calendar intervals would fetch many nearly identical snapshots
// during the quiet period, wasting extraction, while missing the most active period
// entirely. This script uses growth in size as the signal instead: it takes a
// snapshot only when the size changed by at least GROWTH_PCT and at least GROWTH_ABS,
// with at least MIN_GAP_DAYS between any two snapshots.
//
// License: Wikipedia article text is CC BY-SA 4.0. It can be redistributed, but
// **redistribution requires attribution and share-alike terms.** This differs from the
// public-domain State of the Union corpus. The corpus file records its license
// separately; do not treat it as the repository's main license.
//
// **Neither the article text nor the manifest is committed to the repository** (see
// .gitignore). The text is roughly 7MB of CC BY-SA content, and the manifest is the
// output of one sampling run. Only this script is committed.
//
// But **a single benchmark run must pin its revision ids.** Sampling depends on the
// article's revision history as it stands right now, and articles keep getting
// edited, so running --dry again later can select a different set of snapshots.
// The fix: run --manifest once to write a manifest file, then always rebuild with
// --from-manifest afterward. `action=parse&oldid` is immutable, so refetching from the
// same manifest at any later time produces byte-identical text. A controlled
// comparison between benchmark runs depends on this.
//
// Usage: node scripts/bench/fetch-wiki-history.mjs --dry       # report sampling results and size only
//        node scripts/bench/fetch-wiki-history.mjs --manifest  # write the manifest, fetch no text
//        node scripts/bench/fetch-wiki-history.mjs --from-manifest > scripts/bench/corpora/wiki-history.json

import { execFileSync } from "node:child_process";
import fs from "node:fs";

const UA = "Utopia-bench/0.1 (+https://utopia.bi; corpus builder)";
const DRY = process.argv.includes("--dry");
const WRITE_MANIFEST = process.argv.includes("--manifest");
const FROM_MANIFEST = process.argv.includes("--from-manifest");
const MANIFEST_PATH = "scripts/bench/corpora/wiki-history.manifest.json";

// **This uses curl, not fetch,** for the same reason as fetch-ai-timeline.mjs: on this
// machine, HTTP_PROXY and HTTPS_PROXY point to a local proxy, and Node 20's undici
// does not read those two environment variables, so every fetch call failed with
// UND_ERR_CONNECT_TIMEOUT, while curl returned 200 for the same address.
const curl = (url) =>
  execFileSync(
    "curl",
    ["-sSL", "--compressed", "--max-time", "90", "-A", UA, url],
    {
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
    },
  );

const api = (params) => {
  const u = new URL("https://en.wikipedia.org/w/api.php");
  u.searchParams.set("format", "json");
  u.searchParams.set("formatversion", "2");
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return JSON.parse(curl(u.toString()));
};

// The threshold for taking a snapshot. **Both conditions must hold** for a snapshot to
// be taken.
//
// An earlier version used "or" between the two conditions. That version took a
// snapshot of the Elon Musk article (which grew to 340KB) roughly every 6KB, producing
// 89 snapshots, 60% of the whole corpus, mostly covering Tesla, SpaceX, and politics,
// which diluted the graph. Changing "or" to "and" made a large article's sampling grow
// logarithmically with its size, while a small article still has an absolute lower
// bound that filters out noise.
const GROWTH_PCT = 0.18; // The size must grow or shrink by at least 18% from the last snapshot.
const GROWTH_ABS = 6000; // and by at least 6KB in absolute terms.
const MIN_GAP_DAYS = 45; // Two snapshots must be at least this many days apart, except inside a high-density window.

// **The articles are chosen to reference each other:** organizations, people, and
// products. The people form the source of cross-links. Altman appears in the OpenAI,
// Y Combinator, and Worldcoin articles. Musk appears in the OpenAI, Tesla, and xAI
// articles. Sutskever appears in the OpenAI, SSI, and Google Brain articles. Fetching
// only organizations would produce a graph of disconnected clusters.
const TITLES = [
  // Group 1: the centerpiece of changing understanding, four values in six days. This
  // article samples by day, not by growth.
  {
    title: "Removal of Sam Altman from OpenAI",
    daily: ["2023-11-19", "2023-11-29"],
  },

  // Group 2: organizations
  { title: "OpenAI" },
  { title: "Anthropic" },
  { title: "DeepMind" },
  { title: "XAI (company)" },
  { title: "Mistral AI" },
  { title: "Hugging Face" },
  { title: "Stability AI" },
  { title: "Inflection AI" },
  { title: "Safe Superintelligence" },
  { title: "Scale AI" },
  { title: "Cohere" },

  // Group 3: people. **This group is the source of cross-references.** The same
  //    person appears across multiple organizations, and their affiliation changes
  //    over time, which is exactly what bitemporal modeling needs to show.
  { title: "Sam Altman" },
  { title: "Elon Musk" },
  { title: "Ilya Sutskever" },
  { title: "Greg Brockman" },
  { title: "Mira Murati" },
  { title: "Dario Amodei" },
  { title: "Demis Hassabis" },
  { title: "Emmett Shear" },
  { title: "Satya Nadella" },

  // Group 4: products. Each version supersedes the last, forming a natural
  // valid_from/valid_to chain.
  { title: "GPT-4" },
  { title: "ChatGPT" },
  { title: "Claude (language model)" },
  { title: "Gemini (language model)" },
  { title: "Llama (language model)" },
];

/// Lists every revision of an article, with timestamp and size, following all pages.
function revisions(title) {
  const out = [];
  let cont = null;
  for (let page = 0; page < 40; page++) {
    const p = {
      action: "query",
      prop: "revisions",
      titles: title,
      redirects: "1",
      rvlimit: "500",
      rvprop: "ids|timestamp|size",
      rvdir: "newer",
    };
    if (cont) p.rvcontinue = cont;
    const j = api(p);
    const pg = j.query.pages[0];
    if (pg.missing) throw new Error(`${title}: article does not exist`);
    out.push(...(pg.revisions || []));
    cont = j.continue?.rvcontinue;
    if (!cont) return { real: pg.title, revs: out };
  }
  return { real: title, revs: out };
}

const day = (ts) => ts.slice(0, 10);
const days = (a, b) => (new Date(b) - new Date(a)) / 86400000;

/// Whether this size persisted, instead of being reverted right away.
///
/// **"Changed a lot" includes "someone blanked the page."** This case was found in
/// testing: a 2018-05-24T09:35:49 revision of the Elon Musk article was only 33 bytes
/// (its edit summary read "Replaced content with..."). The drop from 141,637 to 33
/// bytes met both growth thresholds, so this revision was selected. It was reverted 30
/// seconds later, but by then the baseline had already shifted to 33 bytes, so the
/// revert itself also looked like a huge change and got selected too. **One act of
/// vandalism produced two useless snapshots, and it also threw off the baseline for
/// every sample after it.**
///
/// A minimum size threshold does not fix this: a legitimate content split, where
/// content moves to a subarticle, is also a large, legitimate drop in size, and it
/// looks identical to vandalism by size alone. What tells them apart is **how long the
/// change lasts.** Vandalism gets reverted within minutes; a split stays. So this
/// checks whether the size PERSIST_DAYS days after this revision is still in the same
/// range.
const PERSIST_DAYS = 1;
function persists(revs, i) {
  const r = revs[i];
  for (let j = i + 1; j < revs.length; j++) {
    if (days(r.timestamp, revs[j].timestamp) < PERSIST_DAYS) continue;
    const hi = Math.max(revs[j].size, r.size);
    return hi === 0 || Math.abs(revs[j].size - r.size) / hi < 0.5;
  }
  return true; // No later revision exists, so this revision is the current state.
}

/// Selects snapshots by how much the article changed. The first and last revisions
/// always get included.
function sampleByGrowth(revs) {
  const picked = [revs[0]];
  for (let i = 1; i < revs.length; i++) {
    const r = revs[i];
    const last = picked[picked.length - 1];
    const d = Math.abs(r.size - last.size);
    const grew = d >= GROWTH_ABS && d >= last.size * GROWTH_PCT;
    if (
      grew &&
      days(last.timestamp, r.timestamp) >= MIN_GAP_DAYS &&
      persists(revs, i)
    )
      picked.push(r);
  }
  const last = revs[revs.length - 1];
  if (picked[picked.length - 1].revid !== last.revid) picked.push(last);
  return picked;
}

/// The high-density window: within the window, this takes the last revision of each
/// day. This shows "how many times did understanding change within one day."
function sampleDaily(revs, [from, to]) {
  const byDay = new Map();
  for (let i = 0; i < revs.length; i++) {
    const d = day(revs[i].timestamp);
    // The last revision of the day can also be vandalism (the day's final edit could
    // happen to be a blanking), so this runs the same persistence check.
    if (d >= from && d < to && persists(revs, i)) byDay.set(d, revs[i]);
  }
  return [...byDay.values()];
}

// The References and External links sections at the end are link and template
// leftovers, and the extractor would treat them as body text. This cuts them out.
//
// **The closing side of this pattern uses `=+`, not `==+`, and that extra flexibility
// is intentional.** An earlier version of this pattern used `==+` on both sides. The
// HTML-to-text conversion below writes the opening tag with `=` repeated to match the
// heading level, but it wrote the closing tag with a single hardcoded `=`, so a
// level-2 heading came out as `== References =`. That pattern with `==+` on both sides
// never matched, so **the entire references section of every snapshot went into
// extraction.** Testing found that 223 of 414 chunks (54%) were citation leftovers,
// producing facts such as `Wired --employee--> Steven Levy`, which mistakes a
// journalist's byline for an employment relation, and which also occupied slots in
// the supersedes mechanism.
//
// The closing-tag bug below is now fixed, but this pattern still stays loose on
// purpose. Whether the two sides of a heading match is a rendering detail, and the
// real question here is only "where does the unwanted section start." Staying loose
// means the same kind of mismatch can never break this pattern again, at the cost of
// possibly cutting an extra level-1 heading shaped like `= Foo =`, a heading shape
// that does not appear in an article's body.
const CUT =
  /\n==+ ?(References|External links|See also|Further reading|Notes|Bibliography|Sources|Citations) ?=+/i;

/// Fetches the plain text of one revision. `prop=extracts` only reads the current
/// version, so this uses `action=parse&oldid=` to get rendered HTML, then strips it
/// down to plain text.
function plaintext(revid) {
  const j = api({
    action: "parse",
    oldid: String(revid),
    prop: "text",
    disablelimitreport: "1",
  });
  let h = j.parse.text;
  return h
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<table[\s\S]*?<\/table>/gi, "") // Infoboxes and navboxes are template leftovers.
    .replace(/<sup class="reference"[\s\S]*?<\/sup>/gi, "") // Footnote markers
    .replace(/<span class="mw-editsection"[\s\S]*?<\/span>/gi, "")
    .replace(/<h([1-6])[^>]*>/gi, (_, n) => "\n\n" + "=".repeat(+n) + " ")
    // This also repeats the closing tag by heading level, matching the line above.
    // A hardcoded single `=` here would turn a level-2 heading into `== References =`,
    // while CUT above expects `==`, so the trailing section would never get cut.
    .replace(/<\/h([1-6])>/gi, (_, n) => " " + "=".repeat(+n) + "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|li|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/\[edit\]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const docs = [];
let plan = [];

if (FROM_MANIFEST) {
  // Rebuilds exactly from the pinned revision ids. This does not run the sampling
  // logic, and it does not look at the article's current history.
  const m = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  plan = m.titles.map((t) => ({
    real: t.real,
    total: t.total,
    picked: t.picked,
  }));
  process.stderr.write(
    `Rebuilding from manifest: ${m.titles.length} articles, ${plan.reduce((n, q) => n + q.picked.length, 0)} snapshots\n`,
  );
} else
  for (const spec of TITLES) {
    try {
      const { real, revs } = revisions(spec.title);
      if (!revs.length) throw new Error("no revisions");
      const picked = spec.daily
        ? sampleDaily(revs, spec.daily)
        : sampleByGrowth(revs);
      plan.push({ real, total: revs.length, picked, slugBase: real });
      process.stderr.write(
        `${real.padEnd(36)} ${String(revs.length).padStart(5)} revisions -> took ${String(picked.length).padStart(3)} snapshots` +
          `  ${day(picked[0].timestamp)} → ${day(picked[picked.length - 1].timestamp)}` +
          `  ${Math.round(picked[0].size / 1024)}KB → ${Math.round(picked[picked.length - 1].size / 1024)}KB\n`,
      );
    } catch (e) {
      process.stderr.write(`ERR ${spec.title}: ${e.message}\n`);
    }
  }

const snapshots = plan.reduce((n, p) => n + p.picked.length, 0);
const rawBytes = plan.reduce(
  (n, p) => n + p.picked.reduce((m, r) => m + r.size, 0),
  0,
);
process.stderr.write(
  `\nTotal: ${snapshots} snapshots, ${(rawBytes / 1048576).toFixed(1)} MB raw (includes templates; roughly half that after stripping)\n`,
);

if (WRITE_MANIFEST) {
  fs.writeFileSync(
    MANIFEST_PATH,
    JSON.stringify(
      {
        note:
          "The revision-id manifest for the wiki-history corpus. The article text is not " +
          "committed to the repository (roughly 6MB of CC BY-SA text). Running " +
          "--from-manifest against this file rebuilds it byte-for-byte, because " +
          "action=parse&oldid is immutable.",
        sampling: { GROWTH_PCT, GROWTH_ABS, MIN_GAP_DAYS },
        titles: plan.map((q) => ({
          real: q.real,
          total: q.total,
          picked: q.picked.map((r) => ({
            revid: r.revid,
            timestamp: r.timestamp,
            size: r.size,
          })),
        })),
      },
      null,
      1,
    ),
  );
  process.stderr.write(`--manifest: wrote the manifest to ${MANIFEST_PATH}\n`);
  process.exit(0);
}

if (DRY) {
  process.stderr.write("--dry: reporting the sampling result only; no text fetched\n");
  process.exit(0);
}

process.stderr.write("\nFetching article text...\n");
for (const p of plan) {
  const slug = p.real
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  for (const r of p.picked) {
    try {
      const body = plaintext(r.revid).split(CUT)[0].trim();
      if (body.length < 400) {
        process.stderr.write(
          `  skip ${slug}@${day(r.timestamp)}: only ${body.length} characters of text\n`,
        );
        continue;
      }
      // The third element is doc_time, the snapshot's **actual revision time**. The
      // extraction prompt receives it (extraction.rs inserts doc_time formatted as
      // %Y-%m-%d), which lets a relative date in the text resolve correctly. Loading
      // documents sorted by this value is also what spreads `recorded_at` into a line
      // instead of bunching it at one point.
      docs.push([
        `${slug}@${day(r.timestamp)}.txt`,
        `${p.real}\n\n${body}\n`,
        r.timestamp,
      ]);
    } catch (e) {
      process.stderr.write(`  ERR ${slug}@${day(r.timestamp)}: ${e.message}\n`);
    }
  }
  process.stderr.write(`OK  ${p.real}\n`);
}

// **This sorts by time,** because the corpus's meaning depends on the order.
// Loading it out of order would recreate "every document loads at the same moment."
docs.sort((a, b) => (a[2] < b[2] ? -1 : 1));

const total = docs.reduce((n, [, t]) => n + t.length, 0);
process.stderr.write(
  `\n${docs.length} snapshots, ${total.toLocaleString()} characters total, about ${Math.round(total / 950)} chunks\n`,
);

process.stdout.write(
  JSON.stringify(
    {
      name: "wiki-history",
      note:
        "Historical snapshots of Wikipedia articles, sampled by growth in size (sampled " +
        "daily inside high-density windows). This fetches the same topics as ai-timeline, " +
        "but fetches **historical versions instead of current versions.** That corpus's 15 " +
        "articles are each a retrospective summary; loading one reveals its whole timeline " +
        "at once, showing only world time. This corpus's snapshots each capture what people " +
        "knew at that moment. Loaded in doc_time order, recorded_at spreads into a line, " +
        "and supersedes happens between documents instead of only within one document. " +
        "The articles are chosen to reference each other (organizations, people, and " +
        "products), and the people form the source of cross-references. The References, " +
        "External links, and infobox tables have been cut. Note: these topics are very " +
        "common in model training data, which makes this corpus good for a demo (a " +
        "familiar result reads as a strength) but not suitable as an accuracy benchmark " +
        "(a familiar result may just be recall from training, not extraction).",
      source:
        "https://en.wikipedia.org/ -- action=query&prop=revisions + action=parse&oldid",
      license: "CC BY-SA 4.0 (attribution and share-alike; differs from the repository's main license)",
      sampling: { GROWTH_PCT, GROWTH_ABS, MIN_GAP_DAYS },
      /// The third element of each docs entry is doc_time, an ISO timestamp. An older
      /// corpus format has only two elements; run.mjs stays compatible with both.
      docs,
    },
    null,
    1,
  ),
);

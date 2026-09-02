#!/usr/bin/env node
// The measurement harness for type resolution: **one new KB per run.**
//
// This rule exists because of a mistake found once: three tuning rounds ran in a row
// against the same KB, and that KB still carried the retyping results from the
// earlier rounds. The easy entities were already refined, and rejection reasons read
// "already correctly typed as pharmacy". The numbers from the second and third rounds
// were not comparable to the first round at all, and code changed twice based on
// those numbers before this was noticed.
//
// One run: create a KB, load a fixed corpus, optionally import an ontology, run type
// resolution, then score the result against the expected answers. Both the corpus and
// the expected answers live in this repository (scripts/bench/), so anyone can rerun
// this and get the same numbers.
//
// Usage:
//   node scripts/bench/run.mjs --corpus pharma --label seeds-only
//   node scripts/bench/run.mjs --corpus pharma --ontology /tmp/schemaorg.ttl --label schemaorg
//
// Environment variables: BENCH_BASE (default http://localhost:18080), BENCH_EMAIL,
// BENCH_PASSWORD, BENCH_PSQL (default runs psql through docker exec; the ontology
// section's character count requires a direct database query).

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BENCH_BASE || "http://localhost:18080";
const EMAIL = process.env.BENCH_EMAIL || "bench@test.local";
const PASSWORD = process.env.BENCH_PASSWORD || "benchbench123";

// Measurement found roughly 4.0 characters per token (377,735 to 81,855, and 396,716
// to 99,041; both measurements gave 4.0).
//
// The actual token count for the extraction prompt is not available here, because it
// lives inside the LLM client, and exposing it would mean changing a signature all
// the way through the call chain. The ontology section's character count stays in a
// stable ratio to it, and character count is enough for what this measures: ontology
// size. This avoids changing the client.
const CHARS_PER_TOKEN = 4.0;
// What "untouched" looks like. After decision 0009 removed the built-in classes, an
// entity the ontology cannot place stays at `type_id IS NULL`, and this reads it as
// `-`. **This value is the baseline for judging "was something that should stay
// untouched actually changed."**
//
// An earlier version of this constant held the nine built-in class names (concept,
// person, organization, and so on). Those seed classes no longer exist. Keeping the
// old value would have judged every unclassified entity as "changed", inflating
// wronglyChanged.
const UNTOUCHED = "-";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith("--")) acc.push([cur.slice(2), arr[i + 1]]);
    return acc;
  }, []),
);
const corpusName = args.corpus || "pharma";
const label = args.label || corpusName;

let cookie = "";
async function api(method, url, body, isForm) {
  const init = { method, headers: {} };
  if (cookie) init.headers.cookie = cookie;
  if (isForm) init.body = body;
  else if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const r = await fetch(BASE + url, init);
  for (const c of r.headers.getSetCookie?.() ?? []) cookie = c.split(";")[0];
  const text = await r.text();
  if (!r.ok) throw new Error(method + " " + url + " -> " + r.status + " " + text.slice(0, 200));
  return text ? JSON.parse(text) : null;
}

function psql(sql) {
  const cmd =
    process.env.BENCH_PSQL ||
    "docker exec -e PGPASSWORD=utopia landscapebi-db-1 psql -U utopia -d utopia -tAc";
  const parts = cmd.split(" ");
  return execFileSync(parts[0], [...parts.slice(1), sql], { encoding: "utf8" }).trim();
}
const num = (sql) => Number(psql(sql) || 0);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/// **Only a stall counts as a timeout. Being slow does not.**
///
/// An earlier version used a fixed 15-minute total time limit. A 348-chunk corpus
/// always got killed before document extraction finished under that limit, on all
/// three runs, producing no result JSON at all, even though the server kept running
/// the extraction the whole time (the tasks queue on the server, and killing the
/// driver script does not affect them). Reporting a successful run as a failure is
/// worse than reporting nothing.
///
/// A fixed limit also cannot fit both cases: one chunk takes about a minute, a
/// 20-chunk corpus finishes in three minutes, and a 348-chunk corpus takes 75 minutes.
/// A single total-time limit cannot serve both. So this checks **progress** instead.
/// `fn` reports a progress value on each check, and the deadline extends forward
/// whenever that value changes.
///
/// `fn` returns true when the task is done, or a number meaning "not done yet, and
/// this is the current progress value."
async function until(fn, everyMs, stallMs) {
  const stall = stallMs || 900000;
  let deadline = Date.now() + stall;
  let last = null;
  for (;;) {
    const r = await fn();
    if (r === true) return;
    if (typeof r === "number" && r !== last) {
      last = r;
      deadline = Date.now() + stall;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out: no progress for ${Math.round(stall / 60000)} minutes`);
    }
    await sleep(everyMs || 5000);
  }
}

async function main() {
  const corpus = JSON.parse(
    fs.readFileSync(path.join(HERE, "corpora", corpusName + ".json"), "utf8"),
  );
  // The expected-answer key is **optional.** Some corpora are not accuracy
  // benchmarks: the holmes corpus is a demo fixture for entity resolution, and models
  // have already read it during training, so measuring type accuracy against it would
  // measure memorization, not this pipeline. With no expected-answer key, this
  // reports size, timing, and the graph's shape, and skips scoring. That is more
  // honest than inventing a fake answer key.
  const truthPath = path.join(HERE, "truth", corpusName + ".json");
  const truth = fs.existsSync(truthPath)
    ? JSON.parse(fs.readFileSync(truthPath, "utf8")).expect
    : null;

  try {
    await api("POST", "/api/v1/auth/register", {
      email: EMAIL,
      display_name: "bench",
      password: PASSWORD,
    });
  } catch {
    // Already registered; log in instead.
  }
  await api("POST", "/api/v1/auth/login", { email: EMAIL, password: PASSWORD });
  psql("UPDATE users SET is_admin=TRUE WHERE email='" + EMAIL + "'");
  await api("POST", "/api/v1/auth/login", { email: EMAIL, password: PASSWORD });

  const ws = (await api("GET", "/api/v1/workspaces"))[0].id;
  // **One new KB per run.** This rule is the entire reason this script exists.
  // Do not reuse a KB to save a few minutes.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const kb = (
    await api("POST", "/api/v1/workspaces/" + ws + "/kbs", {
      name: "bench " + label + " " + stamp,
      // --packs schema-org,prov-o follows **the product's actual cold-start path**
      // (packs install at KB creation time). This differs from --ontology, which
      // imports a file after the KB already exists, and which only measures prompt
      // overhead.
      ontology_packs: args.packs ? args.packs.split(",").map((x) => x.trim()) : [],
    })
  ).id;
  // **Ontology auto-extension is off by default,** because it would change the
  // ontology in the middle of a measurement, and then two runs would not be
  // comparing the same thing.
  //
  // But turning it off also means **cold start is never measured here.** A new KB
  // starts with only 10 built-in relations, and the product's real answer to that is
  // auto-extending the ontology after extraction (the bootstrap_ontology column
  // defaults to true). This script always sets it FALSE, so the related_to
  // proportion this harness reports is always the number "after that mechanism is
  // turned off." Using that number to claim the product's cold start is poor would be
  // treating this script's own setting as the conclusion.
  //
  // So this exposes a flag instead. Running with the flag on measures **the
  // product's actual behavior**; running with it off measures **one isolated
  // variable.** Both measurements are useful; do not keep only one.
  const autoExtend = "auto-extend" in args;
  if (!autoExtend) {
    psql("UPDATE knowledge_bases SET auto_extend_ontology=FALSE WHERE id='" + kb + "'");
  }
  await sleep(6000);

  // **The order between importing the ontology and loading the corpus measures two
  // different things.**
  //
  // Load then import (the default): extraction sees only the seed ontology, and the
  // large ontology only affects resolution afterward.
  // Import then load (--ontology-first): extraction sees the large ontology
  // immediately, which measures prompt effects.
  //
  // This distinction once caused a wrong conclusion. Under the default order, this
  // script reported a 108k-character ontology section and that was read as "a 108k
  // prompt cost 5 entities". In fact, extraction's prompt in that run held only the 9
  // seed classes; the two runs' extraction input was identical, and the 25-versus-18
  // difference was run-to-run variance. So this records both ontology_size values
  // below, each labeled with when it was measured.
  const ontologyFirst = "ontology-first" in args;

  async function importOntology() {
    if (!args.ontology) return 0;
    const t1 = Date.now();
    const form = new FormData();
    form.append(
      "file",
      new Blob([fs.readFileSync(args.ontology)]),
      path.basename(args.ontology),
    );
    await api("POST", "/api/v1/kbs/" + kb + "/ontology/imports", form, true);
    // Retrieval works only after the class vectors finish. A background job fills the
    // relation half; type resolution does not need it.
    //
    // A cold start for 1,000 classes takes minutes to tens of minutes. It competes for
    // the same embedding concurrency slot as fill jobs for other knowledge bases. This
    // waits up to 40 minutes and writes the remaining count to stderr, so a silent 20
    // minute wait does not look like a hang.
    await until(
      async () => {
        // Wait for both vector columns (see ADR 0050). Waiting only on `embedding`
        // starts too soon: the label vectors are still missing, so the short-label
        // path finds nothing. The result would look complete but is not.
        const left = num(
          "SELECT count(*) FILTER (WHERE embedding IS NULL)" +
            " + count(*) FILTER (WHERE label_embedding IS NULL)" +
            " FROM entity_types WHERE kb_id='" +
            kb +
            "'",
        );
        if (left) process.stderr.write("  Class vectors remaining: " + left + "\n");
        // Report the remaining count as progress. A falling count shows the job is not
        // stuck (`until` checks whether the value moves).
        return left === 0 ? true : left;
      },
      10000,
      2400000,
    );
    return Date.now() - t1;
  }

  const sizeNow = () => {
    const c = num(
      "SELECT coalesce(sum(length('- '||key||coalesce(': '||nullif(description,''),''))+1),0)" +
        " FROM entity_types WHERE kb_id='" +
        kb +
        "'",
    );
    const r = num(
      "SELECT coalesce(sum(length('- '||key||' (x)'||coalesce(': '||nullif(description,''),''))+1),0)" +
        " FROM relation_types WHERE kb_id='" +
        kb +
        "' AND kind<>'attribute'",
    );
    const a = num(
      "SELECT coalesce(sum((length('- '||r.key||' (text)'||coalesce(': '||nullif(r.description,''),''))+1)" +
        " * greatest(1,(SELECT count(*) FROM relation_type_domains d WHERE d.relation_type_id=r.id))),0)" +
        " FROM relation_types r WHERE r.kb_id='" +
        kb +
        "' AND r.kind='attribute'",
    );
    return {
      classes: num("SELECT count(*) FROM entity_types WHERE kb_id='" + kb + "'"),
      relations: num(
        "SELECT count(*) FROM relation_types WHERE kb_id='" + kb + "' AND kind<>'attribute'",
      ),
      attributes: num(
        "SELECT count(*) FROM relation_types WHERE kb_id='" + kb + "' AND kind='attribute'",
      ),
      prompt_chars: c + r + a,
      prompt_tokens_est: Math.round((c + r + a) / CHARS_PER_TOKEN),
    };
  };

  let importMs = 0;
  if (ontologyFirst) importMs = await importOntology();

  // **The ontology size at extraction time.** This is the size the extraction prompt
  // actually saw.
  //
  // This reads the ontology once first. Seed classes load **lazily**: the row appears
  // only on the first read or extraction. Without this read, the count would show only
  // the imported classes and miss the 9 seed classes. The first version of this script
  // missed this step. The result showed 24 classes at extraction and 32 at resolution,
  // and looked like someone changed the ontology mid-run.
  await api("GET", "/api/v1/kbs/" + kb + "/ontology");
  const atExtraction = sizeNow();

  const t0 = Date.now();
  for (const [filename, content, docTime] of corpus.docs) {
    // The third array element is doc_time. Only the history-snapshot corpus sets it;
    // older corpora have two elements, so doc_time is undefined here. This value feeds
    // two places: the extraction prompt (extraction.rs inserts it as %Y-%m-%d, so the
    // model can resolve relative dates in the text) and documents.doc_time (the
    // timeline sorts by this field). Without it, 247 snapshots would collapse into one
    // recorded time.
    const body = { filename, content };
    if (docTime) body.doc_time = docTime;
    await api("POST", "/api/v1/kbs/" + kb + "/ingest", body);
  }
  // Progress counts **chunks**, not documents. Document count is a coarse measure: a
  // 73-chunk document can run for over an hour while the document count stays at zero,
  // and that looks like a hang.
  await until(async () => {
    const done = num(
      "SELECT count(*) FROM documents WHERE kb_id='" + kb + "' AND graph_status='done'",
    );
    if (done >= corpus.docs.length) return true;
    const chunks = num(
      "SELECT count(*) FROM chunks WHERE kb_id='" + kb + "' AND extracted_at IS NOT NULL",
    );
    process.stderr.write(`  Extracted ${chunks} chunks / ${done} documents done\n`);
    return chunks;
  }, 15000);
  const extractMs = Date.now() - t0;

  if (!ontologyFirst) importMs = await importOntology();

  // The ontology size at resolution time. In the documents-first order, this differs
  // from the size at extraction time.
  const atResolution = sizeNow();

  const t2 = Date.now();
  const outcome = await api("POST", "/api/v1/kbs/" + kb + "/ontology/type-resolution");
  const resolveMs = Date.now() - t2;

  // Score the run. **Entities left for human review count as unchanged.** They have
  // not changed yet, and counting them as a hit would credit the machine for a
  // person's future work.
  //
  // **Use a LEFT JOIN, and write `-` when an entity has no class (see ADR 0009).** An
  // inner join would drop unclassified entities entirely. They would then count as
  // absent, as if extraction never found them, when in fact extraction found them but
  // did not assign a class. The two failure modes need different fixes, so this table
  // must keep them apart.
  const rows = psql(
    "SELECT e.canonical_name || '|' || coalesce(t.key, '-') FROM entities e" +
      " LEFT JOIN entity_types t ON t.id=e.type_id" +
      " WHERE e.kb_id='" +
      kb +
      "' AND e.merged_into IS NULL",
  )
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const i = l.lastIndexOf("|");
      return [l.slice(0, i), l.slice(i + 1)];
    });

  let hit = 0;
  let miss = 0;
  let correctlyLeft = 0;
  let wronglyChanged = 0;
  let absent = 0;
  const notes = [];
  for (const [frag, accept] of Object.entries(truth ?? {})) {
    // Match by fragment, not exact equality. The name extraction returns varies each
    // run (for example, "Nebula Tech" vs. "Nebula Tech (Shanghai) Co., Ltd."), and
    // exact matching would count this normal variation as a failure.
    const found = rows.filter(([name]) => name.includes(frag));
    if (found.length === 0) {
      absent += 1;
      continue;
    }
    const keys = found.map((r) => r[1]);
    if (accept.length === 0) {
      // No class in the ontology fits this entity. The correct behavior is to leave it
      // unchanged; a change here counts as an error.
      if (keys.some((k) => k !== UNTOUCHED)) {
        wronglyChanged += 1;
        notes.push(frag + ": should stay unchanged, but became " + keys.join("/"));
      } else correctlyLeft += 1;
    } else if (keys.some((k) => accept.includes(k))) {
      hit += 1;
    } else {
      miss += 1;
      notes.push(frag + ": expected " + accept.join("|") + ", got " + keys.join("/"));
    }
  }

  console.log(
    JSON.stringify(
      {
        label,
        corpus: corpusName,
        ontology: args.ontology ? path.basename(args.ontology) : null,
        kb_id: kb,
        order: ontologyFirst ? "ontology-first" : "documents-first",
        // Record this setting in the result instead of relying on memory. A previous
        // run omitted an assumption (when the ontology size was measured) and that
        // produced a wrong conclusion.
        auto_extend_ontology: autoExtend,
        // **Report both sizes, each labeled with when it was measured.** Reporting
        // only one value invites a wrong reading, such as assuming the extraction
        // prompt held this size when, in the documents-first order, extraction never
        // saw it. This misreading has happened before.
        ontology_at_extraction: atExtraction,
        ontology_at_resolution: atResolution,
        graph: {
          entities: num(
            "SELECT count(*) FROM entities WHERE kb_id='" +
              kb +
              "' AND merged_into IS NULL",
          ),
          facts: num(
            "SELECT count(*) FROM facts WHERE kb_id='" +
              kb +
              "' AND invalidated_at IS NULL",
          ),
        },
        resolution: {
          retyped: outcome.retyped,
          for_review: outcome.for_review.length,
          left_alone: outcome.left_alone.length,
        },
        score: truth
          ? { hit, miss, correctlyLeft, wronglyChanged, absent, notes }
          : "no answer key, not scored",
        ms: { extract: extractMs, import: importMs, resolve: resolveMs },
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

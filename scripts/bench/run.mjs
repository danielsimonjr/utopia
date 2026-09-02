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
    // 类向量建完才谈得上检索。关系那一半有后台任务补，类型消解用不到。
    //
    // 一千个类的冷启动要几分钟到几十分钟——跟别的库的补齐任务抢同一个嵌入
    // 并发信号量。所以放宽到 40 分钟，并把剩余数打到 stderr：静默地等二十
    // 分钟，分不清是在跑还是卡死了。
    await until(
      async () => {
        // **两份向量都要等**（0050）。只等 `embedding` 的话，label 那份还没补完
        // 就开跑，短说法那一路一条都检索不到——测出来的是个半成品，而且看不出来
        const left = num(
          "SELECT count(*) FILTER (WHERE embedding IS NULL)" +
            " + count(*) FILTER (WHERE label_embedding IS NULL)" +
            " FROM entity_types WHERE kb_id='" +
            kb +
            "'",
        );
        if (left) process.stderr.write("  类向量还差 " + left + "\n");
        // 返回剩余数当进度：它在减就说明没卡住（until 看的是"有没有动"）
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

  // **抽取当时本体有多大**——这一份才是提示词看到的那个规模。
  //
  // 先摸一次本体：种子类是**惰性建**的（第一次读本体或抽取时才落库），
  // 不先摸就量到导入进来那些、漏掉 9 个种子。第一版就漏了，表现是
  // 抽取时 24 类、消解时 32 类，看着像中途有人改了本体
  await api("GET", "/api/v1/kbs/" + kb + "/ontology");
  const atExtraction = sizeNow();

  const t0 = Date.now();
  for (const [filename, content, docTime] of corpus.docs) {
    // 第三个元素是 doc_time（历史快照语料才有；旧语料只有两个元素，这里是 undefined）。
    // 它同时进两处：抽取提示词（extraction.rs 按 %Y-%m-%d 塞进去，文内相对日期才解得开）
    // 与 documents.doc_time（时间线按它排）。少了它，247 张快照会挤成同一刻录入
    const body = { filename, content };
    if (docTime) body.doc_time = docTime;
    await api("POST", "/api/v1/kbs/" + kb + "/ingest", body);
  }
  // 进度按**块**数，不按文档数。文档数是个很粗的刻度：一篇 73 块的文档要跑
  // 一个多小时，期间文档数一动不动，看着就像卡死了
  await until(async () => {
    const done = num(
      "SELECT count(*) FROM documents WHERE kb_id='" + kb + "' AND graph_status='done'",
    );
    if (done >= corpus.docs.length) return true;
    const chunks = num(
      "SELECT count(*) FROM chunks WHERE kb_id='" + kb + "' AND extracted_at IS NOT NULL",
    );
    process.stderr.write(`  抽取 ${chunks} 块 / ${done} 篇完成\n`);
    return chunks;
  }, 15000);
  const extractMs = Date.now() - t0;

  if (!ontologyFirst) importMs = await importOntology();

  // 消解时本体有多大（先灌后导时它跟抽取当时不同）
  const atResolution = sizeNow();

  const t2 = Date.now();
  const outcome = await api("POST", "/api/v1/kbs/" + kb + "/ontology/type-resolution");
  const resolveMs = Date.now() - t2;

  // 打分。**待人工的按"没改"算**——它确实还没改，算成命中就是把人的活记在机器账上。
  //
  // **LEFT JOIN，且没有类时写 `-`**（0009）。内连接会让未分类实体整个不出现，
  // 于是它们被算进 absent——"抽取压根没抽出来"——而实际是抽出来了、只是没定类。
  // 两种失败的修法完全不同，混在一栏里这张表就白做了。
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
    // 按片段匹配而不是全等：抽取给的名字每次略有出入
    //（"星云科技" / "星云科技(上海)有限公司"），全等会把这种变化算成失败
    const found = rows.filter(([name]) => name.includes(frag));
    if (found.length === 0) {
      absent += 1;
      continue;
    }
    const keys = found.map((r) => r[1]);
    if (accept.length === 0) {
      // 本体里没有对得上的类：正确行为是**不动**，动了才算错
      if (keys.some((k) => k !== UNTOUCHED)) {
        wronglyChanged += 1;
        notes.push(frag + "：本不该改，却成了 " + keys.join("/"));
      } else correctlyLeft += 1;
    } else if (keys.some((k) => accept.includes(k))) {
      hit += 1;
    } else {
      miss += 1;
      notes.push(frag + "：期望 " + accept.join("|") + "，实得 " + keys.join("/"));
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
        // 开关写进结果里而不是靠人记得——上一个没写进去的前提（本体规模是
        // 什么时候量的）已经害我得出过一个错结论
        auto_extend_ontology: autoExtend,
        // **两份，各自标明什么时候量的。** 只报一份就会被读成"抽取用的提示词
        // 有这么大"，而先灌后导时抽取根本没见过它——这个误读已经发生过一次
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
          : "无答案键，不打分",
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

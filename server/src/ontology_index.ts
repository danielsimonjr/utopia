/**
 * The ontology's vector index: embeds each class/relation/attribute's
 * `label + description`.
 *
 * This does not serve one feature — it serves every place that asks "which
 * ontology entry does this wording correspond to": ontology proposals,
 * predicate resolution, type resolution. Retrieval narrows to a shortlist
 * of candidates first, and a model adjudicates from there, so the prompt
 * stays decoupled from the ontology's size.
 *
 * **Self-healing, no hooks.** Staleness is judged by "does the text we
 * embedded, and the model name, still match now" — so no write site that
 * changes a description needs to remember to notify this module. A missed
 * hook rots silently; comparing the source text does not.
 */

import type { Sql } from "./core/db";
import * as store from "./store";
import { embedClient, acquireEmbed } from "./llm_util";
import { log } from "./core/log";
import type { Uuid } from "./core/ids";
import type { TypeCandidate } from "./store/ontology";

/** How many rows go into one embedding request. Measured to hold up: real class text averages 151 characters. */
const BATCH = 64;
/** How many embedding batches may be in flight at once — small on purpose, to leave room in the shared per-model concurrency gate. */
const EMBED_JOBS = 4;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i]!) };
      } catch (e) {
        results[i] = { status: "rejected", reason: e };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

/** Tops up this KB's stale ontology vectors. Returns 0 with no embed model configured — retrieval is an enhancement, and must not block a deployment that has none. */
export async function refresh(sql: Sql, kb_id: Uuid): Promise<number> {
  return refreshScoped(sql, kb_id, null);
}

/** Tops up only half. Type resolution only needs classes; waiting for relations to finish embedding too wastes time. The other half is caught by the background top-up job. */
export async function refreshScoped(
  sql: Sql,
  kb_id: Uuid,
  only: store.ontology.TypeKind | null,
): Promise<number> {
  let kb;
  try {
    kb = await store.kbs.get(sql, kb_id);
  } catch {
    // The KB may already be gone -- the task was queued at import time,
    // minutes may have passed. That is not a failure, it is nothing to do.
    return 0;
  }
  const settings = await store.settings.get(sql, kb.workspace_id);
  if (!settings) return 0;
  const client = embedClient(settings);
  const model = settings.embed_model;
  if (!client || !model) return 0;

  const stale = await store.ontology.types_needing_embedding(sql, kb_id, model, only);
  if (stale.length === 0) return 0;

  let done = 0;
  let failed = 0;
  const batches = chunk(stale, BATCH);
  const results = await mapWithConcurrency(batches, EMBED_JOBS, async (batch) => {
    const texts = batch.map((t) => t.text);
    const release = await acquireEmbed(sql, settings);
    try {
      const vectors = await client.embed(texts);
      if (vectors.length !== batch.length) {
        throw new Error(`embedding returned ${vectors.length} vectors for ${batch.length} rows`);
      }
      const items: [typeof batch[number], number[]][] = batch.map((t, i) => [t, vectors[i]!]);
      await store.ontology.set_type_embeddings(sql, model, items);
      return batch.length;
    } finally {
      release();
    }
  });
  for (const r of results) {
    if (r.status === "fulfilled") done += r.value;
    else {
      failed += 1;
      log.warn("a batch of ontology vectors did not embed, leaving it for the next round", {
        kb_id,
        error: String(r.reason),
      });
    }
  }
  if (failed > 0) {
    log.warn("ontology vectors partially topped up, the rest left for the next round", {
      kb_id,
      count: done,
      failed,
    });
  } else {
    log.info("ontology vectors topped up", { kb_id, count: done });
  }
  return done;
}

/** Which half of the ontology to search. Classes live in `entity_types`; relations and attributes share `relation_types` — their descriptions answer different questions, so the two must never be searched together. */
export type Target =
  | { kind: "class" }
  | { kind: "classLabel" }
  | { kind: "predicate"; only: "relation" | "attribute" | null };

/**
 * For a batch of wordings, the ontology relations/attributes that most
 * resemble each. Embeds everything in one pass, then queries the database
 * once per vector — not once per wording.
 */
export async function nearestForEach(
  sql: Sql,
  kb_id: Uuid,
  queries: string[],
  limit: number,
  target: Target,
): Promise<TypeCandidate[][]> {
  if (queries.length === 0) return [];
  const empty = (): TypeCandidate[][] => queries.map(() => []);

  const kb = await store.kbs.get(sql, kb_id);
  const settings = await store.settings.get(sql, kb.workspace_id);
  if (!settings) return empty();
  const client = embedClient(settings);
  if (!client) return empty();

  const vectors: number[][] = [];
  for (const batch of chunk(queries, BATCH)) {
    const release = await acquireEmbed(sql, settings);
    try {
      const got = await client.embed(batch);
      if (got.length !== batch.length) {
        throw new Error(`embedding returned ${got.length} vectors for ${batch.length} rows`);
      }
      vectors.push(...got);
    } finally {
      release();
    }
  }

  const out: TypeCandidate[][] = [];
  for (const v of vectors) {
    if (target.kind === "class") {
      out.push(await store.ontology.nearest_entity_types(sql, kb_id, v, limit, false));
    } else if (target.kind === "classLabel") {
      out.push(await store.ontology.nearest_entity_types(sql, kb_id, v, limit, true));
    } else {
      out.push(await store.ontology.nearest_relation_types(sql, kb_id, v, limit, target.only));
    }
  }
  return out;
}

/**
 * Graph extraction task.
 *
 * The task calls the LLM chunk by chunk, resolves entities (v2), and
 * writes facts and evidence to the ledger.
 *
 * Extraction is separate from the ingest pipeline (a two-stage design).
 * Once ingest indexes a document, the document is searchable and
 * answerable. Extraction runs slowly in the background.
 *
 * Gray-zone resolution pairs only enqueue review rows. A separate batched
 * adjudication job later judges them. An LLM verdict never blocks this
 * task.
 */

import type { AppState } from "./state";
import * as store from "./store";
import { chatClient, acquireChat } from "./llm_util";
import { PredicateIndex, type RelationTypeLike } from "./predicate_match";
import { rateLimited } from "./llm";
import type { LlmClient } from "./llm";
import * as extract from "./extract";
import type { Uuid } from "./core/ids";
import { log } from "./core/log";
import type { LlmSettings } from "./core/models";
import type { EntityType, RelationType } from "./store/graph";

/** Cap on rate-limit backoff retries. Applies only to 429s: a bad key stays bad no matter how many times it retries. */
const RATE_LIMIT_TRIES = 5;
/** Cap on one backoff wait. Total wait is capped a little over two minutes; an account whose quota stays exhausted fails cleanly instead of holding a worker slot forever. */
const RATE_LIMIT_CAP_MS = 60_000;

/**
 * Jitters a backoff delay to the lower half of its range.
 *
 * This avoids many chunks waking up at the same instant. The backoff
 * still grows monotonically; only the exact wake time is randomized.
 */
function jitter(baseMs: number): number {
  const nanos = process.hrtime.bigint() % 1_000_000_000n;
  const half = Math.floor(baseMs / 2);
  const offset = half === 0 ? 0 : Number(nanos % BigInt(half));
  return Math.floor(baseMs / 2) + offset;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs one extraction chat call, backing off and retrying on a rate
 * limit.
 *
 * A rate limit heals on its own, unlike other failures. Skipping the
 * chunk on a rate limit trades a one-minute wait for a permanent data
 * gap — measured on one 1884-chunk ingest run, 55 of 60 documents failed
 * outright while the endpoint stayed healthy throughout.
 *
 * Two details matter:
 * - The concurrency permit only wraps the call itself. It is released
 *   before sleeping, or a waiting chunk would block one that could go
 *   through right away.
 * - Most providers do not send `Retry-After`. Treat it as a bonus hint
 *   when present; fall back to exponential backoff otherwise.
 */
async function chatRetryingRateLimits(
  state: AppState,
  settings: LlmSettings,
  client: LlmClient,
  messages: { role: string; content: string }[],
): Promise<string> {
  let backoff = 2000;
  for (let attempt = 1; attempt <= RATE_LIMIT_TRIES; attempt++) {
    const release = await acquireChat(state, settings);
    let reply: string;
    try {
      reply = await client.chat(messages);
    } catch (e) {
      release();
      const hit = rateLimited(e);
      if (!hit) throw e;
      if (attempt === RATE_LIMIT_TRIES) {
        throw new Error(`still rate limited after ${RATE_LIMIT_TRIES} backoff attempts: ${(e as Error).message}`);
      }
      const delay = jitter(Math.min(hit.retryAfterMs ?? backoff, RATE_LIMIT_CAP_MS));
      log.warn("endpoint is rate limiting; backing off and retrying", {
        attempt,
        delay_ms: delay,
        from_header: hit.retryAfterMs != null,
      });
      await sleep(delay);
      backoff = Math.min(backoff * 2, RATE_LIMIT_CAP_MS);
      continue;
    }
    release();
    return reply;
  }
  throw new Error("unreachable: the loop above always returns or throws");
}

const MIN_CONFIDENCE = 0.6;

/**
 * Whether a string names a thing (versus being a whole sentence or
 * clause).
 *
 * The test is word count, not character count. Character count cannot
 * tell the two apart: "US District Court for the Northern District of
 * California" (57 characters) is a real entity, while "removal was
 * driven by growing discontent and distrust with Altman" (65 characters)
 * is a whole clause. Both are close in length and in word count (9 vs
 * 10), but the clause carries a **finite verb**.
 *
 * So two tests apply together: a word-count cap blocks long sentences,
 * and a finite-verb check blocks short clauses.
 *
 * The word cap is 12: the longest real institution name observed is 9
 * words; this leaves headroom of 3.
 */
const MAX_NAME_WORDS = 12;

/**
 * Finite-verb markers. Only finite forms are listed — a participle such
 * as `used` or `flying` is normal inside a noun phrase ("equipment used
 * by X") and would wrongly flag a real entity name.
 */
const CLAUSE_MARKERS = new Set([
  "was", "were", "is", "are", "has", "have", "had", "will", "would", "showed", "said", "says",
  "became", "went", "came", "did", "does", "gave", "took", "made",
]);

function isEntityName(rawName: string): boolean {
  const name = rawName.trim();
  if (name === "" || [...name].length > 100) {
    return false;
  }
  const words = name
    .split(/\s+/)
    .map((w) => w.replace(/^[^a-zA-Z0-9\p{L}\p{N}]+|[^a-zA-Z0-9\p{L}\p{N}]+$/gu, "").toLowerCase());
  if (words.length > MAX_NAME_WORDS) {
    return false;
  }
  // A single-word name cannot be a clause; do not flag a proper noun like "Is".
  if (words.length > 2 && words.some((w) => CLAUSE_MARKERS.has(w))) {
    return false;
  }
  // A partitive phrase: "745 of OpenAI's 770 employees" describes a quantity,
  // not a thing. It has no finite verb and is not long, so neither test
  // above catches it. The test is narrow on purpose: a real entity that
  // starts with a digit ("3M", "7-Eleven", "23andMe") does not have a
  // bare-digit first word; "2023 Nobel Prize" has a bare-digit first word,
  // but its second word is not "of". Widening this test would misfire on
  // those.
  if (
    words.length >= 3 &&
    words[1] === "of" &&
    words[0] !== "" &&
    /^\d+$/.test(words[0]!)
  ) {
    return false;
  }
  return true;
}

/**
 * Records one drop signal. The extractor has seven places that skip a
 * fact silently; each one is a case of "a fact was extracted, then
 * blocked, with nothing said". A failure to write the signal must never
 * fail the whole document's extraction, so the error is swallowed.
 */
async function dropSignal(
  state: AppState,
  kbId: Uuid,
  documentId: Uuid,
  reason: string,
  detail: string,
  example: string | null,
): Promise<void> {
  try {
    await store.extractionDrops.record(state.sql, kbId, documentId, reason, detail, example);
  } catch {
    // Losing a signal must not lose the extraction it describes.
  }
}

/**
 * Whether this round of extraction finished — and if not, the message to
 * store in `graph_error`.
 *
 * The test is "every chunk succeeded", not some ratio. Any ratio is
 * arbitrary; this test needs no arbitrary threshold — a round is only
 * complete once every chunk in it succeeded.
 *
 * `attempted` is the number of chunks fetched **this round**, not the
 * document's total chunk count: a retry only re-fetches chunks whose
 * `extracted_at` is still null, so the denominator on a retry is
 * naturally smaller. The message says "this round" so nobody reads it as
 * the whole document.
 */
function incompleteReason(unextracted: [number, string][], attempted: number): string | null {
  if (unextracted.length === 0) {
    return null;
  }
  // List only the first three: the cause is usually one and the same (an
  // unreachable endpoint fails every chunk the same way), so listing
  // twenty repeats one sentence twenty times.
  const sample = unextracted.slice(0, 3).map(([seq, why]) => `#${seq} ${why}`);
  const more = Math.max(unextracted.length - sample.length, 0);
  const tail = more > 0 ? `; ${more} more` : "";
  return `${unextracted.length} of ${attempted} chunks failed to extract this round: ${sample.join("; ")}${tail}`;
}

/**
 * The single enqueue point for automatic ontology extension. Both the
 * success path and the failure path must call it.
 *
 * The switch is re-read here, not carried over from what the caller
 * already holds: the failure path never loaded the KB at all, and on the
 * success path the caller's copy was read when extraction **started** —
 * a 73-chunk document can run for over an hour, and using a stale value
 * would act on an intent that is an hour old.
 */
async function enqueueBootstrap(state: AppState, kbId: Uuid): Promise<void> {
  const kb = await store.kbs.get(state.sql, kbId);
  if (!kb.auto_extend_ontology) {
    return;
  }
  if (!(await store.documents.extractionIdle(state.sql, kbId))) {
    return;
  }
  await store.jobs.enqueue(state.sql, "bootstrap_ontology", { kb_id: kbId });
}

export async function extractDocument(state: AppState, documentId: Uuid): Promise<void> {
  try {
    await run(state, documentId);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // The reason lands with the status: an error that only reaches the
    // log is the same as no error at all.
    try {
      await store.documents.setGraphFailed(state.sql, documentId, message);
    } catch {
      // Best effort: the caller's error takes priority.
    }
    try {
      const doc = await store.documents.get(state.sql, documentId);
      state.emitDocument(doc.kb_id, documentId);
      // Automatic ontology extension must fire on failure too.
      //
      // This used to run only on the success path, which could wedge a
      // whole knowledge base permanently: the first 14 documents succeed
      // (each one sees another extraction still in flight, so it never
      // fires), the 15th exhausts its retries and becomes failed — at
      // that exact moment `extractionIdle` is true (a failed document
      // does not count as queued/extracting), but no document will ever
      // finish again to trigger the check. Proposals then pile up
      // unseen, the ontology stays frozen at its seed vocabulary, and
      // half the graph stays on the fallback predicate, with nothing on
      // screen to say so.
      //
      // The task itself is idempotent and re-checks the switch and the
      // threshold, so enqueuing it again here is safe.
      await enqueueBootstrap(state, doc.kb_id).catch(() => {});
    } catch {
      // The document may not even exist anymore; nothing more to do.
    }
    throw e;
  }
}

/**
 * Resolves a mention name to an entity id.
 *
 * Within one document, the same name and type reuse the same entity —
 * two mentions of the same name rarely refer to different people within
 * a single document, and this also cuts resolution calls down to one per
 * name. Cross-document ambiguity is handled by `resolve_mention`'s
 * profile comparison.
 */
async function resolveEntity(
  state: AppState,
  kbId: Uuid,
  // null = the model's type is not in the ontology, or this KB has no
  // types at all (decision 0009).
  typeId: Uuid | null,
  name: string,
  ctx: number[] | null,
  docCache: Map<string, Uuid>,
  needsAdjudication: { value: boolean },
): Promise<Uuid> {
  const key = `${typeId ?? ""}\u0000${store.resolution.normalize_name(name).toLowerCase()}`;
  const cached = docCache.get(key);
  if (cached) {
    return cached;
  }
  const r = await store.resolution.resolve_mention(state.sql, kbId, typeId, name, ctx);
  // Suspected-duplicate pairs (same-name gray zone / type drift) enqueue a
  // review row; the batched adjudication job settles them later.
  for (const review of r.reviews) {
    await store.resolution.create_review(
      state.sql,
      kbId,
      r.entity_id,
      review.other_id,
      review.score,
      review.reason,
    );
    needsAdjudication.value = true;
  }
  docCache.set(key, r.entity_id);
  return r.entity_id;
}

async function run(state: AppState, documentId: Uuid): Promise<void> {
  const doc = await store.documents.get(state.sql, documentId);
  const kb = await store.kbs.get(state.sql, doc.kb_id);
  const settings = await store.settings.get(state.sql, kb.workspace_id);
  if (!settings) {
    throw new Error("Chat model not configured; cannot extract");
  }
  const client = chatClient(settings);
  if (!client) {
    throw new Error("Chat model not configured; cannot extract");
  }

  // Ownership token: a re-extraction bumps the epoch, and this task
  // notices it has been superseded (see the chunk loop below).
  const myEpoch = await store.documents.extractEpoch(state.sql, documentId);
  await store.documents.setGraphStatus(state.sql, documentId, "extracting");
  state.emitDocument(doc.kb_id, documentId);
  const etypes = await store.graph.entity_types(state.sql, doc.kb_id);
  const rtypes = await store.graph.relation_types(state.sql, doc.kb_id);

  // Relations and attributes travel different channels: attributes go
  // through the literal-value channel and are excluded from the relation
  // list.
  //
  // **No matching relation in the ontology means no predicate at all**
  // (see `facts.predicate_id`). The original wording lands in
  // `fact_evidence.proposed_predicate` and is recovered for display by
  // `fact_surface_predicate()`. There is no catch-all `related_to`
  // relation, and none is listed for the model — listing one turns it
  // into an escape hatch that the model reaches for the moment a
  // relation is unclear, instead of writing down what the text actually
  // said.
  const typeKeyById = new Map<Uuid, string>(etypes.map((t) => [t.id, t.key]));
  const attrMeta = new Map<string, RelationType>(
    rtypes.filter((r) => r.kind === "attribute").map((r) => [r.key, r]),
  );
  const typeIds = new Map<string, Uuid>(etypes.map((t) => [t.key, t.id]));
  const relIds = new Map<string, Uuid>(rtypes.map((r) => [r.key, r.id]));
  // Folds the model's wording onto an existing ontology relation: spelling,
  // tense, and passive voice are all aligned (see predicate_match). Without
  // this, a model that writes `produced_by` when the ontology has `produces`
  // gets downgraded and dropped.
  const predIndex = PredicateIndex.build(rtypes as RelationTypeLike[]);
  // "Does the ontology recognize this wording at all" — the literal-value
  // channel and the relation channel must use the same test. Splitting them
  // would let a fuzzy-matchable predicate get shunted onto the literal
  // channel first, so the same word gets opposite answers on the two paths.
  const knownPredicate = (p: string): boolean => relIds.has(p) || predIndex.lookup(p) !== null;
  // Time reconciliation only applies to state relations with a uniqueness
  // constraint (ontology metadata): (functional, inverse_functional, temporal).
  const relMeta = new Map<Uuid, [boolean, boolean, string]>(
    rtypes.map((r) => [r.id, [r.functional, r.inverse_functional, r.temporal]]),
  );
  const typeParents = new Map<Uuid, Uuid[]>(etypes.map((t) => [t.id, t.parents]));

  // Inline the whole ontology, or retrieve candidates per chunk.
  //
  // Inlining everything is today's behavior, and it is correct and cheap
  // for a small ontology: about 40 classes cost roughly 2k characters,
  // where retrieval would just be an extra round trip. For a large
  // ontology it is a disaster — measured on schema.org, each chunk cost
  // 108k tokens, and the same corpus extracted 25 entities with only the
  // seed classes listed but just 18 once the full vocabulary was listed.
  // **The extra 959 classes ate 7 entities.**
  //
  // So the choice is budget-based. The test measures the **actual text
  // that would be laid out** (`buildLists` counts it itself), not a
  // separate estimate formula that would drift from the layout.
  const full = buildLists(etypes, rtypes, null, null);
  const budget = await store.access.ontologyPromptBudget(state.sql);
  const retrievePerChunk = promptListsChars(full) > budget;
  if (retrievePerChunk) {
    log.info("ontology exceeds the prompt budget; retrieving candidates per chunk", {
      document_id: documentId,
      chars: promptListsChars(full),
      budget,
      classes: etypes.length,
    });
  }
  // Built-in classes are always present: a chunk that retrieval misses
  // still needs somewhere for the model to land an entity.
  const seedClasses = new Set<Uuid>(etypes.filter((t) => t.builtin).map((t) => t.id));

  // Attribute domains allow subclasses: a subject type qualifies if
  // walking up its parent chain reaches the domain.
  //
  // Walks up `subClassOf`. **Breadth-first with a visited set**, not a
  // single-chain loop: a class can have multiple parents (FOAF's Person
  // is both an Agent and a SpatialThing), and diamond inheritance reaches
  // the same ancestor by two paths — without a visited set that ancestor
  // would expand twice.
  //
  // The depth limit is the visited set, not a hop count: the write side
  // (`set_parents`) already checks for cycles, and "walk at most ten
  // levels" here would neither stop a wide graph nor quietly let a deep
  // one through.
  const typeMatchesDomain = (ty: Uuid, domain: Uuid): boolean => {
    const seen = new Set<Uuid>();
    const queue = [ty];
    while (queue.length > 0) {
      const cur = queue.pop()!;
      if (cur === domain) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const ps = typeParents.get(cur);
      if (ps) queue.push(...ps);
    }
    return false;
  };

  // This round tells this document's story from scratch; clear old signals
  // (a re-extraction is authoritative).
  await store.extractionDrops.clearForDocument(state.sql, documentId).catch(() => {});

  const docTime = doc.doc_time ? formatYmd(doc.doc_time) : null;
  const chunks = await store.documents.chunksForExtraction(state.sql, documentId);

  const docCache = new Map<string, Uuid>();
  // Entities already accepted in this document, in first-appearance
  // order, fed into later chunks' prompts.
  //
  // **De-duplicated by entity id, not by name**: if chunk 3 writes
  // "Shanghai Institute" and it resolves to chunk 1's "Nebula Tech
  // Shanghai Institute", it must not enter the list under the second
  // name — each entity gets one display form in this list, the one
  // first used in this document.
  const docEntities: [Uuid, string, string][] = [];
  // Chunks that produced nothing at all: (seq, reason). Used at the end
  // to refuse marking the document done.
  const unextracted: [number, string][] = [];
  const needsAdjudication = { value: false };
  let conflictsFound = false;
  let factCount = 0;
  // No chunk cap: silently truncating would silently drop knowledge. The
  // cost of a long document is the deployer's call (cost optimization is
  // a prompt-prefix-cache and chunk-level-skip problem, not a data-loss
  // problem).
  for (const chunk of chunks) {
    // A takeover means a quiet exit: do not write failed, do not touch
    // status — the stage belongs to the new task now. Checked before the
    // LLM call: the cancellation granularity is one chunk, no need to
    // wait for the whole document.
    if ((await store.documents.extractEpoch(state.sql, documentId)) !== myEpoch) {
      log.info("extraction task was superseded by a newer round; exiting", { document_id: documentId });
      return;
    }
    const ctx = chunk.embedding ?? null;
    // Use the full list when the ontology fits the budget; otherwise
    // retrieve candidates using **this chunk's own vector**. The vector is
    // already at hand — entity resolution already uses it (the same
    // `ctx`) — so retrieval costs no extra embedding call. Fall back to
    // the full list when retrieval finds nothing (no embedding model
    // configured, or this chunk has no vector): a big prompt is slow, but
    // no classes to choose from means nothing gets extracted at all.
    let lists: PromptLists | null = null;
    if (retrievePerChunk && ctx) {
      try {
        lists = await chunkLists(state, doc.kb_id, ctx, etypes, rtypes, seedClasses);
      } catch {
        lists = null;
      }
    }
    const activeLists = lists ?? full;
    const known: [string, string][] = docEntities.map(([, k, n]) => [k, n]);
    const messages = extract.buildMessages(
      activeLists.types,
      activeLists.relations,
      activeLists.attributes,
      docTime,
      doc.filename,
      known,
      chunk.text,
    );
    // Both `continue`s below skip the **whole chunk** — it produces zero
    // facts. Record it: the outcome at the end decides whether this
    // document counts as fully extracted (see after the loop).
    let reply: string;
    try {
      reply = await chatRetryingRateLimits(state, settings, client, messages);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log.warn("extraction call failed; skipping this chunk", {
        document_id: documentId,
        seq: chunk.seq,
        error: message,
      });
      unextracted.push([chunk.seq, `call failed: ${message}`]);
      continue;
    }
    let extraction: extract.Extraction;
    try {
      extraction = extract.parseResponse(reply);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log.warn("extraction result failed to parse; skipping this chunk", {
        document_id: documentId,
        seq: chunk.seq,
        error: message,
      });
      unextracted.push([chunk.seq, `result failed to parse: ${message}`]);
      continue;
    }
    // What got skipped must be said. Item-by-item parsing saves the rest of
    // the chunk, but the items it dropped must not become another kind of
    // "a partial extraction reported as complete".
    if (extraction.truncated) {
      await dropSignal(
        state,
        doc.kb_id,
        documentId,
        store.extractionDrops.reason.TRUNCATED_REPLY,
        `chunk #${chunk.seq}'s output was truncated`,
        null,
      );
    }
    const skipped = extraction.skippedEntities + extraction.skippedFacts;
    if (skipped > 0) {
      log.warn("skipped malformed items", {
        document_id: documentId,
        seq: chunk.seq,
        entities: extraction.skippedEntities,
        facts: extraction.skippedFacts,
      });
      await dropSignal(
        state,
        doc.kb_id,
        documentId,
        store.extractionDrops.reason.MALFORMED_ITEM,
        `chunk #${chunk.seq} skipped ${extraction.skippedEntities} entities / ${extraction.skippedFacts} facts`,
        null,
      );
    }

    // Entity resolution: name -> entity id (this chunk's facts connect to
    // the original wording).
    const entityIds = new Map<string, Uuid>();
    // Name -> declared type (for attribute domain checks: salary cannot
    // land on Organization).
    const entityTypeOf = new Map<string, Uuid | null>();
    for (const e of extraction.entities) {
      const name = e.name.trim();
      if (!isEntityName(name)) {
        // This used to be a silent `continue` — exactly the case
        // `dropSignal` exists for.
        await dropSignal(
          state,
          doc.kb_id,
          documentId,
          store.extractionDrops.reason.NOT_AN_ENTITY_NAME,
          e.type,
          name,
        );
        continue;
      }
      // Remember the model's proposed word when downgrading: the
      // ontology not fitting it does not mean it was wrong. Keeping only
      // a count would make it impossible to later find those entities to
      // add a `model` class for them — they hide inside `concept`, and
      // the only way out is a full re-extraction of the whole KB.
      let proposed: string | null = null;
      let typeId: Uuid | null;
      const existingTypeId = typeIds.get(e.type);
      if (existingTypeId !== undefined) {
        typeId = existingTypeId;
      } else {
        // Type outside the whitelist: **leave it unset**, and record it
        // in the miss statistics (a signal for ontology extension).
        //
        // This used to downgrade to a `concept` sentinel row. Now "not
        // yet decided" simply means `type_id IS NULL` (decision 0009):
        // the entity is created, the fact lands, the evidence is
        // recorded — only the type is missing for now. Installing a
        // pack later runs type resolution, which reassigns it.
        await store.ontology.record_miss(state.sql, doc.kb_id, "entity_type", e.type, name).catch(() => {});
        proposed = e.type;
        typeId = null;
      }
      const id = await resolveEntity(state, doc.kb_id, typeId, name, ctx, docCache, needsAdjudication);
      if (proposed !== null) {
        await store.resolution.set_proposed_type(state.sql, id, proposed).catch(() => {});
      }
      // The model's own wording. **Stored apart from proposed_type**: that
      // column means "not in the ontology", and the growth loop relies on
      // its rarity to set a threshold; this column has one value per
      // entity. A specific type that just repeats the coarse type name is
      // not recorded — that is not a more specific wording, just the same
      // list item copied twice.
      const st = e.specificType?.trim();
      if (st && st !== "" && st.toLowerCase() !== e.type.toLowerCase()) {
        await store.resolution.set_specific_type(state.sql, id, st).catch(() => {});
      }
      // Only entities the model actually declared a type for are recorded
      // here: the subject/object fallback path has no type to go on, and
      // recording a guessed type would let later chunks copy that guess.
      //
      // When the ontology cannot fit that type, the model's own wording
      // (`proposed`) is used: this list exists so later text recognizes
      // "the same name, do not create a second entity" — that is its only
      // job. This code used to always write `concept` here, flattening
      // several different words into one label.
      if (!docEntities.some(([eid]) => eid === id)) {
        const tk = (typeId ? typeKeyById.get(typeId) : undefined) ?? proposed ?? "?";
        docEntities.push([id, tk, name]);
      }
      entityIds.set(name, id);
      entityTypeOf.set(name, typeId);
    }

    for (const f of extraction.facts) {
      const confidence = Math.min(Math.max(f.confidence ?? 0.7, 0), 1);
      if (confidence < MIN_CONFIDENCE) {
        // A designed threshold, but the user has no way to know "it was
        // extracted, just not confident enough" either.
        await dropSignal(
          state,
          doc.kb_id,
          documentId,
          store.extractionDrops.reason.LOW_CONFIDENCE,
          f.predicate,
          `${f.subject} (${Math.round(confidence * 100)}%)`,
        );
        continue;
      }
      const from = f.validFrom ? extract.parseTime(f.validFrom) : null;
      const to = f.validTo ? extract.parseTime(f.validTo) : null;
      // **Each end records its own precision** (see `facts.valid_to_precision`).
      // A single shared precision column used to describe both ends, so
      // "started in 2020, ended 2023-05-06" could not be represented.
      //
      // The model's `valid_to = "unknown"` means the source text says it
      // ended, but does not say when. `parseTime` cannot parse it (it is
      // not a date), so it is recognized explicitly here — without this
      // it degrades to null and the assertion reverts to "still ongoing".
      const endedUnknown =
        f.validTo != null && f.validTo.trim().toLowerCase() === store.graph.ENDED_UNKNOWN;
      const validity = new store.graph.Validity({
        from: from?.date ?? null,
        from_precision: from?.precision ?? null,
        to: to?.date ?? null,
        to_precision: to?.precision ?? (endedUnknown ? store.graph.ENDED_UNKNOWN : null),
      });

      // Attribute fact: the predicate hits an attribute -> the literal-
      // value channel. A datatype-check failure would rather lose the fact
      // than store it dirty; the domain check (with subclass walk-up)
      // blocks mismatches such as putting salary on Organization. The
      // model occasionally copies the fully qualified name from the list,
      // like "person.salary" — strip the class prefix and look up again.
      const attrHit =
        attrMeta.get(f.predicate) ?? (f.predicate.includes(".") ? attrMeta.get(f.predicate.split(".").pop()!) : undefined);
      if (attrHit) {
        const subjectName = f.subject.trim();
        // The subject was not declared in entities: its type is unknown,
        // the domain cannot be checked, and the attribute does not land.
        // The relation path falls back to resolving as `concept` on the
        // same gap; this path cannot borrow that trick — a `concept`-typed
        // subject would still fail the domain check, only later, at the
        // branch below.
        const subjectId = entityIds.get(subjectName);
        const subjectType = entityTypeOf.get(subjectName);
        if (subjectId === undefined) {
          await dropSignal(
            state,
            doc.kb_id,
            documentId,
            store.extractionDrops.reason.SUBJECT_NOT_DECLARED,
            attrHit.key,
            subjectName,
          );
          continue;
        }
        // Unreachable in practice: the store layer requires every
        // attribute to have a domain, and a domain-less attribute never
        // even reaches the prompt. Kept as a defensive check; no signal
        // needed.
        if (attrHit.domains.length === 0) {
          continue;
        }
        // **Any matching domain is enough**: an attribute attached to
        // several classes counts if the subject belongs to any one of
        // them.
        if (!attrHit.domains.some((d) => subjectType != null && typeMatchesDomain(subjectType, d))) {
          const subjKey = (subjectType ? typeKeyById.get(subjectType) : undefined) ?? "?";
          const domKey = attrHit.domains
            .map((d) => typeKeyById.get(d))
            .filter((k): k is string => k != null)
            .join("|");
          await dropSignal(
            state,
            doc.kb_id,
            documentId,
            store.extractionDrops.reason.ATTR_DOMAIN_MISMATCH,
            `${attrHit.key}@${subjKey} (wants ${domKey})`,
            subjectName,
          );
          continue;
        }
        let raw: unknown;
        if (f.value !== undefined) {
          raw = f.value;
        } else if (f.object && f.object.trim() !== "") {
          // The model occasionally puts the value in `object`: accept it.
          raw = f.object.trim();
        } else {
          await dropSignal(
            state,
            doc.kb_id,
            documentId,
            store.extractionDrops.reason.ATTR_NO_VALUE,
            attrHit.key,
            subjectName,
          );
          continue;
        }
        const datatype = attrHit.datatype ?? "text";
        const normalized = extract.normalizeAttrValue(datatype, raw);
        if (normalized === null || normalized === undefined) {
          await dropSignal(
            state,
            doc.kb_id,
            documentId,
            store.extractionDrops.reason.ATTR_DATATYPE,
            `${attrHit.key} (${datatype})`,
            `${subjectName} → ${JSON.stringify(raw)}`,
          );
          continue;
        }
        const objectValue: Record<string, unknown> = { value: normalized };
        if (attrHit.unit) {
          // The unit travels with the fact: a later change to the type's
          // unit must not rewrite old values under the new unit.
          objectValue.unit = attrHit.unit;
        }
        const [factId, created] = await store.graph.insert_value_fact(
          state.sql,
          doc.kb_id,
          subjectId,
          attrHit.id,
          objectValue,
          validity,
          confidence,
        );
        // The attribute's own predicate also keeps the original wording:
        // the model occasionally copies the fully qualified name
        // ("person.salary"); what it wrote is worth keeping as-is.
        await store.graph.add_evidence(state.sql, factId, chunk.id, f.quote ?? null, f.predicate);
        if (!created) {
          continue;
        }
        factCount += 1;
        // A single-valued attribute is functional: the new value closes
        // the old one (this is where attribute history comes from).
        if (attrHit.functional && attrHit.temporal === "state") {
          const report = await store.temporal.reconcileNewFact(
            state.sql,
            doc.kb_id,
            factId,
            subjectId,
            attrHit.id,
            null,
            objectValue,
            "SubjectSide",
            validity,
            confidence,
          );
          if (report.conflicts > 0) {
            conflictsFound = true;
          }
        }
        continue;
      }

      // **A literal value outside the vocabulary: neither dropped, nor
      // invented as an entity.**
      //
      // Reaching here means the predicate is neither a known attribute
      // nor (yet) a checked relation. Two earlier approaches both failed:
      // with `value` set and `object` empty it fell into the "object is
      // required" branch below and vanished silently; with the literal
      // stuffed into `object`, resolving it as `concept` invented a fake
      // entity out of thin air (a node in the graph named "2015", with no
      // clean way to fix it later short of reshaping the fact). Now it is
      // stored as an `object_value` with no predicate: the value is in
      // the graph with evidence and timing, the original word is in
      // `proposed_predicate`, and a later re-resolution only needs to
      // swap the predicate — the shape is already right.
      //
      // Whether the thing in `object` counts as a literal is judged
      // strictly: the model must not have declared it an entity, and it
      // must itself parse as a number or a date. "Shanghai" satisfies
      // neither; "2015" satisfies both. Text-valued attributes (323 of
      // them on schema.org) still turn into entities on this path — there
      // is no reliable test here, and a wrong guess would eat a real
      // entity.
      let literal: unknown;
      const objectTrim = f.object?.trim() ?? "";
      if (f.value !== undefined && objectTrim === "" && !knownPredicate(f.predicate)) {
        literal = f.value;
      } else if (
        objectTrim !== "" &&
        !knownPredicate(f.predicate) &&
        !entityIds.has(objectTrim) &&
        looksLiteral(objectTrim)
      ) {
        literal = objectTrim;
      } else {
        literal = undefined;
      }
      if (literal !== undefined) {
        const subjectName = f.subject.trim();
        const subjectId = entityIds.get(subjectName);
        if (subjectId === undefined) {
          await dropSignal(
            state,
            doc.kb_id,
            documentId,
            store.extractionDrops.reason.SUBJECT_NOT_DECLARED,
            f.predicate,
            subjectName,
          );
          continue;
        }
        await store.ontology
          .record_miss(state.sql, doc.kb_id, "attribute_type", f.predicate, `${subjectName} → ${literal}`)
          .catch(() => {});
        const [factId, created] = await store.graph.insert_value_fact(
          state.sql,
          doc.kb_id,
          subjectId,
          null,
          { value: literal },
          validity,
          confidence,
        );
        await store.graph.add_evidence(state.sql, factId, chunk.id, f.quote ?? null, f.predicate);
        if (created) {
          factCount += 1;
        }
        continue;
      }

      // Relation fact: the object is required.
      const objectName = f.object?.trim();
      if (!objectName) {
        await dropSignal(
          state,
          doc.kb_id,
          documentId,
          store.extractionDrops.reason.OBJECT_MISSING,
          f.predicate,
          f.subject.trim(),
        );
        continue;
      }
      // **Undeclared subject and object go through the same test too.**
      //
      // This guard used to sit only on the path that declares an entity;
      // this path bypassed it — the model writes a whole sentence into
      // `object`, that sentence never appears in `entities`, and this
      // path then turned around and created it as an entity. Measured
      // (ai-timeline-ends × schema.org): 76 of 421 entities had no type,
      // the longest 111 characters — "thermal-imaging equipment used by
      // volunteers flying over the site showed at least 33 generators
      // giving off heat" — a whole clause, not a thing. **The guard
      // blocked the front door; the back door was open.**
      //
      // These entities cause more damage than that: they never match a
      // mention anywhere else, sit as isolated points on the graph
      // (measured: 59 of them), and drag down resolution — every one of
      // them gets compared against every existing entity.
      if (!isEntityName(f.subject.trim()) || !isEntityName(objectName)) {
        await dropSignal(
          state,
          doc.kb_id,
          documentId,
          store.extractionDrops.reason.NOT_AN_ENTITY_NAME,
          f.predicate,
          isEntityName(f.subject.trim()) ? objectName : f.subject.trim(),
        );
        continue;
      }

      // Create the subject/object first if not already declared in
      // entities (the model occasionally forgets to report one). With no
      // entities row there is no type to go on, so it is left unset —
      // before decision 0009 this could only fall back to `concept`.
      let subjectId = entityIds.get(f.subject.trim());
      if (subjectId === undefined) {
        subjectId = await resolveEntity(
          state,
          doc.kb_id,
          null,
          f.subject.trim(),
          ctx,
          docCache,
          needsAdjudication,
        );
      }
      let objectId = entityIds.get(objectName);
      if (objectId === undefined) {
        objectId = await resolveEntity(state, doc.kb_id, null, objectName, ctx, docCache, needsAdjudication);
      }
      if (subjectId === objectId) {
        continue;
      }
      // Land on an existing ontology relation whenever possible (wording,
      // tense, passive voice); only downgrade when it cannot land, and
      // record the miss statistics. Downgrading flattens the original
      // meaning into "is related to" — the original wording, written into
      // the evidence's `proposed_predicate`, is the only place that keeps
      // it (predicate resolution maps it back onto the ontology from
      // there).
      let predicateId: Uuid | null;
      let swap: boolean;
      const hit = predIndex.lookup(f.predicate);
      if (hit) {
        [predicateId, swap] = hit;
      } else {
        await store.ontology
          .record_miss(state.sql, doc.kb_id, "relation_type", f.predicate, `${f.subject} → ${objectName}`)
          .catch(() => {});
        // No matching relation in the ontology -> **there simply is no
        // predicate** (see `facts.predicate_id`). The original wording
        // lives on in the evidence's `proposed_predicate`, recovered for
        // display. This used to fall back to `related_to`, which also
        // meant worrying about "what if the fallback relation gets
        // deleted" — that whole failure mode, and its `continue`, is
        // gone now.
        predicateId = null;
        swap = false;
      }
      // A passive wording hits the same edge in reverse: "ChatGPT
      // produced_by OpenAI" and "OpenAI produces ChatGPT" are the same
      // edge, and must be stored following the ontology's direction, or
      // it ends up as a second, opposite-pointing edge next to the 130
      // existing `produces` edges.
      let sId = swap ? objectId : subjectId;
      let oId = swap ? subjectId : objectId;

      // **When the subject violates the domain and the object satisfies
      // it, flip them to match the ontology's declared direction.**
      //
      // Prompting was tried first, across three rounds, without success:
      // the violation rate dropped from 57% to 35%, but the drop was
      // entirely type misclassifications being fixed — the **true
      // reversed cases barely moved** (22.7% -> 17.1% -> 17.6%, the last
      // two within noise). The model can see `employee (organization ->
      // person)` and still not follow it; English's "X is an employee of
      // Y" pulls too strongly the other way.
      //
      // This is not a new principle: a passive wording that hits
      // `produces` via `produced_by` (see `swap` above) already flips
      // subject and object automatically — the only difference is the
      // trigger being the wording versus the signature.
      //
      // **This must never happen silently.** A signal is always
      // recorded: decision 0001 objects to acting on a possibly-wrong
      // declaration without telling anyone; a visible, reviewable,
      // reversible action is not that.
      if (predicateId) {
        const sFits = await store.ontology.entity_fits_domain(state.sql, predicateId, sId).catch(() => null);
        if (sFits === false) {
          const oFits = await store.ontology.entity_fits_domain(state.sql, predicateId, oId).catch(() => null);
          if (oFits === true) {
            await dropSignal(
              state,
              doc.kb_id,
              documentId,
              store.extractionDrops.reason.DIRECTION_CORRECTED,
              f.predicate,
              `${f.subject} → ${f.object ?? "?"} corrected by signature to ${f.object ?? "?"} → ${f.subject}`,
            );
            const swapped = sId;
            sId = oId;
            oId = swapped;
          } else {
            // **Swapping is not valid either -> fall back to no
            // predicate.**
            //
            // This is not a direction problem; the relation simply does
            // not apply here: schema.org's `affectedBy` is for medical
            // tests, and the model reaches for it by name when it means
            // "affected by" in the ordinary sense; `amount` belongs on a
            // funding instrument, not a company, and the model attaches
            // it to the company because it never created that
            // intermediate node.
            //
            // Storing it as-is used to mean **using the ontology's name
            // to assert something the ontology does not agree with** —
            // the graph would say "OpenAI affectedBy …" and a reader
            // would take that as a medical claim. That is a confident
            // mistake, far worse than an empty predicate.
            //
            // Falling back to an empty predicate loses nothing: the
            // original wording lands in `fact_evidence.proposed_predicate`,
            // recovered for display by `fact_surface_predicate()`
            // (decision 0010). Subject, object, time, and evidence all
            // stay — the fact just no longer claims an ontology relation
            // it does not fit. **An honest silence.**
            await dropSignal(
              state,
              doc.kb_id,
              documentId,
              store.extractionDrops.reason.DOMAIN_MISMATCH,
              f.predicate,
              `${f.subject} — ${f.predicate} → neither side fits; reverted to the original wording`,
            );
            predicateId = null;
          }
        }
      }

      {
        const [factId, created] = await store.graph.insert_fact(
          state.sql,
          doc.kb_id,
          sId,
          predicateId,
          oId,
          validity,
          confidence,
        );
        // A repeated observation still gets evidence: several sources
        // corroborate one fact, and deleting any one source does not
        // orphan it. The surface predicate is recorded per observation —
        // chunk A says "runs on", chunk B says "optimized for"; they
        // merge into the same fact (first writer wins there), but both
        // wordings stay on the evidence.
        await store.graph.add_evidence(state.sql, factId, chunk.id, f.quote ?? null, f.predicate);
        if (!created) {
          continue;
        }
        factCount += 1;
        // Time reconciliation: a newly landed state relation under a
        // uniqueness constraint is checked for a contradiction right
        // away (a rule-based point check; an automatic close works by
        // invalidate-and-rewrite, and an unclear case goes to
        // `fact_conflicts` for a human).
        //
        // No predicate means no relation metadata, so no time
        // reconciliation either — an edge whose relation is unknown
        // cannot carry a uniqueness constraint in the first place.
        const meta = predicateId ? relMeta.get(predicateId) : undefined;
        if (meta && meta[2] === "state") {
          const [func, invFunc] = meta;
          const directions: ("SubjectSide" | "ObjectSide")[] = [];
          if (func) directions.push("SubjectSide");
          if (invFunc) directions.push("ObjectSide");
          for (const dir of directions) {
            const report = await store.temporal.reconcileNewFact(
              state.sql,
              doc.kb_id,
              factId,
              sId,
              predicateId!,
              oId,
              null,
              dir,
              validity,
              confidence,
            );
            if (report.conflicts > 0) {
              conflictsFound = true;
            }
          }
        }
      }
    }

    // Mark this chunk done as soon as it finishes: an adopted chunk
    // carries the flag forward on the next re-extraction, and an
    // interrupted extraction can resume (chunks whose LLM call or parse
    // failed hit `continue` above and stay unmarked, so a retry picks
    // them up again).
    await store.documents.markChunkExtracted(state.sql, chunk.id);
  }

  // Disambiguator suffixes are computed at entity-creation time, which can
  // run before its facts are written; refresh once, at the end, for every
  // name touched in this document.
  const names = new Set<string>();
  for (const key of docCache.keys()) {
    names.add(key.slice(key.indexOf("\u0000") + 1));
  }
  for (const name of names) {
    await store.resolution.refresh_disambiguators(state.sql, doc.kb_id, name);
  }

  // Check ownership once more on the way out: a takeover can happen after
  // the last chunk, once the loop's own checks have already run. Missing
  // this check would let a superseded task write `done` on a document
  // whose `extracted_at` flags were just cleared — the UI would say
  // "done" while nothing was actually extracted, until the new task ran
  // and corrected it.
  if ((await store.documents.extractEpoch(state.sql, documentId)) !== myEpoch) {
    log.info("extraction task was superseded by a newer round; exiting at cleanup", {
      document_id: documentId,
    });
    return;
  }

  // **A document with any failed chunk must not be marked done.**
  //
  // This used to write `done` unconditionally: one network blip once left
  // six documents with only 12 of 60 chunks extracted, all six shown as
  // "extraction complete", with 80% of the content missing from the graph
  // and nothing on screen saying so. The failure only reached the log,
  // and an error that only reaches the log is the same as no error.
  //
  // Throwing here completes the chain: `extractDocument` writes
  // `graph_failed` plus the reason, the UI shows that document as failed
  // (clickable to see the error), the task retries with a 30s×attempts²
  // backoff, and chunks that already succeeded (carrying `extracted_at`)
  // are skipped — so a retry is cheap, and the document heals itself once
  // the network recovers. Staying failed after retries run out means the
  // status is finally telling the truth.
  const incomplete = incompleteReason(unextracted, chunks.length);
  if (incomplete !== null) {
    throw new Error(incomplete);
  }
  await store.documents.setGraphStatus(state.sql, documentId, "done");
  state.emitDocument(doc.kb_id, documentId);

  // Gray-zone pairs landed in the review queue -> trigger the batched
  // adjudication job (runs independently in the background; extraction
  // itself is done here).
  if (needsAdjudication.value) {
    await store.jobs.enqueue(state.sql, "adjudicate_entities", { kb_id: doc.kb_id });
  }
  if (needsAdjudication.value || conflictsFound) {
    state.emitReview(doc.kb_id);
  }
  // Automatic ontology extension: fires when the switch is on and this
  // whole batch has finished, triggered by whichever document finishes
  // last. The test is an explicit switch, not "has the ontology been
  // touched" — the latter infers intent from behavior, and a wrong
  // inference here is absurd (clicking Add once on a proposal would
  // permanently turn off suggestions), and once false it never turns true
  // again, freezing the ontology at whatever vocabulary the first batch
  // of documents happened to contain. Concurrent runs may enqueue this
  // twice; the task itself re-checks the switch and the state.
  await enqueueBootstrap(state, doc.kb_id);

  log.info("graph extraction complete", { document_id: documentId, facts: factCount });
}

/**
 * Whether the thing in the object position is a literal, not the name of
 * an entity.
 *
 * **Only numbers and dates count.** A wrong "yes" here eats a real
 * entity, so this test would rather miss than misfire: missing just
 * keeps today's behavior (create a `concept` entity); misfiring demotes
 * a real entity down to a piece of text, and the graph loses a node.
 *
 * "2015", "2023-03", "6" count; "Hangzhou", "chief technology officer",
 * "3M", "V3" do not. The caller additionally requires the model to **not**
 * have declared it an entity — both gates must pass.
 */
function looksLiteral(s: string): boolean {
  const trimmed = s.trim();
  if (trimmed === "") {
    return false;
  }
  // A bare number (decimals and signs included). Parsed as a float, not
  // scanned character by character: "3M", "V3", and full-width "２０１５"
  // all fail this test, exactly as intended.
  if (trimmed !== "" && Number.isFinite(Number(trimmed)) && /^[+-]?[\d.]+$/.test(trimmed)) {
    return true;
  }
  // A date: reuses the extraction-side parser, which accepts 2015 /
  // 2015-03 / 2015-03-01 and similar.
  return extract.parseTime(trimmed) !== null;
}

/**
 * The three lists that go into the prompt: types, relations, attributes.
 *
 * **Factored out so "give everything" and "retrieve per chunk" share the
 * same layout logic.** Two separately maintained layouts would eventually
 * drift, and drifting here means the prompt says one thing while the code
 * believes another.
 */
type PromptLists = {
  types: [string, string, string][];
  relations: extract.PromptRelation[];
  attributes: string[];
};

/**
 * How long these three lists would lay out in the prompt. The budget test
 * uses this — it measures the **actual text that would be laid out**, not
 * a separate estimate formula that would drift from the layout.
 */
function promptListsChars(lists: PromptLists): number {
  let total = 0;
  for (const [k, l, d] of lists.types) total += k.length + l.length + d.length + 6;
  for (const r of lists.relations) total += r.key.length + r.label.length + r.description.length + r.signature.length + 8;
  for (const a of lists.attributes) total += a.length + 1;
  return total;
}

/**
 * Lays out the three lists from a **selection set**. `null` means "give
 * everything" (the old path, used when the ontology fits the budget).
 *
 * Three details only matter when a selection is in play; "give
 * everything" never triggers them:
 *
 * 1. **A signature may only mention selected classes.** `works_at
 *    (person → organization)` — both keys there must be classes the
 *    model can see; naming a class that was never laid out teaches it to
 *    output a nonexistent type. When neither side is selected, fall back
 *    to `*`.
 * 2. **Attributes follow their domain.** An attribute line is
 *    `class.attr`; if its class was not laid out, the line is
 *    meaningless. This also handles trimming the attribute section
 *    (28% of the prompt) without separate logic.
 * 3. **Built-in classes are always present.** A chunk retrieval misses
 *    still needs somewhere for the model to land an entity.
 */
function buildLists(
  etypes: EntityType[],
  rtypes: RelationType[],
  classes: Set<Uuid> | null,
  rels: Set<Uuid> | null,
): PromptLists {
  const pickedClass = (id: Uuid): boolean => classes === null || classes.has(id);
  const pickedRel = (id: Uuid): boolean => rels === null || rels.has(id);
  const keyOf = new Map<Uuid, string>(etypes.filter((t) => pickedClass(t.id)).map((t) => [t.id, t.key]));

  const types: [string, string, string][] = etypes
    .filter((t) => pickedClass(t.id))
    .map((t) => [t.key, t.label, t.description]);

  // When one side has no laid-out classes at all, write `*`: a signature
  // is a hint, and pointing at an invisible class only misleads.
  const sigOf = (ids: Uuid[]): string => {
    const keys = ids.map((id) => keyOf.get(id)).filter((k): k is string => k != null);
    if (keys.length === 0) return "*";
    keys.sort();
    return keys.join("|");
  };
  const relations: extract.PromptRelation[] = rtypes
    .filter((r) => r.kind !== "attribute")
    .filter((r) => pickedRel(r.id))
    .map((r) => {
      const signature =
        r.domains.length === 0 && r.ranges.length === 0 ? "" : `${sigOf(r.domains)} → ${sigOf(r.ranges)}`;
      return { key: r.key, label: r.label, description: r.description, signature };
    });

  const attributes: string[] = [];
  for (const r of rtypes) {
    if (r.kind !== "attribute" || !pickedRel(r.id)) continue;
    for (const domainId of r.domains) {
      const classKey = keyOf.get(domainId);
      if (classKey === undefined) continue;
      const dt = r.datatype ?? "text";
      const spec = r.unit ? `${dt}, ${r.unit}` : dt;
      const d = r.description.trim();
      attributes.push(d === "" ? `- ${classKey}.${r.key} (${spec})` : `- ${classKey}.${r.key} (${spec}): ${d}`);
    }
  }

  return { types, relations, attributes };
}

/** How many classes / relations / attributes to retrieve per chunk. **Untested** — like the budget, tuning this needs a curve. */
const PER_CHUNK_CLASSES = 40;
const PER_CHUNK_RELATIONS = 30;
const PER_CHUNK_ATTRIBUTES = 30;

/**
 * Retrieves candidates by this chunk's vector, and lays out its own three
 * lists.
 *
 * Returns `null` on a retrieval failure rather than throwing: the caller
 * falls back to the full list. A large prompt is slow; no classes to
 * choose from means nothing gets extracted — the choice favors the
 * former.
 */
async function chunkLists(
  state: AppState,
  kbId: Uuid,
  embedding: number[],
  etypes: EntityType[],
  rtypes: RelationType[],
  seedClasses: Set<Uuid>,
): Promise<PromptLists | null> {
  const classes = new Set<Uuid>(seedClasses);
  const nearestClasses = await store.ontology.nearest_entity_type_ids(
    state.sql,
    kbId,
    embedding,
    PER_CHUNK_CLASSES,
  );
  for (const id of nearestClasses) classes.add(id);

  // **Whatever gets hit, its ancestors get laid out too.**
  //
  // Vector retrieval naturally favors leaf classes that appear literally
  // in the text. Measured on a chunk about Sutskever, out of 976 classes
  // ranked by distance: `researcher` ranked 4th, `corporation` 27th,
  // while `organization` ranked 177th and `person` 359th — **not one
  // generalized base class made the top 40.** The text writes "a
  // researcher at", "the corporation"; it never writes "person".
  //
  // Two symptoms, one root cause:
  //
  // - An entity gets classified as `researcher` (a subclass of
  //   `Audience` on schema.org, not a person), so every `works_for`
  //   (domain=person) fact on it becomes a violation.
  // - `employee (organization → person)`'s signature **degrades to `(* →
  //   *)`** — `sigOf` only counts laid-out classes, and one side not laid
  //   out writes `*`. The model never even sees that direction
  //   constraint.
  //
  // This floor used to be `seedClasses` (the `builtin` classes), and
  // `buildLists`'s comment said "built-in classes are always present: a
  // chunk retrieval misses still needs somewhere to land". The floor went
  // hollow once the seed step was retired (#128) — it only happened to
  // work because the seed classes were exactly those general-purpose
  // classes.
  //
  // Ancestors make a better floor than a hand-maintained "common
  // classes" list: **the inheritance chain is already the ontology's own
  // declared generalization** — who generalizes whom is not something we
  // need to judge again. The cost is a few extra ancestor levels laid out
  // per chunk.
  if (classes.size > 0) {
    const picked = [...classes];
    const ancestors = await store.ontology.ancestors_of(state.sql, picked);
    for (const id of ancestors) classes.add(id);
  }
  const rels = new Set<Uuid>();
  // Relations and attributes are retrieved separately: the two sections
  // are laid out separately in the prompt, and retrieving them together
  // would let one crowd out the other.
  const nearestRels = await store.ontology.nearest_relation_type_ids(
    state.sql,
    kbId,
    embedding,
    PER_CHUNK_RELATIONS,
    "relation",
  );
  for (const id of nearestRels) rels.add(id);
  const nearestAttrs = await store.ontology.nearest_relation_type_ids(
    state.sql,
    kbId,
    embedding,
    PER_CHUNK_ATTRIBUTES,
    "attribute",
  );
  for (const id of nearestAttrs) rels.add(id);

  // **Once a relation is laid out, the classes named in its signature
  // must be laid out too.**
  //
  // Classes and relations are retrieved independently, and a signature
  // depends on the intersection of the two — `sigOf` only counts laid-out
  // classes, and a side that was not laid out writes `*`. This often
  // produces a case like: `employee` gets pulled in because it reads
  // close to the text, while its `organization` (ranked 795th) and
  // `person` (ranked 630th) read far from the text and neither gets
  // pulled in, so the signature degrades to `(* → *)` — **the direction
  // constraint disappears entirely**, and the model follows English
  // instinct and writes `Musk --employee--> Microsoft`, when schema.org
  // declares organization → person.
  //
  // The ancestor floor above cannot fix this case: it grows upward from
  // "hit leaves", and here no relevant leaf was hit at all, so there are
  // no ancestors to grow from.
  //
  // `sigOf`'s comment says "pointing at an invisible class only
  // misleads" — that concern is real, but erasing the signature trades
  // away direction to avoid it. **Pulling the class in** keeps both: the
  // model can see the class, and the signature can be laid out. It is
  // also the right call for another reason: these are exactly the
  // classes the model is about to use to judge types — `employee` being
  // present already says this chunk is about employment, so
  // `organization`/`person` belong in the candidates regardless — plain
  // text similarity cannot find them, but **the ontology's structure
  // knows**.
  const sigClasses = new Set<Uuid>();
  for (const r of rtypes) {
    if (!rels.has(r.id)) continue;
    for (const d of r.domains) sigClasses.add(d);
    for (const rg of r.ranges) sigClasses.add(rg);
  }
  for (const id of sigClasses) classes.add(id);

  // No candidate retrieved at all = the index is not built yet; fall back
  // to the full list rather than an empty one.
  if (classes.size <= seedClasses.size && rels.size === 0) {
    return null;
  }
  return buildLists(etypes, rtypes, classes, rels);
}

function formatYmd(d: Date): string {
  const y = d.getUTCFullYear().toString().padStart(4, "0");
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Entity resolution v2. The same name does not mean the same person. See
 * DESIGN.md section 4, "Entity resolution v2", for the full design.
 *
 * Funnel: recall name candidates first (this step is free, and includes
 * generic-suffix stem cross-recall). Then rank candidates by profile-vector
 * similarity (this step is fast; it reuses the chunk embedding computed at
 * ingest time). Gray-zone cases create a new entity, plus a
 * suspected-duplicate review item (the system splits rather than merges
 * when unsure). LLM batch adjudication runs in a separate background job.
 * Manual review is the final backstop. The LLM never sits on the critical
 * path of an extraction write.
 *
 * Type drift: when the same name under the same type has no candidate, the
 * function also looks under other types. The same team getting extracted
 * as organization, project, or concept in different documents is normal.
 * The function routes by how strongly a type pair excludes each other: a
 * fallback type (no type decided yet) counts as a recall candidate and
 * goes through profile-vector ranking; confusable concrete types still
 * create a new entity but also queue a review pair; hard-exclusive types
 * (person vs organization) stay fully separate.
 */

import { q, qOne, qOpt, exec, type Sql } from "../core/db";
import { AppError } from "../core/errors";
import { newId, type Uuid } from "../core/ids";
import { log } from "../core/log";
import { reconcileMovedFacts } from "./temporal";

/**
 * Context similarity thresholds. These are empirical cosine-similarity
 * values for bge-m3-class models; they may need tuning later.
 * A score at or above ATTACH merges the mention into an existing entity.
 * A score below NEW marks it as a different entity. The gray zone in
 * between splits rather than merges, and queues a review item.
 */
export const SIM_ATTACH = 0.55;
export const SIM_NEW = 0.35;

/**
 * Normalize a name: map full-width ASCII to half-width, map a full-width
 * space to a half-width space, and collapse repeated whitespace.
 * The result keeps the original letter case. Every lookup still applies
 * SQL lower() on top of this.
 */
export function normalize_name(raw: string): string {
  let mapped = "";
  for (const c of raw) {
    if (c === "\u3000") {
      mapped += " ";
      continue;
    }
    const code = c.codePointAt(0) ?? 0;
    if (code >= 0xff01 && code <= 0xff5e) {
      mapped += String.fromCodePoint(code - 0xfee0);
    } else {
      mapped += c;
    }
  }
  return mapped
    .split(/\s+/)
    .filter((s) => s.length > 0)
    .join(" ");
}

/**
 * Generic-suffix word list. A Chinese suffix attaches directly after the
 * stem. An English suffix counts as a separate word, and both word orders
 * are accepted ("Phoenix Project" and "Project Phoenix"). This list only
 * affects recall. The merge decision still goes through profile
 * similarity.
 */
const GENERIC_SUFFIXES_CJK = ["项目", "公司", "集团", "部门", "团队"];
const GENERIC_WORDS_EN = ["project", "corp", "inc", "team"];

/**
 * Compute the stem: the lowercase form of a name with one generic suffix
 * removed. Returns null when no suffix matches, when removing the suffix
 * leaves nothing, or when the stem itself is a generic word (for example
 * "project team"). The input should already be normalized by
 * normalize_name.
 */
export function name_stem(name: string): string | null {
  const lower = name.toLowerCase();
  const strip_punct = (w: string) => w.replace(/[.,]+$/, "");
  const generic = (s: string) => GENERIC_SUFFIXES_CJK.includes(s) || GENERIC_WORDS_EN.includes(strip_punct(s));

  for (const suf of GENERIC_SUFFIXES_CJK) {
    if (lower.endsWith(suf)) {
      const stem = lower.slice(0, lower.length - suf.length).trimEnd();
      if (stem.length > 0 && !generic(stem)) {
        return stem;
      }
    }
  }
  const words = lower.split(" ");
  if (words.length >= 2) {
    if (generic(words[words.length - 1])) {
      const stem = words.slice(0, -1).join(" ");
      if (!generic(stem)) {
        return stem;
      }
    }
    if (generic(words[0])) {
      const stem = words.slice(1).join(" ");
      if (!generic(stem)) {
        return stem;
      }
    }
  }
  return null;
}

/**
 * Compute the recall key set for a mention. It is all lowercase: the raw
 * name, the stem, and the stem widened with each generic suffix.
 * The widening covers the reverse direction (the store holds "Stardust
 * Project", but the mention only says "Stardust"). If the stem contains a
 * CJK character, the function widens it with a Chinese suffix; otherwise
 * it widens with an English word, in both word orders. The key count stays
 * at 10 or fewer, and each lookup does a multi-value index scan on
 * (kb, type, lower(name)).
 */
export function recall_keys(name: string): string[] {
  const lower = name.toLowerCase();
  const base = name_stem(name) ?? lower;
  const keys: string[] = [lower];
  const add = (k: string) => {
    if (!keys.includes(k)) {
      keys.push(k);
    }
  };
  add(base);
  const has_cjk = [...base].some((c) => {
    const code = c.codePointAt(0) ?? 0;
    return code >= 0x4e00 && code <= 0x9fff;
  });
  if (has_cjk) {
    for (const suf of GENERIC_SUFFIXES_CJK) {
      add(`${base}${suf}`);
    }
  } else {
    for (const w of GENERIC_WORDS_EN) {
      add(`${base} ${w}`);
      add(`${w} ${base}`);
    }
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Type drift: an entity with one name gets extracted under different types
// ("Orion platform team" as organization in one document, project in
// another).
// ---------------------------------------------------------------------------

/**
 * Confusable concrete types. Extraction commonly wavers among these (is a
 * team an organization or a project? is a platform a project or a
 * product?). The same name across this group of types still creates a
 * separate entity (split rather than merge), but the pair is queued for
 * LLM or human review.
 *
 * This table should come from the ontology, and today it does not. The
 * ontology already stores `owl:disjointWith` (in `entity_type_disjoint`,
 * both importable and editable), but the only consumer today is the
 * reasoner's own ontology self-check. Resolution still checks these three
 * hard-coded keys. In a KB with no imported vocabulary, these three keys do
 * not exist, so this tier never fires, and every cross-type same-name case
 * falls through as Disjoint. That direction only makes the check stricter,
 * never looser, so it cannot cause a wrong merge. Reading this from the
 * ontology instead is tracked as decision 0016, item B3.
 */
export const CONFUSABLE_TYPE_KEYS = ["organization", "project", "product"];

/** The maximum number of drift review pairs queued in one resolution call. This limit stops a large same-name group from flooding the review queue. */
const MAX_DRIFT_REVIEWS = 4;

/** How a cross-type same-name pair is handled. */
type TypeDrift = "Recall" | "Review" | "Disjoint";

function classify_type_drift(a: string | null, b: string | null): TypeDrift {
  // Two types can, of course, be the same thing.
  //
  // This tier did not exist at first, because this function was built only
  // to serve "type drift": the same name extracted under two types, a case
  // where the two types are never equal. Later, containment_reviews reused
  // this function as a compatibility check, and there, two equal types are
  // the common case. Because of that, person-to-person fell through to the
  // last branch, Disjoint, and got read as "these can never be the same
  // thing".
  //
  // The cost showed up in the clearest coreference pair in a whole
  // document: across the first six Sherlock Holmes stories, "Sherlock
  // Holmes" and "Holmes" are two separate entities, and out of 488
  // entities, only 14 got merged. The 12 existing unit tests all covered
  // cross-type cases, and none covered the same-type case.
  if (a === b) {
    return "Recall";
  }
  // One side has no type decided yet: treat it as a recall candidate, and
  // let profile-vector ranking decide.
  //
  // This used to compare against the key `FALLBACK_TYPE_KEY`, which no
  // longer exists. "Not decided yet" is now represented by `null` (see
  // decision 0009). The case where both sides are null is already caught
  // by the `a === b` check above.
  if (a === null || b === null) {
    return "Recall";
  }
  if (CONFUSABLE_TYPE_KEYS.includes(a) && CONFUSABLE_TYPE_KEYS.includes(b)) {
    return "Review";
  }
  return "Disjoint";
}

function cosine(a: number[], b: number[]): number | null {
  if (a.length !== b.length || a.length === 0) {
    return null;
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) {
    return null;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Parse a pgvector text value ("[0.1,0.2,0.3]") into a plain number array. Returns null when the column is null. */
function parse_vector(v: string | null): number[] | null {
  if (v === null) {
    return null;
  }
  const inner = v.slice(1, -1).trim();
  if (inner.length === 0) {
    return [];
  }
  return inner.split(",").map((x) => Number(x));
}

/** Serialize a number array into pgvector text form for a query parameter. */
function vector_param(v: number[]): string {
  return `[${v.join(",")}]`;
}

interface Candidate {
  id: Uuid;
  profile_embedding: number[] | null;
  profile_n: number;
  degree: number;
}

/**
 * A resolution result: the entity the mention landed on, plus any
 * suspected-duplicate pairs to queue. The caller writes these into the
 * review queue and triggers the adjudication job.
 */
export interface Resolution {
  entity_id: Uuid;
  created: boolean;
  reviews: ReviewRequest[];
}

/** A review pair to queue: `Resolution.entity_id` versus `other_id`. */
export interface ReviewRequest {
  other_id: Uuid;
  score: number;
  reason: string;
}

/**
 * Resolve a single mention. `context` is the vector of the chunk the
 * mention appears in (null when there is no embedding model; that
 * degrades to v1 behavior: the same name merges into the candidate with
 * the most facts).
 */
export async function resolve_mention(
  sql: Sql,
  kb_id: Uuid,
  // null = the extractor's type is not in the ontology, or the KB has no
  // types at all (decision 0009).
  type_id: Uuid | null,
  raw_name: string,
  context: number[] | null,
): Promise<Resolution> {
  const name = normalize_name(raw_name);
  // Recall keys = the raw name plus the generic-suffix stem and its
  // widened forms ("Stardust" and "Stardust Project" recall each other).
  // This only widens recall. The merge decision still comes from
  // profile-vector ranking below.
  const keys = recall_keys(name);
  const candidate_rows = await q<{
    id: Uuid;
    profile_embedding: string | null;
    profile_n: number;
    degree: number | string;
  }>(
    sql,
    `SELECT e.id, e.profile_embedding, e.profile_n,
            (SELECT count(*) FROM facts f
             WHERE (f.subject_id = e.id OR f.object_id = e.id)
               AND f.invalidated_at IS NULL) AS degree
     FROM entities e
     WHERE e.kb_id = $1 AND e.type_id = $2 AND e.merged_into IS NULL
       AND (lower(e.canonical_name) = ANY($3)
            OR EXISTS (SELECT 1 FROM unnest(e.aliases) a WHERE lower(a) = ANY($3)))`,
    [kb_id, type_id, keys],
  );
  const candidates: Candidate[] = candidate_rows.map((r) => ({
    id: r.id,
    profile_embedding: parse_vector(r.profile_embedding),
    profile_n: r.profile_n,
    degree: Number(r.degree),
  }));

  if (candidates.length === 0) {
    // No candidate under the same type does not mean a new name: a type
    // label can drift (the same team gets extracted as organization,
    // project, or concept). Look under other types first, and route by
    // how strongly the type pair excludes each other.
    return resolve_type_drift(sql, kb_id, type_id, name, keys, context);
  }

  if (context === null) {
    // No vector to compare: fall back to v1 behavior. Merge into the
    // same-name candidate with the most facts.
    let best = candidates[0];
    for (const c of candidates) {
      if (c.degree > best.degree) {
        best = c;
      }
    }
    await touch_entity(sql, best.id);
    return { entity_id: best.id, created: false, reviews: [] };
  }
  const ctx = context;

  // Score every candidate that has a profile. Track candidates without a
  // profile (historical data, or created before embeddings existed)
  // separately.
  let best_scored: [Candidate, number] | null = null;
  let unprofiled: Candidate | null = null;
  for (const c of candidates) {
    const sim = c.profile_embedding !== null ? cosine(c.profile_embedding, ctx) : null;
    if (sim !== null) {
      if (best_scored === null || sim > best_scored[1]) {
        best_scored = [c, sim];
      }
    } else {
      if (unprofiled === null || c.degree > unprofiled.degree) {
        unprofiled = c;
      }
    }
  }

  if (best_scored !== null) {
    const [best, sim] = best_scored;
    if (sim >= SIM_ATTACH) {
      await update_profile(sql, best.id, best.profile_n, ctx);
      return { entity_id: best.id, created: false, reviews: [] };
    }
  }
  if (unprofiled !== null) {
    // A candidate with no profile gives no way to judge: fall back to v1
    // behavior and merge into it, then seed its profile from this
    // context.
    await update_profile(sql, unprofiled.id, unprofiled.profile_n, ctx);
    return { entity_id: unprofiled.id, created: false, reviews: [] };
  }

  // Every candidate has a profile, and the best score is still below
  // ATTACH: create a new entity (same name, different person).
  const id = await create_entity(sql, kb_id, type_id, name, context);
  await refresh_disambiguators(sql, kb_id, name);
  const reviews: ReviewRequest[] = [];
  if (best_scored !== null && best_scored[1] >= SIM_NEW) {
    const [c, sim] = best_scored;
    reviews.push({ other_id: c.id, score: sim, reason: `ambiguous_name|${sim.toFixed(2)}` });
  }
  // Existing entities whose names contain each other: equality-based
  // recall cannot see them (prefixes cannot be fully enumerated), so a
  // short form silently becomes a second entity. Only queue them; never
  // merge.
  reviews.push(...(await containment_reviews(sql, kb_id, type_id, name, id, context)));
  return { entity_id: id, created: true, reviews };
}

/** The shortest edge a containment-pair candidate may use: the shorter of the two names must be at least this long. Below it, most matches are generic words like "institute" or "center"; pairing on them adds no information and only floods the queue. */
const MIN_CONTAIN_CHARS = 4;

/** The maximum number of containment review pairs produced in one call. Same reasoning as MAX_DRIFT_REVIEWS: a generic name can be contained in dozens of entities, and queuing all of them would flood the queue. */
const MAX_CONTAIN_REVIEWS = 4;

/** Fetch a few extra rows on the SQL side. Hard-exclusive types can only be filtered out on the JS side, and taking only 4 rows risks all 4 being excluded types, cutting off the one real pair before the filter even runs. */
const CONTAIN_SCAN_LIMIT = 16;

/**
 * After creating a new entity, find existing entities whose names contain
 * each other, as review candidates.
 *
 * Chinese business text often shortens a full name to an abbreviation
 * within the same document ("Nebula Tech Shanghai Institute" to "Shanghai
 * Institute"). recall_keys does an equality lookup: it only catches the
 * reverse direction by enumerating generic suffixes, but the prefix can be
 * any organization name, and that cannot be fully enumerated. So all three
 * of these cases slip through, and silently become a second entity:
 *
 * ```text
 * Shanghai Institute        contained in   Nebula Tech Shanghai Institute   (suffix narrowed)
 * Vega X7 accelerator card  ~ similar to   Vega X7 inference accelerator    (a word inserted in the middle; LIKE cannot cover this, see below)
 * Deep Sea                  contained in   Deep Sea distributed inference platform 2.0   (prefix extended)
 * ```
 *
 * This function only produces candidates. It never merges automatically.
 * The same-name path merges automatically once similarity reaches
 * SIM_ATTACH; the containment path must never take it. "Nova Group
 * Technology Center" and "Halcyon Tech Technology Center" both contain
 * "Technology Center", and within one document their context similarity
 * easily crosses that line, yet they are two different departments. Split
 * rather than merge.
 *
 * Aliases take part in the search too. A merge moves a name into
 * `aliases`; searching only `canonical_name` would lose one recall bridge
 * per successful merge. After "Holmes" merges into "Sherlock Holmes", a
 * later mention of "Mr. Holmes" can no longer connect to either, because
 * neither name contains the other. The more successful the merges, the
 * more bridges are lost. This gap grows on its own.
 *
 * Known gap: two names that neither contain each other nor share an alias
 * bridge ("Vega X7 accelerator card" and "Vega X7 inference accelerator
 * card") are not covered. Covering that needs trigram similarity, and
 * `CREATE EXTENSION pg_trgm` needs superuser privilege; this database
 * connects with a restricted role (see
 * `migrations/0010_least_privilege_role.sql`), so installing the extension
 * would fail at deploy time. Left for when it is actually needed.
 *
 * Performance: neither the reverse half (a new name containing an old
 * name) nor the alias half can use an index, so this query narrows the row
 * set by `kb_id`, caps it with a limit, and runs only once per new entity,
 * not once per mention. If that is not enough at large scale, the right
 * fix is a "suffix key" table with an equality lookup, not a fuzzy index.
 */
async function containment_reviews(
  sql: Sql,
  kb_id: Uuid,
  // null = the extractor's type is not in the ontology, or the KB has no
  // types at all (decision 0009).
  type_id: Uuid | null,
  name: string,
  new_id: Uuid,
  ctx: number[] | null,
): Promise<ReviewRequest[]> {
  const lower = name.toLowerCase();
  if ([...lower].length < MIN_CONTAIN_CHARS) {
    return [];
  }
  // The entity may not have a type decided yet (decision 0009); then
  // there is no key to look up.
  let mention_key: string | null = null;
  if (type_id !== null) {
    const row = await qOpt<{ key: string }>(sql, `SELECT key FROM entity_types WHERE id = $1`, [type_id]);
    mention_key = row?.key ?? null;
  }
  // Do not filter by type: a short form often falls into the concept
  // fallback while the full name has a concrete type (observed in
  // practice: "Shanghai Institute" to concept versus "Nebula Tech
  // Shanghai Institute" to organization; "Vega X7 accelerator card" to
  // concept versus "Vega X7 inference accelerator card" to product).
  // Filtering by equal type would catch neither pair. Compatibility is
  // left to classify_type_drift below. Fetch extra rows, because
  // hard-exclusive types get filtered out on the JS side. The third
  // column can be null: an untyped entity must still take part in the
  // containment scan (decision 0009).
  const rows = await q<{
    id: Uuid;
    canonical_name: string;
    key: string | null;
    profile_embedding: string | null;
  }>(
    sql,
    `SELECT e.id, e.canonical_name, t.key, e.profile_embedding
     FROM entities e LEFT JOIN entity_types t ON t.id = e.type_id
     WHERE e.kb_id = $1 AND e.merged_into IS NULL
       AND e.id <> $2
       AND lower(e.canonical_name) <> $3
       AND (
         (char_length(e.canonical_name) >= $4
          AND (lower(e.canonical_name) LIKE '%' || $3 || '%'
               OR $3 LIKE '%' || lower(e.canonical_name) || '%'))
         -- Aliases must take part in recall too, or every merge removes
         -- one bridge.
         --
         -- A merge moves a name into aliases: after "Holmes" merges into
         -- "Sherlock Holmes", the "Holmes" row has a non-null
         -- merged_into and gets filtered out by the first condition
         -- above. Ten minutes later, "Mr. Holmes" shows up, and it
         -- contains neither "Sherlock Holmes" nor is contained by it --
         -- "Holmes" used to be the bridge. This is exactly how it was
         -- observed to leak: after fixing the same-type bug and getting
         -- "Holmes" to merge correctly, "Mr. Holmes" then never entered
         -- the queue at all.
         --
         -- The more successful the merges, the more bridges get torn
         -- down. This gap grows on its own.
         OR EXISTS (
           SELECT 1 FROM unnest(e.aliases) AS alias
           WHERE char_length(alias) >= $4
             AND (lower(alias) LIKE '%' || $3 || '%'
                  OR $3 LIKE '%' || lower(alias) || '%'))
       )
     ORDER BY char_length(e.canonical_name)
     LIMIT $5`,
    [kb_id, new_id, lower, MIN_CONTAIN_CHARS, CONTAIN_SCAN_LIMIT],
  );

  return rows
    .filter((r) => classify_type_drift(mention_key, r.key) !== "Disjoint")
    .slice(0, MAX_CONTAIN_REVIEWS)
    .map((r) => {
      // The score is only a hint for sorting the queue. It never decides
      // whether to merge -- that decision does not live on this path at
      // all.
      const emb = parse_vector(r.profile_embedding);
      const score = ctx !== null && emb !== null ? (cosine(emb, ctx) ?? 0) : 0;
      return { other_id: r.id, score, reason: `contains|${r.canonical_name}` };
    });
}

interface CrossCandidate {
  id: Uuid;
  canonical_name: string;
  // null = this candidate has no type decided yet (decision 0009).
  type_key: string | null;
  // Extraction upgrade must check this: when a human has said "there is
  // really no type for this", that is also a decision.
  type_source: string;
  profile_embedding: number[] | null;
  profile_n: number;
}

/**
 * `reason` stores a code. Wording belongs to the UI (see decision 0004).
 * This column must not mix codes with English sentences, or a Chinese UI
 * ends up half translatable and half not.
 */
function drift_reason(mention_key: string | null, other_key: string | null, sim: number | null): string {
  // An untyped side is written as "(untyped)". This column stores a code
  // for the UI to translate; leaving it blank would turn "a vs b" into
  // "a vs ", which reads like truncation, not "no type".
  const a = mention_key ?? "(untyped)";
  const b = other_key ?? "(untyped)";
  return sim !== null ? `type_drift|${a} vs ${b} ${sim.toFixed(2)}` : `type_drift|${a} vs ${b}`;
}

function confusable_reviews(
  // null = this side has no type decided yet (decision 0009).
  mention_key: string | null,
  cands: CrossCandidate[],
  ctx: number[] | null,
): ReviewRequest[] {
  return cands.map((c) => {
    const sim = ctx !== null && c.profile_embedding !== null ? cosine(c.profile_embedding, ctx) : null;
    return {
      other_id: c.id,
      score: sim ?? 0,
      reason: drift_reason(mention_key, c.type_key, sim),
    };
  });
}

/**
 * Handle a cross-type case (type drift) when the same-type recall is
 * empty.
 *
 * A concept-fallback candidate runs through the usual profile-vector
 * ranking: a high score attaches it directly (this repairs the drift by
 * upgrading the concept side to a concrete type). A gray-zone or
 * undecidable score creates a new entity plus a review pair (split rather
 * than merge). A confusable concrete type always creates a new entity plus
 * a review pair -- the same name with a wavering type is itself a signal,
 * so no similarity threshold applies there. A hard-exclusive type is
 * ignored.
 */
async function resolve_type_drift(
  sql: Sql,
  kb_id: Uuid,
  // null = the extractor's type is not in the ontology, or the KB has no
  // types at all (decision 0009).
  type_id: Uuid | null,
  name: string,
  keys: string[],
  context: number[] | null,
): Promise<Resolution> {
  // This side may also have no type decided yet (decision 0009); then
  // there is no key to look up.
  let mention_key: string | null = null;
  if (type_id !== null) {
    const row = await qOpt<{ key: string }>(sql, `SELECT key FROM entity_types WHERE id = $1`, [type_id]);
    mention_key = row?.key ?? null;
  }
  const cross_rows = await q<{
    id: Uuid;
    canonical_name: string;
    type_key: string | null;
    type_source: string;
    profile_embedding: string | null;
    profile_n: number;
  }>(
    sql,
    `SELECT e.id, e.canonical_name, t.key AS type_key, e.type_source,
            e.profile_embedding, e.profile_n
     FROM entities e LEFT JOIN entity_types t ON t.id = e.type_id
     -- IS DISTINCT FROM, not <>: <> evaluates to NULL when either side is
     -- NULL, and WHERE treats NULL as false, so untyped entities would be
     -- dropped entirely (decision 0009).
     WHERE e.kb_id = $1 AND e.type_id IS DISTINCT FROM $2 AND e.merged_into IS NULL
       AND (lower(e.canonical_name) = ANY($3)
            OR EXISTS (SELECT 1 FROM unnest(e.aliases) a WHERE lower(a) = ANY($3)))`,
    [kb_id, type_id, keys],
  );
  const cross: CrossCandidate[] = cross_rows.map((r) => ({
    id: r.id,
    canonical_name: r.canonical_name,
    type_key: r.type_key,
    type_source: r.type_source,
    profile_embedding: parse_vector(r.profile_embedding),
    profile_n: r.profile_n,
  }));

  const recall_cands: CrossCandidate[] = [];
  const review_cands: CrossCandidate[] = [];
  for (const c of cross) {
    const drift = classify_type_drift(mention_key, c.type_key);
    if (drift === "Recall") {
      recall_cands.push(c);
    } else if (drift === "Review") {
      review_cands.push(c);
    }
  }

  if (context !== null) {
    const ctx = context;
    let best: [CrossCandidate, number] | null = null;
    for (const c of recall_cands) {
      if (c.profile_embedding === null) continue;
      const sim = cosine(c.profile_embedding, ctx);
      if (sim === null) continue;
      if (best === null || sim > best[1]) {
        best = [c, sim];
      }
    }
    if (best !== null) {
      const [candidate, sim] = best;
      if (sim >= SIM_ATTACH) {
        await update_profile(sql, candidate.id, candidate.profile_n, ctx);
        // The candidate had no type yet, and this extraction has one:
        // upgrade it. This is not a merge (there is no second entity), so
        // it does not go into entity_merges; the ontology page can still
        // change it back by hand.
        //
        // A "no type" a human already said does not count as "not
        // decided yet". After decision 0009 both are NULL, and checking
        // only type_key === null cannot tell them apart -- so an entity a
        // human reviewed and judged to have no matching class in the
        // ontology would get a type assigned again on the next
        // extraction run.
        if (candidate.type_key === null && candidate.type_source !== "human" && type_id !== null) {
          await exec(
            sql,
            `UPDATE entities
             SET type_id = $2, type_source = 'extracted', updated_at = now()
             WHERE id = $1`,
            [candidate.id, type_id],
          );
          // The type-fallback disambiguator suffix may now be stale.
          await refresh_disambiguators(sql, kb_id, candidate.canonical_name);
        }
        // The mention has settled on the recalled entity; a same-name
        // confusable-type entity may still be suspect -> queue it as
        // usual.
        let reviews = confusable_reviews(mention_key, review_cands, ctx);
        reviews = reviews.slice(0, MAX_DRIFT_REVIEWS);
        return { entity_id: candidate.id, created: false, reviews };
      }
    }
  }

  const id = await create_entity(sql, kb_id, type_id, name, context);
  if (cross.length > 0) {
    // Cross-type same-name entities coexist: the disambiguator suffix
    // groups by name, not by type, and must be refreshed.
    await refresh_disambiguators(sql, kb_id, name);
  }
  let reviews = confusable_reviews(mention_key, review_cands, context);
  for (const c of recall_cands) {
    const sim =
      context !== null && c.profile_embedding !== null ? cosine(c.profile_embedding, context) : null;
    if (sim !== null && sim < SIM_NEW) {
      // Clearly a different entity by profile: keep it fully separate,
      // and do not bother the review queue.
      continue;
    }
    // Gray zone, or undecidable (no embedding, or the candidate has no
    // profile): split rather than merge, and queue a review.
    reviews.push({
      other_id: c.id,
      score: sim ?? 0,
      reason: drift_reason(mention_key, c.type_key, sim),
    });
  }
  reviews = reviews.slice(0, MAX_DRIFT_REVIEWS);
  // This path creates a new entity too, so containment recall still runs.
  reviews.push(...(await containment_reviews(sql, kb_id, type_id, name, id, context)));
  return { entity_id: id, created: true, reviews };
}

async function create_entity(
  sql: Sql,
  kb_id: Uuid,
  // null = the extractor's type is not in the ontology, or the KB has no
  // types at all (decision 0009).
  type_id: Uuid | null,
  name: string,
  context: number[] | null,
): Promise<Uuid> {
  const id = newId();
  await exec(
    sql,
    `INSERT INTO entities (id, kb_id, type_id, canonical_name, profile_embedding, profile_n)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, kb_id, type_id, name, context !== null ? vector_param(context) : null, context !== null ? 1 : 0],
  );
  return id;
}

async function touch_entity(sql: Sql, id: Uuid): Promise<void> {
  await exec(sql, `UPDATE entities SET updated_at = now() WHERE id = $1`, [id]);
}

/**
 * Incrementally update the profile centroid: profile becomes
 * (profile * n + ctx) / (n + 1). When dimensions do not match (the
 * embedding model changed), the new vector resets the profile instead.
 */
async function update_profile(sql: Sql, id: Uuid, n: number, ctx: number[]): Promise<void> {
  const existing = await qOpt<{ profile_embedding: string | null }>(
    sql,
    `SELECT profile_embedding FROM entities WHERE id = $1`,
    [id],
  );
  const old = existing ? parse_vector(existing.profile_embedding) : null;
  let new_vec: number[];
  let new_n: number;
  if (old !== null && old.length === ctx.length && n > 0) {
    new_vec = old.map((a, i) => (a * n + ctx[i]) / (n + 1));
    new_n = n + 1;
  } else {
    new_vec = ctx;
    new_n = 1;
  }
  await exec(
    sql,
    `UPDATE entities SET profile_embedding = $2, profile_n = $3, updated_at = now()
     WHERE id = $1`,
    [id, vector_param(new_vec), new_n],
  );
}

/**
 * Refresh the display disambiguator for a same-name group: when 2 or more
 * live entities share a name, each takes its strongest distinguishing fact
 * (the object name of works_at, part_of, located_in, or leads); otherwise
 * it falls back to the type label. When the group has only one member, the
 * disambiguator clears.
 */
export async function refresh_disambiguators(sql: Sql, kb_id: Uuid, name: string): Promise<void> {
  const group = await q<{ id: Uuid }>(
    sql,
    `SELECT id FROM entities
     WHERE kb_id = $1 AND merged_into IS NULL AND lower(canonical_name) = lower($2)`,
    [kb_id, name],
  );

  if (group.length < 2) {
    for (const { id } of group) {
      await exec(sql, `UPDATE entities SET disambiguator = NULL WHERE id = $1`, [id]);
    }
    return;
  }

  for (const { id } of group) {
    const label = await qOpt<{ canonical_name: string }>(
      sql,
      `SELECT o.canonical_name FROM facts f
       JOIN relation_types r ON r.id = f.predicate_id
       JOIN entities o ON o.id = f.object_id
       WHERE f.kb_id = $1 AND f.subject_id = $2
         AND f.invalidated_at IS NULL AND f.object_id IS NOT NULL
         AND r.key IN ('works_at', 'part_of', 'located_in', 'leads')
       ORDER BY (r.key = 'works_at') DESC, f.confidence DESC, f.recorded_at DESC
       LIMIT 1`,
      [kb_id, id],
    );
    // No related fact found: fall back to the type label. The type can
    // also be missing (decision 0009); then there is no suffix to write.
    // Leave it null. The UI shows same-name entries side by side, and
    // must not invent one.
    let disambiguator: string | null = null;
    if (label) {
      disambiguator = label.canonical_name;
    } else {
      const type_row = await qOpt<{ label: string }>(
        sql,
        `SELECT t.label FROM entities e JOIN entity_types t ON t.id = e.type_id
         WHERE e.id = $1`,
        [id],
      );
      disambiguator = type_row?.label ?? null;
    }
    await exec(sql, `UPDATE entities SET disambiguator = $2 WHERE id = $1`, [id, disambiguator]);
  }
}

// ---------------------------------------------------------------------------
// Review queue
// ---------------------------------------------------------------------------

/** Queue a gray-zone suspected-duplicate pair. Queuing the same pending pair twice is idempotent. */
export async function create_review(
  sql: Sql,
  kb_id: Uuid,
  left_id: Uuid,
  right_id: Uuid,
  score: number,
  reason: string,
): Promise<void> {
  await exec(
    sql,
    `INSERT INTO resolution_reviews (id, kb_id, left_id, right_id, score, reason)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (kb_id, least(left_id, right_id), greatest(left_id, right_id))
         WHERE status = 'pending'
     DO NOTHING`,
    [newId(), kb_id, left_id, right_id, score, reason],
  );
}

interface ReviewRow {
  id: Uuid;
  left_id: Uuid;
  right_id: Uuid;
  score: number;
  reason: string | null;
  stage: string;
  created_at: Date;
}

/** A review item's side: a summary of one entity in a review pair. */
export interface ReviewSide {
  id: Uuid;
  name: string;
  type_label: string | null;
  color: string;
  disambiguator: string | null;
  degree: number;
  top_facts: string[];
}

/** A resolution review item: a gray-zone pair suspected of being the same entity. */
export interface ReviewItem {
  id: Uuid;
  score: number;
  reason: string | null;
  /** adjudicating = waiting for the LLM; human = waiting for manual review. */
  stage: string;
  created_at: Date;
  left: ReviewSide;
  right: ReviewSide;
}

async function review_side(sql: Sql, kb_id: Uuid, entity_id: Uuid): Promise<ReviewSide> {
  interface SideRow {
    id: Uuid;
    name: string;
    type_label: string | null;
    color: string;
    disambiguator: string | null;
    degree: number | string;
  }
  const row = await qOpt<SideRow>(
    sql,
    `SELECT e.id, e.canonical_name AS name, t.label AS type_label,
            coalesce(t.color, '#94a3b8') AS color, e.disambiguator,
            (SELECT count(*) FROM facts f
             WHERE (f.subject_id = e.id OR f.object_id = e.id)
               AND f.invalidated_at IS NULL) AS degree
     -- LEFT JOIN: an entity with no type decided yet must still be able
     -- to enter review (decision 0009). An inner join would drop the
     -- whole review item, and drift reviews happen most often on exactly
     -- these entities.
     FROM entities e LEFT JOIN entity_types t ON t.id = e.type_id
     WHERE e.kb_id = $1 AND e.id = $2`,
    [kb_id, entity_id],
  );
  if (!row) {
    throw AppError.notFound();
  }

  return {
    id: row.id,
    name: row.name,
    type_label: row.type_label,
    color: row.color,
    disambiguator: row.disambiguator,
    degree: Number(row.degree),
    top_facts: await entity_fact_lines(sql, kb_id, entity_id, 4),
  };
}

/**
 * An entity's fact summary lines: "works at -> Nebula Tech (2023-01 ->
 * now)". Both the adjudication prompt and the review UI share this.
 */
export async function entity_fact_lines(
  sql: Sql,
  kb_id: Uuid,
  entity_id: Uuid,
  limit: number,
): Promise<string[]> {
  interface Line {
    direction: string;
    predicate_label: string;
    other_name: string | null;
    valid_from: Date | null;
    valid_to: Date | null;
  }
  const rows = await q<Line>(
    sql,
    `SELECT CASE WHEN f.subject_id = $2 THEN 'out' ELSE 'in' END AS direction,
            COALESCE(r.label, fact_surface_predicate(f.id)) AS predicate_label,
            o.canonical_name AS other_name,
            f.valid_from, f.valid_to
     FROM facts f
     LEFT JOIN relation_types r ON r.id = f.predicate_id
     LEFT JOIN entities o
       ON o.id = CASE WHEN f.subject_id = $2 THEN f.object_id ELSE f.subject_id END
     WHERE f.kb_id = $1 AND f.invalidated_at IS NULL
       AND (f.subject_id = $2 OR f.object_id = $2)
       AND COALESCE(r.label, fact_surface_predicate(f.id)) IS NOT NULL
     ORDER BY f.confidence DESC, f.recorded_at DESC
     LIMIT $3`,
    [kb_id, entity_id, limit],
  );

  return rows.map((l) => {
    const other = l.other_name ?? "?";
    const core =
      l.direction === "out" ? `${l.predicate_label} \u2192 ${other}` : `${l.predicate_label} \u2190 ${other}`;
    if (l.valid_from !== null && l.valid_to !== null) {
      return `${core} (${format_year_month(l.valid_from)} \u2192 ${format_year_month(l.valid_to)})`;
    }
    if (l.valid_from !== null) {
      return `${core} (${format_year_month(l.valid_from)} \u2192 now)`;
    }
    return core;
  });
}

function format_year_month(d: Date): string {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

async function assemble_reviews(sql: Sql, kb_id: Uuid, rows: ReviewRow[]): Promise<ReviewItem[]> {
  const items: ReviewItem[] = [];
  for (const r of rows) {
    items.push({
      id: r.id,
      score: r.score,
      reason: r.reason,
      stage: r.stage,
      created_at: r.created_at,
      left: await review_side(sql, kb_id, r.left_id),
      right: await review_side(sql, kb_id, r.right_id),
    });
  }
  return items;
}

/** Every pending review item (both the items waiting on the LLM and the ones waiting on a human are shown; a human may adjudicate any of them ahead of time). */
export async function list_reviews(sql: Sql, kb_id: Uuid, limit: number, offset: number): Promise<ReviewItem[]> {
  const rows = await q<ReviewRow>(
    sql,
    `SELECT id, left_id, right_id, score, reason, stage, created_at
     FROM resolution_reviews
     WHERE kb_id = $1 AND status = 'pending'
     ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [kb_id, limit, offset],
  );
  return assemble_reviews(sql, kb_id, rows);
}

/** Review items waiting for LLM adjudication (consumed by the background adjudication job). */
export async function pending_adjudications(sql: Sql, kb_id: Uuid, limit: number): Promise<ReviewItem[]> {
  const rows = await q<ReviewRow>(
    sql,
    `SELECT id, left_id, right_id, score, reason, stage, created_at
     FROM resolution_reviews
     WHERE kb_id = $1 AND status = 'pending' AND stage = 'adjudicating'
     ORDER BY created_at LIMIT $2`,
    [kb_id, limit],
  );
  return assemble_reviews(sql, kb_id, rows);
}

/**
 * Move a review to manual review: the LLM was unsure, or no model is
 * configured.
 * `reason` stores a **code**, optionally with a `|detail` suffix. It is
 * not a sentence for a person to read.
 *
 * The UI's display language lives on the client (see decision 0004); the
 * server has no locale to word things in. English prose written into this
 * column stays stuck on a Chinese UI forever. Wording belongs to i18n;
 * this column only holds a stable code.
 */
export async function escalate_review(sql: Sql, review_id: Uuid, reason: string): Promise<void> {
  await exec(
    sql,
    `UPDATE resolution_reviews SET stage = 'human', reason = $2
     WHERE id = $1 AND status = 'pending'`,
    [review_id, reason],
  );
}

/** Automatic adjudication (high LLM confidence): merged or kept. The caller must already have performed the merge action itself. */
export async function close_review_auto(sql: Sql, review_id: Uuid, status: string, reason: string): Promise<void> {
  await exec(
    sql,
    `UPDATE resolution_reviews SET status = $2, reason = $3, decided_at = now()
     WHERE id = $1 AND status = 'pending'`,
    [review_id, status, reason],
  );
}

/** Manual adjudication. Merge direction: the side with more facts (higher degree) survives; ties go to the entity created earlier. */
export async function decide_review(
  sql: Sql,
  kb_id: Uuid,
  review_id: Uuid,
  action: string,
  user_id: Uuid,
): Promise<void> {
  const row = await qOpt<ReviewRow>(
    sql,
    `SELECT id, left_id, right_id, score, reason, stage, created_at
     FROM resolution_reviews WHERE id = $1 AND kb_id = $2 AND status = 'pending'`,
    [review_id, kb_id],
  );
  if (!row) {
    throw AppError.notFound();
  }

  if (action === "merge") {
    const [target, source] = await merge_direction(sql, row.left_id, row.right_id);
    await merge_entities(sql, kb_id, source, target, user_id, "review decision");
    await exec(
      sql,
      `UPDATE resolution_reviews SET status = 'merged', decided_at = now(), decided_by = $2
       WHERE id = $1`,
      [review_id, user_id],
    );
  } else if (action === "keep") {
    await exec(
      sql,
      `UPDATE resolution_reviews SET status = 'kept', decided_at = now(), decided_by = $2
       WHERE id = $1`,
      [review_id, user_id],
    );
  } else {
    throw AppError.validation("action must be merge or keep");
  }
}

/** Merge direction: returns [target that survives, source that merges away]. */
export async function merge_direction(sql: Sql, a: Uuid, b: Uuid): Promise<[Uuid, Uuid]> {
  const deg_a_row = await qOne<{ count: string | number }>(
    sql,
    `SELECT count(*) FROM facts WHERE (subject_id = $1 OR object_id = $1) AND invalidated_at IS NULL`,
    [a],
  );
  const deg_b_row = await qOne<{ count: string | number }>(
    sql,
    `SELECT count(*) FROM facts WHERE (subject_id = $1 OR object_id = $1) AND invalidated_at IS NULL`,
    [b],
  );
  const deg_a = Number(deg_a_row.count);
  const deg_b = Number(deg_b_row.count);
  // uuidv7 sorts by time: on a tie in fact count, the earlier-created
  // side survives.
  return deg_a > deg_b || (deg_a === deg_b && a < b) ? [a, b] : [b, a];
}

// ---------------------------------------------------------------------------
// Merge / revert
// ---------------------------------------------------------------------------

interface EntityFull {
  // null = not decided yet (decision 0009).
  type_id: Uuid | null;
  canonical_name: string;
  aliases: string[];
  profile_embedding: string | null;
  profile_n: number;
  merged_into: Uuid | null;
}

async function entity_full(sql: Sql, kb_id: Uuid, id: Uuid): Promise<EntityFull> {
  const row = await qOpt<EntityFull>(
    sql,
    `SELECT type_id, canonical_name, aliases, profile_embedding, profile_n, merged_into
     FROM entities WHERE kb_id = $1 AND id = $2`,
    [kb_id, id],
  );
  if (!row) {
    throw AppError.notFound();
  }
  return row;
}

/**
 * Merge source into target: facts move over to target, mutual facts
 * between the two (and duplicates created by the merge) are invalidated,
 * the source's name joins target's aliases, the profiles merge by weight,
 * and source is marked merged_into. Every step is logged, so it can be
 * reverted.
 */
export async function merge_entities(
  sql: Sql,
  kb_id: Uuid,
  source_id: Uuid,
  target_id: Uuid,
  merged_by: Uuid | null,
  reason: string,
): Promise<Uuid> {
  if (source_id === target_id) {
    throw AppError.invalid("self_merge", "Cannot merge an entity into itself");
  }
  const source = await entity_full(sql, kb_id, source_id);
  const target = await entity_full(sql, kb_id, target_id);
  if (source.merged_into !== null || target.merged_into !== null) {
    throw AppError.conflict("Entity already merged");
  }

  let moved_subject: Uuid[] = [];
  let moved_object: Uuid[] = [];
  let merge_id = "";

  await sql.begin(async (tx_raw) => {
    const tx = tx_raw as unknown as Sql;

    // Mutual facts (they would become a self-loop after the merge) are
    // invalidated.
    const cross = await q<{ id: Uuid }>(
      tx,
      `UPDATE facts SET invalidated_at = now()
       WHERE kb_id = $1 AND invalidated_at IS NULL
         AND ((subject_id = $2 AND object_id = $3) OR (subject_id = $3 AND object_id = $2))
       RETURNING id`,
      [kb_id, source_id, target_id],
    );
    const invalidated: Uuid[] = cross.map((r) => r.id);

    moved_subject = (
      await q<{ id: Uuid }>(
        tx,
        `UPDATE facts SET subject_id = $2 WHERE kb_id = $3 AND subject_id = $1 RETURNING id`,
        [source_id, target_id, kb_id],
      )
    ).map((r) => r.id);
    moved_object = (
      await q<{ id: Uuid }>(
        tx,
        `UPDATE facts SET object_id = $2 WHERE kb_id = $3 AND object_id = $1 RETURNING id`,
        [source_id, target_id, kb_id],
      )
    ).map((r) => r.id);

    // Live facts that are now duplicates by SPO + valid_from after the
    // merge: keep the one with the earliest recorded_at, and invalidate
    // the rest.
    //
    // Both object sides must be grouped. A literal fact's object_id is
    // always NULL; grouping by that alone would treat every value under
    // the same subject and predicate as a single assertion -- after one
    // merge, (company, founding_year, 2015) and (company,
    // registered_capital, ...) aside, only the earliest-recorded value
    // under the same predicate would survive, and the rest would vanish
    // silently, with no supersedes chain to look them up by.
    const dups = await q<{ dup_ids: Uuid[] }>(
      tx,
      `SELECT (array_agg(id ORDER BY recorded_at))[2:] AS dup_ids FROM facts
       WHERE kb_id = $1 AND invalidated_at IS NULL
         AND (subject_id = $2 OR object_id = $2)
       GROUP BY subject_id, predicate_id, object_id, object_value, valid_from
       HAVING count(*) > 1`,
      [kb_id, target_id],
    );
    const dup_ids: Uuid[] = dups.flatMap((r) => r.dup_ids);
    if (dup_ids.length > 0) {
      await exec(tx, `UPDATE facts SET invalidated_at = now() WHERE id = ANY($1)`, [dup_ids]);
      invalidated.push(...dup_ids);
    }

    // The source's name and aliases join target's aliases (deduplicated,
    // excluding target's own canonical name).
    const aliases = [...target.aliases];
    const taken = new Set<string>([target.canonical_name.toLowerCase(), ...aliases.map((a) => a.toLowerCase())]);
    for (const a of [source.canonical_name, ...source.aliases]) {
      const lower_a = a.toLowerCase();
      if (!taken.has(lower_a) && !aliases.some((x) => x.toLowerCase() === lower_a)) {
        aliases.push(a);
      }
    }

    // Merge the profiles by weight.
    const source_profile = parse_vector(source.profile_embedding);
    const target_profile = parse_vector(target.profile_embedding);
    let profile: number[] | null;
    let profile_n: number;
    if (target_profile !== null && source_profile !== null && target_profile.length === source_profile.length) {
      const nt = Math.max(target.profile_n, 1);
      const ns = Math.max(source.profile_n, 1);
      profile = target_profile.map((t, i) => (t * nt + source_profile[i] * ns) / (nt + ns));
      profile_n = target.profile_n + source.profile_n;
    } else if (target_profile !== null) {
      profile = target_profile;
      profile_n = target.profile_n;
    } else if (source_profile !== null) {
      profile = source_profile;
      profile_n = source.profile_n;
    } else {
      profile = null;
      profile_n = 0;
    }

    // Reconcile the type: the side with no type yields.
    //
    // If the surviving side has no type yet and the merged-away side
    // does, carry that type over; otherwise keep the surviving side's
    // type. "Not decided yet" is now `null` (decision 0009), so a single
    // `??` says it all.
    const new_type_id = target.type_id ?? source.type_id;

    await exec(
      tx,
      `UPDATE entities SET aliases = $2, profile_embedding = $3, profile_n = $4,
              type_id = $5, updated_at = now() WHERE id = $1`,
      [target_id, aliases, profile !== null ? vector_param(profile) : null, profile_n, new_type_id],
    );
    await exec(tx, `UPDATE entities SET merged_into = $2, updated_at = now() WHERE id = $1`, [
      source_id,
      target_id,
    ]);

    // Other pending review items involving the source: redirect them to
    // the merge target, do not close them.
    //
    // These used to be closed unconditionally, with the reasoning that
    // "if the suspicion still holds, a later mention will raise it
    // again". That reasoning is wrong: containment recall only runs when
    // a new entity is created, and these entities already exist -- they
    // will never be created again, so there is no "later mention" to
    // raise it again. Closing them closes them forever.
    //
    // Observed in practice: "Mr. Holmes" and "Holmes" were queued as a
    // pair (0.70); then "Holmes" merged into "Sherlock Holmes", and that
    // pair got closed as superseded by merge -- while the still-open
    // question of "Mr. Holmes" versus "Sherlock Holmes" was never asked
    // again.
    //
    // First close the two kinds that truly are stale: a pair that would
    // become a self-loop after the redirect, and a pair whose redirected
    // target is already queued.
    await exec(
      tx,
      `UPDATE resolution_reviews AS r
       SET status = 'kept', reason = 'superseded by merge', decided_at = now()
       WHERE r.kb_id = $1 AND r.status = 'pending'
         AND (r.left_id = $2 OR r.right_id = $2)
         AND NOT (least(r.left_id, r.right_id) = least($2, $3)
                      AND greatest(r.left_id, r.right_id) = greatest($2, $3))
         AND (
           (CASE WHEN r.left_id = $2 THEN r.right_id ELSE r.left_id END) = $3
           OR EXISTS (
             SELECT 1 FROM resolution_reviews d
             WHERE d.kb_id = $1 AND d.status = 'pending' AND d.id <> r.id
               AND least(d.left_id, d.right_id)
                   = least($3, CASE WHEN r.left_id = $2 THEN r.right_id ELSE r.left_id END)
               AND greatest(d.left_id, d.right_id)
                   = greatest($3, CASE WHEN r.left_id = $2 THEN r.right_id ELSE r.left_id END))
         )`,
      [kb_id, source_id, target_id],
    );
    // The rest redirect to the target, and the question stays open in
    // the queue for adjudication. The (source, target) pair itself is
    // excluded -- it is the very pair this merge is deciding, and
    // touching it here would wrongly show it in history as "kept
    // separate".
    await exec(
      tx,
      `UPDATE resolution_reviews
       SET left_id = CASE WHEN left_id = $2 THEN $3 ELSE left_id END,
           right_id = CASE WHEN right_id = $2 THEN $3 ELSE right_id END,
           reason = reason || '|redirected'
       WHERE kb_id = $1 AND status = 'pending' AND (left_id = $2 OR right_id = $2)
         AND NOT (least(left_id, right_id) = least($2, $3)
                      AND greatest(left_id, right_id) = greatest($2, $3))`,
      [kb_id, source_id, target_id],
    );

    merge_id = newId();
    await exec(
      tx,
      `INSERT INTO entity_merges (id, kb_id, source_id, target_id,
              moved_subject_facts, moved_object_facts, invalidated_facts,
              target_profile_before, target_profile_n_before, target_type_before,
              merged_by, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        merge_id,
        kb_id,
        source_id,
        target_id,
        moved_subject,
        moved_object,
        invalidated,
        source.profile_embedding !== null ? source.profile_embedding : target.profile_embedding,
        target.profile_n,
        target.type_id,
        merged_by,
        reason,
      ],
    );
  });

  // Temporal reconciliation after the move: a fact whose subject or
  // object just changed is equivalent to a freshly landed observation --
  // only after two entities fold into one does the uniqueness invariant
  // first see the old open interval collide with its successor (for
  // example, "Stardust" merges into "Stardust Project", and the old
  // leader's leads fact must now close at the new leader's start).
  // Record the correcting row ids into the merge ledger: their only cause
  // is this merge, and a revert must undo them too.
  //
  // Note: this step runs outside the transaction. If it fails, it is
  // self-healing -- a leftover old open row gets caught and closed by
  // ordinary reconciliation the next time a related new fact lands.
  const moved_all = [...moved_subject, ...moved_object];
  const report = await reconcileMovedFacts(sql, kb_id, moved_all);
  if (report.corrected.length > 0) {
    await exec(sql, `UPDATE entity_merges SET temporal_corrections = $2 WHERE id = $1`, [
      merge_id,
      report.corrected,
    ]);
  }

  await refresh_disambiguators(sql, kb_id, source.canonical_name);
  if (source.canonical_name.toLowerCase() !== target.canonical_name.toLowerCase()) {
    await refresh_disambiguators(sql, kb_id, target.canonical_name);
  }
  return merge_id;
}

interface MergeRow {
  source_id: Uuid;
  target_id: Uuid;
  moved_subject_facts: Uuid[];
  moved_object_facts: Uuid[];
  invalidated_facts: Uuid[];
  temporal_corrections: Uuid[];
  target_profile_before: string | null;
  target_profile_n_before: number;
  target_type_before: Uuid | null;
  reverted_at: Date | null;
}

/** Precisely revert one merge: facts move back, invalidations undo, target's profile and type restore from the snapshot, and source comes back to life. */
export async function revert_merge(sql: Sql, kb_id: Uuid, merge_id: Uuid): Promise<void> {
  const m = await qOpt<MergeRow>(
    sql,
    `SELECT source_id, target_id, moved_subject_facts, moved_object_facts,
            invalidated_facts, temporal_corrections, target_profile_before,
            target_profile_n_before, target_type_before, reverted_at
     FROM entity_merges WHERE id = $1 AND kb_id = $2`,
    [merge_id, kb_id],
  );
  if (!m) {
    throw AppError.notFound();
  }
  if (m.reverted_at !== null) {
    throw AppError.conflict("Merge already reverted");
  }

  await sql.begin(async (tx_raw) => {
    const tx = tx_raw as unknown as Sql;
    await exec(tx, `UPDATE facts SET subject_id = $1 WHERE id = ANY($2)`, [
      m.source_id,
      m.moved_subject_facts,
    ]);
    await exec(tx, `UPDATE facts SET object_id = $1 WHERE id = ANY($2)`, [m.source_id, m.moved_object_facts]);
    await exec(tx, `UPDATE facts SET invalidated_at = NULL WHERE id = ANY($1)`, [m.invalidated_facts]);

    // Undo the temporal corrections the merge caused: their only cause is
    // this merge (the invariant only saw the collision because two
    // entities folded into one), so once the cause is undone, the
    // corrections must be undone too -- first restore the row a
    // correction replaced, then invalidate the correction row. Only
    // still-live corrections are undone: a chain later rewritten by a
    // genuinely new observation is left untouched (that part has its own
    // independent basis).
    await exec(
      tx,
      `UPDATE facts SET invalidated_at = NULL WHERE id IN (
           SELECT supersedes FROM facts
           WHERE id = ANY($1) AND invalidated_at IS NULL AND supersedes IS NOT NULL)`,
      [m.temporal_corrections],
    );
    await exec(
      tx,
      `UPDATE facts SET invalidated_at = now()
       WHERE id = ANY($1) AND invalidated_at IS NULL`,
      [m.temporal_corrections],
    );

    const source = await entity_full(tx, kb_id, m.source_id);
    // Roll back target's aliases: remove the names that came from source.
    await exec(
      tx,
      `UPDATE entities SET
          aliases = (SELECT coalesce(array_agg(a), '{}') FROM unnest(aliases) a
                     WHERE lower(a) <> ALL($2)),
          profile_embedding = $3, profile_n = $4,
          type_id = coalesce($5, type_id), updated_at = now()
       WHERE id = $1`,
      [
        m.target_id,
        [source.canonical_name, ...source.aliases].map((s) => s.toLowerCase()),
        m.target_profile_before,
        m.target_profile_n_before,
        m.target_type_before,
      ],
    );
    await exec(tx, `UPDATE entities SET merged_into = NULL, updated_at = now() WHERE id = $1`, [m.source_id]);
    await exec(tx, `UPDATE entity_merges SET reverted_at = now() WHERE id = $1`, [merge_id]);

    await refresh_disambiguators(tx, kb_id, source.canonical_name);
  });
}

/** A merge log view: a merge-log entry (used by the review page's history section). */
export interface MergeLogView {
  id: Uuid;
  source_name: string;
  target_name: string;
  /** null = an automatic LLM merge. */
  merged_by_name: string | null;
  reason: string | null;
  created_at: Date;
  reverted_at: Date | null;
}

/** Merge log (the review page's history section). */
export async function list_merges(sql: Sql, kb_id: Uuid, limit: number, offset: number): Promise<MergeLogView[]> {
  return q<MergeLogView>(
    sql,
    `SELECT m.id, s.canonical_name AS source_name, t.canonical_name AS target_name,
            u.display_name AS merged_by_name, m.reason, m.created_at, m.reverted_at
     FROM entity_merges m
     JOIN entities s ON s.id = m.source_id
     JOIN entities t ON t.id = m.target_id
     LEFT JOIN users u ON u.id = m.merged_by
     WHERE m.kb_id = $1
     ORDER BY m.created_at DESC LIMIT $2 OFFSET $3`,
    [kb_id, limit, offset],
  );
}

// ---------------------------------------------------------------------------
// LLM adjudication cache
// ---------------------------------------------------------------------------

export async function get_verdict(
  sql: Sql,
  kb_id: Uuid,
  pair_key: string,
): Promise<[boolean | null, number] | null> {
  const row = await qOpt<{ same: boolean | null; confidence: number }>(
    sql,
    `SELECT same, confidence FROM resolution_verdicts WHERE kb_id = $1 AND pair_key = $2`,
    [kb_id, pair_key],
  );
  return row ? [row.same, row.confidence] : null;
}

export async function put_verdict(
  sql: Sql,
  kb_id: Uuid,
  pair_key: string,
  same: boolean | null,
  confidence: number,
  model: string,
): Promise<void> {
  await exec(
    sql,
    `INSERT INTO resolution_verdicts (kb_id, pair_key, same, confidence, model)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (kb_id, pair_key)
     DO UPDATE SET same = $3, confidence = $4, model = $5, created_at = now()`,
    [kb_id, pair_key, same, confidence, model],
  );
}

/**
 * Record a model-proposed entity type that the ontology does not have.
 *
 * **Only the first write counts.** The same entity gets mentioned by
 * multiple documents, and the first proposal counts as its proposal;
 * letting later ones overwrite it would make "which entities are waiting
 * on a model type" drift with whatever document ran last. Adopting the
 * matching type clears this field through the rewrite flow -- at that
 * point it is no longer a "proposal", it is settled fact.
 */
export async function set_proposed_type(sql: Sql, entity_id: Uuid, proposed: string): Promise<void> {
  await exec(
    sql,
    `UPDATE entities SET proposed_type = left($2, 60)
     WHERE id = $1 AND proposed_type IS NULL`,
    [entity_id, proposed],
  );
}

/** A type the entity type not yet claimed. */
export interface ProposedType {
  form: string;
  entity_count: number;
  example: string | null;
}

/**
 * Entity types waiting to be claimed: a model proposed one, the ontology
 * has none, and the entity was downgraded to concept as a result.
 *
 * This is symmetric with the predicate side's `proposed_predicates` in
 * graph.ts -- it is tied to concrete entities, so adopting it can say
 * "this will reclassify 43 entities" and actually do it, instead of only
 * creating an empty type.
 */
export async function proposed_types(sql: Sql, kb_id: Uuid): Promise<ProposedType[]> {
  const rows = await q<{ form: string; entity_count: number | string; example: string | null }>(
    sql,
    `SELECT e.proposed_type AS form,
            count(*) AS entity_count,
            (array_agg(e.canonical_name ORDER BY e.created_at))[1] AS example
     FROM entities e
     WHERE e.kb_id = $1 AND e.merged_into IS NULL AND e.proposed_type IS NOT NULL
       -- A type a user already dismissed does not show up as a candidate
       -- again.
       AND NOT EXISTS (SELECT 1 FROM ontology_misses m
                       WHERE m.kb_id = $1 AND m.kind = 'entity_type'
                         AND m.key = e.proposed_type AND m.dismissed_at IS NOT NULL)
     GROUP BY e.proposed_type
     ORDER BY entity_count DESC, form`,
    [kb_id],
  );
  return rows.map((r) => ({ form: r.form, entity_count: Number(r.entity_count), example: r.example }));
}

/**
 * Move entities that proposed any type in `forms` onto `type_id`. Returns
 * [batch id, number of entities moved].
 *
 * Symmetric with the predicate side's `adopt_proposed_predicates` in
 * graph.ts: this only creates the type and does not touch entities; the
 * ontology grows but the graph does not improve on its own -- entities
 * that proposed the model's type would keep sitting under concept.
 *
 * An entity is a mutable row (the P0 PATCH edits it directly), so this is
 * a plain UPDATE. A revert reads the pre-change type from the ledger,
 * rather than following a supersedes chain.
 */
export async function adopt_proposed_types(
  sql: Sql,
  kb_id: Uuid,
  type_id: Uuid,
  forms: string[],
  // null = the engine acted automatically (a cleanup claim after the
  // ontology grew a new type, with no human clicking anything).
  actor: Uuid | null,
): Promise<[Uuid, number]> {
  const batch_id = newId();
  if (forms.length === 0) {
    return [batch_id, 0];
  }
  // An entity already on the target type does not count as a change, and
  // does not go into the ledger -- a revert must not push it back.
  //
  // IS DISTINCT FROM, not <>: after decision 0009, type_id can be NULL,
  // and NULL <> uuid evaluates to NULL, not true -- that row would get
  // silently filtered out, and it happens that almost every entity
  // carrying a proposed_type has no type decided yet, so the whole claim
  // feature would quietly do nothing.
  const targets = await q<{ id: Uuid; type_id: Uuid | null; canonical_name: string }>(
    sql,
    `SELECT id, type_id, canonical_name FROM entities
     WHERE kb_id = $1 AND merged_into IS NULL
       -- An entity a human already decided is not claimed here. This
       -- also makes unadopt naturally correct: a human row never enters
       -- an adoption batch, so a revert never touches it, and does not
       -- need to restore type_source separately.
       AND type_source <> 'human'
       AND proposed_type = ANY($2) AND type_id IS DISTINCT FROM $3`,
    [kb_id, forms, type_id],
  );

  const names = new Set<string>();
  let moved = 0;
  for (const { id: entity_id, type_id: from_type, canonical_name: name } of targets) {
    await sql.begin(async (tx_raw) => {
      const tx = tx_raw as unknown as Sql;
      await exec(
        tx,
        // actor set = a human clicked Approve in the UI, and vouched for
        // this type -> protected. actor null = an automatic cleanup
        // claim after the ontology grew a new type, with no human
        // clicking anything.
        `UPDATE entities
            SET type_id = $2, proposed_type = NULL, updated_at = now(),
                type_source = CASE WHEN $3::uuid IS NULL THEN 'inferred' ELSE 'human' END
         WHERE id = $1`,
        [entity_id, type_id, actor],
      );
      await exec(
        tx,
        `INSERT INTO entity_retypes
            (batch_id, kb_id, entity_id, from_type_id, to_type_id, actor_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [batch_id, kb_id, entity_id, from_type, type_id, actor],
      );
    });
    names.add(name);
    moved += 1;
  }
  // The disambiguator suffix falls back to the type label, and a type
  // change must recompute it (same as the P0 entity type change).
  for (const n of names) {
    await refresh_disambiguators(sql, kb_id, n);
  }
  return [batch_id, moved];
}

/**
 * Revert one entity-retype batch: put the entities back on their previous
 * type.
 *
 * The type itself is not deleted -- same reasoning as the predicate side:
 * an entity has pointed to it, and "it once existed" is history.
 * `proposed_type` is restored too, or those entities could never be
 * claimed again after the revert.
 */
export async function unadopt_types(sql: Sql, kb_id: Uuid, batch_id: Uuid): Promise<number> {
  // from_type_id can be NULL: after decision 0009, the most common retype
  // is "from no type to a type", and a revert puts it back to no type.
  // Parsing it as a Uuid would crash right here.
  const rows = await q<{ entity_id: Uuid; from_type_id: Uuid | null; key: string }>(
    sql,
    `SELECT r.entity_id, r.from_type_id, t.key
     FROM entity_retypes r JOIN entity_types t ON t.id = r.to_type_id
     WHERE r.batch_id = $1 AND r.kb_id = $2 AND r.reverted_at IS NULL`,
    [batch_id, kb_id],
  );
  if (rows.length === 0) {
    throw AppError.notFound();
  }
  const names: string[] = [];
  let reverted = 0;
  await sql.begin(async (tx_raw) => {
    const tx = tx_raw as unknown as Sql;
    for (const { entity_id, from_type_id, key } of rows) {
      const row = await qOpt<{ canonical_name: string }>(
        tx,
        `UPDATE entities SET type_id = $2, proposed_type = $3, updated_at = now()
         WHERE id = $1 RETURNING canonical_name`,
        [entity_id, from_type_id, key],
      );
      if (row) {
        names.push(row.canonical_name);
      }
      reverted += 1;
    }
    await exec(
      tx,
      `UPDATE entity_retypes SET reverted_at = now()
       WHERE batch_id = $1 AND kb_id = $2 AND reverted_at IS NULL`,
      [batch_id, kb_id],
    );
  });
  for (const n of names) {
    await refresh_disambiguators(sql, kb_id, n);
  }
  return reverted;
}

/** Shape a proposed type into a key: lowercase, non-alphanumeric characters become underscores, and repeats collapse. "AI Model" becomes "ai_model", matching the character set validate_key allows. */
function normalize_type_key(s: string): string {
  let out = "";
  let last_us = true; // A leading underscore also counts as a repeat.
  for (const c of s.trim()) {
    if (/[a-zA-Z0-9]/.test(c)) {
      out += c.toLowerCase();
      last_us = false;
    } else if (!last_us) {
      out += "_";
      last_us = true;
    }
  }
  while (out.endsWith("_")) {
    out = out.slice(0, -1);
  }
  return out.slice(0, 40);
}

/**
 * Claim entities whose proposed type is already in the ontology, but who
 * are still sitting under concept.
 *
 * `adopt_proposed_types` only runs at the moment a type is created, so an
 * entity extracted after the type already exists never gets picked up on
 * its own -- and that is the common case: the ontology grows in a first
 * pass, and later documents keep producing proposals. This sweep catches
 * up on those.
 *
 * It only matches an exact same name after normalizing, and does not
 * guess. A wrong guess puts an entity in the wrong type, and "wait for the
 * next pass" costs almost nothing.
 */
export async function sweep_proposed_types(
  sql: Sql,
  kb_id: Uuid,
  actor: Uuid | null,
): Promise<[Uuid, number][]> {
  const pending = await proposed_types(sql, kb_id);
  const existing = await q<{ id: Uuid; key: string }>(sql, `SELECT id, key FROM entity_types WHERE kb_id = $1`, [
    kb_id,
  ]);
  const out: [Uuid, number][] = [];
  for (const p of pending) {
    const norm = normalize_type_key(p.form);
    const match = existing.find((e) => e.key === norm);
    if (!match) {
      continue;
    }
    const [batch, n] = await adopt_proposed_types(sql, kb_id, match.id, [p.form], actor);
    if (n > 0) {
      out.push([batch, n]);
    }
  }
  return out;
}

/** An entity waiting for type refinement, together with everything used to judge what it is. */
export interface TypeCandidateSubject {
  id: Uuid;
  canonical_name: string;
  aliases: string[];
  /**
   * The type it currently has, which may be missing (decision 0009: not
   * decided yet is NULL). "coarse" in the name is historical -- extraction
   * can also give a specific type directly today, and it can be wrong
   * (observed: "Shaoxing" to address), so this may also be the type that
   * needs correcting.
   */
  coarse_key: string | null;
  coarse_id: Uuid | null;
  /**
   * The current type's description. Adjudication judges "is the current
   * type right", and the key alone is not enough -- an imported
   * ontology's key is often not self-explanatory ("entry_point" -- what
   * is that?).
   */
  coarse_description: string | null;
  /** The type name the model reported at extraction time. Only set when the vocabulary has no matching type. */
  proposed_type: string | null;
  /**
   * What the model said about the entity itself, present for every
   * entity.
   *
   * This is the strongest signal, because it turns the task from
   * "understand what this is" back into "which ontology type is called
   * this" -- a short name against a short label. The failure observed in
   * practice happened on the other end: matching a Chinese profile
   * against schema.org's "A software application." compares two things
   * of very different shape.
   */
  specific_type: string | null;
  /**
   * The predicates it takes part in, with the other side's name
   * ("produces DeepBlue", "leads by Zhang Wei"). Accumulated across
   * documents -- this is exactly what extraction does not have at the
   * time.
   */
  roles: string[];
  /**
   * Evidence quotes, a few sentences at most. Only quotes where this
   * entity is the subject: an object-position quote talks about the
   * subject instead. "Shanghai Pudong New Area" as the object of
   * located_in has a quote reading "Nebula Tech (Shanghai) Co., Ltd. is a
   * joint-stock company registered in Shanghai Pudong New Area", with the
   * sentence's real weight on "joint-stock company" -- observed in
   * practice, that version's retrieval returned only corporation-like
   * candidates.
   */
  quotes: string[];
  fact_count: number;
}

/**
 * Entities worth sending for type refinement: entities with **no type
 * yet**, or entities for which the model reported a type outside the
 * vocabulary.
 *
 * An entity already typed specifically is left alone -- rejudging it only
 * risks making it worse, never better.
 */
export async function entities_for_type_resolution(
  sql: Sql,
  kb_id: Uuid,
  limit: number,
): Promise<TypeCandidateSubject[]> {
  const rows = await q<{
    id: Uuid;
    canonical_name: string;
    aliases: string[];
    coarse_key: string | null;
    coarse_id: Uuid | null;
    coarse_description: string | null;
    proposed_type: string | null;
    specific_type: string | null;
    roles: string[];
    quotes: string[];
    fact_count: number | string;
  }>(
    sql,
    `SELECT e.id, e.canonical_name, e.aliases, t.key AS coarse_key, t.id AS coarse_id,
            t.description AS coarse_description,
            e.proposed_type, e.specific_type,
            -- The other side writes its **name**, not its type key.
            -- Writing the key would defeat the purpose: the query would
            -- contain words like organization, product, event -- exactly
            -- the classes retrieval is trying to find -- so the
            -- candidates would just be the words already in the profile.
            -- Observed in practice: "Zhang Wei"'s profile is leads ->
            -- organization, works_at -> organization, ..., and the
            -- candidates that came back were corporation, organization,
            -- business_entity_type -- retrieval found the profile itself,
            -- not what this person is.
            ARRAY(
              SELECT DISTINCT COALESCE(rt.key, fact_surface_predicate(f.id))
                              || CASE WHEN f.subject_id = e.id THEN ' ' ELSE ' by ' END
                              || coalesce(oe.canonical_name, 'a value')
              FROM facts f
              LEFT JOIN relation_types rt ON rt.id = f.predicate_id
              LEFT JOIN entities oe ON oe.id = CASE WHEN f.subject_id = e.id
                                                   THEN f.object_id ELSE f.subject_id END
              WHERE f.kb_id = $1 AND f.invalidated_at IS NULL
                AND (f.subject_id = e.id OR f.object_id = e.id)
                AND COALESCE(rt.key, fact_surface_predicate(f.id)) IS NOT NULL
              LIMIT 12
            ) AS roles,
            ARRAY(
              SELECT DISTINCT ev.quote FROM fact_evidence ev
              JOIN facts f2 ON f2.id = ev.fact_id
              WHERE f2.kb_id = $1 AND f2.invalidated_at IS NULL
                AND f2.subject_id = e.id
                AND ev.quote IS NOT NULL
              LIMIT 3
            ) AS quotes,
            (SELECT count(*) FROM facts f3
             WHERE f3.kb_id = $1 AND f3.invalidated_at IS NULL
               AND (f3.subject_id = e.id OR f3.object_id = e.id)) AS fact_count
     FROM entities e
     LEFT JOIN entity_types t ON t.id = e.type_id
     WHERE e.kb_id = $1 AND e.merged_into IS NULL
       -- An entity a human already decided is not rejudged.
       --
       -- Without this line, the third condition below would pull them
       -- all back in: an entity a human set to organization qualifies as
       -- soon as organization has any subtype, so the engine would
       -- re-adjudicate something a human already decided, every single
       -- pass, and the ledger could only show who changed it after the
       -- fact.
       --
       -- "Not stored" does not mean "not allowed to speak up": if the
       -- engine thinks a human got it wrong, that belongs in the Review
       -- queue, not a silent overwrite. Staying quiet and silently
       -- overwriting are both a loss of truth, just in opposite
       -- directions.
       AND e.type_source <> 'human'
       -- Three kinds are worth a look: entities with **no type yet**,
       -- entities the model reported an out-of-vocabulary type for, and
       -- entities whose current type **itself has subtypes**. The third
       -- kind is the main one: once extraction only recognizes base
       -- types, organization ends up with a large set of more specific
       -- types underneath it, and that is the only place an imported
       -- ontology actually gets used. Checking only the first two misses
       -- this entirely.
       AND (e.type_id IS NULL OR e.proposed_type IS NOT NULL OR e.specific_type IS NOT NULL
            OR EXISTS (SELECT 1 FROM entity_type_parents p WHERE p.parent_id = t.id))
     ORDER BY fact_count DESC, e.created_at
     LIMIT $2`,
    [kb_id, limit],
  );
  return rows.map((r) => ({ ...r, fact_count: Number(r.fact_count) }));
}

/**
 * All descendants of a type, including itself. Refinement can only move
 * down the coarse type's descendants.
 *
 * This is recursive, not one level: the ontology is a DAG
 * (software_application is under creative_work, which is under thing),
 * and checking only one level would block out most correct answers.
 */
export async function descendants_of(sql: Sql, kb_id: Uuid, root: Uuid): Promise<Uuid[]> {
  const rows = await q<{ id: Uuid }>(
    sql,
    `WITH RECURSIVE d(id) AS (
         SELECT $2::uuid
         UNION
         SELECT p.child_id FROM entity_type_parents p JOIN d ON d.id = p.parent_id
     )
     SELECT d.id FROM d JOIN entity_types t ON t.id = d.id WHERE t.kb_id = $1`,
    [kb_id, root],
  );
  return rows.map((r) => r.id);
}

/**
 * Record what the model said about this entity, in the model's own words.
 *
 * **A later write does not overwrite an earlier one** (writes only when
 * NULL), the same rule as set_proposed_type: the same entity gets
 * mentioned across multiple chunks, and the first wording usually comes
 * from the most complete sentence; later chunks often only mention it in
 * passing.
 */
export async function set_specific_type(sql: Sql, entity_id: Uuid, value: string): Promise<void> {
  await exec(
    sql,
    `UPDATE entities SET specific_type = left($2, 80)
     WHERE id = $1 AND specific_type IS NULL`,
    [entity_id, value],
  );
}

/**
 * The most similar **already-typed** entities to this one, together with
 * their types.
 *
 * The second candidate source for type resolution. The first is searching
 * a profile against type descriptions, and its weak point is clear in
 * practice: a Chinese profile against schema.org's "A software
 * application." compares two things of very different shape. This source
 * sidesteps that: **name against name, same language**, and it gets more
 * accurate as the KB grows. "DeepBlue Vector Database" resembles "Milvus",
 * and Milvus is already labeled software_application.
 *
 * It compares both sides' `profile_embedding` (a running average of the
 * contexts the entity appears in) -- one kind of vector against the same
 * kind of vector, not a text profile against a context vector. The cost is
 * zero -- this vector already exists for entity resolution.
 *
 * Known weak point: an entity appearing in only one document has a
 * context vector equal to that one chunk's vector, and entities in the
 * same document become each other's near neighbors. The caller must look
 * at `same_document`, and must not treat it as type evidence on its own.
 */
export async function nearest_typed_entities(
  sql: Sql,
  kb_id: Uuid,
  entity_id: Uuid,
  limit: number,
): Promise<[string, Uuid, string, number, boolean][]> {
  const rows = await q<{
    canonical_name: string;
    id: Uuid;
    key: string;
    distance: number;
    same_document: boolean;
  }>(
    sql,
    `WITH me AS (
         SELECT profile_embedding AS v FROM entities WHERE id = $2 AND kb_id = $1
     ),
     my_docs AS (
         SELECT DISTINCT ev.document_id FROM fact_evidence ev
         JOIN facts f ON f.id = ev.fact_id
         WHERE f.kb_id = $1 AND (f.subject_id = $2 OR f.object_id = $2)
     )
     SELECT e.canonical_name, t.id, t.key,
            (e.profile_embedding <=> (SELECT v FROM me))::float8 AS distance,
            EXISTS (SELECT 1 FROM fact_evidence ev2
                    JOIN facts f2 ON f2.id = ev2.fact_id
                    WHERE f2.kb_id = $1 AND (f2.subject_id = e.id OR f2.object_id = e.id)
                      AND ev2.document_id IN (SELECT document_id FROM my_docs))
            AS same_document
     -- The inner join is the gate: an entity with no type decided yet
     -- (type_id IS NULL) is not a valid answer, and treating it as a
     -- neighbor would spread "not decided yet" onward.
     FROM entities e
     JOIN entity_types t ON t.id = e.type_id
     WHERE e.kb_id = $1 AND e.merged_into IS NULL AND e.id <> $2
       AND e.profile_embedding IS NOT NULL
       AND (SELECT v FROM me) IS NOT NULL
     ORDER BY e.profile_embedding <=> (SELECT v FROM me)
     LIMIT $3`,
    [kb_id, entity_id, limit],
  );
  return rows.map((r) => [r.canonical_name, r.id, r.key, r.distance, r.same_document]);
}

/**
 * Retype entities one by one, writing to the same ledger. Returns [batch
 * id, number of entities moved].
 *
 * The only difference from `adopt_proposed_types` is how entities are
 * picked: that function claims a batch by a `proposed_type` **wording**;
 * this one takes the caller's exact picks -- a type-resolution
 * adjudication decides "this entity is that type", not "everything with
 * this wording is that type".
 *
 * The ledger format matches exactly, so `unadopt_types` can revert it
 * unchanged.
 */
export async function retype_entities(
  sql: Sql,
  kb_id: Uuid,
  picks: [Uuid, Uuid][],
  // null = the engine adjudicated automatically. Same convention as
  // entity_merges.merged_by; entity history uses it to tell "a person
  // changed this" apart from "a high-confidence automatic change".
  actor: Uuid | null,
): Promise<[Uuid, number]> {
  const batch_id = newId();
  let moved = 0;
  const names = new Set<string>();
  class SkipRetype extends Error {}
  // An entity is retyped at most once per batch. The ledger's primary key
  // is (batch_id, entity_id), and a second entry for the same id would
  // collide -- and the caller would then see the whole batch fail with a
  // 500. Guarding here is more reliable than chasing every code path that
  // could produce duplicate picks: a second copy of the same pick has no
  // meaning anyway.
  const seen = new Set<Uuid>();
  for (const [entity_id, type_id] of picks) {
    if (seen.has(entity_id)) {
      continue;
    }
    seen.add(entity_id);
    try {
      await sql.begin(async (tx_raw) => {
        const tx = tx_raw as unknown as Sql;
        // An entity already on the target type does not count as a
        // change, and does not go into the ledger -- a revert must not
        // push it back.
        //
        // **The old type must be read from the CTE.** UPDATE ... RETURNING
        // gives the new value; reading type_id directly from RETURNING
        // would capture the value just written, and a revert would then
        // "restore" the entity to where it already is -- the ledger
        // looks full, but nothing can actually be undone. The condition
        // is folded into the CTE too: the row must still exist, must not
        // be merged away, and must actually be changing.
        //
        // IS DISTINCT FROM, not <>: after decision 0009 the starting
        // point is often NULL, and NULL <> uuid is NULL, not true -- the
        // CTE would come back empty, the UPDATE would touch nothing, and
        // "assign a type to an untyped entity", the single most common
        // case, would silently become a no-op.
        const row = await qOpt<{ type_id: Uuid | null; canonical_name: string }>(
          tx,
          `WITH before AS (
               SELECT id, type_id, canonical_name FROM entities
               WHERE id = $1 AND kb_id = $3 AND merged_into IS NULL
                 AND type_id IS DISTINCT FROM $2
           )
           UPDATE entities e SET type_id = $2, updated_at = now(),
                  type_source = CASE WHEN $4::uuid IS NULL THEN 'inferred' ELSE 'human' END
           FROM before
           WHERE e.id = before.id
           RETURNING before.type_id, before.canonical_name`,
          [entity_id, type_id, kb_id, actor],
        );
        if (!row) {
          throw new SkipRetype();
        }
        await exec(
          tx,
          `INSERT INTO entity_retypes
              (batch_id, kb_id, entity_id, from_type_id, to_type_id, actor_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [batch_id, kb_id, entity_id, row.type_id, type_id, actor],
        );
        names.add(row.canonical_name);
        moved += 1;
      });
    } catch (e) {
      if (e instanceof SkipRetype) continue;
      throw e;
    }
  }
  // The disambiguator suffix falls back to the type label, and a type
  // change must recompute it.
  for (const n of names) {
    await refresh_disambiguators(sql, kb_id, n);
  }
  return [batch_id, moved];
}

/**
 * Coarse-to-specific type pairs a human has approved.
 *
 * The manual-review tier fires on "does this cross a classification axis",
 * and that check in practice most often measures "is the seed type even
 * connected to the imported vocabulary", not risk: schema.org uses its own
 * key for Place, the built-in `location` type has zero subtypes, so every
 * city triggers a question. A pair is about the two types, and an entity
 * only happens to be the one that raised it -- once approved, it should
 * count from then on.
 */
export async function approved_refinements(sql: Sql, kb_id: Uuid): Promise<Set<string>> {
  const rows = await q<{ from_type_id: Uuid; to_type_id: Uuid }>(
    sql,
    `SELECT from_type_id, to_type_id FROM type_refinement_pairs WHERE kb_id = $1`,
    [kb_id],
  );
  // A pair is keyed as "from:to" (a Uuid pair packed into one string),
  // because JavaScript's Set compares objects and tuples by reference,
  // not by value.
  return new Set(rows.map((r) => `${r.from_type_id}:${r.to_type_id}`));
}

/** Record one approved pair. Approving the same pair twice is idempotent. */
export async function approve_refinement(
  sql: Sql,
  kb_id: Uuid,
  from_type_id: Uuid,
  to_type_id: Uuid,
  by: Uuid,
): Promise<void> {
  await exec(
    sql,
    `INSERT INTO type_refinement_pairs (kb_id, from_type_id, to_type_id, approved_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (kb_id, from_type_id, to_type_id) DO NOTHING`,
    [kb_id, from_type_id, to_type_id, by],
  );
}

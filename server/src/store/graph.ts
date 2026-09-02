/**
 * Graph store.
 *
 * This module manages the ontology, entity resolution (first pass: merge
 * entities with the same name and the same type in one KB), the fact
 * ledger, and graph queries.
 */

import { q, qOne, qOpt, exec, type Sql } from "../core/db";
import { AppError } from "../core/errors";
import { newId, type Uuid } from "../core/ids";
import { log } from "../core/log";
import { refresh_disambiguators } from "./resolution";

/** The fate of an old fact at adoption time (`fact_adoptions.mode`). A new row replaces it. */
const ADOPT_SUPERSEDED = "superseded";
/**
 * The target assertion already exists. The old fact merges into it.
 *
 * The old row is invalidated and has no successor. The entity history must
 * read this as "merged", not "withdrawn". Otherwise the UI states an event
 * that did not happen.
 */
const ADOPT_MERGED = "merged";

// The seed step no longer plants any relations, and `ensure_default_ontology`
// is gone.
//
// This file once shipped ten seed relations, a table of Chinese wording, a
// `localized` helper that picked wording by language, and a seed function
// that ran on KB creation, on the first ontology read, and before every
// extraction run. They left in three steps:
//
// - `related_to` (0010): a code-level fallback. Placed in the prompt it
//   became an escape hatch.
// - The other eight (#125): none had a matching signature, and installing a
//   pack did not replace them by name (`worksFor` and `works_at` did not
//   match keys, so both relations survived as two edges). Their axiom bit
//   was always false, so the consistency check could never find a
//   contradiction on them.
// - `mapped_to` (0011): it answers "how do we compute this number", not
//   "what exists in the world". It moved to `concept_mappings`.
//
// The remaining function only walked an empty table. **The ontology has held
// only the user's own imported vocabulary since day one of the KB** — the
// other half of the same change that removed built-in entity classes in
// 0009.

export interface EntityType {
  id: Uuid;
  kb_id: Uuid;
  key: string;
  label: string;
  color: string;
  shape: string;
  builtin: boolean;
  parents: Uuid[];
  primary_parent: Uuid | null;
  iri: string | null;
  description: string;
}

export interface RelationType {
  id: Uuid;
  kb_id: Uuid;
  key: string;
  label: string;
  temporal: string;
  functional: boolean;
  inverse_functional: boolean;
  builtin: boolean;
  description: string;
  iri: string | null;
  kind: string;
  domains: Uuid[];
  ranges: Uuid[];
  datatype: string | null;
  unit: string | null;
}

export async function entity_types(sql: Sql, kb_id: Uuid): Promise<EntityType[]> {
  // Do not use `SELECT *`: `parents` lives in a join table, so `*` cannot
  // reach it. This is the third time this trap has fired. The SQL is inside
  // a string, so `cargo check` (and `tsc`) stay green. Only the first
  // request reports "no column found".
  return q<EntityType>(
    sql,
    `SELECT t.*,
                ARRAY(SELECT p.parent_id FROM entity_type_parents p
                      WHERE p.child_id = t.id) AS parents,
                (SELECT p.parent_id FROM entity_type_parents p
                  WHERE p.child_id = t.id AND p.is_primary) AS primary_parent
         FROM entity_types t WHERE t.kb_id = $1 ORDER BY t.created_at`,
    [kb_id],
  );
}

export async function relation_types(sql: Sql, kb_id: Uuid): Promise<RelationType[]> {
  // Do not use `SELECT *`: domain/range live in a join table, so `*` cannot
  // reach them. The database only reports "no column found" at run time;
  // the SQL text is invisible to the compiler.
  return q<RelationType>(
    sql,
    `SELECT r.*,
            ARRAY(SELECT d.entity_type_id FROM relation_type_domains d
                  WHERE d.relation_type_id = r.id) AS domains,
            ARRAY(SELECT g.entity_type_id FROM relation_type_ranges g
                  WHERE g.relation_type_id = r.id) AS ranges
     FROM relation_types r WHERE r.kb_id = $1 ORDER BY r.created_at`,
    [kb_id],
  );
}

/**
 * Write a fact. Returns [fact id, whether it was newly created].
 *
 * Multiple observations of the same assertion (same subject-predicate-object)
 * do not each get their own row:
 * - A live row with the same `valid_from` already exists → reuse it (evidence
 *   accumulates on that one row).
 * - The new observation carries **no time**, and an open row for the same
 *   assertion already exists → weaken the new statement into the open row
 *   ("works at Nebula Tech" folds into "worked at Nebula Tech since
 *   2021-02"; no dateless duplicate is created).
 * - The new observation **carries a time**, and the same assertion has a
 *   bare row with no start and no end → refine the time: write the new row,
 *   then invalidate the bare row and chain it with `supersedes` (invalidate
 *   and rewrite; the cognitive history stays intact), copying its evidence.
 * - Both carry a time but the times differ → keep both, conservatively (it
 *   may really be two separate intervals, such as leaving and returning).
 *
 * The object of a fact is either an entity (a relation) or a literal (an
 * attribute, or an analytics mapping). Both share the same folding and
 * time-refinement logic.
 */
export type FactObject = { kind: "entity"; id: Uuid } | { kind: "value"; value: unknown };

export async function insert_fact(
  sql: Sql,
  kb_id: Uuid,
  subject_id: Uuid,
  // null = the ontology has no matching relation. The original wording is
  // not lost: it lives in the evidence's `proposed_predicate`, and
  // `fact_surface_predicate()` recovers it for display (see
  // `facts.predicate_id`).
  predicate_id: Uuid | null,
  object_id: Uuid,
  validity: Validity,
  confidence: number,
): Promise<[Uuid, boolean]> {
  return insert_fact_inner(
    sql,
    kb_id,
    subject_id,
    predicate_id,
    { kind: "entity", id: object_id },
    validity,
    confidence,
  );
}

/**
 * `valid_to_precision` set to `"unknown"` means the assertion ended, but the
 * date is not known.
 */
export const ENDED_UNKNOWN = "unknown";

/**
 * Where a fact sits on the **world timeline**: the instant and the
 * granularity at each end.
 *
 * This is a single object, not four separate parameters. There are two
 * `Date | null` fields and two `string | null` fields; swapping two adjacent
 * parameters of the same shape compiles without warning, and the result is a
 * fact with its start and end reversed.
 *
 * The end has three states (the database constraint
 * `facts_to_precision_matches_date` enforces this):
 *
 * | Meaning | `to` | `to_precision` |
 * |---|---|---|
 * | still ongoing | `null` | `null` |
 * | **ended, date unknown** | `null` | `"unknown"` |
 * | ended at a known time | a date | `"year"` / `"month"` / `"day"` |
 *
 * The second row was added later. Before it, `to = null` carried two
 * meanings at once: "still ongoing" and "ended, but we do not know when". A
 * sentence like "former CEO of Weta Digital" — clearly ended, date missing —
 * could only be written as the first case, so the graph asserted something
 * the source text said had already ended.
 */
export class Validity {
  from: Date | null;
  from_precision: string | null;
  to: Date | null;
  to_precision: string | null;

  constructor(init: {
    from?: Date | null;
    from_precision?: string | null;
    to?: Date | null;
    to_precision?: string | null;
  } = {}) {
    this.from = init.from ?? null;
    this.from_precision = init.from_precision ?? null;
    this.to = init.to ?? null;
    this.to_precision = init.to_precision ?? null;
  }

  /** The start is known. The end is unknown or does not apply. */
  static starting(from: Date | null, from_precision: string | null): Validity {
    return new Validity({ from, from_precision });
  }

  /** The source text says the assertion ended, but does not say when. */
  ended_when_unknown(): Validity {
    this.to = null;
    this.to_precision = ENDED_UNKNOWN;
    return this;
  }

  /**
   * Has this assertion stopped holding? **Both kinds of ending count.**
   *
   * This check lives here instead of being repeated as `valid_to.is_some()`
   * at each call site. That shortcut would misread "ended, date unknown" as
   * "still ongoing" — exactly the case the two-precision-column design
   * exists to fix.
   */
  has_ended(): boolean {
    return this.to !== null || this.to_precision === ENDED_UNKNOWN;
  }
}

interface FactSpanRow {
  id: Uuid;
  valid_from: Date | null;
  valid_to: Date | null;
}

function same_instant(a: Date | null, b: Date | null): boolean {
  if (a === null || b === null) return a === b;
  return a.getTime() === b.getTime();
}

/** Order two optional dates. `null` sorts before any real date. */
function compare_opt_date(a: Date | null, b: Date | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a.getTime() - b.getTime();
}

async function insert_fact_inner(
  sql: Sql,
  kb_id: Uuid,
  subject_id: Uuid,
  // null = the ontology has no matching relation. The original wording is
  // not lost: it lives in the evidence's `proposed_predicate`, and
  // `fact_surface_predicate()` recovers it for display (see
  // `facts.predicate_id`).
  predicate_id: Uuid | null,
  object: FactObject,
  validity: Validity,
  confidence: number,
): Promise<[Uuid, boolean]> {
  const same_sql =
    object.kind === "entity"
      ? `SELECT id, valid_from, valid_to FROM facts
             WHERE kb_id = $1 AND subject_id = $2 AND predicate_id = $3 AND object_id = $4
               AND invalidated_at IS NULL`
      : `SELECT id, valid_from, valid_to FROM facts
             WHERE kb_id = $1 AND subject_id = $2 AND predicate_id = $3 AND object_value = $4
               AND object_id IS NULL AND invalidated_at IS NULL`;
  const object_bind = object.kind === "entity" ? object.id : object.value;
  const same = await q<FactSpanRow>(sql, same_sql, [kb_id, subject_id, predicate_id, object_bind]);

  // Exact duplicate: same valid_from → reuse.
  const exact = same.find((r) => same_instant(r.valid_from, validity.from));
  if (exact) {
    return [exact.id, false];
  }
  // Weakened statement: the new observation has no time, and the same
  // assertion already has an open row → fold in (take the open row with the
  // latest start).
  if (validity.from === null && !validity.has_ended()) {
    const open_rows = same.filter((r) => r.valid_to === null);
    if (open_rows.length > 0) {
      let best = open_rows[0]!;
      for (const r of open_rows.slice(1)) {
        if (compare_opt_date(r.valid_from, best.valid_from) > 0) best = r;
      }
      return [best.id, false];
    }
  }
  // Time-refinement candidate: an existing bare row (no start, no end)
  // exists, and this observation carries a start → write, then invalidate
  // the bare row and chain it.
  const refine_target =
    validity.from !== null
      ? (same.find((r) => r.valid_from === null && r.valid_to === null)?.id ?? null)
      : null;

  const id = newId();
  const insert_sql =
    object.kind === "entity"
      ? `INSERT INTO facts (id, kb_id, subject_id, predicate_id, object_id,
                                valid_from, valid_from_precision,
                                valid_to, valid_to_precision, confidence)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`
      : `INSERT INTO facts (id, kb_id, subject_id, predicate_id, object_value,
                                valid_from, valid_from_precision,
                                valid_to, valid_to_precision, confidence)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`;
  await exec(sql, insert_sql, [
    id,
    kb_id,
    subject_id,
    predicate_id,
    object_bind,
    validity.from,
    validity.from_precision,
    validity.to,
    validity.to_precision,
    confidence,
  ]);

  // Time refinement: a bare row (same assertion, no start, no end) is
  // replaced by this timed observation — invalidate and chain it, copying
  // its evidence.
  if (refine_target !== null) {
    await exec(sql, `UPDATE facts SET invalidated_at = now() WHERE id = $1`, [refine_target]);
    await exec(sql, `UPDATE facts SET supersedes = $2 WHERE id = $1`, [id, refine_target]);
    await exec(
      sql,
      // The surface predicate travels with the evidence: refining the time
      // does not change what the source text said.
      `INSERT INTO fact_evidence (fact_id, chunk_id, quote, proposed_predicate, document_id, doc_version)
             SELECT $1, chunk_id, quote, proposed_predicate, document_id, doc_version
             FROM fact_evidence WHERE fact_id = $2
             ON CONFLICT DO NOTHING`,
      [id, refine_target],
    );
  }
  return [id, true];
}

/**
 * A fact with a literal object (the `object_value` channel; analytics
 * mappings were its first consumer).
 *
 * Deduplication: only one live fact is kept for the same (S, P) with an
 * identical `object_value`.
 */
export async function insert_value_fact(
  sql: Sql,
  kb_id: Uuid,
  subject_id: Uuid,
  // null = the ontology has no matching relation. The original wording is
  // not lost: it lives in the evidence's `proposed_predicate`, and
  // `fact_surface_predicate()` recovers it for display (see
  // `facts.predicate_id`).
  predicate_id: Uuid | null,
  object_value: unknown,
  validity: Validity,
  confidence: number,
): Promise<[Uuid, boolean]> {
  return insert_fact_inner(
    sql,
    kb_id,
    subject_id,
    predicate_id,
    { kind: "value", value: object_value },
    validity,
    confidence,
  );
}

/**
 * `proposed`: the wording the model actually used in this chunk. When it
 * matches the ontology it equals the relation key. When the wording is
 * outside the ontology and the fact does not attach to a relation, this is
 * the only place the original wording survives — the fact row only says
 * "related", while the source text said "runs on".
 */
export async function add_evidence(
  sql: Sql,
  fact_id: Uuid,
  chunk_id: Uuid,
  quote: string | null,
  proposed: string | null,
): Promise<void> {
  // Recording evidence also records its version: which document, which
  // version (the basis for S3 version reconciliation and "stale evidence").
  // On conflict, fill in the surface predicate instead of skipping the whole
  // row: re-extraction mostly hits existing (fact, chunk) pairs, and
  // `DO NOTHING` would leave that column permanently empty for existing
  // evidence. Only fill it when the existing value is empty; do not
  // overwrite it — for the same chunk and the same fact, the first wording
  // recorded is its wording.
  await exec(
    sql,
    `INSERT INTO fact_evidence (fact_id, chunk_id, quote, proposed_predicate, document_id, doc_version)
         SELECT $1, $2, $3, left($4, 120), c.document_id, c.doc_version FROM chunks c WHERE c.id = $2
         ON CONFLICT (fact_id, chunk_id) DO UPDATE
           SET proposed_predicate = COALESCE(fact_evidence.proposed_predicate, EXCLUDED.proposed_predicate)`,
    [fact_id, chunk_id, quote, proposed],
  );
}

export interface GraphNode {
  id: Uuid;
  name: string;
  type_key: string | null;
  type_label: string | null;
  color: string;
  shape: string;
  disambiguator: string | null;
  degree: number;
}

export interface GraphEdge {
  id: Uuid;
  source: Uuid;
  target: Uuid;
  predicate: string | null;
  label: string | null;
  inferred: boolean;
  derived: boolean;
  rule: string | null;
  premises: Uuid[];
  valid_from: Date | null;
  valid_to: Date | null;
  confidence: number;
}

/**
 * The node-fetching SQL shared by every graph query.
 *
 * **LEFT JOIN, not JOIN** (0009). An entity with no assigned type is still a
 * node on the graph: it has a name, facts, evidence — it is only missing a
 * label. An inner join would make it disappear entirely: the facts stay in
 * the database, but the graph shows no trace of it. That is the hardest kind
 * of data loss to notice.
 *
 * `key` and `label` are left `NULL`; **color and shape get default values**:
 * the former is identity — if there is none, say so. The latter is
 * something the canvas must have to render at all; a gray dot is exactly
 * what "not decided yet" should look like.
 */
const NODE_SQL = `SELECT e.id, e.canonical_name AS name, t.key AS type_key,
        t.label AS type_label,
        coalesce(t.color, '#94a3b8') AS color,
        coalesce(t.shape, 'circle') AS shape,
        e.disambiguator,
        (SELECT count(*) FROM facts f
         WHERE (f.subject_id = e.id OR f.object_id = e.id) AND f.invalidated_at IS NULL) AS degree
     FROM entities e LEFT JOIN entity_types t ON t.id = e.type_id`;

interface CountRow {
  count: string | number;
}

/**
 * The graph overview: the top-N entities by degree, and the edges between
 * them.
 *
 * `at`: server-side as-of. Only edges valid at time T are returned (started
 * at or before T, or unknown start; ended after T, or still open). The
 * front-end time slider does its own local filtering and does not pass this
 * parameter; this is the time-travel entry point for API/MCP consumers.
 *
 * **The real totals are returned too.** How many nodes get drawn is a
 * rendering decision; how many exist is a fact about the knowledge base.
 * These two used to share one number in the UI — a KB with ten thousand
 * entities always showed 150 in the corner, and that is a rendering cap, not
 * the size of the KB. The cap itself is reasonable (nobody can read a
 * ten-thousand-node drawing); presenting it as the total is what was
 * misleading.
 */
export async function overview(
  sql: Sql,
  kb_id: Uuid,
  limit: number,
  at: Date | null,
): Promise<[GraphNode[], GraphEdge[], number, number]> {
  const nodes = await q<GraphNode>(
    sql,
    `${NODE_SQL} WHERE e.kb_id = $1 AND e.merged_into IS NULL ORDER BY degree DESC, e.created_at LIMIT $2`,
    [kb_id, limit],
  );

  const ids = nodes.map((n) => n.id);
  const edges = await edges_among(sql, kb_id, ids, at);

  // Count with the same rules as the canvas: merged entities do not count,
  // invalidated facts do not count, and attribute facts (literal object)
  // draw no edge so they do not count either. A different rule here would
  // make the "325" in "150 / 325" disagree with a number the user sees
  // elsewhere.
  const total_nodes_row = await qOne<CountRow>(
    sql,
    `SELECT count(*) FROM entities WHERE kb_id = $1 AND merged_into IS NULL`,
    [kb_id],
  );
  const total_edges_row = await qOne<CountRow>(
    sql,
    `SELECT (SELECT count(*) FROM facts
                  WHERE kb_id = $1 AND invalidated_at IS NULL AND object_id IS NOT NULL)
              + (SELECT count(*) FROM derived_facts
                  WHERE kb_id = $1 AND invalidated_at IS NULL)`,
    [kb_id],
  );
  return [nodes, edges, Number(total_nodes_row.count), Number(total_edges_row.count)];
}

async function edges_among(
  sql: Sql,
  kb_id: Uuid,
  ids: Uuid[],
  at: Date | null,
): Promise<GraphEdge[]> {
  if (ids.length === 0) {
    return [];
  }
  // **Derived edges are pulled in with an explicit UNION.** They live in
  // `derived_facts`, not in `facts` — so every read path that wants to show
  // inferred results has to spell this out, as done here. Forgetting it
  // means the inference is invisible, not that it is treated as someone's
  // assertion (that is exactly what splitting the tables buys us).
  //
  // The graph wants them, because "this edge was inferred" is itself
  // information the user should see; the `derived` flag lets the UI draw
  // the difference, and also lets people filter it out entirely.
  return q<GraphEdge>(
    sql,
    `SELECT f.id, f.subject_id AS source, f.object_id AS target,
                COALESCE(r.key, fact_surface_predicate(f.id)) AS predicate,
                COALESCE(r.label, fact_surface_predicate(f.id)) AS label,
                r.id IS NULL AS inferred, FALSE AS derived, NULL::text AS rule,
                ARRAY[]::uuid[] AS premises,
                f.valid_from, f.valid_to, f.confidence
         FROM facts f LEFT JOIN relation_types r ON r.id = f.predicate_id
         WHERE f.kb_id = $1 AND f.invalidated_at IS NULL AND f.object_id IS NOT NULL
           AND f.subject_id = ANY($2) AND f.object_id = ANY($2)
           AND ($3::timestamptz IS NULL
                OR ((f.valid_from IS NULL OR f.valid_from <= $3)
                    AND (f.valid_to IS NULL OR f.valid_to > $3)))
         UNION ALL
         SELECT d.id, d.subject_id AS source, d.object_id AS target,
                r.key AS predicate, r.label AS label,
                FALSE AS inferred, TRUE AS derived, ru.kind AS rule,
                ARRAY(SELECT fd.premise_fact_id FROM fact_derivations fd
                       WHERE fd.derived_fact_id = d.id ORDER BY fd.seq) AS premises,
                d.valid_from, d.valid_to, d.confidence
         FROM derived_facts d JOIN relation_types r ON r.id = d.predicate_id
                              JOIN rules ru ON ru.id = d.rule_id
         WHERE d.kb_id = $1 AND d.invalidated_at IS NULL
           AND d.subject_id = ANY($2) AND d.object_id = ANY($2)
           AND ($3::timestamptz IS NULL
                OR ((d.valid_from IS NULL OR d.valid_from <= $3)
                    AND (d.valid_to IS NULL OR d.valid_to > $3)))`,
    [kb_id, ids, at],
  );
}

interface TouchingRow {
  subject_id: Uuid;
  object_id: Uuid | null;
}

/** Neighborhood expansion (BFS, at most 2 hops, node count capped). */
export async function neighborhood(
  sql: Sql,
  kb_id: Uuid,
  entity_id: Uuid,
  hops: number,
  at: Date | null,
): Promise<[GraphNode[], GraphEdge[]]> {
  const MAX_NODES = 300;
  const seen = new Set<Uuid>([entity_id]);
  let frontier: Uuid[] = [entity_id];

  const clamped_hops = Math.min(Math.max(hops, 1), 2);
  for (let i = 0; i < clamped_hops; i++) {
    if (frontier.length === 0 || seen.size >= MAX_NODES) {
      break;
    }
    const touching = await q<TouchingRow>(
      sql,
      `SELECT subject_id, object_id FROM facts
             WHERE kb_id = $1 AND invalidated_at IS NULL AND object_id IS NOT NULL
               AND (subject_id = ANY($2) OR object_id = ANY($2))`,
      [kb_id, frontier],
    );

    const next: Uuid[] = [];
    for (const { subject_id, object_id } of touching) {
      for (const id of [subject_id, object_id]) {
        if (id === null) continue;
        if (seen.size >= MAX_NODES) {
          break;
        }
        if (!seen.has(id)) {
          seen.add(id);
          next.push(id);
        }
      }
    }
    frontier = next;
  }

  const ids = Array.from(seen);
  const nodes = await q<GraphNode>(sql, `${NODE_SQL} WHERE e.kb_id = $1 AND e.id = ANY($2)`, [
    kb_id,
    ids,
  ]);
  const edges = await edges_among(sql, kb_id, ids, at);
  return [nodes, edges];
}

/**
 * Find entities by name. **The real total is returned too** — "prefer
 * splitting over merging" naturally produces many entities with the same
 * name. With a fixed page of ten, the one the user wants may not be in that
 * page, and the UI gives no hint of that.
 */
export async function search_entities(
  sql: Sql,
  kb_id: Uuid,
  query: string,
  limit: number,
  offset: number,
): Promise<[GraphNode[], number]> {
  const pattern = `%${query.trim()}%`;
  const nodes = await q<GraphNode>(
    sql,
    `${NODE_SQL} WHERE e.kb_id = $1 AND e.merged_into IS NULL
         AND e.canonical_name ILIKE $2
         ORDER BY degree DESC, e.canonical_name LIMIT $3 OFFSET $4`,
    [kb_id, pattern, limit, offset],
  );
  const total_row = await qOne<CountRow>(
    sql,
    `SELECT count(*) FROM entities e
          WHERE e.kb_id = $1 AND e.merged_into IS NULL AND e.canonical_name ILIKE $2`,
    [kb_id, pattern],
  );
  return [nodes, Number(total_row.count)];
}

export interface EntityFact {
  id: Uuid;
  direction: string;
  predicate_key: string | null;
  predicate_label: string | null;
  inferred: boolean;
  temporal: string | null;
  other_id: Uuid | null;
  other_name: string | null;
  object_value: unknown | null;
  valid_from: Date | null;
  valid_from_precision: string | null;
  valid_to: Date | null;
  valid_to_precision: string | null;
  confidence: number;
  evidence_count: number;
  stale: boolean;
  corrected: boolean;
  last_evidence_time: Date | null;
}

/** Entity detail: node info plus the fact timeline. */
export async function entity_detail(
  sql: Sql,
  kb_id: Uuid,
  entity_id: Uuid,
): Promise<[GraphNode, EntityFact[]]> {
  const node = await qOpt<GraphNode>(sql, `${NODE_SQL} WHERE e.kb_id = $1 AND e.id = $2`, [
    kb_id,
    entity_id,
  ]);
  if (node === null) throw AppError.notFound();

  const facts = await q<EntityFact>(
    sql,
    `SELECT f.id,
                CASE WHEN f.subject_id = $2 THEN 'out' ELSE 'in' END AS direction,
                COALESCE(r.key, fact_surface_predicate(f.id)) AS predicate_key,
                COALESCE(r.label, fact_surface_predicate(f.id)) AS predicate_label,
                r.id IS NULL AS inferred, r.temporal,
                CASE WHEN f.subject_id = $2 THEN f.object_id ELSE f.subject_id END AS other_id,
                o.canonical_name AS other_name, f.object_value,
                f.valid_from, f.valid_from_precision, f.valid_to, f.valid_to_precision, f.confidence,
                (SELECT count(*) FROM fact_evidence fe WHERE fe.fact_id = f.id) AS evidence_count,
                (EXISTS (SELECT 1 FROM fact_evidence fe WHERE fe.fact_id = f.id)
                 AND NOT EXISTS (SELECT 1 FROM fact_evidence fe
                                 JOIN chunks c ON c.id = fe.chunk_id
                                 WHERE fe.fact_id = f.id AND c.superseded_at IS NULL)
                ) AS stale,
                (f.supersedes IS NOT NULL) AS corrected,
                (SELECT MAX(COALESCE(d.doc_time, d.created_at))
                 FROM fact_evidence fe JOIN documents d ON d.id = fe.document_id
                 WHERE fe.fact_id = f.id) AS last_evidence_time
         FROM facts f
         LEFT JOIN relation_types r ON r.id = f.predicate_id
         LEFT JOIN entities o
           ON o.id = CASE WHEN f.subject_id = $2 THEN f.object_id ELSE f.subject_id END
         WHERE f.kb_id = $1 AND f.invalidated_at IS NULL
           AND (f.subject_id = $2 OR f.object_id = $2)
         ORDER BY f.valid_from NULLS LAST, f.recorded_at`,
    [kb_id, entity_id],
  );

  return [node, facts];
}

/**
 * Manually correct an entity's type or name. Returns [snapshot before,
 * state after] so the caller can record it in the audit log.
 *
 * A wrong type or a badly extracted name used to mean re-extracting the
 * whole KB. Extraction gives a first guess, not a final ruling.
 *
 * Same name is not blocked: two entities with the same name and the same
 * type are the normal result of "prefer splitting over merging" (two people
 * named Zhang Wei). Blocking it would make it impossible to record the
 * second one. The caller finds the collision afterward and suggests a
 * merge; see `same_name_peers`.
 */
export async function update_entity(
  sql: Sql,
  kb_id: Uuid,
  entity_id: Uuid,
  type_id: Uuid | null,
  canonical_name: string | null,
): Promise<[GraphNode, GraphNode]> {
  const before = await qOpt<GraphNode>(
    sql,
    `${NODE_SQL} WHERE e.kb_id = $1 AND e.id = $2 AND e.merged_into IS NULL`,
    [kb_id, entity_id],
  );
  if (before === null) throw AppError.notFound();

  let new_name: string | null = null;
  if (canonical_name !== null) {
    const n = canonical_name.trim();
    if (n.length === 0) {
      throw AppError.invalid("entity_name_required", "Name cannot be empty");
    }
    // The same limit as the extraction side: crossing this line usually
    // means a whole sentence got taken for a name.
    if ([...n].length > 100) {
      throw AppError.invalid("entity_name_too_long", "Name is too long (max 100)");
    }
    new_name = n;
  }

  if (type_id !== null) {
    const exists = await qOpt<{ id: Uuid }>(
      sql,
      `SELECT id FROM entity_types WHERE id = $1 AND kb_id = $2`,
      [type_id, kb_id],
    );
    if (exists === null) {
      throw AppError.invalid("unknown_entity_type", "No such entity type in this KB");
    }
  }

  await exec(
    sql,
    // Only mark the source as "human" when the type actually changed. This
    // endpoint also renames entities; renaming alone must not silently mark
    // the type's source as human. `$3 IS NULL` in this endpoint means "no
    // type was supplied this time", not "clear the type" — the route layer
    // requires at least one of the two fields, so a three-state distinction
    // is not available here.
    //
    // One thing this cannot do today: since 0009, "no type" can be a human
    // decision (looked at it, no matching class in the ontology exists),
    // and this endpoint cannot express that. Fixing it needs the request
    // body to distinguish "not supplied" from "explicitly cleared" — a
    // separate change.
    `UPDATE entities
         SET type_id = COALESCE($3, type_id),
             canonical_name = COALESCE($4, canonical_name),
             type_source = CASE WHEN $3::uuid IS NULL THEN type_source ELSE 'human' END,
             updated_at = now()
         WHERE id = $1 AND kb_id = $2 AND merged_into IS NULL`,
    [entity_id, kb_id, type_id, new_name],
  );

  // The disambiguation suffix depends on grouping by name and on the type
  // label (used as its fallback). Both just changed. A rename must refresh
  // both groups: the old name's group may drop to 1 (the suffix should
  // clear), and the new name's group may grow to 2.
  if (new_name !== null && new_name.toLowerCase() !== before.name.toLowerCase()) {
    await refresh_disambiguators(sql, kb_id, before.name);
    await refresh_disambiguators(sql, kb_id, new_name);
  } else if (type_id !== null) {
    await refresh_disambiguators(sql, kb_id, before.name);
  }

  const after = await qOne<GraphNode>(sql, `${NODE_SQL} WHERE e.kb_id = $1 AND e.id = $2`, [
    kb_id,
    entity_id,
  ]);
  return [before, after];
}

/**
 * Other live entities with the same name (case-insensitive) as the given
 * entity — used to suggest "merge these?" after a rename. This only
 * reports; it does not block. Deciding whether they are really the same
 * thing is up to a human.
 */
export async function same_name_peers(sql: Sql, kb_id: Uuid, entity_id: Uuid): Promise<GraphNode[]> {
  return q<GraphNode>(
    sql,
    `${NODE_SQL} WHERE e.kb_id = $1 AND e.merged_into IS NULL AND e.id <> $2
           AND lower(e.canonical_name) = (SELECT lower(canonical_name) FROM entities WHERE id = $2)
         ORDER BY degree DESC LIMIT 10`,
    [kb_id, entity_id],
  );
}

export interface FactReviewItem {
  id: Uuid;
  subject_name: string;
  predicate_label: string | null;
  object_name: string | null;
  valid_from: Date | null;
  valid_to: Date | null;
  confidence: number;
  evidence_count: number;
  quote: string | null;
}

/** Low-confidence live facts (the review page). */
export async function low_confidence_facts(
  sql: Sql,
  kb_id: Uuid,
  below: number,
  limit: number,
  offset: number,
): Promise<FactReviewItem[]> {
  return q<FactReviewItem>(
    sql,
    `SELECT f.id, s.canonical_name AS subject_name, COALESCE(r.label, fact_surface_predicate(f.id)) AS predicate_label,
                COALESCE(o.canonical_name, f.object_value->>'summary') AS object_name,
                f.valid_from, f.valid_to, f.confidence,
                (SELECT count(*) FROM fact_evidence fe WHERE fe.fact_id = f.id) AS evidence_count,
                (SELECT fe.quote FROM fact_evidence fe
                 WHERE fe.fact_id = f.id AND fe.quote IS NOT NULL LIMIT 1) AS quote
         FROM facts f
         JOIN entities s ON s.id = f.subject_id
         LEFT JOIN relation_types r ON r.id = f.predicate_id
         LEFT JOIN entities o ON o.id = f.object_id
         WHERE f.kb_id = $1 AND f.invalidated_at IS NULL AND f.confidence < $2
         ORDER BY f.confidence, f.recorded_at DESC
         LIMIT $3 OFFSET $4`,
    [kb_id, below, limit, offset],
  );
}

/**
 * Live facts whose "evidence is all stuck on an old version" (S3, third
 * cut: knowledge that the new document version no longer confirms).
 *
 * The check is derived purely from chunk survival; the claim mechanism
 * guarantees that evidence in unchanged paragraphs is not mistakenly
 * flagged. This never deletes anything automatically (not mentioned again
 * does not mean untrue); deleting or closing it is a decision for the human
 * in Review.
 */
export async function stale_facts(
  sql: Sql,
  kb_id: Uuid,
  limit: number,
  offset: number,
): Promise<FactReviewItem[]> {
  return q<FactReviewItem>(
    sql,
    `SELECT f.id, s.canonical_name AS subject_name, COALESCE(r.label, fact_surface_predicate(f.id)) AS predicate_label,
                COALESCE(o.canonical_name, f.object_value->>'summary') AS object_name,
                f.valid_from, f.valid_to, f.confidence,
                (SELECT count(*) FROM fact_evidence fe WHERE fe.fact_id = f.id) AS evidence_count,
                (SELECT fe.quote FROM fact_evidence fe
                 WHERE fe.fact_id = f.id AND fe.quote IS NOT NULL LIMIT 1) AS quote
         FROM facts f
         JOIN entities s ON s.id = f.subject_id
         LEFT JOIN relation_types r ON r.id = f.predicate_id
         LEFT JOIN entities o ON o.id = f.object_id
         WHERE f.kb_id = $1 AND f.invalidated_at IS NULL
           AND EXISTS (SELECT 1 FROM fact_evidence fe WHERE fe.fact_id = f.id)
           AND NOT EXISTS (SELECT 1 FROM fact_evidence fe
                           JOIN chunks c ON c.id = fe.chunk_id
                           WHERE fe.fact_id = f.id AND c.superseded_at IS NULL)
         ORDER BY f.recorded_at DESC
         LIMIT $2 OFFSET $3`,
    [kb_id, limit, offset],
  );
}

/** Human confirmation of a low-confidence fact: raise confidence to 1.0. */
export async function confirm_fact(sql: Sql, kb_id: Uuid, fact_id: Uuid): Promise<void> {
  const res = await exec(
    sql,
    `UPDATE facts SET confidence = 1.0 WHERE id = $1 AND kb_id = $2 AND invalidated_at IS NULL`,
    [fact_id, kb_id],
  );
  if (res.count === 0) {
    throw AppError.notFound();
  }
  // This once also invalidated the old mapping for the same (concept,
  // source) pair when a `mapped_to` fact was confirmed. Mappings have since
  // moved out of the ledger (0011; `concept_mappings` manages its own
  // uniqueness), so that statement always matched zero rows. It was
  // removed.
}

/** Human rejection of a fact: invalidate it (the ledger is append-only, never DELETE). */
export async function reject_fact(sql: Sql, kb_id: Uuid, fact_id: Uuid): Promise<void> {
  const res = await exec(
    sql,
    `UPDATE facts SET invalidated_at = now()
         WHERE id = $1 AND kb_id = $2 AND invalidated_at IS NULL`,
    [fact_id, kb_id],
  );
  if (res.count === 0) {
    throw AppError.notFound();
  }
}

export interface ChunkFactView {
  chunk_id: Uuid;
  fact_id: Uuid;
  subject_id: Uuid;
  subject: string;
  predicate: string | null;
  inferred: boolean;
  object_id: Uuid | null;
  object: string | null;
  valid_from: Date | null;
  valid_to: Date | null;
  confidence: number;
}

/** The reverse evidence chain: which live facts each chunk of a document produced (document viewer, right panel). */
export async function document_extractions(sql: Sql, document_id: Uuid): Promise<ChunkFactView[]> {
  return q<ChunkFactView>(
    sql,
    `SELECT fe.chunk_id, f.id AS fact_id,
                f.subject_id, s.canonical_name AS subject,
                COALESCE(r.label, fact_surface_predicate(f.id)) AS predicate,
                r.id IS NULL AS inferred,
                f.object_id, o.canonical_name AS object,
                f.valid_from, f.valid_to, f.confidence
         FROM fact_evidence fe
         JOIN chunks c ON c.id = fe.chunk_id AND c.document_id = $1
              AND c.superseded_at IS NULL
         JOIN facts f ON f.id = fe.fact_id AND f.invalidated_at IS NULL
         JOIN entities s ON s.id = f.subject_id
         LEFT JOIN relation_types r ON r.id = f.predicate_id
         LEFT JOIN entities o ON o.id = f.object_id
         ORDER BY c.seq, f.recorded_at`,
    [document_id],
  );
}

export interface EvidenceView {
  proposed_predicate: string | null;
  quote: string | null;
  chunk_id: Uuid;
  document_id: Uuid;
  filename: string;
  seq: number;
  doc_version: number;
  stale: boolean;
}

/**
 * The evidence replay path: this does not filter out superseded evidence —
 * its job is precisely to show old versions. `stale` = the evidence version
 * is behind the document's current version (the UI marks it "from v{n}").
 */
export async function fact_evidence(sql: Sql, fact_id: Uuid): Promise<EvidenceView[]> {
  return q<EvidenceView>(
    sql,
    `SELECT fe.quote, fe.proposed_predicate, fe.chunk_id, c.document_id, d.filename, c.seq,
                c.doc_version,
                c.doc_version < COALESCE(
                    (SELECT MAX(version) FROM document_versions dv
                     WHERE dv.document_id = c.document_id), 1) AS stale
         FROM fact_evidence fe
         JOIN chunks c ON c.id = fe.chunk_id
         JOIN documents d ON d.id = c.document_id
         WHERE fe.fact_id = $1`,
    [fact_id],
  );
}

/**
 * Clear a KB's entire graph layer (the settlement semantics of "Rebuild
 * graph"): entities, facts, evidence, pending review items, conflicts, and
 * merge records are all deleted. The ontology (class and relation
 * definitions) and documents/chunks/embeddings are kept.
 *
 * Two things are deliberately kept: the decision ledger (`audit_events`,
 * self-contained snapshots, still readable after the graph is gone) and the
 * verdict cache (`resolution_verdicts`, so the same-name pair hits it again
 * directly after a rebuild, saving a batch of LLM calls).
 *
 * Returns [entities deleted, facts deleted].
 */
export async function purge_graph(sql: Sql, kb_id: Uuid): Promise<[number, number]> {
  return sql.begin(async (tx_raw) => {
    const tx = tx_raw as unknown as Sql;
    const entity_count_row = await qOne<CountRow>(
      tx,
      `SELECT count(*) FROM entities WHERE kb_id = $1`,
      [kb_id],
    );
    const fact_count_row = await qOne<CountRow>(tx, `SELECT count(*) FROM facts WHERE kb_id = $1`, [
      kb_id,
    ]);

    // Most foreign keys are CASCADE, but two self-references are NO ACTION:
    // clear the reference first, then delete, in this explicit order (this
    // list is itself the definition of "what the graph layer consists of").
    const statements = [
      `DELETE FROM fact_conflicts WHERE kb_id = $1`,
      `DELETE FROM resolution_reviews WHERE kb_id = $1`,
      `DELETE FROM entity_merges WHERE kb_id = $1`,
      `UPDATE facts SET supersedes = NULL WHERE kb_id = $1`,
      `DELETE FROM fact_evidence WHERE fact_id IN (SELECT id FROM facts WHERE kb_id = $1)`,
      `DELETE FROM facts WHERE kb_id = $1`,
      `UPDATE entities SET merged_into = NULL WHERE kb_id = $1`,
      `DELETE FROM entities WHERE kb_id = $1`,
      // Unmatched-wording stats build back up as extraction runs again.
      `DELETE FROM ontology_misses WHERE kb_id = $1`,
    ];
    for (const stmt of statements) {
      await exec(tx, stmt, [kb_id]);
    }
    return [Number(entity_count_row.count), Number(fact_count_row.count)];
  });
}

export interface EntityHistoryEvent {
  fact_id: Uuid | null;
  at: Date;
  kind: string;
  direction: string | null;
  predicate_label: string | null;
  other_name: string | null;
  object_value: unknown | null;
  valid_from: Date | null;
  valid_from_precision: string | null;
  valid_to: Date | null;
  valid_to_precision: string | null;
  confidence: number | null;
  actor_name: string | null;
  action: string | null;
  document_id: Uuid | null;
  filename: string | null;
  quote: string | null;
  from_type_label: string | null;
  to_type_label: string | null;
}

/**
 * An entity's cognitive change history (a timeline of record events).
 *
 * The key difference from `entity_detail`: that one filters on
 * `invalidated_at IS NULL`, so it only answers "what do we currently think
 * is true"; this one does not filter, and answers "when did we start
 * thinking this, and when did we change our mind". The data has always been
 * there — the ledger is append-only, and a correction is a new row plus an
 * invalidated old row, never an overwrite.
 *
 * One fact row can produce at most two events: being written (asserted /
 * corrected) and being invalidated (rejected). An invalidation that has a
 * successor correction row is not recorded separately — that death is
 * already explained by the corrected event of the successor.
 *
 * Attribution: in the audit ledger, `fact.close`'s target is **the closed
 * old row**, while a correction row is a newly inserted, different row, so
 * this looks it up via `COALESCE(supersedes, id)`. A conflict verdict's
 * target is the conflict row, one more hop away.
 *
 * No matching audit record = the engine did it automatically (extraction
 * writing a fact, or temporal reconciliation); `actor` is `NULL`.
 */
export async function entity_history(
  sql: Sql,
  kb_id: Uuid,
  entity_id: Uuid,
  limit: number,
  offset: number,
): Promise<[EntityHistoryEvent[], number]> {
  const EVENTS = `
        WITH ef AS (
            SELECT f.*,
                   CASE WHEN f.subject_id = $2 THEN 'out' ELSE 'in' END AS direction,
                   CASE WHEN f.subject_id = $2 THEN f.object_id ELSE f.subject_id END AS other_id
            FROM facts f
            WHERE f.kb_id = $1 AND (f.subject_id = $2 OR f.object_id = $2)
        ),
        ev AS (
            SELECT ef.*, ef.recorded_at AS at,
                   CASE WHEN ef.supersedes IS NULL THEN 'asserted' ELSE 'corrected' END AS kind
            FROM ef
            UNION ALL
            -- Invalidated with no successor = overturned ... unless it was
            -- merged into another assertion. In that case the content is
            -- unchanged, and calling it "withdrawn" states an event that
            -- did not happen.
            SELECT ef.*, ef.invalidated_at AS at,
                   CASE WHEN EXISTS (SELECT 1 FROM fact_adoptions fa
                                     WHERE fa.old_fact_id = ef.id AND fa.mode = 'merged'
                                       AND fa.reverted_at IS NULL)
                        THEN 'merged' ELSE 'rejected' END AS kind
            FROM ef
            WHERE ef.invalidated_at IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM facts s WHERE s.supersedes = ef.id)
        ),
        -- A retype is not a fact: no predicate, no other party, no
        -- direction. It comes from 'entity_retypes'; one row produces at
        -- most two events — the change itself, and its reversal.
        --
        -- **A reverted change is still shown.** It reads as "changed, then
        -- reverted", not as if it never happened. This same class of bug
        -- has hit this codebase twice (#37; a merge misread as a
        -- withdrawal), so this is not defensive programming.
        rt AS (
            SELECT r.created_at AS at, 'retyped' AS kind, r.actor_id,
                   tf.label AS from_type_label, tt.label AS to_type_label
            FROM entity_retypes r
            LEFT JOIN entity_types tf ON tf.id = r.from_type_id
            JOIN entity_types tt ON tt.id = r.to_type_id
            WHERE r.kb_id = $1 AND r.entity_id = $2
            UNION ALL
            SELECT r.reverted_at, 'retype_reverted', r.actor_id, tf.label, tt.label
            FROM entity_retypes r
            LEFT JOIN entity_types tf ON tf.id = r.from_type_id
            JOIN entity_types tt ON tt.id = r.to_type_id
            WHERE r.kb_id = $1 AND r.entity_id = $2 AND r.reverted_at IS NOT NULL
        )`;
  const rows = await q<EntityHistoryEvent>(
    sql,
    `${EVENTS}
         SELECT * FROM (
         SELECT ev.id AS fact_id, ev.at, ev.kind, ev.direction,
                COALESCE(r.label, fact_surface_predicate(ev.id)) AS predicate_label, o.canonical_name AS other_name,
                ev.object_value, ev.valid_from, ev.valid_from_precision,
                ev.valid_to, ev.valid_to_precision,
                ev.confidence, act.actor_name, act.action,
                src.document_id, src.filename, src.quote,
                NULL::text AS from_type_label, NULL::text AS to_type_label
         FROM ev
         LEFT JOIN relation_types r ON r.id = ev.predicate_id
         LEFT JOIN entities o ON o.id = ev.other_id
         LEFT JOIN LATERAL (
             SELECT u.display_name AS actor_name, a.action
             FROM audit_events a
             LEFT JOIN users u ON u.id = a.actor_id
             WHERE a.kb_id = $1
               -- An assertion is written by extraction, never a human
               -- decision: attribution only asks about correction and
               -- override events, otherwise a later human verdict would be
               -- wrongly attached to that original assertion.
               AND ev.kind <> 'asserted'
               AND a.action = ANY(CASE ev.kind
                     WHEN 'corrected' THEN
                       ARRAY['fact.close', 'conflict.close_old', 'ontology.predicate_adopted']
                     -- A merge can only be caused by an adoption, never a
                     -- rejection made in Review.
                     WHEN 'merged' THEN ARRAY['ontology.predicate_adopted']
                     ELSE ARRAY['fact.reject', 'conflict.reject_new',
                                'ontology.adoption_reverted'] END)
               AND (a.target_id = COALESCE(ev.supersedes, ev.id)
                    OR a.target_id IN (SELECT c.id FROM fact_conflicts c
                                       WHERE c.old_fact_id = COALESCE(ev.supersedes, ev.id)
                                          OR c.new_fact_id = ev.id)
                    -- Adoption and its reversal are both recorded on the
                    -- relation type, one action changing a batch of facts;
                    -- 'fact_adoptions' is what connects it precisely to
                    -- specific facts (a 'corrected' event is the new row,
                    -- 'merged' is the old row; both are recognized here).
                    OR (a.action IN ('ontology.predicate_adopted',
                                     'ontology.adoption_reverted')
                        AND EXISTS (SELECT 1 FROM fact_adoptions fa
                                    WHERE fa.predicate_id = a.target_id
                                      AND (fa.new_fact_id = ev.id
                                           OR fa.old_fact_id = ev.id))))
             ORDER BY a.created_at DESC LIMIT 1
         ) act ON true
         LEFT JOIN LATERAL (
             SELECT d.id AS document_id, d.filename, fe.quote
             FROM fact_evidence fe
             JOIN chunks c ON c.id = fe.chunk_id
             JOIN documents d ON d.id = c.document_id
             WHERE fe.fact_id = ev.id
             ORDER BY fe.doc_version DESC NULLS LAST LIMIT 1
         ) src ON true
         UNION ALL
         SELECT NULL::uuid, rt.at, rt.kind, NULL::text,
                NULL::text, NULL::text,
                NULL::jsonb, NULL::timestamptz, NULL::text,
                NULL::timestamptz, NULL::text,
                NULL::real, u.display_name, NULL::text,
                NULL::uuid, NULL::text, NULL::text,
                rt.from_type_label, rt.to_type_label
         FROM rt LEFT JOIN users u ON u.id = rt.actor_id
         ) x
         ORDER BY x.at DESC, x.fact_id
         LIMIT $3 OFFSET $4`,
    [kb_id, entity_id, limit, offset],
  );
  // The total includes the retype branch too, or pagination would be short.
  const total_row = await qOne<{ total: string | number }>(
    sql,
    `${EVENTS} SELECT (SELECT count(*) FROM ev) + (SELECT count(*) FROM rt) AS total`,
    [kb_id, entity_id],
  );
  return [rows, Number(total_row.total)];
}

export interface GraphChange {
  fact_id: Uuid;
  at: Date;
  kind: string;
  subject_id: Uuid;
  subject_name: string;
  predicate_label: string | null;
  object_name: string | null;
  object_value: unknown | null;
  valid_from: Date | null;
  valid_from_precision: string | null;
  valid_to: Date | null;
  valid_to_precision: string | null;
  confidence: number;
  document_id: Uuid | null;
  filename: string | null;
  quote: string | null;
}

/**
 * All cognitive changes across the whole KB inside a record-time window.
 *
 * **The window opens on the record axis**: `since`/`until` compare against
 * `recorded_at` and `invalidated_at`, not `valid_from`/`valid_to`. This is
 * the one and only difference from `entity_facts(at)` — that one asks "what
 * did the world look like at time T", this one asks "what did we change our
 * mind about during this period". Both query the same table using
 * different columns; mixing them up quietly gives a plausible-looking wrong
 * answer.
 *
 * Event derivation shares its logic with `entity_history` (see the comments
 * there): one fact row produces at most two events, and a death that
 * already has a successor correction is not recorded twice.
 */
export async function graph_changes(
  sql: Sql,
  kb_id: Uuid,
  since: Date,
  until: Date,
  entity_id: Uuid | null,
  kinds: string[] | null,
  limit: number,
): Promise<GraphChange[]> {
  // Each branch opens its window on **its own time column**, instead of
  // taking a union and filtering afterward: a fact written in February and
  // overturned in August should show neither event in a "March-April"
  // window.
  const EVENTS = `
        WITH ev AS (
            SELECT f.id, f.subject_id, f.predicate_id, f.object_id, f.object_value,
                   f.valid_from, f.valid_from_precision, f.valid_to, f.valid_to_precision, f.confidence,
                   f.recorded_at AS at,
                   CASE WHEN f.supersedes IS NULL THEN 'asserted' ELSE 'corrected' END AS kind
            FROM facts f
            WHERE f.kb_id = $1 AND f.recorded_at >= $2 AND f.recorded_at < $3
              AND ($4::uuid IS NULL OR f.subject_id = $4 OR f.object_id = $4)
            UNION ALL
            SELECT f.id, f.subject_id, f.predicate_id, f.object_id, f.object_value,
                   f.valid_from, f.valid_from_precision, f.valid_to, f.valid_to_precision, f.confidence,
                   f.invalidated_at AS at,
                   CASE WHEN EXISTS (SELECT 1 FROM fact_adoptions fa
                                     WHERE fa.old_fact_id = f.id AND fa.mode = 'merged'
                                       AND fa.reverted_at IS NULL)
                        THEN 'merged' ELSE 'rejected' END AS kind
            FROM facts f
            WHERE f.kb_id = $1 AND f.invalidated_at >= $2 AND f.invalidated_at < $3
              AND NOT EXISTS (SELECT 1 FROM facts s WHERE s.supersedes = f.id)
              AND ($4::uuid IS NULL OR f.subject_id = $4 OR f.object_id = $4)
        )`;
  return q<GraphChange>(
    sql,
    `${EVENTS}
         SELECT ev.id AS fact_id, ev.at, ev.kind,
                ev.subject_id, s.canonical_name AS subject_name,
                COALESCE(r.label, fact_surface_predicate(ev.id)) AS predicate_label, o.canonical_name AS object_name,
                ev.object_value, ev.valid_from, ev.valid_from_precision,
                ev.valid_to, ev.valid_to_precision,
                ev.confidence, src.document_id, src.filename, src.quote
         FROM ev
         LEFT JOIN relation_types r ON r.id = ev.predicate_id
         JOIN entities s ON s.id = ev.subject_id
         LEFT JOIN entities o ON o.id = ev.object_id
         LEFT JOIN LATERAL (
             SELECT d.id AS document_id, d.filename, fe.quote
             FROM fact_evidence fe
             JOIN chunks c ON c.id = fe.chunk_id
             JOIN documents d ON d.id = c.document_id
             WHERE fe.fact_id = ev.id
             ORDER BY fe.doc_version DESC NULLS LAST LIMIT 1
         ) src ON true
         WHERE $5::text[] IS NULL OR ev.kind = ANY($5)
         ORDER BY ev.at DESC, ev.id
         LIMIT $6`,
    [kb_id, since, until, entity_id, kinds, limit],
  );
}

// ---------------------------------------------------------------------------
// Predicate resolution: claim facts with no predicate back into the ontology
// ---------------------------------------------------------------------------

// The view type ProposedPredicate is defined here (store does not depend on
// a shared serialization layer for it).

export interface ProposedPredicate {
  form: string;
  fact_count: number;
  doc_count: number;
  example: string | null;
}

/**
 * Which wordings the source text used, on facts that have no predicate.
 *
 * This is the evidence base for ontology-extension suggestions — stronger
 * than the plain count in `ontology_misses` because it is linked to actual
 * facts, so adopting a wording can say "this will reclassify 57 facts" and
 * actually do it.
 */
export async function proposed_predicates(sql: Sql, kb_id: Uuid): Promise<ProposedPredicate[]> {
  return q<ProposedPredicate>(
    sql,
    // **Popularity is counted from all evidence, not from the backlog.**
    //
    // The WHERE clauses below narrow the row set to "still on the fallback
    // predicate, still live, object is an entity" — that is **what
    // adoption would rewrite**, and `fact_count` should count that. But
    // `doc_count` answers a different question: how common is this wording
    // in the corpus. Counting it from the leftover rows would
    // systematically under-count, and get worse over time — once a wording
    // is adopted, matched by a relation, or superseded by a correction, its
    // row leaves the backlog. A KB fed one document at a time suffers the
    // most: each round removes a batch, and what remains never accumulates
    // to two documents.
    //
    // Measured (ai-timeline, 348 chunks): under the two counting rules, 8
    // wordings land on opposite sides of the threshold — the backlog count
    // says "only in 1 document", the full count says "in >=2 documents".
    //
    // A CTE is used instead of a correlated subquery: the latter rescans
    // the evidence table once per group — 360ms vs 7ms on the same data.
    // This function runs on every Suggest call and every automatic
    // ontology-extension pass.
    `WITH spread AS (
             SELECT e.proposed_predicate AS form,
                    count(DISTINCT e.document_id) AS doc_count
             FROM fact_evidence e
             JOIN facts ff ON ff.id = e.fact_id
             WHERE ff.kb_id = $1 AND e.proposed_predicate IS NOT NULL
             GROUP BY 1
         )
         SELECT fe.proposed_predicate AS form,
                count(DISTINCT f.id) AS fact_count,
                max(sp.doc_count) AS doc_count,
                (SELECT s.canonical_name || ' → ' || o.canonical_name
                 FROM fact_evidence e2
                 JOIN facts f2 ON f2.id = e2.fact_id
                 JOIN entities s ON s.id = f2.subject_id
                 JOIN entities o ON o.id = f2.object_id
                 WHERE e2.proposed_predicate = fe.proposed_predicate
                   AND f2.kb_id = $1 AND f2.predicate_id IS NULL AND f2.invalidated_at IS NULL
                 LIMIT 1) AS example
         FROM fact_evidence fe
         JOIN facts f ON f.id = fe.fact_id
         JOIN spread sp ON sp.form = fe.proposed_predicate
         WHERE f.kb_id = $1 AND f.predicate_id IS NULL
           AND f.invalidated_at IS NULL AND fe.proposed_predicate IS NOT NULL
           -- Literal-object facts do not count: they also have no
           -- predicate and also carry the source wording, but what they
           -- need is an attribute, not a relation. Mixing them in would
           -- make the proposal build a relation, and 'founding_date' would
           -- turn into an edge pointing at "2015" — exactly what this path
           -- is meant to fix.
           AND f.object_id IS NOT NULL
           -- A wording the user already rejected is not offered again
           -- (both the manual and the automatic path honor this).
           AND NOT EXISTS (SELECT 1 FROM ontology_misses m
                           WHERE m.kb_id = $1 AND m.kind = 'relation_type'
                             AND m.key = fe.proposed_predicate AND m.dismissed_at IS NOT NULL)
         GROUP BY fe.proposed_predicate
         ORDER BY fact_count DESC, form`,
    [kb_id],
  );
}

/**
 * Which documents each pending wording appears in.
 *
 * `proposed_predicates` already gives `doc_count`, but the adoption path
 * groups wordings by their stem first (`sued` and `sues` are one relation),
 * and after grouping the document count must be a **union**, not a sum —
 * the same document can easily use two spellings, and summing would double
 * count and push one document over the ">=2 documents" threshold.
 *
 * **This does not filter out the fallback predicate.** This query and
 * `proposed_predicates` answer two different questions: that one asks "what
 * wordings are still waiting to be adopted" (the backlog); this one asks
 * "how common is this wording" (all evidence, matching the internal
 * `spread` CTE there).
 *
 * The first version copied `rt.key = 'related_to'` (from when that fallback
 * relation still existed), reasoning "the two conditions must match" — that
 * was wrong. It still counted the leftovers: once a wording is adopted,
 * matched, or superseded by a correction, its row leaves the backlog, and
 * a KB fed one document at a time never accumulates to two. A test caught
 * this directly (only one of two documents came back).
 */
export async function proposed_predicate_documents(
  sql: Sql,
  kb_id: Uuid,
): Promise<[string, Uuid][]> {
  const rows = await q<{ proposed_predicate: string; document_id: Uuid }>(
    sql,
    `SELECT DISTINCT fe.proposed_predicate, fe.document_id
         FROM fact_evidence fe
         JOIN facts f ON f.id = fe.fact_id
         WHERE f.kb_id = $1
           AND fe.proposed_predicate IS NOT NULL
           AND fe.document_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM ontology_misses m
                           WHERE m.kb_id = $1 AND m.kind = 'relation_type'
                             AND m.key = fe.proposed_predicate AND m.dismissed_at IS NOT NULL)`,
    [kb_id],
  );
  return rows.map((r) => [r.proposed_predicate, r.document_id]);
}

/**
 * Rewrite the predicate-less facts recognized by `forms` onto
 * `predicate_id`. Returns [batch id, number rewritten] — the batch id is
 * the handle for undoing this.
 *
 * **Appends, does not rewrite in place**: a new row carrying `supersedes`
 * is inserted, and the old row is invalidated — the same path as a manual
 * correction or a temporal closure. The cognitive change is itself
 * information: the entity history can show "first recorded as related to,
 * later refined to available on".
 *
 * Only rewrites facts whose wordings fall **entirely** within `forms`: one
 * fact may have accumulated several wordings (chunk A says "runs on", chunk
 * B says "optimized for"); recognizing only one of them and rewriting
 * anyway would silently decide the other one too. Measured: this case is
 * under 1% of facts. Missing a few is safer than guessing.
 *
 * Every outcome is recorded in `fact_adoptions`. A single `supersedes`
 * pointer is not enough — when the target assertion already exists, the
 * path taken is "merge": the old row is invalidated with no successor, so
 * it cannot be undone by chaining, and the entity history would otherwise
 * read it as rejected and tell the world "this was withdrawn" (it was, in
 * fact, merged into another assertion without losing a single word).
 *
 * `swap = true`: these wordings are the **passive voice** of the target
 * relation, so subject and object must be swapped when rewriting.
 *
 * `X produced_by Y` and `Y produces X` are the same edge. Without the swap,
 * the graph would draw an extra edge pointing the wrong way, one that never
 * merges with the forward-facing ones — the same event split across two
 * directions.
 */
export async function adopt_proposed_predicates(
  sql: Sql,
  kb_id: Uuid,
  predicate_id: Uuid,
  forms: string[],
  swap: boolean,
): Promise<[Uuid, number]> {
  return adopt(sql, kb_id, predicate_id, { kind: "by_form", forms }, swap);
}

/** Which facts to rewrite, and where the new row's object comes from. */
export type AdoptTargets =
  | { kind: "by_form"; forms: string[] }
  | { kind: "with_values"; items: [Uuid, unknown][] };

interface AdoptTarget {
  old_id: Uuid;
  subject_id: Uuid;
  object_id: Uuid | null;
  object_value: unknown | null;
}

async function adopt(
  sql: Sql,
  kb_id: Uuid,
  predicate_id: Uuid,
  targets: AdoptTargets,
  swap: boolean,
): Promise<[Uuid, number]> {
  const batch_id = newId();
  let items: AdoptTarget[];
  if (targets.kind === "by_form") {
    const forms = targets.forms;
    if (forms.length === 0) {
      return [batch_id, 0];
    }
    const rows = await q<{
      id: Uuid;
      subject_id: Uuid;
      object_id: Uuid | null;
      object_value: unknown | null;
    }>(
      sql,
      `SELECT f.id, f.subject_id, f.object_id, f.object_value
                 FROM facts f
                 WHERE f.kb_id = $1 AND f.predicate_id IS NULL AND f.invalidated_at IS NULL
                   -- Only touches facts whose object is an entity. The same
                   -- wording can have facts pointing at entities and facts
                   -- carrying a literal (location is used both ways); the
                   -- latter belongs to the attribute path — rewriting it
                   -- onto a relation would stop it from being a value at
                   -- all.
                   AND f.object_id IS NOT NULL
                   AND EXISTS (SELECT 1 FROM fact_evidence e
                               WHERE e.fact_id = f.id AND e.proposed_predicate = ANY($2))
                   AND NOT EXISTS (SELECT 1 FROM fact_evidence e
                                   WHERE e.fact_id = f.id AND e.proposed_predicate IS NOT NULL
                                     AND NOT (e.proposed_predicate = ANY($2)))
                 ORDER BY f.recorded_at`,
      [kb_id, forms],
    );
    items = rows.map((r) => ({
      old_id: r.id,
      subject_id: r.subject_id,
      object_id: r.object_id,
      object_value: r.object_value,
    }));
  } else {
    const values = targets.items;
    if (values.length === 0) {
      return [batch_id, 0];
    }
    // The subject has to be read back from the database (the caller gives
    // fact id plus new value), which also confirms the fact is still live
    // — extraction may have run again between selection and adoption.
    const ids = values.map(([id]) => id);
    const live = await q<{ id: Uuid; subject_id: Uuid }>(
      sql,
      `SELECT id, subject_id FROM facts
                 WHERE kb_id = $1 AND id = ANY($2) AND invalidated_at IS NULL`,
      [kb_id, ids],
    );
    const subject_of = new Map(live.map((r) => [r.id, r.subject_id]));
    items = [];
    for (const [id, value] of values) {
      const subject_id = subject_of.get(id);
      if (subject_id === undefined) continue;
      items.push({ old_id: id, subject_id, object_id: null, object_value: value });
    }
  }

  class SkipAdoption extends Error {}

  let moved = 0;
  for (const target of items) {
    // Passive-voice rewrite: swap subject and object. A literal-object fact
    // cannot be swapped (a value cannot be a subject), and the `by_form`
    // query only selects facts with a non-null `object_id`, so this only
    // ever applies to entity objects.
    let subject_id = target.subject_id;
    let object_id = target.object_id;
    if (swap && object_id !== null) {
      const old_subject = subject_id;
      subject_id = object_id;
      object_id = old_subject;
    }
    const object_value = target.object_value;
    const old_id = target.old_id;

    try {
      await sql.begin(async (tx_raw) => {
        const tx = tx_raw as unknown as Sql;
        // The target assertion may already exist (a real relation with the
        // same subject and object already exists): merge into it instead
        // of creating a duplicate.
        //
        // **Both sides of the object must be compared.** Literal facts all
        // have `object_id = NULL`; comparing only that would treat every
        // value under the same subject and predicate as one assertion —
        // (Nebula Tech, founding_date, 2015) and (Nebula Tech,
        // founding_date, 2016) would merge into one, and the second value
        // would silently vanish.
        const existing = await qOpt<{ id: Uuid }>(
          tx,
          `SELECT id FROM facts
             WHERE kb_id = $1 AND subject_id = $2 AND predicate_id = $3
               AND object_id IS NOT DISTINCT FROM $4
               AND object_value IS NOT DISTINCT FROM $5
               AND invalidated_at IS NULL`,
          [kb_id, subject_id, predicate_id, object_id, object_value],
        );

        let new_id: Uuid;
        let mode: string;
        if (existing) {
          new_id = existing.id;
          mode = ADOPT_MERGED;
        } else {
          const id = newId();
          // The object is bound explicitly, not copied from the old row:
          // the attribute path's new value has been normalized ("2015" →
          // a date), and copying the old row would insert the
          // un-normalized original value. The relation path binds the old
          // row's own value, so its behavior is unchanged.
          const inserted = await qOpt<{ id: Uuid }>(
            tx,
            `INSERT INTO facts (id, kb_id, subject_id, predicate_id, object_id, object_value,
                                        valid_from, valid_from_precision,
                                        valid_to, valid_to_precision, confidence, supersedes)
                     SELECT $1, kb_id, $6, $3, $4, $5,
                            valid_from, valid_from_precision,
                            valid_to, valid_to_precision, confidence, id
                     FROM facts WHERE id = $2 AND invalidated_at IS NULL
                     RETURNING id`,
            // The subject is also bound explicitly rather than copied from
            // the old row — the passive-voice rewrite exists precisely to
            // change it. The first version missed this: the local variable
            // was renamed but the SQL still read `subject_id`, so the
            // object changed and the subject did not, producing a bare
            // `OpenAI produces OpenAI`.
            [id, old_id, predicate_id, object_id, object_value, subject_id],
          );
          // Already rewritten concurrently: do not act again.
          if (!inserted) {
            throw new SkipAdoption();
          }
          new_id = inserted.id;
          mode = ADOPT_SUPERSEDED;
        }

        // The evidence moves over wholesale, and the surface predicate goes
        // with it — it is the basis for this rewrite and must not be lost
        // in it.
        await exec(
          tx,
          `INSERT INTO fact_evidence (fact_id, chunk_id, quote, proposed_predicate, document_id, doc_version)
             SELECT $1, chunk_id, quote, proposed_predicate, document_id, doc_version
             FROM fact_evidence WHERE fact_id = $2
             ON CONFLICT DO NOTHING`,
          [new_id, old_id],
        );
        await exec(tx, `UPDATE facts SET invalidated_at = now() WHERE id = $1`, [old_id]);
        await exec(
          tx,
          `INSERT INTO fact_adoptions
                (batch_id, kb_id, predicate_id, old_fact_id, new_fact_id, mode)
             VALUES ($1, $2, $3, $4, $5, $6)`,
          [batch_id, kb_id, predicate_id, old_id, new_id, mode],
        );
      });
      moved += 1;
    } catch (e) {
      if (e instanceof SkipAdoption) continue;
      throw e;
    }
  }
  return [batch_id, moved];
}

/**
 * Undo one adoption: the newly written row is invalidated, the old row is
 * revived.
 *
 * The relation type is **not deleted** — facts have pointed to it (and
 * `delete_relation_type` would refuse too), and by the append-only rule,
 * "it once existed" is itself history; an unused relation is harmless. The
 * evidence is not cleared either: the new row is already invalidated, so
 * its evidence is already dormant; deleting it would erase "we once thought
 * this".
 *
 * A merge (`mode = merged`) only revives the old row; it does not touch the
 * target it merged into — that one was already there, and the copied
 * evidence staying in place is harmless (`ON CONFLICT DO NOTHING` may well
 * be its own row anyway).
 */
export async function unadopt(sql: Sql, kb_id: Uuid, batch_id: Uuid): Promise<number> {
  const rows = await q<{ old_fact_id: Uuid; new_fact_id: Uuid; mode: string }>(
    sql,
    `SELECT old_fact_id, new_fact_id, mode FROM fact_adoptions
         WHERE batch_id = $1 AND kb_id = $2 AND reverted_at IS NULL`,
    [batch_id, kb_id],
  );
  if (rows.length === 0) {
    throw AppError.notFound();
  }

  return sql.begin(async (tx_raw) => {
    const tx = tx_raw as unknown as Sql;
    let reverted = 0;
    for (const { old_fact_id, new_fact_id, mode } of rows) {
      if (mode === ADOPT_SUPERSEDED) {
        await exec(tx, `UPDATE facts SET invalidated_at = now() WHERE id = $1 AND invalidated_at IS NULL`, [
          new_fact_id,
        ]);
      }
      await exec(tx, `UPDATE facts SET invalidated_at = NULL WHERE id = $1`, [old_fact_id]);
      reverted += 1;
    }
    // Marked, not deleted: this adoption happened, and so did the undo —
    // both are history.
    await exec(
      tx,
      `UPDATE fact_adoptions SET reverted_at = now()
         WHERE batch_id = $1 AND kb_id = $2 AND reverted_at IS NULL`,
      [batch_id, kb_id],
    );
    return reverted;
  });
}

/** Which relation type a `fact_adoptions` batch belongs to, or null when the batch id names an entity-retype batch instead (the two batch kinds share one caller-visible id space). */
export async function predicateForBatch(sql: Sql, kb_id: Uuid, batch_id: Uuid): Promise<Uuid | null> {
  const row = await qOpt<{ predicate_id: Uuid }>(
    sql,
    `SELECT predicate_id FROM fact_adoptions WHERE batch_id = $1 AND kb_id = $2 LIMIT 1`,
    [batch_id, kb_id],
  );
  return row?.predicate_id ?? null;
}

/** How many of the given adoption batches still have at least one live (non-reverted) row. Used to decide whether a past auto-extension run is still worth showing — one reverted clean leaves nothing on the graph to report. */
export async function liveAdoptionCount(sql: Sql, kb_id: Uuid, batch_ids: Uuid[]): Promise<number> {
  if (batch_ids.length === 0) return 0;
  const row = await qOne<{ count: string }>(
    sql,
    `SELECT count(*)::text AS count FROM fact_adoptions
     WHERE kb_id = $1 AND batch_id = ANY($2) AND reverted_at IS NULL`,
    [kb_id, batch_ids],
  );
  return Number(row.count);
}

export interface ProposedAttribute {
  form: string;
  fact_count: number;
  doc_count: number;
  example: string | null;
  domain_keys: string[];
}

/**
 * Out-of-vocabulary **literal** wordings: still on the fallback predicate,
 * with an object that is a value, not an entity.
 *
 * This is the counterpart to `proposed_predicates`, split strictly by
 * whether `object_id` is empty. Mixing the two would turn `founding_date`
 * into a proposed relation — exactly what this path exists to fix.
 */
export async function proposed_attributes(sql: Sql, kb_id: Uuid): Promise<ProposedAttribute[]> {
  return q<ProposedAttribute>(
    sql,
    // Same rule as `proposed_predicates`: popularity is counted from all
    // evidence, the rewrite count from the backlog; a CTE is used instead
    // of a correlated subquery, which would rescan the evidence table once
    // per group.
    `WITH spread AS (
             SELECT e.proposed_predicate AS form,
                    count(DISTINCT e.document_id) AS doc_count
             FROM fact_evidence e
             JOIN facts ff ON ff.id = e.fact_id
             WHERE ff.kb_id = $1 AND e.proposed_predicate IS NOT NULL
             GROUP BY 1
         )
         SELECT fe.proposed_predicate AS form,
                count(DISTINCT f.id) AS fact_count,
                max(sp.doc_count) AS doc_count,
                (SELECT f2.object_value::text
                 FROM fact_evidence e2
                 JOIN facts f2 ON f2.id = e2.fact_id
                 WHERE e2.proposed_predicate = fe.proposed_predicate
                   AND f2.kb_id = $1 AND f2.predicate_id IS NULL
                   AND f2.object_id IS NULL AND f2.invalidated_at IS NULL
                 LIMIT 1) AS example,
                -- Which classes the subject actually is: an attribute's
                -- domain comes from here, not from a guess.
                ARRAY(SELECT DISTINCT t.key
                      FROM fact_evidence e3
                      JOIN facts f3 ON f3.id = e3.fact_id
                      JOIN entities s ON s.id = f3.subject_id
                      JOIN entity_types t ON t.id = s.type_id
                      WHERE e3.proposed_predicate = fe.proposed_predicate
                        AND f3.kb_id = $1 AND f3.predicate_id IS NULL
                        AND f3.object_id IS NULL AND f3.invalidated_at IS NULL) AS domain_keys
         FROM fact_evidence fe
         JOIN facts f ON f.id = fe.fact_id
         JOIN spread sp ON sp.form = fe.proposed_predicate
         WHERE f.kb_id = $1 AND f.predicate_id IS NULL
           AND f.invalidated_at IS NULL AND fe.proposed_predicate IS NOT NULL
           AND f.object_id IS NULL
           -- A wording the user already rejected is not offered again.
           AND NOT EXISTS (SELECT 1 FROM ontology_misses m
                           WHERE m.kb_id = $1 AND m.kind = 'attribute_type'
                             AND m.key = fe.proposed_predicate AND m.dismissed_at IS NOT NULL)
         GROUP BY fe.proposed_predicate
         ORDER BY fact_count DESC, form`,
    [kb_id],
  );
}

/**
 * The facts currently attached to a set of literal wordings: id, subject's
 * type, raw value.
 *
 * Used by the adoption step. **Normalization does not happen here** — the
 * rules that turn "2015" into a date, or "1,200" into a number, live in the
 * extraction module. The store cannot reach them and should not. The
 * caller normalizes first and hands back the result.
 */
export async function value_facts_for_forms(
  sql: Sql,
  kb_id: Uuid,
  forms: string[],
): Promise<[Uuid, Uuid, unknown][]> {
  if (forms.length === 0) {
    return [];
  }
  const rows = await q<{ id: Uuid; type_id: Uuid; object_value: unknown }>(
    sql,
    `SELECT DISTINCT f.id, s.type_id, f.object_value
         FROM facts f
         JOIN entities s ON s.id = f.subject_id
         WHERE f.kb_id = $1 AND f.predicate_id IS NULL AND f.invalidated_at IS NULL
           AND f.object_id IS NULL AND f.object_value IS NOT NULL
           AND EXISTS (SELECT 1 FROM fact_evidence e
                       WHERE e.fact_id = f.id AND e.proposed_predicate = ANY($2))`,
    [kb_id, forms],
  );
  return rows.map((r) => [r.id, r.type_id, r.object_value]);
}

/**
 * Adopt a batch of **literal** wordings: rewrite their facts onto an
 * attribute.
 *
 * Shares the rewrite, batch, and undo logic with `adopt_proposed_predicates`
 * — the effect on the graph is the same operation. Only "where the new
 * object comes from" differs: here the values were normalized by the
 * caller according to the attribute's datatype, and values that could not
 * be converted are never passed in (they simply stay predicate-less, for
 * next time).
 */
export async function adopt_value_facts(
  sql: Sql,
  kb_id: Uuid,
  attribute_id: Uuid,
  rewrites: [Uuid, unknown][],
): Promise<[Uuid, number]> {
  // The attribute path has no passive voice: the object is a literal, and a
  // value cannot be a subject.
  return adopt(sql, kb_id, attribute_id, { kind: "with_values", items: rewrites }, false);
}

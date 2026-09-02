/**
 * Fetching and storing for consistency checks. The judgment itself lives
 * in `../reason` — that layer never touches the database.
 *
 * Three steps: turn live facts into edges, turn `relation_types` axiom
 * columns into `Axioms`, and write what `check()` reports into
 * `axiom_violations`.
 *
 * **A rerun is idempotent, and the rerun always wins.** After every run,
 * any `open` row in this table that the rerun did not reproduce gets
 * deleted. Those rows are derived state. When a fact is retracted or an
 * axiom is relaxed, that violation should not stay on the Review page.
 * A row someone has already decided on (`resolved`) is left alone — that
 * is a human decision, not a derived value.
 *
 * This rule guards against the opposite mistake made in
 * `ontology_proposals`: a rerun there flips a rejected proposal back to
 * pending, erasing a human rejection every time it runs. So here,
 * `ON CONFLICT` does nothing — a row already in the table, open or
 * resolved, is left exactly as it is.
 */

import { q, qOne, qOpt, exec, type Sql } from "../core/db";
import { AppError } from "../core/errors";
import { newId, type Uuid } from "../core/ids";
import { check, defaultAxioms, checkOntology, derive, validity } from "../reason";
import type { Axioms, Edge, Derived, TimedEdge } from "../reason";

/** A rule kind literal. A plain string, not an enum: it goes straight into SQL and also serves as a map key. */
type RuleKind = "transitive" | "symmetric" | "inverse" | "sub_property";

/** What one check run produces, for the caller to audit and report to the user. */
export type Report = {
  /** How many edges took part in the check. */
  edges: number;
  /** How many predicates declared at least one axiom. **Zero here means "no criterion", not "no contradiction".** */
  predicates_with_axioms: number;
  /** The total number of violations found this run. */
  found: number;
  /** How many of those are new (not already in the table). */
  inserted: number;
  /** How many stale `open` rows got cleared. */
  cleared: number;
};

/**
 * Fetches every edge in this KB that can take part in the check.
 *
 * All three filters are required:
 *
 * - `invalidated_at IS NULL` — a retracted fact should not still report a
 *   contradiction; it is no longer our assertion.
 * - `predicate_id IS NOT NULL` — no predicate means no axiom to check
 *   against (see `facts.predicate_id`).
 * - `object_id IS NOT NULL` — an attribute fact's object is a literal;
 *   axioms talk about relations between entities.
 */
async function edges(sql: Sql, kbId: Uuid): Promise<Edge[]> {
  const rows = await q<{ id: Uuid; predicate_id: Uuid; subject_id: Uuid; object_id: Uuid }>(
    sql,
    `SELECT id, predicate_id, subject_id, object_id
       FROM facts
      WHERE kb_id = $1
        AND invalidated_at IS NULL
        AND predicate_id IS NOT NULL
        AND object_id IS NOT NULL`,
    [kbId],
  );
  return rows.map((r) => ({
    fact: r.id,
    predicate: r.predicate_id,
    subject: r.subject_id,
    object: r.object_id,
  }));
}

/**
 * Fetches this KB's predicate axioms.
 *
 * **Only fetches predicates that declare at least one flag.** A predicate
 * with none declared would still take a row in the table, but `saysNothing`
 * skips it, wasting memory for nothing. This count also matters on its
 * own — it measures "is there a criterion at all", and the report uses it.
 */
async function axioms(sql: Sql, kbId: Uuid): Promise<Map<Uuid, Axioms>> {
  const rows = await q<{
    id: Uuid;
    is_transitive: boolean;
    is_symmetric: boolean;
    is_asymmetric: boolean;
    is_irreflexive: boolean;
    functional: boolean;
    inverse_functional: boolean;
    inverse_of: Uuid | null;
    sub_property_of: Uuid | null;
  }>(
    sql,
    `SELECT id, is_transitive, is_symmetric, is_asymmetric, is_irreflexive,
            functional, inverse_functional, inverse_of, sub_property_of
       FROM relation_types
      WHERE kb_id = $1
        AND (is_transitive OR is_symmetric OR is_asymmetric OR is_irreflexive
             OR functional OR inverse_functional
             OR inverse_of IS NOT NULL OR sub_property_of IS NOT NULL)`,
    [kbId],
  );
  const map = new Map<Uuid, Axioms>();
  for (const r of rows) {
    map.set(r.id, {
      transitive: r.is_transitive,
      symmetric: r.is_symmetric,
      asymmetric: r.is_asymmetric,
      irreflexive: r.is_irreflexive,
      functional: r.functional,
      inverseFunctional: r.inverse_functional,
      inverseOf: r.inverse_of ?? undefined,
      subPropertyOf: r.sub_property_of ?? undefined,
    });
  }

  // **Inverses are mutual, and the table only stores one direction.**
  // Declaring `p⁻¹ = q` without also filling in `q⁻¹ = p` means `A p B`
  // implies `B q A`, but `B q A` does not imply back to `A p B` — that is
  // exactly the "asking about a job and asking about employment gives a
  // different answer" shape that R1 exists to remove. Fixing only one
  // side is the same as not fixing it.
  //
  // Normalization happens here, not in a database trigger: more than one
  // path can bypass a trigger (RDF import, a direct table edit), but
  // loading axioms happens in exactly this one place, and nothing can go
  // around it.
  const pairs: Array<[Uuid, Uuid]> = [];
  for (const [id, ax] of map) {
    if (ax.inverseOf !== undefined) pairs.push([ax.inverseOf, id]);
  }
  for (const [target, source] of pairs) {
    // Leave a predicate that already declares its own inverse alone —
    // **what a human wrote outranks what is derived.** The two sides
    // pointing at different things is a contradiction in the ontology
    // itself, reported by R0, not silently patched here.
    const existing = map.get(target);
    if (existing) {
      if (existing.inverseOf === undefined) existing.inverseOf = source;
    } else {
      map.set(target, { ...defaultAxioms(), inverseOf: source });
    }
  }
  return map;
}

/** Runs one check and writes the result to the table. */
export async function run(sql: Sql, kbId: Uuid): Promise<Report> {
  const es = await edges(sql, kbId);
  const ax = await axioms(sql, kbId);
  const violations = check(es, ax);

  const report: Report = {
    edges: es.length,
    predicates_with_axioms: ax.size,
    found: violations.length,
    inserted: 0,
    cleared: 0,
  };

  // In a transaction, or there would be a window between "insert the new
  // ones" and "clear the stale ones" during which the Review page briefly
  // looks emptier than it is.
  await sql.begin(async (tx) => {
    const fresh: Uuid[] = [];
    for (const v of violations) {
      const inserted = await qOpt<{ id: Uuid }>(
        tx,
        `INSERT INTO axiom_violations (id, kb_id, kind, left_fact, right_fact, path)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (kb_id, kind, left_fact, right_fact) DO NOTHING
         RETURNING id`,
        [newId(), kbId, v.kind, v.left, v.right, v.path],
      );
      if (inserted) {
        report.inserted += 1;
      }
      // Whether just inserted or already present, it still holds this round.
      const keep = await qOne<{ id: Uuid }>(
        tx,
        `SELECT id FROM axiom_violations
          WHERE kb_id = $1 AND kind = $2 AND left_fact = $3 AND right_fact = $4`,
        [kbId, v.kind, v.left, v.right],
      );
      fresh.push(keep.id);
    }

    // An `open` row this round did not reproduce is stale: the fact was
    // retracted, or the axiom was relaxed. A `resolved` row is left
    // alone — that is a human decision, not a derived value.
    const cleared = await exec(
      tx,
      `DELETE FROM axiom_violations
        WHERE kb_id = $1 AND status = 'open' AND NOT (id = ANY($2))`,
      [kbId, fresh],
    );
    report.cleared = cleared.count;
  });
  return report;
}

/** One violation the Review page shows: two facts (as triples) and the reason. */
export type AxiomViolation = {
  id: Uuid;
  /** self_loop | asymmetry | cycle | functional */
  kind: string;
  /** The relation the criterion came from. When a human decides "the axiom is wrong", this is where they go to fix the ontology. */
  predicate: string | null;
  left_fact: Uuid;
  left_text: string;
  right_fact: Uuid;
  right_text: string;
  /** The cycle length (including both ends). Zero for the other three kinds — the frontend uses this to decide whether to show "view path". */
  path_len: number;
  detected_at: Date;
};

/**
 * The Review page's list: violations nobody has decided on yet, together
 * with both facts' triples spelled out as text.
 *
 * Spelling triples out as text happens in SQL rather than a follow-up
 * query: a page holds dozens of rows, each with two triples, and querying
 * each separately would mean hundreds of round trips. The predicate falls
 * back to `fact_surface_predicate` — a fact with no matching ontology
 * relation shows the source text instead (see `facts.predicate_id`).
 */
export async function openViolations(
  sql: Sql,
  kbId: Uuid,
  limit: number,
  offset: number,
): Promise<AxiomViolation[]> {
  return q<AxiomViolation>(
    sql,
    `WITH triple AS (
         SELECT f.id,
                s.canonical_name || ' · '
                  || COALESCE(r.label, fact_surface_predicate(f.id), '?') || ' · '
                  || COALESCE(o.canonical_name, f.object_value ->> 'summary',
                              f.object_value #>> '{}', '?') AS text,
                r.label AS predicate
           FROM facts f
           JOIN entities s ON s.id = f.subject_id
           LEFT JOIN relation_types r ON r.id = f.predicate_id
           LEFT JOIN entities o ON o.id = f.object_id
          WHERE f.kb_id = $1
     )
     SELECT v.id, v.kind, l.predicate,
            v.left_fact, l.text AS left_text,
            v.right_fact, rt.text AS right_text,
            coalesce(array_length(v.path, 1), 0) AS path_len,
            v.detected_at
       FROM axiom_violations v
       JOIN triple l  ON l.id  = v.left_fact
       JOIN triple rt ON rt.id = v.right_fact
      WHERE v.kb_id = $1 AND v.status = 'open'
      ORDER BY v.detected_at DESC
      LIMIT $2 OFFSET $3`,
    [kbId, limit, offset],
  );
}

/**
 * A human decides one violation.
 *
 * **Three outcomes, not two.** A temporal conflict asks "which fact is
 * right", but here the definition itself may be wrong — the user's
 * imported ontology declared a relation asymmetric, and their corpus
 * actually uses it both ways. `axiom_relaxed` records exactly that: the
 * fix is the ontology, not twenty facts.
 *
 * Changing the status does not delete the row, the same rule as the
 * ledger: having decided must leave a trace, and `run` relies on
 * `status = 'open'` to know which rows are derived and safe to recompute
 * — a human decision must survive a rerun.
 */
export async function decide(
  sql: Sql,
  kbId: Uuid,
  violationId: Uuid,
  resolution: string,
  actor: Uuid,
): Promise<void> {
  const res = await exec(
    sql,
    `UPDATE axiom_violations
        SET status = 'resolved', resolution = $3, decided_by = $4, decided_at = now()
      WHERE id = $2 AND kb_id = $1 AND status = 'open'`,
    [kbId, violationId, resolution, actor],
  );
  if (res.count === 0) throw AppError.notFound();
}

// ===================== The other half of R0: the ontology itself =====================

/** What one ontology self-consistency check produces. */
export type OntologyReport = {
  classes: number;
  found: number;
  inserted: number;
  cleared: number;
};

/**
 * Checks the ontology against itself: axiom combinations on predicates,
 * `subClassOf` cycles, and unsatisfiable classes.
 *
 * Same rerun rule as [`run`]: `open` is derived state and can be
 * recomputed away; `resolved` is a human decision and stays untouched.
 */
export async function checkOntologyRun(sql: Sql, kbId: Uuid): Promise<OntologyReport> {
  const ax = await axioms(sql, kbId);
  const parents = await q<{ child_id: Uuid; parent_id: Uuid }>(
    sql,
    `SELECT child_id, parent_id FROM entity_type_parents p
                      JOIN entity_types t ON t.id = p.child_id
                     WHERE t.kb_id = $1`,
    [kbId],
  );
  const disjoint = await q<{ a_id: Uuid; b_id: Uuid }>(
    sql,
    `SELECT a_id, b_id FROM entity_type_disjoint WHERE kb_id = $1`,
    [kbId],
  );
  const classesRow = await qOne<{ count: string }>(
    sql,
    `SELECT count(*) FROM entity_types WHERE kb_id = $1`,
    [kbId],
  );
  const classes = Number(classesRow.count);

  const defects = checkOntology(
    ax,
    parents.map((r) => [r.child_id, r.parent_id]),
    disjoint.map((r) => [r.a_id, r.b_id]),
  );
  const report: OntologyReport = {
    classes,
    found: defects.length,
    inserted: 0,
    cleared: 0,
  };

  await sql.begin(async (tx) => {
    const fresh: Uuid[] = [];
    for (const d of defects) {
      const existing = await qOpt<{ id: Uuid }>(
        tx,
        `SELECT id FROM ontology_defects
          WHERE kb_id = $1 AND kind = $2 AND subject = $3
            AND other IS NOT DISTINCT FROM $4`,
        [kbId, d.kind, d.subject, d.other ?? null],
      );
      let id: Uuid;
      if (existing) {
        id = existing.id;
      } else {
        id = newId();
        await exec(
          tx,
          `INSERT INTO ontology_defects (id, kb_id, kind, subject, other, path)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [id, kbId, d.kind, d.subject, d.other ?? null, d.path],
        );
        report.inserted += 1;
      }
      fresh.push(id);
    }
    const cleared = await exec(
      tx,
      `DELETE FROM ontology_defects
        WHERE kb_id = $1 AND status = 'open' AND NOT (id = ANY($2))`,
      [kbId, fresh],
    );
    report.cleared = cleared.count;
  });
  return report;
}

/** One self-contradiction the Review page shows, together with its labels. */
export type OntologyDefect = {
  id: Uuid;
  /** symmetric_and_asymmetric | transitive_and_functional | subclass_cycle | disjoint_with_ancestor | inherits_disjoint */
  kind: string;
  /** The label of the object with the problem (a class or a predicate). Missing means it has already been deleted. */
  subject_label: string | null;
  /** The other side: the disjoint class. */
  other_label: string | null;
  /** The labels of the classes on the cycle, in order. */
  path_labels: string[];
  detected_at: Date;
};

/**
 * The Review page's list of ontology defects, together with their labels.
 *
 * Labels are fetched in SQL rather than a follow-up query: the `subject`
 * column points at one of two tables (a predicate or a class), so fetching
 * separately would mean grouping by kind first and issuing two batches of
 * queries, while a single LEFT JOIN across both tables is enough — one id
 * can only match one of them.
 */
export async function openDefects(
  sql: Sql,
  kbId: Uuid,
  limit: number,
  offset: number,
): Promise<OntologyDefect[]> {
  return q<OntologyDefect>(
    sql,
    `SELECT d.id, d.kind,
            COALESCE(st.label, sr.label) AS subject_label,
            ot.label AS other_label,
            COALESCE(
                (SELECT array_agg(t.label ORDER BY x.ord)
                   FROM unnest(d.path) WITH ORDINALITY AS x(id, ord)
                   JOIN entity_types t ON t.id = x.id),
                ARRAY[]::text[]
            ) AS path_labels,
            d.detected_at
       FROM ontology_defects d
       LEFT JOIN entity_types   st ON st.id = d.subject
       LEFT JOIN relation_types sr ON sr.id = d.subject
       LEFT JOIN entity_types   ot ON ot.id = d.other
      WHERE d.kb_id = $1 AND d.status = 'open'
      ORDER BY d.detected_at DESC
      LIMIT $2 OFFSET $3`,
    [kbId, limit, offset],
  );
}

/**
 * A human decides one ontology defect.
 *
 * Two outcomes, not three: an ontology defect has no "the data is wrong"
 * option — it never looked at the data at all. `fixed` means "I went and
 * changed the ontology"; `accepted` means "seen, no change needed".
 */
export async function decideDefect(
  sql: Sql,
  kbId: Uuid,
  defectId: Uuid,
  resolution: string,
  actor: Uuid,
): Promise<void> {
  const res = await exec(
    sql,
    `UPDATE ontology_defects
        SET status = 'resolved', resolution = $3, decided_by = $4, decided_at = now()
      WHERE id = $2 AND kb_id = $1 AND status = 'open'`,
    [kbId, defectId, resolution, actor],
  );
  if (res.count === 0) throw AppError.notFound();
}

// ===================== R1: materialized derivation =====================

/** What one derivation run produces. */
export type DeriveReport = {
  /** How many rules got compiled. **Zero here means "no rules", not "nothing can be derived".** */
  rules: number;
  edges: number;
  /** The total number derived this round. */
  derived: number;
  /** How many of those are newly stored. */
  inserted: number;
  /** How many were invalidated because a premise disappeared. */
  invalidated: number;
  /** How many predicates hit the per-predicate cap and were left incomplete. */
  capped: number;
  /**
   * **Derived, but no matching rule row was found. Should always be zero.**
   *
   * A nonzero value means rule compilation and derivation have drifted
   * apart. This used to be a silent `continue`, so the `works_at` fact
   * derived from `ceo_of ⊑ works_at` **was derived but never stored**,
   * while the `employs` fact derived from it downstream still made it
   * into the table — a derived fact's premise vanished without a trace.
   * Count it instead of letting it stay silent.
   */
  unruled: number;
};

/** A derived fact's identity: the triple plus the interval. */
type DerivedKey = readonly [Uuid, Uuid, Uuid, number | undefined, number | undefined];

function derivedKeyStr(k: DerivedKey): string {
  return `${k[0]}\u0000${k[1]}\u0000${k[2]}\u0000${k[3] ?? ""}\u0000${k[4] ?? ""}`;
}

/**
 * Picks the coarsest of the two precisions.
 *
 * Strictly, each end of a derived interval should keep its own premise's
 * precision. Picking the coarsest is **deliberately conservative**: a
 * chain is only as trustworthy as its least certain link, and labeling a
 * conclusion derived from a year-level premise as day-level would be
 * "filling in a certain value where there is none" — exactly the mistake
 * called out in the comment on `facts.valid_from_precision`.
 */
function coarsest(a: string | undefined, b: string | undefined): string | undefined {
  const rank = (p: string): number => (p === "year" ? 0 : p === "month" ? 1 : 2);
  if (a !== undefined && b !== undefined) return rank(a) <= rank(b) ? a : b;
  return a ?? b;
}

/**
 * Recompiles rules from the ontology's axioms, returning `(predicate, kind) → rule id`.
 *
 * **Idempotent**: identity is `(kb, predicate, kind)`, so a recompile
 * recognizes "this is still that rule" — otherwise every run would give
 * `derived_facts.rule_id` a new id, breaking the history.
 *
 * **A rule whose axiom was retracted is not deleted.** An already
 * invalidated derived row still points at it, and explaining "which rule
 * this was derived by at the time" needs it to still exist; it simply no
 * longer appears in the return value, and facts derived from it are
 * invalidated by the reconciliation below. A KB only has a handful of
 * rules, so leaving them takes no real space.
 */
async function compileRules(
  sql: Sql,
  kbId: Uuid,
  ax: Map<Uuid, Axioms>,
): Promise<Map<string, Uuid>> {
  const want: Array<[Uuid, RuleKind]> = [];
  for (const [pred, a] of ax) {
    if (a.transitive) want.push([pred, "transitive"]);
    if (a.symmetric) want.push([pred, "symmetric"]);
    // The last two come from migration 0016
    // (a_relation_can_name_its_inverse). **The rule is attached to the side
    // that declares it** — a normalized inverse has a declaration on both
    // sides, so each direction gets its own rule, matching what each
    // direction derives.
    if (a.inverseOf !== undefined) want.push([pred, "inverse"]);
    if (a.subPropertyOf !== undefined) want.push([pred, "sub_property"]);
  }
  want.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));

  const out = new Map<string, Uuid>();
  for (const [pred, kind] of want) {
    await exec(
      sql,
      `INSERT INTO rules (id, kb_id, predicate_id, kind) VALUES ($1, $2, $3, $4)
       ON CONFLICT (kb_id, predicate_id, kind) DO NOTHING`,
      [newId(), kbId, pred, kind],
    );
    const row = await qOne<{ id: Uuid }>(
      sql,
      `SELECT id FROM rules WHERE kb_id = $1 AND predicate_id = $2 AND kind = $3`,
      [kbId, pred, kind],
    );
    out.set(`${pred}\u0000${kind}`, row.id);
  }
  return out;
}

/**
 * Runs derivation once and stores the derived facts in the ledger.
 *
 * **The caller is responsible for checking the `materialize_inferences`
 * flag.** This layer does not check it — it is also used to preview what
 * would be derived, and a preview must not be blocked by that flag.
 */
export async function materialize(sql: Sql, kbId: Uuid): Promise<DeriveReport> {
  const ax = await axioms(sql, kbId);
  const rules = await compileRules(sql, kbId, ax);

  // The input is **assertions only**. Derived facts live in a separate
  // table, so this query does not even need to filter them out — that is
  // exactly what the split table buys: forgetting to exclude them means
  // failing to derive anything new, not feeding the output back into itself.
  const rows = await q<{
    id: Uuid;
    predicate_id: Uuid;
    subject_id: Uuid;
    object_id: Uuid;
    valid_from: Date | null;
    valid_to: Date | null;
    valid_from_precision: string | null;
    valid_to_precision: string | null;
    confidence: number;
  }>(
    sql,
    `SELECT id, predicate_id, subject_id, object_id,
            valid_from, valid_to, valid_from_precision, valid_to_precision, confidence
       FROM facts
      WHERE kb_id = $1
        AND invalidated_at IS NULL
        AND predicate_id IS NOT NULL
        AND object_id IS NOT NULL`,
    [kbId],
  );

  const timedEdges: TimedEdge[] = [];
  const meta = new Map<Uuid, { fp: string | undefined; tp: string | undefined; conf: number }>();
  const spans = new Map<Uuid, [number | undefined, number | undefined]>();
  for (const r of rows) {
    const from = r.valid_from ? Math.floor(r.valid_from.getTime() / 1000) : undefined;
    const to = r.valid_to ? Math.floor(r.valid_to.getTime() / 1000) : undefined;
    timedEdges.push({
      edge: { fact: r.id, predicate: r.predicate_id, subject: r.subject_id, object: r.object_id },
      from,
      to,
    });
    spans.set(r.id, [from, to]);
    meta.set(r.id, {
      fp: r.valid_from_precision ?? undefined,
      tp: r.valid_to_precision ?? undefined,
      conf: r.confidence,
    });
  }

  const derivation = derive(timedEdges, ax);
  const report: DeriveReport = {
    rules: rules.size,
    edges: timedEdges.length,
    derived: derivation.facts.length,
    inserted: 0,
    invalidated: 0,
    capped: derivation.capped.length,
    unruled: 0,
  };

  const wanted = new Map<string, { key: DerivedKey; d: Derived }>();
  for (const d of derivation.facts) {
    const span = validity(d.premises, spans);
    if (span === undefined) continue;
    const key: DerivedKey = [d.subject, d.predicate, d.object, span[0], span[1]];
    wanted.set(derivedKeyStr(key), { key, d });
  }

  await sql.begin(async (tx) => {
    const live = await q<{
      id: Uuid;
      subject_id: Uuid;
      predicate_id: Uuid;
      object_id: Uuid;
      valid_from: Date | null;
      valid_to: Date | null;
    }>(
      tx,
      `SELECT id, subject_id, predicate_id, object_id, valid_from, valid_to
         FROM derived_facts
        WHERE kb_id = $1 AND invalidated_at IS NULL`,
      [kbId],
    );

    const stale: Uuid[] = [];
    for (const l of live) {
      const from = l.valid_from ? Math.floor(l.valid_from.getTime() / 1000) : undefined;
      const to = l.valid_to ? Math.floor(l.valid_to.getTime() / 1000) : undefined;
      const key = derivedKeyStr([l.subject_id, l.predicate_id, l.object_id, from, to]);
      if (wanted.has(key)) {
        wanted.delete(key);
      } else {
        stale.push(l.id);
      }
    }

    // A premise disappeared, so the derived fact follows it into invalidity.
    // **Sets `invalidated_at` instead of deleting**: this is structurally
    // the same as rejecting a fact, and leaves a record on the timeline —
    // "we derived this once, then the premise went away" — that an
    // entity's history page can show directly (0002 section 3).
    if (stale.length > 0) {
      await exec(tx, `UPDATE derived_facts SET invalidated_at = now() WHERE id = ANY($1)`, [
        stale,
      ]);
      report.invalidated = stale.length;
    }

    for (const { key, d } of wanted.values()) {
      const [subject, predicate, object, from, to] = key;
      // **Looks up by `via`, not by `predicate`.** A rule row is compiled
      // for "the predicate that declares the axiom"; for the two
      // cross-predicate rules, the derived predicate is a different one.
      // Looking up by `predicate` used to work for the first two rules
      // (`via` and `predicate` are the same there), but broke for
      // `inverse` and `sub_property` — the lookup missed and the fact was
      // derived but never stored.
      const ruleId = rules.get(`${d.via}\u0000${d.rule}`);
      if (ruleId === undefined) {
        // A missing rule here means compilation and derivation drifted
        // apart, not a normal case. Count it instead of letting it
        // disappear silently again.
        report.unruled += 1;
        continue;
      }
      // Both precision and confidence take the most conservative value
      // among the premises.
      let fp: string | undefined;
      let tp: string | undefined;
      let conf = 1.0;
      for (const p of d.premises) {
        const m = meta.get(p);
        if (m) {
          fp = coarsest(fp, m.fp);
          tp = coarsest(tp, m.tp);
          conf = Math.min(conf, m.conf);
        }
      }
      // The constraint is "no date, no precision" — when an intersection
      // leaves an end unbounded, that end's precision must be cleared too.
      const fpFinal = from !== undefined ? fp : undefined;
      const tpFinal = to !== undefined ? tp : undefined;
      const id = newId();
      await exec(
        tx,
        `INSERT INTO derived_facts (id, kb_id, subject_id, predicate_id, object_id,
                                    valid_from, valid_to,
                                    valid_from_precision, valid_to_precision,
                                    confidence, rule_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          id,
          kbId,
          subject,
          predicate,
          object,
          from !== undefined ? new Date(from * 1000) : null,
          to !== undefined ? new Date(to * 1000) : null,
          fpFinal ?? null,
          tpFinal ?? null,
          conf,
          ruleId,
        ],
      );
      for (let seq = 0; seq < d.premises.length; seq++) {
        await exec(
          tx,
          `INSERT INTO fact_derivations (derived_fact_id, premise_fact_id, seq)
             VALUES ($1, $2, $3)`,
          [id, d.premises[seq], seq],
        );
      }
      report.inserted += 1;
    }
  });
  return report;
}

/** One derived fact, connected to its subject, object, predicate, and proof. */
export type DerivedFactView = {
  id: Uuid;
  subject_id: Uuid;
  subject: string;
  object_id: Uuid;
  object: string;
  predicate: string;
  /** transitive | symmetric — which rule derived it. */
  rule: string;
  valid_from: Date | null;
  valid_to: Date | null;
  confidence: number;
  derived_at: Date;
  /** The direct premises, unfolded into triple text, in derivation order. */
  premises: string[];
};

/**
 * The KBs that are due for another derivation pass.
 *
 * Same shape as source sync: one interval plus a last-run time. **A KB
 * that has never run is due** — a KB that just turned the flag on should
 * not have to wait a full interval for its first run.
 */
export async function dueForInference(sql: Sql): Promise<Uuid[]> {
  const rows = await q<{ id: Uuid }>(
    sql,
    `SELECT id FROM knowledge_bases
      WHERE materialize_inferences
        AND (last_inference_at IS NULL
             OR last_inference_at < now()
                - make_interval(mins => inference_interval_minutes))`,
  );
  return rows.map((r) => r.id);
}

/**
 * Records the time this round of inference finished.
 *
 * **Records it whether or not anything changed**: this column answers
 * "have we looked since", not "have we changed anything since". Skipping
 * this would mean a KB with no changes gets rescanned every minute.
 */
export async function markInferenceRan(sql: Sql, kbId: Uuid): Promise<void> {
  await exec(sql, `UPDATE knowledge_bases SET last_inference_at = now() WHERE id = $1`, [kbId]);
}

/**
 * One derived fact, with the text needed to display it and prove it (the
 * entity panel's "derived" tab).
 *
 * **The proof is fetched along with it**: the whole point of this tab is
 * that "this edge was not said by anyone, it was derived this way", and
 * without the premises it looks no different from a normal edge — the
 * exact pollution a user worries about.
 */
export async function derivedForEntity(
  sql: Sql,
  kbId: Uuid,
  entityId: Uuid,
): Promise<DerivedFactView[]> {
  return q<DerivedFactView>(
    sql,
    `SELECT d.id,
            d.subject_id, s.canonical_name AS subject,
            d.object_id,  o.canonical_name AS object,
            r.label AS predicate,
            ru.kind AS rule,
            d.valid_from, d.valid_to, d.confidence, d.derived_at,
            COALESCE(
                (SELECT array_agg(
                            ps.canonical_name || ' · '
                            || COALESCE(pr.label, '?') || ' · '
                            || COALESCE(po.canonical_name, '?')
                            ORDER BY fd.seq)
                   FROM fact_derivations fd
                   JOIN facts pf       ON pf.id = fd.premise_fact_id
                   JOIN entities ps    ON ps.id = pf.subject_id
                   LEFT JOIN relation_types pr ON pr.id = pf.predicate_id
                   LEFT JOIN entities po ON po.id = pf.object_id
                  WHERE fd.derived_fact_id = d.id),
                ARRAY[]::text[]
            ) AS premises
       FROM derived_facts d
       JOIN entities s ON s.id = d.subject_id
       JOIN entities o ON o.id = d.object_id
       JOIN relation_types r ON r.id = d.predicate_id
       JOIN rules ru ON ru.id = d.rule_id
      WHERE d.kb_id = $1 AND d.invalidated_at IS NULL
        AND (d.subject_id = $2 OR d.object_id = $2)
      ORDER BY d.derived_at DESC`,
    [kbId, entityId],
  );
}

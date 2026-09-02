/**
 * The semantic layer's "business concept -> data asset" mapping (see
 * `docs/decisions/0011`).
 *
 * It used to be a `mapped_to` fact, with all of this stuffed into JSON
 * inside `object_value`. The reason for pulling it out lives in the
 * `concept_mappings` table comment, in one line: it is not an assertion
 * about the world, it is configuration.
 *
 * That is the difference from the ledger you can see right here: this
 * table **allows editing in place**. `confirm` changes "did this
 * configuration take effect", not "did our understanding of the world
 * change" — so it does not need to be append-only; the version before
 * an edit is kept in `concept_mapping_revisions`.
 */

import { q, qOne, qOpt, exec, type Sql } from "../core/db";
import { AppError } from "../core/errors";
import { newId, type Uuid } from "../core/ids";

/** A mapping from a business concept to a data asset definition. */
export type ConceptMapping = {
  id: Uuid;
  concept_id: Uuid;
  /** the concept's name. Every reader needs it (the query-data prompt, the Review list), and looking it up again from the entities table every time would be wasted work */
  concept_name: string;
  /** the mounted data source. The same concept can have a different definition on a different source, and that is intentional */
  source: string;
  table_name: string | null;
  expr: string | null;
  sql: string | null;
  unit: string | null;
  summary: string | null;
  /** a derived metric ("conversion rate = orders / visits"): computed, not a column in a table */
  derived: boolean;
  /**
   * proposed | confirmed | rejected
   *
   * A status, not a confidence score. It used to borrow a fact's
   * confidence to express "proposed 0.6 / confirmed 1.0" — that encodes
   * a two-valued state as a float, and drops it straight into the
   * "low-confidence facts" bucket besides.
   */
  status: string;
};

/** A mapping's state before one edit. */
export type MappingRevision = {
  id: Uuid;
  before: unknown;
  /** who changed it. A bare foreign key + soft-deleted users, so attribution never breaks when someone leaves; only a hard delete makes this null */
  changed_by_name: string | null;
  changed_at: Date;
};

/**
 * A discovery job proposes a mapping.
 *
 * Only one row per (concept, source), enforced by the primary key —
 * this uniqueness used to be buried inside `object_value`, invisible to
 * the database, enforceable only by explicitly closing out the
 * confirmation flow.
 *
 * Anything already decided is not overwritten: rerunning discovery
 * would compute the same rejected mapping again, and without this
 * check every rerun would erase the person's rejection all over again
 * (`ontology_proposals` hit the same trap, see `ontology_proposals`).
 */
export async function propose(
  sql: Sql,
  kbId: Uuid,
  conceptId: Uuid,
  source: string,
  tableName: string | null,
  expr: string | null,
  querySql: string | null,
  unit: string | null,
  summary: string | null,
  derived: boolean,
): Promise<Uuid> {
  // **When the `DO UPDATE ... WHERE` condition is not met, `RETURNING`
  // returns no rows at all.**
  //
  // This is real Postgres behavior, not the intuitive one: a condition
  // that blocks the update means that row does not count as touched by
  // the statement, so it does not show up in RETURNING either. A test
  // hit this directly — proposing a mapping a second time, after it had
  // been rejected, made `fetch_one` report "no rows returned".
  //
  // So the id is looked up separately: whether the update happened is
  // one question, "which row is this mapping" is another.
  const existing = await qOpt<{ id: Uuid }>(
    sql,
    `SELECT id FROM concept_mappings
      WHERE kb_id = $1 AND concept_id = $2 AND source = $3`,
    [kbId, conceptId, source],
  );
  const id = existing?.id ?? newId();
  await exec(
    sql,
    `INSERT INTO concept_mappings
         (id, kb_id, concept_id, source, table_name, expr, sql, unit, summary, derived)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (kb_id, concept_id, source) DO UPDATE
       SET table_name = EXCLUDED.table_name, expr = EXCLUDED.expr,
           sql = EXCLUDED.sql, unit = EXCLUDED.unit,
           summary = EXCLUDED.summary, derived = EXCLUDED.derived,
           updated_at = now()
       WHERE concept_mappings.status = 'proposed'`,
    [id, kbId, conceptId, source, tableName, expr, querySql, unit, summary, derived],
  );
  return id;
}

/** Still waiting for someone to decide. The Review page reads it. */
export async function proposed(
  sql: Sql,
  kbId: Uuid,
  limit: number,
  offset: number,
): Promise<ConceptMapping[]> {
  return q<ConceptMapping>(
    sql,
    `SELECT m.id, m.concept_id, e.canonical_name AS concept_name, m.source,
            m.table_name, m.expr, m.sql, m.unit, m.summary, m.derived, m.status
     FROM concept_mappings m
     JOIN entities e ON e.id = m.concept_id
     WHERE m.kb_id = $1 AND m.status = 'proposed'
     ORDER BY e.canonical_name, m.source
     LIMIT $2 OFFSET $3`,
    [kbId, limit, offset],
  );
}

/** Confirmed by a person. Query-data injects only these into the system prompt — using only confirmed definitions, never guessing from the schema each time. */
export async function confirmed(sql: Sql, kbId: Uuid, limit: number): Promise<ConceptMapping[]> {
  return q<ConceptMapping>(
    sql,
    `SELECT m.id, m.concept_id, e.canonical_name AS concept_name, m.source,
            m.table_name, m.expr, m.sql, m.unit, m.summary, m.derived, m.status
     FROM concept_mappings m
     JOIN entities e ON e.id = m.concept_id
     WHERE m.kb_id = $1 AND m.status = 'confirmed'
     ORDER BY e.canonical_name, m.source
     LIMIT $2`,
    [kbId, limit],
  );
}

/**
 * Someone decided.
 *
 * Changes the status, does not delete the row: both confirming and
 * rejecting really happened. Keeping the rejection is also useful right
 * away — `propose`'s `WHERE status = 'proposed'` relies on it to avoid
 * flipping it back to "pending".
 */
export async function decide(
  sql: Sql,
  kbId: Uuid,
  mappingId: Uuid,
  status: string,
  actor: Uuid,
): Promise<void> {
  const res = await exec(
    sql,
    `UPDATE concept_mappings
        SET status = $3, decided_by = $4, decided_at = now(), updated_at = now()
      WHERE id = $2 AND kb_id = $1`,
    [kbId, mappingId, status, actor],
  );
  if (res.count === 0) throw AppError.notFound();
}

/**
 * Edits a confirmed mapping. The version before the edit goes into
 * revisions first — query-data needs to answer, when looking back at a
 * historical report, "how was this number computed back then".
 *
 * Stores a full snapshot, not a diff: reading it back needs "what was
 * it at the time", and a diff would have to be replayed from the start
 * to answer that.
 */
export async function revise(
  sql: Sql,
  kbId: Uuid,
  mappingId: Uuid,
  tableName: string | null,
  expr: string | null,
  querySql: string | null,
  unit: string | null,
  summary: string | null,
  derived: boolean,
  actor: Uuid,
): Promise<void> {
  await sql.begin(async (tx) => {
    const before = await qOpt<{ before: unknown }>(
      tx,
      `SELECT to_jsonb(m) - 'id' - 'kb_id' AS before FROM concept_mappings m
        WHERE m.id = $2 AND m.kb_id = $1`,
      [kbId, mappingId],
    );
    if (!before) throw AppError.notFound();
    await exec(
      tx,
      `INSERT INTO concept_mapping_revisions (id, mapping_id, before, changed_by)
       VALUES ($1, $2, $3, $4)`,
      [newId(), mappingId, before.before, actor],
    );
    await exec(
      tx,
      `UPDATE concept_mappings
          SET table_name = $3, expr = $4, sql = $5, unit = $6, summary = $7,
              derived = $8, updated_at = now()
        WHERE id = $2 AND kb_id = $1`,
      [kbId, mappingId, tableName, expr, querySql, unit, summary, derived],
    );
  });
}

/**
 * What the data-mapping page reads: one page of mappings, filterable by
 * status and keyword.
 *
 * Neither `proposed` nor `confirmed` is enough on its own — the first
 * only fetches what is still pending, the second is for query-data's
 * prompt (no pagination, no filter, capped at 30). What a person needs
 * to see is everything, including what they themselves have rejected:
 * the rejection left a record, so it should stay visible, otherwise
 * "why wasn't this concept mapped" can never be answered.
 */
export async function page(
  sql: Sql,
  kbId: Uuid,
  status: string | null,
  q_: string | null,
  limit: number,
  offset: number,
): Promise<[ConceptMapping[], number]> {
  // Both the concept name and the data source name are searchable: what
  // people remember might be "GMV", or it might be "the one wired to
  // orders".
  const where = `WHERE m.kb_id = $1
         AND ($2::text IS NULL OR m.status = $2)
         AND ($3::text IS NULL
              OR e.canonical_name ILIKE '%' || $3 || '%'
              OR m.source ILIKE '%' || $3 || '%'
              OR m.table_name ILIKE '%' || $3 || '%')`;
  const rows = await q<ConceptMapping>(
    sql,
    `SELECT m.id, m.concept_id, e.canonical_name AS concept_name, m.source,
            m.table_name, m.expr, m.sql, m.unit, m.summary, m.derived, m.status
     FROM concept_mappings m
     JOIN entities e ON e.id = m.concept_id
     ${where}
     ORDER BY e.canonical_name, m.source
     LIMIT $4 OFFSET $5`,
    [kbId, status, q_, limit, offset],
  );
  const total = await qOne<{ count: string }>(
    sql,
    `SELECT count(*) FROM concept_mappings m
     JOIN entities e ON e.id = m.concept_id ${where}`,
    [kbId, status, q_],
  );
  return [rows, Number(total.count)];
}

/** How many of each status. The filter chips on the page show counts; querying three times would be three full scans. */
export async function statusCounts(sql: Sql, kbId: Uuid): Promise<[number, number, number]> {
  const row = await qOne<{ proposed: string; confirmed: string; rejected: string }>(
    sql,
    `SELECT count(*) FILTER (WHERE status = 'proposed') AS proposed,
            count(*) FILTER (WHERE status = 'confirmed') AS confirmed,
            count(*) FILTER (WHERE status = 'rejected') AS rejected
       FROM concept_mappings WHERE kb_id = $1`,
    [kbId],
  );
  return [Number(row.proposed), Number(row.confirmed), Number(row.rejected)];
}

/**
 * How many times a mapping has changed, and what it looked like before
 * each change.
 *
 * `revise` has written to `concept_mapping_revisions` since the table
 * was created, and **nothing read it before now** — the trail was kept
 * for nobody. 0006 says the point of keeping it is to let query-data
 * answer "how was this number computed last quarter", and that requires
 * someone able to see it.
 */
export async function revisions(
  sql: Sql,
  kbId: Uuid,
  mappingId: Uuid,
): Promise<MappingRevision[]> {
  // kbId is checked through the JOIN to confirm ownership: revisions has
  // no kb_id of its own, and without this check you could read another
  // KB's mapping history.
  return q<MappingRevision>(
    sql,
    `SELECT r.id, r.before, u.display_name AS changed_by_name, r.changed_at
       FROM concept_mapping_revisions r
       JOIN concept_mappings m ON m.id = r.mapping_id
       LEFT JOIN users u ON u.id = r.changed_by
      WHERE r.mapping_id = $2 AND m.kb_id = $1
      ORDER BY r.changed_at DESC
      LIMIT 50`,
    [kbId, mappingId],
  );
}

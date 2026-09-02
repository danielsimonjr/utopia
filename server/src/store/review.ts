/**
 * The **real counts** for the review queue.
 *
 * The left-column badge used to read the length of the array the API
 * returned, and that endpoint is capped at 100 — so a KB with 164
 * low-confidence facts showed 100. Clear those 100, and the remaining
 * 64 resurface, looking like they appeared out of nowhere.
 *
 * **Counting and fetching are two different jobs, and must stay
 * separate.** Fetching has a cap (one page of ten, next page for more);
 * counting does not: `count(*)` runs against the same WHERE as the
 * list, on the same index.
 *
 * The eight COUNTs are combined into one query instead of eight
 * round trips: they all target the same KB, and one round trip fills
 * the whole left column at once, instead of switching KBs and watching
 * the column populate one badge at a time.
 */

import { qOne, type Sql } from "../core/db";
import type { Uuid } from "../core/ids";

/** The real count for each review queue bucket. */
export type ReviewCounts = {
  duplicates: number;
  conflicts: number;
  unconfirmed: number;
  lowconf: number;
  mappings: number;
  violations: number;
  defects: number;
  merges: number;
};

/**
 * The low-confidence threshold. Shared as one constant with the review
 * routes — two places each writing their own number eventually drifts
 * into "the badge says 12, clicking in shows 9".
 */
export const LOW_CONFIDENCE_BELOW = 0.75;

export async function counts(sql: Sql, kbId: Uuid): Promise<ReviewCounts> {
  const row = await qOne<{
    duplicates: string;
    conflicts: string;
    unconfirmed: string;
    lowconf: string;
    mappings: string;
    violations: string;
    defects: string;
    merges: string;
  }>(
    sql,
    `SELECT
       (SELECT count(*) FROM resolution_reviews
         WHERE kb_id = $1 AND status = 'pending') AS duplicates,
       (SELECT count(*) FROM fact_conflicts
         WHERE kb_id = $1 AND status = 'open') AS conflicts,
       -- unconfirmed = has evidence, but every chunk that evidence
       -- points to has been superseded by a newer version
       (SELECT count(*) FROM facts f
         WHERE f.kb_id = $1 AND f.invalidated_at IS NULL
           AND EXISTS (SELECT 1 FROM fact_evidence fe WHERE fe.fact_id = f.id)
           AND NOT EXISTS (SELECT 1 FROM fact_evidence fe
                             JOIN chunks c ON c.id = fe.chunk_id
                            WHERE fe.fact_id = f.id
                              AND c.superseded_at IS NULL)) AS unconfirmed,
       (SELECT count(*) FROM facts
         WHERE kb_id = $1 AND invalidated_at IS NULL
           AND confidence < $2 AND derived_by_rule IS NULL) AS lowconf,
       (SELECT count(*) FROM concept_mappings
         WHERE kb_id = $1 AND status = 'proposed') AS mappings,
       (SELECT count(*) FROM axiom_violations
         WHERE kb_id = $1 AND status = 'open') AS violations,
       (SELECT count(*) FROM ontology_defects
         WHERE kb_id = $1 AND status = 'open') AS defects,
       (SELECT count(*) FROM entity_merges WHERE kb_id = $1) AS merges`,
    [kbId, LOW_CONFIDENCE_BELOW],
  );
  return {
    duplicates: Number(row.duplicates),
    conflicts: Number(row.conflicts),
    unconfirmed: Number(row.unconfirmed),
    lowconf: Number(row.lowconf),
    mappings: Number(row.mappings),
    violations: Number(row.violations),
    defects: Number(row.defects),
    merges: Number(row.merges),
  };
}

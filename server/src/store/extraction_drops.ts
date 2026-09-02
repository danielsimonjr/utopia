/**
 * Extraction drop signals: which facts were extracted but never landed,
 * and why.
 *
 * Kept separate from `ontology_misses` on purpose — that table says
 * "your ontology is missing these", read by whoever maintains the
 * ontology, acted on by adding a type; this one says "these facts did
 * not land", read by whoever uploaded the document, acted on by editing
 * the document or the ontology. Mixing them into one panel makes
 * neither story clear.
 *
 * A failure to record here never affects extraction (callers always
 * swallow the error) — missing one signal is far better than aborting a
 * whole document's extraction because recording a signal failed.
 */

import { exec, q, type Sql } from "../core/db";
import type { Uuid } from "../core/ids";

/** Reason codes. The frontend looks up copy by these, so they are a stable contract — never change the literals. */
export const reason = {
  /** the subject was never declared in entities -> type unknown, an attribute's domain cannot be checked */
  SUBJECT_NOT_DECLARED: "subject_not_declared",
  /** an attribute landed on a class it should not (salary on Organization) */
  ATTR_DOMAIN_MISMATCH: "attr_domain_mismatch",
  /** an attribute fact gave neither a value nor an object */
  ATTR_NO_VALUE: "attr_no_value",
  /** a value did not match its datatype; normalization failed */
  ATTR_DATATYPE: "attr_datatype",
  /** the model self-reported a confidence below the threshold */
  LOW_CONFIDENCE: "low_confidence",
  /** a relation fact is missing its object */
  OBJECT_MISSING: "object_missing",
  /** what the model gave for this one item was malformed (missing predicate, etc.) -> only this item is skipped, not the whole block */
  MALFORMED_ITEM: "malformed_item",
  /**
   * The subject's type does not match the relation's declared domain,
   * **and swapping it would not be valid either** — that means the
   * wrong relation or the wrong type was picked, not a direction
   * problem. Stored as-is, plus this signal, for a person to look at —
   * not guessed at automatically.
   */
  DOMAIN_MISMATCH: "domain_mismatch",
  /**
   * What the model called an "entity name" is actually a whole sentence
   * or clause — not the name of a thing. These never match a mention
   * anywhere else, sit as isolated points on the graph, and drag down
   * resolution.
   */
  NOT_AN_ENTITY_NAME: "not_an_entity_name",
  /**
   * The subject violated the domain while the object matched it, and
   * subject/object have already been swapped to follow the ontology's
   * declared direction. **This action must leave a trace** — a silent,
   * automatic rewrite is exactly what 0001 argues against.
   */
  DIRECTION_CORRECTED: "direction_corrected",
  /** the model's output got cut off (hit max_tokens) -> whatever was already complete is kept, the tail is dropped */
  TRUNCATED_REPLY: "truncated_reply",
} as const;

export async function record(
  sql: Sql,
  kbId: Uuid,
  documentId: Uuid,
  reason_: string,
  detail: string,
  example: string | null,
): Promise<void> {
  await exec(
    sql,
    `INSERT INTO extraction_drops (kb_id, document_id, reason, detail, example)
     VALUES ($1, $2, $3, left($4, 120), left($5, 200))
     ON CONFLICT (kb_id, document_id, reason, detail)
     DO UPDATE SET count = extraction_drops.count + 1,
                   example = COALESCE(EXCLUDED.example, extraction_drops.example),
                   updated_at = now()`,
    [kbId, documentId, reason_, detail, example],
  );
}

/** Clears this document's old signals when a re-extraction starts — this round tells this document's story from scratch. */
export async function clearForDocument(sql: Sql, documentId: Uuid): Promise<void> {
  await exec(sql, `DELETE FROM extraction_drops WHERE document_id = $1`, [documentId]);
}

/** A KB's extraction drop signal. */
export type ExtractionDrop = {
  document_id: Uuid;
  reason: string;
  detail: string;
  count: number;
  example: string | null;
};

/**
 * A KB's every drop signal. Rows aggregate by (document x reason x
 * specific object), so the row count stays small — one fetch lets the
 * Library both total up each document and expand the details directly,
 * without a request per row.
 */
export async function forKb(sql: Sql, kbId: Uuid): Promise<ExtractionDrop[]> {
  return q<ExtractionDrop>(
    sql,
    `SELECT document_id, reason, detail, count, example FROM extraction_drops
     WHERE kb_id = $1 ORDER BY count DESC, reason LIMIT 2000`,
    [kbId],
  );
}

/**
 * The temporal engine (S3): contradiction detection and automatic
 * closing for functional state relations.
 *
 * Principles:
 * - Pure rule-based judgment, zero LLM — the ambiguity has already been
 *   absorbed upstream (resolution merges entities, the ontology marks
 *   functional).
 * - Closing works by "invalidate + rewrite", never in place: the old
 *   assertion's invalidated_at records "when it got corrected" (the
 *   cognitive axis); the correcting row closes the interval (the world
 *   axis) and points back at the old row via `supersedes` — so "replay
 *   the past using what we believed at the time" still holds.
 * - The closing point only ever uses world time (the new fact's
 *   valid_from), never the ingestion moment as a stand-in.
 * - When unsure (missing time / simultaneous start / low confidence),
 *   never force a close — it goes into `fact_conflicts` for a person to
 *   decide.
 */

import { q, qOne, qOpt, exec, type Sql } from "../core/db";
import { AppError } from "../core/errors";
import { newId, type Uuid } from "../core/ids";

/** `valid_to_precision` meaning "it ended, but we don't know when". */
export const ENDED_UNKNOWN = "unknown";

/** A fact's world-time validity window. */
export type Validity = {
  from: Date | null;
  from_precision: string | null;
  to: Date | null;
  to_precision: string | null;
};

/** Start known, end unknown or not applicable. */
export function validityStarting(from: Date | null, fromPrecision: string | null): Validity {
  return { from, from_precision: fromPrecision, to: null, to_precision: null };
}

/** The source says it ended, but not when. */
export function endedWhenUnknown(v: Validity): Validity {
  return { ...v, to: null, to_precision: ENDED_UNKNOWN };
}

export function hasEnded(v: Validity): boolean {
  return v.to != null || v.to_precision === ENDED_UNKNOWN;
}

/** Which side must be unique: subject-side (Zhang San only `reports_to` one person at a time) vs. object-side (a project has only one person `leads` it at a time). */
export type Uniqueness = "SubjectSide" | "ObjectSide";

/**
 * The reconciliation result: the ids of correcting rows produced by an
 * automatic close (the caller records these as needed — reverting a
 * merge, for example, must undo them) and the number of conflicts sent
 * to human review.
 */
export type ReconcileReport = {
  corrected: Uuid[];
  conflicts: number;
};

function emptyReport(): ReconcileReport {
  return { corrected: [], conflicts: 0 };
}

/** A matching open-interval fact (at most one under the invariant; historical dirty data from before this engine may have more). */
type OpenFact = {
  id: Uuid;
  valid_from: Date | null;
  valid_from_precision: string | null;
};

/** Facts below this confidence may not automatically rewrite history (goes to review instead). */
const AUTO_CLOSE_MIN_CONFIDENCE = 0.75;

/**
 * Reconciliation after one new state fact lands, along the given
 * uniqueness direction. The caller is responsible for checking that the
 * relation really has that direction's uniqueness and is temporal =
 * state (the ontology metadata is already loaded in the extraction
 * task).
 *
 * The object can be an entity (object_id) or a literal (object_value,
 * an attribute fact) — "a different object" is judged by comparing the
 * (object_id, object_value) pair together: a salary going from 30k to
 * 35k and "swapped from Zhang San to Li Si" go through the same closing
 * path.
 */
export async function reconcileNewFact(
  sql: Sql,
  kbId: Uuid,
  newFactId: Uuid,
  subjectId: Uuid,
  predicateId: Uuid,
  objectId: Uuid | null,
  objectValue: unknown,
  direction: Uniqueness,
  newValidity: Validity,
  newConfidence: number,
): Promise<ReconcileReport> {
  // A new fact whose interval has already ended is a historical
  // statement, and does not threaten the "open interval is unique"
  // invariant — it triggers no rewrite. (Overlap between two closed
  // intervals is finer-grained interval algebra, not auto-adjudicated
  // here — left to a human in Review.)
  if (hasEnded(newValidity)) {
    return emptyReport();
  }
  // Object-side uniqueness only makes sense for an entity object
  // (a literal is not "occupied").
  if (direction === "ObjectSide" && objectId == null) {
    return emptyReport();
  }
  // Point check on the invariant: subject-side = same (kb, S, P) with a
  // different object; object-side = same (kb, P, O) with a different
  // subject.
  let open: OpenFact[];
  if (direction === "SubjectSide") {
    open = await q<OpenFact>(
      sql,
      `SELECT id, valid_from, valid_from_precision FROM facts
       WHERE kb_id = $1 AND subject_id = $2 AND predicate_id = $3
         AND valid_to IS NULL AND valid_to_precision IS NULL
         AND invalidated_at IS NULL
         AND id <> $4
         AND (object_id IS DISTINCT FROM $5 OR object_value IS DISTINCT FROM $6)`,
      [kbId, subjectId, predicateId, newFactId, objectId, objectValue ?? null],
    );
  } else {
    open = await q<OpenFact>(
      sql,
      `SELECT id, valid_from, valid_from_precision FROM facts
       WHERE kb_id = $1 AND object_id = $5 AND predicate_id = $3
         AND valid_to IS NULL AND valid_to_precision IS NULL
         AND invalidated_at IS NULL
         AND id <> $4 AND subject_id IS DISTINCT FROM $2`,
      [kbId, subjectId, predicateId, newFactId, objectId],
    );
  }
  if (open.length === 0) {
    return emptyReport();
  }

  const report = emptyReport();
  for (const old of open) {
    const of_ = old.valid_from;
    const nf = newValidity.from;
    if (nf == null) {
      // The new fact has no world time: there is no closing point to
      // speak of -> human review.
      await recordConflict(sql, kbId, old.id, newFactId, "no_time");
      report.conflicts += 1;
    } else if (of_ != null && of_.getTime() === nf.getTime()) {
      // Started at the same instant: which one supersedes which is
      // unclear -> human review.
      await recordConflict(sql, kbId, old.id, newFactId, "simultaneous");
      report.conflicts += 1;
    } else if (of_ != null && nf.getTime() < of_.getTime()) {
      // The new fact started earlier: it is the historical predecessor,
      // closed at the old fact's start.
      if (newConfidence < AUTO_CLOSE_MIN_CONFIDENCE) {
        await recordConflict(sql, kbId, old.id, newFactId, "low_confidence");
        report.conflicts += 1;
      } else {
        report.corrected.push(
          await closeSuperseded(sql, newFactId, of_, old.valid_from_precision ?? "day"),
        );
      }
    } else {
      // The usual succession: the old fact closes at the new fact's
      // start (this also applies when the old fact has no known start —
      // start unknown but already ended).
      if (newConfidence < AUTO_CLOSE_MIN_CONFIDENCE) {
        await recordConflict(sql, kbId, old.id, newFactId, "low_confidence");
        report.conflicts += 1;
      } else {
        report.corrected.push(
          await closeSuperseded(sql, old.id, nf, newValidity.from_precision ?? "day"),
        );
      }
    }
  }
  return report;
}

type MovedFact = {
  id: Uuid;
  subject_id: Uuid;
  predicate_id: Uuid;
  object_id: Uuid | null;
  object_value: unknown;
  valid_from: Date | null;
  valid_from_precision: string | null;
  confidence: number;
  functional: boolean;
  inverse_functional: boolean;
};

/**
 * Reconciliation after an entity merge moves facts over: a fact whose
 * subject/object just changed is equivalent to "a freshly landed
 * observation" — folding two objects into one is the first moment a
 * uniqueness invariant could even see them collide. Facts are replayed
 * as inserts in `recorded_at` order; non-unique relations, already
 * closed intervals, and facts already invalidated by an earlier
 * rewrite in this same pass are skipped automatically.
 *
 * The correcting row ids this returns are recorded by the caller into
 * the merge ledger — these corrections exist only because of the merge
 * itself, and reverting the merge must undo them too, or a correction
 * would be left hanging on the target with its cause gone.
 */
export async function reconcileMovedFacts(
  sql: Sql,
  kbId: Uuid,
  factIds: Uuid[],
): Promise<ReconcileReport> {
  if (factIds.length === 0) {
    return emptyReport();
  }
  const rows = await q<MovedFact>(
    sql,
    `SELECT f.id, f.subject_id, f.predicate_id, f.object_id, f.object_value,
            f.valid_from, f.valid_from_precision,
            f.confidence, r.functional, r.inverse_functional
     FROM facts f JOIN relation_types r ON r.id = f.predicate_id
     WHERE f.kb_id = $1 AND f.id = ANY($2)
       AND f.invalidated_at IS NULL AND f.valid_to IS NULL
       AND r.temporal = 'state' AND (r.functional OR r.inverse_functional)
     ORDER BY f.recorded_at`,
    [kbId, factIds],
  );

  const report = emptyReport();
  for (const f of rows) {
    // A literal (attribute) fact is reconciled too after a merge: two
    // "Zhang San"s folding into one, a salary collision must still
    // close.
    if (f.object_id == null && f.object_value == null) {
      continue;
    }
    // An earlier close in this loop may already have invalidated this
    // row — recheck it is still alive before treating it as "new".
    const alive = await qOne<{ exists: boolean }>(
      sql,
      `SELECT EXISTS (SELECT 1 FROM facts
                      WHERE id = $1 AND invalidated_at IS NULL AND valid_to IS NULL) AS exists`,
      [f.id],
    );
    if (!alive.exists) {
      continue;
    }
    const directions: Uniqueness[] = [];
    if (f.functional) directions.push("SubjectSide");
    if (f.inverse_functional) directions.push("ObjectSide");
    for (const dir of directions) {
      const r = await reconcileNewFact(
        sql,
        kbId,
        f.id,
        f.subject_id,
        f.predicate_id,
        f.object_id,
        f.object_value,
        dir,
        validityStarting(f.valid_from, f.valid_from_precision),
        f.confidence,
      );
      report.corrected.push(...r.corrected);
      report.conflicts += r.conflicts;
    }
  }
  return report;
}

/**
 * Invalidate + rewrite: the old row gets `invalidated_at` (the
 * cognitive axis), a correcting row is inserted closing the interval
 * (the world axis), and evidence references are copied over. Returns
 * the correcting row's id.
 */
export async function closeSuperseded(
  sql: Sql,
  factId: Uuid,
  validTo: Date,
  validToPrecision: string,
): Promise<Uuid> {
  return sql.begin(async (tx) => {
    const corrected = newId();
    const inserted = await qOpt<{ id: Uuid }>(
      tx,
      `INSERT INTO facts (id, kb_id, subject_id, predicate_id, object_id, object_value,
                          valid_from, valid_from_precision,
                          valid_to, valid_to_precision, confidence, supersedes)
       SELECT $1, kb_id, subject_id, predicate_id, object_id, object_value,
              valid_from, valid_from_precision, $3, $4, confidence, id
       FROM facts WHERE id = $2 AND invalidated_at IS NULL
       RETURNING id`,
      [corrected, factId, validTo, validToPrecision],
    );
    // Already corrected by a concurrent process: do not act twice.
    if (!inserted) {
      return factId;
    }
    await exec(tx, `UPDATE facts SET invalidated_at = now() WHERE id = $1`, [factId]);
    await exec(
      tx,
      // The surface predicate travels with the evidence: what is being
      // corrected is the time interval, not what the source text said.
      `INSERT INTO fact_evidence (fact_id, chunk_id, quote, proposed_predicate, document_id, doc_version)
       SELECT $1, chunk_id, quote, proposed_predicate, document_id, doc_version
       FROM fact_evidence WHERE fact_id = $2
       ON CONFLICT DO NOTHING`,
      [corrected, factId],
    );
    return corrected;
  });
}

async function recordConflict(
  sql: Sql,
  kbId: Uuid,
  oldFactId: Uuid,
  newFactId: Uuid,
  reason: string,
): Promise<void> {
  await exec(
    sql,
    `INSERT INTO fact_conflicts (id, kb_id, old_fact_id, new_fact_id, reason)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (old_fact_id, new_fact_id) DO NOTHING`,
    [newId(), kbId, oldFactId, newFactId, reason],
  );
}

/** A time conflict (double sided fact + interval, with names) for the Review page. */
export type ConflictView = {
  id: Uuid;
  /** no_time | simultaneous | low_confidence */
  reason: string;
  created_at: Date;
  predicate_label: string;
  old_fact_id: Uuid;
  old_subject: string;
  old_object: string | null;
  old_valid_from: Date | null;
  new_fact_id: Uuid;
  new_subject: string;
  new_object: string | null;
  new_valid_from: Date | null;
  new_confidence: number;
};

/**
 * The Review page's conflict list (both sides' facts, with names and
 * intervals). Lazily cleaned up: a conflict where either side has
 * already been invalidated (rejected, or rewritten by another close) is
 * meaningless — it is automatically dequeued and marked stale, to avoid
 * adjudicating a zombie conflict (like closing Eve against an already-
 * rejected Ivan).
 */
export async function listConflicts(
  sql: Sql,
  kbId: Uuid,
  limit: number,
  offset: number,
): Promise<ConflictView[]> {
  await exec(
    sql,
    `UPDATE fact_conflicts c
     SET status = 'resolved', resolution = 'stale', resolved_at = now()
     WHERE c.kb_id = $1 AND c.status = 'open'
       AND EXISTS (SELECT 1 FROM facts f
                   WHERE f.id IN (c.old_fact_id, c.new_fact_id)
                     AND f.invalidated_at IS NOT NULL)`,
    [kbId],
  );
  return q<ConflictView>(
    sql,
    `SELECT c.id, c.reason, c.created_at, r.label AS predicate_label,
            c.old_fact_id, os.canonical_name AS old_subject,
            oo.canonical_name AS old_object, fo.valid_from AS old_valid_from,
            c.new_fact_id, ns.canonical_name AS new_subject,
            no_.canonical_name AS new_object, fn_.valid_from AS new_valid_from,
            fn_.confidence AS new_confidence
     FROM fact_conflicts c
     JOIN facts fo ON fo.id = c.old_fact_id
     JOIN facts fn_ ON fn_.id = c.new_fact_id
     JOIN entities os ON os.id = fo.subject_id
     JOIN entities ns ON ns.id = fn_.subject_id
     JOIN relation_types r ON r.id = fo.predicate_id
     LEFT JOIN entities oo ON oo.id = fo.object_id
     LEFT JOIN entities no_ ON no_.id = fn_.object_id
     WHERE c.kb_id = $1 AND c.status = 'open'
     ORDER BY c.created_at DESC
     LIMIT $2 OFFSET $3`,
    [kbId, limit, offset],
  );
}

/**
 * Human adjudication: close (the old fact closes at close_at or the new
 * fact's start) / keep (they coexist, no real contradiction) /
 * reject_new (the new fact is an extraction error, invalidate it).
 */
export async function resolveConflict(
  sql: Sql,
  kbId: Uuid,
  conflictId: Uuid,
  resolution: string,
  closeAt: Date | null,
): Promise<void> {
  const row = await qOpt<{ old_fact_id: Uuid; new_fact_id: Uuid; valid_from: Date | null }>(
    sql,
    `SELECT c.old_fact_id, c.new_fact_id, fn_.valid_from
     FROM fact_conflicts c JOIN facts fn_ ON fn_.id = c.new_fact_id
     WHERE c.id = $1 AND c.kb_id = $2 AND c.status = 'open'`,
    [conflictId, kbId],
  );
  if (!row) throw AppError.notFound();
  const { old_fact_id: oldFactId, new_fact_id: newFactId, valid_from: newFrom } = row;

  let stored: string;
  if (resolution === "close") {
    const at = closeAt ?? newFrom;
    if (at == null) {
      throw AppError.invalid(
        "close_at_required",
        "close_at is required when the new fact has no start time",
      );
    }
    await closeSuperseded(sql, oldFactId, at, "day");
    stored = "closed";
  } else if (resolution === "keep") {
    stored = "kept_both";
  } else if (resolution === "reject_new") {
    await exec(sql, `UPDATE facts SET invalidated_at = now() WHERE id = $1`, [newFactId]);
    // Ripple effect: other open conflicts caused by this same new fact
    // are dequeued too (the new fact is dead now, nothing left to
    // adjudicate).
    await exec(
      sql,
      `UPDATE fact_conflicts
       SET status = 'resolved', resolution = 'rejected_new', resolved_at = now()
       WHERE new_fact_id = $1 AND status = 'open' AND id <> $2`,
      [newFactId, conflictId],
    );
    stored = "rejected_new";
  } else {
    throw AppError.validation(`Unknown resolution: ${resolution}`);
  }
  await exec(
    sql,
    `UPDATE fact_conflicts SET status = 'resolved', resolution = $3, resolved_at = now()
     WHERE id = $1 AND kb_id = $2`,
    [conflictId, kbId, stored],
  );
}

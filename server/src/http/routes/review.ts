/**
 * Review queue API: candidate duplicate pairs, low-confidence facts,
 * temporal conflicts, and merge log / revert.
 */

import type { Hono } from "hono";
import type { AppState } from "../../state";
import * as store from "../../store";
import * as auth from "../../auth";
import { AppError } from "../../core/errors";
import type { Uuid } from "../../core/ids";
import { uuidParam, queryStr, queryInt, clampLimit, clampOffset } from "../context";
import { qOpt } from "../../core/db";

/** The server-side default page size, not a ceiling — the frontend can ask for fewer; more is blocked by the clamp. */
const REVIEW_PAGE = 10;

type FactSnapshot = { subject: string; predicate: string | null; object: string | null; confidence: number };

/** A fact's snapshot, for the decision ledger: after `reject`, the fact disappears from the graph, so the ledger entry must display fine on its own. Always taken before the action runs. */
async function factSnapshot(state: AppState, kbId: Uuid, factId: Uuid): Promise<FactSnapshot | null> {
  // The object may be an entity or a literal; a structured literal
  // prefers `summary` (the same display convention as the queue card).
  const row = await qOpt<{ subject: string; predicate: string | null; object: string | null; confidence: number }>(
    state.sql,
    `SELECT s.canonical_name AS subject, COALESCE(r.label, fact_surface_predicate(f.id)) AS predicate,
            COALESCE(o.canonical_name, f.object_value ->> 'summary', f.object_value #>> '{}') AS object,
            f.confidence
     FROM facts f
     JOIN entities s ON s.id = f.subject_id
     LEFT JOIN relation_types r ON r.id = f.predicate_id
     LEFT JOIN entities o ON o.id = f.object_id
     WHERE f.id = $1 AND f.kb_id = $2`,
    [factId, kbId],
  ).catch(() => null);
  return row;
}

export function registerReviewRoutes(api: Hono, state: AppState): void {
  // The review queue: **counts and content are fetched separately.**
  //
  // This used to return all eight queues at once, each capped at a fixed
  // 100, with the frontend paging them client-side — so the sidebar's
  // badge was a truncated number (164 low-confidence facts in the KB, the
  // UI said 100), and anything past page ten did not exist as far as the
  // UI was concerned.
  //
  // Now: counts always come back (eight COUNTs in one query, using the
  // same WHERE as the list), and content is one page of whichever queue
  // is selected. Switching queues or paging costs one extra round trip
  // each, in exchange for **numbers that stop lying**, and a KB with a
  // hundred thousand pending items can still be paged to the end.
  api.get("/kbs/:id/review", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    await store.access.requireKb(state.sql, user, kbId, "viewer");
    const counts = await store.review.counts(state.sql, kbId);
    const queue = queryStr(c, "queue") ?? "duplicates";
    const limit = clampLimit(queryInt(c, "limit"), REVIEW_PAGE, 200);
    const offset = clampOffset(queryInt(c, "offset"));

    let items: unknown;
    switch (queue) {
      case "duplicates":
        items = await store.resolution.list_reviews(state.sql, kbId, limit, offset);
        break;
      case "conflicts":
        items = await store.temporal.listConflicts(state.sql, kbId, limit, offset);
        break;
      case "unconfirmed":
        items = await store.graph.stale_facts(state.sql, kbId, limit, offset);
        break;
      case "lowconf":
        items = await store.graph.low_confidence_facts(state.sql, kbId, store.review.LOW_CONFIDENCE_BELOW, limit, offset);
        break;
      case "mappings":
        items = await store.mappings.proposed(state.sql, kbId, limit, offset);
        break;
      case "violations":
        items = await store.reasoning.openViolations(state.sql, kbId, limit, offset);
        break;
      case "defects":
        items = await store.reasoning.openDefects(state.sql, kbId, limit, offset);
        break;
      case "merges":
        items = await store.resolution.list_merges(state.sql, kbId, limit, offset);
        break;
      default:
        // An unrecognized queue name is reported as a contract error,
        // not silently answered with an empty list — a silent empty
        // list would make a typo look like "this queue is empty".
        throw AppError.invalid("unknown_queue", `no review queue named ${queue}`);
    }
    return c.json({ counts, queue, items });
  });

  // Manually closes a fact's valid interval ("this ended at some point")
  // — goes through invalidate + rewrite, the same mechanism as automatic
  // closure, so the ledger can replay it.
  api.post("/kbs/:id/facts/:fact_id/close", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    const factId = uuidParam(c, "fact_id");
    await store.access.requireKb(state.sql, user, kbId, "editor");
    const body = (await c.req.json()) as { valid_to: string };
    const validTo = new Date(body.valid_to);
    // Ownership and status check: only a fact in this KB, not invalidated, with an open interval can be closed.
    const ok = await qOpt<{ id: Uuid }>(
      state.sql,
      `SELECT id FROM facts WHERE id = $1 AND kb_id = $2 AND invalidated_at IS NULL AND valid_to IS NULL`,
      [factId, kbId],
    );
    if (!ok) throw AppError.notFound();
    const snap = await factSnapshot(state, kbId, factId);
    // The person picked a date in the UI, so the closing point is day precision.
    await store.temporal.closeSuperseded(state.sql, factId, validTo, "day");
    if (snap) {
      await store.audit
        .record(state.sql, kbId, user.id, "fact.close", "fact", factId, { ...snap, valid_to: validTo.toISOString() })
        .catch(() => {});
    }
    state.emitReview(kbId);
    return c.json({ ok: true });
  });

  // Temporal conflict adjudication (S3: the ones automatic closure could not call).
  api.post("/kbs/:id/conflicts/:conflict_id", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    const conflictId = uuidParam(c, "conflict_id");
    await store.access.requireKb(state.sql, user, kbId, "editor");
    const body = (await c.req.json()) as { action: string; close_at?: string };
    // Snapshots both sides' triples: adjudication invalidates/rewrites facts, so copy before acting.
    const snap = await qOpt<{
      old_subject: string;
      old_object: string | null;
      new_subject: string;
      new_object: string | null;
      predicate_label: string;
    }>(
      state.sql,
      `SELECT os.canonical_name AS old_subject, oo.canonical_name AS old_object,
              ns.canonical_name AS new_subject, no_.canonical_name AS new_object,
              r.label AS predicate_label
       FROM fact_conflicts c
       JOIN facts fo ON fo.id = c.old_fact_id
       JOIN facts fn_ ON fn_.id = c.new_fact_id
       JOIN entities os ON os.id = fo.subject_id
       LEFT JOIN entities oo ON oo.id = fo.object_id
       JOIN entities ns ON ns.id = fn_.subject_id
       LEFT JOIN entities no_ ON no_.id = fn_.object_id
       JOIN relation_types r ON r.id = fo.predicate_id
       WHERE c.id = $1 AND c.kb_id = $2`,
      [conflictId, kbId],
    ).catch(() => null);
    const closeAt = body.close_at ? new Date(body.close_at) : null;
    await store.temporal.resolveConflict(state.sql, kbId, conflictId, body.action, closeAt);
    if (snap) {
      const action = body.action === "close" ? "conflict.close_old" : body.action === "keep" ? "conflict.keep_both" : "conflict.reject_new";
      await store.audit
        .record(state.sql, kbId, user.id, action, "conflict", conflictId, {
          predicate: snap.predicate_label,
          old_subject: snap.old_subject,
          old_object: snap.old_object,
          new_subject: snap.new_subject,
          new_object: snap.new_object,
          close_at: closeAt?.toISOString() ?? null,
        })
        .catch(() => {});
    }
    state.emitReview(kbId);
    return c.json({ ok: true });
  });

  api.post("/kbs/:id/review/:review_id", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    const reviewId = uuidParam(c, "review_id");
    await store.access.requireKb(state.sql, user, kbId, "editor");
    const body = (await c.req.json()) as { action: string };
    const snap = await qOpt<{ left: string; right: string; score: number }>(
      state.sql,
      `SELECT a.canonical_name AS left, b.canonical_name AS right, rr.score
       FROM resolution_reviews rr
       JOIN entities a ON a.id = rr.left_id
       JOIN entities b ON b.id = rr.right_id
       WHERE rr.id = $1 AND rr.kb_id = $2`,
      [reviewId, kbId],
    ).catch(() => null);
    await store.resolution.decide_review(state.sql, kbId, reviewId, body.action, user.id);
    if (snap) {
      await store.audit
        .record(state.sql, kbId, user.id, body.action === "merge" ? "review.merge" : "review.keep", "review", reviewId, {
          left: snap.left,
          right: snap.right,
          score: snap.score,
        })
        .catch(() => {});
    }
    state.emitReview(kbId);
    return c.json({ ok: true });
  });

  api.post("/kbs/:id/facts/:fact_id/confirm", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    const factId = uuidParam(c, "fact_id");
    await store.access.requireKb(state.sql, user, kbId, "editor");
    const snap = await factSnapshot(state, kbId, factId);
    await store.graph.confirm_fact(state.sql, kbId, factId);
    if (snap) {
      await store.audit.record(state.sql, kbId, user.id, "fact.confirm", "fact", factId, snap).catch(() => {});
    }
    state.emitReview(kbId);
    return c.json({ ok: true });
  });

  api.post("/kbs/:id/facts/:fact_id/reject", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    const factId = uuidParam(c, "fact_id");
    await store.access.requireKb(state.sql, user, kbId, "editor");
    const snap = await factSnapshot(state, kbId, factId);
    await store.graph.reject_fact(state.sql, kbId, factId);
    if (snap) {
      await store.audit.record(state.sql, kbId, user.id, "fact.reject", "fact", factId, snap).catch(() => {});
    }
    state.emitReview(kbId);
    return c.json({ ok: true });
  });

  api.post("/kbs/:id/merges/:merge_id/revert", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    const mergeId = uuidParam(c, "merge_id");
    await store.access.requireKb(state.sql, user, kbId, "editor");
    const snap = await qOpt<{ source: string; target: string }>(
      state.sql,
      `SELECT s.canonical_name AS source, t.canonical_name AS target
       FROM entity_merges m JOIN entities s ON s.id = m.source_id JOIN entities t ON t.id = m.target_id
       WHERE m.id = $1 AND m.kb_id = $2`,
      [mergeId, kbId],
    ).catch(() => null);
    await store.resolution.revert_merge(state.sql, kbId, mergeId);
    if (snap) {
      await store.audit
        .record(state.sql, kbId, user.id, "merge.revert", "merge", mergeId, { source: snap.source, target: snap.target })
        .catch(() => {});
    }
    state.emitReview(kbId);
    return c.json({ ok: true });
  });

  // Manual merge (the entity panel's "Merge into..." entry point).
  api.post("/kbs/:id/entities/merge", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    await store.access.requireKb(state.sql, user, kbId, "editor");
    const body = (await c.req.json()) as { source: Uuid; target: Uuid };
    const snap = await qOpt<{ source: string; target: string }>(
      state.sql,
      `SELECT s.canonical_name AS source, t.canonical_name AS target FROM entities s, entities t WHERE s.id = $1 AND t.id = $2`,
      [body.source, body.target],
    ).catch(() => null);
    const mergeId = await store.resolution.merge_entities(state.sql, kbId, body.source, body.target, user.id, "manual merge");
    if (snap) {
      await store.audit
        .record(state.sql, kbId, user.id, "merge.manual", "merge", mergeId, { source: snap.source, target: snap.target })
        .catch(() => {});
    }
    state.emitReview(kbId);
    return c.json({ merge_id: mergeId });
  });

  // The decision ledger: audit events in the review domain, paginated server-side.
  api.get("/kbs/:id/review/history", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    await store.access.requireKb(state.sql, user, kbId, "viewer");
    const per = clampLimit(queryInt(c, "per"), 20, 100);
    const page = clampOffset(queryInt(c, "page"));
    const [events, total] = await store.audit.reviewHistory(state.sql, kbId, per, page * per);
    return c.json({ events, total });
  });

  // A verdict on one semantic-layer mapping.
  //
  // **Status changes, the row is never deleted**: confirming happened,
  // rejecting happened too. Keeping the rejection is immediately useful:
  // the next exploration round would otherwise compute the same
  // rejected mapping again, and `propose`'s `WHERE status = 'proposed'`
  // relies on it staying rejected instead of resurfacing.
  api.post("/kbs/:id/review/mappings/:mapping_id", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    const mappingId = uuidParam(c, "mapping_id");
    await store.access.requireKb(state.sql, user, kbId, "editor");
    const body = (await c.req.json()) as { status: string };
    if (body.status !== "confirmed" && body.status !== "rejected") {
      throw AppError.invalid("bad_status", "status must be confirmed or rejected");
    }
    await store.mappings.decide(state.sql, kbId, mappingId, body.status, user.id);
    await store.audit
      .record(state.sql, kbId, user.id, "mapping.decided", "concept_mapping", mappingId, { status: body.status })
      .catch(() => {});
    state.emitReview(kbId);
    return c.json({ ok: true });
  });

  // A human decides one axiom violation.
  //
  // **Three outcomes, not two.** `axiom_relaxed` is unique to this
  // queue: the contradiction may be in the definition, not the data —
  // the user's imported ontology declared a property asymmetric, and
  // their own corpus actually uses that relation both ways. There, the
  // fix is the ontology, not twenty facts.
  //
  // The endpoint only records the decision, it does not carry it out:
  // retracting a fact goes through `reject_fact`, changing an axiom
  // through the Ontology page — each of those has its own permission
  // and ledger entry; folding them in here would make this one endpoint
  // able to do anything.
  api.post("/kbs/:id/review/violations/:violation_id", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    const violationId = uuidParam(c, "violation_id");
    await store.access.requireKb(state.sql, user, kbId, "editor");
    const body = (await c.req.json()) as { resolution: string };
    if (!["fact_retracted", "axiom_relaxed", "accepted"].includes(body.resolution)) {
      throw AppError.invalid("bad_resolution", "resolution must be fact_retracted, axiom_relaxed, or accepted");
    }
    await store.reasoning.decide(state.sql, kbId, violationId, body.resolution, user.id);
    await store.audit
      .record(state.sql, kbId, user.id, "violation.decided", "axiom_violation", violationId, { resolution: body.resolution })
      .catch(() => {});
    state.emitReview(kbId);
    return c.json({ ok: true });
  });

  // A human decides one ontology defect.
  //
  // **Two outcomes, not three**: an ontology defect never looked at the
  // data at all, so there is no "the data is wrong" option here.
  api.post("/kbs/:id/review/defects/:defect_id", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    const defectId = uuidParam(c, "defect_id");
    await store.access.requireKb(state.sql, user, kbId, "editor");
    const body = (await c.req.json()) as { resolution: string };
    if (body.resolution !== "fixed" && body.resolution !== "accepted") {
      throw AppError.invalid("bad_resolution", "resolution must be fixed or accepted");
    }
    await store.reasoning.decideDefect(state.sql, kbId, defectId, body.resolution, user.id);
    await store.audit
      .record(state.sql, kbId, user.id, "defect.decided", "ontology_defect", defectId, { resolution: body.resolution })
      .catch(() => {});
    state.emitReview(kbId);
    return c.json({ ok: true });
  });

  // Manually runs a consistency check.
  //
  // **Synchronous, not queued as a job**: this is pure computation, no
  // model call and no network — even a KB with tens of thousands of
  // facts finishes in milliseconds. Queuing it would only leave someone
  // staring at a "queued" state after clicking a button that never
  // needed one.
  //
  // `predicates_with_axioms` is returned too: **zero and zero mean
  // different things.** With no axioms declared, the right conclusion is
  // "there is no criterion" and the UI should say "import an ontology
  // with axioms first" — not "no contradictions found".
  api.post("/kbs/:id/consistency/check", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    await store.access.requireKb(state.sql, user, kbId, "editor");
    const report = await store.reasoning.run(state.sql, kbId);
    // Ontology self-consistency is computed in the same pass. Both share
    // the same criterion (the axioms the ontology itself declares), so
    // two separate buttons would only mean two clicks.
    const onto = await store.reasoning.checkOntologyRun(state.sql, kbId);
    await store.audit
      .record(state.sql, kbId, user.id, "consistency.checked", "knowledge_base", kbId, {
        edges: report.edges,
        predicates_with_axioms: report.predicates_with_axioms,
        found: report.found,
        inserted: report.inserted,
        cleared: report.cleared,
        defects_found: onto.found,
      })
      .catch(() => {});
    state.emitReview(kbId);
    return c.json({
      edges: report.edges,
      predicates_with_axioms: report.predicates_with_axioms,
      found: report.found,
      inserted: report.inserted,
      cleared: report.cleared,
      // The ontology's own tier is returned separately. **Not folded
      // into `found`**: the two are not the same kind of thing, and
      // adding them would make "3 contradictions" mean either three
      // facts clashing or three places where the ontology itself
      // contradicts itself.
      classes: onto.classes,
      defects_found: onto.found,
      defects_new: onto.inserted,
    });
  });

  // Runs inference (R1).
  //
  // **Gated by the `materialize_inferences` switch.** Off by default,
  // because this step adds things to the graph, and decision 0001's
  // criterion 2 says the ontology guides, it does not enforce — a
  // declaration may be wrong, and should not change the graph before the
  // user has said so. When the switch is off this does not silently
  // no-op: it returns a clear error, so the UI can say why nothing happened.
  //
  // Synchronous, same reason as the consistency check: pure computation,
  // no model call and no network.
  api.post("/kbs/:id/inference/run", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    await store.access.requireKb(state.sql, user, kbId, "editor");
    const kb = await store.kbs.get(state.sql, kbId);
    if (!kb.materialize_inferences) {
      throw AppError.invalid("inference_off", "materialized inference is off for this knowledge base");
    }
    const report = await store.reasoning.materialize(state.sql, kbId);
    await store.audit
      .record(state.sql, kbId, user.id, "inference.materialized", "knowledge_base", kbId, {
        rules: report.rules,
        edges: report.edges,
        derived: report.derived,
        inserted: report.inserted,
        invalidated: report.invalidated,
        capped: report.capped,
      })
      .catch(() => {});
    state.emitGraph(kbId);
    return c.json({
      rules: report.rules,
      edges: report.edges,
      derived: report.derived,
      inserted: report.inserted,
      invalidated: report.invalidated,
      capped: report.capped,
    });
  });
}

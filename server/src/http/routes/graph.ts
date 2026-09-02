/**
 * Entity graph API: overview, neighborhood, search, entity detail and
 * edits, fact evidence, and the two "start over" actions (manual
 * re-extract, full rebuild).
 */

import type { Hono } from "hono";
import type { AppState } from "../../state";
import * as store from "../../store";
import * as auth from "../../auth";
import { AppError } from "../../core/errors";
import { uuidParam, queryStr, queryInt, clampLimit, clampOffset } from "../context";

/** `at`: an optional as-of date (YYYY-MM-DD or RFC3339) — server-side time travel. */
function parseAt(raw: string | undefined): Date | null {
  const s = raw?.trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T00:00:00Z`);
    if (!Number.isNaN(d.getTime())) return d;
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw AppError.validation("Invalid `at` (expected YYYY-MM-DD or RFC3339)");
  }
  return d;
}

/** The **default** number of nodes an overview draws. The cap itself is reasonable — nobody can read ten thousand dots — but treating it as the KB's size would lie, so the endpoint also returns the true total. */
const GRAPH_NODE_CAP = 150;
/** Even a raised request has a ceiling. **Not an arbitrary number**: nodes are taken in descending degree order, so the tail is all fringe nodes, and force layout is roughly O(n^2) — past this point "draggable" breaks before "readable" does. Viewing tens of thousands of nodes wants a different view, not a bigger version of this one. */
const GRAPH_NODE_CAP_MAX = 1000;

export function registerGraphRoutes(api: Hono, state: AppState): void {
  api.get("/kbs/:id/graph/overview", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    await store.access.requireKb(state.sql, user, kbId, "viewer");
    const at = parseAt(queryStr(c, "at"));
    // How many to draw is rendering's business; how many the KB actually
    // has is the KB's business — returning both lets the UI say "drew
    // 150 of 325" instead of presenting the cap as the size.
    const limit = clampLimit(queryInt(c, "limit"), GRAPH_NODE_CAP, GRAPH_NODE_CAP_MAX);
    const [nodes, edges, total_nodes, total_edges] = await store.graph.overview(state.sql, kbId, limit, at);
    return c.json({ nodes, edges, total_nodes, total_edges });
  });

  api.get("/kbs/:id/graph/neighborhood", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    await store.access.requireKb(state.sql, user, kbId, "viewer");
    const entity = queryStr(c, "entity");
    if (!entity) throw AppError.validation("'entity' is required");
    const at = parseAt(queryStr(c, "at"));
    const hops = queryInt(c, "hops") ?? 2;
    const [nodes, edges] = await store.graph.neighborhood(state.sql, kbId, entity, hops, at);
    return c.json({ nodes, edges });
  });

  api.get("/kbs/:id/entities", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    await store.access.requireKb(state.sql, user, kbId, "viewer");
    const query = queryStr(c, "q")?.trim() ?? "";
    if (!query) return c.json({ entities: [], total: 0 });
    // The total comes back too: "split rather than merge" naturally
    // produces a pile of same-named entities, so with a fixed ten
    // results the one being searched for may not even be among them,
    // and the UI would have no way to tell.
    const limit = clampLimit(queryInt(c, "limit"), 10, 100);
    const offset = clampOffset(queryInt(c, "offset"));
    const [entities, total] = await store.graph.search_entities(state.sql, kbId, query, limit, offset);
    return c.json({ entities, total });
  });

  api.get("/kbs/:id/entities/:entity_id", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    const entityId = uuidParam(c, "entity_id");
    await store.access.requireKb(state.sql, user, kbId, "viewer");
    const [entity, facts] = await store.graph.entity_detail(state.sql, kbId, entityId);
    // The inferred ones get **their own key**, never mixed into `facts`.
    // The frontend gives them their own tier from this: a derived edge
    // sitting in the same list as an asserted one would leave the user
    // unable to tell "written in a document" apart from "the engine
    // inferred it" — and that is exactly what a reasoner polluting
    // knowledge would look like.
    const derived = await store.reasoning.derivedForEntity(state.sql, kbId, entityId);
    // Same-named peers are returned **when the panel opens**, not only
    // after a rename. It used to only come back from `update_entity`'s
    // response, so "merge the same-named one in" was only reachable
    // after renaming once — but two "Zhang Wei"s coexisting is the
    // legitimate product of "split rather than merge", not something a
    // rename produced. The merge entry point belongs wherever same-named
    // peers are visible.
    const same_name = await store.graph.same_name_peers(state.sql, kbId, entityId);
    return c.json({ entity, facts, derived, same_name });
  });

  // Manually fixes an entity's type or name. Extraction gives a first
  // guess, and before this endpoint the only fix for a wrong guess was
  // re-extracting the whole KB.
  //
  // A rename colliding with a same-named entity is not blocked (two
  // "Zhang Wei"s are the legitimate product of "split rather than
  // merge"); after the rename, same-named peers are reported back, and
  // the UI prompts whether to merge — judging whether they are really
  // the same one is a person's call.
  api.patch("/kbs/:id/entities/:entity_id", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    const entityId = uuidParam(c, "entity_id");
    await store.access.requireKb(state.sql, user, kbId, "editor");
    const req = (await c.req.json()) as { type_id?: string | null; canonical_name?: string | null };
    if (req.type_id === undefined && req.canonical_name === undefined) {
      throw AppError.invalid("nothing_to_update", "Nothing to update");
    }
    const [before, after] = await store.graph.update_entity(
      state.sql,
      kbId,
      entityId,
      req.type_id ?? null,
      req.canonical_name ?? null,
    );

    // The ledger snapshot is self-contained: even if the type is later
    // deleted, this record still reads fine. P4 wants to aggregate "37
    // entities moved from Product to Concept this month" by from/to, so
    // the two actions are recorded separately.
    if (before.type_key !== after.type_key) {
      await store.audit
        .record(state.sql, kbId, user.id, "entity.retyped", "entity", entityId, {
          name: after.name,
          from: { key: before.type_key, label: before.type_label },
          to: { key: after.type_key, label: after.type_label },
        })
        .catch(() => {});
    }
    if (before.name !== after.name) {
      await store.audit
        .record(state.sql, kbId, user.id, "entity.renamed", "entity", entityId, {
          from: before.name,
          to: after.name,
          type: after.type_label,
        })
        .catch(() => {});
    }

    const peers = await store.graph.same_name_peers(state.sql, kbId, entityId);
    state.emitReview(kbId);
    return c.json({ entity: after, same_name: peers });
  });

  api.get("/kbs/:id/entities/:entity_id/history", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    const entityId = uuidParam(c, "entity_id");
    await store.access.requireKb(state.sql, user, kbId, "viewer");
    const per = clampLimit(queryInt(c, "per"), 30, 200);
    const page = clampOffset(queryInt(c, "page"));
    const [events, total] = await store.graph.entity_history(state.sql, kbId, entityId, per, page * per);
    return c.json({ events, total });
  });

  api.get("/kbs/:id/facts/:fact_id/evidence", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    const factId = uuidParam(c, "fact_id");
    await store.access.requireKb(state.sql, user, kbId, "viewer");
    const evidence = await store.graph.fact_evidence(state.sql, factId);
    return c.json({ evidence });
  });

  // Manually triggers extraction (retry a failed document / re-extract after configuring a model).
  api.post("/documents/:id/extract", async (c) => {
    const user = await auth.requireUser(c, state);
    const documentId = uuidParam(c, "id");
    const doc = await store.documents.get(state.sql, documentId);
    await store.access.requireKb(state.sql, user, doc.kb_id, "editor");
    // A manual trigger means a full force-run: clear the incremental
    // flag, dismiss any job in flight, mark queued, and create the job,
    // all in one transaction.
    const jobId = await store.documents.queueExtractionOne(state.sql, documentId);
    state.emitDocument(doc.kb_id, documentId);
    return c.json({ job_id: jobId });
  });

  // Graph rebuild (a clean-slate operation, KB admin): wipes the whole
  // graph layer, then re-extracts everything.
  //
  // How this differs from a source-scoped re-extract: re-extract keeps
  // every existing decision; rebuild discards them, in exchange for a
  // deterministic replay of "current corpus x current ontology" (a
  // last-resort move after early dirty extractions or a major ontology
  // overhaul). The decision ledger and adjudication cache are kept on
  // purpose (see `store::graph::purge_graph`).
  api.post("/kbs/:id/graph/rebuild", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    await store.access.requireKb(state.sql, user, kbId, "admin");
    const [entitiesRemoved, factsRemoved] = await store.graph.purge_graph(state.sql, kbId);
    // The jobs are created by `queue_extraction` in the same transaction
    // as the status change; this only pushes the events.
    const ids = await store.documents.queueExtraction(state.sql, kbId, null);
    for (const id of ids) state.emitDocument(kbId, id);
    state.emitReview(kbId);
    await store.audit
      .record(state.sql, kbId, user.id, "graph.rebuild", "kb", kbId, {
        entities_removed: entitiesRemoved,
        facts_removed: factsRemoved,
        documents: ids.length,
      })
      .catch(() => {});
    return c.json({ entities_removed: entitiesRemoved, facts_removed: factsRemoved, queued: ids.length });
  });
}

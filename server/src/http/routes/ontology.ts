/**
 * Ontology editor API: type/relation CRUD, unmatched-wording stats, and
 * LLM-assisted extension proposals.
 *
 * Viewing needs `viewer`. Changing needs `editor` — the ontology directly
 * gates what later extraction runs are allowed to say.
 */

import type { Hono } from "hono";
import type { AppState } from "../../state";
import * as store from "../../store";
import * as auth from "../../auth";
import { AppError } from "../../core/errors";
import type { Uuid } from "../../core/ids";
import { uuidParam, queryInt } from "../context";
import { buildProposals, adoptAttributeCore, type AttributeAdoption } from "../../ontology_engine";
import * as owlImport from "../../owl_import";
import * as typeResolution from "../../type_resolution";

const MAX_ONTOLOGY_BYTES = 8 * 1024 * 1024;

/** Reads the first file out of a multipart body. 8 MB cap: FOAF is 44 KB, DCTerms is 48 KB, and even a modular FIBO part sits in the low hundreds of KB — bigger than that is usually the wrong file. */
async function readUpload(c: import("hono").Context): Promise<{ filename: string; bytes: Uint8Array }> {
  let body: Record<string, unknown>;
  try {
    body = await c.req.parseBody();
  } catch (e) {
    throw AppError.invalid("bad_upload", "Could not read the upload", String(e));
  }
  const field = body.file;
  if (!(field instanceof File)) {
    throw AppError.invalid("no_files", "No file in the upload");
  }
  const bytes = new Uint8Array(await field.arrayBuffer());
  if (bytes.byteLength === 0) throw AppError.invalid("empty_file", "Ontology file is empty");
  if (bytes.byteLength > MAX_ONTOLOGY_BYTES) {
    throw AppError.invalid("file_too_large", "Ontology file is too large (max 8 MB)");
  }
  return { filename: field.name, bytes };
}

type ProposalDoc = { entity_types: unknown[]; relation_types: unknown[]; attribute_types: unknown[]; map_to: unknown[] };

/**
 * Each section's rows get stored one line at a time. Failure does not
 * block the response: the proposals are already computed, and failing to
 * save them only means recomputing next time — treating the whole request
 * as failed would also throw away the part that did work.
 */
async function persistProposals(state: AppState, kbId: Uuid, proposals: ProposalDoc): Promise<void> {
  const sections = ["entity_types", "relation_types", "attribute_types", "map_to"] as const;
  const rows: [string, string, unknown][] = [];
  for (const section of sections) {
    const items = proposals[section];
    if (!Array.isArray(items)) continue;
    for (const it of items) {
      const key = (it as Record<string, unknown>)?.key;
      if (typeof key !== "string") continue;
      rows.push([section, key, it]);
    }
  }
  try {
    await store.ontology.save_proposals(state.sql, kbId, rows);
  } catch (e) {
    console.warn(`ontology proposals for kb ${kbId} failed to persist, this batch only lives in the response: ${String(e)}`);
  }
}

export function registerOntologyRoutes(api: Hono, state: AppState): void {
  api.get("/kbs/:id/ontology", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    await store.access.requireKb(state.sql, user, kbId, "viewer");
    const entity_types = await store.ontology.entity_type_views(state.sql, kbId);
    const relation_types = await store.ontology.relation_type_views(state.sql, kbId);
    const misses = await store.ontology.list_misses(state.sql, kbId);
    const dismissed_misses = await store.ontology.list_dismissed_misses(state.sql, kbId);
    return c.json({ entity_types, relation_types, misses, dismissed_misses });
  });

  api.get("/kbs/:id/ontology/entity-types/:type_id/entities", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    const typeId = uuidParam(c, "type_id");
    await store.access.requireKb(state.sql, user, kbId, "viewer");
    const per = Math.max(1, Math.min(100, queryInt(c, "per") ?? 12));
    const page = Math.max(0, queryInt(c, "page") ?? 0);
    const [entities, total] = await store.ontology.entity_instances(state.sql, kbId, typeId, per, page * per);
    return c.json({ entities, total });
  });

  api.post("/kbs/:id/ontology/entity-types", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    await store.access.requireKb(state.sql, user, kbId, "editor");
    const req = (await c.req.json()) as {
      key?: string;
      label: string;
      color?: string;
      shape?: string;
      parents?: Uuid[];
      disjoint?: Uuid[];
      description?: string;
    };
    const key = req.key?.trim();
    if (!key) throw AppError.invalid("key_required", "key is required");
    const id = await store.ontology.create_entity_type(
      state.sql,
      kbId,
      key,
      req.label.trim(),
      req.color?.trim() || store.palette.colorForKey(key),
      req.shape?.trim() || "circle",
      req.parents ?? [],
      req.description?.trim() ?? "",
    );
    if (req.disjoint !== undefined) {
      await store.ontology.set_disjoint_for(state.sql, kbId, id, req.disjoint);
    }
    await store.audit
      .record(state.sql, kbId, user.id, "entity_type.created", "entity_type", id, {
        key,
        label: req.label.trim(),
      })
      .catch(() => {});
    return c.json({ id });
  });

  api.patch("/kbs/:id/ontology/entity-types/:type_id", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    const id = uuidParam(c, "type_id");
    await store.access.requireKb(state.sql, user, kbId, "editor");
    const req = (await c.req.json()) as {
      label: string;
      color?: string;
      shape?: string;
      parents?: Uuid[];
      disjoint?: Uuid[];
      description?: string;
    };
    await store.ontology.update_entity_type(
      state.sql,
      kbId,
      id,
      req.label.trim(),
      req.color ?? null,
      req.shape?.trim() || "circle",
      req.parents ?? [],
      req.description?.trim() ?? "",
    );
    if (req.disjoint !== undefined) {
      await store.ontology.set_disjoint_for(state.sql, kbId, id, req.disjoint);
    }
    await store.audit
      .record(state.sql, kbId, user.id, "entity_type.updated", "entity_type", id, {
        label: req.label.trim(),
        color: req.color ?? null,
        shape: req.shape ?? null,
        description: req.description ?? null,
      })
      .catch(() => {});
    return c.json({ ok: true });
  });

  api.delete("/kbs/:id/ontology/entity-types/:type_id", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    const id = uuidParam(c, "type_id");
    await store.access.requireKb(state.sql, user, kbId, "editor");
    await store.ontology.delete_entity_type(state.sql, kbId, id);
    await store.audit.record(state.sql, kbId, user.id, "entity_type.deleted", "entity_type", id, {}).catch(() => {});
    return c.json({ ok: true });
  });

  api.post("/kbs/:id/ontology/relation-types", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    await store.access.requireKb(state.sql, user, kbId, "editor");
    const req = await parseRelationTypeReq(c);
    const key = req.key?.trim();
    if (!key) throw AppError.invalid("key_required", "key is required");
    const kind = req.kind ?? "relation";
    const id = await store.ontology.create_relation_type(
      state.sql,
      kbId,
      key,
      req.label.trim(),
      req.temporal,
      req.axioms,
      req.description?.trim() ?? "",
      kind,
      req.domains ?? [],
      req.ranges ?? [],
      req.datatype ?? null,
      req.unit?.trim() || null,
    );
    await store.audit
      .record(state.sql, kbId, user.id, "relation_type.created", "relation_type", id, {
        key,
        label: req.label.trim(),
        temporal: req.temporal,
        kind,
      })
      .catch(() => {});
    return c.json({ id });
  });

  api.patch("/kbs/:id/ontology/relation-types/:type_id", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    const id = uuidParam(c, "type_id");
    await store.access.requireKb(state.sql, user, kbId, "editor");
    const req = await parseRelationTypeReq(c);
    await store.ontology.update_relation_type(
      state.sql,
      kbId,
      id,
      req.label.trim(),
      req.temporal,
      req.axioms,
      req.description?.trim() ?? "",
      req.datatype ?? null,
      req.unit?.trim() || null,
      req.domains ?? null,
      req.ranges ?? null,
    );
    await store.audit
      .record(state.sql, kbId, user.id, "relation_type.updated", "relation_type", id, {
        label: req.label.trim(),
        temporal: req.temporal,
        functional: req.axioms.functional,
        inverse_functional: req.axioms.inverse_functional,
        description: req.description ?? null,
      })
      .catch(() => {});
    return c.json({ ok: true });
  });

  api.delete("/kbs/:id/ontology/relation-types/:type_id", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    const id = uuidParam(c, "type_id");
    await store.access.requireKb(state.sql, user, kbId, "editor");
    await store.ontology.delete_relation_type(state.sql, kbId, id);
    await store.audit.record(state.sql, kbId, user.id, "relation_type.deleted", "relation_type", id, {}).catch(() => {});
    return c.json({ ok: true });
  });

  api.post("/kbs/:id/ontology/misses/dismiss", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    await store.access.requireKb(state.sql, user, kbId, "editor");
    const req = (await c.req.json()) as { kind: string; key: string };
    await store.ontology.dismiss_miss(state.sql, kbId, req.kind, req.key);
    return c.json({ ok: true });
  });

  api.post("/kbs/:id/ontology/misses/restore", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    await store.access.requireKb(state.sql, user, kbId, "editor");
    const req = (await c.req.json()) as { kind: string; key: string };
    await store.ontology.restore_miss(state.sql, kbId, req.kind, req.key);
    return c.json({ ok: true });
  });

  // LLM-assisted extension suggestion: existing ontology + unmatched
  // stats -> proposals (a person reviews, then adopts through the create
  // endpoints). `locale` is stated by the CALLER, not the server's
  // setting: reason is only for a person to read, and that person is on
  // the other end of this same request.
  api.post("/kbs/:id/ontology/suggest", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    await store.access.requireKb(state.sql, user, kbId, "editor");
    let locale = "en";
    try {
      const body = (await c.req.json()) as { locale?: string };
      if (body.locale === "en" || body.locale === "zh") locale = body.locale;
    } catch {
      // No body: default to English.
    }
    // Manual path uses min_docs = 0: the "seen in 1 document" number is
    // shown to the person, who can judge it themselves. Filtering it out
    // for them would only remove information.
    const proposals = (await buildProposals(state, kbId, locale, 0)) as unknown as ProposalDoc;
    // Written down once computed (see `ontology_proposals`). This used to
    // only go back to the frontend and live in a useState, gone on
    // refresh — and recomputing calls the model again, with no guarantee
    // of the same grouping.
    await persistProposals(state, kbId, proposals);
    return c.json(proposals);
  });

  // The proposals still awaiting a verdict, shaped exactly like the
  // interface expects — the frontend does not need to tell "just
  // computed" apart from "stored last time".
  api.get("/kbs/:id/ontology/proposals", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    await store.access.requireKb(state.sql, user, kbId, "viewer");
    const stored = await store.ontology.open_proposals(state.sql, kbId);
    const out: ProposalDoc = { entity_types: [], relation_types: [], attribute_types: [], map_to: [] };
    for (const p of stored) {
      const bucket = out[p.section as keyof ProposalDoc];
      if (Array.isArray(bucket)) bucket.push(p.payload);
    }
    return c.json(out);
  });

  // A verdict on one proposal. Status changes, the row is never deleted:
  // adoption happened, rejection happened too, and a rejection's trace is
  // exactly what keeps the next Suggest from surfacing it again.
  api.post("/kbs/:id/ontology/proposals", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    await store.access.requireKb(state.sql, user, kbId, "editor");
    const req = (await c.req.json()) as { section: string; key: string; status: string };
    if (req.status !== "adopted" && req.status !== "rejected") {
      throw AppError.invalid("bad_status", "status must be adopted or rejected");
    }
    await store.ontology.decide_proposal(state.sql, kbId, req.section, req.key, req.status, user.id);
    return c.json({ ok: true });
  });

  // Adopts a surface predicate: builds the relation type **and rewrites
  // the related_to facts waiting on it**. The rewrite is what makes this
  // different from a plain create — building the type alone leaves the
  // graph no better off, the fact still just says "related to".
  api.post("/kbs/:id/ontology/adopt-predicate", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    await store.access.requireKb(state.sql, user, kbId, "editor");
    const req = (await c.req.json()) as {
      key: string;
      existing?: boolean;
      label?: string;
      description?: string;
      temporal?: string;
      functional?: boolean;
      inverse_functional?: boolean;
      forms: string[];
      kind?: string;
      datatype?: string;
      unit?: string;
    };
    const key = req.key.trim();
    if (!req.forms || req.forms.length === 0) {
      throw AppError.invalid("forms_required", "forms cannot be empty");
    }
    if (req.kind === "attribute") {
      const spec: AttributeAdoption = {
        key,
        label: req.label?.trim() ?? "",
        description: req.description?.trim() ?? "",
        datatype: req.datatype ?? "text",
        unit: req.unit?.trim() || null,
        forms: req.forms,
        existing: req.existing ?? false,
      };
      const done = await adoptAttributeCore(state, kbId, spec);
      await store.audit
        .record(state.sql, kbId, user.id, "ontology.attribute_adopted", "relation_type", done.attribute_id, {
          key: spec.key,
          forms: req.forms,
          existing: spec.existing,
          remapped: done.remapped,
          unconvertible: done.unconvertible,
        })
        .catch(() => {});
      return c.json({
        id: done.attribute_id,
        batch: done.batch_id,
        remapped: done.remapped,
        unconvertible: done.unconvertible,
      });
    }

    let predicateId: Uuid;
    if (req.existing) {
      const found = await store.ontology.relation_type_id_by_key(state.sql, kbId, key);
      if (!found) throw AppError.invalid("unknown_relation_key", "no relation type with that key");
      predicateId = found;
    } else {
      predicateId = await store.ontology.create_relation_type(
        state.sql,
        kbId,
        key,
        req.label?.trim() ?? key,
        req.temporal ?? "state",
        {
          functional: req.functional ?? false,
          inverse_functional: req.inverse_functional ?? false,
          transitive: false,
          symmetric: false,
          asymmetric: false,
          irreflexive: false,
          inverse_of: null,
          sub_property_of: null,
        },
        req.description?.trim() ?? "",
        "relation",
        [],
        [],
        null,
        null,
      );
    }
    const [batchId, remapped] = await store.graph.adopt_proposed_predicates(state.sql, kbId, predicateId, req.forms, false);
    for (const form of req.forms) {
      await store.ontology.clear_miss(state.sql, kbId, "relation_type", form).catch(() => {});
    }
    await store.audit
      .record(state.sql, kbId, user.id, "ontology.predicate_adopted", "relation_type", predicateId, {
        key,
        label: req.label,
        forms: req.forms,
        facts_remapped: remapped,
        batch: batchId,
      })
      .catch(() => {});
    state.emitReview(kbId);
    return c.json({ id: predicateId, remapped, batch: batchId });
  });

  // Reverts one adoption: the newly written rows are voided, the old ones
  // come back. The relation type stays (facts once pointed at it, and an
  // unused relation is inert).
  api.delete("/kbs/:id/ontology/adopt-predicate/:batch_id", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    const batchId = uuidParam(c, "batch_id");
    await store.access.requireKb(state.sql, user, kbId, "editor");
    const predicateId = await store.graph.predicateForBatch(state.sql, kbId, batchId);
    if (predicateId === null) {
      // A single adoption pass may have produced both a fact-rewrite
      // batch and an entity-retype batch, and the caller gets back an
      // undifferentiated string of batch ids — try both, whichever
      // claims it wins.
      const n = await store.resolution.unadopt_types(state.sql, kbId, batchId);
      await store.audit
        .record(state.sql, kbId, user.id, "ontology.adoption_reverted", "kb", kbId, {
          batch: batchId,
          entities_reverted: n,
        })
        .catch(() => {});
      state.emitReview(kbId);
      return c.json({ reverted: n });
    }
    const reverted = await store.graph.unadopt(state.sql, kbId, batchId);
    await store.audit
      .record(state.sql, kbId, user.id, "ontology.adoption_reverted", "relation_type", predicateId, {
        batch: batchId,
        facts_reverted: reverted,
      })
      .catch(() => {});
    state.emitReview(kbId);
    return c.json({ reverted });
  });

  // The surface predicates awaiting a claim: said in the source text, not
  // in the ontology, and its facts got demoted to related_to.
  api.get("/kbs/:id/ontology/proposed-predicates", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    await store.access.requireKb(state.sql, user, kbId, "viewer");
    const forms = await store.graph.proposed_predicates(state.sql, kbId);
    return c.json({ forms });
  });

  // What the last automatic extension run did, and whether it can still
  // be undone.
  api.get("/kbs/:id/ontology/auto-extension", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    await store.access.requireKb(state.sql, user, kbId, "viewer");
    const row = await store.audit.lastBootstrapRun(state.sql, kbId);
    if (!row) return c.json({ run: null });
    const { detail, at } = row;
    const batches = Array.isArray(detail.batches) ? (detail.batches as Uuid[]) : [];
    const live = batches.length > 0 ? await store.graph.liveAdoptionCount(state.sql, kbId, batches) : 0;
    if (live === 0) return c.json({ run: null });
    return c.json({
      run: {
        at,
        relations: detail.relations ?? null,
        classes: detail.classes ?? null,
        facts_remapped: detail.facts_remapped ?? null,
        batches,
      },
    });
  });

  // OWL import: look first, write only once confirmed.
  //
  // **An upload must never irreversibly change the ontology on its own.**
  // Preview and apply run the exact same plan; two independently written
  // paths would eventually diverge, and the divergence surfaces after
  // confirmation as "this is not what I just looked at".
  api.post("/kbs/:id/ontology/imports/preview", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    await store.access.requireKb(state.sql, user, kbId, "editor");
    const { filename, bytes } = await readUpload(c);
    const [plan] = await owlImport.plan(state, kbId, filename, bytes);
    return c.json({ filename, plan });
  });

  api.post("/kbs/:id/ontology/imports", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    await store.access.requireKb(state.sql, user, kbId, "editor");
    const { filename, bytes } = await readUpload(c);
    const [importId, plan] = await owlImport.apply(state, kbId, user.id, filename, bytes);
    // Axioms just changed — this is the best moment to recheck
    // consistency, since what the user imported is the very thing the
    // checks judge against. A failure here does not undo the import: the
    // ontology is already saved, the check simply did not run this time,
    // and the Review page button can run it again.
    let violations = 0;
    try {
      const report = await store.reasoning.run(state.sql, kbId);
      violations = report.found;
    } catch (e) {
      console.warn(`consistency check after import did not run: ${String(e)}`);
    }
    state.emitReview(kbId);
    return c.json({ import_id: importId, plan, violations });
  });

  api.get("/kbs/:id/ontology/imports", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    await store.access.requireKb(state.sql, user, kbId, "viewer");
    const imports = await store.ontology.list_imports(state.sql, kbId);
    return c.json({ imports });
  });

  // Type resolution's compute-only step: each entity awaiting refinement,
  // with its profile and candidate classes.
  api.post("/kbs/:id/ontology/type-resolution/preview", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    await store.access.requireKb(state.sql, user, kbId, "editor");
    const items = await typeResolution.preview(state, kbId);
    return c.json({ items });
  });

  api.post("/kbs/:id/ontology/type-resolution", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    await store.access.requireKb(state.sql, user, kbId, "editor");
    const outcome = await typeResolution.resolve(state, kbId);
    await store.audit
      .record(state.sql, kbId, user.id, "ontology.types_resolved", "knowledge_base", kbId, {
        retyped: outcome.retyped,
        for_review: outcome.for_review.length,
        left_alone: outcome.left_alone.length,
        batch: outcome.batch,
      })
      .catch(() => {});
    return c.json(outcome);
  });

  api.delete("/kbs/:id/ontology/type-resolution/:batch_id", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    const batchId = uuidParam(c, "batch_id");
    await store.access.requireKb(state.sql, user, kbId, "editor");
    const reverted = await store.resolution.unadopt_types(state.sql, kbId, batchId);
    await store.audit
      .record(state.sql, kbId, user.id, "ontology.types_resolution_reverted", "knowledge_base", kbId, {
        batch: batchId,
        reverted,
      })
      .catch(() => {});
    return c.json({ reverted });
  });

  // Approves one "coarse -> specific" class pair, and moves along any
  // entities the request carried. Approval is on the class pair, the
  // change is to the entities — kept separate, so a caller can approve
  // the rule alone without touching any entity yet.
  api.post("/kbs/:id/ontology/type-resolution/approve", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    await store.access.requireKb(state.sql, user, kbId, "editor");
    const req = (await c.req.json()) as { from_type_id: Uuid; to_type_id: Uuid; entity_ids?: Uuid[] };
    await store.resolution.approve_refinement(state.sql, kbId, req.from_type_id, req.to_type_id, user.id);
    const entityIds = req.entity_ids ?? [];
    const picks: [Uuid, Uuid][] = entityIds.map((id) => [id, req.to_type_id]);
    let batch: Uuid | null = null;
    let moved = 0;
    if (picks.length > 0) {
      const [b, n] = await store.resolution.retype_entities(state.sql, kbId, picks, user.id);
      batch = b;
      moved = n;
    }
    await store.audit
      .record(state.sql, kbId, user.id, "ontology.refinement_approved", "entity_type", req.to_type_id, {
        from: req.from_type_id,
        to: req.to_type_id,
        moved,
      })
      .catch(() => {});
    return c.json({ moved, batch });
  });
}

type RelationTypeReq = {
  key?: string;
  label: string;
  temporal: string;
  axioms: {
    functional: boolean;
    inverse_functional: boolean;
    transitive: boolean;
    symmetric: boolean;
    asymmetric: boolean;
    irreflexive: boolean;
    inverse_of: Uuid | null;
    sub_property_of: Uuid | null;
  };
  description?: string;
  kind?: string;
  domains?: Uuid[];
  ranges?: Uuid[];
  datatype?: string;
  unit?: string;
};

async function parseRelationTypeReq(c: import("hono").Context): Promise<RelationTypeReq> {
  const body = (await c.req.json()) as Record<string, unknown>;
  return {
    key: typeof body.key === "string" ? body.key : undefined,
    label: String(body.label ?? ""),
    temporal: typeof body.temporal === "string" ? body.temporal : "state",
    axioms: {
      functional: Boolean(body.functional),
      inverse_functional: Boolean(body.inverse_functional),
      transitive: Boolean(body.is_transitive),
      symmetric: Boolean(body.is_symmetric),
      asymmetric: Boolean(body.is_asymmetric),
      irreflexive: Boolean(body.is_irreflexive),
      inverse_of: (body.inverse_of as Uuid | undefined) ?? null,
      sub_property_of: (body.sub_property_of as Uuid | undefined) ?? null,
    },
    description: typeof body.description === "string" ? body.description : undefined,
    kind: typeof body.kind === "string" ? body.kind : undefined,
    domains: Array.isArray(body.domains) ? (body.domains as Uuid[]) : undefined,
    ranges: Array.isArray(body.ranges) ? (body.ranges as Uuid[]) : undefined,
    datatype: typeof body.datatype === "string" ? body.datatype : undefined,
    unit: typeof body.unit === "string" ? body.unit : undefined,
  };
}

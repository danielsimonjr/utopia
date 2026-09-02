/**
 * OWL import: keep the original file verbatim -> project -> preview ->
 * write.
 *
 * **Preview and write run the exact same plan.** Two independent code
 * paths eventually drift apart, and the cost of drifting is that what
 * happens after a user confirms differs from what they just previewed —
 * worse than no preview at all.
 *
 * Matched by IRI, not by key: upstream renaming `rdfs:label` once changes
 * the derived key, and matching by key would build the same class again as
 * a new one, leaving every existing entity orphaned (see decision 0001,
 * P2).
 */

import { createHash } from "node:crypto";
import type { AppState } from "./state";
import * as store from "./store";
import type { BulkRelation } from "./store/ontology";
import { ontologyRdf } from "./ingest";
import type { OwlProjection, OwlProperty, RdfFormat, VocabDatatypes } from "./ingest/ontology_rdf";
import * as packAlignment from "./pack_alignment";
import type { Uuid } from "./core/ids";
import { AppError } from "./core/errors";

/** Where a class/property in this import ends up. */
export type Disposition = "create" | "update" | "key_taken" | "aligned";

/** Whether an attribute will be built, and why. Preview must be able to say why: a bare "parsed 54 attributes" tells a reader nothing about whether that means "all get built" or "none do" — and in practice it was usually the latter. */
export type AttrNote =
  | { outcome: "datatype"; detail: "text" | "number" | "date" | "bool" }
  | { outcome: "no_range" }
  | { outcome: "degraded_to_text"; detail: string }
  | { outcome: "unusable_range"; detail: string }
  | { outcome: "no_domain" }
  | { outcome: "domain_skipped"; detail: string }
  | { outcome: "unknown_domain"; detail: string };

export type PlannedItem = {
  iri: string;
  key: string;
  label: string;
  has_description: boolean;
  disposition: Disposition;
  functional?: boolean;
  conflict_with?: string | null;
  attr?: AttrNote;
};

export type ImportPlan = {
  format: string;
  triples: number;
  classes: PlannedItem[];
  relations: PlannedItem[];
  attributes: PlannedItem[];
  /** A predicate seen but not consumed today -> how many times. Not "skipped": "not yet projected". */
  unprojected: [string, number][];
  classes_without_description: number;
  functional_relations: number;
};

/** An attribute's fate. **Domain is judged first**: an attribute with no domain cannot be built at all, and its range no longer matters. */
function attrNote(p: OwlProperty, vocab: VocabDatatypes, resolvable: Set<string>, inFile: Set<string>): AttrNote {
  if (p.domains.length === 0) {
    return { outcome: "no_domain" };
  }
  // Only a total miss counts as a failure: when some domains resolve and
  // some do not, the attribute is still built, just attached to fewer
  // classes — better than dropping the whole thing, and the skipped ones
  // are each reported separately in the plan as a key collision.
  if (!p.domains.some((d) => resolvable.has(d))) {
    const first = p.domains[0]!;
    return inFile.has(first) ? { outcome: "domain_skipped", detail: first } : { outcome: "unknown_domain", detail: first };
  }
  const mapping = ontologyRdf.mapRangeOf(p, vocab);
  switch (mapping.kind) {
    case "datatype":
      return { outcome: "datatype", detail: mapping.value };
    case "absent":
      return { outcome: "no_range" };
    case "degraded":
      return { outcome: "degraded_to_text", detail: mapping.value };
    case "unusable":
      return { outcome: "unusable_range", detail: mapping.value };
  }
}

/** Whether an attribute gets built, and with what datatype. Shared by write and by statistics, so "preview says it will build" and "it actually built" cannot drift apart by each judging separately. */
function attrDatatype(note: AttrNote): string | null {
  switch (note.outcome) {
    case "datatype":
      return note.detail;
    // No range written, or written but our four kinds cannot express it:
    // the value is still a literal, and text is an honest superset that blocks nothing.
    case "no_range":
    case "degraded_to_text":
      return "text";
    default:
      return null;
  }
}

/** Attributes that cannot be built, grouped and counted by reason. **A bare total in the preview is not enough** — "54 attributes" does not say whether that means all get built or none, and in practice it depends on the reason. */
export function attrSkips(plan: ImportPlan): Map<string, number> {
  const out = new Map<string, number>();
  const bump = (key: string) => out.set(key, (out.get(key) ?? 0) + 1);
  for (const a of plan.attributes) {
    if (a.disposition === "key_taken") {
      bump("key_taken");
      continue;
    }
    switch (a.attr?.outcome) {
      case "datatype":
      case "no_range":
      case "degraded_to_text":
      case undefined:
        continue;
      case "unusable_range":
        bump("unusable_range");
        continue;
      case "no_domain":
        bump("no_domain");
        continue;
      case "domain_skipped":
        bump("domain_skipped");
        continue;
      case "unknown_domain":
        bump("unknown_domain");
        continue;
    }
  }
  return out;
}

/** Parses the file and computes a plan against the existing ontology. Writes nothing. */
export async function plan(
  state: AppState,
  kbId: Uuid,
  filename: string,
  bytes: Uint8Array,
): Promise<[ImportPlan, OwlProjection, RdfFormat]> {
  const format = ontologyRdf.RdfFormat.detect(filename, bytes);
  let proj: OwlProjection;
  try {
    proj = ontologyRdf.project(bytes, format);
  } catch (e) {
    throw AppError.invalid("bad_ontology_file", "Could not parse this ontology file", e instanceof Error ? e.message : String(e));
  }

  // The existing ontology: indexed by IRI and by key, so the two kinds of
  // collision can be judged separately.
  const etypes = await store.graph.entity_types(state.sql, kbId);
  const rtypes = await store.graph.relation_types(state.sql, kbId);
  const eByIri = new Map(etypes.filter((t) => t.iri).map((t) => [t.iri as string, t]));
  const eByKey = new Map(etypes.map((t) => [t.key, t]));
  const rByIri = new Map(rtypes.filter((t) => t.iri).map((t) => [t.iri as string, t]));
  const rByKey = new Map(rtypes.map((t) => [t.key, t]));

  // Class IRIs that will resolve to an id once this run finishes: those
  // newly created or updated in the file, plus ones already in the
  // database under the same IRI. A key collision skip is NOT included —
  // it will not be built, so nothing waiting on it as a domain/range has
  // anywhere to land.
  //
  // This import can also collide with itself: two different IRIs deriving
  // the same short label (FOAF's familyName and family_name both become
  // family_name). Checking only against the database is not enough —
  // otherwise the second one previews as "will be created" and then gets
  // silently dropped by ON CONFLICT at write time, which makes the
  // preview a lie.
  //
  // **Two namespaces, not one**: classes go into entity_types, relations
  // and attributes share relation_types, each with its own (kb_id, key)
  // unique constraint. Merging them into one table would invent a
  // constraint out of nowhere — and the cost is concrete: schema.org's
  // location/address are attributes, but OMG Commons' Location/Address
  // classes claim those names first (classes are processed first), so
  // extraction asks the model for `location` and the database simply does
  // not have it.
  const claimedClass = new Map<string, string>();
  const claimedProp = new Map<string, string>();

  const classes: PlannedItem[] = [];
  for (const c of proj.classes) {
    let renamedKey: string | null = null;
    let disposition: Disposition;
    let conflictWith: string | null = null;
    const prevClaim = claimedClass.get(c.key);
    if (prevClaim !== undefined) {
      disposition = "key_taken";
      conflictWith = prevClaim;
    } else if (eByIri.has(c.iri)) {
      disposition = "update";
    } else {
      const existing = eByKey.get(c.key);
      if (existing) {
        if (existing.iri == null) {
          // **No IRI: claim it.** No IRI means this class was named
          // locally (a seed ontology, or hand-built); it is not another
          // vocabulary's same-named word. The import is saying "this IRI
          // is that class", and skipping this step leaves the whole tree
          // broken: schema.org's Organization would collide with the
          // built-in organization and get skipped, so Corporation's
          // parent points at something never built — none of the
          // built-in base classes gets a subclass, and type refinement
          // has nothing to work from.
          disposition = "update";
        } else {
          // A DIFFERENT IRI is already there: two vocabularies fighting
          // over the same short label. Check the starter-pack alignment
          // table first — that is a DECLARED disposition, and a
          // re-import gets the same result either way, so the "do not
          // auto-suffix" rule below does not apply to it.
          const alignment = packAlignment.lookup(c.iri, existing.iri);
          if (alignment?.kind === "sameAs") {
            // Same meaning: the existing one already is it, and skipping
            // is exactly the outcome that avoids building a duplicate.
            disposition = "aligned";
            conflictWith = existing.iri;
          } else if (alignment?.kind === "rename") {
            // Same name, different meaning: build it under the declared key instead.
            renamedKey = alignment.key;
            disposition = "create";
          } else {
            // Not in the table: a real conflict. Do not auto-suffix — that
            // would make a re-import unable to recognize what it built last time.
            disposition = "key_taken";
            conflictWith = existing.iri;
          }
        }
      } else {
        disposition = "create";
      }
    }
    const key = renamedKey ?? c.key;
    if (disposition !== "key_taken" && disposition !== "aligned") {
      claimedClass.set(key, c.iri);
    }
    classes.push({
      iri: c.iri,
      key,
      label: c.label,
      has_description: c.description.trim() !== "",
      disposition,
      conflict_with: conflictWith,
    });
  }

  // Classes that appeared in the file (including skipped ones) — used to
  // tell "skipped" apart from "not in this file at all".
  const inFile = new Set(proj.classes.map((c) => c.iri));
  const resolvable = new Set([
    ...classes.filter((c) => c.disposition !== "key_taken").map((c) => c.iri),
    ...eByIri.keys(),
  ]);

  const relations: PlannedItem[] = [];
  const attributes: PlannedItem[] = [];
  for (const p of proj.properties) {
    let disposition: Disposition;
    let conflictWith: string | null = null;
    const prevClaim = claimedProp.get(p.key);
    if (prevClaim !== undefined) {
      disposition = "key_taken";
      conflictWith = prevClaim;
    } else if (rByIri.has(p.iri)) {
      disposition = "update";
    } else {
      const existing = rByKey.get(p.key);
      if (existing) {
        disposition = "key_taken";
        conflictWith = existing.iri;
      } else {
        disposition = "create";
      }
    }
    if (disposition !== "key_taken") {
      claimedProp.set(p.key, p.iri);
    }
    const item: PlannedItem = {
      iri: p.iri,
      key: p.key,
      label: p.label,
      has_description: p.description.trim() !== "",
      disposition,
      functional: p.functional,
      conflict_with: conflictWith,
    };
    if (p.isDatatype) {
      item.attr = attrNote(p, proj.vocabDatatypes, resolvable, inFile);
      attributes.push(item);
    } else {
      relations.push(item);
    }
  }

  const unprojected: [string, number][] = [...proj.unprojected.entries()].sort((a, b) => b[1] - a[1]);

  const result: ImportPlan = {
    format,
    triples: proj.triples,
    classes_without_description: classes.filter((c) => !c.has_description).length,
    functional_relations: relations.filter((r) => r.functional).length,
    classes,
    relations,
    attributes,
    unprojected,
  };
  return [result, proj, format];
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Runs the plan. Attributes are written after classes — they attach to a
 * domain, and a domain needs the classes built first and their IRIs
 * resolved to ids (`idOf` below).
 */
export async function apply(
  state: AppState,
  kbId: Uuid,
  actor: Uuid,
  filename: string,
  bytes: Uint8Array,
): Promise<[Uuid, ImportPlan]> {
  const [importPlan, proj, format] = await plan(state, kbId, filename, bytes);

  // Layer one: the original bytes, content-addressed into blob storage.
  // **Store the original before touching the ontology** — a failed
  // projection can be retried; lost original bytes cannot.
  const sha = sha256Hex(bytes);
  await state.blob.put(sha, bytes);

  const byIri = new Map(proj.classes.map((c) => [c.iri, c]));
  // Classes already in the database, by IRI -> id. `aligned` needs this to
  // wire a parent reference to "the equivalent one that already exists".
  const existingByIri = new Map(
    (await store.graph.entity_types(state.sql, kbId))
      .filter((t) => t.iri)
      .map((t) => [t.iri as string, t.id]),
  );
  let createdClasses = 0;
  let updatedClasses = 0;
  // IRI -> the ontology's id, used to resolve parents.
  const idOf = new Map<string, Uuid>();

  // **Newly created classes are inserted in one batch, not one at a
  // time.** One `exec` per row commits separately; at schema.org's scale
  // (about 968 classes plus about 1,500 attributes) that is five thousand
  // fsyncs — measured at 45 seconds. The same rows in one statement take
  // 536 milliseconds. Update and Aligned stay one at a time below: on an
  // empty database they are single digits, and each needs to read current
  // state first, so batching would not help.
  const newClasses: [string, string, string, string][] = importPlan.classes
    .filter((i) => i.disposition === "create")
    .map((i) => {
      const c = byIri.get(i.iri);
      return c ? ([i.key, c.label, c.description, c.iri] as [string, string, string, string]) : null;
    })
    .filter((x): x is [string, string, string, string] => x !== null);
  const createdIds = await store.ontology.create_entity_types_bulk(state.sql, kbId, newClasses);
  for (const [key, , , iri] of newClasses) {
    const id = createdIds.get(key);
    if (id) {
      idOf.set(iri, id);
      createdClasses += 1;
    }
  }

  for (const item of importPlan.classes) {
    const c = byIri.get(item.iri);
    if (!c) continue;
    if (item.disposition === "create") {
      // Already built in the batch above.
    } else if (item.disposition === "update") {
      // Two kinds of Update: this IRI was imported before (found by IRI),
      // or it is claiming a same-named local class (found by key, with no IRI yet).
      const updated = await store.ontology.update_type_from_import(state.sql, kbId, c.iri, c.label, c.description);
      const id = updated ?? (await store.ontology.adopt_iri_onto_key(state.sql, kbId, c.key, c.iri));
      if (id) {
        idOf.set(c.iri, id);
        updatedClasses += 1;
      }
    } else if (item.disposition === "aligned") {
      // sameAs: not built. But the IRI must still point at the existing
      // class's id, or a subclass naming it as a parent would fail to
      // resolve, and the whole tree breaks right here.
      if (item.conflict_with) {
        const id = existingByIri.get(item.conflict_with);
        if (id) idOf.set(c.iri, id);
      }
    }
    // key_taken: already reported, left untouched.
  }

  // Second pass for parents: on the first pass, a parent may not have been built yet.
  const parentEdges: [Uuid, Uuid][] = [];
  for (const c of proj.classes) {
    const child = idOf.get(c.iri);
    if (!child) continue;
    // **All parents, not just the first one.** FOAF's Person is both an
    // Agent and a SpatialThing at once; dropping the second branch would
    // make domain checks on that branch fail. Parents pointing at classes
    // that never got built are naturally excluded — missing one branch is
    // better than not attaching at all.
    const parents = c.parents.map((iri) => idOf.get(iri)).filter((x): x is Uuid => x !== undefined);
    for (const p of parents) parentEdges.push([child, p]);
  }
  await store.ontology.set_parents_bulk(state.sql, parentEdges);

  // Class disjointness, batched the same way. Ends pointing at classes
  // never built are naturally excluded — both ends of a disjointness
  // declaration need to be in this KB before it means anything.
  const disjointEdges: [Uuid, Uuid][] = [];
  for (const c of proj.classes) {
    const a = idOf.get(c.iri);
    if (!a) continue;
    for (const other of c.disjointWith) {
      const b = idOf.get(other);
      if (b) disjointEdges.push([a, b]);
    }
  }
  await store.ontology.set_disjoint_bulk(state.sql, kbId, disjointEdges);

  const byPropIri = new Map(proj.properties.map((p) => [p.iri, p]));
  // Relations. Write used to skip them entirely — while the preview's
  // relations row promised "N new", a promise that never happened. Same
  // family of defect as the key-collision fix.
  //
  // **`functional` / `inverse_functional` are written exactly as the
  // vocabulary declares.** They drive the temporal engine's automatic
  // closure of old facts; a wrong guess manufactures conflicts in bulk
  // (`part_of` once produced 59 of them). The preview already lists
  // functional relations separately for a human to review, so this does
  // not force them to false on its own.
  let createdRels = 0;
  let updatedRels = 0;
  const newRels: BulkRelation[] = [];
  // (key, domains, ranges): a relation has no id until the batch insert finishes, so track by key first.
  const pendingLinks: [string, Uuid[], Uuid[]][] = [];
  for (const item of importPlan.relations) {
    if (item.disposition === "key_taken") continue;
    const p = byPropIri.get(item.iri);
    if (!p) continue;
    // A domain/range pointing at a class never built just drops that one
    // entry, not the whole relation — unlike an attribute, a relation
    // does not have to attach to a class; no domain simply means "no
    // subject-type restriction".
    const resolve = (iris: string[]): Uuid[] => iris.map((i) => idOf.get(i)).filter((x): x is Uuid => x !== undefined);
    const domains = resolve(p.domains);
    const ranges = resolve(p.ranges);

    if (item.disposition === "update") {
      const ok = await store.ontology.update_relation_from_import(
        state.sql,
        kbId,
        p.iri,
        p.label,
        p.description,
        domains,
        ranges,
      );
      if (ok) updatedRels += 1;
      continue;
    }
    newRels.push({
      key: p.key,
      label: p.label,
      description: p.description,
      iri: p.iri,
      kind: "relation",
      datatype: null,
      functional: p.functional,
      inverse_functional: p.inverseFunctional,
      transitive: p.transitive,
      symmetric: p.symmetric,
      asymmetric: p.asymmetric,
      irreflexive: p.irreflexive,
    });
    pendingLinks.push([p.key, domains, ranges]);
  }
  const relIds = await store.ontology.create_relation_types_bulk(state.sql, kbId, newRels);
  createdRels += relIds.size;

  // Inverse and super-property point at ANOTHER relation type, and its id
  // only exists once everything has been inserted — hence a second pass.
  // A single pass would only work when "the parent property happens to
  // come first" in the file, and RDF triples carry no ordering.
  //
  // Both new and pre-existing relations are collected: on a re-import
  // these two declarations may only just now have been added.
  const invPairs: [string, string][] = [];
  const subPairs: [string, string][] = [];
  for (const item of importPlan.relations) {
    const p = byPropIri.get(item.iri);
    if (!p) continue;
    if (p.inverseOf) invPairs.push([p.iri, p.inverseOf]);
    if (p.subPropertyOf) subPairs.push([p.iri, p.subPropertyOf]);
  }
  const [linkedInv, linkedSub] = await store.ontology.link_property_axioms_bulk(state.sql, kbId, invPairs, subPairs);
  // Link rows are flattened too: the single-row version runs 4 statements
  // per relation (two tables, one DELETE and one INSERT each) — fifteen
  // hundred relations would be six thousand separate commits.
  const linkD: [Uuid, Uuid][] = [];
  const linkR: [Uuid, Uuid][] = [];
  for (const [key, domains, ranges] of pendingLinks) {
    const rid = relIds.get(key);
    if (!rid) continue;
    for (const d of domains) linkD.push([rid, d]);
    for (const r of ranges) linkR.push([rid, r]);
  }
  await store.ontology.link_domains_ranges_bulk(state.sql, linkD, linkR);

  // Attributes: only once classes are built and idOf is filled in. The
  // plan already decided each attribute's fate; **this only carries it
  // out, it does not re-decide** — judging twice in two places is exactly
  // how the preview and the actual write drift apart.
  let createdAttrs = 0;
  const newAttrs: BulkRelation[] = [];
  const pendingAttrDomains: [string, Uuid[]][] = [];
  for (const item of importPlan.attributes) {
    if (item.disposition === "key_taken") continue;
    const p = byPropIri.get(item.iri);
    if (!item.attr || !p) continue;
    const dt = attrDatatype(item.attr);
    if (dt === null) continue;
    // A domain judged resolvable at plan time but with no id at write time
    // (its class was skipped or failed to update) is naturally excluded;
    // when all of them are, skip building rather than build an attribute
    // attached to nothing.
    const domainIds = p.domains.map((iri) => idOf.get(iri)).filter((x): x is Uuid => x !== undefined);
    if (domainIds.length === 0) continue;
    newAttrs.push({
      key: p.key,
      label: p.label,
      description: p.description,
      iri: p.iri,
      kind: "attribute",
      datatype: dt,
      // An attribute does not take part in temporal closure or the
      // consistency check: both are judgments about edges BETWEEN
      // entities, and an attribute's object is a literal.
      functional: false,
      inverse_functional: false,
      transitive: false,
      symmetric: false,
      asymmetric: false,
      irreflexive: false,
    });
    pendingAttrDomains.push([p.key, domainIds]);
  }
  const attrIds = await store.ontology.create_relation_types_bulk(state.sql, kbId, newAttrs);
  createdAttrs += attrIds.size;
  const attrLinks: [Uuid, Uuid][] = [];
  for (const [key, domains] of pendingAttrDomains) {
    const aid = attrIds.get(key);
    if (!aid) continue;
    for (const d of domains) attrLinks.push([aid, d]);
  }
  await store.ontology.link_domains_ranges_bulk(state.sql, attrLinks, []);

  const skips = attrSkips(importPlan);
  const summary = {
    classes_created: createdClasses,
    classes_updated: updatedClasses,
    classes_key_taken: importPlan.classes.filter((c) => c.disposition === "key_taken").length,
    relations_seen: importPlan.relations.length,
    // Reported, because a target IRI outside this KB is silently skipped
    // (referencing an external vocabulary is normal) — without a count
    // nobody would know how many links were missed.
    inverse_linked: linkedInv,
    sub_property_linked: linkedSub,
    relations_created: createdRels,
    relations_updated: updatedRels,
    attributes_seen: importPlan.attributes.length,
    attributes_created: createdAttrs,
    attributes_skipped: Object.fromEntries(skips),
    classes_without_description: importPlan.classes_without_description,
    functional_relations: importPlan.functional_relations,
    unprojected: importPlan.unprojected.slice(0, 30),
    triples: importPlan.triples,
  };
  const importId = await store.ontology.record_import(state.sql, kbId, sha, filename, format, bytes.byteLength, summary, actor);

  await store.audit.record(state.sql, kbId, actor, "ontology.imported", "kb", kbId, summary).catch(() => {});
  // The ontology just changed, so its vectors are stale. **Queued, not run
  // in place**: this pass embeds thousands of rows, and doing it inside
  // the import request would make the person who just clicked confirm
  // wait six to eight minutes. Missing the queue slot is not fatal either
  // — the index is self-healing, and the next person who uses retrieval
  // tops it up.
  await store.jobs.enqueue(state.sql, "embed_ontology", { kb_id: kbId }).catch(() => {});

  return [importId, importPlan];
}

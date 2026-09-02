/**
 * Automatic ontology extension: when extraction hits a wording outside
 * the ontology, fold it in and rewrite the facts that were waiting on it.
 *
 * A freshly created KB starts with whatever relations the user's chosen
 * starter pack seeds (0008), or none at all. No pack is big enough to
 * cover a whole corpus: a fact whose predicate does not fit the ontology
 * is left with none, the source wording is kept on the evidence (0010),
 * and its edge on the graph carries only the raw wording, no vocabulary
 * meaning, until a person sits down, clicks Suggest, reviews a proposal,
 * and clicks Add one at a time. This module automates that step: once a
 * wording is common enough, build it as a relation and rewrite the facts
 * that were waiting on it.
 *
 * This is safe to do because adoption is reversible (see
 * `store/graph.ts`'s `unadopt`): a mistake is one click away from undone,
 * and the old facts are never destroyed. So the axis to judge is not "how
 * confident", it is "how expensive if wrong".
 *
 * **Whether to do this for a person is declared in KB settings**
 * (`auto_extend_ontology`, on by default). This used to be inferred from
 * behavior — "has the ontology been touched" — and that was a guess with
 * an absurd failure mode: clicking Add once on a proposal would
 * permanently turn the suggestion feature off. The setting removes both
 * the guessing and the freeze.
 *
 * Turning it off does not affect "keeping an eye on things": unmatched
 * statistics still accumulate, still visible on the Unmatched panel; they
 * just become a proposal you click, with none of the information lost.
 *
 * **`functional` is never automatic, even with the setting on** — it
 * drives the temporal engine's automatic closure of facts and its
 * conflict generation, and by the time a mistake is noticed, the closures
 * are already a chain of supersedes — not the kind of thing that is
 * cheap to be wrong about.
 */

import type { AppState } from "./state";
import * as store from "./store";
import type { Uuid } from "./core/ids";
import { mergeKey, PredicateIndex } from "./predicate_match";
import { buildProposals, adoptAttributeAuto, adoptAttributeExisting } from "./ontology_engine";
import type { ProposedPredicate } from "./store/graph";
import { colorForKey } from "./store/palette";
import { log } from "./core/log";

/** Fewer than this many qualifying signals (predicates + types) is not worth bothering with — not enough for a decent proposal, and it would just burn one LLM call. */
const MIN_SIGNALS = 3;
/**
 * Only adopt a wording that appears in at least this many documents.
 * **A wording seen in only one document is that document's own word
 * choice, not this organization's vocabulary** — and the ontology feeds
 * back into the extraction prompt, so one accident would become a
 * standing instruction.
 *
 * The side effect is exactly right: with only one document, nothing
 * clears this bar, so nothing happens, and the next document gets another try.
 */
const MIN_DOCS = 2;

/** A group of wordings merged by their inflection base — after adoption they are the same relation. */
type RelationGroup = {
  /** Canonical key: whichever wording in the group has the most facts. **The model is not asked to name it** — every wording in the group is a spelling that really occurred in the text, and picking the most common one fits the corpus better than inventing a new word. */
  key: string;
  /** Every wording in the group, rewritten together on adoption. */
  forms: string[];
  facts: number;
  docs: number;
  /** Where this lands if the ontology already has an equivalent relation: [relation id, whether to swap subject/object]. `null` = the ontology really does not have one; build by vote count. */
  existing: [Uuid, boolean] | null;
};

/**
 * Decides which relations to adopt, by vote count. **Never calls the
 * model.**
 *
 * Three steps: merge wordings by their inflection base (`sued` and `sues`
 * are the same relation), compute the document union, and check the
 * threshold.
 *
 * The union must not be a sum: the same document can easily use both
 * spellings, and summing would let one document push a wording over the
 * "at least 2 documents" bar on its own. So this reads the real document
 * ids from `proposedPredicateDocuments`.
 *
 * The output is **sorted** — half of this path's value is being
 * deterministic, and a Map's iteration order is not.
 */
async function countedRelationGroups(state: AppState, kbId: Uuid): Promise<RelationGroup[]> {
  const forms = await store.graph.proposed_predicates(state.sql, kbId);
  const pairs = await store.graph.proposed_predicate_documents(state.sql, kbId);
  // **Check the ontology before building.**
  //
  // Without this step, adoption always builds by vote count alone, never
  // checking "is there already an equivalent". Measured fallout: in the
  // demo-b3 KB, `produced_by` and `produces`, and `developed_by` and
  // `develops`, each became their own separate relation — the two
  // directions of the same fact permanently split apart.
  //
  // And `produces` had 265 facts, `produced_by` only 15 — the one with
  // more votes goes into the ontology first, and the smaller one should
  // have been caught by `predicate_match`'s `_by` rule, but was not,
  // **because the adoption path never runs the matcher at all**. The
  // matcher was only ever used during extraction; this is the second
  // place it was missing.
  const rtypes = await store.graph.relation_types(state.sql, kbId);
  const index = PredicateIndex.build(rtypes);

  const docsOf = new Map<string, Set<Uuid>>();
  for (const [form, doc] of pairs) {
    let s = docsOf.get(form);
    if (!s) {
      s = new Set();
      docsOf.set(form, s);
    }
    s.add(doc);
  }

  const grouped = new Map<string, ProposedPredicate[]>();
  for (const f of forms) {
    const key = mergeKey(f.form).join("\u0000");
    let members = grouped.get(key);
    if (!members) {
      members = [];
      grouped.set(key, members);
    }
    members.push(f);
  }

  const out: RelationGroup[] = [];
  for (const members of grouped.values()) {
    // Most facts first, ties broken lexicographically — the canonical
    // key's choice must not depend on Map iteration order.
    members.sort((a, b) => b.fact_count - a.fact_count || a.form.localeCompare(b.form));
    const docs = new Set<Uuid>();
    for (const m of members) {
      const d = docsOf.get(m.form);
      if (d) for (const id of d) docs.add(id);
    }
    if (docs.size < MIN_DOCS) continue;
    // If any wording in the group already resolves to an existing
    // relation, the whole group lands there. Wordings in the same group
    // share an inflection base, and whether the ending has "by" or not is
    // necessarily the same across the group (`produced_by` and `produces`
    // are different groups), so "swap or not" is consistent for the
    // whole group — no need to judge it wording by wording.
    let existing: [Uuid, boolean] | null = null;
    for (const m of members) {
      const hit = index.lookup(m.form);
      if (hit) {
        existing = hit;
        break;
      }
    }
    out.push({
      key: members[0]!.form,
      facts: members.reduce((sum, m) => sum + m.fact_count, 0),
      forms: members.map((m) => m.form),
      docs: docs.size,
      existing,
    });
  }
  out.sort((a, b) => b.facts - a.facts || a.key.localeCompare(b.key));
  return out;
}

function strOf(v: Record<string, unknown>, key: string): string | null {
  const raw = v[key];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

function formsOf(v: Record<string, unknown>, fallback: string[]): string[] {
  const raw = v.forms;
  if (Array.isArray(raw)) {
    const out = raw.filter((x): x is string => typeof x === "string");
    if (out.length > 0) return out;
  }
  return fallback;
}

export async function bootstrapOntology(state: AppState, kbId: Uuid): Promise<void> {
  // Two concurrent extraction tasks may both see "nothing queued" and
  // each enqueue this once; the setting may also have just been turned off.
  const kb = await store.kbs.get(state.sql, kbId);
  if (!kb.auto_extend_ontology) {
    log.info("automatic ontology extension is off, skipping", { kb_id: kbId });
    return;
  }
  // The threshold is "is this enough for one LLM call", **predicates and
  // types counted together**. This used to count only predicates, so a
  // corpus missing only entity types (never a relation) would be skipped
  // wholesale — while `proposed_type` already had `platform` x2,
  // `inference_engine` x2 sitting there waiting.
  const forms = (await store.graph.proposed_predicates(state.sql, kbId)).filter((f) => f.doc_count >= MIN_DOCS);
  const types = await store.resolution.proposed_types(state.sql, kbId);
  if (forms.length + types.length < MIN_SIGNALS) {
    log.info("too few qualifying signals, skipping automatic ontology extension", {
      kb_id: kbId,
      predicates: forms.length,
      types: types.length,
    });
    return;
  }

  // **Relations are adopted by vote count, never asked of the model.**
  //
  // This used to hand the candidates to the LLM and ask "which of these
  // are worth building". The data had already answered that question —
  // `runs_on` appeared in 8 documents and 13 facts, that is not a
  // judgment call. And the model, measured, got it wrong: it missed
  // `runs_on` while adopting `pledged_capital`, seen in only one
  // document.
  //
  // Switching to counting has one more effect that matters: **this step
  // becomes deterministic.** The same corpus run twice builds the same
  // ontology, and a benchmark can finally compare runs against each
  // other. Two earlier runs differed by three points, and there was no
  // way to tell whether that was a real fix or run-to-run variance,
  // exactly because an LLM call sat in the middle.
  //
  // The model was not removed, only asked a different question: the
  // synonym-folding below — "which of these new relations mean the same
  // as one that already exists". That one genuinely needs judgment, and
  // getting it wrong is one `unadopt` away from undone.
  const counted = await countedRelationGroups(state, kbId);
  const proposals = await buildProposals(state, kbId, "en", MIN_DOCS);
  const classes = proposals.entity_types;

  const addedRelations: string[] = [];
  const addedClasses: string[] = [];
  let movedTotal = 0;
  const batches: Uuid[] = [];

  for (const p of classes) {
    const rec = p as Record<string, unknown>;
    const key = strOf(rec, "key");
    const label = strOf(rec, "label");
    if (!key || !label) continue;
    let typeId: Uuid;
    try {
      typeId = await store.ontology.create_entity_type(
        state.sql,
        kbId,
        key,
        label,
        // A cold-start-built class gets no parent: the proposal carries
        // no hierarchy information, and guessing a parent is worse than none.
        colorForKey(key),
        "circle",
        [],
        // The description feeds the extraction prompt; the reason is only for a person to read — feeding the wrong one in makes this class the next dumping ground.
        strOf(rec, "description") ?? strOf(rec, "reason") ?? "",
      );
    } catch (e) {
      // A key collision or similar: skip this one entry, do not take the whole batch down with it.
      log.warn("failed to build a class at cold start", { kb_id: kbId, key, error: String(e) });
      continue;
    }
    addedClasses.push(key);
    // After building the class, sweep the entities that were waiting for
    // it — building only the type without moving entities grows the
    // ontology without improving the graph; those entities proposed
    // `model` stay stuck under concept.
    const forms2 = formsOf(rec, [key]);
    try {
      const [batch, n] = await store.resolution.adopt_proposed_types(state.sql, kbId, typeId, forms2, null);
      movedTotal += n;
      if (n > 0) batches.push(batch);
    } catch (e) {
      log.warn("failed to retype entities onto a cold-start class", { kb_id: kbId, key, error: String(e) });
    }
    for (const form of forms2) {
      await store.ontology.clear_miss(state.sql, kbId, "entity_type", form).catch(() => {});
    }
  }

  // Relations: adopted by vote count, one relation per group.
  //
  // key and label both come from the corpus's own wording; description is
  // left blank — it feeds the extraction prompt as a semantic guide, and
  // there is no trustworthy source to write it from here. Inventing a
  // sentence would be injecting an unowned claim into the prompt, while
  // the key itself (`runs_on`, `available_on`) already says it plainly.
  //
  // temporal is always `state`: it only drives the temporal engine when
  // functional / inverse_functional are true, and this path **never**
  // sets those two automatically (see the module doc), so it has no
  // behavioral effect here.
  for (const g of counted) {
    let predicateId: Uuid;
    let swap: boolean;
    if (g.existing) {
      [predicateId, swap] = g.existing;
    } else {
      try {
        predicateId = await store.ontology.create_relation_type(
          state.sql,
          kbId,
          g.key,
          g.key.replace(/_/g, " "),
          "state",
          // A cold start does not declare any axioms on a person's
          // behalf: the reasoner's judgments must be written by a human.
          {
            functional: false,
            inverse_functional: false,
            transitive: false,
            symmetric: false,
            asymmetric: false,
            irreflexive: false,
            inverse_of: null,
            sub_property_of: null,
          },
          "",
          "relation",
          [],
          [],
          null,
          null,
        );
        addedRelations.push(g.key);
        swap = false;
      } catch (e) {
        log.warn("failed to build a relation at cold start", { kb_id: kbId, key: g.key, error: String(e) });
        continue;
      }
    }
    const [batch, moved] = await store.graph.adopt_proposed_predicates(state.sql, kbId, predicateId, g.forms, swap);
    log.info("adopted a relation by vote count", {
      kb_id: kbId,
      key: g.key,
      forms: g.forms,
      docs: g.docs,
      facts: g.facts,
      moved,
      reused: g.existing !== null,
      swap,
    });
    movedTotal += moved;
    if (moved > 0) batches.push(batch);
    for (const form of g.forms) {
      await store.ontology.clear_miss(state.sql, kbId, "relation_type", form).catch(() => {});
    }
  }

  // The attribute tier: wordings whose object is a literal value.
  //
  // domain is not read from the proposal — it comes from these facts'
  // subject types, see `adoptAttributeAuto`. Values that will not
  // convert are not rewritten; they stay predicate-less and get another try next time.
  const attrs = proposals.attribute_types;
  for (const p of attrs) {
    const rec = p as Record<string, unknown>;
    const key = strOf(rec, "key");
    const label = strOf(rec, "label");
    if (!key || !label) continue;
    const forms2 = formsOf(rec, []);
    if (forms2.length === 0) continue;
    try {
      const [batch, moved] = await adoptAttributeAuto(
        state,
        kbId,
        key,
        label,
        strOf(rec, "description") ?? strOf(rec, "reason") ?? "",
        strOf(rec, "datatype") ?? "text",
        strOf(rec, "unit"),
        forms2,
      );
      addedRelations.push(key);
      movedTotal += moved;
      if (moved > 0) batches.push(batch);
    } catch (e) {
      log.warn("failed to build an attribute at cold start", { kb_id: kbId, key, error: String(e) });
    }
  }

  // **Mapped onto an existing type**: the ontology already carries this
  // meaning, so only the facts are rewritten, the ontology itself is not touched.
  //
  // Doing this automatically is the safe tier: it never grows the
  // ontology, only attaches a batch of `related_to` facts onto an
  // existing predicate, and it goes through the same batch mechanism as a
  // fresh build, so it is just as reversible. Skipping this tier would be
  // the dangerous side, though: retrieval tells the model "founding_date
  // already exists", the model answers "these wordings are it", and doing
  // nothing leaves that whole batch of facts stuck as "related to".
  const mapped = proposals.map_to;
  for (const m of mapped) {
    const rec = m as Record<string, unknown>;
    const key = strOf(rec, "key");
    if (!key) continue;
    const forms2 = formsOf(rec, []);
    if (forms2.length === 0) continue;
    // The target is an attribute: rewrite goes through the other path — a
    // value has to convert according to its datatype. `kind` was tagged
    // server-side while parsing the proposal (the model can only answer with a key).
    if (rec.kind === "attribute") {
      try {
        const [batch, moved] = await adoptAttributeExisting(state, kbId, key, forms2);
        movedTotal += moved;
        if (moved > 0) batches.push(batch);
      } catch (e) {
        log.warn("failed to map onto an existing attribute", { kb_id: kbId, key, error: String(e) });
      }
      continue;
    }
    // The model occasionally copies in a key outside the candidate list
    // (or invents one). Not found means skip — **never build** — that is
    // the whole premise of this tier, "it already exists".
    const predicateId = await store.ontology.relation_type_id_by_key(state.sql, kbId, key);
    if (!predicateId) {
      log.warn("a map_to target is not in the ontology, skipping", { kb_id: kbId, key });
      continue;
    }
    const [batch, moved] = await store.graph.adopt_proposed_predicates(state.sql, kbId, predicateId, forms2, false);
    movedTotal += moved;
    if (moved > 0) batches.push(batch);
    for (const form of forms2) {
      await store.ontology.clear_miss(state.sql, kbId, "relation_type", form).catch(() => {});
    }
  }

  // Building the class first and only extracting the entity later is
  // normal: sweep up the ones waiting on a type that already exists now.
  try {
    const swept = await store.resolution.sweep_proposed_types(state.sql, kbId, null);
    for (const [batch, n] of swept) {
      movedTotal += n;
      batches.push(batch);
    }
  } catch (e) {
    log.warn("failed to sweep entities onto already-existing types", { kb_id: kbId, error: String(e) });
  }

  if (addedRelations.length === 0 && addedClasses.length === 0 && movedTotal === 0) {
    return;
  }
  // actor is NULL: this is a system action, not anyone's decision. The
  // ledger shows what happened, how much changed, and which batch numbers to use for an undo.
  await store.audit
    .recordOpt(state.sql, kbId, null, "ontology.bootstrapped", "kb", kbId, {
      relations: addedRelations,
      classes: addedClasses,
      facts_remapped: movedTotal,
      batches,
    })
    .catch(() => {});
  state.emitReview(kbId);
  log.info("automatic cold-start ontology extension complete", {
    kb_id: kbId,
    relations: addedRelations.length,
    classes: addedClasses.length,
    facts: movedTotal,
  });
}
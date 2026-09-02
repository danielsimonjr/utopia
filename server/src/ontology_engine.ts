/**
 * Shared ontology-extension logic: building LLM proposals, and adopting an
 * attribute (build or reuse it, then rewrite the literal facts waiting on
 * it).
 *
 * Split out of the ontology HTTP routes so that both a human clicking
 * Suggest/Adopt and the automatic cold-start path (`bootstrap_ontology.ts`)
 * call the exact same code — the automatic path is not a different
 * judgment, it is only missing the "a person clicks a button" step.
 */

import type { AppState } from "./state";
import * as store from "./store";
import type { TypeCandidate } from "./store/ontology";
import { chatClient } from "./llm_util";
import { jsonBlock, normalizeAttrValue } from "./extract";
import * as ontologyIndex from "./ontology_index";
import { AppError } from "./core/errors";
import type { Uuid } from "./core/ids";

/** Each probe retrieves a small number of candidates: the candidates are for the model to judge "is this already there", not to pick the closest of a pile of loosely related entries. A larger number just makes it force a mapping among mediocre matches. */
const CANDIDATES_PER_PROBE = 5;

/**
 * key/label comparison form: lowercase, letters and digits only.
 *
 * **Separators are dropped entirely**, because separators are exactly what
 * needs to line up: `acquiredFrom`, `acquired_from`, `Acquired From` all
 * fold to `acquiredfrom`. Folding to underscores would not be enough —
 * camelCase has no separator to fold.
 *
 * This only aligns spelling; it does not judge synonyms — that is
 * retrieval's and the model's job.
 */
export function normalizeName(s: string): string {
  return [...s].filter((c) => /[a-zA-Z0-9]/.test(c)).map((c) => c.toLowerCase()).join("");
}

/** Language code -> the name written into the prompt for the model to read. The model understands "Chinese"; it may not understand "zh". */
function langName(code: string): string {
  return code === "zh" ? "Chinese" : "English";
}

type ProposalItem = Record<string, unknown>;
type Proposals = {
  entity_types: ProposalItem[];
  relation_types: ProposalItem[];
  attribute_types: ProposalItem[];
  map_to: ProposalItem[];
  [key: string]: ProposalItem[];
};

/**
 * Maps `map_to` keys back to the ontology's real key; anything that does
 * not resolve is dropped entirely.
 *
 * A model miscopy is common, and usually copies the label sitting right
 * next to the candidate line (`acquiredFrom` instead of `acquired_from`).
 * **This must happen server-side**: the "use the existing one" button in
 * the UI promises to attach a batch of facts to an existing predicate —
 * if the key does not resolve it can only error, after already promising
 * to do it. An unresolvable entry should not even be shown.
 *
 * Also tags whether the target is a relation or an attribute: adoption
 * rewrites those two differently, and the model only answers with a key —
 * nothing else says which table, which section, that key lives in.
 */
function resolveMapTargets(proposals: Proposals, byName: Map<string, string>, kindOfKey: Map<string, string>): void {
  const items = proposals.map_to;
  if (!Array.isArray(items)) return;
  proposals.map_to = items.filter((m) => {
    const raw = m.key;
    if (typeof raw !== "string") return false;
    const real = byName.get(normalizeName(raw));
    if (real === undefined) return false;
    m.kind = kindOfKey.get(real) ?? "relation";
    m.key = real;
    return true;
  });
}

/**
 * Keeps only the proposals whose wordings truly belong to this section, and
 * strips out of `forms` any wording the other section has already claimed.
 *
 * **The server holds the deciding fact**: whether a wording carries a literal value
 * or an entity object is written in the facts. The server does not need to ask the
 * model.
 * Measured: the model will propose the same `founded_in` as both a
 * relation and an attribute — adopting both means the same facts get
 * claimed twice, and whichever runs first wins.
 *
 * A proposal left with no wordings is dropped entirely: its promised
 * "rewrites N facts" is already zero.
 */
function keepForms(proposals: Proposals, section: string, mine: Set<string>, theirs: Set<string>): void {
  const items = proposals[section];
  if (!Array.isArray(items)) return;
  proposals[section] = items.filter((p) => {
    const forms = p.forms;
    if (!Array.isArray(forms)) {
      // No forms: this proposal only adds a type, does not rewrite any
      // fact, and archiving does not apply to it.
      return true;
    }
    const kept = forms.filter((f) => {
      if (typeof f !== "string") return false;
      // Only drop it when the other section explicitly claims it. A
      // wording neither side recognizes (e.g. from misses rather than a
      // surface predicate) is left alone — dropping it would be vetoing a
      // proposal on the model's behalf.
      return !theirs.has(f) || mine.has(f);
    });
    p.forms = kept;
    return kept.length > 0;
  });
}

/**
 * Generates ontology-extension proposals. A human clicking Suggest and the
 * automatic cold-start path share this exact code — the automatic path is
 * not a different judgment, only missing the "someone clicks" step.
 *
 * `minDocs`: only wordings appearing in at least this many documents are
 * handed to the model. 0 = hand over everything.
 */
export async function buildProposals(
  state: AppState,
  kbId: Uuid,
  reasonLang: string,
  minDocs: number,
): Promise<Proposals> {
  const kb = await store.kbs.get(state.sql, kbId);
  const settings = await store.settings.get(state.sql, kb.workspace_id);
  if (!settings) throw AppError.invalid("no_chat_model", "Chat model not configured");
  const client = chatClient(settings);
  if (!client) throw AppError.invalid("no_chat_model", "Chat model not configured");

  let misses = await store.ontology.list_misses(state.sql, kbId);
  // Surface predicates carry one more thing than misses: they are linked
  // to actual facts, so a proposal can promise "this will reclassify N
  // facts" and then really do it.
  //
  // **The two lines are kept strictly apart**, by whether the object is an
  // entity or a literal: an acquisition wants a relation, a founding date
  // wants an attribute. Mixing them would turn `founding_date = "2015"`
  // into a relation pointing at a fake entity named "2015".
  let forms = await store.graph.proposed_predicates(state.sql, kbId);
  let valueForms = await store.graph.proposed_attributes(state.sql, kbId);
  if (minDocs > 0) {
    forms = forms.filter((f) => f.doc_count >= minDocs);
    valueForms = valueForms.filter((f) => f.doc_count >= minDocs);
    // **All three lists must be filtered, or filtering one does nothing.**
    // The same wording appears twice in the prompt: the miss line ("seen N
    // times") and the surface-predicate line ("on N fact(s)"). A miss has
    // no document dimension, so filter it by which wordings survived —
    // those are the ones that both crossed the document threshold and
    // still have no predicate. Classes are left untouched: ProposedType
    // also has no doc_count, and forcing it through this filter would be
    // judging it by an unrelated criterion.
    const kept = new Set(forms.map((f) => f.form));
    misses = misses.filter((m) => m.kind !== "relation_type" || kept.has(m.key));
  }
  if (misses.length === 0 && forms.length === 0 && valueForms.length === 0) {
    return { entity_types: [], relation_types: [], attribute_types: [], map_to: [] };
  }

  // **A relevant slice of the ontology, not its full text.**
  //
  // This used to inline two flat lists of keys — for a 965-class ontology
  // that is a prompt of 1,949 keys, and with no description the model
  // cannot judge "is this wording a synonym of an existing type", so it
  // only ever creates new ones, and the ontology steadily grows
  // duplicates.
  //
  // Now each wording retrieves a few nearest candidates, with their
  // descriptions attached. Prompt size no longer depends on ontology
  // size, and "there is already one" becomes judgeable for the first
  // time.
  await ontologyIndex.refresh(state, kbId).catch(() => {});
  // Predicate side: surface wordings plus relation-type misses. An
  // example gives the vector more to go on — "acquires" alone is too
  // short, "Nebula Tech -> Deepblue Storage" gives it context.
  const predProbes = [
    ...forms.map((f) => (f.example ? `${f.form} — ${f.example}` : f.form)),
    ...misses.filter((m) => m.kind === "relation_type").map((m) => m.key),
  ];
  // Class side. **Must be retrieved separately**: the two tables'
  // descriptions answer completely different questions, and searching an
  // out-of-vocabulary class name against relations would only ever come
  // back with something loosely related.
  const classProbes = misses.filter((m) => m.kind === "entity_type").map((m) => m.key);
  const perPred = await ontologyIndex
    .nearestForEach(state, kbId, predProbes, CANDIDATES_PER_PROBE, { kind: "predicate", only: null })
    .catch(() => predProbes.map(() => [] as TypeCandidate[]));
  const perClass = await ontologyIndex
    .nearestForEach(state, kbId, classProbes, CANDIDATES_PER_PROBE, { kind: "class" })
    .catch(() => classProbes.map(() => [] as TypeCandidate[]));
  // Attribute side: only searched within attributes. Without limiting the
  // kind, the nearest match for "founding date" is usually a relation, and
  // the model would map a literal onto an edge.
  const attrProbes = [
    ...valueForms.map((f) => (f.example ? `${f.form} = ${f.example}` : f.form)),
    ...misses.filter((m) => m.kind === "attribute_type").map((m) => m.key),
  ];
  const perAttr = await ontologyIndex
    .nearestForEach(state, kbId, attrProbes, CANDIDATES_PER_PROBE, { kind: "predicate", only: "attribute" })
    .catch(() => attrProbes.map(() => [] as TypeCandidate[]));

  // Union, deduplicated: several wordings often point at the same
  // candidate, and listing it once per wording burns tokens for nothing.
  const seen = new Set<string>();
  const candidateLines: string[] = [];
  // The keys the model copies back must resolve to the ontology: the
  // candidate table is indexed by key, normalized key, and label at once.
  const byName = new Map<string, string>();
  // Whether each candidate is a relation or an attribute. On mapping to an
  // existing type, which rewrite path adoption takes depends on this.
  const kindOfKey = new Map<string, string>();
  for (const c of [...perPred.flat(), ...perClass.flat(), ...perAttr.flat()]) {
    if (seen.has(c.key)) continue;
    seen.add(c.key);
    byName.set(normalizeName(c.key), c.key);
    byName.set(normalizeName(c.label), c.key);
    // A relation row carries its own relation/attribute kind; a class row has none.
    const kind = c.kind ?? "entity type";
    kindOfKey.set(c.key, kind);
    const d = c.description.trim();
    // **The label is written only when it actually adds something.**
    // An imported ontology's label is often just the key in camelCase
    // (acquired_from / acquiredFrom) — two nearly identical names side by
    // side, and the model copies the wrong one. A Chinese label paired
    // with an English key is the case where the label carries real
    // information, so it is kept for that case.
    const name = normalizeName(c.label) === normalizeName(c.key) ? "" : ` (${c.label})`;
    candidateLines.push(d === "" ? `- ${c.key} [${kind}]${name}` : `- ${c.key} [${kind}]${name}: ${d}`);
  }
  // No candidates at all (no embedding model configured, or an empty
  // ontology) is stated plainly, so the model does not read "nothing in
  // the ontology" as license to build freely.
  const candidatesBlock =
    candidateLines.length === 0
      ? "(no candidates retrieved — the ontology may be empty, or embeddings are unavailable)"
      : candidateLines.join("\n");

  const missLines = misses.map((m) => `- [${m.kind}] "${m.key}" seen ${m.count} times, e.g. ${m.example ?? "-"}`);

  // Surface predicate lines carry the fact count and an example: the model
  // judges from this whether it is a real relation, and `forms` tells
  // adoption which wordings to rewrite.
  const formLines = forms.map((f) => `- "${f.form}" on ${f.fact_count} fact(s), e.g. ${f.example ?? "-"}`);

  // The literal-value lines carry two extra things: an example value (so
  // the model can judge number vs date), and which classes this wording
  // actually sits on. The latter is not for the model to read — it is
  // used directly as the domain at adoption time, and a wrong domain
  // guess means the whole thing is dropped when the subject type does not match.
  const valueLines = valueForms.map(
    (f) =>
      `- "${f.form}" on ${f.fact_count} fact(s), value e.g. ${f.example ?? "-"}, seen on: ${
        f.domain_keys.length === 0 ? "-" : f.domain_keys.join(", ")
      }`,
  );

  const prompt = `You are an ontology engineer.

Below are the ontology entries closest in meaning to the unmatched wordings that follow. This is a retrieved slice, not the whole ontology, so "not in this list" does not mean "not in the ontology" — it means nothing close to it was found:
${candidatesBlock}

During extraction, the LLM repeatedly produced types/relations OUTSIDE this ontology:
${missLines.join("\n")}

These predicates were taken from the source text because nothing in the ontology fit. Their facts are currently filed under "related_to", which says nothing:
${formLines.join("\n")}

These carried a literal VALUE rather than pointing at another entity, so each one wants an attribute, never a relation. Turning one into a relation manufactures an entity out of the value — a node named "2015" that stands for nothing:
${valueLines.join("\n")}

Each wording gets exactly ONE answer. Do not both map it and propose for it, and do not propose it as a relation and as an attribute — a wording listed above as carrying a value is an attribute, full stop.

For each wording, decide one of two things.

**If one of the candidates above already means it, map to it** — name that candidate's key in "map_to". Do this whenever the meaning matches even though the spelling differs ("founding date" is founding_date; "headquartered in" is location). Adding a second entry for a meaning the ontology already carries is the worst outcome available here: it splits the same facts across two keys permanently, and nothing downstream can tell they were the same.

**Otherwise propose a new entry.** Rules:
- Merge near-duplicates into ONE relation and list every spelling it covers in "forms" (e.g. available_on / available_from / "available through" are one relation).
- Skip generic verbs that carry no domain meaning (is, has, includes, provides, brings).
- A relation is worth adding when the ontology genuinely lacks that meaning, not merely because a word was frequent.
- "functional" must be false unless the relation truly permits at most one object per subject at a time. Getting this wrong makes the temporal engine manufacture conflicts.
- An attribute needs a "datatype": text, number, date or bool. Read it off the example value. Choose text when unsure — a value that will not convert to the declared type is dropped, and a date stored as text is still the value.

Every proposal needs a "description" as well as a "reason", and they are not the same thing. The reason argues for adding it and is read by a person. **The description is injected verbatim into the extraction prompt and is the only thing telling the model what belongs here** — write it as a definition: say what the type is, then say what it is not and which existing type those cases belong to. A type that arrives with a weak description becomes the next dumping ground.

Output exactly one JSON object:
{"entity_types":[{"key":"snake_case","label":"Display Name","description":"what belongs here, and what does not","reason":"why add it"}],
 "relation_types":[{"key":"snake_case","label":"display label","temporal":"state|event|eternal","functional":false,"forms":["surface spellings this covers"],"description":"what this relation asserts, and what it does not","reason":"why add it"}],
 "attribute_types":[{"key":"snake_case","label":"display label","datatype":"text|number|date|bool","unit":"optional, e.g. CNY","forms":["surface spellings this covers"],"description":"what this attribute records, and what it does not","reason":"why add it"}],
 "map_to":[{"key":"an existing key, copied from the candidate list above","forms":["surface spellings that mean it"],"reason":"why these are the same thing"}]}

Language, and it overrides the skeleton above — that skeleton is written in English only because these instructions are. Write every "label" and "description" in ${langName(kb.ontology_lang ?? "en")}: they become this knowledge base's own ontology, and the description is read by the extraction model while it reads documents in that language. Write every "reason" in ${langName(reasonLang)}: a person reads it. "key" and "forms" stay lowercase ASCII either way.`;

  const reply = await client.chat([{ role: "user", content: prompt }]);
  const block = jsonBlock(reply);
  const proposals = JSON.parse(block) as Proposals;
  for (const section of ["entity_types", "relation_types", "attribute_types", "map_to"] as const) {
    if (!Array.isArray(proposals[section])) proposals[section] = [];
  }
  resolveMapTargets(proposals, byName, kindOfKey);
  // The server decides which section a wording belongs to — it has the
  // facts in hand. Measured: the model will propose the same
  // "founded_in" as both a relation and an attribute; adopting both means
  // the same facts get claimed twice.
  const valueOnly = new Set(valueForms.map((f) => f.form));
  const entityOnly = new Set(forms.map((f) => f.form));
  keepForms(proposals, "relation_types", entityOnly, valueOnly);
  keepForms(proposals, "attribute_types", valueOnly, entityOnly);
  return proposals;
}

/** Everything one attribute adoption needs. */
export type AttributeAdoption = {
  key: string;
  label: string;
  description: string;
  datatype: string;
  unit: string | null;
  forms: string[];
  /** true = key names an EXISTING attribute; only rewrite, do not build one. */
  existing: boolean;
};

export type AttributeAdopted = {
  attribute_id: Uuid;
  batch_id: Uuid;
  remapped: number;
  /** How many facts were left un-rewritten because their value would not convert to this datatype. Must be reported upward — 3 rewritten and 2 dropped, reporting only the first half is reporting good news only. */
  unconvertible: number;
};

/** Builds (or points at an existing) attribute, and rewrites the literal facts waiting on it. Shared by a human's click and the automatic path. */
export async function adoptAttributeCore(state: AppState, kbId: Uuid, spec: AttributeAdoption): Promise<AttributeAdopted> {
  // Pull the facts to rewrite first: they decide both the domain and
  // whether the value can convert.
  const facts = await store.graph.value_facts_for_forms(state.sql, kbId, spec.forms);
  let attributeId: Uuid;
  if (spec.existing) {
    const found = await store.ontology.relation_type_id_by_key(state.sql, kbId, spec.key);
    if (!found) throw AppError.invalid("unknown_relation_key", "no relation type with that key");
    attributeId = found;
  } else {
    // **Domain comes from the data.** An attribute must declare which
    // classes it can attach to, and a wrong guess has a hard cost — a
    // subject whose type does not match gets the whole fact dropped.
    // These facts' subjects' current type is a fact, not a judgment.
    const domains = [...new Set(facts.map(([, typeId]) => typeId))].sort();
    if (domains.length === 0) {
      throw AppError.invalid("no_facts_for_forms", "nothing is waiting on those wordings");
    }
    attributeId = await store.ontology.create_relation_type(
      state.sql,
      kbId,
      spec.key,
      spec.label,
      "state",
      // The proposer does not decide axioms on the temporal engine's or
      // the reasoner's behalf: `functional` would drive automatic closure
      // of old values, and the rest drive consistency checking — both
      // should be declared explicitly by a person.
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
      spec.description,
      "attribute",
      domains,
      [],
      spec.datatype,
      spec.unit,
    );
  }

  // Conversion follows the datatype ALREADY IN the ontology row, not the
  // request — pointing at an existing attribute means the request has no
  // datatype at all, and even if it did, the ontology has the final say.
  const datatype = (await store.ontology.relation_type_datatype(state.sql, attributeId)) ?? "text";
  const rewrites: [Uuid, unknown][] = [];
  let unconvertible = 0;
  for (const [factId, , objectValue] of facts) {
    // Extraction writes the shape {"value": ...}; pull that inner layer out to convert.
    const raw =
      objectValue && typeof objectValue === "object" && "value" in (objectValue as Record<string, unknown>)
        ? (objectValue as Record<string, unknown>).value
        : objectValue;
    const converted = normalizeAttrValue(datatype, raw);
    if (converted !== undefined && converted !== null) {
      rewrites.push([factId, { value: converted }]);
    } else {
      // Not rewritten when it cannot convert: better to leave it without
      // a predicate for next time than force an inconvertible value into a typed attribute.
      unconvertible += 1;
    }
  }
  const [batchId, remapped] = await store.graph.adopt_value_facts(state.sql, kbId, attributeId, rewrites);
  for (const form of spec.forms) {
    await store.ontology.clear_miss(state.sql, kbId, "attribute_type", form);
  }
  return { attribute_id: attributeId, batch_id: batchId, remapped, unconvertible };
}

/** Maps to an EXISTING attribute: builds nothing, only attaches these wordings' literal facts. */
export async function adoptAttributeExisting(state: AppState, kbId: Uuid, key: string, forms: string[]): Promise<[Uuid, number]> {
  const done = await adoptAttributeCore(state, kbId, {
    key,
    label: "",
    description: "",
    datatype: "text",
    unit: null,
    forms,
    existing: true,
  });
  return [done.batch_id, done.remapped];
}

/** The automatic cold-start path's entry point. Arguments are spread out rather than an `AdoptReq` — that struct is an HTTP request body, and the automatic path has no request. */
export async function adoptAttributeAuto(
  state: AppState,
  kbId: Uuid,
  key: string,
  label: string,
  description: string,
  datatype: string,
  unit: string | null,
  forms: string[],
): Promise<[Uuid, number]> {
  const done = await adoptAttributeCore(state, kbId, {
    key,
    label,
    description,
    datatype,
    unit,
    forms,
    existing: false,
  });
  return [done.batch_id, done.remapped];
}

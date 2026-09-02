/**
 * Type resolution: fix an entity's type — **both narrow it, and correct a
 * wrong guess.**
 *
 * At first this only did the second half: extraction gives a coarse type,
 * and resolution refines it toward a descendant. Once extraction began
 * retrieving candidates per chunk, it started picking specific types on
 * its own — and picking wrong ones too (observed: "Shaoxing" to
 * `address`, "chronic disease management mini-program" to
 * `entry_point`). The right answer there is a **sibling** of the wrong
 * type, not a descendant of it, and the old "candidate must be narrower"
 * rule (written into this module's own prompt) blocked it at the door.
 *
 * Both directions are accepted now. A correction is always treated as
 * crossing an axis, so it always goes to a human: overturning extraction's
 * judgment is riskier than refining it, and should not happen
 * automatically.
 *
 * Since decision 0009 there is a third kind of input, and it is the most
 * common one: **no type at all yet.** Once the fallback type was removed,
 * an entity the ontology has no room for gets `type_id IS NULL` instead of
 * being stuffed into a generic bucket. This tier carries no "extraction's
 * judgment" to overturn — giving it a type is filling a gap, not
 * reclassifying — so it does **not** count as crossing an axis, and a
 * high-confidence verdict is written straight to the database. Otherwise
 * removing the fallback type would cost a human look at every single
 * entity.
 *
 * **Why this can happen after the fact, while a predicate cannot** (the
 * asymmetry in decision 0001): a type is an annotation hanging off a node,
 * and can wait until enough evidence has piled up; a predicate is the fact
 * itself — `(NVIDIA, ?, Mellanox)` is not a fact at all. So a predicate is
 * "record the original word, map it later", while a type is "coarse
 * first, precise later".
 *
 * What resolution has to work with is quite different from what
 * extraction has in the moment:
 *
 * 1. **`proposed_type`** — the type name the model itself reported at
 *    extraction time, kept only when the vocabulary had nothing for it.
 *    The strongest signal, because the task turns from "understand what
 *    this is" into "which ontology class is called this".
 * 2. **The entity's profile** — every predicate it takes part in,
 *    accumulated across documents.
 * 3. **Evidence quotes** — the same sentences, but gathered together, and
 *    not competing for attention with dozens of other entities.
 *
 * Candidates come from **two paths**, taken as a union, never merged into
 * one score: one searches the profile against class descriptions; the
 * other searches a context vector against already-typed entities and
 * treats their types as votes. The second path sidesteps the first path's
 * weak point (a Chinese profile against an English boilerplate
 * description), and gets more accurate as the KB grows. The two paths'
 * distances live in different spaces — one in class space, one in entity
 * space — merging them into one ranking would be self-deception, and in
 * fact even one path's own distances are not comparable across entities.
 *
 * The coarse type's descendants are **ranked first, but are not the only
 * choice** — two ontologies' classification axes often do not line up
 * (schema.org hangs software under CreativeWork, while extraction's
 * coarse type is `product`). The decision to say no belongs to
 * adjudication, which can see both the description and the coarse type.
 */

import type { AppState } from "./state";
import * as store from "./store";
import { chatClient } from "./llm_util";
import { AppError } from "./core/errors";
import type { Uuid } from "./core/ids";
import { jsonBlock } from "./extract";
import * as ontologyIndex from "./ontology_index";
import { TypeKind, type TypeCandidate } from "./store/ontology";
import type { TypeCandidateSubject } from "./store/resolution";

/** How many entities to look at in one round. Enough for a human to review, and enough to tell whether retrieval is accurate. */
const BATCH = 60;
/**
 * How many candidates to retrieve per entity.
 *
 * **Retrieval's job is to surface candidates; it is not adjudication's
 * job to say no.** So it errs toward surfacing more — adjudication can see
 * the description and the current type and say "none of these fit";
 * whatever retrieval misses, adjudication can never reach no matter how
 * good it is.
 */
const CANDIDATES = 10;
/** How many already-typed neighbors to look at. Too few and there are not enough votes; too many and the tail is all noise. */
const NEIGHBOURS = 10;

/** One entity's resolution suggestion (for preview; does not write). */
export interface TypeSuggestion {
  entity_id: Uuid;
  name: string;
  /** The type currently attached, which may be absent (decision 0009). */
  coarse: string | null;
  /** The current type's description. Adjudication needs this to judge "is the current type right" — the key alone is not enough. */
  coarse_description: string | null;
  coarse_id: Uuid | null;
  proposed_type: string | null;
  specific_type: string | null;
  fact_count: number;
  /** The text sent for retrieval. Returned to the caller: when retrieval finds nothing, this is the first thing worth checking. */
  profile: string;
  /** First path: profile -> class description. */
  candidates: TypeCandidate[];
  /** Second path: context-similar already-typed entities, voted by class. */
  neighbours: NeighbourVote[];
  /** All of the coarse type's descendants. Adjudication uses this to grade the verdict. */
  descendants: Set<Uuid>;
}

/**
 * One class a neighbor search voted for.
 *
 * **Not merged into one ranking with `candidates`**: the two paths'
 * distances live in different spaces (class space vs entity space) and are
 * not comparable — and in fact even one path's distances are not
 * comparable across entities. The union is left to adjudication, each
 * candidate labeled with its source.
 */
export interface NeighbourVote {
  key: string;
  /** How many neighbors carry this class. */
  votes: number;
  /** How close the nearest of those neighbors is. */
  best_distance: number;
  /** The voting entities' names, for a human to read as evidence. */
  examples: string[];
  /**
   * Whether these neighbors all come from the same batch of documents.
   * If so, this vote is discounted: an entity seen only once has a
   * context vector equal to that one chunk's vector, and entities in the
   * same document naturally become each other's neighbors — that is not
   * type evidence.
   */
  same_document_only: boolean;
}

/**
 * Computes only, writes nothing: the profile and candidates for each
 * entity awaiting resolution.
 *
 * Kept as its own step on purpose — before spending effort building
 * adjudication, first answer "can retrieval even find anything". If it
 * cannot, no amount of good adjudication helps.
 */
export async function preview(state: AppState, kb_id: Uuid): Promise<TypeSuggestion[]> {
  // Only tops up the class half: this step never touches relations, and a
  // large ontology can have well over a thousand of those.
  await ontologyIndex.refreshScoped(state, kb_id, TypeKind.Entity);

  const subjects = await store.resolution.entities_for_type_resolution(state.sql, kb_id, BATCH);
  if (subjects.length === 0) return [];

  // **Two queries per entity, not one.**
  //
  // The model's own wording leads the profile, but the rest of it is
  // context, and goes into the same vector. Observed: "Hangzhou Gongshu
  // District"'s profile was `district. Hangzhou Gongshu District.
  // located_in by Renhetang Pharmacy Chain. Renhetang Pharmacy Chain
  // opened its 40th store in Hangzhou Gongshu District` — the whole
  // passage is about the pharmacy, so the candidates came back pharmacy,
  // store, and `administrative_area` never once appeared. The name got
  // diluted into the paragraph.
  //
  // So the name is sent on its own too: a short query against a short
  // label is exactly the shape this index is good at. The profile query
  // still goes out as well, covering entities with no `specific_type` and
  // ones that need context to judge. The two result sets are unioned —
  // one extra embedding call, in exchange for eliminating a whole class of
  // missed retrieval.
  const profiles = subjects.map(profileOf);
  const names = subjects.map(nameQueryOf);
  const nameQueries = names.filter((n): n is string => n !== null);

  const [profileHits, nameHits] = await Promise.all([
    ontologyIndex.nearestForEach(state, kb_id, profiles, CANDIDATES * 4, { kind: "class" }).catch(() => []),
    ontologyIndex
      .nearestForEach(state, kb_id, nameQueries, CANDIDATES * 4, { kind: "classLabel" })
      .catch(() => []),
  ]);

  // Each entity's index into the two result sets: (profile, name). The
  // name path only sent a query for entities with wording, so its index
  // is counted separately.
  const slots: [number, number | null][] = [];
  let ni = 0;
  for (let pi = 0; pi < names.length; pi++) {
    if (names[pi] !== null) {
      slots.push([pi, ni]);
      ni += 1;
    } else {
      slots.push([pi, null]);
    }
  }

  const out: TypeSuggestion[] = [];
  for (let i = 0; i < subjects.length; i++) {
    const s = subjects[i]!;
    // The coarse type's descendants **come first, but are not the only
    // choice** — the old hard gate (descendants only) blocked 4 of 17
    // correct answers in measurement: schema.org hangs both
    // SoftwareApplication and Periodical under CreativeWork, while
    // extraction's coarse type was product/organization — the two
    // classification axes simply do not line up, and a hard gate locks
    // the correct answer out permanently. The lesson is the same as
    // `part_of`: **a signature is a hint, not a gate**; systematically
    // losing data costs more than an occasional wrong judgment.
    //
    // The decision to say no belongs to adjudication: it can see the
    // description and the coarse type and say "this is not it". An
    // entity with no type yet has no "coarse type's descendants" axis to
    // use (0009); every class is a candidate, and order is pure
    // retrieval order.
    const descendants = new Set<Uuid>(
      s.coarse_id !== null ? await store.resolution.descendants_of(state.sql, kb_id, s.coarse_id) : [],
    );

    // **The two paths alternate; they are not merged by distance.**
    //
    // Distance is not comparable across the two paths: a short query
    // ("pharmaceutical group") produces systematically smaller distances
    // than a whole profile, so sorting by distance alone lets the name
    // path dominate the top ranks. Alternating gives each path half the
    // slots, so distance magnitude no longer decides who is seen.
    const [pi, niIdx] = slots[i]!;
    const lists: TypeCandidate[][] = [profileHits[pi] ?? []];
    if (niIdx !== null) lists.push(nameHits[niIdx] ?? []);
    const seenIds = new Set<Uuid>();
    const ranked: TypeCandidate[] = [];
    const longest = Math.max(...lists.map((l) => l.length), 0);
    for (let rank = 0; rank < longest; rank++) {
      for (const list of lists) {
        const c = list[rank];
        if (!c) continue;
        if (c.id === s.coarse_id || seenIds.has(c.id)) continue;
        seenIds.add(c.id);
        ranked.push(c);
      }
    }
    const candidates = ranked.slice(0, CANDIDATES);

    // Second path: context-similar already-typed entities, voted by class.
    const raw = await store.resolution.nearest_typed_entities(state.sql, kb_id, s.id, NEIGHBOURS);
    const votes = new Map<string, { votes: number; best_distance: number; examples: string[]; same_document_only: boolean }>();
    for (const [name, , key, distance, sameDoc] of raw) {
      const slot = votes.get(key) ?? { votes: 0, best_distance: distance, examples: [], same_document_only: true };
      slot.votes += 1;
      slot.best_distance = Math.min(slot.best_distance, distance);
      if (slot.examples.length < 3) slot.examples.push(name);
      slot.same_document_only = slot.same_document_only && sameDoc;
      votes.set(key, slot);
    }
    const neighbours: NeighbourVote[] = [...votes.entries()]
      .filter(([key]) => key !== s.coarse_key)
      .map(([key, v]) => ({ key, ...v }))
      .sort((a, b) => b.votes - a.votes || a.best_distance - b.best_distance);

    out.push({
      entity_id: s.id,
      name: s.canonical_name,
      coarse: s.coarse_key,
      coarse_description: s.coarse_description,
      coarse_id: s.coarse_id,
      proposed_type: s.proposed_type,
      specific_type: s.specific_type,
      fact_count: s.fact_count,
      profile: profiles[i]!,
      candidates,
      neighbours,
      descendants,
    });
  }
  return out;
}

interface Verdict {
  id?: number | null;
  name: string;
  choice?: string | null;
  confidence?: number | null;
  reason?: string | null;
}

/**
 * Below this line, always send to a human, no matter where it lands.
 *
 * **This is not the main criterion for the gray zone**: measurement
 * showed the model's self-reported confidence is bimodal — 15 answers all
 * >= 0.85, 4 null, nothing in between. Self-reported confidence is a
 * writing style, not a probability; the model picks a number that matches
 * its own tone. Using it as the main gate would gate nothing. The real
 * tiering criterion below is "did this cross a classification axis" —
 * this line only catches the occasional low score.
 */
const AUTO_THRESHOLD = 0.85;

export interface ReviewItem {
  entity_id: Uuid;
  name: string;
  coarse: string | null;
  from_type_id: Uuid | null;
  to_type_id: Uuid;
  choice: string;
  confidence: number;
  reason: string | null;
  crosses_axis: boolean;
}

export interface DeclineNote {
  name: string;
  coarse: string | null;
  specific_type: string | null;
  reason: string | null;
  top_candidate: string | null;
}

export interface ResolutionOutcome {
  batch: Uuid | null;
  retyped: number;
  for_review: ReviewItem[];
  left_alone: DeclineNote[];
}

/**
 * Runs one round of type resolution and writes results.
 *
 * **No actor is recorded, even though a human clicked "run".**
 * `retype_entities`'s actor argument now serves two purposes at once: who
 * gets credited in the ledger, and (since it now also decides
 * `type_source`) whether the engine will ever touch this entity again — an
 * actor means `human`, and `human` means the engine stops here forever.
 *
 * These are two different questions:
 *
 * | | who triggered it | who decided what this entity is |
 * |---|---|---|
 * | manual entity edit | a person | a person |
 * | approve a type pair + name an entity | a person | a person |
 * | **run one resolution round** | a person clicked run | **the engine** |
 *
 * Passing a user for the third row would claim "a person judged this
 * class", and every entity ever touched by a resolution run would become
 * permanently un-resolvable again. Who clicked run is recorded in the
 * `ontology.types_resolved` audit entry, with the batch id, and can be
 * looked up there.
 */
export async function resolve(state: AppState, kb_id: Uuid): Promise<ResolutionOutcome> {
  const all = await preview(state, kb_id);
  const items = all.filter((i) => i.candidates.length > 0 || i.neighbours.length > 0);
  if (items.length === 0) {
    return { batch: null, retyped: 0, for_review: [], left_alone: [] };
  }

  const kb = await store.kbs.get(state.sql, kb_id);
  const settings = await store.settings.get(state.sql, kb.workspace_id);
  if (!settings) throw AppError.invalid("no_chat_model", "Chat model not configured");
  const client = chatClient(settings);
  if (!client) throw AppError.invalid("no_chat_model", "Chat model not configured");

  const reply = await client.chat([{ role: "user", content: adjudicationPrompt(items) }]);
  const block = jsonBlock(reply);
  const parsed = JSON.parse(block) as { verdicts?: Verdict[] };
  const verdicts = parsed.verdicts ?? [];

  // Name -> index **list**, not a single one. Untyped entities can share
  // a name (0009), and collapsing to one entry would leave several of
  // them without a verdict forever. A verdict prefers `id`; the name is
  // only the fallback when the model omits it.
  const byName = new Map<string, number[]>();
  items.forEach((it, i) => {
    const list = byName.get(it.name) ?? [];
    list.push(i);
    byName.set(it.name, list);
  });

  // Pairs already approved by a human: the same pair does not go to
  // review again. Crossing an axis is about the two classes, and an
  // entity only happens to be the one that raised it — the second city
  // should not be asked again.
  const approved = await store.resolution.approved_refinements(sql, kb_id);

  const picks: [Uuid, Uuid][] = [];
  const forReview: ReviewItem[] = [];
  const leftAlone: DeclineNote[] = [];
  const decided = new Set<number>();

  const decline = (item: TypeSuggestion, reason: string | null): DeclineNote => ({
    name: item.name,
    coarse: item.coarse,
    specific_type: item.specific_type,
    reason,
    top_candidate: item.candidates[0]?.key ?? null,
  });

  for (const v of verdicts) {
    // Prefer id; fall back to name when omitted, taking the first
    // **not-yet-decided** entry under that name. An out-of-range id
    // counts as not given — the model occasionally makes one up.
    let idx: number | undefined;
    if (v.id !== null && v.id !== undefined && v.id < items.length) idx = v.id;
    else idx = byName.get(v.name)?.find((i) => !decided.has(i));
    if (idx === undefined) continue;
    // Only the first verdict for a given entry counts. A repeated answer
    // would push the same entity_id into picks twice, colliding on the
    // primary key at write time.
    if (decided.has(idx)) continue;
    decided.add(idx);
    const item = items[idx]!;

    // **The string "null" is also null.** The model sometimes gives a
    // JSON null, sometimes the four letters; looking that up as a key
    // would never find a candidate, and this would get recorded as
    // "chose a key outside the candidates" — a made-up rejection reason
    // covering up the one the model actually gave. The rejection reason
    // is the single most important output of this step; corrupting it
    // with our own parsing is worse than having none.
    const choiceRaw = v.choice?.trim();
    if (!choiceRaw || choiceRaw.toLowerCase() === "null" || choiceRaw.toLowerCase() === "none") {
      leftAlone.push(decline(item, v.reason ?? null));
      continue;
    }
    // Only an answer from the candidate list counts. An answer outside
    // it is not "a better judgment" — it is the model writing a
    // schema.org name from memory, which may not even be in this
    // ontology.
    const target = item.candidates.find((c) => c.key === choiceRaw);
    if (!target) {
      leftAlone.push(decline(item, `chose ${choiceRaw}, which is not among the candidates`));
      continue;
    }
    const confidence = v.confidence ?? 0;
    // **Tiering looks at whether a classification axis was crossed, not
    // the model's self-reported number.**
    //
    // Inside the coarse type's subtree = refining one step down,
    // extraction's judgment stands, auto-apply. Outside it = a different
    // classification axis (something judged `product` landed under
    // `CreativeWork`), which is a reclassification, not a refinement, and
    // deserves a human look.
    //
    // **A correction goes through here too, and naturally so**: once
    // extraction picks a wrong specific type ("Shaoxing" -> `address`),
    // the correct answer is its sibling, not its descendant, so it is
    // always judged as crossing an axis and always goes to review — which
    // is exactly the point: overturning extraction's judgment is riskier
    // than refining it, and must not happen automatically.
    //
    // **An entity with no type yet does not count as crossing an axis**
    // (0009): it carries no "extraction's judgment" to overturn; giving it
    // a first type is filling a gap, not reclassifying. Judging this as
    // crossing an axis would mean, after removing the fallback type,
    // every single entity needs a human look — defeating the whole
    // automation.
    const crossesAxis =
      item.coarse_id !== null
        ? !item.descendants.has(target.id) && !approved.has(`${item.coarse_id}:${target.id}`)
        : false;
    if (confidence >= AUTO_THRESHOLD && !crossesAxis) {
      picks.push([item.entity_id, target.id]);
    } else {
      forReview.push({
        entity_id: item.entity_id,
        name: item.name,
        coarse: item.coarse,
        from_type_id: item.coarse_id,
        to_type_id: target.id,
        choice: choiceRaw,
        confidence,
        reason: v.reason ?? null,
        crosses_axis: crossesAxis,
      });
    }
  }
  // Entities the adjudication never mentioned also count as "left
  // untouched", or the three tiers would not add up to the total.
  items.forEach((item, i) => {
    if (!decided.has(i)) leftAlone.push(decline(item, null));
  });

  let batch: Uuid | null = null;
  let retyped = 0;
  if (picks.length > 0) {
    const [b, n] = await store.resolution.retype_entities(sql, kb_id, picks, null);
    batch = b;
    retyped = n;
  }
  return { batch, retyped, for_review: forReview, left_alone: leftAlone };
}

/**
 * The adjudication prompt.
 *
 * **"None of these" must be a respectable answer.** This is the opposite
 * of the `related_to` escape hatch: there, the fallback destroyed
 * information, so it was removed; here, keeping the coarse type loses
 * nothing — the entity and its facts stay exactly where they are, just not
 * more specific. Forcing the model to always pick from the candidates
 * buys a batch of confident mistakes that never show up on a timeline and
 * are hard to notice.
 */
function adjudicationPrompt(items: TypeSuggestion[]): string {
  const blocks: string[] = [];
  // **The index is the key, the name is not** (0009). Untyped entities
  // can share a name; one KB was measured to have 4 entities named "Zhang
  // Wei" — matching by name would collapse them into one.
  items.forEach((it, i) => {
    const current =
      it.coarse !== null
        ? it.coarse_description && it.coarse_description.trim() !== ""
          ? `${it.coarse} (${it.coarse_description.trim()})`
          : it.coarse
        : "not yet typed";
    const lines: string[] = [
      `### [${i}] ${it.name}\ncurrently: ${current}\nthe extractor called it: ${it.specific_type ?? "-"}\nseen as: ${it.profile.slice(0, 200)}`,
      "candidates:",
    ];
    for (const c of it.candidates) {
      const d = c.description.trim();
      lines.push(d === "" ? `- ${c.key} (${c.label})` : `- ${c.key}: ${d}`);
    }
    if (it.neighbours.length > 0) {
      const n = it.neighbours
        .slice(0, 3)
        .map((nb) => `${nb.key} (like ${nb.examples.join(", ")})`)
        .join("; ");
      lines.push(`similar entities are typed: ${n}`);
    }
    blocks.push(lines.join("\n"));
  });

  return (
    "You are fixing entity types in a knowledge graph. Each entity below has a type it was " +
    "given during extraction, and a list of candidate types retrieved from the ontology.\n" +
    "\n" +
    "For each entity choose ONE candidate key, or null. There are two reasons to choose " +
    "a candidate, and they are different:\n" +
    "\n" +
    "**Narrowing** — the current type is right but broad, and a candidate says the same " +
    "thing more precisely (organization -> hospital).\n" +
    "\n" +
    "**Correcting** — the current type is simply wrong, and a candidate is right. This " +
    "happens because extraction picks from a retrieved shortlist and can pick badly: a city " +
    "typed as an address, an app typed as an entry point. A correcting candidate is " +
    "usually a sibling of the current type rather than a narrower version of it, so do not " +
    "withhold it on the grounds that it is not more specific. Say plainly in the reason " +
    "that the current type is wrong; a person will see this one before it is applied.\n" +
    "\n" +
    "Choose null whenever any of these hold, and expect null to be a common answer:\n" +
    "- no candidate actually means the thing (the list is retrieved by similarity, so it " +
    "usually contains near-misses and sometimes contains nothing right at all);\n" +
    "- the current type is already right and no candidate is more precise;\n" +
    "- the entity is not a thing of that kind at all — a quantity, a capability, a phrase.\n" +
    "Keeping the current type loses nothing: the entity and its facts stay exactly as they " +
    "are. Picking a wrong type is worse than picking none, because it reads as a decided " +
    "fact.\n" +
    "\n" +
    "confidence is your own 0~1: use above 0.85 only when the candidate's definition " +
    "plainly describes this entity, not when it is merely the closest of a weak list.\n" +
    "\n" +
    "reason is required on every verdict, including the nulls — especially the nulls. " +
    "When you choose null, say which candidate came closest and what it got wrong " +
    '("nearest was publication_issue, but that is one issue of a journal, not the ' +
    'journal"). A refusal without a reason cannot be acted on: nobody can tell whether ' +
    "the ontology is missing the class, or the search failed to surface it, or you read " +
    "the entity differently.\n" +
    "\n" +
    `${blocks.join("\n\n")}\n` +
    "\n" +
    "id is the number in the heading, and it is what identifies the verdict — not the " +
    "name. Two entries can carry the same name and still be different things (two people " +
    "called Zhang Wei, each with their own facts); judge each one on its own block and " +
    "give one verdict per id you answer. Never merge two ids into one verdict.\n" +
    "\n" +
    "Output exactly one JSON object:\n" +
    '{"verdicts":[{"id":0,"name":"entity name exactly as given","choice":"candidate key or null","confidence":0.0,"reason":"one short clause"}]}'
  );
}

/**
 * The name-only query: the model's own wording, nothing else.
 *
 * **Sent separately to avoid dilution.** In the profile query these words
 * lead, but the rest of the passage goes into the same vector, and that
 * passage is often about someone else. Returns `None` when neither wording
 * exists: a query with only the entity's name would be identical to the
 * start of the profile query, and sending it again wastes an embedding.
 */
function nameQueryOf(s: TypeCandidateSubject): string | null {
  const parts = [s.specific_type, s.proposed_type]
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter((x) => x !== "");
  return parts.length > 0 ? parts.join(". ") : null;
}

/**
 * Entity profile: the text sent for vector retrieval.
 *
 * **The model's own reported type name leads.** It is the strongest
 * signal, and retrieval matches against a class's `label + description` —
 * a class name against a class definition is much closer than a string of
 * predicates against a class definition.
 *
 * Name and aliases come next; predicates and quotes trail as context.
 */
function profileOf(s: TypeCandidateSubject): string {
  const parts: string[] = [];
  for (const named of [s.specific_type, s.proposed_type]) {
    const p = named?.trim();
    if (p) parts.push(p);
  }
  parts.push(s.canonical_name);
  if (s.aliases.length > 0) parts.push(s.aliases.join(", "));
  if (s.roles.length > 0) parts.push(s.roles.join(" "));
  for (const q of s.quotes.slice(0, 2)) {
    parts.push([...q].slice(0, 120).join(""));
  }
  return parts.join(". ");
}

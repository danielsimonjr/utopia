# 0012 · The ontology is a contract, not a suggestion

**Status**: Implemented, based on five rounds of paired experiments. Violation rate dropped from 57% to 4%; true reversed facts dropped from 39 to 0. All three "to do" items at the end are still not done. Since this document, the ontology can also declare `inverseOf` and `subPropertyOf` (#177, #179), consumed by the reasoning engine; the pack list grew to five, though these experiments cover only the first two (checked 2026-09-02).

[0008](0008-ontology-packs-as-cold-start.md) built ontology packs, but the question they were meant to answer — **does a large ontology actually help** — had never been tested. Every base with a pack installed was a 5-document, 26-fact benchmark run, measuring prompt overhead, not quality. This document is the first to ask that question on real text.

The answer splits in two: **vocabulary size really does capture more, and not one declared constraint was actually enforced.**

## First: the pack's benefit is real

`ai-timeline-ends` (6 Wikipedia articles) with schema.org plus W3C Org (1,655 relations, 973 types), **zero seeds** (after #125 and #128, creating a base seeds no relation at all):

- 215 facts with a predicate, across 41 distinct relations, **all sourced from the pack** — auto-extend grew zero of them
- Empty predicates: 25.6% (historically, with 10 seed relations, `related_to` reached 55.5%)

## Second: but direction was written in reverse

```
Elon Musk (person) --employee--> Microsoft
```

While schema.org declares `employee (organization → person)`. **Of 130 checkable facts, 102 were stored backward like this.**

This is exactly the reasoning behind choosing schema.org failing to hold — `ontology_packs.rs` states: "1,488 properties carry domain and range; direction is **declared**, not just described." It was declared, and then nothing enforced it.

And it is far worse than an empty predicate: **an empty predicate is honest silence; a reversed edge is a confident mistake.** The graph states that Musk employed Microsoft, and 0002 already noted the reasoning engine amplifies defects — this is exactly the kind of input it would amplify.

## Third: one root cause, two symptoms

Digging in, wrong types and reversed direction turned out to be two faces of the same problem:

```
#128 removed seed types → seed_classes is empty (it read only builtin types)
        ↓
Retrieval favors leaf types that appear literally in the source text
(in a chunk about Sutskever, out of 976 types, researcher ranked 4th, person 359th, organization 795th)
        ↓
   ┌──────────────────────┬──────────────────────────┐
An entity is typed researcher      The employee signature degrades to (* → *)
(in schema.org it is a subtype       (sig_of only recognizes listed types;
 of Audience, not of person)          if one side is not listed, it writes *)
```

A comment in `build_lists` already stated this floor: "**seed types always present** — a chunk retrieval misses still needs somewhere to land, or the model has no type to choose from." Once seeds were retired, this rule lost its footing — **it had only worked by coincidence, because the seed types happened to be exactly the general-purpose ones.**

## Fourth: five rounds of experiments

Same corpus, same ontology, changing one variable per round, all runs over 60/60 chunks:

| Variant | Facts | Empty predicate | Checkable | Violations | **True reversals** | Violation rate |
|---|---|---|---|---|---|---|
| Prompt wording only | 429 | 138 | 172 | 98 | 39 | 57.0% |
| + ancestor floor | 451 | 138 | 181 | 63 | 31 | 34.8% |
| + always-list-signature-types | — | — | — | — | 26 | 37.2% |
| + correct direction against the base's real types | 447 | 139 | 179 | **0** | **0** | 29.6% |
| + stem-based merging + silence when not applicable | 447 | 179 | 149 | **6** | **0** | **4.0%** |

(The third row stopped at 41/60 chunks — the server was killed mid-run; only the rate is meaningful.)

### What prompt wording can and cannot fix

The first version merged two different ideas into one instruction, "hint, not a rule — when the text says otherwise, write what the text says," so the model also applied this to argument order, following the source's phrasing there too. The two ideas differ completely in how overridable they should be:

- **Which types can take part**: a hint, not a gate. The ontology can be wrong; if the source says Seattle, write Seattle. [0001](0001-ontology-import-and-governance.md)'s judgment holds unchanged here — a hard gate discards data systematically, the same way `part_of` burned us before.
- **Argument order**: set by the signature. **Order is not a claim about the world, it is an encoding convention for this key**; the source text never "states a different direction" — it only states that some relationship exists between two entities.

Wording changes did help, but **they were not the main driver**: three rounds of prompt wording brought the violation rate from 57% to 35%, and the drop came **entirely from the wrong-type half of the problem** — true reversals barely moved (22.7% → 17.1% → 17.6%, with the last two indistinguishable from noise).

**The model can see the signature and still not follow it** — the English phrase "X is an employee of Y" is too strong a pull. More wording will not win this.

### So direction gets corrected at write time

When the subject fails the domain check **but the object passes it**, swap subject and object to match the signature.

This is not a new principle: when `produced_by` matches `produces` (#109), subject and object were already swapped automatically — the only difference is whether the trigger is **wording** or **a signature**.

The original objection to automatic correction was that entity types were unreliable — Elon Musk was measured as being typed `researcher`. **That premise stopped holding once the ancestor floor was fixed**; the same batch then typed him `person`.

Type is **read from the entity stored in the base**, not from the extractor's own `entity_type_of` map — that map only covers entities the model declared within this one chunk, while the object is often an entity that already exists elsewhere. **This one difference is why reversed facts dropped from 10 to 0.**

**Never silent**: every correction writes a `direction_corrected` marker. 0001's objection was to "letting a declaration that might be wrong drive an **automatic action**" — a logged, traceable action does not belong to that category. Of 29 corrections, 1 was wrong (`spatial`, where schema.org's own domain for it is genuinely ambiguous) — this is an inherent cost of the mechanism: **it trusts the ontology's declaration, and a declaration can fail to apply to this specific pair.**

### A relation that does not apply should go silent

When swapping still does not make the fact legal, it used to be stored as-is anyway — which meant **using the ontology's authority to state something the ontology itself disagrees with**:

```
OpenAI --affectedBy--> …          schema.org's affectedBy is a medical-test term
Mistral --amount--> €105 million  amount belongs to a financing instrument, not a company
Anthropic --competitor--> OpenAI  schema.org's competitor is a SportsEvent property
```

Now the predicate is dropped, keeping subject, object, time, and evidence, with the original word kept in `fact_evidence.proposed_predicate`, recovered for display by `fact_surface_predicate()` ([0010](0010-no-relation-is-no-relation.md)). Checked for silent data loss: **of the 179 facts returned to an empty predicate, all 179 still had their original wording recoverable.**

## Fifth: what remains is not an extraction error

- **A gap in modeling with intermediate nodes** (`amount` 13, `target` 8, `participant` 5): schema.org models these through an intermediate node (Action, LoanOrCredit, Offer); our model uses flat binary relations.
- **Reused, ambiguous names** (`affected_by`, `competitor`, `uses_device`): the pack contains many generically named, narrowly scoped terms, and picking by name or vector similarity will inevitably collide with them — the same root cause behind `Researcher` being used to label a person.

**Both belong to the real cost of using an ontology pack**, and 0008 should record it: **a pack's cost is not prompt length, it is the difficulty of choosing.**

### Why we did not adopt a stronger modeling language

The data model **already supports** intermediate nodes — `entities` plus `facts` is already a property graph, and `[a funding round] --amount--> €105M` can already be stored; the base already holds 10 `event` entities and 9 `monetary_amount` entities. Expressiveness is not the blocker.

The real blocker is **prompt rules 1 and 2**: "use the canonical full name as written in the text" and "every fact's subject and object must appear in `entities`." A funding round often **has no name at all** in the source text — satisfying the signature would mean inventing an entity out of nothing, while the prompt spends its entire length teaching the model not to do exactly that. **The model's behavior here is correct.**

Supporting real reification means changing the foundation of those two rules, and also designing a naming and deduplication scheme for nameless nodes (how do two mentions of the same funding round, in two different articles, get recognized as one, with no name to compare?) — that is a new problem for entity resolution.

The real test should be **whether a qualifier itself needs to be queryable**: "which companies had a Series A round in 2024 led by General Catalyst" — "led by" attaches to the funding round itself. **That kind of question cannot be answered today, and that gap is the signal that should drive this work** — not "schema.org models it this way, so we should too."

## Sixth: two more fixes along the way

**A leading light verb should not count as a real difference**: `has_funding` and `funding` are the same relation. Measured among empty-predicate facts: `has_funding` failed to match ×4 even though the ontology has `funding`; `product` failed to match ×2 even though the ontology has `has_product`. Merging too aggressively here carries little risk — a bad merge just fails cleanly and falls back to "no match," nothing worse.

**A whole sentence should not be treated as an entity name.** Measured: of 421 entities, 76 had no type, and the longest name, at 111 characters, was a full subordinate clause. A guard already existed (`continue` past 100 characters), but **it only ran on the path for declared entities** — an undeclared subject or object skipped straight to `resolve()` and created an entity anyway. **The front door was locked; the back door was open.** And that `continue` was silent — exactly the kind of case `drop_signal` was built to catch, one of seven such places.

The rule changed to **word count plus a finite verb**, instead of a character count: "US District Court for the Northern District of California" (57 characters) is a real entity; "removal was driven by growing discontent and distrust with Altman" (65 characters) is a clause — character count cannot tell them apart, **a finite verb can.**

Result: the longest entity name dropped from 111 to 57 characters (the 57-character one is that same court), and untyped entities dropped from 76 to 60. Everything the guard blocked was a real sentence; nothing legitimate was caught by mistake.

**Isolated entities (with zero facts attached) rose from 14.0% to 17.5%, but this cannot be credited to the guard**: the guard blocked only a handful of entities total, while isolated entities grew by 14 — more likely run-to-run variance (model output differs between runs even on identical input, and this run also restarted mid-way, causing a reclaimed document to be re-extracted whole). The real cause of isolated entities is a separate issue — **the model declared an entity in `entities` but produced no fact using it** — the isolated list contains legitimate entities like a court, the SEC, and Tesla's headquarters. This ratio deserves its own record, but it is unrelated to this guard.

## To do

- **A write-time guard cannot catch a change made after the fact**: merging two entities can replace a subject with an entity of a different type, turning a fact into a violation after the fact. 4 of 6 remaining violations trace to this. Fixing it means putting the same check inside the merge path too. (Still not done: `merge_entities` only retires mutually-referencing facts, redirects subject/object, and deduplicates by SPO — it never re-checks domain or range.)
- The other 2 remaining violations (`Stability AI Ltd`, `Colossus 2 data center`) involved no merge and no retype — **the cause is still unknown.**
- When importing an ontology pack, filter out relations that only make sense with an intermediate node (whose domain is entirely reification shells like `Action`, `Offer`, or `LoanOrCredit`) — listing them for the model only produces violations. (Still not done.)
- **(Added 2026-09-02)** The module comment at the top of `bootstrap_ontology.rs` still states "a new base has only 10 default relations … downgrades to related_to" — describing a world that ended three retirements ago. Outside the scope of this document, but from the same line of work, and it should be fixed.

# 0011 · "How to compute it" is not "what exists"

- **Status**: Implemented. The table exists and is wired up (#126, in the same commit as this document), a standalone data-mapping page exists (#140), and it was moved out of the Review queue (#148). Two of the three redesign items shipped; the evidence chain did not. One of two open questions is answered (checked 2026-09-02; revision at the end).
- **Written**: 2026-08-31 (see conventions in [README](README.md))
- **Related**: [0009](0009-no-type-is-a-type.md) removed the built-in entity types, [0010](0010-no-relation-is-no-relation.md) removed the fallback relation, and `#125` removed the remaining eight seed relations — this document is the last step in that same line: **the ontology should hold nothing but vocabulary.**

> This document undoes a reuse decision that was deliberate when it was made. The original design was not an oversight; it bought three specific things. This document lists what it bought, then explains why it still needs undoing.

## Current state

The Ask-the-Data semantic layer stores "business concept → data asset definition" as a fact:

```
Subject    = a concept entity (Metric / Dimension)
Predicate  = mapped_to          ← a row in relation_types, alongside works_at
Object     = object_value JSON  { source, table?, expr?, sql?, unit?, summary? }
Confidence = 0.6 proposed / 1.0 confirmed
```

The full path:

```
An exploration task reads the mounted source schema → the LLM proposes → a mapped_to fact at 0.6 confidence
    ↓  review_routes' low_confidence_facts pulls in anything below 0.75
A person clicks Confirm on the Review page  → confirm_fact sets confidence to 1.0
    ↓  chat.rs reads confirmed_mappings (>= 0.75)
Injected into the Ask-the-Data system prompt
```

## What this reuse bought

**First: zero new UI for the review flow.** A proposal lands at low confidence and flows automatically into the "low-confidence facts" bucket, using the existing Confirm/Reject buttons. `mappings.rs`'s module comment states this as deliberate design intent, not something noticed after the fact.

**Second: bitemporal history.** Whether a definition changed, when, and what it was before — the ledger already answers this.

**Third: an evidence chain.** Sharing the same shape as other facts, entity history can display it directly.

All three are real benefits, and undoing this reuse means rebuilding them.

## Why it still needs undoing

### 1. It is not a claim about the world

The ontology answers "what exists in the world, and how are things related." `mapped_to` answers a different question: "**how is this number computed in our database**" — an implementation detail, not the same kind of thing as `works_at`.

This is the same rule, applied a third time, as removing the built-in entity types in 0009 and removing `related_to` in 0010: **a code-level mechanism should not be mixed into vocabulary.** 0009 said "`concept` is control flow, not vocabulary." Here: "`mapped_to` is configuration, not vocabulary."

### 2. It shows up in places it should not

A row in `relation_types` means: the ontology page lists it as a relation, the extraction prompt hands it to the model, ontology-size statistics count it, and after `#125` it became the **only remaining seed relation** — a new base starts with an ontology holding exactly one relation, and that relation has nothing to do with the knowledge graph the user is trying to build.

### 3. The "confirm" action already breaks the ledger's own foundation

```rust
// graph.rs — confirm_fact
UPDATE facts SET confidence = 1.0 WHERE id = $1
```

The ledger is append-only: correcting a fact means inserting a new row and marking the old one `supersedes`, because **a change in understanding is itself information** (the argument behind 0001 P0). But confirming a definition is an **in-place UPDATE** — it does not change "what we understand about the world," it changes "whether this configuration is now active."

Something that needs an in-place status change does not belong on a table that forbids in-place changes — that mismatch is itself the evidence. Nothing has broken yet only because confirming a definition happens to be simple enough to express with one floating-point number.

### 4. The shape does not fit

A mapping's real fields are `source`, `table`, `expr`, `sql`, `unit`, and `summary`, all currently crammed into one `object_value` JSONB blob. As a result:

- **It cannot be queried well.** "Which concepts map to the `orders` table" means digging through JSON.
- **It cannot be constrained.** One concept should have at most one mapping per source, but that uniqueness — `(concept, source)` — lives inside `object_value`, where the database cannot enforce it. Today it only holds because the confirm flow closes the old one explicitly, a matter of process, not of a real constraint.
- **It cannot be described clearly.** What is the range of `mapped_to`? There is no answer, because the object is neither an entity nor a fixed data type — it is a piece of configuration.

## The decision

**A separate table, `concept_mappings`.** Concept (an entity id) maps to a data asset definition, with fields expanded into real columns, and uniqueness on `(kb_id, concept_id, source)` enforced by the primary key.

`mapped_to` is retired from `relation_types`, and `DEFAULT_RELATION_TYPES` becomes empty as a result — creating a base no longer seeds any relation at all; the ontology holds nothing from day one except vocabulary the user imports themselves.

## The three things to rebuild, one at a time

**The review flow**: no longer borrows the low-confidence-facts bucket. A pending semantic-layer item is a different kind of thing (a configuration proposal, not a knowledge claim), and the Review page gets it its own group. This lands in the same place as 0002's R0 consistency check — that is also "the engine proposes, a person decides."

**History**: the table carries its own `created_at`, `confirmed_at`, and `confirmed_by`, plus a `concept_mapping_revisions` table recording how a definition evolved. **No bitemporal design here** — a definition has no separate "valid time" and "recorded time" axis; it has only "when it took effect." Forcing the ledger's full machinery onto it would import complexity instead of solving anything.

**The evidence chain**: a mapping's evidence is "which table's schema the LLM read to propose this," a different kind of thing from a fact's "which sentence in the source text." They should be recorded separately from the start.

## The cost, stated up front

- **One data migration**: existing `mapped_to` facts need to move into the new table. Since the base holds only mock data today, this step skips writing a migration and just replaces the data directly (same as `#125`). This convenience will not exist after a real release.
- **Three wiring points to change**: writing in `mappings.rs`, reading in `review_routes`, and injection in `chat.rs`.
- **One extra piece of UI in the short term**: the Review page needs one more group. 0002's R0 needs the same thing — do this once for both, not twice.

## Revision note (2026-09-02): checked against the shipped code

**The status line read "planned," even though this document shipped in the exact same commit as its implementation** — the largest gap found in this review, recorded here as a lesson: the status line is the responsibility of the PR that implements the change.

**Three small differences in shape**: the uniqueness rule `(kb_id, concept_id, source)` is a `UNIQUE` constraint, not the primary key (the primary key is `id`) — this does not change the conclusion. The table has one extra column, `derived` (a computed metric, such as "conversion rate = orders / visits"). **No data migration was done** — the base held only mock data, and the old `mapped_to` facts stayed in the ledger, unread by anything.

**The three rebuild items**: the Review group was built, then moved again — #140 built a standalone "Data Mappings" page, and #148 shrank the Review page's left-panel entry down to a count with a link out, reasoning that a data mapping is neither a queue nor a history view; the approval endpoint stayed in `review_routes` (the `mapping.decided` audit trail lives there). History shipped: `revise()` writes a full snapshot into `concept_mapping_revisions`, and the page has a History drawer. **The evidence chain was not built**: `concept_mappings` has no column recording "which table's schema the LLM read"; an exploration proposal keeps no evidence at all.

**Two things this document did not anticipate**: `propose()` uses `ON CONFLICT … DO UPDATE … WHERE status = 'proposed'`, so re-running exploration never overwrites a human rejection (and this surfaced a real Postgres behavior: `RETURNING` returns zero rows when a `DO UPDATE … WHERE` clause is not satisfied). And a visibility tier exists: a Viewer can see the list, but `revise` requires Editor — "seeing the answer but not the method behind it means asking someone to trust a calculation they cannot inspect."

## Open questions

- **What happens when a confirmed definition changes?** The bitemporal design could already answer "what was last quarter's definition"; switching to a revisions table needs this designed explicitly. Ask-the-Data will hit this whenever it looks back at a historical report. (**Answered**: `revise()`, `concept_mapping_revisions`, and the History drawer. "Last quarter's definition" can now be read from the revisions table; whether Ask-the-Data actually uses this for historical queries is still undone.)
- **The same concept, multiple sources**: `(kb_id, concept_id, source)` allows one concept to have a different definition per source, which is deliberate (a comment predating 0010 already stated this). But which one should Ask-the-Data use? Today, all of them go into the prompt and the model picks. This document does not change that, but moving to a real table makes it easier to add a rule later. (Still: all are sent, capped at 30, and the model picks.)

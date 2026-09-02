# 0003 · The ontology grows from the corpus: where the human sits

- **Status**: Shipped and still running (#44 plus the auto-extend switch). **The starting point in this document is now overturned** by [0010](0010-no-relation-is-no-relation.md) (removal of `related_to`) and by #125/#128 (seed types retired). The "rejection has memory" section was redone after [0007](0007-who-decides-what-becomes-a-relation.md) overturned it. Of the three gaps listed at the end, two are closed; "alert on new phrases" is still open (checked 2026-09-02).
- **Written**: 2026-08-28
- **Related**: 0001 P3b and P4 in [0001](0001-ontology-import-and-governance.md) describe the plan; this document describes what actually grew, and the two differ.

> The most useful part of this document is the section on **three changes of judgment**. The final code shows the conclusions, but not the reasoning, and the reasoning differs each time. Following the convention in [README](README.md), we keep each revision in place.

---

## The problem

The extractor reads "Star Wars: Squadron Zero plays on GeForce NOW," but the ontology has no "playable on" relation, so it downgrades to `related_to` — which **says nothing at all**. In real text, this kind of edge once reached 40.5%.

A new knowledge base starts with only 10 default relations, chosen by no one — just seed data. So every new base starts in this state: **nearly half the edges in the graph carry no meaning, until someone sits down and fills in the ontology one relation at a time.**

The extraction-side fix (remove the escape hatch, add prompt rule 8, store the original word in `fact_evidence.surface_predicate`, shipped as `proposed_predicate`) is covered in 0001 P3b. This document continues from there — **once the original word is kept, how do we turn it back into a real ontology relation.**

> **Revision note (2026-09-02): the world described in the two paragraphs above no longer exists.** `related_to` was removed entirely; a predicate that fails to map is now stored empty, and the UI recovers the original wording through `fact_surface_predicate()`. A new base starts with **zero relations**; the starting point is now an ontology pack ([0008](0008-ontology-packs-as-cold-start.md)).
> The 40.5% figure was measured at that time. [0012](0012-the-ontology-is-a-contract-not-a-suggestion.md) later measured 25.6% empty predicates on `ai-timeline-ends × schema.org`, and all 41 relations there came from the ontology pack — **auto-growth had not produced a single one.**
> So this loop's role changed: cold start now leans on "install a vocabulary first," and the mechanism in this document fills the remaining gaps. The loop itself is unchanged and still on by default.

---

## What shipped

### The value of adoption is in the second half

The Suggest panel could already propose a relation and add it with one click, but it **only created the relation type; it did not touch existing facts** — the ontology grew, but the graph did not improve, and the same 49 facts kept showing "related to."

Adoption now does two things: create the relation type, **and rewrite the facts waiting on it.** The proposal itself states "will reclassify 21 facts" and lists which phrasings it groups together.

The rewrite is an append, not an edit: insert a new row marked `supersedes`, retire the old row — the same path used for a human correction or a temporal close. Entity history can then show "first recorded as related to, later refined to available on, by [user]."

**Only facts whose phrasing falls entirely inside the adopted group get rewritten.** A single fact can accumulate several different phrasings across chunks; adopting only one phrasing and rewriting anyway would silently decide the other one too. Measured, this case is under 1% of facts.

### Adoption can be undone

`fact_adoptions` records, per fact: the batch, the predicate, the old fact, the new fact, and whether it was a **new relation** or a **merge into an existing one**. Undo rolls back by batch: the new row is retired, the old row comes back.

**A relation type is never deleted** — facts have pointed to it (and `delete_relation_type` refuses anyway), and under an append-only rule, "it existed" is itself history; an unused relation is simply inactive. Undo marks a ledger row rather than deleting anything, because both the adoption and the undo really happened.

Undo needs a light confirmation (a click, not a typed confirmation — the action is itself reversible).

### Three levels of action

| | Who decides | When to use |
|---|---|---|
| Add one at a time | A person | Adopting selectively |
| Add all | A person | The common case: "these all look right," one decision |
| Automatic | The switch | See below |

### The switch

`knowledge_bases.auto_extend_ontology`, on the knowledge base settings page, **on by default**.

It controls only **automatic adoption**, never **detection**: turning it off does not stop unmatched phrasings from accumulating, and they stay visible on the Unmatched panel — they just become a proposal you click instead. The label must say this plainly; "stop extending" is too easy to misread as "stop watching."

Defaulting to on depends on the action being **visible and reversible**: the ontology page shows a banner stating what was added, how many facts changed, with an undo control. **The audit trail is for checking after the fact, not for notification.**

### The one thing that is never automatic

`functional` is always `false`, no matter what a proposal suggests and no matter whether the switch is on.

Marking a relation functional drives the temporal engine to **auto-close facts and generate conflicts.** By the time someone notices, those closures already form a chain of supersede links, and undoing them means unwinding it backward. `part_of` was once wrongly marked functional, and 28 press releases produced 59 false conflicts from it.

**The rule in one line: what is reversible can be automatic; what triggers a cascade of writes cannot.**

(Later widened to all axioms: the cold-start path passes `Axioms::default()`, all eight false — every axiom the reasoning engine ([0002](0002-reasoning-engine.md)) trusts must be written by a person.)

### Rejection has memory

`dismiss` used to run `DELETE FROM ontology_misses`; the next extraction that met the same word inserted it right back — **a user's "no" did not survive one extraction cycle.** With the switch off this was only annoying; with it on, this became the system silently overriding a clear human decision.

Fixed by marking instead of deleting (`dismissed_at`): `record_miss` no longer accumulates a marked entry, and both the manual and automatic paths skip it. This also fixed the existing bug that made "dismiss" temporary.

> **Revision note (following defect 5 in [0007](0007-who-decides-what-becomes-a-relation.md))**: half of "no longer accumulates" was **overturned again**. It turned a dismissal into a one-way gate: a user's decision, made while looking at "seen once," was recorded as a decision for all time. The next twenty documents kept using that same word, but the count stayed frozen at 1, with no one able to see it.
> Now `record_miss` accumulates as before, and suppression moves to the read side — dismissed entries appear in their own group, showing the updated count, and can be brought back. "Rejection has memory" still holds, but what it remembers is **the decision**, not **the count**.

### The threshold for automatic adoption

Only a phrasing seen in **2 or more documents** gets adopted automatically. The reason is not safety (undo already covers that) — it is quality: **the ontology feeds back into the extraction prompt, so one accidental word choice would become a standing instruction.** A useful side effect: a single document never reaches the threshold on its own, so nothing happens until the next document confirms the pattern.

---

## Three changes of judgment

### First: I opposed automation, for the wrong reason

**Original judgment**: the ontology should never write itself automatically. Synonyms would multiply (four versions of "available" becoming four relations), generic verbs would slip in (`is`/`has`/`includes`), frequency does not equal meaning, and a wrong guess at `functional` could mass-produce false conflicts.

**The individual points were correct.** The conclusion built on them relied on a hidden assumption that was not: **"a mistake is expensive."**

It is not expensive. Adoption uses supersede; the old fact is never destroyed. **I had already designed in reversibility, then argued against automation without counting it** — using an irreversibility I had already designed away as the reason to avoid it.

**The right axis is not "how confident are we," it is "how expensive is being wrong."**

(The synonym and generic-verb points still stand, but they call for **clustering**, not "wait for a human nod." Automation applies to approval, not to grouping.)

### Second: after accepting automation, I judged by a guess

**Original judgment**: whether the ontology "has been touched" (has any non-built-in type) can decide whether auto-run should be allowed.

**That infers intent from behavior, and it fails in both directions.**

Clicking Add once on a proposal logs an ontology action with an actor attached — **taking part in the governance loop would then switch the governance loop off.** Fixing a typo in a description does the same thing.

And once this flag turns false, it never turns true again: after the first automatic run, the ontology "has been touched," so **the vocabulary freezes permanently on whatever the first batch of documents happened to contain**, even though RSS and folder sources keep adding new documents every day.

### Third: the switch (pointed out by a user)

**A stated setting replaces a guess.** The switch is not just a new control — it **removes a broken mechanism.** No guess means no absurd on/off flip; no automatic turn-off means no freeze; iteration becomes "leave it on and let it run," needing no cleverness at all.

Defaulting to on also solves the switch's own old problem: a new user could never find it, and would be stuck with a graph that is nearly half meaningless.

---

## Two defects found in shipped code

**A merge branch made history lie.** When adoption finds the target assertion already exists, the old row is retired **with nothing pointing to it as a successor.** Entity history reads "retired with no successor" as `rejected`, so the UI stated "this record about GeForce NOW was withdrawn" — when in fact every word of it had merged, unchanged, into another assertion. This is the same class of bug fixed in [#37](https://github.com/deeplethe/utopia/pull/37): **the UI confidently states something that did not happen.** `fact_adoptions` exists directly because of this.

**A single document could lock in the whole ontology.** The trigger condition, "no other document is currently processing," is true immediately when a batch holds only one document — and my own code comment says plainly, "triggering per document is wrong." The 2-or-more-documents threshold is the fix.

---

## Measured results

| | |
|---|---|
| Adopting `available_on` (merging 4 phrasings) | Rewrote **49** facts (48 new, 1 merged) |
| Adopting then undoing `supports` | `related_to` count returned exactly to its pre-adoption value; 24 rows marked undone; the relation type stayed |
| Cold start (a fresh base, 3 documents) | Auto-created 5 relations (all `functional=false`), rewrote 19 facts, **`related_to` left at 0** |
| Rejecting `runs_on`, then simulating the next extraction round | Count stayed at 41, did not grow (previously it would have been deleted and re-inserted) |

One **negative result, which proves the design works**: a suggestion proposed merging `optimized_for` into `runs_on` — "optimized for RTX" is not the same claim as "runs on RTX." The merged phrasings are visible in a tooltip, so a bad merge can be caught by a person. **This is the clearest evidence for keeping merging out of full automation.**

(The four rows above are measured against `related_to` and the seed ontology, both now gone; treat them as history, not as a current baseline. The adoption path later gained two things not described here: a phrasing group is first checked against `predicate_match` — if an equivalent relation already exists in the ontology, including its `_by` reverse form, the group lands on it and swaps subject and object (#109); the threshold now combines predicate and type into `MIN_SIGNALS = 3`, instead of counting predicate alone, so a corpus missing only entity types no longer gets skipped entirely. The canonical key is not asked of the model; it is the exact wording used most often inside the group.)

---

## Known gaps

- ~~**Entity types have no equivalent mechanism at all.**~~ **Closed** (2026-08-30): type resolution (0001 P3a) supplies proposals and a decision step, `adopt_proposed_types` supplies adoption plus retyping, and `entity_retypes` supplies a reversible log. The original claim of "only one PATCH endpoint" no longer holds. The measured data cited at the time (the name "rust" split across 5 types in the General base; `product` at 37.1% of `Industry Corpus`) is still the problem this path solves; see the three-layer breakdown in 0001 P3.
- **With the switch off, there is no alert like "88 new phrasings since last time."** The signal exists on the Unmatched panel, but no one checks it on their own. **Still open.** (Checked 2026-09-02: still not done. The comment on the `ontology_proposals_open_idx` table repeats this same gap word for word — the index is ready, the alert is not. Today there is only the `last_auto_extension` banner, which describes what the last automatic run did, not what is waiting.)
- ~~**Proposals are not saved.**~~ **Fixed** (2026-08-30, #112): the `ontology_proposals` table now stores them. What was actually being lost was never the raw material (that lives in `ontology_misses`) — it was **the clustering result**: which phrasings were grouped under one proposal, the only thing that lets a past merge be checked later.

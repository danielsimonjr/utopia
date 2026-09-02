# 0007 · Who decides a phrase deserves to become a relation

- **Status**: Shipped. Adoption is now decided by count. Fixes for all six defects below are live. "Narrative verbs entering the ontology" and `merge_key` not folding `_by` variants are both still open. **This document's starting point — 10 seed relations, and the measured `related_to` share — no longer exists**; see the revision at the end (checked 2026-09-02).
- **Written**: 2026-08-30 (see conventions in [README](README.md))

> Like [0006](0006-ontology-scale-and-the-prompt.md), this document uses real numbers, and marks what each one **cannot** show. It also records the dead ends along the way — four rejected designs, three of them proposed by us. They stay here because each one looked reasonable at the time.

## The problem

A new base starts with 10 seed relations. Once the first batch of documents loads, most relations the model states are not among those 10, so they downgrade to `related_to` — a fallback predicate that says nothing.

Measured (the ai-timeline corpus, 15 Wikipedia articles on AI companies, 348 chunks): **49.8% of facts were `related_to`**, with 398 distinct relation names in `ontology_misses`, used 895 times total.

`bootstrap_ontology` was built exactly for this: after extraction, hand candidates to an LLM, propose relations, adopt them, and rewrite the old facts waiting on them. But it worked poorly, and checking why turned up more than one cause.

## What we found

In the order found, each an independent defect:

**First: a word already in the ontology was thrown out just for being phrased differently.** Extraction only did an exact string match, so `produced_by | ChatGPT → OpenAI` — meaning the existing `produces`, just with subject and object swapped — was missed.
→ Fixed with [`predicate_match`](../../crates/utopia-server/src/predicate_match.rs): try an exact key, then a normalized phrasing, then a stemmed form, each retried once more with a trailing `by` stripped (swapping subject and object on a match).

**Second: the last document in a batch failing locked the whole base permanently.** Queuing auto-extend ran only on the success path, and its trigger condition was "this whole batch is done extracting." When document 15 exhausted its retries and turned `failed`, that condition became true — but no document would ever complete again to run the check. Proposals piled up in the queue; the ontology stayed frozen at the seed relations forever.
→ Fixed by moving the queue trigger to a point reached on both success and failure.

**Third: a threshold was computed but never applied.** `bootstrap_ontology` filtered for "appears in 2 or more documents" only to decide whether an LLM call was worth running; the following call to `build_proposals` passed only `kb_id`, and that function re-queried the **unfiltered** full set on its own. Of the 526 phrasings handed to the model, **456 (86.7%) had appeared in only one document.** The reverse gap also existed: 5 single-document phrasings were adopted, two of them becoming new attributes.
→ Fixed by making the filter apply where it is supposed to.

**Fourth: `doc_count` was counting leftovers.** It counted only facts that were "still attached to the fallback predicate, still live, with an entity object." Once a phrasing was adopted, matched by `predicate_match`, or corrected and retired, its row left the pending pile, and the document count dropped with it. **A base fed documents one at a time could therefore never accumulate two documents' worth of evidence, freezing the ontology permanently.**
→ Fixed: commonality is now measured from all evidence ever seen, while the rewrite count still comes from the pending pile.

**Fifth: "dismiss" was a one-way gate.** `record_miss` ran with `WHERE dismissed_at IS NULL`, so one dismiss click stopped both display **and counting.** A user's decision, made while looking at "seen once," got recorded as a decision for all time — the next twenty documents kept using the same word, but the count stayed frozen at 1, invisible to anyone.
→ Fixed by separating suppression from counting: counting continues as before, and dismissed entries appear in their own group with an updated count, reversible.

**Sixth: a fact with no date claimed day-level precision.** `valid_precision` was `NOT NULL DEFAULT 'day'`, so every fact with no date on either end still stored `'day'` (measured at 728 and 843 live rows across two bases).
→ Fixed by making it nullable, with a CHECK that precision can only be set when a date exists (see `facts.valid_from_precision`).

## The decision

**Adoption is decided by count, not by asking the model.**

The LLM used to be asked "which of these phrasings deserve to become a relation." The data already answers that question — `runs_on` appearing in 8 documents across 13 facts is not a judgment call. And the model got it wrong in testing: it missed `runs_on` entirely, while adopting `pledged_capital`, seen in only one document.

Three steps, all deterministic:

1. **Group by stemmed root** (`predicate_match::merge_key`): `sued` and `sues` are one relation.
2. **Count the union of documents**, not the sum — the same document might use both phrasings.
3. **Apply the threshold** (2 or more documents); the canonical key is the most common phrasing in the group.

The model was not removed, just given a different question: **merging synonyms** (is `collaborates_with` the same as `partnered_with`?). That question genuinely needs judgment, and a wrong answer there is a one-click `unadopt` away from being undone.

**The side effect is the most valuable part of this change: adoption became deterministic.** Re-running the same corpus produces the same ontology, and for the first time the benchmark tool can compare runs on this step — before this, a 3-point difference between two runs could not be told apart from run-to-run variance.

## What we measured

Same corpus (`scripts/bench/corpora/ai-timeline.json`), 348 chunks:

| Group | Ontology relations | `related_to` | Note |
|---|---|---|---|
| A | 10 | 55.5% | Auto-extend off |
| B | 17 | 39.1% | LLM adoption |
| B3 | 15 | 42.3% | LLM adoption plus the threshold fix |
| **B3 + count-based adoption** | **104** | **25.8%** | The decision in this document |

The merging step's contribution can be seen on its own: qualifying candidates rose from **70 groups / 281 facts** to **85 groups / 355 facts**, with 40 groups absorbing 80 phrasings, each group a different tense of the same verb (`sued`/`sues`, `reported`/`report`, `integrated_with`/`integrates_with`, `announced`/`announces`, `develops`/`developed`, and more).

`_by` is the only reversed marker common enough to matter: 31 phrasings, with `founded_by` at 42 facts, `released_by` at 19, `produced_by` at 15. Nearly every one has an active-voice counterpart already in use (`produces` at 265 facts), and without folding them together, two opposite-direction relations would be created for the same idea. `has_X`/`X_of` appeared in only two pairs — not enough evidence to act on.

> **Follow-up (2026-08-30, #109)**: before adoption, phrasings now pass through `PredicateIndex` first — if an equivalent relation (including a `_by` reversed form) already exists in the ontology, no new relation is created; the fact is rewritten onto the existing one, with subject and object swapped as needed. `adopt` also learned to swap subject and object (it used to copy the subject from the old row unchanged).
>
> **Still open**: when neither direction exists in the ontology yet (`founded_by` at 42 facts vs. `founded` at 4, both meeting the threshold, neither adopted), `merge_key` still does not fold `_by` into the same group, so two opposite-direction relations still get created. The original reason for not folding them was "the adoption path cannot swap subject and object" — that reason no longer holds. What remains is a small fix: add `_by` handling to `merge_key` and mark the whole group as needing a swap.

## What these numbers cannot show

- **The 3-point gap between B and B3 carries no information.** Both groups involve one LLM call, and run-to-run variance on this corpus, with identical input, has measured as wide as 25 vs. 18 entities. Only the deterministic part is certain: single-document adoptions dropped from 5 to 0.
- **The `related_to` share is not a quality metric.** It measures "how many facts sit on a predicate that says nothing," and the cheapest way to lower it is to fold everything into the ontology — which is exactly the open question below.
- **This corpus likely appears heavily in model training data.** These AI-company articles are good for a demo (a real strength) but not for an accuracy benchmark (it may be measuring recall of memorized text, not extraction). The open question on corpus validity from 0006 still applies here.

## Open: narrative verbs entering the ontology

Among the 104 relations, several carry Wikipedia's own voice:

```
reported/report 11 · states/stated 6 · describes/described 5
criticizes/criticized 6 · published/publishes 6 · accused/accuses 6
```

These describe **the article citing a source**, not a structural relationship between AI companies. They recur consistently across articles, so a count-based threshold cannot filter them out. And since the ontology feeds back into the extraction prompt, the next batch of documents sees `states` and `describes` listed as options, making the model more likely to extract narration as if it were a fact.

**Telling narration apart from structure needs judgment — a third job counting alone cannot do** (the first two, synonym merging and preposition variants, both already have a home). A candidate direction: fold this into the same LLM call already used for synonym merging ("which of these sound like the article's own narration") — a small, reversible addition. Maintaining a fixed list of narrative verbs would be too fragile, breaking on the next different corpus.

Not fixed for now: dropping `related_to` from 55.5% to 25.8% is already a large improvement, and a narrative relation at least keeps the source's own wording, saying more than "related to" did. (**Follow-up**: the remaining 25.8% no longer displays as "related to" either — `related_to` was removed entirely, see [0010](0010-no-relation-is-no-relation.md). This open item still stands on its own: narrative verbs entering the ontology is a separate problem from predicate fallback.)

## Revision note (2026-09-02): the starting point is gone; the conclusions still stand

This document's problem statement was "a new base starts with only 10 seed relations, so most phrasings downgrade to `related_to`." **Neither premise holds today**: seed relations retired in three stages (`related_to` in [0010](0010-no-relation-is-no-relation.md); the other eight in #125; `mapped_to` in [0011](0011-a-mapping-is-not-a-fact.md)), and the seeding function itself is gone (#128). A new base now starts from an ontology pack instead ([0008](0008-ontology-packs-as-cold-start.md)), defaulting to schema.org: 1,010 types and 1,676 properties.

**This also breaks comparability of the measured table above**: groups A, B, B3, and count-based adoption all started from 10 seed relations. Running the same corpus today would start from schema.org instead, and `related_to` as a metric no longer exists at all (a fact can simply have no predicate, with the original word kept in `fact_evidence.proposed_predicate`). The equivalent metric is now "share of empty predicates" — [0012](0012-the-ontology-is-a-contract-not-a-suggestion.md) measured 25.6% on ai-timeline-ends. That number and this document's 25.8% come from different starting points and different definitions; **do not compare them.**

**The decision itself is unaffected.** Count-based adoption, `merge_key` grouping, document-union counting, and `MIN_DOCS = 2` are all live, along with one addition not in this document, `MIN_SIGNALS = 3` (skip the LLM call entirely if fewer than three qualifying signals exist). Proposals are now saved to `ontology_proposals` (#112), so a decided case is not pulled back in on the next run.

**No one has yet measured what changing the starting point from 10 to 1,500 relations means for the adoption loop** — the last open question in 0008. None of the thresholds have changed.

**The downstream effect of `_by` now has a structural answer**: the ontology can declare an inverse relation (#177/#179), with direction stated by the type signature and corrected at write time (#138, leaving a `direction_corrected` trace). But that does not replace the `merge_key` gap for `_by` — when neither direction exists in the ontology yet, two opposite relations can still be created.

## Dead ends

Kept here because each one looked reasonable at the time.

**A Snowball stemmer.** Using `rust-stemmers` for stem normalization measured **the opposite of the intended effect**: with a 10-word vocabulary it recovered 49 matches; switched to schema.org's 629 words, it recovered only 18. The cause: it also strips derivational suffixes, so `producer` (a person) and `produces` (an action) both collapse to `produc`, and a conflict-avoidance rule then refused to match them — **the larger the vocabulary, the less it dared to act.** Limiting it to inflectional suffixes only brought the count from 49 to 59.

**Subject diversity instead of document count.** The idea: "how many distinct subjects use this phrasing" tracks generality better than "how many documents contain it." Measured worse: it gained 6 and lost 33. Most of the 6 gains were a false signal from **coordinated subjects** — "A, B, and C all proposed X" splitting into 3 facts with 3 subjects and 1 object, measuring sentence grammar, not word generality.

**`docs>=2 OR subjects>=3` combined.** A patch for the case above, defeated by the same coordinated-subject problem.

**Trigger auto-extend after every single document.** Meant to fix "the last document failing locks the base forever," but it would change the meaning of "2 or more documents" from "across the corpus" to "so far," and more importantly, **it would make merging worse**: with the full pool visible, the LLM can see `acquired`/`acquires`/`acquisition_of` together and merge them in one pass; split into 8 separate runs, each seeing only one or two, there is no cluster to merge. Adoption batches would also multiply from 1 to 8, needing separate undos. The fix that shipped instead was the smaller one: move the queue trigger to a point reached on both success and failure.

**Add another threshold for "a real new relation stuck at one document."** The intuition: "3 or more facts should also qualify." The data rejected it: the top two relations this would have let in were the two worst candidates (`has_property` at 11 facts, `intends_to` at 5). Single-document groups with 3+ facts totaled only 20 groups / 86 facts, and only about 5 groups / 25 facts of those looked like real relations — 1.2% of the base. We chose not to add a fourth guessed threshold for this: a growing base will resolve it on its own over time, and a static corpus can rely on the manual panel instead (`min_docs = 0` shows everything).

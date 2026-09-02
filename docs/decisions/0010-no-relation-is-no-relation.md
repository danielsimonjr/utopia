# 0010 · "Cannot state a relation" should not be a relation

**Status**: Implemented. `facts.predicate_id` is now nullable. The two "to do" items at the end are both complete, delivered together with [0011](0011-a-mapping-is-not-a-fact.md) (#126) — `mapped_to` did not just leave the prompt, it left `relation_types` entirely, and creating a base no longer seeds any relation (checked 2026-09-02).

This is the relation-side twin of [0009](0009-no-type-is-a-type.md). That document covered `concept` — "not yet classified" written as a type. This one covers `related_to` — "the ontology has no matching relation" written as a relation.

## It is control flow, not vocabulary

`related_to` encoded one thing: **the extractor found an edge, but the ontology had no matching relation for it.** That is a program state. Yet it sat in `relation_types` as a `builtin` relation, listed on the ontology page right next to `acquired` and `works_at`, as if someone had decided "the relationship between these two things is called related to." No one ever decided that.

The cost was not abstract. Measured before deletion: in one 348-chunk base, 533 facts sat on this relation, and the UI showed **all of them** as the four words "related to." Yet every one of those 533 facts **carried the original wording** (`fact_evidence.proposed_predicate`), with nothing missing — the real meaning was in the database the whole time, hidden behind that one fake word.

## Deleting it made the data more informative, not less

Same data, but what a reader can see went from one word to over five hundred. Verified on real text (a 14,706-fact base, see below): 93 edges in the graph that used to all read "related to" now each show their own wording — `placed_pressure_on`, `agreed_to_resign`, `countersued`, `revived_legal_action`, `license_from`.

Only 3.0% of facts (16/533) carry more than one wording, so "which one to display" is not a real obstacle: pick the most frequent one, breaking ties alphabetically — the same rule `predicate_match::merge_key` uses to pick a canonical key, and **deterministic**, so the same edge shows the same name in the graph, the entity panel, and change history.

Built as a SQL function, `fact_surface_predicate(uuid)`, instead of a subquery repeated in every read query: there are eight separate paths that read facts, and eight copies of the same SQL will eventually drift apart — and drifting here means exactly "the same edge shows a different name on different pages."

**420 rows are an exception, all from historical data.** Of 5,934 fallback facts, 420 have no recoverable original wording, and **all** of them come from the two oldest bases, `Industry Corpus` (275) and `General` (145) — from before `add_evidence` unconditionally recorded `proposed_predicate`. After the change they display as empty, but they used to display as "related to" — equally zero information either way, so nothing got worse.

## This overturns a line from 0001

[0001](0001-ontology-import-and-governance.md), line 441, once stated:

> **`related_to` is an honest "we don't know"; a wrong specific guess is a confident mistake.**

The first half was wrong; the second half is still correct. **Staying at "we don't know" really is more honest than guessing a specific relation** — 0001 was right about that, and this document does not overturn it. The mistake was implementing that honesty as **a word in the ontology.** A relation the UI shows as "related to" is not vagueness — it is a **claim**: it states that a connection called "related to" exists between these two things. The truly honest form is empty — shown alongside the note "the source text says `acquired`."

The parenthetical in the same document, line 460 ("keep it in the ontology as a code-level fallback"), is also obsolete: the fallback now happens **at read time**, not at write time.

## Twenty inner joins, invisible to the compiler

Once `predicate_id` became nullable, every `JOIN relation_types` on a read path became a **silent filter** — an inner join drops a NULL-matching row without error or warning, and `cargo check` and clippy say nothing about it. This is the same trap as `NULL <> uuid` in 0009, wearing a different face: under three-valued logic, "no value" gets treated as "no match."

Of the twenty joins, **11 needed to become `LEFT JOIN` with a fallback**, and 6 inner joins **were already correct** (4 filter by `r.key`, where a NULL predicate could never match anyway; 2 read `functional`/`temporal`, and a fact with no predicate should not take part in temporal reasoning at all).

The three that were missed were all caught by the database, not by the compiler:

| Missed spot | Symptom | Caught by |
|---|---|---|
| `document_extractions`'s `r.label` had no COALESCE | Runtime decode failure | Manual line-by-line review afterward |
| `entity_history` / `graph_changes`, the outer `FROM ev` (a CTE) referenced `f.id` | `missing FROM-clause entry for table "f"` | A new database-backed test |
| `proposed_predicates`, after removing the `rt` join, an example subquery still referenced `rt.id` | `missing FROM-clause entry for table "rt"` | An existing `proposal_counts` test |

Two placeholder-numbering mistakes (removing `$2` without renumbering `$3`) were also caught by tests.

**This is the 8th time in this codebase that "SQL is invisible to the compiler" has bitten us.** The conclusion has not changed, only gotten more expensive to relearn: any change touching a SQL string needs a database-backed test — it is not optional polish.

A new test, [`no_predicate_still_shows.rs`](../../crates/utopia-store/tests/no_predicate_still_shows.rs), guards this rule: it creates a fact with no predicate and requires every read path to still show it. Reverting any `LEFT JOIN relation_types` back to `JOIN` must fail this test — checked against both control cases (reverting to an inner join fails the assertion; writing `ev.id` back as `f.id` fails at the SQL level).

## The UI must show the difference

A reader **must be able to tell** whether a word came from the ontology or from the source text — otherwise this is just a different way of lying. So each row carries an `inferred` flag:

- Graph edges: a relation outside the ontology renders in a lighter gray, visually distinct from a vocabulary relation
- Entity panel and document output: hovering explains "this relation is not in the ontology; this is the source's own wording"
- When neither is available (the 420 rows above): shown in italics as "no relation could be determined" — **never invented as a word**

## End-to-end verification

Run on a full clone of the `utopia` base (14,706 facts, 5,934 sitting on `related_to`):

| Step | Result |
|---|---|
| Migration on a fresh empty base | Migration 0052 applied cleanly; `related_to` count is 0 |
| Migration on real data | 5,934 rows converted to empty; 5,514 recovered their original wording |
| Graph overview | 457 edges: 364 ontology relations, 93 with original wording, 0 unresolvable |
| Entity panel (OpenAI, 252 facts) | 64 show original wording; every row with `inferred = true` has an empty `temporal` field |
| Document output (509 facts) | 134 show original wording |
| Resolution profile (the deduplication page) | Shows original wordings such as `offered_to_employ`, `hiring_effort`, `feared_retaliation` |
| Rejecting a fact with no predicate | The decision ledger keeps a self-contained snapshot: "Southeast Memphis — has_higher → risk of developing cancer" |

The last row is exactly where an inner join would have cost the most: `fact_snapshot`, run as an inner join, would have returned `None`, and this rejection would have left **no record at all** in the ledger — even though the entire point of the ledger is to survive after the fact itself is gone.

## Data was changed directly; no migration path was built

Every base today holds only test data, since the product has not shipped yet. This reasoning holds here, but it would not hold once a user has run a base for months — at that point, the rule from 0001, line 464 ("applies only to new extraction; existing data needs a rebuild") still applies.

## Cleaned up along the way

- The `graph::FALLBACK_RELATION_KEY` constant and both `FALLBACK_RELATION_MISSING` branches
- The `extraction_drops` discard reason for "the ontology does not even have a fallback relation, so the whole fact vanishes" (the exact trap noted in 0001, line 99, which can no longer happen)
- The wording "fallback predicate" and "fallback relation" throughout the code and docs

## Revision: the data was deleted, the code was not, and it grew back seven minutes later

**Status**: Implemented — a direct continuation of the section above, in the same document.

Migration 0052 only deleted **rows** in `relation_types`. The seed relation was **code** — the entry in `graph.rs`'s `DEFAULT_RELATION_TYPES` was still there, and `ensure_default_ontology` ran on base creation, on viewing the ontology page, and on **every extraction.** (This function, along with the seed table, was retired entirely in #128; this kind of "grows back" case is no longer possible, and the control case in `no_predicate_still_shows.rs` was rewritten accordingly.) The ledger shows it clearly:

    0052 applied 08-30 17:54  →  related_to count across the whole system drops to zero
    bench demo-autoextend    →  08-30 18:01, one row grows back with builtin=true

**A second layer made this worse than "not fully deleted."** Migration 0052 also removed the exclusion filter in the extraction prompt, reasoning in a code comment: "it has no row left anyway, so the escape hatch and 'remember not to list it' both disappear together." The first half of that reasoning was wrong, which turned the second half into a regression: `related_to` was not only still alive, it was **listed in the prompt for the model to see, for the first time ever.** 0001 already measured the cost of this — of 359 uses, 321 were chosen by the model directly from the list, and only about 38 came from a code-level downgrade. Once an escape hatch is put on the table, the model stops trying to state what the source text actually says.

**The lesson is not "remember to change both places" — it is "these two changes must ship together; changing only one is worse than changing neither."** Deleting the data without the code means the vocabulary grows back. Deleting the exclusion filter without the vocabulary means handing it straight to the model.

### And the test guarding this had been passing on an empty case

Migration 0052 shipped with what looked like a control-case check:

```sql
SELECT count(*) FROM relation_types WHERE key = 'related_to' AND builtin
```

It passed, because **the test fixture built its base with raw SQL and never called `ensure_default_ontology`** — the seed was never planted, so the assertion passed over empty ground. This is the second time in this project a test passed for this exact reason (the first was an extraction guard where `ctx = None` could never reach the branch it was meant to guard).

The current version plants the seed first, then checks, and was verified against the control case: adding `related_to` back to the seed table turns the test red.

Two related bugs were also fixed: a whole-database count assertion could be polluted by parallel tests (fixed by scoping the count to one knowledge base), and a failing assertion could skip teardown (fixed by clearing state before each run instead of relying on cleanup after).

## To do (all now complete, see the status line)

- Remove `mapped_to` from the extraction prompt. It links an entity to a data-source schema (a JSON value); only `related_to` was excluded from the prompt, so the model used `mapped_to` between entities 41 times. A one-line filter fixes it.
- Further: `mapped_to` should not be in the ontology at all. It is an internal mechanism for question-to-data mapping, and belongs to the exact same class of mistake as this whole document — writing control flow as vocabulary.

(**Two pieces of dead code noted along the way (2026-09-02)**: `graph.rs`'s `confirmed_mappings()` has zero callers anywhere in the repository, since question-to-data mapping now goes through `mappings::confirmed`; and the `r.key = 'mapped_to'` join inside `confirm_fact`, meant to retire an old mapping for the same (concept, source) pair, now always matches zero rows. Both should be removed.)

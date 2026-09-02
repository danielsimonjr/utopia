# 0002 · Reasoning engine

- **Status**: R0 is done (4 fact-level violation checks, 8 ontology self-check defect types, two tables, two Review tabs). R1 is done, gated by the per-base switch `materialize_inferences`, **off by default**; all four axiom-based rule types compile (#132, #177, #179). R2 has only one layer of direct premises; a proof-tree API and UI are not built. R3 is not done; the system re-derives everything on a timer (`inference_interval_minutes`, default 60). Reviewed against the code and revised on 2026-09-02; see each section.
- **Written**: 2026-08-28
- **Related**: [0001](0001-ontology-import-and-governance.md) P5 (that section keeps its original judgment; this document replaces its schedule)

The original placeholder stated the intent: *"Temporal Datalog interpreter for derived facts with explanations, plus the ontology axiom compiler."* The direction is correct. This document sets the **order** and the **safety boundary**.

---

## Core judgment: the first delivery is consistency checking, not derivation

**The reasoning engine amplifies defects.** Measured on `Industry Corpus` (28 public press releases):

| Metric | Value | Meaning |
|---|---|---|
| Share of `related_to` facts | **359 / 922 = 39%** | Almost 40% of edges carry no real meaning (out-of-vocabulary predicates downgraded; see 0001 P3b) |
| `part_of` facts | 185 | The first target for a transitive rule |
| `part_of` transitive closure | 828 (capped at depth 10) | A 4.5x blow-up, and it **does not converge** |
| Closure depth distribution | 1:185 2:181 3:141 4:45 5:52 6:40 7:52 8:40 9:52 10:40 | Oscillation from depth 5, not decay — **a cycle exists** |

The cycle is real, caused by an extraction error:

```
Microsoft → FarmBeats for Students → Microsoft
FarmBeats for Students → National FFA Organization → FarmBeats for Students
```

"FarmBeats for Students is part of Microsoft" is correct. The reverse edge came from the model reading "Microsoft's FarmBeats program" backward. **Real text contains a cycle on day one.** Cycle detection is not defensive coding, it is a precondition for starting this work.

Turning on transitive closure over this data would produce "Microsoft is part of Microsoft" on day one, **with a full evidence chain attached** — harder to clean up than no answer at all.

But the same rule-evaluation engine, run the other direction, becomes a **consistency checker**: find cycles, find asymmetry violations, find disjoint-type violations. It carries no truth-maintenance burden, no blow-up risk, and its output feeds directly into the existing `fact_conflicts` table and Review UI. **Build the engine through checking first, clean the corpus, then turn on materialization.**

Contradictions found today (11 total across three knowledge bases, all real defects): 2 `part_of` two-way cycles, 9 pairs of duplicate reversed predicates, 0 self-loops (`extraction.rs:363` already blocks these).

---

## Three architectural constraints

### 1. A derived fact has no evidence slot

`fact_evidence.chunk_id` is `NOT NULL`. A derived fact has no chunk — **its evidence is other facts.** The product promise is "nothing enters the graph without evidence," so this is not optional.

```sql
CREATE TABLE fact_derivations (
  fact_id         UUID NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  premise_fact_id UUID NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  rule_id         UUID NOT NULL,
  seq             SMALLINT NOT NULL,
  PRIMARY KEY (fact_id, premise_fact_id, seq)
);
```

This is also where "with explanations" lands: **an explanation is a premise set plus a rule**, expanded recursively into a proof tree, with real chunks only at the leaves. The `facts.derived_by_rule` column has waited unused since `0004_graph.sql:71` — this is what it was for.

> **Revision note (2026-09-02): the final shape is different, and that column is still unused.** In the shipped design, **derived facts do not go into `facts`**; they get their own table, `derived_facts`. Migration `0013_reasoning.sql` gives three reasons: only one of the 40+ queries reading `facts` knows about that marker, so any new query would treat a derived fact as asserted by default — **the failure points the wrong way**; once split, forgetting the UNION means derived facts go missing, not that they leak in; the columns needed differ; and the row counts differ by an order of magnitude. The real `fact_derivations` columns are `(derived_fact_id, premise_fact_id, seq)`, with the rule on `derived_facts.rule_id`. `facts.derived_by_rule` still has zero writes; its only reference is one filter in Review.
> This "which way a failure should point" rule was later reused, unchanged, by [0015](0015-recording-a-sentence-is-not-asserting-a-fact.md) to reject a `facts.nod` column.

### 2. A derived fact must never close an asserted fact

`reconcile_new_fact` (`temporal.rs:49`) auto-closes an old fact for a functional predicate. If a derived fact followed the same path, **one wrong rule could systematically close facts a human asserted** — the `part_of` incident, ten times over, and this time automated.

Hard priority, **asserted beats derived**:

| Case | Handling |
|---|---|
| Derived vs. asserted | The derived fact **does not land**; log a "rule conflicts with fact" signal |
| Derived vs. derived | The rule set contradicts itself → goes to Review, **not auto-decided** |
| Asserted vs. asserted | Existing logic, unchanged |

This is the same rule as criterion 2 in [0001](0001-ontology-import-and-governance.md) ("the ontology guides, it does not enforce"), applied to reasoning: **a declaration can be wrong, so it must not drive rewrites of existing data.**

> **Revision note (2026-09-02)**: only the first half of the first row shipped — `asserted` has hard priority, and an already-asserted triple is never re-derived (`derive.rs`). "Log a rule-conflicts-with-fact signal" is **not done**. "Derived vs. derived goes to Review" is **not done** (multiple derivation paths for the same triple keep only the first proof). Both remain open work.

### 3. When a premise is retracted — bitemporal storage is the best fit, not a burden

An `UPDATE` is not allowed; append-only is the foundation. The fix is to set `invalidated_at`, exactly like rejecting any other fact. This leaves a record on the derived fact's own timeline: "we once derived this, and later the premise was gone."

Truth maintenance is hard work in most systems (either mark-and-delete or full recompute). In this data model it is a natural extension of existing machinery — **and the entity history page (PR #37) can show it directly**, with no new UI needed.

> **Revision note (2026-09-02)**: "entity history shows it directly" **did not happen** — the `entity_history` UNION covers only facts, merges, and retypes; it does not include `derived_facts`.
> Visibility for derived facts lives elsewhere instead: a separate "derived" tab in the entity panel, and gold-colored edges in the graph reserved for derived facts (the switch disappears entirely when there are zero derived facts; edges derived through an inverse relation merge onto the same arc).
> There is also no "premise retracted" incremental step today. R3 is not done; the system fully re-derives and reconciles on a timer.

---

## Steps

### R0 · Consistency checking (produces no facts)

- Rule evaluation engine: semi-naive evaluation, plus cycle detection, plus a depth cap
- Three checks: **asymmetry violation** (a two-way `part_of`), **functional violation** (a missed case), **disjointWith violation** (waits on ontology import from 0001 P2)
- Output goes into `fact_conflicts`, reusing the existing Review UI; no new screens
- **Immediate value**: the 11 existing contradictions surface right away

The value is that the engine's hard parts (rule representation, evaluation, termination) get built and proven, at zero risk — it writes nothing to the `facts` table.

> **Revision note (2026-09-02): R0 shipped, four differences from the plan above.**
> First, **four checks, not three, and not the same three**: `self_loop`, `asymmetry`, `cycle`, `functional` (this last one also covers inverse_functional). **The fact-level disjointWith check was not built** — disjoint checking only exists in the ontology self-check.
> Second, **output does not go into `fact_conflicts`; it has its own table, `axiom_violations`.** `fact_conflicts` asks "which side is right"; an axiom violation asks "is the data wrong or is the rule wrong," resolved as `fact_retracted`, `axiom_relaxed`, or `accepted`. "No new screens" also did not hold — Review gained two tabs, `violations` and `defects`.
> Third, **an added half not in the plan: the ontology's own self-consistency** (`ontology_defects`, 8 types: symmetric and asymmetric at once, transitive and functional at once, a subclass cycle, disjoint with an ancestor, an inherited disjoint conflict, a self-inverse, an inverse that does not point back, a subproperty cycle). Reasoning: a self-contradictory ontology makes every fact-level conclusion suspect, so defects display ahead of violations.
> Fourth, cycle detection is depth-first, not semi-naive — a closure alone only tells you A derives A; a person needs the **path**. Semi-naive evaluation lives in R1.
> Also: a knowledge base with no ontology packs installed reports zero violations — that is a true result, not a bug. No axioms means no basis for judgment. The claim "11 existing contradictions" above assumed a seed ontology declaring `functional`, which no longer exists. A consistency check now runs automatically right after an ontology import, since that is when axioms just changed and recomputing matters most.

### R1 · Materialized derivation (behind a switch)

- Tables `rules` and `fact_derivations`
- Rules **compile only from ontology axioms**: `TransitiveProperty`, `SymmetricProperty`, `inverseOf`, `subPropertyOf`. No user-defined rule language — that is a different product.
- Hard priority: asserted beats derived
- A depth cap and cycle detection (proven necessary in testing)
- Derived facts are visually distinct in the graph, and can be filtered out entirely

> **Revision note (2026-09-02): R1 shipped.** Three tables: `rules`, `derived_facts`, `fact_derivations`. The switch `materialize_inferences` defaults to FALSE; `inference_interval_minutes` defaults to 60; a scheduler scans for due bases every minute and queues them. A job **logs its run time before deriving**, to avoid a failure loop; when the switch is off, the endpoint returns a clear error instead of failing silently.
> Rules compile from four axiom types: Transitive, Symmetric (#132), inverseOf, subPropertyOf (#177, #179; the projection side lives in migration `0016`). Inverse normalization happens once, at axiom load time — it only fills gaps and never overwrites a human-entered value; if the two sides point to different targets, R0 reports `inverse_not_mutual`.
> **Each predicate is capped at 20,000 derived facts, and a cut-off must be reported** (`capped`). A separate `unruled` counter, normally zero, records a bug we actually hit — rule lookup once matched by predicate instead of by `via`, so adding a cross-predicate rule silently dropped derivations.
> A `rules` row's identity is `(kb, predicate, kind)`. Removing an axiom does not delete the row — otherwise `rule_id` would change on every run and break the history trail.
> Automatic ontology growth at cold start now **declares zero axioms on behalf of the user** (`Axioms::default()`): every axiom the reasoning engine trusts must be written by a person.

### R2 · Explanation

A proof-tree API and UI, expanding down to the leaves (chunks), with derived facts and rules as internal nodes. (**Only one layer is built**: `derived_for_entity` expands direct premises into text. A recursive API and UI down to the leaves are not built; the data model already supports them.)

### R3 · Incremental maintenance

A retracted premise should invalidate its derived facts. This needs semi-naive incremental updates, not a full recompute. It is scheduled last because the first three steps can all survive on "recompute the whole base," while incremental correctness is the hardest part to verify. (**Not done.** The system fully recomputes and reconciles every time; the migration comment states plainly: "until incremental maintenance exists, every run is a full-base recompute.")

---

## Open questions

- **Intersection semantics for valid time**: premise A is valid `[2020,2023)`, premise B is valid `[2022,∞)` → the derived fact is valid `[2022,2023)`. How does a literal-valued attribute fact take part? What happens at the boundary when a closed interval meets an open one? (**Answered**: take the intersection of the half-open intervals; an empty intersection derives nothing; touching endpoints do not count as overlapping. Precision takes the coarsest of the two; confidence takes the lower of the two. **A literal-valued object never takes part** — both fetching edges and deriving require `object_id IS NOT NULL`.)
- **When to materialize vs. evaluate at query time**: measured a 4.5x blow-up (185 → 828). How does this ratio change on larger text, and at what scale should the system switch approach? (**Not settled.** The shipped approach is a per-predicate cap plus a scheduled full re-derive.)
- **The 39% `related_to` share blocks reasoning**: the reasoning engine sees a graph where almost 40% of edges carry no real meaning. This raises the priority of 0001 P3b — **the quality of reasoning's input depends on it.** Further measurement: of the 359 rows, only about 38 came from an out-of-vocabulary downgrade; **321 were `related_to` chosen directly by the model from the prompt's list** — it was offered right there as a valid ontology option. The fix has two parts: **remove this escape hatch from the prompt first**, then build the mapping step. Details in the 0001 P3b revision notes.
- **How to handle a cycle**: detecting it is only step one. Which edge should be auto-rejected? Or should both go to Review for a person to decide? We lean toward the second — both edges came from the model, and there is no prior reason to trust one over the other. (**Shipped, following that lean**: a `cycle` violation carries the full `path` into Review; R1 never derives a self-loop. The `related_to` blocker above is also gone, following [0010](0010-no-relation-is-no-relation.md) — an edge with an empty predicate never enters reasoning.)

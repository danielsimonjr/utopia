# 0016 · Close the open seams before cutting new ones

- **Status**: Planning. The first schedule set after v0.1.0.
- **Written**: 2026-09-02 (see conventions in [README](README.md))
- **Related**: this document follows a full review of [0001](0001-ontology-import-and-governance.md) through [0015](0015-recording-a-sentence-is-not-asserting-a-fact.md) against the current code; every "to do" item below traces back to one of those fifteen documents. The review itself produced the 2026-09-02 revision notes in each of them; this document only sets the order, and explains why that order was chosen.

> This document has no experiment numbers. It is an inventory: v0.1.0 shipped, the README's feature table lists twelve lines, and three of the fifteen decision records had a status line that lagged behind code shipped in the very same pull request. **Before starting the next major line of work, align what we say with what we actually do.**

## Current state, in one paragraph

One Rust binary plus Postgres: ingestion (ten formats, URL/RSS/GitHub/Jira sync, per-source token push) → hybrid search → extraction (ontology-driven, listed in full within budget, retrieved per chunk with ancestor backfill above budget, direction corrected against the signature at write time) → three-stage resolution (exact match, profile similarity, containment) with batched adjudication → a bitemporal ledger (evidence, supersedes, reversible merges) → an ontology that grows from the corpus (count-based adoption, reversible, on by default) → a reasoning engine with R0 fully built and R1 behind a switch → a semantic layer (mappings stored separately, with history) → Ask-the-Data (Ontology2SQL, sources authorized per workspace) → an agentic chat interface with seven tools, replaying its own actions across turns → a read-only MCP server with five tools and personal tokens. Five alert types, an audit ledger, per-base role permissions. About 47,000 lines of Rust, 22,000 lines of frontend code, 18 database-backed tests, 8 repeatable benchmark corpora.

**All of this is real.** So is the following:

| Half-finished piece | Source | Symptom |
|---|---|---|
| `pending_facts` has a table but no runtime; `remember` is disabled entirely | 0015 | The README lists chat memory; a user cannot use it |
| MCP has an API but no token UI | 0014 | The README lists MCP; a user cannot configure it |
| Three placeholder crates — `utopia-mcp`, `utopia-connectors`, `utopia-graph` — are three-line stubs; one claims tool names that were never implemented | 0014 | Misleads anyone reading the source |
| The proof tree expands only one layer; incremental maintenance is not built; a derived-vs-asserted contradiction logs no signal | 0002 | The README says "the derivation path expands all the way back to the sentence" — only true for one layer |
| `disjointWith` is stored, but resolution still uses a hardcoded `CONFUSABLE_TYPE_KEYS` list | 0009 / 0001 P5 | The ontology declares two types disjoint; a merge candidate can still cross that line |
| The merge path never re-checks the type signature | 0012, still to do | A direction corrected at write time can flip back on the next merge |
| Type resolution only runs manually | 0001 P3a | At ontology scale, refining a new entity depends on a person remembering to click a button |
| A Chinese-language base gets a purely English ontology; `zh.ts` has not caught up, so the UI defaults to English | 0008 / 0004 | A Chinese-speaking user sees English on both fronts |
| `merge_key` does not fold `_by` variants; narrative verbs enter the ontology | 0007 | Two opposite directions of the same relation can coexist |
| The 24,000 budget and the 40/30/30 per-chunk numbers are all marked "not yet measured"; the answer key is still hand-filled; mixed-pack accuracy is untested | 0006 / 0008 | No "improvement" can be told apart from run-to-run variance |
| Semantic-layer mappings keep no evidence; with multiple sources for one concept, the model picks with no rule | 0011 | The method behind a number is a black box |
| Mapping exploration hard-depends on the keys `metric` and `dimension`; an empty base silently returns nothing | 0009, open question | No pack installed means no Ask-the-Data semantic layer at all |
| Turning off auto-extend leaves no "new phrasings" alert | 0003 | The index is ready; the alert was never built |
| `document.no_text_layer` is not wired up; no OCR endpoint exists | 0005 | Scanned documents show all green |
| Dead code and stale comments: `graph.rs`'s `confirmed_mappings()`, the `mapped_to` join inside `confirm_fact`, the module comment at the top of `bootstrap_ontology.rs`, a wrong migration number in a `reasoning.rs` comment, a wrong migration number in a test header | 0010 / 0012 / 0002 / 0014 | The next person to read this code will believe it |

## Criteria

Use these to set future schedules, without re-arguing them each time:

1. **What we say and what we do must match.** A line in the README, a status line in a decision record, a comment in the code — when any of these disagrees with the code, fix that first, before discussing a new feature. [0015](0015-recording-a-sentence-is-not-asserting-a-fact.md) is about the assistant being honest with the user; this rule is about us being honest with the reader.
2. **Anything that writes to the graph comes before anything that only reads it.** A half-finished feature that silently changes the graph is worse than no feature at all; a half-finished read-only feature is simply a missing capability. This is why `pending_facts` is scheduled ahead of the proof tree.
3. **Do what can be measured, first.** `scripts/bench/` exists, the corpora exist; what is missing is an external answer key. Without one, any tuning of the ontology or extraction side only overfits more tightly (the open question in [0006](0006-ontology-scale-and-the-prompt.md)).
4. **Simulation and an execution gate need their foundation first.** The first two items on the README roadmap — decision replay, execution validation — are both, at their core, "**an unrecorded proposal layered on top of the ledger.**" 0015's `pending_facts` is the first piece of exactly this shape: a proposal, the original sentence on top and the triple below it, entering the ledger only once a human confirms it. Lay this piece down solidly before building anything on top of it.

## Four lines of work, in this order

### A · Close the seams — a small scope, no new concepts

**A1 · Wire up 0015.** When extraction meets a memory document (`memory::is_memory_document`, already written, zero callers), write to `pending_facts` instead of `facts`. Add a `pending` category to Review, with the UI showing **the original sentence on top, the triple below it.** Confirming writes to `insert_fact`, **without changing confidence** (the lesson from 0011: do not use a float to express a human decision — the human decision belongs in the audit trail). Rejecting writes to `rejected_facts`, checked before the next re-extraction. Change `remember`'s reply to "Recorded — N facts extracted, waiting for your confirmation." Then set `REMEMBER_ENABLED` back to true.
**Acceptance**: re-run the original test case ("Acme moved its headquarters to Shenzhen"). No empty-predicate live edge should appear in the graph; a pending item carrying the original sentence should appear in Review.
Once this is done, MCP can enable `remember` (scope = write; a token proposes as the person who issued it; the person confirms) — this settles the open question left in 0014.

**A2 · Give tokens a UI.** On the Account page: a list (prefix, name, scope, bases, last used, expiry), issuing a token (shown in plain text only once), and revocation; next to it, a copyable MCP client configuration block (URL plus an Authorization header).
Delete the three placeholder crates (done, in the same change as A3): `utopia-mcp`'s three claimed tools never existed; the real server lives in `utopia-server/src/api/mcp.rs`. `utopia-graph` has no real counterpart. `utopia-connectors`'s intent was right, but with only two connectors built, no clear boundary has emerged yet — [0013](0013-a-source-should-hand-over-its-history.md) already concluded that abstraction should wait for a third connector, and the same judgment applies to this crate. A placeholder is a promise to the reader; if it cannot be kept, remove it — `cargo new` takes minutes when it is actually needed.

**A3 · Clean up dead code and stale comments.** The five items in the last row of the table above, plus the comment above `CONFUSABLE_TYPE_KEYS` in `resolution.rs`, which still describes an old state of the world. One pull request.

**A4 · Reconcile the README with the code.** Change the reasoning line, "the derivation path expands all the way back to the original sentence," to state honestly that it covers only one layer, until B1 ships. Mark chat memory and MCP as "in development" until A1 and A2 ship. Update both the English and Chinese versions together.

### B · Finish the reasoning engine — after A, in parallel with C

**B1 · The R2 proof tree.** An API that expands recursively down to leaf chunks, plus an expandable tree in the entity panel. The data model (`fact_derivations`) already supports this.
**B2 · A derived-vs-asserted contradiction needs a signal.** Add a new kind to `axiom_violations` (`derived_contradiction`), landing in the same Review category — the one line 0002 wrote down but never built.
**B3 · Bring `disjointWith` into resolution; re-check the signature on merge.** Change `classify_type_drift` to read from `entity_type_disjoint` (falling back to today's behavior when nothing is declared, not hardcoded). Have `merge_entities` re-run the same domain/range check used at write time before moving facts over, sending a violation to `axiom_violations` instead of moving it silently. This is the same open item from both 0009 and 0012.
**B4 · R3 incremental maintenance — scheduled last.** Only build this once full re-derivation on the benchmark tool crosses a clear threshold (suggested: over 10 seconds on the `ai-timeline-ends` corpus). Full re-derivation is workable for now.

### C · Ontology and extraction quality — build the ruler before tuning anything

**C1 · An external answer key.** The open item from 0006: pair Wikipedia articles with Wikidata's `P31` as the type answer, with the generation script committed to the repository. This unlocks both the mixed-pack comparison from 0008 (`run.mjs --packs` already supports it) and the budget curve from 0006.
**C2 · Automatic triggering for type resolution.** Queue one type-resolution run at the end of extraction (alongside `bootstrap_ontology`), auto-applying only the "inside the current type's subtree" case, still routing cross-branch cases to a person. **Scheduled after C1**: without a ruler, running this automatically would only scale up noise (0001 P3's own words).
**C3 · A Chinese ontology.** Three options; leaning toward the first: when installing a pack with `ontology_lang = zh`, have an LLM batch-generate Chinese **descriptions** (the field the model reads; 0004 already established it should match the corpus language), store them in the base without touching the original IRI or `label` (a label is the display form of a key, and a key is never translated). The other two options are "wait for a community-built Chinese pack" and "do nothing, just show a note." At the same time, catch `zh.ts` up to the English pack and add `navigator.language` back to `detect()`.
**C4 · The two remaining items from 0007.** Fold `_by` into `merge_key` and mark the whole group as needing a direction swap; hand narrative-verb detection to the same LLM call already used for synonym merging ("which of these sound like the article's own narration"), kept reversible.
**C5 · The alert from 0003.** Show "N new phrasings since last time" on the Ontology page when the switch is off, computed from `ontology_misses` where `dismissed_at IS NULL`; the index already exists.

### D · Semantic layer and Ask-the-Data — after C1

**D1 · Mappings keep evidence.** Add an `evidence` field to `concept_mappings` (which table schemas were read during exploration, as an array of chunk ids), shown on the data-mappings page.
**D2 · Ship `metric` and `dimension` as a pack.** The answer to 0009's open question: build a "Utopia semantic layer" pack, carrying an IRI, optional, replaceable, installed the same way as any other pack; change `mappings.rs` to look types up by IRI instead of by key.
**D3 · A rule for multiple sources per concept.** Start with the simplest rule: if only one source is mounted, send only that source's mapping to Ask-the-Data; with multiple sources, send all of them. Keep the rule in one place, `mappings::confirmed`.
**D4 · The MySQL wire protocol.** Gains TiDB, OceanBase, Doris, and StarRocks essentially for free by swapping the `sqlparser` dialect. The item already on the README roadmap.

### E · Enterprise delivery — the bar for v0.2, can run alongside other work

- **Encrypt credentials at rest** (SECURITY.md already promises this "before 1.0"; LLM keys and connection strings get the same treatment) — small, and can be moved earlier.
- **OIDC SSO**; **backup and restore commands**; **a 100,000-document benchmark** (run it first, since the numbers matter more than the design).
- **`document.no_text_layer` plus OCR**: wiring up this alert needs an OCR endpoint first (a docling-serve sidecar); build both together, since only then is the message complete (the item 0005 left for a later batch).
- **`instant` precision**: 0013 already states the trigger condition (reporting by local business day, or a source whose events cluster near midnight); do not build this until that condition is hit.

### Scheduled later: the simulation engine and the execution gate

The first two items on the README roadmap are **not part of this schedule**, for the reason in criterion 4. They need three pieces of foundation first: the proposal semantics of `pending_facts` (A1), derivation explainability (B1), and a signal for derived-vs-asserted contradictions (B2). Once A and B are done, write a separate decision record and schedule them then.

## The order, in one line

**A → B and C in parallel → D → E.** A aligns what we say with what we do, adding nothing new. B and C do not depend on each other — B touches the paths that write to the graph, C builds the ruler. D waits on C1's ruler. E can run alongside other work, with encryption moved earlier.

## One new rule

**The status line is the responsibility of the pull request that implements the change.** The status lines in 0011, 0014, and 0015 all lagged behind code shipped in the very same pull request — the person writing the decision record and the person writing the code were the same person, in the same commit, and it still slipped through. So do not rely on memory: the PR template now includes a line asking "which decision record does this implement or overturn, and is its status line updated?" Already added to the conventions in [README](README.md).

## Open questions

- **Should A1's gate block only memory, or every single, interactive write?** Left open in 0015. Today `remember` is the only such path, so block that first; when a future UI adds "manually add an edge to the graph," route it through the same table.
- **Does the Chinese description generated in C3 count as an exception to "keep the raw source"?** It is not imported raw text, it is a projection we generate ourselves. Leaning toward treating it as a projection (re-runnable, disposable), while the original IRI and English description stay untouched in the pack.
- **B4's threshold**: the 10-second figure is a guess.
- **Whether to split the extraction layer out of `utopia-server`.** About 6,500 lines of domain logic today (extraction, type_resolution, bootstrap_ontology, predicate_match, adjudication, owl_import, connectors) live inside the HTTP crate, though the dependency direction stays clean, one way. Discussed (2026-09-02) and decided **not to split it**: the only concrete benefit would be testing pure functions apart from the server, and their unit tests already do not depend on the server today. Moving 1,500 lines of `extraction.rs` would also make the diff and blame history for the immediately following A1 harder to read. The rule to apply later: **split it once it causes a real cost, defined as "something that cannot be tested apart from the server."** The boundary for connectors waits for a third connector (Feishu) to arrive.
- **Once the 100,000-document benchmark runs**, its result decides where the single-process worker and the embedded Tantivy index hit their ceiling, which in turn decides whether horizontal scaling belongs in v0.2. Not a topic for now.

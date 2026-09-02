# Decision records

Code records **what we built**. Git records **when we changed it**. Neither records **why we chose this and not that**, or **which paths we tried that turned out to be dead ends**. This directory records that.

Use this test: if someone, six months from now (possibly us), looks at a piece of code and asks "why didn't we just do it the other way," and the code cannot answer — write a decision record.

## Conventions

**File names** follow `NNNN-short-english-title.md`, with a four-digit number assigned in creation order, with no gaps. The number is a stable reference anchor. It does not signal priority.

**Keep this directory flat.** Do not add subdirectories until a second, genuinely different kind of document appears.

**Revise in place. Never silently rewrite.** When a conclusion changes, especially because further checking overturned an earlier judgment, **keep a "revision" block in the original spot.** State clearly: what the text used to say, why it was wrong, and what evidence drove the change. Do not delete the earlier, incorrect version.

> This is not a documentation habit. It is the same product principle applied to our own writing. The ledger in this product never updates a fact in place. A correction is a new row plus a `supersedes` link to the old one, because **a change in understanding is itself information.** The same rule applies here. Knowing "we once believed a time range would apply immediately, and later found that not one case actually did" is more useful than seeing only the final answer. It tells you what to check first next time.

**When a conclusion changes substantially**, write a new document. Mark the old one at the top as "superseded by NNNN," instead of editing the old one to look like the new one.

**The status line is the responsibility of the pull request that implements it.** The status lines in 0011, 0014, and 0015 all lagged behind code shipped in the same pull request. The person who wrote the decision record and the person who wrote the code were the same person, in the same commit, and the lag still slipped through. So a PR description must answer one question: which decision record does this change implement or overturn, and is its status line updated? (Added 2026-09-02; see [0016](0016-close-the-open-seams-before-cutting-new-ones.md).)

**The server is TypeScript.** Implementation lives under `server/`. Older records still name Rust files. Prefer a function name, a table name, or a constant name when you cite code.

**Line numbers drift, and file names change.** A `file.ts:123` reference in this text reflects the coordinates at the time of writing. It is not guaranteed to still be accurate. Pull requests #130 and #131 folded the migrations from 53 files down to 10, one file per domain. Because of this, any migration file name written before 2026-08-31 needs a fresh lookup by domain.

## Index

| | Document | Status |
|---|---|---|
| 0001 | [Ontology import and governance](0001-ontology-import-and-governance.md) | In progress. P0 through P2c are fully built. P3 ships by budget; P3a runs only manually. P3b is built but shaped differently than planned. P4b and P4c are still to do. P5 is delivered by 0002. Half of criterion 2 is overturned by 0012. |
| 0002 | [Reasoning engine](0002-reasoning-engine.md) | R0 is built, including the 8 ontology self-check types. R1 is built, behind a switch, off by default. **R2 has only one layer; R3 is not built.** No signal exists yet for a derived-vs-asserted contradiction. |
| 0003 | [The ontology grows from the corpus: where the human sits](0003-ontology-growth-loop.md) | Built and still running. Its starting point is rewritten by 0010 (removing `related_to`) and by seed retirement. "Rejection has memory" was overturned and rebuilt by 0007. An alert for new phrasings is still to do. |
| 0004 | [Language: what follows the reader, what follows the source text](0004-language-and-localization.md) | Built. L0 through L3 are all live. The UI deliberately does not guess the browser language. "A built-in Chinese ontology" is obsolete, retired along with seeding. |
| 0005 | [Alert center](0005-alert-center.md) | Built. Five alert types. Two of the original three decisions were overturned, with the revision kept in place. `no_text_layer` is still not wired up. |
| 0006 | [Ontology scale and the extraction prompt](0006-ontology-scale-and-the-prompt.md) | Built. "Seed types always present" was replaced by ancestor backfill. The budget and candidate-count numbers are still not properly measured. No external answer key exists yet. |
| 0007 | [Who decides a phrase deserves to become a relation](0007-who-decides-what-becomes-a-relation.md) | Built. All six defects are fixed. The starting point (seed relations, the `related_to` share) no longer exists. `_by` folding and narrative verbs are still open. |
| 0008 | [Ontology packs as cold start](0008-ontology-packs-as-cold-start.md) | Built. Five packs are embedded, multi-selectable, with a 22-row alignment table. All three open questions are still open, and the Chinese-labels one has gotten worse. |
| 0009 | ["Not yet classified" should not be a type](0009-no-type-is-a-type.md) | Implemented. `disjointWith` is stored but resolution does not yet read it. Where `metric` and `dimension` belong is unanswered and now has a visible cost. |
| 0010 | ["Cannot state a relation" should not be a relation](0010-no-relation-is-no-relation.md) | Implemented. Both "to do" items are complete, delivered together with 0011. |
| 0011 | ["How to compute it" is not "what exists"](0011-a-mapping-is-not-a-fact.md) | Implemented (#126, #140, #148). The evidence chain is not built. A rule for multiple sources per concept is not built. |
| 0012 | [The ontology is a contract, not a suggestion](0012-the-ontology-is-a-contract-not-a-suggestion.md) | Implemented. The violation rate fell from 57% to 4%; reversed facts fell from 39 to 0. All three "to do" items are still not done. |
| 0013 | [A source should hand over its history, not just its current state](0013-a-source-should-hand-over-its-history.md) | Implemented for two sources (GitHub, Jira). Document-collaboration sources have not started. |
| 0014 | [Identity comes from the person; scope comes from the token](0014-identity-from-the-person-scope-from-the-token.md) | Implemented (#180). MCP exposes five read-only tools. **There is no token UI yet.** The three placeholder crates are removed. |
| 0015 | [Recording a sentence is not the same as asserting a fact](0015-recording-a-sentence-is-not-asserting-a-fact.md) | In progress. The schema is built; **the runtime has zero wiring.** `remember` is disabled entirely as a temporary gate. |
| 0016 | [Close the open seams before cutting new ones](0016-close-the-open-seams-before-cutting-new-ones.md) | Planning. This sets the schedule for the work after v0.1.0. Track A closes the seams. Track B (finish the reasoning engine) then runs alongside track C (build the ruler, then tune the ontology). Track D (semantic layer) and track E (enterprise delivery) follow. The simulation engine comes later. |

## What is not a decision record

**[../pipeline.md](../pipeline.md) — how a document becomes a graph.** A decision record explains "why this, not that." That document explains "how the data flows, and where it can be lost." It has five mermaid diagrams, plus a sixth for axioms, added 2026-09-02. Read it first if you are new here. Then come back to this directory for the reasoning behind it.

This is the "second, genuinely different kind of document" mentioned in the conventions above. It stays outside a subdirectory. It lives at the root of `docs/`, with its own exception carved out in `.gitignore`, alongside `decisions/`.

## What does not belong here

The root of `docs/` is a **local scratch area** (`.gitignore` excludes `/docs/*`, with an exception only for `/docs/decisions/`). Keep informal research notes, temporary lists, and test output there. Do not commit them. Once a piece of scratch work produces a judgment worth keeping, turn it into a decision record and move it here.

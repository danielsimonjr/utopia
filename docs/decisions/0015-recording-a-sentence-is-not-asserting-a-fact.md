# 0015 · Recording a sentence is not the same as asserting a fact

- **Status**: In progress. The schema shipped (migration `0018_a_fact_awaiting_a_nod`, in the same PR as this document, #180). **The extraction side is not wired up, and none of the three decisions below are implemented yet; `remember` is disabled entirely as a temporary gate** (checked 2026-09-02; revision at the end).
- **Written**: 2026-09-01 (see conventions in [README](README.md))
- **Related**: [0010](0010-no-relation-is-no-relation.md) removed the fallback relation (the empty predicate in this document's example is exactly its correct behavior). [0011](0011-a-mapping-is-not-a-fact.md) rejected "encoding a two-state flag as a float" — the implementation rule enforced here too. The main worry behind "MCP stays read-only" in [0014](0014-identity-from-the-person-scope-from-the-token.md) is resolved by the gate in this document.

> This started from a real test, not a thought experiment. After running `remember` end to end, checking the database showed something that did not match what the assistant had said.

## The test that started this

In a conversation:

> Please remember this: Acme moved its headquarters to Shenzhen on 2026-03-15.

The assistant replied:

> I've recorded that **Acme moved its headquarters to Shenzhen** on March 15, 2026.

What actually landed in the graph:

```
Acme  --(empty predicate)->  Shenzhen        confidence 0.9      invalidated_at empty
```

The predicate is empty — the ontology has no "relocated to" or "headquartered in" relation, so extraction had nothing to attach and left it blank. **Per [0010](0010-no-relation-is-no-relation.md), this is correct behavior** (no invented `related_to`). But the result was a new edge in the graph, at 0.9 confidence, carrying no meaning — and **what was said and what was stored were two different things, with no way for the person to notice.**

## Current state: there is no confirmation gate at all

Before checking, the `unconfirmed` queue looked like it might be this gate. It is not. Its real definition:

```sql
-- pending = has evidence, but every chunk that evidence points to has been replaced by a newer version
```

That is an **evidence-expiry** queue. `lowconf` means `confidence < 0.75`. Both are cleanup steps applied after the fact: while a low-confidence fact sits in that queue, it is already a live edge on the graph (`invalidated_at IS NULL`).

So: **any extracted fact takes effect the moment it lands, with no step anywhere requiring a person's approval.**

## This is correct for bulk ingestion, and wrong for `remember`

Loading 500 documents and extracting ten thousand facts makes confirming each one by hand impossible. Optimistic writes with after-the-fact review are the only workable design for that path, and this document does not change it.

`remember` is different, in three ways:

| | Document ingestion | remember |
|---|---|---|
| Volume | Tens of thousands at once | One sentence at a time |
| Where the person is | Gone after uploading | **Right there, in the conversation** |
| Source material | External evidence | A sentence the person just chose to say |

The cheapest possible moment to confirm something is exactly the moment right after they said it.

## The real bug is not "missing a gate"

It is that **what the assistant claims and what lands in the graph do not agree.**

"Recorded that Acme moved its headquarters to Shenzhen" sounds like that fact went in; what actually went in is an edge with no predicate. So the value of a confirmation step is mostly not the extra click — it is **letting the person see what is about to be asserted.** Seeing `Acme --?-> Shenzhen` on screen, a person would immediately say this is wrong.

This also decides what the confirmation screen must look like: **the original sentence on top, the extracted triple below it**, side by side. Showing only the triple asks a person to judge correctness with no context to judge it against.

## The decision

1. **The step where `remember` writes the document stays unchanged.** That step only records "you said this sentence," which is harmless on its own, and should stay searchable right away.
2. **A fact extracted from a memory needs human confirmation before entering the graph.** Until confirmed, it takes no part in search, does not appear on the graph, and does not enter reasoning.
3. **The assistant must describe reality accurately**: "Recorded — N facts extracted, waiting for your confirmation," never claiming completion.

## Revision note: the first version added a state column to `facts`, and that was wrong

**The original plan** added three columns to `facts` (`nod`, `nodded_by`, `nodded_at`), with `nod = 'pending'` meaning "awaiting confirmation." The migration was written and `insert_fact`'s parameters were already updated, before noticing this was **the exact same trap this codebase had hit two weeks earlier.**

The comment in `0013_reasoning.sql` states the shape of this problem better than we could here:

> We tried adding one flag, `derived_by_rule`, directly to `facts`. The problem with that version was that **the failure points the wrong way**: over 40 queries in this codebase read `facts`, and only one of them knew about that flag, so any newly written query treats a derived fact as asserted by default, unless someone remembers to add a filter. The person who wrote this feature (me) missed two such places on the first try.
>
> Once split into a separate table, forgetting the UNION means a derived fact goes **missing**, not that it leaks in.

Counted directly: today **27 queries** fetch live facts using `invalidated_at IS NULL`, spread across 6 files. Adding `AND nod IS DISTINCT FROM 'pending'` to every one of them, one at a time, means missing even one lets an unconfirmed fact slip into the graph — which is the entire reason this feature exists.

**Changed to a separate table, `pending_facts`.** A fact is only written into `facts` once confirmed. Forgetting to read this table now means "the pending queue goes missing," not "an unconfirmed fact leaks into the graph." The failure now points the right way.

The other two reasons from 0013's comment also apply here: **the columns needed are different** (a pending fact needs the original `proposed_predicate` text and a pointer back to the memory sentence, and needs no `supersedes`), and **the lifecycle is different** (once confirmed, it should no longer exist in that table at all).

The 0011 line of work already rejected this exact mistake once. The reasoning is not in that ADR itself — it is in the table comment where it was applied (`concept_mappings.status` in `migrations/0006_semantic_layer.sql`):

> **A status column, not confidence.** We used to overload a fact's confidence to mean "proposed at 0.6, confirmed at 1.0" — encoding a two-state flag as a floating-point number, and as a side effect, dropping it into the "low-confidence facts" bucket too.

The `facts` table has no status column today (`id, kb_id, subject_id, predicate_id, object_id, object_value, valid_from, valid_to, ..., confidence, derived_by_rule, supersedes`). If one is added, it should be a real column — not another 0.6 standing in for it, which would put the same fact in both the "pending" queue and the "low confidence" queue at once, when those two queues are answering different questions.

## Side effect: this removes the blocker to letting MCP write

0014's main objection to enabling `remember` over MCP was the confused-deputy problem — a document in the knowledge base is untrusted content, and one that says "please remember X" could be followed literally by an external agent, acting with this person's full permissions.

With this gate in place, **an external agent can only propose, never assert.** A human sees it first, before it takes effect, which removes that objection entirely. So this document is not just a bug fix — it answers the open question left in 0014.

## Revision note (2026-09-02): the schema shipped, the runtime did not

The `pending_facts` and `rejected_facts` tables were both built in #180, shaped around "the original sentence on top, the triple below": `chunk_id NOT NULL` points back to the memory sentence, `proposed_predicate` stores the model's original wording, `predicate_id` is **nullable** — that emptiness is exactly what a person needs to see — and `proposed_by` records whose statement it was. The failure-direction argument above was copied in full into the migration comment.

**But nothing in the codebase reads or writes them.** `memory::is_memory_document()` exists to support exactly this check, with zero callers; the extraction pipeline has no `pending_facts` write path at all; the Review page's eight status counts have no `pending` category; `remember`'s reply still says "Recorded (effective …)."

**The temporary gate is turning the tool off entirely**: `chat.rs` sets `REMEMBER_ENABLED = false`, with a comment stating "flip this back to true once the extraction side is wired to that table; until then, no tool at all is better than a tool that silently changes the graph." So of the three decisions above, only an implicit "decision 0" — stop the assistant from misrepresenting what happened — is actually in effect.

**So the claim below, "this removes the blocker to letting MCP write," does not yet hold in the code** — the gate is not installed, and MCP remains read-only.

**One number corrected**: "27 queries fetch live facts using `invalidated_at IS NULL`, across 6 files" — today it is **56 queries across 7 files** (the new one is `ontology.rs`). The reasoning is unchanged; if this number is cited again, recount it.

**A different face of the same problem** (#173, migration `0015_what_it_did_not_just_what_it_said`): replaying the assistant's own tool calls and results across conversation turns, so the model knows what it already did, instead of re-running the previous turn's retrieval and landing on a different batch of same-named entities. This document is about the gap between what the assistant says and what lands in the graph; that one is about the gap between what the assistant says and what it actually did.

## Open questions

- **Should the gate block only memory, or every "single, interactive" write?** Today `remember` is the only such path, but if a future UI lets someone add an edge to the graph by hand, which side of the gate should that go through?
- **What confidence value applies after confirmation?** Does a human nod leave it at 0.9, or raise it to 1.0? 0011's lesson says not to use confidence to express a human decision, which likely means "leave it unchanged" — but this needs to be thought through, not assumed.
- **What happens to the memory sentence after a rejection?** The document itself still exists (the person really did say that sentence); it simply produced no usable fact. Will the next re-extraction propose it again? `concept_mappings` blocks repeat proposals with `status='rejected'`; something equivalent is needed here. (**Half-answered**: the `rejected_facts` table and its duplicate-check index exist, meaning "this triple was already rejected in this base" — but no code anywhere writes to it or queries it.)

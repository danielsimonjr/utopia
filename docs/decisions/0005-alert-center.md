# 0005 · Alert center

- **Status**: Shipped. Five alert types are live (`source.sync_failed`, `llm.unreachable`, `llm.rate_limited` #160, `llm.out_of_credit` #182, `data_source.schema_sync_failed`), with a panel supporting search and grouped pagination. Decisions 1 and 2 below were each overturned during implementation; the revision stays in place. `document.no_text_layer` is still not wired up (checked 2026-09-02).
- **Written**: 2026-08-29
- **Related**: adjacent in responsibility to the Review queue (0001 P4); this document draws the boundary between them.

---

## Why

Failure states are scattered across six places today, each with its own fields, with no single place to see them all:

| Location | Records |
|---|---|
| `jobs.status='failed'` plus `jobs.last_error` | A job failed — **no UI shows this at all.** (Now: a job that **finally** fails, meaning `attempts >= max_attempts`, and whose error can be classified, becomes an alert through `observe_job_failure`. Nothing is reported during retries, since retries exist precisely to avoid bothering a person.) |
| `documents.status='failed'` | Ingestion failed |
| `documents.graph_status='failed'` | Extraction failed |
| `sources.last_sync_status='failed'` | A source's most recent sync failed |
| `source_sync_runs.status='failed'` | One sync run failed |
| Logs | Everything else |

This problem **was already partly fixed once.** Migration `0021_graph_error.sql` (later folded into `0002_ingest.sql`'s `graph_error` column after #130/#131) opens with:

> Extraction failures used to go only into logs and `jobs.last_error`; the document itself kept no trace, so the UI had nothing to show.

That fix added an error field to `documents`. **This is a patch.** Each new kind of failure gets its own column on its own table. The reasoning layer, the execution layer, an OCR endpoint, and lakehouse connections have not shipped yet, and each will bring its own kind of failure. Following this pattern leads to a dozen error columns scattered across a dozen tables, with the user still having no single place to ask "what is wrong right now."

The real damage is not the failure itself, it is a **silent** failure. Drag in 100 PDFs, 12 of them scanned images, and the UI shows all 100 as green — the user believes everything landed, until the day they ask a question and the answer is missing that one contract, with no reason to suspect ingestion at all.

---

## The boundary with the Review queue

Both look like "a list of pending items." Without a clear line, they compete for the same attention.

| | Review queue | Alert center |
|---|---|---|
| Nature | A person must **make a decision** | A person must **be told** |
| Example | Should these two entities merge? Should this low-confidence fact be kept? | This document did not ingest. This source cannot connect. This endpoint is down. |
| Cost of ignoring it | Knowledge stays half-formed | **You believe it landed, and it did not** |
| Who raises it | Extraction and resolution, when uncertain | Any execution path, on failure |

In one line: **Review is about right and wrong in the knowledge. Alerts are about the system being alive or not.**

---

## Three decisions

### 1. Grouping belongs in the view layer, not in the table

> **Revision note**: this decision first read "only one open row per alert kind," making `(kb_id, kind)` unique in the table, folding repeated failures into one row and appending to a `subject_ids` array.
> **The first half was right. The second half was wrong**, and it is the root cause of the state machine problem in decision 2.

Drag in 100 PDFs, 12 scanned, and the UI should read **one** line: "12 documents have no text layer" — not 12 separate lines. An alert center with no grouping stops being read within two weeks; this is not a nice-to-have, it decides whether the feature works at all. That much still holds.

**But grouping must be computed on read, never stored.** A grouping stored in a table is **alive**, and a live thing needs upkeep: once something is fixed it must be removed from the array, and forgetting to remove it is a lie. And "when is something fixed" is exactly the trap in decision 2 below. The first implementation stored the grouping, and all three bugs it produced traced back to the same root: the row got emptied out piece by piece during self-healing, until it could no longer say what it had originally been about (`subject_ids` and `detail` both empty), while still generating a title like "0 sources failed to sync."

The current approach: **store one row per failure; fold adjacent rows sharing the same `(kb, kind)` into one group at read time.** Folding happens in SQL (a gaps-and-islands pattern, subtracting two `row_number()` calls), because pagination must work by group — folding on the frontend would split one continuous run of failures across a page boundary into two groups, and clicking one would only mark up to the boundary. The count is always computed fresh and can never go stale.

Only **adjacent** rows fold together: a gap in between means it belongs to a different span of time and should not merge in.

### 2. "Is it fixed yet" is not a question the alert center should answer

> **Revision note**: this decision first read "self-healing should take priority over manual dismissal," reasoning that "an alert that never resolves itself trains users to ignore it fast." **That concern was real, but this fix was wrong**, and wrong in an expensive way — the whole section is overturned, and it stays here because the idea is tempting enough that someone will propose it again if it is not recorded.

Original plan: `resolved_at` would be cleared by whatever produced the alert. Once the OCR endpoint was configured and the 12 documents reprocessed successfully, the alert would disappear on its own.

**It requires every new alert type to implement its own answer to "how do we know this is fixed."** The very first two alert types already needed two different mechanisms: `source.sync_failed` has a natural success signal (`finish_sync` uses the same exit point for success and failure, essentially free); `llm.unreachable` has none, so it would need a dedicated background probe — hitting the endpoint every minute, and first checking "is this alert even still lit" before sending a request, or a healthy deployment would spin uselessly. A third alert type would need a third mechanism. **A missing clear-condition is invisible at compile time**, and its symptom is an alert that stays lit forever — exactly the failure this feature exists to prevent.

A deeper problem: **this is not the alert center's job.** Whether something is broken right now is already shown on the source's page and in the document's status. The alert's job is to make someone look, not to serve as a live dashboard.

So what about users learning to ignore it? Solve it by **writing a new row per failure**: once something is fixed, no new failures appear, the old ones sink out of view as they are read, and the badge clears on its own. If it breaks again two months later, that is a new alert, and the badge lights up again. No success signal, no probe, and no time constant needed anywhere.

There is exactly one cost, and it is real: **row count.** A source syncing hourly while broken writes 24 rows a day. So rows expire after a retention window (30 days, `alerting::RETAIN_DAYS`) — without cleanup, this table would grow into a second log file.

> We also considered de-duplicating by `(kb, kind, subject)` and just bumping a timestamp on repeat: bounded row count, no retention window needed.
> **Rejected**, because it makes "this recurred" and "this never got fixed" indistinguishable in the data, short of adding a clock or a success signal — forcing a choice between two bad options: read-once-means-read-forever (silent on recurrence two months later — **a missed report**), or any timestamp bump reopens the alert as unread (an hourly-failing known issue relights constantly — **noise**). A missed report costs far more than extra rows.

### 3. Read state is per person (this one needed no changes)

**This decision overturned a simpler-looking alternative, and the reasoning is worth keeping.**

Rejected alternative: any admin opening an alert marks it read for everyone. It looks like it avoids duplicate work.

How it fails:

> A knowledge base has three admins. A opens an alert in passing in the morning and does not act on it. The alert **disappears permanently** from B's and C's unread lists — they never learn it happened, while A was thinking "I'll deal with it later."

This is the classic failure of shared read state: **everyone assumes someone else is handling it**, and afterward, nothing shows that it was missed.

The root cause is conflating two different things: **"read" is whether I personally saw it; "resolved" is whether the underlying problem is over.** One person reading it does not mean the problem is solved.

> **Revision note**: the original text continued, "and once the problem is resolved, that is the moment everyone should see it drop from their list," listing "the alert disappears when `resolved_at` is set, for everyone at once" as the other half of read state alongside per-person read status.
> **That half is gone**, along with decision 2 — there is no "resolved" state, and an alert never disappears on its own; it only sinks with time and gets cleared on expiry. The part of this decision that truly holds is **per-person read state**, and that part is unchanged.

So: **unread = an alert visible to me that I have not clicked** — tracked independently per person, in a small two-column table. What this buys is **no one can mark something read on someone else's behalf.** GitHub notifications and Slack unread counts work the same way, and that is not a coincidence.

---

## Visibility

`kb_id` is nullable, with two meanings:

```
kb_id IS NULL   System-level: the LLM endpoint is unreachable
                (today, three LLM alerts: unreachable / rate-limited / out of credit)
                → visible only to users.is_admin

kb_id set       Knowledge-base level: a parse failure, an extraction failure, a source sync failure
                → visible to anyone with role >= min_role in that base
```

**No new permission logic needed**: `access::kb_role()` already opens with `if user.is_admin { return Ok(Some(Role::Owner)) }`, so alert visibility reuses it directly, through the same authorization chain as KB routes. A system admin therefore also sees every knowledge-base-level alert.

> **Revision note (2026-09-02)**: the conclusion holds (an admin sees everything; visibility compares against `min_role`), but "no new logic" did not hold in practice.
> Listing alerts needs a per-person filter inside one SQL query, so it ended up using `access::visible_kb_roles()`, plus a `VISIBLE` CASE expression in `alerts.rs`, plus a `rank()` call — the code comment admits this outright: "must stay in the same order as `Role`'s `PartialOrd`, and the same order as the `VISIBLE` CASE; all three must agree." Recorded here because this is exactly the kind of hidden rule this codebase tries hardest to avoid: reordering roles means remembering to update three places.

`min_role` is stored on each alert instead of hardcoded per kind, because the same alert kind needs a different audience depending on the case:

- **Configuration issues** (an endpoint, permissions, a quota) → admin
- **Content issues** (a parse failure, an extraction failure, a source sync failure) → **editor and above**

Content issues cannot go to admins only. Take a scanned document: an admin needs to know "OCR should be configured," but **the person who uploaded those 12 files** needs even more to know "what you uploaded did not go in." Restricting this to admins only would hide it from exactly the people most affected.

---

## Data model

> **Revision note**: this section was originally a draft including `subject_ids UUID[]`, `resolved_at`, and a partial unique index on `WHERE resolved_at IS NULL`. It became obsolete along with decisions 1 and 2 above.
> **We do not restate a schema here** — a draft schema that no longer matches the migrations is worse than no draft at all.

See [`migrations/0009_alerts.sql`](../../migrations/0009_alerts.sql) for the real definition. In shape:

- `alerts` has one row per failure, written once and never edited afterward. `subject_id` is a **single column, not an array** — one row describes one object, with `detail` storing a snapshot of its name at the time, so the alert still displays correctly even after that object is deleted.
- `alert_reads` has two columns, tracked per person.
- No unique index, no `resolved_at`, no state machine.

One trap the draft got right and is worth keeping: **rows where `kb_id IS NULL`.** The original plan used a partial unique index on `WHERE resolved_at IS NULL` for grouping, but NULL is excluded from uniqueness checks, so every system-level alert would have inserted a new row on every report — grouping would silently fail for exactly the category that needed it most. That trap no longer exists, since there is no unique index anymore, but **the same class of bug shows up elsewhere**: `mark_group_read` compares `kb_id` with `IS NOT DISTINCT FROM` rather than `=`, guarding against the same NULL behavior.

**Push notifications** reuse the existing `AppEvent` broadcast (with a new `alert` kind). But SSE routing is **per knowledge base** (`/kbs/{id}/events`), while the badge spans every base and a system-level alert has no base at all — so a separate global stream, `/alerts/events`, was added. That stream **carries no data and checks no permissions**: anyone who receives an event simply re-fetches, and the list query is the single place that decides who can see what. The cost is that a user with no access is also woken up once; the benefit is that the push path carries zero permission logic.

---

## Scope of the first cut

**Do not build an empty framework first.**

A migration is the hardest part to walk back. Ship an empty table, and by the time real data flows through it, the schema may turn out wrong (should grouping use an array or a join table, should `min_role` live on the row or be hardcoded per kind), and fixing a migration after release means an upgrade path. No version has been tagged yet, so migrations can still be redone from scratch — that window should not be spent on a table no data has ever passed through.

More importantly: **grouping, self-healing, and per-user read state — the three easiest things to design wrong — can only be checked once real data flows through them.** An empty framework defers all three to later.

> **This turned out to be true, in a way stronger than expected**: once real data flowed through, two of the three designs turned out wrong — and both were only caught by writing them, running them, and watching them fail. Had an empty framework shipped first, waiting for a second and third alert type before connecting real data, both wrong designs would already have gone out in a migration.

So the first cut wires up **two real alert sources**, each testing one permission path, and neither needing new detection logic:

| Kind | Level | Tests | Result |
|---|---|---|---|
| `source.sync_failed` | KB level | Grouping, self-healing, `min_role=editor` | Grouping moved to the view layer; self-healing scrapped; permissions worked as designed |
| `llm.unreachable` | System level | The `kb_id IS NULL` path, `is_admin` visibility | It has no success signal — this is exactly what forced the reversal in decision 2 |

> **Follow-up (checked 2026-09-02)**: three more alert kinds shipped after the first cut, **none needing new detection logic** — each just wires up an error classification that already existed:
> `llm.rate_limited` (#160, still failing after backoff is exhausted), `llm.out_of_credit` (#182, a 402 status or "insufficient balance" message, kept separate from rate limiting since the right audience differs), and `data_source.schema_sync_failed` (a source connects, but its table schema failed to sync). Classification is one pure function, `alert_for`, with unit tests, because the rule keys on the error's **type**, not its text. This last one is worth noting: it reports **a standing state**, not **a single failed run** — the first alert not triggered directly by one execution failure, which does not quite match "any execution path reports on failure," stated above.
>
> The panel also gained search and grouped pagination (8 groups per page, up to 5 detail rows per group). Search **deliberately cannot match a title** — a title is built on the frontend from a lookup table keyed by kind ([0004](0004-language-and-localization.md): the server must not produce display text). The server can only match against a base name, a detail string, or a kind code.
>
> **One boundary this document should have drawn and did not**: `extraction_drops` (11 discard reasons, read by the person who uploaded the document) is a fully separate failure channel. Its division of labor with alerts is "something in this document did not land" versus "something in the system is broken" — the former groups on the document's row in the library, the latter goes to the bell icon. Neither goes into Review: Review is about right and wrong in the knowledge, not about failures.

**If the design had a flaw, this cut would surface it** — and it did, twice, recorded in the two revision notes above.

The rule for `llm.unreachable` was also loosened once during implementation: at first it only caught transport-layer failures (cannot connect at all), and the most common real failure — a wrong URL, or a proxy in the middle returning an HTML page — **produced no alert at all**, which is exactly the "silent failure" this feature exists to prevent. It now means "failed to get a parseable answer from the endpoint": either it cannot connect, or it connects but the response is not from this API. A clean 4xx response from the endpoint does not count — that means it is the right model API, just a wrong key or quota, and needs a different audience.

UI: a bell icon in the top bar, opening a **popover panel**, not a full page — an alert is something to glance at in passing; a full page would force someone to leave what they are doing, and that cost means fewer people look at all. Unread is a red dot, not a number ("something unseen" is binary; a number would keep climbing with every retry). **Reading counts only on a click, not on a hover** (a mouse passing over a list of alerts does not mean they were seen, and a read mark, once set, does not come back on its own).

### Left for a later batch

**`document.no_text_layer` (a scanned document)** — this needs detection logic first (checking whether the parse result came back empty), and it becomes genuinely useful only once an OCR endpoint exists: only then is the message complete — "this document has no text layer; configure an OCR endpoint and reprocess it" — both an explanation and a call to action.

When this ships, **do not bring back "when is it fixed" thinking** (see decision 2). One scanned document with an empty parse result writes one row; 12 documents write 12 rows; the panel folds adjacent ones into a group with a count. Once reprocessing succeeds, nothing needs to be cleared — no new failures appear, the old rows sink out of view, and expiry clears them in time.

---

## Rejected alternatives

**Reuse `audit_events`.** That table is a ledger of "who did what," meant to be immutable; alerts are "what went wrong," needing per-user read state and grouped display. Putting them in one table would stop the ledger from being a ledger.

> **Revision note**: the original reasoning here was "alerts need a state machine (unread → read → resolved)." The state-machine part is gone along with decision 2 — an alert row is also immutable now.
> **The conclusion is unchanged, for a different reason**: the ledger records what a person did, an alert records what the system got wrong. They differ in retention (alerts expire after 30 days; the ledger never does), in visibility rules, and in audience.

**No new table; query and display the union of the six existing failure states.** Zero migrations, zero new concepts — but this cannot hold per-user read state, and it loses history: once a source is fixed, `last_sync_status` changes, and "why did last Wednesday's sync fail" can no longer be answered.

**Shared read state.** See decision 3 above.

**Storage-layer grouping**, **self-healing plus a probe**, and **de-duplication by `(kb, kind, subject)`**. See the revision notes under decisions 1 and 2 — the first two were built, then torn out; the third was rejected on paper before being built at all.

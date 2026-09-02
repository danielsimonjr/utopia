# 0013 · A source should hand over its history, not just its current state

- **Status**: Implemented for two sources (`github_issues` #134, `jira_issues` #135). Document-collaboration sources (Feishu, Confluence, Notion) have not started; `instant` precision has not been needed yet (checked 2026-09-02; every other statement below was re-checked and still holds).
- **Written**: 2026-08-31 (see conventions in [README](README.md))
- **Related**: the bitemporal foundation in [0001](0001-ontology-import-and-governance.md); the same judgment applied on the corpus side in `scripts/bench/fetch-wiki-history.mjs` (#122); [0012](0012-the-ontology-is-a-contract-not-a-suggestion.md) covers the other half of the same problem — this document is about **how data comes in**, that one is about **what rules apply once it lands**.

## The test: is a source worth connecting

This product is a bitemporal ledger, so a candidate source is judged on four points; missing any one turns it into "just another web scraper":

1. **Does it carry real timestamps** — this is what the recorded-time axis depends on
2. **Does it revise itself over time** — `supersedes` needs something to act on
3. **Does it have a stable identity** — a new version of the same item must be recognizable (`external_key`)
4. **Does real enterprise knowledge actually live there**

A ticketing system passes all four: every ticket's status changes over time by nature, and its signal-to-noise ratio is far higher than a chat log.

## The core judgment: capture change, not just current state

**A ticket's most valuable part is not "it is currently closed"** — it is "opened on Aug 18, closed on Aug 20, assigned to someone in between, priority changed along the way."

Capturing only the current state means this timeline can only be rebuilt slowly, one sync at a time — the first sync can only see the present moment, and everything before it is lost. Most systems **already have this change history ready**; it only takes one more request to ask for it.

This is the same judgment applied to the Wikipedia corpus in #122. The difference: Wikipedia needs sampling from a revision list, while a ticketing system hands over change events directly.

The shape once it lands in document text (consistent across both sources, deliberately):

```
# KAFKA-9 Consumer logs ERROR during close

Type Bug.
Currently Closed.
Resolved on 2011-07-19.

## History
- 2011-08-05 — Alan Cabrera changed Workflow: jira → no-reopen-closed
- 2015-09-01 — Tony Stevenson changed Workflow: no-reopen-closed → Apache Kafka Workflow

## Comments
### Luke Chen on 2026-08-24
…
```

**The header is written as a dated sentence, not a key-value pair.** "Opened by X on 2026-08-18" lets the extractor produce a fact with a `valid_from`; "created_at: 2026-08-18" forces the model to guess what that field means.

## Two vendors, two different lessons

| | GitHub | Jira |
|---|---|---|
| Fetch method | 3 API calls, plus events **fetched per ticket** | **One call** returns everything (`expand=changelog`) |
| Incremental sync | A `since` parameter | JQL query `updated >= "…"` |
| Change history | Event-level ("a labeled event happened") | **Field-level** (`Workflow: A → B`) |
| Timestamp format | RFC3339 | `+0000`, **no colon** — not RFC3339 |

### GitHub: a clever design quietly threw away all the value

The first version tried to fetch all three kinds of data from repository-level endpoints, paging through everything once, to avoid making 401 separate requests for 200 tickets. **Running it against real data showed the events path was wrong**: `issues/events` does not support `since`; it can only be paged backward from the most recent event, and in GitHub's data model, a PR also produces issue events. In this very repository, the ticket events we wanted were already buried on **page 5**; a more PR-active repository would push them past any reasonable page limit.

So "the status change history" quietly became empty — **which is the entire reason this source was worth connecting.** Fixed by fetching events per ticket instead; N is simply the number of tickets being written this run. Trading accuracy for less convenience was the right call here.

### Jira: three traps, all hidden in field shape

- **Timestamps are not RFC3339** (`2026-08-24T11:11:52.944+0000`, with no colon in the timezone offset). chrono cannot parse this by default, and a failed parse means the whole page of tickets is lost.
- **No `since` parameter for incremental sync** — only JQL, using Jira's own date format, which **must be quoted.** Both mistakes produce a 400 error, not a "nothing found" response.
- **`fields` must be listed explicitly**: omitting `comment` means no comments are returned; returning every field by default can bloat one response to hundreds of KB.

## Pinning field shape against real responses

Hand-written JSON only proves that "the shape we assumed" can be parsed. A single GitHub issue has over a hundred fields; we declare only ten. Which ones are actually named differently, and which are null under certain conditions, can only be answered by real data.

Both connectors' test fixtures come from **public, anonymously readable instances** (`deeplethe/utopia`, `issues.apache.org`), trimmed down to the fields we declare — the trimming itself proves that undeclared fields do not break deserialization.

This caught a real bug on the spot: a hand-written test passed cleanly while real data failed. **The per-ticket events endpoint does not return an `issue` field** (the context is already in the URL). The first version marked it required, copying the repository-level response shape; switching endpoints broke parsing entirely.

**This is a hard requirement for future work**: connecting a source with no public instance and no real response available must be labeled explicitly as "not verified against a real instance" in the PR, and kept separate from these two verified connectors.

## Truncation must be stated

The Kafka project has **14,506** tickets; one page-through run is capped at 500. Staying silent about this would make "sync complete" a misleading message in the UI — so when the number retrieved is less than `total`, a warning is logged stating this run covered only part of the data.

Same principle as #108 ("a partial extraction reported as complete") and #127 ("one bad record should not destroy a whole chunk"): **a limited scope must be stated, not implied.**

## A known trade-off: a moment gets truncated to a date

When the connector writes a timestamp into document text, it uses `created_at.format("%Y-%m-%d")` — **truncated to a UTC day.** The `valid_from` the extractor reads out of "Opened by X on 2026-08-18." therefore has day-level precision; the exact moment is gone before it ever reaches storage.

**The cost, stated plainly**: an event near UTC midnight can land on the wrong day. Someone in UTC+8 opening an issue at 7am on August 19 sees "8-19" in GitHub's own UI, while our document reads "8-18."

**Why this is still acceptable**:

- Nothing is truly lost. The source still holds the original data, and both connectors **re-sync idempotently** — recovering exact-moment precision just means syncing again. This is a different, much smaller category of cost than an irreversible loss.
- The precision model is already telling the truth here. `precision = day` means exactly "we know the day, not the moment," and storing a day-precision date at UTC midnight, rendered in UTC, is internally consistent. **The real mistake would be pretending to know more than we do.**
- This product does not currently ask "at what time." It answers "what did the world look like at some point," at day granularity.

**When to revisit this**: if someone needs to report by "local business day," or a connected source naturally clusters events near midnight (a shift handover, market open/close). At that point day precision is not enough, and adding an `instant` precision tier becomes worthwhile — along with matching changes to the CHECK constraint, the extraction prompt, and the rendering logic.

One related rule from the same reasoning, already in the code: **world time and recorded time are handled in opposite timezones on purpose.** `valid_from`/`valid_to` come from a statement in a document — a calendar date, not a moment — and are always rendered in UTC (converting to local time would show a UTC-5 reader the previous day). `recorded_at`, meaning "when we came to believe this," is a real moment in time, and is rendered in the viewer's own timezone. **These two are deliberately different. Do not make them consistent.**

## Why this was not abstracted into `issues` plus a provider trait

Connecting a second vendor was specifically meant to test whether abstraction was worth it. The answer is **not yet**: the fetch methods differ completely (3 calls vs. one call, `since` vs. JQL, events vs. field-level changes). The only thing they share is the judgment "one ticket, one document, with change history in the body" — and that already shows up as a consistent **document shape** on both sides, with no shared trait needed to enforce it.

Forcing a shared provider interface now would squeeze these real differences into a pile of `match` statements. Revisit this once a third source arrives: if its fetch method matches one of the two existing shapes, abstraction then has a real shape to follow.

## Where this line of reasoning extended later

"State clearly where something came from" is not only about sources. The same rule applies on the ontology side too, added after this document was written:

- **#141**: a type's shape now carries its origin — **a square means declared by a vocabulary (it has an IRI); a circle means grown from the corpus.** Before this, every automatically created type was drawn as a circle, with no way to tell, on the graph, which types were ontology-defined and which grew from documents.
- **#145**: once a type is **adopted** by a vocabulary (`adopt_iri_onto_key`), its shape must update to match. Missing this case produced a jarring symptom: a type gained an IRI but still drew as a circle — **having an IRI while looking like a circle means the display is lying.** This gap only surfaces through a real import, and it was hit in testing.

Neither is the subject of this document, but the rule is the same one: **origin must be visible.** When connecting a new source, it is worth asking the same question: can a reader tell at a glance where something this source brought in actually came from?

## An adjacent layer: who can mount a source

This document covers "how data comes in." A layer not covered here was added afterward — **authorization** (#142, `data_source_grants`): registering a data source is a deployment-level action, and the connection string it carries reaches every workspace it is granted to. So mounting can only choose from the set of already-granted workspaces, guarded on both sides (the list is filtered per workspace, and the mount endpoint re-checks). The same rule applies here: origin must be visible, and destination must be controlled.

## To do: Feishu, Confluence, Notion

Document-collaboration sources are the next ones worth connecting — this is **the enterprise version** of the Wikipedia history-snapshot corpus from #122: the same document, at different points in time, already carrying version numbers, needing no sampling and no fight with events buried inside pull requests. All four test criteria pass.

**Feishu first** (`feishu_docs`): the real destination for Chinese-speaking users, and its API returns document versions directly.

Three known unknowns, to be answered before connecting one:

1. **No public instance is available.** Feishu, Confluence, and Notion all require a tenant and credentials, so a GitHub/Jira-style real end-to-end test is not possible. Either use a test tenant, or state plainly that it is unverified against a real instance.
2. **Rich text is not a plain string.** A Feishu document is a block tree (the `docx` block structure); Notion uses blocks; Confluence Cloud uses ADF — all need a "block tree to plain text" renderer. Jira Cloud's v3 API has the same problem, sidestepped this round by using v2 instead.
3. **What "change history" means here is different.** A ticket's change history is an event stream; a document's change history is a **sequence of versions** — closer to what #122 already does for its corpus, and likely needs sampling by "how much changed," rather than fetching every single version.

### The shape to follow

The two existing implementations share one shape; copy it directly: `github_issues.rs` (3 calls, plus events fetched per ticket) and `jira_issues.rs` (one call returns everything, `expand=changelog`).

1. **A pure function, `render()`**, lays out one record as Markdown — no network calls, so it can be tested directly.
2. **`fetch_all()`** handles pagination and authentication.
3. Add a `sync_*` branch in `ingest_sources.rs`, calling `ingest_item()` — which handles identity, sha256 deduplication, and version recording.
4. Add the new kind to `sources::KINDS`, **and to three places in the frontend** (`SourceView["kind"]` in `api.ts`, the create-source dialog in `Library.tsx`, and the icon plus `SYNCING_KINDS` in `SourcesRail.tsx`).

Step 4 is the easiest to miss, and its symptom is **selectable in the UI, then rejected at creation time with `kind must be one of…`** — invisible to unit tests and to `tsc`, catchable only end-to-end (this is exactly how #134 found it).

Also: credentials only ever flow in, never out. Leaving a field empty while editing a source means "keep the existing stored value" — see `sync_custom` for the pattern.

### Acceptance

- Unit tests cover `render()`, including edge cases like "an empty comment leaves no empty section"
- Add a fixture test wherever a real response is available; **if not available, state plainly in the PR that it is unverified against a real instance**
- End-to-end: create the source → sync → the document carries version/change information → a second sync is idempotent (adds 0 new documents)
- `cargo clippy --workspace --all-targets` and `npm run typecheck` both run clean

Confluence and Notion belong to the same category; unknown #2 above applies to all three.

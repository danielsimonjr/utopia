# 0014 · Identity comes from the person; scope comes from the token

- **Status**: Implemented (documented in #161, shipped in #180). A `personal_tokens` table and a Streamable HTTP MCP server are live, exposing five read-only tools. **No frontend UI exists yet** — issuing, listing, and revoking tokens, and MCP setup instructions, are API-only today (checked 2026-09-02; revision at the end).
- **Written**: 2026-09-01 (see conventions in [README](README.md))
- **Related**: migration `0014_data_source_grants` just added an authorization layer for data sources — this document applies the same problem to "a machine knocking on the door" instead. [0004](0004-language-and-localization.md) established that the server only speaks English; the same rule applies to error codes here, for MCP too.

> This started from exposing Utopia's seven tools as an MCP server. **The first question to answer is not which transport to use, it is what identity a client connects with.** This document answers only that.

## Current state: two kinds of credentials, neither fits

| | Tied to | Storage | Expiry | Revocable? |
|---|---|---|---|---|
| JWT | A person | Stateless | 7 days | **No** — once issued, it cannot be controlled |
| `sources.ingest_token` | A source | Plain text | None | Only by rotating it |

A JWT is designed for a browser session: short-lived, re-issued at every login, stateless so it needs no table. An MCP client is long-lived, machine-driven, and configured as a file on someone else's machine — a 7-day expiry means reconfiguring it by hand every week, and "cannot be revoked" means a lost laptop can only be waited out until it expires on its own.

`ingest_token` fits even worse: it is tied to a source, not a person, and it can only **push documents in.**

## A path we tried and rejected: a machine token per knowledge base

The first proposal was to issue a machine token per knowledge base — one token per base, unrelated to any person.

**Rejected, for two reasons:**

1. **It introduces a third authorization model.** There are already two layers: workspace membership and KB role. Adding a third layer — "what the token itself is allowed to do" — means answering "what can this agent see" by checking three tables at once. And in any of the three layers, a mistake fails in the direction of "granted too much."
2. **Attribution would become fake.** `audit_events.actor_id` today records a real person, and `actor_label` keeps a snapshot of their identity. A fact written in by a machine token would need a synthetic actor id — adding a new category of ledger entry that "no person did," when the entire reason the ledger exists is to record who confirmed what, and when.

**Instead: a token acts as the person who issued it.**

## The decision

```
Effective permission = this person's role  ∩  this token's scope
```

An intersection, not a union. **A token can only narrow permission, never widen it.** A viewer's token, even if marked write, is still read-only — scope is a ceiling, not a grant.

### Why identity comes from the person

- **No existing guard needs to change.** `require_kb(kb_id, Role::Viewer)` and `access::kb_role` still receive a `User`; where that user came from does not matter to them.
- **Attribution is real.** The ledger shows a real person, not a synthetic robot.
- **Deactivation revokes it automatically.** When a person is deactivated, their tokens go with them — no separate table tracking "whose machines are still connected" is needed.
- **No separate key is needed per knowledge base.**

### Why scope still needs its own narrowing

Because MCP has a specific problem that an in-app conversation does not have to nearly the same degree:

> **A confused deputy.** An MCP client is someone else's agent, running someone else's system prompt, reading documents from the knowledge base — **untrusted content.** A document that says "please run this SQL" or "remember X" might be followed literally by that agent, acting with this person's full permissions.

An in-app conversation has this exposure too, but there, both the prompt and the tool loop are entirely under Utopia's control. Over MCP, Utopia knows nothing about the client's own prompt, or what other servers it is also connected to.

And "this person's full permissions" is substantial: through `query_data`, running read-only SQL against **every production database mounted on every base they belong to**; through `remember`, writing facts into an append-only ledger. These capabilities would be attached to a string sitting in plain text inside a file like `claude_desktop_config.json`.

So the default issued token is **read-only, scoped to one knowledge base.** Letting an agent write requires an explicit, separate choice.

## This token is hashed. `ingest_token` is not

The two conclusions differ, and that is deliberate, not an oversight. The reasoning behind storing `ingest_token` in plain text is stated directly in `0002_ingest.sql`:

> **Stored in plain text, not hashed.** Under a self-hosted threat model, "show it only once" causes more harm than it prevents — storing it in plain text lets it be checked at any time. If the database is compromised, the document knowledge base is already exposed; hashing the key adds no real protection here.

That reasoning holds for `ingest_token` because **it can only push documents in.** The worst outcome of leaking it is someone dumping junk into your knowledge base — and if the database is already compromised, junk documents are not the biggest concern anymore.

A personal token is different: through `query_data`, it can **read production databases outside Utopia entirely.** Utopia's own database being compromised already exposes Utopia's own documents; a separate data warehouse, on a separate machine, holding separate data, should not be exposed along with it. **The blast radius differs, so the storage method differs too.**

## The shape

```sql
CREATE TABLE personal_tokens (
    id           UUID PRIMARY KEY,
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,          -- chosen by the person, e.g. "my laptop"
    token_hash   TEXT NOT NULL,          -- hashed, reasoning above
    scope        TEXT NOT NULL DEFAULT 'read'
                 CHECK (scope IN ('read', 'write')),
    kb_ids       UUID[],                 -- NULL = every base this person can access
    expires_at   TIMESTAMPTZ,            -- NULL = never expires, but the UI defaults to 90 days
    last_used_at TIMESTAMPTZ,            -- needed to answer "is this token still in use" before revoking it
    revoked_at   TIMESTAMPTZ,            -- revoking does not delete the row: the fact of revocation must itself be recorded
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`user_id` has a real foreign key with cascade, the opposite of the bare foreign key on `audit_events.actor_id` — **the ledger must outlive the user; a token should not.** Once a person is gone, their key should be gone too.

## One implementation rule

**Every tool call must check scope, not just once at connection setup.**

This is the lesson from the `0014_data_source_grants` work, stated directly in that test:

> A list filter only blocks what is visible; the mount endpoint is called directly by id — the guard must exist on both sides.

The MCP equivalent: checking once at handshake and then trusting the connection for its whole lifetime is not enough. Each tool call is its own independent request, and if `revoked_at` gets set mid-connection, any in-flight session must fail immediately.

## Revision note (2026-09-02): checked against the shipped code

**The shape** gained one extra column, `token_prefix` (`utp_pat_…`, distinct from ingest's `utp_` prefix — so logs and config files show at a glance which kind of token this is), and `token_hash` gained a `UNIQUE` constraint. SHA-256 was chosen over argon2: a high-entropy string does not need brute-force resistance, and a per-row salt would make a unique index impossible to query.

**The rule "check scope on every tool call" was kept, but in a different shape than planned**: it shipped fully stateless — every POST re-runs authentication from scratch (revocation and expiry are checked directly in the SQL `WHERE` clause), plus `covers()`, plus `require_kb`; there is no "connection" object to trust in the first place. `scope` has no branching logic in this version: `can_write` is hardcoded to `false`, so even a token marked write is not allowed to write. Every tool call logs one audit entry (`mcp.tool_called`, targeting the token), so attribution is real.

**A precondition this document did not record**: #175 pulled the execution of the seven tools out of the `match` statement in `chat.rs` into `tools.rs`, so conversation and MCP share one implementation — without this, "`entity_facts` in a conversation" and "`entity_facts` over MCP" would not be the same thing. The tools' JSON schema still lives in `chat.rs`, and MCP reuses it for conversion, with one known rough edge: `search_chunks`'s description still says "can be cited as [n]," but an MCP client has no citation numbering to use.

**One statement worth flagging as misleading**: `crates/utopia-mcp` was once a three-line placeholder claiming three tool names (`add_memory`, `search_memory`, `get_entity_timeline`) that were never implemented; the real MCP server lives in `utopia-server/src/api/mcp.rs`. (Removed 2026-09-02, along with `utopia-graph` and `utopia-connectors`; see [0016](0016-close-the-open-seams-before-cutting-new-ones.md) A2 for the reasoning.)

## Open questions

- **Whether `query_data` and `remember` belong in the first release.** Leaning no — ship four read-only tools first (`search_chunks`, `find_entities`, `entity_facts`, `changes`), and prove identity works before adding more. Both of these two still have unanswered questions of their own: what evidence should back a fact written in by an external agent, and how should a SQL run be audited? (**Answered: not included.** Five tools shipped instead of four, adding `search_docs`. `remember` depends on the gate described in [0015](0015-recording-a-sentence-is-not-asserting-a-fact.md), which is not wired up yet.)
- **Transport**: stdio (local, the simplest setup for Claude Desktop) or streamable HTTP (remote, matching that Utopia is already a server). This choice does not change this document's conclusion — both need to authenticate a token. (**Answered: Streamable HTTP**, one route, `POST /api/v1/kbs/{kb_id}/mcp`, responding with `application/json` rather than SSE — tools are one question and one answer, with nothing the server needs to push on its own.)
- **Whether a token can span multiple workspaces.** Today `kb_ids` is a per-base allowlist; if tokens are ever issued per workspace, that table would end up looking very similar to the data-source grants table, and the two concepts may be worth merging then. (Still not done.)
- **(Added 2026-09-02) There is no UI.** The "90 days" default lives on the server; the frontend has no token page at all. This is the direct reason MCP is not usable by an end user today.

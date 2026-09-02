# 0008 · Ontology packs as cold start

- **Status**: Shipped. Five packs are embedded in the binary, selectable (multiple at once) when creating a base, with schema.org checked by default; a 22-row alignment table is maintained by hand. **Creating a base no longer seeds any relations** — a pack is not a supplement, it is the ontology's only source. All three open questions are still open, and the "Chinese labels" one has gotten worse (checked 2026-09-02; revision at the end).
- **Written**: 2026-08-30 (see conventions in [README](README.md))
- **Related**: [0001](0001-ontology-import-and-governance.md) sets the IRI/key split and the cross-cutting criteria. [0006](0006-ontology-scale-and-the-prompt.md) removes the prompt-size barrier to a large ontology. [0007](0007-who-decides-what-becomes-a-relation.md) sets the adoption rule for growing from a seed.

> Same format as 0006 and 0007: numbers first, each marked with what it **cannot** show.
> Every number here **comes only from official release files** (fetched 2026-08-30), and anyone can reproduce them.
> **Deliberately excludes stats from our own dev base** — that is mock text, useful for showing the shape of a bug, not the rate at which it happens in real deployments; citing it in a decision record would only mislead a future reader.

## The problem

A new base seeds only 10 relations (at the time of writing, `graph.rs`'s `RELATION_TEXT_ZH`; today that table, `localized()`, and `ensure_default_ontology` are all gone, and `graph.rs` opens with three retirement notes explaining why). **Not one of those 10 carries a type signature** — no domain, no range.

The extraction prompt already supports signatures (see the test in `extract/lib.rs:498`: `- buys_from (employee|team → *)`), attaching "subject type → object type" to a relation that has one. The seed relations have nothing to offer there, so they degrade to plain prose instead:

`- works_at: employed by an organization.`

**Plain prose cannot constrain direction.** The definition of `produces` reads "an organization or project makes, releases, or launches the object" — "organization or project" is a **type hint about the subject**, not a **direction constraint**. The model reads "Anthropic's Claude" and knows the two are connected by `produces`, but nothing machine-checkable tells it who belongs in the subject position. And a product in this ontology is often also classified as a Project or a Product, so both directions read as legal.

Of the 10 seed relations, only `part_of` states a counter-example ("**not** 'is playable on'"), clearly added after hitting that exact problem. **This is the core of the problem**: fixing direction with prose means hitting the same trap once per relation, and each fix only protects that one relation — `part_of`'s warning about "playable on a service" does nothing for the next relation that hits the same trap.

The self-description at the top of `graph.rs` (now moved to the top of `bootstrap_ontology.rs`, **its content now out of date**, still describing 10 default relations and a `related_to` downgrade) states this is not a problem with one relation:

> [The corpus's] documents mostly use relations outside these 10, so a large share of facts downgrade to related_to

**Ten predicates cannot cover real documents, and expanding to a few dozen does not fix direction either** — as long as direction is expressed in prose, it costs one trap per predicate, O(number of predicates).

## schema.org turns direction into structure

| | Types | Properties | With both domain and range | 
|---|---|---|---|
| Our 10 seed relations | — | 10 | **0** |
| schema.org (2026-08-30) | 1,010 | 1,521 | **1,488 = 97.8%** |

```
schema:manufacturer   Product      → Organization
schema:worksFor       Person       → Organization
```

`Claude manufacturer Anthropic` is valid; the reverse fails domain validation, since `Anthropic` is not a `Product`, and **is blocked before it can ever enter the graph.** Direction is no longer described in prose; it is declared.

Note that `manufacturer`'s direction is the **exact opposite** of our own `produces` (organization → product). This does not affect the conclusion — the point is not which direction is correct, it is that a direction is declared explicitly at all.

## Candidate packs (measured)

Fetched and counted by each pack's own syntax. Three criteria: the existing importer can parse it (Turtle or RDF/XML), it uses an open license, and it carries domain/range.

| Pack | Size | Types | Properties | Domain | Range | What it adds |
|---|---|---|---|---|---|---|
| **schema.org** | 1,078 KB | 1,010 | 1,521 (the shipped pack records 1,676) | 1,521 | 1,521 | General purpose: people, organizations, products, events, creative works |
| **W3C Org** | 82 KB | 13 | 34 | 36 | 32 | **Organizational structure**: Unit, Post, Membership, Role, tenure |
| **PROV-O** | 110 KB | 62 (the shipped pack records 49) | 69 | 63 | 62 | Provenance: Activity, Agent, wasDerivedFrom |
| **FOAF** | 43 KB | 12 | 62 | 60 | 57 | Social relationships |
| **IOF Core** | 394 KB | 294 | 75 | 94 | 94 | Industrial manufacturing |

**W3C Org has only 13 types and 34 properties, but fills schema.org's weakest area.** schema.org's `Organization` type is built for web pages; it has no concept of a department, a post, tenure, or a reporting relationship.

**PROV-O also closes an external gap**: two rows in past competitive comparisons — "Provenance: W3C PROV-O" and "Compliance export" — were both weak points against a custom schema; importing this pack gives us the standard vocabulary directly.

### Not downloadable or not a good fit

- **FIBO** (finance) ships in modules through a catalog; the full set needs fetching hundreds of files. A single module (People) has only 31 types. Supporting finance properly is a separate piece of engineering, not something to add as one more pack.
- **Brick** (1,438 types) and **QUDT**: an extremely low property-to-type ratio (Brick is 25:1,438) — these are classification trees, not relation ontologies, and help extraction only marginally.
- **SAREF**: parsed out to zero types and zero properties; its declaration style is not yet covered by our projection and needs checking first.
- **SNOMED CT**: requires a license.

## How much overlap exists

Compared using the real `key_from_iri()` algorithm — collisions are checked by key, not by IRI.

| Pair | Colliding names | Which ones |
|---|---|---|
| org ∩ schema | **6** / 43 | `identifier` `location` `member` `member_of` `organization` `role` |
| foaf ∩ schema | **15** / 72 | `agent` `name` `person` `knows` `member` `organization` `title` `image` `logo` `thumbnail` `given_name` `family_name` `gender` `project` `status` |
| prov ∩ schema | **4** / 95 | `agent` `contributor` `creator` `publisher` |
| org ∩ foaf | 2 | `member` `organization` |

After removing duplicates, **about 20 words overlap.** They fall into two groups, and cannot all be treated the same way:

**Truly the same concept — map them together**: `foaf:Person ≡ schema:Person`, `org:Organization ≡ schema:Organization`, `foaf:knows ≡ schema:knows`.

**Same name, different meaning — must stay separate**:
- `org:role` is a post inside an organization; `schema:role` is a character played in a creative work.
- `foaf:status` is a 2000s-era instant-messaging status field; `schema:status` is an order or action status.

**FOAF has the highest overlap rate (21%) and the lowest unique value** — its core concepts already exist in schema.org, and what remains, like `mbox_sha1sum` and `icqChatID`, is a relic. It stays on the candidate list but is not part of the default recommendation.

## The decision

### 1. Multi-select at base creation, not a fixed bundle

The first draft proposed three fixed bundles: general purpose, provenance/compliance, and industrial. **Rejected.** The alignment table declares pairs, not bundles — `foaf:Person ≡ schema:Person` holds no matter which packs a user picks, so multi-select **adds no alignment cost.** A fixed bundle is a guessed category that will not match reality — a fintech company wants IOF plus a future FIBO pack, a consulting firm wants schema plus Org plus PROV, and no single bundle covers every case.

The UI shows each pack's size and **its overlap rate with what is already selected**, letting the user judge for themselves instead of deciding for them.

### 2. No import undo

Three existing safeguards already guarantee the safety boundary: `ON DELETE RESTRICT` (today in `0003_graph.sql`), an application-level usage count (in the two delete paths in `ontology.rs`), and a `NOT builtin` check (this third one is now an empty condition, since no builtin rows exist anymore). **A type with entities attached cannot be deleted.**

So the real answer to "what if I picked the wrong pack" is: an unused type can just be deleted; a used type cannot — **and being unable to delete it is exactly correct**, since real knowledge is attached to it.

What is needed is not `undo_import`, but a **batch view**: "this import created 294 types; 12 have entities using them; 282 are empty," with a one-click way to delete the empty ones. This is much simpler than a real undo, and its meaning is clear — it never touches anything holding data.

> These three safeguards deserve their own note: they are the **reverse** of criterion 2 ("the ontology guides, it does not enforce"). The ontology does not enforce rules on facts, but **knowledge can veto a deletion in the ontology.** Knowledge protects the ontology; the ontology does not get to prune knowledge.

### 3. A hand-maintained alignment table, not runtime inference

About 20 rows, written by us. **Some of the work is already done upstream** — W3C Org's own documentation states its alignment with FOAF, and PROV-O states its alignment with FOAF and Dublin Core; these can be copied over directly.

No automatic alignment (label similarity, embedding match): the packs are ones we chose, not ones a user uploads freely — there are only five or six of them, their pairwise overlap is limited, and it can be listed exhaustively. **This turns an open-ended alignment problem into one static table**, matching criterion 6 ("fix governance lessons in the schema, not as hidden rules").

## Revision note (2026-09-02): checked against the shipped code

**How the three decisions landed.** Multi-select at base creation shipped (`CreateKbReq.ontology_packs`, a multi-select card UI, with no preset combination at all). **"Overlap rate with what is selected" was not built, and in fact went the other way** — commit `2fa8d57` removed the collision warning entirely, since the alignment table already resolves collisions, and reporting one to the user would ask them to fix something that needs no fixing.
No-import-undo held, but **its replacement — "a batch view: this import created 294 types, 12 in use, 282 empty, delete the empty ones with one click" — was not built**; `ImportPanel` shows only import history and the plan.
The alignment table has 22 rows (this document guessed "about 20"), in two kinds, `SameAs` and `Rename`; both `org:Role → org_role` and `foaf:status → foaf_status` are present.

**The alignment table grew three things this document did not anticipate.**
First, a third outcome, `Aligned`: a same-meaning match is recorded as "aligned" rather than as a conflict, alongside `Create`, `Update`, and `KeyTaken`.
Second, **it is direction-sensitive**: the table is keyed as `(incoming IRI, occupied IRI)`, so installing packs in a different order matches different entries — which directly produces a user-visible rule: the order you check the boxes is the order they install.
Third, it needs a safeguard against drift: a test that projects all five real packs and checks every IRI against the table, guarding against a silent typo, and against an upstream prefix change (schema.org migrating from `http://` to `https://` has actually happened).

**Two consequences ended up in the code.** One pack failing does not roll back packs already installed (the ontology only grows by addition; a partially installed base still works, and rolling back would mean deleting types already built — the same reasoning behind not building import undo). Packs ship gzip-compressed inside the binary and decompress on each base creation (1.7 MB down to 316 KB, supporting the offline/private-network promise and keeping the clone size down).

**A third starting point this document never discussed: starting from zero.** Installing no pack at all is valid; an empty base still works, with entity `type_id` set to NULL ([0009](0009-no-type-is-a-type.md)). This document assumed packs moved the starting point from 10 to 1,500; in practice there is also a "0" option.

**"The ontology guides, it does not enforce" was half-overturned for packs.** [0012](0012-the-ontology-is-a-contract-not-a-suggestion.md) asked, for the first time on real text, "does a large ontology actually help": vocabulary size did catch real content (215 facts with a predicate, all 41 relations sourced from a pack), but not one declared direction was actually enforced, and 102 of 130 checkable facts were stored backward. The fix was to correct direction against the signature at write time, leaving a trace. **A pack's real cost is not prompt length, it is the difficulty of choosing**: many pack entries have generic names with narrow real meanings (`affectedBy` is a medical test term; `competitor` is a sports-event term), and picking by name or by vector similarity will collide with them. This belongs in this document's list of costs.

**Current state of the open questions**:
- Accuracy with mixed packs — **the tool is ready; the comparison has not been run.** `run.mjs --packs` follows the real cold-start path, but `truth/` still holds only pharma and tech.
- schema.org is built for web content — still true. The README turned "request a pack for your industry" into an issue-template link, converting this gap into a channel for user input.
- Chinese labels — **this has gotten worse.** The 14 seed relations that had Chinese names are gone, and all five packs are English-only, so a Chinese-language base today gets a **purely English ontology.** The practical effect of the split defined in [0004](0004-language-and-localization.md) is that `ontology_lang = zh` only affects vocabulary grown later through LLM proposals — it changes nothing about an installed pack, and nothing in the UI states this.
- Starting scale — not studied. `MIN_DOCS = 2` and `MIN_SIGNALS = 3` were never adjusted for the starting point moving from 10 to 1,500.

## Open questions

- **No one has measured extraction accuracy with mixed packs.** The data in 0006 covers a single ontology. Selecting every pack gives about 2,400 types, and per-chunk retrieval will surface both `org:role` and `schema:role` at once. 0006's budget guarantees they **fit**; fitting is not the same as **being chosen correctly.** This is the largest unknown in this document, and should be tested with a paired comparison in `scripts/bench/` before further work here.
- **schema.org is built for web content** (Recipe, JobPosting, Event); it has no concept of a "contract," an "approval," or "supplier qualification" for enterprise text. It is a good cold-start base, not an end point — the growth loop from 0007 is still needed, just starting from 1,500 relations instead of 10.
- **Chinese labels**: schema.org and every candidate pack are English-only. Our old 10 seed relations carried Chinese names (`produces` → 出品). Manually translating 1,500 properties is not realistic, and machine translation is not appropriate either — `rdfs:label` is a token the model reads, and a wrong translation is worse than none. Whether the split defined in [0004](0004-language-and-localization.md) is enough here still needs checking.
- **Starting scale is itself a variable.** The Snowball dead end in 0007 already proves this in passing: growing the vocabulary from 10 to 629 words changed matching behavior qualitatively (49 recovered matches dropped to 18). No one has directly studied what starting from 1,500 words means for the adoption loop — what will a high-frequency phrase even propose against?

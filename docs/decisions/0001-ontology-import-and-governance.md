# 0001 · Ontology import and governance

- **Status**: In progress. P0, P1, P2, and P2c are complete. P3 ("switch by budget") is live: the deployment sets `ontology_prompt_budget` (default 24,000 characters). Above the budget, the system retrieves types per chunk. P3a is live but runs only on manual trigger; it has no class-count threshold. P3b has both parts live, but in a different shape than this document describes (the surface word goes to `fact_evidence.proposed_predicate`; mapping uses `predicate_match` and the adoption loop from [0003](0003-ontology-growth-loop.md)). P4a is live. P4b and P4c are not done. P5 is live, delivered by [0002](0002-reasoning-engine.md); `utopia-reason` is no longer an empty shell. Half of criterion 2, about argument order, is overturned by [0012](0012-the-ontology-is-a-contract-not-a-suggestion.md). Reviewed against the code and revised in place on 2026-09-02.
- **Written**: 2026-08-27/28, revised during ongoing review (see conventions in [README](README.md)).

The reasons matter more than the checklist. A checklist goes stale. The reasons decide how we judge the next new case. This document puts the cross-cutting criteria before the phases, and it keeps overturned judgments in place as revision notes (see P1 and P3).

## Why this direction

The product differs on two things: time and trust. Both depend on the **ontology**. The extractor uses the ontology to decide what to extract and how to classify it. The temporal engine uses `functional` to decide what counts as a conflict. Resolution uses type to decide which entities can be the same. When the ontology is wrong, everything downstream is wrong, and wrong silently.

Enterprises already have their own ontology: FIBO, an industry standard, or a custom Protégé model. Rebuilding it by hand in our UI is not realistic. So this line of work ends here: import the enterprise ontology, extract using its vocabulary, and let the governance process itself accumulate knowledge.

---

## Verified facts (2026-08-28, measured on real text)

We built an `Industry Corpus` knowledge base from public company press releases (18 NVIDIA blog posts and 10 Microsoft newsroom posts, ingested by RSS):

| Metric | Value |
|---|---|
| Documents / chunks | 28 / 181 |
| Entities / facts | 917 / 922 |
| **Entity density** | **5.07 per chunk** |
| Resolution: auto-merged / pending review | 10 pairs / 5 pairs |
| Batched adjudication tasks | 22 (covering 917 entities) |
| Graph overview query | 103 ms |
| As-of query | 107 ms |
| Entity change history (NVIDIA, 122 events) | 16 ms |
| Size of the 9 seed types in the prompt | 466 characters |

**Cross-document resolution works.** NVIDIA merged facts from 16 documents into one entity, with 118 facts total. It did not split into duplicate entities with the same name.

**Three defects fixed** (see branch history):

1. The HTTP client sent no User-Agent, so sites like Wikipedia returned 403. This broke URL and RSS ingestion for many real sites.
2. HTML extraction walked the whole document. A Wikipedia article split into 60 chunks; the first chunk was the sidebar menu and the last was the copyright notice.
3. `part_of` was marked `functional`. Across 28 press releases this created 59 false conflicts (belonging to "Microsoft Learn" and to "Microsoft" is not a contradiction).

**Open quality problem**: the Product type holds 40% of entities (368). About a quarter of a sample are generic phrases ("row power center", "financial databases"). The fix is to add descriptions to types, since descriptions feed the extraction prompt.

> The original note here said "today the only fix is to re-extract the whole base, because entities cannot be edited alone." This is no longer true after P0. Three finer paths exist today: direct edits in the entity panel (protected by the P4a `type_source` field), batch refinement through type resolution, and `adopt_proposed_types` when the ontology grows a new type. Re-extracting the whole base is no longer the only option.

---

## Cross-cutting criteria

Use these criteria to judge new designs and new features. Do not re-argue them each time.

1. **The question is not "do we have the OWL," it is "can a machine use it."** Add a time dimension: discarding data cannot be undone, but saving it is nearly free. So we keep the raw source text in full, and a projection covers only what is used today. It follows that **a projection does not need to be semantically complete once the raw text is kept**. Simplification is a UI and prompt trade-off, not data loss.
2. **The ontology guides. It does not enforce.** A declaration can be wrong (as `part_of` was), so the ontology should shape the prompt and rank candidates. It should not drive discarding, overwriting, or silent rewriting. A wrong guide can be overridden by the source text. A wrong enforcement mechanism damages data systematically.
   > **Revision (2026-09-02, based on [0012](0012-the-ontology-is-a-contract-not-a-suggestion.md))**: split this criterion in two. **Which types can take part** is still guidance; the ontology can be wrong, and if the source text says Seattle, we write Seattle. **Argument order** is now enforced: it is not a claim about the world, it is an encoding convention for the fact's key, and the source text never states a direction. When the subject fails the domain check but the object passes it, we swap them to match the type signature and record `direction_corrected`. If swapping still fails, we drop the predicate and keep the subject, object, and evidence. Measured over five rounds: the violation rate fell from 57% to 4%, and true reversed facts fell from 39 to 0.
3. **Prompt size must not scale with ontology size.** Listing all N types in every chunk's prompt costs O(chunks × ontology size), and a model choosing from 800 options performs worse, not better. Solve the scale problem with retrieval, not by listing fewer types.
4. **Matching names carries no conclusion by itself.** If two mentions resolve to the same entity, they already share a type, so no inference is needed. If they resolve to different entities, the shared name is exactly the signal we deliberately distrust (two people both named Zhang Wei). Context carries the real information.
5. **Surface uncertainty to a person. Do not guess quietly.** Use tiered thresholds; put the gray zone in Review. This matches the "prefer separate over merged" rule in resolution.
6. **Fix governance lessons in the schema, not as hidden rules.** Editing a type's description once is visible, reviewable, and logged in the audit trail. A rule that grows out of clicks is invisible after six months.
7. **Uniqueness is not identity.** `key` has `UNIQUE (kb_id, key)`, but it derives from something that can change (a label or a local name), while identity must stay stable over time. If two different global things could want the same key, the key needs to carry its origin to work as an identifier. That origin is the IRI. Also: **an IRI is a name, not an address.** Most IRIs cannot be fetched. Do not crawl them, and do not "normalize" http vs. https or a trailing slash into one form.

---

## Phases

### P0 · Entities must be editable — the foundation, and a live problem today

**Problem**: entities are read-only. `/kbs/{id}/entities/{entity_id}` only supports GET. The one store-level `UPDATE entities SET type_id` sits in `resolution.rs:388` (an automatic upgrade during merge). The entity panel in the UI has no edit control. A wrong type or a mis-extracted name can only be fixed by re-extracting the whole base.

**Do**
- Add `PATCH /kbs/{id}/entities/{entity_id}`, requiring Editor permission, to change `type_id` and `canonical_name`.
- Write to the audit trail: `entity.retyped` and `entity.renamed`, with a before/after snapshot in the detail field (the same self-contained snapshot convention used for the decision ledger).
- Add an edit control to the entity panel header in the UI.

> **Revision note**: the first draft said "`entities` has a unique index, so a rename will hit a 409." Both parts were wrong. `entities_kb_type_name_idx` is a **plain index, not a unique index**, and duplicates of the same type and name **already exist** (two entities named "Zhang Wei" in the General base, two named "rust compiler").

**A name collision is a hint, not a rejection.** Two "Zhang Wei" entities are a direct result of "prefer separate over merged." Two different people can share a name and a type, and resolution's whole gray-zone logic depends on storing them apart. So when a rename or retype hits a matching name: **look it up, ask "an entity with this name exists, merge it?", but allow the edit to proceed.** A unique constraint would break the foundation resolution depends on. A 409 error would block a user from ever adding a second Zhang Wei.

**Supporting data**: in the General base, the name "rust" spans **5 different types**, "java" spans 3, and "c++" spans 3. The same thing is split across five types today, with no way to fix it.

**Acceptance**: rename "row power center" from Product to Concept. The change appears in the audit trail. The graph view and ontology page counts update.

---

### P1 · Stop discarding facts silently — small, but a live problem today

> **Revision note**: this item first read "validate the relation's range," reasoned as "this applies to existing text right away." That claim was wrong. On review: of 23 relations, only 2 have a domain (the same two that are attributes), and **none have a range**, because the UI has no field for it and nothing writes it. Range data can only come from an OWL import, so it cannot take effect independently of P2. The correct place for range is P2 (import and store it) and P3 (use it as one signal among several).

**The real, live problem**: the extractor **silently discards facts**. It extracts a fact, blocks it, and leaves no trace. The user sees nothing; the graph is simply missing something. This conflicts directly with three principles: the ledger is append-only, every fact carries evidence, and uncertainty must surface to a person.

**The scope is larger than first judged** (checked line by line in `extraction.rs` on 2026-08-28). The attribute path is not one `continue`, it is four separate discards:

| Line | Condition | Nature |
|---|---|---|
| 255 | Subject not declared in `entities` | Real discard |
| 257 | `domain_type_id` is NULL | **Unreachable.** `ontology.rs:197` requires every attribute to have a domain, and `update_relation_type` blocks changes to kind or domain (`ontology.rs:290`). An attribute with no domain never reaches the prompt (`extraction.rs:122`, `r.domain_type_id?`). This is defensive code and needs no signal. |
| 261 | Domain mismatch | Real discard (the only one flagged at first) |
| 269 | Neither `value` nor `object` given | Real discard |
| 274 | Datatype normalization failed | Logged with `debug!`, but the user cannot see it |

The relation path has two more worth noting: `confidence < 0.6` (line 234, a deliberate threshold, but still invisible — the user has no way to know a fact was extracted but flagged low-confidence) and, when `related_to` was missing from the ontology, **the whole fact vanished** (line 380; deleting the default relation would trigger this). This second case can no longer happen: `related_to` was removed entirely, so a missing predicate now results in `predicate_id = NULL` (see [0010](0010-no-relation-is-no-relation.md)).

**A related inconsistency**: on the relation path, an undeclared subject or object falls back to the `concept` type (lines 332–362). On the attribute path, the same missing case is simply discarded (line 255). Same root cause, one path tolerant, the other silently dropping facts. Either both paths should fall back, or both should log a signal — not one rule for each. **This is now fixed**: the `concept` fallback type was removed along with [0009](0009-no-type-is-a-type.md), and both paths now log `subject_not_declared`. There are 12 discard reason codes today (`extraction_drops::reason`), including `truncated_reply`, `malformed_item`, `not_an_entity_name`, and `direction_corrected` — twice as many as this section first described.

**Do**
- Add a table `extraction_drops (kb_id, document_id, reason, detail, count, example, updated_at)`, with primary key `(kb_id, document_id, reason, detail)`. Clear it per document when extraction starts.
- Do not reuse `ontology_misses`. That table means "your ontology is missing this" (for ontology growth). A discard means "this fact did not land" (for data completeness). Readers and actions differ for each.
- Group discards by document. This also fixes a lifecycle bug: `ontology_misses` clears only on a full base rebuild (`graph.rs:689`). A per-source re-extract does not clear it, so stale entries build up. A table keyed by document clears correctly by design.

**Acceptance**: give a Person-only attribute an Organization subject on purpose. The document's row in the library shows "3 facts did not land." Opening it shows the reason and an example. Facts no longer disappear without a trace.

---

### P2 · OWL import

**The architecture has three layers. The first layer matters most.**

1. **Keep the raw source.** The imported ontology file goes into the blob store unchanged, using the same content-addressed ingest pipeline already in place. `ontology_imports` records `(kb_id, blob sha, file name, time, projection version)`. This layer does not interpret meaning; it only avoids loss.
2. **Projection.** Map the subset we can use today into `entity_types` and `relation_types`. **This is a re-runnable derivation, not a one-time conversion.**
3. **Re-projection.** Re-run it when the reasoning engine ships or when we add new checks. The user does nothing extra.

This turns "we cannot express this" from a **capability gap** into "the projection does not cover this yet."

**Mapping table**

| OWL / RDFS | Utopia | Note |
|---|---|---|
| `owl:Class` | entity_type | |
| `rdfs:subClassOf` | **multiple parents** (see below) | |
| `rdfs:label` | `label` | Prefer `@en`/`@zh` |
| **`rdfs:comment`** | **`description`** | Load-bearing: feeds the extraction prompt and is the match target for P3 retrieval |
| `owl:ObjectProperty` | relation_type (`kind=relation`) | |
| `owl:DatatypeProperty` | relation_type (`kind=attribute`) | |
| `rdfs:domain` | `relation_type_domains` (a multi-value join table) | See "multi-value domain" below |
| `rdfs:range` | `relation_type_ranges` (join table) / `datatype` | Same; **stored, not enforced**; consumed by P3/P5 |
| `owl:FunctionalProperty` | `functional` | Max cardinality 1; core to the temporal engine |
| `owl:InverseFunctionalProperty` | `inverse_functional` | |
| IRI | New `iri` column | See "IRI and key" below |
| All other axioms | **Kept in the raw source, reported as "not yet projected"** | Not "skipped" |

**IRI and key have separate jobs.** `key` has strict limits: only `[a-z0-9_]`, at most 40 characters (`ontology.rs:77`), and it is **a token the model reads and writes**: the prompt lists keys, the model returns a `type` as a key, and `type_ids` are looked up by key. An IRI does not fit here (colons, slashes, and hashes are all illegal), and loosening the rule would turn the prompt into 800 lines of URLs the model must reproduce exactly — one wrong character breaks the match.

So: **the IRI is the global identity (the authority); the key is the model's label.** The key derives from the IRI (a namespace prefix plus a local name, in snake_case, with a suffix on conflict), kept short and stable. Storage: a nullable TEXT column plus `UNIQUE (kb_id, iri) WHERE iri IS NOT NULL`. Manually created types keep `iri` as NULL, at no extra cost.

**Why keep an IRI once the key is unique**: re-importing an updated ontology is the first case that breaks a key-only design:

```
v1: http://acme.com/hr#Employee  rdfs:label "Employee"     → key = employee
v2: http://acme.com/hr#Employee  rdfs:label "Staff Member" → key = staff_member  ← same class
```

Without an IRI, both choices are wrong: creating a new type `staff_member` orphans `employee` (all its entities stay attached to the old type), or matching by label fails because the label is exactly what changed. With an IRI, this is one `WHERE iri = $1` query: the name changes, the entities stay put.

Deriving the key from the local name alone does not work either: `foaf:Person` and `acme:Person` both want `person`. Which one gets the `_2` suffix depends on import order, and on the next re-import we cannot tell which `person_2` belongs to which source — unless we record which IRI it came from, which reinvents the IRI column. Two more uses: **tracing origin** (reconciling an upstream type after a manual edit requires knowing it came from upstream) and **P5 export** (a key alone cannot recover the namespace; it would be lossy).

**Multi-value domain and range**: a union of domains is common in OWL (`works_at` might range over `Organization ∪ Project`), which a single column cannot express. Store it in a join table and check membership through the subclass DAG.

**An import trap**: in RDFS, multiple `rdfs:range` statements on the same property are an **intersection** ("must be both"), not a union. This is a common modeling mistake, but it is the spec. Treat `owl:unionOf` as a direct union in the table. For multiple independent `rdfs:range` statements, if one is a subclass of the other, keep the more specific one; if neither contains the other, **report "not yet projected" and do not guess.**

**The correct use of domain/range is a type signature in the prompt, not a gate.**

In the prompt, a relation changes from `- works_at (works at): description` to `- works_at (works at): Person → Organization. description`. This is a **type signature for the model**, reducing bad triples like "Alice works_at Seattle" at the source, instead of catching them afterward — after-the-fact checks face a fact already extracted (discard it and lose information, or keep it and pollute the data). A signature corrects the model at the moment of generation.

**Guide, do not force.** If the ontology is wrong, the model can still follow what the source text says. A hard gate would discard data systematically — the same way `part_of` burned us before.

At larger scale (P3), domain/range still helps, in a different role: when predicting a predicate, **rank candidate relations higher when domain/range match the actual subject and object types**, as a retrieval-ranking signal.

The three possible uses differ in value: **store it** (yes — it is real input to P5, and the parser already has to write it); **put it in the prompt as a signature** (yes — the highest return for about ten lines of code); **validate it, auto-upgrade on it, or queue violations from it** (no — P3 uses richer evidence for the same job, and driving automatic actions from a declaration that might be wrong is risky).

**We do not implement intersection semantics, for architectural reasons.** **Because we keep the raw source, the projection does not need to be semantically complete.** The projection only serves the prompt and the UI, and both accept simplification. Full semantics belong to the reasoning engine, which reads the raw blob. Implementing intersection means expressing an anonymous class ("is both A and B"), a first step toward description logic that would pull the schema into class expressions, for a gain of one extra line in the prompt.

**Multiple inheritance needs real support.** `type_matches_domain` (`extraction.rs:137`) walks up a single parent chain. Dropping a parent branch makes attributes on that branch **fail silently** — extracted, then blocked at write time, with no error. Fix: store all parents in an `entity_type_parents` join table, and check domain/range membership over the DAG (with a visited set to guard against cycles). Keep showing the left panel as a tree using the primary parent, so the same type does not appear twice.

**Two things the import preview must state clearly**
- **Which relations will turn on conflict detection because of `functional`.** This is exactly the `part_of` trap: an enterprise ontology declares a relation functional, but the data does not follow it, and the import produces a batch of false conflicts.
- **How many types have no `rdfs:comment`.** Those types will score noticeably lower in P3's automatic classification.

**Flow**: upload → **dry-run preview** (counts of new/updated/not-yet-projected, plus the two warnings above) → confirm before writing. Never let a single file upload change the ontology irreversibly.

**Cut from v1**: OWL/XML and Manchester syntax (Turtle and RDF/XML cover most Protégé exports), any reasoning, individual (instance) import, and export back to OWL.

**Individuals (ABox data) are never imported as facts** — not a limitation, a principle. Every fact must carry an evidence chain and a source. Instances inserted with no such chain would break that foundation. They stay in the saved raw file; the future reasoning engine may read them as background knowledge.

**Dependency**: `oxttl` and `oxrdfxml` (the small, focused crates from Oxigraph). We do not use `horned-owl`; we do not need reasoning. The workspace had no RDF dependency before this. (Now added, in `utopia-ingest`.)

> **Revision note · P2a and P2b are live** (`feat/owl-import`)
>
> The first two layers and the full preview flow are live: parsing (`utopia-ingest/src/ontology_rdf.rs`), planning and execution (`utopia-server/src/owl_import.rs`, where preview and commit **share one `plan()` function`), and the UI (an Import control at the bottom of the ontology page's left panel → pick a file → plan → confirm). See the `ontology_imports` table and the `entity_types.iri` / `relation_types.iri` columns for storage details.
>
> **Validated against a real vocabulary, not hand-written samples.** FOAF (RDF/XML, 635 triples): read 15 classes and 89 properties, including `functional`, `inverse_functional`, domain, and range. DCTerms (Turtle, 700 triples): 22 classes and 55 properties. **All our hand-written sample files passed, but real FOAF failed on the first line.** The format detector had the check backward, and a leading `<!--` comment pushed `<rdf:` past the detection window. Now a file extension is a strong signal; content only overrides it when it is clearly Turtle.
>
> **The preview also reports one case not covered here: key collisions.** FOAF's `Person` shares a name with our built-in `person`, but they are different identities. The first idea was to add a suffix automatically, but that would stop a later re-import from recognizing what it built last time — the same case this document used to justify the IRI, seen from the other side. So: report it, do not resolve it automatically. To import the new one, rename the existing one first.
>
> (**Later changed in part** (#78, #145): a local type with the same name and **no IRI** is now adopted — it is a seed or a manually created placeholder, and the vocabulary should take it over, or the tree stays broken. On adoption, its shape switches to "square" (declared by a vocabulary). Key collisions where both sides have an IRI are still reported, not resolved.)
>
> **Three items not yet done** — storing attributes, the domain/range join tables and type signature, and the multi-parent DAG — are re-costed against what P2b actually built, in a separate section below: **P2c**. (All four are now done; see the end of P2c.) The first draft overstated one dependency here: attribute storage does not need to wait on the parent mapping, since P2b already built it.
>
> **Worth recording, a mistake of our own**: the `OntologyImportView` field is named `imported_at`, but the frontend type declared it as `created_at`. TypeScript said nothing — a type only guarantees internal consistency, not agreement with the server. The bug surfaced as `Invalid Date` in the UI. In the same change, the server also sent a Chinese fallback string, `（手工建的）`, into `conflict_with`, leaking straight into the English UI. Same lesson twice: **the server must not produce display text**; wording belongs to the UI. Check cross-language boundaries against real data.

---

### P2c · Attribute storage, domain/range, type signature, multiple inheritance

> This section re-costs the work after P2a/P2b shipped. The order differs from the first draft. **One item is closer than first estimated**: the draft said attribute storage must wait on domain resolution, but P2b already built that mapping.

#### 1. Attribute storage: single-domain attributes can ship now

Attributes are already fully supported in the product: `relation_types` serves two roles (`kind='attribute'`), `domain_type_id` names the owning type, `datatype` and `unit` describe the value, the value lives in `facts.object_value`, and time, evidence, and review all reuse the same machinery (see `relation_types.kind`).

**The only missing piece is that the importer does not create them.** FOAF's 54 `owl:DatatypeProperty` entries parse correctly and the preview reports a count, but `apply()` skips them. The first draft blamed this on "attributes need domain resolution, which needs classes built first" — but the mapping `id_of: HashMap<IRI, Uuid>` was already built in P2b to resolve parent classes. Three small gaps remain:

- **`rdfs:range` → `datatype`, with three outcomes, not two**:

  | Case | Handling |
  |---|---|
  | Range maps directly | Build with the mapping. `number` covers `decimal`, `integer` and its bounded/unsigned variants, `double`, `float`, `owl:real`, `owl:rational`. `date` covers `date`, `dateTime`, `dateTimeStamp`, `gYear`, `gYearMonth` (our date format is already `YYYY[-MM[-DD]]`, each part optional). `boolean` covers `boolean`. `text` covers `string` and its subtypes, `anyURI`, `rdf:langString`, `rdfs:Literal`. |
  | **No range given** | Build as `text`, and list it in the preview. The vocabulary made no declaration; all we know is that it is a literal, and `text` is an honest superset. |
  | Range exists but our types cannot express it | Build as `text` **and report it**: `time`, `gMonth`, `gDay`, `gMonthDay` (no year), the `duration` family (a span, not a point in time), multiple `rdfs:range` statements (the intersection trap — do not guess the type, but the value is still a literal), and any type IRI we do not recognize. |
  | The extractor **could never read this value from prose** | **Skip it and report it**: `base64Binary`, `hexBinary` (binary blobs), `rdf:XMLLiteral` (an XML fragment), `QName`, `ID`, `IDREF`, `ENTITY` (internal XML plumbing). |

  > **Two revisions. The second overturns the first.**
  >
  > The first draft said "do not guess `text`, because a wrongly typed attribute would let a value get blocked by `attr_datatype`." Checking `normalize_attr_value` shows this is false — **`text` accepts any string and never blocks**. Only `number`, `date`, and `boolean` can block a value.
  >
  > The next idea was: "the vocabulary made a declaration, so downgrading to `text` throws it away with no trace." **This also fails**: the preview already reports it, so nothing is untraced. The real cost of skipping is that the attribute does not exist at all. The extractor is never told about it, and that piece of knowledge **is never captured** — exactly the failure this project treats as worst.
  >
  > The right line is not "can we map it precisely" or "should it be in the graph" — an attribute value already belongs in the graph. The line is **"could the extractor ever read this value out of prose."** "The store opens at 9:00" contains `09:00`, so an `xsd:time` attribute can be filled; storing it as `text` only loses sort order, the value survives. A base64 floor plan never appears in prose, so that attribute would exist but stay forever empty.
  >
  > Skipping it protects not the data (which would never have a value anyway) but **the prompt**: every attribute is a line in the extraction prompt, billed once per chunk. Attributes that can never be filled are pure, repeated noise cost.
- **Domain points to a class that was not imported** (a class in an external vocabulary): skip it and count it in the preview; do not skip silently.
- **Multiple `rdfs:domain` values**: cannot be stored yet. This case truly needs the join table.

So the order is: **ship single-domain attributes first** (P2b's output already supports this); multi-domain attributes wait for the join table.

> **One more thing found along the way: the attribute extraction path had never run.**
>
> The code was complete: the prompt has an attribute section and rule 10, `ExtractedFact` has a `value` field, `normalize_attr_value` validates by datatype, values land in `facts.object_value`, and evidence, time, and review all reuse the same machinery.
> But **the built-in ontology had zero attributes**, so `attr_lines` was always empty and the whole attribute section of the prompt never appeared. Unless someone built an attribute by hand, this path had never executed since it shipped.
>
> OWL import starts creating attributes, which brings this path to life. We tested it end to end, one case per datatype:
>
> ```
> floor_area  {"value": 860}          number, not a string
> opened_on   {"value": "2024-09-01"} date
> opens_at    {"value": "10:00"}      text (downgraded from xsd:time)
> ```
>
> Evidence, confidence, and UI rendering were all correct, with zero discard signals. **Under the old skip rule, the two `opens_at` cases would never have existed at all** — direct evidence that storing something beats losing that decision.

#### 2. Join tables: multi-value domain and range

```sql
relation_type_domains(relation_type_id, entity_type_id)   -- who can be the subject
relation_type_ranges (relation_type_id, entity_type_id)   -- who can be the object
```

A property with multiple domains is common in OWL. `datatype` stays on the `relation_types` row, since a data property's range is a literal type, not a class; the `ranges` table serves object properties only.

**The same spec trap noted above, restated here as the rule**: multiple `rdfs:domain` values on one property are an **intersection** in RDFS, not a union. If one is a subclass of the other, keep the more specific one; if neither contains the other, report "not yet projected," and do not guess.

#### 3. Type signature in the prompt

A relation line changes from `- works_at: description` to `- works_at (person → organization): description`.

**It is a signature, not a gate** — it reduces bad output like "Alice works_at Seattle" at generation time, instead of catching it after the fact. An after-the-fact check faces a fact already extracted (discard it and lose information, or keep it and pollute the data). A signature corrects the model before it writes the fact. If the ontology is wrong, the model can still follow what the source text says; a hard gate would discard data systematically, the same way `part_of` burned us before.

> **New constraint (from the language work in 0004): the signature must use the key, not the label.** In a Chinese-language base, the label for `person` is "人物". Writing `(人物 → 组织)` teaches the model to output a type that does not exist. This follows the same rule as descriptions referencing other types: always use the key. Labels are already removed from the prompt when a description is present, so the signature should not bring them back.

#### 4. Multiple inheritance as a DAG

`entity_types.parent_id` used to be a single column, able to express only a tree. Multiple inheritance is common in real vocabularies — FOAF's `Person` is both a `foaf:Agent` and a `geo:SpatialThing`, two different lines, not ancestors on one chain. P2b today **projects only the first parent**.

Dropping a branch has a real cost: `type_matches_domain` (`extraction.rs`) walks the one stored chain, so an attribute whose domain sits on the other branch fails its check — `latitude` has domain `SpatialThing`, but `person` is stored only under `agent`, so this fact is extracted and then blocked.

> **Revision**: the first draft called this a "silent mismatch." Since #41, it is no longer silent: `extraction.rs` now emits an `attr_domain_mismatch` discard signal, shown in the library as "attribute attached to the wrong type." It is still wrong (the fact should have landed), but it is now visible. Severity drops from "knowledge lost silently" to "visibly one fact short," so priority moved down.

This change touches four places:

| | Today | After |
|---|---|---|
| Storage | Single `parent_id` column | `entity_type_parents(child_id, parent_id)` join table |
| Walking up | Single-chain loop, 10 levels | Breadth-first with a **visited set** (diamond inheritance reaches the same ancestor twice) |
| Create/edit a type | No cycle risk | **Must check for cycles**: A→B→A would loop forever |
| Left panel | Already a tree | Still shown as a tree, using the **primary parent** |

The last row is a product choice: **storage is a DAG, display is a tree.** If the left panel drew the true DAG, `person` would appear under both `agent` and `spatial_thing`, and either click would be correct but would look like two different things. So we keep a "primary parent" purely for display — no longer the only parent, just the branch chosen for the tree view.

#### Order and reasoning

1. **Single-domain attribute storage** — only the range-to-datatype mapping is missing; this closes a known gap.
2. **Domain/range join tables** — unlocks multi-domain attributes and is a prerequisite for the signature.
3. **Type signature in the prompt** — about ten lines, the highest return in this document.
4. **Multiple-inheritance DAG** — independent of the first three, placed last only because it is no longer silent.

The first three form a chain; the fourth can run in parallel.

> **Revision note (2026-09-02): all four items are done.** The importer creates attributes (`create_attribute_with_iri`). `relation_type_domains` and `relation_type_ranges` exist as tables. The signature is in the prompt (`works_at (person → organization)`), listing only the types already shown on that side; if none is selected, it falls back to `*`. The single `parent_id` column **no longer exists**; multiple parents live in `entity_type_parents` (with an `is_primary` flag for the tree view). Membership checks are breadth-first with a visited set. One change beyond this document: `update_relation_type` now **allows changing domain and range** — a signature is not an identity, though `kind` still cannot change.
> See the P5 revision for the current state of all OWL axiom projection.

---

### P3 · Type resolution — making a large ontology usable

**Problem**: today the model picks a type from an **inline list** at extraction time. Nine types work well. Eight hundred types blow up the prompt and lower accuracy.

**Three layers. The first matters most.**

1. **Extraction returns only a coarse type.** The prompt always lists only base types (person, organization, product, place, event, concept). **Prompt size becomes independent of ontology size.**
2. **Type resolution (a new background task).** Embed each type's `label + description` once. As an entity accumulates a name and facts, embed **synthetic text** (name, plus the predicates it appears in, plus its coarse type), retrieve the top-k candidate types, and hand only those k to the model for a decision. High-confidence matches upgrade automatically; the gray zone goes to Review; results are cached.
3. **Types inferred by reasoning.** A type with an `equivalentClass` definition needs no model judgment (waits for P5).

> **Revision note, after testing on a real ontology.** The three points above were written before anyone measured a real ontology. Testing overturned two of them. The original text stays, because the reasoning behind the reversal is more useful than the conclusion.
>
> **First, "800 types" understates the problem, and the type list is not the largest part.** The current schema.org release measured out at 1,010 types and 1,676 properties, producing a **109,083-token prompt per chunk**. The three sections split as 38% types, 34% relations, 28% attributes — **the first layer only touches the 38%**, and the original text never mentioned the attribute section at all. Even trimming to only top-level types still leaves about 64k tokens.
>
> **Second, "list only base types" is wrong, for three reasons, all in the data:**
> - It removes a user's own custom ontology from extraction entirely. Forty types cost about 2k tokens — **not a real problem**. Extrapolating from the 968-type case to every ontology overreaches; we have only two data points, 12 types (fine) and 968 types (a problem), with nothing in between.
> - It mirrors the `related_to` trap: **give the model an escape hatch and it will use it.** Listing only base types means everything can only ever be `organization`.
> - A fact dropped at extraction time due to a coarse type **cannot be recovered by retyping later** (`type_matches_domain` checks domain at write time; we measured `attr_domain_mismatch: position@person`). A coarse type also makes entities look more alike to each other, so `classify_type_drift` fails to flag `Disjoint`, more merge candidates appear, and **a merge really does write to the ledger.**
>
> **New design: switch by budget.** If the ontology is smaller than the budget, list it all (this already works today). Above the budget, retrieve the top-K types per chunk, **with the seed base types always present** as a fallback. Attributes expand per type by domain, so trimming a type automatically trims its attributes. The budget counts characters, not type count, since type descriptions vary in length by orders of magnitude. **Where to set the budget is not yet measured**; that needs raising the inline type count from 12 to 968 step by step and finding where fact count and latency start to drop.
>
> (**Now shipped**, see [0006](0006-ontology-scale-and-the-prompt.md): the budget counts **characters, not tokens**, stored in `deployment_settings.ontology_prompt_budget` (24,000), at 40 types / 30 relations / 30 attributes per chunk — all three numbers marked "not yet measured." "Seed base types always present" stopped applying after #128 (seeds were removed); it was replaced by **ancestor backfill**: whatever type is retrieved also brings its ancestors along. The "threshold 30" axis discussed below in open questions **never existed**.)
>
> **Third, the second layer shipped, but it is more complex than described here.** See below.

#### P3a · Type resolution, measured (shipped)

Extraction returns a coarse type plus a separate **`specific_type`**: free text, not validated, not stored in the ontology — just the model's own description of the entity. **This field matters most.** Without it, in one test, all 17 entities' `proposed_type` came back empty, because the type list always has something "close enough" (the ontology has `product`, the model picks it, and its real description — "vector database software" — is lost). With it, the task changes from "understand what this is" back to "which ontology type has this name" — a short name matched to a short label, exactly what a vector index is good at. With this field added, retrieval hits rose from 4/17 to about 13/20.

**Two candidate sources, combined as a union, not scored together.** One path searches type descriptions using the entity's profile text. The other searches for entities with a similar context vector that already have a type, and treats their types as votes. The second path is structurally useless at cold start (existing typed entities all carry base types, so they cannot vote for anything finer); it becomes useful only after the first path has run a round.

**Distances are not comparable, in three separate ways, each one seen in testing.** Not comparable across entities (a distance of 0.46 for "清华大学计算机系→computer_store" is closer than 0.59 for "星云科技→corporation", though the first match is absurd). Not comparable between the two paths (type-space vs. entity-space). **Not even comparable between two queries on the same path** — a short query like "医药集团" produces systematically smaller distances than a full profile paragraph. Merging by raw distance let the name-based path dominate the top results, pushing out three correct answers that had passed on the previous run. **Always alternate between the two sources; never merge by score.**

**Do not use the model's self-reported confidence to set tiers.** Measured values were bimodal (15 cases at 0.85+ and 4 null, nothing between) — self-reported confidence is a tone, not a probability. Use instead: **is the chosen type inside the coarse type's subtree?** Inside = one step down, automatic. Outside = a different branch of classification, sent to a person.

> **But this criterion often measures the wrong thing.** On a second corpus, 24 entities produced 14 "different branch" flags, and all 14 were correct — because the check was really measuring **whether the seed type ever connected to the imported vocabulary's tree.** The keys for `organization`/`product` happened to match schema.org's same-named types (and were adopted, gaining 167 and 8 descendants respectively), while `location` did not match — schema.org's `Place` type used a different key and kept its 209 descendants on its own branch, leaving built-in `location` with zero children, so every `location → city` case counted as "different branch."
>
> The fix is to **approve by type pair, not by entity** (`type_refinement_pairs`). "Different branch" is a property of the pair (coarse type, target type); once a person approves a pair once, it is never asked again. A full fix means connecting the seed types into the imported vocabulary's tree — that is ontology alignment, a bigger job than this step.

**A rejection must state a reason.** `left_alone` started as a bare count, and this whole design bets on "choosing 'none of these' is a respectable answer" — the largest, least transparent bucket. Once we logged the reason, the first run answered a question we could not answer before: failures were **entirely on the retrieval side** (`administrative_area` and `periodical` were never even offered as candidates), not in the decision step.

**A retype does not enter the time axis.** It is one `UPDATE` on `entities` plus one row in `entity_retypes`; entity history reads only `facts`. So a wrong retype does not show up on its own — reversible is not the same as reversed. This is why we run preview before apply. **The gap to close is making a retype visible in entity history**, not moving type onto the bitemporal ledger (P0 deliberately made entities a mutable row).

#### P3b · The relation list grows too, an earlier gap

> **The extraction side of this section shipped**: the escape hatch is removed, prompt rule 8 covers it, and surface predicates land on the evidence row.
> **The mapping-back-to-ontology half also shipped, but in a different shape than described here** — not a fully automatic retrieval decision, but "cluster → a proposal with its impact shown → one-click adopt and rewrite → reversible," behind a switch that defaults to on. See [0003](0003-ontology-growth-loop.md), which records three changes of judgment along the way.

The above solved entity types only. But next to the type list in the prompt sits the **relation list**, expanded in full from the ontology and resent for every chunk, same as types. Measured (Industry Corpus): 9 types cost 197 characters; 10 relations cost **250 characters** — relations are already the larger half. And **the codebase has no prompt caching at all** (`cache_control` has zero hits), so O(chunks × ontology size) has no cache to soften it. A department-scale ontology (300 types / 400 properties) costs roughly 4,200 tokens per chunk; at 181 chunks that is 760,000 input tokens — for just 28 documents.

**We missed this at first because of an asymmetry.** `(NVIDIA, acquired, Mellanox)` is a complete fact even without knowing NVIDIA is an Organization — **type is an annotation on a node, and can be added later.** But `(NVIDIA, ?, Mellanox)` is not a fact at all — **the predicate is the fact itself**, so "leave it blank, fill in later" does not work.

**The fix is a different middle state**: defer to a **surface predicate**, not to nothing — `(NVIDIA, "acquired", Mellanox)`, free text, storable, and something the model can produce without any vocabulary. A second pass, given the full sentence plus retrieved candidates, maps it onto an ontology relation, using the same machinery as type resolution. Domain/range acts as a ranking signal here (candidates whose subject/object types match rank higher).

Three outcomes, matching the pattern used in entity resolution: high confidence rewrites the predicate (**must append a new row and mark `supersedes`, never edit in place** — the same shape as a human correction, so entity history can show "first recorded as related to, later refined to builds"); the gray zone goes to Review; **no good candidate keeps `related_to`** and turns the phrase into an ontology suggestion. This last case matters most — **`related_to` is an honest "we don't know"; a wrong specific guess is a confident mistake** (later overturned: staying at "we don't know" is indeed more honest than guessing a specific relation, but that honesty should not be a word in the ontology — showing "related to" in the UI is not vagueness, it is a claim. See [0010](0010-no-relation-is-no-relation.md)) — and downstream reasoning would then reason from a wrong, specific relation.

#### But mapping is only half: the bigger half is removing the escape hatch

> **Revision note**: this section first said only "extraction produces a surface predicate, then it gets mapped." Checking the data showed **that covers only about a tenth of cases**, so this splits into two parts.

Measured (Industry Corpus):

```
ontology_misses:  16 predicates / 38 downgrades
related_to facts: 359
```

**Only about 38 came from a downgrade. The other 321 (89%) were `related_to` chosen directly by the model.** It appears right there in the ontology's relation list, offered to the model as a valid option (`rel_pairs` only filters out `kind == "attribute"`). When the model meets a relation it cannot name clearly, it does not invent a word — it reaches for this universal option instead. **We handed it an escape hatch. It used it 321 times, and that escape hatch destroys information.**

(Checked other sources too: `mappings.rs` writes `mapped_to`, not `related_to`; `record_miss` runs once per fact inside the loop, so 38 is an upper bound on downgraded facts.)

So, two parts:

1. **Remove `related_to` from the prompt** (keep it in the ontology as a code-level fallback, but do not list it for the model). (The parenthetical is now obsolete: `related_to` was removed entirely; the fallback now happens at read time, see [0010](0010-no-relation-is-no-relation.md).) This way the model either uses a real relation or writes down what the source actually says — **the fallback happens in code, not in the model's head, and the phrase is always recorded.** The change is one filter added to `rel_pairs`, cheap — but **it needs a `surface_predicate` column first**, or this only changes "becomes related_to" into "becomes related_to, plus one extra miss count."
2. **Map it** (the retrieval-based decision process above).

**Existing data cannot be fixed retroactively.** The current 359 rows have no surface predicate saved, and 321 of them have no way to recover the original word at all. **Re-extraction is the only fix.** `Industry Corpus` is our benchmark, so re-extracting it is expected — but if this logic reaches a base a user has run for months, we must say clearly: "this applies only to new extraction; existing data needs a rebuild."

**Two-thirds of this pipeline already exists.** `ontology_misses` already holds live data (`available_from` ×9, `scales_to` ×5, `runs_on` ×4, `collaborated_with` ×4), and `extraction.rs:366-383` already accepts out-of-vocabulary predicates and records the surface form. Only the mapping step is missing. Today it is a report for a person to read, not an input to a resolver.

**A prerequisite defect (fix first)**: downgrading loses information — `f.predicate` only goes into the `record_miss` aggregate, **the exact word is not kept anywhere**, so today there is no way to answer "which facts were downgraded from `available_from`." Same principle as keeping the raw source: **do not throw it away first; that cannot be undone.**

> **Revision note**: the first plan was to add `facts.surface_predicate`. **Wrong** — `graph.rs:164-175` shows facts are deduplicated, so the first write would win that column. The right place is `fact_evidence`.

**Store it on `fact_evidence`, not on `facts`.** `insert_fact_inner` (`graph.rs:164-175`) deduplicates live facts by `(kb_id, subject_id, predicate_id, object_id)`, so one `(A, related_to, B)` row can absorb several chunks — one chunk says "runs on," another says "optimized for," and they merge into the same row. Storing it on `facts` means **first writer wins, the rest silently lost** — exactly the bug this fix targets. `fact_evidence` already has one row per chunk and already carries a `quote` (the source text for that chunk); a surface predicate is the same kind of thing: the raw form of each individual observation. The grain matches, and it needs no new concept.

Add `fact_evidence.surface_predicate TEXT` (shipped as **`proposed_predicate`**, used below under that name). Write it on both paths (on the relation path, write the pre-downgrade `f.predicate`; on a normal match, write the exact word the model used, since it may be an alias). This has value even before mapping ships — Review and the entity panel can already show "the source said available from, downgraded to related to," which today is invisible to the user (the frontend has zero special handling for `related_to`).

**Mapping does not replace the miss report.** A predicate that keeps recurring and never maps (`available_from` ×9) is exactly the signal that "the ontology should add this relation" (fuel for P4). Mapping only consumes the high-confidence cases; the rest stays in the miss report as a suggestion.

**Do not use `profile_embedding` for this retrieval.** It is the centroid of the chunks an entity appears in — it represents "what kind of document this appeared in," not "what this is." A person mentioned in a GPU launch article gets a GPU-flavored centroid. A fresh embedding of the synthetic text is required.

**Cost (projected from measured data)**
- For an existing small-ontology deployment: **zero** — below the type-count threshold (about 30), this does not activate; the coarse type already is the fine type.
- Compared with "naively import 500 types": **a large saving.** 500 types in the prompt cost about 8,000 tokens × 181 chunks = 1.4 million extra input tokens; the retrieval approach keeps the prompt near 466 characters.
- Net change: **calls up 15–20%, tokens up about 5%** — type-resolution calls carry no chunk text, so they are an order of magnitude smaller than an extraction call; batching (already about 40:1 in the existing decision task) plus tiered thresholds keep most entities out of the model call entirely.
- New cost: 917 short-text embeddings, on the same order as embedding a hundred more chunks.

**The real risk is not cost, it is quality.** At large ontology scale, a wrong decision turns into noise at scale. The mitigation is still criterion 4: auto-upgrade only when similarity is high and clearly ahead of the next-best option; send the gray zone to Review.

**Every entity gets a type on first extraction.** `entities.type_id NOT NULL`; there is no "unclassified" state. The coarse type is a real type, not a placeholder, and at small ontology scale it is the final type. Upgrading runs on the same task chain as the document extraction job, alongside batched adjudication, within seconds.

> **Revision note (2026-09-02): both sentences above are now reversed.** `type_id` is now nullable ([0009](0009-no-type-is-a-type.md)); "no type" now really means no type, and it can be **a human decision** (`type_source = human`). "Upgrading runs on the same task chain" **was never implemented**: extraction only queues `bootstrap_ontology` and `adjudicate_entities`; type resolution today runs only through a manual preview → apply on the ontology page. See P3a for why: retrieval hit rate is not yet good enough to run automatically. This is a real gap, not a trade-off: **at ontology scale, refining a new entity depends on a person remembering to click a button.**

---

### P4 · Governance as accumulated experience

> The governance loop that actually shipped takes a different shape: adopt-and-rewrite, reversible, with a switch controlling automation. See [0003](0003-ontology-growth-loop.md). Of the three items below, **item 1 shipped** (2026-08-30, #114); items 2 and 3 are not done.

**The order matters**: P0's editing capability must exist first, before a human decision can be protected or learned from.

1. **A decision must not be forgotten (a correctness requirement, not a feature)** — **shipped** (`entities.type_source`, #114). `entities.type_source` (extracted / human / inferred) is guarded on four paths: type resolution input, ontology new-type adoption, extraction auto-upgrade, and manual retype (an `actor` value always sets it to `human`).

   > **The premise here was already false when written; recorded because chasing the wrong lead costs more than not finding one.** This section said "a re-extraction would silently overwrite governance work," but the extraction path already guarded against that (`resolve_type_drift` only upgrades when `type_key.is_none()`). The real gap was **type resolution**: its input rule, "include an entity if its current type still has subtypes," pulls back in entities a human already decided on.
   >
   > After [0009](0009-no-type-is-a-type.md), there is a second case: "no type" can now be **a human decision**, and `type_id IS NULL` cannot tell "not yet judged" apart from "a person judged it and there is no type."

2. **Search past decisions as input** — **not done**. `resolution_verdicts` is already half of this pattern, but it matches by exact `pair_key`, without generalizing. Type decisions need one more step: store the retrieval vector and outcome of each human retype, then, for the next classification, **retrieve the most similar past decision as evidence** for the decision step. Generalize by context similarity, not by matching names (criterion 3).

   > **Recommend sequencing this after a benchmark corpus exists**: this is the one item of the three where, even done, we could not tell if it helped — and the top open question in this document is exactly the lack of a real enterprise ontology for small-sample evaluation. Tuning it without a baseline is another guess.

3. **Aggregate corrections into ontology signals (highest return)** — **not done**. If 37 entities moved from Product to Concept in a month, the fix is not those 37 rows — it is that Product's description is too loose. Add a signal panel to the ontology page: "Product → Concept, 37 moves in the last 30 days," with sample entities, and a "draft a stricter description with AI" action next to it — the same shape as the existing "Suggest with AI" button on the misses panel.

   > **The data source is `audit_events`, not `entity_retypes`.** A human correction happens through two actions: `entity.retyped` (a direct edit in the entity panel, one row at a time) and `ontology.refinement_approved` (approval in the review queue, a batch with a from/to move count); both carry an actor.
   > `entity_retypes` is an **undo log** (scoped to a batch); aggregating from it would mix in retypes the engine made on its own — that would read as "the engine keeps changing its mind," not "a person keeps correcting you."

---

### P5 · Reasoning engine (long term)

> **Superseded by the schedule in [0002](0002-reasoning-engine.md)**. What this section says the engine can eventually consume still holds, but the order changed: 0002 found that real text already contains a `part_of` cycle on day one (the transitive closure oscillates past depth 5 and never converges), so the reasoning engine's first delivery is **consistency checking**, not derivation — the same evaluation engine, run in the opposite direction, at zero risk, and it immediately surfaces 11 existing contradictions.

`utopia-reason` is a 3-line empty shell today. (**Now built**, nearly 2,000 lines: R0 consistency checking and ontology self-checks, R1 materialized derivation behind a switch — see the [0002](0002-reasoning-engine.md) revision.) Once it ships, it can consume exactly the axioms P2 kept but never projected:

- `TransitiveProperty` → "everything under NVIDIA" (today only guessable by following hops one at a time)
- A cardinality other than 1 violated → **a consistency alert goes to the Review queue**, turning the ontology into a data-quality rule
- `someValuesFrom` and class expressions → automatic classification, with no explicit type needed on the entity
- `equivalentClass`, `inverseOf`, and property chains → standard reasoning input
- `disjointWith` → prune merge candidates that would cross incompatible types (the "type drift" logic in `resolution.rs:103` can retrieve across types; this lets it reject impossible combinations)

**None of this can be read today, but keeping the raw source in P2 means no user needs to re-upload anything when it ships.**

> **Revision note (2026-09-02): most of it can be read today.** Axioms now projected into storage: `TransitiveProperty`, `SymmetricProperty`, `AsymmetricProperty`, `IrreflexiveProperty`, `FunctionalProperty`, `InverseFunctionalProperty`, `disjointWith`, `inverseOf`, `subPropertyOf`. Still "not yet projected": `equivalentClass`, `someValuesFrom` and class expressions, and property chains. Status of the five points above: Transitive feeds an R1 rule (with cycle detection and a per-predicate cap); cardinality violations go to `axiom_violations` for Review; `equivalentClass` and class expressions are not done; `inverseOf` and `subPropertyOf` feed R1 (#177, #179); **`disjointWith` is only half-delivered** — import stores `entity_type_disjoint`, but the only consumer is R0's ontology self-check (unsatisfiable classes); the resolution side, `classify_type_drift`, still uses a hardcoded `CONFUSABLE_TYPE_KEYS` list — [0009](0009-no-type-is-a-type.md) calls for reading this from the ontology instead, and that has not been done.

---

## Open questions

- **No accuracy number exists for auto-upgrade.** This needs small-sample evaluation on a real enterprise ontology; today we only have projections.
- **The role of the `active` flag**: first meant as a fix for scale (wrong — scale should be solved by P3's retrieval), now used only for governance (a retired old type is excluded from assignment). Whether it deserves separate treatment waits for a real large ontology.
- **The threshold of 30 was a guess** — how many types before type resolution should turn on needs measurement. (This axis no longer exists; it was replaced by a character budget. The new unmeasured numbers are 40/30/30 per chunk; see [0006](0006-ontology-scale-and-the-prompt.md).)
- **`disjointWith` and `SymmetricProperty` bring moderate value**: the first prunes wrong merges; the second removes duplicates (measured 8 reversed-duplicate pairs in new text, 1% of 910 facts). Scheduled after P2, as needed. (Symmetric now feeds the R0 check and an R1 rule; `disjointWith` feeds the ontology self-check, but **pruning on the resolution side is still not done**.)

---

## Benchmark corpus

The `Industry Corpus` base is kept (18 NVIDIA blog posts, 10 Microsoft newsroom posts, ingested by RSS). It is the source of every number above, and the baseline for future evaluation — run the same base before and after a change so the numbers stay comparable. Do not run destructive experiments on it.

(**2026-09-02**: the baseline has changed. After the seed ontology was retired, this base's starting point can no longer be reproduced. The current benchmark runs on the repeatable corpora in `scripts/bench/`, with the ontology side using `ai-timeline-ends × schema.org + W3C Org` ([0012](0012-the-ontology-is-a-contract-not-a-suggestion.md)). The numbers in this document are still real measurements from that time; they can no longer be compared with today's numbers.)

Branch status is not recorded here: git already tracks it, and writing it here would only go stale.

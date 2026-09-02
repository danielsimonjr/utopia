# 0009 · "Not yet classified" should not be a type

- **Status**: Implemented. `entities.type_id` and `entity_retypes.from_type_id` are nullable. The nine built-in types and the seeding function are retired, along with the seed relations (#110, #125, #128, [0011](0011-a-mapping-is-not-a-fact.md)). Both open questions are still open, and the second now has a visible cost (checked 2026-09-02).
- **Written**: 2026-08-30 (see conventions in [README](README.md))
- **Related**: [0008](0008-ontology-packs-as-cold-start.md) makes a real vocabulary an optional starting point; this document removes the built-in one. The IRI/key split from [0001](0001-ontology-import-and-governance.md) is the basis for the key-collision argument here.

> This document has no benchmark numbers. It is a correction of category — `concept` was always treated as part of the ontology, when it is actually part of control flow. The correction rests on facts in the code and a key-collision scenario, both reproducible.

## Starting point: nine built-in types, none of which should stay

Creating a base seeded nine entity types (`graph.rs`'s `DEFAULT_ENTITY_TYPES`):

```
person  organization  project  metric  dimension  product  event  concept  location
```

0008 already showed their shared flaw — **not one carries a type signature**, so direction can only be described in prose. Once schema.org is installed, they become redundant too: `Person`, `Organization`, `Product`, `Event`, and `Project` all get adopted by key collision, meaning the built-in versions were only ever placeholders.

**`location` is the counter-example that proves the point.** In schema.org this concept is named `Place`; the key does not match, so it is never adopted. `City` and `AdministrativeArea` attach instead to a separately created `place` type, forming a second tree next to `location`. A name we chose ourselves ends up splitting the whole geography subtree in two.

`metric` and `dimension` are semantic-layer concepts that genuinely have no counterpart in schema.org — but the code has zero references to them outside tests. They were only ever **seeded defaults**, not a mechanism.

## `concept` is control flow, not vocabulary

Eight of the nine are vocabulary content: they can change, be disagreed with, or be replaced by schema.org. `concept` is different:

```rust
// extraction.rs
let concept_type = *type_ids.get("concept")
    .ok_or_else(|| anyhow!("Ontology missing the 'concept' type"))?;
```

It encodes one state: **"the extractor found something, but the ontology has no matching type for it."** This state exists under any ontology, regardless of whether schema.org or FIBO is installed. Without it, an extracted entity could only be discarded — and all of 0001 P1 exists to fix exactly that kind of "silent discard."

It carries three jobs: a landing place for a type outside the vocabulary (while `record_miss` records it as an ontology-growth signal), the input scope for type resolution (`entities_for_type_resolution(kb, DUMPING_GROUND, …)`), and type reconciliation during entity merges (a fallback type steps aside for a specific one).

## The decision: not renaming it, removing it entirely

The first draft proposed keeping the sentinel row and renaming its key to `_unclassified`. **Rejected** — but this alternative is worth recording, since the reason for rejecting it is the real conclusion of this document.

Renaming would have worked, because `key_from_iri` can never produce a leading underscore — if the first character is not alphanumeric, `out.is_empty()` stays true and the underscore is never pushed. Measured:

```
skos:Concept        -> "concept"      ← would collide
http://x#_Concept   -> "concept"      ← the leading underscore is stripped
http://x#__unclass  -> "unclassified"
```

So `_unclassified` sits in a namespace no import can ever reach. **This is a guarantee from the algorithm, not a convention someone has to remember.**

But leaving it unrenamed would cause a real incident: the sentinel row **has no IRI**, and the import rule is "a placeholder with no IRI gets adopted." So `skos:Concept` would **take over the sentinel row**, and overnight, every "not yet classified" entity would become a proper `skos:Concept`. This is not a skipped collision — it is meaning silently rewritten. SKOS is not an obscure vocabulary.

**But renaming only fixes the collision, not leakage.** A sentinel row must be filtered out of every single consumer: the ontology page, the extraction prompt, candidate lists, the graph legend, exports, statistics. Missing even one means it shows up there as a real type — silently.

This is exactly the kind of defect this codebase repeatedly warns against. The opening comment in `ontology_index.rs` states:

> **Self-heals; does not rely on a hook.** … a missed hook rots silently, while checking against the source text does not.

`_unclassified` **substitutes a naming convention for a real type guarantee**: it prevents an import collision, but it cannot prevent some `SELECT` somewhere from forgetting `WHERE key NOT LIKE '\_%'`.

**So `entities.type_id` becomes nullable instead.** "No type" simply means no type, with no fake type standing in for it.

The first draft claimed here that "NULL cannot be forgotten — SQL and the type system will catch it immediately." **Only half of that turned out true, and the wrong half matters more.**

On the Rust side, this held completely: turning a field into `Option` makes the compiler list every single consumer of it, with nothing missed (the node-fetching query in `graph.rs`, both sides of a review item, the adjudication prompt, the entity list shown in chat). Forgetting a sentinel gives no warning at all; forgetting an `Option` will not even compile.

**On the SQL side, it did not hold.** `NULL <> uuid` evaluates to NULL, not true, so a condition like this:

```sql
AND type_id <> $2      -- used by both adoption and retyping to pick "rows that need to change"
```

**matches zero rows, silently, with no error.** This bug hit twice, both on the main path: `adopt_proposed_types` (adopting entities waiting on a newly grown type) and `retype_entities` (applying a type-resolution decision). Both queries' inputs are almost entirely `type_id IS NULL` entities — so the feature silently did nothing, while tests still passed. The fix is `IS DISTINCT FROM`. In one measured case (an unclassified entity with `proposed_type='vehicle'`): `<>` matched 0 rows; `IS DISTINCT FROM` matched 1.

So the real cost of this decision was not "90 references to update" — it was **re-checking every comparison inside 26 SQL statements.** The type system can count the 64 Rust references; it cannot count what is inside SQL strings.

## The cost, itemized

**90 references, 26 inside SQL strings.** All checked one by one; the actual change touched 14 files, `+316 / -369` — **more removed than added**, since the two built-in tables (nine types and their Chinese wording) disappeared along with the seeding loop.

**Two unique indexes carry a `type_id` prefix:**

```sql
CREATE UNIQUE INDEX … ON entities (kb_id, type_id, lower(canonical_name))
  WHERE merged_into IS NULL;
```

In Postgres, **NULL is never equal to NULL**, so two unclassified entities sharing a name are not blocked by this index — two unclassified entities both named "Zhang San" can coexist.

**This is the intended behavior, not a defect**: this index was always meant to allow duplicates of the same type and name (0001 P0 already argued two people named Zhang Wei must be storable separately — prefer separate over merged). When entities are unclassified, we **know even less** about whether they are the same thing, giving even less reason to merge them. This is recorded here because, six months from now, someone seeing "duplicate unclassified same-name entities allowed" might mistake it for a bug.

**`CONFUSABLE_TYPE_KEYS` is unaffected.** It looks up by key (`["organization","project","product"]`), and these keys still exist once schema.org is installed — only their source changed, from a built-in seed to an imported vocabulary. In a base with no pack installed, these keys do not exist, so this check never matches, and every cross-type same-name pair is judged `Disjoint` (fully separate). **That makes the check stricter, not looser**, and cannot cause a wrong merge.

The real fix is still the one noted in the code comment — read this from the ontology once `disjointWith` is stored, which is R0's third phase in 0008. This document leaves it unchanged.

(**2026-09-02**: the precondition now holds, but the fix is still not done. `owl:disjointWith` has a table (`entity_type_disjoint`), an importer, and an edit UI, but its only consumer is R0's ontology self-check; `CONFUSABLE_TYPE_KEYS` is still a hardcoded list of three keys, and its own comment still describes the old world.)

## An empty base

Once removed, a base with no pack selected is **genuinely empty**: extracted entities get `type_id = NULL`, while facts still land and evidence chains still work as before. Installing a pack later and re-running type resolution reassigns entities — `entities_for_type_resolution` already selected entities "sitting on the fallback type"; it now simply selects `type_id IS NULL` instead.

**So "build the base first, model it later" is a supported path, not a workaround.**

(One column not described here was added at ship time: `entities.type_source` — extracted, human, or inferred. 0009 makes `type_id IS NULL` carry two different meanings at once, "not yet judged" and "a person judged it and decided there is no type"; this column tells them apart, and also filters the input to type resolution, per 0001 P4a. `specific_type` and `proposed_type` are kept as separate columns too — the former is the model's own free-text description of the entity, used only by type resolution.)

Alongside this: schema.org is now checked by default in the base-creation dialog, with the option to uncheck it. This is not viable at 45 seconds per import, but it is viable at 0.42 seconds (measured after the importer switched to a batch insert).

## Two things settled at ship time

**How the graph draws it.** The node-fetching query changed from `JOIN entity_types` to `LEFT JOIN` — an inner join would make unclassified entities **vanish from the graph entirely**, with the underlying fact still in the database but no way to find it — one of the hardest kinds of data loss to notice. `key` and `label` stay NULL; **color and shape get a default value** (a gray dot): the first pair is identity, and should say plainly when it is missing; the second pair is required for rendering, and cannot be left unresolved. The same handling applies on both sides of a review item.

**Assigning its first type does not count as "crossing a branch."** Type resolution treats "the chosen type is outside the current type's subtree" as a reclassification rather than a refinement, and always routes it to a person. An unclassified entity has **no prior extraction decision to overturn** — its first classification is filling a gap, not correcting one. If this were also flagged as crossing a branch, removing the sentinel type would cost a human review for every single entity, defeating the whole point of automation. To match this, `entity_retypes.from_type_id` also became nullable — the most common retype is exactly "from no type to a type," and that table is the only record undo relies on; if it required a non-null value, a first-time classification could never be logged, and that whole batch of changes could never be undone.

## Open questions

- **Resolution of unclassified entities**: with no type dimension in the profile, `classify_type_drift` loses one of its signals. Two unclassified entities sharing a name today fall back to profile similarity through `Recall` — whether that is good enough has not been tested.
- **Where `metric` and `dimension` belong**: the semantic layer needs them, and no public vocabulary supplies them. Should users build them by hand, or should we ship a "Utopia semantic layer" pack? The second option would move the built-in ontology out of the code and into a pack — a fundamentally different kind of thing: optional, carrying an IRI, and replaceable. (**Still unanswered, and now has a visible cost**: mapping exploration looks for types via `entity_types.key IN ('metric','dimension')`, and `continue`s if it finds none — in a base with no pack installed and no one having built these types by hand, exploration **silently produces zero results.**)

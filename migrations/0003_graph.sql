-- The graph layer: the ontology vocabulary, entities, the bitemporal fact ledger, and the evidence chain.
-- See docs/DESIGN.md, section 3, for the design: facts are append-only. Extraction errors set
-- invalidated_at. A fact that changes closes its valid_to instead of being deleted.

-- Classes. **The two embedding columns are not redundant.** Type resolution issues two kinds
-- of query (see type_resolution.rs): one is the short form the model gives (`district. place`),
-- and the other is a full profile. This table once compared both query kinds against the same
-- `label + description` vector. The two query shapes did not match the one document shape, and
-- a short query would then match a class whose label and description repeated each other
-- (`Park\nA park.` wins by length, not by meaning: the median length of a matched class was 44
-- characters, against a median of 89 characters across the whole set).
--
-- This repository has fixed the same underlying pattern four times, in four different
-- places: comparing distance across entities, comparing distance across the two query kinds,
-- comparing distance between two queries of the same kind, and giving an advantage to a class
-- with an empty description. Each earlier fix changed the query side. This fix changes the
-- document side instead: **two kinds of query need two kinds of document**, short compared
-- against short, and long compared against long.
--
-- The dimension varies, the same as chunks.embedding, with the workspace's chosen model, so
-- this table has no HNSW index and search does a sequential scan. An ontology has thousands
-- of rows at most, and a sequential scan handles that size without trouble.
CREATE TABLE entity_types (
    id         UUID PRIMARY KEY,
    kb_id      UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    key        TEXT NOT NULL,
    label      TEXT NOT NULL,
    color      TEXT NOT NULL DEFAULT '#64748b',
    builtin    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- The graph renders a node's shape by its type. An earlier version hardcoded
    -- organization and product to a square shape in the frontend.
    shape      TEXT NOT NULL DEFAULT 'circle' CHECK (shape IN ('circle', 'square')),
    -- This is not a display decoration. It is a semantic instruction fed into the
    -- extraction prompt (for example: "Event: something with a clear point in time, such
    -- as a launch, an acquisition, or a meeting"), and it directly affects extraction quality.
    description TEXT NOT NULL DEFAULT '',
    -- The IRI is the global identity; key is the short label the model reads. See "the
    -- roles of IRI and key" under criterion 2 in ADR 0001. A re-import matches an
    -- existing row by IRI. Matching by key instead would treat the same class as a new
    -- class whenever an upstream change to rdfs:label changed the key, and every entity
    -- of that class would become orphaned.
    iri        TEXT,
    -- The long-document embedding: label plus description.
    embedding  vector,
    -- **This column stores the text that was embedded, not just a timestamp.** A
    -- timestamp can only answer "was this embedded," not "does the embedding still match
    -- the current text." When a description changes or the model changes, the vector
    -- becomes stale, and a timestamp cannot show that. Storing the source text and the
    -- model name lets a backfill job compare them directly and find exactly which rows
    -- need a new embedding, without adding a hook at every place that writes a description
    -- (a missed hook would let a row go stale silently).
    embedded_text  text,
    embedded_model text,
    -- The short-document embedding: label only.
    label_embedding      vector,
    label_embedded_text  text,
    label_embedded_model text,
    UNIQUE (kb_id, key)
);
CREATE UNIQUE INDEX entity_types_iri_idx ON entity_types (kb_id, iri) WHERE iri IS NOT NULL;

CREATE TABLE relation_types (
    id         UUID PRIMARY KEY,
    kb_id      UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    key        TEXT NOT NULL,
    label      TEXT NOT NULL,
    -- The time behavior: state (holds over an interval), event (holds at one point in
    -- time), or eternal (holds with no time attached).
    temporal   TEXT NOT NULL DEFAULT 'state' CHECK (temporal IN ('state', 'event', 'eternal')),
    -- Cardinality: at most one value at a given moment. Temporal conflict detection
    -- (which closes valid_to automatically) uses this pair of flags: functional means
    -- the subject side is unique; inverse_functional means the object side is unique
    -- (one leader per project).
    functional BOOLEAN NOT NULL DEFAULT FALSE,
    inverse_functional BOOLEAN NOT NULL DEFAULT FALSE,
    builtin    BOOLEAN NOT NULL DEFAULT FALSE,
    -- The attribute system: an attribute is a relation whose value is a literal (an RDF
    -- datatype property). This one table serves both purposes. An attribute's value goes
    -- through the facts.object_value column, and the full set of temporal, evidence, and
    -- review features applies to it the same way.
    kind       TEXT NOT NULL DEFAULT 'relation' CHECK (kind IN ('relation', 'attribute')),
    datatype   TEXT CHECK (datatype IN ('text', 'number', 'date', 'bool')),
    unit       TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    description TEXT NOT NULL DEFAULT '',
    iri        TEXT,
    embedding  vector,
    embedded_text  text,
    embedded_model text,
    -- The remaining relation axioms belong to the same family as functional and
    -- inverse_functional; those two simply reached the database first. **These default
    -- to false, not NULL.** OWL treats the world as open, but a consistency check can
    -- only judge what is written down. "Not declared" and "declared false" lead to the
    -- same outcome here (neither one raises a contradiction), so there is no need for a
    -- three-state value to mark a difference that has no effect on behavior.
    --
    -- **The is_ prefix on these column names is not a style preference.** `symmetric`
    -- and `asymmetric` are reserved words in Postgres (`BETWEEN SYMMETRIC`), and using
    -- them bare would fail with a syntax error on the CREATE TABLE line itself. Quoting
    -- them would work, but every later piece of SQL that touches these columns would
    -- then need to remember the same quoting, and a missed instance would fail only at runtime.
    is_transitive  BOOLEAN NOT NULL DEFAULT FALSE,
    is_symmetric   BOOLEAN NOT NULL DEFAULT FALSE,
    is_asymmetric  BOOLEAN NOT NULL DEFAULT FALSE,
    is_irreflexive BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE (kb_id, key)
);
CREATE UNIQUE INDEX relation_types_iri_idx ON relation_types (kb_id, iri) WHERE iri IS NOT NULL;

-- domain and range are **join tables, not columns.** In OWL, a property with several
-- rdfs:domain values is common (works_at can take a person or an organization as its
-- subject); a single column cannot express that, and import would have to pick one value
-- and drop the rest (FOAF has properties like this). This design also avoids a separate
-- "primary domain" column, because that would record the same fact in two places, and two
-- places recording the same fact tend to drift apart (a past bug came from computing a key
-- conflict once for the preview and once for the save, so the preview reported a result
-- that did not match what was saved). One authoritative place removes the guesswork about
-- which value to trust.
--
-- range applies only to object properties. A datatype property's range is a literal type,
-- and that value lives in relation_types.datatype instead.
CREATE TABLE relation_type_domains (
    relation_type_id UUID NOT NULL REFERENCES relation_types(id) ON DELETE CASCADE,
    entity_type_id   UUID NOT NULL REFERENCES entity_types(id)   ON DELETE CASCADE,
    PRIMARY KEY (relation_type_id, entity_type_id)
);

CREATE TABLE relation_type_ranges (
    relation_type_id UUID NOT NULL REFERENCES relation_types(id) ON DELETE CASCADE,
    entity_type_id   UUID NOT NULL REFERENCES entity_types(id)   ON DELETE CASCADE,
    PRIMARY KEY (relation_type_id, entity_type_id)
);

-- These indexes support the reverse lookup: the ontology page lists a class's relations,
-- and extraction filters the relations available to a class. The primary key covers the
-- forward lookup; the reverse lookup needs its own index.
CREATE INDEX relation_type_domains_entity_idx ON relation_type_domains (entity_type_id);
CREATE INDEX relation_type_ranges_entity_idx  ON relation_type_ranges  (entity_type_id);

-- subClassOf. **A class can have more than one parent.** This is common in a real
-- vocabulary: FOAF's Person is both a foaf:Agent and a geo:SpatialThing, which are two
-- separate branches, not ancestors on one chain. Allowing only one parent would fail a
-- domain check for a property that sits on the other branch (latitude's domain is
-- SpatialThing, but if person is attached only under agent, that extracted fact would be
-- blocked).
--
-- **is_primary is not redundant.** The left-hand panel displays classes as a tree, and a
-- class can appear in only one place in that tree. Which branch it appears under is a
-- question the subClassOf set alone cannot answer; is_primary carries that extra piece
-- of information, and it does not repeat the same fact twice.
CREATE TABLE entity_type_parents (
    child_id   UUID NOT NULL REFERENCES entity_types(id) ON DELETE CASCADE,
    parent_id  UUID NOT NULL REFERENCES entity_types(id) ON DELETE CASCADE,
    -- The tree in the left-hand panel follows this branch. This flag affects display only,
    -- not semantics.
    is_primary BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (child_id, parent_id),
    -- This blocks a direct self-reference. A longer cycle is checked by the application
    -- before a write, because SQL alone cannot catch a cycle like A -> B -> A.
    CONSTRAINT entity_type_parents_no_self CHECK (child_id <> parent_id)
);

-- Each class has at most one primary parent.
CREATE UNIQUE INDEX entity_type_parents_primary_idx
    ON entity_type_parents (child_id) WHERE is_primary;

-- This index supports the reverse lookup: the left-hand panel finds child classes from a
-- parent class, and a domain check walks up the parent chain.
CREATE INDEX entity_type_parents_parent_idx ON entity_type_parents (parent_id);

-- Class disjointness. **This is a table, not an array column.** The question this table
-- answers is "are A and B disjoint," which is a single-row lookup. An array column would
-- need either a full table scan or a GIN index to answer that, when the underlying
-- relationship is really just one edge.
CREATE TABLE entity_type_disjoint (
    kb_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    a_id  UUID NOT NULL REFERENCES entity_types(id) ON DELETE CASCADE,
    b_id  UUID NOT NULL REFERENCES entity_types(id) ON DELETE CASCADE,
    -- Each direction gets its own row; the axiom's symmetry is expanded on the import
    -- side already. The primary key removes duplicates as a side effect, and a query
    -- does not need to know which side the caller asked from.
    PRIMARY KEY (kb_id, a_id, b_id),
    -- A class cannot be disjoint from itself; this rule has no useful meaning, and
    -- rejecting it here is simpler than leaving it for a consistency check to catch later.
    CHECK (a_id <> b_id)
);

-- "Which classes are disjoint from this one" is the only lookup this table supports (a
-- consistency check asks this question using an entity's class).
CREATE INDEX entity_type_disjoint_a_idx ON entity_type_disjoint (kb_id, a_id);

CREATE TABLE entities (
    id             UUID PRIMARY KEY,
    kb_id          UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    -- **This column can be NULL.** See docs/decisions/0009: "not yet classified" is not
    -- itself a class. An earlier design used a sentinel row named concept for this case,
    -- and a sentinel has a name, so it could collide with a real class: SKOS's
    -- skos:Concept produces the key concept, and the import rule "a placeholder with no
    -- IRI is claimed by the first row with that key" let it take over the sentinel. Every
    -- unclassified entity then silently became a proper skos:Concept overnight, with no
    -- warning about a name collision. A NULL value has no name and cannot collide, and it
    -- cannot be missed either: skipping a sentinel by mistake produces no error, while
    -- skipping a NULL check fails immediately.
    type_id        UUID REFERENCES entity_types(id) ON DELETE RESTRICT,
    canonical_name TEXT NOT NULL,
    aliases        TEXT[] NOT NULL DEFAULT '{}',
    attrs          JSONB NOT NULL DEFAULT '{}',
    -- After a merge, this points at the surviving entity. A merge can be reverted; see
    -- the later work on that in criterion 2.
    merged_into    UUID REFERENCES entities(id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- The entity's profile: a running centroid of its evidence chunk vectors, used for a
    -- context similarity check. This reuses the chunk embeddings already computed during ingest.
    profile_embedding vector,
    profile_n      INTEGER NOT NULL DEFAULT 0,
    -- A display suffix that disambiguates two entities that share a name (for example,
    -- "Zhang San, Platform Engineering").
    disambiguator  TEXT,
    -- The type the model proposed: **the word it used when the ontology had no matching
    -- class.** Without this column, finding the entities behind a proposed new class
    -- would be impossible; they would sit mixed in with every other unclassified entity,
    -- and the only way to find them would be to re-extract the whole knowledge base.
    proposed_type  TEXT,
    -- The model's own description of this entity: what it considers the most specific
    -- thing this entity is.
    --
    -- **This is a separate column from proposed_type, and the two must not merge.**
    -- proposed_type means "the ontology has nothing matching what the model wanted." The
    -- ontology growth loop uses how rarely that happens as its threshold; if every entity
    -- filled this column, the loop would propose a new class for every single entity.
    --
    -- Why this column exists: every class list has one entry that is close enough. When
    -- the ontology already has product, and the model judges that close enough, it
    -- selects product, and the more specific idea in its head ("vector database
    -- software") is lost. Type resolution needs exactly this kind of name: a short name
    -- compared against a short label is a much closer match than comparing a paragraph
    -- of Chinese prose against schema.org's "A software application."
    specific_type  text,
    -- **How this type was set.** Protection needs to happen before the fact:
    -- entity_retypes records who made a later change, but that is a record after the
    -- fact. An entity itself needs a marker that says whether a person has ever made a
    -- decision on it; otherwise, every read path can see only type_id. This gap showed
    -- up in type resolution: an entity a person manually set to organization would still
    -- be picked up and re-judged in the next round, as long as organization had subclasses.
    --
    -- Since ADR 0009, there is also a second case: "no type" can now be **a person's
    -- decision** — someone looked at this entity and judged that the ontology has no
    -- matching class. `type_id IS NULL` alone cannot tell "not yet judged" apart from
    -- "a person judged it and there is no match," so the next extraction pass would
    -- assign it a type anyway.
    --
    --   extracted  set by extraction (an upgrade from resolve_type_drift)
    --   inferred   set by the reasoning engine (type resolution, or claimed after the
    --              ontology grew a new class)
    --   human      set by a person (a direct edit in the entity panel, or an approval
    --              in the review queue)
    --
    -- inferred and extracted stay separate instead of merging into one "not human" value,
    -- because they carry different confidence levels. If a future rule needs "the engine
    -- may change its own decisions, but not extraction's," this column already supports it.
    type_source    TEXT NOT NULL DEFAULT 'extracted'
                   CHECK (type_source IN ('extracted', 'human', 'inferred'))
);
-- **This index is not unique.** A name is not an identity (see the two people both named
-- Zhang Wei in criterion 0 of ADR 0001); two entities with the same name are allowed to
-- coexist. This index supports candidate lookup only.
--
-- Since ADR 0009, type_id can also be NULL, and Postgres treats NULL <> NULL as true, so
-- two unclassified entities with the same name are not blocked here either. This is the
-- correct behavior: without a class, the system knows less about whether two entities are
-- the same thing, and so it has even less reason to merge them.
CREATE INDEX entities_kb_type_name_idx
    ON entities (kb_id, type_id, lower(canonical_name)) WHERE merged_into IS NULL;
CREATE INDEX entities_kb_idx ON entities (kb_id);
-- This index supports a cross-type name lookup (used when handling type drift): the index
-- above has a type_id prefix, so a query that spans types cannot use it.
CREATE INDEX entities_kb_name_idx
    ON entities (kb_id, lower(canonical_name)) WHERE merged_into IS NULL;

-- The fact ledger: subject-predicate-object rows with two time axes. This table is
-- append-only; a row is never deleted.
CREATE TABLE facts (
    id              UUID PRIMARY KEY,
    kb_id           UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    subject_id      UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    -- **This column can be NULL.** "Cannot name the relation" should not itself become a
    -- relation (the same reasoning ADR 0009 applies to concept). An earlier design used a
    -- builtin relation named related_to for this case, listed on the ontology page next
    -- to real relations, even though what it encoded was "extraction found an edge, but
    -- the ontology has no matching relation." That is a control-flow signal, not vocabulary.
    --
    -- Removing it loses no information: the original wording already lives in the
    -- evidence row's proposed_predicate column; the fake vocabulary entry only covered it
    -- up. Removing it actually surfaces more information: before, every one of these
    -- showed as "related"; after, each shows the word the source text actually used, such
    -- as acquired, runs_on, or sued (see fact_surface_predicate).
    predicate_id    UUID REFERENCES relation_types(id) ON DELETE CASCADE,
    object_id       UUID REFERENCES entities(id) ON DELETE CASCADE,
    object_value    JSONB,
    valid_from      TIMESTAMPTZ,
    valid_to        TIMESTAMPTZ,
    -- **Each endpoint records its own precision, and a NULL date carries no precision.**
    --
    -- An earlier design used one column, `valid_precision NOT NULL DEFAULT 'day'`, so a
    -- fact with no date at all was still stored with a value of 'day'. The ledger filled
    -- in a specific value at a point where it had no information, and any interface that
    -- rendered "accurate to the day" from that column would state that value as fact. The
    -- default value itself was the bug: it made "never measured" look identical to
    -- "measured to the day."
    --
    -- One column describing two endpoints also fails: a fact with only a valid_to value
    -- (something true "until 2023," for example) would have that value stored under a
    -- column named "from," which describes the wrong endpoint.
    valid_from_precision TEXT,
    recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    invalidated_at  TIMESTAMPTZ,
    confidence      REAL NOT NULL DEFAULT 1.0,
    derived_by_rule UUID,
    supersedes      UUID REFERENCES facts(id),
    -- The end-of-validity precision adds one more value, 'unknown', because the ledger
    -- could not previously say "this ended, but the date is unknown." valid_to IS NULL
    -- carried two different meanings at once, so a sentence like "former CEO of Weta
    -- Digital" — **where the source text states clearly that the role ended, but gives no
    -- end date** — could only be stored as NULL, which the system then read as "still
    -- holds today." The graph would then confidently assert something the source text
    -- said had already ended.
    --
    --   still holds                 valid_to IS NULL   valid_to_precision IS NULL
    --   ended, date unknown         valid_to IS NULL   valid_to_precision = 'unknown'
    --   ended in 2023               valid_to = ...     valid_to_precision = 'year'
    --
    -- **This design does not fill valid_to with the document's date as an upper bound**
    -- (the textbook approach of an indeterminate instant). That approach would place a
    -- timestamp in the column that looks certain, and every reader would need to check
    -- the precision column before trusting it. This product's core promise is that it does not do that.
    valid_to_precision text,
    CHECK (object_id IS NOT NULL OR object_value IS NOT NULL),
    -- The start of validity has no 'unknown' value. "It started, but the date is
    -- unknown" and "unknown whether it started at all" cannot be told apart in this
    -- ledger, and adding a state for only one of them would just invite a reader to guess.
    CONSTRAINT facts_from_precision_matches_date
      CHECK ((valid_from IS NULL) = (valid_from_precision IS NULL)),
    -- The `IS NOT NULL` clause here is not redundant. Without it, a row with a valid_to
    -- date but a NULL precision would **pass this check**: `NULL IN ('year', ...)`
    -- evaluates to NULL, `TRUE AND NULL` evaluates to NULL, `NULL OR FALSE` evaluates to
    -- NULL, and a CHECK constraint treats a NULL result as passing. Three-valued logic
    -- fails silently here without this clause.
    CONSTRAINT facts_to_precision_matches_date
      CHECK (
        (valid_to IS NOT NULL AND valid_to_precision IS NOT NULL
           AND valid_to_precision IN ('year', 'month', 'day'))
        OR (valid_to IS NULL AND (valid_to_precision IS NULL OR valid_to_precision = 'unknown'))
      )
);
-- Partial indexes for the hot path: an invalidated row is excluded from these indexes.
-- See "the ledger boundary and cleanup" in DESIGN.md, section 3.1.
CREATE INDEX facts_live_subject_idx ON facts (kb_id, subject_id) WHERE invalidated_at IS NULL;
CREATE INDEX facts_live_object_idx  ON facts (kb_id, object_id)  WHERE invalidated_at IS NULL;
CREATE INDEX facts_live_time_idx    ON facts (kb_id, valid_from, valid_to) WHERE invalidated_at IS NULL;
-- These support the invariant lookup used by temporal conflict detection: one index for
-- the subject side and one for the object side, each over open (still valid) and
-- not-invalidated rows.
CREATE INDEX facts_open_pair_idx ON facts (kb_id, subject_id, predicate_id)
    WHERE valid_to IS NULL AND invalidated_at IS NULL;
CREATE INDEX facts_open_obj_pair_idx ON facts (kb_id, object_id, predicate_id)
    WHERE valid_to IS NULL AND invalidated_at IS NULL;
-- The recording axis. The indexes above all serve the world axis, and only look at live
-- rows, answering "what was true at a given moment." These two indexes serve a different
-- question: **when was this written, and when was it overturned** (for example, "what did
-- our understanding change on last quarter," used by the changes tool in chat). The
-- invalidated index is partial and inverted on purpose: a live row always has a NULL
-- invalidated_at, so including live rows would make this index as large as the table
-- itself, while overturned facts stay a small minority.
CREATE INDEX facts_recorded_idx ON facts (kb_id, recorded_at DESC);
CREATE INDEX facts_invalidated_idx ON facts (kb_id, invalidated_at DESC)
    WHERE invalidated_at IS NOT NULL;

-- The evidence chain: links between a fact and the source text chunks behind it. Tracing
-- a fact back to its source is a first-class feature, not an afterthought.
CREATE TABLE fact_evidence (
    fact_id  UUID NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
    chunk_id UUID NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
    quote    TEXT,
    -- The evidence source version: which document, and which version of it, this row
    -- came from. This backs version reconciliation and the "evidence is stale" display.
    document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
    doc_version INT,
    -- The model's own wording. **This lives on the evidence row, not on the fact.** A
    -- fact is deduplicated by (kb, subject, predicate, object); if one chunk says "runs
    -- on" and another says "optimized for," they collapse into the same fact row, and
    -- storing the wording on the fact would mean the first writer wins and every other
    -- wording is silently dropped. Evidence has one row per chunk, which is the right
    -- granularity, and it already carries the quote (the source text for that chunk).
    -- The model's own wording is the same kind of thing: the raw form of one observation.
    proposed_predicate TEXT,
    PRIMARY KEY (fact_id, chunk_id)
);


-- Temporal conflicts (check S3): automatic closing handles the clear cases; an uncertain
-- case goes to review, where a person chooses close, keep, or reject_new.
CREATE TABLE fact_conflicts (
    id          UUID PRIMARY KEY,
    kb_id       UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    old_fact_id UUID NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
    new_fact_id UUID NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
    -- no_time | simultaneous | low_confidence
    reason      TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
    -- closed | kept_both | rejected_new
    resolution  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ,
    UNIQUE (old_fact_id, new_fact_id)
);
CREATE INDEX fact_conflicts_open_idx ON fact_conflicts (kb_id) WHERE status = 'open';

-- What a fact with no predicate **displays** as.
--
-- This is a function, instead of a repeated subquery in each read path, because more
-- than six code paths read facts (graph edges, the entity panel, change history,
-- low-confidence review, document output, and resolution profiles). Six copies of the
-- same SQL tend to drift apart over time, and drift here means the same edge would show a
-- different label on different pages.
--
-- **This function is deterministic.** When two wordings occur the same number of times,
-- it picks the one that sorts first alphabetically, so the same fact always displays the same word.
CREATE FUNCTION fact_surface_predicate(fact uuid) RETURNS text
LANGUAGE sql STABLE AS $$
    SELECT e.proposed_predicate
      FROM fact_evidence e
     WHERE e.fact_id = fact AND e.proposed_predicate IS NOT NULL
     GROUP BY e.proposed_predicate
     ORDER BY count(*) DESC, e.proposed_predicate
     LIMIT 1
$$;

-- Which entities changed class when an entity type was adopted.
--
-- This table is symmetric with fact_adoptions, for the same reason: creating a class
-- without also updating the entities that need it grows the ontology without improving
-- the graph. And the update must be reversible, or no one will trust the system to create
-- classes on its own.
--
-- Entities are not append-only rows (a PATCH request changes one directly, since
-- criterion 0), so a revert here works by recording the type an entity held before the
-- change, rather than by following a supersedes chain.
CREATE TABLE entity_retypes (
    batch_id     UUID NOT NULL,
    kb_id        UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    entity_id    UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    -- **This column can be NULL.** Since ADR 0009, the most common type change is going
    -- from no type to a type, and this table is the only record a revert can use. If this
    -- column were required, the first assignment of a type could never be recorded here,
    -- and that batch of changes could not be reverted.
    from_type_id UUID REFERENCES entity_types(id) ON DELETE CASCADE,
    to_type_id   UUID NOT NULL REFERENCES entity_types(id) ON DELETE CASCADE,
    -- Following the same pattern as fact_adoptions: a revert sets a marker instead of
    -- deleting the row, because the adoption happened, and so did the revert.
    reverted_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- The user who made this change. NULL means the reasoning engine decided it on its
    -- own, matching the same convention as entity_merges.merged_by.
    --
    -- **This column answers only "who triggered this change,"** not "was this type set
    -- by a person." Those two questions were once treated as the same question: type
    -- resolution carried forward the person who clicked "run," and every entity the
    -- engine then classified became marked type_source = human, and so was never
    -- resolved again (see issue #117).
    actor_id     UUID REFERENCES users(id),
    PRIMARY KEY (batch_id, entity_id)
);

CREATE INDEX entity_retypes_kb_idx ON entity_retypes (kb_id, created_at DESC);

-- Which fact was rewritten into which fact, when a surface-level predicate was adopted.
--
-- Without this table, a rewrite would leave only the facts.supersedes pointer, and that
-- pointer cannot cover the case of "merged into an already-existing fact": the old row is
-- invalidated with no successor pointing at it. Two problems follow from that: a revert
-- cannot find where the old row went, and an entity's history would read
-- "invalidated with no successor" as rejected, so the interface would say "this record was
-- withdrawn" when it was really merged, unchanged, into another assertion.
--
-- This table also fills a governance requirement: an audit row previously recorded only
-- the total count, "rewrote 49 facts," with no way to answer "which 49."
CREATE TABLE fact_adoptions (
    -- The batch for one adoption action; a revert operates on this unit.
    batch_id     UUID NOT NULL,
    kb_id        UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    predicate_id UUID NOT NULL REFERENCES relation_types(id) ON DELETE CASCADE,
    old_fact_id  UUID NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
    new_fact_id  UUID NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
    -- superseded = a new row replaces the old row; merged = the old row merges into an
    -- existing row.
    mode         TEXT NOT NULL,
    -- A revert does not delete this row. Erasing "what happened" would contradict the
    -- ledger's own rule, and a revert is itself a person's decision, which an entity's
    -- history must be able to attribute.
    reverted_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (batch_id, old_fact_id)
);

-- An entity's history asks "was this row merged away" one fact at a time; this index
-- supports that lookup.
CREATE INDEX fact_adoptions_old_idx ON fact_adoptions (old_fact_id);
-- This index lists the batches that can be reverted, per knowledge base.
CREATE INDEX fact_adoptions_kb_idx ON fact_adoptions (kb_id, created_at DESC);

-- A blocked fact leaves no trace today. Extraction has seven places that `continue`
-- silently: an unclear subject type, a domain mismatch on an attribute, a value that does
-- not match its datatype, confidence too low, and more. Each one extracts a fact, blocks
-- it, and says nothing; a user only sees that the graph is missing something. This
-- contradicts three of this project's core rules directly: the ledger is append-only,
-- every fact carries evidence, and uncertainty must surface to a person instead of disappearing.

-- This table groups drops by document: it can total "how many did not make it in" for one
-- document, and it can also aggregate at the knowledge base level. Grouping by document
-- also fixes the row lifecycle: ontology_misses is cleared only on a full knowledge base
-- rebuild (in graph.rs), so a source-level re-extraction leaves it holding stale counts;
-- clearing by document instead makes each re-extraction correct on its own.
CREATE TABLE extraction_drops (
    kb_id       UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    -- A machine-aggregatable reason code (attr_domain_mismatch, low_confidence, and so on).
    reason      TEXT NOT NULL,
    -- The specific object under that reason (an attribute key, a predicate name, or
    -- "salary@organization").
    detail      TEXT NOT NULL,
    count       INT NOT NULL DEFAULT 1,
    -- One example, so a person can see at a glance what was dropped ("Acme Corp -> salary").
    example     TEXT,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (kb_id, document_id, reason, detail)
);

CREATE INDEX extraction_drops_doc_idx ON extraction_drops (document_id);

-- The semantic layer: data sources for Ask-the-Data, and the mapping between a business
-- concept and a data asset.
--
-- Data sources use a two-layer model:
-- a registered connection at the system layer (credentials live in one place, shared
-- across knowledge bases), and a mount grant at the knowledge base layer (Ask-the-Data
-- permission follows the knowledge base).

CREATE TABLE data_sources (
    id           UUID PRIMARY KEY,
    name         TEXT NOT NULL UNIQUE,
    -- The first release supports postgres only; mysql and clickhouse drivers can follow later.
    engine       TEXT NOT NULL CHECK (engine IN ('postgres')),
    -- The connection string, including credentials. This gets the same treatment as the
    -- API key in llm_settings: encryption at rest is not implemented yet. See the Status
    -- section of the README.
    conn_string  TEXT NOT NULL,
    created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_test_at TIMESTAMPTZ,
    last_test_ok BOOLEAN
);

-- A mount grant: only through this grant can chat in this knowledge base query the
-- mounted source.
CREATE TABLE kb_data_sources (
    kb_id          UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    data_source_id UUID NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
    mounted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (kb_id, data_source_id)
);

-- The semantic layer's mapping from a concept to a data asset lives outside the ontology.
-- See docs/decisions/0011.
--
-- An earlier design stored this as a `mapped_to` fact: the subject was the concept
-- entity, and the object was a JSON configuration packed into `object_value`, with
-- `mapped_to` itself as a row in `relation_types`, next to a relation like `works_at`.
--
-- Three separate reasons justify pulling it out, none of them a matter of style:
--
-- 1. **This is not a claim about the world.** The ontology answers "what exists in the
--    world"; this table answers "how does this number compute in our database." This is
--    the third application of one rule: ADR 0009 says concept is control flow, not
--    vocabulary, and ADR 0010 says related_to is a fallback, not a relation.
--
-- 2. **The "confirm" action already breaks the ledger's foundation.** confirm_fact runs
--    `UPDATE facts SET confidence = 1.0`, an update in place. The ledger is append-only:
--    correcting a fact means inserting a new row with a supersedes link, because a change
--    in understanding is itself information (criterion 0 of ADR 0001). Confirming a
--    mapping does not change understanding; it changes whether this configuration is
--    active. Something that needs an in-place status change does not belong on a table
--    that forbids in-place changes; that mismatch is itself evidence this design does not fit.
--
-- 3. **The shape does not match.** The real fields are source, table, expr, sql, unit,
--    and summary, all packed into one JSONB value. That makes them hard to query
--    ("which concepts map to orders" means digging through JSON) and impossible to
--    constrain (uniqueness at the granularity of (concept, source) sits inside
--    object_value, where the database cannot enforce it; today this rule holds only
--    through process, not through a constraint).

CREATE TABLE concept_mappings (
    id         UUID PRIMARY KEY,
    kb_id      UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    -- The business concept being mapped (an entity of a type such as Metric or Dimension).
    concept_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    -- The mounted data source. **This column is part of the primary key on purpose.** The
    -- same concept having a different definition on a different source is supported by
    -- design; the same concept should have only one definition on the same source. An
    -- earlier version closed this rule through the confirmation process; the database
    -- enforces it now.
    source     TEXT NOT NULL,
    -- How the value computes. These fields are separate columns, not packed into JSON,
    -- because they are the reason this table exists.
    table_name TEXT,
    expr       TEXT,
    sql        TEXT,
    unit       TEXT,
    summary    TEXT,
    -- A derived metric (for example, "conversion rate = orders / visits"): a computed
    -- value, not a stored column.
    derived    BOOLEAN NOT NULL DEFAULT FALSE,

    -- **This is a status, not a confidence score.** An earlier design borrowed a fact's
    -- confidence column to express "proposed = 0.6 / confirmed = 1.0," which encoded a
    -- two-valued state as a float, and also let a proposed mapping fall into the
    -- "low-confidence fact" review bucket by mistake. This column states plainly what it is.
    status     TEXT NOT NULL DEFAULT 'proposed'
               CHECK (status IN ('proposed', 'confirmed', 'rejected')),
    -- NULL means no one has decided yet. Both confirming and rejecting leave a record; a
    -- rejected mapping must not be surfaced again as pending by the next exploration pass.
    --
    -- This foreign key has no ON DELETE rule, matching entity_merges.merged_by and
    -- ontology_proposals.decided_by. **A user account is deactivated, not deleted; the
    -- production code has no `DELETE FROM users` statement,** so this foreign key's
    -- delete rule never triggers, and attribution stays intact.
    decided_by UUID REFERENCES users(id),
    decided_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (kb_id, concept_id, source)
);

-- Ask-the-Data reads only confirmed mappings (chat.rs injects them into the system
-- prompt), and Review reads only the mappings still waiting for a decision. Both queries
-- filter by knowledge base and status.
CREATE INDEX concept_mappings_status_idx ON concept_mappings (kb_id, status);

-- A record of how a mapping changed over time. **This table does not use two time
-- axes.** A mapping has no separate "valid time" and "recorded time"; it has only one
-- axis, "when this took effect." Forcing the ledger's bitemporal pattern onto it would
-- move complexity here instead of solving anything.
CREATE TABLE concept_mapping_revisions (
    id         UUID PRIMARY KEY,
    mapping_id UUID NOT NULL REFERENCES concept_mappings(id) ON DELETE CASCADE,
    -- The full previous version, before the change. This stores a snapshot, not a diff.
    -- Reading this table means asking "what was this at the time," and a diff would need
    -- a full replay from the start to answer that question.
    before     JSONB NOT NULL,
    changed_by UUID REFERENCES users(id),
    changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX concept_mapping_revisions_idx
    ON concept_mapping_revisions (mapping_id, changed_at DESC);

-- The old mapped_to facts are not migrated. This repository has not shipped a release
-- yet, and every knowledge base holds only mock knowledge (the same situation as issue #125).
-- Leaving them in the ledger causes no harm: the confirmed_mappings query changes along
-- with the rest of the code, and after that, nothing reads these old rows again.
--
-- **This shortcut will not be available after a real release.** This note exists so no
-- one copies this shortcut for a future migration.

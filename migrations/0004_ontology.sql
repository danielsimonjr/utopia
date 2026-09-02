-- Ontology: unmatched-term statistics from extraction, imports, proposals, and refinement
-- pairs a person has approved.

-- A type or relation that extraction found outside the allowed vocabulary. This is not
-- noise; it is a signal for growing the ontology.
CREATE TABLE ontology_misses (
    kb_id      UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    -- attribute_type and relation_type stay separate. When a predicate outside the
    -- vocabulary carries a literal value (`founding_date: "2015"`), the missing piece is
    -- an attribute, not a relation. Recording it as the wrong kind would send the
    -- ontology proposal toward creating a relation instead.
    kind       TEXT NOT NULL
               CHECK (kind IN ('entity_type', 'relation_type', 'attribute_type')),
    key        TEXT NOT NULL,
    example    TEXT,
    count      INT NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- A person said no to this term. **This sets a marker; it does not delete the row.**
    -- An earlier design used a DELETE for dismiss, and the next extraction pass would
    -- insert the same term back in, unchanged. A user's "no" would not survive one more
    -- extraction pass. While automatic ontology growth is on, that outcome would mean the
    -- system overriding a person's explicit decision.
    dismissed_at TIMESTAMPTZ,
    PRIMARY KEY (kb_id, kind, key)
);

-- The first layer of ontology import: keeping the source file intact.
--
-- The projection covers only the part of the file the system can use today (classes,
-- labels, rdfs:comment, subClassOf, object and data properties, functional, and
-- domain/range). **Something the system cannot read yet is not an error; it is "not
-- projected yet."** The source file is stored in a content-addressed blob, so when a
-- reasoning engine ships or a new consumer is added later, re-running the import needs no
-- action from the user. This turns "we cannot express this" from a permanent capability
-- gap into "the projection does not cover this yet."
CREATE TABLE ontology_imports (
    id            UUID PRIMARY KEY,
    kb_id         UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    -- The content hash of the blob. Importing the same file twice does not use extra storage.
    sha256        TEXT NOT NULL,
    filename      TEXT NOT NULL,
    -- turtle | rdfxml
    format        TEXT NOT NULL,
    byte_size     BIGINT NOT NULL,
    -- The projection version. When the projection logic changes later, this value shows
    -- which imports need to run again.
    projection_version INT NOT NULL DEFAULT 1,
    -- What this projection did: counts and details for items created, updated, or not
    -- yet projected. The preview and the later audit view share this column.
    summary       JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- The user who ran this import. This stays NULL after the account is deleted,
    -- following the same rule as the audit ledger.
    imported_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    imported_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ontology_imports_kb_idx ON ontology_imports (kb_id, imported_at DESC);


-- Ontology proposals, stored in the database.
--
-- An earlier design kept this data only in browser memory (`useState<OntologyProposals>`
-- in Ontology.tsx). A refresh, a tab switch, or a crash would lose the whole batch of
-- proposals, and seeing them again meant running the model a second time.
--
-- **The raw material was never the part that got lost.** An unmatched term always stayed
-- in ontology_misses. What was lost was the **clustering result**: which terms were
-- grouped under the same proposal, and the estimate "adopting this reclassifies N rows."
-- That is exactly the part a person needs to check: migration 0003 recorded a model
-- suggestion to merge `optimized_for` into `runs_on` ("optimized for RTX" does not mean
-- "runs on RTX"), and **a person could only catch this by seeing, in a tooltip, which
-- terms the merge grouped together.** That catch became the direct evidence for the rule
-- "do not merge automatically, in every case." Something a person can check should not
-- live only inside one page's lifetime.
CREATE TABLE ontology_proposals (
    id         UUID PRIMARY KEY,
    kb_id      UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    -- The proposal's section, matching one of the four sections the API returns:
    -- entity_types | relation_types | attribute_types | map_to
    section    TEXT NOT NULL,
    key        TEXT NOT NULL,
    -- The proposal's content, as-is: label, description, reason, forms, datatype,
    -- temporal, and so on.
    --
    -- **This is stored as JSONB, not split into columns.** The four sections already
    -- have different shapes (a relation has temporal and forms; an attribute has
    -- datatype; map_to has a target). Splitting this would need either four tables or one
    -- table with many empty columns. The frontend also consumes this exact JSON, so
    -- storing it as-is keeps the same contract. Checking which terms a merge grouped
    -- together still works this way (`payload->'forms'`).
    payload    JSONB NOT NULL,
    -- open = still waiting for a person to review; adopted / rejected = a person has
    -- already decided.
    status     TEXT NOT NULL DEFAULT 'open'
               CHECK (status IN ('open', 'adopted', 'rejected')),
    decided_by UUID REFERENCES users(id),
    decided_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Each knowledge base allows only one row per section and key. Running Suggest again
    -- refreshes that row; it does not add another one.
    UNIQUE (kb_id, section, key)
);

-- "How many proposals are still waiting" is the most common question asked of this
-- table. This closes a gap from migration 0003: turning off automatic ontology growth
-- removed any "N new terms since last time" reminder, so the signal sat in the panel
-- with no one prompted to look at it.
CREATE INDEX ontology_proposals_open_idx
    ON ontology_proposals (kb_id, created_at DESC)
    WHERE status = 'open';

-- Coarse-to-specific class pairs a person has already approved. Once approved, the same
-- pair skips manual review the next time.
--
-- Why this table exists: the manual-review path triggers on "is the selected class inside
-- the coarse class's subtree." In practice, that check often measures something other
-- than real risk: **whether the seed class ever connected to the imported vocabulary's
-- class tree at all.** schema.org's Place introduces its own key, place, and the builtin
-- location class has no subclasses at all, so every location -> city case counted as a
-- cross-branch case. In one batch of 24 entities, this flagged 14 of them, and every one
-- was a correct classification.
--
-- Whether a pair crosses branches is a property of the pair (coarse class, target class),
-- not a property of the entity. Once a person has confirmed "a city can appear under
-- location," a second city should not ask the same question again.
CREATE TABLE type_refinement_pairs (
    kb_id       uuid NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    from_type_id uuid NOT NULL REFERENCES entity_types(id) ON DELETE CASCADE,
    to_type_id  uuid NOT NULL REFERENCES entity_types(id) ON DELETE CASCADE,
    approved_by uuid REFERENCES users(id),
    approved_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (kb_id, from_type_id, to_type_id)
);

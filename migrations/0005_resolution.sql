-- Entity resolution: the same name does not mean the same person.
-- See docs/DESIGN.md, section 4, for the design: a name is only a candidate lookup clue.
-- Identity depends on context (a profile vector and relation compatibility). The system
-- favors keeping entities separate over merging them. An unclear case goes to the review
-- queue first. Batched LLM judgment runs in the background, with a person as the final check.



-- The resolution review queue: unclear pairs that may be the same entity.
-- stage: adjudicating = waiting for a batched LLM judgment; human = the LLM was unsure, or
-- no model is configured, so the pair waits for a person's final check.
-- status: pending -> merged / kept.
CREATE TABLE resolution_reviews (
    id         UUID PRIMARY KEY,
    kb_id      UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    left_id    UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    right_id   UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    score      REAL NOT NULL DEFAULT 0,
    reason     TEXT,
    stage      TEXT NOT NULL DEFAULT 'adjudicating' CHECK (stage IN ('adjudicating', 'human')),
    status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'merged', 'kept')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at TIMESTAMPTZ,
    decided_by UUID REFERENCES users(id)
);
CREATE UNIQUE INDEX resolution_reviews_pair_idx
    ON resolution_reviews (kb_id, least(left_id, right_id), greatest(left_id, right_id))
    WHERE status = 'pending';
CREATE INDEX resolution_reviews_kb_pending_idx
    ON resolution_reviews (kb_id, created_at) WHERE status = 'pending';

-- A cache of LLM judgments: the same pair (name plus a hash of the context summary)
-- does not incur a second model call. A NULL value for same means the model was also unsure.
CREATE TABLE resolution_verdicts (
    kb_id      UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    pair_key   TEXT NOT NULL,
    same       BOOLEAN,
    confidence REAL NOT NULL DEFAULT 0,
    model      TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (kb_id, pair_key)
);

-- The merge log: records the facts moved or invalidated, and a snapshot of the target
-- entity's profile, so a merge can be reverted precisely.
CREATE TABLE entity_merges (
    id                    UUID PRIMARY KEY,
    kb_id                 UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    source_id             UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    target_id             UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    moved_subject_facts   UUID[] NOT NULL DEFAULT '{}',
    moved_object_facts    UUID[] NOT NULL DEFAULT '{}',
    invalidated_facts     UUID[] NOT NULL DEFAULT '{}',
    -- Correction rows produced by temporal reconciliation after the merge. The merge
    -- itself caused these rows, so reverting the merge reverts them too.
    temporal_corrections  UUID[] NOT NULL DEFAULT '{}',
    target_profile_before vector,
    target_profile_n_before INTEGER NOT NULL DEFAULT 0,
    -- A revert snapshot for type reconciliation, used when a concept target is upgraded
    -- to a specific type.
    target_type_before    UUID REFERENCES entity_types(id),
    -- NULL means an automatic merge (a high-confidence LLM judgment).
    merged_by             UUID REFERENCES users(id),
    reason                TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    reverted_at           TIMESTAMPTZ
);
CREATE INDEX entity_merges_kb_idx ON entity_merges (kb_id, created_at DESC);

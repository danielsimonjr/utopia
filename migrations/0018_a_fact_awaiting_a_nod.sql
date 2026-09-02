-- A fact awaiting a person's confirmation (see docs/decisions/0015).
--
-- This started from a test case: a conversation said "remember that Acme moved its
-- headquarters to Shenzhen," the assistant replied "recorded," and the edge that landed
-- in the graph carried **no predicate, at 0.9 confidence** — the ontology had no
-- "relocated to" relation, so extraction left the predicate empty, correctly, following
-- ADR 0010. **What the assistant said and what actually went in were two different
-- things, and there was no way for a person to notice.**
--
-- **This is a separate table; these facts do not go into facts.**
--
-- The first version added a nod column to facts. That is exactly the failure shape
-- recorded in migration 0013:
--
-- > An earlier attempt added derived rows into facts with a derived_by_rule flag. That
-- > version failed in the wrong direction: this repository has more than forty queries
-- > that read facts, and only one of them checked that flag...
-- > After splitting the tables, forgetting a UNION means a derived fact becomes
-- > invisible, not mixed in — a safer failure.
--
-- Today, 27 queries across 6 files read live facts by filtering on invalidated_at IS
-- NULL. Adding a filter to each one individually leaves one missed filter away from a
-- fact no one confirmed slipping into the graph — and preventing exactly that is this
-- table's entire reason to exist. With a separate table, forgetting to read it means "the
-- pending queue misses a row," not "an unconfirmed fact reached the graph."
--
-- **This table blocks only an interactive, single-statement write; it does not block
-- bulk ingest.** Loading 500 documents can extract ten thousand facts, and confirming
-- each one by hand is not realistic; that path keeps its optimistic write, followed by
-- review afterward. remember handles one sentence at a time, with a person right there in
-- the conversation, at the exact moment confirmation costs the least.
CREATE TABLE pending_facts (
    id           UUID PRIMARY KEY,
    kb_id        UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    subject_id   UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    -- Can be NULL, matching facts.predicate_id: this stays empty when the ontology has
    -- no matching relation (ADR 0010). **A person needs to see exactly this empty
    -- value** — in the test case above, the empty predicate was the reason to reject it.
    predicate_id UUID REFERENCES relation_types(id) ON DELETE SET NULL,
    object_id    UUID REFERENCES entities(id) ON DELETE CASCADE,
    object_value JSONB,
    -- The model's own wording. When the predicate is empty, a person uses this to judge
    -- whether the ontology should grow a new relation for it.
    proposed_predicate TEXT,

    valid_from   TIMESTAMPTZ,
    valid_from_precision TEXT,
    valid_to     TIMESTAMPTZ,
    valid_to_precision   TEXT,
    confidence   REAL NOT NULL DEFAULT 0.5,

    -- Which sentence this came from. **The confirmation screen must show the original
    -- sentence next to the triple** — showing the triple alone would ask a person to
    -- judge it with no context.
    chunk_id     UUID NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
    -- Whose statement this was. remember does not record this today; this migration adds
    -- it, closing the gap named in ADR 0015.
    proposed_by  UUID REFERENCES users(id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The pending queue reads by knowledge base, and also needs a count.
CREATE INDEX pending_facts_kb_idx ON pending_facts (kb_id, created_at DESC);
-- Several facts extracted from one sentence need to display together.
CREATE INDEX pending_facts_chunk_idx ON pending_facts (chunk_id);

-- A rejected fact must not be brought back by the next re-extraction.
--
-- concept_mappings blocks a repeated proposal with status = 'rejected'; the same idea
-- applies here, but **a rejection record cannot stay inside pending_facts** — that
-- table's whole meaning is "waiting for a person to look at this," and mixing in
-- already-reviewed rows would make its count lie. So this is a separate table, recording
-- only "this triple was rejected once, in this knowledge base."
CREATE TABLE rejected_facts (
    kb_id        UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    subject_id   UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    -- The predicate can be NULL, so it cannot be part of the primary key; a duplicate
    -- check here uses a COALESCE expression index instead.
    predicate_id UUID REFERENCES relation_types(id) ON DELETE SET NULL,
    object_id    UUID REFERENCES entities(id) ON DELETE CASCADE,
    rejected_by  UUID REFERENCES users(id),
    rejected_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX rejected_facts_lookup_idx
    ON rejected_facts (kb_id, subject_id, object_id);

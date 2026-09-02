-- Axiom violations: contradictions found by the consistency check (ADR 0002, check R0).
--
-- **This table does not reuse fact_conflicts**, even though both tables record "two facts
-- disagree, and a person decides." The reason is that the decision itself is different:
--
--   fact_conflicts    a temporal conflict, asking "which one is correct"
--                     -> closed / kept_both / rejected_new, and every answer changes a fact
--   axiom_violations  an axiom violation, asking "is the data wrong, or is the definition wrong"
--                     -> retract the fact, or change the ontology axiom instead
--
-- The second option matters for a real reason. A user imports a FOAF file where a
-- property is declared asymmetric, but that relation is actually bidirectional in their
-- own text; the fix here is the ontology, not twenty individual facts. Forcing this into
-- one table would make the resolution column carry two different meanings at once, and
-- code reading it would need to check reason first just to know how to interpret resolution.
--
-- The shape does not match either: fact_conflicts assumes a conflict is always "the new
-- row replaces the old row" (old and new columns), while a self-loop violation involves
-- **one** fact contradicting itself, and a cycle involves **a chain** of facts.

CREATE TABLE axiom_violations (
    id         UUID PRIMARY KEY,
    kb_id      UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    -- self_loop  a fact whose subject and object are the same, on a predicate declared Irreflexive
    -- asymmetry  A->B and B->A both exist
    -- cycle      a transitive cycle: A->B->C->A, on a predicate that is both Transitive and Asymmetric
    -- functional a cardinality violation: two values exist on a side declared unique
    kind       TEXT NOT NULL
               CHECK (kind IN ('self_loop', 'asymmetry', 'cycle', 'functional')),
    -- The two facts involved. **For a self-loop, both columns hold the same fact** — one
    -- fact contradicts itself, so a second fact is not needed. For a cycle, these are the
    -- first and last fact; the facts in between are listed in path.
    left_fact  UUID NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
    right_fact UUID NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
    -- The full path of a cycle, in order of the facts involved; empty for the other three
    -- kinds. This stays because "A->B->C->A" is far more useful than "A and C
    -- contradict"; a person needs to see the whole chain to know which fact to retract.
    --
    -- This is a plain UUID array, not a join table, because it represents **one piece of
    -- evidence** (this is what the cycle looked like at detection time), not a
    -- relationship anyone needs to query. There is no query of the form "which cycles
    -- passed through this fact."
    path       UUID[] NOT NULL DEFAULT '{}',
    status     TEXT NOT NULL DEFAULT 'open'
               CHECK (status IN ('open', 'resolved')),
    -- fact_retracted the data was wrong, so the fact was retracted
    -- axiom_relaxed  the definition was wrong, so the ontology axiom was changed
    -- accepted       both sides are correct, and a person accepted that they coexist
    --                (the next check no longer reports it)
    resolution TEXT CHECK (resolution IN ('fact_retracted', 'axiom_relaxed', 'accepted')),
    decided_by UUID REFERENCES users(id),
    decided_at TIMESTAMPTZ,
    detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Running the check again does not insert a duplicate row for the same
    -- contradiction. The check is deterministic (a cycle is deduplicated by sorting its
    -- fact IDs), so the same cycle always produces the same first-and-last pair.
    UNIQUE (kb_id, kind, left_fact, right_fact)
);

-- The review page reads only the rows still waiting for a decision.
CREATE INDEX axiom_violations_open_idx ON axiom_violations (kb_id, detected_at DESC)
    WHERE status = 'open';

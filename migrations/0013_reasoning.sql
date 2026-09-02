-- The reasoning engine: the rest of check R0, plus R1 materialized derivation (see docs/decisions/0002).

-- ============ The rest of R0: the ontology's own consistency ============
--
-- axiom_violations covers "a fact contradicts a definition." This table covers "a
-- definition contradicts itself." These are separate tables for a real reason: a
-- self-contradictory ontology makes **every** conclusion at the fact layer suspect. If a
-- predicate declares itself both symmetric and asymmetric, then every asymmetry
-- violation reported against it rests on a premise that was never valid to begin with.
-- This is why this check is listed first in the interface.
--
-- The shape differs too: the two columns on that table are foreign keys into facts, while
-- this table's columns point at classes and predicates.
CREATE TABLE ontology_defects (
    id      UUID PRIMARY KEY,
    kb_id   UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    -- symmetric_and_asymmetric  a predicate declares both (this only holds for an empty relation)
    -- transitive_and_functional a combination OWL 2 DL explicitly forbids
    -- subclass_cycle            A subclass of B subclass of A; the table's own CHECK
    --                           constraint blocks only a direct self-reference
    -- disjoint_with_ancestor    a class disjoint from its own ancestor, so it can never
    --                           have an instance
    -- inherits_disjoint         two ancestors are disjoint, with the same result
    kind    TEXT NOT NULL CHECK (kind IN (
                'symmetric_and_asymmetric', 'transitive_and_functional',
                'subclass_cycle', 'disjoint_with_ancestor', 'inherits_disjoint')),
    -- **Both columns are plain UUID values, with no foreign key.** The first two kinds
    -- point at relation_types, and the other three point at entity_types; one column
    -- cannot express a foreign key to two different tables. This is fine because this
    -- table holds derived state: the whole table is recomputed on every ontology change,
    -- and a row pointing at a deleted object simply disappears on the next pass, with no
    -- need for a cascading delete to catch it.
    subject UUID NOT NULL,
    other   UUID,
    -- The cycle's path, in order of the classes involved; empty for the other kinds.
    path    UUID[] NOT NULL DEFAULT '{}',
    status  TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
    -- fixed     the ontology was changed (a declaration edited, an inheritance link
    --           removed, a disjoint rule dropped)
    -- accepted  a person reviewed it and judged that no change is needed
    resolution  TEXT CHECK (resolution IN ('fixed', 'accepted')),
    decided_by  UUID REFERENCES users(id),
    decided_at  TIMESTAMPTZ,
    detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (kb_id, kind, subject, other)
);

CREATE INDEX ontology_defects_open_idx ON ontology_defects (kb_id, detected_at DESC)
    WHERE status = 'open';

-- ============ R1: rules and derivation ============

-- Rules **compile only from ontology axioms.** There is no user-defined rule language;
-- that would be a different product (see ADR 0002).
--
-- Why this needs its own table, instead of folding the rule kind into the derived row:
-- facts.derived_by_rule needs something it can point at, and "which rule produced this
-- row" must be aggregated by rule in two places: explanation (check R2), and answering
-- "if this axiom is removed, which derived facts must go with it."
--
-- This table holds derived state: it is fully recompiled from the ontology before every
-- derivation run. Its identity is therefore (kb, predicate, kind), not an autoincrementing
-- id; recompiling must recognize "this is still the same rule," or every run would give
-- derived_facts.rule_id a new value, breaking the history.
--
-- **A rule is not deleted when its axiom is removed.** A row in derived_facts that is
-- already invalidated still points at it, and explaining "which rule produced this at the
-- time" needs the rule to still exist. A knowledge base has only a handful of rules, so
-- keeping old ones costs almost nothing.
CREATE TABLE rules (
    id           UUID PRIMARY KEY,
    kb_id        UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    predicate_id UUID NOT NULL REFERENCES relation_types(id) ON DELETE CASCADE,
    -- transitive | symmetric. inverseOf and subPropertyOf are not stored yet on the
    -- import projection side, so no rule compiles for them either; a missing rule here
    -- is not a defect, it follows the same principle as "nothing not declared gets
    -- derived."
    kind         TEXT NOT NULL CHECK (kind IN ('transitive', 'symmetric')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (kb_id, predicate_id, kind)
);

-- Derived facts. **This is a separate table; derived facts do not go into facts.**
--
-- An earlier attempt added derived rows into facts with a derived_by_rule flag. That
-- version failed in the wrong direction: this repository has more than forty queries that
-- read facts, and only one of them checked that flag, so every new query written after
-- that point treated a derived row as an assertion by default, unless someone remembered
-- to add a filter. The person who built this feature (the author of this comment) missed
-- two such places at the time: the low-confidence review queue offered a derived fact for
-- Confirm/Reject (confirming a derivation has no meaning, and rejecting it just derives
-- the same fact again next time, since its premises are unchanged), and temporal
-- reconciliation used a derived fact to close an asserted one (the engine editing a
-- person's data using its own conclusion, which criterion 2 of ADR 0001 forbids directly).
--
-- After splitting the tables, forgetting a UNION means a derived fact becomes
-- **invisible**, not **mixed in** — a safer failure.
--
-- Two more reasons:
--
-- First, **the columns genuinely differ**. A derived fact has no supersedes (it carries
-- no "correction" meaning), no fact_evidence (its evidence is its premises, held in
-- fact_derivations), and its confidence means something different (computed, not
-- self-reported by a model). Every one of these columns would be borrowed if placed on one table.
--
-- Second, **the row counts differ by an order of magnitude.** ADR 0002 measured this on
-- real text: 185 asserted facts produced 828 derived facts, more than four times as many.
-- Making every query against facts filter out most of its rows would be a cost paid for nothing.
CREATE TABLE derived_facts (
    id           UUID PRIMARY KEY,
    kb_id        UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    subject_id   UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    -- **Required, unlike facts.predicate_id.** A rule attaches to a predicate; with no
    -- predicate, there is no rule, and so nothing to derive this row from.
    predicate_id UUID NOT NULL REFERENCES relation_types(id) ON DELETE CASCADE,
    -- Also required: an axiom describes a relationship between entities, so an
    -- attribute fact with a literal object takes no part in derivation.
    object_id    UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    rule_id      UUID NOT NULL REFERENCES rules(id),
    -- The validity interval is the intersection of the premises' intervals (the meaning
    -- given in ADR 0002's open questions). Precision follows the same invariant as
    -- facts: a NULL date carries no precision.
    valid_from   TIMESTAMPTZ,
    valid_to     TIMESTAMPTZ,
    valid_from_precision TEXT,
    valid_to_precision   TEXT,
    -- The lowest confidence among the premises. A chain is only as trustworthy as its
    -- weakest link.
    confidence   REAL NOT NULL DEFAULT 1.0,
    derived_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Set when a premise is gone. **This does not delete the row**, following the same
    -- pattern as rejecting a fact: the recorded axis keeps a trace of "this was once
    -- derived here, and later its premise disappeared," which an entity's history page
    -- can display directly (see ADR 0002, section 3).
    invalidated_at TIMESTAMPTZ,
    CONSTRAINT derived_from_precision_matches_date
      CHECK ((valid_from IS NULL) = (valid_from_precision IS NULL)),
    CONSTRAINT derived_to_precision_matches_date
      CHECK ((valid_to IS NULL) = (valid_to_precision IS NULL))
);

-- The graph reads edges by (subject, object); reconciliation identifies "is this still
-- the same derivation" by the full triple plus the interval.
CREATE INDEX derived_facts_live_idx
    ON derived_facts (kb_id, subject_id, object_id) WHERE invalidated_at IS NULL;
CREATE UNIQUE INDEX derived_facts_identity_idx
    ON derived_facts (kb_id, subject_id, predicate_id, object_id, valid_from, valid_to)
    WHERE invalidated_at IS NULL;

-- One layer of the proof tree: which premises a derived fact used directly.
--
-- **This stores only the direct premises, not the whole tree.** Expanding this table
-- recursively produces the full proof (what check R2 needs). Storing the whole tree would
-- record the same information N times, where N is the number of paths through it.
--
-- A premise is always an asserted fact (from facts). Derivation excludes derived facts
-- from its own inputs; otherwise, the output of one run could become the input to the
-- same run, and a later re-run would depend on state left over from an earlier one.
--
-- seq fixes the order: a proof for A->B->C->D must read back in that order for a person to follow the chain.
CREATE TABLE fact_derivations (
    derived_fact_id UUID NOT NULL REFERENCES derived_facts(id) ON DELETE CASCADE,
    premise_fact_id UUID NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
    seq             INT  NOT NULL,
    PRIMARY KEY (derived_fact_id, seq)
);

-- "This premise was retracted; which derived facts must follow it" is a reverse lookup
-- the primary key alone cannot support.
CREATE INDEX fact_derivations_premise_idx ON fact_derivations (premise_fact_id);

-- The reasoning toggle. **This defaults to off.** R1 adds rows to the graph, and
-- criterion 2 of ADR 0001 states that the ontology guides but does not enforce: a
-- declaration can be wrong, so the system should not change the graph based on it before
-- a user has approved that behavior.
--
-- This setting lives on the knowledge base, not the deployment, because whether
-- derivation should run varies by base: one base's ontology may carry solid axioms, while
-- another is built entirely from loosely extracted free text.
ALTER TABLE knowledge_bases
    ADD COLUMN materialize_inferences BOOLEAN NOT NULL DEFAULT FALSE;

-- How often re-derivation runs. **This must run on a schedule, not only on demand.**
-- Facts change continuously (every document extraction adds edges), while a derivation
-- is computed only at the moment it runs. Without a schedule, after the next document
-- arrives, the derived facts in the graph become **missing**, not wrong (their premises
-- are still there); the new chain simply has not been derived yet, and this kind of gap
-- is invisible in the interface.
--
-- This follows the same shape as source syncing: an interval plus a last-run time, with a
-- scheduler scanning for due knowledge bases every minute. 60 minutes is a starting
-- estimate: derivation is pure computation with no external cost, but until incremental
-- maintenance ships (ADR 0002, check R3), each run recomputes the whole knowledge base,
-- so this interval should not be too short either.
ALTER TABLE knowledge_bases
    ADD COLUMN inference_interval_minutes INT NOT NULL DEFAULT 60
        CHECK (inference_interval_minutes BETWEEN 5 AND 10080);

-- The time of the last completed derivation run. **Checking whether it is due means
-- comparing this run's result against what already exists in the knowledge base** —
-- materialize already does exactly that (matching computed rows against existing ones,
-- inserting new ones, invalidating stale ones). So this comparison is not a new
-- mechanism; this column simply records the result of that comparison for a person to see.
ALTER TABLE knowledge_bases ADD COLUMN last_inference_at TIMESTAMPTZ;

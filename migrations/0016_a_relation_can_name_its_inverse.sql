-- A relation's inverse and parent property (the last two rule sources for check R1; see
-- docs/decisions/0002).
--
-- ADR 0002 lists four rule sources for R1: TransitiveProperty, SymmetricProperty,
-- inverseOf, and subPropertyOf. The first two have always run; the last two **had no
-- column at all** — a comment on rules.kind in migration 0013 recorded this fact:
--
-- > inverseOf and subPropertyOf are not stored yet on the import projection side, so no
-- > rule compiles for them either
--
-- This migration adds that missing projection. The cost of the gap was not "fewer
-- derivations"; it was **an asymmetric answer**: if the ontology declares works_at's
-- inverse as employs, asking "who works at Acme" and "who does Acme employ" would give
-- different answers, unless both directions were asserted separately by hand — exactly
-- the duplicate work R1 exists to remove.
ALTER TABLE relation_types
    -- p's inverse is q. **This is stored in one direction, and used in both.**
    --
    -- This migration does not add a trigger to auto-fill q.inverse_of = p. A trigger
    -- would hide a semantic rule inside the database, and more than one path can bypass
    -- it (an RDF import, or direct SQL). Normalizing this happens instead when the axioms
    -- are read: the loading step is the one place that must handle this, cannot be
    -- bypassed, and can be tested directly (reasoning::axioms_of).
    ADD COLUMN inverse_of UUID REFERENCES relation_types(id) ON DELETE SET NULL,
    -- p is a sub-property of q: whatever holds under the specific relation also holds
    -- under the general one (ceo_of is a sub-property of works_at). A chain here must be
    -- checked for cycles on the R0 side, the same kind of problem as a cycle in
    -- entity_types' parent classes.
    ADD COLUMN sub_property_of UUID REFERENCES relation_types(id) ON DELETE SET NULL;

-- A relation cannot be its own parent property. **A relation can be its own inverse** —
-- that is equivalent to symmetric, and is a valid declaration (check R0 suggests using
-- symmetric instead, for clarity, but does not treat this as an error).
ALTER TABLE relation_types
    ADD CONSTRAINT relation_types_sub_property_not_self
        CHECK (sub_property_of IS NULL OR sub_property_of <> id);

-- Normalization needs the reverse lookup, "which rows point at me," once per predicate
-- when rules compile.
CREATE INDEX relation_types_inverse_idx ON relation_types (inverse_of)
    WHERE inverse_of IS NOT NULL;
CREATE INDEX relation_types_sub_property_idx ON relation_types (sub_property_of)
    WHERE sub_property_of IS NOT NULL;

-- Both CHECK constraints below expand to match: the new rule kind and the new defect
-- kinds are values migration 0013's two tables did not anticipate.
--
-- **This is not a missed case; those values genuinely did not exist yet.** The comment
-- in migration 0013 states plainly that "inverseOf and subPropertyOf are not stored yet
-- on the import projection side, so no rule compiles for them either." This migration
-- adds that projection, so the constraints naturally expand along with it.
ALTER TABLE rules DROP CONSTRAINT IF EXISTS rules_kind_check;
ALTER TABLE rules ADD CONSTRAINT rules_kind_check
    CHECK (kind IN ('transitive', 'symmetric', 'inverse', 'sub_property'));

-- Three new ontology self-checks: a relation declared as its own inverse (equivalent to
-- symmetric, so this suggests a rewrite), an inverse link that does not point back
-- (loading only fills a missing link and never overwrites one, so a genuine
-- contradiction is left for this check to report), and a cycle in sub-property links.
ALTER TABLE ontology_defects DROP CONSTRAINT IF EXISTS ontology_defects_kind_check;
ALTER TABLE ontology_defects ADD CONSTRAINT ontology_defects_kind_check
    CHECK (kind IN (
        'symmetric_and_asymmetric', 'transitive_and_functional',
        'subclass_cycle', 'disjoint_with_ancestor', 'inherits_disjoint',
        'inverse_of_itself', 'inverse_not_mutual', 'sub_property_cycle'
    ));

export { check, defaultAxioms, Kind, MAX_DEPTH } from "./check";
export type { Axioms, Edge, Violation } from "./check";

export { derive, validity, Rule, MAX_DERIVED_PER_PREDICATE } from "./derive";
export type { Derivation, Derived, TimedEdge } from "./derive";

export { checkOntology, Defect, MAX_ANCESTRY } from "./ontology";
export type { OntologyDefect } from "./ontology";

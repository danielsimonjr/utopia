import { describe, expect, test } from "bun:test";
import { type Axioms, defaultAxioms } from "./check";
import { checkOntology, Defect, type OntologyDefect } from "./ontology";
import type { Uuid } from "@/core";

function bytesToUuid(byte: number): string {
  const hex = byte.toString(16).padStart(2, "0").repeat(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function c(i: number): Uuid {
  return bytesToUuid(i);
}

function kinds(v: OntologyDefect[]): Defect[] {
  return v
    .map((d) => d.kind)
    .slice()
    .sort();
}

function ax(build: (a: Axioms) => void): Map<Uuid, Axioms> {
  const a = defaultAxioms();
  build(a);
  return new Map([[c(99), a]]);
}

describe("check_ontology", () => {
  test("a property cannot be both symmetric and asymmetric", () => {
    const a = ax((x) => {
      x.symmetric = true;
      x.asymmetric = true;
    });
    const d = checkOntology(a, [], []);
    expect(kinds(d)).toEqual([Defect.SymmetricAndAsymmetric]);
    expect(d[0]!.subject).toBe(c(99));
  });

  test("either one alone is fine", () => {
    expect(checkOntology(ax((a) => (a.symmetric = true)), [], [])).toEqual([]);
    expect(checkOntology(ax((a) => (a.asymmetric = true)), [], [])).toEqual([]);
    // Transitive and asymmetric together is normal. It is the very
    // precondition that makes cycle detection meaningful.
    const both = ax((a) => {
      a.transitive = true;
      a.asymmetric = true;
    });
    expect(checkOntology(both, [], [])).toEqual([]);
  });

  test("transitive and functional is forbidden by owl2", () => {
    const a = ax((x) => {
      x.transitive = true;
      x.functional = true;
    });
    expect(kinds(checkOntology(a, [], []))).toEqual([Defect.TransitiveAndFunctional]);
    // Same for inverse-functional.
    const b = ax((x) => {
      x.transitive = true;
      x.inverseFunctional = true;
    });
    expect(kinds(checkOntology(b, [], []))).toEqual([Defect.TransitiveAndFunctional]);
  });

  test("subclass of can form a ring", () => {
    const none = new Map<Uuid, Axioms>();
    // 1 → 2 → 3 → 1
    const ring: Array<[Uuid, Uuid]> = [
      [c(1), c(2)],
      [c(2), c(3)],
      [c(3), c(1)],
    ];
    const d = checkOntology(none, ring, []);
    expect(kinds(d)).toEqual([Defect.SubclassCycle]);
    expect(d.length).toBe(1);
    expect(d[0]!.path.length).toBe(3);
  });

  test("a tree is not a ring", () => {
    const none = new Map<Uuid, Axioms>();
    // Multiple parents are not a ring either: 4 sits under both 2 and 3.
    const tree: Array<[Uuid, Uuid]> = [
      [c(1), c(2)],
      [c(1), c(3)],
      [c(4), c(2)],
      [c(4), c(3)],
    ];
    expect(checkOntology(none, tree, [])).toEqual([]);
  });

  test("a class disjoint with its own ancestor can never exist", () => {
    const none = new Map<Uuid, Axioms>();
    const parents: Array<[Uuid, Uuid]> = [
      [c(1), c(2)],
      [c(2), c(3)],
    ];
    // The import step expands the symmetry of "disjoint" into two rows;
    // this test gives it two rows too.
    const dis: Array<[Uuid, Uuid]> = [
      [c(1), c(3)],
      [c(3), c(1)],
    ];
    const d = checkOntology(none, parents, dis);
    expect(kinds(d)).toEqual([Defect.DisjointWithAncestor]);
    expect(d[0]!.subject).toBe(c(1));
    expect(d[0]!.other).toBe(c(3));
  });

  test("two disjoint ancestors make a class unsatisfiable", () => {
    const none = new Map<Uuid, Axioms>();
    // 1 is a subclass of both 2 and 3, and 2 and 3 are disjoint.
    const parents: Array<[Uuid, Uuid]> = [
      [c(1), c(2)],
      [c(1), c(3)],
    ];
    const dis: Array<[Uuid, Uuid]> = [
      [c(2), c(3)],
      [c(3), c(2)],
    ];
    const d = checkOntology(none, parents, dis);
    expect(kinds(d)).toEqual([Defect.InheritsDisjoint]);
    expect(d.length).toBe(1);
    expect(d[0]!.subject).toBe(c(1));
  });

  test("disjoint between unrelated branches is the point of disjoint", () => {
    const none = new Map<Uuid, Axioms>();
    // 2 and 3 are disjoint. 1 sits only under 2, and 4 sits only under 3.
    // This is the normal use of disjoint.
    const parents: Array<[Uuid, Uuid]> = [
      [c(1), c(2)],
      [c(4), c(3)],
    ];
    const dis: Array<[Uuid, Uuid]> = [
      [c(2), c(3)],
      [c(3), c(2)],
    ];
    expect(checkOntology(none, parents, dis)).toEqual([]);
  });

  test("a ring does not hang the ancestor walk", () => {
    const none = new Map<Uuid, Axioms>();
    const ring: Array<[Uuid, Uuid]> = [
      [c(1), c(2)],
      [c(2), c(1)],
    ];
    const dis: Array<[Uuid, Uuid]> = [
      [c(1), c(2)],
      [c(2), c(1)],
    ];
    // Both a ring and a disjoint pair at once: the ring must be reported,
    // and the ancestor walk must not fail to terminate.
    const d = checkOntology(none, ring, dis);
    expect(d.some((x) => x.kind === Defect.SubclassCycle)).toBe(true);
    expect(d.some((x) => x.kind === Defect.DisjointWithAncestor)).toBe(true);
  });

  test("nothing declared means nothing reported", () => {
    expect(checkOntology(new Map(), [], [])).toEqual([]);
    // A full class hierarchy but no disjoint pair means no criterion.
    const parents: Array<[Uuid, Uuid]> = [
      [c(1), c(2)],
      [c(2), c(3)],
    ];
    expect(checkOntology(new Map(), parents, [])).toEqual([]);
  });
});

describe("check_ontology inverse and sub property", () => {
  function only(id: Uuid, a: Axioms): Map<Uuid, Axioms> {
    return new Map([[id, a]]);
  }

  // Being its own inverse: legal, but indirect. Suggest symmetric instead.
  test("a predicate that is its own inverse should just say symmetric", () => {
    const a: Axioms = { ...defaultAxioms(), inverseOf: c(1) };
    const d = checkOntology(only(c(1), a), [], []);
    expect(kinds(d)).toEqual([Defect.InverseOfItself]);
  });

  // Its own inverse plus asymmetric equals the same contradiction as
  // symmetric+asymmetric, written a different way.
  test("its own inverse and asymmetric is the same contradiction in disguise", () => {
    const a: Axioms = { ...defaultAxioms(), inverseOf: c(1), asymmetric: true };
    const d = checkOntology(only(c(1), a), [], []);
    expect(kinds(d)).toContain(Defect.SymmetricAndAsymmetric);
  });

  // A mutual pair is clean: nothing should be reported.
  test("a mutual pair is clean", () => {
    const axioms = new Map<Uuid, Axioms>([
      [c(1), { ...defaultAxioms(), inverseOf: c(2) }],
      [c(2), { ...defaultAxioms(), inverseOf: c(1) }],
    ]);
    expect(checkOntology(axioms, [], [])).toEqual([]);
  });

  // `p⁻¹ = q` and `q⁻¹ = r`: the two disagree.
  //
  // Loading axioms only fills gaps and never overwrites what a user
  // wrote, so this contradiction is never silently smoothed over. It must
  // be reported here; there is no other place that would report it.
  test("an inverse that does not point back is reported", () => {
    const axioms = new Map<Uuid, Axioms>([
      [c(1), { ...defaultAxioms(), inverseOf: c(2) }],
      [c(2), { ...defaultAxioms(), inverseOf: c(3) }],
    ]);
    const d = checkOntology(axioms, [], []);
    const one = d.find((x) => x.kind === Defect.InverseNotMutual);
    expect(one).toBeDefined();
    expect(one!.subject).toBe(c(1));
    expect(one!.other).toBe(c(2));
    expect(one!.path).toEqual([c(1), c(2), c(3)]);
  });

  test("a sub property ring is a single predicate wearing three hats", () => {
    const mk = (parent: number): Axioms => ({ ...defaultAxioms(), subPropertyOf: c(parent) });
    const axioms = new Map<Uuid, Axioms>([
      [c(1), mk(2)],
      [c(2), mk(3)],
      [c(3), mk(1)],
    ]);
    const d = checkOntology(axioms, [], []);
    const ring = d.filter((x) => x.kind === Defect.SubPropertyCycle);
    expect(ring.length).toBe(1);
    expect(ring[0]!.path.length).toBe(3);
  });

  test("a chain that ends is not a ring", () => {
    const axioms = new Map<Uuid, Axioms>([
      [c(1), { ...defaultAxioms(), subPropertyOf: c(2) }],
      [c(2), { ...defaultAxioms(), subPropertyOf: c(3) }],
    ]);
    expect(checkOntology(axioms, [], [])).toEqual([]);
  });
});

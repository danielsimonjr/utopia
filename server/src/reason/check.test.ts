import { describe, expect, test } from "bun:test";
import { type Axioms, check, defaultAxioms, type Edge, Kind, type Violation } from "./check";
import type { Uuid } from "@/core";

function bytesToUuid(byte: number): string {
  const hex = byte.toString(16).padStart(2, "0").repeat(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Builds a stable id for a small integer. The tests read these to tell nodes apart. */
function n(i: number): Uuid {
  return bytesToUuid(i);
}

/**
 * Builds a stable id for a fact. Node ids use the low bits; fact ids use
 * the high bits (xor with 0xf0), so the two never collide even in a test
 * with 30 edges.
 */
function f(i: number): Uuid {
  return bytesToUuid(i ^ 0xf0);
}

function e(fact: number, s: number, o: number): Edge {
  return { fact: f(fact), predicate: n(99), subject: n(s), object: n(o) };
}

function ax(overrides: Partial<Axioms>): Axioms {
  return { ...defaultAxioms(), ...overrides };
}

function withAxioms(a: Axioms): Map<Uuid, Axioms> {
  return new Map([[n(99), a]]);
}

function kinds(v: Violation[]): Kind[] {
  return v
    .map((x) => x.kind)
    .slice()
    .sort();
}

describe("check", () => {
  // No declared axiom means no check. This is the base of the whole check:
  // no axiom means no reported contradiction. The reverse is also true: a
  // predicate with no ontology package reports zero. That is a true
  // result, not a bug.
  test("a predicate that declares nothing is never checked", () => {
    const edges = [e(1, 1, 1), e(2, 1, 2), e(3, 2, 1)];
    expect(check(edges, withAxioms(defaultAxioms()))).toEqual([]);
    // Also no check when the axioms map has no entry for this predicate
    // at all (the ontology has no row for it).
    expect(check(edges, new Map())).toEqual([]);
  });

  test("a self loop needs irreflexive to be a problem", () => {
    const edges = [e(1, 1, 1)];
    expect(check(edges, withAxioms(ax({ transitive: true })))).toEqual([]);
    const v = check(edges, withAxioms(ax({ irreflexive: true })));
    expect(kinds(v)).toEqual([Kind.SelfLoop]);
    // Only one fact: both columns hold the same id.
    expect(v[0]!.left).toEqual(v[0]!.right);
  });

  // The asymmetric check does not report a self loop again. `A p A` also
  // fits the literal wording of "there is a reverse edge". Without this
  // block, a self loop would be reported once for each of the two checks,
  // making a person see two findings for what is one problem.
  test("a self loop is reported once not twice", () => {
    const edges = [e(1, 1, 1)];
    const v = check(edges, withAxioms(ax({ irreflexive: true, asymmetric: true })));
    expect(kinds(v)).toEqual([Kind.SelfLoop]);
  });

  test("a pair pointing both ways needs asymmetric", () => {
    const edges = [e(1, 1, 2), e(2, 2, 1)];
    expect(
      check(edges, withAxioms(ax({ transitive: true }))).every((v) => v.kind !== Kind.Asymmetry),
    ).toBe(true);
    const v = check(edges, withAxioms(ax({ asymmetric: true })));
    expect(kinds(v)).toEqual([Kind.Asymmetry]);
    expect([v[0]!.left, v[0]!.right]).toEqual([f(1), f(2)]);
  });

  // A long cycle must report the whole path, not just "the first and last
  // fact contradict". A person needs to read the path in order to know
  // which fact to remove.
  test("a long cycle reports the whole path", () => {
    const edges = [e(1, 1, 2), e(2, 2, 3), e(3, 3, 4), e(4, 4, 1)];
    const v = check(edges, withAxioms(ax({ transitive: true })));
    expect(v.length).toBe(1);
    expect(v[0]!.path.length).toBe(4);
  });

  // The same cycle is reached once per node on it. Deduplication is half
  // the reason this function exists: reporting it four times would make a
  // person read the same thing four times.
  test("one cycle is one finding however many ways in", () => {
    const edges = [e(1, 1, 2), e(2, 2, 3), e(3, 3, 1)];
    const v = check(edges, withAxioms(ax({ transitive: true })));
    expect(v.length).toBe(1);
  });

  test("separate cycles stay separate", () => {
    const edges = [e(1, 1, 2), e(2, 2, 1), e(3, 5, 6), e(4, 6, 5)];
    const v = check(edges, withAxioms(ax({ transitive: true })));
    expect(v.length).toBe(2);
  });

  // The depth limit must stop a run that does not converge. ADR 0002
  // measured a real corpus where the `part_of` closure still oscillated at
  // depth 10. Without a limit, one long chain plus one cycle could make
  // the check never terminate.
  //
  // This builds a chain longer than the limit, then closes it into a
  // cycle. The check must not hang. Whether it reports the cycle is a
  // secondary concern; not hanging is the primary one.
  test("a chain longer than the limit still terminates", () => {
    const edges: Edge[] = [];
    for (let i = 0; i < 30; i++) {
      edges.push(e(i, i, i + 1));
    }
    edges.push(e(60, 30, 0));
    const v = check(edges, withAxioms(ax({ transitive: true })));
    // This asserts that the run finished. It does not require a specific length.
    expect(v.length).toBeLessThanOrEqual(1);
  });

  test("functional and its inverse are two directions of one check", () => {
    // The same subject points to two objects.
    const out = [e(1, 1, 2), e(2, 1, 3)];
    expect(kinds(check(out, withAxioms(ax({ functional: true }))))).toEqual([Kind.Functional]);
    expect(check(out, withAxioms(ax({ inverseFunctional: true })))).toEqual([]);

    // The same object is pointed to by two subjects.
    const inn = [e(1, 2, 1), e(2, 3, 1)];
    expect(kinds(check(inn, withAxioms(ax({ inverseFunctional: true }))))).toEqual([Kind.Functional]);
    expect(check(inn, withAxioms(ax({ functional: true })))).toEqual([]);
  });

  // A subject pointing to five objects reports only one pair. Reporting
  // ten pairs (every combination) would say the same thing ten times. A
  // person needs to know "there is a conflict here"; one pair is enough to
  // start looking.
  test("one finding per conflicting key not one per pair", () => {
    const edges = [e(1, 1, 2), e(2, 1, 3), e(3, 1, 4), e(4, 1, 5), e(5, 1, 6)];
    const v = check(edges, withAxioms(ax({ functional: true })));
    expect(v.length).toBe(1);
  });

  test("saying the same thing twice is not a contradiction", () => {
    const edges = [e(1, 1, 2), e(2, 1, 2)];
    expect(check(edges, withAxioms(ax({ functional: true })))).toEqual([]);
  });

  // Axioms attach to a predicate. Edges under different predicates are not
  // comparable. `A p B` and `B q A` holding at the same time is not a
  // contradiction, even when `p` declares `asymmetric`.
  test("axioms do not leak across predicates", () => {
    const a: Edge = { fact: f(1), predicate: n(90), subject: n(1), object: n(2) };
    const b: Edge = { fact: f(2), predicate: n(91), subject: n(2), object: n(1) };
    const axioms = new Map<Uuid, Axioms>([
      [n(90), ax({ asymmetric: true })],
      [n(91), ax({ asymmetric: true })],
    ]);
    expect(check([a, b], axioms)).toEqual([]);
  });
});

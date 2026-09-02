import { describe, expect, test } from "bun:test";
import { type Axioms, defaultAxioms, type Edge, MAX_DEPTH } from "./check";
import { derive, type Derivation, Rule, type TimedEdge, validity } from "./derive";
import type { Uuid } from "@/core";

function bytesToUuid(byte: number): string {
  const hex = byte.toString(16).padStart(2, "0").repeat(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function n(i: number): Uuid {
  return bytesToUuid(i);
}

function f(i: number): Uuid {
  return bytesToUuid(i ^ 0xf0);
}

/** An edge with no time bound. */
function e(fact: number, s: number, o: number): TimedEdge {
  return {
    edge: { fact: f(fact), predicate: n(99), subject: n(s), object: n(o) },
    from: undefined,
    to: undefined,
  };
}

/** An edge with a validity interval. */
function te(fact: number, s: number, o: number, from: number | undefined, to: number | undefined): TimedEdge {
  return { ...e(fact, s, o), from, to };
}

function ax(overrides: Partial<Axioms>): Axioms {
  return { ...defaultAxioms(), ...overrides };
}

function withAxioms(a: Axioms): Map<Uuid, Axioms> {
  return new Map([[n(99), a]]);
}

function transitive(): Map<Uuid, Axioms> {
  return withAxioms(ax({ transitive: true }));
}

/** Reads the low byte of a uuid built by `n()`, to compare against a small integer. */
function lowByte(id: Uuid): number {
  return parseInt(id.slice(0, 2), 16);
}

function pairs(d: Derivation): Array<[number, number]> {
  const p: Array<[number, number]> = d.facts.map((x) => [lowByte(x.subject), lowByte(x.object)]);
  p.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return p;
}

describe("derive", () => {
  test("nothing declared derives nothing", () => {
    const edges = [e(1, 1, 2), e(2, 2, 3)];
    expect(derive(edges, new Map()).facts).toEqual([]);
    // Declaring a different axiom does not help either. Only transitive
    // and symmetric compile into a rule.
    const irr = withAxioms(ax({ irreflexive: true }));
    expect(derive(edges, irr).facts).toEqual([]);
  });

  test("a chain closes", () => {
    // 1→2→3→4. Transitive should derive 1→3, 1→4, 2→4.
    const edges = [e(1, 1, 2), e(2, 2, 3), e(3, 3, 4)];
    const d = derive(edges, transitive());
    expect(pairs(d)).toEqual([
      [1, 3],
      [1, 4],
      [2, 4],
    ]);
    expect(d.capped).toEqual([]);
  });

  test("the proof is the premises in order", () => {
    const edges = [e(1, 1, 2), e(2, 2, 3), e(3, 3, 4)];
    const d = derive(edges, transitive());
    const long = d.facts.find((x) => x.subject === n(1) && x.object === n(4));
    expect(long).toBeDefined();
    expect(long!.premises).toEqual([f(1), f(2), f(3)]);
    expect(long!.rule).toBe(Rule.Transitive);
  });

  test("asserted beats derived", () => {
    // 1→2 and 2→3 already derive 1→3, and 1→3 is also asserted, so it is
    // not derived a second time.
    const edges = [e(1, 1, 2), e(2, 2, 3), e(3, 1, 3)];
    const d = derive(edges, transitive());
    expect(d.facts).toEqual([]);
  });

  test("a ring does not derive self loops and does not hang", () => {
    // 1→2→3→1: a cycle. The transitive closure would imply 1→1, which is
    // a contradiction, not knowledge.
    const edges = [e(1, 1, 2), e(2, 2, 3), e(3, 3, 1)];
    const d = derive(edges, transitive());
    expect(d.facts.every((x) => x.subject !== x.object)).toBe(true);
    // But the rest of the derivation on the ring holds: 1→3, 2→1, 3→2.
    expect(pairs(d)).toEqual([
      [1, 3],
      [2, 1],
      [3, 2],
    ]);
  });

  test("symmetric derives the other direction once", () => {
    const sym = withAxioms(ax({ symmetric: true }));
    const edges = [e(1, 1, 2)];
    const d = derive(edges, sym);
    expect(pairs(d)).toEqual([[2, 1]]);
    expect(d.facts[0]!.rule).toBe(Rule.Symmetric);
    expect(d.facts[0]!.premises).toEqual([f(1)]);
    // Both directions already asserted, so nothing to derive.
    const both = [e(1, 1, 2), e(2, 2, 1)];
    expect(derive(both, sym).facts).toEqual([]);
  });

  test("validity is the intersection", () => {
    // 1→2 during [10,30), 2→3 during [20,∞) implies 1→3 during [20,30).
    const edges = [te(1, 1, 2, 10, 30), te(2, 2, 3, 20, undefined)];
    const d = derive(edges, transitive());
    expect(pairs(d)).toEqual([[1, 3]]);
    const byFact = new Map<Uuid, [number | undefined, number | undefined]>([
      [f(1), [10, 30]],
      [f(2), [20, undefined]],
    ]);
    expect(validity(d.facts[0]!.premises, byFact)).toEqual([20, 30]);
  });

  test("no overlap derives nothing", () => {
    // 1→2 only during [10,20), 2→3 only during [30,40): the chain never
    // holds at any point in time.
    const edges = [te(1, 1, 2, 10, 20), te(2, 2, 3, 30, 40)];
    const d = derive(edges, transitive());
    expect(d.facts).toEqual([]);
  });

  test("a touching boundary is not an overlap", () => {
    // [10,20) and [20,30): half-open intervals, so touching endpoints do not overlap.
    const edges = [te(1, 1, 2, 10, 20), te(2, 2, 3, 20, 30)];
    expect(derive(edges, transitive()).facts).toEqual([]);
  });

  test("depth is bounded", () => {
    // A 40-hop chain. The depth limit is 12.
    const edges: TimedEdge[] = [];
    for (let i = 1; i <= 40; i++) {
      edges.push(e(i, i, i + 1));
    }
    const d = derive(edges, transitive());
    const longest = Math.max(...d.facts.map((x) => x.premises.length));
    expect(longest).toBeLessThanOrEqual(MAX_DEPTH);
    expect(d.facts.length).toBeGreaterThan(0);
  });

  test("symmetric feeds the transitive chain", () => {
    // Both symmetric and transitive declared: 1→2 and 3→2 are asserted.
    // Symmetric derives 2→3, so transitive can then reach 1→3.
    const both = withAxioms(ax({ symmetric: true, transitive: true }));
    const edges = [e(1, 1, 2), e(2, 3, 2)];
    const d = derive(edges, both);
    const got = pairs(d);
    expect(got.some(([a, b]) => a === 2 && b === 1)).toBe(true);
    expect(got.some(([a, b]) => a === 2 && b === 3)).toBe(true);
    expect(got.some(([a, b]) => a === 1 && b === 3)).toBe(true);
  });

  test("each predicate is closed on its own", () => {
    // 99 is transitive; 98 is not. The chain must not join across predicates.
    const other = e(2, 2, 3);
    other.edge.predicate = n(98);
    const edges = [e(1, 1, 2), other];
    const d = derive(edges, transitive());
    expect(d.facts).toEqual([]);
  });

  // ---- The two cross-predicate rules (inverseOf / subPropertyOf) ----
  //
  // The tests above all use a single predicate, n(99). These two rules
  // need three predicates to show their behavior, so this uses another
  // set of constants and builders.

  const P = bytesToUuid(1);
  const Q = bytesToUuid(2);
  const R = bytesToUuid(3);

  /** An edge with no time bound, on a given predicate. */
  function ep(pred: Uuid, fact: number, s: number, o: number): TimedEdge {
    return { edge: { fact: f(fact), predicate: pred, subject: n(s), object: n(o) }, from: undefined, to: undefined };
  }

  /** An edge with an interval, on a given predicate. */
  function tep(
    pred: Uuid,
    fact: number,
    s: number,
    o: number,
    from: number | undefined,
    to: number | undefined,
  ): TimedEdge {
    return { ...ep(pred, fact, s, o), from, to };
  }

  /** `p⁻¹ = q` and `q⁻¹ = p`: mutual. Used to test convergence. */
  function inversePair(): Map<Uuid, Axioms> {
    return new Map([
      [P, ax({ inverseOf: Q })],
      [Q, ax({ inverseOf: P })],
    ]);
  }

  /** `p ⊑ q` */
  function subProperty(): Map<Uuid, Axioms> {
    return new Map([[P, ax({ subPropertyOf: Q })]]);
  }

  // `A worksAt B` implies `B employs A`: the ends swap and the predicate
  // changes. Doing only one is the most common mistake, so this asserts both.
  test("the inverse swaps the ends and the predicate", () => {
    const d = derive([ep(P, 1, 1, 2)], inversePair());
    expect(d.facts.length).toBe(1);
    const got = d.facts[0]!;
    expect(got.predicate).toBe(Q);
    expect([got.subject, got.object]).toEqual([n(2), n(1)]);
    expect(got.rule).toBe(Rule.Inverse);
    expect(got.via).toBe(P);
    expect(got.premises).toEqual([f(1)]);
  });

  // `p⁻¹ = q` and `q⁻¹ = p`: mutual inverses. The edge derived back is
  // already asserted, so it must converge instead of bouncing back and forth.
  test("a mutual inverse settles instead of bouncing", () => {
    const d = derive([ep(P, 1, 1, 2), ep(Q, 2, 2, 1)], inversePair());
    expect(d.facts).toEqual([]);
  });

  // `p ⊑ q`: a fact about the specific predicate also holds for the general one. Ends stay the same.
  test("a sub property lifts the predicate and keeps the ends", () => {
    const d = derive([ep(P, 1, 1, 2)], subProperty());
    expect(d.facts.length).toBe(1);
    const got = d.facts[0]!;
    expect(got.predicate).toBe(Q);
    expect([got.subject, got.object]).toEqual([n(1), n(2)]);
    expect(got.rule).toBe(Rule.SubProperty);
    expect(got.via).toBe(P);
  });

  // For the two rules that do not change the predicate, `via` must equal
  // `predicate`. This looks obvious, but it is the reason the past bug
  // stayed hidden: the lookup used `predicate` for both rules, which was
  // correct here, so nobody noticed the key was wrong.
  test("for the same predicate rules via is the predicate", () => {
    const d = derive([e(1, 1, 2), e(2, 2, 3)], transitive());
    expect(d.facts.length).toBeGreaterThan(0);
    for (const fact of d.facts) {
      expect(fact.via).toBe(fact.predicate);
    }
  });

  // This test is the reason for the whole redesign: three rules chain
  // together.
  //
  // `A ceoOf B` ∧ `ceoOf ⊑ worksAt` ∧ `worksAt⁻¹ = employs`
  //   ⟹ `A worksAt B` ⟹ `B employs A`
  //
  // The old grouped-by-predicate design broke at the first step.
  test("a sub property feeds the inverse", () => {
    const axioms = new Map<Uuid, Axioms>([
      [P, ax({ subPropertyOf: Q })],
      [Q, ax({ inverseOf: R })],
    ]);
    const d = derive([ep(P, 1, 1, 2)], axioms);
    const got = d.facts
      .map((x): [Uuid, number, number] => [x.predicate, lowByte(x.subject), lowByte(x.object)])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1] || a[2] - b[2]));
    expect(got.some(([pred, s, o]) => pred === Q && s === 1 && o === 2)).toBe(true);
    expect(got.some(([pred, s, o]) => pred === R && s === 2 && o === 1)).toBe(true);
    expect(got.length).toBe(2);
    const employs = d.facts.find((x) => x.predicate === R)!;
    expect(employs.premises).toEqual([f(1)]);
  });

  // An edge derived by the inverse rule must still be usable by the
  // transitive rule: `p` is transitive, `q` is its inverse. `B q A` and
  // `C q B` should derive `C q A` (since `q` is also transitive).
  test("what the inverse produces can still be chained", () => {
    const axioms = new Map<Uuid, Axioms>([
      [P, ax({ inverseOf: Q })],
      [Q, ax({ transitive: true })],
    ]);
    // A p B, B p C ⟹ B q A, C q B ⟹ (q transitive) ⟹ C q A
    const d = derive([ep(P, 1, 1, 2), ep(P, 2, 2, 3)], axioms);
    const got = d.facts.map((x): [Uuid, number, number] => [x.predicate, lowByte(x.subject), lowByte(x.object)]);
    expect(got.some(([pred, s, o]) => pred === Q && s === 2 && o === 1)).toBe(true);
    expect(got.some(([pred, s, o]) => pred === Q && s === 3 && o === 2)).toBe(true);
    expect(got.some(([pred, s, o]) => pred === Q && s === 3 && o === 1)).toBe(true);
  });

  test("the inverse carries the same span", () => {
    const d = derive([tep(P, 1, 1, 2, 10, 20)], inversePair());
    expect(d.facts.length).toBe(1);
    const v = validity(d.facts[0]!.premises, new Map([[f(1), [10, 20]]]));
    expect(v).toEqual([10, 20]);
  });

  // Being its own inverse is equivalent to symmetric, but must not derive a self loop.
  test("a predicate that is its own inverse still refuses self loops", () => {
    const axioms = new Map<Uuid, Axioms>([[P, ax({ inverseOf: P })]]);
    const d = derive([ep(P, 1, 1, 1)], axioms);
    expect(d.facts).toEqual([]);
  });
});

// Consistency check.
//
// This module checks facts against axioms from the ontology. See ADR
// docs/decisions/0002 for the R0 design.
//
// This module does not write to the `facts` table. It does not touch the
// database. This layer only judges. Input is edges and axioms. Output is a
// list of facts that contradict each other. Fetching and storing data is
// the job of `utopia-store` and `utopia-server`.
//
// This split is not a preference. It is a design choice. The value of R0 is
// this: the hard parts of the engine (rule representation, evaluation, and
// termination) are built and tested, and the risk is zero. Those hard parts
// are pure logic. The check can run hundreds of test cases without a
// database, including shapes that a real corpus may not produce, such as an
// 11-node cycle, a self-loop inside a cycle, and one pair of nodes linked by
// two different predicates.
//
// No axiom means no check. Each of the four checks runs only when the
// ontology declares the matching axiom. No declaration means no check. It
// is safer to report zero contradictions than to guess an axiom. So a
// predicate with no ontology package reports zero. That is a true result,
// not a bug.

import type { Uuid } from "@/core";

/** One edge that takes part in a check: who, which relation, and who it points to. */
export interface Edge {
  fact: Uuid;
  predicate: Uuid;
  subject: Uuid;
  object: Uuid;
}

/**
 * The axioms declared for one predicate. A predicate with all four flags
 * false does not enter the check at all.
 */
export interface Axioms {
  transitive: boolean;
  symmetric: boolean;
  asymmetric: boolean;
  irreflexive: boolean;
  functional: boolean;
  inverseFunctional: boolean;
  /**
   * `p⁻¹ = q`: the inverse of this predicate. Cross-predicate rules come
   * from here. `A p B` implies `B q A`. The R0 check also reads this field:
   * a predicate that is its own inverse behaves like `symmetric`.
   */
  inverseOf?: Uuid;
  /**
   * `p ⊑ q`: a fact about the specific predicate also holds for the general
   * one. Chains can form a cycle. R0 checks for that.
   */
  subPropertyOf?: Uuid;
}

/** Returns a new `Axioms` value with every flag false and no inverse or super-property. */
export function defaultAxioms(): Axioms {
  return {
    transitive: false,
    symmetric: false,
    asymmetric: false,
    irreflexive: false,
    functional: false,
    inverseFunctional: false,
    inverseOf: undefined,
    subPropertyOf: undefined,
  };
}

/**
 * Returns true when a predicate declares no axiom at all.
 *
 * Skipping this predicate saves time and matches the semantics. No axiom
 * means no criterion. Scanning it finds nothing.
 */
function saysNothing(ax: Axioms): boolean {
  return (
    !ax.transitive &&
    !ax.symmetric &&
    !ax.asymmetric &&
    !ax.irreflexive &&
    !ax.functional &&
    !ax.inverseFunctional &&
    ax.inverseOf === undefined &&
    ax.subPropertyOf === undefined
  );
}

/**
 * One contradiction found by the check.
 *
 * Store this in the `axiom_violations` table, not in `fact_conflicts`. The
 * `fact_conflicts` table asks which fact is correct. An axiom violation asks
 * whether the error is in the data or in the ontology. The fix for the
 * second case may be to change the ontology.
 */
export interface Violation {
  kind: Kind;
  /**
   * The facts involved. A self-loop violation has only one fact: it
   * contradicts itself, so there is no second fact to name. A cycle
   * violation names the first and last fact of the path. The other facts
   * are in `path`.
   */
  left: Uuid;
  right: Uuid;
  /** The full path of the cycle, in fact order. Empty for the other three kinds. */
  path: Uuid[];
}

export type Kind = "self_loop" | "asymmetry" | "cycle" | "functional";

export const Kind = {
  /** `A p A`, and `p` declares `irreflexive`. */
  SelfLoop: "self_loop",
  /** `A p B` and `B p A`, and `p` declares `asymmetric`. */
  Asymmetry: "asymmetry",
  /** `A p B p … p A`, and `p` declares `transitive`. The closure implies `A p A`. */
  Cycle: "cycle",
  /**
   * The same subject and predicate point to two objects, and `p` declares
   * `functional`. (`inverseFunctional` is the same check for one object
   * pointed to by two subjects.)
   */
  Functional: "functional",
} as const satisfies Record<string, Kind>;

/**
 * The depth limit for cycle detection.
 *
 * This limit is required, not a defensive habit. ADR 0002 measured a real
 * corpus: the transitive closure of `part_of` grew from 185 facts to 828
 * facts and did not converge. The depth distribution was `1:185 2:181
 * 3:141 4:45 5:52 6:40 7:52 8:40 9:52 10:40`. From depth 5 onward the count
 * oscillates instead of shrinking. That shape means a cycle exists. Without
 * a limit, one cycle can make evaluation never terminate.
 */
export const MAX_DEPTH = 12;

/**
 * Checks a batch of edges against the given axioms.
 *
 * Each predicate is checked on its own. Axioms attach to a predicate, so
 * edges under different predicates are not comparable. `A part_of B` and
 * `B produces A` holding at the same time is not a contradiction.
 */
export function check(edges: Edge[], axioms: Map<Uuid, Axioms>): Violation[] {
  const out: Violation[] = [];
  const byPred = new Map<Uuid, Edge[]>();
  for (const e of edges) {
    const ax = axioms.get(e.predicate);
    if (ax === undefined) continue;
    if (saysNothing(ax)) continue;
    const group = byPred.get(e.predicate);
    if (group) {
      group.push(e);
    } else {
      byPred.set(e.predicate, [e]);
    }
  }
  for (const [pred, group] of byPred) {
    const ax = axioms.get(pred)!;
    if (ax.irreflexive) {
      out.push(...selfLoops(group));
    }
    if (ax.asymmetric) {
      out.push(...asymmetries(group));
    }
    if (ax.transitive) {
      out.push(...cycles(group));
    }
    if (ax.functional) {
      out.push(...tooMany(group, (e) => e.subject, (e) => e.object));
    }
    if (ax.inverseFunctional) {
      out.push(...tooMany(group, (e) => e.object, (e) => e.subject));
    }
  }
  return out;
}

function selfLoops(edges: Edge[]): Violation[] {
  return edges
    .filter((e) => e.subject === e.object)
    .map((e) => ({
      kind: Kind.SelfLoop,
      // Both columns hold the same fact: it contradicts itself, so there
      // is no second fact to point to.
      left: e.fact,
      right: e.fact,
      path: [],
    }));
}

function asymmetries(edges: Edge[]): Violation[] {
  const seen = new Map<string, Uuid>();
  const out: Violation[] = [];
  for (const e of edges) {
    if (e.subject === e.object) {
      // The irreflexive check already covers this. Reporting it here too
      // would report the same self-loop twice.
      continue;
    }
    const other = seen.get(pairKey(e.object, e.subject));
    if (other !== undefined) {
      out.push({
        kind: Kind.Asymmetry,
        left: other,
        right: e.fact,
        path: [],
      });
    }
    seen.set(pairKey(e.subject, e.object), e.fact);
  }
  return out;
}

function pairKey(a: Uuid, b: Uuid): string {
  return `${a}\u0000${b}`;
}

/**
 * Finds cycles. Each cycle is reported once, starting from the smallest
 * node on the cycle.
 *
 * This uses depth-first search, not semi-naive closure evaluation. Both
 * methods can find a cycle, but closure evaluation only tells you that `A`
 * implies `A`. A person needs the path: reading `A→B→C→A` in order shows
 * which fact to remove. Closure evaluation drops that path.
 *
 * R1 materialization needs the closure itself, and builds it separately.
 * R0 needs the set of edges that form each cycle.
 */
function cycles(edges: Edge[]): Violation[] {
  const adj = new Map<Uuid, Edge[]>();
  for (const e of edges) {
    const list = adj.get(e.subject);
    if (list) {
      list.push(e);
    } else {
      adj.set(e.subject, [e]);
    }
  }
  const reported = new Set<string>();
  const out: Violation[] = [];
  const nodes = Array.from(adj.keys());
  for (const start of nodes) {
    const path: Edge[] = [];
    const onPath = new Set<Uuid>();
    walk(start, start, adj, path, onPath, reported, out);
  }
  return out;
}

function walk(
  start: Uuid,
  at: Uuid,
  adj: Map<Uuid, Edge[]>,
  path: Edge[],
  onPath: Set<Uuid>,
  reported: Set<string>,
  out: Violation[],
): void {
  if (path.length >= MAX_DEPTH) {
    return;
  }
  const next = adj.get(at);
  if (!next) {
    return;
  }
  for (const e of next) {
    if (e.object === start && path.length !== 0) {
      // Back at the start: this is a cycle. Dedupe by the sorted fact ids.
      // The same cycle is reached once per node on it. Reporting it more
      // than once would make a person read the same finding many times.
      const facts = path.map((x) => x.fact);
      facts.push(e.fact);
      const key = [...facts].sort().join(",");
      if (!reported.has(key)) {
        reported.add(key);
        out.push({
          kind: Kind.Cycle,
          left: facts[0]!,
          right: facts[facts.length - 1]!,
          path: facts,
        });
      }
      continue;
    }
    if (e.object === start || onPath.has(e.object)) {
      continue;
    }
    onPath.add(e.object);
    path.push(e);
    walk(start, e.object, adj, path, onPath, reported, out);
    path.pop();
    onPath.delete(e.object);
  }
}

/**
 * Checks for a functional violation: the same "one side" points to two
 * different values on the other side.
 *
 * `functional` and `inverseFunctional` are the same check in two
 * directions, so both share this function. The caller picks which side is
 * the key.
 */
function tooMany(edges: Edge[], key: (e: Edge) => Uuid, val: (e: Edge) => Uuid): Violation[] {
  const byKey = new Map<Uuid, Edge[]>();
  for (const e of edges) {
    const k = key(e);
    const group = byKey.get(k);
    if (group) {
      group.push(e);
    } else {
      byKey.set(k, [e]);
    }
  }
  const out: Violation[] = [];
  for (const group of byKey.values()) {
    // Report only the first pair. A subject pointing to five objects would
    // give ten pairs if we reported every combination. That says the same
    // thing ten times. A person needs to know "there is a conflict here";
    // one pair is enough to start looking.
    const distinct: Edge[] = [];
    for (const e of group) {
      if (!distinct.some((d) => val(d) === val(e))) {
        distinct.push(e);
      }
    }
    if (distinct.length > 1) {
      out.push({
        kind: Kind.Functional,
        left: distinct[0]!.fact,
        right: distinct[1]!.fact,
        path: [],
      });
    }
  }
  return out;
}

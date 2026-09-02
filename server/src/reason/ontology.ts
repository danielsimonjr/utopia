// Consistency of the ontology itself. This module reads only definitions.
// It does not touch facts.
//
// This is a different job from `check` in `check.ts`. That module asks
// "does this fact contradict the definition?" This module asks "does the
// definition contradict itself?" The two are separate for a reason: a
// self-contradictory ontology makes every conclusion from the fact layer
// suspect. If a predicate declares both `symmetric` and `asymmetric`, every
// asymmetry violation reported for it rests on a premise that was already
// false. So the findings from this layer must be shown first.
//
// This check is also cheap. The input is only a few thousand lines of
// ontology. There is no need to scan a fact store.
//
// The same rule applies here: no declaration, no check. Every check below
// matches something written in the ontology. None of it is an assumption
// made on the user's behalf.

import type { Uuid } from "@/core";
import type { Axioms } from "./check";

/**
 * The depth limit for walking up the class hierarchy. This uses the same
 * reasoning as `MAX_DEPTH` in `check.ts`: an ontology can contain a cycle
 * (table constraints only block a direct self-loop; they cannot block
 * `A → B → A`). Without a limit, the walk would never terminate.
 */
export const MAX_ANCESTRY = 32;

export type Defect =
  | "symmetric_and_asymmetric"
  | "transitive_and_functional"
  | "subclass_cycle"
  | "disjoint_with_ancestor"
  | "inherits_disjoint"
  | "inverse_of_itself"
  | "inverse_not_mutual"
  | "sub_property_cycle";

export const Defect = {
  /**
   * A predicate declares both `symmetric` and `asymmetric`.
   *
   * In OWL, the two can hold together only for an empty property. As soon
   * as one edge `A p B` exists, `symmetric` requires `B p A`, and
   * `asymmetric` forbids it. So whenever this predicate has any fact, one
   * of the two declarations is wrong.
   */
  SymmetricAndAsymmetric: "symmetric_and_asymmetric",
  /**
   * `transitive` and `functional` together. OWL 2 DL forbids this
   * explicitly: a functional property must not be declared transitive,
   * because together they push reasoning outside the decidable fragment.
   *
   * The intuition matches: `functional` says the subject side has only one
   * value. `transitive` says to keep following the chain. The second hop
   * on the chain then gives the same subject a second value.
   */
  TransitiveAndFunctional: "transitive_and_functional",
  /**
   * A `subClassOf` chain forms a cycle. A table constraint at load time
   * can only block `A → A`.
   *
   * A cycle means every class on it is a subclass of every other, so they
   * are really one class. Yet each keeps its own label, description, and
   * properties, and the UI draws each as a separate row.
   */
  SubclassCycle: "subclass_cycle",
  /**
   * A class declares itself disjoint with one of its own ancestors, so
   * this class can never have an instance. It inherits its ancestor's
   * identity, and also declares itself disjoint from it.
   */
  DisjointWithAncestor: "disjoint_with_ancestor",
  /**
   * Two ancestors of a class are disjoint from each other, so the class
   * can never have an instance. This shape is not rare under multiple
   * inheritance: two branches are each fine alone, but combined they
   * contradict.
   */
  InheritsDisjoint: "inherits_disjoint",
  /**
   * A predicate declares itself as its own inverse. This is equivalent to
   * `symmetric`. Reasoning still works, but the reader must think one
   * extra step. Suggest rewriting it as `symmetric` instead.
   */
  InverseOfItself: "inverse_of_itself",
  /**
   * `p⁻¹ = q`, but `q⁻¹ = r`, and the two disagree.
   *
   * When loading axioms, a missing value is filled in, but a value the
   * user wrote is never overwritten (the user's value always wins over a
   * derived one). So this contradiction is never silently smoothed over.
   * It is reported here instead.
   */
  InverseNotMutual: "inverse_not_mutual",
  /**
   * A `subPropertyOf` chain forms a cycle. This has the same shape as
   * `SubclassCycle`: every predicate on the cycle is a sub-property of
   * every other, so they are really one predicate, yet each keeps its own
   * label and its own facts.
   */
  SubPropertyCycle: "sub_property_cycle",
} as const satisfies Record<string, Defect>;

/** One self-contradiction found in the ontology. */
export interface OntologyDefect {
  kind: Defect;
  /** The object with the problem: a predicate (first two kinds) or a class (last three kinds). */
  subject: Uuid;
  /** The other side: the disjoint class. The first two kinds and the cycle kinds have no second side. */
  other?: Uuid;
  /** The path of the cycle (by class), or the path from the class to the ancestor. Empty otherwise. */
  path: Uuid[];
}

function cmpUuid(a: Uuid, b: Uuid): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Checks the ontology against itself.
 *
 * `parents` holds `(child, parent)` pairs. `disjoint` holds disjoint pairs.
 * The import step has already expanded symmetry into two rows, so both
 * directions are seen here. Deduplication uses a sorted key.
 */
export function checkOntology(
  axioms: Map<Uuid, Axioms>,
  parents: Array<[Uuid, Uuid]>,
  disjoint: Array<[Uuid, Uuid]>,
): OntologyDefect[] {
  const out: OntologyDefect[] = [];

  // Two self-contradictions on predicates. Sort before reporting: a Map's
  // iteration order can differ between runs, but the same ontology must
  // give the same result on two checks.
  const preds = Array.from(axioms.entries()).sort((a, b) => cmpUuid(a[0], b[0]));
  for (const [pred, ax] of preds) {
    if (ax.symmetric && ax.asymmetric) {
      out.push({ kind: Defect.SymmetricAndAsymmetric, subject: pred, other: undefined, path: [] });
    }
    if (ax.transitive && (ax.functional || ax.inverseFunctional)) {
      out.push({ kind: Defect.TransitiveAndFunctional, subject: pred, other: undefined, path: [] });
    }
    // Being its own inverse is equivalent to symmetric. This is not
    // wrong, only indirect. Reasoning still works, but the reader must
    // think one extra step. Suggest `symmetric` instead; it is clearer.
    if (ax.inverseOf === pred) {
      out.push({ kind: Defect.InverseOfItself, subject: pred, other: undefined, path: [] });
    }
    // Inverse-of-self plus asymmetric: `A p B` implies `B p A` (its own
    // inverse), and asymmetric forbids that. This is the same
    // contradiction as symmetric+asymmetric, written a different way.
    if (ax.inverseOf === pred && ax.asymmetric) {
      out.push({ kind: Defect.SymmetricAndAsymmetric, subject: pred, other: undefined, path: [] });
    }
    // Each side declares an inverse, but they point to different
    // predicates. The loader does not silently reconcile this (loading
    // axioms only fills gaps; it never overwrites what a user wrote), so
    // it is reported here.
    if (ax.inverseOf !== undefined) {
      const inv = ax.inverseOf;
      const back = axioms.get(inv)?.inverseOf;
      if (back !== undefined && back !== pred) {
        out.push({ kind: Defect.InverseNotMutual, subject: pred, other: inv, path: [pred, inv, back] });
      }
    }
  }

  // subPropertyOf forms a cycle. Same shape as the subClassOf cycle:
  // every predicate on the cycle is a sub-property of every other, so
  // they are really one predicate, yet each keeps its own label and its
  // own facts.
  {
    const parentOf = new Map<Uuid, Uuid>();
    for (const [id, ax] of axioms) {
      if (ax.subPropertyOf !== undefined) {
        parentOf.set(id, ax.subPropertyOf);
      }
    }
    const starts = Array.from(parentOf.keys()).sort(cmpUuid);
    const reported = new Set<Uuid>();
    for (const start of starts) {
      if (reported.has(start)) {
        continue;
      }
      const seen: Uuid[] = [];
      let cur = start;
      for (let i = 0; i < MAX_ANCESTRY; i++) {
        if (seen.includes(cur)) {
          // Every member of the cycle is marked, so the whole cycle is
          // reported only once.
          for (const m of seen) {
            reported.add(m);
          }
          out.push({ kind: Defect.SubPropertyCycle, subject: start, other: undefined, path: [...seen] });
          break;
        }
        seen.push(cur);
        const parent = parentOf.get(cur);
        if (parent === undefined) {
          break;
        }
        cur = parent;
      }
    }
  }

  const up = adjacency(parents);
  out.push(...subclassCycles(up));
  out.push(...unsatisfiable(up, disjoint));
  return out;
}

/** Builds a child-to-parent adjacency map. A repeated pair is stored only once. */
function adjacency(parents: Array<[Uuid, Uuid]>): Map<Uuid, Uuid[]> {
  const up = new Map<Uuid, Uuid[]>();
  for (const [child, parent] of parents) {
    let slot = up.get(child);
    if (!slot) {
      slot = [];
      up.set(child, slot);
    }
    if (!slot.includes(parent)) {
      slot.push(parent);
    }
  }
  // Sorting keeps the path the same across runs of the same ontology.
  for (const v of up.values()) {
    v.sort(cmpUuid);
  }
  return up;
}

/** Finds subClassOf cycles. Each cycle is reported once, keyed by its sorted set of classes. */
function subclassCycles(up: Map<Uuid, Uuid[]>): OntologyDefect[] {
  const reported = new Set<string>();
  const out: OntologyDefect[] = [];
  const starts = Array.from(up.keys()).sort(cmpUuid);
  for (const start of starts) {
    const path: Uuid[] = [];
    const onPath = new Set<Uuid>();
    climb(start, start, up, path, onPath, reported, out);
  }
  return out;
}

function climb(
  start: Uuid,
  at: Uuid,
  up: Map<Uuid, Uuid[]>,
  path: Uuid[],
  onPath: Set<Uuid>,
  reported: Set<string>,
  out: OntologyDefect[],
): void {
  if (path.length >= MAX_ANCESTRY) {
    return;
  }
  const ups = up.get(at);
  if (!ups) {
    return;
  }
  for (const parent of ups) {
    if (parent === start && path.length !== 0) {
      // Back at the start: this is a cycle. `path` currently holds the
      // classes after `start`.
      const ring = [start, ...path];
      const sorted = [...ring].sort(cmpUuid);
      const key: Uuid[] = [];
      for (const id of sorted) {
        if (key[key.length - 1] !== id) {
          key.push(id);
        }
      }
      const keyStr = key.join("\u0000");
      if (!reported.has(keyStr)) {
        reported.add(keyStr);
        out.push({ kind: Defect.SubclassCycle, subject: start, other: undefined, path: ring });
      }
      continue;
    }
    if (onPath.has(parent) || parent === start) {
      // A cycle elsewhere; let it be reported on its own turn. Just do
      // not walk into it here.
      continue;
    }
    path.push(parent);
    onPath.add(parent);
    climb(start, parent, up, path, onPath, reported, out);
    onPath.delete(parent);
    path.pop();
  }
}

/**
 * Finds unsatisfiable classes: a class whose set of ancestors contains a
 * disjoint pair.
 *
 * The two shapes are reported separately, because the message to the user
 * differs: disjoint with one's own ancestor means "this disjoint
 * declaration is backwards"; disjoint ancestors means "this class should
 * not sit under both branches".
 */
function unsatisfiable(up: Map<Uuid, Uuid[]>, disjoint: Array<[Uuid, Uuid]>): OntologyDefect[] {
  const pairs = new Set<string>();
  for (const [a, b] of disjoint) {
    pairs.add(pairKey(a, b));
  }
  if (pairs.size === 0) {
    return [];
  }
  const out: OntologyDefect[] = [];
  const classes = Array.from(up.keys()).sort(cmpUuid);
  for (const cls of classes) {
    const anc = ancestors(cls, up);
    // One: disjoint with one's own ancestor.
    for (const a of anc) {
      if (pairs.has(pairKey(cls, a))) {
        out.push({ kind: Defect.DisjointWithAncestor, subject: cls, other: a, path: [] });
      }
    }
    // Two: two ancestors disjoint from each other. Dedupe with an ordered
    // pair, or a disjoint declaration expanded into two rows would be
    // reported twice.
    const sorted = Array.from(anc).sort(cmpUuid);
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i]!;
      for (let j = i + 1; j < sorted.length; j++) {
        const b = sorted[j]!;
        if (pairs.has(pairKey(a, b))) {
          out.push({ kind: Defect.InheritsDisjoint, subject: cls, other: b, path: [a] });
        }
      }
    }
  }
  return out;
}

function pairKey(a: Uuid, b: Uuid): string {
  return `${a}\u0000${b}`;
}

/** All ancestors of a class, not including itself. A cycle does not stop this: `seen` blocks it. */
function ancestors(cls: Uuid, up: Map<Uuid, Uuid[]>): Set<Uuid> {
  const seen = new Set<Uuid>();
  const queue: Array<[Uuid, number]> = [[cls, 0]];
  while (queue.length > 0) {
    const [at, depth] = queue.pop()!;
    if (depth >= MAX_ANCESTRY) {
      continue;
    }
    const ups = up.get(at);
    if (!ups) {
      continue;
    }
    for (const parent of ups) {
      if (parent !== cls && !seen.has(parent)) {
        seen.add(parent);
        queue.push([parent, depth + 1]);
      }
    }
  }
  return seen;
}

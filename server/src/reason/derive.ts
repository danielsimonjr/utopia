// R1: materialized derivation.
//
// This layer adds facts to the graph. Because of that, every constraint in
// it is necessary.
//
// The line between R0 and R1: R0 only points out problems, so its risk is
// zero. R1 writes facts. ADR 0002 gives this step three hard rules. Each
// one is implemented below.
//
// Rule one: rules compile only from ontology axioms. There is no
// user-defined DSL; that is a different product. Today only
// `TransitiveProperty` and `SymmetricProperty` compile into rules.
// `inverseOf` and `subPropertyOf` projection is not yet stored, so it is
// not compiled either. A missing rule is not a defect. It follows the same
// principle: no declaration, no derivation.
//
// Rule two: an asserted fact always outranks a derived one. This is a hard
// rule. A triple that is already asserted is never derived again. This is
// not to save rows. It exists so the question "who said this" has one
// answer.
//
// Rule three: a depth limit and cycle detection are both required in
// practice. ADR 0002 measured a real corpus: the transitive closure of
// `part_of` grew from 185 facts to 828 facts and did not converge. From
// depth 5 onward the count oscillates instead of shrinking. That shape
// means a cycle exists. So this layer never derives a self-loop (`A → A`
// is a contradiction, not knowledge; R0 reports it), and it also caps the
// number of rounds.
//
// ADR 0002 leaves one open question that this module must answer: how to
// combine validity intervals. Premise A holds during `[2020,2023)`.
// Premise B holds during `[2022,∞)`. The derived fact holds during
// `[2022,2023)`, the intersection. When the intersection is empty, do not
// derive the fact. Two intervals with no overlap mean the chain never
// holds at any point in time.

import type { Uuid } from "@/core";
import { type Axioms, type Edge, MAX_DEPTH } from "./check";

/**
 * The limit on how many facts one predicate can derive.
 *
 * This limit is not a defensive habit; it is based on measurement. A 4.5x
 * growth was measured on one predicate with 185 edges, and the growth is
 * super-linear. When the limit truncates a predicate, that fact must be
 * reported (see `Derivation.capped`). A silent truncation would make
 * "derivation finished" look the same as "derivation is partial".
 */
export const MAX_DERIVED_PER_PREDICATE = 20_000;

export type Rule = "transitive" | "symmetric" | "inverse" | "sub_property";

export const Rule = {
  /** `A p B` ∧ `B p C` ⟹ `A p C`. */
  Transitive: "transitive",
  /** `A p B` ⟹ `B p A`. */
  Symmetric: "symmetric",
  /**
   * `A p B` ∧ `p⁻¹ = q` ⟹ `B q A`. Both the subject/object swap and the
   * predicate change happen together. Doing only one of them is the
   * easiest mistake to make with this rule.
   */
  Inverse: "inverse",
  /** `A p B` ∧ `p ⊑ q` ⟹ `A q B`. The subject and object stay the same. Only the predicate rises. */
  SubProperty: "sub_property",
} as const satisfies Record<string, Rule>;

/** One derived fact to store, together with its proof. */
export interface Derived {
  predicate: Uuid;
  /**
   * The predicate whose declaration triggered this fact.
   *
   * `Transitive` and `Symmetric` do not change the predicate, so
   * `via === predicate`. `inverseOf` and `subPropertyOf` do change it:
   * deriving from `ceoOf ⊑ worksAt` produces a fact whose predicate is
   * `worksAt`, but the declaration is on `ceoOf`.
   *
   * Look up the rule row by `via` when storing a fact. A past bug looked
   * up by `predicate` instead. That was correct for the first two rules
   * (`via` and `predicate` are equal there), but broke for the two
   * cross-predicate rules: the lookup failed and the fact was silently
   * dropped. That is the hardest kind of bug to find.
   */
  via: Uuid;
  subject: Uuid;
  object: Uuid;
  rule: Rule;
  /**
   * The premises used, in derivation order. This is one layer of the proof
   * tree. R2 walks it to expand an explanation. When a premise becomes
   * invalid, this layer also shows which derived facts must be
   * invalidated.
   */
  premises: Uuid[];
}

/** The output of one derivation run. */
export interface Derivation {
  facts: Derived[];
  /**
   * Predicates that hit the limit before finishing. This list must reach
   * the caller. The UI must be able to say "this predicate is too dense;
   * only 20,000 facts were derived," instead of implying the derivation
   * finished.
   */
  capped: Uuid[];
}

/**
 * One edge with a validity interval, in addition to the fields on `Edge`.
 *
 * This is a separate type instead of adding fields to `Edge`. R0 never
 * uses time: whether an axiom is violated does not depend on when it
 * holds. R1 computes an intersection at every step.
 */
export interface TimedEdge {
  edge: Edge;
  /** A half-open interval `[from, to)`. Either end may be absent, meaning unknown or unbounded. */
  from?: number;
  to?: number;
}

type Span = readonly [number | undefined, number | undefined];

/** Intersects two intervals. `undefined` means unbounded on that side. */
function overlap(a: Span, b: Span): Span | undefined {
  const from = a[0] !== undefined && b[0] !== undefined ? Math.max(a[0], b[0]) : a[0] ?? b[0];
  const to = a[1] !== undefined && b[1] !== undefined ? Math.min(a[1], b[1]) : a[1] ?? b[1];
  // An empty intersection means no derivation. When the two intervals do
  // not overlap, the chain never holds at any point in time. Deriving it
  // anyway would produce a fact that is never true, which is worse than
  // not deriving it.
  if (from !== undefined && to !== undefined && from >= to) {
    return undefined;
  }
  return [from, to];
}

/** One edge out of a subject: (object, from, to, fact id). */
type Hop = [Uuid, number | undefined, number | undefined, Uuid];

/** An intermediate state: how one (subject, object) pair was reached. */
interface Reached {
  from: number | undefined;
  to: number | undefined;
  premises: Uuid[];
}

/** The identity of one triple: (predicate, subject, object). */
type Triple = readonly [Uuid, Uuid, Uuid];

function tripleKey(pred: Uuid, subj: Uuid, obj: Uuid): string {
  return `${pred}\u0000${subj}\u0000${obj}`;
}

function pairKey(pred: Uuid, subj: Uuid): string {
  return `${pred}\u0000${subj}`;
}

function cmpUuid(a: Uuid, b: Uuid): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function cmpTriple(a: Triple, b: Triple): number {
  return cmpUuid(a[0], b[0]) || cmpUuid(a[1], b[1]) || cmpUuid(a[2], b[2]);
}

/**
 * Derives new facts from a batch of edges and axioms.
 *
 * This is one global fixed-point computation. It does not group by
 * predicate. Three rules can chain together:
 *
 * ```text
 * A ceoOf B  --(subPropertyOf)-->  A worksAt B  --(inverseOf)-->  B employs A
 * ```
 *
 * Grouping by predicate would break this chain at the first step. Instead,
 * this uses semi-naive evaluation over the whole set: each round takes the
 * new edges from the last round (the frontier) and derives once more.
 * Rounds stop when nothing new appears.
 *
 * The three one-hop rules (symmetric, inverse, sub-property) run in the
 * same round as transitive, because they feed each other: an edge derived
 * by `inverse` may complete a transitive chain, and the reverse also
 * holds.
 */
export function derive(edges: TimedEdge[], axioms: Map<Uuid, Axioms>): Derivation {
  const out: Derivation = { facts: [], capped: [] };

  // Asserted triples. A derivation yields to an asserted fact; asserted
  // outranking derived is a hard rule.
  const asserted = new Set<string>();
  for (const e of edges) {
    asserted.add(tripleKey(e.edge.predicate, e.edge.subject, e.edge.object));
  }

  // Triples already derived, and how they were reached. Only the first
  // proof is kept for each triple. Multiple paths can derive the same
  // fact; showing one path over another makes no difference to the user,
  // while keeping every path would make the proof tree grow with the
  // number of paths.
  const reached = new Map<string, Reached>();
  // The limit is still counted per predicate. The constant keeps its
  // meaning: one predicate can derive at most 20,000 facts, and
  // `Derivation.capped` still returns a list of predicates. A single
  // global count would make it impossible for the UI to say which
  // predicate is too dense.
  const perPred = new Map<Uuid, number>();
  const capped = new Set<Uuid>();

  // Edges reachable from (predicate, subject), used for the transitive
  // rule. Derived edges are added here too. They are already our
  // assertions, so a chain must not break just because an edge came from
  // derivation instead of assertion.
  const adj = new Map<string, Hop[]>();
  for (const e of edges) {
    const key = pairKey(e.edge.predicate, e.edge.subject);
    const hop: Hop = [e.edge.object, e.from, e.to, e.edge.fact];
    const list = adj.get(key);
    if (list) {
      list.push(hop);
    } else {
      adj.set(key, [hop]);
    }
  }

  let frontier: Array<[Triple, Reached]> = edges.map((e) => [
    [e.edge.predicate, e.edge.subject, e.edge.object],
    { from: e.from, to: e.to, premises: [e.edge.fact] },
  ]);
  // The order of the input is not guaranteed. Sort once so the same
  // library derives the same result on two runs.
  frontier.sort((a, b) => cmpTriple(a[0], b[0]));

  // The round limit is a backstop. The real limit is the
  // `premises.length >= MAX_DEPTH` check below: the constant means "the
  // longest path is 12", which is measured by premise count. The round
  // limit only guards against pathological input.
  for (let round = 0; round < MAX_DEPTH; round++) {
    if (frontier.length === 0) {
      break;
    }
    const next: Array<[Triple, Reached]> = [];

    for (const [triple, acc] of frontier) {
      const [pred, subj, obj] = triple;
      const ax = axioms.get(pred);
      if (ax === undefined) {
        continue;
      }
      // One more hop would exceed the limit. This triple does not expand
      // further, but it has already been emitted.
      if (acc.premises.length >= MAX_DEPTH) {
        continue;
      }

      // The three one-hop rules: swap the ends (symmetric), or change the
      // predicate (inverse, sub-property).
      const hops: Array<[Triple, Rule]> = [];
      if (ax.symmetric) {
        hops.push([[pred, obj, subj], Rule.Symmetric]);
      }
      if (ax.inverseOf !== undefined) {
        // `A p B ⟹ B p⁻¹ A`. The ends swap and the predicate changes.
        // Doing only one of these is the easiest mistake with this rule.
        hops.push([[ax.inverseOf, obj, subj], Rule.Inverse]);
      }
      if (ax.subPropertyOf !== undefined) {
        // `A p B ∧ p ⊑ q ⟹ A q B`. The ends stay the same. Only the
        // predicate rises.
        hops.push([[ax.subPropertyOf, subj, obj], Rule.SubProperty]);
      }
      for (const [t, rule] of hops) {
        emit(t, pred, rule, acc, acc.from, acc.to, undefined, asserted, reached, perPred, capped, out, next, adj);
      }

      // Transitive: needs one more outgoing edge on the same predicate.
      if (ax.transitive) {
        const outs = adj.get(pairKey(pred, obj)) ?? [];
        for (const [c, from, to, fact] of outs) {
          // No self-loop derivation. `A p A` on a transitive and
          // asymmetric predicate is a contradiction, not knowledge. R0
          // reports it, together with the path around the cycle.
          if (subj === c) {
            continue;
          }
          const ov = overlap([acc.from, acc.to], [from, to]);
          if (!ov) {
            continue;
          }
          emit(
            [pred, subj, c],
            pred,
            Rule.Transitive,
            acc,
            ov[0],
            ov[1],
            fact,
            asserted,
            reached,
            perPred,
            capped,
            out,
            next,
            adj,
          );
        }
      }
    }
    next.sort((a, b) => cmpTriple(a[0], b[0]));
    frontier = next;
  }

  out.capped = Array.from(capped).sort(cmpUuid);
  return out;
}

/**
 * Stores one derived fact and links it into the adjacency map for later
 * transitive steps. Returns true when the predicate has hit its cap.
 *
 * This function takes many parameters, but pulling it out is necessary:
 * the four rules share the same steps (check asserted, check already
 * reached, compute the interval, record the proof, add to the frontier,
 * add to the adjacency map). A past version wrote the symmetric and
 * transitive steps separately, and their skip conditions slowly drifted
 * apart.
 */
function emit(
  t: Triple,
  // The predicate whose declaration triggered this. For all four rules,
  // this is the predicate of the edge being expanded.
  via: Uuid,
  rule: Rule,
  acc: Reached,
  from: number | undefined,
  to: number | undefined,
  // The extra premise used by the transitive rule. The one-hop rules have none.
  extraPremise: Uuid | undefined,
  asserted: Set<string>,
  reached: Map<string, Reached>,
  perPred: Map<Uuid, number>,
  capped: Set<Uuid>,
  out: Derivation,
  next: Array<[Triple, Reached]>,
  adj: Map<string, Hop[]>,
): boolean {
  const [pred, subj, obj] = t;
  // No self-loop derivation, for any rule: `A p A` is a contradiction, not knowledge.
  if (subj === obj) {
    return false;
  }
  const key = tripleKey(pred, subj, obj);
  // Asserted facts come first. An already-derived triple is not derived
  // again. This is what makes mutual inverses converge: when `p⁻¹ = q` and
  // `q⁻¹ = p`, the edge derived on the second round is already in `reached`.
  if (asserted.has(key) || reached.has(key)) {
    return false;
  }
  const n = perPred.get(pred) ?? 0;
  if (n >= MAX_DERIVED_PER_PREDICATE) {
    capped.add(pred);
    return true;
  }
  perPred.set(pred, n + 1);

  const premises = [...acc.premises];
  if (extraPremise !== undefined) {
    premises.push(extraPremise);
  }
  const r: Reached = { from, to, premises: [...premises] };
  reached.set(key, r);
  // A derived edge can also feed the next transitive step.
  const first = premises[0];
  if (first !== undefined) {
    const ak = pairKey(pred, subj);
    const hop: Hop = [obj, from, to, first];
    const list = adj.get(ak);
    if (list) {
      list.push(hop);
    } else {
      adj.set(ak, [hop]);
    }
  }
  out.facts.push({
    predicate: pred,
    via,
    subject: subj,
    object: obj,
    rule,
    premises,
  });
  next.push([t, r]);
  return false;
}

/**
 * Computes the validity interval of a derived fact, for use when storing it.
 *
 * This is separate from `derive` because the intersection is already
 * computed during derivation, and the caller's `Derived` value carries only
 * the premises. Recomputing it here is cheaper than adding the interval to
 * the result, and harder to get wrong: the premises are the facts, and the
 * interval is a function of them.
 */
export function validity(
  premises: Uuid[],
  byFact: Map<Uuid, Span>,
): Span | undefined {
  let acc: Span = [undefined, undefined];
  for (const p of premises) {
    const span = byFact.get(p);
    if (span === undefined) {
      return undefined;
    }
    const next = overlap(acc, span);
    if (next === undefined) {
      return undefined;
    }
    acc = next;
  }
  return acc;
}

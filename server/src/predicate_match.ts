/**
 * Fold a model-spoken predicate onto a relation that already exists in the
 * ontology.
 *
 * Extraction used to compare only the exact key. A miss fell back to a
 * generic fallback predicate, and the original wording waited in
 * `fact_evidence.proposed_predicate` for a human to adopt it later.
 *
 * Measurement showed this missed a lot. On the ai-timeline corpus
 * (Wikipedia AI-company entries), 49.8% of facts fell back, spread over
 * 398 distinct relation names and 895 uses. One whole class of these was
 * not a missing word at all — **the word was already in the ontology; the
 * model only said it backwards or in a different tense**:
 * `produced_by | ChatGPT -> OpenAI` means the existing `produces`, subject
 * and object swapped.
 *
 * That 49.8% number comes from a **test harness that turns automatic
 * ontology extension off** (`run.mjs` creates the KB with
 * `auto_extend_ontology=FALSE`, while the column default is true). The
 * product's real cold-start path is `bootstrap_ontology` filling the
 * ontology in after the fact, so this number does not say the product is
 * bad — it measures "how often a fallback happens when a word is
 * missing", exactly the part this module cuts down.
 *
 * Three extra passes are added here, **in priority order, widest last**:
 *
 * 1. Exact key — the original behavior, unchanged.
 * 2. Spelling alignment — `acquiredFrom` / `acquired_from` / `Acquired
 *    From` are the same word.
 * 3. Inflection folding — `produced` and `produces` fold to the same
 *    string (only tense and number are shaved off; see `inflectBase`).
 *
 * Passes 2 and 3 each try once more with a trailing `by` stripped; a hit
 * there **swaps subject and object**. English marks the passive voice with
 * `_by`, so `X produced_by Y` and `Y produces X` are the same edge.
 *
 * **A collision means no match.** If the ontology has both `produces` and
 * `produced` at once, both fold to the same string — picking either one
 * would be a guess, so it falls back instead and waits for a human to
 * adopt it. Only the exact key is exempt from this, since it is already
 * unique.
 *
 * Measured effect (the same 895 unmatched uses, two vocabularies): the
 * seed ontology's 10 relations recovered 49 uses; schema.org's 629
 * relations recovered 59. Of the 9 recovered wordings, 6 were correct and
 * 3 had a doubtful direction (`addresses->address`, `funds->funding`,
 * `sponsors->sponsor`, one use each) — **all from the plain trailing-`s`
 * path alone**: in English `sponsors` is both a third-person verb and a
 * plural noun, and a suffix rule cannot tell them apart. No extra rule was
 * added for these three: the sample is too small, and a rule here would be
 * overfitting. Their counterfactual is not "correct" either — it is the
 * fallback predicate, with the original word still in
 * `proposed_predicate`.
 *
 * This module does not judge synonyms (`partners_with` vs
 * `collaborates_with`) — that is retrieval's and the model's job. Doing it
 * here would quietly turn "spelling alignment" into "roughly the same
 * meaning", and the second kind of mistake is invisible to everyone.
 */

export interface RelationTypeLike {
  id: string;
  key: string;
  kind: string;
}

/**
 * Splits on non-alphanumeric characters, and also at a lowercase-to-uppercase
 * boundary (camelCase).
 *
 * The camelCase half is not optional: an OWL import's key is literally
 * `acquiredFrom`. Without this split it would never fold together with a
 * hand-written `acquired_from` — and "can an imported ontology actually be
 * used" is exactly what this path exists to protect.
 */
export function words(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let prevIsLowerOrDigit = false;
  for (const c of s) {
    if (!/[a-zA-Z0-9\u00c0-\uffff]/.test(c) || !isAlphanumeric(c)) {
      if (cur !== "") {
        out.push(cur);
        cur = "";
      }
      prevIsLowerOrDigit = false;
      continue;
    }
    const isUpper = c === c.toUpperCase() && c !== c.toLowerCase();
    const isLower = c === c.toLowerCase() && c !== c.toUpperCase();
    const isDigit = c >= "0" && c <= "9";
    if (isUpper && prevIsLowerOrDigit && cur !== "") {
      out.push(cur);
      cur = "";
    }
    prevIsLowerOrDigit = isLower || isDigit;
    cur += c.toLowerCase();
  }
  if (cur !== "") out.push(cur);
  return out;
}

function isAlphanumeric(c: string): boolean {
  return /[a-zA-Z0-9]/.test(c) || /[\p{L}\p{N}]/u.test(c);
}

/**
 * The spelling-alignment form: the split words concatenated with no
 * separator. Same rule as `normalize_name` in the ontology routes.
 */
function joined(ws: string[]): string {
  return ws.join("");
}

/**
 * Inflection folding: shaves off tense and number, **never a derivational
 * suffix**.
 *
 * This once used a Snowball stemmer (`rust-stemmers`); measurement showed
 * that was backwards — with a 10-word vocabulary it recovered 49 uses, and
 * with schema.org's 629 words that dropped to 18. Snowball shaves
 * derivational suffixes too, so `producer` and `produces` both become
 * `produc`, and the collision rule then refuses to match either — **the
 * bigger the vocabulary, the less it dares to move.** And `producer` (a
 * person) and `produces` (an action) really should be two different
 * relations; folding them together is the stemmer's mistake, not the
 * collision rule's.
 *
 * So only inflection is touched: `-ies -> y`, `-ing`, `-ed`, `-s` (except
 * `-ss`), then a trailing `e` is dropped. That last step exists so the
 * `-s` and `-ed` paths converge — `produces -> produce -> produc`,
 * `produced -> produc` — otherwise the same verb's two tenses would never
 * meet.
 *
 * The length guard looks at the result **after** shaving, not partway
 * through. Guarding on a partial result would send the two paths off in
 * different directions: `uses` loses `-s`, leaving three letters (passes),
 * then loses the `e`, leaving two; `used` loses `-ed` and is immediately at
 * two letters (blocked) — so the same verb's two tenses would never line
 * up. Anything left under two letters is not shaved at all (`is` must not
 * become `i`, `led` must not become `l`).
 *
 * Chinese has no inflectional suffixes, so this is an identity
 * transformation for it; no branch on `ontology_lang` is needed.
 */
export function inflectBase(w: string): string {
  const n = w.length;
  let s: string;
  if (w.endsWith("ies") && n > 3) {
    s = `${w.slice(0, n - 3)}y`;
  } else if (w.endsWith("ing") && n > 3) {
    s = w.slice(0, n - 3);
  } else if (w.endsWith("ed") && n > 2) {
    s = w.slice(0, n - 2);
  } else if (w.endsWith("s") && !w.endsWith("ss") && n > 1) {
    s = w.slice(0, n - 1);
  } else {
    s = w;
  }
  if (s.endsWith("e")) {
    s = s.slice(0, -1);
  }
  if ([...s].length < 2) {
    return w;
  }
  return s;
}

/**
 * Leading light verbs: `has_funding` and `funding` are the same relation;
 * the prefix is a naming habit, not a meaning.
 *
 * Measured (ai-timeline-ends x schema.org): among the wordings on
 * predicate-less facts, `has_funding` missed 4 times while the ontology
 * had `funding`; `product` missed 2 times while the ontology had
 * `has_product` — **the only difference is this one prefix.**
 *
 * Only strips when a word remains after stripping — `has` alone is itself,
 * and cannot be stripped to nothing. Over-merging cannot cause a wrong
 * match — `insert` voids any key that lands on two relations (collision
 * voids), so the worst case is falling back to "no match", never matching
 * the wrong one.
 */
const LEADING_AUX = new Set(["has", "have", "had", "is", "are", "was", "were", "be", "been"]);

function stems(ws: string[]): string[] {
  let rest = ws;
  if (ws.length > 1 && LEADING_AUX.has(ws[0]!)) {
    rest = ws.slice(1);
  }
  return rest.map((w) => inflectBase(w));
}

/**
 * A wording's merge key: different tenses of the same relation land on the
 * same key.
 *
 * Used by the ontology-adoption path. Extraction compares a wording
 * against **existing** relations (the three-pass match above); adoption
 * does something different — it first merges wordings that mean the same
 * thing, then counts votes.
 *
 * Skipping this merge costs something visible: after an ai-timeline run,
 * the wordings still stuck on the fallback predicate include `sued` and
 * `sues` as two separate entries (11 and 5 uses), `integrated_with` and
 * `integrates_with` (5 each), and the same for
 * `announced`/`announces`, `supported`/`supports`,
 * `developed`/`develops`. Counted separately, each falls short of the
 * ">=2 documents" threshold; merged, the qualifying candidates rose from
 * 70 groups to 85, and 281 facts to 355.
 *
 * **Prepositions are not merged**: `integrated_with` and `integrated_into`
 * stay two groups. `works_at` and `works_in` may really be two different
 * things; this errs toward missing that merge.
 *
 * **`_by` is also not merged (future work)**: `founded_by` and `founded`
 * are the two directions of the same edge.
 */
export function mergeKey(form: string): string[] {
  return stems(words(form));
}

/** A collision means no match: the same form landing on two different relations means picking either is a guess. */
function insertKey(map: Map<string, string | null>, key: string, id: string): void {
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, id);
  } else if (existing !== id) {
    map.set(key, null);
  }
}

export class PredicateIndex {
  private readonly exact = new Map<string, string>();
  private readonly byJoined = new Map<string, string | null>();
  private readonly byStems = new Map<string, string | null>();

  private constructor() {}

  /**
   * **Only takes `kind === "relation"`.** An attribute goes through the
   * literal-value channel; letting fuzzy matching cross over there would
   * turn `founding_date` into an edge pointing at the entity "2015" —
   * exactly what the ontology-adoption path already blocks on purpose.
   * This must not let it back in through a side door.
   */
  static build(rtypes: RelationTypeLike[]): PredicateIndex {
    const idx = new PredicateIndex();
    for (const r of rtypes) {
      if (r.kind !== "relation") continue;
      idx.exact.set(r.key, r.id);
      const w = words(r.key);
      if (w.length === 0) continue;
      insertKey(idx.byJoined, joined(w), r.id);
      insertKey(idx.byStems, stems(w).join("\u0000"), r.id);
    }
    return idx;
  }

  private widened(w: string[]): string | null {
    if (w.length === 0) return null;
    const hit = this.byJoined.get(joined(w));
    if (hit !== undefined) return hit;
    const stemHit = this.byStems.get(stems(w).join("\u0000"));
    return stemHit ?? null;
  }

  /** Returns [relation id, whether to swap subject and object]. `null` = truly missing from the ontology; fall back. */
  lookup(proposed: string): [string, boolean] | null {
    const exact = this.exact.get(proposed);
    if (exact !== undefined) return [exact, false];

    const w = words(proposed);
    const wide = this.widened(w);
    if (wide !== null) return [wide, false];

    // Passive form: `produced_by` matches `produces` only once `by` is
    // dropped, and subject/object must swap. At least two words are
    // required — a lone `by` shaves to nothing.
    if (w.length >= 2 && w[w.length - 1] === "by") {
      const swapped = this.widened(w.slice(0, -1));
      if (swapped !== null) return [swapped, true];
    }
    return null;
  }
}

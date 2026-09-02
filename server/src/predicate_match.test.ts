import { describe, expect, test } from "bun:test";
import { PredicateIndex, inflectBase, words, type RelationTypeLike } from "./predicate_match";

function rel(key: string): RelationTypeLike {
  return { id: key, key, kind: "relation" };
}

function attr(key: string): RelationTypeLike {
  return { id: key, key, kind: "attribute" };
}

describe("predicate_match", () => {
  // `has_funding` and `funding` are the same relation; the prefix is a
  // naming habit, not a meaning.
  //
  // Measured: each of these missed on its own — the ontology has
  // `funding`, the model wrote `has_funding` (x4); the ontology has
  // `has_product`, the model wrote `product` (x2). Only the prefix differs.
  test("a leading auxiliary does not make a different relation", () => {
    const rels = [rel("funding"), rel("has_product")];
    const idx = PredicateIndex.build(rels);
    expect(idx.lookup("has_funding")).not.toBeNull();
    expect(idx.lookup("product")).not.toBeNull();
    expect(idx.lookup("funding")).not.toBeNull();
    expect(idx.lookup("has_product")).not.toBeNull();
  });

  // **Only strips when a word remains.** `has` alone is itself; stripping
  // it to nothing would make it match everything.
  test("a bare auxiliary is still a word", () => {
    const rels = [rel("has")];
    const idx = PredicateIndex.build(rels);
    expect(idx.lookup("has")).not.toBeNull();
    expect(idx.lookup("owns")).toBeNull();
  });

  // A collision still voids: when the ontology has both `funding` and
  // `has_funding`, picking either is a guess. The worst outcome of
  // over-merging is "no match", never "the wrong match".
  test("folding the prefix never produces a wrong match", () => {
    const rels = [rel("funding"), rel("has_funding")];
    const idx = PredicateIndex.build(rels);
    expect(idx.lookup("funding")).not.toBeNull();
    expect(idx.lookup("has_funding")).not.toBeNull();
    // The collision sits at the **stem** layer: both `funding` and
    // `has_funding` strip to ["funding"] after the prefix. Testing it
    // needs a form that skips spelling alignment and lands on the stem
    // only — `has_fundings` joins to "hasfundings", which the ontology
    // does not have, so it falls to the stem layer and collides.
    expect(idx.lookup("has_fundings")).toBeNull();
  });

  test("splits camel case and separators the same way", () => {
    expect(words("acquiredFrom")).toEqual(["acquired", "from"]);
    expect(words("acquired_from")).toEqual(["acquired", "from"]);
    expect(words("Acquired From")).toEqual(["acquired", "from"]);
    // All-uppercase is not a camelCase boundary; do not split an IRI into i/r/i.
    expect(words("IRI")).toEqual(["iri"]);
    expect(words("gpt4Model")).toEqual(["gpt4", "model"]);
  });

  test("exact key still wins unchanged", () => {
    const types = [rel("produces")];
    const idx = PredicateIndex.build(types);
    expect(idx.lookup("produces")).toEqual([types[0]!.id, false]);
  });

  test("separator and case differences align", () => {
    const types = [rel("acquired_from")];
    const idx = PredicateIndex.build(types);
    expect(idx.lookup("acquiredFrom")).toEqual([types[0]!.id, false]);
    expect(idx.lookup("Acquired From")).toEqual([types[0]!.id, false]);
  });

  test("tense folds without swapping", () => {
    const types = [rel("produces")];
    const idx = PredicateIndex.build(types);
    // The model wrote the past tense; it still means the same edge, same direction.
    expect(idx.lookup("produced")).toEqual([types[0]!.id, false]);
  });

  // This is this module's reason to exist: `ChatGPT produced_by OpenAI`
  // and `OpenAI produces ChatGPT` are the same edge, only subject and
  // object differ.
  test("passive form matches and asks for a swap", () => {
    const types = [rel("produces")];
    const idx = PredicateIndex.build(types);
    expect(idx.lookup("produced_by")).toEqual([types[0]!.id, true]);
    expect(idx.lookup("producedBy")).toEqual([types[0]!.id, true]);
  });

  test("multi word passive matches", () => {
    const types = [rel("invests_in")];
    const idx = PredicateIndex.build(types);
    expect(idx.lookup("invested_in")).toEqual([types[0]!.id, false]);
  });

  // **Derivation is not inflection.** This is the reason Snowball was
  // replaced: schema.org has both `producer` and `produces`, and a
  // stemmer folds both to `produc`, so the collision rule then also
  // rejects `produced` — the bigger the vocabulary, the less it recovers
  // (measured: 49 uses dropped to 18). Shaving only inflectional suffixes
  // avoids this collision: `producer` stays as-is.
  test("derivational forms stay separate from inflected ones", () => {
    const types = [rel("produces"), rel("producer"), rel("production_company")];
    const idx = PredicateIndex.build(types);
    expect(idx.lookup("produced")).toEqual([types[0]!.id, false]);
    expect(idx.lookup("produced_by")).toEqual([types[0]!.id, true]);
    expect(idx.lookup("producer")).toEqual([types[1]!.id, false]);
    // Derived words must not cross into each other either.
    expect(idx.lookup("producers")).toEqual([types[1]!.id, false]);
  });

  // Plural and past-tense paths must converge to the same base, or the
  // same verb's two spellings would never line up.
  test("plural and past forms meet at the same base", () => {
    expect(inflectBase("produces")).toBe(inflectBase("produced"));
    expect(inflectBase("uses")).toBe(inflectBase("used"));
    expect(inflectBase("notes")).toBe(inflectBase("note"));
    expect(inflectBase("studies")).toBe(inflectBase("study"));
    // Short words are not shaved: `is` must not become `i`.
    expect(inflectBase("is")).toBe("is");
    // `-ss` is not a plural.
    expect(inflectBase("address")).toBe(inflectBase("addresses"));
  });

  // A collision would rather not match: when the ontology has both
  // `produces` and `produced`, `producing` folds to the stem shared by
  // both, and picking either is a guess.
  test("ambiguous stem declines rather than guesses", () => {
    const types = [rel("produces"), rel("produced")];
    const idx = PredicateIndex.build(types);
    expect(idx.lookup("producing")).toBeNull();
    // The exact key is unaffected — it is already unique.
    expect(idx.lookup("produces")).toEqual([types[0]!.id, false]);
    expect(idx.lookup("produced")).toEqual([types[1]!.id, false]);
  });

  // Attributes cannot be reached through this path: the object is a
  // literal, so no edge can be formed.
  test("attributes are not reachable", () => {
    const types = [attr("founding_date")];
    const idx = PredicateIndex.build(types);
    expect(idx.lookup("founding_date")).toBeNull();
    expect(idx.lookup("foundingDate")).toBeNull();
  });

  // Genuinely missing vocabulary still falls back — this module does not judge synonyms.
  test("genuinely missing vocabulary still declines", () => {
    const types = [rel("produces"), rel("works_at")];
    const idx = PredicateIndex.build(types);
    expect(idx.lookup("partners_with")).toBeNull();
    expect(idx.lookup("acquired")).toBeNull();
    // A different preposition is a different relation; do not put words in the model's mouth.
    expect(idx.lookup("works_in")).toBeNull();
  });

  test("lone by does not strip to nothing", () => {
    const types = [rel("produces")];
    const idx = PredicateIndex.build(types);
    expect(idx.lookup("by")).toBeNull();
    expect(idx.lookup("_by_")).toBeNull();
  });

  // A Chinese key passing through the stemmer is an identity
  // transformation; it must not be shaved and must not mismatch.
  test("chinese keys pass through", () => {
    const types = [rel("隶属于"), rel("生产")];
    const idx = PredicateIndex.build(types);
    expect(idx.lookup("隶属于")).toEqual([types[0]!.id, false]);
    expect(idx.lookup("生产")).toEqual([types[1]!.id, false]);
    expect(idx.lookup("收购")).toBeNull();
  });
});

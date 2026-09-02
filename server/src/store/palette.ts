/**
 * Entity class colors: a set of hand-picked colors, plus a deterministic
 * **color-by-key** function.
 *
 * ## Why this exists
 *
 * Every auto-created class used to get the same `#8ea5bd` — imported
 * classes, classes built by type resolution, classes seeded when a KB is
 * created, all the same grayish blue. The product already has a
 * curated palette, but it was **only reachable through the manual color
 * picker**. So importing schema.org (1010 classes) produced 1010
 * classes sharing one color, a graph that is one shade of gray.
 *
 * The capability was always there; this module is the missing wire.
 *
 * ## Why a hash, not round-robin
 *
 * Round-robin (the nth class gets the nth color) needs a counter, and
 * classes are created from several different paths (manual, import,
 * resolution, KB seeding), so the counter would have to be shared
 * across all of them — a shared state that can drift out of sync.
 * Hashing by key needs no state: **the same key always gets the same
 * color**, no matter who created it, which number it was, or how many
 * times it has been rebuilt. Re-importing the same ontology never makes
 * the colors jump.
 *
 * ## Why not `DefaultHasher`
 *
 * A language's default hasher typically seeds itself differently **on
 * every process** (to resist hash-collision attacks). Using that for
 * color would mean the same class changes color every time the server
 * restarts — and color is what a user relies on to recognize things.
 * So this hand-writes FNV-1a instead: fixed constants, a fixed result,
 * the same across every process and every machine.
 */

/**
 * The entity class palette. **This set is the existing one, unchanged
 * this time round** — a Morandi palette was tried once and rejected the
 * moment it hit a real graph: low saturation with mid brightness is
 * tuned for paper, and it goes uniformly gray against a near-black
 * canvas, making classes indistinguishable from each other. A dark
 * background needs colors whose saturation can hold up.
 *
 * Changing this list means changing `web/src/ui/index.tsx`'s
 * `ENTITY_PALETTE` too: hand-picked colors and auto-picked colors must
 * come from the same set, or one graph ends up with two different
 * palettes. A test at the end of this file's Rust counterpart guards
 * this; missing that sync makes it fail.
 */
export const ENTITY_PALETTE: readonly string[] = [
  "#7fd0ff",
  "#5fa8ff",
  "#5fd4d0",
  "#63e2b7",
  "#4cc38a",
  "#a8d878",
  "#ffd479",
  "#f2b66d",
  "#ff9d76",
  "#ff8a9e",
  "#ff9daf",
  "#e797d8",
  "#c4a5ff",
  "#9fa8ff",
  "#8ea5bd",
  "#b3b9c4",
];

/**
 * A class's shape: **square = declared in a vocabulary, circle = grown
 * from the corpus**.
 *
 * Every auto-created class used to be hardcoded to `circle` — same
 * story as color: the capability exists (the canvas has
 * `NodeSquareShellProgram`, the legend follows suit), nobody had wired
 * a value into it.
 *
 * Why not hash it like color: shape only has two values, and a hash
 * would make it random — whether `person` is square or circle would
 * mean nothing, just noise. Shape is rare and eye-catching; it should
 * carry a real distinction.
 *
 * Why an IRI and not "a top-level class": "top-level class" sounds more
 * natural, but many knowledge bases have flat classes (everything
 * built by resolution has no parent), which would turn into "everything
 * is square" — just flipping the same problem. Whether something has an
 * IRI is **definite, knowable right now**: an imported vocabulary
 * carries an IRI, something grown from the corpus does not.
 *
 * This is the same thing this product keeps saying: **be explicit about
 * where something came from**. Looking at a graph, it should be
 * immediately obvious which classes were declared in the ontology and
 * which ones grew out of the documents.
 */
export function shapeFor(iri: string): "circle" | "square" {
  return iri.trim().length === 0 ? "circle" : "square";
}

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const AVALANCHE_MULTIPLIER = 0xff51afd7ed558ccdn;
const MASK_64 = 0xffffffffffffffffn;

/**
 * A class's key -> color. The same key always gets the same color.
 *
 * FNV-1a, constants fixed. Never switch to a language default hasher —
 * that reseeds on every process, so the server restarting would change
 * every color, and users rely on color to recognize things.
 */
export function colorForKey(key: string): string {
  let hash = FNV_OFFSET_BASIS;
  const bytes = new TextEncoder().encode(key);
  for (const b of bytes) {
    hash ^= BigInt(b);
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  // Avalanche mix: FNV alone followed by a modulo clusters values —
  // measured in practice, person/project/research_lab collided into
  // the same slot, and eight common keys spread across only five
  // colors. This step folds the high bits into the low bits, and the
  // same eight keys then spread out (the palette length is not prime,
  // so the low bits alone do not carry much information).
  hash ^= hash >> 33n;
  hash = (hash * AVALANCHE_MULTIPLIER) & MASK_64;
  hash ^= hash >> 33n;
  const idx = Number(hash % BigInt(ENTITY_PALETTE.length));
  return ENTITY_PALETTE[idx]!;
}

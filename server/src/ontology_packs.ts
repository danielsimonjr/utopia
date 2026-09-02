/**
 * Preset ontology packs: the starting point offered at KB creation time.
 *
 * A new KB starts with nothing pre-loaded (see the Rust side's
 * `docs/decisions/0008` through `0011`), so these packs are the *only*
 * source of ontology unless someone writes classes by hand. schema.org
 * comes first in the recommended order: it declares domain + range on
 * 1488 of its 1521 properties, and the extraction prompt uses that
 * signature to fix argument order, not just to hint at it.
 *
 * Files ship gzip-compressed under `server/packs/`. `bytes()` decompresses
 * with `Bun.gunzipSync` on demand — this runs once per KB creation, not a
 * hot path, so nothing is decompressed and kept resident.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AppError } from "./core/errors";

export type Pack = {
  id: string;
  name: string;
  summary: string;
  /** Filename handed to the (future) OWL importer. Format is decided by the extension, so this must keep the real suffix. */
  filename: string;
  classes: number;
  properties: number;
  /** Path to the gzip-compressed source file. */
  gzPath: string;
};

const PACKS_DIR = join(import.meta.dir, "..", "packs");

export const PACKS: Pack[] = [
  {
    id: "schema-org",
    name: "schema.org",
    summary: "People, organizations, products, events, creative works",
    filename: "schema-org.ttl",
    classes: 1010,
    properties: 1676,
    gzPath: join(PACKS_DIR, "schema-org.ttl.gz"),
  },
  {
    id: "w3c-org",
    name: "W3C Org",
    summary: "Departments, posts, memberships, reporting lines",
    filename: "w3c-org.ttl",
    classes: 13,
    properties: 34,
    gzPath: join(PACKS_DIR, "w3c-org.ttl.gz"),
  },
  {
    id: "prov-o",
    name: "PROV-O",
    summary: "Provenance: who produced what, when, from which source",
    filename: "prov-o.ttl",
    classes: 49,
    properties: 69,
    gzPath: join(PACKS_DIR, "prov-o.ttl.gz"),
  },
  {
    id: "foaf",
    name: "FOAF",
    summary: "People and social relations",
    filename: "foaf.rdf",
    classes: 12,
    properties: 62,
    gzPath: join(PACKS_DIR, "foaf.rdf.gz"),
  },
  {
    id: "iof-core",
    name: "IOF Core",
    summary: "Industrial manufacturing",
    filename: "iof-core.rdf",
    classes: 294,
    properties: 75,
    gzPath: join(PACKS_DIR, "iof-core.rdf.gz"),
  },
];

export function get(id: string): Pack | undefined {
  return PACKS.find((p) => p.id === id);
}

/** Decompresses a pack's source text. Reads and decompresses fresh each call — building a KB is rare, this is not worth keeping resident. */
export function bytes(pack: Pack): Uint8Array {
  try {
    const gz = readFileSync(pack.gzPath);
    return Bun.gunzipSync(gz);
  } catch (e) {
    throw AppError.other(`Failed to decompress ontology pack ${pack.id}: ${String(e)}`);
  }
}

/**
 * How a same-named wording between two starter ontology packs is handled.
 *
 * On a key collision, `owl_import`'s default is `keyTaken` — skip and
 * report, never silently add a suffix. That rule exists for a GUESSED
 * suffix ("a re-import cannot recognize which one it built last time");
 * this module carries a DECLARED disposition instead, and a re-import
 * gets the same result either way, so that rule does not apply to it.
 *
 * Why this exists: the starter packs collide by name in about 20 places,
 * and they fall into two different cases —
 *
 * - `org:Organization` and `schema:Organization` are THE SAME THING;
 *   skipping is correct, but it should not be reported as "a conflict"
 *   for the user to resolve when there is nothing to resolve.
 * - `org:role` (a post inside an organization) and `schema:role` (the
 *   part an actor plays) are MERELY SAME-NAMED; skipping would throw
 *   away the entire reason W3C Org exists.
 *
 * Only covers the starter packs. A vocabulary a user imports by hand is
 * not in here — that is a deliberate choice, and a collision there
 * should be reported for a person to see.
 */

/** How a same-named wording is handled. */
export type Alignment = { kind: "sameAs" } | { kind: "rename"; key: string };

/**
 * (incoming IRI, IRI already occupying the key) -> disposition.
 *
 * Alignments the upstream vocabularies declare themselves are copied
 * first: W3C Org's own docs declare a correspondence with FOAF, and
 * PROV-O declares one with FOAF and Dublin Core. Only the collisions
 * that actually happen between our own packs are recorded here.
 */
const TABLE: readonly [string, string, Alignment][] = [
  // -- W3C Org x schema.org --------------------------------------------
  ["http://www.w3.org/ns/org#Organization", "https://schema.org/Organization", { kind: "sameAs" }],
  ["http://www.w3.org/ns/org#identifier", "https://schema.org/identifier", { kind: "sameAs" }],
  ["http://www.w3.org/ns/org#location", "https://schema.org/location", { kind: "sameAs" }],
  // org:Role is "the role a post carries" (paired with Post, Membership);
  // schema:role is the part an actor plays in a creative work. Same name, unrelated.
  ["http://www.w3.org/ns/org#Role", "https://schema.org/Role", { kind: "rename", key: "org_role" }],
  // org:member is a membership with a term (reified through Membership);
  // schema:member is a generic affiliation. Different granularity, keep both.
  ["http://www.w3.org/ns/org#member", "https://schema.org/member", { kind: "rename", key: "org_member" }],
  [
    "http://www.w3.org/ns/org#memberOf",
    "https://schema.org/memberOf",
    { kind: "rename", key: "org_member_of" },
  ],
  // -- PROV-O x schema.org ----------------------------------------------
  // prov:Agent is a SUPERCLASS of Person and Organization, not a synonym.
  // Calling it sameAs would erase that abstraction layer entirely.
  ["http://www.w3.org/ns/prov#Agent", "https://schema.org/agent", { kind: "rename", key: "prov_agent" }],
  // -- FOAF x schema.org --------------------------------------------------
  ["http://xmlns.com/foaf/0.1/Person", "https://schema.org/Person", { kind: "sameAs" }],
  ["http://xmlns.com/foaf/0.1/Organization", "https://schema.org/Organization", { kind: "sameAs" }],
  ["http://xmlns.com/foaf/0.1/Project", "https://schema.org/Project", { kind: "sameAs" }],
  ["http://xmlns.com/foaf/0.1/name", "https://schema.org/name", { kind: "sameAs" }],
  ["http://xmlns.com/foaf/0.1/knows", "https://schema.org/knows", { kind: "sameAs" }],
  ["http://xmlns.com/foaf/0.1/givenName", "https://schema.org/givenName", { kind: "sameAs" }],
  ["http://xmlns.com/foaf/0.1/familyName", "https://schema.org/familyName", { kind: "sameAs" }],
  ["http://xmlns.com/foaf/0.1/gender", "https://schema.org/gender", { kind: "sameAs" }],
  ["http://xmlns.com/foaf/0.1/logo", "https://schema.org/logo", { kind: "sameAs" }],
  ["http://xmlns.com/foaf/0.1/thumbnail", "https://schema.org/thumbnail", { kind: "sameAs" }],
  ["http://xmlns.com/foaf/0.1/title", "https://schema.org/title", { kind: "sameAs" }],
  ["http://xmlns.com/foaf/0.1/member", "https://schema.org/member", { kind: "sameAs" }],
  // foaf:Agent and prov:Agent are synonyms (that is PROV-O's own official
  // alignment), but neither equals schema:agent.
  ["http://xmlns.com/foaf/0.1/Agent", "https://schema.org/agent", { kind: "rename", key: "foaf_agent" }],
  // foaf:status is an instant-messaging-era presence value; schema:status is an order/action status.
  ["http://xmlns.com/foaf/0.1/status", "https://schema.org/status", { kind: "rename", key: "foaf_status" }],
];

/** Looked up on a key collision. Returns `null` when neither IRI is in the starter packs, and the caller falls back to `keyTaken` as before. */
export function lookup(incomingIri: string, existingIri: string): Alignment | null {
  const hit = TABLE.find(([a, b]) => a === incomingIri && b === existingIri);
  return hit ? hit[2] : null;
}

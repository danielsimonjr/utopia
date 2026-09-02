/**
 * OWL / RDFS file parsing and PROJECTION.
 *
 * The work is split into layers (see decision 0001): this module does
 * only the second layer (projection). The first layer (keeping the
 * original bytes verbatim) is the caller's job. What this module cannot
 * read is not an error, it is "not yet projected" — the original file
 * stays intact, and re-running later picks up anything we later learn to
 * read.
 *
 * This module only parses; it does not reason. It hands back triples and
 * we pick out the ones we can use. We do not implement full OWL
 * reasoning here — that is a different concern, and it reads the
 * original file, not the projection.
 */

import { Parser as TurtleParser } from "n3";
import sax from "sax";

/** One projected class. */
export type OwlClass = {
  iri: string;
  /** A short label derived from the IRI (the token the model reads and writes). The caller de-duplicates and suffixes it. */
  key: string;
  label: string;
  /** `rdfs:comment` — a load-bearing field, copied verbatim into the extraction prompt. */
  description: string;
  /** Every parent IRI from `rdfs:subClassOf` (multiple inheritance is common here). */
  parents: string[];
  /**
   * The other side of every `owl:disjointWith`. Both directions are kept
   * here — the axiom is symmetric, and a vocabulary usually states it
   * only once.
   */
  disjointWith: string[];
};

/** One projected property (an object property becomes a relation, a datatype property becomes an attribute). */
export type OwlProperty = {
  iri: string;
  key: string;
  label: string;
  description: string;
  /** true = the attribute channel (a literal value), false = the relation channel. */
  isDatatype: boolean;
  functional: boolean;
  inverseFunctional: boolean;
  /** OWL property axioms. Consistency checking relies on these — without them there is no way to tell whether `A part_of B` and `B part_of A` both holding is a contradiction or normal. */
  transitive: boolean;
  symmetric: boolean;
  asymmetric: boolean;
  irreflexive: boolean;
  /** The other side of `owl:inverseOf`. Kept only in the direction written — the reverse is filled in later, where reasoning happens, not here. */
  inverseOf: string | null;
  /** The parent property from `rdfs:subPropertyOf`. Only the first one is kept when there are several. */
  subPropertyOf: string | null;
  domains: string[];
  ranges: string[];
  /**
   * Whether several `ranges` entries are a union or an intersection.
   * `rdfs:range` written more than once is an intersection ("must be
   * both"); `schema:rangeIncludes` written more than once is a union
   * ("either is fine"). Losing this bit turns
   * `author rangeIncludes Organization, Person` into "must be both an
   * organization and a person", degrading a real edge away.
   */
  rangesUnion: boolean;
};

/** The IRI of a datatype this vocabulary declares itself, mapped to one of our four kinds. */
export type VocabDatatypes = Map<string, DatatypeKind>;

export type DatatypeKind = "text" | "number" | "date" | "bool";

/** The result of one parse. `unprojected` is a REPORT, not an error — see the module doc. */
export type OwlProjection = {
  classes: OwlClass[];
  properties: OwlProperty[];
  /** A predicate we saw but do not consume today, mapped to how many times. For the "not yet projected" panel in the preview. */
  unprojected: Map<string, number>;
  /** The total triple count, so someone can tell how big the file is. */
  triples: number;
  vocabDatatypes: VocabDatatypes;
};

const RDF_NS = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const RDF_TYPE = `${RDF_NS}type`;
const RDFS = "http://www.w3.org/2000/01/rdf-schema#";
const OWL = "http://www.w3.org/2002/07/owl#";
const XSD = "http://www.w3.org/2001/XMLSchema#";
const XML_NS = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NS = "http://www.w3.org/2000/xmlns/";

/**
 * schema.org's own domain/range vocabulary. It is NOT a standard
 * vocabulary, so it is hard-coded here — but it is worth recognizing:
 * schema.org and its derivatives declare not one `rdfs:domain`, so
 * ignoring these two predicates would treat its whole type system as
 * unseen — over 1,600 properties would all become unconstrained
 * relations. Both schemes are recognized: the same vocabulary is
 * published under https and http at different times.
 */
const SCHEMA_NS = ["https://schema.org/", "http://schema.org/"];

function isSchema(iri: string, local: string): boolean {
  return SCHEMA_NS.some((ns) => iri.length === ns.length + local.length && iri.startsWith(ns) && iri.endsWith(local));
}

/**
 * The supported input formats. v1 handles only these two — most Protégé
 * exports use one of them. OWL/XML and Manchester syntax are cut on
 * purpose (see decision 0001, P2, "cut for v1").
 */
export type RdfFormat = "turtle" | "rdfxml";

export const RdfFormat = {
  /**
   * The extension is a strong signal; the content overrides it only when
   * they plainly disagree.
   *
   * This used to run the other way (fall back to Turtle when a `.rdf`
   * file did not look like XML), and FOAF's own file broke it: it opens
   * with dozens of lines of `<!--` comments, so `<rdf:` sits outside the
   * sniff window, and the file was sent to the Turtle parser and failed
   * on the first line with "Invalid IRI code point".
   */
  detect(filename: string, bytes: Uint8Array): RdfFormat {
    const lower = filename.toLowerCase();
    const looksTurtle = looksLikeTurtle(bytes);
    if (lower.endsWith(".ttl") || lower.endsWith(".turtle") || lower.endsWith(".n3")) {
      return "turtle";
    }
    if (lower.endsWith(".rdf") || lower.endsWith(".owl") || lower.endsWith(".xml")) {
      // Both encodings are common for `.owl` — content decides, but only
      // when it genuinely looks like Turtle.
      return looksTurtle ? "turtle" : "rdfxml";
    }
    return looksTurtle ? "turtle" : "rdfxml";
  },
};

/** Turtle's fingerprint is hard to fake: only Turtle opens with `@prefix` / `@base` / `PREFIX`. */
function looksLikeTurtle(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 4096))).toString("utf8");
  for (const rawLine of head.split(/\r?\n/)) {
    const line = rawLine.replace(/^\s+/, "");
    if (line === "" || line.startsWith("#")) continue;
    return (
      line.startsWith("@prefix") ||
      line.startsWith("@base") ||
      line.startsWith("PREFIX") ||
      line.startsWith("BASE")
    );
  }
  return false;
}

/** The in-between shape of a triple: only the part we know how to read. */
type Triple = {
  subject: string;
  predicate: string;
  /** Set when the object is an IRI. */
  objectIri?: string;
  /** Set when the object is a literal (value, language tag). */
  objectLit?: { value: string; lang?: string };
};

/** A synthetic base IRI. See the RDF/XML reader below for why one is needed even with no document URL. */
const BASE = "urn:utopia:import";

function readTriples(bytes: Uint8Array, format: RdfFormat): Triple[] {
  return format === "turtle" ? readTriplesTurtle(bytes) : readTriplesRdfXml(bytes);
}

function readTriplesTurtle(bytes: Uint8Array): Triple[] {
  const text = Buffer.from(bytes).toString("utf8");
  const parser = new TurtleParser({ baseIRI: BASE });
  let quads;
  try {
    quads = parser.parse(text);
  } catch (e) {
    throw new Error(`Turtle parse error: ${(e as Error).message}`);
  }
  const out: Triple[] = [];
  for (const q of quads) {
    if (q.subject.termType === "BlankNode") continue; // See readTriplesRdfXml: blank subjects are not projected.
    const subject = q.subject.value;
    const predicate = q.predicate.value;
    if (q.object.termType === "NamedNode") {
      out.push({ subject, predicate, objectIri: q.object.value });
    } else if (q.object.termType === "Literal") {
      const lang = q.object.language || undefined;
      out.push({ subject, predicate, objectLit: { value: q.object.value, lang } });
    } else {
      out.push({ subject, predicate });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// RDF/XML reading
//
// This is a deliberately small reader, not a general RDF/XML processor:
// it understands `rdf:about`/`rdf:ID` subjects, the typed-node shorthand,
// attribute-abbreviated literal properties, `rdf:resource` /
// `rdf:nodeID` property values, and one level of nested resource
// descriptions. `rdf:parseType="Collection"` list items are read as
// plain nested resources rather than as a proper RDF list — the
// predicates that matter to `project()` never appear inside one, so the
// only cost is an extra, harmless "unprojected" count.
// ---------------------------------------------------------------------------

let blankCounter = 0;

function readTriplesRdfXml(bytes: Uint8Array): Triple[] {
  let text = Buffer.from(bytes).toString("utf8");
  const entities = collectDtdEntities(text);
  text = stripDoctype(text);
  text = expandCustomEntities(text, entities);

  const triples: Triple[] = [];
  const pushTriple = (subject: string, predicate: string, object: { iri?: string; lit?: { value: string; lang?: string } }) => {
    if (subject.startsWith("_:")) return; // A blank subject cannot be re-identified later, so it is not worth projecting.
    triples.push({ subject, predicate, objectIri: object.iri, objectLit: object.lit });
  };

  type SaxTag = { name: string; uri: string; local: string; attributes: Record<string, { name: string; value: string; uri: string; local: string }> };
  type Frame =
    | { kind: "root"; base: string }
    | { kind: "node"; subject: string; base: string; lang?: string }
    | { kind: "prop"; subject: string; predicate: string; base: string; lang?: string; text: string; sawChildElement: boolean }
    | { kind: "ignore" };

  const findAttr = (tag: SaxTag, uri: string, local: string) =>
    Object.values(tag.attributes).find((a) => a.uri === uri && a.local === local);

  const resolveIri = (value: string, base: string): string => {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return value;
    try {
      return new URL(value, base).toString();
    } catch {
      return value;
    }
  };

  const resolveSubject = (tag: SaxTag, base: string): string => {
    const about = findAttr(tag, RDF_NS, "about");
    if (about) return resolveIri(about.value, base);
    const id = findAttr(tag, RDF_NS, "ID");
    if (id) return resolveIri(`#${id.value}`, base);
    const nodeId = findAttr(tag, RDF_NS, "nodeID");
    if (nodeId) return `_:${nodeId.value}`;
    blankCounter += 1;
    return `_:b${blankCounter}`;
  };

  const RESERVED_RDF_ATTRS = new Set(["about", "ID", "nodeID", "resource", "parseType", "datatype"]);

  const emitTypeAndAttrs = (tag: SaxTag, subject: string, lang: string | undefined) => {
    if (subject.startsWith("_:")) return;
    if (!(tag.uri === RDF_NS && tag.local === "Description")) {
      pushTriple(subject, RDF_TYPE, { iri: tag.uri + tag.local });
    }
    for (const attr of Object.values(tag.attributes)) {
      if (attr.uri === RDF_NS && RESERVED_RDF_ATTRS.has(attr.local)) continue;
      if (attr.uri === XML_NS) continue;
      if (attr.uri === XMLNS_NS || attr.uri === "") continue;
      pushTriple(subject, attr.uri + attr.local, { lit: { value: attr.value, lang } });
    }
  };

  const stack: Frame[] = [{ kind: "root", base: BASE }];

  const parser = sax.parser(true, { xmlns: true, trim: false });
  parser.onerror = () => parser.resume();

  parser.onopentag = (node) => {
    const tag = node as unknown as SaxTag;
    const top = stack[stack.length - 1]!;
    const xmlBaseAttr = findAttr(tag, XML_NS, "base");
    const xmlLangAttr = findAttr(tag, XML_NS, "lang");

    if (top.kind === "root") {
      const base = xmlBaseAttr ? resolveIri(xmlBaseAttr.value, top.base) : top.base;
      // The `<rdf:RDF>` wrapper is not itself a node element — it only
      // carries namespace declarations and (sometimes) `xml:base`. Its
      // children are the top-level node elements.
      if (tag.uri === RDF_NS && tag.local === "RDF") {
        stack.push({ kind: "root", base });
        return;
      }
      const subject = resolveSubject(tag, base);
      const lang = xmlLangAttr?.value;
      emitTypeAndAttrs(tag, subject, lang);
      stack.push({ kind: "node", subject, base, lang });
      return;
    }
    if (top.kind === "node") {
      const base = xmlBaseAttr ? resolveIri(xmlBaseAttr.value, top.base) : top.base;
      const predicate = tag.uri + tag.local;
      const resourceAttr = findAttr(tag, RDF_NS, "resource");
      const nodeIdAttr = findAttr(tag, RDF_NS, "nodeID");
      if (resourceAttr) {
        pushTriple(top.subject, predicate, { iri: resolveIri(resourceAttr.value, base) });
        stack.push({ kind: "ignore" });
      } else if (nodeIdAttr) {
        pushTriple(top.subject, predicate, {});
        stack.push({ kind: "ignore" });
      } else {
        stack.push({
          kind: "prop",
          subject: top.subject,
          predicate,
          base,
          lang: xmlLangAttr?.value ?? top.lang,
          text: "",
          sawChildElement: false,
        });
      }
      return;
    }
    if (top.kind === "prop") {
      top.sawChildElement = true;
      const base = xmlBaseAttr ? resolveIri(xmlBaseAttr.value, top.base) : top.base;
      const childSubject = resolveSubject(tag, base);
      if (childSubject.startsWith("_:")) {
        pushTriple(top.subject, top.predicate, {});
      } else {
        pushTriple(top.subject, top.predicate, { iri: childSubject });
      }
      emitTypeAndAttrs(tag, childSubject, xmlLangAttr?.value);
      stack.push({ kind: "node", subject: childSubject, base, lang: xmlLangAttr?.value });
      return;
    }
    // "ignore" frames (an element already fully described by rdf:resource/rdf:nodeID) nest as "ignore" too.
    stack.push({ kind: "ignore" });
  };

  parser.ontext = (t) => {
    const top = stack[stack.length - 1];
    if (top?.kind === "prop") top.text += t;
  };

  parser.onclosetag = () => {
    const top = stack.pop();
    if (top?.kind === "prop" && !top.sawChildElement) {
      const value = top.text.trim();
      if (value !== "") {
        pushTriple(top.subject, top.predicate, { lit: { value, lang: top.lang } });
      }
    }
  };

  parser.write(text).close();
  return triples;
}

/** Reads `<!ENTITY name "value">` declarations from an internal DTD subset. */
function collectDtdEntities(text: string): Map<string, string> {
  const entities = new Map<string, string>();
  const re = /<!ENTITY\s+([A-Za-z_][\w.-]*)\s+"([^"]*)"\s*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) entities.set(m[1]!, m[2]!);
  return entities;
}

/** Cuts the `<!DOCTYPE ...>` declaration out, with or without an internal subset. */
function stripDoctype(text: string): string {
  const start = text.indexOf("<!DOCTYPE");
  if (start === -1) return text;
  const bracketStart = text.indexOf("[", start);
  const firstGt = text.indexOf(">", start);
  if (bracketStart !== -1 && (firstGt === -1 || bracketStart < firstGt)) {
    const bracketEnd = text.indexOf("]>", bracketStart);
    if (bracketEnd !== -1) return text.slice(0, start) + text.slice(bracketEnd + 2);
  }
  if (firstGt !== -1) return text.slice(0, start) + text.slice(firstGt + 1);
  return text;
}

const PREDEFINED_XML_ENTITIES = new Set(["amp", "lt", "gt", "quot", "apos"]);

/** Expands `&name;` references declared by the DTD. The five predefined XML entities are left for the XML parser itself. */
function expandCustomEntities(text: string, entities: Map<string, string>): string {
  if (entities.size === 0) return text;
  return text.replace(/&([A-Za-z_][\w.-]*);/g, (whole, name: string) => {
    if (PREDEFINED_XML_ENTITIES.has(name)) return whole;
    return entities.get(name) ?? whole;
  });
}

/** Parses and projects. Language tags prefer `@en`/`@zh`, then no tag, then whichever comes first. */
export function project(bytes: Uint8Array, format: RdfFormat): OwlProjection {
  const triples = readTriples(bytes, format);
  const proj: OwlProjection = { classes: [], properties: [], unprojected: new Map(), triples: triples.length, vocabDatatypes: new Map() };

  // First pass: sort out who is a class, an object property, a datatype
  // property, or carries a functional-style marker.
  const classes = new Set<string>();
  const objProps = new Set<string>();
  const dataProps = new Set<string>();
  const functional = new Set<string>();
  const inverseFunctional = new Set<string>();
  const transitive = new Set<string>();
  const symmetric = new Set<string>();
  // Two relations between properties (not a type declaration, so kept separately).
  const inverseOf = new Map<string, string>();
  const subPropertyOf = new Map<string, string>();
  const asymmetric = new Set<string>();
  const irreflexive = new Set<string>();
  const plainProps = new Set<string>();
  const datatypeRoots = new Set<string>();

  for (const t of triples) {
    if (t.predicate !== RDF_TYPE) continue;
    const o = t.objectIri;
    if (o === undefined) continue;
    if (o === `${OWL}Class` || o === `${RDFS}Class`) {
      classes.add(t.subject);
    } else if (o === `${OWL}ObjectProperty`) {
      objProps.add(t.subject);
    } else if (o === `${OWL}DatatypeProperty`) {
      dataProps.add(t.subject);
    } else if (o === `${RDF_NS}Property`) {
      // rdf:Property does NOT say object or datatype. Kept apart from an
      // explicit owl:ObjectProperty: that one HAS said something and must
      // not be overruled by range; this one has said nothing, so range
      // decides below, and falls back to "relation" when range says
      // nothing either.
      plainProps.add(t.subject);
    } else if (o === `${OWL}FunctionalProperty`) {
      functional.add(t.subject);
    } else if (o === `${OWL}InverseFunctionalProperty`) {
      inverseFunctional.add(t.subject);
    } else if (o === `${OWL}TransitiveProperty`) {
      transitive.add(t.subject);
    } else if (o === `${OWL}SymmetricProperty`) {
      symmetric.add(t.subject);
    } else if (o === `${OWL}AsymmetricProperty`) {
      asymmetric.add(t.subject);
    } else if (o === `${OWL}IrreflexiveProperty`) {
      irreflexive.add(t.subject);
    } else if (isSchema(o, "DataType")) {
      // A vocabulary reporting its own datatypes. The marker class itself
      // is also collected: schema:DataType is declared `a rdfs:Class`,
      // and skipping this would leave a stray entity type named
      // `data_type`, and it lets `rdfs:subClassOf schema:DataType` reach
      // this set too.
      datatypeRoots.add(t.subject);
      datatypeRoots.add(o);
    }
  }

  const labels = new Map<string, [string, string | undefined][]>();
  const comments = new Map<string, [string, string | undefined][]>();
  const parents = new Map<string, string[]>();
  const disjoint = new Map<string, string[]>();
  const domains = new Map<string, string[]>();
  const ranges = new Map<string, string[]>();
  const unionRanged = new Set<string>();

  const push = <K, V>(map: Map<K, V[]>, key: K, value: V) => {
    const arr = map.get(key);
    if (arr) arr.push(value);
    else map.set(key, [value]);
  };

  const isKnown = (p: string): boolean =>
    p === RDF_TYPE ||
    p === `${RDFS}label` ||
    p === `${RDFS}comment` ||
    p === `${RDFS}subClassOf` ||
    p === `${RDFS}subPropertyOf` ||
    p === `${RDFS}domain` ||
    p === `${RDFS}range` ||
    isSchema(p, "domainIncludes") ||
    isSchema(p, "rangeIncludes") ||
    p === `${OWL}disjointWith` ||
    p === `${OWL}inverseOf`;

  for (const t of triples) {
    const p = t.predicate;
    if (p === `${RDFS}label`) {
      if (t.objectLit) push(labels, t.subject, [t.objectLit.value, t.objectLit.lang]);
    } else if (p === `${RDFS}comment`) {
      if (t.objectLit) push(comments, t.subject, [t.objectLit.value, t.objectLit.lang]);
    } else if (p === `${OWL}disjointWith`) {
      // Both directions are recorded. `owl:disjointWith` is symmetric,
      // and a vocabulary usually states it only once (W3C Org states its
      // four mutually-exclusive classes in six lines, not twelve).
      // Recording only the written direction would make "are A and B
      // disjoint" depend on which end the caller happens to ask from.
      if (t.objectIri) {
        push(disjoint, t.subject, t.objectIri);
        push(disjoint, t.objectIri, t.subject);
      }
    } else if (p === `${OWL}inverseOf`) {
      // Kept only in the direction written. OWL says `p owl:inverseOf q`
      // implies the reverse too, and a vocabulary usually states it only
      // once. Filling in the reverse here (instead of where reasoning
      // happens, in `reasoning::axioms`) would blur "what the ontology
      // itself states" together with "what we inferred" — and one
      // consistency check needs exactly that distinction.
      if (t.objectIri && !inverseOf.has(t.subject)) inverseOf.set(t.subject, t.objectIri);
    } else if (p === `${RDFS}subPropertyOf`) {
      // This predicate used to sit only in the `isKnown()` allow-list —
      // recognized, silenced, and then DISCARDED. Importing an ontology
      // with `subPropertyOf` used to lose that information on the spot,
      // with no sign anything was dropped.
      if (t.objectIri && !subPropertyOf.has(t.subject)) subPropertyOf.set(t.subject, t.objectIri);
    } else if (p === `${RDFS}subClassOf`) {
      if (t.objectIri) push(parents, t.subject, t.objectIri);
    } else if (p === `${RDFS}domain`) {
      if (t.objectIri) push(domains, t.subject, t.objectIri);
    } else if (p === `${RDFS}range`) {
      if (t.objectIri) push(ranges, t.subject, t.objectIri);
    } else if (isSchema(p, "domainIncludes")) {
      // domainIncludes is a union ("usable on any of these types"), and
      // our domain list is already union semantics (the signature
      // `person|organization`), so it goes straight in.
      if (t.objectIri) push(domains, t.subject, t.objectIri);
    } else if (isSchema(p, "rangeIncludes")) {
      if (t.objectIri) {
        push(ranges, t.subject, t.objectIri);
        unionRanged.add(t.subject);
      }
    } else if (!isKnown(p)) {
      // Reported, not discarded — the preview needs to say plainly
      // "here is what this file has that we do not consume yet".
      proj.unprojected.set(p, (proj.unprojected.get(p) ?? 0) + 1);
    }
  }

  // The datatype closure: the roots are the ones explicitly `a
  // schema:DataType`; subclasses inherit it down `subClassOf` (Integer ⊂
  // Number, URL ⊂ Text). WHICH IRIs are datatypes is stated by the file
  // itself; the only hard-coded part is "which of our four kinds this
  // datatype's NAME corresponds to" — that half cannot be read out of RDF.
  const datatypeClasses = new Set(datatypeRoots);
  for (;;) {
    const grown: string[] = [];
    for (const [child, ps] of parents) {
      if (!datatypeClasses.has(child) && ps.some((p) => datatypeClasses.has(p))) grown.push(child);
    }
    if (grown.length === 0) break;
    for (const g of grown) datatypeClasses.add(g);
  }
  for (const iri of datatypeClasses) {
    const dt = nameDatatype(iri, parents, datatypeClasses);
    if (dt) proj.vocabDatatypes.set(iri, dt);
  }

  for (const iri of classes) {
    // A datatype is not an entity type. schema:Text is declared `a
    // rdfs:Class, schema:DataType`; looking only at the first half would
    // build entity types named `text`, `number`, `boolean`.
    if (datatypeClasses.has(iri)) continue;
    const disjointList = [...new Set(disjoint.get(iri) ?? [])].sort();
    proj.classes.push({
      iri,
      key: keyFromIri(iri),
      label: pickLang(labels.get(iri)) ?? localName(iri),
      description: pickLang(comments.get(iri)) ?? "",
      parents: parents.get(iri) ?? [],
      disjointWith: disjointList,
    });
  }

  // A UNION, not two sets appended one after the other: vocabularies
  // often declare the same property as both `rdf:Property` and
  // `owl:DatatypeProperty` at once (FOAF does this for name, age, nick,
  // and more) — collecting each set separately and chaining them would
  // report it twice. Classification only needs `dataProps`.
  const allProps = new Set([...objProps, ...dataProps, ...plainProps]);
  for (const iri of allProps) {
    const rs = ranges.get(iri) ?? [];
    // Relation channel or attribute channel. An explicit declaration
    // wins; with none, range decides: ONLY "every range entry is a
    // datatype" counts as an attribute. A union with even one class in
    // it stays a relation — `address`'s range is `PostalAddress|Text`,
    // and calling it an attribute would drop that edge for good, while a
    // relation can always fall back to a plain string later. The rich
    // side can degrade; the poor side cannot un-degrade.
    let isDatatype: boolean;
    if (dataProps.has(iri)) isDatatype = true;
    else if (objProps.has(iri)) isDatatype = false;
    else isDatatype = rs.length > 0 && rs.every((r) => datatypeClasses.has(r));

    proj.properties.push({
      iri,
      key: keyFromIri(iri),
      label: pickLang(labels.get(iri)) ?? localName(iri).replace(/_/g, " "),
      description: pickLang(comments.get(iri)) ?? "",
      isDatatype,
      functional: functional.has(iri),
      inverseFunctional: inverseFunctional.has(iri),
      transitive: transitive.has(iri),
      symmetric: symmetric.has(iri),
      asymmetric: asymmetric.has(iri),
      inverseOf: inverseOf.get(iri) ?? null,
      subPropertyOf: subPropertyOf.get(iri) ?? null,
      irreflexive: irreflexive.has(iri),
      domains: domains.get(iri) ?? [],
      ranges: rs,
      rangesUnion: unionRanged.has(iri),
    });
  }

  orderByHomeNamespace(proj);
  return proj;
}

/**
 * Moves THIS FILE'S OWN vocabulary to the front.
 *
 * A key collision is decided first-come-first-served by the caller (the
 * `claimed` set in `owl_import::plan`), and "first" used to mean
 * lexicographic order over the IRI — so `http://` sorted ahead of
 * `https://`, and a small vocabulary being merely referenced would
 * systematically beat the file's main one. In the schema.org file, 50
 * namespaces are merged in; the main vocabulary declares 94% of the
 * terms, yet lost 114 of 141 collisions: `location` lost to OMG Commons,
 * `country` lost to unece.org, `organization` lost to purl.org — exactly
 * the terms most worth keeping.
 *
 * The criterion is: the namespace declaring the MOST terms is the file's
 * owner — this does not special-case the name "schema.org", so it works
 * for any vocabulary. Ties break on the lexicographically smaller
 * namespace, so the result is reproducible.
 */
function orderByHomeNamespace(proj: OwlProjection): void {
  const counts = new Map<string, number>();
  for (const iri of [...proj.classes.map((c) => c.iri), ...proj.properties.map((p) => p.iri)]) {
    const ns = namespaceOf(iri);
    counts.set(ns, (counts.get(ns) ?? 0) + 1);
  }
  let home: string | null = null;
  let homeCount = -1;
  // Ties keep the lexicographically SMALLER namespace: iterate in sorted
  // key order and only replace on a strictly greater count.
  for (const ns of [...counts.keys()].sort()) {
    const n = counts.get(ns)!;
    if (n > homeCount) {
      home = ns;
      homeCount = n;
    }
  }
  if (home === null) return;
  const rank = (iri: string) => (namespaceOf(iri) === home ? 0 : 1);
  proj.classes = stableSortBy(proj.classes, (c) => rank(c.iri));
  proj.properties = stableSortBy(proj.properties, (p) => rank(p.iri));
}

function stableSortBy<T>(items: T[], key: (item: T) => number): T[] {
  return items
    .map((item, index) => ({ item, index, key: key(item) }))
    .sort((a, b) => a.key - b.key || a.index - b.index)
    .map((x) => x.item);
}

/** The part of an IRI before its local name (including the trailing `#` or `/`). */
function namespaceOf(iri: string): string {
  const i = Math.max(iri.lastIndexOf("#"), iri.lastIndexOf("/"));
  return i === -1 ? iri : iri.slice(0, i + 1);
}

/**
 * Maps a datatype IRI to one of our four kinds. Uses its own name when
 * recognized, otherwise climbs `rdfs:subClassOf` (Integer → Number,
 * URL → Text).
 *
 * Returns `null` when the name is not recognized — for example
 * `schema:Time`, which has a time of day but no date, gets the same
 * treatment as `xsd:time`: {@link mapRange} degrades it to text and
 * reports it, rather than dropping it.
 */
function nameDatatype(iri: string, parents: Map<string, string[]>, datatypes: Set<string>): DatatypeKind | null {
  const seen = new Set<string>();
  const stack = [iri];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const dt = wellKnownDatatype(cur);
    if (dt) return dt;
    // Only climb through OTHER datatypes: a datatype's parent can be a
    // plain rdfs:Class (schema:DataType ⊂ rdfs:Class), and crossing that
    // line would walk the whole class hierarchy instead.
    for (const p of parents.get(cur) ?? []) {
      if (datatypes.has(p)) stack.push(p);
    }
  }
  return null;
}

/**
 * The hard-coded half: which datatype NAME maps to which of our kinds.
 *
 * This cannot be read out of RDF — a file can say "Integer is a
 * datatype" but not "it is a number, not a date". The table holds only
 * the roots; subclasses reach it by climbing `subClassOf`.
 */
function wellKnownDatatype(iri: string): DatatypeKind | null {
  const table: [string, DatatypeKind][] = [
    ["Text", "text"],
    ["Number", "number"],
    ["Date", "date"],
    ["DateTime", "date"],
    ["Boolean", "bool"],
  ];
  for (const [local, kind] of table) {
    if (isSchema(iri, local)) return kind;
  }
  return null;
}

/** Picks one label out of several: prefers en / zh, then untagged, then whichever comes first. */
function pickLang(vals: [string, string | undefined][] | undefined): string | undefined {
  if (!vals || vals.length === 0) return undefined;
  for (const want of ["en", "zh"]) {
    const hit = vals.find(([, lang]) => lang?.startsWith(want));
    if (hit) return hit[0];
  }
  const untagged = vals.find(([, lang]) => lang === undefined);
  return (untagged ?? vals[0])?.[0];
}

/** The local part of an IRI: whatever follows the last `#` or `/`. */
export function localName(iri: string): string {
  const i = Math.max(iri.lastIndexOf("#"), iri.lastIndexOf("/"));
  return i === -1 ? iri : iri.slice(i + 1);
}

/**
 * Derives a key from an IRI. The IRI is the identity; the key is the
 * label the model reads and writes (see decision 0001, P2): only
 * `[a-z0-9_]`, at most 40 characters, so the IRI itself never fits.
 * camelCase is split at the boundary: `hasEmployee` → `has_employee`.
 */
export function keyFromIri(iri: string): string {
  const local = localName(iri);
  let out = "";
  let prevLower = false;
  for (const c of local) {
    if (/[A-Z]/.test(c)) {
      if (prevLower && out !== "") out += "_";
      out += c.toLowerCase();
      prevLower = false;
    } else if (/[a-zA-Z0-9]/.test(c)) {
      out += c;
      prevLower = true;
    } else if (!out.endsWith("_") && out !== "") {
      out += "_";
      prevLower = false;
    }
  }
  while (out.endsWith("_")) out = out.slice(0, -1);
  return out.slice(0, 40);
}

/** The result of mapping an `rdfs:range` to one of our four datatypes. Three-way, not two-way. */
export type RangeMapping =
  /** Maps to `text` / `number` / `date` / `bool`. */
  | { kind: "datatype"; value: DatatypeKind }
  /** No range at all: the vocabulary declared nothing, only that it is a literal. `text` is an honest superset (it accepts any string, never rejects), so we build it and list it in the preview. */
  | { kind: "absent" }
  /**
   * A range was written, the value is a SHORT, READABLE literal, but our
   * four kinds cannot express it (`time` has no year, `duration` is a
   * span, not a point). Built as `text` AND reported: only the ordering
   * semantics is lost, the value is still there; skipping it instead
   * would lose the knowledge entirely, which is worse.
   */
  | { kind: "degraded"; value: string }
  /**
   * A range was written, and there is no realistic way the extractor
   * would ever read this value out of prose: a binary blob, an XML
   * fragment, an internal XML identifier. Skipping it protects no data
   * (there was never going to be a value); what it saves is a line in
   * every extraction prompt, paid for once per text chunk.
   */
  | { kind: "unusable"; value: string };

/**
 * A datatype property's `rdfs:range` → datatype.
 *
 * Matched by FULL IRI, not local name: a custom vocabulary can easily
 * have a class named `date`; matching on the tail would treat it as
 * `xsd:date`.
 *
 * Several ranges are always {@link RangeMapping} `degraded` — in RDFS
 * that is INTERSECTION semantics ("must be both"), almost always a
 * modeling slip, but the spec says so and we do not guess.
 */
export function mapRange(ranges: string[]): RangeMapping {
  return resolveRange(ranges, false, new Map());
}

/**
 * Resolves a range using the PROPERTY'S OWN range semantics.
 *
 * `rdfs:range` written more than once is an intersection;
 * `schema:rangeIncludes` written more than once is a union — both land
 * in the same `ranges` list. Ignoring {@link OwlProperty.rangesUnion}
 * would read `author rangeIncludes Organization, Person` as "must be
 * both an organization and a person".
 */
export function mapRangeOf(p: OwlProperty, vocab: VocabDatatypes): RangeMapping {
  return resolveRange(p.ranges, p.rangesUnion, vocab);
}

function resolveRange(ranges: string[], union: boolean, vocab: VocabDatatypes): RangeMapping {
  // A vocabulary's own reported datatype is checked first
  // (schema:Text → text); only then do we fall back to the standard
  // xsd/owl table.
  const named = (iri: string): DatatypeKind | null => vocab.get(iri) ?? datatypeOf(iri);
  if (ranges.length === 0) return { kind: "absent" };
  if (ranges.length === 1) {
    const one = ranges[0]!;
    const dt = named(one);
    if (dt) return { kind: "datatype", value: dt };
    if (unusable(one)) return { kind: "unusable", value: one };
    return { kind: "degraded", value: one };
  }
  if (union) {
    // A union: all pointing at the same kind means that kind (Text ∪ URL are both text).
    // An inconsistent union degrades to text and is reported — text is an honest upper bound for any union.
    const dts = ranges.map(named);
    const first = dts[0];
    if (first && dts.every((d) => d === first)) return { kind: "datatype", value: first };
    if (ranges.every((r) => unusable(r))) return { kind: "unusable", value: ranges.join(" ∪ ") };
    return { kind: "degraded", value: ranges.join(" ∪ ") };
  }
  // rdfs:range written more than once is an intersection: we do not guess the type, but the value is still a literal, so it is built as text.
  return { kind: "degraded", value: ranges.join(" ∩ ") };
}

/**
 * What the extractor could never read out of prose: binary blobs and
 * internal XML plumbing.
 *
 * The test is not "should this value be stored" — an attribute value is
 * already stored in the graph either way (through `facts.object_value`,
 * with evidence, time, and review all included). The test is WHETHER A
 * VALUE WOULD EVER EXIST: "the store opens at 9:00" has `09:00` in it; a
 * base64 floor plan does not appear in prose, and even if a document
 * genuinely had a base64 blob in it, extracting it as a fact would still
 * be wrong.
 *
 * Everything else degrades to text — a value that CAN be extracted
 * deserves somewhere to go, even with a rough type.
 */
function unusable(iri: string): boolean {
  if (iri.startsWith(XSD)) {
    const local = iri.slice(XSD.length);
    return ["base64Binary", "hexBinary", "QName", "NOTATION", "ID", "IDREF", "IDREFS", "ENTITY", "ENTITIES"].includes(local);
  }
  if (iri.startsWith(RDF_NS)) {
    return iri.slice(RDF_NS.length) === "XMLLiteral";
  }
  return false;
}

function datatypeOf(iri: string): DatatypeKind | null {
  if (iri.startsWith(XSD)) {
    const local = iri.slice(XSD.length);
    if (
      [
        "decimal",
        "integer",
        "int",
        "long",
        "short",
        "byte",
        "nonNegativeInteger",
        "positiveInteger",
        "nonPositiveInteger",
        "negativeInteger",
        "unsignedLong",
        "unsignedInt",
        "unsignedShort",
        "unsignedByte",
        "double",
        "float",
      ].includes(local)
    ) {
      return "number";
    }
    // Our date format is already YYYY[-MM[-DD]], each part optional, so
    // gYear / gYearMonth fit too.
    if (["date", "dateTime", "dateTimeStamp", "gYear", "gYearMonth"].includes(local)) return "date";
    if (local === "boolean") return "bool";
    if (["string", "normalizedString", "token", "language", "Name", "NCName", "NMTOKEN", "anyURI"].includes(local)) {
      return "text";
    }
    // time / gMonth / gDay / gMonthDay have no year, and the duration
    // family is a span, not a point — these fall through to `null` and
    // get sorted by unusable(): they are readable literals, so they
    // degrade to text; only binary data and internal XML identifiers
    // are truly skipped.
    return null;
  }
  if (iri.startsWith(RDF_NS)) {
    const local = iri.slice(RDF_NS.length);
    return local === "PlainLiteral" || local === "langString" ? "text" : null;
  }
  if (iri.startsWith(RDFS)) {
    return iri.slice(RDFS.length) === "Literal" ? "text" : null;
  }
  if (iri.startsWith(OWL)) {
    const local = iri.slice(OWL.length);
    return local === "real" || local === "rational" ? "number" : null;
  }
  return null;
}

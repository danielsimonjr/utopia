import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  RdfFormat,
  keyFromIri,
  mapRange,
  mapRangeOf,
  project,
  type OwlProjection,
  type OwlProperty,
} from "./ontology_rdf";

const XSD = "http://www.w3.org/2001/XMLSchema#";
const OWL = "http://www.w3.org/2002/07/owl#";
const RDF_NS = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";

describe("mapRange", () => {
  test("maps every numeric xsd variant", () => {
    for (const local of [
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
    ]) {
      expect(mapRange([`${XSD}${local}`])).toEqual({ kind: "datatype", value: "number" });
    }
    // owl:real / owl:rational are also in the OWL 2 datatype map.
    expect(mapRange([`${OWL}rational`])).toEqual({ kind: "datatype", value: "number" });
  });

  /** Our date format is YYYY[-MM[-DD]], each part optional, so only the g-types missing the low end fit. */
  test("a partial date fits only when the year is there", () => {
    for (const local of ["date", "dateTime", "dateTimeStamp", "gYear", "gYearMonth"]) {
      expect(mapRange([`${XSD}${local}`])).toEqual({ kind: "datatype", value: "date" });
    }
    for (const local of ["gMonth", "gDay", "gMonthDay", "time"]) {
      const m = mapRange([`${XSD}${local}`]);
      expect(m.kind).toBe("degraded");
    }
  });

  /** The line is not "can we map it exactly", it is "should this value make it into the graph at all". Anything storable is kept. */
  test("a value we can store is kept even when we cannot name its type", () => {
    expect(mapRange([])).toEqual({ kind: "absent" });
    expect(mapRange([`${XSD}duration`]).kind).toBe("degraded");
    expect(mapRange([`${XSD}base64Binary`]).kind).toBe("unusable");
    expect(mapRange([`${RDF_NS}XMLLiteral`]).kind).toBe("unusable");
  });

  /** Several ranges are an INTERSECTION in RDFS ("must be both"), not a union — we refuse to guess. */
  test("several ranges are an intersection we refuse to guess", () => {
    const m = mapRange([`${XSD}string`, `${XSD}integer`]);
    expect(m.kind).toBe("degraded");
    expect((m as { value: string }).value).toContain("∩");
  });

  /** Matched by full IRI: a custom vocabulary's class named "date" is not xsd:date. */
  test("a class that happens to be called date is not a date", () => {
    expect(mapRange(["http://acme.example/hr#date"]).kind).toBe("degraded");
  });
});

const TTL = `
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix ex: <http://acme.example/hr#> .

ex:Employee a owl:Class ;
    rdfs:label "Employee"@en ;
    rdfs:label "员工"@zh ;
    rdfs:comment "A person on the payroll."@en ;
    rdfs:subClassOf ex:Person .
ex:Person a owl:Class ; rdfs:label "Person" .
ex:hasManager a owl:ObjectProperty, owl:FunctionalProperty ;
    rdfs:label "has manager" ;
    rdfs:domain ex:Employee ;
    rdfs:range ex:Person .
ex:salary a owl:DatatypeProperty ; rdfs:domain ex:Employee .
ex:Employee owl:disjointWith ex:Contractor .
ex:Employee owl:equivalentClass ex:Staff .
`;

test("projects classes and properties, and reports the rest", () => {
  const p = project(Buffer.from(TTL), "turtle");
  const emp = p.classes.find((c) => c.key === "employee")!;
  expect(emp.label).toBe("Employee");
  expect(emp.description).toBe("A person on the payroll.");
  expect(emp.parents).toEqual(["http://acme.example/hr#Person"]);

  const mgr = p.properties.find((x) => x.key === "has_manager")!;
  expect(mgr.functional && !mgr.isDatatype).toBe(true);
  expect(mgr.ranges).toEqual(["http://acme.example/hr#Person"]);

  const sal = p.properties.find((x) => x.key === "salary")!;
  expect(sal.isDatatype).toBe(true);

  // A predicate we cannot consume is reported, not silently dropped nor an error.
  expect(p.unprojected.has(`${OWL}equivalentClass`)).toBe(true);
});

describe("RdfFormat.detect", () => {
  test("recognizes RDF/XML that opens with comments", () => {
    // FOAF's official file looks exactly like this: dozens of `<!-- -->`
    // lines before the first `<rdf:RDF>`.
    const head = Buffer.from(
      "<!-- This is the FOAF vocabulary, expressed using RDFS and OWL. -->\n" +
        "<!-- padding padding padding padding padding padding padding -->\n",
    );
    expect(RdfFormat.detect("index.rdf", head)).toBe("rdfxml");
    // The other way round: Turtle inside a `.owl` file is also common — content decides.
    expect(RdfFormat.detect("x.owl", Buffer.from("@prefix owl: <http://x#> .\n"))).toBe("turtle");
    // A comment-first Turtle file is still recognized (the `#` line is skipped first).
    expect(RdfFormat.detect("x", Buffer.from("# a note\n\n@base <http://x> .\n"))).toBe("turtle");
  });
});

test("keyFromIri derives from the local name", () => {
  expect(keyFromIri("http://x/hr#hasEmployee")).toBe("has_employee");
  expect(keyFromIri("http://x/ns/Person")).toBe("person");
  expect(keyFromIri("http://x#HTTP_Server")).toBe("http_server");
});

/**
 * A minimal recreation of schema.org's own shape: datatypes announce
 * themselves, properties use domainIncludes / rangeIncludes, and
 * everything is declared only as rdf:Property.
 */
const SCHEMA_ISH = `
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix schema: <https://schema.org/> .

schema:DataType a rdfs:Class .
schema:Text a rdfs:Class, schema:DataType .
schema:Number a rdfs:Class, schema:DataType .
schema:Date a rdfs:Class, schema:DataType .
schema:Time a rdfs:Class, schema:DataType .
schema:URL a rdfs:Class ; rdfs:subClassOf schema:Text .
schema:Integer a rdfs:Class ; rdfs:subClassOf schema:Number .

schema:Organization a rdfs:Class ; rdfs:label "Organization" .
schema:Person a rdfs:Class ; rdfs:label "Person" .
schema:PostalAddress a rdfs:Class ; rdfs:label "PostalAddress" .

schema:foundingDate a rdf:Property ;
    schema:domainIncludes schema:Organization ;
    schema:rangeIncludes schema:Date .
schema:author a rdf:Property ;
    schema:domainIncludes schema:Organization ;
    schema:rangeIncludes schema:Organization, schema:Person .
schema:address a rdf:Property ;
    schema:domainIncludes schema:Organization ;
    schema:rangeIncludes schema:PostalAddress, schema:Text .
schema:homepage a rdf:Property ;
    schema:domainIncludes schema:Person ;
    schema:rangeIncludes schema:Text, schema:URL .
schema:opens a rdf:Property ;
    schema:domainIncludes schema:Organization ;
    schema:rangeIncludes schema:Time .
schema:knows a rdf:Property ;
    schema:domainIncludes schema:Person .
`;

function schemaIsh(): OwlProjection {
  return project(Buffer.from(SCHEMA_ISH), "turtle");
}

function prop(p: OwlProjection, key: string): OwlProperty {
  const found = p.properties.find((x) => x.key === key);
  if (!found) throw new Error(`no property ${key}`);
  return found;
}

test("schema.org's own datatypes are not entity types", () => {
  const p = schemaIsh();
  const keys = p.classes.map((c) => c.key);
  for (const gone of ["text", "number", "date", "time", "url", "integer", "data_type"]) {
    expect(keys).not.toContain(gone);
  }
  expect(keys).toContain("organization");
  expect(keys).toContain("person");
});

test("domainIncludes feeds the signature", () => {
  const p = schemaIsh();
  expect(prop(p, "founding_date").domains).toEqual(["https://schema.org/Organization"]);
});

test("a union range of classes stays a relation", () => {
  const p = schemaIsh();
  expect(prop(p, "author").isDatatype).toBe(false);
  expect(prop(p, "address").isDatatype).toBe(false);
});

test("a union range of datatypes becomes an attribute", () => {
  const p = schemaIsh();
  const fd = prop(p, "founding_date");
  expect(fd.isDatatype).toBe(true);
  expect(mapRangeOf(fd, p.vocabDatatypes)).toEqual({ kind: "datatype", value: "date" });

  const hp = prop(p, "homepage");
  expect(hp.isDatatype).toBe(true);
  expect(mapRangeOf(hp, p.vocabDatatypes)).toEqual({ kind: "datatype", value: "text" });
});

test("a union is not an intersection", () => {
  const p = schemaIsh();
  expect(prop(p, "author").rangesUnion).toBe(true);
  expect(prop(p, "author").ranges.length).toBe(2);
  const m = mapRange([`${XSD}string`, `${XSD}integer`]);
  expect(m.kind).toBe("degraded");
  expect((m as { value: string }).value).toContain("∩");
});

test("an unnamed datatype degrades and is reported", () => {
  const p = schemaIsh();
  const o = prop(p, "opens");
  expect(o.isDatatype).toBe(true);
  const m = mapRangeOf(o, p.vocabDatatypes);
  expect(m.kind).toBe("degraded");
  expect((m as { value: string }).value.endsWith("Time")).toBe(true);
});

test("a bare rdf:Property with no range is still a relation", () => {
  const p = schemaIsh();
  const k = prop(p, "knows");
  expect(k.isDatatype).toBe(false);
  expect(k.ranges.length).toBe(0);
});

test("schema predicates are consumed, not reported as unprojected", () => {
  const p = schemaIsh();
  for (const consumed of ["domainIncludes", "rangeIncludes"]) {
    expect([...p.unprojected.keys()].some((k) => k.endsWith(consumed))).toBe(false);
  }
});

/**
 * One file merges two vocabularies, and the main vocabulary's IRIs use
 * https while the referenced one uses http — under lexicographic order
 * http sorts first, so the main vocabulary would lose. This is the shape
 * of the real schema.org file.
 */
const TWO_VOCABS = `
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix home: <https://home.example/> .
@prefix cited: <http://cited.example/> .

home:Location a rdfs:Class ; rdfs:label "Location" .
home:Country a rdfs:Class ; rdfs:label "Country" .
home:Person a rdfs:Class ; rdfs:label "Person" .
home:Organization a rdfs:Class ; rdfs:label "Organization" .
cited:Location a rdfs:Class ; rdfs:label "Location (cited)" .

home:worksAt a rdf:Property ; rdfs:label "worksAt" .
home:knows a rdf:Property ; rdfs:label "knows" .
cited:worksAt a rdf:Property ; rdfs:label "worksAt (cited)" .
`;

test("the file's own vocabulary wins a key collision", () => {
  const p = project(Buffer.from(TWO_VOCABS), "turtle");
  const firstLocation = p.classes.find((c) => c.key === "location")!;
  expect(firstLocation.iri.startsWith("https://home.example/")).toBe(true);
  const firstWorks = p.properties.find((x) => x.key === "works_at")!;
  expect(firstWorks.iri.startsWith("https://home.example/")).toBe(true);
});

describe("axioms", () => {
  /**
   * OWL property axioms and class disjointness must be projected — they
   * are the deciding evidence for consistency checking. Without them
   * there is no way to tell whether `A part_of B` and `B part_of A` both
   * holding is a contradiction or normal: `alias_of` both ways is
   * correct, `produces` both ways is almost certainly wrong, and only
   * the ontology can say which is which.
   */
  const AX = `
    @prefix owl: <http://www.w3.org/2002/07/owl#> .
    @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
    @prefix ex: <http://acme.example/ax#> .

    ex:Person a owl:Class ; owl:disjointWith ex:Organization .
    ex:Organization a owl:Class .
    ex:Document a owl:Class .

    ex:partOf   a owl:ObjectProperty, owl:TransitiveProperty, owl:AsymmetricProperty .
    ex:aliasOf  a owl:ObjectProperty, owl:SymmetricProperty .
    ex:reportsTo a owl:ObjectProperty, owl:IrreflexiveProperty .
    ex:plain    a owl:ObjectProperty .
  `;

  function proj(): OwlProjection {
    return project(Buffer.from(AX), "turtle");
  }

  test("property axioms survive the projection", () => {
    const p = proj();
    const by = (k: string) => p.properties.find((x) => x.key === k)!;

    const partOf = by("part_of");
    expect(partOf.transitive).toBe(true);
    expect(partOf.asymmetric).toBe(true);
    expect(partOf.symmetric).toBe(false);

    expect(by("alias_of").symmetric).toBe(true);
    expect(by("reports_to").irreflexive).toBe(true);

    // Undeclared is always false — the default is "no such axiom", not
    // "unknown". OWL is open-world, but consistency checking can only
    // judge by what is written down: not writing one down is not
    // evidence of a contradiction, and guessing one in would be less safe.
    const plain = by("plain");
    expect(plain.transitive || plain.symmetric || plain.asymmetric || plain.irreflexive).toBe(false);
  });

  /** Both directions must be present — a vocabulary usually writes a disjointness pair only once. */
  test("disjointness is recorded from both ends", () => {
    const p = proj();
    const d = (k: string) => p.classes.find((c) => c.key === k)!.disjointWith;
    expect(d("person")).toEqual(["http://acme.example/ax#Organization"]);
    expect(d("organization")).toEqual(["http://acme.example/ax#Person"]);
    expect(d("document")).toEqual([]);
  });
});

describe("property axiom relations", () => {
  /** `owl:inverseOf` and `rdfs:subPropertyOf` must be read. Both used to be silently dropped on import. */
  test("inverseOf and subPropertyOf survive projection", () => {
    const ttl = `
      @prefix owl:  <http://www.w3.org/2002/07/owl#> .
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
      @prefix ex:   <http://example.org/> .

      ex:Person a owl:Class ; rdfs:label "Person" ; rdfs:comment "A human being." .
      ex:Org    a owl:Class ; rdfs:label "Organization" ; rdfs:comment "A company." .

      ex:worksAt a owl:ObjectProperty ;
          rdfs:label "works at" ; rdfs:comment "Employment." ;
          rdfs:domain ex:Person ; rdfs:range ex:Org .

      ex:employs a owl:ObjectProperty ;
          rdfs:label "employs" ; rdfs:comment "The other direction." ;
          rdfs:domain ex:Org ; rdfs:range ex:Person ;
          owl:inverseOf ex:worksAt .

      ex:ceoOf a owl:ObjectProperty ;
          rdfs:label "CEO of" ; rdfs:comment "Chief executive." ;
          rdfs:domain ex:Person ; rdfs:range ex:Org ;
          rdfs:subPropertyOf ex:worksAt .
    `;
    const p = project(Buffer.from(ttl), "turtle");
    const by = (k: string) => {
      const found = p.properties.find((x) => x.key === k);
      if (!found) throw new Error(`missing ${k}`);
      return found;
    };
    expect(by("employs").inverseOf).toBe("http://example.org/worksAt");
    expect(by("ceo_of").subPropertyOf).toBe("http://example.org/worksAt");
    expect(by("works_at").inverseOf).toBeNull();
    expect([...p.unprojected.keys()].some((k) => k.includes("inverseOf"))).toBe(false);
  });
});

describe("against real packs", () => {
  function load(name: string): Buffer {
    const packDir = path.join(import.meta.dir, "..", "..", "packs");
    const gz = readFileSync(path.join(packDir, name));
    return Buffer.from(Bun.gunzipSync(gz));
  }

  /**
   * W3C Org states Organization / Role / Membership / Site / ChangeEvent
   * as pairwise disjoint, and the official file states each pair only
   * once. Every one of the five classes should show all four others.
   */
  test("w3c-org states four mutually disjoint classes", () => {
    const p = project(load("w3c-org.ttl.gz"), "turtle");
    for (const key of ["organization", "role", "membership", "site", "change_event"]) {
      const c = p.classes.find((x) => x.key === key);
      expect(c).toBeDefined();
      expect(c!.disjointWith.length).toBe(4);
    }
  });

  /** schema.org's real file: the main vocabulary must still win its collisions among 50 merged namespaces. */
  test("schema-org projects a large real vocabulary without error", () => {
    const p = project(load("schema-org.ttl.gz"), "turtle");
    expect(p.classes.length).toBeGreaterThan(50);
    expect(p.properties.length).toBeGreaterThan(50);
    const org = p.classes.find((c) => c.key === "organization");
    expect(org?.iri.startsWith("https://schema.org/") || org?.iri.startsWith("http://schema.org/")).toBe(true);
  });

  /** IOF Core declares a batch of transitive properties (before/after/occursDuring…) — the one real source of transitive axioms. */
  test("iof-core (RDF/XML) declares transitive properties", () => {
    const p = project(load("iof-core.rdf.gz"), "rdfxml");
    const n = p.properties.filter((x) => x.transitive).length;
    expect(n).toBeGreaterThanOrEqual(8);
  });

  /** FOAF (RDF/XML) says a Person is not an Organization — the most commonly colliding pair. */
  test("foaf (RDF/XML) says a person is not an organization", () => {
    const p = project(load("foaf.rdf.gz"), "rdfxml");
    const person = p.classes.find((c) => c.key === "person");
    expect(person).toBeDefined();
    expect(person!.disjointWith.some((d) => d.endsWith("Organization"))).toBe(true);
  });
});

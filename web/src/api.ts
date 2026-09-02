import { S, lang } from "./i18n";

export class ApiError extends Error {
  status: number;
  /** The stable error code the server returns. When absent, this is an
   *  untranslated contract guard, and message is already the raw English text. */
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers:
      init?.body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    // Wording is decided at this one point, so none of the 22 files calling
    // toast.error(e.message) need to change. When a code is present, this looks
    // it up in i18n; when it is absent, or not yet in that table, this falls back
    // to the server's raw English text — the server always speaks English,
    // because the interface language lives on the client (see ADR 0004).
    let message = res.statusText;
    let code: string | undefined;
    try {
      const body = (await res.json()) as {
        error?: string;
        code?: string;
        detail?: string;
      };
      if (body.error) message = body.error;
      code = body.code;
      // code comes from the network, not a literal — this cast is what lets the
      // err table itself keep full type checking.
      const worded = code
        ? (S.err as Record<string, string | undefined>)[code]
        : undefined;
      if (worded) message = worded;
      if (body.detail) message = S.errDetail(message, body.detail);
    } catch {
      // The response body was not JSON; keep statusText.
    }
    throw new ApiError(res.status, message, code);
  }
  return res.json() as Promise<T>;
}

export interface User {
  id: string;
  org_id: string;
  email: string;
  display_name: string;
  is_admin: boolean;
  created_at: string;
}

export interface Workspace {
  id: string;
  org_id: string;
  name: string;
  created_at: string;
}

/** An optional prebuilt ontology pack, offered when creating a knowledge base
 *  (`GET /ontology-packs`). */
export type OntologyPack = {
  id: string;
  name: string;
  summary: string;
  classes: number;
  properties: number;
};

export interface Kb {
  id: string;
  workspace_id: string;
  name: string;
  kind: string;
  description: string | null;
  visibility: "open" | "restricted";
  /** The deployment's public default space (the first knowledge base created):
   *  always open, and cannot be deleted. */
  is_default: boolean;
  /** Whether the system may add a relation to the ontology automatically, and
   *  reclassify the facts waiting for it, when extraction meets a relation
   *  outside the ontology. Turning this off does not stop detection: the
   *  unmatched count still accumulates and stays visible; it only becomes a
   *  proposal the user must click to approve. */
  auto_extend_ontology: boolean;
  /** Whether to write derived facts into the ledger (see ADR R1). **Off by
   *  default** — inference adds facts to the graph, and a declaration can be
   *  wrong, so the graph should not change from it before the user opts in. */
  materialize_inferences: boolean;
  /** How often to rerun inference, in minutes. Facts keep changing, and relying
   *  only on a manual click would leave derived facts always out of date. */
  inference_interval_minutes: number;
  /** The time of the last completed inference run. */
  last_inference_at: string | null;
  /** Which language seeds the built-in ontology, and which language new
   *  descriptions are written in. **This follows the corpus, not the interface**
   *  (the interface language is a client-side setting; see ADR 0004). */
  ontology_lang: "en" | "zh";
  /** The caller's role in this knowledge base (returned only by the detail
   *  endpoint): the frontend uses it to gate destructive actions. */
  my_role?: "viewer" | "editor" | "admin" | "owner" | null;
}

/** A row in the account-level "My knowledge bases" list: the base, the caller's
 *  role, join information, and overview stats. */
export interface MyKb {
  kb: Kb;
  my_role: "viewer" | "editor" | "admin" | "owner" | null;
  joined_at: string | null;
  added_by_name: string | null;
  doc_count: number;
  member_count: number;
}

/** An audit event, shown for audit purposes only. */
export interface AuditEvent {
  id: string;
  action: string;
  target_kind: string;
  target_id: string | null;
  detail: Record<string, unknown>;
  actor_name: string | null;
  created_at: string;
}

export interface KbMember {
  user_id: string;
  email: string;
  display_name: string;
  role: "viewer" | "editor" | "admin";
}

export interface Doc {
  id: string;
  kb_id: string;
  source_id: string | null;
  filename: string;
  mime: string;
  size_bytes: number;
  status: string;
  graph_status: string;
  /** The failure reason from the ingestion pipeline. */
  error: string | null;
  /** The failure reason from the graph extraction pipeline (kept separate from
   *  error: each pipeline stores its own failure). */
  graph_error: string | null;
  chunk_count: number;
  /** Document tags. **No interface uses this today** — it stays intentionally;
   *  the reason is recorded next to the `tags` column in
   *  `migrations/0002_ingest.sql`. */
  tags: string[];
  missing_since: string | null;
  created_at: string;
}

/** An aggregate of one kind of extraction drop within a document: a fact was
 *  extracted but did not make it into the graph. */
export interface ExtractionDrop {
  document_id: string;
  /** The stable reason code the frontend uses to look up wording
   *  (attr_domain_mismatch / low_confidence / and so on). */
  reason: string;
  /** The specific object this reason applies to (an attribute key, a predicate
   *  name, or "salary@organization"). */
  detail: string;
  count: number;
  example: string | null;
}

export interface SourceView {
  id: string;
  kind:
    | "folder"
    | "url"
    | "rss"
    | "api"
    | "custom"
    | "github_issues"
    | "jira_issues"
    | "s3"
    | "memory"
    | "upload";
  name: string;
  config: {
    urls?: string[];
    feed_url?: string;
    endpoint?: string;
    /** github_issues: owner/name. */
    repo?: string;
    /** github_issues: in GitHub's own model, a pull request is also a ticket;
     *  excluded by default. */
    include_pull_requests?: boolean;
    /** jira_issues: the site address, for example
     *  https://issues.apache.org/jira. */
    base_url?: string;
    /** jira_issues: the project key, for example KAFKA. */
    project?: string;
  } | null;
  icon: string | null;
  sync_interval_minutes: number | null;
  sync_cron: string | null;
  last_sync_at: string | null;
  last_sync_status: "never" | "queued" | "running" | "ok" | "failed";
  last_sync_error: string | null;
  last_sync_added: number;
  doc_count: number;
  missing_count: number;
}

export interface SearchResult {
  id: string;
  document_id: string;
  seq: number;
  text: string;
  filename: string;
}

export interface LlmSettingsView {
  chat_base_url?: string | null;
  chat_model?: string | null;
  has_chat_key?: boolean;
  embed_base_url?: string | null;
  embed_model?: string | null;
  embed_dim?: number | null;
  has_embed_key?: boolean;
}

export interface Member {
  user_id: string;
  email: string;
  display_name: string;
  role: string;
  is_admin: boolean;
}

export interface OrgUser {
  id: string;
  email: string;
  display_name: string;
  is_admin: boolean;
}

/** A data source for Ask. Credentials never come down to the client; only a
 *  host:port/db summary does. */
export interface DataSourceView {
  id: string;
  name: string;
  engine: string;
  summary: string;
  created_at: string;
  last_test_at: string | null;
  last_test_ok: boolean | null;
}

export interface GraphNode {
  id: string;
  name: string;
  // null when no type has been judged yet (see ADR 0009).
  type_key: string | null;
  type_label: string | null;
  color: string;
  shape: "circle" | "square";
  degree: number;
  disambiguator: string | null;
}

export interface SyncRun {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: "running" | "ok" | "failed";
  created_docs: number;
  updated_docs: number;
  error: string | null;
}

/** An extraction result for one chunk (shown in the document viewer's right
 *  column). */
export interface ChunkFact {
  chunk_id: string;
  fact_id: string;
  subject_id: string;
  subject: string;
  /** The source text's own wording when the ontology does not recognize this
   *  relation; null when neither is available. */
  predicate: string | null;
  /** true means the name comes from the source text, not from a relation the
   *  ontology recognizes. */
  inferred: boolean;
  object_id: string | null;
  object: string | null;
  valid_from: string | null;
  valid_to: string | null;
  confidence: number;
}

/** A derived fact, together with its proof (the "Derived" tab in the entity
 *  panel).
 *
 * `premises` is the reason this field exists: without stating the premises, a
 * derived edge looks no different from an ordinary edge in the interface, and
 * that is exactly what "inference contaminating knowledge" looks like. */
export interface DerivedFact {
  id: string;
  subject_id: string;
  subject: string;
  object_id: string;
  object: string;
  predicate: string;
  /** Which rule derived this fact. The last two were added by ADR 0017 as
   *  cross-predicate rules. */
  rule: "transitive" | "symmetric" | "inverse" | "sub_property";
  valid_from: string | null;
  valid_to: string | null;
  confidence: number;
  derived_at: string;
  /** The direct premises, in derivation order. */
  premises: string[];
}

/** A category in the Review page. **These are the same literal values as the
 *  server's queue parameter** — a typo produces a clear unknown_queue error,
 *  not a silently empty list. */
export type ReviewQueue =
  | "duplicates"
  | "conflicts"
  | "unconfirmed"
  | "lowconf"
  | "mappings"
  | "violations"
  | "defects"
  | "merges";

/** The real count for each category. The badge in the left rail reads this, not
 *  the length of the loaded list. */
export interface ReviewCounts {
  duplicates: number;
  conflicts: number;
  unconfirmed: number;
  lowconf: number;
  mappings: number;
  violations: number;
  defects: number;
  merges: number;
}

/** One type-resolution suggestion: an entity to refine, the profile sent to
 *  retrieval, and the candidate classes.
 *
 * Returning `profile` to the caller is deliberate — when retrieval fails to
 * find a match, the first thing to check is "what did we search with," rather
 * than guessing whether the profile or a class description is at fault. */
export interface TypeSuggestion {
  entity_id: string;
  name: string;
  /** The class currently assigned, which can be absent (see ADR 0009). */
  coarse: string | null;
  coarse_description: string | null;
  proposed_type: string | null;
  specific_type: string | null;
  fact_count: number;
  profile: string;
  candidates: {
    id: string;
    key: string;
    label: string;
    description: string;
    distance: number;
  }[];
}

/** The result of one refinement run. **Reported in three separate groups**:
 *  entities retyped automatically, entities left for a person to decide, and
 *  entities the judgment left alone. The last group carries a reason — this
 *  design relies on "leaving something alone is a legitimate answer," and
 *  without a recorded reason, the largest group would be opaque. */
export interface ResolutionOutcome {
  batch: string | null;
  retyped: number;
  for_review: {
    entity_id: string;
    name: string;
    coarse: string | null;
    from_type_id: string | null;
    to_type_id: string;
    choice: string;
    confidence: number;
    reason: string | null;
    /** The chosen class is not under the coarse class's subtree — this changes
     *  the classification axis, not just one step down it. */
    crosses_axis: boolean;
  }[];
  left_alone: {
    name: string;
    coarse: string | null;
    specific_type: string | null;
    reason: string | null;
    top_candidate: string | null;
  }[];
}
export interface ReviewSide {
  id: string;
  name: string;
  // null when no type has been judged yet (see ADR 0009).
  type_label: string | null;
  color: string;
  disambiguator: string | null;
  degree: number;
  top_facts: string[];
}

export interface ReviewItem {
  id: string;
  score: number;
  reason: string | null;
  stage: "adjudicating" | "human";
  created_at: string;
  left: ReviewSide;
  right: ReviewSide;
}

/** A data mapping: a business concept mapped to a data asset definition (see
 *  ADR 0011).
 *
 * These are separate columns, not keys inside a JSON blob — an earlier version
 * stored this as one `mapped_to` fact, with all of these fields packed into
 * `object_value`. */
export interface ConceptMapping {
  id: string;
  concept_id: string;
  concept_name: string;
  /** The mounted data source. The same concept can have a different
   *  definition on a different source. */
  source: string;
  table_name: string | null;
  expr: string | null;
  sql: string | null;
  unit: string | null;
  summary: string | null;
  /** A derived metric: computed, not a column in a table. */
  derived: boolean;
  status: "proposed" | "confirmed" | "rejected";
}
/** The state of a definition before one change. **A full snapshot, not a
 *  diff** (see ADR 0006): reading this needs to answer "what was it at that
 *  time," and a diff would require replaying from the start to answer that. */
export interface MappingRevision {
  id: string;
  before: Record<string, unknown>;
  /** Who made the change. A user account is soft-deleted, so attribution does
   *  not disappear when that person leaves. */
  changed_by_name: string | null;
  changed_at: string;
}
/** One axiom violation (see ADR 0002, rule R0). The judgment comes from an
 *  axiom the ontology itself declares; with no declared axiom, nothing is
 *  reported. */
export interface AxiomViolation {
  id: string;
  kind: "self_loop" | "asymmetry" | "cycle" | "functional";
  /** Which relation this judgment comes from. To fix a wrongly declared axiom,
   *  start here and edit the ontology. */
  predicate: string | null;
  left_fact: string;
  left_text: string;
  /** For the self-loop kind, this equals left — one fact contradicts itself. */
  right_fact: string;
  right_text: string;
  /** The length of the cycle; 0 for the other three kinds. */
  path_len: number;
  detected_at: string;
}
/** A contradiction within the ontology itself. **This is a different thing
 *  from AxiomViolation**: that one states "a fact contradicts a definition,"
 *  this one states "the definition itself cannot hold" — a more fundamental
 *  problem. */
export interface OntologyDefect {
  id: string;
  kind:
    | "symmetric_and_asymmetric"
    | "transitive_and_functional"
    | "subclass_cycle"
    | "disjoint_with_ancestor"
    | "inherits_disjoint"
    // Three kinds added by ADR 0017, all on predicates: the first two concern
    // inverses, and the third is a sub-property cycle.
    | "inverse_of_itself"
    | "inverse_not_mutual"
    | "sub_property_cycle";
  subject_label: string | null;
  other_label: string | null;
  path_labels: string[];
  detected_at: string;
}
export interface FactReviewItem {
  id: string;
  subject_name: string;
  predicate_label: string | null;
  object_name: string | null;
  valid_from: string | null;
  valid_to: string | null;
  confidence: number;
  evidence_count: number;
  quote: string | null;
}

/** A temporal conflict — an old fact against a new fact, for cases automatic
 *  closing could not resolve confidently. */
export interface ConflictItem {
  id: string;
  reason: "no_time" | "simultaneous" | "low_confidence";
  created_at: string;
  predicate_label: string;
  old_fact_id: string;
  old_subject: string;
  old_object: string | null;
  old_valid_from: string | null;
  new_fact_id: string;
  new_subject: string;
  new_object: string | null;
  new_valid_from: string | null;
  new_confidence: number;
}

/** A decision-ledger event (a review-scoped slice of audit_events): detail is
 *  a self-contained snapshot taken at decision time. */
export interface ReviewHistoryEvent {
  id: string;
  action: string;
  target_kind: string;
  target_id: string | null;
  detail: Record<string, unknown>;
  /** null means the system (the AI adjudicator). */
  actor_name: string | null;
  created_at: string;
}

export interface MergeLog {
  id: string;
  source_name: string;
  target_name: string;
  merged_by_name: string | null;
  reason: string | null;
  created_at: string;
  reverted_at: string | null;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  /** The source text's own wording when the ontology does not recognize this
   *  relation; null when neither is available (old data from before migration
   *  0052). */
  predicate: string | null;
  label: string | null;
  /** true means this edge's name comes from the source text, not from a
   *  relation the ontology recognizes. */
  inferred: boolean;
  /** true means this edge is **derived**, not asserted by anyone (see ADR
   *  R1). This is a different thing from `inferred`: that one states "the name
   *  comes from the source text," this one states "no one stated this." */
  derived: boolean;
  /** The rule that derived this edge; null for an asserted edge. The
   *  interface uses this to recognize `inverse` — that kind of edge is two
   *  wordings of the same fact as its source edge, and drawing both would
   *  only draw the same redundancy twice (see `layOutParallelEdges` in
   *  Graph). */
  rule: string | null;
  /** The premise fact ids used to derive this edge, in proof order; empty for
   *  an asserted edge. Folding edges together relies on this to find the
   *  correct source edge — matching by node pair alone can attach a wording
   *  to the wrong edge. */
  premises: string[];
  valid_from: string | null;
  valid_to: string | null;
  confidence: number;
}

export interface EntityFact {
  id: string;
  direction: "out" | "in";
  /** Same as GraphEdge: a relation outside the ontology falls back to the
   *  source text's own wording; null when neither is available. */
  predicate_key: string | null;
  predicate_label: string | null;
  /** true means the name comes from the source text, not from a relation the
   *  ontology recognizes. */
  inferred: boolean;
  /** The relation's temporal category. Null when there is no predicate to
   *  categorize. */
  temporal: string | null;
  other_id: string | null;
  other_name: string | null;
  /** A literal-valued object (an attribute fact or a data mapping):
   *  {"value": ...} or {"summary": ...}. */
  object_value: Record<string, unknown> | null;
  valid_from: string | null;
  valid_to: string | null;
  valid_from_precision: string | null;
  /** year | month | day, plus unknown meaning the source text said this ended
   *  but did not say when. */
  valid_to_precision: string | null;
  confidence: number;
  evidence_count: number;
  /** True when every piece of evidence still points to an old version of its
   *  source document (not confirmed by the current content; this does not
   *  mean the fact is invalid). */
  stale: boolean;
  /** A correction row: the interval closed through engine reconciliation or a
   *  human decision, not stated verbatim in the source text. */
  corrected: boolean;
  /** The latest document time among this fact's evidence (the "last
   *  confirmed" time for an open-ended fact). */
  last_evidence_time: string | null;
}

/** One change in an entity's record (an event on the recording timeline,
 *  orthogonal to EntityFact's validity timeline).
 *
 * Not every event comes from a fact: retyped and retype_reverted come from
 * the retype ledger, with no predicate, no other party, and no direction. */
export interface EntityHistoryEvent {
  /** Present only for a fact event; null for a retype event. */
  fact_id: string | null;
  /** The recording moment: recorded_at for a write, invalidated_at for a
   *  retraction, and the moment of the change for a retype. */
  at: string;
  kind:
    | "asserted"
    | "corrected"
    | "rejected"
    | "merged"
    | "retyped"
    | "retype_reverted";
  direction: "out" | "in" | null;
  predicate_label: string | null;
  other_name: string | null;
  object_value: Record<string, unknown> | null;
  valid_from: string | null;
  valid_to: string | null;
  valid_from_precision: string | null;
  /** year | month | day, plus unknown meaning the source text said this ended
   *  but did not say when. */
  valid_to_precision: string | null;
  confidence: number | null;
  /** null means the engine acted automatically (a write during extraction,
   *  temporal reconciliation closing an interval, or a high-confidence
   *  automatic retype). */
  actor_name: string | null;
  action: string | null;
  document_id: string | null;
  filename: string | null;
  quote: string | null;
  /** The two sides of a retype event. A null starting side means it changed
   *  from "unclassified" — the most common case after ADR 0009. */
  from_type_label: string | null;
  to_type_label: string | null;
}

export interface Evidence {
  /** The predicate wording the model actually used for this chunk. A
   *  predicate outside the ontology does not attach to a relation, so this is
   *  what the interface shows. */
  proposed_predicate: string | null;
  quote: string | null;
  chunk_id: string;
  document_id: string;
  filename: string;
  seq: number;
  /** Which version of the document this evidence comes from. */
  doc_version: number;
  /** True when the document has a newer version (this evidence points to an
   *  old version; this does not mean the fact is invalid). */
  stale: boolean;
}

export interface ChunkFull {
  id: string;
  seq: number;
  text: string;
}

export interface EntityTypeView {
  id: string;
  key: string;
  label: string;
  color: string;
  shape: "circle" | "square";
  builtin: boolean;
  /** Every parent class (subClassOf can have more than one). */
  parents: string[];
  /** The classes this class is mutually exclusive with: **declares "cannot
   *  also be."** */
  disjoint: string[];
  /** Which branch this class hangs under when the left rail draws the tree.
   *  This has no semantic effect; it only controls display. */
  primary_parent: string | null;
  description: string;
  usage: number;
}

export interface RelationTypeView {
  id: string;
  key: string;
  label: string;
  temporal: string;
  functional: boolean;
  inverse_functional: boolean;
  /** The other four OWL axioms. **All the reasoning engine's judgments come
   *  from these.** */
  is_transitive: boolean;
  is_symmetric: boolean;
  is_asymmetric: boolean;
  is_irreflexive: boolean;
  /** Two links to another relation: `p⁻¹ = q` and `p ⊑ q`. These are ids, not
   *  booleans, so the interface renders them as dropdowns. */
  inverse_of: string | null;
  sub_property_of: string | null;
  builtin: boolean;
  description: string;
  /** relation means the object is an entity; attribute means the object is a
   *  literal value. */
  kind: "relation" | "attribute";
  /** The classes that can be the subject. An attribute needs at least one; an
   *  empty list for a relation means no restriction. */
  domains: string[];
  /** The classes that can be the object. Meaningful only for a relation — an
   *  attribute's range is its datatype. */
  ranges: string[];
  datatype: "text" | "number" | "date" | "bool" | null;
  unit: string | null;
  usage: number;
}

export interface OntologyMiss {
  kind: "entity_type" | "relation_type";
  key: string;
  example: string | null;
  count: number;
}

/** `description` and `reason` are not the same thing: description goes
    verbatim into the extraction prompt, and is the model's only basis for
    judging "what belongs in this class"; reason is only for a person to read,
    stating "why this should be added." Feeding the wrong text into
    description turns that class into the next dumping ground — testing
    showed this is exactly how the "technology" class ended up overloaded. */
export interface OntologyProposals {
  entity_types: {
    key: string;
    label: string;
    description?: string;
    reason?: string;
  }[];
  relation_types: {
    key: string;
    label: string;
    temporal?: string;
    functional?: boolean;
    description?: string;
    reason?: string;
    /** Which surface-level wordings this relation merges together. Without
     *  this, there is nothing to reclassify the waiting facts against. */
    forms?: string[];
  }[];
  /**
   * A wording whose object is a literal value ("founding date = 2015").
   *
   * This is separate from relation_types because the two need different
   * things: an attribute has a datatype, and building it as a relation
   * instead would turn that value into a fake entity. domain is not included
   * here — the server derives it from the fact's subject type, and a wrong
   * guess would cause the whole entry to be discarded.
   */
  attribute_types?: {
    key: string;
    label: string;
    datatype?: string;
    unit?: string;
    description?: string;
    reason?: string;
    forms?: string[];
  }[];
  /**
   * The ontology **already has** this meaning; this only attaches a wording
   * to it.
   *
   * The difference from relation_types is that this creates nothing: growing
   * a second key for the same meaning would split that group of facts
   * permanently across two keys, and no one would recognize they were ever
   * the same thing.
   */
  map_to?: {
    key: string;
    /** Marked by the server: whether the target is a relation or an
     *  attribute. The two reclassification paths differ, and the model can
     *  only answer with one key, with no way to tell which kind it is. */
    kind?: string;
    forms?: string[];
    reason?: string;
  }[];
}

/** A wording the source text used, that the ontology does not have, so the
 *  resulting fact has no predicate. */
export interface ProposedPredicate {
  form: string;
  fact_count: number;
  example: string | null;
}

/** What happens to a class or property in this import. key_taken means the
 *  key already belongs to a different IRI: this is reported, and nothing
 *  changes. */
export interface PlannedItem {
  iri: string;
  key: string;
  label: string;
  has_description: boolean;
  disposition: "create" | "update" | "key_taken";
  functional?: boolean;
  conflict_with?: string | null;
}

/** The preview and the applied import return the same plan: clicking confirm
 *  makes exactly what was just previewed happen. */
export interface ImportPlan {
  format: string;
  triples: number;
  classes: PlannedItem[];
  relations: PlannedItem[];
  attributes: PlannedItem[];
  /** An axiom the file uses that this projection does not consume today,
   *  mapped to its count. This is not skipped — it is not projected yet. */
  unprojected: [string, number][];
  classes_without_description: number;
  functional_relations: number;
}

export interface OntologyImportView {
  id: string;
  filename: string;
  format: string;
  byte_size: number;
  summary: Record<string, unknown>;
  imported_by_name: string | null;
  imported_at: string;
}

export interface Source {
  n: number;
  /** Default means a document chunk reference; charter means the built-in
   *  manual (jumps to /docs/{slug}#{anchor}). */
  kind?: "charter";
  chunk_id?: string;
  document_id?: string;
  slug?: string;
  anchor?: string;
  heading?: string;
  filename: string;
  excerpt: string;
}

/** The action trace for an agentic chat turn (one entry per tool call). */
export interface ChatStep {
  kind: "search" | "docs" | "entity" | "facts" | "changes" | "query" | "tool";
  label: string;
  detail: string;
  /** How long the reply text was, in UTF-16 code units (the same unit as
   *  `string.length`), at the moment this step happened. This threads the
   *  trace back into the reply text, instead of stacking every step at the
   *  top. **A message recorded before this migration does not have this
   *  field** — it defaults to the old behavior of the whole trace showing at
   *  the top. */
  at?: number;
}

/** A conversation row (in Chat's left-hand list). */
export interface ConversationRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
}

/** A conversation message, including its stored action trace and sources,
 *  for replaying history. */
export interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  steps: ChatStep[];
  sources: Source[];
  created_at: string;
}

/** One group in the alert center (see ADR 0005): **several consecutive
 *  failures of the same kind**.
 *
 * Storage still keeps one row per failure; grouping happens when the server
 * reads them. This way, pagination counts groups, and a page boundary never
 * cuts a run of consecutive failures in half. */
export type AlertGroup = {
  kb_id: string | null;
  /** A system-level alert has no knowledge-base name. */
  kb_name: string | null;
  /** `source.sync_failed` / `llm.unreachable` and so on — the frontend looks
   *  up wording in i18n by this value. */
  kind: string;
  severity: "info" | "warning" | "error";
  /** How many failures are in this group. */
  count: number;
  /** How many of those the current user has not read. */
  unread: number;
  latest_at: string;
  /** Together with latest_at, this defines the group's range; marking as read
   *  sends this back unchanged. */
  earliest_at: string;
  /** A capped set of detail lines, newest first. */
  lines: { name?: string; error?: string; job?: string }[];
};

export const api = {
  health: () =>
    request<{ status: string; name: string; version: string }>(
      "/api/v1/health",
    ),
  me: () => request<User>("/api/v1/auth/me"),
  alerts: (o: { q?: string; limit?: number; offset?: number }) => {
    const p = new URLSearchParams();
    if (o.q?.trim()) p.set("q", o.q.trim());
    if (o.limit != null) p.set("limit", String(o.limit));
    if (o.offset) p.set("offset", String(o.offset));
    return request<{ items: AlertGroup[]; total: number }>(
      `/api/v1/alerts?${p}`,
    );
  },
  alertsUnread: () => request<{ unread: number }>("/api/v1/alerts/unread"),
  alertReadGroup: (g: {
    kb_id: string | null;
    kind: string;
    from: string;
    to: string;
  }) =>
    request<{ marked: number }>("/api/v1/alerts/read-group", {
      method: "POST",
      body: JSON.stringify(g),
    }),
  alertsReadAll: () =>
    request<{ ok: boolean }>("/api/v1/alerts/read-all", { method: "POST" }),
  login: (email: string, password: string) =>
    request<{ user: User }>("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  register: (email: string, password: string, displayName: string) =>
    request<{ user: User; workspace: Workspace }>("/api/v1/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password, display_name: displayName }),
    }),
  logout: () =>
    request<{ ok: boolean }>("/api/v1/auth/logout", { method: "POST" }),
  updateMe: (displayName: string) =>
    request<User>("/api/v1/auth/me", {
      method: "PATCH",
      body: JSON.stringify({ display_name: displayName }),
    }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: boolean }>("/api/v1/auth/password", {
      method: "POST",
      body: JSON.stringify({
        current_password: currentPassword,
        new_password: newPassword,
      }),
    }),
  workspaces: () => request<Workspace[]>("/api/v1/workspaces"),

  kbs: (workspaceId: string) =>
    request<Kb[]>(`/api/v1/workspaces/${workspaceId}/kbs`),
  /** The audit ledger. **Paginated and filterable** — the ledger is compliance
   *  material, and showing only the most recent 100 entries would make
   *  history unreachable. `action` is a prefix: `entity.` matches the whole
   *  entity.retyped / entity.renamed family. */
  kbAudit: (
    kbId: string,
    opts: {
      action?: string;
      actor?: string;
      since?: string;
      until?: string;
      limit: number;
      offset: number;
    },
  ) => {
    const p = new URLSearchParams({
      limit: String(opts.limit),
      offset: String(opts.offset),
    });
    if (opts.action) p.set("action", opts.action);
    if (opts.actor) p.set("actor", opts.actor);
    if (opts.since) p.set("since", opts.since);
    if (opts.until) p.set("until", opts.until);
    return request<{
      events: AuditEvent[];
      total: number;
      /** The actions that actually occurred in this knowledge base; the
       *  filter dropdown fills in from this. */
      actions: string[];
    }>(`/api/v1/kbs/${kbId}/audit?${p}`);
  },
  myKbs: (workspaceId: string) =>
    request<{ kbs: MyKb[] }>(`/api/v1/workspaces/${workspaceId}/my-kbs`),
  createKb: (
    workspaceId: string,
    body: {
      name: string;
      description?: string | null;
      visibility?: string;
      /** The ids of prebuilt ontology packs. Order matters: the first pack
       *  claims any seed class with a matching name. */
      ontology_packs?: string[];
    },
  ) =>
    request<Kb>(`/api/v1/workspaces/${workspaceId}/kbs`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  ontologyPacks: () =>
    request<{ packs: OntologyPack[] }>("/api/v1/ontology-packs"),

  kbDetail: (kbId: string) => request<Kb>(`/api/v1/kbs/${kbId}`),
  updateKb: (kbId: string, body: Record<string, unknown>) =>
    request<Kb>(`/api/v1/kbs/${kbId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteKb: (kbId: string) =>
    request<{ ok: boolean }>(`/api/v1/kbs/${kbId}`, { method: "DELETE" }),
  kbMembers: (kbId: string) =>
    request<{ members: KbMember[] }>(`/api/v1/kbs/${kbId}/members`),
  setKbMember: (kbId: string, userId: string, role: string) =>
    request<{ ok: boolean }>(`/api/v1/kbs/${kbId}/members/${userId}`, {
      method: "PUT",
      body: JSON.stringify({ role }),
    }),
  removeKbMember: (kbId: string, userId: string) =>
    request<{ ok: boolean }>(`/api/v1/kbs/${kbId}/members/${userId}`, {
      method: "DELETE",
    }),

  adminDeployment: () =>
    request<{
      open_registration: boolean;
      /** An outer ceiling that stops jobs from piling up without bound; the
       *  real throttle is the per-model limit. */
      worker_concurrency: number;
      default_model_concurrency: number;
      /** The default ontology language for a newly created knowledge base.
       *  **This is not the interface language** — that setting lives on the
       *  client. */
      default_ontology_lang: "en" | "zh";
      model_limits: {
        base_url: string;
        model: string;
        max_concurrent: number;
      }[];
      models_in_use: { base_url: string; model: string; kind: string }[];
    }>("/api/v1/admin/deployment"),
  saveAdminDeployment: (
    openRegistration: boolean,
    workerConcurrency?: number,
    defaultModelConcurrency?: number,
    modelLimit?: {
      base_url: string;
      model: string;
      max_concurrent: number | null;
    },
    defaultOntologyLang?: "en" | "zh",
  ) =>
    request<{ ok: boolean }>("/api/v1/admin/deployment", {
      method: "PUT",
      body: JSON.stringify({
        open_registration: openRegistration,
        ...(workerConcurrency !== undefined
          ? { worker_concurrency: workerConcurrency }
          : {}),
        ...(defaultModelConcurrency !== undefined
          ? { default_model_concurrency: defaultModelConcurrency }
          : {}),
        ...(modelLimit ? { model_limit: modelLimit } : {}),
        ...(defaultOntologyLang
          ? { default_ontology_lang: defaultOntologyLang }
          : {}),
      }),
    }),
  adminCreateUser: (body: {
    email: string;
    display_name: string;
    password: string;
    role: string;
  }) =>
    request<{ user: User }>("/api/v1/admin/users", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  /** Deactivated accounts. **Without this endpoint, restoring one is out of
   *  reach** — that person disappears from every other list, and the restore
   *  endpoint needs exactly their id. */
  deactivatedUsers: () => request<OrgUser[]>("/api/v1/users/deactivated"),
  /** Restores one deactivated account. */
  adminReactivateUser: (userId: string) =>
    request<{ ok: boolean }>(`/api/v1/admin/users/${userId}`, {
      method: "POST",
    }),
  /** Deactivates an account (a soft delete). Attribution still resolves
   *  correctly afterward — the audit log, merge log, and retype ledger all
   *  depend on it. */
  adminDeactivateUser: (userId: string) =>
    request<{ ok: boolean }>(`/api/v1/admin/users/${userId}`, {
      method: "DELETE",
    }),
  adminDataSources: () =>
    request<{ data_sources: DataSourceView[] }>("/api/v1/admin/data-sources"),
  adminCreateDataSource: (body: { name: string; conn_string: string }) =>
    request<{ id: string }>("/api/v1/admin/data-sources", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  adminDeleteDataSource: (id: string) =>
    request<{ ok: boolean }>(`/api/v1/admin/data-sources/${id}`, {
      method: "DELETE",
    }),
  adminTestDataSource: (id: string) =>
    request<{ ok: boolean }>(`/api/v1/admin/data-sources/${id}/test`, {
      method: "POST",
    }),
  /** Which workspaces this source is granted to (see ADR 0014). Grant and
   *  mount are two separate layers: a deployment admin writes the grant, and
   *  a knowledge-base admin chooses which granted source to mount. */
  dataSourceGrants: (id: string) =>
    request<{ workspaces: { id: string; name: string }[] }>(
      `/api/v1/admin/data-sources/${id}/grants`,
    ),
  grantDataSource: (id: string, workspaceId: string) =>
    request<{ ok: boolean }>(
      `/api/v1/admin/data-sources/${id}/grants/${workspaceId}`,
      { method: "PUT" },
    ),
  /** Revokes a grant. **This also unmounts the source from every knowledge
   *  base in that workspace that had mounted it**, and returns how many. */
  revokeDataSource: (id: string, workspaceId: string) =>
    request<{ ok: boolean; unmounted: number }>(
      `/api/v1/admin/data-sources/${id}/grants/${workspaceId}`,
      { method: "DELETE" },
    ),

  /** One page of mapping definitions. **A viewer can read this** — Ask's
   *  answers are decided directly by these definitions, and seeing an answer
   *  without seeing the definition behind it would ask a person to trust an
   *  algorithm they cannot inspect. */
  mappings: (
    kbId: string,
    opts: {
      status?: "proposed" | "confirmed" | "rejected";
      q?: string;
      limit?: number;
      offset?: number;
    } = {},
  ) => {
    const p = new URLSearchParams();
    if (opts.status) p.set("status", opts.status);
    if (opts.q) p.set("q", opts.q);
    if (opts.limit != null) p.set("limit", String(opts.limit));
    if (opts.offset != null) p.set("offset", String(opts.offset));
    const qs = p.toString();
    return request<{
      items: ConceptMapping[];
      total: number;
      counts: { proposed: number; confirmed: number; rejected: number };
    }>(`/api/v1/kbs/${kbId}/mappings${qs ? `?${qs}` : ""}`);
  },
  /** Revises one mapping definition. The version before the change is saved
   *  to revisions automatically. */
  reviseMapping: (
    kbId: string,
    mappingId: string,
    body: {
      table_name?: string | null;
      expr?: string | null;
      sql?: string | null;
      unit?: string | null;
      summary?: string | null;
      derived: boolean;
    },
  ) =>
    request<{ ok: boolean }>(`/api/v1/kbs/${kbId}/mappings/${mappingId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  mappingRevisions: (kbId: string, mappingId: string) =>
    request<{ revisions: MappingRevision[] }>(
      `/api/v1/kbs/${kbId}/mappings/${mappingId}/revisions`,
    ),
  kbDataSources: (kbId: string) =>
    request<{ data_sources: DataSourceView[] }>(
      `/api/v1/kbs/${kbId}/data-sources`,
    ),
  kbDataSourcesAvailable: (kbId: string) =>
    request<{ data_sources: DataSourceView[] }>(
      `/api/v1/kbs/${kbId}/data-sources/available`,
    ),
  /** Mounts a data source. **A non-empty `schema_error` does not mean the
   *  mount failed** — the source really is mounted; only its schema was not
   *  ingested, so Ask cannot see which tables exist. The same event also
   *  appears in the alert center. */
  mountDataSource: (kbId: string, dsId: string) =>
    request<{
      ok: boolean;
      schema_tables: number;
      schema_error?: string | null;
    }>(`/api/v1/kbs/${kbId}/data-sources/${dsId}`, {
      method: "PUT",
    }),
  unmountDataSource: (kbId: string, dsId: string) =>
    request<{ ok: boolean }>(`/api/v1/kbs/${kbId}/data-sources/${dsId}`, {
      method: "DELETE",
    }),
  exploreMappings: (kbId: string) =>
    request<{ ok: boolean }>(`/api/v1/kbs/${kbId}/data-sources/explore`, {
      method: "POST",
    }),
  syncDataSourceSchema: (kbId: string, dsId: string) =>
    request<{ ok: boolean; schema_tables: number }>(
      `/api/v1/kbs/${kbId}/data-sources/${dsId}/sync-schema`,
      { method: "POST" },
    ),

  /** One page of the document library. **The server does filtering and paging.**
   *  The old code fetched the whole library and sliced it in the frontend.
   *  Client-side filtering can only filter documents already fetched. */
  documents: (
    kbId: string,
    opts: {
      source?: string;
      q?: string;
      graph?: string;
      limit: number;
      offset: number;
    },
  ) => {
    const p = new URLSearchParams({
      limit: String(opts.limit),
      offset: String(opts.offset),
    });
    if (opts.source) p.set("source", opts.source);
    if (opts.q) p.set("q", opts.q);
    if (opts.graph) p.set("graph", opts.graph);
    return request<{
      docs: Doc[];
      total: number;
      /** The next three counts **use only the source scope**. Name and status
       *  filters do not affect them. They mark the scope of the batch buttons. */
      ready: number;
      extracting: number;
      failed: number;
    }>(`/api/v1/kbs/${kbId}/documents?${p}`);
  },
  /** Retries all extraction-failed documents in this scope, with one action. */
  retryFailedDocs: (kbId: string, source?: string) =>
    request<{ queued: number; found: number }>(
      `/api/v1/kbs/${kbId}/documents/retry-failed${source ? `?source=${source}` : ""}`,
      { method: "POST" },
    ),
  /** Fetches the whole library at once. Rows aggregate by (document x reason
   *  x object), so the row count stays small. This avoids one request per row. */
  extractionDrops: (kbId: string) =>
    request<{ drops: ExtractionDrop[] }>(
      `/api/v1/kbs/${kbId}/extraction-drops`,
    ),
  upload: (kbId: string, files: File[], sourceId?: string) => {
    const form = new FormData();
    for (const f of files) form.append("files", f, f.name);
    const qs = sourceId ? `?source=${sourceId}` : "";
    return request<{ created: Doc[]; skipped: unknown[] }>(
      `/api/v1/kbs/${kbId}/documents${qs}`,
      { method: "POST", body: form },
    );
  },
  deleteDocument: (id: string) =>
    request<{ ok: boolean }>(`/api/v1/documents/${id}`, { method: "DELETE" }),

  search: (kbId: string, q: string) =>
    request<{ results: SearchResult[] }>(`/api/v1/kbs/${kbId}/search`, {
      method: "POST",
      body: JSON.stringify({ q }),
    }),

  settings: (workspaceId: string) =>
    request<LlmSettingsView>(`/api/v1/workspaces/${workspaceId}/settings`),
  saveSettings: (workspaceId: string, body: Record<string, unknown>) =>
    request<{ ok: boolean }>(`/api/v1/workspaces/${workspaceId}/settings`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  graphOverview: (kbId: string, limit?: number) =>
    request<{
      nodes: GraphNode[];
      edges: GraphEdge[];
      /** The total count in the knowledge base. **This differs from
       *  `nodes.length`.** The canvas draws only the highest-degree nodes.
       *  This field used to show the limit as the total, which was misleading. */
      total_nodes?: number;
      total_edges?: number;
    }>(`/api/v1/kbs/${kbId}/graph/overview${limit ? `?limit=${limit}` : ""}`),
  /** The neighborhood view **has no total count**. It shows only a small
   *  slice, so a total count has no meaning here. Both fields are optional,
   *  so callers can share one type with the overview response. */
  graphNeighborhood: (kbId: string, entityId: string) =>
    request<{
      nodes: GraphNode[];
      edges: GraphEdge[];
      total_nodes?: number;
      total_edges?: number;
    }>(`/api/v1/kbs/${kbId}/graph/neighborhood?entity=${entityId}&hops=2`),
  /** Finds entities by name. **The response also returns the total count.**
   *  The "split rather than merge" rule creates many entities with the same
   *  name. With a fixed page of ten results, the wanted entity may not
   *  appear in that page. */
  searchEntities: (kbId: string, q: string, limit = 10) =>
    request<{ entities: GraphNode[]; total: number }>(
      `/api/v1/kbs/${kbId}/entities?q=${encodeURIComponent(q)}&limit=${limit}`,
    ),
  entityDetail: (kbId: string, entityId: string) =>
    request<{
      entity: GraphNode;
      facts: EntityFact[];
      /** Inferred facts use **a separate key**, not mixed into `facts`. If
       *  the two lists mixed together, the user could not tell facts stated
       *  in a document from facts derived by the reasoning engine. */
      derived: DerivedFact[];
      /** Other entities with the same name. **This loads with the panel.**
       *  The merge action must appear where the user can see the duplicate
       *  names, not hidden behind a separate "rename" step. */
      same_name: GraphNode[];
    }>(`/api/v1/kbs/${kbId}/entities/${entityId}`),
  /** Change history for an entity (the recorded-time timeline). The server pages this list. */
  /** Manually corrects the type or the name of an entity. This does not
   *  block on same-name entities; the returned `same_name` field lets the UI
   *  prompt for a merge. */
  updateEntity: (
    kbId: string,
    entityId: string,
    body: { type_id?: string; canonical_name?: string },
  ) =>
    request<{ entity: GraphNode; same_name: GraphNode[] }>(
      `/api/v1/kbs/${kbId}/entities/${entityId}`,
      { method: "PATCH", body: JSON.stringify(body) },
    ),

  entityHistory: (kbId: string, entityId: string, page: number, per = 30) =>
    request<{ events: EntityHistoryEvent[]; total: number }>(
      `/api/v1/kbs/${kbId}/entities/${entityId}/history?page=${page}&per=${per}`,
    ),
  factEvidence: (kbId: string, factId: string) =>
    request<{ evidence: Evidence[] }>(
      `/api/v1/kbs/${kbId}/facts/${factId}/evidence`,
    ),
  documentDetail: (id: string) =>
    request<{ document: Doc; chunks: ChunkFull[] }>(`/api/v1/documents/${id}`),
  extractDocument: (id: string) =>
    request<{ job_id: number }>(`/api/v1/documents/${id}/extract`, {
      method: "POST",
    }),
  reprocessDocument: (id: string) =>
    request<{ job_id: number }>(`/api/v1/documents/${id}/reprocess`, {
      method: "POST",
    }),
  /** Re-extracts all data from one source. This is incremental: existing decisions stay in place. */
  reExtractSource: (kbId: string, sourceId: string) =>
    request<{ queued: number }>(
      `/api/v1/kbs/${kbId}/sources/${sourceId}/re-extract`,
      {
        method: "POST",
      },
    ),
  /** Rebuilds the graph. This clears the graph layer, then re-extracts all data. Requires KB admin rights. */
  rebuildGraph: (kbId: string) =>
    request<{
      entities_removed: number;
      facts_removed: number;
      queued: number;
    }>(`/api/v1/kbs/${kbId}/graph/rebuild`, { method: "POST" }),

  ontology: (kbId: string) =>
    request<{
      entity_types: EntityTypeView[];
      relation_types: RelationTypeView[];
      misses: OntologyMiss[];
      /** Dismissed misses, with their counts, which keep accumulating.
       *  Suppression still applies; only the visibility changes. */
      dismissed_misses: OntologyMiss[];
    }>(`/api/v1/kbs/${kbId}/ontology`),
  createEntityType: (kbId: string, body: Record<string, unknown>) =>
    request<{ id: string }>(`/api/v1/kbs/${kbId}/ontology/entity-types`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateEntityType: (kbId: string, id: string, body: Record<string, unknown>) =>
    request<{ ok: boolean }>(
      `/api/v1/kbs/${kbId}/ontology/entity-types/${id}`,
      {
        method: "PATCH",
        body: JSON.stringify(body),
      },
    ),
  deleteEntityType: (kbId: string, id: string) =>
    request<{ ok: boolean }>(
      `/api/v1/kbs/${kbId}/ontology/entity-types/${id}`,
      {
        method: "DELETE",
      },
    ),
  typeEntities: (kbId: string, typeId: string, page: number, per = 12) =>
    request<{
      entities: { id: string; name: string; fact_count: number }[];
      total: number;
    }>(
      `/api/v1/kbs/${kbId}/ontology/entity-types/${typeId}/entities?page=${page}&per=${per}`,
    ),
  createRelationType: (kbId: string, body: Record<string, unknown>) =>
    request<{ id: string }>(`/api/v1/kbs/${kbId}/ontology/relation-types`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateRelationType: (
    kbId: string,
    id: string,
    body: Record<string, unknown>,
  ) =>
    request<{ ok: boolean }>(
      `/api/v1/kbs/${kbId}/ontology/relation-types/${id}`,
      {
        method: "PATCH",
        body: JSON.stringify(body),
      },
    ),
  deleteRelationType: (kbId: string, id: string) =>
    request<{ ok: boolean }>(
      `/api/v1/kbs/${kbId}/ontology/relation-types/${id}`,
      {
        method: "DELETE",
      },
    ),
  /** The last computed proposals, still awaiting a decision (ADR 0049). The
   *  page reload uses this stored result, so it does not rerun the model. */
  storedProposals: (kbId: string) =>
    request<OntologyProposals>(`/api/v1/kbs/${kbId}/ontology/proposals`),
  /** Records a decision on one proposal. This updates the status and does
   *  not delete the row. A rejected proposal stays on record, so the next
   *  Suggest run does not show it again as pending. */
  decideProposal: (
    kbId: string,
    section: string,
    key: string,
    status: "adopted" | "rejected",
  ) =>
    request<{ ok: boolean }>(`/api/v1/kbs/${kbId}/ontology/proposals`, {
      method: "POST",
      body: JSON.stringify({ section, key, status }),
    }),
  dismissMiss: (kbId: string, kind: string, key: string) =>
    request<{ ok: boolean }>(`/api/v1/kbs/${kbId}/ontology/misses/dismiss`, {
      method: "POST",
      body: JSON.stringify({ kind, key }),
    }),
  restoreMiss: (kbId: string, kind: string, key: string) =>
    request<{ ok: boolean }>(`/api/v1/kbs/${kbId}/ontology/misses/restore`, {
      method: "POST",
      body: JSON.stringify({ kind, key }),
    }),
  /** The `reason` field is for a human reader, and that reader is on the
   *  caller's end of this request. So the caller states the language; the
   *  server setting does not decide it (see ADR 0004). The `description`
   *  field follows the knowledge base language, which the server already knows. */
  suggestOntology: (kbId: string) =>
    request<OntologyProposals>(`/api/v1/kbs/${kbId}/ontology/suggest`, {
      method: "POST",
      body: JSON.stringify({ locale: lang }),
    }),

  /** Uploads an ontology file and computes a plan only. This writes nothing to the database. */
  previewOntologyImport: (kbId: string, file: File) => {
    const form = new FormData();
    form.append("file", file, file.name);
    return request<{ filename: string; plan: ImportPlan }>(
      `/api/v1/kbs/${kbId}/ontology/imports/preview`,
      { method: "POST", body: form },
    );
  },
  /** Applies the plan the user just previewed. The server recomputes the
   *  plan, so the preview and apply paths share the same code. */
  applyOntologyImport: (kbId: string, file: File) => {
    const form = new FormData();
    form.append("file", file, file.name);
    return request<{ import_id: string; plan: ImportPlan }>(
      `/api/v1/kbs/${kbId}/ontology/imports`,
      { method: "POST", body: form },
    );
  },
  ontologyImports: (kbId: string) =>
    request<{ imports: OntologyImportView[] }>(
      `/api/v1/kbs/${kbId}/ontology/imports`,
    ),

  proposedPredicates: (kbId: string) =>
    request<{ forms: ProposedPredicate[] }>(
      `/api/v1/kbs/${kbId}/ontology/proposed-predicates`,
    ),
  /** The last automatic ontology extension, and whether the user can still
   *  undo it. If the undo already happened, this returns `null`. */
  lastAutoExtension: (kbId: string) =>
    request<{
      run: {
        at: string;
        relations: string[] | null;
        classes: string[] | null;
        facts_remapped: number | null;
        batches: string[];
      } | null;
    }>(`/api/v1/kbs/${kbId}/ontology/auto-extension`),
  /** Creates a relation type **and** assigns the waiting no-predicate facts
   *  to it. The second part is the main benefit of this call. */
  adoptPredicate: (
    kbId: string,
    body: {
      key: string;
      /** `true` means the key refers to an existing relation or attribute.
       *  This only rewrites facts and does not create a new type. */
      existing?: boolean;
      /** `attribute` uses a different rewrite path: it converts the value by datatype. */
      kind?: "relation" | "attribute";
      datatype?: string;
      unit?: string;
      label?: string;
      temporal?: string;
      functional?: boolean;
      description?: string;
      forms: string[];
    },
  ) =>
    request<{
      id: string;
      remapped: number;
      batch: string;
      /** The count of facts that were not rewritten, because their value did
       *  not convert to the target datatype. Reporting only the rewritten
       *  count would hide these dropped facts. */
      unconvertible?: number;
    }>(`/api/v1/kbs/${kbId}/ontology/adopt-predicate`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /** Undoes one adoption. The newly written rows become void, and the old
   *  rows become active again. The relation type stays in place. */
  unadoptPredicate: (kbId: string, batchId: string) =>
    request<{ reverted: number }>(
      `/api/v1/kbs/${kbId}/ontology/adopt-predicate/${batchId}`,
      { method: "DELETE" },
    ),

  sources: (kbId: string) =>
    request<{ sources: SourceView[] }>(`/api/v1/kbs/${kbId}/sources`),
  createSource: (kbId: string, body: Record<string, unknown>) =>
    request<{ source: SourceView; ingest_token?: string | null }>(
      `/api/v1/kbs/${kbId}/sources`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    ),
  sourceToken: (kbId: string, sourceId: string) =>
    request<{ ingest_token: string | null }>(
      `/api/v1/kbs/${kbId}/sources/${sourceId}/token`,
    ),
  rotateSourceToken: (kbId: string, sourceId: string) =>
    request<{ ingest_token: string }>(
      `/api/v1/kbs/${kbId}/sources/${sourceId}/rotate-token`,
      { method: "POST" },
    ),
  updateSource: (
    kbId: string,
    sourceId: string,
    body: Record<string, unknown>,
  ) =>
    request<{ source: SourceView }>(`/api/v1/kbs/${kbId}/sources/${sourceId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteSource: (kbId: string, sourceId: string) =>
    request<{ ok: boolean }>(`/api/v1/kbs/${kbId}/sources/${sourceId}`, {
      method: "DELETE",
    }),
  cleanupMissing: (kbId: string, sourceId: string) =>
    request<{ deleted: number }>(
      `/api/v1/kbs/${kbId}/sources/${sourceId}/missing/cleanup`,
      {
        method: "POST",
      },
    ),
  syncSource: (kbId: string, sourceId: string) =>
    request<{ queued: boolean }>(
      `/api/v1/kbs/${kbId}/sources/${sourceId}/sync`,
      {
        method: "POST",
      },
    ),
  sourceRuns: (kbId: string, sourceId: string) =>
    request<{ runs: SyncRun[] }>(
      `/api/v1/kbs/${kbId}/sources/${sourceId}/runs`,
    ),
  documentExtractions: (docId: string) =>
    request<{ facts: ChunkFact[] }>(`/api/v1/documents/${docId}/extractions`),

  /** The **exact count** for each review queue tab. This call is separate
   *  from the list call, because the list has a page limit and the count
   *  does not. A badge that read the array length used to show 100 for a
   *  queue of 164, because the list endpoint always returns at most 100 rows. */
  review: (kbId: string, queue: ReviewQueue, limit: number, offset: number) =>
    request<{
      counts: ReviewCounts;
      queue: ReviewQueue;
      /** One page from the current queue only. The item type depends on the
       *  queue; each caller narrows the type by queue. */
      items: unknown[];
    }>(
      `/api/v1/kbs/${kbId}/review?queue=${queue}&limit=${limit}&offset=${offset}`,
    ),
  closeFact: (kbId: string, factId: string, validTo: string) =>
    request<{ ok: boolean }>(`/api/v1/kbs/${kbId}/facts/${factId}/close`, {
      method: "POST",
      body: JSON.stringify({ valid_to: validTo }),
    }),
  resolveConflict: (
    kbId: string,
    conflictId: string,
    body: { action: "close" | "keep" | "reject_new"; close_at?: string },
  ) =>
    request<{ ok: boolean }>(`/api/v1/kbs/${kbId}/conflicts/${conflictId}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  decideReview: (kbId: string, reviewId: string, action: "merge" | "keep") =>
    request<{ ok: boolean }>(`/api/v1/kbs/${kbId}/review/${reviewId}`, {
      method: "POST",
      body: JSON.stringify({ action }),
    }),
  /** Records a decision on one data mapping (ADR 0011). This updates the
   *  status and does not delete the row. A rejected mapping stays on
   *  record, so the next discovery run does not propose it again. */
  decideMapping: (
    kbId: string,
    mappingId: string,
    status: "confirmed" | "rejected",
  ) =>
    request<{ ok: boolean }>(
      `/api/v1/kbs/${kbId}/review/mappings/${mappingId}`,
      {
        method: "POST",
        body: JSON.stringify({ status }),
      },
    ),
  /** Runs a consistency check. This call returns synchronously, because it
   *  is pure computation with no model call and no network access. */
  runConsistencyCheck: (kbId: string) =>
    request<{
      edges: number;
      /** **Zero is not the same as zero here**: with no axioms, the
       *  conclusion is "no criterion to check", not "no conflict found". */
      predicates_with_axioms: number;
      found: number;
      inserted: number;
      cleared: number;
      classes: number;
      /** Ontology defects return in a **separate field**, not added into
       *  `found`. The two counts measure different kinds of problems. */
      defects_found: number;
      defects_new: number;
    }>(`/api/v1/kbs/${kbId}/consistency/check`, { method: "POST" }),
  /** Records a decision on one ontology defect. **This has two outcomes.**
   *  This check never looks at the data, so "the data is wrong" is not an
   *  outcome here. */
  decideDefect: (
    kbId: string,
    defectId: string,
    resolution: "fixed" | "accepted",
  ) =>
    request<{ ok: boolean }>(`/api/v1/kbs/${kbId}/review/defects/${defectId}`, {
      method: "POST",
      body: JSON.stringify({ resolution }),
    }),
  /** Runs the reasoning engine (R1). When the setting is off, the server returns `inference_off`. */
  /** Type resolution: **this computes only and writes nothing**. The
   *  response carries the profile sent to the search step. When the search
   *  finds nothing, check this profile first, to see what the search used. */
  /** Manual merge: merges `source` into `target`. **The direction matters.**
   *  The source entity disappears, and its facts move to the target entity.
   *  A merge can roll back as a whole, because `entity_merges` stores a snapshot. */
  mergeEntities: (kbId: string, source: string, target: string) =>
    request<{ ok: boolean }>(`/api/v1/kbs/${kbId}/entities/merge`, {
      method: "POST",
      body: JSON.stringify({ source, target }),
    }),
  typeResolutionPreview: (kbId: string) =>
    request<{ items: TypeSuggestion[] }>(
      `/api/v1/kbs/${kbId}/ontology/type-resolution/preview`,
      { method: "POST" },
    ),
  /** Runs type resolution and writes the result to the database. The
   *  response separates three groups: automatic changes, cases left for a
   *  human, and cases marked "none of these". */
  typeResolutionApply: (kbId: string) =>
    request<ResolutionOutcome>(`/api/v1/kbs/${kbId}/ontology/type-resolution`, {
      method: "POST",
    }),
  /** Approves one "coarse type to fine type" pair, and retypes the given
   *  entities. **The approval applies to the type pair; the change applies
   *  to the entities.** After one approval, the same pair skips manual review. */
  approveRefinement: (
    kbId: string,
    body: { from_type_id: string; to_type_id: string; entity_ids: string[] },
  ) =>
    request<{ retyped: number }>(
      `/api/v1/kbs/${kbId}/ontology/type-resolution/approve`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  /** Undoes a whole batch: reverts the affected entities to their previous type. */
  typeResolutionUndo: (kbId: string, batchId: string) =>
    request<{ reverted: number }>(
      `/api/v1/kbs/${kbId}/ontology/type-resolution/${batchId}`,
      { method: "DELETE" },
    ),
  runInference: (kbId: string) =>
    request<{
      /** The count of compiled rules. A count of zero means "no rules
       *  exist", not "the engine found nothing to derive". */
      rules: number;
      edges: number;
      derived: number;
      inserted: number;
      /** The count of facts invalidated because their premise no longer holds. */
      invalidated: number;
      /** The count of predicates that hit the single-predicate limit and did not finish reasoning. */
      capped: number;
    }>(`/api/v1/kbs/${kbId}/inference/run`, { method: "POST" }),
  /** Records a decision on one axiom violation. There are three outcomes.
   *  The third outcome is unique to this queue: the axiom definition may be wrong. */
  decideViolation: (
    kbId: string,
    violationId: string,
    resolution: "fact_retracted" | "axiom_relaxed" | "accepted",
  ) =>
    request<{ ok: boolean }>(
      `/api/v1/kbs/${kbId}/review/violations/${violationId}`,
      { method: "POST", body: JSON.stringify({ resolution }) },
    ),
  confirmFact: (kbId: string, factId: string) =>
    request<{ ok: boolean }>(`/api/v1/kbs/${kbId}/facts/${factId}/confirm`, {
      method: "POST",
    }),
  rejectFact: (kbId: string, factId: string) =>
    request<{ ok: boolean }>(`/api/v1/kbs/${kbId}/facts/${factId}/reject`, {
      method: "POST",
    }),
  revertMerge: (kbId: string, mergeId: string) =>
    request<{ ok: boolean }>(`/api/v1/kbs/${kbId}/merges/${mergeId}/revert`, {
      method: "POST",
    }),
  reviewHistory: (kbId: string, page: number, per = 20) =>
    request<{ events: ReviewHistoryEvent[]; total: number }>(
      `/api/v1/kbs/${kbId}/review/history?page=${page}&per=${per}`,
    ),

  members: (workspaceId: string) =>
    request<Member[]>(`/api/v1/workspaces/${workspaceId}/members`),
  orgUsers: () => request<OrgUser[]>("/api/v1/users"),
  setMemberRole: (workspaceId: string, userId: string, role: string) =>
    request<{ ok: boolean }>(
      `/api/v1/workspaces/${workspaceId}/members/${userId}`,
      {
        method: "PUT",
        body: JSON.stringify({ role }),
      },
    ),
  removeMember: (workspaceId: string, userId: string) =>
    request<{ ok: boolean }>(
      `/api/v1/workspaces/${workspaceId}/members/${userId}`,
      {
        method: "DELETE",
      },
    ),

  testSettings: (workspaceId: string) =>
    request<{
      chat: { ok: boolean; reply?: string; error?: string };
      embed: { ok: boolean; dim?: number; error?: string };
    }>(`/api/v1/workspaces/${workspaceId}/settings/test`, { method: "POST" }),
};

/** RAG conversations: streamed over SSE. Returns an abort function. */
export const conversationsApi = {
  /** **This list supports search and paging.** Titles can repeat, because
   *  asking the same question twice creates a repeated title. Beyond a
   *  fixed page of one hundred, older conversations do not appear in the
   *  UI at all. The search covers both the title and the message text,
   *  because a user often remembers the question asked, not the title. */
  list: (kbId: string, q = "", limit = 30, offset = 0) => {
    const p = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
    });
    if (q.trim()) p.set("q", q.trim());
    return request<{ conversations: ConversationRow[]; total: number }>(
      `/api/v1/kbs/${kbId}/conversations?${p}`,
    );
  },
  /** Renames a conversation. The title starts as an automatic copy of the
   *  first message, but a conversation often drifts away from that topic. */
  rename: (kbId: string, id: string, title: string) =>
    request<{ ok: boolean }>(`/api/v1/kbs/${kbId}/conversations/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),
  detail: (kbId: string, id: string) =>
    request<{ messages: ConversationMessage[] }>(
      `/api/v1/kbs/${kbId}/conversations/${id}`,
    ),
  remove: (kbId: string, id: string) =>
    request<{ ok: boolean }>(`/api/v1/kbs/${kbId}/conversations/${id}`, {
      method: "DELETE",
    }),
};

export interface ChatHandlers {
  onConversation: (id: string) => void;
  onSources: (s: Source[]) => void;
  onStep: (s: ChatStep) => void;
  onDelta: (text: string) => void;
  onDone: () => void;
  onError: (message: string) => void;
  /** Attaches to a reply already in progress: this is its current state.
   *  **This replaces the content; it does not append to it.** */
  onSnapshot?: (s: { content: string; steps: ChatStep[]; sources: Source[] }) => void;
  /** This conversation has no reply in progress. This is the most common
   *  case, not an error. */
  onIdle?: () => void;
}

/** Attaches to a reply that is still generating (used after a page reload).
 *
 *  This reads the same event stream as `streamChat`, with one extra
 *  snapshot event at the start. */
export function reattachChat(
  kbId: string,
  conversationId: string,
  handlers: ChatHandlers,
): () => void {
  return consumeChatStream(
    (signal) =>
      fetch(`/api/v1/kbs/${kbId}/conversations/${conversationId}/stream`, {
        credentials: "include",
        signal,
      }),
    handlers,
  );
}

export function streamChat(
  kbId: string,
  body: { conversation_id?: string; message: string },
  handlers: ChatHandlers,
): () => void {
  return consumeChatStream(
    (signal) =>
      fetch(`/api/v1/kbs/${kbId}/chat`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      }),
    handlers,
  );
}

/** There is only one way to read the SSE stream. The request differs; the handling after receipt is identical. */
function consumeChatStream(
  open: (signal: AbortSignal) => Promise<Response>,
  handlers: ChatHandlers,
): () => void {
  const controller = new AbortController();
  (async () => {
    try {
      const res = await open(controller.signal);
      if (!res.ok || !res.body) {
        let message = res.statusText;
        try {
          const body = (await res.json()) as { error?: string };
          if (body.error) message = body.error;
        } catch {
          /* ignore */
        }
        handlers.onError(message);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let event = "message";
          let data = "";
          for (const line of frame.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          if (event === "conversation")
            handlers.onConversation((JSON.parse(data) as { id: string }).id);
          else if (event === "sources")
            handlers.onSources(JSON.parse(data || "[]"));
          else if (event === "step")
            handlers.onStep(JSON.parse(data) as ChatStep);
          else if (event === "delta")
            handlers.onDelta((JSON.parse(data) as { text: string }).text);
          else if (event === "snapshot") handlers.onSnapshot?.(JSON.parse(data));
          else if (event === "idle") handlers.onIdle?.();
          else if (event === "done") handlers.onDone();
          else if (event === "error") handlers.onError(data);
        }
      }
      handlers.onDone();
    } catch (e) {
      if (!controller.signal.aborted) handlers.onError(String(e));
    }
  })();
  return () => controller.abort();
}

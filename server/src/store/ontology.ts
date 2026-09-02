/**
 * Ontology editor store: class/relation CRUD (with usage counts and delete
 * protection), plus unmatched-wording statistics.
 */

import { q, qOne, qOpt, exec, type Sql } from "../core/db";
import { AppError } from "../core/errors";
import { newId, type Uuid } from "../core/ids";
import { log } from "../core/log";
import { colorForKey, shapeFor } from "./palette";

export interface EntityTypeView {
  id: Uuid;
  key: string;
  label: string;
  color: string;
  shape: string;
  builtin: boolean;
  parents: Uuid[];
  primary_parent: Uuid | null;
  disjoint: Uuid[];
  description: string;
  usage: number;
}

interface UsageRow {
  count: string | number;
}

export async function entity_type_views(sql: Sql, kb_id: Uuid): Promise<EntityTypeView[]> {
  return q<EntityTypeView>(
    sql,
    `SELECT t.id, t.key, t.label, t.color, t.shape, t.builtin, t.description,
                ARRAY(SELECT p.parent_id FROM entity_type_parents p
                      WHERE p.child_id = t.id) AS parents,
                (SELECT p.parent_id FROM entity_type_parents p
                  WHERE p.child_id = t.id AND p.is_primary) AS primary_parent,
                ARRAY(SELECT d.b_id FROM entity_type_disjoint d
                      WHERE d.kb_id = t.kb_id AND d.a_id = t.id) AS disjoint,
                (SELECT count(*) FROM entities e
                 WHERE e.type_id = t.id AND e.merged_into IS NULL) AS usage
         FROM entity_types t WHERE t.kb_id = $1 ORDER BY lower(t.label)`,
    [kb_id],
  ).then((rows) => rows.map((r) => ({ ...r, usage: Number(r.usage) })));
}

export interface EntityInstance {
  id: Uuid;
  name: string;
  fact_count: number;
}

/** The entity instances under a class (ordered by name, paginated). Returns [rows, total]. */
export async function entity_instances(
  sql: Sql,
  kb_id: Uuid,
  type_id: Uuid,
  limit: number,
  offset: number,
): Promise<[EntityInstance[], number]> {
  const rows = await q<EntityInstance>(
    sql,
    `SELECT e.id, e.canonical_name AS name,
                (SELECT count(*) FROM facts f
                 WHERE (f.subject_id = e.id OR f.object_id = e.id)
                   AND f.invalidated_at IS NULL) AS fact_count
         FROM entities e
         WHERE e.kb_id = $1 AND e.type_id = $2 AND e.merged_into IS NULL
         ORDER BY lower(e.canonical_name)
         LIMIT $3 OFFSET $4`,
    [kb_id, type_id, limit, offset],
  );
  const total_row = await qOne<UsageRow>(
    sql,
    `SELECT count(*) FROM entities e
         WHERE e.kb_id = $1 AND e.type_id = $2 AND e.merged_into IS NULL`,
    [kb_id, type_id],
  );
  return [rows.map((r) => ({ ...r, fact_count: Number(r.fact_count) })), Number(total_row.count)];
}

function validate_shape(shape: string): void {
  if (shape !== "circle" && shape !== "square") {
    throw AppError.validation("shape must be circle or square");
  }
}

export interface RelationTypeView {
  id: Uuid;
  key: string;
  label: string;
  temporal: string;
  functional: boolean;
  inverse_functional: boolean;
  is_transitive: boolean;
  is_symmetric: boolean;
  is_asymmetric: boolean;
  is_irreflexive: boolean;
  inverse_of: Uuid | null;
  sub_property_of: Uuid | null;
  builtin: boolean;
  description: string;
  kind: string;
  datatype: string | null;
  unit: string | null;
  domains: Uuid[];
  ranges: Uuid[];
  usage: number;
}

export async function relation_type_views(sql: Sql, kb_id: Uuid): Promise<RelationTypeView[]> {
  const rows = await q<RelationTypeView>(
    sql,
    `SELECT r.id, r.key, r.label, r.temporal, r.functional, r.inverse_functional,
                r.is_transitive, r.is_symmetric, r.is_asymmetric, r.is_irreflexive,
                r.inverse_of, r.sub_property_of,
                r.builtin, r.description,
                r.kind, r.datatype, r.unit,
                ARRAY(SELECT d.entity_type_id FROM relation_type_domains d
                      WHERE d.relation_type_id = r.id) AS domains,
                ARRAY(SELECT g.entity_type_id FROM relation_type_ranges g
                      WHERE g.relation_type_id = r.id) AS ranges,
                (SELECT count(*) FROM facts f
                 WHERE f.predicate_id = r.id AND f.invalidated_at IS NULL) AS usage
         FROM relation_types r WHERE r.kb_id = $1 ORDER BY lower(r.label)`,
    [kb_id],
  );
  return rows.map((r) => ({ ...r, usage: Number(r.usage) }));
}

function validate_key(key: string): void {
  const ok =
    key.length > 0 &&
    key.length <= 40 &&
    [...key].every((c) => (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c === "_");
  if (!ok) {
    throw AppError.invalid(
      "bad_key",
      "Key must be lowercase snake_case (a-z, 0-9, _), max 40 chars",
    );
  }
}

async function throwConflictOnUnique<T>(fn: () => Promise<T>, message: string): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AppError && e.kind === "Conflict") {
      throw AppError.conflict(message);
    }
    throw e;
  }
}

export async function create_entity_type(
  sql: Sql,
  kb_id: Uuid,
  key: string,
  label: string,
  color: string,
  shape: string,
  parents: Uuid[],
  description: string,
): Promise<Uuid> {
  validate_key(key);
  validate_shape(shape);
  const id = newId();
  await throwConflictOnUnique(
    () =>
      exec(
        sql,
        `INSERT INTO entity_types (id, kb_id, key, label, color, shape, description)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, kb_id, key, label, color, shape, description],
      ),
    `Type key '${key}' already exists`,
  );
  await set_parents(sql, kb_id, id, parents);
  return id;
}

/**
 * Edit an entity class.
 *
 * **`color: null` means keep the current color**, not reset it. This used
 * to take a plain string, and a caller that did not supply a color got a
 * hard-coded default gray-blue — so any rename without a color would erase
 * a color the user had picked.
 */
export async function update_entity_type(
  sql: Sql,
  kb_id: Uuid,
  id: Uuid,
  label: string,
  color: string | null,
  shape: string,
  parents: Uuid[],
  description: string,
): Promise<void> {
  validate_shape(shape);
  const res = await exec(
    sql,
    `UPDATE entity_types SET label = $3, color = COALESCE($4, color), shape = $5,
                description = $6
         WHERE id = $2 AND kb_id = $1`,
    [kb_id, id, label, color, shape, description],
  );
  if (res.count === 0) {
    throw AppError.notFound();
  }
  await set_parents(sql, kb_id, id, parents);
}

interface CycleCountRow {
  count: string | number;
}

/**
 * Set `parents` as the full set of this class's parents; the first one is
 * the primary parent (drawn under that branch in the left panel).
 *
 * **The cycle check runs before the write.** In the single-parent era, only
 * a self-loop needed blocking; a single chain can never form a cycle on its
 * own. In a DAG, A -> B -> A is entirely possible, and
 * `type_matches_domain` walks up the parent chain — a cycle there is an
 * infinite loop. SQL cannot stop this on its own: a foreign key only blocks
 * a self-loop; longer cycles need an application-level check.
 */
export async function set_parents(sql: Sql, kb_id: Uuid, child: Uuid, parents: Uuid[]): Promise<void> {
  if (parents.includes(child)) {
    throw AppError.invalid("self_parent", "A class cannot be its own parent");
  }
  if (parents.length > 0) {
    // If `child` shows up among the candidate parents' own ancestors, this
    // new edge would create a cycle.
    const cycles_row = await qOne<CycleCountRow>(
      sql,
      `WITH RECURSIVE up(id) AS (
                 SELECT unnest($2::uuid[])
                 UNION
                 SELECT p.parent_id FROM entity_type_parents p JOIN up ON p.child_id = up.id
             )
             SELECT count(*) FROM up WHERE id = $1`,
      [child, parents],
    );
    if (Number(cycles_row.count) > 0) {
      throw AppError.invalid("parent_cycle", "That parent is already a subclass of this one");
    }
  }
  await exec(sql, `DELETE FROM entity_type_parents WHERE child_id = $1`, [child]);
  for (let i = 0; i < parents.length; i++) {
    await exec(
      sql,
      `INSERT INTO entity_type_parents (child_id, parent_id, is_primary)
             VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      // The first parent becomes the primary parent: the UI explains "drawn
      // under the first one", so no extra control is needed.
      [child, parents[i], i === 0],
    );
  }
  void kb_id;
}

export async function delete_entity_type(sql: Sql, kb_id: Uuid, id: Uuid): Promise<void> {
  const usage_row = await qOne<UsageRow>(sql, `SELECT count(*) FROM entities WHERE type_id = $1`, [
    id,
  ]);
  const usage = Number(usage_row.count);
  if (usage > 0) {
    throw AppError.conflict(`Cannot delete: ${usage} entities use this type`);
  }
  // An attribute whose only domain is this class goes with it: an
  // attribute must be attached to a class, and leaving one with no domain
  // would leave a dead row that appears nowhere. One still attached to
  // another class only loses one link (a foreign key CASCADE handles that).
  await exec(
    sql,
    `DELETE FROM relation_types r
         WHERE r.kind = 'attribute' AND r.kb_id = $1
           AND EXISTS (SELECT 1 FROM relation_type_domains d
                       WHERE d.relation_type_id = r.id AND d.entity_type_id = $2)
           AND NOT EXISTS (SELECT 1 FROM relation_type_domains d
                           WHERE d.relation_type_id = r.id AND d.entity_type_id <> $2)`,
    [kb_id, id],
  );
  const res = await exec(
    sql,
    `DELETE FROM entity_types WHERE id = $2 AND kb_id = $1 AND NOT builtin`,
    [kb_id, id],
  );
  if (res.count === 0) {
    throw AppError.conflict("Built-in types cannot be deleted");
  }
}

/** Attribute field checks: an attribute needs a domain and a valid datatype; a relation forces both blank. */
function validate_attribute_fields(kind: string, domains: Uuid[], datatype: string | null): void {
  if (kind === "relation") {
    return;
  }
  if (kind === "attribute") {
    if (domains.length === 0) {
      throw AppError.invalid("attr_needs_class", "An attribute needs a class (domain)");
    }
    if (datatype !== "text" && datatype !== "number" && datatype !== "date" && datatype !== "bool") {
      throw AppError.validation("datatype must be text / number / date / bool");
    }
    return;
  }
  throw AppError.validation("kind must be relation / attribute");
}

export interface RelationAxioms {
  functional: boolean;
  inverse_functional: boolean;
  transitive: boolean;
  symmetric: boolean;
  asymmetric: boolean;
  irreflexive: boolean;
  inverse_of: Uuid | null;
  sub_property_of: Uuid | null;
}

/**
 * The two axioms that point at another relation must pass this check before
 * being written.
 *
 * **The most important rule is same-KB.** The column's foreign key is
 * `REFERENCES relation_types(id)`, which does not know about knowledge
 * bases — at the database level, a relation in KB A can point at a relation
 * in KB B. The RDF import path never hits this (it looks things up by IRI
 * within its own KB), but the API accepts a bare UUID: without this check,
 * any UUID would let the reasoner read axioms across KBs. **Restricting the
 * front-end's dropdown to this KB's own relations is not enough** — that is
 * UI courtesy, not a boundary.
 *
 * Two more rules: an attribute has no inverse (its object is a literal, so
 * "the other way around" makes no sense), and a sub-property cannot be
 * itself (the database has a CHECK for this, but hitting it produces a 500;
 * this gives a human-readable message instead). **A relation being its own
 * inverse is allowed** — that is the same as being symmetric, and the UI
 * suggests using `symmetric` instead; it is not wrong.
 */
async function validate_property_links(
  sql: Sql,
  kb_id: Uuid,
  self_id: Uuid | null,
  kind: string,
  ax: RelationAxioms,
): Promise<void> {
  const links = [ax.inverse_of, ax.sub_property_of];
  if (links.every((l) => l === null)) {
    return;
  }
  if (kind === "attribute") {
    throw AppError.invalid("attr_has_no_link", "An attribute cannot have an inverse or a super-property");
  }
  if (self_id !== null && ax.sub_property_of === self_id) {
    throw AppError.invalid("sub_property_self", "A relation cannot be its own super-property");
  }
  for (const target of links) {
    if (target === null) continue;
    const ok = await qOpt<{ kind: string }>(
      sql,
      `SELECT kind FROM relation_types WHERE id = $1 AND kb_id = $2`,
      [target, kb_id],
    );
    if (ok === null) {
      // Whether it is "does not exist" or "exists in a different KB" is
      // not distinguished: being able to probe which UUID exists elsewhere
      // is itself information that should not be given out.
      throw AppError.invalid("unknown_relation", "That relation is not in this knowledge base");
    } else if (ok.kind !== "relation") {
      throw AppError.invalid("link_target_is_attr", "An attribute cannot be an inverse or a super-property");
    }
  }
}

export async function create_relation_type(
  sql: Sql,
  kb_id: Uuid,
  key: string,
  label: string,
  temporal: string,
  ax: RelationAxioms,
  description: string,
  kind: string,
  domains: Uuid[],
  ranges: Uuid[],
  datatype: string | null,
  unit: string | null,
): Promise<Uuid> {
  validate_key(key);
  if (temporal !== "state" && temporal !== "event" && temporal !== "eternal") {
    throw AppError.validation("temporal must be state / event / eternal");
  }
  validate_attribute_fields(kind, domains, datatype);
  // The newly created row's id does not exist yet, so it cannot point at
  // itself — pass `self_id` as null.
  await validate_property_links(sql, kb_id, null, kind, ax);
  const is_attr = kind === "attribute";
  const id = newId();
  await throwConflictOnUnique(
    () =>
      exec(
        sql,
        `INSERT INTO relation_types (id, kb_id, key, label, temporal,
                                     functional, inverse_functional, description,
                                     kind, datatype, unit,
                                     is_transitive, is_symmetric,
                                     is_asymmetric, is_irreflexive,
                                     inverse_of, sub_property_of)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
                 $16, $17)`,
        [
          id,
          kb_id,
          key,
          label,
          temporal,
          ax.functional,
          ax.inverse_functional,
          description,
          kind,
          is_attr ? datatype : null,
          is_attr ? unit : null,
          ax.transitive,
          ax.symmetric,
          ax.asymmetric,
          ax.irreflexive,
          // An attribute does not carry these two (the check above already
          // rejects a non-empty value; this is a backstop).
          is_attr ? null : ax.inverse_of,
          is_attr ? null : ax.sub_property_of,
        ],
      ),
    `Relation key '${key}' already exists`,
  );
  // An attribute does not write a range: its value range is a literal
  // datatype, recorded in `datatype`.
  await set_domains_ranges(sql, id, domains, is_attr ? [] : ranges);
  return id;
}

/**
 * Overwrite the domain / range set. **Deletes first, then inserts**, so
 * this works for both a first creation and a re-import, and never leaves a
 * leftover from a previous run.
 */
async function set_domains_ranges(
  sql: Sql,
  relation_type_id: Uuid,
  domains: Uuid[],
  ranges: Uuid[],
): Promise<void> {
  const tables: [string, Uuid[]][] = [
    ["relation_type_domains", domains],
    ["relation_type_ranges", ranges],
  ];
  for (const [table, ids] of tables) {
    await exec(sql, `DELETE FROM ${table} WHERE relation_type_id = $1`, [relation_type_id]);
    if (ids.length === 0) {
      continue;
    }
    // A single `unnest` insert, saving a round trip per row.
    await exec(
      sql,
      `INSERT INTO ${table} (relation_type_id, entity_type_id)
             SELECT $1, x FROM unnest($2::uuid[]) AS x
             ON CONFLICT DO NOTHING`,
      [relation_type_id, ids],
    );
  }
}

export async function update_relation_type(
  sql: Sql,
  kb_id: Uuid,
  id: Uuid,
  label: string,
  temporal: string,
  ax: RelationAxioms,
  description: string,
  datatype: string | null,
  unit: string | null,
  // null = do not touch. The caller for the attribute form passes null for
  // whichever field it does not manage, so an unrelated rename does not
  // clear the attribute's domain.
  domains: Uuid[] | null,
  ranges: Uuid[] | null,
): Promise<void> {
  if (temporal !== "state" && temporal !== "event" && temporal !== "eternal") {
    throw AppError.validation("temporal must be state / event / eternal");
  }
  if (
    datatype !== null &&
    datatype !== "text" &&
    datatype !== "number" &&
    datatype !== "date" &&
    datatype !== "bool"
  ) {
    throw AppError.validation("datatype must be text / number / date / bool");
  }
  // The two links that point at another relation must be checked against
  // the database first: does the target exist in this KB, is it a
  // relation. Only check when a value is actually supplied — clearing both
  // to null has no target to validate.
  if (ax.inverse_of !== null || ax.sub_property_of !== null) {
    const row = await qOpt<{ kind: string }>(
      sql,
      `SELECT kind FROM relation_types WHERE id = $1 AND kb_id = $2`,
      [id, kb_id],
    );
    if (row === null) throw AppError.notFound();
    await validate_property_links(sql, kb_id, id, row.kind, ax);
  }
  // `kind` cannot change (changing it would confuse the meaning of
  // existing facts). Domain/range can change — they are a signature, not
  // an identity; "this attribute also applies to contractors" is a
  // legitimate edit. `datatype`/`unit` only take effect on an attribute
  // row; `datatype` keeps its old value when not supplied.
  //
  // Both link columns are **overwritten together with the six axiom
  // bits**: the default is to clear, not "leave unchanged" — the same rule
  // as `is_transitive` and its neighbors. They are declared together on
  // one form; overwriting half and preserving half is exactly the
  // combination that causes real bugs.
  const res = await exec(
    sql,
    `UPDATE relation_types
            SET label = $3, temporal = $4,
                functional = $5, inverse_functional = $6, description = $7,
                datatype = CASE WHEN kind = 'attribute' AND $8 IS NOT NULL THEN $8 ELSE datatype END,
                unit = CASE WHEN kind = 'attribute' THEN $9 ELSE unit END,
                is_transitive = $10, is_symmetric = $11,
                is_asymmetric = $12, is_irreflexive = $13,
                inverse_of = $14, sub_property_of = $15
         WHERE id = $2 AND kb_id = $1`,
    [
      kb_id,
      id,
      label,
      temporal,
      ax.functional,
      ax.inverse_functional,
      description,
      datatype,
      unit,
      ax.transitive,
      ax.symmetric,
      ax.asymmetric,
      ax.irreflexive,
      ax.inverse_of,
      ax.sub_property_of,
    ],
  );
  if (res.count === 0) {
    throw AppError.notFound();
  }
  if (domains !== null || ranges !== null) {
    const kind_row = await qOne<{ kind: string }>(
      sql,
      `SELECT kind FROM relation_types WHERE id = $1`,
      [id],
    );
    const next_domains = domains ?? [];
    if (kind_row.kind === "attribute" && next_domains.length === 0) {
      throw AppError.invalid("attr_needs_class", "An attribute needs a class (domain)");
    }
    // An attribute has no range: its value range is a literal datatype,
    // recorded in `datatype`.
    const next_ranges: Uuid[] = kind_row.kind === "attribute" ? [] : (ranges ?? []);
    await set_domains_ranges(sql, id, next_domains, next_ranges);
  }
}

export async function delete_relation_type(sql: Sql, kb_id: Uuid, id: Uuid): Promise<void> {
  const usage_row = await qOne<UsageRow>(sql, `SELECT count(*) FROM facts WHERE predicate_id = $1`, [
    id,
  ]);
  const usage = Number(usage_row.count);
  if (usage > 0) {
    throw AppError.conflict(`Cannot delete: ${usage} facts use this relation`);
  }
  const res = await exec(
    sql,
    `DELETE FROM relation_types WHERE id = $2 AND kb_id = $1 AND NOT builtin`,
    [kb_id, id],
  );
  if (res.count === 0) {
    throw AppError.conflict("Built-in relations cannot be deleted");
  }
}

/* ---- Unmatched-wording statistics ---- */

export async function record_miss(
  sql: Sql,
  kb_id: Uuid,
  kind: string,
  key: string,
  example: string | null,
): Promise<void> {
  await exec(
    sql,
    // **A dismissed wording still gets counted.**
    //
    // This used to carry `WHERE dismissed_at IS NULL`, on the reasoning
    // "otherwise the count would push a dismissed wording back into view".
    // That reasoning targets **display**, but the mechanism used was
    // **stop counting** — the two got tied together, and the cost was one
    // click causing permanent blindness: a wording seen once in the first
    // document, then used in the next twenty, still shows a count of 1, and
    // nobody can tell that the original judgment no longer holds; those
    // facts stay on the fallback predicate forever.
    //
    // A user judges based on **the evidence visible at the time**, not all
    // time forever. So the count keeps accumulating; suppressing it is a
    // job for the read side: `list_misses` still returns only the
    // undismissed ones, so the proposal flow and the automatic
    // ontology-extension flow are unchanged; the dismissed ones, with their
    // updated counts, go through `list_dismissed_misses`, listed separately
    // in the panel so a person seeing the count climb to 40 can undo it.
    `INSERT INTO ontology_misses (kb_id, kind, key, example)
         VALUES ($1, $2, left($3, 80), left($4, 200))
         ON CONFLICT (kb_id, kind, key)
         DO UPDATE SET count = ontology_misses.count + 1,
                       example = COALESCE(EXCLUDED.example, ontology_misses.example),
                       updated_at = now()`,
    [kb_id, kind, key, example],
  );
}

export interface OntologyMiss {
  kind: string;
  key: string;
  example: string | null;
  count: number;
}

export async function list_misses(sql: Sql, kb_id: Uuid): Promise<OntologyMiss[]> {
  return q<OntologyMiss>(
    sql,
    `SELECT kind, key, example, count FROM ontology_misses
         WHERE kb_id = $1 AND dismissed_at IS NULL
         ORDER BY count DESC, updated_at DESC LIMIT 50`,
    [kb_id],
  );
}

/**
 * Dismissed wordings, together with **the count they kept accumulating**.
 *
 * This list exists because dismissing used to be a one-way door: once
 * clicked, a wording was never shown or counted again, so once "it only
 * showed up once at the time" stopped being true, nobody could tell.
 * This list is the window on that door: suppression still applies, but you
 * can see what is suppressed and how much weight it has now.
 */
export async function list_dismissed_misses(sql: Sql, kb_id: Uuid): Promise<OntologyMiss[]> {
  return q<OntologyMiss>(
    sql,
    `SELECT kind, key, example, count FROM ontology_misses
         WHERE kb_id = $1 AND dismissed_at IS NOT NULL
         ORDER BY count DESC, updated_at DESC LIMIT 50`,
    [kb_id],
  );
}

/** Undo a dismissal: this wording re-enters proposals and automatic ontology extension. */
export async function restore_miss(sql: Sql, kb_id: Uuid, kind: string, key: string): Promise<void> {
  await exec(
    sql,
    `UPDATE ontology_misses SET dismissed_at = NULL, updated_at = now()
         WHERE kb_id = $1 AND kind = $2 AND key = $3 AND dismissed_at IS NOT NULL`,
    [kb_id, kind, key],
  );
}

/**
 * The user says "not this one". **Marked, not deleted** — deleting it would
 * mean the next extraction run inserts the same word right back, so the
 * user's rejection would not survive one extraction pass. The automatic
 * extension path also honors this.
 *
 * Reversible (see `restore_miss`), and the count stays continuous after a
 * restore — it kept recording while dismissed.
 */
export async function dismiss_miss(sql: Sql, kb_id: Uuid, kind: string, key: string): Promise<void> {
  await exec(
    sql,
    `UPDATE ontology_misses SET dismissed_at = now()
         WHERE kb_id = $1 AND kind = $2 AND key = $3 AND dismissed_at IS NULL`,
    [kb_id, kind, key],
  );
}

/**
 * The ontology already covers this wording (call this on adoption): unlike
 * "user rejected", this one can really be cleared — the next extraction run
 * will match it in the ontology and it will no longer be unmatched.
 */
export async function clear_miss(sql: Sql, kb_id: Uuid, kind: string, key: string): Promise<void> {
  await exec(sql, `DELETE FROM ontology_misses WHERE kb_id = $1 AND kind = $2 AND key = $3`, [
    kb_id,
    kind,
    key,
  ]);
}

/* ---- OWL import ---- */

/** Create a class carrying an IRI. The IRI is its global identity; a re-import matches on it (see 0001 P2). */
export async function create_entity_type_with_iri(
  sql: Sql,
  kb_id: Uuid,
  key: string,
  label: string,
  description: string,
  iri: string,
): Promise<Uuid> {
  validate_key(key);
  const id = newId();
  await throwConflictOnUnique(
    () =>
      exec(
        sql,
        `INSERT INTO entity_types (id, kb_id, key, label, color, shape, description, iri)
         VALUES ($1, $2, $3, $4, $7, $8, $5, $6)`,
        [
          id,
          kb_id,
          key,
          label,
          description,
          iri,
          // Color by key, instead of one shared gray-blue for every
          // automatically created class — otherwise importing a large
          // ontology produces a graph with nothing to look at.
          colorForKey(key),
          // The shape states its origin: this path carries an IRI, so it
          // is declared by a vocabulary.
          shapeFor(iri),
        ],
      ),
    `Type key '${key}' already exists`,
  );
  return id;
}

/**
 * On re-import, update label and description by IRI. **The key does not
 * move** — it may already be referenced by extracted entities and by the
 * prompt; changing it would break existing references. The upstream label
 * changing is normal; the IRI is the identity.
 */
export async function update_type_from_import(
  sql: Sql,
  kb_id: Uuid,
  iri: string,
  label: string,
  description: string,
): Promise<Uuid | null> {
  const row = await qOpt<{ id: Uuid }>(
    sql,
    `UPDATE entity_types
         SET label = $3,
             -- An empty description does not overwrite an existing one:
             -- upstream may not have written an rdfs:comment, and the
             -- local one may already have been tuned to this corpus — that
             -- tuning is worth more than an empty value.
             description = CASE WHEN $4 = '' THEN description ELSE $4 END
         WHERE kb_id = $1 AND iri = $2 RETURNING id`,
    [kb_id, iri, label, description],
  );
  return row?.id ?? null;
}

/**
 * Create an attribute from an import (`kind = 'attribute'`), carrying an
 * IRI.
 *
 * The difference from `create_relation_type` is just the `iri` and how a
 * key collision is handled: an import identifies by IRI, so a colliding
 * key means "two different things fighting over one short label"; the
 * caller reports and skips it at the planning stage, so it should never
 * collide here — on collision this returns null instead of overwriting, so
 * the caller can count it as "skipped".
 *
 * `temporal` is fixed to `state`: an attribute is a value that changes over
 * time (salary, headcount); a new value closing the old one is exactly what
 * is wanted. OWL has no matching concept; guessing event or eternal would
 * be worse either way.
 */
export async function create_attribute_with_iri(
  sql: Sql,
  kb_id: Uuid,
  key: string,
  label: string,
  description: string,
  iri: string,
  domains: Uuid[],
  datatype: string,
): Promise<Uuid | null> {
  validate_key(key);
  const id = newId();
  const row = await qOpt<{ id: Uuid }>(
    sql,
    `INSERT INTO relation_types
             (id, kb_id, key, label, temporal, functional, inverse_functional,
              description, kind, datatype, iri)
         VALUES ($1, $2, $3, $4, 'state', FALSE, FALSE, $5, 'attribute', $6, $7)
         ON CONFLICT (kb_id, key) DO NOTHING
         RETURNING id`,
    [id, kb_id, key, label, description, datatype, iri],
  );
  if (row === null) {
    return null;
  }
  await set_domains_ranges(sql, row.id, domains, []);
  return row.id;
}

/**
 * Create a relation from an import (`kind = 'relation'`), carrying an IRI.
 *
 * `temporal` is fixed to `state`: OWL has no matching concept, and `state`
 * (which carries an interval) is the only one of the three that loses no
 * information — `event` would collapse an interval to a point, `eternal`
 * would claim it never changes.
 *
 * **`functional` / `inverse_functional` are written exactly as the
 * vocabulary declares.** They drive the temporal engine's automatic closure
 * of old facts; guessing wrong manufactures conflicts in bulk (`part_of`
 * once produced 59 of them). The preview already lists relations declared
 * functional separately for a human to review, so this no longer overrides
 * them to false on its own.
 */
export async function create_relation_with_iri(
  sql: Sql,
  kb_id: Uuid,
  key: string,
  label: string,
  description: string,
  iri: string,
  functional: boolean,
  inverse_functional: boolean,
  domains: Uuid[],
  ranges: Uuid[],
): Promise<Uuid | null> {
  validate_key(key);
  const id = newId();
  const row = await qOpt<{ id: Uuid }>(
    sql,
    `INSERT INTO relation_types
             (id, kb_id, key, label, temporal, functional, inverse_functional,
              description, kind, iri)
         VALUES ($1, $2, $3, $4, 'state', $5, $6, $7, 'relation', $8)
         ON CONFLICT (kb_id, key) DO NOTHING
         RETURNING id`,
    [id, kb_id, key, label, functional, inverse_functional, description, iri],
  );
  if (row === null) {
    return null;
  }
  await set_domains_ranges(sql, row.id, domains, ranges);
  return row.id;
}

/**
 * On re-import, update a relation already claimed by IRI.
 *
 * **The key does not move** (it may already be referenced by facts).
 * **An empty description does not overwrite** (a human-written one is more
 * accurate than upstream's). **Domain/range are fully overwritten** — they
 * are the structure the upstream vocabulary declares, not wording a human
 * has tuned.
 */
export async function update_relation_from_import(
  sql: Sql,
  kb_id: Uuid,
  iri: string,
  label: string,
  description: string,
  domains: Uuid[],
  ranges: Uuid[],
): Promise<boolean> {
  const row = await qOpt<{ id: Uuid }>(
    sql,
    `UPDATE relation_types
            SET label = $3,
                description = CASE WHEN $4 = '' THEN description ELSE $4 END
          WHERE kb_id = $1 AND iri = $2
          RETURNING id`,
    [kb_id, iri, label, description],
  );
  if (row === null) {
    return false;
  }
  await set_domains_ranges(sql, row.id, domains, ranges);
  return true;
}

/** Record one import. The original file is already content-addressed in blob storage; this is just the ledger entry. */
export async function record_import(
  sql: Sql,
  kb_id: Uuid,
  sha256: string,
  filename: string,
  format: string,
  byte_size: number,
  summary: unknown,
  actor: Uuid,
): Promise<Uuid> {
  const id = newId();
  await exec(
    sql,
    `INSERT INTO ontology_imports
            (id, kb_id, sha256, filename, format, byte_size, summary, imported_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, kb_id, sha256, filename, format, byte_size, summary, actor],
  );
  return id;
}

export interface OntologyImportView {
  id: Uuid;
  filename: string;
  format: string;
  byte_size: number;
  summary: unknown;
  imported_at: Date;
  imported_by_name: string | null;
}

/** A KB's import history (with the importer's display name; null once the account is removed). */
export async function list_imports(sql: Sql, kb_id: Uuid): Promise<OntologyImportView[]> {
  const rows = await q<OntologyImportView & { byte_size: string | number }>(
    sql,
    `SELECT i.id, i.filename, i.format, i.byte_size, i.summary, i.imported_at,
                u.display_name AS imported_by_name
         FROM ontology_imports i
         LEFT JOIN users u ON u.id = i.imported_by
         WHERE i.kb_id = $1 ORDER BY i.imported_at DESC LIMIT 50`,
    [kb_id],
  );
  return rows.map((r) => ({ ...r, byte_size: Number(r.byte_size) }));
}

/**
 * One ontology row waiting to be embedded. `text` is the text sent for
 * embedding; `kind` decides which table the vector is written back to.
 */
export interface TypeToEmbed {
  id: Uuid;
  kind: TypeKind;
  text: string;
  /**
   * Which pair of columns to write. A class has two vectors: the full
   * profile (label + description) and a label-only one, serving two
   * different query shapes — a long profile and a short wording (see
   * `entity_types.label_embedding`).
   */
  field: EmbedField;
}

/**
 * The two vectors of one row. **A short query is compared against Label, a
 * long profile against Full** — queries come in two shapes, so the
 * documents must too, otherwise a short query would be won by a
 * self-describing class (the "Map\nA map." kind of row).
 */
export enum EmbedField {
  Full = "full",
  Label = "label",
}

/** Which table an ontology row belongs to: a class goes into `entity_types`; a relation and an attribute share `relation_types`. */
export enum TypeKind {
  Entity = "entity",
  Relation = "relation",
}

/**
 * The text to embed: the label first, then the description.
 *
 * **The key is not included.** The key is a token the model reads and
 * writes (`founding_date`); the description is where this type's meaning
 * lives. Mixing the key in would let retrieval get misled by two keys that
 * merely look alike — and `position` (list rank) and `position` (job title)
 * look exactly alike.
 */
function embed_text(label: string, description: string): string {
  const d = description.trim();
  if (d.length === 0) {
    return label.trim();
  }
  return `${label.trim()}\n${d}`;
}

/**
 * Which ontology rows have a stale vector (never embedded, description
 * changed, or the embedding model changed).
 *
 * The check compares the text and model name **at the time it was
 * embedded**, not a timestamp: a changed description or a changed model
 * would not show up in a timestamp either way. This also avoids needing a
 * hook at every write site that touches a description — missing just one
 * would quietly go stale.
 *
 * `only` limits this to half the work. Type resolution only uses classes;
 * making it wait for 1,633 relations to finish embedding wastes six
 * minutes for nothing. The background top-up job has no such limit — both
 * sides top up the same rows, and whichever gets there first counts.
 */
export async function types_needing_embedding(
  sql: Sql,
  kb_id: Uuid,
  model: string,
  only: TypeKind | null,
): Promise<TypeToEmbed[]> {
  const out: TypeToEmbed[] = [];
  if (only === TypeKind.Relation) {
    // Type resolution only uses classes; waiting for 1,633 relations to
    // finish embedding wastes six minutes for nothing.
    return relations_needing_embedding(sql, kb_id, model);
  }
  const ents = await q<{ id: Uuid; label: string; coalesce: string }>(
    sql,
    `SELECT id, label, coalesce(description, '') FROM entity_types
         WHERE kb_id = $1
           AND (embedding IS NULL
                OR embedded_model IS DISTINCT FROM $2
                OR embedded_text IS DISTINCT FROM
                   CASE WHEN coalesce(btrim(description), '') = '' THEN btrim(label)
                        ELSE btrim(label) || E'\n' || btrim(description) END)`,
    [kb_id, model],
  );
  for (const e of ents) {
    out.push({
      id: e.id,
      kind: TypeKind.Entity,
      text: embed_text(e.label, e.coalesce),
      field: EmbedField.Full,
    });
  }
  // The label-only vector (see `entity_types.label_embedding`). A short
  // query goes through this index — queries come in two shapes, so the
  // documents must too, or a short query would be won by a
  // self-describing class.
  const labels = await q<{ id: Uuid; label: string }>(
    sql,
    `SELECT id, label FROM entity_types
         WHERE kb_id = $1
           AND (label_embedding IS NULL
                OR label_embedded_model IS DISTINCT FROM $2
                OR label_embedded_text IS DISTINCT FROM btrim(label))`,
    [kb_id, model],
  );
  for (const e of labels) {
    out.push({
      id: e.id,
      kind: TypeKind.Entity,
      text: e.label.trim(),
      field: EmbedField.Label,
    });
  }
  if (only === TypeKind.Entity) {
    return out;
  }
  out.push(...(await relations_needing_embedding(sql, kb_id, model)));
  return out;
}

async function relations_needing_embedding(sql: Sql, kb_id: Uuid, model: string): Promise<TypeToEmbed[]> {
  const out: TypeToEmbed[] = [];
  const rels = await q<{ id: Uuid; label: string; coalesce: string }>(
    sql,
    `SELECT id, label, coalesce(description, '') FROM relation_types
         WHERE kb_id = $1
           AND (embedding IS NULL
                OR embedded_model IS DISTINCT FROM $2
                OR embedded_text IS DISTINCT FROM
                   CASE WHEN coalesce(btrim(description), '') = '' THEN btrim(label)
                        ELSE btrim(label) || E'\n' || btrim(description) END)`,
    [kb_id, model],
  );
  for (const r of rels) {
    out.push({
      id: r.id,
      kind: TypeKind.Relation,
      text: embed_text(r.label, r.coalesce),
      // A relation has no short-query side, only this one full-text
      // vector.
      field: EmbedField.Full,
    });
  }
  return out;
}

function vector_param(v: number[]): string {
  return `[${v.join(",")}]`;
}

/**
 * Write vectors back, together with what text was embedded and which model
 * was used. All three must be written in the same pass — writing only the
 * vector without its source makes the next run think it is still stale,
 * causing a re-embed every single round.
 */
export async function set_type_embeddings(
  sql: Sql,
  model: string,
  items: [TypeToEmbed, number[]][],
): Promise<void> {
  await sql.begin(async (tx_raw) => {
    const tx = tx_raw as unknown as Sql;
    for (const [item, emb] of items) {
      const table = item.kind === TypeKind.Entity ? "entity_types" : "relation_types";
      // Each of the two vectors writes its own columns (see
      // `entity_types.label_embedding`); only the column prefix differs.
      const [vec_col, text_col, model_col] =
        item.field === EmbedField.Full
          ? ["embedding", "embedded_text", "embedded_model"]
          : ["label_embedding", "label_embedded_text", "label_embedded_model"];
      await exec(
        tx,
        `UPDATE ${table} SET ${vec_col} = $2, ${text_col} = $3, ${model_col} = $4
             WHERE id = $1`,
        [item.id, vector_param(emb), item.text, model],
      );
    }
  });
}

export interface TypeCandidate {
  id: Uuid;
  key: string;
  label: string;
  description: string;
  kind: string | null;
  distance: number;
}

/**
 * The k nearest entity classes to a given vector.
 *
 * **A class with no description and no place on the class tree does not
 * take part.** Importing a vocabulary creates a row for every external IRI
 * referenced by `domainIncludes` / `rangeIncludes` / `equivalentClass`
 * (OMG, UNECE, GS1, ...); those rows have no real label text, no parent, no
 * child — they are not vocabulary, they are dangling references.
 *
 * They happen to win easily: `embed_text` falls back to embedding just the
 * label when the description is empty, so a row like this embeds a single
 * word: "Location". The short side's distance is systematically smaller
 * (the same pattern has bitten this file and type resolution three times
 * already), so an empty shell outscores `administrative_area` with its
 * 83-character definition — measured: this is exactly how "Hangzhou
 * Gongshu District" got lost.
 *
 * And even if it were surfaced, nobody could judge it: the reviewer would
 * see `- location (location)` with no definition to go on. A KB with the
 * schema.org pack has 50 such rows, 43 of them with not even one
 * inheritance edge.
 *
 * **This only excludes them as candidates; it does not delete the rows**:
 * domain/range still point at them, and deleting would break those
 * references.
 */
export async function nearest_entity_types(
  sql: Sql,
  kb_id: Uuid,
  embedding: number[],
  limit: number,
  // true = compare against the label-only vector (see
  // `entity_types.label_embedding`). A short wording takes this path:
  // **short against short**, otherwise "district. place" would lose to a
  // self-describing row like "Map\nA map.".
  by_label: boolean,
): Promise<TypeCandidate[]> {
  const col = by_label ? "label_embedding" : "embedding";
  const rows = await q<{
    id: Uuid;
    key: string;
    label: string;
    coalesce: string;
    float8: number;
  }>(
    sql,
    `SELECT id, key, label, coalesce(description, ''), (${col} <=> $2)::float8
         FROM entity_types t
         WHERE t.kb_id = $1 AND t.${col} IS NOT NULL
           AND (coalesce(btrim(t.description), '') <> ''
                OR EXISTS (SELECT 1 FROM entity_type_parents p
                           WHERE p.child_id = t.id OR p.parent_id = t.id))
         ORDER BY ${col} <=> $2
         LIMIT $3`,
    [kb_id, vector_param(embedding), limit],
  );
  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    label: r.label,
    description: r.coalesce,
    kind: null,
    distance: r.float8,
  }));
}

/**
 * The k nearest relations/attributes to a given vector.
 *
 * `only_kind` splits the search: a fact with a literal object needs an
 * attribute, one with an entity object needs a relation. Without the
 * split, `founding_date` would get suggested for a fact whose object is an
 * entity, and the reverse would also happen.
 */
export async function nearest_relation_types(
  sql: Sql,
  kb_id: Uuid,
  embedding: number[],
  limit: number,
  only_kind: string | null,
): Promise<TypeCandidate[]> {
  const rows = await q<{
    id: Uuid;
    key: string;
    label: string;
    coalesce: string;
    kind: string;
    float8: number;
  }>(
    sql,
    `SELECT id, key, label, coalesce(description, ''), kind, (embedding <=> $2)::float8
         FROM relation_types
         WHERE kb_id = $1 AND embedding IS NOT NULL
           AND ($4::text IS NULL OR kind = $4)
         ORDER BY embedding <=> $2
         LIMIT $3`,
    [kb_id, vector_param(embedding), limit, only_kind],
  );
  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    label: r.label,
    description: r.coalesce,
    kind: r.kind,
    distance: r.float8,
  }));
}

/**
 * Find a relation/attribute id by key. Used by the "map to an existing
 * type" path.
 *
 * `kind` is not checked: an attribute and a relation share one table and
 * one key namespace; once the caller has the id, it already knows how to
 * use it (when rewriting a fact, the predicate is the predicate).
 */
export async function relation_type_id_by_key(sql: Sql, kb_id: Uuid, key: string): Promise<Uuid | null> {
  const row = await qOpt<{ id: Uuid }>(
    sql,
    `SELECT id FROM relation_types WHERE kb_id = $1 AND key = $2`,
    [kb_id, key],
  );
  return row?.id ?? null;
}

/**
 * The declared datatype of an attribute. Used to convert a literal fact's
 * value when it is rewritten.
 *
 * **This KB's own row wins over the request**: when pointing at an
 * existing attribute, the request has no datatype at all; even if it did,
 * the ontology has the final say.
 */
export async function relation_type_datatype(sql: Sql, id: Uuid): Promise<string | null> {
  const row = await qOpt<{ datatype: string | null }>(
    sql,
    `SELECT datatype FROM relation_types WHERE id = $1`,
    [id],
  );
  return row?.datatype ?? null;
}

/**
 * Claim an IRI onto an existing **local** class (one that had no IRI).
 *
 * **This only writes the IRI and the shape; it does not touch the label,
 * description, or color.** Claiming solves "this tree is disconnected", not
 * "replace the user's wording with the vocabulary's wording": a seed
 * class's description has been tuned for extraction and follows the KB's
 * language, while schema.org's description is generic English boilerplate.
 * Overwriting it would quietly replace the single most load-bearing
 * sentence in the extraction prompt.
 *
 * **The shape must change too, because the shape states origin** (square =
 * declared by a vocabulary, circle = grown from the corpus). A class
 * claimed as "declared by a vocabulary" that still draws as a circle would
 * be a picture contradicting itself. This gap has been hit in practice:
 * importing schema.org into a KB that already had `person` /
 * `organization` — those classes got an IRI but stayed circles, an IRI yet
 * still a circle, self-contradictory.
 *
 * The color does not change: color is **identity** (the same key always
 * gets the same color); claiming does not change who it is. Shape is
 * **origin**, and claiming is exactly what changes that.
 *
 * This only writes when `iri IS NULL`, so re-importing is idempotent and
 * will never steal a class already claimed by another vocabulary.
 */
export async function adopt_iri_onto_key(
  sql: Sql,
  kb_id: Uuid,
  key: string,
  iri: string,
): Promise<Uuid | null> {
  const row = await qOpt<{ id: Uuid }>(
    sql,
    `UPDATE entity_types SET iri = $3, shape = 'square'
         WHERE kb_id = $1 AND key = $2 AND iri IS NULL
         RETURNING id`,
    [kb_id, key, iri],
  );
  return row?.id ?? null;
}

/**
 * The nearest class **ids** to a given vector (only ids; the caller already
 * has the full data for each class).
 *
 * Used by extraction: the chunk vector is already available inside the
 * extraction loop (entity resolution uses it too); use it to retrieve
 * classes that may be relevant to this chunk, and only those go into the
 * prompt.
 */
export async function nearest_entity_type_ids(
  sql: Sql,
  kb_id: Uuid,
  embedding: number[],
  limit: number,
): Promise<Uuid[]> {
  const rows = await q<{ id: Uuid }>(
    sql,
    `SELECT id FROM entity_types
         WHERE kb_id = $1 AND embedding IS NOT NULL
         ORDER BY embedding <=> $2
         LIMIT $3`,
    [kb_id, vector_param(embedding), limit],
  );
  return rows.map((r) => r.id);
}

/** Same as above, for relations and attributes. `only_kind` splits: relations and attributes go in two sections of the prompt. */
export async function nearest_relation_type_ids(
  sql: Sql,
  kb_id: Uuid,
  embedding: number[],
  limit: number,
  only_kind: string | null,
): Promise<Uuid[]> {
  const rows = await q<{ id: Uuid }>(
    sql,
    `SELECT id FROM relation_types
         WHERE kb_id = $1 AND embedding IS NOT NULL
           AND ($4::text IS NULL OR kind = $4)
         ORDER BY embedding <=> $2
         LIMIT $3`,
    [kb_id, vector_param(embedding), limit, only_kind],
  );
  return rows.map((r) => r.id);
}

/**
 * Insert a batch of classes in one shot; returns key -> id.
 *
 * **The reason for this is fsync.** Running `execute` one row at a time
 * commits each one separately; at the scale of a schema.org import (about
 * 968 classes plus about 1,500 attributes), that is five thousand fsyncs —
 * measured at 45 seconds. The same number of rows in one statement takes
 * 536 milliseconds. The cost is not round trips, it is commits.
 *
 * `ON CONFLICT DO NOTHING` instead of an error: what to do about a key
 * collision was already decided at the planning stage (see the comment on
 * [`create_entity_type_with_iri`] for why it is not overwritten); this just
 * carries out that plan — hitting a conflict here means the plan and the
 * database drifted apart, so it is skipped, and the caller notices who is
 * missing from the returned map.
 */
export async function create_entity_types_bulk(
  sql: Sql,
  kb_id: Uuid,
  rows: [string, string, string, string][],
): Promise<Map<string, Uuid>> {
  if (rows.length === 0) {
    return new Map();
  }
  for (const [key] of rows) {
    validate_key(key);
  }
  const keys = rows.map((r) => r[0]);
  const labels = rows.map((r) => r[1]);
  const descs = rows.map((r) => r[2]);
  const iris = rows.map((r) => r[3]);
  // The color is computed on this side, by key, alongside the UNNEST — SQL
  // cannot call a JS/Rust function, and this is exactly the batch used for
  // a large ontology import.
  const colours = keys.map((k) => colorForKey(k));
  const shapes = iris.map((i) => shapeFor(i));
  const out = await q<{ id: Uuid; key: string }>(
    sql,
    `INSERT INTO entity_types (id, kb_id, key, label, color, shape, description, iri)
         SELECT gen_random_uuid(), $1, k, l, c, s, d, i
         FROM UNNEST($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[])
              AS t(k, l, d, i, c, s)
         ON CONFLICT (kb_id, key) DO NOTHING
         RETURNING id, key`,
    [kb_id, keys, labels, descs, iris, colours, shapes],
  );
  return new Map(out.map((r) => [r.key, r.id]));
}

/**
 * One row of a batch relation/attribute create.
 *
 * **`functional` / `inverse_functional` must be written exactly as the
 * vocabulary declares; they must not default to false.** They drive the
 * temporal engine's automatic closure of facts; guessing wrong manufactures
 * conflicts in bulk — `part_of` mislabeled as functional once produced 59
 * of them.
 */
export interface BulkRelation {
  key: string;
  label: string;
  description: string;
  iri: string;
  /** `"relation"` or `"attribute"` */
  kind: "relation" | "attribute";
  /** Only meaningful for an attribute; a relation passes null. */
  datatype: string | null;
  functional: boolean;
  inverse_functional: boolean;
  /**
   * OWL property axioms, the basis for the consistency check (0002 R0).
   * These must also be written exactly as the vocabulary declares —
   * `alias_of` being bidirectional is correct, `produces` being
   * bidirectional is wrong; only the ontology can tell the two apart.
   */
  transitive: boolean;
  symmetric: boolean;
  asymmetric: boolean;
  irreflexive: boolean;
}

/**
 * Insert a batch of relations or attributes in one shot; returns key -> id.
 * Same rationale as [`create_entity_types_bulk`].
 *
 * `kind` picks the relation channel or the attribute channel; `datatype`
 * only matters for an attribute, and a relation passes null. `temporal` is
 * fixed to `state` — OWL has no matching concept, and guessing event or
 * eternal would be worse either way (the same judgment as the single-row
 * version).
 */
export async function create_relation_types_bulk(
  sql: Sql,
  kb_id: Uuid,
  rows: BulkRelation[],
): Promise<Map<string, Uuid>> {
  if (rows.length === 0) {
    return new Map();
  }
  for (const r of rows) {
    validate_key(r.key);
  }
  const keys = rows.map((r) => r.key);
  const labels = rows.map((r) => r.label);
  const descs = rows.map((r) => r.description);
  const iris = rows.map((r) => r.iri);
  const kinds = rows.map((r) => r.kind);
  const dts = rows.map((r) => r.datatype);
  const funcs = rows.map((r) => r.functional);
  const invs = rows.map((r) => r.inverse_functional);
  const trans = rows.map((r) => r.transitive);
  const syms = rows.map((r) => r.symmetric);
  const asyms = rows.map((r) => r.asymmetric);
  const irrefs = rows.map((r) => r.irreflexive);
  const out = await q<{ id: Uuid; key: string }>(
    sql,
    `INSERT INTO relation_types
             (id, kb_id, key, label, temporal, functional, inverse_functional,
              description, kind, datatype, iri,
              is_transitive, is_symmetric, is_asymmetric, is_irreflexive)
         SELECT gen_random_uuid(), $1, k, l, 'state', fu, iv, d, kind, dt, i,
                tr, sy, asym, irr
         FROM UNNEST($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[],
                     $8::bool[], $9::bool[], $10::bool[], $11::bool[], $12::bool[], $13::bool[])
              AS t(k, l, d, i, kind, dt, fu, iv, tr, sy, asym, irr)
         ON CONFLICT (kb_id, key) DO NOTHING
         RETURNING id, key`,
    [kb_id, keys, labels, descs, iris, kinds, dts, funcs, invs, trans, syms, asyms, irrefs],
  );
  return new Map(out.map((r) => [r.key, r.id]));
}

/**
 * Write the domain/range of a whole batch of relations in one pass.
 *
 * The single-row version [`set_domains_ranges`] already saves a round trip
 * with `unnest` internally, but it still runs 4 statements **per
 * relation** (two tables, one DELETE and one INSERT each). 1,500 relations
 * means 6,000 separate commits, and commits are the cost. This flattens
 * every relation's link rows into two statements.
 *
 * **No DELETE**: the caller is a freshly created relation, so there can be
 * no old rows in the link tables. Updating an existing relation still uses
 * the single-row version.
 */
export async function link_domains_ranges_bulk(
  sql: Sql,
  domains: [Uuid, Uuid][],
  ranges: [Uuid, Uuid][],
): Promise<void> {
  const tables: [string, [Uuid, Uuid][]][] = [
    ["relation_type_domains", domains],
    ["relation_type_ranges", ranges],
  ];
  for (const [table, pairs] of tables) {
    if (pairs.length === 0) {
      continue;
    }
    const rels = pairs.map((p) => p[0]);
    const types = pairs.map((p) => p[1]);
    await exec(
      sql,
      `INSERT INTO ${table} (relation_type_id, entity_type_id)
             SELECT r, t FROM UNNEST($1::uuid[], $2::uuid[]) AS x(r, t)
             ON CONFLICT DO NOTHING`,
      [rels, types],
    );
  }
}

/**
 * Set the parents for a whole batch of classes in one pass. Same meaning as
 * [`set_parents`], but **does not check for cycles**.
 *
 * The single-row version runs a recursive CTE cycle check every time — a
 * thousand classes means a thousand recursive queries. This is only used
 * for classes newly created by an import: a cycle is the upstream
 * vocabulary's problem, and `set_parents`'s own handling of a cycle is
 * already just to skip that one edge (`let _ =`), not to abort the import.
 * The ontology page can still find and let a human handle it after the
 * import finishes.
 */
export async function set_parents_bulk(sql: Sql, pairs: [Uuid, Uuid][]): Promise<void> {
  if (pairs.length === 0) {
    return;
  }
  const children = pairs.map((p) => p[0]);
  const parents = pairs.map((p) => p[1]);
  await exec(
    sql,
    `INSERT INTO entity_type_parents (child_id, parent_id)
         SELECT c, p FROM UNNEST($1::uuid[], $2::uuid[]) AS x(c, p)
         WHERE c <> p
         ON CONFLICT DO NOTHING`,
    [children, parents],
  );
}

/**
 * Write class mutual-exclusion pairs in bulk (see the axiom column on
 * `relation_types`). Same meaning as [`set_parents_bulk`].
 *
 * **Both directions are written.** The parsing side has already expanded
 * the symmetry of `owl:disjointWith` into two pairs, so this just writes
 * them — asking "are A and B disjoint" therefore does not care which side
 * you ask from.
 *
 * `a <> b` blocks a self-reference: a class being disjoint with itself is a
 * meaningless declaration, and it would make the consistency check flag
 * every single instance as a contradiction. The table also has a matching
 * CHECK; both stay in place — the constraint is the last line of defense,
 * and filtering here exists so one bad row does not fail the whole batch
 * insert.
 */
export async function set_disjoint_bulk(sql: Sql, kb_id: Uuid, pairs: [Uuid, Uuid][]): Promise<void> {
  if (pairs.length === 0) {
    return;
  }
  const a = pairs.map((p) => p[0]);
  const b = pairs.map((p) => p[1]);
  await exec(
    sql,
    `INSERT INTO entity_type_disjoint (kb_id, a_id, b_id)
         SELECT $1, x, y FROM UNNEST($2::uuid[], $3::uuid[]) AS t(x, y)
         WHERE x <> y
         ON CONFLICT DO NOTHING`,
    [kb_id, a, b],
  );
}

/**
 * Set `others` as the **complete** set of classes disjoint with this class
 * (any not in it are cleared).
 *
 * The division of labor with [`set_disjoint_bulk`]: that one is "add only",
 * used at import time; this one is "this is the whole set", used for
 * editing. Editing must be able to remove a pair — otherwise unchecking a
 * box in the UI would have no effect, while the user believes they changed
 * something.
 *
 * Each direction gets its own row, matching the import side: asking "are A
 * and B disjoint" does not care which side you ask from.
 */
export async function set_disjoint_for(
  sql: Sql,
  kb_id: Uuid,
  entity_class: Uuid,
  others: Uuid[],
): Promise<void> {
  await sql.begin(async (tx_raw) => {
    const tx = tx_raw as unknown as Sql;
    // First clear every disjoint edge this class takes part in — both
    // directions, since it can appear on either side.
    await exec(
      tx,
      `DELETE FROM entity_type_disjoint
          WHERE kb_id = $1 AND (a_id = $2 OR b_id = $2)`,
      [kb_id, entity_class],
    );
    for (const other of others) {
      if (other === entity_class) {
        continue;
      }
      await exec(
        tx,
        `INSERT INTO entity_type_disjoint (kb_id, a_id, b_id)
             VALUES ($1, $2, $3), ($1, $3, $2)
             ON CONFLICT DO NOTHING`,
        [kb_id, entity_class, other],
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Ontology proposals (see `ontology_proposals`)
// ---------------------------------------------------------------------------

/** One stored proposal. `payload` is the exact object the API returns. */
export interface StoredProposal {
  section: string;
  key: string;
  payload: unknown;
}

/**
 * Record the results of one Suggest run.
 *
 * **Anything a human already decided on stays untouched.** The
 * `WHERE status = 'open'` clause is the whole point of this function:
 * re-running Suggest recomputes a proposal that was already rejected (the
 * raw material is still sitting in `ontology_misses`); without this clause
 * it would be flipped back to open — every run would erase a human's
 * rejection all over again.
 */
export async function save_proposals(
  sql: Sql,
  kb_id: Uuid,
  items: [string, string, unknown][],
): Promise<void> {
  for (const [section, key, payload] of items) {
    await exec(
      sql,
      `INSERT INTO ontology_proposals (id, kb_id, section, key, payload)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (kb_id, section, key) DO UPDATE
               SET payload = EXCLUDED.payload, created_at = now()
               WHERE ontology_proposals.status = 'open'`,
      [newId(), kb_id, section, key, payload],
    );
  }
}

/** Proposals still waiting for a human to look at. Newest first — the older batch has already been seen a few times. */
export async function open_proposals(sql: Sql, kb_id: Uuid): Promise<StoredProposal[]> {
  return q<StoredProposal>(
    sql,
    `SELECT section, key, payload FROM ontology_proposals
         WHERE kb_id = $1 AND status = 'open'
         ORDER BY created_at DESC, key`,
    [kb_id],
  );
}

/**
 * A proposal was adopted or rejected.
 *
 * **The status changes; the row is not deleted**: the adoption happened,
 * and so did the rejection. This follows the same path as
 * `fact_adoptions` and `entity_retypes`. Keeping the rejection also does
 * something useful right away — the next Suggest run will not flip it back
 * to "waiting".
 */
export async function decide_proposal(
  sql: Sql,
  kb_id: Uuid,
  section: string,
  key: string,
  status: string,
  actor: Uuid,
): Promise<void> {
  await exec(
    sql,
    `UPDATE ontology_proposals
            SET status = $4, decided_by = $5, decided_at = now()
          WHERE kb_id = $1 AND section = $2 AND key = $3 AND status = 'open'`,
    [kb_id, section, key, status, actor],
  );
}

/**
 * How many proposals are still waiting. The 0003 gap: turning off automatic
 * extension left no "N proposals since last time" reminder — the signal
 * was on the panel, but nobody was looking. With this table, the reminder
 * is exactly this one query.
 */
export async function open_proposal_count(sql: Sql, kb_id: Uuid): Promise<number> {
  const row = await qOne<CountRowN>(
    sql,
    `SELECT count(*) FROM ontology_proposals WHERE kb_id = $1 AND status = 'open'`,
    [kb_id],
  );
  return Number(row.count);
}

interface CountRowN {
  count: string | number;
}

/**
 * Does the subject's type fit the domain declared for this relation? This
 * walks up the inheritance chain.
 *
 * **This only answers; it does not change data.** 0001 already settled
 * this: a signature is a hint, not a gate — "driving an automatic action
 * from a declaration that might be wrong is risky". An entity's own type is
 * also model-judged (Elon Musk was measured to have been judged
 * `researcher`); using it to flip a fact's direction would stack two
 * uncertain guesses and silently rewrite data. So the result here only
 * feeds one signal.
 *
 * Three answers, never collapse them into two:
 * - `true`  fits
 * - `false` does not fit — **this is the actual signal**
 * - `null`  cannot judge (the relation declares no domain, or the entity
 *   has no type yet)
 */
export async function subject_fits_domain(
  sql: Sql,
  relation_type_id: Uuid,
  subject_type_id: Uuid | null,
): Promise<boolean | null> {
  if (subject_type_id === null) {
    return null;
  }
  const row = await qOne<{ declared: string | number; ok: string | number }>(
    sql,
    `WITH RECURSIVE up(id) AS (
             SELECT $2::uuid
             UNION
             SELECT p.parent_id FROM entity_type_parents p JOIN up ON p.child_id = up.id
         )
         SELECT (SELECT count(*) FROM relation_type_domains WHERE relation_type_id = $1),
                (SELECT count(*) FROM relation_type_domains d
                   JOIN up ON up.id = d.entity_type_id
                  WHERE d.relation_type_id = $1)`,
    [relation_type_id, subject_type_id],
  );
  const declared = Number(row.declared);
  const ok = Number(row.ok);
  return declared > 0 ? ok > 0 : null;
}

/**
 * All ancestors of these classes (not including themselves). Walks up
 * `subClassOf`; multiple inheritance and diamonds both work.
 *
 * Used to pad the floor under per-chunk retrieval: vector search favors
 * leaf classes that appear literally in the text, and a generalized base
 * class ranks far behind (measured: `person` ranks 359th out of 976
 * classes), so the prompt ends up without it — the entity has nowhere to
 * land, and a relation's signature degrades to `*`. Ancestors are a
 * generalization the ontology itself declares, which is more reliable than
 * maintaining a hand-written list of "common classes".
 */
export async function ancestors_of(sql: Sql, ids: Uuid[]): Promise<Uuid[]> {
  if (ids.length === 0) {
    return [];
  }
  // The UNION in the recursive term deduplicates, so diamond inheritance
  // does not expand the same ancestor twice.
  const rows = await q<{ id: Uuid }>(
    sql,
    `WITH RECURSIVE up(id) AS (
             SELECT unnest($1::uuid[])
             UNION
             SELECT p.parent_id FROM entity_type_parents p JOIN up ON p.child_id = up.id
         )
         SELECT id FROM up WHERE id <> ALL($1::uuid[])`,
    [ids],
  );
  return rows.map((r) => r.id);
}

/**
 * Same as [`subject_fits_domain`], but the type is **read from the
 * database**, not taken from what the caller already has.
 *
 * The extractor's own `entity_type_of` only covers entities the model
 * declared a type for in this chunk; the object is often an entity that
 * already exists elsewhere, whose type was not re-declared in this chunk,
 * so it cannot be looked up or judged. Resolution has already linked it to
 * its row in the database, and that row has a type — using it makes the
 * check complete.
 */
export async function entity_fits_domain(
  sql: Sql,
  relation_type_id: Uuid,
  entity_id: Uuid,
): Promise<boolean | null> {
  const row = await qOne<{ declared: string | number; ok: string | number }>(
    sql,
    `WITH RECURSIVE up(id) AS (
             SELECT type_id FROM entities WHERE id = $2
             UNION
             SELECT p.parent_id FROM entity_type_parents p JOIN up ON p.child_id = up.id
         )
         SELECT (SELECT count(*) FROM relation_type_domains WHERE relation_type_id = $1),
                (SELECT count(*) FROM relation_type_domains d
                   JOIN up ON up.id = d.entity_type_id
                  WHERE d.relation_type_id = $1)`,
    [relation_type_id, entity_id],
  );
  const declared = Number(row.declared);
  const ok = Number(row.ok);
  return declared > 0 ? ok > 0 : null;
}

/**
 * Resolve `owl:inverseOf` / `rdfs:subPropertyOf` from IRIs to ids.
 *
 * **This must be a second pass.** These two point at another relation type,
 * and the id only exists once everything has been inserted — a single-pass
 * approach only works when "the parent property happens to come first" in
 * the file, and RDF triples have no ordering.
 *
 * Matched by IRI, not by key: a key may have a numeric suffix added on a
 * collision (`part_of_2`), while the IRI is this ontology's own identity.
 */
export async function link_property_axioms_bulk(
  sql: Sql,
  kb_id: Uuid,
  inverse: [string, string][],
  sub_property: [string, string][],
): Promise<[number, number]> {
  const run = async (column: "inverse_of" | "sub_property_of", pairs: [string, string][]): Promise<number> => {
    const src = pairs.map((p) => p[0]);
    const dst = pairs.map((p) => p[1]);
    if (src.length === 0) {
      return 0;
    }
    // A target IRI that cannot be found in this KB is skipped — **a
    // partial import is normal** (it may reference a property from an
    // external vocabulary); one unresolved link should not fail the whole
    // import.
    const res = await exec(
      sql,
      `UPDATE relation_types r SET ${column} = t.id
                   FROM UNNEST($2::text[], $3::text[]) AS p(src, dst)
                   JOIN relation_types t ON t.kb_id = $1 AND t.iri = p.dst
                  WHERE r.kb_id = $1 AND r.iri = p.src AND r.id <> t.id`,
      [kb_id, src, dst],
    );
    return res.count;
  };
  const inv = await run("inverse_of", inverse);
  const sub = await run("sub_property_of", sub_property);
  return [inv, sub];
}

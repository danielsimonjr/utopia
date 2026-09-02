import { q, qOpt, qOne, exec, type Sql } from "../core/db";
import { AppError } from "../core/errors";
import { newId, type Uuid } from "../core/ids";
import type { KnowledgeBase } from "../core/models";

export async function list(sql: Sql, workspaceId: Uuid): Promise<KnowledgeBase[]> {
  return q<KnowledgeBase>(
    sql,
    `SELECT * FROM knowledge_bases WHERE workspace_id = $1 ORDER BY created_at`,
    [workspaceId],
  );
}

/** KBs visible to a user: system admins see all; others see open KBs plus their restricted matrix rows. */
export async function listVisible(
  sql: Sql,
  workspaceId: Uuid,
  userId: Uuid,
  isAdmin: boolean,
): Promise<KnowledgeBase[]> {
  return q<KnowledgeBase>(
    sql,
    `SELECT * FROM knowledge_bases k
     WHERE k.workspace_id = $1
       AND ($3
            OR k.visibility = 'open'
            OR EXISTS (SELECT 1 FROM kb_members m
                       WHERE m.kb_id = k.id AND m.user_id = $2))
     ORDER BY k.created_at`,
    [workspaceId, userId, isAdmin],
  );
}

export async function create(
  sql: Sql,
  workspaceId: Uuid,
  name: string,
  kind: string,
  description: string | null,
): Promise<KnowledgeBase> {
  // The deployment's first KB automatically becomes the default: the
  // shared space, always open, never deletable (enforced by the API and
  // by a DB CHECK).
  //
  // ontology_lang takes the deployment default: a Chinese-language
  // deployment should not need a manual pick on every new KB. It can be
  // changed per KB afterward — a single deployment may well read
  // Chinese contracts in one KB and English papers in another.
  return qOne<KnowledgeBase>(
    sql,
    `INSERT INTO knowledge_bases
         (id, workspace_id, name, kind, description, is_default, ontology_lang)
     VALUES ($1, $2, $3, $4, $5,
             NOT EXISTS (SELECT 1 FROM knowledge_bases WHERE workspace_id = $2),
             COALESCE((SELECT default_ontology_lang FROM deployment_settings LIMIT 1), 'en'))
     RETURNING *`,
    [newId(), workspaceId, name, kind, description],
  );
}

export async function get(sql: Sql, id: Uuid): Promise<KnowledgeBase> {
  const row = await qOpt<KnowledgeBase>(sql, `SELECT * FROM knowledge_bases WHERE id = $1`, [id]);
  if (!row) throw AppError.notFound();
  return row;
}

export async function update(
  sql: Sql,
  id: Uuid,
  name: string | null,
  description: string | null,
  visibility: string | null,
  autoExtendOntology: boolean | null,
  ontologyLang: string | null,
  materializeInferences: boolean | null,
  inferenceIntervalMinutes: number | null,
): Promise<KnowledgeBase> {
  // Changing the language does not rewrite existing classes — they are
  // already this KB's data and someone may have adjusted them by hand.
  // This column governs the language of new descriptions from here on
  // (auto-extended ontology, AI suggestions).
  if (ontologyLang != null && ontologyLang !== "en" && ontologyLang !== "zh") {
    throw AppError.invalid("bad_lang", "language must be en or zh");
  }
  if (visibility != null) {
    if (visibility !== "open" && visibility !== "restricted") {
      throw AppError.validation("visibility must be open or restricted");
    }
    // The default KB stays open forever: the shared-space semantics must
    // be reliable (renaming or redescribing it is not restricted).
    if (visibility === "restricted") {
      const current = await get(sql, id);
      if (current.is_default) {
        throw AppError.invalid(
          "default_kb_open",
          "The default knowledge base stays open to everyone.",
        );
      }
    }
  }
  const row = await qOpt<KnowledgeBase>(
    sql,
    `UPDATE knowledge_bases
     SET name = COALESCE($2, name),
         description = COALESCE($3, description),
         visibility = COALESCE($4, visibility),
         auto_extend_ontology = COALESCE($5, auto_extend_ontology),
         ontology_lang = COALESCE($6, ontology_lang),
         materialize_inferences = COALESCE($7, materialize_inferences),
         inference_interval_minutes = COALESCE($8, inference_interval_minutes),
         updated_at = now()
     WHERE id = $1 RETURNING *`,
    [
      id,
      name,
      description,
      visibility,
      autoExtendOntology,
      ontologyLang,
      materializeInferences,
      inferenceIntervalMinutes,
    ],
  );
  if (!row) throw AppError.notFound();
  return row;
}

export async function del(sql: Sql, id: Uuid): Promise<void> {
  const current = await get(sql, id);
  if (current.is_default) {
    throw AppError.invalid("default_kb_undeletable", "The default knowledge base cannot be deleted.");
  }
  const res = await exec(sql, `DELETE FROM knowledge_bases WHERE id = $1`, [id]);
  if (res.count === 0) throw AppError.notFound();
}

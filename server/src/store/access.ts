/**
 * KB-level access control. This is the only authorization entry point for
 * every KB-scoped route.
 *
 * Decision chain: system admin gets full access. A row in `kb_members`
 * wins next and sets the matrix role. An open KB falls back to the
 * deployment role (membership in the invisible workspace). A restricted
 * KB with no row returns NotFound, so its existence never leaks.
 */

import { q, qOne, qOpt, exec, type Sql } from "../core/db";
import { AppError } from "../core/errors";
import type { Uuid } from "../core/ids";
import type { KnowledgeBase, Role, User } from "../core/models";
import { parseRole, roleAtLeast } from "../core/models";
import * as kbs from "./kbs";

/** KB member matrix row (Members section of KB settings). */
export type KbMemberView = {
  user_id: Uuid;
  email: string;
  display_name: string;
  role: string;
};

/**
 * Account-level "my knowledge bases" row (the member fields can be null:
 * an open KB is entered through the deployment role, with no matrix row).
 */
export type MyKbInfo = {
  kb_id: Uuid;
  member_role: string | null;
  joined_at: Date | null;
  added_by_name: string | null;
  doc_count: number;
  member_count: number;
};

/** The effective role a user has on a KB. null means it is invisible. */
export async function kbRole(sql: Sql, user: User, kb: KnowledgeBase): Promise<Role | null> {
  if (user.is_admin) {
    return "owner";
  }
  const matrix = await qOpt<{ role: string }>(
    sql,
    `SELECT role FROM kb_members WHERE kb_id = $1 AND user_id = $2`,
    [kb.id, user.id],
  );
  if (matrix) {
    return parseRole(matrix.role);
  }
  if (kb.visibility === "open") {
    // An open KB is readable by everyone in the deployment; write access
    // always comes from this KB's own matrix (a system admin is already
    // owner at the top of the chain, and the deployment role never maps
    // to write access inside a KB).
    const ws = await qOpt<{ role: string }>(
      sql,
      `SELECT role FROM memberships WHERE workspace_id = $1 AND user_id = $2`,
      [kb.workspace_id, user.id],
    );
    return ws ? "viewer" : null;
  }
  return null;
}

/**
 * The set version of `kbRole`: every KB this user can see across all
 * workspaces, mapped to its effective role.
 *
 * Any change to `kbRole` above must be mirrored here. This does not loop
 * over `kbRole` per KB: the alerts list spans every KB, and one query per
 * KB is an N+1 that grows with deployment size. The three branches match
 * `kbRole` in the same order:
 *   1. is_admin -> every KB, owner
 *   2. a row in kb_members -> the matrix role
 *   3. an open KB + membership in that workspace -> viewer
 *
 * Branch 3 checks `memberships` explicitly here, unlike `kbs.listVisible`:
 * that function is already scoped by a workspace route, this one is not.
 */
export async function visibleKbRoles(sql: Sql, user: User): Promise<[Uuid, Role][]> {
  if (user.is_admin) {
    const ids = await q<{ id: Uuid }>(sql, `SELECT id FROM knowledge_bases`, []);
    return ids.map((row) => [row.id, "owner" as Role]);
  }
  const rows = await q<{ id: Uuid; role: string | null; open_member: boolean }>(
    sql,
    `SELECT k.id,
            m.role,
            (k.visibility = 'open'
             AND EXISTS (SELECT 1 FROM memberships ws
                         WHERE ws.workspace_id = k.workspace_id AND ws.user_id = $1)) AS open_member
     FROM knowledge_bases k
     LEFT JOIN kb_members m ON m.kb_id = k.id AND m.user_id = $1`,
    [user.id],
  );
  const out: [Uuid, Role][] = [];
  for (const row of rows) {
    // The matrix wins over "open", same as kbRole: a matrix row means we
    // stop looking at visibility.
    if (row.role != null) {
      const r = parseRole(row.role);
      if (r) out.push([row.id, r]);
    } else if (row.open_member) {
      out.push([row.id, "viewer"]);
    }
  }
  return out;
}

/** Requires at least `min` role on a KB. Returns the KB. */
export async function requireKb(
  sql: Sql,
  user: User,
  kbId: Uuid,
  min: Role,
): Promise<KnowledgeBase> {
  const kb = await kbs.get(sql, kbId);
  const role = await kbRole(sql, user, kb);
  if (role && roleAtLeast(role, min)) return kb;
  if (role) throw AppError.forbidden();
  throw AppError.notFound();
}

// ---------------------------------------------------------------------------
// KB member matrix
// ---------------------------------------------------------------------------

export async function kbMembers(sql: Sql, kbId: Uuid): Promise<KbMemberView[]> {
  return q<KbMemberView>(
    sql,
    `SELECT m.user_id, u.email, u.display_name, m.role
     FROM kb_members m JOIN users u ON u.id = m.user_id
     -- Deactivated people do not show up in the member list (see
     -- 'users.deactivated_at'); the membership row stays.
     WHERE m.kb_id = $1 AND u.deactivated_at IS NULL ORDER BY u.display_name`,
    [kbId],
  );
}

export async function setKbMember(
  sql: Sql,
  kbId: Uuid,
  userId: Uuid,
  role: string,
  addedBy: Uuid | null,
): Promise<void> {
  if (role !== "viewer" && role !== "editor" && role !== "admin") {
    throw AppError.validation("role must be viewer, editor or admin");
  }
  // Changing the role does not rewrite who invited them first (the
  // membership row records who brought this person in).
  await exec(
    sql,
    `INSERT INTO kb_members (kb_id, user_id, role, added_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (kb_id, user_id)
     DO UPDATE SET role = $3, added_by = COALESCE(kb_members.added_by, $4)`,
    [kbId, userId, role, addedBy],
  );
}

/** My member info + overview stats for each visible KB (account-level page). */
export async function myKbInfos(sql: Sql, kbIds: Uuid[], userId: Uuid): Promise<MyKbInfo[]> {
  return q<MyKbInfo>(
    sql,
    `SELECT k.id AS kb_id,
            m.role AS member_role,
            m.created_at AS joined_at,
            inviter.display_name AS added_by_name,
            (SELECT count(*) FROM documents d WHERE d.kb_id = k.id) AS doc_count,
            (SELECT count(*) FROM kb_members mm WHERE mm.kb_id = k.id) AS member_count
     FROM knowledge_bases k
     LEFT JOIN kb_members m ON m.kb_id = k.id AND m.user_id = $2
     LEFT JOIN users inviter ON inviter.id = m.added_by
     WHERE k.id = ANY($1)`,
    [kbIds, userId],
  );
}

export async function removeKbMember(sql: Sql, kbId: Uuid, userId: Uuid): Promise<void> {
  const res = await exec(sql, `DELETE FROM kb_members WHERE kb_id = $1 AND user_id = $2`, [
    kbId,
    userId,
  ]);
  if (res.count === 0) throw AppError.notFound();
}

// ---------------------------------------------------------------------------
// Deployment configuration
// ---------------------------------------------------------------------------

export async function openRegistration(sql: Sql): Promise<boolean> {
  const row = await qOpt<{ open_registration: boolean }>(
    sql,
    `SELECT open_registration FROM deployment_settings LIMIT 1`,
  );
  return row?.open_registration ?? true;
}

export async function setOpenRegistration(sql: Sql, value: boolean): Promise<void> {
  await exec(sql, `UPDATE deployment_settings SET open_registration = $1`, [value]);
}

/**
 * The default `ontology_lang` for a newly created knowledge base.
 *
 * This is deliberately not called "system language": that name invites
 * someone to wire the UI language to it, and then discover it does not
 * fit (the UI language lives on the client). The name itself should stop
 * that misuse. See docs/decisions/0004.
 */
export async function defaultOntologyLang(sql: Sql): Promise<string> {
  const row = await qOpt<{ default_ontology_lang: string }>(
    sql,
    `SELECT default_ontology_lang FROM deployment_settings LIMIT 1`,
  );
  return row?.default_ontology_lang ?? "en";
}

export async function setDefaultOntologyLang(sql: Sql, value: string): Promise<void> {
  if (value !== "en" && value !== "zh") {
    throw AppError.invalid("bad_lang", "language must be en or zh");
  }
  await exec(sql, `UPDATE deployment_settings SET default_ontology_lang = $1`, [value]);
}

/** Job worker concurrency (changeable in system settings, takes effect right away — see jobs.runWorker). */
export async function workerConcurrency(sql: Sql): Promise<number> {
  const row = await qOpt<{ worker_concurrency: number }>(
    sql,
    `SELECT worker_concurrency FROM deployment_settings LIMIT 1`,
  );
  // Keep this in sync with the column default on
  // `deployment_settings.worker_concurrency` (migration 0011). They are
  // written in two different places (one in SQL, one here), so changing
  // one does not carry over to the other automatically.
  return row?.worker_concurrency ?? 64;
}

export async function setWorkerConcurrency(sql: Sql, value: number): Promise<void> {
  if (value < 1 || value > 256) {
    throw AppError.invalid("concurrency_range", "worker_concurrency must be between 1 and 256");
  }
  await exec(sql, `UPDATE deployment_settings SET worker_concurrency = $1`, [value]);
}

/**
 * Stores an auto-generated JWT secret and returns the one that ends up in
 * effect.
 *
 * `COALESCE` lets several instances starting at once converge on the same
 * value: whoever writes first wins, and the others read back that row
 * instead of the one they just generated. Reading first and only writing
 * when missing cannot achieve this: two instances would both read NULL
 * at the same time, each write its own value, and the one that wrote
 * first would now be signing tokens with a secret no longer in the
 * database, which every other instance would then reject.
 */
export async function ensureJwtSecret(sql: Sql, generated: string): Promise<string> {
  const row = await qOne<{ jwt_secret: string | null }>(
    sql,
    `UPDATE deployment_settings SET jwt_secret = COALESCE(jwt_secret, $1)
     RETURNING jwt_secret`,
    [generated],
  );
  if (row.jwt_secret == null) {
    throw AppError.other(
      "deployment_settings has no singleton row, so the JWT secret has nowhere to be stored",
    );
  }
  return row.jwt_secret;
}

/**
 * The character budget for inlining the ontology into the extraction
 * prompt. Beyond it, extraction falls back to retrieval by chunk.
 *
 * This lives in settings rather than as a constant because pinning it
 * needs a curve: at each ontology size, measure full inlining against
 * chunk retrieval and see where they cross. If testing one point needs a
 * service restart, nobody will ever run that curve a second time.
 */
export async function ontologyPromptBudget(sql: Sql): Promise<number> {
  const row = await qOpt<{ ontology_prompt_budget: number }>(
    sql,
    `SELECT ontology_prompt_budget FROM deployment_settings LIMIT 1`,
  );
  return Math.max(row?.ontology_prompt_budget ?? 24_000, 0);
}

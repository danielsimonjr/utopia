import { q, qOpt, exec, type Sql } from "../core/db";
import { AppError } from "../core/errors";
import type { Uuid } from "../core/ids";
import type { Role } from "../core/models";
import * as workspaces from "./workspaces";

/** Workspace member view (member management page). */
export type MemberView = {
  user_id: Uuid;
  email: string;
  display_name: string;
  role: string;
  is_admin: boolean;
};

/** Every user in the deployment (add-member picker). */
export type OrgUser = {
  id: Uuid;
  email: string;
  display_name: string;
  is_admin: boolean;
};

export async function list(sql: Sql, workspaceId: Uuid): Promise<MemberView[]> {
  return q<MemberView>(
    sql,
    `SELECT m.user_id, u.email, u.display_name, m.role, u.is_admin
     FROM memberships m JOIN users u ON u.id = m.user_id
     -- Deactivated people no longer show up in the member list (see
     -- 'users.deactivated_at'). The membership row stays — restoring an
     -- account should not require re-adding it to every workspace.
     WHERE m.workspace_id = $1 AND u.deactivated_at IS NULL
     ORDER BY m.created_at`,
    [workspaceId],
  );
}

/** Every user in the deployment (add-member picker). */
export async function orgUsers(sql: Sql, orgId: Uuid): Promise<OrgUser[]> {
  return q<OrgUser>(
    sql,
    `SELECT id, email, display_name, is_admin FROM users
     WHERE org_id = $1 AND deactivated_at IS NULL ORDER BY created_at`,
    [orgId],
  );
}

export async function ownerCount(sql: Sql, workspaceId: Uuid): Promise<number> {
  const rows = await q<{ count: string }>(
    sql,
    `SELECT count(*) FROM memberships WHERE workspace_id = $1 AND role = 'owner'`,
    [workspaceId],
  );
  return Number(rows[0]!.count);
}

export async function currentRole(
  sql: Sql,
  workspaceId: Uuid,
  userId: Uuid,
): Promise<Role | null> {
  return workspaces.roleOf(sql, userId, workspaceId);
}

/** Sets/adds a member role (upsert). Guard rails live in the API layer. */
export async function setRole(
  sql: Sql,
  workspaceId: Uuid,
  userId: Uuid,
  role: Role,
): Promise<void> {
  // The target user must exist in this organization, and be active —
  // otherwise a deactivated account could be added to a workspace and
  // still be invisible in the member list (that query filters out
  // deactivated accounts), an authorization nobody can see.
  const exists = await qOpt<{ id: Uuid }>(
    sql,
    `SELECT id FROM users WHERE id = $1 AND deactivated_at IS NULL`,
    [userId],
  );
  if (!exists) throw AppError.notFound();
  await exec(
    sql,
    `INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, workspace_id) DO UPDATE SET role = EXCLUDED.role`,
    [userId, workspaceId, role],
  );
}

export async function remove(sql: Sql, workspaceId: Uuid, userId: Uuid): Promise<void> {
  const res = await exec(
    sql,
    `DELETE FROM memberships WHERE workspace_id = $1 AND user_id = $2`,
    [workspaceId, userId],
  );
  if (res.count === 0) throw AppError.notFound();
}

/**
 * Deactivated accounts. Without this, restoring one is out of reach —
 * a deactivated person disappears from every list, so the admin has no
 * id to work with, and the restore endpoint needs exactly that id.
 *
 * Kept as a separate query from `orgUsers` rather than an "include
 * deactivated" flag: the readers differ (one feeds the picker, this one
 * feeds a small section of the admin page), and a boolean flag would make
 * every call site stop and think about which kind it wants.
 */
export async function deactivatedUsers(sql: Sql, orgId: Uuid): Promise<OrgUser[]> {
  return q<OrgUser>(
    sql,
    `SELECT id, email, display_name, is_admin FROM users
     WHERE org_id = $1 AND deactivated_at IS NOT NULL
     ORDER BY deactivated_at DESC`,
    [orgId],
  );
}

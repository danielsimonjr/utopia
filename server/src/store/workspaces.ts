import { q, qOne, qOpt, exec, type Sql } from "../core/db";
import { AppError } from "../core/errors";
import { newId, type Uuid } from "../core/ids";
import { parseRole, roleAtLeast, type Role, type Workspace } from "../core/models";

export async function listForUser(sql: Sql, userId: Uuid): Promise<Workspace[]> {
  return q<Workspace>(
    sql,
    `SELECT w.* FROM workspaces w
     JOIN memberships m ON m.workspace_id = w.id
     WHERE m.user_id = $1
     ORDER BY w.created_at`,
    [userId],
  );
}

/** Creates a workspace inside the user's organization. The creator becomes owner. */
export async function create(
  sql: Sql,
  orgId: Uuid,
  userId: Uuid,
  name: string,
): Promise<Workspace> {
  return sql.begin(async (tx) => {
    const ws = await qOne<Workspace>(
      tx,
      `INSERT INTO workspaces (id, org_id, name) VALUES ($1, $2, $3) RETURNING *`,
      [newId(), orgId, name],
    );
    await exec(tx, `INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, $3)`, [
      userId,
      ws.id,
      "owner",
    ]);
    return ws;
  });
}

export async function get(sql: Sql, id: Uuid): Promise<Workspace> {
  const row = await qOpt<Workspace>(sql, `SELECT * FROM workspaces WHERE id = $1`, [id]);
  if (!row) throw AppError.notFound();
  return row;
}

/** The user's role in the workspace; null for non-members. */
export async function roleOf(sql: Sql, userId: Uuid, workspaceId: Uuid): Promise<Role | null> {
  const row = await qOpt<{ role: string }>(
    sql,
    `SELECT role FROM memberships WHERE user_id = $1 AND workspace_id = $2`,
    [userId, workspaceId],
  );
  return row ? parseRole(row.role) : null;
}

/** Permission check: non-members get NotFound (no existence leak); insufficient role gets Forbidden. */
export async function requireRole(
  sql: Sql,
  userId: Uuid,
  workspaceId: Uuid,
  min: Role,
): Promise<Role> {
  const role = await roleOf(sql, userId, workspaceId);
  if (role == null) throw AppError.notFound();
  if (roleAtLeast(role, min)) return role;
  throw AppError.forbidden();
}

export async function rename(sql: Sql, id: Uuid, name: string): Promise<Workspace> {
  const row = await qOpt<Workspace>(
    sql,
    `UPDATE workspaces SET name = $2 WHERE id = $1 RETURNING *`,
    [id, name],
  );
  if (!row) throw AppError.notFound();
  return row;
}

export async function del(sql: Sql, id: Uuid): Promise<void> {
  const res = await exec(sql, `DELETE FROM workspaces WHERE id = $1`, [id]);
  if (res.count === 0) throw AppError.notFound();
}

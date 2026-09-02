import { qOne, qOpt, exec, type Sql, type Queryable } from "../core/db";
import { AppError, isAppError } from "../core/errors";
import { newId, type Uuid } from "../core/ids";
import type { Role, User, Workspace } from "../core/models";

async function insertUser(
  tx: Queryable,
  orgId: Uuid,
  email: string,
  passwordHash: string,
  displayName: string,
  isAdmin: boolean,
): Promise<User> {
  try {
    return await qOne<User>(
      tx,
      `INSERT INTO users (id, org_id, email, password_hash, display_name, is_admin)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [newId(), orgId, email, passwordHash, displayName, isAdmin],
    );
  } catch (e) {
    if (isAppError(e) && e.kind === "Conflict") {
      throw AppError.conflict("This email is already registered");
    }
    throw e;
  }
}

async function insertMembership(
  tx: Queryable,
  userId: Uuid,
  workspaceId: Uuid,
  role: Role,
): Promise<void> {
  await exec(tx, `INSERT INTO memberships (user_id, workspace_id, role) VALUES ($1, $2, $3)`, [
    userId,
    workspaceId,
    role,
  ]);
}

/**
 * The deployment's shared space. It is created for the first user at
 * registration, in the same transaction as the organization and
 * workspace — otherwise a fresh deployment's first screen is a shell:
 * Graph stuck on Loading, no KB to pick in the switcher, and nobody ever
 * told the user to create the first KB.
 *
 * It is named General, not Public: visibility is expressed by the
 * `visibility` field, so the name would be redundant, and on a
 * self-hosted deployment a name like Public would be misread as
 * "exposed to the internet". `is_default` keeps it open and undeletable
 * forever (the CHECK in migration 0012 is a second, database-level
 * guard).
 */
async function insertGeneralKb(tx: Queryable, workspaceId: Uuid, ownerId: Uuid): Promise<void> {
  const kbId = newId();
  await exec(
    tx,
    `INSERT INTO knowledge_bases
        (id, workspace_id, name, kind, description, is_default, visibility)
     VALUES ($1, $2, 'General', 'knowledge', $3, TRUE, 'open')`,
    [kbId, workspaceId, "Shared space for the whole deployment. Everyone can read it."],
  );
  // The creator becomes this KB's admin, matching the manual-create path.
  // The first user is already a system admin and does not need this row
  // to get in, but system admin status can be revoked later, and this
  // KB's permission should not evaporate along with it.
  await exec(
    tx,
    `INSERT INTO kb_members (kb_id, user_id, role, added_by)
     VALUES ($1, $2, 'admin', $2)`,
    [kbId, ownerId],
  );
}

/**
 * Registration (single-tenant model):
 * - No organization exists yet in the deployment -> first user: create the
 *   organization plus a default workspace, become owner and system admin.
 * - An organization already exists -> join it as a viewer in the default
 *   (oldest) workspace; rejected when `openRegistration` is false (the
 *   first user is the only exception).
 */
export async function register(
  sql: Sql,
  email: string,
  passwordHash: string,
  displayName: string,
  orgName: string | null,
  openRegistration: boolean,
): Promise<{ user: User; workspace: Workspace }> {
  return sql.begin(async (tx) => {
    const existingOrg = await qOpt<{ id: Uuid }>(
      tx,
      `SELECT id FROM organizations ORDER BY created_at LIMIT 1`,
    );

    if (!existingOrg) {
      // First user: bootstraps the entire deployment.
      const orgId = newId();
      await exec(tx, `INSERT INTO organizations (id, name) VALUES ($1, $2)`, [
        orgId,
        orgName ?? "Default Organization",
      ]);

      const user = await insertUser(tx, orgId, email, passwordHash, displayName, true);

      const workspace = await qOne<Workspace>(
        tx,
        `INSERT INTO workspaces (id, org_id, name) VALUES ($1, $2, $3) RETURNING *`,
        [newId(), orgId, "Default Workspace"],
      );

      await insertMembership(tx, user.id, workspace.id, "owner");
      await insertGeneralKb(tx, workspace.id, user.id);
      return { user, workspace };
    }

    const orgId = existingOrg.id;
    if (!openRegistration) {
      throw AppError.invalid(
        "registration_closed",
        "Registration is closed for this deployment. Contact your administrator.",
      );
    }
    const user = await insertUser(tx, orgId, email, passwordHash, displayName, false);

    // Join the default (oldest) workspace; in the unusual case where the
    // organization has no workspace, create one.
    const defaultWs = await qOpt<Workspace>(
      tx,
      `SELECT * FROM workspaces WHERE org_id = $1 ORDER BY created_at LIMIT 1`,
      [orgId],
    );

    if (defaultWs) {
      await insertMembership(tx, user.id, defaultWs.id, "viewer");
      return { user, workspace: defaultWs };
    }
    const ws = await qOne<Workspace>(
      tx,
      `INSERT INTO workspaces (id, org_id, name) VALUES ($1, $2, $3) RETURNING *`,
      [newId(), orgId, "Default Workspace"],
    );
    await insertMembership(tx, user.id, ws.id, "owner");
    return { user, workspace: ws };
  });
}

/** Admin-created account: joins the existing organization + default workspace, with a deployment role chosen by the admin. */
export async function adminCreateUser(
  sql: Sql,
  email: string,
  passwordHash: string,
  displayName: string,
  role: Role,
): Promise<User> {
  return sql.begin(async (tx) => {
    const org = await qOpt<{ id: Uuid }>(
      tx,
      `SELECT id FROM organizations ORDER BY created_at LIMIT 1`,
    );
    if (!org) throw AppError.validation("Deployment not bootstrapped yet");
    const user = await insertUser(tx, org.id, email, passwordHash, displayName, false);
    const ws = await qOpt<{ id: Uuid }>(
      tx,
      `SELECT id FROM workspaces WHERE org_id = $1 ORDER BY created_at LIMIT 1`,
      [org.id],
    );
    if (ws) {
      await insertMembership(tx, user.id, ws.id, role);
    }
    return user;
  });
}

/**
 * Finds an account by email — active accounts only.
 *
 * `deactivated_at IS NULL` does two things at once: a deactivated person
 * cannot sign in, and if the same email is reused across deactivated
 * accounts it never returns one of them at random (the unique index is
 * now partial, constraining only active accounts, see
 * `users.deactivated_at`).
 */
export async function findUserByEmail(sql: Sql, email: string): Promise<User | null> {
  return qOpt<User>(sql, `SELECT * FROM users WHERE email = $1 AND deactivated_at IS NULL`, [
    email,
  ]);
}

/**
 * Finds an account by id — active accounts only.
 *
 * Session validation goes through here, so deactivation takes effect
 * immediately without waiting for a token to expire: a token already
 * issued will fail to resolve on the very next request. This is the only
 * path deactivation must block; everywhere else that reads users (audit,
 * merge logs, mapping ledgers) should keep finding the person — what they
 * did is a fact, deactivating them does not undo it.
 */
export async function findUserById(sql: Sql, id: Uuid): Promise<User | null> {
  return qOpt<User>(sql, `SELECT * FROM users WHERE id = $1 AND deactivated_at IS NULL`, [id]);
}

/** Changes the display name (profile page). */
export async function updateDisplayName(sql: Sql, id: Uuid, displayName: string): Promise<User> {
  const row = await qOpt<User>(
    sql,
    `UPDATE users SET display_name = $2 WHERE id = $1 RETURNING *`,
    [id, displayName],
  );
  if (!row) throw AppError.notFound();
  return row;
}

/** Changes the password (the server layer has already verified the old one and hashed the new one). */
export async function updatePassword(sql: Sql, id: Uuid, passwordHash: string): Promise<void> {
  await exec(sql, `UPDATE users SET password_hash = $2 WHERE id = $1`, [id, passwordHash]);
}

/**
 * Deactivates an account (soft delete, see `users.deactivated_at`).
 *
 * Does not delete the row. Audit events, merge logs, mapping ledgers,
 * and confirmed mappings all point their `actor_id` at this person, and
 * those are audit material — once someone has left, we still need to
 * answer "who did this at the time". Deactivation only cuts off access.
 *
 * Cannot deactivate yourself: an admin who deactivates themselves leaves
 * nobody able to bring them back (this system has no "super admin"
 * tier). This is enforced here, not only in the UI — the UI stops
 * accidental clicks, not a direct API call.
 *
 * The last admin cannot be deactivated: otherwise the organization would
 * have nobody left to manage members. Same reasoning.
 */
export async function deactivateUser(sql: Sql, target: Uuid, actor: Uuid): Promise<void> {
  if (target === actor) {
    throw AppError.validation("You cannot deactivate your own account");
  }
  await sql.begin(async (tx) => {
    const victim = await qOpt<{ is_admin: boolean; org_id: Uuid; deactivated_at: Date | null }>(
      tx,
      `SELECT is_admin, org_id, deactivated_at FROM users WHERE id = $1`,
      [target],
    );
    if (!victim) throw AppError.notFound();
    if (victim.deactivated_at != null) {
      // Idempotent: deactivating twice is not an error, and should not
      // overwrite deactivated_by with a second person.
      return;
    }
    if (victim.is_admin) {
      const others = await qOne<{ count: string }>(
        tx,
        `SELECT count(*) FROM users
          WHERE org_id = $1 AND is_admin AND deactivated_at IS NULL AND id <> $2`,
        [victim.org_id, target],
      );
      if (Number(others.count) === 0) {
        throw AppError.validation(
          "This is the organization's last admin; deactivating them would leave nobody able to manage members",
        );
      }
    }
    await exec(tx, `UPDATE users SET deactivated_at = now(), deactivated_by = $2 WHERE id = $1`, [
      target,
      actor,
    ]);
  });
}

/**
 * Restores a deactivated account.
 *
 * Can fail, and for good reason: if someone registered a new account
 * with the same email while this one was deactivated, the partial unique
 * index blocks this restore. The right response is to surface that
 * conflict to the admin, not to quietly let two active accounts share an
 * email.
 */
export async function reactivateUser(sql: Sql, target: Uuid): Promise<void> {
  const res = await exec(
    sql,
    `UPDATE users SET deactivated_at = NULL, deactivated_by = NULL
      WHERE id = $1 AND deactivated_at IS NOT NULL`,
    [target],
  );
  if (res.count === 0) throw AppError.notFound();
}

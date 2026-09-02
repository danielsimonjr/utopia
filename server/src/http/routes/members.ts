/**
 * Workspace member management.
 * Rules: viewing = viewer+; changing a role / removing = admin+; granting or
 * revoking the owner role = owner only; a workspace always keeps at least
 * one owner.
 */

import type { Hono } from "hono";
import type { AppState } from "../../state";
import * as store from "../../store";
import * as auth from "../../auth";
import { AppError } from "../../core/errors";
import { parseRole } from "../../core/models";
import { uuidParam } from "../context";

export function registerMemberRoutes(api: Hono, state: AppState): void {
  api.get("/workspaces/:id/members", async (c) => {
    const user = await auth.requireUser(c, state);
    const workspaceId = uuidParam(c, "id");
    await store.workspaces.requireRole(state.sql, user.id, workspaceId, "viewer");
    const list = await store.members.list(state.sql, workspaceId);
    return c.json(list);
  });

  api.get("/users", async (c) => {
    const user = await auth.requireUser(c, state);
    const list = await store.members.orgUsers(state.sql, user.org_id);
    return c.json(list);
  });

  api.get("/users/deactivated", async (c) => {
    const user = await auth.requireUser(c, state);
    if (!user.is_admin) throw AppError.forbidden();
    const list = await store.members.deactivatedUsers(state.sql, user.org_id);
    return c.json(list);
  });

  api.put("/workspaces/:workspace_id/members/:user_id", async (c) => {
    const user = await auth.requireUser(c, state);
    const workspaceId = uuidParam(c, "workspace_id");
    const targetId = uuidParam(c, "user_id");
    const body = (await c.req.json().catch(() => ({}))) as { role?: unknown };
    const newRole = typeof body.role === "string" ? parseRole(body.role) : null;
    if (!newRole) {
      throw AppError.validation("Role must be one of owner/admin/editor/viewer");
    }
    const callerRole = await store.workspaces.requireRole(state.sql, user.id, workspaceId, "admin");
    const targetRole = await store.members.currentRole(state.sql, workspaceId, targetId);

    const touchesOwner = newRole === "owner" || targetRole === "owner";
    if (touchesOwner && callerRole !== "owner") {
      throw AppError.forbidden();
    }
    if (
      targetRole === "owner" &&
      newRole !== "owner" &&
      (await store.members.ownerCount(state.sql, workspaceId)) <= 1
    ) {
      throw AppError.invalid("last_owner_demote", "Cannot demote the last owner");
    }

    await store.members.setRole(state.sql, workspaceId, targetId, newRole);
    return c.json({ ok: true });
  });

  api.delete("/workspaces/:workspace_id/members/:user_id", async (c) => {
    const user = await auth.requireUser(c, state);
    const workspaceId = uuidParam(c, "workspace_id");
    const targetId = uuidParam(c, "user_id");
    const callerRole = await store.workspaces.requireRole(state.sql, user.id, workspaceId, "admin");
    const targetRole = await store.members.currentRole(state.sql, workspaceId, targetId);
    if (!targetRole) throw AppError.notFound();

    if (targetRole === "owner") {
      if (callerRole !== "owner") throw AppError.forbidden();
      if ((await store.members.ownerCount(state.sql, workspaceId)) <= 1) {
        throw AppError.invalid("last_owner_remove", "Cannot remove the last owner");
      }
    }

    await store.members.remove(state.sql, workspaceId, targetId);
    return c.json({ ok: true });
  });
}

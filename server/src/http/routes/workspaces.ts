import type { Hono } from "hono";
import type { AppState } from "../../state";
import * as store from "../../store";
import * as auth from "../../auth";
import { AppError } from "../../core/errors";
import { uuidParam } from "../context";

function validateName(name: unknown): string {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (trimmed === "" || [...trimmed].length > 64) {
    throw AppError.invalid("bad_name", "Name must be 1-64 characters");
  }
  return trimmed;
}

export function registerWorkspaceRoutes(api: Hono, state: AppState): void {
  api.get("/workspaces", async (c) => {
    const user = await auth.requireUser(c, state);
    const list = await store.workspaces.listForUser(state.sql, user.id);
    return c.json(list);
  });

  api.post("/workspaces", async (c) => {
    const user = await auth.requireUser(c, state);
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
    const name = validateName(body.name);
    const ws = await store.workspaces.create(state.sql, user.org_id, user.id, name);
    return c.json(ws);
  });

  api.get("/workspaces/:id", async (c) => {
    const user = await auth.requireUser(c, state);
    const id = uuidParam(c, "id");
    const role = await store.workspaces.requireRole(state.sql, user.id, id, "viewer");
    const ws = await store.workspaces.get(state.sql, id);
    return c.json({ workspace: ws, role });
  });

  api.patch("/workspaces/:id", async (c) => {
    const user = await auth.requireUser(c, state);
    const id = uuidParam(c, "id");
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
    const name = validateName(body.name);
    await store.workspaces.requireRole(state.sql, user.id, id, "admin");
    const ws = await store.workspaces.rename(state.sql, id, name);
    return c.json(ws);
  });

  api.delete("/workspaces/:id", async (c) => {
    const user = await auth.requireUser(c, state);
    const id = uuidParam(c, "id");
    await store.workspaces.requireRole(state.sql, user.id, id, "owner");
    await store.workspaces.del(state.sql, id);
    return c.json({ ok: true });
  });
}

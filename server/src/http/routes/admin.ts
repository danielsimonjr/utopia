/**
 * System administration: deployment configuration + admin-issued accounts.
 * Every route here requires `user.is_admin`.
 */

import type { Hono } from "hono";
import type { AppState } from "../../state";
import * as store from "../../store";
import * as auth from "../../auth";
import { AppError } from "../../core/errors";
import { parseRole, publicUser, type User } from "../../core/models";
import { uuidParam } from "../context";

function requireAdmin(user: User): void {
  if (!user.is_admin) throw AppError.forbidden();
}

export function registerAdminRoutes(api: Hono, state: AppState): void {
  api.get("/admin/deployment", async (c) => {
    const user = await auth.requireUser(c, state);
    requireAdmin(user);
    const open = await store.access.openRegistration(state.sql);
    const workers = await store.access.workerConcurrency(state.sql);
    const onto = await store.access.defaultOntologyLang(state.sql);
    const [limits, dflt] = await store.modelLimits.list(state.sql);
    const inUse = await store.modelLimits.modelsInUse(state.sql);
    return c.json({
      open_registration: open,
      worker_concurrency: workers,
      default_ontology_lang: onto,
      model_limits: limits,
      default_model_concurrency: dflt,
      models_in_use: inUse.map(([baseUrl, model, kind]) => ({ base_url: baseUrl, model, kind })),
    });
  });

  api.put("/admin/deployment", async (c) => {
    const user = await auth.requireUser(c, state);
    requireAdmin(user);
    const body = (await c.req.json().catch(() => ({}))) as {
      open_registration?: unknown;
      worker_concurrency?: unknown;
      default_model_concurrency?: unknown;
      model_limit?: { base_url?: unknown; model?: unknown; max_concurrent?: unknown };
      default_ontology_lang?: unknown;
    };
    await store.access.setOpenRegistration(state.sql, Boolean(body.open_registration));
    if (typeof body.worker_concurrency === "number") {
      await store.access.setWorkerConcurrency(state.sql, body.worker_concurrency);
      state.workerConcurrency.value = body.worker_concurrency;
    }
    if (typeof body.default_ontology_lang === "string") {
      await store.access.setDefaultOntologyLang(state.sql, body.default_ontology_lang);
    }
    if (typeof body.default_model_concurrency === "number") {
      await store.modelLimits.setDefault(state.sql, body.default_model_concurrency);
    }
    if (body.model_limit && typeof body.model_limit.base_url === "string" && typeof body.model_limit.model === "string") {
      const maxConcurrent =
        typeof body.model_limit.max_concurrent === "number" ? body.model_limit.max_concurrent : null;
      await store.modelLimits.set(state.sql, body.model_limit.base_url, body.model_limit.model, maxConcurrent);
    }
    return c.json({ ok: true });
  });

  api.post("/admin/users", async (c) => {
    const user = await auth.requireUser(c, state);
    requireAdmin(user);
    const body = (await c.req.json().catch(() => ({}))) as {
      email?: unknown;
      display_name?: unknown;
      password?: unknown;
      role?: unknown;
    };
    const email = typeof body.email === "string" ? body.email : "";
    const displayName = typeof body.display_name === "string" ? body.display_name : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!email.includes("@") || email.length > 254) {
      throw AppError.invalid("bad_email", "Invalid email address");
    }
    if ([...password].length < 8) {
      throw AppError.invalid("password_too_short", "Password must be at least 8 characters");
    }
    if (displayName.trim() === "" || [...displayName].length > 64) {
      throw AppError.invalid("bad_display_name", "Display name must be 1-64 characters");
    }
    const roleStr = typeof body.role === "string" ? body.role : "editor";
    const role = parseRole(roleStr);
    if (!role) {
      throw AppError.validation("role must be admin, editor or viewer");
    }
    const hash = await auth.hashPassword(password);
    const created = await store.accounts.adminCreateUser(
      state.sql,
      email.trim(),
      hash,
      displayName.trim(),
      role,
    );
    return c.json({ user: publicUser(created) });
  });

  api.delete("/admin/users/:id", async (c) => {
    const user = await auth.requireUser(c, state);
    requireAdmin(user);
    const target = uuidParam(c, "id");
    await store.accounts.deactivateUser(state.sql, target, user.id);
    await store.audit.record(state.sql, null, user.id, "user.deactivated", "user", target, {});
    return c.json({ ok: true });
  });

  api.post("/admin/users/:id", async (c) => {
    const user = await auth.requireUser(c, state);
    requireAdmin(user);
    const target = uuidParam(c, "id");
    await store.accounts.reactivateUser(state.sql, target);
    await store.audit.record(state.sql, null, user.id, "user.reactivated", "user", target, {});
    return c.json({ ok: true });
  });
}

import type { Hono } from "hono";
import type { AppState } from "../../state";
import * as store from "../../store";
import * as auth from "../../auth";
import * as ontologyPacks from "../../ontology_packs";
import { AppError } from "../../core/errors";
import { log } from "../../core/log";
import type { KnowledgeBase, User } from "../../core/models";
import { roleAtLeast } from "../../core/models";
import { uuidParam, queryStr, queryInt, clampLimit, clampOffset } from "../context";
import type { Uuid } from "../../core/ids";

type CreateKbReq = {
  name?: unknown;
  kind?: unknown;
  description?: unknown;
  visibility?: unknown;
  ontology_packs?: unknown;
};

type UpdateKbReq = {
  name?: unknown;
  description?: unknown;
  visibility?: unknown;
  auto_extend_ontology?: unknown;
  ontology_lang?: unknown;
  materialize_inferences?: unknown;
  inference_interval_minutes?: unknown;
};

async function kbWithRole(
  state: AppState,
  user: User,
  kbId: Uuid,
  min: "viewer" | "editor" | "admin" | "owner",
): Promise<KnowledgeBase> {
  return store.access.requireKb(state.sql, user, kbId, min);
}

/**
 * Installs the ontology packs picked at KB creation.
 *
 * The Bun/Hono build does not yet carry an OWL importer (that lives in
 * `crates/utopia-server/src/owl_import.rs`, out of scope here), so a
 * chosen pack id is validated but not applied. The KB is still created —
 * a KB with an empty ontology is a real, useful state; a KB that
 * disappeared over a missing importer would not be.
 */
async function installPacks(kbId: Uuid, actor: Uuid, packIds: string[]): Promise<void> {
  if (packIds.length === 0) return;
  for (const id of packIds) {
    const pack = ontologyPacks.get(id);
    if (!pack) {
      throw AppError.invalid("unknown_pack", `Unknown ontology pack: ${id}`);
    }
  }
  log.warn("ontology pack installation is not implemented in the Bun/Hono server yet", {
    kb_id: kbId,
    actor,
    packs: packIds,
  });
}

export function registerKbRoutes(api: Hono, state: AppState): void {
  api.get("/ontology-packs", async (c) => {
    await auth.requireUser(c, state);
    const packs = ontologyPacks.PACKS.map((p) => ({
      id: p.id,
      name: p.name,
      summary: p.summary,
      classes: p.classes,
      properties: p.properties,
    }));
    return c.json({ packs });
  });

  api.get("/workspaces/:id/kbs", async (c) => {
    const user = await auth.requireUser(c, state);
    const workspaceId = uuidParam(c, "id");
    await store.workspaces.requireRole(state.sql, user.id, workspaceId, "viewer");
    const list = await store.kbs.listVisible(state.sql, workspaceId, user.id, user.is_admin);
    return c.json(list);
  });

  api.post("/workspaces/:id/kbs", async (c) => {
    const user = await auth.requireUser(c, state);
    const workspaceId = uuidParam(c, "id");
    const body = (await c.req.json().catch(() => ({}))) as CreateKbReq;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name === "" || [...name].length > 64) {
      throw AppError.invalid("bad_name", "Name must be 1-64 characters");
    }
    const kind = typeof body.kind === "string" ? body.kind : "knowledge";
    if (kind !== "knowledge" && kind !== "memory") {
      throw AppError.validation("kind must be 'knowledge' or 'memory'");
    }
    const wsRole = await store.workspaces.requireRole(state.sql, user.id, workspaceId, "viewer");
    if (!user.is_admin && !roleAtLeast(wsRole, "admin")) {
      throw AppError.forbidden();
    }
    const description = typeof body.description === "string" ? body.description : null;
    let kb = await store.kbs.create(state.sql, workspaceId, name, kind, description);
    if (typeof body.visibility === "string") {
      kb = await store.kbs.update(
        state.sql,
        kb.id,
        null,
        null,
        body.visibility,
        null,
        null,
        null,
        null,
      );
    }
    await store.access.setKbMember(state.sql, kb.id, user.id, "admin", user.id);
    const packIds = Array.isArray(body.ontology_packs)
      ? body.ontology_packs.filter((x): x is string => typeof x === "string")
      : [];
    await installPacks(kb.id, user.id, packIds);
    kb = await store.kbs.get(state.sql, kb.id);
    return c.json(kb);
  });

  api.get("/workspaces/:id/my-kbs", async (c) => {
    const user = await auth.requireUser(c, state);
    const workspaceId = uuidParam(c, "id");
    await store.workspaces.requireRole(state.sql, user.id, workspaceId, "viewer");
    const kbs = await store.kbs.listVisible(state.sql, workspaceId, user.id, user.is_admin);
    const ids = kbs.map((k) => k.id);
    const infos = await store.access.myKbInfos(state.sql, ids, user.id);
    const rows = kbs.map((kb) => {
      const info = infos.find((i) => i.kb_id === kb.id);
      return {
        kb,
        my_role: info?.member_role ?? null,
        joined_at: info?.joined_at ?? null,
        added_by_name: info?.added_by_name ?? null,
        doc_count: info?.doc_count ?? 0,
        member_count: info?.member_count ?? 0,
      };
    });
    return c.json({ kbs: rows });
  });

  api.get("/kbs/:id", async (c) => {
    const user = await auth.requireUser(c, state);
    const id = uuidParam(c, "id");
    const kb = await kbWithRole(state, user, id, "viewer");
    const role = await store.access.kbRole(state.sql, user, kb);
    return c.json({ ...kb, my_role: role });
  });

  api.patch("/kbs/:id", async (c) => {
    const user = await auth.requireUser(c, state);
    const id = uuidParam(c, "id");
    const body = (await c.req.json().catch(() => ({}))) as UpdateKbReq;
    await kbWithRole(state, user, id, "admin");
    const kb = await store.kbs.update(
      state.sql,
      id,
      typeof body.name === "string" ? body.name.trim() : null,
      typeof body.description === "string" ? body.description : null,
      typeof body.visibility === "string" ? body.visibility : null,
      typeof body.auto_extend_ontology === "boolean" ? body.auto_extend_ontology : null,
      typeof body.ontology_lang === "string" ? body.ontology_lang : null,
      typeof body.materialize_inferences === "boolean" ? body.materialize_inferences : null,
      typeof body.inference_interval_minutes === "number" ? body.inference_interval_minutes : null,
    );
    await store.audit.record(state.sql, id, user.id, "kb.updated", "kb", id, {
      name: body.name,
      visibility: body.visibility,
    });
    return c.json(kb);
  });

  api.delete("/kbs/:id", async (c) => {
    const user = await auth.requireUser(c, state);
    const id = uuidParam(c, "id");
    const kb = await kbWithRole(state, user, id, "admin");
    await store.kbs.del(state.sql, id);
    await store.audit.record(state.sql, null, user.id, "kb.deleted", "kb", id, { name: kb.name });
    return c.json({ ok: true });
  });

  api.get("/kbs/:id/members", async (c) => {
    const user = await auth.requireUser(c, state);
    const id = uuidParam(c, "id");
    await kbWithRole(state, user, id, "admin");
    const members = await store.access.kbMembers(state.sql, id);
    return c.json({ members });
  });

  api.put("/kbs/:id/members/:user_id", async (c) => {
    const user = await auth.requireUser(c, state);
    const id = uuidParam(c, "id");
    const targetId = uuidParam(c, "user_id");
    const body = (await c.req.json().catch(() => ({}))) as { role?: unknown };
    await kbWithRole(state, user, id, "admin");
    const role = typeof body.role === "string" ? body.role : "";
    await store.access.setKbMember(state.sql, id, targetId, role, user.id);
    await store.audit.record(state.sql, id, user.id, "kb.member_set", "user", targetId, { role });
    return c.json({ ok: true });
  });

  api.delete("/kbs/:id/members/:user_id", async (c) => {
    const user = await auth.requireUser(c, state);
    const id = uuidParam(c, "id");
    const targetId = uuidParam(c, "user_id");
    await kbWithRole(state, user, id, "admin");
    await store.access.removeKbMember(state.sql, id, targetId);
    await store.audit.record(state.sql, id, user.id, "kb.member_removed", "user", targetId, {});
    return c.json({ ok: true });
  });

  api.get("/kbs/:id/audit", async (c) => {
    const user = await auth.requireUser(c, state);
    const id = uuidParam(c, "id");
    await kbWithRole(state, user, id, "admin");
    const limit = clampLimit(queryInt(c, "limit"), 50, 200);
    const offset = clampOffset(queryInt(c, "offset"));
    const action = queryStr(c, "action") ?? null;
    const actor = queryStr(c, "actor") ?? null;
    const since = parseDay(queryStr(c, "since"));
    const until = parseDay(queryStr(c, "until"));
    const [events, total] = await store.audit.listForKb(
      state.sql,
      id,
      action,
      actor,
      since,
      until,
      limit,
      offset,
    );
    const actions = await store.audit.actionsForKb(state.sql, id);
    return c.json({ events, total, actions });
  });
}

function parseDay(raw: string | undefined): Date | null {
  if (!raw) return null;
  const dayMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (dayMatch) {
    return new Date(Date.UTC(Number(dayMatch[1]), Number(dayMatch[2]) - 1, Number(dayMatch[3])));
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw AppError.invalid("bad_date", "expected YYYY-MM-DD or RFC3339");
  }
  return date;
}

/**
 * Data-mapping API: the semantic layer's list, edit, and revision history.
 * Deciding (approve/reject) a mapping lives with review, not here — see
 * the `review.decideMapping`-equivalent stub.
 */

import type { Hono } from "hono";
import type { AppState } from "../../state";
import * as store from "../../store";
import * as auth from "../../auth";
import { AppError } from "../../core/errors";
import { uuidParam, queryStr, queryInt, clampLimit, clampOffset } from "../context";

const MAPPING_PAGE = 25;

function clean(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed === "" ? null : trimmed;
}

export function registerMappingRoutes(api: Hono, state: AppState): void {
  api.get("/kbs/:id/mappings", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    await store.access.requireKb(state.sql, user, kbId, "viewer");
    const status = queryStr(c, "status") ?? null;
    if (status && status !== "proposed" && status !== "confirmed" && status !== "rejected") {
      throw AppError.invalid("bad_status", "status must be proposed, confirmed or rejected");
    }
    const needle = queryStr(c, "q")?.trim() || null;
    const limit = clampLimit(queryInt(c, "limit"), MAPPING_PAGE, 200);
    const offset = clampOffset(queryInt(c, "offset"));
    const [items, total] = await store.mappings.page(state.sql, kbId, status, needle, limit, offset);
    const [proposed, confirmed, rejected] = await store.mappings.statusCounts(state.sql, kbId);
    return c.json({ items, total, counts: { proposed, confirmed, rejected } });
  });

  api.patch("/kbs/:id/mappings/:mapping_id", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    const mappingId = uuidParam(c, "mapping_id");
    await store.access.requireKb(state.sql, user, kbId, "editor");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const tableName = clean(body.table_name);
    const expr = clean(body.expr);
    const sql = clean(body.sql);
    const unit = clean(body.unit);
    const summary = clean(body.summary);
    const derived = Boolean(body.derived);
    if (tableName === null && expr === null && sql === null) {
      throw AppError.invalid(
        "empty_mapping",
        "A mapping needs at least one of table, expression or SQL",
      );
    }
    await store.mappings.revise(
      state.sql,
      kbId,
      mappingId,
      tableName,
      expr,
      sql,
      unit,
      summary,
      derived,
      user.id,
    );
    await store.audit.record(state.sql, kbId, user.id, "mapping.revised", "concept_mapping", mappingId, {});
    return c.json({ ok: true });
  });

  api.get("/kbs/:id/mappings/:mapping_id/revisions", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    const mappingId = uuidParam(c, "mapping_id");
    await store.access.requireKb(state.sql, user, kbId, "viewer");
    const revisions = await store.mappings.revisions(state.sql, kbId, mappingId);
    return c.json({ revisions });
  });
}

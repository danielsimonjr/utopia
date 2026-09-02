import type { Hono } from "hono";
import type { AppState } from "../../state";
import * as store from "../../store";
import * as auth from "../../auth";
import * as retrieval from "../../retrieval";
import { AppError } from "../../core/errors";
import { uuidParam } from "../context";

export function registerSearchRoutes(api: Hono, state: AppState): void {
  api.post("/kbs/:id/search", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    const body = (await c.req.json().catch(() => ({}))) as { q?: unknown; top_k?: unknown };
    const q = typeof body.q === "string" ? body.q.trim() : "";
    if (q === "") {
      throw AppError.invalid("empty_query", "Search query cannot be empty");
    }
    const kb = await store.access.requireKb(state.sql, user, kbId, "viewer");
    const topK = Math.min(typeof body.top_k === "number" ? body.top_k : 10, 50);
    const chunks = await retrieval.hybrid(state, kbId, kb.workspace_id, q, topK);
    return c.json({ results: chunks });
  });
}

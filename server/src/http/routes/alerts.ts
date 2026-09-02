/**
 * Alert center (cross-KB — the top-bar badge is not scoped to one KB).
 * Visibility is decided once, inside `store.alerts`; the routes here only
 * resolve the current user.
 */

import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppState } from "../../state";
import * as store from "../../store";
import * as auth from "../../auth";
import { queryStr, queryInt, clampLimit, clampOffset } from "../context";

/** As many groups as fit in the panel. */
const PAGE = 8;
const MAX_PAGE = 50;

export function registerAlertRoutes(api: Hono, state: AppState): void {
  api.get("/alerts", async (c) => {
    const user = await auth.requireUser(c, state);
    const limit = clampLimit(queryInt(c, "limit"), PAGE, MAX_PAGE);
    const offset = clampOffset(queryInt(c, "offset"));
    const q = queryStr(c, "q") ?? null;
    const page = await store.alerts.listGroups(state.sql, user, q, limit, offset);
    return c.json(page);
  });

  api.get("/alerts/unread", async (c) => {
    const user = await auth.requireUser(c, state);
    const n = await store.alerts.unreadCount(state.sql, user);
    return c.json({ unread: n });
  });

  api.post("/alerts/read-group", async (c) => {
    const user = await auth.requireUser(c, state);
    const body = (await c.req.json().catch(() => ({}))) as {
      kb_id?: unknown;
      kind?: unknown;
      from?: unknown;
      to?: unknown;
    };
    const kbId = typeof body.kb_id === "string" ? body.kb_id : null;
    const kind = typeof body.kind === "string" ? body.kind : "";
    const from = new Date(typeof body.from === "string" ? body.from : NaN);
    const to = new Date(typeof body.to === "string" ? body.to : NaN);
    const n = await store.alerts.markGroupRead(state.sql, user, kbId, kind, from, to);
    return c.json({ marked: n });
  });

  api.post("/alerts/read-all", async (c) => {
    const user = await auth.requireUser(c, state);
    const n = await store.alerts.markAllRead(state.sql, user);
    return c.json({ marked: n });
  });

  api.get("/alerts/events", async (c) => {
    await auth.requireUser(c, state);
    return streamSSE(c, async (stream) => {
      await new Promise<void>((resolve) => {
        const unsubscribe = state.subscribeEvents((e) => {
          if (e.kind !== "alert") return;
          void stream.writeSSE({ event: "alert", data: "{}" });
        });
        const ping = setInterval(() => {
          void stream.writeSSE({ event: "ping", data: "" }).catch(() => {});
        }, 25_000);
        stream.onAbort(() => {
          clearInterval(ping);
          unsubscribe();
          resolve();
        });
      });
    });
  });
}

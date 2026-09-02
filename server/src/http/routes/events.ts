/**
 * KB event stream (SSE): live ingest/extraction status + review-queue
 * changes. The frontend just invalidates its react-query caches on
 * receipt — events carry no business data, so this is naturally
 * idempotent.
 */

import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppState } from "../../state";
import * as store from "../../store";
import * as auth from "../../auth";
import { uuidParam } from "../context";

export function registerEventRoutes(api: Hono, state: AppState): void {
  api.get("/kbs/:id/events", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    await store.access.requireKb(state.sql, user, kbId, "viewer");

    return streamSSE(c, async (stream) => {
      await new Promise<void>((resolve) => {
        const unsubscribe = state.subscribeEvents((e) => {
          if (e.kbId !== kbId) return;
          // Wire shape mirrors `crates/utopia-server/src/state.rs`'s
          // `AppEvent` (snake_case); the frontend ignores the payload and
          // only reacts to the event name, but the field names still need
          // to match the Rust build for any other client.
          void stream.writeSSE({
            event: e.kind,
            data: JSON.stringify({
              kb_id: e.kbId,
              kind: e.kind,
              document_id: e.documentId ?? null,
            }),
          });
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

/**
 * Personal access tokens (account-level, not KB-level — a token belongs to
 * a person, and a person can be in several KBs).
 */

import type { Hono } from "hono";
import type { AppState } from "../../state";
import * as store from "../../store";
import * as auth from "../../auth";
import { uuidParam } from "../context";
import type { Uuid } from "../../core/ids";

export function registerTokenRoutes(api: Hono, state: AppState): void {
  api.post("/me/tokens", async (c) => {
    const user = await auth.requireUser(c, state);
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: unknown;
      scope?: unknown;
      kb_ids?: unknown;
      expires_in_days?: unknown;
    };
    const name = typeof body.name === "string" ? body.name : "";
    const scope = typeof body.scope === "string" ? body.scope : "read";
    const kbIds = Array.isArray(body.kb_ids)
      ? body.kb_ids.filter((x): x is Uuid => typeof x === "string")
      : null;
    const expiresInDays = typeof body.expires_in_days === "number" ? body.expires_in_days : 90;
    const expiresAt = expiresInDays > 0 ? new Date(Date.now() + expiresInDays * 86_400_000) : null;

    const [view, plain] = await store.tokens.issue(state.sql, user.id, name, scope, kbIds, expiresAt);
    await store.audit.record(state.sql, null, user.id, "token.issued", "personal_token", view.id, {
      name: view.name,
      scope: view.scope,
    });
    return c.json({ token: plain, info: view });
  });

  api.get("/me/tokens", async (c) => {
    const user = await auth.requireUser(c, state);
    const tokens = await store.tokens.list(state.sql, user.id);
    return c.json({ tokens });
  });

  api.delete("/me/tokens/:token_id", async (c) => {
    const user = await auth.requireUser(c, state);
    const tokenId = uuidParam(c, "token_id");
    await store.tokens.revoke(state.sql, user.id, tokenId);
    await store.audit.record(state.sql, null, user.id, "token.revoked", "personal_token", tokenId, {});
    return c.json({ ok: true });
  });
}

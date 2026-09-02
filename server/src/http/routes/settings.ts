/**
 * Workspace-level LLM settings (chat + embedding endpoints).
 */

import type { Hono } from "hono";
import type { AppState } from "../../state";
import * as store from "../../store";
import * as auth from "../../auth";
import { LlmClient } from "../../llm";
import { chatReady, embedReady } from "../../core/models";
import { uuidParam } from "../context";

function nonEmpty(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed === "" ? null : trimmed;
}

export function registerSettingsRoutes(api: Hono, state: AppState): void {
  api.get("/workspaces/:id/settings", async (c) => {
    const user = await auth.requireUser(c, state);
    const workspaceId = uuidParam(c, "id");
    await store.workspaces.requireRole(state.sql, user.id, workspaceId, "admin");
    const s = await store.settings.get(state.sql, workspaceId);
    if (!s) return c.json({});
    return c.json({
      chat_base_url: s.chat_base_url,
      chat_model: s.chat_model,
      has_chat_key: Boolean(s.chat_api_key && s.chat_api_key !== ""),
      embed_base_url: s.embed_base_url,
      embed_model: s.embed_model,
      embed_dim: s.embed_dim,
      has_embed_key: Boolean(s.embed_api_key && s.embed_api_key !== ""),
    });
  });

  api.put("/workspaces/:id/settings", async (c) => {
    const user = await auth.requireUser(c, state);
    const workspaceId = uuidParam(c, "id");
    await store.workspaces.requireRole(state.sql, user.id, workspaceId, "admin");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    await store.settings.upsert(
      state.sql,
      workspaceId,
      nonEmpty(body.chat_base_url),
      nonEmpty(body.chat_api_key),
      nonEmpty(body.chat_model),
      nonEmpty(body.embed_base_url),
      nonEmpty(body.embed_api_key),
      nonEmpty(body.embed_model),
      typeof body.embed_dim === "number" ? body.embed_dim : null,
    );
    return c.json({ ok: true });
  });

  api.post("/workspaces/:id/settings/test", async (c) => {
    const user = await auth.requireUser(c, state);
    const workspaceId = uuidParam(c, "id");
    await store.workspaces.requireRole(state.sql, user.id, workspaceId, "admin");
    const s = await store.settings.get(state.sql, workspaceId);
    if (!s) {
      return c.json({
        chat: { ok: false, error: "Not configured" },
        embed: { ok: false, error: "Not configured" },
      });
    }

    let chatResult: Record<string, unknown>;
    if (!chatReady(s)) {
      chatResult = { ok: false, error: "Not configured" };
    } else {
      try {
        const client = new LlmClient(s.chat_base_url!, s.chat_api_key, s.chat_model!);
        const reply = await client.chat([{ role: "user", content: "Reply with exactly one word: OK" }]);
        chatResult = { ok: true, reply: [...reply].slice(0, 50).join("") };
      } catch (e) {
        chatResult = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }

    let embedResult: Record<string, unknown>;
    if (!embedReady(s)) {
      embedResult = { ok: false, error: "Not configured" };
    } else {
      try {
        const client = new LlmClient(s.embed_base_url!, s.embed_api_key, s.embed_model!);
        const v = await client.embed(["connectivity test"]);
        embedResult = v.length > 0 ? { ok: true, dim: v[0]!.length } : { ok: false, error: "Empty response" };
      } catch (e) {
        embedResult = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }

    return c.json({ chat: chatResult, embed: embedResult });
  });
}

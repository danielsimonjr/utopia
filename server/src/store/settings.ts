import { qOne, qOpt, type Sql } from "../core/db";
import type { Uuid } from "../core/ids";
import type { LlmSettings } from "../core/models";

export async function get(sql: Sql, workspaceId: Uuid): Promise<LlmSettings | null> {
  return qOpt<LlmSettings>(sql, `SELECT * FROM llm_settings WHERE workspace_id = $1`, [
    workspaceId,
  ]);
}

/**
 * Any workspace setting that has a chat model configured. For endpoint
 * probes: the endpoint address is shared across the deployment, so it
 * does not matter which workspace's setting it came from, and a probe
 * has no "current workspace" context.
 */
export async function anyWithChat(sql: Sql): Promise<LlmSettings | null> {
  return qOpt<LlmSettings>(
    sql,
    `SELECT * FROM llm_settings
     WHERE chat_base_url IS NOT NULL AND chat_model IS NOT NULL
     ORDER BY workspace_id LIMIT 1`,
  );
}

/** Upsert; passing null for an api_key keeps the old value (the frontend never sends secrets back). */
export async function upsert(
  sql: Sql,
  workspaceId: Uuid,
  chatBaseUrl: string | null,
  chatApiKey: string | null,
  chatModel: string | null,
  embedBaseUrl: string | null,
  embedApiKey: string | null,
  embedModel: string | null,
  embedDim: number | null,
): Promise<LlmSettings> {
  return qOne<LlmSettings>(
    sql,
    `INSERT INTO llm_settings
         (workspace_id, chat_base_url, chat_api_key, chat_model,
          embed_base_url, embed_api_key, embed_model, embed_dim, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (workspace_id) DO UPDATE SET
         chat_base_url  = EXCLUDED.chat_base_url,
         chat_api_key   = COALESCE(EXCLUDED.chat_api_key, llm_settings.chat_api_key),
         chat_model     = EXCLUDED.chat_model,
         embed_base_url = EXCLUDED.embed_base_url,
         embed_api_key  = COALESCE(EXCLUDED.embed_api_key, llm_settings.embed_api_key),
         embed_model    = EXCLUDED.embed_model,
         embed_dim      = EXCLUDED.embed_dim,
         updated_at     = now()
     RETURNING *`,
    [
      workspaceId,
      chatBaseUrl,
      chatApiKey,
      chatModel,
      embedBaseUrl,
      embedApiKey,
      embedModel,
      embedDim,
    ],
  );
}

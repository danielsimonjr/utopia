/**
 * Per-model concurrency limits.
 *
 * The real constraint is the provider's rate limit, and that is keyed
 * by (base_url, model) — a local Ollama might only take 2 concurrent
 * calls, a hosted API can take 50. Before this, a single
 * deployment-level `worker_concurrency` governed everything, using one
 * number for two completely different things.
 *
 * A model with no dedicated config falls back to
 * `deployment_settings.default_model_concurrency` (default 10).
 */

import { q, qOpt, exec, type Sql } from "../core/db";
import { AppError } from "../core/errors";

/** A model's concurrency cap. The constraint comes from the provider's rate limit, keyed by (base_url, model) — a local Ollama and a hosted API should not share one number. */
export type ModelLimit = {
  base_url: string;
  model: string;
  max_concurrent: number;
};

/**
 * How much concurrency this model is allowed. Falls back to the
 * deployment default when nothing is configured.
 *
 * Checked before every LLM call — against a call that often takes
 * twenty-plus seconds, this query's cost is negligible, and in
 * exchange an admin's change takes effect immediately, no cache to
 * invalidate.
 */
export async function limitFor(sql: Sql, baseUrl: string, model: string): Promise<number> {
  const row = await qOpt<{ max_concurrent: number }>(
    sql,
    `SELECT max_concurrent FROM model_concurrency WHERE base_url = $1 AND model = $2`,
    [baseUrl, model],
  );
  if (row) return Math.max(row.max_concurrent, 1);
  const dflt = await qOpt<{ default_model_concurrency: number }>(
    sql,
    `SELECT default_model_concurrency FROM deployment_settings LIMIT 1`,
  );
  return Math.max(dflt?.default_model_concurrency ?? 10, 1);
}

/** Configured models plus the deployment default (fetched together for the admin page). */
export async function list(sql: Sql): Promise<[ModelLimit[], number]> {
  const rows = await q<ModelLimit>(
    sql,
    `SELECT base_url, model, max_concurrent FROM model_concurrency ORDER BY base_url, model`,
  );
  const dflt = await qOpt<{ default_model_concurrency: number }>(
    sql,
    `SELECT default_model_concurrency FROM deployment_settings LIMIT 1`,
  );
  return [rows, dflt?.default_model_concurrency ?? 10];
}

/** Sets a model's concurrency. `maxConcurrent` of null removes the dedicated config, falling back to the default. */
export async function set(
  sql: Sql,
  baseUrl: string,
  model: string,
  maxConcurrent: number | null,
): Promise<void> {
  if (maxConcurrent != null) {
    if (maxConcurrent < 1 || maxConcurrent > 256) {
      throw AppError.invalid("concurrency_range", "max_concurrent must be between 1 and 256");
    }
    await exec(
      sql,
      `INSERT INTO model_concurrency (base_url, model, max_concurrent)
       VALUES ($1, $2, $3)
       ON CONFLICT (base_url, model)
       DO UPDATE SET max_concurrent = EXCLUDED.max_concurrent, updated_at = now()`,
      [baseUrl, model, maxConcurrent],
    );
  } else {
    await exec(sql, `DELETE FROM model_concurrency WHERE base_url = $1 AND model = $2`, [
      baseUrl,
      model,
    ]);
  }
}

/** The deployment default concurrency (every model without its own config uses this). */
export async function setDefault(sql: Sql, value: number): Promise<void> {
  if (value < 1 || value > 256) {
    throw AppError.invalid(
      "concurrency_range",
      "default_model_concurrency must be between 1 and 256",
    );
  }
  await exec(sql, `UPDATE deployment_settings SET default_model_concurrency = $1`, [value]);
}

/** Models actually in use in the deployment (appearing in some workspace's settings), for the admin page to list what can be configured. */
export async function modelsInUse(sql: Sql): Promise<[string, string, string][]> {
  const rows = await q<{ chat_base_url: string; chat_model: string; kind: string }>(
    sql,
    `SELECT DISTINCT chat_base_url, chat_model, 'chat' AS kind FROM llm_settings
      WHERE chat_base_url IS NOT NULL AND chat_model IS NOT NULL
     UNION
     SELECT DISTINCT embed_base_url, embed_model, 'embed' FROM llm_settings
      WHERE embed_base_url IS NOT NULL AND embed_model IS NOT NULL`,
  );
  return rows.map((r) => [r.chat_base_url, r.chat_model, r.kind]);
}

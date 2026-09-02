/**
 * Alert production (0005). Storage lives in `store/alerts.ts`; this file
 * decides only WHEN to raise one.
 *
 * There is no "clear" step here. One failure writes one row, and the row
 * is never edited again. See `store/alerts.ts` for the reasons.
 */

import type { AppState } from "./state";
import * as alerts from "./store/alerts";
import { isUnreachable, rateLimited, outOfCredit } from "./llm";
import type { Job } from "./core/models";
import type { Uuid } from "./core/ids";
import { log } from "./core/log";

/**
 * Alerts are kept for 30 days. **Being purely additive has this price**: a
 * source that fails every hour writes 24 rows a day, and without cleanup
 * this table grows into a second log file.
 *
 * 30 days answers "what happened last month"; anything older belongs in
 * `audit_events` and the logs instead.
 */
const RETAIN_DAYS = 30;

/**
 * Look at a job's failure to see whether the model endpoint is the cause.
 *
 * **Only raised once the job finally gives up** (`attempts >= max_attempts`).
 * Reporting on every retry would report the same thing three times —
 * retries exist so a person is not bothered, and reporting each one
 * defeats that.
 */
export async function observeJobFailure(state: AppState, job: Job, err: unknown): Promise<void> {
  if (job.attempts < job.max_attempts) return;
  const hit = alertFor(err);
  if (!hit) return;
  const [kindStr, severity] = hit;
  try {
    await alerts.raise(state.sql, {
      kb_id: null,
      severity,
      kind: kindStr,
      min_role: "admin",
      subject_type: "system",
      subject_id: null,
      detail: { job: job.kind, error: errMessage(err) },
    });
  } catch (e) {
    log.warn("failed to raise an alert", { error: String(e), kind: kindStr });
    return;
  }
  state.emitAlert();
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Which alert kind a job failure should raise, if any.
 *
 * **A plain function, so it can be tested** without a real database. The
 * three kinds call for different actions — out of credit needs someone to
 * top up, rate limiting needs lower concurrency or a bigger quota, an
 * unreachable endpoint needs the network or the address checked. Folding
 * them into one alert points a person at the wrong fix, which costs more
 * time than not alerting at all.
 *
 * Order is "say the more urgent thing first", not overlapping checks: the
 * kinds are mutually exclusive; the overlap is only in HTTP status codes
 * (OpenAI's exhausted balance also answers 429), and that split already
 * happens inside `llm/index.ts`.
 */
function alertFor(err: unknown): [string, string] | null {
  if (outOfCredit(err) !== undefined) {
    return [alerts.kind.LLM_OUT_OF_CREDIT, "error"];
  }
  if (rateLimited(err) !== undefined) {
    return [alerts.kind.LLM_RATE_LIMITED, "warning"];
  }
  if (isUnreachable(err)) {
    return [alerts.kind.LLM_UNREACHABLE, "error"];
  }
  return null;
}

/** Sweeps expired alerts once a day. Call once at startup; it never resolves on its own. */
export function spawnRetentionSweep(state: AppState): void {
  const tick = async (): Promise<void> => {
    try {
      const n = await alerts.purgeOlderThan(state.sql, RETAIN_DAYS);
      if (n > 0) {
        log.info("expired alerts cleaned up", { count: n, days: RETAIN_DAYS });
        state.emitAlert();
      }
    } catch (e) {
      log.warn("failed to clean up expired alerts", { error: String(e) });
    }
  };
  setInterval(() => void tick(), 24 * 60 * 60 * 1000);
}

/**
 * A data source got mounted, but its schema never made it in.
 *
 * **This reports the state it left behind, not the failure itself.**
 * Mounting is two steps: write `kb_data_sources`, then ingest the schema
 * as a document. When the first succeeds and the second does not, the
 * source is genuinely half-mounted — `query_data` still lists it, and the
 * model can only guess at column names.
 *
 * The error at the moment of mounting was visible only to whoever clicked
 * the button. From then on the KB silently lacks it — exactly the failure
 * mode this alert exists to end.
 */
export async function observeSchemaSyncFailure(
  state: AppState,
  kbId: Uuid,
  sourceId: Uuid,
  sourceName: string,
  err: unknown,
): Promise<void> {
  try {
    await alerts.raise(state.sql, {
      kb_id: kbId,
      severity: "warning",
      kind: alerts.kind.SCHEMA_SYNC_FAILED,
      min_role: "admin",
      subject_type: "data_source",
      subject_id: sourceId,
      detail: { source: sourceName, error: errMessage(err) },
    });
  } catch (e) {
    log.warn("failed to raise data_source.schema_sync_failed", { error: String(e) });
    return;
  }
  state.emitAlert();
}

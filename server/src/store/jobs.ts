/**
 * Job queue: Postgres `FOR UPDATE SKIP LOCKED` consumer.
 *
 * The worker runs in the same process as the API. Failed jobs retry with a
 * backoff of 30s * attempts^2.
 *
 * The scheduling loop keeps claiming work while running jobs are below the
 * target concurrency (new work starts right away). Each job runs on its own
 * async task so a slow extraction never blocks the loop. The target
 * concurrency is read fresh every round: changing it in system settings
 * takes effect immediately, no restart needed.
 */

import { q, qOpt, exec, type Sql } from "../core/db";
import { log } from "../core/log";
import type { Job } from "../core/models";

export async function enqueue(sql: Sql, kind: string, payload: unknown): Promise<number> {
  const rows = await q<{ id: number }>(
    sql,
    `INSERT INTO jobs (kind, payload) VALUES ($1, $2) RETURNING id`,
    [kind, payload],
  );
  // `postgres` returns BIGINT columns as strings by default (to avoid
  // silent precision loss); job ids stay well under Number.MAX_SAFE_INTEGER
  // in practice, so a plain JS number matches Rust's i64-as-JSON-number.
  return Number(rows[0]!.id);
}

/** Claim one due job. Returns null when there is none. */
async function claimOne(sql: Sql): Promise<Job | null> {
  return qOpt<Job>(
    sql,
    `UPDATE jobs SET status = 'running', locked_at = now(),
            attempts = attempts + 1, updated_at = now()
     WHERE id = (
         SELECT id FROM jobs
         WHERE status = 'queued' AND run_at <= now()
         ORDER BY run_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
     )
     RETURNING id, kind, payload, attempts, max_attempts`,
  );
}

async function markDone(sql: Sql, id: number): Promise<void> {
  // A retry that later succeeds must clear the old error. Otherwise the
  // jobs table shows status='done' next to an error message that no
  // longer applies, and that has misled someone before: bootstrap had
  // in fact succeeded, but the row still carried the old
  // "column relation_type does not exist" text.
  await exec(
    sql,
    `UPDATE jobs SET status = 'done', last_error = NULL, updated_at = now() WHERE id = $1`,
    [id],
  );
}

async function markFailed(sql: Sql, job: Job, err: string): Promise<void> {
  if (job.attempts >= job.max_attempts) {
    await exec(
      sql,
      `UPDATE jobs SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1`,
      [job.id, err],
    );
  } else {
    const backoffSecs = 30 * job.attempts * job.attempts;
    await exec(
      sql,
      `UPDATE jobs SET status = 'queued', last_error = $2,
              run_at = now() + make_interval(secs => $3::float8),
              updated_at = now()
       WHERE id = $1`,
      [job.id, err, backoffSecs],
    );
  }
}

/** Reads the current target concurrency. Either shape works. */
export type ConcurrencyRef = { value: number } | { get(): number };

function readConcurrency(ref: ConcurrencyRef): number {
  return "get" in ref ? ref.get() : ref.value;
}

/**
 * Worker scheduling loop.
 *
 * The caller injects the job dispatch logic through `handler` (the store
 * does not depend on the layers above it).
 */
export async function runWorker(
  sql: Sql,
  concurrency: ConcurrencyRef,
  handler: (job: Job) => Promise<void>,
): Promise<void> {
  let running = 0;

  // Orphan recovery: if the process was killed, running jobs have no one
  // left to finish them, and their documents would stay stuck in
  // "extracting" forever. In a single-process deployment, any job still
  // "running" at startup must be an orphan, so requeue it unconditionally
  // (every handler is idempotent).
  try {
    const result = await exec(
      sql,
      `UPDATE jobs SET status = 'queued', locked_at = NULL, updated_at = now()
       WHERE status = 'running'`,
    );
    if (result.count > 0) {
      log.warn("recovered orphan jobs from a previous process exit", { count: result.count });
    }
  } catch (e) {
    log.error("failed to recover orphan jobs", { error: String(e) });
  }

  log.info("jobs worker started", { concurrency: readConcurrency(concurrency) });

  for (;;) {
    const cap = Math.max(readConcurrency(concurrency), 1);
    if (running >= cap) {
      await sleep(200);
      continue;
    }
    let job: Job | null;
    try {
      job = await claimOne(sql);
    } catch (e) {
      log.error("job claim failed, retrying in 5s", { error: String(e) });
      await sleep(5000);
      continue;
    }
    if (!job) {
      await sleep(2000);
      continue;
    }
    running += 1;
    const claimed = job;
    void (async () => {
      try {
        await handler(claimed);
        await markDone(sql, claimed.id);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        log.warn("job failed", { job_id: claimed.id, kind: claimed.kind, error: message });
        try {
          await markFailed(sql, claimed, message);
        } catch (writeErr) {
          log.error("failed to write back job status", {
            job_id: claimed.id,
            error: String(writeErr),
          });
        }
      } finally {
        running -= 1;
      }
    })();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

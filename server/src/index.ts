/**
 * Utopia server entry point (Bun/Hono build).
 *
 * Boot order: load config -> migrate -> open the full-text index -> resolve
 * the JWT secret -> build state -> start the job worker and schedulers ->
 * serve HTTP. This mirrors `crates/utopia-server/src/main.rs`.
 */

import { existsSync } from "node:fs";
import { dirname, join, isAbsolute } from "node:path";
import { loadConfig, parseBindAddr } from "./core/config";
import { connect, migrate } from "./core/db";
import { log } from "./core/log";
import * as store from "./store";
import type { Job } from "./core/models";
import { SearchIndex } from "./search";
import { LocalBlobStore } from "./blob";
import { AppState } from "./state";
import { generateJwtSecret } from "./auth";
import { createApp } from "./http/app";
import { processDocument } from "./pipeline";

// Bun loads `.env` (and `.env.local`) automatically for `bun run`/`bun
// <file>`, matching `dotenvy::dotenv().ok()` on the Rust side — no extra
// call needed here.

/** Walks up from `cwd` looking for the repo root (has both `migrations/` and `crates/`). Falls back to `cwd` itself — a checkout layout different from this monorepo should still boot, just needs the env vars set explicitly. */
function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "migrations")) && existsSync(join(dir, "crates"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function resolveFromRoot(repoRoot: string, maybeRelative: string): string {
  return isAbsolute(maybeRelative) ? maybeRelative : join(repoRoot, maybeRelative);
}

function payloadDocumentId(payload: unknown): string {
  const id = (payload as Record<string, unknown> | null)?.document_id;
  if (typeof id !== "string") throw new Error("payload is missing document_id");
  return id;
}

function payloadKbId(payload: unknown): string {
  const id = (payload as Record<string, unknown> | null)?.kb_id;
  if (typeof id !== "string") throw new Error("payload is missing kb_id");
  return id;
}

function payloadSourceId(payload: unknown): string {
  const id = (payload as Record<string, unknown> | null)?.source_id;
  if (typeof id !== "string") throw new Error("payload is missing source_id");
  return id;
}

/** Job dispatch: new job kinds get registered here. */
async function dispatch(state: AppState, job: Job): Promise<void> {
  switch (job.kind) {
    case "noop":
      log.info("noop job ran", { job_id: job.id });
      return;

    case "process_document":
      await processDocument(state, payloadDocumentId(job.payload));
      return;

    case "extract_document":
      // Graph extraction (LLM entity/relation extraction) is not wired up
      // in this build yet — mirrors `crates/utopia-server/src/extraction.rs`,
      // out of scope here. Logging and succeeding keeps documents usable
      // for search/chat instead of stuck in "queued" forever.
      log.warn("extract not wired", { job_id: job.id, document_id: payloadDocumentId(job.payload) });
      return;

    case "sync_source":
      log.warn("sync_source not wired", { job_id: job.id, source_id: payloadSourceId(job.payload) });
      return;

    // Scheduled re-derivation (materialize_inferences is fully implemented
    // in `store/reasoning.ts`; only the LLM-backed extraction/adjudication
    // pipeline is out of scope for this build).
    case "materialize_inferences": {
      const kbId = payloadKbId(job.payload);
      await store.reasoning.markInferenceRan(state.sql, kbId);
      const report = await store.reasoning.materialize(state.sql, kbId);
      if (report.inserted > 0 || report.invalidated > 0) {
        await store.audit.recordOpt(
          state.sql,
          kbId,
          null,
          "inference.materialized",
          "knowledge_base",
          kbId,
          {
            scheduled: true,
            inserted: report.inserted,
            invalidated: report.invalidated,
            rules: report.rules,
          },
        );
        state.emitGraph(kbId);
      }
      return;
    }

    default:
      log.warn("job kind not implemented in the Bun/Hono server yet, marking as succeeded", {
        job_id: job.id,
        kind: job.kind,
      });
      return;
  }
}

/**
 * Rebuilds the full-text index from the database when it comes up empty
 * but the database is not — a missing volume, a fresh machine, or a
 * corrupted index directory can all cause this, and search would
 * otherwise fail silently with zero results and no visible symptom.
 */
async function reindexIfEmpty(sql: Awaited<ReturnType<typeof connect>>, search: SearchIndex): Promise<void> {
  if (!search.isEmpty()) return;
  let total: number;
  try {
    total = await store.documents.liveChunkCount(sql);
  } catch (e) {
    log.warn("could not count chunks, skipping index rebuild", { error: String(e) });
    return;
  }
  if (total === 0) return;
  log.info("full-text index is empty, rebuilding from the database", { chunks: total });

  let rows: [string, string, string, string][];
  try {
    rows = await store.documents.allChunksForIndex(sql);
  } catch (e) {
    log.warn("could not read chunks, index not rebuilt", { error: String(e) });
    return;
  }

  let current: string | null = null;
  let batch: [string, string][] = [];
  let done = 0;
  const flush = async () => {
    if (current !== null && batch.length > 0) {
      const [kbId, docId] = current.split("|") as [string, string];
      try {
        await search.reindexDocument(kbId, docId, batch);
      } catch (e) {
        log.warn("a document failed to rebuild into the index", { error: String(e), document_id: docId });
      }
    }
    batch = [];
  };
  for (const [kbId, docId, chunkId, text] of rows) {
    const key = `${kbId}|${docId}`;
    if (current !== key) {
      await flush();
      current = key;
    }
    batch.push([chunkId, text]);
    done += 1;
  }
  await flush();
  log.info("full-text index rebuild complete", { chunks: done });
}

async function main(): Promise<void> {
  const repoRoot = findRepoRoot();
  const cfg = loadConfig();

  // Migrations run under a separate connection with a small pool: the
  // running app never needs table/trigger-creating privileges.
  const migrationPool = connect(cfg.migrationUrl, 2);
  await migrate(migrationPool, join(repoRoot, "migrations"));
  await migrationPool.end();
  log.info("database migrations complete");

  const sql = connect(cfg.databaseUrl, cfg.dbMaxConnections);

  const dataDir = resolveFromRoot(repoRoot, cfg.dataDir);
  const search = await SearchIndex.open(join(dataDir, "index"));
  log.info("full-text index ready", { dir: join(dataDir, "index") });

  await reindexIfEmpty(sql, search);

  // JWT secret: an explicit env var wins (for rotation / lining up several
  // instances); otherwise the one already in the database; otherwise
  // generate one and store it. An empty string counts as "not set" —
  // compose files writing `${UTOPIA_JWT_SECRET:-}` leave the variable
  // present but empty, and reading that literally would hand every
  // deployment the same blank secret.
  let jwtSecret: string;
  const envSecret = cfg.jwtSecret?.trim();
  if (envSecret) {
    jwtSecret = envSecret;
  } else {
    jwtSecret = await store.access.ensureJwtSecret(sql, generateJwtSecret());
    log.info("JWT secret taken from deployment settings (UTOPIA_JWT_SECRET not set)");
  }

  const blob = new LocalBlobStore(join(dataDir, "files"));

  const workerConcurrency = await store.access.workerConcurrency(sql).catch(() => 32);

  const state = new AppState({
    sql,
    jwtSecret,
    search,
    blob,
    openRegistration: cfg.openRegistration,
    cookieSecure: cfg.cookieSecure,
    dataDir,
    workerConcurrency: Math.min(Math.max(workerConcurrency, 1), 256),
  });

  // Job dispatch: register new job kinds in `dispatch` above.
  void store.jobs.runWorker(sql, state.workerConcurrency, (job) => dispatch(state, job));

  // Scheduled ingest: sweeps due sources once a minute, queues a sync task.
  setInterval(() => {
    void (async () => {
      try {
        const due = await store.sources.dueSources(sql);
        for (const s of due) {
          try {
            const queued = await store.sources.markQueued(sql, s.id);
            if (queued) {
              await store.jobs.enqueue(sql, "sync_source", { source_id: s.id });
            }
          } catch (e) {
            log.warn("failed to queue a source sync", { source_id: s.id, error: String(e) });
          }
        }
      } catch (e) {
        log.warn("failed to scan due sources", { error: String(e) });
      }
    })();
  }, 60_000);

  // Scheduled re-derivation: same cadence, sweeps KBs due for another
  // inference pass and queues them (the real derivation runs in the job).
  setInterval(() => {
    void (async () => {
      try {
        const due = await store.reasoning.dueForInference(sql);
        for (const kbId of due) {
          try {
            await store.jobs.enqueue(sql, "materialize_inferences", { kb_id: kbId });
          } catch (e) {
            log.warn("failed to queue inference", { kb_id: kbId, error: String(e) });
          }
        }
      } catch (e) {
        log.warn("failed to scan due inference", { error: String(e) });
      }
    })();
  }, 60_000);

  const webDist = resolveFromRoot(repoRoot, cfg.webDist);
  const app = createApp(state, { webDist });

  const { hostname, port } = parseBindAddr(cfg.bindAddr);
  Bun.serve({
    hostname,
    port,
    fetch: app.fetch,
    // Uploads run up to 100MB (see `documents.ts`); Bun's own idle timeout
    // must not cut off a large, slow upload partway through.
    idleTimeout: 255,
  });
  log.info(`Utopia server listening on http://${hostname}:${port}`);
  if (existsSync(join(webDist, "index.html"))) {
    log.info("serving frontend build", { webDist });
  }
}

main().catch((e: unknown) => {
  const message = e instanceof Error ? (e.stack ?? e.message) : String(e);
  log.error("server failed to start", { error: message });
  process.exit(1);
});

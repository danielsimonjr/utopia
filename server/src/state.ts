/**
 * Process-wide application state, shared by every request handler and by
 * the background worker and schedulers.
 *
 * Mirrors `crates/utopia-server/src/state.rs`. There is one instance per
 * process, built once in `index.ts` and passed down by closure.
 */

import type { Sql } from "./core/db";
import type { BlobStore } from "./blob";
import type { SearchIndex } from "./search";
import type { Uuid } from "./core/ids";

/** In-process event (SSE push to the frontend for a local refetch). */
export type AppEventKind = "document" | "review" | "graph" | "source" | "alert";

export type AppEvent = {
  /** null = not scoped to a KB. Alerts are cross-KB; a system alert has no KB at all. */
  kbId: Uuid | null;
  kind: AppEventKind;
  documentId?: Uuid | null;
};

export type Unsubscribe = () => void;

/**
 * A minimal in-process pub/sub, standing in for the Rust side's
 * `tokio::sync::broadcast` channel. There is one process, one event bus.
 */
class EventBus {
  private readonly listeners = new Set<(e: AppEvent) => void>();

  subscribe(fn: (e: AppEvent) => void): Unsubscribe {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(e: AppEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        // A subscriber's own failure must not break the others.
      }
    }
  }
}

export type AppStateOptions = {
  sql: Sql;
  jwtSecret: string;
  search: SearchIndex;
  blob: BlobStore;
  openRegistration: boolean;
  cookieSecure: boolean;
  dataDir: string;
  /** Initial worker concurrency; changeable at runtime through `workerConcurrency`. */
  workerConcurrency: number;
};

export class AppState {
  readonly sql: Sql;
  readonly jwtSecret: string;
  readonly search: SearchIndex;
  readonly blob: BlobStore;
  readonly openRegistration: boolean;
  readonly cookieSecure: boolean;
  readonly dataDir: string;
  /** Read fresh by the job scheduling loop every round; changing it takes effect right away. */
  readonly workerConcurrency: { value: number };

  private readonly bus = new EventBus();

  constructor(opts: AppStateOptions) {
    this.sql = opts.sql;
    this.jwtSecret = opts.jwtSecret;
    this.search = opts.search;
    this.blob = opts.blob;
    this.openRegistration = opts.openRegistration;
    this.cookieSecure = opts.cookieSecure;
    this.dataDir = opts.dataDir;
    this.workerConcurrency = { value: opts.workerConcurrency };
  }

  subscribeEvents(fn: (e: AppEvent) => void): Unsubscribe {
    return this.bus.subscribe(fn);
  }

  emitDocument(kbId: Uuid, documentId: Uuid): void {
    this.bus.emit({ kbId, kind: "document", documentId });
  }

  emitReview(kbId: Uuid): void {
    this.bus.emit({ kbId, kind: "review" });
  }

  /** The graph changed (inference added edges outside the document pipeline). */
  emitGraph(kbId: Uuid): void {
    this.bus.emit({ kbId, kind: "graph" });
  }

  emitSource(kbId: Uuid): void {
    this.bus.emit({ kbId, kind: "source" });
  }

  /** An alert changed. Carries no data and checks no permission — every listener refetches, and the list query enforces visibility once. */
  emitAlert(): void {
    this.bus.emit({ kbId: null, kind: "alert" });
  }
}

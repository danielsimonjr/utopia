/**
 * In-process events, pushed to the frontend over SSE for partial refresh.
 *
 * The frontend reacts to an event only by invalidating a react-query
 * cache and refetching — an event carries no business data, so it is
 * naturally idempotent, and a dropped or duplicated event costs nothing
 * beyond an extra refetch.
 */

import type { Uuid } from "./core/ids";

export type AppEventKind = "document" | "review" | "graph" | "source" | "alert";

export type AppEvent = {
  /** `null` = belongs to no KB. Alert badges are cross-KB; a system-wide alert has no KB at all. */
  kb_id: Uuid | null;
  kind: AppEventKind;
  document_id: Uuid | null;
};

type Listener = (ev: AppEvent) => void;

const listeners = new Set<Listener>();

/** Subscribes to every event; returns a function that unsubscribes. */
export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(ev: AppEvent): void {
  for (const fn of listeners) {
    try {
      fn(ev);
    } catch {
      // A broken listener must not break the others.
    }
  }
}

export function emitDocument(kb_id: Uuid, document_id: Uuid): void {
  emit({ kb_id, kind: "document", document_id });
}

export function emitReview(kb_id: Uuid): void {
  emit({ kb_id, kind: "review", document_id: null });
}

/** The graph changed. Reasoning must emit this after it adds edges to the graph — that path does not go through the document pipeline, and the `document` event is document-pipeline-only. */
export function emitGraph(kb_id: Uuid): void {
  emit({ kb_id, kind: "graph", document_id: null });
}

export function emitSource(kb_id: Uuid): void {
  emit({ kb_id, kind: "source", document_id: null });
}

/**
 * Something in the alert center changed. **Carries no data and checks no
 * permission** — every listener just refetches the list, and "who can see
 * what" is judged once, in the list query, and only there.
 *
 * The cost is that someone with no permission also gets woken up to
 * refetch, and gets an empty result again. In exchange, this push path
 * carries zero permission logic, so it cannot drift out of sync with what
 * the list query decides.
 */
export function emitAlert(): void {
  emit({ kb_id: null, kind: "alert", document_id: null });
}

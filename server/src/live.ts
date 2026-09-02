/**
 * An answer that is still being generated, resumable after a reconnect.
 *
 * **One SSE stream is tied to one HTTP request, and an answer can outlive
 * the request.** Generation already runs as an independent task (see
 * `http/routes/chat.ts`), so reloading the page no longer loses the
 * answer — but that stream, once broken, stays broken; after a reload the
 * client can only wait for it to land in the database, and everything in
 * between is invisible. The frontend moves the in-flight answer out of
 * the component to survive switching tabs within the same browser tab
 * group; **a reload, a different tab, or a different device are not
 * covered by that.**
 *
 * This fills in the last piece: register a generation while it runs, and
 * anyone can reattach to it.
 *
 * **Reattaching gets a snapshot first, not a replay of every event.** The
 * event stream is unbounded; buffering it would keep every delta of a
 * whole conversation in memory. A snapshot's size is bounded by the
 * answer itself. It is also simpler for the client: overwrite the current
 * state with the snapshot, then keep receiving deltas as usual — no need
 * to track "which event have I already replayed".
 */

import type { Uuid } from "./core/ids";

/** One SSE event: an event name plus already-serialized data. */
export type Frame = { event: string; data: string };

export function frame(event: string, data: unknown): Frame {
  return { event, data: JSON.stringify(data) };
}

/** What this answer looks like so far. Whoever reattaches gets this first. */
export type Snapshot = {
  content: string;
  steps: unknown[];
  sources: unknown[];
};

function emptySnapshot(): Snapshot {
  return { content: "", steps: [], sources: [] };
}

/**
 * **The snapshot is derived from the events themselves; there is no
 * separate write path.** Two write paths eventually disagree — exactly
 * the shape of bug this codebase keeps hitting (one place learns about a
 * new field, the other does not).
 */
function applyFrame(snap: Snapshot, f: Frame): void {
  try {
    const v = JSON.parse(f.data) as Record<string, unknown>;
    if (f.event === "delta") {
      if (typeof v.text === "string") snap.content += v.text;
    } else if (f.event === "step") {
      snap.steps.push(v);
    } else if (f.event === "sources") {
      // `sources` is a full resend, not an append.
      if (Array.isArray(v)) snap.sources = v;
      else if (Array.isArray((v as { sources?: unknown }).sources)) {
        snap.sources = (v as { sources: unknown[] }).sources;
      }
    }
  } catch {
    // Not JSON: ignore. The snapshot is best-effort.
  }
}

export function snapshotFrame(snap: Snapshot): Frame {
  return frame("snapshot", { content: snap.content, steps: snap.steps, sources: snap.sources });
}

type Subscriber = (f: Frame) => void;

class Entry {
  readonly snap: Snapshot = emptySnapshot();
  readonly subscribers = new Set<Subscriber>();
}

/** A handle held during one generation. Emits events; deregisters when done. */
export class Handle {
  constructor(
    private readonly conversationId: Uuid,
    private readonly entry: Entry,
    private readonly registry: Registry,
  ) {}

  /** Emits one event: records it into the snapshot, then broadcasts it. */
  emit(f: Frame): void {
    // The snapshot is updated before broadcasting, in the same synchronous
    // call — JavaScript has no preemption mid-function, so a subscriber
    // added by `attach` either sees this update fully applied or not
    // started at all, never half-applied. No lock is needed for the same
    // guarantee the Rust version gets from holding a write lock across
    // both steps.
    applyFrame(this.entry.snap, f);
    // Having no subscribers (everyone left) is normal, not an error.
    for (const sub of this.entry.subscribers) {
      try {
        sub(f);
      } catch {
        // A broken subscriber must not break the others.
      }
    }
  }

  /** Generation is done. **Anyone who reattaches after this gets "nothing running"** — the answer is already in the database by then; read it from there. */
  finish(): void {
    this.registry.end(this.conversationId);
  }
}

/** In-flight generations, looked up by conversation. */
export class Registry {
  private readonly entries = new Map<Uuid, Entry>();

  /** Registers one generation. Registering the same conversation twice replaces the old entry — this should not normally happen, and if it does, the new one wins. */
  begin(conversationId: Uuid): Handle {
    const entry = new Entry();
    this.entries.set(conversationId, entry);
    return new Handle(conversationId, entry, this);
  }

  end(conversationId: Uuid): void {
    this.entries.delete(conversationId);
  }

  /**
   * Reattaches to a running generation: the snapshot as of right now, plus
   * an unsubscribe function and an async iterable of further deltas.
   *
   * Returns `null` = no generation is running for this conversation.
   * **That is not an error** — it is the common case.
   */
  attach(conversationId: Uuid): { snapshot: Snapshot; subscribe: (fn: Subscriber) => () => void } | null {
    const entry = this.entries.get(conversationId);
    if (!entry) return null;
    // The snapshot is copied out synchronously, in the same tick as
    // registering the subscriber below — so nothing emitted concurrently
    // can be both missed and double-counted, matching the Rust version's
    // "hold the snapshot read lock while subscribing" guarantee.
    const snapshot: Snapshot = {
      content: entry.snap.content,
      steps: [...entry.snap.steps],
      sources: [...entry.snap.sources],
    };
    const subscribe = (fn: Subscriber): (() => void) => {
      entry.subscribers.add(fn);
      return () => entry.subscribers.delete(fn);
    };
    return { snapshot, subscribe };
  }
}

/** The process-wide registry of in-flight chat generations. */
export const liveRegistry = new Registry();

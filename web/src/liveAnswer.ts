// The reply currently generating lives outside any component.
//
// **Navigating away used to make it disappear.** The streaming `turns`
// data used to be component state on the Chat page. Leaving the
// conversation page unmounted that component: the state was gone, but the
// fetch kept running, and its callbacks wrote into an already-unmounted
// component. On return, the component remounted and read from the
// database, but the database only gets that row after generation finishes.
// So the user saw only the question they had asked. Returning later
// worked, because the row existed by then.
//
// The server-side fix, which keeps generation running independent of the
// connection, is a separate change. This module fixes **whether the reply
// is visible on return.** Both fixes are needed: the server preserves the
// answer, and this module preserves the stream.
//
// Only one reply can generate at a time, so this is a singleton store, not a table keyed by conversation.
import type { ChatStep, Source } from "./api";

export interface Turn {
  role: "user" | "assistant";
  content: string;
  steps?: ChatStep[];
  sources?: Source[];
  error?: string;
}

interface Live {
  conversationId: string | null;
  turns: Turn[];
  /** Used by the stop button. Navigating to another page **does not call
   *  this**; that is the point of this fix. */
  abort: () => void;
  /** Whether the reply is still writing or has finished. **Finishing does
   *  not clear the state**; see `finish` below. */
  streaming: boolean;
}

let live: Live | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export const liveAnswer = {
  /** `useSyncExternalStore` requires the same snapshot reference when nothing has changed. */
  get: () => live,
  subscribe: (l: () => void) => {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
  start: (conversationId: string | null, turns: Turn[], abort: () => void) => {
    live = { conversationId, turns, abort, streaming: true };
    emit();
  },
  /** The conversation is created partway through streaming. Its id becomes known only when `onConversation` fires. */
  identify: (conversationId: string) => {
    if (!live) return;
    live = { ...live, conversationId };
    emit();
  },
  /** Updates the last turn (the assistant's turn). During generation, this is the only turn that changes. */
  patchLast: (f: (t: Turn) => Turn) => {
    if (!live) return;
    const turns = [...live.turns];
    turns[turns.length - 1] = f(turns[turns.length - 1]);
    live = { ...live, turns };
    emit();
  },
  /** Ends the reply (on success, on error, or when the user presses stop).
   *
   * **This does not clear the state.** An earlier version cleared it, and
   * that version had a hard-to-see bug: navigating away unmounted the
   * component, so "hand the final result back to the component" called
   * into an already-unmounted component and did nothing. The store then
   * went empty, and the new component, having already claimed this reply
   * earlier, did not read from the database again. On return, the whole
   * conversation appeared blank, including the user's own question.
   *
   * At that moment, this store is the only place still holding the
   * content, so it stays here; only `streaming` changes to `false`. The
   * next `start` call replaces it, and switching to a different
   * conversation naturally hides it, because the id no longer matches.
   */
  finish: () => {
    if (!live) return;
    live = { ...live, streaming: false };
    emit();
  },
};

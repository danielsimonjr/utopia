/* Chat: an agentic conversation, with search and graph tools plus a remember tool.
   Conversation persistence: the left rail lists conversations. The server builds the
   context; the frontend sends only conversation_id and the new message. The action
   trace (steps) and citations (sources) save with each message. Playback of history and
   the live stream share the same rendering code. */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import remend from "remend";
import {
  ArrowUp,
  BookOpen,
  Check,
  ChevronDown,
  Database,
  GitCompareArrows,
  History,
  Search as SearchIcon,
  Square,
  SquarePen,
  MoreHorizontal,
  Waypoints,
  Wrench,
} from "lucide-react";
import { ThinkingOrb, type OrbState } from "thinking-orbs";
import {
  conversationsApi,
  reattachChat,
  streamChat,
  type ChatStep,
  type ConversationRow,
} from "../api";
import { S } from "../i18n";
import { toast } from "../toast";
import { useKb, useKbId } from "../kb";
import { DangerConfirm, RAIL_CLS } from "../ui";
import { liveAnswer, type Turn } from "../liveAnswer";

/* `Turn` is defined in liveAnswer.ts. A turn still in progress is also a Turn, and it
   must outlive this component (see the note at the top of that file). */

/** Same-tab memory: the last conversation per KB, and an unsent draft. This state
 * restores when the user returns to the page, and starts empty in a new tab. */
const lastKey = (kbId: string) => `chat:last:${kbId}`;
const DRAFT_KEY = "chat:draft";

export function Chat() {
  const kbId = useKbId();
  const { kb, kbs, setKb } = useKb();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // A conversation is a route: /chat/$conversationId. The URL is the single source of
  // truth for the current conversation, so a refresh or back navigation works naturally.
  const { conversationId: routeConvId } = useParams({ strict: false }) as {
    conversationId?: string;
  };
  const [activeId, setActiveId] = useState<string | null>(null);
  // The route-sync effect checks this ref. A state update commits later than the
  // re-render that navigate triggers. Writing to a ref synchronously makes the guard for
  // "only the URL changes after streaming creates a conversation" reliable.
  const activeIdRef = useRef<string | null>(null);
  // Turns already finished, read from the database. **The turn in progress is not here.**
  // See below.
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState(() => sessionStorage.getItem(DRAFT_KEY) ?? "");
  // The turn in progress lives outside this component, so it survives when the user
  // navigates away and back (see liveAnswer.ts). For a new conversation, its id is null,
  // and activeId is also null, so the two match.
  const live = useSyncExternalStore(liveAnswer.subscribe, liveAnswer.get);
  /* **This checks whether *this* conversation is streaming, not whether *any*
     conversation is streaming.** A global flag would turn this input box into a stop
     button, and block sending, while another conversation streams elsewhere. It would
     also mark the last turn here as still streaming, which hides its sources (see the
     check in TurnView). A response generating elsewhere must not change anything here. */
  /* **This claims the conversation by URL, not by state.** The top of this file states
     that the URL is the single source of truth for the current conversation. An earlier
     version used `activeId` instead, a piece of state that updates later than the first
     render after navigation, so that first render did not recognize its own conversation
     and showed an empty screen. The id in the address bar has no such timing issue. For
     a new conversation with no id yet, both values are null, so they still match. */
  const currentId = routeConvId ?? activeId;
  const liveHere = live && live.conversationId === currentId ? live : null;
  const streaming = liveHere?.streaming ?? false;
  const shown = liveHere ? liveHere.turns : turns;
  const [scopeOpen, setScopeOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ConversationRow | null>(null);
  // Conversation search. **This searches both the title and the message text,** because
  // a user often remembers the question they asked, not the title.
  const [convSearch, setConvSearch] = useState("");
  // Which row has its three-dot menu open. Only one menu is open at a time.
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const abortRef = useRef<(() => void) | null>(null);
  const scopeRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // The scope popover closes on an outside click or on Escape, the same convention as
  // ui/Dropdown.
  useEffect(() => {
    if (!scopeOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!scopeRef.current?.contains(e.target as Node)) setScopeOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setScopeOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [scopeOpen]);

  const convs = useQuery({
    queryKey: ["conversations", kb?.id, convSearch],
    queryFn: () => conversationsApi.list(kb!.id, convSearch),
    enabled: !!kb,
    placeholderData: (prev) => prev,
  });
  // Renaming a conversation: **this edits in place** and does not open a dialog.
  // Changing a name does not need to interrupt the whole page.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const rename = useMutation({
    mutationFn: (v: { id: string; title: string }) =>
      conversationsApi.rename(kb!.id, v.id, v.title),
    onSuccess: () => {
      setRenamingId(null);
      queryClient.invalidateQueries({ queryKey: ["conversations", kb?.id] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Scrolls to the bottom instantly. Smooth scrolling would crawl slowly as streamed
  // text keeps appending.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "instant" });
  }, [shown]);

  // Switching the KB scope starts a new conversation. The first time the page gets a KB
  // does not count as a switch, so a direct load of /chat/$id keeps its URL.
  const prevKbRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevKbRef.current;
    prevKbRef.current = kb?.id ?? null;
    if (prev && kb && prev !== kb.id) {
      // **This does not abort.** Switching the KB must not stop a response streaming for
      // another KB; that response still saves to its own conversation.
      activeIdRef.current = null;
      setActiveId(null);
      setTurns([]);
      navigate({ to: "/kb/$kbId/chat", params: { kbId }, replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kb?.id]);

  // Loads a conversation from the route. A bare /chat restores the KB's last conversation,
  // so returning to the page keeps the same conversation.
  useEffect(() => {
    if (!kb) return;
    if (!routeConvId) {
      const last = sessionStorage.getItem(lastKey(kb.id));
      if (last) {
        navigate({
          to: "/kb/$kbId/chat/$conversationId",
          params: { kbId, conversationId: last },
          replace: true,
        });
      }
      return;
    }
    if (routeConvId === activeIdRef.current) return; // After streaming creates a conversation, only the URL changes; skip reload.
    loadConversation(routeConvId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kb?.id, routeConvId]);

  // Sizes the input box to fit a restored draft. onChange keeps the height in sync otherwise.
  useEffect(() => {
    const el = inputRef.current;
    if (el && el.value) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 192)}px`;
    }
  }, []);

  const invalidateList = () =>
    queryClient.invalidateQueries({ queryKey: ["conversations", kb?.id] });

  /** A click in the list only changes the URL. The route-sync effect loads the conversation. */
  const openConversation = (id: string) =>
    navigate({
      to: "/kb/$kbId/chat/$conversationId",
      params: { kbId, conversationId: id },
    });

  /** Reattaches to a response still generating. If none is running, the server returns
   * `idle` and nothing happens. */
  const attachIfRunning = (id: string, history: Turn[]) => {
    let abort = () => {};
    const stop = reattachChat(kb!.id, id, {
      onConversation: () => {},
      /* **This creates the turn only when the snapshot arrives.** Adding an empty turn
         before the response is known would flash an empty assistant bubble on a
         conversation with nothing running, which is the common case. The snapshot
         replaces the turn's content; it is the full state of the response at that
         moment, not a delta. */
      onSnapshot: (s) =>
        liveAnswer.start(
          id,
          [
            ...history,
            {
              role: "assistant",
              content: s.content,
              steps: s.steps.length ? s.steps : undefined,
              sources: s.sources.length ? s.sources : undefined,
            },
          ],
          abort,
        ),
      onSources: (sources) => liveAnswer.patchLast((t) => ({ ...t, sources })),
      onStep: (step) =>
        liveAnswer.patchLast((t) => ({ ...t, steps: [...(t.steps ?? []), step] })),
      onDelta: (text) => liveAnswer.patchLast((t) => ({ ...t, content: t.content + text })),
      onDone: () => {
        liveAnswer.finish();
        invalidateList();
      },
      onError: (message) => {
        liveAnswer.patchLast((t) => ({ ...t, error: message }));
        liveAnswer.finish();
      },
      onIdle: () => {},
    });
    abort = stop;
    abortRef.current = stop;
  };

  const loadConversation = async (id: string) => {
    // Returning to a conversation that is still writing: claim it directly, and skip the
    // database read. The database has this row only after writing finishes.
    if (liveAnswer.get()?.conversationId === id) {
      activeIdRef.current = id;
      setActiveId(id);
      return;
    }
    activeIdRef.current = id;
    setActiveId(id);
    try {
      const { messages } = await conversationsApi.detail(kb!.id, id);
      sessionStorage.setItem(lastKey(kb!.id), id);
      const history: Turn[] = messages.map((m) => ({
        role: m.role,
        content: m.content,
        steps: m.steps.length ? m.steps : undefined,
        sources: m.sources.length ? m.sources : undefined,
      }));
      setTurns(history);
      /* **This reattaches after a page refresh.** The store above lives only on this
         page; a refresh, a new tab, or a different machine cannot reach it, while
         generation can still run on the server. This asks "is anything running for this
         conversation?" The common answer is no, at the cost of one request that returns
         `idle` right away. This asks only when the last message is from the user, which
         is the shape of "asked but not yet answered". */
      if (history[history.length - 1]?.role === "user") {
        attachIfRunning(id, history);
      }
    } catch {
      // An invalid link (a deleted conversation, or one from another KB): return quietly
      // to a new conversation.
      sessionStorage.removeItem(lastKey(kb!.id));
      activeIdRef.current = null;
      setActiveId(null);
      setTurns([]);
      navigate({ to: "/kb/$kbId/chat", params: { kbId }, replace: true });
    }
  };

  const newChat = () => {
    // Also does not abort: starting a new conversation does not give up the last one.
    if (kb) sessionStorage.removeItem(lastKey(kb.id));
    activeIdRef.current = null;
    setActiveId(null);
    setTurns([]);
    navigate({ to: "/kb/$kbId/chat", params: { kbId } });
    inputRef.current?.focus();
  };

  const removeConversation = async (id: string) => {
    await conversationsApi.remove(kb!.id, id);
    if (sessionStorage.getItem(lastKey(kb!.id)) === id) {
      sessionStorage.removeItem(lastKey(kb!.id));
    }
    invalidateList();
    if (id === activeId) newChat();
  };

  const send = () => {
    const q = input.trim();
    if (!q || streaming || !kb) return;
    setInput("");
    sessionStorage.removeItem(DRAFT_KEY);
    if (inputRef.current) inputRef.current.style.height = "auto";

    /* **The result stays in the store; it does not return to component state.**
       Returning it would go through a `setTurns` call, and this component may already
       be unmounted when the stream ends. That call would be a no-op, and the content
       would be lost, showing a blank screen with not even the question bubble. Keeping
       the result in the store lets whichever component mounts next claim it. */
    const abort = streamChat(
      kb.id,
      { conversation_id: activeId ?? undefined, message: q },
      {
        onConversation: (id) => {
          liveAnswer.identify(id);
          // Writes the ref synchronously before changing the URL. The route-sync effect
          // then sees a matching id and skips reload, so it does not interrupt the stream.
          activeIdRef.current = id;
          setActiveId(id);
          sessionStorage.setItem(lastKey(kb.id), id);
          navigate({
            to: "/kb/$kbId/chat/$conversationId",
            params: { kbId, conversationId: id },
            replace: true,
          });
          invalidateList();
        },
        onSources: (sources) => liveAnswer.patchLast((t) => ({ ...t, sources })),
        onStep: (step) =>
          liveAnswer.patchLast((t) => ({ ...t, steps: [...(t.steps ?? []), step] })),
        onDelta: (text) =>
          liveAnswer.patchLast((t) => ({ ...t, content: t.content + text })),
        onDone: () => {
          liveAnswer.finish();
          invalidateList();
        },
        onError: (message) => {
          liveAnswer.patchLast((t) => ({ ...t, error: message }));
          liveAnswer.finish();
        },
      },
    );
    abortRef.current = abort;
    liveAnswer.start(
      activeId,
      [...turns, { role: "user", content: q }, { role: "assistant", content: "" }],
      abort,
    );
  };

  /* The composer card. It centers on a new conversation's first screen, then docks at
     the bottom once the conversation has messages. This same JSX block is used in both
     places. */
  const composerCard = (
    <div className="rounded-2xl border border-white/[0.12] bg-white/[0.04] backdrop-blur-md focus-within:border-white/30 transition-colors px-4 pt-3 pb-2">
      <textarea
        ref={inputRef}
        rows={1}
        className="w-full bg-transparent outline-none text-sm resize-none leading-relaxed max-h-48 u-scroll placeholder:text-neutral-600"
        placeholder={S.ask.placeholder}
        value={input}
        onChange={(e) => {
          setInput(e.target.value);
          sessionStorage.setItem(DRAFT_KEY, e.target.value);
          const el = e.currentTarget;
          el.style.height = "auto";
          el.style.height = `${Math.min(el.scrollHeight, 192)}px`;
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className="flex items-center justify-between gap-3 pt-1">
        <div className="flex items-center gap-2.5 min-w-0">
          {/* The scope chip shows which KB the question targets. Switching it here follows
              the existing rule: it starts a new conversation. */}
          <div ref={scopeRef} className="relative shrink-0">
            <button
              onClick={() => setScopeOpen((v) => !v)}
              title={S.ask.scopeLabel}
              className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200 hover:bg-white/[0.07] transition-colors max-w-52"
            >
              <Database size={12} className="shrink-0 text-neutral-500" />
              <span className="truncate">{kb?.name ?? "…"}</span>
              <ChevronDown
                size={11}
                className={`shrink-0 text-neutral-600 transition-transform ${
                  scopeOpen ? "rotate-180" : ""
                }`}
              />
            </button>
            {scopeOpen && (
              <div className="u-pop u-pop-up absolute bottom-full mb-1.5 left-0 z-50 w-56 rounded-lg shadow-xl overflow-hidden">
                <div className="px-2.5 pt-2 pb-1 text-[9.5px] font-medium uppercase tracking-[0.1em] text-neutral-600 border-b border-white/5">
                  {S.ask.scopeLabel}
                </div>
                <div className="u-scroll max-h-60 overflow-y-auto">
                  {kbs.map((k) => (
                    <button
                      key={k.id}
                      onClick={() => {
                        setScopeOpen(false);
                        if (k.id !== kb?.id) setKb(k.id);
                      }}
                      className={`w-full flex items-center gap-2 text-left px-2.5 py-1.5 text-xs ${
                        k.id === kb?.id
                          ? "bg-white/[0.12] text-white"
                          : "text-neutral-300 hover:bg-white/[0.06] hover:text-white"
                      }`}
                    >
                      <span className="flex-1 min-w-0 truncate">{k.name}</span>
                      {k.id === kb?.id && <Check size={12} className="shrink-0 text-neutral-400" />}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <span className="text-[11px] text-neutral-600 truncate">{S.ask.composerHint}</span>
        </div>
        {streaming ? (
          <button
            onClick={() => {
              // **This is the only place that aborts.** Navigating away, switching
              // conversations, or switching KBs no longer interrupts the stream
              // (see liveAnswer.ts).
              abortRef.current?.();
              liveAnswer.finish();
            }}
            title={S.ask.stop}
            className="h-8 w-8 shrink-0 rounded-lg grid place-items-center bg-white/[0.08] text-neutral-200 hover:bg-white/[0.14] transition-colors"
          >
            <Square size={11} fill="currentColor" />
          </button>
        ) : (
          <button
            onClick={send}
            disabled={!input.trim()}
            title={S.ask.send}
            className={`h-8 w-8 shrink-0 rounded-lg grid place-items-center transition-colors ${
              input.trim()
                ? "bg-white text-black hover:bg-neutral-200"
                : "bg-white/[0.07] text-neutral-600"
            }`}
          >
            <ArrowUp size={15} strokeWidth={2.4} />
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div className="h-full flex">
      {/* The conversation rail */}
      <aside className={`${RAIL_CLS} flex flex-col`}>
        <div className="px-2 pt-3 pb-1">
          {/* This uses the same style as a conversation row. The rail is a column of
              uniform rows, and "New chat" is simply the first row. */}
          <button
            onClick={newChat}
            className="w-full flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-neutral-300 hover:bg-white/[0.05] hover:text-white transition-colors"
          >
            <SquarePen size={14} className="shrink-0 text-neutral-500" />
            {S.ask.newChat}
          </button>
        </div>
        {/* Search. **Duplicate titles are common,** because asking the same question
            twice creates a duplicate title. The message text is what a user remembers,
            so the server searches both fields. */}
        <div className="px-2 pb-2">
          <input
            className="input-dark w-full px-2.5 py-1.5 text-[12.5px]"
            placeholder={S.ask.searchConversations}
            value={convSearch}
            onChange={(e) => setConvSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setConvSearch("")}
          />
        </div>
        <div className="u-scroll flex-1 overflow-y-auto px-2 pb-3 space-y-0.5">
          {(convs.data?.conversations ?? []).map((c: ConversationRow) => (
            <div
              key={c.id}
              className={`group relative rounded-lg transition-colors ${
                c.id === activeId ? "u-nav-active" : "hover:bg-white/[0.05]"
              }`}
            >
              {/* A single-line title. The delete action appears on hover, and it opens a
                  confirm dialog instead of deleting right away. */}
              {renamingId === c.id ? (
                /* Edits in place: Enter saves, Escape cancels. Changing a name does not
                   need a dialog. */
                <input
                  autoFocus
                  className="input-dark w-full px-2 py-1.5 text-[13px]"
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onBlur={() => setRenamingId(null)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && renameDraft.trim())
                      rename.mutate({ id: c.id, title: renameDraft });
                    if (e.key === "Escape") setRenamingId(null);
                  }}
                />
              ) : (
                <button
                  onClick={() => openConversation(c.id)}
                  className="w-full text-left px-2.5 py-2"
                >
                  <span
                    className={`block truncate pr-5 text-[13px] ${
                      c.id === activeId ? "text-white" : "text-neutral-300"
                    }`}
                  >
                    {c.title || S.ask.untitled}
                  </span>
                </button>
              )}
              {/* The three-dot menu: **one entry point holds all actions.** An earlier
                  version put delete directly on the right edge, but delete is the action
                  that most needs a confirm step, not a one-click action. */}
              {renamingId !== c.id && (
                <button
                  onClick={() => setMenuFor(menuFor === c.id ? null : c.id)}
                  title={S.ask.moreActions}
                  className="absolute right-2 top-1/2 -translate-y-1/2 hidden group-hover:block text-neutral-600 hover:text-neutral-200"
                >
                  <MoreHorizontal size={14} />
                </button>
              )}
              {menuFor === c.id && (
                <>
                  {/* Closes on an outside click. This overlay covers the full screen
                      instead of listening on document, so there is no listener to
                      remove on unmount. */}
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => setMenuFor(null)}
                  />
                  <div className="glass-strong absolute right-2 top-8 z-20 w-32 rounded-lg py-1 shadow-xl">
                    <button
                      className="w-full px-3 py-1.5 text-left text-xs text-neutral-300 hover:bg-white/5"
                      onClick={() => {
                        setRenameDraft(c.title || "");
                        setRenamingId(c.id);
                        setMenuFor(null);
                      }}
                    >
                      {S.ask.rename}
                    </button>
                    <button
                      className="w-full px-3 py-1.5 text-left text-xs text-neutral-300 hover:bg-white/5"
                      onClick={() => {
                        navigator.clipboard?.writeText(c.title || "");
                        setMenuFor(null);
                      }}
                    >
                      {S.ask.copyTitle}
                    </button>
                    <button
                      className="w-full px-3 py-1.5 text-left text-xs text-[var(--u-danger)] hover:bg-white/5"
                      onClick={() => {
                        setPendingDelete(c);
                        setMenuFor(null);
                      }}
                    >
                      {S.ask.deleteConversation}
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
          {convs.data?.conversations.length === 0 && (
            <p className="px-2.5 py-2 text-xs text-neutral-600">{S.ask.noConversations}</p>
          )}
        </div>
      </aside>

      {/* The conversation area. A new conversation's first screen shows a greeting with
          a centered composer, the convention used by ChatGPT and Claude. Once the
          conversation has messages, the composer docks at the bottom. */}
      <div className="flex-1 min-w-0 flex flex-col">
        {shown.length === 0 ? (
          /* This anchors to the upper third of the screen, not the vertical center. A
             vertical center looks too low on a tall window. 22vh plus roughly 100px of
             top chrome puts the greeting at about 37% height and the composer center
             at about 49%. */
          <div className="flex-1 px-4 pt-[22vh]">
            <div className="w-full max-w-3xl mx-auto">
              <h1
                className="text-center text-[26px] text-neutral-100 mb-9"
                style={{ fontFamily: "var(--font-brand)", letterSpacing: "0.03em" }}
              >
                {S.ask.greeting}
              </h1>
              {composerCard}
            </div>
          </div>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto u-scroll px-4 py-6">
              <div className="max-w-3xl mx-auto space-y-4">
                {shown.map((t, i) => (
                  <TurnView key={i} turn={t} live={streaming && i === shown.length - 1} />
                ))}
                <div ref={bottomRef} />
              </div>
            </div>
            <div className="px-4 pb-4 pt-2">
              <div className="max-w-3xl mx-auto">{composerCard}</div>
            </div>
          </>
        )}
      </div>

      {pendingDelete && (
        <DangerConfirm
          title={S.ask.deleteTitle}
          hint={S.ask.deleteHint(pendingDelete.title || S.ask.untitled)}
          confirmLabel={S.ask.deleteBtn}
          cancelLabel={S.ask.cancel}
          onConfirm={() => {
            removeConversation(pendingDelete.id);
            setPendingDelete(null);
          }}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}

/** One block of text, or one group of calls that happened at the same time. */
type Segment =
  | { kind: "text"; text: string; last: boolean }
  | { kind: "steps"; steps: ChatStep[] };

/** Splits one turn's reply into segments, ordered by when each part happened.
 *
 *  The split point is `step.at`: how long the text was when that step happened. **A
 *  message saved before this migration has no `at` value.** That order information was
 *  never stored, so this code does not invent it. Those older messages fall back to the
 *  old layout, with the whole trace first. */
function segments(turn: Turn): Segment[] {
  const steps = turn.steps ?? [];
  const text = turn.content ?? "";
  if (steps.length === 0) {
    return text ? [{ kind: "text", text, last: true }] : [];
  }
  if (steps.some((s) => s.at === undefined)) {
    return [
      { kind: "steps", steps },
      ...(text ? [{ kind: "text" as const, text, last: true }] : []),
    ];
  }
  const out: Segment[] = [];
  let cursor = 0;
  for (let i = 0; i < steps.length; ) {
    const at = steps[i].at!;
    // Groups steps at the same position. Multiple calls in one turn with no text between
    // them are one fan-out, by nature.
    let j = i;
    while (j < steps.length && steps[j].at === at) j++;
    const before = text.slice(cursor, at);
    if (before) out.push({ kind: "text", text: before, last: false });
    out.push({ kind: "steps", steps: steps.slice(i, j) });
    cursor = at;
    i = j;
  }
  const tail = text.slice(cursor);
  if (tail) out.push({ kind: "text", text: tail, last: true });
  return out;
}

function stepIcon(kind: ChatStep["kind"]) {
  if (kind === "search") return <SearchIcon size={11} />;
  if (kind === "docs") return <BookOpen size={11} />;
  if (kind === "entity") return <Waypoints size={11} />;
  if (kind === "facts") return <History size={11} />;
  // The `facts` tool reads the world axis and `changes` reads the knowledge axis. These
  // two graph tools use different icons, so the user can tell which axis a step queries.
  if (kind === "changes") return <GitCompareArrows size={11} />;
  if (kind === "query") return <Database size={11} />;
  return <Wrench size={11} />;
}

/** Maps a tool step to an orb state, so the thinking orb reflects the current action. */
function orbState(kind?: ChatStep["kind"]): OrbState {
  if (kind === "search" || kind === "docs") return "searching";
  if (kind === "entity") return "connecting";
  if (kind === "facts" || kind === "changes") return "solving";
  if (kind === "query" || kind === "tool") return "working";
  return "listening"; // No step yet: the message just arrived.
}

/** The thinking indicator: a thinking-orbs sphere plus the current action. The app uses
 * a fixed dark theme, so theme is set to "dark". */
function Thinking({ step }: { step?: ChatStep }) {
  return (
    <span className="inline-flex items-center gap-2.5 text-neutral-500">
      <ThinkingOrb state={orbState(step?.kind)} size={20} theme="dark" />
      {step && (
        <span className="text-xs truncate">
          {step.label} · {step.detail}
        </span>
      )}
    </span>
  );
}

function TurnView({ turn, live }: { turn: Turn; live?: boolean }) {
  const kbId = useKbId();
  if (turn.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="u-bubble-user max-w-[85%] rounded-2xl rounded-tr-sm px-4 py-2 text-sm whitespace-pre-wrap text-neutral-100">
          {turn.content}
        </div>
      </div>
    );
  }

  const thinking = live && !turn.content && !turn.error;
  const lastStep = turn.steps?.[turn.steps.length - 1];

  return (
    <div className="max-w-[95%]">
      {/* An agent reply has no bubble: its text sits directly on the canvas. A user
          message keeps its bubble, to tell the roles apart. */}
      <div className="py-1 text-sm text-neutral-200 leading-relaxed">
        {/* **The trace runs through the text in the order it happened.** The model talks
            and calls tools by turns: a sentence, a call, another sentence. Moving all
            calls to the front would read as "seven searches, then the full answer",
            which is not what happened, and it would separate a sentence such as "let me
            check this one" from the call it explains. Multiple calls at the same position
            in one turn share that position, so they group together naturally, and each
            group is one turn. */}
        {segments(turn).map((seg, i) =>
          seg.kind === "steps" ? (
            <div
              key={i}
              className="my-2.5 space-y-1 border-l border-white/15 pl-2.5"
            >
              {seg.steps.map((s, j) => (
                <div key={j} className="flex items-center gap-1.5 text-xs">
                  <span className="text-neutral-600">{stepIcon(s.kind)}</span>
                  <span className="text-neutral-400 truncate">{s.label}</span>
                  <span className="text-neutral-600 shrink-0">· {s.detail}</span>
                </div>
              ))}
            </div>
          ) : (
            /* react-markdown renders the text, with all styling in the u-chat-prose
               design system. During streaming, remend repairs unclosed syntax such as
               bold, fenced code, and links. rehype-highlight adds code highlighting.
               These parts are established libraries assembled together, and the look
               stays consistent. **Only the segment still growing needs remend,** because
               an earlier segment has already closed. */
            <div key={i} className="u-chat-prose">
              <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                {live && seg.last ? remend(seg.text) : seg.text}
              </Markdown>
            </div>
          ),
        )}
        {thinking && <Thinking step={lastStep} />}
        {turn.error && <div className="text-rose-400">{turn.error}</div>}
      </div>
      {/* **Sources appear only after the answer finishes.** `sources` arrives in
          increments as retrieval runs. Rendering it as it arrives would attach a
          growing list to a sentence still being written, and it would keep pushing the
          text upward. Sources are the answer's signature, not part of the process; the
          trace above already explains the process. */}
      {!live && turn.sources && turn.sources.length > 0 && (
        <div className="mt-2 space-y-1">
          {turn.sources.map((s) =>
            s.kind === "charter" ? (
              /* A guide citation. Its BookOpen icon sets it apart from a data citation,
                 and it links to a formatted section in /docs. */
              <Link
                key={s.n}
                to="/docs/$slug"
                params={{ slug: s.slug! }}
                hash={s.anchor || undefined}
                title={s.excerpt}
                className="flex items-center gap-1.5 text-xs text-neutral-500 glass rounded-lg px-3 py-1.5 glass-hover hover:text-neutral-300"
              >
                <span className="u-num text-[var(--u-accent)]">[{s.n}]</span>
                <BookOpen size={11} className="shrink-0 text-neutral-600" />
                <span className="truncate">
                  {/* When the heading equals the article name, this skips "X › X". */}
                  {s.heading && s.heading !== s.filename
                    ? `${s.filename} › ${s.heading}`
                    : s.filename}
                </span>
              </Link>
            ) : (
              <Link
                key={s.n}
                to="/kb/$kbId/doc/$docId"
                params={{ kbId, docId: s.document_id! }}
                search={{ chunk: s.chunk_id }}
                title={s.excerpt}
                className="block text-xs text-neutral-500 glass rounded-lg px-3 py-1.5 glass-hover hover:text-neutral-300"
              >
                <span className="u-num text-[var(--u-accent)]">[{s.n}]</span> {s.filename} ·{" "}
                {s.excerpt.slice(0, 60)}…
              </Link>
            ),
          )}
        </div>
      )}
    </div>
  );
}

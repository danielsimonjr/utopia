/**
 * Agentic chat: the model gathers evidence on its own (document search /
 * entity lookup / temporal facts) with tools, then answers.
 *
 * Event sequence: `step`* (the action trace) | `sources` (the citation
 * list, updated incrementally as retrieval runs) | `delta`* (text
 * increments) -> `done` | `error`. A model with no tool-calling support
 * falls back to a one-shot RAG injection.
 */

import type { Hono, Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppState } from "../../state";
import * as store from "../../store";
import * as auth from "../../auth";
import { AppError } from "../../core/errors";
import { uuidParam, queryStr, queryInt, clampLimit, clampOffset } from "../context";
import * as llmUtil from "../../llm_util";
import * as retrieval from "../../retrieval";
import { frame, snapshotFrame, type Frame, type Snapshot } from "../../live";
import * as tools from "./tools";
import type { ChunkView } from "../../core/models";
import type { AssistantTurn } from "../../llm";
import { assistantTurnToMessage, toolResultMessage } from "../../llm";
import type { Uuid } from "../../core/ids";

/**
 * Replays a few already-recognized entities. Capped because a long
 * conversation piles up dozens of them, and sending all of them back
 * spends the very context we saved; ordered by first appearance, since
 * the earliest recognized ones are usually the conversation's real
 * subjects.
 */
const KNOWN_ENTITY_LIMIT = 20;

const MAX_HISTORY = 20;
const MAX_ROUNDS = 6;

/**
 * **`remember` is disabled for now** (see `docs/decisions/0015`).
 *
 * Today it would turn one sentence directly into a live graph edge, with
 * no visible step in between: testing it, "remember Acme moved its HQ to
 * Shenzhen" landed as an edge with an **empty predicate and 0.9
 * confidence** — the ontology has no "relocated to" relation, and
 * extraction correctly leaves it blank rather than invent one (0010 says
 * this is right). So what the assistant claims and what lands on the
 * graph are two different things.
 *
 * 0018 built `pending_facts`: an extracted fact waits for a person's nod
 * first. **Flip this back to true once extraction is wired to that
 * table.** Until then, no tool at all is better than one that quietly
 * edits the graph.
 */
export const REMEMBER_ENABLED = false;

export type ChatReq = {
  /** default = a new conversation (the SSE stream's first `conversation` event returns the id) */
  conversation_id?: Uuid;
  message: string;
};

/** The tool schema — **the copy the model sees**. */
export function baseTools(): unknown[] {
  return [
    {
      type: "function",
      function: {
        name: "search_chunks",
        description:
          "Full-text + semantic search over the knowledge base documents. " +
          "Returns numbered source excerpts you can cite as [n].",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query, phrased in the corpus language." },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "search_docs",
        description:
          "Search Utopia's own user manual (the Charter): how the platform " +
          "itself works — sources and ingestion, sync semantics (missing markers, " +
          "tombstones, versions), the knowledge graph and review flow, roles and " +
          "permissions, settings. Use ONLY for questions about using or understanding " +
          "Utopia itself, or to explain platform concepts that appear in other tool " +
          "results (e.g. why a document is marked missing). NEVER use it to answer " +
          "questions about the content stored in the knowledge base.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "What to look up in the manual." },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "find_entities",
        description:
          "Look up entities in the knowledge graph by (partial) name. " +
          "Returns id, name, type and a disambiguator when several entities share a name.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Entity name or a fragment of it." },
          },
          required: ["name"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "entity_facts",
        description:
          "Facts about one entity from the bi-temporal knowledge graph: " +
          "relations with validity ranges (from → to; 'now' = still ongoing). " +
          "The best tool for who/when/history questions. Use after find_entities. " +
          "Pass `at` to see the world as of that date (server-side filter) — " +
          "always do this for \"who was X in <year/month>\" questions.",
        parameters: {
          type: "object",
          properties: {
            entity_id: { type: "string", description: "Entity id (uuid) from find_entities." },
            at: {
              type: "string",
              description:
                "Optional as-of date (YYYY-MM-DD). Only facts valid on " +
                "this date are returned. Omit for the full history.",
            },
          },
          required: ["entity_id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "changes",
        description:
          "What the graph LEARNED or REVISED in a window of record time — the belief axis. " +
          "Answers \"what changed since X\", \"what did we get wrong\", " +
          "\"what is new this quarter\", and needs no entity, so use it when the " +
          "question names a period rather than a subject. " +
          "Events: asserted (new claim), corrected (a claim replaced by a revised one), " +
          "rejected (a claim withdrawn), merged (folded into another claim) — each with " +
          "the document it came from. " +
          "NOT the same axis as entity_facts(at): that asks \"what was true on date D\"; " +
          "this asks \"what did we change our mind about between D1 and D2\". A fact " +
          "about 2019 can be recorded in 2026 — this windows on when we recorded it.",
        parameters: {
          type: "object",
          properties: {
            since: { type: "string", description: "Start of the window (YYYY-MM-DD), inclusive." },
            until: {
              type: "string",
              description:
                "End of the window (YYYY-MM-DD), inclusive of that whole day. Omit for 'up to now'.",
            },
            entity_id: {
              type: "string",
              description:
                "Optional entity id from find_entities, to narrow the window to changes touching that one entity.",
            },
            kinds: {
              type: "array",
              items: { type: "string", enum: ["asserted", "corrected", "rejected", "merged"] },
              description:
                "Optional filter. A freshly ingested corpus is nearly all 'asserted'; " +
                "pass [\"corrected\", \"rejected\"] to isolate the places we actually changed our mind.",
            },
          },
          required: ["since"],
        },
      },
    },
  ];
}

function toolsSchema(canWrite: boolean, dataSourceNames: string[]): any[] {
  const arr = baseTools() as any[];
  if (dataSourceNames.length > 0) {
    arr.push({
      type: "function",
      function: {
        name: "query_data",
        description:
          `Run a read-only SQL query against a mounted database. Available sources: ` +
          `${dataSourceNames.join(", ")}. Search the source's schema document first ` +
          `(search_chunks) if unsure of tables/columns. Only a single SELECT/WITH statement ` +
          `is allowed; a LIMIT is enforced server-side; results come back as JSON lines. If the ` +
          `query errors, fix the SQL and retry once.`,
        parameters: {
          type: "object",
          properties: {
            data_source: { type: "string", description: "Name of the mounted data source to query." },
            sql: { type: "string", description: "One SELECT/WITH statement (PostgreSQL dialect)." },
            purpose: {
              type: "string",
              description: "One short phrase: what this query answers (shown to the user).",
            },
          },
          required: ["data_source", "sql"],
        },
      },
    });
  }
  if (canWrite && REMEMBER_ENABLED) {
    arr.push({
      type: "function",
      function: {
        name: "remember",
        description:
          "Record one memory episode into the knowledge base's temporal " +
          "memory. Use ONLY when the user explicitly asks to remember/record " +
          "something, or clearly states a decision or fact to keep. The episode is " +
          "extracted into the knowledge graph; if it contradicts an existing " +
          "single-valued fact, the old fact's validity is closed automatically " +
          "(never deleted). Do not use for casual conversation.",
        parameters: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description:
                "The episode to remember, one self-contained statement (who/what, with names spelled out).",
            },
            occurred_at: {
              type: "string",
              description: "Optional date the stated fact took effect (YYYY-MM-DD). Omit to use today.",
            },
          },
          required: ["text"],
        },
      },
    });
  }
  return arr;
}

type CallCheck =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; message: string; step: Record<string, unknown> };

/**
 * Looks at whether a call said what it wants to do, before running it.
 *
 * **Two kinds of "unclear" used to become an ordinary call silently.**
 *
 * One: the arguments do not parse. When the model's output hits the
 * token cap, `arguments` cuts off mid-way and the JSON is incomplete.
 * This used to fall back to an empty object, and then `search_chunks`
 * would fall back again to the user's own words — a truncated call
 * quietly becomes "search using the user's original question", while the
 * trace shows a perfectly normal `search · 6 sources`.
 *
 * Two: a required argument is simply missing. Same fallback, same result.
 *
 * Neither should be guessed at. **A fallback produces a wrong answer that
 * looks fine** — that is worse than an error: an error makes the model
 * retry, a guess gets no scrutiny because it looks fine.
 *
 * The criterion comes straight from the tool table's `required`: add a
 * required argument and this follows automatically, with nothing to
 * remember to change in a second place.
 */
export function checkCall(toolsArr: any[], name: string, rawArgs: string): CallCheck {
  const refuse = (detail: string, message: string): CallCheck => ({
    ok: false,
    message,
    step: { kind: "tool", label: name, detail },
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArgs);
  } catch {
    return refuse(
      "bad arguments",
      `The arguments for ${name} were not valid JSON, so the call was not run. ` +
        `They were probably cut off. Call it again with complete arguments.`,
    );
  }
  const args =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  const toolDef = toolsArr.find((t) => t?.function?.name === name);
  const required: unknown[] = toolDef?.function?.parameters?.required ?? [];
  for (const key of required) {
    if (typeof key !== "string") continue;
    // An empty string and null both count as missing: a retrieval done
    // with `{"query": ""}` comes back unrelated to the question, and it
    // still shows up as a perfectly normal trace step.
    const v = args[key];
    const missing = v === undefined || v === null || (typeof v === "string" && v.trim() === "");
    if (missing) {
      return refuse(
        `missing ${key}`,
        `${name} needs \`${key}\`, and it was missing or empty, so the call was not run. ` +
          `Call it again with \`${key}\` set.`,
      );
    }
  }
  return { ok: true, args };
}

const MEMORY_PROMPT =
  "Memory: you can persist knowledge with the remember tool. Use it when the user says " +
  '"remember/record this" or states a decision meant to last. Confirm in your reply what ' +
  "was recorded. Never invent memories, and never call it for small talk.";

const SYSTEM_PROMPT =
  "You are the assistant of Utopia, a temporal knowledge platform. " +
  "You have tools: search_chunks (document search), find_entities, entity_facts and " +
  "changes (a bi-temporal knowledge graph), and search_docs (Utopia's own manual, the " +
  "Charter).\n" +
  "The graph has TWO independent time axes, and each graph tool reads exactly one:\n" +
  "- World time — when something was true. Read with entity_facts (`at` = as of that date).\n" +
  "- Record time — when we came to believe it, and when we revised it. Read with changes.\n" +
  '"Who was CTO in 2019" is world time; "what did we learn last month" and "what did ' +
  'we get wrong" are record time. The same fact has a position on both.\n' +
  "Boundary: search_docs answers questions about Utopia itself (features, ingestion, " +
  "permissions, what fields like 'missing' or validity ranges mean); the other tools answer " +
  "questions about the knowledge stored in it. Never mix the manual into answers about the " +
  "user's data unless they asked about Utopia's behavior.\n\n" +
  "Method:\n" +
  "First decide what the message is about. A message about THIS CONVERSATION — translate it, " +
  'say it shorter, rephrase it, "what did you just say", "why" — is answered from the ' +
  "transcript above with NO tool calls: the evidence is already in it. Gathering it again is " +
  "not merely wasted work — with several entities sharing a name the second pass can land on " +
  'a different one, and the "translation" then says something else. Just deliver it — no ' +
  "preamble about what you are or are not looking up. Everything below is for messages about " +
  "the user's data.\n" +
  "1. For factual questions — questions about the user's data, never one about this " +
  "conversation — ALWAYS gather evidence with tools before answering. Prefer the " +
  'graph tools for questions about people/organizations/projects and time ("who was X ' +
  'when", "what changed"), search_chunks for content and detail questions. Combine both ' +
  "when useful.\n" +
  "2. Facts carry validity ranges (from → to). For \"as of <date>\" questions pass `at` to " +
  "entity_facts and the server filters to that moment; for history questions omit `at` " +
  "to see the full timeline. State dates in the answer.\n" +
  '2b. For "what changed / what is new / what did we get wrong since <date>", call changes — ' +
  "it needs no entity. Name the document a correction came from in plain prose. Graph tools " +
  "return no [n] numbers and no URLs, so never write a bracketed citation or a placeholder " +
  "like [Link] after one — the document's name IS the attribution.\n" +
  "3. Several entities can share one name — check the disambiguator and pick the right one; " +
  "if genuinely ambiguous, ask the user which one they mean.\n" +
  "4. Stop calling tools as soon as you have enough evidence. Then answer concisely: cite " +
  "document sources with [n] (numbers from search results) at the end of supported " +
  "sentences. If the evidence is insufficient, say so explicitly — never fabricate.\n" +
  "5. Always respond in the same language as the user's question.";

function deltaFrame(text: string): Frame {
  return frame("delta", { text });
}
function doneFrame(): Frame {
  return frame("done", {});
}
function errorFrame(message: string): Frame {
  // **Not JSON.** The frontend reads this event's data as raw text
  // (see `web/src/api.ts`'s `consumeChatStream`), so it must not go
  // through the generic JSON-encoding `frame()` helper.
  return { event: "error", data: message };
}
function sourceJsonLegacy(n: number, c: ChunkView): Record<string, unknown> {
  return {
    n,
    chunk_id: c.id,
    document_id: c.document_id,
    filename: c.filename,
    excerpt: tools.truncate(c.text, 160),
  };
}

/** The fallback path's system prompt (one-shot injection when tool-calling is unavailable). */
function legacySystemPrompt(chunks: ChunkView[]): string {
  if (chunks.length === 0) {
    return (
      "You are an enterprise knowledge base assistant. No relevant sources were " +
      "retrieved for this question. Tell the user the knowledge base lacks material " +
      "on this topic, answer cautiously from general knowledge, and clearly separate " +
      "sourced statements from speculation. Always respond in the same language as " +
      "the user's question."
    );
  }
  let prompt =
    "You are an enterprise knowledge base assistant. Answer strictly based on the " +
    "numbered sources below. When a source supports a statement, append its citation " +
    "number, e.g. [1] or [2], at the end of the sentence. If the sources are " +
    "insufficient, say so explicitly — never fabricate. Always respond in the same " +
    "language as the user's question.\n\n### Sources\n";
  chunks.forEach((c, i) => {
    prompt += `\n[${i + 1}] "${c.filename}" section ${c.seq + 1}:\n${c.text}\n`;
  });
  return prompt;
}

type ProducerCtx = {
  state: AppState;
  kbId: Uuid;
  workspaceId: Uuid;
  conversationId: Uuid;
  canWrite: boolean;
  mountedSources: readonly { id: Uuid; name: string }[];
  mappings: readonly store.mappings.ConceptMapping[];
  history: store.conversations.History;
  query: string;
  client: import("../../llm").LlmClient;
};

/**
 * Runs one generation end to end, yielding SSE frames as it goes.
 *
 * **This does not run tied to the request.** The caller drives it inside
 * a detached background task (see the route handler below) so that
 * closing the browser tab never cancels the LLM call mid-flight — only
 * the connection watching it goes away.
 */
async function* produce(ctx: ProducerCtx): AsyncGenerator<Frame> {
  const { state, kbId, workspaceId, conversationId, canWrite, mountedSources, mappings, history, query, client } =
    ctx;
  const dsNames = mountedSources.map((d) => d.name);
  const toolsArr = toolsSchema(canWrite, dsNames);
  let systemPrompt = canWrite && REMEMBER_ENABLED ? `${SYSTEM_PROMPT}\n${MEMORY_PROMPT}` : SYSTEM_PROMPT;
  if (dsNames.length > 0) {
    systemPrompt +=
      `\nData: query_data runs read-only SQL (PostgreSQL dialect) against: ${dsNames.join(", ")}. ` +
      `For questions about numbers/metrics, search for the source's schema document ` +
      `first, then query. State units and the time range you used in the answer.`;
    if (mappings.length > 0) {
      systemPrompt += "\nSemantic layer (confirmed definitions — use these instead of guessing from schema):";
      for (const m of mappings) {
        const how = m.sql ?? m.expr ?? m.table_name ?? "-";
        const unit = m.unit ? ` [${m.unit}]` : "";
        const note = m.summary ? ` — ${m.summary}` : "";
        systemPrompt += `\n- ${m.concept_name} (${m.source})${unit}: ${how}${note}`;
      }
    }
  }

  const msgs: Record<string, unknown>[] = [{ role: "system", content: systemPrompt }];
  /*
   * **What happened last round goes back where it happened.** The last
   * assistant message is its conclusion; the message carrying
   * `tool_calls` and the tool results happened before it, so they are
   * inserted before it — the order is the real order, and the model
   * reads it as "I asked, I looked it up, I answered".
   *
   * Without this, it only sees its own prose across rounds, so a
   * "translate" follow-up searches again (and can land on a different
   * batch of same-named entities).
   */
  const turns = history.turns;
  let lastAssistant = -1;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i]![0] === "assistant") {
      lastAssistant = i;
      break;
    }
  }
  turns.forEach(([role, content], i) => {
    if (i === lastAssistant) {
      for (const m of history.last_tool_exchange) {
        msgs.push(m as Record<string, unknown>);
      }
    }
    msgs.push({ role, content });
  });
  // **Entities already recognized in earlier rounds, id and all.**
  //
  // Without this, the model only sees the previous round's final answer
  // text, has no idea what it already searched for or which id it got,
  // and re-searches by name — and worse, with same-named entities, two
  // rounds can land on **different** entities, so the two answers are not
  // about the same node.
  //
  // Placed after history and before the current question — position is
  // deference, the same reasoning as `known_block` sitting right next to
  // the body in extraction.
  if (history.entities.length > 0) {
    const lines = history.entities.slice(0, KNOWN_ENTITY_LIMIT).map((e) => {
      const rec = e as Record<string, unknown>;
      return `${rec.id ?? "?"} | ${rec.name ?? "?"} | ${rec.type ?? "?"}`;
    });
    msgs.push({
      role: "user",
      content:
        `Entities already identified earlier in this conversation ` +
        `(id | name | type). Call entity_facts with these ids directly; ` +
        `do not look them up by name again:\n${lines.join("\n")}`,
    });
  }

  // The conversation id is sent first (this is how a new conversation
  // tells the frontend its id).
  yield frame("conversation", { id: conversationId });

  // The citation list and the entities recognized this round. **Kept
  // outside the tools** — the `3` in `[3]` depends on how many were
  // already cited before, and each tool counting its own would give the
  // same chunk two different numbers.
  const sink = new tools.ToolSink();
  // Accumulated for the database: the assistant's full text and the
  // action trace (used for history replay).
  let answerAcc = "";
  const stepsAcc: Record<string, unknown>[] = [];
  // This round's tool round-trip, kept as-is for the database: replaying
  // it next round is how the model knows what it already did.
  const exchangeAcc: Record<string, unknown>[] = [];

  const persistAssistant = async (sources: unknown[]): Promise<void> => {
    await store.conversations.appendMessage(state.sql, conversationId, "assistant", answerAcc, {
      steps: stepsAcc,
      sources,
      resolved: sink.resolved,
      tool_exchange: exchangeAcc,
    });
  };

  let rounds = 0;
  for (;;) {
    if (rounds >= MAX_ROUNDS) {
      // Out of budget: tell the model to answer now from what it has
      // (still streamed).
      msgs.push({
        role: "user",
        content: "(system) Tool budget exhausted. Answer now from the evidence gathered above.",
      });
      try {
        for await (const text of client.chatStreamRaw(msgs)) {
          answerAcc += text;
          yield deltaFrame(text);
        }
      } catch (e) {
        yield errorFrame(e instanceof Error ? e.message : String(e));
        return;
      }
      await persistAssistant(sink.sources);
      yield doneFrame();
      return;
    }

    // The main path streams throughout: text increments go out right
    // away, tool calls are merged in once the stream ends.
    let stream: AsyncGenerator<import("../../llm").ToolStreamItem>;
    try {
      stream = client.chatToolsStream(msgs, toolsArr);
      // Force the first chunk now, so a connection failure surfaces here
      // (inside this try) rather than mid-iteration below.
    } catch (e) {
      yield* handleStreamStartFailure(ctx, e, msgs, answerAcc, stepsAcc, sink, exchangeAcc);
      return;
    }

    let turn: AssistantTurn | null = null;
    try {
      for await (const item of stream) {
        if (item.kind === "delta") {
          answerAcc += item.text;
          yield deltaFrame(item.text);
        } else {
          turn = item.turn;
        }
      }
    } catch (e) {
      if (rounds === 0) {
        yield* legacyFallback(ctx, msgs, answerAcc, stepsAcc, sink, exchangeAcc);
        return;
      }
      yield errorFrame(e instanceof Error ? e.message : String(e));
      return;
    }
    if (!turn) {
      yield errorFrame("LLM stream ended unexpectedly");
      return;
    }

    if (turn.toolCalls.length === 0) {
      if (answerAcc === "") {
        yield errorFrame("Model returned an empty answer");
      } else {
        await persistAssistant(sink.sources);
        yield doneFrame();
      }
      return;
    }

    // A tool round carries narration text: insert a paragraph break
    // between it and the next round's body.
    if (turn.content && answerAcc !== "") {
      answerAcc += "\n\n";
      yield deltaFrame("\n\n");
    }

    const callMsg = assistantTurnToMessage(turn);
    exchangeAcc.push(callMsg);
    msgs.push(callMsg);

    for (const call of turn.toolCalls) {
      // **A call that cannot say what it wants to do does not run.** Hand
      // the message back to the model and let it try again.
      const checked = checkCall(toolsArr, call.name, call.arguments);
      if (!checked.ok) {
        stepsAcc.push(checked.step);
        yield frame("step", checked.step);
        msgs.push(toolResultMessage(call.id, checked.message));
        continue;
      }
      const toolCtx: tools.ToolCtx = {
        state,
        kb_id: kbId,
        workspace_id: workspaceId,
        mounted_sources: mountedSources as any,
        can_write: canWrite,
      };
      const [result, stepBase] = await tools.dispatch(toolCtx, sink, call.name, checked.args);
      /*
       * **Where in the body this step happened.** The model talks as it
       * calls: says a bit, checks something, says more. On the SSE wire
       * `delta` and `step` are already interleaved, so no extra offset is
       * needed there; but **history replay has no timeline** — the
       * database only keeps the assembled full text and a flat steps
       * array, so reopening a conversation stacks every call at the
       * very front and reads as if it searched seven times before saying
       * anything. Recording the offset lets replay split the text again.
       *
       * The unit is **UTF-16 code units**, because splitting happens in
       * the browser, and that is what JS's `String.prototype.length`
       * counts. Byte count or a codepoint count would cut Chinese and
       * emoji at the wrong place.
       */
      const step: Record<string, unknown> = { ...stepBase, at: utf16Length(answerAcc) };
      stepsAcc.push(step);
      yield frame("step", step);
      if (step.kind === "search" || step.kind === "docs") {
        yield frame("sources", sink.sources);
      }
      const resultMsg = toolResultMessage(call.id, result);
      exchangeAcc.push(resultMsg);
      msgs.push(resultMsg);
    }
    rounds += 1;
  }
}

function utf16Length(s: string): number {
  return s.length;
}

/** Handles a `chatToolsStream` call that threw before yielding anything (e.g. a connect failure). */
async function* handleStreamStartFailure(
  ctx: ProducerCtx,
  e: unknown,
  msgs: Record<string, unknown>[],
  answerAcc: string,
  stepsAcc: Record<string, unknown>[],
  sink: tools.ToolSink,
  exchangeAcc: Record<string, unknown>[],
): AsyncGenerator<Frame> {
  yield* legacyFallback(ctx, msgs, answerAcc, stepsAcc, sink, exchangeAcc, e);
}

/** Model may not support tool-calling: fall back to a one-shot RAG injection. */
async function* legacyFallback(
  ctx: ProducerCtx,
  _msgs: Record<string, unknown>[],
  answerAccIn: string,
  stepsAcc: Record<string, unknown>[],
  sink: tools.ToolSink,
  exchangeAcc: Record<string, unknown>[],
  _cause?: unknown,
): AsyncGenerator<Frame> {
  let answerAcc = answerAccIn;
  const chunks = await retrieval
    .hybrid(ctx.state, ctx.kbId, ctx.workspaceId, ctx.query, 8)
    .catch(() => [] as ChunkView[]);
  const legacySources = chunks.map((c, i) => sourceJsonLegacy(i + 1, c));
  yield frame("sources", legacySources);
  const lmsgs: Record<string, unknown>[] = [{ role: "system", content: legacySystemPrompt(chunks) }];
  for (const [role, content] of ctx.history.turns) {
    lmsgs.push({ role, content });
  }
  try {
    for await (const text of ctx.client.chatStreamRaw(lmsgs)) {
      answerAcc += text;
      yield deltaFrame(text);
    }
  } catch (e2) {
    yield errorFrame(e2 instanceof Error ? e2.message : String(e2));
    return;
  }
  await store.conversations.appendMessage(ctx.state.sql, ctx.conversationId, "assistant", answerAcc, {
    steps: stepsAcc,
    sources: legacySources,
    resolved: sink.resolved,
    tool_exchange: exchangeAcc,
  });
  yield doneFrame();
}

function toSSE(f: Frame): { event: string; data: string } {
  return { event: f.event, data: f.data };
}

/** Turns one "reattach" into SSE: a snapshot first, then increments as usual. */
function attachedToSSE(
  c: Context,
  attached: { snapshot: Snapshot; subscribe: (fn: (f: Frame) => void) => () => void } | null,
) {
  return streamSSE(c, async (stream) => {
    if (!attached) {
      await stream.writeSSE(toSSE(frame("idle", {})));
      return;
    }
    await stream.writeSSE(toSSE(snapshotFrame(attached.snapshot)));
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        unsubscribe();
        resolve();
      };
      const unsubscribe = attached.subscribe((f) => {
        void stream.writeSSE(toSSE(f)).catch(() => {});
        if (f.event === "done" || f.event === "error") finish();
      });
      stream.onAbort(finish);
    });
  });
}

export function registerChatRoutes(api: Hono, state: AppState): void {
  api.post("/kbs/:id/chat", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    const kb = await store.access.requireKb(state.sql, user, kbId, "viewer");
    // Write tools follow the person: only editor and above get `remember`
    // in the conversation; viewer stays read-only.
    // Mounted data sources decide whether query_data is offered (asking
    // a question is read, a viewer may use it too).
    const mountedSources = await store.datasources.mounted(state.sql, kbId);
    /*
     * Semantic layer: person-confirmed metric/dimension -> data-asset
     * mappings go straight into the system prompt — asking a question
     * prefers a confirmed definition over guessing from schema each time.
     *
     * This used to pull facts by `confidence >= 0.75`, a float encoding a
     * binary state (proposed 0.6 / confirmed 1.0). It now reads
     * `status = confirmed` (0011).
     */
    const mappings =
      mountedSources.length === 0 ? [] : await store.mappings.confirmed(state.sql, kbId, 30);
    const role = await store.access.kbRole(state.sql, user, kb);
    const canWrite = role != null && (role === "editor" || role === "admin" || role === "owner");

    const NO_MODEL = "Chat model not configured. Go to Settings → Models.";
    const settings = await store.settings.get(state.sql, kb.workspace_id);
    if (!settings) throw AppError.invalid("no_chat_model", NO_MODEL);
    const client = llmUtil.chatClient(settings);
    if (!client) throw AppError.invalid("no_chat_model", NO_MODEL);

    const req = (await c.req.json()) as ChatReq;
    const query = (req.message ?? "").trim();
    if (query === "") {
      throw AppError.validation("Missing user message");
    }

    // Conversation persistence: with an id, check ownership; without
    // one, create with the first sentence as the title. The user
    // message is saved right away; the server assembles context from
    // the database — the frontend only ever sends the new message.
    let conversationId: Uuid;
    if (req.conversation_id) {
      await store.conversations.requireOwned(state.sql, kbId, user.id, req.conversation_id);
      conversationId = req.conversation_id;
    } else {
      conversationId = await store.conversations.create(state.sql, kbId, user.id, query);
    }
    await store.conversations.appendMessage(
      state.sql,
      conversationId,
      "user",
      query,
      store.conversations.emptyTurnRecord(),
    );
    const history = await store.conversations.recentContext(state.sql, conversationId, MAX_HISTORY);

    const producerCtx: ProducerCtx = {
      state,
      kbId,
      workspaceId: kb.workspace_id,
      conversationId,
      canWrite,
      mountedSources,
      mappings,
      history,
      query,
      client,
    };

    /*
     * The generation does not run tied to this connection.
     *
     * **Switching away once loses one answer** — and more thoroughly
     * than it looks: the whole generation lives inside this producer,
     * and the assistant message is only saved once it finishes; a
     * browser navigation drops the response body, the producer would
     * be abandoned, the LLM call cancelled mid-flight, and that
     * `appendMessage` never runs.
     *
     * So the producer is driven by an independent task, and this
     * connection becomes just a subscriber.
     *
     * The cost, plainly: **it keeps spending money even when nobody is
     * watching**. That is intentional — losing an answer costs more
     * than running one extra round, and `MAX_ROUNDS` already caps it.
     * A failed emit (the receiving end is gone) does not interrupt it;
     * that is the whole point.
     */
    const handle = state.live.begin(conversationId);
    const attached = state.live.attach(conversationId);
    void (async () => {
      try {
        for await (const f of produce(producerCtx)) {
          handle.emit(f);
        }
      } finally {
        handle.finish();
      }
    })();

    return attachedToSSE(c, attached);
  });

  api.get("/kbs/:id/conversations/:conversation_id/stream", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    const conversationId = uuidParam(c, "conversation_id");
    await store.access.requireKb(state.sql, user, kbId, "viewer");
    // **Ownership is checked.** A conversation id can be guessed, and this
    // stream would read someone else's answer aloud word for word.
    await store.conversations.requireOwned(state.sql, kbId, user.id, conversationId);
    return attachedToSSE(c, state.live.attach(conversationId));
  });

  api.get("/kbs/:id/conversations", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    await store.access.requireKb(state.sql, user, kbId, "viewer");
    const [conversations, total] = await store.conversations.list(
      state.sql,
      kbId,
      user.id,
      queryStr(c, "q")?.trim() || null,
      clampLimit(queryInt(c, "limit"), 30, 100),
      clampOffset(queryInt(c, "offset")),
    );
    return c.json({ conversations, total });
  });

  api.patch("/kbs/:id/conversations/:conversation_id", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    const conversationId = uuidParam(c, "conversation_id");
    await store.access.requireKb(state.sql, user, kbId, "viewer");
    const body = (await c.req.json()) as { title: string };
    await store.conversations.rename(state.sql, kbId, user.id, conversationId, body.title);
    return c.json({ ok: true });
  });

  api.get("/kbs/:id/conversations/:conversation_id", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    const conversationId = uuidParam(c, "conversation_id");
    await store.access.requireKb(state.sql, user, kbId, "viewer");
    await store.conversations.requireOwned(state.sql, kbId, user.id, conversationId);
    const messages = await store.conversations.messages(state.sql, conversationId);
    return c.json({ messages });
  });

  api.delete("/kbs/:id/conversations/:conversation_id", async (c) => {
    const user = await auth.requireUser(c, state);
    const kbId = uuidParam(c, "id");
    const conversationId = uuidParam(c, "conversation_id");
    await store.access.requireKb(state.sql, user, kbId, "viewer");
    await store.conversations.del(state.sql, kbId, user.id, conversationId);
    return c.json({ ok: true });
  });
}

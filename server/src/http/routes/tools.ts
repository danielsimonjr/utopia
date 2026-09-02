/**
 * Execution of the seven tools, independent of who is calling them.
 *
 * These used to be seven branches of one `match` in `chat.ts`, each
 * 20-70 lines, closing over the streaming loop's local variables. That
 * was fine while chat was the only caller. **MCP is the second caller.**
 * Pulling this out means both sides share one implementation: chat's
 * `entity_facts` and MCP's `entity_facts` are the same code.
 *
 * The tool definitions (the JSON schema shown to the model) stay in
 * `chat.ts`: that is part of the prompt, and follows the conversation
 * strategy. This file only decides what to do once the arguments have
 * arrived.
 */

import type { ChunkView } from "../../core/models";
import type { DataSourceView } from "../../store/datasources";
import type { Uuid } from "../../core/ids";
import type { AppState } from "../../state";
import type { DocsSection } from "../../search";
import * as store from "../../store";
import * as retrieval from "../../retrieval";
import * as queryEngine from "../../query_engine";

const SEARCH_TOP_K = 6;
const TOOL_CHUNK_CHARS = 800;

/**
 * The most rows one `changes` call returns. A freshly ingested corpus is
 * almost all "asserted"; sending every one of them just fills the context
 * window without adding information. What carries information is
 * corrected/rejected, and those are rare by nature. When truncated, the
 * detail says "40+" so the model knows to narrow the window.
 */
const CHANGES_LIMIT = 40;

/** The world one tool call can see. **Read-only** — a tool cannot change it. */
export type ToolCtx = {
  state: AppState;
  kb_id: Uuid;
  workspace_id: Uuid;
  /**
   * Data sources mounted on this KB. **This list is `query_data`'s
   * security boundary**: credentials never leave the server, and the
   * model can only order by name.
   */
  mounted_sources: readonly DataSourceView[];
  /** editor and above only, for `remember` */
  can_write: boolean;
};

/**
 * What a tool run collects on the way out.
 *
 * **Citation numbers are stateful**: the `3` in `[3]` depends on how many
 * were already cited earlier in this round, so tools cannot each count
 * their own and merge afterward — that would give the same chunk two
 * different numbers.
 */
export class ToolSink {
  /** Dedup key (chunk uuid, or `charter:{slug}#{anchor}`); index + 1 is the citation number. */
  readonly sourceIds: string[] = [];
  /** The citation list sent to the frontend, in the same order as `sourceIds`. */
  readonly sources: unknown[] = [];
  /** Entities recognized this round, stored on the conversation for next round's replay. */
  readonly resolved: unknown[] = [];
}

/** One tool call's result: text for the model + one step for the UI. */
export type ToolResult = [string, Record<string, unknown>];

/**
 * Dispatches by name. **An unknown tool is not an error** — the model
 * occasionally makes one up; telling it there is no such tool lets it
 * pick another one next round instead of breaking the whole conversation.
 */
export async function dispatch(
  ctx: ToolCtx,
  sink: ToolSink,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  switch (name) {
    case "search_chunks":
      return searchChunks(ctx, sink, args);
    case "search_docs":
      return searchDocs(ctx, sink, args);
    case "find_entities":
      return findEntities(ctx, sink, args);
    case "entity_facts":
      return entityFacts(ctx, args);
    case "changes":
      return changes(ctx, args);
    case "query_data":
      if (ctx.mounted_sources.length > 0) return queryData(ctx, args);
      break;
    case "remember":
      if (ctx.can_write) return remember(ctx, args);
      break;
  }
  return [
    `Unknown tool: ${name}`,
    { kind: "tool", label: name, detail: "unknown" },
  ];
}

/**
 * Returns the number already cited, or files a new one. **The same chunk
 * gets exactly one number in one round** — otherwise the model cites
 * `[2]` while the UI shows two different `[2]`s.
 */
function cite(sink: ToolSink, key: string, make: (n: number) => unknown): number {
  const existing = sink.sourceIds.indexOf(key);
  if (existing !== -1) return existing + 1;
  sink.sourceIds.push(key);
  sink.sources.push(make(sink.sourceIds.length));
  return sink.sourceIds.length;
}

export async function searchChunks(
  ctx: ToolCtx,
  sink: ToolSink,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  // The required argument is already blocked by `chat.checkCall` before
  // dispatch, so this no longer falls back to the user's own words — a
  // fallback produces a wrong answer that looks fine.
  const q = typeof args.query === "string" ? args.query : "";
  const chunks = await retrieval
    .hybrid(ctx.state, ctx.kb_id, ctx.workspace_id, q, SEARCH_TOP_K)
    .catch(() => [] as ChunkView[]);
  const lines: string[] = [];
  for (const c of chunks) {
    const n = cite(sink, c.id, (n) => sourceJson(n, c));
    lines.push(`[${n}] "${c.filename}" section ${c.seq + 1}:\n${truncate(c.text, TOOL_CHUNK_CHARS)}`);
  }
  const text = lines.length === 0 ? "No results." : lines.join("\n\n");
  return [text, { kind: "search", label: q, detail: `${chunks.length} sources` }];
}

export async function searchDocs(
  ctx: ToolCtx,
  sink: ToolSink,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  // Same rule as searchChunks: the required argument is checked before
  // dispatch, so no fallback to the user's own words here either.
  const q = typeof args.query === "string" ? args.query : "";
  const hits = ctx.state.docs.search(q, 4);
  const lines: string[] = [];
  for (const h of hits) {
    const key = `charter:${h.slug}#${h.anchor}`;
    const n = cite(sink, key, (n) => charterSourceJson(n, h));
    lines.push(`[${n}] Utopia Charter — ${h.title} › ${h.heading}:\n${truncate(h.body, 1600)}`);
  }
  const text = lines.length === 0 ? "No matching manual sections." : lines.join("\n\n");
  return [text, { kind: "docs", label: q, detail: `${hits.length} sections` }];
}

export async function findEntities(
  ctx: ToolCtx,
  sink: ToolSink,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const name = typeof args.name === "string" ? args.name : "";
  const [hits] = await store.graph
    .search_entities(ctx.state.sql, ctx.kb_id, name, 8, 0)
    .catch(() => [[], 0] as const);
  const text =
    hits.length === 0
      ? "No matching entities."
      : hits
          .map((n) => {
            const dis = n.disambiguator ? ` (${n.disambiguator})` : "";
            // An entity with no resolved type can still be found and cited (0009).
            return `${n.id} | ${n.name}${dis} | ${n.type_label ?? "untyped"} | ${n.degree} facts`;
          })
          .join("\n");
  for (const n of hits) {
    sink.resolved.push({ id: n.id, name: n.name, type: n.type_label });
  }
  return [text, { kind: "entity", label: name, detail: `${hits.length} matches` }];
}

export async function entityFacts(
  ctx: ToolCtx,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const rawId = typeof args.entity_id === "string" ? args.entity_id : null;
  const id = rawId && UUID_RE.test(rawId) ? rawId : null;
  // as-of filtering: valid at T = start not after T (or unknown) and end after T (or open)
  const at = parseDay(args.at);
  if (!id) {
    return [
      "Invalid entity_id (expected the uuid returned by find_entities).",
      { kind: "facts", label: "?", detail: "invalid id" },
    ];
  }
  try {
    const [node, allFacts] = await store.graph.entity_detail(ctx.state.sql, ctx.kb_id, id);
    let facts = allFacts;
    if (at) {
      facts = facts.filter(
        (f) => (f.valid_from === null || f.valid_from <= at) && (f.valid_to === null || f.valid_to > at),
      );
    }
    const text =
      facts.length === 0
        ? at
          ? `${node.name}: no facts valid as of ${fmtDate(at)}.`
          : `${node.name}: no recorded facts.`
        : facts.map(factLine).join("\n");
    const detail = at ? `${facts.length} facts as of ${fmtDate(at)}` : `${facts.length} facts`;
    return [text, { kind: "facts", label: node.name, detail }];
  } catch {
    return ["Entity not found.", { kind: "facts", label: "?", detail: "not found" }];
  }
}

export async function changes(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  const since = parseDay(args.since);
  const until = parseDay(args.until);
  const win = changesWindow(since, until, new Date());
  if (!win) {
    return [
      "Invalid or missing `since` (expected YYYY-MM-DD).",
      { kind: "changes", label: "?", detail: "invalid since" },
    ];
  }
  const rawEntity = typeof args.entity_id === "string" ? args.entity_id : null;
  const entity = rawEntity && UUID_RE.test(rawEntity) ? rawEntity : null;
  const kindsRaw = Array.isArray(args.kinds)
    ? args.kinds.filter((k): k is string => typeof k === "string")
    : null;
  const kinds = kindsRaw && kindsRaw.length > 0 ? kindsRaw : null;
  const rows = await store.graph
    .graph_changes(ctx.state.sql, ctx.kb_id, win.start, win.end, entity, kinds, CHANGES_LIMIT)
    .catch(() => []);
  const text = rows.length === 0 ? `No recorded changes in ${win.label}.` : rows.map(changeLine).join("\n");
  const detail = rows.length === CHANGES_LIMIT ? `${CHANGES_LIMIT}+ changes` : `${rows.length} changes`;
  return [text, { kind: "changes", label: win.label, detail }];
}

export async function queryData(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  const dsName = typeof args.data_source === "string" ? args.data_source.trim() : "";
  const sql = typeof args.sql === "string" ? args.sql.trim() : "";
  const purpose = typeof args.purpose === "string" ? args.purpose.trim() : "";
  // Security boundary: only sources mounted on this KB are allowed
  // (credentials never leave the server).
  const found = ctx.mounted_sources.find((d) => d.name.toLowerCase() === dsName.toLowerCase());
  let text: string;
  if (!found) {
    text = `Unknown data source '${dsName}'. Mounted sources: ${ctx.mounted_sources
      .map((d) => d.name)
      .join(", ")}`;
  } else {
    try {
      text = await runQuery(ctx.state, found.id, sql);
    } catch (e) {
      // The error passes through: the model can fix the SQL and retry.
      text = `Query failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  const detail = purpose === "" ? sql.slice(0, 60) : purpose;
  return [text, { kind: "query", label: dsName, detail }];
}

export async function remember(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  const text = typeof args.text === "string" ? args.text.trim() : "";
  const occurredAt = parseDay(args.occurred_at) ?? new Date();
  if (text === "") {
    return ["remember requires non-empty text.", { kind: "tool", label: "remember", detail: "empty" }];
  }
  try {
    const [docId] = await store.memory.appendEpisode(ctx.state.sql, ctx.kb_id, text, occurredAt);
    // Ingestion (embedding/indexing/incremental extraction) runs async on
    // the queue and does not block the conversation.
    await store.jobs.enqueue(ctx.state.sql, "memory_ingest", { document_id: docId });
    ctx.state.emitDocument(ctx.kb_id, docId);
    return [
      `Recorded (effective ${fmtDate(occurredAt)}): ${text}`,
      { kind: "tool", label: "remember", detail: text.slice(0, 60) },
    ];
  } catch (e) {
    return [
      `Failed to record: ${e instanceof Error ? e.message : String(e)}`,
      { kind: "tool", label: "remember", detail: "failed" },
    ];
  }
}

// ---------------------------------------------------------------------------
// Formatting and execution helpers. **The chat fallback path uses these
// too**, so they are exported rather than private.
// ---------------------------------------------------------------------------

export function sourceJson(n: number, c: ChunkView): Record<string, unknown> {
  return {
    n,
    chunk_id: c.id,
    document_id: c.document_id,
    filename: c.filename,
    excerpt: truncate(c.text, 160),
  };
}

/** A Charter citation: the frontend renders it as a manual line, linking to /docs/{slug}#{anchor}. */
export function charterSourceJson(n: number, h: DocsSection): Record<string, unknown> {
  return {
    n,
    kind: "charter",
    slug: h.slug,
    anchor: h.anchor,
    heading: h.heading,
    filename: h.title,
    excerpt: truncate(h.body, 160),
  };
}

/** query_data execution: safety gate (parse allowlist) -> engine execution (read-only session + forced LIMIT + timeout) -> JSON lines. */
async function runQuery(state: AppState, dsId: Uuid, sql: string): Promise<string> {
  const guarded = queryEngine.guardSql(sql);
  const [engine, conn] = await store.datasources.engineAndConn(state.sql, dsId);
  const result = await queryEngine.engineFor(engine, conn).execute(guarded);
  if (result.rows.length === 0) return "(no rows)";
  let out = result.rows.join("\n");
  out += `\n(${result.rows.length} rows`;
  if (result.truncated) {
    out += `, truncated at ${queryEngine.ROW_CAP} — aggregate in SQL for totals`;
  }
  out += ")";
  return out;
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function parseDay(raw: unknown): Date | null {
  if (typeof raw !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function fmtDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** One evidence-carrying fact line: "works at → Nebula Corp (2023-08 → now) [90%]", in-direction uses ←. */
function factLine(f: store.graph.EntityFact): string {
  const other = f.other_name ?? "?";
  // Same convention as `other`: use "?" when neither the ontology nor the
  // surface wording settled on a predicate. Never invent "related to" —
  // that is exactly what removing `related_to` was meant to stop.
  const pred = f.predicate_label ?? "?";
  const core = f.direction === "out" ? `${pred} → ${other}` : `${pred} ← ${other}`;
  let range = "";
  if (f.valid_from && f.valid_to) {
    range = ` (${fmtDate(f.valid_from)} → ${fmtDate(f.valid_to)})`;
  } else if (f.valid_from) {
    range = ` (${fmtDate(f.valid_from)} → now)`;
  } else if (f.valid_to) {
    range = ` (→ ${fmtDate(f.valid_to)})`;
  }
  return `${core}${range} [${Math.round(f.confidence * 100)}%]`;
}

/**
 * `changes`'s time window: turns two optional dates into (a half-open SQL
 * range, a display window string).
 *
 * **Pulled out as a pure function because this broke once.** `until` needs
 * a day added before it reaches SQL (someone who says "through March 31"
 * means to include the 31st, and the SQL side is `< $3`), and the first
 * version printed the already-incremented value into the display string
 * too — the model then answered "as of August 30" when the question was
 * the 29th. The two values must be computed together and tested together;
 * splitting them into two places invites them to drift apart again.
 *
 * `now` is passed in rather than read inside, purely so this function can
 * be tested.
 */
export function changesWindow(
  since: Date | null,
  until: Date | null,
  now: Date,
): { start: Date; end: Date; label: string } | null {
  if (!since) return null;
  const start = since;
  const end = until ? new Date(until.getTime() + 24 * 60 * 60 * 1000) : now;
  // The display string uses **the day that was asked for**, never `now`
  // when nothing was asked.
  const label = `${fmtDate(since)} → ${until ? fmtDate(until) : "now"}`;
  return { start, end, label };
}

/** One line on the cognitive axis.
 *
 * Formatting keeps the two axes **visibly separate**: `at` prefixes the
 * event kind, and the world-axis range trails the assertion inside
 * brackets. Printed as one run of dates, the model reads "recorded in
 * 2026" as "happened in 2026" — exactly the misreading this tool exists
 * to prevent.
 */
export function changeLine(c: store.graph.GraphChange): string {
  const object =
    c.object_name ?? (c.object_value !== null && c.object_value !== undefined ? literalText(c.object_value) : "?");
  let range = "";
  if (c.valid_from && c.valid_to) {
    range = ` [valid ${fmtDate(c.valid_from)} → ${fmtDate(c.valid_to)}]`;
  } else if (c.valid_from) {
    range = ` [valid ${fmtDate(c.valid_from)} → now]`;
  } else if (c.valid_to) {
    range = ` [valid → ${fmtDate(c.valid_to)}]`;
  }
  // No filename tag on this one: the citation number belongs to a chunk,
  // and this only has a document — sending one out would land on the UI
  // pointing at nothing.
  const src =
    c.filename && c.quote
      ? ` — from "${c.filename}": "${truncate(c.quote, 160)}"`
      : c.filename
        ? ` — from "${c.filename}"`
        : "";
  return `${fmtDate(c.at)} ${c.kind}: ${c.subject_name} ${c.predicate_label ?? "?"} ${object}${range}${src}`;
}

function literalText(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

export function truncate(text: string, maxChars: number): string {
  const t = text.trim();
  const chars = [...t];
  if (chars.length <= maxChars) return t;
  return `${chars.slice(0, maxChars).join("")}…`;
}

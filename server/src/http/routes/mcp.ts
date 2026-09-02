/**
 * MCP server (Streamable HTTP).
 *
 * One route: `POST /api/v1/kbs/:id/mcp`, taking JSON-RPC 2.0.
 *
 * **Transport is Streamable HTTP, not stdio** (see `docs/decisions/0014`):
 * Utopia is already a server; stdio would need either a child process
 * connecting back to it, or a second connection pool. This is a
 * multi-person deployment — five people each connecting should be served
 * by the one deployment, not five subprocesses.
 *
 * **Every POST re-authenticates.** The spec allows reusing one handshake's
 * result for the whole connection, but decision 0014 is explicit:
 *
 * > Check scope at every tool entry, not at the handshake. A `revoked_at`
 * > written mid-session must take effect immediately.
 *
 * Being stateless gets that property for free — there is no "connection"
 * left to trust.
 *
 * **Responses are `application/json`, not SSE.** The spec allows both;
 * these tools are one question, one answer, with nothing the server
 * pushes on its own. SSE is for notifications, and this version does not
 * need one.
 */

import type { Hono, Context } from "hono";
import type { AppState } from "../../state";
import * as store from "../../store";
import { AppError } from "../../core/errors";
import { uuidParam } from "../context";
import * as tools from "./tools";
import { baseTools } from "./chat";
import type { Uuid } from "../../core/ids";

/** The implemented protocol version. A client asking for a different one still gets this — the spec requires the server to answer with the version it supports, and lets the client decide whether to accept it. */
const PROTOCOL_VERSION = "2025-06-18";

/**
 * Tools exposed in this release. **Only the four read-only ones** (0014):
 *
 * `query_data` runs SQL against production, `remember` writes to the
 * ledger, and each still has an open question — what evidence an
 * external agent's written fact carries, how a run SQL query gets
 * audited. Get the identity story right first.
 */
const EXPOSED = new Set(["search_chunks", "search_docs", "find_entities", "changes", "entity_facts"]);

function isExposed(name: string): boolean {
  return EXPOSED.has(name);
}

type AuthContext = {
  user: import("../../core/models").User;
  auth: import("../../store/tokens").Authenticated;
};

/**
 * Authentication + authorization. **Two steps, not one.**
 *
 * The token says "who this is, and which KBs this key reaches";
 * `requireKb` says "what role this person has on this KB". The former
 * only narrows; the latter is the actual permission — a token with every
 * scope open, held by a viewer, is still only a viewer.
 */
async function authorize(state: AppState, headers: Headers, kbId: Uuid): Promise<AuthContext> {
  const raw = headers.get("authorization");
  const token = raw?.startsWith("Bearer ") ? raw.slice("Bearer ".length).trim() : null;
  if (!token) throw AppError.unauthorized();
  const auth = await store.tokens.authenticate(state.sql, token);
  // The token's scope: limited to certain KBs cannot reach further.
  if (!auth.covers(kbId)) {
    throw AppError.forbidden();
  }
  // The person: deactivation takes effect immediately (findUserById blocks it).
  const user = await store.accounts.findUserById(state.sql, auth.userId);
  if (!user) throw AppError.unauthorized();
  // The role: the same guard the web app uses, unchanged by one line.
  await store.access.requireKb(state.sql, user, kbId, "viewer");
  return { user, auth };
}

/**
 * OpenAI shape -> MCP shape.
 *
 * **Shares `chat.ts`'s definitions** rather than writing a second set
 * here. Name and parameter schema are the contract with `tools.ts`'s
 * execution side; copying it twice would eventually drift — exactly what
 * pulling the tools out was meant to prevent.
 *
 * Known wart: the descriptions were written for the in-app assistant —
 * `search_chunks`'s still says citations can read as [n], and an MCP
 * client has no citation numbers to work with. Sharing one copy is worth
 * more than that one sentence; split them if that ever changes.
 */
function toMcpTools(openai: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const t of openai) {
    const fn = (t as Record<string, unknown> | undefined)?.function as
      | Record<string, unknown>
      | undefined;
    const name = fn?.name;
    if (typeof name !== "string" || !isExposed(name)) continue;
    out.push({
      name,
      description: typeof fn?.description === "string" ? fn.description : "",
      inputSchema: fn?.parameters ?? { type: "object", properties: {} },
    });
  }
  return out;
}

function ok(id: unknown, result: unknown): { jsonrpc: "2.0"; id: unknown; result: unknown } {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

/** A JSON-RPC error is not an HTTP error: **the transport succeeded, the method failed.** Answer 200 with an error body, or the client cannot parse it. */
function rpcErr(
  id: unknown,
  code: number,
  message: string,
): { jsonrpc: "2.0"; id: unknown; error: { code: number; message: string } } {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

export function registerMcpRoutes(api: Hono, state: AppState): void {
  api.post("/kbs/:id/mcp", async (c: Context) => {
    const kbId = uuidParam(c, "id");
    const { user, auth } = await authorize(state, c.req.raw.headers, kbId);
    const req = (await c.req.json()) as Record<string, unknown>;
    const id = req.id;
    const method = typeof req.method === "string" ? req.method : "";
    const params = (req.params ?? {}) as Record<string, unknown>;

    switch (method) {
      case "initialize":
        return c.json(
          ok(id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "utopia", version: process.env.npm_package_version ?? "0.0.0" },
          }),
        );
      // Notifications have no id and, per spec, should get no response
      // body; but HTTP still needs to answer something, and 202 would be
      // more accurate — this returns an empty result to keep the handler
      // signature uniform.
      case "notifications/initialized":
      case "notifications/cancelled":
        return c.json(ok(null, {}));
      case "ping":
        return c.json(ok(id, {}));
      case "tools/list":
        return c.json(ok(id, { tools: toMcpTools(baseTools()) }));
      case "tools/call": {
        const name = typeof params.name === "string" ? params.name : "";
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        if (!isExposed(name)) {
          // An unexposed tool (query_data / remember) must say "not in
          // this release", not "no such tool" — the former does not make
          // a client retry forever.
          return c.json(
            rpcErr(id, -32601, `Tool '${name}' is not exposed over MCP in this version`),
          );
        }
        const kb = await store.kbs.get(state.sql, kbId);
        // This release only offers read-only tools, so mounted_sources is
        // empty and can_write is false: **even a write-scoped token does
        // not open this up** — scope is a ceiling, not a grant, and this
        // release's ceiling is set by EXPOSED.
        const toolCtx: tools.ToolCtx = {
          state,
          kb_id: kbId,
          workspace_id: kb.workspace_id,
          mounted_sources: [],
          can_write: false,
        };
        const sink = new tools.ToolSink();
        const [text] = await tools.dispatch(toolCtx, sink, name, args);
        await store.audit.record(
          state.sql,
          kbId,
          user.id,
          "mcp.tool_called",
          "personal_token",
          auth.tokenId,
          { tool: name },
        );
        return c.json(
          ok(id, { content: [{ type: "text", text }], isError: false }),
        );
      }
      default:
        return c.json(rpcErr(id, -32601, `Unknown method: ${method}`));
    }
  });
}

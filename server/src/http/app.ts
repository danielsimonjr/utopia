/**
 * The Hono application: mounts every `/api/v1` route, wraps requests with
 * an audit client-context, serves the built frontend (SPA fallback) when
 * present, and converts thrown errors into the shared JSON error shape.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AppState } from "../state";
import * as store from "../store";
import * as auth from "../auth";
import { errorResponse } from "./errors";
import { registerHealthRoutes } from "./routes/health";
import { registerAuthRoutes } from "./routes/auth";
import { registerWorkspaceRoutes } from "./routes/workspaces";
import { registerKbRoutes } from "./routes/kbs";
import { registerMemberRoutes } from "./routes/members";
import { registerSettingsRoutes } from "./routes/settings";
import { registerAdminRoutes } from "./routes/admin";
import { registerTokenRoutes } from "./routes/tokens";
import { registerAlertRoutes } from "./routes/alerts";
import { registerEventRoutes } from "./routes/events";
import { registerSearchRoutes } from "./routes/search";
import { registerDocumentRoutes } from "./routes/documents";
import { registerMappingRoutes } from "./routes/mappings";
import { registerDataSourceRoutes } from "./routes/datasources";
import { registerOntologyRoutes } from "./routes/ontology";
import { registerSourceRoutes } from "./routes/sources";
import { registerGraphRoutes } from "./routes/graph";
import { registerReviewRoutes } from "./routes/review";

/**
 * Routes declared in the Rust API surface (`api/mod.rs`) that this build
 * does not implement yet: chat, MCP, and the agentic tool surface. Each
 * one still responds on its exact method + path, with a clear 501, so
 * the frontend gets a legible error instead of a generic 404.
 */
const UNIMPLEMENTED_ROUTES: readonly [string, string][] = [
  ["POST", "/kbs/:id/mcp"],
  ["POST", "/kbs/:id/chat"],
  ["GET", "/kbs/:id/conversations/:conversation_id/stream"],
  ["GET", "/kbs/:id/conversations"],
  ["GET", "/kbs/:id/conversations/:conversation_id"],
  ["PATCH", "/kbs/:id/conversations/:conversation_id"],
  ["DELETE", "/kbs/:id/conversations/:conversation_id"],
];

function registerUnimplementedRoutes(api: Hono): void {
  for (const [method, path] of UNIMPLEMENTED_ROUTES) {
    const handler = (c: import("hono").Context) =>
      c.json(
        {
          error: "Not implemented",
          code: "not_implemented",
          detail: `${method} ${path} is not implemented in the Bun/Hono server yet.`,
        },
        501,
      );
    switch (method) {
      case "GET":
        api.get(path, handler);
        break;
      case "POST":
        api.post(path, handler);
        break;
      case "PUT":
        api.put(path, handler);
        break;
      case "PATCH":
        api.patch(path, handler);
        break;
      case "DELETE":
        api.delete(path, handler);
        break;
    }
  }
}

export type CreateAppOptions = {
  /** Directory containing the built frontend (`index.html` + assets). Skipped when it does not exist — the API still works standalone (e.g. behind Vite dev server). */
  webDist: string;
  /** Origin allowed for the Vite dev server (cross-port cookies during development). */
  devOrigin?: string;
};

export function createApp(state: AppState, opts: CreateAppOptions): Hono {
  const api = new Hono();

  registerHealthRoutes(api);
  registerAuthRoutes(api, state);
  registerWorkspaceRoutes(api, state);
  registerKbRoutes(api, state);
  registerMemberRoutes(api, state);
  registerSettingsRoutes(api, state);
  registerAdminRoutes(api, state);
  registerTokenRoutes(api, state);
  registerAlertRoutes(api, state);
  registerEventRoutes(api, state);
  registerSearchRoutes(api, state);
  registerDocumentRoutes(api, state);
  registerMappingRoutes(api, state);
  registerDataSourceRoutes(api, state);
  registerOntologyRoutes(api, state);
  registerSourceRoutes(api, state);
  registerGraphRoutes(api, state);
  registerReviewRoutes(api, state);

  // P0 queue-validation endpoint: queues a noop job.
  api.post("/jobs/noop", async (c) => {
    await auth.requireUser(c, state);
    const id = await store.jobs.enqueue(state.sql, "noop", {});
    return c.json({ job_id: id });
  });

  registerUnimplementedRoutes(api);

  const app = new Hono();

  // Dev CORS: the Vite dev server carries cookies across ports.
  app.use(
    "/api/*",
    cors({
      origin: opts.devOrigin ?? "http://localhost:5173",
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "PUT"],
      allowHeaders: ["Content-Type", "Authorization"],
      credentials: true,
    }),
  );

  // Every audit write downstream reads the request's origin info from this
  // context; background jobs run outside any request and see none.
  app.use("*", async (c, next) => {
    const server = c.env as unknown as
      | { requestIP?: (req: Request) => { address: string } | null }
      | undefined;
    const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    const ip = forwarded ?? server?.requestIP?.(c.req.raw)?.address ?? null;
    const userAgent = c.req.header("user-agent") ?? null;
    await store.audit.withClientContext({ ip, userAgent }, () => next());
  });

  app.route("/api/v1", api);

  // SPA hosting: mount when the build exists, history-fallback to index.html.
  const indexHtml = join(opts.webDist, "index.html");
  if (existsSync(indexHtml)) {
    app.use("*", serveStatic({ root: opts.webDist }));
    // Hand-rolled instead of another `serveStatic({ path: indexHtml })`:
    // that middleware's path-join defaults to a `./`-relative root even
    // for an absolute `path` option, which silently resolves against the
    // process's cwd instead of `indexHtml` and 404s on every SPA route.
    //
    // Never swallows `/api/*` into the SPA shell: axum's nested router
    // keeps its own 404 for an unmatched `/api/v1/...` path, it does not
    // fall through to the outer fallback service, so an unknown API route
    // stays a plain 404 here too.
    app.get("*", async (c) => {
      if (c.req.path.startsWith("/api/")) return c.notFound();
      const file = Bun.file(indexHtml);
      if (!(await file.exists())) return c.notFound();
      return new Response(file, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    });
  }

  app.onError((err, c) => errorResponse(err, c));

  return app;
}

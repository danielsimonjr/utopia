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

/**
 * Routes declared in the Rust API surface (`api/mod.rs`) that this build
 * does not implement yet: chat, the entity graph, ontology editing,
 * review queues, data sources, and ingest sources. Each one still
 * responds on its exact method + path, with a clear 501, so the frontend
 * gets a legible error instead of a generic 404.
 */
const UNIMPLEMENTED_ROUTES: readonly [string, string][] = [
  ["GET", "/admin/data-sources"],
  ["POST", "/admin/data-sources"],
  ["DELETE", "/admin/data-sources/:id"],
  ["POST", "/admin/data-sources/:id/test"],
  ["GET", "/admin/data-sources/:id/grants"],
  ["PUT", "/admin/data-sources/:id/grants/:workspace_id"],
  ["DELETE", "/admin/data-sources/:id/grants/:workspace_id"],
  ["POST", "/kbs/:id/mcp"],
  ["GET", "/kbs/:id/data-sources"],
  ["GET", "/kbs/:id/data-sources/available"],
  ["PUT", "/kbs/:id/data-sources/:ds_id"],
  ["DELETE", "/kbs/:id/data-sources/:ds_id"],
  ["POST", "/kbs/:id/data-sources/:ds_id/sync-schema"],
  ["POST", "/kbs/:id/data-sources/explore"],
  ["GET", "/kbs/:id/ontology"],
  ["POST", "/kbs/:id/ontology/type-resolution/preview"],
  ["POST", "/kbs/:id/ontology/type-resolution"],
  ["POST", "/kbs/:id/ontology/type-resolution/approve"],
  ["DELETE", "/kbs/:id/ontology/type-resolution/:batch_id"],
  ["POST", "/kbs/:id/ontology/entity-types"],
  ["PATCH", "/kbs/:id/ontology/entity-types/:type_id"],
  ["DELETE", "/kbs/:id/ontology/entity-types/:type_id"],
  ["GET", "/kbs/:id/ontology/entity-types/:type_id/entities"],
  ["POST", "/kbs/:id/ontology/relation-types"],
  ["PATCH", "/kbs/:id/ontology/relation-types/:type_id"],
  ["DELETE", "/kbs/:id/ontology/relation-types/:type_id"],
  ["POST", "/kbs/:id/ontology/misses/dismiss"],
  ["POST", "/kbs/:id/ontology/misses/restore"],
  ["POST", "/kbs/:id/ontology/suggest"],
  ["GET", "/kbs/:id/ontology/proposals"],
  ["POST", "/kbs/:id/ontology/proposals"],
  ["GET", "/kbs/:id/ontology/imports"],
  ["POST", "/kbs/:id/ontology/imports"],
  ["POST", "/kbs/:id/ontology/imports/preview"],
  ["GET", "/kbs/:id/ontology/proposed-predicates"],
  ["GET", "/kbs/:id/ontology/auto-extension"],
  ["POST", "/kbs/:id/ontology/adopt-predicate"],
  ["DELETE", "/kbs/:id/ontology/adopt-predicate/:batch_id"],
  ["POST", "/kbs/:id/chat"],
  ["GET", "/kbs/:id/conversations/:conversation_id/stream"],
  ["GET", "/kbs/:id/conversations"],
  ["GET", "/kbs/:id/conversations/:conversation_id"],
  ["PATCH", "/kbs/:id/conversations/:conversation_id"],
  ["DELETE", "/kbs/:id/conversations/:conversation_id"],
  ["POST", "/documents/:id/extract"],
  ["GET", "/kbs/:id/graph/overview"],
  ["GET", "/kbs/:id/graph/neighborhood"],
  ["GET", "/kbs/:id/entities"],
  ["GET", "/kbs/:id/entities/:entity_id"],
  ["PATCH", "/kbs/:id/entities/:entity_id"],
  ["GET", "/kbs/:id/entities/:entity_id/history"],
  ["GET", "/kbs/:id/facts/:fact_id/evidence"],
  ["GET", "/kbs/:id/sources"],
  ["POST", "/kbs/:id/sources"],
  ["PATCH", "/kbs/:id/sources/:source_id"],
  ["DELETE", "/kbs/:id/sources/:source_id"],
  ["POST", "/kbs/:id/sources/:source_id/sync"],
  ["GET", "/kbs/:id/sources/:source_id/runs"],
  ["POST", "/kbs/:id/sources/:source_id/re-extract"],
  ["POST", "/kbs/:id/graph/rebuild"],
  ["POST", "/kbs/:id/sources/:source_id/missing/cleanup"],
  ["POST", "/kbs/:id/ingest"],
  ["POST", "/sources/:source_id/ingest"],
  ["GET", "/kbs/:id/sources/:source_id/token"],
  ["POST", "/kbs/:id/sources/:source_id/rotate-token"],
  ["GET", "/kbs/:id/review"],
  ["GET", "/kbs/:id/review/history"],
  ["POST", "/kbs/:id/review/:review_id"],
  ["POST", "/kbs/:id/review/mappings/:mapping_id"],
  ["POST", "/kbs/:id/consistency/check"],
  ["POST", "/kbs/:id/review/violations/:violation_id"],
  ["POST", "/kbs/:id/review/defects/:defect_id"],
  ["POST", "/kbs/:id/inference/run"],
  ["POST", "/kbs/:id/facts/:fact_id/confirm"],
  ["POST", "/kbs/:id/facts/:fact_id/reject"],
  ["POST", "/kbs/:id/facts/:fact_id/close"],
  ["POST", "/kbs/:id/merges/:merge_id/revert"],
  ["POST", "/kbs/:id/conflicts/:conflict_id"],
  ["POST", "/kbs/:id/entities/merge"],
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

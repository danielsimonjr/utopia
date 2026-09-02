import type { Hono } from "hono";

export function registerHealthRoutes(api: Hono): void {
  api.get("/health", (c) =>
    c.json({ status: "ok", name: "utopia", version: "0.1.0" }),
  );
}

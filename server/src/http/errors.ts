/**
 * Maps a thrown error to a JSON response, the same shape the Rust build
 * sends: `{ error, code?, detail? }`.
 */

import type { Context } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import { isAppError } from "../core/errors";
import { log } from "../core/log";

export function errorResponse(err: unknown, c: Context): Response {
  if (isAppError(err)) {
    if (err.kind === "Db" || err.kind === "Other") {
      log.error("internal error", { error: err.message });
    }
    return c.json(err.toJson(), err.httpStatus as StatusCode);
  }
  log.error("unhandled error", { error: err instanceof Error ? err.stack ?? err.message : String(err) });
  return c.json({ error: "Internal server error" }, 500);
}

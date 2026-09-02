/**
 * Small shared helpers for route handlers: path/query parsing that fails
 * the same way for every route, instead of each file inventing its own.
 */

import type { Context } from "hono";
import { AppError } from "../core/errors";
import type { Uuid } from "../core/ids";

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** A path param that must be a UUID. A malformed one is a client mistake (422), not a 404 or a database error. */
export function uuidParam(c: Context, name: string): Uuid {
  const raw = c.req.param(name);
  if (!raw || !UUID_RE.test(raw)) {
    throw AppError.validation(`'${name}' must be a UUID`);
  }
  return raw;
}

export function queryInt(c: Context, name: string): number | undefined {
  const raw = c.req.query(name);
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export function queryStr(c: Context, name: string): string | undefined {
  const raw = c.req.query(name);
  return raw === undefined || raw === "" ? undefined : raw;
}

/** Clamps a page size the way every list endpoint does: at least 1, at most `max`. */
export function clampLimit(value: number | undefined, fallback: number, max: number): number {
  const n = value ?? fallback;
  return Math.min(Math.max(Math.trunc(n), 1), max);
}

export function clampOffset(value: number | undefined): number {
  return Math.max(Math.trunc(value ?? 0), 0);
}

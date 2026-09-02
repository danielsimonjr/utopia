/**
 * Audit log: who did what to what, and when. Pure audit trail — it only
 * records and displays; it does not carry derived features like undo.
 * A failed write never blocks the underlying operation (callers always
 * swallow the error).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { q, qOne, qOpt, exec, type Sql } from "../core/db";
import { newId, type Uuid } from "../core/ids";

/** Audit event view (with the actor's display name; null after account deletion). Display only. */
export type AuditEventView = {
  id: Uuid;
  action: string;
  target_kind: string;
  target_id: Uuid | null;
  detail: unknown;
  actor_name: string | null;
  created_at: Date;
};

/**
 * The request's origin info. The HTTP layer scopes this in for every
 * request; `recordOpt` reads it. Otherwise every one of the ~25 call
 * sites would need to carry two extra parameters that have nothing to
 * do with its own business logic.
 *
 * Background jobs (batched adjudication, scheduled sync) run outside any
 * request, so they see an empty context — as they should: those actions
 * really do have no client.
 */
export type ClientContext = {
  ip: string | null;
  userAgent: string | null;
};

const CLIENT = new AsyncLocalStorage<ClientContext>();

/** Runs `fn` with a client context available to `recordOpt` calls made inside it. */
export async function withClientContext<T>(ctx: ClientContext, fn: () => Promise<T>): Promise<T> {
  return CLIENT.run(ctx, fn);
}

/** Reads the current request's origin; empty outside a request context (background jobs). */
function clientContext(): ClientContext {
  return CLIENT.getStore() ?? { ip: null, userAgent: null };
}

export async function record(
  sql: Sql,
  kbId: Uuid | null,
  actorId: Uuid,
  action: string,
  targetKind: string,
  targetId: Uuid | null,
  detail: unknown,
): Promise<void> {
  await recordOpt(sql, kbId, actorId, action, targetKind, targetId, detail);
}

/** System events with no human actor (like an AI adjudication auto-merge) go through here: actor is NULL. */
export async function recordOpt(
  sql: Sql,
  kbId: Uuid | null,
  actorId: Uuid | null,
  action: string,
  targetKind: string,
  targetId: Uuid | null,
  detail: unknown,
): Promise<void> {
  const ctx = clientContext();
  // Identity snapshot: if the user is later deleted (rows survive that
  // as of 0025), the ledger still knows who this was, instead of a bare
  // UUID. It is reliable to look up right now — the action is happening,
  // the person is still here.
  let actorLabel: string | null = null;
  if (actorId != null) {
    try {
      const rows = await q<{ email: string }>(sql, `SELECT email FROM users WHERE id = $1`, [
        actorId,
      ]);
      actorLabel = rows[0]?.email ?? null;
    } catch {
      actorLabel = null;
    }
  }
  await exec(
    sql,
    `INSERT INTO audit_events
        (id, kb_id, actor_id, action, target_kind, target_id, detail,
         client_ip, user_agent, actor_label)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      newId(),
      kbId,
      actorId,
      action,
      targetKind,
      targetId,
      detail,
      ctx.ip,
      ctx.userAgent,
      actorLabel,
    ],
  );
}

/** Review-decision ledger: only actions in the review domain (review./fact./conflict./merge.), paginated server-side. */
export async function reviewHistory(
  sql: Sql,
  kbId: Uuid,
  limit: number,
  offset: number,
): Promise<[AuditEventView[], number]> {
  const cond = `e.kb_id = $1 AND (e.action LIKE 'review.%' OR e.action LIKE 'fact.%'
                      OR e.action LIKE 'conflict.%' OR e.action LIKE 'merge.%')`;
  const rows = await q<AuditEventView>(
    sql,
    `SELECT e.id, e.action, e.target_kind, e.target_id, e.detail,
            u.display_name AS actor_name, e.created_at
     FROM audit_events e LEFT JOIN users u ON u.id = e.actor_id
     WHERE ${cond} ORDER BY e.created_at DESC LIMIT $2 OFFSET $3`,
    [kbId, limit, offset],
  );
  const total = await qOne<{ count: string }>(
    sql,
    `SELECT count(*) FROM audit_events e WHERE ${cond}`,
    [kbId],
  );
  return [rows, Number(total.count)];
}

/**
 * A knowledge base's audit ledger, with pagination and filters.
 *
 * It used to be a fixed most-recent-100, with no pagination and no
 * filters — but the ledger is compliance material; "only the last
 * hundred are visible" means the history cannot really be queried. The
 * three filters match how people actually query it:
 *
 * - `action`: a class of action ("who changed a type", "what got
 *   rejected"). Prefix match, not exact — action names are themselves
 *   layered (`entity.retyped` / `entity.renamed`), and passing `entity.`
 *   pulls a whole family at once.
 * - `actor`: what a specific person did. The single most common
 *   compliance question.
 * - `since` / `until`: a time window. Exactly what an incident review
 *   needs.
 *
 * The total count comes back too, otherwise the pager has no idea how
 * many pages there are — and "no idea how many pages" is the same
 * problem as the old fixed 100, wearing a different hat.
 */
export async function listForKb(
  sql: Sql,
  kbId: Uuid,
  action: string | null,
  actor: Uuid | null,
  since: Date | null,
  until: Date | null,
  limit: number,
  offset: number,
): Promise<[AuditEventView[], number]> {
  // All four filters are written as "no-op when the parameter is null",
  // so one query covers every combination — string-concatenating
  // branches would grow to sixteen cases here, each one an injection
  // surface.
  const where = `WHERE e.kb_id = $1
       AND ($2::text IS NULL OR e.action LIKE $2 || '%')
       AND ($3::uuid IS NULL OR e.actor_id = $3)
       AND ($4::timestamptz IS NULL OR e.created_at >= $4)
       AND ($5::timestamptz IS NULL OR e.created_at < $5)`;

  const rows = await q<AuditEventView>(
    sql,
    `SELECT e.id, e.action, e.target_kind, e.target_id, e.detail,
            u.display_name AS actor_name, e.created_at
     FROM audit_events e LEFT JOIN users u ON u.id = e.actor_id
     ${where}
     ORDER BY e.created_at DESC LIMIT $6 OFFSET $7`,
    [kbId, action, actor, since, until, limit, offset],
  );

  const total = await qOne<{ count: string }>(
    sql,
    `SELECT count(*) FROM audit_events e ${where}`,
    [kbId, action, actor, since, until],
  );
  return [rows, Number(total.count)];
}

/** Which actions have appeared in this KB's ledger. The filter dropdown should list only what is real — a hardcoded list of every possible action would show options that never happened in this KB. */
export async function actionsForKb(sql: Sql, kbId: Uuid): Promise<string[]> {
  const rows = await q<{ action: string }>(
    sql,
    `SELECT DISTINCT action FROM audit_events WHERE kb_id = $1 ORDER BY 1`,
    [kbId],
  );
  return rows.map((r) => r.action);
}

/** The most recent automatic ontology-extension run for a KB, if any. Read by the Ontology page's "last auto-extension" banner. */
export async function lastBootstrapRun(sql: Sql, kbId: Uuid): Promise<{ detail: Record<string, unknown>; at: Date } | null> {
  const row = await qOpt<{ detail: Record<string, unknown>; created_at: Date }>(
    sql,
    `SELECT detail, created_at FROM audit_events
     WHERE kb_id = $1 AND action = 'ontology.bootstrapped'
     ORDER BY id DESC LIMIT 1`,
    [kbId],
  );
  if (!row) return null;
  return { detail: row.detail, at: row.created_at };
}

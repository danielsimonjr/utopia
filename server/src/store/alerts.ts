/**
 * Alert center (0005). Review manages whether the knowledge is right.
 * Alerts manage whether the system is alive.
 *
 * One failure, one row, written once and never edited again. This table
 * deliberately has no state machine: no "resolved", no self-healing, no
 * folding repeated failures into one row.
 *
 * It used to have one, and the cost was that every new alert kind had to
 * reinvent "how do I know this is fixed" on its own —
 * `source.sync_failed` has a natural success signal (the next sync
 * succeeds), `llm.unreachable` does not, so it needed its own background
 * probe; a third kind would need a third mechanism, and a missed one is
 * invisible at compile time — the symptom is an alert that never clears.
 * More fundamentally, that is not this module's job: whether something
 * is broken right now is already shown on the source page, on the
 * document status. The alert center's job is to make someone look, not
 * to be a live dashboard.
 *
 * Deduplication is also skipped on purpose. "The same source failing
 * every hour for 24 hours straight" is 24 rows, not one — folding that
 * into one row requires deciding "is this a repeat or has it just never
 * recovered", and that distinction cannot be made from the data alone
 * without a clock or a success signal. A missed alert costs far more
 * than an extra row, so this errs toward writing more rows and lets
 * `purgeOlderThan` clean up afterward.
 */

import { q, qOne, exec, type Sql } from "../core/db";
import { newId, type Uuid } from "../core/ids";
import type { Role, User } from "../core/models";
import * as access from "./access";

/**
 * Alert kind strings. Written here as constants instead of scattered at
 * call sites: the UI looks up copy by this string, and a typo falls back
 * to showing the raw code — a mistake that neither type checking nor a
 * unit test will catch.
 */
export const kind = {
  /** KB-level: a source's sync failed. min_role = editor */
  SOURCE_SYNC_FAILED: "source.sync_failed",
  /**
   * System-level: the model endpoint did not give a usable answer —
   * unreachable, or reachable but not actually this API. A clean 4xx
   * from the endpoint does not count: that means it is a model API, the
   * key or quota is just wrong. That case is `LLM_RATE_LIMITED`.
   */
  LLM_UNREACHABLE: "llm.unreachable",
  /**
   * System-level: the endpoint is rate-limiting and backoff retries
   * still could not get through. min_role = admin
   *
   * Kept separate from `LLM_UNREACHABLE` because the right response
   * differs: unreachable means go check the network or the address;
   * rate-limited means lower concurrency or upgrade the plan — different
   * people, different actions.
   *
   * severity is `warning`, not `error`: quota recovers on its own, a
   * dead endpoint does not.
   *
   * This fills the other half of what backoff retries leave behind. A
   * retry no longer loses data, but when a document really is blocked by
   * quota, nothing else tells anyone that happened — one test run saw 4
   * documents fail, half unreachable (alerted), half rate-limited
   * (silent).
   */
  LLM_RATE_LIMITED: "llm.rate_limited",
  /**
   * System-level: the account cannot afford the request — out of
   * balance or plan quota exhausted. min_role = admin
   *
   * `error`, not `warning`, precisely because of how it differs from
   * rate limiting: quota resets on schedule, an unpaid bill does not.
   * Until someone tops it up, this deployment's extraction and
   * embedding stay stopped.
   */
  LLM_OUT_OF_CREDIT: "llm.out_of_credit",
  /**
   * KB-level: a data source got mounted, but its schema never made it
   * in. min_role = admin
   *
   * This describes not the failure but what it left behind: the source
   * is mounted, yet querying it cannot see which tables it has —
   * `query_data` still lists it, and the model can only guess at column
   * names. The error at the moment of mounting was visible only to
   * whoever clicked the button; from then on the KB is silently missing
   * it.
   */
  SCHEMA_SYNC_FAILED: "data_source.schema_sync_failed",
} as const;

/**
 * One failure. Bundled into an object not just for the argument count —
 * `severity: "error"` at a call site reads far better than "the third
 * positional argument is error", and the number of alert sources will
 * only grow.
 */
export type NewAlert = {
  /** null = system-level */
  kb_id: Uuid | null;
  severity: string;
  /** Use a constant from `kind`, never a literal. */
  kind: string;
  min_role: Role;
  /** document / source / system */
  subject_type: string | null;
  subject_id: Uuid | null;
  /**
   * The human-facing half: name, the raw error text. The name needs to
   * be stored here — once the object is deleted, `subject_id` no longer
   * resolves to a name, and the alert should still keep it.
   */
  detail: unknown;
};

/** Records one failure. Just an INSERT — no conflict handling, no read-back. */
export async function raise(sql: Sql, a: NewAlert): Promise<Uuid> {
  const id = newId();
  await exec(
    sql,
    `INSERT INTO alerts
         (id, kb_id, severity, kind, min_role, subject_type, subject_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, a.kb_id, a.severity, a.kind, a.min_role, a.subject_type, a.subject_id, a.detail],
  );
  return id;
}

/**
 * Retention cleanup. This is the price of being purely additive: a
 * broken source syncing hourly writes 24 rows a day, and without
 * cleanup this table grows into a second log file.
 *
 * This also deletes its read receipts (foreign key CASCADE).
 */
export async function purgeOlderThan(sql: Sql, days: number): Promise<number> {
  const res = await exec(
    sql,
    `DELETE FROM alerts WHERE created_at < now() - make_interval(days => $1)`,
    [days],
  );
  return res.count;
}

/**
 * The visibility predicate, written exactly once. The list, the unread
 * count, and "mark all read" each run their own query, but "who can see
 * what" is one rule; copying it three times would eventually drift.
 *
 * $1 = user_id, $2 = is_admin, $3 = the array of visible KBs, $4 = their
 * matching role ranks.
 */
const VISIBLE = `
    CASE
        WHEN a.kb_id IS NULL THEN $2::bool
        ELSE EXISTS (
            SELECT 1 FROM unnest($3::uuid[], $4::int[]) AS v(kb, rank)
            WHERE v.kb = a.kb_id
              AND v.rank >= CASE a.min_role
                    WHEN 'viewer' THEN 0
                    WHEN 'editor' THEN 1
                    WHEN 'admin'  THEN 2
                    ELSE 3 END)
    END`;

/**
 * The search matches the KB name, the object's details, and the kind
 * code — not the display title shown in the UI.
 *
 * That title's wording lives on the client (0004: the server does not
 * produce display copy), so the server cannot search it. This is not a
 * shortcut: what people actually search for is a source name or the raw
 * error text, both language-neutral and both sitting in `detail`.
 * Searching by category should use a filter, not the search box.
 */
const SEARCH = `
    ($5::text IS NULL
     OR a.kind ILIKE '%' || $5 || '%'
     OR COALESCE(k.name, '') ILIKE '%' || $5 || '%'
     OR a.detail::text ILIKE '%' || $5 || '%')`;

/** A group: consecutive failures sharing the same (kb, kind). */
export type AlertGroup = {
  kb_id: Uuid | null;
  kb_name: string | null;
  kind: string;
  /** The heaviest severity in the group */
  severity: string;
  /** How many times, in this group */
  count: number;
  /** Of those, how many I have not read */
  unread: number;
  /**
   * The newest and oldest moments in the group. "Mark read" scopes by
   * this range instead of sending a list of ids to the client — a group
   * can hold hundreds of rows.
   */
  latest_at: Date;
  earliest_at: Date;
  /** Up to `GROUP_LINES` details, newest first */
  lines: unknown[];
};

/**
 * How many detail lines a group carries at most. The panel cannot show
 * more than this anyway, and a group can have hundreds — sending them
 * all just slows down first load.
 */
const GROUP_LINES = 5;

/** One page of groups, plus the total group count. */
export type GroupPage = {
  items: AlertGroup[];
  total: number;
};

/**
 * Folds adjacent same-kind rows: subtracting two `row_number()`s (gaps
 * and islands).
 *
 * The global sequence number minus "the sequence number within the same
 * (kb, kind)" gives consecutive same-kind rows the same difference;
 * anything else in between shifts that difference — so the difference
 * itself is the group number. `PARTITION BY kb_id` treats NULL as equal,
 * so system-level alerts naturally group together.
 */
const ISLANDS = `
    SELECT v.*,
           row_number() OVER (ORDER BY v.created_at DESC, v.id DESC)
         - row_number() OVER (PARTITION BY v.kb_id, v.kind
                              ORDER BY v.created_at DESC, v.id DESC) AS grp
    FROM v`;

/** Alerts this person can see, paginated by group, newest first. */
export async function listGroups(
  sql: Sql,
  user: User,
  q_: string | null,
  limit: number,
  offset: number,
): Promise<GroupPage> {
  const [kbIds, kbRoles] = await visible(sql, user);
  // An empty string counts as no search: clearing the search box should
  // not turn into "search for an empty string".
  const trimmed = q_?.trim();
  const qParam = trimmed ? trimmed : null;
  const base = `WITH v AS (
             SELECT a.id, a.kb_id, k.name AS kb_name, a.severity, a.kind,
                    a.detail, a.created_at, (r.user_id IS NOT NULL) AS read
             FROM alerts a
             LEFT JOIN knowledge_bases k ON k.id = a.kb_id
             LEFT JOIN alert_reads r ON r.alert_id = a.id AND r.user_id = $1
             WHERE (${VISIBLE}) AND (${SEARCH})
         ),
         isl AS (${ISLANDS})`;
  const sql_ = `${base}
         SELECT kb_id, max(kb_name) AS kb_name, kind,
                -- severity takes the heaviest one, not a lexical max: that
                -- would let "warning" outrank "error"
                CASE max(CASE severity WHEN 'error' THEN 3 WHEN 'warning' THEN 2 ELSE 1 END)
                    WHEN 3 THEN 'error' WHEN 2 THEN 'warning' ELSE 'info' END AS severity,
                count(*) AS count,
                count(*) FILTER (WHERE NOT read) AS unread,
                max(created_at) AS latest_at,
                min(created_at) AS earliest_at,
                (array_agg(detail ORDER BY created_at DESC))[1:${GROUP_LINES}] AS lines
         FROM isl
         GROUP BY kb_id, kind, grp
         ORDER BY max(created_at) DESC
         LIMIT $6 OFFSET $7`;
  const items = await q<AlertGroup>(sql, sql_, [
    user.id,
    user.is_admin,
    kbIds,
    kbRoles,
    qParam,
    limit,
    offset,
  ]);
  // The total number of **groups**, not rows — the pager counts groups.
  const countSql = `${base} SELECT count(*) FROM (SELECT 1 FROM isl GROUP BY kb_id, kind, grp) g`;
  const total = await qOne<{ count: string }>(sql, countSql, [
    user.id,
    user.is_admin,
    kbIds,
    kbRoles,
    qParam,
  ]);
  return { items, total: Number(total.count) };
}

/**
 * Marks a whole group read. Scoped by a time range, not a list of ids —
 * a group can have hundreds of rows, and sending all their ids to the
 * client and back would be a wasted round trip.
 *
 * Visibility is still checked: nobody should be able to mark an alert
 * they cannot see read just by guessing its kind.
 */
export async function markGroupRead(
  sql: Sql,
  user: User,
  kbId: Uuid | null,
  kind_: string,
  from: Date,
  to: Date,
): Promise<number> {
  const [kbIds, kbRoles] = await visible(sql, user);
  const sql_ = `INSERT INTO alert_reads (alert_id, user_id)
         SELECT a.id, $1 FROM alerts a
         WHERE (${VISIBLE})
           AND a.kind = $5
           -- IS NOT DISTINCT FROM: a system-level alert's kb_id is NULL,
           -- and = cannot compare that
           AND a.kb_id IS NOT DISTINCT FROM $6
           AND a.created_at BETWEEN $7 AND $8
         ON CONFLICT DO NOTHING`;
  const res = await exec(sql, sql_, [
    user.id,
    user.is_admin,
    kbIds,
    kbRoles,
    kind_,
    kbId,
    from,
    to,
  ]);
  return res.count;
}

/** My unread count. */
export async function unreadCount(sql: Sql, user: User): Promise<number> {
  const [kbIds, kbRoles] = await visible(sql, user);
  const sql_ = `SELECT count(*) FROM alerts a
         LEFT JOIN alert_reads r ON r.alert_id = a.id AND r.user_id = $1
         WHERE (${VISIBLE}) AND r.user_id IS NULL`;
  const row = await qOne<{ count: string }>(sql, sql_, [user.id, user.is_admin, kbIds, kbRoles]);
  return Number(row.count);
}

/**
 * Marks everything I can see as read.
 *
 * One SQL statement, not one insert per row: doing it row by row would
 * first need the list fetched back, and "what can be seen" is already
 * written once in `VISIBLE` — fetching it back and looping over it would
 * apply the same rule twice.
 */
export async function markAllRead(sql: Sql, user: User): Promise<number> {
  const [kbIds, kbRoles] = await visible(sql, user);
  const sql_ = `INSERT INTO alert_reads (alert_id, user_id)
         SELECT a.id, $1 FROM alerts a
         WHERE (${VISIBLE})
         ON CONFLICT DO NOTHING`;
  const res = await exec(sql, sql_, [user.id, user.is_admin, kbIds, kbRoles]);
  return res.count;
}

/**
 * Splits visible KBs into two parallel arrays: Postgres has no
 * convenient way to pass an array of tuples, and `unnest(a, b)` expanded
 * side by side is the standard trick.
 */
async function visible(sql: Sql, user: User): Promise<[Uuid[], number[]]> {
  const roles = await access.visibleKbRoles(sql, user);
  const ids: Uuid[] = [];
  const ranks: number[] = [];
  for (const [id, r] of roles) {
    ids.push(id);
    ranks.push(rank(r));
  }
  return [ids, ranks];
}

/**
 * The role's rank, used to compare against `alerts.min_role`. Same order
 * as `Role`'s comparison, and the same order as the CASE in `VISIBLE` —
 * the three must agree.
 */
function rank(r: Role): number {
  switch (r) {
    case "viewer":
      return 0;
    case "editor":
      return 1;
    case "admin":
      return 2;
    case "owner":
      return 3;
  }
}

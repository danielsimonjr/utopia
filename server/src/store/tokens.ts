/**
 * Personal access tokens (see `docs/decisions/0014`).
 *
 * A token acts as the person who issued it, but does not have to carry
 * their full power:
 *
 * ```text
 * effective permission = this person's role ∩ this token's scope
 * ```
 *
 * That is an intersection, not a union — a viewer's token with write
 * checked is still read-only. So this module only answers "who does this
 * string belong to, and how far does this token let them go". Whether
 * they may touch a given KB is still decided by `access.requireKb`,
 * unchanged.
 */

import { createHash, randomBytes } from "node:crypto";
import { q, qOne, qOpt, exec, type Sql } from "../core/db";
import { AppError } from "../core/errors";
import { newId, type Uuid } from "../core/ids";

/**
 * The plaintext token prefix. Kept distinct from `sources.ingest_token`'s
 * `utp_` prefix — the two grant very different things, and a log line or
 * config file should make it obvious at a glance which kind this is.
 */
const PREFIX = "utp_pat_";
/** How much of the plaintext (including the prefix) is shown in lists. Enough to match a config file, not enough to reconstruct the rest. */
const SHOWN = 16;

/** A personal access token's metadata (0014). Never carries the plaintext — that exists only once, in the return value of `issue`; the database only ever stores the hash. */
export type TokenView = {
  id: Uuid;
  name: string;
  token_prefix: string;
  scope: string;
  kb_ids: Uuid[] | null;
  expires_at: Date | null;
  last_used_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
};

/** What you get once a token checks out: who it is, and how far it lets them go. */
export class Authenticated {
  constructor(
    public readonly userId: Uuid,
    public readonly tokenId: Uuid,
    /** read | write */
    public readonly scope: string,
    /** null = every KB this person can enter */
    public readonly kbIds: Uuid[] | null,
  ) {}

  /**
   * Whether this token is allowed anywhere near this KB.
   *
   * This is not a permission check, only a scope check. `true` only
   * means the token has not excluded it — what role that person actually
   * has on this KB is still `access.requireKb`'s job.
   */
  covers(kbId: Uuid): boolean {
    return this.kbIds == null || this.kbIds.includes(kbId);
  }

  canWrite(): boolean {
    return this.scope === "write";
  }
}

/**
 * SHA-256, not argon2. This is the one place that stores secrets
 * differently from a password, for two reasons:
 *
 * 1. A token is high-entropy random text, not something a person chose.
 *    argon2 is slow to make brute-forcing "password123" not worth it;
 *    against 244 bits of randomness, a million times slower still buys
 *    nothing.
 * 2. argon2 salts every row differently, so it cannot be looked up.
 *    Verification is a hot path (once per tool call), and
 *    `WHERE token_hash = $1` hits a unique index in one shot; argon2
 *    would need every token pulled back and verified one by one — the
 *    more tokens issued, the slower it gets.
 */
function hash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Issues one. The returned plaintext is its only appearance — the database only stores the hash, and losing it means reissuing. */
export async function issue(
  sql: Sql,
  userId: Uuid,
  name: string,
  scope: string,
  kbIds: Uuid[] | null,
  expiresAt: Date | null,
): Promise<[TokenView, string]> {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 64) {
    throw AppError.invalid("bad_token_name", "Token name must be 1-64 characters");
  }
  if (scope !== "read" && scope !== "write") {
    throw AppError.invalid("bad_token_scope", "Scope must be read or write");
  }
  // Two random 128-bit halves give about 244 bits of entropy, the same
  // approach as `new_ingest_token`; a different prefix just keeps them
  // distinguishable in logs.
  const plain = `${PREFIX}${randomBytes(16).toString("hex")}${randomBytes(16).toString("hex")}`;
  const id = newId();
  const view = await qOne<TokenView>(
    sql,
    `INSERT INTO personal_tokens
         (id, user_id, name, token_hash, token_prefix, scope, kb_ids, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, name, token_prefix, scope, kb_ids, expires_at,
               last_used_at, revoked_at, created_at`,
    [id, userId, trimmed, hash(plain), plain.slice(0, SHOWN), scope, kbIds, expiresAt],
  );
  return [view, plain];
}

/** Every token I issued. Revoked ones are listed too — that a token was revoked must stay visible. */
export async function list(sql: Sql, userId: Uuid): Promise<TokenView[]> {
  return q<TokenView>(
    sql,
    `SELECT id, name, token_prefix, scope, kb_ids, expires_at,
            last_used_at, revoked_at, created_at
       FROM personal_tokens WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
}

/**
 * Revokes one. This stamps the row rather than deleting it: that a token
 * was revoked is itself something worth keeping a record of, the first
 * thing anyone investigating afterward will ask.
 */
export async function revoke(sql: Sql, userId: Uuid, tokenId: Uuid): Promise<void> {
  const res = await exec(
    sql,
    `UPDATE personal_tokens SET revoked_at = now()
      WHERE id = $2 AND user_id = $1 AND revoked_at IS NULL`,
    [userId, tokenId],
  );
  if (res.count === 0) throw AppError.notFound();
}

/**
 * Plaintext -> who this is and how far they may go.
 *
 * Expiry and revocation are checked in SQL, not after fetching the row
 * back into application code: fetching first and comparing after leaves
 * a window where a token revoked in between still passes, and MCP
 * connections are long-lived enough for that window to matter.
 *
 * This also writes `last_used_at` along the way: before revoking a
 * token, someone needs to be able to answer "is this one still in use",
 * and without that number nobody would dare revoke it.
 */
export async function authenticate(sql: Sql, plain: string): Promise<Authenticated> {
  if (!plain.startsWith(PREFIX)) {
    throw AppError.unauthorized();
  }
  const row = await qOpt<{ id: Uuid; user_id: Uuid; scope: string; kb_ids: Uuid[] | null }>(
    sql,
    `UPDATE personal_tokens SET last_used_at = now()
      WHERE token_hash = $1
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())
    RETURNING id, user_id, scope, kb_ids`,
    [hash(plain)],
  );
  if (!row) throw AppError.unauthorized();
  return new Authenticated(row.user_id, row.id, row.scope, row.kb_ids);
}

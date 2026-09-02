/**
 * Chat conversation persistence: conversation/message store. The
 * trajectory (steps) and citations (sources) are written alongside the
 * assistant message; history replay and the live stream share the same
 * shape.
 */

import { q, qOne, qOpt, exec, type Sql } from "../core/db";
import { AppError } from "../core/errors";
import { newId, type Uuid } from "../core/ids";

/** A conversation row (left-column list). */
export type ConversationView = {
  id: Uuid;
  title: string;
  created_at: Date;
  updated_at: Date;
  message_count: number;
};

/** A chat message (with the stored action trace and citations, for history replay). */
export type ConversationMessage = {
  id: Uuid;
  role: string;
  content: string;
  steps: unknown;
  sources: unknown;
  created_at: Date;
};

export async function create(
  sql: Sql,
  kbId: Uuid,
  userId: Uuid,
  title: string,
): Promise<Uuid> {
  const id = newId();
  await exec(
    sql,
    `INSERT INTO conversations (id, kb_id, user_id, title) VALUES ($1, $2, $3, $4)`,
    [id, kbId, userId, [...title].slice(0, 80).join("")],
  );
  return id;
}

/**
 * My conversations in this KB. Searchable and paginated — titles repeat
 * (asking the same question twice repeats the title), and a fixed
 * hundred conversations means anything after that does not exist in the
 * UI at all.
 *
 * The search covers both the title and message bodies: what people
 * remember is often "I asked about that Q3 thing", and that phrase lives
 * in the body, while the title may have been truncated into something
 * else.
 */
export async function list(
  sql: Sql,
  kbId: Uuid,
  userId: Uuid,
  q_: string | null,
  limit: number,
  offset: number,
): Promise<[ConversationView[], number]> {
  const where = `WHERE c.kb_id = $1 AND c.user_id = $2
         AND ($3::text IS NULL
              OR c.title ILIKE '%' || $3 || '%'
              OR EXISTS (SELECT 1 FROM conversation_messages m
                          WHERE m.conversation_id = c.id
                            AND m.content ILIKE '%' || $3 || '%'))`;
  const rows = await q<ConversationView>(
    sql,
    `SELECT c.id, c.title, c.created_at, c.updated_at,
            (SELECT count(*) FROM conversation_messages m
             WHERE m.conversation_id = c.id) AS message_count
     FROM conversations c
     ${where}
     ORDER BY c.updated_at DESC
     LIMIT $4 OFFSET $5`,
    [kbId, userId, q_, limit, offset],
  );
  const total = await qOne<{ count: string }>(
    sql,
    `SELECT count(*) FROM conversations c ${where}`,
    [kbId, userId, q_],
  );
  return [rows, Number(total.count)];
}

/**
 * Renames a conversation.
 *
 * The title used to be picked automatically from the first message, and
 * that message is often not what the conversation ends up being about —
 * drifting off topic is normal, and renaming lets someone find it again
 * the way they actually remember it.
 */
export async function rename(
  sql: Sql,
  kbId: Uuid,
  userId: Uuid,
  conversationId: Uuid,
  title: string,
): Promise<void> {
  const trimmed = title.trim();
  if (trimmed.length === 0 || trimmed.length > 120) {
    throw AppError.invalid("bad_title", "Title must be 1-120 characters");
  }
  const res = await exec(
    sql,
    `UPDATE conversations SET title = $4
      WHERE id = $3 AND kb_id = $1 AND user_id = $2`,
    [kbId, userId, conversationId, trimmed],
  );
  if (res.count === 0) throw AppError.notFound();
}

/** Ownership check: a conversation must belong to this KB and this person. */
export async function requireOwned(
  sql: Sql,
  kbId: Uuid,
  userId: Uuid,
  conversationId: Uuid,
): Promise<void> {
  const found = await qOpt<{ id: Uuid }>(
    sql,
    `SELECT id FROM conversations WHERE id = $1 AND kb_id = $2 AND user_id = $3`,
    [conversationId, kbId, userId],
  );
  if (!found) throw AppError.notFound();
}

export async function messages(sql: Sql, conversationId: Uuid): Promise<ConversationMessage[]> {
  return q<ConversationMessage>(
    sql,
    `SELECT id, role, content, steps, sources, created_at
     FROM conversation_messages WHERE conversation_id = $1 ORDER BY created_at`,
    [conversationId],
  );
}

/**
 * One round's replay history.
 *
 * Three things, each answering a different question: the text (what was
 * said), the entities (who got recognized), and the most recent round's
 * tool exchange (what got done).
 *
 * The third thing was added later. The original judgment was "identity
 * is enough for replay: once we have the id, next round can call
 * entity_facts directly" — that saving on accumulated chunk text per
 * round was not wrong. But it also threw away "we already looked this
 * up": across rounds, the model could only see its own prose, so asking
 * to "translate" would search again, sometimes landing on a different
 * batch of same-named entities.
 *
 * The compromise is to **replay only the most recent round**: what is
 * needed is "what did I just do", not twenty rounds of output.
 */
export type History = {
  /** `(role, content)`, chronological */
  turns: [string, string][];
  /** entities already recognized in this conversation (deduplicated) */
  entities: unknown[];
  /**
   * **What the assistant did in the most recent round**: the assistant
   * message carrying `tool_calls`, plus the matching tool results.
   *
   * Only the most recent round. This exists so the model knows what it
   * just did — when the next message says "translate" or "shorter", the
   * evidence is right there and does not need to be looked up again
   * (and so it will not land on a different batch of same-named
   * entities). Carrying twenty rounds of tool output back is a
   * different matter — that is exactly why only the text is kept for
   * the rest.
   */
  last_tool_exchange: unknown[];
};

export async function recentContext(
  sql: Sql,
  conversationId: Uuid,
  n: number,
): Promise<History> {
  const rows = await q<{
    role: string;
    content: string;
    resolved: unknown;
    tool_exchange: unknown;
    created_at: Date;
  }>(
    sql,
    `SELECT role, content, resolved, tool_exchange, created_at FROM conversation_messages
     WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [conversationId, n],
  );
  rows.reverse();
  // Entities are deduplicated by id, keeping the order of first
  // appearance: the same entity showing up across several rounds is
  // normal, and listing it again each round would just say the same
  // thing three times.
  const seen = new Set<string>();
  const entities: unknown[] = [];
  for (const row of rows) {
    const list = Array.isArray(row.resolved) ? row.resolved : [];
    for (const e of list) {
      const id = typeof e === "object" && e != null ? (e as Record<string, unknown>).id : undefined;
      if (typeof id !== "string") continue;
      if (!seen.has(id)) {
        seen.add(id);
        entities.push(e);
      }
    }
  }
  // The segment from the last assistant message. Search backward — the
  // last row is usually the user message that was just saved.
  let lastToolExchange: unknown[] = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]!.role === "assistant") {
      const ex = rows[i]!.tool_exchange;
      lastToolExchange = Array.isArray(ex) ? ex : [];
      break;
    }
  }
  return {
    turns: rows.map((r) => [r.role, r.content]),
    entities,
    last_tool_exchange: lastToolExchange,
  };
}

/**
 * Everything a round leaves behind besides the text.
 *
 * All four are untyped JSON, passed around loosely — passing them in the
 * wrong order still compiles, still stores, still reads back, only with
 * the contents mixed up. Same reasoning as `RelationAxioms`.
 */
export type TurnRecord = {
  /** the action trace: what was called, how much came back (shown in the UI) */
  steps: unknown;
  /** the citation list */
  sources: unknown;
  /** entities recognized this round (id / name / type). Replayed next round so the model can keep going instead of searching again */
  resolved: unknown;
  /** what was called and what came back this round (already truncated). Replayed next round — without it the model has no idea across rounds that it already looked something up, so it looks again */
  tool_exchange: unknown;
};

/** A user message: all four are empty. */
export function emptyTurnRecord(): TurnRecord {
  return { steps: [], sources: [], resolved: [], tool_exchange: [] };
}

export async function appendMessage(
  sql: Sql,
  conversationId: Uuid,
  role: string,
  content: string,
  rec: TurnRecord,
): Promise<Uuid> {
  const id = newId();
  await sql.begin(async (tx) => {
    await exec(
      tx,
      `INSERT INTO conversation_messages
           (id, conversation_id, role, content, steps, sources, resolved, tool_exchange)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, conversationId, role, content, rec.steps, rec.sources, rec.resolved, rec.tool_exchange],
    );
    await exec(tx, `UPDATE conversations SET updated_at = now() WHERE id = $1`, [
      conversationId,
    ]);
  });
  return id;
}

export async function del(
  sql: Sql,
  kbId: Uuid,
  userId: Uuid,
  conversationId: Uuid,
): Promise<void> {
  const res = await exec(
    sql,
    `DELETE FROM conversations WHERE id = $1 AND kb_id = $2 AND user_id = $3`,
    [conversationId, kbId, userId],
  );
  if (res.count === 0) throw AppError.notFound();
}

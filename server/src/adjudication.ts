/**
 * The entity-resolution batched adjudication job: consumes gray-zone pairs
 * in the review queue with `stage=adjudicating`.
 *
 * It checks the verdict cache first; cache misses are batched together
 * (one LLM call judges many pairs at once). A high-confidence "same"
 * auto-merges (revertible); a high-confidence "different" auto-keeps them
 * apart; everything else goes to manual review. With no model configured,
 * everything goes to manual review — this task failing or being absent
 * never blocks extraction or querying.
 */

import { createHash } from "node:crypto";
import type { Sql } from "./core/db";
import * as store from "./store";
import { chatClient, acquireChat } from "./llm_util";
import { isAppError } from "./core/errors";
import type { Uuid } from "./core/ids";
import { buildAdjudicationMessages, parseAdjudication, type AdjudicationPair } from "./extract";
import * as events from "./events";
import type { ReviewItem, ReviewSide } from "./store/resolution";

const BATCH_SIZE = 12;
const AUTO_CONF = 0.8;
const MAX_ROUNDS = 20;

/** Cache key: type + both sides' name + fact summary (independent of entity id — resubmitting a document does not pay twice). */
function pairKey(item: ReviewItem): string {
  const side = (s: ReviewSide): string =>
    `${s.name.toLowerCase()}|${s.type_label ?? "untyped"}|${s.top_facts.join(";")}`;
  const sides = [side(item.left), side(item.right)].sort();
  return createHash("sha256").update(sides.join("##")).digest("hex");
}

export async function adjudicateEntities(sql: Sql, kb_id: Uuid): Promise<void> {
  const kb = await store.kbs.get(sql, kb_id);
  const settings = await store.settings.get(sql, kb.workspace_id);
  const client = settings ? chatClient(settings) : null;
  const model = settings?.chat_model ?? "";

  if (!client) {
    // No model available: escalate everything to manual review; the task itself finishes successfully.
    const items = await store.resolution.pending_adjudications(sql, kb_id, 500);
    for (const item of items) {
      await store.resolution.escalate_review(sql, item.id, "escalate_no_model");
    }
    events.emitReview(kb_id);
    return;
  }

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const items = await store.resolution.pending_adjudications(sql, kb_id, BATCH_SIZE);
    if (items.length === 0) break;

    // First tier: the verdict cache.
    const toAsk: [ReviewItem, string][] = [];
    for (const item of items) {
      const key = pairKey(item);
      const cached = await store.resolution.get_verdict(sql, kb_id, key);
      if (cached) {
        const [same, conf] = cached;
        await applyVerdict(sql, kb_id, item, same, conf, "cached");
      } else {
        toAsk.push([item, key]);
      }
    }
    if (toAsk.length === 0) continue;

    // Second tier: a batched LLM verdict.
    const pairs: AdjudicationPair[] = toAsk.map(([item]) => ({
      left: {
        name: item.left.name,
        typeLabel: item.left.type_label ?? "untyped",
        facts: item.left.top_facts,
      },
      right: {
        name: item.right.name,
        typeLabel: item.right.type_label ?? "untyped",
        facts: item.right.top_facts,
      },
    }));
    const messages = buildAdjudicationMessages(pairs);
    // A failed call or a failed parse -> the task retries with backoff;
    // once retries run out the rows stay in the queue, and a human can
    // still decide them.
    const release = settings ? await acquireChat(sql, settings) : () => {};
    let reply: string;
    try {
      reply = await client.chat(messages);
    } finally {
      release();
    }
    const verdicts = parseAdjudication(reply);
    const byI = new Map(verdicts.map((v) => [v.i, v]));

    for (let idx = 0; idx < toAsk.length; idx++) {
      const [item, key] = toAsk[idx]!;
      const v = byI.get(idx);
      if (v) {
        const same = v.verdict === "same" ? true : v.verdict === "different" ? false : null;
        const conf = Math.min(Math.max(v.confidence ?? 0.5, 0), 1);
        await store.resolution.put_verdict(sql, kb_id, key, same, conf, model);
        await applyVerdict(sql, kb_id, item, same, conf, "adjudicated");
      } else {
        await store.resolution.escalate_review(sql, item.id, "escalate_no_verdict");
      }
    }
    // This round's verdicts are written; tell the frontend to refresh the review queue.
    events.emitReview(kb_id);
  }
}

async function applyVerdict(
  sql: Sql,
  kb_id: Uuid,
  item: ReviewItem,
  same: boolean | null,
  conf: number,
  via: string,
): Promise<void> {
  if (same === true && conf >= AUTO_CONF) {
    const [target, source] = await store.resolution.merge_direction(sql, item.left.id, item.right.id);
    const reason = `auto_merged|${via} ${conf.toFixed(2)}`;
    try {
      await store.resolution.merge_entities(sql, kb_id, source, target, null, reason);
      await store.resolution.close_review_auto(sql, item.id, "merged", reason);
      // Decision ledger: an AI auto-merge (empty actor = the system).
      await store.audit.recordOpt(sql, kb_id, null, "review.merge", "review", item.id, {
        left: item.left.name,
        right: item.right.name,
        score: item.score,
        confidence: conf,
        via,
      }).catch(() => {});
    } catch (e) {
      // A chained merge earlier in the same batch may already have
      // swallowed one side: escalate to a human instead of failing the
      // task.
      if (isAppError(e) && (e.kind === "Conflict" || e.kind === "NotFound")) {
        await store.resolution.escalate_review(sql, item.id, "escalate_entity_changed");
      } else {
        throw e;
      }
    }
  } else if (same === false && conf >= AUTO_CONF) {
    const reason = `kept_apart|${via} ${conf.toFixed(2)}`;
    await store.resolution.close_review_auto(sql, item.id, "kept", reason);
    await store.audit.recordOpt(sql, kb_id, null, "review.keep", "review", item.id, {
      left: item.left.name,
      right: item.right.name,
      score: item.score,
      confidence: conf,
      via,
    }).catch(() => {});
  } else {
    await store.resolution.escalate_review(sql, item.id, `escalate_unsure|${via} ${conf.toFixed(2)}`);
  }
}

void AppError;

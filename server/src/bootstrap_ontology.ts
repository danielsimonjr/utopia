/**
 * Auto-extend-ontology cold start (mirrors
 * `crates/utopia-server/src/bootstrap_ontology.rs`).
 *
 * The Rust build turns votes on unmatched predicates/types into new
 * ontology relations, classes, and attributes, then rewrites the facts
 * waiting on them. That LLM-proposal pipeline (`ontology_routes::
 * build_proposals` and friends) is not ported to this Bun/Hono build yet.
 *
 * This stub keeps the job queue healthy: `extraction.ts` enqueues
 * `bootstrap_ontology` after a document extracts, and a missing handler
 * would otherwise mark every one of those jobs "not implemented" forever.
 * Logging and returning keeps extraction itself fully usable; only the
 * automatic ontology growth step is out of scope here. A knowledge base
 * with `auto_extend_ontology` on still surfaces its unmatched predicates
 * and types in the Unmatched panel for a manual Suggest / Add.
 */

import type { AppState } from "./state";
import * as store from "./store";
import { log } from "./core/log";
import type { Uuid } from "./core/ids";

export async function bootstrapOntology(state: AppState, kbId: Uuid): Promise<void> {
  const kb = await store.kbs.get(state.sql, kbId);
  if (!kb.auto_extend_ontology) return;
  log.warn("ontology auto-extend not wired in the Bun/Hono server yet", { kb_id: kbId });
}

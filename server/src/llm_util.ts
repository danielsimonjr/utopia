/**
 * Builds an LLM client from workspace settings, and a per-model
 * concurrency gate.
 */

import type { AppState } from "./state";
import { LlmClient } from "./llm";
import * as store from "./store";
import { chatReady, embedReady, type LlmSettings } from "./core/models";

export function chatClient(s: LlmSettings): LlmClient | null {
  if (!chatReady(s) || !s.chat_base_url || !s.chat_model) return null;
  return new LlmClient(s.chat_base_url, s.chat_api_key, s.chat_model);
}

export function embedClient(s: LlmSettings): LlmClient | null {
  if (!embedReady(s) || !s.embed_base_url || !s.embed_model) return null;
  return new LlmClient(s.embed_base_url, s.embed_api_key, s.embed_model);
}

/** A counting semaphore. `acquire()` resolves once a slot is free; call the returned release function when done. */
class Semaphore {
  private available: number;
  private readonly queue: Array<() => void> = [];

  constructor(limit: number) {
    this.available = limit;
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.available -= 1;
    return () => this.release();
  }

  private release(): void {
    this.available += 1;
    const next = this.queue.shift();
    if (next) next();
  }
}

/**
 * A registry of per-model semaphores. When the limit changes, a fresh
 * semaphore replaces the old one — permits already in flight on the old
 * one simply run out, and the swap may briefly exceed the new limit. That
 * is acceptable: it buys "a change takes effect immediately" without a
 * cache to invalidate.
 */
class ModelGates {
  private readonly gates = new Map<string, { limit: number; sem: Semaphore }>();

  gate(key: string, limit: number): Semaphore {
    const existing = this.gates.get(key);
    if (existing && existing.limit === limit) return existing.sem;
    const sem = new Semaphore(limit);
    this.gates.set(key, { limit, sem });
    return sem;
  }
}

const modelGates = new ModelGates();

/**
 * Acquires a permit before calling a model in a background task; hold it
 * until the call ends.
 *
 * **Background tasks only** (extraction, adjudication, ingest embeddings,
 * ontology suggestions). Chat and search do not go through this — making
 * a person's typing wait behind ten background extractions would make the
 * product feel broken, and a single person typing never floods a
 * provider's real rate limit anyway.
 *
 * Returns a no-op release function when the limit cannot be read (table
 * not yet created, database briefly unreachable) — the concurrency limit
 * is a safeguard, and it must not stall the whole pipeline just because
 * its own configuration could not be read.
 */
export async function acquire(state: AppState, baseUrl: string, model: string): Promise<() => void> {
  try {
    const limit = await store.modelLimits.limitFor(state.sql, baseUrl, model);
    const key = `${baseUrl}|${model}`;
    return await modelGates.gate(key, limit).acquire();
  } catch {
    return () => {};
  }
}

export async function acquireChat(state: AppState, s: LlmSettings): Promise<() => void> {
  if (!s.chat_base_url || !s.chat_model) return () => {};
  return acquire(state, s.chat_base_url, s.chat_model);
}

export async function acquireEmbed(state: AppState, s: LlmSettings): Promise<() => void> {
  if (!s.embed_base_url || !s.embed_model) return () => {};
  return acquire(state, s.embed_base_url, s.embed_model);
}

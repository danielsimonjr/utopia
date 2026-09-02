/**
 * Domain types.
 *
 * Roles sort from low to high: viewer < editor < admin < owner.
 * The database stores the lowercase name.
 */

import type { Uuid } from "./ids";

export type Role = "viewer" | "editor" | "admin" | "owner";

const ROLE_RANK: Record<Role, number> = {
  viewer: 0,
  editor: 1,
  admin: 2,
  owner: 3,
};

export function parseRole(s: string): Role | null {
  if (s === "viewer" || s === "editor" || s === "admin" || s === "owner") return s;
  return null;
}

export function roleAtLeast(have: Role, min: Role): boolean {
  return ROLE_RANK[have] >= ROLE_RANK[min];
}

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export type User = {
  id: Uuid;
  org_id: Uuid;
  email: string;
  password_hash: string;
  display_name: string;
  is_admin: boolean;
  created_at: Date;
};

export type PublicUser = Omit<User, "password_hash">;

export function publicUser(u: User): PublicUser {
  const { password_hash: _, ...rest } = u;
  return rest;
}

export type Organization = {
  id: Uuid;
  name: string;
  created_at: Date;
};

export type Workspace = {
  id: Uuid;
  org_id: Uuid;
  name: string;
  created_at: Date;
};

export type KnowledgeBase = {
  id: Uuid;
  workspace_id: Uuid;
  name: string;
  kind: string;
  description: string | null;
  visibility: string;
  is_default: boolean;
  auto_extend_ontology: boolean;
  materialize_inferences: boolean;
  inference_interval_minutes: number | null;
  last_inference_at: Date | null;
  ontology_lang: string | null;
};

export type Document = {
  id: Uuid;
  kb_id: Uuid;
  source_id: Uuid | null;
  filename: string;
  mime: string;
  size_bytes: number;
  sha256: string;
  status: string;
  error: string | null;
  doc_time: Date | null;
  doc_time_source: string;
  graph_status: string;
  graph_error: string | null;
  text_len: number;
  chunk_count: number;
  tags: string[];
  external_key: string | null;
  missing_since: Date | null;
  created_at: Date;
  updated_at: Date;
};

export type Source = {
  id: Uuid;
  kb_id: Uuid;
  kind: string;
  name: string;
  config: Json;
  icon: string | null;
  sync_interval_minutes: number | null;
  sync_cron: string | null;
  last_sync_at: Date | null;
  last_sync_status: string;
  last_sync_error: string | null;
  last_sync_added: number;
  ingest_token: string | null;
  created_at: Date;
};

export type LlmSettings = {
  workspace_id: Uuid;
  chat_base_url: string | null;
  chat_api_key: string | null;
  chat_model: string | null;
  embed_base_url: string | null;
  embed_api_key: string | null;
  embed_model: string | null;
  embed_dim: number | null;
  updated_at: Date;
};

export function chatReady(s: LlmSettings): boolean {
  return Boolean(s.chat_base_url && s.chat_model);
}

export function embedReady(s: LlmSettings): boolean {
  return Boolean(s.embed_base_url && s.embed_model);
}

export type Job = {
  id: number;
  kind: string;
  payload: Json;
  attempts: number;
  max_attempts: number;
};

export type ChunkView = {
  id: Uuid;
  document_id: Uuid;
  seq: number;
  text: string;
  filename: string;
};

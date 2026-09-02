/**
 * Source sync task: url (page scraping) / rss (feed, pubDate -> doc_time)
 * / github_issues / jira_issues (tickets, update time -> doc_time, body
 * carries the status-change history) / s3 (object storage, LastModified
 * -> doc_time). All of it dedups by sha256 (identical content is skipped
 * silently); a new document enters the standard ingest pipeline
 * (`process_document`). folder is a plain container (upload goes
 * straight in); api is push-based — neither has pull semantics.
 */

import { createHash } from "node:crypto";
import type { AppState } from "./state";
import * as store from "./store";
import type { Source } from "./core/models";
import { isAppError } from "./core/errors";
import type { Uuid } from "./core/ids";
import { log } from "./core/log";
import * as githubIssues from "./github_issues";
import * as jiraIssues from "./jira_issues";
import * as objectStorage from "./object_storage";

/** Cap on new documents per sync (guards against a runaway feed or URL list stalling the task). */
const MAX_NEW_PER_SYNC = 200;

/**
 * The User-Agent used for fetching. Wikipedia rejects an anonymous
 * request outright (403), and sites behind Cloudflare commonly do too —
 * without one, url and rss sources fail against a large share of real
 * sites. Naming ourselves is also crawler courtesy: the site operator
 * can identify us and reach us.
 */
const UA = "Utopia/0.1 (+https://utopia.bi; self-hosted knowledge platform)";

/** One sync's output counters (Moved/Unchanged do not count). */
export type SyncStats = { created: number; updated: number };

function emptyStats(): SyncStats {
  return { created: 0, updated: 0 };
}

function absorb(stats: SyncStats, action: IngestAction): void {
  if (action === "Created") stats.created += 1;
  else if (action === "Updated") stats.updated += 1;
}

function total(stats: SyncStats): number {
  return stats.created + stats.updated;
}

export async function syncSource(state: AppState, sourceId: Uuid): Promise<void> {
  const source = await store.sources.get(state.sql, sourceId);
  await store.sources.markRunning(state.sql, sourceId);
  const runId = await store.sources.startRun(state.sql, sourceId);
  state.emitSource(source.kb_id);

  let outcome: { ok: true; stats: SyncStats } | { ok: false; error: string };
  try {
    let stats: SyncStats;
    switch (source.kind) {
      case "url":
        stats = await syncUrls(state, source);
        break;
      case "rss":
        stats = await syncRss(state, source);
        break;
      case "custom":
        stats = await syncCustom(state, source);
        break;
      case "github_issues":
        stats = await syncGithubIssues(state, source);
        break;
      case "jira_issues":
        stats = await syncJiraIssues(state, source);
        break;
      case "s3":
        stats = await syncObjectStorage(state, source);
        break;
      default:
        // folder / api have no pull semantics.
        stats = emptyStats();
    }
    outcome = { ok: true, stats };
  } catch (e) {
    outcome = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  if (outcome.ok) {
    await store.sources.finishRun(state.sql, runId, sourceId, null, outcome.stats.created, outcome.stats.updated);
    await store.sources.finishSync(state.sql, sourceId, null, total(outcome.stats));
    state.emitSource(source.kb_id);
    log.info("source sync complete", {
      source_id: sourceId,
      kind: source.kind,
      created: outcome.stats.created,
      updated: outcome.stats.updated,
    });
  } else {
    await store.sources.finishRun(state.sql, runId, sourceId, outcome.error, 0, 0);
    await store.sources.finishSync(state.sql, sourceId, outcome.error, 0);
    state.emitSource(source.kb_id);
    throw new Error(outcome.error);
  }
}

/** The outcome of the three-way test. */
export type IngestAction =
  | "Created"
  | "Updated"
  | "Moved"
  /** No change detected. */
  | "Unchanged"
  /** Tombstoned: flagged "not in the source" (the document itself is not deleted — that decision is left to the user in the UI). */
  | "Tombstoned";

async function writeBlob(state: AppState, sha256: string, bytes: Uint8Array): Promise<void> {
  await state.blob.put(sha256, bytes);
}

function shaHex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Push with plain-upload semantics (the KB-level `/ingest` -> Uploads):
 * no source, no identity key, no three-way test — identical content
 * already in the KB is a no-op, everything else is created.
 */
export async function ingestUpload(
  state: AppState,
  kbId: Uuid,
  filename: string,
  mime: string,
  bytes: Uint8Array,
  docTime: Date | null,
): Promise<IngestAction> {
  if (bytes.length === 0) {
    return "Unchanged";
  }
  const sha256 = shaHex(bytes);
  await writeBlob(state, sha256, bytes);
  try {
    const doc = await store.documents.create(state.sql, kbId, filename, mime, bytes.length, sha256, null, docTime, null);
    await store.jobs.enqueue(state.sql, "process_document", { document_id: doc.id });
    state.emitDocument(kbId, doc.id);
    return "Created";
  } catch (e) {
    if (isAppError(e) && e.kind === "Conflict") return "Unchanged";
    throw e;
  }
}

/**
 * Identity-aware ingest: a three-way test by (source, external_key) —
 * new (create the document) / changed (replace in place + record a
 * version + rerun the pipeline) / unchanged (skip); identical content at
 * a new path is recognized as a move (identity only, no rerun).
 * `externalKey` is URI-shaped (`file:///` relative path, page URL, RSS
 * guid, `api:{id}`) — the provenance describes itself, which also
 * pre-aligns with the P5 SPARQL projection's document IRI.
 */
export async function ingestItem(
  state: AppState,
  kbId: Uuid,
  sourceId: Uuid,
  externalKey: string,
  filename: string,
  mime: string,
  bytes: Uint8Array,
  docTime: Date | null,
): Promise<IngestAction> {
  if (bytes.length === 0) {
    return "Unchanged";
  }
  const sha256 = shaHex(bytes);

  // Primary test: logical identity. Fallback: a pre-migration legacy
  // document (no key) claimed by filename and backfilled with a key.
  let existing = await store.documents.findByExternalKey(state.sql, sourceId, externalKey);
  if (!existing) {
    const legacy = await store.documents.findLegacyByFilename(state.sql, sourceId, filename);
    if (legacy) {
      await store.documents.adoptExternalKey(state.sql, legacy.id, externalKey);
      // Claiming it records the old content as version 1 (there was no version record before).
      await store.documents.recordVersion(state.sql, legacy.id, legacy.sha256, legacy.size_bytes);
      existing = legacy;
    }
  }

  if (existing) {
    if (existing.sha256 === sha256) {
      return "Unchanged";
    }
    // Changed: replace in place; the old version enters document_versions
    // (blob content-addressing keeps it around, so a replay has material).
    await writeBlob(state, sha256, bytes);
    await store.documents.replaceContent(state.sql, existing.id, filename, mime, bytes.length, sha256, docTime);
    await store.documents.recordVersion(state.sql, existing.id, sha256, bytes.length);
    await store.jobs.enqueue(state.sql, "process_document", { document_id: existing.id });
    state.emitDocument(kbId, existing.id);
    return "Updated";
  }

  // Identical content at a new path: recognized as a move/rename, no pipeline rerun.
  const bySha = await store.documents.findBySourceSha(state.sql, sourceId, sha256);
  if (bySha) {
    await store.documents.updateLocation(state.sql, bySha.id, filename, externalKey);
    state.emitDocument(kbId, bySha.id);
    return "Moved";
  }

  await writeBlob(state, sha256, bytes);
  try {
    const doc = await store.documents.create(state.sql, kbId, filename, mime, bytes.length, sha256, sourceId, docTime, externalKey);
    await store.documents.recordVersion(state.sql, doc.id, sha256, bytes.length);
    await store.jobs.enqueue(state.sql, "process_document", { document_id: doc.id });
    state.emitDocument(kbId, doc.id);
    return "Created";
  } catch (e) {
    // Identical content already in the KB (e.g. someone uploaded the same file by hand): do not ingest twice.
    if (isAppError(e) && e.kind === "Conflict") return "Unchanged";
    throw e;
  }
}

function configArray(config: unknown, key: string): string[] {
  const v = (config as Record<string, unknown> | null)?.[key];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter((s) => s !== "");
}

function configStr(config: unknown, key: string): string | null {
  const v = (config as Record<string, unknown> | null)?.[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function configBool(config: unknown, key: string): boolean {
  const v = (config as Record<string, unknown> | null)?.[key];
  return v === true;
}

async function syncUrls(state: AppState, source: Source): Promise<SyncStats> {
  const urls = configArray(source.config, "urls");
  if (urls.length === 0) {
    throw new Error("url source is missing config.urls (a list of page URLs)");
  }
  const stats = emptyStats();
  let lastErr: string | null = null;
  for (const url of urls.slice(0, MAX_NEW_PER_SYNC)) {
    try {
      const { filename, mime, bytes } = await fetchPage(url);
      // Logical identity = the URL itself: content changing replaces in place (history lands in the versions table).
      const action = await ingestItem(state, source.kb_id, source.id, url, filename, mime, bytes, null);
      absorb(stats, action);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log.warn("fetch failed", { url, error: message });
      lastErr = `${url}: ${message}`;
    }
  }
  // Partial failure counts as success as long as something got through (the error still reaches the log); total failure is reported.
  if (total(stats) === 0 && lastErr) {
    throw new Error(lastErr);
  }
  // The config list is the whole set: any document not in the list is flagged "not in the source" (a fetch failure does not count — it is still configured).
  await store.documents.reconcileMissing(state.sql, source.id, urls);
  return stats;
}

async function fetchPage(url: string): Promise<{ filename: string; mime: string; bytes: Uint8Array }> {
  const resp = await fetch(url, {
    headers: { "user-agent": UA },
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }
  const mime = (resp.headers.get("content-type") ?? "text/html").split(";")[0]!.trim() || "text/html";
  const bytes = new Uint8Array(await resp.arrayBuffer());
  const filename = filenameFromUrl(url, mime);
  return { filename, mime, bytes };
}

function filenameFromUrl(url: string, mime: string): string {
  const stripped = url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  let slug = [...stripped].map((c) => (/[a-zA-Z0-9.-]/.test(c) ? c : "-")).join("");
  slug = slug.slice(0, 120);
  const hasExt = (() => {
    const ext = slug.split(".").pop();
    return Boolean(ext && ext.length <= 5) && slug.includes(".") && !slug.endsWith(".");
  })();
  return !hasExt || mime.includes("html") ? `${slug}.html` : slug;
}

type FeedEntry = {
  id: string;
  title: string;
  link: string;
  body: string;
  publishedAt: Date | null;
};

/** Minimal RSS 2.0 / Atom parser: pulls only what the sync needs (id, title, link, body, published/updated). */
function parseFeed(xml: string): FeedEntry[] {
  const entries: FeedEntry[] = [];
  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const itemTag = isAtom ? "entry" : "item";
  const re = new RegExp(`<${itemTag}[\\s>]([\\s\\S]*?)<\\/${itemTag}>`, "gi");
  for (const m of xml.matchAll(re)) {
    const block = m[1]!;
    const tag = (name: string): string | null => {
      const r = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i").exec(block);
      return r ? decodeXmlText(r[1]!.trim()) : null;
    };
    const title = tag("title") ?? "untitled";
    let link = "";
    if (isAtom) {
      const linkMatch = /<link\b([^>]*)\/?>/i.exec(block);
      const hrefMatch = linkMatch ? /href="([^"]*)"/i.exec(linkMatch[1]!) : null;
      link = hrefMatch ? hrefMatch[1]! : "";
    } else {
      link = tag("link") ?? "";
    }
    const guid = isAtom ? tag("id") : tag("guid");
    const body = tag("content:encoded") ?? tag("content") ?? tag("description") ?? tag("summary") ?? "";
    const pub = tag("pubDate") ?? tag("published") ?? tag("updated");
    const publishedAt = pub ? new Date(pub) : null;
    entries.push({
      id: guid?.trim() ?? "",
      title,
      link: link.trim(),
      body,
      publishedAt: publishedAt && !Number.isNaN(publishedAt.getTime()) ? publishedAt : null,
    });
  }
  return entries;
}

function decodeXmlText(s: string): string {
  const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(s.trim());
  const inner = cdata ? cdata[1]! : s;
  return inner
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

async function syncRss(state: AppState, source: Source): Promise<SyncStats> {
  const feedUrl = configStr(source.config, "feed_url");
  if (!feedUrl) {
    throw new Error("rss source is missing config.feed_url");
  }
  const resp = await fetch(feedUrl, {
    headers: { "user-agent": UA },
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} fetching feed`);
  }
  const xml = await resp.text();
  const entries = parseFeed(xml);

  const stats = emptyStats();
  for (const entry of entries.slice(0, MAX_NEW_PER_SYNC)) {
    // Logical identity: the feed's own guid (usually already a
    // permalink/urn); fall back to the entry link when missing.
    const key = entry.id !== "" ? entry.id : entry.link !== "" ? entry.link : `entry:${shaHex(new TextEncoder().encode(entry.title))}`;
    const html = `<html><head><title>${entry.title}</title></head><body><h1>${entry.title}</h1>\n<p><a href="${entry.link}">${entry.link}</a></p>\n${entry.body}</body></html>`;
    let slug = [...entry.title].map((c) => (/[a-zA-Z0-9]/.test(c) ? c : "-")).join("");
    slug = slug.slice(0, 80);
    const filename = `${slug}.html`;
    // The entry's publish time -> document time: time-aware extraction reads a real timestamp (this is where this platform's edge comes from).
    const action = await ingestItem(
      state,
      source.kb_id,
      source.id,
      key,
      filename,
      "text/html",
      new TextEncoder().encode(html),
      entry.publishedAt,
    );
    absorb(stats, action);
  }
  return stats;
}

/**
 * GitHub issues: one issue becomes one document, its body carrying its
 * status-change history.
 *
 * `doc_time` uses `updated_at`, not `created_at`: each sync captures
 * "what this issue looks like right now", and cognitive time should say
 * when that state became true. A new comment bumps `updated_at`, so the
 * content changes, a new version is recorded, and `doc_time` moves with
 * it.
 */
async function syncGithubIssues(state: AppState, source: Source): Promise<SyncStats> {
  const repo = configStr(source.config, "repo");
  if (!repo) {
    throw new Error("github_issues source is missing config.repo (owner/name)");
  }
  if (repo.split("/").length !== 2) {
    throw new Error(`config.repo should look like owner/name, got ${JSON.stringify(repo)}`);
  }
  const auth = configStr(source.config, "auth_header");
  // A PR is also an issue in GitHub's data model; excluded by default —
  // asking for "the ticket system" means asking for tickets. The switch
  // exists because some repos keep their decision record in PR
  // descriptions.
  const includePrs = configBool(source.config, "include_pull_requests");

  const base = `https://api.github.com/repos/${repo}`;
  const issueQ: [string, string][] = [["state", "all"]];
  const commentQ: [string, string][] = [];
  if (source.last_sync_at) {
    issueQ.push(["since", source.last_sync_at.toISOString()]);
    commentQ.push(["since", source.last_sync_at.toISOString()]);
  }

  const issues = await githubIssues.fetchAll<githubIssues.Issue>(`${base}/issues`, issueQ, auth);
  const comments = await githubIssues.fetchAll<githubIssues.Comment>(`${base}/issues/comments`, commentQ, auth);

  const stats = emptyStats();
  const grouped = githubIssues
    .groupComments(issues, comments)
    .filter(([issue]) => includePrs || issue.pull_request === undefined)
    .slice(0, MAX_NEW_PER_SYNC);
  for (const [issue, cs] of grouped) {
    // Fetch events per issue. N is only the issues being written this
    // round — the first sync equals the total, and `since` afterward
    // usually narrows it to single digits.
    const events = githubIssues.sortEvents(
      await githubIssues.fetchAll<githubIssues.Event>(`${base}/issues/${issue.number}/events`, [], auth),
    );
    const body = githubIssues.render(issue, cs, events);
    // The logical identity carries the repo: connecting two repos to one KB means #18 does not collide with the other's #18.
    const key = `github:${repo}#${issue.number}`;
    const filename = `${issue.number}-${slugify(issue.title)}.md`;
    const action = await ingestItem(
      state,
      source.kb_id,
      source.id,
      key,
      filename,
      "text/markdown",
      new TextEncoder().encode(body),
      new Date(issue.updated_at),
    );
    absorb(stats, action);
  }
  return stats;
}

/**
 * Jira issues: one issue becomes one document, its body carrying its
 * **field-level** change history.
 *
 * `doc_time` uses `updated`, matching github_issues's same standard.
 */
async function syncJiraIssues(state: AppState, source: Source): Promise<SyncStats> {
  const baseUrl = configStr(source.config, "base_url");
  if (!baseUrl) {
    throw new Error("jira_issues source is missing config.base_url");
  }
  const project = configStr(source.config, "project");
  if (!project) {
    throw new Error("jira_issues source is missing config.project");
  }
  // The project key is spliced directly into JQL, so it cannot be an
  // arbitrary string. Jira's own keys are already limited to
  // alphanumerics and underscore — enforcing that also blocks JQL
  // injection.
  if (!/^[a-zA-Z0-9_]+$/.test(project)) {
    throw new Error(`config.project should be a Jira project key, got ${JSON.stringify(project)}`);
  }
  const auth = configStr(source.config, "auth_header");

  const jqlStr = jiraIssues.jql(project, source.last_sync_at);
  const [issues, total_] = await jiraIssues.fetchAll(baseUrl, jqlStr, auth);
  // **A truncation must be said out loud.** A project running for years
  // easily has tens of thousands of issues; the page cap means this
  // round only covers a slice. Staying silent makes "sync complete" on
  // screen misleading.
  if (total_ > issues.length) {
    log.warn("Jira results were truncated by the page cap; this round only covered part of it, the next JQL window picks up from here", {
      source_id: source.id,
      fetched: issues.length,
      total: total_,
    });
  }

  const stats = emptyStats();
  for (const issue of issues.slice(0, MAX_NEW_PER_SYNC)) {
    const body = jiraIssues.render(issue);
    // The logical identity carries the site: connecting two Jira instances to one KB means PROJ-1 does not collide with the other's PROJ-1.
    const host = (() => {
      try {
        return new URL(baseUrl).host;
      } catch {
        return "jira";
      }
    })();
    const key = `jira:${host}/${issue.key}`;
    const filename = `${issue.key}-${slugify(issue.fields.summary ?? "")}.md`;
    const updated = issue.fields.updated ? jiraIssues.parseJiraTime(issue.fields.updated) : null;
    const action = await ingestItem(
      state,
      source.kb_id,
      source.id,
      key,
      filename,
      "text/markdown",
      new TextEncoder().encode(body),
      updated,
    );
    absorb(stats, action);
  }
  return stats;
}

/** Title -> a filename-safe slug. Same convention as the RSS path (non-alphanumeric becomes -, truncated). */
function slugify(title: string): string {
  let s = [...title].map((c) => (/[a-zA-Z0-9]/.test(c) ? c : "-")).join("");
  s = s.slice(0, 60);
  return s.replace(/^-+|-+$/g, "");
}

/**
 * Custom puller — the Utopia Ingest Interface:
 * `GET {endpoint}?since=<last sync's RFC3339>` (omitted on the first
 * sync; an Authorization header can be configured), responding
 * `{"items":[{"id":"a stable unique id","title":"document name",
 * "content":"body (plain text/Markdown/HTML)","doc_time":"optional
 * RFC3339","mime":"optional, defaults to text/markdown"}]}`.
 * `id` -> `external_key` (`custom:{id}`), so the three-way test applies:
 * same id and same content skips; new content updates in place.
 */
async function syncCustom(state: AppState, source: Source): Promise<SyncStats> {
  const endpoint = configStr(source.config, "endpoint");
  if (!endpoint) {
    throw new Error("custom source is missing config.endpoint");
  }
  const url = new URL(endpoint);
  if (source.last_sync_at) {
    url.searchParams.set("since", source.last_sync_at.toISOString());
  }
  const auth = configStr(source.config, "auth_header");
  const headers: Record<string, string> = { "user-agent": UA };
  if (auth) headers.authorization = auth;
  const resp = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} from endpoint`);
  }
  const body = (await resp.json()) as Record<string, unknown>;
  const items = body.items;
  if (!Array.isArray(items)) {
    throw new Error("Response is missing the items[] array");
  }

  const stats = emptyStats();
  const seenKeys: string[] = [];
  for (const rawItem of items.slice(0, MAX_NEW_PER_SYNC)) {
    const item = rawItem as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (id === "") {
      log.warn("custom item is missing id; skipped", { source_id: source.id });
      continue;
    }
    const content = typeof item.content === "string" ? item.content.trim() : "";
    if (content === "") {
      log.warn("custom item is missing content; skipped", { source_id: source.id, id });
      continue;
    }
    const title = typeof item.title === "string" && item.title.trim() !== "" ? item.title.trim() : id;
    const mime = typeof item.mime === "string" ? item.mime : "text/markdown";
    const docTime = typeof item.doc_time === "string" ? new Date(item.doc_time) : null;
    const filename = ensureExtension(title, mime);
    const key = `custom:${id}`;
    const action = await ingestItem(
      state,
      source.kb_id,
      source.id,
      key,
      filename,
      mime,
      new TextEncoder().encode(content),
      docTime && !Number.isNaN(docTime.getTime()) ? docTime : null,
    );
    absorb(stats, action);
    seenKeys.push(key);
  }
  // An incremental response (`?since=`) missing an item does not mean
  // deleted; no full reconciliation is done. But: 1) an item seen again
  // clears its missing flag (found again after being lost); 2) only an
  // explicit tombstone (`deleted[]`) flags "not in the source" — whether
  // to delete the document is left to the user in the UI.
  if (seenKeys.length > 0) {
    await store.documents.clearMissingKeys(state.sql, source.id, seenKeys);
  }
  const deleted = body.deleted;
  const tombstones = Array.isArray(deleted)
    ? deleted.filter((v): v is string => typeof v === "string").map((id) => `custom:${id.trim()}`)
    : [];
  if (tombstones.length > 0) {
    const n = await store.documents.markMissingKeys(state.sql, source.id, tombstones);
    log.info("custom tombstones: flagged not in the source", { source_id: source.id, count: n });
  }
  return stats;
}

/**
 * Object storage sync: lists objects under a prefix, ingests each one.
 *
 * `externalKey` uses `s3://bucket/key`, the same convention as
 * `file:///` and page URLs: provenance describes itself. A prefix change
 * with unchanged content is recognized by `ingestItem` as a move, not a
 * new document, and does not rerun extraction.
 */
async function syncObjectStorage(state: AppState, source: Source): Promise<SyncStats> {
  const bucket = configStr(source.config, "bucket");
  if (!bucket) {
    throw new Error("s3 source is missing config.bucket");
  }
  const prefix = configStr(source.config, "prefix") ?? undefined;

  const cfg = objectStorage.parseS3Config((source.config as Record<string, unknown>) ?? {});
  const { objects, truncated } = await objectStorage.fetchObjects(cfg, prefix);

  // Reaching the cap is not an error, but it must be said — otherwise
  // "sync succeeded" hides objects that never came in.
  if (truncated) {
    log.warn("object count hit the per-sync cap; the rest is left for the next sync", { bucket, prefix: prefix ?? "" });
  }

  const stats = emptyStats();
  for (const obj of objects) {
    // Do not guess the mime type: ingest's own parser checks magic bytes
    // first, then the extension, and falls back to decoding as text.
    // Guessing here by filename would just be one more source that can
    // lie. `application/octet-stream` is honest: it says we only have a
    // string of bytes and have not looked inside.
    const action = await ingestItem(
      state,
      source.kb_id,
      source.id,
      obj.externalKey,
      obj.filename,
      "application/octet-stream",
      obj.bytes,
      obj.lastModified,
    );
    absorb(stats, action);
  }
  return stats;
}

/** Adds an extension based on mime when the title has none, so the parsing matrix can dispatch it. */
function ensureExtension(title: string, mime: string): string {
  const ext = title.split(".").pop();
  const hasExt = Boolean(ext && ext.length >= 2 && ext.length <= 5 && !ext.includes(" ")) && title.includes(".");
  if (hasExt) return title;
  const suffix = mime.includes("html") ? "html" : mime.includes("plain") ? "txt" : "md";
  return `${title}.${suffix}`;
}

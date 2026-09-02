/**
 * Jira issue source: one issue becomes one document, with its
 * **field-level** change history written into the body.
 *
 * Same judgment as `github_issues` (fetch the change, not the current
 * value), but Jira hands over stronger material at a lower cost. One
 * call — `GET /rest/api/2/search?jql=…&expand=changelog` — returns the
 * issue body, the full change history, and the comments together, with
 * no N+1.
 *
 * Jira's history is field-level: instead of "a labeled event happened",
 * it says "field X changed from A to B" — better raw material for the
 * ledger, since from/to are already the two ends of one cognitive
 * change.
 *
 * There is no `since` parameter; the incremental window is expressed in
 * JQL instead: `updated >= "…"`, using Jira's own time format (not
 * RFC3339), quoted.
 *
 * This module targets API v2 (Jira Server/DC). Cloud's v3 renders
 * `description` and comment bodies as ADF (a JSON tree, not a plain
 * string), which needs its own renderer — out of scope until an
 * instance that only speaks v3 shows up.
 */

const MAX_PAGES = 10;
const PAGE_SIZE = 50;

/** Fields wanted. Must be listed explicitly: omitting `comment` drops comments from the response, and the unfiltered default response runs into hundreds of KB per issue. */
const FIELDS =
  "summary,status,issuetype,priority,created,updated,resolutiondate,labels,assignee,reporter,description,comment";

export type Named = { name: string | null };
export type JiraUser = { displayName?: string | null };
export type Comment = { author?: JiraUser | null; created?: string | null; body?: string | null };
export type ChangeItem = { field?: string | null; fromString?: string | null; toString?: string | null };
export type History = { created?: string | null; author?: JiraUser | null; items?: ChangeItem[] };
export type Changelog = { histories?: History[] };
export type Fields = {
  summary?: string | null;
  description?: string | null;
  created?: string | null;
  updated?: string | null;
  resolutiondate?: string | null;
  status?: Named | null;
  issuetype?: Named | null;
  priority?: Named | null;
  assignee?: JiraUser | null;
  reporter?: JiraUser | null;
  labels?: string[];
  comment?: { comments?: Comment[] } | null;
};
export type Issue = {
  key: string;
  fields: Fields;
  /** Present only when the request used `expand=changelog`. */
  changelog?: Changelog | null;
};
export type SearchPage = { issues: Issue[]; total: number };

/**
 * Parses a Jira timestamp such as `2026-08-24T11:11:52.944+0000`
 * (no colon in the offset — not RFC3339) into a `Date`. Also accepts a
 * real RFC3339 string, since some Cloud endpoints return that shape.
 */
export function parseJiraTime(s: string): Date | null {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?)([+-]\d{2}):?(\d{2})$/.exec(s);
  if (m) {
    const [, body, offH, offM] = m;
    const iso = `${body}${offH}:${offM}`;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function name(n: Named | null | undefined): string | null {
  return n?.name ?? null;
}

function who(u: JiraUser | null | undefined): string {
  return u?.displayName ?? "?";
}

/** Lays out one issue as one document. A pure function, no network calls — fetching and layout are kept apart so layout stays testable. */
export function render(issue: Issue): string {
  const f = issue.fields;
  const out: string[] = [];
  out.push(`# ${issue.key} ${f.summary ?? ""}\n`);

  // The header is written as dated sentences, not key/value pairs: the
  // extractor reads sentences. "Reported by X on 2026-08-24" yields a
  // fact with a valid_from.
  if (f.reporter && f.created) {
    const created = parseJiraTime(f.created);
    if (created) out.push(`Reported by ${who(f.reporter)} on ${ymd(created)}.`);
  }
  const issueType = name(f.issuetype);
  if (issueType) out.push(`Type ${issueType}.`);
  const status = name(f.status);
  if (status) out.push(`Currently ${status}.`);
  const priority = name(f.priority);
  if (priority) out.push(`Priority ${priority}.`);
  if (f.assignee) out.push(`Assigned to ${f.assignee.displayName ?? "?"}.`);
  if (f.resolutiondate) {
    const resolved = parseJiraTime(f.resolutiondate);
    if (resolved) out.push(`Resolved on ${ymd(resolved)}.`);
  }
  if (f.labels && f.labels.length > 0) out.push(`Labelled ${f.labels.join(", ")}.`);

  const description = f.description?.trim();
  if (description) {
    out.push("\n## Description\n");
    out.push(description);
  }

  // Field-level change history: this is Jira's extra, over GitHub — not
  // just "an event happened" but "which field changed from what to
  // what," the two ends of one cognitive change.
  const lines: [Date, string][] = [];
  for (const h of issue.changelog?.histories ?? []) {
    if (!h.created) continue;
    const at = parseJiraTime(h.created);
    if (!at) continue;
    for (const item of h.items ?? []) {
      if (!item.field) continue;
      const from = item.fromString ?? "(empty)";
      const to = item.toString ?? "(empty)";
      lines.push([at, `- ${ymd(at)} — ${who(h.author)} changed ${item.field}: ${from} → ${to}`]);
    }
  }
  if (lines.length > 0) {
    // The endpoint's order is not a contract; sort here — getting it
    // wrong tells the history backwards.
    lines.sort((a, b) => a[0].getTime() - b[0].getTime());
    out.push("\n## History\n");
    for (const [, l] of lines) out.push(l);
  }

  const comments = f.comment?.comments ?? [];
  if (comments.length > 0) {
    out.push("\n## Comments\n");
    for (const c of comments) {
      const body = c.body?.trim() ?? "";
      if (body === "") continue;
      const at = c.created ? parseJiraTime(c.created) : null;
      out.push(`### ${who(c.author)} on ${at ? ymd(at) : "?"}\n`);
      out.push(body);
      out.push("");
    }
  }
  return out.join("\n") + "\n";
}

/**
 * Builds the incremental JQL. The time format is Jira's own
 * (`yyyy-MM-dd HH:mm`), not RFC3339, and must be quoted — either mistake
 * fails with a 400, not "no results".
 */
export function jql(project: string, since: Date | null): string {
  let q = `project = ${project}`;
  if (since) {
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${since.getUTCFullYear()}-${pad(since.getUTCMonth() + 1)}-${pad(since.getUTCDate())} ${pad(
      since.getUTCHours(),
    )}:${pad(since.getUTCMinutes())}`;
    q += ` AND updated >= "${stamp}"`;
  }
  q += " ORDER BY updated ASC";
  return q;
}

/**
 * Pages through search results. Jira uses `startAt`/`maxResults`, and
 * `total` is often in the tens of thousands — capped by `MAX_PAGES`, the
 * rest waits for the next incremental window.
 *
 * `total` is returned alongside the issues: a truncated fetch must say
 * so. Getting back 500 of 14506 and calling it "sync complete" would be
 * misleading — what really happened is "this round only covered a
 * slice".
 */
export async function fetchAll(
  baseUrl: string,
  jqlStr: string,
  auth: string | null,
): Promise<[Issue[], number]> {
  const out: Issue[] = [];
  let total = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(`${baseUrl.replace(/\/+$/, "")}/rest/api/2/search`);
    url.searchParams.set("jql", jqlStr);
    url.searchParams.set("expand", "changelog");
    url.searchParams.set("fields", FIELDS);
    url.searchParams.set("maxResults", String(PAGE_SIZE));
    url.searchParams.set("startAt", String(page * PAGE_SIZE));
    const headers: Record<string, string> = { accept: "application/json" };
    if (auth) headers.authorization = auth;
    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      // Jira reports a bad JQL as a 400 too; the reason is in the body.
      // "HTTP 400" alone sends someone to check the network, when the
      // real fix is the project key or the time format.
      const detail = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status} from Jira: ${detail.slice(0, 200)}`);
    }
    const page_ = (await resp.json()) as SearchPage;
    total = page_.total;
    out.push(...page_.issues);
    if (page_.issues.length < PAGE_SIZE) break;
  }
  return [out, total];
}

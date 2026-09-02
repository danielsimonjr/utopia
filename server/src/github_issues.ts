/**
 * GitHub issue source: one issue becomes one document, with its status
 * history written into the body.
 *
 * The most valuable part of an issue is not "it is currently closed" but
 * "it opened on Aug 18, closed on Aug 20, and was reassigned and
 * relabeled in between." Fetching only the current state means that
 * timeline has to be pieced together sync by sync — the first sync only
 * sees the present moment; everything before it is lost. Fetch the
 * change, not the current value.
 *
 * Comments are fetched repo-wide; events are fetched per issue. This is
 * not an inconsistency — the two endpoints differ in capability:
 * `issues/comments` supports `since` (one page fetches every comment in
 * the window); `issues/events` does not support `since`, and PRs also
 * produce issue events, so on an active repo the real issue events get
 * pushed past the page cap and the status history silently comes back
 * empty. Fetching events per issue avoids this. The N+1 cost is real,
 * but N is only the number of issues touched this round: on the first
 * sync it equals the whole repo, and afterwards `since` usually narrows
 * it to single digits.
 */

export type Label = { name: string };
export type Actor = { login: string };

export type Issue = {
  number: number;
  title: string;
  state: string;
  body: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  labels: Label[];
  assignees: Actor[];
  user: Actor | null;
  /** Present only when this row is actually a pull request (GitHub stores both in the same table). */
  pull_request?: unknown;
};

export type Comment = {
  /** Which issue this comment is on: only the URL carries the number, parsed from the tail of `.../issues/18`. */
  issue_url: string;
  user: Actor | null;
  created_at: string;
  body: string | null;
};

export type Event = {
  event: string;
  created_at: string;
  actor: Actor | null;
  label: Label | null;
  assignee: Actor | null;
};

const MAX_PAGES = 10;
const PER_PAGE = 100;

function issueNumberFromUrl(url: string): number | null {
  const tail = url.split("/").pop();
  if (!tail) return null;
  const n = Number(tail);
  return Number.isInteger(n) ? n : null;
}

function ymd(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Lays out one issue, together with its comments and events, as one
 * document.
 *
 * A pure function, no network calls — fetching and layout are kept
 * apart so the layout half stays testable.
 */
export function render(issue: Issue, comments: Comment[], events: Event[]): string {
  const out: string[] = [];
  out.push(`# #${issue.number} ${issue.title}\n`);

  // The header is written as dated sentences, not key/value pairs: the
  // extractor reads sentences. "opened by X on 2026-08-18" yields a fact
  // with a valid_from; "created_at: 2026-08-18" makes it guess.
  if (issue.user) {
    out.push(`Opened by ${issue.user.login} on ${ymd(issue.created_at)}.`);
  }
  out.push(`Currently ${issue.state}.`);
  if (issue.closed_at) {
    out.push(`Closed on ${ymd(issue.closed_at)}.`);
  }
  if (issue.labels.length > 0) {
    out.push(`Labelled ${issue.labels.map((l) => l.name).join(", ")}.`);
  }
  if (issue.assignees.length > 0) {
    out.push(`Assigned to ${issue.assignees.map((a) => a.login).join(", ")}.`);
  }

  const body = issue.body?.trim();
  if (body) {
    out.push("\n## Description\n");
    out.push(body);
  }

  // The status history is why this source exists. Every line carries a
  // date, so the ledger gets "what changed when", not a frozen snapshot.
  if (events.length > 0) {
    out.push("\n## History\n");
    for (const e of events) {
      const who = e.actor?.login ?? "?";
      let detail = "";
      if ((e.event === "labeled" || e.event === "unlabeled") && e.label) {
        detail = ` (${e.label.name})`;
      } else if ((e.event === "assigned" || e.event === "unassigned") && e.assignee) {
        detail = ` (${e.assignee.login})`;
      }
      out.push(`- ${ymd(e.created_at)} — ${e.event} by ${who}${detail}`);
    }
  }

  if (comments.length > 0) {
    out.push("\n## Comments\n");
    for (const c of comments) {
      const who = c.user?.login ?? "?";
      const cBody = c.body?.trim() ?? "";
      if (cBody === "") continue;
      out.push(`### ${who} on ${ymd(c.created_at)}\n`);
      out.push(cBody);
      out.push("");
    }
  }
  return out.join("\n") + "\n";
}

/**
 * Groups repo-wide comments by issue number, each ascending by time.
 *
 * Comments are fetched repo-wide, and include ones outside this sync's
 * issue set (a different incremental window). A comment that cannot be
 * matched to an issue is dropped — it comes back with its own issue on
 * a later sync.
 */
export function groupComments(issues: Issue[], comments: Comment[]): [Issue, Comment[]][] {
  const byIssue = new Map<number, Comment[]>();
  for (const c of comments) {
    const n = issueNumberFromUrl(c.issue_url);
    if (n === null) continue;
    const list = byIssue.get(n);
    if (list) list.push(c);
    else byIssue.set(n, [c]);
  }
  return issues.map((issue) => {
    const cs = (byIssue.get(issue.number) ?? []).slice();
    cs.sort((a, b) => a.created_at.localeCompare(b.created_at));
    return [issue, cs];
  });
}

/**
 * Sorts events ascending by time. The per-issue endpoint's order
 * **looks** ascending, but the order is not a contract, and getting it
 * wrong tells the history backwards.
 */
export function sortEvents(events: Event[]): Event[] {
  return [...events].sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** Pages one endpoint until an empty page or the page cap. */
export async function fetchAll<T>(
  base: string,
  query: [string, string][],
  auth: string | null,
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = new URL(base);
    for (const [k, v] of query) url.searchParams.append(k, v);
    url.searchParams.set("per_page", String(PER_PAGE));
    url.searchParams.set("page", String(page));
    const headers: Record<string, string> = {};
    if (auth) headers.authorization = auth;
    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      const remaining = resp.headers.get("x-ratelimit-remaining") ?? "?";
      if (resp.status === 403 && remaining === "0") {
        throw new Error(
          "GitHub is rate limiting this hour's quota. Unauthenticated requests get 60/hour; configure a token to raise it to 5000",
        );
      }
      throw new Error(`HTTP ${resp.status} from GitHub`);
    }
    const batch = (await resp.json()) as T[];
    out.push(...batch);
    if (batch.length < PER_PAGE) break;
  }
  return out;
}

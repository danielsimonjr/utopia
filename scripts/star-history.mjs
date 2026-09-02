#!/usr/bin/env node
/* The star history chart: a single line of the cumulative star count over time. This
 * script draws nothing else.
 *
 * Why this script exists. An earlier version used `lowlighter/metrics`. That action
 * ties the cumulative total chart and the daily new-stars chart **to one setting**
 * (`plugin_stargazers_charts`), with no way to render only one of the two. This project
 * wants only the traditional cumulative line.
 *
 * Writing this script also removed a risk: that action was third-party code running
 * under `contents: write`. Now this script runs under that permission instead.
 *
 * **On 2026-06-30, GitHub restricted the star timeline to repository admins and
 * collaborators.** This script must send a token with that access. An anonymous call
 * can no longer read this data, so a site such as star-history.com now returns only a
 * placeholder image.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const [owner, repo] = (process.env.REPO ?? "").split("/");
const token = process.env.GITHUB_TOKEN;
const out = process.env.OUT ?? "assets/star-history.svg";
if (!owner || !repo) throw new Error("REPO must be set as owner/name");
if (!token) throw new Error("GITHUB_TOKEN must be set");

/** This fetches 100 stars per page and follows the cursor to the end. 1,868 stars is
 * 19 pages, too few to be worth adding concurrency.
 *
 * **This uses GraphQL, not REST.** The REST endpoint `/repos/{o}/{r}/stargazers`
 * returns 404 with this same token, because that endpoint requires a repository-level
 * scope, and this token holds only `read:org`. GitHub returns 404, not 403, for a
 * resource the token cannot access, so it does not reveal whether the resource exists.
 * The GraphQL `stargazers` connection accepts this token; this was verified in CI.
 * Fixing this here is safer than widening the token's scope to fit one endpoint. */
async function stargazerDates() {
  /* `viewerPermission` and `totalCount` are not decoration. **When access is
     restricted, GitHub returns an empty collection, not an error.** Reading only
     `edges` would make "no access" and "genuinely zero stars" look identical. This
     fetches both fields, so a failure can state which case occurred. */
  const query = `query($owner:String!,$name:String!,$cursor:String){
    repository(owner:$owner,name:$name){
      stargazerCount
      viewerPermission
      stargazers(first:100,after:$cursor,orderBy:{field:STARRED_AT,direction:ASC}){
        totalCount
        pageInfo{hasNextPage endCursor}
        edges{starredAt}
      }
    }
  }`;
  const dates = [];
  let cursor = null;
  for (let page = 1; page <= 400; page++) {
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": `${owner}-star-history`,
      },
      body: JSON.stringify({ query, variables: { owner, name: repo, cursor } }),
    });
    if (!res.ok) {
      throw new Error(`graphql page ${page}: ${res.status} ${await res.text()}`);
    }
    const body = await res.json();
    // **GraphQL returns 200 even on error,** so this code must check `errors` itself.
    // Without this check, the failure would surface later as an undefined value, by
    // which point the original error message would be lost.
    if (body.errors) {
      throw new Error(`graphql page ${page}: ${JSON.stringify(body.errors)}`);
    }
    const node = body.data?.repository;
    const conn = node?.stargazers;
    if (!conn) throw new Error(`graphql page ${page}: no stargazers in response`);
    if (page === 1) {
      console.log(
        `repo sees ${node.stargazerCount} stars; connection reports ` +
          `${conn.totalCount}; token permission = ${node.viewerPermission}`,
      );
    }
    for (const e of conn.edges) if (e.starredAt) dates.push(new Date(e.starredAt));
    if (!conn.pageInfo.hasNextPage) return dates;
    cursor = conn.pageInfo.endCursor;
  }
  return dates;
}

const dates = (await stargazerDates()).sort((a, b) => a - b);
if (dates.length === 0) {
  // The log line above already states the repo's star count, the connection's count,
  // and the token's permission level. **This must not silently render an empty
  // chart.** A chart showing zero stars is worse than no chart at all.
  throw new Error(
    "no stargazer timestamps came back — see the line above for what the API " +
      "reported. An empty connection with a non-zero star count means the token " +
      "cannot read the stargazer timeline (restricted to admins and collaborators " +
      "since 2026-06-30).",
  );
}

/* This aggregates the data into a cumulative value per day. **Every day gets a point,
   even a day with no new stars.** Skipping a gap day would break the x-axis spacing as
   a measure of time, and the curve's slope would then be misleading. */
const DAY = 86400000;
const day0 = Date.UTC(
  dates[0].getUTCFullYear(),
  dates[0].getUTCMonth(),
  dates[0].getUTCDate(),
);
const today = Date.now();
const perDay = new Map();
for (const d of dates) {
  const k = Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - day0) / DAY);
  perDay.set(k, (perDay.get(k) ?? 0) + 1);
}
const lastDay = Math.floor((today - day0) / DAY);
const series = [];
let total = 0;
for (let k = 0; k <= lastDay; k++) {
  total += perDay.get(k) ?? 0;
  series.push({ t: day0 + k * DAY, v: total });
}

// ---- Rendering
const W = 800, H = 400;
/* This leaves more top margin than the other sides, because the label for the last
   point sits above it, and **the last point is always at the top.** The cumulative
   value never decreases, so the last point is always the maximum. */
const PAD = { top: 40, right: 28, bottom: 40, left: 64 };
const plotW = W - PAD.left - PAD.right;
const plotH = H - PAD.top - PAD.bottom;
const maxV = series[series.length - 1].v;
const x = (i) => PAD.left + (plotW * i) / Math.max(1, series.length - 1);
const y = (v) => PAD.top + plotH - (plotH * v) / Math.max(1, maxV);

/** Picks round numbers for the axis ticks, instead of a value such as max/5 that
 * could carry a decimal fraction. */
function ticks(max, count = 5) {
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;
  const out = [];
  for (let v = 0; v <= max; v += step) out.push(Math.round(v));
  return out;
}
const fmtDate = (t) =>
  new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** Smooths the line into a cubic Bezier curve, using **monotonic** interpolation
 * (the Fritsch–Carlson method).
 *
 * This does not use a plain Catmull-Rom spline. The cumulative star count only rises;
 * it never falls. A plain spline would overshoot at a sharp change in slope and draw a
 * dip, **which would show the chart claiming stars were lost.** Monotonic
 * interpolation bounds each segment's tangent within a range that creates no new
 * local maximum or minimum, so the curve never turns backward.
 *
 * On a flat run of days with zero new stars, the tangent is zero, so the curve does
 * not bulge where it connects to a flat segment. */
function smoothPath(pts) {
  const n = pts.length;
  if (n < 2) return `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  // The slope of each segment
  const dx = [], dy = [], slope = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1].x - pts[i].x);
    dy.push(pts[i + 1].y - pts[i].y);
    slope.push(dy[i] / dx[i]);
  }
  // The tangent at each point. It is zero when the two adjacent segments have
  // opposite signs, or when one segment is flat; that is the condition for no
  // overshoot.
  const m = [slope[0]];
  for (let i = 1; i < n - 1; i++) {
    m.push(slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2);
  }
  m.push(slope[n - 2]);
  // The Fritsch–Carlson step: bounds each tangent to at most three times its
  // segment's slope.
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / slope[i];
    const b = m[i + 1] / slope[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = (3 / Math.sqrt(s)) * slope[i];
      m[i] = t * a;
      m[i + 1] = t * b;
    }
  }
  let d = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d +=
      `C${(pts[i].x + h).toFixed(1)},${(pts[i].y + m[i] * h).toFixed(1)} ` +
      `${(pts[i + 1].x - h).toFixed(1)},${(pts[i + 1].y - m[i + 1] * h).toFixed(1)} ` +
      `${pts[i + 1].x.toFixed(1)},${pts[i + 1].y.toFixed(1)}`;
  }
  return d;
}

const pts = series.map((p, i) => ({ x: x(i), y: y(p.v) }));
const line = smoothPath(pts);
const area = `${line}L${x(series.length - 1).toFixed(1)},${(PAD.top + plotH).toFixed(1)}L${x(0).toFixed(1)},${(PAD.top + plotH).toFixed(1)}Z`;

/* The last point and its value label. **This right-aligns the text when the point
   sits close to the right edge.** Otherwise a four-digit number would extend past the
   canvas edge. SVG does not clip that text; it simply disappears. */
const endX = x(series.length - 1);
const endY = y(maxV);
const endAnchor = endX > W - PAD.right - 40 ? "end" : "middle";

const xTickIdx = [...new Set(
  Array.from({ length: 6 }, (_, i) => Math.round((i * (series.length - 1)) / 5)),
)];

/* This writes two files, one dark and one light. The README's `<picture>` element
 * picks between them based on the active theme.
 *
 * **A white line is invisible against the light theme,** because GitHub's light
 * background is also white. Rendering white requires two separate files. Writing
 * `prefers-color-scheme` inside the SVG does not work, because the README loads the
 * SVG as a plain image, and that media query asks the operating system, not GitHub's
 * theme setting. A user whose OS theme and GitHub theme differ would see a blank
 * chart. The `<picture>` element asks GitHub's own theme setting instead. */
const THEMES = {
  dark: { ink: "#8b949e", accent: "#ffffff", grid: "#8b949e33" },
  light: { ink: "#6e7781", accent: "#1f2328", grid: "#6e778133" },
};

function render({ ink, accent, grid }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">
<defs><linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
<stop offset="0%" stop-color="${accent}" stop-opacity="0.22"/>
<stop offset="100%" stop-color="${accent}" stop-opacity="0"/>
</linearGradient></defs>
<text x="${PAD.left}" y="24" fill="${ink}" font-size="13">${owner}/${repo}</text>
${ticks(maxV).map((v) => `<g><line x1="${PAD.left}" y1="${y(v).toFixed(1)}" x2="${W - PAD.right}" y2="${y(v).toFixed(1)}" stroke="${grid}"/><text x="${PAD.left - 10}" y="${(y(v) + 4).toFixed(1)}" fill="${ink}" font-size="11" text-anchor="end">${v.toLocaleString("en-US")}</text></g>`).join("")}
${xTickIdx.map((i) => `<text x="${x(i).toFixed(1)}" y="${H - 16}" fill="${ink}" font-size="11" text-anchor="middle">${fmtDate(series[i].t)}</text>`).join("")}
<path d="${area}" fill="url(#fill)"/>
<path d="${line}" fill="none" stroke="${accent}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
<circle cx="${endX.toFixed(1)}" cy="${endY.toFixed(1)}" r="3.5" fill="${accent}"/>
<text x="${endX.toFixed(1)}" y="${(endY - 12).toFixed(1)}" fill="${accent}" font-size="14" font-weight="600" text-anchor="${endAnchor}">${maxV.toLocaleString("en-US")}</text>
</svg>
`;
}

mkdirSync(dirname(out), { recursive: true });
const lightOut = out.replace(/\.svg$/, "-light.svg");
writeFileSync(out, render(THEMES.dark));
writeFileSync(lightOut, render(THEMES.light));
console.log(`${series.length} days, ${maxV} stars → ${out} + ${lightOut}`);

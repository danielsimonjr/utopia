/* Built-in docs: bundled with the app, so they work offline in a private
   deployment, and their version always matches the deployment version.
   This is a public route: it does not depend on a session, so a reader
   can view it before login. An engineer integrating with the API may not have an account yet. */
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { Command, Search } from "lucide-react";
import { api } from "../api";
import { S } from "../i18n";
import { GithubMark, SectionMark } from "../ui";
import { UserMenu } from "./UserMenu";
import { usePageTitle } from "../useTitle";
import ingestMd from "../docs/ingest.md?raw";

/** The doc list: each slug maps to a title and content, bundled at build time. */
const DOCS: { slug: string; title: string; body: string }[] = [
  { slug: "ingest", title: "Ingest interfaces", body: ingestMd },
];

/** Full-text search, run on the client, since the docs are already in
 *  the bundle. Each match returns the document and a snippet centered on the matched term. */
function searchDocs(q: string): { slug: string; title: string; snippet: string }[] {
  const needle = q.trim().toLowerCase();
  if (needle.length < 2) return [];
  const hits: { slug: string; title: string; snippet: string }[] = [];
  for (const d of DOCS) {
    for (const line of d.body.split("\n")) {
      const cleaned = line.replace(/[#`*|>-]/g, " ").replace(/\s+/g, " ").trim();
      const idx = cleaned.toLowerCase().indexOf(needle);
      if (idx < 0) continue;
      // The snippet window centers on the matched term, so a 90-character truncation never cuts off the match itself.
      const start = Math.max(0, idx - 30);
      const snippet = (start > 0 ? "…" : "") + cleaned.slice(start, start + 100);
      hits.push({ slug: d.slug, title: d.title, snippet });
      if (hits.length >= 8) return hits;
    }
  }
  return hits;
}

/** Highlights the matched term inside a snippet, case-insensitively, marking every match. */
function Highlighted({ text, q }: { text: string; q: string }) {
  const needle = q.trim();
  if (!needle) return <>{text}</>;
  const parts = text.split(new RegExp(`(${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig"));
  return (
    <>
      {parts.map((p, i) =>
        p.toLowerCase() === needle.toLowerCase() ? (
          /* The matched term uses a warning-amber color, so a reader can spot the match in the results list at a glance. */
          <mark
            key={i}
            className="rounded-[3px] bg-[rgba(242,182,109,0.16)] px-0.5 text-[var(--u-warn)]"
          >
            {p}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

/** Converts a heading to an anchor id. The table of contents and the body use this same function, so their ids always match. */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, "-")
    .replace(/(^-+|-+$)/g, "");
}

/** Converts React children to plain text. An h2 or h3 heading may nest a `code` or `strong` element. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function textOf(children: any): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map(textOf).join("");
  if (children && typeof children === "object" && "props" in children)
    return textOf(children.props.children);
  return "";
}

/** Extracts an h2/h3 table of contents from the markdown source. */
function tocOf(body: string): { id: string; text: string; level: 2 | 3 }[] {
  const out: { id: string; text: string; level: 2 | 3 }[] = [];
  for (const line of body.split("\n")) {
    const m = /^(#{2,3})\s+(.+)$/.exec(line);
    if (!m) continue;
    const text = m[2].replace(/[`*]/g, "").trim();
    out.push({ id: slugify(text), text, level: m[1].length as 2 | 3 });
  }
  return out;
}

const IS_MAC = navigator.platform.toUpperCase().includes("MAC");

export function DocsPage() {
  const { slug } = useParams({ from: "/docs/$slug" });
  const doc = DOCS.find((d) => d.slug === slug) ?? DOCS[0];
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const searchRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const results = searchDocs(q);
  const toc = tocOf(doc.body);
  const mainRef = useRef<HTMLElement>(null);
  const [activeHeading, setActiveHeading] = useState<string | null>(null);
  // Title: `Utopia | {article name}`. "Charter" is the section wordmark, and the page title names the article directly.
  usePageTitle(S.app.name, doc.title);
  // This public page still checks the login state: a signed-in user sees the user menu, and a signed-out user sees "Sign in".
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, retry: false });
  const health = useQuery({ queryKey: ["health"], queryFn: api.health, staleTime: Infinity });

  // Scroll spy: the current section is the nearest heading above the
  // viewport's top edge. At the bottom of the scroll, this forces the
  // last section active, because a short final section might never cross the threshold line.
  const onScrollSpy = () => {
    const main = mainRef.current;
    if (!main) return;
    const top = main.getBoundingClientRect().top;
    let current: string | null = null;
    for (const h of toc) {
      const el = document.getElementById(h.id);
      if (el && el.getBoundingClientRect().top - top <= 96) current = h.id;
    }
    if (main.scrollTop + main.clientHeight >= main.scrollHeight - 8 && toc.length)
      current = toc[toc.length - 1].id;
    setActiveHeading(current);
  };

  useEffect(() => {
    if (!q) return;
    const onDown = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) setQ("");
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setQ("");
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [q]);

  // Keyboard shortcut to open search: Cmd+K or Ctrl+K works at any time.
  // The `/` shortcut only works when focus is not in a text field, so it does not interrupt typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      const typing =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLElement && el.isContentEditable);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      } else if (e.key === "/" && !typing) {
        e.preventDefault();
        inputRef.current?.focus();
      } else if (e.key === "Escape" && el === inputRef.current) {
        inputRef.current?.blur();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <header className="glass-strong relative z-40 border-x-0 border-t-0 h-14 shrink-0 flex items-center px-5">
        <SectionMark text={S.docs.brand} title={S.docs.backTitle} />
        {/* Centered search: this searches all locally bundled docs. Its
            width matches the body column (`max-w-3xl` minus `px-8`). */}
        <div
          ref={searchRef}
          className="absolute left-1/2 -translate-x-1/2 w-[min(44rem,55vw)]"
        >
          <div className="relative">
            <Search
              size={13}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500 pointer-events-none"
            />
            <input
              ref={inputRef}
              className="input-dark w-full pr-14 py-1.5 text-[13px]"
              style={{ paddingLeft: "2.1rem" }}
              placeholder={S.docs.searchPlaceholder}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            {/* Shortcut hint: this stays out of the way while typing. On
                Mac, it uses a lucide icon for Cmd. Ctrl has no standard
                icon, unlike the Mac-only Cmd symbol, so Windows shows the word "Ctrl" instead. */}
            {!q && (
              <kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 flex items-center gap-1 rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-sans text-[10px] text-neutral-600">
                {IS_MAC ? <Command size={9} /> : <span>Ctrl</span>}
                <span>K</span>
              </kbd>
            )}
          </div>
          {q.trim().length >= 2 && (
            <div className="u-pop u-pop-in u-pop-in-tl absolute inset-x-0 top-full mt-2 rounded-xl shadow-2xl overflow-hidden">
              {results.length === 0 ? (
                <p className="px-3.5 py-3 text-xs text-neutral-500">{S.docs.noResults}</p>
              ) : (
                results.map((r, i) => (
                  <button
                    key={i}
                    onClick={() => {
                      setQ("");
                      navigate({ to: "/docs/$slug", params: { slug: r.slug } });
                    }}
                    className="w-full text-left px-3.5 py-2.5 hover:bg-white/[0.06] border-b border-white/5 last:border-0"
                  >
                    <div className="text-[11px] text-neutral-500">{r.title}</div>
                    <div className="text-[13px] text-neutral-200 truncate">
                      <Highlighted text={r.snippet} q={q} />
                    </div>
                  </button>
                ))
              )}
            </div>
          )}
        </div>

        {/* Right side: an explicit back link (a second way to return home,
            besides the wordmark), a GitHub and version pill, and the login state. */}
        <div className="ml-auto flex items-center gap-1.5">
          <Link
            to="/"
            className="px-2 py-1 rounded-lg text-[12.5px] text-neutral-500 hover:text-neutral-200 hover:bg-white/[0.05] transition-colors"
          >
            {S.account.backToApp}
          </Link>
          <a
            href={S.login.githubUrl}
            target="_blank"
            rel="noreferrer"
            title="GitHub"
            className="flex items-center gap-1.5 rounded-full border border-white/10 px-2.5 py-1 text-neutral-500 hover:text-neutral-200 hover:border-white/25 transition-colors"
          >
            <GithubMark size={13} />
            {health.data && <span className="u-num text-[11px]">v{health.data.version}</span>}
          </a>
          {me.data ? (
            <div className="ml-1">
              <UserMenu user={me.data} />
            </div>
          ) : me.isError ? (
            <Link
              to="/login"
              className="u-btn u-btn-ghost px-3 py-1.5 text-xs"
            >
              {S.login.signIn}
            </Link>
          ) : null}
        </div>
      </header>

      {/* The whole page scrolls, with the scrollbar against the window's
          right edge, and the side rails stay sticky. This matches a standard docs site layout. */}
      <main
        ref={mainRef}
        onScroll={onScrollSpy}
        className="flex-1 min-h-0 overflow-y-auto u-scroll"
      >
        <div className="flex items-start">
          <aside className="w-64 shrink-0 sticky top-0 h-[calc(100vh-3.5rem)] glass-strong border-y-0 border-l-0 p-3 space-y-0.5">
            {DOCS.map((d) => (
              <Link
                key={d.slug}
                to="/docs/$slug"
                params={{ slug: d.slug }}
                className={`block rounded-lg px-3 py-2 text-[13px] ${
                  d.slug === doc.slug
                    ? "u-nav-active"
                    : "text-neutral-400 hover:bg-white/[0.05] hover:text-neutral-200"
                }`}
              >
                {d.title}
              </Link>
            ))}
          </aside>

          {/* Enough space stays above and below the content: the heading
              does not touch the top, and the last section can scroll to
              the middle of the screen, where a reader's eyes rest.
              Typography comes from the official @tailwindcss/typography
              plugin (`prose`, at a 16px base size). The only custom
              additions are: heading anchor ids, opening external links in
              a new tab, and a horizontal scroll container for tables. */}
          {/* This uses `prose-neutral`, because the default gray scale has
              a slight blue tint (258 degrees in oklch), which would
              violate the "no color bias in UI chrome" rule. */}
          <article className="prose prose-neutral prose-invert prose-headings:scroll-mt-6 prose-code:before:content-none prose-code:after:content-none flex-1 min-w-0 max-w-3xl mx-auto px-8 pt-16 pb-[40vh]">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                h2: ({ children, ...p }) => (
                  <h2 id={slugify(textOf(children))} {...p}>
                    {children}
                  </h2>
                ),
                h3: ({ children, ...p }) => (
                  <h3 id={slugify(textOf(children))} {...p}>
                    {children}
                  </h3>
                ),
                a: (p) => <a target="_blank" rel="noreferrer" {...p} />,
                // This does not add `u-scroll`: `overscroll-contain` would trap vertical scrolling inside this block, and the page could not scroll.
                table: (p) => (
                  <div className="overflow-x-auto">
                    <table {...p} />
                  </div>
                ),
              }}
            >
              {doc.body}
            </ReactMarkdown>
          </article>

          {/* The right-side table of contents stays sticky, and starts at the same horizontal line as the body heading. */}
          {toc.length > 0 && (
            <aside className="hidden lg:block w-64 shrink-0 sticky top-0 pt-16 pr-8">
              <nav className="space-y-0.5">
                {toc.map((h) => (
                  <button
                    key={h.id}
                    onClick={() =>
                      document.getElementById(h.id)?.scrollIntoView({ behavior: "smooth" })
                    }
                    className={`block w-full text-left px-2 py-1.5 text-sm leading-snug transition-colors ${
                      h.level === 3 ? "pl-5" : ""
                    } ${
                      activeHeading === h.id
                        ? "text-white"
                        : "text-neutral-500 hover:text-neutral-300"
                    }`}
                  >
                    {h.text}
                  </button>
                ))}
              </nav>
            </aside>
          )}
        </div>
      </main>
    </div>
  );
}

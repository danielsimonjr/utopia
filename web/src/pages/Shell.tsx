import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Link,
  Outlet,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import {
  BookMarked,
  Database,
  Library as LibraryIcon,
  ListChecks,
  MessagesSquare,
  Search as SearchIcon,
  Settings as SettingsIcon,
  Shapes,
  Waypoints,
} from "lucide-react";
import { api, ApiError } from "../api";
import { S } from "../i18n";
import { useKb, useKbId } from "../kb";
import { Dropdown, GithubMark, Wordmark } from "../ui";
import { AlertBell } from "./AlertBell";
import { UserMenu } from "./UserMenu";
import { ServerDown } from "./ServerDown";
import { useAlertEvents } from "../useAlertEvents";
import { useKbEvents } from "../useKbEvents";
import { usePageTitle } from "../useTitle";

const TABS = [
  // The graph is the front page and comes first; the two query methods (Search and Ask) follow.
  { to: "/kb/$kbId/graph", label: S.nav.graph, Icon: Waypoints },
  { to: "/kb/$kbId/search", label: S.nav.search, Icon: SearchIcon },
  { to: "/kb/$kbId/chat", label: S.nav.ask, Icon: MessagesSquare },
  { to: "/kb/$kbId/library", label: S.nav.library, Icon: LibraryIcon },
  { to: "/kb/$kbId/review", label: S.review.title, Icon: ListChecks },
  { to: "/kb/$kbId/ontology", label: S.ontology.title, Icon: Shapes },
  // Ontology answers "what exists in the world"; data mappings answer "how does the database compute this number". They sit next to each other.
  { to: "/kb/$kbId/mappings", label: S.mapping.title, Icon: Database },
  // KB settings shares the same scope as the other tabs, "the current KB", so it sits alongside them in the content navigation.
  { to: "/kb/$kbId/settings", label: S.nav.settings, Icon: SettingsIcon },
] as const;

export function Shell() {
  const navigate = useNavigate();
  const kbId = useKbId();

  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const health = useQuery({
    queryKey: ["health"],
    queryFn: api.health,
    staleTime: Infinity,
  });
  const { kb, kbs, setKb } = useKb();
  // The page title follows the current tab: `Graph · Utopia`. The document viewer page counts as part of Library.
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const tabLabel =
    TABS.find((t) => pathname.startsWith(t.to))?.label ??
    (pathname.startsWith("/doc/") ? S.nav.library : undefined);
  usePageTitle(S.app.name, tabLabel);
  // The single global KB event stream connection: document and review
  // status refresh in real time, replacing polling.
  useKbEvents(kb?.id);
  // The alert stream is global: the badge counts across all KBs, and a system-level alert has no KB at all.
  useAlertEvents();

  // A signed-out user goes to the login page. **This side effect must
  // run inside an effect**; see the 401 branch below for the reason.
  const unauthorized =
    me.isError && me.error instanceof ApiError && me.error.status === 401;
  useEffect(() => {
    if (unauthorized) navigate({ to: "/login" });
  }, [unauthorized, navigate]);

  if (me.isPending) {
    return (
      <div className="min-h-screen flex items-center justify-center text-neutral-500 text-sm">
        {S.nav.loading}
      </div>
    );
  }

  if (me.isError) {
    // **The redirect happens inside an effect, not during rendering.**
    // Calling `navigate` during render changes the router's state while
    // another component is rendering, and React logs a persistent
    // warning: "Cannot update a component while rendering a different
    // component". This does not fail today, but it has the smell of a
    // render-order dependency, and a layout change is the most likely place for it to become a real bug.
    if (me.error instanceof ApiError && me.error.status === 401) {
      return null;
    }
    return <ServerDown />;
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden u-arrive">
      {/* Top bar: brand, workspace, and user (a Vercel-style layout). */}
      {/* z-40: `backdrop-filter` gives the top bar and the tab bar each
          their own stacking context. Without this z-index, the tab bar
          would cover the top bar's popovers, because of DOM order. */}
      <header className="glass-strong relative z-40 border-x-0 border-t-0 h-14 shrink-0 flex items-center gap-4 px-5">
        {/* Wordmark: each letter fades in; hover shows an arrow (↗); a click opens the marketing site. */}
        <Wordmark className="text-[17px]" />
        {/* The breadcrumb has one level: the KB. The workspace concept has
            folded into an invisible deployment-level layer (settings and
            members calls still route through it, similar to how
            organizations work in a single-tenant product). */}
        <span className="text-neutral-700">/</span>
        {/* A plain switcher: creating a KB is an admin action, available under System settings > Knowledge bases. */}
        <Dropdown
          className="w-40"
          size="sm"
          icon={<BookMarked size={12} />}
          menuLabel={S.nav.kbLabel}
          value={kb?.id ?? ""}
          onChange={setKb}
          options={kbs.map((k) => ({ value: k.id, label: k.name }))}
        />
        {/* Three groups: project links, alerts, and identity. **Groups use
            `gap-3`; items within a group use `gap-1.5`.** Spacing comes
            from this structure, not from a one-off margin on a single
            element. An earlier version had the user menu carrying an
            `ml-1.5`, set when it sat right next to the GitHub pill. Once
            the alert bell moved between them, that margin left a 6px gap
            on one side and 12px on the other. */}
        <div className="ml-auto flex items-center gap-3">
          {/* Project links: the Docs link, plus a GitHub-and-version
              pill (the version comes from the backend health check, so
              it always matches the deployment). The version sits inside
              the GitHub pill so both parts share the same height and
              look balanced. These two form a pair, so they sit closer to
              each other than to the other groups. */}
          <div className="flex items-center gap-1.5">
            <Link
              to="/docs"
              className="px-2 py-1 rounded-lg text-[12.5px] text-neutral-500 hover:text-neutral-200 hover:bg-white/[0.05] transition-colors"
            >
              {S.nav.docs}
            </Link>
            <a
              href={S.login.githubUrl}
              target="_blank"
              rel="noreferrer"
              title="GitHub"
              className="flex items-center gap-1.5 rounded-full border border-white/10 px-2.5 py-1 text-neutral-500 hover:text-neutral-200 hover:border-white/25 transition-colors"
            >
              <GithubMark size={13} />
              {health.data && (
                <span className="u-num text-[11px]">
                  v{health.data.version}
                </span>
              )}
            </a>
          </div>
          {/* Alert badge: the unread count across all KBs. Before this
              badge existed, a failure stayed hidden in the logs and in
              `jobs.last_error`, and no document changed color in the UI (ADR 0005). */}
          <AlertBell />
          {/* User menu: profile, system administration (admins only), and sign out. */}
          <UserMenu user={me.data} />
        </div>
      </header>

      {/* Tab navigation bar: icon plus label, with an underline on the active tab (a Vercel-style layout). */}
      <nav className="glass-strong border-x-0 border-t-0 shrink-0 flex items-stretch gap-1 px-4">
        {TABS.map(({ to, label, Icon }) => (
          <Link
            key={to}
            to={to}
            params={{ kbId }}
            className="flex items-center gap-2 px-3.5 py-2.5 text-[13.5px] font-medium text-neutral-400 border-b-2 border-transparent hover:text-neutral-200"
            activeProps={{
              className:
                "flex items-center gap-2 px-3.5 py-2.5 text-[13.5px] font-medium text-white border-b-2 border-white",
            }}
          >
            <Icon size={15} strokeWidth={1.8} />
            {label}
          </Link>
        ))}
      </nav>

      <main className="flex-1 min-h-0">
        <Outlet />
      </main>
    </div>
  );
}

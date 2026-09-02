import {
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";
import { Account } from "./pages/Account";
import { AccountShell } from "./pages/AccountShell";
import { Chat } from "./pages/Chat";
import { DocViewer } from "./pages/DocViewer";
import { DocsPage } from "./pages/Docs";
import { Graph } from "./pages/Graph";
import { Library } from "./pages/Library";
import { Login } from "./pages/Login";
import { Privacy, Terms } from "./pages/Legal";
import { KbRedirect, KbScope } from "./pages/KbScope";
import { KbSettings } from "./pages/KbSettings";
import { MyKbs } from "./pages/MyKbs";
import { NotFound } from "./pages/ServerDown";
import { Ontology } from "./pages/Ontology";
import { Mappings } from "./pages/Mappings";
import { Review } from "./pages/Review";
import { Search } from "./pages/Search";
import { Settings } from "./pages/Settings";
import { Shell } from "./pages/Shell";

const rootRoute = createRootRoute();

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: Login,
});

// Public legal pages: reachable before login.
const privacyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/privacy",
  component: Privacy,
});

const termsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/terms",
  component: Terms,
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  component: Shell,
});

const indexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  beforeLoad: () => {
    // The home page is the graph page: the product's distinct front page.
    throw redirect({ to: "/graph" });
  },
});

/* KB scope. **A KB is a container, not a filter.** Every page below this
   route belongs to one KB. The path expresses that containment, so the
   router catches a "forgot to include the KB" mistake by itself: a URL
   like `/kb/$kbId/search` cannot even build without an id. See
   pages/KbScope.tsx for the full reasoning. */
const kbRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/kb/$kbId",
  component: KbScope,
});

const chatRoute = createRoute({
  getParentRoute: () => kbRoute,
  path: "chat",
  component: Chat,
});

// A conversation is a route: `/chat/$conversationId` only carries the URL,
// so a refresh or a shared link returns to the same conversation.
// Rendering still belongs to the parent Chat component, which stays
// mounted across `/chat` and `/chat/$id`, so streaming continues without a break.
const chatConversationRoute = createRoute({
  getParentRoute: () => chatRoute,
  path: "$conversationId",
  component: () => null,
});

const searchRoute = createRoute({
  getParentRoute: () => kbRoute,
  path: "search",
  component: Search,
});

const graphRoute = createRoute({
  getParentRoute: () => kbRoute,
  path: "graph",
  /* Shareable state for the graph page. **All three describe "what you are
     looking at", not "how you are viewing it".** So the display tier (how
     many nodes to draw) stays out of the URL on purpose; that is a local
     display setting, and it should not carry over to a different machine.

     - `entity`: the selected entity.
     - `focus`: whether the view is in a neighborhood around one entity
       (a different view from a selection in the full graph).
     - `at`: the point on the timeline. **This field matters most.** This
       product's core feature is viewing the world at one point in time. A
       link without a time point loses the most useful part. */
  validateSearch: (
    search: Record<string, unknown>,
  ): { entity?: string; focus?: string; at?: string } => ({
    entity: typeof search.entity === "string" ? search.entity : undefined,
    focus: typeof search.focus === "string" ? search.focus : undefined,
    at: typeof search.at === "string" ? search.at : undefined,
  }),
  component: Graph,
});

const docRoute = createRoute({
  getParentRoute: () => kbRoute,
  path: "doc/$docId",
  validateSearch: (search: Record<string, unknown>): { chunk?: string } => ({
    chunk: typeof search.chunk === "string" ? search.chunk : undefined,
  }),
  component: DocViewer,
});

const libraryRoute = createRoute({
  getParentRoute: () => kbRoute,
  path: "library",
  validateSearch: (search: Record<string, unknown>): { src?: string } => ({
    src: typeof search.src === "string" ? search.src : undefined,
  }),
  component: Library,
});

const ontologyRoute = createRoute({
  getParentRoute: () => kbRoute,
  path: "ontology",
  component: Ontology,
});

const mappingsRoute = createRoute({
  getParentRoute: () => kbRoute,
  path: "mappings",
  component: Mappings,
});

const reviewRoute = createRoute({
  getParentRoute: () => kbRoute,
  path: "review",
  component: Review,
});

// Built-in docs: a public route, readable before login and available offline in a private deployment.
const docsIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/docs",
  beforeLoad: () => {
    throw redirect({ to: "/docs/$slug", params: { slug: "ingest" } });
  },
});

const docsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/docs/$slug",
  component: DocsPage,
});

// Account layer (Profile, Administration): not tied to a KB. It uses a separate shell with no tab navigation.
const accountShellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "account",
  component: AccountShell,
});

const accountRoute = createRoute({
  getParentRoute: () => accountShellRoute,
  path: "/account",
  component: Account,
});

const myKbsRoute = createRoute({
  getParentRoute: () => accountShellRoute,
  path: "/account/kbs",
  component: MyKbs,
});

const adminRoute = createRoute({
  getParentRoute: () => accountShellRoute,
  path: "/admin",
  // Supports a deep link to a specific tab (for example, a "register a new
  // connection" link from the KB data section that goes straight to Data sources).
  validateSearch: (
    search: Record<string, unknown>,
  ): { tab?: "models" | "members" | "kbs" | "datasources" | "deployment" } => ({
    tab:
      search.tab === "models" ||
      search.tab === "members" ||
      search.tab === "kbs" ||
      search.tab === "datasources" ||
      search.tab === "deployment"
        ? search.tab
        : undefined,
  }),
  component: Settings,
});

// Backward compatibility for an old path: /settings redirects to /admin.
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  beforeLoad: () => {
    throw redirect({ to: "/admin" });
  },
});

const kbSettingsRoute = createRoute({
  getParentRoute: () => kbRoute,
  path: "settings",
  component: KbSettings,
});

/* Backward compatibility for old paths: an address without a KB id, such
   as `/graph`, still works. This resolves the target KB, then redirects.
   **This does not use a `beforeLoad` redirect**, because the KB list has
   not loaded at that point, and localStorage may hold nothing yet (a new
   device, or a cleared cache). This waits for `useKb` to resolve the KB instead. */
/* **Each route is written out separately, instead of built by a factory
   function.** A factory function's `path` has type `string`, so the type
   system cannot narrow it to a literal type, and calls like
   `redirect({ to: "/graph" })` elsewhere would fail to type-check. This
   repetition trades brevity for type safety. */
const legacyGraphRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/graph",
  component: () => <KbRedirect page="graph" />,
});
const legacySearchRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/search",
  component: () => <KbRedirect page="search" />,
});
const legacyChatRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/chat",
  component: () => <KbRedirect page="chat" />,
});
const legacyLibraryRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/library",
  component: () => <KbRedirect page="library" />,
});
const legacyOntologyRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/ontology",
  component: () => <KbRedirect page="ontology" />,
});
const legacyMappingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/mappings",
  component: () => <KbRedirect page="mappings" />,
});
const legacyReviewRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/review",
  component: () => <KbRedirect page="review" />,
});
const legacyKbSettingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/kb-settings",
  component: () => <KbRedirect page="settings" />,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  privacyRoute,
  termsRoute,
  settingsRoute,
  docsIndexRoute,
  docsRoute,
  accountShellRoute.addChildren([accountRoute, myKbsRoute, adminRoute]),
  appRoute.addChildren([
    indexRoute,
    legacyGraphRoute,
    legacySearchRoute,
    legacyChatRoute,
    legacyLibraryRoute,
    legacyOntologyRoute,
    legacyMappingsRoute,
    legacyReviewRoute,
    legacyKbSettingsRoute,
    kbRoute.addChildren([
      chatRoute.addChildren([chatConversationRoute]),
      searchRoute,
      graphRoute,
      docRoute,
      libraryRoute,
      reviewRoute,
      ontologyRoute,
      mappingsRoute,
      kbSettingsRoute,
    ]),
  ]),
]);

export const router = createRouter({
  routeTree,
  // The 404 page for an unknown path.
  defaultNotFoundComponent: NotFound,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

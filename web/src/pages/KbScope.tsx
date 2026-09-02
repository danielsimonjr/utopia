// KB scope layer: everything under `/kb/$kbId` belongs to this knowledge base.
//
// **Why the KB id lives in the path, not a query parameter**: a KB is a
// container, not a filter. The graph, search, library, ontology, and
// review pages all live under it. A path can express that containment,
// and the router enforces it: a URL like `/kb/$kbId/search` cannot even
// build without an id. A query parameter such as `?kb=` is optional; it
// can drop while switching tabs, silently and with no error. The user
// would then see another KB's data behind an identical-looking interface.
//
// **Why this also uses localStorage**: the URL and localStorage answer
// different questions. The URL answers "what does this link point to".
// localStorage answers "what was I looking at last". So when the URL has
// a KB id, the URL wins; otherwise, this falls back to the stored value
// (see kb.tsx and `KbRedirect` below).
import { useEffect } from "react";
import { Link, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { ApiError, api } from "../api";
import { S } from "../i18n";
import { useKb } from "../kb";
import { kbStore, wsStore } from "../wsStore";

/** The page shown when the KB does not exist or the user has no access.
 *  **A blank graph is not enough**: the most common failure for a shared
 *  link is that the recipient has no access. A blank graph looks like
 *  "this KB is empty", which is a different problem. */
function KbNoAccess({ status }: { status: number }) {
  return (
    <div className="grid h-full place-items-center px-6">
      <div className="max-w-sm text-center">
        <h2 className="text-[15px] text-neutral-200">
          {status === 404 ? S.kbScope.missingTitle : S.kbScope.deniedTitle}
        </h2>
        <p className="mt-2 text-xs leading-relaxed text-neutral-500">
          {status === 404 ? S.kbScope.missingBody : S.kbScope.deniedBody}
        </p>
        <Link
          to="/account/kbs"
          className="u-btn u-btn-ghost mt-4 inline-block px-3 py-1.5 text-xs"
        >
          {S.kbScope.myKbs}
        </Link>
      </div>
    </div>
  );
}

export function KbScope() {
  const { kbId } = useParams({ from: "/app/kb/$kbId" });
  // **This asks the server directly, instead of searching the current
  // workspace's KB list.** A link can point to a KB in a different
  // workspace, which does not appear in that list, even though the user
  // has access to it. Checking only the list would wrongly deny access.
  const kb = useQuery({
    queryKey: ["kbOne", kbId],
    queryFn: () => api.kbDetail(kbId),
    retry: false,
  });

  // Opening a KB updates the "last viewed" KB to match. This also aligns
  // the workspace; otherwise, the top-bar switcher would still show the
  // previous workspace.
  useEffect(() => {
    if (!kb.data) return;
    kbStore.set(kb.data.id);
    wsStore.set(kb.data.workspace_id);
  }, [kb.data]);

  if (kb.isError) {
    const status = kb.error instanceof ApiError ? kb.error.status : 500;
    return <KbNoAccess status={status} />;
  }
  // This renders nothing while loading. This layer is only a scope
  // wrapper; a flashing spinner here would look like the page is jumping.
  if (!kb.data) return null;
  return <Outlet />;
}

/** Handles an old path, such as `/graph`, that has no KB id: this
 *  resolves the target KB, then redirects to it.
 *
 *  **This cannot redirect directly inside `beforeLoad`**, because the KB
 *  list has not loaded at that point, and localStorage may hold nothing
 *  yet (a new device, or a cleared cache). So this is a component that
 *  waits for `useKb` to resolve the KB first. */
export function KbRedirect({
  page,
}: {
  page:
    | "graph"
    | "search"
    | "chat"
    | "library"
    | "ontology"
    | "mappings"
    | "review"
    | "settings";
}) {
  const { kb } = useKb();
  const navigate = useNavigate();
  useEffect(() => {
    if (!kb) return;
    navigate({
      to: `/kb/$kbId/${page}`,
      params: { kbId: kb.id },
      replace: true,
    });
  }, [kb, page, navigate]);
  return null;
}

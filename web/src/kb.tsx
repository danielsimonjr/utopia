// Current workspace/KB context: both are switchable and persist in
// localStorage. When a workspace has no KB, this creates one named "General".
import { useCallback, useSyncExternalStore } from "react";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Kb, type Workspace } from "./api";
import { kbStore, wsStore } from "./wsStore";

/** The KB id from the current path. **Every page lives under
 *  `/kb/$kbId`, so this reads the id straight from the path.** It does not
 *  wait for the KB list to load; the link determines the id directly.
 *  Outside that scope, such as the account pages, this falls back to the
 *  stored id. */
export function useKbId(): string {
  const params = useParams({ strict: false }) as { kbId?: string };
  const { kb } = useKb();
  return params.kbId ?? kb?.id ?? "";
}

export function useKb(): {
  kb: Kb | null;
  kbs: Kb[];
  workspace: Workspace | null;
  workspaces: Workspace[];
  setWorkspace: (id: string) => void;
  setKb: (id: string) => void;
} {
  const queryClient = useQueryClient();
  const selectedId = useSyncExternalStore(wsStore.subscribe, wsStore.get);
  const selectedKbId = useSyncExternalStore(kbStore.subscribe, kbStore.get);

  const workspaces = useQuery({ queryKey: ["workspaces"], queryFn: api.workspaces });
  const list = workspaces.data ?? [];
  const ws = list.find((w) => w.id === selectedId) ?? list[0] ?? null;

  const kbs = useQuery({
    queryKey: ["kbs", ws?.id],
    queryFn: async () => {
      const existing = await api.kbs(ws!.id);
      if (existing.length > 0) return existing;
      // An empty workspace gets a "General" KB automatically. Creating a KB
      // is now an admin action, so a non-admin call returns 403.
      // On that error, wait silently for an admin to create it. In
      // practice, the first user is an admin, so "General" always exists.
      try {
        const created = await api.createKb(ws!.id, { name: "General" });
        queryClient.invalidateQueries({ queryKey: ["kbs", ws!.id] });
        return [created];
      } catch {
        return [];
      }
    },
    enabled: !!ws,
  });

  const kbList = kbs.data ?? [];
  /* **When the URL has a KB id, the URL wins.** The two sources answer
     different questions: the address bar answers "what does this link
     point to", and localStorage answers "what was I looking at last".
     A link shared by another user must win over the local memory.
     Otherwise, the page opens to the wrong KB, with a different data
     set behind an identical-looking interface. */
  const routeParams = useParams({ strict: false }) as { kbId?: string };
  const wantedKbId = routeParams.kbId ?? selectedKbId;
  const kb = kbList.find((k) => k.id === wantedKbId) ?? kbList[0] ?? null;

  /* **Switching the KB is a navigation, not only a stored change.**
     The "URL wins" rule above is correct, but it has a cost: every page
     in scope has a KB id in its address, so `selectedKbId` never takes
     effect on its own. Writing only to the store changes the value and
     re-renders the component, but the computed KB stays the same. As a
     result, the top-bar dropdown becomes **fully inactive** under
     `/kb/$kbId/*`: a click does nothing until the next page reload (and
     the home redirect reads the stored value at that point).

     So this merges the navigation into `setKb` itself, instead of
     requiring every call site to remember a matching `navigate` call.
     Two call sites had missed exactly that step (the top-bar dropdown and
     the Chat scope switcher), while the three correct call sites all
     navigated to a specific page and carried the KB id along by chance.
     A convention that depends on memory gets forgotten.

     This stays on the current page: switching the KB on the ontology page
     should show the other KB's ontology, not redirect to the graph page.
     When the address has no KB id, such as on the account pages, this
     only updates the store; that scope should not force a redirect, so
     the caller decides where to navigate. */
  const navigate = useNavigate();
  const pathname = useLocation({ select: (l) => l.pathname });
  const currentKbId = routeParams.kbId;
  const setKb = useCallback(
    (id: string) => {
      kbStore.set(id);
      if (currentKbId && currentKbId !== id) {
        navigate({ to: pathname.replace(currentKbId, id), replace: false });
      }
    },
    [navigate, pathname, currentKbId],
  );

  return {
    kb,
    kbs: kbList,
    workspace: ws,
    workspaces: list,
    setWorkspace: wsStore.set,
    setKb,
  };
}

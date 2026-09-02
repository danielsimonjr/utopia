// Alert event subscription. **This is global, not per-KB.** The top-bar
// badge spans all KBs, and a system-level alert has no KB at all.
//
// The server-pushed event carries no data and applies no permission check
// (see alerts_routes::stream). On receipt, the client refetches, and the
// list query decides what each user can see. So this code does not need
// to know the current KB.
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

export function useAlertEvents() {
  const queryClient = useQueryClient();
  useEffect(() => {
    const es = new EventSource("/api/v1/alerts/events");
    es.addEventListener("alert", () => {
      queryClient.invalidateQueries({ queryKey: ["alerts"] });
    });
    return () => es.close();
  }, [queryClient]);
}

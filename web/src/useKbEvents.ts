// KB event stream subscription: on each event, this only invalidates and
// refetches react-query data. Events carry no business data, so retries
// are naturally idempotent. EventSource reconnects on its own after a
// disconnect. This replaces polling in Library and Review.
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

export function useKbEvents(kbId: string | undefined) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!kbId) return;
    const es = new EventSource(`/api/v1/kbs/${kbId}/events`);
    es.addEventListener("document", () => {
      queryClient.invalidateQueries({ queryKey: ["documents", kbId] });
      queryClient.invalidateQueries({ queryKey: ["graph"] });
    });
    es.addEventListener("graph", () => {
      queryClient.invalidateQueries({ queryKey: ["graph"] });
    });
    es.addEventListener("review", () => {
      queryClient.invalidateQueries({ queryKey: ["review", kbId] });
    });
    es.addEventListener("source", () => {
      queryClient.invalidateQueries({ queryKey: ["sources", kbId] });
      queryClient.invalidateQueries({ queryKey: ["documents", kbId] });
    });
    return () => es.close();
  }, [kbId, queryClient]);
}

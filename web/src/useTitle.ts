/* Page title system: `{domain} | {page}`, with the brand name first (a
   product decision; the cost is that multiple truncated tabs share a prefix).
   Domains: Utopia (main app), Utopia Charter (docs), Utopia Persona (account). */
import { useEffect } from "react";

export function usePageTitle(...parts: (string | null | undefined)[]) {
  const title = parts.filter(Boolean).join(" | ");
  useEffect(() => {
    if (title) document.title = title;
  }, [title]);
}

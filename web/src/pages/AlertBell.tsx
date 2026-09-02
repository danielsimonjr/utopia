// Top-bar alerts (ADR 0005): a bell icon, an unread badge, and a popover panel.
//
// **This is a popover, not a page.** An alert is something to glance at
// in passing, not a place to visit on purpose. A dedicated page would
// force the user away from their current task, and that cost means fewer
// people would ever check it.
//
// One alert equals one failure. Once written, it does not change; there
// is no "resolved" state. The "read" state is per user: one user reading
// an alert does not clear it from another user's unread count.
import { type Ref, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, Search, X } from "lucide-react";

import { api, type AlertGroup } from "../api";
import { S } from "../i18n";
import { Chip, Pager, cn } from "../ui";
import { usePopoverFlip } from "../ui/popoverFlip";

const PAGE = 8;

/** The line shown for one detail row: the object name and the raw error text. */
function line(d: AlertGroup["lines"][number]): string | null {
  const parts = [d.name ?? d.job, d.error].filter(Boolean);
  return parts.length ? parts.join(" — ") : null;
}

function AlertRow({
  g,
  onRead,
}: {
  g: AlertGroup;
  onRead: (g: AlertGroup) => void;
}) {
  // An unrecognized kind must still display. When a new alert source
  // ships, the frontend may not have a label for it yet, and "an alert
  // exists but the label is unfamiliar" is much better than showing nothing.
  const worded = S.alerts.kinds[g.kind];
  const lines = g.lines.map(line).filter((l): l is string => !!l);
  // `count` covers the whole group, but `lines` returns only the first few. The difference is "N more".
  const rest = g.count - lines.length;
  return (
    <button
      type="button"
      // **Only a click marks an alert as read**, not a hover. Moving the
      // mouse over a list of alerts does not mean the user saw them, and
      // a read state does not undo itself. A click marks the whole group at once.
      onClick={() => {
        if (g.unread > 0) onRead(g);
      }}
      className="w-full text-left flex gap-2.5 px-3.5 py-3 border-b border-white/[0.06] last:border-b-0 hover:bg-white/[0.03] transition-colors"
    >
      {/* An unread alert shows only a small red dot. A full-row border or
          background would turn the panel entirely red when many alerts
          exist. The dot occupies only the space it needs, and disappears once read. */}
      <span
        className={cn(
          "mt-[7px] h-1.5 w-1.5 rounded-full shrink-0",
          g.unread > 0 ? "bg-rose-500" : "bg-transparent",
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span
            className={cn(
              "text-[13px]",
              g.unread > 0 ? "font-medium text-white" : "text-neutral-400",
            )}
          >
            {worded?.title ?? S.alerts.unknownKind(g.kind)}
          </span>
          {g.count > 1 && <Chip tone="neutral">{g.count}</Chip>}
          <Chip tone={g.kb_name ? "neutral" : "violet"}>
            {g.kb_name ?? S.alerts.system}
          </Chip>
        </div>
        {worded && (
          <p className="mt-0.5 text-[11.5px] text-neutral-500">{worded.hint}</p>
        )}
        {lines.length > 0 && (
          <ul className="mt-1 space-y-0.5">
            {lines.map((l, i) => (
              <li key={i} className="text-[11px] text-neutral-400 break-words">
                {l}
              </li>
            ))}
            {rest > 0 && (
              <li className="text-[11px] text-neutral-600">
                {S.alerts.andMore(rest)}
              </li>
            )}
          </ul>
        )}
        {/* This shows the timestamp of the most recent alert in the group. */}
        <p className="u-num mt-1.5 text-[10.5px] text-neutral-600">
          {new Date(g.latest_at).toLocaleString()}
        </p>
      </div>
    </button>
  );
}

function Panel({ panelRef }: { panelRef: Ref<HTMLDivElement> }) {
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const qc = useQueryClient();

  // A new search resets to the first page. Staying on page 4 while the
  // result has only 2 pages would show a blank panel, and the user would read that as "no alerts".
  useEffect(() => {
    setPage(0);
  }, [q]);

  const list = useQuery({
    queryKey: ["alerts", "list", q, page],
    queryFn: () => api.alerts({ q, limit: PAGE, offset: page * PAGE }),
    // This keeps the previous page's data visible while paging, so the panel height does not collapse and then snap back.
    placeholderData: (prev) => prev,
  });

  const read = useMutation({
    mutationFn: (g: AlertGroup) =>
      api.alertReadGroup({
        kb_id: g.kb_id,
        kind: g.kind,
        from: g.earliest_at,
        to: g.latest_at,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alerts"] }),
  });
  const readAll = useMutation({
    mutationFn: () => api.alertsReadAll(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alerts"] }),
  });

  const groups = list.data?.items ?? [];
  const total = list.data?.total ?? 0;

  return (
    // This uses `top-0`, not `top-9`, because the panel must grow from the bell's **original position**, aligned at the top right.
    <div
      ref={panelRef}
      className="u-menu-glass absolute right-0 top-0 w-[420px] rounded-xl shadow-2xl z-50 overflow-hidden"
    >
      <div className="flex items-center gap-2 pl-3.5 pr-10 py-2.5 border-b border-white/10">
        <span className="text-[13px] font-medium text-neutral-100">
          {S.alerts.title}
        </span>
      </div>

      {/* This matches the library's filter box: `input-dark`, a left
          icon, a clear button on the right when a value exists, and Esc to clear. */}
      <div className="px-3.5 py-2.5 border-b border-white/[0.06]">
        <div className="relative">
          <Search
            size={13}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-500 pointer-events-none"
          />
          <input
            className="input-dark w-full pl-8 pr-7 py-1.5 text-[13px]"
            placeholder={S.alerts.searchPlaceholder}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQ("")}
          />
          {q && (
            <button
              onClick={() => setQ("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-neutral-200"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      <div className="max-h-[420px] overflow-y-auto">
        {groups.length === 0 ? (
          <div className="px-3.5 py-8 text-center">
            <p className="text-[13px] text-neutral-300">
              {q ? S.alerts.noMatch : S.alerts.empty}
            </p>
            {!q && (
              <p className="mt-1 text-[11.5px] text-neutral-500">
                {S.alerts.emptyHint}
              </p>
            )}
          </div>
        ) : (
          groups.map((g) => (
            <AlertRow
              key={`${g.kb_id ?? "system"}|${g.kind}|${g.latest_at}`}
              g={g}
              onRead={(x) => read.mutate(x)}
            />
          ))
        )}
      </div>

      {/* Footer: list-wide actions sit next to the pager, farthest from the cursor. */}
      {groups.length > 0 && (
        <div className="flex items-center gap-3 px-3.5 py-2 border-t border-white/[0.06]">
          {groups.some((g) => g.unread > 0) && (
            <button
              className="text-[11.5px] text-neutral-500 hover:text-neutral-200 transition-colors"
              onClick={() => readAll.mutate()}
            >
              {S.alerts.markAllRead}
            </button>
          )}
          <Pager
            className="ml-auto"
            total={total}
            pageSize={PAGE}
            page={page}
            onPage={setPage}
          />
        </div>
      )}
    </div>
  );
}

export function AlertBell() {
  // This shares the same in-place transform as the user menu. The two
  // panels sit next to each other, so any small animation difference is visible on switching between them.
  const { open, setOpen, close, rootRef, anchorRef, panelRef } =
    usePopoverFlip<HTMLButtonElement, HTMLDivElement>();
  const unread = useQuery({
    queryKey: ["alerts", "unread"],
    queryFn: () => api.alertsUnread(),
    // A push update is the primary path; this poll is only a fallback for when the stream disconnects.
    refetchInterval: 120_000,
  });
  const n = unread.data?.unread ?? 0;

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={anchorRef}
        onClick={() => (open ? close() : setOpen(true))}
        title={S.alerts.badgeLabel}
        aria-label={S.alerts.badgeLabel}
        aria-expanded={open}
        // h-7 w-7 keeps this a square: a button holding only one icon
        // should not be rectangular. The close button uses the same
        // size, absolutely positioned at the panel's `right-0 top-0`, so the two align exactly.
        className={cn(
          "relative grid h-7 w-7 place-items-center rounded-lg transition-colors",
          open
            ? "text-neutral-200 bg-white/[0.06]"
            : "text-neutral-500 hover:text-neutral-200 hover:bg-white/[0.05]",
        )}
      >
        <Bell size={15} />
        {/* The badge is a dot, not a number. "There is something unread"
            is a yes-or-no state; the exact count shows once the panel
            opens. A number would also climb with retries, and a
            three-digit count would distort the bell's shape. */}
        {n > 0 && (
          <span className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-rose-500" />
        )}
      </button>
      {open && (
        <>
          <Panel panelRef={panelRef} />
          {/* The close button is the panel's **sibling**, not its child.
              Inside the panel, `right-0 top-0` would position relative
              to the panel's padding box, and `u-menu-glass` has a
              0.667px hairline border (one physical pixel at a device
              pixel ratio of 1.5), which would always leave a small gap.
              Placed here, the positioning ancestor is the div wrapping
              the bell, the same box as the bell itself, so the alignment holds exactly.

              The cursor rests at this exact spot right after opening the
              panel, so this position must be "click again to close".
              Placing "mark all as read" here would turn a stray click
              into a default action, and it would clear every alert across every KB at once. */}
          <button
            onClick={close}
            title={S.alerts.close}
            aria-label={S.alerts.close}
            className="absolute right-0 top-0 z-[60] grid h-7 w-7 place-items-center rounded-lg text-neutral-500 hover:text-neutral-200 transition-colors"
          >
            <X size={15} />
          </button>
        </>
      )}
    </div>
  );
}

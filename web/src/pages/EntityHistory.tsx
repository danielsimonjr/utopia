/* An entity's knowledge change history (the recorded-time timeline).
   This axis is independent of the Timeline view in the same panel. The
   Timeline view asks "when did this hold true in reality". This axis
   asks "when did we believe this, and when did we change our mind". The
   data comes from the append-only log, minus the rows that `entity_detail`
   filters out with `invalidated_at IS NULL`. */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { FileText, Merge, PencilLine, Tag, Undo2 } from "lucide-react";
import { api, type EntityHistoryEvent } from "../api";
import { S } from "../i18n";
import { useKbId } from "../kb";
import { Pager } from "../ui";

const PER = 20;

/** Maps each event kind to an icon and a tone. Only "overturned" events use a semantic color; the rest stay neutral. */
const KIND_ICON = {
  asserted: FileText,
  corrected: PencilLine,
  rejected: Undo2,
  // A merge is not a retraction: the content moves, unchanged, into another assertion.
  merged: Merge,
  // Retyping is not a fact change: only the node's type changes on the graph; the facts stay the same.
  retyped: Tag,
  retype_reverted: Undo2,
} as const;

const KIND_TONE: Record<string, string> = {
  asserted: "text-neutral-500",
  corrected: "text-[var(--u-warn)]",
  rejected: "text-[var(--u-danger)]",
  merged: "text-neutral-500",
  retyped: "text-neutral-500",
  retype_reverted: "text-[var(--u-warn)]",
};

/* These two functions **are different on purpose**; do not merge them.
   They render two different kinds of time.

   `ymd` returns the **recorded time** (when we came to believe this).
   That is a real point in time, and it must display in the viewer's own
   time zone. An earlier version sliced the ISO string directly, which
   effectively displayed it in UTC. A revision made before 8 AM in UTC+8
   would then display as the previous day in the history.

   `ym` returns **world time** (when this held true in reality). It comes
   from a statement in a document, such as "took office in May 2019", and
   is **a calendar date, not a point in time**; it has no time zone at
   all. Slicing the ISO string returns the same date that was stored, as
   read in UTC. Converting it to local time would show a reader in UTC-5 the previous month instead.*/
const ymd = (iso: string) => {
  const d = new Date(iso);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
};
const ym = (iso: string | null) => (iso ? iso.slice(0, 7) : null);

/** The object of the fact: the entity name if there is one, or a literal
 *  value's (an attribute fact's) summary or raw value. */
function objectText(e: EntityHistoryEvent): string {
  if (e.other_name) return e.other_name;
  const v = e.object_value as { summary?: unknown; value?: unknown } | null;
  const raw = v?.summary ?? v?.value;
  return raw === undefined || raw === null ? "—" : String(raw);
}

/** Describes what this change did to the valid-time interval. This event
 *  belongs to the recorded-time axis, but it changes a boundary on the
 *  valid-time axis. */
function intervalNote(e: EntityHistoryEvent): string | null {
  if (e.kind === "corrected") {
    return e.valid_to ? S.graph.historyClosedAt(ym(e.valid_to)!) : null;
  }
  const from = ym(e.valid_from);
  if (!from) return null;
  return e.valid_to
    ? `${from} → ${ym(e.valid_to)}`
    : `${S.graph.historyFrom(from)} · ${S.graph.historyOngoing}`;
}

function EventRow({ e }: { e: EntityHistoryEvent }) {
  const kbId = useKbId();
  const Icon = KIND_ICON[e.kind] ?? FileText;
  const note = intervalNote(e);
  return (
    <div className="flex gap-2.5 px-2 py-2">
      <Icon size={13} className={`mt-0.5 shrink-0 ${KIND_TONE[e.kind] ?? ""}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5 flex-wrap">
          <span className="text-[11px] font-medium text-neutral-300">
            {S.graph.historyKind[e.kind] ?? e.kind}
          </span>
          {note && <span className="u-num text-[11px] text-neutral-500">{note}</span>}
        </div>
        {/* A retype event has no predicate and no object, so the body
            shows the two types instead. An empty starting type means the
            entity changed from "untyped", the most common case since ADR 0009. */}
        {e.kind === "retyped" || e.kind === "retype_reverted" ? (
          <div className="mt-0.5 text-[12.5px] text-neutral-400 truncate">
            <span className="text-neutral-500">
              {e.from_type_label ?? S.graph.untyped} →{" "}
            </span>
            <span className="text-neutral-200">{e.to_type_label}</span>
          </div>
        ) : (
          <div className="mt-0.5 text-[12.5px] text-neutral-400 truncate">
            <span className="text-neutral-500">
              {e.direction === "in" ? "← " : ""}
              <span className={e.predicate_label === null ? "italic text-neutral-600" : undefined}>
                {e.predicate_label ?? S.graph.unknownPredicate}
              </span>
              {e.direction === "in" ? "" : " →"}
            </span>{" "}
            <span className="text-neutral-200">{objectText(e)}</span>
          </div>
        )}
        <div className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-neutral-600">
          <span className="u-num">{ymd(e.at)}</span>
          <span>·</span>
          {/* Attribution: a person's name, or the engine (extraction write, or an automatic close from temporal reconciliation). */}
          <span>{e.actor_name ?? S.graph.historyEngine}</span>
          {e.filename && e.document_id && (
            <>
              <span>·</span>
              <Link
                to="/kb/$kbId/doc/$docId"
                params={{ kbId, docId: e.document_id }}
                search={{}}
                className="truncate hover:text-neutral-300"
                title={e.quote ?? e.filename}
              >
                {e.filename}
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function EntityHistory({ kbId, entityId }: { kbId: string; entityId: string }) {
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [entityId]);
  const q = useQuery({
    queryKey: ["entityHistory", kbId, entityId, page],
    queryFn: () => api.entityHistory(kbId, entityId, page, PER),
  });

  const total = q.data?.total ?? 0;
  if (q.isPending) return <p className="p-2 text-sm text-neutral-500">{S.nav.loading}</p>;
  // "Empty" means zero events, not zero facts. The first assertion is
  // itself an event on this axis: "when did we learn this, and from
  // which document" is half of what this axis answers.
  if (total === 0) return <p className="p-2 text-xs text-neutral-500">{S.graph.historyEmpty}</p>;

  return (
    <div>
      <p className="px-2 pb-1.5 text-[11px] text-neutral-600">{S.graph.historyHint}</p>
      <div className="divide-y divide-white/[0.06]">
        {/* The key uses `fact_id ?? at`, because a retype event has no `fact_id`. */}
        {(q.data?.events ?? []).map((e) => (
          <EventRow key={`${e.fact_id ?? e.at}-${e.kind}`} e={e} />
        ))}
      </div>
      <Pager total={total} pageSize={PER} page={page} onPage={setPage} />
    </div>
  );
}

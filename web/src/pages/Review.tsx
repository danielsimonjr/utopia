import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import {
  api,
  type AxiomViolation,
  type ReviewQueue,
  type OntologyDefect,
  type ConflictItem,
  type FactReviewItem,
  type MergeLog,
  type ReviewHistoryEvent,
  type ReviewItem,
  type ReviewSide,
} from "../api";
import { S } from "../i18n";
import { useKb, useKbId } from "../kb";
import { Chip, type ChipTone, Pager, RAIL_CLS, cn } from "../ui";

const DUP_PAGE = 6;
const FACT_PAGE = 10;
const MERGE_PAGE = 10;
const CONFLICT_PAGE = 8;

const ym = (iso: string | null) => (iso ? iso.slice(0, 7) : null);

/** The reason format is `code` or `code|detail`. When the code has no
 *  label, this displays the raw text; older rows still hold the old prose text in English. */
function escalationText(reason: string): string {
  const [code, detail] = reason.split("|");
  const worded = S.review.escalated[code];
  if (!worded) return reason;
  return detail ? S.errDetail(worded, detail) : worded;
}

function dateRange(from: string | null, to: string | null): string | null {
  if (!from && !to) return null;
  return `${ym(from) ?? "…"} → ${ym(to) ?? S.review.ongoing}`;
}

function SideCard({ side }: { side: ReviewSide }) {
  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-2 mb-1">
        <span
          className="h-2.5 w-2.5 rounded-full shrink-0"
          style={{ backgroundColor: side.color }}
        />
        <span className="text-sm font-medium text-white truncate">
          {side.name}
        </span>
        {side.disambiguator && (
          <span className="text-xs text-neutral-500 truncate">
            · {side.disambiguator}
          </span>
        )}
      </div>
      <div className="text-xs text-neutral-500 mb-2">
        {side.type_label ?? S.graph.untyped} ·{" "}
        {S.review.factsCount(side.degree)}
      </div>
      {side.top_facts.length > 0 ? (
        <ul className="space-y-1">
          {side.top_facts.map((f, i) => (
            <li key={i} className="text-xs text-neutral-400 truncate">
              {f}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-neutral-600">{S.review.noFacts}</p>
      )}
    </div>
  );
}

function DuplicateCard({
  item,
  busy,
  onDecide,
}: {
  item: ReviewItem;
  busy: boolean;
  onDecide: (action: "merge" | "keep") => void;
}) {
  return (
    <div className="glass rounded-xl p-4">
      <div className="flex gap-4">
        <SideCard side={item.left} />
        <div className="self-center text-neutral-600 text-sm shrink-0">≟</div>
        <SideCard side={item.right} />
      </div>
      <div className="mt-3 pt-3 flex items-center gap-3 border-t border-[var(--u-line)]">
        <span
          className={`u-chip ${item.stage === "human" ? "u-chip-warn" : "u-chip-neutral"}`}
        >
          {item.stage === "human"
            ? S.review.stageHuman
            : S.review.stageAdjudicating}
        </span>
        <span className="text-xs text-neutral-500">
          {S.review.similarity(Math.round(item.score * 100))}
        </span>
        {item.reason && (
          <span className="text-xs text-neutral-600 truncate min-w-0">
            {escalationText(item.reason)}
          </span>
        )}
        <div className="ml-auto flex gap-2 shrink-0">
          <button
            className="u-btn u-btn-ghost px-3 py-1.5 text-xs"
            disabled={busy}
            onClick={() => onDecide("keep")}
          >
            {S.review.keep}
          </button>
          <button
            className="u-btn u-btn-primary px-3 py-1.5 text-xs"
            disabled={busy}
            onClick={() => onDecide("merge")}
          >
            {S.review.merge}
          </button>
        </div>
      </div>
    </div>
  );
}

function FactRow({
  fact,
  busy,
  onConfirm,
  onReject,
}: {
  fact: FactReviewItem;
  busy: boolean;
  onConfirm: () => void;
  onReject: () => void;
}) {
  const range = dateRange(fact.valid_from, fact.valid_to);
  return (
    <div className="glass rounded-xl p-4">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-medium text-white">
          {fact.subject_name}
        </span>
        <span className="text-xs text-neutral-500">
          —{" "}
          <span
            className={
              fact.predicate_label === null
                ? "italic text-neutral-600"
                : undefined
            }
          >
            {fact.predicate_label ?? S.graph.unknownPredicate}
          </span>{" "}
          →
        </span>
        <span className="text-sm font-medium text-white">
          {fact.object_name ?? "?"}
        </span>
        {range && <span className="text-xs text-neutral-500">({range})</span>}
        <span className="u-chip u-chip-warn ml-auto">
          {S.review.confidence(Math.round(fact.confidence * 100))}
        </span>
      </div>
      {fact.quote && (
        <p className="mt-2 text-xs text-neutral-500 italic line-clamp-2">
          “{fact.quote}”
        </p>
      )}
      <div className="mt-3 flex gap-2 justify-end">
        <button
          className="u-btn u-btn-ghost px-3 py-1.5 text-xs text-[var(--u-danger)]"
          disabled={busy}
          onClick={onReject}
        >
          {S.review.reject}
        </button>
        <button
          className="u-btn u-btn-ghost px-3 py-1.5 text-xs"
          disabled={busy}
          onClick={onConfirm}
        >
          {S.review.confirm}
        </button>
      </div>
    </div>
  );
}

/** A temporal conflict row: the old fact against the new fact, with
 *  three actions available: close the old fact, keep both, or reject the new fact. */
function ConflictRow({
  conflict,
  busy,
  onResolve,
}: {
  conflict: ConflictItem;
  busy: boolean;
  onResolve: (
    action: "close" | "keep" | "reject_new",
    closeAt?: string,
  ) => void;
}) {
  const [closeAt, setCloseAt] = useState("");
  const c = conflict;
  const needsDate = !c.new_valid_from;
  // Converts the day-precision `closeAt` input to RFC 3339.
  const closeAtIso = /^\d{4}-\d{2}-\d{2}$/.test(closeAt.trim())
    ? `${closeAt.trim()}T00:00:00Z`
    : undefined;

  return (
    <div className="glass rounded-xl p-4">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-medium text-white">{c.old_subject}</span>
        <span className="text-xs text-neutral-500">
          — {c.predicate_label} →
        </span>
        <span className="text-sm font-medium text-white">
          {c.old_object ?? "?"}
        </span>
        {c.old_valid_from && (
          <span className="u-num text-xs text-neutral-500">
            ({S.review.conflictSince(c.old_valid_from.slice(0, 10))})
          </span>
        )}
        <span className="text-xs text-neutral-600">{S.review.conflictVs}</span>
        <span className="text-sm font-medium text-white">{c.new_subject}</span>
        <span className="text-xs text-neutral-500">
          — {c.predicate_label} →
        </span>
        <span className="text-sm font-medium text-white">
          {c.new_object ?? "?"}
        </span>
        {c.new_valid_from && (
          <span className="u-num text-xs text-neutral-500">
            ({S.review.conflictSince(c.new_valid_from.slice(0, 10))})
          </span>
        )}
        <span className="u-chip u-chip-warn ml-auto">
          {S.review.conflictReason[c.reason] ?? c.reason}
        </span>
      </div>
      <div className="mt-3 flex items-center gap-2 justify-end">
        <button
          className="u-btn u-btn-ghost px-3 py-1.5 text-xs text-[var(--u-danger)]"
          disabled={busy}
          onClick={() => onResolve("reject_new")}
        >
          {S.review.rejectNew}
        </button>
        <button
          className="u-btn u-btn-ghost px-3 py-1.5 text-xs"
          disabled={busy}
          onClick={() => onResolve("keep")}
        >
          {S.review.keepBoth}
        </button>
        {needsDate && (
          <input
            className="input-dark u-num w-28 px-2 py-1.5 text-xs text-center"
            placeholder={S.review.closeAtPlaceholder}
            value={closeAt}
            onChange={(e) => setCloseAt(e.target.value)}
          />
        )}
        <button
          className="u-btn u-btn-ghost px-3 py-1.5 text-xs"
          disabled={busy || (needsDate && !closeAtIso)}
          onClick={() => onResolve("close", closeAtIso)}
        >
          {c.new_valid_from
            ? S.review.closeOldAt(c.new_valid_from.slice(0, 10))
            : S.review.closeOld}
        </button>
      </div>
    </div>
  );
}

/** A fact row for "the newer document no longer mentions this". The
 *  actions are Reject (the extraction was wrong) or Close at date (this fact ended). */
function UnconfirmedRow({
  fact,
  busy,
  onReject,
  onClose,
}: {
  fact: FactReviewItem;
  busy: boolean;
  onReject: () => void;
  onClose: (validTo: string) => void;
}) {
  const [closeAt, setCloseAt] = useState("");
  const closeAtIso = /^\d{4}-\d{2}-\d{2}$/.test(closeAt.trim())
    ? `${closeAt.trim()}T00:00:00Z`
    : undefined;
  const range = dateRange(fact.valid_from, fact.valid_to);

  return (
    <div className="glass rounded-xl p-4">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-medium text-white">
          {fact.subject_name}
        </span>
        <span className="text-xs text-neutral-500">
          —{" "}
          <span
            className={
              fact.predicate_label === null
                ? "italic text-neutral-600"
                : undefined
            }
          >
            {fact.predicate_label ?? S.graph.unknownPredicate}
          </span>{" "}
          →
        </span>
        <span className="text-sm font-medium text-white">
          {fact.object_name ?? "?"}
        </span>
        {range && (
          <span className="u-num text-xs text-neutral-500">({range})</span>
        )}
      </div>
      {fact.quote && (
        <p className="mt-2 text-xs text-neutral-500 italic line-clamp-2">
          “{fact.quote}”
        </p>
      )}
      <div className="mt-3 flex items-center gap-2 justify-end">
        <button
          className="u-btn u-btn-ghost px-3 py-1.5 text-xs text-[var(--u-danger)]"
          disabled={busy}
          onClick={onReject}
        >
          {S.review.reject}
        </button>
        <input
          className="input-dark u-num w-28 px-2 py-1.5 text-xs text-center"
          placeholder={S.review.closeAtPlaceholder}
          value={closeAt}
          onChange={(e) => setCloseAt(e.target.value)}
        />
        <button
          className="u-btn u-btn-ghost px-3 py-1.5 text-xs"
          disabled={busy || !closeAtIso}
          onClick={() => closeAtIso && onClose(closeAtIso)}
        >
          {closeAt.trim()
            ? S.review.closeFactAt(closeAt.trim())
            : S.review.closeFact}
        </button>
      </div>
    </div>
  );
}

function MergeRow({
  merge,
  busy,
  onRevert,
}: {
  merge: MergeLog;
  busy: boolean;
  onRevert: () => void;
}) {
  return (
    <div className="glass rounded-xl px-4 py-3 flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm text-neutral-300 truncate">
          <span className="text-neutral-500">{merge.source_name}</span>
          <span className="text-neutral-600"> → </span>
          <span className="text-white">{merge.target_name}</span>
        </div>
        <div className="text-xs text-neutral-500 truncate">
          {merge.merged_by_name
            ? S.review.mergedBy(merge.merged_by_name)
            : S.review.mergedByAi}
          {" · "}
          {merge.created_at.slice(0, 10)}
          {merge.reason ? ` · ${escalationText(merge.reason)}` : ""}
        </div>
      </div>
      {merge.reverted_at ? (
        <span className="u-chip u-chip-neutral shrink-0">
          {S.review.reverted}
        </span>
      ) : (
        <button
          className="u-btn u-btn-ghost px-3 py-1.5 text-xs shrink-0"
          disabled={busy}
          onClick={onRevert}
        >
          {S.review.revert}
        </button>
      )}
    </div>
  );
}

/* ---------- Decision log row ---------- */

const DECISION_TONE: Record<string, ChipTone> = {
  "review.merge": "violet",
  "merge.manual": "violet",
  "review.keep": "neutral",
  "fact.confirm": "success",
  "fact.reject": "danger",
  "conflict.reject_new": "danger",
  "fact.close": "info",
  "conflict.close_old": "info",
  "conflict.keep_both": "neutral",
  "merge.revert": "warn",
};

function DecisionRow({ e }: { e: ReviewHistoryEvent }) {
  // `detail` is a self-contained snapshot taken at decision time. It
  // does not join against live data, so the log stays complete even after the fact is deleted.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = e.detail as any;
  let text: string;
  if (e.action.startsWith("review.")) text = `${d.left} ≟ ${d.right}`;
  else if (e.action.startsWith("fact."))
    text = `${d.subject} — ${d.predicate ?? "?"} → ${d.object ?? "?"}`;
  else if (e.action.startsWith("conflict."))
    text = `${d.old_subject} — ${d.predicate} → ${d.old_object ?? "?"} · vs · ${
      d.new_object ?? d.new_subject
    }`;
  else text = `${d.source} → ${d.target}`;

  return (
    <div className="glass rounded-xl px-4 py-3 flex items-center gap-3">
      <Chip tone={DECISION_TONE[e.action] ?? "neutral"}>
        {S.review.decisionActions[e.action] ?? e.action}
      </Chip>
      <span className="text-sm text-neutral-300 truncate min-w-0">{text}</span>
      {typeof d.confidence === "number" && (
        <span className="u-num text-xs text-neutral-600 shrink-0">
          {Math.round(d.confidence * 100)}%
        </span>
      )}
      {typeof d.valid_to === "string" && (
        <span className="u-num text-xs text-neutral-600 shrink-0">
          → {d.valid_to.slice(0, 10)}
        </span>
      )}
      <span className="ml-auto shrink-0 text-xs text-neutral-500">
        {e.actor_name ?? S.review.aiActor}
        {" · "}
        <span className="u-num">{e.created_at.slice(0, 10)}</span>
      </span>
    </div>
  );
}

/** A pending data mapping decision (ADR 0011).
 *
 * The main display value is **"how to compute this number"**: SQL,
 * expression, or table name, in that priority order, since a reviewer
 * judges exactly that. The concept name and source identify the mapping,
 * and `unit` is a dimension the answer must carry. */
/** A self-contradiction inside the ontology itself. **This shows two
 *  buttons, not three**, because this check never looks at the data.
 *  So "the data is wrong" is not an outcome here; the choice is only
 *  "I changed the ontology" or "leave this as is". */
function DefectRow({
  defect: d,
  busy,
  onDecide,
}: {
  defect: OntologyDefect;
  busy: boolean;
  onDecide: (resolution: "fixed" | "accepted") => void;
}) {
  const what = {
    symmetric_and_asymmetric: S.review.defectSymAsym,
    transitive_and_functional: S.review.defectTransFunc,
    subclass_cycle: S.review.defectCycle,
    disjoint_with_ancestor: S.review.defectDisjointAncestor,
    inherits_disjoint: S.review.defectInheritsDisjoint,
    inverse_of_itself: S.review.defectInverseSelf,
    inverse_not_mutual: S.review.defectInverseNotMutual,
    sub_property_cycle: S.review.defectSubPropertyCycle,
  }[d.kind];
  // The last two kinds have a consequence worth stating: an unsatisfiable type raises no error; it just stays permanently empty.
  const unsatisfiable =
    d.kind === "disjoint_with_ancestor" || d.kind === "inherits_disjoint";
  return (
    <div className="glass rounded-xl p-3">
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-sm text-[var(--u-danger)]">{what}</span>
        {d.subject_label && (
          <span className="text-xs text-neutral-300">{d.subject_label}</span>
        )}
        {d.other_label && (
          <span className="text-xs text-neutral-500">↔ {d.other_label}</span>
        )}
      </div>
      {d.path_labels.length > 0 && (
        <div className="mt-1 text-xs text-neutral-400">
          {d.path_labels.join(" → ")} → {d.path_labels[0]}
        </div>
      )}
      {unsatisfiable && (
        <p className="mt-1 text-xs text-neutral-500">
          {S.review.defectNeverInstantiable}
        </p>
      )}
      <div className="mt-2 flex gap-1.5">
        <button
          className="u-btn u-btn-ghost px-3 py-1.5 text-xs"
          disabled={busy}
          onClick={() => onDecide("accepted")}
        >
          {S.review.defectAccepted}
        </button>
        <button
          className="u-btn u-btn-primary px-3 py-1.5 text-xs"
          disabled={busy}
          onClick={() => onDecide("fixed")}
        >
          {S.review.defectFixed}
        </button>
      </div>
    </div>
  );
}

/** One axiom violation. **This shows three buttons, not two.** The third
 *  button is an outcome unique to this queue: the conflict can come from
 *  the definition itself (a user's imported ontology declared a
 *  relation asymmetric, but that relation is actually mutual in the
 *  user's corpus). In that case, the fix belongs in the ontology, not in twenty individual facts. */
function ViolationRow({
  violation: v,
  busy,
  onDecide,
}: {
  violation: AxiomViolation;
  busy: boolean;
  onDecide: (
    resolution: "fact_retracted" | "axiom_relaxed" | "accepted",
  ) => void;
}) {
  const what = {
    self_loop: S.review.violationSelfLoop,
    asymmetry: S.review.violationAsymmetry,
    cycle: S.review.violationCycle,
    functional: S.review.violationFunctional,
  }[v.kind];
  // For a self-loop violation, the two facts are the same fact. Showing it once is correct; showing it twice would look like a bug.
  const single = v.left_fact === v.right_fact;
  return (
    <div className="glass rounded-xl p-3">
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-sm text-[var(--u-warn)]">{what}</span>
        {v.predicate && (
          <span className="text-[11px] text-neutral-500">
            {S.review.violationVia(v.predicate)}
          </span>
        )}
        {v.path_len > 0 && (
          <span className="text-[11px] text-neutral-500">
            {S.review.violationPath(v.path_len)}
          </span>
        )}
      </div>
      <div className="mt-1.5 space-y-1">
        <div className="text-xs text-neutral-300">{v.left_text}</div>
        {!single && (
          <div className="text-xs text-neutral-300">{v.right_text}</div>
        )}
      </div>
      <div className="mt-2 flex gap-1.5 flex-wrap">
        <button
          className="u-btn u-btn-ghost px-3 py-1.5 text-xs"
          disabled={busy}
          onClick={() => onDecide("accepted")}
        >
          {S.review.acceptBoth}
        </button>
        <button
          className="u-btn u-btn-ghost px-3 py-1.5 text-xs"
          disabled={busy}
          onClick={() => onDecide("axiom_relaxed")}
        >
          {S.review.relaxAxiom}
        </button>
        <button
          className="u-btn u-btn-primary px-3 py-1.5 text-xs"
          disabled={busy}
          onClick={() => onDecide("fact_retracted")}
        >
          {S.review.retractFact}
        </button>
      </div>
    </div>
  );
}

/* ---------- Page layout: a left-side category rail plus a single content area ---------- */

type Sel =
  | "duplicates"
  | "conflicts"
  | "unconfirmed"
  | "lowconf"
  // Axiom violations (ADR 0002, R0). **This is separate from
  // `conflicts`.** That queue asks "which fact is correct"; this queue
  // can also answer "the axiom itself is wrong", a different outcome.
  | "violations"
  // Ontology self-contradictions. **This is separate from
  // `violations`.** That queue examines facts; this queue examines only definitions.
  | "defects"
  | "decisions"
  | "merges";

/** The queues that page through the server (the decision log has its own separate endpoint). */
const QUEUE_FETCHED: ReviewQueue[] = [
  "duplicates",
  "conflicts",
  "unconfirmed",
  "lowconf",
  "violations",
  "defects",
  "merges",
];

const QUEUE_ORDER: Sel[] = [
  "duplicates",
  "conflicts",
  "unconfirmed",
  "lowconf",
  "violations",
  "defects",
];
const PAGE_SIZE: Record<Sel, number> = {
  duplicates: DUP_PAGE,
  conflicts: CONFLICT_PAGE,
  unconfirmed: FACT_PAGE,
  lowconf: FACT_PAGE,
  violations: FACT_PAGE,
  defects: FACT_PAGE,
  merges: MERGE_PAGE,
  decisions: 20,
};

function RailHeader({ label }: { label: string }) {
  return (
    <div className="px-4 pt-4 pb-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-neutral-500">
      {label}
    </div>
  );
}

function RailItem({
  active,
  label,
  count,
  onClick,
  external,
}: {
  active: boolean;
  label: string;
  count: number | null;
  onClick: () => void;
  /** This queue is not handled on this page. This mark shows the destination, so a click does not look like it did nothing. */
  external?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] transition-colors",
        active
          ? "u-nav-active"
          : "text-neutral-400 hover:bg-white/[0.05] hover:text-neutral-200",
      )}
    >
      <span className="truncate">{label}</span>
      {external && <ArrowUpRight size={11} className="shrink-0 opacity-50" />}
      {count !== null && (
        <span
          className={cn(
            "ml-auto shrink-0 u-num text-[10.5px]",
            count > 0 ? "text-neutral-400" : "text-neutral-700",
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}

export function Review() {
  const kbId = useKbId();
  const { kb } = useKb();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [sel, setSel] = useState<Sel | null>(null);
  const [page, setPage] = useState(0);

  // Queue changes arrive through the SSE event stream (useKbEvents,
  // mounted in Shell), so no polling is needed here.
  //
  // **This fetches by queue and page number.** An earlier version
  // fetched all eight queues at once, one hundred rows per queue, and
  // paged them on the client. The left-rail badge then showed a
  // truncated number, and anything past page ten did not exist in the
  // UI. Now, the count always comes back as a server-side `COUNT`,
  // independent of the page size, and the content returns only the current queue's page.
  const queueSel: ReviewQueue = QUEUE_FETCHED.includes(
    (sel ?? "duplicates") as ReviewQueue,
  )
    ? ((sel ?? "duplicates") as ReviewQueue)
    : "duplicates";
  const review = useQuery({
    queryKey: ["review", kb?.id, queueSel, page],
    queryFn: () =>
      api.review(
        kb!.id,
        queueSel,
        PAGE_SIZE[queueSel as Sel],
        page * PAGE_SIZE[queueSel as Sel],
      ),
    enabled: !!kb,
    // This avoids a blank flash on the previous page while paging. The
    // count and the layout stay in place; only the items change.
    placeholderData: (prev) => prev,
  });
  // Decision log: paged by the server, fetched only when this tab is selected.
  const history = useQuery({
    queryKey: ["reviewHistory", kb?.id, page],
    queryFn: () => api.reviewHistory(kb!.id, page),
    enabled: !!kb && sel === "decisions",
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["review", kb?.id] });
    queryClient.invalidateQueries({ queryKey: ["reviewHistory", kb?.id] });
    queryClient.invalidateQueries({ queryKey: ["graph"] });
  };

  const decide = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "merge" | "keep" }) =>
      api.decideReview(kb!.id, id, action),
    onSettled: invalidate,
  });
  const factAction = useMutation({
    mutationFn: ({
      id,
      action,
    }: {
      id: string;
      action: "confirm" | "reject";
    }) =>
      action === "confirm"
        ? api.confirmFact(kb!.id, id)
        : api.rejectFact(kb!.id, id),
    onSettled: invalidate,
  });
  const defectAction = useMutation({
    mutationFn: ({
      id,
      resolution,
    }: {
      id: string;
      resolution: "fixed" | "accepted";
    }) => api.decideDefect(kb!.id, id, resolution),
    onSettled: invalidate,
  });
  const violationAction = useMutation({
    mutationFn: ({
      id,
      resolution,
    }: {
      id: string;
      resolution: "fact_retracted" | "axiom_relaxed" | "accepted";
    }) => api.decideViolation(kb!.id, id, resolution),
    onSettled: invalidate,
  });
  // The check is a synchronous, pure computation, so it mutates directly
  // with no queue needed. After it runs, the report stays next to the
  // button. **Zero is not the same as zero here**: with no axioms
  // defined, the message must say "no criterion to check", not "no conflict found".
  const runCheck = useMutation({
    mutationFn: () => api.runConsistencyCheck(kb!.id),
    onSettled: invalidate,
  });
  const revert = useMutation({
    mutationFn: (mergeId: string) => api.revertMerge(kb!.id, mergeId),
    onSettled: invalidate,
  });
  const conflictAction = useMutation({
    mutationFn: ({
      id,
      action,
      closeAt,
    }: {
      id: string;
      action: "close" | "keep" | "reject_new";
      closeAt?: string;
    }) => api.resolveConflict(kb!.id, id, { action, close_at: closeAt }),
    onSettled: invalidate,
  });

  const closeFactAction = useMutation({
    mutationFn: ({ id, validTo }: { id: string; validTo: string }) =>
      api.closeFact(kb!.id, id, validTo),
    onSettled: invalidate,
  });

  // **The badge reads the server's `COUNT`, not the list length.** This
  // was the root cause of the earlier bug where the database held 164
  // rows and the UI showed 100. An array's length reflects the page
  // size, not the total row count in the database.
  const c = review.data?.counts;
  // `mappings` is not a queue on this page (approval happens on the
  // "Data mappings" page), but this still fetches its count. The inbox
  // should always state how many items are waiting.
  const counts: Record<Sel | "mappings", number> = {
    duplicates: c?.duplicates ?? 0,
    conflicts: c?.conflicts ?? 0,
    unconfirmed: c?.unconfirmed ?? 0,
    lowconf: c?.lowconf ?? 0,
    mappings: c?.mappings ?? 0,
    violations: c?.violations ?? 0,
    defects: c?.defects ?? 0,
    merges: c?.merges ?? 0,
    decisions: history.data?.total ?? 0,
  };
  // The current queue's page. **The server already sliced it**; this
  // only narrows the type by queue. A wrong narrowing shows up at render
  // time, instead of silently displaying an empty list.
  const rows = review.data?.queue === queueSel ? (review.data.items ?? []) : [];
  const asDuplicates = () => rows as ReviewItem[];
  const asFacts = () => rows as FactReviewItem[];
  const asConflicts = () => rows as ConflictItem[];
  const asViolations = () => rows as AxiomViolation[];
  const asDefects = () => rows as OntologyDefect[];
  const asMerges = () => rows as MergeLog[];
  const queueEmpty = QUEUE_ORDER.every((k) => counts[k] === 0);

  // On the first data load, this selects the first non-empty queue. If
  // every queue is empty, this lands on "duplicates" and shows the "all clear" message.
  useEffect(() => {
    if (sel === null && c)
      setSel(QUEUE_ORDER.find((k) => counts[k] > 0) ?? "duplicates");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c]);

  const select = (s: Sel) => {
    setSel(s);
    setPage(0);
  };

  const active = sel ?? "duplicates";
  const isQueueSel = QUEUE_ORDER.includes(active);

  const SECTION: Record<Sel, { title: string; hint: string | null }> = {
    duplicates: { title: S.review.duplicates, hint: S.review.duplicatesHint },
    conflicts: { title: S.review.conflicts, hint: S.review.conflictsHint },
    unconfirmed: {
      title: S.review.unconfirmed,
      hint: S.review.unconfirmedHint,
    },
    lowconf: {
      title: S.review.lowConfidence,
      hint: S.review.lowConfidenceHint,
    },
    violations: {
      title: S.review.violations,
      hint: S.review.violationsHint,
    },
    defects: { title: S.review.defects, hint: S.review.defectsHint },
    decisions: { title: S.review.decisionsTitle, hint: S.review.decisionsHint },
    merges: { title: S.review.mergeHistory, hint: null },
  };

  return (
    <div className="h-full flex">
      {/* Left rail: queue categories plus history, each with a live count refreshed through SSE. */}
      {/* `overflow-y-auto`: on a short window, this rail's content is
          taller than the rail itself, and the bottom link goes to
          another page. Without scrolling, that link would be clipped
          and unreachable. `mt-auto` only pushes it to the bottom when
          extra space exists, so both properties are needed together. */}
      <aside className={`${RAIL_CLS} flex flex-col overflow-y-auto u-scroll`}>
        <RailHeader label={S.review.tabQueue} />
        <div className="px-2 space-y-0.5">
          <RailItem
            active={active === "duplicates"}
            label={S.review.railDuplicates}
            count={counts.duplicates}
            onClick={() => select("duplicates")}
          />
          <RailItem
            active={active === "conflicts"}
            label={S.review.railConflicts}
            count={counts.conflicts}
            onClick={() => select("conflicts")}
          />
          <RailItem
            active={active === "unconfirmed"}
            label={S.review.railUnconfirmed}
            count={counts.unconfirmed}
            onClick={() => select("unconfirmed")}
          />
          <RailItem
            active={active === "lowconf"}
            label={S.review.railLowConfidence}
            count={counts.lowconf}
            onClick={() => select("lowconf")}
          />
          <RailItem
            active={active === "violations"}
            label={S.review.railViolations}
            count={counts.violations}
            onClick={() => select("violations")}
          />
          <RailItem
            active={active === "defects"}
            label={S.review.railDefects}
            count={counts.defects}
            onClick={() => select("defects")}
          />
        </div>
        <RailHeader label={S.review.tabHistory} />
        <div className="px-2 space-y-0.5">
          <RailItem
            active={active === "decisions"}
            label={S.review.railDecisions}
            count={null}
            onClick={() => select("decisions")}
          />
          <RailItem
            active={active === "merges"}
            label={S.review.railMerges}
            count={counts.merges}
            onClick={() => select("merges")}
          />
        </div>

        {/* Data mappings: **this belongs to neither group above, so it
            sits alone at the bottom.** The seven queues above all ask
            "is this piece of knowledge correct". A data mapping asks
            "how is this number computed" (ADR 0011 already separated it
            at the data level). The two items below this one are a log
            of decisions made on this page, and a mapping decision never
            enters `review_history` (that log only captures `review.`,
            `fact.`, `conflict.`, and `merge.` actions; a mapping decision
            records as `mapping.decided` instead). **The count stays
            here**, because the inbox should state how many items are
            waiting, even though the actual decision happens on that other page. */}
        <div className="mt-auto border-t border-white/5 px-2 py-2">
          <RailItem
            active={false}
            label={S.review.railMappings}
            count={counts.mappings}
            onClick={() =>
              navigate({ to: "/kb/$kbId/mappings", params: { kbId } })
            }
            external
          />
        </div>
      </aside>

      {/* Right side: shows only the selected category at a time, with a single pager. */}
      <div className="flex-1 min-w-0 overflow-y-auto u-scroll px-8 py-6">
        <div className="max-w-4xl">
          {review.isPending && (
            <p className="text-sm text-neutral-500">{S.nav.loading}</p>
          )}
          {review.isError && (
            <p className="text-sm text-rose-400">
              {(review.error as Error).message}
            </p>
          )}

          {review.data && (
            <section>
              {/* Page-level title: at the same level as Library and KB Settings (`text-lg`), not a card header. */}
              <h2 className="u-title text-lg mb-1">{SECTION[active].title}</h2>
              {SECTION[active].hint && (
                <p className="text-xs text-neutral-500 mb-3">
                  {SECTION[active].hint}
                </p>
              )}

              {/* Empty state: the whole inbox is clear, versus one
                  category being clear. **This excludes the axiom
                  violations queue**, because its own message must
                  distinguish "checked, no conflict" from "never
                  checked", and the generic empty state cannot express that difference. */}
              {isQueueSel &&
                active !== "violations" &&
                active !== "defects" &&
                counts[active] === 0 && (
                  <div className="glass rounded-xl p-10 text-center text-sm text-neutral-500">
                    {queueEmpty ? S.review.empty : S.review.categoryEmpty}
                  </div>
                )}

              {active === "duplicates" && counts.duplicates > 0 && (
                <div className="space-y-3">
                  {asDuplicates().map((item) => (
                    <DuplicateCard
                      key={item.id}
                      item={item}
                      busy={
                        decide.isPending && decide.variables?.id === item.id
                      }
                      onDecide={(action) =>
                        decide.mutate({ id: item.id, action })
                      }
                    />
                  ))}
                </div>
              )}

              {active === "conflicts" && counts.conflicts > 0 && (
                <div className="space-y-3">
                  {asConflicts().map((c) => (
                    <ConflictRow
                      key={c.id}
                      conflict={c}
                      busy={
                        conflictAction.isPending &&
                        conflictAction.variables?.id === c.id
                      }
                      onResolve={(action, closeAt) =>
                        conflictAction.mutate({ id: c.id, action, closeAt })
                      }
                    />
                  ))}
                </div>
              )}

              {active === "unconfirmed" && counts.unconfirmed > 0 && (
                <div className="space-y-3">
                  {asFacts().map((fact) => (
                    <UnconfirmedRow
                      key={fact.id}
                      fact={fact}
                      busy={
                        (factAction.isPending &&
                          factAction.variables?.id === fact.id) ||
                        (closeFactAction.isPending &&
                          closeFactAction.variables?.id === fact.id)
                      }
                      onReject={() =>
                        factAction.mutate({ id: fact.id, action: "reject" })
                      }
                      onClose={(validTo) =>
                        closeFactAction.mutate({ id: fact.id, validTo })
                      }
                    />
                  ))}
                </div>
              )}

              {active === "lowconf" && counts.lowconf > 0 && (
                <div className="space-y-3">
                  {asFacts().map((fact) => (
                    <FactRow
                      key={fact.id}
                      fact={fact}
                      busy={
                        factAction.isPending &&
                        factAction.variables?.id === fact.id
                      }
                      onConfirm={() =>
                        factAction.mutate({ id: fact.id, action: "confirm" })
                      }
                      onReject={() =>
                        factAction.mutate({ id: fact.id, action: "reject" })
                      }
                    />
                  ))}
                </div>
              )}

              {active === "defects" && (
                <div className="space-y-3">
                  {counts.defects === 0 && (
                    <div className="glass rounded-xl p-10 text-center text-sm text-neutral-500">
                      {S.review.categoryEmpty}
                    </div>
                  )}
                  {asDefects().map((d) => (
                    <DefectRow
                      key={d.id}
                      defect={d}
                      busy={
                        defectAction.isPending &&
                        defectAction.variables?.id === d.id
                      }
                      onDecide={(resolution) =>
                        defectAction.mutate({ id: d.id, resolution })
                      }
                    />
                  ))}
                </div>
              )}

              {active === "violations" && (
                <div className="space-y-3">
                  {/* The button lives inside this queue, not in the page
                      header, because only a user viewing this queue
                      wants to rerun the check. The report stays next to
                      the button; an empty result must state clearly
                      whether that means "no conflict" or "no criterion to check". */}
                  <div className="flex items-center gap-3">
                    {/* This uses the ghost style, not solid white. It is
                        the same kind of action as "explore mappings": a
                        manual trigger for an analysis, not the primary
                        action on this page. Solid white stays reserved
                        for a real decision, such as confirm or merge. */}
                    <button
                      className="u-btn u-btn-ghost px-3 py-1.5 text-xs"
                      disabled={runCheck.isPending}
                      onClick={() => runCheck.mutate()}
                    >
                      {runCheck.isPending
                        ? S.review.checking
                        : S.review.runCheck}
                    </button>
                    {runCheck.data && (
                      <span className="text-xs text-neutral-500">
                        {/* Three outcomes get three different messages.
                            **`found` is not the count to report.**
                            Rerunning the check recomputes conflicts
                            already decided; stating "3 conflicts found"
                            while the list shows only one would look like
                            the UI dropped the rest. */}
                        {runCheck.data.predicates_with_axioms === 0
                          ? S.review.checkNoAxioms
                          : runCheck.data.inserted > 0
                            ? S.review.checkFound(runCheck.data.inserted)
                            : runCheck.data.found > 0
                              ? S.review.checkNothingNew
                              : S.review.checkClean(runCheck.data.edges)}
                      </span>
                    )}
                  </div>
                  {counts.violations === 0 && !runCheck.data && (
                    <div className="glass rounded-xl p-10 text-center text-sm text-neutral-500">
                      {S.review.checkNeverRun}
                    </div>
                  )}
                  {asViolations().map((v) => (
                    <ViolationRow
                      key={v.id}
                      violation={v}
                      busy={
                        violationAction.isPending &&
                        violationAction.variables?.id === v.id
                      }
                      onDecide={(resolution) =>
                        violationAction.mutate({ id: v.id, resolution })
                      }
                    />
                  ))}
                </div>
              )}

              {active === "merges" &&
                (counts.merges === 0 ? (
                  <div className="glass rounded-xl p-10 text-center text-sm text-neutral-500">
                    {S.review.historyEmpty}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {asMerges().map((m) => (
                      <MergeRow
                        key={m.id}
                        merge={m}
                        busy={revert.isPending && revert.variables === m.id}
                        onRevert={() => revert.mutate(m.id)}
                      />
                    ))}
                  </div>
                ))}

              {active === "decisions" &&
                (history.isPending ? (
                  <p className="text-sm text-neutral-500">{S.nav.loading}</p>
                ) : (history.data?.total ?? 0) === 0 ? (
                  <div className="glass rounded-xl p-10 text-center text-sm text-neutral-500">
                    {S.review.decisionsEmpty}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {(history.data?.events ?? []).map((e) => (
                      <DecisionRow key={e.id} e={e} />
                    ))}
                  </div>
                ))}

              {/* A single pager: queue and merge lists page on the client; the decisions list pages on the server. */}
              {active !== "decisions" && (
                <Pager
                  total={counts[active]}
                  pageSize={PAGE_SIZE[active]}
                  page={page}
                  onPage={setPage}
                />
              )}
              {active === "decisions" && (
                <Pager
                  total={history.data?.total ?? 0}
                  pageSize={PAGE_SIZE.decisions}
                  page={page}
                  onPage={setPage}
                />
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

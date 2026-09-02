// The ontology editor: a master-detail two-column layout, the same structure as the
// SourcesRail in Library.
// The left column holds a filter, the Classes and Properties sections, and the
// Unmatched entry point at the bottom. The right side shows the form for the selected
// item, the unmatched signals panel, or the overview.
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ChevronRight,
  Inbox,
  Plus,
  Search,
  Upload,
  Wand2,
} from "lucide-react";
import {
  api,
  type EntityTypeView,
  type ImportPlan,
  type OntologyMiss,
  type PlannedItem,
  type OntologyProposals,
  type ResolutionOutcome,
  type TypeSuggestion,
  type RelationTypeView,
} from "../api";
import { S } from "../i18n";
import { useKb } from "../kb";
import { toast } from "../toast";
import {
  Button,
  Chip,
  ColorPicker,
  colorForKey,
  DangerConfirm,
  Dropdown,
  Input,
  Loading,
  MultiSearchSelect,
  Pager,
  PageTitle,
  RAIL_CLS,
  SearchSelect,
  cn,
  pageSlice,
} from "../ui";

/** The left rail's row height (py-1.5 plus 13px text plus the space-y gap), and the
 * space reserved at the bottom for the new-item row and the pager. */
const RAIL_ROW_H = 34;
const RAIL_RESERVED = 80;
/** The fallback row count, used before the first frame measures the height. */
const RAIL_PAGE = 14;
/** The row count per section, when the filter mixes both sections together. */
const RAIL_PAGE_MIXED = 6;

/** What the right-side detail area shows. */
type Sel =
  | { kind: "class"; id: string }
  | { kind: "relation"; id: string }
  | { kind: "new-class"; parentId: string | null }
  | { kind: "new-relation" }
  | { kind: "misses" }
  // Type refinement: replaces a roughly-right class with a more specific one.
  | { kind: "refine" }
  | { kind: "import" }
  | null;

export function Ontology() {
  const { kb } = useKb();
  const queryClient = useQueryClient();
  const [sel, setSel] = useState<Sel>(null);
  const [railTab, setRailTab] = useState<"classes" | "properties">("classes");
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Calculates rows per page from the list area's actual height, so the list fills the
  // window height, with no scrolling and no large empty space.
  const listRef = useRef<HTMLDivElement>(null);
  const [railRows, setRailRows] = useState(RAIL_PAGE);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setRailRows(
        Math.max(5, Math.floor((el.clientHeight - RAIL_RESERVED) / RAIL_ROW_H)),
      );
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const data = useQuery({
    queryKey: ["ontology", kb?.id],
    queryFn: () => api.ontology(kb!.id),
    enabled: !!kb,
  });

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["ontology", kb?.id] });
  // Every error goes through the global toast. No error line is embedded in the page.
  const onError = (e: unknown) => toast.error((e as Error).message);

  if (!kb) return <Loading>{S.nav.loading}</Loading>;
  if (data.isPending) return <Loading>{S.nav.loading}</Loading>;
  if (data.isError) return <Loading>{(data.error as Error).message}</Loading>;

  const { entity_types, relation_types, misses, dismissed_misses } = data.data;
  // An attribute does not appear in the Properties list. It belongs to a class, and the
  // user edits it in the class detail area.
  const relations = relation_types.filter((r) => r.kind !== "attribute");
  const selectedClass =
    sel?.kind === "class"
      ? (entity_types.find((t) => t.id === sel.id) ?? null)
      : null;
  const selectedProp =
    sel?.kind === "relation"
      ? (relation_types.find((r) => r.id === sel.id) ?? null)
      : null;

  return (
    <div className="h-full flex">
      {/* The left rail: a filter, two sections, and Unmatched. */}
      <aside className={`${RAIL_CLS} flex flex-col`}>
        <div className="px-3 pt-3 pb-2.5">
          <div className="relative">
            <Search
              size={12}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-600"
            />
            <input
              className="input-dark w-full pl-7 pr-2 py-1.5 text-xs"
              placeholder={S.ontology.filter}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
        </div>
        {/* This segmented switch uses the same style as the login page mode switch and
            the schedule picker: a bg-white/5 container with an inverted-color active
            state. When a filter is active, this rule has an exception: the list mixes
            both sections and shows matches from both at once. */}
        <div className="mx-3 mb-1 flex gap-1 rounded-lg bg-white/5 p-1">
          {(
            [
              ["classes", S.ontology.tabClasses],
              ["properties", S.ontology.tabProperties],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setRailTab(k)}
              className={cn(
                "flex-1 rounded-md py-1 text-[12px] font-medium text-center transition-colors",
                railTab === k
                  ? "bg-white/10 text-neutral-100"
                  : "text-neutral-500 hover:text-neutral-300",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <div
          ref={listRef}
          className="flex-1 min-h-0 overflow-hidden px-2 pt-1.5 pb-2 flex flex-col"
        >
          {/* The new-item row stays at the top. It creates a class or a relation,
              depending on the current section. */}
          {!filter.trim() && (
            <button
              onClick={() =>
                railTab === "classes"
                  ? setSel({ kind: "new-class", parentId: null })
                  : setSel({ kind: "new-relation" })
              }
              className="w-full flex items-center gap-1.5 rounded-lg px-2 py-2 mb-0.5 text-[13px] text-neutral-500 hover:bg-white/[0.05] hover:text-neutral-200 transition-colors"
            >
              <Plus size={13} />
              {railTab === "classes"
                ? S.ontology.newClass
                : S.ontology.newProperty}
            </button>
          )}
          {filter.trim() ? (
            <>
              <div className="px-2 pt-2 pb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-neutral-600">
                {S.ontology.tabClasses}
              </div>
              <ClassTree
                types={entity_types}
                filter={filter}
                collapsed={collapsed}
                onToggle={() => {}}
                selectedId={selectedClass?.id ?? null}
                onSelect={(id) => setSel({ kind: "class", id })}
                pageSize={RAIL_PAGE_MIXED}
              />
              <div className="px-2 pt-3 pb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-neutral-600">
                {S.ontology.tabProperties}
              </div>
              <PropertyList
                relations={relations}
                filter={filter}
                selectedId={selectedProp?.id ?? null}
                onSelect={(id) => setSel({ kind: "relation", id })}
                pageSize={RAIL_PAGE_MIXED}
              />
            </>
          ) : railTab === "classes" ? (
            <ClassTree
              types={entity_types}
              filter={filter}
              collapsed={collapsed}
              onToggle={(id) => {
                const next = new Set(collapsed);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                setCollapsed(next);
              }}
              selectedId={selectedClass?.id ?? null}
              onSelect={(id) => setSel({ kind: "class", id })}
              pageSize={railRows}
            />
          ) : (
            <PropertyList
              relations={relations}
              filter={filter}
              selectedId={selectedProp?.id ?? null}
              onSelect={(id) => setSel({ kind: "relation", id })}
              pageSize={railRows}
            />
          )}
        </div>
        {/* Two fixed entries about the ontology as a whole: importing an ontology from
            an outside source, or reviewing signals that extraction rejected. */}
        <button
          onClick={() => setSel({ kind: "import" })}
          className={cn(
            "shrink-0 border-t border-white/10 px-4 py-2.5 flex items-center gap-2 text-[13px] transition-colors",
            sel?.kind === "import"
              ? "u-nav-active"
              : "text-neutral-400 hover:bg-white/[0.05] hover:text-neutral-200",
          )}
        >
          <Upload size={14} className="text-neutral-500" />
          <span>{S.ontology.importShort}</span>
        </button>
        {/* Type refinement replaces a roughly-right class with a more specific one.
            **This sits next to Unmatched.** Both handle a mismatch between the ontology
            and the data, but in opposite directions: Unmatched means the ontology is
            missing something, while refinement means the ontology has a better option
            that extraction did not use. */}
        <button
          onClick={() => setSel({ kind: "refine" })}
          className={cn(
            "shrink-0 border-t border-white/10 px-4 py-2.5 flex items-center gap-2 text-[13px] transition-colors",
            sel?.kind === "refine"
              ? "u-nav-active"
              : "text-neutral-400 hover:bg-white/[0.05] hover:text-neutral-200",
          )}
        >
          <Wand2 size={14} className="text-neutral-500" />
          <span>{S.ontology.refineShort}</span>
        </button>
        {/* A fixed entry for signals that extraction did not match. It shows a count
            badge when any are pending. */}
        <button
          onClick={() => setSel({ kind: "misses" })}
          className={cn(
            "shrink-0 border-t border-white/10 px-4 py-2.5 flex items-center gap-2 text-[13px] transition-colors",
            sel?.kind === "misses"
              ? "u-nav-active"
              : "text-neutral-400 hover:bg-white/[0.05] hover:text-neutral-200",
          )}
        >
          <Inbox size={14} className="text-neutral-500" />
          <span>{S.ontology.missesShort}</span>
          {misses.length > 0 && (
            <span className="ml-auto u-num text-[10.5px] text-neutral-500 bg-white/[0.08] rounded-full px-1.5 py-px">
              {misses.length}
            </span>
          )}
        </button>
      </aside>

      {/* The right side: the detail area. When a class is selected, the form and the
          instance list spread across two columns, to use a wide screen well. */}
      <div className="flex-1 min-w-0 overflow-y-auto u-scroll px-8 py-6">
        {/* This widens to 6xl to fit three columns. The misses, relation, and overview
            views each keep their own max-w-xl padding, unaffected by this. */}
        <div className="max-w-6xl">
          {sel?.kind === "import" ? (
            <div className="max-w-xl">
              <ImportPanel kbId={kb.id} onChanged={refresh} onError={onError} />
            </div>
          ) : sel?.kind === "refine" ? (
            <div className="max-w-2xl">
              <RefinePanel kbId={kb.id} onChanged={refresh} onError={onError} />
            </div>
          ) : sel?.kind === "misses" ? (
            <div className="max-w-xl">
              <MissesPanel
                kbId={kb.id}
                misses={misses}
                dismissedMisses={dismissed_misses ?? []}
                onChanged={refresh}
                onError={onError}
              />
            </div>
          ) : sel?.kind === "new-class" || selectedClass ? (
            /* At the lg breakpoint, this is two columns: the form, then attributes and
               instances stacked. At xl, it becomes three columns side by side (the
               xl:contents wrapper dissolves into the grid). */
            <div className="grid gap-4 items-start lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)] xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)_minmax(0,1fr)]">
              <div className="glass rounded-xl p-4">
                <ClassForm
                  key={
                    selectedClass?.id ??
                    `new-${sel?.kind === "new-class" ? sel.parentId : "root"}`
                  }
                  kbId={kb.id}
                  existing={selectedClass}
                  parentId={
                    sel?.kind === "new-class"
                      ? sel.parentId
                      : (selectedClass?.primary_parent ?? null)
                  }
                  allTypes={entity_types}
                  onNewSub={
                    selectedClass
                      ? () =>
                          setSel({
                            kind: "new-class",
                            parentId: selectedClass.id,
                          })
                      : undefined
                  }
                  onDone={(createdId) => {
                    // On a successful create, this selects the new item, so the user
                    // can see it and keep editing right away.
                    if (sel?.kind === "new-class")
                      setSel(
                        createdId ? { kind: "class", id: createdId } : null,
                      );
                    refresh();
                  }}
                  onError={onError}
                />
              </div>
              {/* At lg, the right column stacks attributes and instances. At xl, this
                  dissolves into two separate grid columns. */}
              {selectedClass && (
                <div className="grid gap-4 items-start xl:contents">
                  <AttributesCard
                    kbId={kb.id}
                    type={selectedClass}
                    attributes={relation_types.filter(
                      (r) =>
                        r.kind === "attribute" &&
                        r.domains.includes(selectedClass.id),
                    )}
                    onChanged={refresh}
                    onError={onError}
                  />
                  <InstancesCard kbId={kb.id} type={selectedClass} />
                </div>
              )}
            </div>
          ) : sel?.kind === "new-relation" || selectedProp ? (
            <div className="glass rounded-xl p-4 max-w-xl">
              <PropertyForm
                key={selectedProp?.id ?? "new"}
                kbId={kb.id}
                existing={selectedProp}
                allTypes={entity_types}
                allRelations={relations}
                onDone={(createdId) => {
                  if (sel?.kind === "new-relation")
                    setSel(
                      createdId ? { kind: "relation", id: createdId } : null,
                    );
                  refresh();
                }}
                onError={onError}
              />
            </div>
          ) : (
            /* The overview, shown when no item is selected. */
            <div className="glass rounded-xl p-6 max-w-xl">
              <PageTitle className="mb-1">{S.ontology.title}</PageTitle>
              <p className="text-xs text-neutral-500 u-num">
                {S.ontology.overviewStats(
                  entity_types.length,
                  relations.length,
                )}
              </p>
              <p className="mt-3 text-sm text-neutral-400">
                {S.ontology.overviewHint}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------- Instance list: entities of the selected class, server-paged, click to open the graph ---------- */

function InstancesCard({ kbId, type }: { kbId: string; type: EntityTypeView }) {
  const PER = 12;
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [type.id]);
  const q = useQuery({
    queryKey: ["type-entities", kbId, type.id, page],
    queryFn: () => api.typeEntities(kbId, type.id, page, PER),
  });
  const total = q.data?.total ?? 0;
  const rows = q.data?.entities ?? [];
  if (!q.isPending && total === 0) return null; // Takes no layout space when there are no instances.

  return (
    <div className="glass rounded-xl p-4">
      <div className="mb-1.5 flex items-baseline gap-2">
        <h3 className="text-sm font-bold text-neutral-200">
          {S.ontology.instances}
        </h3>
        <span className="u-num text-xs text-neutral-500">{total}</span>
      </div>
      <div className="divide-y divide-white/[0.06]">
        {rows.map((e) => (
          <Link
            key={e.id}
            to="/kb/$kbId/graph"
            params={{ kbId }}
            search={{ entity: e.id }}
            className="flex items-center gap-2 py-1.5 text-sm text-neutral-300 hover:text-white"
          >
            <span
              className={`h-2 w-2 shrink-0 ${type.shape === "square" ? "" : "rounded-full"}`}
              style={{ background: type.color }}
            />
            <span className="truncate">{e.name}</span>
            <span className="ml-auto shrink-0 u-num text-[10.5px] text-neutral-600">
              {S.ontology.instanceFacts(e.fact_count)}
            </span>
          </Link>
        ))}
      </div>
      <Pager total={total} pageSize={PER} page={page} onPage={setPage} />
    </div>
  );
}

/* ---------- Attributes card: literal-value fields of the selected class, added, edited, and deleted inline ---------- */

function AttributesCard({
  kbId,
  type,
  attributes,
  onChanged,
  onError,
}: {
  kbId: string;
  type: EntityTypeView;
  attributes: RelationTypeView[];
  onChanged: () => void;
  onError: (e: unknown) => void;
}) {
  // Inline editing: only one row expands at a time, identified by attribute id or "new".
  const [editing, setEditing] = useState<string | null>(null);
  useEffect(() => setEditing(null), [type.id]);

  return (
    <div className="glass rounded-xl p-4">
      <div className="mb-1 flex items-baseline gap-2">
        <h3 className="text-sm font-bold text-neutral-200">
          {S.ontology.attributes}
        </h3>
        {attributes.length > 0 && (
          <span className="u-num text-xs text-neutral-500">
            {attributes.length}
          </span>
        )}
      </div>
      <p className="text-xs text-neutral-500 mb-2">
        {S.ontology.attributesHint}
      </p>
      <div className="divide-y divide-white/[0.06]">
        {attributes.map((a) =>
          editing === a.id ? (
            <AttributeForm
              key={a.id}
              kbId={kbId}
              typeId={type.id}
              existing={a}
              onDone={() => {
                setEditing(null);
                onChanged();
              }}
              onCancel={() => setEditing(null)}
              onError={onError}
            />
          ) : (
            <button
              key={a.id}
              onClick={() => setEditing(a.id)}
              className="w-full flex items-center gap-2 py-1.5 text-sm text-left text-neutral-300 hover:text-white"
            >
              <span className="truncate">{a.label}</span>
              <Chip tone="neutral">
                {S.ontology.datatypeNames[a.datatype ?? "text"]}
              </Chip>
              {a.unit && (
                <span className="text-xs text-neutral-500 shrink-0">
                  {a.unit}
                </span>
              )}
              {a.functional && <Chip tone="info">1:1</Chip>}
              <span className="ml-auto shrink-0 u-num text-[10.5px] text-neutral-600">
                {S.ontology.usage(a.usage)}
              </span>
            </button>
          ),
        )}
      </div>
      {editing === "new" ? (
        <div className="pt-2">
          <AttributeForm
            kbId={kbId}
            typeId={type.id}
            existing={null}
            onDone={() => {
              setEditing(null);
              onChanged();
            }}
            onCancel={() => setEditing(null)}
            onError={onError}
          />
        </div>
      ) : (
        <button
          onClick={() => setEditing("new")}
          className="mt-1.5 flex items-center gap-1.5 text-[13px] text-neutral-500 hover:text-neutral-200 transition-colors"
        >
          <Plus size={13} />
          {S.ontology.newAttribute}
        </button>
      )}
    </div>
  );
}

function AttributeForm({
  kbId,
  typeId,
  existing,
  onDone,
  onCancel,
  onError,
}: {
  kbId: string;
  typeId: string;
  existing: RelationTypeView | null;
  onDone: () => void;
  onCancel: () => void;
  onError: (e: unknown) => void;
}) {
  const [key, setKey] = useState(existing?.key ?? "");
  const [label, setLabel] = useState(existing?.label ?? "");
  const [datatype, setDatatype] = useState(existing?.datatype ?? "text");
  const [unit, setUnit] = useState(existing?.unit ?? "");
  // A single value means functional: a new value closes the old value through the
  // temporal engine, which is the source of attribute history. Most attributes work
  // this way, so this defaults to on.
  const [single, setSingle] = useState(existing?.functional ?? true);
  const [description, setDescription] = useState(existing?.description ?? "");

  const save = useMutation({
    mutationFn: async (): Promise<unknown> =>
      existing
        ? api.updateRelationType(kbId, existing.id, {
            label,
            temporal: existing.temporal,
            functional: single,
            inverse_functional: false,
            description,
            datatype,
            unit,
          })
        : api.createRelationType(kbId, {
            key,
            label,
            kind: "attribute",
            domains: [typeId],
            temporal: "state",
            functional: single,
            inverse_functional: false,
            description,
            datatype,
            unit,
          }),
    onSuccess: () => {
      toast.success(existing ? S.toast.saved : S.toast.created);
      onDone();
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: () => api.deleteRelationType(kbId, existing!.id),
    onSuccess: () => {
      toast.success(S.toast.deleted);
      onDone();
    },
    onError,
  });

  const lbl = "block text-xs font-medium text-neutral-500 mb-1";
  return (
    <div className="py-2.5 space-y-2.5">
      {!existing && (
        <div className="flex gap-2">
          <div className="flex-1">
            <label className={lbl}>{S.ontology.key}</label>
            <Input
              value={key}
              onChange={(e) => setKey(e.target.value)}
              className="w-full"
              placeholder="salary"
            />
          </div>
          <div className="flex-1">
            <label className={lbl}>{S.ontology.label}</label>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="w-full"
            />
          </div>
        </div>
      )}
      {existing && (
        <div>
          <label className={lbl}>{S.ontology.label}</label>
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="w-full"
          />
        </div>
      )}
      <div className="flex gap-2">
        <div className="flex-1">
          <label className={lbl}>{S.ontology.attrDatatype}</label>
          <Dropdown
            value={datatype}
            onChange={(v) => setDatatype(v as typeof datatype)}
            className="w-full"
            options={(["text", "number", "date", "bool"] as const).map((d) => ({
              value: d,
              label: S.ontology.datatypeNames[d],
            }))}
          />
        </div>
        <div className="flex-1">
          <label className={lbl}>
            {S.ontology.attrUnit}{" "}
            <span className="text-neutral-600">
              ({S.ontology.attrUnitHint})
            </span>
          </label>
          <Input
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            className="w-full"
          />
        </div>
      </div>
      <label className="flex items-center gap-2 text-[13px] text-neutral-300">
        <input
          type="checkbox"
          checked={single}
          onChange={(e) => setSingle(e.target.checked)}
        />
        {S.ontology.attrSingle}
      </label>
      <div>
        <label className={lbl}>{S.ontology.description}</label>
        <textarea
          className="input-dark w-full px-3 py-2 text-sm min-h-[3.5rem] resize-y"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={() => save.mutate()}
          disabled={
            save.isPending || !label.trim() || (!existing && !key.trim())
          }
        >
          {S.ontology.save}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {S.ontology.cancel}
        </Button>
        {existing && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            disabled={existing.usage > 0}
            title={existing.usage > 0 ? S.ontology.deleteBlocked : undefined}
            onClick={() => remove.mutate()}
          >
            {S.ontology.delete}
          </Button>
        )}
      </div>
    </div>
  );
}

/* ---------- Left rail section headers ---------- */

/* ---------- Class hierarchy tree, collapsible, flattened when a filter is active ---------- */

function ClassTree({
  types,
  filter,
  collapsed,
  onToggle,
  selectedId,
  onSelect,
  pageSize,
}: {
  types: EntityTypeView[];
  filter: string;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  pageSize: number;
}) {
  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (q) {
      // Filter mode: flattens the matching items. Both label and key match.
      return types
        .filter(
          (t) =>
            t.label.toLowerCase().includes(q) ||
            t.key.toLowerCase().includes(q),
        )
        .map((t) => ({ t, depth: 0, hasChildren: false }));
    }
    const children = new Map<string | null, EntityTypeView[]>();
    for (const t of types) {
      const p = t.primary_parent ?? null;
      if (!children.has(p)) children.set(p, []);
      children.get(p)!.push(t);
    }
    const out: { t: EntityTypeView; depth: number; hasChildren: boolean }[] =
      [];
    const walk = (parent: string | null, depth: number) => {
      for (const t of children.get(parent) ?? []) {
        const kids = children.get(t.id) ?? [];
        out.push({ t, depth, hasChildren: kids.length > 0 });
        if (!collapsed.has(t.id)) walk(t.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [types, filter, collapsed]);

  // Half-screen paging: a filter change resets to the first page.
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [filter]);
  const { rows: paged, safe } = pageSlice(rows, page, pageSize);

  return (
    <div className="space-y-0.5">
      {paged.map(({ t, depth, hasChildren }) => (
        <button
          key={t.id}
          onClick={() => onSelect(t.id)}
          style={{ paddingLeft: `${6 + depth * 14}px` }}
          className={cn(
            "w-full text-left rounded-lg py-1.5 pr-2 text-[13px] flex items-center gap-1.5",
            selectedId === t.id
              ? "u-nav-active"
              : "hover:bg-white/[0.05] text-neutral-400 hover:text-neutral-200",
          )}
        >
          {/* The collapse handle. It renders only when the class has children, and
              clicking it does not select the row. */}
          {hasChildren ? (
            <span
              onClick={(e) => {
                e.stopPropagation();
                onToggle(t.id);
              }}
              className="shrink-0 text-neutral-600 hover:text-neutral-300"
            >
              <ChevronRight
                size={12}
                className={cn(
                  "transition-transform",
                  !collapsed.has(t.id) && "rotate-90",
                )}
              />
            </span>
          ) : (
            <span className="w-3 shrink-0" />
          )}
          {/* A square has right angles, to stand apart from a circle. The graph nodes
              use the same distinction. */}
          <span
            className={`h-2.5 w-2.5 shrink-0 ${t.shape === "square" ? "" : "rounded-full"}`}
            style={{ background: t.color }}
          />
          {/* This list does not show a usage count per item. At scale, computing and
              rendering that count for every row is expensive; the user checks usage
              in the form instead. */}
          <span className="truncate">{t.label}</span>
        </button>
      ))}
      <Pager
        total={rows.length}
        pageSize={pageSize}
        page={safe}
        onPage={setPage}
      />
    </div>
  );
}

/* ---------- Relation list ---------- */

function PropertyList({
  relations,
  filter,
  selectedId,
  onSelect,
  pageSize,
}: {
  relations: RelationTypeView[];
  filter: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  pageSize: number;
}) {
  const q = filter.trim().toLowerCase();
  const rows = q
    ? relations.filter(
        (r) =>
          r.label.toLowerCase().includes(q) || r.key.toLowerCase().includes(q),
      )
    : relations;
  // Half-screen paging: a filter change resets to the first page.
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [filter]);
  const { rows: paged, safe } = pageSlice(rows, page, pageSize);
  return (
    <div className="space-y-0.5">
      {paged.map((r) => (
        <button
          key={r.id}
          onClick={() => onSelect(r.id)}
          style={{ paddingLeft: "6px" }}
          className={cn(
            "w-full text-left rounded-lg py-1.5 pr-2 text-[13px] flex items-center gap-1.5",
            selectedId === r.id
              ? "u-nav-active"
              : "hover:bg-white/[0.05] text-neutral-400 hover:text-neutral-200",
          )}
        >
          {/* This leaves only the collapse-handle slot at the start, so the text
              aligns with the left edge of a class row's marker dot. */}
          <span className="w-3 shrink-0" />
          <span className="truncate">{r.label}</span>
          {r.functional && <Chip tone="info">1:1</Chip>}
        </button>
      ))}
      <Pager
        total={rows.length}
        pageSize={pageSize}
        page={safe}
        onPage={setPage}
      />
    </div>
  );
}

/* ---------- Class form ---------- */

/** The candidates for the parent-class dropdown, in tree order with indentation to
 * show the hierarchy. This excludes the class itself and all its descendants, to
 * prevent a cycle. */
function parentOptions(
  allTypes: EntityTypeView[],
  selfId: string | undefined,
): { value: string; label: string; indent: number }[] {
  const excluded = new Set<string>();
  if (selfId) {
    excluded.add(selfId);
    // Collects all descendants by scanning repeatedly until nothing changes. The number
    // of classes is small, so an O(n²) scan is fine.
    let grew = true;
    while (grew) {
      grew = false;
      for (const t of allTypes) {
        if (t.parents.some((p) => excluded.has(p)) && !excluded.has(t.id)) {
          excluded.add(t.id);
          grew = true;
        }
      }
    }
  }
  const children = new Map<string | null, EntityTypeView[]>();
  for (const t of allTypes) {
    const p = t.primary_parent ?? null;
    if (!children.has(p)) children.set(p, []);
    children.get(p)!.push(t);
  }
  const out: { value: string; label: string; indent: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const t of children.get(parent) ?? []) {
      if (excluded.has(t.id)) continue;
      out.push({ value: t.id, label: t.label, indent: depth });
      walk(t.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

function ClassForm({
  kbId,
  existing,
  parentId,
  allTypes,
  onNewSub,
  onDone,
  onError,
}: {
  kbId: string;
  existing: EntityTypeView | null;
  parentId: string | null;
  allTypes: EntityTypeView[];
  /** Provided when editing an existing class: creates a subclass with this class as parent. */
  onNewSub?: () => void;
  /** Carries the new id on a successful create; undefined on a successful edit. */
  onDone: (createdId?: string) => void;
  onError: (e: unknown) => void;
}) {
  const [key, setKey] = useState(existing?.key ?? "");
  const [label, setLabel] = useState(existing?.label ?? "");
  // For a new class, the color follows the key, using the same rule as the server's
  // color_for_key function, not a fixed default. The user can change it. **If the user
  // does not change it, a manually created class matches the color scheme of an
  // imported class.**
  const [color, setColor] = useState(
    existing?.color ?? colorForKey(existing?.key ?? ""),
  );
  const [colorTouched, setColorTouched] = useState(Boolean(existing?.color));
  const [shape, setShape] = useState<"circle" | "square">(
    existing?.shape ?? "circle",
  );
  const [parents, setParents] = useState<string[]>(
    existing?.parents ?? (parentId ? [parentId] : []),
  );
  const [description, setDescription] = useState(existing?.description ?? "");
  // Disjoint classes declare "cannot be both at once". The consistency check uses this
  // to report an unsatisfiable class (see decision 0002). A class that inherits from
  // two disjoint ancestors can never have an instance. This state raises no error; the
  // class simply stays empty forever.
  const [disjoint, setDisjoint] = useState<string[]>(existing?.disjoint ?? []);

  // Pre-fills the parent when the user arrives from "+ subclass" in the left rail. With
  // multiple parents, this one is first, so it becomes the primary parent.
  useEffect(() => setParents(parentId ? [parentId] : []), [parentId]);

  const save = useMutation({
    mutationFn: async (): Promise<unknown> =>
      existing
        ? api.updateEntityType(kbId, existing.id, {
            label,
            color,
            shape,
            parents,
            disjoint,
            description,
          })
        : api.createEntityType(kbId, {
            key,
            label,
            color,
            shape,
            parents,
            disjoint,
            description,
          }),
    onSuccess: (res) => {
      toast.success(existing ? S.toast.saved : S.toast.created);
      onDone(existing ? undefined : (res as { id?: string })?.id);
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: () => api.deleteEntityType(kbId, existing!.id),
    onSuccess: () => {
      toast.success(S.toast.deleted);
      onDone();
    },
    onError,
  });

  const lbl = "block text-xs font-medium text-neutral-500 mb-1";
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span
          className={`h-3 w-3 ${shape === "square" ? "" : "rounded-full"}`}
          style={{ background: color }}
        />
        <span className="font-bold text-neutral-100">
          {existing?.label ?? S.ontology.newClass}
        </span>
        {/* The key is a plain technical identifier. This shows it only during creation
            and not for an existing class. */}
        {existing?.builtin && <Chip tone="neutral">{S.ontology.builtin}</Chip>}
        {existing && (
          <span className="ml-auto text-xs text-neutral-500">
            {S.ontology.usage(existing.usage)}
          </span>
        )}
      </div>
      {!existing && (
        <div>
          <label className={lbl}>
            {S.ontology.key}{" "}
            <span className="text-neutral-600">({S.ontology.keyHint})</span>
          </label>
          <Input
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              // When the user has not chosen a color, this keeps the color following
              // the key, using the same rule as the server.
              if (!colorTouched) setColor(colorForKey(e.target.value));
            }}
            className="w-full"
            placeholder="contract"
          />
        </div>
      )}
      <div>
        <label className={lbl}>{S.ontology.label}</label>
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="w-full"
        />
      </div>
      <div>
        <label className={lbl}>{S.ontology.shapeColor}</label>
        <div className="flex items-center gap-2">
          <ColorPicker value={color} onChange={(c: string) => { setColor(c); setColorTouched(true); }} shape={shape} />
          {/* The shape matches the graph node rendering directly: circle renders as a
              four-layer circle, square renders as a four-layer square. */}
          <div className="flex rounded-lg overflow-hidden border border-white/10">
            {(["circle", "square"] as const).map((sh) => (
              <button
                key={sh}
                onClick={() => setShape(sh)}
                title={sh}
                className={`h-8 w-10 grid place-items-center transition-colors ${
                  shape === sh
                    ? "bg-white/[0.12] text-white"
                    : "text-neutral-500 hover:bg-white/[0.05] hover:text-neutral-300"
                }`}
              >
                <span
                  className={`h-3 w-3 border-[1.5px] border-current ${
                    sh === "circle" ? "rounded-full" : ""
                  }`}
                />
              </button>
            ))}
          </div>
        </div>
      </div>
      {/* Multiple parents: a class can have several subClassOf relations. The left
          rail draws a tree, and a class appears in it only once, so this uses the
          first parent as the primary parent. The UI states this rule instead of
          adding a separate "choose primary parent" control. */}
      <div>
        <label className={lbl}>{S.ontology.parent}</label>
        <MultiSearchSelect
          values={parents}
          options={parentOptions(allTypes, existing?.id)}
          onToggle={(id) =>
            setParents((v) =>
              v.includes(id) ? v.filter((x) => x !== id) : [...v, id],
            )
          }
          placeholder={S.ontology.searchTypes}
          emptyHint={S.ontology.noParent}
        />
        {parents.length > 1 && (
          <p className="mt-1 text-[11px] text-neutral-600">
            {S.ontology.primaryParentHint}
          </p>
        )}
      </div>
      {/* Disjoint classes **declare "cannot be both at once".** This sits next to
          Parent, because the two fields are two sides of one idea: Parent means "is
          also", and Disjoint means "cannot be both at once". The consistency check
          reports "this class can never have an instance" exactly when these two
          conflict. */}
      <div>
        <label className={lbl}>{S.ontology.disjoint}</label>
        <p className="text-[11px] leading-relaxed text-neutral-600 mb-1.5">
          {S.ontology.disjointHint}
        </p>
        <MultiSearchSelect
          values={disjoint}
          options={parentOptions(allTypes, existing?.id)}
          onToggle={(id) =>
            setDisjoint((v) =>
              v.includes(id) ? v.filter((x) => x !== id) : [...v, id],
            )
          }
          placeholder={S.ontology.searchTypes}
          emptyHint={S.ontology.noDisjoint}
        />
        {/* Being disjoint with its own parent means this class can never have an
            instance. Stating this here is faster than letting the user run a
            consistency check to discover it. */}
        {disjoint.some((d) => parents.includes(d)) && (
          <p className="mt-1.5 text-[11px] text-[var(--u-danger)]">
            {S.ontology.disjointWithParent}
          </p>
        )}
      </div>
      <div>
        <label className={lbl}>{S.ontology.description}</label>
        {/* Semantic guidance: this whole text goes into the extraction prompt, so it
            directly affects extraction classification quality. */}
        <textarea
          className="input-dark w-full px-3 py-2 text-sm min-h-[4.5rem] resize-y"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <p className="mt-1 text-[10.5px] text-neutral-600">
          {S.ontology.descriptionHint}
        </p>
      </div>
      <div className="flex gap-2 pt-1">
        <Button
          size="sm"
          onClick={() => save.mutate()}
          disabled={save.isPending || !label.trim()}
        >
          {S.ontology.save}
        </Button>
        {onNewSub && (
          <Button size="sm" variant="ghost" onClick={onNewSub}>
            {S.ontology.newSubClass}
          </Button>
        )}
        {existing && !existing.builtin && (
          <Button
            size="sm"
            variant="ghost"
            disabled={existing.usage > 0}
            title={existing.usage > 0 ? S.ontology.deleteBlocked : undefined}
            onClick={() => remove.mutate()}
          >
            {S.ontology.delete}
          </Button>
        )}
      </div>
    </div>
  );
}

/* ---------- Relation form ---------- */

function PropertyForm({
  kbId,
  existing,
  allTypes,
  allRelations,
  onDone,
  onError,
}: {
  kbId: string;
  existing: RelationTypeView | null;
  allTypes: EntityTypeView[];
  /** This KB's relations, not including attributes. The inverse-of and sub-property-of
   *  dropdowns draw from this list. **Attributes are not in this list,** because an
   *  attribute's object is a literal value, so an inverse of it makes no sense. */
  allRelations: RelationTypeView[];
  onDone: (createdId?: string) => void;
  onError: (e: unknown) => void;
}) {
  const [key, setKey] = useState(existing?.key ?? "");
  const [label, setLabel] = useState(existing?.label ?? "");
  const [temporal, setTemporal] = useState(existing?.temporal ?? "state");
  const [functional, setFunctional] = useState(existing?.functional ?? false);
  const [inverseFunctional, setInverseFunctional] = useState(
    existing?.inverse_functional ?? false,
  );
  // The remaining four OWL axioms. **The reasoning engine's rules depend entirely on
  // these.** Before this form existed, only an OWL import could set them, so a user
  // building an ontology by hand in the UI could never turn on that engine (see
  // decision 0002).
  const [transitive, setTransitive] = useState(existing?.is_transitive ?? false);
  const [symmetric, setSymmetric] = useState(existing?.is_symmetric ?? false);
  const [asymmetric, setAsymmetric] = useState(existing?.is_asymmetric ?? false);
  const [irreflexive, setIrreflexive] = useState(
    existing?.is_irreflexive ?? false,
  );
  // The last two fields in this group have a different shape: each points to another
  // relation. An empty string means the field is not set.
  const [inverseOf, setInverseOf] = useState(existing?.inverse_of ?? "");
  const [subPropertyOf, setSubPropertyOf] = useState(
    existing?.sub_property_of ?? "",
  );
  const [description, setDescription] = useState(existing?.description ?? "");
  const [domains, setDomains] = useState<string[]>(existing?.domains ?? []);
  const [ranges, setRanges] = useState<string[]>(existing?.ranges ?? []);
  // This shows the label, not the key. **The server reads the key that goes into the
  // prompt from the database,** independent of what the UI shows. The class tree and
  // the properties list also show the label, so this has no reason to be an exception.
  // A user with a Chinese-language KB should see "发票记录", not invoice_record.
  const typeOpts = useMemo(
    () => parentOptions(allTypes, undefined),
    [allTypes],
  );
  // The options for both dropdowns: the other relations in this KB.
  //
  // **Neither dropdown lists the relation itself.** For sub-property-of, the database
  // rejects a self-reference directly, because that would be a cycle. For inverse-of,
  // a self-reference is valid in theory, but it equals `symmetric`, and that checkbox
  // sits right above. Offering a second path to the same result here would only let a
  // user create the state that check R0 reports as an error.
  //
  // The one exception is **when the current value already is the relation itself.** An
  // OWL import can create that state. Leaving it out of the list would show the
  // dropdown as blank, and saving while blank would erase the existing value.
  const linkOptions = (current: string) => [
    { value: "", label: S.ontology.noLink },
    // Adds the relation back to the list when the current value is itself. Otherwise
    // the dropdown would show blank, and saving while blank would erase the existing
    // value.
    ...(existing && current === existing.id
      ? [{ value: existing.id, label: existing.label, hint: existing.key }]
      : []),
    ...allRelations
      .filter((r) => r.id !== existing?.id)
      .map((r) => ({ value: r.id, label: r.label, hint: r.key })),
  ];
  /** The display name for the selected dropdown value. This falls back to the id when
   * not found. An ugly value is better than a blank one. */
  const nameOf = (id: string) =>
    allRelations.find((r) => r.id === id)?.label ?? id;
  const toggle = (
    set: React.Dispatch<React.SetStateAction<string[]>>,
    id: string,
  ) => set((v) => (v.includes(id) ? v.filter((x) => x !== id) : [...v, id]));

  const save = useMutation({
    mutationFn: async (): Promise<unknown> =>
      existing
        ? api.updateRelationType(kbId, existing.id, {
            label,
            temporal,
            functional,
            inverse_functional: inverseFunctional,
            is_transitive: transitive,
            is_symmetric: symmetric,
            is_asymmetric: asymmetric,
            is_irreflexive: irreflexive,
            // This sends an empty string as null. The server expects `Option<Uuid>`,
            // and `""` does not parse as a UUID. Sending `""` would return a 422
            // error instead of clearing the field.
            inverse_of: inverseOf || null,
            sub_property_of: subPropertyOf || null,
            description,
            domains,
            ranges,
          })
        : api.createRelationType(kbId, {
            key,
            label,
            temporal,
            functional,
            inverse_functional: inverseFunctional,
            is_transitive: transitive,
            is_symmetric: symmetric,
            is_asymmetric: asymmetric,
            is_irreflexive: irreflexive,
            // This sends an empty string as null. The server expects `Option<Uuid>`,
            // and `""` does not parse as a UUID. Sending `""` would return a 422
            // error instead of clearing the field.
            inverse_of: inverseOf || null,
            sub_property_of: subPropertyOf || null,
            description,
            domains,
            ranges,
          }),
    onSuccess: (res) => {
      toast.success(existing ? S.toast.saved : S.toast.created);
      onDone(existing ? undefined : (res as { id?: string })?.id);
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: () => api.deleteRelationType(kbId, existing!.id),
    onSuccess: () => {
      toast.success(S.toast.deleted);
      onDone();
    },
    onError,
  });

  const lbl = "block text-xs font-medium text-neutral-500 mb-1";
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="font-bold text-neutral-100">
          {existing?.label ?? S.ontology.newProperty}
        </span>
        {existing?.builtin && <Chip tone="neutral">{S.ontology.builtin}</Chip>}
        {existing && (
          <span className="ml-auto text-xs text-neutral-500">
            {S.ontology.usage(existing.usage)}
          </span>
        )}
      </div>
      {!existing && (
        <div>
          <label className={lbl}>
            {S.ontology.key}{" "}
            <span className="text-neutral-600">({S.ontology.keyHint})</span>
          </label>
          <Input
            value={key}
            onChange={(e) => setKey(e.target.value)}
            className="w-full"
            placeholder="signed_with"
          />
        </div>
      )}
      <div>
        <label className={lbl}>{S.ontology.label}</label>
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="w-full"
        />
      </div>
      {/* The type signature. The UI shows the label, while the key goes into the
          prompt; that step happens on the server, independent of what shows here.
          Decision 0004 requires the prompt to use the key. */}
      <div>
        <label className={lbl}>{S.ontology.signature}</label>
        <p className="text-[11px] leading-relaxed text-neutral-600 mb-1.5">
          {S.ontology.signatureHint}
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.08em] text-neutral-600 mb-1">
              {S.ontology.domainLabel}
            </div>
            <MultiSearchSelect
              values={domains}
              options={typeOpts}
              onToggle={(id) => toggle(setDomains, id)}
              placeholder={S.ontology.searchTypes}
              emptyHint={S.ontology.anyType}
            />
          </div>
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.08em] text-neutral-600 mb-1">
              {S.ontology.rangeLabel}
            </div>
            <MultiSearchSelect
              values={ranges}
              options={typeOpts}
              onToggle={(id) => toggle(setRanges, id)}
              placeholder={S.ontology.searchTypes}
              emptyHint={S.ontology.anyType}
            />
          </div>
        </div>
      </div>
      <div>
        <label className={lbl}>{S.ontology.temporal}</label>
        <Dropdown
          value={temporal}
          onChange={setTemporal}
          className="w-full"
          options={[
            { value: "state", label: S.ontology.temporalState },
            { value: "event", label: S.ontology.temporalEvent },
            { value: "eternal", label: S.ontology.temporalEternal },
          ]}
        />
      </div>
      {/* These six axioms group together, **because they are one family.** The
          reasoning engine (see decision 0002) uses them as its rules, and spreading
          them across the form would suggest that the first two and the last four are
          unrelated. Below each one, the text states what checking it does. These
          checkboxes are not descriptions; they are declarations that change system
          behavior. `functional` makes the temporal engine close the old value
          automatically, and `transitive` makes the reasoning engine add edges to the
          graph. A checkbox with no visible consequence invites a user to check it at
          random. */}
      <div>
        <label className={lbl}>{S.ontology.axioms}</label>
        <p className="text-[11px] leading-relaxed text-neutral-600 mb-1.5">
          {S.ontology.axiomsHint}
        </p>
        <div className="space-y-1.5">
          {(
            [
              [functional, setFunctional, S.ontology.functional, S.ontology.functionalHint],
              [
                inverseFunctional,
                setInverseFunctional,
                S.ontology.inverseFunctional,
                S.ontology.inverseFunctionalHint,
              ],
              [transitive, setTransitive, S.ontology.transitive, S.ontology.transitiveHint],
              [symmetric, setSymmetric, S.ontology.symmetric, S.ontology.symmetricHint],
              [asymmetric, setAsymmetric, S.ontology.asymmetric, S.ontology.asymmetricHint],
              [
                irreflexive,
                setIrreflexive,
                S.ontology.irreflexive,
                S.ontology.irreflexiveHint,
              ],
            ] as const
          ).map(([on, set, title, hint], i) => (
            <label key={i} className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                className="mt-0.5 accent-[var(--u-accent)]"
                checked={on}
                onChange={(e) => set(e.target.checked)}
              />
              <span className="min-w-0">
                <span className="block text-[13px] text-neutral-200">{title}</span>
                <span className="block text-[11px] leading-relaxed text-neutral-500">
                  {hint}
                </span>
              </span>
            </label>
          ))}
        </div>
        {/* Checking both symmetric and asymmetric is self-contradictory, except for an
            empty relation. The ontology consistency check reports this, but stating it
            here is faster than letting the user run the check to discover it. */}
        {symmetric && asymmetric && (
          <p className="mt-1.5 text-[11px] text-[var(--u-danger)]">
            {S.ontology.axiomConflict}
          </p>
        )}
        {/* The last two fields in this group only have a different shape: each points
            to **another relation**, so each uses a dropdown instead of a checkbox.
            This keeps them here rather than in a separate section. Of the reasoning
            engine's four rule sources (decision 0002), two are checkboxes above and two
            are dropdowns here; separating them would suggest they are unrelated. */}
        <div className="mt-3 space-y-2.5 border-t border-white/5 pt-3">
          {(
            [
              [
                inverseOf,
                setInverseOf,
                S.ontology.inverseOf,
                S.ontology.inverseOfHint,
                linkOptions(inverseOf),
              ],
              [
                subPropertyOf,
                setSubPropertyOf,
                S.ontology.subPropertyOf,
                S.ontology.subPropertyOfHint,
                linkOptions(subPropertyOf),
              ],
            ] as const
          ).map(([value, set, title, hint, options], i) => (
            <div key={i}>
              <div className="text-[13px] text-neutral-200">{title}</div>
              <p className="text-[11px] leading-relaxed text-neutral-500 mb-1">
                {hint}
              </p>
              <SearchSelect
                value={value}
                onChange={set}
                options={options}
                size="sm"
                className="w-full"
                placeholder={S.ontology.noLink}
              />
            </div>
          ))}
          {/* Once the user picks a value, this states the full effect right away. **The
              subject and object of the inferred fact are not always in the same
              order.** An inverse relation swaps them; a sub-property does not. The
              names alone do not make this clear, so this spells it out. */}
          {(inverseOf || subPropertyOf) && (
            <div className="text-[11px] leading-relaxed text-neutral-500 space-y-0.5">
              {inverseOf && (
                <div>
                  {S.ontology.linkMeansInverse(
                    label.trim() || key || "?",
                    nameOf(inverseOf),
                  )}
                </div>
              )}
              {subPropertyOf && (
                <div>
                  {S.ontology.linkMeansSuper(
                    label.trim() || key || "?",
                    nameOf(subPropertyOf),
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <div>
        <label className={lbl}>{S.ontology.description}</label>
        <textarea
          className="input-dark w-full px-3 py-2 text-sm min-h-[4.5rem] resize-y"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <p className="mt-1 text-[10.5px] text-neutral-600">
          {S.ontology.descriptionHint}
        </p>
      </div>
      <div className="flex gap-2 pt-1">
        <Button
          size="sm"
          onClick={() => save.mutate()}
          disabled={save.isPending || !label.trim()}
        >
          {S.ontology.save}
        </Button>
        {existing && !existing.builtin && (
          <Button
            size="sm"
            variant="ghost"
            disabled={existing.usage > 0}
            title={existing.usage > 0 ? S.ontology.deleteBlocked : undefined}
            onClick={() => remove.mutate()}
          >
            {S.ontology.delete}
          </Button>
        )}
      </div>
    </div>
  );
}

/* ---------- Unmatched signals plus AI suggestions ---------- */


/** Type refinement replaces a roughly-right class with a more specific one.
 *
 * **This works in two steps, the same shape as ontology import:** the user previews
 * what will happen, then decides whether to apply it. There is a further reason for
 * this here. A type change does not save to the timeline, so it does not show up on
 * its own in an entity's history, the way a fact rewrite does. The preview is the only
 * time the user can see it.
 *
 * After it runs, the result falls into three groups, each with its own handling:
 * changes made automatically (the whole batch can be undone), changes that cross a
 * classification axis and go to a human for review, and cases the model judged to be
 * none of the candidates. **The last group carries a reason.** This step relies on
 * "choosing none of the candidates is a reasonable answer". Without a reason, that
 * group, usually the largest, would give the user no way to check the model's work.
 */
function RefinePanel({
  kbId,
  onChanged,
  onError,
}: {
  kbId: string;
  onChanged: () => void;
  onError: (e: Error) => void;
}) {
  const [preview, setPreview] = useState<TypeSuggestion[] | null>(null);
  const [outcome, setOutcome] = useState<ResolutionOutcome | null>(null);

  const look = useMutation({
    mutationFn: () => api.typeResolutionPreview(kbId),
    onSuccess: (d) => {
      setPreview(d.items);
      setOutcome(null);
    },
    onError,
  });
  const run = useMutation({
    mutationFn: () => api.typeResolutionApply(kbId),
    onSuccess: (d) => {
      setOutcome(d);
      setPreview(null);
      onChanged();
    },
    onError,
  });
  const approve = useMutation({
    mutationFn: (v: {
      from_type_id: string;
      to_type_id: string;
      entity_ids: string[];
    }) => api.approveRefinement(kbId, v),
    onSuccess: () => {
      toast.success(S.toast.saved);
      onChanged();
    },
    onError,
  });
  const undo = useMutation({
    mutationFn: (batch: string) => api.typeResolutionUndo(kbId, batch),
    onSuccess: (d) => {
      toast.success(S.ontology.refineUndone(d.reverted));
      setOutcome(null);
      onChanged();
    },
    onError,
  });

  const busy = look.isPending || run.isPending;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="u-title text-lg mb-1">{S.ontology.refineTitle}</h3>
        <p className="text-xs leading-relaxed text-neutral-500 max-w-xl">
          {S.ontology.refineHint}
        </p>
      </div>

      <div className="flex gap-2">
        <button
          className="u-btn text-xs"
          disabled={busy}
          onClick={() => look.mutate()}
        >
          {look.isPending ? S.ontology.refineLooking : S.ontology.refinePreview}
        </button>
        <button
          className="u-btn u-btn-primary text-xs"
          disabled={busy}
          onClick={() => run.mutate()}
        >
          {run.isPending ? S.ontology.refineRunning : S.ontology.refineRun}
        </button>
      </div>

      {/* ---- The compute-only step, before anything saves */}
      {preview && (
        <div className="space-y-2">
          <p className="text-xs text-neutral-500">
            {preview.length === 0
              ? S.ontology.refineNothing
              : S.ontology.refineCandidates(preview.length)}
          </p>
          {preview.map((s) => (
            <div key={s.entity_id} className="glass rounded-xl p-3">
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className="text-sm text-neutral-100">{s.name}</span>
                <span className="text-[11px] text-neutral-500">
                  {s.coarse ?? S.graph.untyped}
                </span>
                {s.specific_type && (
                  <span className="text-[11px] text-[var(--u-warn)]">
                    {S.ontology.refineModelSays(s.specific_type)}
                  </span>
                )}
                <span className="ml-auto u-num text-[10.5px] text-neutral-600">
                  {S.review.factsCount(s.fact_count)}
                </span>
              </div>
              {/* **This shows the text sent to retrieval.** When retrieval finds
                  nothing useful, the first thing to check is what text was searched,
                  rather than guessing whether the entity profile or the class
                  description is at fault. */}
              <p className="mt-1 text-[11px] text-neutral-500 line-clamp-2">
                {s.profile}
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {s.candidates.slice(0, 6).map((c) => (
                  <span
                    key={c.id}
                    title={c.description}
                    className="u-chip u-chip-neutral u-num text-[10.5px]"
                  >
                    {c.label} {c.distance.toFixed(2)}
                  </span>
                ))}
                {s.candidates.length === 0 && (
                  <span className="text-[11px] text-neutral-600">
                    {S.ontology.refineNoCandidates}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ---- The three groups, after the result saves */}
      {outcome && (
        <div className="space-y-3">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-xs text-neutral-300">
              {S.ontology.refineRetyped(outcome.retyped)}
            </span>
            {outcome.batch && outcome.retyped > 0 && (
              <button
                className="u-btn u-btn-ghost text-xs"
                disabled={undo.isPending}
                onClick={() => undo.mutate(outcome.batch!)}
              >
                {S.ontology.refineUndo}
              </button>
            )}
          </div>

          {outcome.for_review.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs text-neutral-500">
                {S.ontology.refineForReview(outcome.for_review.length)}
              </p>
              {outcome.for_review.map((r) => (
                <div key={r.entity_id} className="glass rounded-xl p-3">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-sm text-neutral-100">{r.name}</span>
                    <span className="text-[11px] text-neutral-500">
                      {r.coarse ?? S.graph.untyped} → {r.choice}
                    </span>
                    {r.crosses_axis && (
                      <span className="u-chip u-chip-warn text-[10.5px]">
                        {S.ontology.refineCrossesAxis}
                      </span>
                    )}
                    <span className="ml-auto u-num text-[10.5px] text-neutral-600">
                      {Math.round(r.confidence * 100)}%
                    </span>
                  </div>
                  {r.reason && (
                    <p className="mt-1 text-[11px] text-neutral-500">
                      {r.reason}
                    </p>
                  )}
                  {/* **This approves the pair of classes, not this one entity.** After
                      one approval, the same pair no longer needs human review, which
                      is how most items in this group arise in the first place. */}
                  {r.from_type_id && (
                    <button
                      className="u-btn u-btn-primary mt-2 text-xs"
                      disabled={approve.isPending}
                      onClick={() =>
                        approve.mutate({
                          from_type_id: r.from_type_id!,
                          to_type_id: r.to_type_id,
                          entity_ids: [r.entity_id],
                        })
                      }
                    >
                      {S.ontology.refineApprovePair}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {outcome.left_alone.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs text-neutral-500">
                {S.ontology.refineLeftAlone(outcome.left_alone.length)}
              </p>
              {outcome.left_alone.map((d, i) => (
                <div key={i} className="glass rounded-xl px-3 py-2">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-[13px] text-neutral-200">
                      {d.name}
                    </span>
                    <span className="text-[11px] text-neutral-500">
                      {d.coarse ?? S.graph.untyped}
                    </span>
                  </div>
                  {/* This shows the reason together with the top candidate. When the
                      reason is unclear, the candidate shows whether retrieval found
                      nothing useful or the model rejected what it found. */}
                  {d.reason && (
                    <p className="mt-0.5 text-[11px] text-neutral-500">
                      {d.reason}
                    </p>
                  )}
                  {d.top_candidate && (
                    <p className="mt-0.5 text-[11px] text-neutral-600">
                      {S.ontology.refineTopCandidate(d.top_candidate)}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
function MissesPanel({
  kbId,
  misses,
  dismissedMisses,
  onChanged,
  onError,
}: {
  kbId: string;
  misses: OntologyMiss[];
  dismissedMisses: OntologyMiss[];
  onChanged: () => void;
  onError: (e: unknown) => void;
}) {
  // This collapses by default. A dismissed item is **background information,** and it
  // must not compete for attention with the pending items.
  const [showDismissed, setShowDismissed] = useState(false);
  const [proposals, setProposals] = useState<OntologyProposals | null>(null);
  // The proposals computed last time, with no user decision yet: this reads them back
  // from the database after a page refresh (see decision 0049).
  //
  // Before this query existed, this component held that state only in the useState
  // above. A refresh or a navigation away lost the whole batch of proposals. Seeing
  // them again meant rerunning the model, and a rerun was not guaranteed to group the
  // same forms together. Which forms a proposal groups is the only way to verify a
  // merge (this is how decision 0003 caught the optimized_for to runs_on case).
  const storedProposals = useQuery({
    queryKey: ["storedProposals", kbId],
    queryFn: () => api.storedProposals(kbId),
  });
  useEffect(() => {
    // Fills in the stored data only when no local result exists yet. A batch just
    // computed by clicking Suggest must not be overwritten.
    if (proposals === null && storedProposals.data) {
      const d = storedProposals.data;
      const empty =
        !d.entity_types?.length &&
        !d.relation_types?.length &&
        !d.attribute_types?.length;
      if (!empty) setProposals(d);
    }
  }, [storedProposals.data, proposals]);
  // The most recent adoption, for undo. This keeps only the most recent one; undoing an
  // older batch goes through the audit log instead, which already records which
  // relation each adoption changed and how many facts moved.
  const [lastAdopt, setLastAdopt] = useState<{
    batches: string[];
    key: string;
    moved: number;
  } | null>(null);
  // Undo needs a second confirmation, because it changes a batch of facts at once.
  const [confirmUndo, setConfirmUndo] = useState<{
    batches: string[];
    moved: number;
  } | null>(null);
  // Whether the system auto-extended the ontology. The banner below shows based on
  // this. After a full undo, the server returns null.
  const autoRun = useQuery({
    queryKey: ["auto-extension", kbId],
    queryFn: () => api.lastAutoExtension(kbId),
  });
  // The unclaimed surface predicates. A proposal's impact, such as "will rewrite 57
  // facts", is computed from this data.
  const surface = useQuery({
    queryKey: ["proposed-predicates", kbId],
    queryFn: () => api.proposedPredicates(kbId),
  });
  const factsWaiting = (forms: string[]) => {
    const byForm = new Map(
      (surface.data?.forms ?? []).map((f) => [f.form, f.fact_count]),
    );
    return forms.reduce((n, f) => n + (byForm.get(f) ?? 0), 0);
  };

  const suggest = useMutation({
    mutationFn: () => api.suggestOntology(kbId),
    onSuccess: setProposals,
    onError,
  });
  const dismiss = useMutation({
    mutationFn: ({ kind, key }: { kind: string; key: string }) =>
      api.dismissMiss(kbId, kind, key),
    onSuccess: onChanged,
    onError,
  });
  const restore = useMutation({
    mutationFn: ({ kind, key }: { kind: string; key: string }) =>
      api.restoreMiss(kbId, kind, key),
    onSuccess: onChanged,
    onError,
  });
  const approveEntity = useMutation({
    mutationFn: (p: { key: string; label: string; description?: string }) =>
      api.createEntityType(kbId, {
        key: p.key,
        label: p.label,
        description: p.description,
      }),
    onSuccess: (_data, p) => {
      // Adopted: removes it from the proposals list, and also clears the matching
      // unmatched-count chip, because the ontology now covers it.
      toast.success(S.toast.added);
      setProposals(
        (prev) =>
          prev && {
            ...prev,
            entity_types: prev.entity_types.filter((x) => x.key !== p.key),
          },
      );
      api.dismissMiss(kbId, "entity_type", p.key).catch(() => {});
      // Saves the decision on this proposal (see decision 0049), so the next Suggest
      // run does not bring it back as pending.
      api.decideProposal(kbId, "entity_types", p.key, "adopted").catch(() => {});
      onChanged();
    },
    onError,
  });
  const approveRelation = useMutation({
    // A proposal with forms goes through adopt, which creates the relation and also
    // claims the unassigned facts waiting for it. Creating the relation alone would
    // grow the ontology without improving the graph; those facts would still show as
    // an unlabeled "related to" link.
    mutationFn: (p: {
      key: string;
      label: string;
      temporal?: string;
      functional?: boolean;
      description?: string;
      forms?: string[];
    }) =>
      p.forms?.length
        ? api.adoptPredicate(kbId, {
            key: p.key,
            label: p.label,
            temporal: p.temporal ?? "state",
            functional: p.functional ?? false,
            description: p.description,
            forms: p.forms,
          })
        : api.createRelationType(kbId, {
            key: p.key,
            label: p.label,
            temporal: p.temporal ?? "state",
            functional: p.functional ?? false,
            description: p.description,
          }),
    onSuccess: (data, p) => {
      const d = data as { remapped?: number; batch?: string };
      const moved = d.remapped ?? 0;
      toast.success(moved > 0 ? S.ontology.adopted(moved) : S.toast.added);
      // A handle for undo: adoption rewrites a batch of facts, and with no way back,
      // no one would risk clicking the first time.
      if (moved > 0 && d.batch)
        setLastAdopt({ batches: [d.batch], key: p.key, moved });
      setProposals(
        (prev) =>
          prev && {
            ...prev,
            relation_types: prev.relation_types.filter((x) => x.key !== p.key),
          },
      );
      api.dismissMiss(kbId, "relation_type", p.key).catch(() => {});
      api.decideProposal(kbId, "relation_types", p.key, "adopted").catch(() => {});
      onChanged();
    },
    onError,
  });

  // This runs one predicate at a time, instead of adding a bulk endpoint. Each
  // predicate gets its own batch and its own undo granularity, and a partial failure
  // can report honestly ("5 succeeded, 1 key already exists") instead of rolling back
  // the whole batch.
  // Attribute proposals: predicates whose object is a literal value. These go through
  // the same adoption entry point, but a value must convert to the target datatype.
  // A value that cannot convert does not get rewritten, so the response must report
  // unconvertible values explicitly.
  const approveAttribute = useMutation({
    mutationFn: (p: {
      key: string;
      label: string;
      datatype?: string;
      unit?: string;
      description?: string;
      forms?: string[];
    }) =>
      api.adoptPredicate(kbId, {
        key: p.key,
        kind: "attribute",
        label: p.label,
        datatype: p.datatype ?? "text",
        unit: p.unit,
        description: p.description,
        forms: p.forms ?? [],
      }),
    onSuccess: (data, p) => {
      const moved = data.remapped ?? 0;
      const left = data.unconvertible ?? 0;
      toast.success(
        left > 0
          ? S.ontology.adoptedPartly(moved, left)
          : moved > 0
            ? S.ontology.adopted(moved)
            : S.toast.added,
      );
      if (moved > 0 && data.batch)
        setLastAdopt({ batches: [data.batch], key: p.key, moved });
      setProposals(
        (prev) =>
          prev && {
            ...prev,
            attribute_types: (prev.attribute_types ?? []).filter(
              (x) => x.key !== p.key,
            ),
          },
      );
      for (const form of p.forms ?? [])
        api.dismissMiss(kbId, "attribute_type", form).catch(() => {});
      api.decideProposal(kbId, "attribute_types", p.key, "adopted").catch(() => {});
      onChanged();
    },
    onError,
  });
  // Mapping to an existing type: this creates nothing, and only attaches these forms'
  // facts to the existing type. It goes through the same adoption entry point as a new
  // predicate, because it changes the graph the same way, and so it can undo the same way.
  const approveMapping = useMutation({
    mutationFn: (p: { key: string; kind?: string; forms?: string[] }) =>
      api.adoptPredicate(kbId, {
        key: p.key,
        existing: true,
        // When the target is an attribute, the value must convert to its datatype.
        // The server routes based on this field.
        kind: p.kind === "attribute" ? "attribute" : "relation",
        forms: p.forms ?? [],
      }),
    onSuccess: (data, p) => {
      const moved = data.remapped ?? 0;
      const left = data.unconvertible ?? 0;
      toast.success(
        left > 0
          ? S.ontology.adoptedPartly(moved, left)
          : moved > 0
            ? S.ontology.adopted(moved)
            : S.toast.saved,
      );
      if (moved > 0 && data.batch)
        setLastAdopt({ batches: [data.batch], key: p.key, moved });
      setProposals(
        (prev) =>
          prev && {
            ...prev,
            map_to: (prev.map_to ?? []).filter((x) => x.key !== p.key),
          },
      );
      for (const form of p.forms ?? [])
        api.dismissMiss(kbId, "relation_type", form).catch(() => {});
      onChanged();
    },
    onError,
  });
  const addAll = useMutation({
    mutationFn: async (all: OntologyProposals) => {
      const batches: string[] = [];
      let moved = 0;
      const failed: string[] = [];
      for (const p of all.entity_types) {
        try {
          await api.createEntityType(kbId, { key: p.key, label: p.label });
        } catch {
          failed.push(p.key);
        }
      }
      for (const p of all.relation_types) {
        try {
          if (p.forms?.length) {
            const r = await api.adoptPredicate(kbId, {
              key: p.key,
              label: p.label,
              temporal: p.temporal ?? "state",
              functional: p.functional ?? false,
              description: p.description,
              forms: p.forms,
            });
            moved += r.remapped;
            if (r.remapped > 0) batches.push(r.batch);
          } else {
            await api.createRelationType(kbId, {
              key: p.key,
              label: p.label,
              temporal: p.temporal ?? "state",
              functional: p.functional ?? false,
              description: p.description,
            });
          }
        } catch {
          failed.push(p.key);
        }
      }
      for (const p of all.attribute_types ?? []) {
        if (!p.forms?.length) continue;
        try {
          const r = await api.adoptPredicate(kbId, {
            key: p.key,
            kind: "attribute",
            label: p.label,
            datatype: p.datatype ?? "text",
            unit: p.unit,
            description: p.description,
            forms: p.forms,
          });
          moved += r.remapped;
          if (r.remapped > 0) batches.push(r.batch);
        } catch {
          failed.push(p.key);
        }
      }
      for (const p of all.map_to ?? []) {
        if (!p.forms?.length) continue;
        try {
          const r = await api.adoptPredicate(kbId, {
            key: p.key,
            existing: true,
            kind: p.kind === "attribute" ? "attribute" : "relation",
            forms: p.forms,
          });
          moved += r.remapped;
          if (r.remapped > 0) batches.push(r.batch);
        } catch {
          failed.push(p.key);
        }
      }
      return { batches, moved, failed };
    },
    onSuccess: (r) => {
      if (r.failed.length) toast.error(S.ontology.addAllPartial(r.failed));
      else toast.success(S.ontology.adopted(r.moved));
      if (r.batches.length)
        setLastAdopt({
          batches: r.batches,
          key: S.ontology.addAllLabel,
          moved: r.moved,
        });
      setProposals(null);
      onChanged();
    },
    onError,
  });

  const unadopt = useMutation({
    mutationFn: async (batches: string[]) => {
      let reverted = 0;
      for (const b of batches)
        reverted += (await api.unadoptPredicate(kbId, b)).reverted;
      return { reverted };
    },
    onSuccess: (r) => {
      toast.success(S.ontology.reverted(r.reverted));
      setLastAdopt(null);
      setConfirmUndo(null);
      autoRun.refetch();
      onChanged();
    },
    onError,
  });

  return (
    <div className="glass rounded-xl p-4">
      <div className="flex items-center gap-3 mb-1">
        <h3 className="text-sm font-bold text-neutral-200">
          {S.ontology.misses}
        </h3>
        {misses.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => suggest.mutate()}
            disabled={suggest.isPending}
          >
            {suggest.isPending ? S.ontology.suggesting : S.ontology.suggest}
          </Button>
        )}
      </div>
      <p className="text-xs text-neutral-500 mb-3">{S.ontology.missesHint}</p>

      {misses.length === 0 ? (
        <p className="text-sm text-neutral-500">{S.ontology.noMisses}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {misses.map((m) => (
            <span
              key={`${m.kind}:${m.key}`}
              className="glass rounded-full px-2.5 py-1 text-xs flex items-center gap-1.5"
              title={m.example ?? ""}
            >
              <Chip tone={m.kind === "entity_type" ? "info" : "violet"}>
                {m.kind === "entity_type" ? "C" : "P"}
              </Chip>
              <span className="font-mono text-neutral-300">{m.key}</span>
              <span className="text-neutral-500">×{m.count}</span>
              <button
                onClick={() => dismiss.mutate({ kind: m.kind, key: m.key })}
                className="text-neutral-600 hover:text-neutral-300"
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      {dismissedMisses.length > 0 && (
        <div className="mt-3 border-t border-white/5 pt-3">
          <button
            onClick={() => setShowDismissed((v) => !v)}
            className="text-xs text-neutral-500 hover:text-neutral-300"
          >
            {showDismissed ? "▾" : "▸"} {S.ontology.dismissed(dismissedMisses.length)}
          </button>
          {showDismissed && (
            <>
              <p className="text-xs text-neutral-600 mt-1.5 mb-2">
                {S.ontology.dismissedHint}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {dismissedMisses.map((m) => (
                  <span
                    key={`d:${m.kind}:${m.key}`}
                    className="glass rounded-full px-2.5 py-1 text-xs flex items-center gap-1.5 opacity-60"
                    title={m.example ?? ""}
                  >
                    <Chip tone={m.kind === "entity_type" ? "info" : "violet"}>
                      {m.kind === "entity_type" ? "C" : "P"}
                    </Chip>
                    <span className="font-mono text-neutral-400 line-through">
                      {m.key}
                    </span>
                    <span className="text-neutral-500">×{m.count}</span>
                    <button
                      onClick={() => restore.mutate({ kind: m.kind, key: m.key })}
                      className="text-neutral-600 hover:text-neutral-200"
                      title={S.ontology.restore}
                    >
                      ↺
                    </button>
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
      )}
      {/* When the system changes the ontology on its own, the user must see it.
          Recording it only in the audit log does not count as visible. Turning this
          feature on by default relies on its actions being visible and reversible;
          this banner is the "visible" half of that. */}
      {autoRun.data?.run && !lastAdopt && (
        <div className="mt-3 rounded-lg border border-[var(--u-accent)]/25 bg-[var(--u-accent)]/[0.06] px-3 py-2.5">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-xs text-neutral-200">
                {S.ontology.autoRanTitle}
              </p>
              <p className="mt-0.5 text-[11px] text-neutral-400">
                {S.ontology.autoRanBody(
                  autoRun.data.run.relations ?? [],
                  autoRun.data.run.facts_remapped ?? 0,
                )}
              </p>
              <p className="mt-0.5 text-[11px] text-neutral-600">
                {S.ontology.autoRanOff}
              </p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              disabled={unadopt.isPending}
              onClick={() =>
                setConfirmUndo({
                  batches: autoRun.data!.run!.batches,
                  moved: autoRun.data!.run!.facts_remapped ?? 0,
                })
              }
            >
              {S.ontology.undoAdoptBtn}
            </Button>
          </div>
        </div>
      )}

      {/* Adoption rewrites a batch of facts. With no way back, no one would risk
          clicking the first time. */}
      {lastAdopt && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2">
          <span className="text-xs text-neutral-300">
            {S.ontology.undoAdopt(lastAdopt.key, lastAdopt.moved)}
          </span>
          <span className="text-[11px] text-neutral-600">
            {S.ontology.undoKeepsRelation}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            disabled={unadopt.isPending}
            onClick={() =>
              setConfirmUndo({
                batches: lastAdopt.batches,
                moved: lastAdopt.moved,
              })
            }
          >
            {S.ontology.undoAdoptBtn}
          </Button>
        </div>
      )}

      {/* Undoing changes a batch of facts back. This uses a light confirm, because
          undo is itself reversible, so typing to confirm is not required. */}
      {confirmUndo && (
        <DangerConfirm
          title={S.ontology.undoTitle}
          hint={S.ontology.undoHint(confirmUndo.moved)}
          confirmLabel={S.ontology.undoConfirm}
          cancelLabel={S.ontology.undoCancel}
          busy={unadopt.isPending}
          onConfirm={() => unadopt.mutate(confirmUndo.batches)}
          onCancel={() => setConfirmUndo(null)}
        />
      )}
      {proposals && (
        <div className="mt-4 border-t border-white/10 pt-3">
          <div className="mb-2 flex items-center gap-2">
            <h4 className="text-xs font-bold text-neutral-400">
              {S.ontology.proposals}
            </h4>
            {/* The common case is "all of these are correct". Clicking each one
                separately turns one decision into eight. */}
            {proposals.relation_types.length +
              proposals.entity_types.length +
              (proposals.attribute_types?.length ?? 0) +
              (proposals.map_to?.length ?? 0) >
              1 && (
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                disabled={addAll.isPending}
                onClick={() => addAll.mutate(proposals)}
              >
                {addAll.isPending
                  ? S.ontology.addingAll
                  : S.ontology.addAll(
                      proposals.relation_types.length +
                        proposals.entity_types.length +
                        (proposals.attribute_types?.length ?? 0) +
                        (proposals.map_to?.length ?? 0),
                    )}
              </Button>
            )}
          </div>
          <div className="space-y-1.5">
            {/* This sorts first. It says "the ontology already has this", and that is
                the message the user most needs to see first. Sorting it after the
                new-item proposals would let a user create a duplicate while clicking
                through the list. */}
            {(proposals.map_to ?? []).map((p) => (
              <div key={`map-${p.key}`} className="flex items-center gap-2 text-sm">
                <Chip tone="success">=</Chip>
                <span className="font-mono text-neutral-300">{p.key}</span>
                {!!p.forms?.length && (
                  <span
                    className="text-xs text-neutral-400 truncate"
                    title={p.forms.join(" · ")}
                  >
                    {p.forms.join(" · ")}
                  </span>
                )}
                {!!p.forms?.length && (
                  <span className="text-xs text-[var(--u-accent)]">
                    {S.ontology.willRemap(factsWaiting(p.forms))}
                  </span>
                )}
                {p.reason && (
                  <span className="text-xs text-neutral-500 truncate">
                    {p.reason}
                  </span>
                )}
                <Button
                  size="sm"
                  className="ml-auto"
                  onClick={() => approveMapping.mutate(p)}
                  disabled={approveMapping.isPending}
                >
                  {S.ontology.mapOver}
                </Button>
              </div>
            ))}
            {proposals.entity_types.map((p) => (
              <div key={p.key} className="flex items-center gap-2 text-sm">
                <Chip tone="info">C</Chip>
                <span className="font-mono text-neutral-300">{p.key}</span>
                <span className="text-neutral-200">{p.label}</span>
                {p.reason && (
                  <span className="text-xs text-neutral-500 truncate">
                    {p.reason}
                  </span>
                )}
                <Button
                  size="sm"
                  className="ml-auto"
                  onClick={() => approveEntity.mutate(p)}
                  disabled={approveEntity.isPending}
                >
                  {S.ontology.approve}
                </Button>
              </div>
            ))}
            {proposals.relation_types.map((p) => (
              <div key={p.key} className="flex items-center gap-2 text-sm">
                <Chip tone="violet">P</Chip>
                <span className="font-mono text-neutral-300">{p.key}</span>
                <span className="text-neutral-200">{p.label}</span>
                {p.temporal && <Chip tone="neutral">{p.temporal}</Chip>}
                {/* The impact: how many facts adoption will rewrite, and which forms it
                    merges. Without this, "approve" would just add an empty relation
                    for no visible reason. */}
                {!!p.forms?.length && (
                  <span
                    className="text-xs text-[var(--u-accent)]"
                    title={p.forms.join(" · ")}
                  >
                    {S.ontology.willRemap(factsWaiting(p.forms))}
                  </span>
                )}
                {p.reason && (
                  <span className="text-xs text-neutral-500 truncate">
                    {p.reason}
                  </span>
                )}
                <Button
                  size="sm"
                  className="ml-auto"
                  onClick={() => approveRelation.mutate(p)}
                  disabled={approveRelation.isPending}
                >
                  {S.ontology.approve}
                </Button>
              </div>
            ))}
            {(proposals.attribute_types ?? []).map((p) => (
              <div key={`attr-${p.key}`} className="flex items-center gap-2 text-sm">
                {/* This uses "A", not "P", because the literal-value group is not a
                    relation, and the UI keeps the two visibly distinct. */}
                <Chip tone="warn">A</Chip>
                <span className="font-mono text-neutral-300">{p.key}</span>
                <span className="text-neutral-200">{p.label}</span>
                <Chip tone="neutral">{p.datatype ?? "text"}</Chip>
                {p.unit && <Chip tone="neutral">{p.unit}</Chip>}
                {!!p.forms?.length && (
                  <span
                    className="text-xs text-[var(--u-accent)]"
                    title={p.forms.join(" · ")}
                  >
                    {S.ontology.willRemap(factsWaiting(p.forms))}
                  </span>
                )}
                {p.reason && (
                  <span className="text-xs text-neutral-500 truncate">
                    {p.reason}
                  </span>
                )}
                <Button
                  size="sm"
                  className="ml-auto"
                  onClick={() => approveAttribute.mutate(p)}
                  disabled={approveAttribute.isPending}
                >
                  {S.ontology.approve}
                </Button>
              </div>
            ))}
            {proposals.entity_types.length === 0 &&
              proposals.relation_types.length === 0 &&
              !proposals.attribute_types?.length &&
              !proposals.map_to?.length && (
                <p className="text-sm text-neutral-500">—</p>
              )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- Ontology import: upload, preview the plan, confirm, save ---------- */
/* The preview and the save step share the same server-side plan. This panel's whole
   job is to show **the three things in the plan that can cause trouble,** before the
   user clicks confirm: a functional relation (a wrong uniqueness declaration creates a
   string of false conflicts), a class with no description (the description goes
   word-for-word into the extraction prompt, and a missing one silently lowers
   extraction quality), and a key collision (renaming automatically does not fix this;
   it would make the next re-import fail to recognize what it created last time). */

function ImportPanel({
  kbId,
  onChanged,
  onError,
}: {
  kbId: string;
  onChanged: () => void;
  onError: (e: unknown) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const pick = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  const history = useQuery({
    queryKey: ["ontology-imports", kbId],
    queryFn: () => api.ontologyImports(kbId),
  });

  const preview = useMutation({
    mutationFn: (f: File) => api.previewOntologyImport(kbId, f),
    onError: (e) => {
      setFile(null);
      onError(e);
    },
  });

  const apply = useMutation({
    mutationFn: (f: File) => api.applyOntologyImport(kbId, f),
    onSuccess: (res) => {
      const p = res.plan;
      toast.success(
        S.ontology.importDone(
          p.classes.filter((c) => c.disposition === "create").length,
          p.classes.filter((c) => c.disposition === "update").length,
        ),
      );
      setFile(null);
      preview.reset();
      queryClient.invalidateQueries({ queryKey: ["ontology-imports", kbId] });
      onChanged();
    },
    onError,
  });

  const choose = (f: File | undefined) => {
    if (!f) return;
    setFile(f);
    preview.mutate(f);
  };

  const plan = preview.data?.plan ?? null;
  const busy = preview.isPending || apply.isPending;
  const empty =
    plan &&
    plan.classes.length === 0 &&
    plan.relations.length === 0 &&
    plan.attributes.length === 0;

  return (
    <div className="glass rounded-xl p-4">
      <h3 className="text-sm font-bold text-neutral-200 mb-1">
        {S.ontology.importTitle}
      </h3>
      <p className="text-xs text-neutral-500 mb-3">{S.ontology.importHint}</p>

      <input
        ref={pick}
        type="file"
        accept=".owl,.rdf,.ttl,.xml,.n3"
        className="hidden"
        onChange={(e) => {
          choose(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => pick.current?.click()}
        >
          {file ? S.ontology.importChange : S.ontology.importPick}
        </Button>
        {file && (
          <span className="text-xs text-neutral-400 truncate">
            <span className="font-mono">{file.name}</span>
            <span className="text-neutral-600">
              {" "}
              · {S.ontology.importSize(file.size)}
            </span>
          </span>
        )}
        {preview.isPending && (
          <span className="text-xs text-neutral-500">
            {S.ontology.importReading}
          </span>
        )}
      </div>

      {plan && (
        <div className="mt-4">
          <p className="text-[11px] uppercase tracking-[0.08em] text-neutral-600 u-num">
            {S.ontology.importParsed(plan.format, plan.triples)}
          </p>

          {empty ? (
            <p className="mt-2 text-sm text-neutral-500">
              {S.ontology.importNothing}
            </p>
          ) : (
            <>
              {/* The three warnings come before the counts, because a user reads only
                  the first screen. */}
              <Warning
                show={plan.functional_relations > 0}
                tone="warn"
                title={S.ontology.warnFunctional(plan.functional_relations)}
                body={S.ontology.warnFunctionalBody}
                items={plan.relations
                  .filter((r) => r.functional)
                  .map((r) => r.key)}
              />
              <Warning
                show={plan.classes_without_description > 0}
                tone="warn"
                title={S.ontology.warnNoDescription(
                  plan.classes_without_description,
                )}
                body={S.ontology.warnNoDescriptionBody}
                items={plan.classes
                  .filter((c) => !c.has_description)
                  .map((c) => c.key)}
              />
              <Warning
                show={takenCount(plan) > 0}
                tone="danger"
                title={S.ontology.warnKeyTaken(takenCount(plan))}
                body={S.ontology.warnKeyTakenBody}
                items={[...plan.classes, ...plan.relations, ...plan.attributes]
                  .filter((i) => i.disposition === "key_taken")
                  .map(
                    (i) =>
                      `${i.key} — ${S.ontology.importTakenBy(i.conflict_with ?? null)}`,
                  )}
              />

              <div className="mt-3 grid gap-2">
                <PlanRow
                  label={S.ontology.importClasses}
                  items={plan.classes}
                />
                <PlanRow
                  label={S.ontology.importRelations}
                  items={plan.relations}
                />
                <PlanRow
                  label={S.ontology.importAttributes}
                  items={plan.attributes}
                  note={
                    plan.attributes.length > 0
                      ? S.ontology.importAttributesLater
                      : undefined
                  }
                />
              </div>

              {plan.unprojected.length > 0 && (
                <details className="mt-3">
                  <summary className="cursor-pointer text-xs text-neutral-500 hover:text-neutral-300">
                    {S.ontology.importUnprojected} ({plan.unprojected.length})
                  </summary>
                  <p className="mt-1.5 text-[11px] text-neutral-600">
                    {S.ontology.importUnprojectedBody}
                  </p>
                  <ul className="mt-1.5 space-y-0.5">
                    {plan.unprojected.map(([iri, n]) => (
                      <li key={iri} className="flex gap-2 text-[11px]">
                        <span
                          className="font-mono text-neutral-500 truncate"
                          title={iri}
                        >
                          {shortIri(iri)}
                        </span>
                        <span className="u-num text-neutral-600 shrink-0">
                          ×{n}
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              <div className="mt-4 flex items-center gap-2">
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => file && apply.mutate(file)}
                >
                  {apply.isPending
                    ? S.ontology.importApplying
                    : S.ontology.importApply}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setFile(null);
                    preview.reset();
                  }}
                >
                  {S.ontology.importCancel}
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Import history: who changed the ontology, when, and with which file. The
          original file saves under its sha256 hash. */}
      <div className="mt-5 border-t border-white/10 pt-3">
        <h4 className="text-xs font-medium text-neutral-400 mb-2">
          {S.ontology.importHistory}
        </h4>
        {!history.data?.imports.length ? (
          <p className="text-xs text-neutral-600">
            {S.ontology.importNoHistory}
          </p>
        ) : (
          <ul className="space-y-1.5">
            {history.data.imports.map((im) => (
              <li key={im.id} className="flex items-baseline gap-2 text-xs">
                <span className="font-mono text-neutral-300 truncate">
                  {im.filename}
                </span>
                <span className="u-num text-neutral-600 shrink-0">
                  {S.ontology.importSize(im.byte_size)}
                </span>
                <span className="ml-auto text-[11px] text-neutral-600 shrink-0">
                  {S.ontology.importBy(
                    im.imported_by_name ?? "—",
                    new Date(im.imported_at).toLocaleDateString(),
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function takenCount(p: ImportPlan) {
  return [...p.classes, ...p.relations, ...p.attributes].filter(
    (i) => i.disposition === "key_taken",
  ).length;
}

/** Only the tail of an IRI is the part a person recognizes. The prefix only takes up
 * width in the list. */
function shortIri(iri: string) {
  const i = Math.max(iri.lastIndexOf("#"), iri.lastIndexOf("/"));
  return i < 0 ? iri : iri.slice(i + 1);
}

/** One warning: the title gives a count, the body gives the consequence in one
 * sentence, and the items collapse into a details element. */
function Warning({
  show,
  tone,
  title,
  body,
  items,
}: {
  show: boolean;
  tone: "warn" | "danger";
  title: string;
  body: string;
  items: string[];
}) {
  if (!show) return null;
  return (
    <div
      className={cn(
        "mt-3 rounded-lg border px-3 py-2.5",
        tone === "danger"
          ? "border-rose-500/25 bg-rose-500/[0.06]"
          : "border-amber-500/25 bg-amber-500/[0.06]",
      )}
    >
      <p className="text-xs text-neutral-200">{title}</p>
      <p className="mt-0.5 text-[11px] text-neutral-400">{body}</p>
      {items.length > 0 && (
        <details className="mt-1.5">
          <summary className="cursor-pointer text-[11px] text-neutral-500 hover:text-neutral-300">
            {items.length > 1 ? `${items.length} items` : "1 item"}
          </summary>
          <ul className="mt-1 space-y-0.5">
            {items.map((it) => (
              <li key={it} className="font-mono text-[11px] text-neutral-400">
                {it}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** A count of what happens to one section's items: create, update, or skip. This
 * hides a count of zero. */
function PlanRow({
  label,
  items,
  note,
}: {
  label: string;
  items: PlannedItem[];
  note?: string;
}) {
  if (items.length === 0) return null;
  const n = (d: PlannedItem["disposition"]) =>
    items.filter((i) => i.disposition === d).length;
  return (
    <div className="rounded-lg bg-white/[0.03] px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="text-xs text-neutral-300">{label}</span>
        <span className="ml-auto flex items-center gap-1.5">
          {n("create") > 0 && (
            <Chip tone="success">
              {S.ontology.importWillCreate(n("create"))}
            </Chip>
          )}
          {n("update") > 0 && (
            <Chip tone="info">{S.ontology.importWillUpdate(n("update"))}</Chip>
          )}
          {n("key_taken") > 0 && (
            <Chip tone="neutral">
              {S.ontology.importKeyTaken(n("key_taken"))}
            </Chip>
          )}
        </span>
      </div>
      {note && <p className="mt-1 text-[11px] text-neutral-600">{note}</p>}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import Graphology from "graphology";
import { circular, circlepack } from "graphology-layout";
import forceAtlas2 from "graphology-layout-forceatlas2";
import FA2Layout from "graphology-layout-forceatlas2/worker";
import Sigma from "sigma";
import { createNodeBorderProgram } from "@sigma/node-border";
import EdgeCurveProgram from "@sigma/edge-curve";
import { NodeSquareShellProgram } from "./squareShellProgram";
import { EntityHistory } from "./EntityHistory";
import {
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  CircleDashed,
  Grape,
  Loader2,
  Maximize2,
  Orbit,
  Pause,
  Pencil,
  Play,
  Waypoints,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  api,
  type DerivedFact,
  type EntityFact,
  type Evidence,
  type GraphEdge,
  type GraphNode,
} from "../api";
import { S } from "../i18n";
import { usePopoverFlip } from "../ui/popoverFlip";
import { useKb, useKbId } from "../kb";
import { toast } from "../toast";

/* Canvas color palette. The structure comes from the Semantica GraphWorkspace source.
   The base colors are neutralized: the Semantica original used a steel-blue family
   (#0B1320/#5A7A9E/#7A92AE). This version follows the rule "chrome carries no color
   bias; color belongs only to data," so each base color becomes a neutral gray at the
   same brightness. The mix ratio for the type color stays the same. */
const NODE_SHELL_BASE = "#121212"; // Node shell base (neutralized from #0B1320)
const NODE_CORE_BASE = "#767676"; // Node core gray (neutralized from #5A7A9E)
const NODE_BORDER_BASE = "#909090"; // Node border (neutralized from #7A92AE)
const NODE_TINT_MIX = 0.14; // The type color mixes into the shell at only 14%
const NODE_CORE_MIX = 0.5; // How much the core mixes toward the type color
/* The status ring takes **the node's own type color**, not one of two fixed hues.

   The direct reason for this change: a color collision. The old gold selection ring,
   `#E7C57C`, is `rgb(231,197,124)` — the same value, byte for byte, as
   `EDGE_COLOR_DERIVED`. "This node is selected" and "this edge is derived" used the
   same color, and the two facts have nothing to do with each other. Gold is now
   reserved for "derived."

   The ring mixes toward white instead of using the raw color: the ring is drawn on the
   node itself, so the same color at the same brightness would not read as a ring.
   **Hover mixes more toward white; selection mixes less.** On hover, the rest of the
   graph does not dim, so the ring must stand out immediately against a field of lines.
   On selection, the rest of the graph dims and the node is already isolated, so the
   ring should say "who this is" — closer to its own color. */
const RING_HOVER_MIX = 0.7; // Hover: closer to white, so it stands out
const RING_SELECT_MIX = 0.35; // Selection: closer to the true color, so it reads clearly
const EDGE_COLOR = "rgba(163,163,163,0.2)"; // Plain gray (by user request, not steel blue)
// A relation the ontology does not recognize: the same color, but fainter. The name
// comes from the source text, so it should not look as prominent as a relation
// declared in the ontology's vocabulary.
const EDGE_COLOR_INFERRED = "rgba(163,163,163,0.1)";
// A derived edge (R1). **This is a different fact from the two colors above.** Those
// two state where the edge's name comes from. This one states that no one asserted the
// edge at all — the engine derived it. It gets its own hue instead of another shade of
// gray, so a user can tell "written in a document" from "derived" at a glance.
const EDGE_COLOR_DERIVED = "rgba(231,197,124,0.42)";
const EDGE_COLOR_DERIVED_DIM = "rgba(231,197,124,0.14)";

/** The curvature step between two adjacent arcs. Too small and they still blur
 *  together. Too large and a long edge swings far from its nodes. */
const EDGE_CURVATURE_STEP = 0.18;

/** Which arc draws one edge; `curvature === 0` means a straight line. */
interface PlacedEdge {
  edge: GraphEdge;
  curvature: number;
  /** Other wordings for this edge (its inverse relations), shown together on hover. */
  alsoLabels: string[];
}

/** Edges between the same pair of nodes, each drawn on its own arc. Edges derived
 *  from an inverse relation are folded in first.
 *
 *  **Two steps, in this order: fold first, then group.**
 *
 *  1. `A works_at B` and its derived edge `B employs A` are **two wordings of the same
 *  fact**, not two separate facts. Drawing two arcs would only make the redundancy look
 *  nicer. So an edge derived from an inverse relation folds into its source edge; its
 *  wording attaches to that edge. A `sub_property` edge (`ceo_of ⊑ works_at`) does not
 *  fold — that is two facts at different levels of detail, and each one holds on its own.
 *
 *  2. The rest fan out grouped by **undirected pair**. Undirected matters here: an
 *  edge and its reverse edge have swapped source and target, so grouping by directed
 *  pair would put each in its own group of one, and both would land back on the same
 *  straight line. Grouping uses min/max, and placing on an arc flips the sign by the
 *  edge's own direction — sigma's curvature is relative to source→target, and without
 *  the flip, the reverse arc would bow to the same side. */
function layOutParallelEdges(edges: GraphEdge[]): {
  edges: PlacedEdge[];
  folded: number;
} {
  const pairKey = (a: string, b: string) => (a < b ? `${a} ${b}` : `${b} ${a}`);
  const push = (m: Map<string, GraphEdge[]>, k: string, e: GraphEdge) => {
    const list = m.get(k);
    if (list) list.push(e);
    else m.set(k, [e]);
  };

  // ---- 1. Fold in edges derived from an inverse relation
  const survivors: GraphEdge[] = [];
  const inverses: GraphEdge[] = [];
  for (const e of edges) {
    if (e.derived && e.rule === "inverse") inverses.push(e);
    else survivors.push(e);
  }
  /* **Find the source edge by premise, not by node pair.**
     An earlier version took "the first edge on that pair of nodes." That attached
     `contains` to an `allied_with` edge that happened to connect the same two nodes —
     but `contains` belongs to `part_of`. A wrong attachment like this looks completely
     normal on screen, which makes it the hardest kind of bug to find. The premise
     comes from the server; use it. */
  const onScreen = new Map<string, GraphEdge>();
  for (const e of survivors) onScreen.set(e.id, e);

  const also = new Map<string, string[]>();
  let folded = 0;
  for (const e of inverses) {
    const host = (e.premises ?? []).map((p) => onScreen.get(p)).find(Boolean);
    if (!host) {
      // The source edge is not on this screen (the timeline filtered it out, or it
      // is itself derived and got filtered). **Keep this edge on its own** — folding
      // it into an edge that does not exist would delete the fact it carries.
      survivors.push(e);
      continue;
    }
    const list = also.get(host.id) ?? [];
    // Deduplicate: several derived `part_of` edges can each have their own inverse,
    // and their premise chains can all lead back to the same edge. That would attach
    // the same wording three times. **A wording is a name, not a count.**
    const name = e.label ?? e.predicate ?? "";
    if (!list.includes(name)) list.push(name);
    also.set(host.id, list);
    folded++;
  }

  // ---- 2. Fan the rest out, grouped by undirected pair
  const groups = new Map<string, GraphEdge[]>();
  for (const e of survivors) push(groups, pairKey(e.source, e.target), e);

  const placed: PlacedEdge[] = [];
  for (const group of groups.values()) {
    const n = group.length;
    group.forEach((e, i) => {
      // Spread symmetrically around the straight line: n=1 → [0]; n=2 → [-0.5, 0.5];
      // n=3 → [-1, 0, 1].
      const offset = n === 1 ? 0 : i - (n - 1) / 2;
      const sign = e.source < e.target ? 1 : -1;
      placed.push({
        edge: e,
        curvature: offset === 0 ? 0 : sign * offset * EDGE_CURVATURE_STEP,
        alsoLabels: also.get(e.id) ?? [],
      });
    });
  }
  return { edges: placed, folded };
}
// The pulse cycle. This animation is not decorative — a static color difference is
// too small to notice among hundreds of edges.
const DERIVED_PULSE_MS = 2200;
// Above this count, edges get color only, with no animation. **This is a stated
// limit, not a silent degrade**: recomputing colors for thousands of edges every
// frame makes the graph too slow to drag, and at that point the user needs a graph
// that responds, not a graph that pulses.
const DERIVED_ANIMATE_MAX = 400;
// The fade duration for the derived-edges toggle. **Slightly longer than FADE_MS
// (320)**: a playback fade-in brings edges in one after another, but this toggle
// brings a whole batch of edges in or out at once, and a slower pace makes it clear
// that batch of gold lines is leaving together.
const DERIVED_TOGGLE_MS = 420;
/* Derived edges **arrive slightly after the facts**, then fade in as a group.

   An earlier version animated the derivation itself: light up each premise in order,
   then light up the conclusion. Two versions of this were tried, and neither read
   clearly. The first version flashed each premise and turned it off, so by the time
   the conclusion appeared the premises had already dimmed. The second version lit
   and dimmed each whole group together, but dozens of groups still flickered across
   the graph at different times, and no one could tell which edge belonged to which
   group.
   **A graph with hundreds of edges is not the place to explain a chain of reasoning.**
   The Derived panel in the side rail lists that, edge by edge, far more clearly. This
   view only needs to state one fact: these edges came later, and they are not the
   same kind of thing as an edge someone wrote. Arriving later, with their own color,
   already says that. */
const DERIVE_SETTLE_MS = 500; // How long after the facts settle before derived edges follow
const DERIVE_FADE_MS = 620; // Fade-in duration, slower than the toggle — this is an entrance, not a switch
// The legend shows at most this many pill labels; the rest collapse into "+N classes."
// **This row lays out horizontally.** Too many classes wrap it onto a new line and push
// the canvas down. A dozen identical pills in a row also give no sign of which class
// matters. The collapsed ones stay searchable through "+N."
const LEGEND_MAX = 6;
/* The selectable node-count levels. **Levels, not a text field**: this number has no
   "precise" value — it only affects whether the graph is readable or draggable, and
   the user wants "more points" or "fewer points," not the number 237. The maximum
   matches the server's GRAPH_NODE_CAP_MAX; past that, dragging breaks down before
   clarity does. */
const NODE_BUDGETS: number[] = [150, 300, 600, 1000];
// Note: under premultiplied blending (ONE, ONE_MINUS_SRC_ALPHA), sigma's edge shader
// does not premultiply RGB, so alpha alone cannot dim an edge — dimming must be
// encoded into RGB (an opaque color close to the background).
const EDGE_DIM = "#141414";
const EDGE_FOCUS = "rgba(255,255,255,0.55)";
// Derived edges when selected or hovered. **This must not fade toward white along with
// the rest** — selection is exactly when a user looks closest, and that is the moment
// "this edge is derived; no one wrote it" needs to be clearest.
// The old rule used EDGE_FOCUS everywhere, so a selected gold line turned white and
// lost its meaning. This color stays brighter and more solid than the resting gold —
// it still needs to say "this is selected."
const EDGE_FOCUS_DERIVED = "rgba(255,214,140,0.95)";
const MUTED_SHELL = "#151515";
/* How much everything else dims on hover. **Lighter than on selection** (selection
   dims all the way): hover follows the mouse and changes with every node the pointer
   crosses, so dimming all the way would make the whole canvas flicker. If the two
   states dimmed by the same amount, "I am just passing over this" and "I selected
   this" would look the same. This level keeps a gap: dim, but not all the way — the
   focus is visible, and so is the fact that this is only a pass-over.
   (0.55 was tried and tested too pale; the focus did not stand out enough.) */
const HOVER_MUTE = 0.78;
const PILL_BG = "rgba(12,12,12,0.9)";
const PILL_BORDER = "rgba(255,255,255,0.14)";
const PILL_TEXT = "#ededed";
const TRANSPARENT = "rgba(0,0,0,0)";
const DAY_MS = 24 * 3600 * 1000;

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return [128, 128, 128];
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** Mixes color c1 toward color c2 by ratio t. */
function mix(c1: string, c2: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(c1);
  const [r2, g2, b2] = hexToRgb(c2);
  const f = (a: number, b: number) => Math.round(a + (b - a) * t);
  return `rgb(${f(r1, r2)},${f(g1, g2)},${f(b1, b2)})`;
}

/* For playback fade-in: parses hex / rgb / rgba (with alpha) for linear interpolation. */
function parseRgba(c: string): [number, number, number, number] {
  if (c.startsWith("#")) {
    const [r, g, b] = hexToRgb(c);
    return [r, g, b, 1];
  }
  const m = c.match(
    /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/,
  );
  if (!m) return [128, 128, 128, 1];
  return [+m[1], +m[2], +m[3], m[4] !== undefined ? +m[4] : 1];
}
function lerpColor(from: string, to: string, t: number): string {
  const a = parseRgba(from);
  const b = parseRgba(to);
  const f = (i: number) => a[i] + (b[i] - a[i]) * t;
  return `rgba(${Math.round(f(0))},${Math.round(f(1))},${Math.round(f(2))},${f(3).toFixed(3)})`;
}
/** How long a new element fades in during playback. */
const FADE_MS = 320;

/* The world-coordinate grid moves with the camera pan and zoom (the same convention
   Figma and tldraw use for an infinite canvas). Detail levels step by a factor of 4:
   each level's alpha fades in continuously with its screen spacing (from 13px to full
   brightness at 52px, capped at 5.5%). Where a coarse line and a fine line overlap,
   their brightness adds naturally, giving a "large grid, small grid" layering with no
   sudden jump. */
const GRID_BASE_WORLD = 24; // Base world grid spacing (matches a layout at roughly 300 scale)
const GRID_FADE_IN_PX = 13;
const GRID_FULL_PX = 52;
const GRID_MAX_LEVEL_PX = 480;
const GRID_MAX_ALPHA = 0.055;

function drawWorldGrid(canvas: HTMLCanvasElement, sigma: Sigma): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { width, height } = sigma.getDimensions();
  const dpr = window.devicePixelRatio || 1;
  const pw = Math.round(width * dpr);
  const ph = Math.round(height * dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  if (width <= 0 || height <= 0) return;

  // World-to-screen: two probe points give pixels per world unit and the origin
  // position (the camera never rotates in this view).
  const p0 = sigma.graphToViewport({ x: 0, y: 0 });
  const p1 = sigma.graphToViewport({ x: 1, y: 0 });
  const ppw = p1.x - p0.x;
  if (!Number.isFinite(ppw) || ppw <= 0) return;

  // The finest visible level: the smallest power-of-4 spacing whose screen distance
  // is at least the fade-in threshold.
  let spacing = GRID_BASE_WORLD;
  while (spacing * ppw < GRID_FADE_IN_PX) spacing *= 4;
  while (spacing * ppw >= GRID_FADE_IN_PX * 4) spacing /= 4;

  for (let sp = spacing; sp * ppw < GRID_MAX_LEVEL_PX; sp *= 4) {
    const ss = sp * ppw;
    const t = Math.min(
      1,
      (ss - GRID_FADE_IN_PX) / (GRID_FULL_PX - GRID_FADE_IN_PX),
    );
    if (t <= 0) continue;
    ctx.strokeStyle = `rgba(255,255,255,${(GRID_MAX_ALPHA * t).toFixed(4)})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const startX = ((p0.x % ss) + ss) % ss;
    for (let x = startX; x <= width; x += ss) {
      const px = Math.round(x) + 0.5;
      ctx.moveTo(px, 0);
      ctx.lineTo(px, height);
    }
    const startY = ((p0.y % ss) + ss) % ss;
    for (let y = startY; y <= height; y += ss) {
      const py = Math.round(y) + 0.5;
      ctx.moveTo(0, py);
      ctx.lineTo(width, py);
    }
    ctx.stroke();
  }
}

/* A pill label: a dark rounded background with soft text (the same floating-label
   style as Semantica). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function drawPillLabel(
  ctx: CanvasRenderingContext2D,
  data: any,
  settings: any,
): void {
  if (!data.label) return;
  // On hover, the hover card (drawHoverCard) takes over the display, so the base
  // pill hides to avoid showing two labels at once.
  if (data.hideBaseLabel) return;
  // Semantica chip: fontSize=clamp(10, size*0.25, 11), padding 6/3, radius 6,
  // positioned above the node, with a shadow blur of 12.
  const size = Math.max(10, Math.min(11, data.size * 0.25));
  ctx.font = `500 ${size}px Geist, Inter, "Noto Sans SC", sans-serif`;
  ctx.textBaseline = "middle";
  const padX = 6;
  const padY = 3;
  const w = ctx.measureText(data.label).width + padX * 2;
  const h = size + padY * 2;
  const x = data.x + Math.max(data.size * 0.7, 12);
  const y = data.y - Math.max(data.size * 0.9, 10) - h;
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.6)";
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 6);
  ctx.fillStyle = PILL_BG;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = PILL_BORDER;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = PILL_TEXT;
  ctx.fillText(data.label, x + padX, y + h / 2);
  ctx.restore();
}

/* The hover card (following Semantica's hoverCard spec): a soft radial glow, a name,
   and a type row. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function drawHoverCard(
  ctx: CanvasRenderingContext2D,
  data: any,
  _settings: any,
): void {
  if (!data.label) return;
  ctx.save();

  // Glow: radius max(size*4.8, 16), type color alpha fading from 0.18 to 0.
  const glowR = Math.max(data.size * 4.8, 16);
  const [r, g, b] = hexToRgb((data.typeColor as string) ?? "#888888");
  const grad = ctx.createRadialGradient(
    data.x,
    data.y,
    0,
    data.x,
    data.y,
    glowR,
  );
  grad.addColorStop(0, `rgba(${r},${g},${b},0.18)`);
  grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(data.x, data.y, glowR, 0, Math.PI * 2);
  ctx.fill();

  // Card: title at weight 700 / size 13, type row at weight 500 / size 10, uppercase.
  const titleSize = 13;
  const metaSize = 10;
  const padX = 10;
  const padY = 7;
  const metaGap = 5;
  const meta = String(data.typeLabel ?? "NODE").toUpperCase();
  ctx.textBaseline = "top";
  ctx.font = `700 ${titleSize}px Geist, Inter, "Noto Sans SC", sans-serif`;
  const titleW = ctx.measureText(data.label).width;
  ctx.font = `500 ${metaSize}px Geist, Inter, sans-serif`;
  const metaW = ctx.measureText(meta).width;
  const w = Math.max(titleW, metaW) + padX * 2;
  const h = padY * 2 + titleSize + metaGap + metaSize;
  const x = data.x + Math.max(data.size * 0.9, 16);
  const y = data.y - Math.max(data.size * 1.1, 16) - h;

  ctx.shadowColor = "rgba(0,0,0,0.62)";
  ctx.shadowBlur = 15;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 8);
  ctx.fillStyle = "rgba(12,12,12,0.94)";
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = "rgba(255,255,255,0.16)";
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = "#f5f5f5";
  ctx.font = `700 ${titleSize}px Geist, Inter, "Noto Sans SC", sans-serif`;
  ctx.fillText(data.label, x + padX, y + padY);
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.font = `500 ${metaSize}px Geist, Inter, sans-serif`;
  ctx.fillText(meta, x + padX, y + padY + titleSize + metaGap);
  ctx.restore();
}

export function Graph() {
  const kbId = useKbId();
  const { kb } = useKb();
  /* The address bar and the canvas stay synced **in both directions**.
     An earlier version only had the "read" half: `?entity=` was read once on mount
     and then ignored. A link someone sent you worked, but you could not share what
     you were looking at, because the address bar always stayed at a bare /graph. */
  const search = useSearch({ from: "/app/kb/$kbId/graph" });
  const navigate = useNavigate();
  const entityParam = search.entity;
  const [focusEntity, setFocusEntity] = useState<string | null>(
    search.focus ?? entityParam ?? null,
  );
  const [selected, setSelected] = useState<string | null>(entityParam ?? null);
  const [searchInput, setSearchInput] = useState("");
  const [searchQ, setSearchQ] = useState("");
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());
  // Whether to show derived edges. Shown by default — inference is off by default,
  // so any derived edges present mean the user already turned that setting on.
  const [showDerived, setShowDerived] = useState(true);
  // The inference panel starts collapsed: it answers "when was this derived," and
  // that question comes up only occasionally.
  /* The Inference panel expands in place, the same pattern as "+N classes," alerts,
     and the user menu. **Anchored to the bottom left**: the tower sits at the bottom
     left of the canvas, so the panel grows up and to the right from that "…" button. */
  const derivedPop = usePopoverFlip<HTMLButtonElement, HTMLDivElement>(
    "bottom left",
  );
  /* "+N classes" uses the same in-place expansion as the alert and user cards: the
     panel starts at the chip's true boundary (a 999px rounded corner) and grows into
     a card. **Anchored to the left, so the anchor corner is top left.** */
  const legendPop = usePopoverFlip<HTMLButtonElement, HTMLDivElement>(
    "top left",
  );
  const [legendQ, setLegendQ] = useState("");
  /* The entity currently exiting the panel. **The panel must not unmount the instant
     it is deselected** — that would make it disappear instantly. It stays in place to
     finish its exit animation, then unmounts. This reads the current value through
     selectedRef instead of writing setState as an updater with a side effect —
     that pattern runs twice under StrictMode. */
  const [exiting, setExiting] = useState<string | null>(null);
  const deselect = useCallback(() => {
    const cur = selectedRef.current;
    if (!cur) return;
    setExiting(cur);
    setSelected(null);
    window.setTimeout(() => setExiting(null), 170);
  }, []);
  /** null means all time; a number means an as-of moment, in milliseconds.
      Defaults to as-of today: on a temporal platform, the graph shows "the world as
      it is now" by default. A closed fact should not sit next to a current fact with
      no distinction. Choosing All time is an explicit action. */
  /* The timeline. Uses the value from the URL when present: `all` means all time,
     otherwise parse YYYY-MM-DD (this matches the data's day-level precision and
     reads more clearly than a string of milliseconds). */
  const [timeT, setTimeT] = useState<number | null>(() => {
    if (search.at === "all") return null;
    if (search.at) {
      const t = Date.parse(search.at);
      if (!Number.isNaN(t)) return t;
    }
    return Date.now();
  });
  const [activeCount, setActiveCount] = useState(0);
  const [stabilizing, setStabilizing] = useState(false);
  /* Playback state lives at this level: the reducer must tell "advancing during
     playback" (fade in) apart from "manual drag" (an instant jump). */
  const [playing, setPlaying] = useState(false);

  /* Canvas state → address bar. **Use replace, not push**: clicking a node is
     browsing, not navigating, and pushing each click onto history would turn "back"
     into undoing one click at a time. Skip this entirely during playback — writing
     the URL every frame would be disastrous. */
  useEffect(() => {
    if (playing) return;
    const at =
      timeT === null
        ? "all"
        : // Do not write the URL when stopped at "now." Otherwise every visit would
          // drag today's date into the address bar, when that is already the default.
          Math.abs(timeT - Date.now()) < DAY_MS
          ? undefined
          : new Date(timeT).toISOString().slice(0, 10);
    const next = {
      entity: selected ?? undefined,
      // **Omit this when it equals entity**: clicking a search result sets both at
      // once, and writing both would put the same UUID twice in the address bar.
      // This carries information only when "focused on A's neighborhood, but B is
      // selected" is actually true.
      focus:
        focusEntity && focusEntity !== selected ? focusEntity : undefined,
      at,
    };
    if (
      next.entity === search.entity &&
      next.focus === search.focus &&
      next.at === search.at
    )
      return;
    navigate({
      to: "/kb/$kbId/graph",
      params: { kbId },
      search: next,
      replace: true,
    });
  }, [
    selected,
    focusEntity,
    timeT,
    playing,
    search.entity,
    search.focus,
    search.at,
    navigate,
  ]);

  /* Address bar → canvas state. **This half exists for browser back and forward.**
     Without it, the browser's back button changes the address but not the canvas,
     which looks like back is broken. Both directions compare before acting, so they
     do not conflict with each other. */
  useEffect(() => {
    const e = search.entity ?? null;
    const f = search.focus ?? null;
    setSelected((cur) => (cur === e ? cur : e));
    setFocusEntity((cur) => (cur === f ? cur : f));
  }, [search.entity, search.focus]);
  /* Layout mode: force = FA2 repulsion; circular = a ring; pack = circles packed and
     clustered by type. */
  type LayoutMode = "force" | "circular" | "pack";
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("force");
  const layoutModeRef = useRef<LayoutMode>("force");
  const layoutCtlRef = useRef<{ apply: (m: LayoutMode) => void } | null>(null);

  /* How many nodes to draw. **This goes in the queryKey** — without it, changing the
     level does not refetch, and the interface looks changed while the data is still
     old. */
  const [nodeBudget, setNodeBudget] = useState<number>(NODE_BUDGETS[0]);

  const data = useQuery({
    queryKey: ["graph", kb?.id, focusEntity, nodeBudget],
    queryFn: () =>
      focusEntity
        ? api.graphNeighborhood(kb!.id, focusEntity)
        : api.graphOverview(kb!.id, nodeBudget),
    enabled: !!kb,
  });

  // The full-graph mode searches every entity in the base; the subgraph mode filters
  // on the client, only within the subgraph already loaded.
  const inSubgraph = !!focusEntity;
  // The cap on search hits. **"Load more," not pagination**: this is a dropdown of
  // suggestions, and the user is looking for one specific entity. Pagination would
  // make them lose the rows they just scanned.
  const [searchLimit, setSearchLimit] = useState(10);
  useEffect(() => setSearchLimit(10), [searchQ]);
  const candidates = useQuery({
    queryKey: ["entitySearch", kb?.id, searchQ, searchLimit],
    queryFn: () => api.searchEntities(kb!.id, searchQ, searchLimit),
    enabled: !!kb && searchQ.length > 0 && !inSubgraph,
    placeholderData: (prev) => prev,
  });
  const subgraphHits = useMemo(() => {
    if (!inSubgraph || !searchQ || !data.data) return [];
    const q = searchQ.toLowerCase();
    return data.data.nodes
      .filter(
        (n) =>
          n.name.toLowerCase().includes(q) ||
          n.disambiguator?.toLowerCase().includes(q),
      )
      .slice(0, 10);
  }, [inSubgraph, searchQ, data.data]);
  const searchHits = inSubgraph
    ? subgraphHits
    : (candidates.data?.entities ?? []);

  const containerRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLCanvasElement>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  /* Focus: hover takes priority over selection; the reducer handles all styling. */
  const selectedRef = useRef<string | null>(null);
  const hoverRef = useRef<string | null>(null);
  /** Which edge the mouse rests on. Used to reveal the inverse-relation wordings
   *  folded into it. */
  const hoverEdgeRef = useRef<string | null>(null);
  const filterRef = useRef<{
    hiddenTypes: Set<string>;
    activeNodes: Set<string> | null;
    activeEdges: Set<string> | null;
    /** Whether to show derived edges. **Shown by default** — inference is off by
     *  default, so any derived edges present mean the user turned the setting on.
     *  This still lets a user hide them with one click, to see "only the facts
     *  someone stated." */
    showDerived: boolean;
  }>({
    hiddenTypes: new Set(),
    activeNodes: null,
    activeEdges: null,
    showDerived: true,
  });
  const playingRef = useRef(false);
  /* The playback fade-in table: maps a node or edge id newly activated this round to
     its activation time (an rAF loop drives it until settled). */
  const fadeRef = useRef<Map<string, number>>(new Map());
  const fadeRafRef = useRef(0);

  const kickFade = useCallback(() => {
    if (fadeRafRef.current) return;
    const step = () => {
      const now = performance.now();
      for (const [id, start] of fadeRef.current)
        if (now - start >= FADE_MS) fadeRef.current.delete(id);
      sigmaRef.current?.refresh();
      fadeRafRef.current = fadeRef.current.size
        ? requestAnimationFrame(step)
        : 0;
    };
    fadeRafRef.current = requestAnimationFrame(step);
  }, []);

  useEffect(() => {
    playingRef.current = playing;
    if (!playing) {
      // When playback stops, jump any unfinished fade straight to its end state.
      fadeRef.current.clear();
      sigmaRef.current?.refresh();
    }
  }, [playing]);

  useEffect(() => () => cancelAnimationFrame(fadeRafRef.current), []);

  const types = useMemo(() => {
    const map = new Map<
      string,
      { label: string; color: string; shape: string; count: number }
    >();
    for (const n of data.data?.nodes ?? []) {
      // An entity with no judged type falls into the empty-key bucket (see ADR 0009).
      // A real key derives from an IRI, so it can never be empty — this key cannot
      // collide with a real class. The label goes through i18n, so the legend never
      // shows a raw null.
      const key = n.type_key ?? "";
      const cur = map.get(key);
      if (cur) cur.count++;
      else
        map.set(key, {
          label: n.type_label ?? S.graph.untyped,
          color: n.color,
          shape: n.shape,
          count: 1,
        });
    }
    // **Sort by count, not by order of encounter.** The legend fits only a few
    // classes, and those slots should go to the classes that appear most. An earlier
    // version sorted by node arrival order, which is effectively random. Equal
    // counts sort by label — otherwise the same data would show a different order
    // on every refresh.
    return [...map.entries()].sort(
      (a, b) => b[1].count - a[1].count || a[1].label.localeCompare(b[1].label),
    );
  }, [data.data]);

  /* The classes shown directly, and the classes collapsed. A collapsed class is
     still searchable and can still be toggled from "+N." */
  const legendShown = types.slice(0, LEGEND_MAX);
  const legendRest = types.slice(LEGEND_MAX);
  // Whether any collapsed class is currently hidden. **Without this marker, hiding
  // is silent** — a user could turn off a class in the panel, collapse the panel,
  // and see nothing on screen state that it is off.
  const hiddenInRest = legendRest.filter(([k]) => hiddenTypes.has(k)).length;

  // How many derived edges exist. **When this is zero, the toggle does not appear at
  // all** — a base with inference turned off should not show a button that never
  // changes anything when clicked.
  const derivedCount = useMemo(
    () => (data.data?.edges ?? []).filter((e) => e.derived).length,
    [data.data],
  );

  /* Time filter: computes the set of edges and nodes active at moment T. */
  const recomputeActive = useCallback(
    (t: number | null) => {
      const d = data.data;
      if (!d) return;
      if (t === null) {
        filterRef.current.activeNodes = null;
        filterRef.current.activeEdges = null;
        setActiveCount(d.edges.length);
      } else {
        const prevNodes = filterRef.current.activeNodes;
        const prevEdges = filterRef.current.activeEdges;
        const edges = new Set<string>();
        const nodes = new Set<string>();
        const touched = new Set<string>();
        for (const e of d.edges) {
          const vf = e.valid_from ? Date.parse(e.valid_from) : null;
          const vt = e.valid_to ? Date.parse(e.valid_to) : null;
          touched.add(e.source);
          touched.add(e.target);
          const active =
            vf === null ? true : vf <= t && (vt === null || vt > t);
          if (active) {
            edges.add(e.id);
            nodes.add(e.source);
            nodes.add(e.target);
          }
        }
        // An isolated node with no edges stays visible.
        for (const n of d.nodes) if (!touched.has(n.id)) nodes.add(n.id);
        // During playback, a newly appearing element fades in; a manual drag stays
        // an instant switch.
        if (playingRef.current) {
          const now = performance.now();
          for (const id of edges)
            if (prevEdges && !prevEdges.has(id)) fadeRef.current.set(id, now);
          for (const id of nodes)
            if (prevNodes && !prevNodes.has(id)) fadeRef.current.set(id, now);
          if (fadeRef.current.size) kickFade();
        }
        filterRef.current.activeNodes = nodes;
        filterRef.current.activeEdges = edges;
        setActiveCount(edges.size);
      }
      sigmaRef.current?.refresh();
    },
    [data.data, kickFade],
  );

  useEffect(() => {
    filterRef.current.hiddenTypes = hiddenTypes;
    filterRef.current.showDerived = showDerived;
    sigmaRef.current?.refresh();
  }, [hiddenTypes, showDerived]);

  const deriveRafRef = useRef(0);
  /* Derived edges do not appear until their entrance animation finishes. **The
     toggle controls "show or not"; this controls "has the animation played yet."**
     Merging these two would skip one play-through when a user toggles off and back
     on. */
  const [derivedRevealed, setDerivedRevealed] = useState(false);
  /* The reducer is a closure that runs every frame; reading state there would read
     a stale value. It only reads refs. */
  const derivedRevealedRef = useRef(false);
  useEffect(() => {
    derivedRevealedRef.current = derivedRevealed;
    sigmaRef.current?.refresh();
  }, [derivedRevealed]);

  const revealDerived = useCallback(() => {
    setDerivedRevealed(true);
    // Reuses the toggle's fade: direction "on," brightening from near-background
    // color to its normal color.
    derivedToggleRef.current = { at: performance.now(), on: true };
    const step = () => {
      const tr = derivedToggleRef.current;
      const done = !tr || performance.now() - tr.at >= DERIVE_FADE_MS;
      if (done) derivedToggleRef.current = null;
      sigmaRef.current?.refresh();
      deriveRafRef.current = done ? 0 : requestAnimationFrame(step);
    };
    cancelAnimationFrame(deriveRafRef.current);
    deriveRafRef.current = requestAnimationFrame(step);
  }, []);

  useEffect(() => () => cancelAnimationFrame(deriveRafRef.current), []);

  /* The toggle's fade state: { start time, which direction }; null means no
     transition is running. */
  const derivedToggleRef = useRef<{ at: number; on: boolean } | null>(null);
  const derivedRafRef = useRef(0);
  /* The previous value of the toggle. **This is the only way to tell "did the toggle
     actually flip."** The effect's dependencies include derivedCount, and clicking
     Run now can derive new edges and change that count without touching the toggle.
     Watching only the effect firing would fade once with no user action behind it. */
  const prevShowDerived = useRef(showDerived);

  // On toggle, fade over a short transition instead of disappearing instantly.
  // **This effect must drive its own redraw** — when turned off, the pulse timer
  // below stops running, so nothing else pushes sigma to redraw, and the fade-out
  // would freeze on its first frame.
  useEffect(() => {
    const changed = prevShowDerived.current !== showDerived;
    prevShowDerived.current = showDerived;
    // Neither the first mount nor "only the count changed" counts as a toggle:
    // entering the page, and inference finishing and refreshing the count, should
    // never show an unexplained fade.
    if (!changed) return;
    // Skip the fade above this count, for the same reason as the pulse: recomputing
    // colors for thousands of edges every frame causes stutter. **This is a stated
    // limit, not a silent degrade.**
    if (derivedCount > DERIVED_ANIMATE_MAX) return;

    const now = performance.now();
    const prev = derivedToggleRef.current;
    // If the user reverses direction mid-fade (clicking twice quickly), continue
    // from the current progress instead of starting over — otherwise the brightness
    // would jump.
    const at =
      prev && prev.on !== showDerived
        ? now - Math.max(0, DERIVED_TOGGLE_MS - (now - prev.at))
        : now;
    derivedToggleRef.current = { at, on: showDerived };

    const step = () => {
      const tr = derivedToggleRef.current;
      const done = !tr || performance.now() - tr.at >= DERIVED_TOGGLE_MS;
      if (done) derivedToggleRef.current = null;
      sigmaRef.current?.refresh();
      derivedRafRef.current = done ? 0 : requestAnimationFrame(step);
    };
    cancelAnimationFrame(derivedRafRef.current);
    derivedRafRef.current = requestAnimationFrame(step);
    // **No cleanup function here**: a cleanup would also run whenever a dependency
    // changes, and derivedCount is a dependency. If inference finishes partway
    // through this 420ms window, the animation would cut off mid-fade (the canvas
    // would stop at half brightness until the next unrelated redraw). The loop ends
    // itself; cancellation should happen only on unmount.
  }, [showDerived, derivedCount]);

  // On unmount, cancel any frame still scheduled.
  useEffect(() => () => cancelAnimationFrame(derivedRafRef.current), []);

  /* When derived edges enter. Both entry points (opening the page, and manually
     turning on the toggle) share the same delay. **This does not wait for the
     layout to settle** — settling takes 2.5 seconds, and by then the user is
     already looking elsewhere.

     **The order itself carries meaning**: edges someone wrote settle first, and only
     then do derived edges follow. Appearing together would make it impossible to
     tell which came first. */
  useEffect(() => {
    if (!showDerived || !data.data) {
      if (!showDerived) setDerivedRevealed(false);
      return;
    }
    if (derivedRevealed) return;
    const t = window.setTimeout(revealDerived, DERIVE_SETTLE_MS);
    return () => window.clearTimeout(t);
  }, [showDerived, data.data, derivedRevealed, revealDerived]);

  // The derived-edge pulse. **This runs only when derived edges exist, are shown,
  // and are not too many** — a base with inference off should not redraw every two
  // seconds for no reason.
  useEffect(() => {
    const n = derivedCount;
    if (!showDerived || n === 0 || n > DERIVED_ANIMATE_MAX) return;
    // This only needs to match sigma's redraw rate, not every frame: the pulse is
    // slow, and 30 fps looks no different from 60.
    const timer = setInterval(() => sigmaRef.current?.refresh(), 1000 / 30);
    return () => clearInterval(timer);
  }, [showDerived, derivedCount]);

  useEffect(() => {
    selectedRef.current = selected;
    sigmaRef.current?.refresh();
  }, [selected]);

  useEffect(() => {
    recomputeActive(timeT);
  }, [timeT, recomputeActive]);

  useEffect(() => {
    if (!containerRef.current || !data.data) return;
    const g = new Graphology({ multi: true });
    for (const n of data.data.nodes) {
      if (!g.hasNode(n.id)) {
        g.addNode(n.id, {
          label: n.name,
          // Semantica's recipe: a dark shell with a 14% type tint, a core at 50%
          // tint, and a steel-gray border with a slight tint.
          color: mix(NODE_CORE_BASE, n.color, NODE_CORE_MIX),
          shellColor: mix(NODE_SHELL_BASE, n.color, NODE_TINT_MIX),
          borderColor: mix(NODE_BORDER_BASE, n.color, 0.3),
          ringColor: TRANSPARENT,
          typeColor: n.color,
          typeLabel: n.type_label ?? S.graph.untyped,
          typeKey: n.type_key ?? "",
          type: n.shape === "square" ? "square" : "shell",
          size: 5 + Math.min(8, Math.sqrt(Number(n.degree)) * 1.6),
        });
      }
    }
    const placed = layOutParallelEdges(
      data.data.edges.filter((e) => g.hasNode(e.source) && g.hasNode(e.target)),
    );
    for (const { edge: e, curvature, alsoLabels } of placed.edges) {
      g.addEdgeWithKey(e.id, e.source, e.target, {
        label: e.label?.toUpperCase() ?? "",
        size: 1,
        color: e.derived
          ? EDGE_COLOR_DERIVED
          : e.inferred
            ? EDGE_COLOR_INFERRED
            : EDGE_COLOR,
        // A single edge draws as a straight line: curves exist only to separate
        // overlapping edges, so with no overlap there is no need to curve.
        type: curvature === 0 ? "line" : "curved",
        curvature,
        // The inverse-relation wordings folded into this edge, shown together with
        // its own name on hover.
        alsoLabels,
        // The reducer reads this every frame, to decide whether to hide or pulse
        // this edge.
        derived: e.derived,
      });
    }
    // Layout: place nodes statically first, then animate with a worker to settle
    // over roughly 2.5s (the same "stabilizing" pattern Semantica uses).
    let fa2: InstanceType<typeof FA2Layout> | null = null;
    let stabilizeTimer: ReturnType<typeof setTimeout> | null = null;
    // Drag state is declared before fa2, because outputReducer's closure refers to it.
    let dragged: string | null = null;
    let dragPos: { x: number; y: number } | null = null;
    let fa2Settings: ReturnType<typeof forceAtlas2.inferSettings> | null = null;
    if (g.order > 0) {
      circular.assign(g, { scale: 300 });
      /* Scaling these settings by graph size was tried (gravity 0.12-0.22,
         scalingRatio 11-16, with more damping), and testing against a real graph
         ruled it out: the nodes did spread out, but the graph lost the tension of
         "nodes pushing against each other" and looked limp. **This fixed, deliberately
         large setting is intentional** — the goal is nodes visibly pushing against
         each other, not the layout that costs the least energy. */
      const settings = {
        ...forceAtlas2.inferSettings(g),
        gravity: 0.35,
        scalingRatio: 22,
        outboundAttractionDistribution: true,
      };
      fa2Settings = settings;
      forceAtlas2.assign(g, { iterations: 60, settings });
      fa2 = new FA2Layout(g, {
        settings,
        // Key point: on write-back, pin the dragged node to the cursor (no flicker).
        // Providing an outputReducer also makes the supervisor call
        // readGraphPositions every frame, so the cursor position keeps feeding into
        // the force simulation.
        outputReducer: (node, attr) => {
          if (dragged && node === dragged && dragPos) {
            attr.x = dragPos.x;
            attr.y = dragPos.y;
          }
          return attr;
        },
      });
      fa2.start();
      setStabilizing(true);
      stabilizeTimer = setTimeout(() => {
        fa2?.stop();
        setStabilizing(false);
      }, 2500);
    }

    // After rebuilding the data, the layout goes back to force (the world regrows).
    setLayoutMode("force");
    layoutModeRef.current = "force";

    // Rescale any layout result to the same world scale FA2 uses (±target), so a
    // camera reset looks consistent regardless of layout.
    const rescaleWorld = (target = 300) => {
      let minX = Infinity,
        maxX = -Infinity,
        minY = Infinity,
        maxY = -Infinity;
      g.forEachNode((_n, a) => {
        minX = Math.min(minX, a.x as number);
        maxX = Math.max(maxX, a.x as number);
        minY = Math.min(minY, a.y as number);
        maxY = Math.max(maxY, a.y as number);
      });
      const span = Math.max(maxX - minX, maxY - minY) || 1;
      const k = (target * 2) / span;
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      g.updateEachNodeAttributes((_n, a) => ({
        ...a,
        x: (a.x - cx) * k,
        y: (a.y - cy) * k,
      }));
    };

    // Layout-switch control (attached to a ref so component-level buttons can call
    // it; the closure holds g and fa2 directly).
    layoutCtlRef.current = {
      apply: (mode) => {
        if (g.order === 0) return;
        if (stabilizeTimer) clearTimeout(stabilizeTimer);
        fa2?.stop();
        setStabilizing(false);
        if (mode === "force") {
          forceAtlas2.assign(g, {
            iterations: 60,
            settings: fa2Settings ?? undefined,
          });
          fa2?.start();
          setStabilizing(true);
          stabilizeTimer = setTimeout(() => {
            fa2?.stop();
            setStabilizing(false);
          }, 2500);
        } else if (mode === "circular") {
          circular.assign(g, { scale: 300 });
        } else {
          // Cluster by entity type: same-type entities pack into the same circle.
          circlepack.assign(g, { hierarchyAttributes: ["typeKey"] });
          rescaleWorld(300);
        }
        sigma.setCustomBBox(null);
        sigma.refresh();
        sigma.getCamera().animatedReset({ duration: 300 });
      },
    };

    sigmaRef.current?.kill();
    const sigma = new Sigma(g, containerRef.current, {
      allowInvalidContainer: true,
      defaultNodeType: "shell",
      nodeProgramClasses: {
        // Semantica's node anatomy, from outside in: status ring, border, dark
        // shell, tinted core.
        shell: createNodeBorderProgram({
          borders: [
            { size: { value: 0.1 }, color: { attribute: "ringColor" } },
            { size: { value: 0.07 }, color: { attribute: "borderColor" } },
            { size: { value: 0.3 }, color: { attribute: "shellColor" } },
            { size: { fill: true }, color: { attribute: "color" } },
          ],
        }),
        square: NodeSquareShellProgram,
      },
      renderEdgeLabels: true,
      defaultEdgeType: "line",
      /* Parallel edges fan out into arcs (see `layOutParallelEdges`). The
         straight-line version drew every edge between the same pair of nodes on the
         same segment, so several labels overlapped character by character into
         garbage. Testing found up to six edges stacked between a single pair. */
      edgeProgramClasses: { curved: EdgeCurveProgram },
      // Edge hover events are off by default. This turns them on for `enterEdge`:
      // the folded-in wordings need a way to become visible (see edgeReducer).
      enableEdgeEvents: true,
      labelFont: '"Geist", "Inter", "Noto Sans SC", sans-serif',
      labelSize: 11,
      labelColor: { color: "#e5e5e5" },
      labelRenderedSizeThreshold: 6,
      labelDensity: 0.7,
      labelGridCellSize: 140,
      minCameraRatio: 0.04,
      maxCameraRatio: 8,
      edgeLabelSize: 9,
      edgeLabelColor: { color: "#a1a1a1" },
      edgeLabelFont: '"Geist", "Inter", sans-serif',
      defaultDrawNodeLabel: drawPillLabel,
      defaultDrawNodeHover: drawHoverCard,
      nodeReducer: (node, attrs) => {
        const f = filterRef.current;
        const res = { ...attrs };
        const base = attrs.size as number;
        // The status ring takes the node's own type color (see the reasoning at
        // RING_*_MIX above).
        const ownColor = (attrs.typeColor as string) ?? NODE_CORE_BASE;
        if (f.hiddenTypes.has(attrs.typeKey as string)) {
          res.hidden = true;
          return res;
        }
        // Semantica's muted state: {×0.52, every layer dimmed}.
        const muteNode = () => {
          res.size = base * 0.52;
          res.color = mix(MUTED_SHELL, NODE_CORE_BASE, 0.3);
          res.shellColor = MUTED_SHELL;
          res.borderColor = TRANSPARENT;
          res.ringColor = TRANSPARENT;
          res.label = "";
          res.zIndex = 0;
        };
        /* On hover, everything else dims by HOVER_MUTE (selection dims all the way).
           Neighbors do not dim — hover exists to answer "what is this connected to,"
           and dimming the neighbors too would leave that question unanswered. */
        const softMute = () => {
          res.size = base * (1 - 0.48 * HOVER_MUTE);
          res.color = lerpColor(
            String(attrs.color ?? NODE_CORE_BASE),
            mix(MUTED_SHELL, NODE_CORE_BASE, 0.3),
            HOVER_MUTE,
          );
          res.shellColor = lerpColor(
            String(attrs.shellColor ?? NODE_SHELL_BASE),
            MUTED_SHELL,
            HOVER_MUTE,
          );
          res.borderColor = TRANSPARENT;
          res.ringColor = TRANSPARENT;
          res.label = "";
          res.zIndex = 0;
        };
        if (hoverRef.current === node) {
          res.size = Math.max(base * 1.08, 10.4);
          res.ringColor = mix(ownColor, "#ffffff", RING_HOVER_MIX);
          // The hover card takes over the label display; the label itself is kept
          // (the hover card renders its title from it).
          res.hideBaseLabel = true;
          res.zIndex = 4;
          return res;
        }
        const hov = hoverRef.current;
        // The selected entity might not be on the current canvas (during a side-rail
        // jump or while the neighborhood is reloading) — skip focus dimming if so.
        const sel =
          selectedRef.current && g.hasNode(selectedRef.current)
            ? selectedRef.current
            : null;
        if (sel) {
          if (node === sel) {
            res.size = Math.max(base * 1.02, 9.2);
            res.ringColor = mix(ownColor, "#ffffff", RING_SELECT_MIX);
            res.forceLabel = true;
            res.zIndex = 3;
            return res;
          }
          if (g.areNeighbors(sel, node)) {
            // Neighbor: {×0.76, minimum 4, zIndex 2}.
            res.size = Math.max(base * 0.76, 4);
            res.zIndex = 2;
          } else {
            muteNode();
            return res;
          }
        } else if (hov && hov !== node && !g.areNeighbors(hov, node)) {
          // **Hover also dims everything else**, just one level lighter than
          // selection (see HOVER_MUTE). Neighbors stay lit: hover exists to answer
          // exactly "what is this connected to."
          // **A node not currently active dims all the way**: this branch returns
          // early, skipping the time filter below. Dimming it only halfway would
          // leave it brighter than when there is no hover at all.
          if (f.activeNodes && !f.activeNodes.has(node)) muteNode();
          else softMute();
          return res;
        } else {
          // Default: {×0.7}.
          res.size = base * 0.7;
        }
        if (f.activeNodes && !f.activeNodes.has(node)) {
          muteNode();
          return res;
        }
        // Playback fade-in: transition from the muted shape to this frame's normal
        // shape.
        const fs = fadeRef.current.get(node);
        if (fs !== undefined) {
          const t = Math.min(1, (performance.now() - fs) / FADE_MS);
          res.size = (res.size as number) * (0.55 + 0.45 * t);
          res.color = lerpColor(
            MUTED_SHELL,
            String(res.color ?? NODE_CORE_BASE),
            t,
          );
          res.shellColor = lerpColor(
            MUTED_SHELL,
            String(res.shellColor ?? NODE_SHELL_BASE),
            t,
          );
          res.borderColor = lerpColor(
            "rgba(0,0,0,0)",
            String(res.borderColor ?? NODE_BORDER_BASE),
            t,
          );
          if (t < 0.7) res.label = "";
        }
        return res;
      },
      edgeReducer: (edge, attrs) => {
        const f = filterRef.current;
        const res = { ...attrs };
        const [s, t] = g.extremities(edge);
        /* The inverse-relation wordings folded into this edge, appended after its
           own name: `PART OF ⁻¹ CONTAINS`.
           **Shown only when this edge has attention** — showing it always would
           double the label length, and a label too long is the exact problem this
           feature fixes.
           Two triggers exist, because **an edge is only one pixel wide, and hovering
           it precisely is hard for a person too**: the mouse resting on the edge
           itself, or on either of its two end nodes. The second is the one actually
           used in practice; the first stays because sometimes a person really does
           point at that one edge.
           This runs before the hide/dim logic: wording is a display concern, not a
           visibility concern. */
        const also = attrs.alsoLabels as string[] | undefined;
        if (also && also.length > 0) {
          const focused =
            edge === hoverEdgeRef.current ||
            hoverRef.current === s ||
            hoverRef.current === t ||
            selectedRef.current === s ||
            selectedRef.current === t;
          if (focused) {
            res.label = `${attrs.label} ⁻¹ ${also
              .map((l) => l.toUpperCase())
              .join(" / ")}`;
          }
        }
        const sk = g.getNodeAttribute(s, "typeKey") as string;
        const tk = g.getNodeAttribute(t, "typeKey") as string;
        if (f.hiddenTypes.has(sk) || f.hiddenTypes.has(tk)) {
          res.hidden = true;
          return res;
        }
        // For a derived edge: check hidden state first, then decide its pulse
        // level. **This check runs first** — a hidden edge does not need any of
        // the brighten/dim math that follows.
        const isDerived = attrs.derived === true;

        if (isDerived) {
          // Its turn to enter has not come yet: do not draw it. **Facts settle
          // first; derived edges follow.**
          if (!derivedRevealedRef.current) {
            res.hidden = true;
            return res;
          }
          const tr = derivedToggleRef.current;
          const k = tr
            ? Math.min(1, (performance.now() - tr.at) / DERIVED_TOGGLE_MS)
            : 1;
          // Turned off: the only case still drawn is a fade-out still in progress.
          if (!f.showDerived) {
            if (!tr || tr.on || k >= 1) {
              res.hidden = true;
              return res;
            }
            /* Fades from its current color to near-background. **Dimming must be
               encoded in RGB** (see the note at EDGE_DIM: under premultiplied
               blending, alpha cannot dim an edge), so this mixes toward EDGE_DIM
               instead of lowering alpha.

               **The start color cannot always be full-bright gold**: this branch
               returns before the hover/selection dimming logic runs, so an unrelated
               derived edge that should already be dim would jump back to full
               brightness before fading out — that jump is the "unrelated edges flash
               when derived edges turn off" bug. The start color must be whatever
               this edge actually looks like right now. */
            const selNow =
              selectedRef.current && g.hasNode(selectedRef.current)
                ? selectedRef.current
                : null;
            const hovNow = hoverRef.current;
            const focused = selNow ?? hovNow;
            const from = !focused
              ? EDGE_COLOR_DERIVED
              : s === focused || t === focused
                ? EDGE_FOCUS_DERIVED
                : EDGE_DIM;
            res.color = lerpColor(from, EDGE_DIM, k);
            res.label = "";
            return res;
          }
          const pulse = lerpColor(
            EDGE_COLOR_DERIVED_DIM,
            EDGE_COLOR_DERIVED,
            // A triangle wave, not a sine wave: it pauses briefly at each end, so it
            // reads as a "pulse," not a "flash."
            Math.abs(
              ((performance.now() % DERIVED_PULSE_MS) / DERIVED_PULSE_MS) * 2 -
                1,
            ),
          );
          // Turning on: brighten from near-background into the pulse.
          res.color =
            tr && tr.on && k < 1 ? lerpColor(EDGE_DIM, pulse, k) : pulse;
        }
        // Hover only brightens connected edges; selection brightens connected edges
        // and dims everything else.
        const hov = hoverRef.current;
        const sel =
          selectedRef.current && g.hasNode(selectedRef.current)
            ? selectedRef.current
            : null;
        const boost = () => {
          res.color = isDerived ? EDGE_FOCUS_DERIVED : EDGE_FOCUS;
          res.size = Math.max((attrs.size as number) * 1.42, 1.85);
          res.zIndex = 5;
        };
        /* **Whether this edge currently exists, at the timeline's current moment.**
           Both hover branches return early, skipping the time filter below. Without
           checking this, hovering would jump every edge that "has not appeared yet"
           from near-background straight to 45% of its normal color, which looks lit
           up. Testing confirmed it really is that bright. */
        const liveNow = !f.activeEdges || f.activeEdges.has(edge);
        if (hov && (s === hov || t === hov) && liveNow) {
          boost();
        } else if (hov && !sel) {
          // On hover, other edges also dim back, but **only by half** — the same
          // HOVER_MUTE used for nodes. Dimming all the way is reserved for
          // selection. An edge that does not currently exist **should already be
          // dim**, so mixing from EDGE_DIM leaves it unchanged.
          const from = liveNow ? String(res.color) : EDGE_DIM;
          res.color = lerpColor(from, EDGE_DIM, HOVER_MUTE);
          res.size = (attrs.size as number) * (1 - 0.4 * HOVER_MUTE);
          res.label = "";
          return res;
        } else if (sel) {
          if (s === sel || t === sel) {
            boost();
          } else {
            res.color = EDGE_DIM;
            res.size = (attrs.size as number) * 0.6;
            res.label = "";
            return res;
          }
        }
        if (f.activeEdges && !f.activeEdges.has(edge)) {
          res.color = EDGE_DIM;
          res.label = "";
          return res;
        }
        // Playback fade-in: an edge brightens from near-background to its normal
        // color (alpha interpolates along with it).
        const fs = fadeRef.current.get(edge);
        if (fs !== undefined) {
          const t = Math.min(1, (performance.now() - fs) / FADE_MS);
          res.color = lerpColor(EDGE_DIM, String(res.color), t);
          if (t < 0.8) res.label = "";
        }
        return res;
      },
    });
    sigma.on("clickNode", ({ node }) => setSelected(node));
    sigma.on("doubleClickNode", ({ node, event }) => {
      event.preventSigmaDefault();
      setFocusEntity(node);
      setSelected(node);
    });
    sigma.on("clickStage", () => deselect());
    sigma.on("enterNode", ({ node }) => {
      hoverRef.current = node;
      sigma.refresh();
    });
    sigma.on("leaveNode", () => {
      hoverRef.current = null;
      sigma.refresh();
    });
    /* Hovering an edge reveals the wordings folded into it.
       An edge derived from an inverse relation is folded in (see
       `layOutParallelEdges`), and drawing one fewer edge is correct — but that name
       should not disappear entirely: the ontology states that the inverse of
       `part_of` is `contains`, and a person has a right to see it. **Shown only on
       hover** — showing it always would double the label length, and a label too
       long is the exact problem this feature fixes. */
    sigma.on("enterEdge", ({ edge }) => {
      hoverEdgeRef.current = edge;
      sigma.refresh();
    });
    sigma.on("leaveEdge", () => {
      hoverEdgeRef.current = null;
      sigma.refresh();
    });
    // Edge labels appear only after zooming in (too dense at the default view
    // distance; Semantica takes the same restrained approach).
    const updateEdgeLabels = () =>
      sigma.setSetting("renderEdgeLabels", sigma.getCamera().ratio < 0.7);
    sigma.getCamera().on("updated", updateEdgeLabels);
    updateEdgeLabels();

    // The world-coordinate grid redraws when the camera or the container size changes.
    const renderGrid = () => {
      if (gridRef.current) drawWorldGrid(gridRef.current, sigma);
    };
    sigma.getCamera().on("updated", renderGrid);
    sigma.on("resize", renderGrid);
    renderGrid();

    // Node dragging with live force-layout feedback. Pressing down only records a
    // candidate: it becomes a drag only after moving more than 4px in viewport space
    // (otherwise a plain click would wrongly start FA2). The dragged node is pinned
    // to the cursor through fa2's outputReducer (see above). On release, it settles
    // and stops after roughly 1.2s.
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let dragCandidate: string | null = null;
    let downPoint: { x: number; y: number } | null = null;
    sigma.on("downNode", (e) => {
      dragCandidate = e.node;
      downPoint = { x: e.event.x, y: e.event.y };
    });
    sigma.getMouseCaptor().on("mousemovebody", (e) => {
      if (!dragCandidate) return;
      if (!dragged) {
        if (!downPoint || Math.hypot(e.x - downPoint.x, e.y - downPoint.y) < 4)
          return;
        // Promote to a drag.
        dragged = dragCandidate;
        if (settleTimer) clearTimeout(settleTimer);
        // Under a static layout (circular/pack), dragging does not wake the force
        // simulation — otherwise one touch would scatter the whole layout.
        if (layoutModeRef.current === "force" && fa2 && !fa2.isRunning())
          fa2.start();
        // Fix the current bounding box, so the camera does not auto-zoom to follow
        // the drag.
        if (!sigma.getCustomBBox()) sigma.setCustomBBox(sigma.getBBox());
      }
      const pos = sigma.viewportToGraph(e);
      dragPos = pos;
      g.setNodeAttribute(dragged, "x", pos.x);
      g.setNodeAttribute(dragged, "y", pos.y);
      // Block the camera from panning.
      e.preventSigmaDefault();
      e.original.preventDefault();
      e.original.stopPropagation();
    });
    const endDrag = () => {
      dragCandidate = null;
      downPoint = null;
      if (!dragged) return;
      dragged = null;
      dragPos = null;
      settleTimer = setTimeout(() => fa2?.stop(), 1200);
    };
    sigma.getMouseCaptor().on("mouseup", endDrag);
    sigmaRef.current = sigma;
    if (import.meta.env.DEV) {
      // Debug handles (dev only): for inspecting reducer output in a headless
      // environment.
      (window as unknown as Record<string, unknown>).__g = g;
      (window as unknown as Record<string, unknown>).__sigma = sigma;
      (window as unknown as Record<string, unknown>).__sel = selectedRef;
    }
    recomputeActive(timeT);
    return () => {
      if (stabilizeTimer) clearTimeout(stabilizeTimer);
      if (settleTimer) clearTimeout(settleTimer);
      fa2?.kill();
      setStabilizing(false);
      sigma.kill();
      sigmaRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.data]);

  if (!kb)
    return <div className="p-8 text-sm text-neutral-500">{S.nav.loading}</div>;

  const empty = data.isSuccess && data.data.nodes.length === 0;
  const nodeCount = data.data?.nodes.length ?? 0;
  const edgeCount = data.data?.edges.length ?? 0;
  // How many entities exist in the whole base. **This is not the same as how many
  // are drawn** — a neighborhood view has no total count, because it is only ever a
  // small slice by design, so this falls back to the drawn count. It never shows
  // "0 total."
  const totalNodes = data.data?.total_nodes ?? nodeCount;
  const totalEdges = data.data?.total_edges ?? edgeCount;
  const capped = totalNodes > nodeCount;

  return (
    <div className="h-full relative">
      {/* The floating top bar: search, legend, and status. */}
      <div className="absolute top-3 left-3 right-3 z-10 flex items-start gap-2 pointer-events-none">
        <div className="relative pointer-events-auto">
          <input
            className="input-dark w-60 px-3 py-1.5 text-sm shadow-lg"
            placeholder={
              inSubgraph ? S.graph.searchInSubgraph : S.graph.searchEntity
            }
            value={searchInput}
            onChange={(e) => {
              setSearchInput(e.target.value);
              setSearchQ(e.target.value.trim());
            }}
          />
          {searchQ && searchHits.length > 0 && (
            <div className="glass-strong absolute mt-1 w-full rounded-lg shadow-xl overflow-hidden">
              {searchHits.map((c) => (
                <button
                  key={c.id}
                  onClick={() => {
                    // A hit inside the subgraph only selects it (already on
                    // screen); a full-graph search jumps to that entity's
                    // neighborhood.
                    if (!inSubgraph) setFocusEntity(c.id);
                    setSelected(c.id);
                    setSearchInput("");
                    setSearchQ("");
                  }}
                  className="w-full px-3 py-1.5 text-left text-sm text-neutral-200 hover:bg-white/5 flex items-center gap-2"
                >
                  <span
                    className="h-2.5 w-2.5 rounded-full shrink-0"
                    style={{ background: c.color }}
                  />
                  <span className="truncate">{c.name}</span>
                  {c.disambiguator && (
                    <span className="text-xs text-neutral-500 truncate">
                      · {c.disambiguator}
                    </span>
                  )}
                  <span className="ml-auto text-xs text-neutral-500">
                    {c.type_label}
                  </span>
                </button>
              ))}
              {/* There are more hits not shown. **This states exactly how many
                  remain** — an earlier version fixed the list to ten, and when the
                  entity a user wanted was not in those ten, the interface gave no
                  clue at all. A subgraph search filters on the client, so there is
                  no "more" case there. */}
              {!inSubgraph &&
                (candidates.data?.total ?? 0) > searchHits.length && (
                  <button
                    onClick={() => setSearchLimit((n) => n + 20)}
                    className="w-full border-t border-white/10 px-3 py-1.5 text-left text-xs text-neutral-400 hover:bg-white/5 hover:text-neutral-200"
                  >
                    {S.graph.searchMore(
                      candidates.data!.total - searchHits.length,
                    )}
                  </button>
                )}
            </div>
          )}
        </div>
        {focusEntity && (
          <button
            onClick={() => setFocusEntity(null)}
            className="u-btn u-btn-ghost glass-strong pointer-events-auto px-3 py-1.5 text-sm shadow-lg"
          >
            {S.graph.backToOverview}
          </button>
        )}

        {/* The legend (click a pill to toggle that class). **Shows only the first
            LEGEND_MAX classes**; the rest collapse into "+N classes" — this row
            grows horizontally, and too many classes would wrap it onto a new line
            and push the canvas down. A dozen identical pills also give no sign of
            which class matters. */}
        <div className="pointer-events-auto flex flex-wrap gap-1.5 pt-0.5">
          {legendShown.map(([key, t]) => (
            <button
              key={key}
              onClick={() =>
                setHiddenTypes((prev) => {
                  const next = new Set(prev);
                  if (next.has(key)) next.delete(key);
                  else next.add(key);
                  return next;
                })
              }
              className={`glass rounded-full px-2.5 py-1 text-[11px] flex items-center gap-1.5 transition-opacity ${
                hiddenTypes.has(key) ? "opacity-35" : ""
              }`}
            >
              <span
                className={`h-2 w-2 ${t.shape === "square" ? "" : "rounded-full"}`}
                style={{ background: t.color }}
              />
              <span className="text-neutral-300">{t.label}</span>
            </button>
          ))}

          {/* The number on this chip is **every class**, not only the collapsed
              ones — opening it shows all of them (any class is searchable), and a
              label like "+3" would promise something different. */}
          {/* Reset. **Whenever any class is hidden, this gives a one-step way out**
              — "show only this" can narrow the view very fast, and without this
              button a user would have to click each one back on. */}
          {hiddenTypes.size > 0 && (
            <button
              onClick={() => setHiddenTypes(new Set())}
              className="glass rounded-full px-2.5 py-1 text-[11px] text-neutral-400 transition-colors hover:text-neutral-100"
            >
              {S.graph.legendShowAll(hiddenTypes.size)}
            </button>
          )}

          {legendRest.length > 0 && (
            <div className="relative" ref={legendPop.rootRef}>
              <button
                ref={legendPop.anchorRef}
                onClick={() =>
                  legendPop.open ? legendPop.close() : legendPop.setOpen(true)
                }
                title={S.graph.legendAllHint}
                aria-expanded={legendPop.open}
                className={`glass rounded-full px-2.5 py-1 text-[11px] flex items-center gap-1.5 transition-colors ${
                  legendPop.open ? "text-neutral-100" : "text-neutral-400"
                } hover:text-neutral-100`}
              >
                {S.graph.legendMore(types.length)}
                {/* This dot shows when any collapsed class is hidden. **Without it,
                    hiding is silent**: a user could turn off a class in the panel,
                    collapse the panel, and see nothing on screen state that it is
                    off. */}
                {hiddenInRest > 0 && (
                  <span className="h-1.5 w-1.5 rounded-full bg-neutral-300" />
                )}
              </button>
              {legendPop.open && (
                <div
                  ref={legendPop.panelRef}
                  className="u-menu-glass absolute left-0 top-0 z-50 w-64 overflow-hidden rounded-xl p-2 shadow-2xl"
                >
                  {/* The panel covers the chip's original position, so **the first
                      row takes the same shape as that chip**, and clicking it
                      collapses the panel again — "it collapses back where it
                      opened," the same reasoning behind the alert and user cards,
                      where the close button sits on top of the button that opened
                      them. */}
                  <button
                    onClick={() => legendPop.close()}
                    className="mb-1.5 flex w-full items-center gap-1.5 rounded-full px-1.5 py-0.5 text-[11px] text-neutral-300 transition-colors hover:text-neutral-100"
                  >
                    {S.graph.legendMore(types.length)}
                    <X size={11} className="ml-auto text-neutral-500" />
                  </button>
                  <input
                    autoFocus
                    value={legendQ}
                    onChange={(e) => setLegendQ(e.target.value)}
                    placeholder={S.graph.legendSearch}
                    className="input-dark mb-1.5 w-full px-2 py-1 text-[12px]"
                  />
                  {/* **This list shows every class, not only the collapsed ones**:
                      when a user is looking for a class, no one remembers whether
                      it happened to rank among the first few shown. */}
                  <div className="flex max-h-64 flex-col overflow-y-auto">
                    {types
                      .filter(([, t]) =>
                        t.label.toLowerCase().includes(legendQ.toLowerCase()),
                      )
                      .map(([key, t]) => (
                        /* **Two buttons per row, not one button cycling through
                           three states.** A single cycling button costs clarity:
                           without checking the current state, a user cannot know
                           what the next click does, and going from "show only this"
                           back to normal would have to pass through "exclude" —
                           wanting to clear the filter would first make the view
                           wrong in a different way. With two separate buttons, each
                           gesture always means the same thing. */
                        <div
                          key={key}
                          className="group flex items-center gap-2 rounded px-1.5 py-1 hover:bg-white/5"
                        >
                          <button
                            onClick={() =>
                              setHiddenTypes((prev) => {
                                const next = new Set(prev);
                                if (next.has(key)) next.delete(key);
                                else next.add(key);
                                return next;
                              })
                            }
                            className="flex min-w-0 flex-1 items-center gap-2 text-left"
                          >
                            <span
                              className={`h-2 w-2 shrink-0 ${t.shape === "square" ? "" : "rounded-full"}`}
                              style={{
                                background: t.color,
                                opacity: hiddenTypes.has(key) ? 0.35 : 1,
                              }}
                            />
                            <span
                              className={`truncate text-[12px] ${
                                hiddenTypes.has(key)
                                  ? "text-neutral-500 line-through"
                                  : "text-neutral-200"
                              }`}
                            >
                              {t.label}
                            </span>
                          </button>
                          {/* "Show only this": the action a user wants most when
                              there are many classes. **This gets its own button,
                              not a modifier key** — no one would guess alt-click,
                              and there is horizontal room for a button here. */}
                          <button
                            onClick={() =>
                              setHiddenTypes(
                                new Set(
                                  types.map(([k]) => k).filter((k) => k !== key),
                                ),
                              )
                            }
                            className="shrink-0 rounded px-1 text-[10px] text-neutral-500 opacity-0 transition-opacity hover:text-white focus:opacity-100 group-hover:opacity-100"
                          >
                            {S.graph.legendOnly}
                          </button>
                          <span className="u-num shrink-0 text-[11px] text-neutral-500">
                            {t.count}
                          </span>
                        </div>
                      ))}
                    {types.every(
                      ([, t]) =>
                        !t.label.toLowerCase().includes(legendQ.toLowerCase()),
                    ) && (
                      <div className="px-1.5 py-2 text-[12px] text-neutral-500">
                        {S.graph.legendNone}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Top right: the "how many to draw" control, plus stats. **The stats state
            exactly this number** ("150 drawn, 548 total"), and placing the control
            next to it makes clear what the control changes. The shell stays
            neutral — this area is chrome, and color belongs only to data. */}
        <div className="ml-auto flex flex-col items-end gap-1">
          <div className="flex items-start gap-2">
            <div className="pointer-events-auto flex items-center overflow-hidden rounded-md border border-white/10">
            <button
              title={S.graph.nodeBudgetLess}
              disabled={nodeBudget <= NODE_BUDGETS[0]}
              onClick={() =>
                setNodeBudget(
                  (b) => NODE_BUDGETS[Math.max(0, NODE_BUDGETS.indexOf(b) - 1)],
                )
              }
              className="px-1.5 py-[3px] text-[11px] leading-none text-neutral-400 transition-colors hover:bg-white/[0.06] hover:text-white disabled:opacity-25 disabled:hover:bg-transparent disabled:hover:text-neutral-400"
            >
              −
            </button>
            {/* **Do not offer "draw more" once everything is already drawn**: the
                base has no more entities, so raising the level would change
                nothing, and a button that does nothing when clicked is worse than
                no button at all. */}
            <button
              title={S.graph.nodeBudgetMore}
              disabled={
                !capped || nodeBudget >= NODE_BUDGETS[NODE_BUDGETS.length - 1]
              }
              onClick={() =>
                setNodeBudget(
                  (b) =>
                    NODE_BUDGETS[
                      Math.min(NODE_BUDGETS.length - 1, NODE_BUDGETS.indexOf(b) + 1)
                    ],
                )
              }
              className="px-1.5 py-[3px] text-[11px] leading-none text-neutral-400 transition-colors hover:bg-white/[0.06] hover:text-white disabled:opacity-25 disabled:hover:bg-transparent disabled:hover:text-neutral-400"
            >
              +
            </button>
          </div>
          <div className="pointer-events-none pt-0.5 u-num text-[11px] text-neutral-500">
          {/* When at the cap, state "drawn / total" clearly. **This value used to
              show the cap itself instead of the real scale** — a base with ten
              thousand entities always showed 150 in this corner. */}
          {capped ? (
            <span title={S.graph.cappedHint(nodeCount, totalNodes)}>
              {/* **Facts use the same "drawn / total" convention.** An earlier
                  version showed the base's total fact count here, while entities
                  showed "drawn / total" — two conventions in one sentence, so
                  changing the level moved the entity count and left the fact count
                  fixed, which looked broken. When no time filter is active, active
                  always equals the drawn count, so this omits it. */}
              {S.graph.statsCapped(
                nodeCount,
                totalNodes,
                edgeCount,
                totalEdges,
                timeT === null ? null : activeCount,
              )}
            </span>
          ) : (
            S.graph.stats(
              nodeCount,
              edgeCount,
              timeT === null ? null : activeCount,
            )
          )}
            </div>
          </div>
          {/* **This sits on its own line, not as a prefix to the stats text.**
              As a prefix, its appearance would widen the whole block, and this
              block is right-aligned — so every layout change would push and jump
              the level buttons on the left. On its own line, the width of the
              first row no longer depends on it. */}
          {stabilizing && (
            <div className="flex items-center gap-1.5 text-[11px] text-neutral-400">
              <Loader2 size={11} className="animate-spin" />
              {S.graph.stabilizing}
            </div>
          )}
        </div>
      </div>

      {/* The canvas: a world-coordinate grid layer (moves with the camera) sits
          under the sigma WebGL layer (full-bleed, with the time island floating
          above it). */}
      <div className="absolute inset-0">
        <canvas ref={gridRef} className="absolute inset-0 h-full w-full" />
        <div ref={containerRef} className="absolute inset-0" />
      </div>

      {/* The bottom-left control tower: derived edges, layout switch, and camera
          (the bottom-right belongs to the entity side rail; the bottom center
          belongs to the time island). */}
      {/* **items-start**: a column's children default to stretch, so expanding one
          group would pull every other group to the same width — and since those
          groups' text stays short, they would show as a few unexplained blank
          bars. Sizing each group by its own content is what lets "one group
          expands without affecting the others" actually work. */}
      <div className="absolute bottom-4 left-3 z-10 flex flex-col items-start gap-2">
        {/* Derived edges: **its own group, and not part of the class legend.**
            The legend answers "which classes to show," a row of classes that all
            come from the ontology. This answers "show derived edges or not" — a
            different question. When the count is zero, the whole group does not
            appear.

            **Placing it on this tower avoids a conflict.** Next to the legend in
            the top bar, it would look like a 10th class; trying to set it apart by
            color would run into the rule stated at the top of this file — "chrome
            carries no color bias; color belongs only to data" (see the palette
            comment). A saturated gold block in the frame would be the interface's
            only colored chrome element, out of place with everything else.

            This tower is already the home for "how the view looks" (layout, zoom),
            and "show derived edges or not" is the same kind of question. The shell
            stays neutral; gold appears only on the icon itself — the same approach
            used for the color dots on class pills. */}
        {derivedCount > 0 && (
          /* **Two layers**: the outer layer only positions the element; the inner
             layer carries overflow-hidden. That class rounds the corners of the
             button stack, but the panel is a sibling inside the same box — merging
             them into one layer would clip the panel too, and testing showed only
             the tower's own 32px width surviving. */
          <div className="relative" ref={derivedPop.rootRef}>
            <div className="u-tower group glass-strong rounded-xl shadow-xl flex flex-col overflow-hidden">
            <button
              onClick={() => setShowDerived((v) => !v)}
              role="switch"
              aria-checked={showDerived}
              title={`${S.graph.derivedEdges(derivedCount)} · ${S.graph.derivedHint}`}
              className={`flex items-center p-2 transition-colors ${
                showDerived
                  ? "bg-white/[0.1]"
                  : "text-neutral-500 hover:bg-white/[0.06]"
              }`}
              style={
                showDerived ? { color: "rgba(231,197,124,0.95)" } : undefined
              }
            >
              <Waypoints size={15} />
              <span className="u-tower-label">{S.graph.viewDerived}</span>
            </button>
            <div className="h-px bg-white/10 mx-1.5" />
            {/* Expands into a small panel: when these edges were derived, whether
                inference is still running, and a manual re-run. **This is a second
                button, separate from the toggle** — "hide them" is a daily click,
                "when were they derived" is an occasional question, and merging the
                two would add a step to the daily action. */}
            <button
              ref={derivedPop.anchorRef}
              onClick={() =>
                derivedPop.open ? derivedPop.close() : derivedPop.setOpen(true)
              }
              title={S.graph.derivedPanel}
              aria-expanded={derivedPop.open}
              className={`flex items-center p-2 text-[11px] leading-none transition-colors ${
                derivedPop.open
                  ? "text-white bg-white/[0.1]"
                  : "text-neutral-400 hover:text-white hover:bg-white/[0.06]"
              }`}
            >
              <span className="grid h-[15px] w-[15px] shrink-0 place-items-center leading-none">
                ⋯
              </span>
              <span className="u-tower-label">{S.graph.derivedPanel}</span>
            </button>
            </div>
            {derivedPop.open && kb && (
              <DerivedPanel
                panelRef={derivedPop.panelRef}
                kbId={kb.id}
                count={derivedCount}
                onClose={() => derivedPop.close()}
              />
            )}
          </div>
        )}
        <div className="u-tower group glass-strong rounded-xl shadow-xl flex flex-col overflow-hidden">
          {(
            [
              { key: "force", Icon: Orbit, label: S.graph.layoutForce },
              {
                key: "circular",
                Icon: CircleDashed,
                label: S.graph.layoutCircular,
              },
              { key: "pack", Icon: Grape, label: S.graph.layoutPack },
            ] as const
          ).map(({ key, Icon, label }) => (
            <button
              key={key}
              title={label}
              onClick={() => {
                setLayoutMode(key);
                layoutModeRef.current = key;
                layoutCtlRef.current?.apply(key);
              }}
              className={`flex items-center p-2 transition-colors ${
                layoutMode === key
                  ? "text-white bg-white/[0.1]"
                  : "text-neutral-400 hover:text-white hover:bg-white/[0.06]"
              }`}
            >
              <Icon size={15} />
              <span className="u-tower-label">{label}</span>
            </button>
          ))}
        </div>
        <div className="u-tower group glass-strong rounded-xl shadow-xl flex flex-col overflow-hidden">
          <button
            title={S.graph.zoomIn}
            onClick={() =>
              sigmaRef.current?.getCamera().animatedZoom({ duration: 220 })
            }
            className="flex items-center p-2 text-neutral-400 hover:text-white hover:bg-white/[0.06] transition-colors"
          >
            <ZoomIn size={15} />
            <span className="u-tower-label">{S.graph.zoomIn}</span>
          </button>
          <button
            title={S.graph.zoomOut}
            onClick={() =>
              sigmaRef.current?.getCamera().animatedUnzoom({ duration: 220 })
            }
            className="flex items-center p-2 text-neutral-400 hover:text-white hover:bg-white/[0.06] transition-colors"
          >
            <ZoomOut size={15} />
            <span className="u-tower-label">{S.graph.zoomOut}</span>
          </button>
          <div className="h-px bg-white/10 mx-1.5" />
          <button
            title={S.graph.fitView}
            onClick={() =>
              sigmaRef.current?.getCamera().animatedReset({ duration: 300 })
            }
            className="flex items-center p-2 text-neutral-400 hover:text-white hover:bg-white/[0.06] transition-colors"
          >
            <Maximize2 size={15} />
            <span className="u-tower-label">{S.graph.fitView}</span>
          </button>
        </div>
      </div>

      {empty && (
        <div className="absolute inset-0 grid place-items-center pointer-events-none">
          {/* No title block here: this page is already the Graph page, and the tab
              bar already says so. Writing "Graph" a third time adds no information.
              An empty state should say what to do next. */}
          <div className="text-center text-sm text-neutral-500 max-w-xs">
            {S.graph.emptyBody}
          </div>
        </div>
      )}

      {/* The floating time island, centered at the bottom. */}
      {edgeCount > 0 && (
        <TimeScrubber
          edges={data.data!.edges}
          value={timeT}
          onChange={setTimeT}
          playing={playing}
          onPlayingChange={setPlaying}
        />
      )}

      {/* The entity side rail. **Stays mounted 170ms after deselection** — that is
          its exit animation playing out. */}
      {(selected || exiting) && kb && (
        <EntityPanel
          kbId={kb.id}
          entityId={(selected ?? exiting)!}
          exiting={!selected}
          onClose={deselect}
          onNavigate={(id) => {
            // The jump target might not be on the current canvas: refocus the
            // graph on its neighborhood too (matching the search-select behavior).
            setFocusEntity(id);
            setSelected(id);
          }}
        />
      )}
    </div>
  );
}

/* ============ Timeline (the floating time island, bottom center: play,
   density band, and drag) ============ */

/** Converts a track clientX to a time value aligned to day steps (the data's
 *  precision is day-level; dragging aims for that precision, while playback still
 *  advances by month for a steady pace). */
function scrubValueAt(
  clientX: number,
  track: HTMLDivElement | null,
  minTs: number,
  maxTs: number,
): number {
  if (!track) return maxTs;
  const rect = track.getBoundingClientRect();
  // Avoids a division by zero producing NaN when the layout has not settled
  // (width is 0).
  if (rect.width < 1) return maxTs;
  const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  const raw = minTs + frac * (maxTs - minTs);
  return Math.min(maxTs, minTs + Math.round((raw - minTs) / DAY_MS) * DAY_MS);
}

/** The step size for playback and for each bar. **These two must be the same
 *  unit** — an earlier version stepped bars by year and playback by day, and no
 *  part of the interface could say "how long is one step." */
type ScrubUnit = "year" | "month" | "day";

/** The maximum number of bars to draw. Past this, adjacent buckets merge into one
 *  bar. **This affects drawing only, not the playback step size**: at the day
 *  unit, 15 years produce more than five thousand buckets, more than fit at one
 *  pixel each, but playback still advances one day at a time. When bars merge, the
 *  tooltip states how many — nothing is hidden. */
const SCRUB_MAX_BARS = 220;
/** The target duration for playing through the whole track. **This does not
 *  depend on the unit** — the unit changes granularity and density, and should not
 *  also change how long a user waits. At the day unit, "one day per tick" would
 *  take twenty minutes to cover 15 years. */
const SCRUB_PLAY_MS = 18000;

function bucketStart(ts: number, unit: ScrubUnit): number {
  const d = new Date(ts);
  if (unit === "year") return Date.UTC(d.getUTCFullYear(), 0, 1);
  if (unit === "month")
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
function bucketNext(ts: number, unit: ScrubUnit): number {
  const d = new Date(ts);
  if (unit === "year") return Date.UTC(d.getUTCFullYear() + 1, 0, 1);
  if (unit === "month")
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return ts + DAY_MS;
}

function TimeScrubber({
  edges,
  value,
  onChange,
  playing,
  onPlayingChange,
}: {
  edges: GraphEdge[];
  value: number | null;
  onChange: (v: number | null) => void;
  /* Playback state lives in Graph: the rendering layer must tell "advancing during
     playback" apart from "manual drag." */
  playing: boolean;
  onPlayingChange: (v: boolean) => void;
}) {
  const setPlaying = onPlayingChange;
  /* Defaults to year: **most knowledge bases span years**, so this gives a view
     that fits on screen at a glance on entry. */
  const [unit, setUnit] = useState<ScrubUnit>("year");
  /* How many times playback has swept the whole track. **This is used as a key**
     — repeating the same trigger on the same element does not replay an
     animation; changing the key to force a remount does. */
  const [sweep, setSweep] = useState(0);
  /* The lit-up segment behind the pointer while it sits on the track. **This
     answers "how far have I gotten"** — without playback, the whole track is one
     shade of gray with no sign of where progress stopped, and that is exactly what
     a user wants to know when they move the pointer there. */
  const [trackHover, setTrackHover] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  /* Where a drag landed. **The playback loop keeps its own floating-point
     accumulator** and does not read value — otherwise rounding error would
     accumulate every frame. So changing value alone has no effect; the next frame
     would overwrite it unchanged. A drag writes its target here, and the loop
     picks it up on its next frame, continuing from the new position. */
  const seekRef = useRef<number | null>(null);
  const seek = (v: number) => {
    seekRef.current = v;
    onChange(v);
  };

  const { minTs, maxTs, bars, merged, trackW } = useMemo(() => {
    const now = Date.now();
    const froms = edges
      .map((e) => (e.valid_from ? Date.parse(e.valid_from) : NaN))
      .filter((t) => !Number.isNaN(t));
    const min = froms.length
      ? Math.min(...froms)
      : now - 5 * 365 * 24 * 3600 * 1000;
    // Align the start to the unit boundary: otherwise the first bar is half a
    // step, which reads as missing data.
    const start = bucketStart(min, unit);

    const counts = new Map<number, number>();
    for (const t of froms) {
      const k = bucketStart(t, unit);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const raw: { ts: number; n: number }[] = [];
    for (let t = start; t <= now; t = bucketNext(t, unit))
      raw.push({ ts: t, n: counts.get(t) ?? 0 });

    // Merge buckets when there is not enough room to draw them separately.
    // **This merges the drawing, not the step size.**
    const group = Math.max(1, Math.ceil(raw.length / SCRUB_MAX_BARS));
    const cells: { ts: number; n: number }[] = [];
    for (let i = 0; i < raw.length; i += group) {
      const slice = raw.slice(i, i + group);
      cells.push({
        ts: slice[0].ts,
        n: slice.reduce((a, b) => a + b.n, 0),
      });
    }
    const peak = Math.max(1, ...cells.map((c) => c.n));

    // A larger unit means fewer buckets, so the island shortens; a smaller unit
    // means more buckets, so it lengthens. **But the minimum width must stay high
    // enough**: the island's fixed row of controls (play button, unit selector,
    // two years, a date, and All time/Now) already needs more than 400 pixels. At
    // an island width of 320, the flex-1 track would compress to 0 — testing
    // showed not a single bar visible, the whole track empty.
    //
    // With that floor raised, changing the unit mainly changes **how thick each
    // bar is**: on the same track, year gives a dozen thick blocks, and day gives
    // more than two hundred thin lines. That makes the change clearer than
    // stretching the whole track.
    const w = Math.min(780, Math.max(660, 380 + cells.length * 2));

    return {
      minTs: start,
      maxTs: now,
      bars: cells.map((c) => ({ ts: c.ts, h: c.n / peak, n: c.n })),
      merged: group,
      trackW: w,
    };
  }, [edges, unit]);

  // Playback advances by day (the data's own precision), passing days quickly;
  // the overall pace stays roughly one month per 260ms. Driven by rAF time, so it
  // is frame-rate independent; an internal float accumulator avoids rounding
  // drift, and the value is only pushed out when the day actually changes.
  useEffect(() => {
    if (!playing) return;
    // The whole track takes about SCRUB_PLAY_MS to play through, independent of
    // the unit; the unit only decides which step the landing point rounds to.
    const SPEED = (maxTs - minTs) / SCRUB_PLAY_MS;
    let raf = 0;
    let last = performance.now();
    let acc = value ?? minTs;
    let lastPushed = 0;
    const step = (now: number) => {
      // If a drag happened, continue from its landing point instead of the
      // original path.
      if (seekRef.current !== null) {
        acc = seekRef.current;
        seekRef.current = null;
      }
      acc += (now - last) * SPEED;
      last = now;
      if (acc >= maxTs) {
        setPlaying(false);
        onChange(null);
        // A sweep of light plays when playback reaches the end. **This is a
        // closing signal** — playback stopping and time jumping back to all-time
        // would look like it broke off midway without one; the sweep of light
        // states clearly that "this track finished."
        setSweep((n) => n + 1);
        return;
      }
      // **Advance continuously; do not jump by bucket.** An earlier version
      // rounded the pushed value through `bucketStart`, so at the year unit each
      // step jumped a whole year — the playback head hopped step by step, which
      // looked like stuttering rather than motion. The unit now controls only
      // **display** (label precision, bar span), not the step size of playback.
      //
      // The cost is that pushes happen more often (once per frame), and every
      // push recomputes the active edges for the whole graph, so this caps the
      // rate at roughly 30fps: the eye cannot tell it apart from 60fps, and it
      // halves the recompute load.
      if (now - lastPushed >= 33) {
        lastPushed = now;
        onChange(Math.round(acc));
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // This effect restarts only when playback toggles: acc persists inside the
    // loop, so a value that changes every frame should not rebuild the loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, minTs, maxTs, unit]);

  // Displays down to the day, matching the data's day-level valid_precision.
  const label = (() => {
    if (value === null) return S.graph.allTime;
    const d = new Date(value);
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    // Precision follows the unit: writing "2019-01-01" at the year unit would be
    // false precision.
    if (unit === "year") return `${d.getUTCFullYear()}`;
    if (unit === "month") return `${d.getUTCFullYear()}-${mm}`;
    return `${d.getUTCFullYear()}-${mm}-${dd}`;
  })();

  const minYear = bars.length
    ? new Date(bars[0].ts).getUTCFullYear()
    : undefined;
  const maxYear = bars.length
    ? new Date(bars[bars.length - 1].ts).getUTCFullYear()
    : undefined;

  return (
    /* Width changes with the unit: a larger unit means fewer buckets, so shorter;
       a smaller unit means more buckets, so longer and denser. Still clamped to
       the viewport (the calc term), so a narrow screen never overflows.
       Measured widths: year 320, month 648, day 760. */
    <div
      className={`glass-strong absolute bottom-4 left-1/2 -translate-x-1/2 z-10 rounded-2xl px-3 py-2 flex items-center gap-2.5 shadow-[0_12px_40px_rgba(0,0,0,0.5)] u-scrub-island${playing ? " u-solid" : ""}`}
      style={{ width: `min(${trackW}px, calc(100vw - 4rem))` }}
    >
      <button
        onClick={() => {
          // Clicking play while already at the end (`Now`) restarts from the
          // beginning. **Otherwise the first click would do nothing** — acc would
          // start already at the end, and the loop's first frame would judge
          // playback finished, only resetting the position to All time.
          if (
            !playing &&
            (value === null || value >= maxTs - (maxTs - minTs) * 0.02)
          )
            onChange(minTs);
          setPlaying(!playing);
        }}
        title={playing ? S.graph.pause : S.graph.play}
        className="u-btn u-btn-ghost h-8 w-8 shrink-0 grid place-items-center rounded-lg"
      >
        {playing ? <Pause size={13} /> : <Play size={13} />}
      </button>

      {/* The step size. **Playback and the bars share this setting** — an earlier
          version stepped bars by year and playback by day, and no part of the
          interface could state "how long is one step." */}
      <div
        title={S.graph.scrubUnitHint}
        /* **Matches the play button's height and corner radius**: that button is
           h-8 / rounded-lg, while this element used to be a 20px height from
           py-[3px] with rounded-md — two elements side by side with different
           sizes and corners looked like they did not belong to the same set. */
        className="flex h-8 shrink-0 items-center overflow-hidden rounded-lg border border-white/10"
      >
        {(["year", "month", "day"] as const).map((u) => (
          <button
            key={u}
            onClick={() => setUnit(u)}
            className={`grid h-full place-items-center px-2 text-[10px] leading-none transition-colors ${
              unit === u
                ? "bg-white/[0.08] text-neutral-100"
                : "text-neutral-500 hover:bg-white/[0.04] hover:text-neutral-300"
            }`}
          >
            {u === "year"
              ? S.graph.scrubUnitYear
              : u === "month"
                ? S.graph.scrubUnitMonth
                : S.graph.scrubUnitDay}
          </button>
        ))}
      </div>

      <span className="shrink-0 u-num text-[10px] text-neutral-600">
        {minYear}
      </span>

      {/* The density-band track: an inset light well with a bar for each period's
          fact count. */}
      <div
        ref={trackRef}
        onMouseEnter={() => setTrackHover(true)}
        onMouseLeave={() => setTrackHover(false)}
        className="relative h-9 min-w-[150px] flex-1 overflow-hidden rounded-lg bg-white/[0.04]"
      >
        {/* **React** unmounts this when the animation finishes; **do not call
            `remove()` manually.** An earlier version used
            `onAnimationEnd={(e) => e.currentTarget.remove()}`, which pulled a
            React-managed node out of the DOM without React knowing. On the next
            sweep, the key changes and React tries to remove the "old node," which
            is no longer inside its parent; removeChild throws NotFoundError, and
            the uncaught error unmounts and remounts the whole tree. The visible
            effect was **the interface looking like it refreshed after two
            playback sweeps.** */}
        {sweep > 0 && (
          <span
            key={sweep}
            className="u-sweep"
            onAnimationEnd={() => setSweep(0)}
          />
        )}
        {/* **The gap must shrink as density rises**: a fixed 2px gap, at the day
            unit with 216 bars, needs 215 gaps of about 430px total, while the
            track's inner width is only about 455px — the bars would be squeezed
            to 0.1px, and the whole track would look empty. Testing showed exactly
            this failure. A sparse set of bars keeps a 2px gap for easy counting;
            a dense set touches to read as a density band instead. */}
        <div
          className="absolute inset-x-1.5 top-1.5 bottom-1.5 flex items-end"
          style={{ gap: bars.length > 120 ? 0 : bars.length > 40 ? 1 : 2 }}
        >
          {bars.map((b) => {
            // Lights up on entry (judged by the bucket's start time): the bar
            // under the playback head is already covered — the common convention
            // for a progress bar.
            const past = value !== null && b.ts <= value;
            const d = new Date(b.ts);
            const stamp =
              unit === "year"
                ? `${d.getUTCFullYear()}`
                : unit === "month"
                  ? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`
                  : d.toISOString().slice(0, 10);
            return (
              <div
                key={b.ts}
                className="flex-1 flex items-end h-full"
                title={`${stamp} · ${b.n}${merged > 1 ? ` · ${S.graph.scrubBarMerged(merged)}` : ""}`}
              >
                <div
                  className="w-full rounded-[1px] transition-colors"
                  style={{
                    height: `${Math.max(10, b.h * 100)}%`,
                    // A bar already swept during playback brightens, then
                    // returns to normal brightness when playback stops.
                    // **A bar not yet reached dims to nearly invisible**: at its
                    // original 0.09, it would still read clearly against this
                    // background, so both sides of the playback head would look
                    // equally "lit," and progress would be impossible to see. It
                    // keeps a trace instead of zero — zero would claim that
                    // period has no data, when it only has not arrived yet.
                    background:
                      value !== null && past && (playing || trackHover)
                        ? "rgba(255,255,255,0.62)"
                        : value === null || past
                          ? "rgba(255,255,255,0.32)"
                          : "rgba(255,255,255,0.04)",
                  }}
                />
              </div>
            );
          })}
        </div>
        <input
          type="range"
          className="scrubber-range"
          min={minTs}
          max={maxTs}
          step={DAY_MS}
          value={value ?? maxTs}
          /* **Dragging does not stop playback**: a drag means "I want to see that
             period," not "I want to stop" — releasing it should continue playing
             through to the end from the new position.
             (The `All time` and `Now` buttons still stop playback: those are
             explicit jumps, not scrubbing.) */
          onChange={(e) => seek(Number(e.target.value))}
          // The native range input's drag gesture can be disrupted by page-level
          // mouse listeners (such as dragging a node on the canvas) — this drives
          // the drag itself with pointer capture, so a click and a drag both
          // follow the same calculation path.
          onPointerDown={(e) => {
            draggingRef.current = true;
            try {
              e.currentTarget.setPointerCapture(e.pointerId);
            } catch {
              /* A synthetic event's pointerId can be invalid; ignore it. */
            }
            seek(scrubValueAt(e.clientX, trackRef.current, minTs, maxTs));
          }}
          onPointerMove={(e) => {
            if (draggingRef.current)
              seek(scrubValueAt(e.clientX, trackRef.current, minTs, maxTs));
          }}
          onPointerUp={() => {
            draggingRef.current = false;
          }}
          onPointerCancel={() => {
            draggingRef.current = false;
          }}
        />
      </div>

      <span className="shrink-0 u-num text-[10px] text-neutral-600">
        {maxYear}
      </span>

      <div className="w-[5.6rem] shrink-0 text-center u-num text-xs text-neutral-200">
        {label}
      </div>

      <div className="h-5 w-px shrink-0 bg-white/10" />

      {/* A two-anchor segment: the current anchor highlights and a click jumps to
          it; dragging to a day in between leaves neither highlighted. */}
      <div className="flex shrink-0 rounded-lg overflow-hidden border border-white/10">
        {(
          [
            {
              key: "all",
              label: S.graph.allTime,
              active: value === null,
              to: null,
            },
            {
              key: "now",
              label: S.graph.nowBtn,
              active: value !== null && maxTs - value < DAY_MS,
              to: maxTs,
            },
          ] as const
        ).map((a) => (
          <button
            key={a.key}
            onClick={() => {
              setPlaying(false);
              onChange(a.to);
            }}
            className={`px-2.5 py-1.5 text-xs transition-colors ${
              a.active
                ? "bg-white/10 text-neutral-100"
                : "text-neutral-500 hover:bg-white/[0.05] hover:text-neutral-300"
            }`}
          >
            {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ============ Entity side rail ============ */

/** World time (when a fact holds) → text. **Always read in UTC; never convert to
 *  local time.**
 *
 *  `valid_from` and `valid_to` come from a statement in a document ("took office
 *  on May 2, 2019"). This is **a calendar date, not a moment in time**, so it has
 *  no time zone to begin with; it is stored as UTC midnight of that day.
 *  Rendering in local time would show a UTC-5 reader 2019-05-01 — a day off with
 *  no real cause, and the direction of the error would depend on the reader's
 *  location. Recorded time (when we came to believe this) is a different matter,
 *  and that one should render in local time; see the comment on ymd in
 *  EntityHistory. */
function fmtTime(iso: string | null, precision: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  if (precision === "year") return `${y}`;
  if (precision === "month") return `${y}-${m}`;
  return `${y}-${m}-${day}`;
}

function fmtInterval(f: EntityFact): string {
  if (f.temporal === "eternal") return "";
  const from = fmtTime(f.valid_from, f.valid_from_precision);
  const to = fmtTime(f.valid_to, f.valid_to_precision);
  // **"Ended, but the date is unknown" must never display as "ongoing."** This
  // is the exact bug this change fixes: the source text stated "former CEO of
  // Weta Digital," and the interface told the reader he still held the role.
  const endedUnknown = !f.valid_to && f.valid_to_precision === "unknown";
  if (!from && !to && !endedUnknown) return "";
  const end = to ?? (endedUnknown ? S.graph.endedUnknown : S.graph.ongoing);
  return from ? `${from} ~ ${end}` : `~ ${end}`;
}

/** A derived fact, **with its proof laid out below it**.
 *
 * There is no collapsing: the entire reason this row exists is "no one asserted
 * this edge; here is how it was derived," and hiding the premises behind a click
 * would hide that reason. A chain is at most twelve facts long, so laying it out
 * flat stays short. */
/** The small panel next to the derived-edges toggle: **when these edges were
 * derived, from what, and whether they are still accurate now**.
 *
 * The reason this panel exists is that freshness is otherwise invisible.
 * Inference reruns every hour, while the underlying facts change with every
 * document that comes in — a derived edge can look exactly like it did the
 * moment it was derived, while a premise it depends on was retracted three
 * minutes ago. The toggle alone cannot answer "as of when is this conclusion
 * current."
 *
 * The manual re-run button lives here, not elsewhere: the person who wants to
 * rerun inference is exactly the person who just read these three lines and
 * decided the numbers look stale.
 */
function DerivedPanel({
  panelRef,
  kbId,
  count,
  onClose,
}: {
  panelRef: React.Ref<HTMLDivElement>;
  kbId: string;
  count: number;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const kb = useQuery({
    queryKey: ["kbOne", kbId],
    queryFn: () => api.kbDetail(kbId),
  });
  /* A re-run needs confirmation, but **the second click of that confirmation must
     land on a different button.** This product's gesture convention is "clicking
     the same control twice collapses it" — the toggle, the "…" button, and the
     legend pills all follow this. Putting "click again to run" on the same
     button would make that same gesture unexpectedly mean "run" here, when
     everywhere else it means "cancel."
     So one click only **asks a question**, and the question offers two separate
     targets: cancel or run.

     This also does not use the site-wide DangerConfirm: that pattern is a red
     title, sometimes requiring the user to type a confirmation word, reserved
     for irreversible actions like deleting a knowledge base. Rerunning
     inference is heavy but repeatable, and does not rise to that level. */
  const [armed, setArmed] = useState(false);
  const run = useMutation({
    mutationFn: () => api.runInference(kbId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["graph"] });
      qc.invalidateQueries({ queryKey: ["kbOne", kbId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const on = kb.data?.materialize_inferences ?? false;
  const last = kb.data?.last_inference_at;
  // "How long ago" reads more clearly than a timestamp — the question is
  // freshness, not the exact time.
  const age = last
    ? Math.round((Date.now() - new Date(last).getTime()) / 60000)
    : null;

  // **Covers the trigger's original position and grows up and to the right**
  // (bottom-0 left-0), instead of opening a separate window beside it. The
  // surface and corner radius match the alert and user cards: u-menu-glass +
  // rounded-xl.
  return (
    <div
      ref={panelRef}
      className="u-menu-glass pointer-events-auto absolute bottom-0 left-0 z-50 w-72 overflow-hidden rounded-xl px-3 pb-3 pt-2.5 shadow-2xl"
    >
      {/* items-center, not baseline: a button and a close control sit next to the
          title, and baseline alignment would make those two look like they float
          upward. */}
      <div className="flex items-center gap-2">
        <span className="text-[13px] text-neutral-100">
          {S.graph.derivedPanel}
        </span>
        {!armed && (
          <button
            /* **This must look like a button.** An earlier version was a plain
               gray ghost text sitting between the title and the × button, which
               read like a third title rather than an action. Adding a border and
               padding gives it the same visual weight as the level +/- control in
               the top-right corner. */
            className="ml-auto rounded-md border border-white/10 px-2 py-0.5 text-[11px] text-neutral-400 transition-colors hover:border-white/20 hover:text-neutral-100"
            disabled={!on || run.isPending}
            title={on ? undefined : S.err.inference_off}
            onClick={() => setArmed(true)}
          >
            {run.isPending ? S.graph.derivedRunning : S.graph.derivedRun}
          </button>
        )}
        {/* A fixed 18px square: **the close button must not stretch the title
            row's height** — if it did, the shorter title text would center
            within that extra height and look like it has too much top margin. */}
        <button
          className={`${armed ? "ml-auto " : ""}grid h-[18px] w-[18px] place-items-center rounded text-neutral-500 transition-colors hover:bg-white/[0.06] hover:text-neutral-200`}
          onClick={onClose}
          aria-label={S.graph.close}
        >
          ×
        </button>
      </div>

      {/* The question, with two targets. **Cancel comes first**: moving from the
          "run" click, the pointer reaches cancel first, and the option with the
          smaller cost of a mistake should sit closer. */}
      {armed && (
        <div className="mt-2 rounded-lg bg-white/[0.04] p-2">
          <p className="text-[11px] leading-relaxed text-neutral-300">
            {S.graph.derivedRunAsk}
          </p>
          <div className="mt-1.5 flex gap-1.5">
            <button
              className="rounded px-2 py-0.5 text-[11px] text-neutral-400 transition-colors hover:bg-white/[0.06] hover:text-neutral-100"
              onClick={() => setArmed(false)}
            >
              {S.graph.derivedRunCancel}
            </button>
            <button
              className="rounded bg-white/10 px-2 py-0.5 text-[11px] text-neutral-100 transition-colors hover:bg-white/[0.16]"
              disabled={run.isPending}
              onClick={() => {
                setArmed(false);
                run.mutate();
              }}
            >
              {S.graph.derivedRunGo}
            </button>
          </div>
        </div>
      )}

      <dl className="mt-2 space-y-1 text-[11px]">
        <div className="flex justify-between gap-3">
          <dt className="text-neutral-500">{S.graph.derivedCountLabel}</dt>
          <dd className="u-num text-neutral-200">{count}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-neutral-500">{S.graph.derivedStateLabel}</dt>
          <dd className={on ? "text-neutral-200" : "text-[var(--u-warn)]"}>
            {on
              ? S.graph.derivedOn(kb.data!.inference_interval_minutes)
              : S.graph.derivedOff}
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-neutral-500">{S.graph.derivedLastLabel}</dt>
          <dd className="u-num text-neutral-200">
            {age === null ? S.graph.derivedNever : S.graph.derivedAgo(age)}
          </dd>
        </div>
      </dl>

      {/* The result of the last manual run stays here. **The number derived and
          the number retracted are stated separately** — "nothing changed" and
          "thirty facts were replaced" are two very different outcomes. */}
      {run.data && (
        <p className="mt-2 text-[11px] text-neutral-400">
          {run.data.inserted === 0 && run.data.invalidated === 0
            ? S.graph.derivedNoChange
            : S.graph.derivedChanged(run.data.inserted, run.data.invalidated)}
          {run.data.capped > 0 &&
            ` · ${S.graph.derivedCapped(run.data.capped)}`}
        </p>
      )}

    </div>
  );
}

/** One derived edge. **The row style matches FactRow**: the same rounded row,
 *  the same chevron to expand, the same role="link" navigation (avoiding a
 *  button nested inside a button).
 *
 *  An earlier version used a `glass rounded-xl p-3` card with the proof always
 *  expanded — inside a compact list of Relations/Timeline/History rows, that
 *  looked like it belonged to a different product, and a dozen derivations
 *  stacked up into a wall of text. Proof is something a reader asks for; putting
 *  it behind an expandable section fits that. */
function DerivedRow({
  d,
  otherId,
  otherName,
  open,
  onToggle,
  onNavigate,
}: {
  d: DerivedFact;
  otherId: string;
  otherName: string;
  open: boolean;
  onToggle: () => void;
  onNavigate: (entityId: string) => void;
}) {
  return (
    <div
      className={`rounded-lg transition-colors ${open ? "bg-white/[0.05]" : "hover:bg-white/[0.04]"}`}
    >
      <button
        onClick={onToggle}
        className="w-full text-left px-2 py-1.5 flex items-center gap-1.5"
      >
        <ChevronRight
          size={11}
          className={`shrink-0 text-neutral-600 transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span
          role="link"
          tabIndex={0}
          onClick={(ev) => {
            ev.stopPropagation();
            onNavigate(otherId);
          }}
          onKeyDown={(ev) => {
            if (ev.key === "Enter") {
              ev.stopPropagation();
              onNavigate(otherId);
            }
          }}
          className="truncate text-[13px] text-neutral-200 hover:text-white hover:underline underline-offset-2 decoration-white/30"
        >
          {otherName}
        </span>
        <span className="ml-auto shrink-0 pl-2 text-[10.5px] text-neutral-600">
          {d.premises.length}
        </span>
      </button>
      {/* The proof: premises in derivation order. **The border matches
          EvidenceList's border** — the two are two forms of the same idea, one
          giving a source, the other giving a chain of reasoning. */}
      {open && (
        <div className="mx-2 mb-2 mt-0.5 border-l border-white/15 pl-2.5">
          <ol className="space-y-0.5">
            {d.premises.map((p, i) => (
              <li key={i} className="text-[11px] text-neutral-400">
                {p}
              </li>
            ))}
          </ol>
          {d.premises.length === 0 && (
            <p className="text-[11px] text-neutral-600">
              {S.graph.derivedNoProof}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function EntityPanel({
  kbId,
  entityId,
  exiting,
  onClose,
  onNavigate,
}: {
  kbId: string;
  entityId: string;
  /** Playing its exit animation: still mounted in the DOM, but no longer accepts
   *  clicks. */
  exiting: boolean;
  onClose: () => void;
  onNavigate: (entityId: string) => void;
}) {
  const detail = useQuery({
    queryKey: ["entity", kbId, entityId],
    queryFn: () => api.entityDetail(kbId, entityId),
  });
  const [openFact, setOpenFact] = useState<string | null>(null);
  // Derived facts. **A separate key, not mixed into facts** — mixing the two
  // into one list would leave a user unable to tell "written in a document"
  // apart from "derived by the engine."
  const derived = detail.data?.derived ?? [];
  /* Grouped by "direction + predicate + rule," using the same structure as
     Relations' groups. The rule attaches to the group, not to each row: it holds
     for the whole group, so repeating it on every row would be redundant, and
     that small amber label would also compete in hue with a derived edge. */
  const derivedGroups = useMemo(() => {
    const map = new Map<
      string,
      {
        key: string;
        direction: "in" | "out";
        predicate: string;
        rule: string;
        rows: DerivedFact[];
      }
    >();
    for (const d of derived) {
      const direction = d.subject_id === entityId ? "out" : "in";
      // Each of the four rules has a name. **A missing lookup falls back to the
      // raw kind string** — that string means nothing to a reader, but it is
      // more honest than displaying the name of a different rule.
      const rule = S.graph.ruleNames[d.rule] ?? d.rule;
      const key = `${direction}|${d.predicate}|${d.rule}`;
      const cur = map.get(key);
      if (cur) cur.rows.push(d);
      else map.set(key, { key, direction, predicate: d.predicate, rule, rows: [d] });
    }
    return [...map.values()];
  }, [derived, entityId]);
  // Relations groups by relation (for browsing relations); Timeline shows the
  // validity axis (when something held true); History shows the recording axis
  // (when we came to believe it, and when we changed our mind).
  const [view, setView] = useState<
    "relations" | "timeline" | "history" | "derived"
  >("relations");

  const e: GraphNode | undefined = detail.data?.entity;

  // Entity correction: extraction produces a first judgment, and before this
  // feature existed, a wrong judgment could only be fixed by re-extracting the
  // whole knowledge base.
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftType, setDraftType] = useState("");
  // Other entities sharing this name: the detail endpoint returns this on open.
  // After a rename, this overrides that value with the response's own list —
  // a rename can surface a new set of same-name matches, and that answer is
  // newer than the one from when the panel opened.
  const [renamedPeers, setRenamedPeers] = useState<GraphNode[] | null>(null);
  const sameName = renamedPeers ?? detail.data?.same_name ?? [];
  const setSameName = setRenamedPeers;
  // Manual merge: folds the same-name entity into **the one currently open**.
  // This direction is fixed on purpose — the entity the user is looking at is
  // the one they judged to be the "primary" one.
  const merge = useMutation({
    mutationFn: (source: string) => api.mergeEntities(kbId, source, entityId),
    onSuccess: () => {
      toast.success(S.toast.saved);
      // Removes the merged-away entity from the local list instead of waiting
      // for a refetch — it no longer exists, and leaving it would invite a
      // second click on it.
      setSameName((prev) =>
        (prev ?? sameName).filter((p) => p.id !== merge.variables),
      );
      qc.invalidateQueries({ queryKey: ["entity", kbId, entityId] });
      qc.invalidateQueries({ queryKey: ["graph"] });
      qc.invalidateQueries({ queryKey: ["review", kbId] });
    },
    onError: (err: Error) => toast.error(err.message),
  });
  // The type dropdown needs the whole ontology, not only the classes that
  // happen to appear in the current view.
  const ontology = useQuery({
    queryKey: ["ontology", kbId],
    queryFn: () => api.ontology(kbId),
    enabled: editing,
  });
  const types = ontology.data?.entity_types ?? [];

  const openEdit = () => {
    if (!e) return;
    setDraftName(e.name);
    setDraftType(types.find((t) => t.key === e.type_key)?.id ?? "");
    setSameName([]);
    setEditing(true);
  };
  // The ontology arrives asynchronously: once it is available, align the type
  // dropdown with the entity's current type.
  useEffect(() => {
    if (editing && !draftType && e)
      setDraftType(types.find((t) => t.key === e.type_key)?.id ?? "");
  }, [editing, draftType, e, types]);

  const save = useMutation({
    mutationFn: () => {
      const body: { type_id?: string; canonical_name?: string } = {};
      if (draftName.trim() && draftName.trim() !== e?.name)
        body.canonical_name = draftName.trim();
      const curId = types.find((t) => t.key === e?.type_key)?.id;
      if (draftType && draftType !== curId) body.type_id = draftType;
      return api.updateEntity(kbId, entityId, body);
    },
    onSuccess: (r) => {
      setEditing(false);
      setSameName(r.same_name);
      toast.success(S.graph.editSaved);
      // Changing the type or name must also update the graph node and the
      // ontology's counts.
      qc.invalidateQueries({ queryKey: ["entity", kbId, entityId] });
      qc.invalidateQueries({ queryKey: ["graph", kbId] });
      qc.invalidateQueries({ queryKey: ["ontology", kbId] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const dirty =
    !!e &&
    (draftName.trim() !== e.name ||
      draftType !== (types.find((t) => t.key === e.type_key)?.id ?? ""));

  // Relations shows a snapshot valid as-of now; a closed historical fact
  // appears only in Timeline. Grouped by "direction + predicate": the entity's
  // own name no longer repeats on every row, and the predicate appears only in
  // the section heading.
  const { groups, historicalCount } = useMemo(() => {
    const all = detail.data?.facts ?? [];
    const nowIso = new Date().toISOString();
    const current = all.filter(
      (f) =>
        (!f.valid_from || f.valid_from <= nowIso) &&
        (!f.valid_to || f.valid_to > nowIso),
    );
    const map = new Map<
      string,
      {
        key: string;
        label: string | null;
        inferred: boolean;
        direction: string;
        rows: EntityFact[];
      }
    >();
    for (const f of current) {
      // Facts with an empty predicate fall into one group: what they share is
      // that no relation could be named.
      const k = `${f.direction}:${f.predicate_key ?? ""}`;
      if (!map.has(k))
        map.set(k, {
          key: k,
          label: f.predicate_label,
          inferred: f.inferred,
          direction: f.direction,
          rows: [],
        });
      map.get(k)!.rows.push(f);
    }
    const arr = [...map.values()];
    for (const gr of arr)
      gr.rows.sort((a, b) =>
        (a.valid_from ?? "9999") < (b.valid_from ?? "9999") ? -1 : 1,
      );
    arr.sort(
      (a, b) =>
        b.rows.length - a.rows.length ||
        (a.label ?? "").localeCompare(b.label ?? ""),
    );
    return { groups: arr, historicalCount: all.length - current.length };
  }, [detail.data]);

  return (
    <div
      className={`${exiting ? "u-dock-out" : "u-dock-in"} glass-strong absolute top-14 right-3 bottom-20 w-80 z-10 rounded-xl shadow-2xl flex flex-col`}
    >
      <div className="flex items-start justify-between px-4 py-3.5 border-b border-white/10">
        <div>
          {e && (
            <>
              <div className="flex items-center gap-2">
                <span
                  className="h-2.5 w-2.5 rounded-full shrink-0"
                  style={{
                    background: e.color,
                    boxShadow: `0 0 8px ${e.color}55`,
                  }}
                />
                <span
                  className="text-[15px] font-semibold tracking-tight text-white"
                  style={{ fontFamily: "var(--font-display)" }}
                >
                  {e.name}
                </span>
              </div>
              {/* When no fact backs the disambiguator suffix, it falls back to
                  the type label, which then duplicates the type shown next to
                  it. */}
              <div className="mt-1 text-xs text-neutral-500">
                {e.disambiguator && e.disambiguator !== e.type_label
                  ? `${e.disambiguator} · `
                  : ""}
                {e.type_label ?? S.graph.untyped} ·{" "}
                {detail.data?.facts.length ?? 0} {S.graph.facts}
              </div>
            </>
          )}
        </div>
        <div className="flex items-center gap-1.5 mt-0.5">
          {e && !editing && (
            <button
              onClick={openEdit}
              title={S.graph.edit}
              className="text-neutral-500 hover:text-neutral-200"
            >
              <Pencil size={13} />
            </button>
          )}
          <button
            onClick={onClose}
            className="text-neutral-500 hover:text-neutral-200"
          >
            <X size={15} />
          </button>
        </div>
      </div>

      {editing && e && (
        <div className="px-4 py-3 border-b border-white/10 space-y-2.5">
          <label className="block">
            <span className="text-[10px] uppercase tracking-[0.08em] text-neutral-500">
              {S.graph.editName}
            </span>
            <input
              autoFocus
              value={draftName}
              onChange={(ev) => setDraftName(ev.target.value)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" && dirty && draftName.trim())
                  save.mutate();
                if (ev.key === "Escape") setEditing(false);
              }}
              className="mt-1 w-full bg-white/[0.04] border border-white/10 rounded px-2 py-1 text-sm text-neutral-100 focus:outline-none focus:border-white/25"
            />
          </label>
          <label className="block">
            <span className="text-[10px] uppercase tracking-[0.08em] text-neutral-500">
              {S.graph.editType}
            </span>
            <select
              value={draftType}
              onChange={(ev) => setDraftType(ev.target.value)}
              className="mt-1 w-full bg-white/[0.04] border border-white/10 rounded px-2 py-1 text-sm text-neutral-100 focus:outline-none focus:border-white/25"
            >
              {types.map((t) => (
                <option key={t.id} value={t.id} className="bg-neutral-900">
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-center gap-2 pt-0.5">
            <button
              disabled={!dirty || !draftName.trim() || save.isPending}
              onClick={() => save.mutate()}
              className="u-pop px-2.5 py-1 text-xs rounded bg-white/10 text-neutral-100 hover:bg-white/15 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {S.graph.editSave}
            </button>
            <button
              onClick={() => setEditing(false)}
              className="px-2.5 py-1 text-xs rounded text-neutral-500 hover:text-neutral-300"
            >
              {S.graph.editCancel}
            </button>
            {!draftName.trim() && (
              <span className="text-[11px] text-[var(--u-danger)]">
                {S.graph.editEmptyName}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Sharing a name is not an error — two entities can both be named Zhang
          Wei. This is only a hint; deciding whether they are the same thing is a
          person's decision. */}
      {sameName.length > 0 && !editing && (
        <div className="mx-4 mt-2.5 rounded border border-white/10 bg-white/[0.03] px-2.5 py-2">
          <div className="flex items-start justify-between gap-2">
            <p className="text-[11px] text-neutral-400">
              {S.graph.sameNameNote(sameName.length)}{" "}
              <span className="text-neutral-500">{S.graph.sameNameHint}</span>
            </p>
            <button
              onClick={() => setSameName([])}
              className="text-neutral-600 hover:text-neutral-300 shrink-0"
            >
              <X size={11} />
            </button>
          </div>
          {/* Each same-name entity offers two actions: go look at it, or merge it
              in. **The direction is fixed as "merge into the entity open now"**
              — a merge has a direction (the source disappears; its facts move to
              the target), and the entity open now is the one the user is
              looking at and judging. */}
          <div className="mt-1.5 space-y-1">
            {sameName.map((p) => (
              <div key={p.id} className="flex items-center gap-1">
                <button
                  onClick={() => onNavigate(p.id)}
                  className="min-w-0 flex-1 truncate text-left text-[11px] px-1.5 py-0.5 rounded bg-white/[0.06] text-neutral-300 hover:bg-white/10"
                >
                  {p.type_label ?? S.graph.untyped}
                  {p.disambiguator && p.disambiguator !== p.type_label
                    ? ` · ${p.disambiguator}`
                    : ""}
                </button>
                <button
                  className="shrink-0 text-[11px] px-1.5 py-0.5 rounded text-neutral-400 hover:bg-white/10 hover:text-neutral-100"
                  disabled={merge.isPending}
                  title={S.graph.mergeIntoHint}
                  onClick={() => {
                    if (confirm(S.graph.mergeConfirm(p.name, e?.name ?? "")))
                      merge.mutate(p.id);
                  }}
                >
                  {S.graph.mergeInto}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* View switch: Relations (grouped) | Timeline (chronological). */}
      <div className="px-4 pt-2.5">
        <div className="flex rounded-lg overflow-hidden border border-white/10 w-fit">
          {(["relations", "timeline", "history", "derived"] as const)
            // The Derived tab: **it does not appear when there is nothing
            // derived.** A base with inference off should not see a tab that is
            // always empty.
            .filter((v) => v !== "derived" || derived.length > 0)
            .map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`px-3 py-1 text-[11px] transition-colors ${
                  view === v
                    ? "bg-white/10 text-neutral-100"
                    : "text-neutral-500 hover:bg-white/[0.05] hover:text-neutral-300"
                }`}
              >
                {v === "relations"
                  ? S.graph.viewRelations
                  : v === "timeline"
                    ? S.graph.viewTimeline
                    : v === "history"
                      ? S.graph.viewHistory
                      : S.graph.viewDerived}
              </button>
            ))}
        </div>
      </div>

      <div className="u-scroll flex-1 overflow-y-auto px-2 py-2">
        {view === "relations" && historicalCount > 0 && (
          <button
            onClick={() => setView("timeline")}
            className="mx-2 mb-2 mt-0.5 text-[11px] text-neutral-500 hover:text-neutral-300 underline-offset-2 hover:underline"
          >
            {S.graph.historicalNote(historicalCount)}
          </button>
        )}
        {view === "relations" &&
          groups.map((gr) => (
            <div key={gr.key} className="mb-3 last:mb-1">
              <div className="flex items-center gap-1.5 px-2 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-neutral-500">
                {gr.direction === "in" ? (
                  <ArrowLeft size={10} />
                ) : (
                  <ArrowRight size={10} />
                )}
                <span
                  className={
                    gr.label === null ? "italic text-neutral-600" : undefined
                  }
                  title={
                    gr.label && gr.inferred
                      ? S.graph.inferredPredicate
                      : undefined
                  }
                >
                  {gr.label ?? S.graph.unknownPredicate}
                </span>
                {gr.rows.length > 1 && (
                  <span className="text-neutral-600">{gr.rows.length}</span>
                )}
              </div>
              <div>
                {gr.rows.map((f) => (
                  <FactRow
                    key={f.id}
                    kbId={kbId}
                    fact={f}
                    open={openFact === f.id}
                    onToggle={() =>
                      setOpenFact(openFact === f.id ? null : f.id)
                    }
                    onNavigate={onNavigate}
                  />
                ))}
              </div>
            </div>
          ))}
        {view === "timeline" && (
          <TimelineView
            kbId={kbId}
            facts={detail.data?.facts ?? []}
            openFact={openFact}
            onToggle={(id) => setOpenFact(openFact === id ? null : id)}
            onNavigate={onNavigate}
          />
        )}
        {view === "history" && (
          <EntityHistory kbId={kbId} entityId={entityId} />
        )}
{view === "derived" && (
          <>
            <p className="px-2 pb-1.5 pt-0.5 text-[11px] leading-relaxed text-neutral-500">
              {S.graph.derivedHint}
            </p>
            {/* **The same structure as Relations**: a direction arrow, a
                predicate, and a count in a small heading, with compact rows
                below. The rule (transitive/symmetric) attaches to the heading —
                it holds for the whole group, so repeating it on every row would
                be redundant, and that `--u-warn` amber color would also compete
                in hue with a derived edge. */}
            {derivedGroups.map((gr) => (
              <div key={gr.key} className="mb-3 last:mb-1">
                <div className="flex items-center gap-1.5 px-2 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-neutral-500">
                  {gr.direction === "in" ? (
                    <ArrowLeft size={10} />
                  ) : (
                    <ArrowRight size={10} />
                  )}
                  <span>{gr.predicate}</span>
                  <span className="text-neutral-600">{gr.rule}</span>
                  {gr.rows.length > 1 && (
                    <span className="ml-auto text-neutral-600">
                      {gr.rows.length}
                    </span>
                  )}
                </div>
                <div>
                  {gr.rows.map((d) => {
                    const out = d.subject_id === entityId;
                    return (
                      <DerivedRow
                        key={d.id}
                        d={d}
                        otherId={out ? d.object_id : d.subject_id}
                        otherName={out ? d.object : d.subject}
                        open={openFact === d.id}
                        onToggle={() =>
                          setOpenFact(openFact === d.id ? null : d.id)
                        }
                        onNavigate={onNavigate}
                      />
                    );
                  })}
                </div>
              </div>
            ))}
          </>
        )}
        {view !== "history" &&
          view !== "derived" &&
          detail.data?.facts.length === 0 && (
            <p className="text-sm text-neutral-500 p-2">{S.graph.noFacts}</p>
          )}
      </div>
    </div>
  );
}

/** The timeline view: facts with an interval lay out as a vertical timeline by
 *  start date; facts with no time sink to the bottom, under Undated. */
function TimelineView({
  kbId,
  facts,
  openFact,
  onToggle,
  onNavigate,
}: {
  kbId: string;
  facts: EntityFact[];
  openFact: string | null;
  onToggle: (id: string) => void;
  onNavigate: (entityId: string) => void;
}) {
  const dated = facts
    .filter((f) => f.temporal !== "eternal" && (f.valid_from || f.valid_to))
    .sort((a, b) =>
      (a.valid_from ?? a.valid_to ?? "") < (b.valid_from ?? b.valid_to ?? "")
        ? -1
        : 1,
    );
  const undated = facts.filter((f) => !dated.includes(f));

  return (
    <div className="px-2 pt-1">
      <div className="relative ml-1.5 border-l border-white/15 pl-3 space-y-0.5">
        {dated.map((f) => (
          <div key={f.id} className="relative">
            <span className="absolute -left-[17.5px] top-2.5 h-2 w-2 rounded-full bg-neutral-600 ring-2 ring-[#0f0f0f]" />
            <TimelineRow
              kbId={kbId}
              fact={f}
              open={openFact === f.id}
              onToggle={() => onToggle(f.id)}
              onNavigate={onNavigate}
            />
          </div>
        ))}
        {dated.length === 0 && (
          <p className="py-2 text-xs text-neutral-500">
            {S.graph.timelineEmpty}
          </p>
        )}
      </div>
      {undated.length > 0 && (
        <div className="mt-3">
          <div className="px-2 pb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-neutral-600">
            {S.graph.undated}
          </div>
          {undated.map((f) => (
            <FactRow
              key={f.id}
              kbId={kbId}
              fact={f}
              open={openFact === f.id}
              onToggle={() => onToggle(f.id)}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** A timeline entry: the interval, a marker for how it closed, and the last
 *  confirmation time for an open-ended fact; clicking expands the evidence. */
function TimelineRow({
  kbId,
  fact,
  open,
  onToggle,
  onNavigate,
}: {
  kbId: string;
  fact: EntityFact;
  open: boolean;
  onToggle: () => void;
  onNavigate: (entityId: string) => void;
}) {
  const interval = fmtInterval(fact);
  const isOpenEnded = !fact.valid_to;
  const literal = fmtObjectValue(fact.object_value);
  return (
    <div
      className={`rounded-lg transition-colors ${open ? "bg-white/[0.05]" : "hover:bg-white/[0.04]"} ${
        fact.stale ? "opacity-55" : ""
      }`}
      title={fact.stale ? S.graph.staleFactHint : undefined}
    >
      <button onClick={onToggle} className="w-full text-left px-2 py-1.5">
        <div className="flex items-center gap-1.5 u-num text-[10.5px] text-neutral-500">
          {interval || "—"}
          {fact.corrected && (
            <span className="text-neutral-600" title={S.graph.correctedHint}>
              ⟲
            </span>
          )}
          {isOpenEnded && fact.last_evidence_time && (
            <span className="ml-auto text-neutral-600">
              {S.graph.lastConfirmed(fact.last_evidence_time.slice(0, 10))}
            </span>
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[13px] text-neutral-200">
          <span className="text-neutral-500 text-xs">
            {fact.direction === "in" ? "←" : "→"}{" "}
            <span
              className={
                fact.predicate_label === null
                  ? "italic text-neutral-600"
                  : undefined
              }
              title={
                fact.predicate_label && fact.inferred
                  ? S.graph.inferredPredicate
                  : undefined
              }
            >
              {fact.predicate_label ?? S.graph.unknownPredicate}
            </span>
          </span>
          {fact.other_id ? (
            <span
              role="link"
              tabIndex={0}
              onClick={(ev) => {
                ev.stopPropagation();
                onNavigate(fact.other_id!);
              }}
              onKeyDown={(ev) => {
                if (ev.key === "Enter") {
                  ev.stopPropagation();
                  onNavigate(fact.other_id!);
                }
              }}
              className="truncate hover:text-white hover:underline underline-offset-2 decoration-white/30"
            >
              {fact.other_name ?? "?"}
            </span>
          ) : (
            <span className="truncate">
              {fact.other_name ?? literal ?? "?"}
            </span>
          )}
          {fact.stale && (
            <span className="u-chip u-chip-neutral shrink-0 !text-[10px] !px-1.5">
              {S.graph.staleFactChip}
            </span>
          )}
        </div>
      </button>
      {open && <EvidenceList kbId={kbId} fact={fact} />}
    </div>
  );
}

/** Displays a literal-valued object: an attribute as {value, unit}, a data
 *  mapping as {summary}, and anything else falls back to raw JSON. */
function fmtObjectValue(v: Record<string, unknown> | null): string | null {
  if (!v) return null;
  if (v.value !== undefined) {
    const val =
      typeof v.value === "boolean" ? (v.value ? "✓" : "✗") : String(v.value);
    return typeof v.unit === "string" && v.unit ? `${val} ${v.unit}` : val;
  }
  if (typeof v.summary === "string") return v.summary;
  return JSON.stringify(v);
}

function FactRow({
  kbId,
  fact,
  open,
  onToggle,
  onNavigate,
}: {
  kbId: string;
  fact: EntityFact;
  open: boolean;
  onToggle: () => void;
  onNavigate: (entityId: string) => void;
}) {
  const interval = fmtInterval(fact);
  // Matches the same low-confidence threshold as Review: a chip appears only
  // when confidence is low enough to doubt; normal confidence stays silent.
  const lowConfidence = fact.confidence < 0.75;

  return (
    <div
      className={`rounded-lg transition-colors ${open ? "bg-white/[0.05]" : "hover:bg-white/[0.04]"} ${
        fact.stale ? "opacity-55" : ""
      }`}
      title={fact.stale ? S.graph.staleFactHint : undefined}
    >
      <button
        onClick={onToggle}
        className="w-full text-left px-2 py-1.5 flex items-center gap-1.5"
      >
        <ChevronRight
          size={11}
          className={`shrink-0 text-neutral-600 transition-transform ${open ? "rotate-90" : ""}`}
        />
        {fact.other_id ? (
          <span
            role="link"
            tabIndex={0}
            onClick={(ev) => {
              ev.stopPropagation();
              onNavigate(fact.other_id!);
            }}
            onKeyDown={(ev) => {
              if (ev.key === "Enter") {
                ev.stopPropagation();
                onNavigate(fact.other_id!);
              }
            }}
            className="truncate text-[13px] text-neutral-200 hover:text-white hover:underline underline-offset-2 decoration-white/30"
          >
            {fact.other_name ?? "?"}
          </span>
        ) : (
          <span className="truncate text-[13px] text-neutral-200">
            {fact.other_name ?? fmtObjectValue(fact.object_value) ?? "?"}
          </span>
        )}
        {lowConfidence && (
          <span className="shrink-0 u-num u-meta-warn text-[10.5px]">
            {Math.round(fact.confidence * 100)}%
          </span>
        )}
        {fact.stale && (
          <span className="u-chip u-chip-neutral shrink-0 !text-[10px] !px-1.5">
            {S.graph.staleFactChip}
          </span>
        )}
        {interval && (
          <span className="ml-auto shrink-0 pl-2 u-num text-[10.5px] text-neutral-500">
            {interval}
          </span>
        )}
      </button>
      {open && <EvidenceList kbId={kbId} fact={fact} />}
    </div>
  );
}

/** The evidence panel, shared by FactRow and TimelineRow: a quote, a link to
 *  the source, a version badge, and confidence. */
function EvidenceList({ kbId, fact }: { kbId: string; fact: EntityFact }) {
  const evidence = useQuery({
    queryKey: ["evidence", fact.id],
    queryFn: () => api.factEvidence(kbId, fact.id),
  });
  return (
    <div className="mx-2 mb-2 mt-0.5 space-y-2 border-l border-white/15 pl-2.5">
      {evidence.data?.evidence.map((ev: Evidence) => (
        <Link
          key={ev.chunk_id}
          to="/kb/$kbId/doc/$docId"
          params={{ kbId, docId: ev.document_id }}
          search={{ chunk: ev.chunk_id }}
          className="block text-xs text-neutral-500 hover:text-neutral-300"
        >
          {/* The source text's own wording for this predicate, written here only
              when it differs from what the fact row already shows. For a
              predicate outside the ontology, the fact row already shows the
              source's own wording (migration 0052); writing the same wording
              again would be noise. This shows up only when a fact has more than
              one wording, which happens in about 3% of facts. */}
          {ev.proposed_predicate &&
            ev.proposed_predicate !== fact.predicate_key && (
              <div className="mb-0.5 text-[11px] text-neutral-400">
                {S.graph.proposedPredicate(ev.proposed_predicate)}
              </div>
            )}
          <div className="line-clamp-2 italic">
            {ev.quote ? `“${ev.quote}”` : S.graph.noQuote}
          </div>
          <div className="mt-0.5 text-neutral-400">
            {S.graph.sectionRef(ev.filename, ev.seq + 1)}
            {ev.stale && (
              <span
                className="ml-1.5 u-num text-[10px] text-neutral-600"
                title={S.graph.staleEvidenceHint}
              >
                {S.graph.fromVersion(ev.doc_version)}
              </span>
            )}
          </div>
        </Link>
      ))}
      {evidence.data?.evidence.length === 0 && (
        <p className="text-xs text-neutral-500">{S.graph.noEvidence}</p>
      )}
      {/* Confidence is shown only when it is low enough to doubt (matching
          Review's low-confidence threshold); normal confidence stays unmarked. */}
      {fact.confidence < 0.75 && (
        <p className="text-[10px] text-[var(--u-warn)]">
          {Math.round(fact.confidence * 100)}% {S.graph.confidence}
        </p>
      )}
    </div>
  );
}

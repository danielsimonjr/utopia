/* The Utopia UI component library. Pages use only these components and
   the semantic classes in styles.css. Pages do not write color literals. */
import { useEffect, useRef, useState } from "react";
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
} from "react";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Search as SearchIcon,
} from "lucide-react";
import { S } from "../i18n";

/** The shared base for the app's left rail: width and glass surface. Each
    page adds its own flex layout and padding on top of this.
    The width matches the widest rail, the Ontology page (w-64), because
    a rail holds names, and a wider rail truncates fewer of them. */
export const RAIL_CLS = "w-64 shrink-0 glass-strong border-y-0 border-l-0";

/** Brand wordmark: a Marcellus serif font, with each letter fading in from
    left to right. On hover, an arrow (↗) appears; a click opens the
    marketing site. The arrow and its offset use `em` units, so they scale
    with the font size at each usage site (the login page and the top bar share this component). */
export function Wordmark({ className }: { className?: string }) {
  return (
    <a
      href={S.app.siteUrl}
      target="_blank"
      rel="noreferrer"
      title="utopia.bi"
      className={cn("relative inline-flex text-white", className)}
      style={{ fontFamily: "var(--font-brand)", letterSpacing: "0.06em" }}
    >
      {[...S.app.name].map((ch, i) => (
        <span
          key={i}
          className="u-letter"
          style={{ animationDelay: `${80 + i * 65}ms` }}
        >
          {ch}
        </span>
      ))}
      <ArrowUpRight className="u-mark-arrow" aria-hidden />
    </a>
  );
}

export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

/* ---------- Button ---------- */
type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost";
  size?: "sm" | "md";
};

export function Button({
  variant = "primary",
  size = "md",
  className,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(
        "u-btn",
        variant === "primary" ? "u-btn-primary" : "u-btn-ghost",
        size === "sm" ? "px-3 py-1.5 text-xs" : "px-4 py-2 text-sm",
        className,
      )}
      {...props}
    />
  );
}

/* ---------- Input / Select ---------- */
export function Input({
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn("input-dark px-3 py-2 text-sm", className)}
      {...props}
    />
  );
}

/* ---------- Dropdown (a custom dropdown that replaces the native
   `select`, because a native popover cannot take a custom theme) ---------- */
export interface DropdownOption {
  value: string;
  label: ReactNode;
}

export function Dropdown({
  value,
  options,
  onChange,
  placeholder,
  className,
  size = "md",
  icon,
  menuLabel,
  footer,
}: {
  value: string;
  options: DropdownOption[];
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  size?: "sm" | "md";
  /** A semantic icon on the left of the trigger, showing what this level represents. */
  icon?: ReactNode;
  /** A small heading at the top of the popover. This also becomes the trigger's title tooltip. */
  menuLabel?: string;
  /** A fixed action area at the bottom of the popover. Clicking it closes the popover. */
  footer?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = options.find((o) => o.value === value);
  const pad = size === "sm" ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-sm";

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        title={menuLabel}
        className={cn(
          "input-dark w-full flex items-center gap-2 text-left",
          pad,
        )}
      >
        {icon && <span className="shrink-0 text-neutral-500">{icon}</span>}
        <span className="flex-1 min-w-0 truncate">
          {current?.label ?? (
            <span className="text-neutral-600">{placeholder ?? ""}</span>
          )}
        </span>
        <ChevronDown
          size={12}
          className={cn(
            "shrink-0 text-neutral-500 transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <div className="u-pop u-pop-in u-pop-in-tl absolute z-50 mt-1 w-full rounded-lg shadow-xl overflow-hidden">
          {menuLabel && (
            <div className="px-2.5 pt-2 pb-1 text-[9.5px] font-medium uppercase tracking-[0.1em] text-neutral-600 border-b border-white/5">
              {menuLabel}
            </div>
          )}
          {/* Each option row spans to the panel edge, with no inner
              padding. With a single option, that option fills the whole menu. */}
          <div className="u-scroll max-h-60 overflow-y-auto">
            {options.map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
                className={cn(
                  "w-full flex items-center gap-2 text-left",
                  pad,
                  o.value === value
                    ? "bg-white/[0.12] text-white"
                    : "text-neutral-300 hover:bg-white/[0.06] hover:text-white",
                )}
              >
                <span className="flex-1 min-w-0 truncate">{o.label}</span>
                {o.value === value && (
                  <Check size={12} className="shrink-0 text-neutral-400" />
                )}
              </button>
            ))}
          </div>
          {footer && (
            <div
              className="border-t border-white/10"
              onClick={() => setOpen(false)}
            >
              {footer}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------- SearchSelect (a searchable picker, for an unbounded list of
   objects such as members, parent types, or data sources.
   The trigger itself is a text input: it opens on focus and filters as
   the user types. It renders up to `maxVisible` rows, and prompts the
   user to narrow the search when more rows exist. A small, bounded set of
   values, such as roles or data types, still uses Dropdown, since two
   clicks reach the answer with no typing needed. ---------- */
export interface SearchSelectOption {
  value: string;
  /** The main label: the basis for filtering and for the selected display. This must be a plain string, not a node. */
  label: string;
  /** A secondary label, such as an email or a connection summary. This also affects filtering, and displays in a muted style. */
  hint?: string;
  /** The indent level. Browsing shows a tree; typing a filter flattens the list and removes the indent. */
  indent?: number;
}

export function SearchSelect({
  value,
  options,
  onChange,
  placeholder,
  className,
  size = "md",
  maxVisible = 8,
}: {
  value: string;
  options: SearchSelectOption[];
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  size?: "sm" | "md";
  maxVisible?: number;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const current = options.find((o) => o.value === value);
  const q = query.trim().toLowerCase();
  const matches = q
    ? options.filter((o) =>
        `${o.label} ${o.hint ?? ""}`.toLowerCase().includes(q),
      )
    : options;
  const visible = matches.slice(0, maxVisible);
  const hidden = matches.length - visible.length;

  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
    setQuery("");
    inputRef.current?.blur();
  };

  const pad =
    size === "sm" ? "pl-7 pr-2.5 py-1 text-xs" : "pl-8 pr-3 py-1.5 text-sm";
  const rowPad = size === "sm" ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-sm";

  return (
    <div className={cn("relative", className)}>
      <SearchIcon
        size={size === "sm" ? 11 : 13}
        className="absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-600 pointer-events-none"
      />
      <input
        ref={inputRef}
        className={cn("input-dark w-full", pad)}
        value={open ? query : (current?.label ?? "")}
        /* Once open, the current selection moves into the placeholder, so the current value stays visible while typing. */
        placeholder={open ? current?.label || placeholder : placeholder}
        onFocus={() => {
          setOpen(true);
          setQuery("");
          setActive(0);
        }}
        /* Each option row calls preventDefault on mousedown, so it does not
           steal focus. So any blur that reaches this handler is a real exit. */
        onBlur={() => setOpen(false)}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setOpen(false);
            inputRef.current?.blur();
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, visible.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter" && visible[active]) {
            e.preventDefault();
            pick(visible[active].value);
          }
        }}
      />
      {open && (
        <div className="u-pop u-pop-in u-pop-in-tl absolute z-50 mt-1 w-full rounded-lg shadow-xl overflow-hidden">
          {visible.map((o, i) => (
            <button
              key={o.value}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(o.value)}
              onMouseEnter={() => setActive(i)}
              className={cn(
                "w-full flex items-center gap-2 text-left",
                rowPad,
                i === active
                  ? "bg-white/[0.08] text-white"
                  : "text-neutral-300",
              )}
            >
              {!q && !!o.indent && (
                <span className="shrink-0" style={{ width: o.indent * 14 }} />
              )}
              <span className="min-w-0 flex-1 truncate">
                {o.label}
                {o.hint && (
                  <span className="ml-2 text-neutral-500">{o.hint}</span>
                )}
              </span>
              {o.value === value && (
                <Check size={12} className="shrink-0 text-neutral-400" />
              )}
            </button>
          ))}
          {visible.length === 0 && (
            <p className={cn(rowPad, "text-neutral-600")}>{S.ui.noMatches}</p>
          )}
          {hidden > 0 && (
            <div
              className={cn(
                rowPad,
                "border-t border-white/5 text-[11px] text-neutral-600",
              )}
            >
              {S.ui.keepTyping(hidden)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------- MultiSearchSelect (a multi-select version of SearchSelect) ---------- */

/**
 * Multi-select with search. This shares its patterns and keyboard
 * behavior with [`SearchSelect`], with three differences:
 *
 * - **The selected values display above the input**, each with its own
 *   remove button. They do not display inside the dropdown, because the
 *   dropdown becomes invisible once closed, and "what did I select"
 *   needs to stay visible at all times.
 * - **Selecting an option does not close the dropdown.** A multi-select
 *   action usually needs several clicks in a row, and refocusing each
 *   time would be tedious.
 * - A selected option shows a check mark in the list; clicking it again removes it.
 *
 * This stays usable with several hundred options, the scale of a large
 * ontology. That is the reason it replaces a wall of chips: a chip wall's
 * height grows with the number of types, but a search box's height does not.
 */
export function MultiSearchSelect({
  values,
  options,
  onToggle,
  placeholder,
  emptyHint,
  className,
  maxVisible = 8,
}: {
  values: string[];
  options: SearchSelectOption[];
  onToggle: (v: string) => void;
  placeholder?: string;
  /** The text shown when nothing is selected. In a multi-select, an
   *  empty value often means "no restriction", not "not filled in yet". */
  emptyHint?: string;
  className?: string;
  maxVisible?: number;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const q = query.trim().toLowerCase();
  const matches = q
    ? options.filter((o) =>
        `${o.label} ${o.hint ?? ""}`.toLowerCase().includes(q),
      )
    : options;
  const visible = matches.slice(0, maxVisible);
  const hidden = matches.length - visible.length;
  const picked = values
    .map((v) => options.find((o) => o.value === v))
    .filter((o): o is SearchSelectOption => !!o);

  const toggle = (v: string) => {
    onToggle(v);
    setQuery("");
    setActive(0);
    inputRef.current?.focus();
  };

  return (
    <div className={cn("relative", className)}>
      {picked.length > 0 && (
        <div className="mb-1 flex flex-wrap gap-1">
          {picked.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => onToggle(o.value)}
              className="group flex items-center gap-1 rounded-full bg-white/[0.10] px-2 py-0.5 text-[11px] text-neutral-200 hover:bg-white/[0.16] transition-colors"
              title={o.hint ?? o.label}
            >
              {o.label}
              <span className="text-neutral-500 group-hover:text-neutral-200">
                ✕
              </span>
            </button>
          ))}
        </div>
      )}
      {picked.length === 0 && emptyHint && (
        <p className="mb-1 text-[11px] text-neutral-600">{emptyHint}</p>
      )}
      <SearchIcon
        size={11}
        className="absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-600 pointer-events-none"
        style={{ top: undefined }}
      />
      <input
        ref={inputRef}
        className="input-dark w-full pl-7 pr-2.5 py-1 text-xs"
        value={query}
        placeholder={placeholder}
        onFocus={() => {
          setOpen(true);
          setActive(0);
        }}
        onBlur={() => setOpen(false)}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setOpen(false);
            inputRef.current?.blur();
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, visible.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter" && visible[active]) {
            e.preventDefault();
            toggle(visible[active].value);
          } else if (e.key === "Backspace" && !query && picked.length) {
            // With an empty input, Backspace removes the last selected item, matching most token inputs.
            onToggle(picked[picked.length - 1].value);
          }
        }}
      />
      {open && (
        <div className="u-pop u-pop-in u-pop-in-tl absolute z-50 mt-1 w-full rounded-lg shadow-xl overflow-hidden">
          {visible.map((o, i) => (
            <button
              key={o.value}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => toggle(o.value)}
              onMouseEnter={() => setActive(i)}
              className={cn(
                "w-full flex items-center gap-2 text-left px-2.5 py-1 text-xs",
                i === active
                  ? "bg-white/[0.08] text-white"
                  : "text-neutral-300",
              )}
            >
              {!q && !!o.indent && (
                <span className="shrink-0" style={{ width: o.indent * 14 }} />
              )}
              <span className="min-w-0 flex-1 truncate">
                {o.label}
                {o.hint && (
                  <span className="ml-2 text-neutral-500">{o.hint}</span>
                )}
              </span>
              {values.includes(o.value) && (
                <Check size={12} className="shrink-0 text-neutral-400" />
              )}
            </button>
          ))}
          {visible.length === 0 && (
            <p className="px-2.5 py-1 text-xs text-neutral-600">
              {S.ui.noMatches}
            </p>
          )}
          {hidden > 0 && (
            <div className="px-2.5 py-1 text-[11px] text-neutral-600 border-t border-white/5">
              {S.ui.keepTyping(hidden)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------- ColorPicker (a curated palette with a hex fallback; entity
   colors intentionally do not expose the full color range) ----------
   **A change here also requires a change to
   `crates/utopia-store/src/palette.rs`.** A manually chosen color and an
   automatically assigned color, by key, must come from the same palette.
   Otherwise, a single graph could show two different color sets. That
   crate has a test that checks this; a missed update fails that test. */
export const ENTITY_PALETTE = [
  "#7fd0ff",
  "#5fa8ff",
  "#5fd4d0",
  "#63e2b7",
  "#4cc38a",
  "#a8d878",
  "#ffd479",
  "#f2b66d",
  "#ff9d76",
  "#ff8a9e",
  "#ff9daf",
  "#e797d8",
  "#c4a5ff",
  "#9fa8ff",
  "#8ea5bd",
  "#b3b9c4",
];

/**
 * Maps a type's key to a color. **This must match
 * `color_for_key` in `crates/utopia-store/src/palette.rs` bit for bit.**
 * When a user creates a new type, the frontend picks a color from the key
 * first, and that color stays unless the user changes it. Import and
 * resolution flows compute the color on the server instead. If the two
 * computations differ, the same key gets a different color depending on
 * which path created it.
 *
 * This uses FNV-1a with an avalanche mix. It uses `BigInt` because JS bit
 * operations are limited to 32 bits, and this computation needs a 64-bit
 * multiplication. Using `Number` would silently drop the high bits,
 * producing a result that does not match the Rust implementation, with no error raised.
 */
export function colorForKey(key: string): string {
  let h = 0xcbf29ce484222325n;
  const M = (1n << 64n) - 1n;
  for (const b of new TextEncoder().encode(key)) {
    h = (h ^ BigInt(b)) & M;
    h = (h * 0x100000001b3n) & M;
  }
  h = (h ^ (h >> 33n)) & M;
  h = (h * 0xff51afd7ed558ccdn) & M;
  h = (h ^ (h >> 33n)) & M;
  return ENTITY_PALETTE[Number(h % BigInt(ENTITY_PALETTE.length))];
}

export function ColorPicker({
  value,
  onChange,
  shape,
}: {
  value: string;
  onChange: (v: string) => void;
  /** When set, the color well renders a "shape plus color" instead of a
   *  filled block. The square shape uses right angles, matching graph node shapes. */
  shape?: "circle" | "square";
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const valid = /^#[0-9a-fA-F]{6}$/.test(value);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative inline-block">
      {/* Trigger: the current color swatch (a Figma-style color well). With a shape set, this renders shape plus color. */}
      {shape ? (
        <button
          type="button"
          title={value}
          onClick={() => setOpen(!open)}
          className="h-8 w-14 rounded-lg border border-white/15 hover:border-white/35 transition-colors bg-white/[0.04] grid place-items-center"
        >
          <span
            className={cn("h-3.5 w-3.5", shape === "circle" && "rounded-full")}
            style={{ background: valid ? value : ENTITY_PALETTE[0] }}
          />
        </button>
      ) : (
        <button
          type="button"
          title={value}
          onClick={() => setOpen(!open)}
          className="h-8 w-14 rounded-lg border border-white/15 hover:border-white/35 transition-colors"
          style={{ background: valid ? value : ENTITY_PALETTE[0] }}
        />
      )}
      {open && (
        // An explicit width is needed: a shrink-fit width on an
        // absolutely positioned element would collapse to the 56px width
        // of the inline-block trigger.
        <div className="u-pop u-pop-in u-pop-in-tl absolute z-50 left-0 top-full mt-2 w-56 rounded-xl p-3 shadow-xl">
          <div className="grid grid-cols-8 gap-1.5 mb-2.5">
            {ENTITY_PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                title={c}
                onClick={() => {
                  onChange(c);
                  setOpen(false);
                }}
                className={cn(
                  "h-5 w-5 rounded-full transition-transform hover:scale-110",
                  value.toLowerCase() === c &&
                    "outline outline-2 outline-white/80 outline-offset-1",
                )}
                style={{ background: c }}
              />
            ))}
          </div>
          <input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={ENTITY_PALETTE[0]}
            className={cn(
              "input-dark w-full px-2 py-1 text-xs font-mono",
              !valid && "!border-[var(--u-danger)]",
            )}
          />
        </div>
      )}
    </div>
  );
}

/* ---------- Pager (a list paging bar; it hides itself when the list fits on one page) ---------- */
export function Pager({
  total,
  pageSize,
  page,
  onPage,
  /** Overrides the default top margin. The default `mt-3` fits after a
      list. Pass `""` to remove it when placing this inside a footer that
      already has padding. */
  className = "mt-3",
}: {
  total: number;
  pageSize: number;
  page: number;
  onPage: (p: number) => void;
  className?: string;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safe = Math.min(page, pageCount - 1);
  if (total <= pageSize) return null;
  return (
    <div className={cn("flex items-center justify-end gap-2 text-xs text-neutral-500", className)}>
      <span className="u-num">
        {S.library.pageOf(
          safe * pageSize + 1,
          Math.min((safe + 1) * pageSize, total),
          total,
        )}
      </span>
      <button
        onClick={() => onPage(safe - 1)}
        disabled={safe === 0}
        className="u-btn u-btn-ghost h-7 w-7 grid place-items-center rounded-lg"
      >
        <ChevronLeft size={13} />
      </button>
      <button
        onClick={() => onPage(safe + 1)}
        disabled={safe >= pageCount - 1}
        className="u-btn u-btn-ghost h-7 w-7 grid place-items-center rounded-lg"
      >
        <ChevronRight size={13} />
      </button>
    </div>
  );
}

/** A paging helper: returns the current page's rows and a bounds-checked page number. */
export function pageSlice<T>(
  items: T[],
  page: number,
  pageSize: number,
): { rows: T[]; safe: number } {
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const safe = Math.min(page, pageCount - 1);
  return { rows: items.slice(safe * pageSize, (safe + 1) * pageSize), safe };
}

/* ---------- DangerConfirm (a confirmation dialog for a dangerous action;
   it can require the user to type an exact text to unlock the action) ---------- */
export function DangerConfirm({
  title,
  hint,
  requireText,
  confirmLabel,
  cancelLabel,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string;
  hint: string;
  /** A text (for example, a resource name) the user must type exactly to
   *  unlock the action. Without this, the action confirms immediately. */
  requireText?: string;
  confirmLabel: string;
  cancelLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const unlocked = !requireText || text === requireText;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      className="u-modal-scrim fixed inset-0 z-50 grid place-items-center bg-black/80 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="u-modal-panel u-modal-in w-[24rem] max-w-[calc(100vw-2rem)] rounded-2xl shadow-2xl p-5">
        <h2 className="text-[15px] font-semibold text-[var(--u-danger)] mb-2">
          {title}
        </h2>
        <p className="text-xs text-neutral-400 leading-relaxed mb-4">{hint}</p>
        {requireText && (
          <input
            autoFocus
            className="input-dark w-full px-3 py-2 text-sm mb-4"
            placeholder={requireText}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        )}
        <div className="flex justify-end gap-2">
          <button
            className="u-btn u-btn-ghost px-3.5 py-1.5 text-xs"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            className="u-btn px-3.5 py-1.5 text-xs font-semibold disabled:opacity-40"
            style={{ background: "var(--u-danger-solid)", color: "#ffffff" }}
            disabled={!unlocked || busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- Panel (a glass-surface panel) ---------- */
export function Panel({
  strong = false,
  className,
  children,
}: {
  strong?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(strong ? "glass-strong" : "glass", "rounded-xl", className)}
    >
      {children}
    </div>
  );
}

/* ---------- Chip (a status pill) ---------- */
export type ChipTone =
  "neutral" | "info" | "success" | "warn" | "danger" | "violet";

export function Chip({
  tone = "neutral",
  className,
  title,
  children,
}: {
  tone?: ChipTone;
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <span className={cn("u-chip", `u-chip-${tone}`, className)} title={title}>
      {children}
    </span>
  );
}

/* ---------- PageTitle ---------- */
export function PageTitle({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <h2 className={cn("u-title text-lg", className)}>{children}</h2>;
}

/* ---------- EmptyState ---------- */
export function EmptyState({
  icon,
  children,
}: {
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="text-center">
      <div className="glass mx-auto mb-4 h-14 w-14 rounded-2xl grid place-items-center text-xl font-bold text-neutral-300">
        {icon}
      </div>
      <div className="text-sm text-neutral-500 whitespace-pre-line">
        {children}
      </div>
    </div>
  );
}

/* ---------- Loading / ErrorText ---------- */
export function Loading({ children }: { children: ReactNode }) {
  return <div className="p-8 text-sm text-neutral-500">{children}</div>;
}

export function ErrorText({ children }: { children: ReactNode }) {
  return <p className="text-sm text-rose-400">{children}</p>;
}

/* ---------- GithubMark (lucide has no brand icons, so this inlines the official mark) ---------- */
export function GithubMark({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
    >
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

/* ---------- SectionMark (a section wordmark for the Docs page and the
   account layer; each letter fades in, and a click returns to the app) ---------- */
import { Link as RouterLink } from "@tanstack/react-router";
export function SectionMark({ text, title }: { text: string; title: string }) {
  return (
    <RouterLink
      to="/"
      title={title}
      className="relative inline-flex text-white text-[17px]"
      style={{ fontFamily: "var(--font-brand)", letterSpacing: "0.06em" }}
    >
      {[...text].map((ch, i) => (
        <span
          key={i}
          className="u-letter"
          style={{ animationDelay: `${80 + i * 45}ms` }}
        >
          {/* inline-flex collapses a span that holds only a plain space; the replacement character does not collapse. */}
          {ch === " " ? " " : ch}
        </span>
      ))}
    </RouterLink>
  );
}

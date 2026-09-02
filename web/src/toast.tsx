/* Global toast messages: a module-level singleton, plus one <ToastHost/>
   mounted once at the app root. Any module can call
   `import { toast } from "./toast"` to show a message, with no context
   wiring needed. Toasts stack at the bottom right. Success and info
   toasts dismiss after 3.8s, error toasts after 6s. The user can also
   close a toast manually. */
import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";

type Kind = "success" | "error" | "info";
type Item = { id: number; kind: Kind; text: string };

let nextId = 1;
let items: Item[] = [];
let listener: ((items: Item[]) => void) | null = null;

function dismiss(id: number) {
  items = items.filter((t) => t.id !== id);
  listener?.(items);
}

function push(kind: Kind, text: string) {
  const id = nextId++;
  items = [...items, { id, kind, text }];
  listener?.(items);
  window.setTimeout(() => dismiss(id), kind === "error" ? 6000 : 3800);
}

export const toast = {
  success: (text: string) => push("success", text),
  error: (text: string) => push("error", text),
  info: (text: string) => push("info", text),
};

const ICON = { success: CheckCircle2, error: AlertCircle, info: Info } as const;
const ICON_COLOR: Record<Kind, string> = {
  success: "text-[var(--u-ok)]",
  error: "text-[var(--u-danger)]",
  info: "text-neutral-400",
};

export function ToastHost() {
  const [list, setList] = useState<Item[]>(items);
  useEffect(() => {
    listener = setList;
    return () => {
      if (listener === setList) listener = null;
    };
  }, []);
  if (!list.length) return null;
  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-[100] flex flex-col items-end gap-2">
      {list.map((t) => {
        const Icon = ICON[t.kind];
        return (
          <div
            key={t.id}
            className="u-pop u-toast-in pointer-events-auto flex items-center gap-2.5 rounded-xl py-2.5 pl-3.5 pr-2.5 text-sm text-neutral-200 shadow-xl"
          >
            <Icon size={15} className={`shrink-0 ${ICON_COLOR[t.kind]}`} />
            <span className="max-w-xs">{t.text}</span>
            <button
              onClick={() => dismiss(t.id)}
              className="text-neutral-600 hover:text-neutral-300"
            >
              <X size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

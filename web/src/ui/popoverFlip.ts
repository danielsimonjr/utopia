// An "in-place transform" (FLIP) for top-bar popover panels. The panel
// covers the trigger button's original position. The first frame matches
// the button's real bounds (a 999px border radius), then the next frame
// transitions to the full panel shape, so the button "grows" into the
// panel. Closing reverses this shrink.
//
// **This logic lives in one shared hook**, instead of a separate copy in
// the user menu and the alert bell. These two panels sit next to each
// other, so any small difference in duration or easing is visible after
// clicking each one in turn.
import { useEffect, useLayoutEffect, useRef, useState } from "react";

const OPEN_MS = 260;
const CLOSE_MS = 190;

function reduced(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Returns `{ open, setOpen, close, anchorRef, panelRef }`.
 *
 * `close()` plays the shrink animation, then unmounts the panel. To close
 * immediately, for example after a navigation, call `setOpen(false)` directly.
 * Clicking outside the panel or pressing Esc already closes it, through the listener on `rootRef`.
 */
export function usePopoverFlip<A extends HTMLElement, P extends HTMLElement>(
  /** The anchor corner for the transform. **Set this to match the panel's
   *  actual side**: a panel on the right of the top bar anchors at "top
   *  right". A panel that sits on the left, such as the legend's "+N
   *  classes" panel, needs "top left". Otherwise the panel grows leftward
   *  from the right edge, and looks like it flew in from elsewhere. */
  origin: "top right" | "top left" | "bottom left" = "top right",
) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<A>(null);
  const panelRef = useRef<P>(null);
  const closingRef = useRef(false);

  useLayoutEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const anchor = anchorRef.current;
    if (!panel || !anchor || reduced()) return;
    const a = anchor.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    if (p.width < 1 || p.height < 1) return;
    panel.style.transformOrigin = origin;
    panel.style.transform = `scale(${a.width / p.width}, ${a.height / p.height})`;
    panel.style.borderRadius = "999px";
    panel.style.opacity = "0.35";
    let done: number | undefined;
    const raf = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        panel.style.transition = `transform ${OPEN_MS}ms cubic-bezier(0.16,1,0.3,1), border-radius ${OPEN_MS}ms cubic-bezier(0.16,1,0.3,1), opacity 0.18s ease`;
        panel.style.transform = "scale(1, 1)";
        panel.style.borderRadius = "12px";
        panel.style.opacity = "1";
        // After the animation, **clear the inline styles**; do not leave a
        // `scale(1,1)` transform in place. An identity transform looks
        // harmless, but it still creates a compositing layer, and that
        // shifts absolutely positioned children to the nearest device
        // pixel. At a device pixel ratio of 1.5, that shift is 0.67px.
        // The close button must align exactly with the button that
        // triggered it, and a shift of even one physical pixel is visible.
        done = window.setTimeout(() => {
          panel.style.transition = "";
          panel.style.transform = "";
          panel.style.borderRadius = "";
          panel.style.opacity = "";
          panel.style.transformOrigin = "";
        }, OPEN_MS + 20);
      }),
    );
    return () => {
      cancelAnimationFrame(raf);
      if (done !== undefined) window.clearTimeout(done);
    };
  }, [open, origin]);

  const close = () => {
    const panel = panelRef.current;
    const anchor = anchorRef.current;
    if (closingRef.current) return;
    if (!panel || !anchor || reduced()) {
      setOpen(false);
      return;
    }
    closingRef.current = true;
    panel.style.transformOrigin = origin;
    const a = anchor.getBoundingClientRect();
    // `offsetWidth`/`offsetHeight` measure the layout size and ignore the
    // current transform. `getBoundingClientRect` would return the
    // already-shrunk size, which would shrink further on each call.
    panel.style.transition = `transform ${CLOSE_MS}ms cubic-bezier(0.5,0,0.9,0.4), border-radius ${CLOSE_MS}ms cubic-bezier(0.5,0,0.9,0.4), opacity 0.16s ease`;
    panel.style.transform = `scale(${a.width / panel.offsetWidth}, ${a.height / panel.offsetHeight})`;
    panel.style.borderRadius = "999px";
    panel.style.opacity = "0.3";
    window.setTimeout(() => {
      closingRef.current = false;
      setOpen(false);
    }, CLOSE_MS);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node))
        close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return { open, setOpen, close, rootRef, anchorRef, panelRef };
}

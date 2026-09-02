// UI language: **the viewer sets this directly**, with no round trip to
// the server (see ADR 0004). This works like dark mode. A setting such as
// a concurrency limit describes the deployment; the UI language describes the reader.
//
// This file is the only place that resolves the locale. Every other call
// site, over 600 of them, consumes `S` only and never reads the source.
// A future change, such as following the browser language or adding a
// per-user override, changes only this file, not those 600 call sites.
import { en, type Strings } from "./en";
import { zh } from "./zh";

export type { Strings };

export const LANGS = ["en", "zh"] as const;
export type Lang = (typeof LANGS)[number];

/** Each language name stays in its own language and is never translated.
 *  In the switcher, "中文" is the signpost a non-English reader can recognize. */
export const LANG_NAMES: Record<Lang, string> = { en: "English", zh: "中文" };

const BUNDLES: Record<Lang, Strings> = { en, zh };
const KEY = "utopia.lang";

function detect(): Lang {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && (LANGS as readonly string[]).includes(saved))
      return saved as Lang;
  } catch {
    // In private browsing mode, localStorage can throw. Fall back to
    // English instead of failing the first page render.
  }
  // **This does not follow the browser language.** The Chinese bundle
  // still lags behind the English bundle. Guessing the wrong language
  // costs a Chinese-speaking user an incomplete page, instead of a
  // complete English page. Add the `navigator.language` check back once
  // the `zh` bundle catches up; that change is a single line.
  // A saved user choice still applies (see above), and the switcher stays
  // available in the user menu.
  return "en";
}

export const lang: Lang = detect();

/** The active language bundle. This resolves once, at module load, so
 *  module-level constants such as `const X = S.a.b` also work correctly. */
export const S: Strings = BUNDLES[lang];

/**
 * Switching the language reloads the whole page. It does not remount the app.
 *
 * At least one of the 635 references already evaluates at module load time
 * (`ROLE_OPTIONS` in `Members.tsx`), and more code like this will likely
 * appear later. A remount would leave such code frozen on the old language,
 * **with no error**. A full reload re-evaluates the whole module graph, at
 * the cost of one page refresh. Users switch languages only a few times a year.
 */
export function setLang(next: Lang) {
  if (next === lang) return;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // If the value cannot be saved, the choice applies to this session only. That is better than no effect at all.
  }
  location.reload();
}

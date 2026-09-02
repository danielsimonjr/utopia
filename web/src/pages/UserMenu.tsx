/* User menu: the avatar pill on the right of the top bar, plus its popover
   panel (profile, system administration, sign out).
   The Shell (KB workspace) and AccountShell (account layer) share this component. */
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  BookMarked,
  Check,
  Languages,
  LogOut,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { api, type User } from "../api";
import { usePopoverFlip } from "../ui/popoverFlip";
import { LANGS, LANG_NAMES, S, lang, setLang } from "../i18n";

/** Initials avatar: a neutral gray background (no color bias in the UI
 *  chrome). It uses the first two letters for Latin text, or the first two
 *  characters for CJK text. */
export function Avatar({ name, size = 24 }: { name: string; size?: number }) {
  const trimmed = name.trim();
  const words = trimmed.split(/\s+/).filter(Boolean);
  const initials =
    words.length >= 2
      ? (words[0][0] + words[1][0]).toUpperCase()
      : [...trimmed].slice(0, 2).join("").toUpperCase();
  return (
    <span
      className="inline-grid place-items-center rounded-full bg-white/[0.09] border border-white/10 text-neutral-200 select-none shrink-0"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}
    >
      {initials}
    </span>
  );
}

export function UserMenu({ user }: { user: User }) {
  // In-place FLIP transform: the pill "grows" into the panel. The
  // implementation is shared; see ui/popoverFlip. The alert bell sits right
  // next to this menu, and two separate implementations would drift apart over time.
  const { open, setOpen, close, rootRef, anchorRef, panelRef } =
    usePopoverFlip<HTMLButtonElement, HTMLDivElement>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const go = (to: string) => {
    setOpen(false);
    navigate({ to });
  };

  const logout = async () => {
    await api.logout();
    queryClient.clear();
    navigate({ to: "/login" });
  };

  // Each row spans to the panel edge (the same pattern as Dropdown): the
  // container has no inner padding, and each row sets its own height.
  const item =
    "w-full flex items-center gap-2.5 px-3.5 py-2.5 text-[13px] text-neutral-300 hover:bg-white/[0.06] hover:text-white transition-colors";

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={anchorRef}
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-2 rounded-full py-1 pl-1 pr-3 transition-[background-color,opacity] duration-150 ${
          open ? "opacity-0" : "hover:bg-white/[0.06]"
        }`}
      >
        <Avatar name={user.display_name} size={24} />
        <span className="text-sm text-neutral-300">{user.display_name}</span>
      </button>

      {open && (
        <div
          ref={panelRef}
          className="u-menu-glass absolute right-0 top-0 w-64 rounded-xl shadow-2xl z-50 overflow-hidden"
        >
          {/* Identity header: clicking it again collapses the panel back into the pill. */}
          <div
            onClick={close}
            className="flex items-center gap-3 px-3.5 py-3 border-b border-white/10 cursor-pointer hover:bg-white/[0.04] transition-colors"
          >
            <Avatar name={user.display_name} size={32} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-[13px] font-medium text-neutral-100">
                  {user.display_name}
                </span>
                {user.is_admin && (
                  <span className="u-chip u-chip-neutral !text-[10px] !px-1.5">
                    {S.account.adminChip}
                  </span>
                )}
              </div>
              <div className="truncate text-[11px] text-neutral-500">
                {user.email}
              </div>
            </div>
          </div>

          <div>
            <button onClick={() => go("/account")} className={item}>
              <UserRound size={13} className="text-neutral-500" />
              {S.account.profile}
            </button>
            {/* Visible to every user: all accessible KBs, and the user's role in each. */}
            <button onClick={() => go("/account/kbs")} className={item}>
              <BookMarked size={13} className="text-neutral-500" />
              {S.account.kbsNav}
            </button>
            {user.is_admin && (
              <button onClick={() => go("/admin")} className={item}>
                <ShieldCheck size={13} className="text-neutral-500" />
                {S.account.administration}
              </button>
            )}
          </div>

          {/* UI language: the viewer sets this directly, with no round trip
              to the server (see ADR 0004). Each option label uses **its own
              language**, because a user who cannot read English still needs
              to recognize "中文" as an option. */}
          <div className="border-t border-white/10">
            <div className="flex items-center gap-2.5 px-3.5 pt-2.5 pb-1 text-[11px] text-neutral-500">
              <Languages size={13} className="text-neutral-500" />
              {S.account.language}
            </div>
            {LANGS.map((l) => (
              <button key={l} onClick={() => setLang(l)} className={item}>
                <span className="w-[13px] shrink-0">
                  {l === lang && (
                    <Check size={13} className="text-neutral-400" />
                  )}
                </span>
                {LANG_NAMES[l]}
              </button>
            ))}
          </div>

          <div className="border-t border-white/10">
            <button
              onClick={logout}
              className={`${item} !text-[var(--u-danger)]`}
            >
              <LogOut size={13} />
              {S.nav.signOut}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

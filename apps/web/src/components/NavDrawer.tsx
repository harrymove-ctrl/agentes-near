import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import { Button } from "@agenteschat/ui";
import { useRouterState } from "@tanstack/react-router";
import {
  createContext,
  type ReactNode,
  type TouchEvent,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { openPalette } from "./CommandMenu";
import { useOrg } from "./org-context";
import { MyFace, OrgMark } from "./ProfilePhoto";

/**
 * Breakpoints (layout.css keeps the same numbers):
 * phone ≤ 640px · compact ≤ 760px (sidebar = drawer, panels = full-screen sheets)
 * · tablet 761–1199px (sidebar = icon rail) · desktop ≥ 1200px.
 */
export const PHONE_QUERY = "(max-width: 640px)";
export const COMPACT_QUERY = "(max-width: 760px)";
export const DESKTOP_QUERY = "(min-width: 1200px)";
/** The sidebar's id: the menu buttons control it. */
export const NAV_ID = "app-nav";

/** A CSS media query, live (false where `matchMedia` is missing). */
export function useMediaQuery(query: string) {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
      const list = window.matchMedia(query);
      list.addEventListener?.("change", onChange);
      return () => list.removeEventListener?.("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches,
    () => false,
  );
}

interface NavDrawer {
  /** The sidebar is a drawer (narrow screen). */
  compact: boolean;
  open: boolean;
  show: () => void;
  /** `restoreFocus`: back to the button that opened it (Esc, the scrim), not after navigating. */
  close: (options?: { restoreFocus?: boolean }) => void;
  toggle: () => void;
  /** Handlers for the sidebar: a link closes it; swiping left closes it. */
  navProps: {
    id: string;
    "data-open": boolean;
    tabIndex: -1;
    onClick: (e: { target: EventTarget }) => void;
    onTouchStart: (e: TouchEvent) => void;
    onTouchEnd: (e: TouchEvent) => void;
  };
}

const NavDrawerContext = createContext<NavDrawer | null>(null);

/** The drawer state, or null outside the workspace shell. */
export const useNavDrawer = () => useContext(NavDrawerContext);

/** Swipes shorter than this (px) don't close the drawer. */
const SWIPE = 48;

/**
 * The workspace navigation on narrow screens: the sidebar slides in over the
 * page. Closes on Esc, on the scrim, on a swipe to the left and whenever the
 * page changes; the page behind is inert while it's open.
 */
export function NavDrawerProvider({ children }: { children: ReactNode }) {
  const compact = useMediaQuery(COMPACT_QUERY);
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Where focus goes once the page behind is reachable again.
  const restore = useRef<HTMLElement | null>(null);
  const close = useCallback((options?: { restoreFocus?: boolean }) => {
    restore.current = options?.restoreFocus ? opener.current : null;
    opener.current = null;
    setOpen(false);
  }, []);
  const show = useCallback(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen(true);
  }, []);
  const toggle = useCallback(() => (open ? close({ restoreFocus: true }) : show()), [open, close, show]);

  // A new page closes it (links, the palette, redirects).
  const lastPath = useRef(pathname);
  useEffect(() => {
    if (lastPath.current === pathname) return;
    lastPath.current = pathname;
    setOpen(false);
    opener.current = null;
  }, [pathname]);

  // Wide again: the sidebar is back in the layout.
  useEffect(() => {
    if (!compact) setOpen(false);
  }, [compact]);

  // Esc closes it, before the page sees the key (Esc in a channel would stop an agent). A menu or
  // dialog opened from the drawer closes first.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return;
      e.preventDefault();
      close({ restoreFocus: true });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, close]);

  // Open: focus moves into the navigation, and (as a drawer) the page behind can't be reached.
  useEffect(() => {
    if (!open) return;
    const nav = document.getElementById(NAV_ID);
    nav?.focus({ preventScroll: true });
    const behind =
      compact && nav?.parentElement
        ? Array.from(nav.parentElement.children).filter(
            (el): el is HTMLElement =>
              el !== nav && el instanceof HTMLElement && !el.classList.contains("shell__scrim"),
          )
        : [];
    for (const el of behind) el.inert = true;
    return () => {
      for (const el of behind) el.inert = false;
      const back = restore.current;
      restore.current = null;
      if (back?.isConnected) back.focus();
    };
  }, [open, compact]);

  const value = useMemo<NavDrawer>(
    () => ({
      compact,
      open,
      show,
      close,
      toggle,
      navProps: {
        id: NAV_ID,
        "data-open": open,
        tabIndex: -1,
        onClick: (e) => {
          // Following a link closes it even when the page doesn't change (the current channel).
          if (open && e.target instanceof Element && e.target.closest("a[href]")) close();
        },
        onTouchStart: (e) => {
          const t = e.touches[0];
          touch.current = t ? { x: t.clientX, y: t.clientY } : null;
        },
        onTouchEnd: (e) => {
          const start = touch.current;
          const t = e.changedTouches[0];
          touch.current = null;
          if (!open || !start || !t) return;
          const dx = t.clientX - start.x;
          if (dx < -SWIPE && Math.abs(dx) > Math.abs(t.clientY - start.y)) close();
        },
      },
    }),
    [compact, open, show, close, toggle],
  );
  return <NavDrawerContext.Provider value={value}>{children}</NavDrawerContext.Provider>;
}

/** "Abrir menu": only on narrow screens (the sidebar is always there otherwise). */
export function NavToggle({ className }: { className?: string }) {
  const { t } = useTranslation();
  const drawer = useNavDrawer();
  if (!drawer?.compact) return null;
  return (
    <Button
      variant="ghost"
      iconOnly
      icon="menu"
      className={className ? `nav-toggle ${className}` : "nav-toggle"}
      aria-label={t("shell.openNav")}
      aria-controls={NAV_ID}
      aria-expanded={drawer.open}
      onClick={drawer.toggle}
    />
  );
}

/** Behind the open drawer: dims the page; a tap closes the drawer. */
export function NavScrim() {
  const { t } = useTranslation();
  const drawer = useNavDrawer();
  if (!drawer?.compact || !drawer.open) return null;
  return (
    <button
      type="button"
      className="shell__scrim"
      tabIndex={-1}
      aria-label={t("shell.closeNav")}
      onClick={() => drawer.close({ restoreFocus: true })}
    />
  );
}

/**
 * The top bar on narrow screens: menu, workspace, search. Chat pages hide it
 * (their header carries the menu button instead; see layout.css). A personal
 * workspace shows the person, as its sidebar does on top (ADR 0159).
 */
export function ShellBar() {
  const { t } = useTranslation();
  const { org, me } = useOrg();
  const drawer = useNavDrawer();
  if (!drawer?.compact) return null;
  return (
    <header className="shell__bar">
      <NavToggle />
      <span className="shell__bar-org">
        {isPersonal(org) ? <MyFace size="sm" /> : <OrgMark logo={org.logo} size={22} />}
        <span className="shell__bar-name">{isPersonal(org) ? me.user.name : org.name}</span>
      </span>
      <Button variant="ghost" iconOnly icon="search" aria-label={t("palette.jump")} onClick={openPalette} />
    </header>
  );
}

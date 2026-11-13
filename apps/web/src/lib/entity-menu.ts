import type { KeyboardEvent, MouseEvent } from "react";
import { type MenuEntry, openContextMenu } from "./context-menu";

/**
 * Typing and code keep the browser's menu (spelling, paste, copy). Entity rows that are links (a channel, an agent)
 * still get their own menu, like Slack's sidebar, so this is narrower than `keepsSystemMenu`.
 */
const KEEPS_BROWSER_MENU = "input, textarea, select, [contenteditable='true'], [contenteditable=''], pre, code";
const keepsBrowserMenu = (target: EventTarget | null) =>
  target instanceof Element && Boolean(target.closest(KEEPS_BROWSER_MENU));
// React bubbles events out of portals (dialogs, dropdowns, popovers) to their React parents: only the element's own
// DOM opens its menu.
const outside = (e: { currentTarget: EventTarget; target: EventTarget }) =>
  !(e.currentTarget instanceof Node && e.target instanceof Node && e.currentTarget.contains(e.target));

/** Shift+F10 and the menu key, the system's ways to open a context menu from the keyboard. */
export const opensMenuKey = (e: Pick<KeyboardEvent, "key" | "shiftKey">) =>
  e.key === "ContextMenu" || (e.shiftKey && e.key === "F10");

// Windows and Linux follow the menu key with a `contextmenu` of their own: the menu is already open.
const KEY_ECHO_MS = 500;
let keyed: { el: EventTarget; at: number } | null = null;

/**
 * Right click and the keyboard for something with its own menu (a channel, an agent, a file), in the browser and the
 * desktop app. The innermost one wins; touch keeps its long press (taps have their own menus).
 */
export function entityMenu(build: () => MenuEntry[]) {
  return {
    onContextMenu: (e: MouseEvent) => {
      if (e.defaultPrevented || outside(e) || keepsBrowserMenu(e.target)) return;
      if ((e.nativeEvent as PointerEvent).pointerType === "touch") return;
      if (keyed?.el === e.currentTarget && Date.now() - keyed.at < KEY_ECHO_MS) {
        keyed = null;
        return e.preventDefault();
      }
      const entries = build();
      if (!entries.length) return;
      e.preventDefault();
      openContextMenu(e.clientX, e.clientY, entries, e.target);
    },
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.defaultPrevented || !opensMenuKey(e) || outside(e) || keepsBrowserMenu(e.target)) return;
      const entries = build();
      if (!entries.length) return;
      e.preventDefault();
      keyed = { el: e.currentTarget, at: Date.now() };
      const r = e.currentTarget.getBoundingClientRect();
      openContextMenu(r.left + 12, r.bottom, entries);
    },
  };
}

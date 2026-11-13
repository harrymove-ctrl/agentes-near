import type { IconName } from "@agenteschat/ui";
import type { MouseEvent } from "react";
import { matchesNow, TOUCH } from "@/hooks/useMatchMedia";
import { inDesktopApp } from "./desktop";
import { STORAGE_KEYS, storage } from "./storage";

/**
 * The right click: each screen says what its menu has, once, and this draws it as our menu (`MenuAt`, the default)
 * or, in the desktop app, as the system's own (`context_menu` in apps/desktop/src-tauri/src/menus.rs), as the person
 * chose. In the browser, links and empty space keep the browser's menu.
 */
export type MenuEntry =
  | { kind: "item"; id: string; label: string; icon?: IconName; danger?: boolean; disabled?: boolean; run: () => void }
  | { kind: "header"; label: string }
  | { kind: "separator" }
  | {
      kind: "reactions";
      label: string;
      emojis: readonly string[];
      pick: (emoji: string) => void;
      /** A last cell for every emoji (our menu only). */
      more?: { label: string; run: () => void };
    };

/** Our menu (with icons and the reactions row) or the system's. */
export type MenuLook = "ours" | "system";

/** The reactions at the top of a message's menu. */
export const QUICK_REACTIONS = ["👍", "🎉", "👀", "✅", "❤️"] as const;

const LOOK_EVENT = "agentes:menu-look";
let look: MenuLook = storage.get(STORAGE_KEYS.menuLook) === "system" ? "system" : "ours";

export const menuLook = () => look;
export function setMenuLook(next: MenuLook) {
  look = next;
  storage.set(STORAGE_KEYS.menuLook, next);
  window.dispatchEvent(new Event(LOOK_EVENT));
}
export const onMenuLookChange = (cb: () => void) => {
  window.addEventListener(LOOK_EVENT, cb);
  return () => window.removeEventListener(LOOK_EVENT, cb);
};

/** No separator first, last or twice in a row (entries that didn't apply leave gaps). */
export function tidy(entries: MenuEntry[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const e of entries) {
    if (e.kind === "separator" && (out.length === 0 || out.at(-1)?.kind === "separator")) continue;
    out.push(e);
  }
  while (out.at(-1)?.kind === "separator") out.pop();
  return out;
}

/** What the system's menu gets (menus.rs `ContextItem`), and what each choice runs. */
export type SystemItem =
  | { type: "item"; id: string; label: string; disabled?: boolean }
  | { type: "header"; label: string }
  | { type: "separator" }
  | { type: "submenu"; label: string; items: SystemItem[] };

export function toSystem(entries: MenuEntry[]): { items: SystemItem[]; runs: Map<string, () => void> } {
  const runs = new Map<string, () => void>();
  const items: SystemItem[] = [];
  for (const e of entries) {
    if (e.kind === "item") {
      runs.set(e.id, e.run);
      items.push({ type: "item", id: e.id, label: e.label, ...(e.disabled ? { disabled: true } : {}) });
    } else if (e.kind === "reactions") {
      // The system's menus have no row of emoji: a submenu, like Messages' Tapback.
      const sub = e.emojis.map((emoji, i) => {
        runs.set(`react-${i}`, () => e.pick(emoji));
        return { type: "item" as const, id: `react-${i}`, label: emoji };
      });
      items.push({ type: "submenu", label: e.label, items: sub }, { type: "separator" });
    } else items.push(e.kind === "header" ? { type: "header", label: e.label } : { type: "separator" });
  }
  return { items, runs };
}

/**
 * Where the system's menu keeps its place: typing (spelling, paste) and, in the browser, links, images, video and
 * code (open in a new tab, copy the address, save the image).
 */
export function keepsSystemMenu(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']")) return true;
  return !inDesktopApp() && Boolean(target.closest("a[href], img, video, pre, code"));
}

/** The text selected where the right click landed (empty when the click was elsewhere). */
export function selectedTextAt(target: EventTarget | null): string {
  if (!(target instanceof Node)) return "";
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.containsNode(target, true)) return "";
  return selection.toString().trim();
}

/** Text is being selected inside `el` (a drag, or a selection left there). */
export function selectingIn(el: Node | null): boolean {
  const selection = typeof window.getSelection === "function" ? window.getSelection() : null;
  return !!el && !!selection && !selection.isCollapsed && el.contains(selection.anchorNode);
}

export interface OpenMenu {
  key: number;
  x: number;
  y: number;
  entries: MenuEntry[];
}

type Invoke = (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
const tauriInvoke = (): Invoke | null => {
  const tauri = (window as { __TAURI_INTERNALS__?: { invoke?: Invoke } }).__TAURI_INTERNALS__;
  return typeof tauri?.invoke === "function" ? tauri.invoke : null;
};

let show: ((menu: OpenMenu | null) => void) | null = null;
let seq = 0;
/** The system's menu answers with its token and the chosen id (menus.rs); older menus are ignored. */
let systemToken = 0;
let systemRuns = new Map<string, () => void>();

/** `ContextMenuHost` draws our menu through this. */
export function setMenuHost(host: ((menu: OpenMenu | null) => void) | null) {
  show = host;
  const w = window as { __agentesContextMenu?: (token: string, id: string) => void };
  if (host) {
    w.__agentesContextMenu = (token, id) => {
      if (Number(token) === systemToken) systemRuns.get(id)?.();
    };
  } else delete w.__agentesContextMenu;
}

/**
 * "Report a problem here" (ADR 0160): the last entry of every menu a right click opens, where the server takes
 * feedback. Set by the feedback form's host, with the words in the person's language.
 */
let reporter: { label: string; run: (target: EventTarget, selected: string) => void } | null = null;
export function setMenuReporter(next: typeof reporter) {
  reporter = next;
}

/** `target`: what the right click landed on; with it the menu ends in the report entry. A button's menu has none. */
export function openContextMenu(x: number, y: number, raw: MenuEntry[], target?: EventTarget | null) {
  const report = reporter;
  // Read now: choosing an entry may drop the selection.
  const selected = target ? selectedTextAt(target) : "";
  const entries = tidy(
    target && report
      ? [
          ...raw,
          { kind: "separator" },
          {
            kind: "item",
            id: "feedback.report",
            label: report.label,
            icon: "message",
            run: () => report.run(target, selected),
          },
        ]
      : raw,
  );
  if (!entries.length) return;
  const invoke = tauriInvoke();
  if (look === "system" && invoke) {
    const { items, runs } = toSystem(entries);
    systemToken = ++seq;
    systemRuns = runs;
    // The system couldn't draw it: ours instead, never nothing.
    void invoke("context_menu", { token: systemToken, items }).catch(() => show?.({ key: ++seq, x, y, entries }));
    return;
  }
  show?.({ key: ++seq, x, y, entries });
}

/** Things with their own menu (a message, a channel) get it on right click, in the browser too. */
export const contextMenusOn = () => show !== null;

/**
 * `onContextMenu` for something with its own menu (a message, a channel): the innermost one wins, and
 * typing or selected text keep the system's menu.
 */
export function contextMenuHandler(build: (e: MouseEvent) => MenuEntry[]) {
  return (e: MouseEvent) => {
    if (e.defaultPrevented || !contextMenusOn() || keepsSystemMenu(e.target)) return;
    // A long press on touch fires `contextmenu` too: it keeps selecting text (taps have their own menu).
    if ((e.nativeEvent as PointerEvent).pointerType === "touch" || matchesNow(TOUCH)) return;
    const entries = build(e);
    if (!entries.length) return;
    e.preventDefault();
    openContextMenu(e.clientX, e.clientY, entries, e.target);
  };
}

/** Copies `text` and says so (the toast's words come from the caller). */
export async function copyText(text: string, done: () => void) {
  try {
    await navigator.clipboard?.writeText(text);
    done();
  } catch {
    // Clipboard refused: nothing copied, nothing said.
  }
}

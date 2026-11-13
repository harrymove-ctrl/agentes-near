import HELPER_SOURCE from "./desktop-helper.py" with { type: "text" };

/**
 * The desktop helper (ADR 0062 §9): `desktop-helper.py`, one per agent
 * desktop, run as the agent's OS user. It reads the desktop's accessibility
 * tree (AT-SPI), sends input (xdotool) and takes screenshots (scrot), and
 * speaks JSON lines: one request per line on its stdin, one reply per line on
 * its stdout, nothing anywhere else. These are its requests and replies.
 *
 * - It runs from its source in an argument: agents' homes are 0700, so no
 *   file of the runner's is there for the agent's user to read, and `-I`
 *   keeps that user's own site-packages and `.pth` files (code Python runs
 *   at start) out.
 * - Text to type goes in a request, never in an argument (`ps` shows those):
 *   the helper hands it to xdotool on stdin, or pastes it.
 * - The source stays ASCII and under Linux's 128 KiB for one argument; its
 *   test checks both.
 */

/** `python3 -I -c <source>`: the command that starts a helper (as the agent, after its launcher). */
export function helperCommand(python = "python3"): string[] {
  return [python, "-I", "-c", HELPER_SOURCE];
}

/**
 * What the helper's environment needs besides DISPLAY, XAUTHORITY, HOME and
 * PATH: a UTF-8 locale. Without one, xdotool drops every accented letter.
 */
export const HELPER_ENV = { LANG: "C.UTF-8", LC_ALL: "C.UTF-8" } as const;

/** The most text the helper reads of one element (`textMax`'s default and cap; `TEXT_MAX` in the `.py`). */
export const HELPER_TEXT_MAX = 4000;

/** An app's root on the accessibility bus: its windows are its children. */
export const HELPER_ROOT_PATH = "/org/a11y/atspi/accessible/root";

/** An element: its app's connection on the accessibility bus, and its object path. */
export type HelperNodeRef = [bus: string, path: string];
/** Screen pixels. */
export type HelperBox = [x: number, y: number, width: number, height: number];
export interface HelperRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HelperHello {
  /** Null when the display can't be opened (`problem` says why). */
  screen: [width: number, height: number] | null;
  /** The accessibility bus answers. */
  a11y: boolean;
  /** The display reports changes (XDamage): settling works by events. */
  damage: boolean;
  python: string;
  xdotool: boolean;
  scrot: boolean;
  /** Debian packages to install: xdotool, scrot, python3-gi, python3-xlib. */
  missing: string[];
  /** Why there is no screen or accessibility bus, for people. */
  problem?: string;
}

/** A window on the screen (`snapshot.windows`, bottom to top). */
export interface HelperWindow {
  /** The client window's id: what `activate` takes. */
  xid: number;
  /** Its place in the stack, 0 at the bottom. */
  stack: number;
  active: boolean;
  /** Override-redirect (menus, tooltips, notifications): the window manager doesn't list or frame them. */
  override: boolean;
  /** WM_CLASS. */
  class: [instance: string, name: string];
  title: string;
  pid: number | null;
  /** The frame, decorations included: what it covers. */
  box: HelperBox;
  /** `_NET_WM_WINDOW_TYPE`s without the prefix, lowercased: normal, dialog, dock, desktop, popup_menu, tooltip, notification… */
  types: string[];
}

/** An element of an app's accessibility tree, as `Cache.GetItems` has it. */
export interface HelperNode {
  path: string;
  /** Null for the app's root. */
  parent: string | null;
  /** Its index among its parent's children; -1 when the app doesn't say. */
  index: number;
  /** -1 when the app doesn't say. */
  children: number;
  /** The role's name as the desktop's AT-SPI names it ("button" or "push button", "menu item", "terminal", "text"…). */
  role: string;
  name: string;
  /** AT-SPI state bits: the low word (SHOWING is 1 << 25), then the high one. */
  states: [low: number, high: number];
  /** Interface names without `org.a11y.atspi.`: Component, Text, EditableText, Action… */
  ifaces: string[];
  /** On the screen, for showing elements with a Component. */
  box?: HelperBox;
  /** Showing terminals', entries' and texts' text, capped: a terminal's last characters, a field's first. Never a password field's. */
  text?: string;
}

export interface HelperApp {
  bus: string;
  pid: number | null;
  /** Its root's name ("Thunar", "xfce4-panel"). */
  name: string;
  nodes?: HelperNode[];
  /** Why there are no nodes: "no tree" (the app keeps no cache, as Qt's), "didn't answer". */
  error?: string;
}

export interface HelperSnapshot {
  screen: [width: number, height: number];
  windows: HelperWindow[];
  /** `front`: the apps of the active window, of the windows above it and of the panels; `all`: every app. */
  apps: HelperApp[];
  ms: number;
}

/** One input step. Points are screen pixels; a step's checks are the runner's, the helper refuses only malformed ones. */
export type HelperStep =
  | { move: [x: number, y: number] }
  | { click: [x: number, y: number]; button?: 1 | 2 | 3; count?: 1 | 2 | 3 }
  | { drag: [x1: number, y1: number, x2: number, y2: number] }
  /** X key names joined by `+`: `ctrl+s`, `Return`, `alt+F4`. */
  | { key: string }
  /** As keys (printable ASCII, newlines, tabs) or pasted (anything else), in order. */
  | { type: string }
  /** The element's whole text, set through EditableText and read back (`mismatch` when it differs). */
  | { fill: HelperNodeRef; text: string }
  /** Wheel clicks over the point: dy > 0 down, dx > 0 right. */
  | { scroll: [x: number, y: number]; dx?: number; dy?: number }
  | { activate: number }
  /** A desktop entry id (`thunar.desktop`), started with the session's environment. */
  | { launch: string }
  /** An absolute path, opened with its app. */
  | { open: string }
  | { pause: number };

/**
 * After the steps, wait for the screen to settle (XDamage, tiles that were
 * already changing ignored): quiet `quietMs` after the first change, or no
 * change within `lateMs`, at most `capMs`. With `windowMs`, a new window or a
 * change of the active one is waited for first (an app starting).
 */
export interface HelperSettle {
  lateMs?: number;
  quietMs?: number;
  capMs?: number;
  windowMs?: number;
}

export interface HelperAppEntry {
  /** The desktop entry id, what `launch` takes. */
  id: string;
  name: string;
  generic: string | null;
  keywords: string[];
}

export interface HelperRequests {
  hello: Record<string, never>;
  /** `textMax`: per element, 0 for none (default 4,000). `skip`: pids whose trees aren't read (the agent browser's). */
  snapshot: { scope?: "front" | "all"; textMax?: number; skip?: number[] };
  extents: { nodes: HelperNodeRef[] };
  input: { steps: HelperStep[]; settle?: HelperSettle };
  /** JPEG at `quality` (default 70), of the screen or a region of it. */
  capture: { region?: HelperRegion; quality?: number };
  apps: Record<string, never>;
}

export interface HelperReplies {
  hello: HelperHello;
  snapshot: HelperSnapshot;
  /** Keyed `"<bus> <path>"`; null for an element that's gone. And the windows as they are now, bottom to top. */
  extents: { boxes: Record<string, HelperBox | null>; windows: HelperWindow[] };
  /** `settled` and `changed` when it settled: false `settled` means the cap ended the wait. */
  input: { ms: number; settled?: boolean; changed?: boolean };
  /** `jpeg` in base64; the region as taken, kept inside the screen. */
  capture: { jpeg: string; width: number; height: number; region: HelperRegion | null };
  apps: HelperAppEntry[];
}

export type HelperOp = keyof HelperRequests;
export type HelperRequest = { [K in HelperOp]: { id: number; op: K } & HelperRequests[K] }[HelperOp];

/**
 * - `bad_request`: malformed (the runner's bug, not the agent's).
 * - `unavailable`: no display, no accessibility bus, a missing tool.
 * - `stale`: the element is gone.
 * - `failed`: the action didn't happen (the tool failed, nothing took a paste, the app didn't start).
 * - `mismatch`: a field's text didn't come out as written.
 * - `stopped`: SIGUSR1 (a person took control) ended an `input` at its next key or step.
 */
export type HelperErrorCode = "bad_request" | "unavailable" | "stale" | "failed" | "mismatch" | "stopped" | "internal";

export type HelperReply<K extends HelperOp = HelperOp> =
  | { id: number; ok: true; data: HelperReplies[K] }
  | { id: number | null; ok: false; code: HelperErrorCode; error: string };

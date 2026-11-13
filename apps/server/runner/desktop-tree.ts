import { type BrowserCaptureMark, DESKTOP_AGENT_BROWSER } from "@agenteschat/adapters/machine-protocol";
import {
  HELPER_ROOT_PATH,
  HELPER_TEXT_MAX,
  type HelperApp,
  type HelperBox,
  type HelperNode,
  type HelperNodeRef,
  type HelperSnapshot,
  type HelperWindow,
} from "./desktop-helper";

/**
 * The agent's desktop as screen text (ADR 0062 §4): a helper snapshot (the
 * windows from XQueryTree, each app's accessibility tree) as lines like
 * `agent-browser`'s, which the engine's `observeSnapshot` reads:
 *
 *   - toolbar "Panel"
 *     - button "Applications" [pressed, ref=e1]
 *     - button "agent - Thunar" [window, active, ref=e2]
 *   - menu "Applications"
 *     - menuitem "Terminal Emulator" [ref=e3]
 *   - window "agent - Thunar" [active, ref=e4]
 *     - textbox [focused, ref=e5]: "/home/agent/"
 *
 * - Only what shows: nodes that aren't showing, have no size, lie outside
 *   their window, a scrolled pane or the screen, or whose center a window
 *   above covers (tooltips never do) are left out.
 * - Every name and text comes from the screen, window titles too (a web page
 *   sets its window's), so each is redacted (the agent's delivered secrets),
 *   written on one quoted line with `\` and `"` escaped, and `ref=` in it is
 *   broken: no text can pass for an element's ref.
 * - An element keeps its ref across looks (`desktopRefs`, one per desktop).
 */

/** AT-SPI states (`AtspiStateType`): bit n of the first word, or bit n - 32 of the second. */
const STATE = {
  CHECKED: 4,
  EDITABLE: 7,
  ENABLED: 8,
  EXPANDABLE: 9,
  EXPANDED: 10,
  FOCUSED: 12,
  MULTI_LINE: 17,
  PRESSED: 20,
  SELECTED: 23,
  SENSITIVE: 24,
  SHOWING: 25,
  INDETERMINATE: 32,
  IS_DEFAULT: 39,
} as const;

const has = (n: HelperNode, bit: number) => ((bit < 32 ? n.states[0] >>> bit : n.states[1] >>> (bit - 32)) & 1) === 1;

/** AT-SPI role names (older and newer at-spi2 spellings) as one-word roles. */
const ROLES: Record<string, string> = {
  button: "button",
  "push button": "button",
  "push button menu": "button",
  "toggle button": "button",
  "menu item": "menuitem",
  "tearoff menu item": "menuitem",
  "check menu item": "menuitemcheckbox",
  "radio menu item": "menuitemradio",
  menu: "menu",
  "popup menu": "menu",
  "menu bar": "menubar",
  "tool bar": "toolbar",
  "check box": "checkbox",
  switch: "switch",
  "radio button": "radio",
  "combo box": "combobox",
  "password text": "textbox",
  "spin button": "spinbutton",
  slider: "slider",
  "page tab": "tab",
  list: "list",
  "list box": "list",
  "list item": "listitem",
  table: "table",
  "tree table": "table",
  tree: "tree",
  "table row": "row",
  "table cell": "cell",
  "column header": "columnheader",
  "table column header": "columnheader",
  "row header": "rowheader",
  "table row header": "rowheader",
  "tree item": "treeitem",
  link: "link",
  heading: "heading",
  label: "text",
  static: "text",
  caption: "text",
  "accelerator label": "text",
  statusbar: "status",
  "status bar": "status",
  "info bar": "status",
  notification: "alert",
  alert: "alertdialog",
  dialog: "dialog",
  "file chooser": "dialog",
  "font chooser": "dialog",
  "color chooser": "dialog",
  frame: "window",
  window: "window",
  "progress bar": "progressbar",
  "level bar": "meter",
  image: "img",
  icon: "img",
  "document web": "document",
  "document frame": "document",
  "document text": "document",
  "document email": "document",
  "document spreadsheet": "document",
  "document presentation": "document",
  paragraph: "paragraph",
  terminal: "terminal",
  form: "form",
  article: "article",
  landmark: "region",
};

/** Containers that only lay things out: no line of their own (a named one is a group), their children in their place. */
const LAYOUT = new Set([
  "panel",
  "filler",
  "section",
  "grouping",
  "scroll pane",
  "viewport",
  "split pane",
  "layered pane",
  "glass pane",
  "root pane",
  "option pane",
  "internal frame",
  "html container",
  "embedded",
  "redundant object",
  "unknown",
  "directory pane",
  "page",
  "page tab list",
]);
/** Nothing in them to read or act on. */
const SKIPPED = new Set(["separator", "scroll bar", "tool tip", "title bar", "invalid", "desktop icon"]);
/** What scrolls inside them is cut at their edges. */
const CLIPS = new Set(["scroll pane", "viewport"]);
/** Roles an agent acts on: each gets a ref. */
const ELEMENTS = new Set([
  "button",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "checkbox",
  "switch",
  "radio",
  "combobox",
  "textbox",
  "spinbutton",
  "slider",
  "tab",
  "listitem",
  "cell",
  "treeitem",
  "link",
  "terminal",
  "columnheader",
  "rowheader",
]);
const WINDOW_LINES = new Set(["window", "dialog", "alertdialog"]);
const CHECKABLE = new Set(["checkbox", "switch", "radio", "menuitemcheckbox", "menuitemradio"]);
const SELECTABLE = new Set(["tab", "listitem", "cell", "treeitem", "row"]);
const MENUS = new Set(["menu", "popup menu"]);

/** Text one window's lines carry at most; a terminal keeps its last lines. */
export const WINDOW_TEXT_MAX = 4000;
/** An element larger than this share of the screen is an area, not a control: no mark to land a point on. */
const MARK_MAX_SHARE = 0.25;
/** How far from a popup its opener may sit (shadows and borders). */
const OPENER_GAP = 8;

/** One element of a look, to act on it later. */
export interface DesktopTarget {
  role: string;
  name: string;
  /** Its visible part when the look was taken, in screen pixels. */
  box: HelperBox;
  /** Its whole box as its app (or the window manager) gave it then: a fresh one that differs means it moved. */
  extents: HelperBox;
  /** A checkbox, switch or radio: whether it was checked. */
  checked?: boolean;
  /** The element on the accessibility bus; a window's own line has none. */
  node?: HelperNodeRef;
  /** The window it stands for (a window's line, a panel's button for a window): what `activate` takes. */
  xid?: number;
  /** The X window it is drawn in: whatever is stacked above that one covers it. */
  window: number;
  /** Its app's name on the accessibility bus (`xfce4-panel`, `Thunar`), else its window's class. */
  app: string;
  /** It takes text through EditableText. */
  editable?: boolean;
}

export interface DesktopLook {
  /** The screen as lines, for `observeSnapshot`. */
  snapshot: string;
  refs: Record<string, { role: string; name: string }>;
  /** `desktop://<app>/<main|dialog>`: the app in front, and whether its window is a dialog. */
  address: string;
  /** The active window's title. */
  title: string;
  screen: { width: number; height: number };
  /** Elements and their boxes, to land a point found on a screenshot on an element. */
  marks: BrowserCaptureMark[];
  targets: Record<string, DesktopTarget>;
}

export interface DesktopLookOptions {
  /** The agent browser's processes: their windows are one line, since `browser_do` drives them. */
  browserPids?: readonly number[];
  /** The agent's delivered secrets (`agentSecrets`): names and text are redacted before they leave the computer. */
  secrets?: { redact(text: string): string; hold: number } | null;
  /** The snapshot's `textMax`: a text this long was cut by the helper. */
  textMax?: number;
}

/** A desktop's refs: an element keeps its ref across looks, and a ref never names another element. */
export type DesktopRefs = (key: string) => string;

/** The key a window's own line has in `DesktopRefs` (an element's is its bus and path). */
export const windowKey = (xid: number) => `x${xid}`;

/**
 * The refs of one desktop session. `numbered` counts every ref the agent was given: a session that
 * starts again (its elements' keys may come back for other elements) numbers after them, so a number
 * the agent kept from before is stale, never another element.
 */
export function desktopRefs(numbered = { last: 0 }): DesktopRefs {
  // ponytail: holds every element the desktop session showed; prune keys unseen for many looks if sessions grow huge.
  const known = new Map<string, string>();
  return (key) => {
    let ref = known.get(key);
    if (!ref) {
      ref = `e${++numbered.last}`;
      known.set(key, ref);
    }
    return ref;
  };
}

export type Point = [x: number, y: number];

const valid = (b: HelperBox | undefined): b is HelperBox => !!b && b[2] > 0 && b[3] > 0;
export const centerOf = (b: HelperBox): Point => [b[0] + b[2] / 2, b[1] + b[3] / 2];
export const contains = (b: HelperBox, [x, y]: Point) => x >= b[0] && x < b[0] + b[2] && y >= b[1] && y < b[1] + b[3];
const NOWHERE: HelperBox = [0, 0, 0, 0];

export function intersect(a: HelperBox, b: HelperBox): HelperBox {
  const x = Math.max(a[0], b[0]);
  const y = Math.max(a[1], b[1]);
  const right = Math.min(a[0] + a[2], b[0] + b[2]);
  const bottom = Math.min(a[1] + a[3], b[1] + b[3]);
  return right > x && bottom > y ? [x, y, right - x, bottom - y] : NOWHERE;
}
const meets = (a: HelperBox, b: HelperBox) => intersect(a, b)[2] > 0;

/** How much two boxes are the same one: their intersection over their union. */
function overlap(a: HelperBox, b: HelperBox): number {
  const i = intersect(a, b);
  const shared = i[2] * i[3];
  return shared / (a[2] * a[3] + b[2] * b[3] - shared);
}

/**
 * The window covering a point of `own` (windows bottom to top): the topmost
 * one stacked above it that holds the point. Tooltips never count: they go
 * when the pointer moves.
 */
export function coveringWindow(windows: readonly HelperWindow[], own: HelperWindow, point: Point): HelperWindow | null {
  for (let i = windows.length - 1; i >= 0; i--) {
    const w = windows[i] as HelperWindow;
    if (w.xid === own.xid) return null;
    if (!w.types.includes("tooltip") && contains(w.box, point)) return w;
  }
  return null;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: they are what a line of screen text can't hold
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
/** Screen text on one line: control characters (newlines too) as spaces, `ref=` broken so nothing reads it as a ref. */
const flat = (s: string) => s.replace(CONTROL, " ").replace(/(ref)=/gi, "$1 =");
export const quote = (s: string) => `"${s.replace(/[\\"]/g, "\\$&")}"`;

/** A name or title from the screen as the agent may read it: redacted, on one line, `ref=` broken. */
export const screenText = (raw: string, secrets?: DesktopLookOptions["secrets"]) =>
  flat(secrets ? secrets.redact(raw) : raw)
    .replace(/\s+/g, " ")
    .trim();
/** A window's class as an address host: `Xfce4-terminal` → `xfce4-terminal`. */
const hostOf = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "") || "desktop";

interface Line {
  depth: number;
  role: string;
  /** Already one line, redacted; quoted when written. */
  name: string;
  attrs: string[];
  /** Screen text after the colon, quoted when written. */
  value?: string;
  /** Our own words after the colon (never screen text). */
  note?: string;
  target?: Omit<DesktopTarget, "role" | "name"> & { key: string };
}

interface Tree {
  app: HelperApp;
  kids: Map<string, HelperNode[]>;
}

interface Context {
  tree: Tree;
  /** The X window the tree's top-level is. */
  win: HelperWindow;
  clip: HelperBox;
  /** Some ancestor is a menu: its items may be drawn in a popup of their own. */
  underMenu: boolean;
  /** The role of the line the node's lines go under. */
  parent: string;
  inDock: boolean;
  budget: { left: number };
  seen: Set<string>;
}

/** Children in reading order: their place among siblings when the app says, else top to bottom, left to right. */
function inOrder(kids: HelperNode[]): HelperNode[] {
  if (kids.every((k) => k.index >= 0)) return [...kids].sort((a, b) => a.index - b.index);
  const at = (k: HelperNode) => (valid(k.box) ? k.box : null);
  return [...kids].sort((a, b) => {
    const pa = at(a);
    const pb = at(b);
    if (!pa || !pb) return pa ? -1 : pb ? 1 : 0;
    return pa[1] - pb[1] || pa[0] - pb[0];
  });
}

/** The line role a node takes, or null for a container that only lays things out. */
function roleOf(n: HelperNode): string | null {
  if (n.role === "text" || n.role === "entry") return has(n, STATE.EDITABLE) ? "textbox" : "text";
  if (LAYOUT.has(n.role)) return n.name.trim() ? "group" : null;
  return ROLES[n.role] ?? (n.role.replace(/[^a-z]/gi, "").toLowerCase() || null);
}

/** The helper's snapshot as the agent's look: lines, refs, the address and title, marks and targets. */
export function desktopLook(snap: HelperSnapshot, refOf: DesktopRefs, options: DesktopLookOptions = {}): DesktopLook {
  const [width, height] = snap.screen;
  const screen: HelperBox = [0, 0, width, height];
  const secrets = options.secrets ?? null;
  const redact = (s: string) => (secrets ? secrets.redact(s) : s);
  const textMax = options.textMax ?? HELPER_TEXT_MAX;
  const browser = new Set(options.browserPids ?? []);
  const windows = snap.windows;
  const activeAt = windows.findIndex((w) => w.active);
  const nameOf = (raw: string) => screenText(raw, secrets);
  const appWindows = windows.filter((w) => !w.override && !w.types.some((t) => t === "dock" || t === "desktop"));

  // Each X window's top-levels: its app's windows on the bus, matched by process and box.
  const topsOf = new Map<number, { tree: Tree; top: HelperNode }[]>();
  for (const app of snap.apps) {
    if (!app.nodes || (app.pid !== null && browser.has(app.pid))) continue;
    const tree: Tree = { app, kids: new Map() };
    for (const n of app.nodes) {
      if (n.parent === null) continue;
      const list = tree.kids.get(n.parent) ?? [];
      list.push(n);
      tree.kids.set(n.parent, list);
    }
    for (const top of tree.kids.get(HELPER_ROOT_PATH) ?? []) {
      if (!has(top, STATE.SHOWING) || !valid(top.box)) continue;
      let best: HelperWindow | null = null;
      let score = 0.5;
      for (const w of windows) {
        if (w.pid !== null && app.pid !== null && w.pid !== app.pid) continue;
        const s = overlap(top.box, w.box);
        if (s > score) [best, score] = [w, s];
      }
      if (best) topsOf.set(best.xid, [...(topsOf.get(best.xid) ?? []), { tree, top }]);
    }
  }
  // A panel's button stands for the window with its title. Two windows with one title (two terminals in
  // one folder) leave their buttons plain: the panel knows which is which, the title doesn't.
  const titled = new Map<string, HelperWindow | null>();
  for (const w of appWindows) if (w.title) titled.set(w.title, titled.has(w.title) ? null : w);

  /** The window an element is drawn in: a menu's items may be in a popup of their app, above the menu's window. */
  const drawnIn = (point: Point, ctx: Context): HelperWindow => {
    if (!ctx.underMenu) return ctx.win;
    const from = windows.indexOf(ctx.win);
    for (let i = windows.length - 1; i > from; i--) {
      const w = windows[i] as HelperWindow;
      if (w.override && w.pid === ctx.tree.app.pid && contains(w.box, point)) return w;
    }
    return ctx.win;
  };

  /** A text's lines that fit the window's budget: a terminal's last ones, anything else's first. */
  const textLines = (n: HelperNode, budget: { left: number }): string[] => {
    let raw = n.text ?? "";
    // The helper cut a text this long: a secret may be cut in half at the edge, where redaction can't see it.
    if (raw.length >= textMax && secrets && secrets.hold > 0) {
      raw = n.role === "terminal" ? raw.slice(secrets.hold) : raw.slice(0, -secrets.hold);
    }
    const all = redact(raw)
      .split("\n")
      .map((l) => flat(l).trimEnd())
      .filter((l) => l.trim() !== "");
    const out: string[] = [];
    const fromEnd = n.role === "terminal";
    for (const l of fromEnd ? all.reverse() : all) {
      if (budget.left <= 0) break;
      const kept = l.length <= budget.left ? l : fromEnd ? l.slice(l.length - budget.left) : l.slice(0, budget.left);
      budget.left -= kept.length;
      out.push(kept);
    }
    return fromEnd ? out.reverse() : out;
  };

  const render = (n: HelperNode, depth: number, ctx: Context): Line[] => {
    if (SKIPPED.has(n.role) || !has(n, STATE.SHOWING) || ctx.seen.has(n.path)) return [];
    ctx.seen.add(n.path);
    let role = roleOf(n);
    // A menu's own unnamed list of items, right under the menu's line, adds nothing.
    if (role === "menu" && !n.name.trim() && ctx.parent === "menu") role = null;
    const box = valid(n.box) ? n.box : null;
    const center = box ? centerOf(box) : null;
    const own = center ? drawnIn(center, ctx) : ctx.win;
    const clip = own === ctx.win ? ctx.clip : intersect(own.box, screen);
    const visible = !!center && contains(clip, center) && coveringWindow(windows, own, center) === null;

    const childCtx: Context = {
      ...ctx,
      clip: CLIPS.has(n.role) && box ? intersect(ctx.clip, box) : ctx.clip,
      underMenu: ctx.underMenu || MENUS.has(n.role),
      parent: role ?? ctx.parent,
    };
    const below = role === null ? depth : depth + 1;
    const children = inOrder(ctx.tree.kids.get(n.path) ?? []).flatMap((k) => render(k, below, childCtx));
    if (role === null) return children;

    const name = nameOf(n.name);
    const window = ctx.inDock && n.role === "toggle button" ? (titled.get(n.name) ?? undefined) : undefined;
    const element = ELEMENTS.has(role) || (role === "menu" && !!name) || n.ifaces.includes("EditableText");
    if (!visible) {
      if (children.length === 0) return [];
      // Hidden or covered itself, a named node still says where its visible children are; else they take its place.
      if (name) return [{ depth, role, name, attrs: [] }, ...children];
      for (const c of children) c.depth--;
      return children;
    }
    if (!element && !name && children.length === 0 && !n.text) return [];

    const attrs: string[] = [];
    if (window) {
      attrs.push("window");
      if (window.active) attrs.push("active");
    } else if (n.role === "toggle button" && (has(n, STATE.CHECKED) || has(n, STATE.PRESSED))) attrs.push("pressed");
    if (CHECKABLE.has(role) && has(n, STATE.INDETERMINATE)) attrs.push("mixed");
    else if (CHECKABLE.has(role) && has(n, STATE.CHECKED)) attrs.push("checked");
    if (SELECTABLE.has(role) && has(n, STATE.SELECTED)) attrs.push("selected");
    if (has(n, STATE.EXPANDABLE)) attrs.push(has(n, STATE.EXPANDED) ? "expanded" : "collapsed");
    if (n.role === "password text") attrs.push("password");
    if (has(n, STATE.FOCUSED)) attrs.push("focused");
    if (has(n, STATE.IS_DEFAULT)) attrs.push("default");
    // GTK3 and Qt set both; GTK4 sets only SENSITIVE.
    if (element && !has(n, STATE.ENABLED) && !has(n, STATE.SENSITIVE)) attrs.push("disabled");

    const line: Line = { depth, role, name, attrs };
    const lines = [line];
    // Never a password field's text, whatever the helper sent.
    if (n.text && n.role !== "password text") {
      if (n.role === "terminal" || role === "text" || has(n, STATE.MULTI_LINE)) {
        lines.push(...textLines(n, ctx.budget).map((t) => ({ depth: depth + 1, role: "text", name: t, attrs: [] })));
      } else {
        const value = textLines(n, ctx.budget).join(" ");
        if (value) line.value = value;
      }
    }
    if (element && box) {
      line.target = {
        key: `${ctx.tree.app.bus} ${n.path}`,
        box: intersect(box, clip),
        extents: box,
        ...(CHECKABLE.has(role) ? { checked: has(n, STATE.CHECKED) } : {}),
        node: [ctx.tree.app.bus, n.path],
        window: own.xid,
        app: ctx.tree.app.name || ctx.win.class[1],
        ...(window ? { xid: window.xid } : {}),
        ...(n.ifaces.includes("EditableText") ? { editable: true } : {}),
      };
    }
    // A label that only repeats its element's name (GTK4's buttons hold one).
    const echoes = (c: Line) => c.depth === depth + 1 && c.role === "text" && c.name === name && !c.target;
    return [...lines, ...(element && name ? children.filter((c) => !echoes(c)) : children)];
  };

  /** A popup menu with no name is named after what opened it: a pressed button or menu of its app next to it. */
  const openerOf = (tree: Tree, popup: HelperWindow): string => {
    const near: HelperBox = [
      popup.box[0] - OPENER_GAP,
      popup.box[1] - OPENER_GAP,
      popup.box[2] + 2 * OPENER_GAP,
      popup.box[3] + 2 * OPENER_GAP,
    ];
    for (const n of tree.app.nodes ?? []) {
      const opened =
        (n.role === "toggle button" && (has(n, STATE.CHECKED) || has(n, STATE.PRESSED))) ||
        (MENUS.has(n.role) && (has(n, STATE.SELECTED) || has(n, STATE.EXPANDED)));
      if (opened && n.name.trim() && valid(n.box) && !titled.has(n.name) && meets(n.box, near)) {
        return nameOf(n.name);
      }
    }
    return "";
  };

  /** A window's lines: its top-levels' children, with one text budget for the window. */
  const contentOf = (win: HelperWindow, parent: string, inDock = false) => {
    const budget = { left: WINDOW_TEXT_MAX };
    const clip = intersect(win.box, screen);
    return (topsOf.get(win.xid) ?? []).flatMap(({ tree, top }) => {
      const ctx: Context = { tree, win, clip, underMenu: false, parent, inDock, budget, seen: new Set([top.path]) };
      return inOrder(tree.kids.get(top.path) ?? []).flatMap((k) => render(k, 1, ctx));
    });
  };

  const out: Line[] = [];
  // The panels first, top to bottom: they are always there.
  const docks = windows.filter((w) => w.types.includes("dock"));
  docks.sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]);
  for (const dock of docks) {
    const content = contentOf(dock, "toolbar", true);
    if (content.length > 0) out.push({ depth: 0, role: "toolbar", name: "Panel", attrs: [] }, ...content);
  }
  // Then the windows, front to back.
  for (let i = windows.length - 1; i >= 0; i--) {
    const w = windows[i] as HelperWindow;
    if (w.types.some((t) => t === "dock" || t === "desktop" || t === "tooltip")) continue;
    const title = nameOf(w.title);
    if (w.pid !== null && browser.has(w.pid)) {
      if (!w.override) out.push({ depth: 0, role: "window", name: title, attrs: [DESKTOP_AGENT_BROWSER] });
      continue;
    }
    const first = topsOf.get(w.xid)?.[0];
    if (w.override) {
      // A popup: a menu, a list, a notification. Only its app's tree says what it shows.
      if (!first) continue;
      const menu = (first.tree.kids.get(first.top.path) ?? []).some((k) => MENUS.has(k.role));
      const role = menu ? "menu" : (roleOf(first.top) ?? "group");
      const content = contentOf(w, role);
      if (content.length === 0) continue;
      const name = nameOf(first.top.name) || (menu ? openerOf(first.tree, w) : "");
      out.push({ depth: 0, role, name, attrs: [] }, ...content);
      continue;
    }
    const mapped = first ? ROLES[first.top.role] : undefined;
    const role =
      mapped === "dialog" || mapped === "alertdialog" ? mapped : w.types.includes("dialog") ? "dialog" : "window";
    const name = title || (first ? nameOf(first.top.name) : "") || nameOf(w.class[1]);
    const content = contentOf(w, role);
    const line: Line = {
      depth: 0,
      role,
      name,
      attrs: w.active ? ["active"] : [],
      target: {
        key: windowKey(w.xid),
        box: intersect(w.box, screen),
        extents: w.box,
        xid: w.xid,
        window: w.xid,
        app: first?.tree.app.name || w.class[1],
      },
    };
    // In front, a window with nothing read: its app keeps no tree, or didn't answer.
    if (content.length === 0 && i >= activeAt) {
      const app = snap.apps.find((a) => a.pid !== null && a.pid === w.pid);
      line.note = `${app?.error === "didn't answer" ? "its app didn't answer" : "nothing readable"}: find targets on the screen image`;
    }
    out.push(line, ...content);
  }

  // Refs in reading order, the text, and what the runner keeps to act on them.
  const refs: DesktopLook["refs"] = {};
  const targets: DesktopLook["targets"] = {};
  const marks: BrowserCaptureMark[] = [];
  const text = out.map((l) => {
    const attrs = [...l.attrs];
    if (l.target) {
      const { key, ...target } = l.target;
      const ref = refOf(key);
      attrs.push(`ref=${ref}`);
      refs[ref] = { role: l.role, name: l.name };
      targets[ref] = { role: l.role, name: l.name, ...target };
      const [x, y, w, h] = target.box;
      if (!WINDOW_LINES.has(l.role) && w * h > 0 && w * h <= width * height * MARK_MAX_SHARE) {
        marks.push({
          ref,
          number: Number(ref.slice(1)),
          role: l.role,
          ...(l.name ? { name: l.name } : {}),
          box: { x, y, width: w, height: h },
        });
      }
    }
    const after = l.value !== undefined ? `: ${quote(l.value)}` : l.note ? `: ${l.note}` : "";
    return `${"  ".repeat(l.depth)}- ${l.role}${l.name ? ` ${quote(l.name)}` : ""}${attrs.length > 0 ? ` [${attrs.join(", ")}]` : ""}${after}`;
  });

  const active = activeAt >= 0 ? (windows[activeAt] as HelperWindow) : null;
  const activeRole = active ? ROLES[topsOf.get(active.xid)?.[0]?.top.role ?? ""] : undefined;
  const dialog =
    !!active && (active.types.includes("dialog") || activeRole === "dialog" || activeRole === "alertdialog");
  return {
    snapshot: text.join("\n"),
    refs,
    address: `desktop://${hostOf(active?.class[1] || active?.class[0] || "desktop")}/${dialog ? "dialog" : "main"}`,
    title: active ? nameOf(active.title) : "",
    screen: { width, height },
    marks,
    targets,
  };
}

import type { ScreenKind } from "@agenteschat/adapters";
import { cutText } from "../format";

/**
 * What an agent sees on a screen (ADR 0054): the page or window as text, one
 * line per node with a ref for each element it can act on (`button "Save"
 * [ref=e3]`, as `agent-browser`'s snapshot writes it), and what changed
 * between two looks. Surface-agnostic: the browser fills it from its
 * snapshot; a desktop surface fills it from the OS accessibility tree
 * (ADR 0062), and everything built on it (targets in words, checks, plans)
 * works the same.
 */

/** What a screen shows, in the words plans and reports use. */
export const SCREEN_NOUN: Record<ScreenKind, string> = { browser: "page", desktop: "screen" };

/** One element the agent can act on. */
export interface ScreenElement {
  /** `e12` (no `@`). */
  ref: string;
  role: string;
  name: string;
  /** Its line on the screen, as written. */
  line: string;
  /** Where it sits: its named containers, nearest first (`form "Sign in"`, `dialog "Cookies"`). */
  context: string[];
  /** Its line's position in `lines` (document order). */
  index: number;
}

export interface ScreenObservation {
  url: string | null;
  /** The window's title, on a desktop (screen text). */
  title?: string;
  /** The screen as text, one node per line (indentation is nesting). */
  lines: string[];
  elements: ScreenElement[];
  /** When it was taken (ms). */
  at: number;
}

/** A rectangle in the surface's pixels: CSS pixels of a page, screen pixels of a desktop. */
export interface ScreenRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A still image of the screen (JPEG), with the size of what it shows in the surface's pixels. */
export interface ScreenImage {
  data: string;
  width: number;
  height: number;
  /** The size of what it shows (points on the image map onto it). */
  viewport: { width: number; height: number };
  /** A close-up of part of the screen: where its top left corner is (the whole screen when absent). */
  origin?: { x: number; y: number };
  /** Elements drawn on it with their number and box, when it was annotated. */
  marks?: ScreenMark[];
}

export interface ScreenMark {
  ref: string;
  number: number;
  role: string;
  name?: string;
  box: ScreenRegion;
}

/**
 * A line's head: its role, its quoted name and the attribute brackets right
 * after them (`button "Save" [focused, ref=e3]`, `heading "Title" [ref=e1]
 * [level=1]`). A ref is read there only, as an attribute of its own: a name
 * or a text that says `ref=e9` (a page's title, a terminal's output) can't
 * pass for an element.
 */
const HEAD = /^-\s+([A-Za-z][\w-]*)(?:\s+"((?:[^"\\]|\\.)*)")?((?:\s*\[[^\]]*\])*)/;
const REF_ATTR = /(?:^|[[,])\s*ref=(e\d+)\s*(?=[,\]])/;
/** Containers worth naming as an element's place ("the Delete in the row for invoice 42"). */
const PLACES = new Set([
  "dialog",
  "alertdialog",
  "form",
  "region",
  "navigation",
  "banner",
  "main",
  "complementary",
  "contentinfo",
  "search",
  "table",
  "row",
  "rowgroup",
  "listitem",
  "list",
  "group",
  "menu",
  "menubar",
  "tablist",
  "tabpanel",
  "toolbar",
  "article",
  "section",
  "heading",
  "Iframe",
  "iframe",
  "window",
]);

/** A table row has no name of its own in the snapshot: its cells say which row it is. */
const ROWS = new Set(["row"]);
/** A place's name, at most. */
const PLACE_CHARS = 80;
const CELLS = new Set(["cell", "gridcell", "rowheader", "columnheader"]);

const unquote = (s: string) => s.replace(/\\(.)/g, "$1");

/** A line's role, name and ref (see `HEAD`). */
function headOf(body: string): { role: string; name: string | null; ref: string | null } {
  const m = HEAD.exec(body);
  if (!m) return { role: "", name: null, ref: null };
  return {
    role: m[1] as string,
    name: m[2] !== undefined ? unquote(m[2]) : null,
    ref: REF_ATTR.exec(m[3] ?? "")?.[1] ?? null,
  };
}

/** `e7`, `@e7` or `[ref=e7]` → `e7`; anything else → null. */
export function screenRef(target: string): string | null {
  const m = /^\s*(?:\[?ref=)?@?(e\d+)\]?\s*$/.exec(target);
  return m ? (m[1] as string) : null;
}

interface Node {
  role: string;
  name: string | null;
  ref: string | null;
  line: string;
  parent: number;
}

/**
 * The screen from a snapshot's text (and its `refs` map when there is one:
 * role and name per ref, as `agent-browser --json` returns them).
 */
export function observeSnapshot(input: {
  text: string;
  url?: string | null;
  title?: string | null;
  refs?: unknown;
  at?: number;
}): ScreenObservation {
  const lines = input.text
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim() !== "");
  const known =
    input.refs && typeof input.refs === "object"
      ? (input.refs as Record<string, { role?: unknown; name?: unknown }>)
      : {};
  // The tree: each line's node and its parent (by indentation).
  const nodes: Node[] = [];
  const children: number[][] = [];
  const open: { depth: number; index: number }[] = [];
  lines.forEach((line, index) => {
    const depth = (line.length - line.trimStart().length) / 2;
    const body = line.trim();
    while (open.length > 0 && (open[open.length - 1] as { depth: number }).depth >= depth) open.pop();
    const parent = open.length > 0 ? (open[open.length - 1] as { index: number }).index : -1;
    nodes.push({ ...headOf(body), line: body, parent });
    children.push([]);
    if (parent >= 0) (children[parent] as number[]).push(index);
    open.push({ depth, index });
  });
  /**
   * A row's first named cells, once per row: enough of them for a place's characters with any one left out. Every
   * element in a row reads it: joining all of its cells for each one would grow with the row's size squared, in time
   * and in memory (a cut keeps its whole join alive).
   */
  const rowCells = new Map<number, { index: number; name: string }[]>();
  const cellsOf = (row: number) => {
    let cells = rowCells.get(row);
    if (cells) return cells;
    cells = [];
    let size = 0;
    for (const c of children[row] as number[]) {
      const { role, name } = nodes[c] as Node;
      if (!name || !CELLS.has(role)) continue;
      cells.push({ index: c, name: name.slice(0, PLACE_CHARS) });
      size += Math.min(name.length, PLACE_CHARS) + 3;
      if (size >= 2 * (PLACE_CHARS + 3)) break;
    }
    rowCells.set(row, cells);
    return cells;
  };
  /** How a container reads as a place: its name, or for a row the other cells' text ("Invoice 42 · R$ 42,00"). */
  const placeOf = (i: number, via: number): string | null => {
    const n = nodes[i] as Node;
    if (!PLACES.has(n.role)) return null;
    if (n.name) return `${n.role} "${cutText(n.name, PLACE_CHARS)}"`;
    if (!ROWS.has(n.role)) return null;
    const cells = cellsOf(i)
      .filter((c) => c.index !== via)
      .map((c) => c.name);
    return cells.length > 0 ? `${n.role} "${cutText(cells.join(" · "), PLACE_CHARS)}"` : null;
  };
  const elements: ScreenElement[] = [];
  nodes.forEach((n, index) => {
    if (!n.ref) return;
    // Its named containers, nearest first.
    const context: string[] = [];
    let child = index;
    let p = n.parent;
    while (p >= 0 && context.length < 3) {
      const place = placeOf(p, child);
      if (place) context.push(place);
      child = p;
      p = (nodes[p] as Node).parent;
    }
    const meta = known[n.ref];
    elements.push({
      ref: n.ref,
      role: typeof meta?.role === "string" && meta.role ? meta.role : n.role,
      name: typeof meta?.name === "string" ? meta.name : (n.name ?? ""),
      line: n.line,
      context,
      index,
    });
  });
  // Refs the map knows that no line carries (rare): still targets.
  const seen = new Set(elements.map((e) => e.ref));
  for (const [ref, meta] of Object.entries(known)) {
    if (seen.has(ref) || !/^e\d+$/.test(ref)) continue;
    const role = typeof meta?.role === "string" ? meta.role : "";
    const name = typeof meta?.name === "string" ? meta.name : "";
    elements.push({ ref, role, name, line: `${role} "${name}" [ref=${ref}]`, context: [], index: lines.length });
  }
  return {
    url: input.url ?? null,
    ...(input.title ? { title: input.title } : {}),
    lines,
    elements,
    at: input.at ?? Date.now(),
  };
}

/** How an element reads to a judge: its line plus where it sits. */
export function describeElement(e: ScreenElement, max = 220): string {
  // Only the head of a long line: the text is cut at `max` anyway, and the ref's pattern backtracks over long spaces.
  const own = e.line
    .slice(0, max + 64)
    .replace(/^-\s+/, "")
    .replace(/\s*\[ref=e\d+\]/, "");
  const where = e.context.length > 0 ? ` — in ${e.context.join(" › ")}` : "";
  const text = `${own}${where}`;
  return text.length > max ? `${cutText(text, max - 1)}…` : text;
}

/** A look this recent is the screen as it is: a plan's first target can be found on it. */
export const FRESH_LOOK_MS = 8000;
/** A look this recent is still what the agent knows of the screen: a plan's changes are counted from it. */
export const KNOWN_LOOK_MS = 10 * 60_000;

/**
 * The last look at each agent's screen, by key, for the newest `max` keys: what its plans start from. A look older
 * than `KNOWN_LOOK_MS` is dropped (nothing reads one), so idle agents' huge pages don't stay in memory.
 */
export function createLookMemory(now: () => number = Date.now, max = 1000) {
  const looks = new Map<string, ScreenObservation>();
  return {
    remember(key: string, o: ScreenObservation) {
      looks.delete(key);
      looks.set(key, o);
      if (looks.size > max) looks.delete(looks.keys().next().value as string);
      for (const [k, old] of looks) {
        if (now() - old.at < KNOWN_LOOK_MS) break;
        looks.delete(k);
      }
    },
    /** The last look, when it is younger than `ms`. */
    within(key: string, ms: number) {
      const o = looks.get(key);
      return o && now() - o.at < ms ? o : null;
    },
    forget(key: string) {
      looks.delete(key);
    },
  };
}

/** The address without its fragment: two looks at the same document. */
const documentOf = (url: string | null) => (url ? url.replace(/#.*$/, "") : null);

export interface ScreenChanges {
  /** The address changed, or most of the screen did: a new page, not a change on it. */
  newPage: boolean;
  added: string[];
  removed: string[];
  urlBefore: string | null;
  urlAfter: string | null;
}

/**
 * What changed between two looks, line by line (a multiset difference: refs
 * stay the same for elements that survive, so a kept line reads the same).
 * Lines in screen order.
 */
export function diffObservations(before: ScreenObservation | null, after: ScreenObservation): ScreenChanges {
  if (!before) {
    return { newPage: true, added: after.lines, removed: [], urlBefore: null, urlAfter: after.url };
  }
  const count = new Map<string, number>();
  for (const l of before.lines) count.set(l.trim(), (count.get(l.trim()) ?? 0) + 1);
  const added: string[] = [];
  for (const l of after.lines) {
    const k = l.trim();
    const n = count.get(k) ?? 0;
    if (n > 0) count.set(k, n - 1);
    else added.push(l);
  }
  const left = new Map(count);
  const removed: string[] = [];
  for (const l of before.lines) {
    const k = l.trim();
    const n = left.get(k) ?? 0;
    if (n > 0) {
      removed.push(l);
      left.set(k, n - 1);
    }
  }
  const kept = after.lines.length - added.length;
  const newPage =
    documentOf(before.url) !== documentOf(after.url) ||
    (after.lines.length > 8 && kept < Math.min(before.lines.length, after.lines.length) * 0.3);
  return { newPage, added, removed, urlBefore: before.url, urlAfter: after.url };
}

/** A short fingerprint of a screen: two looks with the same one show the same thing. */
export function screenDigest(o: ScreenObservation): string {
  let h = 2166136261;
  for (const l of o.lines) {
    for (let i = 0; i < l.length; i++) {
      h ^= l.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h ^= 10;
  }
  return `${documentOf(o.url) ?? ""}#${(h >>> 0).toString(36)}:${o.lines.length}`;
}

const STRUCTURE = new Set(["heading", "dialog", "alertdialog", "alert", "status", "tab", "Iframe", "iframe", "window"]);

/**
 * What the agent can act on, for its first look at a page: elements with a
 * ref plus headings, dialogs and alerts, nesting kept; at most `max`
 * characters (the rest counted).
 */
export function screenOverview(o: ScreenObservation, max = 6000): { text: string; omitted: number } {
  const keep = o.lines.filter((l) => {
    const head = headOf(l.trim());
    return head.ref !== null || STRUCTURE.has(head.role);
  });
  return clipLines(keep, max);
}

/** Lines up to `max` characters; how many were left out. */
export function clipLines(lines: string[], max: number): { text: string; omitted: number } {
  const out: string[] = [];
  let size = 0;
  for (const l of lines) {
    if (size + l.length + 1 > max) break;
    out.push(l);
    size += l.length + 1;
  }
  return { text: out.join("\n"), omitted: lines.length - out.length };
}

/** The page's text for a judge, at most `max` characters. */
export function screenText(o: ScreenObservation, max = 60_000): string {
  return clipLines(o.lines, max).text;
}

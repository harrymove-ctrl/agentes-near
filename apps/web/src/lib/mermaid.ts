import { escapeHtml } from "@agenteschat/client/lib/text";
import mermaidBundle from "mermaid/dist/mermaid.min.js?url&no-inline";
import frameScript from "./mermaid-frame.js?url&no-inline";

/**
 * Mermaid draws in the document it runs in, and a diagram has many ways to make that document load a URL while it
 * draws (an image node, CSS url() through classDef, style or its own settings, label HTML, a sequence actor's icon…).
 * In the page, each would reach the network from every viewer's browser with no click: who read it, when, and whatever
 * an agent put in the URL. So mermaid runs in a frame where nothing loads, whatever the diagram says:
 *
 * - An iframe sandboxed with `allow-scripts` only (an opaque origin: no cookies, storage or DOM of ours) holds a second
 *   one, sandboxed the same way, where mermaid draws. Both carry the CSP of `mermaidFrameDocument`: nothing loads but
 *   mermaid's bundle and mermaid-frame.js, plus inline styles and data: images. The CSP is not the only layer, because
 *   it doesn't catch every way a tag reaches the network: measured in Chromium 156, Firefox 144 and WebKit 26 (Safari,
 *   the desktop app), it stops neither `<link rel=preconnect>` nor `dns-prefetch`; Chromium also sends `<link
 *   rel=prerender>` as a GET and opens a connection before it refuses an `<iframe>` or a `<meta http-equiv=refresh>`,
 *   and Firefox resolves the host of any HTML `<a href>`. Those tags and `href` are stopped by the second layer below
 *   (mermaid strict + the DOMPurify config) in every engine instead, which drops them before they reach the document.
 * - The page sends `{id, source, dark}` and takes `{id, svg}` or `{id, error}` back only from the inner frame's
 *   window, so another frame on the page (an agent's HTML page) can't post a drawing. The SVG still goes into an
 *   `<img>`, where nothing in it runs or loads.
 * - Mermaid's own settings in mermaid-frame.js (strict, no HTML labels, its sanitizer, a diagram's own settings cut to
 *   the few that only change its look) are a second layer.
 *
 * Desktop Chrome and Edge give the frame a process of its own, where a drawing that takes long only holds up the next
 * one. Safari, Firefox, the desktop app (WebKit) and a Chromium that doesn't isolate sandboxed frames run it on the
 * page's own thread: there a drawing holds up the page, and the timeout below can't fire until mermaid lets go, so a
 * diagram is drawn there only when the viewer asks for it (`mermaidRunsApart`). `mermaidDrawable` bounds what goes to
 * mermaid either way.
 */

const MERMAID_MAX_TEXT = 5000;
const MERMAID_MAX_LINES = 200;
const MERMAID_MAX_LINE = 500;
const MERMAID_MAX_MINDMAP_LINES = 100;
/** A venn diagram's `set` and `union` lines. */
const MERMAID_MAX_VENN_AREAS = 30;
/** Characters mermaid's entity regexes may read over the `style` and `classDef` lines: about 25 ms of them. */
const MERMAID_MAX_STYLE_WORK = 100_000_000;
/** A block diagram's `space:N` blocks, all of them together. */
const MERMAID_MAX_SPACES = 100;
/** Days a gantt that `excludes` dates walks through day by day, its durations together: about 40 ms of them. */
const MERMAID_MAX_GANTT_DAYS = 10_000;
/** Years apart that such a gantt may name: a task that ends on a date or `until` another walks to it too. */
const MERMAID_MAX_GANTT_YEARS = 30;
/** Levels of an architecture diagram's groups inside groups. */
const MERMAID_MAX_GROUP_DEPTH = 3;
/** Levels of a block diagram's blocks inside blocks: its layout recurses twice per block, so its cost doubles a level. */
const MERMAID_MAX_BLOCK_DEPTH = 10;
/** A gantt duration's unit (mermaid's duration regex) in days, rounded up. */
const GANTT_DAYS: Record<string, number> = { y: 366, M: 31, w: 7, d: 1, h: 1 / 24, m: 1 / 1440, s: 1 / 86_400 };
/** Mermaid's directive regex, as 11.17.2 has it: the source its parsers read is the one without these. */
const MERMAID_DIRECTIVE = /%{2}{\s*(?:(\w+)\s*:|(\w+))\s*(?:(\w+)|((?:(?!}%{2}).|\r?\n)*))?\s*(?:}%{2})?/gi;
/** A YAML anchor (`&a`) or alias (`*a`): an `&` or `*` that starts a key or a value and names something. */
const YAML_ANCHOR_OR_ALIAS = /(?:^|[\s:?,[{-])[&*]\S/;

/**
 * Whether a source goes to mermaid, checked before anything reaches the frame, in time linear in the source. Past these
 * bounds one fence held WebKit 26 or Firefox 144 for seconds to minutes (Chrome's frame process too):
 *
 * - At most 5,000 characters, 200 lines and 500 characters a line. Some of mermaid's parsers take time that grows with
 *   the square of the source (50,000 characters of `;` in an xychart: 5 s, 4,800 lines of `<a` in an architecture
 *   diagram: 4.7 s), and some of its layouts a millisecond or more a node.
 * - At most 100 lines in a mindmap, and 30 sets and unions in a venn diagram: their layouts grow much faster than their
 *   size (a mindmap of 1,000 nodes: 21 s, a venn diagram of 200 sets: 100 s).
 * - No more `style` and `classDef` than mermaid's entity regexes read in a moment. `style.*:\S*#.*;` (the same with
 *   classDef) tries, on a line with no `;` after its last `#`, each style there with each `:` after it and each `#`
 *   after that, reading the rest of the line each time.
 * - Front matter that mermaid reads, and no YAML anchors or aliases in it or in node metadata (`@{ … }`): aliases of
 *   aliases take mermaid exponential time (437 characters of front matter: 13 s, 223 in a kanban card: 56 s).
 * - Where a number in the source sets the work, not its length: at most 100 blocks of `space:N` (`space:100000`:
 *   77 s); in a gantt that `excludes` dates, 10,000 days of durations, no number of 5 digits or more and 30 years
 *   between the years it names (a task of 1,000,000 days: 3.6 s).
 * - Architecture groups at most 3 levels deep: the layout's time over edges across nested groups jumps with the edges'
 *   pattern, up to 1.5 s in WebKit and 3 s in Firefox at 3 levels (as people draw them: 50 ms), 13 s in Chrome at 4,
 *   25 s in WebKit and 38 s in Firefox at 10.
 * - Block diagrams at most 10 levels of blocks inside blocks: the layout recurses twice per block, so its cost doubles
 *   with each level (22 levels: 6.9 s in WebKit).
 *
 * Within the bounds a drawing still costs its size. The slowest measured in WebKit and Firefox: a block diagram that
 * packs 1,000 blocks into 5,000 characters, 1.4 s, a 499-edge flowchart 0.75 s, a 200-line class diagram 0.57 s.
 */
export function mermaidDrawable(source: string): boolean {
  if (source.length > MERMAID_MAX_TEXT) return false;
  const lines = source.split(/\r\n?|\n/);
  if (lines.length > MERMAID_MAX_LINES || lines.some((line) => line.length > MERMAID_MAX_LINE)) return false;
  // Front matter ends at a `---` line in the opening one's indent, from the third line on and followed by a line break
  // (mermaid's regex, once mermaid has made every `\r\n` a `\n`). Without one mermaid refuses the diagram.
  let body = lines;
  const first = lines[0] ?? "";
  if (first.trim() === "---") {
    const closing = `${first.slice(0, first.indexOf("-"))}---`;
    const end = lines.findIndex(
      (line, i) => i >= 2 && i < lines.length - 1 && line.startsWith(closing) && !line.slice(closing.length).trim(),
    );
    if (end < 0 || YAML_ANCHOR_OR_ALIAS.test(lines.slice(1, end).join("\n"))) return false;
    body = lines.slice(end + 1);
  }
  // What mermaid's parsers read: the rest without its directives, which can join the lines around them into one.
  const text = body.join("\n").replace(MERMAID_DIRECTIVE, "");
  const read = text.split("\n");
  let styleWork = 0;
  const groupParent = new Map<string, string>();
  for (const line of read) {
    if (line.length > MERMAID_MAX_LINE) return false;
    const styles = line.match(/style|classDef/g)?.length ?? 0;
    styleWork += styles * line.split(":").length * line.split("#").length * line.length;
    const group = /^\s*group\s+([-\w]+)\b.*\sin\s+([-\w]+)\s*$/.exec(line.replace(/%%.*/, ""));
    if (group?.[1] && group[2]) groupParent.set(group[1], group[2]);
  }
  if (styleWork > MERMAID_MAX_STYLE_WORK) return false;
  if (/^\s*mindmap/m.test(text) && read.length > MERMAID_MAX_MINDMAP_LINES) return false;
  if (/^\s*venn-beta/m.test(text) && (text.match(/^\s*(?:set|union)\b/gim)?.length ?? 0) > MERMAID_MAX_VENN_AREAS)
    return false;
  // Node metadata runs to its first `}` outside a quoted string (mermaid's lexer), and is read as YAML. Tested on the
  // raw text like the front matter above: a single-quoted '"' or an escaped \" can fence off an alias chain from a scan
  // that strips "…" first, hiding anchors mermaid still expands.
  for (const [meta] of text.matchAll(/@\{(?:"[^"]*"|[^"}])*/g))
    if (YAML_ANCHOR_OR_ALIAS.test(meta.slice(2))) return false;
  let spaces = 0;
  for (const [, count] of text.matchAll(/\bspace:(\d+)/g)) spaces += Number(count);
  if (spaces > MERMAID_MAX_SPACES) return false;
  // Mermaid matches `excludes` case-insensitively at any token start, the first gantt line included (`gantt excludes …`).
  if (/^\s*gantt\b/m.test(text) && /(?:^|\s)excludes\s/i.test(text)) {
    let days = 0;
    for (const [, count, unit = ""] of text.matchAll(/(\d+(?:\.\d+)?)(ms|[Mdhmswy])\b/g))
      days += Number(count) * (GANTT_DAYS[unit] ?? 0);
    // A task that ends on a date, `until` another or `until` a missing id (which ends today) walks there day by day. The
    // current year is always compared, since a task ending today names no year the regex above could see.
    const years = [...(text.match(/\b\d{4}\b/g) ?? []).map(Number), new Date().getFullYear()];
    if (days > MERMAID_MAX_GANTT_DAYS || /\d{5}/.test(text)) return false;
    if (Math.max(...years) - Math.min(...years) > MERMAID_MAX_GANTT_YEARS) return false;
  }
  for (const group of groupParent.keys()) {
    let depth = 1;
    for (let id = group; depth <= MERMAID_MAX_GROUP_DEPTH && groupParent.has(id); id = groupParent.get(id) ?? "")
      depth++;
    if (depth > MERMAID_MAX_GROUP_DEPTH) return false;
  }
  // A block diagram's nesting: `block:id` and a bare `block` both open a composite that an `end` closes; the diagram's
  // own header (the first keyword) sits at depth 0. Counted over the whole source, in document order.
  if (/^\s*block(?:-beta)?\b/.test(read.find((line) => line.trim()) ?? "")) {
    const tokens = [...text.matchAll(/\bblock:|\bblock-beta\b|\bblock\b(?![:-])|\bend\b/g)].map(([token]) => token);
    let depth = 0;
    let max = 0;
    for (let i = 1; i < tokens.length; i++) {
      if (tokens[i] === "end") depth = Math.max(0, depth - 1);
      else if (++depth > max) max = depth;
    }
    if (max > MERMAID_MAX_BLOCK_DEPTH) return false;
  }
  return true;
}

/** Both frames' sandbox. Not the agent pages' (HtmlFrame): what those may be allowed must never reach this one. */
const SANDBOX = "allow-scripts";

/** The frame mermaid draws in: the window that answers, its load (done or failed) and its removal. */
export type MermaidFrame = { window: () => Window | null | undefined; loaded: Promise<unknown>; remove: () => void };

/**
 * The outer frame's document, with the inner one where mermaid draws. `scripts`: the absolute addresses of mermaid's
 * bundle and mermaid-frame.js, the only scripts it may run (an opaque origin has no 'self' to name them by).
 */
export function mermaidFrameDocument(scripts: string[]): string {
  const head = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${scripts.join(" ")}; style-src 'unsafe-inline'; img-src data:">`;
  const drawing = head + scripts.map((src) => `<script src="${src}"></script>`).join("");
  // The same size on every device, so every viewer gets the same drawing.
  return `${head}<iframe sandbox="${SANDBOX}" width="1280" height="900" srcdoc="${escapeHtml(drawing)}"></iframe>`;
}

/** A frame that runs `scripts` (relative to the page, as the build names them). */
function sandboxFrame(scripts: string[]): MermaidFrame {
  const el = document.createElement("iframe");
  el.setAttribute("sandbox", SANDBOX);
  el.setAttribute("aria-hidden", "true");
  el.tabIndex = -1;
  // Off screen but laid out (not display: none): mermaid measures its text.
  el.style.cssText = "position:fixed;left:-10000px;top:0;width:1280px;height:900px;border:0";
  // The price of the opaque origin: Chrome never takes such a frame's scripts from its cache, so each frame (one per
  // page load, a fresh one after a timeout) downloads mermaid's bundle again. Safari and Firefox take it from theirs.
  el.srcdoc = mermaidFrameDocument(scripts.map((url) => new URL(url, document.baseURI).href));
  const loaded = new Promise((resolve) => el.addEventListener("load", resolve, { once: true }));
  document.body.append(el);
  const inner = () => {
    // Until the outer frame has parsed the inner one, reading its first child is a cross-origin access, which throws.
    try {
      return el.contentWindow?.[0];
    } catch {
      return undefined;
    }
  };
  return { window: inner, loaded, remove: () => el.remove() };
}

let makeFrame = sandboxFrame;
let timeLimit = 10_000;
let frame: { host: MermaidFrame; ready: Promise<void>; markReady: () => void } | null = null;
const waiting = new Map<string, { resolve: (svg: string) => void; reject: (error: Error) => void }>();
let apart: Promise<boolean> | undefined;

/**
 * Whether a drawing may start without the viewer asking for it: only where the frame runs apart from the page, in a
 * process of its own, so a drawing that takes long can't hold the page up. Asked once a page load, of a frame without
 * mermaid's bundle: the page sends it a question and then keeps itself busy for 60 ms, and the frame answers when it
 * read the question (after 25 ms of its own, so that its answer falls within the page's 60). On the page's thread the
 * frame can't read anything while the page is busy, so only a frame apart from it can answer with a time inside. A late
 * answer or none reads as sharing the thread, which is why the question waits for the page to be on screen and idle.
 *
 * False from the first drawing that timed out: a fresh frame downloads mermaid's bundle again in Chrome, and the
 * drawings behind a slow one wait it out.
 */
export function mermaidRunsApart(): Promise<boolean> {
  apart ??= new Promise((resolve) => {
    const ask = () => {
      const host = makeFrame([frameScript]);
      let busy: [number, number] | undefined;
      let spell: ReturnType<typeof setTimeout> | undefined;
      const done = (value: boolean) => {
        window.removeEventListener("message", listen);
        clearTimeout(timer);
        clearTimeout(spell);
        host.remove();
        resolve(value);
      };
      const question = () => {
        host.window()?.postMessage({ probe: true }, "*");
        // In a task after this one: Chrome sends a message to another process once the task that posted it is over.
        spell = setTimeout(() => {
          const from = Date.now();
          while (Date.now() - from < 60) {
            // Busy.
          }
          busy = [from, Date.now()];
        }, 5);
      };
      const listen = ({ source, data }: MessageEvent) => {
        if (source !== host.window()) return;
        if (data?.ready === true) {
          if (typeof requestIdleCallback === "function") requestIdleCallback(question, { timeout: 1000 });
          else setTimeout(question);
        } else if (typeof data?.at === "number")
          done(busy !== undefined && busy[0] + 5 < data.at && data.at < busy[1] - 5);
      };
      // A frame that doesn't answer couldn't draw either.
      const timer = setTimeout(() => done(false), timeLimit);
      window.addEventListener("message", listen);
    };
    // A page in a background tab has its timers held back.
    if (document.hidden) document.addEventListener("visibilitychange", ask, { once: true });
    else ask();
  });
  return apart;
}

/** The frame's answers: only from its window, only in the protocol's shape. */
function onAnswer({ source, data }: MessageEvent) {
  if (!frame || source !== frame.host.window()) return;
  if (data?.ready === true) frame.markReady();
  const asked = typeof data?.id === "string" ? waiting.get(data.id) : undefined;
  if (typeof data?.svg === "string") asked?.resolve(data.svg);
  else if (typeof data?.error === "string") asked?.reject(new Error(data.error));
}

function currentFrame() {
  if (!frame) {
    window.addEventListener("message", onAnswer);
    let markReady = () => {};
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    frame = { host: makeFrame([mermaidBundle, frameScript]), ready, markReady };
  }
  return frame;
}

/**
 * Mermaid's SVG for a source, drawn in the frame (made on first use and kept). It fails when mermaid can't draw the
 * source, or hasn't answered `timeout` ms after the frame loaded: that frame is thrown away with whatever holds it up,
 * the next drawing gets a fresh one, and none starts again without the viewer asking (`mermaidRunsApart`).
 */
export async function drawWithMermaid(id: string, source: string, dark: boolean, timeout = timeLimit) {
  const used = currentFrame();
  // Counted from here, however long mermaid's bundle took to arrive.
  await used.host.loaded;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      timer = setTimeout(() => {
        if (frame === used) {
          used.host.remove();
          frame = null;
        }
        apart = Promise.resolve(false);
        reject(new Error("Mermaid didn't finish drawing"));
      }, timeout);
      used.ready.then(() => used.host.window()?.postMessage({ id, source, dark }, "*"));
    });
  } finally {
    clearTimeout(timer);
    waiting.delete(id);
  }
}

/**
 * Tests: the frames to draw and measure in (a fake that answers like mermaid-frame.js, given the scripts it'd run), or
 * null for real ones, and how long a drawing may take.
 */
export function setMermaidFrame(next: ((scripts: string[]) => MermaidFrame) | null, limit = 10_000) {
  frame?.host.remove();
  frame = null;
  apart = undefined;
  makeFrame = next ?? sandboxFrame;
  timeLimit = limit;
}

/**
 * A diagram drawn: its image (data URL), its own width in CSS pixels (null when its SVG doesn't say) and, when the
 * diagram has them, its accTitle and accDescr.
 */
export type Drawing = { src: string; width: number | null; title?: string; description?: string };

/** Past this the page itself takes long to read, encode, decode and paint a drawing (3.9 MB: 0.5 s in Chrome). */
const MAX_SVG = 1_000_000;
/** Past this on a side a drawing makes a card thousands of pixels tall, or wide with labels too small to read. */
const MAX_SIDE = 20_000;

/**
 * Mermaid's SVG as an image at its own size, its accessible name and description taken out for the <img>. Null when
 * it's too big to show (`MAX_SVG`, `MAX_SIDE`) or isn't markup an <img> can read: the block stays code.
 */
export function svgDrawing(svg: string): Drawing | null {
  if (svg.length > MAX_SVG) return null;
  // Read as XML, as the <img> reads it. DOMParser's document never loads anything.
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement;
  if (root.localName !== "svg" || doc.getElementsByTagName("parsererror").length) return null;
  const [, , width, height] =
    root
      .getAttribute("viewBox")
      ?.trim()
      .split(/[\s,]+/)
      .map(Number) ?? [];
  if (width && height) {
    if (width > MAX_SIDE || height > MAX_SIDE) return null;
    // Its own size, not its box's width (mermaid's "100%"): a small diagram isn't blown up to fill the box. In place
    // of the root's own: a journey's already has a height, and an attribute set twice is markup the <img> can't read.
    root.setAttribute("width", String(width));
    root.setAttribute("height", String(height));
  }
  // Mermaid writes accTitle and accDescr as the SVG's first <title> and <desc>, which an <img> hides from assistive
  // technology.
  const childText = (tag: string) =>
    Array.from(root.children)
      .find((el) => el.localName === tag)
      ?.textContent?.trim() || undefined;
  return {
    src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(root))}`,
    width: width || null,
    title: childText("title"),
    description: childText("desc"),
  };
}

import type { WikiPageSummary } from "@agenteschat/client";
import { parseWikiToken, type TableAlign, tableAt } from "@agenteschat/client/lib/markdown";
import { type WikiFolder, wikiTree } from "@agenteschat/client/lib/wiki";

/**
 * The wiki on the phone: the home's parts (Fixadas, Editadas recentemente, Pastas and the
 * pages at the root), a folder's own screen, the search, and a page's text split into blocks with its `[[links]]`
 * and tasks. Pure: the screens draw it.
 */

/** Pages under "Editadas recentemente" on the home. */
export const RECENT_COUNT = 5;

export interface WikiHome {
  pinned: WikiPageSummary[];
  /** Only when the wiki has more pages than this list shows. */
  recent: WikiPageSummary[];
  folders: { name: string; path: string; count: number }[];
  /** Pages with no folder. */
  pages: WikiPageSummary[];
}

/** Pages in a folder and in every folder under it. */
const countOf = (f: WikiFolder<WikiPageSummary>): number =>
  f.pages.length + f.folders.reduce((n, sub) => n + countOf(sub), 0);

/** A folder of the tree by its path ("" = the root), or null when no page lives there any more. */
function folderAt(pages: WikiPageSummary[], path: string): WikiFolder<WikiPageSummary> | null {
  let node: WikiFolder<WikiPageSummary> | undefined = wikiTree(pages);
  for (const part of path.split("/").filter(Boolean)) {
    node = node?.folders.find((f) => f.name === part);
  }
  return node ?? null;
}

/** The home, or a folder's screen (`folder`): its folders with how many pages each holds, then its pages. */
export function wikiHome(pages: WikiPageSummary[], folder = ""): WikiHome | null {
  const node = folderAt(pages, folder);
  if (!node) return null;
  const top = folder === "";
  return {
    pinned: top ? pages.filter((p) => p.pinned).sort(byTitle) : [],
    recent:
      top && pages.length > RECENT_COUNT
        ? [...pages].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, RECENT_COUNT)
        : [],
    folders: node.folders.map((f) => ({ name: f.name, path: f.path, count: countOf(f) })),
    pages: node.pages,
  };
}

const byTitle = (a: WikiPageSummary, b: WikiPageSummary) => a.title.localeCompare(b.title);

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** Pages whose title, folder, tags or opening text have every word typed (case and accents ignored). */
export function searchWiki(pages: WikiPageSummary[], q: string): WikiPageSummary[] {
  const words = fold(q).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const hay = (p: WikiPageSummary) => fold([p.title, p.folder, p.tags.join(" "), p.excerpt ?? ""].join(" "));
  const titleHit = (p: WikiPageSummary) => words.every((w) => fold(p.title).includes(w));
  return pages
    .filter((p) => {
      const h = hay(p);
      return words.every((w) => h.includes(w));
    })
    .sort((a, b) => Number(titleHit(b)) - Number(titleHit(a)) || byTitle(a, b));
}

/** Pages whose title starts with (then contains) what follows `[[`, for the editor's suggestions. */
export function suggestPages(pages: WikiPageSummary[], query: string, limit = 5): WikiPageSummary[] {
  const q = fold(query.trim());
  const starts = pages.filter((p) => fold(p.title).startsWith(q));
  const has = q ? pages.filter((p) => !fold(p.title).startsWith(q) && fold(p.title).includes(q)) : [];
  return [...starts.sort(byTitle), ...has.sort(byTitle)].slice(0, limit);
}

/** A run of a line: plain words (with the chat's marks), or a `[[link]]` with its target and label. */
export type DocRun = { kind: "text"; text: string } | { kind: "link"; title: string; label: string };

/** A block of a page as the reader draws it; `line` is where a task sits in the text (to check it). */
export type DocBlock =
  | { kind: "heading"; level: number; runs: DocRun[] }
  | { kind: "paragraph"; runs: DocRun[] }
  | { kind: "bullet"; runs: DocRun[]; ordinal: string | null }
  | { kind: "task"; runs: DocRun[]; done: boolean; line: number }
  | { kind: "quote"; runs: DocRun[] }
  | { kind: "code"; text: string }
  | { kind: "table"; header: string[]; rows: string[][]; align: TableAlign[] }
  | { kind: "rule" };

/** A line's `[[links]]` apart from its words; an embed (`![[foto.png]]`) stays as its name, in italics. */
export function docRuns(text: string): DocRun[] {
  const out: DocRun[] = [];
  const plain = text.replace(/!\[\[([^[\]\n]+)\]\]/g, (tok) => `_${parseWikiToken(tok.slice(1)).label}_`);
  let at = 0;
  for (const m of plain.matchAll(/\[\[([^[\]\n]+)\]\]/g)) {
    if (m.index > at) out.push({ kind: "text", text: plain.slice(at, m.index) });
    const { title, label } = parseWikiToken(m[0]);
    out.push({ kind: "link", title, label: label === title ? label.replace(/#.*$/, "").trim() : label });
    at = m.index + m[0].length;
  }
  if (at < plain.length) out.push({ kind: "text", text: plain.slice(at) });
  return out;
}

/** A page's text as blocks: headings, paragraphs, lists, tasks, quotes, code (fenced), tables and rules. */
export function docBlocks(body: string): DocBlock[] {
  const out: DocBlock[] = [];
  const lines = body.split("\n");
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ kind: "paragraph", runs: docRuns(para.join("\n")) });
    para = [];
  };
  for (let n = 0; n < lines.length; n++) {
    const line = (lines[n] ?? "").trimEnd();
    const fence = /^```/.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      n++;
      while (n < lines.length && !/^```/.test(lines[n] ?? "")) code.push(lines[n++] ?? "");
      out.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const table = tableAt(lines, n);
    if (table) {
      flush();
      out.push({ ...table.table, kind: "table" });
      n = table.next - 1;
      continue;
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flush();
      out.push({ kind: "rule" });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const task = /^\s*[-*]\s+\[([ xX])\]\s?(.*)$/.exec(line);
    const bullet = /^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/.exec(line);
    const quote = /^>\s?(.*)$/.exec(line);
    if (heading) {
      flush();
      out.push({ kind: "heading", level: heading[1]?.length ?? 2, runs: docRuns(heading[2] ?? "") });
    } else if (task) {
      flush();
      out.push({ kind: "task", runs: docRuns(task[2] ?? ""), done: task[1] !== " ", line: n });
    } else if (bullet) {
      flush();
      out.push({ kind: "bullet", runs: docRuns(bullet[2] ?? ""), ordinal: bullet[1] ?? null });
    } else if (quote) {
      flush();
      out.push({ kind: "quote", runs: docRuns(quote[1] ?? "") });
    } else para.push(line);
  }
  flush();
  return out;
}

/** A slug from a link or the route (URL keys only: letters, digits, dots, dashes and slashes). */
export const isWikiSlug = (s: unknown): s is string =>
  typeof s === "string" && s.length > 0 && s.length <= 300 && /^[\p{L}\p{N}./_-]+$/u.test(s);

/** The route's slug, decoded, or null when it isn't one. */
export function wikiSlugOf(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const slug = decodeURIComponent(raw);
    return isWikiSlug(slug) ? slug : null;
  } catch {
    return null;
  }
}

/** The page's folders for "Nova página" and "Renomear ou mover": every folder path in use, sorted. */
export const foldersIn = (pages: WikiPageSummary[]) =>
  [...new Set(pages.map((p) => p.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b));

/** How many pages "Continuar lendo" shows, and how many this phone remembers per workspace. */
export const CONTINUE_COUNT = 3;
const RECENT_KEPT = 12;

/** The remembered recents (org id → slugs, newest first), from what storage holds; anything else reads as none. */
export function parseRecents(raw: string | null): Record<string, string[]> {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([org, slugs]) => [
        org,
        Array.isArray(slugs) ? slugs.filter((s): s is string => typeof s === "string") : [],
      ]),
    );
  } catch {
    return {};
  }
}

/** The recents after opening `slug` in `orgId`: first, once, the oldest let go past what is kept. */
export function withRecent(recents: Record<string, string[]>, orgId: string, slug: string) {
  const list = [slug, ...(recents[orgId] ?? []).filter((s) => s !== slug)].slice(0, RECENT_KEPT);
  return { ...recents, [orgId]: list };
}

/** "Continuar lendo": the pages last opened that still exist, newest first. */
export function continueReading(pages: WikiPageSummary[], slugs: string[], count = CONTINUE_COUNT) {
  const bySlug = new Map(pages.map((p) => [p.slug, p]));
  return slugs.flatMap((s) => bySlug.get(s) ?? []).slice(0, count);
}

/**
 * A page's text without its first heading when that heading is only the title again (the title is already above
 * it). The line stays, blank, so a task's line number still points at the same line.
 */
export function withoutTitleHeading(body: string, title: string) {
  const lines = body.split("\n");
  const first = lines.findIndex((l) => l.trim() !== "");
  const heading = first >= 0 ? /^#{1,2}\s+(.+?)\s*#*\s*$/.exec(lines[first] ?? "") : null;
  if (!heading?.[1] || heading[1].trim().toLowerCase() !== title.trim().toLowerCase()) return body;
  lines[first] = "";
  return lines.join("\n");
}

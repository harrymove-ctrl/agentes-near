import type { WikiAudience, WikiBulkTarget, WikiPageSummary } from "../api/types";
import { headingId, parseMarkdown, wikiLinksIn } from "./markdown";

/** "Guia de deploy" → "guia-de-deploy" (unique in the org, like the backend; the folder isn't in it). */
export const wikiSlug = (title: string) =>
  leafTitle(title)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** `Página#seção` → { title: "Página", section: "seção" }. */
export function splitSection(title: string) {
  const at = title.indexOf("#");
  return at < 0 ? { title, section: null } : { title: title.slice(0, at).trim(), section: title.slice(at + 1).trim() };
}

/** The last part of a path title: "Processos/Deploy" → "Deploy". */
export function leafTitle(title: string) {
  return title.split("/").pop()?.trim() || title;
}

/** The title a page's slug spells, for a link to a page that doesn't exist yet: "processos/deploy-final" → "deploy final". */
export const titleOfSlug = (slug: string) => leafTitle(slug.split("/").pop()?.replace(/-/g, " ") ?? "");

/** Resolves a `[[link]]` title against the pages: by title (case and accents ignored) or by slug. */
export function resolveWikiLink<T extends { slug: string; title: string; folder: string }>(
  pages: T[],
  title: string,
): T | undefined {
  const fold = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim();
  const want = fold(splitSection(title).title);
  const slug = wikiSlug(splitSection(title).title);
  return (
    pages.find((p) => fold(p.title) === want) ??
    pages.find((p) => fold(p.folder ? `${p.folder}/${p.title}` : p.title) === want) ??
    pages.find((p) => p.slug === slug)
  );
}

export { wikiLinksIn };

/** The outline: headings with their anchor ids. */
export const outlineOf = (body: string) =>
  parseMarkdown(body)
    .filter((b): b is { type: "heading"; level: number; text: string } => b.type === "heading")
    .map((b) => ({ level: b.level, text: b.text, id: `h-${headingId(b.text)}` }));

/** Folders as a tree: { name, path, folders, pages }. */
export interface WikiFolder<T> {
  name: string;
  path: string;
  folders: WikiFolder<T>[];
  pages: T[];
}

export function wikiTree<T extends { folder: string; title: string }>(pages: T[]): WikiFolder<T> {
  const root: WikiFolder<T> = { name: "", path: "", folders: [], pages: [] };
  for (const p of pages) {
    let node = root;
    for (const part of p.folder.split("/").filter(Boolean)) {
      const path = node.path ? `${node.path}/${part}` : part;
      let next = node.folders.find((f) => f.name === part);
      if (!next) {
        next = { name: part, path, folders: [], pages: [] };
        node.folders.push(next);
      }
      node = next;
    }
    node.pages.push(p);
  }
  const sort = (f: WikiFolder<T>) => {
    f.folders.sort((a, b) => a.name.localeCompare(b.name));
    f.pages.sort((a, b) => a.title.localeCompare(b.title));
    f.folders.forEach(sort);
  };
  sort(root);
  return root;
}

// The editor (web and phone): the `[[` being typed, and the toolbar's marks.

/** `[[que` right before the caret (no `]]` yet): the link being typed. */
export function wikiQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("[[");
  if (at < 0) return null;
  const query = before.slice(at + 2);
  if (/[\]\n[]/.test(query) || query.length > 80) return null;
  return { start: at, query };
}

/** Wraps the selection (or inserts a placeholder) and returns the new text and selection. */
export function wrapSelection(text: string, start: number, end: number, before: string, after = before, empty = "") {
  const selected = text.slice(start, end) || empty;
  const next = text.slice(0, start) + before + selected + after + text.slice(end);
  return { text: next, start: start + before.length, end: start + before.length + selected.length };
}

/** Prefixes each selected line ("## ", "- ", "- [ ] "). */
export function prefixLines(text: string, start: number, end: number, prefix: string) {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const block = text.slice(lineStart, end);
  const prefixed = block
    .split("\n")
    .map((l) => (l.startsWith(prefix) ? l : prefix + l))
    .join("\n");
  const next = text.slice(0, lineStart) + prefixed + text.slice(end);
  return { text: next, start: start + prefix.length, end: lineStart + prefixed.length };
}

/** Checks or unchecks the task on line `line` (`- [ ]` ↔ `- [x]`); the text as it was when that line is no task. */
export function toggleTask(body: string, line: number): string {
  const lines = body.split("\n");
  const at = lines[line];
  if (at === undefined) return body;
  const next = at.replace(/^(\s*[-*]\s+\[)([ xX])\]/, (_m, open: string, mark: string) =>
    mark === " " ? `${open}x]` : `${open} ]`,
  );
  if (next === at) return body;
  lines[line] = next;
  return lines.join("\n");
}

export interface Placed {
  slug: string;
  x: number;
  y: number;
}

/**
 * A small force-directed layout (no library): nodes repel, links pull,
 * everything drifts to the center. Deterministic (starts on a circle), so
 * the same graph always lands the same way.
 */
export function layoutGraph(
  graph: { nodes: { slug: string }[]; edges: { from: string; to: string }[] },
  width = 720,
  height = 460,
  steps = 240,
): Placed[] {
  const n = graph.nodes.length;
  if (n === 0) return [];
  const pos = graph.nodes.map((node, i) => {
    const a = (2 * Math.PI * i) / n;
    return {
      slug: node.slug,
      x: width / 2 + Math.cos(a) * width * 0.3,
      y: height / 2 + Math.sin(a) * height * 0.3,
      vx: 0,
      vy: 0,
    };
  });
  const index = new Map(pos.map((p, i) => [p.slug, i]));
  const edges = graph.edges
    .map((e) => [index.get(e.from), index.get(e.to)] as const)
    .filter((e): e is readonly [number, number] => e[0] !== undefined && e[1] !== undefined && e[0] !== e[1]);
  const k = Math.sqrt((width * height) / n) * 0.6;
  for (let step = 0; step < steps; step++) {
    const cool = 1 - step / steps;
    for (let i = 0; i < n; i++) {
      const a = pos[i] as (typeof pos)[number];
      for (let j = i + 1; j < n; j++) {
        const b = pos[j] as (typeof pos)[number];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) {
          dx = 0.1 * (i - j);
          dy = 0.1;
          d2 = dx * dx + dy * dy;
        }
        const f = (k * k) / d2;
        a.vx += dx * f * 0.02;
        a.vy += dy * f * 0.02;
        b.vx -= dx * f * 0.02;
        b.vy -= dy * f * 0.02;
      }
    }
    for (const [i, j] of edges) {
      const a = pos[i] as (typeof pos)[number];
      const b = pos[j] as (typeof pos)[number];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = ((d - k) / d) * 0.06;
      a.vx += dx * f;
      a.vy += dy * f;
      b.vx -= dx * f;
      b.vy -= dy * f;
    }
    for (const p of pos) {
      p.vx += (width / 2 - p.x) * 0.004;
      p.vy += (height / 2 - p.y) * 0.004;
      const max = 12 * cool + 1;
      p.x += Math.max(-max, Math.min(max, p.vx));
      p.y += Math.max(-max, Math.min(max, p.vy));
      p.vx *= 0.6;
      p.vy *= 0.6;
      p.x = Math.max(24, Math.min(width - 24, p.x));
      p.y = Math.max(24, Math.min(height - 24, p.y));
    }
  }
  return pos.map(({ slug, x, y }) => ({ slug, x: Math.round(x), y: Math.round(y) }));
}

/** What someone may do with a wiki page or folder. */
export type WikiLevel = "none" | "view" | "edit";

/** Who sees and who edits a page or a folder, as the server takes it: `null` lists mean everyone. */
export interface WikiAccess {
  audience: WikiAudience | null;
  agentIds: string[] | null;
  editors: WikiAudience | null;
  agentEditorIds: string[] | null;
}

/** The same as the "Quem vê" form holds it: a level for everyone, and one per role, person and agent. */
export interface WikiAccessDraft {
  people: WikiLevel;
  agents: WikiLevel;
  roles: Record<string, WikiLevel>;
  users: Record<string, WikiLevel>;
  agentRows: Record<string, WikiLevel>;
}

export const OPEN_WIKI_ACCESS: WikiAccess = { audience: null, agentIds: null, editors: null, agentEditorIds: null };

const rowLevels = (seen: string[] | null, editors: string[] | null) => {
  const rows: Record<string, WikiLevel> = {};
  for (const id of seen ?? []) rows[id] = !editors || editors.includes(id) ? "edit" : "view";
  if (!seen) for (const id of editors ?? []) rows[id] = "edit";
  return rows;
};

const baseLevel = (seen: unknown, editors: unknown): WikiLevel => (seen ? "none" : editors ? "view" : "edit");

export function wikiAccessDraft(a: WikiAccess): WikiAccessDraft {
  return {
    people: baseLevel(a.audience, a.editors),
    agents: baseLevel(a.agentIds, a.agentEditorIds),
    roles: rowLevels(a.audience?.roleIds ?? null, a.editors?.roleIds ?? null),
    users: rowLevels(a.audience?.userIds ?? null, a.editors?.userIds ?? null),
    agentRows: rowLevels(a.agentIds, a.agentEditorIds),
  };
}

const idsAt = (rows: Record<string, WikiLevel>, levels: WikiLevel[]) =>
  Object.keys(rows).filter((id) => levels.includes(rows[id] ?? "none"));

/** The lists a draft saves as. With a list of who sees, an editors' list exists only if someone on it just views. */
export function wikiAccessOf(d: WikiAccessDraft): WikiAccess {
  const viewers = [...idsAt(d.roles, ["view"]), ...idsAt(d.users, ["view"])];
  const editors = { roleIds: idsAt(d.roles, ["edit"]), userIds: idsAt(d.users, ["edit"]) };
  const agentEditors = idsAt(d.agentRows, ["edit"]);
  return {
    audience:
      d.people === "none"
        ? { roleIds: idsAt(d.roles, ["view", "edit"]), userIds: idsAt(d.users, ["view", "edit"]) }
        : null,
    agentIds: d.agents === "none" ? idsAt(d.agentRows, ["view", "edit"]) : null,
    editors: d.people === "view" || (d.people === "none" && viewers.length > 0) ? editors : null,
    agentEditorIds:
      d.agents === "view" || (d.agents === "none" && idsAt(d.agentRows, ["view"]).length > 0) ? agentEditors : null,
  };
}

/** Whether a draft limits anything. */
export const wikiAccessLimited = (a: WikiAccess) => Boolean(a.audience || a.agentIds || a.editors || a.agentEditorIds);

/** Levels for "everyone" that stay inside a limited folder: it can only be narrower. */
export function wikiBaseLevels(cap: WikiLevel): WikiLevel[] {
  return cap === "edit" ? ["edit", "view", "none"] : cap === "view" ? ["view", "none"] : ["none"];
}

/** The most one row may reach inside a limited folder (`base`: the folder's level for everyone). */
export function wikiRowCap(base: WikiLevel, row: WikiLevel | undefined): WikiLevel {
  if (base === "edit") return "edit";
  if (base === "view") return row === "edit" ? "edit" : "view";
  return row ?? "none";
}

type Imported = Pick<WikiPageSummary, "sourceType" | "sourceName" | "importId">;

/**
 * Everything `page`'s import brought, and the target that deletes it: by the import's id, or by vault for pages
 * imported before imports had ids. Null for a page that wasn't imported.
 */
export function wikiImportOf<T extends Imported>(
  pages: T[],
  page: Imported,
): { name: string; pages: T[]; target: WikiBulkTarget } | null {
  const name = page.sourceName;
  if (page.sourceType !== "obsidian" || !name) return null;
  if (page.importId) {
    const importId = page.importId;
    return { name, pages: pages.filter((p) => p.importId === importId), target: { importId } };
  }
  return {
    name,
    pages: pages.filter((p) => p.sourceType === page.sourceType && p.sourceName === name && !p.importId),
    target: { source: { type: page.sourceType, name } },
  };
}

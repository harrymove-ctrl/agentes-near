import type { ArtifactContent, ArtifactKind, ArtifactRef } from "../api/types";

/** What the Drive filters by: a block or a poll lives in its conversation (ADR 0113). */
export const ARTIFACT_KINDS: ArtifactKind[] = ["document", "table", "diff", "diagram", "html", "file"];

/** Each kind's design system icon (names from `@agenteschat/ui`'s `IconName`). */
export const KIND_ICON = {
  document: "document",
  table: "table",
  diff: "code",
  diagram: "diagram",
  html: "page",
  file: "file",
  block: "page",
  poll: "check",
  choices: "check",
} as const satisfies Record<ArtifactKind, string>;

export const isArtifactKind = (v: unknown): v is ArtifactKind => ARTIFACT_KINDS.includes(v as ArtifactKind);

/**
 * The whole text a viewer's "Copiar texto" takes: a document's Markdown, an HTML page's source, a diagram's Mermaid,
 * a text file's text (code, JSON, Markdown, HTML…, as the server sends it for a file small enough to show). None for
 * anything else.
 */
export function artifactText(content: ArtifactContent): string | undefined {
  if (content.kind === "document") return content.markdown;
  if (content.kind === "html") return content.html;
  if (content.kind === "diagram") return content.mermaid;
  return content.kind === "file" ? content.text : undefined;
}

/** `message.meta.artifacts` entries we can show: each file once, at its newest version (where it first came). */
export function artifactRefs(meta: Record<string, unknown> | undefined): ArtifactRef[] {
  const list = meta?.artifacts;
  if (!Array.isArray(list)) return [];
  const byId = new Map<string, ArtifactRef>();
  for (const r of list) {
    if (!r || typeof r !== "object" || typeof r.id !== "string") continue;
    if (typeof r.version !== "number" && r.deleted !== true) continue;
    const seen = byId.get(r.id) as { version?: number } | undefined;
    // Same file again: the newer version wins, in the first one's place.
    if (!seen || (typeof r.version === "number" && r.version >= (seen.version ?? 0))) byId.set(r.id, r as ArtifactRef);
  }
  return [...byId.values()];
}

// ── Diffs ────────────────────────────────────────────────────────────────────

export type PatchLine =
  | { kind: "same" | "add" | "del"; text: string; old: number | null; new: number | null }
  | { kind: "hunk"; text: string; old: null; new: null };

/** Unified patch hunks → lines with old/new line numbers. */
export function parsePatch(patch: string): PatchLine[] {
  const out: PatchLine[] = [];
  let oldN = 0;
  let newN = 0;
  for (const raw of patch.replace(/\r\n?/g, "\n").split("\n")) {
    if (raw.startsWith("--- ") || raw.startsWith("+++ ") || raw.startsWith("diff ") || raw.startsWith("index "))
      continue;
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (hunk) {
      oldN = Number(hunk[1]);
      newN = Number(hunk[2]);
      out.push({ kind: "hunk", text: raw, old: null, new: null });
      continue;
    }
    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
    if (raw.startsWith("+")) out.push({ kind: "add", text: raw.slice(1), old: null, new: newN++ });
    else if (raw.startsWith("-")) out.push({ kind: "del", text: raw.slice(1), old: oldN++, new: null });
    else if (raw.startsWith(" ") || (raw === "" && out.length > 0)) {
      out.push({ kind: "same", text: raw.slice(1), old: oldN++, new: newN++ });
    }
  }
  // A trailing newline in the patch is not a context line.
  while (out.length && out[out.length - 1]?.kind === "same" && out[out.length - 1]?.text === "") out.pop();
  return out;
}

export function patchCounts(patch: string) {
  let added = 0;
  let removed = 0;
  for (const l of parsePatch(patch)) {
    if (l.kind === "add") added++;
    if (l.kind === "del") removed++;
  }
  return { added, removed };
}

export interface SideRow {
  hunk?: string;
  left: { n: number; text: string; kind: "same" | "del" } | null;
  right: { n: number; text: string; kind: "same" | "add" } | null;
}

/** Pairs removed and added lines of each change block for the side-by-side view. */
export function sideBySide(lines: PatchLine[]): SideRow[] {
  const rows: SideRow[] = [];
  let dels: PatchLine[] = [];
  let adds: PatchLine[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) {
      const d = dels[i];
      const a = adds[i];
      rows.push({
        left: d ? { n: d.old ?? 0, text: d.text, kind: "del" } : null,
        right: a ? { n: a.new ?? 0, text: a.text, kind: "add" } : null,
      });
    }
    dels = [];
    adds = [];
  };
  for (const l of lines) {
    if (l.kind === "del") dels.push(l);
    else if (l.kind === "add") adds.push(l);
    else {
      flush();
      if (l.kind === "hunk") rows.push({ hunk: l.text, left: null, right: null });
      else
        rows.push({
          left: { n: l.old ?? 0, text: l.text, kind: "same" },
          right: { n: l.new ?? 0, text: l.text, kind: "same" },
        });
    }
  }
  flush();
  return rows;
}

// ── Tables ───────────────────────────────────────────────────────────────────

export function toCsv(columns: string[], rows: string[][]) {
  const q = (v: string) => (/[",\n;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [columns, ...rows].map((r) => r.map((c) => q(c ?? "")).join(",")).join("\n");
}

/** Number-aware sort ("1.234,5", "31", "2,6"), then text (locale). */
export function sortRows(rows: string[][], col: number, dir: "asc" | "desc", locale: string) {
  const num = (v: string) => {
    const s = v.trim().replace(/\s/g, "");
    if (!/^[-+]?[\d.,]+%?$/.test(s)) return null;
    const normalized = s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s;
    const n = Number.parseFloat(normalized);
    return Number.isNaN(n) ? null : n;
  };
  const sorted = [...rows].sort((a, b) => {
    const x = a[col] ?? "";
    const y = b[col] ?? "";
    const nx = num(x);
    const ny = num(y);
    const c = nx !== null && ny !== null ? nx - ny : x.localeCompare(y, locale, { sensitivity: "base" });
    return dir === "asc" ? c : -c;
  });
  return sorted;
}

// ── Files ────────────────────────────────────────────────────────────────────

/** The name a download gets. Without the content (a Drive list row), uploaded files go by their title. */
export function fileName(title: string, content: ArtifactContent | { kind: ArtifactKind }, table: "csv" = "csv") {
  // Uploaded files keep their original name.
  if (content.kind === "file") return "name" in content ? content.name : title;
  const slug =
    title
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^\w]+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase() || "arquivo";
  const ext = {
    document: "md",
    table,
    diff: "patch",
    diagram: "mmd",
    html: "html",
    block: "html",
    poll: "json",
    choices: "json",
  }[content.kind];
  return `${slug}.${ext}`;
}

/** The start of a document for a tile's cover: at most `max` characters, cut at a line (never half a block's marks). */
export function documentStart(markdown: string, max: number) {
  if (markdown.length <= max) return markdown;
  const cut = markdown.slice(0, max);
  const line = cut.lastIndexOf("\n");
  return line > max / 2 ? cut.slice(0, line) : cut;
}

/** The first `limit` lines of a CSV or TSV, quotes understood ("a, b" in quotes is one cell). */
export function parseDelimited(text: string, sep: string, limit: number): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length && rows.length < limit; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (rows.length < limit && (cell || row.length)) rows.push([...row, cell]);
  return rows;
}

/** First lines of a document, without Markdown marks or code (card preview). */
export function documentPreview(markdown: string, lines = 3) {
  const out: string[] = [];
  let fenced = false;
  for (const raw of markdown.split("\n")) {
    if (/^\s*```/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const l = raw
      .replace(/^#{1,6}\s+/, "")
      .replace(/^\s*([-*+>]|\d+[.)])\s+/, "")
      .replace(/[*_`]/g, "")
      .trim();
    if (l) out.push(l);
    if (out.length === lines) break;
  }
  return out;
}

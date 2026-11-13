import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { parseTrueType, type TrueTypeFont } from "./ttf";

/**
 * Markdown → PDF, in pure TypeScript (no headless browser, no dependency):
 * headings, paragraphs with **bold**, *italic* and `code`, bullet and
 * numbered lists, quotes, code blocks in a monospace font, tables and rules.
 * Uses our brand fonts when their files are there (Onest for text, Martian
 * Mono for code; embedded as subsets, any Unicode they cover), else the PDF
 * standard fonts (Helvetica, Courier) with WinAnsi encoding, which covers
 * Portuguese; characters outside it become "?".
 */

type FontKey = "F1" | "F2" | "F3" | "F4";
interface Run {
  text: string;
  font: FontKey;
}

const PAGE = { width: 595.28, height: 841.89, margin: 56 };
const CONTENT_WIDTH = PAGE.width - 2 * PAGE.margin;

// Advance widths (1/1000 em) of ASCII 32..126 in Helvetica and Helvetica-Bold (standard AFM metrics).
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833,
  722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556,
  556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334,
  260, 334, 584,
];
const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833,
  722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611,
  556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389,
  280, 389, 584,
];

/** WinAnsi bytes for the characters outside Latin-1 that it does have. */
const WIN_ANSI_EXTRA: Record<string, number> = {
  "€": 0x80,
  "‚": 0x82,
  "„": 0x84,
  "…": 0x85,
  "‘": 0x91,
  "’": 0x92,
  "“": 0x93,
  "”": 0x94,
  "•": 0x95,
  "–": 0x96,
  "—": 0x97,
  "™": 0x99,
};

function toWinAnsi(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 63;
    if (code >= 32 && code <= 126) out.push(code);
    else if (code >= 160 && code <= 255) out.push(code);
    else if (WIN_ANSI_EXTRA[ch] !== undefined) out.push(WIN_ANSI_EXTRA[ch] as number);
    else if (ch === "\t") out.push(32, 32);
    else out.push(63);
  }
  return out;
}

// ── Brand fonts (OFL; files in packages/engine/assets/fonts) ─────────────────

interface Brand {
  F1: TrueTypeFont;
  F2: TrueTypeFont;
  F3: TrueTypeFont;
}

let brand: Brand | null | undefined;

/** Onest Regular/Bold and Martian Mono, read once; null when the files aren't there (fallback: standard fonts). */
export function brandFonts(): Brand | null {
  if (brand !== undefined) return brand;
  try {
    const load = (file: string, name: string) =>
      parseTrueType(
        new Uint8Array(readFileSync(fileURLToPath(new URL(`../assets/fonts/${file}`, import.meta.url)))),
        name,
      );
    brand = {
      F1: load("Onest-Regular.ttf", "Onest-Regular"),
      F2: load("Onest-Bold.ttf", "Onest-Bold"),
      F3: load("MartianMono-Regular.ttf", "MartianMono-Regular"),
    };
  } catch {
    brand = null;
  }
  return brand;
}

/** Fonts of one document: brand (embedded, glyphs used are tracked) or the standard ones. */
let active: Brand | null = null;
let usedGlyphs: Record<"F1" | "F2" | "F3", Map<number, number>> = { F1: new Map(), F2: new Map(), F3: new Map() };
/** Italic has no file of its own: the regular face, slanted. */
const brandKey = (font: FontKey) => (font === "F4" ? "F1" : font);

function charWidth(ch: string, font: FontKey): number {
  if (active) {
    const f = active[brandKey(font)];
    const gid = f.glyphOf(ch.codePointAt(0) ?? 63);
    return (f.advance(gid) * 1000) / f.unitsPerEm;
  }
  if (font === "F3") return 600; // Courier
  const base = ch.normalize("NFD").charAt(0);
  const code = base.charCodeAt(0);
  const table = font === "F2" ? HELVETICA_BOLD : HELVETICA;
  if (code >= 32 && code <= 126) return table[code - 32] ?? 556;
  if (ch === "—") return 1000;
  if (ch === "–" || ch === "•") return font === "F2" ? 556 : 556;
  return 556;
}

const textWidth = (text: string, font: FontKey, size: number) =>
  ([...text].reduce((w, ch) => w + charWidth(ch, font), 0) * size) / 1000;

/** Inline Markdown: **bold**, *italic* / _italic_, `code`, [text](url). */
function inlineRuns(text: string, base: FontKey = "F1"): Run[] {
  const runs: Run[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|_[^_\s][^_]*_|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const token = m[0];
    const at = m.index ?? 0;
    if (at > last) runs.push({ text: text.slice(last, at), font: base });
    if (token.startsWith("**")) runs.push({ text: token.slice(2, -2), font: "F2" });
    else if (token.startsWith("`")) runs.push({ text: token.slice(1, -1), font: "F3" });
    else if (token.startsWith("[")) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      runs.push({ text: link ? `${link[1]} (${link[2]})` : token, font: base });
    } else runs.push({ text: token.slice(1, -1), font: "F4" });
    last = at + token.length;
  }
  if (last < text.length) runs.push({ text: text.slice(last), font: base });
  return runs;
}

/** Breaks runs into lines that fit `width`, word by word (long words are split). */
function wrap(runs: Run[], size: number, width: number): Run[][] {
  const words: { text: string; font: FontKey; space: boolean }[] = [];
  for (const r of runs) {
    const parts = r.text.split(/(\s+)/);
    for (const p of parts) {
      if (p === "") continue;
      if (/^\s+$/.test(p)) {
        const prev = words.at(-1);
        if (prev) prev.space = true;
        continue;
      }
      words.push({ text: p, font: r.font, space: false });
    }
  }
  const lines: Run[][] = [];
  let line: Run[] = [];
  let used = 0;
  const push = (text: string, font: FontKey) => {
    const lastRun = line.at(-1);
    if (lastRun && lastRun.font === font) lastRun.text += text;
    else line.push({ text, font });
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as (typeof words)[number];
    let text = w.text;
    let wWidth = textWidth(text, w.font, size);
    if (used > 0 && used + wWidth > width) {
      lines.push(line);
      line = [];
      used = 0;
    }
    // Never on an empty remainder: in a width below 0 not even that fits, and the loop would never end.
    while (text && wWidth > width) {
      let cut = text.length;
      while (cut > 1 && textWidth(text.slice(0, cut), w.font, size) > width - used) cut--;
      push(text.slice(0, cut), w.font);
      lines.push(line);
      line = [];
      used = 0;
      text = text.slice(cut);
      wWidth = textWidth(text, w.font, size);
    }
    push(text, w.font);
    used += wWidth;
    if (w.space && i < words.length - 1) {
      push(" ", w.font);
      used += textWidth(" ", w.font, size);
    }
  }
  if (line.length > 0) lines.push(line);
  return lines.length > 0 ? lines : [[]];
}

export type MarkdownBlock =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "quote"; text: string }
  | { type: "code"; lines: string[] }
  | { type: "table"; rows: string[][] }
  | { type: "rule" };

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

/** Block-level Markdown, enough for reports and plans. */
export function parseMarkdown(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i++;
      continue;
    }
    if (line.trim().startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").trim().startsWith("```")) code.push(lines[i++] ?? "");
      i++;
      blocks.push({ type: "code", lines: code });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1]?.length ?? 1, text: heading[2] ?? "" });
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ type: "rule" });
      i++;
      continue;
    }
    if (line.trim().startsWith("|") && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? "")) {
      const rows = [cells(line)];
      i += 2;
      while (i < lines.length && (lines[i] ?? "").trim().startsWith("|")) rows.push(cells(lines[i++] ?? ""));
      blocks.push({ type: "table", rows });
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/;
    const numbered = /^\s*\d+[.)]\s+(.*)$/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line);
      const re = ordered ? numbered : bullet;
      const items: string[] = [];
      while (i < lines.length && re.test(lines[i] ?? "")) items.push(re.exec(lines[i++] ?? "")?.[1] ?? "");
      blocks.push({ type: "list", ordered, items });
      continue;
    }
    if (line.startsWith(">")) {
      const quote: string[] = [];
      while (i < lines.length && (lines[i] ?? "").startsWith(">")) quote.push((lines[i++] ?? "").replace(/^>\s?/, ""));
      blocks.push({ type: "quote", text: quote.join(" ") });
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() !== "" &&
      !/^(#{1,6}\s|```|>|\s*[-*+]\s|\s*\d+[.)]\s|\s*\|)/.test(lines[i] ?? "")
    ) {
      para.push((lines[i++] ?? "").trim());
    }
    if (para.length === 0) {
      para.push(line.trim());
      i++;
    }
    blocks.push({ type: "paragraph", text: para.join(" ") });
  }
  return blocks;
}

/** Collects drawing operators page by page. */
class Canvas {
  pages: string[][] = [[]];
  y = PAGE.height - PAGE.margin;

  private get ops() {
    return this.pages[this.pages.length - 1] as string[];
  }

  ensure(height: number) {
    if (this.y - height < PAGE.margin) {
      this.pages.push([]);
      this.y = PAGE.height - PAGE.margin;
    }
  }

  text(runs: Run[], x: number, baseline: number, size: number) {
    let cursor = x;
    for (const r of runs) {
      if (!r.text) continue;
      if (active) {
        const key = brandKey(r.font);
        const f = active[key];
        let hex = "";
        for (const ch of r.text) {
          const cp = ch === "\t" ? 32 : (ch.codePointAt(0) ?? 63);
          const gid = f.glyphOf(cp);
          usedGlyphs[key].set(gid, cp);
          hex += gid.toString(16).padStart(4, "0");
        }
        // Italic: the regular face with an 12° slant.
        const at =
          r.font === "F4"
            ? `1 0 0.21 1 ${cursor.toFixed(2)} ${baseline.toFixed(2)} Tm`
            : `${cursor.toFixed(2)} ${baseline.toFixed(2)} Td`;
        this.ops.push(`BT /${key} ${size} Tf ${at} <${hex}> Tj ET`);
      } else {
        this.ops.push(
          `BT /${r.font} ${size} Tf ${cursor.toFixed(2)} ${baseline.toFixed(2)} Td (${escapePdfString(r.text)}) Tj ET`,
        );
      }
      cursor += textWidth(r.text, r.font, size);
    }
  }

  rect(x: number, y: number, w: number, h: number, gray: number, fill: boolean) {
    this.ops.push(
      `${gray} ${fill ? "g" : "G"} ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re ${fill ? "f" : "S"} 0 g 0 G`,
    );
  }

  line(x1: number, y1: number, x2: number, y2: number, gray: number) {
    this.ops.push(`${gray} G 0.6 w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S 0 G`);
  }

  /** Wrapped runs from the current position; returns nothing, moves `y`. */
  paragraph(runs: Run[], options: { size: number; leading: number; indent?: number; width?: number; before?: string }) {
    const indent = options.indent ?? 0;
    const width = options.width ?? CONTENT_WIDTH - indent;
    const lines = wrap(runs, options.size, width);
    lines.forEach((line, n) => {
      this.ensure(options.leading);
      this.y -= options.leading;
      if (n === 0 && options.before) {
        this.text([{ text: options.before, font: "F1" }], PAGE.margin + indent - 14, this.y, options.size);
      }
      this.text(line, PAGE.margin + indent, this.y, options.size);
    });
  }
}

function escapePdfString(text: string) {
  return String.fromCharCode(...toWinAnsi(text))
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

/** Narrower than this, a column holds a few letters a line: a table with more columns goes on in tables below it. */
const MIN_COLUMN_WIDTH = 40;

function drawTable(c: Canvas, rows: string[][]) {
  const columns = Math.max(1, ...rows.map((r) => r.length));
  const tables = Math.ceil(columns / Math.floor(CONTENT_WIDTH / MIN_COLUMN_WIDTH));
  // The columns shared out evenly (13 columns: 6, then 7).
  for (let t = 0; t < tables; t++) {
    const from = Math.floor((t * columns) / tables);
    const to = Math.floor(((t + 1) * columns) / tables);
    drawColumns(
      c,
      rows.map((r) => r.slice(from, to)),
      to - from,
    );
  }
}

function drawColumns(c: Canvas, rows: string[][], columns: number) {
  const colWidth = CONTENT_WIDTH / columns;
  const size = 9.5;
  const leading = 12.5;
  const pad = 4;
  rows.forEach((row, r) => {
    const wrapped = Array.from({ length: columns }, (_, k) =>
      wrap(inlineRuns(row[k] ?? "", r === 0 ? "F2" : "F1"), size, colWidth - 2 * pad),
    );
    const height = Math.max(...wrapped.map((w) => w.length)) * leading + 2 * pad;
    c.ensure(height);
    const top = c.y;
    if (r === 0) c.rect(PAGE.margin, top - height, CONTENT_WIDTH, height, 0.93, true);
    wrapped.forEach((lines, k) => {
      lines.forEach((line, n) => {
        c.text(line, PAGE.margin + k * colWidth + pad, top - pad - (n + 1) * leading + 3, size);
      });
    });
    c.line(PAGE.margin, top - height, PAGE.margin + CONTENT_WIDTH, top - height, 0.75);
    c.y = top - height;
  });
  c.y -= 8;
}

/** Renders Markdown (and an optional title) as a PDF document. */
export function markdownToPdf(
  markdown: string,
  options: { title?: string; fonts?: "brand" | "standard" } = {},
): Uint8Array {
  active = options.fonts === "standard" ? null : brandFonts();
  usedGlyphs = { F1: new Map(), F2: new Map(), F3: new Map() };
  try {
    return renderPdf(markdown, options);
  } finally {
    active = null;
  }
}

function renderPdf(markdown: string, options: { title?: string }): Uint8Array {
  const c = new Canvas();
  if (options.title) c.paragraph([{ text: options.title, font: "F2" }], { size: 22, leading: 28 });
  if (options.title) c.y -= 10;
  for (const block of parseMarkdown(markdown)) {
    switch (block.type) {
      case "heading": {
        const size = block.level === 1 ? 18 : block.level === 2 ? 15 : 12.5;
        c.y -= block.level === 1 ? 10 : 8;
        c.paragraph(inlineRuns(block.text, "F2"), { size, leading: size * 1.35 });
        c.y -= 4;
        break;
      }
      case "paragraph":
        c.paragraph(inlineRuns(block.text), { size: 11, leading: 15.5 });
        c.y -= 7;
        break;
      case "quote":
        c.paragraph(inlineRuns(block.text, "F4"), { size: 11, leading: 15.5, indent: 16 });
        c.y -= 7;
        break;
      case "list":
        block.items.forEach((item, n) => {
          const before = block.ordered ? `${n + 1}.` : "•";
          c.paragraph(inlineRuns(item), { size: 11, leading: 15.5, indent: 18, before });
          c.y -= 2;
        });
        c.y -= 5;
        break;
      case "code": {
        const size = 9.5;
        const leading = 12.5;
        // Monospace: split long lines by character count, keeping every space.
        const perLine = Math.floor((CONTENT_WIDTH - 16) / ((charWidth("M", "F3") * size) / 1000));
        for (const raw of block.lines.length > 0 ? block.lines : [""]) {
          const text = raw.replace(/\t/g, "  ");
          for (let at = 0; at === 0 || at < text.length; at += perLine) {
            c.ensure(leading);
            c.rect(PAGE.margin, c.y - leading, CONTENT_WIDTH, leading, 0.95, true);
            c.y -= leading;
            c.text([{ text: text.slice(at, at + perLine), font: "F3" }], PAGE.margin + 8, c.y + 3, size);
          }
        }
        c.y -= 9;
        break;
      }
      case "table":
        drawTable(c, block.rows);
        break;
      case "rule":
        c.ensure(12);
        c.y -= 6;
        c.line(PAGE.margin, c.y, PAGE.margin + CONTENT_WIDTH, c.y, 0.7);
        c.y -= 8;
        break;
    }
  }
  return writePdf(c.pages, options.title ?? "Documento");
}

/** Assembles the PDF file: catalog, pages, standard fonts, content streams, xref. */
function writePdf(pages: string[][], title: string): Uint8Array {
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length;
  };
  const catalog = add("");
  const pagesId = add("");
  const fonts: Record<string, number> = active
    ? {
        F1: embedFont(add, active.F1, usedGlyphs.F1),
        F2: embedFont(add, active.F2, usedGlyphs.F2),
        F3: embedFont(add, active.F3, usedGlyphs.F3),
      }
    : {
        F1: add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"),
        F2: add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"),
        F3: add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>"),
        F4: add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>"),
      };
  const fontRefs = Object.entries(fonts)
    .map(([k, id]) => `/${k} ${id} 0 R`)
    .join(" ");
  const pageIds: number[] = [];
  for (const ops of pages) {
    const stream = ops.join("\n");
    const content = add(`<< /Length ${latin1Length(stream)} >>\nstream\n${stream}\nendstream`);
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] /Resources << /Font << ${fontRefs} >> >> /Contents ${content} 0 R >>`,
      ),
    );
  }
  const info = add(`<< /Title (${escapePdfString(title)}) /Producer (agentes.chat) >>`);
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] =
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

  let out = "%PDF-1.4\n%âãÏÓ\n";
  const offsets: number[] = [];
  objects.forEach((body, n) => {
    offsets.push(latin1Length(out));
    out += `${n + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = latin1Length(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}

/** Every char of the assembled file is one byte (WinAnsi), so length in bytes = length in chars. */
const latin1Length = (s: string) => s.length;

const bytesToLatin1 = (bytes: Uint8Array) => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return out;
};

/**
 * A TrueType font as a Type0 / CIDFontType2 with Identity-H (two-byte glyph
 * ids in the text), the glyph subset as FontFile2 (deflated), widths of the
 * glyphs used and a ToUnicode map so text can be copied and searched.
 */
function embedFont(add: (body: string) => number, f: TrueTypeFont, used: Map<number, number>) {
  const scale = 1000 / f.unitsPerEm;
  const file = deflateSync(f.subset(used.keys()));
  const fontFile = add(`<< /Length ${file.length} /Filter /FlateDecode >>\nstream\n${bytesToLatin1(file)}\nendstream`);
  const descriptor = add(
    `<< /Type /FontDescriptor /FontName /${f.name} /Flags 32 /FontBBox [${f.bbox.map((v) => Math.round(v * scale)).join(" ")}] /ItalicAngle 0 /Ascent ${Math.round(f.ascent * scale)} /Descent ${Math.round(f.descent * scale)} /CapHeight ${Math.round(f.capHeight * scale)} /StemV 80 /FontFile2 ${fontFile} 0 R >>`,
  );
  const gids = [...used.keys()].sort((a, b) => a - b);
  const widths = gids.map((g) => `${g} [${Math.round(f.advance(g) * scale)}]`).join(" ");
  const cid = add(
    `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${f.name} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descriptor} 0 R /CIDToGIDMap /Identity /DW ${Math.round(f.advance(0) * scale)} /W [${widths}] >>`,
  );
  const hex4 = (n: number) => n.toString(16).padStart(4, "0");
  const utf16 = (cp: number) => {
    if (cp <= 0xffff) return hex4(cp);
    const v = cp - 0x10000;
    return hex4(0xd800 + (v >> 10)) + hex4(0xdc00 + (v & 0x3ff));
  };
  const entries = gids.filter((g) => g !== 0).map((g) => `<${hex4(g)}> <${utf16(used.get(g) ?? 63)}>`);
  const chunks: string[] = [];
  for (let i = 0; i < entries.length; i += 100) {
    const part = entries.slice(i, i + 100);
    chunks.push(`${part.length} beginbfchar\n${part.join("\n")}\nendbfchar`);
  }
  const cmap = [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /Adobe-Identity-UCS def",
    "/CMapType 2 def",
    "1 begincodespacerange",
    "<0000> <ffff>",
    "endcodespacerange",
    ...chunks,
    "endcmap",
    "CMapName currentdict /CMap defineresource pop",
    "end",
    "end",
  ].join("\n");
  const toUnicode = add(`<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream`);
  return add(
    `<< /Type /Font /Subtype /Type0 /BaseFont /${f.name} /Encoding /Identity-H /DescendantFonts [${cid} 0 R] /ToUnicode ${toUnicode} 0 R >>`,
  );
}

import { EVERYONE_WORDS } from "@agenteschat/i18n/everyone";

/**
 * The parsing half of a small, safe Markdown renderer for chat messages and
 * artifact documents: headings, paragraphs, lists, quotes, rules, GFM tables,
 * fenced code, inline code, bold, italic, ~~strikethrough~~, links and bare
 * URLs, and with `details`, collapsed blocks (`detailsAt`). Each platform renders the blocks with its own elements
 * (the web: `apps/web/src/lib/markdown.tsx`); other raw HTML is never interpreted. Links
 * allow http(s) and mailto (`SAFE_URL`); @mentions follow `MENTION`.
 */
export type MdBlock =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "code"; lang: string; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "quote"; text: string; lines: string[] }
  | { type: "embed"; target: string }
  | { type: "rule" }
  | { type: "table"; header: string[]; rows: string[][]; align: TableAlign[] }
  /** Collapsed until opened (`detailsAt`): `body` is Markdown of its own. */
  | { type: "details"; summary: string; body: string };

/** A column's alignment: from the separator (`:---`, `:---:`, `---:`), else right when every cell is a number. */
export type TableAlign = "left" | "center" | "right";

const LIST = /^\s*([-*+]|\d+[.)])\s+(.*)$/;
const splitRow = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
// "429", "-17,2%", "~6,7%", "R$ 1.200", "$3.5k": numbers as people write them in a table.
const NUMERIC = /^[~≈<>+-]?\s*(R\$|US\$|\$|€)?\s*[+-]?\d[\d.,\s]*(%|k|mil|mi|x)?$/i;

/**
 * A GFM table starting at `lines[i]` (a row with pipes, then the `|---|` rule), or null. Shared by the
 * web and the phone app, so a table is a table anywhere in a message (also right under a sentence).
 */
export function tableAt(
  lines: readonly string[],
  i: number,
): { table: Extract<MdBlock, { type: "table" }>; next: number } | null {
  const line = lines[i] ?? "";
  const rule = lines[i + 1] ?? "";
  if (!line.includes("|") || !TABLE_RULE.test(rule)) return null;
  const header = splitRow(line);
  const marks = splitRow(rule);
  const rows: string[][] = [];
  let j = i + 2;
  while (j < lines.length && (lines[j] as string).includes("|") && (lines[j] as string).trim())
    rows.push(splitRow(lines[j++] as string));
  const align = header.map((_, c): TableAlign => {
    const m = marks[c] ?? "";
    if (m.startsWith(":") && m.endsWith(":")) return "center";
    if (m.endsWith(":")) return "right";
    if (m.startsWith(":")) return "left";
    const cells = rows.map((r) => (r[c] ?? "").replace(/[*_`]/g, "").trim()).filter(Boolean);
    return cells.length > 0 && cells.every((v) => NUMERIC.test(v)) ? "right" : "left";
  });
  return { table: { type: "table", header, rows, align }, next: j };
}

/** `<details>`, an optional `<summary>…</summary>`, then the start of the body, all on the line that opens it. */
export const DETAILS_OPEN = /^\s*<details>\s*(?:<summary>(.*?)<\/summary>)?(.*)$/i;
const SUMMARY = /^\s*<summary>(.*?)<\/summary>(.*)$/i;
/** `</details>` ends the line that closes the block, after the body's last words or on its own. */
export const DETAILS_CLOSE = /<\/details>\s*$/i;
const FENCE = /^\s*```/;

/**
 * A collapsed block starting at `lines[i]`, written as HTML's `<details>` (ADR 0147: agents put what only some want
 * to read there): `<details>`, a `<summary>…</summary>` (on that line or the next), the body in Markdown, and
 * `</details>` ending a line, so the whole block may sit on one line. One inside it, or in a fenced block, doesn't
 * close it; unclosed (still being written), it runs to the end. Null when the line opens none. Shared by the web and
 * the phone app.
 */
export function detailsAt(
  lines: readonly string[],
  i: number,
): { details: Extract<MdBlock, { type: "details" }>; next: number } | null {
  const open = (lines[i] ?? "").match(DETAILS_OPEN);
  if (!open) return null;
  let j = i + 1;
  let summary = open[1];
  let first = open[2] ?? "";
  const own = summary === undefined && !first.trim() ? (lines[j] ?? "").match(SUMMARY) : null;
  if (own) {
    summary = own[1];
    first = own[2] ?? "";
    j++;
  }
  const body: string[] = [];
  const done = (next: number) => ({
    details: { type: "details" as const, summary: (summary ?? "").trim(), body: body.join("\n").trim() },
    next,
  });
  const closeAt = (line: string) => line.match(DETAILS_CLOSE)?.index;
  const end = closeAt(first);
  body.push(first.slice(0, end));
  if (end !== undefined) return done(j);
  let depth = 0;
  let fence = false;
  for (; j < lines.length; j++) {
    const line = lines[j] as string;
    if (FENCE.test(line)) fence = !fence;
    else if (!fence) {
      const opens = DETAILS_OPEN.test(line);
      const close = closeAt(line);
      if (opens && close === undefined) depth++;
      else if (!opens && close !== undefined && depth-- === 0) {
        body.push(line.slice(0, close));
        return done(j + 1);
      }
    }
    body.push(line);
  }
  return done(lines.length);
}

/** A block and the source lines it came from (`[first, end)`), for an editor that keeps untouched blocks as written. */
export type MdRangedBlock = MdBlock & { range: [number, number] };

/** `details`: `<details>` blocks become `details` (`detailsAt`) instead of text; off for editors that keep the source. */
type ParseOptions = { breaks?: boolean; details?: boolean };
export function parseMarkdown(source: string, options: ParseOptions & { ranges: true }): MdRangedBlock[];
export function parseMarkdown(source: string, options?: ParseOptions & { ranges?: false }): MdBlock[];
export function parseMarkdown(source: string, options: ParseOptions & { ranges?: boolean } = {}): MdBlock[] {
  const join = options.breaks ? "\n" : " ";
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out: MdBlock[] = [];
  let i = 0;
  let start = 0;
  // Each block is pushed once its lines are read (`i` is past them).
  const push = (b: MdBlock) => {
    const ranged: MdRangedBlock = { ...b, range: [start, i] };
    out.push(options.ranges ? ranged : b);
  };
  while (i < lines.length) {
    start = i;
    const line = lines[i] as string;
    const fence = line.match(/^\s*```\s*([\w+-]*)\s*$/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i] as string)) body.push(lines[i++] as string);
      i = Math.min(i + 1, lines.length);
      push({ type: "code", lang: fence[1] ?? "", text: body.join("\n") });
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      i++;
      push({ type: "heading", level: (heading[1] as string).length, text: heading[2] ?? "" });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      i++;
      push({ type: "rule" });
      continue;
    }
    const table = tableAt(lines, i);
    if (table) {
      i = table.next;
      push(table.table);
      continue;
    }
    const details = options.details ? detailsAt(lines, i) : null;
    if (details) {
      i = details.next;
      push(details.details);
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i] as string))
        body.push((lines[i++] as string).replace(/^\s*>\s?/, ""));
      push({ type: "quote", text: body.join(join), lines: body });
      continue;
    }
    // `![[foto.png]]` alone on its line: an Obsidian embed (an attachment or another note).
    const embed = line.match(/^\s*!\[\[([^[\]\n|]+)(?:\|[^\]\n]*)?\]\]\s*$/);
    if (embed) {
      i++;
      push({ type: "embed", target: (embed[1] ?? "").trim() });
      continue;
    }
    const item = line.match(LIST);
    if (item) {
      const ordered = /\d/.test(item[1] as string);
      const items: string[] = [];
      while (i < lines.length) {
        const m = (lines[i] as string).match(LIST);
        if (m && /\d/.test(m[1] as string) === ordered) {
          items.push(m[2] ?? "");
          i++;
        } else if (items.length && /^\s{2,}\S/.test(lines[i] as string)) {
          items[items.length - 1] += `${join}${(lines[i++] as string).trim()}`;
        } else break;
      }
      push({ type: "list", ordered, items });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i] as string;
      if (
        !l.trim() ||
        /^(#{1,6})\s|^\s*```|^\s*>/.test(l) ||
        LIST.test(l) ||
        (para.length && tableAt(lines, i)) ||
        (options.details && DETAILS_OPEN.test(l))
      )
        break;
      para.push(l.trim());
      i++;
    }
    push({ type: "paragraph", text: para.join(join) });
  }
  return out;
}

// Code, bold, italic (not inside words, so `snake_case` and URLs stay as typed), links, bare URLs,
// wiki links, ~~strikethrough~~.
export const INLINE =
  /(`[^`]+`)|(\*\*[^*]+?\*\*|__[^_]+?__)|((?<![\w*])\*[^*\s][^*]*?\*(?![\w*])|(?<![\w_])_[^_\s][^_]*?_(?![\w_]))|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])|(\[\[[^[\]\n]+\]\])|(~~[^~\s](?:[^~]*?[^~\s])?~~)/;
export const SAFE_URL = /^(https?:|mailto:)/i;

/**
 * A short line's `code` and **bold** spans in order, the rest as typed (a task's title, an option's label): only the
 * marks such a line carries, never a link or a mention that would take the press of what it sits in.
 */
export function codeAndBoldParts(text: string): { text: string; mark?: "code" | "bold" }[] {
  return text
    .split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g)
    .filter(Boolean)
    .map((part) =>
      part.length > 2 && part.startsWith("`") && part.endsWith("`")
        ? { text: part.slice(1, -1), mark: "code" as const }
        : part.length > 4 && part.startsWith("**") && part.endsWith("**")
          ? { text: part.slice(2, -2), mark: "bold" as const }
          : { text: part },
    );
}

/** The words for everyone outside the handles' letters (`@全員`, `@все`); the others are handles to `MENTION` already. */
const OTHER_SCRIPT_EVERYONE = EVERYONE_WORDS.filter((w) => !/^[a-z0-9_-]+$/.test(w));
/**
 * Same rule as the backend (`parseMentionHandles`): emails are not mentions. Also the mention of everyone in any
 * script (`@全員`), as the backend reads it (`mentionsEveryone`).
 */
export const MENTION = new RegExp(
  `(^|[^\\w@.])@([a-zA-Z0-9][a-zA-Z0-9_-]{1,31}(?![\\w@-])|(?:${OTHER_SCRIPT_EVERYONE.join("|")})(?![\\p{L}\\p{N}_@-]))`,
  "giu",
);

/** The first of `agents` a text @mentions, ignoring case as the backend does; undefined when it names none of them. */
export function firstMentioned<A extends { handle: string }>(text: string, agents: readonly A[]): A | undefined {
  for (const m of text.matchAll(MENTION)) {
    const handle = m[2]?.toLowerCase();
    const agent = agents.find((a) => a.handle.toLowerCase() === handle);
    if (agent) return agent;
  }
  return undefined;
}

/** Whether a text @mentions `handle`, ignoring case as the backend does. */
export function mentionsHandle(text: string, handle: string): boolean {
  const wanted = handle.toLowerCase();
  for (const m of text.matchAll(MENTION)) if (m[2]?.toLowerCase() === wanted) return true;
  return false;
}

/** `[[Processos/Onboarding|o onboarding]]` → { title: "Processos/Onboarding", label: "o onboarding" }. */
export function parseWikiToken(token: string) {
  const inner = token.slice(2, -2);
  const bar = inner.indexOf("|");
  const title = (bar >= 0 ? inner.slice(0, bar) : inner).trim();
  const label = (bar >= 0 ? inner.slice(bar + 1) : inner).trim() || title;
  return { title, label };
}

/**
 * Whether a `[[link]]` to no page reads as a page's name. A sentence in brackets (ends like one, or runs long) is an
 * agent's styling, so it shows as plain text instead of an offer to create a page of that name.
 */
export const readsAsPageTitle = (title: string) => title.length <= 80 && !/[.!?…:;]$/.test(title.trim());

/** Every `[[link]]` title in a text, in order, without repeats. */
export function wikiLinksIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?<!!)\[\[([^[\]\n]+)\]\]/g)) {
    const { title } = parseWikiToken(m[0]);
    if (title && !out.includes(title)) out.push(title);
  }
  return out;
}

/** An internal id in a text, after the word naming its kind when one does ("artifact 0193…", "id=0193…"). */
const INTERNAL_ID =
  /(\b(?:artifact|artefato|id)[ _]?(?:id)?\s*[:=]?\s*)?\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;

export interface InternalId {
  at: number;
  /** The id with the word naming its kind, as written. */
  text: string;
  /** Lower case. */
  id: string;
  /** Written as ours, as agents copy it from what they read ("artifact 0193…", "id=0193…"), not a bare one. */
  marked: boolean;
}

/**
 * The internal ids in a text, in order: the apps show what each names in its place (`splitIdRefs`), text with no pill
 * drops the marked ones (`plainInline`). Never one inside an address (`exemplo.com/x/0193…`, `?id=0193…`).
 */
export function internalIds(text: string): InternalId[] {
  const out: InternalId[] = [];
  for (const m of text.matchAll(INTERNAL_ID)) {
    const at = m.index ?? 0;
    if (/[/?&=#%.+@~-]/.test(text[at - 1] ?? "")) continue;
    out.push({ at, text: m[0], id: (m[2] ?? "").toLowerCase(), marked: /artifact|artefato|=/i.test(m[1] ?? "") });
  }
  return out;
}

/**
 * A text without its marked ids, nor the commas and brackets they leave ("(print, artifact 0193…)" → "(print)"). A
 * bare one stays: it may be the person's own (an order's).
 */
function withoutMarkedIds(text: string): string {
  const marked = internalIds(text).filter((m) => m.marked);
  if (marked.length === 0) return text;
  let out = "";
  let last = 0;
  for (const m of marked) {
    out += text.slice(last, m.at);
    last = m.at + m.text.length;
  }
  return `${out}${text.slice(last)}`
    .replace(/\(\s*[,;:]?\s*\)/g, "")
    .replace(/\s*[,;:]\s*(?=\))/g, "")
    .replace(/\(\s*[,;:]\s*/g, "(")
    .replace(/[ \t]+(?=[,.;:!?)])/g, "")
    .replace(/[ \t]{2,}/g, " ");
}

const INLINE_ALL = new RegExp(INLINE.source, "g");

/**
 * A line's words without its inline marks: links and wiki links as their labels, an image as its alt text. Nor an id
 * of ours an agent wrote, which no person reads (`withoutMarkedIds`).
 */
export const plainInline = (text: string): string =>
  withoutMarkedIds(
    text
      .replace(/!(?=\[)/g, "")
      .replace(INLINE_ALL, (tok, code, bold, em, link, _url, wiki, strike) =>
        code
          ? tok.slice(1, -1)
          : bold || strike
            ? plainInline(tok.slice(2, -2))
            : em
              ? plainInline(tok.slice(1, -1))
              : link
                ? plainInline(tok.slice(1, tok.indexOf("](")))
                : wiki
                  ? parseWikiToken(tok).label
                  : tok,
      ),
  );

/**
 * A Markdown text's prose as plain lines, the way a person reads it: each line of its paragraphs, list items
 * and quotes, without their marks. Headings, rules, code, tables and embeds are left out: they frame what it
 * says rather than say it.
 */
export function plainLines(source: string): string[] {
  return parseMarkdown(source, { breaks: true })
    .flatMap((b) =>
      b.type === "paragraph" ? [b.text] : b.type === "list" ? b.items : b.type === "quote" ? b.lines : [],
    )
    .flatMap((text) => text.split("\n"))
    .map((line) => looseMarks(plainInline(line)).replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** A table row that lost its table (a cut text): its cells, without the separator's. */
const rowCells = (line: string) => splitRow(line).filter((cell) => cell && !/^:?-+:?$/.test(cell));

/**
 * Marks left unpaired where a text was cut, and the tags of a collapsed block. `**` between spaces is a word ("2 ** 3").
 */
const looseMarks = (text: string) =>
  text.replace(/(?<=\S)(?:\*\*|~~)|(?:\*\*|~~)(?=\S)|`|<\/?(?:details|summary)>/gi, "");

const plainProse = (text: string) =>
  looseMarks(
    plainInline(
      text
        .split("\n")
        .map((line) => (/^\s*\|/.test(line) ? rowCells(line).join(" · ") : line))
        .join("\n"),
    ),
  );

/**
 * A Markdown text on one line, as whatever shows it outside the message reads it: previews, quotes, the inbox, push,
 * search. Every word stays, those of code blocks and tables too (it may be what was searched for), and no mark does.
 * `shown`: the most that will show, so a list of previews on the server's hot path never parses whole 40,000-character
 * bodies (marks and addresses take room, hence the margin).
 */
export function plainLine(source: string, shown = Number.POSITIVE_INFINITY): string {
  return parseMarkdown(source.slice(0, shown * 8), { breaks: true })
    .flatMap((b) => {
      if (b.type === "code") return [b.text];
      if (b.type === "paragraph" || b.type === "heading") return [plainProse(b.text)];
      if (b.type === "list") return b.items.map((item) => plainProse(item.replace(/^\[[ xX]\]\s+/, "")));
      if (b.type === "quote") return b.lines.map(plainProse);
      if (b.type === "table") return [...b.header, ...b.rows.flat()].map(plainProse);
      return b.type === "embed" ? [b.target] : [];
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A text with a code block or a table: it needs the conversation's whole width, never a bubble's. */
export const hasWideBlock = (source: string) =>
  /```|\|/.test(source) && parseMarkdown(source).some((b) => b.type === "code" || b.type === "table");

/** Heading anchor ids for the outline: "Como pedimos acesso" → "como-pedimos-acesso". */
export const headingId = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

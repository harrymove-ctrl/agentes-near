/**
 * Markdown formatting for a plain text box (the composer): pure functions
 * that take the text and the selection and return the new text and
 * selection. Wrapping toggles (a second press unwraps); line formats
 * (lists, quote) apply to every line the selection touches.
 */

export type FormatKind =
  | "bold"
  | "italic"
  | "strike"
  | "code"
  | "codeBlock"
  | "link"
  | "bulletList"
  | "numberedList"
  | "quote";

export const FORMAT_KINDS: FormatKind[] = [
  "bold",
  "italic",
  "strike",
  "code",
  "codeBlock",
  "link",
  "bulletList",
  "numberedList",
  "quote",
];

export interface TextEdit {
  value: string;
  start: number;
  end: number;
}

const MARKERS = { bold: "**", italic: "_", strike: "~~", code: "`" } as const;

/** Wraps the selection in `marker` ("**"), or unwraps it when it is already wrapped. */
export function wrapSelection(value: string, start: number, end: number, marker: string, placeholder = ""): TextEdit {
  const m = marker.length;
  const selected = value.slice(start, end);
  // "**|text|**": the markers sit right outside the selection.
  if (start >= m && value.slice(start - m, start) === marker && value.slice(end, end + m) === marker) {
    return {
      value: value.slice(0, start - m) + selected + value.slice(end + m),
      start: start - m,
      end: end - m,
    };
  }
  // "|**text**|": the selection includes them.
  if (selected.length >= 2 * m && selected.startsWith(marker) && selected.endsWith(marker)) {
    const inner = selected.slice(m, selected.length - m);
    return { value: value.slice(0, start) + inner + value.slice(end), start, end: start + inner.length };
  }
  // Spaces around the selection stay outside the markers ("**word** ", never "**word **").
  const lead = /^\s*/.exec(selected)?.[0] ?? "";
  const trail = selected.trim() ? (/\s*$/.exec(selected)?.[0] ?? "") : "";
  const core = selected.trim() ? selected.slice(lead.length, selected.length - trail.length) : placeholder;
  const before = value.slice(0, start) + (selected.trim() ? lead : selected);
  const next = `${before}${marker}${core}${marker}${trail}${value.slice(end)}`;
  const s = before.length + m;
  return { value: next, start: s, end: s + core.length };
}

/** A fenced code block around the selection (on lines of its own), or the fences removed. */
export function codeBlock(value: string, start: number, end: number, placeholder = ""): TextEdit {
  const selected = value.slice(start, end);
  const fenced = /^```[^\n]*\n([\s\S]*)\n```$/.exec(selected);
  if (fenced) {
    const inner = fenced[1] ?? "";
    return { value: value.slice(0, start) + inner + value.slice(end), start, end: start + inner.length };
  }
  const body = selected || placeholder;
  const open = start > 0 && value[start - 1] !== "\n" ? "\n```\n" : "```\n";
  const close = end < value.length && value[end] !== "\n" ? "\n```\n" : "\n```";
  const s = start + open.length;
  return { value: value.slice(0, start) + open + body + close + value.slice(end), start: s, end: s + body.length };
}

/** `[text](url)`: the selection becomes the text and the URL is selected to type over (a URL selection is both). */
export function linkSelection(value: string, start: number, end: number, labelPlaceholder = ""): TextEdit {
  const selected = value.slice(start, end);
  if (/^https?:\/\/\S+$/.test(selected)) {
    const next = `[${selected}](${selected})`;
    return {
      value: value.slice(0, start) + next + value.slice(end),
      start: start + 1,
      end: start + 1 + selected.length,
    };
  }
  const label = selected || labelPlaceholder;
  const url = "https://";
  const next = `[${label}](${url})`;
  const s = start + label.length + 3;
  return { value: value.slice(0, start) + next + value.slice(end), start: s, end: s + url.length };
}

const LIST_PREFIX = /^(\s*)([-*+]|\d+[.)])\s+/;
const QUOTE_PREFIX = /^>\s?/;

/** Bullets, numbers or quote marks on every line the selection touches (toggled off when all have them). */
export function prefixLines(value: string, start: number, end: number, kind: "bulletList" | "numberedList" | "quote") {
  const from = value.lastIndexOf("\n", start - 1) + 1;
  const nl = value.indexOf("\n", end > start && value[end - 1] === "\n" ? end - 1 : end);
  const to = nl < 0 ? value.length : nl;
  const lines = value.slice(from, to).split("\n");
  const has = (l: string) =>
    kind === "quote" ? QUOTE_PREFIX.test(l) : kind === "bulletList" ? /^\s*[-*+]\s+/.test(l) : /^\s*\d+[.)]\s+/.test(l);
  const filled = lines.filter((l) => l.trim());
  const remove = filled.length > 0 && filled.every(has);
  let n = 0;
  const next = lines.map((l) => {
    if (remove) return kind === "quote" ? l.replace(QUOTE_PREFIX, "") : l.replace(LIST_PREFIX, "$1");
    if (!l.trim() && lines.length > 1) return l;
    if (kind === "quote") return `> ${l}`;
    const bare = l.replace(LIST_PREFIX, "$1");
    n += 1;
    return `${kind === "bulletList" ? "- " : `${n}. `}${bare}`;
  });
  const text = next.join("\n");
  const out = value.slice(0, from) + text + value.slice(to);
  // One empty line: the caret goes after the new marker; else the touched lines stay selected.
  if (start === end && lines.length === 1 && !lines[0]?.trim()) {
    return { value: out, start: from + text.length, end: from + text.length };
  }
  return { value: out, start: from, end: from + text.length };
}

/** Applies a toolbar action to the text box's value and selection. */
export function applyFormat(
  value: string,
  start: number,
  end: number,
  kind: FormatKind,
  placeholders: { text?: string; code?: string; link?: string } = {},
): TextEdit {
  switch (kind) {
    case "bold":
    case "italic":
    case "strike":
      return wrapSelection(value, start, end, MARKERS[kind], placeholders.text ?? "");
    case "code":
      return wrapSelection(value, start, end, MARKERS.code, placeholders.code ?? "");
    case "codeBlock":
      return codeBlock(value, start, end, placeholders.code ?? "");
    case "link":
      return linkSelection(value, start, end, placeholders.link ?? "");
    default:
      return prefixLines(value, start, end, kind);
  }
}

/** Puts `text` in place of the selection; the caret lands right after it. */
export function insertText(value: string, start: number, end: number, text: string): TextEdit {
  const caret = start + text.length;
  return { value: value.slice(0, start) + text + value.slice(end), start: caret, end: caret };
}

/**
 * The keyboard shortcut for a format, if any: ⌘/Ctrl+B, I, E (code), K (link),
 * ⇧X (strikethrough), ⇧E (code block), ⇧7 (numbered), ⇧8 (bullets), ⇧9 (quote).
 */
export function formatShortcut(e: {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): FormatKind | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return null;
  const key = e.key.toLowerCase();
  if (!e.shiftKey) {
    if (key === "b") return "bold";
    if (key === "i") return "italic";
    if (key === "e") return "code";
    if (key === "k") return "link";
    return null;
  }
  if (key === "x") return "strike";
  if (key === "e") return "codeBlock";
  // With Shift the key is "&", "*", "(" (or other symbols elsewhere): the physical key says which.
  if (e.code === "Digit7" || key === "7") return "numberedList";
  if (e.code === "Digit8" || key === "8") return "bulletList";
  if (e.code === "Digit9" || key === "9") return "quote";
  return null;
}

/** The shortcut's keys for a tooltip ("⌘ B", "Ctrl ⇧ X"). */
export function formatShortcutHint(kind: FormatKind, mod: string): string | null {
  const keys: Partial<Record<FormatKind, string>> = {
    bold: "B",
    italic: "I",
    code: "E",
    link: "K",
    strike: "⇧ X",
    codeBlock: "⇧ E",
    numberedList: "⇧ 7",
    bulletList: "⇧ 8",
    quote: "⇧ 9",
  };
  const k = keys[kind];
  return k ? `${mod} ${k}` : null;
}

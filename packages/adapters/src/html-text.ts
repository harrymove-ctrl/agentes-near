/**
 * Outside HTML and text made safe to read (ADR 0117): one HTML-to-text converter for web pages, mail and
 * search results, which drops what a person never sees on the page (so hidden text can't speak to the
 * model), one cleaner for any outside text, which strips characters that hide or reorder text, and a
 * marker finder that sees through invisible characters and look-alike forms without changing the text.
 */

/** Bidi overrides and isolates: they reorder what a person sees on screen. */
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/gu;
/**
 * Unicode tag characters, an invisible ASCII side channel, except inside an emoji subdivision flag
 * (U+1F3F4, tags, cancel tag), which stays whole.
 */
const STRAY_TAGS = /(\u{1F3F4}[\u{E0020}-\u{E007E}]+\u{E007F})|[\u{E0000}-\u{E007F}]/gu;

/**
 * Outside text without the characters that hide or reorder text (bidi overrides and isolates, stray tag
 * characters). Everything else stays exactly as written (ZWJ emoji, RLM/LRM, ellipses, full-width forms), so
 * text an agent reads and writes back is unchanged; disguised markers are found by `replaceDisguised`.
 */
export function cleanOutside(text: string): string {
  return text.replace(BIDI_CONTROLS, "").replace(STRAY_TAGS, (_m, flag?: string) => flag ?? "");
}

/** Whether the text carries characters `cleanOutside` strips. */
export const hasInvisible = (text: string) => cleanOutside(text) !== text;

/**
 * Ignored when looking for a disguised marker: zero-width, joiners, bidi marks, soft hyphen, combining grapheme
 * joiner, Mongolian vowel separator, Hangul fillers, variation selectors and tag characters.
 */
const SKIPPED_IN_MARKERS =
  // biome-ignore lint/suspicious/noMisleadingCharacterClass: tested on one code point at a time, never on a sequence
  /[\u00AD\u034F\u115F\u1160\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\u3164\uFE00-\uFE0F\uFEFF]|[\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/u;

/** Look-alikes NFKC leaves alone, for the characters of envelope markers (Cyrillic, Greek, angle brackets, slashes). */
const CONFUSABLES: Record<string, string> = {
  а: "a",
  с: "c",
  ԁ: "d",
  е: "e",
  ɡ: "g",
  һ: "h",
  і: "i",
  ӏ: "l",
  о: "o",
  р: "p",
  ѕ: "s",
  т: "t",
  ս: "u",
  ԝ: "w",
  х: "x",
  α: "a",
  ε: "e",
  ι: "i",
  ο: "o",
  ρ: "p",
  τ: "t",
  υ: "u",
  А: "A",
  В: "B",
  С: "C",
  Е: "E",
  Н: "H",
  І: "I",
  М: "M",
  О: "O",
  Р: "P",
  Т: "T",
  Х: "X",
  "‹": "<",
  "〈": "<",
  "⟨": "<",
  "˂": "<",
  "›": ">",
  "〉": ">",
  "⟩": ">",
  "˃": ">",
  "∕": "/",
  "⁄": "/",
  "⧸": "/",
};

/**
 * `text` with every match of `pattern` (global) replaced, matching on a folded copy (invisible characters
 * skipped, NFKC and look-alike letters folded) so a disguised marker is found, while the rest of the text stays as
 * written. The replaced span covers the disguise.
 */
export function replaceDisguised(text: string, pattern: RegExp, replacement: string): string {
  let folded = "";
  const from: number[] = [];
  const to: number[] = [];
  let i = 0;
  for (const ch of text) {
    const end = i + ch.length;
    if (!SKIPPED_IN_MARKERS.test(ch)) {
      const f = CONFUSABLES[ch] ?? ch.normalize("NFKC");
      folded += f;
      for (let k = 0; k < f.length; k++) {
        from.push(i);
        to.push(end);
      }
    }
    i = end;
  }
  let out = "";
  let last = 0;
  for (const m of folded.matchAll(pattern)) {
    const start = from[m.index] ?? text.length;
    const stop = to[m.index + m[0].length - 1] ?? text.length;
    if (start < last) continue;
    out += text.slice(last, start) + replacement;
    last = stop;
  }
  return last === 0 ? text : out + text.slice(last);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  bull: "•",
  middot: "·",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  deg: "°",
  times: "×",
  divide: "÷",
  iexcl: "¡",
  iquest: "¿",
  aacute: "á",
  Aacute: "Á",
  agrave: "à",
  Agrave: "À",
  acirc: "â",
  Acirc: "Â",
  atilde: "ã",
  Atilde: "Ã",
  auml: "ä",
  ccedil: "ç",
  Ccedil: "Ç",
  eacute: "é",
  Eacute: "É",
  egrave: "è",
  ecirc: "ê",
  Ecirc: "Ê",
  euml: "ë",
  iacute: "í",
  Iacute: "Í",
  icirc: "î",
  oacute: "ó",
  Oacute: "Ó",
  ocirc: "ô",
  Ocirc: "Ô",
  otilde: "õ",
  Otilde: "Õ",
  ouml: "ö",
  uacute: "ú",
  Uacute: "Ú",
  ucirc: "û",
  uuml: "ü",
  ntilde: "ñ",
  Ntilde: "Ñ",
  szlig: "ß",
  zwnj: "",
  zwj: "",
  shy: "",
};

/** Decodes HTML entities (named, decimal and hex). Unknown names stay as they are. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code =
        entity[1] === "x" || entity[1] === "X" ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[entity] ?? NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

const BLOCK_TAGS =
  "address|article|aside|blockquote|center|dd|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|main|nav|ol|p|pre|section|table|tbody|thead|tfoot|tr|ul";

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const ATTR = /([^\s=/"'>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
const TAG = /<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;

function attributes(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of raw.matchAll(ATTR)) {
    const name = (m[1] ?? "").toLowerCase();
    if (name && !out.has(name)) out.set(name, decodeEntities(m[2] ?? m[3] ?? m[4] ?? ""));
  }
  return out;
}

const isZero = (v: string) => /^[+-]?0*(\.0*)?[a-z%]*$/.test(v) && /0/.test(v) && !/[1-9]/.test(v);

/** Whether an inline style hides the element from a person looking at the page. */
function styleHides(style: string): boolean {
  const decl = new Map<string, string>();
  for (const part of style.toLowerCase().split(";")) {
    const i = part.indexOf(":");
    if (i > 0)
      decl.set(
        part.slice(0, i).trim(),
        part
          .slice(i + 1)
          .replace(/!important/g, "")
          .replace(/\s+/g, ""),
      );
  }
  const get = (k: string) => decl.get(k) ?? "";
  if (get("display") === "none" || get("visibility") === "hidden") return true;
  if (decl.has("opacity") && isZero(get("opacity"))) return true;
  if (decl.has("font-size") && isZero(get("font-size"))) return true;
  const color = get("color");
  if (color && (color === get("background-color") || color === get("background"))) return true;
  if (/^(transparent|rgba\(.*,0(\.0*)?\)|#[0-9a-f]{6}00|#[0-9a-f]{3}0)$/.test(color)) return true;
  const far = (v: string) => /^-\d+(\.\d+)?px$/.test(v) && Number.parseFloat(v) <= -1000;
  if (/^(absolute|fixed)$/.test(get("position")) && (far(get("left")) || far(get("top")))) return true;
  if (far(get("text-indent"))) return true;
  if (/^rect\(0(px)?,?0(px)?,?0(px)?,?0(px)?\)$/.test(get("clip")) || /^inset\(50%\)$/.test(get("clip-path")))
    return true;
  if (/^scale\(0(\.0*)?(,0(\.0*)?)?\)$/.test(get("transform"))) return true;
  const overflowHidden = /^(hidden|clip)$/.test(get("overflow"));
  if (overflowHidden && ((decl.has("width") && isZero(get("width"))) || (decl.has("height") && isZero(get("height")))))
    return true;
  return false;
}

function hiddenElement(name: string, raw: string): boolean {
  if (name === "template") return true;
  const attrs = attributes(raw);
  if (attrs.has("hidden") || attrs.get("aria-hidden")?.toLowerCase() === "true") return true;
  const style = attrs.get("style");
  return style ? styleHides(style) : false;
}

/**
 * Drops every element a person can't see (template, `hidden`, `aria-hidden="true"`, inline styles that hide
 * it or move it off screen) with its whole subtree. A stack walk, so nested elements of the same name close
 * where the browser would close them. ponytail: inline styles only, colors compared as written; a class
 * hidden by a stylesheet still shows, which needs a CSS engine.
 */
export function dropHidden(html: string): string {
  let out = "";
  let last = 0;
  let skip: { name: string; depth: number } | null = null;
  for (const m of html.matchAll(TAG)) {
    const closing = m[1] === "/";
    const name = (m[2] ?? "").toLowerCase();
    const raw = m[3] ?? "";
    const end = (m.index ?? 0) + m[0].length;
    const selfClosing = VOID_TAGS.has(name) || raw.trimEnd().endsWith("/");
    if (skip) {
      if (name !== skip.name) continue;
      if (closing) skip.depth--;
      else if (!selfClosing) skip.depth++;
      if (skip.depth === 0) {
        skip = null;
        last = end;
      }
      continue;
    }
    if (closing || !hiddenElement(name, raw)) continue;
    out += html.slice(last, m.index);
    last = end;
    if (!selfClosing) skip = { name, depth: 1 };
  }
  // An unclosed hidden element hides the rest of the page, as in a browser.
  return skip ? out : out + html.slice(last);
}

/**
 * HTML to readable plain text: drops head/style/script and comments and every element a person can't see
 * (`dropHidden`), turns blocks and `<br>` into line breaks, list items into "- ", table cells into tabs,
 * images into their alt text, and links into "text (url)" (just the url when the text is the url). The
 * result goes through `cleanOutside`.
 */
export function htmlToText(html: string): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(head|style|script|title|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<!doctype[^>]*>/gi, "");
  text = dropHidden(text);
  text = text.replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_match, attrs: string, inner: string) => {
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    const url = decodeEntities((href?.[1] ?? href?.[2] ?? href?.[3] ?? "").trim());
    const label = inner
      .replace(/<[^>]*>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const labelText = decodeEntities(label);
    if (!url || /^(javascript|data):/i.test(url) || url.startsWith("#")) return label;
    const shownUrl = url.replace(/^mailto:/i, "");
    if (!labelText || labelText === url || labelText === shownUrl) return shownUrl;
    return `${label} (${shownUrl})`;
  });
  text = text.replace(/<img\b[^>]*?\balt\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/gi, (_m, a?: string, b?: string) => {
    const alt = (a ?? b ?? "").trim();
    return alt ? `[${alt}]` : "";
  });
  text = text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(td|th)\s*>/gi, "\t")
    .replace(new RegExp(`</?(${BLOCK_TAGS})\\b[^>]*>`, "gi"), "\n")
    .replace(/<\/li\s*>/gi, "")
    .replace(/<[^>]*>/g, "");
  text = decodeEntities(text).replace(/ /g, " ");
  return cleanOutside(text)
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v\r]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

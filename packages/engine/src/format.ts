import { type AppLocale, localeInfo } from "@agenteschat/i18n/locale";
/**
 * At most `max` UTF-16 units of `text`, never half of a pair (an emoji) at the end: Postgres refuses jsonb that
 * holds a lone surrogate.
 */
export const cutText = (text: string, max: number) => text.slice(0, max).replace(/[\uD800-\uDBFF]$/, "");

/** `cutText` for text people read: a cut ends in "…", never passing for the whole. */
export const cutMarked = (text: string, max: number) => (text.length > max ? `${cutText(text, max - 1)}…` : text);

/** "Ana's", for the English the agents read. */
export const possessive = (name: string) => `${name}'s`;

/** "in 3 h", "in 2 days": how soon `at` comes, for the English the agents read. */
export function fromNow(at: Date, now = Date.now()) {
  const minutes = Math.max(1, Math.round((at.getTime() - now) / 60_000));
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `in ${hours} h` : `in ${Math.round(hours / 24)} days`;
}

/** "Ana, Bia and Caio", for the English the agents read. */
export const andList = (xs: string[]) =>
  xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;

/** The first `max` items, then how many more ("a, b, +3 more"). */
export const firstOf = (items: string[], max: number) =>
  items.length > max ? `${items.slice(0, max).join(", ")}, +${items.length - max} more` : items.join(", ");

/**
 * Whether `text` asks something by its punctuation, in any script: `?`, the full-width `？`, the Arabic `؟`, the
 * Spanish `¿`. Greek's `;` is left out: it is also a semicolon.
 */
export const hasQuestionMark = (text: string) => /[?？؟¿]/.test(text);

/** A person's first name, from their whole name. */
export const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? "";

const WORDS = new Intl.Segmenter(undefined, { granularity: "word" });
/** How many words `text` has, in any script: Chinese, Japanese or Thai, written without spaces, count theirs too. */
export function wordCount(text: string) {
  let n = 0;
  for (const s of WORDS.segment(text)) if (s.isWordLike) n++;
  return n;
}

/** `cutText` from the end: the last `max` units, never half of a pair at the start. */
export const cutTextEnd = (text: string, max: number) =>
  text.slice(Math.max(0, text.length - max)).replace(/^[\uDC00-\uDFFF]/, "");

/** The strings of an untrusted value: its string items when it is an array, else none. */
export const stringsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/** Postgres text and jsonb refuse NUL and lone UTF-16 surrogates: `text` without either. */
export const pgSafeText = (text: string) =>
  text.replaceAll("\0", "").replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");

/** `JSON.stringify` with every string and key in it `pgSafeText`, for a jsonb write that must never fail on its text. */
export const pgSafeStringify = (value: unknown) =>
  JSON.stringify(value, (_key, v) => {
    if (typeof v === "string") return pgSafeText(v);
    if (!v || typeof v !== "object" || Array.isArray(v)) return v;
    const keys = Object.keys(v);
    // Keys come from third parties too (MCP structuredContent): rebuilt only when one needs it.
    return keys.every((k) => pgSafeText(k) === k)
      ? v
      : Object.fromEntries(keys.map((k) => [pgSafeText(k), (v as Record<string, unknown>)[k]]));
  });

/** A JSON value as `pgSafeStringify` writes it. */
export const pgSafeJson = <T>(value: T): T => {
  const json = pgSafeStringify(value);
  return json === undefined ? value : JSON.parse(json);
};

/**
 * The text of file bytes, or null when they are binary. UTF-8 first; a UTF-16 BOM decodes as UTF-16; otherwise
 * bytes with no NUL and few control characters are Windows-1252 text (an Excel CSV export, a Latin-1 file).
 */
export function textOfBytes(bytes: Uint8Array): string | null {
  const bom =
    bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : null;
  if (bom) return new TextDecoder(bom).decode(bytes, { stream: true });
  if (bytes.includes(0)) return null;
  try {
    // `stream`: a character cut at the end (the read stopped mid-file) is no reason to call it binary.
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true });
  } catch {
    let control = 0;
    for (const b of bytes) if ((b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) || b === 0x7f) control++;
    // ponytail: control-byte share as the binary test; magic bytes would catch a NUL-free binary that passes it.
    return control > bytes.length / 20 ? null : new TextDecoder("windows-1252").decode(bytes);
  }
}

/** `2.3 MB`, `12 KB`, `512 bytes`, `50.0 GB`: sizes in the English agents read. */
export function formatBytes(n: number) {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * A moment as a person reads it in their time zone and language: the day ("November 6, 2026", "6 de novembro de
 * 2026") and the time with its zone ("3:42 PM GMT-3", "15:42 BRT").
 */
export function dayAndTime(at: Date, timeZone: string, locale: AppLocale) {
  const tag = localeInfo(locale).intl;
  return {
    day: new Intl.DateTimeFormat(tag, { timeZone, dateStyle: "long" }).format(at),
    time: new Intl.DateTimeFormat(tag, { timeZone, hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(
      at,
    ),
  };
}

/** A `YYYY-MM-DD` day from 2000 to 2999 as the ms of its start in UTC, or null when it isn't a real day. */
export function utcDayMs(day: string) {
  const ms = Date.parse(`${day}T00:00:00Z`);
  return /^2\d{3}-\d\d-\d\d$/.test(day) && !Number.isNaN(ms) && new Date(ms).toISOString().startsWith(day) ? ms : null;
}

/** The value under `key`, made and kept the first time it is asked for. */
export function getOrMake<K, V>(map: Map<K, V>, key: K, make: () => V): V {
  const found = map.get(key);
  if (found !== undefined) return found;
  const made = make();
  map.set(key, made);
  return made;
}

/** Levenshtein distance: the fewest one-character insertions, deletions or substitutions from `a` to `b`. */
export function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const sub = (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1);
      row.push(Math.min((prev[j] as number) + 1, (row[j - 1] as number) + 1, sub));
    }
    prev = row;
  }
  return prev[b.length] as number;
}

/**
 * The `p` quantile (0..1) of `values` by nearest rank: the smallest of them that a `p` share of them don't exceed;
 * 0 for none.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length))) - 1] as number;
}

import { plainLines } from "./markdown";

/** `Acme Saúde` → `acme-saude` (display only: the backend has no slug yet). */
export const slugify = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** `Íris B.` → `irisb`: an agent @handle (2–32 chars: a-z, 0-9, - or _; see HANDLE_PATTERN in the engine). */
export function handleFrom(name: string) {
  const base = name
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 32);
  return base.length >= 2 ? base : base.padEnd(2, "0");
}

/** No address has what mail apps and spreadsheets wrap addresses in (`<…>`, quotes, `mailto:`). */
export const EMAIL = /^[^\s@,;:<>()[\]"]+@[^\s@,;:<>()[\]"]+\.[^\s@,;:<>()[\]"]+$/;
export const isEmail = (value: string) => EMAIL.test(value.trim());

/**
 * Addresses typed or pasted, in order, once each, in lower case, each marked valid or not. Read the way mail apps
 * and spreadsheets copy them: `Ana Silva <ana@x.com>`, `"ana@x.com"`, `mailto:ana@x.com`. Once the text has an
 * address in brackets, the bare words around it are names, not addresses to check; a quoted name
 * (`"Silva, Ana" <…>`) always is.
 */
export function addressesIn(text: string): { email: string; valid: boolean }[] {
  const named = /<[^<>]*@[^<>]*>/.test(text);
  const seen = new Set<string>();
  const out: { email: string; valid: boolean }[] = [];
  for (const piece of text.match(/<[^<>]*>|"[^"]*"|[^\s,;<>"]+/g) ?? []) {
    const email = piece
      .replace(/^[<"'([]+|[>"')\].]+$/g, "")
      .trim()
      .replace(/^mailto:/i, "")
      .toLowerCase();
    const name = !email.includes("@") && (named || piece.startsWith('"'));
    if (!email || name || seen.has(email)) continue;
    seen.add(email);
    out.push({ email, valid: isEmail(email) });
  }
  return out;
}

/** `addressesIn` split into those that look right and those that don't, leaving out the ones in `already`. */
export function emailsFrom(text: string, already: readonly string[] = []): { valid: string[]; invalid: string[] } {
  const known = new Set(already.map((e) => e.toLowerCase()));
  const fresh = addressesIn(text).filter((a) => !known.has(a.email));
  return {
    valid: fresh.filter((a) => a.valid).map((a) => a.email),
    invalid: fresh.filter((a) => !a.valid).map((a) => a.email),
  };
}

/**
 * The address in a JWT's `email` claim (an ID token's), read without checking its signature: only to name the address
 * a sign-in was refused for, never to trust it. Undefined when there is none.
 */
export function jwtEmail(token: string): string | undefined {
  const payload = (token.split(".")[1] ?? "").replace(/-/g, "+").replace(/_/g, "/");
  try {
    const { email } = JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, "=")));
    return typeof email === "string" && isEmail(email) ? email : undefined;
  } catch {
    return undefined;
  }
}

/** Password rules from Better Auth (8–128 characters, nothing else). */
export function passwordState(password: string): "empty" | "short" | "long" | "ok" {
  if (password.length === 0) return "empty";
  if (password.length < 8) return "short";
  if (password.length > 128) return "long";
  return "ok";
}

/**
 * A name step holding a password (typed there, or filled in by a password manager): 8 or more characters with no
 * space, a digit (any script's) and a symbol. Hyphens, apostrophes, periods and middle dots are name characters, so
 * "Jean-Luc", "O'Neil", "Gal·la" or "ジョン・スミス2世" pass.
 */
export function looksLikePassword(name: string) {
  const n = name.trim();
  return n.length >= 8 && !/\s/.test(n) && /\p{Nd}/u.test(n) && /[^\p{L}\p{M}\p{N}\s'’.·・-]/u.test(n);
}

/** The password chosen is the name typed a step before: the name step got the password. */
export function nameIsPassword(name: string, password: string) {
  const n = name.trim();
  return n !== "" && n === password.trim();
}

/** "40", "40,5", "40.5" → 40.5; anything else → NaN. */
export function parseAmount(value: string) {
  const normalized = value.trim().replace(/\s/g, "").replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(normalized)) return Number.NaN;
  return Number(normalized);
}

/** Common misspellings of webmail domains (the sign-in screen offers the fix). */
const DOMAIN_TYPOS: Record<string, string> = {
  "gmial.com": "gmail.com",
  "gmai.com": "gmail.com",
  "gmal.com": "gmail.com",
  "gamil.com": "gmail.com",
  "gnail.com": "gmail.com",
  "gmail.con": "gmail.com",
  "gmail.co": "gmail.com",
  "gmail.com.br": "gmail.com",
  "hotmial.com": "hotmail.com",
  "hotmai.com": "hotmail.com",
  "hotmail.con": "hotmail.com",
  "outlok.com": "outlook.com",
  "outllok.com": "outlook.com",
  "outlook.con": "outlook.com",
  "yaho.com": "yahoo.com",
  "yahoo.con": "yahoo.com",
  "icloud.con": "icloud.com",
  "icoud.com": "icloud.com",
  "uol.com": "uol.com.br",
  "bol.com": "bol.com.br",
};

/** `ana@gmial.com` → `ana@gmail.com`; null when the domain looks right. */
export function emailTypoFix(email: string): string | null {
  const [user, domain, ...rest] = email.trim().toLowerCase().split("@");
  if (!user || !domain || rest.length) return null;
  const fixed = DOMAIN_TYPOS[domain];
  return fixed ? `${user}@${fixed}` : null;
}

/** Where to read the e-mail we just sent: the webmail of known domains ("Abrir o Gmail"). */
export function webmailOf(
  email: string,
): { name: "Gmail" | "Outlook" | "iCloud Mail" | "Yahoo Mail"; url: string } | null {
  const domain = email.trim().toLowerCase().split("@")[1] ?? "";
  if (domain === "gmail.com" || domain === "googlemail.com") return { name: "Gmail", url: "https://mail.google.com" };
  if (["outlook.com", "hotmail.com", "live.com", "msn.com", "outlook.com.br", "hotmail.com.br"].includes(domain))
    return { name: "Outlook", url: "https://outlook.live.com/mail" };
  if (["icloud.com", "me.com", "mac.com"].includes(domain))
    return { name: "iCloud Mail", url: "https://www.icloud.com/mail" };
  if (domain.startsWith("yahoo.")) return { name: "Yahoo Mail", url: "https://mail.yahoo.com" };
  return null;
}

/** The text ended as a sentence: a full stop added unless it already ends with one, "!", "?" or "…". */
export const endSentence = (text: string) => (/[.!?…]$/.test(text) ? text : `${text}.`);

/** `text` around the last `part` in it (a value put into a sentence): what comes before and after, or null. */
export function around(text: string, part: string): [before: string, after: string] | null {
  const at = part ? text.lastIndexOf(part) : -1;
  return at < 0 ? null : [text.slice(0, at), text.slice(at + part.length)];
}

const WORD_CHAR = /[\p{L}\p{N}]/u;
/** Where `word` first stands as a whole word in `text` ("Max" in "Max está", not in "Maximizando"), or -1. */
export function wordIndex(text: string, word: string): number {
  if (!word) return -1;
  for (let at = text.indexOf(word); at >= 0; at = text.indexOf(word, at + 1)) {
    if (!WORD_CHAR.test(text[at - 1] ?? "") && !WORD_CHAR.test(text[at + word.length] ?? "")) return at;
  }
  return -1;
}

/**
 * `text` cut where each of `names` first stands as a word (`wordIndex`), in order of where they stand: the plain
 * pieces as strings, each name found as its index in `names` (where a face goes before it). A name already used, or
 * inside an earlier one, is left as text.
 */
export function splitAtNames(text: string, names: readonly string[]): (string | number)[] {
  const found = names
    .map((name, i) => ({ i, at: wordIndex(text, name), len: name.length }))
    .filter((f) => f.at >= 0 && names.indexOf(names[f.i] ?? "") === f.i)
    .sort((a, b) => a.at - b.at || b.len - a.len);
  const out: (string | number)[] = [];
  let at = 0;
  for (const f of found) {
    if (f.at < at) continue;
    if (f.at > at) out.push(text.slice(at, f.at));
    out.push(f.i);
    at = f.at + f.len;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/** Where a shortened text may stop with nothing added: a sentence's end, or a line's. */
const STOPS = /[.!?…](?=\s)|\n/g;

/**
 * The start of a Markdown text in plain words (`plainLines`), in at most `lines` lines and `max` characters:
 * whole lines and sentences while they fit, so a full stop is never followed by an ellipsis. A first sentence
 * longer than that is cut at a word, with "…".
 */
export function excerpt(text: string, max: number, lines = 3) {
  const whole = plainLines(text).slice(0, lines).join("\n");
  if (whole.length <= max) return whole;
  let end = 0;
  for (const stop of whole.matchAll(STOPS)) {
    const at = stop.index + (stop[0] === "\n" ? 0 : 1);
    if (at > max) break;
    end = at;
  }
  if (end > 0) return whole.slice(0, end).trimEnd();
  const cut = whole.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > 0 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, "")}…`;
}

/** A name as a person types it to confirm: NFKC, without Unicode format characters (Cf), spaces collapsed, lower case. */
const typedForm = (value: string) =>
  value
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/**
 * Whether what someone typed to confirm a permanent step is `name` (deleting a workspace or an agent): case, extra
 * spaces and width forms aside, pasted text works, and invisible characters put in the name can't make it untypeable,
 * so a name that is only those needs nothing typed.
 */
export const matchesName = (typed: string, name: string) => typedForm(typed) === typedForm(name);

/** Text made safe inside HTML, as text or as an attribute value (quoted either way). */
export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Controls, zero-width, bidi and tag characters: they change how text looks without being seen. */
const INVISIBLE: readonly [from: number, to: number][] = [
  [0x0, 0x1f],
  [0x7f, 0x9f],
  [0xad, 0xad],
  [0x61c, 0x61c],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0xfeff, 0xfeff],
  [0xe0000, 0xe007f],
];

/** Text with every invisible character written out as `\u{…}`, so an address can't pass for another. */
export const visibleText = (text: string) =>
  [...text]
    .map((c) => {
      const code = c.codePointAt(0) ?? 0;
      return INVISIBLE.some(([from, to]) => code >= from && code <= to) ? `\\u{${code.toString(16)}}` : c;
    })
    .join("");

const oneSpaced = (text: string) => text.replace(/\s+/g, " ").trim();

/** From this length a text found word for word is the same text, wherever it was cut. */
const SURE_PIECE_CHARS = 40;

/**
 * Whether `whole` already holds `part` word for word (line breaks and extra spaces aside), as whole words: "Ok" is
 * not in "Okay", "Vou ver." is not in "Vou verificar". A long piece counts even cut mid-word: a stream's cuts fall there.
 */
export function holdsText(whole: string, part: string) {
  const w = oneSpaced(whole);
  const p = oneSpaced(part);
  if (p.length >= SURE_PIECE_CHARS && w.includes(p)) return true;
  for (let at = w.indexOf(p); at >= 0; at = w.indexOf(p, at + 1)) {
    if (!WORD_CHAR.test(w[at - 1] ?? "") && !WORD_CHAR.test(w[at + p.length] ?? "")) return true;
  }
  return false;
}

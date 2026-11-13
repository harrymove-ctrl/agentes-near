/** Credential shapes that never belong in an address or a message: API keys, tokens. */
export const KEY_SHAPES =
  /\b(sk-[A-Za-z0-9_-]{12,}|sk-ant-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9._-]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,})/g;
/** Credential shapes that signed and presigned addresses carry by design (an AWS key id, a JWT). */
export const SIGNED_SHAPES = /\b(AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,})/g;
/** A private key, by its first line. */
export const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

export type OutboundCode = "outbound.private_text" | "outbound.credential" | "outbound.long";

export const OUTBOUND_MESSAGES: Record<OutboundCode, string> = {
  "outbound.private_text":
    "This address carries text this run read from private data. Addresses can't carry it. To look something up use web_search, or open the link as it appeared.",
  "outbound.credential": "An address can't carry a key.",
  "outbound.long":
    "This address is too long to open by itself. Open it from a search result or a link, or use web_search.",
};

const MAX_QUERY = 512;
const MAX_SEGMENT = 200;
/** Shortest run of private text that counts as copied: longer than a word, a date or an id prefix. */
const WINDOW = 24;

/** The form of an address `seen` compares: https, lowercase host, no fragment, no trailing slash. */
export function normalizeUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = "";
  u.protocol = "https:";
  return u.toString().replace(/\/+$/, "");
}

const URLS_IN_TEXT = /https?:\/\/[^\s<>"'`]+/gi;

/** Every address written in a text, normalized (trailing punctuation dropped). */
export function urlsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(URLS_IN_TEXT)) {
    const n = normalizeUrl(m[0].replace(/[.,;:!?)\]}*]+$/, ""));
    if (n) out.push(n);
  }
  return out;
}

/** Collapsed whitespace, case-folded: how query text and private text compare. */
export const foldText = (s: string) => s.replace(/\s+/g, " ").toLowerCase();

const decode = (s: string) => {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
};

/**
 * Why an agent may not open this address by itself (null: it may): the address carries a key, is long enough to
 * smuggle data, or copies text the run read from private data (`privateText`). An address that appeared as is
 * (`seen`: in the conversation or a tool's result) always passes, whatever it carries. No privateText (the
 * runner, where the run's reads aren't known): AWS key ids and JWTs pass, since signed addresses carry them.
 */
export function outboundUrlProblem(
  url: string,
  opts: { seen?: (normalized: string) => boolean; privateText?: string[] } = {},
): { code: OutboundCode; message: string } | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  const normalized = normalizeUrl(url);
  if (normalized && opts.seen?.(normalized)) return null;
  const problem = (code: OutboundCode) => ({ code, message: OUTBOUND_MESSAGES[code] });
  const decoded = carried(u);
  const whole = `${decode(u.href)} ${decoded}`;
  if (new RegExp(KEY_SHAPES.source).test(whole) || PRIVATE_KEY.test(whole)) return problem("outbound.credential");
  if (opts.privateText && new RegExp(SIGNED_SHAPES.source).test(whole)) return problem("outbound.credential");
  if (decoded.length > MAX_QUERY || u.pathname.split("/").some((s) => s.length > MAX_SEGMENT)) {
    return problem("outbound.long");
  }
  if (opts.privateText?.length && copiesPrivateText(foldText(decoded), opts.privateText)) {
    return problem("outbound.private_text");
  }
  return null;
}

/** The text an address carries for its server: its query values and fragment, decoded. */
function carried(u: URL) {
  return [...u.searchParams.values(), decode(u.hash.slice(1))].filter(Boolean).join(" ");
}

/** Whether an address's query or fragment copies a private text (`outboundUrlProblem`'s private-text rule alone). */
export function urlCopiesPrivateText(url: string, privateText: string[]): boolean {
  try {
    return copiesPrivateText(foldText(carried(new URL(url))), privateText);
  } catch {
    return false;
  }
}

/** Whether some `WINDOW`-long run of `query` appears in a private text (both folded). */
function copiesPrivateText(query: string, privateText: string[]) {
  if (query.length < WINDOW) return false;
  const windows = new Set<string>();
  for (let i = 0; i + WINDOW <= query.length; i++) windows.add(query.slice(i, i + WINDOW));
  for (const raw of privateText) {
    const text = foldText(raw);
    for (let i = 0; i + WINDOW <= text.length; i++) if (windows.has(text.slice(i, i + WINDOW))) return true;
  }
  return false;
}

/**
 * What a guarded `fetch` throws for an address it won't connect to (the server's `publicHttpsFetch`, for hosts people
 * type): not https, or a host that is or resolves to a private, loopback, link-local or internal address. An adapter
 * that takes a `fetch` tells it from a network failure by this class (ADR 0144).
 */
export class OutboundAddressError extends Error {
  constructor(message = "This address points to an internal network") {
    super(message);
    this.name = "OutboundAddressError";
  }
}

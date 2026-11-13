/**
 * Masks what looks like a credential in free text that leaves its place (the runner's diagnostics and
 * activity log, the operator API's review block): machine tokens, bearer headers, common API key shapes,
 * `password=`/`token=` values. The agent's own secrets are masked by their values (ADR 0027) before this.
 */
export function redactCommon(text: string): string {
  return text
    .replace(/\bagm_[A-Za-z0-9_-]{6,}/g, "agm_***")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 ***")
    .replace(/\b(sk-(?:ant-)?[A-Za-z0-9_-]{12,})/g, "sk-***")
    .replace(/\b(gh[pousr]_[A-Za-z0-9._-]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "gh_***")
    .replace(/\b(xox[abposr]-[A-Za-z0-9-]{10,})/g, "xox-***")
    .replace(/\b(AKIA[0-9A-Z]{16})\b/g, "AKIA***")
    .replace(/((?:password|passwd|secret|token|api[_-]?key)\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, "$1***");
}

/** A field holding a service's own credential (`access_token`, a Page's `page_access_token`), never a page cursor. */
const TOKEN_FIELD = /(^|_)(access|refresh)_?token$/i;

/**
 * An answer without its credential fields, at any depth: Facebook lists a person's Pages with each Page's access
 * token, which would let an agent act around its approvals.
 */
export function withoutTokens(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutTokens);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, v]) => (TOKEN_FIELD.test(key) ? [] : [[key, withoutTokens(v)]])),
  );
}

/** A crash's stack frame (`at fn (/x/y.js:1:2)`, `at /x/y.js:1:2`) or the Node.js version line it ends with. */
const STACK_FRAME = /\s*\bat (?:async |new )?(?:[^\s()]+ \([^)]*\)|\/\S+|file:\/\/\S+|node:\S+)|\s*\bNode\.js v[\d.]+/g;
/** A line that names what went wrong (`Error: …`, `TypeError: …`, `ENOSPC: …`, `error: …`). */
const ERROR_LINE = /(?:\w*Error|\bE[A-Z]{3,}|\berror)\b:/;

/**
 * The line of a command-line tool's output that says what went wrong: its last line naming an error, else its last
 * line, without the stack frames and the Node.js version a crash ends with. Empty when it said nothing else.
 */
export function errorLineOf(output: string): string {
  const lines = output
    .replace(STACK_FRAME, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.filter((l) => ERROR_LINE.test(l)).at(-1) ?? lines.at(-1) ?? "";
}

/** `text` in at most `max` characters: when longer, cut after its last whole word, with "…". */
export function cutAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, "");
  const space = head.lastIndexOf(" ");
  return `${(space > 0 ? head.slice(0, space) : head).trimEnd()}…`;
}

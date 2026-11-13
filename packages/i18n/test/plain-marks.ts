import { readFileSync } from "node:fs";
import { leaves } from "./leaves";
import { sourceFiles } from "./maker-words";

/**
 * Words people read use no semicolon and no em dash: two short sentences read plainer, and both marks read as
 * machine-written. A "·" separates data and never two clauses, which review checks, not this file.
 */
export const MARKS = /[;—]/;

/** Code keeps its marks: `code` spans, help code blocks (`….blocks.N.code`) and HTML entities (`&amp;`). */
const outsideCode = (text: string) => text.replace(/&#?\w+;/g, "").replace(/`[^`]*`/g, "");

/** A help page's code block. A key merely named `code` ("Code from the email") is words. */
const CODE_BLOCK = /\.blocks\.\d+\.code$/;

/** Keys allowed a mark, each with its reason. */
export const MARKS_ALLOWED: Readonly<Record<string, string>> = {
  "members.column.group": "owner-approved Discord-style group header",
};

/** A string tree's leaves that break the rule, as "key: text", for one readable failure. */
export const unplainLeaves = (tree: unknown) =>
  leaves(tree)
    .filter((leaf): leaf is [string, string] => typeof leaf[1] === "string")
    .filter(([key, text]) => !CODE_BLOCK.test(key) && !(key in MARKS_ALLOWED) && MARKS.test(outsideCode(text)))
    .map(([key, text]) => `${key}: ${text}`);

/**
 * An `apiError(c, status, code, "…")`, an engine or runner error the API answers with, or a runner call that ends
 * waiting work with a message (`endSession`, `endShows`, `unanswered`), up to its `(`.
 */
const SERVER_WORDS =
  /\b(?:apiError|endSession|endShows|unanswered|new (?:Validation|Conflict|NotFound|Forbidden|TooMany|MissingCredential|Runner|ChromeStart)Error)\(/g;

/**
 * Reads code from `i` to the bracket that closes the one just before it, and returns the index after that bracket.
 * Every string in it goes to `out`: quoted ones, and the text of template literals (their `${…}` read as code).
 */
function scanCode(src: string, i: number, out: string[]): number {
  let depth = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === "/" && (src[i + 1] === "/" || src[i + 1] === "*")) {
      const close = src[i + 1] === "/" ? "\n" : "*/";
      const at = src.indexOf(close, i + 2);
      i = at < 0 ? src.length : at + close.length;
    } else if (c === '"' || c === "'") {
      let end = i + 1;
      while (end < src.length && src[end] !== c) end += src[end] === "\\" ? 2 : 1;
      out.push(src.slice(i + 1, end));
      i = end + 1;
    } else if (c === "`") i = scanTemplate(src, i + 1, out);
    else if ("([{".includes(c)) {
      depth++;
      i++;
    } else if (")]}".includes(c) && --depth < 0) return i + 1;
    else i++;
  }
  return i;
}

function scanTemplate(src: string, i: number, out: string[]): number {
  let text = "";
  while (i < src.length) {
    if (src[i] === "\\") {
      text += src.slice(i, i + 2);
      i += 2;
    } else if (src[i] === "`") {
      out.push(text);
      return i + 1;
    } else if (src[i] === "$" && src[i + 1] === "{") {
      out.push(text);
      text = "";
      i = scanCode(src, i + 2, out);
    } else text += src[i++];
  }
  return i;
}

/**
 * The strings in one source's calls above that break the rule: every string in their arguments, so both sides of a
 * ternary count. It reads the raw source: `withoutComments` takes a `/*` inside a string ("owner/*") for a comment
 * and drops the rest of the file.
 */
export const unplainCalls = (source: string) =>
  [...source.matchAll(SERVER_WORDS)].flatMap((m) => {
    const strings: string[] = [];
    scanCode(source, m.index + m[0].length, strings);
    return strings.filter((s) => MARKS.test(s));
  });

/** The server's words for people that break the rule, as "file: text". */
export const unplainServerWords = (dirs: string[]) =>
  dirs
    .flatMap((dir) => sourceFiles(dir))
    .flatMap((file) => unplainCalls(readFileSync(file, "utf8")).map((s) => `${file}: ${s}`));

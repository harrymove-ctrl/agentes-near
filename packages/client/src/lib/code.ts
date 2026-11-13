/**
 * Fenced code in messages: the language's display name and a small
 * highlighter (keywords, strings, numbers, comments, function calls, diff lines), shared by the web and
 * the phone app. Not a parser: one pass per line, with block comments carried across lines. A block with
 * no language stays plain (it is often prose or output); an unknown language gets the common keywords.
 */

export type CodeTokenKind =
  | "plain"
  | "keyword"
  | "string"
  | "number"
  | "comment"
  | "function"
  | "inserted"
  | "deleted"
  /** A JSON object's key, apart from the strings it maps to. */
  | "property";
export interface CodeToken {
  kind: CodeTokenKind;
  text: string;
}

const LABELS: Record<string, string> = {
  bash: "Bash",
  c: "C",
  "c++": "C++",
  console: "Terminal",
  cpp: "C++",
  cs: "C#",
  csharp: "C#",
  css: "CSS",
  diff: "Diff",
  dockerfile: "Dockerfile",
  go: "Go",
  graphql: "GraphQL",
  html: "HTML",
  java: "Java",
  javascript: "JavaScript",
  js: "JavaScript",
  json: "JSON",
  jsx: "JSX",
  kotlin: "Kotlin",
  kt: "Kotlin",
  markdown: "Markdown",
  md: "Markdown",
  mermaid: "Mermaid",
  php: "PHP",
  py: "Python",
  python: "Python",
  rb: "Ruby",
  rs: "Rust",
  ruby: "Ruby",
  rust: "Rust",
  sh: "Shell",
  shell: "Shell",
  sql: "SQL",
  swift: "Swift",
  toml: "TOML",
  ts: "TypeScript",
  tsx: "TSX",
  typescript: "TypeScript",
  xml: "XML",
  yaml: "YAML",
  yml: "YAML",
  zsh: "Shell",
};

/** "ts" → "TypeScript", "sql" → "SQL"; an unknown name as written; "" when the block has none. */
export function codeLabel(lang: string): string {
  const key = lang.trim().toLowerCase();
  return LABELS[key] ?? lang.trim();
}

const words = (s: string) => new Set(s.split(" "));
const JS = words(
  "as async await break case catch class const continue default delete do else enum export extends false finally for from function if implements import in instanceof interface let new null of private protected public readonly return static super switch this throw true try type typeof undefined var void while yield",
);
const PY = words(
  "and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield",
);
const SH = words(
  "case cd do done echo elif else esac exit export fi for function if in local return set source sudo then unset until while",
);
const SQL = words(
  "add all alter and as asc between by case cast create delete desc distinct drop else end exists false from full group having if in index inner insert interval into is join key left like limit not null offset on or order outer primary references returning right select set table then true union unique update using values view when where with",
);
const GENERIC = new Set([
  ...JS,
  ...PY,
  ..."fn func impl let match mod mut pub struct trait use where package defer go chan map range select end begin module require nil self elsif unless".split(
    " ",
  ),
]);
const JSON_WORDS = words("true false null");

type Syntax = {
  keywords: Set<string>;
  caseless?: boolean;
  line: string[];
  block: boolean;
  hashOnlyAfterSpace?: boolean;
  /** A string followed by ":" is a key. */
  keys?: boolean;
};

const C_LIKE: Syntax = { keywords: GENERIC, line: ["//"], block: true };
const SYNTAX: Record<string, Syntax> = {
  js: { keywords: JS, line: ["//"], block: true },
  ts: { keywords: JS, line: ["//"], block: true },
  py: { keywords: PY, line: ["#"], block: false },
  sh: { keywords: SH, line: ["#"], block: false, hashOnlyAfterSpace: true },
  sql: { keywords: SQL, caseless: true, line: ["--"], block: true },
  json: { keywords: JSON_WORDS, line: [], block: false, keys: true },
  yaml: { keywords: JSON_WORDS, line: ["#"], block: false },
  css: { keywords: new Set(), line: [], block: true },
  rb: { keywords: GENERIC, line: ["#"], block: false },
};
const ALIAS: Record<string, string> = {
  javascript: "js",
  jsx: "js",
  mjs: "js",
  typescript: "ts",
  tsx: "ts",
  python: "py",
  bash: "sh",
  zsh: "sh",
  shell: "sh",
  console: "sh",
  dockerfile: "sh",
  yml: "yaml",
  toml: "yaml",
  ruby: "rb",
  scss: "css",
};

const IDENT = /^[A-Za-z_$][\w$]*/;
const NUMBER = /^(?:0x[0-9a-fA-F]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)/;

/** The code's lines as tokens. Plain text (no language) comes back as one plain token per line. */
export function highlightCode(text: string, lang: string): CodeToken[][] {
  const lines = text.split("\n");
  const key = lang.trim().toLowerCase();
  if (!key) return lines.map((l) => [{ kind: "plain", text: l }]);
  if (key === "diff" || key === "patch") return lines.map(diffLine);
  const syntax = SYNTAX[ALIAS[key] ?? key] ?? C_LIKE;
  const state = { inBlock: false };
  return lines.map((l) => tokenizeLine(l, syntax, state));
}

function diffLine(line: string): CodeToken[] {
  if (line.startsWith("+") && !line.startsWith("+++")) return [{ kind: "inserted", text: line }];
  if (line.startsWith("-") && !line.startsWith("---")) return [{ kind: "deleted", text: line }];
  if (line.startsWith("@@")) return [{ kind: "comment", text: line }];
  return [{ kind: "plain", text: line }];
}

function tokenizeLine(line: string, syntax: Syntax, state: { inBlock: boolean }): CodeToken[] {
  const out: CodeToken[] = [];
  const push = (kind: CodeTokenKind, text: string) => {
    if (!text) return;
    const prev = out[out.length - 1];
    if (prev && prev.kind === kind) prev.text += text;
    else out.push({ kind, text });
  };
  let i = 0;
  while (i < line.length) {
    const rest = line.slice(i);
    if (state.inBlock) {
      const end = rest.indexOf("*/");
      if (end < 0) {
        push("comment", rest);
        break;
      }
      push("comment", rest.slice(0, end + 2));
      state.inBlock = false;
      i += end + 2;
      continue;
    }
    if (syntax.block && rest.startsWith("/*")) {
      state.inBlock = true;
      continue;
    }
    const lineComment = syntax.line.find((m) => rest.startsWith(m));
    if (lineComment && (!syntax.hashOnlyAfterSpace || i === 0 || /\s/.test(line[i - 1] ?? ""))) {
      push("comment", rest);
      break;
    }
    const ch = line[i] ?? "";
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < line.length && line[j] !== ch) j += line[j] === "\\" ? 2 : 1;
      push(
        syntax.keys && /^\s*:/.test(line.slice(j + 1)) ? "property" : "string",
        line.slice(i, Math.min(line.length, j + 1)),
      );
      i = j + 1;
      continue;
    }
    const prev = line[i - 1] ?? "";
    const num = /[\w$]/.test(prev) ? null : NUMBER.exec(rest);
    if (num) {
      push("number", num[0]);
      i += num[0].length;
      continue;
    }
    const id = IDENT.exec(rest);
    if (id) {
      const word = id[0];
      const keyword = syntax.keywords.has(syntax.caseless ? word.toLowerCase() : word);
      const call = !keyword && /^\s*\(/.test(rest.slice(word.length));
      push(keyword ? "keyword" : call ? "function" : "plain", word);
      i += word.length;
      continue;
    }
    push("plain", ch);
    i += 1;
  }
  return out;
}

/** The languages a block is JSON in. */
export const isJsonLang = (lang: string) => lang.trim().toLowerCase() === "json";

/**
 * A JSON object or array as people read it: one value a line, indented two spaces, every key, string and number
 * exactly as written (a long id never rounded, as `JSON.stringify(JSON.parse(…))` would). Null when `text` isn't an
 * object or array of valid JSON.
 */
export function formatJson(text: string): string | null {
  const raw = text.trim();
  if (!/^[[{]/.test(raw)) return null;
  try {
    JSON.parse(raw);
  } catch {
    return null;
  }
  const pad = (depth: number) => `\n${"  ".repeat(depth)}`;
  let out = "";
  let depth = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i] as string;
    if (ch === '"') {
      let j = i + 1;
      while (raw[j] !== '"') j += raw[j] === "\\" ? 2 : 1;
      out += raw.slice(i, j + 1);
      i = j;
    } else if (ch === "{" || ch === "[") {
      let next = i + 1;
      while (/\s/.test(raw[next] ?? "")) next++;
      if (raw[next] === (ch === "{" ? "}" : "]")) {
        out += ch + raw[next];
        i = next;
      } else out += ch + pad(++depth);
    } else if (ch === "}" || ch === "]") out += pad(--depth) + ch;
    else if (ch === ",") out += `,${pad(depth)}`;
    else if (ch === ":") out += ": ";
    else if (!/\s/.test(ch)) out += ch;
  }
  return out;
}

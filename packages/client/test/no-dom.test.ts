import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * The shared client runs in the browser and in React Native (ADR 0035): no
 * DOM, no browser storage, no web-only packages. Platform effects come in as
 * options (`onAgentReaction`, `createSocket`, `fetch`, `headers`).
 */
const SRC = join(import.meta.dir, "..", "src");
/** Text, not code the client runs: the script of a block's own sandboxed page (ADR 0113). */
const PAGE_TEXT = new Set(["lib/block-kit.ts"]);
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx|js|jsx)$/.test(path) ? [path] : [];
  });

const FORBIDDEN: [RegExp, string][] = [
  // After a dot it is a property path ("aiAccounts.usage.window.five_hour"), never the global.
  [/(?<!\.)\bwindow\s*[.[]/, "window"],
  [/\btypeof\s+window\b/, "window"],
  [/\bglobalThis\.window\b/, "window"],
  [/\bdocument\s*[.[]/, "document"],
  [/\btypeof\s+document\b/, "document"],
  [/\blocalStorage\b/, "localStorage"],
  [/\bsessionStorage\b/, "sessionStorage"],
  [/\bnavigator\s*\./, "navigator"],
  [/\bimport\.meta\.env\b/, "import.meta.env (Vite)"],
  [/\b(HTMLElement|HTMLCanvasElement|HTMLInputElement|FileList|MutationObserver|IntersectionObserver)\b/, "DOM type"],
  [/from\s+["']react-dom(\/[^"']*)?["']/, "react-dom"],
  // `@agenteschat/ui/markdown` is the one shared parser, plain TypeScript the engine reads too (held below).
  [/from\s+["']@agenteschat\/ui(?!\/markdown["'])(\/[^"']*)?["']/, "@agenteschat/ui"],
  [/from\s+["']@tanstack\/react-router["']/, "@tanstack/react-router (web routing)"],
  [/from\s+["']react-i18next["']/, "react-i18next (each app sets up i18n)"],
  [/from\s+["']@\//, "the web app's @/ alias"],
];

/** Comments may talk about the browser; code may not use it. */
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

describe("@agenteschat/client stays platform-neutral", () => {
  test("no DOM, browser storage, react-dom or @agenteschat/ui in src", () => {
    const offenders: string[] = [];
    for (const f of files(SRC)) {
      if (PAGE_TEXT.has(relative(SRC, f))) continue;
      const source = code(readFileSync(f, "utf8"));
      for (const [re, what] of FORBIDDEN) {
        const m = re.exec(source);
        if (m) offenders.push(`${relative(SRC, f)}:${source.slice(0, m.index).split("\n").length} ${what}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the Markdown parser it shares with @agenteschat/ui holds to the same rules", () => {
    const source = code(readFileSync(join(SRC, "..", "..", "ui", "src", "markdown.ts"), "utf8"));
    expect(FORBIDDEN.filter(([re]) => re.test(source)).map(([, what]) => what)).toEqual([]);
    expect([...source.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1])).toEqual(["@agenteschat/i18n/everyone"]);
  });

  test("no .tsx: shared code builds elements without JSX", () => {
    expect(files(SRC).filter((f) => f.endsWith(".tsx"))).toEqual([]);
  });
});

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { sourceFiles, withoutComments } from "../../../packages/i18n/test/maker-words";

const APP = join(import.meta.dir, "..");
const ROOTS = [join(APP, "src"), join(APP, "app")];
/** Brand names, symbols and code that stay as they are. */
const ALLOWED = [
  /^(agentes|chat|\.chat|agentes\.chat|GitHub|MCP|Drive|Claude Code|Codex|US\$|UTC|GIF|PDF)$/,
  // A comparison in code (`a.length > LIMIT ? … : …`), not text.
  /^[A-Z_]+ \?$/,
  /^[A-Z]$/,
  /^@\w+$/,
  /^https?:/,
  /^[^\p{L}]*$/u,
];
const allowed = (s: string) => ALLOWED.some((re) => re.test(s));

test("JSX text and accessibilityLabel / placeholder / title literals go through t() (ADR 0122)", () => {
  const offenders: string[] = [];
  for (const root of ROOTS)
    for (const f of sourceFiles(root, /\.tsx$/)) {
      const source = withoutComments(readFileSync(f, "utf8"));
      const where = (i: number) => `${relative(APP, f)}:${source.slice(0, i).split("\n").length}`;
      for (const m of source.matchAll(/>([^<>{}]*[A-Za-zÀ-ÿ][^<>{}]*)</g)) {
        const text = (m[1] ?? "").trim();
        const prev = source[(m.index ?? 0) - 1];
        if (prev === "=" || prev === "-" || /^[,;:]/.test(text) || /^[&|]\s*[\w.]+$/.test(text)) continue;
        if (!text || /=>|;|\(|\)|&&|\|\||=|\bconst\b|\breturn\b|\bnew\b|\*/.test(text) || allowed(text)) continue;
        offenders.push(`${where(m.index ?? 0)} text "${text}"`);
      }
      for (const m of source.matchAll(
        /\b(accessibilityLabel|accessibilityHint|placeholder|title|label)="([^"]*[A-Za-zÀ-ÿ][^"]*)"/g,
      )) {
        if (allowed(m[2] ?? "")) continue;
        offenders.push(`${where(m.index ?? 0)} ${m[1]}="${m[2]}"`);
      }
    }
  expect(offenders).toEqual([]);
});

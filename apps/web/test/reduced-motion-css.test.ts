import { expect, test } from "bun:test";
import path from "node:path";
import { Glob } from "bun";

const ROOT = path.join(import.meta.dir, "../../..");
const SOURCES = ["apps/web/src", "packages/ui/src", "apps/desktop/src"];

interface Rule {
  selectors: string[];
  body: string;
  /** The @media blocks it sits in. */
  media: string[];
}

/** A stylesheet's rules, each with the @media blocks around it (keyframes left out). */
function rulesOf(css: string): Rule[] {
  const rules: Rule[] = [];
  const open: string[] = [];
  let text = "";
  for (const ch of css.replace(/\/\*[\s\S]*?\*\//g, "")) {
    if (ch === "{") {
      open.push(text.trim());
      text = "";
    } else if (ch === "}") {
      const head = open.pop() ?? "";
      if (!head.startsWith("@") && !open.some((h) => h.startsWith("@keyframes"))) {
        const selectors = head.split(",").map((s) => s.trim().replace(/\s+/g, " "));
        rules.push({ selectors, body: text, media: open.filter((h) => h.startsWith("@media")) });
      }
      text = "";
    } else text += ch;
  }
  return rules;
}

test("with reduced motion nothing loops: every endless animation runs only when motion is allowed, or is turned off", async () => {
  const left: string[] = [];
  for (const dir of SOURCES) {
    for await (const file of new Glob("**/*.css").scan(path.join(ROOT, dir))) {
      const rules = rulesOf(await Bun.file(path.join(ROOT, dir, file)).text());
      const reduce = rules.filter((r) => r.media.some((m) => m.includes("prefers-reduced-motion: reduce")));
      const off = (selector: string) =>
        reduce.some(
          (r) => /animation:\s*none/.test(r.body) && (r.selectors.includes(selector) || r.selectors[0] === "*"),
        );
      for (const rule of rules) {
        if (!/animation[^:;]*:[^;]*\binfinite\b/.test(rule.body)) continue;
        if (rule.media.some((m) => m.includes("prefers-reduced-motion: no-preference"))) continue;
        for (const selector of rule.selectors) if (!off(selector)) left.push(`${dir}/${file}: ${selector}`);
      }
    }
  }
  expect(left).toEqual([]);
});

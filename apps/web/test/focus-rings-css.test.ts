import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

const ROOT = new URL("../../../", import.meta.url).pathname;
/** While a mouse, a finger or a pen leads, <html> has data-pointer (`trackInput`): no rule draws a ring then. */
const KEYS_ONLY = "html:not([data-pointer]) ";
/** Ink, or a color of its own, where the design system's gray ring belongs. */
const OWN_COLOR = /var\(--(ink|ink2|frame-ink|sky-ink)\)|#[0-9a-f]{3,8}\b|rgba?\(/i;
/** Drawn on a surface of their own (the welcome sky, an agent's colored frame), where gray wouldn't show. */
const OWN_SURFACES = [".sky-welcome__close", ".welcome-card__", ".brw-mf__now"];

/**
 * A selector list's selectors, split at the commas outside parentheses, each run of whitespace one space: the formatter
 * breaks a long selector at its combinators, after the gate too.
 */
function selectors(list: string) {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i] === "(") depth++;
    else if (list[i] === ")") depth--;
    else if (list[i] === "," && depth === 0) {
      out.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  return [...out, list.slice(start).trim()].map((s) => s.replace(/\s+/g, " "));
}

describe("focus rings", () => {
  test("every rule that draws a keyboard ring is for the keys only, in the design system's colors", async () => {
    const sheets = ["packages/ui/src/styles/components.css"];
    for await (const path of new Glob("apps/web/src/**/*.css").scan(ROOT)) sheets.push(path);
    const ungated: string[] = [];
    const colored: string[] = [];
    for (const path of sheets) {
      const css = (await Bun.file(ROOT + path).text()).replace(/\/\*[\s\S]*?\*\//g, "");
      for (const [, list = "", body = ""] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const rings = body.split(";").filter((d) => /^\s*(outline|outline-color|box-shadow)\s*:/.test(d));
        if (rings.length === 0) continue;
        for (const selector of selectors(list)) {
          if (!selector.replace(/:not\((?:[^()]|\([^()]*\))*\)/g, "").includes(":focus-visible")) continue;
          if (selector.startsWith("html[data-pointer]")) continue;
          if (!selector.startsWith(KEYS_ONLY) && !selector.startsWith(`:where(${KEYS_ONLY.trim()})`))
            ungated.push(`${path}: ${selector}`);
          if (!OWN_SURFACES.some((s) => selector.includes(s)))
            for (const ring of rings) if (OWN_COLOR.test(ring)) colored.push(`${path}: ${selector} { ${ring.trim()} }`);
        }
      }
    }
    expect(ungated).toEqual([]);
    expect(colored).toEqual([]);
  });

  test("a tooltip or the row's hover chrome opens on the keys' focus only, never on focus a script handed back", async () => {
    const sheets = ["packages/ui/src/styles/components.css"];
    for await (const path of new Glob("apps/web/src/**/*.css").scan(ROOT)) sheets.push(path);
    const ungated: string[] = [];
    for (const path of sheets) {
      const css = (await Bun.file(ROOT + path).text())
        .replace(/\/\*[\s\S]*?\*\//g, "")
        // A tap on touch has no hover to go by: that's the press's own focus.
        .replace(/@media \(hover: none\)[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
      for (const [, list = ""] of css.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
        for (const selector of selectors(list)) {
          if (
            !/:focus(-visible|-within)?\b.*(__tip|__note-tip|\.ac-msg__actions|__gutter-time|\.ac-react--add)/.test(
              selector,
            )
          )
            continue;
          if (!selector.startsWith(KEYS_ONLY)) ungated.push(`${path}: ${selector}`);
        }
      }
    }
    expect(ungated).toEqual([]);
  });
});

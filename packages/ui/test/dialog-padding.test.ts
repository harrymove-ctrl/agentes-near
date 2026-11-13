import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("../../../", import.meta.url).pathname;
const SOURCES = ["apps/web/src", "packages/ui/src"];
const KIT = join(ROOT, "packages/ui/src/styles/components.css");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".css") ? [join(dir, e.name)] : [],
  );
}

const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Every rule as [file, selector, body]; rules inside @media included. */
async function allRules() {
  const out: [string, string, string][] = [];
  for (const file of SOURCES.flatMap((d) => files(join(ROOT, d)))) {
    for (const m of strip(await Bun.file(file).text()).matchAll(/([^{}]+)\{([^{}]*)\}/g))
      for (const selector of (m[1] ?? "").split(","))
        out.push([relative(ROOT, file), selector.replace(/\s+/g, " ").trim(), m[2] ?? ""]);
  }
  return out;
}

type Side = "top" | "right" | "bottom" | "left";

/** The padding a rule sets, per side (the shorthand expanded, longhands after it win). */
function padding(body: string) {
  const out: Partial<Record<Side, string>> = {};
  for (const [, prop, raw] of body.matchAll(/(?:^|;)\s*(padding(?:-top|-right|-bottom|-left)?)\s*:\s*([^;]+)/g)) {
    const value = (raw ?? "").trim();
    if (prop === "padding") {
      const v = value.match(/(?:calc|var|env|min|max)\([^()]*(?:\([^()]*\)[^()]*)*\)|[^\s]+/g) ?? [];
      const [t, r = t, b = t, l = r] = v;
      Object.assign(out, { top: t, right: r, bottom: b, left: l });
    } else out[(prop ?? "").slice(8) as Side] = value;
  }
  return out;
}

/** A dialog part's outer edges (where it meets the dialog's border), and the token those edges take. */
const EDGES: [RegExp, Side[], string][] = [
  [/\.ac-dialog__head(?![\w-])/, ["top", "left", "right"], "--dialog-pad"],
  [/\.ac-dialog__(?:desc|tools|body|list)(?![\w-])/, ["left", "right"], "--dialog-pad"],
  [/\.ac-dialog__(?:body|list)(?![\w-])[^\s>+~]*:last-child/, ["bottom"], "--dialog-pad"],
  [/\.ac-dialog__foot(?:--bar)?(?![\w-])/, ["left", "right", "bottom"], "--dialog-pad"],
  [/\.ac-details__head(?![\w-])/, ["top", "left", "right"], "--details-pad"],
  [/\.ac-details__(?:body|foot)(?![\w-])/, ["left", "right", "bottom"], "--details-pad"],
];

describe("dialog padding", () => {
  test("one inset per dialog: 20 px (a phone's sheet 16), details 24 (16)", async () => {
    const css = strip(await Bun.file(KIT).text());
    expect(css).toMatch(/\n\.ac-dialog \{[^}]*--dialog-pad: 20px;/);
    expect(css).toMatch(/\n\.ac-details \{[^}]*--details-pad: 24px;/);
    const phone = css.split("@media (max-width: 640px) {").slice(1).join("\n");
    expect(phone).toMatch(/\.ac-dialog \{[^}]*--dialog-pad: 16px;/);
    expect(phone).toMatch(/\.ac-details--lg[\s,.a-z-]*\{[^}]*--details-pad: 16px;/);
  });

  test("every edge of every dialog takes its dialog's inset: the bottom as the top, the top as the sides", async () => {
    const off: string[] = [];
    for (const [file, selector, body] of await allRules()) {
      // Full screen's floating bar is a pill over the screen, not an edge of the dialog.
      if (selector.includes(".is-screen-only")) continue;
      const pad = padding(body);
      for (const [part, sides, token] of EDGES) {
        // The part is what the rule styles (its last compound), not an ancestor of it; a combinator inside `:has(…)` or
        // `:not(…)` doesn't start a compound (`.ac-dialog__body:has(+ .ac-dialog__foot--bar)` styles the body).
        const last =
          selector
            .replace(/\((?:[^()]|\([^()]*\))*\)/g, "()")
            .split(/[\s>+~]+/)
            .pop() ?? "";
        if (!part.test(last)) continue;
        for (const side of sides) {
          const value = pad[side];
          // 0 is a full-bleed part (a code view, a sky over the head); anything else measures from the inset.
          if (value !== undefined && value !== "0" && !value.includes(`var(${token})`))
            off.push(`${file} ${selector} padding-${side}: ${value}`);
        }
      }
    }
    expect(off).toEqual([]);
  });
});

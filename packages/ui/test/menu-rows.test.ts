import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../../../", import.meta.url).pathname;
const kit = readFileSync(join(ROOT, "packages/ui/src/styles/components.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The body of the rule for exactly `selector`, wherever it stands in a selector list. */
const rule = (selector: string) =>
  [...kit.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => (m[1] ?? "").split(",").some((s) => s.trim() === selector))
    .map((m) => m[2])
    .join("\n");

test("a long menu scrolls in its flex column, and its rows keep their height there", () => {
  // Why it matters: the menu is a capped flex column that scrolls, and a row has a minimum height of its own.
  expect(rule(".ac-menu")).toContain("display: flex;");
  expect(rule(".ac-menu")).toContain("overflow-y: auto;");
  expect(rule(".ac-menu__item")).toContain("min-height: var(--menu-item-h);");
  // So a row never shrinks to that minimum: "Automático" and its line would lie over the model under it.
  expect(rule(".ac-menu__item")).toContain("flex-shrink: 0;");
});

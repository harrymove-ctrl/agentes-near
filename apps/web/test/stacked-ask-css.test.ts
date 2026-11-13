import { expect, test } from "bun:test";
import { join } from "node:path";
import { declarations, topLevel } from "./built-css";

const SRC = join(import.meta.dir, "../src");
const sheet = async (file: string) => topLevel(await Bun.file(join(SRC, file)).text());

test("the take-control question stacks its buttons: take control, then Cancelar centered under it", async () => {
  expect(declarations(await sheet("components/browser/browser.css"), ".brw-dim__acts")).toEqual([
    ["display", "flex"],
    ["flex-direction", "column"],
    ["align-items", "center"],
    ["gap", "var(--space-1)"],
  ]);
});

test("a card's last settings row is as deep under its control as above its title, over the card's foot", async () => {
  const css = await sheet("layout.css");
  // The rows reach the card's edges (`--card-pad`) and the card spaces its children by `--space-3`: over a foot the
  // rows give that gap back, so the last row's own padding is all that's under it.
  expect(declarations(css, ".settings-rows")).toContainEqual(["margin", "calc(-1 * var(--card-pad))"]);
  expect(declarations(css, ".settings-row")).toContainEqual(["padding", "var(--row-py) var(--card-pad)"]);
  expect(declarations(css, ".settings-rows:has(+ .ac-card__foot)")).toEqual([
    ["margin-bottom", "calc(-1 * var(--space-3))"],
  ]);
  const card = await Bun.file(join(SRC, "../../../packages/ui/src/styles/components.css")).text();
  expect(declarations(topLevel(card), ".ac-card")).toContainEqual(["gap", "var(--space-3)"]);
  expect(declarations(topLevel(card), ".ac-card__foot")).toContainEqual([
    "margin",
    "0 calc(0px - var(--card-pad, 16px)) calc(0px - var(--card-pad, 16px))",
  ]);
});

import { expect, test } from "bun:test";
import { builtCss, declarations, topLevel } from "./built-css";

const css = topLevel(
  await builtCss("src/styles.css", "src/components/notice-island.css", "src/components/request-card.css"),
);
const last = (selector: string, property: string) =>
  declarations(css, selector)
    .filter(([p]) => p === property)
    .at(-1)?.[1];

test("the inbox's times end at the card's edge on every row, the hover bar floating over the time", async () => {
  const inbox = await builtCss("src/pages/notifications.css");
  // Room kept per row for its buttons put each row's time somewhere else.
  expect(inbox).not.toContain("--nt-acts-room");
  expect(inbox).toMatch(/\.nt-item:is\([^{]*\.is-cur[^{]*\.nt-tm\{visibility:hidden\}/);
});

test("a wiki folder's name stops short of the button beside its count", async () => {
  expect(await builtCss("src/pages/wiki.css")).toContain(".wiki-folder-row .wiki-row__t{margin-right:30px}");
});

test("an agent's answer choices grow with their text and wrap: the island, the conversation's card, notifications", () => {
  for (const choice of [".ni__choice", ".rq__choice"]) {
    const own = declarations(css, choice);
    // A fixed height let a two-line choice spill over the next one.
    expect([choice, own.filter(([p, v]) => p === "height" && v !== "auto")]).toEqual([choice, []]);
    expect([choice, last(choice, "min-height") !== undefined]).toEqual([choice, true]);
    expect([choice, last(choice, "white-space") ?? "normal"]).toEqual([choice, "normal"]);
    expect([choice, last(choice, "text-align"), last(choice, "overflow-wrap"), last(choice, "max-width")]).toEqual([
      choice,
      "left",
      "anywhere",
      "100%",
    ]);
  }
  // Buttons on the ruler's small corner, as the conversation's card and notifications have them: never a pill that
  // reads as broken once it wraps.
  expect(last(".ni__choice", "border-radius")).toBe("var(--control-r-sm)");
});

test("the island's open list keeps a max height and scrolls inside", () => {
  expect(last(".ni__list", "max-height")).toBeDefined();
  expect(last(".ni__list", "overflow")).toBe("auto");
});

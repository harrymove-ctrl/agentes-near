import { expect, test } from "bun:test";
import { join } from "node:path";
import { atRule, declarations, topLevel } from "./built-css";

const css = await Bun.file(join(import.meta.dir, "../src/layout.css")).text();
const last = (sheet: string, selector: string, property: string) =>
  declarations(sheet, selector)
    .filter(([p]) => p === property)
    .at(-1)?.[1];

test("the activity bar's room opens and closes in a glide (by its cap, from 0), still with reduced motion", () => {
  const idle = '.channel__composer > .ac-typing:not([data-active="true"])';
  expect(last(topLevel(css), idle, "max-height")).toBe("0");
  // Open, at least its one low line and room for a name on a second (`max-height`, what the glide runs to).
  expect(last(topLevel(css), '.ac-typing[data-active="true"]', "min-height")).toBe("28px");
  expect(last(topLevel(css), '.ac-typing[data-active="true"]', "max-height")).toBe("64px");
  expect(last(topLevel(css), '.ac-typing[data-active="true"]', "height")).toBeUndefined();
  const motion = atRule(css, "@media (prefers-reduced-motion: no-preference)");
  const glide = last(motion, ".channel__composer > .ac-typing", "transition") ?? "";
  expect(glide).toContain("max-height 180ms");
  expect(glide).toContain("margin 180ms");
  expect(last(topLevel(css), ".channel__composer > .ac-typing", "transition")).toBeUndefined();
});

test("an attachment's box is the same before and after what it holds loads: nothing under it moves", async () => {
  const sheet = topLevel(css);
  // A tile still loading is the cover and the name it will keep (`LoadingTile`), never a height of its own.
  expect(last(sheet, ".artifact-tile--loading", "height")).toBeUndefined();
  expect(last(sheet, ".artifact-tile__cover", "height")).toBe("var(--tile-cover)");
  // A picture alone is whole inside the lone tile's box: no rule sizes the tile, its cover or its picture by the
  // picture's own proportions, which are known only once it decodes.
  const lone = ".artifact-cards > .artifact-tile[data-media]:only-child";
  expect(last(sheet, `${lone} .artifact-tile__picture img`, "object-fit")).toBe("contain");
  expect(declarations(sheet, lone)).toEqual([]);
  expect(declarations(sheet, `${lone} .artifact-tile__cover`)).toEqual([]);
  for (const size of ["width", "height", "max-height", "min-height"])
    expect(last(sheet, `${lone} .artifact-tile__picture img`, size)).toBeUndefined();
  expect(css).not.toContain(".artifact-tile__picture[data-loading]");
  // A video: one box before and after its metadata.
  const kit = topLevel(await Bun.file(join(import.meta.dir, "../../../packages/ui/src/styles/components.css")).text());
  expect(last(kit, ".ac-video--tile .ac-video__media", "width")).toBe("320px");
  expect(last(kit, ".ac-video--tile .ac-video__media", "height")).toBe("180px");
  expect(last(kit, ".ac-video--tile .ac-video__media", "max-width")).toBe("100%");
  expect(kit).not.toContain(".ac-video--tile[data-tall]");
  expect(kit).not.toContain(".ac-video--tile:not([data-ready])");
});

test("a file's name wraps whole, never ending in …; on a phone a file takes the row, pictures two to a row (#51)", () => {
  for (const part of [".artifact-tile__title", ".artifact-tile__meta"]) {
    expect(last(topLevel(css), part, "overflow-wrap")).toBe("anywhere");
    expect(last(topLevel(css), part, "text-overflow")).toBeUndefined();
    expect(last(topLevel(css), part, "white-space")).toBeUndefined();
  }
  const phone = atRule(css, "@media (max-width: 640px)");
  expect(last(phone, ".artifact-tile", "--tile-w")).toBe("calc(50% - 5px)");
  // A tile still loading too: it knows whether it is a picture, so it has its row before its details arrive.
  expect(last(phone, ".artifact-tile:not([data-media])", "--tile-w")).toBe("100%");
});

test("two tiles to a row on a small phone: a document's cover is drawn smaller, its lines keeping their words", () => {
  // At 120px (a 320px phone) a document's words at their size wrap one or two a line.
  const cover = ".artifact-tile__cover:has(> :is(.artifact-tile__doc, .artifact-tile__text))";
  expect(last(topLevel(css), cover, "container")).toBe("tile-cover / inline-size");
  const narrow = atRule(css, "@container tile-cover (max-width: 150px)");
  expect(last(narrow, ":is(.artifact-tile__doc, .artifact-tile__text)", "zoom")).toBe("0.75");
});

test("the newest rows are never skipped: a message I send is its own height when the glide down reads the end", () => {
  // A row that just came in would start skipped, at the 56px placeholder: the glide would stop short of its real
  // height, and the list jump up the rest once it ends.
  const newest = ".channel__messages > .ac-msg:nth-last-of-type(-n + 3)";
  expect(last(topLevel(css), newest, "content-visibility")).toBe("visible");
  expect(last(topLevel(css), ".channel__messages .ac-msg", "content-visibility")).toBe("auto");
});

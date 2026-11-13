import { expect, test } from "bun:test";
import { builtCss, declarations, rules, topLevel } from "./built-css";

const css = topLevel(
  await builtCss(
    "src/styles.css",
    "src/components/channel-header.css",
    "src/components/notice-island.css",
    "src/components/computer-queue.css",
  ),
);
const last = (selector: string, property: string) =>
  rules(css)
    .filter((r) => r.selectors.includes(selector))
    .flatMap((r) => r.declarations)
    .filter(([p]) => p === property)
    .at(-1)?.[1];

test("every count pill centres its figures' own box, and the production build keeps it", () => {
  for (const pill of [".ac-count", ".ac-countchip"]) {
    expect([pill, last(pill, "display"), last(pill, "align-content"), last(pill, "text-align")]).toEqual([
      pill,
      "inline-block",
      "center",
      "center",
    ]);
    expect([pill, last(pill, "text-box")]).toEqual([pill, "trim-both cap alphabetic"]);
  }
  // The pills that size themselves (the sidebar's red count, the rail's, the header's threads count, the island's +N)
  // set no line height or display of their own: either would undo the centring.
  const own = rules(css).filter((r) =>
    r.selectors.some((s) => /sidebar__unread|\.ac-count\b|channel__icon-count|ni__count/.test(s)),
  );
  const undo = own.flatMap((r) =>
    r.declarations
      .filter(([p, v]) => p === "line-height" || p === "place-items" || (p === "display" && v !== "none"))
      .map(([p, v]) => `${r.selectors.join(",")} ${p}:${v}`),
  );
  expect(undo.filter((d) => !d.startsWith(".ac-count,.ac-countchip "))).toEqual([]);
});

test("in the build the bell's unread count keeps the sidebar's red, after the kit's neutral count, on the bell's corner", () => {
  const painted = (selector: string) =>
    rules(css).findLastIndex((r) => r.selectors.includes(selector) && r.declarations.some(([p]) => p === "background"));
  expect(painted(".sidebar__unread")).toBeGreaterThan(painted(".ac-count"));
  const corner = Object.fromEntries(
    declarations(css, '.sidebar:not([data-rail="true"]) .sidebar__bell > .sidebar__unread'),
  );
  expect([corner.position, corner["box-shadow"]]).toEqual(["absolute", "0 0 0 2px var(--raised)"]);
});

test("a text button has no plate and no padding: house links, and Não rodar's words where the message's start", () => {
  expect(last(":where(button).ac-link", "padding")).toBe("0");
  // The minifier writes `background: none` as `0 0`.
  expect(last(":where(button).ac-link", "background")).toBe("0 0");
  expect(last(".cq-link", "padding")).toBe("0");
  expect(last(".cq-link", "background")).toBe("0 0");
  expect(last(".ac-link--muted:hover", "color")).toBe("var(--ink)");
});

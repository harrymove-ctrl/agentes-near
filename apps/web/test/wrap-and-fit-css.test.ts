import { expect, test } from "bun:test";
import { atRule, builtCss, declarations, rules, topLevel } from "./built-css";

const css = await builtCss("src/styles.css", "src/pages/routines.css", "src/components/plan-usage.css");
const top = topLevel(css);
const last = (sheet: string, selector: string, property: string) =>
  declarations(sheet, selector)
    .filter(([p]) => p === property)
    .at(-1)?.[1];

test("a settings row's control centres on its words, never pinned to the first line, the row one compact control tall", () => {
  // Nothing lifts or tops what ends a row: the label and its control share the row's middle, a status line included.
  const pinned: string[] = [];
  for (const rule of rules(css))
    for (const s of rule.selectors.filter(
      (s) => s.includes(".settings-row") && /settings-row__(end|control|chevron)/.test(s),
    ))
      for (const [p, v] of rule.declarations)
        if ((p === "translate" && v !== "none") || (p === "align-self" && v === "flex-start"))
          pinned.push(`${s} {${p}: ${v}}`);
  expect(pinned).toEqual([]);
  const row = last(top, ".settings-row", "align-items");
  expect(row).toBe("center");
  expect(last(top, ".settings-row", "min-height")?.replace(/\s+/g, "")).toBe(
    "calc(var(--control-h-sm)+2*var(--row-py))",
  );
  // On a phone every control but a switch goes under the words, from their edge, and sits where it falls.
  const phone = atRule(css, "@media (max-width: 760px)");
  const under = ".settings-row--lead>.settings-row__end:not(:has(>.ac-switch))";
  expect(last(phone, under, "flex-basis")).toBe("100%");
  expect(last(phone, under, "padding-left")?.replace(/\s+/g, "")).toBe("calc(28px+var(--space-3))");
  // Never wider than the row: a select or a field shrinks into it instead of running past the card's edge.
  expect(last(phone, under, "min-width")).toBe("0");
  expect(last(phone, ".settings-row--lead>.settings-row__end:has(>.ac-seg)", "flex-basis")).toBeUndefined();
  // The agent's panel beside a narrow conversation lays a row with an icon out as a phone does.
  const panel = atRule(css, "@container agp-side (max-width: 479px)");
  expect(last(panel, ".agp-card .settings-row--lead", "flex-wrap")).toBe("wrap");
  expect(last(panel, ".agp-card .settings-row--lead>.settings-row__end:not(:has(>.ac-switch))", "translate")).toBe(
    "none",
  );
  expect(last(panel, ".agp-card .settings-row", "flex-direction")).toBeUndefined();
});

test("a text field of several lines in a settings row keeps its rows: the row's one-line control height spares it", () => {
  expect(last(top, "textarea.ac-input", "height")).toBe("auto");
  // What a rule in a settings row gives a height to, a textarea (`textarea`, or an `.ac-input` not kept to inputs).
  const squeezes = (selector: string) => {
    const inRow = selector.slice(selector.indexOf(".settings-row"));
    return (
      /(^|[^\w-])textarea\b/.test(inRow.replaceAll(":not(textarea)", "")) ||
      /\.ac-input(?![\w-])(?!:not\(textarea\))/.test(inRow)
    );
  };
  const squeezed = rules(css).flatMap((rule) =>
    rule.declarations.some(([p]) => p === "height" || p === "block-size")
      ? rule.selectors.filter((s) => s.includes(".settings-row") && squeezes(s))
      : [],
  );
  expect(squeezed).toEqual([]);
});

test("what a row says wraps instead of losing its end to an ellipsis", () => {
  for (const selector of [
    ".routine-row__when-text b",
    ".routine-row__when-text small",
    ".plan-acct__sub",
    ".settings__org>span",
  ]) {
    expect([selector, last(top, selector, "text-overflow")]).toEqual([selector, undefined]);
    expect([selector, last(top, selector, "white-space")]).toEqual([selector, undefined]);
  }
  // An agent's and a connector's names wrap by words, never a letter a line; a level stays whole.
  expect(last(top, ".level-matrix th", "white-space")).toBe("normal");
  expect(last(top, ".level-matrix th", "overflow-wrap")).toBe("break-word");
  expect(last(top, ".level-matrix td", "white-space")).toBe("nowrap");
});

test("usage on a phone: the figures under the name, as wide as the row, not squeezed into a column beside it", () => {
  const phone = atRule(css, "@media (max-width: 720px)");
  expect(last(phone, ".plan-api__row", "grid-template-columns")?.replace(/\s+/g, "")).toBe("28pxminmax(0,1fr)");
  expect(last(phone, ".plan-api__value", "grid-column")?.replace(/\s+/g, "")).toBe("1/-1");
  expect(last(phone, ".plan-api__value", "text-align")).toBe("left");
  expect(last(phone, ".plan-source", "grid-template-columns")?.replace(/\s+/g, "")).toBe("minmax(0,1fr)");
  expect(last(phone, ".plan-source__n", "align-items")).toBe("flex-start");
});

test("a long workspace name never widens the settings' nav", () => {
  expect(last(top, ".settings__nav", "min-width")).toBe("0");
});

test("an agent's identity on a phone: its card as wide as the page, a long role wrapping inside its tag", () => {
  for (const sheet of [atRule(css, "@media (max-width: 640px)"), atRule(css, "@container agp-side (max-width: 640px)")])
    expect(last(sheet, ".agp-id__fields", "align-self")).toBe("stretch");
  expect(last(top, ".agp-roletag", "height")).toBeUndefined();
  expect(last(top, ".agp-roletag", "min-height")).toBe("28px");
  expect(last(top, ".agp-roletag__text", "white-space")).toBeUndefined();
  expect(last(top, ".agp-roletag__text", "text-overflow")).toBeUndefined();
  // The field it turns into keeps the tag's one line.
  expect(last(top, ".agp-roletag.agp-roletag--edit", "height")).toBe("28px");
  // A name that wraps keeps its pencil on its first line.
  expect(last(top, ".agp-inplace", "align-items")).toBe("flex-start");
  expect(last(atRule(css, "@supports (top: 1lh)"), ".agp-inplace__pen", "height")).toBe("1lh");
});

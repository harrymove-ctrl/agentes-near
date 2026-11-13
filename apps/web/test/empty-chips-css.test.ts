import { expect, test } from "bun:test";
import { atRule, builtCss, declarations, topLevel } from "./built-css";

test("what ships keeps an empty conversation's suggestions inside their card at every width, phones too", async () => {
  const css = await builtCss("src/styles.css", "src/pages/home.css");
  const shipped = topLevel(css);
  const phone = atRule(css, "@media (max-width: 640px)");
  const touch = atRule(css, "@media (pointer: coarse)");
  const last = (sheet: string, selector: string, property: string) =>
    declarations(sheet, selector)
      .filter(([p]) => p === property)
      .at(-1)?.[1];

  // An empty state's actions wrap, and none grows wider than the card: a long one wraps its words instead.
  expect(last(shipped, ".ac-empty__actions", "flex-wrap")).toBe("wrap");
  expect(last(shipped, ".ac-empty__actions .ac-btn", "max-width")).toBe("100%");
  expect(last(shipped, ".ac-empty__actions .ac-btn", "white-space")).toBe("normal");
  expect(last(shipped, ".ac-empty__actions .ac-btn", "height")).toBe("auto");
  expect(last(shipped, ".channel__suggestions", "max-width")).toBe("100%");
  // On touch a small one keeps its 32px plate, as every small button does (its target grows past it).
  expect(last(touch, ".ac-empty__actions .ac-btn--sm", "min-height")).toBeUndefined();

  // A phone: one suggestion per row, as wide as the card.
  expect(last(phone, ".channel__suggestions", "flex-direction")).toBe("column");
  expect(last(phone, ".channel__suggestions", "width")).toBe("100%");
  expect(last(phone, ".channel__suggestions", "align-items")).toBe("stretch");
  // Only the card's sides narrow: a DM with an agent keeps its sky's top and its bottom.
  const card = declarations(phone, ".channel__empty .ac-empty").map(([p]) => p);
  expect(card.length).toBeGreaterThan(0);
  expect(card.filter((p) => !/^padding-(inline|left|right)/.test(p))).toEqual([]);

  // Início's rows are MediaRows: in a list under 480px their button goes under the text (`__end--wrap`), which keeps
  // the row's width; no phone rule of the page's own puts it in a column beside the face.
  expect(last(shipped, ".home-list", "container-type")).toBe("inline-size");
  expect(last(phone, ".home-row", "grid-template-columns")).toBeUndefined();
  expect(last(phone, ".home-row__act", "grid-column")).toBeUndefined();
});

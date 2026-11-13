import { expect, test } from "bun:test";

const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text();
/** The declarations of the first rule written exactly as `selector {`, at the top level or one block deep. */
const rule = (selector: string) =>
  (css.split(`\n${selector} {`)[1] ?? css.split(`\n  ${selector} {`)[1])?.split("}")[0] ?? "";

test("the action line: words on their one-line width, actions beside them only while that fits, an empty slot takes no room", () => {
  expect(rule(".ac-actline")).toContain("flex-wrap: wrap");
  expect(rule(".ac-actline")).toContain("gap: var(--space-2) var(--space-4)");
  expect(rule(".ac-actline > :first-child")).toContain("flex: 1 1 auto");
  expect(rule(".ac-actline > :not(:first-child)")).toContain("flex: none");
  expect(rule(".ac-actline > :not(:first-child)")).toContain("margin-inline-start: 0");
  // A slot the viewer has nothing in (an action they may not take) leaves no gap and no row behind.
  expect(rule(".ac-actline > :is(span, div):empty")).toContain("display: none");
});

test("a card's head keeps a lone switch at its end, the words wrapping beside it", () => {
  const head = ".ac-card__head:has(> .ac-card__action > .ac-switch:only-child)";
  expect(rule(head)).toContain("flex-wrap: nowrap");
  expect(rule(`${head} > .ac-card__lead`)).toContain("flex: 1 1 0%");
  expect(rule(`${head} > .ac-card__action`)).toContain("margin-inline-start: 0");
});

test("on a phone a lone button takes the width of what holds it, at its own height", () => {
  const phone = css.split("@media (max-width: 640px) {\n  .ac-card > .ac-acts > .ac-btn:only-child")[1] ?? "";
  expect(phone.split("}")[0]).toContain(":not(.ac-btn--ghost) {\n    flex: 1 1 auto;");
  // A dialog's foot or an empty state with one button: it takes a line of its own, under the foot's note.
  expect(rule(":is(.ac-dialog__foot, .ac-empty__actions):not(:has(> .ac-btn ~ .ac-btn)) > .ac-btn")).toContain(
    "flex: 1 1 100%",
  );
  // Beside a note the one button is the footer's group of buttons: the group takes the line, the button the group.
  expect(
    rule(
      ".ac-dialog__foot-acts:not(:has(> .ac-btn ~ .ac-btn)),\n  .ac-dialog__foot-acts:not(:has(> .ac-btn ~ .ac-btn)) > .ac-btn",
    ),
  ).toContain("flex: 1 1 100%");
  // A MediaRow's end that went under its row: the end takes the row, its one plated button too.
  expect(rule(".ac-mediarow__end--wrap:has(> .ac-btn:only-child:not(.ac-btn--ghost))")).toContain(
    "justify-self: stretch",
  );
  expect(rule(".ac-mediarow__end--wrap > .ac-btn:only-child:not(.ac-btn--ghost)")).toContain("flex: 1 1 auto");
});

import { expect, test } from "bun:test";
import { atRule, builtCss, declarations, topLevel } from "./built-css";

const sheets = () => builtCss("src/styles.css", "src/components/threads/threads.css");
const last = (sheet: string, selector: string, property: string) =>
  declarations(sheet, selector)
    .filter(([p]) => p === property)
    .at(-1)?.[1];

test("a row's minor action, its time and its stop sit right after its words, never pushed to the far edge", async () => {
  const shipped = topLevel(await sheets());
  // "1 thread arquivada não aparece aqui · Ver", "Thread fechada · … · Abrir · Responder": the words don't grow.
  expect(last(shipped, ".thread-closed__text", "flex")).toBeUndefined();
  expect(last(shipped, ".thread-closed", "justify-content")).toBeUndefined();
  // An error line's × right after its words.
  expect(last(shipped, ".ac-msg__error-row>.ac-msg__error", "flex")).toBeUndefined();
  // The receipt's mark right after the time in the name's line.
  expect(last(shipped, ".ac-msg__aside", "margin-left")).toBeUndefined();
  // The header's "· 2 s ■": the clock with no room kept for its seconds.
  expect(last(shipped, ".run-tail__clock", "min-width")).toBeUndefined();
  // No thinking row in the conversation any more: the bar above the composer says it.
  expect(shipped).not.toContain(".ac-wait");
  // The bar's step the same way.
  expect(last(shipped, ".ac-typing__step", "flex")).not.toContain("260px");
  expect(last(shipped, ".ac-typing__step", "max-width")).toBeUndefined();
});

test("a thread floats over the window like a dialog, 10px in, over a scrim; a phone keeps the whole-screen sheet", async () => {
  const css = await sheets();
  const base = topLevel(css);
  const phone = atRule(css, "@media (max-width: 860px)");
  expect(last(base, ".thread-panel", "position")).toBe("fixed");
  for (const edge of ["top", "right", "bottom"]) expect(last(base, ".thread-panel", edge)).toBe("10px");
  // As wide as it always was (640px), from the window, rounded and lifted, no hairline of its own.
  expect(last(base, ".thread-panel", "width")).toBe("min(640px,100vw - 20px)");
  expect(last(base, ".thread-panel", "border-radius")).toBe("var(--radius-section)");
  expect(last(base, ".thread-panel", "box-shadow")).toBe("var(--e3), var(--top)");
  expect(last(base, ".thread-panel", "border-left")).toBeUndefined();
  expect(last(base, ".thread-panel__scrim", "inset")).toBe("0");
  expect(last(base, ".thread-panel__scrim", "position")).toBe("fixed");
  expect(last(phone, ".thread-panel", "inset")).toBe("0");
  expect(last(phone, ".thread-panel", "border-radius")).toBe("0");
  expect(last(phone, ".thread-panel__scrim", "display")).toBe("none");
  // No docked variant left.
  expect(css).not.toContain("thread-panel--docked");
  // A narrow panel drops the channel's name and its "·", never leaving a lone "· 2 respostas".
  const slim = atRule(atRule(css, "@media (min-width: 861px)"), "@container thread-dock (max-width: 479px)");
  expect(last(slim, ".thread-head__meta>.thread-head__where", "display")).toBe("none");
});

test("on a phone a thread's head keeps its actions on top and gives the faces, the title and its line the row under them", async () => {
  const css = await sheets();
  const phone = atRule(css, "@media (max-width: 760px)");
  expect(last(phone, ".thread-head:has(> .thread-head__text)", "flex-wrap")).toBe("wrap");
  expect(last(phone, ".thread-head:has(> .thread-head__text)::after", "flex-basis")).toBe("100%");
  expect(last(phone, ".thread-head:has(> .thread-head__text)::after", "order")).toBe("1");
  for (const part of [".thread-head>.thread-head__who", ".thread-head>.thread-head__text"])
    expect(last(phone, part, "order")).toBe("2");
  expect(last(phone, ".thread-head>.thread-head__text+*", "margin-left")).toBe("auto");
  // The title's own "…" where a phone makes the title a block, the editable title a button that wouldn't shrink.
  expect(last(topLevel(css), ".thread-title__button", "max-width")).toBe("100%");
});

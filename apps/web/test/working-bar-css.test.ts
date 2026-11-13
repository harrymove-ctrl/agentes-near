import { expect, test } from "bun:test";
import { builtCss, declarations, topLevel } from "./built-css";

test("what ships keeps the bar above the composer one low width, the composer's: the words take what is left, the clock ticks in place", async () => {
  const css = topLevel(await builtCss());
  const last = (selector: string, property: string) =>
    declarations(css, selector)
      .filter(([p]) => p === property)
      .at(-1)?.[1];
  const bar = '.ac-typing[data-active="true"]';
  // One width whatever it says or shows (a turning phrase, the seconds, "Ver" or the stop coming and going): no width
  // of its own and no cap, so it fills the composer's column, its edges on the composer's (the channel, a thread in
  // the panel, a DM, a task's conversation alike).
  expect(last(bar, "width")).toBeUndefined();
  expect(last(bar, "max-width")).toBeUndefined();
  expect(last(".ac-typing", "margin")).toBe("0 0 var(--space-1)");
  // One low line, a second only for a name that needs it: a name is never cut.
  expect(last(bar, "min-height")).toBe("28px");
  expect(last(bar, "height")).toBeUndefined();
  // The words never size it: they take the room left, on one line.
  const words = `${bar} .ac-typing__text`;
  expect(last(words, "display")).toBe("flex");
  expect(last(words, "flex")).toBe("1 1 0");
  expect(last(words, "min-width")).toBe("0");
  expect(last(words, "white-space")).toBe("nowrap");
  // Who is typing keeps its width (the agents' words before it give way, their " · " cut with them), and only the
  // names in it end in "…".
  expect(last(".ac-typing__agents", "overflow")).toBe("hidden");
  expect(last(".ac-typing__people", "flex")).toBe("none");
  expect(last(".ac-typing__people", "max-width")).toBe("100%");
  expect(last(".ac-typing__typers", "text-overflow")).toBe("ellipsis");
  // Its round buttons fit the low pill.
  expect(last(".ac-typing .stop-run", "height")).toBe("24px");
  expect(last(".ac-typing__browser.ac-btn", "height")).toBe("24px");
  // An agent's step in the bar is as wide as its words while the bar has room ("planos-concorrentes.md" whole), so
  // the time and the stop follow them; out of room it gives way first, down to nothing.
  expect(last(".ac-typing__step", "max-width")).toBeUndefined();
  expect(last(".ac-typing__step", "min-width")).toBe("0");
  expect(last(".ac-typing__step", "flex")).toBe("0 1000 auto");
  // One agent: its name, step, time and who types beside it are the bar's own pieces; the name wraps, never cut, and
  // what is typed beside it wraps ahead of the stop (no box that lets it run on under it).
  expect(
    last('.ac-typing[data-active="true"] .ac-typing__text:has(>.ac-typing__agents>.ac-typing__step)', "display"),
  ).toBe("contents");
  expect(last(".ac-typing__agents:has(>.ac-typing__step)>b", "white-space")).toBe("normal");
  // Their boxes gone, the name and the step stand over the sky themselves: unpositioned, the sky painted over them.
  expect(last(".ac-typing__agents:has(>.ac-typing__step)>*", "position")).toBe("relative");
  expect(last(".ac-typing__also", "white-space")).toBeUndefined();
  expect(last(".ac-typing__also", "min-width")).toBeUndefined();
  // One agent's pieces grow nothing: the time, or else the globe, the rule before Ver or the stop, takes the room
  // left, so the stop is at the end from the first frame and the time, when it comes, comes in on its left.
  expect(last(".ac-typing__text+.ac-typing__elapsed", "margin-left")).toBe("auto");
  expect(
    last(
      ".ac-typing__text:has(>.ac-typing__agents>.ac-typing__step)+:is(.ac-typing__browser,.ac-typing__sep,.stop-run-wrap)",
      "margin-left",
    ),
  ).toBe("auto");
  // The clock's figures are all one width (`ac-num`), so the seconds never nudge it.
  expect(last(".ac-num", "font-variant-numeric")).toBe("tabular-nums");
});

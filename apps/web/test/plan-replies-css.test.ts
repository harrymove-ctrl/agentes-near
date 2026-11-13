import { expect, test } from "bun:test";
import { builtCss, declarations, topLevel } from "./built-css";

test("what ships puts Atende outras pessoas' switch on its label's line and its line under both, in the panel's type there", async () => {
  const css = await builtCss();
  const shipped = topLevel(css);
  const last = (selector: string, property: string) =>
    declarations(shipped, selector)
      .filter(([p]) => p === property)
      .at(-1)?.[1];

  // The label and the switch on one line, the line saying whom the agent answers under both, with the whole width.
  expect(last(".plan-replies", "display")).toBe("grid");
  expect(last(".plan-replies", "grid-template-columns")).toBe("minmax(0,1fr) auto");
  expect(last(".plan-replies__terms", "grid-column")).toBe("1/-1");
  // The switch's middle on the label's capitals' middle, as an `.ac-iconline` lead's: the 20px line without lh.
  expect(last(".plan-replies>.ac-switch", "translate")).toBe("0 calc(10px - var(--cap-mid) - 50%)");
  expect(css).toContain("@supports (top:1lh){.plan-replies>.ac-switch{translate:0 calc(.5lh - var(--cap-mid) - 50%)}}");

  // In a plan's panel it is the foot: in the type of the panel's lines, its icon on the label's line.
  expect(last(".ai-panel__replies", "font-size")).toBe("14px");
  expect(last(".ai-panel__replies", "line-height")).toBe("20px");
  expect(last(".ai-panel__replies>.plan-replies", "font-size")).toBe("inherit");
  expect(last(".plan-replies", "line-height")).toBe("20px");
});

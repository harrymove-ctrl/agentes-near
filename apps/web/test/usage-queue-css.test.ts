import { expect, test } from "bun:test";
import { atRule, builtCss, declarations } from "./built-css";

const css = await builtCss("src/components/computer-queue.css");
const last = (pairs: (readonly [string, string])[], property: string) => pairs.findLast(([p]) => p === property)?.[1];

test("the usage queue keeps its top while its height changes between Na fila and Puladas", () => {
  // Wide: held by its top, centered only across, and its entrance keeps that.
  const wide = declarations(atRule(css, "@media (min-width: 641px)"), ".ac-dialog.uq-dialog");
  expect(last(wide, "top")).toBe("12vh");
  expect(last(wide, "transform")).toBe("translate(-50%)");
  expect(css).toMatch(/@keyframes uq-dialog-in\{(from|0%)\{opacity:0;transform:translate\(-50%\)scale\(\.97\)\}/);
  // A phone's sheet sits on the bottom edge: one height while the switch shows, so its top stays too.
  const phone = atRule(css, "@media (max-width: 640px)");
  expect(last(declarations(phone, ".ac-dialog.uq-dialog:has(.ac-seg)"), "height")).toContain("520px");
  expect(last(declarations(phone, ".uq-dialog:has(.ac-seg) .ac-dialog__body"), "flex-grow")).toBe("1");
});

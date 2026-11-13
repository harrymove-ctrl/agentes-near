import { expect, test } from "bun:test";
// The command line's logo lives in the MIT setup package, which can't import the engine: it keeps a copy.
import { LOGO_MARK } from "../../setup/src/term";
import { eyeShapes, inBody, toneAt } from "../src/agent/engine.js";

test("the command line's logo is the web's LogoMark: the engine's body, tones and eyes on its 12×12 grid", () => {
  const eyes = eyeShapes("round");
  const grid = Array.from({ length: 12 }, (_, y) =>
    Array.from({ length: 12 }, (_, x) => {
      const u = (x + 0.5) / 12;
      const v = (y + 0.5) / 12;
      if (!inBody(u, v)) return ".";
      if (eyes.some((e) => u >= e.x && u <= e.x + e.w && v >= e.y && v <= e.y + e.h)) return "w";
      return String(toneAt(x, y, 12));
    }).join(""),
  );
  expect(LOGO_MARK).toEqual(grid);
});

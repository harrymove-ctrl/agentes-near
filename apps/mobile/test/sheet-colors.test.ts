import { describe, expect, test } from "bun:test";
import { contrastRatio } from "../src/lib/nav";
import { appColors, sheetColors } from "../src/ui/palette";

describe("a form sheet's colors", () => {
  test("dark: the sheet a step above the screen behind it, its cards one more", () => {
    const screen = appColors("dark");
    const sheet = sheetColors(screen, "dark");
    expect(sheet.grouped).toBe(screen.raised);
    expect(sheet.bg).toBe(screen.raised);
    // Each step can be told apart: the sheet from the screen, a card from the sheet.
    expect(contrastRatio(sheet.grouped, screen.bg)).toBeGreaterThan(1.1);
    expect(contrastRatio(sheet.raised, sheet.grouped)).toBeGreaterThan(1.1);
    // Android's opaque round buttons don't vanish into the sheet.
    expect(sheet.glassSolid).toBe(sheet.raised);
  });

  test("light: the screen's own (the grouped gray with white cards)", () => {
    const screen = appColors("light");
    expect(sheetColors(screen, "light")).toBe(screen);
  });
});

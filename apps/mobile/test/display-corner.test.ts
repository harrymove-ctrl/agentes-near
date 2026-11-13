import { describe, expect, test } from "bun:test";
import { concentricRadius, displayCornerRadius } from "../src/ui/display-corner";

describe("display corner radius", () => {
  test("known iPhones by screen size, in either orientation", () => {
    expect(displayCornerRadius("ios", 402, 874, 34)).toBe(62);
    expect(displayCornerRadius("ios", 874, 402, 21)).toBe(62);
    expect(displayCornerRadius("ios", 393, 852, 34)).toBe(55);
    expect(displayCornerRadius("ios", 390, 844, 34)).toBe(47.33);
  });

  test("square screens (no bottom inset) have no radius", () => {
    expect(displayCornerRadius("ios", 375, 667, 0)).toBe(0);
    expect(displayCornerRadius("android", 412, 915, 0)).toBe(0);
  });

  test("unknown rounded screens get a middle radius", () => {
    expect(displayCornerRadius("ios", 500, 1000, 34)).toBe(44);
    expect(displayCornerRadius("android", 412, 915, 24)).toBe(44);
  });

  test("a floating surface stays concentric, never tighter than its own radius", () => {
    expect(concentricRadius(62, 8, 34)).toBe(54);
    expect(concentricRadius(39, 8, 34)).toBe(34);
    expect(concentricRadius(0, 8, 34)).toBe(34);
  });
});

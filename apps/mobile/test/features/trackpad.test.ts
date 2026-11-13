import { describe, expect, test } from "bun:test";
import { LESSON_SECONDS, padLesson } from "../../src/features/computer/trackpad";

describe("the trackpad's lesson", () => {
  test("one finger moves the cursor", () => {
    const start = padLesson(0.4, 400, 224);
    const later = padLesson(2, 400, 224);
    expect(start.spread).toBe(0);
    expect(later.x).toBeGreaterThan(start.x);
    expect(later.cursorX).toBeGreaterThan(start.cursorX);
  });

  test("a tap opens a ring and presses the cursor", () => {
    const tap = padLesson(3.25, 400, 224);
    expect(tap.ringT).toBeGreaterThanOrEqual(0);
    expect(tap.cursorScale).toBeLessThan(1);
    expect(padLesson(1, 400, 224).ringT).toBe(-1);
  });

  test("two fingers go up together, and the loop fades out", () => {
    const low = padLesson(6, 400, 224);
    const high = padLesson(8, 400, 224);
    expect(low.spread).toBeGreaterThan(0);
    expect(high.y).toBeLessThan(low.y);
    expect(padLesson(LESSON_SECONDS - 0.01, 400, 224).on).toBeLessThan(0.1);
  });
});

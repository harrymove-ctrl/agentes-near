import { describe, expect, test } from "bun:test";
import { readingLanding } from "@/chat/reading";

describe("long answers open at their start", () => {
  test("a short answer keeps sticking to the bottom", () => {
    expect(
      readingLanding({ scrollTop: 1000, clientHeight: 600, scrollHeight: 1900, rowTop: 1600, rowHeight: 300 }),
    ).toEqual({ top: 1300, held: false });
  });

  test("an answer taller than the list lands with its first line at the top (minus the air)", () => {
    expect(
      readingLanding({ scrollTop: 1000, clientHeight: 600, scrollHeight: 2800, rowTop: 1600, rowHeight: 1200 }),
    ).toEqual({ top: 1588, held: true });
  });

  test("never above the top", () => {
    expect(readingLanding({ scrollTop: 0, clientHeight: 600, scrollHeight: 900, rowTop: 4, rowHeight: 890 })).toEqual({
      top: 0,
      held: true,
    });
  });

  test("exactly the list's height (with the air) still fits", () => {
    expect(
      readingLanding({ scrollTop: 0, clientHeight: 600, scrollHeight: 2000, rowTop: 1412, rowHeight: 588 }),
    ).toEqual({ top: 1400, held: false });
  });
});

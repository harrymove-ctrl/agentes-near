import { describe, expect, test } from "bun:test";
import { searchCancelVisible, searchShowsResults } from "../src/ui/searchMode";

describe("search field modes", () => {
  test("results show only while focused or with words", () => {
    expect(searchShowsResults({ focused: false, value: "" })).toBe(false);
    expect(searchShowsResults({ focused: false, value: "   " })).toBe(false);
    expect(searchShowsResults({ focused: true, value: "" })).toBe(true);
    expect(searchShowsResults({ focused: false, value: "ana" })).toBe(true);
  });

  test("cancel shows while focused or with words, unless forced", () => {
    expect(searchCancelVisible({ focused: false, value: "" })).toBe(false);
    expect(searchCancelVisible({ focused: true, value: "" })).toBe(true);
    expect(searchCancelVisible({ focused: false, value: "a" })).toBe(true);
    expect(searchCancelVisible({ focused: true, value: "a", showCancel: false })).toBe(false);
    expect(searchCancelVisible({ focused: false, value: "", showCancel: true })).toBe(true);
  });
});

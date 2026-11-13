import { describe, expect, test } from "bun:test";
import { dragTarget, footprint, moveIndex, orderWidgets } from "../../src/features/dashboards/organize-logic";

describe("Organize on the phone (ADR 0135)", () => {
  test("a held row lands where the finger took it, one row per step, never off the list", () => {
    // Rows 110 tall with a gap of 10: a step of 120.
    expect(dragTarget(1, 0, 120, 4)).toBe(1);
    expect(dragTarget(1, 50, 120, 4)).toBe(1);
    expect(dragTarget(1, 70, 120, 4)).toBe(2);
    expect(dragTarget(1, -70, 120, 4)).toBe(0);
    expect(dragTarget(1, 900, 120, 4)).toBe(3);
    expect(dragTarget(2, -900, 120, 4)).toBe(0);
    expect(dragTarget(0, 50, 0, 4)).toBe(0);
    expect(dragTarget(0, 50, 120, 0)).toBe(0);
  });

  test("a move takes one id out and puts it back at its new place", () => {
    expect(moveIndex(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveIndex(["a", "b", "c", "d"], 3, 1)).toEqual(["a", "d", "b", "c"]);
    expect(moveIndex(["a", "b"], 1, 1)).toEqual(["a", "b"]);
    expect(moveIndex(["a", "b"], 0, 5)).toEqual(["a", "b"]);
  });

  test("the widgets take the dropped order; Home's fixed tiles keep their places", () => {
    const items = [
      { id: "waiting", type: "tile" as const },
      { id: "sales", type: "widget" as const },
      { id: "orders", type: "widget" as const },
      { id: "working", type: "tile" as const },
      { id: "builds", type: "widget" as const },
    ];
    expect(orderWidgets(items, ["builds", "sales", "orders"]).map((x) => x.id)).toEqual([
      "waiting",
      "builds",
      "sales",
      "working",
      "orders",
    ]);
    // A widget the order doesn't name keeps its turn after the others; an unknown id is skipped.
    expect(orderWidgets(items, ["orders", "nope"]).map((x) => x.id)).toEqual([
      "waiting",
      "orders",
      "sales",
      "working",
      "builds",
    ]);
  });

  test("a size is drawn as the room it takes on the phone's two columns", () => {
    expect(footprint("s")).toEqual({ cols: 1, rows: 1 });
    expect(footprint("m")).toEqual({ cols: 2, rows: 1 });
    expect(footprint("l")).toEqual({ cols: 2, rows: 2 });
  });
});

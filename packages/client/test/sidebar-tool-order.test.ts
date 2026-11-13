import { describe, expect, test } from "bun:test";
import type { SidebarItem } from "../src/api/types";
import { knownToolOrder, moveSection, moveShownTool, placeTool, SIDEBAR_ITEMS } from "../src/lib/sidebar-items";

const order: SidebarItem[] = [...SIDEBAR_ITEMS];

describe("the tools' order", () => {
  test("a tool dropped before or after another takes that place; on itself or an unknown one, nothing moves", () => {
    expect(placeTool(order, "drive", "threads", "before").slice(0, 3)).toEqual(["approvals", "proposals", "drive"]);
    expect(placeTool(order, "approvals", "issues", "after").slice(0, 4)).toEqual([
      "proposals",
      "threads",
      "issues",
      "approvals",
    ]);
    expect(placeTool(order, "drive", "drive", "after")).toEqual(order);
    expect(placeTool(order, "drive", "nope" as SidebarItem, "after")).toEqual(order);
    expect(new Set(placeTool(order, "calendar", "approvals", "before")).size).toBe(order.length);
  });

  test("up and down step past the next tool shown in the list, over the ones in More between them", () => {
    const shown: SidebarItem[] = ["threads", "issues", "drive"];
    // Wiki sits in More between Issues and Drive: Drive up lands before Issues, in one step.
    const up = moveShownTool(order, shown, "drive", -1);
    expect(up.filter((x) => shown.includes(x))).toEqual(["threads", "drive", "issues"]);
    const down = moveShownTool(order, shown, "threads", 1);
    expect(down.filter((x) => shown.includes(x))).toEqual(["issues", "threads", "drive"]);
    expect(moveShownTool(order, shown, "threads", -1)).toEqual(order);
    expect(moveShownTool(order, shown, "drive", 1)).toEqual(order);
  });

  test("a tool this build has no page for (newer, or removed) is dropped, one the saved order lacks comes last", () => {
    const saved = ["drive", "from_a_newer_server", "forum", "threads"] as SidebarItem[];
    const known = knownToolOrder(saved);
    expect(known.slice(0, 2)).toEqual(["drive", "threads"]);
    expect([...known].sort()).toEqual([...SIDEBAR_ITEMS].sort());
    expect(knownToolOrder([])).toEqual(order);
  });

  test("the setup dialog moves a tool one place in the whole order", () => {
    expect(moveSection(order, "issues", -1).slice(0, 4)).toEqual(["approvals", "proposals", "issues", "threads"]);
    expect(moveSection(order, "taskManager", 1)).toEqual(order);
  });
});

import { describe, expect, test } from "bun:test";
import {
  inSidebarList,
  knownToolOrder,
  PERSONAL_SIDEBAR_ITEMS,
  PERSONAL_SIDEBAR_SECTIONS,
  SIDEBAR_ITEMS,
  SIDEBAR_SECTIONS,
  sidebarDefaults,
  sidebarItemOrder,
  sidebarPlace,
  sidebarSections,
  withSidebarPlace,
} from "../src/lib/sidebar-items";

/** What a person who never moved anything sees in the list, by mode (nothing waiting). */
const inSight = (personal: boolean) =>
  sidebarItemOrder(personal).filter((id) => inSidebarList(sidebarPlace({}, id, personal), 0));

describe("the sidebar's defaults by the workspace's mode (ADR 0159)", () => {
  test("a team's stay as they were: the default when no mode is given", () => {
    expect(sidebarSections()).toEqual(SIDEBAR_SECTIONS);
    expect(sidebarItemOrder()).toEqual(SIDEBAR_ITEMS);
    expect(inSight(false)).toEqual(["threads", "issues", "drive", "team"]);
    expect(sidebarPlace(undefined, "issues")).toBe("always");
  });

  test("personal: every tool in More, Approvals in sight while something waits", () => {
    expect(inSight(true)).toEqual([]);
    expect(sidebarDefaults(true).approvals).toBe("auto");
    expect(inSidebarList(sidebarPlace({}, "approvals", true), 2)).toBe(true);
    for (const id of [
      "routines",
      "drive",
      "calendar",
      "issues",
      "threads",
      "team",
      "wiki",
      "dashboards",
      "taskManager",
    ] as const)
      expect(sidebarPlace({}, id, true)).toBe("more");
  });

  test("personal: the agents before the group conversations, every section and tool once", () => {
    expect(sidebarSections(true)).toEqual(["tools", "agents", "channels", "people"]);
    expect([...PERSONAL_SIDEBAR_SECTIONS].sort()).toEqual([...SIDEBAR_SECTIONS].sort());
    expect([...PERSONAL_SIDEBAR_ITEMS].sort()).toEqual([...SIDEBAR_ITEMS].sort());
    expect(sidebarItemOrder(true).indexOf("routines")).toBeLessThan(sidebarItemOrder(true).indexOf("drive"));
  });

  test("the person's own choice wins in both modes", () => {
    expect(sidebarPlace({ issues: "always" }, "issues", true)).toBe("always");
    expect(sidebarPlace({ drive: "always" }, "drive", true)).toBe("always");
    expect(sidebarPlace({ team: "more" }, "team")).toBe("more");
  });

  test("a tool put back where the mode has it is no choice: dropped, so it follows the mode from then on", () => {
    expect(withSidebarPlace({ issues: "always" }, "issues", "more", true)).toEqual({});
    expect(withSidebarPlace({}, "issues", "always", true)).toEqual({ issues: "always" });
    // The same place is a team's default: there it would be dropped.
    expect(withSidebarPlace({}, "issues", "always")).toEqual({});
    expect(withSidebarPlace({}, "routines", "more", true)).toEqual({});
    expect(withSidebarPlace({}, "routines", "always", true)).toEqual({ routines: "always" });
  });

  test("a saved order keeps its tools; the ones it lacks follow in the mode's order", () => {
    expect(knownToolOrder([], true)).toEqual([...PERSONAL_SIDEBAR_ITEMS]);
    expect(knownToolOrder([])).toEqual([...SIDEBAR_ITEMS]);
    expect(knownToolOrder(["wiki"], true).slice(0, 3)).toEqual(["wiki", "approvals", "proposals"]);
  });
});

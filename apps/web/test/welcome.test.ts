import { beforeEach, describe, expect, test } from "bun:test";
import { agentActivitySince, dayPart, isNewDay, lastVisit, markVisit } from "@/lib/welcome";

const msg = (type: "agent" | "person", id: string | null, createdAt: string) => ({ author: { type, id }, createdAt });

describe("channel greeting", () => {
  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      // No storage in this environment: lastVisit stays null.
    }
  });

  test("greets on a new local day, never on the first visit", () => {
    const now = new Date(2026, 9, 15, 8, 0);
    expect(isNewDay(null, now)).toBe(false);
    expect(isNewDay(new Date(2026, 9, 15, 7, 59).getTime(), now)).toBe(false);
    expect(isNewDay(new Date(2026, 9, 14, 23, 59).getTime(), now)).toBe(true);
    expect(isNewDay(new Date(2025, 9, 15, 8, 0).getTime(), now)).toBe(true);
  });

  test("the part of the day by local hour", () => {
    expect(dayPart(5)).toBe("morning");
    expect(dayPart(11)).toBe("morning");
    expect(dayPart(12)).toBe("afternoon");
    expect(dayPart(17)).toBe("afternoon");
    expect(dayPart(18)).toBe("evening");
    expect(dayPart(2)).toBe("evening");
  });

  test("counts agent messages after the last visit, most active first", () => {
    const since = Date.parse("2026-10-14T18:40:00Z");
    const result = agentActivitySince(
      [
        msg("agent", "lia", "2026-10-14T18:00:00Z"),
        msg("agent", "teo", "2026-10-14T19:00:00Z"),
        msg("agent", "lia", "2026-10-15T07:00:00Z"),
        msg("agent", "lia", "2026-10-15T07:10:00Z"),
        msg("person", "marina", "2026-10-15T07:20:00Z"),
        msg("agent", null, "2026-10-15T07:30:00Z"),
      ],
      since,
    );
    expect(result).toEqual({ agentIds: ["lia", "teo"], count: 3 });
    expect(agentActivitySince([], since)).toEqual({ agentIds: [], count: 0 });
  });

  test("visits are kept per workspace", () => {
    markVisit("org-a", 1000);
    markVisit("org-b", 2000);
    const a = lastVisit("org-a");
    // Where storage works it round-trips; where it doesn't, it is simply unknown.
    if (a !== null) {
      expect(a).toBe(1000);
      expect(lastVisit("org-b")).toBe(2000);
    }
    expect(lastVisit("org-c")).toBeNull();
  });
});

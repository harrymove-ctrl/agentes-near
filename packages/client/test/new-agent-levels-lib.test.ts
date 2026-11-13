import { describe, expect, test } from "bun:test";
import { NEW_AGENT_STEPS, PERSONAL_SKIPPED_STEPS, presetLevels, starterApps, stepAfter } from "../src/lib/new-agent";

describe("presetLevels", () => {
  const items = [
    { id: "cal", def: { id: "google-calendar" } },
    { id: "mine", def: null },
  ];

  test("a team's agent starts with the catalog's apps at write and a custom server at none", () => {
    expect(presetLevels("custom", items)).toEqual({ cal: "write", mine: "none" });
  });

  test("a personal workspace's agent starts with every app at write, custom servers too (ADR 0159)", () => {
    expect(presetLevels("custom", items, true)).toEqual({ cal: "write", mine: "write" });
  });
});

describe("stepAfter", () => {
  const at = (s: (typeof NEW_AGENT_STEPS)[number]) => NEW_AGENT_STEPS.indexOf(s);

  test("a team's form walks every step", () => {
    expect(stepAfter(at("instructions"), 1, [])).toBe(at("tools"));
    expect(stepAfter(at("review"), -1, [])).toBe(at("model"));
  });

  test("a personal workspace's form passes over the technical steps, both ways, never past the ends", () => {
    expect(stepAfter(at("instructions"), 1, PERSONAL_SKIPPED_STEPS)).toBe(at("review"));
    expect(stepAfter(at("review"), -1, PERSONAL_SKIPPED_STEPS)).toBe(at("instructions"));
    // Opened from Revisar, a skipped step goes on to Revisar.
    expect(stepAfter(at("tools"), 1, PERSONAL_SKIPPED_STEPS)).toBe(at("review"));
    expect(stepAfter(at("role"), -1, PERSONAL_SKIPPED_STEPS)).toBe(at("role"));
    expect(stepAfter(at("review"), 1, PERSONAL_SKIPPED_STEPS)).toBe(at("review"));
  });
});

describe("starterApps (ADR 0164)", () => {
  test("a personal starter's apps at write, a team role's at its preset levels, none from scratch", () => {
    expect(starterApps({ starter: "vic" })).toEqual({ "google-calendar": "write", drive: "write" });
    expect(starterApps({ role: "dev" })).toEqual({ github: "write", sentry: "read", linear: "read" });
    expect(starterApps({ role: "custom" })).toEqual({});
    expect(starterApps({})).toEqual({});
  });
});

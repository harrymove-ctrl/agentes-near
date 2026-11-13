import { describe, expect, test } from "bun:test";
import { targetKind, teamChecksOf } from "../src/lib/team-checks";

describe("team checks (ADR 0064)", () => {
  test("a message carries them in meta.teamChecks, or none", () => {
    const check = { id: "c1", tool: "open_pull_request", targets: ["acme/app@fix/login"], matches: [] };
    expect(teamChecksOf({ teamChecks: [check] })).toEqual([check]);
    expect(teamChecksOf({ teamChecks: "x" })).toEqual([]);
    expect(teamChecksOf(undefined)).toEqual([]);
  });

  test("what a target is, for its icon", () => {
    expect(targetKind("ana@acme.com")).toBe("email");
    expect(targetKind("+551140028922")).toBe("phone");
    expect(targetKind("acme/app#212")).toBe("code");
    expect(targetKind("acme/app@fix/login")).toBe("code");
    expect(targetKind("hooks.acme.com/deal")).toBe("url");
    expect(targetKind("fix/login")).toBe("other");
  });
});

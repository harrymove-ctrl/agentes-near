import { expect, test } from "bun:test";
import type { BrowserProfile } from "../src";
import { browserTrailOf, profilesOfAgent, profileUser, runProfile, trailProfile } from "../src";

const profile = (over: Partial<BrowserProfile>): BrowserProfile => ({
  id: "p1",
  machineId: "m1",
  name: "Empresa B · WhatsApp vendas",
  createdAt: "2026-11-01T12:00:00.000Z",
  agentIds: ["ada"],
  holder: null,
  lastUsedAt: null,
  ...over,
});

test("a run is in its latest switch's profile, else the agent's default; own is its own browser", () => {
  const list = [profile({}), profile({ id: "p2", name: "Empresa A" })];
  expect(runProfile([], null, list)).toBeNull();
  expect(runProfile([], "p2", list)?.name).toBe("Empresa A");
  const steps = [
    { tool: "browser_profile", detail: "empresa b · whatsapp vendas" },
    { tool: "browser_open", detail: "web.whatsapp.com" },
  ];
  expect(runProfile(steps, "p2", list)?.id).toBe("p1");
  expect(runProfile([...steps, { tool: "browser_profile", detail: "own" }], "p2", list)).toBeNull();
});

test("the chip reads the profile the trail ended in, by its name then", () => {
  const steps = browserTrailOf({
    browser: {
      steps: [
        { tool: "browser_open", detail: "web.whatsapp.com", at: "2026-11-01T12:00:00.000Z", profileName: "Empresa B" },
        { tool: "browser_read", at: "2026-11-01T12:00:05.000Z" },
      ],
    },
  });
  expect(steps.map((s) => s.profileName ?? null)).toEqual(["Empresa B", null]);
  expect(trailProfile(steps)).toBeNull();
  expect(trailProfile(steps.slice(0, 1))).toBe("Empresa B");
});

test("who may use a profile, and who uses it now", () => {
  const p = profile({ holder: { type: "agent", agentId: "ada", since: "2026-11-01T12:00:00.000Z" } });
  expect(profilesOfAgent([p], "ada")).toEqual([p]);
  expect(profilesOfAgent([p], "atlas")).toEqual([]);
  expect(profileUser(p)).toEqual({ agentId: "ada" });
  expect(profileUser(profile({}))).toBeNull();
});

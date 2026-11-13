import { afterEach, beforeEach, expect, test } from "bun:test";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({
    env: { ALLOW_SIGNUP: "true" },
    reply: () => ({ chunks: ["done"], usage: { inputTokens: 100, outputTokens: 10 } }),
  });
});
afterEach(() => t.close());

/** Owner with @dev (US$ 50) and a member who joined by invitation. */
async function workspace() {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const seeded = await seedOrg(owner);
  const member = browser(t);
  await signUp(member, "ana@example.com");
  const { url } = (await (
    await owner(`/api/app/organizations/${seeded.orgId}/invitations`, {
      json: { email: "ana@example.com", role: "member" },
    })
  ).json()) as { url: string };
  await member(`/api/app/invitations/${url.split("/invite/")[1]}/accept`, { json: {} });
  const api = (b: typeof owner) => (path: string, init?: Parameters<typeof owner>[1]) =>
    b(`/api/app/organizations/${seeded.orgId}${path}`, init);
  return { ...seeded, owner: api(owner), member: api(member) };
}

// "costly" is the agent brake for paid actions (ask, go or never), not an amount.
const money = /usd|cost(?!ly)/i;

test("members never receive money: only percentages and tokens", async () => {
  const w = await workspace();
  await w.owner(`/channels/${w.channelId}/messages`, { json: { body: "@dev status?" } });
  await t.drain();

  for (const path of [
    "/overview",
    "/agents",
    `/agents/${w.agentId}`,
    "/settings",
    `/channels/${w.channelId}/messages`,
    "/routines",
    // The usage views: everyone, without money (ADR 0063).
    "/usage/plans",
    `/agents/${w.agentId}/usage`,
  ]) {
    const res = await w.member(path);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toMatch(money);
  }
  type Plans = { money: boolean; api: { agentId: string; tokens: number; budgetPercent: number; costUsd?: number }[] };
  const plans = (await (await w.member("/usage/plans")).json()) as Plans;
  expect(plans.money).toBe(false);
  expect(plans.api[0]?.agentId).toBe(w.agentId);
  expect(plans.api[0]?.tokens).toBeGreaterThan(0);
  const admins = (await (await w.owner("/usage/plans")).json()) as Plans;
  expect(admins.money).toBe(true);
  expect(admins.api[0]?.costUsd).toBeGreaterThan(0);
  const dev = (await (await w.member(`/agents/${w.agentId}/usage`)).json()) as { sources: { type: string }[] };
  expect(dev.sources.map((s) => s.type)).toEqual(["api"]);
  const overview = (await (await w.member("/overview")).json()) as { budgetUsedPercent: number };
  expect(typeof overview.budgetUsedPercent).toBe("number");
  const detail = (await (await w.member(`/agents/${w.agentId}`)).json()) as Record<string, unknown>;
  expect(detail.budgetUsedPercent).toBe(0);
  expect(detail).not.toHaveProperty("monthlyBudgetUsd");
  const agents = (await (await w.member("/agents")).json()) as { agents: Record<string, unknown>[] };
  expect(agents.agents.find((a) => a.handle === "dev")).toMatchObject({ budgetUsedPercent: 0 });
  for (const a of agents.agents) expect(a).not.toHaveProperty("monthlyBudgetUsd");

  // The money screens stay closed.
  expect((await w.member("/usage/report")).status).toBe(403);
  expect((await w.member("/usage")).status).toBe(403);
});

test("admins see and set the budgets: the workspace default and each agent's", async () => {
  const w = await workspace();
  const settings = (await (await w.owner("/settings")).json()) as { defaultAgentBudgetUsd: number };
  expect(settings.defaultAgentBudgetUsd).toBe(50);
  const patched = await w.owner("/settings", { method: "PATCH", json: { defaultAgentBudgetUsd: 20 } });
  expect(await patched.json()).toMatchObject({ defaultAgentBudgetUsd: 20 });
  expect((await w.owner("/settings", { method: "PATCH", json: { defaultAgentBudgetUsd: 0 } })).status).toBe(400);
  expect((await w.member("/settings", { method: "PATCH", json: { defaultAgentBudgetUsd: 1 } })).status).toBe(403);

  // An agent created without a budget follows the default; the admin can give it its own.
  const ops = (await (await w.owner("/agents", { json: { name: "Ops", handle: "ops" } })).json()) as {
    id: string;
    monthlyBudgetUsd: number | null;
  };
  expect(ops.monthlyBudgetUsd).toBeNull();
  expect(await (await w.owner(`/agents/${ops.id}`)).json()).toMatchObject({
    monthlyBudgetUsd: null,
    defaultBudgetUsd: 20,
    budgetUsedPercent: 0,
  });
  const own = await w.owner(`/agents/${ops.id}`, { method: "PATCH", json: { monthlyBudgetUsd: 80 } });
  expect(await own.json()).toMatchObject({ monthlyBudgetUsd: 80 });
  const detail = (await (await w.owner(`/agents/${ops.id}`)).json()) as Record<string, unknown>;
  expect(detail.monthlyBudgetUsd).toBe(80);
  expect(detail).not.toHaveProperty("defaultBudgetUsd");
});

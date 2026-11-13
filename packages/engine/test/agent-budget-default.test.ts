import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { costNanoUsd } from "@agenteschat/providers";
import {
  agentBudgetState,
  agentBudgetsThisMonth,
  agentDetail,
  BudgetExceededError,
  budgetPercent,
  canViewCost,
  createAgent,
  DEFAULT_AGENT_BUDGET_NANO_USD,
  getOrgSettings,
  orgOverview,
  updateAgent,
  updateOrgSettings,
  usageReport,
  workspaceBudgetPercent,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

const usage = { inputTokens: 1000, outputTokens: 100 };
const call = (fx: Fixture, agentId = fx.agent.id) =>
  fx.gateway.stream({
    orgId: fx.org.id,
    agentId,
    system: "sys",
    messages: [{ role: "user", content: "hello" }],
    maxTokens: 300,
    onDelta: () => {},
  });

test("an agent without its own budget runs on the workspace default", async () => {
  f = await setup({ reply: () => ({ chunks: ["ok"], usage }) });
  expect(f.agent.monthlyBudgetNanoUsd).toBeNull();
  expect((await getOrgSettings(f.db, f.owner.id, f.org.id)).defaultAgentBudgetNanoUsd).toBe(
    DEFAULT_AGENT_BUDGET_NANO_USD,
  );
  await call(f);
  // The call reserved against the default: the month's counter exists and holds the spend.
  const [period] = await f.db
    .select()
    .from(schema.agentBudgetPeriods)
    .where(eq(schema.agentBudgetPeriods.agentId, f.agent.id));
  expect(period?.spentNanoUsd).toBe(
    costNanoUsd("claude-sonnet-5-5", { ...usage, cacheReadTokens: 0, cacheWriteTokens: 0 }),
  );

  // The admin lowers the default below what was spent: the next call never reaches the provider.
  await updateOrgSettings(f.db, f.owner.id, f.org.id, { defaultAgentBudgetNanoUsd: 1 });
  const before = f.provider.calls.length;
  await expect(call(f)).rejects.toBeInstanceOf(BudgetExceededError);
  expect(f.provider.calls.length).toBe(before);

  // Its own budget wins over the default.
  await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { monthlyBudgetNanoUsd: 10_000_000_000 });
  await call(f);
});

test("the default budget must be above zero and only admins change it", async () => {
  f = await setup();
  await expect(updateOrgSettings(f.db, f.owner.id, f.org.id, { defaultAgentBudgetNanoUsd: 0 })).rejects.toThrow();
  const member = await addMember(f.db, f.org.id, "member");
  await expect(
    updateOrgSettings(f.db, member.id, f.org.id, { defaultAgentBudgetNanoUsd: 5_000_000_000 }),
  ).rejects.toThrow();
  await updateOrgSettings(f.db, f.owner.id, f.org.id, { defaultAgentBudgetNanoUsd: 5_000_000_000 });
  expect((await getOrgSettings(f.db, f.owner.id, f.org.id)).defaultAgentBudgetNanoUsd).toBe(5_000_000_000);
});

test("the workspace's 100% is the sum of every agent's budget (own or default)", async () => {
  f = await setup({ reply: () => ({ chunks: ["ok"], usage }) });
  await updateOrgSettings(f.db, f.owner.id, f.org.id, { defaultAgentBudgetNanoUsd: 2_000_000 });
  const ops = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Ops", handle: "ops", credentialId: f.credential.id, monthlyBudgetNanoUsd: 6_000_000 },
    { model: "claude-sonnet-5-5" },
  );
  // Archived agents don't count.
  const old = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Old", handle: "old", credentialId: f.credential.id, monthlyBudgetNanoUsd: 1_000_000_000 },
    { model: "claude-sonnet-5-5" },
  );
  await f.db.update(schema.agents).set({ archivedAt: new Date() }).where(eq(schema.agents.id, old.id));

  await call(f, ops.id);
  const spent = 1000 * 2000 + 100 * 10000;
  // dev: default 2_000_000; ops: 6_000_000 → 3_000_000 of 8_000_000.
  expect(await workspaceBudgetPercent(f.db, f.org.id)).toBe(budgetPercent(spent, 8_000_000));
  expect(await workspaceBudgetPercent(f.db, f.org.id)).toBe(37.5);
  const overview = await orgOverview(f.db, f.owner.id, f.org.id);
  expect(overview.budgetUsedPercent).toBe(37.5);

  const detail = await agentDetail(f.db, f.owner.id, f.org.id, ops.id);
  expect(detail.month).toMatchObject({ budgetNanoUsd: 6_000_000, budgetUsedPercent: 50 });

  const report = await usageReport(f.db, f.owner.id, f.org.id);
  expect(report.defaultAgentBudgetNanoUsd).toBe(2_000_000);
  expect(report.agents.find((a) => a.handle === "dev")).toMatchObject({
    monthlyBudgetNanoUsd: 2_000_000,
    budgetIsDefault: true,
    budgetUsedPercent: 0,
  });
  expect(report.agents.find((a) => a.handle === "ops")).toMatchObject({
    monthlyBudgetNanoUsd: 6_000_000,
    budgetIsDefault: false,
    budgetUsedPercent: 50,
  });
});

test("what its budget doesn't pay (Jev's judgments, the router) leaves an agent's budget, the workspace's and the gateway's counter at 0%", async () => {
  const fx = await setup({ reply: () => ({ chunks: ["ok"], usage }), budgetNanoUsd: 10_000_000 });
  f = fx;
  // A plan agent's status line asks Jev (the platform's key); the router decides on the workspace's key.
  await fx.gateway.recordExternalUsage({
    orgId: fx.org.id,
    agentId: fx.agent.id,
    kind: "router",
    provider: "typesafe",
    model: "jev-latest",
    inputTokens: 1500,
    outputTokens: 1,
    costNanoUsd: 1_000_000,
  });
  await fx.gateway.complete({
    orgId: fx.org.id,
    agentId: fx.agent.id,
    kind: "router",
    model: "claude-haiku-5-5",
    system: "route",
    messages: [{ role: "user", content: "hi" }],
    maxTokens: 100,
  });
  const used = async () => ({
    workspace: await workspaceBudgetPercent(fx.db, fx.org.id),
    list: (await agentBudgetsThisMonth(fx.db, fx.org.id)).get(fx.agent.id)?.spentNanoUsd,
    page: (await agentDetail(fx.db, fx.owner.id, fx.org.id, fx.agent.id)).month.budgetUsedPercent,
  });
  expect(await used()).toEqual({ workspace: 0, list: 0, page: 0 });

  // Its own call is what its budget pays. With no counter yet, as on a month's first call, the gateway starts it
  // from the month's usage: from that call alone.
  await fx.db.delete(schema.agentBudgetPeriods).where(eq(schema.agentBudgetPeriods.agentId, fx.agent.id));
  await call(fx);
  const spent = costNanoUsd("claude-sonnet-5-5", { ...usage, cacheReadTokens: 0, cacheWriteTokens: 0 });
  expect(budgetPercent(spent, 10_000_000)).toBe(30);
  expect(await used()).toEqual({ workspace: 30, list: spent, page: 30 });
  expect((await agentBudgetState(fx.db, fx.org.id, fx.agent.id)).spentNanoUsd).toBe(spent);
  // A budget changed recounts the month the same way.
  await updateAgent(fx.db, fx.owner.id, fx.org.id, fx.agent.id, { monthlyBudgetNanoUsd: 20_000_000 });
  expect((await agentBudgetState(fx.db, fx.org.id, fx.agent.id)).spentNanoUsd).toBe(spent);
});

test("budgetPercent rounds to one decimal and never divides by zero", () => {
  expect(budgetPercent(1, 3)).toBe(33.3);
  expect(budgetPercent(0, 0)).toBe(0);
  expect(budgetPercent(5, 0)).toBe(100);
  expect(budgetPercent(12, 10)).toBe(120);
});

test("only admins and owners see money", async () => {
  f = await setup();
  const admin = await addMember(f.db, f.org.id, "admin", "bia");
  const member = await addMember(f.db, f.org.id, "member", "caio");
  expect(await canViewCost(f.db, f.owner.id, f.org.id)).toBe(true);
  expect(await canViewCost(f.db, admin.id, f.org.id)).toBe(true);
  expect(await canViewCost(f.db, member.id, f.org.id)).toBe(false);
  expect(await canViewCost(f.db, "someone-else", f.org.id)).toBe(false);
});

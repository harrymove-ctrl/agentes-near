import { afterEach, expect, test } from "bun:test";
import type { PlanUsage } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  agentPlanUsage,
  createAgent,
  createAgentRuns,
  createUsageToolSource,
  insertMessage,
  recordPlanUsage,
  type ToolContext,
  USAGE_TOOL,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

/**
 * `get_my_usage`: an agent's own numbers as its Uso tab shows them (ADR 0063 §6): the plan it thinks with, its part
 * of each window, its tokens and its API budget use, and never money, not even when an admin asks.
 */

const money = /US\$ \d|would have cost/;

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const PESSOAL = "0193eeee-0000-4000-8000-0000000000a1";
const hours = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();
const usage = (windows: PlanUsage["windows"]): PlanUsage => ({ windows, source: "turn", at: new Date().toISOString() });

/** A run of `agentId` answering `userId`; `routine`: a routine's background run, nobody behind it. */
async function runFor(agentId: string, userId: string, routine = false): Promise<ToolContext> {
  const message = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "person", userId },
    body: "como está seu limite de uso?",
  });
  const [run] = await f.db.transaction((tx) =>
    createAgentRuns(tx, message, [agentId], "mention", routine ? { background: true } : {}),
  );
  if (!run) throw new Error("no run");
  return {
    db: f.db,
    orgId: f.org.id,
    agentId,
    runId: run.id,
    channelId: f.general.id,
    threadRootId: run.threadRootId,
    triggerMessageId: run.triggerMessageId,
  };
}

/** What the agent reads back, through the gateway like any call (scope, run policy, schema). */
async function check(ctx: ToolContext) {
  const result = await f.tools?.invoke(ctx, { toolUseId: "u1", name: USAGE_TOOL, input: {} });
  if (result?.type !== "result") throw new Error(`not a result: ${JSON.stringify(result)}`);
  expect(result.output.isError).toBeFalsy();
  return result.output.content;
}

/** Dev thinks with Ana's "Pessoal" Claude Max; Atlas used it too this month. */
async function onPlan() {
  f = await setup({ toolSources: [createUsageToolSource()] });
  const { machineId } = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
    name: "MacBook",
    exec: true,
  });
  await f.db.insert(schema.machineAccounts).values({
    id: PESSOAL,
    orgId: f.org.id,
    machineId,
    kind: "claude_code",
    label: "Pessoal",
    email: "ana@example.com",
    plan: "max",
    status: "active",
    createdBy: f.owner.id,
    usage: usage([
      { kind: "seven_day", usedPercent: 30, resetsAt: hours(72) },
      { kind: "five_hour", usedPercent: 60, resetsAt: hours(2) },
    ]),
  });
  const atlas = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Atlas", handle: "atlas", role: "Ops", instructions: "Run ops.", credentialId: f.agent.credentialId },
    { model: "claude-sonnet-5-5" },
  );
  await f.db
    .update(schema.agents)
    .set({ brain: "claude_code", machineId, brainAccountId: PESSOAL })
    .where(eq(schema.agents.id, f.agent.id));
  for (const [agentId, model] of [
    [f.agent.id, "claude-opus-5-5"],
    [atlas.id, "claude-haiku-5-5"],
  ] as const) {
    const ctx = await runFor(agentId, f.owner.id);
    await recordPlanUsage(f.db, {
      orgId: f.org.id,
      agentId,
      runId: ctx.runId,
      provider: "claude_code",
      machineId,
      accountId: PESSOAL,
      model,
      inputTokens: 20_000,
      outputTokens: 2_000,
    });
  }
  return { atlas };
}

test("on a plan: its windows tightest first with its own part and renewal, its tokens; no money for an admin", async () => {
  await onPlan();
  const view = await agentPlanUsage(f.db, f.owner.id, f.org.id, f.agent.id);
  const part = (kind: string) =>
    view.current?.usage?.windows.find((w) => w.kind === kind)?.agents?.find((a) => a.agentId === f.agent.id)?.percent;
  // Opus weighs more against the plan than Atlas's Haiku: most of each window, never all of it.
  expect(part("five_hour")).toBeGreaterThan(30);
  expect(part("five_hour")).toBeLessThan(60);

  const text = await check(await runFor(f.agent.id, f.owner.id));
  expect(text).toContain(`You think with Claude plan "Pessoal" (Max), ana's.`);
  expect(text).toMatch(
    new RegExp(`- 5 hours: 60% used, resets [^\\n]+\\. Your part: about ${part("five_hour")}%\\.\\n- Week: 30% used`),
  );
  expect(text).toContain(`Week: 30% used, resets `);
  expect(text).toContain(`Your part: about ${part("seven_day")}%.`);
  expect(text).toContain("Tokens this month (UTC): 22,000 (all on plans).");
  // The result stays in the run, which the agent's owner reads without `view_usage`.
  expect(text).not.toMatch(money);
  // On a plan with no API use this month: no budget line.
  expect(text).not.toContain("API budget");
  // Never another agent's numbers, nor the account's email.
  expect(text).not.toMatch(/Atlas|ana@example\.com/);
});

test("on a plan: a member and a routine's run see the same limits and tokens, never money", async () => {
  await onPlan();
  const bia = await addMember(f.db, f.org.id, "member", "Bia");
  const member = await check(await runFor(f.agent.id, bia.id));
  expect(member).toContain("- 5 hours: 60% used, resets ");
  expect(member).toContain("Tokens this month (UTC): 22,000 (all on plans).");
  expect(member).not.toMatch(money);

  // A routine's run reads too (it only looks), with nobody behind it.
  const routine = await check(await runFor(f.agent.id, f.owner.id, true));
  expect(routine).toContain("- 5 hours: 60% used, resets ");
  expect(routine).not.toMatch(money);
});

test("at the limit: the plan says until when; unknown windows say so instead of 0%", async () => {
  await onPlan();
  const until = hours(1);
  await f.db
    .update(schema.machineAccounts)
    .set({ usage: usage([{ kind: "five_hour", usedPercent: 100, resetsAt: until }]) })
    .where(eq(schema.machineAccounts.id, PESSOAL));
  const limited = await check(await runFor(f.agent.id, f.owner.id));
  expect(limited).toContain("- 5 hours: 100% used, resets ");
  expect(limited).toMatch(/\nAt the limit until [^\n]+\./);

  await f.db.update(schema.machineAccounts).set({ usage: null }).where(eq(schema.machineAccounts.id, PESSOAL));
  const unknown = await check(await runFor(f.agent.id, f.owner.id));
  expect(unknown).toContain("Its limits aren't known yet");
  expect(unknown).not.toContain("0% used");
});

test("on the API: how much of its budget it used, for an admin and a member alike; another agent's spend stays out", async () => {
  f = await setup({ toolSources: [createUsageToolSource()] });
  const atlas = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Atlas", handle: "atlas", role: "Ops", instructions: "Run ops.", credentialId: f.agent.credentialId },
    { model: "claude-sonnet-5-5" },
  );
  const spend = (agentId: string, costNanoUsd: number, inputTokens: number) =>
    f.db.insert(schema.usageRecords).values({
      orgId: f.org.id,
      agentId,
      kind: "agent",
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      requestedModel: "claude-sonnet-5-5",
      inputTokens,
      outputTokens: 0,
      costNanoUsd,
    });
  await spend(f.agent.id, 2_000_000_000, 1_000);
  await spend(atlas.id, 10_000_000_000, 9_000);

  const admin = await check(await runFor(f.agent.id, f.owner.id));
  expect(admin).toContain("You think through the API");
  expect(admin).toContain("API budget this month: 4% used. It resets ");
  expect(admin).toContain("Tokens this month (UTC): 1,000 (all through the API).");
  expect(admin).not.toMatch(/Atlas|9,000/);
  expect(admin).not.toMatch(money);

  const bia = await addMember(f.db, f.org.id, "member", "Bia");
  const member = await check(await runFor(f.agent.id, bia.id));
  expect(member).toContain("API budget this month: 4% used. It resets ");
  expect(member).not.toMatch(money);
});

test("every agent has it, with no grant: before any tool group is loaded, find_tools gives it", async () => {
  f = await setup({ toolSources: [createUsageToolSource()] });
  await f.db.delete(schema.agentScopes).where(eq(schema.agentScopes.agentId, f.agent.id));
  const ctx = { ...(await runFor(f.agent.id, f.owner.id)), loadedGroups: [] };
  // A rarely used tool, loaded on demand (ADR 0043): reachable, never behind a permission.
  const listed = await f.tools?.list(ctx);
  expect(listed?.map((t) => t.name)).not.toContain(USAGE_TOOL);
  const found = await f.tools?.invoke(ctx, { toolUseId: "tu_find", name: "find_tools", input: { query: "my usage" } });
  const text = found?.type === "result" ? found.output.content : "";
  expect(text).toContain(`- ${USAGE_TOOL}:`);
  expect(text).not.toContain("request_permission");
  const routine = await f.tools?.list(await runFor(f.agent.id, f.owner.id, true));
  expect(routine?.map((t) => t.name)).toContain(USAGE_TOOL);
});

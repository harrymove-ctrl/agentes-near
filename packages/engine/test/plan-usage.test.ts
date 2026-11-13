import { afterEach, expect, test } from "bun:test";
import type { PlanUsage } from "@agenteschat/adapters";
import { eq, schema, sql } from "@agenteschat/db";
import { catalogModelOf } from "@agenteschat/providers";
import { agentPlanUsage, createAgent, orgPlanUsage, recordPlanUsage, sourceKeyOf } from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

/**
 * The usage views (ADR 0063): plan tokens say which account they spent; an
 * agent's part of a window is its API-priced share of the account's use
 * since the window started, times the account's percent. Everyone sees tokens
 * and percentages; the email only the account's owner; money only admins.
 */

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const PESSOAL = "0193eeee-0000-4000-8000-000000000001";
const hours = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();
const usage = (windows: PlanUsage["windows"]): PlanUsage => ({ windows, source: "turn", at: new Date().toISOString() });

/** Ana's MacBook with her "Pessoal" Claude account; Dev thinks with it, Atlas with the computer's own sign-in. */
async function scene() {
  f = await setup();
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
      { kind: "five_hour", usedPercent: 60, resetsAt: hours(2) },
      { kind: "seven_day", usedPercent: 30, resetsAt: hours(72) },
    ]),
  });
  const atlas = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Atlas", handle: "atlas", role: "Ops", instructions: "Run ops.", credentialId: f.agent.credentialId },
    { model: "claude-sonnet-5-5" },
  );
  const think = (agentId: string, accountId: string | null) =>
    f.db
      .update(schema.agents)
      .set({ brain: "claude_code", machineId, brainAccountId: accountId })
      .where(eq(schema.agents.id, agentId));
  await think(f.agent.id, PESSOAL);
  await think(atlas.id, null);
  const run = async (agentId: string) => {
    const [row] = await f.db
      .insert(schema.agentRuns)
      .values({
        orgId: f.org.id,
        agentId,
        channelId: f.general.id,
        threadRootId: crypto.randomUUID(),
        triggerMessageId: crypto.randomUUID(),
        trigger: "mention",
        hop: 1,
      })
      .returning({ id: schema.agentRuns.id });
    return row?.id ?? "";
  };
  const spend = async (
    agentId: string,
    accountId: string | null,
    model: string,
    inputTokens: number,
    outputTokens = 0,
  ) =>
    recordPlanUsage(f.db, {
      orgId: f.org.id,
      agentId,
      runId: await run(agentId),
      provider: "claude_code",
      machineId,
      accountId,
      model,
      inputTokens,
      outputTokens,
    });
  return { machineId, atlas, spend };
}

test("a CLI's model name is priced by its catalog id", () => {
  expect(catalogModelOf("claude-opus-5-5[1m]")).toBe("claude-opus-5-5");
  expect(catalogModelOf("claude-haiku-5-5-20261001")).toBe("claude-haiku-5-5");
  expect(catalogModelOf("MiniMax-M3")).toBe("MiniMax-M3");
  expect(catalogModelOf("claude_code")).toBeNull();
  expect(catalogModelOf(null)).toBeNull();
});

test("an account's windows split by agent and its month by agent; the email for its owner, money for admins", async () => {
  const { machineId, atlas, spend } = await scene();
  // The same tokens, but Opus weighs more against a plan than Haiku. Atlas used Pessoal before moving.
  await spend(f.agent.id, PESSOAL, "claude-opus-5-5", 20_000, 2_000);
  await spend(atlas.id, PESSOAL, "claude-haiku-5-5", 20_000, 2_000);

  const mine = await orgPlanUsage(f.db, f.owner.id, f.org.id);
  expect(mine.money).toBe(true);
  const pessoal = mine.accounts.find((a) => a.accountId === PESSOAL);
  expect(pessoal).toMatchObject({
    key: sourceKeyOf(machineId, "claude_code", PESSOAL),
    machineName: "MacBook",
    label: "Pessoal",
    plan: "max",
    ownerName: "ana",
    mine: true,
    email: "ana@example.com",
    monthTokens: 44_000,
  });
  expect(pessoal?.agents.map((a) => [a.name, a.tokens, a.now])).toEqual([
    ["Dev", 22_000, true],
    ["Atlas", 22_000, false],
  ]);
  const fiveHours = pessoal?.usage?.windows.find((w) => w.kind === "five_hour");
  const parts = new Map(fiveHours?.agents?.map((a) => [a.agentId, a.percent]));
  expect((parts.get(f.agent.id) ?? 0) + (parts.get(atlas.id) ?? 0)).toBeCloseTo(60, 0);
  expect(parts.get(f.agent.id) ?? 0).toBeGreaterThan(parts.get(atlas.id) ?? 0);
  expect(pessoal?.equivalentUsd).toBeGreaterThan(0);
  // Atlas thinks with the computer's own sign-in now: it is listed, with no windows known yet.
  const own = mine.accounts.find((a) => a.accountId === null);
  expect(own).toMatchObject({ label: null, usage: null, monthTokens: 0, ownerName: "ana", mine: true });
  expect(own?.agents.map((a) => [a.name, a.now])).toEqual([["Atlas", true]]);

  // A member: the same accounts and percentages, no email and no money anywhere.
  const bia = await addMember(f.db, f.org.id, "member", "Bia");
  const seen = await orgPlanUsage(f.db, bia.id, f.org.id);
  expect(seen.money).toBe(false);
  const theirs = seen.accounts.find((a) => a.accountId === PESSOAL);
  expect(theirs).toMatchObject({ email: null, mine: false, ownerName: "ana" });
  expect(theirs?.usage?.windows.find((w) => w.kind === "five_hour")?.usedPercent).toBe(60);
  expect(JSON.stringify(seen)).not.toMatch(/usd|cost|ana@example/i);
});

test("the agent's month: by account and day, the account it uses now, its own sign-in and the API", async () => {
  const { machineId, spend } = await scene();
  // Before Pessoal it used the computer's own sign-in, and the API once.
  await spend(f.agent.id, null, "claude-sonnet-5-5", 1_000);
  await spend(f.agent.id, PESSOAL, "claude-sonnet-5-5", 3_000);
  await f.db.insert(schema.usageRecords).values({
    orgId: f.org.id,
    agentId: f.agent.id,
    kind: "agent",
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    requestedModel: "claude-sonnet-5-5",
    inputTokens: 1_000,
    outputTokens: 0,
    costNanoUsd: 2_000_000_000,
  });

  const usage = await agentPlanUsage(f.db, f.owner.id, f.org.id, f.agent.id);
  expect(usage.tokens).toBe(5_000);
  expect(usage.sources.map((s) => [s.key, s.type, s.tokens, s.share, s.now])).toEqual([
    [sourceKeyOf(machineId, "claude_code", PESSOAL), "plan", 3_000, 60, true],
    [sourceKeyOf(machineId, "claude_code", null), "plan", 1_000, 20, false],
    ["api", "api", 1_000, 20, false],
  ]);
  expect(usage.sources[1]?.account).toMatchObject({ accountId: null, label: null, machineName: "MacBook" });
  expect(usage.sources[2]).toMatchObject({ costUsd: 2, account: null, removed: false });
  expect(usage.equivalentUsd).toBeGreaterThan(0);
  const today = new Date().toISOString().slice(0, 10);
  expect(usage.days[0]?.date.endsWith("-01")).toBe(true);
  expect(usage.days.at(-1)?.date).toBe(today);
  expect(Object.values(usage.days.at(-1)?.tokens ?? {}).reduce((a, b) => a + b, 0)).toBe(5_000);
  // Now: Pessoal with its windows; Dev is the only one that spent it in this window.
  expect(usage.current?.accountId).toBe(PESSOAL);
  expect(usage.current?.usage?.windows.map((w) => [w.kind, w.agents])).toEqual([
    ["five_hour", [{ agentId: f.agent.id, name: "Dev", percent: 60 }]],
    ["seven_day", [{ agentId: f.agent.id, name: "Dev", percent: 30 }]],
  ]);

  const bia = await addMember(f.db, f.org.id, "member", "Bia");
  const seen = await agentPlanUsage(f.db, bia.id, f.org.id, f.agent.id);
  expect(seen.sources.map((s) => s.share)).toEqual([60, 20, 20]);
  expect(JSON.stringify(seen)).not.toMatch(/usd|cost|ana@example/i);
});

test("Jev's judgments and the router's calls for an agent are no API use of its own; the router on a plan is the plan's", async () => {
  const { machineId, spend } = await scene();
  await spend(f.agent.id, PESSOAL, "claude-sonnet-5-5", 1_000);
  await recordPlanUsage(f.db, {
    orgId: f.org.id,
    agentId: f.agent.id,
    kind: "router",
    provider: "claude_code",
    machineId,
    accountId: PESSOAL,
    model: "claude-haiku-5-5",
    inputTokens: 500,
    outputTokens: 0,
  });
  // Jev on the platform's key (its status line), the router on the workspace's key.
  await f.gateway.recordExternalUsage({
    orgId: f.org.id,
    agentId: f.agent.id,
    kind: "router",
    provider: "typesafe",
    model: "jev-latest",
    inputTokens: 1_500,
    outputTokens: 1,
    costNanoUsd: 1_000_000,
  });
  await f.gateway.complete({
    orgId: f.org.id,
    agentId: f.agent.id,
    kind: "router",
    model: "claude-haiku-5-5",
    system: "route",
    messages: [{ role: "user", content: "hi" }],
    maxTokens: 100,
  });

  const org = await orgPlanUsage(f.db, f.owner.id, f.org.id);
  expect(org.api).toEqual([]);
  expect(org.accounts.find((a) => a.accountId === PESSOAL)?.monthTokens).toBe(1_500);
  const usage = await agentPlanUsage(f.db, f.owner.id, f.org.id, f.agent.id);
  expect(usage.tokens).toBe(1_500);
  expect(usage.sources.map((s) => [s.key, s.type, s.tokens])).toEqual([
    [sourceKeyOf(machineId, "claude_code", PESSOAL), "plan", 1_500],
  ]);
});

test("parts: a model's own week counts that model, a reset or unknown window has none; a removed account stays in the month", async () => {
  const { machineId, atlas, spend } = await scene();
  await spend(atlas.id, null, "claude-opus-5-5", 10_000);
  await spend(atlas.id, null, "claude-sonnet-5-5", 10_000);
  await spend(f.agent.id, null, "claude-sonnet-5-5", 10_000);
  // The computer's own sign-in reports its windows on the machine (ADR 0059 §7).
  await f.db
    .update(schema.machines)
    .set({
      executors: sql`${schema.machines.executors} || ${JSON.stringify({
        claude: { version: "2.1.310", plan: "pro" },
        ownUsage: {
          claude_code: usage([
            { kind: "seven_day_opus", usedPercent: 40, resetsAt: hours(48) },
            { kind: "five_hour", usedPercent: 90, resetsAt: hours(-1) },
            { kind: "other", label: "Extra usage", usedPercent: 10 },
          ]),
        },
      })}::jsonb`,
    })
    .where(eq(schema.machines.id, machineId));

  const view = await orgPlanUsage(f.db, f.owner.id, f.org.id);
  const own = view.accounts.find((a) => a.accountId === null);
  expect(own?.plan).toBe("pro");
  expect(own?.usage?.windows.map((w) => [w.kind, w.agents])).toEqual([
    // Only Atlas used Opus on it this week.
    ["seven_day_opus", [{ agentId: atlas.id, name: "Atlas", percent: 40 }]],
    ["five_hour", []],
    // A provider's own window has no known length: no estimate.
    ["other", null],
  ]);

  // Pessoal goes away: Dev's tokens on it stay in its month, as a removed account.
  await spend(f.agent.id, PESSOAL, "claude-sonnet-5-5", 2_000);
  await f.db.update(schema.agents).set({ brainAccountId: null }).where(eq(schema.agents.id, f.agent.id));
  await f.db.delete(schema.machineAccounts).where(eq(schema.machineAccounts.id, PESSOAL));
  const dev = await agentPlanUsage(f.db, f.owner.id, f.org.id, f.agent.id);
  const removed = dev.sources.find((s) => s.key === sourceKeyOf(machineId, "claude_code", PESSOAL));
  expect(removed).toMatchObject({ type: "plan", kind: "claude_code", account: null, removed: true, tokens: 2_000 });
  expect(dev.current?.accountId).toBeNull();
  expect((await orgPlanUsage(f.db, f.owner.id, f.org.id)).accounts.some((a) => a.accountId === PESSOAL)).toBe(false);
});

test("parts: use from before a window started stays out of it; a model without a price weighs like the priced ones", async () => {
  const { atlas, spend } = await scene();
  // Pessoal: 60% of the 5 hours that started 3 hours ago, 30% of the week.
  await spend(f.agent.id, PESSOAL, "claude-sonnet-5-5", 10_000);
  // A turn whose CLI didn't name its model is stored under the brain's name, which has no price.
  await spend(atlas.id, PESSOAL, "claude_code", 10_000);
  const earlier = await spend(atlas.id, PESSOAL, "claude-sonnet-5-5", 50_000);
  await f.db
    .update(schema.usageRecords)
    .set({ createdAt: new Date(Date.now() - 4 * 3_600_000) })
    .where(eq(schema.usageRecords.id, earlier ?? ""));

  const pessoal = (await orgPlanUsage(f.db, f.owner.id, f.org.id)).accounts.find((a) => a.accountId === PESSOAL);
  const parts = (kind: string) =>
    pessoal?.usage?.windows.find((w) => w.kind === kind)?.agents?.map((a) => [a.name, a.percent]);
  expect(parts("five_hour")?.sort()).toEqual([
    ["Atlas", 30],
    ["Dev", 30],
  ]);
  // The week holds the earlier turn too: Atlas weighs 60k tokens of Sonnet, Dev 10k.
  expect(parts("seven_day")).toEqual([
    ["Atlas", 25.7],
    ["Dev", 4.3],
  ]);
});

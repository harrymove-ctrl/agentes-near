import { afterEach, expect, test } from "bun:test";
import { and, eq, schema, sql } from "@agenteschat/db";
import { costNanoUsd } from "@agenteschat/providers";
import {
  addChannelMember,
  drainOutbox,
  openDm,
  PERSON_LIMIT,
  PersonLimitError,
  peopleUsage,
  peopleUsageCsv,
  personLimitsOf,
  personUsageDetail,
  postPersonMessage,
  raisePersonLimit,
  recordPlanUsage,
  renderPush,
  requestMoreUsage,
  resolveLimit,
  setPersonLimits,
} from "../src";
import { addMember, adminRoleId, type Fixture, setup } from "./fixtures";

let f: Fixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

const usage = { inputTokens: 1000, outputTokens: 100 };
const callCost = costNanoUsd("claude-sonnet-5-5", { ...usage, cacheReadTokens: 0, cacheWriteTokens: 0 });
const call = (fx: Fixture, personId: string | null) =>
  fx.gateway.stream({
    orgId: fx.org.id,
    agentId: fx.agent.id,
    personId,
    system: "sys",
    messages: [{ role: "user", content: "hello" }],
    maxTokens: 300,
    onDelta: () => {},
  });
const month = async (fx: Fixture, personId: string) =>
  (
    await fx.db
      .select()
      .from(schema.personUsageMonths)
      .where(and(eq(schema.personUsageMonths.orgId, fx.org.id), eq(schema.personUsageMonths.personId, personId)))
  )[0];
const noLimits = personLimitsOf({});

test("the limit rule: owners none, a raise, the person's own, the highest role's, else the default", () => {
  const limits = personLimitsOf({ default: 20, roles: { sales: 30, eng: 10, admin: null }, people: { liam: 5 } });
  const m = (userId: string, roleIds: string[], owner = false) => ({ userId, owner, roleIds });
  expect(resolveLimit(limits, m("amara", ["admin"], true), null)).toEqual({ limitNanoUsd: null, source: "owner" });
  expect(resolveLimit(limits, m("liam", ["sales"]), 45)).toEqual({ limitNanoUsd: 45, source: "raised" });
  expect(resolveLimit(limits, m("liam", ["sales"]), null)).toEqual({ limitNanoUsd: 5, source: "person" });
  expect(resolveLimit(limits, m("mateus", ["eng", "sales"]), null)).toEqual({
    limitNanoUsd: 30,
    source: "role",
    roleId: "sales",
  });
  expect(resolveLimit(limits, m("kenji", ["eng", "admin"]), null)).toMatchObject({
    limitNanoUsd: null,
    source: "role",
  });
  expect(resolveLimit(limits, m("sofia", []), null)).toEqual({ limitNanoUsd: 20, source: "default" });
  // Off by default: nobody has one.
  expect(resolveLimit(noLimits, m("sofia", []), null)).toEqual({ limitNanoUsd: null, source: "none" });
  expect(noLimits).toMatchObject({ onLimit: "block", warn: true });
});

test("the gateway records the person and counts their month; at the limit the next call never reaches the model", async () => {
  f = await setup({ reply: () => ({ chunks: ["ok"], usage }) });
  const member = await addMember(f.db, f.org.id, "member", "Mateus");
  // No limit anywhere: calls go through and still count.
  await call(f, member.id);
  const [row] = await f.db.select().from(schema.usageRecords);
  expect(row?.personId).toBe(member.id);
  expect((await month(f, member.id))?.spentNanoUsd).toBe(callCost);
  // An agent's own call counts for nobody.
  await call(f, null);
  expect((await month(f, member.id))?.spentNanoUsd).toBe(callCost);

  // A limit a bit over one call: the second call crosses it, the third is refused before the provider.
  await setPersonLimits(f.db, f.owner.id, f.org.id, { ...noLimits, people: { [member.id]: callCost * 2 + 1 } });
  await call(f, member.id);
  const before = f.provider.calls.length;
  await call(f, member.id);
  await expect(call(f, member.id)).rejects.toBeInstanceOf(PersonLimitError);
  expect(f.provider.calls.length).toBe(before + 1);
  // Someone else is not held by it.
  await call(f, f.owner.id);
  // Reaching it queued who decides a notice (once), and the month remembers when.
  expect((await month(f, member.id))?.reachedAt).not.toBeNull();
  const jobs = await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, "usage.person_limit"));
  expect(jobs.map((j) => j.payload.level).sort()).toEqual(["reached", "warning"]);

  // "Só avisar os admins": the same spend no longer blocks.
  await setPersonLimits(f.db, f.owner.id, f.org.id, {
    ...noLimits,
    onLimit: "notify",
    people: { [member.id]: callCost * 2 + 1 },
  });
  await call(f, member.id);
});

test("a member removed while the call settles: the call's usage is still recorded, their month is not", async () => {
  f = await setup({ reply: () => ({ chunks: ["ok"], usage }) });
  const member = await addMember(f.db, f.org.id, "member", "Mateus");
  // The removal lands inside the settle statement, after its snapshot still showed the member.
  await f.db.execute(
    sql.raw(`create function remove_member_mid_settle() returns trigger language plpgsql as $$
    begin delete from organization_members where user_id = new.person_id; return new; end $$`),
  );
  await f.db.execute(
    sql.raw(`create trigger remove_member_mid_settle before insert on usage_records
    for each row execute function remove_member_mid_settle()`),
  );
  await call(f, member.id);
  const [row] = await f.db.select().from(schema.usageRecords);
  expect(row).toMatchObject({ personId: member.id, costNanoUsd: callCost, agentId: f.agent.id });
  expect(await month(f, member.id)).toBeUndefined();
});

test("a plan's turn counts for the person at what it would cost through the API", async () => {
  f = await setup();
  const member = await addMember(f.db, f.org.id, "member");
  await recordPlanUsage(f.db, {
    orgId: f.org.id,
    agentId: f.agent.id,
    personId: member.id,
    provider: "claude_code",
    model: "claude-sonnet-5-5",
    inputTokens: 1000,
    outputTokens: 100,
  });
  const [row] = await f.db.select().from(schema.usageRecords);
  expect([row?.costNanoUsd, row?.billedTo, row?.personId]).toEqual([0, "plan", member.id]);
  expect((await month(f, member.id))?.spentNanoUsd).toBe(callCost);
  const report = await peopleUsage(f.db, f.owner.id, f.org.id);
  expect(report.plansOnly).toBe(true);
  expect(report.people.find((p) => p.userId === member.id)).toMatchObject({ estimated: true });
  // Their drawer says the same of their month.
  expect((await personUsageDetail(f.db, f.owner.id, f.org.id, member.id)).estimated).toBe(true);
});

test("at the limit the agent posts the card instead of answering, and a raise turns it into go on", async () => {
  f = await setup({ reply: () => ({ chunks: ["ok"], usage }) });
  const member = await addMember(f.db, f.org.id, "member", "Mateus");
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: member.id });
  await setPersonLimits(f.db, f.owner.id, f.org.id, { ...noLimits, default: 1 });
  await f.db.insert(schema.personUsageMonths).values({
    orgId: f.org.id,
    personId: member.id,
    periodStart: `${new Date().toISOString().slice(0, 8)}01`,
    spentNanoUsd: 5,
  });
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, member.id, f.org.id, f.general.id, { body: "@dev hi" });
  await drainOutbox(f.db, f.handlers);
  const [run] = await f.db.select().from(schema.agentRuns);
  expect([run?.status, run?.error]).toEqual(["failed", PERSON_LIMIT]);
  expect(f.provider.calls).toHaveLength(0);
  const card = (await f.db.select().from(schema.messages)).find((m) => m.meta.actionCard);
  expect(card?.meta.actionCard).toMatchObject({ kind: "person_limit", state: "limited", userId: member.id });
  // Nobody hears it as a failure: the card is the news.
  expect(await f.db.select().from(schema.notifications).where(eq(schema.notifications.kind, "run_failed"))).toEqual([]);

  // Pedir mais: who decides hears it, waiting, with the raise to offer; never the member.
  await requestMoreUsage({ db: f.db, pubsub: f.pubsub }, member.id, f.org.id);
  const [asked] = await f.db.select().from(schema.notifications).where(eq(schema.notifications.kind, "usage_limit"));
  expect(asked).toMatchObject({ userId: f.owner.id, waiting: true });
  expect(asked?.latest).toMatchObject({ statusTo: "request", limitUsd: 1e-9, raiseToUsd: 1 });
  // Asking again while nobody answered tells nobody again.
  await requestMoreUsage({ db: f.db, pubsub: f.pubsub }, member.id, f.org.id);
  const again = await f.db.select().from(schema.notifications).where(eq(schema.notifications.kind, "usage_limit"));
  expect(again.map((n) => n.count)).toEqual([1]);
  expect(renderPush("pt-BR", { kind: "usage_limit", waiting: true, actorName: "Mateus", status: "request" })).toEqual({
    title: "Mateus pediu mais uso este mês",
    body: "Toque para aumentar o limite ou recusar.",
  });

  // A member can't raise anyone's limit; the owner can, for this month.
  await expect(
    raisePersonLimit({ db: f.db, pubsub: f.pubsub }, member.id, f.org.id, member.id, 45e9),
  ).rejects.toThrow();
  await raisePersonLimit({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, member.id, 45e9);
  const moved = (await f.db.select().from(schema.messages)).find((m) => m.meta.actionCard);
  expect(moved?.meta.actionCard).toMatchObject({ state: "raised", byUserId: f.owner.id });
  const rows = await f.db.select().from(schema.notifications).where(eq(schema.notifications.kind, "usage_limit"));
  expect(rows.find((r) => r.userId === f?.owner.id)?.doneAt).not.toBeNull();
  // The person hears it in percentages only.
  const told = rows.find((r) => r.userId === member.id);
  expect(told?.latest).toEqual({ statusTo: "raised", percent: 0 });
});

test("admins see counts and cost of a DM, never its title; members see only their own, in percentages", async () => {
  f = await setup({ reply: () => ({ chunks: ["ok"], usage }) });
  // A name a spreadsheet would run as a formula stays text in the CSV.
  const member = await addMember(f.db, f.org.id, "member", "=Mateus");
  // The admin isn't in #general: a public channel's work is still named for them.
  const admin = await addMember(f.db, f.org.id, "admin", "Kenji");
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: member.id });
  const fx = f;
  const say = (channelId: string, body: string) =>
    postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, member.id, fx.org.id, channelId, { body });
  await say(f.general.id, "@dev Proposta para a Lumen Tiles\nwith details");
  const dm = await openDm(f.db, member.id, f.org.id, { agentId: f.agent.id });
  await say(dm.id, "my private plans for the raise");
  await drainOutbox(f.db, f.handlers);

  const detail = await personUsageDetail(f.db, admin.id, f.org.id, member.id);
  expect(detail.money).toBe(true);
  expect(detail.estimated).toBe(false);
  const work = detail.recent.find((r) => r.kind === "work");
  expect(work).toMatchObject({ title: "Proposta para a Lumen Tiles", place: { kind: "channel" } });
  const priv = detail.recent.find((r) => r.kind === "private");
  expect(priv).toMatchObject({ agentId: f.agent.id, runs: 1 });
  expect(JSON.stringify(detail)).not.toContain("private plans");

  const report = await peopleUsage(f.db, admin.id, f.org.id);
  const row = report.people.find((p) => p.userId === member.id);
  expect(row?.runs).toBe(2);
  expect(row?.costUsd).toBeGreaterThan(0);
  expect(JSON.stringify(report)).not.toContain("private plans");
  const csv = await peopleUsageCsv(f.db, admin.id, f.org.id);
  expect(csv.split("\n")[0]).toBe("person,email,roles,day,requests,tokens,cost_usd,plan_estimate_usd,agents");
  expect(csv).toContain("'=Mateus");
  expect(csv).not.toContain("Lumen");

  // A member reads their own month in percentages, never someone else's, nor the people report.
  const own = await personUsageDetail(f.db, member.id, f.org.id, member.id);
  expect(own.money).toBe(false);
  expect(own.limit).not.toHaveProperty("limitUsd");
  expect(own.agents[0]?.amount).toBe(100);
  await expect(personUsageDetail(f.db, member.id, f.org.id, admin.id)).rejects.toThrow();
  await expect(peopleUsage(f.db, member.id, f.org.id)).rejects.toThrow();
});

test("limits name only roles and people of the workspace, and only who configures saves them", async () => {
  f = await setup();
  const member = await addMember(f.db, f.org.id, "member");
  const role = await adminRoleId(f.db, f.org.id);
  const saved = await setPersonLimits(f.db, f.owner.id, f.org.id, {
    ...noLimits,
    default: 20e9,
    roles: { [role]: null, "00000000-0000-4000-8000-000000000000": 5e9 },
    people: { [member.id]: 10e9, nobody: 1e9 },
  });
  expect(saved).toMatchObject({ default: 20e9, roles: { [role]: null }, people: { [member.id]: 10e9 } });
  await expect(setPersonLimits(f.db, member.id, f.org.id, noLimits)).rejects.toThrow();
  const [audit] = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "usage.limit_changed"));
  expect(audit?.actorId).toBe(f.owner.id);
});

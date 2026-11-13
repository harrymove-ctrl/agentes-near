import { afterEach, expect, test } from "bun:test";
import { type RealtimeEvent, userTopic } from "@agenteschat/adapters";
import { listNotifications, notifyRunFailed, RUN_FAILED_GROUP_MS, resolveRunFailed } from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

let clock = Date.parse("2026-11-02T12:00:00Z");
const deps = () => ({ db: f.db, pubsub: f.pubsub, now: () => new Date(clock) });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const AGENTS = Array.from({ length: 15 }, (_, i) => id(100 + i));
/** Each agent's turn in its own thread of #general. */
const run = (agentId: string) => ({
  orgId: f.org.id,
  agentId,
  channelId: f.general.id,
  threadRootId: id(Number.parseInt(agentId.slice(-3), 10) + 500),
  triggerMessageId: id(Number.parseInt(agentId.slice(-3), 10) + 500),
});
const signedOut = { code: "not_logged_in", plan: "Claude" };
const fail = (agentId: string, reason = "brain_unavailable: signed out", cause: object | undefined = signedOut) =>
  notifyRunFailed(deps(), run(agentId), f.owner.id, reason, cause);
const inbox = async () => (await listNotifications(deps(), f.owner.id, f.org.id)).items;

test("one cause failing many agents at once is one row listing them; another cause and a lone failure keep theirs", async () => {
  f = await setup();
  clock = Date.parse("2026-11-02T12:00:00Z");
  const events: RealtimeEvent[] = [];
  f.pubsub.subscribe(userTopic(f.org.id, f.owner.id), (e) => events.push(e));
  for (const a of AGENTS) {
    clock += 20_000;
    await fail(a);
  }
  // The same failure again (a retried report) changes nothing.
  await fail(AGENTS[0] as string);
  await fail(id(900), "budget_exceeded", {});

  const rows = await inbox();
  expect(rows).toHaveLength(2);
  const group = rows.find((n) => n.latest.reason === "not_logged_in");
  expect(group?.kind).toBe("run_failed");
  expect(group?.count).toBe(15);
  expect(group?.latest.plan).toBe("Claude");
  expect(group?.latest.failures?.map((x) => x.agentId).sort()).toEqual([...AGENTS].sort());
  expect(group?.actors).toHaveLength(10);
  const lone = rows.find((n) => n.latest.reason === "budget_exceeded");
  expect(lone?.count).toBe(1);
  expect(lone?.source.agentId).toBe(id(900));
  expect(lone?.latest.failures).toHaveLength(1);
  // Each one that joined the row told the person's apps, unread again.
  expect(events.filter((e) => e.type === "notification.upserted").length).toBeGreaterThanOrEqual(16);
});

test("past the window the same cause starts a row of its own", async () => {
  f = await setup();
  clock = Date.parse("2026-11-02T12:00:00Z");
  await fail(AGENTS[0] as string);
  await fail(AGENTS[1] as string);
  clock += RUN_FAILED_GROUP_MS + 1000;
  await fail(AGENTS[2] as string);
  const rows = await inbox();
  expect(rows.map((n) => n.count).sort()).toEqual([1, 2]);
});

test("an agent's good run takes it off the row; the last one left reads as its own failure, then it is done", async () => {
  f = await setup();
  clock = Date.parse("2026-11-02T12:00:00Z");
  for (const a of AGENTS.slice(0, 3)) await fail(a);
  await resolveRunFailed(deps(), run(AGENTS[0] as string));
  let [row] = await inbox();
  expect(row?.count).toBe(2);
  expect(row?.latest.failures?.map((x) => x.agentId)).toEqual(AGENTS.slice(1, 3));

  await resolveRunFailed(deps(), run(AGENTS[1] as string));
  [row] = await inbox();
  expect(row?.count).toBe(1);
  expect(row?.actors).toEqual([{ type: "agent", id: AGENTS[2] as string }]);
  expect(row?.source.agentId).toBe(AGENTS[2]);
  expect(row?.source.messageId).toBe(run(AGENTS[2] as string).triggerMessageId);

  await resolveRunFailed(deps(), run(AGENTS[2] as string));
  expect(await inbox()).toHaveLength(0);
});

test("the agent that made a shared row leaves it once: its later good runs leave the count matching the list", async () => {
  f = await setup();
  clock = Date.parse("2026-11-02T12:00:00Z");
  for (const a of AGENTS.slice(0, 3)) await fail(a);
  const events: RealtimeEvent[] = [];
  f.pubsub.subscribe(userTopic(f.org.id, f.owner.id), (e) => events.push(e));
  await resolveRunFailed(deps(), run(AGENTS[0] as string));
  const after = events.length;
  await resolveRunFailed(deps(), run(AGENTS[0] as string));
  const [row] = await inbox();
  expect(row?.count).toBe(2);
  expect(row?.latest.failures?.map((x) => x.agentId)).toEqual(AGENTS.slice(1, 3));
  expect(events.length).toBe(after);
});

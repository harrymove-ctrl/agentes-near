import { expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { keys } from "../src/api/keys";
import { applyMembershipEvent, applyWorkspaceEvent, readUnknownMembers } from "../src/realtime/machines";

const stale = (qc: QueryClient, key: readonly unknown[]) => qc.getQueryState(key)?.isInvalidated;

test("agents.changed: the team's lists, the DMs that name them, the open agent's page and its skills are read again", () => {
  const qc = new QueryClient();
  const lists = [
    keys.agents("o1"),
    keys.formerAgents("o1"),
    keys.dms("o1"),
    keys.team("o1"),
    keys.agentDetail("o1", "a1"),
    keys.skills("o1"),
    keys.agentSkills("o1", "a1"),
  ];
  for (const key of lists) qc.setQueryData(key, []);
  qc.setQueryData(keys.agents("o2"), []);
  expect(applyWorkspaceEvent(qc, "o1", { type: "agents.changed" })).toBe(true);
  for (const key of lists) expect(stale(qc, key)).toBe(true);
  expect(stale(qc, keys.agents("o2"))).toBe(false);
});

test("channels.changed: the channels, the DMs, and each channel's members and roster, open or cached", () => {
  const qc = new QueryClient();
  const lists = [
    keys.channels("o1"),
    keys.dms("o1"),
    keys.channelMembers("o1", "c1"),
    keys.roster("o1", "c2"),
    keys.channelCard("o1", "c1"),
    keys.agentChannels("o1", "a1"),
  ];
  for (const key of lists) qc.setQueryData(key, []);
  qc.setQueryData(keys.messages("o1", "c1"), []);
  expect(applyWorkspaceEvent(qc, "o1", { type: "channels.changed" })).toBe(true);
  for (const key of lists) expect(stale(qc, key)).toBe(true);
  expect(stale(qc, keys.messages("o1", "c1"))).toBe(false);
});

test("the same event again before the gap ends is one read when it ends, not one each", async () => {
  const qc = new QueryClient();
  let reads = 0;
  qc.setQueryDefaults(keys.agents("o1"), { queryFn: () => ++reads });
  const unwatch = new QueryObserver(qc, { queryKey: keys.agents("o1") }).subscribe(() => {});
  await Bun.sleep(5);
  expect(reads).toBe(1);
  for (let i = 0; i < 10; i++) applyWorkspaceEvent(qc, "o1", { type: "agents.changed" });
  await Bun.sleep(5);
  expect(reads).toBe(2);
  await Bun.sleep(600);
  expect(reads).toBe(3);
  await Bun.sleep(600);
  expect(reads).toBe(3);
  applyWorkspaceEvent(qc, "o1", { type: "agents.changed" });
  await Bun.sleep(5);
  expect(reads).toBe(4);
  unwatch();
});

test("an id the directory lacks reads it again, once; one it knows, or a list not loaded yet, doesn't", () => {
  const qc = new QueryClient();
  qc.setQueryData(keys.agents("o1"), [{ id: "a1" }]);
  qc.setQueryData(keys.members("o1"), [{ userId: "u1" }]);
  readUnknownMembers(qc, "o1", [
    { type: "agent", id: "a1" },
    { type: "person", id: "u1" },
  ]);
  expect(stale(qc, keys.agents("o1"))).toBe(false);
  expect(stale(qc, keys.members("o1"))).toBe(false);

  readUnknownMembers(qc, "o1", [{ type: "agent", id: "a2" }]);
  expect(stale(qc, keys.agents("o1"))).toBe(true);
  expect(stale(qc, keys.members("o1"))).toBe(false);

  // Read again without it (an agent this person can't list): no second read, so no loop.
  qc.setQueryData(keys.agents("o1"), [{ id: "a1" }]);
  readUnknownMembers(qc, "o1", [{ type: "agent", id: "a2" }]);
  expect(stale(qc, keys.agents("o1"))).toBe(false);

  readUnknownMembers(qc, "o1", [{ type: "person", id: "u2" }]);
  expect(stale(qc, keys.members("o1"))).toBe(true);

  const fresh = new QueryClient();
  readUnknownMembers(fresh, "o1", [{ type: "agent", id: "a2" }]);
  expect(fresh.getQueryState(keys.agents("o1"))).toBeUndefined();
});

test("a membership event reads that channel's lists again, on the web and the phone alike", () => {
  const qc = new QueryClient();
  qc.setQueryData(keys.channelMembers("o1", "c1"), []);
  qc.setQueryData(keys.roster("o1", "c1"), []);
  qc.setQueryData(keys.channelMembers("o1", "c2"), []);
  const member = { type: "agent" as const, id: "a1" };
  expect(applyMembershipEvent(qc, "o1", { type: "channel.member_added", channelId: "c1", member })).toBe(true);
  expect(stale(qc, keys.channelMembers("o1", "c1"))).toBe(true);
  expect(stale(qc, keys.roster("o1", "c1"))).toBe(true);
  expect(stale(qc, keys.channelMembers("o1", "c2"))).toBe(false);
});

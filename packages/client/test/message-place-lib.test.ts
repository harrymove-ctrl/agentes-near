import { expect, test } from "bun:test";
import type { ActiveRun } from "../src/api/types";
import { firstUnreadId } from "../src/lib/chat-look";
import { landedAfter, lastPostedId, PLACE_KEPT_MS, postedAtOf } from "../src/lib/timeline";
import { applyChannelEvent, emptyStreams, reconcileRuns } from "../src/realtime/streams";

/** A UUIDv7 as the server makes them: its first 48 bits are the clock at the insert (ms). */
const v7 = (ms: number, n = 1) => {
  const h = ms.toString(16).padStart(12, "0");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-7000-8000-${String(n).padStart(12, "0")}`;
};
const at = (iso: string) => Date.parse(iso);

test("an agent at work keeps no place of its own: a server's deltas, and the active runs, say only that it writes", () => {
  const delta = { type: "agent.delta" as const, channelId: "c", threadId: "t", agentId: "ada", runId: "r" };
  const s = applyChannelEvent(emptyStreams, { ...delta, seq: 0, text: "O deploy" });
  expect(s.runs.r?.status).toBe("running");
  expect(Object.keys(s.runs.r ?? {})).not.toContain("text");
  const active: ActiveRun[] = [
    {
      runId: "r2",
      agentId: "atlas",
      channelId: "c",
      threadId: "t",
      status: "running",
      startedAt: "2026-11-08T16:33:00.000Z",
    },
  ];
  expect(reconcileRuns(emptyStreams, "c", active).runs.r2?.status).toBe("thinking");
});

test("what landed after a read: written after it, or posted since in a place before it", () => {
  const read = at("2026-11-08T16:34:00.000Z");
  const placedBefore = { createdAt: "2026-11-08T16:33:23.000Z" };
  expect(postedAtOf(v7(read + 12_000))).toBe(read + 12_000);
  expect(Number.isNaN(postedAtOf("local-abc"))).toBe(true);
  // Posted after the read, in its earlier place: new to whoever read then.
  expect(landedAfter({ ...placedBefore, id: v7(read + 12_000) }, read)).toBe(true);
  // Posted before the read.
  expect(landedAfter({ ...placedBefore, id: v7(read - 1_000) }, read)).toBe(false);
  // No reply keeps a place that far back.
  expect(landedAfter({ createdAt: new Date(read - PLACE_KEPT_MS - 1).toISOString(), id: v7(read + 1) }, read)).toBe(
    false,
  );

  const reply = { id: v7(read + 12_000), author: { type: "agent" as const, id: "ada" }, ...placedBefore };
  const mine = {
    id: v7(read - 5_000),
    author: { type: "person" as const, id: "me" },
    createdAt: "2026-11-08T16:33:55.000Z",
  };
  // The reply is the first unread: "Novas" goes above it, though it sits above my message, sent before I read.
  expect(firstUnreadId([reply, mine], "2026-11-08T16:34:00.000Z", "me")).toBe(reply.id);
  expect(firstUnreadId([{ ...reply, id: v7(read - 1_000) }, mine], "2026-11-08T16:34:00.000Z", "me")).toBeNull();
});

test("the message posted last, wherever its place: what reading marks read up to", () => {
  const read = at("2026-11-08T16:34:00.000Z");
  const meanwhile = { id: v7(read - 5_000) };
  // Posted after the message sent meanwhile, in a place above it.
  const reply = { id: v7(read + 12_000) };
  expect(lastPostedId([reply, meanwhile])).toBe(reply.id);
  // One still on its way isn't the server's yet.
  expect(lastPostedId([meanwhile, { id: "local-abc" }])).toBe(meanwhile.id);
  expect(lastPostedId([{ id: "local-abc" }])).toBeUndefined();
  expect(lastPostedId(undefined)).toBeUndefined();
});

import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type { ActiveRun } from "../src/api/types";
import { runElapsed } from "../src/lib/activity";
import {
  applyChannelEvent,
  emptyStreams,
  reconcileRuns,
  type StreamsState,
  WORK_MISSED_MS,
  workingSinceOf,
} from "../src/realtime/streams";

/**
 * "Thinking for …" counts the work a run is doing now, by this device's clock. Leaving the conversation and coming
 * back reads the server again (`reconcileRuns`): that read must never move the count back to the run's first start.
 */

const T0 = Date.parse("2026-11-10T12:00:00.000Z");
const at = (ms: number) => setSystemTime(new Date(T0 + ms));
afterEach(() => setSystemTime());

type Ev = Parameters<typeof applyChannelEvent>[1];
const base = { channelId: "c1", threadId: "m1", runId: "r1", agentId: "ada" };
const running = { type: "agent.run", ...base, status: "running" } as Ev;
const posted = {
  type: "message.created",
  channelId: "c1",
  messageId: "reply-1",
  message: { id: "reply-1", channelId: "c1", threadId: "m1", agentRunId: "r1", author: { type: "agent", id: "ada" } },
} as unknown as Ev;

const active = (over: Partial<ActiveRun> = {}): ActiveRun => ({ ...base, status: "running", ...over });
const iso = (ms: number) => new Date(T0 + ms).toISOString();
/** The translator's key and its seconds, so the count reads without a language. */
const words = ((key: string, o: { n: number }) => `${key}:${o.n}`) as never;
const since = (s: StreamsState) => {
  const run = s.runs.r1;
  return run ? (workingSinceOf(run) ?? 0) - T0 : undefined;
};

/** A row this device saw open at T0, as the live events leave it. */
const seenAtT0 = () => {
  at(0);
  return applyChannelEvent(emptyStreams, running);
};

describe("a row already here keeps its count when the server is read again", () => {
  test("the run's first start, minutes before, never becomes the count (the jump on coming back)", () => {
    let s = seenAtT0();
    at(20_000);
    // A server from before `workingMs`: all it says is when the run first started.
    s = reconcileRuns(s, "c1", [active({ startedAt: iso(-120_000) })], T0 + 20_000);
    expect(since(s)).toBe(0);
    // Where it started is still the server's, for the row's place in the timeline.
    expect(s.runs.r1?.startedAt).toBe(T0 - 120_000);
    expect(runElapsed(words, s.runs.r1 ?? {}, T0 + 20_000)).toBe("run.elapsedSeconds:20");
  });

  test("a longer count from the server (it counts from the message, this device from its first event) changes nothing", () => {
    let s = seenAtT0();
    s = reconcileRuns(s, "c1", [active({ startedAt: iso(-120_000), workingMs: 140_000 })], T0 + 20_000);
    expect(since(s)).toBe(0);
  });

  test("a read a little off (a slow answer, two clocks) leaves the count alone", () => {
    let s = seenAtT0();
    const now = T0 + 30_000;
    s = reconcileRuns(s, "c1", [active({ workingMs: 30_000 - (WORK_MISSED_MS - 1000) })], now);
    expect(since(s)).toBe(0);
  });

  test("a stretch that began while this device wasn't listening is taken from the server", () => {
    let s = seenAtT0();
    // A minute later the server says the work it is doing now is 3 s old: it posted and went on meanwhile.
    s = reconcileRuns(s, "c1", [active({ workingMs: 3000 })], T0 + 60_000);
    expect(since(s)).toBe(57_000);
  });

  test("a later count from the server changes nothing for a row that heard from the run since", () => {
    let s = seenAtT0();
    // The run posted with a call still running: this device took it for a message on the way and kept counting,
    // the server counts from the post. Its events kept coming, so nothing was missed.
    at(58_000);
    s = applyChannelEvent(s, running);
    s = reconcileRuns(s, "c1", [active({ workingMs: 3000 })], T0 + 60_000);
    expect(since(s)).toBe(0);
  });
});

describe("a row made from the server's read", () => {
  test("counts from the server's length of the work, at the middle of the read, whatever this device's clock says", () => {
    const now = T0 + 5000;
    const served = [active({ startedAt: iso(-600_000), workingMs: 9000 })];
    const s = reconcileRuns(emptyStreams, "c1", served, now, now - 400);
    expect(since(s)).toBe(5000 - 200 - 9000);
  });

  test("a server from before `workingMs`: the run's first start, as it was", () => {
    const s = reconcileRuns(emptyStreams, "c1", [active({ startedAt: iso(-13_000) })], T0);
    expect(since(s)).toBe(-13_000);
  });
});

describe("live", () => {
  test("a run that posts and goes on counts again from there, and a read of the server keeps that", () => {
    let s = seenAtT0();
    at(90_000);
    s = applyChannelEvent(s, posted);
    expect(s.runs.r1).toBeUndefined();
    at(91_000);
    s = applyChannelEvent(s, running);
    expect(since(s)).toBe(91_000);
    // Back from another screen 10 s later: the server counts from the post, this row from the event after it.
    s = reconcileRuns(s, "c1", [active({ startedAt: iso(0), workingMs: 11_000 })], T0 + 101_000);
    expect(since(s)).toBe(91_000);
  });

  test("the row a message I sent opens counts from that message, and keeps counting once its run is known", () => {
    at(0);
    let s = applyChannelEvent(emptyStreams, {
      type: "agent.thinking",
      channelId: "c1",
      threadId: "m1",
      agentId: "ada",
      runId: null,
      messageId: "m1",
    } as Ev);
    at(2500);
    s = applyChannelEvent(s, running);
    expect(since(s)).toBe(0);
  });
});

import { describe, expect, test } from "bun:test";
import {
  agentWaitingPhrase,
  brainsNeeded,
  brainUnavailableOf,
  isOutageEvent,
  moveErrorOf,
  moveOutcome,
  type OutageLike,
  type OutageTargetLike,
  outageNotice,
  outageTaskCount,
  pickedTargetKey,
  supersededBrainNotices,
  targetOptions,
  visibleOutages,
  waitCardState,
  waitingComputerByAgent,
} from "../src/lib/machine-outages";

const air: OutageLike = {
  machineId: "air",
  name: "MacBook Air",
  platform: "darwin",
  offlineSince: "2026-10-18T20:00:00.000Z",
  waitingRuns: 3,
  agents: [
    { agentId: "ada", name: "Ada", brain: "claude_code", waiting: { routines: 2, conversations: 0 } },
    { agentId: "theo", name: "Theo", brain: "claude_code", waiting: { routines: 0, conversations: 1 } },
  ],
};

const pro: OutageTargetLike = {
  kind: "machine",
  machineId: "pro",
  name: "MacBook Pro do Walter",
  platform: "darwin",
  online: true,
  brains: ["claude_code"],
  reasonOff: null,
};
const office: OutageTargetLike = {
  kind: "machine",
  machineId: "office",
  name: "PC do escritório",
  platform: "windows",
  online: false,
  brains: ["claude_code", "codex"],
  reasonOff: "offline",
};
const codexOnly: OutageTargetLike = { ...pro, machineId: "linux", name: "Servidor", brains: ["codex"] };

describe("offline computers", () => {
  test("counts: the server's task count, else the agents' sum; each agent's phrase", () => {
    expect(outageTaskCount(air)).toBe(3);
    expect(outageTaskCount({ ...air, waitingRuns: 0 })).toBe(3);
    expect(agentWaitingPhrase(air.agents[0] as OutageLike["agents"][number])).toEqual({ kind: "routines", count: 2 });
    expect(agentWaitingPhrase({ waiting: { routines: 0, conversations: 1 } })).toEqual({
      kind: "conversations",
      count: 1,
    });
    expect(agentWaitingPhrase({ waiting: { routines: 1, conversations: 2 } })).toEqual({ kind: "tasks", count: 3 });
    expect(agentWaitingPhrase({ waiting: { routines: 0, conversations: 0 } })).toBeNull();
  });

  test("the notice: computer, who waits (two names and how many more) and the tasks", () => {
    expect(outageNotice(air)).toMatchObject({
      computer: "MacBook Air",
      agents: { first: "Ada", second: "Theo", more: 0 },
      tasks: 3,
    });
    const crowd = { ...air, agents: [...air.agents, { ...air.agents[0], agentId: "x", name: "Lisa" }] } as OutageLike;
    expect(outageNotice(crowd).agents).toEqual({ first: "Ada", second: "Theo", more: 1 });
  });

  test("only outages with someone waiting show, newest first; agents map to their computer", () => {
    const old = { ...air, machineId: "old", offlineSince: "2026-10-17T00:00:00.000Z" };
    const empty = { ...air, machineId: "empty", agents: [] };
    expect(visibleOutages([old, empty, air]).map((o) => o.machineId)).toEqual(["air", "old"]);
    expect(visibleOutages(undefined)).toEqual([]);
    const map = waitingComputerByAgent([air]);
    expect(map.get("ada")).toEqual({ machineId: "air", name: "MacBook Air" });
    expect(map.has("atlas")).toBe(false);
  });

  test("targets: every other computer (as on the web), usable first, the rest with a reason", () => {
    const self: OutageTargetLike = { ...pro, machineId: "air", name: "MacBook Air", online: false };
    const opts = targetOptions(air, [office, self, codexOnly, pro], ["ada", "theo"]);
    // The Codex-only server stays, saying what it lacks.
    expect(opts.map((x) => x.key)).toEqual(["m:pro", "m:office", "m:linux"]);
    expect(opts[0]).toMatchObject({ enabled: true, reason: null, target: { kind: "machine", machineId: "pro" } });
    expect(opts[1]).toMatchObject({ enabled: false, reason: "offline" });
    expect(opts[2]).toMatchObject({ enabled: false, reason: "missing_brain", missing: "claude_code" });
  });

  test("targets: paused, missing one of the chosen brains", () => {
    const mixed: OutageLike = {
      ...air,
      agents: [
        ...air.agents,
        { agentId: "lisa", name: "Lisa", brain: "codex", waiting: { routines: 1, conversations: 0 } },
      ],
    };
    const paused: OutageTargetLike = { ...pro, machineId: "p", reasonOff: "paused", brains: ["claude_code", "codex"] };
    const opts = targetOptions(mixed, [pro, codexOnly, paused], ["ada", "lisa"]);
    expect(brainsNeeded(mixed, ["ada", "lisa"])).toEqual(["claude_code", "codex"]);
    expect(opts.find((x) => x.key === "m:pro")).toMatchObject({
      enabled: false,
      reason: "missing_brain",
      missing: "codex",
    });
    expect(opts.find((x) => x.key === "m:linux")).toMatchObject({ enabled: false, missing: "claude_code" });
    expect(opts.find((x) => x.key === "m:p")).toMatchObject({ enabled: false, reason: "paused" });
    // Only Lisa: the Codex server takes her.
    expect(targetOptions(mixed, [codexOnly], ["lisa"])[0]).toMatchObject({ enabled: true });
  });

  test("the chosen target: kept while usable, else the first usable one", () => {
    const opts = targetOptions(air, [pro, office], ["ada"]);
    expect(pickedTargetKey(opts, null)).toBe("m:pro");
    expect(pickedTargetKey(opts, "m:office")).toBe("m:pro");
    expect(pickedTargetKey(targetOptions(air, [office], ["ada"]), null)).toBeNull();
  });

  test("the switch's result and its refusals", () => {
    expect(moveOutcome({ moved: ["ada", "theo"], skipped: [], resumed: 2, stillWaiting: 1 })).toEqual({
      moved: 2,
      skipped: 0,
      resumed: 2,
      stillWaiting: 1,
      tone: "done",
    });
    expect(
      moveOutcome({ moved: ["ada"], skipped: [{ agentId: "theo", reason: "x" }], resumed: 0, stillWaiting: 0 }).tone,
    ).toBe("partial");
    expect(moveOutcome({ moved: [], skipped: [], resumed: 0, stillWaiting: 0 }).tone).toBe("none");
    expect(moveErrorOf({ status: 409, code: "machine.target_paused" })).toBe("machine.target_paused");
    expect(moveErrorOf({ code: "validation" })).toBeNull();
    expect(moveErrorOf(new Error("x"))).toBeNull();
    expect(isOutageEvent({ type: "machine.status" })).toBe(true);
    expect(isOutageEvent({ type: "machine.agents_moved" })).toBe(true);
    expect(isOutageEvent({ type: "machine.updated" })).toBe(false);
  });

  test("the chat's card: the message's info, waiting, moved, back, unknown", () => {
    const meta = {
      bodyCode: "brain_unavailable",
      brainUnavailable: { brain: "claude_code", code: "offline", machineId: "air", agentId: "ada" },
    };
    const info = brainUnavailableOf(meta);
    expect(info).toEqual({ brain: "claude_code", code: "offline", machineId: "air", agentId: "ada", resetsAt: null });
    expect(brainUnavailableOf({ bodyCode: "done" })).toBeNull();
    expect(brainUnavailableOf(undefined)).toBeNull();
    if (!info) throw new Error("info");
    expect(waitCardState(info, [air], "ada")).toMatchObject({ kind: "waiting", computer: "MacBook Air" });
    expect(waitCardState({ ...info, agentId: "atlas" }, [air], null)).toMatchObject({ kind: "moved" });
    expect(waitCardState(info, [], "ada")).toEqual({ kind: "back", machineId: "air" });
    expect(waitCardState(info, undefined, "ada")).toEqual({ kind: "unknown" });
    expect(waitCardState({ ...info, machineId: null }, [air], "ada")).toEqual({ kind: "unknown" });
  });

  test("one card per agent and computer: older notices of the same agent and computer hide", () => {
    const meta = { bodyCode: "brain_unavailable", brainUnavailable: { brain: "claude_code", machineId: "air" } };
    const msg = (id: string, at: string, agent = "ada", threadId: string | null = null) => ({
      id,
      threadId,
      author: { type: "agent", id: agent },
      meta,
      createdAt: `2026-10-18T${at}:00.000Z`,
    });
    const hide = supersededBrainNotices([
      msg("m1", "20:00"),
      msg("m3", "22:00"),
      msg("m2", "21:00"),
      msg("t1", "20:30", "theo"),
      msg("h1", "20:10", "ada", "thread-1"),
    ]);
    expect([...hide].sort()).toEqual(["m1", "m2"]);
  });

  test("a notice the agent moved past hides: it answered later in the same conversation", () => {
    const note = { bodyCode: "brain_unavailable", brainUnavailable: { brain: "claude_code", code: "busy" } };
    const msg = (
      id: string,
      at: string,
      meta: Record<string, unknown>,
      agent = "nova",
      threadId: string | null = null,
    ) => ({
      id,
      threadId,
      author: { type: "agent", id: agent },
      meta,
      createdAt: `2026-11-02T${at}:00.000Z`,
    });
    const hide = supersededBrainNotices([
      msg("n1", "10:00", note),
      msg("answer", "10:20", {}),
      msg("n2", "10:30", note),
      // Another agent's words and another thread's leave them alone.
      msg("rio", "10:40", {}, "rio"),
      msg("t1", "10:05", note, "nova", "thread-1"),
    ]);
    expect([...hide].sort()).toEqual(["n1"]);
  });
});

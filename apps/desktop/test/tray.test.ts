import { describe, expect, test } from "bun:test";
import type { ControlJob, ControlStatus } from "@agenteschat/adapters/runner-control";
import { combinedPause, extendPause, pauseUntil } from "../src/control/pause";
import { macStateOf, type TrayInput, trayStateOf } from "../src/control/tray";

const status = (over: Partial<ControlStatus> = {}): ControlStatus => ({
  paired: true,
  connection: "online",
  version: "0.1.0",
  protocol: 10,
  paused: { paused: false },
  executors: {},
  agents: [],
  ...over,
});
const job: ControlJob = { id: "j", kind: "exec", summary: "bun test", startedAt: "2026-10-17T15:00:00Z" };
const home = (over: Partial<ControlStatus> = {}, jobs: ControlJob[] = [], running = true): TrayInput => ({
  running,
  status: status(over),
  jobs,
});

describe("trayStateOf", () => {
  test("idle with nothing going on", () => {
    expect(trayStateOf([home(), home()], false)).toBe("idle");
    expect(trayStateOf([], false)).toBe("idle");
  });
  test("any paused organization pauses the icon", () => {
    expect(trayStateOf([home({}, [job]), home({ paused: { paused: true, until: null } })], true)).toBe("paused");
  });
  test("any job means working", () => {
    expect(trayStateOf([home(), home({}, [job])], false)).toBe("working");
  });
  test("offline only when every organization is offline", () => {
    expect(trayStateOf([home({ connection: "offline" }), home()], false)).toBe("idle");
    expect(trayStateOf([home({ connection: "offline" }), home({}, [], false)], false)).toBe("offline");
  });
  test("a newer version shows the update badge when nothing else does", () => {
    expect(trayStateOf([home()], true)).toBe("update");
    expect(trayStateOf([home({}, [job])], true)).toBe("working");
  });
  test("unpaired homes (a sign-in in progress) don't count", () => {
    expect(trayStateOf([home({ paired: false, connection: "unpaired" })], false)).toBe("idle");
  });
});

describe("pause", () => {
  const now = new Date(2026, 9, 17, 15, 24, 0);
  test("1 hour, tomorrow at 9, until resumed", () => {
    expect(pauseUntil("1h", now)).toBe(new Date(2026, 9, 17, 16, 24, 0).toISOString());
    expect(pauseUntil("tomorrow", now)).toBe(new Date(2026, 9, 18, 9, 0, 0).toISOString());
    expect(pauseUntil("manual", now)).toBeNull();
  });
  test("+1 hour from the end, or from now when it already ended", () => {
    const until = new Date(2026, 9, 17, 16, 24).toISOString();
    expect(extendPause({ paused: true, until }, now)).toBe(new Date(2026, 9, 17, 17, 24).toISOString());
    const past = new Date(2026, 9, 17, 14, 0).toISOString();
    expect(extendPause({ paused: true, until: past }, now)).toBe(new Date(2026, 9, 17, 16, 24).toISOString());
    expect(extendPause({ paused: true, until: null }, now)).toBeNull();
  });
  test("several organizations: the latest end wins, until-resumed beats any time", () => {
    const a = new Date(2026, 9, 17, 16, 0).toISOString();
    const b = new Date(2026, 9, 17, 18, 0).toISOString();
    expect(combinedPause([{ paused: false }])).toBeNull();
    expect(
      combinedPause([
        { paused: true, until: a },
        { paused: true, until: b },
      ]),
    ).toEqual({ paused: true, until: b });
    expect(
      combinedPause([
        { paused: true, until: a },
        { paused: true, until: null },
      ]),
    ).toEqual({ paused: true, until: null });
  });
});

describe("macStateOf", () => {
  test("paused wins, then online, else offline", () => {
    expect(macStateOf([home(), home({ paused: { paused: true, until: null } })])).toBe("paused");
    expect(macStateOf([home({ connection: "offline" }), home()])).toBe("online");
    expect(macStateOf([home({}, [], false)])).toBe("offline");
    expect(macStateOf([])).toBe("offline");
  });
});

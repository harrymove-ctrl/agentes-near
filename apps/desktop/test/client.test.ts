import { describe, expect, test } from "bun:test";
import type { ControlStatus } from "@agenteschat/adapters/runner-control";
import { ControlClient, ControlError, type ControlMessage } from "../src/control/client";

/** Manual timers: `fire()` runs every pending timeout. */
function fakeTimers() {
  let next = 1;
  const timers = new Map<number, () => void>();
  return {
    setTimer: (fn: () => void) => {
      const id = next++;
      timers.set(id, fn);
      return id;
    },
    clearTimer: (h: unknown) => {
      timers.delete(h as number);
    },
    fire: () => {
      for (const [id, fn] of [...timers]) {
        timers.delete(id);
        fn();
      }
    },
    get size() {
      return timers.size;
    },
  };
}

function setup(prefix = "popover") {
  const sent: { homeId: string; line: string }[] = [];
  const timers = fakeTimers();
  const client = new ControlClient(
    {
      send: async (homeId, line) => {
        sent.push({ homeId, line });
      },
    },
    { idPrefix: prefix, setTimer: timers.setTimer, clearTimer: timers.clearTimer },
  );
  return { client, sent, timers };
}

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

describe("ControlClient", () => {
  test("sends one JSON line with an id and resolves with the matching reply", async () => {
    const { client, sent } = setup();
    const p = client.request("h1", { type: "status" });
    expect(sent).toHaveLength(1);
    const req = JSON.parse(sent[0]?.line ?? "{}");
    expect(req.type).toBe("status");
    expect(typeof req.id).toBe("string");
    expect(req.id.startsWith("popover-")).toBe(true);
    client.receive("h1", JSON.stringify({ type: "reply", id: req.id, ok: true, data: status() }));
    expect((await p).connection).toBe("online");
    expect(client.inFlight).toBe(0);
  });

  test("request fields go on the same line", () => {
    const { client, sent } = setup();
    void client.request("h1", { type: "pause", until: "2026-10-17T16:24:00.000Z" }).catch(() => {});
    const req = JSON.parse(sent[0]?.line ?? "{}");
    expect(req).toMatchObject({ type: "pause", until: "2026-10-17T16:24:00.000Z" });
  });

  test("matches replies by id even out of order", async () => {
    const { client, sent } = setup();
    const a = client.request("h1", { type: "jobs" });
    const b = client.request("h1", { type: "access.pending" });
    const [ra, rb] = sent.map((s) => JSON.parse(s.line));
    client.receive("h1", JSON.stringify({ type: "reply", id: rb.id, ok: true, data: { requests: [] } }));
    client.receive("h1", JSON.stringify({ type: "reply", id: ra.id, ok: true, data: { jobs: [] } }));
    expect(await a).toEqual({ jobs: [] });
    expect(await b).toEqual({ requests: [] });
  });

  test("an error reply rejects with the runner's code", async () => {
    const { client, sent } = setup();
    const p = client.request("h1", { type: "folders.add", path: "/", agents: [] });
    const id = JSON.parse(sent[0]?.line ?? "{}").id;
    client.receive(
      "h1",
      JSON.stringify({ type: "reply", id, ok: false, error: { code: "invalid_path", message: "no" } }),
    );
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ControlError);
    expect((err as ControlError).code).toBe("invalid_path");
  });

  test("times out when no reply comes", async () => {
    const { client, timers } = setup();
    const p = client.request("h1", { type: "status" });
    expect(timers.size).toBe(1);
    timers.fire();
    const err = await p.catch((e: unknown) => e);
    expect((err as ControlError).code).toBe("timeout");
    expect(client.inFlight).toBe(0);
  });

  test("a late reply after the timeout is ignored", async () => {
    const { client, sent, timers } = setup();
    const p = client.request("h1", { type: "status" });
    timers.fire();
    await p.catch(() => {});
    const id = JSON.parse(sent[0]?.line ?? "{}").id;
    expect(() => client.receive("h1", JSON.stringify({ type: "reply", id, ok: true, data: {} }))).not.toThrow();
  });

  test("ignores replies for another window or another home", async () => {
    const { client, sent } = setup();
    let settled = false;
    const p = client.request("h1", { type: "status" }).then(() => {
      settled = true;
    });
    const id = JSON.parse(sent[0]?.line ?? "{}").id;
    client.receive("h1", JSON.stringify({ type: "reply", id: "prefs-1", ok: true, data: {} }));
    client.receive("h2", JSON.stringify({ type: "reply", id, ok: true, data: {} }));
    await Promise.resolve();
    expect(settled).toBe(false);
    client.receive("h1", JSON.stringify({ type: "reply", id, ok: true, data: status() }));
    await p;
    expect(settled).toBe(true);
  });

  test("routes hello and events to subscribers with the home id", () => {
    const { client } = setup();
    const got: [string, ControlMessage][] = [];
    const off = client.subscribe((homeId, m) => got.push([homeId, m]));
    client.receive("h1", JSON.stringify({ type: "hello", control: 1, version: "0.1.0", protocol: 10, home: "/x" }));
    client.receive("h2", JSON.stringify({ type: "event", event: { kind: "job.finished", jobId: "j1", result: "ok" } }));
    expect(got.map(([h, m]) => [h, m.kind])).toEqual([
      ["h1", "hello"],
      ["h2", "event"],
    ]);
    const second = got[1]?.[1];
    expect(second?.kind === "event" && second.event.kind).toBe("job.finished");
    off();
    client.receive("h1", JSON.stringify({ type: "event", event: { kind: "status", status: status() } }));
    expect(got).toHaveLength(2);
  });

  test("skips lines that are not JSON or too long", () => {
    const { client } = setup();
    const got: unknown[] = [];
    client.subscribe((_h, m) => got.push(m));
    client.receive("h1", "not json");
    client.receive("h1", "");
    client.receive("h1", "null");
    client.receive("h1", `{"type":"event","event":{"kind":"status"},"pad":"${"x".repeat(1024 * 1024)}"}`);
    expect(got).toHaveLength(0);
  });

  test("closeHome fails that home's open requests only", async () => {
    const { client } = setup();
    const a = client.request("h1", { type: "status" });
    const b = client.request("h2", { type: "status" });
    client.closeHome("h1");
    expect(((await a.catch((e: unknown) => e)) as ControlError).code).toBe("closed");
    expect(client.inFlight).toBe(1);
    client.closeHome("h2");
    await b.catch(() => {});
  });

  test("a failed write rejects at once", async () => {
    const timers = fakeTimers();
    const client = new ControlClient(
      {
        send: async () => {
          throw new Error("not running");
        },
      },
      { setTimer: timers.setTimer, clearTimer: timers.clearTimer },
    );
    const err = await client.request("h1", { type: "status" }).catch((e: unknown) => e);
    expect((err as ControlError).code).toBe("send_failed");
    expect(timers.size).toBe(0);
  });
});

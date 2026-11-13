import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import {
  type BrowserTraffic,
  MACHINE_PROTOCOL_VERSION,
  type MachineLoad,
  type MachineRequest,
  type RunnerInfo,
  type ServerFrame,
} from "@agenteschat/adapters/machine-protocol";
import { connectUrl } from "../../runner/config";
import {
  backoffDelay,
  type ConnectionOptions,
  type Dial,
  RunnerConnection,
  type Socket,
  type SocketHandlers,
} from "../../runner/connection";
import { MIN_FREE_BYTES } from "../../runner/desktop-session";
import { RunnerError } from "../../runner/errors";
import {
  LOCKED_TURN_MIN_FREE_BYTES,
  MAX_IN_FLIGHT,
  PERSON_TURN_MIN_FREE_BYTES,
  RequestRunner,
  TURN_BYTES,
  TURN_SETTLE_MS,
  TURNS_WITHOUT_MEMORY,
} from "../../runner/handlers";
import { removeDirs, tempDir, waitFor } from "./helpers";

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

class FakeSocket implements Socket {
  readonly sent: Record<string, unknown>[] = [];
  closed = false;
  bufferedAmount = 0;
  constructor(readonly handlers: SocketHandlers) {}
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.handlers.onClose(1000, ""));
  }
  /** The server sends a frame. */
  frame(f: ServerFrame) {
    this.handlers.onMessage(JSON.stringify(f));
  }
}

function setup(over: Partial<ConnectionOptions> = {}) {
  const ws = tempDir();
  dirs.push(ws);
  const sockets: FakeSocket[] = [];
  const dial: Dial = (_url, handlers) => {
    const s = new FakeSocket(handlers);
    sockets.push(s);
    return s;
  };
  const info: RunnerInfo = {
    version: "0.1.0",
    protocol: MACHINE_PROTOCOL_VERSION,
    os: "linux",
    arch: "x64",
    hostname: "box",
    workspace: ws,
    exec: false,
  };
  const lines: string[] = [];
  const connection = new RunnerConnection({
    url: "wss://agentes.test/api/machines/connect",
    token: "agm_token",
    info,
    context: { workspaceReal: ws, exec: false, token: "agm_token" },
    dial,
    random: () => 0,
    log: (l) => lines.push(l),
    ...over,
  });
  return { ws, sockets, connection, lines };
}

const sock = (sockets: FakeSocket[], i: number) => sockets[i] as FakeSocket;

test("the connect URL comes from the server URL", () => {
  expect(connectUrl("https://agentes.chat")).toBe("wss://agentes.chat/api/machines/connect");
  expect(connectUrl("http://localhost:3000")).toBe("ws://localhost:3000/api/machines/connect");
});

test("backoff: 1 s doubling to 60 s, with jitter", () => {
  expect(backoffDelay(0, () => 0.5)).toBe(1000);
  expect(backoffDelay(1, () => 0.5)).toBe(2000);
  expect(backoffDelay(3, () => 0)).toBe(6400);
  expect(backoffDelay(20, () => 1)).toBe(60_000);
  expect(backoffDelay(0, () => 0)).toBe(800);
});

test("hello first, ping → pong, request → result, refused → stops with exit 2", async () => {
  const { ws, sockets, connection, lines } = setup();
  writeFileSync(path.join(ws, "hello.txt"), "hi there");
  const done = connection.run();
  await waitFor(() => sockets.length === 1);
  const s = sock(sockets, 0);
  s.handlers.onOpen();
  await waitFor(() => s.sent.length === 1);
  expect(s.sent[0]).toEqual({
    type: "hello",
    token: "agm_token",
    version: "0.1.0",
    protocol: MACHINE_PROTOCOL_VERSION,
    os: "linux",
    arch: "x64",
    hostname: "box",
    workspace: ws,
    exec: false,
  });

  s.frame({ type: "welcome", machineId: "m1", name: "My box", heartbeatMs: 25_000 });
  expect(lines).toContain("connected as My box");

  s.frame({ type: "ping", at: 42 });
  expect(s.sent[1]).toEqual({ type: "pong", at: 42 });

  s.frame({ type: "request", id: "r1", op: "read", path: "hello.txt", maxBytes: 1000 });
  await waitFor(() => s.sent.some((f) => f.id === "r1"));
  expect(s.sent.find((f) => f.id === "r1")).toEqual({
    type: "result",
    id: "r1",
    ok: true,
    data: { base64: Buffer.from("hi there").toString("base64"), size: 8 },
  });
  expect(lines).toContain("read hello.txt");

  s.frame({ type: "request", id: "r2", op: "exec", command: "echo hi", timeoutSeconds: 5, stream: false });
  await waitFor(() => s.sent.some((f) => f.id === "r2"));
  expect(s.sent.find((f) => f.id === "r2")).toMatchObject({ ok: false, error: { code: "exec_disabled" } });

  s.frame({ type: "refused", reason: "revoked", message: "This computer was removed" });
  expect(await done).toEqual({ exitCode: 2, reason: "revoked", message: "This computer was removed" });
  expect(s.closed).toBe(true);
  expect(sockets.length).toBe(1);
});

test("protocol 22: a new load summary rides on the next pong, once, and again on a new session", async () => {
  let load: MachineLoad | null = null;
  const { sockets, connection } = setup({ load: () => load });
  const done = connection.run();
  const open = async (i: number) => {
    await waitFor(() => sockets.length === i + 1);
    const s = sock(sockets, i);
    s.handlers.onOpen();
    await waitFor(() => s.sent.length === 1);
    s.frame({ type: "welcome", machineId: "m1", name: "Box", heartbeatMs: 25_000 });
    return s;
  };
  const s = await open(0);
  s.frame({ type: "ping", at: 1 });
  expect(s.sent.at(-1)).toEqual({ type: "pong", at: 1 });
  load = { loadAvg: 0.2, loadPeak: 0.9, memoryAvg: 0.4, memoryPeak: 0.6, hours: 1 };
  s.frame({ type: "ping", at: 2 });
  expect(s.sent.at(-1)).toEqual({ type: "pong", at: 2, load });
  s.frame({ type: "ping", at: 3 });
  expect(s.sent.at(-1)).toEqual({ type: "pong", at: 3 });

  connection.reconnect();
  const again = await open(1);
  again.frame({ type: "ping", at: 4 });
  expect(again.sent.at(-1)).toEqual({ type: "pong", at: 4, load });
  connection.stop();
  await done;
});

test("protocol 23: the browsers' traffic rides on the next pong once per new summary, beside the load", async () => {
  let load: MachineLoad | null = null;
  let traffic: BrowserTraffic | null = null;
  const { sockets, connection } = setup({ load: () => load, browserTraffic: () => traffic });
  const done = connection.run();
  await waitFor(() => sockets.length === 1);
  const s = sock(sockets, 0);
  s.handlers.onOpen();
  await waitFor(() => s.sent.length === 1);
  s.frame({ type: "welcome", machineId: "m1", name: "Box", heartbeatMs: 25_000 });
  s.frame({ type: "ping", at: 1 });
  expect(s.sent.at(-1)).toEqual({ type: "pong", at: 1 });
  traffic = { up: 2000, down: 90_000, hours: 0.1 };
  s.frame({ type: "ping", at: 2 });
  expect(s.sent.at(-1)).toEqual({ type: "pong", at: 2, browserTraffic: traffic });
  s.frame({ type: "ping", at: 3 });
  expect(s.sent.at(-1)).toEqual({ type: "pong", at: 3 });
  // A new sample with the same bytes is a new summary: it goes too, and the load beside it.
  traffic = { ...traffic };
  load = { loadAvg: 0.2, loadPeak: 0.9, memoryAvg: 0.4, memoryPeak: 0.6, hours: 0.1 };
  s.frame({ type: "ping", at: 4 });
  expect(s.sent.at(-1)).toEqual({ type: "pong", at: 4, load, browserTraffic: traffic });
  connection.stop();
  await done;
});

test("the welcome says whether the server runs a task's call once: the MCP side hears it before the tasks", async () => {
  const heard: string[] = [];
  const { sockets, connection } = setup({
    mcp: { attach: (_send, server) => heard.push(`mcp ${server?.mcpOnce}`), detach() {}, result() {} },
    tasks: { list: () => [], attach: () => heard.push("tasks"), detach() {}, ack() {} },
  });
  const done = connection.run();
  const open = async (i: number, welcome: Partial<Extract<ServerFrame, { type: "welcome" }>>) => {
    await waitFor(() => sockets.length === i + 1);
    const s = sock(sockets, i);
    s.handlers.onOpen();
    await waitFor(() => s.sent.length === 1);
    s.frame({ type: "welcome", machineId: "m1", name: "Box", heartbeatMs: 25_000, ...welcome });
  };
  await open(0, { mcpOnce: true });
  expect(heard).toEqual(["mcp true", "tasks"]);
  // An older server says nothing: a call cut by a drop isn't sent to it again.
  connection.reconnect();
  await open(1, {});
  expect(heard.slice(2)).toEqual(["mcp false", "tasks"]);
  connection.stop();
  await done;
});

test("tasks: hello carries the journal, each welcome re-sends unacknowledged task.done, task.ack marks it", async () => {
  const done = { taskId: "t1", exitCode: 0, seconds: 3 };
  let delivered = false;
  const acks: string[] = [];
  const attached: ((f: unknown) => void)[] = [];
  const { sockets, connection } = setup({
    tasks: {
      list: () => [{ taskId: "t1", agentId: "a1", status: "done", startedAt: "2026-10-16T10:00:00.000Z" }],
      attach: (send) => {
        attached.push(send as (f: unknown) => void);
        if (!delivered) send({ type: "task.done", ...done });
      },
      detach: () => {},
      ack: (taskId) => {
        acks.push(taskId);
        delivered = true;
      },
    },
  });
  const run = connection.run();
  await waitFor(() => sockets.length === 1);
  const s = sock(sockets, 0);
  s.handlers.onOpen();
  await waitFor(() => s.sent.length === 1);
  expect(s.sent[0]).toMatchObject({ type: "hello", tasks: [{ taskId: "t1", status: "done" }] });
  s.frame({ type: "welcome", machineId: "m1", name: "box", heartbeatMs: 25_000 });
  expect(s.sent[1]).toEqual({ type: "task.done", taskId: "t1", exitCode: 0, seconds: 3 });
  s.frame({ type: "task.ack", taskId: "t1" });
  expect(acks).toEqual(["t1"]);
  expect(attached).toHaveLength(1);
  connection.stop();
  await run;
});

test("refused: outdated exits 3, replaced exits 0", async () => {
  for (const [reason, exitCode] of [
    ["outdated", 3],
    ["replaced", 0],
    ["invalid_token", 2],
  ] as const) {
    const { sockets, connection } = setup();
    const done = connection.run();
    await waitFor(() => sockets.length === 1);
    sock(sockets, 0).handlers.onOpen();
    sock(sockets, 0).frame({ type: "refused", reason, message: reason });
    expect((await done).exitCode).toBe(exitCode);
  }
});

test("reconnects when the socket closes, and when no ping arrives for two heartbeats", async () => {
  const { sockets, connection, lines } = setup();
  const done = connection.run();
  await waitFor(() => sockets.length === 1);
  const first = sock(sockets, 0);
  first.handlers.onOpen();
  first.frame({ type: "welcome", machineId: "m1", name: "box", heartbeatMs: 30 });
  // No ping: the watchdog closes it after 60 ms, then backoff (0.8 s with random 0) dials again.
  await waitFor(() => sockets.length === 2, 4000);
  expect(first.closed).toBe(true);
  expect(lines).toContain("no ping from the server; reconnecting");

  const second = sock(sockets, 1);
  second.handlers.onOpen();
  await waitFor(() => second.sent.length === 1);
  expect(second.sent[0]?.type).toBe("hello");
  // The server drops it: dial again.
  second.handlers.onClose(1006, "");
  await waitFor(() => sockets.length === 3, 4000);

  connection.stop();
  expect((await done).reason).toBe("stopped");
}, 15_000);

test("reconnect(): drops the welcomed socket and dials again without backoff; while backing off, dials now", async () => {
  const { sockets, connection, lines } = setup({ random: () => 0.99 });
  const done = connection.run();
  await waitFor(() => sockets.length === 1);
  const first = sock(sockets, 0);
  first.handlers.onOpen();
  first.frame({ type: "welcome", machineId: "m1", name: "box", heartbeatMs: 25_000 });
  connection.reconnect();
  await waitFor(() => sockets.length === 2, 300);
  expect(first.closed).toBe(true);
  expect(lines).toContain("reconnecting now (asked by the app)");

  // The server drops it before welcome: a backoff starts; reconnect() cuts it short.
  sock(sockets, 1).handlers.onClose(1006, "");
  await waitFor(() => lines.some((l) => l.startsWith("disconnected; reconnecting in")));
  connection.reconnect();
  await waitFor(() => sockets.length === 3, 300);

  connection.stop();
  expect((await done).reason).toBe("stopped");
});

test("a browser command is logged when it ends, with how long it took and what it waited on first", async () => {
  const lines: string[] = [];
  const ws = tempDir();
  dirs.push(ws);
  const setup = { launch: 1400, worker: 1200, install: 28_140, bogus: 7 };
  const runner = new RequestRunner(
    { workspaceReal: ws, exec: true, token: "agm_x" },
    () => {},
    (l) => lines.push(l),
    async (_ctx, req) => {
      if (req.op === "browser.warm") return { started: true, setup: { desktop: 2300, launch: 1400 } };
      if (req.op === "browser.batch") return { answers: [], setup };
      return req.op === "browser.act" && req.command === "click" ? { success: false, setup } : { success: true };
    },
  );
  const agent = { id: "01a142cb-489d-7000-87a3-efb5adb382ca", handle: "dev" };
  await runner.start("a", { op: "browser.act", agent, command: "snapshot", args: [], timeoutSeconds: 30 });
  await runner.start("b", { op: "browser.act", agent, command: "click", args: ["@e1"], timeoutSeconds: 30 });
  await runner.start("c", { op: "list", path: "", depth: 1 });
  const open = { command: "open", args: ["https://a.example/"], timeoutSeconds: 60 };
  await runner.start("d", { op: "browser.batch", agent, commands: [open] });
  await runner.start("e", { op: "browser.warm", agent, desktop: true });
  expect(lines[0]).toMatch(/^\[dev\] browser\.act snapshot \d+ms$/);
  expect(lines[1]).toMatch(
    /^\[dev\] browser\.act click \d+ms \(failed, worker 1\.2 s, install 28\.1 s, launch 1\.4 s\)$/,
  );
  expect(lines[2]).toBe("list .");
  expect(lines[3]).toMatch(/^\[dev\] browser\.batch open \d+ms \(worker 1\.2 s, install 28\.1 s, launch 1\.4 s\)$/);
  expect(lines[4]).toMatch(/^\[dev\] browser\.warm \(desktop\) \d+ms \(desktop 2\.3 s, launch 1\.4 s\)$/);
});

test("requests run concurrently up to the ceiling; beyond it the runner answers busy (never to a person's view); cancel aborts", async () => {
  const ws = tempDir();
  dirs.push(ws);
  const sent: Record<string, unknown>[] = [];
  const release: (() => void)[] = [];
  const runner = new RequestRunner(
    { workspaceReal: ws, exec: true, token: "agm_x" },
    (f) => sent.push(f as unknown as Record<string, unknown>),
    () => {},
    (_ctx, _req, scope) =>
      new Promise((resolve, reject) => {
        release.push(() => resolve({ done: true }));
        scope.signal.addEventListener("abort", () => reject(new RunnerError("internal", "Canceled")));
      }),
  );
  const started = Array.from({ length: MAX_IN_FLIGHT }, (_, i) =>
    runner.start(`r${i}`, { op: "list", path: "", depth: 1 }),
  );
  expect(runner.size).toBe(MAX_IN_FLIGHT);
  await runner.start("over", { op: "list", path: "", depth: 1 });
  expect(sent).toEqual([{ type: "result", id: "over", ok: false, error: { code: "internal", message: "busy" } }]);
  // A person's view of an agent still opens on a computer full of agents' work.
  const agent = { id: "01a142cb-489d-7000-87a3-efb5adb382ca", handle: "dev" };
  const view = runner.start("v", {
    op: "stream.open",
    streamId: "s".repeat(43),
    kind: "desktop",
    mode: "watch",
    agent,
  });
  expect(runner.size).toBe(MAX_IN_FLIGHT + 1);
  expect(sent).toHaveLength(1);

  runner.cancel("r0");
  await started[0];
  expect(sent[1]).toEqual({ type: "result", id: "r0", ok: false, error: { code: "internal", message: "Canceled" } });

  release[1]?.();
  await started[1];
  expect(sent[2]).toEqual({ type: "result", id: "r1", ok: true, data: { done: true } });

  runner.close();
  await Promise.all([...started, view]);
  expect(sent.length).toBe(3);
  expect(runner.size).toBe(0);
});

test("a locked-down turn goes past the room check down to its own floor, and a little past the count where memory isn't known", async () => {
  const ws = tempDir();
  dirs.push(ws);
  const sent: { id: string; ok: boolean; error?: { code: string } }[] = [];
  const pending: Promise<void>[] = [];
  let free: number | null = MIN_FREE_BYTES - 1;
  const runner = new RequestRunner(
    { workspaceReal: ws, exec: true, token: "agm_x" },
    (f) => sent.push(f as unknown as (typeof sent)[number]),
    () => {},
    (_ctx, _req, scope) =>
      new Promise((_, reject) => {
        scope.signal.addEventListener("abort", () => reject(new RunnerError("internal", "Canceled")));
      }),
    { memAvailable: () => free, now: () => 1_000_000 },
  );
  const turn = (id: string, locked: boolean) => {
    const req = { op: "brain.turn", runId: id, ...(locked ? { permissions: { mode: "chat" } } : {}) };
    pending.push(runner.start(id, req as unknown as MachineRequest));
  };
  const refused = () => sent.filter((f) => !f.ok).map((f) => f.id);

  // Below the floor everyone else keeps: the agents' turn waits, the locked-down one runs.
  turn("work", false);
  turn("lodi", true);
  expect(refused()).toEqual(["work"]);
  expect(runner.size).toBe(1);

  // A computer about to run out turns it away too, and what it just admitted counts.
  free = LOCKED_TURN_MIN_FREE_BYTES + TURN_BYTES - 1;
  turn("lodi2", true);
  expect(refused()).toEqual(["work", "lodi2"]);

  // Where memory isn't known room is a count of turns: it doesn't count against it.
  free = null;
  for (let i = 0; i < TURNS_WITHOUT_MEMORY - 1; i++) turn(`c${i}`, false);
  turn("over", false);
  turn("lodi3", true);
  expect(refused()).toEqual(["work", "lodi2", "over"]);
  // A bound still: a turn it can't measure is no reason to run any number of them.
  turn("lodi4", true);
  turn("lodi5", true);
  expect(refused()).toEqual(["work", "lodi2", "over", "lodi5"]);
  runner.close();
  await Promise.allSettled(pending);
});

describe("the slot held for a person's turn", () => {
  const room = (
    over: {
      free?: number | null;
      reclaimBrains?: () => Promise<boolean>;
      warmBrain?: (spare: string) => Promise<boolean>;
    } = {},
  ) => {
    const ws = tempDir();
    dirs.push(ws);
    const sent: { id: string; ok: boolean; error?: { code: string } }[] = [];
    const release = new Map<string, () => void>();
    const s = { free: "free" in over ? over.free : MIN_FREE_BYTES - 1, now: 1_000_000 };
    const runner = new RequestRunner(
      { workspaceReal: ws, exec: true, token: "agm_x", reclaimBrains: over.reclaimBrains, warmBrain: over.warmBrain },
      (f) => sent.push(f as unknown as (typeof sent)[number]),
      () => {},
      (_ctx, req) =>
        new Promise((resolve) => {
          release.set((req as { runId?: string }).runId ?? "", () => resolve({}));
        }),
      { memAvailable: () => s.free ?? null, now: () => s.now },
    );
    const turn = (id: string, flags: Record<string, unknown> = {}) =>
      runner.start(id, { op: "brain.turn", runId: id, ...flags } as unknown as MachineRequest);
    const person = (id: string) => turn(id, { personWaiting: true });
    const refused = () => sent.filter((f) => !f.ok).map((f) => f.id);
    const end = async (id: string) => {
      release.get(id)?.();
      await waitFor(() => sent.some((f) => f.id === id));
    };
    return { s, runner, turn, person, refused, end };
  };

  test("below the floor a person's turn goes ahead and an agent's waits; an old server's turn has no flag and waits", async () => {
    const { runner, turn, person, refused } = room();
    await turn("agent");
    expect(refused()).toEqual(["agent"]);
    void person("ana");
    expect(refused()).toEqual(["agent"]);
    expect(runner.size).toBe(1);
    runner.close();
  });

  test("one at a time: a second person waits while the slot is taken, whatever the time", async () => {
    const { s, runner, person, refused, end } = room({ free: MIN_FREE_BYTES - 1 });
    void person("ana");
    s.now += TURN_SETTLE_MS;
    await person("bia");
    expect(refused()).toEqual(["bia"]);
    await end("ana");
    void person("bia2");
    expect(refused()).toEqual(["bia"]);
    expect(runner.size).toBe(1);
    runner.close();
  });

  test("used only when no person's turn was admitted in the last TURN_SETTLE_MS, by the floor or by the slot", async () => {
    const { s, runner, person, refused, end } = room({ free: MIN_FREE_BYTES + 1 });
    // Over the floor: an ordinary admission, and it still counts.
    void person("floor");
    s.free = MIN_FREE_BYTES - 1;
    await person("soon");
    expect(refused()).toEqual(["soon"]);
    s.now += TURN_SETTLE_MS;
    void person("slot");
    await end("slot");
    // The slot is free again, but its turn isn't in the reading yet.
    s.now += TURN_SETTLE_MS - 1;
    await person("soon2");
    expect(refused()).toEqual(["soon", "soon2"]);
    s.now += 1;
    void person("later");
    expect(refused()).toEqual(["soon", "soon2"]);
    runner.close();
  });

  test("its own hard floor: under it the turn waits as ever, and a turn still settling counts", async () => {
    const { s, runner, person, refused } = room({ free: PERSON_TURN_MIN_FREE_BYTES - 1 });
    await person("low");
    expect(refused()).toEqual(["low"]);
    s.free = PERSON_TURN_MIN_FREE_BYTES;
    void person("fits");
    expect(refused()).toEqual(["low"]);
    expect(LOCKED_TURN_MIN_FREE_BYTES).toBeLessThan(PERSON_TURN_MIN_FREE_BYTES);
    runner.close();

    const other = room({ free: MIN_FREE_BYTES + 1 });
    void other.turn("agent");
    other.s.free = PERSON_TURN_MIN_FREE_BYTES + TURN_BYTES - 1;
    await other.person("settling");
    expect(other.refused()).toEqual(["settling"]);
    other.runner.close();
  });

  test("what it takes counts against the agents' floor", async () => {
    const { s, runner, turn, person, refused } = room();
    void person("ana");
    s.free = MIN_FREE_BYTES + TURN_BYTES - 1;
    await turn("agent");
    expect(refused()).toEqual(["agent"]);
    runner.close();
  });

  test("a burst of people's turns, all closing idle CLIs at once, gets one slot", async () => {
    const { runner, person, refused } = room({ reclaimBrains: async () => false });
    for (const id of ["a", "b", "c", "d"]) void person(id);
    await waitFor(() => refused().length === 3);
    expect(refused()).toEqual(["b", "c", "d"]);
    expect(runner.size).toBe(1);
    runner.close();
  });

  test("not where memory isn't known: there is no floor to keep", async () => {
    const { runner, turn, person, refused } = room({ free: null });
    for (let i = 0; i < TURNS_WITHOUT_MEMORY; i++) void turn(`t${i}`);
    await person("ana");
    expect(refused()).toEqual(["ana"]);
    runner.close();
  });

  test("a turn on its session's open CLI isn't counted as a new one: it goes ahead while the floor holds", async () => {
    let closes = 0;
    const r = room({
      free: MIN_FREE_BYTES + TURN_BYTES,
      reclaimBrains: async () => {
        closes++;
        return false;
      },
      warmBrain: async (spare) => spare.endsWith(":warm"),
    });
    const turn = (id: string, session: string) => r.turn(id, { agent: { id: "ada" }, session: { id: session } });
    // One cold turn takes the room the reading shows; the next ones on open CLIs still go ahead.
    void turn("cold", "c1");
    void turn("w1", "warm");
    void turn("w2", "warm");
    await waitFor(() => r.runner.size === 3);
    expect(closes).toBe(0);
    // A cold one waits, after trying to close an idle CLI.
    await turn("cold2", "c2");
    expect(r.refused()).toEqual(["cold2"]);
    expect(closes).toBe(1);
    // Under the floor even an open CLI waits.
    r.s.free = MIN_FREE_BYTES - 1;
    await turn("w3", "warm");
    expect(r.refused()).toEqual(["cold2", "w3"]);
    r.runner.close();
  });

  test("idle CLIs close first: the slot is only for what they couldn't free", async () => {
    let idle = 1;
    let closes = 0;
    const r = room({
      reclaimBrains: async () => {
        closes++;
        if (idle === 0) return false;
        idle--;
        r.s.free = MIN_FREE_BYTES;
        return true;
      },
    });
    // Enough came back: an ordinary admission, the slot stays free for the next person.
    void r.person("floor");
    await waitFor(() => r.runner.size === 1 && closes === 1);
    r.s.free = MIN_FREE_BYTES - 1;
    r.s.now += TURN_SETTLE_MS;
    void r.person("slot");
    await waitFor(() => r.runner.size === 2);
    expect(closes).toBe(2);
    expect(r.refused()).toEqual([]);
    r.runner.close();
  });
});

test("a brain turn starts only while the computer has room; recent ones count until they grow; elsewhere a count", async () => {
  const ws = tempDir();
  dirs.push(ws);
  const sent: { id: string; ok: boolean; error?: { code: string } }[] = [];
  const release = new Map<string, () => void>();
  let free: number | null = MIN_FREE_BYTES + 2 * TURN_BYTES + 1;
  let now = 1_000_000;
  let paused = false;
  const runner = new RequestRunner(
    { workspaceReal: ws, exec: true, token: "agm_x", paused: () => paused },
    (f) => sent.push(f as unknown as (typeof sent)[number]),
    () => {},
    (_ctx, req, scope) =>
      new Promise((resolve, reject) => {
        if (paused) return reject(new RunnerError("paused", "Paused by its owner"));
        release.set((req as { runId?: string }).runId ?? req.op, () => resolve({}));
        scope.signal.addEventListener("abort", () => reject(new RunnerError("internal", "Canceled")));
      }),
    { memAvailable: () => free, now: () => now },
  );
  const running: Promise<void>[] = [];
  const start = (id: string, op = "brain.turn") => {
    const started = runner.start(id, { op, runId: id } as unknown as MachineRequest);
    running.push(started);
    return started;
  };
  const refused = () => sent.filter((f) => !f.ok).map((f) => `${f.id}:${f.error?.code}`);

  // Room for three: each one admitted counts for what it will take until the reading shows it.
  for (const id of ["t1", "t2", "t3", "t4"]) start(id);
  expect(refused()).toEqual(["t4:no_slot"]);
  // Other requests (a turn's own tool calls, a background task with its own count) never wait for room.
  start("task", "task.start");
  running.push(runner.start("list", { op: "list", path: "", depth: 1 }));
  expect(runner.size).toBe(5);

  // Grown since: the reading shows them, so they no longer count on top of it.
  now += TURN_SETTLE_MS;
  free = MIN_FREE_BYTES + TURN_BYTES / 2;
  start("t5");
  start("t6");
  expect(refused()).toEqual(["t4:no_slot", "t6:no_slot"]);

  // A paused computer says so, never that it is full.
  paused = true;
  await start("t7");
  expect(refused().at(-1)).toBe("t7:paused");
  paused = false;

  // Where the memory isn't known (not Linux), a count of the ones running.
  free = null;
  for (let i = 0; i < TURNS_WITHOUT_MEMORY - 4; i++) start(`c${i}`);
  start("c-over");
  expect(refused().at(-1)).toBe("c-over:no_slot");
  release.get("t1")?.();
  await running[0];
  start("c-next");
  expect(refused().at(-1)).toBe("c-over:no_slot");
  expect(runner.size).toBe(TURNS_WITHOUT_MEMORY + 2);

  runner.close();
  await Promise.all(running);
});

test("no room for a turn: idle warm CLIs close first, one at a time, before no_slot; never where memory isn't known", async () => {
  const ws = tempDir();
  dirs.push(ws);
  const sent: { id: string; ok: boolean; error?: { code: string; message: string } }[] = [];
  let free: number | null = MIN_FREE_BYTES - 1;
  /** Idle CLIs left, and what closing one gives back. */
  let idle = 2;
  let closes = 0;
  const spares: string[] = [];
  let release = () => {};
  const held = new Promise<unknown>((r) => {
    release = () => r({});
  });
  let slowClose: Promise<void> | null = null;
  const runner = new RequestRunner(
    {
      workspaceReal: ws,
      exec: true,
      token: "agm_x",
      reclaimBrains: async (spare) => {
        closes++;
        spares.push(spare);
        if (slowClose) await slowClose;
        if (idle === 0) return false;
        idle--;
        if (free !== null) free += 0.2e9;
        return true;
      },
    },
    (f) => sent.push(f as unknown as (typeof sent)[number]),
    () => {},
    async (_ctx, req) => ((req as unknown as { runId: string }).runId.startsWith("hold") ? held : {}),
    { memAvailable: () => free, now: () => 1_000_000 },
  );
  const turn = (id: string) =>
    runner.start(id, {
      op: "brain.turn",
      runId: id,
      agent: { id: "a1", handle: "nova" },
      session: { id: "s1" },
    } as unknown as MachineRequest);
  const outcome = (id: string) => {
    const f = sent.find((x) => x.id === id);
    return f?.ok ? "ok" : f?.error?.code;
  };

  // One closed CLI is enough: the turn runs. The turn's own session is the one spared last.
  await turn("t1");
  expect(outcome("t1")).toBe("ok");
  expect(closes).toBe(1);
  expect(spares[0]).toBe("a1:s1");
  // Not enough left to close: refused once nothing more can close.
  free = MIN_FREE_BYTES - 1e9;
  await turn("t2");
  expect(outcome("t2")).toBe("no_slot");
  expect(closes).toBe(3);

  // Canceled while it waits: nothing more closes for it, and it ends as canceled.
  idle = 5;
  closes = 0;
  let opened = () => {};
  slowClose = new Promise<void>((r) => {
    opened = r;
  });
  const waiting = turn("t3");
  await waitFor(() => closes === 1);
  await turn("t3");
  expect(sent.filter((f) => f.id === "t3").map((f) => f.error?.message)).toEqual(["Duplicate request id"]);
  runner.cancel("t3");
  opened();
  await waiting;
  slowClose = null;
  expect(closes).toBe(1);
  expect(sent.filter((f) => f.id === "t3").at(-1)?.error).toEqual({ code: "internal", message: "Canceled" });

  // Memory not known: room is a count of turns, so at the count nothing is closed for one more.
  free = null;
  closes = 0;
  const holding = Array.from({ length: TURNS_WITHOUT_MEMORY }, (_, i) => turn(`hold${i}`));
  await turn("t4");
  expect(outcome("t4")).toBe("no_slot");
  expect(closes).toBe(0);
  release();
  await Promise.all(holding);
  runner.close();
});

test("backpressure drops only browser pictures and observations are resent after reconnect", async () => {
  const egress = { ip: "8.8.8.8", country: "US" };
  const { sockets, connection } = setup({ egress: () => egress });
  const done = connection.run();
  await waitFor(() => sockets.length === 1);
  const s = sock(sockets, 0);
  s.handlers.onOpen();
  s.frame({ type: "welcome", machineId: "m1", name: "Box", heartbeatMs: 25000, observeEgress: true });
  s.frame({ type: "ping", at: 1 });
  s.frame({ type: "ping", at: 2 });
  expect(s.sent.filter((f) => f.type === "pong")).toEqual([
    { type: "pong", at: 1, egress },
    { type: "pong", at: 2 },
  ]);
  s.bufferedAmount = 3 * 1024 * 1024;
  connection.send({
    type: "browser.frame",
    agentId: "a",
    seq: 1,
    data: "eA==",
    metadata: { deviceWidth: 1, deviceHeight: 1 },
  });
  expect(s.sent.some((f) => f.type === "browser.frame")).toBe(false);
  s.frame({ type: "ping", at: 3 });
  expect(s.sent.at(-1)).toEqual({ type: "pong", at: 3 });
  s.bufferedAmount = 0;
  connection.send({
    type: "browser.frame",
    agentId: "a",
    seq: 2,
    data: "eA==",
    metadata: { deviceWidth: 1, deviceHeight: 1 },
  });
  expect(s.sent.at(-1)?.type).toBe("browser.frame");
  connection.reconnect();
  await waitFor(() => sockets.length === 2);
  const next = sock(sockets, 1);
  next.handlers.onOpen();
  next.frame({ type: "welcome", machineId: "m1", name: "Box", heartbeatMs: 25000, observeEgress: true });
  next.frame({ type: "ping", at: 4 });
  expect(next.sent.at(-1)).toEqual({ type: "pong", at: 4, egress });
  connection.stop();
  await done;
});

test("personal computers never read or emit egress, including direct out-of-band frames", async () => {
  let samples = 0;
  const { sockets, connection } = setup({
    egress: () => {
      samples++;
      return { ip: "8.8.8.8" };
    },
  });
  const done = connection.run();
  await waitFor(() => sockets.length === 1);
  const s = sock(sockets, 0);
  s.handlers.onOpen();
  s.frame({ type: "welcome", machineId: "m1", name: "Personal", heartbeatMs: 25000 });
  s.frame({ type: "ping", at: 1 });
  connection.send({ type: "pong", at: 2, egress: { ip: "8.8.8.8", country: "US" } });
  expect(samples).toBe(0);
  expect(s.sent.filter((f) => f.type === "pong")).toEqual([
    { type: "pong", at: 1 },
    { type: "pong", at: 2 },
  ]);
  connection.stop();
  await done;
});

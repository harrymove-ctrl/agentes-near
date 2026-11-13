import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { MACHINE_PROTOCOL_VERSION, type ServerFrame } from "@agenteschat/adapters/machine-protocol";
import { CONTROL_PROTOCOL_VERSION, type ControlEvent, type ControlOut } from "@agenteschat/adapters/runner-control";
import { configPath, readStoredConfig, type StoredConfig, writeConfig } from "../../runner/config";
import type { Dial, Socket, SocketHandlers } from "../../runner/connection";
import { EXIT_LOCKED, type RunControlOptions, runControl } from "../../runner/control";
import { RunnerDaemon } from "../../runner/daemon";
import { RUNNER_VERSION } from "../../runner/errors";
import { ORG_LOGO_MAX_BYTES, orgLogoPath } from "../../runner/org-logo";
import type { FetchFn } from "../../runner/pairing";
import { removeDirs, tempDir, waitFor } from "./helpers";

const dirs: string[] = [];
const running: { input: PassThrough; done: Promise<number> }[] = [];
afterEach(async () => {
  for (const r of running.splice(0)) {
    r.input.end();
    await r.done;
  }
  removeDirs(dirs);
});

const TOKEN = "agm_machine_token_never_shown_123456";
const AGENT = { id: "0193aaaa-bbbb-7ccc-8ddd-eeeeffff0000", handle: "dev", name: "Dev" };
const SELF = { command: ["/opt/agentes/agentes-runner"], compiled: true };

class FakeSocket implements Socket {
  readonly sent: Record<string, unknown>[] = [];
  closed = false;
  constructor(readonly handlers: SocketHandlers) {}
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.handlers.onClose(1000, ""));
  }
  frame(f: ServerFrame) {
    this.handlers.onMessage(JSON.stringify(f));
  }
  of(type: string) {
    return this.sent.filter((f) => f.type === type);
  }
}

function pairedHome(over: StoredConfig = {}) {
  const home = tempDir("home-");
  const ws = tempDir("ws-");
  dirs.push(home, ws);
  writeConfig(
    {
      server: "https://agentes.test",
      machineId: "m1",
      name: "box",
      token: TOKEN,
      workspace: ws,
      exec: false,
      managedBy: "desktop",
      orgId: "o1",
      orgName: "Acme",
      access: { folders: [], tools: { claude: false, codex: false, commands: false } },
      ...over,
    },
    home,
  );
  return { home, ws };
}

type Reply = Extract<ControlOut, { type: "reply" }>;

function control(
  home: string,
  daemon: Partial<RunControlOptions["daemon"]> = {},
  locked?: RunControlOptions["locked"],
) {
  const input = new PassThrough();
  const out: ControlOut[] = [];
  let buf = "";
  const output = {
    write(chunk: string, cb?: (err?: Error | null) => void) {
      buf += chunk;
      for (;;) {
        const i = buf.indexOf("\n");
        if (i < 0) break;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line) out.push(JSON.parse(line) as ControlOut);
      }
      cb?.();
      return true;
    },
  };
  const sockets: FakeSocket[] = [];
  const dial: Dial = (_url, handlers) => {
    const s = new FakeSocket(handlers);
    sockets.push(s);
    return s;
  };
  const done = runControl({
    home,
    input,
    output,
    locked: locked ?? null,
    daemon: {
      log: () => {},
      watch: false,
      executors: () => ({}),
      self: SELF,
      caffeinate: false,
      dial,
      // No network: the org logo asked after each welcome finds none.
      fetch: async () => new Response(null, { status: 404 }),
      // Never this computer's own phones or tools.
      phones: false,
      toolchains: () => undefined,
      ...daemon,
    },
  });
  running.push({ input, done });
  let n = 0;
  const request = async (body: Record<string, unknown>): Promise<Reply> => {
    const id = `r${++n}`;
    input.write(`${JSON.stringify({ id, ...body })}\n`);
    await waitFor(() => out.some((o) => o.type === "reply" && o.id === id));
    return out.find((o) => o.type === "reply" && o.id === id) as Reply;
  };
  const data = async <T = Record<string, unknown>>(body: Record<string, unknown>): Promise<T> => {
    const r = await request(body);
    if (!r.ok) throw new Error(`${String(body.type)} failed: ${r.error.code} ${r.error.message}`);
    return r.data as T;
  };
  const events = (kind?: ControlEvent["kind"]) =>
    out
      .filter((o): o is Extract<ControlOut, { type: "event" }> => o.type === "event")
      .map((o) => o.event)
      .filter((e) => !kind || e.kind === kind);
  /** The server side: the socket opened, hello read, welcome sent. */
  const connect = async () => {
    await waitFor(() => sockets.length >= 1);
    const s = sockets[sockets.length - 1] as FakeSocket;
    s.handlers.onOpen();
    await waitFor(() => s.of("hello").length === 1);
    s.frame({ type: "welcome", machineId: "m1", name: "box", heartbeatMs: 25_000 });
    return s;
  };
  return { input, out, done, request, data, events, sockets, connect };
}

/** The shared folder's grant (ADR 0115): `<workspace>/shared` for every agent, never in config.json. A new object each call. */
const sharedGrant = () => ({ path: expect.stringMatching(/[\\/]shared$/), agents: ["*"] });

const stored = (home: string) => JSON.parse(readFileSync(configPath(home), "utf8")) as Record<string, unknown>;

test("hello carries what this computer builds with and the phones it reaches; a phone found after it goes out", async () => {
  const { home } = pairedHome();
  const root = tempDir("phones-");
  dirs.push(root);
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const fake = path.join(import.meta.dir, "fake-phone-tools.mjs");
  writeFileSync(path.join(bin, "adb"), `#!/bin/sh\nexec "${process.execPath}" "${fake}" adb "$@"\n`, { mode: 0o755 });
  const state = path.join(root, "state.json");
  writeFileSync(
    state,
    JSON.stringify({
      adbDevices: "List of devices attached\nemulator-5554 device model:sdk_gphone64_arm64\n",
      facts: { "emulator-5554": "model=sdk_gphone64_arm64\nrelease=15\nsdk=35\nboot=1\nqemu=1\navd=Pixel_8_API_35\n" },
    }),
  );
  const c = control(home, {
    toolchains: () => ({ git: "2.50.1", adb: "36.0.2" }),
    phones: {
      env: { PATH: bin, FAKE_PHONE_STATE: state, FAKE_PHONE_LOG: path.join(root, "log") },
      platform: "linux",
      home: root,
      dirs: [],
      adbServer: async () => null,
      lockDir: path.join(root, "locks"),
    },
  });
  const s = await c.connect();
  expect(s.of("hello")[0]).toMatchObject({ toolchains: { git: "2.50.1", adb: "36.0.2" }, phones: expect.any(Array) });
  const told = () =>
    s.sent.flatMap((f) =>
      (f.type === "hello" || f.type === "phones.changed") && Array.isArray(f.phones) ? f.phones : [],
    );
  await waitFor(() => told().length > 0);
  expect(told()[0]).toMatchObject({
    platform: "android",
    serial: "emulator-5554",
    kind: "emulator",
    model: "Pixel 8 API 35",
    state: "ready",
  });
  c.input.end();
  expect(await c.done).toBe(0);
});

test("hello comes first; an unpaired runner answers status; unknown requests are bad_request; stdin closing ends it", async () => {
  const home = tempDir("home-");
  dirs.push(home);
  const c = control(home);
  await waitFor(() => c.out.length >= 1);
  expect(c.out[0]).toEqual({
    type: "hello",
    control: CONTROL_PROTOCOL_VERSION,
    version: RUNNER_VERSION,
    protocol: MACHINE_PROTOCOL_VERSION,
    home,
  });
  const status = await c.data<{ paired: boolean; connection: string; paused: unknown; agents: unknown[] }>({
    type: "status",
  });
  expect(status).toMatchObject({ paired: false, connection: "unpaired", paused: { paused: false }, agents: [] });
  expect(await c.request({ type: "make.coffee" })).toMatchObject({ ok: false, error: { code: "bad_request" } });
  expect(await c.request({ type: "pause", until: null })).toMatchObject({ ok: false, error: { code: "not_paired" } });
  // A line that isn't a request (no id) is ignored, nothing breaks.
  c.input.write("not json\n");
  expect((await c.request({ type: "jobs" })).ok).toBe(true);
  c.input.end();
  expect(await c.done).toBe(0);
});

test("paired: status and hello carry pause and access; pause/resume persist, go to the server, resume on their own", async () => {
  const { home } = pairedHome();
  const c = control(home);
  const s = await c.connect();
  expect(s.of("hello")[0]).toMatchObject({
    type: "hello",
    token: TOKEN,
    protocol: MACHINE_PROTOCOL_VERSION,
    exec: false,
    paused: { paused: false },
    access: { folders: [sharedGrant()], tools: { claude: false, codex: false, commands: false } },
    // Protocol 22: how big this computer is.
    size: { cpus: expect.any(Number), memoryGb: expect.any(Number), diskGb: expect.any(Number) },
  });
  await waitFor(() => c.events("status").some((e) => e.kind === "status" && e.status.connection === "online"));
  s.frame({ type: "agents", agents: [{ id: AGENT.id, handle: "dev", name: "Dev", look: { color: "amber" } }] });
  await waitFor(() => c.events("status").some((e) => e.kind === "status" && e.status.agents.length === 1));
  const status = await c.data<Record<string, unknown>>({ type: "status" });
  expect(status).toMatchObject({
    paired: true,
    server: "https://agentes.test",
    org: { id: "o1", name: "Acme" },
    machine: { id: "m1", name: "box" },
    connection: "online",
    agents: [{ id: AGENT.id, handle: "dev", name: "Dev", look: { color: "amber" } }],
  });
  expect(JSON.stringify(status)).not.toContain(TOKEN);

  expect(await c.data({ type: "pause", until: null })).toEqual({ paused: { paused: true, until: null } });
  expect(stored(home).paused).toEqual({ until: null });
  expect(s.of("runner.state").at(-1)).toEqual({ type: "runner.state", paused: { paused: true, until: null } });
  expect(c.events("activity").some((e) => e.kind === "activity" && e.entry.kind === "pause")).toBe(true);

  // While paused, new work from the server is refused; the runner says why.
  s.frame({ type: "request", id: "q1", op: "list", path: "", depth: 1, agent: AGENT });
  await waitFor(() => s.sent.some((f) => f.id === "q1"));
  expect(s.sent.find((f) => f.id === "q1")).toMatchObject({ ok: false, error: { code: "paused" } });

  expect(await c.data({ type: "resume" })).toEqual({ paused: { paused: false } });
  expect(stored(home).paused).toBeUndefined();
  expect(s.of("runner.state").at(-1)).toEqual({ type: "runner.state", paused: { paused: false } });

  // A pause with an end resumes by itself when it passes.
  const until = new Date(Date.now() + 300).toISOString();
  expect(await c.data({ type: "pause", until })).toEqual({ paused: { paused: true, until } });
  expect(await c.request({ type: "pause", until: "2000-01-01T00:00:00Z" })).toMatchObject({
    ok: false,
    error: { code: "bad_request" },
  });
  await waitFor(() => stored(home).paused === undefined, 3000);
  await waitFor(() => (s.of("runner.state").at(-1) as { paused?: { paused: boolean } }).paused?.paused === false);

  expect(await c.data({ type: "shutdown" })).toEqual({ stopping: true });
  expect(await c.done).toBe(0);
  expect(s.closed).toBe(true);
});

test("hello never waits on the CLIs' looks; what a look finds later reaches the server mid-session", async () => {
  const { home } = pairedHome();
  writeFileSync(path.join(home, "executors.json"), JSON.stringify({ codex: { version: "codex-cli 0.80.0" } }));
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const executorRun = async (command: string, args: string[]) => {
    await gate;
    if (command === "claude") {
      return args[0] === "auth"
        ? { status: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }) }
        : { status: 0, stdout: "2.1.300 (Claude Code)\n" };
    }
    return { status: null, stdout: "", error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }) };
  };
  const c = control(home, { executors: undefined, executorRun });
  // The looks hang: hello still goes out at once, with the list the last run kept.
  const s = await c.connect();
  expect(s.of("hello")[0]?.executors).toEqual({ codex: { version: "codex-cli 0.80.0" } });
  release();
  await waitFor(() => s.of("executors.changed").length === 1);
  expect(s.of("executors.changed")[0]).toEqual({
    type: "executors.changed",
    executors: { claude: { version: "2.1.300 (Claude Code)", loggedIn: true, authMethod: "claude.ai" } },
  });
  // The next start's hello has it at once.
  expect(JSON.parse(readFileSync(path.join(home, "executors.json"), "utf8"))).toMatchObject({
    claude: { version: "2.1.300 (Claude Code)" },
  });
});

test("a new install's hello leaves the CLIs out until the first look, then sends what it found", async () => {
  const { home } = pairedHome();
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const executorRun = async () => {
    await gate;
    return { status: null, stdout: "", error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }) };
  };
  const c = control(home, { executors: undefined, executorRun });
  const s = await c.connect();
  expect(s.of("hello")[0]).not.toHaveProperty("executors");
  release();
  await waitFor(() => s.of("executors.changed").length === 1);
  expect(s.of("executors.changed")[0]).toEqual({ type: "executors.changed", executors: {} });
});

test("a service with no app still looks for the CLIs on a new install, and tells the server", async () => {
  const { home } = pairedHome();
  const sockets: FakeSocket[] = [];
  const daemon = new RunnerDaemon({
    home,
    mode: "start",
    log: () => {},
    print: () => {},
    watch: false,
    self: SELF,
    caffeinate: false,
    dial: (_url, handlers) => {
      const s = new FakeSocket(handlers);
      sockets.push(s);
      return s;
    },
    fetch: async () => new Response(null, { status: 404 }),
    executorRun: async (command) =>
      command === "codex"
        ? { status: 0, stdout: "codex-cli 0.164.0\n" }
        : { status: null, stdout: "", error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }) },
  });
  void daemon.runStart();
  await waitFor(() => sockets.length === 1);
  const s = sockets[0] as FakeSocket;
  s.handlers.onOpen();
  await waitFor(() => s.of("hello").length === 1);
  expect(s.of("hello")[0]).not.toHaveProperty("executors");
  s.frame({ type: "welcome", machineId: "m1", name: "box", heartbeatMs: 25_000 });
  await waitFor(() => s.of("executors.changed").length === 1);
  expect(s.of("executors.changed")[0]).toEqual({
    type: "executors.changed",
    executors: { codex: { version: "codex-cli 0.164.0" } },
  });
  await daemon.stop();
});

test("reconnect from the app: the socket is dropped and dialed again at once, with a fresh hello", async () => {
  const unpaired = tempDir("home-");
  dirs.push(unpaired);
  const u = control(unpaired);
  expect(await u.request({ type: "reconnect" })).toMatchObject({ ok: false, error: { code: "not_paired" } });

  const { home } = pairedHome();
  const c = control(home);
  const first = await c.connect();
  await waitFor(() => c.events("status").some((e) => e.kind === "status" && e.status.connection === "online"));
  const started = Date.now();
  expect(await c.data({ type: "reconnect" })).toEqual({ reconnecting: true });
  await waitFor(() => first.closed);
  // No backoff: the next socket is dialed right away and says hello again.
  const second = await c.connect();
  expect(second).not.toBe(first);
  expect(Date.now() - started).toBeLessThan(700);
  expect(second.of("hello")[0]).toMatchObject({ type: "hello", token: TOKEN });
});

test("reconnect after a refusal: the same token dials again (the server may have refused by mistake)", async () => {
  const { home } = pairedHome();
  const c = control(home);
  const first = await c.connect();
  await waitFor(() => c.events("status").some((e) => e.kind === "status" && e.status.connection === "online"));
  first.frame({ type: "refused", reason: "invalid_token", message: "No hello in time." });
  await waitFor(() => c.events("status").some((e) => e.kind === "status" && e.status.connection === "refused"));

  expect(await c.data({ type: "reconnect" })).toEqual({ reconnecting: true });
  const second = await c.connect();
  expect(second).not.toBe(first);
  expect(second.of("hello")[0]).toMatchObject({ type: "hello", token: TOKEN });
});

test("every status (events and replies) carries a seq that only grows, in the order written", async () => {
  const { home } = pairedHome();
  const c = control(home);
  const s = await c.connect();
  await waitFor(() => c.events("status").some((e) => e.kind === "status" && e.status.connection === "online"));
  s.frame({ type: "agents", agents: [{ id: AGENT.id, handle: "dev", name: "Dev", look: { color: "amber" } }] });
  await waitFor(() => c.events("status").some((e) => e.kind === "status" && e.status.agents.length === 1));
  await c.data({ type: "status" });
  await c.data({ type: "status" });
  const seqs = c.out.flatMap((o) => {
    if (o.type === "event" && o.event.kind === "status") return [o.event.status.seq];
    if (o.type === "reply" && o.ok && (o.data as { connection?: unknown }).connection !== undefined)
      return [(o.data as { seq?: number }).seq];
    return [];
  });
  expect(seqs.length).toBeGreaterThanOrEqual(4);
  for (const seq of seqs) expect(typeof seq).toBe("number");
  for (let i = 1; i < seqs.length; i++) expect(seqs[i] as number).toBeGreaterThan(seqs[i - 1] as number);
  expect(await c.data({ type: "shutdown" })).toEqual({ stopping: true });
  expect(await c.done).toBe(0);
});

test("jobs and the activity log: each request is a job while it runs and a line after, newest first", async () => {
  const { home } = pairedHome();
  const c = control(home);
  const s = await c.connect();
  const write = { op: "write" as const, path: "notes.txt", base64: Buffer.from("hello").toString("base64") };
  s.frame({ type: "request", id: "w1", ...write, agent: AGENT });
  await waitFor(() => s.sent.some((f) => f.id === "w1"));
  s.frame({ type: "request", id: "w2", op: "read", path: "notes.txt", maxBytes: 100, agent: AGENT });
  await waitFor(() => c.events("activity").length >= 2);
  const started = c.events("job.started");
  expect(started[0]).toMatchObject({
    kind: "job.started",
    job: { id: "w1", kind: "write", agent: { id: AGENT.id, name: "Dev" } },
  });
  expect(c.events("job.finished")).toContainEqual({ kind: "job.finished", jobId: "w1", result: "ok" });
  expect((await c.data<{ jobs: unknown[] }>({ type: "jobs" })).jobs).toEqual([]);

  const page = await c.data<{ entries: { summary: string; kind: string; result: string }[]; more: boolean }>({
    type: "activity",
    limit: 1,
  });
  expect(page.entries).toEqual([expect.objectContaining({ summary: "read notes.txt", kind: "file", result: "ok" })]);
  expect(page.more).toBe(true);
  const all = await c.data<{ entries: { summary: string; said?: unknown }[] }>({
    type: "activity",
    agentId: AGENT.id,
  });
  expect(all.entries.map((e) => e.summary)).toEqual(["read notes.txt", "wrote notes.txt"]);
  // Beside its English, what each line is, for the app to say in the person's language.
  expect(all.entries.map((e) => e.said)).toEqual([
    { key: "read", path: "notes.txt" },
    { key: "wrote", path: "notes.txt" },
  ]);
  expect(started[0]).toMatchObject({ job: { said: { key: "wrote", path: "notes.txt" } } });
  expect(readFileSync(path.join(home, "activity.jsonl"), "utf8")).not.toContain(TOKEN);
  // Commands are off on a new app pairing: refused, and the log says so.
  s.frame({
    type: "request",
    id: "x1",
    op: "exec",
    command: "echo hi",
    timeoutSeconds: 10,
    stream: false,
    agent: AGENT,
  });
  await waitFor(() => s.sent.some((f) => f.id === "x1"));
  expect(s.sent.find((f) => f.id === "x1")).toMatchObject({ ok: false, error: { code: "exec_disabled" } });
  await waitFor(() => c.events("activity").some((e) => e.kind === "activity" && e.entry.result === "refused"));
});

test("access requests: pending until the person answers on the machine; the answer reaches the server", async () => {
  const { home } = pairedHome();
  const folder = tempDir("proj-");
  const other = tempDir("other-");
  dirs.push(folder, other);
  const lines: string[] = [];
  const c = control(home, { print: (l) => lines.push(l) });
  const s = await c.connect();
  s.frame({
    type: "agents",
    agents: [AGENT, { id: "0193cccc-bbbb-7ccc-8ddd-eeeeffff0000", handle: "ops", name: "Ops" }],
  });
  const ask = (id: string, requestId: string, p: string) =>
    s.frame({ type: "request", id, op: "access.request", requestId, path: p, reason: "run the tests", agent: AGENT });

  ask("a1", "req-00000001", folder);
  await waitFor(() => s.sent.some((f) => f.id === "a1"));
  expect(s.sent.find((f) => f.id === "a1")).toMatchObject({
    ok: true,
    data: { requestId: "req-00000001", status: "pending" },
  });
  await waitFor(() => c.events("access.requested").length === 1);
  expect(c.events("access.requested")[0]).toMatchObject({
    request: { requestId: "req-00000001", agent: { id: AGENT.id, name: "Dev" }, path: folder, reason: "run the tests" },
  });
  const pending = await c.data<{ requests: { requestId: string }[] }>({ type: "access.pending" });
  expect(pending.requests.map((r) => r.requestId)).toEqual(["req-00000001"]);

  const answered = await c.data<{ access: { folders: unknown[] } }>({
    type: "access.answer",
    requestId: "req-00000001",
    decision: "granted",
    scope: "agent",
  });
  expect(answered.access.folders).toEqual([sharedGrant(), { path: folder, agents: [AGENT.id] }]);
  expect((stored(home).access as { folders: unknown[] }).folders).toEqual([{ path: folder, agents: [AGENT.id] }]);
  expect(s.of("access.changed").at(-1)).toMatchObject({
    access: { folders: [sharedGrant(), { path: folder, agents: [AGENT.id] }] },
  });
  expect(s.of("access.decided")).toEqual([
    { type: "access.decided", requestId: "req-00000001", decision: "granted", scope: "agent" },
  ]);
  expect(c.events("access.resolved")).toContainEqual({
    kind: "access.resolved",
    requestId: "req-00000001",
    decision: "granted",
  });

  // Already allowed: granted at once. A path inside it too.
  ask("a2", "req-00000002", path.join(folder, "sub"));
  await waitFor(() => s.sent.some((f) => f.id === "a2"));
  expect(s.sent.find((f) => f.id === "a2")).toMatchObject({ ok: true, data: { status: "granted" } });

  // "Agora não".
  ask("a3", "req-00000003", other);
  await waitFor(() => c.events("access.requested").length === 2);
  await c.data({ type: "access.answer", requestId: "req-00000003", decision: "denied", scope: "agent" });
  expect(s.of("access.decided").at(-1)).toEqual({
    type: "access.decided",
    requestId: "req-00000003",
    decision: "denied",
  });
  expect((stored(home).access as { folders: unknown[] }).folders).toHaveLength(1);
  expect(
    await c.request({ type: "access.answer", requestId: "req-00000003", decision: "granted", scope: "agent" }),
  ).toMatchObject({
    ok: false,
    error: { code: "not_found" },
  });

  // For every agent of the organization on this machine.
  ask("a4", "req-00000004", other);
  await waitFor(() => c.events("access.requested").length === 3);
  const all = await c.data<{ access: { folders: { path: string; agents: string[] }[] } }>({
    type: "access.answer",
    requestId: "req-00000004",
    decision: "granted",
    scope: "all",
  });
  expect(all.access.folders.find((f) => f.path === other)?.agents.sort()).toEqual(
    [AGENT.id, "0193cccc-bbbb-7ccc-8ddd-eeeeffff0000"].sort(),
  );
  expect(s.of("access.decided").at(-1)).toMatchObject({ requestId: "req-00000004", decision: "granted", scope: "all" });

  // The site can only reduce.
  s.frame({ type: "request", id: "r1", op: "access.reduce", removeFolder: { path: folder } });
  await waitFor(() => s.sent.some((f) => f.id === "r1"));
  expect(s.sent.find((f) => f.id === "r1")).toMatchObject({ ok: true });
  expect((stored(home).access as { folders: { path: string }[] }).folders.map((f) => f.path)).toEqual([other]);
  expect(s.of("access.changed").at(-1)).toMatchObject({ access: { folders: [sharedGrant(), { path: other }] } });
  // Terminal mode would print the command; the app gets the event instead (both kept in sync).
  expect(lines.some((l) => l.includes(`agentes-runner folders allow ${other} --agent dev`))).toBe(true);
});

test("folders, tools and settings from the app: system folders refused, everything lands in config.json", async () => {
  const { home } = pairedHome();
  const folder = tempDir("proj-");
  dirs.push(folder);
  const c = control(home);
  expect(await c.request({ type: "folders.add", path: "/", agents: [] })).toMatchObject({
    ok: false,
    error: { code: "invalid_path" },
  });
  expect(await c.request({ type: "folders.add", path: home, agents: [] })).toMatchObject({
    ok: false,
    error: { code: "invalid_path" },
  });
  expect(await c.data({ type: "folders.add", path: folder, agents: [AGENT.id] })).toMatchObject({
    folders: [sharedGrant(), { path: folder, agents: [AGENT.id] }],
  });
  expect(await c.data({ type: "folders.setAgents", path: folder, agents: [] })).toMatchObject({
    folders: [sharedGrant(), { path: folder, agents: [] }],
  });
  const left = await c.data<{ folders: { path: string }[] }>({ type: "folders.remove", path: folder });
  const sharedPath = left.folders[0]?.path ?? "";
  expect(left).toMatchObject({ folders: [sharedGrant()] });
  // The shared folder can't be removed: it is every agent's, and never in config.json.
  expect(await c.data({ type: "folders.remove", path: sharedPath })).toMatchObject({
    folders: [sharedGrant()],
  });
  // Nor taken from "every agent", which would leave an empty grant behind in config.json.
  expect(await c.data({ type: "folders.remove", path: sharedPath, agentId: "*" })).toMatchObject({
    folders: [sharedGrant()],
  });
  expect(stored(home)).toMatchObject({ access: { folders: [] } });
  expect(await c.request({ type: "folders.remove", path: folder })).toMatchObject({
    ok: false,
    error: { code: "not_found" },
  });
  expect(await c.data({ type: "tools.set", tool: "commands", on: true })).toMatchObject({ tools: { commands: true } });
  expect(stored(home)).toMatchObject({ exec: true, access: { tools: { commands: true } } });
  await waitFor(() => c.events("access.changed").length >= 1);

  expect(await c.data({ type: "config.get" })).toEqual({
    name: "box",
    maxConcurrentTasks: 3,
    taskMaxSeconds: 14400,
    brainIdleMinutes: 3,
    brainMaxProcesses: 1,
    workspace: expect.any(String),
    managedBy: "desktop",
  });
  expect(await c.data({ type: "config.set", patch: { name: "Notebook", maxConcurrentTasks: 5 } })).toMatchObject({
    name: "Notebook",
    maxConcurrentTasks: 5,
  });
  expect(await c.request({ type: "config.set", patch: { maxConcurrentTasks: 0 } })).toMatchObject({
    ok: false,
    error: { code: "bad_request" },
  });
  expect(stored(home)).toMatchObject({ name: "Notebook", maxConcurrentTasks: 5, token: TOKEN });

  const diag = await c.data<{ text: string }>({ type: "diagnostics" });
  expect(diag.text).toContain(`agentes runner ${RUNNER_VERSION}`);
  expect(diag.text).not.toContain(TOKEN);
});

test("device pairing from the app: code, confirmation, a desktop home with safe defaults; unpair forgets the token", async () => {
  const home = tempDir("home-");
  const base = tempDir("agentes-");
  dirs.push(home, base);
  const answers = [
    { error: "authorization_pending" },
    { token: TOKEN, machineId: "m9", name: "Notebook", org: { id: "o1", name: "Acme Ltda" } },
  ];
  const fetch: FetchFn = async (url) => {
    if (url.endsWith("/api/machines/device")) {
      return Response.json({
        deviceCode: "dc",
        userCode: "K7Q4ZP",
        verificationUrl: "https://agentes.test/conectar?code=K7Q4ZP",
        expiresIn: 600,
        interval: 3,
      });
    }
    const next = answers.shift();
    return Response.json(next, { status: next && "token" in next ? 200 : 400 });
  };
  const c = control(home, { fetch, pairSleep: async () => {}, workspaceBase: base });
  expect(
    await c.data({ type: "pair.start", server: "https://agentes.test/", name: "Notebook", tools: { claude: true } }),
  ).toEqual({
    started: true,
  });
  await waitFor(() => c.events("pair.done").length === 1);
  expect(c.events("pair.code")[0]).toMatchObject({
    userCode: "K7Q4ZP",
    verificationUrl: "https://agentes.test/conectar?code=K7Q4ZP",
  });
  expect(c.events("pair.done")[0]).toEqual({
    kind: "pair.done",
    org: { id: "o1", name: "Acme Ltda" },
    machine: { id: "m9", name: "Notebook" },
  });
  const config = readStoredConfig(home);
  expect(config).toMatchObject({
    managedBy: "desktop",
    server: "https://agentes.test",
    machineId: "m9",
    token: TOKEN,
    orgId: "o1",
    orgName: "Acme Ltda",
    exec: false,
    workspace: path.join(base, "acme-ltda"),
    access: { folders: [], tools: { claude: true, codex: false, commands: false } },
  });
  // The token never crosses the channel.
  expect(JSON.stringify(c.out)).not.toContain(TOKEN);
  expect(await c.request({ type: "pair.start", server: "https://agentes.test" })).toMatchObject({
    ok: false,
    error: { code: "already_paired" },
  });
  expect(await c.data({ type: "unpair" })).toEqual({ unpaired: true });
  expect(readStoredConfig(home)).toMatchObject({ managedBy: "desktop", workspace: path.join(base, "acme-ltda") });
  expect(readStoredConfig(home)?.token).toBeUndefined();
  expect(await c.data({ type: "status" })).toMatchObject({ paired: false, connection: "unpaired" });
});

test("reconnect after the server refused this Mac: pair.start sends the previous machine id; folders stay", async () => {
  const folder = tempDir("notes-");
  dirs.push(folder);
  const { home, ws } = pairedHome({
    access: { folders: [{ path: folder, agents: [] }], tools: { claude: true, codex: false, commands: false } },
  });
  const bodies: Record<string, unknown>[] = [];
  const NEW_TOKEN = "agm_new_machine_token_never_shown_9876";
  const fetch: FetchFn = async (url, init) => {
    if (url.endsWith("/api/machines/device")) {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Response.json({ deviceCode: "dc", userCode: "K7Q4ZP", verificationUrl: "x", expiresIn: 600, interval: 3 });
    }
    if (url.endsWith("/api/machines/device/token")) {
      return Response.json({ token: NEW_TOKEN, machineId: "m1", name: "box", org: { id: "o1", name: "Acme" } });
    }
    return new Response(null, { status: 404 });
  };
  const c = control(home, { fetch, pairSleep: async () => {} });
  // Still connected: no pairing on top of it.
  const first = await c.connect();
  expect(await c.request({ type: "pair.start", server: "https://agentes.test" })).toMatchObject({
    ok: false,
    error: { code: "already_paired" },
  });
  first.frame({ type: "refused", reason: "revoked", message: "This computer was removed from the organization." });
  await waitFor(() => c.events("status").some((e) => e.kind === "status" && e.status.connection === "refused"));

  expect(await c.data({ type: "pair.start", server: "https://agentes.test" })).toEqual({ started: true });
  await waitFor(() => c.events("pair.done").length === 1);
  // The old token goes along as the proof that this is that computer.
  expect(bodies[0]).toMatchObject({ previousMachineId: "m1", previousToken: TOKEN });
  expect(readStoredConfig(home)?.previousToken).toBeUndefined();
  expect(readStoredConfig(home)).toMatchObject({
    machineId: "m1",
    token: NEW_TOKEN,
    workspace: ws,
    access: { folders: [{ path: folder, agents: [] }], tools: { claude: true } },
  });
  // The new token connects again.
  await waitFor(() => c.sockets.length === 2);
  const second = await c.connect();
  expect(second).not.toBe(first);
  expect(second.of("hello")[0]).toMatchObject({ token: NEW_TOKEN });
});

test("unpair keeps the machine id, so pairing again with the same server asks to come back as it", async () => {
  const { home } = pairedHome();
  const bodies: Record<string, unknown>[] = [];
  const fetch: FetchFn = async (url, init) => {
    if (url.endsWith("/api/machines/device")) {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Response.json({ deviceCode: "dc", userCode: "K7Q4ZP", verificationUrl: "x", expiresIn: 600, interval: 3 });
    }
    return Response.json({ error: "authorization_pending" }, { status: 400 });
  };
  const c = control(home, { fetch, pairSleep: async () => new Promise((r) => setTimeout(r, 5)) });
  await c.connect();
  await c.data({ type: "unpair" });
  expect(readStoredConfig(home)).toMatchObject({ machineId: "m1", server: "https://agentes.test" });
  expect(readStoredConfig(home)?.token).toBeUndefined();
  // Kept only as the proof for coming back as that machine; nothing connects with it.
  expect(readStoredConfig(home)?.previousToken).toBe(TOKEN);
  expect(await c.data({ type: "status" })).toMatchObject({ paired: false, connection: "unpaired" });
  await c.data({ type: "pair.start", server: "https://agentes.test" });
  await waitFor(() => bodies.length === 1);
  expect(bodies[0]).toMatchObject({ previousMachineId: "m1", previousToken: TOKEN });
  await c.data({ type: "pair.cancel" });
  // Another server: a new computer there.
  await c.data({ type: "pair.start", server: "https://other.test" });
  await waitFor(() => bodies.length === 2);
  expect(bodies[1]?.previousMachineId).toBeUndefined();
  expect(bodies[1]?.previousToken).toBeUndefined();
  await c.data({ type: "pair.cancel" });
});

test("device pairing refused on the site: pair.failed with `denied`; cancel stops a pairing in progress", async () => {
  const home = tempDir("home-");
  dirs.push(home);
  let denied = true;
  const fetch: FetchFn = async (url) => {
    if (url.endsWith("/api/machines/device")) {
      return Response.json({ deviceCode: "dc", userCode: "ABC234", verificationUrl: "x", expiresIn: 600, interval: 3 });
    }
    return Response.json({ error: denied ? "access_denied" : "authorization_pending" }, { status: 400 });
  };
  const c = control(home, { fetch, pairSleep: async () => new Promise((r) => setTimeout(r, 5)) });
  await c.data({ type: "pair.start", server: "https://agentes.test" });
  await waitFor(() => c.events("pair.failed").length === 1);
  expect(c.events("pair.failed")[0]).toMatchObject({ code: "denied" });
  denied = false;
  await c.data({ type: "pair.start", server: "https://agentes.test" });
  await waitFor(() => c.events("pair.code").length === 2);
  expect(await c.data({ type: "pair.cancel" })).toEqual({ canceled: true });
  expect(await c.data({ type: "pair.cancel" })).toEqual({ canceled: false });
  expect(readStoredConfig(home)).toBeNull();
});

test("pairing from a connect link: the link goes with the device; a used one fails as link_invalid", async () => {
  const home = tempDir("home-");
  const base = tempDir("agentes-");
  dirs.push(home, base);
  const bodies: Record<string, unknown>[] = [];
  let used = false;
  const fetch: FetchFn = async (url, init) => {
    if (url.endsWith("/api/machines/device")) {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      if (used) return Response.json({ error: { code: "machine.link_invalid", message: "Used" } }, { status: 400 });
      return Response.json({
        deviceCode: "dc",
        userCode: "K7Q4ZP",
        verificationUrl: "x",
        expiresIn: 600,
        interval: 3,
        maker: { name: "Sam Rivera" },
      });
    }
    return Response.json({ token: TOKEN, machineId: "m7", name: "box", org: { id: "o1", name: "Acme" } });
  };
  const c = control(home, { fetch, pairSleep: async () => {}, workspaceBase: base });
  for (const link of ["no spaces", 42, ""])
    expect(await c.request({ type: "pair.start", server: "https://agentes.test", link })).toMatchObject({
      ok: false,
      error: { code: "bad_request" },
    });
  expect(bodies).toEqual([]);
  used = true;
  await c.data({ type: "pair.start", server: "https://agentes.test", link: "OLD1-CODE" });
  await waitFor(() => c.events("pair.failed").length === 1);
  expect(c.events("pair.failed")[0]).toMatchObject({ code: "link_invalid", message: "Used" });
  used = false;
  expect(await c.data({ type: "pair.start", server: "https://agentes.test", link: "ABCD-EFGH" })).toEqual({
    started: true,
  });
  await waitFor(() => c.events("pair.done").length === 1);
  expect(bodies.map((b) => b.link)).toEqual(["OLD1-CODE", "ABCD-EFGH"]);
  expect(c.events("pair.done")[0]).toMatchObject({ org: { id: "o1", name: "Acme" }, machine: { id: "m7" } });
  expect(readStoredConfig(home)).toMatchObject({ machineId: "m7", orgId: "o1", managedBy: "desktop" });
});

test("a second runner on the same home answers every request with the reason, then exits", async () => {
  const home = tempDir("home-");
  dirs.push(home);
  const c = control(home, {}, { pid: 4242, mode: "app", startedAt: "" });
  const r = await c.request({ type: "status" });
  expect(r).toMatchObject({ ok: false, error: { code: "internal" } });
  expect(!r.ok && r.error.message).toContain("pid 4242");
  c.input.end();
  expect(await c.done).toBe(EXIT_LOCKED);
});

test("an edit of config.json from a terminal reaches the app and the server", async () => {
  const { home, ws } = pairedHome();
  const folder = tempDir("proj-");
  dirs.push(folder);
  const c = control(home, { watch: true });
  const s = await c.connect();
  await new Promise((r) => setTimeout(r, 50));
  writeConfig(
    {
      ...(readStoredConfig(home) as StoredConfig),
      workspace: ws,
      access: {
        folders: [{ path: folder, agents: [AGENT.id] }],
        tools: { claude: true, codex: false, commands: false },
      },
    },
    home,
  );
  await waitFor(() => c.events("access.changed").length === 1, 5000);
  expect(s.of("access.changed")).toHaveLength(1);
  expect((await c.data<{ access: { tools: { claude: boolean } } }>({ type: "status" })).access.tools.claude).toBe(true);
}, 10_000);

test("the org logo: fetched after welcome, cached by ETag, a data URL for the app, gone on 404", async () => {
  const { home } = pairedHome();
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const calls: { url: string; headers: Headers }[] = [];
  let answer: () => Response = () => new Response(png, { headers: { "content-type": "image/png", etag: '"a1.png"' } });
  const fetch: FetchFn = async (url, init) => {
    calls.push({ url, headers: new Headers(init.headers) });
    return answer();
  };
  const c = control(home, { fetch });
  const s = await c.connect();
  const logoEtag = () => c.events("status").map((e) => (e.kind === "status" ? e.status.org?.logoEtag : undefined));
  await waitFor(() => logoEtag().includes('"a1.png"'));
  expect(calls[0]?.url).toBe("https://agentes.test/api/machines/org-logo");
  expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  expect(calls[0]?.headers.get("if-none-match")).toBeNull();
  const dataUrl = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
  expect(await c.data({ type: "org.logo" })).toEqual({ logo: dataUrl });
  expect(JSON.parse(readFileSync(orgLogoPath(home), "utf8"))).toEqual({
    etag: '"a1.png"',
    contentType: "image/png",
    base64: Buffer.from(png).toString("base64"),
  });
  // The token never crosses the channel.
  expect(JSON.stringify(c.out)).not.toContain(TOKEN);

  // Next connection: the cached ETag; 304 keeps it.
  answer = () => new Response(null, { status: 304 });
  const welcome = () => s.frame({ type: "welcome", machineId: "m1", name: "box", heartbeatMs: 25_000 });
  welcome();
  await waitFor(() => calls.length === 2);
  expect(calls[1]?.headers.get("if-none-match")).toBe('"a1.png"');
  await new Promise((r) => setTimeout(r, 20));
  expect(await c.data({ type: "org.logo" })).toEqual({ logo: dataUrl });

  // Too big or not an image the app draws: not kept.
  answer = () =>
    new Response(new Uint8Array(ORG_LOGO_MAX_BYTES + 1), { headers: { "content-type": "image/png", etag: '"b.png"' } });
  welcome();
  await waitFor(() => calls.length === 3);
  await waitFor(() => !existsSync(orgLogoPath(home)));
  await new Promise((r) => setTimeout(r, 20));
  expect(await c.data({ type: "org.logo" })).toEqual({ logo: null });
  answer = () => new Response("<svg/>", { headers: { "content-type": "image/svg+xml", etag: '"c.svg"' } });
  welcome();
  await waitFor(() => calls.length === 4);
  await new Promise((r) => setTimeout(r, 20));
  expect(await c.data({ type: "org.logo" })).toEqual({ logo: null });

  // Back, then removed on the site (404).
  answer = () => new Response(png, { headers: { "content-type": "image/png", etag: '"a1.png"' } });
  welcome();
  await waitFor(() => existsSync(orgLogoPath(home)));
  await new Promise((r) => setTimeout(r, 20));
  answer = () => new Response(null, { status: 404 });
  welcome();
  await waitFor(() => !existsSync(orgLogoPath(home)));
  await new Promise((r) => setTimeout(r, 20));
  const status = await c.data<{ org: { logoEtag?: string } }>({ type: "status" });
  expect(status.org.logoEtag).toBeUndefined();
  expect(await c.data({ type: "org.logo" })).toEqual({ logo: null });
});

test("the org logo cached by an earlier run is offered at once, and unpair removes it", async () => {
  const { home } = pairedHome();
  writeFileSync(orgLogoPath(home), JSON.stringify({ etag: '"x.webp"', contentType: "image/webp", base64: "UklGRg==" }));
  const c = control(home, { fetch: async () => new Response(null, { status: 304 }) });
  expect(await c.data({ type: "status" })).toMatchObject({ org: { id: "o1", name: "Acme", logoEtag: '"x.webp"' } });
  expect(await c.data({ type: "org.logo" })).toEqual({ logo: "data:image/webp;base64,UklGRg==" });
  await c.data({ type: "unpair" });
  expect(existsSync(orgLogoPath(home))).toBe(false);
  expect(await c.data({ type: "org.logo" })).toEqual({ logo: null });
});

test.if(process.platform !== "win32")(
  "accounts (ADR 0041): hello lists them; the app lists, signs in here (a fresh id) and removes",
  async () => {
    const { home } = pairedHome();
    const fakeCli = [process.execPath, path.join(import.meta.dir, "fake-account-cli.mjs")];
    // An account signed in earlier.
    const existing = "0193ffff-0000-7000-8000-000000000003";
    const dir = path.join(home, "accounts", "codex", existing);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "signed-in"), "");
    const c = control(home, { accountCommands: { claude_code: fakeCli, codex: fakeCli } });
    // Connects once the first look is done, so `hello` lists what it found whatever the CLIs' speed.
    // Every agent there is the runner's own user: the account thinks for all of them.
    expect(await c.data({ type: "accounts.list" })).toEqual({
      accounts: [{ id: existing, kind: "codex", loggedIn: true, shared: true, authMethod: "cli_login" }],
    });
    const s = await c.connect();
    expect(s.of("hello")[0]?.accounts).toMatchObject([{ id: existing, kind: "codex", loggedIn: true }]);

    const begun = await c.data<{ loginId: string; url: string; userCode?: string }>({
      type: "account.begin",
      kind: "codex",
    });
    expect(begun.loginId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(begun).toMatchObject({ url: "https://auth.openai.com/codex/device", userCode: "7HYC-J6JGM" });
    let state = "waiting";
    for (let i = 0; i < 100 && state === "waiting"; i++) {
      const st = await c.data<{ state: string }>({ type: "account.status", loginId: begun.loginId });
      state = st.state;
      if (state === "waiting") await new Promise((r) => setTimeout(r, 50));
    }
    expect(state).toBe("done");
    const listed = await c.data<{ accounts: { id: string }[] }>({ type: "accounts.list" });
    expect(listed.accounts.map((a) => a.id).sort()).toEqual([existing, begun.loginId].sort());

    expect(await c.data({ type: "account.remove", kind: "codex", accountId: existing })).toEqual({ removed: true });
    expect(existsSync(dir)).toBe(false);
    expect(await c.request({ type: "account.begin", kind: "vim" })).toMatchObject({
      ok: false,
      error: { code: "bad_request" },
    });
    expect(await c.request({ type: "account.status", loginId: "../x" })).toMatchObject({
      ok: false,
      error: { code: "bad_request" },
    });
    expect(await c.request({ type: "account.remove", kind: "codex", accountId: "../x" })).toMatchObject({
      ok: false,
      error: { code: "bad_request" },
    });
  },
  20_000,
);

test.if(process.platform !== "win32")(
  "accounts: a first look that ends after hello went out, before welcome, reaches the server on welcome",
  async () => {
    const { home } = pairedHome();
    const existing = "0193ffff-0000-7000-8000-000000000003";
    const dir = path.join(home, "accounts", "codex", existing);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "signed-in"), "");
    // The CLIs answer once `gate` exists: the first look is still going when hello goes out.
    const gate = path.join(home, "gate");
    const fakeCli = [
      "/bin/sh",
      "-c",
      'while [ ! -e "$0" ]; do sleep 0.01; done; exec "$@"',
      gate,
      process.execPath,
      path.join(import.meta.dir, "fake-account-cli.mjs"),
    ];
    const found = [{ id: existing, kind: "codex", loggedIn: true, shared: true, authMethod: "cli_login" }];
    const c = control(home, { accountCommands: { claude_code: fakeCli, codex: fakeCli } });
    await waitFor(() => c.sockets.length === 1);
    const s = c.sockets[0] as FakeSocket;
    s.handlers.onOpen();
    await waitFor(() => s.of("hello").length === 1);
    expect(s.of("hello")[0]?.accounts).toBeUndefined();
    // It ends before the server's welcome, while nothing can reach the server yet.
    writeFileSync(gate, "");
    expect(await c.data({ type: "accounts.list" })).toEqual({ accounts: found });
    s.frame({ type: "welcome", machineId: "m1", name: "box", heartbeatMs: 25_000 });
    await waitFor(() => s.of("accounts.changed").length > 0);
    expect(s.of("accounts.changed")).toMatchObject([{ accounts: found }]);

    // A hello that already lists them: welcome adds nothing.
    expect(await c.data({ type: "reconnect" })).toEqual({ reconnecting: true });
    await waitFor(() => c.sockets.length === 2);
    const again = await c.connect();
    expect(again.of("hello")[0]?.accounts).toMatchObject(found);
    expect(again.of("accounts.changed")).toEqual([]);
  },
  20_000,
);

import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { AgentScope, MachineRequest, RunnerFrame, ServerFrame } from "@agenteschat/adapters/machine-protocol";
import { sealSecret, secretAad, vaultAad } from "@agenteschat/adapters/secret-box";
import { AccountBrains, type AccountBrainsOptions, SHARED_LOGIN_OFF } from "../../runner/account-brains";
import { AccountManager } from "../../runner/accounts";
import { AGENT_USERS_FILE, type AgentUser, systemLauncher } from "../../runner/agent-users";
import { BrainManager, PERSONAL_MCP_REFUSED } from "../../runner/brain";
import { BrowserManager } from "../../runner/browser";
import { type StoredConfig, writeConfig } from "../../runner/config";
import type { Dial, Socket, SocketHandlers } from "../../runner/connection";
import { RunnerDaemon } from "../../runner/daemon";
import { DesktopSessions } from "../../runner/desktop-session";
import { RunnerError } from "../../runner/errors";
import { type HandlerContext, handleRequest, type RequestScope } from "../../runner/handlers";
import { readLines } from "../../runner/lines";
import { runMcpRelay } from "../../runner/mcp";
import { AgentNetworks } from "../../runner/network-state";
import type { FetchLike } from "../../runner/push";
import { agentSecrets, secretValue } from "../../runner/secrets";
import { RelayCount } from "../../runner/streams";
import {
  BROWSER_LEASE_MS,
  retireLegacyPending,
  Supervisor,
  type SupervisorOptions,
  WORKER_TASKS_FILE,
  type WorkerDesktop,
  type WorkerProcess,
  type WorkerState,
  workerCommand,
  workerHome,
} from "../../runner/supervisor";
import { runWorker, WorkerLink } from "../../runner/worker";
import { errorCode, removeDirs, tempDir, waitFor } from "./helpers";

const dirs: string[] = [];
const supervisors: Supervisor[] = [];
const workerRuns: Promise<number>[] = [];
afterEach(async () => {
  for (const s of supervisors.splice(0)) await s.close(2000);
  await Promise.all(workerRuns.splice(0));
  removeDirs(dirs);
});

const posix = process.platform !== "win32";
const ANA = { id: "a1b2c3d4-0000-4000-8000-000000000001", handle: "ana", name: "Ana" };
const BIA = { id: "b2c3d4e5-0000-4000-8000-000000000002", handle: "bia", name: "Bia" };
const USERS: AgentUser[] = [
  { id: ANA.id, user: "ag-a1b2c3d4", uid: 21000 },
  { id: BIA.id, user: "ag-b2c3d4e5", uid: 21001 },
];
const userOf = (agent: { id: string }) => {
  const u = USERS.find((x) => x.id === agent.id);
  if (!u) throw new RunnerError("bad_request", "No such agent");
  return u;
};

const STATE: WorkerState = {
  access: {
    folders: [
      { path: "/srv/ana", agents: [ANA.id] },
      { path: "/srv/shared", agents: [ANA.id, BIA.id] },
      { path: "/srv/agentes/shared", agents: ["*"] },
    ],
    tools: { claude: true, codex: false, commands: true, browser: true },
  },
  paused: { paused: false },
  limits: { maxConcurrentTasks: 3, taskMaxSeconds: 3600, brainIdleMinutes: 10, brainMaxProcesses: 3 },
};

const HELLO = {
  type: "hello",
  token: "",
  version: "0.10.0",
  protocol: 17,
  os: "linux",
  arch: "x64",
  hostname: "box",
  workspace: "/home/ag",
  exec: true,
};

type Got = Record<string, unknown> & { id: string };

/** A worker over in-memory pipes: what the supervisor sends lands in `got`; `send` answers as the worker would. */
class FakeWorker implements WorkerProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly got: Record<string, unknown>[] = [];
  killed = false;
  readonly exited: Promise<unknown>;
  private exit: (code: unknown) => void = () => {};

  constructor(readonly user: AgentUser) {
    this.exited = new Promise((resolve) => {
      this.exit = resolve;
    });
    readLines(
      this.stdin,
      1 << 26,
      (line) => this.got.push(JSON.parse(line) as Record<string, unknown>),
      () => {},
    );
    // Like a real worker: its stdin closing ends it.
    this.stdin.on("end", () => this.exit(0));
  }

  send(frame: Record<string, unknown>) {
    this.stdout.write(`${JSON.stringify(frame)}\n`);
  }

  hello() {
    this.send(HELLO);
  }

  of(type: string) {
    return this.got.filter((f) => f.type === type);
  }

  kill() {
    this.killed = true;
    this.exit(null);
  }

  /** It exits on its own. */
  crash(code = 1) {
    this.exit(code);
  }
}

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

function newHome() {
  const home = tempDir("supervisor-");
  dirs.push(home);
  writeFileSync(path.join(home, AGENT_USERS_FILE), JSON.stringify(USERS));
  return home;
}

function setup(over: Partial<SupervisorOptions> = {}, home = newHome()) {
  const workers: FakeWorker[] = [];
  const up: Record<string, unknown>[] = [];
  const logs: string[] = [];
  let state = STATE;
  const sup = new Supervisor({
    home,
    user: userOf,
    start: (user) => {
      const w = new FakeWorker(user);
      workers.push(w);
      return w;
    },
    token: "agm_machine",
    server: "https://agentes.test",
    send: (frame) => {
      up.push(frame as unknown as Record<string, unknown>);
      return true;
    },
    state: () => state,
    log: (line) => logs.push(line),
    ...over,
  });
  supervisors.push(sup);
  const ctx: HandlerContext = {
    workspaceReal: home,
    exec: true,
    token: "agm_machine",
    systemMode: () => true,
    workers: sup,
    accounts: { list: async () => [] } as unknown as AccountManager,
    accessOps: {
      request: async (_agent, req) => ({ requestId: req.requestId, status: "pending" }),
      reduce: async () => ({ access: STATE.access }),
    },
  };
  const of = (agentId: string) => workers.filter((w) => w.user.id === agentId);
  const last = (agentId: string) => of(agentId).at(-1) as FakeWorker;
  return { home, sup, ctx, workers, up, logs, of, last, setState: (s: WorkerState) => (state = s) };
}

function scope() {
  const ac = new AbortController();
  const output: { stream: string; chunk: string }[] = [];
  const emitted: RunnerFrame[] = [];
  const s: RequestScope = {
    signal: ac.signal,
    output: (stream, chunk) => output.push({ stream, chunk }),
    emit: (frame) => emitted.push(frame),
  };
  return { ac, output, emitted, scope: s };
}

/** The n-th request a worker got. */
async function requestOn(w: FakeWorker, n = 1): Promise<Got> {
  await waitFor(() => w.of("request").length >= n);
  return w.of("request")[n - 1] as Got;
}

const exec = (agent: typeof ANA, command = "id -un"): Extract<MachineRequest, { op: "exec" }> => ({
  op: "exec",
  command,
  timeoutSeconds: 10,
  stream: true,
  agent,
});
const execDone = { exitCode: 0, stdout: "", stderr: "", timedOut: false };
const taskStart = (agent: typeof ANA, taskId: string) =>
  ({ op: "task.start", taskId, executor: "shell", command: "sleep 1", agent }) as MachineRequest;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const browserOpen = (
  agent: typeof ANA,
  desktop: boolean,
  command = "open",
  args = ["https://shop.example/cart"],
): Extract<MachineRequest, { op: "browser.act" }> => ({
  op: "browser.act",
  command,
  args,
  timeoutSeconds: 30,
  agent,
  ...(desktop ? { desktop } : {}),
});
const BROWSER_REFUSED = "No browser command of this agent on its desktop is running";

test("system boot guards ports and prepares every persisted UID before restoring a worker", () => {
  const home = newHome();
  writeFileSync(
    path.join(home, WORKER_TASKS_FILE),
    JSON.stringify({
      "task-ana-0001": { agentId: ANA.id, startedAt: new Date().toISOString() },
    }),
  );
  const order: string[] = [];
  const t = setup(
    {
      guard: { start: () => order.push("guard"), stop: () => {} },
      prepareExisting: (users) => {
        expect(users.map((u) => u.uid)).toEqual([21000, 21001]);
        order.push("policy");
      },
      start: (user) => {
        order.push("worker");
        return new FakeWorker(user);
      },
    },
    home,
  );
  t.sup.boot();
  expect(order).toEqual(["guard", "policy", "worker"]);
});

test("a worker that can't start fails what waits for it at once, saying why; another agent's still serves", async () => {
  const why =
    "Agent 21000's isolation doesn't hold in agents-21000.slice: An agent's bind(0) failed on 127.0.0.1: EPERM";
  const t = setup({
    start: (user) => {
      if (user.uid === 21000) throw new Error(why);
      const w = new FakeWorker(user);
      t.workers.push(w);
      return w;
    },
  });
  t.sup.boot();
  t.sup.attach();
  const started = Date.now();
  const failed = await handleRequest(t.ctx, exec(ANA), scope().scope).catch((err: unknown) => err);
  expect(failed).toBeInstanceOf(RunnerError);
  expect([(failed as RunnerError).code, (failed as RunnerError).message]).toEqual([
    "internal",
    `The agent's worker couldn't start on this computer: ${why}`,
  ]);
  // Not the start's timeout (20 s).
  expect(Date.now() - started).toBeLessThan(5000);
  expect(t.logs).toContain(`couldn't start the worker of ag-a1b2c3d4: ${why}`);
  const read = handleRequest(t.ctx, { op: "read", path: "notes.md", maxBytes: 100, agent: BIA }, scope().scope);
  await waitFor(() => t.workers.length === 1);
  const bia = t.last(BIA.id);
  bia.hello();
  const req = await requestOn(bia);
  bia.send({ type: "result", id: req.id, ok: true, data: { content: "hi" } });
  expect(await read).toEqual({ content: "hi" });
});

test("the computer's own ops stay in the supervisor; an agent's go to its worker, started on its first request", async () => {
  const t = setup();
  t.sup.boot();
  t.sup.attach();
  // No task to watch: no worker at boot.
  expect(t.workers).toHaveLength(0);
  const s = scope();
  expect(await handleRequest(t.ctx, { op: "account", action: "list" } as MachineRequest, s.scope)).toEqual({
    accounts: [],
  });
  const ask = { op: "access.request", requestId: "req-00000001", path: "/srv/x", reason: "data", agent: ANA } as const;
  expect(await handleRequest(t.ctx, ask, s.scope)).toEqual({ requestId: "req-00000001", status: "pending" });
  expect(t.workers).toHaveLength(0);

  const run = handleRequest(t.ctx, exec(ANA), s.scope);
  await waitFor(() => t.workers.length === 1);
  const ana = t.last(ANA.id);
  expect(ana.user).toEqual(USERS[0] as AgentUser);
  ana.hello();
  const req = await requestOn(ana);
  // Its state (only its own folders) and the welcome come first; the request has the supervisor's own id.
  expect(ana.got.map((f) => f.type)).toEqual(["worker.state", "welcome", "request"]);
  expect(ana.got[0]).toEqual({ type: "worker.state", ...STATE });
  expect(req).toEqual({ ...exec(ANA), type: "request", id: req.id });
  ana.send({ type: "output", id: req.id, stream: "stdout", chunk: "ag-a1b2c3d4\n" });
  ana.send({ type: "result", id: req.id, ok: true, data: { ...execDone, stdout: "ag-a1b2c3d4\n" } });
  expect(await run).toEqual({ ...execDone, stdout: "ag-a1b2c3d4\n" });
  expect(s.output).toEqual([{ stream: "stdout", chunk: "ag-a1b2c3d4\n" }]);

  // Bia's first request starts Bia's worker; Ana's sees nothing of it.
  const read = handleRequest(t.ctx, { op: "read", path: "notes.md", maxBytes: 100, agent: BIA }, scope().scope);
  await waitFor(() => t.workers.length === 2);
  const bia = t.last(BIA.id);
  bia.hello();
  const r2 = await requestOn(bia);
  // The computer's shared folder (granted to every agent) reaches every worker.
  expect((bia.got[0] as unknown as WorkerState).access.folders).toEqual([
    { path: "/srv/shared", agents: [ANA.id, BIA.id] },
    { path: "/srv/agentes/shared", agents: ["*"] },
  ]);
  bia.send({ type: "result", id: r2.id, ok: false, error: { code: "not_found", message: "No such file" } });
  expect(await errorCode(() => read)).toBe("not_found");
  expect(ana.of("request")).toHaveLength(1);

  // The same worker serves the agent's next requests.
  const next = handleRequest(t.ctx, exec(ANA, "pwd"), scope().scope);
  const r3 = await requestOn(ana, 2);
  ana.send({ type: "result", id: r3.id, ok: true, data: execDone });
  await next;
  expect(t.workers).toHaveLength(2);

  // A request without its agent, or an op this runner doesn't know, goes nowhere.
  const anonymous = { op: "exec", command: "id", timeoutSeconds: 1, stream: false } as MachineRequest;
  expect(await errorCode(() => handleRequest(t.ctx, anonymous, scope().scope))).toBe("bad_request");
  const unknown = { op: "make.coffee", agent: ANA } as unknown as MachineRequest;
  expect(await errorCode(() => handleRequest(t.ctx, unknown, scope().scope))).toBe("bad_request");
  expect(t.workers).toHaveLength(2);
  expect(ana.of("request")).toHaveLength(2);
});

test("a brain turn's account goes to its agent's user before the turn reaches the worker; root marks what it refused", async () => {
  const lends: [string, string, number][] = [];
  const refused: string[] = [];
  const t = setup({
    lend: async (kind, id, uid) => {
      lends.push([kind, id, uid]);
    },
  });
  t.ctx.accounts = {
    refused: async (_kind: string, id: string) => {
      refused.push(id);
    },
    invalidate: () => {},
    refresh: async () => [],
  } as unknown as AccountManager;
  t.sup.boot();
  t.sup.attach();
  const ACCOUNT = "0193ffff-0000-7000-8000-000000000001";
  const turn = (account?: string) =>
    ({
      op: "brain.turn",
      kind: "claude_code",
      runId: "run-00000001",
      session: { id: "0193aaaa-0000-7000-8000-000000000001", resume: false },
      prompt: "hi",
      ...(account ? { account } : {}),
      agent: BIA,
    }) as MachineRequest;
  const run = handleRequest(t.ctx, turn(ACCOUNT), scope().scope);
  await waitFor(() => t.workers.length === 1);
  expect(lends).toEqual([["claude_code", ACCOUNT, 21001]]);
  const bia = t.last(BIA.id);
  bia.hello();
  const q = await requestOn(bia);
  const final = { type: "error", code: "not_logged_in", message: "Invalid API key", retryable: true };
  bia.send({ type: "result", id: q.id, ok: true, data: { runId: "run-00000001", final } });
  expect(await run).toEqual({ runId: "run-00000001", final });
  await waitFor(() => refused.length === 1);
  expect(refused).toEqual([ACCOUNT]);
  // Without an account nothing is lent.
  const plain = handleRequest(t.ctx, turn(), scope().scope);
  const q2 = await requestOn(bia, 2);
  bia.send({
    type: "result",
    id: q2.id,
    ok: true,
    data: { runId: "run-00000001", final: { type: "done", text: "ok" } },
  });
  await plain;
  expect(lends).toHaveLength(1);
});

test("a Cursor turn's account is lent as a Cursor account, never as Claude's", async () => {
  const lends: [string, string, number][] = [];
  const t = setup({
    lend: async (kind, id, uid) => {
      lends.push([kind, id, uid]);
    },
  });
  t.sup.boot();
  t.sup.attach();
  const ACCOUNT = "0193ffff-0000-7000-8000-000000000009";
  const run = handleRequest(
    t.ctx,
    {
      op: "brain.turn",
      kind: "cursor",
      runId: "run-00000009",
      session: { id: "0193aaaa-0000-7000-8000-000000000009", resume: false },
      prompt: "hi",
      account: ACCOUNT,
      agent: BIA,
    } as MachineRequest,
    scope().scope,
  );
  await waitFor(() => t.workers.length === 1);
  expect(lends).toEqual([["cursor", ACCOUNT, 21001]]);
  const bia = t.last(BIA.id);
  bia.hello();
  const q = await requestOn(bia);
  const final = { type: "done", text: "ok" };
  bia.send({ type: "result", id: q.id, ok: true, data: { runId: "run-00000009", final } });
  expect(await run).toEqual({ runId: "run-00000009", final });
});

test("an OpenCode turn's account is lent as an OpenCode account, never as Claude's", async () => {
  const lends: [string, string, number][] = [];
  const t = setup({
    lend: async (kind, id, uid) => {
      lends.push([kind, id, uid]);
    },
  });
  t.sup.boot();
  t.sup.attach();
  const ACCOUNT = "0193ffff-0000-7000-8000-00000000000a";
  const run = handleRequest(
    t.ctx,
    {
      op: "brain.turn",
      kind: "opencode",
      runId: "run-0000000a",
      session: { id: "0193aaaa-0000-7000-8000-00000000000a", resume: false },
      prompt: "hi",
      account: ACCOUNT,
      agent: BIA,
    } as MachineRequest,
    scope().scope,
  );
  await waitFor(() => t.workers.length === 1);
  expect(lends).toEqual([["opencode", ACCOUNT, 21001]]);
  const bia = t.last(BIA.id);
  bia.hello();
  const q = await requestOn(bia);
  const final = { type: "done", text: "ok" };
  bia.send({ type: "result", id: q.id, ok: true, data: { runId: "run-0000000a", final } });
  expect(await run).toEqual({ runId: "run-0000000a", final });
});

test("an account root keeps goes with each turn as root's own grant, never the server's; usage only for its turn", async () => {
  const ACCOUNT = "0193ffff-0000-7000-8000-000000000001";
  const OTHER = "0193ffff-0000-7000-8000-000000000002";
  const TOKEN = "sk-ant-oat01-fake-token-for-tests-only";
  const lends: string[] = [];
  const usage: [string, string, unknown][] = [];
  const t = setup({
    grant: async (_kind, id) => (id === ACCOUNT ? { kind: "token", token: TOKEN } : null),
    lend: async (_kind, id) => {
      lends.push(id);
    },
    usage: (kind, id, info) => usage.push([kind, id, info]),
  });
  t.sup.boot();
  t.sup.attach();
  const turn = (account: string, runId: string) =>
    ({
      op: "brain.turn",
      kind: "claude_code",
      runId,
      session: { id: "0193aaaa-0000-7000-8000-000000000001", resume: false },
      prompt: "hi",
      account,
      // What the server can't give: only root hands an account over.
      grant: { kind: "token", token: "sk-ant-oat01-forged-by-the-server" },
      agent: BIA,
    }) as unknown as MachineRequest;
  const run = handleRequest(t.ctx, turn(ACCOUNT, "run-00000001"), scope().scope);
  await waitFor(() => t.workers.length === 1);
  const bia = t.last(BIA.id);
  bia.hello();
  const q = await requestOn(bia);
  expect(q.grant).toEqual({ kind: "token", token: TOKEN });
  expect(lends).toEqual([]);
  // Usage for the account its turn thinks with is taken; for another, or another kind, it isn't.
  const info = { status: "allowed", rateLimitType: "five_hour", utilization: 0.4 };
  bia.send({ type: "usage", kind: "claude_code", account: OTHER, info });
  bia.send({ type: "usage", kind: "codex", account: ACCOUNT, info });
  bia.send({ type: "usage", kind: "claude_code", account: ACCOUNT, info });
  await waitFor(() => usage.length === 1);
  expect(usage).toEqual([["claude_code", ACCOUNT, info]]);
  bia.send({
    type: "result",
    id: q.id,
    ok: true,
    data: { runId: "run-00000001", final: { type: "done", text: "ok" } },
  });
  await run;
  // Its turn is over: nothing more is taken for it.
  bia.send({ type: "usage", kind: "claude_code", account: ACCOUNT, info });
  // One made for one agent: lent, and the server's grant still never passes.
  const lent = handleRequest(t.ctx, turn(OTHER, "run-00000002"), scope().scope);
  const q2 = await requestOn(bia, 2);
  expect(q2.grant).toBeUndefined();
  expect(lends).toEqual([OTHER]);
  bia.send({
    type: "result",
    id: q2.id,
    ok: true,
    data: { runId: "run-00000002", final: { type: "done", text: "ok" } },
  });
  await lent;
  expect(usage).toHaveLength(1);
});

test("protocol 31: a Claude Code or Codex task's account goes to its agent's user as a turn's, before the task reaches the worker", async () => {
  const ACCOUNT = "0193ffff-0000-7000-8000-000000000001";
  const SHARED = "0193ffff-0000-7000-8000-000000000002";
  const TOKEN = "sk-ant-oat01-fake-token-for-tests-only";
  const lends: [string, string, number][] = [];
  const t = setup({
    grant: async (_kind, id) => (id === SHARED ? { kind: "token", token: TOKEN } : null),
    lend: async (kind, id, uid) => {
      lends.push([kind, id, uid]);
    },
  });
  t.sup.boot();
  t.sup.attach();
  let n = 0;
  /** A task start as the worker gets it, answered as started. */
  const started = async (executor: string, account?: string) => {
    const taskId = `0193aaaa-0000-7000-8000-00000000010${++n}`;
    const req = {
      op: "task.start",
      taskId,
      executor,
      ...(executor === "shell" ? { command: "true" } : { prompt: "go" }),
      ...(account ? { account } : {}),
      // What the server can't give: only root hands an account over.
      grant: { kind: "token", token: "sk-ant-oat01-forged-by-the-server" },
      agent: BIA,
    } as unknown as MachineRequest;
    const run = handleRequest(t.ctx, req, scope().scope);
    await waitFor(() => t.workers.length === 1);
    const bia = t.last(BIA.id);
    if (n === 1) bia.hello();
    const q = await requestOn(bia, n);
    const data = { taskId, pid: 42, startedAt: new Date().toISOString(), cwd: "", command: executor };
    bia.send({ type: "result", id: q.id, ok: true, data });
    await run;
    return q;
  };
  // Lent to Bia's user before her worker gets the task, as for a turn; the server's grant never passes.
  expect((await started("claude", ACCOUNT)).grant).toBeUndefined();
  expect(lends).toEqual([["claude_code", ACCOUNT, 21001]]);
  await started("codex", ACCOUNT);
  expect(lends.at(-1)).toEqual(["codex", ACCOUNT, 21001]);
  // One root keeps goes with the task as root's own grant, lent to nobody.
  expect((await started("claude", SHARED)).grant).toEqual({ kind: "token", token: TOKEN });
  // A shell task signs nothing in, whatever it carries; nor does a task with no account.
  expect((await started("shell", ACCOUNT)).grant).toBeUndefined();
  await started("claude");
  expect(lends).toHaveLength(2);
});

test("each worker hears which account its own agent thinks with, and again when that changes", async () => {
  const ACCOUNT = "0193ffff-0000-7000-8000-000000000001";
  const accounts: Record<string, string> = {};
  const t = setup({ account: (agentId) => accounts[agentId] ?? null });
  t.sup.boot();
  t.sup.attach();
  const run = handleRequest(t.ctx, exec(ANA), scope().scope);
  await waitFor(() => t.workers.length === 1);
  const ana = t.last(ANA.id);
  ana.hello();
  await requestOn(ana);
  expect(ana.of("worker.state")).toEqual([{ type: "worker.state", ...STATE, account: null }]);
  accounts[ANA.id] = ACCOUNT;
  t.sup.stateChanged();
  await waitFor(() => ana.of("worker.state").length === 2);
  expect(ana.of("worker.state")[1]).toEqual({ type: "worker.state", ...STATE, account: ACCOUNT });
  // Another agent's account is none of its business.
  accounts[BIA.id] = "0193ffff-0000-7000-8000-000000000002";
  t.sup.stateChanged();
  await new Promise((r) => setTimeout(r, 50));
  expect(ana.of("worker.state")).toHaveLength(2);
  ana.crash();
  expect(await errorCode(() => run)).toBe("dropped");
});

test("a cancel reaches only the worker that runs that request", async () => {
  const t = setup();
  t.sup.boot();
  t.sup.attach();
  const a = scope();
  const b = scope();
  const ra = handleRequest(t.ctx, exec(ANA, "sleep 100"), a.scope);
  const rb = handleRequest(t.ctx, exec(BIA, "sleep 100"), b.scope);
  await waitFor(() => t.workers.length === 2);
  for (const w of t.workers) w.hello();
  const ana = t.last(ANA.id);
  const bia = t.last(BIA.id);
  const qa = await requestOn(ana);
  const qb = await requestOn(bia);
  // The server canceled Bia's request.
  b.ac.abort();
  await waitFor(() => bia.of("cancel").length === 1);
  expect(bia.of("cancel")).toEqual([{ type: "cancel", id: qb.id }]);
  expect(ana.of("cancel")).toEqual([]);
  const canceled = { ...execDone, exitCode: null, canceled: { killed: true } };
  bia.send({ type: "result", id: qb.id, ok: true, data: canceled });
  expect(await rb).toEqual(canceled);
  ana.send({ type: "result", id: qa.id, ok: true, data: execDone });
  expect(await ra).toEqual(execDone);

  // Canceled while the agent's worker isn't up: it fails at once instead of waiting for it.
  ana.crash();
  await waitFor(() => t.logs.some((l) => l.startsWith("[ag-a1b2c3d4] stopped")));
  const c = scope();
  const pending = handleRequest(t.ctx, exec(ANA, "late"), c.scope);
  c.ac.abort();
  expect(await errorCode(() => pending)).toBe("internal");
});

test("room for a turn: root closes one idle CLI, the least recently used across workers, the waiting session's last; a silent worker doesn't hold it", async () => {
  const t = setup({ reclaimMs: 200 });
  t.sup.boot();
  t.sup.attach();
  // No worker up: nothing to close.
  expect(await t.sup.reclaimBrains()).toBe(false);
  const runs = [ANA, BIA].map((a) => handleRequest(t.ctx, exec(a, "sleep 100"), scope().scope));
  await waitFor(() => t.workers.length === 2);
  for (const w of t.workers) w.hello();
  const ana = t.last(ANA.id);
  const bia = t.last(BIA.id);
  const asks = (w: FakeWorker) => w.of("brain.reclaim");
  const answer = (w: FakeWorker, n: number, reply: Record<string, unknown>) =>
    w.send({ type: "brain.reclaimed", reclaimId: asks(w)[n]?.reclaimId, ...reply });

  // Both have one idle: only Bia's, used longer ago, closes.
  const oldest = t.sup.reclaimBrains("ana:s1");
  await waitFor(() => asks(ana).length === 1 && asks(bia).length === 1);
  expect(asks(ana)[0]).toMatchObject({ peek: true, spare: "ana:s1" });
  ana.send({ type: "brain.reclaimed", reclaimId: "nope", closed: true });
  answer(ana, 0, { closed: false, idle: { since: 200, spare: false } });
  answer(bia, 0, { closed: false, idle: { since: 100, spare: false } });
  await waitFor(() => asks(bia).length === 2);
  expect(asks(bia)[1]?.peek).toBeUndefined();
  answer(bia, 1, { closed: true });
  expect(await oldest).toBe(true);
  expect(asks(ana)).toHaveLength(1);

  // The waiting session's own goes last, even if older; Bia's became busy meanwhile, so Ana's closes.
  const spare = t.sup.reclaimBrains("ana:s1");
  await waitFor(() => asks(ana).length === 2 && asks(bia).length === 3);
  answer(ana, 1, { closed: false, idle: { since: 50, spare: true } });
  answer(bia, 2, { closed: false, idle: { since: 100, spare: false } });
  await waitFor(() => asks(bia).length === 4);
  answer(bia, 3, { closed: false });
  await waitFor(() => asks(ana).length === 3);
  answer(ana, 2, { closed: true });
  expect(await spare).toBe(true);

  // Bia's worker says nothing, Ana has none idle: none, in time.
  const silent = t.sup.reclaimBrains();
  await waitFor(() => asks(ana).length === 4);
  answer(ana, 3, { closed: false });
  expect(await silent).toBe(false);
  for (const [w, q] of [
    [ana, await requestOn(ana)],
    [bia, await requestOn(bia)],
  ] as const)
    w.send({ type: "result", id: q.id, ok: true, data: execDone });
  await Promise.all(runs);

  // The worker's end: it answers what it would close, or whether it closed one.
  const fromRoot = new PassThrough();
  const toRoot = new PassThrough();
  const link = new WorkerLink(fromRoot, toRoot);
  const said: Record<string, unknown>[] = [];
  readLines(
    toRoot,
    1 << 20,
    (line) => said.push(JSON.parse(line)),
    () => {},
  );
  const heard: unknown[] = [];
  link.onReclaim = async (ask) => {
    heard.push(ask);
    return ask.peek ? { closed: false, idle: { since: 5, spare: true } } : { closed: true };
  };
  fromRoot.write(`${JSON.stringify({ type: "brain.reclaim", reclaimId: "7", spare: "a:s", peek: true })}\n`);
  fromRoot.write(`${JSON.stringify({ type: "brain.reclaim", reclaimId: "8" })}\n`);
  await waitFor(() => said.length === 2);
  expect(heard).toEqual([{ spare: "a:s", peek: true }, { peek: false }]);
  expect(said).toEqual([
    { type: "brain.reclaimed", reclaimId: "7", closed: false, idle: { since: 5, spare: true } },
    { type: "brain.reclaimed", reclaimId: "8", closed: true },
  ]);
});

test("frames from a worker go up only when they are its agent's", async () => {
  const t = setup();
  t.sup.boot();
  t.sup.attach();
  const turn = scope();
  const brain = handleRequest(
    t.ctx,
    {
      op: "brain.turn",
      runId: "run-ana-0001",
      kind: "claude_code",
      session: { id: "sess-ana-0001", resume: false },
      cwd: "",
      agent: ANA,
    } as unknown as MachineRequest,
    turn.scope,
  );
  const start = handleRequest(t.ctx, taskStart(ANA, "task-ana-0001"), scope().scope);
  const listing = handleRequest(t.ctx, { op: "list", path: "", depth: 1, agent: BIA }, scope().scope);
  await waitFor(() => t.workers.length === 2);
  for (const w of t.workers) w.hello();
  const ana = t.last(ANA.id);
  const bia = t.last(BIA.id);
  const qTurn = await requestOn(ana, 1);
  const qStart = await requestOn(ana, 2);
  const qList = await requestOn(bia, 1);
  ana.send({
    type: "result",
    id: qStart.id,
    ok: true,
    data: { taskId: "task-ana-0001", pid: 4242, startedAt: "2026-10-24T10:00:00.000Z", cwd: "", command: "sleep 1" },
  });
  await start;

  const event = { type: "brain.event", runId: "run-ana-0001", event: { type: "text_delta", text: "Oi" } };
  const taskEvent = { type: "task.event", taskId: "task-ana-0001", kind: "line", line: "working" };
  const ended = { type: "browser.stream.ended", agentId: ANA.id, reason: "stopped" };
  // Bia's worker speaks for Ana: her turn, her task, her browser, her request's result, the computer's pause.
  bia.send(event);
  bia.send(taskEvent);
  bia.send({ type: "task.done", taskId: "task-ana-0001", exitCode: 0, seconds: 1 });
  bia.send(ended);
  bia.send({ type: "runner.state", paused: { paused: true, until: null } });
  bia.send({ type: "accounts.changed", accounts: [] });
  bia.send({
    type: "result",
    id: qTurn.id,
    ok: true,
    data: { runId: "run-ana-0001", final: { type: "done", text: "x" } },
  });
  bia.send({ type: "output", id: qTurn.id, stream: "stdout", chunk: "forged" });
  bia.send({ type: "result", id: qList.id, ok: true, data: { entries: [] } });
  expect(await listing).toEqual({ entries: [] });
  // Ana's own.
  ana.send(event);
  ana.send(taskEvent);
  ana.send(ended);
  const call = {
    type: "mcp.call",
    callId: "call-0001",
    taskId: "task-ana-0001",
    tool: "report",
    args: { summary: "x" },
  };
  ana.send({ ...call, token: "agr_ana-token-0000000000" });
  await waitFor(() => t.up.length === 3);
  expect(t.up).toEqual([taskEvent, ended, { ...call, token: "agr_ana-token-0000000000" }]);
  // Without the run's token the server would take the task id's word: refused here, nothing goes up.
  bia.send({ ...call, callId: "call-0009" });
  await waitFor(() => bia.of("mcp.result").length === 1);
  expect(bia.of("mcp.result")[0]).toMatchObject({ callId: "call-0009", ok: false, error: { code: "not_allowed" } });
  expect(t.up).toHaveLength(3);
  // A turn's events go out with its request (the server's id), and only Ana's.
  await waitFor(() => turn.emitted.length === 1);
  expect(turn.emitted).toEqual([event as RunnerFrame]);

  // The answer to a call goes back to the worker that made it; another worker can't take its call id.
  bia.send({ type: "mcp.list", callId: "call-0001", taskId: "run-bia-0001", token: "agr_bia-token-0000000000" });
  t.sup.mcp.result({ type: "mcp.result", callId: "call-0001", ok: true, text: "noted" });
  await waitFor(() => ana.of("mcp.result").length === 1);
  expect(ana.of("mcp.result")).toEqual([{ type: "mcp.result", callId: "call-0001", ok: true, text: "noted" }]);
  expect(bia.of("mcp.result").map((f) => f.callId)).toEqual(["call-0009"]);
  expect(t.up).toHaveLength(3);

  ana.send({ type: "brain.done", runId: "run-ana-0001" });
  const final = { type: "done", text: "Oi" };
  ana.send({ type: "result", id: qTurn.id, ok: true, data: { runId: "run-ana-0001", final } });
  expect(await brain).toEqual({ runId: "run-ana-0001", final });
  expect(turn.emitted).toEqual([event as RunnerFrame, { type: "brain.done", runId: "run-ana-0001" }]);
  // That turn is over: a late event of it goes nowhere.
  ana.send(event);
  await sleep(20);
  expect(turn.emitted).toHaveLength(2);
});

test("the agents' browsers' traffic: each worker's count summed until taken, between sessions too; nonsense dropped", async () => {
  const t = setup();
  t.sup.boot();
  t.sup.attach();
  const runs = [handleRequest(t.ctx, exec(ANA), scope().scope), handleRequest(t.ctx, exec(BIA), scope().scope)];
  await waitFor(() => t.workers.length === 2);
  const ana = t.last(ANA.id);
  const bia = t.last(BIA.id);
  // Before its session's hello: its Chrome may have run meanwhile.
  ana.send({ type: "browser.traffic", up: 100, down: 2000 });
  ana.hello();
  bia.hello();
  bia.send({ type: "browser.traffic", up: 5, down: 70 });
  for (const bad of [
    { up: 1e12 + 1, down: 1 },
    { up: 1, down: -1 },
    { up: 1.5, down: 1 },
    { up: "100", down: 1 },
    { up: 1 },
  ]) {
    ana.send({ type: "browser.traffic", ...bad });
  }
  // Frames are read in order: once this one counts, the ones before it were seen.
  ana.send({ type: "browser.traffic", up: 1e12, down: 0 });
  const total = { up: 0, down: 0 };
  await waitFor(() => {
    const got = t.sup.takeTraffic();
    total.up += got.up;
    total.down += got.down;
    return total.up >= 1e12;
  });
  expect(total).toEqual({ up: 1e12 + 105, down: 2070 });
  expect(t.sup.takeTraffic()).toEqual({ up: 0, down: 0 });
  // Nothing of it goes to the server: root says it on its own pong.
  expect(t.up.filter((f) => f.type === "browser.traffic")).toEqual([]);
  for (const w of [ana, bia]) {
    const req = await requestOn(w);
    w.send({ type: "result", id: req.id, ok: true, data: execDone });
  }
  await Promise.all(runs);
});

test("scope.enter: root moves only its agent's own process, into the agent's slice for its kind, and answers once it is there", async () => {
  const proc = tempDir("proc-");
  dirs.push(proc);
  /** A process as /proc shows it: its uids (real, effective, saved, filesystem) and its cgroup. */
  const pidAt = (pid: number, uids: number[], cgroup: string) => {
    mkdirSync(path.join(proc, String(pid)), { recursive: true });
    writeFileSync(
      path.join(proc, String(pid), "status"),
      `Name:\tchrome\nUid:\t${uids.join("\t")}\nGid:\t1\t1\t1\t1\n`,
    );
    writeFileSync(path.join(proc, String(pid), "cgroup"), `0::${cgroup}\n`);
  };
  const asked: string[][] = [];
  let systemd: "moves" | "refuses" | "never" = "moves";
  let oomPolicy = true;
  let clock = Date.UTC(2026, 9, 27, 12);
  const t = setup({
    proc,
    now: () => clock,
    scopeOomPolicy: () => oomPolicy,
    busctl: async (args) => {
      asked.push(args);
      if (systemd === "refuses") return { code: 1, output: "Unit agentes-browser-21000-4242.scope already exists." };
      const [pid, slice, unit] = [args[args.indexOf("PIDs") + 3], args[args.indexOf("Slice") + 2], args[7]];
      if (systemd === "moves") {
        setTimeout(
          () =>
            writeFileSync(
              path.join(proc, String(pid), "cgroup"),
              `0::/agents.slice/agents-21000.slice/${slice}/${unit}\n`,
            ),
          60,
        );
      }
      return { code: 0, output: 'o "/org/freedesktop/systemd1/job/1234"' };
    },
  });
  t.sup.boot();
  t.sup.attach();
  const run = handleRequest(t.ctx, exec(ANA), scope().scope);
  await waitFor(() => t.workers.length === 1);
  const ana = t.last(ANA.id);
  ana.hello();
  const answer = async (frame: Record<string, unknown>) => {
    const before = ana.of("scope.entered").length;
    ana.send({ type: "scope.enter", ...frame });
    await waitFor(() => ana.of("scope.entered").length > before, 4000);
    return ana.of("scope.entered").at(-1);
  };

  pidAt(4242, [21000, 21000, 21000, 21000], "/agents.slice/agents-21000.slice/run-r1.scope");
  expect(await answer({ enterId: "e1", pid: 4242, kind: "browser" })).toEqual({ type: "scope.entered", enterId: "e1" });
  // A tab the kernel stops for memory takes only itself, not the agent's whole Chrome (systemd 253 and later).
  expect(asked).toEqual([
    [
      "call",
      "--timeout=5",
      "org.freedesktop.systemd1",
      "/org/freedesktop/systemd1",
      "org.freedesktop.systemd1.Manager",
      "StartTransientUnit",
      "ssa(sv)a(sa(sv))",
      "agentes-browser-21000-4242.scope",
      "fail",
      "4",
      "OOMPolicy",
      "s",
      "continue",
      "PIDs",
      "au",
      "1",
      "4242",
      "Slice",
      "s",
      "agents-21000-browser.slice",
      "CollectMode",
      "s",
      "inactive-or-failed",
      "0",
    ],
  ]);
  expect(readFileSync(path.join(proc, "4242", "cgroup"), "utf8")).toBe(
    "0::/agents.slice/agents-21000.slice/agents-21000-browser.slice/agentes-browser-21000-4242.scope\n",
  );

  // Never another agent's process, one outside the agent's slice, one that only seems the agent's, or a made-up kind.
  pidAt(4243, [21001, 21001, 21001, 21001], "/agents.slice/agents-21001.slice/run-r2.scope");
  pidAt(4244, [21000, 21000, 21000, 21000], "/agents.slice/agents-21001.slice/run-r3.scope");
  pidAt(4245, [21000, 0, 21000, 21000], "/agents.slice/agents-21000.slice/run-r4.scope");
  pidAt(4246, [21000, 21000, 21000, 21000], "/system.slice/agentes-runner.service");
  for (const [frame, error] of [
    [{ pid: 4243, kind: "cli" }, "That isn't this agent's process"],
    [{ pid: 4245, kind: "cli" }, "That isn't this agent's process"],
    [{ pid: 4244, kind: "cli" }, "That process isn't in this agent's slice"],
    [{ pid: 4246, kind: "cli" }, "That process isn't in this agent's slice"],
    [{ pid: 4999, kind: "cli" }, "That isn't this agent's process"],
    [{ pid: 4242, kind: "desktop" }, "The kind is browser or cli"],
    [{ pid: "4242", kind: "cli" }, "That isn't a process id"],
    [{ pid: 1, kind: "cli" }, "That isn't a process id"],
  ] as const) {
    expect(await answer({ enterId: "e2", ...frame })).toEqual({ type: "scope.entered", enterId: "e2", error });
  }
  expect(asked).toHaveLength(1);

  // systemd refusing, or a move that never shows: said so, and the process starts where it is.
  pidAt(4250, [21000, 21000, 21000, 21000], "/agents.slice/agents-21000.slice/run-r5.scope");
  systemd = "refuses";
  expect(await answer({ enterId: "e3", pid: 4250, kind: "cli" })).toEqual({
    type: "scope.entered",
    enterId: "e3",
    error: "systemd didn't move it",
  });
  expect(t.logs.some((l) => l.includes("couldn't move a process into agents-21000-cli.slice"))).toBe(true);
  // An older systemd refuses OOMPolicy on a scope: never asked there.
  oomPolicy = false;
  expect((await answer({ enterId: "e3b", pid: 4250, kind: "cli" }))?.error).toBe("systemd didn't move it");
  expect(asked.at(-1)?.slice(9, 11)).toEqual(["3", "PIDs"]);
  oomPolicy = true;
  systemd = "never";
  expect(await answer({ enterId: "e4", pid: 4250, kind: "cli" })).toEqual({
    type: "scope.entered",
    enterId: "e4",
    error: "It didn't show in its slice in time",
  });

  // 30 a minute: the 31st waits for the next minute. These already show in their slice.
  const used = 9; // every ask above that named a process of a kind counted, refused or not
  for (let i = used; i < 30; i++) {
    pidAt(5000 + i, [21000, 21000, 21000, 21000], "/agents.slice/agents-21000.slice/agents-21000-cli.slice/x.scope");
    expect(await answer({ enterId: `r${i}`, pid: 5000 + i, kind: "cli" })).toEqual({
      type: "scope.entered",
      enterId: `r${i}`,
    });
  }
  expect(await answer({ enterId: "over", pid: 5000 + used, kind: "cli" })).toEqual({
    type: "scope.entered",
    enterId: "over",
    error: "Too many processes moved this minute",
  });
  clock += 61_000;
  expect(await answer({ enterId: "again", pid: 5000 + used, kind: "cli" })).toEqual({
    type: "scope.entered",
    enterId: "again",
  });

  const req = await requestOn(ana);
  ana.send({ type: "result", id: req.id, ok: true, data: execDone });
  await run;
});

test("root counts the live view of its agents' browsers it relays: frames up, people's input down", async () => {
  const relayed = new RelayCount();
  const t = setup({ relayed });
  t.sup.boot();
  t.sup.attach();
  const run = handleRequest(t.ctx, exec(ANA), scope().scope);
  await waitFor(() => t.workers.length === 1);
  const ana = t.last(ANA.id);
  ana.hello();
  const frame = {
    type: "browser.frame",
    agentId: ANA.id,
    seq: 1,
    data: "A".repeat(4000),
    metadata: { deviceWidth: 1280, deviceHeight: 800 },
  };
  ana.send(frame);
  // Another agent's frame never goes up, so it isn't counted either.
  ana.send({ ...frame, agentId: BIA.id });
  await waitFor(() => t.up.some((f) => f.type === "browser.frame"));
  expect(relayed.browserView.up).toBe(Buffer.byteLength(JSON.stringify(frame)));
  const input = handleRequest(
    t.ctx,
    { op: "browser.input", agent: ANA, events: [{ type: "text", text: "olá" }] } as unknown as MachineRequest,
    scope().scope,
  );
  const sent = await requestOn(ana, 2);
  expect(relayed.browserView.down).toBe(Buffer.byteLength(`${JSON.stringify(sent)}\n`));
  expect([relayed.desktop, relayed.terminal]).toEqual([
    { up: 0, down: 0 },
    { up: 0, down: 0 },
  ]);
  ana.send({ type: "result", id: sent.id, ok: true, data: { ok: true } });
  const req = await requestOn(ana, 1);
  ana.send({ type: "result", id: req.id, ok: true, data: execDone });
  await Promise.all([run, input]);
});

test("a worker's browser frames go to its agent's live view when it takes them, else up as before", async () => {
  const pushed: number[] = [];
  const ended: string[] = [];
  let take = true;
  let room = true;
  let open = true;
  const t = setup({
    views: {
      push: (f) => {
        pushed.push(f.seq);
        return take;
      },
      end: (agentId) => {
        ended.push(agentId);
      },
      room: () => room,
      has: () => open,
    },
  });
  t.sup.boot();
  t.sup.attach();
  const run = handleRequest(t.ctx, exec(ANA), scope().scope);
  await waitFor(() => t.workers.length === 1);
  const ana = t.last(ANA.id);
  ana.hello();
  const frame = {
    type: "browser.frame",
    agentId: ANA.id,
    seq: 1,
    data: "/9j/A",
    metadata: { deviceWidth: 1280, deviceHeight: 800 },
  };
  const rooms = () => ana.of("browser.room");
  const upFrames = () => t.up.filter((f) => f.type === "browser.frame").map((f) => f.seq);
  // The view takes it and has room for the next: nothing goes up, and the worker's stream may send the next.
  ana.send(frame);
  await waitFor(() => rooms().length === 1);
  expect(rooms()).toEqual([{ type: "browser.room", agentId: ANA.id, view: true }]);
  // Its window is full: no word until the view frees room (ADR 0040 §7.1).
  room = false;
  ana.send({ ...frame, seq: 2 });
  await waitFor(() => pushed.length === 2);
  expect(rooms()).toHaveLength(1);
  t.sup.browserRoom(ANA.id);
  await waitFor(() => rooms().length === 2);
  // Another agent's frame goes neither to the view nor up.
  ana.send({ ...frame, agentId: BIA.id, seq: 3 });
  // No view: up on the machine socket, and the worker hears once that its frames needn't wait.
  take = false;
  open = false;
  ana.send({ ...frame, seq: 4 });
  ana.send({ ...frame, seq: 5 });
  await waitFor(() => upFrames().length === 2);
  expect(pushed).toEqual([1, 2, 4, 5]);
  expect(upFrames()).toEqual([4, 5]);
  expect(rooms()).toHaveLength(3);
  expect(rooms()[2]).toEqual({ type: "browser.room", agentId: ANA.id, view: false });
  // The stream ended: its view closes with it, and the server hears.
  const streamEnded = { type: "browser.stream.ended", agentId: ANA.id, reason: "stopped" };
  ana.send(streamEnded);
  await waitFor(() => ended.length === 1);
  expect(ended).toEqual([ANA.id]);
  expect(t.up.at(-1)).toEqual(streamEnded);
  const req = await requestOn(ana, 1);
  ana.send({ type: "result", id: req.id, ok: true, data: execDone });
  await run;
});

test("a worker hears root's word on its live view's room; nothing else does", async () => {
  const fromRoot = new PassThrough();
  const link = new WorkerLink(fromRoot, new PassThrough());
  const heard: [string, boolean][] = [];
  link.onBrowserRoom = (agentId, view) => heard.push([agentId, view]);
  fromRoot.write(`${JSON.stringify({ type: "browser.room", agentId: ANA.id, view: true })}\n`);
  fromRoot.write(`${JSON.stringify({ type: "browser.room", agentId: 7, view: true })}\n`);
  fromRoot.write(`${JSON.stringify({ type: "browser.room", agentId: ANA.id, view: false })}\n`);
  await waitFor(() => heard.length === 2);
  await sleep(10);
  expect(heard).toEqual([
    [ANA.id, true],
    [ANA.id, false],
  ]);
});

test("hello lists every worker's tasks until the server acknowledges them, across a restart of the supervisor", async () => {
  const home = newHome();
  const t = setup({}, home);
  t.sup.boot();
  t.sup.attach();
  const startOn = async (agent: typeof ANA, taskId: string, n: number, ok = true) => {
    const run = handleRequest(t.ctx, taskStart(agent, taskId), scope().scope);
    await waitFor(() => t.of(agent.id).length === 1);
    const w = t.last(agent.id);
    if (n === 1) w.hello();
    const q = await requestOn(w, n);
    w.send(
      ok
        ? { type: "result", id: q.id, ok: true, data: { taskId, pid: 1, startedAt: "now", cwd: "", command: "x" } }
        : { type: "result", id: q.id, ok: false, error: { code: "no_slot", message: "busy" } },
    );
    return errorCode(() => run);
  };
  expect(await startOn(ANA, "task-ana-0001", 1)).toBe("ok");
  expect(await startOn(BIA, "task-bia-0001", 1)).toBe("ok");
  // Refused by the worker: that task never started.
  expect(await startOn(ANA, "task-ana-0002", 2, false)).toBe("no_slot");
  const listed = (s: Supervisor) => s.list().map((x) => [x.taskId, x.agentId, x.status]);
  expect(listed(t.sup)).toEqual([
    ["task-ana-0001", ANA.id, "running"],
    ["task-bia-0001", BIA.id, "running"],
  ]);
  expect(t.sup.list()[0]?.startedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  // A task id that is another agent's can't be started for someone else.
  expect(await errorCode(() => handleRequest(t.ctx, taskStart(ANA, "task-bia-0001"), scope().scope))).toBe(
    "bad_request",
  );

  // The supervisor restarts: the tasks are still listed, and their workers start at boot to watch them.
  await t.sup.close(100);
  const t2 = setup({}, home);
  expect(listed(t2.sup)).toEqual(listed(t.sup));
  t2.sup.boot();
  expect(t2.workers.map((w) => w.user.id).sort()).toEqual([ANA.id, BIA.id].sort());

  // An ack waits until the task's worker can be told (it sends `task.done` again, and the server acknowledges again).
  t2.sup.attach();
  t2.sup.ack("task-ana-0001");
  expect(listed(t2.sup)).toHaveLength(2);
  for (const w of t2.workers) w.hello();
  await waitFor(() => t2.workers.every((w) => w.of("welcome").length === 1));
  t2.sup.ack("task-ana-0001");
  await waitFor(() => t2.last(ANA.id).of("task.ack").length === 1);
  expect(t2.last(BIA.id).of("task.ack")).toEqual([]);
  expect(listed(t2.sup)).toEqual([["task-bia-0001", BIA.id, "running"]]);
  const file = JSON.parse(readFileSync(path.join(home, WORKER_TASKS_FILE), "utf8")) as Record<string, unknown>;
  expect(Object.keys(file)).toEqual(["task-bia-0001"]);
  expect(statSync(path.join(home, WORKER_TASKS_FILE)).mode & 0o777).toBe(0o600);
});

test("a worker that stops fails what it ran and starts again with a backoff", async () => {
  const t = setup();
  t.sup.boot();
  t.sup.attach();
  const first = handleRequest(t.ctx, exec(ANA, "sleep 100"), scope().scope);
  await waitFor(() => t.workers.length === 1);
  t.last(ANA.id).hello();
  await requestOn(t.last(ANA.id));
  t.last(ANA.id).crash(1);
  // `dropped`: the server waits for the computer and sends an agent's cut turn again, instead of failing it.
  expect(await errorCode(() => first)).toBe("dropped");
  await waitFor(() => t.logs.some((l) => l === "[ag-a1b2c3d4] stopped (exit 1)"));
  // The live view of Ana's browser ended with it: the server stops showing a stream nothing sends.
  expect(t.up).toEqual([{ type: "browser.stream.ended", agentId: ANA.id, reason: "closed" }]);
  // Nothing waits for it and it has no task to watch: it stays stopped.
  await sleep(50);
  expect(t.workers).toHaveLength(1);
  // The next request starts it again, once the backoff is over (it had only just started).
  const at = Date.now();
  const again = handleRequest(t.ctx, exec(ANA), scope().scope);
  await waitFor(() => t.workers.length === 2, 3000);
  expect(Date.now() - at).toBeGreaterThanOrEqual(600);
  t.last(ANA.id).hello();
  const q = await requestOn(t.last(ANA.id));
  t.last(ANA.id).send({ type: "result", id: q.id, ok: true, data: execDone });
  expect(await again).toEqual(execDone);

  // A worker with a task to watch comes back by itself.
  const start = handleRequest(t.ctx, taskStart(BIA, "task-bia-0001"), scope().scope);
  await waitFor(() => t.of(BIA.id).length === 1);
  t.last(BIA.id).hello();
  const qs = await requestOn(t.last(BIA.id));
  t.last(BIA.id).send({
    type: "result",
    id: qs.id,
    ok: true,
    data: { taskId: "task-bia-0001", pid: 1, startedAt: "now", cwd: "", command: "x" },
  });
  await start;
  t.last(BIA.id).crash(137);
  await waitFor(() => t.of(BIA.id).length === 2, 3000);
  // Whatever its stopped process still says is ignored: the new one hasn't said hello, so it hears nothing.
  t.of(BIA.id)[0]?.send({ ...HELLO });
  await sleep(20);
  expect(t.last(BIA.id).got).toEqual([]);
});

test("worker sessions follow the server's: they end when it drops and are welcomed when it is back", async () => {
  const t = setup();
  t.sup.boot();
  t.sup.attach();
  const run = handleRequest(t.ctx, exec(ANA, "sleep 100"), scope().scope);
  await waitFor(() => t.workers.length === 1);
  const ana = t.last(ANA.id);
  ana.hello();
  await requestOn(ana);
  const handoff: Extract<ServerFrame, { type: "browser.handoff" }> = {
    type: "browser.handoff",
    agentId: ANA.id,
    handoff: { status: "active", controller: "Maria" },
  };
  t.sup.handoff(handoff);
  await waitFor(() => ana.of("browser.handoff").length === 1);
  // Root sees a person take the desktop; the agent's keys are its worker's.
  t.sup.desktopTaken(ANA.id);
  await waitFor(() => ana.of("desktop.taken").length === 1);

  // The server's socket drops: so does the worker's session, and what it ran fails.
  t.sup.detach();
  expect(await errorCode(() => run)).toBe("dropped");
  expect(ana.of("worker.close")).toHaveLength(1);
  // Its next session says hello: it gets its state, but no welcome while the server is away.
  const before = ana.got.length;
  ana.hello();
  await waitFor(() => ana.got.length > before);
  await sleep(20);
  expect(ana.got.slice(before).map((f) => f.type)).toEqual(["worker.state"]);

  // Bia's turn opens while her worker isn't running: her worker gets it when it says hello. This server runs
  // each `mcp.call` once (its welcome says so), and so the workers' welcome says too.
  t.sup.mcp.attach(() => {}, { mcpOnce: true });
  t.sup.attach();
  await waitFor(() => ana.of("welcome").length === 2);
  expect(ana.of("welcome")[0]).not.toHaveProperty("mcpOnce");
  expect(ana.of("welcome")[1]).toMatchObject({ mcpOnce: true });
  t.sup.handoff({ ...handoff, agentId: BIA.id });
  const bread = handleRequest(t.ctx, { op: "read", path: "x", maxBytes: 1, agent: BIA }, scope().scope);
  await waitFor(() => t.of(BIA.id).length === 1);
  const bia = t.last(BIA.id);
  bia.hello();
  await requestOn(bia);
  expect(bia.got.map((f) => f.type)).toEqual(["worker.state", "welcome", "browser.handoff", "request"]);
  bia.send({ type: "result", id: (bia.of("request")[0] as Got).id, ok: true, data: { base64: null, size: 0 } });
  await bread;
  // Ana's turn was said before the drop: forgotten, not replayed.
  expect(ana.of("browser.handoff")).toHaveLength(1);

  // The computer's settings change: each worker hears it once.
  t.setState({ ...STATE, paused: { paused: true, until: null } });
  t.sup.stateChanged();
  t.sup.stateChanged();
  await waitFor(() => ana.of("worker.state").length === 3);
  await sleep(20);
  expect(ana.of("worker.state")).toHaveLength(3);
  expect(ana.of("worker.state")[2]).toMatchObject({ paused: { paused: true, until: null } });
});

test("pull: root fetches its own request's URL with the machine token, once, and paces the bytes to the worker", async () => {
  const gets: { url: string; init: RequestInit }[] = [];
  const bytes = Buffer.alloc(2_500_000, 7);
  const fetch: FetchLike = async (url, init) => {
    gets.push({ url, init });
    return new Response(bytes, { status: 200 });
  };
  const t = setup({ fetch, server: "http://127.0.0.1:3000" });
  t.sup.boot();
  t.sup.attach();
  const pullId = "11111111-1111-4111-8111-111111111111";
  const url = "https://agentes.test/api/machines/pulls/1";
  const req: MachineRequest = { op: "pull", path: "base.zip", url, pullId, size: bytes.length, agent: ANA };
  const pull = handleRequest(t.ctx, req, scope().scope);
  await waitFor(() => t.workers.length === 1);
  const ana = t.last(ANA.id);
  ana.hello();
  const q = await requestOn(ana);
  expect(q).toMatchObject({ op: "pull", pullId });

  // Only for a request it holds, and the address is the request's: the frame has no say in it.
  ana.send({ type: "pull.start", pullId: "nobody" });
  await waitFor(() => ana.of("pull.end").length === 1);
  expect(ana.of("pull.end")[0]).toEqual({
    type: "pull.end",
    pullId: "nobody",
    error: "No pull is waiting for this file",
  });
  ana.send({ type: "pull.start", pullId, url: "https://evil.test/steal" });
  await waitFor(() => ana.of("pull.end").length === 2);
  expect(gets.map((g) => g.url)).toEqual(["http://127.0.0.1:3000/api/machines/pulls/1"]);
  expect(gets[0]?.init.headers).toEqual({ authorization: "Bearer agm_machine" });
  expect(ana.of("pull.head")).toEqual([{ type: "pull.head", pullId, status: 200 }]);
  const pieces = ana.of("pull.chunk") as unknown as { data: string }[];
  expect(pieces.length).toBeGreaterThanOrEqual(3);
  expect(Buffer.concat(pieces.map((p) => Buffer.from(p.data, "base64"))).equals(bytes)).toBe(true);
  expect(ana.of("pull.end")[1]).toEqual({ type: "pull.end", pullId });

  // Once per request.
  ana.send({ type: "pull.start", pullId });
  await waitFor(() => ana.of("pull.end").length === 3);
  expect(gets).toHaveLength(1);
  ana.send({ type: "result", id: q.id, ok: true, data: { size: bytes.length, sha256: "x" } });
  await pull;
});

test("pull: a piece waits for the one before it to leave for the worker's pipe", async () => {
  const bytes = Buffer.alloc(2_500_000, 7);
  const t = setup({ fetch: async () => new Response(bytes), server: "http://127.0.0.1:3000" });
  t.sup.boot();
  t.sup.attach();
  const pullId = "11111111-1111-4111-8111-111111111111";
  const url = "https://agentes.test/api/machines/pulls/1";
  const req: MachineRequest = { op: "pull", path: "base.zip", url, pullId, size: bytes.length, agent: ANA };
  const pull = handleRequest(t.ctx, req, scope().scope);
  await waitFor(() => t.workers.length === 1);
  const ana = t.last(ANA.id);
  ana.hello();
  const q = await requestOn(ana);
  // As a real pipe does it: `writableLength` says nothing, and a write's callback comes when the bytes left.
  const flushes: (() => void)[] = [];
  let holding = true;
  const write = ana.stdin.write.bind(ana.stdin);
  ana.stdin.write = ((line: string, flushed?: () => void) => {
    if (flushed) holding ? flushes.push(flushed) : queueMicrotask(flushed);
    return write(line);
  }) as typeof ana.stdin.write;
  ana.send({ type: "pull.start", pullId });
  await waitFor(() => ana.of("pull.chunk").length === 1);
  await Bun.sleep(40);
  expect(ana.of("pull.chunk")).toHaveLength(1);
  flushes.shift()?.();
  await waitFor(() => ana.of("pull.chunk").length === 2);
  await Bun.sleep(40);
  expect(ana.of("pull.chunk")).toHaveLength(2);
  holding = false;
  flushes.shift()?.();
  await waitFor(() => ana.of("pull.end").length === 1);
  ana.send({ type: "result", id: q.id, ok: true, data: { size: bytes.length, sha256: "x" } });
  await pull;
});

test("pull: the worker's end reads root's frames as a fetch, and a cut stream as a failure", async () => {
  const fromRoot = new PassThrough();
  const toRoot = new PassThrough();
  const link = new WorkerLink(fromRoot, toRoot);
  const said: Record<string, unknown>[] = [];
  readLines(
    toRoot,
    1 << 20,
    (line) => said.push(JSON.parse(line)),
    () => {},
  );
  const frame = (f: Record<string, unknown>) => fromRoot.write(`${JSON.stringify(f)}\n`);
  const headers = (pullId: string) => ({ "x-agentes-pull-id": pullId });

  const whole = link.fetch("ignored", { method: "GET", headers: headers("p1") });
  await waitFor(() => said.length === 1);
  expect(said[0]).toEqual({ type: "pull.start", pullId: "p1" });
  frame({ type: "pull.head", pullId: "p1", status: 200 });
  frame({ type: "pull.chunk", pullId: "p1", data: Buffer.from("olá ").toString("base64") });
  frame({ type: "pull.chunk", pullId: "p1", data: Buffer.from("mundo").toString("base64") });
  frame({ type: "pull.end", pullId: "p1" });
  expect(await (await whole).text()).toBe("olá mundo");

  const cut = link.fetch("ignored", { method: "GET", headers: headers("p2") });
  frame({ type: "pull.head", pullId: "p2", status: 200 });
  frame({ type: "pull.end", pullId: "p2", error: "socket closed" });
  expect((await cut).text()).rejects.toThrow("socket closed");

  const refused = link.fetch("ignored", { method: "GET", headers: headers("p3") });
  frame({ type: "pull.end", pullId: "p3", error: "No pull is waiting for this file" });
  expect(refused).rejects.toThrow("No pull is waiting");

  const stop = new AbortController();
  const stopped = link.fetch("ignored", { method: "GET", headers: headers("p4"), signal: stop.signal });
  stop.abort(new Error("Canceled"));
  expect(stopped).rejects.toThrow("Canceled");
});

test("push: the worker's bytes go out from here with the machine token, only to the server it is paired with", async () => {
  const puts: { url: string; init: RequestInit }[] = [];
  const fetch: FetchLike = async (url, init) => {
    puts.push({ url, init });
    return new Response('{"ok":true}', { status: 200 });
  };
  // The server's own computer: paired on its local address, while the server names its public one.
  const t = setup({ fetch, server: "http://127.0.0.1:3000" });
  t.sup.boot();
  t.sup.attach();
  const uploadId = "11111111-1111-4111-8111-111111111111";
  const req: MachineRequest = {
    op: "push",
    path: "report.pdf",
    url: "https://agentes.test/api/machines/uploads/1",
    uploadId,
    maxBytes: 4_000_000,
    agent: ANA,
  };
  const push = handleRequest(t.ctx, req, scope().scope);
  await waitFor(() => t.workers.length === 1);
  const ana = t.last(ANA.id);
  ana.hello();
  const q = await requestOn(ana);
  const bytes = Buffer.alloc(2_500_000, 7);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  for (let at = 0; at < bytes.length; at += 1024 * 1024) {
    ana.send({ type: "upload.chunk", uploadId, data: bytes.subarray(at, at + 1024 * 1024).toString("base64") });
  }
  const end = { type: "upload.end", uploadId, contentType: "application/pdf", name: "report.pdf", sha256 };
  ana.send({ ...end, url: "https://evil.test/steal" });
  await waitFor(() => ana.of("upload.reply").length === 1);
  expect(ana.of("upload.reply")).toEqual([{ type: "upload.reply", uploadId, status: 200, body: '{"ok":true}' }]);
  expect(puts).toHaveLength(1);
  expect(puts[0]?.url).toBe("http://127.0.0.1:3000/api/machines/uploads/1");
  expect(puts[0]?.init.method).toBe("PUT");
  expect(puts[0]?.init.headers).toEqual({
    authorization: "Bearer agm_machine",
    "content-type": "application/pdf",
    "x-agentes-file-name": "report.pdf",
    "x-agentes-sha256": sha256,
    "x-agentes-upload-id": uploadId,
  });
  expect(Buffer.from(puts[0]?.init.body as Uint8Array).equals(bytes)).toBe(true);
  // Once per push; bytes nobody asked for get an answer and go nowhere.
  ana.send(end);
  ana.send({ ...end, uploadId: "22222222-2222-4222-8222-222222222222" });
  await waitFor(() => ana.of("upload.reply").length === 2);
  expect(ana.of("upload.reply")[1]).toMatchObject({ error: "No upload is waiting for these bytes" });
  expect(puts).toHaveLength(1);
  const sent = { name: "report.pdf", size: bytes.length, sha256, contentType: "application/pdf" };
  ana.send({ type: "result", id: q.id, ok: true, data: sent });
  expect(await push).toEqual(sent);

  // More than the request allows: refused here, nothing goes out.
  const small = handleRequest(t.ctx, { ...req, maxBytes: 10 }, scope().scope);
  const q2 = await requestOn(ana, 2);
  ana.send({ type: "upload.chunk", uploadId, data: Buffer.alloc(20).toString("base64") });
  ana.send(end);
  await waitFor(() => ana.of("upload.reply").length === 3);
  expect(ana.of("upload.reply")[2]).toMatchObject({ status: 413 });
  expect(puts).toHaveLength(1);
  ana.send({ type: "result", id: q2.id, ok: false, error: { code: "upload_failed", message: "too large" } });
  expect(await errorCode(() => small)).toBe("upload_failed");

  // A URL that isn't http(s): the token goes nowhere.
  const odd = handleRequest(t.ctx, { ...req, url: "file:///etc/passwd" }, scope().scope);
  const q3 = await requestOn(ana, 3);
  ana.send({ type: "upload.chunk", uploadId, data: Buffer.from("x").toString("base64") });
  ana.send(end);
  await waitFor(() => ana.of("upload.reply").length === 4);
  expect(ana.of("upload.reply")[3]).toEqual({
    type: "upload.reply",
    uploadId,
    error: "The upload URL must be http(s)",
  });
  expect(puts).toHaveLength(1);
  ana.send({ type: "result", id: q3.id, ok: false, error: { code: "upload_failed", message: "no" } });
  expect(await errorCode(() => odd)).toBe("upload_failed");
});

test("a worker gets its agent's desktop from root only while it serves a request the server sent that uses it", async () => {
  const asked: [AgentScope, string][] = [];
  const desktop: WorkerDesktop = {
    display: 21,
    width: 1280,
    height: 800,
    startedAt: new Date(1000).toISOString(),
    started: true,
    xauthority: "/home/ag-a1b2c3d4/.agentes/desktop/Xauthority",
    home: "/home/ag-a1b2c3d4",
  };
  const t = setup({
    desktop: async (agent, use) => {
      asked.push([agent, use]);
      return desktop;
    },
  });
  t.sup.boot();
  t.sup.attach();
  const answers = (w: FakeWorker) => w.of("desktop.ensured");
  const refused = (ensureId: string, message = "No desktop use request of this agent is running") => ({
    type: "desktop.ensured",
    ensureId,
    error: { code: "not_allowed", message },
  });

  // During another request, the agent's own code (as the worker's user) asking gets nothing.
  const run = handleRequest(t.ctx, exec(ANA), scope().scope);
  await waitFor(() => t.workers.length === 1);
  const ana = t.last(ANA.id);
  ana.hello();
  const q = await requestOn(ana);
  ana.send({ type: "desktop.ensure", ensureId: "1", use: "desktop" });
  ana.send({ type: "desktop.ensure", ensureId: "1b", use: "browser" });
  await waitFor(() => answers(ana).length === 2);
  expect(answers(ana)[1]).toEqual(refused("1b", BROWSER_REFUSED));
  expect(answers(ana)[0]).toEqual(refused("1"));
  ana.send({ type: "result", id: q.id, ok: true, data: execDone });
  await run;

  // Desktop use is the worker's: the request goes to it, and while it runs root starts the desktop for it.
  const look = handleRequest(t.ctx, { op: "desktop.look", agent: ANA }, scope().scope);
  const q2 = await requestOn(ana, 2);
  expect(q2).toEqual({ op: "desktop.look", agent: ANA, type: "request", id: q2.id });
  ana.send({ type: "desktop.ensure", ensureId: "2", use: "desktop" });
  await waitFor(() => answers(ana).length === 3);
  expect(answers(ana)[2]).toEqual({ type: "desktop.ensured", ensureId: "2", desktop });
  expect(asked).toEqual([[ANA, "desktop"]]);

  // Another agent's worker asking meanwhile gets nothing: the request isn't its own.
  const read = handleRequest(t.ctx, { op: "read", path: "a.md", maxBytes: 10, agent: BIA }, scope().scope);
  await waitFor(() => t.workers.length === 2);
  const bia = t.last(BIA.id);
  bia.hello();
  const q3 = await requestOn(bia);
  bia.send({ type: "desktop.ensure", ensureId: "1", use: "desktop" });
  await waitFor(() => answers(bia).length === 1);
  expect(answers(bia)[0]).toEqual(refused("1"));
  expect(asked).toHaveLength(1);
  bia.send({ type: "result", id: q3.id, ok: false, error: { code: "not_found", message: "No such file" } });
  await errorCode(() => read);

  const reply = {
    snapshot: "",
    refs: {},
    address: "desktop://thunar/main",
    title: "",
    screen: { width: 1280, height: 800 },
  };
  ana.send({ type: "result", id: q2.id, ok: true, data: reply });
  expect(await look).toEqual(reply);

  // Its Chrome on its desktop: only during a browser command the server put there, and only for that.
  const plain = handleRequest(t.ctx, browserOpen(ANA, false), scope().scope);
  const q5 = await requestOn(ana, 3);
  ana.send({ type: "desktop.ensure", ensureId: "3", use: "browser" });
  await waitFor(() => answers(ana).length === 4);
  expect(answers(ana)[3]).toEqual(refused("3", BROWSER_REFUSED));
  ana.send({ type: "result", id: q5.id, ok: true, data: { success: true, data: null } });
  await plain;
  const there = handleRequest(t.ctx, browserOpen(ANA, true), scope().scope);
  const q6 = await requestOn(ana, 4);
  ana.send({ type: "desktop.ensure", ensureId: "4", use: "desktop" });
  ana.send({ type: "desktop.ensure", ensureId: "5", use: "browser" });
  await waitFor(() => answers(ana).length === 6);
  expect(answers(ana)[4]).toEqual(refused("4"));
  expect(answers(ana)[5]).toEqual({ type: "desktop.ensured", ensureId: "5", desktop });
  expect(asked).toEqual([
    [ANA, "desktop"],
    [ANA, "browser"],
  ]);
  ana.send({ type: "result", id: q6.id, ok: true, data: { success: true, data: null } });
  await there;
  // Root says why it couldn't, in the machine protocol's words.
  const t2 = setup({
    desktop: async () => {
      throw new RunnerError("desktop_unavailable", "Install the agents' desktops");
    },
  });
  t2.sup.boot();
  t2.sup.attach();
  const look2 = handleRequest(t2.ctx, { op: "desktop.look", agent: ANA }, scope().scope);
  await waitFor(() => t2.workers.length === 1);
  const ana2 = t2.last(ANA.id);
  ana2.hello();
  const q4 = await requestOn(ana2);
  ana2.send({ type: "desktop.ensure", ensureId: "9", use: "desktop" });
  await waitFor(() => answers(ana2).length === 1);
  expect(answers(ana2)[0]).toEqual({
    type: "desktop.ensured",
    ensureId: "9",
    error: { code: "desktop_unavailable", message: "Install the agents' desktops" },
  });
  ana2.send({ type: "result", id: q4.id, ok: false, error: { code: "desktop_unavailable", message: "no" } });
  expect(await errorCode(() => look2)).toBe("desktop_unavailable");
});

test("a browser request that waited for its agent's worker to start says how long; nothing more once it runs", async () => {
  const t = setup();
  t.sup.boot();
  t.sup.attach();
  const first = handleRequest(t.ctx, browserOpen(ANA, false), scope().scope);
  await waitFor(() => t.workers.length === 1);
  await sleep(30);
  const ana = t.last(ANA.id);
  ana.hello();
  const q = await requestOn(ana);
  ana.send({ type: "result", id: q.id, ok: true, data: { success: true, data: null, setup: { launch: 1400 } } });
  const answer = (await first) as { setup: Record<string, number> };
  expect(answer).toMatchObject({ success: true, data: null, setup: { launch: 1400 } });
  expect(answer.setup.worker).toBeGreaterThanOrEqual(30);
  // Its worker runs: the answer as the worker gave it.
  const second = handleRequest(t.ctx, browserOpen(ANA, false), scope().scope);
  const q2 = await requestOn(ana, 2);
  ana.send({ type: "result", id: q2.id, ok: true, data: { success: true, data: null } });
  expect(await second).toEqual({ success: true, data: null });
  // Not a browser request: nothing added, its worker new or not.
  const read = handleRequest(t.ctx, { op: "read", path: "a.md", maxBytes: 10, agent: BIA }, scope().scope);
  await waitFor(() => t.workers.length === 2);
  await sleep(30);
  const bia = t.last(BIA.id);
  bia.hello();
  const q3 = await requestOn(bia);
  bia.send({ type: "result", id: q3.id, ok: true, data: { base64: null, size: 0 } });
  expect(await read).toEqual({ base64: null, size: 0 });
});

test("a worker starting its agent's Chrome ahead on the desktop gets that desktop from root, and only then", async () => {
  const desktop: WorkerDesktop = {
    display: 21,
    width: 1280,
    height: 800,
    startedAt: new Date(1000).toISOString(),
    started: true,
    xauthority: "/home/ag-a1b2c3d4/.agentes/desktop/Xauthority",
    home: "/home/ag-a1b2c3d4",
  };
  const asked: string[] = [];
  const t = setup({
    desktop: async (_agent, use) => {
      asked.push(use);
      return desktop;
    },
  });
  t.sup.boot();
  t.sup.attach();
  const warm = (on: boolean) =>
    handleRequest(t.ctx, { op: "browser.warm", agent: ANA, ...(on ? { desktop: true } : {}) }, scope().scope);
  const headless = warm(false);
  await waitFor(() => t.workers.length === 1);
  const ana = t.last(ANA.id);
  ana.hello();
  const q = await requestOn(ana);
  expect(q).toEqual({ op: "browser.warm", agent: ANA, type: "request", id: q.id });
  ana.send({ type: "desktop.ensure", ensureId: "1", use: "browser" });
  await waitFor(() => ana.of("desktop.ensured").length === 1);
  expect(ana.of("desktop.ensured")[0]).toEqual({
    type: "desktop.ensured",
    ensureId: "1",
    error: { code: "not_allowed", message: BROWSER_REFUSED },
  });
  ana.send({ type: "result", id: q.id, ok: true, data: { started: true } });
  expect(await headless).toMatchObject({ started: true });
  const there = warm(true);
  const q2 = await requestOn(ana, 2);
  ana.send({ type: "desktop.ensure", ensureId: "2", use: "browser" });
  await waitFor(() => ana.of("desktop.ensured").length === 2);
  expect(ana.of("desktop.ensured")[1]).toEqual({ type: "desktop.ensured", ensureId: "2", desktop });
  expect(asked).toEqual(["browser"]);
  ana.send({ type: "result", id: q2.id, ok: true, data: { started: true } });
  expect(await there).toEqual({ started: true });
});

test("a worker's word that its Chrome is in use on the desktop holds a while; it learns who watches that desktop", async () => {
  const clock = { now: 1_000_000 };
  const viewers: Record<string, number> = {};
  const t = setup({ now: () => clock.now, desktopViewers: (agentId) => viewers[agentId] ?? 0 });
  t.sup.boot();
  t.sup.attach();
  const run = handleRequest(t.ctx, exec(ANA), scope().scope);
  await waitFor(() => t.workers.length === 1);
  const ana = t.last(ANA.id);
  // Before its hello nothing it says counts.
  ana.send({ type: "browser.desktop" });
  ana.hello();
  await requestOn(ana);
  expect(t.sup.onDesktopInUse(ANA.id)).toBe(false);
  ana.send({ type: "browser.desktop" });
  await waitFor(() => t.sup.onDesktopInUse(ANA.id));
  expect(t.sup.onDesktopInUse(BIA.id)).toBe(false);
  clock.now += BROWSER_LEASE_MS - 1;
  expect(t.sup.onDesktopInUse(ANA.id)).toBe(true);
  clock.now += 1;
  expect(t.sup.onDesktopInUse(ANA.id)).toBe(false);

  // Someone opens its desktop: only its own worker hears of it.
  viewers[ANA.id] = 2;
  viewers[BIA.id] = 1;
  t.sup.stateChanged();
  await waitFor(() => ana.of("worker.state").length === 2);
  expect(ana.of("worker.state")[1]).toEqual({ type: "worker.state", ...STATE, desktopViewers: 2 });
  viewers[ANA.id] = 0;
  t.sup.stateChanged();
  await waitFor(() => ana.of("worker.state").length === 3);
  expect(ana.of("worker.state")[2]).toEqual({ type: "worker.state", ...STATE });

  // A worker that stops takes its word with it.
  ana.send({ type: "browser.desktop" });
  await waitFor(() => t.sup.onDesktopInUse(ANA.id));
  ana.crash();
  expect(await errorCode(() => run)).toBe("dropped");
  expect(t.sup.onDesktopInUse(ANA.id)).toBe(false);
});

/** A real worker (`runWorker`) on the other end of in-memory pipes; `at`: the homes of an earlier supervisor (a restart). */
function realWorkers(over: Partial<SupervisorOptions> = {}, at?: { home: string; agentHome: string; ownHome: string }) {
  const agentHome = at?.agentHome ?? tempDir("agent-home-");
  const ownHome = at?.ownHome ?? tempDir("worker-home-");
  if (!at) dirs.push(agentHome, ownHome);
  const started: PassThrough[] = [];
  const t = setup(
    {
      start: (user) => {
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        started.push(stdin);
        const done = runWorker({
          agentId: user.id,
          home: ownHome,
          dir: agentHome,
          input: stdin,
          output: stdout,
          log: () => {},
          self: { command: [process.execPath, "/nonexistent/agentes-runner.mjs"], compiled: false },
        });
        workerRuns.push(done);
        return { stdin, stdout, exited: done, kill: () => stdin.end() };
      },
      ...over,
    },
    at?.home,
  );
  return { ...t, agentHome, ownHome, started };
}

test.if(posix)(
  "a real worker: its agent's folder, what the computer allows, uploads through the supervisor, new sessions",
  async () => {
    const puts: { url: string; init: RequestInit }[] = [];
    const big = Buffer.from(Array.from({ length: 3_000_000 }, (_, i) => i % 251));
    const t = realWorkers({
      fetch: async (url, init) => {
        if (init.method === "GET") return new Response(big, { status: 200 });
        puts.push({ url, init });
        return new Response("{}", { status: 200 });
      },
    });
    t.sup.boot();
    t.sup.attach();
    const pwd = (await handleRequest(t.ctx, { ...exec(ANA, "pwd"), stream: false }, scope().scope)) as {
      exitCode: number;
      stdout: string;
    };
    expect(pwd.exitCode).toBe(0);
    expect(pwd.stdout.trim()).toBe(path.join(realpathSync(t.agentHome), "ana-a1b2c3d4"));
    // Its state lives in its own home, not in the agent's.
    expect(statSync(path.join(t.ownHome, "tasks")).isDirectory()).toBe(true);

    const write = { op: "write", path: "out/report.txt", base64: Buffer.from("olá").toString("base64"), agent: ANA };
    expect(await handleRequest(t.ctx, write as MachineRequest, scope().scope)).toEqual({ size: 4 });
    const uploadId = "33333333-3333-4333-8333-333333333333";
    const url = "https://agentes.test/api/machines/uploads/3";
    const push = { op: "push", path: "out/report.txt", url, uploadId, maxBytes: 1000, agent: ANA } as MachineRequest;
    expect(await handleRequest(t.ctx, push, scope().scope)).toMatchObject({ name: "report.txt", size: 4 });
    expect(puts.map((p) => [p.url, (p.init.headers as Record<string, string>).authorization])).toEqual([
      [url, "Bearer agm_machine"],
    ]);
    expect(Buffer.from(puts[0]?.init.body as Uint8Array).toString()).toBe("olá");

    const pull = {
      op: "pull",
      path: "in/base.zip",
      url: "https://agentes.test/api/machines/pulls/4",
      pullId: "44444444-4444-4444-8444-444444444444",
      size: big.length,
      sha256: createHash("sha256").update(big).digest("hex"),
      agent: ANA,
    } as MachineRequest;
    expect(await handleRequest(t.ctx, pull, scope().scope)).toMatchObject({ size: big.length });
    expect(readFileSync(path.join(realpathSync(t.agentHome), "ana-a1b2c3d4", "in/base.zip")).equals(big)).toBe(true);

    // Commands turned off on the computer: the worker refuses them (its state comes before the next request).
    const off = { ...STATE.access.tools, commands: false };
    t.setState({ ...STATE, access: { ...STATE.access, tools: off } });
    t.sup.stateChanged();
    expect(await errorCode(() => handleRequest(t.ctx, exec(ANA, "pwd"), scope().scope))).toBe("exec_disabled");
    t.setState(STATE);
    t.sup.stateChanged();

    // The server's socket drops and comes back: the worker says hello again and serves requests.
    t.sup.detach();
    t.sup.attach();
    const again = (await handleRequest(t.ctx, { ...exec(ANA, "echo back"), stream: false }, scope().scope)) as {
      stdout: string;
    };
    expect(again.stdout).toBe("back\n");
    expect(t.started).toHaveLength(1);
  },
);

test.if(posix)(
  "a real worker: a turn on an account root keeps thinks in the agent's own folder for it, with root's token on a descriptor",
  async () => {
    const ACCOUNT = "0193ffff-0000-7000-8000-000000000001";
    const TOKEN = "sk-ant-oat01-fake-token-for-tests-only";
    const log = path.join(tempDir("worker-claude-"), "spawns.log");
    dirs.push(path.dirname(log));
    process.env.FAKE_CLAUDE_LOG = log;
    const usage: [string, string, unknown][] = [];
    const agentHome = tempDir("agent-home-");
    const ownHome = tempDir("worker-home-");
    dirs.push(agentHome, ownHome);
    let thinksWith: string | null = ACCOUNT;
    try {
      const t = setup({
        start: (user) => {
          const stdin = new PassThrough();
          const stdout = new PassThrough();
          const done = runWorker({
            agentId: user.id,
            home: ownHome,
            dir: agentHome,
            input: stdin,
            output: stdout,
            log: () => {},
            self: { command: [process.execPath, "/nonexistent/agentes-runner.mjs"], compiled: false },
            claudeCommand: [process.execPath, path.join(import.meta.dir, "fake-claude.mjs")],
          });
          workerRuns.push(done);
          return { stdin, stdout, exited: done, kill: () => stdin.end() };
        },
        grant: async () => ({ kind: "token", token: TOKEN }),
        lend: async () => {
          throw new Error("an account root keeps is never lent");
        },
        usage: (kind, id, info) => usage.push([kind, id, info]),
        account: () => thinksWith,
      });
      t.sup.boot();
      t.sup.attach();
      const turn = {
        op: "brain.turn",
        kind: "claude_code",
        runId: "run-00000001",
        session: { id: "0193aaaa-0000-7000-8000-000000000001", resume: false },
        prompt: "RATE",
        account: ACCOUNT,
        agent: ANA,
      } as MachineRequest;
      const out = (await handleRequest(t.ctx, turn, scope().scope)) as { final: { type: string } };
      expect(out.final.type).toBe("done");
      const [run] = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map(
          (l) =>
            JSON.parse(l) as { pid: number; configDir: string; oauthToken: string | null; oauthEnv: string | null },
        );
      expect(run?.configDir).toBe(path.join(ownHome, "accounts", "claude_code", ACCOUNT));
      expect(run?.oauthToken).toBe(TOKEN);
      expect(run?.oauthEnv).toBeNull();
      // What the turn said about the plan's usage reached root, for that account.
      await waitFor(() => usage.length > 0);
      expect(usage[0]?.slice(0, 2)).toEqual(["claude_code", ACCOUNT]);
      // The agent thinks with something else now: root says so, and the process that holds the token goes.
      const alive = (pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      expect(alive(run?.pid ?? 0)).toBe(true);
      thinksWith = null;
      t.sup.stateChanged();
      await waitFor(() => !alive(run?.pid ?? 0), 10_000);
    } finally {
      delete process.env.FAKE_CLAUDE_LOG;
    }
  },
);

test.if(posix)(
  "a real worker: a Claude Code task on an account root keeps signs in as a turn, with root's token on a descriptor, and stops when its agent leaves the account",
  async () => {
    const ACCOUNT = "0193ffff-0000-7000-8000-000000000001";
    const TOKEN = "sk-ant-oat01-fake-token-for-tests-only";
    const TASK = "0193aaaa-0000-7000-8000-000000000201";
    const dir = tempDir("worker-task-");
    dirs.push(dir);
    const log = path.join(dir, "claude.log");
    const bin = path.join(dir, "bin");
    const agentHome = path.join(dir, "agent");
    const ownHome = path.join(dir, "worker");
    mkdirSync(bin);
    mkdirSync(agentHome);
    // The task's shell finds the fake CLI as `claude`.
    const shim = path.join(bin, "claude");
    writeFileSync(
      shim,
      `#!/bin/sh\nexec "${process.execPath}" "${path.join(import.meta.dir, "fake-claude.mjs")}" "$@"\n`,
    );
    chmodSync(shim, 0o755);
    const path0 = process.env.PATH;
    process.env.PATH = `${bin}:${path0 ?? ""}`;
    process.env.FAKE_CLAUDE_LOG = log;
    let thinksWith: string | null = ACCOUNT;
    try {
      const t = setup({
        start: (user) => {
          const stdin = new PassThrough();
          const stdout = new PassThrough();
          const done = runWorker({
            agentId: user.id,
            home: ownHome,
            dir: agentHome,
            input: stdin,
            output: stdout,
            log: () => {},
            self: { command: [process.execPath, "/nonexistent/agentes-runner.mjs"], compiled: false },
          });
          workerRuns.push(done);
          return { stdin, stdout, exited: done, kill: () => stdin.end() };
        },
        grant: async () => ({ kind: "token", token: TOKEN }),
        lend: async () => {
          throw new Error("an account root keeps is never lent");
        },
        account: () => thinksWith,
      });
      t.sup.boot();
      t.sup.attach();
      const start = {
        op: "task.start",
        taskId: TASK,
        executor: "claude",
        prompt: "SLOWTASK",
        account: ACCOUNT,
        agent: ANA,
      } as MachineRequest;
      await handleRequest(t.ctx, start, scope().scope);
      await waitFor(() => existsSync(log) && readFileSync(log, "utf8").includes(TOKEN), 10_000);
      const [run] = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { configDir: string; oauthToken: string | null; oauthEnv: string | null });
      expect(run?.configDir).toBe(path.join(ownHome, "accounts", "claude_code", ACCOUNT));
      expect(run?.oauthToken).toBe(TOKEN);
      expect(run?.oauthEnv).toBeNull();
      // The agent thinks with something else now: root says so, and the task that holds the token stops.
      thinksWith = null;
      t.sup.stateChanged();
      await waitFor(() => t.up.some((f) => f.type === "task.done" && f.taskId === TASK), 15_000);
      expect(t.up.find((f) => f.type === "task.done" && f.taskId === TASK)).toMatchObject({ canceled: true });
    } finally {
      if (path0 === undefined) delete process.env.PATH;
      else process.env.PATH = path0;
      delete process.env.FAKE_CLAUDE_LOG;
    }
  },
  30_000,
);

test.if(posix)(
  "a real worker drives its agent's desktop through its helper, as its own user, with the desktop root started",
  async () => {
    const dir = tempDir("worker-desktop-");
    dirs.push(dir);
    const agentHome = path.join(dir, "agent");
    const ownHome = path.join(dir, "worker");
    mkdirSync(agentHome, { recursive: true });
    const logFile = path.join(dir, "helper.log");
    const stateFile = path.join(dir, "state.json");
    const snapshot = JSON.parse(
      readFileSync(path.join(import.meta.dir, "fixtures", "desktop", "menu.json"), "utf8"),
    ) as unknown;
    writeFileSync(stateFile, JSON.stringify({ snapshot }));
    const uid = process.getuid?.() ?? 1000;
    const asked: AgentScope[] = [];
    const xauthority = path.join(dir, "Xauthority");
    const t = setup({
      start: (user) => {
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const done = runWorker({
          agentId: user.id,
          home: ownHome,
          dir: agentHome,
          input: stdin,
          output: stdout,
          log: () => {},
          self: { command: [process.execPath, "/nonexistent/agentes-runner.mjs"], compiled: false },
          desktop: {
            system: { platform: "linux", uid, which: (c) => `/usr/bin/${c}` },
            command: [process.execPath, path.join(import.meta.dir, "fake-desktop-helper.mjs"), logFile, stateFile],
          },
        });
        workerRuns.push(done);
        return { stdin, stdout, exited: done, kill: () => stdin.end() };
      },
      desktop: async (agent) => {
        asked.push(agent);
        return {
          display: 21,
          width: 1280,
          height: 800,
          startedAt: new Date(1000).toISOString(),
          started: asked.length === 1,
          xauthority,
          home: agentHome,
        };
      },
    });
    const on = { ...STATE, access: { ...STATE.access, tools: { ...STATE.access.tools, desktop: true } } };
    t.setState(on);
    t.sup.boot();
    t.sup.attach();
    const look = (await handleRequest(t.ctx, { op: "desktop.look", agent: ANA }, scope().scope)) as {
      snapshot: string;
      address: string;
    };
    expect(look.address).toBe("desktop://thunar/main");
    expect(look.snapshot).toContain('- menu "Applications"');
    expect(asked).toEqual([ANA]);
    const started = (
      JSON.parse(readFileSync(logFile, "utf8").split("\n")[0] as string) as {
        start: { env: Record<string, string>; cwd: string };
      }
    ).start;
    expect([started.env.DISPLAY, started.env.XAUTHORITY, started.env.HOME]).toEqual([":21", xauthority, agentHome]);
    expect(realpathSync(started.cwd)).toBe(realpathSync(agentHome));

    // The desktop switch off: the worker refuses before asking root for anything.
    t.setState(STATE);
    t.sup.stateChanged();
    expect(await errorCode(() => handleRequest(t.ctx, { op: "desktop.look", agent: ANA }, scope().scope))).toBe(
      "not_allowed",
    );
    expect(asked).toHaveLength(1);
  },
);

test.if(posix)(
  "a real worker runs its agent's Chrome headed on the desktop root started for it, and root keeps that desktop",
  async () => {
    const dir = tempDir("worker-browser-");
    dirs.push(dir);
    const agentHome = path.join(dir, "agent");
    mkdirSync(agentHome, { recursive: true });
    process.env.FAKE_AB_LOG = path.join(dir, "ab.log");
    process.env.FAKE_AB_STATE = path.join(dir, "ab-state.json");
    const chromes: { args: string[]; env?: Record<string, string>; killed: boolean }[] = [];
    const asked: [string, string][] = [];
    let viewers = 0;
    let refusal: string | null = null;
    const xauthority = path.join(dir, "Xauthority");
    const clock = { now: 1_000_000 };
    const t = setup({
      start: (user) => {
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const done = runWorker({
          agentId: user.id,
          home: path.join(dir, "worker"),
          dir: agentHome,
          input: stdin,
          output: stdout,
          log: () => {},
          self: { command: [process.execPath, "/nonexistent/agentes-runner.mjs"], compiled: false },
          browser: {
            command: [process.execPath, path.join(import.meta.dir, "fake-agent-browser.mjs")],
            chrome: () => "/opt/google/chrome/chrome",
            isOurChrome: async () => false,
            async startChrome(_exe, args, _profile, env) {
              const c = { args, env, killed: false };
              chromes.push(c);
              let quit = () => {};
              const exited = new Promise<void>((resolve) => {
                quit = resolve;
              });
              const kill = () => {
                c.killed = true;
                quit();
              };
              return { pid: 50_000 + chromes.length, port: 9400 + chromes.length, exited, kill };
            },
            // Its debugging endpoint lists the page of its window: a click on Browser waits for that.
            fetch: (async () =>
              new Response(
                JSON.stringify([{ id: "P1", type: "page", url: "about:blank" }]),
              )) as unknown as typeof fetch,
            windowDrawMs: 0,
          },
        });
        workerRuns.push(done);
        return { stdin, stdout, exited: done, kill: () => stdin.end() };
      },
      desktop: async (agent, use) => {
        asked.push([agent.id, use]);
        if (refusal) throw new RunnerError("not_allowed", refusal);
        const startedAt = new Date(1000).toISOString();
        return { display: 21, width: 1280, height: 900, startedAt, started: true, xauthority, home: agentHome };
      },
      desktopViewers: () => viewers,
      now: () => clock.now,
    });
    t.setState({ ...STATE, access: { ...STATE.access, tools: { ...STATE.access.tools, desktop: true } } });
    t.sup.boot();
    t.sup.attach();
    const act = (command: string, desktop: boolean) =>
      handleRequest(t.ctx, browserOpen(ANA, desktop, command, ["@e1"]), scope().scope);
    const headed = (c?: { args: string[] }) => !!c && !c.args.includes("--headless=new");

    // Where the server didn't put it on the desktop: headless, and root is never asked.
    expect(await handleRequest(t.ctx, browserOpen(ANA, false), scope().scope)).toMatchObject({ success: true });
    expect(asked).toEqual([]);
    expect(headed(chromes[0])).toBe(false);
    // The next command the server puts there moves it: as this worker's user, on root's display, same page.
    expect(await act("click", true)).toMatchObject({ success: true });
    expect(asked).toEqual([[ANA.id, "browser"]]);
    expect(chromes).toHaveLength(2);
    expect(chromes[0]?.killed).toBe(true);
    expect(headed(chromes[1])).toBe(true);
    expect(chromes[1]?.args).toContain("--start-maximized");
    expect(chromes[1]?.args.at(-1)).toBe("https://shop.example/cart");
    expect(chromes[1]?.env).toMatchObject({ DISPLAY: ":21", XAUTHORITY: xauthority });
    // In use there: root doesn't stop that desktop as idle.
    await waitFor(() => t.sup.onDesktopInUse(ANA.id));

    // Someone on that desktop: the worker hears it before its next request, and never moves Chrome off under them.
    viewers = 1;
    t.sup.stateChanged();
    expect(await act("click", false)).toMatchObject({ success: true });
    expect(chromes).toHaveLength(2);
    viewers = 0;
    t.sup.stateChanged();
    expect(await act("click", false)).toMatchObject({ success: true });
    expect(chromes).toHaveLength(3);
    expect(headed(chromes[2])).toBe(false);
    // Off the desktop, the worker stops saying so and root's word runs out.
    clock.now += BROWSER_LEASE_MS;
    expect(t.sup.onDesktopInUse(ANA.id)).toBe(false);

    // Root refuses (a switch off there): the browser goes on headless, and isn't moved at every command.
    refusal = "The browser on the agent's desktop needs this computer's desktop and browser switches on";
    expect(await act("click", true)).toMatchObject({ success: true });
    expect(await act("click", true)).toMatchObject({ success: true });
    expect(asked).toHaveLength(2);
    expect(chromes).toHaveLength(3);

    // Browser clicked on that desktop: the worker asks root for it at once, and its Chrome moves there.
    refusal = null;
    await t.sup.showBrowser(ANA, () => {});
    expect(asked).toEqual([
      [ANA.id, "browser"],
      [ANA.id, "browser"],
      [ANA.id, "browser"],
    ]);
    expect(chromes).toHaveLength(4);
    expect(headed(chromes[3])).toBe(true);
    expect(chromes[3]?.env).toMatchObject({ DISPLAY: ":21", XAUTHORITY: xauthority });
    expect(chromes[3]?.args).toContain("--class=agentes-browser");
    // Root can't lend it the desktop: the click says so, in root's words, and the agent's Chrome stays as it was.
    await act("click", false);
    expect(chromes).toHaveLength(5);
    refusal = "The browser on the agent's desktop needs this computer's desktop and browser switches on";
    const failed = await t.sup
      .showBrowser(ANA, () => {})
      .then(
        () => null,
        (err: unknown) => err as RunnerError,
      );
    expect([failed?.code, failed?.message]).toEqual(["not_allowed", refusal]);
    expect(chromes).toHaveLength(5);
    expect(chromes[4]?.killed).toBe(false);
  },
);

test("Browser clicked on an agent's desktop: its worker, started for it, answers; root lends it the desktop meanwhile", async () => {
  const asked: [AgentScope, string][] = [];
  const desktop: WorkerDesktop = {
    display: 21,
    width: 1280,
    height: 900,
    startedAt: new Date(1000).toISOString(),
    started: false,
    xauthority: "/home/ag-a1b2c3d4/.agentes/desktop/Xauthority",
    home: "/home/ag-a1b2c3d4",
  };
  const t = setup({
    desktop: async (agent, use) => {
      asked.push([agent, use]);
      return desktop;
    },
  });
  t.sup.boot();
  let installing = 0;
  const shown = t.sup.showBrowser(ANA, () => void installing++);
  await waitFor(() => t.workers.length === 1);
  const ana = t.last(ANA.id);
  ana.hello();
  await waitFor(() => ana.of("browser.show").length === 1);
  expect(ana.of("browser.show")[0]).toEqual({ type: "browser.show", showId: expect.any(String), agent: ANA });
  const show = ana.of("browser.show")[0] as { showId: string };
  // While it answers, root lends it the agent's desktop, for its Chrome only.
  ana.send({ type: "desktop.ensure", ensureId: "1", use: "desktop" });
  ana.send({ type: "desktop.ensure", ensureId: "2", use: "browser" });
  await waitFor(() => ana.of("desktop.ensured").length === 2);
  expect(ana.of("desktop.ensured")[0]).toMatchObject({ error: { code: "not_allowed" } });
  expect(ana.of("desktop.ensured")[1]).toEqual({ type: "desktop.ensured", ensureId: "2", desktop });
  expect(asked).toEqual([[ANA, "browser"]]);
  ana.send({ type: "browser.showing", showId: show.showId });
  await waitFor(() => installing === 1);
  // Another click's id settles nothing.
  ana.send({ type: "browser.shown", showId: "nope" });
  ana.send({ type: "browser.shown", showId: show.showId });
  await shown;
  // Done: the agent's own code asking afterwards gets nothing.
  ana.send({ type: "desktop.ensure", ensureId: "3", use: "browser" });
  await waitFor(() => ana.of("desktop.ensured").length === 3);
  expect(ana.of("desktop.ensured")[2]).toMatchObject({ error: { code: "not_allowed", message: BROWSER_REFUSED } });

  // The server's connection drops meanwhile: the worker's session ends with it, the click it answers goes on, and
  // root lends it the desktop before its next session too (desktop use, the last session's, it doesn't).
  t.sup.attach();
  const across = t.sup.showBrowser(ANA, () => {});
  await waitFor(() => ana.of("browser.show").length === 2);
  t.sup.detach();
  ana.send({ type: "desktop.ensure", ensureId: "4", use: "browser" });
  ana.send({ type: "desktop.ensure", ensureId: "5", use: "desktop" });
  await waitFor(() => ana.of("desktop.ensured").length === 5);
  const ensured = (ensureId: string) => ana.of("desktop.ensured").find((f) => f.ensureId === ensureId);
  expect(ensured("4")).toEqual({ type: "desktop.ensured", ensureId: "4", desktop });
  expect(ensured("5")).toMatchObject({ error: { code: "not_allowed" } });
  ana.send({ type: "browser.shown", showId: (ana.of("browser.show")[1] as { showId: string }).showId });
  await across;
  ana.hello();

  // Why not, in the worker's words.
  const failed = t.sup.showBrowser(ANA, () => {});
  await waitFor(() => ana.of("browser.show").length === 3);
  const third = ana.of("browser.show")[2] as { showId: string };
  ana.send({
    type: "browser.shown",
    showId: third.showId,
    error: { code: "browser_unavailable", message: "Couldn't install a browser for the agent" },
  });
  const why = await failed.then(
    () => null,
    (err: unknown) => err as RunnerError,
  );
  expect([why?.code, why?.message]).toEqual(["browser_unavailable", "Couldn't install a browser for the agent"]);
  // A worker that stops fails the click it was answering.
  const lost = t.sup.showBrowser(ANA, () => {});
  await waitFor(() => ana.of("browser.show").length === 4);
  ana.crash();
  expect(await errorCode(() => lost)).toBe("internal");
});

test("a click its worker never answers (the agent's own code stopped it) fails in time, and root lends nothing more", async () => {
  const desktop: WorkerDesktop = {
    display: 21,
    width: 1280,
    height: 900,
    startedAt: new Date(1000).toISOString(),
    started: false,
    xauthority: "/home/ag-a1b2c3d4/.agentes/desktop/Xauthority",
    home: "/home/ag-a1b2c3d4",
  };
  const t = setup({ desktop: async () => desktop, showMs: 50 });
  t.sup.boot();
  const shown = t.sup.showBrowser(ANA, () => {});
  await waitFor(() => t.workers.length === 1);
  const ana = t.last(ANA.id);
  ana.hello();
  const failed = await shown.then(
    () => null,
    (err: unknown) => err as RunnerError,
  );
  expect([failed?.code, failed?.message]).toEqual(["internal", "The agent's worker didn't answer in time"]);
  ana.send({ type: "desktop.ensure", ensureId: "1", use: "browser" });
  await waitFor(() => ana.of("desktop.ensured").length === 1);
  expect(ana.of("desktop.ensured")[0]).toMatchObject({ error: { code: "not_allowed", message: BROWSER_REFUSED } });
  // Its answer, late, settles nothing.
  ana.send({ type: "browser.shown", showId: (ana.of("browser.show")[0] as { showId: string }).showId });
});

test("a worker's ask for its desktop that root never answers gives up, and frees what waits behind it", async () => {
  const toRoot = new PassThrough();
  const link = new WorkerLink(new PassThrough(), toRoot, 50);
  const asked: string[] = [];
  readLines(
    toRoot,
    1 << 20,
    (line) => asked.push(line),
    () => {},
  );
  const failed = await link.desktop("browser").then(
    () => null,
    (err: unknown) => err as RunnerError,
  );
  expect([failed?.code, failed?.message]).toEqual(["internal", "The agent's desktop didn't start in time"]);
  expect(asked.map((l) => JSON.parse(l))).toEqual([{ type: "desktop.ensure", ensureId: "1", use: "browser" }]);
});

test("a worker's ask to move a process settles on root's answer, whatever it says, and its own traffic goes to root", async () => {
  const fromRoot = new PassThrough();
  const toRoot = new PassThrough();
  const link = new WorkerLink(fromRoot, toRoot);
  const asked: Record<string, unknown>[] = [];
  readLines(
    toRoot,
    1 << 20,
    (line) => asked.push(JSON.parse(line)),
    () => {},
  );
  let settled = false;
  const moved = link.enterScope(4242, "browser").then(() => {
    settled = true;
  });
  await waitFor(() => asked.length === 1);
  expect(asked[0]).toEqual({ type: "scope.enter", enterId: "1", pid: 4242, kind: "browser" });
  // Another ask's answer settles nothing here.
  fromRoot.write(`${JSON.stringify({ type: "scope.entered", enterId: "9" })}\n`);
  await Bun.sleep(20);
  expect(settled).toBe(false);
  fromRoot.write(`${JSON.stringify({ type: "scope.entered", enterId: "1", error: "systemd didn't move it" })}\n`);
  await moved;
  // Nothing to say when nothing moved.
  link.traffic({ up: 0, down: 0 });
  link.traffic({ up: 120, down: 34_000 });
  await waitFor(() => asked.length === 2);
  expect(asked[1]).toEqual({ type: "browser.traffic", up: 120, down: 34_000 });
});

test.if(posix)(
  "a real task keeps running through a restart of the supervisor, and the next worker reports its end",
  async () => {
    const t = realWorkers();
    t.sup.boot();
    t.sup.attach();
    const taskId = "task-ana-0001";
    const start = { op: "task.start", taskId, executor: "shell", command: "sleep 0.6; echo finished", agent: ANA };
    expect(await handleRequest(t.ctx, start as MachineRequest, scope().scope)).toMatchObject({ taskId });
    // The supervisor stops (a restart): its worker exits with it, the task goes on.
    await t.sup.close(2000);
    const t2 = realWorkers({}, t);
    expect(t2.sup.list()).toMatchObject([{ taskId, agentId: ANA.id, status: "running" }]);
    t2.sup.boot();
    expect(t2.started).toHaveLength(1);
    t2.sup.attach();
    await waitFor(() => t2.up.some((f) => f.type === "task.done"), 8000);
    expect(t2.up.filter((f) => f.type === "task.done")).toMatchObject([
      { taskId, exitCode: 0, result: "finished", lastLine: "finished" },
    ]);
    t2.sup.ack(taskId);
    expect(t2.sup.list()).toEqual([]);
  },
  15_000,
);

test.if(posix)(
  "a worker alone: hello first, its own agent's requests only, a new session on worker.close",
  async () => {
    const agentHome = tempDir("agent-home-");
    const ownHome = tempDir("worker-home-");
    dirs.push(agentHome, ownHome);
    const input = new PassThrough();
    const output = new PassThrough();
    const frames: Got[] = [];
    readLines(
      output,
      1 << 26,
      (line) => frames.push(JSON.parse(line) as Got),
      () => {},
    );
    const done = runWorker({ agentId: ANA.id, home: ownHome, dir: agentHome, input, output, log: () => {} });
    const send = (f: object) => input.write(`${JSON.stringify(f)}\n`);
    const result = async (id: string) => {
      await waitFor(() => frames.some((f) => f.type === "result" && f.id === id));
      return frames.find((f) => f.type === "result" && f.id === id) as Got;
    };
    await waitFor(() => frames.length === 1);
    expect(frames[0]).toMatchObject({ type: "hello", token: "", exec: false, workspace: realpathSync(agentHome) });
    send({ type: "welcome", machineId: ANA.id, name: "ag-a1b2c3d4", heartbeatMs: 25_000 });
    // Nothing is allowed until the supervisor says what the computer allows.
    send({ type: "request", id: "1", ...exec(ANA, "pwd") });
    expect(await result("1")).toMatchObject({ ok: false, error: { code: "exec_disabled" } });
    send({ type: "worker.state", ...STATE });
    send({ type: "request", id: "2", ...exec(ANA, "echo hi") });
    expect(await result("2")).toMatchObject({ ok: true, data: { exitCode: 0, stdout: "hi\n" } });
    expect(frames.some((f) => f.type === "output" && f.id === "2")).toBe(true);
    // Another agent's request never runs here.
    send({ type: "request", id: "3", ...exec(BIA, "echo nope") });
    expect(await result("3")).toMatchObject({ ok: false, error: { code: "not_allowed" } });

    // worker.close ends the session; the worker dials again and says hello.
    send({ type: "worker.close" });
    await waitFor(() => frames.filter((f) => f.type === "hello").length === 2, 3000);
    input.end();
    expect(await done).toBe(0);
  },
);

test.if(posix)(
  "a system-mode runner: hello lists its workers' tasks, agents' requests go to their workers, pause stops new work first",
  async () => {
    const home = newHome();
    const ws = tempDir("root-ws-");
    dirs.push(ws);
    writeConfig(
      {
        server: "https://agentes.test",
        machineId: "m1",
        name: "box",
        token: "agm_machine_token_never_shown_123456",
        workspace: ws,
        exec: true,
        mode: "system",
        agentUidRange: [21000, 21099],
        access: { folders: [], tools: { claude: false, codex: false, commands: true, desktop: true } },
      },
      home,
    );
    const startedAt = new Date().toISOString();
    writeFileSync(
      path.join(home, WORKER_TASKS_FILE),
      JSON.stringify({ "task-ana-0001": { agentId: ANA.id, startedAt } }),
    );
    const workers: FakeWorker[] = [];
    const sockets: FakeSocket[] = [];
    const dial: Dial = (_url, handlers) => {
      const s = new FakeSocket(handlers);
      sockets.push(s);
      return s;
    };
    const daemon = new RunnerDaemon({
      probeEgress: async () => null,
      home,
      mode: "start",
      log: () => {},
      watch: false,
      executors: () => ({}),
      self: { command: ["/opt/agentes-runner/agentes-runner"], compiled: true },
      caffeinate: false,
      dial,
      workers: {
        user: userOf,
        start: (user) => {
          const w = new FakeWorker(user);
          workers.push(w);
          return w;
        },
      },
    });
    daemon.start();
    try {
      // Ana's worker starts at boot: it has a task to watch.
      await waitFor(() => workers.length === 1);
      const ana = workers[0] as FakeWorker;
      expect(ana.user.id).toBe(ANA.id);
      await waitFor(() => sockets.length === 1);
      const s = sockets[0] as FakeSocket;
      s.handlers.onOpen();
      await waitFor(() => s.of("hello").length === 1);
      expect(s.of("hello")[0]?.tasks).toEqual([
        { taskId: "task-ana-0001", agentId: ANA.id, status: "running", startedAt },
      ]);
      // Each agent works as its own user, and hello says so: who may drive an agent's desktop follows it.
      expect(s.of("hello")[0]?.mode).toBe("system");
      s.frame({ type: "welcome", machineId: "m1", name: "box", heartbeatMs: 25_000 });
      ana.hello();
      await waitFor(() => ana.of("welcome").length === 1);
      expect(ana.of("worker.state")[0]).toMatchObject({
        access: { tools: { commands: true } },
        paused: { paused: false },
      });

      s.frame({ type: "request", id: "r1", ...exec(ANA, "id -un") });
      const q = await requestOn(ana);
      ana.send({ type: "result", id: q.id, ok: true, data: { ...execDone, stdout: "ag-a1b2c3d4\n" } });
      await waitFor(() => s.sent.some((f) => f.id === "r1"));
      expect(s.sent.find((f) => f.id === "r1")).toEqual({
        type: "result",
        id: "r1",
        ok: true,
        data: { ...execDone, stdout: "ag-a1b2c3d4\n" },
      });
      // The desktops are this root process's own (the data sockets need the machine token): no worker hears of them.
      s.frame({ type: "request", id: "d1", op: "desktop.session.status", agent: ANA });
      await waitFor(() => s.sent.some((f) => f.id === "d1"));
      expect(s.sent.find((f) => f.id === "d1")).toMatchObject({ ok: true, data: { running: false, streams: 0 } });
      expect(ana.of("request")).toHaveLength(1);
      // Root starts the agent's desktop for its worker behind the switches each use needs: its Chrome there the
      // browser's (off here), desktop use the commands' (on: past it, this test computer runs no desktops).
      s.frame({ type: "request", id: "b1", ...browserOpen(ANA, true) });
      const b1 = await requestOn(ana, 2);
      ana.send({ type: "desktop.ensure", ensureId: "1", use: "browser" });
      await waitFor(() => ana.of("desktop.ensured").length === 1);
      expect(ana.of("desktop.ensured")[0]).toMatchObject({
        error: { code: "not_allowed", message: expect.stringContaining("desktop and browser switches") },
      });
      ana.send({ type: "result", id: b1.id, ok: true, data: { success: true, data: null } });
      s.frame({ type: "request", id: "l1", op: "desktop.look", agent: ANA });
      const l1 = await requestOn(ana, 3);
      ana.send({ type: "desktop.ensure", ensureId: "2", use: "desktop" });
      await waitFor(() => ana.of("desktop.ensured").length === 2);
      expect(ana.of("desktop.ensured")[1]?.error).not.toMatchObject({ code: "not_allowed" });
      ana.send({ type: "result", id: l1.id, ok: false, error: { code: "desktop_unavailable", message: "no" } });
      await waitFor(() => s.sent.some((f) => f.id === "l1"));
      // Its task's end goes up; the server's ack comes back down to it.
      ana.send({ type: "task.done", taskId: "task-ana-0001", exitCode: 0, seconds: 3 });
      await waitFor(() => s.of("task.done").length === 1);
      s.frame({ type: "task.ack", taskId: "task-ana-0001" });
      await waitFor(() => ana.of("task.ack").length === 1);

      // The agents on this computer, from the server: the desktops of any other agent stop (they stay on otherwise).
      const kept: string[][] = [];
      daemon.desktops.stopAll = async (keep = new Set()) => void kept.push([...keep]);
      s.frame({ type: "agents", agents: [ANA] });
      await waitFor(() => kept.length === 1);
      expect(kept).toEqual([[ANA.id]]);

      // Browser clicked on the agent's desktop needs the browser switch, off here: no worker hears of it.
      expect(await errorCode(() => daemon.openBrowser(ANA, () => {}))).toBe("not_allowed");
      expect(ana.of("browser.show")).toHaveLength(0);

      // Paused: new work is refused here, before any worker hears of it; the workers learn the pause too.
      daemon.pause(null);
      await waitFor(() => ana.of("worker.state").length === 2);
      s.frame({ type: "request", id: "r2", ...exec(ANA, "id -un") });
      await waitFor(() => s.sent.some((f) => f.id === "r2"));
      expect(s.sent.find((f) => f.id === "r2")).toMatchObject({ ok: false, error: { code: "paused" } });
      expect(ana.of("request")).toHaveLength(3);
    } finally {
      await daemon.stop();
    }
  },
);

test.if(posix)(
  "a system-mode runner: Browser clicked on an agent's desktop goes to that agent's worker, unless the computer is paused",
  async () => {
    const home = newHome();
    const ws = tempDir("root-ws-");
    dirs.push(ws);
    writeConfig(
      {
        server: "https://agentes.test",
        machineId: "m1",
        name: "box",
        token: "agm_machine_token_never_shown_123456",
        workspace: ws,
        exec: true,
        mode: "system",
        agentUidRange: [21000, 21099],
        access: { folders: [], tools: { claude: false, codex: false, commands: true, browser: true, desktop: true } },
      },
      home,
    );
    const workers: FakeWorker[] = [];
    const sockets: FakeSocket[] = [];
    // Root never installs a browser: the installer shares one with every agent, or each agent's worker installs its own.
    const prepared = spyOn(BrowserManager.prototype, "prepareInBackground").mockImplementation(async () => {});
    const daemon = new RunnerDaemon({
      probeEgress: async () => null,
      home,
      mode: "start",
      log: () => {},
      watch: false,
      executors: () => ({}),
      self: { command: ["/opt/agentes-runner/agentes-runner"], compiled: true },
      caffeinate: false,
      dial: (_url, handlers) => {
        const s = new FakeSocket(handlers);
        sockets.push(s);
        return s;
      },
      workers: {
        user: userOf,
        start: (user) => {
          const w = new FakeWorker(user);
          workers.push(w);
          return w;
        },
      },
    });
    daemon.start();
    try {
      await waitFor(() => sockets.length === 1);
      expect(prepared).not.toHaveBeenCalled();
      let installing = 0;
      const shown = daemon.openBrowser(ANA, () => void installing++);
      await waitFor(() => workers.length === 1);
      const ana = workers[0] as FakeWorker;
      ana.hello();
      await waitFor(() => ana.of("browser.show").length === 1);
      const show = ana.of("browser.show")[0] as { showId: string };
      ana.send({ type: "browser.showing", showId: show.showId });
      ana.send({ type: "browser.shown", showId: show.showId });
      await shown;
      expect(installing).toBe(1);
      daemon.pause(null);
      expect(await errorCode(() => daemon.openBrowser(ANA, () => {}))).toBe("paused");
      expect(ana.of("browser.show")).toHaveLength(1);
    } finally {
      prepared.mockRestore();
      await daemon.stop();
    }
  },
);

test.if(posix)(
  "a system-mode runner lists Claude's own login only once its switch is on and its self-check passed",
  async () => {
    const run = async (claudeSharedLogin: unknown, verdict: string | null, retried?: string | null) => {
      const home = newHome();
      const ws = tempDir("root-ws-");
      dirs.push(ws);
      writeConfig(
        {
          server: "https://agentes.test",
          machineId: "m1",
          name: "box",
          token: "agm_machine_token_never_shown_123456",
          workspace: ws,
          mode: "system",
          agentUidRange: [21000, 21099],
          ...(claudeSharedLogin ? { claudeSharedLogin } : {}),
        } as StoredConfig,
        home,
      );
      const sockets: FakeSocket[] = [];
      let swept = 0;
      let checks = 0;
      const daemon = new RunnerDaemon({
        probeEgress: async () => null,
        home,
        mode: "start",
        log: () => {},
        watch: false,
        executors: () => ({}),
        self: { command: ["/opt/agentes-runner/agentes-runner"], compiled: true },
        caffeinate: false,
        dial: (_url, handlers) => {
          const s = new FakeSocket(handlers);
          sockets.push(s);
          queueMicrotask(() => handlers.onOpen());
          return s;
        },
        workers: { user: userOf, start: (user) => new FakeWorker(user) },
        accountUsers: {
          sweep: () => void swept++,
          stopScopes: () => {},
          sweepAgent: () => {},
          launcher: () => ({ prefix: [], env: {}, home }),
          remove: () => {},
          ensure: () => {
            throw new Error("no user here");
          },
          room: () => {},
          bridge: () => "",
          carry: () => {},
        },
        selfCheck: async () => {
          checks++;
          return checks > 1 && retried !== undefined ? retried : verdict;
        },
        ...(retried !== undefined ? { selfCheckRetryMs: 50 } : {}),
      });
      daemon.start();
      return { daemon, sockets, swept: () => swept, checks: () => checks };
    };
    const hellos = (sockets: FakeSocket[]) =>
      sockets.flatMap((s) => s.of("hello")) as { claudeLoginMethods?: string[]; claudeLoginBlocked?: string }[];

    const off = await run(undefined, null);
    await waitFor(() => hellos(off.sockets).length === 1);
    expect(off.swept()).toBe(1);
    expect(off.checks()).toBe(0);
    expect(hellos(off.sockets)[0]).toMatchObject({ claudeLoginMethods: ["setup_token"] });
    expect(hellos(off.sockets)[0]).not.toHaveProperty("claudeLoginBlocked");
    await off.daemon.stop();

    const on = { refresh: "A" };
    const passed = await run(on, null);
    await waitFor(
      () => hellos(passed.sockets).at(-1)?.claudeLoginMethods?.toString() === "setup_token,cli_login",
      8000,
    );
    expect(passed.daemon.accounts.claudeLoginMethods()).toEqual(["setup_token", "cli_login"]);
    await passed.daemon.stop();

    const failed = await run(on, "The Claude CLI kept a tool of its own (Bash)");
    await waitFor(() => failed.checks() === 1 && hellos(failed.sockets).length >= 1);
    expect(failed.daemon.accounts.claudeLoginMethods()).toEqual(["setup_token"]);
    failed.daemon.reconnect();
    await waitFor(() => hellos(failed.sockets).at(-1)?.claudeLoginBlocked !== undefined, 8000);
    expect(hellos(failed.sockets).at(-1)?.claudeLoginBlocked).toContain("Bash");
    await failed.daemon.stop();

    // A failure at a busy moment (boot, a relay starting) is tried again soon, not only at the next 6-hourly run.
    const recovered = await run(on, "The Claude CLI didn't start as the sign-in's user", null);
    await waitFor(
      () => hellos(recovered.sockets).at(-1)?.claudeLoginMethods?.toString() === "setup_token,cli_login",
      8000,
    );
    expect(recovered.checks()).toBe(2);
    await recovered.daemon.stop();
  },
  20_000,
);

/** A system-mode daemon of Ana's with the login's switch on, its self-check answered by the test. */
function sharedLoginDaemon() {
  const home = newHome();
  const ws = tempDir("root-ws-");
  dirs.push(ws);
  const ana = userOf(ANA);
  writeFileSync(path.join(home, AGENT_USERS_FILE), JSON.stringify([ana]));
  const config = {
    server: "https://agentes.test",
    machineId: "m1",
    name: "box",
    token: "agm_machine_token_never_shown_123456",
    workspace: ws,
    mode: "system",
    agentUidRange: [21000, 21099],
    access: STATE.access,
  } as StoredConfig;
  const claudeSharedLogin = { refresh: "A" as const };
  writeConfig({ ...config, claudeSharedLogin }, home);
  const sockets: FakeSocket[] = [];
  const events: string[] = [];
  const checks: ((verdict: string | null) => void)[] = [];
  const logs: string[] = [];
  const daemon = new RunnerDaemon({
    probeEgress: async () => null,
    home,
    mode: "start",
    log: (line) => void logs.push(line),
    executors: () => ({}),
    self: { command: ["/opt/agentes-runner/agentes-runner"], compiled: true },
    caffeinate: false,
    dial: (_url, handlers) => {
      const s = new FakeSocket(handlers);
      sockets.push(s);
      queueMicrotask(() => handlers.onOpen());
      return s;
    },
    workers: { user: userOf, start: (user) => new FakeWorker(user) },
    accountUsers: {
      sweep: () => {},
      stopScopes: () => void events.push("stop"),
      sweepAgent: () => void events.push("sweep"),
      launcher: () => ({ prefix: [], env: {}, home }),
      remove: () => {},
      ensure: () => {
        throw new Error("no user here");
      },
      room: () => {},
      bridge: () => "",
      carry: () => {},
    },
    selfCheck: () => new Promise((resolve) => checks.push(resolve)),
  });
  const hellos = () => sockets.flatMap((s) => s.of("hello")) as { claudeLoginMethods?: string[] }[];
  const lists = (method: boolean) =>
    waitFor(() => hellos().at(-1)?.claudeLoginMethods?.includes("cli_login") === method, 8000);
  /** The connection that has the daemon's session, welcomed. */
  const online = () => {
    const s = sockets.at(-1) as FakeSocket;
    s.frame({ type: "welcome", machineId: "m1", name: "box", heartbeatMs: 25_000 });
    return s;
  };
  return { home, config, claudeSharedLogin, daemon, sockets, events, checks, logs, lists, online };
}

test.if(posix)(
  "a change to the login's switch asks the self-check again, and the server hears of it",
  async () => {
    const d = sharedLoginDaemon();
    const keep = spyOn(BrainManager.prototype, "keepAccount");
    const invalidate = spyOn(AccountManager.prototype, "invalidate");
    const { config, claudeSharedLogin, home, daemon, checks } = d;
    const methods = () => daemon.accounts.claudeLoginMethods();
    daemon.start();
    try {
      await waitFor(() => checks.length === 1);
      expect(invalidate).not.toHaveBeenCalled();
      checks[0]?.(null);
      await d.lists(true);
      // The looks before the pass said "status unknown" for every Claude login: the next list asks again.
      expect(invalidate).toHaveBeenCalledTimes(1);
      d.online().frame({ type: "agents", agents: [{ ...ANA, account: SHARED_LOGIN }] });
      expect(keep).toHaveBeenLastCalledWith(SHARED_LOGIN, undefined, ANA.id);

      // The same switch with a version range an older guard still writes: no change, nothing stopped or asked again.
      writeConfig(
        {
          ...config,
          claudeSharedLogin: { minVersion: "2.1.300", maxVersion: "2.1.320", ...claudeSharedLogin } as never,
        },
        home,
      );
      await waitFor(() => d.logs.includes("config.json changed; applying it"), 5000);
      expect(checks).toHaveLength(1);
      expect(d.events).not.toContain("stop");
      expect(methods()).toEqual(["setup_token", "cli_login"]);

      // Another refresh mode: the pass was for the last switch, and nothing runs on it until this one's answer.
      const modeB = { refresh: "B" as const, refreshLock: ".refresh.lock" };
      writeConfig({ ...config, claudeSharedLogin: modeB }, home);
      await waitFor(() => checks.length === 2, 5000);
      expect(methods()).toEqual(["setup_token"]);
      expect(keep).toHaveBeenLastCalledWith(null, [], ANA.id);
      await d.lists(false);
      checks[1]?.(null);
      await d.lists(true);
      expect(methods()).toEqual(["setup_token", "cli_login"]);
      expect(keep).toHaveBeenLastCalledWith(SHARED_LOGIN, undefined, ANA.id);

      // Off, the method leaves at once; the next on starts from nothing, and no answer from before counts.
      writeConfig(config, home);
      await d.lists(false);
      expect(checks).toHaveLength(2);
      writeConfig({ ...config, claudeSharedLogin }, home);
      await waitFor(() => checks.length === 3, 5000);
      expect(methods()).toEqual(["setup_token"]);
      writeConfig({ ...config, claudeSharedLogin: modeB }, home);
      await waitFor(() => checks.length === 4, 5000);
      checks[2]?.(null);
      await new Promise((r) => setTimeout(r, 20));
      expect(methods()).toEqual(["setup_token"]);

      // A failed check closes what is idle on the store too.
      checks[3]?.("An agent's user reached the sign-in's folders");
      await new Promise((r) => setTimeout(r, 20));
      expect(keep).toHaveBeenLastCalledWith(null, [], ANA.id);
    } finally {
      keep.mockRestore();
      invalidate.mockRestore();
      await daemon.stop();
    }
  },
  30_000,
);

test.if(posix)(
  "an agent leaving its computer keeps what its sign-ins hold; only a deleted one is cleared",
  async () => {
    const d = sharedLoginDaemon();
    const { daemon, events, checks } = d;
    const drop = spyOn(AccountBrains.prototype, "dropTurns").mockImplementation((err, agentId) => {
      events.push(`drop ${err.code} ${agentId ?? "all"}`);
    });
    daemon.start();
    try {
      await waitFor(() => checks.length === 1);
      checks[0]?.(null);
      await d.lists(true);
      const s = d.online();
      s.frame({ type: "agents", agents: [ANA] });
      expect(events).toEqual([]);
      // Archived or moved: its CLIs stop, turn first; its transcripts wait for it.
      s.frame({ type: "agents", agents: [] });
      expect(events).toEqual([`drop dropped ${ANA.id}`, "stop"]);
      events.length = 0;
      s.frame({ type: "agents", agents: [ANA] });
      s.frame({ type: "agents", agents: [ANA], deleted: [ANA.id] });
      expect(events).toEqual([]);
      s.frame({ type: "agents", agents: [], deleted: [ANA.id] });
      expect(events).toEqual([`drop dropped ${ANA.id}`, "sweep"]);
      events.length = 0;
      s.frame({ type: "agents", agents: [], deleted: [ANA.id] });
      expect(events).toEqual([]);

      daemon.pause(null);
      expect(events).toEqual(["drop dropped all", "stop"]);
    } finally {
      drop.mockRestore();
      await daemon.stop();
    }
  },
  20_000,
);

test.if(posix)("the login switch going away stops that login's running CLIs, and only then", async () => {
  const home = newHome();
  const ws = tempDir("root-ws-");
  dirs.push(ws);
  const ana = userOf(ANA);
  writeFileSync(path.join(home, AGENT_USERS_FILE), JSON.stringify([ana]));
  const config = {
    server: "https://agentes.test",
    machineId: "m1",
    name: "box",
    token: "agm_machine_token_never_shown_123456",
    workspace: ws,
    mode: "system",
    agentUidRange: [21000, 21099],
  } as StoredConfig;
  const claudeSharedLogin = { refresh: "A" as const };
  writeConfig({ ...config, claudeSharedLogin }, home);
  const stopped: number[] = [];
  const daemon = new RunnerDaemon({
    probeEgress: async () => null,
    home,
    mode: "start",
    log: () => {},
    executors: () => ({}),
    self: { command: ["/opt/agentes-runner/agentes-runner"], compiled: true },
    caffeinate: false,
    dial: (_url, handlers) => new FakeSocket(handlers),
    workers: { user: userOf, start: (user) => new FakeWorker(user) },
    accountUsers: {
      sweep: () => {},
      stopScopes: (uid) => void stopped.push(uid),
      sweepAgent: () => {},
      launcher: () => ({ prefix: [], env: {}, home }),
      remove: () => {},
      ensure: () => {
        throw new Error("no user here");
      },
      room: () => {},
      bridge: () => "",
      carry: () => {},
    },
    selfCheck: async () => null,
  });
  daemon.start();
  try {
    writeConfig({ ...config, claudeSharedLogin, name: "desk" }, home);
    await new Promise((r) => setTimeout(r, 300));
    expect(stopped).toEqual([]);
    writeConfig(config, home);
    await waitFor(() => stopped.length > 0, 5000);
    expect(stopped).toEqual([ana.uid]);
  } finally {
    await daemon.stop();
  }
});

test.if(posix)(
  "a system-mode runner hosts a shared CLI login's turns in root, and tells them apart by its marker",
  async () => {
    const home = newHome();
    const ws = tempDir("root-ws-");
    const accounts = tempDir("accounts-");
    dirs.push(ws, accounts);
    mkdirSync(path.join(accounts, "claude_code"));
    writeFileSync(path.join(accounts, "claude_code", `${SHARED_LOGIN}.method`), "cli_shared");
    writeConfig(
      {
        server: "https://agentes.test",
        machineId: "m1",
        name: "box",
        token: "agm_machine_token_never_shown_123456",
        workspace: ws,
        mode: "system",
        agentUidRange: [21000, 21099],
        access: STATE.access,
        claudeSharedLogin: { refresh: "A" },
      } as StoredConfig,
      home,
    );
    const sockets: FakeSocket[] = [];
    const started: FakeWorker[] = [];
    const daemon = new RunnerDaemon({
      probeEgress: async () => null,
      home,
      mode: "start",
      log: () => {},
      watch: false,
      executors: () => ({}),
      self: { command: ["/opt/agentes-runner/agentes-runner"], compiled: true },
      caffeinate: false,
      dial: (_url, handlers) => {
        const s = new FakeSocket(handlers);
        sockets.push(s);
        queueMicrotask(() => handlers.onOpen());
        return s;
      },
      workers: {
        user: userOf,
        start: (user) => {
          const w = new FakeWorker(user);
          started.push(w);
          return w;
        },
      },
      systemAccounts: { root: accounts, chown: async () => {} },
      accountUsers: {
        sweep: () => {},
        stopScopes: () => {},
        sweepAgent: () => {},
        launcher: () => ({ prefix: [], env: {}, home }),
        remove: () => {},
        ensure: (id) => ({ id, user: "agc-0193ffff", uid: 30000, gid: 998 }),
        room: () => {},
        bridge: () => "/run/agentes-bridge/21000/mcp.sock",
        carry: () => {},
      },
      selfCheck: async () => null,
    });
    daemon.start();
    try {
      const listed = (s: FakeSocket) =>
        (s.of("hello").at(-1) as { claudeLoginMethods?: string[] } | undefined)?.claudeLoginMethods?.includes(
          "cli_login",
        );
      await waitFor(() => sockets.some(listed), 8000);
      const s = sockets.find(listed) as FakeSocket;
      s.frame({ type: "welcome", machineId: "m1", name: "box", heartbeatMs: 25_000 });
      s.frame({ type: "request", id: "t1", ...hostedTurn() } as ServerFrame);
      await waitFor(() => started.length === 1);
      const ana = started[0] as FakeWorker;
      ana.hello();
      await waitFor(() => ana.of("turn.prepare").length === 1);
      expect(ana.of("request")).toHaveLength(0);
      ana.send({
        type: "turn.context",
        prepareId: ana.of("turn.prepare")[0]?.prepareId,
        error: { code: "bad_request", message: "Not this folder" },
      });
      await waitFor(() => s.of("result").length === 1);
      expect(s.of("result")[0]).toMatchObject({
        id: "t1",
        ok: true,
        data: { final: { type: "error", code: "bad_request", message: "Not this folder" } },
      });
    } finally {
      await daemon.stop();
    }
  },
  20_000,
);

test("a worker that stops or retires takes what root launched for its agent on a sign-in with it", async () => {
  const stopped: number[] = [];
  const { sup, workers } = setup({ stopAccountScopes: (uid) => void stopped.push(uid) });
  const pending = sup.run({ op: "exec", command: "x", agent: ANA } as never, scope().scope);
  await waitFor(() => workers.length === 1);
  const ana = workers[0] as FakeWorker;
  ana.hello();
  sup.retireNetworkAgent(ANA.id, "network changed");
  await pending.catch(() => undefined);
  expect(stopped).toEqual([ana.user.uid]);
});

test.if(posix)(
  "a single-user runner: Browser clicked on an agent's desktop opens that agent's own browser here, unless paused",
  async () => {
    const home = newHome();
    const ws = tempDir("single-ws-");
    dirs.push(ws);
    writeConfig(
      {
        server: "https://agentes.test",
        machineId: "m1",
        name: "box",
        token: "agm_machine_token_never_shown_123456",
        workspace: ws,
        exec: true,
        access: { folders: [], tools: { claude: false, codex: false, commands: true, browser: true, desktop: true } },
      },
      home,
    );
    const shown: [AgentScope, string][] = [];
    const show = spyOn(BrowserManager.prototype, "show").mockImplementation(async (agent, folder, installing) => {
      shown.push([agent, folder]);
      installing();
    });
    // As it starts, with the browser on, it installs what the agents' first browser command would.
    const prepared = spyOn(BrowserManager.prototype, "prepareInBackground").mockImplementation(async () => {});
    const sockets: FakeSocket[] = [];
    const daemon = new RunnerDaemon({
      probeEgress: async () => null,
      home,
      mode: "start",
      log: () => {},
      watch: false,
      executors: () => ({}),
      self: { command: ["/opt/agentes-runner/agentes-runner"], compiled: true },
      caffeinate: false,
      dial: (_url, handlers) => {
        const s = new FakeSocket(handlers);
        sockets.push(s);
        return s;
      },
    });
    daemon.start();
    try {
      await waitFor(() => sockets.length === 1);
      expect(prepared).toHaveBeenCalledTimes(1);
      let installing = 0;
      await daemon.openBrowser(ANA, () => void installing++);
      // This runner's own BrowserManager, on the agent's folder in the workspace: no worker in between.
      expect(shown).toEqual([[ANA, path.join(realpathSync(ws), "ana-a1b2c3d4")]]);
      expect(installing).toBe(1);
      daemon.pause(null);
      expect(await errorCode(() => daemon.openBrowser(ANA, () => {}))).toBe("paused");
      expect(shown).toHaveLength(1);
    } finally {
      show.mockRestore();
      prepared.mockRestore();
      await daemon.stop();
    }
  },
);

test("the launch line: the agent's launcher, then this runner's worker with the agent's own home outside its folder", () => {
  const ana = USERS[0] as AgentUser;
  const runner = ["/opt/agentes-runner/bin/bun", "/opt/agentes-runner/agentes-runner.mjs"];
  const home = "/var/lib/agentes-runner-agents/ag-a1b2c3d4";
  // A systemd older than 253 (no OOMPolicy on scopes), and no Podman: the same on any computer the test runs on.
  const cmd = workerCommand(ana, runner, home, true, false, false);
  expect(cmd.argv).toEqual([
    ...systemLauncher(ana, true, false, false).prefix,
    ...runner,
    "worker",
    "--agent",
    ANA.id,
    "--dir",
    "/home/ag-a1b2c3d4",
    "--home",
    home,
  ]);
  expect(cmd.argv.slice(0, 5)).toEqual([
    "/usr/bin/systemd-run",
    "--quiet",
    "--scope",
    "--collect",
    "--slice=agents-21000.slice",
  ]);
  expect(cmd.cwd).toBe("/home/ag-a1b2c3d4");
  // Only the launcher's environment: never the root runner's own (its token, its home).
  expect(Object.keys(cmd.env).sort()).toEqual([
    "AGENTES_SHARED_BIN",
    "ANDROID_ADB_SERVER_PORT",
    "GRADLE_OPTS",
    "HOME",
    "LANG",
    "LOGNAME",
    "PATH",
    "SHELL",
    "USER",
  ]);
  // With rootless containers (ADR 0169): its runtime dir, and Podman's socket for docker and podman alike.
  expect(workerCommand(ana, runner, home, true, false, true).env).toMatchObject({
    XDG_RUNTIME_DIR: "/run/user/21000",
    CONTAINER_HOST: "unix:///run/user/21000/podman/podman.sock",
    DOCKER_HOST: "unix:///run/user/21000/podman/podman.sock",
  });
  expect(workerCommand(ana, runner, home, false).argv.slice(0, 4)).toEqual([
    "/usr/sbin/runuser",
    "-u",
    "ag-a1b2c3d4",
    "--",
  ]);
});

test.if(posix)("a worker's home: its agent's own, in a folder nobody else can list", () => {
  const base = path.join(tempDir("worker-homes-"), "agents");
  dirs.push(path.dirname(base));
  const me: AgentUser = { id: ANA.id, user: "ag-a1b2c3d4", uid: process.getuid?.() ?? 0 };
  const dir = workerHome(base, me);
  expect(dir).toBe(path.join(base, "ag-a1b2c3d4"));
  expect(statSync(base).mode & 0o777).toBe(0o711);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(statSync(dir).uid).toBe(me.uid);
  expect(workerHome(base, me)).toBe(dir);
});

test.if(posix)(
  "system broker keeps pending material out of the worker and installs only after activation",
  async () => {
    const t = realWorkers();
    t.sup.boot();
    t.sup.attach();
    const requestId = "broker-0001-aaaa";
    const name = "BROKER_TEST_KEY";
    const target = { kind: "env" as const };
    const value = "broker-secret-value";
    const key = await t.sup.secret({ op: "secret", agent: ANA, action: "keypair", requestId }, scope().scope);
    const aad = secretAad({ requestId, orgId: "org-1", name, target });
    const box = await sealSecret(key.publicKey as string, value, aad);
    expect(
      await t.sup.secret(
        { op: "secret", agent: ANA, action: "deliver", requestId, name, target, aad, box },
        scope().scope,
      ),
    ).toEqual({ size: value.length });
    expect(existsSync(path.join(t.home, "secret-broker", "a1b2c3d4", "keys", requestId))).toBe(true);
    expect(existsSync(path.join(t.ownHome, "secrets", "a1b2c3d4", "keys", requestId))).toBe(false);
    expect(await agentSecrets(path.join(t.ownHome, "secrets"), ANA)).toBeNull();
    const order = `2026-10-29T00:00:00.000Z|${requestId}`;
    expect(
      await t.sup.secret({ op: "secret", agent: ANA, action: "activate", requestId, order }, scope().scope),
    ).toEqual({ size: value.length });
    expect((await agentSecrets(path.join(t.ownHome, "secrets"), ANA))?.env[name]).toBe(value);
    expect(await agentSecrets(path.join(t.ownHome, "secrets"), BIA)).toBeNull();
    expect(existsSync(path.join(t.home, "secret-broker", "a1b2c3d4", "keys", requestId))).toBe(false);

    const declined = "broker-0002-bbbb";
    const declinedKey = await t.sup.secret(
      { op: "secret", agent: ANA, action: "keypair", requestId: declined },
      scope().scope,
    );
    const declinedAad = secretAad({ requestId: declined, orgId: "org-1", name: "OTHER_KEY", target });
    const declinedBox = await sealSecret(declinedKey.publicKey as string, "never-installed", declinedAad);
    await t.sup.secret(
      {
        op: "secret",
        agent: ANA,
        action: "deliver",
        requestId: declined,
        name: "OTHER_KEY",
        target,
        aad: declinedAad,
        box: declinedBox,
      },
      scope().scope,
    );
    // A failed DB transaction or a decline sends discard rather than activate.
    await t.sup.secret({ op: "secret", agent: ANA, action: "discard", requestId: declined }, scope().scope);
    expect((await agentSecrets(path.join(t.ownHome, "secrets"), ANA))?.env.OTHER_KEY).toBeUndefined();
    await t.sup.secret({ op: "secret", agent: ANA, action: "remove", name, throughOrder: order }, scope().scope);
    expect((await agentSecrets(path.join(t.ownHome, "secrets"), ANA))?.env[name]).toBeUndefined();
    expect((await agentSecrets(path.join(t.home, "secret-broker"), ANA))?.env[name]).toBeUndefined();
    expect(
      await errorCode(() => t.sup.secret({ op: "secret", agent: ANA, action: "remove", name }, scope().scope)),
    ).toBe("bad_request");
  },
);

test.if(posix)(
  "system broker: a site's password ends in the worker's memory; neither store.json holds it",
  async () => {
    const t = realWorkers();
    t.sup.boot();
    t.sup.attach();
    const requestId = "broker-site-0001";
    const name = "SHOP_PASSWORD";
    const target = { kind: "site" as const, site: "https://shop.example.com" };
    const value = "broker-site-password";
    const key = await t.sup.secret({ op: "secret", agent: ANA, action: "keypair", requestId }, scope().scope);
    const aad = secretAad({ requestId, orgId: "org-1", name, target });
    const box = await sealSecret(key.publicKey as string, value, aad);
    await t.sup.secret(
      { op: "secret", agent: ANA, action: "deliver", requestId, name, target, aad, box },
      scope().scope,
    );
    const order = `2026-11-03T00:00:00.000Z|${requestId}`;
    const activate = () =>
      t.sup.secret({ op: "secret", agent: ANA, action: "activate", requestId, order }, scope().scope);
    expect(await activate()).toEqual({ size: value.length });
    // The worker's browser types it from memory (ADR 0144); root handed its copy on.
    expect(await secretValue(path.join(t.ownHome, "secrets"), ANA, name)).toEqual({ value, site: target.site });
    expect(await secretValue(path.join(t.home, "secret-broker"), ANA, name)).toBeNull();
    for (const store of [
      path.join(t.home, "secret-broker", "a1b2c3d4", "store.json"),
      path.join(t.ownHome, "secrets", "a1b2c3d4", "store.json"),
    ]) {
      expect(existsSync(store) ? readFileSync(store, "utf8") : "").not.toContain(value);
    }
    // A lost reply asked again: answered, nothing sent to the worker again.
    expect(await activate()).toEqual({ size: value.length });
  },
);

test.if(posix)("system mode: a Vault key is made in the agent's worker, and its keys open there", async () => {
  const t = realWorkers();
  t.sup.boot();
  t.sup.attach();
  const { vaultKey } = (await handleRequest(t.ctx, { agent: ANA, op: "vault.key" }, scope().scope)) as {
    vaultKey: { keyId: string; publicKey: string };
  };
  const value = "sk_test_worker_vault_key";
  const use = { kind: "env" as const, name: "STRIPE_KEY" };
  const sealed = await sealSecret(vaultKey.publicKey, value, vaultAad({ keyId: vaultKey.keyId, agentId: ANA.id, use }));
  const vault = { keyId: vaultKey.keyId, keys: [{ name: "STRIPE_KEY", box: sealed }] };
  const ran = (await handleRequest(
    t.ctx,
    { ...exec(ANA, `test "$STRIPE_KEY" = "${value}" && echo "ok $STRIPE_KEY"`), stream: false, vault },
    scope().scope,
  )) as { stdout: string };
  expect(ran.stdout).toBe("ok [secret:STRIPE_KEY]\n");
});

test.if(posix && process.platform === "linux" && process.getuid?.() === 0)(
  "upgrade retires old pending keys and boxes without following agent symlinks or losing active values",
  async () => {
    const base = path.join(tempDir("legacy-worker-homes-"), "agents");
    dirs.push(path.dirname(base));
    const me: AgentUser = { id: ANA.id, user: "ag-a1b2c3d4", uid: 0 };
    const home = workerHome(base, me);
    const own = path.join(home, "secrets", "a1b2c3d4");
    mkdirSync(path.join(own, "keys"), { recursive: true });
    mkdirSync(path.join(own, "staged"), { recursive: true });
    writeFileSync(path.join(own, "keys", "legacy-0001"), "old-private-key");
    writeFileSync(path.join(own, "staged", "legacy-0001"), "old-sealed-box");
    writeFileSync(path.join(own, "store.json"), '{"secrets":[]}');
    const outside = path.join(base, "sentinel");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "keep"), "untouched");
    linkSync(path.join(outside, "keep"), path.join(own, "keys", "linked"));
    retireLegacyPending(base, home, me);
    expect(existsSync(path.join(own, "keys"))).toBe(false);
    expect(existsSync(path.join(own, "staged"))).toBe(false);
    expect(readFileSync(path.join(own, "store.json"), "utf8")).toBe('{"secrets":[]}');
    expect(readFileSync(path.join(outside, "keep"), "utf8")).toBe("untouched");
    const broker = setup();
    expect(
      await errorCode(() =>
        broker.sup.secret(
          {
            op: "secret",
            agent: ANA,
            action: "activate",
            requestId: "legacy-0001",
            order: "2026-10-29T00:00:00.000Z|legacy-0001",
          },
          scope().scope,
        ),
      ),
    ).toBe("not_found");
    symlinkSync(outside, path.join(own, "keys"));
    expect(() => retireLegacyPending(base, home, me)).toThrow();
    expect(readFileSync(path.join(outside, "keep"), "utf8")).toBe("untouched");
    mkdirSync(path.join(own, "keys"));
    writeFileSync(path.join(own, "keys", "replanted"), "old-key");
    expect(() =>
      retireLegacyPending(base, home, me, (name) => {
        if (name !== "keys") return;
        mkdirSync(path.join(own, "keys"));
        writeFileSync(path.join(own, "keys", "replanted"), "old-key");
      }),
    ).toThrow("recreated");
  },
);

test("lines: split across chunks, UTF-8 kept whole, and a line too long is skipped without being held", async () => {
  const stream = new PassThrough();
  const lines: string[] = [];
  let tooLong = 0;
  readLines(
    stream,
    10,
    (l) => lines.push(l),
    () => tooLong++,
  );
  const olá = Buffer.from("olá\n");
  stream.write(olá.subarray(0, 3));
  stream.write(olá.subarray(3));
  stream.write("a\nb");
  stream.write("c\n");
  stream.write("x".repeat(8));
  stream.write("y".repeat(8));
  stream.write("zzz\nafter\n");
  stream.write(`${"q".repeat(11)}\nend\n`);
  await waitFor(() => lines.length === 5);
  expect(lines).toEqual(["olá", "a", "bc", "after", "end"]);
  expect(tooLong).toBe(2);
});

test.if(posix)("route changes discard in-flight egress observations and reconnect starts unknown", async () => {
  const home = newHome();
  const ws = tempDir("egress-ws-");
  dirs.push(ws);
  writeConfig(
    {
      server: "https://agentes.test",
      machineId: "m1",
      name: "box",
      token: "agm_test_observation_only",
      workspace: ws,
      exec: false,
      mode: "system",
      agentUidRange: [21000, 21099],
    },
    home,
  );
  const probes: { uid: number | undefined; resolve: (v: unknown) => void }[] = [];
  const sockets: FakeSocket[] = [];
  const daemon = new RunnerDaemon({
    home,
    mode: "start",
    log: () => {},
    watch: false,
    executors: () => ({}),
    caffeinate: false,
    self: { command: ["/opt/agentes-runner/agentes-runner"], compiled: true },
    fetch: async () => new Response("", { status: 404 }),
    probeEgress: async (_server, user) => new Promise((resolve) => probes.push({ uid: user?.uid, resolve })),
    workers: { user: userOf, start: (user) => new FakeWorker(user) },
    dial: (_url, handlers) => {
      const s = new FakeSocket(handlers);
      sockets.push(s);
      return s;
    },
  });
  daemon.start();
  try {
    await waitFor(() => sockets.length === 1);
    const s = sockets[0] as FakeSocket;
    s.handlers.onOpen();
    s.frame({ type: "welcome", machineId: "m1", name: "box", heartbeatMs: 25000, observeEgress: true });
    s.frame({ type: "agents", agents: [ANA] });
    await waitFor(() => probes.length === 1);
    expect(probes[0]?.uid).toBe(21000);
    s.frame({ type: "agents", agents: [BIA] });
    probes[0]?.resolve({ ip: "8.8.8.8", country: "US" });
    await waitFor(() => probes.length === 2);
    expect(probes[1]?.uid).toBe(21001);
    probes[1]?.resolve({ ip: "1.1.1.1" });
    await waitFor(() => s.of("pong").some((f) => JSON.stringify(f.egress ?? null).includes("1.1.1.1")));
    expect(s.of("pong").some((f) => JSON.stringify(f.egress ?? null).includes("8.8.8.8"))).toBe(false);
    daemon.reconnect();
    await waitFor(() => sockets.length === 2);
    const next = sockets[1] as FakeSocket;
    next.handlers.onOpen();
    next.frame({ type: "welcome", machineId: "m1", name: "box", heartbeatMs: 25000, observeEgress: true });
    next.frame({ type: "ping", at: 1 });
    expect(next.of("pong").at(-1)?.egress).toBeUndefined();
    await waitFor(() => probes.length === 3);
    probes[2]?.resolve({ ip: "9.9.9.9" });
    await waitFor(() => next.of("pong").some((f) => JSON.stringify(f.egress ?? null).includes("9.9.9.9")));
  } finally {
    for (const p of probes) p.resolve(null);
    await daemon.stop();
  }
});

test.if(posix)("three idle samples clear the exit IP until an agent context resumes", async () => {
  const home = newHome();
  // This test supplies existing contexts through the lookup below, without a saved-user fallback.
  writeFileSync(path.join(home, AGENT_USERS_FILE), "[]");
  const ws = tempDir("idle-egress-");
  dirs.push(ws);
  writeConfig(
    {
      server: "https://agentes.test",
      machineId: "m1",
      name: "box",
      token: "agm_test_idle_observation",
      workspace: ws,
      exec: false,
      mode: "system",
      agentUidRange: [21000, 21099],
    },
    home,
  );
  let context: AgentUser | undefined = userOf(ANA);
  let answer = { ip: "8.8.8.8", country: "US" };
  let probes = 0;
  let workers = 0;
  const sockets: FakeSocket[] = [];
  const pageUpdates = spyOn(BrowserManager.prototype, "updateStartPages");
  const daemon = new RunnerDaemon({
    home,
    mode: "start",
    log: () => {},
    watch: false,
    executors: () => ({}),
    caffeinate: false,
    self: { command: ["/opt/agentes-runner/agentes-runner"], compiled: true },
    fetch: async () => new Response("", { status: 404 }),
    probeEgress: async () => {
      probes++;
      return answer;
    },
    workers: {
      // The test's existing-context lookup returns nothing once all agent contexts have drained.
      user: () => context as AgentUser,
      start: (user) => {
        workers++;
        return new FakeWorker(user);
      },
    },
    dial: (_url, handlers) => {
      const socket = new FakeSocket(handlers);
      sockets.push(socket);
      return socket;
    },
  });
  // Drive the regular 30-second sampler without wall-clock waits or starting an agent for a probe.
  const sample = () => (daemon as unknown as { sampleEgress(): Promise<void> }).sampleEgress();
  daemon.start();
  try {
    await waitFor(() => sockets.length === 1);
    const socket = sockets[0] as FakeSocket;
    socket.handlers.onOpen();
    socket.frame({ type: "welcome", machineId: "m1", name: "box", heartbeatMs: 25000, observeEgress: true });
    socket.frame({ type: "agents", agents: [ANA] });
    await waitFor(() => socket.of("pong").some((frame) => JSON.stringify(frame.egress) === JSON.stringify(answer)));
    const observed = socket.of("pong").length;
    const sampled = probes;
    context = undefined;
    await sample();
    await sample();
    expect(socket.of("pong")).toHaveLength(observed);
    const updated = pageUpdates.mock.calls.length;
    await sample();
    expect(socket.of("pong").at(-1)?.egress).toEqual({ ip: null });
    expect(pageUpdates.mock.calls.length).toBeGreaterThan(updated);
    expect(probes).toBe(sampled);
    expect(workers).toBe(0);
    await sample();
    expect(socket.of("pong")).toHaveLength(observed + 1);

    context = userOf(ANA);
    answer = { ip: "1.1.1.1", country: "AU" };
    await sample();
    expect(socket.of("pong").at(-1)?.egress).toEqual(answer);
    expect(probes).toBe(sampled + 1);
    expect(workers).toBe(0);
  } finally {
    pageUpdates.mockRestore();
    await daemon.stop();
  }
});

test("workers restored before a server welcome inherit root network configuration", async () => {
  const home = newHome();
  writeFileSync(
    path.join(home, "worker-tasks.json"),
    JSON.stringify({
      task1: { agentId: ANA.id, startedAt: new Date().toISOString() },
    }),
  );
  const network = { networkLauncher: "/root/network-launcher", networkMark: 0x08000000 };
  const t = setup({ network }, home);
  t.sup.boot();
  await waitFor(() => t.workers.length === 1);
  expect(t.workers[0]?.user).toEqual({ ...(USERS[0] as AgentUser), ...network });
  const stored = JSON.parse(readFileSync(path.join(home, AGENT_USERS_FILE), "utf8"));
  expect(stored[0].networkLauncher).toBeUndefined();
  expect(stored[0].networkMark).toBeUndefined();
});

test("network changes preserve an occupied worker and viewers, then retire it before the next launch", async () => {
  let viewers = 1;
  const t = setup({ desktopViewers: () => viewers });
  t.sup.boot();
  t.sup.attach();
  const run = t.sup.run(exec(ANA), scope().scope);
  await waitFor(() => t.workers.length === 1);
  const old = t.last(ANA.id);
  old.hello();
  const req = await requestOn(old);
  const network = { networkLauncher: "/root/network-launcher", networkMark: 0x08000000 };
  t.sup.setNetwork(network);
  expect(t.sup.drainNetwork()).toEqual([21000]);
  expect(old.stdin.writableEnded).toBe(false);
  old.send({ type: "result", ok: true, id: req.id, data: execDone });
  await run;
  expect(t.sup.drainNetwork()).toEqual([21000]);
  expect(old.stdin.writableEnded).toBe(false);
  viewers = 0;
  t.sup.drainNetwork();
  await old.exited;
  await waitFor(() => t.sup.drainNetwork().length === 0);
  expect(old.killed).toBe(false);
  const again = t.sup.run(exec(ANA), scope().scope);
  await waitFor(() => t.workers.length === 2);
  const next = t.last(ANA.id);
  expect(next.user).toMatchObject(network);
  next.hello();
  const nextReq = await requestOn(next);
  next.send({ type: "result", ok: true, id: nextReq.id, data: execDone });
  await again;
});

test("a stopped worker whose new network can't be prepared doesn't hold the drain", async () => {
  let fail = false;
  let network: { networkMark?: number } = {};
  const t = setup({
    resolveNetwork: () => {
      if (fail) throw new Error("Cannot inspect browser bind test ports: cgroupv2 path fails");
      return network;
    },
  });
  t.sup.boot();
  t.sup.attach();
  const run = t.sup.run(exec(ANA), scope().scope);
  await waitFor(() => t.workers.length === 1);
  const worker = t.last(ANA.id);
  worker.hello();
  const req = await requestOn(worker);
  worker.send({ type: "result", ok: true, id: req.id, data: execDone });
  await run;
  worker.crash(0);
  await worker.exited;
  fail = true;
  network = { networkMark: 0x08000000 };
  t.sup.setNetwork(network);
  expect(t.sup.drainNetwork()).toEqual([]);
});

test("a running background task delays network retirement until its acknowledged completion", async () => {
  const home = newHome();
  writeFileSync(
    path.join(home, WORKER_TASKS_FILE),
    JSON.stringify({ task1: { agentId: ANA.id, startedAt: new Date().toISOString() } }),
  );
  const t = setup({}, home);
  t.sup.boot();
  t.sup.attach();
  const worker = t.last(ANA.id);
  worker.hello();
  t.sup.setNetwork({ networkMark: 0x08000000 });
  expect(t.sup.drainNetwork()).toEqual([21000]);
  expect(worker.stdin.writableEnded).toBe(false);
  t.sup.ack("task1");
  t.sup.drainNetwork();
  await worker.exited;
  await waitFor(() => t.sup.drainNetwork().length === 0);
  expect(worker.killed).toBe(false);
});

test.if(posix)("editing only network settings applies without reconnecting or interrupting a request", async () => {
  const home = newHome();
  const ws = tempDir("network-change-");
  dirs.push(ws);
  const config = {
    server: "https://agentes.test",
    machineId: "m1",
    name: "box",
    token: "agm_test_only",
    workspace: ws,
    exec: true,
    mode: "system" as const,
    agentUidRange: [21000, 21099] as [number, number],
  };
  writeConfig(config, home);
  const workers: FakeWorker[] = [];
  const sockets: FakeSocket[] = [];
  const probed: AgentUser[] = [];
  const daemon = new RunnerDaemon({
    home,
    mode: "start",
    log: () => {},
    watch: true,
    executors: () => ({}),
    caffeinate: false,
    self: { command: ["/opt/agentes-runner/agentes-runner"], compiled: true },
    fetch: async () => new Response("", { status: 404 }),
    probeEgress: async (_server, user) => {
      if (user) probed.push(user);
      return null;
    },
    workers: {
      user: userOf,
      start: (user) => {
        const w = new FakeWorker(user);
        workers.push(w);
        return w;
      },
    },
    dial: (_url, handlers) => {
      const s = new FakeSocket(handlers);
      sockets.push(s);
      return s;
    },
  });
  daemon.start();
  try {
    await waitFor(() => sockets.length === 1);
    const socket = sockets[0] as FakeSocket;
    socket.handlers.onOpen();
    socket.frame({ type: "welcome", machineId: "m1", name: "box", heartbeatMs: 25000, observeEgress: true });
    socket.frame({ type: "agents", agents: [ANA] });
    socket.frame({ type: "request", id: "work", ...exec(ANA) });
    await waitFor(() => workers.length === 1);
    const old = workers[0] as FakeWorker;
    old.hello();
    const req = await requestOn(old);
    const network = { networkLauncher: "/root/network-launcher", networkMark: 0x08000000 };
    await waitFor(() => probed.length > 0);
    const before = probed.length;
    writeConfig({ ...config, ...network }, home);
    await waitFor(() => probed.length > before);
    // A root-side probe (like a new desktop or terminal) retains the occupied worker's context.
    expect(probed.at(-1)?.networkLauncher).toBeUndefined();
    expect(old.of("worker.state").at(-1)?.privateNetwork).toBe(false);
    expect(sockets).toHaveLength(1);
    expect(old.stdin.writableEnded).toBe(false);
    old.send({ type: "result", ok: true, id: req.id, data: execDone });
    await waitFor(() => socket.of("result").some((x) => x.id === "work"));
    await waitFor(() => old.stdin.writableEnded, 5000);
    socket.frame({ type: "request", id: "next", ...exec(ANA) });
    await waitFor(() => workers.length === 2);
    const next = workers[1] as FakeWorker;
    expect(next.user).toMatchObject(network);
    next.hello();
    const nextReq = await requestOn(next);
    next.send({ type: "result", ok: true, id: nextReq.id, data: execDone });
    await waitFor(() => socket.of("result").some((x) => x.id === "next"));
    expect(sockets).toHaveLength(1);
    expect(old.killed).toBe(false);
  } finally {
    await daemon.stop();
  }
});

test("a retained desktop or terminal pins a new worker to the same old network until both drain", async () => {
  const target = { networkLauncher: "/root/net", networkMark: 0x08000000 };
  const pins = new AgentNetworks({}, [{ uid: 21000 }]);
  pins.set(target);
  let desktop = true;
  let terminal = true;
  const t = setup({
    network: target,
    networkBusy: () => desktop || terminal,
    resolveNetwork: (user) => pins.resolve(user.uid, desktop || terminal || t.sup.runningNetwork(user.id) !== null),
  });
  t.sup.boot();
  t.sup.attach();
  const run = t.sup.run(exec(ANA), scope().scope);
  const old = t.last(ANA.id);
  old.hello();
  const req = await requestOn(old);
  old.send({ type: "result", ok: true, id: req.id, data: execDone });
  await run;
  expect(old.user.networkLauncher).toBeUndefined();
  expect(t.sup.drainNetwork()).toEqual([21000]);
  desktop = false;
  t.sup.drainNetwork();
  expect(old.stdin.writableEnded).toBe(false);
  terminal = false;
  t.sup.drainNetwork();
  await old.exited;
  await waitFor(() => t.sup.drainNetwork().length === 0);
  const nextRun = t.sup.run(exec(ANA), scope().scope);
  await waitFor(() => t.workers.length === 2);
  const next = t.last(ANA.id);
  expect(next.user).toMatchObject(target);
  next.hello();
  const nextReq = await requestOn(next);
  next.send({ type: "result", ok: true, id: nextReq.id, data: execDone });
  await nextRun;
});

test("browser stream and desktop leases prevent idle network retirement", async () => {
  let now = 100000;
  const t = setup({ now: () => now });
  t.sup.boot();
  t.sup.attach();
  const stream = t.sup.run({ op: "browser.stream.start", mode: "watch", agent: ANA } as MachineRequest, scope().scope);
  const worker = t.last(ANA.id);
  worker.hello();
  const req = await requestOn(worker);
  worker.send({ type: "result", ok: true, id: req.id, data: { mode: "watch" } });
  await stream;
  t.sup.setNetwork({ networkMark: 0x08000000 });
  expect(worker.stdin.writableEnded).toBe(false);
  worker.send({ type: "browser.desktop", agentId: ANA.id, active: true });
  worker.send({ type: "browser.stream.ended", agentId: ANA.id, reason: "stopped" });
  await waitFor(() => t.sup.onDesktopInUse(ANA.id));
  t.sup.drainNetwork();
  expect(worker.stdin.writableEnded).toBe(false);
  now += 120000;
  t.sup.drainNetwork();
  await worker.exited;
  expect(worker.killed).toBe(false);
});

test("a late hello cannot reopen a retiring worker to a new request", async () => {
  const t = setup();
  t.sup.boot();
  t.sup.attach();
  const run = t.sup.run(exec(ANA), scope().scope);
  const old = t.last(ANA.id);
  old.hello();
  const req = await requestOn(old);
  old.send({ type: "result", ok: true, id: req.id, data: execDone });
  await run;
  old.stdin.removeAllListeners("end");
  t.sup.setNetwork({ networkMark: 0x08000000 });
  old.hello();
  const nextRun = t.sup.run(exec(ANA), scope().scope);
  await new Promise((r) => setTimeout(r, 10));
  expect(old.of("request")).toHaveLength(1);
  old.crash(0);
  await waitFor(() => t.workers.length === 2);
  const next = t.last(ANA.id);
  expect(next.user.networkMark).toBe(0x08000000);
  next.hello();
  const nextReq = await requestOn(next);
  next.send({ type: "result", ok: true, id: nextReq.id, data: execDone });
  await nextRun;
});

test.if(posix)(
  "a managed finite drain holds new work until the switch and retries owned desktop retirement without a roster",
  async () => {
    const home = newHome();
    const ws = tempDir("network-deadline-");
    dirs.push(ws);
    let now = Date.now();
    const config = {
      server: "https://agentes.test",
      machineId: "m1",
      name: "box",
      token: "agm_test_only",
      workspace: ws,
      exec: true,
      mode: "system" as const,
      agentUidRange: [21000, 21099] as [number, number],
      networkDrainSeconds: 60,
    };
    writeConfig(config, home);
    const workers: FakeWorker[] = [];
    const sockets: FakeSocket[] = [];
    const daemon = new RunnerDaemon({
      home,
      mode: "start",
      log: () => {},
      watch: true,
      now: () => now,
      executors: () => ({}),
      caffeinate: false,
      self: { command: ["/opt/agentes-runner/agentes-runner"], compiled: true },
      fetch: async () => new Response("", { status: 404 }),
      probeEgress: async () => null,
      workers: {
        user: userOf,
        start: (user) => {
          const worker = new FakeWorker(user);
          workers.push(worker);
          return worker;
        },
      },
      dial: (_url, handlers) => {
        const socket = new FakeSocket(handlers);
        sockets.push(socket);
        return socket;
      },
    });
    let desktopStops = 0;
    const stopDesktop = spyOn(DesktopSessions.prototype, "stop").mockImplementation(async (agent) => {
      expect(agent.id).toBe(ANA.id);
      if (++desktopStops === 1) throw new Error("Transient desktop stop failure");
      return { stopped: true };
    });
    daemon.start();
    try {
      await waitFor(() => sockets.length === 1);
      const socket = sockets[0] as FakeSocket;
      socket.handlers.onOpen();
      socket.frame({ type: "welcome", machineId: "m1", name: "box", heartbeatMs: 25000, observeEgress: true });
      // A restored owned desktop must close even if its agent is absent from the cached roster.
      socket.frame({ type: "request", id: "active", ...exec(ANA) });
      await waitFor(() => workers.length === 1);
      const old = workers[0] as FakeWorker;
      old.hello();
      await requestOn(old);
      const target = { networkLauncher: "/root/network-launcher", networkMark: 0x08000000 };
      writeConfig({ ...config, ...target }, home);
      await waitFor(() =>
        socket.of("pong").some((p) => (p.networkTransition as { state?: string } | undefined)?.state === "draining"),
      );
      expect(old.stdin.writableEnded).toBe(false);
      socket.frame({ type: "request", id: "new-work", ...exec(ANA) });
      await new Promise((r) => setTimeout(r, 700));
      expect(socket.of("result").some((r) => r.id === "new-work")).toBe(false);
      // Keep the old UID alive until the failed desktop stop has been retried.
      old.stdin.removeAllListeners("end");
      now += 61_000;
      await waitFor(() => old.stdin.writableEnded, 5000);
      expect(
        socket
          .of("pong")
          .some((p) => (p.networkTransition as { state?: string } | undefined)?.state === "restart_required"),
      ).toBe(true);
      // The in-flight request's failure goes out after the worker's input ends, not in the same tick.
      await waitFor(() => socket.of("result").some((r) => r.id === "active"), 5000);
      expect(socket.of("result").find((r) => r.id === "active")?.ok).toBe(false);
      await waitFor(() => desktopStops === 2, 5000);
      old.crash(0);
      await waitFor(() => workers.length === 2, 5000);
      const next = workers[1] as FakeWorker;
      expect(next.user).toMatchObject(target);
      next.hello();
      const held = await requestOn(next);
      // The wait came out of the command's own timeout, inside the server's deadline for it.
      expect(held.timeoutSeconds).toBeLessThan(10);
      next.send({ type: "result", ok: true, id: held.id, data: execDone });
      await waitFor(() => socket.of("result").some((r) => r.id === "new-work"));
      expect(socket.of("result").find((r) => r.id === "new-work")?.ok).toBe(true);
    } finally {
      stopDesktop.mockRestore();
      await daemon.stop();
    }
  },
  15000,
);

test("a restored owner with a temporarily unavailable network does not prevent connection and retries after drain", async () => {
  const home = newHome();
  writeFileSync(
    path.join(home, WORKER_TASKS_FILE),
    JSON.stringify({ restored: { agentId: ANA.id, startedAt: new Date().toISOString() } }),
  );
  let blocked = true;
  const target = { networkLauncher: "/root/net", networkMark: 0x08000000, networkRevision: 2 };
  const t = setup(
    {
      network: target,
      resolveNetwork: () => {
        if (blocked) throw new Error("The prior UID context is draining");
        return target;
      },
    },
    home,
  );
  expect(() => t.sup.boot()).not.toThrow();
  t.sup.attach();
  expect(t.workers).toHaveLength(0);
  expect(t.sup.list()).toMatchObject([{ taskId: "restored", agentId: ANA.id }]);
  blocked = false;
  t.sup.drainNetwork();
  await waitFor(() => t.workers.length === 1, 5000);
  const worker = t.last(ANA.id);
  worker.hello();
  await waitFor(() => worker.of("welcome").length === 1);
  expect(worker.user).toMatchObject(target);
  expect(t.sup.list()).toMatchObject([{ taskId: "restored", agentId: ANA.id }]);
});

test("clone slots are the computer's: two at once across every agent's worker; a stopped worker gives its back; the cache sees the worker's own uid", async () => {
  const filled: { repo: string; uid: number }[] = [];
  const t = setup({
    gitCache: async (input) => {
      filled.push({ repo: input.repo, uid: input.uid });
      return `/var/cache/agentes-git/conn/${input.repo}.git`;
    },
  });
  t.sup.boot();
  t.sup.attach();
  // Both agents' workers running (each started by a request of its agent).
  for (const agent of [ANA, BIA]) handleRequest(t.ctx, exec(agent), scope().scope).catch(() => {});
  await waitFor(() => t.workers.length === 2);
  const ana = t.last(ANA.id);
  const bia = t.last(BIA.id);
  ana.hello();
  bia.hello();
  const slotted = (w: FakeWorker, slotId: string) => w.of("clone.slotted").filter((f) => f.slotId === slotId);

  ana.send({ type: "clone.slot", slotId: "1" });
  ana.send({ type: "clone.slot", slotId: "2" });
  await waitFor(() => ana.of("clone.slotted").length === 2);
  bia.send({ type: "clone.slot", slotId: "1" });
  await waitFor(() => slotted(bia, "1").length === 1);
  expect(slotted(bia, "1")[0]?.waiting).toBe(true);

  // Ana's first clone ends: Bia's starts.
  ana.send({ type: "clone.release", slotId: "1" });
  await waitFor(() => slotted(bia, "1").length === 2);
  expect(slotted(bia, "1")[1]?.waiting).toBeUndefined();

  // A third one waits until Ana's worker stops, which gives back the slot it held.
  bia.send({ type: "clone.slot", slotId: "2" });
  await waitFor(() => slotted(bia, "2").length === 1);
  ana.crash();
  await waitFor(() => slotted(bia, "2").length === 2);
  bia.send({ type: "clone.release", slotId: "1" });
  bia.send({ type: "clone.release", slotId: "2" });

  // The cache is filled for the worker's own agent, whatever the frame says.
  bia.send({ type: "cache.fill", fillId: "f1", connection: "conn", repo: "acme/app", github: "ghs_x", uid: 0 });
  await waitFor(() => bia.of("cache.filled").length === 1);
  expect(filled).toEqual([{ repo: "acme/app", uid: 21001 }]);
  expect(bia.of("cache.filled")[0]?.dir).toBe("/var/cache/agentes-git/conn/acme/app.git");
});

// ── A Claude sign-in several agents share: its turns run in root, as its own user ────────────────────────────────────

const SHARED_LOGIN = "0193ffff-0000-7000-8000-000000000002";
const FAKE_CLI = path.join(import.meta.dir, "fake-claude.mjs");
const HOSTED_SESSION = "0193aaaa-0000-7000-8000-000000000001";

const hostedTurn = (over: Record<string, unknown> = {}) =>
  ({
    op: "brain.turn",
    kind: "claude_code",
    runId: "run-00000001",
    session: { id: HOSTED_SESSION, resume: false },
    prompt: "hi",
    account: SHARED_LOGIN,
    mcp: { token: `agr_${"t".repeat(26)}` },
    agent: ANA,
    ...over,
  }) as unknown as Extract<MachineRequest, { op: "brain.turn" }>;

/** What a worker of `t` says to root's asks about a turn, until `stop`. */
function answersAsWorker(w: FakeWorker, folder: string) {
  let told = 0;
  let bridged = 0;
  const timer = setInterval(() => {
    for (const f of w.of("turn.prepare").slice(told)) {
      told++;
      w.send({
        type: "turn.context",
        prepareId: f.prepareId,
        folder,
        cwd: f.cwd ?? folder,
        text: "\n\nfrom the worker",
      });
    }
    for (const f of w.of("bridge.token").slice(bridged)) {
      bridged++;
      if (f.token !== null) w.send({ type: "bridge.ready", process: f.process });
    }
  }, 2);
  return () => clearInterval(timer);
}

function hosted(t: ReturnType<typeof setup>, over: Partial<AccountBrainsOptions> = {}) {
  const stores = tempDir("stores-");
  dirs.push(stores);
  const log = path.join(stores, "spawns.log");
  const state: { now: "ready" | "off" | "signed_out" } = { now: "ready" };
  const usage: unknown[][] = [];
  const refused: string[] = [];
  const store = path.join(stores, SHARED_LOGIN);
  const brains = new AccountBrains({
    root: path.join(stores, "account-brains"),
    stores,
    accounts: {
      isCliShared: (_kind, id) => id === SHARED_LOGIN,
      cliSharedState: () => state.now,
      sharedCommand: (prefix) => [...prefix, process.execPath, FAKE_CLI],
      noteRateLimit: (key, info) => void usage.push([key, info]),
    },
    users: {
      ensure: (id) => ({ id, user: "agc-0193ffff", uid: 30000, gid: 998 }),
      room: (_user, room) => void mkdirSync(path.join(store, "run", String(room)), { recursive: true }),
      bridge: () => "/run/agentes-bridge/21000/mcp.sock",
      carry: () => {},
    },
    workers: t.sup,
    grants: async () => [],
    relay: ["/usr/local/bin/agentes-runner"],
    shared: () => undefined,
    launcher: (_login, agent, cwd) => ({
      prefix: [],
      env: { PATH: process.env.PATH ?? "", HOME: stores, FAKE_CLAUDE_LOG: log, FAKE_CWD: String(cwd) },
      home: path.join(store, "run", String(agent?.uid)),
    }),
    deltaMs: 5,
    ...over,
  });
  const ctx: HandlerContext = {
    ...t.ctx,
    accountBrains: brains,
    access: () => STATE.access,
    accounts: {
      list: async () => [],
      refused: async (_kind: string, id: string) => void refused.push(id),
      invalidate: () => {},
      refresh: async () => [],
    } as unknown as AccountManager,
  };
  return { brains, ctx, state, usage, refused, store, log };
}

test.if(posix)("a turn on a shared CLI login runs in root: its worker serves it, and gets no request", async () => {
  const t = setup();
  const h = hosted(t);
  t.sup.boot();
  t.sup.attach();
  const s = scope();
  const run = handleRequest(h.ctx, hostedTurn(), s.scope);
  await waitFor(() => t.workers.length === 1);
  const ana = t.last(ANA.id);
  ana.hello();
  const stop = answersAsWorker(ana, "/home/ag-a1b2c3d4/ana-a1b2c3d4");
  const out = (await run) as { runId: string; final: { type: string; text?: string } };
  stop();
  expect(out.final).toMatchObject({ type: "done", text: "echo 1: hi" });
  expect(s.emitted.map((f) => f.type)).toContain("brain.done");
  expect(s.emitted.some((f) => f.type === "brain.event")).toBe(true);
  expect(ana.of("request")).toHaveLength(0);
  const bridges = ana.of("bridge.token");
  expect(bridges[0]).toMatchObject({
    session: HOSTED_SESSION,
    cwd: "/home/ag-a1b2c3d4/ana-a1b2c3d4",
    profile: "work",
    agent: ANA,
    socketPath: "/run/agentes-bridge/21000/mcp.sock",
  });
  expect(bridges[1]).toMatchObject({ runId: "run-00000001", serverToken: `agr_${"t".repeat(26)}` });
  // The folder's text comes with its own ask, from the agent's side.
  expect(ana.of("turn.prepare").map((f) => f.text ?? false)).toEqual([false, true]);
  const log = JSON.parse(readFileSync(h.log, "utf8").trim().split("\n")[0] as string);
  expect(log.system).toContain("from the worker");
  h.brains.brains.close();
});

test.if(posix)("a sign-in that isn't a shared CLI login goes to the worker, as it always did", async () => {
  const t = setup();
  const h = hosted(t);
  t.sup.boot();
  t.sup.attach();
  const other = "0193ffff-0000-7000-8000-000000000009";
  const run = handleRequest(h.ctx, hostedTurn({ account: other }), scope().scope);
  await waitFor(() => t.workers.length === 1);
  const ana = t.last(ANA.id);
  ana.hello();
  const q = await requestOn(ana);
  expect(q).toMatchObject({ op: "brain.turn", account: other });
  ana.send({
    type: "result",
    id: q.id,
    ok: true,
    data: { runId: "run-00000001", final: { type: "done", text: "ok" } },
  });
  await run;
  expect(ana.of("turn.prepare")).toHaveLength(0);
  expect(ana.of("bridge.token")).toHaveLength(0);
});

test.if(posix)("steering and cancel follow the turn to root, and reach the worker's tools", async () => {
  const t = setup();
  const h = hosted(t);
  t.sup.boot();
  t.sup.attach();
  const s = scope();
  const run = handleRequest(h.ctx, hostedTurn({ prompt: "SLOW wait" }), s.scope);
  await waitFor(() => t.workers.length === 1);
  const ana = t.last(ANA.id);
  ana.hello();
  const stop = answersAsWorker(ana, "/home/ag-a1b2c3d4/ana-a1b2c3d4");
  await waitFor(() => h.brains.brains.hosts("run-00000001"));
  const steer = {
    op: "brain.steer",
    runId: "run-00000001",
    session: HOSTED_SESSION,
    messages: [{ uuid: "0193cccc-0000-7000-8000-000000000001", text: "more" }],
    agent: ANA,
  } as unknown as MachineRequest;
  // The fake here is an old CLI: what counts is that root answered, and the worker never saw it.
  await waitFor(() => (h.brains.brains.process(ANA.id, HOSTED_SESSION)?.initSeen ?? false) === true);
  expect(await handleRequest(h.ctx, steer, scope().scope)).toMatchObject({ status: "unsupported" });
  expect(ana.of("request")).toHaveLength(0);
  s.ac.abort();
  const out = (await run) as { final: { code?: string } };
  stop();
  expect(out.final.code).toBe("canceled");
  await waitFor(() => ana.of("turn.cancel").length === 1);
  expect(ana.of("turn.cancel")[0]).toEqual({ type: "turn.cancel", session: HOSTED_SESSION });
});

test.if(posix)("a steer for a run root doesn't host still goes to the worker", async () => {
  const t = setup();
  const h = hosted(t);
  t.sup.boot();
  t.sup.attach();
  const steer = {
    op: "brain.steer",
    runId: "run-00000009",
    session: HOSTED_SESSION,
    messages: [{ uuid: "0193cccc-0000-7000-8000-000000000001", text: "more" }],
    agent: ANA,
  } as unknown as MachineRequest;
  const run = handleRequest(h.ctx, steer, scope().scope);
  await waitFor(() => t.workers.length === 1);
  const ana = t.last(ANA.id);
  ana.hello();
  const q = await requestOn(ana);
  ana.send({ type: "result", id: q.id, ok: true, data: { status: "no_turn" } });
  expect(await run).toEqual({ status: "no_turn" });
});

test.if(posix)("a worker that goes away under a hosted turn drops it, so the server resumes it", async () => {
  const t = setup();
  const h = hosted(t);
  t.sup.boot();
  t.sup.attach();
  const s = scope();
  const run = handleRequest(h.ctx, hostedTurn({ prompt: "SLOW wait" }), s.scope);
  await waitFor(() => t.workers.length === 1);
  const ana = t.last(ANA.id);
  ana.hello();
  const stop = answersAsWorker(ana, "/home/ag-a1b2c3d4/ana-a1b2c3d4");
  await waitFor(() => h.brains.brains.hosts("run-00000001"));
  ana.crash();
  expect(await errorCode(() => run)).toBe("dropped");
  stop();
  expect(s.emitted.flatMap((f) => (f.type === "brain.event" ? [f.event.type] : []))).not.toContain("error");
  expect(s.emitted.some((f) => f.type === "brain.done")).toBe(false);
});

test.if(posix)("a turn dropped on purpose ends now: its CLI isn't taken for crashed and started again", async () => {
  const t = setup();
  const h = hosted(t);
  t.sup.boot();
  t.sup.attach();
  const s = scope();
  const run = handleRequest(h.ctx, hostedTurn({ prompt: "SLOW wait" }), s.scope);
  await waitFor(() => t.workers.length === 1);
  const ana = t.last(ANA.id);
  ana.hello();
  const stop = answersAsWorker(ana, "/home/ag-a1b2c3d4/ana-a1b2c3d4");
  await waitFor(() => h.brains.brains.hosts("run-00000001"));
  await waitFor(() => existsSync(h.log));
  h.brains.dropTurns(new RunnerError("dropped", "Not this agent."), BIA.id);
  expect(h.brains.brains.hosts("run-00000001")).toBe(true);
  h.brains.dropTurns(new RunnerError("dropped", "This computer was paused."));
  expect(await errorCode(() => run)).toBe("dropped");
  await sleep(100);
  stop();
  const started = readFileSync(h.log, "utf8")
    .trim()
    .split("\n")
    .filter((l) => JSON.parse(l).args);
  expect(started).toHaveLength(1);
  expect(s.emitted.some((f) => f.type === "brain.done")).toBe(false);
});

test.if(posix)("the network waits for a hosted turn, and goes on once it ended", async () => {
  const t = setup();
  const h = hosted(t);
  t.sup.boot();
  t.sup.attach();
  const run = handleRequest(h.ctx, hostedTurn({ prompt: "SLOW wait" }), scope().scope);
  await waitFor(() => t.workers.length === 1);
  const ana = t.last(ANA.id);
  ana.hello();
  const stop = answersAsWorker(ana, "/home/ag-a1b2c3d4/ana-a1b2c3d4");
  await waitFor(() => h.brains.brains.hosts("run-00000001"));
  t.sup.setNetwork({ networkMark: 0x08000000 });
  expect(t.sup.drainNetwork()).toEqual([21000]);
  expect(ana.of("worker.close")).toHaveLength(0);
  expect(ana.stdin.writableEnded).toBe(false);
  await run;
  stop();
  t.sup.drainNetwork();
  expect(ana.stdin.writableEnded).toBe(true);
  h.brains.brains.close();
});

test.if(posix)("a hosted turn that can't run says why, with no CLI and no worker", async () => {
  const t = setup();
  const h = hosted(t);
  t.sup.boot();
  t.sup.attach();
  h.state.now = "off";
  const off = (await handleRequest(h.ctx, hostedTurn(), scope().scope)) as { final: unknown };
  expect(off.final).toEqual({ type: "error", code: "unsupported", message: SHARED_LOGIN_OFF, retryable: true });
  expect(h.refused).toEqual([]);
  h.state.now = "signed_out";
  const out = (await handleRequest(h.ctx, hostedTurn(), scope().scope)) as { final: unknown };
  expect(out.final).toMatchObject({ type: "error", code: "not_logged_in", retryable: true });
  await waitFor(() => h.refused.length === 1);
  expect(t.workers).toHaveLength(0);
  const closed = { ...h.ctx, access: () => ({ ...STATE.access, tools: { ...STATE.access.tools, claude: false } }) };
  expect(await errorCode(() => handleRequest(closed, hostedTurn(), scope().scope))).toBe("not_allowed");
});

test.if(posix)(
  "short of memory: a hosted idle CLI closes first, the waiting session's own only after the workers'",
  async () => {
    const t = setup();
    const h = hosted(t);
    const reclaimed: string[] = [];
    const reclaimBrains = spyOn(t.sup, "reclaimBrains").mockImplementation(async (spare) => {
      reclaimed.push(String(spare));
      return false;
    });
    t.sup.boot();
    t.sup.attach();
    const run = handleRequest(h.ctx, hostedTurn(), scope().scope);
    await waitFor(() => t.workers.length === 1);
    const ana = t.last(ANA.id);
    ana.hello();
    const stop = answersAsWorker(ana, "/home/ag-a1b2c3d4/ana-a1b2c3d4");
    await run;
    stop();
    const spare = `${ANA.id}:${HOSTED_SESSION}`;
    // Only the waiting session's own is idle here: the workers are asked first, and it closes when they have nothing.
    expect(await h.brains.reclaim(spare)).toBe(true);
    expect(reclaimed).toEqual([spare]);
    expect(await h.brains.reclaim(spare)).toBe(false);
    reclaimBrains.mockRestore();
  },
);

test.if(posix)("own MCP servers and a folder the worker refuses end the turn with the reason", async () => {
  const t = setup();
  const h = hosted(t);
  t.sup.boot();
  t.sup.attach();
  const run = handleRequest(h.ctx, hostedTurn({ personalMcp: true }), scope().scope);
  await waitFor(() => t.workers.length === 1);
  const ana = t.last(ANA.id);
  ana.hello();
  expect(((await run) as { final: unknown }).final).toMatchObject({
    code: "unsupported",
    message: PERSONAL_MCP_REFUSED,
  });
  const second = handleRequest(h.ctx, hostedTurn({ cwd: "repos/gone" }), scope().scope);
  await waitFor(() => ana.of("turn.prepare").length === 1);
  ana.send({
    type: "turn.context",
    prepareId: ana.of("turn.prepare")[0]?.prepareId,
    error: { code: "not_found", message: "The folder repos/gone doesn't exist" },
  });
  expect(((await second) as { final: unknown }).final).toMatchObject({
    code: "bad_request",
    message: "The folder repos/gone doesn't exist",
  });
});

const HOSTED_TASK = "0193bbbb-0000-7000-8000-000000000001";
const FOLDER = "/home/ag-a1b2c3d4/ana-a1b2c3d4";

const hostedRoute = (over: Record<string, unknown> = {}) =>
  ({
    op: "brain.route",
    kind: "claude_code",
    account: SHARED_LOGIN,
    system: "You route messages.",
    prompt: "@/var/lib/agentes-claude/x/config/.credentials.json who answers?",
    schema: { type: "object", properties: { scores: { type: "array", items: { type: "object" } } } },
    agent: ANA,
    ...over,
  }) as unknown as Extract<MachineRequest, { op: "brain.route" }>;

const hostedTask = (over: Record<string, unknown> = {}) =>
  ({
    op: "task.start",
    taskId: HOSTED_TASK,
    executor: "claude",
    prompt: "fix it",
    session: HOSTED_SESSION,
    account: SHARED_LOGIN,
    agent: ANA,
    ...over,
  }) as unknown as MachineRequest;

/** A task its worker prepared, the CLI running in root until `done`: what that worker heard, in order. */
async function startHostedTask(req: MachineRequest, host: Record<string, unknown> = {}) {
  const t = setup({ grant: async () => ({ kind: "hosted" }) });
  const h = hosted(t);
  t.sup.boot();
  t.sup.attach();
  const run = handleRequest(h.ctx, req, scope().scope);
  await waitFor(() => t.workers.length === 1);
  const ana = t.last(ANA.id);
  ana.hello();
  const stop = answersAsWorker(ana, FOLDER);
  const q = await requestOn(ana);
  const data = {
    taskId: HOSTED_TASK,
    pid: 42,
    startedAt: new Date().toISOString(),
    cwd: "",
    command: "claude",
    host: { cwd: FOLDER, where: "", git: true, maxSeconds: 60, ...host },
  };
  ana.send({ type: "result", id: q.id, ok: true, data });
  const reply = (await run) as Record<string, unknown>;
  const done = async () => {
    await waitFor(() => ana.of("task.exit").length === 1);
    stop();
    h.brains.brains.close();
    return ana.of("task.exit")[0] as Record<string, unknown>;
  };
  return { t, h, ana, q, reply, done };
}

test.if(posix)("a route on a shared CLI login runs in root, with no tools and an empty folder", async () => {
  const t = setup();
  const h = hosted(t);
  t.sup.boot();
  t.sup.attach();
  const run = handleRequest(h.ctx, hostedRoute(), scope().scope);
  await waitFor(() => t.workers.length === 1);
  const ana = t.last(ANA.id);
  ana.hello();
  const stop = answersAsWorker(ana, FOLDER);
  const out = (await run) as { json: unknown; model: string };
  stop();
  expect(out.model).toBeDefined();
  expect(out.json).toBeDefined();
  expect(ana.of("request")).toHaveLength(0);
  expect(ana.of("bridge.token")).toHaveLength(0);
  const [start, said] = readFileSync(h.log, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  expect(start.args[start.args.indexOf("--tools") + 1]).toBe("");
  expect(start.args).toContain("--no-session-persistence");
  expect(start.cwd.endsWith(path.join("run", "21000"))).toBe(true);
  expect(said.system).toBe("You route messages.");
  // The CLI would read that file itself, as the sign-in's user.
  expect(said.prompt).toStartWith("\u200b@/var/lib");
  expect(said.prompt).toContain("who answers?");
  // What the route wrote for the CLI goes with it.
  expect(readdirSync(path.join(h.store, "run", "21000")).filter((f) => f.startsWith("route-"))).toEqual([]);
});

test.if(posix)("a route or a task on a shared CLI login that can't run says why, and nothing starts", async () => {
  const t = setup();
  const h = hosted(t);
  t.sup.boot();
  t.sup.attach();
  h.state.now = "off";
  expect(await errorCode(() => handleRequest(h.ctx, hostedRoute(), scope().scope))).toBe("unsupported");
  expect(await errorCode(() => handleRequest(h.ctx, hostedTask(), scope().scope))).toBe("unsupported");
  h.state.now = "signed_out";
  expect(await errorCode(() => handleRequest(h.ctx, hostedRoute(), scope().scope))).toBe("not_found");
  expect(await errorCode(() => handleRequest(h.ctx, hostedTask(), scope().scope))).toBe("not_found");
  expect(t.workers).toHaveLength(0);
  expect(existsSync(h.log)).toBe(false);
});

test.if(posix)(
  "a task on a shared CLI login: its worker prepares it, root runs the CLI, the lines go back",
  async () => {
    const s = await startHostedTask(hostedTask({ prompt: "@/etc/shadow fix it" }), { where: "Your branch: a/b." });
    expect(s.q.grant).toEqual({ kind: "hosted" });
    // Root's word to the worker, never the server's.
    expect(s.reply.host).toBeUndefined();
    expect(s.reply).toMatchObject({ taskId: HOSTED_TASK, pid: 42 });
    const exit = await s.done();
    expect(exit).toMatchObject({ exitCode: 0, signal: null, reason: null });
    const lines = s.ana.of("task.out").map((f) => String(f.line));
    expect(lines.some((l) => l.includes('"type":"result"'))).toBe(true);
    expect(lines.some((l) => l.includes('"stream_event"'))).toBe(false);
    const start = JSON.parse(readFileSync(s.h.log, "utf8").trim().split("\n")[0] as string);
    expect(start.args[start.args.indexOf("--tools") + 1]).toBe("ToolSearch");
    expect(start.args).toContain("--strict-mcp-config");
    expect(start.args).toContain(HOSTED_SESSION);
    // The turn's id is the task's, for the server's tools; outside a mission only the prompt tool is there.
    expect(s.ana.of("bridge.token")[0]).toMatchObject({ task: "local", profile: "work", session: HOSTED_SESSION });
    expect(s.ana.of("bridge.token")[1]).toMatchObject({ runId: HOSTED_TASK });
    expect(s.ana.of("bridge.token")[1]?.serverToken).toBeUndefined();
    expect(s.ana.of("turn.prepare")[0]).toMatchObject({ cwd: FOLDER });
  },
);

test.if(posix)(
  "a mission task's CLI gets its rules, mode, allow list and server token from root's request",
  async () => {
    const mission = {
      id: "0193cccc-0000-7000-8000-000000000001",
      rules: "Ask before any deploy.",
      allow: ["Bash(swift *)", 3],
      mode: "plan",
      mcpToken: `agr_${"m".repeat(26)}`,
    };
    const s = await startHostedTask(hostedTask({ mission }));
    await s.done();
    const start = JSON.parse(readFileSync(s.h.log, "utf8").trim().split("\n")[0] as string);
    expect(start.system).toContain("Ask before any deploy.");
    expect(s.ana.of("bridge.token")[0]).toMatchObject({ task: "mission", profile: "plan", allow: ["Bash(swift *)"] });
    expect(s.ana.of("bridge.token")[1]).toMatchObject({ runId: HOSTED_TASK, serverToken: mission.mcpToken });
  },
);

test.if(posix)("a mission task in a folder with no git gets the rules for that", async () => {
  const mission = { id: "0193cccc-0000-7000-8000-000000000001", rules: "Ask before any deploy." };
  const s = await startHostedTask(hostedTask({ mission }), { git: false });
  await s.done();
  const start = JSON.parse(readFileSync(s.h.log, "utf8").trim().split("\n")[0] as string);
  expect(start.system).not.toContain("Ask before any deploy.");
  expect(start.system).toContain("not a git repository");
});

test.if(posix)("a worker stops its task's CLI, and no other agent's", async () => {
  const s = await startHostedTask(hostedTask({ prompt: "SLOW wait" }));
  await waitFor(() => existsSync(s.h.log));
  s.h.brains.stopTask(BIA.id, HOSTED_TASK);
  await sleep(20);
  expect(s.ana.of("task.exit")).toHaveLength(0);
  s.h.brains.stopTask(ANA.id, HOSTED_TASK);
  expect(await s.done()).toMatchObject({ exitCode: null, signal: "SIGTERM", reason: "canceled" });
});

test.if(posix)("a task's time limit ends its CLI as timed out", async () => {
  const s = await startHostedTask(hostedTask({ prompt: "SLOW wait" }), { maxSeconds: 0.05 });
  expect(await s.done()).toMatchObject({ reason: "timeout" });
});

test.if(posix)("a task's refused CLI marks the sign-in and tells the worker why", async () => {
  const s = await startHostedTask(hostedTask({ prompt: "AUTH" }));
  expect(await s.done()).toMatchObject({ exitCode: 1, reason: null });
  expect(s.h.refused).toEqual([SHARED_LOGIN]);
  expect(s.ana.of("task.out").some((f) => f.stream === "stderr")).toBe(true);
});

test.if(posix)("a worker that goes away ends its task's CLI, which reads as interrupted", async () => {
  const s = await startHostedTask(hostedTask({ prompt: "SLOW wait" }));
  await waitFor(() => existsSync(s.h.log));
  s.ana.crash();
  await waitFor(() => (s.h.brains as unknown as { tasks: Map<string, unknown> }).tasks.size === 0);
  s.h.brains.brains.close();
});

test("a worker that answers no host for a task on a shared CLI login fails the start", async () => {
  const t = setup({ grant: async () => ({ kind: "hosted" }) });
  const h = hosted(t);
  t.sup.boot();
  t.sup.attach();
  const run = errorCode(() => handleRequest(h.ctx, hostedTask(), scope().scope));
  await waitFor(() => t.workers.length === 1);
  const ana = t.last(ANA.id);
  ana.hello();
  const q = await requestOn(ana);
  ana.send({ type: "result", id: q.id, ok: true, data: { taskId: HOSTED_TASK, pid: 42 } });
  expect(await run).toBe("internal");
});

test.if(posix)("refresh mode B: a CLI starts only once the lock's name is gone", async () => {
  const t = setup();
  const h = hosted(t, {
    shared: () => ({ refresh: "B", refreshLock: ".lock" }),
  });
  mkdirSync(path.join(h.store, "config"), { recursive: true });
  const lock = path.join(h.store, "config", ".lock");
  writeFileSync(lock, "");
  t.sup.boot();
  t.sup.attach();
  const run = handleRequest(h.ctx, hostedTurn(), scope().scope);
  await waitFor(() => t.workers.length === 1);
  const ana = t.last(ANA.id);
  ana.hello();
  const stop = answersAsWorker(ana, "/home/ag-a1b2c3d4/ana-a1b2c3d4");
  await waitFor(() => ana.of("turn.prepare").length === 2);
  await sleep(50);
  expect(existsSync(h.log)).toBe(false);
  rmSync(lock);
  expect(((await run) as { final: { type: string } }).final.type).toBe("done");
  stop();
  expect(existsSync(h.log)).toBe(true);
  h.brains.brains.close();
});

test.if(posix)(
  "a task on a shared CLI login outlives a dropped connection, and its end reaches its worker",
  async () => {
    const s = await startHostedTask(hostedTask({ prompt: "SLOW wait" }));
    await waitFor(() => existsSync(s.h.log));
    s.t.sup.detach();
    expect(s.ana.of("worker.close")).toHaveLength(1);
    const exit = await s.done();
    expect(exit).toMatchObject({ exitCode: 0, signal: null, reason: null, session: HOSTED_SESSION });
  },
);

test.if(posix)("a task on a shared CLI login outlives its worker's new session, not the worker", async () => {
  const s = await startHostedTask(hostedTask({ prompt: "SLOW wait" }));
  await waitFor(() => existsSync(s.h.log));
  s.t.sup.detach();
  s.t.sup.attach();
  s.ana.hello();
  expect(await s.done()).toMatchObject({ exitCode: 0, reason: null });

  const gone = await startHostedTask(hostedTask({ prompt: "SLOW wait" }));
  await waitFor(() => existsSync(gone.h.log));
  gone.t.sup.retireNetworkAgent(ANA.id, "network changed");
  await sleep(50);
  // Nothing hears it there: the worker's next one finds no CLI, and the server resumes the task.
  expect(gone.h.brains.brains.hosts(HOSTED_TASK)).toBe(false);
  gone.h.brains.brains.close();
});

test("a worker's word to stop a task reaches root as that agent's", async () => {
  const stops: string[][] = [];
  const t = setup({ taskStop: (id, taskId) => stops.push([id, taskId]) });
  t.sup.boot();
  t.sup.attach();
  const run = handleRequest(t.ctx, exec(ANA), scope().scope);
  await waitFor(() => t.workers.length === 1);
  const ana = t.last(ANA.id);
  ana.hello();
  const q = await requestOn(ana);
  ana.send({ type: "task.stop", taskId: 3 });
  ana.send({ type: "task.stop", taskId: HOSTED_TASK });
  await waitFor(() => stops.length === 1);
  expect(stops).toEqual([[ANA.id, HOSTED_TASK]]);
  ana.send({ type: "result", id: q.id, ok: true, data: execDone });
  await run;
});

test("a worker's notice reaches root only well formed, as that agent's", async () => {
  const notices: unknown[][] = [];
  const t = setup({ toolNotice: (id, n) => notices.push([id, n]) });
  t.sup.boot();
  t.sup.attach();
  const run = handleRequest(t.ctx, exec(ANA), scope().scope);
  await waitFor(() => t.workers.length === 1);
  const ana = t.last(ANA.id);
  ana.hello();
  const q = await requestOn(ana);
  const notice = {
    session: HOSTED_SESSION,
    shellId: "b12345678",
    status: "running",
    summary: "dev",
    outputFile: "/tmp/x",
  };
  ana.send({ type: "tool.notice", ...notice, status: "exploded" });
  ana.send({ type: "tool.notice", ...notice, outputFile: "relative" });
  ana.send({ type: "tool.notice", ...notice, shellId: "../x" });
  ana.send({ type: "tool.notice", ...notice, agent: BIA.id, summary: "x".repeat(500), moved: true });
  await waitFor(() => notices.length === 1);
  expect(notices[0]).toEqual([ANA.id, { ...notice, summary: "x".repeat(200), moved: true }]);
  ana.send({ type: "result", id: q.id, ok: true, data: execDone });
  await run;
});

test.if(posix)(
  "a real worker: the context, the relay's socket, and a tool served to the relay as the agent",
  async () => {
    const t = realWorkers();
    const h = hosted(t);
    const socketFolder = tempDir("bridge-");
    dirs.push(socketFolder);
    const socketPath = path.join(socketFolder, "mcp.sock");
    const brains = new AccountBrains({
      ...(h.brains as unknown as { o: AccountBrainsOptions }).o,
      users: {
        ...(h.brains as unknown as { o: AccountBrainsOptions }).o.users,
        bridge: () => socketPath,
      },
    });
    t.sup.boot();
    t.sup.attach();
    const folder = path.join(realpathSync(t.agentHome), "ana-a1b2c3d4");
    const out = await handleRequest({ ...h.ctx, accountBrains: brains }, hostedTurn(), scope().scope);
    expect((out as { final: unknown }).final).toMatchObject({ type: "done" });
    expect(statSync(socketPath).mode & 0o777).toBe(0o666);
    writeFileSync(path.join(folder, "note.txt"), "from the agent's folder\n");
    const config = readFileSync(
      path.join(
        h.store,
        "run",
        "21000",
        readdirSync(path.join(h.store, "run", "21000")).find((n) => n !== "sessions.json") as string,
        "mcp.json",
      ),
      "utf8",
    );
    const { args, env } = JSON.parse(config).mcpServers.agentes as {
      args: string[];
      env: { AGENTES_MCP_TOKEN: string; AGENTES_MCP_SOCKET: string };
    };
    expect(env.AGENTES_MCP_SOCKET).toBe(socketPath);
    const input = new PassThrough();
    const output = new PassThrough();
    const seen: { id?: number; result?: { content: { text: string }[] } }[] = [];
    readLines(
      output,
      1 << 20,
      (line) => seen.push(JSON.parse(line)),
      () => {},
    );
    const relay = runMcpRelay({
      socketPath,
      taskId: args.at(-1) as string,
      token: env.AGENTES_MCP_TOKEN,
      input,
      output,
    });
    const read = { name: "Read", arguments: { file_path: path.join(folder, "note.txt") } };
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: read })}\n`);
    await waitFor(() => seen.some((m) => m.id === 7));
    expect(seen.find((m) => m.id === 7)?.result?.content[0]?.text).toContain("from the agent's folder");
    input.end();
    await relay;
    brains.brains.close();
  },
);

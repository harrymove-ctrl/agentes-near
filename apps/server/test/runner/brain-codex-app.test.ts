import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { MachineRequest } from "@agenteschat/adapters/machine-protocol";
import { sealSecret, secretAad } from "@agenteschat/adapters/secret-box";
import {
  type CodexBrainEvent,
  CodexEventMapper,
  CodexThreads,
  codexThreadKey,
  codexThreadsFile,
  handleCodexBrainTurn,
} from "../../runner/brain-codex";
import {
  approvalCalls,
  CodexAppMapper,
  CodexAppServers,
  type CodexAppServersOptions,
  codexAppServerArgs,
  codexAtLeast,
  codexThreadPolicy,
} from "../../runner/brain-codex-app";
import { handleRequest } from "../../runner/handlers";
import { CODEX_MCP_SERVER, type IpcReply, type McpTaskInfo } from "../../runner/mcp";
import { agentWorkspace } from "../../runner/paths";
import { removeDirs, tempDir, waitFor } from "./helpers";

/**
 * Codex turns on `codex app-server` (live steering), against a fake
 * app-server speaking the JSON-RPC subset the runner uses
 * (`fake-codex-app.mjs`, shapes from codex-cli 0.163.0's generated types).
 */

const dirs: string[] = [];
const servers: CodexAppServers[] = [];
const ENV = ["FAKE_CODEX_LOG", "FAKE_CODEX_NO_APP", "FAKE_CODEX_EXEC_MS"];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const k of ENV) delete process.env[k];
  removeDirs(dirs);
});

const posix = process.platform !== "win32";
const FAKE = path.join(import.meta.dir, "fake-codex-app.mjs");
const THREAD = "01a1463b-6712-7b53-9f12-2499fb614d2d";
const SESSION = "0193cccc-0000-7000-8000-000000000001";
const AGENT = { id: "0193aaaa-bbbb-7ccc-8ddd-eeeeffff0000", handle: "dev" };
const run = (n: number) => `0193aaaa-0000-7000-8000-0000000000${String(n).padStart(2, "0")}`;
const U1 = "0193dddd-0000-7000-8000-000000000001";
const U2 = "0193dddd-0000-7000-8000-000000000002";

async function setup(
  opts: {
    accounts?: { accountDir(kind: string, id: string): string | null };
    /** A fake server for the approvals the runner can't decide by itself. */
    ask?: CodexAppServersOptions["ask"];
    onRateLimits?: CodexAppServersOptions["onRateLimits"];
    maxProcesses?: number;
  } = {},
) {
  const root = tempDir("brain-codex-app-");
  dirs.push(root);
  const ws = path.join(root, "ws");
  const home = path.join(root, "home");
  for (const d of [ws, home]) mkdirSync(d, { recursive: true });
  const bin = path.join(root, "codex");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
  chmodSync(bin, 0o755);
  const log = path.join(root, "log.jsonl");
  process.env.FAKE_CODEX_LOG = log;
  const folder = await agentWorkspace(ws, AGENT);
  mkdirSync(path.join(folder, "app"), { recursive: true });
  const runs = new Map<string, McpTaskInfo>();
  const app = new CodexAppServers({
    runs,
    deltaMs: 5,
    ...(opts.maxProcesses ? { maxProcesses: opts.maxProcesses } : {}),
    ...(opts.ask ? { ask: opts.ask } : {}),
    ...(opts.onRateLimits ? { onRateLimits: opts.onRateLimits } : {}),
  });
  servers.push(app);
  const ctx = {
    folder,
    exec: true,
    runnerHome: home,
    mcp: { socketPath: path.join(home, "mcp.sock"), command: ["/usr/bin/env", "/r/runner.js"] },
    codexVersion: () => "codex-cli 0.163.0",
    bin,
    app,
    ...(opts.accounts ? { accounts: opts.accounts } : {}),
  };
  const lines = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];
  const starts = () => lines().filter((l) => l.start);
  const rpcs = (method: string) =>
    lines()
      .filter((l) => l.rpc === method)
      .map((l) => l.params as Record<string, unknown>);
  return { root, home, folder, runs, app, ctx, starts, rpcs };
}

const request = (n: number, prompt: string, extra: Record<string, unknown> = {}) => ({
  runId: run(n),
  kind: "codex" as const,
  session: { id: SESSION, resume: n > 1 },
  cwd: "app",
  system: "You are Dev.",
  prompt,
  mcp: { token: `tok_run_${n}` },
  agent: AGENT,
  ...extra,
});

function start(ctx: Parameters<typeof handleCodexBrainTurn>[0], req: Parameters<typeof handleCodexBrainTurn>[1]) {
  const events: CodexBrainEvent[] = [];
  const abort = new AbortController();
  const done = handleCodexBrainTurn(ctx, req, { signal: abort.signal, emit: (e) => events.push(e) });
  return { events, done, abort };
}

const deltas = (events: CodexBrainEvent[]) => events.map((e) => (e.type === "text_delta" ? e.text : "")).join("");
const notDeltas = (events: CodexBrainEvent[]) => events.filter((e) => e.type !== "text_delta");

test("version gate and the app-server command line: our overrides, our bridge per process, no network", () => {
  expect(codexAtLeast("codex-cli 0.163.0")).toBe(true);
  expect(codexAtLeast("codex-cli 0.200.1")).toBe(true);
  expect(codexAtLeast("codex-cli 0.162.9")).toBe(false);
  expect(codexAtLeast(undefined)).toBe(false);
  const args = codexAppServerArgs({
    processId: "proc-0001",
    mcp: { command: ["/usr/bin/bun", "/r/runner.js"] },
    writableRoots: ["/w/shared"],
  });
  expect(args[0]).toBe("app-server");
  expect(args.join(" ")).not.toContain("network_access");
  expect(args).toContain('sandbox_workspace_write.writable_roots=["/w/shared"]');
  expect(args).toContain(`mcp_servers.${CODEX_MCP_SERVER}.args=["/r/runner.js","mcp","--run","proc-0001"]`);
  expect(args).toContain(`mcp_servers.${CODEX_MCP_SERVER}.default_tools_approval_mode="approve"`);
  expect(args.some((a) => a.startsWith("model_auto_compact_token_limit"))).toBe(false);
  // Protocol 28: the agent's context limit is the process's own.
  const limited = codexAppServerArgs({ processId: "proc-0001", contextTokens: 200_000 });
  expect(limited[limited.indexOf("model_auto_compact_token_limit=200000") - 1]).toBe("-c");
});

test.skipIf(!posix)(
  "turns stream as exec's events; the thread starts once with the instructions and the process lives on",
  async () => {
    const t = await setup();
    const first = start(t.ctx, request(1, "Say pong"));
    await first.done;
    expect(deltas(first.events)).toBe("pong");
    // The same usage and answer exec gives for this turn (TURN1 of brain-codex.test.ts).
    expect(notDeltas(first.events)).toEqual([
      { type: "usage", input: 17806, output: 5, source: "plan", cacheRead: 6912 },
      { type: "done", text: "pong", session: { id: SESSION } },
    ]);
    const [threadStart] = t.rpcs("thread/start");
    expect(threadStart).toMatchObject({
      cwd: path.join(t.folder, "app"),
      sandbox: "workspace-write",
      approvalPolicy: "untrusted",
      developerInstructions: "You are Dev.",
    });
    expect(t.rpcs("turn/start")[0]).toMatchObject({
      threadId: THREAD,
      clientUserMessageId: run(1),
      input: [{ type: "text", text: "Say pong", text_elements: [] }],
    });
    expect(new CodexThreads(codexThreadsFile(t.home)).get(SESSION)).toBe(THREAD);
    // Our bridge belongs to the process: a local token in its env, idle between turns.
    const [proc] = t.starts();
    const procId = [...t.runs.keys()][0] as string;
    expect(String(proc?.args)).toContain(`"mcp","--run","${procId}"`);
    expect(proc?.token).toBe(t.runs.get(procId)?.token as string);
    expect(proc?.token).not.toBe("tok_run_1");
    expect(t.runs.get(procId)).toMatchObject({ running: false, idle: true });
    expect(t.runs.get(procId)?.serverToken).toBeUndefined();

    const second = start(t.ctx, request(2, "TOOLS please", { effort: "max", model: "gpt-5.5" }));
    await second.done;
    // Exec's mapping of the same items (exec has no deltas: only the answer, whole).
    const exec = new CodexEventMapper({ cwd: path.join(t.folder, "app"), model: "gpt-5.5" });
    const execEvents = [
      '{"type":"item.completed","item":{"id":"c-1","type":"command_execution","command":"/bin/zsh -lc \\"npm test\\"","aggregated_output":"2 passed\\n","exit_code":0,"status":"completed"}}',
      `{"type":"item.completed","item":{"id":"f-1","type":"file_change","changes":[{"path":"${path.join(t.folder, "app")}/src/main.ts","kind":"update"}],"status":"completed"}}`,
      '{"type":"item.completed","item":{"id":"t-1","type":"mcp_tool_call","server":"agenteschat_agentes","tool":"search","arguments":{},"status":"completed"}}',
      '{"type":"item.completed","item":{"id":"m-2","type":"agent_message","text":"Done: tests pass."}}',
      '{"type":"turn.completed","usage":{"input_tokens":200,"cached_input_tokens":50,"output_tokens":30}}',
    ].flatMap((l) => exec.line(l));
    const execAll = [...execEvents, ...exec.finish({ exitCode: 0, sessionId: SESSION })];
    expect(notDeltas(second.events)).toEqual(notDeltas(execAll));
    // Live text: the message that came whole, then the streamed one.
    expect(deltas(second.events)).toBe("I’ll check the folder now.\n\nDone: tests pass.");
    // One process, one thread; model and effort per turn (xhigh and max are high).
    expect(t.starts()).toHaveLength(1);
    expect(t.rpcs("thread/start")).toHaveLength(1);
    expect(t.rpcs("turn/start")[1]).toMatchObject({ model: "gpt-5.5", effort: "high" });
    expect(t.app.size).toBe(1);
    // The computer's own sign-in has a process open: a plan's route there waits (`brain-route.ts`).
    expect(t.app.holds(null)).toBe(true);
    expect(t.app.holds("0193aaaa-bbbb-7ccc-8ddd-eeeeffff0001")).toBe(false);
  },
  20_000,
);

test.skipIf(!posix)(
  "speed: every turn says its tier, since a thread keeps one until told; the process turns the feature on",
  async () => {
    const t = await setup();
    await start(t.ctx, request(1, "Say pong", { speed: "fast" })).done;
    await start(t.ctx, request(2, "Say pong")).done;
    await start(t.ctx, request(3, "Say pong", { speed: "turbo" })).done;
    expect(t.rpcs("turn/start").map((p) => p.serviceTier)).toEqual(["fast", null, null]);
    expect(t.starts()).toHaveLength(1);
    expect(String(t.starts()[0]?.args)).toContain("features.fast_mode=true");
  },
  20_000,
);

test.skipIf(!posix)(
  "Fast refused on an app-server: the same turn again at standard speed, once, and the reply still comes",
  async () => {
    const t = await setup();
    const turn = start(t.ctx, request(1, "FAST_REFUSED then pong", { speed: "fast" }));
    await turn.done;
    expect(t.rpcs("turn/start").map((p) => p.serviceTier)).toEqual(["fast", null]);
    expect(turn.events.filter((e) => e.type === "error")).toEqual([]);
    expect(turn.events.find((e) => e.type === "speed_fallback")).toMatchObject({
      message: expect.stringContaining("Fast mode is not available"),
    });
    expect(turn.events.at(-1)).toMatchObject({ type: "done", text: "pong" });
  },
  20_000,
);

test.skipIf(!posix)(
  "another failure of a Fast turn is that failure: no second try, no note",
  async () => {
    const t = await setup();
    const turn = start(t.ctx, request(1, "LIMIT", { speed: "fast" }));
    await turn.done;
    expect(t.rpcs("turn/start")).toHaveLength(1);
    expect(turn.events.some((e) => e.type === "speed_fallback")).toBe(false);
    expect(turn.events.at(-1)).toMatchObject({ type: "error", code: "plan_limit" });
  },
  20_000,
);

test.skipIf(!posix)(
  "a secret quoted across two streamed batches leaves redacted, never in halves",
  async () => {
    const t = await setup();
    const secretsDir = path.join(t.home, "secrets");
    const call = (req: MachineRequest) =>
      handleRequest({ workspaceReal: t.root, exec: true, token: "agm_x", secretsDir }, req, {
        signal: new AbortController().signal,
        output: () => {},
      });
    const [requestId, name, target, value] = [
      "req-0001-leak",
      "FAKE_SECRET",
      { kind: "env" as const },
      "tok_SECRET_123456",
    ];
    const { publicKey } = (await call({ agent: AGENT, op: "secret", action: "keypair", requestId })) as {
      publicKey: string;
    };
    const aad = secretAad({ requestId, orgId: "org-1", name, target });
    const box = await sealSecret(publicKey, value, aad);
    await call({ agent: AGENT, op: "secret", action: "deliver", requestId, name, target, aad, box });
    await call({
      agent: AGENT,
      op: "secret",
      action: "activate",
      requestId,
      order: `2026-11-01T00:00:00.000Z|${requestId}`,
    });
    const turn = start({ ...t.ctx, secretsDir }, request(1, "LEAK"));
    await turn.done;
    const streamed = turn.events.flatMap((e) => (e.type === "text_delta" ? [e.text] : []));
    expect(streamed.length).toBeGreaterThan(1);
    expect(streamed.join("")).toBe("The key you asked about: [secret:FAKE_SECRET] ok");
    expect(JSON.stringify(turn.events)).not.toContain(value.slice(0, 5));
  },
  20_000,
);

test.skipIf(!posix)(
  "steering: accepted mid-turn, read when Codex adds it (steer_read), the answer follows; after the turn: no_turn",
  async () => {
    const t = await setup();
    const turn = start(t.ctx, request(3, "WAIT for news"));
    await waitFor(() => deltas(turn.events).includes("Working"), 10_000);
    // The bridge relays for this run now, with its token.
    const procId = [...t.runs.keys()][0] as string;
    expect(t.runs.get(procId)).toMatchObject({ running: true, runId: run(3), serverToken: "tok_run_3" });
    // Another agent's message never reaches it.
    expect(
      await t.app.steer("0193aaaa-bbbb-7ccc-8ddd-000000000000", {
        runId: run(3),
        session: SESSION,
        messages: [{ uuid: U1, text: "x" }],
      }),
    ).toEqual({ status: "no_turn" });
    const reply = await t.app.steer(AGENT.id, {
      runId: run(3),
      session: SESSION,
      messages: [{ uuid: U1, text: "[New message from Ada]: also say bye" }],
    });
    expect(reply).toEqual({ status: "accepted", accepted: [U1] });
    await turn.done;
    expect(t.rpcs("turn/steer")).toEqual([
      {
        threadId: THREAD,
        expectedTurnId: "turn-1",
        clientUserMessageId: U1,
        input: [{ type: "text", text: "[New message from Ada]: also say bye", text_elements: [] }],
      },
    ]);
    const read = turn.events.findIndex((e) => e.type === "steer_read");
    expect(turn.events[read]).toEqual({ type: "steer_read", uuids: [U1] });
    expect(read).toBeLessThan(turn.events.findIndex((e) => e.type === "done"));
    expect(turn.events.at(-1)).toEqual({
      type: "done",
      text: "Got it: [New message from Ada]: also say bye",
      session: { id: SESSION },
    });
    expect(turn.events.find((e) => e.type === "usage")).toMatchObject({ input: 300, output: 20 });
    // The turn is over: the next message waits for the next turn.
    expect(
      await t.app.steer(AGENT.id, { runId: run(3), session: SESSION, messages: [{ uuid: U2, text: "late" }] }),
    ).toEqual({ status: "no_turn" });
    expect(t.app.size).toBe(1);
  },
  20_000,
);

test.skipIf(!posix)(
  "one kept, several at once: with every app-server busy a turn still gets its own (steering reaches both); the cap is back once they end",
  async () => {
    const t = await setup({ maxProcesses: 1 });
    const SESSION2 = "0193cccc-0000-7000-8000-000000000002";
    const a = start(t.ctx, request(11, "WAIT a"));
    const b = start(t.ctx, request(12, "WAIT b", { session: { id: SESSION2, resume: false } }));
    await waitFor(() => deltas(a.events).includes("Working") && deltas(b.events).includes("Working"), 10_000);
    expect(t.starts().map((s) => s.start)).toEqual(["app-server", "app-server"]);
    for (const [n, session, uuid] of [
      [11, SESSION, U1],
      [12, SESSION2, U2],
    ] as const)
      expect(await t.app.steer(AGENT.id, { runId: run(n), session, messages: [{ uuid, text: "go" }] })).toEqual({
        status: "accepted",
        accepted: [uuid],
      });
    await Promise.all([a.done, b.done]);
    expect(t.app.size).toBe(1);
  },
  20_000,
);

test.skipIf(!posix)(
  "a steer that arrives as Codex ends the turn: refused (no active turn) → no_turn, nothing left unread",
  async () => {
    const t = await setup();
    const turn = start(t.ctx, request(4, "WAIT_END"));
    await waitFor(() => deltas(turn.events).includes("Working"), 10_000);
    const reply = await t.app.steer(AGENT.id, {
      runId: run(4),
      session: SESSION,
      messages: [{ uuid: U1, text: "hi" }],
    });
    expect(reply.status).toBe("no_turn");
    expect((reply as { reason?: string }).reason).toContain("no active turn");
    await turn.done;
    expect(turn.events.at(-1)).toMatchObject({ type: "done", text: "Finished before reading it." });
    expect(turn.events.some((e) => e.type === "steer_read")).toBe(false);
    // Nothing unheard was left in Codex: the process stays for the next turn.
    const pid = t.starts()[0]?.pid;
    await start(t.ctx, request(5, "again")).done;
    expect(t.starts().map((s) => s.pid)).toEqual([pid]);
    expect(t.rpcs("thread/resume")).toHaveLength(0);
  },
  20_000,
);

test.skipIf(!posix)(
  "urgent (stop and send): turn/interrupt, then a new turn starts with the message; read and answered in the same brain turn",
  async () => {
    const t = await setup();
    const turn = start(t.ctx, request(6, "WAIT while I work"));
    await waitFor(() => deltas(turn.events).includes("Working"), 10_000);
    const reply = await t.app.steer(AGENT.id, {
      runId: run(6),
      session: SESSION,
      messages: [{ uuid: U1, text: "Stop: ping me", urgent: true }],
    });
    expect(reply).toEqual({ status: "accepted", accepted: [U1] });
    await turn.done;
    expect(t.rpcs("turn/interrupt")).toEqual([{ threadId: THREAD, turnId: "turn-1" }]);
    expect(t.rpcs("turn/steer")).toHaveLength(0);
    expect(t.rpcs("turn/start")[1]).toMatchObject({
      threadId: THREAD,
      clientUserMessageId: U1,
      input: [{ type: "text", text: "Stop: ping me", text_elements: [] }],
    });
    expect(turn.events.filter((e) => e.type === "steer_read")).toEqual([{ type: "steer_read", uuids: [U1] }]);
    expect(turn.events.at(-1)).toEqual({ type: "done", text: "pong", session: { id: SESSION } });
    expect(turn.events.some((e) => e.type === "error")).toBe(false);
  },
  20_000,
);

test.skipIf(!posix)(
  "no app-server (an older CLI): exec runs the turn, remembered for that Codex; steering it is unsupported",
  async () => {
    const t = await setup();
    process.env.FAKE_CODEX_NO_APP = "1";
    const first = start(t.ctx, request(7, "hi"));
    await first.done;
    expect(first.events.at(-1)).toEqual({ type: "done", text: "exec: hi", session: { id: SESSION } });
    expect(t.starts().map((s) => s.start)).toEqual(["app-server", "exec"]);

    process.env.FAKE_CODEX_EXEC_MS = "400";
    const second = start(t.ctx, request(8, "again"));
    await waitFor(() => t.starts().length === 3, 10_000);
    // The broken app-server isn't tried again: exec, and its turn can't take messages.
    expect(t.starts().map((s) => s.start)).toEqual(["app-server", "exec", "exec"]);
    expect(
      await t.app.steer(AGENT.id, { runId: run(8), session: SESSION, messages: [{ uuid: U1, text: "x" }] }),
    ).toMatchObject({ status: "unsupported" });
    await second.done;
    expect(second.events.at(-1)).toMatchObject({ type: "done", text: "exec: again" });
  },
  20_000,
);

test.skipIf(!posix)("an HTTP bridge (its token is per run) runs with exec", async () => {
  const t = await setup();
  const turn = start(t.ctx, request(9, "hi", { mcp: { token: "tok", url: "https://bridge.example/mcp" } }));
  await turn.done;
  expect(t.starts().map((s) => s.start)).toEqual(["exec"]);
  expect(turn.events.at(-1)).toMatchObject({ type: "done", text: "exec: hi" });
});

test.skipIf(!posix)(
  "dies mid-turn: that turn runs again with exec (resuming the thread); the next one gets a new app-server that resumes it",
  async () => {
    const t = await setup();
    const crashed = start(t.ctx, request(10, "CRASH now"));
    await crashed.done;
    expect(crashed.events.at(-1)).toEqual({ type: "done", text: "exec: CRASH now", session: { id: SESSION } });
    expect(t.starts().map((s) => s.start)).toEqual(["app-server", "exec"]);
    expect(t.starts()[1]?.args).toEqual(expect.arrayContaining(["resume", THREAD]));

    const next = start(t.ctx, request(11, "hello"));
    await next.done;
    expect(next.events.at(-1)).toMatchObject({ type: "done", text: "pong" });
    expect(t.starts().map((s) => s.start)).toEqual(["app-server", "exec", "app-server"]);
    expect(t.rpcs("thread/resume")).toEqual([
      expect.objectContaining({ threadId: THREAD, cwd: path.join(t.folder, "app"), excludeTurns: true }),
    ]);
  },
  20_000,
);

test.skipIf(!posix)("cancel: the turn is interrupted, ends canceled, and the process goes", async () => {
  const t = await setup();
  const turn = start(t.ctx, request(12, "WAIT"));
  await waitFor(() => deltas(turn.events).includes("Working"), 10_000);
  turn.abort.abort();
  await turn.done;
  expect(turn.events.at(-1)).toMatchObject({ type: "error", code: "canceled" });
  await waitFor(() => t.rpcs("turn/interrupt").length === 1, 5_000);
  expect(t.app.size).toBe(0);
  expect(t.runs.size).toBe(0);
});

test.skipIf(!posix)("a usage limit is limit + plan_limit, as exec's", async () => {
  const t = await setup();
  const turn = start(t.ctx, request(13, "LIMIT"));
  await turn.done;
  expect(notDeltas(turn.events)).toEqual([
    { type: "limit" },
    { type: "error", code: "plan_limit", message: "You've hit your usage limit. Try again later.", worked: false },
  ]);
});

test.skipIf(!posix)(
  "a thread Codex lost starts again with the instructions; an account runs in its own Codex home",
  async () => {
    const ACCOUNT = "0193ffff-0000-7000-8000-000000000002";
    const t0 = tempDir("brain-codex-app-acct-");
    dirs.push(t0);
    const t = await setup({ accounts: { accountDir: (kind, id) => (kind === "codex" && id === ACCOUNT ? t0 : null) } });
    const threads = new CodexThreads(codexThreadsFile(t.home));
    threads.set(codexThreadKey(SESSION, ACCOUNT), "01a1463b-0000-7000-8000-00000000dead");
    const turn = start(t.ctx, request(14, "hi", { account: ACCOUNT }));
    await turn.done;
    expect(turn.events.at(-1)).toMatchObject({ type: "done", text: "pong" });
    expect(t.starts()[0]?.codexHome).toBe(t0);
    expect(t.rpcs("thread/resume")).toHaveLength(1);
    expect(t.rpcs("thread/start")[0]).toMatchObject({ developerInstructions: "You are Dev." });
    expect(new CodexThreads(codexThreadsFile(t.home)).get(codexThreadKey(SESSION, ACCOUNT))).toBe(THREAD);
    expect(new CodexThreads(codexThreadsFile(t.home)).get(SESSION)).toBeUndefined();
  },
  20_000,
);

test.skipIf(!posix)(
  "rate limits Codex reports during a turn go to the process's account (or its own sign-in); account turns see no stray key",
  async () => {
    process.env.OPENAI_API_KEY = "sk-stray";
    try {
      const ACCOUNT = "0193ffff-0000-7000-8000-000000000003";
      const home = tempDir("brain-codex-app-acct-");
      dirs.push(home);
      const noted: [string | null, unknown][] = [];
      const t = await setup({
        accounts: { accountDir: (kind, id) => (kind === "codex" && id === ACCOUNT ? home : null) },
        onRateLimits: (account, rateLimits) => noted.push([account, rateLimits]),
      });
      await start(t.ctx, request(16, "RATE", { account: ACCOUNT })).done;
      await start(t.ctx, request(17, "RATE")).done;
      const limits = { primary: { usedPercent: 91, windowDurationMins: 300, resetsAt: 1900000000 }, secondary: null };
      expect(noted).toEqual([
        [ACCOUNT, limits],
        [null, limits],
      ]);
      expect(t.starts().map((s) => [s.codexHome === home, s.openaiKey])).toEqual([
        [true, null],
        [false, "sk-stray"],
      ]);
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  },
  20_000,
);

test("handler: brain.steer for a Codex run goes to its app-server (exec-only runners: unsupported)", async () => {
  const root = tempDir("brain-codex-app-");
  dirs.push(root);
  const runs = new Map([[run(15), {} as McpTaskInfo]]);
  const asked: unknown[] = [];
  const app = {
    steer: async (agentId: string, req: unknown) => {
      asked.push({ agentId, req });
      return { status: "accepted" as const, accepted: [U1] };
    },
  } as unknown as CodexAppServers;
  const scope = { signal: new AbortController().signal, output: () => {} };
  const req = {
    op: "brain.steer",
    runId: run(15),
    session: SESSION,
    messages: [{ uuid: U1, text: "hi", urgent: true }],
    agent: AGENT,
  } as MachineRequest;
  const ctx = { workspaceReal: root, exec: true, token: "agm_x" };
  expect(await handleRequest({ ...ctx, codex: { runnerHome: root, runs, app } }, req, scope)).toEqual({
    status: "accepted",
    accepted: [U1],
  });
  expect(asked).toEqual([
    {
      agentId: AGENT.id,
      req: { runId: run(15), session: SESSION, messages: [{ uuid: U1, text: "hi", urgent: true }] },
    },
  ]);
  expect(await handleRequest({ ...ctx, codex: { runnerHome: root, runs } }, req, scope)).toMatchObject({
    status: "unsupported",
  });
});

// ── Permission profiles (ADR 0053 §3) ────────────────────────────────────────

const answerOf = (events: CodexBrainEvent[]) => {
  const done = events.find((e) => e.type === "done");
  return done?.type === "done" ? done.text : null;
};

test("profiles: plan is a read-only sandbox, work a workspace one; neither has the network, both ask", () => {
  expect(codexThreadPolicy("plan")).toEqual({ sandbox: "read-only", approvalPolicy: "untrusted" });
  expect(codexThreadPolicy("work")).toEqual({ sandbox: "workspace-write", approvalPolicy: "untrusted" });
  // What one approval is for the command policy: the shell line, or a write of each file.
  expect(
    approvalCalls(
      "item/commandExecution/requestApproval",
      { command: '/bin/zsh -lc "gh pr merge 1"' },
      undefined,
      "/w",
    ),
  ).toEqual([{ tool_name: "Bash", input: { command: "gh pr merge 1" } }]);
  expect(
    approvalCalls("item/commandExecution/requestApproval", {}, { command: ["/bin/bash", "-lc", "git status"] }, "/w"),
  ).toEqual([{ tool_name: "Bash", input: { command: "git status" } }]);
  expect(
    approvalCalls("item/fileChange/requestApproval", { grantRoot: "/etc" }, { changes: [{ path: "src/a.ts" }] }, "/w"),
  ).toEqual([
    { tool_name: "Write", input: { file_path: "/w/src/a.ts" } },
    { tool_name: "Write", input: { file_path: "/etc" } },
  ]);
  // Nothing to judge it by: declined.
  expect(approvalCalls("item/fileChange/requestApproval", {}, undefined, "/w")).toEqual([]);
  expect(approvalCalls("turn/started", {}, undefined, "/w")).toBeNull();
});

test.skipIf(!posix)(
  "a plan turn runs in a read-only sandbox without network; a background turn leaves no app-server",
  async () => {
    const t = await setup();
    const first = start(t.ctx, request(1, "Say pong", { permissions: { mode: "plan" }, keepAlive: false }));
    await first.done;
    expect(answerOf(first.events)).toBe("pong");
    expect(t.rpcs("thread/start")[0]).toMatchObject({ sandbox: "read-only", approvalPolicy: "untrusted" });
    for (const s of t.starts()) expect(String(s.args)).not.toContain("network_access");
    // Background: the process closed with the turn.
    expect(t.app.process(AGENT.id, SESSION)).toBeUndefined();
    expect(t.app.size).toBe(0);
    // A work turn of the same session: another process, a workspace sandbox.
    const second = start(t.ctx, request(2, "Say pong"));
    await second.done;
    expect(t.rpcs("thread/resume").at(-1)).toMatchObject({ sandbox: "workspace-write", approvalPolicy: "untrusted" });
    expect(t.app.size).toBe(1);
  },
);

test.skipIf(!posix)(
  "a work turn's approvals get the command policy's answer: merges declined, reads accepted, the rest asks the server",
  async () => {
    const asked: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const replies: unknown[] = [{ behavior: "allow" }, { behavior: "deny", message: "A person said no." }];
    const t = await setup({
      ask: async (_process, tool, args): Promise<IpcReply> => {
        asked.push({ tool, args });
        return { ok: true, text: JSON.stringify(replies.shift() ?? { behavior: "deny", message: "no" }) };
      },
    });
    const merge = start(t.ctx, request(1, "APPROVE gh pr merge 1"));
    await merge.done;
    expect(answerOf(merge.events)).toBe("decision: decline");
    const status = start(t.ctx, request(2, "APPROVE git status"));
    await status.done;
    expect(answerOf(status.events)).toBe("decision: accept");
    // Neither reached the server: the computer decides those by itself.
    expect(asked).toEqual([]);
    // An install: the server's rules decide (allowed here), then a person's no.
    const install = start(t.ctx, request(3, "APPROVE npm install left-pad"));
    await install.done;
    expect(answerOf(install.events)).toBe("decision: accept");
    expect(asked[0]).toMatchObject({
      tool: "permission_prompt",
      args: {
        tool_name: "Bash",
        input: { command: "npm install left-pad" },
        scope: { cwd: path.join(t.folder, "app") },
      },
    });
    const again = start(t.ctx, request(4, "APPROVE npm install other"));
    await again.done;
    expect(answerOf(again.events)).toBe("decision: decline");
  },
);

test.skipIf(!posix)("a plan turn's approvals are refused on the computer, never asked of anyone", async () => {
  const asked: unknown[] = [];
  const t = await setup({
    ask: async (_process, tool, args): Promise<IpcReply> => {
      asked.push({ tool, args });
      return { ok: true, text: JSON.stringify({ behavior: "allow" }) };
    },
  });
  const plan = { permissions: { mode: "plan" as const } };
  const install = start(t.ctx, request(1, "APPROVE npm install left-pad", plan));
  await install.done;
  expect(answerOf(install.events)).toBe("decision: decline");
  const edit = start(t.ctx, request(2, `APPROVE_FILE ${path.join(t.folder, "app", "a.ts")}`, plan));
  await edit.done;
  expect(answerOf(edit.events)).toBe("decision: decline");
  const read = start(t.ctx, request(3, "APPROVE git log --oneline -3", plan));
  await read.done;
  expect(answerOf(read.events)).toBe("decision: accept");
  expect(asked).toEqual([]);
});

test.skipIf(!posix)(
  "an app-server whose turn brings a new tool name starts again, resumed: Codex lists our tools only as its thread opens",
  async () => {
    const t = await setup();
    const turn = (n: number, tools?: string) =>
      start(t.ctx, request(n, "hi", { mcp: { token: `tok_run_${n}`, ...(tools ? { tools } : {}) } })).done;
    await turn(21, "browser_open find_tools");
    // A dropped name stays listed: the server answers a call to it, so the process stays.
    await turn(22, "find_tools");
    expect(t.starts()).toHaveLength(1);
    // A connector given between turns: a new name, so it runs on a new process, same thread.
    await turn(23, "find_tools vega_crm_find");
    expect(t.starts()).toHaveLength(2);
    expect(t.rpcs("thread/start")).toHaveLength(1);
    expect(t.rpcs("thread/resume")).toEqual([expect.objectContaining({ threadId: THREAD })]);
    await turn(24, "find_tools vega_crm_find");
    // A server that sends no names: nothing to compare, the process stays.
    await turn(25);
    expect(t.starts()).toHaveLength(2);
    expect(t.app.size).toBe(1);
  },
  20_000,
);

test("a refusal known by its words after a command says the turn worked", () => {
  const m = new CodexAppMapper({ cwd: "" });
  m.completed({ id: "c", type: "commandExecution", command: "git push", aggregatedOutput: "", status: "completed" });
  const message = "Your workspace is out of credits.";
  expect(m.end({ id: "t", status: "failed", error: { message } } as never, SESSION, []).at(-1)).toEqual({
    type: "error",
    code: "plan_limit",
    message,
    worked: true,
  });
});

test("an agent message completed twice is sent once", () => {
  const m = new CodexAppMapper({ cwd: "" });
  const sent: string[] = [];
  const text = (t: string | undefined) => t && sent.push(t);
  text(m.completed({ id: "msg_b", type: "agentMessage", text: "Achei a chave." }).text);
  text(m.completed({ id: "msg_b", type: "agentMessage", text: "Achei a chave." }).text);
  expect(sent).toEqual(["Achei a chave."]);
});

test("two different messages that read alike are both sent", () => {
  const m = new CodexAppMapper({ cwd: "" });
  const sent: string[] = [];
  for (const id of ["msg_1", "msg_2"]) {
    sent.push(m.delta({ itemId: id, delta: "Feito." }));
    expect(m.completed({ id, type: "agentMessage", text: "Feito." }).text).toBeUndefined();
  }
  expect(sent.join("")).toBe("Feito.\n\nFeito.");
});

import { expect, test } from "bun:test";
import { CODEX_FOLDER_PROTOCOL } from "@agenteschat/adapters";
import { type BrainTurnRequest, CodexBrain, type ComputerBrainLink, codexVersionOk } from "../src/brains/codex";
import { computerPrompt } from "../src/brains/prompt";
import type { BrainEvent, BrainTurn } from "../src/brains/types";
import { MachineRequestError } from "../src/machine-hub";
import { MachineDroppedError } from "../src/machines";

const SESSION = "0193aaaa-0000-7000-8000-00000000c0de";

function turn(over: Partial<BrainTurn> = {}): BrainTurn {
  return {
    runId: "0193aaaa-0000-7000-8000-000000000001",
    orgId: "org",
    agentId: "agent",
    channelId: "channel",
    threadRootId: null,
    system: "You are Dev.",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "run the tests" },
    ],
    tools: [],
    trigger: "run the tests",
    session: { id: SESSION, resume: false, machineId: "m1", cwd: "app" },
    ...over,
  };
}

function link(opts: {
  version?: string | null;
  online?: boolean;
  events?: BrainEvent[];
  fail?: Error;
  protocol?: number;
}): ComputerBrainLink & { sent: BrainTurnRequest[] } {
  const sent: BrainTurnRequest[] = [];
  return {
    sent,
    async status() {
      return {
        online: opts.online ?? true,
        execAllowed: true,
        ...(opts.protocol !== undefined ? { protocol: opts.protocol } : {}),
        executors: opts.version === null ? {} : { codex: { version: opts.version ?? "codex-cli 0.163.0" } },
      };
    },
    async turn(_machineId, request, { onEvent }) {
      sent.push(request);
      for (const e of opts.events ?? []) onEvent(e);
      if (opts.fail) throw opts.fail;
    },
  };
}

const io = () => ({
  signal: new AbortController().signal,
  executeTool: async () => {
    throw new Error("computer brains don't execute tools in the engine");
  },
});

async function collect(it: AsyncIterable<BrainEvent>) {
  const out: BrainEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

test("version gate: 0.163.0 and newer only", () => {
  expect(codexVersionOk("codex-cli 0.163.0")).toBe(true);
  expect(codexVersionOk("codex-cli 0.164.2")).toBe(true);
  expect(codexVersionOk("codex-cli 1.0.0")).toBe(true);
  expect(codexVersionOk("codex-cli 0.162.9")).toBe(false);
  expect(codexVersionOk("codex")).toBe(false);
  expect(codexVersionOk(undefined)).toBe(false);
});

test("a first turn sends the context and the conversation; events pass through; done carries our session", async () => {
  const l = link({
    events: [
      { type: "tool_call", id: "i1", name: "shell", input: { command: "npm test" }, executed: { content: "ok" } },
      { type: "usage", input: 100, output: 5, source: "plan" },
      { type: "text_delta", text: "Tests pass." },
      { type: "done", text: "Tests pass.", session: { id: "whatever" } },
    ],
  });
  const brain = new CodexBrain({
    link: l,
    mcp: async () => ({ token: "tok" }),
    agent: async () => ({ id: "agent", handle: "dev" }),
  });
  expect(brain.kind).toBe("codex");
  const events = await collect(brain.run(turn({ model: "gpt-5.5" }), io()));
  expect(events.map((e) => e.type)).toEqual(["tool_call", "usage", "text_delta", "done"]);
  expect(events[3]).toEqual({ type: "done", text: "Tests pass.", session: { id: SESSION } });
  expect(l.sent[0]).toMatchObject({
    kind: "codex",
    session: { id: SESSION, resume: false },
    cwd: "app",
    model: "gpt-5.5",
    system: "You are Dev.",
    mcp: { token: "tok" },
    agent: { id: "agent", handle: "dev" },
  });
  expect(l.sent[0]?.prompt).toBe(
    "The conversation so far:\n\nUser: hi\n\nYou: hello\n\nNow answer this:\n\nrun the tests",
  );
});

test("each turn sends its tool names, sorted: a kept-alive Codex starts again when one is new", async () => {
  const l = link({ events: [{ type: "done", text: "ok" }] });
  const brain = new CodexBrain({ link: l, mcp: async () => ({ token: "tok" }) });
  const tool = (name: string) => ({ name, description: name, inputSchema: { type: "object" } });
  for (const tools of [
    [tool("find_tools"), tool("use_tool")],
    [tool("use_tool"), tool("find_tools")],
    [tool("find_tools"), tool("use_tool"), tool("vega_crm_find_tools")],
  ]) {
    await collect(brain.run(turn({ tools }), io()));
  }
  const keys = l.sent.map((r) => r.mcp.tools);
  expect(keys[0]).toBe("find_tools use_tool");
  // The same names in another order are the same tools; one more is another list.
  expect(keys[1]).toBe(keys[0] as string);
  expect(keys[2]).toBe("find_tools use_tool vega_crm_find_tools");
  expect(l.sent[0]?.mcp.token).toBe("tok");
});

test("a resumed turn sends only what came after the brain's last reply", () => {
  const t = turn({
    session: { id: SESSION, resume: true, machineId: "m1", cwd: "" },
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "also check lint" },
      { role: "user", content: "run the tests" },
    ],
  });
  expect(computerPrompt(t)).toBe(
    "New messages since your last reply:\n\nUser: also check lint\n\nNow answer this:\n\nrun the tests",
  );
  expect(computerPrompt({ ...t, messages: t.messages.filter((m) => m.content !== "also check lint") })).toBe(
    "run the tests",
  );
});

test("refuses before sending: offline, no Codex, Codex too old, no session", async () => {
  const run = async (l: ComputerBrainLink, t = turn()) =>
    collect(new CodexBrain({ link: l, mcp: async () => ({ token: "t" }) }).run(t, io()));
  const offline = link({ online: false });
  expect(await run(offline)).toMatchObject([{ type: "error", code: "machine_offline", retryable: true }]);
  expect(await run(link({ version: null }))).toMatchObject([{ type: "error", code: "codex_missing" }]);
  const old = link({ version: "codex-cli 0.162.0" });
  const refused = await run(old);
  expect(refused).toMatchObject([{ type: "error", code: "codex_too_old" }]);
  expect((refused[0] as { message: string }).message).toContain("0.163.0");
  expect(old.sent).toHaveLength(0);
  expect(await run(link({}), turn({ session: undefined }))).toMatchObject([{ type: "error", code: "no_session" }]);
});

test("the turn always ends once: a runner failure is an error, a silent end is done with the streamed text", async () => {
  const brain = (l: ComputerBrainLink) => new CodexBrain({ link: l, mcp: async () => ({ token: "t" }) });
  const failed = await collect(brain(link({ fail: new Error("socket closed") })).run(turn(), io()));
  expect(failed).toMatchObject([{ type: "error", code: "runner_failed", message: "socket closed" }]);
  // No room for the turn (or an older runner's ceiling): busy, so the engine waits for room.
  for (const refusal of [
    new MachineRequestError("no_slot", "short of memory"),
    new MachineRequestError("internal", "busy"),
  ]) {
    const refused = await collect(brain(link({ fail: refusal })).run(turn(), io()));
    expect(refused).toMatchObject([{ type: "error", code: "busy", retryable: true }]);
  }
  // Cut by the link dropping (or the agent's worker stopping) waits for the computer; our own stop says so.
  const dropped = await collect(brain(link({ fail: new MachineDroppedError("mac") })).run(turn(), io()));
  expect(dropped).toEqual([expect.objectContaining({ type: "error", code: "machine_offline", retryable: true })]);
  expect("serverStop" in (dropped[0] ?? {})).toBe(false);
  const ours = await collect(
    brain(link({ fail: new MachineDroppedError("mac", { serverStop: true }) })).run(turn(), io()),
  );
  expect(ours).toMatchObject([{ type: "error", code: "machine_offline", serverStop: true }]);
  const silent = await collect(brain(link({ events: [{ type: "text_delta", text: "Hi" }] })).run(turn(), io()));
  expect(silent.at(-1)).toEqual({ type: "done", text: "Hi", session: { id: SESSION } });
  const errored = await collect(
    brain(
      link({
        events: [
          { type: "limit" },
          { type: "error", code: "plan_limit", message: "You’ve hit your usage limit." },
          { type: "done", text: "ignored" },
        ],
      }),
    ).run(turn(), io()),
  );
  expect(errored.map((e) => e.type)).toEqual(["limit", "error"]);
});

test("accounts (ADR 0041): account and effort go to a runner that knows them; a signed-out account is refused", async () => {
  const ACCOUNT = "0193dddd-0000-4000-8000-000000000002";
  const account = { id: ACCOUNT, label: "Pessoal", status: "active" as const };
  const run = async (l: ComputerBrainLink, t: BrainTurn) =>
    collect(new CodexBrain({ link: l, mcp: async () => ({ token: "t" }) }).run(t, io()));

  const current = link({ protocol: 13, events: [{ type: "done", text: "ok" }] });
  await run(current, turn({ account, effort: "max" }));
  expect(current.sent[0]).toMatchObject({ kind: "codex", account: ACCOUNT, effort: "max" });

  // An older runner: the effort is dropped, an account can't run there.
  const old = link({ protocol: 12, events: [{ type: "done", text: "ok" }] });
  await run(old, turn({ effort: "max" }));
  expect("effort" in (old.sent[0] ?? {})).toBe(false);
  expect(await run(old, turn({ account }))).toMatchObject([{ type: "error", code: "runner_outdated" }]);
  expect(old.sent).toHaveLength(1);

  const out = link({ protocol: 13 });
  const refused = await run(out, turn({ account: { ...account, status: "signed_out" } }));
  expect(refused).toMatchObject([{ type: "error", code: "not_logged_in", retryable: true }]);
  expect((refused[0] as { message: string }).message).toContain('"Pessoal"');
  expect(out.sent).toHaveLength(0);
});

test("live steering (protocol 15): the turn on its way takes messages through brain.steer; steer_read passes; null at the end", async () => {
  const steered: unknown[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const l: ComputerBrainLink = {
    ...link({ protocol: 15 }),
    async turn(_machineId, _request, { onEvent }) {
      onEvent({ type: "text_delta", text: "Working" });
      await gate;
      onEvent({ type: "steer_read", uuids: ["u1"] });
      onEvent({ type: "done", text: "Got it", session: { id: "x" } });
    },
    async steer(machineId, target, messages) {
      steered.push({ machineId, target, messages });
      return { status: "accepted", accepted: messages.map((m) => m.uuid) };
    },
  };
  const brain = new CodexBrain({
    link: l,
    mcp: async () => ({ token: "tok" }),
    agent: async () => ({ id: "agent", handle: "dev" }),
  });
  const handed: Array<((m: { uuid: string; text: string }[]) => Promise<unknown>) | null> = [];
  const events: BrainEvent[] = [];
  const running = (async () => {
    for await (const e of brain.run(turn(), { ...io(), steerable: (s) => handed.push(s) })) {
      events.push(e);
      if (e.type === "text_delta") {
        expect(await handed[0]?.([{ uuid: "u1", text: "also bye" }])).toEqual({ status: "accepted", accepted: ["u1"] });
        release();
      }
    }
  })();
  await running;
  expect(steered).toEqual([
    {
      machineId: "m1",
      target: { runId: turn().runId, session: SESSION, agent: { id: "agent", handle: "dev" } },
      messages: [{ uuid: "u1", text: "also bye" }],
    },
  ]);
  expect(events.map((e) => e.type)).toEqual(["text_delta", "steer_read", "done"]);
  expect(handed.at(-1)).toBeNull();
  expect(handed).toHaveLength(2);

  // An older runner (protocol 14) is never asked.
  const old: Array<unknown> = [];
  await collect(
    new CodexBrain({
      link: { ...l, ...link({ protocol: 14, events: [{ type: "done", text: "ok" }] }) },
      mcp: async () => ({ token: "t" }),
      agent: async () => ({ id: "agent", handle: "dev" }),
    }).run(turn(), { ...io(), steerable: (s) => old.push(s) }),
  );
  expect(old).toEqual([]);
});

test("a runner before CODEX_FOLDER_PROTOCOL: the turn stays in the agent's folder and its session, no checkout", async () => {
  const code = { cwd: "repos/acme/app", prompt: "# Your code\nacme/app is checked out." };
  const run = async (protocol: number) => {
    const l = link({ protocol, events: [{ type: "done", text: "ok" }] });
    let prepared = 0;
    const brain = new CodexBrain({
      link: l,
      mcp: async () => ({ token: "t" }),
      prepare: async () => {
        prepared++;
        return code;
      },
    });
    await collect(brain.run(turn({ session: { id: SESSION, resume: true, machineId: "m1", cwd: "" } }), io()));
    return { sent: l.sent[0], prepared };
  };
  // Such a runner reads a checkout in a folder nested in the agent's own, where it isn't: refused every turn.
  expect(await run(CODEX_FOLDER_PROTOCOL - 1)).toMatchObject({
    sent: { cwd: "", system: "You are Dev.", session: { id: SESSION, resume: true } },
    prepared: 0,
  });
  expect(await run(CODEX_FOLDER_PROTOCOL)).toMatchObject({
    sent: { cwd: "repos/acme/app", system: `You are Dev.\n\n${code.prompt}` },
    prepared: 1,
  });
});

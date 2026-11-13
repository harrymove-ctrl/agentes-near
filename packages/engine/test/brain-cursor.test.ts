import { expect, test } from "bun:test";
import { CURSOR_PROTOCOL } from "@agenteschat/adapters";
import { loginPerAgent } from "@agenteschat/providers/plans";
import {
  brainModelOptions,
  brainOptions,
  defaultBrainModel,
  isBrainKind,
  normalizeBrainModel,
} from "../src/brain-settings";
import { type BrainTurnRequest, type ComputerBrainLink, CursorBrain } from "../src/brains/codex";
import { computerBrainUnavailable, NO_AI_CODES, runBrainOf, UNAVAILABLE_CODES } from "../src/brains/select";
import type { BrainEvent, BrainTurn, SteerMessage } from "../src/brains/types";
import { defaultAccountLabel } from "../src/machine-accounts";
import type { MachineStatus } from "../src/machine-hub";

const SESSION = "0193aaaa-0000-7000-8000-00000000c0de";

const turn = (over: Partial<BrainTurn> = {}): BrainTurn => ({
  runId: "0193aaaa-0000-7000-8000-000000000001",
  orgId: "org",
  agentId: "agent",
  channelId: "channel",
  threadRootId: null,
  system: "You are Dev.",
  messages: [{ role: "user", content: "run the tests" }],
  tools: [],
  trigger: "run the tests",
  session: { id: SESSION, resume: false, machineId: "m1", cwd: "" },
  ...over,
});

function link(opts: {
  protocol?: number;
  cursor?: boolean;
  tools?: { claude: boolean; codex: boolean; cursor?: boolean; commands: boolean };
  events?: BrainEvent[];
}): ComputerBrainLink & { sent: BrainTurnRequest[]; steered: SteerMessage[][] } {
  const sent: BrainTurnRequest[] = [];
  const steered: SteerMessage[][] = [];
  return {
    sent,
    steered,
    async status() {
      return {
        online: true,
        execAllowed: true,
        protocol: opts.protocol ?? CURSOR_PROTOCOL,
        executors: opts.cursor === false ? {} : { cursor: { version: "2026.10.28-1a2b3c4" } },
        ...(opts.tools ? { access: { tools: opts.tools } } : {}),
      };
    },
    async turn(_machineId, request, { onEvent }) {
      sent.push(request);
      for (const e of opts.events ?? []) onEvent(e);
    },
    async steer(_m, _t, messages) {
      steered.push(messages);
      return { status: "unsupported", reason: "Cursor reads messages only between turns" };
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

test("a Cursor turn goes to the runner as kind cursor with the context, its events pass through, done carries our session", async () => {
  const l = link({
    events: [
      { type: "text_delta", text: "All good." },
      { type: "usage", input: 1000, output: 40, source: "plan", model: "Grok 5 Code" },
      { type: "done", text: "All good.", session: { id: "chat" } },
    ],
  });
  const brain = new CursorBrain({
    link: l,
    mcp: async () => ({ token: "tok" }),
    agent: async () => ({ id: "agent", handle: "dev" }),
    permissions: async () => ({ mode: "plan" }),
  });
  expect(brain.kind).toBe("cursor");
  const events = await collect(brain.run(turn({ model: "grok-5-code" }), io()));
  expect(events.at(-1)).toEqual({ type: "done", text: "All good.", session: { id: SESSION } });
  expect(l.sent[0]).toMatchObject({
    kind: "cursor",
    session: { id: SESSION, resume: false },
    model: "grok-5-code",
    system: "You are Dev.",
    mcp: { token: "tok" },
    permissions: { mode: "plan" },
  });
});

test("Cursor needs runner protocol 36, its CLI and its switch (Codex's on a runner that reports none)", async () => {
  const run = async (opts: Parameters<typeof link>[0]) =>
    (await collect(new CursorBrain({ link: link(opts), mcp: async () => ({ token: "t" }) }).run(turn(), io())))[0];
  expect(await run({ protocol: CURSOR_PROTOCOL - 1 })).toMatchObject({
    code: "runner_outdated",
    message: expect.stringContaining("Cursor"),
  });
  expect(await run({ cursor: false })).toMatchObject({ code: "cursor_missing", retryable: true });
  expect(await run({ tools: { claude: true, codex: true, cursor: false, commands: true } })).toMatchObject({
    code: "tool_off",
    message: expect.stringContaining("Cursor is turned off"),
  });
  expect(await run({ tools: { claude: true, codex: false, commands: true } })).toMatchObject({ code: "tool_off" });
  expect(await run({ tools: { claude: false, codex: true, commands: false } })).toMatchObject({ type: "done" });
  const signedOut = new CursorBrain({ link: link({}), mcp: async () => ({ token: "t" }) });
  const account = { id: "a1", label: "Cursor", status: "signed_out" as const };
  expect((await collect(signedOut.run(turn({ account }), io())))[0]).toMatchObject({
    code: "not_logged_in",
    message: expect.stringContaining('The Cursor account "Cursor"'),
  });
});

test("which brain a run thinks with, and why Cursor can't now: protocol, its switch, its CLI, its account", () => {
  expect(isBrainKind("cursor")).toBe(true);
  expect(runBrainOf({ brain: "cursor" })).toBe("cursor");
  expect(UNAVAILABLE_CODES.has("cursor_missing")).toBe(true);
  expect(NO_AI_CODES.has("cursor_missing")).toBe(true);
  const status = (over: Partial<MachineStatus> = {}): MachineStatus => ({
    id: "m1",
    orgId: "org",
    name: "MacBook",
    online: true,
    execAllowed: true,
    os: "darwin",
    protocol: CURSOR_PROTOCOL,
    pairedByUserId: "u1",
    executors: { cursor: { version: "2026.10.28-1a2b3c4" }, detectedAt: new Date().toISOString() },
    ...over,
  });
  expect(computerBrainUnavailable("cursor", "m1", status())).toBeNull();
  expect(computerBrainUnavailable("cursor", null, null)?.message).toBe("The agent has no computer for Cursor.");
  expect(computerBrainUnavailable("cursor", "m1", status({ protocol: CURSOR_PROTOCOL - 1 }))?.code).toBe(
    "runner_outdated",
  );
  expect(computerBrainUnavailable("cursor", "m1", status({ executors: { detectedAt: "x" } }))?.code).toBe(
    "cursor_missing",
  );
  // Codex being there never makes Cursor available.
  expect(
    computerBrainUnavailable("cursor", "m1", status({ executors: { codex: { version: "0.170.0" }, detectedAt: "x" } }))
      ?.code,
  ).toBe("cursor_missing");
  const off = { folders: [], tools: { claude: true, codex: true, cursor: false, commands: true } };
  expect(computerBrainUnavailable("cursor", "m1", status({ access: off }))?.code).toBe("tool_off");
  expect(computerBrainUnavailable("cursor", "m1", status({ pairedByUserId: null }))?.message).toContain(
    "Connect a Cursor account",
  );
});

test("Quem pensa lists Cursor with the models its CLI listed, the plan's own first; any model name is taken as typed", () => {
  const machine = (over: Record<string, unknown> = {}) => ({
    id: "m1",
    name: "mac",
    protocol: CURSOR_PROTOCOL,
    execAllowed: true,
    online: true,
    lastSeenAt: new Date(),
    deletedAt: null,
    executors: {
      cursor: {
        version: "2026.10.28-1a2b3c4",
        models: [
          { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
          { id: "grok-5-code", label: "Grok 5 Code", inPlan: true },
        ],
      },
      detectedAt: "x",
    },
    ...over,
  });
  const cursor = (m: ReturnType<typeof machine> | null) => brainOptions(m).find((o) => o.kind === "cursor");
  expect(cursor(machine())).toMatchObject({ available: true, defaultModel: null });
  expect(cursor(machine())?.models.map((o) => [o.value, o.label, o.inPlan ?? false])).toEqual([
    ["grok-5-code", "Grok 5 Code", true],
    ["claude-opus-5-5", "Claude Opus 5.5", false],
  ]);
  expect(cursor(null)?.reason).toBe("no_computer");
  expect(cursor(machine({ protocol: CURSOR_PROTOCOL - 1 }))?.reason).toBe("runner_old");
  expect(cursor(machine({ executors: { detectedAt: "x" } }))?.reason).toBe("not_installed");
  expect(cursor(machine({ access: { tools: { codex: false } } }))?.reason).toBe("tool_off");
  expect(cursor(machine({ access: { tools: { codex: false, cursor: true } } }))?.available).toBe(true);
  expect(brainModelOptions("cursor")).toEqual([]);
  expect(defaultBrainModel("cursor")).toBeNull();
  expect(normalizeBrainModel("cursor", "grok-5-code")).toBe("grok-5-code");
  expect(() => normalizeBrainModel("cursor", "rm -rf /")).toThrow();
});

test("Cursor accounts: named Cursor, signed in once per agent, a key thinks for several", () => {
  expect(defaultAccountLabel("cursor")).toBe("Cursor");
  expect(defaultAccountLabel("cursor", ["Cursor"])).toBe("Cursor 2");
  expect(loginPerAgent("cursor")).toBe(true);
  expect(loginPerAgent("cursor", "cursor")).toBe(true);
});

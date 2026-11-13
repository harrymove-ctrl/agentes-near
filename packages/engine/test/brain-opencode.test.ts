import { expect, test } from "bun:test";
import { OPENCODE_PROTOCOL } from "@agenteschat/adapters";
import { isOpencodeFreeModel, loginPerAgent, OPENCODE_FREE_MODELS } from "@agenteschat/providers/plans";
import { brainOptions, defaultBrainModel, isBrainKind, normalizeBrainModel } from "../src/brain-settings";
import { type BrainTurnRequest, type ComputerBrainLink, OpencodeBrain } from "../src/brains/codex";
import { computerBrainUnavailable, NO_AI_CODES, runBrainOf, UNAVAILABLE_CODES } from "../src/brains/select";
import type { BrainEvent, BrainTurn } from "../src/brains/types";
import { defaultAccountLabel } from "../src/machine-accounts";
import type { MachineStatus } from "../src/machine-hub";

const SESSION = "0193aaaa-0000-7000-8000-00000000f0de";

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
  opencode?: boolean;
  tools?: { claude: boolean; codex: boolean; opencode?: boolean; commands: boolean };
  events?: BrainEvent[];
  pairedByUserId?: string | null;
}): ComputerBrainLink & { sent: BrainTurnRequest[] } {
  const sent: BrainTurnRequest[] = [];
  return {
    sent,
    async status() {
      return {
        online: true,
        execAllowed: true,
        protocol: opts.protocol ?? OPENCODE_PROTOCOL,
        executors: opts.opencode === false ? {} : { opencode: { version: "1.19.5" } },
        ...(opts.tools ? { access: { tools: opts.tools } } : {}),
        ...(opts.pairedByUserId !== undefined ? { pairedByUserId: opts.pairedByUserId } : {}),
      };
    },
    async turn(_machineId, request, { onEvent }) {
      sent.push(request);
      for (const e of opts.events ?? []) onEvent(e);
    },
    async steer() {
      return { status: "unsupported", reason: "OpenCode reads messages only between turns" };
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

test("an OpenCode turn goes to the runner as kind opencode; its usage passes through as the person's", async () => {
  const l = link({
    events: [
      { type: "text_delta", text: "All good." },
      { type: "usage", input: 1000, output: 40, source: "plan", model: "opencode/big-pickle" },
      { type: "done", text: "All good.", session: { id: "ses_x" } },
    ],
  });
  const brain = new OpencodeBrain({
    link: l,
    mcp: async () => ({ token: "tok" }),
    agent: async () => ({ id: "agent", handle: "dev" }),
    permissions: async () => ({ mode: "work" }),
  });
  expect(brain.kind).toBe("opencode");
  const events = await collect(brain.run(turn({ model: "opencode/big-pickle" }), io()));
  expect(events.find((e) => e.type === "usage")).toMatchObject({ source: "plan", input: 1000 });
  expect(events.at(-1)).toEqual({ type: "done", text: "All good.", session: { id: SESSION } });
  expect(l.sent[0]).toMatchObject({ kind: "opencode", model: "opencode/big-pickle", mcp: { token: "tok" } });
});

test("OpenCode needs runner protocol 39, its CLI and its switch (Codex's on a runner that reports none)", async () => {
  const run = async (opts: Parameters<typeof link>[0]) =>
    (await collect(new OpencodeBrain({ link: link(opts), mcp: async () => ({ token: "t" }) }).run(turn(), io())))[0];
  expect(await run({ protocol: OPENCODE_PROTOCOL - 1 })).toMatchObject({
    code: "runner_outdated",
    message: expect.stringContaining("OpenCode"),
  });
  expect(await run({ opencode: false })).toMatchObject({ code: "opencode_missing", retryable: true });
  expect(await run({ tools: { claude: true, codex: true, opencode: false, commands: true } })).toMatchObject({
    code: "tool_off",
    message: expect.stringContaining("OpenCode is turned off"),
  });
  expect(await run({ tools: { claude: true, codex: false, commands: true } })).toMatchObject({ code: "tool_off" });
  expect(await run({ tools: { claude: false, codex: false, opencode: true, commands: false } })).toMatchObject({
    type: "done",
  });
});

test("on a computer nobody connected, a turn with no account is the free tier: OpenCode's own models only", async () => {
  const done: BrainEvent[] = [{ type: "done", text: "ok", session: { id: "s" } }];
  const send = async (over: Partial<BrainTurn>, pairedByUserId: string | null) => {
    const l = link({ events: done, pairedByUserId });
    const events = await collect(
      new OpencodeBrain({ link: l, mcp: async () => ({ token: "t" }) }).run(turn(over), io()),
    );
    return { sent: l.sent[0], first: events[0] };
  };
  expect((await send({ model: "opencode/big-pickle" }, null)).sent?.freeTier).toBe(true);
  expect((await send({ model: "opencode/big-pickle" }, "u1")).sent?.freeTier).toBeUndefined();
  const account = {
    id: "0193eeee-0000-7000-8000-0000000000f1",
    label: "Zen",
    status: "active",
  } as BrainTurn["account"];
  expect((await send({ account }, null)).sent?.freeTier).toBeUndefined();
  const paid = await send({ model: "anthropic/claude-x" }, null);
  expect(paid.sent).toBeUndefined();
  expect(paid.first).toMatchObject({ type: "error", code: "not_logged_in" });
  expect((await send({ model: "anthropic/claude-x" }, "u1")).sent?.model).toBe("anthropic/claude-x");
});

test("which brain a run thinks with, and why OpenCode can't now", () => {
  expect(isBrainKind("opencode")).toBe(true);
  expect(runBrainOf({ brain: "opencode" })).toBe("opencode");
  expect(UNAVAILABLE_CODES.has("opencode_missing")).toBe(true);
  expect(NO_AI_CODES.has("opencode_missing")).toBe(true);
  const status = (over: Partial<MachineStatus> = {}): MachineStatus => ({
    id: "m1",
    orgId: "org",
    name: "MacBook",
    online: true,
    execAllowed: true,
    os: "linux",
    protocol: OPENCODE_PROTOCOL,
    pairedByUserId: "u1",
    executors: { opencode: { version: "1.19.5" }, detectedAt: new Date().toISOString() },
    ...over,
  });
  expect(computerBrainUnavailable("opencode", "m1", status())).toBeNull();
  expect(computerBrainUnavailable("opencode", null, null)?.message).toBe("The agent has no computer for OpenCode.");
  expect(computerBrainUnavailable("opencode", "m1", status({ protocol: OPENCODE_PROTOCOL - 1 }))?.message).toBe(
    "The runner on MacBook is too old for OpenCode agents. Its owner updates the agentes app there, or runs `agentes-runner update`.",
  );
  expect(computerBrainUnavailable("opencode", "m1", status({ executors: { detectedAt: "x" } }))?.code).toBe(
    "opencode_missing",
  );
  const off = { folders: [], tools: { claude: true, codex: true, opencode: false, commands: true } };
  expect(computerBrainUnavailable("opencode", "m1", status({ access: off }))?.message).toBe(
    "OpenCode is turned off on MacBook (its owner can turn it on in the agentes app).",
  );
});

test("Quem pensa lists OpenCode with the models its CLI listed, free ones first or beside their paid model, else OpenCode's free tier", () => {
  const machine = (over: Record<string, unknown> = {}) => ({
    id: "m1",
    name: "box",
    protocol: OPENCODE_PROTOCOL,
    execAllowed: true,
    online: true,
    lastSeenAt: new Date(),
    deletedAt: null,
    executors: {
      opencode: {
        version: "1.19.5",
        models: [{ id: "opencode/glm-5.3" }, { id: "opencode/big-pickle", label: "Big Pickle", free: true }],
      },
      detectedAt: "x",
    },
    ...over,
  });
  const opencode = (m: ReturnType<typeof machine> | null) => brainOptions(m).find((o) => o.kind === "opencode");
  expect(opencode(machine())).toMatchObject({ available: true, defaultModel: null });
  expect(opencode(machine())?.models).toEqual([
    { value: "opencode/big-pickle", label: "Big Pickle", free: true },
    { value: "opencode/glm-5.3", label: "glm-5.3" },
  ]);
  // With a key the CLI lists the paid models too: each free variant sits right after its paid model, with no price.
  const keyed = opencode(
    machine({
      executors: {
        opencode: {
          version: "1.19.5",
          models: [
            { id: "opencode/deepseek-v4-pro" },
            { id: "opencode/deepseek-v4.1-flash" },
            { id: "opencode/deepseek-v4.1-flash-free", label: "DeepSeek V4.1 Flash Free", free: true },
            { id: "opencode/glm-5.3" },
            { id: "opencode/glm-5.3-flash" },
            { id: "opencode/glm-5.3-flash-free", label: "GLM-5.3 Flash Free", free: true },
            { id: "opencode/big-pickle", label: "Big Pickle", free: true },
          ],
        },
        detectedAt: "x",
      },
    }),
  )?.models;
  expect(keyed?.map((m) => [m.value, m.free === true])).toEqual([
    ["opencode/big-pickle", true],
    ["opencode/deepseek-v4-pro", false],
    ["opencode/deepseek-v4.1-flash", false],
    ["opencode/deepseek-v4.1-flash-free", true],
    ["opencode/glm-5.3", false],
    ["opencode/glm-5.3-flash", false],
    ["opencode/glm-5.3-flash-free", true],
  ]);
  expect(keyed?.find((m) => m.value === "opencode/glm-5.3-flash-free")?.label).toBe("GLM-5.3 Flash Free");
  // A CLI that listed nothing (offline at detection): OpenCode's free tier, all marked free.
  const fallback = opencode(machine({ executors: { opencode: { version: "1.19.5" }, detectedAt: "x" } }))?.models;
  expect(fallback?.map((m) => m.value)).toEqual(OPENCODE_FREE_MODELS.map((m) => m.id));
  expect(fallback?.every((m) => m.free === true)).toBe(true);
  expect(opencode(null)?.reason).toBe("no_computer");
  expect(opencode(machine({ protocol: OPENCODE_PROTOCOL - 1 }))?.reason).toBe("runner_old");
  expect(opencode(machine({ executors: { detectedAt: "x" } }))?.reason).toBe("not_installed");
  expect(opencode(machine({ access: { tools: { codex: false } } }))?.reason).toBe("tool_off");
  expect(opencode(machine({ access: { tools: { codex: false, opencode: true } } }))?.available).toBe(true);
  expect(defaultBrainModel("opencode")).toBeNull();
  expect(normalizeBrainModel("opencode", "opencode/kimi-k3")).toBe("opencode/kimi-k3");
  expect(() => normalizeBrainModel("opencode", "big-pickle")).toThrow();
});

test("OpenCode's free tier and accounts: free ids, named OpenCode, a key thinks for several agents", () => {
  for (const id of [
    "opencode/big-pickle",
    "opencode/beam-free",
    "opencode/deepseek-v4.1-flash-free",
    "opencode/flint-40b-free",
    "opencode/glm-5.3-flash-free",
    "opencode/jev-1.13-free",
    "opencode/mimo-v2.6-flash-free",
    "opencode/nemotron-3.5-lightning-free",
    "opencode/nemotron-3.5-super-vl-free",
  ]) {
    expect(isOpencodeFreeModel(id)).toBe(true);
  }
  expect(isOpencodeFreeModel("opencode/glm-5.3")).toBe(false);
  expect(isOpencodeFreeModel("other/thing-free")).toBe(false);
  expect(defaultAccountLabel("opencode")).toBe("OpenCode");
  expect(loginPerAgent("opencode", "zen")).toBe(true);
});

import { expect, test } from "bun:test";
import { GROK_PROTOCOL, LOCKED_BRAIN_PROTOCOL } from "@agenteschat/adapters";
import { GROK_BUILD_MODELS, loginPerAgent, sharedSignIn } from "@agenteschat/providers/plans";
import { brainOptions, defaultBrainModel, grokModels, isBrainKind } from "../src/brain-settings";
import { type BrainTurnRequest, type ComputerBrainLink, GrokBrain } from "../src/brains/codex";
import { computerBrainUnavailable, NO_AI_CODES, UNAVAILABLE_CODES } from "../src/brains/select";
import { BRAIN_NAMES, BRAIN_PLAN_NAMES, type BrainEvent, type BrainTurn, isComputerBrain } from "../src/brains/types";
import { defaultAccountLabel, sharesSignIns } from "../src/machine-accounts";
import type { MachineStatus } from "../src/machine-hub";
import { scrubSignIns } from "../src/tool-detail";

const SESSION = "0193aaaa-0000-7000-8000-00000000f0de";
const ACCOUNT = { id: "0193eeee-0000-7000-8000-000000000001", label: "Grok", status: "active" as const };

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
  account: ACCOUNT,
  ...over,
});

function link(opts: {
  protocol?: number;
  grok?: boolean;
  tools?: { claude: boolean; codex: boolean; grok?: boolean; commands: boolean };
  events?: BrainEvent[];
}): ComputerBrainLink & { sent: BrainTurnRequest[] } {
  const sent: BrainTurnRequest[] = [];
  return {
    sent,
    async status() {
      return {
        online: true,
        execAllowed: true,
        protocol: opts.protocol ?? GROK_PROTOCOL,
        executors: opts.grok === false ? {} : { grok: { version: "grok 1.0.34 (3736acbc8658) [stable]" } },
        ...(opts.tools ? { access: { tools: opts.tools } } : {}),
      };
    },
    async turn(_machineId, request, { onEvent }) {
      sent.push(request);
      for (const e of opts.events ?? []) onEvent(e);
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

const brain = (l: ComputerBrainLink, permissions?: BrainTurnRequest["permissions"]) =>
  new GrokBrain({
    link: l,
    mcp: async () => ({ token: "tok" }),
    ...(permissions ? { permissions: async () => permissions } : {}),
  });

test("a Grok turn goes to the runner as kind grok with its account; its usage passes through as the person's plan", async () => {
  const l = link({
    events: [
      { type: "text_delta", text: "All good." },
      { type: "usage", input: 1000, output: 40, source: "plan", model: "grok-4.6", cacheRead: 400 },
      { type: "done", text: "All good.", session: { id: "9a0c" } },
    ],
  });
  const events = await collect(brain(l).run(turn({ model: "grok-4.6" }), io()));
  expect(l.sent[0]).toMatchObject({ kind: "grok", account: ACCOUNT.id, model: "grok-4.6", session: { id: SESSION } });
  expect(events.at(-1)).toEqual({ type: "done", text: "All good.", session: { id: SESSION } });
  expect(events.find((e) => e.type === "usage")).toMatchObject({ source: "plan", cacheRead: 400 });
});

test("Grok refuses before the runner: an older runner, its CLI missing, its switch off (following Codex's when unset)", async () => {
  const first = async (l: ComputerBrainLink, permissions?: BrainTurnRequest["permissions"]) =>
    (await collect(brain(l, permissions).run(turn(), io())))[0];
  expect(await first(link({ protocol: GROK_PROTOCOL - 1 }))).toMatchObject({ code: "runner_outdated" });
  expect(await first(link({ grok: false }))).toMatchObject({ code: "grok_missing" });
  expect(await first(link({ tools: { claude: true, codex: false, commands: true } }))).toMatchObject({
    code: "tool_off",
  });
  expect(await first(link({ tools: { claude: true, codex: true, grok: false, commands: true } }))).toMatchObject({
    code: "tool_off",
  });
  // The team's right hand on Grok: the runner locks it down from protocol 41 on, which every Grok runner has.
  expect(GROK_PROTOCOL).toBeGreaterThan(LOCKED_BRAIN_PROTOCOL);
  const l = link({ events: [{ type: "done", text: "ok" }] });
  await collect(brain(l, { mode: "chat" }).run(turn(), io()));
  expect(l.sent[0]?.permissions).toEqual({ mode: "chat" });
  expect(UNAVAILABLE_CODES.has("grok_missing")).toBe(true);
  expect(NO_AI_CODES.has("grok_missing")).toBe(true);
});

test("Quem pensa: Grok where its runner and CLI are, its models as the CLI listed them (else the known ones), its CLI's default", () => {
  const machine = (over: Record<string, unknown> = {}) =>
    ({
      id: "m1",
      name: "mac",
      execAllowed: true,
      protocol: GROK_PROTOCOL,
      online: true,
      lastSeenAt: new Date(),
      executors: { grok: { version: "grok 1.0.34", models: [{ id: "grok-4.6" }] } },
      ...over,
    }) as never;
  const option = (m: unknown) => brainOptions(m as never).find((o) => o.kind === "grok");
  expect(option(machine())).toMatchObject({ available: true, defaultModel: null, models: [{ value: "grok-4.6" }] });
  expect(option(machine({ protocol: GROK_PROTOCOL - 1 }))).toMatchObject({ available: false, reason: "runner_old" });
  expect(option(machine({ executors: { detectedAt: "x" } }))).toMatchObject({
    available: false,
    reason: "not_installed",
  });
  expect(option(machine({ executors: {} }))).toMatchObject({ available: false, reason: "not_reported" });
  expect(grokModels([]).map((m) => m.value)).toEqual(GROK_BUILD_MODELS.map((m) => m.id));
  expect(defaultBrainModel("grok")).toBeNull();
  expect(isBrainKind("grok") && isComputerBrain("grok")).toBe(true);
  expect([BRAIN_NAMES.grok, BRAIN_PLAN_NAMES.grok, defaultAccountLabel("grok")]).toEqual([
    "Grok Build",
    "Grok",
    "Grok",
  ]);
});

test("a Grok sign-in is per agent and never made for all agents where each is its own OS user", () => {
  expect(loginPerAgent("grok")).toBe(true);
  expect(sharedSignIn("grok")).toBe(false);
  const system = { protocol: GROK_PROTOCOL, executors: { mode: "system" as const } };
  expect(sharesSignIns(system as never, "grok")).toBe(false);
  expect(sharesSignIns({ protocol: GROK_PROTOCOL, executors: {} } as never, "grok")).toBe(true);
});

test("availability: Grok's account decides, signed out or at its limit says so", () => {
  const status = {
    name: "mac",
    online: true,
    execAllowed: true,
    protocol: GROK_PROTOCOL,
    pairedByUserId: "u1",
    executors: { grok: { version: "grok 1.0.34" }, detectedAt: new Date().toISOString() },
  } as unknown as MachineStatus;
  expect(computerBrainUnavailable("grok", "m1", status, Date.now(), ACCOUNT)).toBeNull();
  expect(
    computerBrainUnavailable("grok", "m1", status, Date.now(), { ...ACCOUNT, status: "signed_out" }),
  ).toMatchObject({ code: "not_logged_in" });
  expect(
    computerBrainUnavailable("grok", "m1", { ...status, executors: { detectedAt: new Date().toISOString() } } as never),
  ).toMatchObject({ code: "grok_missing" });
});

test("the right hand's reply never carries an xAI key", () => {
  const out = scrubSignIns(
    "XAI_API_KEY=xai-AbCdEfGhIjKlMnOpQrStUvWx1234 and xai-ZyXwVuTsRqPoNmLkJiHg9876",
    "[removed]",
  );
  expect(out.text).not.toContain("xai-");
  expect(out.found).toBeGreaterThan(0);
});

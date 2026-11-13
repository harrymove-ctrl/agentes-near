import { afterEach, expect, test } from "bun:test";
import { ACCOUNTS_PROTOCOL, LOCKED_BRAIN_PROTOCOL, MACHINE_PROTOCOL_VERSION } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import {
  type Brain,
  BrainFailure,
  type BrainTurn,
  createAgentRuns,
  createClaudeCodeBrain,
  createJobHandlers,
  drainOutbox,
  getAgentBrain,
  insertMessage,
  type MachineStatus,
  machineAgents,
  mayFallBack,
  OpencodeBrain,
  openPersonAgentDm,
  PLAN_OPENED_JOB,
  postPersonMessage,
  queuePlanOpenedEmail,
  RIGHT_HAND,
  RIGHT_HAND_TURN,
  resolveBrain,
  rightHandNoAiReason,
  setAgentBrain,
  UNAVAILABLE_CODES,
} from "../src";
import { agentAiState } from "../src/ai-status";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

/*
 * ADR 0137 §1, §4 and §7, amended 2026-11-04: the team's right hand thinks with a person's Claude plan, as that plan's
 * CLI on the computer where it is signed in, locked down to its own tools; the plan's owner pays; "Atende outras
 * pessoas" decides whether other people's DMs think with it; with its computer away it says why, never on a key.
 */

let f: Fixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

const ANAS = "0193dddd-0000-4000-8000-0000000000a1";
const CAIOS = "0193dddd-0000-4000-8000-0000000000c1";

const statusOf = (id: string, over: Partial<MachineStatus> = {}): MachineStatus => ({
  id,
  orgId: "org",
  name: "Mac",
  online: true,
  execAllowed: true,
  os: "darwin",
  protocol: MACHINE_PROTOCOL_VERSION,
  executors: { claude: { version: "2.1.318", loggedIn: true }, detectedAt: new Date().toISOString() },
  ...over,
});

/** Lodi, Ana's computer with her Claude account and Caio's (an admin), Bia a member. */
async function world() {
  const fx = await setup({ rightHand: true });
  f = fx;
  const { machineId } = await pairMachine({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, {
    name: "Mac",
    protocol: ACCOUNTS_PROTOCOL,
    exec: true,
  });
  await fx.db
    .update(schema.machines)
    .set({ executors: { claude: { version: "2.1.318", loggedIn: true }, detectedAt: new Date().toISOString() } })
    .where(eq(schema.machines.id, machineId));
  const bia = await addMember(fx.db, fx.org.id, "member", "bia");
  const caio = await addMember(fx.db, fx.org.id, "admin", "caio");
  const account = (id: string, createdBy: string, kind = "claude_code") =>
    fx.db
      .insert(schema.machineAccounts)
      .values({ id, orgId: fx.org.id, machineId, kind, label: id, status: "active", createdBy, shared: true });
  await account(ANAS, fx.owner.id);
  await account(CAIOS, caio.id);
  const lodi = async () => {
    const [row] = await fx.db
      .select()
      .from(schema.agents)
      .where(and(eq(schema.agents.orgId, fx.org.id), eq(schema.agents.builtin, RIGHT_HAND)));
    if (!row) throw new Error("no right hand");
    return row;
  };
  return { fx, deps: { db: fx.db }, machineId, bia, caio, lodi, account };
}

const codeOf = (p: Promise<unknown>) => p.then(() => null).catch((e: { code?: string }) => e.code);

test("Lodi takes a Claude plan signed in as an account, never a computer's own sign-in, and stays on no computer", async () => {
  const { fx, deps, machineId, caio, lodi } = await world();
  const id = (await lodi()).id;
  expect(await codeOf(setAgentBrain(deps, fx.owner.id, fx.org.id, id, { brain: "claude_code" }))).toBe(
    "brain.right_hand_account",
  );
  // Before a plan: the computer it would sign one in on, the caller's.
  const before = await getAgentBrain(deps, fx.owner.id, fx.org.id, id);
  expect(before).toMatchObject({ brain: "model", computer: { machineId }, canUsePlans: true });
  const view = await setAgentBrain(deps, fx.owner.id, fx.org.id, id, { brain: "claude_code", account: ANAS });
  expect(view).toMatchObject({ brain: "claude_code", account: ANAS, computer: { machineId }, onlyOwner: true });
  expect(await lodi()).toMatchObject({
    brain: "claude_code",
    brainAccountId: ANAS,
    machineId: null,
    planForOthers: false,
  });
  // Its audience is its own: everyone still has their DM with it.
  expect((await lodi()).audienceMode).toBe("everyone");
  // Its user there holds the sign-in while it thinks (system mode lends the folder by the `agents` frame).
  const listed = (await machineAgents(fx.db, fx.org.id, machineId)).find((a) => a.id === id);
  expect(listed).toMatchObject({ account: ANAS });
  // It thinks on several plans, sandboxed ones too: no containers service of its own (ADR 0169).
  expect(listed?.containers).toBeUndefined();
  // An admin's view: Ana's plan, not theirs to give; "Atende outras pessoas" as for any agent on its owner's plan.
  expect(await getAgentBrain(deps, caio.id, fx.org.id, id)).toMatchObject({ canUsePlans: false, account: ANAS });
  expect(await codeOf(setAgentBrain(deps, caio.id, fx.org.id, id, { account: ANAS, onlyOwner: true }))).toBeNull();
  await setAgentBrain(deps, fx.owner.id, fx.org.id, id, { onlyOwner: false });
  expect((await lodi()).planForOthers).toBe(true);
  // Anyone who sets Lodi's AI takes it back to a key.
  await setAgentBrain(deps, caio.id, fx.org.id, id, { brain: "model" });
  expect(await lodi()).toMatchObject({ brain: "model", brainAccountId: null, machineId: null });
  // Caio gives it his own.
  await setAgentBrain(deps, caio.id, fx.org.id, id, { brain: "claude_code", account: CAIOS });
  expect(await lodi()).toMatchObject({ brainAccountId: CAIOS, planForOthers: false });
});

test("a plan given to Lodi starts with its switches off, whatever was set before it", async () => {
  const { fx, deps, caio, lodi } = await world();
  const id = (await lodi()).id;
  // An admin arms paid extra usage while it is on a key: it doesn't carry over to Ana's plan.
  await setAgentBrain(deps, caio.id, fx.org.id, id, { extraUsage: true });
  await setAgentBrain(deps, fx.owner.id, fx.org.id, id, { brain: "claude_code", account: ANAS });
  expect(await lodi()).toMatchObject({ brainAccountId: ANAS, brainExtraUsage: false, planForOthers: false });
  // Ana opens hers to others; moved straight onto Caio's plan, his starts closed.
  await setAgentBrain(deps, fx.owner.id, fx.org.id, id, { onlyOwner: false, extraUsage: true });
  await setAgentBrain(deps, caio.id, fx.org.id, id, { account: CAIOS });
  expect(await lodi()).toMatchObject({ brainAccountId: CAIOS, brainExtraUsage: false, planForOthers: false });
});

test("its turns think on the plan's computer and owner; another person's DM only once the plan answers others", async () => {
  const { fx, deps, machineId, bia, lodi } = await world();
  await setAgentBrain(deps, fx.owner.id, fx.org.id, (await lodi()).id, { brain: "claude_code", account: ANAS });
  const agent = await lodi();
  const runIn = async (userId: string) => {
    const dm = await openPersonAgentDm(fx.db, fx.org.id, userId, agent.id);
    const m = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, userId, fx.org.id, dm.id, { body: "oi" });
    const [run] = await fx.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, m.id));
    if (!run) throw new Error("no run");
    return { run, dm };
  };
  const machines = { status: async (id: string) => statusOf(id) };
  const ana = await runIn(fx.owner.id);
  const plan = await resolveBrain({ db: fx.db, machines }, agent, ana.run, ana.dm.id);
  expect(plan).toMatchObject({ kind: "claude_code", account: { id: ANAS }, session: { machineId } });
  expect(plan.unavailable).toBeUndefined();
  // Bia's DM: Ana's plan answers only Ana.
  const theirs = await runIn(bia.id);
  expect((await resolveBrain({ db: fx.db, machines }, agent, theirs.run, theirs.dm.id)).unavailable).toMatchObject({
    code: "plan_not_shared",
  });
  await setAgentBrain(deps, fx.owner.id, fx.org.id, agent.id, { onlyOwner: false });
  const open = await lodi();
  expect((await resolveBrain({ db: fx.db, machines }, open, theirs.run, theirs.dm.id)).unavailable).toBeUndefined();
  // A runner that can't lock Claude Code down never gets its turn.
  const old = { status: async (id: string) => statusOf(id, { protocol: LOCKED_BRAIN_PROTOCOL - 1 }) };
  expect((await resolveBrain({ db: fx.db, machines: old }, open, ana.run, ana.dm.id)).unavailable).toMatchObject({
    code: "runner_outdated",
  });
  // It never stands in on the API, and its state says the computer is away, not "no AI".
  expect(mayFallBack(open, { background: false })).toBe(false);
  const away = { status: async (id: string) => statusOf(id, { online: false }) };
  expect(await agentAiState({ db: fx.db, gateway: fx.gateway, machines: away }, open)).toEqual({ state: "waiting" });
});

test("its computer asleep: one line says why, the run fails at once, no wait and never a key", async () => {
  const { fx, deps, lodi } = await world();
  await setAgentBrain(deps, fx.owner.id, fx.org.id, (await lodi()).id, { brain: "claude_code", account: ANAS });
  const agent = await lodi();
  let turns = 0;
  const brain: Brain = {
    kind: "claude_code",
    async *run() {
      turns++;
      yield { type: "done", text: "nope" };
    },
  };
  const handlers = createJobHandlers({
    ...fx.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id, { online: false, lastSeenAt: new Date(0).toISOString() }) },
  });
  const dm = await openPersonAgentDm(fx.db, fx.org.id, fx.owner.id, agent.id);
  await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, dm.id, { body: "oi" });
  await drainOutbox(fx.db, handlers);
  const [run] = await fx.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.agentId, agent.id));
  expect(run?.status).toBe("failed");
  expect(run?.brain).not.toBe("model");
  expect(turns).toBe(0);
  const cards = (await fx.db.select().from(schema.messages).where(eq(schema.messages.channelId, dm.id))).filter(
    (m) => m.meta.bodyCode === "no_ai",
  );
  expect(cards).toHaveLength(1);
  expect(cards[0]?.meta.noAi).toMatchObject({ agentId: agent.id, reason: "computer_away" });
  // Nothing went to the API (no model call recorded for it).
  const usage = await fx.db.select().from(schema.usageRecords).where(eq(schema.usageRecords.agentId, agent.id));
  expect(usage.filter((u) => u.billedTo !== "plan")).toEqual([]);
});

test("its plan's CLI failing: its line says what the CLI said, the card keeps the way to a key", async () => {
  const { fx, deps, lodi } = await world();
  await setAgentBrain(deps, fx.owner.id, fx.org.id, (await lodi()).id, { brain: "claude_code", account: ANAS });
  const agent = await lodi();
  const brain: Brain = {
    kind: "claude_code",
    async *run() {
      yield {
        type: "error",
        code: "claude_failed",
        message: "Claude Code ended without an answer (exit 1): Error: Invalid settings file: hooks must be an object",
        retryable: true,
      };
    },
  };
  const handlers = createJobHandlers({
    ...fx.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  const dm = await openPersonAgentDm(fx.db, fx.org.id, fx.owner.id, agent.id);
  await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, dm.id, { body: "oi" });
  await drainOutbox(fx.db, handlers);
  const [run] = await fx.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.agentId, agent.id));
  expect(run?.status).toBe("failed");
  const cards = (await fx.db.select().from(schema.messages).where(eq(schema.messages.channelId, dm.id))).filter(
    (m) => m.meta.bodyCode === "no_ai",
  );
  expect(cards.map((m) => m.meta.noAi)).toMatchObject([
    { reason: "cli_failed", why: "Invalid settings file: hooks must be an object" },
  ]);
  expect(cards[0]?.body).toBe(
    "I can't answer now: my plan's AI stopped with an error (Invalid settings file: hooks must be an object).",
  );
});

test("a request no person made, on a plan that answers only its owner: its line never says to connect a plan", async () => {
  const { fx, deps, lodi: helper } = await world();
  await setAgentBrain(deps, fx.owner.id, fx.org.id, (await helper()).id, { brain: "claude_code", account: ANAS });
  const agent = await helper();
  let turns = 0;
  const brain: Brain = {
    kind: "claude_code",
    async *run() {
      turns++;
      yield { type: "done", text: "ok" };
    },
  };
  const machines = { status: async (id: string) => statusOf(id) };
  const handlers = createJobHandlers({ ...fx.jobDeps, brains: { claude_code: () => brain }, machines });
  // Another agent asks it on its own, in a channel: nobody is behind that.
  const asked = await insertMessage(fx.db, {
    orgId: fx.org.id,
    channelId: fx.general.id,
    author: { type: "agent", agentId: fx.agent.id, runId: null, hop: 1, stretchId: null },
    body: `@${agent.handle} cria o canal de vendas`,
  });
  const [run] = await createAgentRuns(fx.db, asked, [agent.id], "mention");
  if (!run) throw new Error("no run");
  expect((await resolveBrain({ db: fx.db, machines }, agent, run, fx.general.id)).unavailable).toMatchObject({
    code: "plan_unattended",
  });
  await drainOutbox(fx.db, handlers);
  const [ended] = await fx.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.id));
  expect(ended?.status).toBe("failed");
  expect(turns).toBe(0);
  const cards = (await fx.db.select().from(schema.messages).where(eq(schema.messages.authorAgentId, agent.id))).filter(
    (m) => m.meta.bodyCode === "no_ai",
  );
  expect(cards.map((m) => (m.meta.noAi as { reason?: string }).reason)).toEqual(["plan_unattended"]);
  expect(cards[0]?.body).toBe(
    "I didn't answer: the request didn't come from a person, and the workspace's plan serves only its owner.",
  );
});

test("its CLI killed at a tool of its own after a bridge call: nothing of the turn is posted, only its line", async () => {
  const { fx, deps, lodi } = await world();
  await setAgentBrain(deps, fx.owner.id, fx.org.id, (await lodi()).id, { brain: "claude_code", account: ANAS });
  const agent = await lodi();
  const brain: Brain = {
    kind: "claude_code",
    async *run() {
      yield { type: "text_delta", text: "Looking it up for you " };
      yield { type: "tool_call", id: "c1", name: "search", input: {}, executed: { content: "ok" } };
      yield { type: "error", code: "tools_not_locked", message: "Codex used a tool of its own", retryable: false };
    },
  };
  const handlers = createJobHandlers({
    ...fx.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  const dm = await openPersonAgentDm(fx.db, fx.org.id, fx.owner.id, agent.id);
  await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, dm.id, { body: "oi" });
  await drainOutbox(fx.db, handlers);
  const [run] = await fx.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.agentId, agent.id));
  expect(run?.status).toBe("failed");
  const said = (await fx.db.select().from(schema.messages).where(eq(schema.messages.channelId, dm.id))).filter(
    (m) => m.authorAgentId === agent.id,
  );
  expect(said.map((m) => m.meta.bodyCode)).toEqual(["no_ai"]);
  expect(said[0]?.meta.noAi).toMatchObject({ reason: "plan_tools" });
  expect(said.some((m) => m.body.includes("Looking it up"))).toBe(false);
});

test("its plan's CLI failing: its line says so, and what the CLI said stays in the run's steps and is reported", async () => {
  const { fx, deps, lodi } = await world();
  await setAgentBrain(deps, fx.owner.id, fx.org.id, (await lodi()).id, { brain: "claude_code", account: ANAS });
  const agent = await lodi();
  // A CLI that refuses to start on that computer fails every turn the same way, in a few seconds.
  const words = "Claude Code ended without an answer (exit 1): error: the sandbox could not start here";
  const brain: Brain = {
    kind: "claude_code",
    async *run() {
      yield { type: "error", code: "claude_failed", message: words, retryable: true };
    },
  };
  const handlers = createJobHandlers({
    ...fx.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  const dm = await openPersonAgentDm(fx.db, fx.org.id, fx.owner.id, agent.id);
  await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, dm.id, { body: "oi" });
  const reported: { code: string; message: string }[] = [];
  await drainOutbox(fx.db, handlers, {
    onError: (_job, error, outcome) => {
      if (outcome === "failed" && error instanceof BrainFailure)
        reported.push({ code: error.code, message: error.message });
    },
  });
  const [run] = await fx.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.agentId, agent.id));
  expect(run).toMatchObject({ status: "failed", error: "no_ai" });
  const cards = (await fx.db.select().from(schema.messages).where(eq(schema.messages.channelId, dm.id))).filter(
    (m) => m.meta.bodyCode === "no_ai",
  );
  expect(cards.map((m) => (m.meta.noAi as { reason?: string }).reason)).toEqual(["cli_failed"]);
  const steps = await fx.db
    .select({ data: schema.agentRunSteps.data })
    .from(schema.agentRunSteps)
    .where(and(eq(schema.agentRunSteps.runId, run?.id ?? ""), eq(schema.agentRunSteps.kind, "error")));
  expect(steps.map((s) => s.data)).toContainEqual({
    reason: "brain_unavailable",
    code: "claude_failed",
    message: words,
  });
  expect(reported).toEqual([{ code: "claude_failed", message: words }]);
});

test("its turn goes to the runner as the locked-down chat profile, with no checkout and none of the owner's servers", async () => {
  const sent: Record<string, unknown>[] = [];
  const hub = {
    status: async (id: string) => statusOf(id),
    call: async (_machineId: string, request: Record<string, unknown>) => {
      sent.push(request);
      return { runId: "r", final: { type: "done", text: "ok" } };
    },
  };
  let prepared = 0;
  const brain = createClaudeCodeBrain({
    hub: hub as never,
    pubsub: { publish: async () => {}, subscribe: () => () => {} } as never,
    agentScope: async () => ({ id: "a", handle: "lodi" }),
    permissions: () => RIGHT_HAND_TURN,
    personalMcp: () => true,
    prepare: async () => {
      prepared++;
      return { cwd: "repos/acme/app", prompt: "# Your code", start: "" } as never;
    },
    finalGraceMs: 0,
  });
  const turn = {
    runId: "0193bbbb-0000-7000-8000-000000000001",
    orgId: "o",
    agentId: "a",
    channelId: "c",
    threadRootId: null,
    system: "You are Lodi.",
    messages: [{ role: "user", content: "oi" }],
    tools: [],
    trigger: "oi",
    session: { id: "0193aaaa-0000-7000-8000-000000000001", resume: false, machineId: "m", cwd: "" },
  } satisfies BrainTurn;
  const events = [];
  for await (const e of brain.run(turn, {
    signal: new AbortController().signal,
    executeTool: async () => ({ content: "" }),
  }))
    events.push(e);
  expect(events.at(-1)).toMatchObject({ type: "done" });
  expect(prepared).toBe(0);
  expect(sent[0]).toMatchObject({ op: "brain.turn", permissions: { mode: "chat" }, personalMcp: false, cwd: "" });
  expect(sent[0]).not.toHaveProperty("personWaiting");
  sent.length = 0;
  for await (const _ of brain.run(
    { ...turn, personWaiting: true },
    { signal: new AbortController().signal, executeTool: async () => ({ content: "" }) },
  ));
  expect(sent[0]).toMatchObject({ personWaiting: true });
  // An older runner reads any mode but `plan` as `work`: nothing is sent to it.
  sent.length = 0;
  hub.status = async (id: string) => statusOf(id, { protocol: LOCKED_BRAIN_PROTOCOL - 1 });
  const refused = [];
  for await (const e of brain.run(turn, {
    signal: new AbortController().signal,
    executeTool: async () => ({ content: "" }),
  }))
    refused.push(e);
  expect(refused).toEqual([expect.objectContaining({ type: "error", code: "runner_outdated" })]);
  expect(sent).toEqual([]);
});

const planOpenedJobs = (fx: Fixture) =>
  fx.db.select().from(schema.outbox).where(eq(schema.outbox.kind, PLAN_OPENED_JOB));

test("Atende outras pessoas: the plan's owner chooses, an admin may override, and the plan's owner gets the email", async () => {
  const { fx, deps, caio, lodi } = await world();
  const id = (await lodi()).id;
  await setAgentBrain(deps, fx.owner.id, fx.org.id, id, { brain: "claude_code", account: ANAS });
  // Ana opens her own plan: nobody to tell.
  await setAgentBrain(deps, fx.owner.id, fx.org.id, id, { onlyOwner: false });
  expect(await planOpenedJobs(fx)).toHaveLength(0);
  await setAgentBrain(deps, fx.owner.id, fx.org.id, id, { onlyOwner: true });
  // Caio, an admin, overrides: it answers others, and Ana hears it.
  const view = await setAgentBrain(deps, caio.id, fx.org.id, id, { onlyOwner: false });
  expect(view.onlyOwner).toBe(false);
  expect((await lodi()).planForOthers).toBe(true);
  const [job] = await planOpenedJobs(fx);
  expect(job?.payload).toMatchObject({ agentId: id, actorId: caio.id, from: { mode: "owner" } });
  await queuePlanOpenedEmail(fx.db, "https://app.test", fx.org.id, String(job?.id), job?.payload ?? {});
  const [mail] = await fx.db.select().from(schema.outbox).where(eq(schema.outbox.kind, "email.send"));
  expect(JSON.stringify(mail?.payload)).toContain(fx.owner.email);
  expect(JSON.stringify(mail?.payload)).not.toContain(caio.email);
});

test("every plan qualifies: OpenCode's, Codex's and Cursor's like Claude's, each signed in as an account", async () => {
  const { fx, deps, machineId, lodi, account } = await world();
  const id = (await lodi()).id;
  const plans = {
    opencode: "0193dddd-0000-4000-8000-0000000000a3",
    codex: "0193dddd-0000-4000-8000-0000000000a2",
    cursor: "0193dddd-0000-4000-8000-0000000000a4",
  } as const;
  for (const [kind, accountId] of Object.entries(plans)) await account(accountId, fx.owner.id, kind);
  // Hers, of every kind (an owner sees Caio's there too: owners may use other people's plans).
  const kinds = (await getAgentBrain(deps, fx.owner.id, fx.org.id, id)).accounts
    .filter((a) => a.mine)
    .map((a) => a.kind)
    .sort();
  expect(kinds).toEqual(["claude_code", "codex", "cursor", "opencode"]);
  await fx.db
    .update(schema.machines)
    .set({
      protocol: MACHINE_PROTOCOL_VERSION,
      executors: {
        codex: { version: "codex-cli 0.165.0" },
        cursor: { version: "2026.10.28-1a2b3c4" },
        opencode: { version: "1.19.5" },
        detectedAt: new Date().toISOString(),
      },
    })
    .where(eq(schema.machines.id, machineId));
  // Never a computer's own sign-in.
  expect(await codeOf(setAgentBrain(deps, fx.owner.id, fx.org.id, id, { brain: "codex" }))).toBe(
    "brain.right_hand_account",
  );
  for (const [kind, accountId] of Object.entries(plans)) {
    const view = await setAgentBrain(deps, fx.owner.id, fx.org.id, id, { brain: kind, account: accountId });
    expect(view).toMatchObject({ brain: kind, account: accountId, computer: { machineId } });
    expect(await lodi()).toMatchObject({ brain: kind, brainAccountId: accountId, machineId: null });
  }
});

test("its DM's line: a runner to update and a CLI with tools of its own each say so, never that it has no AI", () => {
  expect(rightHandNoAiReason("runner_outdated")).toBe("runner_outdated");
  expect(rightHandNoAiReason("tools_not_locked")).toBe("plan_tools");
  expect(UNAVAILABLE_CODES.has("tools_not_locked")).toBe(true);
});

test("its DM's line names the real cause: a model's own limit or region, commands off, a CLI missing, another's plan", () => {
  expect(rightHandNoAiReason("plan_limit")).toBe("plan_limit");
  expect(rightHandNoAiReason("plan_limit", "model")).toBe("model_limit");
  expect(rightHandNoAiReason("plan_limit", "region")).toBe("model_region");
  expect(rightHandNoAiReason("plan_limit", "off")).toBe("model_off");
  expect(rightHandNoAiReason("plan_limit", "inactive")).toBe("plan_inactive");
  expect(rightHandNoAiReason("codex_too_old")).toBe("runner_outdated");
  expect(rightHandNoAiReason("exec_disabled")).toBe("commands_off");
  expect(rightHandNoAiReason("tool_off")).toBe("commands_off");
  expect(rightHandNoAiReason("plan_not_owner")).toBe("plan_not_shared");
  expect(rightHandNoAiReason("plan_unattended")).toBe("plan_unattended");
  for (const code of ["cli_missing", "codex_missing", "opencode_missing", "antigravity_missing"])
    expect(rightHandNoAiReason(code)).toBe("cli_missing");
  // A failure that may pass is a problem on the computer: never "no AI connected", nor that it's away.
  expect(rightHandNoAiReason("runner_error")).toBe("computer_failed");
  // The plan's CLI failing (a provider error through it, its own crash) is the plan's AI's, not its computer's.
  for (const code of ["claude_failed", "codex_failed", "cursor_failed", "grok_failed"])
    expect(rightHandNoAiReason(code)).toBe("cli_failed");
});

test("an OpenCode turn of it goes out as the chat profile with no checkout; an older runner gets nothing", async () => {
  const sent: Record<string, unknown>[] = [];
  let protocol = MACHINE_PROTOCOL_VERSION;
  let prepared = 0;
  const brain = new OpencodeBrain({
    link: {
      status: async (id: string) => ({
        ...statusOf(id, { protocol }),
        executors: { opencode: { version: "1.19.5" }, detectedAt: new Date().toISOString() },
      }),
      turn: async (_m: string, request: Record<string, unknown>, o: { onEvent: (e: unknown) => void }) => {
        sent.push(request);
        o.onEvent({ type: "done", text: "ok" });
        return { type: "done", text: "ok" };
      },
    } as never,
    mcp: async () => ({ token: "t" }),
    permissions: async () => RIGHT_HAND_TURN,
    prepare: async () => {
      prepared++;
      return { cwd: "repos/acme/app", prompt: "# Your code", start: "" } as never;
    },
  } as never);
  const turn = {
    runId: "0193bbbb-0000-7000-8000-000000000002",
    orgId: "o",
    agentId: "a",
    channelId: "c",
    threadRootId: null,
    system: "You are Lodi.",
    messages: [{ role: "user", content: "oi" }],
    tools: [],
    trigger: "oi",
    session: { id: "0193aaaa-0000-7000-8000-000000000002", resume: false, machineId: "m", cwd: "" },
  } as unknown as BrainTurn;
  const run = async () => {
    const out = [];
    for await (const e of brain.run(turn, {
      signal: new AbortController().signal,
      executeTool: async () => ({ content: "" }),
    }))
      out.push(e);
    return out;
  };
  expect((await run()).at(-1)).toMatchObject({ type: "done" });
  expect(prepared).toBe(0);
  expect(sent[0]).toMatchObject({ kind: "opencode", permissions: { mode: "chat" }, cwd: "" });
  sent.length = 0;
  protocol = LOCKED_BRAIN_PROTOCOL - 1;
  expect(await run()).toEqual([expect.objectContaining({ type: "error", code: "runner_outdated" })]);
  expect(sent).toEqual([]);
});

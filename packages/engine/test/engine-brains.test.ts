import { afterEach, expect, test } from "bun:test";
import { ACCOUNTS_PROTOCOL, channelTopic, MACHINE_PROTOCOL_VERSION, orgTopic } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import { systemText } from "@agenteschat/providers";
import {
  activeRunsIn,
  addChannelMember,
  addRunStep,
  type Brain,
  type BrainEvent,
  type BrainTurn,
  brainEffortFor,
  brainFor,
  brainModelFor,
  brainSessionId,
  type ChannelEvent,
  COMPUTER_BUSY_RETRY_MS,
  COMPUTER_QUEUE_NOTE_MS,
  COMPUTER_REACT_NOTE,
  COMPUTER_TOOLS_NOTE,
  cancelRun,
  clearPlanLimits,
  computerBrainUnavailable,
  computerMediaNote,
  computerQueue,
  consultationWait,
  createAgent,
  createAgentRuns,
  createChannel,
  createCredential,
  createJobHandlers,
  createMissionEngine,
  decideApproval,
  drainLocalRuns,
  drainOutbox,
  enableOperatorEvents,
  enqueue,
  executeToolForRun,
  getMessage,
  grantScopes,
  insertMessage,
  invokeToolForRun,
  listApprovals,
  listChannels,
  listMachineOutages,
  listMessages,
  listThreads,
  listWorkingRuns,
  loadAgentStatuses,
  MAX_COMPUTER_DROPS,
  type MachineStatus,
  notePlanLimit,
  OUTAGE_PARK,
  openDm,
  postPersonMessage,
  queueOnRun,
  receiptsFor,
  recoverStaleRuns,
  resetAccountFailures,
  resolveBrain,
  resumeRunsWaitingForMachine,
  roomHead,
  runWhere,
  SESSION_IDLE_MS,
  SESSION_MAX_INPUT_TOKENS,
  sessionLostNote,
  statusReply,
  type ToolSource,
  taskManager,
} from "../src";
import { computerPrompt } from "../src/brains/prompt";
import { afterSteered } from "../src/steering";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";
import { ALL_GITHUB_SCOPES, fakeGithub } from "./tool-fixtures";

/**
 * ADR 0032 integration: the engine with a computer brain (Claude Code, here a
 * scripted fake) on the agent's computer — the turn ends after tools the brain
 * ran through the bridge, a bridged pause leaves the run waiting and resumes
 * the session with the decision, a plan limit falls back to the model brain,
 * and with nothing to fall back on the run waits for the computer.
 */

let f: Fixture;
afterEach(() => {
  clearPlanLimits();
  return f?.close();
});

const RUNNER = {
  hostname: "mac",
  os: "darwin" as const,
  arch: "arm64",
  version: "0.8.0",
  protocol: MACHINE_PROTOCOL_VERSION,
  workspace: "/Users/w/agentes",
};

const statusOf = (machineId: string, over: Partial<MachineStatus> = {}): MachineStatus => ({
  id: machineId,
  orgId: "org",
  name: "MacBook",
  online: true,
  execAllowed: true,
  os: "darwin",
  protocol: 8,
  executors: { claude: { version: "2.1.300", loggedIn: true }, detectedAt: new Date().toISOString() },
  ...over,
});

/** Pairs a computer and makes it the agent's, thinking with Claude Code. */
async function computerAgent(fx: Fixture, over: Partial<typeof schema.agents.$inferInsert> = {}) {
  const deps = { db: fx.db, pubsub: fx.pubsub, publicUrl: "https://agentes.chat" };
  const paired = await pairMachine(deps, fx.owner.id, fx.org.id, { name: "MacBook", ...RUNNER, exec: true });
  await fx.db
    .update(schema.agents)
    .set({ machineId: paired.machineId, brain: "claude_code", ...over })
    .where(eq(schema.agents.id, fx.agent.id));
  return paired.machineId;
}

/** A Claude Code stand-in that replays a script per turn and keeps what each turn received. */
function scriptedComputerBrain(script: (n: number, turn: BrainTurn) => AsyncIterable<BrainEvent> | BrainEvent[]) {
  const seen: BrainTurn[] = [];
  const brain: Brain = {
    kind: "claude_code",
    async *run(turn) {
      const n = seen.length;
      seen.push({ ...turn, system: "", messages: [] });
      yield* script(n, turn) as AsyncIterable<BrainEvent>;
    },
  };
  return { brain, seen };
}

const post = (fx: Fixture, body: string) =>
  postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, { body });

/** The channel's main timeline: a run asked there answers there. */
const timeline = (fx: Fixture) => listMessages(fx.db, fx.owner.id, fx.org.id, fx.general.id);

/** The run knows its brain (`resolveBrain` looked at its computer once): a look now is it waiting there. */
const waitingLook = async (fx: Fixture) =>
  Boolean((await fx.db.select({ brain: schema.agentRuns.brain }).from(schema.agentRuns))[0]?.brain);

/** Another run of the agent in the channel's main timeline (one a new message there would have joined). */
async function secondRun(fx: Fixture, triggerMessageId: string, hop = 1) {
  const [run] = await fx.db
    .insert(schema.agentRuns)
    .values({
      orgId: fx.org.id,
      agentId: fx.agent.id,
      channelId: fx.general.id,
      threadRootId: triggerMessageId,
      triggerMessageId,
      trigger: "router",
      hop,
    })
    .returning();
  if (!run) throw new Error("no run");
  await enqueue(fx.db, {
    orgId: fx.org.id,
    kind: "agent_run.execute",
    payload: { runId: run.id },
    dedupeKey: `agent_run.execute:${run.id}`,
  });
  return run;
}

/** Its computer went a few seconds ago (a runner dialing again), the row as the hub leaves it. */
async function justGone(fx: Fixture, machineId: string) {
  const lastSeenAt = new Date(Date.now() - 5_000);
  await fx.db.update(schema.machines).set({ online: false, lastSeenAt }).where(eq(schema.machines.id, machineId));
  return lastSeenAt.toISOString();
}

test("brainFor: the mission's brain first, then the agent's; unknown values are the model brain", () => {
  const run = { id: "r" };
  expect(brainFor({ brain: "codex" }, run, { brain: "claude_code" })).toBe("claude_code");
  expect(brainFor({ brain: "codex" }, run, null)).toBe("codex");
  expect(brainFor({ brain: "claude_code" }, run)).toBe("claude_code");
  expect(brainFor({ brain: "something" }, run)).toBe("model");
});

test("availability: no computer, offline, old runner, not logged in, Codex missing, plan limit", () => {
  expect(computerBrainUnavailable("model", null, null)).toBeNull();
  expect(computerBrainUnavailable("claude_code", null, null)?.code).toBe("no_computer");
  expect(computerBrainUnavailable("claude_code", "m1", statusOf("m1", { online: false }))?.code).toBe(
    "machine_offline",
  );
  expect(computerBrainUnavailable("claude_code", "m1", statusOf("m1", { protocol: 7 }))?.code).toBe("runner_outdated");
  expect(
    computerBrainUnavailable(
      "claude_code",
      "m1",
      statusOf("m1", { executors: { claude: { version: "2.1.300", loggedIn: false } } }),
    )?.code,
  ).toBe("not_logged_in");
  expect(computerBrainUnavailable("codex", "m1", statusOf("m1"))?.code).toBe("codex_missing");
  expect(computerBrainUnavailable("claude_code", "m1", statusOf("m1"))).toBeNull();
  // The desktop app (protocol 10) reports its tools: Claude Code needs its own switch, not commands.
  const access = (tools: { claude: boolean; codex: boolean; commands: boolean }) => ({ folders: [], tools });
  expect(
    computerBrainUnavailable(
      "claude_code",
      "m1",
      statusOf("m1", { execAllowed: false, access: access({ claude: true, codex: false, commands: false }) }),
    ),
  ).toBeNull();
  expect(
    computerBrainUnavailable(
      "claude_code",
      "m1",
      statusOf("m1", { execAllowed: true, access: access({ claude: false, codex: false, commands: true }) }),
    )?.code,
  ).toBe("tool_off");
  expect(computerBrainUnavailable("claude_code", "m1", statusOf("m1", { execAllowed: false }))?.code).toBe(
    "exec_disabled",
  );
  notePlanLimit("m1", "claude_code", new Date(Date.now() + 3600_000).toISOString());
  expect(computerBrainUnavailable("claude_code", "m1", statusOf("m1"))?.code).toBe("plan_limit");
  expect(
    computerBrainUnavailable("codex", "m1", statusOf("m1", { executors: { codex: { version: "0.163.0" } } })),
  ).toBeNull();
});

test("a computer brain's model: the mission's, else the agent's only for the same brain, else the brain's default", () => {
  const agent = { brain: "claude_code", brainModel: "opus" };
  expect(brainModelFor("claude_code", agent)).toBe("opus");
  // The agent's Claude Code model means nothing to Codex (a mission on Codex): Codex's own default.
  expect(brainModelFor("codex", agent)).toBeUndefined();
  expect(brainModelFor("codex", agent, { model: "gpt-6.1-codex" })).toBe("gpt-6.1-codex");
  expect(brainModelFor("claude_code", { brain: "codex", brainModel: "gpt-6.1-codex" })).toBe("sonnet");
  expect(brainModelFor("claude_code", { brain: "claude_code", brainModel: null }, { model: "haiku" })).toBe("haiku");
  expect(brainModelFor("model", agent)).toBeUndefined();
});

test("a computer-brain turn ends after the tools it ran through the bridge (never sent again); plan usage at no cost", async () => {
  f = await setup();
  const machineId = await computerAgent(f);
  let system = "";
  const { brain, seen } = scriptedComputerBrain((n, turn) => {
    system ||= turn.system;
    return n === 0
      ? [
          { type: "text_delta", text: "Rodei os testes." },
          { type: "tool_call", id: "t1", name: "Bash", input: { command: "bun test" }, executed: { content: "ok" } },
          { type: "usage", input: 40, output: 9, source: "plan", model: "claude-sonnet-5-5" },
          { type: "done", text: "Rodei os testes: tudo verde." },
        ]
      : [{ type: "done", text: "SENT TWICE" }];
  });
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(f, "@dev roda os testes");
  await drainOutbox(f.db, handlers);

  expect(seen.length).toBe(1);
  expect(seen[0]?.trigger).toBe("@dev roda os testes");
  // A computer brain is told it may read and investigate with its own tools (ADR 0037).
  expect(system).toContain(COMPUTER_TOOLS_NOTE);
  expect(system).not.toContain("Beyond this, you can't.");
  expect(seen[0]?.model).toBe("sonnet");
  const [run] = await f.db.select().from(schema.agentRuns);
  // A new session for this run, kept on it (a pause resumes the same one). Asked in the channel, its
  // conversation is the channel's main timeline.
  expect(seen[0]?.session).toEqual({
    id: brainSessionId(f.agent.id, `${f.general.id}:${run?.id}`, "claude_code"),
    resume: false,
    machineId,
    cwd: "",
  });
  expect(run?.brainSessionId).toBe(seen[0]?.session?.id ?? "");
  expect(run?.status).toBe("done");
  const main = await timeline(f);
  expect(main.map((m) => m.body)).toEqual(["@dev roda os testes", "Rodei os testes: tudo verde."]);
  // The transcript stays valid for the model brain: no tool_use without its result.
  expect(JSON.stringify(run?.transcript)).not.toContain('"type":"tool_use"');
  const usage = await f.db
    .select()
    .from(schema.usageRecords)
    .where(eq(schema.usageRecords.runId, run?.id ?? ""));
  // On the computer's own sign-in: its computer, no account (the usage views, ADR 0063).
  expect(usage).toMatchObject([
    {
      provider: "claude_code",
      billedTo: "plan",
      costNanoUsd: 0,
      inputTokens: 40,
      outputTokens: 9,
      machineId,
      brainAccountId: null,
    },
  ]);
  // The turn's bridge token died with the run.
  const tokens = await f.db
    .select()
    .from(schema.runToolTokens)
    .where(eq(schema.runToolTokens.runId, run?.id ?? ""));
  expect(tokens.length).toBe(1);
  expect(tokens[0]?.revokedAt).not.toBeNull();
});

test("a computer brain that keeps doing real work between promises gets both continues, never the ask nudge", async () => {
  f = await setup({
    judge: (kind, _id, state) =>
      kind === "follow_through" ? (String(state.reply).includes("vou ") ? "continue" : "done") : undefined,
  });
  await computerAgent(f);
  const ran = (id: string): BrainEvent => ({
    type: "tool_call",
    id,
    name: "Bash",
    input: { command: "bun run lint" },
    executed: { content: "ok" },
  });
  const turns: BrainEvent[][] = [
    [ran("t1"), { type: "done", text: "Rodei os testes; vou corrigir o lint." }],
    [ran("t2"), { type: "done", text: "Corrigi o lint; vou rodar os testes de novo." }],
    [ran("t3"), { type: "done", text: "Tudo verde." }],
  ];
  const { brain, seen } = scriptedComputerBrain((n) => turns[n] ?? [{ type: "done", text: "EXTRA" }]);
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(f, "@dev arruma o lint e os testes");
  await drainOutbox(f.db, handlers);

  expect(seen.length).toBe(3);
  const nudged = (await f.db.select().from(schema.agentRunSteps)).flatMap((s) =>
    typeof s.data.nudged === "string" ? [s.data.nudged] : [],
  );
  expect(nudged).toEqual(["promise", "promise"]);
  expect((await timeline(f)).at(-1)?.body).toBe("Tudo verde.");
});

test("computer sessions: the conversation's session goes on while recent and small; a big, idle or routine one starts fresh", async () => {
  f = await setup();
  const machineId = await computerAgent(f);
  let input = 40;
  let cacheRead = 0;
  const { brain, seen } = scriptedComputerBrain(() => [
    {
      type: "usage",
      input,
      output: 5,
      source: "plan",
      model: "claude-sonnet-5-5",
      ...(cacheRead ? { cacheRead } : {}),
    },
    { type: "done", text: "ok" },
  ]);
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  const question = await post(f, "@dev oi");
  await drainOutbox(f.db, handlers);
  const reply = (body: string) =>
    postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body,
      threadId: question.id,
    });

  // Small and recent: the next turn in the thread resumes it.
  await reply("@dev e agora?");
  await drainOutbox(f.db, handlers);
  expect(seen[1]?.session).toMatchObject({ id: seen[0]?.session?.id, resume: true });

  // That turn read too much: a fresh session.
  input = SESSION_MAX_INPUT_TOKENS;
  await reply("@dev mais uma");
  await drainOutbox(f.db, handlers);
  input = 40;
  await reply("@dev e essa?");
  await drainOutbox(f.db, handlers);
  expect(seen[3]?.session?.resume).toBe(false);
  expect(seen[3]?.session?.id).not.toBe(seen[2]?.session?.id);

  // A turn that read past the limit mostly from the cache is just as big: a fresh session.
  input = SESSION_MAX_INPUT_TOKENS;
  cacheRead = SESSION_MAX_INPUT_TOKENS - 40;
  await reply("@dev do cache");
  await drainOutbox(f.db, handlers);
  expect(seen[4]?.session).toMatchObject({ id: seen[3]?.session?.id, resume: true });
  input = 40;
  cacheRead = 0;
  await reply("@dev e depois?");
  await drainOutbox(f.db, handlers);
  expect(seen[5]?.session?.resume).toBe(false);
  expect(seen[5]?.session?.id).not.toBe(seen[4]?.session?.id);

  // Idle past the cache: a fresh one too.
  const stale = new Date(Date.now() - SESSION_IDLE_MS - 1000);
  await f.db.update(schema.agentRuns).set({ finishedAt: stale, updatedAt: stale });
  await reply("@dev voltei");
  await drainOutbox(f.db, handlers);
  expect(seen[6]?.session?.resume).toBe(false);
  expect(seen[6]?.session?.id).not.toBe(seen[5]?.session?.id);

  // A routine run never picks up the conversation's session.
  const [agent] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, f.agent.id));
  const runs = await f.db.select().from(schema.agentRuns);
  const last = runs.find((r) => r.brainSessionId === seen[6]?.session?.id);
  if (!agent || !last) throw new Error("missing rows");
  const routineRun = { ...last, id: Bun.randomUUIDv7(), brainSessionId: null };
  await f.db.insert(schema.agentRuns).values({ ...routineRun, triggerMessageId: Bun.randomUUIDv7() });
  const plan = await resolveBrain({ db: f.db }, agent, routineRun, question.id, { fresh: true });
  expect(plan.session).toMatchObject({ resume: false, machineId });
  expect(plan.session?.id).not.toBe(seen[6]?.session?.id);
});

test("edited instructions or org context reach a kept-alive session's next turn: a fresh session with the conversation", async () => {
  f = await setup();
  await computerAgent(f, { instructions: "Never query the database." });
  const systems: string[] = [];
  const prompts: string[] = [];
  const { brain, seen } = scriptedComputerBrain((_n, turn) => {
    systems.push(turn.system);
    prompts.push(computerPrompt(turn));
    return [
      { type: "usage", input: 40, output: 5, source: "plan", model: "claude-sonnet-5-5" },
      { type: "done", text: "ok" },
    ];
  });
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  const question = await post(f, "@dev quantos pedidos hoje?");
  await drainOutbox(f.db, handlers);
  const reply = async (body: string) => {
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body,
      threadId: question.id,
    });
    await drainOutbox(f.db, handlers);
  };

  // Nothing changed: the same session goes on.
  await reply("@dev e ontem?");
  expect(seen[1]?.session).toMatchObject({ id: seen[0]?.session?.id, resume: true });

  await f.db
    .update(schema.agents)
    .set({ instructions: "You may query the orders database." })
    .where(eq(schema.agents.id, f.agent.id));
  await reply("@dev agora pode consultar?");
  expect(seen[2]?.session?.resume).toBe(false);
  expect(seen[2]?.session?.id).not.toBe(seen[1]?.session?.id);
  expect(systems[2]).toContain("You may query the orders database.");
  expect(systems[2]).not.toContain("Never query the database.");
  // The new session reads the conversation so far.
  expect(prompts[2]).toContain("The conversation so far");
  expect(prompts[2]).toContain("quantos pedidos hoje?");

  // And it goes on itself while nothing changes again.
  await reply("@dev e amanhã?");
  expect(seen[3]?.session).toMatchObject({ id: seen[2]?.session?.id, resume: true });

  // The org's context is part of it too.
  await f.db
    .update(schema.organizations)
    .set({ context: "We sell bikes." })
    .where(eq(schema.organizations.id, f.org.id));
  await reply("@dev e a loja?");
  expect(seen[4]?.session?.resume).toBe(false);
  expect(systems[4]).toContain("We sell bikes.");
});

test("people taking turns keep one session; a repository added to the agent's access starts a new one", async () => {
  const gh = fakeGithub();
  f = await setup({ toolSources: [gh.source], askAgent: true });
  await grantScopes(f.db, f.org.id, f.agent.id, ALL_GITHUB_SCOPES);
  await computerAgent(f);
  await f.db
    .insert(schema.agentRepositories)
    .values({ orgId: f.org.id, agentId: f.agent.id, repo: "acme/api", position: 0 });
  // A teammate only its owner talks to: "# Your team" differs between the owner and another member.
  const ops = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Ops", handle: "ops", role: "Infra", instructions: "", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  await f.db
    .update(schema.agents)
    .set({ audienceMode: "owner", consultable: false })
    .where(eq(schema.agents.id, ops.id));
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
  const systems: string[] = [];
  const { brain, seen } = scriptedComputerBrain((_n, turn) => {
    systems.push(turn.system);
    return [
      { type: "usage", input: 40, output: 5, source: "plan", model: "claude-sonnet-5-5" },
      { type: "done", text: "ok" },
    ];
  });
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  const question = await post(f, "@dev o deploy da api quebrou?");
  await drainOutbox(f.db, handlers);
  const reply = async (userId: string, body: string) => {
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, userId, f.org.id, f.general.id, {
      body,
      threadId: question.id,
    });
    await drainOutbox(f.db, handlers);
  };

  await reply(bia.id, "@dev e o do web?");
  await reply(f.owner.id, "@dev e agora?");
  expect(seen).toHaveLength(3);
  expect(seen[1]?.session).toMatchObject({ id: seen[0]?.session?.id, resume: true });
  expect(seen[2]?.session).toMatchObject({ id: seen[0]?.session?.id, resume: true });

  await f.db
    .insert(schema.agentRepositories)
    .values({ orgId: f.org.id, agentId: f.agent.id, repo: "acme/web", position: 1 });
  await reply(f.owner.id, "@dev pode olhar o acme/web?");
  expect(seen[3]?.session?.resume).toBe(false);
  expect(seen[3]?.session?.id).not.toBe(seen[2]?.session?.id);
  expect(systems[3]).toContain("acme/web");
});

test("a mission's main session goes on after an edit to the instructions, and its next turn reads them", async () => {
  f = await setup();
  const machineId = await computerAgent(f, { instructions: "Never query the database." });
  const { brain, seen: turns } = scriptedComputerBrain(() => [
    { type: "usage", input: 40, output: 5, source: "plan", model: "claude-sonnet-5-5" },
    { type: "done", text: "ok" },
  ]);
  const seen = turns as (BrainTurn & { thisTurn?: string })[];
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  const home = await post(f, "@dev missão: relatório de pedidos");
  await drainOutbox(f.db, handlers);
  const mainSessionId = crypto.randomUUID();
  const [mission] = await f.db
    .insert(schema.missions)
    .values({
      orgId: f.org.id,
      threadRootId: home.id,
      channelId: f.general.id,
      agentId: f.agent.id,
      ownerId: f.owner.id,
      machineId,
      title: "Relatório",
      goal: "Relatório de pedidos",
      status: "active",
      mainSessionId,
    })
    .returning();
  // The mission engine started its main session (planning), so later turns resume it.
  await f.db.insert(schema.missionEvents).values({
    orgId: f.org.id,
    missionId: mission?.id as string,
    kind: "engine_session",
    data: { sessionId: mainSessionId, runId: crypto.randomUUID() },
  });
  const reply = async (body: string) => {
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body,
      threadId: home.id,
    });
    await drainOutbox(f.db, handlers);
  };
  await reply("@dev comece");
  await reply("@dev e então?");
  expect(seen[2]?.session).toMatchObject({ id: mainSessionId, resume: true });
  expect(seen[2]?.thisTurn ?? "").not.toContain("# Your settings changed");

  await f.db
    .update(schema.agents)
    .set({ instructions: "You may query the orders database." })
    .where(eq(schema.agents.id, f.agent.id));
  await reply("@dev agora pode consultar?");
  expect(seen[3]?.session?.id).toBe(mainSessionId);
  expect(seen[3]?.thisTurn).toContain("# Your settings changed");
  expect(seen[3]?.thisTurn).toContain("You may query the orders database.");

  await reply("@dev e o total?");
  expect(seen[4]?.thisTurn ?? "").not.toContain("# Your settings changed");
});

test("a gated call through the bridge leaves the run waiting; the decision resumes the session with the result", async () => {
  const gh = fakeGithub();
  f = await setup({ toolSources: [gh.source] });
  await grantScopes(f.db, f.org.id, f.agent.id, ALL_GITHUB_SCOPES);
  const machineId = await computerAgent(f);
  const { brain, seen } = scriptedComputerBrain(async function* (n, turn) {
    if (n === 0) {
      // What the runner bridge does for the brain's MCP call (the run's identity, this machine).
      const result = await executeToolForRun(
        f.jobDeps,
        { orgId: turn.orgId, agentId: turn.agentId, runId: turn.runId, machineId },
        {
          id: "call-1",
          name: "github_merge_pr",
          input: { repo: "acme/app", pr: 42, why: "CI passed on the PR and it was reviewed: merging ships the fix." },
        },
      );
      yield { type: "tool_call", id: "call-1", name: "github_merge_pr", input: {}, executed: result };
      yield { type: "usage", input: 10, output: 2, source: "plan" };
      yield { type: "done", text: "Pedi aprovação para o merge." };
      return;
    }
    yield { type: "done", text: "Merge feito." };
  });
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(f, "@dev faz o merge do PR 42");
  await drainOutbox(f.db, handlers);

  let [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("waiting_approval");
  expect(gh.executed).toEqual([]);
  expect(seen.length).toBe(1);
  const main = await timeline(f);
  // The card says it all: a line that only announces it stays out of the conversation.
  expect(main.map((m) => m.body)).not.toContain("Pedi aprovação para o merge.");
  expect(main.some((m) => typeof m.meta.approvalId === "string")).toBe(true);
  const transcript = run?.transcript as { pending?: { calls: { toolUseId: string; bridged?: boolean }[] } };
  expect(transcript.pending?.calls).toMatchObject([{ toolUseId: "call-1", bridged: true }]);

  const [approval] = await listApprovals(f.db, f.owner.id, f.org.id, { status: "pending" });
  await decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, approval?.id ?? "", {
    decision: "approve",
  });
  await drainOutbox(f.db, handlers);

  [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("done");
  expect(gh.executed).toEqual([{ tool: "github_merge_pr", input: { repo: "acme/app", pr: 42 } }]);
  // The same session goes on, reading what the person decided (not the original message again).
  expect(seen.length).toBe(2);
  expect(seen[1]?.session?.resume).toBe(true);
  expect(seen[1]?.session?.id).toBe(seen[0]?.session?.id);
  expect(seen[1]?.trigger).toContain("github_merge_pr");
  expect(seen[1]?.trigger).toContain("github_merge_pr ok: acme/app#42");
});

/**
 * A connector call that asks a person every time, answering like a remote workbench that gave only a preview.
 * `external`: an MCP server's answer, which reaches the model inside `<external_data>`.
 */
function workbench(options: { content?: string; external?: boolean } = {}) {
  const ran: Record<string, unknown>[] = [];
  const source: ToolSource = {
    name: "fake-workbench",
    tools: async () => [
      {
        name: "ci_workbench",
        description: "Runs code against the CI provider (fake)",
        scope: "ci:run",
        sensitive: true,
        ...(options.external ? { external: true } : {}),
        inputSchema: {
          type: "object",
          properties: { run: { type: "integer" } },
          required: ["run"],
          additionalProperties: false,
        },
        async execute(input) {
          ran.push(input);
          return { content: options.content ?? "Response schema: {jobs: [...]} Data Preview: (2 rows hidden)" };
        },
      },
    ],
  };
  return { source, ran };
}

const WORKBENCH_WHY = "The CI run is slow and its per-job times answer the question: this call reads them.";

test("approved, it ran, and the brain ended its turn without a word: one more turn with the result, then the answer", async () => {
  // A remote workbench's long preview, an MCP server's words: the run reads them as data, never as instructions.
  const preview = `Response schema: {jobs: [...]} Data Preview: ${"x".repeat(2500)} (2 rows hidden)`;
  const bench = workbench({ content: preview, external: true });
  f = await setup({ toolSources: [bench.source] });
  await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: "ci:run" }]);
  const machineId = await computerAgent(f);
  const promised =
    "The card above fetches how long each job took and what's left. When you approve, I'll give you the numbers.";
  const { brain, seen } = scriptedComputerBrain(async function* (n, turn) {
    if (n === 0) {
      yield { type: "text_delta", text: promised };
      const result = await executeToolForRun(
        f.jobDeps,
        { orgId: turn.orgId, agentId: turn.agentId, runId: turn.runId, machineId },
        { id: "wb-1", name: "ci_workbench", input: { run: 42, why: WORKBENCH_WHY } },
      );
      yield { type: "tool_call", id: "wb-1", name: "ci_workbench", input: {}, executed: result };
      yield { type: "done", text: promised };
      return;
    }
    // What production saw: the result came back and the turn ended with nothing.
    if (n === 1) return yield { type: "done", text: "" };
    yield { type: "done", text: "The preview hid the rows, so I read them again: tests took 9 min, lint 2." };
  });
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(f, "@dev o ci demora tanto assim?");
  await drainOutbox(f.db, handlers);
  expect((await f.db.select().from(schema.agentRuns))[0]?.status).toBe("waiting_approval");

  const [approval] = await listApprovals(f.db, f.owner.id, f.org.id, { status: "pending" });
  await decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, approval?.id ?? "", {
    decision: "approve",
  });
  await drainOutbox(f.db, handlers);

  expect(bench.ran).toEqual([{ run: 42 }]);
  expect(seen.length).toBe(3);
  expect(seen[1]?.trigger).toContain("Response schema");
  // Told what was decided and what came back, and to finish what it said it would do: what it is told comes
  // first, and the result keeps its envelope (cut in the middle, its end and closing marker kept).
  const nudge = seen[2]?.trigger ?? "";
  expect(nudge).toContain("ended your turn without telling them anything");
  expect(nudge).toContain("Data Preview");
  expect(nudge).toContain("(2 rows hidden)\n</external_data>");
  expect(nudge).toContain("characters cut");
  expect(nudge.indexOf("Go on with the task")).toBeGreaterThan(-1);
  expect(nudge.indexOf("Go on with the task")).toBeLessThan(nudge.indexOf("<external_data"));
  const [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("done");
  const fromAgent = (await timeline(f)).filter((m) => m.author.type === "agent" && !m.meta.approvalId);
  expect(fromAgent.map((m) => m.body)).toEqual([
    "The preview hid the rows, so I read them again: tests took 9 min, lint 2.",
  ]);
  const steps = await f.db
    .select()
    .from(schema.agentRunSteps)
    .where(eq(schema.agentRunSteps.runId, run?.id ?? ""));
  expect(steps.filter((s) => s.data.nudged === "decision").length).toBe(1);
});

test("told once after a decision: a second silent turn ends the run, never a loop", async () => {
  const bench = workbench();
  f = await setup({ toolSources: [bench.source] });
  await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: "ci:run" }]);
  const machineId = await computerAgent(f);
  const { brain, seen } = scriptedComputerBrain(async function* (n, turn) {
    if (n === 0) {
      const result = await executeToolForRun(
        f.jobDeps,
        { orgId: turn.orgId, agentId: turn.agentId, runId: turn.runId, machineId },
        { id: "wb-1", name: "ci_workbench", input: { run: 7, why: WORKBENCH_WHY } },
      );
      yield { type: "tool_call", id: "wb-1", name: "ci_workbench", input: {}, executed: result };
      return yield { type: "done", text: "Asked for the CI numbers." };
    }
    yield { type: "done", text: "" };
  });
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(f, "@dev quanto tempo levou o CI?");
  await drainOutbox(f.db, handlers);
  const [approval] = await listApprovals(f.db, f.owner.id, f.org.id, { status: "pending" });
  await decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, approval?.id ?? "", {
    decision: "approve",
  });
  await drainOutbox(f.db, handlers);
  expect(seen.length).toBe(3);
  expect((await f.db.select().from(schema.agentRuns))[0]?.status).toBe("done");
});

test("decided while the turn that asked still runs: the run goes on once that turn ends, never two turns at once", async () => {
  const bench = workbench();
  f = await setup({ toolSources: [bench.source] });
  await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: "ci:run" }]);
  const machineId = await computerAgent(f);
  let turnsWhileFirstRan = -1;
  const { brain, seen } = scriptedComputerBrain(async function* (n, turn) {
    if (n > 0) return yield { type: "done", text: "Tests took 9 min, lint 2." };
    const result = await executeToolForRun(
      f.jobDeps,
      { orgId: turn.orgId, agentId: turn.agentId, runId: turn.runId, machineId },
      { id: "wb-1", name: "ci_workbench", input: { run: 42, why: WORKBENCH_WHY } },
    );
    // The person approves seven seconds later, before this turn has ended: the decision's job runs now.
    const [approval] = await listApprovals(f.db, f.owner.id, f.org.id, { status: "pending" });
    await decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, approval?.id ?? "", {
      decision: "approve",
    });
    await drainOutbox(f.db, handlers);
    turnsWhileFirstRan = seen.length;
    yield { type: "tool_call", id: "wb-1", name: "ci_workbench", input: {}, executed: result };
    yield { type: "done", text: "When you approve, I'll give you the numbers." };
  });
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(f, "@dev o ci demora tanto assim?");
  await drainOutbox(f.db, handlers);

  expect(turnsWhileFirstRan).toBe(1);
  expect(seen.length).toBe(2);
  expect(seen[1]?.session?.id).toBe(seen[0]?.session?.id);
  expect(seen[1]?.trigger).toContain("ci_workbench: Response schema");
  expect(bench.ran).toEqual([{ run: 42 }]);
  const [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("done");
  expect((await timeline(f)).at(-1)?.body).toBe("Tests took 9 min, lint 2.");
});

test("two decisions of one pause: the resume that finds the run running under the other's job leaves it alone", async () => {
  const bench = workbench();
  let nested: Promise<number> | null = null;
  f = await setup({
    toolSources: [bench.source],
    reply: (_request, call) => {
      if (call === 1)
        return {
          chunks: ["Reading both CI runs."],
          toolUses: [41, 42].map((n) => ({ name: "ci_workbench", input: { run: n, why: WORKBENCH_WHY } })),
        };
      if (call > 2) return { chunks: ["A second turn beside the first."] };
      // The second decision's job runs while this resumed turn still thinks.
      nested = (async () => {
        await f.db
          .update(schema.outbox)
          .set({ nextAttemptAt: new Date() })
          .where(eq(schema.outbox.kind, "agent_run.execute"));
        return drainOutbox(f.db, f.handlers);
      })();
      return { chunks: ["Tests took 9 min, lint 2."], hold: nested };
    },
  });
  await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: "ci:run" }]);
  await post(f, "@dev compara os dois últimos CIs");
  await drainOutbox(f.db, f.handlers);
  const pending = await listApprovals(f.db, f.owner.id, f.org.id, { status: "pending" });
  expect(pending.length).toBe(2);
  for (const a of pending)
    await decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, a.id, { decision: "approve" });
  // Two resume jobs: the second one is held back until the first one's turn is under way.
  const resumes = await f.db
    .select()
    .from(schema.outbox)
    .where(and(eq(schema.outbox.kind, "agent_run.execute"), eq(schema.outbox.status, "pending")));
  expect(resumes.length).toBe(2);
  await f.db
    .update(schema.outbox)
    .set({ nextAttemptAt: new Date(Date.now() + 3600_000) })
    .where(eq(schema.outbox.id, resumes[1]?.id ?? ""));
  await drainOutbox(f.db, f.handlers);
  await nested;

  expect(bench.ran).toEqual([{ run: 41 }, { run: 42 }]);
  expect(f.provider.calls.length).toBe(2);
  const [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("done");
  const fromAgent = (await timeline(f)).filter((m) => m.author.type === "agent" && !m.meta.approvalId);
  expect(fromAgent.map((m) => m.body)).toEqual(["Tests took 9 min, lint 2."]);
});

test("a question asked through the bridge: the text written before it comes first, what follows isn't posted", async () => {
  f = await setup({ askUser: true });
  const machineId = await computerAgent(f);
  const { brain } = scriptedComputerBrain(async function* (n, turn) {
    if (n > 0) return;
    yield { type: "text_delta", text: "Estou criando a viagem no meu navegador; o formulário pede as datas." };
    const result = await executeToolForRun(
      f.jobDeps,
      { orgId: turn.orgId, agentId: turn.agentId, runId: turn.runId, machineId },
      {
        id: "ask-1",
        name: "ask_user",
        input: {
          why: "I need a person's answer before I go on: this decides what I change next.",
          question: "Quais datas eu coloco?",
        },
      },
    );
    yield { type: "tool_call", id: "ask-1", name: "ask_user", input: {}, executed: result };
    // After the call the brain repeats itself (what the person saw in production).
    await Bun.sleep(400);
    yield { type: "text_delta", text: "\n\nQuais datas eu coloco: você me passa a ida e a volta?" };
    yield {
      type: "done",
      text: "Estou criando a viagem no meu navegador; o formulário pede as datas.\n\nQuais datas eu coloco: você me passa a ida e a volta?",
    };
  });
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(f, "@dev cria a viagem para o Chile");
  await drainOutbox(f.db, handlers);

  const [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("waiting_input");
  const main = await timeline(f);
  const fromAgent = main.filter((m) => m.author.type === "agent");
  // The context first, then the card; the repeated question after the call is never posted.
  expect(fromAgent.map((m) => (m.meta.question ? "card" : m.body))).toEqual([
    "Estou criando a viagem no meu navegador; o formulário pede as datas.",
    "card",
  ]);
  expect(main.some((m) => m.body.includes("você me passa a ida e a volta"))).toBe(false);
});

test("a question for one person, through the bridge: it is theirs alone", async () => {
  f = await setup({ askUser: true });
  const machineId = await computerAgent(f);
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
  const { brain } = scriptedComputerBrain(async function* (n, turn) {
    if (n > 0) return;
    const why = "I need a person's answer before I go on: this decides what I change next.";
    const input = { why, question: "Qual foi o combinado?", person: "bia" };
    const call = { id: "ask-1", name: "ask_user", input };
    const result = await executeToolForRun(
      f.jobDeps,
      { orgId: turn.orgId, agentId: turn.agentId, runId: turn.runId, machineId },
      call,
    );
    yield { type: "tool_call", id: "ask-1", name: "ask_user", input: {}, executed: result };
    yield { type: "done", text: "" };
  });
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(f, "@dev o que foi o combinado com a bia?");
  await drainOutbox(f.db, handlers);
  expect((await f.db.select().from(schema.agentQuestions))[0]?.requestedForUserId).toBe(bia.id);
});

test("a question asked after the brain dropped a draft for a call: only the text written after that call leads the card", async () => {
  f = await setup({ askUser: true });
  const machineId = await computerAgent(f);
  const dropped =
    'You are right, I did not have the right context. When you said "send it to Acme", the video was europe_trip.mp4, and I sent';
  const answer =
    "You were right, I didn't have the right context: the video we were finishing was europe_trip.mp4, but I sent lisbon_v3.mp4, an older version. Pick in the card which one I should send.";
  const { brain } = scriptedComputerBrain(async function* (n, turn) {
    if (n > 0) return;
    // One model call of the turn stops mid-sentence to look something up (a call the brain runs on its own)...
    yield { type: "text_delta", text: dropped };
    yield {
      type: "tool_call",
      id: "look-1",
      name: "Bash",
      input: { command: "ls renders" },
      executed: { content: "europe_trip.mp4\nlisbon_v3.mp4" },
    };
    // ...and the next one writes the answer again from the start, then asks through the bridge.
    yield { type: "text_delta", text: answer };
    const result = await executeToolForRun(
      f.jobDeps,
      { orgId: turn.orgId, agentId: turn.agentId, runId: turn.runId, machineId },
      {
        id: "ask-1",
        name: "ask_user",
        input: {
          why: "I sent the wrong file before; the person picks the right one.",
          question: "Which video do I send to Acme?",
          choices: ["europe_trip.mp4", "lisbon_v3.mp4"],
        },
      },
    );
    yield { type: "tool_call", id: "ask-1", name: "ask_user", input: {}, executed: result };
    // Claude Code's result is its last model call's text.
    yield { type: "done", text: answer };
  });
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(f, "@dev you sent the wrong video");
  await drainOutbox(f.db, handlers);

  const [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("waiting_input");
  const main = await timeline(f);
  const fromAgent = main.filter((m) => m.author.type === "agent");
  // The answer, then the card: never the dropped draft glued in front of it.
  expect(fromAgent.map((m) => (m.meta.question ? "card" : m.body))).toEqual([answer, "card"]);
  expect(main.some((m) => m.body.includes("and I sent"))).toBe(false);
});

test("a computer brain that fails after calls posts what it said after its last call, not every stretch glued", async () => {
  f = await setup({ reply: () => ({ chunks: ["Respondi pela API."] }) });
  await computerAgent(f);
  const { brain } = scriptedComputerBrain(async function* () {
    // Dropped mid-sentence for a call, then written anew after it.
    yield { type: "text_delta", text: "Let me check whether Go is" };
    yield {
      type: "tool_call",
      id: "b-1",
      name: "Bash",
      input: { command: "go version" },
      executed: { content: "go: not found" },
    };
    yield { type: "text_delta", text: "Go isn't installed here, so I'm installing it now." };
    yield {
      type: "tool_call",
      id: "b-2",
      name: "Bash",
      input: { command: "brew install go" },
      executed: { content: "installing" },
    };
    yield { type: "error", code: "executor_crashed", message: "Claude Code exited", retryable: true };
  });
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(f, "@dev is Go installed there?");
  await drainOutbox(f.db, handlers);

  const last = (await timeline(f)).at(-1);
  expect(last?.meta.brainInterrupted).toMatchObject({ text: "Go isn't installed here, so I'm installing it now." });
  expect(last?.body).toContain("Go isn't installed here, so I'm installing it now.");
  expect(last?.body).not.toContain("Let me check whether Go is");
});

test("sent on after its turn, a computer brain that opens again with the same line and asks posts that line once", async () => {
  const opening = 'Vou procurar a integração do serviço de cobrança e consultar os gastos de "acme".';
  f = await setup({ askUser: true, judge: (kind) => (kind === "follow_through" ? "continue" : undefined) });
  const machineId = await computerAgent(f);
  const { brain } = scriptedComputerBrain(async function* (n, turn) {
    // Turn 1 ends on its opening line (Codex's last message of the turn); the judge sends it on.
    yield { type: "text_delta", text: opening };
    if (n === 0) {
      yield { type: "done", text: opening };
      return;
    }
    // Turn 2 opens with the same line, then asks.
    const result = await executeToolForRun(
      f.jobDeps,
      { orgId: turn.orgId, agentId: turn.agentId, runId: turn.runId, machineId },
      {
        id: "ask-2",
        name: "ask_user",
        input: {
          why: "I need a person's answer before I go on: only they have it.",
          question: "Qual é o endereço da API?",
        },
      },
    );
    yield { type: "tool_call", id: "ask-2", name: "ask_user", input: {}, executed: result };
    yield { type: "done", text: opening };
  });
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(f, "@dev quanto o acme gastou este mês?");
  await drainOutbox(f.db, handlers);

  expect((await f.db.select().from(schema.agentRuns))[0]?.status).toBe("waiting_input");
  const fromAgent = (await timeline(f)).filter((m) => m.author.type === "agent");
  expect(fromAgent.map((m) => (m.meta.question ? "card" : m.body))).toEqual([opening, "card"]);
});

test("a plan limit falls back to the model brain; the reply carries a quiet note", async () => {
  f = await setup({ reply: () => ({ chunks: ["Respondi pela API."] }) });
  const machineId = await computerAgent(f);
  const { brain, seen } = scriptedComputerBrain(() => [
    { type: "limit", resetsAt: new Date(Date.now() + 2 * 3600_000).toISOString() },
    { type: "error", code: "plan_limit", message: "You've hit your limit.", worked: false },
  ]);
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(f, "@dev oi");
  await drainOutbox(f.db, handlers);

  expect(seen.length).toBe(1);
  const [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("done");
  const main = await timeline(f);
  const reply = main.at(-1);
  expect(reply?.body).toBe("Respondi pela API.");
  expect(reply?.meta.brainFallback).toMatchObject({ from: "claude_code", code: "plan_limit" });
  // The model brain that stood in has no computer tools: no computer note in its prompt.
  const fallbackPrompt = systemText(f.provider.calls.at(-1)?.request.system ?? "");
  expect(fallbackPrompt).not.toContain(COMPUTER_TOOLS_NOTE);
  expect(fallbackPrompt).toContain("Beyond this, you can't.");
  // That turn ran on the API (the agent's budget) and the limit is remembered for the next turns.
  const usage = await f.db
    .select()
    .from(schema.usageRecords)
    .where(eq(schema.usageRecords.runId, run?.id ?? ""));
  expect(usage.some((u) => u.provider === "anthropic")).toBe(true);
  expect(computerBrainUnavailable("claude_code", machineId, statusOf(machineId))?.code).toBe("plan_limit");
});

test("Fast: the turn of a conversation asks for it; refused, the reply says it came at standard speed", async () => {
  f = await setup({});
  await computerAgent(f, { brain: "codex", brainModel: "gpt-6.1-sol", brainSpeed: "fast" });
  const { brain, seen } = scriptedComputerBrain((n) =>
    n === 0
      ? [
          { type: "speed_fallback", message: "Fast mode is not available for this account." },
          { type: "done", text: "Respondi." },
        ]
      : [{ type: "done", text: "De novo." }],
  );
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { codex: () => ({ ...brain, kind: "codex" }) },
    machines: {
      status: async (id) =>
        statusOf(id, {
          protocol: MACHINE_PROTOCOL_VERSION,
          executors: { codex: { version: "codex-cli 0.166.0" }, detectedAt: new Date().toISOString() },
        }),
    },
  });
  await post(f, "@dev oi");
  await drainOutbox(f.db, handlers);
  expect(seen[0]).toMatchObject({ speed: "fast", model: "gpt-6.1-sol" });
  const reply = (await timeline(f)).at(-1);
  expect(reply).toMatchObject({ body: "Respondi.", meta: { speedFallback: true } });
  const steps = await f.db.select().from(schema.agentRunSteps);
  expect(steps.some((s) => (s.data as { speedFallback?: string }).speedFallback?.includes("not available"))).toBe(true);

  // The agent moves to a model without it: the value stays, nothing goes out.
  await f.db.update(schema.agents).set({ brainModel: "gpt-5.5" }).where(eq(schema.agents.id, f.agent.id));
  await post(f, "@dev e agora?");
  await drainOutbox(f.db, handlers);
  expect(seen[1]?.speed).toBeUndefined();
  expect((await timeline(f)).at(-1)?.meta.speedFallback).toBeUndefined();
});

test("a turn says a person waits on it only in the line's first rank: not for a routine, background work, an agent or a work", async () => {
  f = await setup();
  await computerAgent(f);
  const { brain, seen } = scriptedComputerBrain(() => [{ type: "done", text: "Feito." }]);
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  const turnFor = async (change?: (trigger: string, run: string) => Promise<unknown>) => {
    const fx = f as Fixture;
    const posted = await post(fx, "@dev oi");
    const [run] = await fx.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, posted.id));
    await change?.(posted.id, (run as { id: string }).id);
    await drainOutbox(fx.db, handlers);
    return seen.at(-1)?.personWaiting;
  };
  const setRun = (values: { background?: boolean; hop?: number }) => (_: string, run: string) =>
    (f as Fixture).db.update(schema.agentRuns).set(values).where(eq(schema.agentRuns.id, run));

  expect(await turnFor()).toBe(true);
  expect(
    await turnFor((trigger) =>
      (f as Fixture).db
        .update(schema.messages)
        .set({ meta: { routine: { id: "11111111-1111-4111-8111-111111111111", name: "Resumo" } } })
        .where(eq(schema.messages.id, trigger)),
    ),
  ).toBeUndefined();
  expect(await turnFor(setRun({ background: true }))).toBeUndefined();
  expect(await turnFor(setRun({ hop: 2 }))).toBeUndefined();
  // A person's own work, once in the background, leaves the reserved slot to their reply turn beside it.
  expect(
    await turnFor(async (_, run) => {
      const fx = f as Fixture;
      const [work] = await fx.db
        .insert(schema.agentWorks)
        .values({
          orgId: fx.org.id,
          agentId: fx.agent.id,
          channelId: fx.general.id,
          anchorMessageId: Bun.randomUUIDv7(),
          ownThread: true,
          title: "QA do site",
          status: "live",
          how: "agent",
          lastUpdateAt: new Date(),
        })
        .returning();
      await fx.db.update(schema.agentRuns).set({ workId: work?.id }).where(eq(schema.agentRuns.id, run));
    }),
  ).toBeUndefined();
});

test("Fast stays out of every run nobody waits for", async () => {
  f = await setup({});
  await computerAgent(f, { brain: "codex", brainModel: "gpt-6.1-sol", brainSpeed: "fast" });
  const { brain, seen } = scriptedComputerBrain(() => [{ type: "done", text: "Feito." }]);
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { codex: () => ({ ...brain, kind: "codex" }) },
    machines: {
      status: async (id) =>
        statusOf(id, {
          protocol: MACHINE_PROTOCOL_VERSION,
          executors: { codex: { version: "codex-cli 0.166.0" }, detectedAt: new Date().toISOString() },
        }),
    },
  });
  const called = { id: "11111111-1111-4111-8111-111111111111", name: "Resumo" };
  const ran: string[] = [];
  const turnFor = async (change?: (trigger: string, run: string) => Promise<unknown>) => {
    const posted = await post(f as Fixture, "@dev oi");
    const [run] = await (f as Fixture).db
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.triggerMessageId, posted.id));
    const id = (run as { id: string }).id;
    ran.push(id);
    await change?.(posted.id, id);
    await drainOutbox((f as Fixture).db, handlers);
    return seen.at(-1)?.speed;
  };
  const withMeta = (meta: Record<string, unknown>) => (trigger: string) =>
    (f as Fixture).db.update(schema.messages).set({ meta }).where(eq(schema.messages.id, trigger));

  expect(await turnFor()).toBe("fast");
  expect(await turnFor(withMeta({ routine: called }))).toBeUndefined();
  expect(await turnFor(withMeta({ viaRoutine: called }))).toBeUndefined();
  expect(await turnFor(withMeta({ issueId: "22222222-2222-4222-8222-222222222222" }))).toBeUndefined();
  expect(
    await turnFor((_, run) =>
      (f as Fixture).db.update(schema.agentRuns).set({ background: true }).where(eq(schema.agentRuns.id, run)),
    ),
  ).toBeUndefined();

  // Asked by another agent: in someone's conversation it goes fast, for a routine's run it doesn't.
  const fromAgent = (background: boolean) => async (trigger: string, run: string) => {
    const fx = f as Fixture;
    const asker = ran[0] as string;
    await fx.db.update(schema.agentRuns).set({ background }).where(eq(schema.agentRuns.id, asker));
    await fx.db
      .update(schema.messages)
      .set({ authorType: "agent", authorUserId: null, authorAgentId: fx.agent.id })
      .where(eq(schema.messages.id, trigger));
    await fx.db.insert(schema.agentConsultations).values({
      orgId: fx.org.id,
      askerRunId: asker,
      askerAgentId: fx.agent.id,
      targetAgentId: fx.agent.id,
      targetRunId: run,
      channelId: fx.general.id,
      messageId: trigger,
      waitId: `async:${crypto.randomUUID()}`,
      question: "Pode olhar?",
      chain: [fx.agent.id],
      expiresAt: new Date(Date.now() + 60_000),
    });
  };
  expect(await turnFor(fromAgent(false))).toBe("fast");
  expect(await turnFor(fromAgent(true))).toBeUndefined();
});

test("Claude Code lists every tool; the model brain standing in lists the core ones and finds the rest", async () => {
  f = await setup({ toolsOnDemand: true, issueTools: true, reply: () => ({ chunks: ["Respondi pela API."] }) });
  await computerAgent(f);
  await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: "issues:read" }]);
  const { brain, seen } = scriptedComputerBrain(() => [
    { type: "error", code: "plan_limit", message: "You've hit your limit.", worked: false },
  ]);
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(f, "@dev oi");
  await drainOutbox(f.db, handlers);

  expect(seen[0]?.tools.map((t) => t.name)).toContain("list_issues");
  const names = f.provider.calls.at(-1)?.request.tools?.map((t) => t.name) ?? [];
  expect(names).toContain("find_tools");
  expect(names).not.toContain("list_issues");
  const [run] = await f.db.select().from(schema.agentRuns);
  expect((run?.transcript as { toolGroups?: string[] } | null)?.toolGroups).toEqual([]);
});

test("the agent's account and effort reach its turn; a refused sign-in falls back and the computer decides the status", async () => {
  f = await setup({ reply: () => ({ chunks: ["Respondi pela API."] }) });
  const ACCOUNT = "0193dddd-0000-4000-8000-000000000001";
  const machineId = await computerAgent(f, { brainEffort: "high" });
  await f.db.insert(schema.machineAccounts).values({
    id: ACCOUNT,
    orgId: f.org.id,
    machineId,
    kind: "claude_code",
    label: "Trabalho",
    status: "active",
    createdBy: f.owner.id,
  });
  await f.db.update(schema.agents).set({ brainAccountId: ACCOUNT }).where(eq(schema.agents.id, f.agent.id));
  const { brain, seen } = scriptedComputerBrain(() => [
    { type: "error", code: "not_logged_in", message: "Not logged in · Please run /login" },
  ]);
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id, { protocol: ACCOUNTS_PROTOCOL }) },
  });
  await post(f, "@dev oi");
  await drainOutbox(f.db, handlers);

  expect(seen[0]).toMatchObject({ account: { id: ACCOUNT, label: "Trabalho", status: "active" }, effort: "high" });
  // The server never marks it by itself: the computer asks the CLI again and reports (`accounts.changed`).
  const [account] = await f.db.select().from(schema.machineAccounts);
  expect(account?.status).toBe("active");
  const runs = await f.db.select().from(schema.agentRuns);
  expect(runs.map((r) => r.status)).toEqual(["done"]);

  // Until the computer says otherwise, the next turn asks it again (and falls back again).
  await post(f, "@dev de novo");
  await drainOutbox(f.db, handlers);
  expect(seen.length).toBe(2);
  const after = await f.db.select().from(schema.agentRuns);
  expect(after.map((r) => r.status)).toEqual(["done", "done"]);
});

test("a Claude Code turn's provider failure is kept on its account and told the operator once per cause", async () => {
  enableOperatorEvents();
  resetAccountFailures();
  try {
    f = await setup({ reply: () => ({ chunks: ["Respondi pela API."] }) });
    const ACCOUNT = "0193dddd-0000-4000-8000-000000000002";
    const machineId = await computerAgent(f);
    await f.db.insert(schema.machineAccounts).values({
      id: ACCOUNT,
      orgId: f.org.id,
      machineId,
      kind: "claude_code",
      label: "Trabalho",
      status: "active",
      authMethod: "setup_token",
      createdBy: f.owner.id,
    });
    await f.db.update(schema.agents).set({ brainAccountId: ACCOUNT }).where(eq(schema.agents.id, f.agent.id));
    const script: BrainEvent[][] = [
      [
        {
          type: "error",
          code: "not_logged_in",
          message: "x",
          retryable: true,
          cause: "account_disabled",
          httpStatus: 400,
        },
      ],
      [
        {
          type: "error",
          code: "not_logged_in",
          message: "x",
          retryable: true,
          cause: "account_disabled",
          httpStatus: 400,
        },
      ],
      [{ type: "done", text: "Feito." }],
      // An older runner says no cause: its code says it.
      [{ type: "error", code: "claude_failed", message: "boom", retryable: false }],
      [{ type: "error", code: "canceled", message: "The turn was canceled.", retryable: false }],
    ];
    const { brain } = scriptedComputerBrain((n) => script[n] ?? []);
    const handlers = createJobHandlers({
      ...f.jobDeps,
      brains: { claude_code: () => brain },
      machines: { status: async (id) => statusOf(id, { protocol: ACCOUNTS_PROTOCOL }) },
    });
    const account = async () =>
      (await f.db.select().from(schema.machineAccounts).where(eq(schema.machineAccounts.id, ACCOUNT)))[0];
    const events = async (type: string) =>
      (await f.db.select().from(schema.operatorEvents).where(eq(schema.operatorEvents.type, type))).map((e) => e.data);

    await post(f, "@dev oi");
    await drainOutbox(f.db, handlers);
    expect(await account()).toMatchObject({ lastFailureCause: "account_disabled", lastSuccessAt: null });
    expect((await account())?.lastFailureAt).toBeInstanceOf(Date);
    expect(await events("account.failure")).toEqual([
      {
        accountId: ACCOUNT,
        machineId,
        kind: "claude_code",
        authMethod: "setup_token",
        cause: "account_disabled",
        code: "not_logged_in",
        httpStatus: 400,
        runnerVersion: RUNNER.version,
        protocol: RUNNER.protocol,
      },
    ]);
    // The same cause again soon after: kept on the row, not told twice.
    await post(f, "@dev de novo");
    await drainOutbox(f.db, handlers);
    expect(await events("account.failure")).toHaveLength(1);

    await post(f, "@dev agora vai");
    await drainOutbox(f.db, handlers);
    expect((await account())?.lastSuccessAt).toBeInstanceOf(Date);

    await post(f, "@dev e agora?");
    await drainOutbox(f.db, handlers);
    expect(await account()).toMatchObject({ lastFailureCause: "unknown" });
    expect((await events("account.failure")).map((e) => (e as { cause: string }).cause)).toEqual([
      "account_disabled",
      "unknown",
    ]);
    const finished = (await events("run.finished")) as { status: string; failure?: unknown }[];
    expect(finished.find((e) => e.status === "failed")?.failure).toEqual({ code: "claude_failed", cause: "unknown" });
    // The run keeps whose failure it was and what Claude Code said: never "the computer had a problem".
    const [failed] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.status, "failed"));
    expect(failed?.error).toBe("cli_failed: Claude Code: boom");
    expect(finished.filter((e) => e.status === "done").every((e) => e.failure === undefined)).toBe(true);

    // Not the provider's: nothing kept nor told.
    await post(f, "@dev cancela");
    await drainOutbox(f.db, handlers);
    expect(await account()).toMatchObject({ lastFailureCause: "unknown" });
    expect(await events("account.failure")).toHaveLength(2);
  } finally {
    enableOperatorEvents(false);
  }
});

test("the agent's account and effort apply to its own brain; signed out or an older runner: unavailable", async () => {
  f = await setup();
  const ACCOUNT = "0193dddd-0000-4000-8000-000000000001";
  const machineId = await computerAgent(f, { brainEffort: "low" });
  await f.db.insert(schema.machineAccounts).values({
    id: ACCOUNT,
    orgId: f.org.id,
    machineId,
    kind: "claude_code",
    label: "Trabalho",
    status: "active",
    createdBy: f.owner.id,
  });
  await f.db.update(schema.agents).set({ brainAccountId: ACCOUNT }).where(eq(schema.agents.id, f.agent.id));
  const question = await post(f, "@dev oi");
  const [agent] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, f.agent.id));
  const [run] = await f.db.select().from(schema.agentRuns);
  if (!agent || !run) throw new Error("missing rows");
  const plan = await resolveBrain({ db: f.db }, agent, run, question.id);
  expect(plan).toMatchObject({ kind: "claude_code", account: { id: ACCOUNT, status: "active" }, effort: "low" });
  // One of a coding plan's models by id thinks on that plan; kept while Claude's sign-in thinks, it runs Sonnet.
  const picked = { ...agent, brainModel: "k3-256k" };
  await f.db.update(schema.machineAccounts).set({ provider: "kimi" });
  expect(await resolveBrain({ db: f.db }, picked, run, question.id)).toMatchObject({
    model: "k3-256k",
    account: { provider: "kimi" },
  });
  await f.db.update(schema.machineAccounts).set({ provider: "zai" });
  expect((await resolveBrain({ db: f.db }, picked, run, question.id)).model).toBe("sonnet");
  await f.db.update(schema.machineAccounts).set({ provider: null });
  expect((await resolveBrain({ db: f.db }, picked, run, question.id)).model).toBe("sonnet");
  expect((await resolveBrain({ db: f.db }, { ...agent, brainModel: "auto" }, run, question.id)).model).toBe("auto");
  // Another brain (a mission's choice): neither applies; an account of another kind is no account.
  expect(brainEffortFor(agent, "codex")).toBeUndefined();
  expect(brainEffortFor(agent, "claude_code")).toBe("low");
  const codex = await resolveBrain({ db: f.db }, { ...agent, brain: "codex" }, run, question.id);
  expect(codex.account).toBeUndefined();
  // Signed out: the plan says so before the computer is asked.
  await f.db.update(schema.machineAccounts).set({ status: "signed_out" });
  const out = await resolveBrain(
    { db: f.db, machines: { status: async (id) => statusOf(id, { protocol: ACCOUNTS_PROTOCOL }) } },
    agent,
    run,
    question.id,
  );
  expect(out.unavailable).toMatchObject({ code: "not_logged_in" });
  // A runner older than accounts can't run it.
  await f.db.update(schema.machineAccounts).set({ status: "active" });
  const old = await resolveBrain(
    { db: f.db, machines: { status: async (id) => statusOf(id) } },
    agent,
    run,
    question.id,
  );
  expect(old.unavailable).toMatchObject({ code: "runner_outdated" });
});

test("someone else's plan never thinks for the agent: plan_not_owner falls back to the API, or the run waits", async () => {
  f = await setup({ reply: () => ({ chunks: ["Respondi pela API."] }) });
  const machineId = await computerAgent(f);
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  // Bia owns the agent now; the computer's own sign-in is Ana's.
  await f.db.update(schema.agents).set({ ownerUserId: bia.id }).where(eq(schema.agents.id, f.agent.id));
  const { brain, seen } = scriptedComputerBrain(() => [{ type: "done", text: "Pelo plano da Ana." }]);
  const machines = { status: async (id: string) => statusOf(id) };
  const handlers = createJobHandlers({ ...f.jobDeps, brains: { claude_code: () => brain }, machines });
  await post(f, "@dev oi");
  await drainOutbox(f.db, handlers);
  expect(seen).toEqual([]);
  expect((await timeline(f)).at(-1)?.meta.brainFallback).toMatchObject({ from: "claude_code", code: "plan_not_owner" });

  // Her own account on that computer thinks for her agent, while she is in the organization.
  const ACCOUNT = "0193dddd-0000-4000-8000-000000000001";
  await f.db.insert(schema.machineAccounts).values({
    id: ACCOUNT,
    orgId: f.org.id,
    machineId,
    kind: "claude_code",
    label: "Pessoal",
    status: "active",
    createdBy: bia.id,
  });
  await f.db.update(schema.agents).set({ brainAccountId: ACCOUNT }).where(eq(schema.agents.id, f.agent.id));
  const [agent] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, f.agent.id));
  const [run] = await f.db.select().from(schema.agentRuns);
  if (!agent || !run) throw new Error("missing rows");
  const statusAccounts = { status: async (id: string) => statusOf(id, { protocol: ACCOUNTS_PROTOCOL }) };
  const mine = await resolveBrain({ db: f.db, machines: statusAccounts }, agent, run, f.general.id);
  expect(mine.unavailable).toBeUndefined();
  // She left: her account no longer thinks for anyone.
  await f.db.delete(schema.organizationMembers).where(eq(schema.organizationMembers.userId, bia.id));
  const gone = await resolveBrain({ db: f.db, machines: statusAccounts }, agent, run, f.general.id);
  expect(gone.unavailable).toMatchObject({ code: "plan_not_owner" });

  // Ana's agent on a computer Bia connected, nothing to stand in: the run waits instead.
  await f.db.update(schema.agents).set({ ownerUserId: f.owner.id, brainAccountId: null });
  await f.db.update(schema.machines).set({ pairedByUserId: bia.id }).where(eq(schema.machines.id, machineId));
  await f.db.update(schema.providerCredentials).set({ revokedAt: new Date() });
  await post(f, "@dev de novo");
  await drainOutbox(f.db, handlers);
  const runs = await f.db.select().from(schema.agentRuns);
  expect(runs.map((r) => r.status).sort()).toEqual(["done", "waiting_input"]);
  const waiting = runs.find((r) => r.status === "waiting_input")?.transcript as { waitingForBrain?: { code: string } };
  expect(waiting.waitingForBrain?.code).toBe("plan_not_owner");
  expect(seen).toEqual([]);
});

test("with no model credential, an offline computer: the agent says so once and the run waits until it is back", async () => {
  f = await setup();
  const machineId = await computerAgent(f);
  // No key the API could answer with: nothing can stand in.
  await f.db.update(schema.providerCredentials).set({ revokedAt: new Date() });
  let online = false;
  const { brain, seen } = scriptedComputerBrain(() => [{ type: "done", text: "Voltei e respondo." }]);
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id, { online }) },
  });
  await post(f, "@dev oi");
  await drainOutbox(f.db, handlers);

  let [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("waiting_input");
  expect(seen.length).toBe(0);
  let main = await timeline(f);
  expect(main.at(-1)?.meta).toMatchObject({
    bodyCode: "brain_unavailable",
    brainUnavailable: { brain: "claude_code", code: "machine_offline" },
  });

  // The computer it waits for is on the row (indexed), not only in the transcript.
  expect(run?.waitingMachineId).toBe(machineId);
  online = true;
  expect(await resumeRunsWaitingForMachine(f.db, machineId)).toEqual([run?.id ?? ""]);
  // Reconnecting again before the job ran: still one job for this wait.
  expect(await resumeRunsWaitingForMachine(f.db, machineId)).toEqual([run?.id ?? ""]);
  const back = (await f.db.select().from(schema.outbox)).filter((j) => j.dedupeKey?.includes(":brain_back:"));
  expect(back.length).toBe(1);
  await drainOutbox(f.db, handlers);
  [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("done");
  expect(run?.waitingMachineId).toBeNull();
  // Nothing waits for that computer anymore.
  expect(await resumeRunsWaitingForMachine(f.db, machineId)).toEqual([]);
  expect(seen.length).toBe(1);
  main = await timeline(f);
  expect(main.at(-1)?.body).toBe("Voltei e respondo.");
});

test("a computer gone a few seconds ago: the run waits for it as one still working, and answers once it is back", async () => {
  f = await setup();
  const machineId = await computerAgent(f);
  await f.db.update(schema.providerCredentials).set({ revokedAt: new Date() });
  const lastSeenAt = await justGone(f, machineId);
  let looks = 0;
  const { brain, seen } = scriptedComputerBrain(() => [{ type: "done", text: "Pronto." }]);
  const handlers = createJobHandlers({
    ...f.jobDeps,
    computerBlipWaitMs: 10_000,
    brains: { claude_code: () => brain },
    machines: {
      status: async (id) => {
        if (await waitingLook(f)) looks++;
        // Back at its second look while the run waits.
        return statusOf(id, { online: looks >= 2, lastSeenAt });
      },
    },
  });
  const events: { type: string; status?: string }[] = [];
  f.pubsub.subscribe(channelTopic(f.general.id), (e) => events.push(e as { type: string; status?: string }));
  await post(f, "@dev oi");
  await drainOutbox(f.db, handlers);

  const [run] = await f.db.select().from(schema.agentRuns);
  if (!run) throw new Error("no run");
  expect(looks).toBeGreaterThanOrEqual(2);
  expect(run.status).toBe("done");
  expect(seen.length).toBe(1);
  // No note, no wait stored, never parked: only its answer.
  expect((await timeline(f)).map((m) => m.body)).toEqual(["@dev oi", "Pronto."]);
  expect((run.transcript as { waitingForBrain?: unknown }).waitingForBrain).toBeUndefined();
  expect(events.some((e) => e.type === "run.finished" && e.status === "waiting_input")).toBe(false);
  const steps = await f.db
    .select({ data: schema.agentRunSteps.data })
    .from(schema.agentRunSteps)
    .where(eq(schema.agentRunSteps.runId, run.id));
  expect(steps.some((s) => s.data.reason === "brain_unavailable")).toBe(false);
});

test("a computer still gone after that moment: it waits without a word until the outage grace is over, then says so once", async () => {
  f = await setup();
  const machineId = await computerAgent(f);
  await f.db.update(schema.providerCredentials).set({ revokedAt: new Date() });
  let lastSeenAt = await justGone(f, machineId);
  const outages = async () =>
    (await listMachineOutages({ db: f.db }, f.owner.id, f.org.id)).outages.map((o) => o.machineId);
  const { brain, seen } = scriptedComputerBrain(() => [{ type: "done", text: "Voltei." }]);
  const handlers = createJobHandlers({
    ...f.jobDeps,
    computerBlipWaitMs: 300,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id, { online: false, lastSeenAt }) },
  });
  await post(f, "@dev oi");
  await drainOutbox(f.db, handlers);

  let [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("waiting_input");
  expect(run?.waitingMachineId).toBe(machineId);
  expect(seen.length).toBe(0);
  const notes = async () => (await timeline(f)).filter((m) => m.meta.bodyCode === "brain_unavailable");
  expect(await notes()).toEqual([]);
  // A blip (a deploy, a runner dialing again) is no outage yet: no card, no note.
  expect(await outages()).toEqual([]);
  const look = (await f.db.select().from(schema.outbox)).find((j) => j.dedupeKey?.includes(":offline_note:"));
  expect(look?.nextAttemptAt.getTime()).toBe(Date.parse(lastSeenAt) + 2 * 60_000);

  // Still gone past the grace: the note, once, and the outage shows.
  lastSeenAt = new Date(Date.now() - 3 * 60_000).toISOString();
  await f.db
    .update(schema.machines)
    .set({ lastSeenAt: new Date(lastSeenAt) })
    .where(eq(schema.machines.id, machineId));
  await drainOutbox(f.db, handlers, { now: new Date(Date.now() + 3 * 60_000) });
  [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("waiting_input");
  expect((await notes()).map((m) => m.meta.brainUnavailable)).toMatchObject([{ code: "machine_offline", machineId }]);
  expect(await outages()).toEqual([machineId]);

  // Another run of the agent waiting there for the same computer adds nothing.
  const again = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "person", userId: f.owner.id },
    body: "e aí?",
  });
  await secondRun(f, again.id);
  await drainOutbox(f.db, handlers, { now: new Date(Date.now() + 3 * 60_000) });
  expect((await f.db.select().from(schema.agentRuns)).map((r) => r.status)).toEqual(["waiting_input", "waiting_input"]);
  expect(await notes()).toHaveLength(1);
});

test("a computer gone for minutes is an outage: the agent says so at once, without waiting", async () => {
  f = await setup();
  await computerAgent(f);
  await f.db.update(schema.providerCredentials).set({ revokedAt: new Date() });
  const lastSeenAt = new Date(Date.now() - 10 * 60_000).toISOString();
  let looks = 0;
  const { brain } = scriptedComputerBrain(() => [{ type: "done", text: "Voltei." }]);
  const handlers = createJobHandlers({
    ...f.jobDeps,
    computerBlipWaitMs: 10_000,
    brains: { claude_code: () => brain },
    machines: {
      status: async (id) => {
        if (await waitingLook(f)) looks++;
        return statusOf(id, { online: false, lastSeenAt });
      },
    },
  });
  await post(f, "@dev oi");
  await drainOutbox(f.db, handlers);
  // One look to wait for it, one to tell an outage from a blip: never a wait.
  expect(looks).toBe(2);
  expect((await f.db.select().from(schema.agentRuns))[0]?.status).toBe("waiting_input");
  expect((await timeline(f)).at(-1)?.meta).toMatchObject({ bodyCode: "brain_unavailable" });
});

/** The workspace's computer asleep in standby for hours (ADR 0161), as the hub says it; `wakes`: back once asked to. */
function sleepingComputer(wakes: boolean) {
  const slept = new Date(Date.now() - 6 * 3600_000).toISOString();
  const woke: string[] = [];
  const machines = {
    status: async (id: string) =>
      statusOf(
        id,
        wakes && woke.length > 0
          ? { online: true }
          : { online: false, standby: true, kind: "managed", lastSeenAt: slept },
      ),
    wake: async (id: string, why: string) => {
      woke.push(`${id}:${why}`);
    },
  };
  return { machines, woke };
}

test("a computer in standby: the run asks it to wake and waits quietly however long it slept, then answers", async () => {
  f = await setup();
  const machineId = await computerAgent(f);
  await f.db.update(schema.providerCredentials).set({ revokedAt: new Date() });
  const sleeping = sleepingComputer(true);
  const { brain, seen } = scriptedComputerBrain(() => [{ type: "done", text: "Pronto." }]);
  const handlers = createJobHandlers({
    ...f.jobDeps,
    computerBlipWaitMs: 10,
    computerWakeWaitMs: 10_000,
    brains: { claude_code: () => brain },
    machines: sleeping.machines,
  });
  await post(f, "@dev oi");
  await drainOutbox(f.db, handlers);

  const [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("done");
  expect(seen.length).toBe(1);
  expect(new Set(sleeping.woke)).toEqual(new Set([`${machineId}:run`]));
  // No note, no wait stored: only its answer.
  expect((await timeline(f)).map((m) => m.body)).toEqual(["@dev oi", "Pronto."]);
  expect((run?.transcript as { waitingForBrain?: unknown } | undefined)?.waitingForBrain).toBeUndefined();
});

test("still asleep after the wake's wait: the note and the wait for the computer, as for any computer away", async () => {
  f = await setup();
  const machineId = await computerAgent(f);
  await f.db.update(schema.providerCredentials).set({ revokedAt: new Date() });
  const sleeping = sleepingComputer(false);
  const { brain, seen } = scriptedComputerBrain(() => [{ type: "done", text: "Pronto." }]);
  const handlers = createJobHandlers({
    ...f.jobDeps,
    computerBlipWaitMs: 10,
    computerWakeWaitMs: 300,
    brains: { claude_code: () => brain },
    machines: sleeping.machines,
  });
  await post(f, "@dev oi");
  await drainOutbox(f.db, handlers);
  const [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("waiting_input");
  expect(run?.waitingMachineId).toBe(machineId);
  expect(seen.length).toBe(0);
  expect(sleeping.woke).toEqual([`${machineId}:run`]);
  expect((await timeline(f)).at(-1)?.meta).toMatchObject({
    bodyCode: "brain_unavailable",
    brainUnavailable: { code: "machine_offline", machineId },
  });
});

test("a run back from another wait finds its computer fallen asleep: it asks it to wake and waits again", async () => {
  f = await setup();
  const machineId = await computerAgent(f);
  await f.db.update(schema.providerCredentials).set({ revokedAt: new Date() });
  // Away for minutes, not asleep: the run says so and waits for it.
  const lastSeenAt = new Date(Date.now() - 10 * 60_000).toISOString();
  let asleep = false;
  const woke: string[] = [];
  const { brain, seen } = scriptedComputerBrain(() => [{ type: "done", text: "Voltei." }]);
  const handlers = createJobHandlers({
    ...f.jobDeps,
    computerBlipWaitMs: 10,
    computerWakeWaitMs: 10_000,
    brains: { claude_code: () => brain },
    machines: {
      status: async (id) =>
        !asleep
          ? statusOf(id, { online: false, lastSeenAt })
          : woke.length > 0
            ? statusOf(id, { online: true })
            : statusOf(id, { online: false, standby: true, kind: "managed", lastSeenAt }),
      wake: async (id, why) => {
        woke.push(`${id}:${why}`);
      },
    },
  });
  await post(f, "@dev oi");
  await drainOutbox(f.db, handlers);
  expect((await f.db.select().from(schema.agentRuns))[0]?.status).toBe("waiting_input");
  expect(woke).toEqual([]);

  // The operator put it in standby since; the run is asked to go on (a message, its computer's signal).
  asleep = true;
  await resumeRunsWaitingForMachine(f.db, machineId);
  await drainOutbox(f.db, handlers);
  expect((await f.db.select().from(schema.agentRuns))[0]?.status).toBe("done");
  expect(seen.length).toBe(1);
  expect(woke[0]).toBe(`${machineId}:run`);
  expect((await timeline(f)).at(-1)?.body).toBe("Voltei.");
});

test("a cancel while the run waits for its computer ends it at once", async () => {
  f = await setup();
  const machineId = await computerAgent(f);
  await f.db.update(schema.providerCredentials).set({ revokedAt: new Date() });
  const lastSeenAt = await justGone(f, machineId);
  let canceled = false;
  const { brain, seen } = scriptedComputerBrain(() => [{ type: "done", text: "Pronto." }]);
  const handlers = createJobHandlers({
    ...f.jobDeps,
    computerBlipWaitMs: 20_000,
    brains: { claude_code: () => brain },
    machines: {
      status: async (id) => {
        if (!canceled && (await waitingLook(f))) {
          canceled = true;
          const [run] = await f.db.select().from(schema.agentRuns);
          void cancelRun({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, run?.id ?? "");
        }
        return statusOf(id, { online: false, lastSeenAt });
      },
    },
  });
  await post(f, "@dev oi");
  const started = Date.now();
  await drainOutbox(f.db, handlers);
  expect(Date.now() - started).toBeLessThan(5_000);
  expect((await f.db.select().from(schema.agentRuns))[0]?.status).toBe("canceled");
  expect(seen.length).toBe(0);
  // The agent's own "stopped" line ends what people read (the notice after it is the agent's, ADR 0128).
  const main = (await timeline(f)).filter((m) => !m.meta.notice);
  expect(main.at(-1)?.body).toBe("_Stopped by ana._");
  expect(main.some((m) => m.meta.bodyCode === "brain_unavailable")).toBe(false);
});

test("the computer drops mid-turn after a tool ran: the run stops working, resumes there when it is back, nothing runs twice", async () => {
  let checks = 0;
  const env: ToolSource = {
    name: "env",
    tools: async () => [
      {
        name: "check_env",
        description: "Check the environment",
        scope: "",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => {
          checks++;
          return { content: "go 1.23" };
        },
      },
    ],
  };
  f = await setup({ toolSources: [env], reply: () => ({ chunks: ["Respondi pela API."] }) });
  const machineId = await computerAgent(f);
  let online = true;
  const { brain, seen } = scriptedComputerBrain(async function* (n, turn) {
    if (n === 0) {
      online = false;
      const id = { orgId: turn.orgId, agentId: turn.agentId, runId: turn.runId, machineId };
      const result = await executeToolForRun(f.jobDeps, id, { id: "c-1", name: "check_env", input: {} });
      yield { type: "text_delta", text: "Verificando..." };
      yield { type: "tool_call", id: "c-1", name: "check_env", input: {}, executed: result };
      // The runner was killed (the desktop app reinstalled): the hub fails the request as offline.
      yield { type: "error", code: "machine_offline", message: "The computer MacBook is offline.", retryable: true };
      return;
    }
    yield { type: "done", text: "Tem Go 1.23." };
  });
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id, { online }) },
  });
  const events: string[] = [];
  f.pubsub.subscribe(channelTopic(f.general.id), (e) => events.push(String(e.type)));
  await post(f, "@dev tem Go aí?");
  await drainOutbox(f.db, handlers);

  // Not working anymore: waiting for that computer, quietly (no note yet), nothing redone by the API.
  let [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("waiting_input");
  expect(run?.waitingMachineId).toBe(machineId);
  expect(seen.length).toBe(1);
  let main = await timeline(f);
  expect(main.length).toBe(1);
  // The "working" indicator cleared.
  expect(events).toContain("agent.idle");

  // Back: the turn goes to the same computer again, told what already ran.
  online = true;
  expect(await resumeRunsWaitingForMachine(f.db, machineId)).toEqual([run?.id ?? ""]);
  await drainOutbox(f.db, handlers);
  [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("done");
  expect(seen.length).toBe(2);
  expect(seen[1]?.trigger).toContain("cut off because the computer disconnected");
  expect(seen[1]?.trigger).toContain("do not repeat: check_env");
  expect(seen[1]?.trigger).toContain("tem Go aí?");
  expect(seen[1]?.session?.machineId).toBe(machineId);
  expect(checks).toBe(1);
  main = await timeline(f);
  expect(main.at(-1)?.body).toBe("Tem Go 1.23.");
  const usage = await f.db
    .select()
    .from(schema.usageRecords)
    .where(eq(schema.usageRecords.runId, run?.id ?? ""));
  expect(usage.some((u) => u.provider === "anthropic")).toBe(false);

  // The grace job of that wait finds nothing to do (the run is not run twice).
  await drainOutbox(f.db, handlers, { now: new Date(Date.now() + 10 * 60_000) });
  expect(seen.length).toBe(2);
  expect((await f.db.select().from(schema.agentRuns))[0]?.status).toBe("done");
});

test("the computer drops mid-turn and is already back: the turn is sent again right away", async () => {
  f = await setup();
  await computerAgent(f);
  const { brain, seen } = scriptedComputerBrain((n) =>
    n === 0
      ? [{ type: "error", code: "machine_offline", message: "The computer MacBook is offline.", retryable: true }]
      : [{ type: "done", text: "Pronto." }],
  );
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(f, "@dev oi");
  await drainOutbox(f.db, handlers);
  const [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("done");
  expect(seen.length).toBe(2);
  // No fallback to the API and no "unavailable" note.
  const main = await timeline(f);
  expect(main.map((m) => m.body)).toEqual(["@dev oi", "Pronto."]);
});

test("the computer drops mid-turn and stays away: after the grace the agent says so once, and answers when it is back", async () => {
  f = await setup();
  const machineId = await computerAgent(f);
  await f.db.update(schema.providerCredentials).set({ revokedAt: new Date() });
  let online = true;
  const { brain, seen } = scriptedComputerBrain((n) => {
    if (n > 0) return [{ type: "done", text: "Voltei." }];
    online = false;
    return [{ type: "error", code: "machine_offline", message: "The computer MacBook is offline.", retryable: true }];
  });
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id, { online }) },
  });
  await post(f, "@dev oi");
  await drainOutbox(f.db, handlers);
  expect((await f.db.select().from(schema.agentRuns))[0]?.status).toBe("waiting_input");

  await drainOutbox(f.db, handlers, { now: new Date(Date.now() + 3 * 60_000) });
  let [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("waiting_input");
  expect(run?.waitingMachineId).toBe(machineId);
  let main = await timeline(f);
  expect(main.at(-1)?.meta).toMatchObject({ brainUnavailable: { brain: "claude_code", code: "machine_offline" } });
  expect(seen.length).toBe(1);

  online = true;
  await resumeRunsWaitingForMachine(f.db, machineId);
  await drainOutbox(f.db, handlers);
  [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("done");
  expect(seen.length).toBe(2);
  expect(seen[1]?.trigger).toContain("cut off because the computer disconnected");
  main = await timeline(f);
  expect(main.at(-1)?.body).toBe("Voltei.");
});

test("a computer turn whose server died mid-turn is sent again as cut off, with what ran, never as the request again", async () => {
  f = await setup();
  await computerAgent(f);
  const { brain, seen } = scriptedComputerBrain(() => [{ type: "done", text: "Tem Go 1.23." }]);
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(f, "@dev tem Go aí?");
  // Its server died in the middle of the turn, after `check_env` ran through the bridge; the dead worker still
  // holds the job.
  const [run] = await f.db.select().from(schema.agentRuns);
  if (!run) throw new Error("no run");
  const long = new Date(Date.now() - 10 * 60_000);
  await f.db
    .update(schema.agentRuns)
    .set({
      status: "running",
      brain: "claude_code",
      startedAt: long,
      heartbeatAt: long,
      transcript: { system: [], messages: [], postedUpTo: 0, postedCount: 0, deltaSeq: 0 },
    })
    .where(eq(schema.agentRuns.id, run.id));
  await addRunStep(f.db, run, "tool_call", { toolUseId: "c-1", name: "check_env", input: {} });
  await addRunStep(f.db, run, "tool_result", { toolUseId: "c-1", name: "check_env", isError: false, content: "go" });
  await f.db
    .update(schema.outbox)
    .set({ status: "processing", lockedUntil: new Date(Date.now() + 600_000), lockedBy: "dead" })
    .where(eq(schema.outbox.kind, "agent_run.execute"));

  expect((await recoverStaleRuns({ db: f.db, pubsub: f.pubsub })).resumed).toEqual([run.id]);
  await drainOutbox(f.db, handlers);
  expect(seen.length).toBe(1);
  expect(seen[0]?.trigger).toContain("cut off because the server restarted");
  expect(seen[0]?.trigger).toContain("do not repeat: check_env");
  expect(seen[0]?.trigger).toContain("tem Go aí?");
  expect((await f.db.select().from(schema.agentRuns))[0]?.status).toBe("done");
  expect((await timeline(f)).at(-1)?.body).toBe("Tem Go 1.23.");
});

test("a computer turn cut by a crash while it answered a decision is sent again with that decision, not the request", async () => {
  const gh = fakeGithub();
  f = await setup({ toolSources: [gh.source] });
  await grantScopes(f.db, f.org.id, f.agent.id, ALL_GITHUB_SCOPES);
  const machineId = await computerAgent(f);
  let midTurn: typeof schema.agentRuns.$inferSelect | undefined;
  const { brain, seen } = scriptedComputerBrain(async function* (n, turn) {
    if (n === 0) {
      const result = await executeToolForRun(
        f.jobDeps,
        { orgId: turn.orgId, agentId: turn.agentId, runId: turn.runId, machineId },
        {
          id: "call-1",
          name: "github_merge_pr",
          input: { repo: "acme/app", pr: 42, why: "CI passed on the PR and it was reviewed: merging ships the fix." },
        },
      );
      yield { type: "tool_call", id: "call-1", name: "github_merge_pr", input: {}, executed: result };
      yield { type: "done", text: "Pedi aprovação para o merge." };
      return;
    }
    // What a crash in the middle of this turn would leave behind: the run's row as it is now.
    if (n === 1) [midTurn] = await f.db.select().from(schema.agentRuns);
    yield { type: "done", text: "Merge feito." };
  });
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(f, "@dev faz o merge do PR 42");
  await drainOutbox(f.db, handlers);
  const [approval] = await listApprovals(f.db, f.owner.id, f.org.id, { status: "pending" });
  await decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, approval?.id ?? "", {
    decision: "approve",
  });
  await drainOutbox(f.db, handlers);
  if (!midTurn) throw new Error("the second turn never ran");

  // The server died in that turn instead: the row as it was then, its beat minutes old.
  await f.db
    .update(schema.agentRuns)
    .set({ status: "running", transcript: midTurn.transcript, heartbeatAt: new Date(Date.now() - 10 * 60_000) })
    .where(eq(schema.agentRuns.id, midTurn.id));
  expect((await recoverStaleRuns({ db: f.db, pubsub: f.pubsub })).resumed).toEqual([midTurn.id]);
  await drainOutbox(f.db, handlers);
  expect(seen.length).toBe(3);
  expect(seen[2]?.trigger).toContain("cut off because the server restarted");
  expect(seen[2]?.trigger).toContain("github_merge_pr ok: acme/app#42");
  expect(seen[2]?.trigger).not.toContain("faz o merge do PR 42");
  expect(gh.executed).toHaveLength(1);
});

test("a turn its computer's return resumed, cut by a server shutdown, goes on at once on the next instance", async () => {
  f = await setup();
  const machineId = await computerAgent(f);
  let online = true;
  const { brain, seen } = scriptedComputerBrain((n) => {
    if (n === 0) {
      online = false;
      return [{ type: "error", code: "machine_offline", message: "The computer MacBook is offline.", retryable: true }];
    }
    if (n === 1) {
      // The server begins shutting down in the middle of the turn sent again: it is cut.
      void drainLocalRuns(0, { graceMs: 0 });
      return [{ type: "error", code: "brain_failed", message: "The turn was stopped.", retryable: true }];
    }
    return [{ type: "done", text: "Voltei." }];
  });
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id, { online }) },
  });
  await post(f, "@dev oi");
  await drainOutbox(f.db, handlers);
  const [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("waiting_input");

  // Back: its "back" job resumes the wait, and the shutdown hands that job back.
  online = true;
  await resumeRunsWaitingForMachine(f.db, machineId);
  await drainOutbox(f.db, handlers, { maxBatches: 1 });
  expect(seen.length).toBe(2);
  const back = (await f.db.select().from(schema.outbox)).find((j) => j.dedupeKey?.includes(":brain_back:"));
  // Its wait is over: handed back, it goes on with the run instead of finding it no longer waiting.
  expect(back).toMatchObject({ status: "pending", attempts: 0, payload: { runId: run?.id } });
  expect(back?.payload).not.toHaveProperty("wait");
  await drainOutbox(f.db, handlers);
  expect((await f.db.select().from(schema.agentRuns))[0]?.status).toBe("done");
  expect(seen.length).toBe(3);
  expect((await timeline(f)).at(-1)?.body).toBe("Voltei.");
});

test("a resumed computer turn is told what each cut-off call ran on: a command's first line, a file's path", async () => {
  f = await setup();
  const machineId = await computerAgent(f);
  let online = true;
  const { brain, seen } = scriptedComputerBrain(async function* (n) {
    if (n === 0) {
      online = false;
      yield {
        type: "tool_call",
        id: "b-1",
        name: "Bash",
        input: { command: "git push origin main\necho done" },
        executed: { content: "pushed" },
      };
      yield {
        type: "tool_call",
        id: "e-1",
        name: "Edit",
        input: { file_path: "src/app.ts" },
        executed: { content: "ok" },
      };
      yield { type: "error", code: "machine_offline", message: "The computer MacBook is offline.", retryable: true };
      return;
    }
    yield { type: "done", text: "Pronto." };
  });
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id, { online }) },
  });
  await post(f, "@dev publica");
  await drainOutbox(f.db, handlers);
  online = true;
  await resumeRunsWaitingForMachine(f.db, machineId);
  await drainOutbox(f.db, handlers);
  expect(seen.length).toBe(2);
  expect(seen[1]?.trigger).toContain("do not repeat: Bash (git push origin main), Edit (src/app.ts).");
});

test("drops caused by our own server stopping aren't the computer's: the turn resumes past the drop limit", async () => {
  f = await setup();
  await computerAgent(f);
  const { brain, seen } = scriptedComputerBrain((n) =>
    n <= MAX_COMPUTER_DROPS
      ? [
          {
            type: "error",
            code: "machine_offline",
            message: "The connection to the computer MacBook dropped while this ran.",
            retryable: true,
            serverStop: true,
          },
        ]
      : [{ type: "done", text: "Pronto." }],
  );
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(f, "@dev oi");
  await drainOutbox(f.db, handlers);
  const [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("done");
  // One more cut than the limit allows the computer itself, and still the same session to the end.
  expect(seen.length).toBe(MAX_COMPUTER_DROPS + 2);
  // Each turn sent again reads what cut it: our server, not the computer.
  expect(seen[1]?.trigger).toContain("cut off because the server restarted");
  expect(seen.at(-1)?.trigger).toContain("cut off because the server restarted");
  expect((await timeline(f)).at(-1)?.body).toBe("Pronto.");
  const drops = await f.db
    .select({ data: schema.agentRunSteps.data })
    .from(schema.agentRunSteps)
    .where(eq(schema.agentRunSteps.runId, run?.id ?? ""));
  expect(drops.filter((s) => s.data.reason === "brain_dropped" && s.data.serverStop === true)).toHaveLength(
    MAX_COMPUTER_DROPS + 1,
  );
});

test("a message to a run parked for its computer: looked at again now; resumes with it, or parks again quietly", async () => {
  f = await setup();
  const machineId = await computerAgent(f);
  await f.db.update(schema.providerCredentials).set({ revokedAt: new Date() });
  let online = false;
  const { brain, seen } = scriptedComputerBrain(() => [{ type: "done", text: "Oi! Aqui." }]);
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id, { online }) },
  });
  const events: { type: string; status?: string }[] = [];
  f.pubsub.subscribe(channelTopic(f.general.id), (e) => events.push(e as { type: string; status?: string }));
  const question = await post(f, "@dev oi");
  await drainOutbox(f.db, handlers);
  expect((await f.db.select().from(schema.agentRuns))[0]?.status).toBe("waiting_input");
  const reply = (body: string) =>
    postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body,
      threadId: question.id,
    });

  // Still away: one more look, no second note, and the run says it stopped (the "working" row goes).
  events.length = 0;
  await reply("oi?");
  await drainOutbox(f.db, handlers);
  let runs = await f.db.select().from(schema.agentRuns);
  expect(runs).toHaveLength(1);
  expect(runs[0]?.status).toBe("waiting_input");
  expect(runs[0]?.waitingMachineId).toBe(machineId);
  expect(events.some((e) => e.type === "run.finished" && e.status === "waiting_input")).toBe(true);
  expect(events.some((e) => e.type === "agent.idle")).toBe(true);
  let main = await timeline(f);
  expect(main.filter((m) => m.meta.bodyCode === "brain_unavailable")).toHaveLength(1);
  expect(seen.length).toBe(0);

  // Actually there (a "not available" that was wrong, no reconnect coming): the next message resumes it.
  online = true;
  await reply("oi!!");
  await drainOutbox(f.db, handlers);
  runs = await f.db.select().from(schema.agentRuns);
  expect(runs).toHaveLength(1);
  expect(runs[0]?.status).toBe("done");
  expect(seen.length).toBe(1);
  expect(seen[0]?.trigger).toContain("@dev oi");
  expect(seen[0]?.trigger).toContain("oi?");
  expect(seen[0]?.trigger).toContain("oi!!");
  main = await timeline(f);
  expect(main.at(-1)?.body).toBe("Oi! Aqui.");
});

test("the mission engine: one run per agent and notice; a resume answers the call waiting on that id", async () => {
  f = await setup();
  const engine = createMissionEngine({ db: f.db, pubsub: f.pubsub });
  const root = crypto.randomUUID();
  const start = {
    orgId: f.org.id,
    agentId: f.agent.id,
    channelId: f.general.id,
    threadRootId: root,
    triggerMessageId: root,
    hop: 0,
    trigger: "Plan it",
    brain: "model" as const,
    missionId: crypto.randomUUID(),
    requestedBy: null,
    kind: "system" as const,
  };
  const first = await f.db.transaction((tx) => engine.startRun(tx, start));
  expect(first?.steered).toBe(false);
  expect(await f.db.transaction((tx) => engine.startRun(tx, start))).toBeNull();
  expect((await f.db.select().from(schema.agentRuns)).length).toBe(1);

  // That run paused on a blocking decision (the tool returned `data.pause` with the decision's id).
  await f.db
    .update(schema.agentRuns)
    .set({
      status: "waiting_input",
      transcript: { pending: { calls: [{ toolUseId: "call-9", name: "ask_decision", waitId: "decision-1" }] } },
    })
    .where(eq(schema.agentRuns.id, first?.runId ?? ""));
  const identity = { orgId: f.org.id, agentId: f.agent.id, runId: first?.runId ?? "", machineId: "" };
  expect(
    await engine.resumeRun({ run: identity, pause: { kind: "input", id: "other" }, result: { content: "x" } }),
  ).toBeNull();
  expect(
    await engine.resumeRun({
      run: identity,
      pause: { kind: "input", id: "decision-1" },
      result: { content: "Decision: Tabs or drawer? → Tabs" },
    }),
  ).toEqual({ runId: first?.runId ?? "" });
  const [run] = await f.db.select().from(schema.agentRuns);
  expect(
    (run?.transcript as { pending?: { calls: { result?: unknown }[] } } | undefined)?.pending?.calls[0]?.result,
  ).toEqual({
    content: "Decision: Tabs or drawer? → Tabs",
    isError: false,
  });
  const jobs = await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, "agent_run.execute"));
  expect(jobs.some((j) => j.dedupeKey?.startsWith(`agent_run.execute:${run?.id}:wait:decision-1:`))).toBe(true);
  // Answered once: a second answer finds nothing waiting.
  expect(
    await engine.resumeRun({ run: identity, pause: { kind: "input", id: "decision-1" }, result: { content: "y" } }),
  ).toBeNull();
});

// ── Review fixes (PR #9) ─────────────────────────────────────────────────────

/** A run row that is running now, with the transcript the engine keeps (as before a computer turn). */
async function runningRun(fx: Fixture, trigger: { id: string }, threadRootId = trigger.id) {
  const [run] = await fx.db
    .insert(schema.agentRuns)
    .values({
      orgId: fx.org.id,
      agentId: fx.agent.id,
      channelId: fx.general.id,
      threadRootId,
      triggerMessageId: trigger.id,
      trigger: "mention",
      hop: 1,
      status: "running",
      startedAt: new Date(),
      transcript: { system: [], messages: [], postedUpTo: 0, postedCount: 0, deltaSeq: 0 },
    })
    .returning();
  if (!run) throw new Error("no run");
  return run;
}

/** Tools whose results carry side effects for the reply (`data`), like `react`, artifacts and memory tools. */
function effectTools(fx: () => Fixture) {
  const artifactId = crypto.randomUUID();
  const source: ToolSource = {
    name: "effects",
    tools: async () => [
      {
        name: "react_now",
        description: "React to the message",
        scope: "",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => ({ content: "Reacted.", data: { reacted: true } }),
      },
      {
        name: "save_note",
        description: "Save a note as a file and remember it",
        scope: "",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => ({
          content: "Saved.",
          data: {
            artifact: { id: artifactId, version: 1, title: "deploy.md" },
            memoryUpdate: {
              action: "remembered",
              itemId: "item-1",
              text: "Deploys happen on Fridays",
              requestedByUserId: fx().owner.id,
            },
          },
        }),
      },
      {
        name: "check_env",
        description: "Check the environment",
        scope: "",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => ({ content: "go: not found" }),
      },
    ],
  };
  return { source, artifactId };
}

test("a routine's run: a bridged gated call posts its card and events in the main timeline, like its replies", async () => {
  const gh = fakeGithub();
  f = await setup({ toolSources: [gh.source] });
  await grantScopes(f.db, f.org.id, f.agent.id, ALL_GITHUB_SCOPES);
  const machineId = await computerAgent(f);
  const call = await post(f, "Daily PR check");
  await f.db
    .update(schema.messages)
    .set({ meta: { routine: { id: crypto.randomUUID(), name: "Daily" } } })
    .where(eq(schema.messages.id, call.id));
  const run = await runningRun(f, call);
  expect(runWhere(run).threadId).toBeNull();
  const events = f.listen(f.general.id);

  const out = await invokeToolForRun(
    { db: f.db, pubsub: f.pubsub, tools: f.tools },
    { orgId: f.org.id, agentId: f.agent.id, runId: run.id, machineId },
    {
      id: "call-1",
      name: "github_merge_pr",
      input: { repo: "acme/app", pr: 1, why: "CI passed on the PR and it was reviewed: merging ships the fix." },
    },
  );
  expect(out.result.pause?.kind).toBe("approval");
  const card = (await f.db.select().from(schema.messages)).find((m) => typeof m.meta.approvalId === "string");
  expect(card?.threadId).toBeNull();
  const waiting = events.find((e) => e.type === "agent.run") as { threadId?: string | null; status?: string };
  expect(waiting).toMatchObject({ status: "waiting_approval", threadId: null });
  const chips = events.filter((e) => e.type === "agent.tool") as { threadId?: string | null }[];
  expect(chips.length).toBeGreaterThan(0);
  expect(chips.every((e) => e.threadId === null)).toBe(true);
});

/**
 * The computer's permission check, answering by the command: `rm` refused, `npm publish` waits on a person who
 * says no (`req-1`), `npm version` on one who says yes on the second time it is asked again (`req-2`).
 */
function permissionTool() {
  let polls = 0;
  const source: ToolSource = {
    name: "permission",
    tools: async () => [
      {
        name: "permission_prompt",
        description: "Claude Code's permission prompt",
        scope: "",
        inputSchema: { type: "object" },
        execute: async (input) => {
          const command = String((input.input as { command?: unknown } | undefined)?.command ?? "");
          const answer = (a: Record<string, unknown>) => ({ content: JSON.stringify(a) });
          if (input.request_id === "req-1")
            return answer({ behavior: "deny", message: "A person said no. Don't try it again.", code: "person" });
          if (input.request_id === "req-2")
            return answer(++polls < 2 ? { status: "pending", request_id: "req-2" } : { behavior: "allow" });
          if (command.startsWith("rm "))
            return answer({
              behavior: "deny",
              message:
                "This command was refused because it changes files outside the mission folder. Do it another way.",
              code: "outside",
            });
          if (command === "npm publish") return answer({ status: "pending", request_id: "req-1" });
          if (command === "npm version patch") return answer({ status: "pending", request_id: "req-2" });
          return answer({ behavior: "allow" });
        },
      },
    ],
  };
  return source;
}

/** Commands whose label could show what their whole command hides, and what it must never show. */
const LABEL_PROBES = [
  {
    command: 'curl -s https://api.example.com/v1/items -H "Authorization: Bearer abc123def456ghi789"',
    label: "curl api.example.com/v1/items",
    secret: "abc123def456ghi789",
  },
  {
    command: 'curl -sS https://api.example.com/v1 -H "X-Api-Key: 9f8e7d6c5b4a3210"',
    label: "curl api.example.com/v1",
    secret: "9f8e7d6c5b4a3210",
  },
  { command: "mysql -h db -u root --password hunter2", label: "mysql", secret: "hunter2" },
  { command: 'node -e "console.log(1)"', label: "node", secret: null },
  {
    command: "psql postgres://user:pass@host:5432/db -c 'select 1'",
    label: "psql postgres://***@host:5432/db",
    secret: "user:pass",
  },
  {
    command: "git clone https://x-token:s3cr3tvalue@github.com/acme/app.git",
    label: "git clone github.com/acme/app.git",
    secret: "s3cr3tvalue",
  },
];

test("a bridged permission check: its line says the command, opens on it masked, says why it was refused", async () => {
  f = await setup({ toolSources: [permissionTool()] });
  const machineId = await computerAgent(f);
  const run = await runningRun(f, await post(f, "Roda os testes"));
  const events = f.listen(f.general.id);
  const ask = (id: string, input: Record<string, unknown>) =>
    invokeToolForRun(
      { db: f.db, pubsub: f.pubsub, tools: f.tools },
      { orgId: f.org.id, agentId: f.agent.id, runId: run.id, machineId },
      { id, name: "permission_prompt", input },
    );
  const bash = (command: string, description?: string) => ({
    tool_name: "Bash",
    input: { command, ...(description ? { description } : {}) },
  });
  await ask("p1", bash("cd /w/app && npx jest src/a.test.ts --watch=false", "Rerun new unit tests after formatting"));
  await ask(
    "p2",
    bash('curl -s -H "Authorization: Bearer sk-ant-api03-abcdefghijklmnop" https://api.example.com/v1/items?token=abc'),
  );
  await ask("p3", bash("rm -rf /etc/agentes"));
  await ask("p4", bash("npm publish"));
  // The runner asking again about the one waiting on a person: no line of its own, the person's answer ends it.
  await ask("p5", { request_id: "req-1" });
  for (const [i, probe] of LABEL_PROBES.entries()) await ask(`q${i}`, bash(probe.command));

  const chips = events.filter((e) => e.type === "agent.tool") as Extract<ChannelEvent, { type: "agent.tool" }>[];
  const started = chips.filter((e) => e.tool !== null);
  expect(started.map((e) => [e.toolUseId, e.detail])).toEqual([
    ["p1", "Rerun new unit tests after formatting"],
    ["p2", "curl api.example.com/v1/items"],
    ["p3", "rm /etc/agentes"],
    ["p4", "npm publish"],
    ...LABEL_PROBES.map((p, i) => [`q${i}`, p.label]),
  ]);
  expect(started[0]?.command).toBe("cd /w/app && npx jest src/a.test.ts --watch=false");
  expect(started[1]?.command).toContain("curl -s -H");
  expect(started[1]?.command).not.toContain("sk-ant-api03");
  expect(started[1]?.command).not.toContain("token=abc");
  for (const [i, probe] of LABEL_PROBES.entries()) {
    const shown = started.find((e) => e.toolUseId === `q${i}`)?.command ?? "";
    expect(shown.split(" ")[0]).toBe(probe.command.split(" ")[0]);
    if (probe.secret) expect(shown).not.toContain(probe.secret);
  }
  const ends = chips.filter((e) => e.tool === null && e.toolUseId?.startsWith("p"));
  expect(ends.map((e) => [e.toolUseId, e.failed ?? false, e.held ?? false, e.refusal ?? null])).toEqual([
    ["p1", false, false, null],
    ["p2", false, false, null],
    ["p3", true, false, "outside"],
    ["p4", false, true, null],
  ]);
  expect(ends[2]?.why).toBe(
    "This command was refused because it changes files outside the mission folder. Do it another way.",
  );
  expect(ends[3]?.requestId).toBe("req-1");
  // The person's answer reaches the line that waited for it, by its request.
  const answered = chips.filter((e) => e.tool === null && !e.toolUseId);
  expect(answered).toMatchObject([{ requestId: "req-1", failed: true, refusal: "person" }]);
  // The steps keep the same label, and the command masked for the line's open view.
  const steps = await f.db.select().from(schema.agentRunSteps).where(eq(schema.agentRunSteps.runId, run.id));
  const call = (id: string) => steps.find((s) => s.kind === "tool_call" && s.data.toolUseId === id)?.data;
  expect(call("p2")).toMatchObject({ detail: "curl api.example.com/v1/items" });
  expect(call("p2")?.command).toBe(started[1]?.command);
  expect(call("p5")?.detail).toBeUndefined();
});

test("a reply's tool count leaves out the runner asking again about a command waiting on a person", async () => {
  f = await setup({ toolSources: [permissionTool()] });
  const machineId = await computerAgent(f);
  const { brain } = scriptedComputerBrain(async function* (_n, turn) {
    const id = { orgId: turn.orgId, agentId: turn.agentId, runId: turn.runId, machineId };
    const ask = (call: string, input: Record<string, unknown>) =>
      executeToolForRun(f.jobDeps, id, { id: call, name: "permission_prompt", input });
    await ask("v1", { tool_name: "Bash", input: { command: "npm version patch" } });
    await ask("v2", { request_id: "req-2" });
    await ask("v3", { request_id: "req-2" });
    yield { type: "done", text: "Versão nova." };
  });
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(f, "@dev sobe a versão");
  await drainOutbox(f.db, handlers);

  const reply = (await timeline(f)).at(-1);
  expect(reply?.body).toBe("Versão nova.");
  expect((reply?.meta.work as { steps?: number } | undefined)?.steps).toBe(1);
});

test("bridged side effects reach the engine: a bridged react ends the turn silently (no Done.)", async () => {
  const fx = effectTools(() => f);
  f = await setup({ toolSources: [fx.source] });
  const machineId = await computerAgent(f);
  const { brain } = scriptedComputerBrain(async function* (_n, turn) {
    const id = { orgId: turn.orgId, agentId: turn.agentId, runId: turn.runId, machineId };
    const result = await executeToolForRun(f.jobDeps, id, { id: "r-1", name: "react_now", input: {} });
    yield { type: "tool_call", id: "r-1", name: "react_now", input: {}, executed: result };
    yield { type: "done", text: "" };
  });
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(f, "@dev valeu!");
  await drainOutbox(f.db, handlers);

  const [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("done");
  const main = await timeline(f);
  expect(main.map((m) => m.body)).toEqual(["@dev valeu!"]);
  // Taken by the engine: nothing left over on the run.
  expect(JSON.stringify(run?.transcript)).not.toContain("bridgeEffects");
});

test("a bridged react followed by the emoji as text posts nothing (no 👍 message); a real reply still posts", async () => {
  const fx = effectTools(() => f);
  f = await setup({ toolSources: [fx.source] });
  const machineId = await computerAgent(f);
  const finals = ["👍", "Valeu! Qualquer coisa me chama."];
  const { brain } = scriptedComputerBrain(async function* (n, turn) {
    const id = { orgId: turn.orgId, agentId: turn.agentId, runId: turn.runId, machineId };
    const result = await executeToolForRun(f.jobDeps, id, { id: `r-${n}`, name: "react_now", input: {} });
    yield { type: "tool_call", id: `r-${n}`, name: "react_now", input: {}, executed: result };
    yield { type: "text_delta", text: finals[n] ?? "" };
    yield { type: "done", text: finals[n] ?? "" };
  });
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(f, "@dev valeu, perfeito!");
  await drainOutbox(f.db, handlers);
  expect((await timeline(f)).map((m) => m.body)).toEqual(["@dev valeu, perfeito!"]);
  await post(f, "@dev valeu, e o deploy?");
  await drainOutbox(f.db, handlers);
  expect((await timeline(f)).map((m) => m.body)).toEqual([
    "@dev valeu, perfeito!",
    "@dev valeu, e o deploy?",
    "Valeu! Qualquer coisa me chama.",
  ]);
});

test("a computer brain with the react tool is told to end with an empty reply after reacting", async () => {
  f = await setup({ react: true });
  await computerAgent(f);
  const systems: string[] = [];
  const brain: Brain = {
    kind: "claude_code",
    async *run(turn) {
      systems.push(turn.system);
      yield { type: "done", text: "Oi." };
    },
  };
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(f, "@dev oi");
  await drainOutbox(f.db, handlers);
  expect(systems[0]).toContain(COMPUTER_REACT_NOTE);
  expect(systems[0]).toContain("not even the emoji again");
});

test("a computer brain with the GIF and sticker tools is told an empty reply after one adds nothing", async () => {
  f = await setup({ mediaTools: true });
  await computerAgent(f);
  const systems: string[] = [];
  const brain: Brain = {
    kind: "claude_code",
    async *run(turn) {
      systems.push(turn.system);
      yield { type: "done", text: "Oi." };
    },
  };
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(f, "@dev oi");
  await drainOutbox(f.db, handlers);
  // No GIF search on this server: the note names only the sticker, and no reaction note without `react`.
  expect(systems[0]).toContain(computerMediaNote(["send_sticker"]));
  expect(systems[0]).not.toContain("`send_gif`");
  expect(systems[0]).not.toContain(COMPUTER_REACT_NOTE);
});

test("bridged side effects reach the engine: artifacts and memory cards on the reply, memory.updated published", async () => {
  const fx = effectTools(() => f);
  f = await setup({ toolSources: [fx.source] });
  const machineId = await computerAgent(f);
  const { brain } = scriptedComputerBrain(async function* (_n, turn) {
    const id = { orgId: turn.orgId, agentId: turn.agentId, runId: turn.runId, machineId };
    const result = await executeToolForRun(f.jobDeps, id, { id: "s-1", name: "save_note", input: {} });
    yield { type: "tool_call", id: "s-1", name: "save_note", input: {}, executed: result };
    yield { type: "done", text: "Anotado." };
  });
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  const events = f.listen(f.general.id);
  await post(f, "@dev anota que deploy é na sexta");
  await drainOutbox(f.db, handlers);

  const reply = (await f.db.select().from(schema.messages)).find((m) => m.body === "Anotado.");
  expect(reply?.threadId).toBeNull();
  expect(reply?.meta.artifacts).toEqual([{ id: fx.artifactId, version: 1, title: "deploy.md" }]);
  expect(reply?.meta.memoryUpdates).toMatchObject([{ action: "remembered", text: "Deploys happen on Fridays" }]);
  expect(events.some((e) => e.type === "memory.updated")).toBe(true);
});

test("a computer brain that fails after a bridged tool ran: no fallback, what it did is posted, nothing runs twice", async () => {
  let checks = 0;
  const env: ToolSource = {
    name: "env",
    tools: async () => [
      {
        name: "check_env",
        description: "Check the environment",
        scope: "",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => {
          checks++;
          return { content: "go: not found" };
        },
      },
    ],
  };
  f = await setup({ toolSources: [env], reply: () => ({ chunks: ["Respondi pela API."] }) });
  const machineId = await computerAgent(f);
  const { brain, seen } = scriptedComputerBrain(async function* (_n, turn) {
    const id = { orgId: turn.orgId, agentId: turn.agentId, runId: turn.runId, machineId };
    const result = await executeToolForRun(f.jobDeps, id, { id: "c-1", name: "check_env", input: {} });
    yield { type: "text_delta", text: "Verifiquei o ambiente." };
    yield { type: "tool_call", id: "c-1", name: "check_env", input: {}, executed: result };
    yield { type: "error", code: "executor_crashed", message: "Claude Code exited", retryable: true };
  });
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(f, "@dev tem Go aí?");
  await drainOutbox(f.db, handlers);

  expect(seen.length).toBe(1);
  expect(checks).toBe(1);
  const [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("done");
  // The model brain never redid the turn.
  const usage = await f.db
    .select()
    .from(schema.usageRecords)
    .where(eq(schema.usageRecords.runId, run?.id ?? ""));
  expect(usage.some((u) => u.provider === "anthropic")).toBe(false);
  const main = await timeline(f);
  const last = main.at(-1);
  expect(last?.body).toContain("Verifiquei o ambiente.");
  expect(last?.meta.brainInterrupted).toMatchObject({
    brain: "claude_code",
    code: "executor_crashed",
    text: "Verifiquei o ambiente.",
    tools: ["check_env"],
  });
  expect(last?.meta.brainFallback).toBeUndefined();
});

test("a computer brain that fails after a bridged pause: the run keeps waiting with its pending call, then resumes", async () => {
  const gh = fakeGithub();
  f = await setup({ toolSources: [gh.source], reply: () => ({ chunks: ["Respondi pela API."] }) });
  await grantScopes(f.db, f.org.id, f.agent.id, ALL_GITHUB_SCOPES);
  const machineId = await computerAgent(f);
  const { brain, seen } = scriptedComputerBrain(async function* (n, turn) {
    if (n === 0) {
      const id = { orgId: turn.orgId, agentId: turn.agentId, runId: turn.runId, machineId };
      const result = await executeToolForRun(f.jobDeps, id, {
        id: "call-1",
        name: "github_merge_pr",
        input: { repo: "acme/app", pr: 42, why: "CI passed on the PR and it was reviewed: merging ships the fix." },
      });
      yield { type: "tool_call", id: "call-1", name: "github_merge_pr", input: {}, executed: result };
      yield { type: "error", code: "executor_crashed", message: "Claude Code exited", retryable: true };
      return;
    }
    yield { type: "done", text: "Merge feito." };
  });
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(f, "@dev faz o merge do PR 42");
  await drainOutbox(f.db, handlers);

  let [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("waiting_approval");
  expect(run?.error).toBeNull();
  const transcript = run?.transcript as { pending?: { calls: { toolUseId: string; bridged?: boolean }[] } };
  expect(transcript.pending?.calls).toMatchObject([{ toolUseId: "call-1", bridged: true }]);
  const usage = await f.db
    .select()
    .from(schema.usageRecords)
    .where(eq(schema.usageRecords.runId, run?.id ?? ""));
  expect(usage.some((u) => u.provider === "anthropic")).toBe(false);

  const [approval] = await listApprovals(f.db, f.owner.id, f.org.id, { status: "pending" });
  await decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, approval?.id ?? "", {
    decision: "approve",
  });
  await drainOutbox(f.db, handlers);
  [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("done");
  expect(seen.length).toBe(2);
  expect(gh.executed).toEqual([{ tool: "github_merge_pr", input: { repo: "acme/app", pr: 42 } }]);
});

/** Its pending `agent_run.execute` jobs due now: their backoff and waits are over. */
const runJobsDue = (fx: Fixture) =>
  fx.db
    .update(schema.outbox)
    .set({ nextAttemptAt: new Date(Date.now() - 1000) })
    .where(and(eq(schema.outbox.kind, "agent_run.execute"), eq(schema.outbox.status, "pending")));

test("a CLI that refuses to start on its computer fails the run at once with what it said, never retried", async () => {
  f = await setup();
  await computerAgent(f, { brainFallback: false });
  // Grok Build 1.0.70 on a Linux computer without bubblewrap; the runner calls every Grok failure retryable.
  const said =
    "Grok Build exited with code 1: error: this sandbox could not enforce its deny list on Linux: bwrap exec failed: No such file or directory (os error 2). Install bubblewrap with `apt install -y bubblewrap`. Refusing to start with denied paths unprotected.";
  const { brain, seen } = scriptedComputerBrain(() => [
    { type: "error", code: "grok_failed", message: said, retryable: true },
  ]);
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(f, "@dev roda os testes");
  await drainOutbox(f.db, handlers);
  await runJobsDue(f);
  await drainOutbox(f.db, handlers);

  expect(seen.length).toBe(1);
  const [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("failed");
  expect(run?.error).toStartWith("cli_failed: Grok Build: this sandbox could not enforce its deny list on Linux");
  expect(run?.error).toContain("Install bubblewrap with `apt install -y bubblewrap`");
  const pending = (await f.db.select().from(schema.outbox)).filter(
    (j) => j.kind === "agent_run.execute" && j.status === "pending",
  );
  expect(pending).toEqual([]);
});

test("a failure that keeps coming back parks after its tries in a row, though waits for room hand it new jobs", async () => {
  f = await setup();
  await computerAgent(f, { brainFallback: false });
  let healed = false;
  // Every other turn the computer has no room: each wait for room goes on in a job of its own.
  const { brain, seen } = scriptedComputerBrain((n): BrainEvent[] => {
    if (healed) return [{ type: "done", text: "Testes passaram." }];
    if (n % 2 === 1) return [{ type: "error", code: "busy", message: "The computer is busy.", retryable: true }];
    return [
      {
        type: "error",
        code: "grok_failed",
        message: "Grok Build exited with code 1: error: connection reset by peer",
        retryable: true,
      },
    ];
  });
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  const runRow = async () => (await f.db.select().from(schema.agentRuns))[0];
  const stored = async () =>
    (await runRow())?.transcript as { outage?: { n: number }; failedTries?: number } | null | undefined;
  await post(f, "@dev roda os testes");
  await drainOutbox(f.db, handlers);
  for (let i = 0; i < 12 && !(await stored())?.outage; i++) {
    await runJobsDue(f);
    await drainOutbox(f.db, handlers);
  }

  // Four failures, three waits for room between them: parked on the outage ladder, its first wake 2 minutes away.
  expect(seen.length).toBe(2 * OUTAGE_PARK.tries - 1);
  expect((await runRow())?.status).toBe("waiting_input");
  expect((await stored())?.outage).toMatchObject({ n: 1 });
  const wake = (await f.db.select().from(schema.outbox)).find(
    (j) => j.status === "pending" && j.dedupeKey?.includes(":outage:"),
  );
  const inMinutes = ((wake?.nextAttemptAt.getTime() ?? 0) - Date.now()) / 60_000;
  expect(inMinutes).toBeGreaterThan(OUTAGE_PARK.ladderMinutes[0] - 0.5);
  expect(inMinutes).toBeLessThanOrEqual(OUTAGE_PARK.ladderMinutes[0]);
  // Its note names the CLI and what it said (the apps word it, `provider_wait_said`), never "can't answer right now".
  const notes = (await timeline(f)).filter((m) => m.author.type === "agent");
  expect(notes.map((m) => [m.meta.bodyCode, m.meta.bodyParams])).toEqual([
    ["provider_wait_said", { provider: "Grok Build", detail: "connection reset by peer" }],
  ]);

  // It passes: the wake answers, and the count starts over.
  healed = true;
  await runJobsDue(f);
  await drainOutbox(f.db, handlers);
  expect((await runRow())?.status).toBe("done");
  expect((await stored())?.failedTries).toBeUndefined();
  expect((await timeline(f)).at(-1)?.body).toBe("Testes passaram.");
});

test("a short line before a bridged approval is never posted: the card says it", async () => {
  const gh = fakeGithub();
  f = await setup({ toolSources: [gh.source] });
  await grantScopes(f.db, f.org.id, f.agent.id, ALL_GITHUB_SCOPES);
  const machineId = await computerAgent(f);
  const { brain } = scriptedComputerBrain(async function* (_n, turn) {
    yield { type: "text_delta", text: "Vou pedir a aprovação." };
    const id = { orgId: turn.orgId, agentId: turn.agentId, runId: turn.runId, machineId };
    await executeToolForRun(f.jobDeps, id, {
      id: "call-1",
      name: "github_merge_pr",
      input: { repo: "acme/app", pr: 42, why: "CI passed on the PR and it was reviewed: merging ships the fix." },
    });
    yield { type: "done", text: "Vou pedir a aprovação." };
  });
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(f, "@dev faz o merge do PR 42");
  await drainOutbox(f.db, handlers);

  expect((await f.db.select().from(schema.agentRuns))[0]?.status).toBe("waiting_approval");
  expect((await timeline(f)).some((m) => m.body.includes("Vou pedir"))).toBe(false);
});

test("a long line said before a bridged approval goes right after its card, below what came meanwhile", async () => {
  const gh = fakeGithub();
  f = await setup({ toolSources: [gh.source] });
  await grantScopes(f.db, f.org.id, f.agent.id, ALL_GITHUB_SCOPES);
  const machineId = await computerAgent(f);
  const said = `Revisei o PR 42: ${"os testes passaram e a revisão aprovou a troca da chave do cache. ".repeat(5)}Peço a aprovação do merge.`;
  const { brain } = scriptedComputerBrain(async function* (n, turn) {
    if (n > 0) {
      yield { type: "done", text: "Ok." };
      return;
    }
    yield { type: "text_delta", text: said };
    // Someone writes while it writes, before it asks.
    await Bun.sleep(5);
    await post(f, "manda ver");
    await Bun.sleep(5);
    const id = { orgId: turn.orgId, agentId: turn.agentId, runId: turn.runId, machineId };
    await executeToolForRun(f.jobDeps, id, {
      id: "call-1",
      name: "github_merge_pr",
      input: { repo: "acme/app", pr: 42, why: "CI passed on the PR and it was reviewed: merging ships the fix." },
    });
    yield { type: "done", text: said };
  });
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  const events = f.listen(f.general.id);
  await post(f, "@dev faz o merge do PR 42");
  await drainOutbox(f.db, handlers);

  expect(events.some((e) => e.type === "agent.typing")).toBe(true);
  const main = await timeline(f);
  const meanwhile = main.findIndex((m) => m.body === "manda ver");
  const card = main.findIndex((m) => typeof m.meta.approvalId === "string");
  const lead = main.findIndex((m) => m.body.startsWith("Revisei o PR 42"));
  expect(meanwhile).toBeGreaterThan(0);
  // The bridge posted the card when it asked: what the agent said reads right after it.
  expect(card).toBeGreaterThan(meanwhile);
  expect(lead).toBe(card + 1);
});

test("stopped between calls: the stopped reply keeps the stretch it was on, never the working text before a call", async () => {
  f = await setup();
  await computerAgent(f);
  const { brain } = scriptedComputerBrain(async function* (_n, turn) {
    yield { type: "text_delta", text: "I need the inbox id first." };
    yield { type: "tool_call", id: "c1", name: "Bash", input: {}, executed: { content: "ok" } };
    yield { type: "text_delta", text: "Resumo das lojas:" };
    await cancelRun({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, turn.runId);
    yield { type: "error", code: "executor_crashed", message: "stopped" };
  });
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(f, "@dev resume as lojas");
  await drainOutbox(f.db, handlers);

  expect((await f.db.select().from(schema.agentRuns))[0]?.status).toBe("canceled");
  expect((await timeline(f)).at(-1)?.body).toBe("Resumo das lojas:\n\n_Stopped by ana._");
});

test("two gated bridged calls in one turn both wait; a gated call for a run that isn't running posts nothing", async () => {
  const gh = fakeGithub();
  f = await setup({ toolSources: [gh.source] });
  await grantScopes(f.db, f.org.id, f.agent.id, ALL_GITHUB_SCOPES);
  const machineId = await computerAgent(f);
  // No mention: the run row below is the only one for this message.
  const question = await post(f, "merge os dois");
  const run = await runningRun(f, question);
  const deps = { db: f.db, pubsub: f.pubsub, tools: f.tools };
  const id = { orgId: f.org.id, agentId: f.agent.id, runId: run.id, machineId };
  const [first, second] = await Promise.all([
    invokeToolForRun(deps, id, {
      id: "m-1",
      name: "github_merge_pr",
      input: { repo: "acme/app", pr: 1, why: "CI passed on the PR and it was reviewed: merging ships the fix." },
    }),
    invokeToolForRun(deps, id, {
      id: "m-2",
      name: "github_merge_pr",
      input: { repo: "acme/app", pr: 2, why: "CI passed on the PR and it was reviewed: merging ships the fix." },
    }),
  ]);
  expect(first.result.pause?.kind).toBe("approval");
  expect(second.result.pause?.kind).toBe("approval");
  const [after] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.id));
  expect(after?.status).toBe("waiting_approval");
  const pending =
    (after?.transcript as { pending?: { calls: { toolUseId: string }[] } } | undefined)?.pending?.calls ?? [];
  expect(pending.map((c) => c.toolUseId).sort()).toEqual(["m-1", "m-2"]);
  // Both requests share one card, each its own row.
  const cards = (await f.db.select().from(schema.messages)).filter((m) => typeof m.meta.approvalId === "string");
  expect(cards.length).toBe(1);
  const asked = await f.db.select().from(schema.approvals).where(eq(schema.approvals.runId, run.id));
  expect(asked.map((a) => a.messageId)).toEqual([cards[0]?.id ?? "", cards[0]?.id ?? ""]);

  // The run ended: the gated call is refused before anything is posted, and its request canceled.
  await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, run.id));
  const late = await invokeToolForRun(deps, id, {
    id: "m-3",
    name: "github_merge_pr",
    input: { repo: "acme/app", pr: 3, why: "CI passed on the PR and it was reviewed: merging ships the fix." },
  });
  expect(late).toMatchObject({ code: "bridge.run_not_running", result: { isError: true } });
  expect(late.result.pause).toBeUndefined();
  const all = (await f.db.select().from(schema.messages)).filter((m) => typeof m.meta.approvalId === "string");
  expect(all.length).toBe(1);
  const [third] = await f.db.select().from(schema.approvals).where(eq(schema.approvals.toolUseId, "m-3"));
  expect(third?.status).toBe("canceled");
  expect(gh.executed).toEqual([]);
});

test("one 'computer away' note per outage and place: later messages there join the waiting run; another channel gets its own", async () => {
  f = await setup();
  const machineId = await computerAgent(f);
  await f.db.update(schema.providerCredentials).set({ revokedAt: new Date() });
  const { brain } = scriptedComputerBrain(() => [{ type: "done", text: "Voltei." }]);
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id, { online: false }) },
  });
  // A message in the main timeline; a routine's call when `routine` (like an hourly routine).
  const call = async (channelId: string, routine = false) => {
    const m = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, channelId, {
      body: "@dev check",
    });
    if (routine)
      await f.db
        .update(schema.messages)
        .set({ meta: { routine: { id: crypto.randomUUID(), name: "Hourly" } } })
        .where(eq(schema.messages.id, m.id));
    await drainOutbox(f.db, handlers);
    return m;
  };
  const notices = async () =>
    (await f.db.select().from(schema.messages)).filter((m) => m.meta.bodyCode === "brain_unavailable");

  // A routine's run waits without a note (a computer that naps and wakes would post one every run).
  await call(f.general.id, true);
  let runs = await f.db.select().from(schema.agentRuns);
  expect(runs.map((r) => r.status)).toEqual(["waiting_input"]);
  expect(await notices()).toHaveLength(0);

  // People write there: their messages join that run (one turn when the computer is back), and they hear it once.
  await call(f.general.id);
  await call(f.general.id);
  runs = await f.db.select().from(schema.agentRuns);
  expect(runs.map((r) => r.status)).toEqual(["waiting_input"]);
  expect(runs[0]?.waitingMachineId).toBe(machineId);
  expect(await notices()).toHaveLength(1);

  // Another channel: its people didn't see the note, so it is said there once.
  const other = await createChannel(f.db, f.owner.id, f.org.id, { name: "tech" });
  await addChannelMember(f.db, f.owner.id, f.org.id, other.id, { agentId: f.agent.id });
  await call(other.id);
  // The conversation list's last line carries the note's code (the app says it in the reader's language).
  const tech = (await listChannels(f.db, f.owner.id, f.org.id)).find((c) => c.id === other.id);
  expect(tech?.lastMessage?.meta).toMatchObject({
    bodyCode: "brain_unavailable",
    bodyParams: { brain: "Claude Code" },
  });
  await call(other.id);
  const all = await notices();
  expect(all).toHaveLength(2);
  expect(all.filter((m) => m.channelId === other.id)).toHaveLength(1);

  // All of them still wait and come back together.
  runs = await f.db.select().from(schema.agentRuns);
  expect(runs.filter((r) => r.status === "waiting_input")).toHaveLength(2);
  expect((await resumeRunsWaitingForMachine(f.db, machineId)).length).toBe(2);
});

test("waiting for its computer isn't working: left out of 'working now' and a thread's working flag", async () => {
  f = await setup();
  await computerAgent(f);
  await f.db.update(schema.providerCredentials).set({ revokedAt: new Date() });
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => scriptedComputerBrain(() => []).brain },
    machines: { status: async (id) => statusOf(id, { online: false }) },
  });
  // Asked in a thread, so the run (and its note) live there.
  const root = await post(f, "deploy de hoje");
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev oi",
    threadId: root.id,
  });
  await drainOutbox(f.db, handlers);
  const [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("waiting_input");
  expect(await listWorkingRuns(f.db, f.owner.id, f.org.id)).toEqual([]);
  const threads = await listThreads(f.db, f.owner.id, { orgId: f.org.id });
  const thread = threads.threads.find((t) => t.id === root.id);
  expect(thread?.working).toBe(false);
  // The list's last line says it in the reader's language: the note's code comes with it.
  expect(thread?.lastMessage?.meta).toMatchObject({
    bodyCode: "brain_unavailable",
    bodyParams: { brain: "Claude Code" },
  });
});

test("no room on the computer: nothing in the chat, the person's message says it is in line, it asks again quietly without spending the job's tries, and answers once there is room", async () => {
  f = await setup();
  const machineId = await computerAgent(f);
  // No key the API could answer with: nothing can stand in.
  await f.db.update(schema.providerCredentials).set({ revokedAt: new Date() });
  const busy: BrainEvent = { type: "error", code: "busy", message: "The computer is busy.", retryable: true };
  const { brain, seen } = scriptedComputerBrain((n) => (n < 2 ? [busy] : [{ type: "done", text: "Pronto." }]));
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  const events: { type: string; status?: string; computer?: string }[] = [];
  f.pubsub.subscribe(channelTopic(f.general.id), (e) => events.push(e as { type: string; status?: string }));
  const asked = await post(f, "@dev oi");
  await drainOutbox(f.db, handlers);

  let [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("waiting_input");
  expect(run?.waitingMachineId).toBe(machineId);
  const notes = async () =>
    (await f.db.select().from(schema.messages)).filter((m) => m.meta.bodyCode === "brain_unavailable");
  // Waiting for room is a live state on the person's message, never a line in the chat.
  expect(await notes()).toEqual([]);
  expect(events.find((e) => e.type === "agent.run" && e.status === "waiting_input")?.computer).toBe("queued");
  expect(events.find((e) => e.type === "message.handled")?.computer).toBe("queued");
  const [listed] = (await timeline(f)).filter((m) => m.id === asked.id);
  expect(listed?.receipts?.handled).toMatchObject([
    { agentId: f.agent.id, status: "waiting_input", computer: "queued" },
  ]);
  // The run's own job ended with its first try; the next look is a job of its own, a few seconds later.
  const jobs = await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, "agent_run.execute"));
  expect(jobs.find((j) => j.dedupeKey === `agent_run.execute:${run?.id}`)).toMatchObject({
    status: "done",
    attempts: 1,
  });
  const retry = jobs.find((j) => j.dedupeKey?.includes(":room:"));
  expect(retry?.status).toBe("pending");
  expect((retry?.nextAttemptAt.getTime() ?? 0) - Date.now()).toBeGreaterThan(COMPUTER_BUSY_RETRY_MS - 5_000);

  // Still full: it waits on, saying nothing more and never flashing "thinking" in the conversation.
  events.length = 0;
  const once = { now: new Date(Date.now() + COMPUTER_BUSY_RETRY_MS + 1_000), maxBatches: 1 };
  await drainOutbox(f.db, handlers, once);
  [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("waiting_input");
  expect(seen.length).toBe(2);
  expect(await notes()).toEqual([]);
  expect(events.filter((e) => e.type === "agent.thinking" || e.status === "running")).toEqual([]);
  const steps = await f.db
    .select()
    .from(schema.agentRunSteps)
    .where(eq(schema.agentRunSteps.runId, run?.id ?? ""));
  expect(steps.filter((s) => s.data.reason === "brain_unavailable")).toHaveLength(1);

  // Room: the turn runs and the answer comes.
  await drainOutbox(f.db, handlers, { now: new Date(Date.now() + 2 * COMPUTER_BUSY_RETRY_MS + 2_000) });
  [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("done");
  expect(seen.length).toBe(3);
  expect((await timeline(f)).at(-1)?.body).toBe("Pronto.");
  expect(run?.transcript).not.toHaveProperty("roomWaitSince");
  // The wait ended when the computer took the turn: a step the operator's analytics end it at.
  const after = await f.db
    .select()
    .from(schema.agentRunSteps)
    .where(eq(schema.agentRunSteps.runId, run?.id ?? ""));
  expect(after.filter((s) => s.data.roomFound === true)).toHaveLength(1);
});

test("no room for over 30 minutes: the run never fails, it keeps its place and asks again (long work wakes through turns)", async () => {
  f = await setup();
  await computerAgent(f);
  await f.db.update(schema.providerCredentials).set({ revokedAt: new Date() });
  const { brain, seen } = scriptedComputerBrain(() => [
    { type: "error", code: "busy", message: "The computer is busy.", retryable: true },
  ]);
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(f, "@dev oi");
  await drainOutbox(f.db, handlers);
  let [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("waiting_input");

  const t = run?.transcript as { roomWaitSince?: number };
  const since = Date.now() - 31 * 60_000;
  await f.db
    .update(schema.agentRuns)
    .set({ transcript: { ...t, roomWaitSince: since } })
    .where(eq(schema.agentRuns.id, run?.id ?? ""));
  // Exactly when its look is due: the look it queues next is due 15 s after it ran, later than this.
  const due = (await f.db.select().from(schema.outbox))
    .filter((j) => j.kind === "agent_run.execute" && j.status === "pending")
    .reduce((max, j) => Math.max(max, j.nextAttemptAt.getTime()), 0);
  await drainOutbox(f.db, handlers, { now: new Date(due) });

  [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("waiting_input");
  expect(run?.error).toBeNull();
  expect((run?.transcript as { roomWaitSince?: number } | undefined)?.roomWaitSince).toBe(since);
  expect(seen.length).toBe(2);
  const pending = (await f.db.select().from(schema.outbox)).filter(
    (j) => j.kind === "agent_run.execute" && j.status === "pending",
  );
  expect(pending.length).toBe(1);
});

test("no room on the computer and a model key: the model brain answers, as for any computer that can't", async () => {
  f = await setup({ reply: () => ({ chunks: ["Respondi pela API."] }) });
  await computerAgent(f);
  const { brain } = scriptedComputerBrain(() => [
    { type: "error", code: "busy", message: "The computer is busy.", retryable: true },
  ]);
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(f, "@dev oi");
  await drainOutbox(f.db, handlers);
  const [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("done");
  const last = (await timeline(f)).at(-1);
  expect(last?.body).toBe("Respondi pela API.");
  expect(last?.meta).toMatchObject({ brainFallback: { from: "claude_code", code: "busy" } });
});

/** Sets when a run started waiting for room (ms). */
async function roomSince(fx: Fixture, runId: string, since: number) {
  const [row] = await fx.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId));
  await fx.db
    .update(schema.agentRuns)
    .set({ transcript: { ...row?.transcript, roomWaitSince: since } })
    .where(eq(schema.agentRuns.id, runId));
}

/** Another agent's turn went to this computer a moment ago (still running). */
async function askedJustNow(fx: Fixture, machineId: string) {
  const id = Bun.randomUUIDv7();
  await fx.db.insert(schema.agentRuns).values({
    orgId: fx.org.id,
    agentId: fx.agent.id,
    channelId: fx.general.id,
    threadRootId: id,
    triggerMessageId: id,
    trigger: "mention",
    hop: 2,
    status: "running",
    heartbeatAt: new Date(),
    transcript: { roomAsk: { machineId, at: Date.now() } },
  });
}

const personMessage = (fx: Fixture, body: string, threadId?: string) =>
  insertMessage(fx.db, {
    orgId: fx.org.id,
    channelId: fx.general.id,
    ...(threadId ? { threadId } : {}),
    author: { type: "person", userId: fx.owner.id },
    body,
  });

const runById = async (fx: Fixture, id: string) =>
  (await fx.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, id)))[0];

/** Each `computer.queue` broadcast, with the line as an app that refetched on it read it. */
function queueReads(fx: Fixture) {
  const reads: Promise<Awaited<ReturnType<typeof computerQueue>>>[] = [];
  fx.pubsub.subscribe(orgTopic(fx.org.id), (e) => {
    const event = (e as { event?: { type?: string; machineId?: string } }).event;
    if (event?.type === "computer.queue" && event.machineId)
      reads.push(computerQueue(fx.db, fx.owner.id, fx.org.id, event.machineId));
  });
  return reads;
}

test("the line is told only when it changes: admitted once its ask is saved, a refused re-ask says nothing", async () => {
  f = await setup();
  const machineId = await computerAgent(f);
  await f.db.update(schema.providerCredentials).set({ revokedAt: new Date() });
  let room = false;
  const reads = queueReads(f);
  // Each turn waits for the reads its events started: what an app refetching at once would see.
  const { brain } = scriptedComputerBrain(async function* (): AsyncGenerator<BrainEvent> {
    await Promise.all(reads);
    if (!room) {
      yield { type: "error", code: "busy", message: "The computer is busy.", retryable: true };
      return;
    }
    yield { type: "text_delta", text: "Pronto." };
    await Bun.sleep(0);
    await Promise.all(reads);
    yield { type: "done", text: "Pronto." };
  });
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(f, "@dev oi");
  await drainOutbox(f.db, handlers);
  const [run] = await f.db.select().from(schema.agentRuns);
  const id = run?.id ?? "";
  // Admitted, then refused: it joined the line (one event, read after its ask was saved: working).
  expect((await Promise.all(reads)).map((q) => [q.working.map((w) => w.runId), q.waiting.map((w) => w.runId)])).toEqual(
    [
      [[id], []],
      [[], [id]],
    ],
  );

  // The head asks again and is refused again: nothing changed, nothing is sent.
  await drainOutbox(f.db, handlers, { now: new Date(Date.now() + COMPUTER_BUSY_RETRY_MS + 1_000) });
  expect(reads).toHaveLength(2);

  // Room at last: told when its turn is taken, and again when the run is done.
  room = true;
  await drainOutbox(f.db, handlers, { now: new Date(Date.now() + 2 * COMPUTER_BUSY_RETRY_MS + 2_000) });
  const all = await Promise.all(reads);
  expect(all[2]?.working.map((w) => w.runId)).toEqual([id]);
  expect(all.at(-1)).toMatchObject({ machineId, working: [], waiting: [] });
});

test("a run asking again from the line stays in it for everyone reading, until the computer takes its turn", async () => {
  f = await setup();
  const machineId = await computerAgent(f);
  await f.db.update(schema.providerCredentials).set({ revokedAt: new Date() });
  let room = false;
  const reads: { waiting: string[]; working: string[]; handled: unknown; active: string[] }[] = [];
  let asked = "";
  const look = async () => {
    const line = await computerQueue(f.db, f.owner.id, f.org.id, machineId);
    const listed = (await timeline(f)).find((m) => m.id === asked);
    reads.push({
      waiting: line.waiting.map((w) => w.runId),
      working: line.working.map((w) => w.runId),
      handled: listed?.receipts?.handled.map((h) => [h.status, h.computer]),
      active: (await activeRunsIn(f.db, f.org.id, f.general.id)).map((r) => r.status),
    });
  };
  const { brain } = scriptedComputerBrain(async function* (n): AsyncGenerator<BrainEvent> {
    if (n > 0) await look();
    if (!room) {
      yield { type: "error", code: "busy", message: "The computer is busy.", retryable: true };
      return;
    }
    yield { type: "text_delta", text: "Pronto." };
    await Bun.sleep(0);
    await Bun.sleep(0);
    await look();
    yield { type: "done", text: "Pronto." };
  });
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  const events: { type: string; status?: string }[] = [];
  f.pubsub.subscribe(channelTopic(f.general.id), (e) => events.push(e as { type: string; status?: string }));
  asked = (await post(f, "@dev oi")).id;
  await drainOutbox(f.db, handlers);
  const [run] = await f.db.select().from(schema.agentRuns);
  const id = run?.id ?? "";

  // The head asks again: every read made during the ask finds it where it was, waiting in line.
  await drainOutbox(f.db, handlers, { now: new Date(Date.now() + COMPUTER_BUSY_RETRY_MS + 1_000), maxBatches: 1 });
  expect(reads).toEqual([
    { waiting: [id], working: [], handled: [["waiting_input", "queued"]], active: ["waiting_input"] },
  ]);
  const [after] = await f.db.select().from(schema.agentRuns);
  expect(after?.waitingMachineId).toBe(machineId);

  // The computer takes the turn: it left the line, and the conversation hears it works before any word of it.
  room = true;
  reads.length = 0;
  events.length = 0;
  await drainOutbox(f.db, handlers, { now: new Date(Date.now() + 2 * COMPUTER_BUSY_RETRY_MS + 2_000) });
  // The ask itself, then the read inside the turn.
  expect(reads).toEqual([
    { waiting: [id], working: [], handled: [["waiting_input", "queued"]], active: ["waiting_input"] },
    { waiting: [], working: [id], handled: [["running", undefined]], active: ["running"] },
  ]);
  const seenTypes = events.map((e) => e.type);
  expect(seenTypes.indexOf("agent.thinking")).toBeGreaterThanOrEqual(0);
  expect(seenTypes.indexOf("agent.thinking")).toBeLessThan(seenTypes.indexOf("agent.typing"));
  expect(seenTypes).toContain("message.claimed");
});

test("the Task Manager and a consultation read an ask from the line as the wait it is", async () => {
  f = await setup();
  const machineId = await computerAgent(f);
  await f.db.update(schema.providerCredentials).set({ revokedAt: new Date() });
  const reads: unknown[] = [];
  const { brain } = scriptedComputerBrain(async function* (n): AsyncGenerator<BrainEvent> {
    if (n > 0) {
      const view = await taskManager(f.db, f.owner.id, f.org.id);
      const [run] = await f.db.select().from(schema.agentRuns);
      const consult = run && consultationWait(run);
      reads.push({ task: view.tasks.map((t) => [t.status, t.held]), computers: view.computers, consult });
    }
    yield { type: "error", code: "busy", message: "The computer is busy.", retryable: true };
  });
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(f, "@dev oi");
  await drainOutbox(f.db, handlers);
  await drainOutbox(f.db, handlers, { now: new Date(Date.now() + COMPUTER_BUSY_RETRY_MS + 1_000), maxBatches: 1 });
  expect(reads).toEqual([
    {
      task: [["waiting_input", "computer_busy"]],
      computers: [{ id: machineId, name: "MacBook", working: 0, inLine: 1 }],
      consult: "computer",
    },
  ]);
});

test("an ask cut off by a restart: its new job asks again, and a turn taken shows it working to everyone", async () => {
  f = await setup();
  const machineId = await computerAgent(f);
  await f.db.update(schema.providerCredentials).set({ revokedAt: new Date() });
  const reads: { waiting: string[]; working: string[]; handled: unknown; active: string[]; machine: unknown }[] = [];
  let asked = "";
  const { brain } = scriptedComputerBrain(async function* (n): AsyncGenerator<BrainEvent> {
    if (n === 0) {
      yield { type: "error", code: "busy", message: "The computer is busy.", retryable: true };
      return;
    }
    yield { type: "text_delta", text: "Pronto." };
    await Bun.sleep(0);
    await Bun.sleep(0);
    const line = await computerQueue(f.db, f.owner.id, f.org.id, machineId);
    const [row] = await f.db.select().from(schema.agentRuns);
    reads.push({
      waiting: line.waiting.map((w) => w.runId),
      working: line.working.map((w) => w.runId),
      handled: (await timeline(f)).find((m) => m.id === asked)?.receipts?.handled.map((h) => h.status),
      active: (await activeRunsIn(f.db, f.org.id, f.general.id)).map((r) => r.status),
      machine: row?.waitingMachineId,
    });
    yield { type: "done", text: "Pronto." };
  });
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  asked = (await post(f, "@dev oi")).id;
  await drainOutbox(f.db, handlers);
  const [run] = await f.db.select().from(schema.agentRuns);
  const id = run?.id ?? "";

  // The worker died asking: `running`, its machine kept, its beat old, and its wait's job gone with it.
  const long = new Date(Date.now() - 3_600_000);
  await f.db.delete(schema.outbox).where(eq(schema.outbox.kind, "agent_run.execute"));
  await f.db.update(schema.agentRuns).set({ status: "running", heartbeatAt: long }).where(eq(schema.agentRuns.id, id));
  expect((await recoverStaleRuns({ db: f.db, pubsub: f.pubsub })).resumed).toEqual([id]);
  await drainOutbox(f.db, handlers);
  expect(reads).toEqual([{ waiting: [], working: [id], handled: ["running"], active: ["running"], machine: null }]);
});

test("a run that waited in line counts its work from the turn it got, not from the wait", async () => {
  f = await setup();
  const machineId = await computerAgent(f);
  await f.db.update(schema.providerCredentials).set({ revokedAt: new Date() });
  let room = false;
  const notes: unknown[] = [];
  const heard: string[] = [];
  const { brain } = scriptedComputerBrain(async function* (): AsyncGenerator<BrainEvent> {
    if (!room) {
      yield { type: "error", code: "busy", message: "The computer is busy.", retryable: true };
      return;
    }
    yield { type: "text_delta", text: "Pronto." };
    await Bun.sleep(0);
    await Bun.sleep(0);
    const [row] = await f.db.select().from(schema.agentRuns);
    notes.push((await statusReply(f.db, row as NonNullable<typeof row>, new Date())).meta.bodyParams.minutes);
    notes.push(
      Date.now() - Date.parse((await activeRunsIn(f.db, f.org.id, f.general.id))[0]?.startedAt ?? "") < 60_000,
    );
    notes.push(heard.filter((type) => type === "agent.status").length);
    yield { type: "done", text: "Pronto." };
  });
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(f, "@dev oi");
  await drainOutbox(f.db, handlers);
  await f.db.update(schema.agentRuns).set({ startedAt: new Date(Date.now() - 11 * 60_000) });
  expect((await computerQueue(f.db, f.owner.id, f.org.id, machineId)).waiting).toHaveLength(1);
  room = true;
  f.pubsub.subscribe(orgTopic(f.org.id), (e) => {
    const event = (e as { event?: { type?: string } }).event;
    if (event?.type) heard.push(event.type);
  });
  await drainOutbox(f.db, handlers, { now: new Date(Date.now() + COMPUTER_BUSY_RETRY_MS + 1_000) });
  // Once as the ask starts, once as the computer takes the turn.
  expect(notes).toEqual(["1", true, 2]);
});

test("a person's message during the ask joins the wait: its receipt says the line, as a reload would", async () => {
  f = await setup();
  const machineId = await computerAgent(f);
  await f.db.update(schema.providerCredentials).set({ revokedAt: new Date() });
  const busy: BrainEvent = { type: "error", code: "busy", message: "The computer is busy.", retryable: true };
  const events: { type: string; computer?: string; messageId?: string }[] = [];
  f.pubsub.subscribe(channelTopic(f.general.id), (e) => events.push(e as (typeof events)[number]));
  let second = "";
  const { brain } = scriptedComputerBrain(async function* (n): AsyncGenerator<BrainEvent> {
    if (n === 1) {
      const [run] = await f.db.select().from(schema.agentRuns);
      const message = await personMessage(f, "?");
      second = message.id;
      await queueOnRun(f.db, run?.id ?? "", message.id);
      await afterSteered(
        { db: f.db, pubsub: f.pubsub },
        {
          orgId: f.org.id,
          userId: f.owner.id,
          channelId: f.general.id,
          message,
          runIds: [run?.id ?? ""],
          now: false,
        },
      );
    }
    yield busy;
  });
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(f, "@dev oi");
  await drainOutbox(f.db, handlers);
  await drainOutbox(f.db, handlers, { now: new Date(Date.now() + COMPUTER_BUSY_RETRY_MS + 1_000), maxBatches: 1 });
  expect(second).not.toBe("");
  expect(events.find((e) => e.type === "agent.run.steered" && e.messageId === second)?.computer).toBe("queued");
  const [after] = await f.db.select().from(schema.agentRuns);
  expect(after?.waitingMachineId).toBe(machineId);
});

test("still in line after ten minutes: one note in the agent's words, and no other from it there", async () => {
  f = await setup();
  await computerAgent(f);
  await f.db.update(schema.providerCredentials).set({ revokedAt: new Date() });
  const { brain } = scriptedComputerBrain(() => [
    { type: "error", code: "busy", message: "The computer is busy.", retryable: true },
  ]);
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(f, "@dev oi");
  await drainOutbox(f.db, handlers);
  const [first] = await f.db.select().from(schema.agentRuns);
  if (!first) throw new Error("no run");
  const longAgo = Date.now() - COMPUTER_QUEUE_NOTE_MS - 1_000;
  await roomSince(f, first.id, longAgo);
  await drainOutbox(f.db, handlers, { now: new Date(Date.now() + COMPUTER_BUSY_RETRY_MS + 1_000) });
  const notes = async () =>
    (await f.db.select().from(schema.messages)).filter((m) => m.meta.bodyCode === "brain_unavailable");
  expect((await notes()).map((m) => [m.body, m.meta.brainUnavailable])).toMatchObject([
    ["Still in line for the computer. I'll answer as soon as it has room.", { code: "busy", long: true }],
  ]);

  // A second run of the agent there, first in line by now: it asks, finds no room, and says nothing more.
  const second = await secondRun(f, (await personMessage(f, "e aí?")).id);
  await drainOutbox(f.db, handlers);
  await roomSince(f, second.id, longAgo - 1_000);
  await drainOutbox(f.db, handlers, { now: new Date(Date.now() + COMPUTER_BUSY_RETRY_MS + 1_000) });
  expect((await runById(f, second.id))?.status).toBe("waiting_input");
  expect(await notes()).toHaveLength(1);
});

test("a deploy drops the computer for seconds: runs in line keep their place, and nobody hears about it", async () => {
  f = await setup();
  const machineId = await computerAgent(f);
  await f.db.update(schema.providerCredentials).set({ revokedAt: new Date() });
  let online = true;
  let lastSeenAt: string | null = null;
  const { brain } = scriptedComputerBrain(() => [
    { type: "error", code: "busy", message: "The computer is busy.", retryable: true },
  ]);
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id, { online, lastSeenAt }) },
  });
  await post(f, "@dev oi");
  await drainOutbox(f.db, handlers);
  const [run] = await f.db.select().from(schema.agentRuns);
  if (!run) throw new Error("no run");
  const since = (run.transcript as { roomWaitSince?: number }).roomWaitSince;
  expect(typeof since).toBe("number");

  online = false;
  lastSeenAt = new Date(Date.now() - 5_000).toISOString();
  await drainOutbox(f.db, handlers, { now: new Date(Date.now() + COMPUTER_BUSY_RETRY_MS + 1_000) });
  let t = (await runById(f, run.id))?.transcript as {
    roomWaitSince?: number;
    waitingForBrain?: { code: string; quiet?: boolean };
  };
  expect(t.waitingForBrain).toMatchObject({ code: "machine_offline", quiet: true });
  expect(t.roomWaitSince).toBe(since);

  online = true;
  await resumeRunsWaitingForMachine(f.db, machineId);
  await drainOutbox(f.db, handlers);
  t = (await runById(f, run.id))?.transcript as typeof t;
  expect(t.waitingForBrain?.code).toBe("busy");
  expect(t.roomWaitSince).toBe(since);
  expect((await timeline(f)).filter((m) => m.meta.bodyCode === "brain_unavailable")).toEqual([]);
});

test("agents' turns on one computer start apart, parked in line (never handed to the API); a person's goes at once", async () => {
  f = await setup({ reply: () => ({ chunks: ["Pela API."] }) });
  const machineId = await computerAgent(f);
  const { brain, seen } = scriptedComputerBrain(() => [{ type: "done", text: "Pronto." }]);
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await askedJustNow(f, machineId);
  const fromAgents = await secondRun(f, (await personMessage(f, "@dev revisa")).id, 2);
  await drainOutbox(f.db, handlers);
  const parked = await runById(f, fromAgents.id);
  expect(parked?.status).toBe("waiting_input");
  expect(parked?.transcript).toMatchObject({ waitingForBrain: { code: "busy" } });
  expect(parked?.transcript).not.toHaveProperty("fallback");
  expect(seen).toHaveLength(0);
  expect((await timeline(f)).filter((m) => m.meta.bodyCode === "brain_unavailable")).toEqual([]);

  // A person asks in a thread: no spacing for them, and when that turn ends the next in line is asked.
  const root = await personMessage(f, "sobre o deploy");
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev responde",
    threadId: root.id,
  });
  await drainOutbox(f.db, handlers);
  expect(seen).toHaveLength(1);
  expect((await runById(f, fromAgents.id))?.status).toBe("waiting_input");
  const kick = (await f.db.select().from(schema.outbox)).find(
    (j) => j.dedupeKey?.startsWith(`agent_run.execute:${fromAgents.id}:room-kick:`) && j.status === "pending",
  );
  expect(kick).toBeDefined();
});

test("only the head of the computer's line asks it: an agent's run waits behind a person's", async () => {
  f = await setup();
  const machineId = await computerAgent(f);
  await f.db.update(schema.providerCredentials).set({ revokedAt: new Date() });
  const { brain, seen } = scriptedComputerBrain(() => [
    { type: "error", code: "busy", message: "The computer is busy.", retryable: true },
  ]);
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await askedJustNow(f, machineId);
  const fromAgents = await secondRun(f, (await personMessage(f, "@dev revisa")).id, 3);
  await drainOutbox(f.db, handlers);
  const root = await personMessage(f, "sobre o deploy");
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev responde",
    threadId: root.id,
  });
  await drainOutbox(f.db, handlers);
  const personRun = (await f.db.select().from(schema.agentRuns)).find((r) => r.threadRootId === root.id);
  expect(personRun?.status).toBe("waiting_input");
  expect(personRun?.transcript).toMatchObject({ roomPeople: true });
  expect((await roomHead(f.db, machineId))?.id).toBe(personRun?.id ?? "");
  const asked = seen.length;

  // The agent's run looks again first: it isn't the head, so it doesn't ask.
  const waitOf = async () =>
    ((await runById(f, fromAgents.id))?.transcript as { waitingForBrain?: { waitId?: string } } | null)?.waitingForBrain
      ?.waitId;
  const waitId = await waitOf();
  await drainOutbox(f.db, handlers, { now: new Date(Date.now() + 11_000) });
  expect(seen.length).toBe(asked);
  expect((await runById(f, fromAgents.id))?.status).toBe("waiting_input");
  expect(await waitOf()).toBe(waitId);
  const next = (await f.db.select().from(schema.outbox)).filter(
    (j) => j.dedupeKey?.startsWith(`agent_run.execute:${fromAgents.id}:room:`) && j.status === "pending",
  );
  expect(next).toHaveLength(1);
});

test("background work in the computer's line ranks as asked work: a person's reply turn goes ahead of it", async () => {
  f = await setup();
  const machineId = await computerAgent(f);
  await f.db.update(schema.providerCredentials).set({ revokedAt: new Date() });
  const { brain } = scriptedComputerBrain(() => [
    { type: "error", code: "busy", message: "The computer is busy.", retryable: true },
  ]);
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  // Its first turn, before it moved, waited in line as a person's.
  const workRun = await secondRun(f, (await personMessage(f, "@dev faz o QA do site")).id);
  await drainOutbox(f.db, handlers);
  expect((await runById(f, workRun.id))?.transcript).toMatchObject({ roomPeople: true });
  const [work] = await f.db
    .insert(schema.agentWorks)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      anchorMessageId: Bun.randomUUIDv7(),
      ownThread: true,
      title: "QA do site",
      status: "live",
      how: "agent",
      lastUpdateAt: new Date(),
    })
    .returning();
  await f.db.update(schema.agentRuns).set({ workId: work?.id }).where(eq(schema.agentRuns.id, workRun.id));
  await drainOutbox(f.db, handlers, { now: new Date(Date.now() + COMPUTER_BUSY_RETRY_MS + 1_000), maxBatches: 1 });
  const parked = await runById(f, workRun.id);
  expect(parked?.transcript).toMatchObject({ waitingForBrain: { code: "busy" }, roomAsked: true });
  expect(parked?.transcript).not.toHaveProperty("roomPeople");

  const reply = await secondRun(f, (await personMessage(f, "@dev aqui só a LP tá sendo testada?")).id);
  await drainOutbox(f.db, handlers);
  expect((await runById(f, reply.id))?.transcript).toMatchObject({ roomPeople: true });
  expect((await roomHead(f.db, machineId))?.id).toBe(reply.id);
});

test("the right hand never waits behind the line: its turn goes to the computer past a person's run in it", async () => {
  f = await setup();
  const machineId = await computerAgent(f, { builtin: "right_hand" });
  // It thinks on the computer of the plan it was given.
  const [plan] = await f.db
    .insert(schema.machineAccounts)
    .values({
      id: Bun.randomUUIDv7(),
      orgId: f.org.id,
      machineId,
      kind: "claude_code",
      label: "plan",
      status: "active",
      createdBy: f.owner.id,
      shared: true,
    })
    .returning();
  await f.db.update(schema.agents).set({ brainAccountId: plan?.id }).where(eq(schema.agents.id, f.agent.id));
  const { brain, seen } = scriptedComputerBrain(() => [{ type: "done", text: "Pronto." }]);
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id, { protocol: MACHINE_PROTOCOL_VERSION }) },
  });
  const other = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Rio", handle: "rio", role: "Dev", instructions: "You build.", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  const ahead = await personAhead(f, machineId, other.id);
  await post(f, "@dev o que está rodando?");
  await drainOutbox(f.db, handlers);
  expect(seen).toHaveLength(1);
  const own = (await f.db.select().from(schema.agentRuns)).find((r) => r.id !== ahead.id);
  expect(own?.status).toBe("done");
  expect(own?.transcript).not.toHaveProperty("waitingForBrain");
});

test("the right hand refused for room goes first in the line, past the people already in it", async () => {
  f = await setup();
  const machineId = await computerAgent(f, { builtin: "right_hand" });
  const [plan] = await f.db
    .insert(schema.machineAccounts)
    .values({
      id: Bun.randomUUIDv7(),
      orgId: f.org.id,
      machineId,
      kind: "claude_code",
      label: "plan",
      status: "active",
      createdBy: f.owner.id,
      shared: true,
    })
    .returning();
  await f.db.update(schema.agents).set({ brainAccountId: plan?.id }).where(eq(schema.agents.id, f.agent.id));
  const { brain } = scriptedComputerBrain(() => [
    { type: "error", code: "busy", message: "The computer is busy.", retryable: true },
  ]);
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id, { protocol: MACHINE_PROTOCOL_VERSION }) },
  });
  const other = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Rio", handle: "rio", role: "Dev", instructions: "You build.", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  const ahead = await personAhead(f, machineId, other.id);
  await post(f, "@dev o que está rodando?");
  await drainOutbox(f.db, handlers);
  const own = (await f.db.select().from(schema.agentRuns)).find((r) => r.id !== ahead.id);
  expect(own?.transcript).toMatchObject({ waitingForBrain: { code: "busy" } });
  expect((await roomHead(f.db, machineId))?.id).toBe(own?.id);
});

/** A person's run already waiting for room on this computer, ahead of anything that comes now. */
async function personAhead(fx: Fixture, machineId: string, agentId = fx.agent.id) {
  const id = Bun.randomUUIDv7();
  const [run] = await fx.db
    .insert(schema.agentRuns)
    .values({
      orgId: fx.org.id,
      agentId,
      channelId: fx.general.id,
      threadRootId: id,
      triggerMessageId: id,
      trigger: "mention",
      hop: 1,
      status: "waiting_input",
      waitingMachineId: machineId,
      transcript: {
        waitingForBrain: { kind: "claude_code", machineId, code: "busy", waitId: Bun.randomUUIDv7() },
        roomPeople: true,
        roomWaitSince: Date.now() - 60_000,
      },
    })
    .returning();
  if (!run) throw new Error("no run");
  return run;
}

test("held in line as it resumes after a decision: the turn that runs later reads what the person decided", async () => {
  const gh = fakeGithub();
  f = await setup({ toolSources: [gh.source] });
  await grantScopes(f.db, f.org.id, f.agent.id, ALL_GITHUB_SCOPES);
  const machineId = await computerAgent(f);
  const { brain, seen } = scriptedComputerBrain(async function* (n, turn) {
    if (n === 0) {
      const result = await executeToolForRun(
        f.jobDeps,
        { orgId: turn.orgId, agentId: turn.agentId, runId: turn.runId, machineId },
        {
          id: "call-1",
          name: "github_merge_pr",
          input: { repo: "acme/app", pr: 42, why: "CI passed on the PR and it was reviewed: merging ships the fix." },
        },
      );
      yield { type: "tool_call", id: "call-1", name: "github_merge_pr", input: {}, executed: result };
      yield { type: "done", text: "Pedi aprovação para o merge." };
      return;
    }
    yield { type: "done", text: "Merge feito." };
  });
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(f, "@dev faz o merge do PR 42");
  await drainOutbox(f.db, handlers);
  const [run] = await f.db.select().from(schema.agentRuns);
  if (!run) throw new Error("no run");
  expect(run.status).toBe("waiting_approval");

  const ahead = await personAhead(f, machineId);
  const [approval] = await listApprovals(f.db, f.owner.id, f.org.id, { status: "pending" });
  await decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, approval?.id ?? "", {
    decision: "approve",
  });
  await drainOutbox(f.db, handlers);
  expect((await runById(f, run.id))?.transcript).toMatchObject({ waitingForBrain: { code: "busy" } });
  expect(seen).toHaveLength(1);
  expect(gh.executed).toHaveLength(1);

  // The run ahead is done: this one's turn goes, with the decision (not the first message again).
  await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.id, ahead.id));
  await drainOutbox(f.db, handlers, { now: new Date(Date.now() + 11_000) });
  expect((await runById(f, run.id))?.status).toBe("done");
  expect(seen).toHaveLength(2);
  expect(seen[1]?.trigger).toContain("github_merge_pr ok: acme/app#42");
  expect(gh.executed).toHaveLength(1);
});

test("a real outage starts the wait for room over: a run in line isn't failed as busy for the time its computer was gone", async () => {
  f = await setup();
  const machineId = await computerAgent(f);
  await f.db.update(schema.providerCredentials).set({ revokedAt: new Date() });
  let online = true;
  let lastSeenAt: string | null = null;
  const { brain } = scriptedComputerBrain(() => [
    { type: "error", code: "busy", message: "The computer is busy.", retryable: true },
  ]);
  const handlers = createJobHandlers({
    ...f.jobDeps,
    computerBlipWaitMs: 50,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id, { online, lastSeenAt }) },
  });
  await post(f, "@dev oi");
  await drainOutbox(f.db, handlers);
  const [run] = await f.db.select().from(schema.agentRuns);
  if (!run) throw new Error("no run");
  const longAgo = Date.now() - 20 * 60_000;
  await roomSince(f, run.id, longAgo);

  // Gone past the outage grace: no blip, its wait for room is over.
  online = false;
  lastSeenAt = new Date(Date.now() - 3 * 60_000).toISOString();
  await drainOutbox(f.db, handlers, { now: new Date(Date.now() + COMPUTER_BUSY_RETRY_MS + 1_000), maxBatches: 1 });
  let t = (await runById(f, run.id))?.transcript as { roomWaitSince?: number; waitingForBrain?: { code: string } };
  expect(t.waitingForBrain?.code).toBe("machine_offline");
  expect(t.roomWaitSince).toBeUndefined();

  // Back, and still full: in line again from now, not failed.
  online = true;
  await resumeRunsWaitingForMachine(f.db, machineId);
  await drainOutbox(f.db, handlers, { maxBatches: 1 });
  const back = await runById(f, run.id);
  t = back?.transcript as typeof t;
  expect(back?.status).toBe("waiting_input");
  expect(t.waitingForBrain?.code).toBe("busy");
  expect(t.roomWaitSince).toBeGreaterThan(longAgo);
});

test("the computer drops as the turn of a run in line goes out: it keeps its place", async () => {
  f = await setup();
  await computerAgent(f);
  await f.db.update(schema.providerCredentials).set({ revokedAt: new Date() });
  const { brain, seen } = scriptedComputerBrain((n) => [
    n === 1
      ? { type: "error", code: "machine_offline", message: "The computer MacBook is offline.", retryable: true }
      : { type: "error", code: "busy", message: "The computer is busy.", retryable: true },
  ]);
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(f, "@dev oi");
  await drainOutbox(f.db, handlers);
  const [run] = await f.db.select().from(schema.agentRuns);
  if (!run) throw new Error("no run");
  const since = (run.transcript as { roomWaitSince?: number }).roomWaitSince;
  expect(typeof since).toBe("number");

  await drainOutbox(f.db, handlers, { now: new Date(Date.now() + COMPUTER_BUSY_RETRY_MS + 1_000), maxBatches: 3 });
  expect(seen.length).toBeGreaterThanOrEqual(2);
  expect((await runById(f, run.id))?.transcript).toMatchObject({ roomWaitSince: since });
});

test("a session whose folder is gone from the computer goes on fresh in the agent's own folder, told so", async () => {
  f = await setup();
  await computerAgent(f);
  // A Claude Code runner answers a missing folder as `bad_request`; nothing ran.
  const { brain, seen } = scriptedComputerBrain((n) =>
    n === 0
      ? [{ type: "error", code: "bad_request", message: "The folder repos/acme/app doesn't exist", retryable: false }]
      : [{ type: "done", text: "Pronto." }],
  );
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(f, "@dev oi");
  await drainOutbox(f.db, handlers);
  const [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("done");
  expect(seen).toHaveLength(2);
  const [lost, fresh] = seen as [BrainTurn, BrainTurn];
  expect(lost.session?.ownFolder).toBeUndefined();
  expect(fresh.session).toMatchObject({ resume: false, cwd: "", ownFolder: true });
  expect(fresh.session?.id).not.toBe(lost.session?.id);
  // Later turns and resumes of the run continue that one.
  expect(run?.brainSessionId).toBe(fresh.session?.id ?? "");
  expect((fresh as BrainTurn & { thisTurn?: string }).thisTurn).toContain(
    "Your previous session on the computer was lost: the folder it worked in (repos/acme/app) isn't there anymore.",
  );
  expect((await timeline(f)).map((m) => m.body)).toEqual(["@dev oi", "Pronto."]);
});

test("a Codex session whose folder is gone: a fresh session before the API takes over, once per run", async () => {
  f = await setup();
  await computerAgent(f);
  // A Codex runner throws the same refusal, which the brain says is retryable: the model brain would take it.
  const gone = {
    type: "error",
    code: "runner_failed",
    message: "The folder repos/acme/app doesn't exist",
    retryable: true,
  };
  const { brain, seen } = scriptedComputerBrain(() => [gone as BrainEvent]);
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(f, "@dev oi");
  await drainOutbox(f.db, handlers);
  // Gone again in the fresh session: no third session, the run goes on as any failed turn would.
  expect(seen).toHaveLength(2);
  expect(seen[1]?.session).toMatchObject({ resume: false, ownFolder: true });
  expect(f.provider.calls.length).toBeGreaterThan(0);
});

test("in a busy channel, its teammates now and why its session was lost reach the computer brain whole", async () => {
  f = await setup();
  await computerAgent(f);
  for (const [name, handle, role] of [
    ["Caio", "caio", "Desenvolvedor"],
    ["Lia", "lia", "Revisora de código"],
    ["Rui", "rui", "Backend"],
  ] as const) {
    const a = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name, handle, role, instructions: "", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: a.id });
  }
  await f.db
    .update(schema.channels)
    .set({
      topic:
        "Canal do time de produto: aqui combinamos o que entra no app, quem revisa cada PR e quando cada entrega vai para produção. Use threads.",
    })
    .where(eq(schema.channels.id, f.general.id));
  const { brain, seen } = scriptedComputerBrain((n) =>
    n === 0
      ? [{ type: "error", code: "bad_request", message: "The folder repos/acme/app doesn't exist", retryable: false }]
      : [{ type: "done", text: "Pronto." }],
  );
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  // Nobody named it: the router brought it in, so "# This turn" also says why it was called.
  const message = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "person", userId: f.owner.id },
    body: "alguém revisa o PR do app hoje?",
  });
  await f.db.transaction((tx) => createAgentRuns(tx, message, [f.agent.id], "router"));
  await drainOutbox(f.db, handlers);
  expect(seen).toHaveLength(2);
  const thisTurn = (seen[1] as BrainTurn & { thisTurn?: string }).thisTurn ?? "";
  expect(thisTurn).toContain("## Why you were called");
  expect(thisTurn).toContain(
    "## Your teammates now\n- @caio: has an AI, answers when called\n- @lia: has an AI, answers when called\n- @rui: has an AI, answers when called\nThis is how they are now: it outweighs what older messages here say about them",
  );
  expect(thisTurn).toContain(sessionLostNote("repos/acme/app").replace(/^# /, "## "));
});

test("a run that waited for its computer reads its teammates as they are when it goes on, not as they were", async () => {
  f = await setup();
  const machineId = await computerAgent(f);
  const rui = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Rui", handle: "rui", role: "Backend", instructions: "", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: rui.id });
  // No key anywhere: Rui has no AI, and @dev has nothing to fall back on while its computer is off.
  await f.db.update(schema.providerCredentials).set({ revokedAt: new Date() });
  let online = false;
  const { brain, seen } = scriptedComputerBrain(() => [{ type: "done", text: "Já tem." }]);
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id, { online }) },
  });
  await post(f, "@dev o Rui já tem IA?");
  await drainOutbox(f.db, handlers);
  expect((await f.db.select().from(schema.agentRuns))[0]?.status).toBe("waiting_input");

  // Meanwhile Rui gets a key of his own, and the computer comes back.
  const key = await createCredential(f.db, f.keyWrapper, f.owner.id, f.org.id, {
    provider: "anthropic",
    label: "rui",
    apiKey: "sk-ant-test-key-1234",
  });
  await f.db.update(schema.agents).set({ credentialId: key.id }).where(eq(schema.agents.id, rui.id));
  online = true;
  await resumeRunsWaitingForMachine(f.db, machineId);
  await drainOutbox(f.db, handlers);
  expect(seen).toHaveLength(1);
  const thisTurn = (seen[0] as BrainTurn & { thisTurn?: string }).thisTurn ?? "";
  expect(thisTurn).toContain("## Your teammates now\n- @rui: has an AI, answers when called\n");
  expect(thisTurn).not.toContain("no AI connected yet");
});

/** Opens once, from outside the turn. */
function opening<T = void>() {
  let open!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    open = r;
  });
  return { promise, open };
}

/**
 * A computer brain whose first turn goes to the background through the bridge (`work_in_background`), then holds
 * until `finish`. `live`: it takes messages mid-turn (Claude Code, Codex app-server); without it, like Cursor or
 * `codex exec`, it reads them at its turn's end.
 */
function backgroundBrain(live: boolean) {
  const seen: BrainTurn[] = [];
  const handed: string[] = [];
  const moved = opening();
  const finish = opening();
  const brain: Brain = {
    kind: "claude_code",
    async *run(turn, io) {
      const n = seen.length;
      seen.push({ ...turn, system: "", messages: [] });
      if (n > 0) {
        yield { type: "done", text: "Migração pronta: 3 tabelas conferidas." };
        return;
      }
      if (live)
        io.steerable?.(async (messages) => {
          handed.push(...messages.map((m) => m.text));
          return { status: "accepted", accepted: messages.map((m) => m.uuid) };
        });
      try {
        const result = await io.executeTool?.({
          id: "w1",
          name: "work_in_background",
          input: { title: "Migrar a cobrança", say: "Vou cuidar disso em segundo plano." },
        });
        yield {
          type: "tool_call",
          id: "w1",
          name: "mcp__agentes__work_in_background",
          input: {},
          executed: { content: result?.content ?? "" },
        };
        moved.open();
        await finish.promise;
        yield { type: "done", text: "Migração pronta: 3 tabelas conferidas." };
      } finally {
        if (live) io.steerable?.(null);
      }
    },
  };
  return { brain, seen, handed, moved, finish };
}

test("long work on a steerable computer brain: the check-in reaches the turn live, the same session goes on, the conversation gets a new one", async () => {
  f = await setup({ workTools: true });
  const fx = f;
  await computerAgent(fx);
  const { brain, seen, handed, moved, finish } = backgroundBrain(true);
  const handlers = createJobHandlers({
    ...fx.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(fx, "@dev migra a cobrança");
  const drained = drainOutbox(fx.db, handlers);
  await moved.promise;
  const [work] = await fx.db.select().from(schema.agentWorks);
  if (!work?.nextUpdateAt) throw new Error("no work");
  const { checkInWork } = await import("../src/works");
  const due = new Date(work.nextUpdateAt.getTime() + 1000);
  expect(
    await checkInWork({ db: fx.db, pubsub: fx.pubsub }, fx.org.id, { workId: work.id, seq: 0, phase: "nudge" }, due),
  ).toBe("nudged");
  // Handed to the turn in flight, like a person's message (ADR 0112).
  expect(handed.some((h) => h.includes("You promised an update"))).toBe(true);
  // Meanwhile the conversation is free: a new message starts a run of its own.
  await post(fx, "@dev quanto é 2+2?");
  finish.open();
  await drained;
  await drainOutbox(fx.db, handlers);
  const runs = await fx.db.select().from(schema.agentRuns).orderBy(schema.agentRuns.createdAt);
  expect(runs).toHaveLength(2);
  expect(runs[0]?.workId).toBe(work.id);
  expect(runs[1]?.workId).toBeNull();
  // The work kept its session; the conversation's run never takes it.
  expect(seen[0]?.session?.id).toBe(runs[0]?.brainSessionId ?? "");
  expect(runs[1]?.brainSessionId).not.toBe(runs[0]?.brainSessionId);
  const report = (await timeline(fx)).find((m) => (m.meta?.workEnd as { id?: string } | undefined)?.id === work.id);
  expect(report?.body).toBe("Migração pronta: 3 tabelas conferidas.");
});

test("long work on a brain that reads at its turn's end (Cursor, codex exec): the server's line covers the silence, and the unread nudge doesn't turn the report into a thread line", async () => {
  f = await setup({ workTools: true });
  const fx = f;
  await computerAgent(fx);
  const { brain, seen, moved, finish } = backgroundBrain(false);
  const handlers = createJobHandlers({
    ...fx.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(fx, "@dev migra a cobrança");
  const drained = drainOutbox(fx.db, handlers);
  await moved.promise;
  const [work] = await fx.db.select().from(schema.agentWorks);
  if (!work?.nextUpdateAt) throw new Error("no work");
  const { checkInWork, WORK_LIMITS } = await import("../src/works");
  const deps = { db: fx.db, pubsub: fx.pubsub };
  const due = new Date(work.nextUpdateAt.getTime() + 1000);
  expect(await checkInWork(deps, fx.org.id, { workId: work.id, seq: 0, phase: "nudge" }, due)).toBe("nudged");
  const later = new Date(due.getTime() + WORK_LIMITS.graceMs);
  expect(await checkInWork(deps, fx.org.id, { workId: work.id, seq: 0, phase: "fallback" }, later)).toBe("posted");
  finish.open();
  await drained;
  await drainOutbox(fx.db, handlers);
  // The nudge it never read is stale once the turn ends: its text is the report, home, in one turn.
  expect(seen).toHaveLength(1);
  const all = await fx.db.select().from(schema.messages);
  expect(all.filter((m) => (m.meta.workUpdate as { auto?: boolean } | undefined)?.auto)).toHaveLength(1);
  const report = all.filter((m) => m.body === "Migração pronta: 3 tabelas conferidas.");
  expect(report).toHaveLength(1);
  expect(report[0]?.meta.workEnd).toEqual({ id: work.id, status: "done" });
  expect(report[0]?.threadId).toBeNull();
  const [done] = await fx.db.select().from(schema.agentWorks);
  expect(done).toMatchObject({ status: "done", resultMessageId: report[0]?.id });
});

test("a computer brain's work that waits in line parks at its turn's end instead of ending, and goes on when its turn comes", async () => {
  f = await setup({ workTools: true });
  const fx = f;
  const machineId = await computerAgent(fx);
  // Three works of this agent already live: the next one waits in line.
  const busy = [1, 2, 3].map((n) => ({
    orgId: fx.org.id,
    agentId: fx.agent.id,
    channelId: fx.general.id,
    anchorMessageId: Bun.randomUUIDv7(),
    ownThread: true,
    title: `Tarefa ${n}`,
    status: "live",
    how: "agent",
    lastUpdateAt: new Date(),
  }));
  const live = await fx.db.insert(schema.agentWorks).values(busy).returning();
  const { brain, seen } = scriptedComputerBrain(async function* (n, turn) {
    if (n === 0) {
      const result = await executeToolForRun(
        fx.jobDeps,
        { orgId: turn.orgId, agentId: turn.agentId, runId: turn.runId, machineId },
        { id: "w1", name: "work_in_background", input: { title: "Migrar a cobrança", say: "Vou cuidar disso." } },
      );
      yield { type: "tool_call", id: "w1", name: "mcp__agentes__work_in_background", input: {}, executed: result };
      yield { type: "done", text: "Ok, fico na fila." };
      return;
    }
    yield { type: "done", text: "Migração pronta." };
  });
  const handlers = createJobHandlers({
    ...fx.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(fx, "@dev migra a cobrança");
  await drainOutbox(fx.db, handlers);
  const [run] = await fx.db.select().from(schema.agentRuns);
  const work = (await fx.db.select().from(schema.agentWorks)).find((w) => w.title === "Migrar a cobrança");
  expect(run?.status).toBe("waiting_input");
  expect(work).toMatchObject({ status: "queued", finishedAt: null });
  expect((await fx.db.select().from(schema.messages)).some((m) => m.meta.workEnd)).toBe(false);

  // One of the others ends: it starts, reads that its turn came, and reports home.
  await fx.db
    .update(schema.agentWorks)
    .set({ status: "done", finishedAt: new Date() })
    .where(eq(schema.agentWorks.id, live[0]?.id ?? ""));
  const { releaseQueuedWorks } = await import("../src/works");
  await fx.db.transaction((tx) => releaseQueuedWorks(tx, fx.org.id));
  await drainOutbox(fx.db, handlers);
  expect(seen[1]?.trigger).toContain("Your background work's turn came");
  const report = (await fx.db.select().from(schema.messages)).find((m) => m.meta.workEnd);
  expect(report).toMatchObject({ body: "Migração pronta.", threadId: null });
  const [after] = await fx.db
    .select()
    .from(schema.agentWorks)
    .where(eq(schema.agentWorks.id, work?.id ?? ""));
  expect(after?.status).toBe("done");
});

test("computer sessions: a conversation run never takes a session an active run or background work shares, even through an earlier finished run", async () => {
  f = await setup();
  const fx = f;
  await computerAgent(fx);
  const { brain } = scriptedComputerBrain(() => [{ type: "done", text: "ok" }]);
  const handlers = createJobHandlers({
    ...fx.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  const dm = await openDm(fx.db, fx.owner.id, fx.org.id, { agentId: fx.agent.id });
  await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, dm.id, { body: "oi" });
  await drainOutbox(fx.db, handlers);
  const [first] = await fx.db.select().from(schema.agentRuns);
  const [agent] = await fx.db.select().from(schema.agents).where(eq(schema.agents.id, fx.agent.id));
  if (!first?.brainSessionId || !agent) throw new Error("no session");
  // A later run picked that session up and is still at it (a flat DM's long job).
  const holder = { ...first, id: Bun.randomUUIDv7(), status: "running" as const, triggerMessageId: Bun.randomUUIDv7() };
  await fx.db.insert(schema.agentRuns).values(holder);
  const next = { ...first, id: Bun.randomUUIDv7(), brainSessionId: null, triggerMessageId: Bun.randomUUIDv7() };
  await fx.db.insert(schema.agentRuns).values(next);
  const plan = await resolveBrain({ db: fx.db }, agent, next, dm.id, {});
  expect(plan.session?.id).not.toBe(first.brainSessionId);

  // It moved to the background and its turn ended: its session is still the work's.
  const [work] = await fx.db
    .insert(schema.agentWorks)
    .values({
      orgId: fx.org.id,
      agentId: fx.agent.id,
      channelId: dm.id,
      anchorMessageId: Bun.randomUUIDv7(),
      ownThread: true,
      title: "Relatório",
      status: "live",
      how: "agent",
      lastUpdateAt: new Date(),
    })
    .returning();
  await fx.db
    .update(schema.agentRuns)
    .set({ status: "done", workId: work?.id })
    .where(eq(schema.agentRuns.id, holder.id));
  const again = { ...next, id: Bun.randomUUIDv7(), triggerMessageId: Bun.randomUUIDv7() };
  await fx.db.insert(schema.agentRuns).values(again);
  expect((await resolveBrain({ db: fx.db }, agent, again, dm.id, {})).session?.id).not.toBe(first.brainSessionId);
});

/** The run's job may try once: its next failure is its last attempt (`finalAttempt`), where a wait parks it. */
const lastAttempt = (fx: Fixture) =>
  fx.db.update(schema.outbox).set({ maxAttempts: 1 }).where(eq(schema.outbox.kind, "agent_run.execute"));

/** What the person's message, the agent's line and a hand-off read of the agent's one run. */
async function readsOf(fx: Fixture) {
  const [run] = await fx.db.select().from(schema.agentRuns);
  if (!run) throw new Error("no run");
  const asked = await getMessage(fx.db, fx.org.id, run.triggerMessageId);
  const receipts = await receiptsFor(fx.db, fx.org.id, asked ? [asked] : []);
  const [status] = await loadAgentStatuses(fx.db, fx.org.id, new Date(), [fx.agent.id]);
  return {
    run,
    handled: receipts.get(run.triggerMessageId)?.handled.map(({ status, outage, computer }) => ({
      status,
      ...(outage ? { outage } : {}),
      ...(computer ? { computer } : {}),
    })),
    line: status?.status?.kind,
  };
}

test("back from a provider outage and in line for its computer, it reads as in line, never as the provider being down", async () => {
  f = await setup();
  const machineId = await computerAgent(f);
  await f.db.update(schema.providerCredentials).set({ revokedAt: new Date() });
  const { brain } = scriptedComputerBrain((n) => [
    n === 0
      ? {
          type: "error",
          code: "claude_failed",
          message: "API Error: 529 Overloaded",
          retryable: true,
          cause: "provider_transient",
          httpStatus: 529,
        }
      : { type: "error", code: "busy", message: "The computer is busy with other requests.", retryable: true },
  ]);
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(f, "@dev oi");
  await lastAttempt(f);
  await drainOutbox(f.db, handlers);
  expect((await readsOf(f)).handled).toEqual([{ status: "waiting_input", outage: true }]);

  // The provider's wait is over and the computer has no room: the run waits in its line, the outage marker kept.
  await drainOutbox(f.db, handlers, { now: new Date(Date.now() + 3 * 60_000), maxBatches: 1 });
  const reads = await readsOf(f);
  expect(reads.run.transcript).toMatchObject({ outage: { n: 1 }, waitingForBrain: { code: "busy" } });
  expect(reads.run.waitingMachineId).toBe(machineId);
  expect(reads.handled).toEqual([{ status: "waiting_input", computer: "queued" }]);
  expect(reads.line).toBe("queued_computer");
});

test("a refusal of the computer's own waits for that computer: never the provider's words, back when it is", async () => {
  f = await setup();
  const machineId = await computerAgent(f);
  await f.db.update(schema.providerCredentials).set({ revokedAt: new Date() });
  let ready = false;
  const { brain } = scriptedComputerBrain(() => [
    ready
      ? { type: "done", text: "Pronto." }
      : {
          type: "error",
          code: "unsupported",
          message: "This computer can't run this Claude sign-in right now. Try again later.",
          retryable: true,
        },
  ]);
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(f, "@dev oi");
  await lastAttempt(f);
  await drainOutbox(f.db, handlers);
  const reads = await readsOf(f);
  expect(reads.run.status).toBe("waiting_input");
  expect(reads.run.waitingMachineId).toBe(machineId);
  expect(reads.handled).toEqual([{ status: "waiting_input", computer: "away" }]);
  expect(reads.line).toBe("waiting_computer");
  expect(consultationWait(reads.run)).toBe("computer");
  // A plain note in the computer's words: it names no computer, so no app shows the card that waits for one to come back.
  const notes = (await timeline(f)).filter((m) => m.author.type === "agent");
  expect(notes.map((m) => [m.body, m.meta.bodyCode, m.meta.bodyParams, m.meta.brainUnavailable])).toEqual([
    [
      "Claude Code can't answer right now. I'll answer when it's back.",
      "brain_unavailable",
      { brain: "Claude Code" },
      { brain: "claude_code", code: "unsupported" },
    ],
  ]);

  // Its runner reconnects with the sign-in ready: the run goes on there.
  ready = true;
  await resumeRunsWaitingForMachine(f.db, machineId);
  await drainOutbox(f.db, handlers);
  const after = await runById(f, reads.run.id);
  expect(after?.status).toBe("done");
  expect(after?.waitingMachineId).toBeNull();
});

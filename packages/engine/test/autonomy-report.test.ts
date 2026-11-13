import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import {
  AUTONOMY_REPORT_JOB,
  type AutonomyRow,
  autonomyReport,
  autonomyRows,
  autonomyTable,
  type Brain,
  type BrainEvent,
  CONSULTATION_TTL_MS,
  createAgent,
  createAgentRuns,
  createJobHandlers,
  drainOutbox,
  type EmailTemplate,
  enqueueAutonomyReport,
  expireConsultations,
  holdOf,
  insertMessage,
  type MachineStatus,
  NEW_AGENT_DEFAULTS,
  onConsultedRunFinished,
  postPersonMessage,
  postStretchCard,
  REFUSALS,
  renderEmail,
  STRETCH,
  type ToolSource,
  toolPolicy,
  WRAP_UP_REPLY_NOTE,
} from "../src";
import { type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

/**
 * The daily stall-and-noise report (`autonomy-report.ts`): one workspace's day with, for every count, a case it
 * counts and one it doesn't, each at its own hour so no answer window reaches another case.
 */

const DAY = "2026-10-30";
const at = (time: string, day = DAY) => new Date(`${day}T${time}Z`);

let f: Fixture;
let ops: string;
let machineId: string;
const ch: Record<"agents" | "personDm" | "quiet", string> = { agents: "", personDm: "", quiet: "" };

async function channel(name: string, kind: "channel" | "dm" = "channel", dmKey: string | null = null) {
  const [row] = await f.db.insert(schema.channels).values({ orgId: f.org.id, name, kind, dmKey }).returning();
  if (!row) throw new Error("no channel");
  return row.id;
}

/** A message as stored; `by` an agent's id, else the owner wrote it. */
async function message(m: {
  at: Date;
  by?: string;
  body?: string;
  channelId?: string;
  mentions?: string[];
  meta?: Record<string, unknown>;
}) {
  const [row] = await f.db
    .insert(schema.messages)
    .values({
      orgId: f.org.id,
      channelId: m.channelId ?? f.general.id,
      authorType: m.by ? "agent" : "person",
      authorUserId: m.by ? null : f.owner.id,
      authorAgentId: m.by ?? null,
      body: m.body ?? "",
      mentionedAgentIds: m.mentions ?? [],
      meta: m.meta ?? {},
      hop: m.by ? 1 : 0,
      createdAt: m.at,
    })
    .returning();
  if (!row) throw new Error("no message");
  return row;
}

type Step = [kind: (typeof schema.agentRunStepKindEnum.enumValues)[number], data: Record<string, unknown>];

/** A run as stored, with its steps in order; `dev` by default, a conversation run, done. */
async function run(r: {
  at: Date;
  agentId?: string;
  triggerId?: string;
  trigger?: "mention" | "router" | "dm";
  status?: (typeof schema.agentRunStatusEnum.enumValues)[number];
  error?: string;
  background?: boolean;
  replyMessageId?: string;
  steps?: Step[];
}) {
  const triggerId = r.triggerId ?? crypto.randomUUID();
  const [row] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: r.agentId ?? f.agent.id,
      channelId: f.general.id,
      threadRootId: triggerId,
      triggerMessageId: triggerId,
      trigger: r.trigger ?? "router",
      hop: 1,
      status: r.status ?? "done",
      error: r.error ?? null,
      background: r.background ?? false,
      replyMessageId: r.replyMessageId ?? null,
      createdAt: r.at,
    })
    .returning();
  if (!row) throw new Error("no run");
  let seq = 0;
  for (const [kind, data] of r.steps ?? [])
    await f.db.insert(schema.agentRunSteps).values({ orgId: f.org.id, runId: row.id, seq: ++seq, kind, data });
  return row;
}

const decide = (messageId: string, selected: string[], error: string | null = null, needsAgentScore?: number) =>
  f.db.insert(schema.routingDecisions).values({
    orgId: f.org.id,
    channelId: f.general.id,
    messageId,
    strategy: "rule:test",
    candidates: [],
    selectedAgentIds: selected,
    error,
    needsAgentScore: needsAgentScore ?? null,
  });

const posted: Step = ["message", { messageId: crypto.randomUUID() }];

async function usage(runId: string, u: { input: number; output: number; cacheRead?: number; cost: number }) {
  await f.db.insert(schema.usageRecords).values({
    orgId: f.org.id,
    agentId: f.agent.id,
    runId,
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    requestedModel: "claude-sonnet-5-5",
    inputTokens: u.input,
    outputTokens: u.output,
    cacheReadTokens: u.cacheRead ?? 0,
    costNanoUsd: u.cost,
    createdAt: at("20:01:00"),
  });
}

async function task(t: { at: Date; status: "failed" | "done"; seconds: number }) {
  await f.db.insert(schema.machineTasks).values({
    orgId: f.org.id,
    agentId: f.agent.id,
    machineId,
    channelId: f.general.id,
    title: "Implement #4",
    executor: "claude",
    status: t.status,
    seconds: t.seconds,
    startedAt: t.at,
    endedAt: new Date(t.at.getTime() + t.seconds * 1000),
    createdAt: t.at,
  });
}

async function seed() {
  const dev = f.agent.id;
  ops = (await createAgent(f.db, f.owner.id, f.org.id, { name: "Ops", handle: "ops" }, NEW_AGENT_DEFAULTS)).id;
  await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: ops });
  ch.agents = await channel("dm-agents", "dm", `a:${dev}|a:${ops}`);
  ch.personDm = await channel("dm-ana-dev", "dm", `a:${dev}|u:${f.owner.id}`);
  ch.quiet = await channel("quiet");

  // mentionNoRun / handoffUnanswered (@mentions)
  await message({ at: at("01:00:00"), by: dev, body: "@ops can you check the deploy?", mentions: [ops] });
  const thanks = await message({ at: at("01:30:00"), by: dev, body: "thanks @ops", mentions: [ops] });
  await decide(thanks.id, []);
  const review = await message({ at: at("02:00:00"), by: dev, body: "@ops please review #12", mentions: [ops] });
  const reviewed = await message({ at: at("02:05:00"), by: ops, body: "Reviewed #12: two failing tests in auth." });
  await run({
    at: at("02:00:01"),
    agentId: ops,
    triggerId: review.id,
    trigger: "mention",
    replyMessageId: reviewed.id,
    steps: [posted],
  });
  const migrate = await message({ at: at("03:00:00"), by: dev, body: "@ops run the migration", mentions: [ops] });
  await run({ at: at("03:00:01"), agentId: ops, triggerId: migrate.id, trigger: "mention", status: "failed" });
  await message({ at: at("03:45:00"), by: ops, body: "Migration done." });
  const busy = await run({ at: at("00:30:00"), agentId: ops, steps: [posted] });
  const staging = await message({ at: at("00:40:00"), by: dev, body: "@ops also check staging", mentions: [ops] });
  await f.db
    .insert(schema.agentRunSteps)
    .values({ orgId: f.org.id, runId: busy.id, seq: 2, kind: "context", data: { steeredMessageIds: [staging.id] } });
  await message({ at: at("00:45:00"), by: ops, body: "Staging is fine too." });

  // handoffUnanswered (notes and questions)
  await message({ at: at("04:00:00"), by: dev, channelId: ch.agents, body: "Deploy is out.", meta: { agentNote: {} } });
  await message({ at: at("05:00:00"), by: dev, channelId: ch.agents, body: "Logs?", meta: { agentNote: {} } });
  await message({ at: at("05:10:00"), by: ops, channelId: ch.agents, body: "Logs are clean." });
  for (const [time, answeredAt] of [
    ["06:00:00", null],
    ["06:30:00", at("06:40:00")],
  ] as const) {
    const asker = await run({ at: at(time), status: "running" });
    await f.db.insert(schema.agentConsultations).values({
      orgId: f.org.id,
      askerRunId: asker.id,
      askerAgentId: dev,
      targetAgentId: ops,
      channelId: ch.agents,
      messageId: crypto.randomUUID(),
      waitId: `async:${crypto.randomUUID()}`,
      question: "How is staging deployed?",
      chain: [dev],
      status: answeredAt ? "answered" : "expired",
      answeredAt,
      expiresAt: new Date(at(time).getTime() + 15 * 60_000),
      createdAt: at(time),
    });
  }

  // readOnly
  await run({ at: at("07:00:00"), status: "running", steps: [["context", { heldBack: ["tell_agent", "ask_agent"] }]] });
  await run({ at: at("07:05:00"), status: "running", background: true, steps: [["context", { heldBack: ["react"] }]] });
  for (const [time, reason] of [
    ["07:10:00", REFUSALS.routineElsewhere],
    ["07:20:00", "Not allowed: this agent lacks the scope github:pr.write"],
  ] as const) {
    const r = await run({ at: at(time), status: "running", steps: [["context", { tools: ["tell_agent"] }]] });
    await f.db.insert(schema.auditLog).values({
      orgId: f.org.id,
      actorType: "agent",
      actorId: dev,
      action: "tool.call",
      targetType: "tool",
      targetId: "tell_agent",
      details: { reason },
      runId: r.id,
      outcome: "refused",
      createdAt: at(time),
    });
  }

  // promiseUnkept / promiseIgnored
  const nudged: Step = ["context", { nudged: "promise" }];
  await run({ at: at("08:00:00"), steps: [posted, nudged, ["tool_call", { name: "run_code" }], posted] });
  await run({
    at: at("08:10:00"),
    steps: [posted, nudged, ["model_call", { stopReason: "end_turn" }], ["tool_call", { name: "react" }], posted],
  });
  await run({ at: at("08:20:00"), steps: [posted, nudged, ["model_call", { executed: 3 }], posted] });
  await run({ at: at("08:30:00"), steps: [posted] });
  await run({ at: at("08:40:00"), status: "failed", error: "provider_error: 529", steps: [posted, nudged] });

  // limitStops
  const capped = await message({ at: at("09:00:05"), by: dev, body: "I ran out of steps.", meta: { stepLimit: {} } });
  await run({
    at: at("09:00:00"),
    replyMessageId: capped.id,
    steps: [["message", { messageId: capped.id, stepLimit: true }]],
  });
  await run({ at: at("09:10:00"), status: "failed", error: "too_many_tool_calls", background: true });
  await run({ at: at("09:20:00"), status: "failed", error: "provider_error: 529" });
  await message({ at: at("09:30:00"), by: dev, meta: { actionCard: { kind: "stretch_paused", state: "paused" } } });
  await message({ at: at("09:40:00"), by: dev, meta: { actionCard: { kind: "connect_ai" } } });

  // personUnanswered
  await message({ at: at("12:00:00"), body: "@dev please fix the login", mentions: [dev] });
  await message({ at: at("13:00:00"), body: "@dev deploy staging", mentions: [dev] });
  await message({ at: at("13:05:00"), by: dev, body: "Deployed." });
  const status = await message({ at: at("14:00:00"), body: "como estamos com a demanda?" });
  await decide(status.id, [ops]);
  await message({ at: at("14:03:00"), by: dev, body: "Não sei, é com o Ops." });
  await decide((await message({ at: at("15:00:00"), body: "bom dia pessoal" })).id, []);
  await message({ at: at("16:00:00"), body: "?" });
  await message({ at: at("17:00:00"), body: "oi" });
  await decide((await message({ at: at("17:00:02"), body: "pode revisar o PR?" })).id, [dev]);
  await message({ at: at("17:04:00"), by: dev, body: "Revisando." });
  await message({ at: at("18:00:00"), channelId: ch.personDm, body: "tá aí?" });
  await message({ at: at("18:20:00"), by: dev, channelId: ch.personDm, body: "Estou." });

  // taskStartFailed
  await task({ at: at("19:00:00"), status: "failed", seconds: 2 });
  await task({ at: at("19:10:00"), status: "failed", seconds: 600 });
  await task({ at: at("19:20:00"), status: "done", seconds: 1 });

  // quietRuns, ackReplies, idleWakes, and what they cost
  const quiet = await run({ at: at("20:00:00") });
  await usage(quiet.id, { input: 1000, output: 200, cacheRead: 300, cost: 5_000_000 });
  await run({ at: at("20:05:00"), background: true });
  const ack = await message({ at: at("21:00:00"), channelId: ch.quiet, body: "Valeu! 🙏" });
  await decide(ack.id, [], null, 0.05);
  const thanked = await run({ at: at("21:00:01"), triggerId: ack.id, steps: [posted] });
  await usage(thanked.id, { input: 500, output: 100, cost: 2_000_000 });
  const ask = await message({ at: at("21:10:00"), channelId: ch.quiet, body: "valeu, agora abre o PR" });
  const worked = await run({ at: at("21:10:01"), triggerId: ask.id, steps: [posted] });
  await usage(worked.id, { input: 9999, output: 9999, cost: 9_999 });
  const obrigado = await message({ at: at("21:20:00"), channelId: ch.quiet, body: "obrigado" });
  await run({ at: at("21:20:01"), triggerId: obrigado.id, steps: [["tool_call", { name: "create_issue" }], posted] });
  for (const [time, wake, reply] of [
    ["22:00:00", "@dev fyi the deploy finished", null],
    ["22:30:00", "@dev the deploy finished, check the logs", "Ok, anotado 👍"],
    ["23:00:00", "@dev review PR #12", "Revisei o PR #12: dois testes falham em auth."],
  ] as const) {
    const trigger = await message({ at: at(time), by: ops, channelId: ch.agents, body: wake, mentions: [dev] });
    const answer = reply ? await message({ at: at(time), by: dev, channelId: ch.agents, body: reply }) : null;
    if (answer) await decide(answer.id, [], null, reply?.startsWith("Ok") ? 0.05 : 0.9);
    await run({
      at: at(time),
      triggerId: trigger.id,
      trigger: "mention",
      ...(answer ? { replyMessageId: answer.id, steps: [posted] } : {}),
    });
  }

  // The days around it: one quiet run the day before (the average), one the day after (another day).
  await run({ at: at("12:00:00", "2026-10-29") });
  await run({ at: at("12:00:00", "2026-10-31") });
}

describe("one workspace's day", () => {
  let row: AutonomyRow;
  beforeAll(async () => {
    f = await setup();
    machineId = (
      await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
        name: "MacBook",
        os: "darwin",
        arch: "arm64",
        version: "0.8.0",
        protocol: MACHINE_PROTOCOL_VERSION,
        exec: true,
      })
    ).machineId;
    await seed();
    const rows = await autonomyRows(f.db, { from: DAY, days: 1 });
    expect(rows.map((r) => [r.day, r.orgName])).toEqual([[DAY, f.org.name]]);
    row = rows[0] as AutonomyRow;
  });
  afterAll(() => f?.close());

  test("an agent's @mention that started no run counts; one the judge read as a reference, or a run took, doesn't", () => {
    expect(row.mentionNoRun).toBe(1);
  });

  test("hand-offs unanswered in 30 minutes: a mention a failed run took, a note, an expired question", () => {
    expect(row.handoffUnanswered).toBe(3);
  });

  test("read-only: a run its policy kept from tools, and one refused a tool for that; a routine's or another refusal doesn't count", () => {
    expect(row.readOnly).toBe(2);
  });

  test("promises: four runs the judge nudged, one that ended doing nothing after it (a reaction isn't doing it)", () => {
    expect(row.promiseUnkept).toBe(4);
    // The one that failed after the nudge didn't end on its promise.
    expect(row.promiseIgnored).toBe(1);
  });

  test("limits: the step limit, a routine's run out of steps and a paused stretch; a provider error isn't one", () => {
    expect(row.limitStops).toBe(3);
  });

  test("people unanswered in 10 minutes: a mention, the router's pick answered by someone else, an undecided message, a DM", async () => {
    expect(row.personUnanswered).toBe(4);
    // With the router off, a message nobody mentioned was for people.
    const [off] = await autonomyRows(f.db, { from: DAY, days: 1, router: false });
    expect(off?.personUnanswered).toBe(3);
  });

  test("a background task that failed in its first seconds counts; a long one or a quick success doesn't", () => {
    expect(row.taskStartFailed).toBe(1);
  });

  test("noise: a silent run, a reply to only a thanks, two agents woken for nothing; each once, with its usage", () => {
    expect(row.quietRuns).toBe(2);
    expect(row.ackReplies).toBe(1);
    expect(row.idleWakes).toBe(2);
    expect(row.noiseRuns).toBe(4);
    expect(row.noiseTokens).toBe(2100);
    expect(row.noiseCostNanoUsd).toBe(7_000_000);
    // Each stall once: the ignored promise is one of the four unkept ones.
    expect(row.stalls).toBe(1 + 3 + 2 + 4 + 3 + 4 + 1);
  });

  test("the day's report: totals, the 7 days before as a daily average, and the operators' table", async () => {
    const report = await autonomyReport(f.db, { day: DAY });
    expect(report.workspaces.map((w) => w.orgId)).toEqual([f.org.id]);
    expect(report.total.quietRuns).toBe(2);
    expect(report.average.quietRuns).toBeCloseTo(1 / 7);
    const table = autonomyTable(report);
    expect(table).toContain(f.org.name);
    expect(table).toContain("7-day average");
    expect(table).toContain("$0.01");
  });

  test("a thanks or an ok counts the same in every language: the router's low need on a few words, or emoji alone", async () => {
    const other = "2026-10-20";
    // The same short messages in Portuguese, English, Japanese and German.
    const thanks = ["valeu, até amanhã", "thanks a lot @dev", "ありがとうございます", "Danke schön!"];
    const asks = [
      "valeu, e o deploy?",
      "thanks, where are the logs?",
      "ありがとう、ログはどこ？",
      "Danke, wo sind die Logs?",
    ];
    const long = [
      "valeu, agora abre o PR do login",
      "thanks, now open the login PR please",
      "ありがとう 次は ログイン の PR を 開いて",
      "danke, jetzt bitte den Login PR öffnen",
    ];
    let n = 0;
    const replied = async (body: string, need?: number) => {
      const time = `10:${String(n++).padStart(2, "0")}:00`;
      const trigger = await message({ at: at(time, other), channelId: ch.quiet, body });
      if (need !== undefined) await decide(trigger.id, [], null, need);
      await run({ at: at(time, other), triggerId: trigger.id, steps: [posted] });
    };
    const acks = async () => (await autonomyRows(f.db, { from: other, days: 1 }))[0]?.ackReplies ?? 0;
    // Heard as needing no agent: an ack. Heard as needing one, or never read by the router: not.
    for (const body of thanks) await replied(body, 0.05);
    expect(await acks()).toBe(4);
    for (const body of thanks) await replied(body, 0.9);
    for (const body of thanks) await replied(body);
    // A question mark in any script, or more than a few words, is never one, whatever the router heard.
    for (const body of [...asks, ...long]) await replied(body, 0.05);
    expect(await acks()).toBe(4);
    // Emoji alone needs no router.
    await replied("👍🙏");
    expect(await acks()).toBe(5);
  });

  test("after the nudge, a tool directory's search or a skill isn't doing it; a look-up is", async () => {
    const other = "2026-10-14";
    const nudged: Step = ["context", { nudged: "promise" }];
    const searched: Step[] = [
      ["tool_call", { name: "github_find_tools" }],
      ["tool_call", { name: "load_skill" }],
    ];
    await run({ at: at("10:00:00", other), steps: [posted, nudged, ...searched, posted] });
    await run({ at: at("11:00:00", other), steps: [posted, nudged, ["tool_call", { name: "read_channel" }], posted] });
    const [day] = await autonomyRows(f.db, { from: other, days: 1 });
    expect(day).toMatchObject({ promiseUnkept: 2, promiseIgnored: 1 });
  });

  test("a mention the judge failed to read woke nobody; one it read as only a reference didn't count", async () => {
    const other = "2026-10-16";
    const dev = f.agent.id;
    for (const [time, error] of [
      ["10:00:00", "judge: provider 529"],
      ["11:00:00", null],
    ] as const) {
      const said = await message({
        at: at(time, other),
        by: ops,
        body: "Feito o build; agora @dev precisa subir o staging",
        mentions: [dev],
      });
      await decide(said.id, [], error);
    }
    const [day] = await autonomyRows(f.db, { from: other, days: 1 });
    expect(day?.mentionNoRun).toBe(1);
  });

  test("a mission its stuck guard paused stopped at a limit; its other lines didn't", async () => {
    const other = "2026-10-17";
    const missionId = crypto.randomUUID();
    await message({
      at: at("10:00:00", other),
      by: f.agent.id,
      meta: { missionStuck: { missionId, reason: "no_progress" } },
    });
    await message({ at: at("11:00:00", other), by: f.agent.id, meta: { missionReport: { missionId } } });
    const [day] = await autonomyRows(f.db, { from: other, days: 1 });
    expect(day?.limitStops).toBe(1);
  });

  test("the talker's quick reply answers a person; another notice doesn't", async () => {
    const other = "2026-10-18";
    const dev = f.agent.id;
    for (const [time, meta] of [
      ["10:00", { talker: { runId: crypto.randomUUID() }, notice: { kind: "talker_reply", text: "" } }],
      ["11:00", { notice: { kind: "wait_result", text: "" } }],
    ] as const) {
      await message({ at: at(`${time}:00`, other), channelId: ch.personDm, body: "como está a migração?" });
      await message({ at: at(`${time}:30`, other), by: dev, channelId: ch.personDm, body: "Ainda rodando.", meta });
    }
    const [day] = await autonomyRows(f.db, { from: other, days: 1 });
    expect(day?.personUnanswered).toBe(1);
  });

  test("a message whose woken run ended without a word is that run's noise, not also a stall", async () => {
    const other = "2026-10-19";
    const dev = f.agent.id;
    const asked = await message({ at: at("10:00:00", other), body: "alguém viu o relatório de ontem?" });
    await decide(asked.id, [dev]);
    await run({ at: at("10:00:03", other), triggerId: asked.id });
    const again = await message({ at: at("11:00:00", other), body: "e o de anteontem?" });
    await decide(again.id, [dev]);
    await run({ at: at("11:00:03", other), triggerId: again.id, status: "failed", error: "provider_error: 529" });
    const told = await message({
      at: at("12:00:00", other),
      by: ops,
      body: "@dev the deploy finished, watch the metrics",
      mentions: [dev],
    });
    await decide(told.id, [dev]);
    await run({
      at: at("12:00:01", other),
      triggerId: told.id,
      trigger: "mention",
      steps: [["tool_call", { name: "react" }]],
    });
    const [day] = await autonomyRows(f.db, { from: other, days: 1 });
    expect(day).toMatchObject({ personUnanswered: 1, handoffUnanswered: 0, quietRuns: 2, idleWakes: 1, stalls: 1 });
  });

  test("only active workspaces, unless one is asked for by its id", async () => {
    await f.db.update(schema.organizations).set({ standing: "hold" }).where(eq(schema.organizations.id, f.org.id));
    try {
      expect(await autonomyRows(f.db, { from: DAY, days: 1 })).toEqual([]);
      expect((await autonomyRows(f.db, { from: DAY, days: 1, orgId: f.org.id })).length).toBe(1);
    } finally {
      await f.db.update(schema.organizations).set({ standing: "active" }).where(eq(schema.organizations.id, f.org.id));
    }
  });

  test("the daily job emails names and counts to the operators, each in their language, never what anyone wrote", async () => {
    const now = new Date("2026-10-31T05:00:00Z");
    const ops = { to: ["ops@example.com", f.owner.email], publicUrl: "https://agentes.chat" };
    await enqueueAutonomyReport(f.db, ops, new Date("2026-10-31T00:20:00Z"));
    await enqueueAutonomyReport(f.db, ops, now);
    const jobs = await f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, AUTONOMY_REPORT_JOB));
    expect(jobs.map((j) => [j.payload.day, j.nextAttemptAt.toISOString()])).toEqual([
      [DAY, "2026-10-31T01:00:00.000Z"],
    ]);
    await drainOutbox(f.db, createJobHandlers(f.jobDeps), { now });
    const emails = await f.db
      .select()
      .from(schema.outbox)
      .where(and(eq(schema.outbox.kind, "email.send")));
    const byLocale = Object.fromEntries(
      emails.map((e) => [(e.payload.template as EmailTemplate).locale, e.payload as { to: string[] }]),
    );
    expect(byLocale.en?.to).toEqual(["ops@example.com"]);
    expect(byLocale["pt-BR"]?.to).toEqual([f.owner.email]);
    const sent = JSON.stringify(emails.map((e) => e.payload));
    for (const said of ["login", "Valeu", "deploy", "migration", "staging", "demanda", "anotado"])
      expect(sent).not.toContain(said);
    const template = emails[0]?.payload.template as EmailTemplate;
    expect(template).toMatchObject({ kind: "autonomy_report", day: DAY, topStalls: [{ name: f.org.name }] });
    const { text } = renderEmail({ ...template, locale: "en" } as EmailTemplate);
    expect(text).toContain("Runs that could only read");
    expect(text).toContain(f.org.name);
  });
});

describe("what runs record for it", () => {
  afterEach(() => f?.close());

  test("what a run's policy keeps from it as it starts: none for a person's, what it refuses for an agent's own line", async () => {
    f = await setup({ askAgent: true });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@dev oi" });
    await drainOutbox(f.db, f.handlers);
    const line = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "agent", agentId: f.agent.id, runId: null, hop: 1, stretchId: null },
      body: "Task done.",
      meta: { machineTask: { taskId: crypto.randomUUID() } },
    });
    await createAgentRuns(f.db, line, [f.agent.id], "mention");
    await drainOutbox(f.db, f.handlers);
    const started = await f.db
      .select({ trigger: schema.agentRuns.triggerMessageId, data: schema.agentRunSteps.data })
      .from(schema.agentRunSteps)
      .innerJoin(schema.agentRuns, eq(schema.agentRuns.id, schema.agentRunSteps.runId))
      .where(eq(schema.agentRunSteps.kind, "context"));
    const first = started.filter((s) => "tools" in s.data);
    expect(first.length).toBe(2);
    // Whatever the policy refuses a run nobody is behind, of the tools this agent has.
    const nobody = { kind: "unattended", personId: null, reason: "agent" } as const;
    const refused = ["ask_agent", "find_agent", "tell_agent"].filter(
      (name) => toolPolicy(nobody, { name, scope: "" }).action === "refuse",
    );
    const lineRun = first.find((s) => s.trigger === line.id)?.data.heldBack as string[] | undefined;
    expect([...(lineRun ?? [])].sort()).toEqual(refused);
    expect(first.some((s) => s.trigger !== line.id && "heldBack" in s.data)).toBe(false);
  });

  test("a computer turn's own calls are counted on its model call, not ours through its bridge", async () => {
    f = await setup({ react: true });
    const paired = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
      name: "MacBook",
      os: "darwin",
      arch: "arm64",
      version: "0.8.0",
      protocol: MACHINE_PROTOCOL_VERSION,
      exec: true,
    });
    await f.db
      .update(schema.agents)
      .set({ machineId: paired.machineId, brain: "claude_code" })
      .where(eq(schema.agents.id, f.agent.id));
    const events: BrainEvent[] = [
      { type: "tool_call", id: "t1", name: "Bash", input: { command: "bun test" }, executed: { content: "ok" } },
      { type: "tool_call", id: "t2", name: "Edit", input: { file_path: "a.ts" }, executed: { content: "ok" } },
      { type: "tool_call", id: "t3", name: "react", input: { emoji: "👍" }, executed: { content: "ok" } },
      { type: "done", text: "Fixed and tested." },
    ];
    const brain: Brain = {
      kind: "claude_code",
      async *run() {
        yield* events;
      },
    };
    const status = (id: string): MachineStatus => ({
      id,
      orgId: f.org.id,
      name: "MacBook",
      online: true,
      execAllowed: true,
      os: "darwin",
      protocol: 8,
      executors: { claude: { version: "2.1.300", loggedIn: true }, detectedAt: new Date().toISOString() },
    });
    const handlers = createJobHandlers({
      ...f.jobDeps,
      brains: { claude_code: () => brain },
      machines: { status: async (id) => status(id) },
    });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev fix it",
    });
    await drainOutbox(f.db, handlers);
    const calls = await f.db
      .select({ data: schema.agentRunSteps.data })
      .from(schema.agentRunSteps)
      .where(eq(schema.agentRunSteps.kind, "model_call"));
    expect(calls.map((c) => c.data.executed)).toEqual([2]);
  });
});

describe("rows as the server writes them", () => {
  afterEach(() => f?.close());

  test("a question that expired or failed is unanswered, one answered in time isn't; a note with its own row counts once", async () => {
    f = await setup();
    ops = (await createAgent(f.db, f.owner.id, f.org.id, { name: "Ops", handle: "ops" }, NEW_AGENT_DEFAULTS)).id;
    const dm = await channel("dm-agents", "dm", `a:${f.agent.id}|a:${ops}`);
    // Past a question's 15 minutes, within a hand-off's 30: the server closes them now, with the clock's time.
    const asked = new Date(Date.now() - 20 * 60_000);
    const asker = await run({ at: asked, status: "running" });
    const target = await run({ at: asked, agentId: ops, status: "failed", error: "provider_error: 529" });
    const ask = (row: Partial<typeof schema.agentConsultations.$inferInsert> = {}) =>
      f.db.insert(schema.agentConsultations).values({
        orgId: f.org.id,
        askerRunId: asker.id,
        askerAgentId: f.agent.id,
        targetAgentId: ops,
        channelId: dm,
        messageId: crypto.randomUUID(),
        waitId: `async:${crypto.randomUUID()}`,
        question: "How is staging deployed?",
        chain: [f.agent.id],
        expiresAt: new Date(asked.getTime() + CONSULTATION_TTL_MS),
        createdAt: asked,
        ...row,
      });
    await ask();
    await ask({ targetRunId: target.id });
    await ask({ status: "answered", answer: "The deploy script.", answeredAt: new Date(asked.getTime() + 5 * 60_000) });
    const note = await message({
      at: asked,
      by: f.agent.id,
      channelId: dm,
      body: "Deploy is out.",
      meta: { agentNote: { runId: asker.id }, consultation: { id: crypto.randomUUID() } },
    });
    await ask({ messageId: note.id, question: note.body });
    await onConsultedRunFinished({ db: f.db, pubsub: f.pubsub }, target, "failed", "provider_error: 529");
    expect(await expireConsultations({ db: f.db, pubsub: f.pubsub })).toBe(2);
    const closed = await f.db.select().from(schema.agentConsultations);
    expect(closed.map((q) => q.status).sort()).toEqual(["answered", "expired", "expired", "failed"]);
    expect(closed.every((q) => q.answeredAt)).toBe(true);
    const [day] = await autonomyRows(f.db, { from: asked.toISOString().slice(0, 10), days: 1 });
    expect(day?.handoffUnanswered).toBe(3);
  });

  test("a run told to wrap up near its cap stopped at a limit: its reply offers Continuar, a routine's hands off", async () => {
    const look: ToolSource = {
      name: "work",
      tools: async () => [
        {
          name: "look",
          description: "Look at the open pull requests",
          scope: "context:read",
          inputSchema: { type: "object", properties: {} },
          execute: async () => ({ content: "3 PRs open" }),
        },
      ],
    };
    f = await setup({
      toolSources: [look],
      reply: (request) =>
        JSON.stringify(request.messages.at(-1)?.content ?? "").includes(WRAP_UP_REPLY_NOTE)
          ? { chunks: ["Vi 3 PRs. Falta revisar o #42."] }
          : { chunks: [], toolUses: [{ name: "look", input: {} }] },
    });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev revisa os PRs",
    });
    await drainOutbox(f.db, createJobHandlers({ ...f.jobDeps, maxToolTurns: 4 }));
    const [wrapped] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.trigger, "mention"));
    expect(wrapped?.status).toBe("done");
    const when = wrapped?.createdAt ?? new Date();
    await run({ at: when, background: true, steps: [["context", { wrapUp: true }]] });
    await run({ at: when, background: true });
    const [day] = await autonomyRows(f.db, { from: when.toISOString().slice(0, 10), days: 1 });
    expect(day?.limitStops).toBe(2);
  });

  test("a mention its stretch's limit held counts once, as that pause; one that woke nobody still counts", async () => {
    f = await setup();
    ops = (await createAgent(f.db, f.owner.id, f.org.id, { name: "Ops", handle: "ops" }, NEW_AGENT_DEFAULTS)).id;
    // The card is posted as the job does, now: the mentions just before it.
    const said = new Date(Date.now() - 2000);
    const held = await message({ at: said, by: ops, body: "@dev sobe o staging", mentions: [f.agent.id] });
    await message({ at: new Date(said.getTime() + 1000), by: ops, body: "@dev e a produção", mentions: [f.agent.id] });
    const stop = { reason: "runs", limit: STRETCH.unattendedRuns } as const;
    await postStretchCard(
      { db: f.db, pubsub: f.pubsub },
      f.org.id,
      await holdOf(f.db, held, f.agent.id, "mention", stop),
    );
    const [day] = await autonomyRows(f.db, { from: said.toISOString().slice(0, 10), days: 1 });
    expect(day).toMatchObject({ mentionNoRun: 1, limitStops: 1, stalls: 2 });
  });
});

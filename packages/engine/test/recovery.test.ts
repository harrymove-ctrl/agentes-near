import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import type { FakeReply } from "@agenteschat/providers/testing";
import {
  activeRunsIn,
  addRunStep,
  createOutboxPump,
  decideApproval,
  drainLocalRuns,
  drainOutbox,
  enqueue,
  INTERRUPTED_BY_RESTART,
  insertMessage,
  type JobHandler,
  listMessages,
  postPersonMessage,
  processOutbox,
  RESUME_MAX_AGE_MS,
  RUN_STALE_MS,
  recoverStaleRuns,
  releaseJobs,
  type ToolSource,
} from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

/**
 * The tools of a run the server stops under. `long_task` starts the shutdown while it runs (the server drains:
 * 0 s to finish), then ends ok, or with an error when asked to (`fail`, a command the shutdown killed).
 */
function deployTools() {
  const ran = { long_task: 0, other_task: 0 };
  const object = (properties: Record<string, unknown> = {}) => ({
    type: "object" as const,
    properties,
    additionalProperties: false,
  });
  const source: ToolSource = {
    name: "deploy-sim",
    tools: async () => [
      {
        name: "long_task",
        description: "A long task",
        scope: "",
        inputSchema: object({ fail: { type: "boolean" } }),
        async execute(input) {
          ran.long_task++;
          if (ran.long_task === 1) void drainLocalRuns(0, { graceMs: 0 });
          return (input as { fail?: boolean }).fail ? { content: "killed", isError: true } : { content: "task ok" };
        },
      },
      {
        name: "other_task",
        description: "Another task",
        scope: "",
        inputSchema: object(),
        async execute() {
          ran.other_task++;
          return { content: "other ok" };
        },
      },
      {
        name: "deploy_app",
        description: "Deploy the app",
        scope: "",
        sensitive: true,
        inputSchema: { type: "object", properties: { env: { type: "string" } } },
        describe: () => ({ title: "Deploy to production" }),
        execute: async () => ({ content: "deployed" }),
      },
    ],
  };
  return { source, ran };
}

/**
 * A run whose server shuts down during its first step (`toolUses`, `long_task` by default). One outbox batch
 * only: the job it hands back is not taken again here. `next`: the model's answer on later calls.
 */
async function interruptedRun(options: { toolUses?: FakeReply["toolUses"]; next?: () => FakeReply | undefined } = {}) {
  const tools = deployTools();
  f = await setup({
    toolSources: [tools.source],
    reply: (_req, call) =>
      call === 1
        ? { chunks: ["Trabalhando nisso."], toolUses: options.toolUses ?? [{ name: "long_task", input: {} }] }
        : (options.next?.() ?? { chunks: ["Pronto."] }),
  });
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev faz a tarefa longa",
  });
  await drainOutbox(f.db, f.handlers, { maxBatches: 1 });
  const [run] = await f.db.select().from(schema.agentRuns);
  if (!run) throw new Error("no run");
  return { run, ran: tools.ran };
}

const jobOf = async (runId: string) =>
  (await f.db.select().from(schema.outbox)).find(
    (j) => j.kind === "agent_run.execute" && (j.payload as { runId?: string }).runId === runId,
  );

const runRow = async (runId: string) =>
  (await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId)))[0];

/** As if the old process held the run's job when it died: lease still valid, no heartbeat for minutes. */
async function orphan(runId: string) {
  const job = await jobOf(runId);
  await f.db
    .update(schema.outbox)
    .set({ status: "processing", lockedUntil: new Date(Date.now() + 600_000), lockedBy: "dead-worker" })
    .where(eq(schema.outbox.id, job?.id ?? ""));
  await f.db
    .update(schema.agentRuns)
    .set({ heartbeatAt: new Date(Date.now() - 10 * 60_000) })
    .where(eq(schema.agentRuns.id, runId));
}

/** The tool results a model call was sent (`call` counts from 1), in order. */
const resultsSent = (call: number) =>
  (f.provider.calls[call - 1]?.request.messages ?? []).flatMap((m) =>
    Array.isArray(m.content) ? m.content.flatMap((b) => (b.type === "tool_result" ? [b] : [])) : [],
  );

const until = async (done: () => boolean) => {
  const end = Date.now() + 5000;
  while (!done()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(5);
  }
};

/** How many times a sweep recovered the run. */
const recoveries = async (runId: string) =>
  (await f.db.select().from(schema.agentRunSteps).where(eq(schema.agentRunSteps.runId, runId))).filter(
    (s) => s.kind === "error" && s.data.reason === "recovered",
  ).length;

describe("server restarts", () => {
  test("SIGTERM mid-tool: the step is saved and the run handed back at once, without spending an attempt", async () => {
    const { run } = await interruptedRun();
    expect(run.status).toBe("running");
    expect(f.provider.calls).toHaveLength(1);
    const job = await jobOf(run.id);
    expect(job).toMatchObject({ status: "pending", attempts: 0, lockedBy: null });
    expect(job?.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(job?.lastError).toContain("interrupted by a server shutdown");
    const saved = run.transcript as { messages: { role: string; content: unknown }[] };
    expect(saved.messages.at(-1)).toMatchObject({
      role: "user",
      content: [{ type: "tool_result", content: "task ok" }],
    });
    expect(await activeRunsIn(f.db, f.org.id, f.general.id)).toEqual([
      expect.objectContaining({ runId: run.id, status: "running", agentId: f.agent.id }),
    ]);
  });

  test("an interrupted run's secret card that is up closes with it and says why, with no click", async () => {
    const { run } = await interruptedRun();
    await orphan(run.id);
    await addRunStep(f.db, run, "tool_call", { toolUseId: "toolu_cut", name: "long_task", input: {} });
    const card = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: run.channelId,
      threadId: null,
      author: { type: "agent", agentId: f.agent.id, runId: run.id, hop: 0 },
      body: "card",
    });
    const [asked] = await f.db
      .insert(schema.secretRequests)
      .values({
        orgId: f.org.id,
        runId: run.id,
        agentId: f.agent.id,
        channelId: run.channelId,
        messageId: card.id,
        toolUseId: "toolu_asked",
        requestedForUserId: f.owner.id,
        name: "SHOP_PASSWORD",
        purpose: "To sign in.",
        targetKind: "env",
        publicKey: "key",
        expiresAt: new Date(Date.now() + 600_000),
      })
      .returning();
    const events = f.listen(f.general.id);

    expect((await recoverStaleRuns({ db: f.db, pubsub: f.pubsub })).failed).toEqual([run.id]);
    const [row] = await f.db
      .select()
      .from(schema.secretRequests)
      .where(eq(schema.secretRequests.id, asked?.id ?? ""));
    expect(row).toMatchObject({ status: "canceled", endReason: "run_stopped" });
    expect(events.find((e) => e.type === "secret.updated")).toMatchObject({
      secretRequest: { status: "canceled", endReason: "run_stopped" },
    });
    const [message] = await f.db.select().from(schema.messages).where(eq(schema.messages.id, card.id));
    expect(message?.meta).toMatchObject({ secretRequest: { status: "canceled", endReason: "run_stopped" } });
  });

  test("the next instance goes on with what the tool returned: the tool ran once", async () => {
    const { run, ran } = await interruptedRun();
    await drainOutbox(f.db, f.handlers);
    expect((await runRow(run.id))?.status).toBe("done");
    expect(f.provider.calls).toHaveLength(2);
    expect(resultsSent(2)).toEqual([expect.objectContaining({ content: "task ok" })]);
    expect(ran.long_task).toBe(1);
    const timeline = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    expect(timeline.at(-1)?.body).toBe("Pronto.");
  });

  test("a call still running when the shutdown began may have stopped partway; one it kept from starting never ran", async () => {
    const { run, ran } = await interruptedRun({
      toolUses: [
        { name: "long_task", input: { fail: true } },
        { name: "other_task", input: {} },
      ],
    });
    await drainOutbox(f.db, f.handlers);
    expect((await runRow(run.id))?.status).toBe("done");
    const [cut, notRun] = resultsSent(2);
    expect(cut?.isError).toBe(true);
    // Its error may be the shutdown's doing or its own: the model is told the restart began, not that it caused it.
    expect(cut?.content).toStartWith(
      "A server restart began while this call ran: it may have stopped partway, after doing part of its work.",
    );
    expect(cut?.content).toEndWith("killed");
    expect(notRun).toMatchObject({ isError: true });
    expect(notRun?.content).toContain("Interrupted by a server restart before it ran: nothing was done");
    expect(ran).toEqual({ long_task: 1, other_task: 0 });
  });

  test("a step cut after asking for an approval posts its card and waits, as it would without the restart", async () => {
    const { run, ran } = await interruptedRun({
      toolUses: [
        { name: "deploy_app", input: { env: "prod", why: "O deploy de ontem quebrou o login de todos os clientes." } },
        { name: "long_task", input: {} },
      ],
    });
    expect((await runRow(run.id))?.status).toBe("waiting_approval");
    // Nothing to hand back: the job ended with the step.
    expect((await jobOf(run.id))?.status).toBe("done");
    const [approval] = await f.db.select().from(schema.approvals);
    expect(approval).toMatchObject({ status: "pending", runId: run.id });
    expect(approval?.messageId).not.toBeNull();

    await decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, approval?.id ?? "", {
      decision: "approve",
    });
    await drainOutbox(f.db, f.handlers);
    expect((await runRow(run.id))?.status).toBe("done");
    expect(resultsSent(2).map((r) => r.content)).toEqual(["deployed", "task ok"]);
    expect(ran.long_task).toBe(1);
  });

  test("a run picked up again with an old beat is beaten first, so a sweep doesn't take it from its worker", async () => {
    let beatAtPickup: Date | null | undefined;
    let swept: Awaited<ReturnType<typeof recoverStaleRuns>> | undefined;
    const { run } = await interruptedRun({
      // While the next instance's worker runs it, a recovery sweep comes by.
      next: () => ({
        chunks: ["Pronto."],
        hold: (async () => {
          [beatAtPickup] = (await f.db.select().from(schema.agentRuns)).map((r) => r.heartbeatAt);
          swept = await recoverStaleRuns({ db: f.db, pubsub: f.pubsub });
        })(),
      }),
    });
    // Handed back a while ago: its last beat is minutes old when a worker takes it again.
    await f.db
      .update(schema.agentRuns)
      .set({ heartbeatAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(schema.agentRuns.id, run.id));
    await drainOutbox(f.db, f.handlers);
    // Fresh before its first model call: a sweep on another instance finds it alive too.
    expect(Date.now() - (beatAtPickup?.getTime() ?? 0)).toBeLessThan(RUN_STALE_MS);
    expect(swept).toEqual({ resumed: [], failed: [], requeued: [] });
    expect((await runRow(run.id))?.status).toBe("done");
    expect(f.provider.calls).toHaveLength(2);
  });

  test("a run this process executes isn't swept while its beat looks old (the database was away)", async () => {
    let swept: Awaited<ReturnType<typeof recoverStaleRuns>> | undefined;
    const { run } = await interruptedRun({
      next: () => ({
        chunks: ["Pronto."],
        // No beat got through for minutes, in the middle of its model call; the database is back and a sweep
        // comes by.
        hold: (async () => {
          await f.db.update(schema.agentRuns).set({ heartbeatAt: new Date(Date.now() - 10 * 60_000) });
          swept = await recoverStaleRuns({ db: f.db, pubsub: f.pubsub });
        })(),
      }),
    });
    await drainOutbox(f.db, f.handlers);
    expect(swept).toEqual({ resumed: [], failed: [], requeued: [] });
    expect((await runRow(run.id))?.status).toBe("done");
    expect(f.provider.calls).toHaveLength(2);
    expect(await recoveries(run.id)).toBe(0);
  });

  test("a worker whose job a sweep took before it started leaves the run to the next job, the same worker's included", async () => {
    let release!: () => void;
    const released = new Promise<void>((r) => {
      release = r;
    });
    const { run } = await interruptedRun({ next: () => ({ chunks: ["Pronto."], hold: released }) });
    // Handed back a while ago: its last beat is minutes old.
    await f.db
      .update(schema.agentRuns)
      .set({ heartbeatAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(schema.agentRuns.id, run.id));
    let started = false;
    let opened!: () => void;
    const gate = new Promise<void>((r) => {
      opened = r;
    });
    const execute = f.handlers["agent_run.execute"] as JobHandler;
    // This worker takes the handed-back job; before its handler gets going, a sweep sees the run's old beat.
    const first = processOutbox(
      f.db,
      {
        ...f.handlers,
        "agent_run.execute": async (job, ctx) => {
          started = true;
          await gate;
          return execute(job, ctx);
        },
      },
      { workerId: "w" },
    );
    await until(() => started);
    expect((await recoverStaleRuns({ db: f.db, pubsub: f.pubsub })).resumed).toEqual([run.id]);
    // The same worker takes the run's next job, which asks the model.
    const second = drainOutbox(f.db, f.handlers, { workerId: "w" });
    await until(() => f.provider.calls.length === 2);
    // The first handler goes on now: its claim is gone, so it leaves the run alone.
    opened();
    await Promise.race([first, Bun.sleep(2000)]);
    expect(f.provider.calls).toHaveLength(2);
    release();
    await Promise.all([first, second]);
    expect((await runRow(run.id))?.status).toBe("done");
  });

  test("a tool that ignores the shutdown and outlives the drain keeps its run's job: nothing runs it again meanwhile", async () => {
    let finish!: () => void;
    const finished = new Promise<void>((r) => {
      finish = r;
    });
    let created = 0;
    const source: ToolSource = {
      name: "connector",
      tools: async () => [
        {
          name: "create_issue",
          description: "A connector call: it doesn't watch the run's abort signal",
          scope: "",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          async execute() {
            created++;
            if (created === 1) {
              // The shutdown begins while the call is in flight, and its drain ends before the call does.
              void drainLocalRuns(0, { graceMs: 0 });
              await finished;
            }
            return { content: "created issue #42" };
          },
        },
      ],
    };
    f = await setup({
      toolSources: [source],
      reply: (_req, call) =>
        call === 1
          ? { chunks: ["Criando a issue."], toolUses: [{ name: "create_issue", input: {} }] }
          : { chunks: ["Pronto."] },
    });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev cria a issue",
    });
    const old = createOutboxPump(f.db, f.handlers, { workerId: "old" });
    await old.pump();
    await until(() => created === 1);
    const [run] = await f.db.select().from(schema.agentRuns);
    if (!run) throw new Error("no run");

    // Its jobs go back to the queue: not the run's, whose step is still under way.
    await releaseJobs(f.db, "old");
    expect(await jobOf(run.id)).toMatchObject({ status: "processing", lockedBy: "old" });
    await drainOutbox(f.db, f.handlers, { workerId: "next" });
    expect(f.provider.calls).toHaveLength(1);

    // The call ends before the process does: the step is saved and the run handed back with what it returned.
    finish();
    await old.idle();
    await drainOutbox(f.db, f.handlers, { workerId: "next" });
    expect((await runRow(run.id))?.status).toBe("done");
    expect(resultsSent(2)).toEqual([expect.objectContaining({ content: "created issue #42" })]);
    expect(created).toBe(1);
  });

  test("a run that crashed with a later wait's job pending is still swept: that job would do nothing to it", async () => {
    const { run } = await interruptedRun();
    await orphan(run.id);
    // The dead worker's lease ran out: the queue leaves the job to the sweep.
    await f.db
      .update(schema.outbox)
      .set({ lockedUntil: new Date(Date.now() - 60_000) })
      .where(eq(schema.outbox.id, (await jobOf(run.id))?.id ?? ""));
    // Left from an earlier wait for its computer's plan to reset, due in 3 hours.
    await enqueue(f.db, {
      orgId: run.orgId,
      kind: "agent_run.execute",
      payload: { runId: run.id, wait: "an-earlier-wait" },
      dedupeKey: `agent_run.execute:${run.id}:plan_reset:later`,
      runAt: new Date(Date.now() + 3 * 3600_000),
      maxAttempts: 4,
    });
    expect((await recoverStaleRuns({ db: f.db, pubsub: f.pubsub })).resumed).toEqual([run.id]);
    await drainOutbox(f.db, f.handlers);
    expect((await runRow(run.id))?.status).toBe("done");
    expect(f.provider.calls).toHaveLength(2);
  });

  test("a run that crashed inside a job for one wait for its computer goes on in a new job, recovered once", async () => {
    const { run } = await interruptedRun();
    await orphan(run.id);
    // The job running it was a "computer is back" job: it resumes one wait, and does nothing once the run runs.
    await f.db
      .update(schema.outbox)
      .set({ payload: { runId: run.id, wait: "w-1" } })
      .where(eq(schema.outbox.id, (await jobOf(run.id))?.id ?? ""));
    expect((await recoverStaleRuns({ db: f.db, pubsub: f.pubsub })).resumed).toEqual([run.id]);
    await drainOutbox(f.db, f.handlers);
    expect((await runRow(run.id))?.status).toBe("done");
    expect(f.provider.calls).toHaveLength(2);
    expect(await recoveries(run.id)).toBe(1);
  });

  test("on boot, an orphan (dead worker still holding the lease) is resumed and finishes", async () => {
    const { run } = await interruptedRun();
    await orphan(run.id);
    expect(await recoverStaleRuns({ db: f.db, pubsub: f.pubsub })).toEqual({
      resumed: [run.id],
      failed: [],
      requeued: [],
    });
    // A second sweep right away leaves it alone (fresh heartbeat, job pending).
    expect((await recoverStaleRuns({ db: f.db, pubsub: f.pubsub })).resumed).toEqual([]);
    await drainOutbox(f.db, f.handlers);
    expect((await runRow(run.id))?.status).toBe("done");
    const timeline = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    expect(timeline.at(-1)?.body).toBe("Pronto.");
    expect(await activeRunsIn(f.db, f.org.id, f.general.id)).toEqual([]);
  });

  test("a dead worker's run whose job lease ran out is left to the sweep: a tool cut in half never runs again", async () => {
    const { run, ran } = await interruptedRun();
    await orphan(run.id);
    // It died in the middle of a tool, longer ago than its job's lease.
    await addRunStep(f.db, run, "tool_call", { toolUseId: "toolu_cut", name: "long_task", input: {} });
    await f.db
      .update(schema.outbox)
      .set({ lockedUntil: new Date(Date.now() - 1000) })
      .where(eq(schema.outbox.id, (await jobOf(run.id))?.id ?? ""));
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls).toHaveLength(1);
    expect((await jobOf(run.id))?.status).toBe("processing");

    expect((await recoverStaleRuns({ db: f.db, pubsub: f.pubsub })).failed).toEqual([run.id]);
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls).toHaveLength(1);
    expect(ran.long_task).toBe(1);
  });

  test("two sweeps at once (two instances booting) resume an orphan once", async () => {
    const { run } = await interruptedRun();
    await orphan(run.id);
    const [a, b] = await Promise.all([
      recoverStaleRuns({ db: f.db, pubsub: f.pubsub }),
      recoverStaleRuns({ db: f.db, pubsub: f.pubsub }),
    ]);
    expect([...a.resumed, ...b.resumed]).toEqual([run.id]);
    const jobs = (await f.db.select().from(schema.outbox)).filter(
      (j) => j.kind === "agent_run.execute" && j.status === "pending",
    );
    expect(jobs).toHaveLength(1);
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls).toHaveLength(2);
  });

  test("an orphan whose job was on its last attempt goes on in a new job; the old one ends", async () => {
    const { run } = await interruptedRun();
    await orphan(run.id);
    const old = await jobOf(run.id);
    await f.db
      .update(schema.outbox)
      .set({ attempts: old?.maxAttempts ?? 4 })
      .where(eq(schema.outbox.id, old?.id ?? ""));
    expect((await recoverStaleRuns({ db: f.db, pubsub: f.pubsub })).resumed).toEqual([run.id]);
    const jobs = (await f.db.select().from(schema.outbox)).filter((j) => j.kind === "agent_run.execute");
    expect(jobs.map((j) => j.status).sort()).toEqual(["failed", "pending"]);
    await drainOutbox(f.db, f.handlers);
    expect((await runRow(run.id))?.status).toBe("done");
  });

  test("an orphan whose reply thread is gone still fails with its notice, posted in the channel itself", async () => {
    const { run } = await interruptedRun();
    await orphan(run.id);
    await addRunStep(f.db, run, "tool_call", { toolUseId: "toolu_cut", name: "long_task", input: {} });
    // Its thread root is no top-level message of this channel any more.
    await f.db
      .update(schema.agentRuns)
      .set({ threadRootId: crypto.randomUUID() })
      .where(eq(schema.agentRuns.id, run.id));

    expect((await recoverStaleRuns({ db: f.db, pubsub: f.pubsub })).failed).toEqual([run.id]);
    expect(await runRow(run.id)).toMatchObject({ status: "failed", error: INTERRUPTED_BY_RESTART });
    const timeline = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    expect(timeline.at(-1)).toMatchObject({ threadId: null });
    expect(timeline.at(-1)?.body).toContain(INTERRUPTED_BY_RESTART);
  });

  test("an orphan dead for longer than the resume window fails with its notice instead of resuming", async () => {
    const { run } = await interruptedRun();
    await orphan(run.id);
    await f.db
      .update(schema.agentRuns)
      .set({ heartbeatAt: new Date(Date.now() - RESUME_MAX_AGE_MS - 60_000) })
      .where(eq(schema.agentRuns.id, run.id));

    expect(await recoverStaleRuns({ db: f.db, pubsub: f.pubsub })).toEqual({
      resumed: [],
      failed: [run.id],
      requeued: [],
    });
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls).toHaveLength(1);
  });

  test("an orphan cut in the middle of a tool call fails with the notice, keeps its text, and the app hears it", async () => {
    const { run } = await interruptedRun();
    await orphan(run.id);
    // A tool started and never reported back (it may have had effects): unsafe to repeat. It had asked for an
    // approval in that step, whose card was never posted.
    await addRunStep(f.db, run, "tool_call", { toolUseId: "toolu_cut", name: "long_task", input: {} });
    await f.db.insert(schema.approvals).values({
      orgId: f.org.id,
      runId: run.id,
      agentId: f.agent.id,
      channelId: run.channelId,
      threadRootId: run.threadRootId,
      toolUseId: "toolu_cut_deploy",
      tool: "deploy_app",
      scope: "",
      params: { env: "prod" },
      actionHash: "hash",
      title: "Deploy to production",
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const events = f.listen(f.general.id);

    expect((await recoverStaleRuns({ db: f.db, pubsub: f.pubsub })).failed).toEqual([run.id]);
    expect(await runRow(run.id)).toMatchObject({ status: "failed", error: INTERRUPTED_BY_RESTART });
    expect(INTERRUPTED_BY_RESTART).toBe("Interrupted by a server restart");
    const timeline = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    expect(timeline.at(-1)?.body).toContain(INTERRUPTED_BY_RESTART);
    expect(events.find((e) => e.type === "run.finished")).toMatchObject({ status: "failed", runId: run.id });
    expect((await jobOf(run.id))?.status).toBe("failed");
    expect((await f.db.select().from(schema.approvals))[0]?.status).toBe("canceled");
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls).toHaveLength(1);
  });
});

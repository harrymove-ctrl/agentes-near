import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { type ModelRequest, systemText, textOf } from "@agenteschat/providers";
import type { FakeReply } from "@agenteschat/providers/testing";
import {
  answerQuestion,
  createTalker,
  drainOutbox,
  grantScopes,
  insertMessage,
  listMessages,
  postPersonMessage,
  queueOnRun,
  releaseHeldInbox,
  statusReply,
  stopChecksSettled,
  TALKER_MIN_GAP_MS,
  TALKER_QUIET_MS,
  type TalkerDeps,
  talkerPolicy,
} from "../src";
import { afterSteered } from "../src/steering";
import { answerSteering, type Fixture, setup } from "./fixtures";
import { pairMachine, RUNNER } from "./machine-fixtures";
import { ALL_GITHUB_SCOPES, fakeGithub } from "./tool-fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const isTalkerCall = (req: ModelRequest) => systemText(req.system).includes("conversation layer");
const QUESTION = "Faço o deploy em staging ou em produção?";
const REPLY = "Ainda não: estou esperando sua resposta no card, staging ou produção.";

/** The agent: asks where to deploy (a question card), then deploys. The talker: `talker(req)`. */
function script(talker: (req: ModelRequest) => FakeReply) {
  return (req: ModelRequest): FakeReply => {
    if (isTalkerCall(req)) return talker(req);
    if (JSON.stringify(req.messages).includes("The person answered")) return { chunks: ["Deploy em staging feito."] };
    return {
      chunks: [],
      toolUses: [
        {
          name: "ask_user",
          input: {
            question: QUESTION,
            choices: ["staging", "produção"],
            why: "The request doesn't say where to deploy, and production is the person's call.",
          },
        },
      ],
    };
  };
}

const replyJson = (text: string) => ({ chunks: [JSON.stringify({ action: "reply", text })] });

type TalkerOptions = Partial<Omit<TalkerDeps, "db" | "pubsub" | "gateway" | "resolveModel">>;

/** The talker on the test gateway, and a person writing in the thread of the task's trigger. */
function talkerOn(trigger: { id: string }, options: TalkerOptions = {}) {
  const decisions: string[] = [];
  const talker = createTalker({
    db: f.db,
    pubsub: f.pubsub,
    gateway: f.gateway,
    resolveModel: async () => "claude-haiku-5-5",
    onDecision: (d) => decisions.push(d.outcome),
    ...options,
  });
  const write = async (body: string) => {
    const m = await postPersonMessage({ db: f.db, pubsub: f.pubsub, talker }, f.owner.id, f.org.id, f.general.id, {
      body,
      threadId: trigger.id,
    });
    await stopChecksSettled();
    return m;
  };
  return { talker, write, decisions };
}

/**
 * A run waiting on a person's answer to its question. The card is in the channel, where the run answers:
 * a message in the thread of the trigger goes into the run without answering it.
 */
async function waitingOnQuestion(talker: Parameters<typeof script>[0], options: TalkerOptions = {}) {
  f = await setup({ askUser: true, reply: script(talker) });
  const trigger = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev faz o deploy da versão nova",
  });
  await drainOutbox(f.db, f.handlers);
  const [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("waiting_input");
  return { run: run as NonNullable<typeof run>, ...talkerOn(trigger, options) };
}

const talkerCalls = () => f.provider.calls.filter((c) => isTalkerCall(c.request));
const talkerMessages = async () =>
  (await f.db.select().from(schema.messages)).filter((m) => (m.meta as Record<string, unknown>).talker);

const MERGE = {
  name: "github_merge_pr",
  input: { repo: "acme/app", pr: 42, why: "CI passed on the PR and it was reviewed: merging ships the fix." },
};
const ASKED = "já mergeou?";
const ANSWER = "Ainda não: o merge espera a aprovação no card.";

/**
 * A run paused on an approval (merging PR 42). The agent answers `ASKED` with `ANSWER` and asks to merge
 * otherwise; the talker answers with `talker(req)`.
 */
async function waitingOnApproval(talker: (req: ModelRequest) => FakeReply = () => replyJson(REPLY)) {
  f = await setup({
    toolSources: [fakeGithub().source],
    reply: (req) =>
      isTalkerCall(req)
        ? talker(req)
        : JSON.stringify(req.messages).includes(ASKED)
          ? { chunks: [ANSWER] }
          : { chunks: [], toolUses: [MERGE] },
  });
  await grantScopes(f.db, f.org.id, f.agent.id, ALL_GITHUB_SCOPES);
  const trigger = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev merge PR 42",
  });
  await drainOutbox(f.db, f.handlers);
  const [held] = await f.db.select().from(schema.agentRuns);
  expect(held?.status).toBe("waiting_approval");
  return { held: held as NonNullable<typeof held>, trigger };
}

/** `ASKED` in the trigger's thread, queued on the run as the insert does while the run works. */
async function askedWhileWorking(run: { id: string }, trigger: { id: string }) {
  const message = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    threadId: trigger.id,
    author: { type: "person", userId: f.owner.id },
    body: ASKED,
  });
  expect(await queueOnRun(f.db, run.id, message.id)).toBe(true);
  return message;
}

/** What the agent said after `message`: fast replies and answers alike. */
const saidAfter = async (message: { createdAt: Date }) =>
  (await f.db.select().from(schema.messages)).filter(
    (m) => m.authorAgentId === f.agent.id && m.createdAt > message.createdAt,
  );

describe("talker: fast replies while the task waits", () => {
  test("waiting on a question: replies as the agent, with the question in its snapshot, usage recorded", async () => {
    const { run, write, decisions } = await waitingOnQuestion(() => replyJson(REPLY));
    const asked = await write("já fez o deploy?");
    expect(decisions).toEqual(["reply"]);

    const [call] = talkerCalls();
    const prompt = textOf(call?.request.messages[0]?.content ?? "");
    const { snapshot } = JSON.parse(prompt) as { snapshot: { waitingOn: string[] } };
    expect(snapshot.waitingOn).toEqual([expect.stringContaining(QUESTION)]);
    expect(prompt).toContain("já fez o deploy?");
    expect(prompt).toContain("faz o deploy da versão nova");
    expect(call?.request.outputSchema).toMatchObject({ required: ["action", "text"] });

    // Posted as the agent where the run answers (the main timeline), marked as a fast reply and a notice.
    const main = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    const reply = main.find((m) => m.body === REPLY);
    expect(reply).toMatchObject({ author: { type: "agent", id: f.agent.id }, threadId: null });
    expect(reply?.meta).toMatchObject({
      talker: { runId: run.id, inReplyTo: asked.id },
      notice: { kind: "talker_reply", text: REPLY },
    });
    // Queued for the task ahead of the person's message (never the last: a redispatch answers the person).
    const [after] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.id));
    expect(after?.pendingMessageIds).toEqual([reply?.id ?? "", asked.id]);
    // Usage on the org's cheap model, recorded with the agent and the run.
    const usage = await f.db.select().from(schema.usageRecords).where(eq(schema.usageRecords.kind, "router"));
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ agentId: f.agent.id, runId: run.id, requestedModel: "claude-haiku-5-5" });
  });

  test("the reply reaches the task as a notice, and starts no run", async () => {
    const { run, write } = await waitingOnQuestion(() => replyJson(REPLY));
    await write("já fez o deploy?");
    // Its `message.posted` job routes nobody (no new run); the question is still open.
    await drainOutbox(f.db, f.handlers);
    expect(await f.db.select().from(schema.agentRuns)).toHaveLength(1);
    const [question] = await f.db.select().from(schema.agentQuestions);
    expect(question?.status).toBe("open");

    await answerQuestion({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, question?.id ?? "", {
      choice: "staging",
    });
    await drainOutbox(f.db, f.handlers);
    const [done] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.id));
    expect(done?.status).toBe("done");
    // The task read the answer, what it already said (as its own, not a person's) and the person's message.
    const agentCalls = f.provider.calls.filter((c) => !isTalkerCall(c.request));
    const read = JSON.stringify(agentCalls.at(-1)?.request.messages);
    expect(read).toContain("The person answered: staging");
    expect(read).toContain(`[You already told them, while you worked]: ${REPLY}`);
    expect(read).toContain("já fez o deploy?");
    expect(read).not.toContain(`New message from Dev`);
    expect(await talkerMessages()).toHaveLength(1);
  });

  test("the task's reply landed meanwhile, in the place its words first showed above the message: no fast reply", async () => {
    // While the cheap model answers, the task posts the reply it was writing when the person wrote.
    const landed = async () => {
      const [asked] = await f.db.select().from(schema.messages).where(eq(schema.messages.body, "já fez o deploy?"));
      const [run] = await f.db.select().from(schema.agentRuns);
      await insertMessage(f.db, {
        orgId: f.org.id,
        channelId: f.general.id,
        author: { type: "agent", agentId: f.agent.id, runId: run?.id ?? "", hop: 1 },
        body: "Deploy em staging feito.",
        createdAt: new Date((asked?.createdAt.getTime() ?? 0) - 5_000),
      });
    };
    const { write, decisions } = await waitingOnQuestion(() => ({ ...replyJson(REPLY), hold: landed() }));
    await write("já fez o deploy?");
    expect(decisions).toEqual(["answered"]);
    expect(await talkerMessages()).toHaveLength(0);
  });

  test("one reply per run in 30 s; another after the gap, for a new message", async () => {
    let clock = new Date();
    const { write, decisions } = await waitingOnQuestion(() => replyJson(REPLY), { now: () => clock });
    await write("já fez o deploy?");
    await write("e aí?");
    expect(decisions).toEqual(["reply", "rate_limited"]);
    expect(talkerCalls()).toHaveLength(1);

    clock = new Date(Date.now() + TALKER_MIN_GAP_MS + 1000);
    await write("alguém aí?");
    expect(decisions.at(-1)).toBe("reply");
    expect(await talkerMessages()).toHaveLength(2);
  });

  test("the model passes: nothing is posted", async () => {
    const pass = await waitingOnQuestion(() => ({ chunks: ['{"action":"pass","text":""}'] }));
    await pass.write("ok, valeu");
    expect(pass.decisions).toEqual(["pass"]);
    expect(await talkerMessages()).toHaveLength(0);
    await f.close();

    // A question it lets pass still gets the server's status line (ADR 0131 §2).
    const ping = await waitingOnQuestion(() => ({ chunks: ['{"action":"pass","text":""}'] }));
    await ping.write("??");
    expect(ping.decisions).toEqual(["reply"]);
    expect((await talkerMessages()).map((m) => (m.meta as Record<string, unknown>).bodyCode)).toEqual([
      "talker_status",
    ]);
    await f.close();

    const never = new Promise<void>(() => {});
    const late = await waitingOnQuestion(() => ({ chunks: ['{"action":', '"reply"}'], hold: never }), {
      timeoutMs: 50,
    });
    const started = Date.now();
    await late.write("já fez o deploy?");
    expect(Date.now() - started).toBeLessThan(2000);
    // Too late is no answer: the server's own status line goes instead (ADR 0131 §2).
    expect(late.decisions).toEqual(["reply"]);
    expect((await talkerMessages()).map((m) => (m.meta as Record<string, unknown>).bodyCode)).toEqual([
      "talker_status",
    ]);
  });

  test("the cheap model can't answer (no key, an outage): the person still hears what the task does", async () => {
    const down = await waitingOnQuestion(() => {
      throw new Error("no API key");
    });
    await down.write("ta fazendo oq ai?");
    expect(down.decisions).toEqual(["reply"]);
    const [line] = await talkerMessages();
    const meta = line?.meta as { bodyCode?: string; bodyParams?: Record<string, string>; talker?: unknown };
    expect(meta.bodyCode).toBe("talker_status");
    expect(Number(meta.bodyParams?.minutes)).toBeGreaterThanOrEqual(1);
    expect(line?.body).toContain("in the middle of a task");
  });

  test('an agent waiting for its computer says so: no "middle of a task", and the minutes are the wait\'s', async () => {
    f = await setup();
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev analisa os logs",
    });
    const [run] = await f.db.select().from(schema.agentRuns);
    if (!run) throw new Error("no run");
    const { machineId } = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, RUNNER);
    const park = (status: "waiting_input" | "running", wait: Record<string, unknown>, machine: string | null) =>
      f.db
        .update(schema.agentRuns)
        .set({
          status,
          startedAt: new Date(Date.now() - 40 * 60_000),
          waitingMachineId: machine,
          transcript: { ...wait, roomWaitSince: Date.now() - 11 * 60_000 },
        })
        .where(eq(schema.agentRuns.id, run.id));
    const line = { waitingForBrain: { kind: "claude_code", machineId, code: "busy", waitId: "w1" } };

    await park("waiting_input", line, machineId);
    const [waiting] = await f.db.select().from(schema.agentRuns);
    const inLine = await statusReply(f.db, waiting as NonNullable<typeof waiting>, new Date());
    expect(inLine.text).not.toContain("middle of a task");
    expect(inLine.meta.bodyParams).toMatchObject({ minutes: "11", wait: "queued" });

    // Asking again from the line, the row says `running` for a moment: the same wait.
    await park("running", {}, machineId);
    const [asking] = await f.db.select().from(schema.agentRuns);
    expect((await statusReply(f.db, asking as NonNullable<typeof asking>, new Date())).meta.bodyParams).toMatchObject({
      minutes: "11",
      wait: "queued",
    });

    await park(
      "waiting_input",
      { waitingForBrain: { kind: "claude_code", machineId, code: "machine_offline" } },
      machineId,
    );
    const [away] = await f.db.select().from(schema.agentRuns);
    const gone = await statusReply(f.db, away as NonNullable<typeof away>, new Date());
    expect(gone.text).not.toContain("middle of a task");
    expect(gone.meta.bodyParams).toMatchObject({ wait: "away" });
  });

  test('an agent parked on its plan or budget says it waits for that and when it is back, never "middle of a task"', async () => {
    f = await setup();
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev analisa os logs",
    });
    const [run] = await f.db.select().from(schema.agentRuns);
    if (!run) throw new Error("no run");
    const resetsAt = new Date(Date.now() + 19 * 3600_000).toISOString();
    const park = async (waitingForBrain: Record<string, unknown>) => {
      await f.db
        .update(schema.agentRuns)
        .set({
          status: "waiting_input",
          startedAt: new Date(Date.now() - 19 * 3600_000),
          transcript: { waitingForBrain, usageWait: { since: Date.now() - 19 * 3600_000, step: 0 } },
        })
        .where(eq(schema.agentRuns.id, run.id));
      const [row] = await f.db.select().from(schema.agentRuns);
      return statusReply(f.db, row as NonNullable<typeof row>, new Date());
    };
    const plan = await park({ kind: "claude_code", machineId: "", code: "plan_limit", plan: "Claude", resetsAt });
    expect(plan.text).not.toContain("middle of a task");
    expect(plan.meta.bodyParams).toMatchObject({ wait: "plan", until: resetsAt, minutes: "0" });
    const unknown = await park({ kind: "claude_code", machineId: "", code: "plan_limit", plan: "Claude" });
    expect(unknown.meta.bodyParams).toEqual({ minutes: "0", steps: "0", wait: "plan" });
    const budget = await park({ kind: "model", machineId: "", code: "budget", resetsAt });
    expect(budget.meta.bodyParams).toMatchObject({ wait: "budget", until: resetsAt });
    expect(budget.text).toContain("budget");
  });

  test("a model-brain run moving along reads the message itself: no model call", async () => {
    f = await setup();
    const trigger = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev analisa os logs",
    });
    // Working (not drained): it steps at its next model call.
    const [run] = await f.db.select().from(schema.agentRuns);
    await f.db
      .update(schema.agentRuns)
      .set({ status: "running", startedAt: new Date() })
      .where(eq(schema.agentRuns.id, run?.id ?? ""));
    if (run) answerSteering(f, run);
    const { write, decisions } = talkerOn(trigger);
    await write("olha só os de ontem");
    expect(decisions).toEqual(["reads_soon"]);
    expect(f.provider.calls).toHaveLength(0);
  });

  test("waiting on an approval: the talker isn't asked", async () => {
    const { trigger } = await waitingOnApproval();
    const { write, decisions } = talkerOn(trigger);
    await write(ASKED);
    // The message gets a run of its own instead (waits.test.ts).
    expect(decisions).toEqual([]);
    expect(talkerCalls()).toHaveLength(0);
  });

  test("paused on an approval and handed the message on before the steering read the run: one answer", async () => {
    const { held, trigger } = await waitingOnApproval();
    const { talker, decisions } = talkerOn(trigger);
    // In this order: the message lands while the run works, the run pauses on the approval and hands it
    // on (the executor's `releaseHeldInbox`), and only then does the steering read the run.
    const message = await askedWhileWorking(held, trigger);
    const taken = await releaseHeldInbox(f.db, f.pubsub, held.id);
    expect(taken?.messageIds).toEqual([message.id]);
    const events = f.listen(f.general.id);
    await afterSteered(
      { db: f.db, pubsub: f.pubsub, talker },
      { orgId: f.org.id, userId: f.owner.id, channelId: f.general.id, message, runIds: [held.id], now: false },
    );
    await stopChecksSettled();

    // Nothing speaks for the held run: no fast reply, and no receipt (steered, held) that would point the
    // message back at it after it went to a run of its own.
    expect(decisions).toEqual([]);
    expect(talkerCalls()).toHaveLength(0);
    const types = events.map((e) => (e as { type: string }).type);
    expect(types.filter((t) => t === "agent.run.steered" || t === "agent.run.wait_message")).toEqual([]);
    await drainOutbox(f.db, f.handlers);
    const said = await saidAfter(message);
    expect(said.map((m) => [m.body, m.agentRunId])).toEqual([[ANSWER, taken?.runId ?? ""]]);
  });

  for (const approved of [false, true]) {
    test(`paused on an approval while the talker thought, handing the message on${approved ? ", then approved" : ""}: no fast reply`, async () => {
      let pause = async () => {};
      const { held, trigger } = await waitingOnApproval(() => ({ ...replyJson(REPLY), hold: pause() }));
      const setStatus = (status: "running" | "waiting_approval") =>
        f.db.update(schema.agentRuns).set({ status }).where(eq(schema.agentRuns.id, held.id));
      // Working again, deep in a long step by the talker's clock: a message to it gets the talker.
      await setStatus("running");
      const message = await askedWhileWorking(held, trigger);
      let taken = null as Awaited<ReturnType<typeof releaseHeldInbox>>;
      // While the talker thinks, the run pauses on the approval again and hands the message on.
      pause = async () => {
        await setStatus("waiting_approval");
        taken = await releaseHeldInbox(f.db, f.pubsub, held.id);
        // Approved before the talker posts: the run works again, the message is still the other run's.
        if (approved) await setStatus("running");
      };
      const { talker, decisions } = talkerOn(trigger, { now: () => new Date(Date.now() + TALKER_QUIET_MS + 1000) });
      await talker.consider({ run: { ...held, status: "running" }, message, live: false, waited: null });

      expect(decisions).toEqual(["held"]);
      expect(taken).toMatchObject({ messageIds: [message.id] });
      await drainOutbox(f.db, f.handlers);
      const said = await saidAfter(message);
      expect(said.map((m) => [m.body, m.agentRunId])).toEqual([[ANSWER, taken?.runId ?? ""]]);
    });
  }

  test("paused and handed the message on before the talker looked at the run again: no model call", async () => {
    const { held, trigger } = await waitingOnApproval();
    const message = await askedWhileWorking(held, trigger);
    expect(await releaseHeldInbox(f.db, f.pubsub, held.id)).toMatchObject({ messageIds: [message.id] });
    const { talker, decisions } = talkerOn(trigger, { now: () => new Date(Date.now() + TALKER_QUIET_MS + 1000) });
    // The steering read the run while it still worked.
    await talker.consider({ run: { ...held, status: "running" }, message, live: false, waited: null });
    expect(decisions).toEqual(["held"]);
    expect(talkerCalls()).toHaveLength(0);
  });
});

describe("talkerPolicy", () => {
  const now = new Date("2026-10-23T12:00:00Z");
  const base = {
    run: { status: "running" as const, background: false },
    brain: "model",
    message: { body: "e aí, como vai?", createdAt: now },
    waited: null,
    lastActivityAt: new Date(now.getTime() - 2000),
    lastReplyAt: null,
    now,
  };
  test("model brain: only when quiet for a while", () => {
    expect(talkerPolicy(base)).toBe("reads_soon");
    expect(talkerPolicy({ ...base, lastActivityAt: new Date(now.getTime() - 25_000) })).toBeNull();
    expect(talkerPolicy({ ...base, run: { status: "queued", background: false } })).toBe("reads_soon");
  });
  test("computer brain mid-turn and waiting runs: considered", () => {
    expect(talkerPolicy({ ...base, brain: "claude_code" })).toBeNull();
    expect(talkerPolicy({ ...base, run: { status: "waiting_input", background: false } })).toBeNull();
    expect(talkerPolicy({ ...base, waited: { waitKind: "approval", outcome: "held" } })).toBeNull();
  });
  test("a computer brain that only just started reads it with its first turn: no 'noted' for the rest of a burst", () => {
    const run = (ago: number) => ({
      status: "running" as const,
      background: false,
      startedAt: new Date(now.getTime() - ago),
    });
    expect(talkerPolicy({ ...base, brain: "claude_code", run: run(3000) })).toBe("reads_soon");
    expect(talkerPolicy({ ...base, brain: "codex", run: run(25_000) })).toBeNull();
  });
  test("skips background work, a wait the message ended, and replies too close", () => {
    expect(talkerPolicy({ ...base, brain: "claude_code", run: { status: "running", background: true } })).toBe(
      "background",
    );
    // A stop is the same in every language: no word list skips it, the model passes and the stop judge cancels.
    for (const body of ["Para!", "Stop!", "止めて！", "Hör auf!"]) {
      expect(talkerPolicy({ ...base, brain: "claude_code", message: { body, createdAt: now } })).toBeNull();
    }
    expect(talkerPolicy({ ...base, waited: { waitKind: "browser_handoff", outcome: "resolved" } })).toBe("resolved");
    const waiting = { ...base, run: { status: "waiting_approval" as const, background: false } };
    expect(talkerPolicy({ ...waiting, lastReplyAt: new Date(now.getTime() - 10_000) })).toBe("rate_limited");
    // Never two in a row without a new person message.
    expect(
      talkerPolicy({
        ...waiting,
        message: { body: "oi", createdAt: new Date(now.getTime() - 60_000) },
        lastReplyAt: new Date(now.getTime() - 40_000),
      }),
    ).toBe("rate_limited");
    expect(talkerPolicy({ ...waiting, lastReplyAt: new Date(now.getTime() - 40_000) })).toBeNull();
  });
});

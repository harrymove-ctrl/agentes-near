import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import {
  answerQuestion,
  createMission,
  drainOutbox,
  getMission,
  KEEP_GOING_JOB,
  KEEP_GOING_PROMPT,
  keepGoingBlocker,
  keepMissionGoing,
  type MachineHub,
  MISSION_STUCK,
  openDm,
  pauseMission,
  postPersonMessage,
  resumeMission,
  STRETCH,
  startMission,
  stretchCardOf,
  updatePlan,
} from "../src";
import { type Fixture, setup } from "./fixtures";
import { missionRunner, pairedMachine } from "./mission-helpers";

let f: Fixture;
afterEach(async () => {
  await f?.machineHub?.stop();
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const md = () => f.missionDeps;
const missionRow = async () => (await f.db.select().from(schema.missions))[0] as typeof schema.missions.$inferSelect;
const lastText = (req: ModelRequest) => JSON.stringify(req.messages.at(-1)?.content ?? "");
const keepGoingJobs = () => f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, KEEP_GOING_JOB));
/** The keep-going checks come due now (they wait a minute after a run ends). */
const dueNow = () =>
  f.db
    .update(schema.outbox)
    .set({ nextAttemptAt: new Date(Date.now() - 1000) })
    .where(and(eq(schema.outbox.kind, KEEP_GOING_JOB), eq(schema.outbox.status, "pending")));

const PLAN = [
  { id: "cli", title: "CLI", status: "todo" },
  { id: "report", title: "Relatório diário", status: "todo" },
];

/** An agent-mode mission (the model brain) on a paired computer; the agent is scripted by `reply`. */
async function agentMission(options: Parameters<typeof setup>[0]) {
  f = await setup({ machines: true, missionTools: true, ...options });
  const paired = await pairedMachine(f);
  const runner = missionRunner(f.machineHub as MachineHub, { executors: {} });
  await runner.hello(paired.token);
  return { paired, runner };
}

describe("a mission keeps going between people's messages", () => {
  test("a run that ends with plan items open and nothing waiting on a person: the mission goes on by itself", async () => {
    await agentMission({
      reply: (req) => {
        const last = lastText(req);
        if (last.includes("tool_result")) return { chunks: ["Feito."] };
        if (last.includes("PLAN MODE"))
          return { chunks: [], toolUses: [{ name: "update_plan", input: { items: PLAN } }] };
        if (last.includes("go on with the next one now")) {
          return {
            chunks: [],
            toolUses: [
              {
                name: "update_plan",
                input: {
                  items: [
                    { ...PLAN[0], status: "done" },
                    { ...PLAN[1], status: "doing" },
                  ],
                },
              },
            ],
          };
        }
        // Started: it says what it will do and ends its turn (what stopped the mission for an hour).
        return { chunks: ["Comecei pela CLI; termino o script e te mostro o primeiro relatório."] };
      },
    });
    const view = await createMission(md(), f.owner.id, f.org.id, {
      agentId: f.agent.id,
      channelId: f.general.id,
      goal: "Relatório diário",
      title: "Relatório",
    });
    await drainOutbox(f.db, f.handlers);
    await startMission(md(), f.owner.id, f.org.id, view.id);
    await drainOutbox(f.db, f.handlers);
    expect((await missionRow()).planDone).toBe(0);

    // The run ended: a check is scheduled a while later, not run at once.
    const pending = (await keepGoingJobs()).filter((j) => j.status === "pending");
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every((j) => j.nextAttemptAt.getTime() > Date.now())).toBe(true);

    await dueNow();
    await drainOutbox(f.db, f.handlers);
    const notice = (await f.db.select().from(schema.messages).where(eq(schema.messages.threadId, view.threadId))).find(
      (m) => (m.meta.missionInbox as { text?: string } | undefined)?.text === KEEP_GOING_PROMPT,
    );
    expect(notice).toBeTruthy();
    const woken = (await f.db.select().from(schema.agentRuns)).find((r) => r.triggerMessageId === notice?.id);
    expect(woken?.status).toBe("done");
    // It went on: the plan moved without anyone writing.
    const row = await missionRow();
    expect(row.planDone).toBe(1);
    expect(row.idleWakeups).toBe(0);
  });

  test("it doesn't go on when nothing is open, a person is asked, or the agent is at work; idle wake-ups pause it as stuck", async () => {
    await agentMission({ reply: () => ({ chunks: ["ok"] }) });
    const view = await createMission(md(), f.owner.id, f.org.id, {
      agentId: f.agent.id,
      channelId: f.general.id,
      goal: "Relatório diário",
      title: "Relatório",
    });
    expect(await keepGoingBlocker(f.db, await missionRow())).toBe("not_working");
    await drainOutbox(f.db, f.handlers);
    await startMission(md(), f.owner.id, f.org.id, view.id);
    await drainOutbox(f.db, f.handlers);

    await updatePlan(md(), await missionRow(), {
      items: PLAN.map((i) => ({ ...i, status: "waiting_you" })),
      source: "executor",
    });
    expect(await keepGoingBlocker(f.db, await missionRow())).toBe("no_open_items");
    expect(await keepMissionGoing(md(), view.id)).toBe(false);

    await updatePlan(md(), await missionRow(), { items: PLAN, source: "executor" });
    const mission = await missionRow();
    await f.db.insert(schema.missionDecisions).values({
      orgId: f.org.id,
      missionId: mission.id,
      question: "Qual banco?",
      options: ["A", "B"],
      blocking: true,
      status: "pending",
    });
    expect(await keepGoingBlocker(f.db, mission)).toBe("waiting_person");
    await f.db.delete(schema.missionDecisions);

    // It asked another agent for something an item needs: that answer wakes it, so nothing else does meanwhile.
    const [asker] = await f.db
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.threadRootId, mission.threadRootId));
    await f.db.insert(schema.agentConsultations).values({
      orgId: f.org.id,
      askerRunId: asker?.id as string,
      askerAgentId: f.agent.id,
      targetAgentId: f.agent.id,
      channelId: f.general.id,
      messageId: mission.threadRootId,
      waitId: "consult-1",
      question: "Qual é o formato do relatório?",
      chain: [f.agent.id],
      expiresAt: new Date(Date.now() + 600_000),
    });
    expect(await keepGoingBlocker(f.db, mission)).toBe("wakes_later");
    await f.db.delete(schema.agentConsultations);

    expect(await keepGoingBlocker(f.db, mission)).toBeNull();
    // Woken and not drained: its run is queued, so the next check holds.
    expect(await keepMissionGoing(md(), view.id)).toBe(true);
    expect(await keepGoingBlocker(f.db, await missionRow())).toBe("run_active");
    await drainOutbox(f.db, f.handlers);

    // Wake-ups that move nothing count: past the stuck guard the mission pauses instead of looping.
    for (let i = 1; i < MISSION_STUCK.idleWakeups; i++) {
      expect(await keepMissionGoing(md(), view.id)).toBe(true);
      await drainOutbox(f.db, f.handlers);
    }
    expect(await keepMissionGoing(md(), view.id)).toBe(false);
    expect((await missionRow()).status).toBe("paused");
  });

  test("a run that ends describing what it needs from a person is told to ask in a card; then the mission waits", async () => {
    const MISSING = "O que falta: 1. Uma credencial read-only do banco. 2. Um teste no Teams.";
    await agentMission({
      askUser: true,
      judge: (kind, _id, state) =>
        kind === "follow_through" && String(state.reply).includes("O que falta") ? "ask" : undefined,
      reply: (req) => {
        const last = lastText(req);
        if (last.includes("didn't ask them in a card")) {
          return {
            chunks: [],
            toolUses: [
              {
                name: "ask_user",
                input: {
                  question: "Pode me passar uma credencial read-only do banco?",
                  why: "The daily report reads the database, and only a person can give that access.",
                },
              },
            ],
          };
        }
        if (last.includes("leitura-de-teste")) return { chunks: ["Recebi, sigo com o relatório."] };
        if (last.includes("tool_result")) return { chunks: [""] };
        if (last.includes("PLAN MODE"))
          return { chunks: [], toolUses: [{ name: "update_plan", input: { items: PLAN } }] };
        // Its status card is the whole answer: a list of what is missing, no question.
        return { chunks: [], toolUses: [{ name: "report", input: { summary: MISSING } }] };
      },
    });
    const view = await createMission(md(), f.owner.id, f.org.id, {
      agentId: f.agent.id,
      channelId: f.general.id,
      goal: "Relatório diário",
      title: "Relatório",
    });
    await drainOutbox(f.db, f.handlers);
    await startMission(md(), f.owner.id, f.org.id, view.id);
    await drainOutbox(f.db, f.handlers);

    // The report card was what got judged.
    const judged = (f.context.judge as unknown as { calls: { kind: string; state: { reply: string } }[] }).calls.filter(
      (c) => c.kind === "follow_through",
    );
    expect(judged.some((c) => c.state.reply.includes("O que falta"))).toBe(true);
    // It asked in a card: the run waits on the person, and the mission doesn't go on by itself meanwhile.
    const [question] = await f.db.select().from(schema.agentQuestions);
    expect(question).toMatchObject({ status: "open", threadId: view.threadId });
    const runs = await f.db
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.id, question?.runId as string));
    expect(runs[0]?.status).toBe("waiting_input");
    expect(await keepGoingBlocker(f.db, await missionRow())).toBe("run_active");

    // Answered: the same run goes on and ends; the old turn's "waiting" no longer holds the mission.
    await answerQuestion({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, question?.id ?? "", {
      text: "leitura-de-teste",
    });
    await drainOutbox(f.db, f.handlers);
    const [resumed] = await f.db
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.id, question?.runId as string));
    expect(resumed?.status).toBe("done");
    expect(await keepGoingBlocker(f.db, await missionRow())).toBeNull();
  });

  test("its own wake-ups count in a stretch: past the limit, the pause card instead, even while the plan keeps changing", async () => {
    await agentMission({ reply: () => ({ chunks: ["ok"] }) });
    const view = await createMission(md(), f.owner.id, f.org.id, {
      agentId: f.agent.id,
      channelId: f.general.id,
      goal: "Relatório diário",
      title: "Relatório",
    });
    await drainOutbox(f.db, f.handlers);
    await startMission(md(), f.owner.id, f.org.id, view.id);
    await drainOutbox(f.db, f.handlers);
    let woke = 0;
    for (let i = 0; i < STRETCH.unattendedRuns + 2; i++) {
      // A plan that changes on every wake resets the stuck guard: only the stretch holds it.
      await updatePlan(md(), await missionRow(), {
        items: [...PLAN, { id: `again-${i}`, title: `Verificar de novo ${i}`, status: "todo" }],
        source: "executor",
      });
      if (!(await keepMissionGoing(md(), view.id))) break;
      woke++;
      await drainOutbox(f.db, f.handlers);
    }
    expect(woke).toBe(STRETCH.unattendedRuns);
    expect((await missionRow()).status).toBe("active");
    await drainOutbox(f.db, f.handlers);
    const cards = (await f.db.select().from(schema.messages).where(eq(schema.messages.threadId, view.threadId))).filter(
      (m) => stretchCardOf(m.meta)?.state === "paused",
    );
    expect(cards).toHaveLength(1);
  });

  test("waiting on a card that already asks the person, it isn't told to ask again", async () => {
    await agentMission({
      askUser: true,
      judge: (kind, _id, state) =>
        kind === "follow_through" && String(state.reply).includes("Aguardo") ? "ask" : undefined,
      reply: (req) => {
        const last = lastText(req);
        if (last.includes("didn't ask them in a card"))
          return {
            chunks: [],
            toolUses: [
              {
                name: "ask_user",
                input: {
                  question: "Você revisou o relatório?",
                  why: "The report waits on the person's review before it goes out to anyone.",
                },
              },
            ],
          };
        if (last.includes("tool_result")) return { chunks: [""] };
        if (last.includes("PLAN MODE"))
          return { chunks: [], toolUses: [{ name: "update_plan", input: { items: PLAN } }] };
        return { chunks: ["Aguardo sua revisão do relatório."] };
      },
    });
    const view = await createMission(md(), f.owner.id, f.org.id, {
      agentId: f.agent.id,
      channelId: f.general.id,
      goal: "Relatório diário",
      title: "Relatório",
    });
    await drainOutbox(f.db, f.handlers);
    await startMission(md(), f.owner.id, f.org.id, view.id);
    await f.db.insert(schema.missionReviews).values({ orgId: f.org.id, missionId: view.id, title: "Relatório v1" });
    await drainOutbox(f.db, f.handlers);
    const judged = (f.context.judge as unknown as { calls: { kind: string }[] }).calls;
    // The card that asks brings the mission back: nothing to judge (ADR 0097).
    expect(judged.some((c) => c.kind === "follow_through")).toBe(false);
    const steps = await f.db.select().from(schema.agentRunSteps);
    expect(steps.some((st) => (st.data as { nudged?: string }).nudged === "mission_ask")).toBe(false);
    expect(await f.db.select().from(schema.agentQuestions)).toHaveLength(0);
    expect(await keepGoingBlocker(f.db, await missionRow())).toBe("waiting_person");
  });
});

describe("the mission's computer and its conversations", () => {
  test("on the workspace's own computer the mission never asks for one", async () => {
    const { paired } = await agentMission({ reply: () => ({ chunks: ["ok"] }) });
    // The Cloud's computer: the workspace's, paired by nobody.
    await f.db
      .update(schema.machines)
      .set({ kind: "managed", pairedByUserId: null })
      .where(eq(schema.machines.id, paired.machineId));
    const view = await createMission(md(), f.owner.id, f.org.id, {
      agentId: f.agent.id,
      channelId: f.general.id,
      goal: "Relatório diário",
      title: "Relatório",
    });
    expect(view.machine?.id).toBe(paired.machineId);
    expect(view.needsComputer).toBe(false);
    await drainOutbox(f.db, f.handlers);
    await startMission(md(), f.owner.id, f.org.id, view.id);
    await pauseMission(md(), f.owner.id, f.org.id, view.id);
    expect((await resumeMission(md(), f.owner.id, f.org.id, view.id)).status).toBe("active");
    expect((await getMission(md(), f.owner.id, f.org.id, view.id)).needsComputer).toBe(false);
  });

  test("in the agent's DM, the mission's thread and the main timeline are separate conversations worked in parallel", async () => {
    await agentMission({ reply: () => ({ chunks: ["ok"] }) });
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    const view = await createMission(md(), f.owner.id, f.org.id, {
      agentId: f.agent.id,
      channelId: dm.id,
      goal: "Relatório diário",
      title: "Relatório",
    });
    // The mission's run is queued in its thread (not drained).
    const [missionRun] = await f.db.select().from(schema.agentRuns);
    expect(missionRun?.threadRootId).toBe(view.threadId);

    // Something else at the DM's top level: a run of its own, never steered into the mission's.
    const aside = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, dm.id, {
      body: "Me lembra de pagar o boleto amanhã",
    });
    expect(aside.meta.steeredRunIds).toBeUndefined();
    const own = (await f.db.select().from(schema.agentRuns)).find((r) => r.triggerMessageId === aside.id);
    expect(own?.threadRootId).toBe(aside.id);

    // A reply in the mission's thread goes to the mission's run, not to the newer one at the top level.
    const reply = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, dm.id, {
      body: "Qual andamento?",
      threadId: view.threadId,
    });
    expect(reply.meta.steeredRunIds).toEqual([missionRun?.id]);
  });
});

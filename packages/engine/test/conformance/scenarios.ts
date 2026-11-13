import { expect } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  addChannelMember,
  answerQuestion,
  createAgent,
  createAgentRuns,
  createChannel,
  insertMessage,
  queueOnRun,
  stopRoutineRun,
} from "../../src";
import { deliverNotice } from "../../src/delivery";
import { messagesIn, notificationsOf } from "../routine-fixtures";
import {
  agentPosts,
  agentRuns,
  approveAll,
  type Harness,
  routineRunOf,
  runRoutine,
  type Scenario,
  type ScriptCall,
  type ScriptRun,
  say,
  stepsOf,
} from "./harness";

/**
 * The scenarios every brain must play the same way (ADR 0053 §12). Each one is a script of steps (what
 * the brain says and calls), how the work starts, and the end state it must reach: messages and where,
 * run status, approvals with their why and origin, run steps, the routine ledger, notifications.
 */

// Reasons for the people deciding (at least `WHY_MIN_CHARS`).
const WHY_DEPLOY = "O erro 500 do checkout voltou depois do deploy 2.14; a 2.15 corrige o cálculo do frete.";
const WHY_ASK = "O formulário da viagem pede a data de ida e o e-mail do cliente fala em duas datas.";
const WHY_CRM = "A Acme Corp abriu 3 chamados de cancelamento esta semana; marco como risco de churn.";

/** What a routine hands off, and what the run its report wakes tells the people. */
const REPORT = "12 erros novos no checkout desde as 9h, todos no cálculo do frete.";
const RECORD = "Checado: 12 erros novos no checkout, reportados.";
const TOLD = "Apareceram 12 erros novos no checkout desde as 9h (cálculo do frete); sugiro reverter a 2.14.";

/** The routine's run hands off its report, then ends with its record. */
const handsOff: ScriptRun = {
  background: true,
  steps: [{ calls: [{ name: "hand_off", input: { message: REPORT, wake_me: true } }] }, { text: RECORD }],
};

const look: ScriptCall = { name: "look", input: {} };

/** The one run of the scenario. */
async function onlyRun(h: Harness) {
  const runs = await agentRuns(h);
  expect(runs).toHaveLength(1);
  return runs[0] as (typeof runs)[number];
}

/** A routine's work posts nothing anywhere: no agent message, nothing in the conversation it reports to. */
async function nothingPosted(h: Harness) {
  expect(await agentPosts(h)).toEqual([]);
  expect(await messagesIn(h.f, h.f.general.id)).toEqual([]);
}

export const SCENARIOS: Scenario[] = [
  {
    name: "1. a plain answer, where it was asked",
    runs: [{ steps: [{ text: "Passou sim: o deploy de ontem passou em todos os testes." }] }],
    async start(h) {
      h.vars.ask = (await say(h, "@dev o deploy de ontem passou?")).id;
      await h.drain();
    },
    async end(h) {
      const run = await onlyRun(h);
      expect(run).toMatchObject({ status: "done", trigger: "mention", triggerMessageId: h.vars.ask });
      const general = await messagesIn(h.f, h.f.general.id);
      expect(general.map((m) => [m.authorType, m.threadId, m.body])).toEqual([
        ["person", null, "@dev o deploy de ontem passou?"],
        ["agent", null, "Passou sim: o deploy de ontem passou em todos os testes."],
      ]);
      expect(run.replyMessageId).toBe(general[1]?.id ?? "");
    },
  },

  {
    name: "2. a read tool through the gateway: its steps recorded, the answer posted",
    runs: [{ steps: [{ calls: [look] }, { text: "Há 3 PRs abertos e 12 erros novos no checkout." }] }],
    async start(h) {
      await say(h, "@dev como estão os PRs?");
      await h.drain();
    },
    async end(h) {
      const run = await onlyRun(h);
      expect(run.status).toBe("done");
      expect(h.counts.look).toBe(1);
      expect(await stepsOf(h, run.id, "tool_call")).toMatchObject([{ name: "look" }]);
      expect(await stepsOf(h, run.id, "tool_result")).toMatchObject([
        { name: "look", isError: false, content: "3 PRs open; 12 new checkout errors since 9:00" },
      ]);
      expect((await agentPosts(h, h.f.general.id)).map((m) => m.body)).toEqual([
        "Há 3 PRs abertos e 12 erros novos no checkout.",
      ]);
    },
  },

  {
    name: "3. a sensitive tool: a card with the agent's why, approved, the run resumes with the result",
    runs: [
      {
        steps: [
          { calls: [{ name: "deploy_app", input: { env: "prod", why: WHY_DEPLOY } }] },
          { text: "Deploy feito: a 2.15 está no ar." },
        ],
      },
    ],
    async start(h) {
      await say(h, "@dev faz o deploy da 2.15");
      await h.drain();
      await approveAll(h);
      await h.drain();
    },
    async end(h) {
      const run = await onlyRun(h);
      expect(run.status).toBe("done");
      expect(h.counts.deploy).toBe(1);
      const approvals = await h.f.db.select().from(schema.approvals);
      expect(approvals).toHaveLength(1);
      const [approval] = approvals;
      expect(approval).toMatchObject({
        tool: "deploy_app",
        status: "approved",
        why: WHY_DEPLOY,
        origin: null,
        channelId: h.f.general.id,
        params: { env: "prod" },
      });
      const posts = await agentPosts(h, h.f.general.id);
      expect(posts.map((m) => (m.meta.approvalId ? "card" : m.body))).toEqual([
        "card",
        "Deploy feito: a 2.15 está no ar.",
      ]);
      expect(posts[0]?.meta).toMatchObject({ approvalId: approval?.id, why: WHY_DEPLOY });
      expect(approval?.messageId).toBe(posts[0]?.id ?? "");
      expect(await stepsOf(h, run.id, "tool_result")).toContainEqual(
        expect.objectContaining({ approvalId: approval?.id, isError: false, content: "Deployed 2.15 to production." }),
      );
    },
  },

  {
    name: "4. ask_user with its why: the person answers, the run resumes with it",
    runs: [
      {
        steps: [
          {
            calls: [
              {
                name: "ask_user",
                input: { question: "Qual data de ida eu coloco?", choices: ["12/11", "19/11"], why: WHY_ASK },
              },
            ],
          },
          { text: "Combinado: ida em 12/11." },
        ],
      },
    ],
    async start(h) {
      await say(h, "@dev cria a viagem para o Chile");
      await h.drain();
      const open = await h.f.db.select().from(schema.agentQuestions).where(eq(schema.agentQuestions.status, "open"));
      expect(open).toHaveLength(1);
      await answerQuestion({ db: h.f.db, pubsub: h.f.pubsub }, h.f.owner.id, h.f.org.id, open[0]?.id ?? "", {
        choice: "12/11",
      });
      await h.drain();
    },
    async end(h) {
      const run = await onlyRun(h);
      expect(run.status).toBe("done");
      const [question] = await h.f.db.select().from(schema.agentQuestions);
      expect(question).toMatchObject({ status: "answered", answer: "12/11", channelId: h.f.general.id });
      const posts = await agentPosts(h, h.f.general.id);
      expect(posts.map((m) => (m.meta.question ? "card" : m.body))).toEqual(["card", "Combinado: ida em 12/11."]);
      expect(posts[0]?.meta).toMatchObject({ questionId: question?.id, why: WHY_ASK });
    },
  },

  {
    name: "5. a run the router picked passes: nothing posted",
    runs: [{ steps: [{ calls: [{ name: "pass", input: { reason: "Nada a acrescentar." } }] }, { text: "" }] }],
    async start(h) {
      const said = await insertMessage(h.f.db, {
        orgId: h.f.org.id,
        channelId: h.f.general.id,
        author: { type: "person", userId: h.f.owner.id },
        body: "alguém viu o deploy de hoje?",
      });
      await h.f.db.transaction((tx) => createAgentRuns(tx, said, [h.f.agent.id], "router"));
      await h.drain();
    },
    async end(h) {
      const run = await onlyRun(h);
      expect(run).toMatchObject({ status: "done", trigger: "router" });
      expect(await agentPosts(h)).toEqual([]);
      expect(await stepsOf(h, run.id, "context")).toContainEqual(
        expect.objectContaining({ passed: { how: "pass", reason: "Nada a acrescentar.", silent: true } }),
      );
    },
  },

  {
    name: "6. react ends the run silently: the reaction is the answer",
    runs: [{ steps: [{ calls: [{ name: "react", input: { emoji: "👍" } }] }, { text: "" }] }],
    async start(h) {
      h.vars.ask = (await say(h, "@dev valeu, ficou ótimo!")).id;
      await h.drain();
    },
    async end(h) {
      expect((await onlyRun(h)).status).toBe("done");
      expect(await agentPosts(h)).toEqual([]);
      const reactions = await h.f.db
        .select()
        .from(schema.messageReactions)
        .where(eq(schema.messageReactions.messageId, h.vars.ask ?? ""));
      expect(reactions.map((r) => r.agentId)).toEqual([h.f.agent.id]);
    },
  },

  {
    name: "7. a routine finds nothing: its ledger is silent, nothing is posted anywhere",
    runs: [{ background: true, steps: [{ calls: [look] }, { text: "Nada novo desde ontem: os mesmos 3 PRs." }] }],
    async start(h) {
      await runRoutine(h);
    },
    async end(h) {
      const run = await onlyRun(h);
      expect(run).toMatchObject({ status: "done", background: true });
      expect(await routineRunOf(h)).toMatchObject({
        status: "silent",
        summary: "Nada novo desde ontem: os mesmos 3 PRs.",
        agentRunId: run.id,
        brain: h.kind,
        messageId: null,
      });
      await nothingPosted(h);
      expect(await notificationsOf(h.f, "routine_failed")).toEqual([]);
    },
  },

  {
    name: "8. a routine hands off: the notice where it reports, the woken run tells people, the ledger links it",
    runs: [handsOff, { steps: [{ text: TOLD }] }],
    async start(h) {
      await runRoutine(h);
    },
    async end(h) {
      const [background, woken, ...rest] = await agentRuns(h);
      expect(rest).toEqual([]);
      expect(background).toMatchObject({ status: "done", background: true });
      expect(woken).toMatchObject({ status: "done", background: false, channelId: h.f.general.id });
      const rr = await routineRunOf(h);
      const general = await messagesIn(h.f, h.f.general.id);
      expect(general.map((m) => [m.authorType, m.body])).toEqual([
        ["agent", REPORT],
        ["agent", TOLD],
      ]);
      const [notice, told] = general;
      expect(notice?.meta.notice).toMatchObject({
        kind: "routine_handoff",
        text: REPORT,
        refs: { runId: background?.id, routineId: h.vars.routineId, routineRunId: rr.id },
      });
      expect(woken?.triggerMessageId).toBe(notice?.id ?? "");
      expect(told?.meta.routine).toEqual({
        id: h.vars.routineId,
        name: "Erros do checkout",
        runId: rr.id,
        noticeId: notice?.id,
      });
      expect(rr).toMatchObject({ status: "reported", summary: RECORD, messageId: told?.id, brain: h.kind });
      // The routine's room holds only its brief: nothing of the agent's.
      expect((await agentPosts(h)).map((m) => m.id)).toEqual([told?.id ?? ""]);
    },
  },

  {
    name: "9a. a routine works as its agent (ADR 0109): an internal write runs, nothing asks anyone",
    runs: [
      {
        background: true,
        steps: [
          { calls: [{ name: "file_issue", input: { title: "Checkout lento" } }] },
          { text: "O checkout está lento; registrei a issue #7." },
        ],
      },
    ],
    async start(h) {
      await runRoutine(h);
    },
    async end(h) {
      const run = await onlyRun(h);
      expect(run.status).toBe("done");
      expect(h.counts.file).toBe(1);
      expect(await stepsOf(h, run.id, "tool_result")).toEqual([
        expect.objectContaining({ name: "file_issue", isError: false, content: "Issue #7 created." }),
      ]);
      expect(await h.f.db.select().from(schema.approvals)).toEqual([]);
    },
  },

  {
    name: "9b. a routine: a connected app's write becomes a card where it reports, from the routine",
    runs: [
      {
        background: true,
        steps: [
          {
            calls: [
              { name: "crm_update_contact", input: { contact: "Acme Corp", status: "churn_risk", why: WHY_CRM } },
            ],
          },
          { text: "Marquei a Acme Corp." },
        ],
      },
    ],
    async start(h) {
      await runRoutine(h, { access: "act" });
    },
    async end(h) {
      const run = await onlyRun(h);
      expect(run).toMatchObject({ status: "waiting_approval", background: true });
      expect(h.counts.crm).toBe(0);
      const approvals = await h.f.db.select().from(schema.approvals);
      expect(approvals).toHaveLength(1);
      const [approval] = approvals;
      const origin = { kind: "routine", routineId: h.vars.routineId, routineName: "Erros do checkout" };
      expect(approval).toMatchObject({
        tool: "crm_update_contact",
        status: "pending",
        channelId: h.f.general.id,
        why: WHY_CRM,
        origin,
      });
      // Only the card, in the conversation it reports to (never its room).
      const posts = await agentPosts(h);
      expect(posts).toHaveLength(1);
      expect(posts[0]).toMatchObject({
        channelId: h.f.general.id,
        meta: { approvalId: approval?.id, why: WHY_CRM, origin },
      });
      // Still open: it waits for the person.
      expect(await routineRunOf(h)).toMatchObject({ status: "started", finishedAt: null });
    },
  },

  {
    name: "10. the run a report woke works as the agent itself: it posts in another channel it is in",
    runs: [
      handsOff,
      {
        steps: [
          { calls: [{ name: "post_message", input: { channel: "tech", text: "Erro novo no checkout." } }] },
          { text: TOLD },
        ],
      },
    ],
    async start(h) {
      const tech = await createChannel(h.f.db, h.f.owner.id, h.f.org.id, { name: "tech" });
      await addChannelMember(h.f.db, h.f.owner.id, h.f.org.id, tech.id, { agentId: h.f.agent.id });
      h.vars.tech = tech.id;
      await runRoutine(h);
    },
    async end(h) {
      const [, woken] = await agentRuns(h);
      expect(woken).toMatchObject({ status: "done", background: false });
      expect(await stepsOf(h, woken?.id ?? "", "tool_result")).toEqual([
        expect.objectContaining({ name: "post_message", isError: false }),
      ]);
      expect((await messagesIn(h.f, h.vars.tech ?? "")).map((m) => m.body)).toEqual(["Erro novo no checkout."]);
      expect((await agentPosts(h)).map((m) => [m.channelId, m.body])).toEqual([
        [h.vars.tech ?? "", "Erro novo no checkout."],
        [h.f.general.id, TOLD],
      ]);
    },
  },

  {
    name: "11. a person stops a routine's run: canceled quietly, the ledger says who",
    runs: [{ background: true, steps: [{ calls: [look] }, { text: "Nada a reportar." }] }],
    async onLook(h) {
      await stopRoutineRun({ db: h.f.db, pubsub: h.f.pubsub }, h.f.owner.id, h.f.org.id, h.vars.routineId ?? "");
    },
    async start(h) {
      await runRoutine(h);
    },
    async end(h) {
      expect((await onlyRun(h)).status).toBe("canceled");
      expect(h.counts.look).toBe(1);
      expect(await routineRunOf(h)).toMatchObject({ status: "canceled", code: "stopped", summary: h.f.owner.id });
      await nothingPosted(h);
    },
  },

  {
    name: "12. a routine's run fails: its ledger fails with the code, nothing is posted, its creator hears once",
    runs: [{ background: true, steps: [{ calls: [look] }, { crash: "The brain stopped unexpectedly." }] }],
    async start(h) {
      await runRoutine(h);
    },
    async end(h) {
      expect((await onlyRun(h)).status).toBe("failed");
      // The code is the brain's own: the API's refusal, or the coding CLI that exited after a tool ran.
      expect(await routineRunOf(h)).toMatchObject({
        status: "failed",
        code: h.kind === "model" ? "provider_error" : "executor_crashed",
      });
      await nothingPosted(h);
      expect((await notificationsOf(h.f, "routine_failed")).map((n) => n.userId)).toEqual([h.f.owner.id]);
    },
  },

  {
    name: "13. the computer is away: the routine's run waits for it, never the API, and its people hear once",
    // The API brain has no computer to wait for: there is nothing to be away.
    skip: { model: "the API brain has no computer" },
    offline: true,
    runs: [{ background: true, steps: [{ text: "Nada novo." }] }],
    async start(h) {
      await runRoutine(h);
    },
    async end(h) {
      expect(await onlyRun(h)).toMatchObject({
        status: "waiting_input",
        background: true,
        waitingMachineId: h.machineId,
      });
      expect(h.turns).toBe(0);
      expect(h.f.provider.calls).toHaveLength(0);
      expect(await routineRunOf(h)).toMatchObject({ status: "started", brain: h.kind, finishedAt: null });
      await nothingPosted(h);
      expect((await notificationsOf(h.f, "routine_stalled")).map((n) => n.userId)).toEqual([h.f.owner.id]);
    },
  },

  {
    name: "14. a person writes into a running run: it reads it (receipt) and owes them an answer (no pass)",
    runs: [
      {
        steps: [
          { calls: [look], turnEnds: true },
          { calls: [{ name: "pass", input: { reason: "nada a acrescentar" } }] },
          { text: "O staging também foi atualizado." },
        ],
      },
    ],
    async onLook(h, ctx) {
      const said = await insertMessage(ctx.db, {
        orgId: h.f.org.id,
        channelId: h.f.general.id,
        threadId: h.vars.notice ?? null,
        author: { type: "person", userId: h.f.owner.id },
        body: "e o staging?",
      });
      h.vars.said = said.id;
      await queueOnRun(ctx.db, ctx.runId, said.id);
    },
    async start(h) {
      // A note from another agent wakes it: nobody is behind the run until a person writes into it.
      const delivered = await h.f.db.transaction((tx) =>
        deliverNotice(tx, {
          orgId: h.f.org.id,
          agentId: h.f.agent.id,
          channelId: h.f.general.id,
          threadId: null,
          hop: 0,
          stretchId: null,
          notice: { kind: "agent_note", text: "Mudei a variável DATABASE_URL.", from: "@infra", refs: {} },
        }),
      );
      h.vars.notice = delivered.message.id;
      await h.drain();
    },
    async end(h) {
      const run = await onlyRun(h);
      expect(run.status).toBe("done");
      expect(run.transcript).toMatchObject({ answerOwed: true, steeredBy: h.f.owner.id });
      // Read during the run (the receipt), not lost and not handed to another run.
      const read = h.events.filter((e) => e.type === "agent.run.read" && e.runId === run.id) as {
        messageIds?: string[];
      }[];
      expect(read.some((e) => e.messageIds?.includes(h.vars.said ?? ""))).toBe(true);
      expect(await stepsOf(h, run.id, "context")).toContainEqual(
        expect.objectContaining({ steeredMessageIds: [h.vars.said] }),
      );
      expect((await agentPosts(h)).map((m) => m.body)).toEqual(["O staging também foi atualizado."]);
    },
  },

  {
    name: "15. a run another agent's mention woke passes: nothing posted",
    runs: [{ steps: [{ calls: [{ name: "pass", input: { reason: "Só um obrigado." } }] }, { text: "" }] }],
    async start(h) {
      const qa = await createAgent(
        h.f.db,
        h.f.owner.id,
        h.f.org.id,
        { name: "QA", handle: "qa" },
        { model: "claude-sonnet-5-5" },
      );
      await addChannelMember(h.f.db, h.f.owner.id, h.f.org.id, h.f.general.id, { agentId: qa.id });
      const thanks = await insertMessage(h.f.db, {
        orgId: h.f.org.id,
        channelId: h.f.general.id,
        author: { type: "agent", agentId: qa.id, runId: null, hop: 1, stretchId: null },
        body: "Valeu, @dev!",
      });
      await h.f.db.transaction((tx) => createAgentRuns(tx, thanks, [h.f.agent.id], "mention"));
      await h.drain();
    },
    async end(h) {
      const run = await onlyRun(h);
      expect(run).toMatchObject({ status: "done", trigger: "mention" });
      expect((await agentPosts(h)).filter((m) => m.authorAgentId === h.f.agent.id)).toEqual([]);
      expect(await stepsOf(h, run.id, "context")).toContainEqual(
        expect.objectContaining({ passed: { how: "pass", reason: "Só um obrigado.", silent: true } }),
      );
    },
  },
];

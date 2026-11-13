import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import { systemText } from "@agenteschat/providers";
import {
  approverIds,
  continueRun,
  createAgent,
  createAgentFromProposal,
  createAgentRuns,
  createReminder,
  createSetupToolSource,
  createToolGateway,
  drainOutbox,
  grantScopes,
  insertMessage,
  NEW_AGENT_DEFAULTS,
  postPersonMessage,
  REFUSALS,
  type RoutineAccess,
  type RoutineBrief,
  type RunAuthority,
  replyPolicyFor,
  runAuthorityById,
  type ToolContext,
  type ToolSource,
  taskNotice,
  toolPolicy,
  wakeConversationForTask,
  wakeForAccessDecision,
} from "../src";
import { deliverNotice } from "../src/delivery";
import { openRoutineRoom } from "../src/routine-room";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";
import { channelRoutine, fire, routineDeps } from "./routine-fixtures";

/**
 * ADR 0053, addendum of 2026-10-31: whoever woke it, a run works within the agent's own permissions. Work that
 * comes back to an agent (a note's reply, a background task's end, a folder decision, a decision on an agent it
 * proposed) goes on for the person behind the run it comes back to; a run nobody is behind works as the agent
 * itself. Only a routine set to only look and tell reads.
 */

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

/** A run of @dev on message `id` (queued, as dispatch starts one). */
async function runOn(id: string, options: { background?: boolean } = {}) {
  const [m] = await f.db.select().from(schema.messages).where(eq(schema.messages.id, id));
  if (!m) throw new Error("no message");
  const [run] = await f.db.transaction((tx) =>
    createAgentRuns(tx, m as never, [f.agent.id], "mention", options.background ? { background: true } : {}),
  );
  if (!run) throw new Error("no run");
  return run;
}

/** Ana asks @dev in #general: a run she is behind. */
const anaAsks = async (body = "@dev faz o deploy de staging") =>
  runOn(
    (
      await insertMessage(f.db, {
        orgId: f.org.id,
        channelId: f.general.id,
        author: { type: "person", userId: f.owner.id },
        body,
      })
    ).id,
  );

/** A line @dev wrote on its own (a reminder, an offline notice): nobody is behind what it wakes. */
const agentLine = (body: string) =>
  insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "agent", agentId: f.agent.id, runId: null, hop: 1, stretchId: null },
    body,
  });

const briefOf = (access: RoutineAccess, channelId = f.general.id): RoutineBrief => ({
  routineId: crypto.randomUUID(),
  routineRunId: crypto.randomUUID(),
  name: "Sentry diário",
  creatorUserId: f.owner.id,
  deliverTo: { channelId, threadId: null },
  access,
  report: "when_new",
  trigger: "schedule",
  dueAt: new Date().toISOString(),
});

/** A routine's background run in its own room, reporting to #general. */
async function routineRun(access: RoutineAccess) {
  const brief = { ...briefOf(access), routineId: (await channelRoutine(f)).id };
  const room = await f.db.transaction((tx) => openRoutineRoom(tx, f.org.id, f.agent.id, brief.routineId));
  const fired = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: room.id,
    author: { type: "person", userId: f.owner.id },
    body: "Confira os erros novos do Sentry.",
    meta: { routineBrief: brief, background: true },
  });
  return { run: await runOn(fired.id, { background: true }), room, brief };
}

/** The run a routine's report woke in #general (the routine's run `run` handed it off). */
async function reportWakes(run: { id: string }) {
  const delivered = await f.db.transaction((tx) =>
    deliverNotice(tx, {
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadId: null,
      hop: 0,
      stretchId: null,
      notice: {
        kind: "routine_handoff",
        text: "3 erros novos no checkout.",
        from: "Routine «Sentry diário»",
        refs: { runId: run.id },
      },
    }),
  );
  const woken = delivered.runs[0];
  if (!woken) throw new Error("no run woken");
  return woken;
}

/** Who is behind a run (every run's computer turns work, ADR 0109). */
const howItWorks = async (runId: string) => ({ behind: await runAuthorityById(f.db, f.org.id, runId) });
const forAna = () => ({ behind: { kind: "person", personId: f.owner.id } }) as const;

/** The run a message woke. */
const wokenBy = async (messageId: string) =>
  (await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, messageId)))[0];

const CODE = { name: "run_code", scope: "sandbox:run", connectionId: null };
const TASK = { name: "start_task", scope: "sandbox:run", connectionId: null };
const TELL = { name: "tell_agent", scope: "", connectionId: null };
const POST = { name: "post_message", scope: "", connectionId: null };
const PULL_REQUEST = { name: "open_pull_request", scope: "github:pr.write", connectionId: "conn_github" };
/** What a run may do with the tools a hand-off and code work need. */
const decisions = (authority: RunAuthority) =>
  [CODE, TASK, TELL, POST, PULL_REQUEST].map((tool) => toolPolicy(authority, tool).action);

describe("work that comes back goes on for the person behind it", () => {
  test("a note's reply: the run it wakes works for the person who asked for the note", async () => {
    const lastText = (req: ModelRequest) => JSON.stringify(req.messages.at(-1)?.content);
    f = await setup({
      askAgent: true,
      judge: (kind) => (kind === "note_reply" ? 0.9 : undefined),
      reply: (req) => {
        if (systemText(req.system).includes("A private conversation between agents"))
          return { chunks: ["Qual branch?"] };
        const last = lastText(req);
        if (last.includes("Note from @infra")) return { chunks: ["A main."] };
        if (last.includes("tool_result")) return { chunks: ["Avisei o Infra."] };
        return {
          chunks: [],
          toolUses: [{ name: "tell_agent", input: { agent: "@infra", message: "O deploy de staging terminou." } }],
        };
      },
    });
    await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      {
        name: "Infra",
        handle: "infra",
        role: "Infrastructure",
        instructions: "You run the servers.",
        credentialId: f.credential.id,
      },
      { model: "claude-sonnet-5-5" },
    );
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev avisa o infra que o deploy terminou",
    });
    await drainOutbox(f.db, f.handlers);
    // What came of the note, back in @dev's conversation (a note's reply, or the answer kind a note may come back as).
    const reply = (await f.db.select().from(schema.messages)).find((m) =>
      ["agent_note", "consult_reply"].includes(String((m.meta.notice as { kind?: unknown } | undefined)?.kind)),
    );
    expect(reply?.channelId).toBe(f.general.id);
    const woken = await wokenBy(reply?.id ?? "");
    expect(woken).toBeDefined();
    expect(await howItWorks(woken?.id ?? "")).toEqual(forAna());
  });

  test("a background task's end: the run that started it goes on; with no such run, the agent itself works", async () => {
    f = await setup();
    const { machineId } = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "MacBook" });
    const ended = async (runId: string | null) => {
      const [task] = await f.db
        .insert(schema.machineTasks)
        .values({
          orgId: f.org.id,
          agentId: f.agent.id,
          machineId,
          channelId: f.general.id,
          runId,
          requestedByUserId: runId ? f.owner.id : null,
          title: "Rodar os testes",
          executor: "shell",
          command: "bun test",
          status: "done",
          exitCode: 0,
          endedAt: new Date(),
        })
        .returning();
      const woke = await wakeConversationForTask({ db: f.db }, task?.id ?? "", { maxHops: 100 });
      expect(woke?.runs).toHaveLength(1);
      return woke?.runs[0]?.id ?? "";
    };
    const started = await anaAsks("@dev roda os testes em segundo plano");
    expect(await howItWorks(await ended(started.id))).toEqual(forAna());
    // A task no run started (the server resumed it): nobody is behind it, and the agent still works.
    expect(await howItWorks(await ended(null))).toEqual({
      behind: { kind: "unattended", personId: null, reason: "agent" },
    });
  });

  test("a task a routine's run started ends where the routine reports, never in its room", async () => {
    f = await setup();
    const { machineId } = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "MacBook" });
    const { run, room, brief } = await routineRun("act");
    const [task] = await f.db
      .insert(schema.machineTasks)
      .values({
        orgId: f.org.id,
        agentId: f.agent.id,
        machineId,
        channelId: room.id,
        runId: run.id,
        title: "Corrigir o erro do checkout",
        executor: "shell",
        command: "bun test",
        status: "done",
        exitCode: 0,
        endedAt: new Date(),
      })
      .returning();
    const woke = await wakeConversationForTask({ db: f.db }, task?.id ?? "", { maxHops: 100 });
    expect(woke?.message?.channelId).toBe(f.general.id);
    expect(woke?.runs.map((r) => r.channelId)).toEqual([f.general.id]);
    // Nobody is behind a routine's work: the run it wakes works as the agent itself, within that routine.
    expect(await howItWorks(woke?.runs[0]?.id ?? "")).toEqual({
      behind: { kind: "unattended", personId: null, reason: "routine", brief },
    });
  });

  test("a routine's task end follows its report policy, and wakes nobody once it can't speak where it reports", async () => {
    f = await setup();
    const { machineId } = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "MacBook" });
    const ends = async (change?: Partial<typeof schema.routines.$inferInsert>) => {
      const { run, room, brief } = await routineRun("act");
      if (change) await f.db.update(schema.routines).set(change).where(eq(schema.routines.id, brief.routineId));
      const [task] = await f.db
        .insert(schema.machineTasks)
        .values({
          orgId: f.org.id,
          agentId: f.agent.id,
          machineId,
          channelId: room.id,
          runId: run.id,
          title: "Corrigir o erro do checkout",
          executor: "shell",
          command: "bun test",
          status: "done",
          exitCode: 0,
          endedAt: new Date(),
        })
        .returning();
      return { woke: await wakeConversationForTask({ db: f.db }, task?.id ?? "", { maxHops: 100 }), room };
    };
    // Live: in #general, and the run it wakes may pass when nothing is new (the routine reports only news).
    const live = await ends();
    const notice = live.woke?.message;
    if (!notice) throw new Error("no notice");
    expect(notice.channelId).toBe(f.general.id);
    const woken = live.woke?.runs[0];
    if (!woken) throw new Error("no run");
    expect(replyPolicyFor(woken, notice).mayPass).toBe(true);
    expect(taskNotice(notice, true)).toContain("If nothing in it is new for them");
    // Paused or deleted: the record stays in its room and nobody is woken.
    for (const change of [{ active: false }, { deletedAt: new Date() }]) {
      const { woke, room } = await ends(change);
      expect(woke?.message?.channelId).toBe(room.id);
      expect(woke?.runs).toEqual([]);
    }
  });

  test("a folder decision: the run that asked for the folder goes on", async () => {
    f = await setup();
    const { machineId } = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "MacBook" });
    const asked = await anaAsks("@dev lê os contratos na pasta Documentos");
    const [request] = await f.db
      .insert(schema.machineAccessRequests)
      .values({
        orgId: f.org.id,
        agentId: f.agent.id,
        machineId,
        channelId: f.general.id,
        runId: asked.id,
        requestedByUserId: f.owner.id,
        path: "/Users/ana/Documents",
        reason: "ler os contratos",
        status: "granted",
        scope: "agent",
        decidedAt: new Date(),
        expiresAt: new Date(Date.now() + 3600_000),
      })
      .returning();
    const woke = await wakeForAccessDecision({ db: f.db }, request?.id ?? "", { maxHops: 100 });
    expect(woke?.runs).toHaveLength(1);
    expect(await howItWorks(woke?.runs[0]?.id ?? "")).toEqual(forAna());
  });

  test("a decision on an agent it proposed: the run that proposed it goes on", async () => {
    f = await setup();
    const trigger = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: f.owner.id },
      body: "cria um agente de design",
    });
    const [proposing] = await f.db
      .insert(schema.agentRuns)
      .values({
        orgId: f.org.id,
        agentId: f.agent.id,
        channelId: f.general.id,
        threadRootId: trigger.id,
        triggerMessageId: trigger.id,
        trigger: "mention",
        hop: 1,
        status: "done",
      })
      .returning();
    const ctx: ToolContext = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: proposing?.id ?? "",
      channelId: f.general.id,
      threadRootId: trigger.id,
      triggerMessageId: trigger.id,
    };
    const tools = createToolGateway({
      sources: [createSetupToolSource({ pubsub: f.pubsub, ai: { gateway: f.gateway } })],
    });
    const proposed = await tools.invoke(ctx, {
      toolUseId: "tu_propose",
      name: "propose_agent",
      input: {
        name: "Ada",
        handle: "ada",
        role: "Designer",
        instructions: "Desenha as telas.",
        look: { color: "rose", eyes: "happy", accessory: "bow" },
        channels: ["#general"],
        why: "Você pediu alguém para cuidar do design.",
      },
    });
    if (proposed.type !== "result") throw new Error(`not a result: ${proposed.type}`);
    const card = (proposed.output.data as { agentProposal: { messageId: string } }).agentProposal.messageId;
    await createAgentFromProposal({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, card, () =>
      createAgent(
        f.db,
        f.owner.id,
        f.org.id,
        { name: "Ada", handle: "ada", role: "Designer", instructions: "Desenha." },
        NEW_AGENT_DEFAULTS,
      ),
    );
    const result = (await f.db.select().from(schema.messages)).find(
      (m) => (m.meta.notice as { kind?: string } | undefined)?.kind === "proposal_result",
    );
    const woken = await wokenBy(result?.id ?? "");
    expect(woken).toBeDefined();
    expect(await howItWorks(woken?.id ?? "")).toEqual(forAna());
  });

  test("Continuar keeps the person who wrote into the stopped run behind the work", async () => {
    f = await setup();
    // A run its own line started, that Ana wrote into while it worked, ended at its step limit.
    const own = await agentLine("Lembrete: revisar o PR #12.");
    const [stopped] = await f.db
      .insert(schema.agentRuns)
      .values({
        orgId: f.org.id,
        agentId: f.agent.id,
        channelId: f.general.id,
        threadRootId: own.id,
        triggerMessageId: own.id,
        trigger: "mention",
        hop: 1,
        status: "done",
        transcript: {
          system: [{ text: "You are Dev." }],
          messages: [{ role: "assistant", content: [{ type: "text", text: "Revisei metade do PR." }] }],
          postedUpTo: 1,
          postedCount: 1,
          deltaSeq: 0,
          steeredBy: f.owner.id,
        },
      })
      .returning();
    if (!stopped) throw new Error("no run");
    const reply = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      threadId: own.id,
      author: { type: "agent", agentId: f.agent.id, runId: stopped.id, hop: 1 },
      body: "Revisei metade do PR.",
      meta: { stepLimit: {} },
    });
    await f.db.update(schema.agentRuns).set({ replyMessageId: reply.id }).where(eq(schema.agentRuns.id, stopped.id));
    expect((await howItWorks(stopped.id)).behind).toEqual({ kind: "person", personId: f.owner.id });
    const { runId } = await continueRun({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, stopped.id);
    expect(await howItWorks(runId)).toEqual(forAna());
  });
});

describe("with nobody behind it, a run works as the agent itself", () => {
  test("a routine's report wakes a run that works within that routine, whatever access it once stored", async () => {
    f = await setup();
    // ADR 0109: it hands the work on and does it (code, background tasks, other agents, other channels, PRs), also
    // for a routine stored as "read" before every routine acted.
    for (const access of ["read", "act"] as const) {
      const { run, brief } = await routineRun(access);
      const woken = await reportWakes(run);
      const { behind } = await howItWorks(woken.id);
      const read = { ...brief, access: "act" as const };
      expect(behind).toEqual({ kind: "unattended", personId: null, reason: "routine_report", brief: read });
      expect(decisions(behind)).toEqual(["allow", "allow", "allow", "allow", "allow"]);
    }
  });

  test("what the run a report woke writes holds no credential: what the routine read may be a stranger's", async () => {
    const key = "AKIAIOSFODNN7EXAMPLE";
    f = await setup({ reply: () => ({ chunks: [`Achei a chave ${key} no repo.`] }) });
    // An agent's own work writes as the agent, with its own grants. It goes first: once the routine's reply sits in
    // the channel, a run there has read outside (ADR 0117) and masks a credential no person wrote too.
    const own = await runOn((await agentLine("Lembrete: revisar o PR #12.")).id);
    await drainOutbox(f.db, f.handlers);
    const [ownReply] = await f.db.select().from(schema.messages).where(eq(schema.messages.agentRunId, own.id));
    expect(ownReply?.body).toContain(key);
    const { run } = await routineRun("read");
    const woken = await reportWakes(run);
    await drainOutbox(f.db, f.handlers);
    const [reply] = await f.db.select().from(schema.messages).where(eq(schema.messages.agentRunId, woken.id));
    expect(reply?.body).toBe("Achei a chave •••• no repo.");
  });

  test("an agent's own message wakes a run that works as the agent", async () => {
    f = await setup();
    const woken = await runOn((await agentLine("Lembrete: revisar o PR #12.")).id);
    const { behind } = await howItWorks(woken.id);
    expect(behind).toEqual({ kind: "unattended", personId: null, reason: "agent" });
    expect(decisions(behind)).toEqual(["allow", "allow", "allow", "allow", "allow"]);
  });

  test("an approval asked with nobody behind goes to the agent's owner, from the tool's own rule", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await f.db.update(schema.agents).set({ ownerUserId: bia.id }).where(eq(schema.agents.id, f.agent.id));
    await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: "sandbox:run" }]);
    const ran: Record<string, unknown>[] = [];
    // Like run_code: a call that says why asks a person first.
    const computer: ToolSource = {
      name: "computer",
      tools: async () => [
        {
          name: "run_code",
          description: "Run code on the computer.",
          inputSchema: {
            type: "object",
            properties: { code: { type: "string" }, why: { type: "string" } },
            required: ["code"],
            additionalProperties: false,
          },
          scope: "sandbox:run",
          whyAsks: true,
          execute: async (input) => {
            ran.push(input);
            return { content: "ran" };
          },
        },
      ],
    };
    const gateway = createToolGateway({ sources: [computer] });
    const woken = await runOn((await agentLine("O CI do main falhou.")).id);
    const ctx: ToolContext = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: woken.id,
      channelId: woken.channelId,
      threadRootId: woken.threadRootId,
      triggerMessageId: woken.triggerMessageId,
    };
    const call = (input: Record<string, unknown>) =>
      gateway.invoke(ctx, { toolUseId: `tu_${crypto.randomUUID()}`, name: "run_code", input });
    expect(await call({ code: "bun test" })).toMatchObject({ type: "result", output: { content: "ran" } });
    const why = "The main branch build failed twice; this push of the fix goes to main, which a person approves.";
    const asked = await call({ code: "git push origin main", why });
    if (asked.type !== "approval") throw new Error(`expected an approval, got ${JSON.stringify(asked)}`);
    expect(asked.approval).toMatchObject({ ownerUserId: bia.id, origin: { kind: "unattended" }, why });
    expect(await approverIds(f.db, asked.approval)).toContain(bia.id);
    expect(ran).toEqual([{ code: "bun test" }]);
  });
});

describe("every routine works as its agent (ADR 0109)", () => {
  test("a routine, also one stored as only looking, starts background tasks and runs code", async () => {
    f = await setup();
    const looks = await routineRun("read");
    const { behind } = await howItWorks(looks.run.id);
    expect(toolPolicy(behind, TASK).action).toBe("allow");
    expect(toolPolicy(behind, CODE).action).toBe("allow");
    const acts = await routineRun("act");
    const acting = await howItWorks(acts.run.id);
    // The computer's own background task is code work, not a mission's tool.
    expect(toolPolicy(acting.behind, TASK).action).toBe("allow");
    // The mission's own `start_task` (no scope) stays the mission's.
    expect(toolPolicy(acting.behind, { ...TASK, scope: "" })).toEqual({
      action: "refuse",
      reason: REFUSALS.missionOnly,
    });
  });

  test("a reminder that asks the agent to do something at its time starts a run", async () => {
    f = await setup();
    const at = new Date(Date.now() + 3600_000);
    const remind = (askAgent: boolean) =>
      createReminder(routineDeps(f), f.owner.id, f.org.id, {
        agentId: f.agent.id,
        channelId: f.general.id,
        threadId: null,
        at,
        timezone: "UTC",
        description: "em 1 hora",
        message: "Verifique o deploy e conte aqui.",
        askAgent,
      });
    const fired = await fire(f, (await remind(true)).id, at);
    expect(fired.agentRunId).toBeTruthy();
    // A plain reminder only reminds: no run, so nothing to set.
    expect((await fire(f, (await remind(false)).id, at)).agentRunId).toBeNull();
  });
});

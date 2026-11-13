import { and, type Database, desc, eq, inArray, isNull, schema, sql } from "@agenteschat/db";
import type { Agent } from "./agents";
import { runBrainOf } from "./brains/select";
import type { Message } from "./messages";
import { latestPlan, missionOfThread, planMark } from "./missions";
import { type AgentRun, replyThreadOf } from "./runs";
import type { WaitMessageOutcome } from "./waits";

const { agentRunSteps, agentQuestions, agentConsultations, browserHandoffs, messages, users, agents } = schema;

/** Recent steps of the task shown to the talker. */
const SNAPSHOT_STEPS = 12;
/** Recent conversation messages shown to the talker. */
const SNAPSHOT_MESSAGES = 8;
/** Any one text in the snapshot is cut to this (the cheap model needs the gist, not the whole thing). */
const CLIP = 400;

const clip = (text: string, max = CLIP) => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/**
 * What the agent's task is doing right now, as the conversation layer reads
 * it: only facts from the database (the trigger, steps, waits, plan, queued
 * messages). The talker may say nothing beyond this.
 */
export interface TalkerSnapshot {
  agent: { name: string; handle: string; role: string };
  /** What the task was asked (its trigger message). */
  task: string;
  elapsedSeconds: number;
  status: AgentRun["status"];
  /** What it waits on, in words ("an answer to its question «Staging or production?»"). */
  waitingOn: string[];
  /** What the message did to the wait, if it waited. */
  waitOutcome: WaitMessageOutcome | null;
  /** A computer brain (Claude Code, Codex) in the middle of a turn; `live`: it gets the message at its next tool. */
  computerTurn: { live: boolean } | null;
  /** Its latest steps, oldest first ("12s ago: ran tool run_code"). */
  steps: string[];
  /** Its mission's plan, when the task is a mission's. */
  plan: string[] | null;
  /** Other messages queued for it that it hasn't read yet. */
  unread: { from: string; text: string }[];
  /** The last messages of the conversation, oldest first (`you`: the agent's own). */
  conversation: { from: string; text: string; you?: true }[];
  /** The message to answer or pass on. */
  message: { from: string; text: string };
}

export const ago = (now: Date, at: Date) => {
  const s = Math.max(0, Math.round((now.getTime() - at.getTime()) / 1000));
  return s < 90 ? `${s}s ago` : `${Math.round(s / 60)} min ago`;
};

/** A run step as one line (null: nothing worth telling). */
export function stepLine(kind: string, data: Record<string, unknown>): string | null {
  const name = typeof data.name === "string" ? data.name : "a tool";
  switch (kind) {
    case "model_call":
      return typeof data.narration === "string" && data.narration ? `said: "${clip(data.narration, 300)}"` : null;
    case "tool_call":
      return `started tool ${name}`;
    case "tool_result":
      return `tool ${name} ${data.isError === true ? "failed" : "finished"}`;
    case "message":
      return "posted a message in the conversation";
    case "approval":
      return "asked for an approval";
    case "error":
      if (data.reason === "usage_wait")
        return data.code === "budget" ? "ran out of its monthly budget" : "hit its plan's limit";
      return typeof data.reason === "string" ? `hit a problem: ${data.reason}` : "hit a problem";
    case "context":
      return Array.isArray(data.steeredMessageIds) ? "read new messages from people" : null;
    default:
      return null;
  }
}

/** What a waiting run waits on, from the rows it waits for. */
async function waitsOf(db: Database, run: AgentRun): Promise<string[]> {
  const out: string[] = [];
  const brainWait = (run.transcript as { waitingForBrain?: { code?: string; until?: string } } | null)?.waitingForBrain;
  // A usage wait has no computer to wait for: never "its computer is offline".
  if (brainWait?.code === "plan_limit" || brainWait?.code === "budget") {
    const what = brainWait.code === "budget" ? "its monthly budget to renew" : "its plan's usage limit to reset";
    out.push(`${what} (it picks up by itself${brainWait.until ? ` around ${brainWait.until}` : ""})`);
  } else if (run.waitingMachineId) {
    // No stored wait with a machine kept: it is asking from the line (`computerWaitOf`).
    out.push(
      !brainWait || brainWait.code === "busy"
        ? "room on its computer (busy with other tasks)"
        : "its computer to come back online (it is offline)",
    );
  }
  // An approval or a secret never gets here: the talker says nothing for a run that holds messages.
  if (run.status !== "waiting_input") return out;
  const [questions, handoffs, consults] = await Promise.all([
    db
      .select({ text: agentQuestions.text, person: users.name })
      .from(agentQuestions)
      .leftJoin(users, eq(users.id, agentQuestions.requestedForUserId))
      .where(and(eq(agentQuestions.runId, run.id), eq(agentQuestions.status, "open"))),
    db
      .select({ instructions: browserHandoffs.instructions, status: browserHandoffs.status })
      .from(browserHandoffs)
      .where(and(eq(browserHandoffs.runId, run.id), inArray(browserHandoffs.status, ["pending", "active"]))),
    db
      .select({ kind: agentConsultations.kind, question: agentConsultations.question, name: agents.name })
      .from(agentConsultations)
      .innerJoin(agents, eq(agents.id, agentConsultations.targetAgentId))
      .where(and(eq(agentConsultations.askerRunId, run.id), eq(agentConsultations.status, "open"))),
  ]);
  for (const q of questions)
    out.push(`an answer${q.person ? ` from ${q.person}` : ""} to its question "${clip(q.text, 200)}"`);
  for (const h of handoffs) {
    out.push(
      `a person to help in its browser: "${clip(h.instructions, 200)}" (${h.status === "active" ? "a person has control now" : "nobody opened it yet"})`,
    );
  }
  for (const c of consults)
    out.push(
      c.kind === "note"
        ? `${c.name} to finish the work it handed over: "${clip(c.question, 200)}"`
        : `an answer from ${c.name}, whom it asked: "${clip(c.question, 200)}"`,
    );
  return out;
}

/** Messages by id or in a conversation, with author names, oldest first. */
async function namedMessages(db: Database, run: AgentRun, where: ReturnType<typeof and>, limit: number) {
  const rows = await db
    .select({
      id: messages.id,
      body: messages.body,
      meta: messages.meta,
      authorAgentId: messages.authorAgentId,
      name: sql<string | null>`coalesce(${users.name}, ${agents.name})`,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.authorUserId))
    .leftJoin(agents, eq(agents.id, messages.authorAgentId))
    .where(and(eq(messages.orgId, run.orgId), isNull(messages.deletedAt), where))
    .orderBy(desc(messages.createdAt))
    .limit(limit);
  return rows.reverse();
}

export async function loadTalkerSnapshot(
  db: Database,
  input: {
    run: AgentRun;
    agent: Agent;
    message: Message;
    live: boolean;
    waited: WaitMessageOutcome | null;
    now: Date;
  },
): Promise<TalkerSnapshot> {
  const { run, agent, message, now } = input;
  const thread = replyThreadOf(run);
  const conversationWhere = thread
    ? and(eq(messages.channelId, run.channelId), sql`(${messages.threadId} = ${thread} or ${messages.id} = ${thread})`)
    : and(eq(messages.channelId, run.channelId), isNull(messages.threadId));
  const otherPending = run.pendingMessageIds.filter((id) => id !== message.id);
  const [trigger, steps, waitingOn, mission, conversation, unread, author] = await Promise.all([
    db
      .select({ body: messages.body })
      .from(messages)
      .where(and(eq(messages.orgId, run.orgId), eq(messages.id, run.triggerMessageId)))
      .then((r) => r[0]?.body ?? ""),
    db
      .select({ kind: agentRunSteps.kind, data: agentRunSteps.data, createdAt: agentRunSteps.createdAt })
      .from(agentRunSteps)
      .where(eq(agentRunSteps.runId, run.id))
      .orderBy(desc(agentRunSteps.seq))
      .limit(SNAPSHOT_STEPS),
    waitsOf(db, run),
    missionOfThread(db, run.orgId, run.threadRootId),
    namedMessages(db, run, conversationWhere, SNAPSHOT_MESSAGES + 1),
    otherPending.length > 0
      ? namedMessages(db, run, inArray(messages.id, otherPending), 10)
      : Promise.resolve([] as Awaited<ReturnType<typeof namedMessages>>),
    message.authorUserId
      ? db
          .select({ name: users.name })
          .from(users)
          .where(eq(users.id, message.authorUserId))
          .then((r) => r[0]?.name ?? "someone")
      : Promise.resolve("someone"),
  ]);
  const plan = mission && mission.agentId === run.agentId ? await latestPlan(db, mission.id) : null;
  return {
    agent: { name: agent.name, handle: agent.handle, role: agent.role },
    task: clip(trigger, 800),
    elapsedSeconds: Math.max(0, Math.round((now.getTime() - (run.startedAt ?? run.createdAt).getTime()) / 1000)),
    status: run.status,
    waitingOn,
    waitOutcome: input.waited,
    computerTurn: runBrainOf(run, agent) !== "model" && run.status === "running" ? { live: input.live } : null,
    steps: steps.reverse().flatMap((s) => {
      const line = stepLine(s.kind, s.data);
      return line ? [`${ago(now, s.createdAt)}: ${line}`] : [];
    }),
    plan: plan ? plan.items.map((i) => `${planMark(i.status)} ${clip(i.title, 160)}`) : null,
    unread: unread.map((m) => ({ from: m.name ?? "someone", text: clip(m.body) })),
    conversation: conversation
      .filter((m) => m.id !== message.id)
      .slice(-SNAPSHOT_MESSAGES)
      .map((m) => ({
        from: m.name ?? "someone",
        text: clip(m.body),
        ...(m.authorAgentId === run.agentId ? { you: true as const } : {}),
      })),
    message: { from: author, text: clip(message.body, 2000) },
  };
}

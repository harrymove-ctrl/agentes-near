import type { PubSub } from "@agenteschat/adapters";
import {
  and,
  type Database,
  type Executor,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  schema,
  sql,
} from "@agenteschat/db";
import { runAuthority } from "./authority";
import { askStillOpen, unrequested } from "./brakes";
import { requireChannelAccess } from "./channels";
import { handOffsFrom, sentOpen } from "./consultations";
import { getChannelCached } from "./context";
import { publishDelivery } from "./delivery";
import { eligibleChannelAgents } from "./dispatch";
import { isAgentOnlyDm } from "./dms";
import { ConflictError, NotFoundError } from "./errors";
import { publishMessageCreated } from "./events";
import { cutText, cutTextEnd } from "./format";
import type { Judge } from "./judge";
import { getMessage, insertMessage, type Message, messageView } from "./messages";
import { isWithdrawnHandoff } from "./open-requests";
import { enqueue } from "./outbox";
import { personCanPost } from "./routine-state";
import { deliverNoticeToRun, lateNoticeSent } from "./run-resume";
import { type AgentRun, replyThreadOf } from "./runs";
import { refusedAtLimit, runStretchOf } from "./stretch";
import type { ToolContext, ToolDefinition, ToolOutput, ToolSource } from "./tools/types";

/**
 * Agents follow through (ADR 0037, round 3): a run that ends right after a decision without a word gets
 * one more turn with the result (`decisionNudge`); a conversation run that ends with work it said it would do
 * still undone and nothing set to bring it back is caught by one judge call, in any language
 * (`followThroughVerdict`, ADR 0089), and told once to do it (`FOLLOW_THROUGH_NUDGE`); and an agent comes back to a
 * conversation by itself (`follow_up`): a notice line there now, and at its time a notice that wakes the agent in
 * that conversation (`wakeFollowUp`).
 */

const { agentRuns, agentWorks, messages, routines } = schema;

export const FOLLOW_UP_TOOL = "follow_up";
export const CANCEL_FOLLOW_UP_TOOL = "cancel_follow_up";
/** The outbox job that wakes the agent at a follow-up's time. */
export const FOLLOW_UP_JOB = "agent.follow_up";
/** How far ahead one goes, how many one run sets, how many wait at once in one conversation. */
/** How often a follow-up held by an unanswered question looks again. */
export const ASK_HOLD_MS = 10 * 60_000;
export const FOLLOW_UP_LIMITS = { maxMinutes: 24 * 60, perRun: 2, perConversation: 3 } as const;

export type FollowUpState = "pending" | "done" | "canceled";

const str = (v: unknown) => (typeof v === "string" ? v : "");
/** An ISO 8601 time that says its offset ("Z", "-03:00"). */
const WITH_OFFSET = /(?:z|[+-]\d{2}:?\d{2})$/i;

// ── After a decision ─────────────────────────────────────────────────────────

/**
 * What a run reads when it ended its turn right after a decision without telling anyone what came of it. The
 * results come last: one may be an outside envelope (`<external_data>`), and nothing it is told may follow it.
 */
export const decisionNudge = (decided: string) =>
  [
    "A person decided what you were waiting on, and you ended your turn without telling them anything. Go on with the task with the result below now (call the tools you need), then tell them the outcome. If the result isn't what you needed (empty, a placeholder, an error), say so and what you'll do instead.",
    "What they decided and what came back:",
    decided,
  ].join("\n");

// ── Promises at the end of a run ─────────────────────────────────────────────

export type FollowThroughVerdict = "done" | "waiting" | "unkept";

/**
 * One judge call on a run's last message: it finished, it waits on a person for something specific
 * (legitimate), or it stopped with a promise or work left that nothing will bring it back to.
 */
export async function followThroughVerdict(
  judge: Judge,
  input: { orgId: string; agentId: string; runId: string; request: string; reply: string },
): Promise<FollowThroughVerdict> {
  const answers = await judge.ask({
    orgId: input.orgId,
    agentId: input.agentId,
    runId: input.runId,
    kind: "follow_through",
    state: { request: cutText(input.request, 2000), reply: cutTextEnd(input.reply, 3000) },
    questions: {
      verdict: {
        type: "choice",
        instructions:
          "An AI agent in a team chat was asked `request` and ended its turn with `reply`, its last message. It won't act again until someone writes to it or something it set up wakes it. Did it finish, does it wait on a person for something specific, or did it stop with work it said it would do still undone?",
        criteria: {
          done: "The reply gives the result or the answer, or says plainly what it couldn't do. Offers that wait for a yes ('want me to…?', 'if you want, I can…') and 'let me know if…' count as done.",
          waiting:
            "To go on it needs something specific from a person (a decision, an answer, an approval, access, a file) and asks for it, or an approval card it asked for will wake it.",
          unkept:
            "It says it will do more itself, later or next (check again, send the numbers, report when something finishes, continue after a build or an approval), but it stopped without doing it and nothing it set up brings it back.",
        },
      },
    },
  });
  const a = answers.verdict;
  const unkept = a?.probabilities?.unkept ?? (a?.choice === "unkept" ? 1 : 0);
  if (unkept >= 0.6) return "unkept";
  return a?.choice === "waiting" ? "waiting" : "done";
}

/** What a run reads, once, when it ended with work it said it would do still undone and nothing keeps it. */
export const FOLLOW_THROUGH_NUDGE =
  "You ended saying you would do more, and nothing you set up brings you back to it. Do it now with your tools and tell them what came of it. If it has to wait (a build, a deploy, a job still running), set a follow_up to come back to it and say when, in one line.";

/**
 * The same, for a run in an agents' DM answering another agent (ADR 0095): its last message goes back as the
 * answer, and nothing wakes it there again.
 */
export const FOLLOW_THROUGH_NUDGE_DM =
  "You ended saying you would do more, and nothing brings you back here: your answer goes back as it is. Do it now with your tools, then answer with what came of it. If a part needs another agent, hand it on with tell_agent: what comes of it goes back with your answer.";

/**
 * What a mission's run reads, once, when it ended waiting on a person without a card: asked in a card, the thread
 * shows the mission waits on them, the answer resumes the session, and the mission doesn't go on by itself meanwhile.
 */
export const MISSION_ASK_NUDGE =
  "You ended waiting on a person, but you didn't ask them in a card. Ask now, directly: ask_user with one clear question (request_secret for a credential or a key, a blocking ask_decision for a choice between options, browser_ask_person or desktop_ask_person for a sign-in, a QR code or a code once the page or app is at that step), mark the plan item waiting_you with update_plan, then end your turn. Don't repeat the question in your text.";

// ── Coming back by itself (`follow_up`) ──────────────────────────────────────

/** A follow-up notice's refs: the run that set it, when, the people's words for it, and its state. */
const refsOf = (m: Pick<Message, "meta">) =>
  ((m.meta.notice as { refs?: Record<string, string> } | undefined)?.refs ?? {}) as Record<string, string>;

const isFollowUpLine = (m: Pick<Message, "meta">) =>
  (m.meta.notice as { kind?: unknown } | undefined)?.kind === "follow_up" && !refsOf(m).wake;

/**
 * The follow-ups still waiting in a run's conversation (all set in the last day: none goes further ahead). In a
 * thread that is the thread's; in the main timeline (a channel's, a DM's) it is the person's: `personId`, who is
 * behind the run (null: nobody), keeps other people's follow-ups there out.
 */
async function pendingFollowUps(
  db: Executor,
  run: Pick<AgentRun, "orgId" | "agentId" | "channelId" | "threadRootId" | "triggerMessageId">,
  personId: string | null,
) {
  const threadId = replyThreadOf(run);
  return db
    .select({ id: messages.id, runId: sql<string>`${messages.meta}->'notice'->'refs'->>'runId'` })
    .from(messages)
    .where(
      and(
        eq(messages.orgId, run.orgId),
        eq(messages.channelId, run.channelId),
        threadId
          ? eq(messages.threadId, threadId)
          : and(
              isNull(messages.threadId),
              sql`coalesce(${messages.meta}->'notice'->'refs'->>'personId', '') = ${personId ?? ""}`,
            ),
        eq(messages.authorAgentId, run.agentId),
        isNull(messages.deletedAt),
        gt(messages.createdAt, new Date(Date.now() - (FOLLOW_UP_LIMITS.maxMinutes + 60) * 60_000)),
        sql`${messages.meta}->'notice'->>'kind' = 'follow_up'`,
        sql`${messages.meta}->'notice'->'refs'->>'state' = 'pending'`,
      ),
    );
}

/** Reminders of the agent that run it in this conversation at their time (`schedule_reminder` with `ask_agent`). */
const wakingReminders = (db: Executor, run: Pick<AgentRun, "orgId" | "agentId" | "channelId">, since?: Date) =>
  db
    .select({ id: routines.id })
    .from(routines)
    .where(
      and(
        eq(routines.orgId, run.orgId),
        eq(routines.agentId, run.agentId),
        eq(routines.triggerType, "once"),
        eq(routines.active, true),
        isNull(routines.deletedAt),
        isNotNull(routines.nextRunAt),
        since ? gte(routines.createdAt, since) : undefined,
        sql`${routines.target}->>'channelId' = ${run.channelId}`,
        sql`${routines.target}->>'reminder' = 'false'`,
      ),
    )
    .limit(1);

/**
 * Whatever run set it, the agent comes back to this conversation by itself: a follow-up still to come (the person's,
 * in the main timeline), a reminder that runs it here, or long work of its own whose updates come here
 * (`updatesThreadOf`: a work asked in the main timeline talks in its own thread, so a new request there beside it
 * still gets its nudge). Only for a promise already made: `wakesLater` alone decides whether a turn is judged at all,
 * or every turn beside a running work would go unread.
 */
export async function comesBackHere(db: Executor, run: AgentRun) {
  const { personId } = await runAuthority(db, run);
  const threadId = replyThreadOf(run);
  const [followUps, reminders, works] = await Promise.all([
    pendingFollowUps(db, run, personId),
    wakingReminders(db, run),
    run.workId
      ? []
      : db
          .select({ id: agentWorks.id })
          .from(agentWorks)
          .where(
            and(
              eq(agentWorks.orgId, run.orgId),
              eq(agentWorks.agentId, run.agentId),
              eq(agentWorks.channelId, run.channelId),
              sql`(case when ${agentWorks.ownThread} then ${agentWorks.anchorMessageId} else ${agentWorks.homeThreadId} end) is not distinct from ${threadId}::uuid`,
              inArray(agentWorks.status, ["queued", "live"]),
            ),
          )
          .limit(1),
  ]);
  return followUps.length > 0 || reminders.length > 0 || works.length > 0;
}

/**
 * Whether something brings the agent back here by itself, keeping its promise: a follow-up this run set still to
 * come, a question or work it or an earlier run of it asked or handed off from this conversation that is still out
 * (`ask_agent`, `tell_agent`, the last day: what comes of it wakes the agent here), a wait it stopped waiting on
 * whose result hasn't come, or a reminder it set to do the work then (`schedule_reminder` with `ask_agent`). In an
 * agents' DM only what this run handed on counts: what another run there handed on goes back with that run's answer.
 */
export async function wakesLater(
  db: Executor,
  run: Pick<AgentRun, "id" | "orgId" | "agentId" | "channelId" | "threadRootId" | "triggerMessageId" | "createdAt">,
  detachedWaits: { waitId: string }[] = [],
) {
  const channel = await getChannelCached(db, run.orgId, run.channelId);
  const [followUp, handedOff, reminder] = await Promise.all([
    db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.orgId, run.orgId),
          eq(messages.channelId, run.channelId),
          eq(messages.authorAgentId, run.agentId),
          gte(messages.createdAt, run.createdAt),
          isNull(messages.deletedAt),
          sql`${messages.meta}->'notice'->>'kind' = 'follow_up'`,
          sql`${messages.meta}->'notice'->'refs'->>'runId' = ${run.id}`,
          sql`${messages.meta}->'notice'->'refs'->>'state' = 'pending'`,
        ),
      )
      .limit(1),
    channel && isAgentOnlyDm(channel)
      ? sentOpen(db, run)
      : handOffsFrom(db, run, { openOnly: true }).then((rows) => rows.length > 0),
    wakingReminders(db, run, run.createdAt),
  ]);
  if (followUp.length > 0 || handedOff || reminder.length > 0) return true;
  for (const d of detachedWaits)
    if (!(await lateNoticeSent(db, run, d.waitId)) && !(await isWithdrawnHandoff(db, run.orgId, d.waitId))) return true;
  return false;
}

/** Moves a pending follow-up line to `state`; null when it isn't pending anymore. */
async function settle(tx: Executor, line: Pick<Message, "id" | "orgId">, state: FollowUpState, by?: string) {
  const patch = JSON.stringify({ state, ...(by ? { canceledBy: by } : {}) });
  const [row] = await tx
    .update(messages)
    .set({
      meta: sql`jsonb_set(${messages.meta}, '{notice,refs}', coalesce(${messages.meta}->'notice'->'refs', '{}'::jsonb) || ${patch}::jsonb)`,
    })
    .where(
      and(
        eq(messages.orgId, line.orgId),
        eq(messages.id, line.id),
        sql`${messages.meta}->'notice'->'refs'->>'state' = 'pending'`,
      ),
    )
    .returning();
  return row ?? null;
}

const refused = (content: string): ToolOutput => ({ content, isError: true });

/** The line shows up, or changes in place (the apps replace a message they have by its id). */
const publishLine = async (pubsub: PubSub | undefined, line: Message) => {
  if (pubsub) await publishMessageCreated(pubsub, messageView(line));
};

/** The run a tool call belongs to: a conversation's run, never a routine's background work or a mission task. */
async function conversationRun(ctx: ToolContext) {
  if (!ctx.runId || ctx.background || ctx.bridge?.taskId) return null;
  const [run] = await ctx.db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.id, ctx.runId), eq(agentRuns.orgId, ctx.orgId), eq(agentRuns.agentId, ctx.agentId)));
  return run && !run.background ? run : null;
}

/**
 * `follow_up` and `cancel_follow_up`, for every agent (no scope; routines' background runs are refused by
 * the run policy: they run again on their own schedule). Setting one posts its line in the run's
 * conversation (a `follow_up` notice that wakes nobody, `refs.state` `pending`) and queues the job that
 * wakes the agent there at its time (`wakeFollowUp`).
 */
export function createFollowUpToolSource(deps: { pubsub?: PubSub }): ToolSource {
  const tools: ToolDefinition[] = [
    {
      name: FOLLOW_UP_TOOL,
      description:
        'Come back to this conversation by yourself later: at that time you are woken here with your note and the conversation, to do the work and tell the people (check a CI run or a deploy again, send the numbers once a job ends). Use it instead of promising to come back. `minutes` from now, or `at` (ISO 8601 with its offset), at most 24 hours ahead. `note`: what to do then, for yourself. `about`: a few words in the people\'s language for the line they see ("ver o CI", "check the deploy"). Then tell them in a line when you\'ll be back.',
      scope: "",
      inputSchema: {
        type: "object",
        properties: {
          minutes: { type: "integer", minimum: 1, maximum: FOLLOW_UP_LIMITS.maxMinutes },
          at: { type: "string", minLength: 10, maxLength: 40 },
          note: { type: "string", minLength: 1, maxLength: 1000 },
          about: { type: "string", minLength: 1, maxLength: 80 },
        },
        required: ["note", "about"],
        additionalProperties: false,
      },
      describe: (input) => ({ title: `Follow up: ${str(input.about)}` }),
      async execute(input, ctx) {
        const run = await conversationRun(ctx);
        if (!run) return refused("Only a conversation's run can come back to it.");
        const channel = await getChannelCached(ctx.db, run.orgId, run.channelId);
        if (channel && isAgentOnlyDm(channel))
          return refused("Answer the agent that asked now: no person reads this conversation to come back to.");
        // Its wake is one more run this agent starts on its own (ADR 0089): past the stretch's limits it would be held.
        const atLimit = await refusedAtLimit(ctx.db, run, run.agentId);
        if (atLimit) return atLimit;
        const now = Date.now();
        const given = str(input.at).trim();
        // A time without its offset would be read in the server's zone, not the person's.
        const due = given
          ? WITH_OFFSET.test(given)
            ? Date.parse(given)
            : Number.NaN
          : now + Number(input.minutes ?? 0) * 60_000;
        if (!Number.isFinite(due) || (!given && !input.minutes))
          return refused("Say when: `minutes` from now, or `at` as an ISO 8601 time with its offset.");
        if (due < now + 30_000) return refused("That time has passed: pick one at least a minute ahead.");
        if (due > now + FOLLOW_UP_LIMITS.maxMinutes * 60_000)
          return refused("At most 24 hours ahead. For later or recurring checks, ask the person for a routine.");
        const note = str(input.note).trim();
        const about = str(input.about).trim();
        const at = new Date(due).toISOString();
        const personId = (await runAuthority(ctx.db, run)).personId;
        const line = await ctx.db.transaction(async (tx) => {
          const pending = await pendingFollowUps(tx, run, personId);
          if (pending.filter((p) => p.runId === run.id).length >= FOLLOW_UP_LIMITS.perRun) return "run" as const;
          if (pending.length >= FOLLOW_UP_LIMITS.perConversation) return "conversation" as const;
          const message = await insertMessage(tx, {
            orgId: run.orgId,
            channelId: run.channelId,
            threadId: replyThreadOf(run),
            author: { type: "agent", agentId: run.agentId, runId: null, hop: run.hop, stretchId: runStretchOf(run) },
            body: note,
            meta: {
              notice: {
                kind: "follow_up",
                text: note,
                refs: { runId: run.id, at, about, state: "pending", ...(personId ? { personId } : {}) },
              },
            },
          });
          await enqueue(tx, {
            orgId: run.orgId,
            kind: FOLLOW_UP_JOB,
            payload: { messageId: message.id },
            dedupeKey: `${FOLLOW_UP_JOB}:${message.id}`,
            runAt: new Date(due),
            maxAttempts: 4,
          });
          return message;
        });
        if (line === "run") return refused(`This run already set ${FOLLOW_UP_LIMITS.perRun} follow-ups.`);
        if (line === "conversation")
          return refused(
            `${FOLLOW_UP_LIMITS.perConversation} follow-ups already wait in this conversation: cancel one first (cancel_follow_up) or do it now.`,
          );
        await publishLine(deps.pubsub, line);
        return {
          content: `Follow-up ${line.id} set for ${at}: you'll be woken here then with your note. Tell them in a line when you'll be back.`,
          data: { followUp: { id: line.id, at } },
        };
      },
    },
    {
      name: CANCEL_FOLLOW_UP_TOOL,
      description:
        "Cancel your follow-ups still waiting in this conversation: the one `id` names (from follow_up), or all of them. When the person says there is no need, or it's done already.",
      scope: "",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", minLength: 36, maxLength: 36 } },
        additionalProperties: false,
      },
      describe: () => ({ title: "Cancel follow-up" }),
      async execute(input, ctx) {
        const run = await conversationRun(ctx);
        if (!run) return refused("Only a conversation's run has follow-ups.");
        const id = str(input.id);
        const personId = (await runAuthority(ctx.db, run)).personId;
        const pending = (await pendingFollowUps(ctx.db, run, personId)).filter((p) => !id || p.id === id);
        if (pending.length === 0) return refused(id ? "No such follow-up waits here." : "No follow-up waits here.");
        const lines: Message[] = [];
        for (const p of pending) {
          const row = await settle(ctx.db, { id: p.id, orgId: run.orgId }, "canceled", `agent:${run.agentId}`);
          if (row) lines.push(row);
        }
        for (const line of lines) await publishLine(deps.pubsub, line);
        return { content: `Canceled ${lines.length} follow-up${lines.length === 1 ? "" : "s"}.` };
      },
    },
  ];
  return { name: "follow-ups", tools: async () => tools };
}

/**
 * Job `agent.follow_up`: a follow-up's time came. Its line moves to `done` and a `follow_up` notice for the run
 * that set it (`refs.wake`) goes to its conversation: while that run is still active it reads it at its next step,
 * else it starts a run of the agent there (or joins one working for the same person), which reads the note and
 * the conversation since. A canceled or deleted line, or a run that is gone, wakes nobody.
 */
export async function wakeFollowUp(deps: { db: Database; pubsub?: PubSub }, orgId: string, messageId: string) {
  const woke = await deps.db.transaction(async (tx) => {
    const [line] = await tx
      .select()
      .from(messages)
      .where(and(eq(messages.orgId, orgId), eq(messages.id, messageId)))
      .for("update");
    if (!line || line.deletedAt || !isFollowUpLine(line) || refsOf(line).state !== "pending") return null;
    const refs = refsOf(line);
    const [run] = await tx
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.id, refs.runId ?? "")));
    let here = run ? await stillHere(tx, run) : false;
    // Work nobody asked for that asked the person something they haven't answered waits for their answer, not the
    // clock (ADR 0131 §1): the line stays pending and looks again later; a day past its time it is canceled. What a
    // person asked for comes back at its time.
    if (here && run && unrequested(await runAuthority(tx, run)) && (await askStillOpen(tx, run))) {
      const due = Date.parse(refs.at ?? "") || line.createdAt.getTime();
      if (Date.now() < due + FOLLOW_UP_LIMITS.maxMinutes * 60_000) {
        await enqueue(tx, {
          orgId,
          kind: FOLLOW_UP_JOB,
          payload: { messageId: line.id },
          dedupeKey: `${FOLLOW_UP_JOB}:${line.id}:${Date.now()}`,
          runAt: new Date(Date.now() + ASK_HOLD_MS),
          maxAttempts: 4,
        });
        return null;
      }
      here = false;
    }
    const settled = await settle(tx, line, here ? "done" : "canceled");
    if (!settled || !run || !here) return settled ? { line: settled, delivered: null } : null;
    const delivered = await deliverNoticeToRun(tx, run, {
      kind: "follow_up",
      text: str((line.meta.notice as { text?: unknown }).text) || line.body,
      refs: { runId: run.id, followUpId: line.id, at: refs.at ?? "", about: refs.about ?? "", wake: "1" },
    });
    return { line: settled, delivered };
  });
  if (!woke) return null;
  await publishLine(deps.pubsub, woke.line);
  if (woke.delivered) await publishDelivery(deps.pubsub, woke.delivered).catch(() => {});
  return woke.delivered?.message ?? null;
}

/**
 * At a follow-up's time the agent is still in its conversation and may answer the person behind the run that
 * set it, who can still post there: neither changed since (a removal doesn't cancel the line, its time does).
 */
async function stillHere(tx: Executor, run: AgentRun) {
  const personId = (await runAuthority(tx, run)).personId;
  const agents = await eligibleChannelAgents(
    tx,
    run.orgId,
    run.channelId,
    [run.agentId],
    personId ? { requesterUserId: personId } : {},
  );
  return agents.length > 0 && (!personId || (await personCanPost(tx, run.orgId, personId, run.channelId)));
}

/** A person cancels a follow-up from its line: anyone who can read the conversation. */
export async function cancelFollowUp(
  deps: { db: Database; pubsub?: PubSub },
  userId: string,
  orgId: string,
  messageId: string,
): Promise<void> {
  const line = await getMessage(deps.db, orgId, messageId);
  if (!line || line.deletedAt || !isFollowUpLine(line))
    throw new NotFoundError("Follow-up not found", "follow_up.not_found");
  await requireChannelAccess(deps.db, userId, orgId, line.channelId);
  const row = await settle(deps.db, line, "canceled", userId);
  if (!row) throw new ConflictError("This follow-up already came or was canceled", "follow_up.not_pending");
  await publishLine(deps.pubsub, row);
}

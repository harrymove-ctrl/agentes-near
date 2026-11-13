import {
  and,
  type Database,
  desc,
  type Executor,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  rowsOf,
  schema,
  sql,
} from "@agenteschat/db";
import { audienceSql } from "./audience";
import { messageRoot, personOfMessage, routinePostRun, runAuthorityById } from "./authority";
import { agentLineRank, frontOfLine } from "./computer-queue";
import { dmAgents, isAgentOnlyDm } from "./dms";
import { getMessage, type Message } from "./messages";
import { enqueue } from "./outbox";
import { routineCreatorOf } from "./requester";
import { rightHandReaches } from "./right-hand";
import { holdsMessages } from "./run-hold";
import { ACTIVE_RUN_STATUSES, queueOnRun } from "./run-inbox";
import { inChannelRun, waitsOnUsage, workKeepsThread, workTakesPersonMessage } from "./run-scope";
import type { AgentRun } from "./runs";
import { holdOf, hopLimitReached, pauseStretch, personAskedLately, stretchOf, stretchStop } from "./stretch";

const { agentConsultations, agents, agentWorks, channelMembers, channels, agentRuns, messages, outbox } = schema;

/** The outbox job that looks again at an agent's wake waiting outside any run (`StartRunOptions.park`). */
export const INBOX_JOB = "agent_inbox.deliver";

/** How often a parked wake looks whether its agent has left the computer's line. */
export const INBOX_LOOK_MS = 30_000;

/**
 * Each look keeps a parked question or note open at least this long: well past the next look, and short enough that
 * one whose looks stopped expires and its asker hears it.
 */
const INBOX_KEEP_OPEN_MS = 5 * 60_000;

export type RunTrigger = AgentRun["trigger"];

export interface DispatchResult {
  runs: AgentRun[];
  /** Why nothing was started, when nothing was. */
  skipped?: "no_mentions" | "hop_limit" | "message_missing";
  /**
   * Mentioned agents dispatch couldn't wake (I5, I7): no longer in the conversation, archived, or only certain
   * people may talk to them and the person behind the message (nobody, for a run with none) isn't one.
   */
  dropped?: { agentId: string; handle: string; reason: "not_in_channel" | "audience" }[];
}

/** What starting a run on a message reads of it. */
type Trigger = Pick<
  Message,
  "id" | "orgId" | "channelId" | "threadId" | "hop" | "stretchId" | "authorAgentId" | "authorUserId" | "agentRunId"
>;

/**
 * Creates one `agent_run` per agent for a trigger message and enqueues its
 * execution, in the caller's transaction. Shared by every way agents wake up
 * (mentions, router, DMs, routines, webhooks, issues). Idempotent:
 * `(trigger_message_id, agent_id)` is unique and the execute job has a dedupe
 * key, so a redelivered event starts nothing twice.
 *
 * Callers decide WHO may run (eligibility, the depth backstop); this never grants anything.
 */
export async function createAgentRuns(
  tx: Executor,
  message: Trigger,
  agentIds: string[],
  trigger: RunTrigger,
  options: StartRunOptions = {},
): Promise<AgentRun[]> {
  const created: AgentRun[] = [];
  for (const agentId of agentIds) {
    const started = await startOrJoinRun(tx, message, agentId, trigger, options);
    if (started && "created" in started) created.push(started.created);
  }
  return created;
}

export interface StartRunOptions {
  /**
   * A person's new message in the channel (the router picked the agent): it also joins the agent's
   * run that answers in the channel itself (ADR 0029), so two people calling one agent get one answer.
   * Routines, agents' messages and consultations keep one run per message.
   */
  joinChannelRun?: boolean;
  /**
   * Background work (a routine's run): it holds no conversation's slot, so it never joins the
   * conversation's active run (nor does anything ever join it).
   */
  background?: boolean;
  /**
   * A person let the work go on (Continuar on a stretch's pause card): the run starts at hop 1 in this fresh
   * stretch, past the limits of the one that held it (ADR 0089).
   */
  granted?: string;
  /**
   * The agent inbox (ADR 0032 "Calm wakes"): an agent's message for an agent already in its computer's line with a
   * run that ranks at least as high starts no run while that one waits. It waits outside any run (`INBOX_JOB`, this
   * look's number) and starts or joins one once the agent has nothing in line; a person's message never waits so.
   */
  park?: number;
  /** A parked wake: when it started waiting. Its run's place in the computer's line counts from then. */
  parkedSince?: number;
}

/**
 * One agent and one message: the message joins the agent's active run in that conversation (read
 * at its next step; `joined`), or a run starts on it (`created`). Null: nothing to do (a
 * redelivered event), or a run agents started on their own would pass its stretch's limits
 * (`stretchStop`): the wake-up is held for the pause card (ADR 0089). A run that ends between the
 * lookup and the append is never appended to: the message starts a run of its own instead.
 */
export async function startOrJoinRun(
  tx: Executor,
  message: Trigger,
  agentId: string,
  trigger: RunTrigger,
  options: StartRunOptions = {},
): Promise<{ created: AgentRun } | { joined: string } | null> {
  // One active run per agent and conversation (background runs hold no slot): the message goes to it, read at its next step, instead of a second run.
  if (!options.background) {
    // Several runs may be active (in the agents' DM one per person behind them; elsewhere a person's run
    // next to an unattended one, or one held by a decision): the message joins the newest it may
    // (`mayJoin`). A run waiting on an approval, a secret or a mission's decision takes nothing new
    // (`holdsMessages`): the agent answers this in a run of its own meanwhile.
    // Its run in the channel waiting for its computer, its plan or its budget takes the message: one turn per agent
    // there, not one per mention, each waiting for the same thing. Not a Continuar's: that starts a fresh stretch.
    const waitingForComputer =
      message.threadId || options.granted
        ? sql<boolean>`false`
        : sql<boolean>`(${agentRuns.status} = 'waiting_input' and (${agentRuns.waitingMachineId} is not null or ${waitsOnUsage(sql`${agentRuns}`)}) and ${inChannelRun(sql`${agentRuns}`)}
          and not exists (select 1 from ${channels} c where c.id = ${message.channelId}::uuid and c.kind = 'dm'))`;
    const active = await tx
      .select({
        id: agentRuns.id,
        orgId: agentRuns.orgId,
        status: agentRuns.status,
        triggerMessageId: agentRuns.triggerMessageId,
        waitingForComputer,
        inLine: sql<boolean>`coalesce(${agentRuns.transcript}->'waitingForBrain'->>'code' = 'busy', false)`,
      })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.orgId, message.orgId),
          eq(agentRuns.agentId, agentId),
          eq(agentRuns.channelId, message.channelId),
          inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES]),
          eq(agentRuns.background, false),
          // A person's message never goes to background work at work: a reply turn answers it (agents' still join).
          message.authorUserId
            ? workTakesPersonMessage(sql`${agentRuns}`, message.authorUserId)
            : workKeepsThread(sql`${agentRuns}`),
          // In a DM the main timeline is one conversation; each thread (a mission's) is its own.
          sql`(${agentRuns.threadRootId} = ${message.threadId ?? message.id}::uuid or ${
            message.threadId
              ? sql`false`
              : sql`(${inChannelRun(sql`${agentRuns}`)} and exists (
            select 1 from channels c where c.id = ${message.channelId}::uuid and c.kind = 'dm'))`
          }
            or ${
              options.joinChannelRun && !message.threadId
                ? sql`(${agentRuns.status} in ('queued', 'running') and ${inChannelRun(sql`${agentRuns}`)})`
                : sql`false`
            }
            or ${waitingForComputer})`,
        ),
      )
      .orderBy(sql`${agentRuns.createdAt} desc`)
      .limit(10);
    for (const run of active) {
      if (
        run.triggerMessageId === message.id ||
        (await holdsMessages(tx, run, message.authorUserId)) ||
        !(await mayJoin(tx, message, run.id))
      )
        continue;
      if (!(await queueOnRun(tx, run.id, message.id))) break;
      if (run.waitingForComputer && message.hop >= 1) {
        // An agent's message keeps its depth: the run's replies carry its hop, so the hop limit still holds.
        await tx
          .update(agentRuns)
          .set({ hop: sql`greatest(${agentRuns.hop}, ${message.hop + 1})` })
          .where(eq(agentRuns.id, run.id));
      }
      // A person's message the router or a hand-on brought here (no steering after it): a person waits on it now.
      if (run.inLine && !message.authorAgentId && message.hop === 0 && (await byPerson(tx, message)))
        await frontOfLine(tx, run, message.id);
      return { joined: run.id };
    }
  }
  if (options.park && message.authorAgentId && message.hop >= 1 && !options.granted && !options.background) {
    const inLine = await agentLineRank(tx, message.orgId, agentId);
    // Work a person asked for lately never waits behind the agent's own chatter.
    if (inLine !== null && (inLine < 2 || !(await personAskedLately(tx, message.orgId, stretchOf(message))))) {
      await enqueue(tx, {
        orgId: message.orgId,
        kind: INBOX_JOB,
        payload: {
          messageId: message.id,
          agentId,
          trigger,
          look: options.park,
          since: options.parkedSince ?? Date.now(),
        },
        dedupeKey: `${INBOX_JOB}:${agentId}:${message.id}:${options.park}`,
        runAt: new Date(Date.now() + INBOX_LOOK_MS),
      });
      return null;
    }
  }
  // Agents started it (its trigger is an agent's, hop 1 or more): within its stretch's limits. A routine's background
  // run keeps its own.
  if (!options.granted && !options.background && message.hop >= 1) {
    const stop = await stretchStop(tx, message.orgId, stretchOf(message), agentId, message.id);
    if (stop) {
      await pauseStretch(tx, message.orgId, await holdOf(tx, message, agentId, trigger, stop));
      return null;
    }
  }
  const [run] = await tx
    .insert(agentRuns)
    .values({
      orgId: message.orgId,
      agentId,
      channelId: message.channelId,
      threadRootId: message.threadId ?? message.id,
      triggerMessageId: message.id,
      trigger,
      hop: options.granted ? 1 : message.hop + 1,
      stretchId: options.granted ?? stretchOf(message),
      ...(options.background ? { background: true } : {}),
    })
    .onConflictDoNothing()
    .returning();
  if (!run) return null;
  await enqueue(tx, {
    orgId: message.orgId,
    kind: "agent_run.execute",
    payload: { runId: run.id, ...(options.parkedSince ? { lineSince: options.parkedSince } : {}) },
    dedupeKey: `agent_run.execute:${run.id}`,
    maxAttempts: 4,
  });
  return { created: run };
}

/**
 * A parked wake looks again (`INBOX_JOB`): it starts or joins its agent's run in its conversation, or, the agent still
 * in line, waits for the next look. One agent's looks go one at a time, so wakes for one conversation share a run. A
 * note or question waiting so is answered by that run, and doesn't expire while it waits.
 */
export async function deliverParked(
  db: Database,
  orgId: string,
  input: { messageId: string; agentId: string; trigger: RunTrigger; look: number; since?: number },
) {
  const message = await getMessage(db, orgId, input.messageId);
  if (!message || message.deletedAt) return;
  // Archived, out of the conversation or, for a mention, out of the reach of whom it acts for since it parked: the
  // wake is dropped. A question or note so stops being kept open, and its asker hears it expired.
  const [still] = await eligibleChannelAgents(
    db,
    orgId,
    message.channelId,
    [input.agentId],
    input.trigger === "mention" ? { requesterUserId: await mentionRequester(db, message) } : {},
  );
  if (!still) return;
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`inbox:${input.agentId}`}))`);
    const out = await startOrJoinRun(tx, message, input.agentId, input.trigger, {
      park: input.look + 1,
      parkedSince: input.since ?? Date.now(),
    });
    await takeConsultation(
      tx,
      { orgId, messageId: message.id, agentId: input.agentId },
      out ? ("created" in out ? out.created.id : out.joined) : null,
    );
  });
}

/**
 * The question or note posted as `messageId` that no run took yet now waits on `runId`; with none, it waits on, its
 * deadline moved on (a parked wake's look).
 */
export async function takeConsultation(
  tx: Executor,
  where: { orgId: string; messageId: string; agentId?: string },
  runId: string | null,
) {
  await tx
    .update(agentConsultations)
    .set(
      runId
        ? { targetRunId: runId }
        : {
            expiresAt: sql`greatest(${agentConsultations.expiresAt}, ${new Date(Date.now() + INBOX_KEEP_OPEN_MS).toISOString()}::timestamptz)`,
          },
    )
    .where(
      and(
        eq(agentConsultations.orgId, where.orgId),
        eq(agentConsultations.messageId, where.messageId),
        where.agentId ? eq(agentConsultations.targetAgentId, where.agentId) : undefined,
        eq(agentConsultations.status, "open"),
        isNull(agentConsultations.targetRunId),
      ),
    );
}

/** The outbox job that wakes an agent once for the replies to its message that woke several agents. */
export const MENTION_REPORT_JOB = "mention.report_once";

/**
 * How long after the asked message its report waits at most for the agents it woke: past it, the author hears the
 * replies already in, even while one of them still waits for room on its computer (a run asks until it runs).
 */
const MENTION_REPORT_WAIT_MS = 35 * 60_000;

/**
 * Report once for @mentions (ADR 0032 "Calm wakes"; `reportHandOffs` does it for notes): `reply` names the author of
 * the message its run answers, a message that woke at least one other agent too (a run on it, a run it joined, or a
 * wake for it still parked), and the author's run that wrote it is no longer at work (one at work takes every reply).
 * The author is then woken once, when all of them are done (`reportMentionReplies`), instead of once per reply. One
 * look goes per message and author: it wakes on the newest reply anyway. Returns the author left out of this reply's
 * wake, else null.
 */
export async function deferMentionReport(db: Database, reply: Message, allowed: string[]): Promise<string | null> {
  if (!reply.agentRunId) return null;
  const [own] = await db
    .select({ triggerId: agentRuns.triggerMessageId })
    .from(agentRuns)
    .where(and(eq(agentRuns.orgId, reply.orgId), eq(agentRuns.id, reply.agentRunId)));
  const asked = own ? await getMessage(db, reply.orgId, own.triggerId) : null;
  const author = asked?.authorAgentId;
  if (!asked || !author || !allowed.includes(author) || asked.channelId !== reply.channelId) return null;
  if (asked.agentRunId) {
    const [writer] = await db
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(and(eq(agentRuns.orgId, reply.orgId), eq(agentRuns.id, asked.agentRunId)));
    if (writer?.status === "queued" || writer?.status === "running") return null;
  }
  const [woke] = rowsOf<{ n: number }>(
    await db.execute(sql`select count(*)::int as n from (
        select ${agentRuns.agentId}::text from ${agentRuns} where ${siblingRuns(reply.orgId, asked.id, author, true)}
        union ${parkedWakes(reply.orgId, asked.id, author)}) w`),
  );
  if (Number(woke?.n ?? 0) < 2) return null;
  const [looking] = await db
    .select({ id: outbox.id })
    .from(outbox)
    .where(
      and(
        eq(outbox.orgId, reply.orgId),
        eq(outbox.kind, MENTION_REPORT_JOB),
        eq(outbox.status, "pending"),
        sql`${outbox.payload}->>'triggerId' = ${asked.id}`,
        sql`${outbox.payload}->>'agentId' = ${author}`,
      ),
    )
    .limit(1);
  if (!looking)
    await enqueue(db, {
      orgId: reply.orgId,
      kind: MENTION_REPORT_JOB,
      payload: { replyId: reply.id, triggerId: asked.id, agentId: author, look: 0 },
      dedupeKey: `${MENTION_REPORT_JOB}:${reply.id}:${author}:0`,
    });
  return author;
}

/** Runs of agents other than the author on `triggerId`; with `joined`, also runs it joined that haven't read it. */
const siblingRuns = (orgId: string, triggerId: string, authorId: string, joined = false) =>
  and(
    eq(agentRuns.orgId, orgId),
    joined
      ? sql`(${agentRuns.triggerMessageId} = ${triggerId}::uuid or ${triggerId}::uuid = any(${agentRuns.pendingMessageIds}))`
      : eq(agentRuns.triggerMessageId, triggerId),
    ne(agentRuns.agentId, authorId),
    eq(agentRuns.background, false),
  );

/** The agents other than the author whose wake for `triggerId` still waits outside any run (`INBOX_JOB`). */
const parkedWakes = (orgId: string, triggerId: string, authorId: string) =>
  sql`select ${outbox.payload}->>'agentId' from ${outbox} where ${outbox.orgId} = ${orgId}::uuid
    and ${outbox.kind} = ${INBOX_JOB} and ${outbox.status} in ('pending', 'processing')
    and ${outbox.payload}->>'messageId' = ${triggerId} and ${outbox.payload}->>'agentId' <> ${authorId}`;

/**
 * A deferred report's look (`MENTION_REPORT_JOB`): while an agent the message woke is at work on it (queued,
 * running, in its computer's line, or parked), it looks again later, for at most `MENTION_REPORT_WAIT_MS`; then the
 * author is woken once, on the newest reply that names it (the others are in the conversation it reads). Long work
 * that stepped into the background and a wait for a computer that is gone don't hold it.
 */
export async function reportMentionReplies(
  db: Database,
  orgId: string,
  input: { replyId: string; triggerId: string; agentId: string; look: number },
  options: { maxHops: number },
) {
  const asked = await getMessage(db, orgId, input.triggerId);
  if (!asked) return null;
  if (Date.now() - asked.createdAt.getTime() < MENTION_REPORT_WAIT_MS) {
    const [working] = rowsOf<{ yes: boolean | string }>(
      await db.execute(sql`select (exists (select 1 from ${agentRuns}
          where ${siblingRuns(orgId, input.triggerId, input.agentId, true)} and ${agentRuns.workId} is null
            and (${agentRuns.status} in ('queued', 'running') or (${agentRuns.status} = 'waiting_input'
              and ${agentRuns.waitingMachineId} is not null
              and ${agentRuns.transcript}->'waitingForBrain'->>'code' = 'busy')))
        or exists (${parkedWakes(orgId, input.triggerId, input.agentId)})) as yes`),
    );
    if (working?.yes === true || working?.yes === "t") {
      const look = input.look + 1;
      await enqueue(db, {
        orgId,
        kind: MENTION_REPORT_JOB,
        payload: { ...input, look },
        dedupeKey: `${MENTION_REPORT_JOB}:${input.replyId}:${input.agentId}:${look}`,
        runAt: new Date(Date.now() + INBOX_LOOK_MS),
      });
      return null;
    }
  }
  const [last] = await db
    .select({ id: messages.id })
    .from(messages)
    .innerJoin(agentRuns, eq(agentRuns.id, messages.agentRunId))
    .where(
      and(
        eq(messages.orgId, orgId),
        eq(messages.channelId, asked.channelId),
        gte(messages.createdAt, asked.createdAt),
        isNull(messages.deletedAt),
        sql`${input.agentId}::uuid = any(${messages.mentionedAgentIds})`,
        siblingRuns(orgId, input.triggerId, input.agentId),
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(1);
  if (!last) return null;
  return dispatchMentions(db, { orgId, messageId: last.id }, { ...options, onlyAgentIds: [input.agentId] });
}

const byPerson = async (tx: Executor, message: Pick<Message, "id" | "orgId">) => {
  const [row] = await tx
    .select({ authorType: messages.authorType })
    .from(messages)
    .where(and(eq(messages.orgId, message.orgId), eq(messages.id, message.id)));
  return row?.authorType === "person";
};

/**
 * Whether a message may join a run active in its conversation (ADR 0053 §4, §9). A person's own words
 * steer the agent's run there (and put them behind an unattended one), except in the agents' DM, where a
 * run works for one person, and background work, which only its asker's join (ADR 0121). Another agent's message for a person, and work coming back to a person's run (a
 * note's reply, a task that ended, a folder decision), joins only a run working for that same person. A
 * routine's report joins only a run such news woke: never one working for a person, nor the agent's own work
 * (a mission's); it starts a run of its own. What nobody is behind still goes to whatever run works there.
 */
export async function mayJoin(
  tx: Executor,
  message: Pick<Message, "id" | "orgId" | "channelId">,
  runId: string,
): Promise<boolean> {
  const [channel] = await tx
    .select({ kind: channels.kind, dmKey: channels.dmKey })
    .from(channels)
    .where(and(eq(channels.orgId, message.orgId), eq(channels.id, message.channelId)));
  const agentsDm = !!channel && isAgentOnlyDm(channel);
  const [author] = await tx
    .select({ type: messages.authorType, userId: messages.authorUserId })
    .from(messages)
    .where(and(eq(messages.orgId, message.orgId), eq(messages.id, message.id)));
  if (!agentsDm && author?.type === "person") {
    // Background work acts on its asker's access: another person's own words never join it (`steerWork`).
    const [work] = await tx
      .select({ asker: agentWorks.requestedByUserId })
      .from(agentRuns)
      .innerJoin(agentWorks, eq(agentWorks.id, agentRuns.workId))
      .where(eq(agentRuns.id, runId));
    return !work || work.asker === author.userId;
  }
  const root = await messageRoot(tx, message.orgId, message.id);
  if (root.kind === "agent" && !agentsDm) return true;
  const behind = await runAuthorityById(tx, message.orgId, runId);
  if (root.kind === "person") return behind.personId === root.personId;
  if (root.kind === "agent") return behind.personId === null;
  return behind.kind === "unattended" && behind.reason !== "agent";
}

/** Active agents among `agentIds` that are members of the channel, or the right hand there (re-checked at dispatch time). */
export async function eligibleChannelAgents(
  db: Executor,
  orgId: string,
  channelId: string,
  agentIds: string[],
  options: { autoReplyOnly?: boolean; requesterUserId?: string | null } = {},
) {
  if (agentIds.length === 0) return [];
  return db
    .select({ id: agents.id, handle: agents.handle, name: agents.name, role: agents.role })
    .from(agents)
    .leftJoin(channelMembers, and(eq(channelMembers.agentId, agents.id), eq(channelMembers.channelId, channelId)))
    .where(
      and(
        eq(agents.orgId, orgId),
        inArray(agents.id, agentIds),
        isNull(agents.archivedAt),
        or(isNotNull(channelMembers.id), rightHandReaches(sql`${agents}`, sql`${channelId}::uuid`)),
        options.autoReplyOnly ? eq(channelMembers.autoReply, true) : undefined,
        // Who can talk to the agent, for the person behind the message.
        options.requesterUserId !== undefined
          ? audienceSql("agents", sql`${options.requesterUserId}::text`, { channelId: sql`${channelId}::uuid` })
          : undefined,
      ),
    );
}

/**
 * The person behind a message (`authority.ts`): its author, or for an agent's message the person
 * behind the run that wrote it. Null when nobody is (a routine, a webhook, an agent on its own).
 */
export const requesterOf = (db: Executor, message: Pick<Message, "orgId" | "id">) =>
  personOfMessage(db, message.orgId, message.id);

/**
 * Whom a mention acts for: an agent asking another one acts for the person behind its run, who must be allowed to
 * talk to it; a routine wakes only agents its creator can talk to.
 */
async function mentionRequester(db: Executor, message: Message) {
  const behind = message.agentRunId ?? (await routinePostRun(db, message));
  return (
    (await requesterOf(db, message)) ??
    (behind ? routineCreatorOf(await runAuthorityById(db, message.orgId, behind)) : null)
  );
}

/**
 * Handles `message.posted` for messages with mentions: starts one run per
 * explicitly @mentioned agent. A message whose hop already reached `maxHops`
 * (the depth backstop, `hopLimitReached`) triggers nobody.
 */
export async function dispatchMentions(
  db: Database,
  input: { orgId: string; messageId: string },
  options: { maxHops: number; onlyAgentIds?: string[] },
): Promise<DispatchResult> {
  const message = await getMessage(db, input.orgId, input.messageId);
  if (!message) return { runs: [], skipped: "message_missing" };
  const candidates = message.mentionedAgentIds.filter(
    (id) => id !== message.authorAgentId && (!options.onlyAgentIds || options.onlyAgentIds.includes(id)),
  );
  if (candidates.length === 0) return { runs: [], skipped: "no_mentions" };
  if (await hopLimitReached(db, message, options.maxHops)) return { runs: [], skipped: "hop_limit" };

  // Re-check at dispatch time: the agent may have been archived or removed from the channel since.
  const requester = await mentionRequester(db, message);
  const [eligible, here] = await Promise.all([
    eligibleChannelAgents(db, message.orgId, message.channelId, candidates, { requesterUserId: requester }),
    eligibleChannelAgents(db, message.orgId, message.channelId, candidates),
  ]);
  const runs = await db.transaction((tx) =>
    createAgentRuns(
      tx,
      message,
      eligible.map((a) => a.id),
      "mention",
      message.authorAgentId ? { park: 1 } : {},
    ),
  );
  const woken = new Set(eligible.map((a) => a.id));
  const present = new Map(here.map((a) => [a.id, a.handle]));
  const missing = candidates.filter((id) => !woken.has(id));
  if (missing.length === 0) return { runs };
  const handles = new Map(
    (
      await db
        .select({ id: agents.id, handle: agents.handle })
        .from(agents)
        .where(and(eq(agents.orgId, message.orgId), inArray(agents.id, missing)))
    ).map((a) => [a.id, a.handle]),
  );
  const dropped = missing.map((agentId) => ({
    agentId,
    handle: handles.get(agentId) ?? agentId,
    reason: present.has(agentId) ? ("audience" as const) : ("not_in_channel" as const),
  }));
  return { runs, dropped };
}

/**
 * A person's message in a DM with an agent: the agent always answers (no
 * router), within the hop limit. Mentions in a DM go through `dispatchMentions`.
 */
export async function dispatchDm(
  db: Database,
  message: Message,
  options: { maxHops: number },
): Promise<DispatchResult & { agentIds: string[] }> {
  if (message.authorType !== "person") return { runs: [], agentIds: [] };
  if (message.hop >= options.maxHops) return { runs: [], skipped: "hop_limit", agentIds: [] };
  const dm = await dmAgents(db, message.orgId, message.channelId);
  const allowed = await eligibleChannelAgents(
    db,
    message.orgId,
    message.channelId,
    dm.map((a) => a.id),
    { requesterUserId: message.authorUserId },
  );
  const agentIds = allowed.map((a) => a.id);
  const runs = await db.transaction((tx) => createAgentRuns(tx, message, agentIds, "dm"));
  return { runs, agentIds };
}

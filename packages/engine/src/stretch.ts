import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, desc, type Executor, eq, gt, inArray, isNull, rowsOf, schema, sql } from "@agenteschat/db";
import { getAgentCached } from "./agents";
import { recordAudit } from "./audit";
import { messageRoot } from "./authority";
import { routineBriefOfRun } from "./background";
import { eligibleChannelAgents, type RunTrigger, startOrJoinRun, takeConsultation } from "./dispatch";
import { isAgentOnlyDm } from "./dms";
import { ForbiddenError } from "./errors";
import { publishChannelEvent, publishMessageCreated } from "./events";
import { getMessage, insertMessage, type Message, messageView } from "./messages";
import { recordOperatorEvent } from "./operator-events";
import { can, type Membership } from "./organizations";
import { enqueue } from "./outbox";
import { routineBriefOf } from "./routine-brief";
import { type AgentRun, replyThreadOf } from "./runs";
import type { ToolOutput } from "./tools/types";
import { effectiveAgentBudget } from "./usage";

const { agentConsultations, agentRuns, agents, channels, messages, usageRecords } = schema;

/**
 * A stretch (ADR 0089): the work agents do on their own since a person last acted on it. A person's message opens
 * one (it is its own), and so does work nobody asked for (a routine's report). A run that reads a person's
 * message, answer, approval or secret, and every run Continuar starts, gets a fresh one. Messages and runs carry
 * their stretch next to their hop, so every way agents wake each other is counted.
 *
 * No limit reads words. Agents start at most `runs` runs on their own in one stretch (`unattendedRuns` when nobody
 * asked for the work), and each agent spends at most `budgetShare` of its monthly budget there. Past either, the
 * wake-up is held and one card in the conversation says why, with Continuar. Waiting costs nothing: only runs and
 * API spend count. A crowded computer never lowers these: its line orders and parks turns (ADR 0032 "Calm wakes").
 */
export const STRETCH = { runs: 50, unattendedRuns: 10, budgetShare: 0.2 } as const;

/**
 * How long work a person asked for (a stretch they opened) goes before agents' own in a computer's line
 * (`transcript.roomAsked`, ADR 0032 "Calm wakes").
 */
export const PERSON_ASKED_MS = 4 * 3600_000;

/** Nobody asked for the stretch's work: an agent wrote its first message, or it is a routine's brief. */
const unattendedSql = (orgId: string, stretchId: string) => sql`exists (select 1 from ${messages} m
  where m.org_id = ${orgId}::uuid and m.id = ${stretchId}::uuid and (m.author_type = 'agent' or m.meta ? 'routineBrief'))`;

/**
 * Whether a stretch is work a person asked for (their message, decision or Continuar opened it) within
 * `PERSON_ASKED_MS`. Stretch ids are UUIDv7: their first 48 bits are when it opened.
 */
export async function personAskedLately(db: Executor, orgId: string, stretchId: string): Promise<boolean> {
  const [row] = rowsOf<{ asked: boolean | string }>(
    await db.execute(sql`select (not ${unattendedSql(orgId, stretchId)}
      and ('x' || left(replace(${stretchId}::text, '-', ''), 12))::bit(48)::bigint > ${Date.now() - PERSON_ASKED_MS}) as asked`),
  );
  return row?.asked === true || row?.asked === "t";
}

/**
 * How many links up a chain of questions and hand-offs between agents the walks to where people read go
 * (`peopleRun`, `consultationOrigin`): notes have no depth cap of their own, the stretch bounds them.
 */
export const MAX_HANDOFF_LINKS = 10;

/** The outbox job that posts (or extends) a stretch's pause card. */
export const STRETCH_JOB = "stretch.paused";

/** What a tool that would wake an agent says once its stretch is at its limit. */
export const STRETCH_REFUSAL =
  "You and the other agents did what you may do on your own since a person last wrote. Tell the people here what is done and what is left. They can let you go on.";

/** A message's stretch: the one it carries, else (a root: a person's message, a routine's report) its own id. */
export const stretchOf = (m: Pick<Message, "id" | "stretchId">) => m.stretchId ?? m.id;

/** A run's stretch: the one it carries, else (an older row) its trigger. */
export const runStretchOf = (r: Pick<AgentRun, "stretchId" | "triggerMessageId">) => r.stretchId ?? r.triggerMessageId;

/** Why a stretch holds a wake-up: its runs reached `limit`, or the agent spent `limit`% of its monthly budget. */
export type StretchStop = { reason: "runs" | "spend"; limit: number };

/**
 * Whether one more run of `agentId` that agents started would pass its stretch's limits: the stretch's runs at hop
 * 2 or more (the ones agents or their events started; a person's message starts hop 1) against `STRETCH.runs`, or
 * `STRETCH.unattendedRuns` when nobody asked for the work (an agent wrote the stretch's first message, or it is a
 * routine's brief: what a routine's run starts counts like its report's); and this agent's spend on its own such
 * runs, billed to the workspace (a plan costs it nothing), against `STRETCH.budgetShare` of its monthly budget.
 * A wake-up on `triggerId` that already has its run (a redelivered event) is never held.
 */
export async function stretchStop(
  db: Executor,
  orgId: string,
  stretchId: string,
  agentId: string,
  triggerId: string | null = null,
): Promise<StretchStop | null> {
  const [row] = rowsOf<{
    started: boolean;
    runs: number;
    unattended: boolean;
    spent: string | number | null;
  }>(
    await db.execute(sql`with runs as (
        select r.id, r.agent_id, r.created_at from ${agentRuns} r
        where r.org_id = ${orgId}::uuid and r.stretch_id = ${stretchId}::uuid and r.hop >= 2
      ), mine as (select id, created_at from runs where agent_id = ${agentId}::uuid)
      select exists (select 1 from ${agentRuns} s where ${triggerId}::uuid is not null
          and s.trigger_message_id = ${triggerId}::uuid and s.agent_id = ${agentId}::uuid) as started,
        (select count(*) from runs)::int as runs,
        ${unattendedSql(orgId, stretchId)} as unattended,
        (select sum(u.cost_nano_usd) from ${usageRecords} u
          where u.org_id = ${orgId}::uuid and u.agent_id = ${agentId}::uuid and u.billed_to = 'org'
            and u.created_at >= (select min(created_at) from mine) and u.run_id in (select id from mine)) as spent`),
  );
  if (!row || row.started === true || (row.started as unknown) === "t") return null;
  const yes = (v: unknown) => v === true || v === "t";
  const limit = yes(row.unattended) ? STRETCH.unattendedRuns : STRETCH.runs;
  if (Number(row.runs) >= limit) return { reason: "runs", limit };
  const spent = Number(row.spent ?? 0);
  if (spent <= 0) return null;
  const agent = await getAgentCached(db, orgId, agentId);
  if (!agent) return null;
  return spent >= (await effectiveAgentBudget(db, agent)) * STRETCH.budgetShare
    ? { reason: "spend", limit: Math.round(STRETCH.budgetShare * 100) }
    : null;
}

/** A wake-up a stretch's limit holds, as its card job carries it. */
export interface StretchHold {
  stretchId: string;
  /** Where the card goes: the held message's conversation, or the refused run's. */
  channelId: string;
  threadId: string | null;
  /** Who the card is written as: the agent the work stopped at, and its run when one wrote the held message. */
  authorAgentId: string;
  runId: string | null;
  hop: number;
  /** What Continuar starts: this agent on this message (null: on the card). */
  agentId: string;
  messageId: string | null;
  trigger: RunTrigger;
  stop: StretchStop;
  /**
   * The agent the card names, when it isn't `agentId`: a refused tool's wake-up whose agent spent its budget share
   * (the card says whose money it is; Continuar still wakes the agent that was refused).
   */
  stoppedAgentId?: string;
}

/** Holds a wake-up: the card job, once per stretch, message (or refused run) and agent. */
export async function pauseStretch(tx: Executor, orgId: string, hold: StretchHold) {
  await enqueue(tx, {
    orgId,
    kind: STRETCH_JOB,
    payload: { ...hold },
    dedupeKey: `${STRETCH_JOB}:${hold.stretchId}:${hold.messageId ?? hold.runId}:${hold.agentId}`,
    maxAttempts: 4,
  });
}

/**
 * What `startOrJoinRun` holds: `agentId` woken by `message` (an agent's, at hop 1 or more) past its stretch. Held
 * inside the agents' private DM, its card goes where the people of this work read: with the run that wrote the
 * message, up the chain (`peopleRun`). Continuar still starts the held run in that DM.
 */
export async function holdOf(
  tx: Executor,
  message: Pick<
    Message,
    "id" | "orgId" | "channelId" | "threadId" | "hop" | "stretchId" | "authorAgentId" | "agentRunId"
  >,
  agentId: string,
  trigger: RunTrigger,
  stop: StretchStop,
): Promise<StretchHold> {
  const hold: StretchHold = {
    stretchId: stretchOf(message),
    channelId: message.channelId,
    threadId: message.threadId,
    authorAgentId: message.authorAgentId ?? agentId,
    runId: message.agentRunId,
    hop: message.hop,
    agentId,
    messageId: message.id,
    trigger,
    stop,
  };
  const [channel] = await tx
    .select({ kind: channels.kind, dmKey: channels.dmKey })
    .from(channels)
    .where(and(eq(channels.orgId, message.orgId), eq(channels.id, message.channelId)));
  const [writer] =
    channel && isAgentOnlyDm(channel) && message.agentRunId
      ? await tx
          .select()
          .from(agentRuns)
          .where(and(eq(agentRuns.orgId, message.orgId), eq(agentRuns.id, message.agentRunId)))
      : [];
  if (!writer) return hold;
  const at = await peopleRun(tx, writer);
  return {
    ...hold,
    channelId: at.channelId,
    threadId: replyThreadOf(at),
    authorAgentId: at.agentId,
    runId: at.id,
    hop: at.hop,
  };
}

type ToolRun = Pick<
  AgentRun,
  "id" | "orgId" | "agentId" | "channelId" | "threadRootId" | "triggerMessageId" | "hop" | "stretchId" | "background"
>;

/**
 * A tool that would wake an agent (`ask_agent`, `tell_agent`: the other one; `follow_up`: this one later) when
 * the stretch is at its limit: the pause card goes out, where the people of this work read (a routine's run: where
 * it reports; its Continuar wakes the agent there again), and the tool is refused. Null: it may go on.
 */
export async function refusedAtLimit(db: Database, run: ToolRun, wakes: string): Promise<ToolOutput | null> {
  const stretchId = runStretchOf(run);
  const stop = await stretchStop(db, run.orgId, stretchId, wakes);
  if (!stop) return null;
  const at = await peopleRun(db, run);
  const report = at.background ? (await routineBriefOfRun(db, at))?.deliverTo : undefined;
  await pauseStretch(db, run.orgId, {
    stretchId,
    channelId: report?.channelId ?? at.channelId,
    threadId: report ? report.threadId : replyThreadOf(at),
    authorAgentId: at.agentId,
    runId: at.id,
    hop: at.hop,
    agentId: at.agentId,
    messageId: null,
    trigger: "mention",
    stop,
    ...(stop.reason === "spend" ? { stoppedAgentId: wakes } : {}),
  });
  return { content: STRETCH_REFUSAL, isError: true };
}

/**
 * The run whose conversation people read: this one, or for a run in the agents' private DM (answering another
 * agent's question or note) the run that asked, up the chain.
 */
async function peopleRun(db: Executor, run: ToolRun): Promise<ToolRun> {
  let at = run;
  for (let i = 0; i < MAX_HANDOFF_LINKS; i++) {
    const [channel] = await db
      .select({ kind: channels.kind, dmKey: channels.dmKey })
      .from(channels)
      .where(and(eq(channels.orgId, at.orgId), eq(channels.id, at.channelId)));
    if (!channel || !isAgentOnlyDm(channel)) return at;
    const trigger = await getMessage(db, at.orgId, at.triggerMessageId);
    const note = (trigger?.meta.agentNote as { runId?: unknown } | undefined)?.runId;
    const [asker] = await db
      .select()
      .from(agentRuns)
      .where(
        typeof note === "string"
          ? and(eq(agentRuns.orgId, at.orgId), eq(agentRuns.id, note))
          : sql`${agentRuns.id} = (select ${agentConsultations.askerRunId} from ${agentConsultations}
              where ${agentConsultations.orgId} = ${at.orgId}::uuid
                and ${agentConsultations.messageId} = ${at.triggerMessageId}::uuid limit 1)`,
      );
    if (!asker) return at;
    at = asker;
  }
  return at;
}

/** `meta.actionCard` of a stretch's pause card (ADR 0089). Only the card job and Continuar write it. */
export interface StretchCard {
  kind: "stretch_paused";
  stretchId: string;
  state: "paused" | "continued";
  /** `runs` once any wake-up stopped at the run limit; `spend` while only agents' budget shares held them. */
  reason: "runs" | "spend";
  /** The run limit reached (50, or 10 when nobody asked); with `spend`, the budget share in percent. */
  limit: number;
  /**
   * Who hears of it and may go on (with the agents' owners and admins): the person behind the work, else the
   * routine's creator.
   */
  forUserId: string | null;
  /** The agents that stopped, in order. */
  agentIds: string[];
  /** What Continuar starts: each agent on the message that would have woken it (null: on this card). */
  /** `threadId` (when `messageId` is null): the thread of the card's channel it was held in (null: the timeline). */
  held: { agentId: string; messageId: string | null; threadId?: string | null; trigger: RunTrigger }[];
  continuedByUserId: string | null;
  continuedAt: string | null;
}

export const stretchCardOf = (meta: Record<string, unknown> | null | undefined): StretchCard | null => {
  const card = meta?.actionCard as Partial<StretchCard> | undefined;
  return card?.kind === "stretch_paused" && typeof card.stretchId === "string" && Array.isArray(card.held)
    ? (card as StretchCard)
    : null;
};

/** One card per stretch: its writers take turns. */
const lockCard = (tx: Executor, stretchId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`stretch-card:${stretchId}`}))`);

/** The card's English text (what agents read, and the fallback) and its code for the apps. */
function cardText(card: StretchCard, names: string[]) {
  const who = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "The agents");
  const body =
    card.reason === "runs"
      ? `${who} paused to check with you before going on.`
      : `${who} paused to check with you. ${names.length > 1 ? "Each" : "It"} used ${card.limit}% of the month's budget.`;
  return {
    body,
    meta: {
      bodyCode: `stretch_paused_${card.reason}`,
      // `count`: how many agents (its plural); the apps name them in the reader's language.
      bodyParams: {
        agents: names.join(", "),
        count: names.length,
        ...(card.reason === "spend" ? { percent: card.limit } : {}),
      },
    },
  };
}

/**
 * Who hears of a pause and may go on first: the person behind `messageId`'s work, else its routine's creator (of
 * the report it started from, or of the brief that opened the stretch: work a routine's run started).
 */
async function accountableFor(db: Database, orgId: string, messageId: string, stretchId: string) {
  const root = await messageRoot(db, orgId, messageId);
  if (root.kind === "person") return root.personId;
  if (root.kind !== "routine_report" || !root.backgroundRunId) {
    return routineBriefOf((await getMessage(db, orgId, stretchId))?.meta)?.creatorUserId ?? null;
  }
  const [row] = await db
    .select({ meta: messages.meta })
    .from(agentRuns)
    .innerJoin(messages, and(eq(messages.orgId, agentRuns.orgId), eq(messages.id, agentRuns.triggerMessageId)))
    .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.id, root.backgroundRunId)));
  return routineBriefOf(row?.meta)?.creatorUserId ?? null;
}

/**
 * Job `stretch.paused`: the stretch's card for the held wake-up, written as the agent the work stopped at (so the
 * person behind it hears of it, `notifyMessage`), or the card already waiting for this stretch with this wake-up
 * added. One card per stretch, wherever it waits: the ways a wake-up is held place it differently (the held
 * message's conversation, the refused run's reply thread, a long work's own thread, a routine's report), so one
 * stretch held in two of them would otherwise show the same agents' pause twice.
 */
export async function postStretchCard(deps: { db: Database; pubsub?: PubSub }, orgId: string, hold: StretchHold) {
  const { db } = deps;
  const behind = hold.messageId ?? (await runTriggerOf(db, orgId, hold.runId));
  const forUserId = behind ? await accountableFor(db, orgId, behind, hold.stretchId) : null;
  const entry = {
    agentId: hold.agentId,
    messageId: hold.messageId,
    ...(hold.messageId ? {} : { threadId: hold.threadId }),
    trigger: hold.trigger,
  };
  const stopped = hold.stoppedAgentId ?? hold.agentId;
  const card = await db.transaction(async (tx) => {
    await lockCard(tx, hold.stretchId);
    // Where it can wait: this hold's channel, or one the stretch's runs work in (by their index, not the meta). A
    // wake-up with no message starts on the card, so only a card in its own channel can hold it.
    const [open] = await tx
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.orgId, orgId),
          hold.messageId
            ? sql`(${messages.channelId} = ${hold.channelId}::uuid or ${messages.channelId} in (
            select distinct ${agentRuns.channelId} from ${agentRuns}
            where ${agentRuns.orgId} = ${orgId}::uuid and ${agentRuns.stretchId} = ${hold.stretchId}::uuid))`
            : eq(messages.channelId, hold.channelId),
          gt(messages.createdAt, new Date(Date.now() - 7 * 86_400_000)),
          isNull(messages.deletedAt),
          sql`${messages.meta}->'actionCard'->>'kind' = 'stretch_paused'`,
          sql`${messages.meta}->'actionCard'->>'stretchId' = ${hold.stretchId}`,
          sql`${messages.meta}->'actionCard'->>'state' = 'paused'`,
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(1);
    const was = open ? stretchCardOf(open.meta) : null;
    const next: StretchCard = was
      ? {
          ...was,
          ...(was.reason === "spend" && hold.stop.reason === "runs" ? { reason: "runs", limit: hold.stop.limit } : {}),
          agentIds: was.agentIds.includes(stopped) ? was.agentIds : [...was.agentIds, stopped],
          held: was.held.some(
            (h) =>
              h.agentId === entry.agentId &&
              h.messageId === entry.messageId &&
              (h.threadId ?? null) === (entry.threadId ?? null),
          )
            ? was.held
            : [...was.held, entry],
        }
      : {
          kind: "stretch_paused",
          stretchId: hold.stretchId,
          state: "paused",
          reason: hold.stop.reason,
          limit: hold.stop.limit,
          forUserId,
          agentIds: [stopped],
          held: [entry],
          continuedByUserId: null,
          continuedAt: null,
        };
    const named = await tx
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(and(eq(agents.orgId, orgId), inArray(agents.id, next.agentIds)));
    const text = cardText(
      next,
      next.agentIds.flatMap((id) => named.find((a) => a.id === id)?.name ?? []),
    );
    const meta = { ...text.meta, actionCard: next };
    if (open) {
      const [row] = await tx
        .update(messages)
        .set({ body: text.body, meta: { ...open.meta, ...meta } })
        .where(and(eq(messages.orgId, orgId), eq(messages.id, open.id)))
        .returning();
      return row ?? null;
    }
    const author =
      hold.runId !== null
        ? ({ type: "agent", agentId: hold.authorAgentId, runId: hold.runId, hop: hold.hop } as const)
        : ({
            type: "agent",
            agentId: hold.authorAgentId,
            runId: null,
            hop: hold.hop,
            stretchId: hold.stretchId,
          } as const);
    const message = await insertMessage(tx, {
      orgId,
      channelId: hold.channelId,
      threadId: hold.threadId,
      author,
      body: text.body,
      meta,
    });
    // Its run tells the person behind it; the card tells them (or the routine's creator) either way.
    await enqueue(tx, {
      orgId,
      kind: "notifications.message",
      payload: { messageId: message.id },
      dedupeKey: `notifications.message:${message.id}`,
      maxAttempts: 4,
    });
    return message;
  });
  if (card && deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(card));
  return card;
}

async function runTriggerOf(db: Database, orgId: string, runId: string | null) {
  if (!runId) return null;
  const [run] = await db
    .select({ triggerMessageId: agentRuns.triggerMessageId })
    .from(agentRuns)
    .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.id, runId)));
  return run?.triggerMessageId ?? null;
}

/**
 * Continuar on a pause card (`POST …/messages/{id}/answer-now`): the card moves from paused to continued (once:
 * a second press starts nothing), and each held wake-up whose agent is still active there starts at hop 1 in a
 * fresh stretch, past the old one's limits. Who asked, the agents' owners or an admin, the same people as Continuar
 * under a stopped reply. Audited.
 */
export async function continueStretch(
  deps: { db: Database; pubsub?: PubSub },
  userId: string,
  membership: Membership,
  message: Message,
  card: StretchCard,
): Promise<{ runs: { agentId: string; runId: string }[] }> {
  const { db } = deps;
  const owners = await db
    .select({ owner: agents.ownerUserId })
    .from(agents)
    .where(and(eq(agents.orgId, message.orgId), inArray(agents.id, card.agentIds)));
  if (card.forUserId !== userId && !owners.some((a) => a.owner === userId) && !can(membership, "manage_agents"))
    throw new ForbiddenError("Only who asked, the agents' owners or an admin can do this", "run.answer_forbidden");
  const stretchId = Bun.randomUUIDv7();
  const done = await db.transaction(async (tx) => {
    await lockCard(tx, card.stretchId);
    // What it holds now: a wake-up held after the caller read the card may have joined it since.
    const now = stretchCardOf((await getMessage(tx, message.orgId, message.id))?.meta);
    if (now?.state !== "paused") return null;
    const next: StretchCard = {
      ...now,
      state: "continued",
      continuedByUserId: userId,
      continuedAt: new Date().toISOString(),
    };
    const [row] = await tx
      .update(messages)
      .set({ meta: sql`jsonb_set(${messages.meta}, '{actionCard}', ${JSON.stringify(next)}::jsonb)` })
      .where(
        and(
          eq(messages.orgId, message.orgId),
          eq(messages.id, message.id),
          sql`${messages.meta}->'actionCard'->>'state' = 'paused'`,
        ),
      )
      .returning();
    if (!row) return null;
    const runs: AgentRun[] = [];
    const started: { agentId: string; runId: string }[] = [];
    for (const h of next.held) {
      // No message: on the card, in the thread it was held in (the card may wait in another one).
      const trigger = h.messageId
        ? await getMessage(tx, message.orgId, h.messageId)
        : h.threadId === undefined
          ? row
          : { ...row, threadId: h.threadId };
      if (!trigger || trigger.deletedAt) continue;
      const [active] = await eligibleChannelAgents(tx, message.orgId, trigger.channelId, [h.agentId]);
      if (!active) continue;
      const out = await startOrJoinRun(tx, trigger, h.agentId, h.trigger, { granted: stretchId });
      if (!out) continue;
      // A question or a note the stretch held is answered by the run that takes it now (ADR 0095).
      await takeConsultation(
        tx,
        { orgId: message.orgId, messageId: trigger.id },
        "created" in out ? out.created.id : out.joined,
      );
      if ("joined" in out) {
        await rerootRun(tx, { id: out.joined }, stretchId);
        // Should that run end before reading it, the run it is handed on to counts in the new stretch, not in the
        // spent one.
        await tx
          .update(messages)
          .set({ stretchId })
          .where(and(eq(messages.orgId, trigger.orgId), eq(messages.id, trigger.id)));
      } else runs.push(out.created);
      started.push({ agentId: h.agentId, runId: "created" in out ? out.created.id : out.joined });
    }
    await recordAudit(tx, {
      orgId: message.orgId,
      actor: { type: "person", id: userId },
      action: "stretch.continued",
      target: { type: "message", id: message.id },
      details: { stretchId: card.stretchId, newStretchId: stretchId, runs: started },
      channelId: message.channelId,
    });
    return { row, runs, started };
  });
  if (!done) return { runs: [] };
  if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(done.row));
  for (const run of done.runs) {
    await publishChannelEvent(deps.pubsub, {
      type: "agent.thinking",
      channelId: run.channelId,
      threadId: replyThreadOf(run),
      agentId: run.agentId,
      runId: run.id,
    });
  }
  return { runs: done.started };
}

/**
 * A person acted on this run's work (it read their message, they decided what it waited on, they let it go on):
 * hop 1 and a fresh stretch, in the row and on `run`, so what it starts from here counts from zero.
 */
export async function rerootRun(
  db: Executor,
  run: { id: string; hop?: number; stretchId?: string | null },
  stretchId: string,
) {
  await db.update(agentRuns).set({ hop: 1, stretchId }).where(eq(agentRuns.id, run.id));
  run.hop = 1;
  run.stretchId = stretchId;
}

/**
 * The depth backstop (`AGENT_MAX_HOPS`) holds a message: the stretch limits stop agents long before, so reaching it
 * means some path lost its stretch, and the operator hears of it.
 */
export async function hopLimitReached(
  db: Executor,
  message: Pick<Message, "id" | "orgId" | "hop">,
  maxHops: number,
): Promise<boolean> {
  if (message.hop < maxHops) return false;
  await recordOperatorEvent(db, {
    type: "run.hop_limit",
    orgId: message.orgId,
    data: { messageId: message.id, hop: message.hop },
  });
  return true;
}

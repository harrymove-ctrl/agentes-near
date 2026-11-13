import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, desc, eq, gt, inArray, isNull, schema, sql } from "@agenteschat/db";
import { type AiStatusDeps, agentAiState } from "./ai-status";
import { canTalkTo, speakerFor, viaAgent } from "./audience";
import { fedByRoutine, personOfMessage, routinePostRun, runAuthorityById } from "./authority";
import { chainOfRun, NOTE_DEDUPE_MS, sendNote } from "./consultations";
import { publishChannelEvent, publishMessageCreated } from "./events";
import { getMessage, type Message, messageView } from "./messages";
import { notifyAgentUnreached } from "./notification-producers";
import { routineCreatorOf } from "./requester";
import type { RoutineBrief } from "./routine-brief";

const { agents, agentConsultations, channels, messages, routingDecisions } = schema;

/**
 * Why an agent's mention didn't wake the agent it names, the one vocabulary every skip uses (`routing_decisions.reason`,
 * `meta.reach`): `not_in_channel`, on messages from before an agent's @ stopped reaching outsiders (a passing name woke them);
 * `audience`, the person behind the message can't talk to it (consulted as a note instead, when it takes consultations);
 * `routine_creator_reach`, a routine is behind it and
 * its creator's reach (a routine's) doesn't take it there.
 */
export type ReachReason = "not_in_channel" | "audience" | "routine_creator_reach";

/**
 * One agent a message named and didn't wake as a mention (`meta.reach`), what the people there read under it.
 * `consultationId`: delivered as a hand-off note to its private DM (`audience`, when it takes consultations for people
 * outside its audience: it answers the agent, never them). `outside`: old messages, also not a member there. `userId`: whose reach fell short (the person behind it, or the routine's creator), so the agent's owner
 * can let them in. A routine behind it: its id, name, creator and access.
 */
export interface ReachEntry {
  agentId: string;
  handle: string;
  reason: ReachReason;
  consultationId?: string;
  outside?: true;
  /** `not_in_channel` from a private conversation, on messages from before such mentions were forwarded too. */
  private?: true;
  /** `not_in_channel` to an agent with no AI connected: nothing could answer it. */
  noAi?: true;
  /** Old messages only: a routine then set to only read named a member in its own message, which woke nobody. */
  routinePost?: true;
  userId?: string;
  routine?: { id: string; name: string; creatorUserId: string | null; access: RoutineBrief["access"] };
}

/** `meta.reach`, read safely. */
export function reachOf(meta: Record<string, unknown> | null | undefined): ReachEntry[] {
  const list = meta?.reach;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (e): e is ReachEntry =>
      !!e && typeof e === "object" && typeof e.agentId === "string" && typeof e.handle === "string",
  );
}

/**
 * What the author reads in its next context about the agents its message named and didn't wake (`meta.reach`): who
 * got it as a note and how to reach them next time, who couldn't be called and why. "" when none.
 */
export function reachNote(entries: ReachEntry[]): string {
  return entries
    .map((e) => {
      if (e.consultationId && e.reason !== "not_in_channel")
        return `[Delivered as a note]: @${e.handle} only answers the people here through other agents, so your mention went to it privately (tell_agent); what comes of it reaches you here, for you to pass on. To reach it next time, use tell_agent or ask_agent.`;
      if (e.consultationId)
        return `[Delivered as a note]: @${e.handle} isn't in this conversation, so your mention went to it as a note (tell_agent); what comes of it reaches you here. To reach it next time, use tell_agent or ask_agent.`;
      if (e.routinePost)
        return `[Not delivered]: @${e.handle} wasn't woken: this routine is set to only look and tell, so its message wakes nobody, even the agents it mentions. If it should call agents, the people here can set it to act.`;
      if (e.noAi)
        return `[Not delivered]: @${e.handle} isn't in this conversation and has no AI connected, so nothing could answer it. The people here can see that.`;
      if (e.private)
        return `[Not delivered]: @${e.handle} isn't in this private conversation, so your mention wasn't forwarded (what's said here stays here). If it needs something, hand it with tell_agent in a note you write yourself, with only what it may know.`;
      const why =
        e.reason === "routine_creator_reach"
          ? "it only works with some people, and the person who set up the routine behind this isn't one of them"
          : "it only works with some people, and the person you are helping isn't one of them";
      return `[Not delivered]: @${e.handle} wasn't called: ${why}. The people here can see that; don't mention it again for this, say what you need from it instead.`;
    })
    .join("\n");
}

/**
 * Whose reach a message's mentions have: the person behind it, or the creator of the routine behind it
 * (`routineCreatorOf`); `routine`: the routine its chain roots in, if any (its bounds hold, ADR 0053 §4).
 */
export async function reachOfMessage(db: Database, message: Pick<Message, "orgId" | "id" | "agentRunId" | "meta">) {
  const person = await personOfMessage(db, message.orgId, message.id);
  const runId = message.agentRunId ?? (await routinePostRun(db, message));
  if (person || !runId) return { person, routine: null };
  const authority = await runAuthorityById(db, message.orgId, runId);
  const routine = authority.kind !== "person" && fedByRoutine(authority) ? (authority.brief ?? null) : null;
  return { person: routineCreatorOf(authority), routine };
}

/**
 * For an agent's message once its mentions were dispatched: `blocked`, members its mention didn't wake for who is
 * behind it, are told under it, or go as a hand-off note (`sendNote`, as `tell_agent`) when they take consultations.
 * Each one is written on the message (`meta.reach`, the line under it, and the author's next context), in
 * `routing_decisions`, and, when a routine's creator couldn't reach an agent, told to that agent's owner. An agent @named
 * outside the conversation isn't here: that @ reaches nobody, and `unreachedNote` tells the author so.
 */
export async function settleReach(
  deps: { db: Database; pubsub?: PubSub } & Partial<Pick<AiStatusDeps, "gateway" | "machines">>,
  message: Message,
  input: { blocked: string[] },
): Promise<ReachEntry[]> {
  const { db } = deps;
  const ids = [...new Set(input.blocked)];
  if (ids.length === 0) return [];
  const rows = await db
    .select()
    .from(agents)
    .where(and(eq(agents.orgId, message.orgId), inArray(agents.id, ids), isNull(agents.archivedAt)));
  const { person, routine } = await reachOfMessage(db, message);
  const talks = await speakerFor(db, message.orgId, person);
  const blockedReason: ReachReason = routine ? "routine_creator_reach" : "audience";
  const routineRef = routine
    ? { id: routine.routineId, name: routine.name, creatorUserId: routine.creatorUserId, access: routine.access }
    : undefined;
  const blockedOf = (a: { id: string; handle: string }): ReachEntry => ({
    agentId: a.id,
    handle: a.handle,
    reason: blockedReason,
    ...(person ? { userId: person } : {}),
    ...(routineRef ? { routine: routineRef } : {}),
  });
  const entries: ReachEntry[] = [];
  // A member that takes consultations is asked privately instead: it answers the agent, never the person here.
  const consulted = viaAgent(talks);
  const consultedOnly = (r: (typeof rows)[number]) =>
    !!person && !canTalkTo(r, person, talks) && canTalkTo(r, person, consulted);
  for (const a of rows.filter((r) => !consultedOnly(r))) entries.push(blockedOf(a));
  const asked = rows.filter(consultedOnly);
  if (asked.length > 0) {
    const [where] = await db
      .select({ name: channels.name, kind: channels.kind })
      .from(channels)
      .where(and(eq(channels.orgId, message.orgId), eq(channels.id, message.channelId)));
    const [author] = message.authorAgentId
      ? await db.select({ handle: agents.handle }).from(agents).where(eq(agents.id, message.authorAgentId))
      : [];
    // A routine's own message speaks for the routine's run that posted it.
    const runId = message.agentRunId ?? (await routinePostRun(db, message));
    const chain = runId ? [...(await chainOfRun(db, message.orgId, runId)), message.authorAgentId as string] : [];
    const place = where?.kind === "channel" ? `#${where.name}` : "a conversation";
    for (const a of asked) {
      // A routine reaches only its creator's agents.
      const may = !!runId && !!message.authorAgentId && !chain.includes(a.id) && canTalkTo(a, person, consulted);
      if (!may) {
        entries.push(blockedOf(a));
        continue;
      }
      if (
        deps.gateway &&
        (await agentAiState({ db, gateway: deps.gateway, machines: deps.machines }, a, undefined, person ?? undefined))
          .state === "no_ai"
      ) {
        entries.push({ agentId: a.id, handle: a.handle, reason: blockedReason, noAi: true });
        continue;
      }
      // Already handed to it by this run (its own tell_agent): that note is the delivery.
      const [handed] = await db
        .select({ id: agentConsultations.id })
        .from(agentConsultations)
        .where(
          and(
            eq(agentConsultations.orgId, message.orgId),
            eq(agentConsultations.askerRunId, runId as string),
            eq(agentConsultations.targetAgentId, a.id),
          ),
        )
        .limit(1);
      const fresh = handed
        ? null
        : await sendNote(db, {
            orgId: message.orgId,
            agentId: message.authorAgentId as string,
            runId: runId as string,
            hop: message.hop,
            targetAgentId: a.id,
            body: `[@${author?.handle ?? "an agent"} mentioned you in ${place} for someone you answer only through other agents, so it reaches you here: answer it, not them]\n\n${message.body}`,
            chain,
            fromMention: true,
          });
      // `sendNote` drops the same note sent to it within the hour: that earlier one is the delivery.
      const [earlier] =
        handed || fresh
          ? []
          : await db
              .select({ id: agentConsultations.id })
              .from(agentConsultations)
              .where(
                and(
                  eq(agentConsultations.orgId, message.orgId),
                  eq(agentConsultations.askerAgentId, message.authorAgentId as string),
                  eq(agentConsultations.targetAgentId, a.id),
                  eq(agentConsultations.kind, "note"),
                  gt(agentConsultations.createdAt, new Date(Date.now() - NOTE_DEDUPE_MS)),
                ),
              )
              .orderBy(desc(agentConsultations.createdAt))
              .limit(1);
      const sent = handed ? { consultationId: handed.id } : (fresh ?? (earlier && { consultationId: earlier.id }));
      if (!sent) continue;
      entries.push({
        agentId: a.id,
        handle: a.handle,
        reason: blockedReason,
        consultationId: sent.consultationId,
      });
      if (fresh && deps.pubsub && runId) {
        await publishChannelEvent(deps.pubsub, {
          type: "agent.consulting",
          channelId: message.channelId,
          threadId: message.threadId,
          runId,
          agentId: message.authorAgentId as string,
          consultedAgentId: a.id,
          kind: "note",
        });
      }
    }
  }
  if (entries.length === 0) return [];
  await recordReach(db, message, entries);
  await db
    .update(messages)
    .set({ meta: sql`jsonb_set(${messages.meta}, '{reach}', ${JSON.stringify(entries)}::jsonb)` })
    .where(and(eq(messages.orgId, message.orgId), eq(messages.id, message.id)));
  const updated = await getMessage(db, message.orgId, message.id);
  if (updated && deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(updated));
  // Only a routine its creator's reach kept out: the agent's owner may let its creator in.
  for (const e of entries) {
    if (e.reason !== "routine_creator_reach" || e.routinePost || !e.routine?.creatorUserId) continue;
    await notifyAgentUnreached(deps, {
      orgId: message.orgId,
      agentId: e.agentId,
      routineId: e.routine.id,
      routineName: e.routine.name,
      creatorUserId: e.routine.creatorUserId,
      channelId: message.channelId,
      threadId: message.threadId,
      messageId: message.id,
    });
  }
  return entries;
}

/** Each skip in the message's routing decision (one row per message): the reasons first, the judge's words after. */
async function recordReach(db: Database, message: Message, entries: ReachEntry[]) {
  const reason = entries.map((e) => `${e.reason}: @${e.handle}`).join(", ");
  const selected = entries.filter((e) => e.consultationId).map((e) => e.agentId);
  await db
    .insert(routingDecisions)
    .values({
      orgId: message.orgId,
      channelId: message.channelId,
      messageId: message.id,
      strategy: "reach",
      candidates: entries.map((e) => ({ agentId: e.agentId, score: 0 })),
      selectedAgentIds: selected,
      reason: reason.slice(0, 500),
    })
    .onConflictDoUpdate({
      target: routingDecisions.messageId,
      set: {
        reason: sql`left(concat_ws('; ', ${reason}::text, ${routingDecisions.reason}), 500)`,
      },
    });
}

import { and, asc, desc, type Executor, eq, inArray, isNull, type SQL, schema, sql } from "@agenteschat/db";
import type { ReleasedAsks } from "./catch-up-triage";
import { ago } from "./context";
import { andList, cutText, possessive } from "./format";
import { landedAfterSql } from "./message-place";
import { stripSentinel } from "./reply-policy";
import { type AgentRun, replyThreadOf } from "./runs";

const { agents, messages, users } = schema;

/** A wait on the plan or budget at least this long is a catch-up: the run reads what happened since (ADR 0118). */
export const CATCH_UP_AFTER_MS = 10 * 60_000;
/** Asked longer ago than this: the agent asks whether it is still needed before long work. */
export const CATCH_UP_CONFIRM_AFTER_MS = 24 * 3600_000;
/** The last messages of the conversation a catch-up reads. */
const CATCH_UP_MESSAGES = 50;

/** Whether a run back from a wait on its plan or budget since `since` (ms) catches up (a conversation's, long enough). */
export const isCatchUp = (
  run: Pick<AgentRun, "background" | "workId">,
  waitedOn: string | undefined,
  since: number | undefined,
  now = Date.now(),
) =>
  (waitedOn === "plan_limit" || waitedOn === "budget") &&
  !run.background &&
  !run.workId &&
  since !== undefined &&
  now - since >= CATCH_UP_AFTER_MS;

/**
 * What a run catching up reads first: how long it was paused and why, everything posted in its conversation after
 * its trigger (the last `CATCH_UP_MESSAGES`, not the messages sent to it, which it reads as they come, nor the agents'
 * own waiting notes, a promise being no answer), who wrote, and how to answer: once, for what is still open, naming
 * each person when several asked, `pass` when it was handled (`mayPass`), and asking first before long work on an ask
 * older than a day.
 */
export async function catchUpText(
  db: Executor,
  run: Pick<AgentRun, "orgId" | "agentId" | "channelId" | "threadRootId" | "triggerMessageId" | "pendingMessageIds"> &
    Partial<Pick<AgentRun, "transcript">>,
  trigger: { createdAt: Date },
  w: {
    since: number;
    why: "plan" | "budget";
    plan?: string;
    mayPass: boolean;
    /** What the check before it found (`triageBrief`). */
    brief?: string;
    /** A person asked it to answer anyway (`continueRun`): said first; the caller passes `mayPass: false`. */
    anyway?: string;
  },
  now = Date.now(),
): Promise<string> {
  const threadId = replyThreadOf(run);
  const askIds = [run.triggerMessageId, ...run.pendingMessageIds];
  const released = (run.transcript as { releasedAsks?: ReleasedAsks[] } | null | undefined)?.releasedAsks ?? [];
  const skip = [...askIds, ...released.flatMap((r) => r.messageIds)];
  const read = (where: SQL | undefined) =>
    db
      .select({
        id: messages.id,
        body: messages.body,
        at: messages.createdAt,
        threadId: messages.threadId,
        agentId: messages.authorAgentId,
        person: users.name,
        agent: agents.name,
      })
      .from(messages)
      .leftJoin(users, eq(users.id, messages.authorUserId))
      .leftJoin(agents, eq(agents.id, messages.authorAgentId))
      .where(
        and(
          eq(messages.orgId, run.orgId),
          eq(messages.channelId, run.channelId),
          where,
          landedAfterSql(messages, trigger.createdAt),
          sql`not (${messages.id} = any(${`{${skip.join(",")}}`}::uuid[]))`,
          isNull(messages.deletedAt),
          sql`${messages.meta}->'usageWait' is null and ${messages.meta}->'notice' is null`,
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(CATCH_UP_MESSAGES);
  // Beside its conversation, the threads under what it was asked: another agent may have answered there.
  const [here, underAsks, askers] = await Promise.all([
    read(threadId ? eq(messages.threadId, threadId) : isNull(messages.threadId)),
    read(inArray(messages.threadId, askIds)),
    db
      .select({ id: messages.id, name: users.name })
      .from(messages)
      .leftJoin(users, eq(users.id, messages.authorUserId))
      .where(and(eq(messages.orgId, run.orgId), inArray(messages.id, askIds))),
  ]);
  const rows = [...here, ...underAsks].sort((a, b) => a.at.getTime() - b.at.getTime());
  const askerOf = new Map(askers.map((a) => [a.id, a.name]));
  const where = (r: (typeof rows)[number]) =>
    r.threadId && r.threadId !== threadId
      ? `, in the thread under ${possessive(askerOf.get(r.threadId) ?? "someone")} message`
      : "";
  const from = (r: (typeof rows)[number]) => (r.agentId === run.agentId ? "You" : (r.person ?? r.agent ?? "Someone"));
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(from(r), (counts.get(from(r)) ?? 0) + 1);
  const why = w.why === "budget" ? "your monthly budget ran out" : `the ${w.plan ?? "AI"} plan hit its limit`;
  const lines = [
    "# Catching up",
    `You were paused ${ago(new Date(w.since), now)} because ${why}, and you are back now.` +
      (rows.length > 0
        ? " Below is what was posted in this conversation after the message you were answering; the messages sent to you come after it."
        : " Nothing else was posted here meanwhile; the messages sent to you come after this."),
    ...(w.anyway ? [w.anyway] : []),
    "Reply once, covering only what is still open. If more than one person asked, name each person whose ask is still open and answer each." +
      (w.mayPass ? " If someone already answered it or it no longer applies, call `pass`." : ""),
    ...(now - w.since >= CATCH_UP_CONFIRM_AFTER_MS
      ? [
          "This was asked more than a day ago: ask whether it is still needed before starting long work or changing anything.",
        ]
      : []),
  ];
  // What it let go while it waited (`releaseAsks`) is someone else's now: it neither answers nor reads it as news.
  for (const r of released)
    lines.push(
      `${andList(r.askers.map(possessive))} ask was handled meanwhile${r.who ? ` by ${r.who}` : ""}: it isn't yours to answer anymore.`,
    );
  if (rows.length === 0 && w.brief) lines.push(w.brief);
  if (rows.length > 0) {
    const who = [...counts].map(([name, n]) => `${name} ${n}`).join(", ");
    lines.push(
      `Since you paused: ${rows.length} message${rows.length === 1 ? "" : "s"} (${who}).`,
      ...(w.brief ? [w.brief] : []),
      "",
      ...rows.map((r) => `[${from(r)}, ${ago(r.at, now)}${where(r)}]: ${cutText(stripSentinel(r.body), 600)}`),
    );
  }
  return lines.join("\n");
}

/** Who wrote in a waiting conversation after its trigger, for the queue's rows: how many messages, and the names. */
export async function writtenSince(
  db: Executor,
  orgId: string,
  where: { channelId: string; threadId: string | null; after: Date; triggerId: string; exceptAgentId: string },
): Promise<{ count: number; names: string[] }> {
  const rows = await db
    .select({ person: users.name, agent: agents.name, agentId: messages.authorAgentId })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.authorUserId))
    .leftJoin(agents, eq(agents.id, messages.authorAgentId))
    .where(
      and(
        eq(messages.orgId, orgId),
        eq(messages.channelId, where.channelId),
        where.threadId ? eq(messages.threadId, where.threadId) : isNull(messages.threadId),
        landedAfterSql(messages, where.after),
        // `after` is cut to milliseconds while Postgres keeps microseconds, and the trigger's id can be from a later
        // millisecond than its `created_at`: never the trigger itself.
        sql`${messages.id} <> ${where.triggerId}::uuid`,
        isNull(messages.deletedAt),
        sql`${messages.meta}->'usageWait' is null and ${messages.meta}->'notice' is null`,
      ),
    )
    .orderBy(asc(messages.createdAt))
    .limit(200);
  const names = [
    ...new Set(rows.filter((r) => r.agentId !== where.exceptAgentId).flatMap((r) => r.person ?? r.agent ?? [])),
  ];
  return { count: rows.filter((r) => r.agentId !== where.exceptAgentId).length, names };
}

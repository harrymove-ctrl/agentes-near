import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, eq, rowsOf, schema, sql } from "@agenteschat/db";
import { deliverNotice, publishDelivery } from "./delivery";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishMessageCreated } from "./events";
import { messageView, replyExcerpt } from "./messages";
import type { Notice } from "./notices";
import { requireActiveMembership } from "./organizations";
import { type AgentRun, computerWaitOf, type RunStatus, replyThreadOf } from "./runs";

/**
 * A person stopped an agent's task (ADR 0128): the agent is told, in the conversation the task belonged to (a
 * routine's room for a routine), with why when the person says it. The notice wakes nothing (stopping means stop):
 * the agent reads it before its next turn there. People see it as one line ("You stopped Dev · Waits until someone
 * asks to continue").
 */

const { agentRuns, agentWorks, messages, threads, users } = schema;

/** A stop reason's length at most. */
export const STOP_REASON_MAX = 500;

export interface StoppedRefs {
  runId: string;
  byUserId: string;
  byName: string;
  /** What the task was about (≤ 80). */
  label: string;
  /** What it was doing when stopped: `working`, `waiting` (an ok or an answer), `queued`. */
  was: "working" | "waiting" | "queued";
  reason?: string;
  /** The agents it had asked, stopped with it ("@ada, @rio"). */
  helpers?: string;
}

const refsOf = (r: StoppedRefs): Record<string, string> => ({ ...r }) as unknown as Record<string, string>;

const wasOf = (status: RunStatus): StoppedRefs["was"] =>
  status === "running" ? "working" : status === "queued" ? "queued" : "waiting";

/** What the agent reads (English, like every prompt). */
export function stoppedText(r: StoppedRefs): string {
  const doing =
    r.was === "working" ? "while you worked on it" : r.was === "queued" ? "before it started" : "while it waited";
  return [
    `${r.byName || "A person"} stopped your task${r.label ? ` «${r.label}»` : ""} ${doing}.`,
    ...(r.helpers ? [`What you asked of ${r.helpers} stopped with it: nothing more comes from them.`] : []),
    "What you already did or posted stays as it is.",
    r.reason ? `Their reason, in their words: «${r.reason}».` : "They gave no reason.",
    "Don't pick it up again on your own: only when someone asks you to.",
  ].join(" ");
}

const cleanReason = (reason: string | undefined) => {
  const r = reason?.replace(/\s+/g, " ").trim();
  if (!r) return undefined;
  if (r.length > STOP_REASON_MAX) throw new ValidationError(`A reason has at most ${STOP_REASON_MAX} characters`);
  return r;
};

/** What a run was about: its long work's title, its thread's title, else its first message. */
async function labelOfRun(db: Database, run: AgentRun): Promise<string> {
  const [row] = rowsOf<{ label: string | null }>(
    await db.execute(sql`select coalesce(nullif(w.title, ''), nullif(t.title, ''), root.body) as label
      from (select 1) one
      left join ${agentWorks} w on w.id = ${run.workId}::uuid
      left join ${threads} t on t.org_id = ${run.orgId}::uuid and t.root_message_id = ${run.threadRootId}::uuid
      left join lateral (
        select m.body from ${messages} m
        where m.org_id = ${run.orgId}::uuid and m.id = ${run.threadRootId}::uuid and m.deleted_at is null limit 1
      ) root on true`),
  );
  return replyExcerpt(row?.label ?? "", 80);
}

/**
 * After `stopRun` ended a run a person stopped: the notice to its agent. Best effort (the stop already happened).
 */
export async function tellAgentStopped(
  deps: { db: Database; pubsub?: PubSub },
  run: AgentRun,
  previous: RunStatus,
  byUserId: string,
  reason?: string,
  helpers: string[] = [],
): Promise<void> {
  const { db } = deps;
  const [person] = await db.select({ name: users.name }).from(users).where(eq(users.id, byUserId));
  const refs: StoppedRefs = {
    runId: run.id,
    byUserId,
    byName: person?.name ?? "",
    label: await labelOfRun(db, run),
    was: computerWaitOf(run) ? "waiting" : wasOf(previous),
    ...(cleanReason(reason) ? { reason: cleanReason(reason) } : {}),
    ...(helpers.length ? { helpers: helpers.join(", ") } : {}),
  };
  const notice: Notice = { kind: "run_stopped", text: stoppedText(refs), refs: refsOf(refs) };
  const delivered = await db.transaction((tx) =>
    deliverNotice(tx, {
      orgId: run.orgId,
      agentId: run.agentId,
      channelId: run.channelId,
      threadId: replyThreadOf(run),
      hop: run.hop,
      stretchId: run.stretchId,
      notice,
      wake: false,
    }),
  );
  await publishDelivery(deps.pubsub, delivered);
}

/**
 * The reason, said after the stop ("Dizer por quê"): only who stopped it, once. The notice the agent reads changes;
 * an agent that already read it reads the reason on its next turn.
 */
export async function setStopReason(
  deps: { db: Database; pubsub?: PubSub },
  userId: string,
  orgId: string,
  runId: string,
  reason: string,
): Promise<{ messageId: string }> {
  const { db } = deps;
  await requireActiveMembership(db, userId, orgId);
  const text = cleanReason(reason);
  if (!text) throw new ValidationError("Say why, or leave it");
  const [run] = await db
    .select({ channelId: agentRuns.channelId })
    .from(agentRuns)
    .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.id, runId)));
  if (!run) throw new NotFoundError("Run not found");
  const [message] = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.orgId, orgId),
        eq(messages.channelId, run.channelId),
        sql`${messages.meta}->'notice'->>'kind' = 'run_stopped'`,
        sql`${messages.meta}->'notice'->'refs'->>'runId' = ${runId}`,
      ),
    )
    .limit(1);
  if (!message) throw new NotFoundError("This task wasn't stopped by a person");
  const notice = message.meta.notice as Notice;
  const refs = notice.refs as unknown as StoppedRefs;
  if (refs.byUserId !== userId) {
    throw new ForbiddenError("Only who stopped it can say why", "run.stop_reason_forbidden");
  }
  if (refs.reason) throw new ValidationError("The reason was already sent");
  const next: StoppedRefs = { ...refs, reason: text };
  const meta = { ...message.meta, notice: { ...notice, text: stoppedText(next), refs: refsOf(next) } };
  const [updated] = await db
    .update(messages)
    .set({ meta, body: stoppedText(next) })
    .where(and(eq(messages.orgId, orgId), eq(messages.id, message.id)))
    .returning();
  if (updated && deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(updated));
  return { messageId: message.id };
}

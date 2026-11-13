import { type Database, rowsOf, schema, sql } from "@agenteschat/db";
import { replyExcerpt } from "./messages";
import { requirePermission } from "./organizations";
import { pendingIds } from "./recovery";

const { agentRuns, channels, channelMembers, threads } = schema;

/** Runs listed at most ("Trabalhando agora"). */
export const MAX_WORKING_RUNS = 100;
/** Length of a run's label. */
export const WORKING_LABEL_LENGTH = 80;

export interface WorkingRun {
  runId: string;
  agentId: string;
  channelId: string;
  channelKind: "channel" | "dm";
  /** Null for a DM. */
  channelName: string | null;
  /** Null: the main timeline (DMs are flat). */
  threadId: string | null;
  status: "queued" | "running" | "waiting_approval" | "waiting_input";
  startedAt: string | null;
  createdAt: string;
  /** What it works on, in a few words: the thread's title, never the words of its first message (null: say where). */
  label: string | null;
  /** Messages sent to it while it works that it hasn't read yet. */
  pendingMessageIds: string[];
  /** A routine's work in the background: it holds no conversation (people's messages never go to it). */
  background: boolean;
  /** Long work (ADR 0121): what it is, its plan's progress and since when. Null: a conversation's run. */
  work: { id: string; title: string; plan: { done: number; total: number } | null; since: string } | null;
}

/**
 * "Trabalhando agora" for any member: agent runs in progress (queued,
 * running, waiting for an approval or an answer) in the channels and DMs
 * they are in, newest first. A run waiting for its computer to come back (a computer brain
 * offline, ADR 0032 §5) isn't working: it's left out. Only conversations they read: never someone
 * else's DM, a private channel they're not in, nor agents' own DMs. No
 * cost, no internals.
 */
export async function listWorkingRuns(db: Database, userId: string, orgId: string): Promise<WorkingRun[]> {
  await requirePermission(db, userId, orgId, "read");
  const rows = rowsOf<{
    id: string;
    agent_id: string;
    channel_id: string;
    status: WorkingRun["status"];
    thread_root_id: string;
    trigger_message_id: string;
    started_at: string | Date | null;
    created_at: string | Date;
    kind: "channel" | "dm";
    name: string;
    title: string | null;
    pending: string[] | string | null;
    background: boolean | string;
    work_id: string | null;
    work_title: string | null;
    work_plan: { state: string }[] | string | null;
    work_started: string | Date | null;
  }>(
    await db.execute(sql`select r.id, r.agent_id, r.channel_id, r.status, r.thread_root_id, r.trigger_message_id,
        r.started_at, r.created_at, c.kind, c.name, t.title,
        array_to_json(r.pending_message_ids) as pending, r.background,
        w.id as work_id, w.title as work_title, w.plan as work_plan, w.started_at as work_started
      from ${agentRuns} r
      left join ${schema.agentWorks} w on w.id = r.work_id
      join ${channels} c on c.id = r.channel_id and c.org_id = ${orgId}::uuid
        and c.archived_at is null and c.kind in ('channel', 'dm')
      join ${channelMembers} cm on cm.org_id = ${orgId}::uuid and cm.channel_id = c.id and cm.user_id = ${userId}
      left join ${threads} t on t.org_id = ${orgId}::uuid and t.root_message_id = r.thread_root_id
      where r.org_id = ${orgId}::uuid and r.status in ('queued', 'running', 'waiting_approval', 'waiting_input')
        and r.waiting_machine_id is null
      order by r.created_at desc, r.id desc
      limit ${MAX_WORKING_RUNS}`),
  );
  const iso = (v: string | Date | null) => (v === null ? null : new Date(v).toISOString());
  return rows.map((r) => {
    const label = replyExcerpt(r.title?.trim() ?? "", WORKING_LABEL_LENGTH);
    return {
      runId: r.id,
      agentId: r.agent_id,
      channelId: r.channel_id,
      channelKind: r.kind,
      channelName: r.kind === "dm" ? null : r.name,
      // Where it answers (`replyThreadOf`): asked in the main timeline, there.
      threadId: r.thread_root_id === r.trigger_message_id ? null : r.thread_root_id,
      status: r.status,
      startedAt: iso(r.started_at),
      createdAt: iso(r.created_at) as string,
      label: label || null,
      pendingMessageIds: pendingIds(r.pending),
      background: r.background === true || r.background === "t",
      work: r.work_id
        ? workOf(r.work_id, r.work_title ?? "", r.work_plan, iso(r.work_started) ?? iso(r.created_at) ?? "")
        : null,
    };
  });
}

const workOf = (id: string, title: string, raw: { state: string }[] | string | null, since: string) => {
  const plan = typeof raw === "string" ? (JSON.parse(raw) as { state: string }[]) : (raw ?? []);
  return {
    id,
    title,
    plan: plan.length ? { done: plan.filter((p) => p.state === "done").length, total: plan.length } : null,
    since,
  };
};

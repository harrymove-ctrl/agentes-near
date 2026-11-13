import { PERMISSION_TOOL, type PubSub } from "@agenteschat/adapters";
import {
  and,
  asc,
  type Database,
  desc,
  type Executor,
  eq,
  inArray,
  isNull,
  or,
  rowsOf,
  type SQL,
  schema,
  sql,
} from "@agenteschat/db";
import { plainLine, plainLines } from "@agenteschat/ui/markdown";
import { getAgent } from "./agents";
import { audienceError, canTalkTo, speakerFor } from "./audience";
import { recordAudit } from "./audit";
import { runAuthorityById, runPerson } from "./authority";
import { requireChannelAccess } from "./channels";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import {
  publishChannelEvent,
  publishListChanged,
  publishMessageCreated,
  publishOrgEvent,
  publishUserEvent,
} from "./events";
import { cutText } from "./format";
import { boardColumns, columnForMove, columnOf, topRank } from "./issue-columns";
import type { IssueWorkMeta } from "./issue-work";
import { fileIdsOf, getMessage, insertMessage, type MessageView, messageView, postPersonMessage } from "./messages";
import { enqueueRunJob } from "./mission-runs";
import { notifyIssueChanged } from "./notification-producers";
import { can, getMembership, requireActiveMembership } from "./organizations";
import { membersWhoMaySql } from "./permissions";
import { fireRoutineEvent } from "./routines";
import { agentSearchChannels, enqueueIndex, registerDocumentBuilder } from "./search";
import { AUDIENCE_MAX, type Audience, admitTaskAgents, taskSeenSql } from "./task-access";
import {
  ensureTaskConversation,
  type TaskConversationRef,
  type TaskConversationSummary,
  taskConversationSummaries,
} from "./task-conversation";
import { promptAnswer, promptPoll, toolDetail } from "./tool-detail";
import { syncWikiLinks, withWikiLinks } from "./wiki-links";
import { type WorkRow, type WorkView, workViews } from "./works";

const {
  issues,
  issueActivity,
  issueCounters,
  channels,
  channelMembers,
  artifacts,
  agentConsultations,
  agentRuns,
  agentRunSteps,
  notifications,
  organizationMembers,
} = schema;

export type IssueStatus = "todo" | "in_progress" | "in_review" | "done" | "canceled";
export type IssuePriority = "low" | "normal" | "high";
export interface WorkActor {
  type: "person" | "agent";
  id: string;
}
export type IssueSource =
  | { type: "manual" }
  | { type: "message"; channelId: string; messageId: string }
  | { type: "agent"; agentId: string; workId?: string; channelId?: string; messageId?: string }
  | { type: "webhook"; provider: string };

/** An issue as the app shows it. */
export interface IssueView {
  id: string;
  number: number;
  title: string;
  description: string;
  status: IssueStatus;
  /** Its board column: always one of its stage. */
  columnId: string | null;
  /** Order inside the column, lowest first. */
  boardRank: number;
  priority: IssuePriority;
  assignee: WorkActor | null;
  labels: string[];
  dueDate: string | null;
  /** `doneBy`: who checked it (an agent shows its face next to it). */
  criteria: { id: string; text: string; done: boolean; doneBy?: WorkActor | null }[];
  createdBy: WorkActor;
  source: IssueSource;
  channelId: string | null;
  /** Who sees it besides administrators (ADR 0151). */
  audience: IssueAudience;
  /** The issue this one is a sub-issue of. */
  parentIssueId: string | null;
  pullRequests: { number: number; url: string; openedBy: WorkActor | null }[];
  /** The GitHub issue or pull request it is about: only a link, nothing syncs. */
  githubUrl: string | null;
  artifacts: { id: string; title: string; createdBy: WorkActor }[];
  /** The assigned agent's work on it, from its runs (null: a person has it, nobody, or it is closed). */
  work: IssueWork | null;
  /** Long work stopped on something (ADR 0121 §4): a badge, the card stays in its stage. */
  blocked: { reason: string; since: string; text?: string } | null;
  /** The agent's background work this card tracks (its plan, last update and line), newest. */
  backgroundWork: WorkView | null;
  /** Its conversation (ADR 0145), once someone wrote or opened it: replies, who took part, an agent at work. */
  conversation: TaskConversationSummary | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Who sees a task (ADR 0151): the workspace, or some people. `channelId`: those people are whoever is in that
 * conversation now, DM or private channel, so someone who joins it sees the task and someone who leaves it doesn't.
 */
export interface IssueAudience {
  mode: "everyone" | "people";
  userIds: string[];
  channelId: string | null;
}

/**
 * What the assigned agent is doing on an issue, derived from its runs (never
 * a status the agent sets): `running` / `waiting_approval` / `waiting_input`
 * while a linked run is alive; `stalled` when the issue is in progress with
 * the agent and no run is alive (it ended, failed or was stopped).
 */
export interface IssueWork {
  agentId: string;
  runId: string | null;
  state: "running" | "waiting_approval" | "waiting_input" | "stalled";
  /** When the live run started, or when the work stopped (stalled). */
  since: string;
  /**
   * The run's last tool calls, oldest first (safe labels only: built-in details, no connector inputs). A permission
   * check also says when its command was refused or still waits on a person (`outcome`).
   */
  steps: { tool: string; detail?: string; at: string; outcome?: "refused" | "waiting" }[];
  /** Stalled: how the last run ended, when it did not finish on its own. */
  reason?: "failed" | "canceled" | "budget";
}

/** One issue with its sub-issues. */
export interface IssueDetailView extends IssueView {
  subIssues: { id: string; number: number; title: string; status: IssueStatus; assignee: WorkActor | null }[];
}

export interface IssueActivityView {
  id: string;
  kind: "comment" | "event";
  author: WorkActor;
  text: string;
  event?: string;
  /** An event in the app's words (`issues.event.{textCode}`), with its params; `text` is the English fallback. */
  textCode?: string;
  textParams?: Record<string, string>;
  /** The system moved it on its own (status follows the agent's runs and PRs). */
  auto?: boolean;
  /** Files attached to a comment (Drive files; they are linked to the issue too). */
  attachments?: { id: string; title: string }[];
  createdAt: string;
}

export interface IssueInput {
  title: string;
  description?: string;
  criteria?: string[];
  assignee?: WorkActor | null;
  priority?: IssuePriority;
  dueDate?: string | null;
  labels?: string[];
  githubUrl?: string | null;
}

export type IssuePatch = Partial<{
  title: string;
  description: string;
  status: IssueStatus;
  /** A board column: the issue takes that column's stage. */
  columnId: string;
  boardRank: number;
  priority: IssuePriority;
  assignee: WorkActor | null;
  dueDate: string | null;
  labels: string[];
  /** Null removes it. */
  githubUrl: string | null;
  /**
   * The whole list of acceptance criteria, in order: an `id` keeps that criterion (and whether it is checked), one
   * without is new, and a criterion left out is removed.
   */
  criteria: { id?: string; text: string }[];
}>;

/** Who acts: a person, or an agent during a run (it sees what its channel lets it see). */
export type IssueActor = { type: "person"; userId: string } | AgentActor;
/** `runId`: the run acting (links the run to the issue it touches). */
type AgentActor = { type: "agent"; agentId: string; channelId: string; runId?: string };

type IssueRow = typeof issues.$inferSelect;
/** The columns that say who sees a task. */
type TaskScope = Pick<IssueRow, "channelId" | "restricted" | "audienceUserIds">;
/** What an agent's reach also reads of a task. */
type TaskRef = TaskScope & Partial<Pick<IssueRow, "assigneeType" | "assigneeId" | "conversationChannelId">>;

const WORKSPACE_SCOPE: TaskScope = { channelId: null, restricted: false, audienceUserIds: [] };

const STATUSES: readonly IssueStatus[] = ["todo", "in_progress", "in_review", "done", "canceled"];
const PRIORITIES: readonly IssuePriority[] = ["low", "normal", "high"];
const STATUS_WORDS: Record<IssueStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
  canceled: "Canceled",
};

const actorOf = (a: IssueActor): WorkActor =>
  a.type === "person" ? { type: "person", id: a.userId } : { type: "agent", id: a.agentId };

function checkDate(d: string | null | undefined) {
  if (d === undefined || d === null) return d;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) {
    throw new ValidationError("dueDate must be YYYY-MM-DD");
  }
  return d;
}

function cleanLabels(labels: string[] | undefined) {
  if (!labels) return undefined;
  return [...new Set(labels.map((l) => l.trim().toLowerCase().slice(0, 40)).filter(Boolean))].slice(0, 20);
}

/** `scope`: who sees the task, which a person assigned to it must be among. */
async function checkAssignee(
  db: Database,
  orgId: string,
  a: WorkActor | null | undefined,
  scope: TaskScope = WORKSPACE_SCOPE,
) {
  if (!a) return;
  if (a.type === "agent") {
    const agent = await getAgent(db, orgId, a.id);
    if (!agent || agent.archivedAt) throw new ValidationError("That agent does not exist in this organization");
  } else if (!(await getMembership(db, a.id, orgId))) {
    throw new ValidationError("That person is not a member of this organization");
  } else if (!(await personSees(db, a.id, orgId, scope))) {
    throw new ValidationError(
      "That person can't see this task. Add them to who sees it first",
      "issue.assignee_outside",
    );
  }
}

/**
 * What a task made from `channelId` is limited to: the people of a DM or a private channel (`tiedTo`); from a task's
 * own conversation (`scope`), whoever sees that task. Nothing where the whole workspace may see it: a public channel,
 * and a room no person reads (a routine's), whose task would otherwise be nobody's.
 */
async function conversationOf(db: Database, orgId: string, channelId: string) {
  const [row] = await db
    .select({
      kind: channels.kind,
      visibility: channels.visibility,
      taskChannelId: issues.channelId,
      restricted: issues.restricted,
      audienceUserIds: issues.audienceUserIds,
      people: sql<boolean>`exists (select 1 from ${channelMembers} cm
        where cm.channel_id = ${channels.id} and cm.user_id is not null)`,
    })
    .from(channels)
    .leftJoin(issues, eq(issues.conversationChannelId, channels.id))
    .where(and(eq(channels.id, channelId), eq(channels.orgId, orgId)));
  if (row?.kind === "task")
    return {
      tiedTo: row.taskChannelId,
      scope: {
        channelId: row.taskChannelId,
        restricted: row.restricted === true,
        audienceUserIds: row.audienceUserIds ?? [],
      },
    };
  const open = !row?.people || (row.kind === "channel" && row.visibility === "public");
  return { tiedTo: open ? null : channelId, scope: null };
}

/**
 * The columns for a chosen audience. "Only me" is a list of one. Who chooses stays in it unless they're an
 * administrator, who sees it anyway, and a person assigned to the task stays too: taking it from them is a surprise.
 */
async function chosenScope(
  db: Database,
  actor: IssueActor,
  orgId: string,
  audience: Audience,
  assigneeId: string | null,
): Promise<TaskScope> {
  if (audience.mode === "everyone") return WORKSPACE_SCOPE;
  const membership = actor.type === "person" ? await getMembership(db, actor.userId, orgId) : null;
  const self = actor.type === "person" && !(membership && can(membership, "administrator")) ? [actor.userId] : [];
  const wanted = [...new Set([...self, ...(assigneeId ? [assigneeId] : []), ...audience.userIds])].slice(
    0,
    AUDIENCE_MAX,
  );
  const members = wanted.length
    ? await db
        .select({ id: organizationMembers.userId })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.orgId, orgId), inArray(organizationMembers.userId, wanted)))
    : [];
  if (members.length === 0) throw new ValidationError("Choose who sees it", "issue.audience_empty");
  return { channelId: null, restricted: true, audienceUserIds: members.map((m) => m.id).sort() };
}

/**
 * Asked to implement an issue, an agent works on it in the requester's DM (`dmId`): from there it sees the
 * issue when that person can see its channel (`channelId`, an SQL expression).
 */
const seenFromDmSql = (orgId: string, dmId: string, channelId: SQL) => sql`exists (select 1
    from ${channelMembers} dm_m join ${channels} dm on dm.id = dm_m.channel_id and dm.kind = 'dm'
    where dm_m.channel_id = ${dmId}::uuid and dm_m.org_id = ${orgId}::uuid and dm_m.user_id is not null
      and exists (select 1 from ${channelMembers} cm2 where cm2.channel_id = ${channelId} and cm2.user_id = dm_m.user_id))`;

/** Whether a person is in a conversation, which for a public channel is everyone. */
async function inConversation(db: Database, userId: string, orgId: string, channelId: string) {
  const [row] = await db
    .select({ visibility: channels.visibility, kind: channels.kind, memberId: channelMembers.id })
    .from(channels)
    .leftJoin(channelMembers, and(eq(channelMembers.channelId, channels.id), eq(channelMembers.userId, userId)))
    .where(and(eq(channels.id, channelId), eq(channels.orgId, orgId)));
  return !!row && (row.memberId !== null || (row.visibility === "public" && row.kind === "channel"));
}

/** Whether a person sees a task (ADR 0151). Mirrors `taskSeenSql`. */
async function personSees(db: Database, userId: string, orgId: string, t: TaskScope) {
  if (t.restricted ? t.audienceUserIds.includes(userId) : !t.channelId) return true;
  const membership = await getMembership(db, userId, orgId);
  if (membership && can(membership, "administrator")) return true;
  return !t.restricted && !!t.channelId && inConversation(db, userId, orgId, t.channelId);
}

/** An agent's own reach, whoever it works for: what it may list in any conversation of its own. */
async function agentReaches(db: Database, actor: AgentActor, orgId: string, t: TaskRef) {
  if (!t.restricted && !t.channelId) return true;
  if (t.conversationChannelId && actor.channelId === t.conversationChannelId) return true;
  const assigned = t.assigneeType === "agent" && t.assigneeId === actor.agentId;
  if (t.restricted) {
    if (!assigned) return false;
    const [row] = rowsOf<{ yes: boolean | string }>(
      await db.execute(sql`select exists (select 1
        from ${channelMembers} dm_m join ${channels} dm on dm.id = dm_m.channel_id and dm.kind = 'dm'
        where dm_m.channel_id = ${actor.channelId}::uuid and dm_m.org_id = ${orgId}::uuid
          and dm_m.user_id = any(${`{${t.audienceUserIds.join(",")}}`}::text[])) as yes`),
    );
    return row?.yes === true || row?.yes === "t";
  }
  const channelId = t.channelId as string;
  if ((await agentSearchChannels(db, orgId, actor.agentId, actor.channelId)).includes(channelId)) return true;
  // In a task's conversation, an agent of the place it's tied to reads what's tied there (a step made here). One
  // assigned from outside reaches its own task only.
  const [sibling] = await db
    .select({ id: issues.id })
    .from(issues)
    .innerJoin(channelMembers, and(eq(channelMembers.channelId, channelId), eq(channelMembers.agentId, actor.agentId)))
    .where(and(eq(issues.conversationChannelId, actor.channelId), eq(issues.channelId, channelId)));
  if (sibling) return true;
  if (!assigned) return false;
  const [row] = rowsOf<{ yes: boolean | string }>(
    await db.execute(sql`select ${seenFromDmSql(orgId, actor.channelId, sql`${channelId}::uuid`)} as yes`),
  );
  return row?.yes === true || row?.yes === "t";
}

/** By id, an agent working for a person also reaches what that person reaches (ADR 0151). */
export async function canSee(db: Database, actor: IssueActor, orgId: string, t: TaskRef) {
  if (actor.type === "person") return personSees(db, actor.userId, orgId, t);
  if (await agentReaches(db, actor, orgId, t)) return true;
  const person = await runPerson(db, orgId, actor.runId);
  return person !== null && personSees(db, person, orgId, t);
}

/**
 * Of `ids`, the tasks an agent may list in its run's conversation for `person`: what it says reaches everyone there,
 * so everyone there must see them. Never in a public channel, read by the whole workspace.
 */
async function seenByConversation(db: Database, person: string | null, channelId: string, ids: string[]) {
  if (ids.length === 0) return new Set<string>();
  const rows = rowsOf<{ id: string }>(
    await db.execute(sql`select t.id from ${issues} t join ${channels} c on c.id = ${channelId}::uuid
      where t.id = any(${`{${ids.join(",")}}`}::uuid[]) and c.kind <> 'task'
        and not (c.kind = 'channel' and c.visibility = 'public')
        ${person ? sql`and ${taskSeenSql("t", sql`${person}::text`)}` : sql``}
        and not exists (select 1 from ${channelMembers} h where h.channel_id = c.id and h.user_id is not null
          and not ${taskSeenSql("t", sql`h.user_id`)})`),
  );
  return new Set(rows.map((r) => r.id));
}

/**
 * Whether what an agent says of a task may name it in a conversation: its own, or one where everyone sees it. A task
 * for the workspace goes anywhere.
 */
export async function nameableIn(db: Database, channelId: string, task: IssueView) {
  if (task.audience.mode === "everyone" || task.conversation?.channelId === channelId) return true;
  return (await seenByConversation(db, null, channelId, [task.id])).has(task.id);
}

async function requireOrgMember(db: Database, actor: IssueActor, orgId: string) {
  if (actor.type !== "person") return null;
  const membership = await requireActiveMembership(db, actor.userId, orgId);
  return membership;
}

const LIVE_RUN = new Set(["queued", "running", "waiting_approval", "waiting_input"]);
const OPEN_FOR_WORK = new Set<IssueStatus>(["todo", "in_progress", "in_review"]);
const STEPS_SHOWN = 8;

/** The assigned agents' work on these issues: their latest linked run and its last tool calls. */
async function workOf(db: Database, rows: IssueRow[]): Promise<Map<string, IssueWork>> {
  const out = new Map<string, IssueWork>();
  const withAgent = rows.filter((r) => r.assigneeType === "agent" && r.assigneeId && OPEN_FOR_WORK.has(r.status));
  if (withAgent.length === 0) return out;
  const latest = await db
    .selectDistinctOn([agentRuns.issueId], {
      id: agentRuns.id,
      issueId: agentRuns.issueId,
      agentId: agentRuns.agentId,
      status: agentRuns.status,
      error: agentRuns.error,
      createdAt: agentRuns.createdAt,
      startedAt: agentRuns.startedAt,
      finishedAt: agentRuns.finishedAt,
      updatedAt: agentRuns.updatedAt,
    })
    .from(agentRuns)
    .where(
      inArray(
        agentRuns.issueId,
        withAgent.map((r) => r.id),
      ),
    )
    .orderBy(agentRuns.issueId, desc(agentRuns.createdAt));
  const runOf = new Map(latest.map((r) => [r.issueId ?? "", r]));
  const runIds = latest.map((r) => r.id);
  const steps = runIds.length
    ? await db
        .select({
          runId: agentRunSteps.runId,
          kind: agentRunSteps.kind,
          data: agentRunSteps.data,
          createdAt: agentRunSteps.createdAt,
        })
        .from(agentRunSteps)
        .where(
          and(
            inArray(agentRunSteps.runId, runIds),
            or(
              eq(agentRunSteps.kind, "tool_call"),
              and(eq(agentRunSteps.kind, "tool_result"), sql`${agentRunSteps.data}->>'name' = ${PERMISSION_TOOL}`),
            ),
          ),
        )
        .orderBy(asc(agentRunSteps.seq))
    : [];
  // A permission check's answer, by its call: refused, or waiting on a person until the runner's asking again brings
  // the person's answer (by its request: Claude Code may ask twice while the card is open).
  const answers = new Map(
    steps.flatMap((st) =>
      st.kind === "tool_result" ? [[st.data.toolUseId, promptAnswer(String(st.data.content ?? ""))] as const] : [],
    ),
  );
  const waiting = new Map<string, IssueWork["steps"]>();
  const stepsOf = new Map<string, IssueWork["steps"]>();
  for (const st of steps) {
    const name = st.kind === "tool_call" && typeof st.data.name === "string" ? st.data.name : "";
    const input = st.data.input as Record<string, unknown> | undefined;
    if (!name) continue;
    const answer = name === PERMISSION_TOOL ? answers.get(st.data.toolUseId) : undefined;
    if (promptPoll(name, input)) {
      for (const asked of answer?.behavior ? (waiting.get(String(input?.request_id)) ?? []) : []) {
        if (answer?.behavior === "deny") asked.outcome = "refused";
        else delete asked.outcome;
      }
      continue;
    }
    const detail = toolDetail(name, input);
    const outcome = answer?.behavior === "deny" ? "refused" : answer?.status === "pending" ? "waiting" : null;
    const step: IssueWork["steps"][number] = {
      tool: name,
      ...(detail ? { detail } : {}),
      at: st.createdAt.toISOString(),
      ...(outcome ? { outcome } : {}),
    };
    if (outcome === "waiting" && answer?.request_id)
      waiting.set(answer.request_id, [...(waiting.get(answer.request_id) ?? []), step]);
    const list = stepsOf.get(st.runId) ?? [];
    list.push(step);
    stepsOf.set(st.runId, list);
  }
  for (const r of withAgent) {
    const run = runOf.get(r.id);
    // A run of another agent (the issue changed hands) is not this agent's work.
    const mine = run && run.agentId === r.assigneeId ? run : undefined;
    const runSteps = mine ? (stepsOf.get(mine.id) ?? []).slice(-STEPS_SHOWN) : [];
    if (mine && LIVE_RUN.has(mine.status)) {
      out.set(r.id, {
        agentId: r.assigneeId as string,
        runId: mine.id,
        state: mine.status === "waiting_approval" || mine.status === "waiting_input" ? mine.status : "running",
        since: (mine.startedAt ?? mine.createdAt).toISOString(),
        steps: runSteps,
      });
      continue;
    }
    // Committed but not running: in progress with the agent, nothing alive.
    if (r.status !== "in_progress") continue;
    const reason =
      mine?.status === "canceled"
        ? ("canceled" as const)
        : mine?.status === "failed"
          ? mine.error === "budget_exceeded"
            ? ("budget" as const)
            : ("failed" as const)
          : undefined;
    out.set(r.id, {
      agentId: r.assigneeId as string,
      runId: mine?.id ?? null,
      state: "stalled",
      since: (mine ? (mine.finishedAt ?? mine.updatedAt) : r.updatedAt).toISOString(),
      steps: runSteps,
      ...(reason ? { reason } : {}),
    });
  }
  return out;
}

/** `reader`: who reads them, for what only they may get (`backgroundWorksOf`). */
async function views(db: Database, rows: IssueRow[], reader?: string): Promise<IssueView[]> {
  const [work, works, conversations] = await Promise.all([
    workOf(db, rows),
    backgroundWorksOf(db, rows, reader),
    taskConversationSummaries(db, rows),
  ]);
  const ids = [...new Set(rows.flatMap((r) => r.artifactIds))];
  const files = ids.length
    ? await db
        .select({ id: artifacts.id, title: artifacts.title, type: artifacts.createdByType, by: artifacts.createdById })
        .from(artifacts)
        .where(and(inArray(artifacts.id, ids), isNull(artifacts.deletedAt)))
    : [];
  const byId = new Map(files.map((f) => [f.id, f]));
  const orgId = rows[0]?.orgId;
  const [columns, tied] = await Promise.all([orgId ? boardColumns(db, orgId) : [], tiedPeople(db, rows)]);
  return rows.map((r) => ({
    id: r.id,
    number: r.number,
    title: r.title,
    description: r.description,
    status: r.status,
    columnId: columnOf(columns, r)?.id ?? null,
    boardRank: r.boardRank,
    priority: r.priority,
    assignee: r.assigneeType && r.assigneeId ? { type: r.assigneeType as WorkActor["type"], id: r.assigneeId } : null,
    labels: r.labels,
    dueDate: r.dueDate,
    criteria: r.criteria,
    createdBy: { type: r.createdByType as WorkActor["type"], id: r.createdById },
    source: r.source as unknown as IssueSource,
    channelId: r.channelId,
    audience: taskAudienceOf(r, tied),
    parentIssueId: r.parentIssueId,
    pullRequests: r.pullRequests as unknown as IssueView["pullRequests"],
    githubUrl: r.githubUrl,
    artifacts: r.artifactIds.flatMap((id) => {
      const f = byId.get(id);
      return f ? [{ id: f.id, title: f.title, createdBy: { type: f.type as WorkActor["type"], id: f.by } }] : [];
    }),
    work: work.get(r.id) ?? null,
    blocked: r.blocked ?? null,
    backgroundWork: works.get(r.id) ?? null,
    conversation: conversations.get(r.id) ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

/** The people of the private conversations these tasks are tied to, by channel. */
export async function tiedPeople(db: Database, rows: IssueRow[]) {
  const ids = [...new Set(rows.flatMap((r) => (r.channelId ? [r.channelId] : [])))];
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  const found = await db
    .select({ id: channels.id, userId: channelMembers.userId })
    .from(channels)
    .leftJoin(channelMembers, eq(channelMembers.channelId, channels.id))
    .where(
      and(inArray(channels.id, ids), sql`not (${channels.kind} = 'channel' and ${channels.visibility} = 'public')`),
    );
  for (const f of found) {
    const people = out.get(f.id) ?? [];
    if (f.userId) people.push(f.userId);
    out.set(f.id, people);
  }
  return out;
}

export function taskAudienceOf(r: IssueRow, tied: Map<string, string[]>): IssueAudience {
  if (r.restricted) return { mode: "people", userIds: r.audienceUserIds, channelId: null };
  const people = r.channelId ? tied.get(r.channelId) : undefined;
  return people
    ? { mode: "people", userIds: people, channelId: r.channelId }
    : { mode: "everyone", userIds: [], channelId: null };
}

/** The newest background work each card tracks (ADR 0121 §4). */
async function backgroundWorksOf(db: Database, rows: IssueRow[], reader?: string): Promise<Map<string, WorkView>> {
  const ids = rows.map((r) => r.id);
  const out = new Map<string, WorkView>();
  if (ids.length === 0) return out;
  const w = schema.agentWorks;
  const latest = await db
    .selectDistinctOn([w.issueId], { id: w.id, issueId: w.issueId, orgId: w.orgId })
    .from(w)
    .where(inArray(w.issueId, ids))
    .orderBy(w.issueId, desc(w.createdAt));
  const orgId = rows[0]?.orgId;
  if (!orgId || latest.length === 0) return out;
  const views = await workViews(
    db,
    orgId,
    latest.map((l) => l.id),
  );
  const channelOf = new Map(rows.map((r) => [r.id, r.channelId]));
  const closed = await dmsClosedTo(
    db,
    reader,
    [...views.values()].map((v) => v.channelId),
  );
  for (const l of latest) {
    const v = views.get(l.id);
    if (!v || !l.issueId) continue;
    // A card shown to everyone reaches past its work's conversation: what the work asks in there stays in there. So
    // does a DM's for an administrator, who sees the task and never the DM.
    const asks = channelOf.get(l.issueId) === v.channelId && !closed.has(v.channelId);
    out.set(l.issueId, asks ? v : { ...v, question: null });
  }
  return out;
}

/** Of `channelIds`, the DMs `reader` isn't in; with no reader, every DM. */
async function dmsClosedTo(db: Database, reader: string | undefined, channelIds: string[]) {
  if (channelIds.length === 0) return new Set<string>();
  const found = await db
    .select({ id: channels.id })
    .from(channels)
    .leftJoin(channelMembers, and(eq(channelMembers.channelId, channels.id), eq(channelMembers.userId, reader ?? "")))
    .where(and(inArray(channels.id, channelIds), eq(channels.kind, "dm"), isNull(channelMembers.id)));
  return new Set(found.map((c) => c.id));
}

async function one(db: Database, row: IssueRow, reader?: string) {
  const [v] = await views(db, [row], reader);
  if (!v) throw new Error("issue view missing");
  return v;
}

async function addActivity(
  tx: Executor,
  issue: Pick<IssueRow, "id" | "orgId">,
  entry: { kind: "comment" | "event"; author: WorkActor; text: string; event?: string; data?: Record<string, unknown> },
) {
  const [row] = await tx
    .insert(issueActivity)
    .values({
      orgId: issue.orgId,
      issueId: issue.id,
      kind: entry.kind,
      authorType: entry.author.type,
      authorId: entry.author.id,
      text: entry.text,
      event: entry.event ?? null,
      data: entry.data ?? {},
    })
    .returning();
  if (!row) throw new Error("activity insert returned nothing");
  return row;
}

const activityView = (a: typeof issueActivity.$inferSelect): IssueActivityView => ({
  id: a.id,
  kind: a.kind as IssueActivityView["kind"],
  author: { type: a.authorType as WorkActor["type"], id: a.authorId },
  text: a.text,
  ...(a.event ? { event: a.event } : {}),
  ...(a.kind === "event" ? eventDetail(a.event, a.data as Record<string, unknown>) : {}),
  ...((a.data as Record<string, unknown>).auto === true ? { auto: true } : {}),
  ...(Array.isArray((a.data as Record<string, unknown>).attachments)
    ? { attachments: (a.data as { attachments: { id: string; title: string }[] }).attachments }
    : {}),
  createdAt: a.createdAt.toISOString(),
});

/** The code and params of an activity event, from its `event` and `data` (older rows lacking a param keep `text`). */
function eventDetail(event: string | null, data: Record<string, unknown>) {
  const s = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : null);
  const out = (textCode: string, textParams: Record<string, string> = {}) => ({ textCode, textParams });
  const titles = (list: unknown) =>
    (Array.isArray(list) ? (list as { title?: unknown }[]) : [])
      .flatMap((f) => (typeof f?.title === "string" ? [f.title] : []))
      .join(", ");
  switch (event) {
    case "created":
    case "renamed":
    case "description_changed":
    case "criteria_changed":
      return out(event);
    // By name; an older row says "attached a file".
    case "artifact_linked":
      return titles(data.attachments) ? out("files_attached", { names: titles(data.attachments) }) : out(event);
    case "artifact_unlinked":
      return titles(data.files) ? out("files_removed", { names: titles(data.files) }) : {};
    case "status_changed":
      return s(data.to) ? out(event, { status: s(data.to) as string }) : {};
    case "priority_changed":
      return s(data.to) ? out(event, { priority: s(data.to) as string }) : {};
    case "assigned":
      return "assignee" in data ? out(data.assignee ? "assigned" : "unassigned") : {};
    case "due_date":
      if (!("dueDate" in data)) return {};
      return s(data.dueDate) ? out("due_date_set", { date: s(data.dueDate) as string }) : out("due_date_removed");
    case "pr_linked":
      return s(data.number) ? out(event, { number: s(data.number) as string }) : {};
    case "github_link":
      return out(s(data.url) ? "github_linked" : "github_unlinked");
    case "criterion_checked":
      return s(data.text)
        ? out(data.done ? "criterion_checked" : "criterion_unchecked", { text: s(data.text) as string })
        : {};
    case "agent_asked":
      // `threadId`: the requester's DM thread where the work lives (only they can open it).
      return s(data.agentName)
        ? out(event, {
            name: s(data.agentName) as string,
            ...(s(data.threadId) ? { threadId: s(data.threadId) as string } : {}),
          })
        : {};
    case "work_update":
      return s(data.text) ? out(event, { text: s(data.text) as string }) : {};
    case "work_stopped":
      return out(event, s(data.byUserId) ? { byUserId: s(data.byUserId) as string } : {});
    case "shared_everyone":
      return out(event, {});
    case "audience_changed":
      return out(data.mode === "everyone" ? "audience_everyone" : "audience_people");
    default:
      return {};
  }
}

export interface IssueDeps {
  db: Database;
  pubsub?: PubSub;
}

/** Tells whoever can see the task: the whole org, or its conversation, the people it names and administrators. */
export async function publishToTaskReaders(
  deps: IssueDeps,
  orgId: string,
  task: { channelId: string | null; audience: Pick<IssueAudience, "mode" | "userIds"> },
  event:
    | { type: "issue.created" | "issue.updated"; issue: IssueView }
    | { type: "issue.deleted"; issueId: string; number: number },
) {
  if (task.audience.mode === "everyone") {
    await publishOrgEvent(deps.pubsub, { type: "org.broadcast", orgId, event });
    return;
  }
  if (!deps.pubsub) return;
  if (task.channelId) await publishChannelEvent(deps.pubsub, { ...event, channelId: task.channelId });
  const admins = rowsOf<{ user_id: string }>(
    await deps.db.execute(membersWhoMaySql(sql`${orgId}::uuid`, "administrator")),
  ).map((r) => r.user_id);
  // The board hears no conversation: a task tied to a DM or a private channel reaches its people on their own topics.
  const named = task.audience.userIds;
  for (const userId of new Set([...admins, ...named])) await publishUserEvent(deps.pubsub, orgId, userId, event);
}

const announce = (deps: IssueDeps, orgId: string, issue: IssueView, type: "issue.created" | "issue.updated") =>
  publishToTaskReaders(deps, orgId, issue, { type, issue });

/** Creates an issue with the next number of the org. */
export async function createIssue(
  deps: IssueDeps,
  actor: IssueActor,
  orgId: string,
  input: IssueInput & {
    source?: IssueSource;
    channelId?: string | null;
    parentIssueId?: string | null;
    /** Drive files uploaded from the new-issue box: linked to the issue and kept on its "created" event. */
    attachmentIds?: string[];
    /**
     * Files the caller checked and placed where whoever sees the task reads them: an agent's, brought by its tool
     * (`bringFiles` in `issue-tools.ts`), or the message's own turned into the task. Linked and kept on its "created"
     * event like a box's, but never moved: one in the shared Drive stays everyone's.
     */
    linkFileIds?: string[];
    /** Who sees it (ADR 0151); left out, where it's made decides. A step always follows its parent. */
    audience?: Audience;
  },
): Promise<IssueView> {
  const { db } = deps;
  const membership = await requireOrgMember(db, actor, orgId);
  if (membership && !can(membership, "post")) throw new ForbiddenError();
  const title = input.title.trim().slice(0, 300);
  if (!title) throw new ValidationError("title is required");
  const uploaded = await ownFiles(db, actor, orgId, input.attachmentIds);
  const files = await withLinked(db, orgId, uploaded, input.linkFileIds);
  if (input.priority && !PRIORITIES.includes(input.priority)) throw new ValidationError("invalid priority");
  const criteria = (input.criteria ?? [])
    .map((text) => text.trim().slice(0, 500))
    .filter(Boolean)
    .slice(0, 50)
    .map((text) => ({ id: Bun.randomUUIDv7(), text, done: false }));
  const [parent] = input.parentIssueId
    ? await db
        .select({ channelId: issues.channelId, restricted: issues.restricted, audienceUserIds: issues.audienceUserIds })
        .from(issues)
        .where(and(eq(issues.id, input.parentIssueId), eq(issues.orgId, orgId)))
    : [];
  if (input.parentIssueId && (!parent || !(await canSee(db, actor, orgId, parent)))) {
    throw new ValidationError("The parent issue does not exist");
  }
  // A task never reaches further than where it was made, unless someone chose: an agent's, its run's conversation. A
  // step, its parent's.
  const madeIn = input.channelId ?? (actor.type === "agent" ? actor.channelId : null);
  const made = madeIn ? await conversationOf(db, orgId, madeIn) : null;
  const assigned = input.assignee?.type === "person" ? input.assignee.id : null;
  const scope: TaskScope = parent?.restricted
    ? parent
    : parent?.channelId
      ? { ...WORKSPACE_SCOPE, channelId: parent.channelId }
      : input.audience
        ? await chosenScope(db, actor, orgId, input.audience, assigned)
        : (made?.scope ?? { ...WORKSPACE_SCOPE, channelId: made?.tiedTo ?? input.channelId ?? null });
  await checkAssignee(db, orgId, input.assignee, scope);
  const author = actorOf(actor);
  const source: IssueSource =
    input.source ?? (actor.type === "agent" ? { type: "agent", agentId: actor.agentId } : { type: "manual" });
  const row = await db.transaction(async (tx) => {
    const [counter] = await tx
      .insert(issueCounters)
      .values({ orgId, last: 1 })
      .onConflictDoUpdate({ target: issueCounters.orgId, set: { last: sql`${issueCounters.last} + 1` } })
      .returning();
    const [issue] = await tx
      .insert(issues)
      .values({
        orgId,
        number: counter?.last ?? 1,
        title,
        description: (input.description ?? "").slice(0, 50_000),
        priority: input.priority ?? "normal",
        boardRank: topRank(),
        assigneeType: input.assignee?.type ?? null,
        assigneeId: input.assignee?.id ?? null,
        labels: cleanLabels(input.labels) ?? [],
        dueDate: checkDate(input.dueDate) ?? null,
        githubUrl: checkGithubUrl(input.githubUrl),
        criteria,
        source: source as unknown as Record<string, unknown>,
        channelId: scope.channelId,
        restricted: scope.restricted,
        audienceUserIds: scope.audienceUserIds,
        parentIssueId: input.parentIssueId ?? null,
        ...(files.length ? { artifactIds: files.map((f) => f.id) } : {}),
        createdByType: author.type,
        createdById: author.id,
      })
      .returning();
    if (!issue) throw new Error("issue insert returned nothing");
    await addActivity(tx, issue, {
      kind: "event",
      author,
      text: "created the issue",
      event: "created",
      ...(files.length ? { data: { attachments: files } } : {}),
    });
    await enqueueIndex(tx, { orgId, kind: "issue", sourceId: issue.id });
    if (issue.description.includes("[[")) {
      await syncWikiLinks(tx, orgId, { type: "issue", id: issue.id, channelId: issue.channelId }, issue.description);
    }
    return issue;
  });
  await keepFilesWithTask(
    deps,
    actor,
    row,
    uploaded.map((f) => f.id),
  );
  const view = await one(db, (await reload(db, row)) ?? row);
  await announce(deps, orgId, view, "issue.created");
  if (row.assigneeType === "person") await notifyIssueChanged(deps, author, null, row).catch(() => {});
  // Routines on `issue.created` (ADR 0053 §6.5): never for an issue a routine or an unattended run created
  // (a routine would trigger itself), only for routines whose creator can see the issue, and with its id,
  // not its title (the run reads it with its own tools).
  const origin =
    actor.type === "person"
      ? "person"
      : actor.runId
        ? (await runAuthorityById(db, orgId, actor.runId).catch(() => null))?.kind
        : "unattended";
  if (origin === "person") {
    await fireRoutineEvent(
      deps,
      orgId,
      "issue.created",
      { summary: `New issue #${view.number} (id ${view.id})`, issueId: view.id, number: view.number, origin },
      {
        dedupeKey: `issue:${view.id}`,
        visibleTo: (userId) => personSees(db, userId, orgId, row),
      },
    ).catch(() => 0);
  }
  return view;
}

export async function findVisible(
  db: Database,
  actor: IssueActor,
  orgId: string,
  where: { id?: string; number?: number },
) {
  await requireOrgMember(db, actor, orgId);
  const [row] = await db
    .select()
    .from(issues)
    .where(
      and(
        eq(issues.orgId, orgId),
        where.id ? eq(issues.id, where.id) : undefined,
        where.number !== undefined ? eq(issues.number, where.number) : undefined,
      ),
    );
  if (!row || !(await canSee(db, actor, orgId, row))) throw new NotFoundError("Issue not found");
  return row;
}

const readerOf = (actor: IssueActor) => (actor.type === "person" ? actor.userId : undefined);

export async function getIssue(db: Database, actor: IssueActor, orgId: string, ref: { id?: string; number?: number }) {
  return one(db, await findVisible(db, actor, orgId, ref), readerOf(actor));
}

/** An issue with its sub-issues (the ones the actor can see). */
export async function getIssueDetail(
  db: Database,
  actor: IssueActor,
  orgId: string,
  ref: { id?: string; number?: number },
): Promise<IssueDetailView> {
  const row = await findVisible(db, actor, orgId, ref);
  const [view, children] = await Promise.all([
    one(db, row, readerOf(actor)),
    db
      .select()
      .from(issues)
      .where(and(eq(issues.orgId, orgId), eq(issues.parentIssueId, row.id)))
      .orderBy(asc(issues.number)),
  ]);
  const subIssues: IssueDetailView["subIssues"] = [];
  for (const c of children) {
    if (!(await canSee(db, actor, orgId, c))) continue;
    subIssues.push({
      id: c.id,
      number: c.number,
      title: c.title,
      status: c.status,
      assignee: c.assigneeType && c.assigneeId ? { type: c.assigneeType as WorkActor["type"], id: c.assigneeId } : null,
    });
  }
  return { ...view, subIssues };
}

/** Issues the actor can see, open first then by most recent update. */
export async function listIssues(
  db: Database,
  actor: IssueActor,
  orgId: string,
  filters: { q?: string; status?: IssueStatus; assignee?: WorkActor; parentIssueId?: string; limit?: number } = {},
): Promise<IssueView[]> {
  await requireOrgMember(db, actor, orgId);
  const q = filters.q?.trim();
  const rows = await db
    .select()
    .from(issues)
    .where(
      and(
        eq(issues.orgId, orgId),
        actor.type === "person" ? taskSeenSql("issues", sql`${actor.userId}::text`) : undefined,
        filters.status ? eq(issues.status, filters.status) : undefined,
        filters.parentIssueId ? eq(issues.parentIssueId, filters.parentIssueId) : undefined,
        filters.assignee
          ? and(eq(issues.assigneeType, filters.assignee.type), eq(issues.assigneeId, filters.assignee.id))
          : undefined,
        q
          ? or(
              sql`${issues.title} ilike ${`%${q}%`}`,
              sql`${issues.description} ilike ${`%${q}%`}`,
              /^#?\d+$/.test(q) ? eq(issues.number, Number(q.replace("#", ""))) : undefined,
            )
          : undefined,
      ),
    )
    .orderBy(sql`${issues.status} in ('done', 'canceled')`, desc(issues.updatedAt))
    .limit(Math.min(500, filters.limit ?? 200));
  if (actor.type === "person") return views(db, rows, actor.userId);
  const person = await runPerson(db, orgId, actor.runId);
  const shared = person
    ? await seenByConversation(
        db,
        person,
        actor.channelId,
        rows.map((r) => r.id),
      )
    : new Set<string>();
  const visible: IssueRow[] = [];
  for (const r of rows) if (shared.has(r.id) || (await agentReaches(db, actor, orgId, r))) visible.push(r);
  return views(db, visible);
}

/** Mirrors `GITHUB_LINK`, packages/client/src/lib/github-link.ts. */
const GITHUB_LINK = /^https:\/\/(?:www\.)?github\.com\/[^/\s]+\/[^/\s]+\/(?:issues|pull)\/\d+(?:[/?#]\S*)?$/;

/** A task's GitHub link as stored: people open it from the task, so nothing but that address goes in. */
function checkGithubUrl(value: string | null | undefined) {
  const url = value?.trim();
  if (!url) return null;
  if (url.length > 500 || !GITHUB_LINK.test(url))
    throw new ValidationError("That isn't the link of a GitHub issue or pull request");
  return url;
}

const isHttpsUrl = (value: string) => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

/** Changes fields; each change is an event in the activity ("changed the status to In review"). */
export async function updateIssue(
  deps: IssueDeps,
  actor: IssueActor,
  orgId: string,
  issueId: string,
  patch: IssuePatch & {
    addPullRequest?: { number: number; url: string };
    /** Files to link, checked by the caller like `createIssue`'s `linkFileIds` (an agent's; Refazer). */
    addFiles?: string[];
    /** Files to unlink: Desfazer on an agent's attach. */
    removeFiles?: string[];
  },
): Promise<IssueView> {
  const { db } = deps;
  const current = await findVisible(db, actor, orgId, { id: issueId });
  if (patch.status && !STATUSES.includes(patch.status)) throw new ValidationError("invalid status");
  if (patch.priority && !PRIORITIES.includes(patch.priority)) throw new ValidationError("invalid priority");
  if (patch.assignee !== undefined) await checkAssignee(db, orgId, patch.assignee, current);
  const author = actorOf(actor);
  const set: Partial<typeof issues.$inferInsert> = { updatedAt: new Date() };
  const events: { text: string; event: string; data?: Record<string, unknown> }[] = [];
  if (patch.title?.trim() && patch.title.trim() !== current.title) {
    set.title = patch.title.trim().slice(0, 300);
    events.push({ text: "renamed the issue", event: "renamed" });
  }
  if (patch.description !== undefined && patch.description !== current.description) {
    set.description = patch.description.slice(0, 50_000);
    events.push({ text: "edited the description", event: "description_changed" });
  }
  // A board column carries its stage; a bare status lands on top of the stage's first column.
  const column = patch.columnId ? await columnForMove(db, orgId, patch.columnId) : null;
  const status = column?.stage ?? patch.status;
  if (column) set.columnId = column.id;
  if (status && status !== current.status) {
    set.status = status;
    if (!column) set.columnId = null;
    events.push({
      text: `changed the status to ${STATUS_WORDS[status]}`,
      event: "status_changed",
      data: { from: current.status, to: status },
    });
  }
  if (patch.boardRank !== undefined && Number.isFinite(patch.boardRank)) set.boardRank = patch.boardRank;
  else if (set.columnId !== undefined) set.boardRank = topRank();
  if (patch.priority && patch.priority !== current.priority) {
    set.priority = patch.priority;
    events.push({ text: "changed the priority", event: "priority_changed", data: { to: patch.priority } });
  }
  if (patch.assignee !== undefined) {
    set.assigneeType = patch.assignee?.type ?? null;
    set.assigneeId = patch.assignee?.id ?? null;
    events.push({
      text: patch.assignee ? "assigned the issue" : "removed the assignee",
      event: "assigned",
      data: { assignee: patch.assignee },
    });
  }
  if (patch.dueDate !== undefined) {
    set.dueDate = checkDate(patch.dueDate) ?? null;
    events.push({
      text: patch.dueDate ? `set the due date to ${patch.dueDate}` : "removed the due date",
      event: "due_date",
      data: { dueDate: patch.dueDate || null },
    });
  }
  if (patch.labels !== undefined) set.labels = cleanLabels(patch.labels) ?? [];
  if (patch.githubUrl !== undefined) {
    const url = checkGithubUrl(patch.githubUrl);
    if (url !== current.githubUrl) {
      set.githubUrl = url;
      events.push({
        text: url ? "linked it to GitHub" : "removed the GitHub link",
        event: "github_link",
        data: { url },
      });
    }
  }
  if (patch.criteria !== undefined) {
    const criteria = editedCriteria(current.criteria, patch.criteria);
    const same =
      criteria.length === current.criteria.length &&
      criteria.every((c, k) => c.id === current.criteria[k]?.id && c.text === current.criteria[k]?.text);
    if (!same) {
      set.criteria = criteria;
      events.push({ text: "edited the acceptance criteria", event: "criteria_changed" });
    }
  }
  if (patch.addPullRequest) {
    // People open this link from the issue page: only an https address, never javascript:, data: or the like.
    if (!isHttpsUrl(patch.addPullRequest.url))
      throw new ValidationError("The pull request URL must be an https:// address");
    const prs = (current.pullRequests as unknown as IssueView["pullRequests"]).filter(
      (p) => p.url !== patch.addPullRequest?.url,
    );
    const pr = { number: patch.addPullRequest.number, url: patch.addPullRequest.url, openedBy: author };
    set.pullRequests = [...prs, pr] as unknown as Record<string, unknown>[];
    events.push({ text: `linked PR #${pr.number}`, event: "pr_linked", data: { url: pr.url, number: pr.number } });
  }
  // A linked PR moves open work to review on its own (unless the status is being set now).
  if (
    patch.addPullRequest &&
    !patch.status &&
    !patch.columnId &&
    (current.status === "todo" || current.status === "in_progress")
  ) {
    set.status = "in_review";
    set.columnId = null;
    set.boardRank = topRank();
    events.push({
      text: `changed the status to ${STATUS_WORDS.in_review} (automatic: a PR was linked)`,
      event: "status_changed",
      data: { from: current.status, to: "in_review", auto: true },
    });
  }
  const added = await liveFiles(
    db,
    orgId,
    [...new Set(patch.addFiles ?? [])].filter((id) => !current.artifactIds.includes(id)),
  );
  const removed = (patch.removeFiles ?? []).filter((id) => current.artifactIds.includes(id));
  if (added.length || removed.length) {
    set.artifactIds = [...current.artifactIds.filter((id) => !removed.includes(id)), ...added.map((f) => f.id)];
    // Kept apart from `attachments`, which the task's Anexos list.
    const files = removed.length ? await liveFiles(db, orgId, removed) : [];
    if (added.length)
      events.push({
        text: added.length === 1 ? "attached a file" : `attached ${added.length} files`,
        event: "artifact_linked",
        data: { attachments: added },
      });
    if (removed.length)
      events.push({
        text: removed.length === 1 ? "removed a file" : `removed ${removed.length} files`,
        event: "artifact_unlinked",
        data: { artifactIds: removed, files },
      });
  }
  const row = await db.transaction(async (tx) => {
    const [updated] = await tx.update(issues).set(set).where(eq(issues.id, current.id)).returning();
    if (!updated) throw new NotFoundError("Issue not found");
    for (const e of events) await addActivity(tx, updated, { kind: "event", author, ...e });
    await enqueueIndex(tx, { orgId, kind: "issue", sourceId: updated.id });
    if (set.description !== undefined && (set.description.includes("[[") || current.description.includes("[["))) {
      await syncWikiLinks(tx, orgId, { type: "issue", id: updated.id, channelId: updated.channelId }, set.description);
    }
    return updated;
  });
  await linkRun(deps, actor, row);
  // A new agent assignee joins the task's conversation (ADR 0145): a mention there reaches it.
  if (patch.assignee?.type === "agent" && row.conversationChannelId) {
    await admitTaskAgents(db, orgId, row.conversationChannelId, { ids: [patch.assignee.id] });
  }
  const view = await one(db, (await reload(db, row)) ?? row);
  await announce(deps, orgId, view, "issue.updated");
  // The inbox: a new assignee, a status change for whoever follows it.
  if (patch.assignee !== undefined || row.status !== current.status) {
    await notifyIssueChanged(deps, author, current, row).catch(() => {});
  }
  return view;
}

const reload = async (db: Database, row: IssueRow) => (await db.select().from(issues).where(eq(issues.id, row.id)))[0];

/**
 * The criteria a person edited in place: a kept one keeps its id and its check (and who checked it), a new one
 * starts unchecked; the same limits as at creation (500 characters each, 50 in all, empty lines dropped).
 */
function editedCriteria(current: IssueRow["criteria"], next: { id?: string; text: string }[]): IssueRow["criteria"] {
  const byId = new Map(current.map((c) => [c.id, c]));
  const seen = new Set<string>();
  return next
    .map((c) => ({ id: c.id, text: c.text.trim().slice(0, 500) }))
    .filter((c) => c.text)
    .slice(0, 50)
    .map((c) => {
      const kept = c.id && !seen.has(c.id) ? byId.get(c.id) : undefined;
      if (kept) {
        seen.add(kept.id);
        return { ...kept, text: c.text };
      }
      return { id: Bun.randomUUIDv7(), text: c.text, done: false };
    });
}

/**
 * An agent's run touched this issue (an issue tool, or "implement" asked):
 * the run is linked to it, and an issue the agent has that is still "to do"
 * moves to "in progress" on its own.
 */
async function linkRun(deps: IssueDeps, actor: IssueActor, issue: IssueRow) {
  if (actor.type !== "agent" || !actor.runId) return;
  await startedWork(deps, issue, actor.agentId, [actor.runId]);
}

async function startedWork(deps: IssueDeps, issue: IssueRow, agentId: string, runIds: string[]) {
  if (runIds.length === 0) return;
  await deps.db
    .update(agentRuns)
    .set({ issueId: issue.id })
    .where(and(inArray(agentRuns.id, runIds), isNull(agentRuns.issueId), eq(agentRuns.orgId, issue.orgId)));
  const [current] = await deps.db.select().from(issues).where(eq(issues.id, issue.id));
  const isMineToStart =
    current?.status === "todo" && current.assigneeType === "agent" && current.assigneeId === agentId;
  if (!current || !isMineToStart) return;
  await deps.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(issues)
      .set({ status: "in_progress", columnId: null, boardRank: topRank(), updatedAt: new Date() })
      .where(and(eq(issues.id, current.id), eq(issues.status, "todo")))
      .returning();
    if (!updated) return;
    await addActivity(tx, updated, {
      kind: "event",
      author: { type: "agent", id: agentId },
      text: `changed the status to ${STATUS_WORDS.in_progress} (automatic: the agent started)`,
      event: "status_changed",
      data: { from: "todo", to: "in_progress", auto: true },
    });
  });
}

/** Checks or unchecks one acceptance criterion. */
export async function setCriterion(
  deps: IssueDeps,
  actor: IssueActor,
  orgId: string,
  issueId: string,
  criterionId: string,
  done: boolean,
): Promise<IssueView> {
  const current = await findVisible(deps.db, actor, orgId, { id: issueId });
  const criterion = current.criteria.find((c) => c.id === criterionId);
  if (!criterion) throw new NotFoundError("Criterion not found");
  const criteria = current.criteria.map((c) =>
    c.id === criterionId ? { ...c, done, doneBy: done ? actorOf(actor) : null } : c,
  );
  const row = await deps.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(issues)
      .set({ criteria, updatedAt: new Date() })
      .where(eq(issues.id, current.id))
      .returning();
    if (!updated) throw new NotFoundError("Issue not found");
    await addActivity(tx, updated, {
      kind: "event",
      author: actorOf(actor),
      text: `${done ? "checked" : "unchecked"} the criterion "${cutText(criterion.text, 80)}"`,
      event: "criterion_checked",
      data: { criterionId, done, text: cutText(criterion.text, 80) },
    });
    return updated;
  });
  await linkRun(deps, actor, row);
  const view = await one(deps.db, (await reload(deps.db, row)) ?? row);
  await announce(deps, orgId, view, "issue.updated");
  return view;
}

export async function listIssueActivity(db: Database, actor: IssueActor, orgId: string, issueId: string) {
  const issue = await findVisible(db, actor, orgId, { id: issueId });
  const rows = await db
    .select()
    .from(issueActivity)
    .where(eq(issueActivity.issueId, issue.id))
    .orderBy(issueActivity.createdAt, issueActivity.id);
  return rows.map(activityView);
}

/**
 * Files attached from a box (new issue, comment): at most 10, in the org, not in the trash and uploaded by
 * this author, so an id alone can't pull someone else's file into an issue.
 */
async function ownFiles(db: Database, actor: IssueActor, orgId: string, attachmentIds: string[] | undefined) {
  const ids = [...new Set(attachmentIds ?? [])].slice(0, 10);
  const files = await liveFiles(db, orgId, ids, actorOf(actor));
  if (files.length !== ids.length) throw new ValidationError("An attached file does not exist");
  return files;
}

/** `files` and, after them, the live ones of `linkFileIds` (checked by the caller), each once. */
async function withLinked(db: Executor, orgId: string, files: { id: string; title: string }[], linkFileIds?: string[]) {
  const ids = [...new Set(linkFileIds ?? [])].filter((id) => !files.some((f) => f.id === id));
  return [...files, ...(await liveFiles(db, orgId, ids))];
}

/** These files of the org not in the trash, in the order given; `by`: only the ones it uploaded. */
async function liveFiles(db: Executor, orgId: string, ids: string[], by: WorkActor | null = null) {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: artifacts.id, title: artifacts.title })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.orgId, orgId),
        inArray(artifacts.id, ids),
        isNull(artifacts.deletedAt),
        ...(by ? [eq(artifacts.createdByType, by.type), eq(artifacts.createdById, by.id)] : []),
      ),
    );
  return ids.flatMap((id) => rows.filter((f) => f.id === id));
}

/**
 * A limited task's files stay with it: a file its author brings that isn't in any conversation would be the whole
 * workspace's in the Drive, so it moves to the task's conversation, read by who sees the task (ADR 0151).
 */
async function keepFilesWithTask(
  deps: IssueDeps,
  actor: IssueActor,
  task: Pick<IssueRow, "id" | "orgId" | "restricted">,
  fileIds: string[],
) {
  if (!task.restricted || fileIds.length === 0) return;
  const { db } = deps;
  const { channelId } = await ensureTaskConversation(db, task.id);
  const by = actorOf(actor);
  const moved = await db
    .update(artifacts)
    .set({ channelId })
    .where(
      and(
        eq(artifacts.orgId, task.orgId),
        inArray(artifacts.id, fileIds),
        isNull(artifacts.channelId),
        eq(artifacts.createdByType, by.type),
        eq(artifacts.createdById, by.id),
      ),
    )
    .returning({ id: artifacts.id });
  for (const f of moved) await enqueueIndex(db, { orgId: task.orgId, kind: "file", sourceId: f.id });
  if (moved.length > 0) await publishListChanged(deps.pubsub, task.orgId, "artifacts");
}

/**
 * A comment: a reply in the task's conversation (ADR 0145), on the chat's own path. A person's goes like any
 * message there (a mention wakes the agent, receipts, the working line); an agent's (`comment_issue`, a reply
 * mirrored from elsewhere) is its own message there. Drive files uploaded for it show on it and are linked to
 * the issue. Notifications come from the message (`notifications.message`).
 */
export async function commentIssue(
  deps: IssueDeps,
  actor: IssueActor,
  orgId: string,
  issueId: string,
  text: string,
  /** `linkFileIds`: as `createIssue`'s. */
  options: { attachmentIds?: string[]; linkFileIds?: string[] } = {},
): Promise<IssueActivityView> {
  const body = text.trim().slice(0, 20_000);
  if (!body && (options.attachmentIds ?? []).length + (options.linkFileIds ?? []).length === 0)
    throw new ValidationError("Comment is empty");
  const issue = await findVisible(deps.db, actor, orgId, { id: issueId });
  const uploaded = await ownFiles(deps.db, actor, orgId, options.attachmentIds);
  const files = await withLinked(deps.db, orgId, uploaded, options.linkFileIds);
  const conversation = await ensureTaskConversation(deps.db, issue.id);
  const message = await postInConversation(
    deps,
    actor,
    orgId,
    conversation,
    body,
    files.map((f) => f.id),
  );
  await keepFilesWithTask(
    deps,
    actor,
    issue,
    uploaded.map((f) => f.id),
  );
  const linked = [...issue.artifactIds, ...files.map((f) => f.id).filter((id) => !issue.artifactIds.includes(id))];
  await deps.db
    .update(issues)
    .set({ updatedAt: new Date(), ...(files.length ? { artifactIds: linked } : {}) })
    .where(eq(issues.id, issue.id));
  await linkRun(deps, actor, issue);
  return {
    id: message.id,
    kind: "comment",
    author: actorOf(actor),
    text: message.body,
    ...(files.length ? { attachments: files } : {}),
    createdAt: message.createdAt,
  };
}

/** A reply in the task's conversation by a person (the chat's send) or an agent (its own message). */
async function postInConversation(
  deps: IssueDeps,
  actor: IssueActor | { type: "agent"; agentId: string; runId?: string },
  orgId: string,
  at: TaskConversationRef,
  body: string,
  fileIds: string[] = [],
): Promise<MessageView> {
  if (!deps.pubsub) throw new Error("posting in a task's conversation needs pub/sub");
  if (actor.type === "person") {
    return postPersonMessage({ db: deps.db, pubsub: deps.pubsub }, actor.userId, orgId, at.channelId, {
      body,
      threadId: at.rootId,
      ...(fileIds.length ? { attachments: fileIds } : {}),
    });
  }
  const refs = fileIds.length
    ? await deps.db
        .select({ id: artifacts.id, version: artifacts.currentVersion, title: artifacts.title })
        .from(artifacts)
        .where(and(eq(artifacts.orgId, orgId), inArray(artifacts.id, fileIds)))
    : [];
  // It saw the task (the caller's check): later mentions of it there reach it.
  await admitTaskAgents(deps.db, orgId, at.channelId, { ids: [actor.agentId] });
  const message = await insertMessage(deps.db, {
    orgId,
    channelId: at.channelId,
    threadId: at.rootId,
    author: actor.runId
      ? { type: "agent", agentId: actor.agentId, runId: actor.runId, hop: 1 }
      : { type: "agent", agentId: actor.agentId, runId: null, hop: 1, stretchId: null },
    body,
    ...(refs.length ? { meta: { artifacts: fileIds.flatMap((id) => refs.filter((r) => r.id === id)) } } : {}),
  });
  const [view] = (await withWikiLinks(deps.db, orgId, [messageView(message)])) as [MessageView];
  await publishMessageCreated(deps.pubsub, view);
  return view;
}

/**
 * After a reply in a task's conversation (ADR 0145): its files are linked to the task (its Anexos), and whoever sees
 * the task gets its card with the new count.
 */
export async function announceTaskConversation(deps: IssueDeps, orgId: string, messageId: string) {
  const message = await getMessage(deps.db, orgId, messageId);
  if (!message?.threadId) return;
  const [issue] = await deps.db
    .select()
    .from(issues)
    .where(and(eq(issues.orgId, orgId), eq(issues.conversationChannelId, message.channelId)));
  if (!issue) return;
  const files = fileIdsOf(message.meta).filter((id) => !issue.artifactIds.includes(id));
  const row = files.length
    ? ((
        await deps.db
          .update(issues)
          // Appended in SQL: another write to the list meanwhile keeps its own.
          .set({
            artifactIds: sql`${issues.artifactIds} || array(select x from unnest(${`{${files.join(",")}}`}::uuid[]) x
              where not x = any(${issues.artifactIds}))`,
          })
          .where(eq(issues.id, issue.id))
          .returning()
      )[0] ?? issue)
    : issue;
  await announce(deps, orgId, await one(deps.db, row), "issue.updated");
}

/** The task's conversation for whoever sees the task, made on first use (opening it, ADR 0145). */
export async function openTaskConversation(
  db: Database,
  actor: IssueActor,
  orgId: string,
  issueId: string,
): Promise<TaskConversationRef> {
  const issue = await findVisible(db, actor, orgId, { id: issueId });
  return ensureTaskConversation(db, issue.id);
}

/**
 * "Turn into issue": a message becomes an issue that keeps its channel's visibility, with the message's files (they
 * live where it was said, which the task's readers read).
 */
export async function issueFromMessage(
  deps: IssueDeps,
  userId: string,
  orgId: string,
  messageId: string,
  input: { title?: string } = {},
) {
  const message = await getMessage(deps.db, orgId, messageId);
  if (!message) throw new NotFoundError("Message not found");
  const actor: IssueActor = { type: "person", userId };
  const made = await conversationOf(deps.db, orgId, message.channelId);
  // Reading the message, not the task: an administrator reads a private channel, never someone's DM.
  if (!(await inConversation(deps.db, userId, orgId, message.channelId)))
    await requireChannelAccess(deps.db, userId, orgId, message.channelId).catch(() => {
      throw new NotFoundError("Message not found");
    });
  const firstLine = plainLines(message.body)[0] ?? plainLine(message.body);
  return createIssue(deps, actor, orgId, {
    title: input.title?.trim() || firstLine.slice(0, 120) || "New issue",
    description: message.body,
    source: { type: "message", channelId: message.channelId, messageId: message.id },
    channelId: made.tiedTo,
    ...(made.scope?.restricted ? { audience: { mode: "people", userIds: made.scope.audienceUserIds } } : {}),
    linkFileIds: fileIdsOf(message.meta),
  });
}

/**
 * "Ask Ada to implement": assigns the agent and starts its work in the task's own conversation (ADR 0145), where
 * everyone who sees the task follows it and talks to it, on a short line from the person ("Please implement issue
 * #N", `meta.issueWorkStart`). The instructions never show in the chat: the run's context builds them from the
 * issue (`issueWorkBrief`). Criteria, PR and status stay on the issue. An issue made from a channel message gets one
 * discreet line there (`meta.issueTaken`); nothing else is posted in channels.
 */
export async function askAgentToImplement(
  deps: IssueDeps,
  userId: string,
  orgId: string,
  issueId: string,
  agentId: string,
  /**
   * The right hand handing it on for `userId` from its run (ADR 0137 §13): the start is written as it, never in the
   * person's name, and is a `note` row of that run, so what comes of it goes back to their DM (`reportHandOffs`).
   */
  by?: { agentId: string; runId: string; hop: number },
): Promise<IssueView> {
  const { db } = deps;
  if (!deps.pubsub) throw new Error("askAgentToImplement needs pub/sub");
  const pubsub = deps.pubsub;
  const actor: IssueActor = { type: "person", userId };
  const issue = await findVisible(db, actor, orgId, { id: issueId });
  const agent = await getAgent(db, orgId, agentId);
  if (!agent || agent.archivedAt) throw new NotFoundError("Agent not found");
  if (!canTalkTo(agent, userId, await speakerFor(db, orgId, userId))) throw await audienceError(db, agent);
  const updated =
    issue.assigneeType === "agent" && issue.assigneeId === agentId
      ? await one(db, issue, userId)
      : await updateIssue(deps, actor, orgId, issue.id, { assignee: { type: "agent", id: agentId } });
  const conversation = await ensureTaskConversation(db, issue.id);
  await admitTaskAgents(db, orgId, conversation.channelId, { ids: [agentId] });
  const card: IssueWorkMeta = { issueId: issue.id, number: issue.number, title: issue.title, agentId };
  const author: WorkActor = by ? { type: "agent", id: by.agentId } : { type: "person", id: userId };
  const { start, runId } = await db.transaction(async (tx) => {
    const consultationId = Bun.randomUUIDv7();
    // What starts the run, in the conversation: short and human (shown in the person's language).
    const start = await insertMessage(tx, {
      orgId,
      channelId: conversation.channelId,
      threadId: conversation.rootId,
      author: by ? { type: "agent", agentId: by.agentId, runId: by.runId, hop: by.hop } : { type: "person", userId },
      body: `Please implement issue #${issue.number}.`,
      meta: {
        issueId: issue.id,
        issueWorkStart: true,
        bodyCode: "issue_work_start",
        bodyParams: { number: issue.number },
        ...(by ? { agentNote: { runId: by.runId }, consultation: { id: consultationId } } : {}),
      },
    });
    const { run, steered } = await enqueueRunJob(tx, start, agentId);
    const targetRunId = run?.id ?? steered;
    if (by)
      await tx.insert(agentConsultations).values({
        id: consultationId,
        orgId,
        kind: "note",
        askerRunId: by.runId,
        askerAgentId: by.agentId,
        targetAgentId: agentId,
        channelId: conversation.channelId,
        messageId: start.id,
        targetRunId,
        waitId: `async:${Bun.randomUUIDv7()}`,
        question: `Work on task #${issue.number}: ${issue.title}`.slice(0, 2_000),
        chain: [by.agentId],
        expiresAt: new Date(Date.now() + TASK_HAND_OFF_TTL_MS),
      });
    return { start, runId: run?.id ?? null };
  });
  await publishMessageCreated(pubsub, messageView(start));
  if (runId) {
    await publishChannelEvent(pubsub, {
      type: "agent.thinking",
      channelId: conversation.channelId,
      threadId: conversation.rootId,
      agentId,
      runId,
    });
  }
  await db.transaction(async (tx) => {
    await addActivity(tx, issue, {
      kind: "event",
      author,
      text: `asked ${agent.name} to implement`,
      event: "agent_asked",
      data: {
        agentId,
        agentName: agent.name,
        channelId: conversation.channelId,
        messageId: start.id,
        threadId: conversation.rootId,
        inConversation: true,
      },
    });
    await recordAudit(tx, {
      orgId,
      actor: author,
      action: "issue.agent_asked",
      target: { type: "issue", id: issue.id },
      details: { agentId },
      ...(by ? { runId: by.runId, onBehalfOfUserId: userId } : {}),
    });
  });
  await announceTaken(deps, issue, card);
  await startedWork(deps, issue, agentId, runId ? [runId] : []);
  const fresh = await reload(db, issue);
  if (!fresh) return updated;
  const view = await one(db, fresh);
  await announce(deps, orgId, view, "issue.updated");
  return view;
}

/** How long a hand-off of a task waits before it counts as hung while its agent hasn't started (the work extends it). */
const TASK_HAND_OFF_TTL_MS = 15 * 60_000;

/** An issue made from a channel message: one discreet line there ("Ada took issue #24"), never a thread. */
async function announceTaken(deps: IssueDeps, issue: IssueRow, card: IssueWorkMeta) {
  const source = issue.source as IssueSource;
  // Limited since it was made: the people of the message's channel may not see it.
  if (source.type !== "message" || !deps.pubsub || issue.restricted) return;
  const origin = await getMessage(deps.db, issue.orgId, source.messageId);
  if (!origin || origin.channelId !== source.channelId) return;
  const [channel] = await deps.db
    .select({ kind: channels.kind, archivedAt: channels.archivedAt })
    .from(channels)
    .where(eq(channels.id, origin.channelId));
  if (!channel || channel.archivedAt) return;
  const line = await insertMessage(deps.db, {
    orgId: issue.orgId,
    channelId: origin.channelId,
    threadId: origin.threadId,
    author: { type: "agent", agentId: card.agentId, runId: null, hop: 0, stretchId: null },
    body: `Took issue #${card.number}: ${card.title}`.slice(0, 2_000),
    meta: { issueTaken: card, bodyCode: "issue_taken", bodyParams: { number: card.number } },
  });
  await publishMessageCreated(deps.pubsub, messageView(line));
}

/**
 * An agent's reply to a task it was asked to implement (trigger `meta.issueId`) goes to the task's conversation,
 * unless it was written there already (ADR 0145: where "Pedir ao" works now; older work threads lived in a DM).
 */
export async function mirrorReplyToIssue(
  deps: IssueDeps,
  run: { orgId: string; agentId: string; channelId: string },
  issueId: string,
  text: string,
) {
  const [issue] = await deps.db
    .select({ conversationChannelId: issues.conversationChannelId })
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.orgId, run.orgId)));
  if (!issue || issue.conversationChannelId === run.channelId) return;
  await commentIssue(deps, { type: "agent", agentId: run.agentId, channelId: run.channelId }, run.orgId, issueId, text);
}

/**
 * A run started in an issue's work thread (or on its start message) works on that issue, as if it had
 * touched it with a tool: the issue shows it working instead of stalled. Only while the issue is open and
 * still this agent's.
 */
export async function linkRunToIssue(
  deps: IssueDeps,
  run: { id: string; orgId: string; agentId: string },
  issueId: string,
) {
  const [issue] = await deps.db
    .select()
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.orgId, run.orgId)));
  // The issue's work is its latest linked run: a run in the thread of an agent it was taken from would hide
  // the assignee's.
  if (issue?.assigneeType !== "agent" || issue.assigneeId !== run.agentId || !OPEN_FOR_WORK.has(issue.status)) return;
  await startedWork(deps, issue, run.agentId, [run.id]);
}

const OPEN_TASKS_SHOWN = 5;

/**
 * A run's reminder of the agent's open tasks: issues assigned to it, not done or canceled, that it can see
 * from the run's channel, newest activity first. `updates`: it has the tools to keep them updated. Null when
 * there are none.
 */
export async function openTasksBrief(
  db: Database,
  orgId: string,
  agentId: string,
  channelId: string,
  updates: boolean,
  /** A personal workspace (ADR 0159): the person, not a team, sees the work. */
  personal = false,
) {
  const visible = await agentSearchChannels(db, orgId, agentId, channelId);
  const rows = await db
    .select({ number: issues.number, title: issues.title, status: issues.status, criteria: issues.criteria })
    .from(issues)
    .where(
      and(
        eq(issues.orgId, orgId),
        eq(issues.assigneeType, "agent"),
        eq(issues.assigneeId, agentId),
        inArray(issues.status, [...OPEN_FOR_WORK]),
        // What `canSee` lets it read from here: an issue of a private channel or DM would leak its title.
        or(
          and(eq(issues.restricted, false), isNull(issues.channelId)),
          inArray(issues.channelId, visible),
          seenFromDmSql(orgId, channelId, sql`${issues.channelId}`),
          // From a task's own conversation: that task (ADR 0145), and what's tied to the same place.
          eq(issues.conversationChannelId, channelId),
          sql`${issues.channelId} = (select t.channel_id from ${issues} t where t.conversation_channel_id = ${channelId}::uuid)`,
          // Limited to people: in a DM of someone it names.
          sql`${issues.restricted} and exists (select 1
            from ${channelMembers} dm_m join ${channels} dm on dm.id = dm_m.channel_id and dm.kind = 'dm'
            where dm_m.channel_id = ${channelId}::uuid and dm_m.user_id = any(${issues.audienceUserIds}))`,
        ),
      ),
    )
    .orderBy(desc(issues.updatedAt))
    .limit(OPEN_TASKS_SHOWN);
  if (rows.length === 0) return null;
  return [
    "# Your open tasks",
    "Issues assigned to you, latest activity first:",
    ...rows.map((r) => {
      const done = r.criteria.filter((c) => c.done).length;
      return `- #${r.number} ${r.title} (${r.status}${r.criteria.length ? `, criteria ${done}/${r.criteria.length}` : ""})`;
    }),
    ...(updates
      ? [
          `When what you're doing belongs to one of them, keep that task updated as you go: a short progress comment (\`comment_issue\`) and each criterion as you meet it (\`update_issue\`); its status moves on its own. That also ties your run to it, so ${personal ? "the person" : "the team"} sees you working on it.`,
        ]
      : []),
  ].join("\n");
}

registerDocumentBuilder("issue", async (db, orgId, id) => {
  const [i] = await db
    .select()
    .from(issues)
    .where(and(eq(issues.id, id), eq(issues.orgId, orgId)));
  if (!i) return null;
  return {
    orgId,
    kind: "issue",
    sourceId: i.id,
    // A limited task is its own scope: only who sees it searches it (`searchForUser`).
    channelIds: i.restricted ? [i.id] : i.channelId ? [i.channelId] : [],
    title: `#${i.number} ${i.title}`,
    body: [i.description, ...i.criteria.map((c) => c.text)].join("\n").slice(0, 20_000),
    createdAt: i.createdAt,
  };
});

/**
 * Links a background work to its card (ADR 0121 §4): issue `number` when the agent named one it can see, else the issue
 * the run already works on, else a new card assigned to the agent in the conversation's channel (who reads the
 * conversation sees it). An existing card's criteria are never touched. Returns the issue's id.
 */
export async function linkIssueToWork(
  deps: IssueDeps,
  work: WorkRow,
  run: { id: string; orgId: string; agentId: string; channelId: string; issueId: string | null },
  input: { number?: number; description: string },
): Promise<string | null> {
  const actor: IssueActor = { type: "agent", agentId: run.agentId, channelId: run.channelId, runId: run.id };
  let issueId: string | null = null;
  if (input.number !== undefined) {
    // Only a card the person behind the work can read, in this conversation or workspace-wide: its updates must not
    // carry the conversation to readers it doesn't have.
    const found = work.requestedByUserId
      ? await findVisible(deps.db, { type: "person", userId: work.requestedByUserId }, run.orgId, {
          number: input.number,
        }).catch(() => null)
      : null;
    issueId =
      found && !found.restricted && (found.channelId === null || found.channelId === work.channelId) ? found.id : null;
  }
  issueId ??= run.issueId;
  if (!issueId) {
    const created = await createIssue(deps, actor, run.orgId, {
      title: work.title,
      description: input.description,
      assignee: { type: "agent", id: run.agentId },
      source: {
        type: "agent",
        agentId: run.agentId,
        workId: work.id,
        channelId: work.channelId,
        messageId: work.anchorMessageId,
      },
      channelId: work.channelId,
    });
    issueId = created.id;
  }
  await deps.db.update(schema.agentWorks).set({ issueId }).where(eq(schema.agentWorks.id, work.id));
  await deps.db
    .update(agentRuns)
    .set({ issueId })
    .where(and(eq(agentRuns.workId, work.id), isNull(agentRuns.issueId)));
  await setWorkIssueState(deps, { ...work, issueId }, {});
  return issueId;
}

/**
 * A card follows its work (ADR 0121 §4): queued → A fazer, working → Em andamento, waiting on a person, paused or
 * failed → the blocked badge in its stage, done → Feito (left in review when the agent moved it there), stopped →
 * back to A fazer. An update is an activity event on it.
 */
export async function setWorkIssueState(
  deps: IssueDeps,
  work: Pick<WorkRow, "id" | "orgId" | "agentId" | "issueId">,
  input: { update?: string; plan?: boolean; ended?: "done" | "failed" | "canceled" },
) {
  if (!work.issueId) return;
  const view = (await workViews(deps.db, work.orgId, [work.id])).get(work.id);
  const [current] = await deps.db.select().from(issues).where(eq(issues.id, work.issueId));
  if (!view || !current || current.status === "canceled") return;
  const now = new Date();
  let status: IssueStatus = current.status;
  let blocked: IssueRow["blocked"] = null;
  const ended = input.ended ?? (view.status === "live" || view.status === "queued" ? null : view.status);
  if (ended === "done") status = current.status === "in_review" ? "in_review" : "done";
  else if (ended === "canceled") status = "todo";
  else if (ended === "failed") blocked = { reason: "failed", since: now.toISOString(), text: view.errorCode ?? "" };
  else if (view.state === "queued") status = current.status === "done" ? current.status : "todo";
  else {
    if (current.status === "todo" || current.status === "done") status = "in_progress";
    if (view.state && view.state !== "working")
      blocked = { reason: view.state, since: current.blocked?.since ?? now.toISOString() };
  }
  const author: WorkActor = { type: "agent", id: work.agentId };
  const row = await deps.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(issues)
      .set({
        blocked,
        updatedAt: now,
        ...(status !== current.status ? { status, columnId: null, boardRank: topRank() } : {}),
      })
      .where(eq(issues.id, current.id))
      .returning();
    if (!updated) return null;
    if (status !== current.status) {
      await addActivity(tx, updated, {
        kind: "event",
        author,
        text: `changed the status to ${STATUS_WORDS[status]} (automatic: background work)`,
        event: "status_changed",
        data: { from: current.status, to: status, auto: true },
      });
    }
    if (input.update) {
      await addActivity(tx, updated, {
        kind: "event",
        author,
        text: input.update,
        event: "work_update",
        data: { text: input.update, workId: work.id, auto: true },
      });
    }
    if (ended === "canceled" && view.canceledByUserId) {
      await addActivity(tx, updated, {
        kind: "event",
        author,
        text: "stopped",
        event: "work_stopped",
        data: { byUserId: view.canceledByUserId, workId: work.id, auto: true },
      });
    }
    return updated;
  });
  if (!row) return;
  await announce(deps, work.orgId, await one(deps.db, row), "issue.updated");
}

/** A task's steps at every depth (`union`: a loop ends). */
async function stepsOf(db: Database, task: Pick<IssueRow, "id" | "orgId">) {
  const tree = rowsOf<{ id: string }>(
    await db.execute(sql`with recursive tree as (
        select s.id from ${issues} s where s.parent_issue_id = ${task.id}::uuid and s.org_id = ${task.orgId}::uuid
        union
        select s.id from ${issues} s join tree on s.parent_issue_id = tree.id
      ) select id from tree`),
  );
  if (tree.length === 0) return [];
  return db
    .select()
    .from(issues)
    .where(
      inArray(
        issues.id,
        tree.map((t) => t.id),
      ),
    );
}

const sameList = (a: readonly string[], b: readonly string[]) => [...a].sort().join() === [...b].sort().join();

/** Who reads each of these tasks' conversations now, as `channelId userId`. */
async function conversationReaders(db: Database, orgId: string, ids: string[]) {
  const rows = rowsOf<{ channel_id: string; user_id: string }>(
    await db.execute(sql`select t.conversation_channel_id as channel_id, om.user_id
      from ${issues} t join ${organizationMembers} om on om.org_id = t.org_id
      where t.org_id = ${orgId}::uuid and t.id = any(${`{${ids.join(",")}}`}::uuid[])
        and t.conversation_channel_id is not null and ${taskSeenSql("t", sql`om.user_id`)}`),
  );
  return new Set(rows.map((r) => `${r.channel_id} ${r.user_id}`));
}

/**
 * Changes who sees a task (ADR 0151), by anyone who can edit it. Limited, its steps go with it at every depth: a step
 * left open would show what the task keeps. A step with a list of its own keeps it, so nobody new reads it, and a
 * person assigned to a step stays on it. To everyone, steps stay as they are, so a step someone kept back isn't shown.
 * Who loses it loses its notifications and, at once, the conversation they have open; everyone's boards read again from
 * an event that says nothing about it.
 */
export async function setIssueAudience(
  deps: IssueDeps,
  actor: IssueActor,
  orgId: string,
  issueId: string,
  audience: Audience,
) {
  const { db } = deps;
  const current = await findVisible(db, actor, orgId, { id: issueId });
  const assignee = current.assigneeType === "person" ? current.assigneeId : null;
  const scope = await chosenScope(db, actor, orgId, audience, assignee);
  const tied = (await tiedPeople(db, [current])).has(current.channelId ?? "");
  const unchanged = current.restricted
    ? scope.restricted && sameList(scope.audienceUserIds, current.audienceUserIds)
    : !scope.restricted && !tied;
  if (unchanged) return one(db, current, readerOf(actor));
  const steps = scope.restricted
    ? (await stepsOf(db, current)).filter(
        (s) => !s.restricted || (current.restricted && sameList(s.audienceUserIds, current.audienceUserIds)),
      )
    : [];
  const changed = [current.id, ...steps.map((s) => s.id)];
  const readers = await conversationReaders(db, orgId, changed);
  const row = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(issues)
      .set({ ...scope, updatedAt: new Date() })
      .where(eq(issues.id, current.id))
      .returning();
    if (!updated) throw new NotFoundError("Issue not found");
    for (const s of steps) {
      const assigned = s.assigneeType === "person" && s.assigneeId ? [s.assigneeId] : [];
      await tx
        .update(issues)
        .set({ ...scope, audienceUserIds: [...new Set([...scope.audienceUserIds, ...assigned])].sort() })
        .where(eq(issues.id, s.id));
    }
    await addActivity(tx, updated, {
      kind: "event",
      author: actorOf(actor),
      text: audience.mode === "everyone" ? "showed the task to everyone" : "changed who sees the task",
      event: "audience_changed",
      data: { mode: audience.mode, from: current.channelId },
    });
    await recordAudit(tx, {
      orgId,
      actor: actor.type === "person" ? { type: "person", id: actor.userId } : { type: "agent", id: actor.agentId },
      action: "issue.audience_changed",
      target: { type: "issue", id: current.id },
      details: { mode: audience.mode, userIds: scope.audienceUserIds },
    });
    for (const id of changed) await enqueueIndex(tx, { orgId, kind: "issue", sourceId: id });
    await tx.execute(sql`delete from ${notifications} n using ${issues} t
      where n.org_id = ${orgId}::uuid and t.id = any(${`{${changed.join(",")}}`}::uuid[])
        and n.source->>'issueId' = t.id::text and not ${taskSeenSql("t", sql`n.user_id`)}`);
    return updated;
  });
  await keepFilesWithTask(deps, actor, row, row.artifactIds);
  const still = await conversationReaders(db, orgId, changed);
  for (const reader of readers) {
    if (still.has(reader)) continue;
    const [channelId, userId] = reader.split(" ") as [string, string];
    await publishOrgEvent(deps.pubsub, { type: "membership.revoked", orgId, userId, channelId });
  }
  await publishOrgEvent(deps.pubsub, {
    type: "org.broadcast",
    orgId,
    event: { type: "issue.audience", issueId: current.id },
  });
  return one(db, (await reload(db, row)) ?? row, readerOf(actor));
}

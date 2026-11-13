import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, eq, inArray, isNull, schema, sql } from "@agenteschat/db";
import { publishOrgEvent } from "./events";
import { cutText } from "./format";
import type { Judge } from "./judge";
import { requirePermission } from "./organizations";
import { type OutOfOffice, type OutOfOfficeOptions, outOfOffice } from "./out-of-office";
import { routineSeer } from "./routines";
import { outageParkedSql } from "./runs";
import { toolGroupKey } from "./tools/directory";
import type { ToolContext, ToolDefinition, ToolSource } from "./tools/types";
import { liveWorksByAgent, type WorkView } from "./works";
import { inWorkspaceWords } from "./workspace-mode";

const { agents, agentRuns, channels, issues, messages, missions } = schema;
type AgentRunRow = typeof agentRuns.$inferSelect;

/**
 * An agent's presence, from its work (ADR 0084): nobody sets it by hand.
 * - `busy`: on heavy work (a routine, a task, a run going for a while, or one Jev rated heavy), or it said so.
 * - `online`: answering someone, waiting on an answer, or active recently.
 * - `away`: idle for a while.
 * - `out`: out of office (§12): its plan hit its limit or its monthly budget is spent, so it can't think until a
 *   reset (`out-of-office.ts`). Its line says why and until when.
 * - `offline`: held by the people who run the server. An agent with no AI is drawn offline by the apps,
 *   which already know it (`GET …/ai-status`).
 */
export type AgentPresence = "online" | "busy" | "away" | "out" | "offline";

/** What a line the server picked says (ADR 0084 §8); the apps word it in their language. */
export type AgentStatusKind =
  | "task"
  | "routine"
  | "mission"
  | "channel"
  | "browsing"
  | "coding"
  | "files"
  | "wiki"
  | "planning"
  | "data"
  | "mail"
  | "connector"
  | "computer"
  | "waiting_approval"
  | "waiting_answer"
  | "waiting_computer"
  /** In line for room on a shared computer (`computer-queue.ts`). */
  | "queued_computer"
  | "waiting_plan"
  | "waiting_budget"
  | "provider_down"
  /** Out of office (§12): its plan hit its limit, back at `until` (null: the plan didn't say when). */
  | "out_of_plan"
  /** Out of office (§12): its monthly budget is spent, back at `until` (the next month). */
  | "out_of_budget"
  /** Long work in the background (ADR 0121): `subject` its title (only where everyone may read it), `count` how many. */
  | "work";

/** An agent's line: its own words (`self`), one picked for its run (`auto`), or what its run waits on (`wait`). */
export interface AgentStatusLine {
  by: "self" | "auto" | "wait";
  text: string | null;
  kind: AgentStatusKind | null;
  subject: string | null;
  emoji: string | null;
  until: string | null;
  /** Since when (a work's start). */
  since?: string;
  /** How many background works it is on (with `kind` `work`), or conversations wait for it (out of office). */
  count?: number;
  /** A second work's title, for "Em 2 trabalhos: A e B". */
  second?: string | null;
  /** One work that waits: on what (`approval`, `answer`, `plan`, `computer`, `line`). */
  wait?: "approval" | "answer" | "plan" | "computer" | "line";
}

export interface AgentStatusView {
  agentId: string;
  presence: AgentPresence;
  status: AgentStatusLine | null;
  /** Its last run's end (or now while one is going), ISO; null = it never worked. */
  activeAt: string | null;
  /**
   * Something of its own is thinking now (a run, or long work at work): the apps draw it at work whatever they read of
   * its AI, which for the right hand is each viewer's own.
   */
  working: boolean;
}

/** A run going this long is heavy work: the agent reads as busy. */
export const AGENT_HEAVY_AFTER_MS = 2 * 60_000;
/** No run for this long: away. */
export const AGENT_AWAY_AFTER_MS = 30 * 60_000;
/** A running run counts only with a heartbeat this recent: a dead worker's run stops counting at once (§11). */
export const AGENT_HEARTBEAT_FRESH_MS = 90_000;
/** A run waiting longer than this keeps the agent online but loses its line (§11). */
export const AGENT_WAIT_LINE_MS = 24 * 3600_000;
/** An automatic line changes at most this often while the run moves between tools (§10). */
export const AGENT_LINE_EVERY_MS = 30_000;
/** Jev's rating of the work at or above which the run is busy from the start (§9): P(minutes or long) ≥ this. */
export const AGENT_HEAVY_PROBABILITY = 0.6;
/** An automatic line shows only when Jev rates it worth showing at least this much (§8): a quick reply says nothing. */
export const AGENT_LINE_WORTH = 0.5;
/** An agent's own line is replaced when Jev says it still fits the step under this (§10). */
export const AGENT_LINE_STALE_BELOW = 0.3;

export const AGENT_STATUS_TEXT_MAX = 100;
/** The longest an agent's status may outlive its run. */
export const AGENT_STATUS_MAX_MS = 24 * 3600_000;

const ACTIVE = ["queued", "running"] as const;
const WAITING = ["waiting_approval", "waiting_input"] as const;

/**
 * Every agent's presence and written status, for a member of the organization. An agent hidden from them (the
 * agents list's rule, `routineSeer`) keeps its presence but not its line, which can name a routine, task or channel.
 */
export async function agentStatuses(
  db: Database,
  actorId: string,
  orgId: string,
  now = new Date(),
  options: Pick<OutOfOfficeOptions, "hasModel"> = {},
) {
  await requirePermission(db, actorId, orgId, "read");
  const [list, sees] = await Promise.all([
    loadAgentStatuses(db, orgId, now, undefined, options),
    routineSeer(db, orgId, actorId),
  ]);
  return list.map((s) => (sees({ agentId: s.agentId, createdByUserId: null }) ? s : { ...s, status: null }));
}

/**
 * Every agent's presence and line in an organization, at `now` (no permission check), or only `ids`'. Checked on
 * read, no job. `hasModel` (the gateway's key check) tells whether a plan at its limit still falls back to a model.
 */
export async function loadAgentStatuses(
  db: Database,
  orgId: string,
  now = new Date(),
  ids?: string[],
  options: Pick<OutOfOfficeOptions, "hasModel"> = {},
): Promise<AgentStatusView[]> {
  if (ids?.length === 0) return [];
  const ofAgents = ids ? [inArray(agents.id, ids)] : [];
  const ofRuns = ids ? [inArray(agentRuns.agentId, ids)] : [];
  const [list, open] = await Promise.all([
    db
      .select({
        id: agents.id,
        orgId: agents.orgId,
        model: agents.model,
        credentialId: agents.credentialId,
        brain: agents.brain,
        brainFallback: agents.brainFallback,
        brainAccountId: agents.brainAccountId,
        machineId: agents.machineId,
        monthlyBudgetNanoUsd: agents.monthlyBudgetNanoUsd,
        heldAt: agents.operatorHoldAt,
        statusText: agents.statusText,
        statusEmoji: agents.statusEmoji,
        statusBusy: agents.statusBusy,
        statusRunId: agents.statusRunId,
        statusUntil: agents.statusUntil,
        statusSource: agents.statusSource,
        statusKind: agents.statusKind,
        statusSubject: agents.statusSubject,
        builtin: agents.builtin,
        createdAt: agents.createdAt,
        // Its last finished run however long ago ("Parado desde…"): none means it never worked. Newest first along
        // the (org, agent, created) index, so this stops at the first one.
        // Written out: Drizzle drops a column's table in a one-table select, and `id` would read the run's.
        lastRunAt: sql<Date | string | null>`(
          select r.finished_at from agent_runs r
          where r.org_id = agents.org_id and r.agent_id = agents.id and r.finished_at is not null
          order by r.created_at desc limit 1
        )`,
      })
      .from(agents)
      .where(and(eq(agents.orgId, orgId), isNull(agents.archivedAt), ...ofAgents)),
    db
      .select({
        id: agentRuns.id,
        agentId: agentRuns.agentId,
        status: agentRuns.status,
        background: agentRuns.background,
        workId: agentRuns.workId,
        issueId: agentRuns.issueId,
        startedAt: agentRuns.startedAt,
        heartbeatAt: agentRuns.heartbeatAt,
        updatedAt: agentRuns.updatedAt,
        waitingMachineId: agentRuns.waitingMachineId,
        outage: outageParkedSql,
        // A long-work pause (ADR 0118) reads as the wait on what it paused on.
        waitCode: sql<string | null>`case when ${agentRuns.transcript}->'waitingForBrain'->>'code' = 'usage_pause'
          then (case when ${agentRuns.transcript}->'waitingForBrain'->>'source' = 'budget' then 'budget' else 'plan_limit' end)
          else ${agentRuns.transcript}->'waitingForBrain'->>'code' end`,
        /** A conversation's catch-up: waiting on its plan or budget itself (not long work paused near one). */
        catchUp: sql<"plan_limit" | "budget" | null>`case when ${agentRuns.status} = 'waiting_input'
          and ${agentRuns.transcript}->'waitingForBrain'->>'code' in ('plan_limit', 'budget')
          then ${agentRuns.transcript}->'waitingForBrain'->>'code' end`,
        resetsAt: sql<string | null>`${agentRuns.transcript}->'waitingForBrain'->>'resetsAt'`,
      })
      .from(agentRuns)
      .where(and(eq(agentRuns.orgId, orgId), inArray(agentRuns.status, [...ACTIVE, ...WAITING]), ...ofRuns)),
  ]);
  const [works, outs] = await Promise.all([
    liveWorksByAgent(db, orgId, ids),
    outOfOffice(db, orgId, list, { now, ...options }),
  ]);
  const publicIds = await publicChannelIds(
    db,
    orgId,
    [...works.values()].flat().map((w) => w.channelId),
  );
  const ms = now.getTime();
  // A running run without a recent heartbeat lost its worker: it doesn't count (recovery takes it within a minute).
  const alive = open
    .filter(
      (r) =>
        r.status !== "running" ||
        ms - (r.heartbeatAt ?? r.startedAt ?? r.updatedAt).getTime() < AGENT_HEARTBEAT_FRESH_MS,
    )
    // Asking its computer from the line it still waits (`computerWaitOf`): no "working" for the ask.
    .map((r) =>
      r.status === "running" && r.waitingMachineId ? { ...r, status: "waiting_input" as const, waitCode: "busy" } : r,
    );
  const runById = new Map(alive.map((r) => [r.id, r]));
  return list.map((a) => {
    // Long work (ADR 0121) speaks through its own line below, never through the wait lines.
    const runs = alive.filter((r) => r.agentId === a.id && !r.workId);
    const working = runs.filter((r) => (ACTIVE as readonly string[]).includes(r.status));
    const long = (r: (typeof runs)[number]) =>
      r.startedAt !== null && ms - r.startedAt.getTime() >= AGENT_HEAVY_AFTER_MS;
    const stored = storedLine(a, runById, now);
    const isWorking = (r: (typeof runs)[number]) => (ACTIVE as readonly string[]).includes(r.status);
    const lineRun = a.statusRunId ? runById.get(a.statusRunId) : undefined;
    let status = stored?.line ?? null;
    // What its run waits on (an approval, an answer, its computer) replaces the line, unless the agent's own words
    // have an end of their own; with no line, the first run that waits speaks while nothing works (§10–11).
    const waits =
      lineRun && !isWorking(lineRun)
        ? lineRun
        : !status && working.length === 0
          ? runs.find((r) => !isWorking(r))
          : undefined;
    if (waits && !(stored?.line.by === "self" && a.statusUntil)) {
      // Parked on a provider outage it waits on nobody: its line says the provider is down for as long as it is.
      status = waits.outage || ms - waits.updatedAt.getTime() < AGENT_WAIT_LINE_MS ? waitLine(waits) : null;
    }
    const mine = works.get(a.id) ?? [];
    // Precedence: its own words > its background works > a conversation run's line > what a run waits on.
    if (mine.length > 0 && stored?.line.by !== "self") status = workLine(mine, publicIds);
    const heavy =
      mine.some((w) => w.status === "live") ||
      working.some((r) => r.background || r.issueId !== null || long(r)) ||
      (stored?.busy === true && working.length > 0);
    const activeAt = runs.length > 0 || mine.length > 0 ? now : a.lastRunAt ? new Date(a.lastRunAt) : null;
    // Out of office (§12) while nothing of its own is thinking: whatever waits, waits for the reset. Its own words
    // stay. A conversation waiting on its plan or budget says so too (nothing could stand in for it), with how many
    // wait: one story for its status, its queue and its notes.
    const catchUps = runs.filter((r) => r.catchUp !== null && !r.background);
    const out = outs.get(a.id) ?? catchUpOut(catchUps, now);
    const thinking =
      working.some((r) => r.status === "running") ||
      mine.some((w) => w.status === "live" && (w.state === null || w.state === "working"));
    const outNow = out && !thinking;
    if (outNow && stored?.line.by !== "self") status = outLine(out, catchUps.length);
    // Away is for an agent idle a while since it last worked: one just made counts from its making, and the right hand,
    // where the workspace's people come to talk, never idles away.
    const fresh = activeAt ?? new Date(a.createdAt);
    const presence: AgentPresence = a.heldAt
      ? "offline"
      : outNow
        ? "out"
        : heavy
          ? "busy"
          : runs.length > 0 || a.builtin === "right_hand" || ms - fresh.getTime() < AGENT_AWAY_AFTER_MS
            ? "online"
            : "away";
    return { agentId: a.id, presence, status, activeAt: activeAt?.toISOString() ?? null, working: thinking };
  });
}

/** An out-of-office agent's line (§12): why, when it is back, and how many conversations wait for it (`count`). */
const outLine = (out: OutOfOffice, waiting: number): AgentStatusLine => ({
  by: "auto",
  text: null,
  kind: out.reason === "plan" ? "out_of_plan" : "out_of_budget",
  subject: null,
  emoji: null,
  until: out.until?.toISOString() ?? null,
  ...(waiting > 0 ? { count: waiting } : {}),
});

/**
 * Out of office read from its conversations waiting on its plan or budget: the earliest reset still ahead (one past
 * while the line drains, 60 s apart, says no time rather than one gone by).
 */
function catchUpOut(
  list: { catchUp: "plan_limit" | "budget" | null; resetsAt: string | null }[],
  now: Date,
): OutOfOffice | undefined {
  const first = list[0];
  if (!first) return undefined;
  const reason = list.some((r) => r.catchUp === "plan_limit") ? ("plan" as const) : ("budget" as const);
  const resets = list.map((r) => Date.parse(r.resetsAt ?? "")).filter((t) => t > now.getTime());
  return { reason, until: resets.length > 0 ? new Date(Math.min(...resets)) : null };
}

const WORK_WAITS: Partial<Record<NonNullable<WorkView["state"]>, AgentStatusLine["wait"]>> = {
  waiting_approval: "approval",
  waiting_input: "answer",
  paused: "plan",
  waiting_computer: "computer",
  queued: "line",
};

/** The line of an agent on background work: its titles only where everyone may read them (a public channel). */
function workLine(list: WorkView[], publicIds: Set<string>): AgentStatusLine {
  const titled = (w: WorkView) => (publicIds.has(w.channelId) ? w.title : null);
  const first = list[0] as WorkView;
  const oldest = list.reduce((a, w) => (w.startedAt < a ? w.startedAt : a), first.startedAt);
  const wait = list.length === 1 && first.state ? WORK_WAITS[first.state] : undefined;
  return {
    by: "auto",
    text: null,
    kind: "work",
    subject: titled(first),
    emoji: null,
    until: null,
    since: list.length === 1 ? first.startedAt : oldest,
    count: list.length,
    second: list[1] ? titled(list[1]) : null,
    ...(wait ? { wait } : {}),
  };
}

async function publicChannelIds(db: Database, orgId: string, ids: string[]) {
  if (ids.length === 0) return new Set<string>();
  const rows = await db
    .select({ id: channels.id })
    .from(channels)
    .where(
      and(
        eq(channels.orgId, orgId),
        inArray(channels.id, [...new Set(ids)]),
        eq(channels.kind, "channel"),
        eq(channels.visibility, "public"),
      ),
    );
  return new Set(rows.map((r) => r.id));
}

interface StoredStatus {
  statusText: string | null;
  statusEmoji: string | null;
  statusBusy: boolean;
  statusRunId: string | null;
  statusUntil: Date | null;
  statusSource: "self" | "auto" | null;
  statusKind: string | null;
  statusSubject: string | null;
}

/** The stored line while it holds: its run is still alive, or (with `minutes`) its end time hasn't come. */
function storedLine(a: StoredStatus, aliveRuns: Map<string, unknown>, now: Date) {
  const has = a.statusSource === "auto" ? Boolean(a.statusKind) : Boolean(a.statusText);
  if (!has) return null;
  const runAlive = Boolean(a.statusRunId && aliveRuns.has(a.statusRunId));
  if (!runAlive && !(a.statusUntil && a.statusUntil > now)) return null;
  const line: AgentStatusLine =
    a.statusSource === "auto"
      ? {
          by: "auto",
          text: null,
          kind: a.statusKind as AgentStatusKind,
          subject: a.statusSubject,
          emoji: null,
          until: a.statusUntil?.toISOString() ?? null,
        }
      : {
          by: "self",
          text: a.statusText,
          kind: null,
          subject: null,
          emoji: a.statusEmoji,
          until: a.statusUntil?.toISOString() ?? null,
        };
  return { line, busy: a.statusBusy };
}

const waitLine = (r: {
  status: string;
  waitingMachineId: string | null;
  waitCode?: string | null;
  outage?: boolean;
}): AgentStatusLine => ({
  by: "wait",
  text: null,
  kind: r.outage
    ? "provider_down"
    : r.status === "waiting_approval"
      ? "waiting_approval"
      : r.waitCode === "plan_limit"
        ? "waiting_plan"
        : r.waitCode === "budget"
          ? "waiting_budget"
          : r.waitingMachineId
            ? r.waitCode === "busy"
              ? "queued_computer"
              : "waiting_computer"
            : "waiting_answer",
  subject: null,
  emoji: null,
  until: null,
});

/** An agent's line in plain English, for other agents (`find_agent`); the apps word it themselves. */
export function lineInEnglish(line: AgentStatusLine): string | null {
  if (line.text) return line.text;
  const s = line.subject ?? "";
  const words: Record<AgentStatusKind, string> = {
    task: `working on the task "${s}"`,
    routine: `running the routine "${s}"`,
    mission: `working on the mission "${s}"`,
    channel: `answering in #${s}`,
    browsing: "browsing the web",
    coding: "coding",
    files: "working on files",
    wiki: "writing in the wiki",
    planning: "organizing tasks",
    data: "analyzing data",
    mail: "handling email",
    connector: `using ${s}`,
    computer: "using the computer",
    waiting_approval: "waiting for an approval",
    waiting_answer: "waiting for an answer",
    waiting_computer: "waiting for its computer",
    queued_computer: "in line for its computer",
    waiting_plan: "waiting for its plan to reset",
    waiting_budget: "waiting for its budget to renew",
    provider_down: "waiting for its AI provider to come back (it retries by itself)",
    out_of_plan: `out of office: its AI plan hit its limit${line.until ? `, back at ${line.until}` : ""}; what you send waits until then${line.count ? ` (${line.count} conversation${line.count === 1 ? "" : "s"} already waiting)` : ""}`,
    out_of_budget: `out of office: its monthly budget is spent${line.until ? `, back at ${line.until}` : ""}; what you send waits until then`,
    work:
      (line.count ?? 1) > 1
        ? `on ${line.count} background works${s ? ` ("${s}"…)` : ""}`
        : `working in the background${s ? ` on "${s}"` : ""}`,
  };
  return line.kind ? words[line.kind] : null;
}

/** Tells the apps an agent's presence or line moved (a run started or ended, a line changed): ids only. */
export async function announceAgentStatus(pubsub: PubSub | undefined, orgId: string, agentId: string) {
  await publishOrgEvent(pubsub, { type: "org.broadcast", orgId, event: { type: "agent.status", orgId, agentId } });
}

// ── The line picked for a run (ADR 0084 §8–10) ─────────────────────────────

/** A line the run could show: what it says (`kind`, `subject`) and, for Jev, the same in plain English. */
export interface StatusCandidate {
  key: string;
  kind: AgentStatusKind;
  subject: string | null;
  text: string;
}

/** What it is doing, by the group of the tool it uses; null = nothing worth a line (chat, memory, skills). */
export function activityOf(
  tool: Pick<ToolDefinition, "name" | "scope" | "connectionId" | "connectorLabel">,
): Omit<StatusCandidate, "key"> | null {
  const group = toolGroupKey(tool);
  const label = tool.connectorLabel?.trim();
  if (group === "browser") return { kind: "browsing", subject: null, text: "Browsing the web" };
  if (group === "desktop") return { kind: "computer", subject: null, text: "Using the computer" };
  if (group === "sandbox" || group === "github") return { kind: "coding", subject: null, text: "Coding" };
  if (group === "drive") return { kind: "files", subject: null, text: "Working on files" };
  if (group === "wiki") return { kind: "wiki", subject: null, text: "Writing in the wiki" };
  if (["issues", "linear", "calendar", "schedule"].includes(group)) {
    return { kind: "planning", subject: null, text: "Organizing tasks" };
  }
  if (group === "mail") return { kind: "mail", subject: null, text: "Handling email" };
  if (group.startsWith("pg_") || group === "database") {
    return { kind: "data", subject: null, text: "Analyzing data" };
  }
  if (tool.connectionId && label) return { kind: "connector", subject: label, text: `Using ${label}` };
  return null;
}

/** Lines that say what the work is for: they stay while the run moves between tools (§10). */
const STICKY: ReadonlySet<string> = new Set(["task", "routine", "mission"]);

/**
 * The lines a run may show, from facts everyone in the workspace may see (§8): its task, mission or routine,
 * where it answers (a public channel by name; anything else is "a private conversation"), and what its tools do.
 * Never a private channel's name, a person's name or a message's text.
 */
export async function statusCandidates(
  db: Database,
  run: Pick<
    AgentRunRow,
    "orgId" | "agentId" | "channelId" | "threadRootId" | "triggerMessageId" | "issueId" | "background"
  >,
  tools: ToolDefinition[],
): Promise<StatusCandidate[]> {
  const [issue, mission, trigger] = await Promise.all([
    run.issueId
      ? db
          .select({ title: issues.title, channelId: issues.channelId, restricted: issues.restricted })
          .from(issues)
          .where(and(eq(issues.orgId, run.orgId), eq(issues.id, run.issueId)))
          .then((r) => r[0] ?? null)
      : null,
    run.threadRootId && run.threadRootId !== run.triggerMessageId
      ? db
          .select({ title: missions.title, agentId: missions.agentId, channelId: missions.channelId })
          .from(missions)
          .where(and(eq(missions.orgId, run.orgId), eq(missions.threadRootId, run.threadRootId)))
          .then((r) => r[0] ?? null)
      : null,
    db
      .select({ meta: messages.meta })
      .from(messages)
      .where(and(eq(messages.orgId, run.orgId), eq(messages.id, run.triggerMessageId)))
      .then((r) => r[0] ?? null),
  ]);
  // A line is read by the whole workspace: a title or a name shows only where everyone may see it (a public channel;
  // a task with no channel is the workspace's).
  const channelIds = [run.channelId, issue?.channelId, mission?.channelId].filter((id): id is string => Boolean(id));
  const publicChannels = new Map(
    (
      await db
        .select({ id: channels.id, name: channels.name, kind: channels.kind, visibility: channels.visibility })
        .from(channels)
        .where(and(eq(channels.orgId, run.orgId), inArray(channels.id, channelIds)))
    )
      .filter((c) => c.kind === "channel" && c.visibility === "public")
      .map((c) => [c.id, c.name] as const),
  );
  const here = publicChannels.get(run.channelId);
  const out: Omit<StatusCandidate, "key">[] = [];
  if (issue && !issue.restricted && (!issue.channelId || publicChannels.has(issue.channelId))) {
    out.push({ kind: "task", subject: issue.title, text: `Working on the task "${issue.title}"` });
  }
  if (mission && mission.agentId === run.agentId && publicChannels.has(mission.channelId)) {
    out.push({ kind: "mission", subject: mission.title, text: `Working on the mission "${mission.title}"` });
  }
  const routine = (trigger?.meta as { routine?: { name?: unknown } } | undefined)?.routine;
  if (typeof routine?.name === "string" && routine.name) {
    out.push({ kind: "routine", subject: routine.name, text: `Running the routine "${routine.name}"` });
  }
  // Where it answers, only a public channel by name; a DM or a private channel says nothing worth a line.
  if (!run.background && here) {
    out.push({ kind: "channel", subject: here, text: `Answering in #${here}` });
  }
  const seen = new Set(out.map((c) => `${c.kind}:${c.subject}`));
  for (const tool of tools) {
    const act = activityOf(tool);
    if (!act || seen.has(`${act.kind}:${act.subject}`)) continue;
    seen.add(`${act.kind}:${act.subject}`);
    out.push(act);
  }
  // Jev rates each one (§8): a few, the most telling first.
  return out.slice(0, 8).map((c, i) => ({ ...c, key: `c${i}` }));
}

/**
 * Jev's questions for the start of a run (§8–9, `askRunStatus`): which line, how heavy the work is, and, for each
 * line, whether it is worth showing at all (they run in parallel, so every candidate gets its own; code reads the
 * chosen one's).
 */
export function statusQuestions(candidates: StatusCandidate[]) {
  const worth = Object.fromEntries(
    candidates.map((c) => [
      `status_worth_${c.key}`,
      {
        type: "noul" as const,
        instructions: `An AI agent of a team (\`agent\`) is starting to work on \`message\`. Next to its name, the whole team would read: "${c.text}". Is that worth showing as its status?`,
        criteria: {
          true: "Yes: it tells the team something useful about what the agent is busy with (real work that takes a while, a task, a routine, something people may want to know before interrupting).",
          false:
            "No: a quick reply, small talk or something nobody needs to know (it would only be noise next to its name).",
        },
      },
    ]),
  );
  return {
    ...worth,
    status_line: {
      type: "choice" as const,
      instructions:
        "An AI agent of a team (`agent`) is starting to work on `message`. Which line best tells the team what it is doing now? Prefer the most specific one that is true for this message.",
      criteria: {
        ...Object.fromEntries(candidates.map((c) => [c.key, c.text])),
        none: "None of these describes what it is about to do.",
      },
    },
    status_weight: {
      type: "score" as const,
      instructions: "How long and heavy is the work `message` asks of the agent (`agent`)?",
      criteria: [
        "A quick answer from what it already knows, no tools",
        "A few short steps: one search, one file or one lookup",
        "Several minutes of work: research, code, a report or many steps",
        "Long work that goes on in the background: a deploy, a big analysis, a mission",
      ],
    },
  };
}

/** What Jev picked: the line's key (null = none), P(several minutes or long work), and P(the line is worth showing). */
export interface StatusPick {
  line: string | null;
  heavy: number;
  worth: number | null;
}

/**
 * The run's line and whether it is busy, as it starts (§8–9): Jev's pick when it rated it worth showing, else no
 * line; without Jev, only what the work is for (task, mission, routine). Never replaces the agent's own words while
 * they hold.
 */
export async function startRunStatus(
  deps: { db: Database; pubsub?: PubSub },
  run: { id: string; orgId: string; agentId: string },
  candidates: StatusCandidate[],
  pick: StatusPick | null,
  now = new Date(),
): Promise<void> {
  const chosen = pick
    ? (pick.worth ?? 0) >= AGENT_LINE_WORTH
      ? candidates.find((c) => c.key === pick.line)
      : undefined
    : candidates.find((c) => STICKY.has(c.kind));
  const busy = (pick?.heavy ?? 0) >= AGENT_HEAVY_PROBABILITY;
  await writeAutoLine(deps, run, chosen ?? null, { busy, now, keepOwn: true });
  // Its run started: the presence moved even when the line stays (the agent's own words, another run's).
  await announceAgentStatus(deps.pubsub, run.orgId, run.agentId).catch(() => {});
}

/** Jev's pick for a run as it starts (§8–9): a request of its own, beside the run, never in its way. */
export async function askRunStatus(
  judge: Judge,
  input: {
    orgId: string;
    agentId: string;
    runId: string;
    agent: { name: string; role: string; instructions: string };
    message: string;
    recent: string[];
    candidates: StatusCandidate[];
  },
): Promise<StatusPick | null> {
  if (input.candidates.length === 0) return null;
  const answers = await judge.ask({
    orgId: input.orgId,
    agentId: input.agentId,
    runId: input.runId,
    kind: "agent_status",
    calibrated: true,
    state: {
      agent: { name: input.agent.name, role: input.agent.role, instructions: cutText(input.agent.instructions, 1500) },
      message: cutText(input.message, 2000),
      recent: input.recent.map((m) => cutText(m, 400)).join("\n"),
    },
    questions: statusQuestions(input.candidates),
  });
  const line = answers.status_line?.choice;
  const picked = line && line !== "none" ? line : null;
  const weight = answers.status_weight;
  const levels = weight?.probabilities ?? {};
  // P(several minutes or long work) by level; the expected level when Jev gives no distribution.
  const heavy =
    "2" in levels || "3" in levels ? (levels["2"] ?? 0) + (levels["3"] ?? 0) : (weight?.score ?? 0) >= 2 ? 1 : 0;
  return { line: picked, heavy, worth: picked ? (answers[`status_worth_${picked}`]?.noul ?? null) : null };
}

/**
 * Writes an automatic line for `run`, unless it would cover what the agent or another of its runs says: the agent's
 * own words while they hold, another live run's task, mission or routine line, or another live run's line with
 * nothing to put in its place. Returns whether it wrote.
 */
async function writeAutoLine(
  deps: { db: Database; pubsub?: PubSub },
  run: { id: string; orgId: string; agentId: string },
  line: Pick<StatusCandidate, "kind" | "subject"> | null,
  options: { busy?: boolean; now: Date; keepOwn: boolean },
) {
  // The agent's own words hold: their end hasn't come, or the run that wrote them is still on.
  const liveRun = sql`exists (select 1 from ${agentRuns} where ${agentRuns.id} = ${agents.statusRunId} and ${agentRuns.status} in ('queued', 'running', 'waiting_approval', 'waiting_input'))`;
  const own = sql`${agents.statusSource} = 'self' and (${agents.statusUntil} > ${options.now.toISOString()}::timestamptz or ${liveRun})`;
  // Another of its runs, still on, says what its work is for (or this one has nothing better to say).
  const another = sql`${agents.statusRunId} is not null and ${agents.statusRunId} <> ${run.id} and ${liveRun}`;
  const covers = line ? sql`${another} and ${agents.statusKind} in ('task', 'mission', 'routine')` : another;
  const [row] = await deps.db
    .update(agents)
    .set({
      statusSource: line ? "auto" : null,
      statusKind: line?.kind ?? null,
      statusSubject: line?.subject ?? null,
      statusText: null,
      statusEmoji: null,
      statusUntil: null,
      statusRunId: run.id,
      statusAt: options.now,
      ...(options.busy !== undefined ? { statusBusy: options.busy } : {}),
    })
    .where(
      and(
        eq(agents.orgId, run.orgId),
        eq(agents.id, run.agentId),
        ...(options.keepOwn ? [sql`not coalesce((${own}), false)`] : []),
        sql`not coalesce((${covers}), false)`,
      ),
    )
    .returning({ id: agents.id });
  return Boolean(row);
}

/**
 * A run used `tool` (§10): the automatic line follows what it does now (code only, at most every 30 s; a task,
 * mission or routine line stays), and the agent's own line is checked against the step with Jev when the kind of
 * work changes (under 0.3, the automatic line takes its place). Best effort: never fails the call.
 */
export async function followWork(
  deps: { db: Database; pubsub?: PubSub; judge?: Judge | null },
  ctx: Pick<ToolContext, "orgId" | "agentId" | "runId">,
  tool: Pick<ToolDefinition, "name" | "scope" | "connectionId" | "connectorLabel">,
  now = new Date(),
): Promise<void> {
  if (!ctx.runId) return;
  const act = activityOf(tool);
  if (!act) return;
  const [[a], [run]] = await Promise.all([
    deps.db
      .select({
        source: agents.statusSource,
        kind: agents.statusKind,
        subject: agents.statusSubject,
        text: agents.statusText,
        runId: agents.statusRunId,
        at: agents.statusAt,
        until: agents.statusUntil,
        busy: agents.statusBusy,
      })
      .from(agents)
      .where(and(eq(agents.orgId, ctx.orgId), eq(agents.id, ctx.agentId))),
    deps.db
      .select({ startedAt: agentRuns.startedAt, background: agentRuns.background })
      .from(agentRuns)
      .where(and(eq(agentRuns.orgId, ctx.orgId), eq(agentRuns.id, ctx.runId))),
  ]);
  if (!a) return;
  const target = { id: ctx.runId, orgId: ctx.orgId, agentId: ctx.agentId };
  if (a.source === "self") {
    // Another run's own words, or a line with its own end: the agent chose them, leave them.
    if (a.runId !== ctx.runId || a.until || a.kind === act.kind) return;
    // For an own line, `status_kind` remembers the last kind of work it was checked against.
    await deps.db
      .update(agents)
      .set({ statusKind: act.kind })
      .where(and(eq(agents.orgId, ctx.orgId), eq(agents.id, ctx.agentId)));
    if (!deps.judge || !a.text) return;
    const still = await stillFits(deps.judge, ctx, a.text, act.text).catch(() => null);
    const stale = still !== null && still < AGENT_LINE_STALE_BELOW;
    if (stale && (await writeAutoLine(deps, target, act, { now, keepOwn: false }))) {
      await announceAgentStatus(deps.pubsub, ctx.orgId, ctx.agentId).catch(() => {});
    }
    return;
  }
  const mine = a.runId === ctx.runId;
  // Only real work earns a line (§8): rated heavy at the start, a routine, or going for a while; a quick reply
  // that opens a page says nothing.
  const heavy =
    (mine && a.busy) ||
    run?.background === true ||
    (run?.startedAt != null && now.getTime() - run.startedAt.getTime() >= AGENT_HEAVY_AFTER_MS);
  if (!heavy) return;
  if (mine && a.kind && STICKY.has(a.kind)) return;
  if (mine && a.kind === act.kind && a.subject === act.subject) return;
  if (a.at && now.getTime() - a.at.getTime() < AGENT_LINE_EVERY_MS) return;
  if (await writeAutoLine(deps, target, act, { now, keepOwn: true })) {
    await announceAgentStatus(deps.pubsub, ctx.orgId, ctx.agentId).catch(() => {});
  }
}

/** Jev: does the agent's own line still describe the step it is on? (P of yes; calibrated, so Jev only.) */
async function stillFits(
  judge: Judge,
  ctx: Pick<ToolContext, "orgId" | "agentId" | "runId">,
  line: string,
  step: string,
) {
  const answers = await judge.ask({
    orgId: ctx.orgId,
    agentId: ctx.agentId,
    runId: ctx.runId,
    kind: "status_fits",
    calibrated: true,
    state: { status_line: line, current_step: step },
    questions: {
      fits: {
        type: "noul",
        instructions:
          "An AI agent shows `status_line` to its team as what it is doing. It is now on `current_step`. Does the line still describe its work?",
        criteria: {
          true: "Yes: the step is part of what the line says (or the line is general enough to cover it).",
          false: "No: the line is about something else now, and the team would be misled.",
        },
      },
    },
  });
  return answers.fits?.noul ?? null;
}

export const SET_STATUS_TOOL = "set_status";

/**
 * The built-in `set_status`: the agent says what it is doing ("Revisando o PR #12"), shown next to its
 * name everywhere, and may ask not to be interrupted (`busy`). It clears when the run ends, or at
 * `minutes` from now. Every agent has it; it changes nothing but its own line. Optional: without it, the
 * run gets a line picked for it (ADR 0084 §8).
 */
export function createSetStatusToolSource(deps: { pubsub?: PubSub } = {}): ToolSource {
  const tool: ToolDefinition = {
    name: SET_STATUS_TOOL,
    description:
      "Show the team what you are doing, next to your name, in your own words: a short line in the language of the conversation (e.g. 'Revisando o PR #12'). A line is already picked for you from your task; use this only when your own words say it better, or to stay busy. Set `busy` when the work is heavy and you'd rather not be interrupted. It clears when you finish; `minutes` keeps it at least that long, even after you finish (up to a day). An empty `text` clears it now.",
    scope: "",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", maxLength: AGENT_STATUS_TEXT_MAX },
        emoji: { type: "string", maxLength: 16, description: "One emoji, optional." },
        busy: { type: "boolean", description: "Heavy work: people see you as busy." },
        minutes: {
          type: "integer",
          minimum: 1,
          maximum: AGENT_STATUS_MAX_MS / 60_000,
          description: "Keep it at least this long from now, even after you finish; omit to clear it when you finish.",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
    describe: (input) => ({ title: "Set status", detail: String(input.text ?? "") }),
    async execute(input, ctx) {
      const text = String(input.text ?? "")
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, AGENT_STATUS_TEXT_MAX);
      const emoji = typeof input.emoji === "string" && input.emoji.trim() ? input.emoji.trim().slice(0, 16) : null;
      const minutes = typeof input.minutes === "number" ? Math.min(input.minutes, AGENT_STATUS_MAX_MS / 60_000) : null;
      const now = new Date();
      await ctx.db
        .update(agents)
        .set(
          text
            ? {
                statusSource: "self",
                statusText: text,
                statusEmoji: emoji,
                statusBusy: input.busy === true,
                statusRunId: ctx.runId || null,
                statusUntil: minutes ? new Date(now.getTime() + minutes * 60_000) : null,
                statusKind: null,
                statusSubject: null,
                statusAt: now,
              }
            : {
                statusSource: null,
                statusText: null,
                statusEmoji: null,
                statusBusy: false,
                statusRunId: null,
                statusUntil: null,
                statusKind: null,
                statusSubject: null,
                statusAt: now,
              },
        )
        .where(and(eq(agents.orgId, ctx.orgId), eq(agents.id, ctx.agentId)));
      await announceAgentStatus(deps.pubsub, ctx.orgId, ctx.agentId);
      return { content: text ? "Status set." : "Status cleared." };
    },
  };
  // A personal workspace (ADR 0159): the person sees the line, not a team.
  return {
    name: "status",
    tools: async (ctx) =>
      inWorkspaceWords(ctx.db, ctx.orgId, [tool], {
        [SET_STATUS_TOOL]: tool.description.replace(
          "Show the team what you are doing",
          "Show the person what you are doing",
        ),
      }),
  };
}

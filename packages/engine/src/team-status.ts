import { and, type Database, eq, inArray, isNull, rowsOf, schema, sql } from "@agenteschat/db";
import { lineInEnglish, loadAgentStatuses } from "./agent-status";
import { readerOfRun } from "./agents-dm-reads";
import { listApprovals } from "./approvals";
import { seesAgentDetails } from "./audience";
import { publicChannelIds, readsOrMayJoin } from "./channels";
import { proposalsWaitingFor } from "./context/proposals";
import { listIssues, nameableIn } from "./issues";
import { oneLine } from "./mail/text";
import { appPageLink } from "./message-links";
import { getMembership } from "./organizations";
import { personBehindCall } from "./requester";
import { isRightHand, readsAlone, rightHandReader } from "./right-hand";
import { loadTeam } from "./team";
import type { ToolDefinition, ToolSource } from "./tools/types";
import { cleanOutside } from "./untrusted";
import { liveWorksByAgent } from "./works";
import { isPersonalWorkspace } from "./workspace-mode";

const { agentQuestions, agentRuns, agents, channels } = schema;

export const TEAM_STATUS_TOOL = "team_status";

/** "Lately": what the report looks back on. */
const LATELY_MS = 24 * 3_600_000;
/** An agent's task that hasn't moved for this long is stuck. */
const STUCK_MS = 4 * 3_600_000;
const TEAM_MAX = 40;
const TASKS_LISTED = 12;
const TITLE_CHARS = 100;

/**
 * Titles and lines as plain text, never in the `<external_data>` envelope: "what's going on" must not mark the run as
 * outside (`readsOutside`), or what it hands on next is treated as outside too. With no angle brackets they can't
 * open one, and `read_conversation` keeps its mark for when the person asks for detail.
 */
const clean = (text: string) => oneLine(cleanOutside(text).replace(/[<>]/g, " "), TITLE_CHARS);

/**
 * A supervisor's view (ADR 0148 addendum): its reports only, and their tasks only. In a conversation others read too
 * (`shared`), only places anyone may read and tasks this conversation may name: the person's own reach stays out of a
 * reply others read, as the right hand keeps it to their DM.
 */
export interface SupervisorScope {
  agentIds: ReadonlySet<string>;
  channelId: string;
  shared: boolean;
}

/**
 * What the team is doing, for this person, from stored data with no model call (ADR 0137 §13): only agents they see
 * (the rest a count), and work in a place they can't read says so, with no subject. `only`: a supervisor's reports,
 * still as this person sees them.
 */
export async function teamStatus(
  db: Database,
  orgId: string,
  personId: string,
  now = new Date(),
  only?: SupervisorScope,
) {
  const membership = await getMembership(db, personId, orgId);
  const team = (
    await db
      .select()
      .from(agents)
      .where(and(eq(agents.orgId, orgId), isNull(agents.archivedAt), isNull(agents.builtin)))
      .orderBy(agents.createdAt)
  ).filter((a) => !only || only.agentIds.has(a.id));
  const visible = team.filter((a) => seesAgentDetails(a, personId, membership));
  const seen = visible.slice(0, TEAM_MAX);
  const ids = seen.map((a) => a.id);
  const since = new Date(now.getTime() - LATELY_MS).toISOString();
  const [statuses, works, runsNow, ended, allTasks, approvals, proposals, questions] = await Promise.all([
    loadAgentStatuses(db, orgId, now, ids),
    liveWorksByAgent(db, orgId, ids),
    ids.length
      ? db
          .select({ id: agentRuns.id, agentId: agentRuns.agentId, channelId: agentRuns.channelId })
          .from(agentRuns)
          .where(
            and(
              eq(agentRuns.orgId, orgId),
              inArray(agentRuns.agentId, ids),
              inArray(agentRuns.status, ["queued", "running", "waiting_approval", "waiting_input"]),
            ),
          )
      : [],
    ids.length
      ? rowsOf<{ agent_id: string; channel_id: string; done: number | string; failed: number | string }>(
          await db.execute(sql`select r.agent_id, r.channel_id, count(*) filter (where r.status = 'done') as done,
              count(*) filter (where r.status = 'failed') as failed from agent_runs r
            where r.org_id = ${orgId}::uuid and r.created_at >= ${since}::timestamptz
              and r.agent_id = any(${`{${ids.join(",")}}`}::uuid[]) and r.status in ('done', 'failed')
            group by r.agent_id, r.channel_id`),
        )
      : [],
    listIssues(db, { type: "person", userId: personId }, orgId, { limit: 200 }),
    only ? [] : listApprovals(db, personId, orgId, { status: "pending", limit: 200 }),
    only ? 0 : proposalsWaitingFor(db, personId, orgId),
    ids.length && !only
      ? db
          .select({ runId: agentQuestions.runId })
          .from(agentQuestions)
          .where(
            and(
              eq(agentQuestions.orgId, orgId),
              inArray(agentQuestions.agentId, ids),
              eq(agentQuestions.status, "open"),
            ),
          )
      : [],
  ]);
  const reportsTask = (t: (typeof allTasks)[number]) =>
    t.assignee?.type === "agent" && !!only?.agentIds.has(t.assignee.id);
  let tasks = only ? allTasks.filter(reportsTask) : allTasks;
  if (only?.shared) {
    const named = await Promise.all(tasks.map((t) => nameableIn(db, only.channelId, t)));
    tasks = tasks.filter((_, i) => named[i]);
  }
  const places = [
    ...runsNow.map((r) => r.channelId),
    ...[...works.values()].flat().map((w) => w.channelId),
    ...ended.map((r) => r.channel_id),
  ];
  let reads = await readsOrMayJoin(db, orgId, personId, places);
  if (only?.shared) {
    const open = await publicChannelIds(db, orgId, places);
    reads = new Set([...reads].filter((id) => open.has(id) || id === only.channelId));
  }
  const forThem = async (runIds: (string | null)[]) => {
    const ids = [...new Set(runIds.filter((id): id is string => !!id))];
    const readers = await Promise.all(ids.map((id) => readerOfRun(db, orgId, id)));
    return new Set(ids.filter((_, i) => readers[i] === personId));
  };
  // What they handed on runs in the agents' DM, which no person reads: it is still theirs to hear about, not others'.
  const theirs = await forThem(
    only?.shared
      ? []
      : [...runsNow.map((r) => ({ runId: r.id, channelId: r.channelId })), ...[...works.values()].flat()]
          .filter((r) => !reads.has(r.channelId))
          .map((r) => r.runId),
  );
  const shows = (place: { channelId: string; runId: string | null }) =>
    reads.has(place.channelId) || (!!place.runId && theirs.has(place.runId));
  const named = reads.size
    ? await db
        .select({ id: channels.id, name: channels.name, kind: channels.kind })
        .from(channels)
        .where(and(eq(channels.orgId, orgId), inArray(channels.id, [...reads])))
    : [];
  const where = (id: string) => {
    const c = named.find((n) => n.id === id);
    return c?.kind === "channel" ? ` in #${c.name}` : "";
  };
  const handle = new Map(seen.map((a) => [a.id, a.handle]));
  const statusOf = new Map(statuses.map((s) => [s.agentId, s]));

  const working: string[] = [];
  const quiet: string[] = [];
  for (const a of seen) {
    const status = statusOf.get(a.id);
    const line = status?.status ?? null;
    const mine = works.get(a.id) ?? [];
    const here = [...runsNow.filter((r) => r.agentId === a.id).map((r) => ({ ...r, runId: r.id })), ...mine];
    const unseen = here.some((p) => !shows(p));
    const shown = mine.find(shows);
    const plain = line && !line.text && !line.subject && !line.second;
    if (shown) {
      const link = shown.issue ? ` ${appPageLink(orgId, `/issues/${shown.issue.number}`)}` : "";
      working.push(`- @${a.handle}: on "${clean(shown.title)}"${where(shown.channelId)}${link}`);
    } else if (unseen && !plain) working.push(`- @${a.handle}: busy with something this person can't see`);
    else if (line) working.push(`- @${a.handle}: ${clean(lineInEnglish(line) ?? "working")}`);
    else if (status?.presence === "busy") working.push(`- @${a.handle}: working`);
    else quiet.push(`@${a.handle}`);
  }

  const owner = (t: (typeof tasks)[number]) =>
    t.assignee?.type === "agent" ? ` (@${handle.get(t.assignee.id) ?? "an agent"})` : "";
  const task = (t: (typeof tasks)[number]) =>
    `- #${t.number} ${clean(t.title)}${owner(t)} ${appPageLink(orgId, `/issues/${t.number}`)}`;
  const open = tasks.filter((t) => ["todo", "in_progress", "in_review"].includes(t.status));
  const moved = (t: (typeof tasks)[number]) => new Date(t.updatedAt).getTime();
  const stuck = open.filter(
    (t) => t.assignee?.type === "agent" && t.status !== "todo" && now.getTime() - moved(t) > STUCK_MS,
  );
  const done = tasks.filter((t) => t.status === "done" && now.getTime() - moved(t) < LATELY_MS);

  const counts = (key: "done" | "failed") =>
    ended
      .filter((r) => Number(r[key]) > 0)
      .map((r) => {
        const seenHere = reads.has(r.channel_id);
        return `- @${handle.get(r.agent_id)}: ${r[key]}${seenHere ? where(r.channel_id) : " somewhere this person can't see"}`;
      });
  const waiting = approvals.filter((a) => a.canDecide);
  const asked = await forThem(questions.map((q) => q.runId));
  const needs = [
    waiting.length ? `- ${waiting.length} approvals: offer_approvals shows them` : "",
    proposals ? `- ${proposals} proposed changes on Aprovações` : "",
    asked.size ? `- ${asked.size} questions from agents, unanswered` : "",
  ].filter(Boolean);
  const hidden = team.length - visible.length;

  const section = (title: string, lines: string[]) => (lines.length ? `${title}\n${lines.join("\n")}` : "");
  return [
    "Tell it in one message with three short parts, in the person's language: done, in progress, needs you. Each line starts with the agent's name and links to the work. Leave out what has nothing.",
    section("Working now:", working),
    quiet.length ? `Quiet: ${quiet.join(", ")}.` : "",
    section(`Open tasks (${open.length}):`, open.slice(0, TASKS_LISTED).map(task)),
    section("Stuck for hours:", stuck.slice(0, TASKS_LISTED).map(task)),
    section("Tasks done today:", done.slice(0, TASKS_LISTED).map(task)),
    section("Runs finished today:", counts("done")),
    section("Runs that failed today:", counts("failed")),
    section("Waiting for this person:", needs),
    visible.length > seen.length ? `(${visible.length - seen.length} more agents not listed.)` : "",
    hidden > 0 ? `(${hidden} more agent${hidden > 1 ? "s" : ""} this person can't see.)` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The agents under `supervisorId`, all the way down its line (ADR 0148 addendum). */
export function reportsUnder(team: readonly { id: string; reportsToAgentId: string | null }[], supervisorId: string) {
  const out = new Set<string>();
  let level = [supervisorId];
  while (level.length > 0) {
    level = team
      .filter((a) => a.reportsToAgentId && level.includes(a.reportsToAgentId) && !out.has(a.id))
      .map((a) => a.id);
    for (const id of level) out.add(id);
  }
  return out;
}

/**
 * `team_status` as a personal workspace's right hand reads it (ADR 0159): its description, and its title in the audit
 * (the call's own words, as every other call's), speak of the person's agents instead of a team.
 */
const TEAM_STATUS_PERSONAL = {
  description:
    "What this person's agents are doing now: each agent's work, open and stuck tasks, what finished or failed today, what waits for them.",
  title: "Check on your agents",
};

/**
 * `team_status`: the tool of "what's going on". The right hand's, in the core group so it is there on the first turn
 * of any brain, and only in the person's own DM with it: in a channel, others read the reply. A supervisor's (an agent
 * others report to) covers its reports, as the person behind the run sees them; with nobody behind it, none.
 */
export function createTeamStatusToolSource(): ToolSource {
  const tool: ToolDefinition = {
    name: TEAM_STATUS_TOOL,
    description:
      "What the team is doing now, for this person: each agent's work, open and stuck tasks, what finished or failed today, what waits for them.",
    scope: "",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    describe: () => ({ title: "Check on the team" }),
    async execute(_input, ctx) {
      const person = await rightHandReader(ctx);
      if (!person) return { content: "Only in your private conversation with a person.", isError: true };
      return { content: await teamStatus(ctx.db, ctx.orgId, person) };
    },
  };
  const supervisorTool: ToolDefinition = {
    ...tool,
    description:
      "What the agents who report to you are doing now, as the person you are helping sees it: each one's work, open and stuck tasks, what finished or failed today.",
    async execute(_input, ctx) {
      const person = await personBehindCall(ctx);
      if (!person)
        return {
          content: "Only when a person asked: with nobody behind this run, ask your reports with ask_agent.",
          isError: true,
        };
      const team = await loadTeam(ctx.db as Database, ctx.orgId);
      const scope = {
        agentIds: reportsUnder(team, ctx.agentId),
        channelId: ctx.channelId,
        shared: !(await readsAlone(ctx.db, ctx.channelId, person)),
      };
      return { content: await teamStatus(ctx.db, ctx.orgId, person, new Date(), scope) };
    },
  };
  const personalTool: ToolDefinition = {
    ...tool,
    description: TEAM_STATUS_PERSONAL.description,
    describe: () => ({ title: TEAM_STATUS_PERSONAL.title }),
  };
  return {
    name: "team-status",
    tools: async (ctx) => {
      const [row] = await ctx.db.select({ builtin: agents.builtin }).from(agents).where(eq(agents.id, ctx.agentId));
      // A personal workspace (ADR 0159): the person's agents, not a team. Only words: a read that fails keeps a team's.
      if (isRightHand(row)) {
        return [(await isPersonalWorkspace(ctx.db, ctx.orgId).catch(() => false)) ? personalTool : tool];
      }
      const team = await loadTeam(ctx.db as Database, ctx.orgId);
      return team.some((a) => a.reportsToAgentId === ctx.agentId) ? [supervisorTool] : [];
    },
  };
}

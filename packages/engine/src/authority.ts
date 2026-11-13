import { and, type Executor, eq, gte, inArray, schema, sql } from "@agenteschat/db";
import { caches, cachesEnabled } from "./cache";
import { getMembership } from "./organizations";
import { type RoutineBrief, routineBriefOf } from "./routine-brief";

const { agentRuns, messages, routineRuns } = schema;

/**
 * Who is behind a run (ADR 0053, addendum of 2026-10-31): the one gate every "who asked?" check goes
 * through, on every brain. Whoever woke it, a run works within the agent's own permissions: this says on
 * whose behalf, and who hears about its approvals and pauses.
 *
 * - `person`: a person asked, directly or through a chain of agents (an agent's message counts for the
 *   person behind the run that wrote it), or work came back to a run of theirs (an answer, a note's
 *   reply, the end of a wait or of a background task, a decision on a folder or on a proposed agent, a
 *   follow-up), or they wrote on GitHub with their linked account, or a background work ended after taking on what
 *   they passed on to it (a `github_event` or `work_follow_up` notice's server-set `refs.personId`). Tools act on
 *   their behalf, within their permissions and the agent's scopes.
 * - `routine`: a routine's background run. Nobody is behind it: its creator set it up and stays
 *   accountable (notifications, approvals), but the run never acts as them. What it may do comes only
 *   from the agent's own permissions, like any run (ADR 0109), within a routine's bounds (`run-policy.ts`).
 * - `unattended`: no person at the root: the conversation run a routine's report woke, an agent's own
 *   message, work either started. It works as the agent itself, with the tools a person's run has (one a
 *   routine's report or work woke keeps within that routine's `brief`: see `run-policy.ts`); what
 *   needs a person's request (their channels, their reminders) is refused, and its approvals and pauses
 *   go to the agent's owner. A person writing into such a run (`steeredBy`) puts that person behind it
 *   from then on.
 *
 * Message metadata alone never proves a person: only authorship and server-set links (a message's run, a
 * notice's run, the run on a task's or a folder request's line) are followed, within the workspace.
 */
export type RunAuthority =
  | { kind: "person"; personId: string }
  | { kind: "routine"; personId: null; brief: RoutineBrief | null }
  /** `brief`: the routine whose report or work woke it (reasons `routine_report` and `routine`), whose bounds it keeps. */
  | { kind: "unattended"; personId: null; reason: UnattendedReason; brief?: RoutineBrief | null };

/**
 * Why nobody is behind an unattended run: a routine's report woke it (`routine_report`), its chain roots in a
 * routine's background run (`routine`: the end of a task one started), or an agent's own work (`agent`).
 */
export type UnattendedReason = "routine_report" | "routine" | "agent";

/** What a message's chain roots in. */
export type MessageRoot =
  | { kind: "person"; personId: string }
  /** `briefMessageId`: the routine's brief the chain started from, when known. */
  | { kind: "routine"; briefMessageId: string | null }
  /** `backgroundRunId`: the routine's run that handed it off (the notice's `refs.runId`). */
  | { kind: "routine_report"; backgroundRunId: string | null }
  | { kind: "agent" };

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * How many links (message → its run → that run's trigger) a chain may have before it counts as nobody's: far past
 * what agents do on their own in a stretch (ADR 0089), so a long collaboration stays the person's.
 */
export const MAX_AUTHORITY_CHAIN = 1000;

type MessageLink = {
  authorType: string;
  authorUserId: string | null;
  agentRunId: string | null;
  meta: Record<string, unknown>;
};

const noticeOf = (meta: Record<string, unknown>) =>
  meta.notice as { kind?: unknown; refs?: Record<string, unknown> } | undefined;

/**
 * The run a line brings work back to, as the server wrote it: a notice's `refs.runId` (an answer, a note's
 * reply, a wait's result, a follow-up, a decision on a proposed agent), or the run that started the task
 * (`machineTask`) or asked for the folder (`machineAccess`) the line ends. Null when it names none.
 */
function returnsTo(meta: Record<string, unknown>): string | null {
  for (const link of [noticeOf(meta)?.refs, meta.machineTask, meta.machineAccess]) {
    const runId = (link as { runId?: unknown } | undefined)?.runId;
    if (typeof runId === "string" && UUID.test(runId)) return runId;
  }
  return null;
}

/**
 * What a message's chain roots in: a person (its author, or the person behind the run that wrote it or
 * that the work comes back to), a routine (its brief, or a run that is a routine's background work), a
 * routine's report, or nothing (an agent's own message with no run, a broken or too long chain).
 *
 * Each message's root is remembered (`caches.messageRoots`): a message's links never change, so the walk
 * stops at the first link it already knows, and a long chain costs what its newest link does.
 */
export async function messageRoot(db: Executor, orgId: string, messageId: string): Promise<MessageRoot> {
  if (!cachesEnabled()) return (await walkAndRemember(db, orgId, messageId)) ?? { kind: "agent" };
  // A run's parallel reads ask for the same root at once: one walk answers them all.
  const key = `${orgId}:${messageId}`;
  let walk = walking.get(key);
  if (!walk) {
    walk = walkAndRemember(db, orgId, messageId).finally(() => walking.delete(key));
    walking.set(key, walk);
  }
  return (await walk) ?? { kind: "agent" };
}

const walking = new Map<string, Promise<MessageRoot | null>>();

async function walkAndRemember(db: Executor, orgId: string, messageId: string): Promise<MessageRoot | null> {
  const walked: string[] = [];
  const found = await walkRoot(db, orgId, messageId, walked);
  if (found)
    for (const id of walked) await caches.messageRoots.getOrLoad(`${orgId}:${id}`, () => Promise.resolve(found));
  return found;
}

/** The walk, collecting the ids it passed in `walked`; null when the chain is broken or too long (never remembered). */
async function walkRoot(db: Executor, orgId: string, messageId: string, walked: string[]): Promise<MessageRoot | null> {
  let id = messageId;
  for (let depth = 0; depth <= MAX_AUTHORITY_CHAIN; depth++) {
    const known = caches.messageRoots.get(`${orgId}:${id}`) as MessageRoot | undefined;
    if (known) return known;
    walked.push(id);
    const [m] = (await db
      .select({
        authorType: messages.authorType,
        authorUserId: messages.authorUserId,
        agentRunId: messages.agentRunId,
        meta: messages.meta,
      })
      .from(messages)
      .where(and(eq(messages.orgId, orgId), eq(messages.id, id)))) as MessageLink[];
    if (!m) return null;
    if (m.authorType === "person") {
      // A routine's brief is written by its creator, but nobody is behind the work it starts.
      if (routineBriefOf(m.meta) || m.meta.background === true) return { kind: "routine", briefMessageId: id };
      return m.authorUserId ? { kind: "person", personId: m.authorUserId } : { kind: "agent" };
    }
    const notice = noticeOf(m.meta);
    if (notice?.kind === "routine_handoff") {
      const runId = notice.refs?.runId;
      return { kind: "routine_report", backgroundRunId: typeof runId === "string" ? runId : null };
    }
    // What happened on GitHub (`git/github-events.ts`): the member whose linked account wrote it, or who asked the
    // agent to answer it; nobody for anyone else. What a person passed on to a work that ended (`followUpWork`): that
    // person, not who asked for the work.
    if (notice?.kind === "github_event" || notice?.kind === "work_follow_up") {
      const personId = notice.refs?.personId;
      return typeof personId === "string" && personId ? { kind: "person", personId } : { kind: "agent" };
    }
    // Work that comes back to the agent continues the run it came back to, for whoever is behind that run; a
    // routine's own message roots in the routine's run that posted it.
    const runId = returnsTo(m.meta) ?? m.agentRunId ?? (await routinePostRun(db, { orgId, ...m }));
    if (!runId) return { kind: "agent" };
    const [run] = await db
      .select({ triggerMessageId: agentRuns.triggerMessageId, background: agentRuns.background })
      .from(agentRuns)
      .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.id, runId)));
    if (!run) return null;
    if (run.background) return { kind: "routine", briefMessageId: run.triggerMessageId };
    id = run.triggerMessageId;
  }
  return null;
}

/** The routine's background run behind a routine's own message (`hand_off`, `meta.routine`, posted with no run). */
export async function routinePostRun(
  db: Executor,
  message: { orgId: string; agentRunId: string | null; meta: Record<string, unknown> },
) {
  const routine = message.meta.routine as { runId?: unknown } | undefined;
  if (message.agentRunId || message.meta.reminder || typeof routine?.runId !== "string" || !UUID.test(routine.runId))
    return null;
  const [row] = await db
    .select({ agentRunId: routineRuns.agentRunId })
    .from(routineRuns)
    .where(and(eq(routineRuns.orgId, message.orgId), eq(routineRuns.id, routine.runId)));
  return row?.agentRunId ?? null;
}

/**
 * The agents a run's chain passed through, from `runId` back to its root (the run's agent, then each agent whose
 * message or run woke the one after it), the runs themselves, and the person's message it started from, if one did. The
 * right hand never decides a card its own run is part of (ADR 0139 §2). Null when the chain is broken or too long.
 */
export async function runChain(
  db: Executor,
  orgId: string,
  runId: string,
): Promise<{ agentIds: string[]; runIds: string[]; rootMessageId: string | null } | null> {
  const seen = new Set<string>();
  const runIds: string[] = [];
  let id: string | null = runId;
  for (let depth = 0; id && depth <= MAX_AUTHORITY_CHAIN; depth++) {
    const [run] = await db
      .select({
        agentId: agentRuns.agentId,
        triggerMessageId: agentRuns.triggerMessageId,
        background: agentRuns.background,
      })
      .from(agentRuns)
      .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.id, id)));
    if (!run) return null;
    seen.add(run.agentId);
    runIds.push(id);
    if (run.background) return { agentIds: [...seen], runIds, rootMessageId: null };
    const [m] = await db
      .select({
        authorType: messages.authorType,
        authorAgentId: messages.authorAgentId,
        agentRunId: messages.agentRunId,
        meta: messages.meta,
      })
      .from(messages)
      .where(and(eq(messages.orgId, orgId), eq(messages.id, run.triggerMessageId)));
    if (!m) return null;
    if (m.authorType === "person") return { agentIds: [...seen], runIds, rootMessageId: run.triggerMessageId };
    if (m.authorAgentId) seen.add(m.authorAgentId);
    id = returnsTo(m.meta) ?? m.agentRunId ?? (await routinePostRun(db, { orgId, ...m }));
  }
  return id ? null : { agentIds: [...seen], runIds, rootMessageId: null };
}

/**
 * Whether someone else wrote into a run of the chain while it worked (`meta.steeredRunIds`): a person other than
 * `forUserId`, or an agent whose message isn't theirs. Their words reached the run outside the request it roots in.
 */
export async function steeredByOthers(db: Executor, orgId: string, forUserId: string, runIds: string[]) {
  const runs = await db
    .select({ channelId: agentRuns.channelId, createdAt: agentRuns.createdAt, triggerId: agentRuns.triggerMessageId })
    .from(agentRuns)
    .where(and(eq(agentRuns.orgId, orgId), inArray(agentRuns.id, runIds)));
  if (runs.length === 0) return false;
  const since = new Date(Math.min(...runs.map((r) => r.createdAt.getTime())));
  // Where they were asked too: a run sent on elsewhere (`moveRun`) keeps what reached it there.
  const asked = await db
    .select({ channelId: messages.channelId })
    .from(messages)
    .where(
      and(
        eq(messages.orgId, orgId),
        inArray(
          messages.id,
          runs.map((r) => r.triggerId),
        ),
      ),
    );
  const written = await db
    .select({ id: messages.id, authorType: messages.authorType, authorUserId: messages.authorUserId })
    .from(messages)
    .where(
      and(
        eq(messages.orgId, orgId),
        inArray(messages.channelId, [...new Set([...runs, ...asked].map((r) => r.channelId))]),
        gte(messages.createdAt, since),
        sql`${messages.meta} -> 'steeredRunIds' ?| ${`{${runIds.join(",")}}`}::text[]`,
      ),
    );
  for (const m of written) {
    if (m.authorType === "person") {
      if (m.authorUserId !== forUserId) return true;
      continue;
    }
    const root = await messageRoot(db, orgId, m.id);
    if (root.kind !== "person" || root.personId !== forUserId) return true;
  }
  return false;
}

/** The person behind a message (see `messageRoot`), or null. */
export async function personOfMessage(db: Executor, orgId: string, messageId: string): Promise<string | null> {
  const root = await messageRoot(db, orgId, messageId);
  return root.kind === "person" ? root.personId : null;
}

/**
 * The person an agent's run works for, while they still belong to the workspace (a run stays its message's author's for
 * good): an agent working for someone reaches what they reach (ADR 0151).
 */
export async function runPerson(db: Executor, orgId: string, runId: string | undefined) {
  const person = runId ? (await runAuthorityById(db, orgId, runId)).personId : null;
  return person && (await getMembership(db, person, orgId)) ? person : null;
}

/** The run fields the gate reads. */
export type AuthorityRun = {
  id: string;
  orgId: string;
  triggerMessageId: string;
  background: boolean;
  transcript?: Record<string, unknown> | null;
};

/** The person who wrote into an unattended run while it worked (`Transcript.steeredBy`), if any. */
export const steeredByOf = (transcript: Record<string, unknown> | null | undefined) =>
  typeof transcript?.steeredBy === "string" ? transcript.steeredBy : null;

/** Who is behind a run (see `RunAuthority`). */
export async function runAuthority(db: Executor, run: AuthorityRun): Promise<RunAuthority> {
  if (run.background) {
    const [trigger] = await db
      .select({ meta: messages.meta })
      .from(messages)
      .where(and(eq(messages.orgId, run.orgId), eq(messages.id, run.triggerMessageId)));
    return { kind: "routine", personId: null, brief: routineBriefOf(trigger?.meta) };
  }
  const root = await messageRoot(db, run.orgId, run.triggerMessageId);
  if (root.kind === "person") return { kind: "person", personId: root.personId };
  const steeredBy = steeredByOf(run.transcript);
  if (steeredBy) return { kind: "person", personId: steeredBy };
  if (root.kind === "agent") return { kind: "unattended", personId: null, reason: "agent" };
  return { kind: "unattended", personId: null, reason: root.kind, brief: await feedingBrief(db, run.orgId, root) };
}

/** The brief of the routine a chain roots in (its own, or the one whose run handed off the report); null when gone. */
export async function feedingBrief(
  db: Executor,
  orgId: string,
  root: Extract<MessageRoot, { kind: "routine" | "routine_report" }>,
): Promise<RoutineBrief | null> {
  if (root.kind === "routine") {
    if (!root.briefMessageId) return null;
    const [m] = await db
      .select({ meta: messages.meta })
      .from(messages)
      .where(and(eq(messages.orgId, orgId), eq(messages.id, root.briefMessageId)));
    return routineBriefOf(m?.meta);
  }
  if (!root.backgroundRunId || !UUID.test(root.backgroundRunId)) return null;
  const [row] = await db
    .select({ meta: messages.meta })
    .from(agentRuns)
    .innerJoin(messages, and(eq(messages.orgId, agentRuns.orgId), eq(messages.id, agentRuns.triggerMessageId)))
    .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.id, root.backgroundRunId), eq(agentRuns.background, true)));
  return routineBriefOf(row?.meta);
}

/**
 * Whether what a routine read feeds this run: a routine's own run, or a run nobody is behind that its report or its
 * work woke. Such text may come from outside (inbound mail, a webhook, the web) through the routine, so the run
 * never sends a credential, its writes to connected apps and its mail sends always ask a person (ADR 0038, 0053 §3).
 */
export const fedByRoutine = (authority: RunAuthority | null): boolean =>
  authority?.kind === "routine" || (authority?.kind === "unattended" && authority.reason !== "agent");

/** Who is behind a run, by its id (the tool context's `runId`); unattended when the run is gone. */
export async function runAuthorityById(db: Executor, orgId: string, runId: string): Promise<RunAuthority> {
  if (!UUID.test(runId)) return { kind: "unattended", personId: null, reason: "agent" };
  const [run] = await db
    .select({
      id: agentRuns.id,
      orgId: agentRuns.orgId,
      triggerMessageId: agentRuns.triggerMessageId,
      background: agentRuns.background,
      transcript: agentRuns.transcript,
    })
    .from(agentRuns)
    .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.id, runId)));
  if (!run) return { kind: "unattended", personId: null, reason: "agent" };
  return runAuthority(db, run);
}

/**
 * Who answers for a run's requests (approvals, questions, failures): the person behind it, else the
 * routine's creator. Null for an unattended run: the caller falls back to the agent's owner.
 */
export const accountablePerson = (authority: RunAuthority): string | null =>
  authority.kind === "person"
    ? authority.personId
    : authority.kind === "routine"
      ? (authority.brief?.creatorUserId ?? null)
      : null;

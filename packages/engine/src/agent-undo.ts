import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, desc, eq, gt, gte, isNull, ne, or, schema, sql } from "@agenteschat/db";
import { actionsFor, actionView, describeAction, publishMessageActions, UNDO_WINDOW_MS } from "./agent-actions";
import { getAgentCached } from "./agents";
import { recordAudit } from "./audit";
import { caches } from "./cache";
import { addChannelMember, archiveChannel, removeChannelMember, unarchiveChannel } from "./channels";
import { ConflictError, ForbiddenError, NotFoundError } from "./errors";
import { getIssue, type IssueView, setCriterion, updateIssue, type WorkActor } from "./issues";
import { announceMessageMemories } from "./message-memories";
import { assertActiveMembership, can, getMembership } from "./organizations";
import { hookMethodsOf, routineHookKeys } from "./routine-hooks";
import { nextRoutineTime } from "./routines";
import { enqueueIndex } from "./search";
import { revertSettings } from "./settings-proposals";
import { restoreSkillSnapshot, type SkillSnapshot } from "./skill-updates";
import { writeSkillBody } from "./skills";
import { closeThread, getThread, reopenThread, updateThread } from "./threads";
import { canonicalJson } from "./tools/json-schema";
import { deleteWikiPage, getWikiPage, getWikiVersion, restoreWikiPage, updateWikiPage } from "./wiki";
import { revertWorkspaceAction } from "./workspace-actions";

const {
  agentActions,
  contextItems,
  routines,
  routineHooks,
  channels,
  channelMembers,
  issueActivity,
  issues,
  messages,
  users,
} = schema;

type Row = typeof agentActions.$inferSelect;

export interface AgentUndoDeps {
  db: Database;
  pubsub?: PubSub;
  now?: () => Date;
}

const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);

/** Someone changed the target since the agent did: undoing would overwrite their work. */
const changedSince = () =>
  new ConflictError("This changed after the agent did it. Undo it by hand.", "action.changed_since");

// ── Issues ───────────────────────────────────────────────────────────────────

/** The fields an issue change can touch (what undo restores). */
export function issueSnapshot(i: IssueView): Record<string, unknown> {
  return {
    title: i.title,
    description: i.description,
    status: i.status,
    priority: i.priority,
    assignee: i.assignee ? { type: i.assignee.type, id: i.assignee.id } : null,
    labels: i.labels,
    dueDate: i.dueDate,
    githubUrl: i.githubUrl,
    criteria: i.criteria.map((c) => ({ id: c.id, done: c.done })),
    files: i.artifacts.map((f) => f.id),
  };
}

/** Only what changed between two snapshots: `{ before, after, fields }` (empty `fields`: nothing). */
export function issueDiff(before: Record<string, unknown>, after: Record<string, unknown>) {
  const fields = Object.keys(after).filter((k) => !same(before[k], after[k]));
  type Criterion = { id: string; done: boolean };
  // Criteria: only the ones whose check changed.
  const touched = new Set(
    ((after.criteria ?? []) as Criterion[])
      .filter((c) => ((before.criteria ?? []) as Criterion[]).find((b) => b.id === c.id)?.done !== c.done)
      .map((c) => c.id),
  );
  const pick = (s: Record<string, unknown>) =>
    Object.fromEntries(
      fields.map((k) => [k, k === "criteria" ? ((s[k] ?? []) as Criterion[]).filter((c) => touched.has(c.id)) : s[k]]),
    );
  return { fields, before: pick(before), after: pick(after) };
}

/** Puts these field values back on the issue (as the person undoing), through the domain (activity, events). */
async function applyIssueFields(
  deps: AgentUndoDeps,
  userId: string,
  orgId: string,
  issueId: string,
  values: Record<string, unknown>,
) {
  const actor = { type: "person" as const, userId };
  const patch: Parameters<typeof updateIssue>[4] = {};
  if ("title" in values) patch.title = String(values.title ?? "");
  if ("description" in values) patch.description = String(values.description ?? "");
  if ("status" in values) patch.status = values.status as IssueView["status"];
  if ("priority" in values) patch.priority = values.priority as IssueView["priority"];
  if ("assignee" in values) patch.assignee = (values.assignee as WorkActor | null) ?? null;
  if ("labels" in values) patch.labels = (values.labels as string[]) ?? [];
  if ("dueDate" in values) patch.dueDate = (values.dueDate as string | null) ?? null;
  if ("githubUrl" in values) patch.githubUrl = (values.githubUrl as string | null) ?? null;
  if (Array.isArray(values.files)) {
    const want = values.files as string[];
    const have = (await getIssue(deps.db, actor, orgId, { id: issueId })).artifacts.map((f) => f.id);
    const add = want.filter((id) => !have.includes(id));
    const remove = have.filter((id) => !want.includes(id));
    if (add.length) patch.addFiles = add;
    if (remove.length) patch.removeFiles = remove;
  }
  if (Object.keys(patch).length > 0) await updateIssue(deps, actor, orgId, issueId, patch);
  if (Array.isArray(values.criteria)) {
    let current = await getIssue(deps.db, actor, orgId, { id: issueId });
    for (const c of values.criteria as { id: string; done: boolean }[]) {
      const now = current.criteria.find((x) => x.id === c.id);
      if (now && now.done !== c.done) current = await setCriterion(deps, actor, orgId, issueId, c.id, c.done);
    }
  }
}

/** Another person or agent touched the issue since `since`: its activity, or a reply in its conversation (ADR 0145). */
async function issueTouchedByOthers(db: Database, issueId: string, agentId: string, since: Date) {
  const [row] = await db
    .select({ id: issueActivity.id })
    .from(issueActivity)
    .where(
      and(
        eq(issueActivity.issueId, issueId),
        gt(issueActivity.createdAt, since),
        or(ne(issueActivity.authorType, "agent"), ne(issueActivity.authorId, agentId)),
      ),
    )
    .limit(1);
  if (row) return true;
  const [issue] = await db
    .select({ channelId: issues.conversationChannelId, rootId: issues.conversationRootId })
    .from(issues)
    .where(eq(issues.id, issueId));
  if (!issue?.channelId || !issue.rootId) return false;
  const [reply] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.channelId, issue.channelId),
        eq(messages.threadId, issue.rootId),
        gt(messages.createdAt, since),
        or(ne(messages.authorType, "agent"), isNull(messages.authorAgentId), ne(messages.authorAgentId, agentId)),
      ),
    )
    .limit(1);
  return Boolean(reply);
}

// ── Memory ───────────────────────────────────────────────────────────────────

async function memoryItem(db: Database, orgId: string, id: unknown) {
  if (typeof id !== "string") return null;
  const [row] = await db
    .select()
    .from(contextItems)
    .where(and(eq(contextItems.orgId, orgId), eq(contextItems.id, id)));
  return row ?? null;
}

const isCurrent = (i: { status: string; supersededBy: string | null } | null) =>
  i?.status === "active" && !i.supersededBy;

async function setMemory(
  deps: AgentUndoDeps,
  orgId: string,
  changes: { id: string; status: "active" | "archived"; supersededBy: string | null }[],
) {
  await deps.db.transaction(async (tx) => {
    for (const c of changes) {
      await tx
        .update(contextItems)
        .set({ status: c.status, supersededBy: c.supersededBy, updatedAt: new Date() })
        .where(and(eq(contextItems.orgId, orgId), eq(contextItems.id, c.id)));
      await enqueueIndex(tx, { orgId, kind: "context_item", sourceId: c.id });
    }
  });
  caches.contextPresence.delete(`${orgId}:`);
  caches.contextPresence.deletePrefix(`${orgId}:rules:`);
  for (const c of changes) {
    const item = await memoryItem(deps.db, orgId, c.id);
    if (item) await announceMessageMemories(deps, orgId, item).catch(() => {});
  }
}

// ── Routines ─────────────────────────────────────────────────────────────────

type RoutineRow = typeof routines.$inferSelect;
const ROUTINE_FIELDS = [
  "name",
  "prompt",
  "target",
  "triggerType",
  "phrase",
  "cron",
  "timezone",
  "description",
  "event",
  "rule",
  "active",
  "access",
  "report",
  "ownActions",
] as const;

/** The fields a routine change can touch (what undo restores). */
export function routineSnapshot(r: RoutineRow): Record<string, unknown> {
  return Object.fromEntries(ROUTINE_FIELDS.map((k) => [k, r[k]]));
}

export async function routineRow(db: Database, orgId: string, id: string) {
  const [row] = await db
    .select()
    .from(routines)
    .where(and(eq(routines.orgId, orgId), eq(routines.id, id)));
  return row ?? null;
}

async function setRoutine(db: Database, row: RoutineRow, values: Record<string, unknown>, deleted?: boolean) {
  const next = { ...row, ...values } as RoutineRow;
  const nextRunAt =
    !next.active || deleted
      ? null
      : next.triggerType === "schedule"
        ? nextRoutineTime(next, new Date())
        : row.nextRunAt;
  await db
    .update(routines)
    .set({
      ...(values as Partial<RoutineRow>),
      nextRunAt,
      ...(deleted !== undefined ? { deletedAt: deleted ? new Date() : null } : {}),
      ...(deleted ? { active: false } : {}),
      updatedAt: new Date(),
    })
    .where(eq(routines.id, row.id));
}

// ── Handlers ─────────────────────────────────────────────────────────────────

type Direction = "undo" | "redo";
/** Applies the inverse (undo) or the change again (redo); returns new bookkeeping for `state`. */
type Handler = (
  deps: AgentUndoDeps,
  action: Row,
  userId: string,
  direction: Direction,
) => Promise<Record<string, unknown> | undefined>;

const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** Every receipt on the same target (other changes of this agent, and their undo/redo). */
async function sameTarget(db: Database, a: Row) {
  return db
    .select()
    .from(agentActions)
    .where(
      and(
        eq(agentActions.orgId, a.orgId),
        eq(agentActions.targetType, a.targetType),
        eq(agentActions.targetId, a.targetId),
      ),
    );
}

/** The last moment an undo/redo flow touched this target (their changes are not "someone else's"). */
async function lastCheckpoint(db: Database, a: Row) {
  let at = a.createdAt.getTime();
  for (const r of await sameTarget(db, a)) {
    const c = obj(r.state).checkpoint;
    if (typeof c === "string") at = Math.max(at, Date.parse(c));
  }
  return new Date(at);
}

/** The page version the agent's changes and their undo/redo left (a higher one = someone else wrote). */
async function knownWikiVersion(db: Database, a: Row) {
  let v = 0;
  for (const r of await sameTarget(db, a)) {
    const known = Number(obj(r.state).version ?? obj(r.after).version ?? 0);
    if (Number.isFinite(known)) v = Math.max(v, known);
  }
  return v;
}

const handlers: Record<string, Handler> = {
  async "issue.created"(deps, a, userId, direction) {
    const actor = { type: "person" as const, userId };
    const issue = await getIssue(deps.db, actor, a.orgId, { id: a.targetId });
    const state = obj(a.state);
    if (direction === "undo") {
      const since = await lastCheckpoint(deps.db, a);
      if (issue.status === "canceled" || (await issueTouchedByOthers(deps.db, issue.id, a.agentId, since))) {
        throw changedSince();
      }
      await updateIssue(deps, actor, a.orgId, issue.id, { status: "canceled" });
      return { statusBefore: issue.status };
    }
    if (issue.status !== "canceled") throw changedSince();
    await updateIssue(deps, actor, a.orgId, issue.id, {
      status: (state.statusBefore as IssueView["status"]) ?? "todo",
    });
    return undefined;
  },

  async "issue.updated"(deps, a, userId, direction) {
    const actor = { type: "person" as const, userId };
    const issue = await getIssue(deps.db, actor, a.orgId, { id: a.targetId });
    const [from, to] = direction === "undo" ? [obj(a.after), obj(a.before)] : [obj(a.before), obj(a.after)];
    const now = issueSnapshot(issue);
    for (const k of Object.keys(from)) {
      if (k === "criteria") {
        // Only the criteria this change touched must still be as it left them.
        const wanted = from.criteria as { id: string; done: boolean }[];
        const current = now.criteria as { id: string; done: boolean }[];
        if (wanted.some((w) => current.find((c) => c.id === w.id)?.done !== w.done)) throw changedSince();
      } else if (!same(now[k], from[k])) throw changedSince();
    }
    await applyIssueFields(deps, userId, a.orgId, issue.id, to);
    return undefined;
  },

  async "memory.saved"(deps, a, _userId, direction) {
    const item = await memoryItem(deps.db, a.orgId, obj(a.after).itemId);
    const previous = await memoryItem(deps.db, a.orgId, obj(a.before).itemId);
    if (!item) throw new NotFoundError("The memory is gone", "action.target_gone");
    if (direction === "undo") {
      if (!isCurrent(item)) throw changedSince();
      if (previous && (previous.status !== "archived" || previous.supersededBy !== item.id)) throw changedSince();
      await setMemory(deps, a.orgId, [
        { id: item.id, status: "archived", supersededBy: null },
        ...(previous ? [{ id: previous.id, status: "active" as const, supersededBy: null }] : []),
      ]);
      return undefined;
    }
    if (item.status !== "archived" || item.supersededBy) throw changedSince();
    if (previous && !isCurrent(previous)) throw changedSince();
    await setMemory(deps, a.orgId, [
      ...(previous ? [{ id: previous.id, status: "archived" as const, supersededBy: item.id }] : []),
      { id: item.id, status: "active", supersededBy: null },
    ]);
    return undefined;
  },

  async "memory.forgotten"(deps, a, _userId, direction) {
    const item = await memoryItem(deps.db, a.orgId, obj(a.before).itemId);
    if (!item) throw new NotFoundError("The memory is gone", "action.target_gone");
    if (item.supersededBy) throw changedSince();
    if (direction === "undo") {
      if (item.status !== "archived") throw changedSince();
      await setMemory(deps, a.orgId, [{ id: item.id, status: "active", supersededBy: null }]);
    } else {
      if (item.status !== "active") throw changedSince();
      await setMemory(deps, a.orgId, [{ id: item.id, status: "archived", supersededBy: null }]);
    }
    return undefined;
  },

  async "routine.created"(deps, a, _userId, direction) {
    const row = await routineRow(deps.db, a.orgId, a.targetId);
    if (!row) throw new NotFoundError("The routine is gone", "action.target_gone");
    if (direction === "undo") {
      if (row.deletedAt || !same(routineSnapshot(row), a.after)) throw changedSince();
      await setRoutine(deps.db, row, {}, true);
    } else {
      if (!row.deletedAt) throw changedSince();
      await setRoutine(deps.db, row, { active: obj(a.after).active !== false }, false);
    }
    return undefined;
  },

  async "routine.deleted"(deps, a, _userId, direction) {
    const row = await routineRow(deps.db, a.orgId, a.targetId);
    if (!row) throw new NotFoundError("The routine is gone", "action.target_gone");
    if (direction === "undo") {
      if (!row.deletedAt) throw changedSince();
      await setRoutine(deps.db, row, { active: obj(a.before).active !== false }, false);
    } else {
      if (row.deletedAt) throw changedSince();
      await setRoutine(deps.db, row, {}, true);
    }
    return undefined;
  },

  async "routine.updated"(deps, a, _userId, direction) {
    const row = await routineRow(deps.db, a.orgId, a.targetId);
    if (!row || row.deletedAt) throw new NotFoundError("The routine is gone", "action.target_gone");
    const [from, to] = direction === "undo" ? [obj(a.after), obj(a.before)] : [obj(a.before), obj(a.after)];
    // The methods its webhook address answers are kept with the address, not on the routine.
    const { methods: fromMethods, ...fromRow } = from;
    const { methods: toMethods, ...toRow } = to;
    const now = routineSnapshot(row);
    if (Object.keys(fromRow).some((k) => !same(now[k], fromRow[k]))) throw changedSince();
    if (Array.isArray(toMethods)) {
      if (!same((await routineHookKeys(deps.db, [row.id])).get(row.id)?.methods, fromMethods)) throw changedSince();
      await deps.db
        .update(routineHooks)
        .set({ methods: hookMethodsOf(toMethods.map(String)), updatedAt: new Date() })
        .where(eq(routineHooks.routineId, row.id));
    }
    await setRoutine(deps.db, row, toRow);
    return undefined;
  },

  async "channel.agent_added"(deps, a, userId, direction) {
    const agentId = String(obj(a.after).agentId ?? "");
    const [member] = await deps.db
      .select({ id: channelMembers.id })
      .from(channelMembers)
      .where(and(eq(channelMembers.channelId, a.targetId), eq(channelMembers.agentId, agentId)));
    if (direction === "undo") {
      if (!member) throw changedSince();
      await removeChannelMember(deps.db, userId, a.orgId, a.targetId, { agentId }, { pubsub: deps.pubsub });
    } else {
      if (member) throw changedSince();
      await addChannelMember(
        deps.db,
        userId,
        a.orgId,
        a.targetId,
        { agentId, autoReply: obj(a.after).autoReply !== false },
        { pubsub: deps.pubsub },
      );
    }
    return undefined;
  },

  async "channel.created"(deps, a, userId, direction) {
    const [channel] = await deps.db
      .select({ createdAt: channels.createdAt, archivedAt: channels.archivedAt })
      .from(channels)
      .where(and(eq(channels.orgId, a.orgId), eq(channels.id, a.targetId)));
    if (!channel) throw new NotFoundError("The channel is gone", "action.target_gone");
    if (direction === "redo") {
      if (!channel.archivedAt) throw changedSince();
      await unarchiveChannel(deps.db, userId, a.orgId, a.targetId, { pubsub: deps.pubsub });
      return undefined;
    }
    if (channel.archivedAt) throw changedSince();
    // Someone already wrote there: archiving would hide their messages.
    const [written] = await deps.db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.orgId, a.orgId),
          eq(messages.channelId, a.targetId),
          gte(messages.createdAt, channel.createdAt),
          isNull(messages.deletedAt),
        ),
      )
      .limit(1);
    if (written) throw changedSince();
    await archiveChannel(deps.db, userId, a.orgId, a.targetId, { pubsub: deps.pubsub });
    return undefined;
  },

  async "wiki.page_created"(deps, a, userId, direction) {
    const actor = { type: "person" as const, userId };
    const wiki = { db: deps.db, pubsub: deps.pubsub };
    if (direction === "undo") {
      const page = await getWikiPage(deps.db, actor, a.orgId, a.targetId);
      if (page.version !== (await knownWikiVersion(deps.db, a))) throw changedSince();
      await deleteWikiPage(wiki, actor, a.orgId, page.id);
      return undefined;
    }
    const page = await restoreWikiPage(wiki, actor, a.orgId, a.targetId);
    return { version: page.version };
  },

  async "wiki.page_edited"(deps, a, userId, direction) {
    const actor = { type: "person" as const, userId };
    const page = await getWikiPage(deps.db, actor, a.orgId, a.targetId);
    const expected = obj(a.state).version ?? (direction === "undo" ? obj(a.after).version : undefined);
    if (page.version !== expected) throw changedSince();
    const wanted = Number((direction === "undo" ? obj(a.before) : obj(a.after)).version);
    const v = await getWikiVersion(deps.db, actor, a.orgId, page.id, wanted);
    const saved = await updateWikiPage({ db: deps.db, pubsub: deps.pubsub }, actor, a.orgId, page.id, {
      baseVersion: page.version,
      title: v.title,
      body: v.body,
      note: direction === "undo" ? `undid the agent's edit (back to version ${wanted})` : "redid the agent's edit",
    });
    return { version: saved.version };
  },

  async "thread.renamed"(deps, a, userId, direction) {
    const thread = await getThread(deps.db, userId, a.orgId, a.targetId);
    const [from, to] = direction === "undo" ? [obj(a.after), obj(a.before)] : [obj(a.before), obj(a.after)];
    if ((thread.title ?? null) !== ((from.title as string | null) ?? null)) throw changedSince();
    await updateThread({ db: deps.db, pubsub: deps.pubsub }, userId, a.orgId, a.targetId, {
      title: (to.title as string | null) ?? null,
    });
    return undefined;
  },

  async "thread.closed"(deps, a, userId, direction) {
    const thread = await getThread(deps.db, userId, a.orgId, a.targetId);
    const threadDeps = { db: deps.db, pubsub: deps.pubsub };
    if (direction === "undo") {
      if (thread.state !== "closed") throw changedSince();
      await reopenThread(threadDeps, userId, a.orgId, a.targetId);
    } else {
      if (thread.state !== "open") throw changedSince();
      await closeThread(threadDeps, userId, a.orgId, a.targetId);
    }
    return undefined;
  },
};
// ── Skills an agent made or fixed (ADR 0120) ─────────────────────────────────

handlers["skill.created"] = async (deps, a, _userId, direction) => {
  const [skill] = await deps.db
    .select()
    .from(schema.skills)
    .where(and(eq(schema.skills.orgId, a.orgId), eq(schema.skills.id, a.targetId)));
  if (!skill) throw new NotFoundError("The skill is gone", "action.target_gone");
  const noteIds = (obj(a.after).noteIds as string[] | undefined) ?? [];
  if (direction === "undo" ? skill.deletedAt !== null : skill.deletedAt === null) throw changedSince();
  await deps.db
    .update(schema.skills)
    .set({ deletedAt: direction === "undo" ? new Date() : null, updatedAt: new Date() })
    .where(eq(schema.skills.id, skill.id));
  // Its how-tos come back while it is gone, and leave again with it.
  if (noteIds.length > 0)
    await setMemory(
      deps,
      a.orgId,
      noteIds.map((id) => ({ id, status: direction === "undo" ? "active" : "archived", supersededBy: null })),
    );
  return undefined;
};

handlers["skill.updated"] = async (deps, a, _userId, direction) => {
  const [skill] = await deps.db
    .select()
    .from(schema.skills)
    .where(and(eq(schema.skills.orgId, a.orgId), eq(schema.skills.id, a.targetId), isNull(schema.skills.deletedAt)));
  if (!skill) throw new NotFoundError("The skill is gone", "action.target_gone");
  // An update from its link (`update_skill_from_source`): each side a whole version, its text and files.
  if (typeof obj(a.before).version === "number") {
    const [from, to] = (direction === "undo" ? [a.after, a.before] : [a.before, a.after]) as SkillSnapshot[];
    const at = direction === "undo" ? skill.version === from?.version : skill.body === from?.body;
    if (!from || !to || !at || (direction === "redo" && skill.description !== from.description)) throw changedSince();
    await restoreSkillSnapshot(deps.db, skill, to);
    return undefined;
  }
  const [from, to] =
    direction === "undo" ? [obj(a.after).body, obj(a.before).body] : [obj(a.before).body, obj(a.after).body];
  if (typeof to !== "string" || skill.body !== from) throw changedSince();
  await writeSkillBody(deps.db, skill, to);
  return undefined;
};

handlers["agent.settings_changed"] = async (deps, a, userId, direction) => {
  await revertSettings(deps, a, userId, direction, changedSince);
  return undefined;
};

handlers["workspace.changed"] = (deps, a, userId, direction) =>
  revertWorkspaceAction(deps, a, userId, direction, changedSince);

handlers["issue.assigned"] = handlers["issue.updated"] as Handler;
handlers["memory.updated"] = handlers["memory.saved"] as Handler;

// ── Undo, redo ───────────────────────────────────────────────────────────────

async function loadAction(db: Database, orgId: string, id: string) {
  const [row] = await db
    .select()
    .from(agentActions)
    .where(and(eq(agentActions.orgId, orgId), eq(agentActions.id, id)));
  if (!row) throw new NotFoundError("Action not found", "action.not_found");
  return row;
}

/** The person the agent worked for, an admin, or the agent's owner. A change to skills: only an admin. */
async function requireMayUndo(db: Database, userId: string, a: Row) {
  const membership = await getMembership(db, userId, a.orgId);
  if (!membership) throw new NotFoundError("Action not found", "action.not_found");
  assertActiveMembership(membership);
  if (can(membership, "manage_agents")) return;
  // Skills are who manages agents' on the agent's page (`SETTING_GROUP`), though `setAgentSkills` takes its owner too.
  const fields = (a.params as { fields?: unknown }).fields;
  if (a.kind === "agent.settings_changed" && Array.isArray(fields) && fields.includes("skill"))
    throw new ForbiddenError("Only an admin can undo or redo a change to an agent's skills", "action.skills_admins");
  if (a.requestedByUserId === userId) return;
  const agent = await getAgentCached(db, a.orgId, a.agentId);
  if (agent?.ownerUserId === userId) return;
  throw new ForbiddenError(
    "Only the person the agent worked for, its owner or an admin can undo this",
    "action.not_allowed",
  );
}

/** "Walter undid: created issue #23" on the agent's message, so its next turns know (`meta.actionNotes`). */
async function noteOnMessage(db: Database, a: Row, userId: string, direction: Direction) {
  if (!a.messageId) return;
  const [user] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId));
  const note = `${user?.name ?? "Someone"} ${direction === "undo" ? "undid" : "redid"}: ${describeAction(actionView(a))}`;
  await db
    .update(messages)
    .set({
      meta: sql`jsonb_set(${messages.meta}, '{actionNotes}', coalesce(${messages.meta}->'actionNotes', '[]'::jsonb) || ${JSON.stringify([note])}::jsonb)`,
    })
    .where(and(eq(messages.orgId, a.orgId), eq(messages.id, a.messageId)));
}

async function toggle(deps: AgentUndoDeps, userId: string, orgId: string, id: string, direction: Direction) {
  const now = deps.now?.() ?? new Date();
  const a = await loadAction(deps.db, orgId, id);
  await requireMayUndo(deps.db, userId, a);
  if (direction === "undo" && a.undoneAt) throw new ConflictError("Already undone", "action.already_undone");
  if (direction === "redo" && !a.undoneAt) throw new ConflictError("Not undone", "action.not_undone");
  if (a.undoableUntil.getTime() <= now.getTime()) {
    throw new ConflictError("Too late to undo this. Change it by hand.", "action.expired");
  }
  const handler = handlers[a.kind];
  if (!handler) throw new ConflictError("This can't be undone", "action.not_undoable");
  // Claim first: two clicks never invert twice.
  const until = new Date(now.getTime() + UNDO_WINDOW_MS);
  const claimed = await deps.db
    .update(agentActions)
    .set(
      direction === "undo"
        ? { undoneAt: now, undoneByUserId: userId, undoableUntil: until }
        : { undoneAt: null, undoneByUserId: null, redoneAt: now, undoableUntil: until },
    )
    .where(
      and(
        eq(agentActions.id, a.id),
        direction === "undo" ? isNull(agentActions.undoneAt) : sql`${agentActions.undoneAt} is not null`,
        gt(agentActions.undoableUntil, now),
      ),
    )
    .returning({ id: agentActions.id });
  if (claimed.length === 0) {
    throw new ConflictError(
      "Someone did this already",
      direction === "undo" ? "action.already_undone" : "action.not_undone",
    );
  }
  let state: Record<string, unknown> | undefined;
  try {
    state = await handler(deps, a, userId, direction);
  } catch (error) {
    await deps.db
      .update(agentActions)
      .set({
        undoneAt: a.undoneAt,
        undoneByUserId: a.undoneByUserId,
        redoneAt: a.redoneAt,
        undoableUntil: a.undoableUntil,
      })
      .where(eq(agentActions.id, a.id));
    throw error;
  }
  // `checkpoint`: changes before it are this flow's own (the next undo compares from there).
  await deps.db
    .update(agentActions)
    .set({ state: { ...obj(a.state), ...state, checkpoint: new Date().toISOString() } })
    .where(eq(agentActions.id, a.id));
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: userId },
    action: direction === "undo" ? "agent_action.undone" : "agent_action.redone",
    target: { type: "agent_action", id: a.id },
    details: { kind: a.kind, targetType: a.targetType, targetId: a.targetId, agentId: a.agentId },
  });
  await noteOnMessage(deps.db, a, userId, direction).catch(() => {});
  if (a.messageId) await publishMessageActions(deps, orgId, a.messageId).catch(() => {});
  return actionView(await loadAction(deps.db, orgId, a.id));
}

/** Desfazer: applies the inverse, if nobody changed the target since and the window is open. */
export const undoAgentAction = (deps: AgentUndoDeps, userId: string, orgId: string, actionId: string) =>
  toggle(deps, userId, orgId, actionId, "undo");

/** Refazer: applies the change again (after an undo, while the window is open). */
export const redoAgentAction = (deps: AgentUndoDeps, userId: string, orgId: string, actionId: string) =>
  toggle(deps, userId, orgId, actionId, "redo");

/**
 * Desfazer tudo: every receipt of the message still undoable, newest first
 * (a later change on the same target goes first). Each one that can't be
 * undone is listed in `failed` with its code; the rest are undone.
 */
export async function undoMessageActions(deps: AgentUndoDeps, userId: string, orgId: string, messageId: string) {
  const now = deps.now?.() ?? new Date();
  const rows = await deps.db
    .select()
    .from(agentActions)
    .where(and(eq(agentActions.orgId, orgId), eq(agentActions.messageId, messageId)))
    .orderBy(desc(agentActions.createdAt));
  if (rows.length === 0) throw new NotFoundError("This message has no changes to undo", "action.not_found");
  const open = rows.filter((a) => !a.undoneAt && a.undoableUntil.getTime() > now.getTime());
  // A card's receipts can differ in who may undo them (a skill's is only an admin's): refused before any is undone.
  for (const a of open) await requireMayUndo(deps.db, userId, a);
  const failed: { id: string; code: string; message: string }[] = [];
  for (const a of open) {
    try {
      await toggle(deps, userId, orgId, a.id, "undo");
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      // Not allowed for one = not allowed for all (same agent, same requester).
      if (error instanceof ForbiddenError) throw error;
      failed.push({
        id: a.id,
        code: typeof code === "string" ? code : "action.failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { actions: (await actionsFor(deps.db, orgId, [messageId])).get(messageId) ?? [], failed };
}

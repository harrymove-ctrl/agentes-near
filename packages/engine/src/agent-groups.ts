import type { PubSub } from "@agenteschat/adapters";
import { and, asc, type Database, type Executor, eq, inArray, isNotNull, isNull, schema } from "@agenteschat/db";
import { NotFoundError, ValidationError } from "./errors";
import { publishOrgEvent } from "./events";
import { getMembership, requirePermission } from "./organizations";
import { ROLE_COLORS, ROLE_ICONS } from "./permissions";

const { agentGroups, agents } = schema;

/**
 * A group of agents as every app reads it (ADR 0083): the groups in the workspace's order, each with its agents in
 * theirs. Shown as a setor (ADR 0148): its mark, who leads it and who covers for them.
 */
export interface AgentGroupView {
  id: string;
  name: string;
  agentIds: string[];
  color: string;
  icon: string;
  leadUserId: string | null;
  backupUserId: string | null;
}

/** What a group's look and people may change to; null clears a person. */
export interface AgentGroupPatch {
  name?: string;
  index?: number;
  color?: string;
  icon?: string;
  leadUserId?: string | null;
  backupUserId?: string | null;
}

export interface AgentGroupDeps {
  db: Database;
  pubsub?: PubSub;
}

const MAX_GROUPS = 50;

const groupNotFound = () => new NotFoundError("Group not found", "agent_group.not_found");

const cleanName = (name: string) => {
  const n = name.trim().slice(0, 80);
  if (!n) throw new ValidationError("name is required");
  return n;
};

/** `item` at `index` among `others` (clamped to the ends). */
const placeAt = <T>(others: T[], item: T, index: number) => {
  const at = Math.max(0, Math.min(others.length, Math.trunc(index)));
  return [...others.slice(0, at), item, ...others.slice(at)];
};

const groupRows = (db: Executor, orgId: string) =>
  db
    .select()
    .from(agentGroups)
    .where(eq(agentGroups.orgId, orgId))
    .orderBy(asc(agentGroups.position), asc(agentGroups.createdAt));

/** The workspace's groups with their agents (archived ones left out). No permission check. */
export async function agentGroupViews(db: Executor, orgId: string): Promise<AgentGroupView[]> {
  const groups = await groupRows(db, orgId);
  const members = await db
    .select({ id: agents.id, groupId: agents.groupId })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), isNotNull(agents.groupId), isNull(agents.archivedAt)))
    .orderBy(asc(agents.groupPosition), asc(agents.createdAt));
  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    agentIds: members.filter((m) => m.groupId === g.id).map((m) => m.id),
    color: g.color,
    icon: g.icon,
    leadUserId: g.leadUserId,
    backupUserId: g.backupUserId,
  }));
}

/**
 * Tells every open app of the workspace to read the groups again (an org broadcast), and gives them as they are now.
 * The event carries no list: it grows with the agents, and Postgres NOTIFY refuses payloads near 8000 bytes.
 */
async function announce(deps: AgentGroupDeps, orgId: string) {
  await publishOrgEvent(deps.pubsub, { type: "org.broadcast", orgId, event: { type: "agent.groups" } });
  return agentGroupViews(deps.db, orgId);
}

async function requireAgents(db: Executor, orgId: string, ids: string[]) {
  const found = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), inArray(agents.id, ids), isNull(agents.archivedAt)));
  if (found.length !== ids.length) throw new NotFoundError("Agent not found");
}

const oneOf = (list: readonly string[], value: string, what: string) => {
  if (!list.includes(value)) throw new ValidationError(`Unknown ${what}`, `agent_group.bad_${what}`);
  return value;
};

/** The color, icon and people a patch sets, checked: a person must be in the workspace. */
async function lookOf(db: Executor, orgId: string, patch: AgentGroupPatch) {
  const set: Partial<typeof agentGroups.$inferInsert> = {};
  if (patch.color !== undefined) set.color = oneOf(ROLE_COLORS, patch.color, "color");
  if (patch.icon !== undefined) set.icon = oneOf(ROLE_ICONS, patch.icon, "icon");
  for (const key of ["leadUserId", "backupUserId"] as const) {
    const id = patch[key];
    if (id === undefined) continue;
    if (id !== null && !(await getMembership(db, id, orgId)))
      throw new ValidationError("That person isn't in the workspace", "agent_group.not_member");
    set[key] = id;
  }
  return set;
}

/** `ids` in this order inside `groupId` (null: in no group). */
async function placeAgents(tx: Executor, orgId: string, groupId: string | null, ids: string[]) {
  for (const [i, id] of ids.entries()) {
    await tx
      .update(agents)
      .set({ groupId, groupPosition: i })
      .where(and(eq(agents.id, id), eq(agents.orgId, orgId)));
  }
}

/** Anyone in the workspace reads them. */
export async function listAgentGroups(db: Database, userId: string, orgId: string): Promise<AgentGroupView[]> {
  await requirePermission(db, userId, orgId, "read");
  return agentGroupViews(db, orgId);
}

/**
 * Adds a group after the others, with `agentIds` in it in that order (out of any group they were in). Owners and
 * admins. An import brings its sections of agents in through this too, one call per section.
 */
export async function createAgentGroup(
  deps: AgentGroupDeps,
  userId: string,
  orgId: string,
  input: { name: string; agentIds?: string[]; color?: string; icon?: string },
): Promise<AgentGroupView[]> {
  await requirePermission(deps.db, userId, orgId, "manage_agents");
  const name = cleanName(input.name);
  const ids = [...new Set(input.agentIds ?? [])];
  const look = await lookOf(deps.db, orgId, { color: input.color, icon: input.icon });
  await deps.db.transaction(async (tx) => {
    const groups = await groupRows(tx, orgId);
    if (groups.length >= MAX_GROUPS) {
      throw new ValidationError(`A workspace holds at most ${MAX_GROUPS} groups`, "agent_group.too_many", {
        max: MAX_GROUPS,
      });
    }
    if (ids.length) await requireAgents(tx, orgId, ids);
    const [group] = await tx
      .insert(agentGroups)
      .values({ orgId, name, position: (groups.at(-1)?.position ?? -1) + 1, ...look })
      .returning({ id: agentGroups.id });
    if (group) await placeAgents(tx, orgId, group.id, ids);
  });
  return announce(deps, orgId);
}

/**
 * Renames a group, moves it among the groups (`index`: its place among the others), or changes its color, icon, lead
 * or substitute. Owners and admins.
 */
export async function updateAgentGroup(
  deps: AgentGroupDeps,
  userId: string,
  orgId: string,
  groupId: string,
  patch: AgentGroupPatch,
): Promise<AgentGroupView[]> {
  await requirePermission(deps.db, userId, orgId, "manage_agents");
  const groups = await groupRows(deps.db, orgId);
  const group = groups.find((g) => g.id === groupId);
  if (!group) throw groupNotFound();
  const name = patch.name === undefined ? undefined : cleanName(patch.name);
  const set = { ...(await lookOf(deps.db, orgId, patch)), ...(name === undefined ? {} : { name }) };
  const index = patch.index;
  await deps.db.transaction(async (tx) => {
    if (Object.keys(set).length > 0) await tx.update(agentGroups).set(set).where(eq(agentGroups.id, group.id));
    if (index === undefined) return;
    const order = placeAt(
      groups.filter((g) => g.id !== group.id),
      group,
      index,
    );
    for (const [i, g] of order.entries()) {
      if (g.position !== i) await tx.update(agentGroups).set({ position: i }).where(eq(agentGroups.id, g.id));
    }
  });
  return announce(deps, orgId);
}

/** Deletes a group; its agents go back to no group (the foreign key clears theirs). Owners and admins. */
export async function deleteAgentGroup(
  deps: AgentGroupDeps,
  userId: string,
  orgId: string,
  groupId: string,
): Promise<AgentGroupView[]> {
  await requirePermission(deps.db, userId, orgId, "manage_agents");
  const gone = await deps.db
    .delete(agentGroups)
    .where(and(eq(agentGroups.id, groupId), eq(agentGroups.orgId, orgId)))
    .returning({ id: agentGroups.id });
  if (gone.length === 0) throw groupNotFound();
  return announce(deps, orgId);
}

/**
 * Moves an agent into a group, at `index` among its other agents (the end without one), or out of any group
 * (`groupId` null: back with the agents in none, in the workspace's order). Owners and admins.
 */
export async function moveAgentToGroup(
  deps: AgentGroupDeps,
  userId: string,
  orgId: string,
  agentId: string,
  input: { groupId: string | null; index?: number },
): Promise<AgentGroupView[]> {
  await requirePermission(deps.db, userId, orgId, "manage_agents");
  await requireAgents(deps.db, orgId, [agentId]);
  const { groupId, index } = input;
  await deps.db.transaction(async (tx) => {
    if (groupId === null) return placeAgents(tx, orgId, null, [agentId]);
    const [group] = await tx
      .select({ id: agentGroups.id })
      .from(agentGroups)
      .where(and(eq(agentGroups.id, groupId), eq(agentGroups.orgId, orgId)));
    if (!group) throw groupNotFound();
    const others = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.orgId, orgId), eq(agents.groupId, group.id), isNull(agents.archivedAt)))
      .orderBy(asc(agents.groupPosition), asc(agents.createdAt));
    const ids = others.map((a) => a.id).filter((id) => id !== agentId);
    await placeAgents(tx, orgId, group.id, placeAt(ids, agentId, index ?? ids.length));
  });
  return announce(deps, orgId);
}

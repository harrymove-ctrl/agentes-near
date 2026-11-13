/**
 * Who may see, manage and use a Vault item (ADR 0144). One place for every check: the app's (people) and the
 * tools' (agents). Items are few per workspace, so callers load them (`VAULT_MAX_ITEMS`) and filter here in code.
 *
 * People:
 * - A personal item or connection is its owner's alone: they see, edit and delete it. Admins don't see
 *   anyone else's.
 * - A team item is seen by whoever manages credentials (`manage_credentials`) and by its audience (everyone, its
 *   roles, its people). Only those who manage credentials edit or delete it, and only they see and change
 *   team connections.
 *
 * Agents: the person behind the run (the one who asked, else a routine's creator, else nobody), counted only while
 * an active member.
 * - Every item: the agent is one it is shared with (`allAgents`, or in `agentIds`).
 * - Personal: that person is its owner.
 * - Team: that person is in its audience, or nobody is behind the run and it is shared with everyone.
 */
import { and, type Executor, eq, inArray, isNull, schema } from "@agenteschat/db";
import { runAuthorityById, UUID } from "../authority";
import { ValidationError } from "../errors";
import { can, getMembership } from "../organizations";
import { routineCreatorOf } from "../requester";
import { VAULT_LIMITS, type VaultAccess, type VaultRun, type VaultScope } from "./service";

const { agents, orgRoles, organizationMembers } = schema;

export type ItemRow = typeof schema.vaultItems.$inferSelect;
export type ConnectionRow = typeof schema.vaultConnections.$inferSelect;

/** The access columns items and connections share. */
export interface AccessColumns {
  audienceEveryone: boolean;
  audienceRoleIds: string[];
  audienceUserIds: string[];
  allAgents: boolean;
  agentIds: string[];
}

export const scopeOf = (ownerUserId: string | null): VaultScope => (ownerUserId ? "personal" : "team");

/** The defaults: a personal item is for any agent its owner asks, a team one for everyone and no agent yet. */
export const DEFAULT_ACCESS: Record<VaultScope, VaultAccess> = {
  personal: { everyone: false, roleIds: [], userIds: [], allAgents: true, agentIds: [] },
  team: { everyone: true, roleIds: [], userIds: [], allAgents: false, agentIds: [] },
};

/**
 * A connection made now: every agent, its owner's for a personal one. A standing choice (`allAgents`), so an agent
 * created later is in. Connections made before this keep what they had.
 */
export const DEFAULT_CONNECTION_ACCESS: Record<VaultScope, VaultAccess> = {
  personal: DEFAULT_ACCESS.personal,
  team: { ...DEFAULT_ACCESS.team, allAgents: true },
};

/** The columns that decide an item's access now: its own, or its connection's while it follows it. */
export function effectiveColumns(item: ItemRow, connection: ConnectionRow | undefined): AccessColumns {
  return item.accessFromConnection && connection ? connection : item;
}

/** Columns as the apps read them; a personal item's audience is always empty. */
export function accessView(columns: AccessColumns, ownerUserId: string | null): VaultAccess {
  const personal = ownerUserId !== null;
  return {
    everyone: personal ? false : columns.audienceEveryone,
    roleIds: personal ? [] : [...columns.audienceRoleIds],
    userIds: personal ? [] : [...columns.audienceUserIds],
    allAgents: columns.allAgents,
    agentIds: [...columns.agentIds],
  };
}

/** A person in the app. `manages`: they hold `manage_credentials`. */
export interface VaultViewer {
  userId: string;
  roleIds: readonly string[];
  manages: boolean;
}

/** Whether the person is in a team audience: everyone, one of its people, or holding one of its roles. */
const inAudience = (columns: AccessColumns, person: { userId: string; roleIds: readonly string[] }) =>
  columns.audienceEveryone ||
  columns.audienceUserIds.includes(person.userId) ||
  person.roleIds.some((roleId) => columns.audienceRoleIds.includes(roleId));

/** Whether a person sees an item (or, with a connection's columns, its items by default). */
export function viewerSees(ownerUserId: string | null, columns: AccessColumns, viewer: VaultViewer): boolean {
  if (ownerUserId) return ownerUserId === viewer.userId;
  return viewer.manages || inAudience(columns, viewer);
}

/** Whether a person edits and deletes an item, or sees and changes a connection. */
export function viewerManages(ownerUserId: string | null, viewer: VaultViewer): boolean {
  return ownerUserId ? ownerUserId === viewer.userId : viewer.manages;
}

/** Who is behind an agent's run, as the Vault reads it. */
export interface VaultRunPerson {
  /** The person who asked, else the routine's creator; null when nobody is, or they are no longer a member. */
  personId: string | null;
  roleIds: string[];
  /** That person holds `manage_credentials`. */
  manages: boolean;
  /** The routine behind the run, if a routine is (its own run, or one its report or work woke). */
  routineId: string | null;
}

/**
 * The person a run uses the Vault for (ADR 0144): who asked (`authority.ts`), else the creator of the routine behind
 * it (`routineCreatorOf`), else nobody. A person counts only while an active member (a blocked account or one who
 * left counts as nobody).
 */
export async function vaultPersonOfRun(db: Executor, run: VaultRun): Promise<VaultRunPerson> {
  const authority = await runAuthorityById(db, run.orgId, run.runId);
  const routineId = authority.kind === "person" ? null : (authority.brief?.routineId ?? null);
  const candidate = authority.personId ?? routineCreatorOf(authority);
  const nobody = { personId: null, roleIds: [], manages: false, routineId };
  if (!candidate) return nobody;
  const membership = await getMembership(db, candidate, run.orgId);
  if (!membership) return nobody;
  return {
    personId: candidate,
    roleIds: membership.roleIds,
    manages: can(membership, "manage_credentials"),
    routineId,
  };
}

/** The agent check every item has: shared with all agents, or with this one. */
export const sharedWithAgent = (columns: AccessColumns, agentId: string) =>
  columns.allAgents || columns.agentIds.includes(agentId);

/**
 * What a run may do with an item, before its value is looked at:
 * - `use`: the agent may use it for the person behind the run.
 * - `not_shared`: that person may know the item (they see it in the app) but this agent may not use it for them.
 * - `hidden`: the run may not know it exists.
 */
export function runAccess(
  ownerUserId: string | null,
  columns: AccessColumns,
  person: Pick<VaultRunPerson, "personId" | "roleIds" | "manages">,
  agentId: string,
): "use" | "not_shared" | "hidden" {
  const agentOk = sharedWithAgent(columns, agentId);
  if (ownerUserId) {
    if (person.personId !== ownerUserId) return "hidden";
    return agentOk ? "use" : "not_shared";
  }
  if (!person.personId) {
    if (!columns.audienceEveryone) return "hidden";
    return agentOk ? "use" : "not_shared";
  }
  const viewer = { userId: person.personId, roleIds: person.roleIds };
  if (inAudience(columns, viewer)) return agentOk ? "use" : "not_shared";
  // Someone who manages credentials sees it in the app, but agents work for them only within its audience.
  return person.manages ? "not_shared" : "hidden";
}

const unique = (ids: readonly string[]) => [...new Set(ids.map((id) => id.trim()).filter(Boolean))];

/**
 * An access a person picked, checked against the workspace (as `setAgentAudience` does): roles must be its own
 * custom roles, agents its own, people still in it (someone who left drops out instead of failing the save). A
 * personal item has no audience: only the agents count.
 */
export async function cleanAccess(
  db: Executor,
  orgId: string,
  scope: VaultScope,
  access: VaultAccess | undefined,
): Promise<AccessColumns> {
  const given = access ?? DEFAULT_ACCESS[scope];
  const agentIds = unique(given.agentIds ?? []);
  if (agentIds.length > VAULT_LIMITS.agents)
    throw new ValidationError(`At most ${VAULT_LIMITS.agents} agents`, "vault.agents_invalid");
  if (agentIds.some((id) => !UUID.test(id)))
    throw new ValidationError("Every agent must be one of the workspace's", "vault.agents_invalid");
  if (agentIds.length > 0) {
    const known = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.orgId, orgId), inArray(agents.id, agentIds), isNull(agents.deletedAt)));
    if (known.length !== agentIds.length)
      throw new ValidationError("Every agent must be one of the workspace's", "vault.agents_invalid");
  }
  if (scope === "personal") {
    return { audienceEveryone: false, audienceRoleIds: [], audienceUserIds: [], allAgents: given.allAgents, agentIds };
  }
  const everyone = given.everyone === true;
  let roleIds = everyone ? [] : unique(given.roleIds ?? []);
  let userIds = everyone ? [] : unique(given.userIds ?? []);
  if (roleIds.length > VAULT_LIMITS.roles)
    throw new ValidationError(`At most ${VAULT_LIMITS.roles} roles`, "vault.audience_invalid");
  if (userIds.length > VAULT_LIMITS.people)
    throw new ValidationError(`At most ${VAULT_LIMITS.people} people`, "vault.audience_invalid");
  if (roleIds.some((id) => !UUID.test(id)))
    throw new ValidationError("Every role must be one of the workspace's", "vault.audience_invalid");
  if (roleIds.length > 0) {
    // `everyone` is the "everyone" switch, not a role to pick.
    const known = await db
      .select({ id: orgRoles.id })
      .from(orgRoles)
      .where(and(eq(orgRoles.orgId, orgId), eq(orgRoles.kind, "custom"), inArray(orgRoles.id, roleIds)));
    if (known.length !== roleIds.length)
      throw new ValidationError("Every role must be one of the workspace's", "vault.audience_invalid");
    roleIds = known.map((r) => r.id).sort();
  }
  if (userIds.length > 0) {
    const members = await db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), inArray(organizationMembers.userId, userIds)));
    const known = new Set(members.map((m) => m.userId));
    userIds = userIds.filter((id) => known.has(id));
  }
  return {
    audienceEveryone: everyone,
    audienceRoleIds: roleIds,
    audienceUserIds: userIds,
    allAgents: given.allAgents,
    agentIds,
  };
}

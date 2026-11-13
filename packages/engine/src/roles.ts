import type { PubSub } from "@agenteschat/adapters";
import { and, asc, type Database, type Executor, eq, inArray, schema, sql } from "@agenteschat/db";
import { recordAudit } from "./audit";
import { memberCardVia } from "./card-via";
import { announceChannelLeavers, type ChannelLeaver, dropRoleLeavers } from "./channels";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import {
  announceMembers,
  can,
  getMembership,
  lockOrgMembers,
  type Membership,
  outranks,
  requireActiveMembership,
  requirePermission,
} from "./organizations";
import {
  EVERYONE_DEFAULTS,
  isRolePermission,
  PERMISSION_AREAS,
  ROLE_COLORS,
  ROLE_ICONS,
  type RoleColor,
  type RoleIcon,
  type RolePermission,
  roleGrants,
} from "./permissions";

/**
 * A workspace's roles (ADR 0085): a person holds any number and may do what any allows; `everyone`
 * ("Todos") is the base every member holds; order is hierarchy. Two rules keep it from being climbed: anyone but
 * an owner only touches roles below their own highest one (and people whose highest role is below theirs), and
 * never gives a key they don't hold themselves.
 */

const { orgRoles, organizationMemberRoles, organizationMembers } = schema;

export const ROLE_NAME_MAX = 40;
/** A workspace's roles at most, `everyone` aside. */
export const ROLES_MAX = 100;

export interface RoleView {
  id: string;
  kind: "custom" | "everyone";
  name: string;
  icon: string;
  color: string;
  position: number;
  permissions: RolePermission[];
  mentionable: boolean;
  hoist: boolean;
  /** How many people hold it (`everyone`: every member). */
  people: number;
  /** Whether the person asking may change it: they manage roles and stand above it. */
  editable: boolean;
  /**
   * Whether they may give it to people (invitations, requests to join, a person's roles): a role below theirs whose
   * keys they all hold.
   */
  givable: boolean;
}

/** The base role and an "Admin" that holds `administrator` (listed apart in the members column), for a new workspace. */
export async function createDefaultRoles(tx: Executor, orgId: string) {
  await tx.insert(orgRoles).values([
    {
      orgId,
      kind: "everyone",
      name: "everyone",
      icon: "audienceEveryone",
      color: "graphite",
      permissions: [...EVERYONE_DEFAULTS],
    },
    { orgId, name: "Admin", icon: "shield", color: "indigo", position: 0, permissions: ["administrator"], hoist: true },
  ]);
}

const byOrder = <T extends { kind: string; position: number; name: string }>(a: T, b: T) =>
  (a.kind === "everyone" ? 1 : 0) - (b.kind === "everyone" ? 1 : 0) ||
  a.position - b.position ||
  a.name.localeCompare(b.name);

/**
 * Whether an actor holds every key of a role (an owner holds them all): giving it to anyone, themselves included,
 * then hands out nothing they can't already do.
 */
function holdsAll(actor: Membership, keys: readonly string[]) {
  if (actor.role === "owner") return true;
  const mine = roleGrants(actor.permissions as ReadonlySet<string>);
  return keys.every((k) => !isRolePermission(k) || mine.has(k));
}

/** Whether `actor` may change `role`: hold `manage_roles` (or own the workspace) and stand above it. */
function mayEdit(actor: Membership, role: { kind: string; position: number }) {
  if (!can(actor, "manage_roles")) return false;
  return role.kind === "everyone" || outranks(actor, role.position);
}

/**
 * The workspace's roles, top first and `everyone` last, with how many hold each, and the areas the apps draw the
 * permissions in. Every member may read them: what a role may do is no secret inside the workspace.
 */
export async function listRoles(db: Database, actorId: string, orgId: string) {
  const actor = await requirePermission(db, actorId, orgId, "read");
  const rows = await db
    .select({
      id: orgRoles.id,
      kind: orgRoles.kind,
      name: orgRoles.name,
      icon: orgRoles.icon,
      color: orgRoles.color,
      position: orgRoles.position,
      permissions: orgRoles.permissions,
      mentionable: orgRoles.mentionable,
      hoist: orgRoles.hoist,
      people: sql<number>`(case when ${orgRoles.kind} = 'everyone'
        then (select count(*) from organization_members m where m.org_id = ${orgRoles.orgId})
        else (select count(*) from organization_member_roles mr where mr.org_id = ${orgRoles.orgId} and mr.role_id = ${orgRoles.id})
        end)::int`,
    })
    .from(orgRoles)
    .where(eq(orgRoles.orgId, orgId));
  const roles: RoleView[] = rows.sort(byOrder).map((r) => ({
    ...r,
    permissions: r.permissions.filter(isRolePermission),
    editable: mayEdit(actor, r),
    givable: r.kind === "custom" && outranks(actor, r.position) && holdsAll(actor, r.permissions),
  }));
  return { roles, areas: PERMISSION_AREAS, colors: ROLE_COLORS, icons: ROLE_ICONS };
}

async function loadRole(db: Executor, orgId: string, roleId: string) {
  const [role] = await db
    .select()
    .from(orgRoles)
    .where(and(eq(orgRoles.orgId, orgId), eq(orgRoles.id, roleId)));
  if (!role) throw new NotFoundError("Role not found");
  return role;
}

function cleanName(name: string) {
  const v = name.trim().replace(/\s+/g, " ");
  if (!v) throw new ValidationError("A role needs a name", "role.name_required");
  if (v.length > ROLE_NAME_MAX)
    throw new ValidationError(`At most ${ROLE_NAME_MAX} characters`, "role.name_long", { max: ROLE_NAME_MAX });
  return v;
}

const pickColor = (v: string | undefined, fallback: RoleColor) =>
  v && (ROLE_COLORS as readonly string[]).includes(v) ? v : fallback;
const pickIcon = (v: string | undefined, fallback: RoleIcon) =>
  v && (ROLE_ICONS as readonly string[]).includes(v) ? v : fallback;

/**
 * The keys an actor sets on a role: only known ones, and none they don't hold (an owner holds them all). Keys the
 * role already had stay even when the actor lacks them: they only add or remove what they hold.
 */
function settableKeys(actor: Membership, next: readonly string[], before: readonly string[] = []) {
  const mine = actor.role === "owner" ? null : roleGrants(actor.permissions as ReadonlySet<string>);
  const wanted = new Set(next.filter(isRolePermission));
  for (const k of wanted) {
    if (mine && !mine.has(k) && !before.includes(k))
      throw new ForbiddenError("You can only give what you can do yourself", "role.grant_forbidden", { key: k });
  }
  for (const k of before) {
    if (mine && !mine.has(k as RolePermission) && !wanted.has(k as RolePermission))
      throw new ForbiddenError("You can only take away what you can do yourself", "role.grant_forbidden", { key: k });
  }
  return [...wanted];
}

const announceRoles = async (pubsub: PubSub | undefined, orgId: string) => {
  // People's permissions follow their roles: their apps read `me`, the people and the roles again.
  await announceMembers(pubsub, orgId);
};

/** Creates a role at the bottom of the others (just above `everyone`). Needs `manage_roles`. */
export async function createRole(
  db: Database,
  actorId: string,
  orgId: string,
  input: {
    name: string;
    icon?: string;
    color?: string;
    permissions?: string[];
    mentionable?: boolean;
    hoist?: boolean;
  },
  options: { pubsub?: PubSub } = {},
) {
  const actor = await requirePermission(db, actorId, orgId, "manage_roles");
  const name = cleanName(input.name);
  const permissions = settableKeys(actor, input.permissions ?? []);
  const role = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`org-roles:${orgId}`}))`);
    const [count] = await tx
      .select({ n: sql<number>`count(*)::int`, last: sql<number>`coalesce(max(${orgRoles.position}), -1)::int` })
      .from(orgRoles)
      .where(and(eq(orgRoles.orgId, orgId), eq(orgRoles.kind, "custom")));
    if ((count?.n ?? 0) >= ROLES_MAX) throw new ConflictError("Too many roles", "role.too_many", { max: ROLES_MAX });
    const [row] = await tx
      .insert(orgRoles)
      .values({
        orgId,
        name,
        icon: pickIcon(input.icon, "shield"),
        color: pickColor(input.color, "graphite"),
        position: (count?.last ?? -1) + 1,
        permissions,
        mentionable: input.mentionable ?? true,
        hoist: input.hoist ?? false,
      })
      .returning();
    if (!row) throw new Error("role insert returned nothing");
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "role.created",
      target: { type: "role", id: row.id },
      details: { name, permissions },
    });
    return row;
  });
  await announceRoles(options.pubsub, orgId);
  return role;
}

/**
 * Changes a role below the actor (or `everyone`). `everyone` keeps its name, look and switches: only its keys
 * change.
 */
export async function updateRole(
  db: Database,
  actorId: string,
  orgId: string,
  roleId: string,
  patch: {
    name?: string;
    icon?: string;
    color?: string;
    permissions?: string[];
    mentionable?: boolean;
    hoist?: boolean;
  },
  options: { pubsub?: PubSub } = {},
) {
  const actor = await requirePermission(db, actorId, orgId, "manage_roles");
  const role = await loadRole(db, orgId, roleId);
  if (!mayEdit(actor, role)) throw new ForbiddenError("Only someone above this role changes it", "role.above_you");
  const everyone = role.kind === "everyone";
  const set: Partial<typeof orgRoles.$inferInsert> = {};
  if (patch.name !== undefined && !everyone) set.name = cleanName(patch.name);
  if (patch.icon !== undefined && !everyone) set.icon = pickIcon(patch.icon, role.icon as RoleIcon);
  if (patch.color !== undefined) set.color = pickColor(patch.color, role.color as RoleColor);
  if (patch.mentionable !== undefined && !everyone) set.mentionable = patch.mentionable;
  if (patch.hoist !== undefined && !everyone) set.hoist = patch.hoist;
  if (patch.permissions !== undefined) {
    const next = settableKeys(actor, patch.permissions, role.permissions);
    // `everyone` never holds `administrator`: it would make every member one.
    set.permissions = everyone ? next.filter((k) => k !== "administrator") : next;
  }
  if (Object.keys(set).length === 0) return role;
  const [row] = await db.transaction(async (tx) => {
    const updated = await tx.update(orgRoles).set(set).where(eq(orgRoles.id, role.id)).returning();
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "role.updated",
      target: { type: "role", id: role.id },
      details: {
        name: set.name ?? role.name,
        ...(set.permissions ? { from: role.permissions, to: set.permissions } : {}),
      },
    });
    return updated;
  });
  await announceRoles(options.pubsub, orgId);
  return row ?? role;
}

/** Deletes a role below the actor; whoever held it keeps the rest. `everyone` can't go. */
export async function deleteRole(
  db: Database,
  actorId: string,
  orgId: string,
  roleId: string,
  options: { pubsub?: PubSub } = {},
) {
  const actor = await requirePermission(db, actorId, orgId, "manage_roles");
  const role = await loadRole(db, orgId, roleId);
  if (role.kind === "everyone") throw new ForbiddenError("Every workspace keeps its base role", "role.base");
  if (!mayEdit(actor, role)) throw new ForbiddenError("Only someone above this role changes it", "role.above_you");
  const leavers = await db.transaction(async (tx) => {
    // The lock joinChannel takes for a role channel: a join at the same moment sees the role gone, or is dropped here.
    await lockOrgMembers(tx, orgId);
    const holders = (
      await tx
        .select({ userId: organizationMemberRoles.userId })
        .from(organizationMemberRoles)
        .where(and(eq(organizationMemberRoles.orgId, orgId), eq(organizationMemberRoles.roleId, role.id)))
    ).map((r) => r.userId);
    await tx.delete(orgRoles).where(eq(orgRoles.id, role.id));
    // Its holders leave the channels they were in through it alone (ADR 0125); then the channels forget it.
    const left = await dropRoleLeavers(tx, orgId, { people: holders, roleIds: [role.id] });
    await tx
      .update(schema.channels)
      .set({ audienceRoleIds: sql`array_remove(${schema.channels.audienceRoleIds}, ${role.id}::uuid)` })
      .where(and(eq(schema.channels.orgId, orgId), sql`${role.id}::uuid = any(${schema.channels.audienceRoleIds})`));
    // Boards forget it too: a `roles` board with no role left is its owner's (and admins') alone (ADR 0135 §8).
    await tx
      .update(schema.dashboards)
      .set({ audienceRoleIds: sql`array_remove(${schema.dashboards.audienceRoleIds}, ${role.id}::uuid)` })
      .where(
        and(eq(schema.dashboards.orgId, orgId), sql`${role.id}::uuid = any(${schema.dashboards.audienceRoleIds})`),
      );
    // And who edits them: a board edited by roles with none left is edited by its owner and admins (`owner`).
    await tx
      .update(schema.dashboards)
      .set({
        editRoleIds: sql`array_remove(${schema.dashboards.editRoleIds}, ${role.id}::uuid)`,
        editPolicy: sql`case when cardinality(array_remove(${schema.dashboards.editRoleIds}, ${role.id}::uuid)) = 0
          and ${schema.dashboards.editPolicy} = 'roles' then 'owner' else ${schema.dashboards.editPolicy} end`,
      })
      .where(and(eq(schema.dashboards.orgId, orgId), sql`${role.id}::uuid = any(${schema.dashboards.editRoleIds})`));
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "role.deleted",
      target: { type: "role", id: role.id },
      details: { name: role.name, permissions: role.permissions },
    });
    return left;
  });
  await announceChannelLeavers({ db, pubsub: options.pubsub }, orgId, leavers);
  await announceRoles(options.pubsub, orgId);
}

/**
 * Puts the roles in this order (top first; `everyone` stays last, whatever is sent). Anyone but an owner leaves the
 * roles at or above their own where they are: only the ones below them move, among themselves.
 */
export async function reorderRoles(
  db: Database,
  actorId: string,
  orgId: string,
  ids: string[],
  options: { pubsub?: PubSub } = {},
) {
  const actor = await requirePermission(db, actorId, orgId, "manage_roles");
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`org-roles:${orgId}`}))`);
    const current = (
      await tx
        .select({ id: orgRoles.id, position: orgRoles.position, name: orgRoles.name, kind: orgRoles.kind })
        .from(orgRoles)
        .where(and(eq(orgRoles.orgId, orgId), eq(orgRoles.kind, "custom")))
    ).sort(byOrder);
    const known = new Set(current.map((r) => r.id));
    const next = [...new Set(ids)].filter((id) => known.has(id));
    if (next.length !== current.length) throw new ValidationError("Send every role once", "role.order_incomplete");
    current.forEach((r, i) => {
      // A role the actor doesn't stand above keeps its slot.
      if (!outranks(actor, r.position) && next[i] !== r.id)
        throw new ForbiddenError("Only someone above a role moves it", "role.above_you");
    });
    for (const [i, id] of next.entries()) {
      await tx.update(orgRoles).set({ position: i }).where(eq(orgRoles.id, id));
    }
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "role.reordered",
      target: { type: "organization", id: orgId },
      details: { order: next.map((id) => current.find((r) => r.id === id)?.name ?? id) },
    });
  });
  await announceRoles(options.pubsub, orgId);
}

/**
 * The roles in `ids` the actor may give (or take): custom roles of this workspace below them whose keys they all
 * hold, so nobody hands themselves or anyone else more than they can do. Unknown or base ids refuse the whole call;
 * the result keeps the ids in the workspace.
 */
export async function givableRoleIds(db: Executor, actor: Membership, orgId: string, ids: readonly string[]) {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return [];
  const rows = await db
    .select({ id: orgRoles.id, kind: orgRoles.kind, position: orgRoles.position, permissions: orgRoles.permissions })
    .from(orgRoles)
    .where(and(eq(orgRoles.orgId, orgId), inArray(orgRoles.id, wanted)));
  if (rows.length !== wanted.length || rows.some((r) => r.kind !== "custom"))
    throw new ValidationError("Unknown role", "role.unknown");
  if (rows.some((r) => !outranks(actor, r.position)))
    throw new ForbiddenError("You can only give roles below your own", "role.above_you");
  if (rows.some((r) => !holdsAll(actor, r.permissions)))
    throw new ForbiddenError("You can only give roles whose permissions you hold", "role.grant_forbidden");
  return rows.map((r) => r.id);
}

/**
 * The ids among `ids` that `actor` could still give today (`givableRoleIds`, by someone who may invite), the others
 * left out: none when `actor` is no longer a member.
 */
export async function stillGivableRoleIds(
  db: Executor,
  actor: Membership | null,
  orgId: string,
  ids: readonly string[],
) {
  if (!actor || !can(actor, "invite_people") || ids.length === 0) return [];
  const rows = await db
    .select({ id: orgRoles.id, position: orgRoles.position, permissions: orgRoles.permissions })
    .from(orgRoles)
    .where(and(eq(orgRoles.orgId, orgId), eq(orgRoles.kind, "custom"), inArray(orgRoles.id, [...new Set(ids)])));
  return rows.filter((r) => outranks(actor, r.position) && holdsAll(actor, r.permissions)).map((r) => r.id);
}

/** The ids among `ids` that are still custom roles of the workspace. */
export async function rolesStillThere(db: Executor, orgId: string, ids: readonly string[]) {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: orgRoles.id })
    .from(orgRoles)
    .where(and(eq(orgRoles.orgId, orgId), eq(orgRoles.kind, "custom"), inArray(orgRoles.id, [...new Set(ids)])));
  return rows.map((r) => r.id);
}

/** Adds roles to a member in the caller's transaction, skipping any no longer in the workspace. */
export async function addMemberRolesInTx(
  tx: Executor,
  orgId: string,
  userId: string,
  roleIds: readonly string[],
  actorId = userId,
) {
  if (roleIds.length === 0) return;
  const before = await memberRoleIds(tx, orgId, userId);
  const there = await tx
    .select({ id: orgRoles.id })
    .from(orgRoles)
    .where(and(eq(orgRoles.orgId, orgId), eq(orgRoles.kind, "custom"), inArray(orgRoles.id, [...new Set(roleIds)])));
  if (there.length === 0) return;
  await tx
    .insert(organizationMemberRoles)
    .values(there.map((r) => ({ orgId, userId, roleId: r.id })))
    .onConflictDoNothing();
  // Loaded here: audience builds on this module.
  const { dropMailForNewRoleMember } = await import("./audience");
  const added = there.map((r) => r.id).filter((id) => !before.includes(id));
  await dropMailForNewRoleMember(tx, orgId, userId, before, added, actorId);
}

/** A member's roles (ids), not `everyone`. */
export async function memberRoleIds(db: Executor, orgId: string, userId: string) {
  const rows = await db
    .select({ id: organizationMemberRoles.roleId })
    .from(organizationMemberRoles)
    .where(and(eq(organizationMemberRoles.orgId, orgId), eq(organizationMemberRoles.userId, userId)));
  return rows.map((r) => r.id);
}

/**
 * Sets a member's roles to exactly `roleIds` (ADR 0085). Needs `manage_members`; anyone but an owner only touches
 * people below them (themselves aside) and only adds or removes roles below their own. An owner's roles are set
 * by owners only.
 */
export async function setMemberRoles(
  db: Database,
  actorId: string,
  orgId: string,
  targetUserId: string,
  roleIds: string[],
  /** `via`: the people card it was applied from (the audit's "via", `memberCardVia`). */
  options: { pubsub?: PubSub; via?: string } = {},
) {
  const actor = await requirePermission(db, actorId, orgId, "manage_members");
  const via = await memberCardVia(db, orgId, options.via, targetUserId);
  const target = await getMembership(db, targetUserId, orgId, { includeBlocked: true });
  if (!target) throw new ConflictError("That user is not a member");
  if (target.role === "owner" && actor.role !== "owner")
    throw new ForbiddenError("Only owners change an owner's roles", "role.above_you");
  if (actorId !== targetUserId && !outranks(actor, target.rank))
    throw new ForbiddenError("Only someone above them changes their roles", "role.above_you");
  const next = [...new Set(roleIds)];
  // Read and checked under the lock: two people changing the same person's roles at once never undo each other.
  const changed = await db.transaction(async (tx): Promise<false | ChannelLeaver[]> => {
    await lockOrgMembers(tx, orgId);
    const before = await memberRoleIds(tx, orgId, targetUserId);
    const added = next.filter((id) => !before.includes(id));
    const removed = before.filter((id) => !next.includes(id));
    await givableRoleIds(tx, actor, orgId, [...added, ...removed]);
    if (added.length === 0 && removed.length === 0) return false;
    if (removed.length > 0)
      await tx
        .delete(organizationMemberRoles)
        .where(
          and(
            eq(organizationMemberRoles.orgId, orgId),
            eq(organizationMemberRoles.userId, targetUserId),
            inArray(organizationMemberRoles.roleId, removed),
          ),
        );
    await addMemberRolesInTx(tx, orgId, targetUserId, added, actorId);
    // Channels limited to the roles taken away (ADR 0125) let them go, unless another of theirs still opens them.
    const left = await dropRoleLeavers(tx, orgId, { people: [targetUserId], roleIds: removed });
    const names = await tx
      .select({ id: orgRoles.id, name: orgRoles.name })
      .from(orgRoles)
      .where(and(eq(orgRoles.orgId, orgId), inArray(orgRoles.id, [...added, ...removed])))
      .orderBy(asc(orgRoles.position));
    const nameOf = (id: string) => names.find((n) => n.id === id)?.name ?? id;
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "member.roles_changed",
      target: { type: "person", id: targetUserId },
      details: { added: added.map(nameOf), removed: removed.map(nameOf), ...(via ? { via } : {}) },
    });
    return left;
  });
  if (changed) {
    await announceChannelLeavers({ db, pubsub: options.pubsub }, orgId, changed);
    // Loaded here: questions build on channels, which this module loads.
    const { releaseQuestionsOutOfReach } = await import("./questions");
    await releaseQuestionsOutOfReach({ db, pubsub: options.pubsub }, orgId, targetUserId);
    await announceMembers(options.pubsub, orgId);
  }
  return next;
}

/** The people who hold a role (ids), for the role's screen. Every member may read it. */
export async function roleMembers(db: Database, actorId: string, orgId: string, roleId: string) {
  await requireActiveMembership(db, actorId, orgId);
  const role = await loadRole(db, orgId, roleId);
  if (role.kind === "everyone") {
    const rows = await db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(eq(organizationMembers.orgId, orgId));
    return rows.map((r) => r.userId);
  }
  const rows = await db
    .select({ userId: organizationMemberRoles.userId })
    .from(organizationMemberRoles)
    .where(and(eq(organizationMemberRoles.orgId, orgId), eq(organizationMemberRoles.roleId, roleId)));
  return rows.map((r) => r.userId);
}

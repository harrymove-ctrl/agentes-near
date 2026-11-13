import { holdEvents, type PubSub } from "@agenteschat/adapters";
import { and, asc, type Database, desc, eq, inArray, isNotNull, isNull, schema, sql } from "@agenteschat/db";
import {
  type ActionRecord,
  type AgentActionTarget,
  actWithUndo,
  publishMessageActions,
  UNDO_WINDOW_MS,
} from "./agent-actions";
import type { AgentDeletionDeps } from "./agent-deletion";
import { agentsByHandle } from "./agents";
import { recordAudit } from "./audit";
import { cancelRun } from "./cancel";
import { deleteChannel } from "./channel-deletion";
import { setChannelOverride } from "./channel-permissions";
import {
  addChannelMember,
  archiveChannel,
  listChannels,
  removeChannelMember,
  requireChannelAccess,
  unarchiveChannel,
} from "./channels";
import { findMember } from "./chat-tools";
import { cardPlace, NO_PERSON_READS } from "./consultations";
import { ownWords } from "./context/learn";
import { continueRun } from "./continue-run";
import { queueInvitationEmail } from "./email";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishChannelEvent, publishMessageCreated } from "./events";
import { approveJoinRequest, denyJoinRequest } from "./invite-requests";
import { getOrgSettings, updateChannel, updateOrgSettings } from "./management";
import { AVAILABILITIES, type Availability, setMyStatus } from "./member-status";
import { getMessage, insertMessage, messageView } from "./messages";
import { NOTICE_CATEGORIES, type NoticeCategory, noticePrefsView, setNoticePref } from "./notice-prefs";
import { notify, resolveNotifications } from "./notifications";
import {
  announceMembers,
  can,
  getMembership,
  requirePermission,
  resendInvitation,
  revokeInvitation,
  setInvitationRoles,
  updateMyProfile,
} from "./organizations";
import {
  CHANNEL_KEYS,
  maySql,
  type Permission,
  ROLE_COLORS,
  ROLE_ICONS,
  ROLE_PERMISSIONS,
  type RolePermission,
} from "./permissions";
import { personBehindCall } from "./requester";
import {
  createRole,
  deleteRole,
  memberRoleIds,
  ROLE_NAME_MAX,
  reorderRoles,
  setMemberRoles,
  updateRole,
} from "./roles";
import { bodyCode } from "./run-tools";
import { rankTools } from "./tools/directory";
import { canonicalJson, type JsonSchema, validateJson } from "./tools/json-schema";
import type { ToolContext, ToolDefinition, ToolOutput } from "./tools/types";

const {
  agentActions,
  agentRuns,
  channelMembers,
  channelPermissionOverrides,
  channels,
  messages,
  organizationInvitations,
  organizationJoinRequests,
  organizationMembers,
  organizationMemberRoles,
  orgRoles,
} = schema;

/**
 * Anything else a person can change in the app, done by the right hand as them (ADR 0137 amendment of 2026-11-07): a
 * catalog of actions, each the engine call its screen makes with the person as the actor, so it never does more than
 * their click would. `workspace_action` finds one and does it: at once with Undo when the person who asked may decide
 * it in their own words (`ownWords`), else a card whoever may applies, as themselves (`decideWorkspaceAction`).
 */

export const WORKSPACE_ACTION_TOOL = "workspace_action";
/** The receipt of every catalog action (`params.action` says which): Undo runs the entry's own inverse. */
export const WORKSPACE_ACTION_KIND = "workspace.changed";
/** Its card's `bodyCode` (`chat.body.action_workspace`). */
export const WORKSPACE_ACTION_CARD = "action_workspace";
/** At most this many changes at once in one turn: enough for a request, never a flood. */
export const MAX_ACTIONS_PER_RUN = 10;

export interface ActionDeps {
  db: Database;
  pubsub?: PubSub;
  /** The server's address and `AGENTES_SECRET`: invitations an action sends link back to it. */
  server?: ServerLinks;
  /** What the channel screen's deletion passes: its missions stop on their computers, its mail routines' triggers go. */
  hub?: AgentDeletionDeps["hub"];
  mail?: AgentDeletionDeps["mail"];
}

export interface ServerLinks {
  publicUrl: string;
  secret?: string;
}

/** What an action did: its receipt's target and words, and what its Undo puts back. */
export interface ActionDone {
  target: AgentActionTarget;
  /** The words of its receipt (`agentActions.workspace.changed_{action}`) and card (`rightHand.action.{action}`). */
  words: Record<string, string>;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  /** Nothing undoes it: its receipt is plain history. */
  final?: boolean;
}

type ActionRow = typeof agentActions.$inferSelect;
type Input = Record<string, unknown>;

export interface WorkspaceAction {
  id: string;
  /** What it does, for the model (English). */
  does: string;
  /** Its input, with names as the person says them. */
  input: JsonSchema;
  /**
   * `now`: at once with Undo when the person who asked may decide it, a card otherwise. `card`: always a card someone
   * confirms (it can't be undone, or it is a safety switch).
   */
  mode: "now" | "card";
  /** The key its screen asks for, to say who may (the engine call checks again, with all its rules): null, anyone. */
  needs: Permission | null;
  /** It changes whoever runs it (their status…): on a card, only the person it was for applies it. */
  self?: true;
  /** Names read as ids for `person`, or why not (English). What a card keeps and its click runs. */
  resolve(
    ctx: ToolContext,
    person: string,
    input: Input,
  ): Promise<{ input: Input; words: Record<string, string> } | string>;
  /** The engine call its screen makes, as `actorId`. */
  run(deps: ActionDeps, actorId: string, orgId: string, input: Input): Promise<ActionDone>;
  /** Undo (back to `before`) or Redo, as `actorId`; throws `changedSince()` when it moved since. The state to keep. */
  revert?(
    deps: ActionDeps,
    actorId: string,
    a: ActionRow,
    direction: "undo" | "redo",
    changedSince: () => Error,
  ): Promise<Record<string, unknown> | undefined>;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const list = (v: unknown) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);
const sameSet = (a: readonly string[], b: readonly string[]) => same([...a].sort(), [...b].sort());

// ── Names ────────────────────────────────────────────────────────────────────

const EVERYONE_NAMES = new Set(["everyone", "todos", "@everyone", "@todos"]);

/** A role by name (`everyone` and its words too), or why not. */
async function roleNamed(ctx: Pick<ToolContext, "db" | "orgId">, name: string) {
  const rows = await ctx.db
    .select({ id: orgRoles.id, name: orgRoles.name, kind: orgRoles.kind })
    .from(orgRoles)
    .where(eq(orgRoles.orgId, ctx.orgId));
  const key = name.trim().toLowerCase();
  const hit = EVERYONE_NAMES.has(key)
    ? rows.find((r) => r.kind === "everyone")
    : rows.find((r) => r.kind === "custom" && r.name.toLowerCase() === key);
  return (
    hit ??
    `No role "${name}". Roles here: ${
      rows
        .filter((r) => r.kind === "custom")
        .map((r) => r.name)
        .join(", ") || "none but everyone"
    }.`
  );
}

/** One member by @handle, email or name, or why not. */
async function personNamed(ctx: Pick<ToolContext, "db" | "orgId">, who: string) {
  const found = await findMember(ctx, who);
  if (found.length === 1 && found[0]) return found[0];
  return found.length
    ? `Several people match "${who}": ${found.map((m) => (m.handle ? `${m.name} (@${m.handle})` : m.name)).join(", ")}. Ask which one.`
    : `No one called "${who}" in this workspace.`;
}

/** A channel the person sees, by name. */
async function channelNamed(ctx: Pick<ToolContext, "db" | "orgId">, person: string, name: string) {
  const wanted = name.trim().replace(/^#/, "").toLowerCase();
  const channel = (await listChannels(ctx.db, person, ctx.orgId)).find((c) => c.name === wanted);
  return channel ?? `They see no channel #${wanted}.`;
}

// ── Roles ────────────────────────────────────────────────────────────────────

/** What each key lets a role's people do, for the model choosing them. */
const KEY_WORDS =
  "post: write in channels; create_channels; mention_everyone; manage_channels: rename, archive and arrange channels; talk_to_agents; assign_work: give agents long work; manage_routines: any agent's routines; approve_actions: decide agents' approvals (merges, deploys, emails); create_agents; manage_agents: change any agent; pair_computers; own_browsers, own_computers: their own agents' browser or computer; control_browsers, control_computers: every agent's; manage_connectors: connect apps; manage_credentials: AI keys; use_others_plans; edit_wiki; upload_files; review_memory: agents' memory and instructions; invite_people; view_usage; view_audit; configure: the workspace's settings; manage_members: people's roles and removing people; manage_roles; manage_billing; administrator: all of them.";

const KEYS = { type: "array", items: { enum: [...ROLE_PERMISSIONS] }, maxItems: ROLE_PERMISSIONS.length };

/** The fields a role change can touch, as Undo compares and puts them back. */
const ROLE_FIELDS = ["name", "icon", "color", "permissions", "mentionable", "hoist"] as const;
type RoleRow = typeof orgRoles.$inferSelect;
const roleSnapshot = (r: RoleRow, fields: readonly string[] = ROLE_FIELDS) =>
  Object.fromEntries(
    fields.map((f) => [f, f === "permissions" ? [...r.permissions].sort() : r[f as (typeof ROLE_FIELDS)[number]]]),
  );

async function roleRow(db: Database, orgId: string, id: string) {
  const [row] = await db
    .select()
    .from(orgRoles)
    .where(and(eq(orgRoles.orgId, orgId), eq(orgRoles.id, id)));
  return row ?? null;
}

/** Whether anyone or anything holds the role: its people, a channel's audience or exception, a pending invitation. */
const roleInUse = async (db: Database, orgId: string, roleId: string) =>
  (
    await db
      .select({
        used: sql<boolean>`exists (select 1 from ${organizationMemberRoles} where ${organizationMemberRoles.orgId} = ${orgId}
            and ${organizationMemberRoles.roleId} = ${roleId})
          or exists (select 1 from ${channelPermissionOverrides} where ${channelPermissionOverrides.orgId} = ${orgId}
            and ${channelPermissionOverrides.roleId} = ${roleId})
          or exists (select 1 from ${channels} where ${channels.orgId} = ${orgId}
            and ${roleId}::uuid = any(${channels.audienceRoleIds}))
          or exists (select 1 from ${organizationInvitations} where ${organizationInvitations.orgId} = ${orgId}
            and ${organizationInvitations.acceptedAt} is null and ${roleId}::uuid = any(${organizationInvitations.roleIds}))`,
      })
      .from(orgRoles)
      .where(and(eq(orgRoles.orgId, orgId), eq(orgRoles.id, roleId)))
  )[0]?.used === true;

/** The custom roles' ids, top first. */
const roleOrder = async (db: Database, orgId: string) =>
  (
    await db
      .select({ id: orgRoles.id })
      .from(orgRoles)
      .where(and(eq(orgRoles.orgId, orgId), eq(orgRoles.kind, "custom")))
      .orderBy(asc(orgRoles.position), asc(orgRoles.name))
  ).map((r) => r.id);

const roleTarget = (r: Pick<RoleRow, "id" | "name">): AgentActionTarget => ({ type: "role", id: r.id, title: r.name });

const createRoleAction: WorkspaceAction = {
  id: "create_role",
  does: "Create a role with what its people may do (permission keys), its color and icon.",
  input: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, maxLength: ROLE_NAME_MAX },
      permissions: { ...KEYS, description: KEY_WORDS },
      color: { enum: [...ROLE_COLORS] },
      icon: { enum: [...ROLE_ICONS] },
      mentionable: { type: "boolean", description: "Whether @role mentions its people (default true)." },
      hoist: { type: "boolean", description: "Its people listed apart in the members column." },
    },
    required: ["name"],
    additionalProperties: false,
  },
  mode: "now",
  needs: "manage_roles",
  async resolve(_ctx, _person, input) {
    return { input, words: { name: str(input.name) } };
  },
  async run(deps, actorId, orgId, input) {
    const role = await createRole(
      deps.db,
      actorId,
      orgId,
      {
        name: str(input.name),
        permissions: list(input.permissions),
        ...(str(input.color) ? { color: str(input.color) } : {}),
        ...(str(input.icon) ? { icon: str(input.icon) } : {}),
        ...(typeof input.mentionable === "boolean" ? { mentionable: input.mentionable } : {}),
        ...(typeof input.hoist === "boolean" ? { hoist: input.hoist } : {}),
      },
      deps,
    );
    return { target: roleTarget(role), words: { name: role.name }, after: roleSnapshot(role) };
  },
  async revert(deps, actorId, a, direction, changedSince) {
    const after = obj(a.after);
    if (direction === "redo") {
      const role = await createRole(deps.db, actorId, a.orgId, after as Parameters<typeof createRole>[3], deps);
      return { roleId: role.id };
    }
    const id = str(obj(a.state).roleId) || a.targetId;
    const role = await roleRow(deps.db, a.orgId, id);
    if (!role) throw new NotFoundError("The role is gone", "action.target_gone");
    // Changed since, or given to someone or something since: deleting it would take that away too.
    if (!same(roleSnapshot(role), after) || (await roleInUse(deps.db, a.orgId, id))) throw changedSince();
    await deleteRole(deps.db, actorId, a.orgId, id, deps);
    return undefined;
  },
};

const updateRoleAction: WorkspaceAction = {
  id: "update_role",
  does: "Change a role: its name, color or icon, the permission keys it gives or takes, its switches.",
  input: {
    type: "object",
    properties: {
      role: { type: "string", minLength: 1, maxLength: 80, description: "Its name (everyone: the base role)." },
      name: { type: "string", minLength: 1, maxLength: ROLE_NAME_MAX },
      color: { enum: [...ROLE_COLORS] },
      icon: { enum: [...ROLE_ICONS] },
      add_permissions: { ...KEYS, description: KEY_WORDS },
      remove_permissions: KEYS,
      mentionable: { type: "boolean" },
      hoist: { type: "boolean" },
    },
    required: ["role"],
    additionalProperties: false,
  },
  mode: "now",
  needs: "manage_roles",
  async resolve(ctx, _person, input) {
    const role = await roleNamed(ctx, str(input.role));
    if (typeof role === "string") return role;
    const { role: _, ...rest } = input;
    return { input: { ...rest, roleId: role.id }, words: { name: role.name } };
  },
  async run(deps, actorId, orgId, input) {
    const role = await roleRow(deps.db, orgId, str(input.roleId));
    if (!role) throw new NotFoundError("Role not found");
    const add = list(input.add_permissions);
    const take = list(input.remove_permissions);
    const patch: Record<string, unknown> = {};
    for (const f of ["name", "color", "icon"] as const) if (str(input[f])) patch[f] = str(input[f]);
    for (const f of ["mentionable", "hoist"] as const) if (typeof input[f] === "boolean") patch[f] = input[f];
    if (add.length || take.length)
      patch.permissions = [...new Set([...role.permissions, ...add])].filter((k) => !take.includes(k));
    const fields = Object.keys(patch);
    if (fields.length === 0) throw new ValidationError("Say what changes on the role");
    const updated = await updateRole(deps.db, actorId, orgId, role.id, patch, deps);
    const before = roleSnapshot(role, fields);
    const after = roleSnapshot(updated, fields);
    if (same(before, after)) throw new ValidationError(`${role.name} already is like that`);
    return { target: roleTarget(updated), words: { name: updated.name }, before, after };
  },
  async revert(deps, actorId, a, direction, changedSince) {
    const [from, to] = direction === "undo" ? [obj(a.after), obj(a.before)] : [obj(a.before), obj(a.after)];
    const role = await roleRow(deps.db, a.orgId, a.targetId);
    if (!role) throw new NotFoundError("The role is gone", "action.target_gone");
    if (!same(roleSnapshot(role, Object.keys(from)), from)) throw changedSince();
    await updateRole(deps.db, actorId, a.orgId, role.id, to, deps);
    return undefined;
  },
};

const deleteRoleAction: WorkspaceAction = {
  id: "delete_role",
  does: "Delete a role for good: whoever held it keeps their other roles.",
  input: {
    type: "object",
    properties: { role: { type: "string", minLength: 1, maxLength: 80 } },
    required: ["role"],
    additionalProperties: false,
  },
  mode: "card",
  needs: "manage_roles",
  async resolve(ctx, _person, input) {
    const role = await roleNamed(ctx, str(input.role));
    if (typeof role === "string") return role;
    if (role.kind === "everyone") return "The base role (everyone) can't be deleted.";
    return { input: { roleId: role.id }, words: { name: role.name } };
  },
  async run(deps, actorId, orgId, input) {
    const role = await roleRow(deps.db, orgId, str(input.roleId));
    if (!role) throw new NotFoundError("Role not found");
    await deleteRole(deps.db, actorId, orgId, role.id, deps);
    return { target: roleTarget(role), words: { name: role.name }, final: true };
  },
};

const moveRoleAction: WorkspaceAction = {
  id: "move_role",
  does: "Move a role above or below another (order is rank: people only manage roles below their own).",
  input: {
    type: "object",
    properties: {
      role: { type: "string", minLength: 1, maxLength: 80 },
      above: { type: "string", minLength: 1, maxLength: 80, description: "Right above this role." },
      below: { type: "string", minLength: 1, maxLength: 80, description: "Right below this role." },
    },
    required: ["role"],
    additionalProperties: false,
  },
  mode: "now",
  needs: "manage_roles",
  async resolve(ctx, _person, input) {
    const role = await roleNamed(ctx, str(input.role));
    if (typeof role === "string") return role;
    const anchorName = str(input.above) || str(input.below);
    if (!anchorName) return "Say which role it goes above or below.";
    const anchor = await roleNamed(ctx, anchorName);
    if (typeof anchor === "string") return anchor;
    if (role.kind === "everyone" || anchor.kind === "everyone") return "The base role (everyone) is always last.";
    if (anchor.id === role.id) return "A role can't move next to itself.";
    return {
      input: { roleId: role.id, anchorId: anchor.id, above: Boolean(str(input.above)) },
      words: { name: role.name, other: anchor.name },
    };
  },
  async run(deps, actorId, orgId, input) {
    const role = await roleRow(deps.db, orgId, str(input.roleId));
    if (!role) throw new NotFoundError("Role not found");
    const before = await roleOrder(deps.db, orgId);
    const rest = before.filter((id) => id !== role.id);
    const at = rest.indexOf(str(input.anchorId));
    if (at < 0) throw new NotFoundError("Role not found");
    const after = [...rest.slice(0, input.above ? at : at + 1), role.id, ...rest.slice(input.above ? at : at + 1)];
    if (same(before, after)) throw new ValidationError(`${role.name} is already there`);
    await reorderRoles(deps.db, actorId, orgId, after, deps);
    return { target: roleTarget(role), words: { name: role.name }, before: { order: before }, after: { order: after } };
  },
  async revert(deps, actorId, a, direction, changedSince) {
    const [from, to] = direction === "undo" ? [obj(a.after), obj(a.before)] : [obj(a.before), obj(a.after)];
    if (!same(await roleOrder(deps.db, a.orgId), from.order)) throw changedSince();
    await reorderRoles(deps.db, actorId, a.orgId, to.order as string[], deps);
    return undefined;
  },
};

const setMemberRolesAction: WorkspaceAction = {
  id: "set_member_roles",
  does: "Give a person roles or take roles from them.",
  input: {
    type: "object",
    properties: {
      person: { type: "string", minLength: 1, maxLength: 200, description: "@handle, email or name." },
      add_roles: { type: "array", items: { type: "string", minLength: 1, maxLength: 80 }, maxItems: 20 },
      remove_roles: { type: "array", items: { type: "string", minLength: 1, maxLength: 80 }, maxItems: 20 },
    },
    required: ["person"],
    additionalProperties: false,
  },
  mode: "now",
  needs: "manage_members",
  async resolve(ctx, _person, input) {
    const who = await personNamed(ctx, str(input.person));
    if (typeof who === "string") return who;
    const roles = await givenRoles(ctx, input);
    if (typeof roles === "string") return roles;
    const { add, take } = roles;
    return {
      input: { userId: who.userId, name: who.name, add: add.map((r) => r.id), remove: take.map((r) => r.id) },
      words: { name: who.name, change: roleChange(add, take) },
    };
  },
  async run(deps, actorId, orgId, input) {
    const userId = str(input.userId);
    const add = list(input.add);
    const take = list(input.remove);
    const before = await memberRoleIds(deps.db, orgId, userId);
    const next = [...new Set([...before, ...add])].filter((id) => !take.includes(id));
    if (sameSet(before, next)) throw new ValidationError(`${str(input.name)} already has those roles`);
    await setMemberRoles(deps.db, actorId, orgId, userId, next, deps);
    const names = await roleNames(deps.db, orgId, [...add, ...take]);
    const pick = (ids: string[]) => ids.map((id) => ({ name: names.get(id) ?? "" }));
    return {
      target: { type: "person", id: userId, title: str(input.name) },
      words: { name: str(input.name), change: roleChange(pick(add), pick(take)) },
      before: { roleIds: before },
      after: { roleIds: next },
    };
  },
  async revert(deps, actorId, a, direction, changedSince) {
    const [from, to] = direction === "undo" ? [obj(a.after), obj(a.before)] : [obj(a.before), obj(a.after)];
    if (!sameSet(await memberRoleIds(deps.db, a.orgId, a.targetId), list(from.roleIds))) throw changedSince();
    await setMemberRoles(deps.db, actorId, a.orgId, a.targetId, list(to.roleIds), deps);
    return undefined;
  },
};

/** The custom roles an entry gives (`add_roles`) and takes (`remove_roles`), by name, or why not. */
async function givenRoles(ctx: Pick<ToolContext, "db" | "orgId">, input: Input) {
  const pick = async (names: string[]) => {
    const out: { id: string; name: string }[] = [];
    for (const n of names) {
      const role = await roleNamed(ctx, n);
      if (typeof role === "string") return role;
      if (role.kind === "everyone") return "Everyone holds the base role (everyone): it isn't given or taken.";
      out.push(role);
    }
    return out;
  };
  const add = await pick(list(input.add_roles));
  if (typeof add === "string") return add;
  const take = await pick(list(input.remove_roles));
  if (typeof take === "string") return take;
  if (add.length + take.length === 0) return "Say which roles are given or taken.";
  return { add, take };
}

/** "+ Marketing, − Vendas": the same in every language. */
const roleChange = (add: { name: string }[], take: { name: string }[]) =>
  [...add.map((r) => `+ ${r.name}`), ...take.map((r) => `− ${r.name}`)].join(", ");

async function roleNames(db: Database, orgId: string, ids: string[]) {
  if (ids.length === 0) return new Map<string, string>();
  const rows = await db
    .select({ id: orgRoles.id, name: orgRoles.name })
    .from(orgRoles)
    .where(and(eq(orgRoles.orgId, orgId), inArray(orgRoles.id, ids)));
  return new Map(rows.map((r) => [r.id, r.name]));
}

const CHANNEL_KEY_LIST = { type: "array", items: { enum: [...CHANNEL_KEYS] }, maxItems: CHANNEL_KEYS.length };

/** A channel exception's keys now (null: none). */
async function overrideNow(db: Database, channelId: string, target: { type: "role" | "person"; id: string }) {
  const [row] = await db
    .select({ allow: channelPermissionOverrides.allow, deny: channelPermissionOverrides.deny })
    .from(channelPermissionOverrides)
    .where(
      and(
        eq(channelPermissionOverrides.channelId, channelId),
        target.type === "role"
          ? eq(channelPermissionOverrides.roleId, target.id)
          : eq(channelPermissionOverrides.userId, target.id),
      ),
    );
  return row ? { allow: [...row.allow].sort(), deny: [...row.deny].sort() } : { allow: [], deny: [] };
}

const channelPermissionsAction: WorkspaceAction = {
  id: "set_channel_permissions",
  does: "In one channel, allow or deny a role or a person to post, to talk to agents or to manage the channel, against what their roles say; clear: back to their roles.",
  input: {
    type: "object",
    properties: {
      channel: { type: "string", minLength: 1, maxLength: 81 },
      role: { type: "string", minLength: 1, maxLength: 80, description: "A role, or everyone." },
      person: { type: "string", minLength: 1, maxLength: 200 },
      allow: CHANNEL_KEY_LIST,
      deny: CHANNEL_KEY_LIST,
      clear: { type: "boolean", description: "True: remove this role's or person's exception." },
    },
    required: ["channel"],
    additionalProperties: false,
  },
  mode: "now",
  needs: "manage_channels",
  async resolve(ctx, person, input) {
    const channel = await channelNamed(ctx, person, str(input.channel));
    if (typeof channel === "string") return channel;
    let target: { type: "role" | "person"; id: string; name: string };
    if (str(input.role)) {
      const role = await roleNamed(ctx, str(input.role));
      if (typeof role === "string") return role;
      target = { type: "role", id: role.id, name: role.name };
    } else if (str(input.person)) {
      const who = await personNamed(ctx, str(input.person));
      if (typeof who === "string") return who;
      target = { type: "person", id: who.userId, name: who.name };
    } else return "Say for which role or person.";
    const allow = input.clear === true ? [] : list(input.allow);
    const deny = input.clear === true ? [] : list(input.deny);
    if (input.clear !== true && allow.length + deny.length === 0) return "Say what to allow or deny, or clear.";
    return {
      input: { channelId: channel.id, channel: channel.name, target, allow, deny },
      words: { channel: channel.name, who: target.name },
    };
  },
  async run(deps, actorId, orgId, input) {
    const channelId = str(input.channelId);
    const target = obj(input.target) as { type: "role" | "person"; id: string; name: string };
    const before = await overrideNow(deps.db, channelId, target);
    const after = { allow: list(input.allow).sort(), deny: list(input.deny).sort() };
    if (same(before, after)) throw new ValidationError("That channel already has that exception");
    await setChannelOverride(deps.db, actorId, orgId, channelId, { target, ...after }, deps);
    return {
      target: { type: "channel", id: channelId, title: str(input.channel) },
      words: { channel: str(input.channel), who: target.name },
      before: { target, ...before },
      after: { target, ...after },
    };
  },
  async revert(deps, actorId, a, direction, changedSince) {
    const [from, to] = direction === "undo" ? [obj(a.after), obj(a.before)] : [obj(a.before), obj(a.after)];
    const target = obj(from.target) as { type: "role" | "person"; id: string };
    if (!same(await overrideNow(deps.db, a.targetId, target), { allow: from.allow, deny: from.deny }))
      throw changedSince();
    await setChannelOverride(
      deps.db,
      actorId,
      a.orgId,
      a.targetId,
      { target, allow: list(to.allow), deny: list(to.deny) },
      deps,
    );
    return undefined;
  },
};

// ── Their own status ─────────────────────────────────────────────────────────

/** A person's status in this workspace, as Undo compares and puts it back. */
async function statusNow(db: Database, orgId: string, userId: string) {
  const [row] = await db
    .select({
      availability: organizationMembers.availability,
      text: organizationMembers.statusText,
      emoji: organizationMembers.statusEmoji,
      until: organizationMembers.statusUntil,
    })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)));
  return {
    availability: row?.availability ?? "auto",
    status: row?.text ? { text: row.text, emoji: row.emoji, until: row.until?.toISOString() ?? null } : null,
  };
}

const setStatusAction: WorkspaceAction = {
  id: "set_my_status",
  does: "Set their own status: away, busy, out of office or back (auto), and what they are doing until when.",
  input: {
    type: "object",
    properties: {
      availability: { enum: [...AVAILABILITIES], description: "auto: back, as their activity says." },
      text: { type: "string", maxLength: 100, description: "What they are doing (empty clears it)." },
      emoji: { type: "string", maxLength: 16 },
      until: { type: "string", maxLength: 40, description: "When it ends, ISO 8601 with its offset." },
    },
    additionalProperties: false,
  },
  mode: "now",
  needs: null,
  self: true,
  async resolve(_ctx, _person, input) {
    if (input.availability === undefined && input.text === undefined) return "Say their availability or status.";
    return { input, words: { what: str(input.text), availability: str(input.availability) } };
  },
  async run(deps, actorId, orgId, input) {
    const before = await statusNow(deps.db, orgId, actorId);
    await setMyStatus(deps, actorId, orgId, {
      ...(input.availability !== undefined ? { availability: input.availability as Availability } : {}),
      ...(input.text !== undefined
        ? {
            status: str(input.text)
              ? { text: str(input.text), emoji: str(input.emoji) || null, until: str(input.until) || null }
              : null,
          }
        : {}),
    });
    const after = await statusNow(deps.db, orgId, actorId);
    return {
      target: { type: "person", id: actorId },
      words: { what: after.status?.text ?? "", availability: after.availability },
      before,
      after,
    };
  },
  async revert(deps, actorId, a, direction, changedSince) {
    const [from, to] = direction === "undo" ? [obj(a.after), obj(a.before)] : [obj(a.before), obj(a.after)];
    if (actorId !== a.targetId) throw new ForbiddenError("Only they change their own status", "action.not_allowed");
    if (!same(await statusNow(deps.db, a.orgId, actorId), from)) throw changedSince();
    // A line whose time ran out meanwhile comes back as no line: the screen takes no `until` in the past either.
    const until = str(obj(to.status).until);
    const status = until && Date.parse(until) <= Date.now() ? null : to.status;
    await setMyStatus(deps, actorId, a.orgId, { ...to, status } as Parameters<typeof setMyStatus>[3]);
    return undefined;
  },
};

const notificationsAction: WorkspaceAction = {
  id: "set_notifications",
  does: "Turn one kind of their notifications in this workspace on or off (the inbox keeps everything).",
  input: {
    type: "object",
    properties: {
      category: {
        enum: [...NOTICE_CATEGORIES],
        description:
          "waiting: approvals and questions for them; replies: agents' answers; mentions: mentions and DMs; threads: threads they follow; tasks; routines: routines and missions; computers; reactions.",
      },
      on: { type: "boolean" },
    },
    required: ["category", "on"],
    additionalProperties: false,
  },
  mode: "now",
  needs: null,
  self: true,
  async resolve(_ctx, _person, input) {
    return { input, words: { category: str(input.category), variant: input.on === true ? "on" : "off" } };
  },
  async run(deps, actorId, orgId, input) {
    const category = str(input.category) as NoticeCategory;
    const on = input.on === true;
    const before = (await noticePrefsView(deps.db, orgId, actorId)).categories.find((c) => c.id === category)?.on;
    if (before === on) throw new ValidationError("Their notifications are already like that");
    await setNoticePref(deps.db, orgId, actorId, category, on);
    return {
      target: { type: "person", id: actorId },
      words: { category, variant: on ? "on" : "off" },
      before: { category, on: !on },
      after: { category, on },
    };
  },
  async revert(deps, actorId, a, direction, changedSince) {
    const [from, to] = direction === "undo" ? [obj(a.after), obj(a.before)] : [obj(a.before), obj(a.after)];
    if (actorId !== a.targetId) throw new ForbiddenError("Only they change their notifications", "action.not_allowed");
    const category = str(from.category) as NoticeCategory;
    const now = (await noticePrefsView(deps.db, a.orgId, actorId)).categories.find((c) => c.id === category)?.on;
    if (now !== from.on) throw changedSince();
    await setNoticePref(deps.db, a.orgId, actorId, category, to.on === true);
    return undefined;
  },
};

/** Their own time zone here (null: the workspace's). */
const timezoneNow = async (db: Database, orgId: string, userId: string) =>
  (
    await db
      .select({ timezone: organizationMembers.timezone })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)))
  )[0]?.timezone ?? null;

const timezoneWords = (timezone: string | null): Record<string, string> =>
  timezone ? { timezone } : { timezone: "", variant: "workspace" };

const timezoneAction: WorkspaceAction = {
  id: "set_my_timezone",
  does: "Set their own time zone in this workspace, or follow the workspace's again.",
  input: {
    type: "object",
    properties: {
      timezone: {
        type: "string",
        minLength: 1,
        maxLength: 64,
        description: 'IANA, e.g. Europe/Lisbon, or "workspace" to follow the workspace\'s.',
      },
    },
    required: ["timezone"],
    additionalProperties: false,
  },
  mode: "now",
  needs: null,
  self: true,
  async resolve(_ctx, _person, input) {
    const timezone = str(input.timezone);
    return { input: { timezone }, words: timezoneWords(timezone === "workspace" ? null : timezone) };
  },
  async run(deps, actorId, orgId, input) {
    const wanted = str(input.timezone) === "workspace" ? null : str(input.timezone);
    const before = await timezoneNow(deps.db, orgId, actorId);
    if (before === wanted) throw new ValidationError("Their time zone already is that");
    await updateMyProfile(deps.db, actorId, orgId, { timezone: wanted });
    await announceMembers(deps.pubsub, orgId);
    return {
      target: { type: "person", id: actorId },
      words: timezoneWords(wanted),
      before: { timezone: before },
      after: { timezone: wanted },
    };
  },
  async revert(deps, actorId, a, direction, changedSince) {
    const [from, to] = direction === "undo" ? [obj(a.after), obj(a.before)] : [obj(a.before), obj(a.after)];
    if (actorId !== a.targetId) throw new ForbiddenError("Only they change their time zone", "action.not_allowed");
    if ((await timezoneNow(deps.db, a.orgId, actorId)) !== (from.timezone ?? null)) throw changedSince();
    await updateMyProfile(deps.db, actorId, a.orgId, { timezone: (to.timezone as string | null) ?? null });
    await announceMembers(deps.pubsub, a.orgId);
    return undefined;
  },
};

// ── Channels ─────────────────────────────────────────────────────────────────

type ChannelRow = typeof channels.$inferSelect;

async function channelRow(db: Database, orgId: string, id: string) {
  const [row] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.orgId, orgId), eq(channels.id, id)));
  return row ?? null;
}

const CHANNEL_REF = { type: "string", minLength: 1, maxLength: 81, description: "Its name, with or without #." };
const channelTarget = (c: Pick<ChannelRow, "id" | "name">): AgentActionTarget => ({
  type: "channel",
  id: c.id,
  title: c.name,
});
/** With its roles' audience: made public, a private channel forgets them, and Undo gives them back. */
const channelSnapshot = (c: ChannelRow) => ({
  name: c.name,
  topic: c.topic,
  visibility: c.visibility,
  audienceRoleIds: [...c.audienceRoleIds],
});

const updateChannelAction: WorkspaceAction = {
  id: "update_channel",
  does: "Rename a channel, change its topic, or make it private (invite only) or public.",
  input: {
    type: "object",
    properties: {
      channel: CHANNEL_REF,
      name: { type: "string", minLength: 1, maxLength: 80, description: "Lower-case letters, digits, - or _." },
      topic: { type: "string", maxLength: 500 },
      private: { type: "boolean" },
    },
    required: ["channel"],
    additionalProperties: false,
  },
  mode: "now",
  needs: "manage_channels",
  async resolve(ctx, person, input) {
    const channel = await channelNamed(ctx, person, str(input.channel));
    if (typeof channel === "string") return channel;
    if (input.name === undefined && input.topic === undefined && input.private === undefined)
      return "Say what changes: its name, topic or whether it is private.";
    const { channel: _, ...rest } = input;
    return { input: { ...rest, channelId: channel.id }, words: { channel: channel.name } };
  },
  async run(deps, actorId, orgId, input) {
    const row = await channelRow(deps.db, orgId, str(input.channelId));
    if (!row) throw new NotFoundError("Channel not found");
    const before = channelSnapshot(row);
    const updated = await updateChannel(
      deps.db,
      actorId,
      orgId,
      row.id,
      {
        ...(str(input.name) ? { name: str(input.name).replace(/^#/, "") } : {}),
        ...(typeof input.topic === "string" ? { topic: input.topic } : {}),
        ...(typeof input.private === "boolean" ? { visibility: input.private ? "private" : "public" } : {}),
      },
      deps,
    );
    const after = channelSnapshot(updated);
    if (same(before, after)) throw new ValidationError(`#${row.name} already is like that`);
    return { target: channelTarget(updated), words: { channel: updated.name }, before, after };
  },
  async revert(deps, actorId, a, direction, changedSince) {
    const [from, to] = direction === "undo" ? [obj(a.after), obj(a.before)] : [obj(a.before), obj(a.after)];
    const row = await channelRow(deps.db, a.orgId, a.targetId);
    if (!row || row.archivedAt) throw new NotFoundError("The channel is gone", "action.target_gone");
    if (!same(channelSnapshot(row), from)) throw changedSince();
    const access = same([from.visibility, from.audienceRoleIds], [to.visibility, to.audienceRoleIds])
      ? {}
      : { visibility: to.visibility as "public" | "private", audienceRoleIds: list(to.audienceRoleIds) };
    await updateChannel(
      deps.db,
      actorId,
      a.orgId,
      row.id,
      { name: str(to.name), topic: String(to.topic ?? ""), ...access },
      deps,
    );
    return undefined;
  },
};

/** Whether `person` sees this channel as `listChannels` would: public, theirs, through a role of theirs, or an admin. */
async function seesChannel(
  db: Database,
  orgId: string,
  person: string,
  c: { id: string; visibility: string; audienceRoleIds: string[] },
) {
  if (c.visibility === "public" || can(await getMembership(db, person, orgId), "administrator")) return true;
  const roles = await memberRoleIds(db, orgId, person);
  if (c.audienceRoleIds.some((id) => roles.includes(id))) return true;
  const [seat] = await db
    .select({ id: channelMembers.id })
    .from(channelMembers)
    .where(and(eq(channelMembers.channelId, c.id), eq(channelMembers.userId, person)))
    .limit(1);
  return Boolean(seat);
}

/** Archives or brings back, the other one undoing it. */
async function setArchived(deps: ActionDeps, actorId: string, orgId: string, id: string, archived: boolean) {
  if (archived) await archiveChannel(deps.db, actorId, orgId, id, deps);
  else await unarchiveChannel(deps.db, actorId, orgId, id, deps);
}

const archiveChannelAction: WorkspaceAction = {
  id: "archive_channel",
  does: "Archive a channel (it leaves everyone's list; its messages stay) or bring an archived one back.",
  input: {
    type: "object",
    properties: { channel: CHANNEL_REF, back: { type: "boolean", description: "True: bring it back." } },
    required: ["channel"],
    additionalProperties: false,
  },
  mode: "now",
  needs: "manage_channels",
  async resolve(ctx, person, input) {
    const name = str(input.channel).replace(/^#/, "").toLowerCase();
    if (input.back === true) {
      const [row] = await ctx.db
        .select({
          id: channels.id,
          name: channels.name,
          visibility: channels.visibility,
          audienceRoleIds: channels.audienceRoleIds,
        })
        .from(channels)
        .where(
          and(
            eq(channels.orgId, ctx.orgId),
            eq(channels.kind, "channel"),
            eq(channels.name, name),
            isNotNull(channels.archivedAt),
            isNull(channels.deletedAt),
          ),
        );
      // Only one they could see in the list (`listChannels`' rule): a private one they're not in stays unnamed.
      if (!row || !(await seesChannel(ctx.db, ctx.orgId, person, row))) return `No archived channel #${name}.`;
      return { input: { channelId: row.id, back: true }, words: { channel: row.name, variant: "back" } };
    }
    const channel = await channelNamed(ctx, person, name);
    if (typeof channel === "string") return channel;
    const words: Record<string, string> = { channel: channel.name };
    return { input: { channelId: channel.id, back: false }, words };
  },
  async run(deps, actorId, orgId, input) {
    const row = await channelRow(deps.db, orgId, str(input.channelId));
    if (!row) throw new NotFoundError("Channel not found");
    const archive = input.back !== true;
    await setArchived(deps, actorId, orgId, row.id, archive);
    return {
      target: channelTarget(row),
      words: { channel: row.name, ...(archive ? {} : { variant: "back" }) },
      after: { archived: archive },
    };
  },
  async revert(deps, actorId, a, direction, changedSince) {
    const archived = obj(a.after).archived === true;
    const row = await channelRow(deps.db, a.orgId, a.targetId);
    if (!row || row.deletedAt) throw new NotFoundError("The channel is gone", "action.target_gone");
    const wanted = direction === "undo" ? !archived : archived;
    if (Boolean(row.archivedAt) === wanted) throw changedSince();
    await setArchived(deps, actorId, a.orgId, row.id, wanted);
    return undefined;
  },
};

const channelPeopleAction: WorkspaceAction = {
  id: "channel_people",
  does: "Add people to a channel, or take someone out of it.",
  input: {
    type: "object",
    properties: {
      channel: CHANNEL_REF,
      add: { type: "array", items: { type: "string", minLength: 1, maxLength: 200 }, maxItems: 20 },
      remove: { type: "array", items: { type: "string", minLength: 1, maxLength: 200 }, maxItems: 20 },
    },
    required: ["channel"],
    additionalProperties: false,
  },
  mode: "now",
  needs: "manage_channels",
  async resolve(ctx, person, input) {
    const channel = await channelNamed(ctx, person, str(input.channel));
    if (typeof channel === "string") return channel;
    const pick = async (names: string[]) => {
      const out: { userId: string; name: string }[] = [];
      for (const n of names) {
        const who = await personNamed(ctx, n);
        if (typeof who === "string") return who;
        out.push({ userId: who.userId, name: who.name });
      }
      return out;
    };
    const add = await pick(list(input.add));
    if (typeof add === "string") return add;
    const take = await pick(list(input.remove));
    if (typeof take === "string") return take;
    if (add.length + take.length === 0) return "Say who joins or leaves it.";
    return {
      input: { channelId: channel.id, channel: channel.name, add, remove: take },
      words: { channel: channel.name, change: peopleChange(add, take) },
    };
  },
  async run(deps, actorId, orgId, input) {
    const channelId = str(input.channelId);
    const seated = new Set(
      (
        await deps.db
          .select({ userId: channelMembers.userId })
          .from(channelMembers)
          .where(and(eq(channelMembers.channelId, channelId), isNotNull(channelMembers.userId)))
      ).map((r) => r.userId),
    );
    const people = (v: unknown) => (Array.isArray(v) ? (v as { userId: string; name: string }[]) : []);
    const add = people(input.add).filter((p) => !seated.has(p.userId));
    const take = people(input.remove).filter((p) => seated.has(p.userId));
    if (add.length + take.length === 0) throw new ValidationError(`#${str(input.channel)} already has them like that`);
    for (const p of add) await addChannelMember(deps.db, actorId, orgId, channelId, { userId: p.userId }, deps);
    for (const p of take) await removeChannelMember(deps.db, actorId, orgId, channelId, { userId: p.userId }, deps);
    return {
      target: { type: "channel", id: channelId, title: str(input.channel) },
      words: { channel: str(input.channel), change: peopleChange(add, take) },
      after: { added: add.map((p) => p.userId), removed: take.map((p) => p.userId) },
    };
  },
  async revert(deps, actorId, a, direction, changedSince) {
    const { added, removed } = obj(a.after) as { added?: string[]; removed?: string[] };
    const [put, out] = direction === "undo" ? [removed ?? [], added ?? []] : [added ?? [], removed ?? []];
    const seated = new Set(
      (
        await deps.db
          .select({ userId: channelMembers.userId })
          .from(channelMembers)
          .where(and(eq(channelMembers.channelId, a.targetId), isNotNull(channelMembers.userId)))
      ).map((r) => r.userId),
    );
    if (put.some((id) => seated.has(id)) || out.some((id) => !seated.has(id))) throw changedSince();
    for (const userId of out) await removeChannelMember(deps.db, actorId, a.orgId, a.targetId, { userId }, deps);
    for (const userId of put) await addChannelMember(deps.db, actorId, a.orgId, a.targetId, { userId }, deps);
    return undefined;
  },
};

/** "+ Nina, − Caio": the same in every language. */
const peopleChange = (add: { name: string }[], take: { name: string }[]) =>
  [...add.map((p) => `+ ${p.name}`), ...take.map((p) => `− ${p.name}`)].join(", ");

const deleteChannelAction: WorkspaceAction = {
  id: "delete_channel",
  does: "Delete a channel for good, its messages and files with it (archive_channel keeps them).",
  input: { type: "object", properties: { channel: CHANNEL_REF }, required: ["channel"], additionalProperties: false },
  mode: "card",
  needs: "manage_channels",
  async resolve(ctx, person, input) {
    const channel = await channelNamed(ctx, person, str(input.channel));
    if (typeof channel === "string") return channel;
    return { input: { channelId: channel.id }, words: { channel: channel.name } };
  },
  async run(deps, actorId, orgId, input) {
    const row = await channelRow(deps.db, orgId, str(input.channelId));
    if (!row) throw new NotFoundError("Channel not found");
    if (!deps.pubsub) throw new Error("Deleting a channel needs the server's events");
    // Its card is the confirmation the screen asks for by the typed name.
    await deleteChannel(
      { db: deps.db, pubsub: deps.pubsub, hub: deps.hub ?? null, mail: deps.mail ?? null },
      actorId,
      orgId,
      row.id,
      row.name,
    );
    return { target: channelTarget(row), words: { channel: row.name }, final: true };
  },
};

// ── People ───────────────────────────────────────────────────────────────────

/** A pending invitation to `email` (any case), or 404. */
async function pendingInvitation(db: Database, orgId: string, email: string) {
  const [row] = await db
    .select({ id: organizationInvitations.id, email: organizationInvitations.email })
    .from(organizationInvitations)
    .where(
      and(
        eq(organizationInvitations.orgId, orgId),
        sql`lower(${organizationInvitations.email}) = ${email.toLowerCase()}`,
        isNull(organizationInvitations.acceptedAt),
      ),
    );
  if (!row) throw new NotFoundError(`No pending invitation for ${email}`);
  return row;
}

const revokeInvitationAction: WorkspaceAction = {
  id: "revoke_invitation",
  does: "Cancel a pending invitation to the workspace: its link stops working.",
  input: {
    type: "object",
    properties: { email: { type: "string", minLength: 3, maxLength: 254 } },
    required: ["email"],
    additionalProperties: false,
  },
  mode: "now",
  needs: "invite_people",
  // Looked up when it runs, as whoever may invite: someone who can't learns nothing of who was invited.
  async resolve(_ctx, _person, input) {
    const email = str(input.email).toLowerCase();
    return { input: { email }, words: { email } };
  },
  async run(deps, actorId, orgId, input) {
    await requirePermission(deps.db, actorId, orgId, "invite_people");
    const row = await pendingInvitation(deps.db, orgId, str(input.email));
    await revokeInvitation(deps.db, actorId, orgId, row.id);
    return { target: { type: "person", id: row.id, title: row.email }, words: { email: row.email }, final: true };
  },
};

/** The roles a pending invitation gives (ids), as Undo compares and puts them back. */
const invitationRoles = async (db: Database, id: string) =>
  (
    await db
      .select({ roleIds: organizationInvitations.roleIds })
      .from(organizationInvitations)
      .where(eq(organizationInvitations.id, id))
  )[0]?.roleIds ?? [];

const invitationRolesAction: WorkspaceAction = {
  id: "set_invitation_roles",
  does: "Change the roles a pending invitation gives: the same link, nothing is sent.",
  input: {
    type: "object",
    properties: {
      email: { type: "string", minLength: 3, maxLength: 254 },
      add_roles: { type: "array", items: { type: "string", minLength: 1, maxLength: 80 }, maxItems: 20 },
      remove_roles: { type: "array", items: { type: "string", minLength: 1, maxLength: 80 }, maxItems: 20 },
    },
    required: ["email"],
    additionalProperties: false,
  },
  mode: "now",
  needs: "invite_people",
  async resolve(ctx, _person, input) {
    const roles = await givenRoles(ctx, input);
    if (typeof roles === "string") return roles;
    const email = str(input.email).toLowerCase();
    return {
      input: { email, add: roles.add.map((r) => r.id), remove: roles.take.map((r) => r.id) },
      words: { email, change: roleChange(roles.add, roles.take) },
    };
  },
  async run(deps, actorId, orgId, input) {
    await requirePermission(deps.db, actorId, orgId, "invite_people");
    const row = await pendingInvitation(deps.db, orgId, str(input.email));
    const add = list(input.add);
    const take = list(input.remove);
    const before = await invitationRoles(deps.db, row.id);
    const next = [...new Set([...before, ...add])].filter((id) => !take.includes(id));
    if (sameSet(before, next)) throw new ValidationError(`The invitation of ${row.email} already gives those roles`);
    await setInvitationRoles(deps.db, actorId, orgId, row.id, next);
    const names = await roleNames(deps.db, orgId, [...add, ...take]);
    const pick = (ids: string[]) => ids.map((id) => ({ name: names.get(id) ?? "" }));
    return {
      target: { type: "person", id: row.id, title: row.email },
      words: { email: row.email, change: roleChange(pick(add), pick(take)) },
      before: { roleIds: before },
      after: { roleIds: next },
    };
  },
  async revert(deps, actorId, a, direction, changedSince) {
    const [from, to] = direction === "undo" ? [obj(a.after), obj(a.before)] : [obj(a.before), obj(a.after)];
    if (!sameSet(await invitationRoles(deps.db, a.targetId), list(from.roleIds))) throw changedSince();
    await setInvitationRoles(deps.db, actorId, a.orgId, a.targetId, list(to.roleIds));
    return undefined;
  },
};

const resendInvitationAction: WorkspaceAction = {
  id: "resend_invitation",
  does: "Send a pending invitation again, with 7 more days to accept it.",
  input: revokeInvitationAction.input,
  mode: "now",
  needs: "invite_people",
  resolve: revokeInvitationAction.resolve,
  async run(deps, actorId, orgId, input) {
    if (!deps.server) throw new Error("Sending an invitation needs the server's address");
    await requirePermission(deps.db, actorId, orgId, "invite_people");
    const row = await pendingInvitation(deps.db, orgId, str(input.email));
    const { invitation, token } = await resendInvitation(
      deps.db,
      actorId,
      orgId,
      row.id,
      new Date(),
      deps.server.secret,
    );
    await queueInvitationEmail(deps.db, {
      orgId,
      invitationId: invitation.id,
      email: invitation.email,
      role: invitation.role,
      url: `${deps.server.publicUrl.replace(/\/$/, "")}/invite/${token}`,
      inviterId: actorId,
      ...(deps.server.secret ? { secret: deps.server.secret } : {}),
    });
    return {
      target: { type: "person", id: invitation.id, title: invitation.email },
      words: { email: invitation.email },
      final: true,
    };
  },
};

const joinRequestAction: WorkspaceAction = {
  id: "decide_join_request",
  does: "Let in someone who asked to join the workspace (with roles), or turn them down with a reason they read.",
  input: {
    type: "object",
    properties: {
      email: { type: "string", minLength: 3, maxLength: 254 },
      approve: { type: "boolean" },
      roles: { type: "array", items: { type: "string", minLength: 1, maxLength: 80 }, maxItems: 20 },
      reason: { type: "string", maxLength: 500, description: "When turning down: what they read in the email." },
    },
    required: ["email", "approve"],
    additionalProperties: false,
  },
  // Someone gets in, or is told no by email: a card the person confirms.
  mode: "card",
  needs: "invite_people",
  async resolve(ctx, _person, input) {
    const email = str(input.email).toLowerCase();
    const roles: { id: string; name: string }[] = [];
    for (const n of list(input.roles)) {
      const role = await roleNamed(ctx, n);
      if (typeof role === "string") return role;
      roles.push(role);
    }
    const approve = input.approve === true;
    return {
      input: {
        email,
        approve,
        roleIds: roles.map((r) => r.id),
        roleNames: roles.map((r) => r.name),
        reason: str(input.reason),
      },
      words: { email, variant: approve ? "approve" : "deny" },
    };
  },
  async run(deps, actorId, orgId, input) {
    // Looked up when it runs, as whoever may invite: someone who can't learns nothing of who asked.
    await requirePermission(deps.db, actorId, orgId, "invite_people");
    const [row] = await deps.db
      .select({ id: organizationJoinRequests.id })
      .from(organizationJoinRequests)
      .where(
        and(
          eq(organizationJoinRequests.orgId, orgId),
          sql`lower(${organizationJoinRequests.email}) = ${str(input.email)}`,
          eq(organizationJoinRequests.status, "pending"),
        ),
      );
    if (!row) throw new NotFoundError(`No request to join from ${str(input.email)}`);
    const id = row.id;
    if (input.approve === true) {
      if (!deps.server) throw new Error("Letting someone in needs the server's address");
      await approveJoinRequest(
        { db: deps.db, pubsub: deps.pubsub, ...(deps.server.secret ? { secret: deps.server.secret } : {}) },
        deps.server.publicUrl,
        actorId,
        orgId,
        id,
        list(input.roleIds),
      );
    } else await denyJoinRequest({ db: deps.db, pubsub: deps.pubsub }, actorId, orgId, id, str(input.reason) || null);
    return {
      target: { type: "person", id, title: str(input.email) },
      words: { email: str(input.email), variant: input.approve === true ? "approve" : "deny" },
      final: true,
    };
  },
};

// ── Work ─────────────────────────────────────────────────────────────────────

const LIVE = ["queued", "running", "waiting_approval", "waiting_input"] as const;

const agentRef = { type: "string", minLength: 1, maxLength: 64, description: "Its @handle." } as const;

/** An agent by handle, never the right hand itself (stopping it would stop this very turn). */
async function workerNamed(ctx: ToolContext, handle: string) {
  const found = await agentsByHandle(ctx.db, ctx.orgId, [handle]);
  const agent = found.rows[0];
  if (!agent) return `No agent ${handle.startsWith("@") ? handle : `@${handle}`} here.`;
  if (agent.id === ctx.agentId) return "That is you: say so, and stop nothing.";
  return agent;
}

const stopWorkAction: WorkspaceAction = {
  id: "stop_work",
  does: "Stop what an agent is doing now (its runs going, waiting or queued), and say why so it learns.",
  input: {
    type: "object",
    properties: { agent: agentRef, reason: { type: "string", maxLength: 500 } },
    required: ["agent"],
    additionalProperties: false,
  },
  mode: "now",
  needs: null,
  async resolve(ctx, _person, input) {
    const agent = await workerNamed(ctx, str(input.agent));
    if (typeof agent === "string") return agent;
    return {
      input: { agentId: agent.id, name: agent.name, reason: str(input.reason) },
      words: { agent: agent.name },
    };
  },
  async run(deps, actorId, orgId, input) {
    const runs = await deps.db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.orgId, orgId),
          eq(agentRuns.agentId, str(input.agentId)),
          inArray(agentRuns.status, [...LIVE]),
        ),
      );
    if (runs.length === 0) throw new ConflictError(`${str(input.name)} isn't doing anything now`);
    let stopped = 0;
    let refused: unknown = null;
    for (const r of runs) {
      try {
        await cancelRun(deps, actorId, orgId, r.id, { ...(str(input.reason) ? { reason: str(input.reason) } : {}) });
        stopped++;
      } catch (error) {
        if (!(error instanceof ForbiddenError)) throw error;
        refused = error;
      }
    }
    if (stopped === 0) throw refused;
    return {
      target: { type: "agent", id: str(input.agentId), title: str(input.name) },
      words: { agent: str(input.name) },
      final: true,
    };
  },
};

const continueWorkAction: WorkspaceAction = {
  id: "continue_work",
  does: "Let an agent go on with work it stopped: stopped by a person, at its step limit, or cut off by its AI.",
  input: { type: "object", properties: { agent: agentRef }, required: ["agent"], additionalProperties: false },
  mode: "now",
  needs: null,
  async resolve(ctx, _person, input) {
    const agent = await workerNamed(ctx, str(input.agent));
    if (typeof agent === "string") return agent;
    return { input: { agentId: agent.id, name: agent.name }, words: { agent: agent.name } };
  },
  async run(deps, actorId, orgId, input) {
    // Its newest stopped run in a conversation the person reads: an ordinary answer since is no reason to give up.
    const ended = await deps.db
      .select({ id: agentRuns.id, channelId: agentRuns.channelId })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.orgId, orgId),
          eq(agentRuns.agentId, str(input.agentId)),
          inArray(agentRuns.status, ["canceled", "done", "failed"]),
        ),
      )
      .orderBy(desc(agentRuns.updatedAt))
      .limit(20);
    let refused: unknown = null;
    for (const r of ended) {
      // Someone else's conversation isn't theirs to wake, nor to learn of.
      if (!(await requireChannelAccess(deps.db, actorId, orgId, r.channelId).catch(() => null))) continue;
      try {
        await continueRun(deps, actorId, orgId, r.id);
        return {
          target: { type: "agent", id: str(input.agentId), title: str(input.name) },
          words: { agent: str(input.name) },
          final: true,
        };
      } catch (error) {
        if (error instanceof ForbiddenError) refused ??= error;
        else if (!(error instanceof ConflictError && error.code === "run.not_continuable")) throw error;
      }
    }
    throw refused ?? new ConflictError(`${str(input.name)} has nothing stopped to go on with`);
  },
};

// ── The workspace ────────────────────────────────────────────────────────────

const WORKSPACE_FIELDS = ["name", "timezone", "defaultAgentBudgetNanoUsd"] as const;
const NANO_PER_USD = 1_000_000_000;

const updateWorkspaceAction: WorkspaceAction = {
  id: "update_workspace",
  does: "Change the workspace's name, time zone or the monthly budget of agents without their own.",
  input: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, maxLength: 80 },
      timezone: { type: "string", minLength: 1, maxLength: 64, description: "IANA, e.g. America/Sao_Paulo." },
      default_budget_usd: { type: "number", minimum: 0.01, maximum: 100_000 },
    },
    additionalProperties: false,
  },
  mode: "now",
  needs: "configure",
  async resolve(ctx, _person, input) {
    if (Object.keys(input).length === 0) return "Say what changes.";
    const [org] = await ctx.db
      .select({ name: schema.organizations.name })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, ctx.orgId));
    return { input, words: { name: org?.name ?? "" } };
  },
  async run(deps, actorId, orgId, input) {
    const now = await getOrgSettings(deps.db, actorId, orgId);
    const patch: Record<string, unknown> = {
      ...(str(input.name) ? { name: str(input.name) } : {}),
      ...(str(input.timezone) ? { timezone: str(input.timezone) } : {}),
      ...(typeof input.default_budget_usd === "number"
        ? { defaultAgentBudgetNanoUsd: Math.round(input.default_budget_usd * NANO_PER_USD) }
        : {}),
    };
    const fields = WORKSPACE_FIELDS.filter((f) => f in patch);
    const updated = await updateOrgSettings(deps.db, actorId, orgId, patch);
    const pick = (o: Record<string, unknown>) => Object.fromEntries(fields.map((f) => [f, o[f]]));
    const before = pick(now as unknown as Record<string, unknown>);
    const after = pick(updated as unknown as Record<string, unknown>);
    if (same(before, after)) throw new ValidationError("The workspace already is like that");
    return {
      target: { type: "workspace", id: orgId, title: updated.name },
      words: { name: updated.name },
      before,
      after,
    };
  },
  async revert(deps, actorId, a, direction, changedSince) {
    const [from, to] = direction === "undo" ? [obj(a.after), obj(a.before)] : [obj(a.before), obj(a.after)];
    const now = (await getOrgSettings(deps.db, actorId, a.orgId)) as unknown as Record<string, unknown>;
    if (!same(Object.fromEntries(Object.keys(from).map((f) => [f, now[f]])), from)) throw changedSince();
    await updateOrgSettings(deps.db, actorId, a.orgId, to);
    return undefined;
  },
};

const actionCheckAction: WorkspaceAction = {
  id: "set_action_check",
  does: "Turn the action check on or off: agents look at what the team already did before an outside action.",
  input: { type: "object", properties: { on: { type: "boolean" } }, required: ["on"], additionalProperties: false },
  // A safety switch: always a card someone confirms.
  mode: "card",
  needs: "configure",
  async resolve(_ctx, _person, input) {
    return { input, words: { variant: input.on === true ? "on" : "off" } };
  },
  async run(deps, actorId, orgId, input) {
    const now = await getOrgSettings(deps.db, actorId, orgId);
    if (now.actionCheck === (input.on === true)) throw new ValidationError("It already is like that");
    await updateOrgSettings(deps.db, actorId, orgId, { actionCheck: input.on === true });
    return {
      target: { type: "workspace", id: orgId, title: now.name },
      words: { variant: input.on === true ? "on" : "off" },
      before: { actionCheck: now.actionCheck },
      after: { actionCheck: input.on === true },
    };
  },
  async revert(deps, actorId, a, direction, changedSince) {
    const [from, to] = direction === "undo" ? [obj(a.after), obj(a.before)] : [obj(a.before), obj(a.after)];
    if ((await getOrgSettings(deps.db, actorId, a.orgId)).actionCheck !== from.actionCheck) throw changedSince();
    await updateOrgSettings(deps.db, actorId, a.orgId, { actionCheck: to.actionCheck === true });
    return undefined;
  },
};

// ── The catalog ──────────────────────────────────────────────────────────────

export const WORKSPACE_ACTIONS: readonly WorkspaceAction[] = [
  createRoleAction,
  updateRoleAction,
  deleteRoleAction,
  moveRoleAction,
  setMemberRolesAction,
  channelPermissionsAction,
  setStatusAction,
  notificationsAction,
  timezoneAction,
  updateChannelAction,
  archiveChannelAction,
  channelPeopleAction,
  deleteChannelAction,
  revokeInvitationAction,
  resendInvitationAction,
  invitationRolesAction,
  joinRequestAction,
  stopWorkAction,
  continueWorkAction,
  updateWorkspaceAction,
  actionCheckAction,
];

export const workspaceAction = (id: unknown) => WORKSPACE_ACTIONS.find((a) => a.id === id) ?? null;

/** The catalog as tools, for the search the directory runs. */
const asTools = () =>
  WORKSPACE_ACTIONS.map((a) => ({ name: a.id, description: a.does, inputSchema: a.input }) as ToolDefinition);

type Member = Awaited<ReturnType<typeof getMembership>>;

/** Whether this member may, as far as its screen's key goes (the engine call checks the rest). */
const mayDo = (membership: Member, a: WorkspaceAction) =>
  Boolean(membership) && (a.needs === null || can(membership, a.needs));

/** Who a card is sent to ("Pedir a quem pode"), and who may then open it: its key's holders, else the owners. */
const decides = (needs: Permission | null) => needs !== null && needs !== "read" && needs !== "manage_owners";
const isDecider = (membership: Member, needs: Permission | null) =>
  Boolean(membership) && (decides(needs) ? can(membership, needs as Permission) : membership?.role === "owner");

/** `find`: the best actions for what the person wants, with their input and whether they may. */
export async function findWorkspaceActions(ctx: ToolContext, person: string | null, query: string) {
  const membership = person ? await getMembership(ctx.db, person, ctx.orgId) : null;
  const best = rankTools(asTools(), "", query)
    .slice(0, 5)
    .map((t) => workspaceAction(t.name) as WorkspaceAction);
  if (best.length === 0)
    return `No action matches. The actions: ${WORKSPACE_ACTIONS.map((a) => a.id).join(", ")}. Tasks: update_issue. Routines: update_routine, delete_routine, run_routine_now. Billing, deleting the workspace or an account, passwords and keys: offer_open_page.`;
  return best
    .map(
      (a) =>
        `- ${a.id}: ${a.does} ${
          mayDo(membership, a)
            ? a.mode === "now"
              ? `They may: it applies at once ${a.revert ? "with Undo" : "and can't be undone"}.`
              : "They may: a card they confirm."
            : "Their roles don't give it: unless its screen lets them anyway (their own channel or agent), a card for someone who may."
        } Input: ${JSON.stringify(a.input)}`,
    )
    .join("\n");
}

// ── Doing it ─────────────────────────────────────────────────────────────────

/** The receipt of a done action: its kind, with what Undo needs. */
const recordOf = (a: WorkspaceAction, done: ActionDone): ActionRecord => ({
  kind: WORKSPACE_ACTION_KIND,
  target: done.target,
  params: { action: a.id, ...done.words },
  before: done.before ?? null,
  after: done.after ?? null,
  ...(done.final ? { final: true } : {}),
});

/** `meta.actionCard` of a catalog action waiting for someone who may (and how it ended). */
export interface WorkspaceActionCard {
  kind: "workspace_action";
  forUserId: string;
  params: {
    action: string;
    input: Input;
    words: Record<string, string>;
    needs: Permission | null;
    why: string;
    /** The person it was for tried and the screen's own rule refused them (a role above theirs): they send it on. */
    refused?: boolean;
    /** It changes whoever applies it (their own status…): only the person it was for does. */
    self?: boolean;
  };
  state: "pending" | "applied" | "dismissed";
  decidedByUserId: string | null;
  decidedAt: string | null;
  /** "Pedir a quem pode": sent to whoever may (their inbox opens the card). */
  askedAt?: string | null;
}

/** The run's changes made at once so far (`workspace_action` and the people card's roles): `MAX_ACTIONS_PER_RUN` caps them. */
export const changesThisRun = async (ctx: Pick<ToolContext, "db" | "orgId" | "runId">) =>
  (
    await ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(agentActions)
      .where(
        and(
          eq(agentActions.orgId, ctx.orgId),
          eq(agentActions.runId, ctx.runId),
          eq(agentActions.kind, WORKSPACE_ACTION_KIND),
        ),
      )
  )[0]?.n ?? 0;

/**
 * Runs `a` now for the person behind the call, its receipt in the same transaction. `refused`: the screen's own rule
 * turned them down, in its words (nothing changed).
 */
export async function actNow(
  deps: { pubsub?: PubSub; server?: ServerLinks },
  ctx: ToolContext,
  person: string,
  a: WorkspaceAction,
  input: Input,
): Promise<ActionDone | { refused: string }> {
  const events = holdEvents(deps.pubsub);
  try {
    const done = await actWithUndo(
      ctx,
      (db) => a.run({ db, pubsub: events.pubsub, server: deps.server }, person, ctx.orgId, input),
      (d) => recordOf(a, d),
    );
    await events.flush();
    return done;
  } catch (error) {
    if (error instanceof ForbiddenError) return { refused: error.message };
    throw error;
  }
}

/** The tool's card tools (`cardsLeft`, `hopOf`), passed in as `teamTools` takes them. */
export interface CardTools {
  cardsLeft: (ctx: ToolContext, asks?: boolean) => Promise<ToolOutput | null>;
  hopOf: (ctx: ToolContext) => Promise<number>;
}

/**
 * `workspace_action` (the right hand only): finds an action of the catalog and does it as the person behind the run,
 * with their permissions. One tool for all of them, so its prompt stays the size of one.
 */
export function workspaceActionTool(deps: { pubsub?: PubSub; server?: ServerLinks } & CardTools): ToolDefinition {
  return {
    name: WORKSPACE_ACTION_TOOL,
    description:
      "Do anything else the app lets this person do, as them and never more: roles and what each may do, people's roles, a channel's settings, people and permissions, their own status, notifications and time zone, invitations and requests to join, the workspace's settings, stopping or continuing an agent's work. First call it with `find` (what they want, in a few words), then with `action`, its `input` and `why`. A change they may make, asked in their own words, applies at once with Undo; anything else becomes a card for whoever may. The result says which: never say it is done before it does.",
    scope: "setup:write",
    inputSchema: {
      type: "object",
      properties: {
        find: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "What they want done, in a few English words.",
        },
        action: { type: "string", minLength: 1, maxLength: 64, description: "An action from find." },
        input: { type: "object", description: "The action's input, as find showed it." },
        why: { type: "string", maxLength: 300, description: "One short line for its card, in their language." },
      },
      additionalProperties: false,
    },
    async execute(raw, ctx) {
      try {
        const person = await personBehindCall(ctx);
        if (str(raw.find) && !str(raw.action))
          return { content: await findWorkspaceActions(ctx, person, str(raw.find)) };
        if (!person) return { content: "Only a person's request changes the workspace.", isError: true };
        const a = workspaceAction(str(raw.action));
        if (!a)
          return {
            content: `No action "${str(raw.action)}". Closest:\n${await findWorkspaceActions(ctx, person, str(raw.action).replace(/_/g, " "))}`,
            isError: true,
          };
        const given = obj(raw.input);
        const errors = validateJson(a.input, given);
        if (errors.length > 0)
          return { content: `Wrong input: ${errors.join("; ")}. Input: ${JSON.stringify(a.input)}`, isError: true };
        const resolved = await a.resolve(ctx, person, given);
        if (typeof resolved === "string") return { content: resolved, isError: true };
        const membership = await getMembership(ctx.db, person, ctx.orgId);
        let may = mayDo(membership, a);
        let refused = "";
        // Tried even without the key: the screen's own rules decide (a channel's creator manages it too).
        if (a.mode === "now" && (await ownWords(ctx)) === person) {
          if ((await changesThisRun(ctx)) >= MAX_ACTIONS_PER_RUN)
            return { content: `You already made ${MAX_ACTIONS_PER_RUN} changes in this turn.`, isError: true };
          const done = await actNow(deps, ctx, person, a, resolved.input);
          if (!("refused" in done))
            return {
              content: `Done at once${a.revert ? ", with Undo under your reply" : " (it can't be undone)"}: ${a.id} (${describe(done.words)}). Say it is done.`,
            };
          // Refused by the engine's own rules (a role above theirs, a key they don't hold): someone who may decides.
          may = false;
          refused = done.refused;
        }
        const full = await deps.cardsLeft(ctx);
        if (full) return full;
        const at = await cardPlace(ctx);
        if (!at) return { content: NO_PERSON_READS, isError: true };
        const card: WorkspaceActionCard = {
          kind: "workspace_action",
          forUserId: person,
          params: {
            action: a.id,
            input: resolved.input,
            words: resolved.words,
            needs: a.needs,
            why: str(raw.why),
            ...(refused ? { refused: true } : {}),
            ...(a.self ? { self: true } : {}),
          },
          state: "pending",
          decidedByUserId: null,
          decidedAt: null,
        };
        const message = await postActionCard(deps, ctx, at, card);
        return {
          content: `Posted a card to ${a.id} (${describe(resolved.words)}). ${
            may
              ? "They apply it there."
              : `They can't make this change${refused ? ` (the app says: ${refused})` : ""}: the card lets them send it to whoever may. Say so.`
          } Nothing has changed yet.`,
          data: { actionCard: { messageId: message } },
        };
      } catch (error) {
        return { content: `Failed: ${error instanceof Error ? error.message : String(error)}`, isError: true };
      }
    },
  };
}

const describe = (words: Record<string, string>) =>
  Object.entries(words)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");

async function postActionCard(
  deps: { pubsub?: PubSub } & CardTools,
  ctx: ToolContext,
  at: { channelId: string; threadId: string | null },
  card: WorkspaceActionCard,
) {
  const message = await insertMessage(ctx.db, {
    orgId: ctx.orgId,
    ...at,
    author: { type: "agent", agentId: ctx.agentId, runId: ctx.runId, hop: await deps.hopOf(ctx) },
    body: `Proposed ${card.params.action} (${describe(card.params.words)})${card.params.why ? `: ${card.params.why}` : ""}`,
    meta: { ...bodyCode(WORKSPACE_ACTION_CARD), actionCard: card },
  });
  if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(message));
  return message.id;
}

// ── The card ─────────────────────────────────────────────────────────────────

const cardOf = (meta: Record<string, unknown> | null | undefined) => {
  const c = meta?.actionCard as WorkspaceActionCard | undefined;
  return c?.kind === "workspace_action" && c.params && typeof c.params.action === "string" ? c : null;
};

const ASK_GROUP = "change_request:action:";

/** The card behind `messageId` for someone who reads its conversation, or whom it was sent to (and may). */
async function cardMessage(db: Database, userId: string, orgId: string, messageId: string) {
  const message = await getMessage(db, orgId, messageId);
  const card = message && !message.deletedAt && message.authorType === "agent" ? cardOf(message.meta) : null;
  if (!message || !card) throw new NotFoundError("Card not found", "action_card.not_found");
  const membership = await getMembership(db, userId, orgId);
  // Sent on, it opens for whom it was sent to (`askWorkspaceAction`), never for every member.
  const asked = card.askedAt && isDecider(membership, card.params.needs);
  if (!asked) await requireChannelAccess(db, userId, orgId, message.channelId);
  if (!membership) throw new NotFoundError("Card not found", "action_card.not_found");
  return { message, card, membership };
}

/** The card as it is now (`GET`), for its conversation or the inbox of whom it was sent to. */
export async function getWorkspaceActionCard(db: Database, userId: string, orgId: string, messageId: string) {
  const { message, card } = await cardMessage(db, userId, orgId, messageId);
  return { messageId: message.id, channelId: message.channelId, threadId: message.threadId, card };
}

async function announceCard(
  deps: ActionDeps,
  message: { channelId: string; threadId: string | null; id: string },
  card: WorkspaceActionCard,
) {
  await publishChannelEvent(deps.pubsub, {
    type: "action_card.updated",
    channelId: message.channelId,
    threadId: message.threadId,
    messageId: message.id,
    card: card as unknown as Record<string, unknown>,
  });
}

/**
 * Aplicar or Descartar on the card, as whoever clicks: Aplicar runs the action with their permissions (the engine call
 * refuses what they can't do) and puts its receipt, with Undo, on the card; Descartar is for the person it was for or
 * anyone who may. Once: a card already decided is refused.
 */
export async function decideWorkspaceAction(
  deps: ActionDeps,
  userId: string,
  orgId: string,
  messageId: string,
  decision: "apply" | "dismiss",
) {
  const found = await cardMessage(deps.db, userId, orgId, messageId);
  const a = workspaceAction(found.card.params.action);
  if (!a) throw new ValidationError("This build doesn't know that action", "action_card.unknown");
  const decided = () => new ConflictError("This card was already decided", "action_card.decided");
  if (found.card.state !== "pending") throw decided();
  if (decision === "dismiss" && found.card.forUserId !== userId && !mayDo(found.membership, a))
    throw new ForbiddenError("Only the person it was for, or someone who may, dismisses it", "action_card.not_allowed");
  // Their own status or notifications: anyone else's click would change theirs instead.
  if (decision === "apply" && a.self && found.card.forUserId !== userId)
    throw new ForbiddenError("Only the person it was for applies it", "action_card.not_requester");
  const events = holdEvents(deps.pubsub);
  const deciding = deps.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    // Locked: two clicks at once never apply it twice.
    const [row] = await db
      .select({ meta: messages.meta })
      .from(messages)
      .where(and(eq(messages.orgId, orgId), eq(messages.id, messageId)))
      .for("update");
    const current = cardOf(row?.meta);
    if (current?.state !== "pending") throw decided();
    const card: WorkspaceActionCard = {
      ...current,
      state: decision === "apply" ? "applied" : "dismissed",
      decidedByUserId: userId,
      decidedAt: new Date().toISOString(),
    };
    if (decision === "apply") {
      const done = await a.run(
        { db, pubsub: events.pubsub, server: deps.server, hub: deps.hub, mail: deps.mail },
        userId,
        orgId,
        current.params.input,
      );
      const record = recordOf(a, done);
      const now = new Date();
      await db.insert(agentActions).values({
        orgId,
        runId: found.message.agentRunId,
        agentId: found.message.authorAgentId as string,
        channelId: found.message.channelId,
        messageId,
        // Whoever applied it may undo it, as may admins and its agent's owner.
        requestedByUserId: userId,
        kind: record.kind,
        targetType: record.target.type,
        targetId: record.target.id,
        target: (({ type: _t, id: _i, ...label }) => label)(record.target),
        params: record.params ?? {},
        before: record.before ?? null,
        after: record.after ?? null,
        createdAt: now,
        undoableUntil: new Date(now.getTime() + (record.final ? 0 : UNDO_WINDOW_MS)),
      });
      card.params = { ...card.params, words: { ...card.params.words, ...done.words } };
    }
    await db
      .update(messages)
      .set({ meta: sql`jsonb_set(${messages.meta}, '{actionCard}', ${JSON.stringify(card)}::jsonb)` })
      .where(and(eq(messages.orgId, orgId), eq(messages.id, messageId)));
    await recordAudit(db, {
      orgId,
      actor: { type: "person", id: userId },
      action: decision === "apply" ? "action_card.applied" : "action_card.dismissed",
      target: { type: "message", id: messageId },
      details: { action: a.id, via: found.message.authorAgentId },
    });
    return card;
  });
  const next = await deciding.catch(async (error: unknown) => {
    // The screen's own rule refused the person it was for (a role above theirs): from now on the card sends it on.
    if (error instanceof ForbiddenError && decision === "apply" && found.card.forUserId === userId) {
      const refused: WorkspaceActionCard = { ...found.card, params: { ...found.card.params, refused: true } };
      const [row] = await deps.db
        .update(messages)
        .set({ meta: sql`jsonb_set(${messages.meta}, '{actionCard,params,refused}', 'true'::jsonb)` })
        .where(
          and(
            eq(messages.orgId, orgId),
            eq(messages.id, messageId),
            sql`${messages.meta}->'actionCard'->>'state' = 'pending'`,
          ),
        )
        .returning({ id: messages.id });
      if (row) await announceCard(deps, found.message, refused);
    }
    throw error;
  });
  await events.flush();
  await resolveNotifications(deps, orgId, { groupKey: `${ASK_GROUP}${messageId}` }).catch(() => 0);
  await announceCard(deps, { ...found.message }, next);
  if (decision === "apply") await publishMessageActions(deps, orgId, messageId);
  return next;
}

/**
 * "Pedir a quem pode": the person it was for can't make the change, so it goes to whoever may, as an inbox entry
 * (waiting) that opens the card; their click applies it as them. Once per card.
 */
export async function askWorkspaceAction(deps: ActionDeps, userId: string, orgId: string, messageId: string) {
  const found = await cardMessage(deps.db, userId, orgId, messageId);
  const { message, card } = found;
  const a = workspaceAction(card.params.action);
  if (!a) throw new ValidationError("This build doesn't know that action", "action_card.unknown");
  if (card.forUserId !== userId)
    throw new ForbiddenError("Only the person it was for can send it", "action_card.not_requester");
  if (card.state !== "pending") throw new ConflictError("This card was already decided", "action_card.decided");
  if (card.askedAt) throw new ConflictError("It was already sent", "action_card.asked");
  if (a.self || (mayDo(found.membership, a) && !card.params.refused))
    throw new ConflictError("You can apply it yourself", "action_card.yours");
  const next: WorkspaceActionCard = { ...card, askedAt: new Date().toISOString() };
  const [row] = await deps.db
    .update(messages)
    .set({ meta: sql`jsonb_set(${messages.meta}, '{actionCard}', ${JSON.stringify(next)}::jsonb)` })
    .where(
      and(
        eq(messages.id, message.id),
        eq(messages.orgId, orgId),
        sql`${messages.meta}->'actionCard'->>'state' = 'pending'`,
        sql`not (${messages.meta}->'actionCard' ? 'askedAt')`,
      ),
    )
    .returning({ id: messages.id });
  if (!row) throw new ConflictError("It was already sent", "action_card.asked");
  const deciders = await deps.db
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.orgId, orgId),
        decides(a.needs)
          ? maySql(orgId, organizationMembers.userId, a.needs as RolePermission)
          : eq(organizationMembers.role, "owner"),
      ),
    );
  await notify(deps, {
    orgId,
    userIds: deciders.map((d) => d.userId).filter((id) => id !== userId),
    kind: "change_request",
    groupKey: `${ASK_GROUP}${message.id}`,
    waiting: true,
    actor: { type: "user", id: userId },
    source: {
      messageId: message.id,
      action: a.id,
      ...(message.authorAgentId ? { agentId: message.authorAgentId } : {}),
      label: Object.values(card.params.words)[0] ?? a.id,
    },
    latest: { text: card.params.why || describe(card.params.words) },
  }).catch(() => {});
  await announceCard(deps, message, next);
  return next;
}

/** Undo or Redo of a catalog action's receipt, as `userId` (`agent-undo.ts`). */
export async function revertWorkspaceAction(
  deps: ActionDeps,
  a: ActionRow,
  userId: string,
  direction: "undo" | "redo",
  changedSince: () => Error,
) {
  const entry = workspaceAction(obj(a.params).action);
  if (!entry?.revert) throw new ConflictError("This can't be undone", "action.not_undoable");
  const events = holdEvents(deps.pubsub);
  const state = await entry.revert({ db: deps.db, pubsub: events.pubsub }, userId, a, direction, changedSince);
  await events.flush();
  return state;
}

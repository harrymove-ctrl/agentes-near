/**
 * The keys of a workspace's permissions (ADR 0085, packages/engine/src/permissions.ts). The server sends each
 * person's resolved `permissions` with their membership (`OrgSummary`); the UI only hides what isn't allowed, the
 * server checks every request.
 */
export type RolePermission =
  | "administrator"
  | "post"
  | "create_channels"
  | "mention_everyone"
  | "manage_channels"
  | "talk_to_agents"
  | "assign_work"
  | "manage_routines"
  | "approve_actions"
  | "create_agents"
  | "manage_agents"
  | "pair_computers"
  | "own_browsers"
  | "own_computers"
  | "control_browsers"
  | "control_computers"
  | "manage_connectors"
  | "manage_credentials"
  | "use_others_plans"
  | "edit_wiki"
  | "upload_files"
  | "review_memory"
  | "invite_people"
  | "view_usage"
  | "view_audit"
  | "configure"
  | "manage_members"
  | "manage_roles"
  | "manage_billing";

/** `read`: any member; `manage_owners`: owners only. */
export type Permission = RolePermission | "read" | "manage_owners";

/** Whether this membership (an `OrgSummary`) may `permission`. */
export const can = (org: { permissions?: readonly string[] } | null | undefined, permission: Permission) =>
  org?.permissions?.includes(permission) === true;

/** Whether a way into a new agent shows: `create_agents`, in a workspace not being deleted (it takes none, ADR 0088). */
export const makesAgents = (org: { permissions?: readonly string[]; deletion?: unknown } | null | undefined) =>
  can(org, "create_agents") && !org?.deletion;

/** Whether a way into connecting a service shows: `manage_connectors`, in a workspace not being deleted. */
export const addsConnectors = (org: { permissions?: readonly string[]; deletion?: unknown } | null | undefined) =>
  can(org, "manage_connectors") && !org?.deletion;

type Membership = Parameters<typeof can>[0];

type ChannelLike = {
  isMember?: boolean;
  createdByUserId?: string | null;
  /** From the channel list, with the channel's exceptions (ADR 0134). */
  can?: { post: boolean; callAgents: boolean; manage: boolean };
};

/**
 * Who manages a channel (its name, members, category and exceptions): the server's answer in `channel.can`, else
 * who may manage every channel, or its creator while still in it. Mirrors the server's `managesChannel`
 * (packages/engine/src/channels.ts).
 */
export const managesChannel = (
  channel: ChannelLike | null | undefined,
  meId: string | null | undefined,
  org: Membership,
) =>
  channel?.can
    ? channel.can.manage
    : can(org, "manage_channels") || (!!meId && channel?.isMember === true && channel.createdByUserId === meId);

/**
 * Who picks how an agent replies in a channel: who manages the channel, or the agent's owner. Mirrors the server's
 * `setChannelAgentAutoReply` (packages/engine/src/channels.ts).
 */
export const setsAutoReply = (
  channel: ChannelLike | null | undefined,
  agent: { ownerUserId?: string | null } | null | undefined,
  meId: string | null | undefined,
  org: Membership,
) => managesChannel(channel, meId, org) || (!!meId && agent?.ownerUserId === meId);

/**
 * Whether this person may put an agent in a channel or take it out of it: a channel they're in and may post in, or
 * one they manage. Mirrors the server's `placesAgentsIn` (packages/engine/src/channels.ts), which also needs the
 * agent to be theirs or `manage_agents`.
 */
export const addsAgentsTo = (
  channel: ChannelLike | null | undefined,
  meId: string | null | undefined,
  org: Membership,
) => (channel?.isMember === true && can(org, "post")) || managesChannel(channel, meId, org);

/** Who may edit what an agent remembers: who reviews memory, or the agent's owner (the server's `requireEdit`). */
export const editsMemory = (
  agent: { ownerUserId?: string | null } | null | undefined,
  meId: string | null | undefined,
  org: Membership,
) => can(org, "review_memory") || (!!meId && agent?.ownerUserId === meId);

/** I may leave this channel: I'm in it, and it isn't #general, where everyone stays. */
export const leavesChannel = (channel: { isMember?: boolean; name: string }) =>
  channel.isMember === true && channel.name !== "general";

import { type SQL, sql } from "@agenteschat/db";

/**
 * What a role may grant in a workspace (ADR 0085), in five areas. Every member may also `read` (see the workspace,
 * its people, agents and the channels open to them); only an owner may `manage_owners` (give and take ownership,
 * delete the workspace). Agents never hold these: what an agent may do comes from its own scopes (Tool Gateway).
 * The apps draw the roles screen from `PERMISSION_AREAS` (sent by `GET …/roles`) and name each key with i18n.
 * `use_others_plans`: give any agent one may manage a plan someone else connected (ADR 0059 §3); administrators and
 * owners hold it, `everyone` doesn't, so no migration backfills it. `mention_everyone` (Discord's "Mention @everyone"):
 * `@todos` in any conversation but a DM mentions all its members, people and agents; the same holds for it.
 */
export const PERMISSION_AREAS = [
  {
    id: "chat",
    use: ["post", "create_channels"],
    keys: ["post", "create_channels", "mention_everyone", "manage_channels"],
  },
  {
    id: "agents",
    use: ["talk_to_agents", "assign_work", "manage_routines"],
    keys: ["talk_to_agents", "assign_work", "manage_routines", "approve_actions", "create_agents", "manage_agents"],
  },
  {
    id: "tools",
    use: ["pair_computers"],
    keys: [
      "pair_computers",
      "own_browsers",
      "own_computers",
      "control_browsers",
      "control_computers",
      "manage_connectors",
      "manage_credentials",
      "use_others_plans",
    ],
  },
  {
    id: "knowledge",
    use: ["edit_wiki", "upload_files"],
    keys: ["edit_wiki", "upload_files", "review_memory"],
  },
  {
    id: "org",
    use: ["invite_people"],
    keys: [
      "invite_people",
      "view_usage",
      "view_audit",
      "configure",
      "manage_members",
      "manage_roles",
      "manage_billing",
    ],
  },
] as const;

export type PermissionArea = (typeof PERMISSION_AREAS)[number]["id"];
/** A key a role can hold. `administrator` grants every other one. */
export type RolePermission = "administrator" | (typeof PERMISSION_AREAS)[number]["keys"][number];
/** What the server checks: a role's keys, plus `read` (every member) and `manage_owners` (owners only). */
export type Permission = RolePermission | "read" | "manage_owners";

/**
 * The agents' computers, one choice per role on the roles screen (none, the browser, the whole computer), stored as
 * one of two keys per reach. `control_*`: every agent's. `own_*`: an agent the person is responsible for, a computer
 * they connected, a run they asked for and a request addressed to them; `everyone` holds these, the other roles the
 * `control_*` pair. The browser is the agent's browser view and its sign-in requests; the whole computer adds its
 * full screen, taking control of it and its terminal. Each key gives the ones below it, so a check names only the
 * least it needs.
 */
const IMPLIED: Partial<Record<RolePermission, readonly RolePermission[]>> = {
  control_computers: ["control_browsers", "own_computers", "own_browsers"],
  control_browsers: ["own_browsers"],
  own_computers: ["own_browsers"],
};
/** The keys that give `permission`, itself first. */
const givers = (permission: RolePermission): RolePermission[] => [
  permission,
  ...(Object.keys(IMPLIED) as RolePermission[]).filter((k) => IMPLIED[k]?.includes(permission)),
];

/** Every key but `administrator`, in the areas' order. */
export const AREA_PERMISSIONS: readonly RolePermission[] = PERMISSION_AREAS.flatMap((a) => a.keys);
export const ROLE_PERMISSIONS: readonly RolePermission[] = ["administrator", ...AREA_PERMISSIONS];

export const isRolePermission = (v: unknown): v is RolePermission =>
  typeof v === "string" && (ROLE_PERMISSIONS as readonly string[]).includes(v);

/**
 * What the `everyone` role ("Todos") holds in a new workspace: what any member could do before roles, now as
 * keys (the same list as migration 0130, with `own_computers` from migration 0211).
 */
export const EVERYONE_DEFAULTS: readonly RolePermission[] = [
  "post",
  "create_channels",
  "talk_to_agents",
  "assign_work",
  "pair_computers",
  "own_computers",
  "edit_wiki",
  "upload_files",
];

/** The roles' look: one of the agents' colors but sky (the agents' own) and one of the apps' role icons. */
export const ROLE_COLORS = ["indigo", "violet", "rose", "amber", "green", "teal", "graphite"] as const;
export const ROLE_ICONS = [
  "shield",
  "code",
  "wallet",
  "mail",
  "bolt",
  "flag",
  "book",
  "chart",
  "bulb",
  "globe",
  "pullRequest",
  "calendar",
  "message",
  "eye",
  "plug",
  "person",
] as const;
export type RoleColor = (typeof ROLE_COLORS)[number];
export type RoleIcon = (typeof ROLE_ICONS)[number];

/**
 * Everything a person may do from their roles' keys (theirs and `everyone`'s): an owner everything, a key
 * `administrator` every role key; `read` always.
 */
export function resolvePermissions(owner: boolean, keys: Iterable<string>): ReadonlySet<Permission> {
  if (owner) return new Set<Permission>(["read", "manage_owners", ...ROLE_PERMISSIONS]);
  const out = new Set<Permission>(["read"]);
  for (const k of keys) if (isRolePermission(k)) out.add(k);
  if (out.has("administrator")) for (const k of AREA_PERMISSIONS) out.add(k);
  for (const k of [...out]) for (const i of IMPLIED[k as RolePermission] ?? []) out.add(i);
  return out;
}

/** The keys a role holds once `administrator` is spread out (what the role screen shows on). */
export function roleGrants(keys: Iterable<string>): ReadonlySet<RolePermission> {
  const out = new Set<RolePermission>();
  for (const k of keys) if (isRolePermission(k)) out.add(k);
  if (out.has("administrator")) for (const k of AREA_PERMISSIONS) out.add(k);
  for (const k of [...out]) for (const i of IMPLIED[k] ?? []) out.add(i);
  return out;
}

/**
 * Wraps a value (a column, a param, SQL) one level down. Drizzle renders a column that sits directly in a select
 * field of a single-table query as a bare `"user_id"`, which inside these subqueries binds to the subquery's own
 * table (`pm.user_id = "user_id"` is always true); one level down it keeps its table name.
 */
const qualified = (v: unknown) => sql`${v}`;

/**
 * The keys of every role a member holds, as SQL over `organization_members` aliased `m`: theirs and `everyone`.
 * Used where a membership is read (`getMembership`, `listMemberships`).
 */
export const memberKeysSql = ({ orgId, userId }: { orgId: unknown; userId: unknown }) => {
  const m = { orgId: qualified(orgId), userId: qualified(userId) };
  return sql<string[]>`coalesce((
  select array_agg(distinct k) from org_roles r, unnest(r.permissions) as k
  where r.org_id = ${m.orgId}
    and (r.kind = 'everyone' or r.id in (
      select mr.role_id from organization_member_roles mr where mr.org_id = ${m.orgId} and mr.user_id = ${m.userId}))
), '{}'::text[])`;
};

/** The position of a member's highest role (0 the top), null with none but `everyone`. */
export const memberRankSql = ({ orgId, userId }: { orgId: unknown; userId: unknown }) => sql<number | null>`(
  select min(r.position) from org_roles r join organization_member_roles mr on mr.org_id = r.org_id and mr.role_id = r.id
  where r.org_id = ${qualified(orgId)} and mr.user_id = ${qualified(userId)} and r.kind = 'custom')`;

/**
 * Whether the member `userId` of `orgId` may `permission`, as a SQL condition: an owner, or a role of theirs (or
 * `everyone`) holding the key or `administrator`. For checks inside one statement (the message insert's runs,
 * lists of who may decide).
 */
export function maySql(orgId: unknown, userId: unknown, permission: RolePermission): SQL<boolean> {
  const keys = sql.join(
    [...givers(permission), "administrator"].map((k) => sql`${k}`),
    sql`, `,
  );
  return sql<boolean>`exists (
    select 1 from organization_members pm
    where pm.org_id = ${qualified(orgId)} and pm.user_id = ${qualified(userId)}
      and (pm.role = 'owner' or exists (
        select 1 from org_roles pr
        where pr.org_id = pm.org_id
          and (pr.kind = 'everyone' or pr.id in (
            select pmr.role_id from organization_member_roles pmr where pmr.org_id = pm.org_id and pmr.user_id = pm.user_id))
          and pr.permissions && array[${keys}]::text[])))`;
}

/** The ids of the members of `orgId` who may `permission` (owners included), as a SQL subquery. */
export function membersWhoMaySql(orgId: unknown, permission: RolePermission): SQL {
  return sql`(select wm.user_id from organization_members wm where wm.org_id = ${orgId}
    and ${maySql(sql`wm.org_id`, sql`wm.user_id`, permission)})`;
}

/** The keys a channel may change for a role or a person (ADR 0134). */
export const CHANNEL_KEYS = ["post", "talk_to_agents", "manage_channels"] as const;
export type ChannelKey = (typeof CHANNEL_KEYS)[number];

export const isChannelKey = (v: unknown): v is ChannelKey =>
  typeof v === "string" && (CHANNEL_KEYS as readonly string[]).includes(v);

/** One of a channel's exceptions that applies to a person: `everyone`'s, one of their roles', or their own. */
export interface ChannelOverride {
  target: "everyone" | "role" | "person";
  allow: readonly string[];
  deny: readonly string[];
}

const decided = (o: ChannelOverride | undefined, key: ChannelKey) =>
  o?.allow.includes(key) ? true : o?.deny.includes(key) ? false : undefined;

/**
 * A person's keys in one channel (ADR 0134), Discord's order: their workspace keys, then `everyone`'s exception,
 * then their roles' (any allow wins over a deny), then their own, last. An owner or `administrator` is never
 * overridden, and `manage_channels` held in the workspace is never taken away. `channelMaySql` is the same rule.
 */
export function channelPermissions(
  permissions: ReadonlySet<Permission>,
  overrides: readonly ChannelOverride[],
): ReadonlySet<Permission> {
  if (overrides.length === 0 || permissions.has("administrator")) return permissions;
  const out = new Set(permissions);
  const everyone = overrides.find((o) => o.target === "everyone");
  const person = overrides.find((o) => o.target === "person");
  const roles = overrides.filter((o) => o.target === "role");
  for (const key of CHANNEL_KEYS) {
    if (key === "manage_channels" && permissions.has(key)) continue;
    const byRoles = roles.some((o) => o.allow.includes(key))
      ? true
      : roles.some((o) => o.deny.includes(key))
        ? false
        : undefined;
    const verdict = decided(person, key) ?? byRoles ?? decided(everyone, key);
    if (verdict === true) out.add(key);
    else if (verdict === false) out.delete(key);
  }
  return out;
}

/** An exception's say on `key`: true (allow), false (deny) or null, as SQL over a `channel_permission_overrides` row `o`. */
const verdictSql = (key: SQL) =>
  sql`case when ${key} = any(o.allow) then true when ${key} = any(o.deny) then false end`;

/**
 * `channelPermissions` in SQL: whether the member `userId` of `orgId` may `key` in `channelId`. For checks inside
 * one statement (the message insert's runs, the router, the channel list).
 */
export function channelMaySql(orgId: unknown, channelId: unknown, userId: unknown, key: ChannelKey): SQL<boolean> {
  const k = sql`${key}::text`;
  const c = qualified(channelId);
  const holds = (keys: SQL) => sql`exists (
          select 1 from org_roles pr
          where pr.org_id = pm.org_id
            and (pr.kind = 'everyone' or pr.id in (
              select pmr.role_id from organization_member_roles pmr where pmr.org_id = pm.org_id and pmr.user_id = pm.user_id))
            and pr.permissions && ${keys})`;
  return sql<boolean>`exists (
    select 1 from organization_members pm
    where pm.org_id = ${qualified(orgId)} and pm.user_id = ${qualified(userId)}
      and (pm.role = 'owner' or ${holds(sql`array['administrator']::text[]`)}
        ${key === "manage_channels" ? sql`or ${holds(sql`array['manage_channels']::text[]`)}` : sql``}
        or coalesce(
          (select ${verdictSql(k)} from channel_permission_overrides o
            where o.channel_id = ${c} and o.org_id = pm.org_id and o.user_id = pm.user_id),
          (select case when bool_or(${k} = any(o.allow)) then true when bool_or(${k} = any(o.deny)) then false end
            from channel_permission_overrides o
            join organization_member_roles omr on omr.org_id = o.org_id and omr.role_id = o.role_id and omr.user_id = pm.user_id
            where o.channel_id = ${c} and o.org_id = pm.org_id),
          (select ${verdictSql(k)} from channel_permission_overrides o
            join org_roles er on er.id = o.role_id and er.kind = 'everyone'
            where o.channel_id = ${c} and o.org_id = pm.org_id),
          ${holds(sql`array[${k}]::text[]`)})))`;
}

/** The exceptions of `channelId` that apply to `userId` (`ChannelOverride`s), as a SQL json array (null with none). */
export const channelOverridesSql = (orgId: unknown, channelId: unknown, userId: unknown) => {
  const [org, channel, user] = [qualified(orgId), qualified(channelId), qualified(userId)];
  return sql<ChannelOverride[] | string | null>`(
  select json_agg(json_build_object('target', case when o.user_id is not null then 'person'
      when ovr.kind = 'everyone' then 'everyone' else 'role' end, 'allow', o.allow, 'deny', o.deny))
  from channel_permission_overrides o left join org_roles ovr on ovr.id = o.role_id
  where o.channel_id = ${channel} and o.org_id = ${org}
    and (o.user_id = ${user} or ovr.kind = 'everyone' or exists (select 1 from organization_member_roles ovm
      where ovm.org_id = o.org_id and ovm.user_id = ${user} and ovm.role_id = o.role_id)))`;
};

/** `channelOverridesSql`'s value as read back (some drivers hand json over as text). */
export const parseOverrides = (v: ChannelOverride[] | string | null | undefined): ChannelOverride[] =>
  typeof v === "string" ? JSON.parse(v) : (v ?? []);

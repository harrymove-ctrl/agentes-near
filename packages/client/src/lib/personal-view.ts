import type { Member, OrgRole, OrgSummary, WorkspaceMode } from "../api/types";
import { isPersonal } from "./workspace-mode";

/**
 * What a personal workspace shows its person (ADR 0159): a simpler view of the same workspace. Nothing here changes
 * what exists or who may do what; it only picks which sections come first, their words, and what a switch of mode or
 * an invitation says. Pure, for the web and the phone app.
 */

type Org = Pick<OrgSummary, "mode"> | null | undefined;

/**
 * Settings in a personal workspace (ADR 0159 §3), in this order: Your account, About you, AI and usage, Connectors,
 * Vault, Devices (the web's `devices`, the phone's `computers`). Every other section the person may open is under
 * Advanced. Ids are the settings sections' (`/settings/{id}` on the web).
 */
export const PERSONAL_SETTINGS = [
  "account",
  "general",
  "usage",
  "connectors",
  "vault",
  "devices",
  "computers",
] as const;

/**
 * Sections a personal workspace shows on another one's page: AI and usage holds billing. Its own address still opens
 * it alone.
 */
export const PERSONAL_SETTINGS_PARTS: Readonly<Record<string, (typeof PERSONAL_SETTINGS)[number]>> = {
  billing: "usage",
};

/** The section whose page also shows `id` in a personal workspace, when the person may open it; null otherwise. */
export function personalSettingsHost(id: string, open: ReadonlySet<string>): string | null {
  const host = PERSONAL_SETTINGS_PARTS[id];
  return host && open.has(host) ? host : null;
}

/**
 * The short list once other people are members (a family): People comes after About you. Alone, it stays under
 * Advanced, where inviting the first one still is.
 */
const PERSONAL_SETTINGS_SHARED = [
  "account",
  "general",
  "members",
  "usage",
  "connectors",
  "vault",
  "devices",
  "computers",
] as const;

/** A personal workspace's short list: with other people here (`others`), the one People is on. */
export const personalSettingsShort = (others?: number): readonly string[] =>
  others !== undefined && others > 0 ? PERSONAL_SETTINGS_SHARED : PERSONAL_SETTINGS;

/**
 * A personal workspace's settings list from the sections the person may open (`open`, in their usual order): the
 * short list, then Advanced with every other one (a section already on another's page isn't listed again). `others`:
 * how many other people are members; with any, People joins the short list (unknown while loading: it doesn't).
 */
export function personalSettingsNav<T extends { id: string }>(
  open: readonly T[],
  others?: number,
): { main: T[]; advanced: T[] } {
  const ids = new Set(open.map((s) => s.id));
  const short = personalSettingsShort(others);
  return {
    main: short.flatMap((id) => open.filter((s) => s.id === id)),
    advanced: open.filter((s) => !short.includes(s.id) && personalSettingsHost(s.id, ids) === null),
  };
}

/** The sections a personal workspace names in its own words: About you, People. */
const RENAMED = ["general", "members"] as const;
type Renamed = (typeof RENAMED)[number];
/** The sections whose line under the title has a personal variant. */
const RETOLD = ["general", "members", "usage", "connectors", "roles"] as const;
type Retold = (typeof RETOLD)[number];

type NameKey<S extends string> = `settings.section.${S}` | `settings.section.${S & Renamed}Personal`;
type TextKey<S extends string> = `settings.sectionText.${S}` | `settings.sectionText.${S & Retold}Personal`;

/**
 * The i18n key of a settings section's name: `settings.section.<id>`, or in a personal workspace its own
 * (`settings.section.<id>Personal`) for the sections it renames.
 */
export function settingsSectionNameKey<S extends string>(org: Org, id: S): NameKey<S> {
  const own = isPersonal(org) && (RENAMED as readonly string[]).includes(id);
  return (own ? `settings.section.${id}Personal` : `settings.section.${id}`) as NameKey<S>;
}

/** The i18n key of a settings section's line under its title, with the personal variant where there is one. */
export function settingsSectionTextKey<S extends string>(org: Org, id: S): TextKey<S> {
  const own = isPersonal(org) && (RETOLD as readonly string[]).includes(id);
  return (own ? `settings.sectionText.${id}Personal` : `settings.sectionText.${id}`) as TextKey<S>;
}

/** A line of what switching the mode changes: its icon (the web's icon names) and its i18n key. */
export interface ModeSwitchLine {
  icon: "channel" | "personAdd" | "shield" | "sidebar" | "message" | "settings" | "members";
  key:
    | "personalMode.toTeam.channels"
    | "personalMode.toTeam.roles"
    | "personalMode.toTeam.admin"
    | "personalMode.toPersonal.sidebar"
    | "personalMode.toPersonal.channels"
    | "personalMode.toPersonal.settings"
    | "personalMode.toPersonal.bubbles"
    | "personalMode.toPersonal.others";
  /** For `others`: how many other people are members. */
  count?: number;
}

/**
 * What switching a workspace `to` a mode says (ADR 0159 §4): what comes into sight going to a team's; what changes
 * going to personal, and with `others` other members, that they see it too. What stays is its own line
 * (`personalMode.<to>.stays`).
 */
export function modeSwitchLines(to: WorkspaceMode, others: number): ModeSwitchLine[] {
  if (to === "team")
    return [
      { icon: "channel", key: "personalMode.toTeam.channels" },
      { icon: "personAdd", key: "personalMode.toTeam.roles" },
      { icon: "shield", key: "personalMode.toTeam.admin" },
    ];
  const lines: ModeSwitchLine[] = [
    { icon: "sidebar", key: "personalMode.toPersonal.sidebar" },
    { icon: "channel", key: "personalMode.toPersonal.channels" },
    { icon: "settings", key: "personalMode.toPersonal.settings" },
    { icon: "message", key: "personalMode.toPersonal.bubbles" },
  ];
  if (others > 0) lines.push({ icon: "members", key: "personalMode.toPersonal.others", count: others });
  return lines;
}

/**
 * Inviting in a personal workspace asks one plain question (ADR 0159 §4): the person uses the agents (a member, no
 * role) or helps run the workspace, which is the highest role the inviter may give that holds `administrator` (a new
 * workspace's Admin). Null when there is none to give: only the first choice is offered. The roles stay what they are.
 */
export function personalHelperRole(roles: readonly OrgRole[]): OrgRole | null {
  return (
    [...roles]
      .filter((r) => r.kind === "custom" && r.givable && r.permissions.includes("administrator"))
      .sort((a, b) => a.position - b.position)[0] ?? null
  );
}

/** How many people other than `meId` are members. */
export const othersHere = (members: readonly Pick<Member, "userId">[], meId: string) =>
  members.filter((m) => m.userId !== meId).length;

/**
 * Whether the viewer is alone in a personal workspace (ADR 0159): `others` is how many other people are members,
 * undefined while that is loading, which never counts as alone, so a control a family member needs doesn't hide and
 * come back. A control may leave the screen while alone only while it holds its default: a value someone set shows.
 */
export const isSolo = (org: Org, others: number | undefined) => isPersonal(org) && others === 0;

/**
 * Whether a picker's Roles group is worth showing (who talks to an agent, who sees an item, who joins a group
 * conversation, limits per role): always in a team's workspace. In a personal one, only when one is already picked
 * (`picked`, its ids) or a role exists besides the base one and those holding `administrator`: whoever holds those
 * already sees everything shared (ADR 0151, 0157), so a family picks people instead. The roles themselves don't change.
 */
export function rolePicksInSight(
  org: Org,
  roles: readonly Pick<OrgRole, "kind" | "permissions">[],
  picked: readonly string[] = [],
): boolean {
  return (
    !isPersonal(org) ||
    picked.length > 0 ||
    roles.some((r) => r.kind === "custom" && !r.permissions.includes("administrator"))
  );
}

/**
 * A role's plain words in a personal workspace (the invitation's two choices): no role ("Uses the agents"), the
 * helper's (`personalHelperRole`: "Helps you run it"); null for any other role, which goes by its own name.
 */
export function personalRoleKey(
  roles: readonly OrgRole[],
  roleId: string | null,
): "members.dialog.role.uses" | "members.dialog.role.helps" | null {
  if (roleId === null) return "members.dialog.role.uses";
  return personalHelperRole(roles)?.id === roleId ? "members.dialog.role.helps" : null;
}

/**
 * Who runs a personal workspace besides the viewer, by first name, for the notes a family member meets ("Only Ana can
 * change this."): its one owner or holder of an `administrator` role (`roles`, when known) other than `meId`; null
 * when there are several or none, and the note says it without a name.
 */
export function keeperName(
  members: readonly Pick<Member, "userId" | "name" | "role" | "roleIds">[],
  meId: string,
  roles: readonly Pick<OrgRole, "id" | "permissions">[] = [],
): string | null {
  const admin = new Set(roles.filter((r) => r.permissions.includes("administrator")).map((r) => r.id));
  const keepers = members.filter(
    (m) => m.userId !== meId && (m.role === "owner" || (m.roleIds ?? []).some((id) => admin.has(id))),
  );
  const [only] = keepers;
  if (!only || keepers.length > 1) return null;
  return only.name.trim().split(/\s+/)[0] || null;
}

/**
 * The key of a note on who may change something, for whoever can't (ADR 0159): a team's own key; in a personal
 * workspace its words, naming who runs it (`keeper`, from `keeperName`, as `{{keeper}}`) with `<key>Keeper`, or
 * without a name, `<key>Personal`, when that isn't one person. Only the words: who may change it is the same.
 */
export const keeperKey = <K extends string>(org: Org, keeper: string | null, key: K) =>
  isPersonal(org) ? (keeper ? (`${key}Keeper` as const) : (`${key}Personal` as const)) : key;

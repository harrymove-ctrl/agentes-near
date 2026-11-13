import type {
  Agent,
  AgentAccess,
  Machine,
  MachineAccessReduce,
  MachineOs,
  MachinePause,
  MachineToolName,
  OrgRole,
  OrgRoles,
  OrgSummary,
  Person,
  S3Input,
  Skill,
  StorageConfig,
  StoragePlatform,
} from "@agenteschat/client";
import { type AccessResource, resourcesOf } from "@agenteschat/client/lib/access-levels";
import { type NoComputer, noComputerChoice, type SetupView, setupPending } from "@agenteschat/client/lib/computer";
import { clockAt, formatPercent, relativeTime } from "@agenteschat/client/lib/format";
import { folderName, hostDescKey, isPaused } from "@agenteschat/client/lib/machines";
import { can } from "@agenteschat/client/lib/permissions";
import { type ModeSwitchLine, personalSettingsHost, personalSettingsNav } from "@agenteschat/client/lib/personal-view";
import {
  type AreaLevel,
  areaLine,
  computerChoice,
  everyoneOf,
  isBelow,
  isEveryone,
  levelLabel,
  levelOf,
  levelOptions,
  type PermissionAreaId,
} from "@agenteschat/client/lib/roles";
import { zoneDisplayName } from "@agenteschat/client/lib/routines";
import { skillWaitingChip } from "@agenteschat/client/lib/skills";
import type { TFunction } from "i18next";
import type { IconName } from "@/ui";

/*
 * The workspace's settings on the phone, as the web's (`apps/web/src/pages/SettingsPage.tsx`): which sections each
 * person opens (from their permissions, ADR 0085), the line the workspace's page shows under each area, and what the
 * screens decide before they draw. Pure, so it is unit-tested; the screens turn it into views.
 */

// ── Sections ────────────────────────────────────────────────────────────────

export type SettingsSection =
  | "apps"
  | "general"
  | "members"
  | "roles"
  | "audit"
  | "media"
  | "access"
  | "connectors"
  | "skills"
  | "storage"
  | "computers"
  | "usage"
  | "import"
  | "vault";

/**
 * The phone's groups, the web's settings entries (`TEAM_SETTINGS`; Your account is the phone's own tab): Workspace,
 * People, AI and usage, Connectors, then Advanced.
 */
export type SettingsGroup = "org" | "people" | "ai" | "connectors" | "advanced";

/** Each group's name: the words the web's list shows for the same entry. */
export const GROUP_LABEL = {
  org: "mobile.settings.group.org",
  people: "mobile.settings.group.people",
  ai: "settings.section.usage",
  connectors: "access.kind.connectors",
  advanced: "settings.advanced",
} as const satisfies Record<SettingsGroup, string>;

export interface SettingsEntry {
  id: SettingsSection;
  group: SettingsGroup;
  icon: IconName;
  /** The phone's screen for it. */
  href: string;
  /** Who opens it: the web's rule (`apps/web/src/pages/settings-sections.ts`), but for Membros (see there). */
  allowed: (org: OrgSummary | null | undefined) => boolean;
}

/**
 * The web's settings (`settings.section.*`) in the phone's groups, each thing once, a screen each: the workspace
 * itself (what it is, its GIFs), its people (members, roles), AI and usage, connectors (with skills, the Vault, the
 * agents' access and the AI apps that reach them) and Advanced (devices, storage, import and export, the audit). The
 * right hand's settings are on its own profile. Each with a neutral icon (the color stays on faces).
 */
export const SETTINGS_SECTIONS: readonly SettingsEntry[] = [
  // The workspace itself (its name, logo, zone, what every agent knows of it): who configures it.
  { id: "general", group: "org", icon: "home", href: "/settings/general", allowed: (o) => can(o, "configure") },
  // GIFs and stickers in chat (ADR 0091): who configures the workspace.
  { id: "media", group: "org", icon: "sticker", href: "/settings/media", allowed: (o) => can(o, "configure") },
  // Everyone, as on the web: who invites finds the requests there, a member who may not suggests someone (ADR 0090).
  { id: "members", group: "people", icon: "members", href: "/me/members", allowed: (o) => can(o, "read") },
  // Papéis e permissões (ADR 0085): who manages roles, as on the web.
  { id: "roles", group: "people", icon: "lock", href: "/settings/roles", allowed: (o) => can(o, "manage_roles") },
  // "IA e uso", for everyone (ADR 0063): the workspace's AI accounts with their meters and the agents whose details
  // they see, in tokens and percentages; money only for who has `view_usage`. It leads to the AI accounts screen.
  { id: "usage", group: "ai", icon: "chart", href: "/usage", allowed: () => true },
  { id: "connectors", group: "connectors", icon: "join", href: "/connectors", allowed: () => true },
  {
    id: "skills",
    group: "connectors",
    icon: "sparkle",
    href: "/settings/skills",
    allowed: (o) => can(o, "manage_agents"),
  },
  // The Vault (ADR 0144): every member keeps their own logins and keys there and sees the team's shared with them.
  { id: "vault", group: "connectors", icon: "key", href: "/settings/vault", allowed: (o) => can(o, "read") },
  {
    id: "access",
    group: "connectors",
    icon: "shield",
    href: "/settings/access",
    allowed: (o) => can(o, "manage_agents"),
  },
  // AI apps (ADR 0119): each person's own connections in this workspace; connecting one happens on the web.
  { id: "apps", group: "connectors", icon: "share", href: "/settings/apps", allowed: () => true },
  // Dispositivos: every member sees the computers and the phones they reach, and connects their own (ADR 0025).
  { id: "computers", group: "advanced", icon: "laptop", href: "/settings/devices", allowed: (o) => can(o, "read") },
  { id: "storage", group: "advanced", icon: "archive", href: "/settings/storage", allowed: (o) => can(o, "configure") },
  { id: "import", group: "advanced", icon: "out", href: "/settings/import", allowed: (o) => can(o, "create_agents") },
  // What agents did and people changed: who may see the audit (it shows everyone's work).
  { id: "audit", group: "advanced", icon: "list", href: "/settings/audit", allowed: (o) => can(o, "view_audit") },
];

export const SETTINGS_GROUPS: readonly SettingsGroup[] = ["org", "people", "ai", "connectors", "advanced"];

/** The sections this membership opens, in order. */
export const visibleSections = (org: OrgSummary | null | undefined) => SETTINGS_SECTIONS.filter((s) => s.allowed(org));

// ── A personal workspace's settings (ADR 0159 §3) ───────────────────────────

export interface PersonalSettings {
  /** The short list, in its order (Your account comes before it: it is the person's own, not a section). */
  main: SettingsEntry[];
  /** Every other section this person opens, on the Advanced screen in the phone's groups. */
  advanced: SettingsEntry[];
}

/**
 * A personal workspace's settings on the phone (ADR 0159 §3), from the sections this person opens, as the web lists
 * them (`personalSettingsNav`): About you, AI and usage, Connectors, Vault and Computers in one list, with People
 * after About you once someone else is a member (`others`, unknown while loading: it doesn't); every other one under
 * Advanced. Only where a section is listed changes: each opens the same screen, with the same permission, as in a
 * team's workspace.
 */
export const personalSections = (org: OrgSummary | null | undefined, others: number | undefined): PersonalSettings =>
  personalSettingsNav(visibleSections(org), others);

/**
 * What the AI accounts screen lists at its foot in a personal workspace: the sections it holds (`personalSettingsHost`),
 * those this person opens. No section is held there: Connectors and Skills have rows of their own.
 */
export function personalAiParts(org: OrgSummary | null | undefined): SettingsEntry[] {
  const open = visibleSections(org);
  const ids = new Set<string>(open.map((s) => s.id));
  return open.filter((s) => personalSettingsHost(s.id, ids) === "keys");
}

/** The icon a section has in a personal workspace's short list, where it differs from its usual one. */
export const PERSONAL_ICON: Partial<Record<SettingsSection, IconName>> = { general: "pen" };

/** A switch of mode's line icon, in the phone's set (`modeSwitchLines` names the web's). */
export const MODE_LINE_ICON: Record<ModeSwitchLine["icon"], IconName> = {
  channel: "hash",
  personAdd: "person",
  shield: "shield",
  sidebar: "list",
  message: "chat",
  settings: "home",
  members: "members",
};

// ── The workspace's page and Editar workspace ──────────────────────────────

/** What the workspace's page knows of each area (absent while it loads: its line stays empty). */
export interface TileFacts {
  overview?: { people: number; agents: number; budgetUsedPercent: number } | undefined;
  /** The workspace uses the API (`workspaceUsesApi`): only then Uso says its budget, never 0% on plans alone. */
  usesApi?: boolean | undefined;
  /** Invitations waiting (managers only). */
  invitations?: number | undefined;
  /** The live connections' names. */
  connectors?: string[] | undefined;
  skills?: number | undefined;
  computers?: { count: number; online: number } | undefined;
  storage?: { kind: "agentes" | "s3"; edition: "cloud" | "selfhost" } | undefined;
}

/**
 * One value per row on the workspace's page, short, in faint ("5", "2", "1 de 2", "40%"): a count or a state, never
 * a sentence (that is the area's own screen). Absent while it loads or where there is nothing to count.
 */
export function areaValues(t: TFunction, locale: string, f: TileFacts): Partial<Record<SettingsSection, string>> {
  const out: Partial<Record<SettingsSection, string>> = {};
  if (f.overview) {
    out.members = String(f.overview.people);
    out.access = String(f.overview.agents);
    if (f.usesApi) out.usage = formatPercent(locale, f.overview.budgetUsedPercent);
  }
  if (f.connectors && f.connectors.length > 0) out.connectors = String(f.connectors.length);
  if (f.skills !== undefined && f.skills > 0) out.skills = String(f.skills);
  if (f.computers && f.computers.count > 0)
    out.computers = t("mobile.settings.ofOnline", { online: f.computers.online, count: f.computers.count });
  return out;
}

/** The ideas the organization's context still misses ("Falta dizer: Para quem…"), by their label. */
export const missingIdeas = (context: string, labels: readonly string[]) =>
  labels.filter((label) => !context.toLowerCase().includes(label.toLowerCase()));

/** The context with an idea started on a paragraph of its own ("…\n\nPara quem: "). */
export const withIdea = (context: string, label: string) =>
  `${context.replace(/\s*$/, "")}${context.trim() ? "\n\n" : ""}${label}: `;

/**
 * Leaving the name field: save the trimmed name when it changed, put the saved one back when it was emptied (a
 * workspace always has a name), else nothing.
 */
export function nameOnLeave(draft: string, saved: string | undefined): { save: string } | { reset: string } | null {
  const next = draft.trim();
  if (!next) return { reset: saved ?? "" };
  return next !== saved ? { save: next } : null;
}

/** A zone as lists say it: "Horário de Brasília" (a friendly name) or the city. */
export const zoneLabel = (zone: string, locale: string) =>
  zoneDisplayName(zone, locale) ?? (zone.split("/").pop() ?? zone).replace(/_/g, " ");

// ── Acesso ──────────────────────────────────────────────────────────────────

export type AccessKind = "connector" | "builtin";

/** The columns of the web's matrix: the resources of that kind, from the first agent's tree (all agents share them). */
export const accessColumns = (first: AgentAccess | undefined, kind: AccessKind): AccessResource[] =>
  first ? resourcesOf(first).filter((r) => r.kind === kind) : [];

/** A built-in area's icon (the web's `AREA_ICON`, in the phone's set). */
export const AREA_ICON: Record<string, IconName> = {
  context: "search",
  drive: "drive",
  issues: "issue",
  calendar: "clock",
  wiki: "doc",
  skills: "bolt",
  schedule: "clock",
  sandbox: "code",
  browser: "globe",
  setup: "pen",
  desktop: "laptop",
};

// ── Skills ──────────────────────────────────────────────────────────────────

/** Above this many skills the list gets its search (the web lists 6 and searches the rest). */
export const SKILLS_INLINE = 6;

/** "GitHub" for github.com links, "Link" for other addresses, "Enviada", "Criada aqui" (`skills.source.*`). */
export const skillSourceKey = (s: Pick<Skill, "source" | "sourceUrl">) =>
  s.source === "url" ? (/github\.com/i.test(s.sourceUrl ?? "") ? "github" : "url") : s.source;

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** The skills whose name or description has the query, accents aside. */
export function searchSkills<S extends Pick<Skill, "name" | "description">>(skills: S[], query: string): S[] {
  const q = fold(query.trim());
  return q ? skills.filter((s) => fold(`${s.name} ${s.description}`).includes(q)) : skills;
}

/** A link to a skill's folder on GitHub (the only link the import reads). */
export const isGithubSkillLink = (url: string) => /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+/.test(url.trim());

/** "GitHub · Em agentes novos · v3 · 2 agentes usam": a skill's facts in the list. */
export function skillLine(
  t: TFunction,
  s: Pick<Skill, "source" | "sourceUrl" | "version" | "defaultForNewAgents" | "autoUpdate" | "pendingUpdate">,
  users: number | null,
): string {
  return [
    t(`skills.source.${skillSourceKey(s)}`),
    s.defaultForNewAgents ? t("skills.defaultChip") : null,
    s.pendingUpdate && !s.pendingUpdate.dismissed
      ? t(skillWaitingChip(s.pendingUpdate))
      : s.autoUpdate
        ? t("skills.autoChip")
        : null,
    t("skills.version", { version: s.version }),
    users !== null ? t("skills.usedBy", { count: users }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** How often a long action's line moves on ("Baixando a skill…" → "Lendo os arquivos…"). */
export const STEP_EVERY_MS = 2500;

/** Which step of a long action to show, by the time since it started (the last one stays). */
export const stepAt = (sinceMs: number, nowMs: number, steps: number, everyMs = STEP_EVERY_MS) =>
  Math.min(steps - 1, Math.max(0, Math.floor((nowMs - sinceMs) / everyMs)));

// ── Computadores ────────────────────────────────────────────────────────────

const OSES: MachineOs[] = ["linux", "darwin", "windows", "other"];
export const osOf = (os: string): MachineOs => (OSES.includes(os as MachineOs) ? (os as MachineOs) : "other");

/** "conectado agora", "visto há 2 h", "ainda não conectou". */
export function seenText(t: TFunction, locale: string, m: Pick<Machine, "online" | "lastSeenAt">, now = new Date()) {
  return m.online
    ? t("machines.seenNow")
    : m.lastSeenAt
      ? t("machines.seen", { when: relativeTime(t, locale, m.lastSeenAt, now) })
      : t("machines.neverSeen");
}

/** "Pausado até 16:24" (another day: with the date), "Pausado"; null when not paused now. */
export function pauseText(t: TFunction, locale: string, paused: MachinePause | null | undefined, now = new Date()) {
  if (!isPaused({ paused }, now.getTime())) return null;
  const until = paused?.until;
  if (!until) return t("machines.paused");
  return t("machines.pausedUntil", { time: clockAt(locale, until, now) });
}

/** A computer's line in the lists: the server's own says what it is; others their system, version, seen and by whom. */
export function machineFacts(t: TFunction, locale: string, m: Machine, now = new Date()): string {
  if (m.kind === "host") return t(`machines.host.${hostDescKey(m.os)}`);
  return [
    t(`machines.os.${osOf(m.os)}`),
    m.runnerVersion ? t("machines.versionShort", { version: m.runnerVersion }) : null,
    seenText(t, locale, m, now),
    m.pairedBy ? t("machines.pairedBy", { name: m.pairedBy.name }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The computers people connected with a code ("Outros computadores"): the server's and the workspace's own apart. */
export const peoplesMachines = (list: readonly Machine[]) =>
  list.filter((m) => m.kind !== "managed" && m.kind !== "host");

/** The pickers' value for "no computer" (`machineId` null), as on the web. */
export const NO_COMPUTER = "none";

export interface AgentComputerPick {
  /** The computer the agent uses, or `NO_COMPUTER`. */
  value: string;
  /** What "no computer" stands for here; null: not offered. */
  noComputer: NoComputer | null;
  /** The computers this person may pick for it. */
  choices: Machine[];
  canPick: boolean;
}

/**
 * "Qual computador cada agente usa", for one agent: admins pick any computer; its owner, the ones they connected (the
 * server checks again). While the workspace's own computer is on its way, "no computer" stands for it.
 */
export function agentComputerPick(input: {
  agent: Pick<Agent, "id" | "ownerUserId">;
  meId: string | null;
  admin: boolean;
  machines: readonly Machine[];
  setup: SetupView | null;
}): AgentComputerPick {
  const machines = setupPending(input.setup) ? input.machines.filter((m) => m.kind !== "managed") : [...input.machines];
  const current = machines.find((m) => m.agents.some((a) => a.id === input.agent.id));
  const value = current?.id ?? NO_COMPUTER;
  const mine = (id: string | null | undefined) => input.meId !== null && id === input.meId;
  const choices = machines.filter((m) => input.admin || mine(m.pairedBy?.id) || m.id === value);
  return {
    value,
    noComputer: noComputerChoice(input.setup, value === NO_COMPUTER),
    choices,
    canPick: (input.admin || mine(input.agent.ownerUserId)) && choices.length > 0,
  };
}

/**
 * The "no computer" choice's name: the workspace's own computer on its way (`computerSetup.title`, with `org`), else
 * no computer at all.
 */
export const noComputerKey = (choice: NoComputer) =>
  choice === "workspace" ? "computerSetup.title" : "computer.target.none";

/** Taking something away on a computer (granting happens only on the computer itself). */
export type Reduce =
  | { kind: "folder"; path: string; agent?: { id: string; name: string } }
  | { kind: "tool"; tool: MachineToolName | "browser" };

/** The confirmation's words, its button, the toast after it and the request, as the web's. */
export function reduceTexts(
  t: TFunction,
  reduce: Reduce,
): { title: string; text: string; action: string; done: string; input: MachineAccessReduce } {
  if (reduce.kind === "tool") {
    const tool = t(`machines.access.tool.${reduce.tool}`);
    return {
      title: t("machines.access.disableTitle", { tool }),
      text: t("machines.access.disableText", { tool }),
      action: t("machines.access.disable"),
      done: t("machines.access.disabled", { tool }),
      input: { disableTool: reduce.tool },
    };
  }
  const folder = folderName(reduce.path);
  if (reduce.agent) {
    const values = { folder, name: reduce.agent.name };
    return {
      title: t("machines.access.removeAgentTitle", values),
      text: t("machines.access.removeAgentText", values),
      action: t("machines.access.remove"),
      done: t("machines.access.removedAgent", values),
      input: { removeFolder: { path: reduce.path, agentId: reduce.agent.id } },
    };
  }
  return {
    title: t("machines.access.removeTitle", { folder }),
    text: t("machines.access.removeText"),
    action: t("machines.access.remove"),
    done: t("machines.access.removed", { folder }),
    input: { removeFolder: { path: reduce.path } },
  };
}

/** "Para liberar mais": the command that allows a folder, as the administrator in system mode (ADR 0057). */
export const grantCommand = (m: Pick<Machine, "mode">, path: string, agent: string) =>
  `${m.mode === "system" ? "sudo " : ""}agentes-runner folders allow ${path} --agent ${agent}`;

/** Both switches apps on the agents' screens need, turned on at the computer (ADR 0062). */
export const DESKTOP_TURN_ON = "agentes-runner tools enable desktop && agentes-runner tools enable commands";

// ── Armazenamento ───────────────────────────────────────────────────────────

/** The option's name: the workspace's own bucket, our storage on the Cloud, or this server where people run it. */
export const storageKey = (kind: "agentes" | "s3", edition: "cloud" | "selfhost") =>
  kind === "s3" ? "storage.s3" : edition === "cloud" ? "storage.agentes" : "storage.server";

/** Where this server keeps files, in words: the folder by its path when the server says it. */
export function platformText(t: TFunction, platform: StoragePlatform): string {
  if (platform.kind !== "disk" || !platform.folder) return t(`storage.serverText.${platform.kind}`);
  return t("storage.serverText.folder").replace("<folder/>", platform.folder);
}

export interface S3Form {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  pathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
}

export const EMPTY_S3_FORM: S3Form = {
  endpoint: "",
  region: "",
  bucket: "",
  prefix: "",
  pathStyle: false,
  accessKeyId: "",
  secretAccessKey: "",
};

/** The bucket form from what is saved (the keys never come back: blank keeps them). */
export const s3FormOf = (c: StorageConfig | undefined): S3Form =>
  c?.s3
    ? {
        ...EMPTY_S3_FORM,
        endpoint: c.s3.endpoint,
        region: c.s3.region,
        bucket: c.s3.bucket,
        prefix: c.s3.prefix ?? "",
        pathStyle: c.s3.pathStyle,
      }
    : EMPTY_S3_FORM;

/** What the server gets; blank keys mean "keep the saved ones". */
export function toS3Input(f: S3Form): S3Input {
  const input: S3Input = {
    endpoint: f.endpoint.trim(),
    region: f.region.trim(),
    bucket: f.bucket.trim(),
    prefix: f.prefix.trim() || null,
    pathStyle: f.pathStyle,
  };
  if (f.accessKeyId.trim()) input.accessKeyId = f.accessKeyId.trim();
  if (f.secretAccessKey.trim()) input.secretAccessKey = f.secretAccessKey.trim();
  return input;
}

/** What the form lacks before a test: the required fields, and the keys when none are saved yet. */
export function s3Missing(f: S3Form, keysSaved: boolean) {
  const input = toS3Input(f);
  const keys = !keysSaved && (!input.accessKeyId || !input.secretAccessKey);
  const fields = !input.endpoint || !input.region || !input.bucket;
  return { fields, keys, complete: !fields && !keys };
}

// ── Importar e exportar ─────────────────────────────────────────────────────

/** The export's file name, as the web saves it: `agentes-chat-2026-10-28.json`. */
export const exportFileName = (now: Date) => `agentes-chat-${now.toISOString().slice(0, 10)}.json`;

// ── Papéis e permissões ─────────────────────────────────────────────────────

/** The owners' page in the roles' routes (owner isn't a role on the server: `organization_members.role`). */
export const OWNER_ROLE = "owner";
/** The agents' computers' choice in the area routes: one choice, beside the areas (`computerChoice`). */
export const COMPUTER_AREA = "computer";

/** Each area's icon on a role's screen (the web's `AREA_ICONS`, in the phone's set). */
export const ROLE_AREA_ICON: Record<string, IconName> = {
  chat: "chat",
  agents: "agent",
  tools: "bolt",
  knowledge: "doc",
  org: "home",
  [COMPUTER_AREA]: "laptop",
};

export interface RoleAreaRow {
  id: string;
  label: string;
  /** What the role reaches there. */
  line: string;
  /** Its level; empty as Administrador (it has every area). */
  value: string;
}

/** A role's areas on its screen, as the web's card: each with its line and level, the computers right after Ferramentas. */
export function roleAreaRows(t: TFunction, locale: string, role: OrgRole, data: OrgRoles): RoleAreaRow[] {
  const everyone = everyoneOf(data.roles);
  const admin = !isEveryone(role) && role.permissions.includes("administrator");
  return data.areas.flatMap((a) => {
    const row = {
      id: a.id,
      label: t(`permissions.areas.${a.id as PermissionAreaId}`),
      line: areaLine(t, locale, role, a, everyone),
      value: admin ? "" : levelLabel(t, role, levelOf(role, a, everyone)),
    };
    if (a.id !== "tools") return [row];
    const c = computerChoice(role, everyone);
    return [
      row,
      {
        id: COMPUTER_AREA,
        label: t("rolesPage.computer.title"),
        line: t(`rolesPage.computer.${c.reach}.${c.shown}`),
        value: admin ? "" : t(`rolesPage.computer.levels.${c.shown}`),
      },
    ];
  });
}

/** The levels an area's screen lists: those offered, and "Personalizado" while it is that (never picked). */
export function areaChoices(role: OrgRole, area: OrgRoles["areas"][number], everyone: OrgRole | undefined) {
  const level = levelOf(role, area, everyone);
  const options: AreaLevel[] = levelOptions(role, area, everyone);
  return { level, options: level === "custom" ? [...options, level] : options };
}

/** Who may get a role from this viewer: without it, and below them (the server checks it again). */
export const roleCandidates = (
  viewer: { role: string; rank?: number | null; userId: string },
  role: Pick<OrgRole, "id">,
  people: readonly Person[],
  roles: readonly OrgRole[],
) => people.filter((p) => !(p.roleIds ?? []).includes(role.id) && isBelow(viewer, p, roles));

/** Whether the viewer gives and takes this role: not Todos, below them, and they manage members. */
export const givesRole = (org: OrgSummary | null | undefined, role: Pick<OrgRole, "kind" | "givable">) =>
  !isEveryone(role) && role.givable && can(org, "manage_members");

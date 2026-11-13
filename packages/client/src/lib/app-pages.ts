import type { Permission } from "./permissions";

/**
 * The screens the right hand's "Abrir" card opens (`offer_open_page`, ADR 0137 §4), mirrored from `APP_PAGES` in
 * packages/engine/src/setup-tools.ts. `web`: under `/org/{orgId}` (`{agentId}`, `{channelId}` filled in); `phone`: its
 * route, or null where the phone has no such screen (its button opens the page on the website). `may`: who may use it, when not
 * everyone; the screen checks it again and asks what it always asks (the code and the typed name of a deletion).
 * `label`: the card's title, the screen's own name (an agent's and a channel's are their names).
 */
export const APP_PAGES = {
  billing: { web: "/settings/billing", phone: null, may: "manage_billing", label: "settings.section.billing" },
  delete_workspace: {
    web: "/settings/general?delete=1",
    phone: null,
    may: "manage_owners",
    label: "deleteOrg.card.title",
  },
  delete_account: {
    web: "/settings/account?account=delete",
    phone: "/account-delete",
    may: null,
    label: "deleteAccount.menu",
  },
  account: { web: "/settings/account", phone: "/me/account", may: null, label: "settings.section.account" },
  ai_accounts: { web: "/settings/usage", phone: "/ai-accounts", may: null, label: "settings.section.usage" },
  workspace: {
    web: "/settings/general",
    phone: "/settings/general",
    may: "configure",
    label: "settings.section.general",
  },
  members: { web: "/settings/members", phone: "/me/members", may: null, label: "settings.section.members" },
  roles: { web: "/settings/roles", phone: "/settings/roles", may: "manage_roles", label: "settings.section.roles" },
  audit: { web: "/settings/audit", phone: "/settings/audit", may: "view_audit", label: "settings.section.audit" },
  usage: { web: "/settings/usage", phone: "/usage", may: null, label: "settings.section.usage" },
  computers: {
    web: "/settings/computers",
    phone: "/settings/computers",
    may: null,
    label: "settings.section.computers",
  },
  task_manager: { web: "/task-manager", phone: "/task-manager", may: null, label: "taskManager.title" },
  connectors: { web: "/settings/connectors", phone: "/connectors", may: null, label: "settings.section.connectors" },
  skills: {
    web: "/settings/skills",
    phone: "/settings/skills",
    may: "manage_agents",
    label: "settings.section.skills",
  },
  storage: {
    web: "/settings/storage",
    phone: "/settings/storage",
    may: "configure",
    label: "settings.section.storage",
  },
  notifications: {
    web: "/settings/notifications",
    phone: "/me/notifications",
    may: null,
    label: "settings.section.notifications",
  },
  right_hand: {
    web: "/settings/right_hand",
    phone: "/settings/right-hand",
    // Everyone's: each person's own part is there, the workspace's shows only to who manages agents.
    may: null,
    label: "settings.section.right_hand",
  },
  import: {
    web: "/settings/import",
    phone: "/settings/import",
    may: "create_agents",
    label: "settings.section.import",
  },
  approvals: { web: "/approvals", phone: "/activity", may: null, label: "shell.approvals" },
  proposals: { web: "/proposals", phone: "/proposals", may: null, label: "shell.proposals" },
  routines: { web: "/routines", phone: "/routines", may: null, label: "shell.routines" },
  drive: { web: "/drive", phone: "/drive", may: null, label: "shell.drive" },
  wiki: { web: "/wiki", phone: "/wiki", may: null, label: "shell.wiki" },
  issues: { web: "/issues", phone: "/issues", may: null, label: "shell.issues" },
  calendar: { web: "/calendar", phone: null, may: null, label: "shell.calendar" },
  vault: { web: "/settings/vault", phone: "/settings/vault", may: null, label: "settings.section.vault" },
  ai_apps: { web: "/settings/apps", phone: "/settings/apps", may: null, label: "settings.section.apps" },
  approval_settings: {
    web: "/settings/approvals",
    phone: "/me/approvals",
    may: null,
    label: "settings.section.approvals",
  },
  media: { web: "/settings/media", phone: "/settings/media", may: "configure", label: "settings.section.media" },
  voice: { web: "/settings/voice", phone: null, may: "configure", label: "settings.section.voice" },
  agent: { web: "/agents/{agentId}", phone: "/agent/{agentId}", may: null, label: "" },
  channel: { web: "/c/{channelId}", phone: "/chat/{channelId}", may: null, label: "" },
} as const satisfies Record<string, { web: string; phone: string | null; may: Permission | null; label: string }>;

export type AppPage = keyof typeof APP_PAGES;

export const isAppPage = (v: unknown): v is AppPage => typeof v === "string" && Object.hasOwn(APP_PAGES, v);

/** A page's address with its agent or channel filled in; null when it needs one the card doesn't have. */
export function appPagePath(path: string | null, ids: { agentId?: string; channelId?: string }): string | null {
  if (!path) return null;
  if (path.includes("{agentId}") && !ids.agentId) return null;
  if (path.includes("{channelId}") && !ids.channelId) return null;
  return path.replace("{agentId}", ids.agentId ?? "").replace("{channelId}", ids.channelId ?? "");
}

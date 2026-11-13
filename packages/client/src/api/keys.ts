import type { ScreenKind } from "./types";

/** React Query keys. Everything under ["org", orgId] is dropped when switching organizations. */
export const keys = {
  health: ["health"] as const,
  instance: ["instance"] as const,
  telemetry: ["telemetry"] as const,
  jev: ["jev"] as const,
  /** The installation's GIPHY key (ADR 0091), not a workspace's: it stays when switching organizations. */
  gifKey: ["gif-key"] as const,
  speechKey: ["speech-key"] as const,
  authConfig: ["auth-config"] as const,
  me: ["me"] as const,
  accountDeletion: ["account-deletion"] as const,
  phoneSignIn: ["phone-sign-in"] as const,
  /** The server's Web Push key (ADR 0071); `null` = Web Push off on this server. */
  webPushKey: ["push", "web-key"] as const,
  models: ["models"] as const,
  invitation: (token: string) => ["invitation", token] as const,
  invitationState: (token: string) => ["invitation", token, "state"] as const,
  org: (orgId: string) => ["org", orgId] as const,
  members: (orgId: string) => ["org", orgId, "members"] as const,
  /** The workspace's roles (ADR 0085). */
  roles: (orgId: string) => ["org", orgId, "roles"] as const,
  /** Under `members`: someone joining or leaving refreshes it too. */
  limits: (orgId: string) => ["org", orgId, "members", "limits"] as const,
  invitations: (orgId: string) => ["org", orgId, "invitations"] as const,
  agents: (orgId: string) => ["org", orgId, "agents"] as const,
  /** Set whole by every change; read again on the `agent.groups` org event. */
  agentGroups: (orgId: string) => ["org", orgId, "agent-groups"] as const,
  /** Under `agents`: archiving or deleting one refreshes both. */
  formerAgents: (orgId: string) => ["org", orgId, "agents", "former"] as const,
  /** An agent's proposal of a new agent, by its card's message (ADR 0081). */
  agentProposal: (orgId: string, messageId: string) => ["org", orgId, "agent-proposal", messageId] as const,
  actionCard: (orgId: string, messageId: string) => ["org", orgId, "action-card", messageId] as const,
  teamTemplates: (orgId: string, locale: string) => ["org", orgId, "team-templates", locale] as const,
  team: (orgId: string) => ["org", orgId, "team"] as const,
  credentials: (orgId: string) => ["org", orgId, "credentials"] as const,
  /** Under `credentials`: a key added, rotated or removed refreshes it too. */
  aiStatus: (orgId: string) => ["org", orgId, "credentials", "ai-status"] as const,
  usage: (orgId: string) => ["org", orgId, "usage"] as const,
  channels: (orgId: string) => ["org", orgId, "channels"] as const,
  /** Under `channels`: archiving one, or bringing one back, refreshes both. */
  archivedChannels: (orgId: string) => ["org", orgId, "channels", "archived"] as const,
  channelCard: (orgId: string, channelId: string) => ["org", orgId, "channel", channelId, "card"] as const,
  messageCard: (orgId: string, messageId: string) => ["org", orgId, "message", messageId, "card"] as const,
  idRef: (orgId: string, id: string) => ["org", orgId, "ref", id] as const,
  channelCategories: (orgId: string) => ["org", orgId, "channel-categories"] as const,
  channelMembers: (orgId: string, channelId: string) => ["org", orgId, "channel", channelId, "members"] as const,
  channelPermissions: (orgId: string, channelId: string) =>
    ["org", orgId, "channel", channelId, "permissions"] as const,
  messages: (orgId: string, channelId: string) => ["org", orgId, "channel", channelId, "messages"] as const,
  /** A channel's older pages loaded on scroll-up: outside the channel's key, which holds only message lists. */
  olderPages: (orgId: string, channelId: string) => ["org", orgId, "older-pages", channelId] as const,
  thread: (orgId: string, channelId: string, rootId: string) =>
    ["org", orgId, "channel", channelId, "thread", rootId] as const,
  approvals: (orgId: string) => ["org", orgId, "approvals"] as const,
  approval: (orgId: string, approvalId: string) => ["org", orgId, "approvals", approvalId] as const,
  catalog: ["connector-catalog"] as const,
  connections: (orgId: string) => ["org", orgId, "connections"] as const,
  githubApp: (orgId: string) => ["org", orgId, "github-app"] as const,
  githubRepos: (orgId: string) => ["org", orgId, "github-repositories"] as const,
  githubAccess: (orgId: string) => ["org", orgId, "github-access"] as const,
  agentRepos: (orgId: string, agentId: string) => ["org", orgId, "agent", agentId, "repositories"] as const,
  agentMergeRepos: (orgId: string, agentId: string) => ["org", orgId, "agent", agentId, "merge-repositories"] as const,
  customServers: (orgId: string) => ["org", orgId, "custom-servers"] as const,
  scopes: (orgId: string, agentId: string) => ["org", orgId, "agent", agentId, "scopes"] as const,
  /** What the agent runs without asking ("Aprovar sempre"). */
  approvalCovers: (orgId: string) => ["org", orgId, "approval-covers"] as const,
  rightHandApprovals: (orgId: string) => ["org", orgId, "right-hand-approvals"] as const,
  approvalRules: (orgId: string, agentId: string) => ["org", orgId, "agent", agentId, "approval-rules"] as const,
  runs: (orgId: string, agentId: string) => ["org", orgId, "agent", agentId, "runs"] as const,
  /** Whether the agent has a run going now (its newest running run, if any). */
  runningRuns: (orgId: string, agentId: string) => ["org", orgId, "agent", agentId, "runs", "running"] as const,
  run: (orgId: string, runId: string) => ["org", orgId, "run", runId] as const,
  /** The questions agents asked other agents from a conversation (drawn inside the replies that asked). */
  consultations: (orgId: string, channelId: string) => ["org", orgId, "channel", channelId, "consultations"] as const,
  /** Under `consultations`: reloading the list reloads an open one too. */
  consultation: (orgId: string, channelId: string, consultationId: string) =>
    ["org", orgId, "channel", channelId, "consultations", consultationId] as const,
  agentDetail: (orgId: string, agentId: string) => ["org", orgId, "agent", agentId, "detail"] as const,
  agentBrain: (orgId: string, agentId: string) => ["org", orgId, "agent", agentId, "brain"] as const,
  /** Every single agent's reads (its page, its brain). */
  agentPages: (orgId: string) => ["org", orgId, "agent"] as const,
  aiAccounts: (orgId: string) => ["org", orgId, "ai-accounts"] as const,
  accountLogin: (orgId: string, machineId: string, loginId: string) =>
    ["org", orgId, "machine", machineId, "account-login", loginId] as const,
  agentChannels: (orgId: string, agentId: string) => ["org", orgId, "agent", agentId, "channels"] as const,
  settings: (orgId: string) => ["org", orgId, "settings"] as const,
  overview: (orgId: string) => ["org", orgId, "overview"] as const,
  people: (orgId: string) => ["org", orgId, "people"] as const,
  agentStatus: (orgId: string) => ["org", orgId, "agent-status"] as const,
  /** Under `agentStatus`: an `agent.status` event refetches it too. */
  usageQueue: (orgId: string, agentId: string) => ["org", orgId, "agent-status", "usage-queue", agentId] as const,
  allInvitations: (orgId: string) => ["org", orgId, "invitations", "all"] as const,
  /** Under `invitations`: an approval (which may invite) refreshes the pending list too. */
  joinRequests: (orgId: string) => ["org", orgId, "invitations", "join-requests"] as const,
  mySuggestions: (orgId: string) => ["org", orgId, "invitations", "suggestions"] as const,
  inviteLinks: (orgId: string) => ["org", orgId, "invitations", "links"] as const,
  usageReport: (orgId: string) => ["org", orgId, "usage-report"] as const,
  composioUsage: (orgId: string) => ["org", orgId, "usage-composio"] as const,
  audit: (orgId: string, query: object) => ["org", orgId, "audit", query] as const,
  /** The usage views; an agent's sits under it, so one invalidation refreshes both. */
  planUsage: (orgId: string) => ["org", orgId, "plan-usage"] as const,
  agentPlanUsage: (orgId: string, agentId: string) => ["org", orgId, "plan-usage", "agent", agentId] as const,
  /** Uso › Pessoas and a person's month (ADR 0141); one invalidation refreshes both. */
  peopleUsage: (orgId: string, period: object = {}) => ["org", orgId, "people-usage", period] as const,
  personUsage: (orgId: string, userId: string) => ["org", orgId, "people-usage", "person", userId] as const,
  personLimits: (orgId: string) => ["org", orgId, "people-usage", "limits"] as const,
  teamWeek: (orgId: string) => ["org", orgId, "team-week"] as const,
  platformKey: (orgId: string) => ["org", orgId, "platform-key"] as const,
  roster: (orgId: string, channelId: string) => ["org", orgId, "channel", channelId, "roster"] as const,
  /** All the agents' memories, for the workspace's map. */
  orgMemories: (orgId: string) => ["org", orgId, "memories"] as const,
  teamMemories: (orgId: string) => ["org", orgId, "team-memories"] as const,
  memory: (orgId: string, agentId: string) => ["org", orgId, "agent", agentId, "memory"] as const,
  /** Under `memory`: invalidating an agent's memories also refreshes "O que sabe sobre você". */
  memoryAboutMe: (orgId: string, agentId: string) => ["org", orgId, "agent", agentId, "memory", "me"] as const,
  agentForYou: (orgId: string, agentId: string) => ["org", orgId, "agent", agentId, "for-you"] as const,
  proposals: (orgId: string) => ["org", orgId, "proposals"] as const,
  /** A chat card's rows (under `proposals`: deciding any refreshes it too). */
  cardProposals: (orgId: string, ids: string[]) => ["org", orgId, "proposals", "card", ids.join(",")] as const,
  dms: (orgId: string) => ["org", orgId, "dms"] as const,
  dmReads: (orgId: string, channelId: string) => ["org", orgId, "dmReads", channelId] as const,
  storage: (orgId: string) => ["org", orgId, "storage"] as const,
  artifacts: (orgId: string) => ["org", orgId, "artifacts"] as const,
  sandbox: (orgId: string) => ["org", orgId, "sandbox"] as const,
  sandboxSettings: (orgId: string) => ["org", orgId, "sandbox", "settings"] as const,
  computer: (orgId: string, agentId: string) => ["org", orgId, "sandbox", "computer", agentId] as const,
  /** Every agent's computer view (prefix of `computer`). */
  computers: (orgId: string) => ["org", orgId, "sandbox", "computer"] as const,
  agentSecrets: (orgId: string, agentId: string) => ["org", orgId, "agent-secrets", agentId] as const,
  machines: (orgId: string) => ["org", orgId, "machines"] as const,
  /** Devices (under `machines`: every computer event refetches them too). */
  devices: (orgId: string) => ["org", orgId, "machines", "devices"] as const,
  /** Under `devices`: a phone picked over Wi-Fi leaves the offer when the list refetches. */
  wifiIphones: (orgId: string, machineId: string) => ["org", orgId, "machines", "devices", "wifi", machineId] as const,
  connectLink: (orgId: string, linkId: string) => ["org", orgId, "machines", "devices", "link", linkId] as const,
  /** Under `machines`: a computer that changes refreshes what a new agent could think with. */
  brainMachines: (orgId: string) => ["org", orgId, "machines", "brains"] as const,
  /** What a new agent starts thinking with (ADR 0094). */
  newAgentSetup: (orgId: string) => ["org", orgId, "agent-setup"] as const,
  /** What a setup would do to each agent (`sig`: the setup and the agents, as JSON). */
  setupPreview: (orgId: string, sig: string) => ["org", orgId, "setup-preview", sig] as const,
  /** The server's own computer here (under `machines`: a machines refetch refreshes it too). */
  hostComputer: (orgId: string) => ["org", orgId, "machines", "host"] as const,
  /** Offline computers agents wait for (under `machines`: a machines refetch refreshes it too). */
  machineOutages: (orgId: string) => ["org", orgId, "machines", "outages"] as const,
  /** A computer's line (under `machines`); `computer.queue` org events refetch it. */
  machineQueue: (orgId: string, machineId: string) => ["org", orgId, "machines", "queue", machineId] as const,
  /** The workspace's own computer on its way (ADR 0056 §10); `machine.provisioning` events set it. */
  computerSetup: (orgId: string) => ["org", orgId, "computer-setup"] as const,
  /** A computer's device code (`/conectar`): not under an organization, it is picked on that page. */
  machineDevice: (userCode: string) => ["machine-device", userCode] as const,
  /** Settings → AI apps: mine, or the whole workspace's (`all`), both under `apps`. */
  apps: (orgId: string, all = false) => ["org", orgId, "apps", all ? "all" : "mine"] as const,
  /** An app's consent (`/autorizar?req=`): not under an organization, it is picked on that page. */
  appConsent: (requestId: string) => ["app-consent", requestId] as const,
  desktopLatest: (target: string, arch: string) => ["desktop-latest", target, arch] as const,
  artifactBlob: (orgId: string, id: string, version: number) =>
    ["org", orgId, "artifacts", "blob", id, version] as const,
  skills: (orgId: string) => ["org", orgId, "skills"] as const,
  skill: (orgId: string, id: string) => ["org", orgId, "skills", "one", id] as const,
  skillSettings: (orgId: string) => ["org", orgId, "skills", "settings"] as const,
  agentSkills: (orgId: string, agentId: string) => ["org", orgId, "skills", "agent", agentId] as const,
  learnedSkills: (orgId: string, agentId: string) => ["org", orgId, "skills", "learned", agentId] as const,
  access: (orgId: string) => ["org", orgId, "access"] as const,
  agentAccess: (orgId: string, agentId: string) => ["org", orgId, "access", "agent", agentId] as const,
  issues: (orgId: string) => ["org", orgId, "issues"] as const,
  issueList: (orgId: string, q: string) => ["org", orgId, "issues", "list", q] as const,
  issue: (orgId: string, number: number) => ["org", orgId, "issues", "one", number] as const,
  issueActivity: (orgId: string, id: string) => ["org", orgId, "issues", "activity", id] as const,
  issueColumns: (orgId: string) => ["org", orgId, "issues", "columns"] as const,
  /** Every thread view and list (prefix): a `thread.updated` refreshes them all. */
  threads: (orgId: string) => ["org", orgId, "threads"] as const,
  threadList: (orgId: string, filters: object) => ["org", orgId, "threads", "list", filters] as const,
  threadInfo: (orgId: string, threadId: string) => ["org", orgId, "threads", "one", threadId] as const,
  /** How many threads I follow have an unread reply (the Threads entry's mark). */
  unreadThreads: (orgId: string) => ["org", orgId, "threads", "unread"] as const,
  unreadTasks: (orgId: string) => ["org", orgId, "issues", "unread"] as const,
  channelThreads: (orgId: string, channelId: string, tab: string) =>
    ["org", orgId, "threads", "channel", channelId, tab] as const,
  /** The messages of a thread's context range (another channel's, or this one's). */
  threadRange: (orgId: string, threadId: string) => ["org", orgId, "threads", "range", threadId] as const,
  /** Every mission read (prefix): a `mission.updated` refreshes what it touches. */
  missions: (orgId: string) => ["org", orgId, "missions"] as const,
  missionList: (orgId: string, status: string) => ["org", orgId, "missions", "list", status] as const,
  mission: (orgId: string, missionId: string) => ["org", orgId, "missions", "one", missionId] as const,
  /** A mission's reads (decisions, reviews, files, plan, participants): `["…", missionId, part]`. */
  missionPart: (orgId: string, missionId: string, part: string) =>
    ["org", orgId, "missions", "part", missionId, part] as const,
  threadMission: (orgId: string, threadId: string) => ["org", orgId, "missions", "thread", threadId] as const,
  threadTasks: (orgId: string, threadId: string) => ["org", orgId, "missions", "tasks", threadId] as const,
  routines: (orgId: string) => ["org", orgId, "routines"] as const,
  routineRuns: (orgId: string, id: string) => ["org", orgId, "routines", "runs", id] as const,
  routineHook: (orgId: string, id: string) => ["org", orgId, "routines", "hook", id] as const,
  webhookSetup: (orgId: string, provider: string) => ["org", orgId, "routines", "webhook", provider] as const,
  calendar: (orgId: string) => ["org", orgId, "calendar"] as const,
  calendarRange: (orgId: string, from: string) => ["org", orgId, "calendar", from] as const,
  artifactList: (orgId: string, filters: object) => ["org", orgId, "artifacts", "list", filters] as const,
  artifact: (orgId: string, id: string, version?: number) =>
    ["org", orgId, "artifacts", "one", id, version ?? "latest"] as const,
  artifactVersions: (orgId: string, id: string) => ["org", orgId, "artifacts", "versions", id] as const,
  poll: (orgId: string, id: string) => ["org", orgId, "polls", id] as const,
  blockState: (orgId: string, id: string, version: number) => ["org", orgId, "blocks", id, version] as const,
  choices: (orgId: string, id: string) => ["org", orgId, "choices", id] as const,
  storageMigration: (orgId: string) => ["org", orgId, "storage", "migration"] as const,
  search: (orgId: string, q: string, kinds: string) => ["org", orgId, "search", q, kinds] as const,
  reactions: (orgId: string, messageId: string) => ["org", orgId, "reactions", messageId] as const,
  /** Every notification read (prefix): lists per filter and the badge count. */
  notifications: (orgId: string) => ["org", orgId, "notifications"] as const,
  notificationList: (orgId: string, filter: string) => ["org", orgId, "notifications", "list", filter] as const,
  notificationCount: (orgId: string) => ["org", orgId, "notifications", "count"] as const,
  noticePrefs: (orgId: string) => ["org", orgId, "notice-prefs"] as const,
  sidebarItems: (orgId: string) => ["org", orgId, "sidebar-items"] as const,
  sidebarOrder: (orgId: string) => ["org", orgId, "sidebar-order"] as const,
  issuesView: (orgId: string) => ["org", orgId, "issues-view"] as const,
  sidebarToolOrder: (orgId: string) => ["org", orgId, "sidebar-tool-order"] as const,
  sidebarView: (orgId: string) => ["org", orgId, "sidebar-view"] as const,
  wiki: (orgId: string) => ["org", orgId, "wiki"] as const,
  wikiTree: (orgId: string) => ["org", orgId, "wiki", "tree"] as const,
  wikiPage: (orgId: string, slug: string) => ["org", orgId, "wiki", "page", slug] as const,
  wikiHistory: (orgId: string, slug: string) => ["org", orgId, "wiki", "history", slug] as const,
  wikiGraph: (orgId: string) => ["org", orgId, "wiki", "graph"] as const,
  wikiReads: (orgId: string) => ["org", orgId, "wiki", "reads"] as const,
  wikiTrash: (orgId: string) => ["org", orgId, "wiki", "trash"] as const,
  pins: (orgId: string, channelId: string) => ["org", orgId, "channel", channelId, "pins"] as const,
  /** Every GIF search (prefix): the workspace's rating or its GIFs switch changing refreshes them all (ADR 0091). */
  gifs: (orgId: string) => ["org", orgId, "gifs"] as const,
  /** One search's pages: free text or a category (neither: what is trending), in the person's language. */
  gifSearch: (orgId: string, q: string, category: string | null, lang: string) =>
    ["org", orgId, "gifs", q, category ?? "", lang] as const,
  working: (orgId: string) => ["org", orgId, "working"] as const,
  taskManager: (orgId: string) => ["org", orgId, "task-manager"] as const,
  taskSteps: (orgId: string, runId: string) => ["org", orgId, "task-manager", "steps", runId] as const,
  reminders: (orgId: string) => ["org", orgId, "reminders"] as const,
  /** Every mailbox read (prefix). */
  mail: (orgId: string) => ["org", orgId, "mail"] as const,
  mailProviders: (orgId: string) => ["org", orgId, "mail", "providers"] as const,
  mailAccounts: (orgId: string) => ["org", orgId, "mail", "accounts"] as const,
  mailFolders: (orgId: string, accountId: string) => ["org", orgId, "mail", "folders", accountId] as const,
  mailSuggested: (orgId: string, accountId: string) => ["org", orgId, "mail", "suggested", accountId] as const,
  agentMail: (orgId: string, agentId: string) => ["org", orgId, "mail", "agent", agentId] as const,
  /** Every database read (prefix). */
  databases: (orgId: string) => ["org", orgId, "databases"] as const,
  databaseList: (orgId: string) => ["org", orgId, "databases", "list"] as const,
  databaseTables: (orgId: string, connectionId: string, database = "") =>
    ["org", orgId, "databases", "tables", connectionId, database] as const,
  serverDatabases: (orgId: string, connectionId: string) =>
    ["org", orgId, "databases", "server", connectionId] as const,
  agentDatabases: (orgId: string, agentId: string) => ["org", orgId, "databases", "agent", agentId] as const,
  /** The agent browser (ADR 0040): an agent's settings, its open request on each screen, one request (prefix). */
  browser: (orgId: string) => ["org", orgId, "browser"] as const,
  agentBrowser: (orgId: string, agentId: string) => ["org", orgId, "browser", "agent", agentId] as const,
  /** The workspace's browser profiles (ADR 0110). */
  browserProfiles: (orgId: string) => ["org", orgId, "browser", "profiles"] as const,
  /** Everything of the Vault (ADR 0144), the prefix `vault.changed` refreshes. */
  vault: (orgId: string) => ["org", orgId, "vault"] as const,
  /** The Vault as this person sees it: items (never a value), connections, sources. */
  vaultOverview: (orgId: string) => ["org", orgId, "vault", "overview"] as const,
  /** One item with its recent uses. */
  vaultItem: (orgId: string, itemId: string) => ["org", orgId, "vault", "item", itemId] as const,
  agentBrowserHandoff: (orgId: string, agentId: string, screen: ScreenKind = "browser") =>
    ["org", orgId, "browser", "agent", agentId, "handoff", screen] as const,
  agentBrowserControl: (orgId: string, agentId: string, screen: ScreenKind = "browser") =>
    ["org", orgId, "browser", "agent", agentId, "control", screen] as const,
  browserHandoff: (orgId: string, handoffId: string) => ["org", orgId, "browser", "handoff", handoffId] as const,
  /** The agent's desktop (ADR 0058): its state as this person sees it. */
  agentDesktop: (orgId: string, agentId: string) => ["org", orgId, "desktop", agentId] as const,
  agentDesktopPicture: (orgId: string, agentId: string) => ["org", orgId, "desktop", agentId, "picture"] as const,
  /** Every agent's screen (`agentDesktop`'s prefix). */
  agentDesktops: (orgId: string) => ["org", orgId, "desktop"] as const,
  /** Boards and widgets (ADR 0135): everything below (prefix); `dashboard.*` events refresh it. */
  dashboards: (orgId: string) => ["org", orgId, "dashboards"] as const,
  dashboardList: (orgId: string) => ["org", orgId, "dashboards", "list"] as const,
  dashboard: (orgId: string, dashboardId: string) => ["org", orgId, "dashboards", "one", dashboardId] as const,
  /** My home board ("My Home", the Home mural). */
  dashboardHome: (orgId: string) => ["org", orgId, "dashboards", "home"] as const,
  widget: (orgId: string, widgetId: string) => ["org", orgId, "dashboards", "widget", widgetId] as const,
  widgetCost: (orgId: string, agentId: string, schedule: string) =>
    ["org", orgId, "dashboards", "cost", agentId, schedule] as const,
  widgetSuggestions: (orgId: string, agentId: string) => ["org", orgId, "dashboards", "suggestions", agentId] as const,
  widgetPinnable: (orgId: string) => ["org", orgId, "dashboards", "pinnable"] as const,
};

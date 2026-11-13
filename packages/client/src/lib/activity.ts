import type { TFunction } from "i18next";
import type { LiveConsult, LiveConsultStatus } from "../realtime/consults";
import type { LiveRun } from "../realtime/streams";
import { joinNames } from "./format";
import { MAIL_BRANDS } from "./mail";

/**
 * What the typing bar says someone is doing: "Theo está pensando…", "Theo
 * está consultando o GitHub…", "Marina está digitando…". Agents' verbs come
 * from the tool they are calling (`agent.tool`, see realtime/streams.ts).
 */
export type ActivityKind =
  | "thinking"
  | "typing"
  | "writing"
  | "consulting"
  | "creatingIssue"
  | "updatingIssue"
  | "readingIssues"
  | "readingDrive"
  | "writingDrive"
  | "searchingMemory"
  | "updatingMemory"
  | "checkingCalendar"
  | "schedulingEvent"
  | "askingQuestion"
  | "reacting"
  | "sendingGif"
  | "sendingSticker"
  | "openingSkill"
  | "consultingSkill"
  | "runningCode"
  | "browsing"
  | "pcFiles"
  | "exportingFile"
  | "importingFile"
  | "runningSkillScript"
  | "runningSkillScriptAny"
  | "fetchingFile"
  | "schedulingReminder"
  | "creatingRoutine"
  | "updatingRoutine"
  | "proposingMission"
  | "messagingMission"
  | "updatingPlan"
  | "reportingProgress"
  | "askingDecision"
  | "requestingReview"
  | "requestingApproval"
  | "startingTask"
  | "listingTasks"
  | "checkingTask"
  | "cancelingTask"
  | "uploadingArtifact"
  | "gettingContext"
  | "cancelingReminder"
  | "followingUp"
  | "cancelingFollowUp"
  | "listingReminders"
  | "listingRoutines"
  | "checkingComputer"
  | "writingWiki"
  | "readingWiki"
  | "linkingWiki"
  | "creatingChannel"
  | "offeringConnectAi"
  | "offeringConnectApp"
  | "offeringSkill"
  | "updatingSkills"
  | "offeringInvites"
  | "proposingAgent"
  | "askingAgent"
  | "tellingAgent"
  | "findingTools"
  | "runningCommand"
  | "runningCommandAny"
  | "usingScreen"
  | "cloningRepo"
  | "openingPullRequest"
  | "handingOff"
  | "recordingFindings"
  | "deliveringMission"
  | "requestingAccess"
  | "requestingSecret"
  | "queryingDatabase"
  | "checkingUsage"
  | "findingAgent"
  | "searchingWeb"
  | "readingWeb"
  | "preparingCard"
  | "startingPoll"
  | "askingChoices"
  | "usingVault"
  | "makingPassword"
  | "startingWork"
  | "updatingWork"
  | "withdrawingRequest"
  | "releasingAgent"
  | "schedulingAction"
  | "updatingDashboard"
  | "testingOnPhone"
  | "waitingForDevice"
  | "readingDashboards"
  | "pushingBranch"
  | "deletingBranches"
  | "postingMessage"
  | "sendingDm"
  | "settingStatus"
  | "settingReplyStyle"
  | "sendingFeedback"
  | "offeringFeedback"
  | "deletingRoutine"
  | "runningRoutine"
  | "proposingTeam"
  | "proposingChange"
  | "workingOnWorkspace"
  | "updatingThread"
  | "addingAgent"
  | "readingConversation"
  | "usingTool";

/** The computer's own permission check before a command (`PERMISSION_TOOL` in `@agenteschat/adapters`). */
export const PERMISSION_TOOL = "permission_prompt";

export interface Activity {
  kind: ActivityKind;
  /** The app being consulted ("GitHub", "himetrica"), for `consulting`; the skill name for `openingSkill`. */
  app?: string;
  /**
   * The service the call works in, for its logo: a catalog connector's id (`github`, `drive`), a mailbox's maker
   * with a mark (`gmail`), `mail` for any other mailbox, or `postgres`.
   */
  service?: string;
  /** A server connected by address: its own icon (`/api/app/connector-icons/…`). */
  icon?: string;
}

/** Where a call works, as `agent.tool` and the saved `tool_call` step say it (the engine's `ToolDefinition`). */
export interface ToolService {
  service?: string | null;
  serviceIcon?: string | null;
}

/** The engine's own tools (packages/engine/src/context, issues, artifacts, calendar). */
const BUILTIN: Record<string, ActivityKind> = {
  create_issue: "creatingIssue",
  update_issue: "updatingIssue",
  comment_issue: "updatingIssue",
  list_issues: "readingIssues",
  get_issue: "readingIssues",
  read_artifact: "readingDrive",
  list_artifacts: "readingDrive",
  create_artifact: "writingDrive",
  update_artifact: "writingDrive",
  search_context: "searchingMemory",
  expand: "searchingMemory",
  get_summary: "searchingMemory",
  remember: "updatingMemory",
  forget: "updatingMemory",
  update_memory: "updatingMemory",
  save_how_to: "updatingMemory",
  propose_instruction_change: "updatingMemory",
  list_events: "checkingCalendar",
  find_free_time: "checkingCalendar",
  propose_event: "schedulingEvent",
  ask_user: "askingQuestion",
  react: "reacting",
  // A GIF or the agent's sticker (ADR 0091): the message itself shows it, the block says it was sent.
  send_gif: "sendingGif",
  send_sticker: "sendingSticker",
  // The agent's PC (sandbox).
  run_code: "runningCode",
  write_file: "pcFiles",
  read_file: "pcFiles",
  list_files: "pcFiles",
  export_file: "exportingFile",
  upload_file: "exportingFile",
  import_file: "importingFile",
  share_artifact: "fetchingFile",
  // Scheduling from the chat.
  schedule_reminder: "schedulingReminder",
  create_routine: "creatingRoutine",
  update_routine: "updatingRoutine",
  read_skill_file: "consultingSkill",
  update_skill: "consultingSkill",
  // Missions (the agent's tools and the executor's MCP tools).
  propose_mission: "proposingMission",
  send_to_mission: "messagingMission",
  update_plan: "updatingPlan",
  report: "reportingProgress",
  ask_decision: "askingDecision",
  request_review: "requestingReview",
  request_approval: "requestingApproval",
  start_task: "startingTask",
  list_tasks: "listingTasks",
  task_status: "checkingTask",
  cancel_task: "cancelingTask",
  upload_artifact: "uploadingArtifact",
  get_context: "gettingContext",
  cancel_reminder: "cancelingReminder",
  list_reminders: "listingReminders",
  list_routines: "listingRoutines",
  computer_status: "checkingComputer",
  wait_for_device: "waitingForDevice",
  create_wiki_page: "writingWiki",
  update_wiki_page: "writingWiki",
  read_wiki_page: "readingWiki",
  search_wiki: "readingWiki",
  link_to_wiki: "linkingWiki",
  // Setting up the workspace.
  create_channel: "creatingChannel",
  offer_connect_ai: "offeringConnectAi",
  offer_connect_app: "offeringConnectApp",
  offer_invites: "offeringInvites",
  offer_install_skill: "offeringSkill",
  update_skill_from_source: "updatingSkills",
  propose_agent: "proposingAgent",
  // Another agent of the team (the consultation card says who and what it answered).
  ask_agent: "askingAgent",
  tell_agent: "tellingAgent",
  // Ours, though their first word reads like an app's name.
  git_clone: "cloningRepo",
  open_pull_request: "openingPullRequest",
  hand_off: "handingOff",
  record_findings: "recordingFindings",
  complete_mission: "deliveringMission",
  request_permission: "requestingAccess",
  request_folder_access: "requestingAccess",
  request_secret: "requestingSecret",
  use_tool: "findingTools",
  follow_up: "followingUp",
  get_my_usage: "checkingUsage",
  find_agent: "findingAgent",
  // The right hand's look at the team: its tasks, open and stuck, and what waits.
  team_status: "listingTasks",
  cancel_follow_up: "cancelingFollowUp",
  web_search: "searchingWeb",
  web_fetch: "readingWeb",
  read_conversation: "readingConversation",
  // A card of ours in the conversation: the card itself says what it holds.
  show_block: "preparingCard",
  offer_approvals: "preparingCard",
  offer_open_page: "preparingCard",
  set_team_week: "preparingCard",
  start_poll: "startingPoll",
  ask_choices: "askingChoices",
  offer_answers: "askingChoices",
  vault_list: "usingVault",
  vault_save: "usingVault",
  vault_delete: "usingVault",
  vault_make_password: "makingPassword",
  work_in_background: "startingWork",
  steer_work: "updatingWork",
  stop_work: "updatingWork",
  post_update: "updatingWork",
  withdraw_request: "withdrawingRequest",
  release_waiting_agent: "releasingAgent",
  schedule_action: "schedulingAction",
  create_dashboard: "updatingDashboard",
  create_widget: "updatingDashboard",
  update_widget: "updatingDashboard",
  share_dashboard: "updatingDashboard",
  list_dashboards: "readingDashboards",
  request_branch_push: "pushingBranch",
  delete_branches: "deletingBranches",
  post_message: "postingMessage",
  send_dm: "sendingDm",
  set_status: "settingStatus",
  set_reply_style: "settingReplyStyle",
  send_feedback: "sendingFeedback",
  offer_feedback: "offeringFeedback",
  delete_routine: "deletingRoutine",
  run_routine_now: "runningRoutine",
  propose_team: "proposingTeam",
  propose_settings_change: "proposingChange",
  request_settings_change: "proposingChange",
  propose_member_changes: "proposingChange",
  propose_remove_agents: "proposingChange",
  // The right hand's catalog of what a person can do: a look for the action, the change at once, or its card.
  workspace_action: "workingOnWorkspace",
  update_thread: "updatingThread",
  add_agent_to_channel: "addingAgent",
};

/** A computer brain's own tools (`agent.step`: Claude Code's, Codex's, OpenCode's, Grok Build's), lower-cased. */
const OWN_TOOLS: Record<string, ActivityKind> = {
  read: "pcFiles",
  write_file: "pcFiles",
  edit_file: "pcFiles",
  search_replace: "pcFiles",
  list_dir: "pcFiles",
  run_terminal_cmd: "runningCommandAny",
  run_terminal_command: "runningCommandAny",
  edit: "pcFiles",
  multiedit: "pcFiles",
  write: "pcFiles",
  glob: "pcFiles",
  grep: "pcFiles",
  ls: "pcFiles",
  file_change: "pcFiles",
  bash: "runningCommandAny",
  shell: "runningCommandAny",
  toolsearch: "findingTools",
};

/** Catalog connectors (packages/engine/src/connectors/catalog.ts): tools are exposed as `<id>_<tool>`. */
const CONNECTORS: Record<string, string> = {
  github: "GitHub",
  sentry: "Sentry",
  linear: "Linear",
  drive: "Drive",
  slack: "Slack",
  notion: "Notion",
  jira: "Jira",
  stripe: "Stripe",
  // The org's own mailboxes (`mail_<slug>_<verb>`, ADR 0038), labeled "Email" like their tools.
  mail: "Email",
};

const isDrive = (id: string) => id === "drive" || id === "google_drive";
/** A connection's service as its name says it: "Google Drive (ana@acme.com) 2" → "google_drive". */
export const serviceKey = (label: string) =>
  label
    .replace(/\s+\d+$/, "")
    .replace(/\s*\([^)]*\)$/, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");

/** One of the org's mailboxes' tools (`mail_<slug>_<verb>`, ADR 0038), also through the executor's MCP. */
const MAILBOX_TOOL = /^(?:mcp__agentes__)?mail_[a-z0-9]+_[a-z]+$/;

/**
 * The friendly activity of a tool call. `connector` is the app label when the
 * event carries it; without it, only a catalog connector's prefix names an app.
 * `where`: the service the call names, for its logo. A mailbox goes by its maker's
 * name when the app draws its mark ("Consultou o Gmail"), else by "Email".
 */
export function toolActivity(
  tool: string | null | undefined,
  connector?: string | null,
  detail?: string | null,
  where?: ToolService | null,
): Activity {
  const a = activityOf(tool, connector, detail);
  const service = where?.service?.trim() || undefined;
  if (a.kind === "consulting" && MAILBOX_TOOL.test((tool ?? "").trim().toLowerCase())) {
    const brand = service ? MAIL_BRANDS[service] : undefined;
    return brand ? { kind: "consulting", app: brand.name, service } : { ...a, service: "mail" };
  }
  return { ...a, ...(service ? { service } : {}), ...(where?.serviceIcon ? { icon: where.serviceIcon } : {}) };
}

function activityOf(tool: string | null | undefined, connector?: string | null, detail?: string | null): Activity {
  let name = (tool ?? "").trim().toLowerCase();
  if (!name) return { kind: "thinking" };
  // An executor's MCP tool (`mcp__agentes__update_plan`): ours by its own name; another server's is that app.
  const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
  if (mcp) {
    const [, server = "", rest = ""] = mcp;
    if (server !== "agentes" && !BUILTIN[rest]) return { kind: "consulting", app: CONNECTORS[server] ?? server };
    name = rest;
  }
  // "Theo está abrindo a skill Revisão de PR…", or "consultando uma skill" without the name.
  if (name === "run_skill_script") {
    return detail?.trim() ? { kind: "runningSkillScript", app: detail.trim() } : { kind: "runningSkillScriptAny" };
  }
  if (name === "load_skill")
    return detail?.trim() ? { kind: "openingSkill", app: detail.trim() } : { kind: "consultingSkill" };
  // "Rodou: Rerun the tests": the command it checked, by the engine's label (`toolDetail`).
  if (name === PERMISSION_TOOL)
    return detail?.trim() ? { kind: "runningCommand", app: detail.trim() } : { kind: "runningCommandAny" };
  const builtin = BUILTIN[name] ?? OWN_TOOLS[name];
  if (builtin) return { kind: builtin };
  // The tools on demand: looking one up (a big connector's own directory too) is ours, not an app.
  if (name === "find_tools" || name.endsWith("_find_tools")) return { kind: "findingTools" };
  // The agent's own browser (ADR 0040) and screen (ADR 0062): not apps called "browser" and "desktop".
  if (name.startsWith("browser_")) return { kind: "browsing" };
  if (name.startsWith("desktop_")) return { kind: "usingScreen" };
  if (name.startsWith("phone_")) return { kind: "testingOnPhone" };
  const label = connector?.trim();
  if (label) {
    if (isDrive(serviceKey(label))) return { kind: "readingDrive" };
    return { kind: "consulting", app: label };
  }
  // The org's databases (`pg_<slug>_query`, ADR 0039) when the event names no connection.
  if (name.startsWith("pg_")) return { kind: "queryingDatabase" };
  const prefix = name.split(/[_.:]/)[0] ?? "";
  if (isDrive(prefix) || name.startsWith("google_drive_")) return { kind: "readingDrive" };
  const known = CONNECTORS[prefix];
  // Only a catalog connector's own prefix names an app: any other first word is a word of the tool's name.
  return known ? { kind: "consulting", app: known } : { kind: "usingTool" };
}

export interface ActivityEntry {
  id: string;
  type: "agent" | "person";
  name: string;
  activity: Activity;
  /** The agent is asking another agent (or just heard back): its own phrase, never grouped. */
  consult?: EntryConsult;
}

export interface EntryConsult {
  /** The agent it asked. */
  to: string;
  toName: string;
  status: LiveConsultStatus;
  /** When the question went out (the clock). */
  since: number;
}

/** Live statuses the working bar shows (the ones "Parar" can stop; a provisional row is about to be one). */
const BAR_STATUSES: ReadonlySet<string> = new Set(["thinking", "queued", "running"]);

/**
 * At work: its words wait for its message, which shows them whole once posted. Its row in the conversation draws only
 * for something to show meanwhile (its browser card), and the bar says who works, on what and for how long.
 */
export const waitsForWords = (r: Pick<LiveRun, "status">) =>
  // Waiting on an approval keeps the waiting row: a header for that moment would jump in and out again.
  BAR_STATUSES.has(r.status) || r.status === "waiting_approval";

/**
 * Who shows in the bar, in order: agents asking another agent (`consults`), agents at work (thinking, at a tool or
 * writing: their words show whole once posted), then people typing.
 */
export function barEntries(
  runs: LiveRun[],
  typingUserIds: string[],
  agentName: (id: string) => string,
  personName: (id: string) => string | undefined,
  consults: LiveConsult[] = [],
): ActivityEntry[] {
  const out: ActivityEntry[] = [];
  const seen = new Set<string>();
  for (const c of consults) {
    if (seen.has(c.agentId)) continue;
    // Its run failed: its row in the conversation says so.
    if (runs.some((r) => r.runId === c.runId && r.status === "failed")) continue;
    seen.add(c.agentId);
    out.push({
      id: c.agentId,
      type: "agent",
      name: agentName(c.agentId),
      activity: { kind: "thinking" },
      consult: { to: c.consultedAgentId, toName: agentName(c.consultedAgentId), status: c.status, since: c.since },
    });
  }
  for (const r of runs) {
    // Only work in progress: a run waiting (an approval, an answer, its computer) or ended isn't "working".
    if (!BAR_STATUSES.has(r.status) || seen.has(r.agentId)) continue;
    seen.add(r.agentId);
    out.push({
      id: r.agentId,
      type: "agent",
      name: agentName(r.agentId),
      // `running` with no call out: its words are on their way (they show whole, once posted).
      activity:
        r.status === "running" && !r.tool ? { kind: "writing" } : toolActivity(r.tool, r.connector, r.toolDetail, r),
    });
  }
  for (const id of typingUserIds) {
    const name = personName(id);
    if (name) out.push({ id, type: "person", name, activity: { kind: "typing" } });
  }
  return out;
}

/** How many small faces the bar stacks, however many are at work (the sentence says "e mais N"). */
export const BAR_FACES = 3;

/** The faces the bar stacks: agents first, and at least one person typing when someone is. */
export function barFaces(entries: ActivityEntry[]): ActivityEntry[] {
  const agents = entries.filter((e) => e.type === "agent");
  const people = entries.filter((e) => e.type === "person");
  const shown = agents.slice(0, people.length > 0 ? BAR_FACES - 1 : BAR_FACES);
  return [...shown, ...people.slice(0, BAR_FACES - shown.length)];
}

/** The question the bar tells and times: one agent's on its own (beside others, its reply tells it). */
export function barAsking(entries: ActivityEntry[]): EntryConsult | undefined {
  const agents = entries.filter((e) => e.type === "agent");
  const consult = agents.length === 1 ? agents[0]?.consult : undefined;
  return consult?.status === "asking" ? consult : undefined;
}

/** " · 4 s" shows from 2 s on: minutes and seconds past a minute. */
export function elapsedParts(ms: number): { m: number; s: number } | null {
  const secs = Math.floor(Math.max(0, ms) / 1000);
  if (secs < 2) return null;
  return { m: Math.floor(secs / 60), s: secs % 60 };
}

/**
 * The turn the bar tells for one agent on its own, its phrase and its time alike: a turn that failed can still be
 * listed beside the one at work.
 */
const turnAtWork = (runs: LiveRun[], agentId: string) =>
  runs.find((r) => r.agentId === agentId && r.status !== "failed");

/** How long a run has been at it ("16 s", "1 min 5 s"), from 2 s on: the bar's time and its live row's alike. */
export function runElapsed(t: TFunction, run: Pick<LiveRun, "startedAt" | "workingSince">, now: number): string | null {
  // The work it is doing now (`workingSince`), not the run's first start: a run that posted or waited counts again.
  const took = elapsedParts(now - (run.workingSince ?? run.startedAt ?? now));
  if (!took) return null;
  return took.m > 0 ? t("run.elapsedMinutes", { m: took.m, s: took.s }) : t("run.elapsedSeconds", { n: took.s });
}

/** How long one agent on its own has been at it ("16 s", "1 min 5 s"): none for several, or while it asks another. */
export function barElapsed(t: TFunction, entries: ActivityEntry[], runs: LiveRun[], now: number): string | null {
  const agents = entries.filter((e) => e.type === "agent");
  const only = agents.length === 1 ? agents[0] : undefined;
  if (!only || only.consult?.status === "asking") return null;
  const run = turnAtWork(runs, only.id);
  return run ? runElapsed(t, run, now) : null;
}

/**
 * The entries the bar still tells once the agents whose live rows are on screen say it there (their step, time and
 * stop at the end of the row): saying it twice was noise. A question out keeps its own phrase, and people typing stay.
 */
export function entriesOffScreen(
  entries: ActivityEntry[],
  runs: LiveRun[],
  rowInView: (run: LiveRun) => boolean,
): ActivityEntry[] {
  return entries.filter((e) => {
    if (e.type !== "agent" || e.consult) return true;
    const run = runs.find((r) => r.agentId === e.id && BAR_STATUSES.has(r.status));
    return !run || !rowInView(run);
  });
}

/** "trabalhando", "consultando o GitHub". */
export const activityVerb = (t: TFunction, a: Activity) => t(`chat.activity.${a.kind}`, { app: appLabel(a) });

/**
 * The app as people read it: a connector's slug ("himetrica") starts with a capital ("Himetrica"); a name with
 * capitals of its own stays as it is written ("iCloud").
 */
export const appLabel = (a: { kind: string; app?: string }) => {
  const app = a.app ?? "";
  return a.kind === "consulting" && app === app.toLowerCase() ? app.charAt(0).toUpperCase() + app.slice(1) : app;
};

/** Wraps a name in the sentence (the bar shows names in bold); plain text by default. */
export type MarkName = (name: string) => string;
const plain: MarkName = (name) => name;
/** Wraps an agent's name that the line draws with its face before it (the bar's "Theo: …"); `mark` by default. */
export type MarkFace = (name: string, agentId: string) => string;

// Names travel through i18n wrapped in these, then come back drawn: in ink, or with the agent's face (its id rides
// along). Control characters, so no name or translation ever holds one.
const NAME_OPEN = "\u0001";
const NAME_CLOSE = "\u0002";
const FACE_OPEN = "\u0003";
const FACE_ID = "\u0004";
/** A name the line draws in ink. */
export const markInk: MarkName = (name) => `${NAME_OPEN}${name}${NAME_CLOSE}`;
/** A name the line draws with its agent's face before it. */
export const markFaced: MarkFace = (name, agentId) => `${FACE_OPEN}${agentId}${FACE_ID}${name}${NAME_CLOSE}`;

/** A piece of a marked sentence: plain words, a name in ink, or a name with its agent's face (`agentId`). */
export interface MarkedPiece {
  text: string;
  bold: boolean;
  agentId?: string;
}

/** A sentence marked with `markInk` / `markFaced`, in pieces (an unclosed name runs to the end). */
export function markedPieces(text: string): MarkedPiece[] {
  const out: MarkedPiece[] = [];
  let at = 0;
  while (at < text.length) {
    const ink = text.indexOf(NAME_OPEN, at);
    const faced = text.indexOf(FACE_OPEN, at);
    const open = ink < 0 ? faced : faced < 0 ? ink : Math.min(ink, faced);
    if (open < 0) {
      out.push({ text: text.slice(at), bold: false });
      break;
    }
    if (open > at) out.push({ text: text.slice(at, open), bold: false });
    const close = text.indexOf(NAME_CLOSE, open);
    const end = close < 0 ? text.length : close;
    if (open === ink) {
      const name = text.slice(open + 1, end);
      if (name) out.push({ text: name, bold: true });
    } else {
      const sep = text.indexOf(FACE_ID, open);
      const id = sep < 0 || sep > end ? "" : text.slice(open + 1, sep);
      const name = text.slice(sep < 0 || sep > end ? open + 1 : sep + 1, end);
      if (name) out.push({ text: name, bold: true, ...(id ? { agentId: id } : {}) });
    }
    at = end + 1;
  }
  return out;
}

/** "Theo", "Theo e Iris", "Theo e mais 2". */
export function listNames(t: TFunction, names: string[], mark: MarkName = plain) {
  if (names.length <= 2) return joinNames(names.map(mark), t);
  return t("chat.namesMore", { first: mark(names[0] ?? ""), count: names.length - 1 });
}

/** One consultation's phrase: "Dev está perguntando ao Infra", "Infra respondeu. Dev está escrevendo". */
function consultPhrase(t: TFunction, from: string, c: EntryConsult, mark: MarkName) {
  if (c.status === "asking") return t("chat.consult.asking", { from: mark(from), to: mark(c.toName) });
  if (c.status === "answered") return t("chat.consult.answered", { from: mark(from), to: mark(c.toName) });
  return t("chat.consult.writing", { from: mark(from) });
}

/** "Theo e Iris estão trabalhando", "Marina está digitando". */
const doingPhrase = (t: TFunction, names: string[], activity: Activity, mark: MarkName) =>
  t("chat.doing", { count: names.length, names: listNames(t, names, mark), doing: activityVerb(t, activity) });

/** The agents' part: one says what it does (or whom it asks); several just work, their blocks say the rest. */
function agentsPhrase(t: TFunction, entries: ActivityEntry[], mark: MarkName) {
  const agents = entries.filter((e) => e.type === "agent");
  const only = agents.length === 1 ? agents[0] : undefined;
  if (only?.consult) return consultPhrase(t, only.name, only.consult, mark);
  if (agents.length === 0) return "";
  const names = agents.map((e) => e.name);
  return doingPhrase(t, names, only?.activity ?? { kind: "thinking" }, mark);
}

const typingNames = (entries: ActivityEntry[]) => entries.flatMap((e) => (e.type === "person" ? [e.name] : []));

const PHRASES_SEP = " · ";

/** "Marina está digitando"; "" when nobody types. */
function typingPhrase(t: TFunction, entries: ActivityEntry[], mark: MarkName) {
  const people = typingNames(entries);
  return people.length > 0 ? doingPhrase(t, people, { kind: "typing" }, mark) : "";
}

/**
 * The bar's sentence, one short line however many are at work: "Theo e mais 2 estão trabalhando · Marina
 * está digitando…"; "" when nobody. `mark` wraps each name (for bold).
 */
export function activitySentence(t: TFunction, entries: ActivityEntry[], mark: MarkName = plain) {
  const phrases = [agentsPhrase(t, entries, mark), typingPhrase(t, entries, mark)].filter(Boolean);
  return phrases.length > 0 ? `${phrases.join(PHRASES_SEP)}…` : "";
}

/** The bar's sentence as plain text (see `activitySentence`). */
export const activityText = (t: TFunction, entries: ActivityEntry[]) => activitySentence(t, entries);

/**
 * The card's phrase. One agent on its own says only its name (the bar adds its time): what it does is its waiting
 * row's step line in the conversation (`waitStep`), never said twice. Anyone else (several, a question out, people
 * typing): the plain sentence.
 */
export function barPhrase(t: TFunction, entries: ActivityEntry[], mark: MarkName = plain): string {
  const only = entries.length === 1 ? entries[0] : undefined;
  if (only?.type === "agent" && !only.consult) return mark(only.name);
  return activitySentence(t, entries, mark);
}

/**
 * `barPhrase` in pieces, in the order they give way when the bar is short: the agents' words (then the " · "
 * after them, so it never leads the line), the names of who is typing, and never what they do (" está
 * digitando…"). Joined, they read as `barPhrase`; all but the first are "" when nobody types.
 */
export function barWords(
  t: TFunction,
  entries: ActivityEntry[],
  mark: MarkName = plain,
): [agents: string, sep: string, typers: string, typing: string] {
  const typing = typingPhrase(t, entries, mark);
  if (!typing) return [barPhrase(t, entries, mark), "", "", ""];
  const agents = agentsPhrase(t, entries, mark);
  // The names lead the phrase in pt-BR and en; a language that puts them later keeps the phrase whole.
  const names = listNames(t, typingNames(entries), mark);
  const at = typing.startsWith(names) ? names.length : 0;
  return [agents, agents ? PHRASES_SEP : "", typing.slice(0, at), `${typing.slice(at)}…`];
}

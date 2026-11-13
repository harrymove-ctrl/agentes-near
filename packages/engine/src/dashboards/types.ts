import type { PubSub } from "@agenteschat/adapters";
import type { Database, schema } from "@agenteschat/db";
import type {
  WidgetFormat,
  WidgetKind,
  WidgetSchedule,
  WidgetSize,
  WidgetSpec,
  WidgetStatus,
} from "@agenteschat/ui/widgets/spec";
import type { ContextDeps } from "../context/summaries";

/**
 * Dashboards and widgets (ADR 0135): the shapes the engine returns to the HTTP layer (JSON-ready: times as ISO
 * strings) and takes from it. `packages/client/src/dashboards/types.ts` mirrors them for the apps; the spec itself
 * and its rules live in `@agenteschat/ui/widgets/spec`, shared by every package.
 */

export type { WidgetFormat, WidgetKind, WidgetSchedule, WidgetSize, WidgetSpec, WidgetStatus };

export type DashboardRow = typeof schema.dashboards.$inferSelect;
export type WidgetRow = typeof schema.dashboardWidgets.$inferSelect;
export type WidgetUpdateRow = typeof schema.dashboardWidgetUpdates.$inferSelect;

/** `home`: a person's own board on Home (one each, always private); `board`: any other. */
export type DashboardKind = "board" | "home";
export const DASHBOARD_KINDS: readonly DashboardKind[] = ["board", "home"];

/** Who sees a board: every member, whoever holds one of its roles at the time (ADR 0085), or only its owner. */
export type DashboardAudience = "workspace" | "roles" | "private";
export const DASHBOARD_AUDIENCES: readonly DashboardAudience[] = ["workspace", "roles", "private"];

/**
 * Who edits it: whoever sees it, only its owner (and admins), or whoever sees it and holds one of its edit roles
 * (`editRoleIds`; its owner and admins too).
 */
export type DashboardEditPolicy = "viewers" | "owner" | "roles";
export const DASHBOARD_EDIT_POLICIES: readonly DashboardEditPolicy[] = ["viewers", "owner", "roles"];

/** A home board's fixed tiles. */
export type HomeTileKey = "waiting" | "working";
export interface HomeTile {
  key: HomeTileKey;
  position: number;
  w: 1 | 2;
  h: 1 | 2;
}

/** Where a new home board puts "Waiting on you" and "Working now": first, and after the first two widgets. */
export const DEFAULT_HOME_TILES: readonly HomeTile[] = [
  { key: "waiting", position: 0, w: 2, h: 1 },
  { key: "working", position: 3, w: 2, h: 1 },
];

/** Most roles a board's audience may name (as a channel's, ADR 0125). */
export const DASHBOARD_ROLES_MAX = 100;
export const DASHBOARD_TITLE_MAX = 80;
export const DASHBOARD_ABOUT_MAX = 280;
export const WIDGET_TITLE_MAX = 80;
export const WIDGET_PROMPT_MAX = 2000;
export const WIDGET_ALERT_CONDITION_MAX = 200;
export const WIDGET_CHANGE_MAX = 1000;
/** The title an agent writes on a first build or a change: short, in the person's language (ADR 0135 §17). */
export const WIDGET_AGENT_TITLE_MAX = 40;
/** Drafts a person keeps per workspace ("Test" in New widget); one more drops their oldest (ADR 0135 §16). */
export const WIDGET_DRAFTS_MAX = 5;
/** A draft nobody confirmed is deleted after this long (ADR 0135 §16). */
export const WIDGET_DRAFT_TTL_MS = 24 * 3600_000;

/** The error codes the engine throws (the apps translate them under `dashboards.errors.*`). */
export const DASHBOARD_ERRORS = {
  /** 404: no such board, or the person can't see it. */
  notFound: "dashboard.not_found",
  /** 403: they see it but may not edit (or share, delete, pin) it. */
  forbidden: "dashboard.forbidden",
  /** 400: a home board is never shared, deleted or renamed. */
  homeFixed: "dashboard.home_fixed",
  /** 400: `roles` (who sees, or who edits) without any role. */
  rolesRequired: "dashboard.roles_required",
  /** 400: a role that isn't one of the workspace's custom roles. */
  roleUnknown: "dashboard.role_unknown",
  /** 400. */
  titleRequired: "dashboard.title_required",
  /** 400: the workspace has `DASHBOARDS_MAX` boards. */
  tooMany: "dashboard.too_many",
  /** 403: showing a board to others needs `post`. */
  publishForbidden: "dashboard.publish_forbidden",
  /** 409: no agent request is pending on it. */
  proposalNone: "dashboard.proposal_none",
  /** 403: only the person the agent asked decides. */
  proposalNotYours: "dashboard.proposal_not_yours",
  /** 404. */
  widgetNotFound: "widget.not_found",
  /** 400: the board has `WIDGETS_PER_DASHBOARD_MAX` widgets. */
  widgetTooMany: "widget.too_many",
  /** 400: the workspace already keeps `WIDGET_SCHEDULED_MAX` scheduled widgets (`params.max`). */
  scheduledCap: "widget.scheduled_cap",
  /** 403: the person can't talk to that agent (its audience, ADR 0085). */
  agentUnreachable: "widget.agent_unreachable",
  /** 400: the agent is archived. */
  agentArchived: "widget.agent_archived",
  /** 404: that chart block isn't in the message, or the person can't read the message. */
  blockNotFound: "widget.block_not_found",
  /** 400: only an agent's chart block is pinned. */
  notAgentMessage: "widget.not_agent_message",
  /** 400. */
  promptRequired: "widget.prompt_required",
  /** 409: a draft is confirmed only once its test build worked (`ok`, ADR 0135 §16). */
  notTested: "widget.not_tested",
} as const;

/**
 * Why a widget failed (`dashboard_widgets.failure_code`), translated by the apps under `widgets.failure.*`. The
 * routine ledger's own codes pass through as they are (`budget_exceeded`, `waiting_computer`, `creator_left`…);
 * these are the widget's own.
 */
export const WIDGET_FAILURES = {
  /** The agent said why it couldn't (its words in `failure_detail`, shown as they are). */
  agentReported: "agent_reported",
  /** The run ended without `update_widget`. */
  noUpdate: "no_update",
  /** The run failed for another reason. */
  error: "error",
} as const;

export interface DashboardDeps {
  db: Database;
  pubsub: PubSub;
  /** The cheap model for suggestions and the schedule's time zone helpers; absent: suggestions are empty. */
  context?: ContextDeps;
  now?: () => Date;
}

// ── Views ────────────────────────────────────────────────────────────────────

/** Who a board is by: the agent that made it, else the person who owns it. */
export interface DashboardOwnerView {
  kind: "person" | "agent";
  id: string;
  name: string;
}

/** An agent's pending request to show a board to more people (ADR 0135 §11). */
export interface DashboardProposalView {
  audience: "workspace" | "roles";
  roleIds: string[];
  agentId: string;
  why: string;
  at: string;
  /** The viewer is the person it asks (Publish / Keep only for me). */
  canDecide: boolean;
}

export interface DashboardSummaryView {
  id: string;
  kind: DashboardKind;
  /** Empty for a home board (the apps say "My Home"). */
  title: string;
  about: string;
  audience: DashboardAudience;
  roleIds: string[];
  editPolicy: DashboardEditPolicy;
  /** With `editPolicy` `roles`: the roles whose holders edit it when they see it; else empty. */
  editRoleIds: string[];
  pinned: boolean;
  position: number;
  owner: DashboardOwnerView | null;
  ownerUserId: string | null;
  /** The viewer owns it. */
  mine: boolean;
  widgetCount: number;
  /** Its first widgets, for the list's thumbnail: whose tones and how wide. */
  thumbs: { agentId: string; w: 1 | 2 }[];
  /** Members who see it now. */
  viewerCount: number;
  canEdit: boolean;
  /** Share, delete and pin: its owner and admins. */
  canManage: boolean;
  proposal: DashboardProposalView | null;
  createdAt: string;
  /** The later of its own change and its widgets' last update. */
  updatedAt: string;
}

export interface DashboardListView {
  /** The viewer's home board; null until it was first opened. */
  home: DashboardSummaryView | null;
  /** Every other board the viewer sees, pinned first, then by position and title. */
  dashboards: DashboardSummaryView[];
  /** The board Início shows instead of the viewer's own home (one of `dashboards`); null = their own. */
  homeDashboardId: string | null;
}

export interface WidgetView {
  id: string;
  dashboardId: string;
  agentId: string;
  title: string;
  prompt: string;
  format: WidgetFormat;
  kind: WidgetKind | null;
  spec: WidgetSpec | null;
  sources: string[];
  layout: { position: number; w: 1 | 2; h: 1 | 2 };
  schedule: WidgetSchedule;
  alert: { enabled: boolean; condition: string };
  status: WidgetStatus;
  failure: { code: string; detail: string | null } | null;
  refreshedAt: string | null;
  /** Its routine's next run; null for `manual`. */
  nextRunAt: string | null;
  routineId: string | null;
  sourceMessageId: string | null;
  createdBy: { kind: "person" | "agent"; id: string } | null;
  /** A test not created yet (ADR 0135 §16): only its creator sees it, on no board. */
  draft: boolean;
  /** What its latest update cost ("This test cost $0.01"); null on a plan, or before it is known. */
  lastCostUsd: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardView extends DashboardSummaryView {
  widgets: WidgetView[];
  /** Home only: the fixed tiles; empty for a board. */
  tiles: HomeTile[];
}

export interface WidgetUpdateView {
  id: string;
  at: string;
  status: "ok" | "failed";
  summary: string;
  alert: string | null;
  failureCode: string | null;
  /** The person's change request this update answered. */
  change: string | null;
  /** Null on a plan, or before its cost was known. */
  costUsd: number | null;
}

/**
 * The tool call a widget's refresh run is in right now, for the building card's step line: the fields the chat's live
 * chip carries (the app says them in words), never the call's input.
 */
export interface WidgetStepView {
  tool: string;
  /** The connected app's label ("Stripe"); null for one of our own tools. */
  connector: string | null;
  service: string | null;
  /** When the call started. */
  at: string;
}

export interface WidgetDetailView extends WidgetView {
  dashboard: { id: string; kind: DashboardKind; title: string };
  canEdit: boolean;
  /** While it is `building` or `updating`: the call its run is in; null between calls (it is thinking) and otherwise. */
  step: WidgetStepView | null;
  /** The latest updates, newest first. */
  history: WidgetUpdateView[];
}

export interface WidgetCostEstimate {
  agentId: string;
  schedule: WidgetSchedule;
  runsPerDay: number;
  /** Null on a plan or when nothing is known. */
  perRunUsd: number | null;
  perDayUsd: number | null;
  perWeekUsd: number | null;
  /** `history`: its recent routine runs; `model`: its model's price for a typical refresh; `none`. */
  basis: "history" | "model" | "none";
  /** `plan`: a computer brain's plan pays (no money shown). */
  billedTo: "api" | "plan";
}

export interface WidgetSuggestion {
  title: string;
  /** What to ask, as the person would write it. */
  prompt: string;
  kind: WidgetKind;
  /** A sensible alert condition, in words ("drops 20% below yesterday"). */
  alert: string;
}

export interface WidgetSuggestionsView {
  agentId: string;
  /** What the agent can read, by name (its connections), for "reads …". */
  sources: string[];
  suggestions: WidgetSuggestion[];
}

/** A chart an agent sent in a conversation the viewer reads ("Pin from chat"). */
export interface PinnableBlockView {
  messageId: string;
  channelId: string;
  threadId: string | null;
  agentId: string;
  at: string;
  /** The block's JSON text, sent back as is to pin it. */
  block: string;
  title: string;
  spec: WidgetSpec;
  place: { kind: "channel" | "dm" | "thread"; name: string | null };
}

// ── Inputs ───────────────────────────────────────────────────────────────────

export interface CreateDashboardInput {
  title: string;
  about?: string;
  audience: DashboardAudience;
  roleIds?: string[];
  editPolicy: DashboardEditPolicy;
  /** With `editPolicy` `roles`: 1 to `DASHBOARD_ROLES_MAX` custom roles. */
  editRoleIds?: string[];
}

export interface UpdateDashboardInput {
  title?: string;
  about?: string;
  pinned?: boolean;
}

export interface ShareDashboardInput {
  audience: DashboardAudience;
  roleIds: string[];
  editPolicy: DashboardEditPolicy;
  /** With `editPolicy` `roles`: 1 to `DASHBOARD_ROLES_MAX` custom roles. */
  editRoleIds?: string[];
}

export interface DashboardLayoutInput {
  widgets: { id: string; position: number; w: 1 | 2; h: 1 | 2 }[];
  /** Home only. */
  tiles?: HomeTile[];
}

export interface CreateWidgetInput {
  agentId: string;
  prompt: string;
  /** Default: the agent names it on its first run. */
  title?: string;
  format: WidgetFormat;
  schedule: WidgetSchedule;
  alert?: { enabled: boolean; condition: string };
  /** Default: `defaultSize` of its format. */
  size?: WidgetSize;
}

/** "Create widget" after a test: where the draft goes and how it updates (ADR 0135 §16). */
export interface ConfirmWidgetInput {
  dashboardId: string;
  /** A person's title (kept from then on); absent: the one its agent wrote on the test. */
  title?: string;
  size: WidgetSize;
  schedule: WidgetSchedule;
  alert: { enabled: boolean; condition: string };
}

export interface PinWidgetInput {
  messageId: string;
  /** The ```chart block's JSON text, as the message has it. */
  block: string;
  schedule: WidgetSchedule;
  size?: WidgetSize;
  title?: string;
}

export interface UpdateWidgetInput {
  title?: string;
  prompt?: string;
  schedule?: WidgetSchedule;
  alert?: { enabled: boolean; condition: string };
  size?: WidgetSize;
  /** Move it to another board the person edits. */
  dashboardId?: string;
}

export type DashboardProposalDecision = "publish" | "keep";

/** What `update_widget` hands in (ADR 0135 §5). */
export interface WidgetUpdateInput {
  /** The new data; absent with `failed`. */
  spec?: WidgetSpec;
  /** One line for its history. */
  summary: string;
  sources?: string[];
  /** Only on a first build or a change request. */
  title?: string;
  /** Only on a change request: the instructions the next runs follow. */
  prompt?: string;
  /** The alert condition was met: what to tell the person. */
  alert?: string;
  /** It couldn't: why, in the person's words. */
  failed?: string;
}

/** Who stands behind a widget or board an agent's tool makes (ADR 0053 §1). */
export interface AgentMaker {
  agentId: string;
  runId: string;
  /** The person behind the run; null for a routine's or unattended run. */
  personId: string | null;
  /** Who owns what it makes: the person behind it, else the routine's creator or the agent's owner. */
  accountableUserId: string | null;
}

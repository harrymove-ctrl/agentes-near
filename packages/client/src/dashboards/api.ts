import { enc, type Requester } from "../api/http";
import type {
  ConfirmWidgetInput,
  CreateDashboardInput,
  CreateWidgetInput,
  Dashboard,
  DashboardLayoutInput,
  DashboardList,
  DashboardProposalDecision,
  PinnableBlock,
  PinWidgetInput,
  ShareDashboardInput,
  UpdateDashboardInput,
  UpdateWidgetInput,
  Widget,
  WidgetCostEstimate,
  WidgetDetail,
  WidgetSchedule,
  WidgetSuggestions,
} from "./types";

/** The boards and widgets of a workspace (ADR 0135), `/api/app/organizations/{orgId}/…`. */
export interface DashboardsApi {
  /** The boards I see, and my home board once it exists. */
  list(orgId: string): Promise<DashboardList>;
  get(orgId: string, dashboardId: string): Promise<Dashboard>;
  /** My home board, made on first use. */
  home(orgId: string): Promise<Dashboard>;
  /** "Use on Home": Início shows this board instead of my own home (null: my own again). */
  setHome(orgId: string, dashboardId: string | null): Promise<{ homeDashboardId: string | null }>;
  /** "New dashboard": an empty board (an agent builds one when asked in a chat). */
  create(orgId: string, input: CreateDashboardInput): Promise<Dashboard>;
  /** Title, about, pinned. */
  update(orgId: string, dashboardId: string, patch: UpdateDashboardInput): Promise<Dashboard>;
  /** "Share": who sees and who edits. */
  share(orgId: string, dashboardId: string, input: ShareDashboardInput): Promise<Dashboard>;
  remove(orgId: string, dashboardId: string): Promise<void>;
  /** "Organize": order and sizes (and a home board's tiles). */
  saveLayout(orgId: string, dashboardId: string, input: DashboardLayoutInput): Promise<Dashboard>;
  /** An agent's request to show it to more people: Publish or Keep only for me. */
  decideProposal(orgId: string, dashboardId: string, decision: DashboardProposalDecision): Promise<Dashboard>;
  /** "+ Widget": the agent builds it (`building`). */
  createWidget(orgId: string, dashboardId: string, input: CreateWidgetInput): Promise<Widget>;
  /**
   * "Test": a draft of the widget (`draft: true`, `building`), built at once with real data, seen only by me. Testing
   * again or closing the dialog drops it (`removeWidget`).
   */
  testWidget(orgId: string, dashboardId: string, input: CreateWidgetInput): Promise<Widget>;
  /** "Create widget" after a test that worked: the draft goes first on `input.dashboardId`. */
  confirmWidget(orgId: string, widgetId: string, input: ConfirmWidgetInput): Promise<Widget>;
  /** "Pin" a chart an agent sent in chat. */
  pinWidget(orgId: string, dashboardId: string, input: PinWidgetInput): Promise<Widget>;
  widget(orgId: string, widgetId: string): Promise<WidgetDetail>;
  updateWidget(orgId: string, widgetId: string, patch: UpdateWidgetInput): Promise<Widget>;
  removeWidget(orgId: string, widgetId: string): Promise<void>;
  /** "Update now" and "Resolve". */
  refreshWidget(orgId: string, widgetId: string): Promise<Widget>;
  /** "Ask for a change". */
  askWidgetChange(orgId: string, widgetId: string, text: string): Promise<Widget>;
  /** "≈ $ a day of <agent>'s budget". */
  widgetCost(orgId: string, agentId: string, schedule: WidgetSchedule): Promise<WidgetCostEstimate>;
  /** What the agent reads and three things it could keep up to date. */
  widgetSuggestions(orgId: string, agentId: string): Promise<WidgetSuggestions>;
  /** "Pin from chat": charts agents sent where I read, newest first. */
  pinnableBlocks(orgId: string, limit?: number): Promise<PinnableBlock[]>;
}

const org = (orgId: string) => `/api/app/organizations/${enc(orgId)}`;

export function createDashboardsApi(request: Requester): DashboardsApi {
  const board = (orgId: string, dashboardId: string) => `${org(orgId)}/dashboards/${enc(dashboardId)}`;
  const widget = (orgId: string, widgetId: string) => `${org(orgId)}/widgets/${enc(widgetId)}`;
  return {
    list: (orgId) => request<DashboardList>(`${org(orgId)}/dashboards`),
    get: (orgId, dashboardId) => request<Dashboard>(board(orgId, dashboardId)),
    home: (orgId) => request<Dashboard>(`${org(orgId)}/dashboards/home`),
    setHome: (orgId, dashboardId) =>
      request<{ homeDashboardId: string | null }>(`${org(orgId)}/dashboards/home-choice`, {
        method: "PUT",
        json: { homeDashboardId: dashboardId },
      }),
    create: (orgId, input) => request<Dashboard>(`${org(orgId)}/dashboards`, { json: input }),
    update: (orgId, dashboardId, patch) =>
      request<Dashboard>(board(orgId, dashboardId), { method: "PATCH", json: patch }),
    share: (orgId, dashboardId, input) =>
      request<Dashboard>(`${board(orgId, dashboardId)}/share`, { method: "PUT", json: input }),
    remove: (orgId, dashboardId) => request<void>(board(orgId, dashboardId), { method: "DELETE" }),
    saveLayout: (orgId, dashboardId, input) =>
      request<Dashboard>(`${board(orgId, dashboardId)}/layout`, { method: "PUT", json: input }),
    decideProposal: (orgId, dashboardId, decision) =>
      request<Dashboard>(`${board(orgId, dashboardId)}/proposal`, { json: { decision } }),
    createWidget: (orgId, dashboardId, input) =>
      request<Widget>(`${board(orgId, dashboardId)}/widgets`, { json: input }),
    testWidget: (orgId, dashboardId, input) =>
      request<Widget>(`${board(orgId, dashboardId)}/widgets/test`, { json: input }),
    confirmWidget: (orgId, widgetId, input) => request<Widget>(`${widget(orgId, widgetId)}/confirm`, { json: input }),
    pinWidget: (orgId, dashboardId, input) =>
      request<Widget>(`${board(orgId, dashboardId)}/widgets/pin`, { json: input }),
    widget: (orgId, widgetId) => request<WidgetDetail>(widget(orgId, widgetId)),
    updateWidget: (orgId, widgetId, patch) =>
      request<Widget>(widget(orgId, widgetId), { method: "PATCH", json: patch }),
    removeWidget: (orgId, widgetId) => request<void>(widget(orgId, widgetId), { method: "DELETE" }),
    refreshWidget: (orgId, widgetId) => request<Widget>(`${widget(orgId, widgetId)}/refresh`, { json: {} }),
    askWidgetChange: (orgId, widgetId, text) =>
      request<Widget>(`${widget(orgId, widgetId)}/change`, { json: { text } }),
    widgetCost: (orgId, agentId, schedule) =>
      request<WidgetCostEstimate>(`${org(orgId)}/widget-cost`, { query: { agentId, schedule } }),
    widgetSuggestions: (orgId, agentId) =>
      request<WidgetSuggestions>(`${org(orgId)}/widget-suggestions/${enc(agentId)}`),
    pinnableBlocks: async (orgId, limit) =>
      (await request<{ blocks: PinnableBlock[] }>(`${org(orgId)}/widget-pinnable`, { query: { limit } })).blocks,
  };
}

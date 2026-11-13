import {
  askWidgetChange,
  confirmWidget,
  createDashboard,
  createWidget,
  type DashboardDeps,
  decideDashboardProposal,
  deleteDashboard,
  estimateWidgetCost,
  getDashboard,
  getOrCreateHome,
  getWidget,
  listDashboards,
  listPinnableBlocks,
  pinMessageAsWidget,
  refreshWidgetNow,
  removeWidget,
  saveDashboardLayout,
  setHomeDashboard,
  shareDashboard,
  testWidget,
  updateDashboard,
  updateWidget,
  widgetSuggestions,
} from "@agenteschat/engine";
import { createRoute, z } from "@hono/zod-openapi";
import {
  type AppDeps,
  body,
  createAppRouter,
  errors,
  json,
  noContent,
  OrgParams,
  requireSession,
  security,
} from "./context";
import {
  ConfirmWidgetBody,
  CreateDashboardBody,
  CreateWidgetBody,
  Dashboard,
  DashboardLayoutBody,
  DashboardList,
  DashboardParams,
  DashboardProposalBody,
  HomeChoice,
  PinnableBlock,
  PinnableQuery,
  PinWidgetBody,
  ShareDashboardBody,
  UpdateDashboardBody,
  UpdateWidgetBody,
  Widget,
  WidgetAgentParams,
  WidgetChangeBody,
  WidgetCostEstimate,
  WidgetCostQuery,
  WidgetDetail,
  WidgetParams,
  WidgetSuggestions,
} from "./dashboard-schemas";

const tags = ["Dashboards"];

/**
 * Dashboards and widgets (ADR 0135): boards of widgets agents keep up to date, who sees and edits them, "My Home",
 * an agent's request to show a board to more people, and what "+ Widget" needs (cost, suggestions, charts to pin).
 * Every check is the engine's (`packages/engine/src/dashboards/*`): a board the caller can't see is 404, one they see
 * but may not change is 403. Anything that queues a widget's run wakes the workers so it starts without waiting for
 * their poll.
 */
export function dashboardRoutes(deps: AppDeps) {
  const app = createAppRouter(deps);
  app.use("/organizations/*", requireSession(deps.auth));
  const boards: DashboardDeps = { db: deps.db, pubsub: deps.adapters.pubsub, context: deps.extras?.context };
  const wake = () => deps.wakeWorkers?.();

  // ── Boards ──────────────────────────────────────────────────────────────────

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/dashboards",
      tags,
      security,
      summary: "The boards I see (pinned first), and my home board once it exists",
      request: { params: OrgParams },
      responses: { 200: json(DashboardList), ...errors },
    }),
    async (c) => c.json(await listDashboards(boards, c.get("user").id, c.req.valid("param").orgId), 200),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/dashboards",
      tags,
      security,
      summary: "New dashboard, empty (an agent builds one when asked in a chat)",
      description:
        "Showing it to others (`workspace`, `roles`) needs `post`. Whoever sees a board sees what its agents fetched with their own connections (ADR 0135 §12).",
      request: { params: OrgParams, body: body(CreateDashboardBody) },
      responses: { 201: json(Dashboard, "Created"), ...errors },
    }),
    async (c) =>
      c.json(await createDashboard(boards, c.get("user").id, c.req.valid("param").orgId, c.req.valid("json")), 201),
  );

  // Before `/dashboards/{dashboardId}`: `home` is not a board's id.
  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/dashboards/home",
      tags,
      security,
      summary: "My home board (the widgets of Início), made the first time it is read",
      request: { params: OrgParams },
      responses: { 200: json(Dashboard), ...errors },
    }),
    async (c) => c.json(await getOrCreateHome(boards, c.get("user").id, c.req.valid("param").orgId), 200),
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/dashboards/home-choice",
      tags,
      security,
      summary: "Use a board on Início instead of my own home board (null: my own again), for me only",
      request: { params: OrgParams, body: body(HomeChoice) },
      responses: { 200: json(HomeChoice), ...errors },
    }),
    async (c) =>
      c.json(
        await setHomeDashboard(
          boards,
          c.get("user").id,
          c.req.valid("param").orgId,
          c.req.valid("json").homeDashboardId,
        ),
        200,
      ),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/dashboards/{dashboardId}",
      tags,
      security,
      summary: "A board with its widgets",
      request: { params: DashboardParams },
      responses: { 200: json(Dashboard), ...errors },
    }),
    async (c) => {
      const { orgId, dashboardId } = c.req.valid("param");
      return c.json(await getDashboard(boards, c.get("user").id, orgId, dashboardId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/organizations/{orgId}/dashboards/{dashboardId}",
      tags,
      security,
      summary: "Rename it or change its description (its editors); pin it first (its owner and admins)",
      request: { params: DashboardParams, body: body(UpdateDashboardBody) },
      responses: { 200: json(Dashboard), ...errors },
    }),
    async (c) => {
      const { orgId, dashboardId } = c.req.valid("param");
      return c.json(await updateDashboard(boards, c.get("user").id, orgId, dashboardId, c.req.valid("json")), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/dashboards/{dashboardId}",
      tags,
      security,
      summary: "Delete a board and stop its widgets' routines (its owner and admins; never a home board)",
      request: { params: DashboardParams },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, dashboardId } = c.req.valid("param");
      await deleteDashboard(boards, c.get("user").id, orgId, dashboardId);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/dashboards/{dashboardId}/share",
      tags,
      security,
      summary: "Who sees it and who edits it (its owner and admins)",
      description:
        "Showing it to more people needs `post`; `roles` names 1 to 100 of the workspace's roles. Clears an agent's pending request.",
      request: { params: DashboardParams, body: body(ShareDashboardBody) },
      responses: { 200: json(Dashboard), ...errors },
    }),
    async (c) => {
      const { orgId, dashboardId } = c.req.valid("param");
      return c.json(await shareDashboard(boards, c.get("user").id, orgId, dashboardId, c.req.valid("json")), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/organizations/{orgId}/dashboards/{dashboardId}/layout",
      tags,
      security,
      summary: "Organize: the widgets' order and sizes (and a home board's fixed tiles)",
      request: { params: DashboardParams, body: body(DashboardLayoutBody) },
      responses: { 200: json(Dashboard), ...errors },
    }),
    async (c) => {
      const { orgId, dashboardId } = c.req.valid("param");
      return c.json(await saveDashboardLayout(boards, c.get("user").id, orgId, dashboardId, c.req.valid("json")), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/dashboards/{dashboardId}/proposal",
      tags,
      security,
      summary: "An agent's request to show the board to more people: Publish or Keep only for me",
      description: "Only the person it asks decides (ADR 0135 §11); publishing needs `post`.",
      request: { params: DashboardParams, body: body(DashboardProposalBody) },
      responses: { 200: json(Dashboard), ...errors },
    }),
    async (c) => {
      const { orgId, dashboardId } = c.req.valid("param");
      const { decision } = c.req.valid("json");
      return c.json(await decideDashboardProposal(boards, c.get("user").id, orgId, dashboardId, decision), 200);
    },
  );

  // ── Widgets ─────────────────────────────────────────────────────────────────

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/dashboards/{dashboardId}/widgets",
      tags,
      security,
      summary: "+ Widget: an agent I can talk to builds it and keeps it up to date",
      description:
        "It starts `building`; at most 24 widgets a board and 60 updating on a schedule a workspace (`widget.scheduled_cap`, `params.max`).",
      request: { params: DashboardParams, body: body(CreateWidgetBody) },
      responses: { 201: json(Widget, "Created"), ...errors },
    }),
    async (c) => {
      const { orgId, dashboardId } = c.req.valid("param");
      const widget = await createWidget(boards, c.get("user").id, orgId, dashboardId, c.req.valid("json"));
      wake();
      return c.json(widget, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/dashboards/{dashboardId}/widgets/test",
      tags,
      security,
      summary: "Test: a draft of the widget, built at once with real data by its agent, seen only by me",
      description:
        "The same checks as + Widget (I edit the board, I may talk to the agent). The draft (`draft: true`) is on no board and under no cap; it starts `building` and its events go to me alone. I keep at most 5 drafts (the oldest go); unconfirmed ones go after a day. Confirm it with `POST …/widgets/{widgetId}/confirm` once it is `ok`; `DELETE …/widgets/{widgetId}` drops it and stops its run (ADR 0135 §16).",
      request: { params: DashboardParams, body: body(CreateWidgetBody) },
      responses: { 202: json(Widget, "Accepted: its test build started"), ...errors },
    }),
    async (c) => {
      const { orgId, dashboardId } = c.req.valid("param");
      const widget = await testWidget(boards, c.get("user").id, orgId, dashboardId, c.req.valid("json"));
      wake();
      return c.json(widget, 202);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/widgets/{widgetId}/confirm",
      tags,
      security,
      summary: "Create widget after a test: the draft goes first on the board, keeping its data and history",
      description:
        "Only my own draft (`widget.not_found` otherwise), only once its test worked (`widget.not_tested`, 409); the board's room and the scheduled cap hold as on + Widget. A title that differs from its agent's is mine from then on.",
      request: { params: WidgetParams, body: body(ConfirmWidgetBody) },
      responses: { 200: json(Widget), ...errors },
    }),
    async (c) => {
      const { orgId, widgetId } = c.req.valid("param");
      const input = c.req.valid("json");
      const widget = await confirmWidget(boards, c.get("user").id, orgId, widgetId, input);
      if (input.schedule !== "manual") wake();
      return c.json(widget, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/dashboards/{dashboardId}/widgets/pin",
      tags,
      security,
      summary: "Pin a chart an agent sent in a conversation I read; it keeps its data, updating is optional",
      request: { params: DashboardParams, body: body(PinWidgetBody) },
      responses: { 201: json(Widget, "Created"), ...errors },
    }),
    async (c) => {
      const { orgId, dashboardId } = c.req.valid("param");
      const input = c.req.valid("json");
      const widget = await pinMessageAsWidget(boards, c.get("user").id, orgId, dashboardId, input);
      if (input.schedule !== "manual") wake();
      return c.json(widget, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/widgets/{widgetId}",
      tags,
      security,
      summary: "A widget with its board and its latest updates",
      request: { params: WidgetParams },
      responses: { 200: json(WidgetDetail), ...errors },
    }),
    async (c) => {
      const { orgId, widgetId } = c.req.valid("param");
      return c.json(await getWidget(boards, c.get("user").id, orgId, widgetId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/organizations/{orgId}/widgets/{widgetId}",
      tags,
      security,
      summary: "Change a widget: its title, instructions, schedule, alert, size, or the board it is on",
      request: { params: WidgetParams, body: body(UpdateWidgetBody) },
      responses: { 200: json(Widget), ...errors },
    }),
    async (c) => {
      const { orgId, widgetId } = c.req.valid("param");
      const patch = c.req.valid("json");
      const widget = await updateWidget(boards, c.get("user").id, orgId, widgetId, patch);
      if (patch.schedule !== undefined || patch.prompt !== undefined) wake();
      return c.json(widget, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{orgId}/widgets/{widgetId}",
      tags,
      security,
      summary: "Remove a widget and its routine (a draft too: only its creator, and its test run stops)",
      request: { params: WidgetParams },
      responses: { 204: noContent[204], ...errors },
    }),
    async (c) => {
      const { orgId, widgetId } = c.req.valid("param");
      await removeWidget(boards, c.get("user").id, orgId, widgetId);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/widgets/{widgetId}/refresh",
      tags,
      security,
      summary: "Update now, or Resolve a failed widget: its agent redoes it",
      request: { params: WidgetParams },
      responses: { 200: json(Widget), ...errors },
    }),
    async (c) => {
      const { orgId, widgetId } = c.req.valid("param");
      const widget = await refreshWidgetNow(boards, c.get("user").id, orgId, widgetId);
      wake();
      return c.json(widget, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/organizations/{orgId}/widgets/{widgetId}/change",
      tags,
      security,
      summary: "Ask its agent for a change: it redoes the widget with these words",
      request: { params: WidgetParams, body: body(WidgetChangeBody) },
      responses: { 200: json(Widget), ...errors },
    }),
    async (c) => {
      const { orgId, widgetId } = c.req.valid("param");
      const widget = await askWidgetChange(boards, c.get("user").id, orgId, widgetId, c.req.valid("json").text);
      wake();
      return c.json(widget, 200);
    },
  );

  // ── What "+ Widget" needs ───────────────────────────────────────────────────

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/widget-cost",
      tags,
      security,
      summary: "What a widget's updates would cost the agent's budget a day (a week for weekly ones)",
      request: { params: OrgParams, query: WidgetCostQuery },
      responses: { 200: json(WidgetCostEstimate), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const { agentId, schedule } = c.req.valid("query");
      return c.json(await estimateWidgetCost(boards, c.get("user").id, orgId, agentId, schedule), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/widget-suggestions/{agentId}",
      tags,
      security,
      summary: "What an agent reads and three things it could keep up to date",
      request: { params: WidgetAgentParams },
      responses: { 200: json(WidgetSuggestions), ...errors },
    }),
    async (c) => {
      const { orgId, agentId } = c.req.valid("param");
      return c.json(await widgetSuggestions(boards, c.get("user").id, orgId, agentId), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{orgId}/widget-pinnable",
      tags,
      security,
      summary: "Pin from chat: charts agents sent where I read, newest first",
      request: { params: OrgParams, query: PinnableQuery },
      responses: { 200: json(z.object({ blocks: z.array(PinnableBlock) }).openapi("PinnableBlocks")), ...errors },
    }),
    async (c) => {
      const { orgId } = c.req.valid("param");
      const { limit } = c.req.valid("query");
      return c.json({ blocks: await listPinnableBlocks(boards, c.get("user").id, orgId, limit) }, 200);
    },
  );

  return app;
}

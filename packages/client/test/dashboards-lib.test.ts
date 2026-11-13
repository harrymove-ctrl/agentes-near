import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
  applyDashboardEvent,
  boardItems,
  createHttpApi,
  type Dashboard,
  type DashboardEditPolicy,
  type DashboardSummary,
  dashboardAccessOf,
  dashboardGroups,
  editorsInput,
  editorsSummary,
  editorsText,
  fitEditRoles,
  keys,
  layoutOf,
  moveItem,
  resizeItem,
  roleSeesBoard,
  toggleEditRole,
  type Widget,
  widgetCostLine,
  widgetFailureKey,
  widgetStepWords,
  withEditRoles,
} from "../src/index";

const summary = (over: Partial<DashboardSummary>): DashboardSummary => ({
  id: "d",
  kind: "board",
  title: "Board",
  about: "",
  audience: "workspace",
  roleIds: [],
  editPolicy: "viewers",
  editRoleIds: [],
  pinned: false,
  position: 0,
  owner: null,
  ownerUserId: "nina",
  mine: false,
  widgetCount: 0,
  thumbs: [],
  viewerCount: 3,
  canEdit: true,
  canManage: false,
  proposal: null,
  createdAt: "2026-11-03T10:00:00.000Z",
  updatedAt: "2026-11-03T10:00:00.000Z",
  ...over,
});

const widget = (id: string, position: number, w: 1 | 2 = 1): Widget => ({
  id,
  dashboardId: "d",
  agentId: "theo",
  title: id,
  prompt: "",
  format: "auto",
  kind: "kpi",
  spec: { kind: "kpi", value: 1 },
  sources: [],
  layout: { position, w, h: 1 },
  schedule: "hour",
  alert: { enabled: false, condition: "" },
  status: "ok",
  failure: null,
  refreshedAt: null,
  nextRunAt: null,
  routineId: null,
  sourceMessageId: null,
  createdBy: null,
  draft: false,
  lastCostUsd: null,
  createdAt: "2026-11-03T10:00:00.000Z",
  updatedAt: "2026-11-03T10:00:00.000Z",
});

describe("dashboard groups", () => {
  test("splits by audience, pinned first, then by position and title; homes stay out", () => {
    const list = [
      summary({ id: "a", title: "Sales", audience: "workspace", position: 2 }),
      summary({ id: "b", title: "Acme today", audience: "workspace", pinned: true, position: 9 }),
      summary({ id: "c", title: "Finance", audience: "roles" }),
      summary({ id: "d", title: "My goals", audience: "private" }),
      summary({ id: "h", kind: "home", title: "", audience: "private" }),
      summary({ id: "e", title: "Product", audience: "workspace", position: 2 }),
    ];
    const groups = dashboardGroups(list);
    expect(groups.workspace.map((d) => d.id)).toEqual(["b", "e", "a"]);
    expect(groups.roles.map((d) => d.id)).toEqual(["c"]);
    expect(groups.mine.map((d) => d.id)).toEqual(["d"]);
  });
});

describe("who has access", () => {
  const board = {
    kind: "board" as const,
    audience: "roles" as const,
    roleIds: ["sales"],
    editPolicy: "owner" as const,
    ownerUserId: "nina",
  };
  test("the owner edits; a role holder sees; an admin edits; anyone else doesn't see", () => {
    expect(dashboardAccessOf({ userId: "nina", roleIds: [], admin: false }, board)).toBe("edits");
    expect(dashboardAccessOf({ userId: "lia", roleIds: ["sales"], admin: false }, board)).toBe("sees");
    expect(dashboardAccessOf({ userId: "theo", roleIds: [], admin: true }, board)).toBe("edits");
    expect(dashboardAccessOf({ userId: "ada", roleIds: ["support"], admin: false }, board)).toBe("none");
  });
  test("viewers edit when the board says so; a private board is its owner's alone, admins included", () => {
    const lia = { userId: "lia", roleIds: [], admin: false };
    const theo = { userId: "theo", roleIds: [], admin: true };
    expect(dashboardAccessOf(lia, { ...board, audience: "workspace", editPolicy: "viewers" })).toBe("edits");
    expect(dashboardAccessOf(theo, { ...board, audience: "private" })).toBe("none");
  });
  test("with roles, a holder of an edit role who sees the board edits; one who doesn't see it gets nothing", () => {
    const byRoles = { ...board, roleIds: ["sales", "board"], editPolicy: "roles" as const, editRoleIds: ["board"] };
    expect(dashboardAccessOf({ userId: "lia", roleIds: ["board"], admin: false }, byRoles)).toBe("edits");
    expect(dashboardAccessOf({ userId: "ada", roleIds: ["sales"], admin: false }, byRoles)).toBe("sees");
    // Seeing comes first: an edit role outside the audience gives nothing.
    const outside = { ...byRoles, roleIds: ["sales"], editRoleIds: ["board"] };
    expect(dashboardAccessOf({ userId: "lia", roleIds: ["board"], admin: false }, outside)).toBe("none");
    // On a workspace board any member sees it; only the edit roles' holders edit.
    const everyone = { ...byRoles, audience: "workspace" as const, roleIds: [] };
    expect(dashboardAccessOf({ userId: "ada", roleIds: ["sales"], admin: false }, everyone)).toBe("sees");
    expect(dashboardAccessOf({ userId: "lia", roleIds: ["board"], admin: false }, everyone)).toBe("edits");
  });
});

describe("who edits", () => {
  const draft = {
    audience: "roles" as const,
    roleIds: ["sales", "board"],
    editPolicy: "owner" as DashboardEditPolicy,
    editRoleIds: [] as string[],
  };
  test("a role sees a workspace board, a roles board when it is one of them, never a private one", () => {
    expect(roleSeesBoard({ audience: "workspace", roleIds: [] }, "sales")).toBe(true);
    expect(roleSeesBoard({ audience: "roles", roleIds: ["sales"] }, "sales")).toBe(true);
    expect(roleSeesBoard({ audience: "roles", roleIds: ["sales"] }, "board")).toBe(false);
    expect(roleSeesBoard({ audience: "private", roleIds: [] }, "sales")).toBe(false);
  });
  test("checking roles sets `roles`; unchecking the last one goes back to you and admins", () => {
    const one = toggleEditRole(draft, "sales");
    expect(one).toMatchObject({ editPolicy: "roles", editRoleIds: ["sales"] });
    expect(toggleEditRole(one, "board")).toMatchObject({ editPolicy: "roles", editRoleIds: ["sales", "board"] });
    expect(toggleEditRole(one, "sales")).toMatchObject({ editPolicy: "owner", editRoleIds: [] });
    expect(withEditRoles({ ...draft, editPolicy: "viewers" }, ["board", "board"])).toMatchObject({
      editPolicy: "roles",
      editRoleIds: ["board"],
    });
  });
  test("narrowing who sees drops the edit roles that no longer see it, never widening who edits", () => {
    const picked = withEditRoles(draft, ["sales", "board"]);
    expect(fitEditRoles({ ...picked, roleIds: ["board"] })).toMatchObject({
      editPolicy: "roles",
      editRoleIds: ["board"],
    });
    expect(fitEditRoles({ ...picked, audience: "private" as const, roleIds: [] })).toMatchObject({
      editPolicy: "owner",
      editRoleIds: [],
    });
    const everyone = { ...picked, audience: "workspace" as const, roleIds: [] };
    expect(fitEditRoles(everyone)).toBe(everyone);
    expect(editorsInput({ editPolicy: "viewers", editRoleIds: ["sales"] })).toEqual({
      editPolicy: "viewers",
      editRoleIds: [],
    });
  });
  test("the summary names one or two roles and counts more; gone roles read as you and admins", () => {
    const roles = [
      { id: "sales", name: "Sales" },
      { id: "board", name: "Board" },
      { id: "ops", name: "Ops" },
    ];
    const t = ((key: string, o?: Record<string, unknown>) => `${key}${o ? JSON.stringify(o) : ""}`) as never;
    const text = (editRoleIds: string[], editPolicy: "viewers" | "owner" | "roles" = "roles") =>
      editorsText(t, editorsSummary({ editPolicy, editRoleIds }, roles));
    expect(text([], "viewers")).toBe("dashboards.edit.viewers");
    expect(text([], "owner")).toBe("dashboards.edit.owner");
    expect(text(["board"])).toBe("Board");
    expect(text(["board", "sales"])).toBe('dashboards.edit.twoRoles{"first":"Sales","second":"Board"}');
    expect(text(["ops", "board", "sales"])).toBe('dashboards.edit.manyRoles{"count":3}');
    expect(editorsSummary({ editPolicy: "roles", editRoleIds: ["gone"] }, roles)).toEqual({ kind: "owner" });
  });
});

describe("board layout", () => {
  test("tiles and widgets share one order; a tile comes first on a tie", () => {
    const items = boardItems(
      [widget("w1", 1), widget("w2", 0, 2)],
      [
        { key: "waiting", position: 0, w: 2, h: 1 },
        { key: "working", position: 3, w: 2, h: 1 },
      ],
    );
    expect(items.map((i) => i.id)).toEqual(["waiting", "w2", "w1", "working"]);
  });

  test("moving and resizing, then saving positions 0, 1, 2…", () => {
    const tiles = [{ key: "waiting" as const, position: 5, w: 2 as const, h: 1 as const }];
    const items = boardItems([widget("w1", 0), widget("w2", 1), widget("w3", 2)], tiles);
    const moved = moveItem(items, "waiting", "w1");
    expect(moved.map((i) => i.id)).toEqual(["waiting", "w1", "w2", "w3"]);
    expect(moveItem(items, "w1", "w3").map((i) => i.id)).toEqual(["w2", "w3", "w1", "waiting"]);
    expect(moveItem(items, "w1", "nope")).toEqual(items);
    const resized = resizeItem(moved, "w2", { w: 2, h: 2 });
    expect(layoutOf(resized)).toEqual({
      widgets: [
        { id: "w1", position: 1, w: 1, h: 1 },
        { id: "w2", position: 2, w: 2, h: 2 },
        { id: "w3", position: 3, w: 1, h: 1 },
      ],
      tiles: [{ key: "waiting", position: 0, w: 2, h: 1 }],
    });
    expect(layoutOf(boardItems([widget("w1", 0)]))).toEqual({ widgets: [{ id: "w1", position: 0, w: 1, h: 1 }] });
  });
});

describe("words", () => {
  test("a failure code with its own words, or the general one", () => {
    expect(widgetFailureKey("no_update")).toBe("widgets.failure.no_update");
    expect(widgetFailureKey("budget_exceeded")).toBe("widgets.failure.budget_exceeded");
    expect(widgetFailureKey("something_new")).toBe("widgets.failure.error");
  });

  test("the cost line follows the schedule and who pays", () => {
    const estimate = {
      agentId: "theo",
      schedule: "hour" as const,
      runsPerDay: 24,
      perRunUsd: 0.015,
      perDayUsd: 0.36,
      perWeekUsd: 2.52,
      basis: "history" as const,
      billedTo: "api" as const,
    };
    expect(widgetCostLine("manual", estimate)).toEqual({ kind: "manual" });
    expect(widgetCostLine("hour", estimate)).toEqual({ kind: "day", usd: 0.36 });
    expect(widgetCostLine("week", estimate)).toEqual({ kind: "week", usd: 2.52 });
    expect(widgetCostLine("hour", { ...estimate, billedTo: "plan" })).toEqual({ kind: "plan" });
    expect(widgetCostLine("hour", { ...estimate, perDayUsd: null })).toEqual({ kind: "unknown" });
    expect(widgetCostLine("day", null)).toEqual({ kind: "unknown" });
  });
});

describe("dashboards API", () => {
  test("calls the routes of the contract", async () => {
    const calls: { url: string; method: string; body: string | null }[] = [];
    const api = createHttpApi({
      fetch: async (url, init) => {
        calls.push({ url, method: init.method ?? "GET", body: (init.body as string | undefined) ?? null });
        const body = url.endsWith("/widget-pinnable?limit=5") ? { blocks: [] } : {};
        return new Response(init.method === "DELETE" ? null : JSON.stringify(body), {
          status: init.method === "DELETE" ? 204 : 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const org = "/api/app/organizations/o1";
    await api.dashboards.list("o1");
    await api.dashboards.home("o1");
    await api.dashboards.share("o1", "d1", {
      audience: "roles",
      roleIds: ["r1"],
      editPolicy: "roles",
      editRoleIds: ["r1"],
    });
    await api.dashboards.saveLayout("o1", "d1", { widgets: [{ id: "w1", position: 0, w: 2, h: 1 }] });
    await api.dashboards.decideProposal("o1", "d1", "publish");
    await api.dashboards.pinWidget("o1", "d1", { messageId: "m1", block: "{}", schedule: "manual" });
    await api.dashboards.refreshWidget("o1", "w1");
    await api.dashboards.askWidgetChange("o1", "w1", "split by channel");
    await api.dashboards.removeWidget("o1", "w1");
    await api.dashboards.widgetCost("o1", "a1", "hour");
    expect(await api.dashboards.pinnableBlocks("o1", 5)).toEqual([]);
    expect(calls.map((c) => `${c.method} ${c.url.replace(org, "")}`)).toEqual([
      "GET /dashboards",
      "GET /dashboards/home",
      "PUT /dashboards/d1/share",
      "PUT /dashboards/d1/layout",
      "POST /dashboards/d1/proposal",
      "POST /dashboards/d1/widgets/pin",
      "POST /widgets/w1/refresh",
      "POST /widgets/w1/change",
      "DELETE /widgets/w1",
      "GET /widget-cost?agentId=a1&schedule=hour",
      "GET /widget-pinnable?limit=5",
    ]);
    expect(calls[4]?.body).toBe('{"decision":"publish"}');
    expect(calls[7]?.body).toBe('{"text":"split by channel"}');
  });

  test("Test and Create widget (ADR 0135 §16)", async () => {
    const calls: { url: string; method: string; body: string | null }[] = [];
    const api = createHttpApi({
      fetch: async (url, init) => {
        calls.push({ url, method: init.method ?? "GET", body: (init.body as string | undefined) ?? null });
        return new Response(JSON.stringify(widget("w1", 0)), {
          status: url.endsWith("/test") ? 202 : 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const ask = { agentId: "a1", prompt: "Site visits", format: "auto" as const, schedule: "hour" as const };
    expect((await api.dashboards.testWidget("o1", "d1", ask)).id).toBe("w1");
    const confirm = {
      dashboardId: "d2",
      title: "Visits",
      size: "s" as const,
      schedule: "day" as const,
      alert: { enabled: false, condition: "" },
    };
    await api.dashboards.confirmWidget("o1", "w1", confirm);
    expect(calls.map((c) => `${c.method} ${c.url.replace("/api/app/organizations/o1", "")}`)).toEqual([
      "POST /dashboards/d1/widgets/test",
      "POST /widgets/w1/confirm",
    ]);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual(ask);
    expect(JSON.parse(calls[1]?.body ?? "{}")).toEqual(confirm);
  });
});

describe("dashboard events", () => {
  test("a draft's event refreshes its live view (Test in New widget)", () => {
    const qc = new QueryClient();
    qc.setQueryData(keys.widget("o1", "w9"), { ...widget("w9", 0), draft: true, status: "building" });
    const event = { type: "dashboard.widget", orgId: "o1", dashboardId: "d1", widgetId: "w9", status: "ok" };
    expect(applyDashboardEvent(qc, "o1", event as { type: string })).toBe(true);
    expect(qc.getQueryState(keys.widget("o1", "w9"))?.isInvalidated).toBe(true);
  });

  test("refetch what the event touches; other events pass", () => {
    const qc = new QueryClient();
    const board = { id: "d1", widgets: [] } as unknown as Dashboard;
    qc.setQueryData(keys.dashboard("o1", "d1"), board);
    qc.setQueryData(keys.widget("o1", "w1"), { id: "w1" });
    expect(applyDashboardEvent(qc, "o1", { type: "message.created" })).toBe(false);
    expect(
      applyDashboardEvent(qc, "o1", {
        type: "dashboard.widget",
        orgId: "o1",
        dashboardId: "d1",
        widgetId: "w1",
        status: "removed",
      } as { type: string }),
    ).toBe(true);
    expect(qc.getQueryState(keys.dashboard("o1", "d1"))?.isInvalidated).toBe(true);
    expect(qc.getQueryData(keys.widget("o1", "w1"))).toBeUndefined();
    const deleted = { type: "dashboard.changed", dashboardId: "d1", deleted: true } as { type: string };
    expect(applyDashboardEvent(qc, "o1", deleted)).toBe(true);
    expect(qc.getQueryData(keys.dashboard("o1", "d1"))).toBeUndefined();
  });
});

describe("a build's step line", () => {
  // The keys as the app would say them, so the test reads which words each call gets.
  const t = ((key: string, values?: { app?: string }) => (values?.app ? `${key}(${values.app})` : key)) as never;
  const step = (tool: string, connector: string | null = null) => ({ tool, connector, service: null, at: "" });

  test("a connected app by its name, our own tools by what they do, thinking between calls", () => {
    expect(widgetStepWords(t, null)).toBe("dashboards.newWidget.thinking");
    expect(widgetStepWords(t, undefined)).toBe("dashboards.newWidget.thinking");
    expect(widgetStepWords(t, step("stripe_list_subscriptions", "Stripe"))).toBe("Chat.activity.consulting(Stripe)");
    expect(widgetStepWords(t, step("web_search"))).toBe("Chat.activity.searchingWeb");
    expect(widgetStepWords(t, step("permission_prompt"))).toBe("Chat.activity.runningCommandAny");
    expect(widgetStepWords(t, step("update_widget"))).toBe("dashboards.newWidget.finishing");
  });
});

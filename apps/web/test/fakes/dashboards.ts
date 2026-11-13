/**
 * Test fake — boards and widgets (ADR 0135), same shapes as the server's `…/dashboards/*`, `…/widgets/*` and
 * `…/widget-*` routes. Empty until a test adds boards (`fake.boards`) or calls the client; the home board is made on
 * first read. Every widget the fake makes starts as the server's would (`building` when asked of an agent, `ok` when
 * pinned) and stays so until a test changes it (`fake.finish`). Changes are logged; reads are not.
 *
 * "Test" (`testWidget`) makes a draft (`fake.drafts`, on no board) that is built on the next tick, or at the latest on
 * its next read: `ok` with the example data of its format (a kpi for `auto`), titled after the ask, costing
 * `fake.testCostUsd`; `failed` (`agent_reported`) when the ask contains "fail". `fake.holdDrafts` keeps them
 * `building` until `fake.finish`. `confirmWidget` moves a draft that worked onto a board (first); `removeWidget`
 * drops it.
 */
import type {
  ApiClient,
  Dashboard,
  DashboardSummary,
  PinnableBlock,
  Widget,
  WidgetDetail,
  WidgetStep,
  WidgetSuggestions,
  WidgetUpdate,
} from "@agenteschat/client";
import { ApiError } from "@agenteschat/client";
import {
  chartBlockToWidgetSpec,
  type ExampleWords,
  exampleWidgetSpec,
  sizeToLayout,
  type WidgetSpec,
} from "@agenteschat/ui/widgets/spec";
import { clone, mockId } from "./context";

export interface FakeDashboards {
  client: ApiClient["dashboards"];
  /** Every board, homes included (`kind: "home"`, `ownerUserId` the person). */
  boards: Dashboard[];
  /** The board Início shows instead of my own home ("Use on Home"); null = my own. */
  homeDashboardId: string | null;
  history: Map<string, WidgetUpdate[]>;
  suggestions: Map<string, WidgetSuggestions>;
  pinnable: PinnableBlock[];
  /** What a cost estimate answers per run (USD). */
  perRunUsd: number;
  /** A widget's run ended: its data shows (`ok`), or it fails with `failure`. */
  finish(widgetId: string, result: { spec: WidgetSpec; title?: string } | { failure: string; detail?: string }): void;
  /** A board as the server would send it (mine, private, editable unless `over` says otherwise), added to `boards`. */
  addBoard(over: Partial<Dashboard>): Dashboard;
  /** A widget on a board, as the server would send it (`ok` with data when `over` gives a spec). */
  addWidget(dashboardId: string, over: Partial<Widget>): Widget;
  /** Widgets being tested ("Test" in New widget): on no board, mine alone. */
  drafts: Widget[];
  /** Keeps new drafts `building` until a test calls `finish` (default: built on the next tick). */
  holdDrafts: boolean;
  /** What a draft's test costs (`lastCostUsd`). */
  testCostUsd: number;
  /** The call a building draft's run is in (its view's `step`), by widget id. */
  steps: Map<string, WidgetStep>;
}

/** The words of the example data a draft is built with. */
const EXAMPLE_WORDS: ExampleWords = {
  days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
  vsYesterday: "vs. yesterday",
  goalLine: "248 of 400",
  goalNote: "On track for the month",
  lineNote: "Last 7 days",
  rows: ["Order 4371", "Order 4402", "Order 4410"],
  rowMeta: ["3 days", "2 days", "1 day"],
  items: ["Sales are up this week.", "Two orders are late."],
};

/** A short title from an ask, as an agent would write it (its first words). */
const titleOf = (prompt: string) => {
  const words = prompt.replace(/\s+/g, " ").trim().split(" ").slice(0, 4).join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const RUNS: Record<string, number> = { half: 48, hour: 24, day: 1, week: 1 / 7, manual: 0 };

export function createFakeDashboards(
  log: (method: string, ...args: unknown[]) => void,
  now: () => Date,
  me: () => string | null,
): FakeDashboards {
  const at = () => now().toISOString();
  const notFound = (what: "dashboard" | "widget") =>
    new ApiError(404, `${what}.not_found`, what === "dashboard" ? "Dashboard not found" : "Widget not found");
  const summary = (d: Dashboard): DashboardSummary => {
    const { widgets: _w, tiles: _t, ...rest } = d;
    return {
      ...rest,
      mine: d.ownerUserId === me(),
      widgetCount: d.widgets.length,
      thumbs: d.widgets.slice(0, 6).map((w) => ({ agentId: w.agentId, w: w.layout.w })),
    };
  };
  const board = (dashboardId: string) => {
    const d = fake.boards.find((x) => x.id === dashboardId);
    if (!d) throw notFound("dashboard");
    return d;
  };
  const find = (widgetId: string) => {
    for (const d of fake.boards) {
      const w = d.widgets.find((x) => x.id === widgetId);
      if (w) return { d, w };
    }
    throw notFound("widget");
  };
  /** A draft and the board it was tested for. */
  const findDraft = (widgetId: string) => {
    const w = fake.drafts.find((x) => x.id === widgetId);
    if (!w) return null;
    return { d: fake.boards.find((x) => x.id === w.dashboardId) ?? home(), w };
  };
  /** Drafts still waiting for their test build. */
  const building = new Set<string>();
  const build = (widgetId: string) => {
    if (!building.delete(widgetId)) return;
    const w = fake.drafts.find((x) => x.id === widgetId);
    if (!w) return;
    if (/fail/i.test(w.prompt)) {
      Object.assign(w, {
        status: "failed",
        failure: { code: "agent_reported", detail: "The source isn't connected for me." },
        updatedAt: at(),
      });
      return;
    }
    const spec = exampleWidgetSpec(w.format === "auto" ? "kpi" : w.format, EXAMPLE_WORDS);
    Object.assign(w, {
      spec,
      kind: spec.kind,
      title: w.title || titleOf(w.prompt),
      status: "ok",
      failure: null,
      refreshedAt: at(),
      lastCostUsd: fake.testCostUsd,
      updatedAt: at(),
    });
  };
  const touch = (d: Dashboard) => {
    d.updatedAt = at();
    d.widgetCount = d.widgets.length;
    return clone(d);
  };
  const newBoard = (over: Partial<Dashboard>): Dashboard => ({
    id: mockId("dash"),
    kind: "board",
    title: "",
    about: "",
    audience: "private",
    roleIds: [],
    editPolicy: "owner",
    editRoleIds: [],
    pinned: false,
    position: fake.boards.length,
    owner: null,
    ownerUserId: me(),
    mine: true,
    widgetCount: 0,
    thumbs: [],
    viewerCount: 1,
    canEdit: true,
    canManage: true,
    proposal: null,
    createdAt: at(),
    updatedAt: at(),
    widgets: [],
    tiles: [],
    ...over,
  });
  const newWidget = (d: Dashboard, over: Partial<Widget>): Widget => ({
    id: mockId("widget"),
    dashboardId: d.id,
    agentId: "",
    title: "",
    prompt: "",
    format: "auto",
    kind: null,
    spec: null,
    sources: [],
    layout: { position: d.widgets.length, w: 2, h: 1 },
    schedule: "manual",
    alert: { enabled: false, condition: "" },
    status: "building",
    failure: null,
    refreshedAt: null,
    nextRunAt: null,
    routineId: null,
    sourceMessageId: null,
    createdBy: me() ? { kind: "person", id: me() as string } : null,
    draft: false,
    lastCostUsd: null,
    createdAt: at(),
    updatedAt: at(),
    ...over,
  });
  const home = () => {
    let d = fake.boards.find((x) => x.kind === "home" && x.ownerUserId === me());
    if (!d) {
      d = newBoard({
        kind: "home",
        tiles: [
          { key: "waiting", position: 0, w: 2, h: 1 },
          { key: "working", position: 3, w: 2, h: 1 },
        ],
      });
      fake.boards.push(d);
    }
    return d;
  };

  const fake: FakeDashboards = {
    boards: [],
    homeDashboardId: null,
    drafts: [],
    holdDrafts: false,
    testCostUsd: 0.01,
    steps: new Map(),
    history: new Map(),
    suggestions: new Map(),
    pinnable: [],
    perRunUsd: 0.015,
    addBoard(over) {
      const d = newBoard(over);
      fake.boards.push(d);
      return d;
    },
    addWidget(dashboardId, over) {
      const d = board(dashboardId);
      const w = newWidget(d, { status: over.spec ? "ok" : "building", kind: over.spec?.kind ?? null, ...over });
      d.widgets.push(w);
      touch(d);
      return w;
    },
    finish(widgetId, result) {
      building.delete(widgetId);
      const { w } = findDraft(widgetId) ?? find(widgetId);
      if ("spec" in result) {
        Object.assign(w, {
          spec: result.spec,
          kind: result.spec.kind,
          title: result.title ?? w.title,
          status: "ok",
          failure: null,
          refreshedAt: at(),
        });
      } else {
        Object.assign(w, { status: "failed", failure: { code: result.failure, detail: result.detail ?? null } });
      }
    },
    client: {
      list: async () => {
        const mine = fake.boards.find((x) => x.kind === "home" && x.ownerUserId === me());
        return {
          home: mine ? summary(mine) : null,
          dashboards: fake.boards.filter((x) => x.kind === "board").map(summary),
          homeDashboardId: fake.boards.some((x) => x.id === fake.homeDashboardId) ? fake.homeDashboardId : null,
        };
      },
      setHome: async (orgId, dashboardId) => {
        log("dashboards.setHome", orgId, dashboardId);
        fake.homeDashboardId = dashboardId;
        return { homeDashboardId: dashboardId };
      },
      // `home` is My Home's own address on the server (`GET …/dashboards/home`).
      get: async (_orgId, dashboardId) => clone(dashboardId === "home" ? home() : board(dashboardId)),
      home: async () => clone(home()),
      create: async (orgId, input) => {
        log("dashboards.create", orgId, input);
        const d = newBoard({
          title: input.title,
          about: input.about ?? "",
          audience: input.audience,
          roleIds: input.roleIds ?? [],
          editPolicy: input.editPolicy,
          editRoleIds: input.editRoleIds ?? [],
        });
        fake.boards.push(d);
        return clone(d);
      },
      update: async (orgId, dashboardId, patch) => {
        log("dashboards.update", orgId, dashboardId, patch);
        const d = board(dashboardId);
        Object.assign(d, patch);
        return touch(d);
      },
      share: async (orgId, dashboardId, input) => {
        log("dashboards.share", orgId, dashboardId, input);
        const d = board(dashboardId);
        const { audience, roleIds, editPolicy, editRoleIds = [] } = input;
        Object.assign(d, { audience, roleIds, editPolicy, editRoleIds, proposal: null });
        return touch(d);
      },
      remove: async (orgId, dashboardId) => {
        log("dashboards.remove", orgId, dashboardId);
        board(dashboardId);
        fake.boards = fake.boards.filter((x) => x.id !== dashboardId);
      },
      saveLayout: async (orgId, dashboardId, input) => {
        log("dashboards.saveLayout", orgId, dashboardId, input);
        const d = board(dashboardId);
        for (const l of input.widgets) {
          const w = d.widgets.find((x) => x.id === l.id);
          if (w) w.layout = { position: l.position, w: l.w, h: l.h };
        }
        if (input.tiles && d.kind === "home") d.tiles = clone(input.tiles);
        d.widgets.sort((a, b) => a.layout.position - b.layout.position);
        return touch(d);
      },
      decideProposal: async (orgId, dashboardId, decision) => {
        log("dashboards.decideProposal", orgId, dashboardId, decision);
        const d = board(dashboardId);
        if (!d.proposal) throw new ApiError(409, "dashboard.proposal_none", "No request is pending");
        if (decision === "publish") Object.assign(d, { audience: d.proposal.audience, roleIds: d.proposal.roleIds });
        d.proposal = null;
        return touch(d);
      },
      createWidget: async (orgId, dashboardId, input) => {
        log("dashboards.createWidget", orgId, dashboardId, input);
        const d = board(dashboardId);
        const w = newWidget(d, {
          agentId: input.agentId,
          title: input.title ?? "",
          prompt: input.prompt,
          format: input.format,
          kind: input.format === "auto" ? null : input.format,
          schedule: input.schedule,
          alert: input.alert ?? { enabled: false, condition: "" },
          layout: { position: d.widgets.length, ...sizeToLayout(input.size ?? "m") },
        });
        d.widgets.push(w);
        touch(d);
        return clone(w);
      },
      testWidget: async (orgId, dashboardId, input) => {
        log("dashboards.testWidget", orgId, dashboardId, input);
        const d = board(dashboardId);
        const w = newWidget(d, {
          agentId: input.agentId,
          title: input.title ?? "",
          prompt: input.prompt,
          format: input.format,
          kind: input.format === "auto" ? null : input.format,
          layout: { position: 0, ...sizeToLayout(input.size ?? "m") },
          draft: true,
        });
        fake.drafts.push(w);
        // A person keeps 5 drafts at most: the oldest go.
        if (fake.drafts.length > 5) fake.drafts = fake.drafts.slice(-5);
        if (!fake.holdDrafts) {
          building.add(w.id);
          setTimeout(() => build(w.id), 0);
        }
        return clone(w);
      },
      confirmWidget: async (orgId, widgetId, input) => {
        log("dashboards.confirmWidget", orgId, widgetId, input);
        build(widgetId);
        const found = findDraft(widgetId);
        if (!found) throw notFound("widget");
        const { w } = found;
        if (w.status !== "ok") {
          throw new ApiError(409, "widget.not_tested", "Test it first: the widget is confirmed once its test worked");
        }
        const to = board(input.dashboardId);
        fake.drafts = fake.drafts.filter((x) => x.id !== widgetId);
        const top = Math.min(0, ...to.widgets.map((x) => x.layout.position), ...to.tiles.map((x) => x.position));
        Object.assign(w, {
          draft: false,
          dashboardId: to.id,
          title: input.title ?? w.title,
          schedule: input.schedule,
          alert: clone(input.alert),
          layout: { position: top - 1, ...sizeToLayout(input.size) },
          updatedAt: at(),
        });
        to.widgets.unshift(w);
        touch(to);
        return clone(w);
      },
      pinWidget: async (orgId, dashboardId, input) => {
        log("dashboards.pinWidget", orgId, dashboardId, input);
        const d = board(dashboardId);
        const block = fake.pinnable.find((b) => b.messageId === input.messageId && b.block === input.block);
        const read = chartBlockToWidgetSpec(input.block);
        if (!block || !read) throw new ApiError(404, "widget.block_not_found", "That chart isn't in the message");
        const w = newWidget(d, {
          agentId: block.agentId,
          title: input.title ?? read.title,
          kind: read.spec.kind,
          spec: read.spec as Widget["spec"],
          format: read.spec.kind,
          status: "ok",
          refreshedAt: at(),
          schedule: input.schedule,
          sourceMessageId: input.messageId,
          layout: { position: d.widgets.length, ...sizeToLayout(input.size ?? "m") },
        });
        d.widgets.push(w);
        touch(d);
        return clone(w);
      },
      widget: async (_orgId, widgetId) => {
        build(widgetId);
        const { d, w } = findDraft(widgetId) ?? find(widgetId);
        const detail: WidgetDetail = {
          ...clone(w),
          dashboard: { id: d.id, kind: d.kind, title: d.title },
          canEdit: d.canEdit,
          history: clone(fake.history.get(widgetId) ?? []),
          step: w.status === "building" ? (fake.steps.get(widgetId) ?? null) : null,
        };
        return detail;
      },
      updateWidget: async (orgId, widgetId, patch) => {
        log("dashboards.updateWidget", orgId, widgetId, patch);
        const { d, w } = find(widgetId);
        const { size, dashboardId, ...rest } = patch;
        Object.assign(w, rest, { updatedAt: at() });
        if (size) w.layout = { ...w.layout, ...sizeToLayout(size) };
        if (dashboardId && dashboardId !== d.id) {
          const to = board(dashboardId);
          d.widgets = d.widgets.filter((x) => x.id !== widgetId);
          w.dashboardId = to.id;
          w.layout = { ...w.layout, position: to.widgets.length };
          to.widgets.push(w);
          touch(to);
        }
        touch(d);
        return clone(w);
      },
      removeWidget: async (orgId, widgetId) => {
        log("dashboards.removeWidget", orgId, widgetId);
        if (findDraft(widgetId)) {
          building.delete(widgetId);
          fake.drafts = fake.drafts.filter((x) => x.id !== widgetId);
          return;
        }
        const { d } = find(widgetId);
        d.widgets = d.widgets.filter((x) => x.id !== widgetId);
        touch(d);
      },
      refreshWidget: async (orgId, widgetId) => {
        log("dashboards.refreshWidget", orgId, widgetId);
        const { w } = find(widgetId);
        w.status = w.spec ? "updating" : "building";
        w.failure = null;
        return clone(w);
      },
      askWidgetChange: async (orgId, widgetId, text) => {
        log("dashboards.askWidgetChange", orgId, widgetId, text);
        const { w } = find(widgetId);
        w.status = w.spec ? "updating" : "building";
        return clone(w);
      },
      widgetCost: async (_orgId, agentId, schedule) => {
        const runsPerDay = RUNS[schedule] ?? 0;
        const perDayUsd = runsPerDay ? fake.perRunUsd * runsPerDay : null;
        return {
          agentId,
          schedule,
          runsPerDay,
          perRunUsd: fake.perRunUsd,
          perDayUsd,
          perWeekUsd: perDayUsd === null ? null : perDayUsd * 7,
          basis: "history",
          billedTo: "api",
        };
      },
      widgetSuggestions: async (_orgId, agentId) =>
        clone(fake.suggestions.get(agentId) ?? { agentId, sources: [], suggestions: [] }),
      pinnableBlocks: async (_orgId, limit) => clone(fake.pinnable.slice(0, limit ?? 20)),
    },
  };
  return fake;
}

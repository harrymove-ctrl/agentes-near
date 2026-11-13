import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type DashboardList, type DashboardSummary, frozenBoard } from "@agenteschat/client";
import { type OpenTarget, targetPath } from "@agenteschat/client/lib/notifications";
import { chartAreaTones, chartInk } from "@agenteschat/ui/sky/chart";
import { agentPickNow, chooseAgent, closeAgentPick, openAgentPick } from "../../src/features/dashboards/agent-pick";
import {
  AGENT_SEARCH_FROM,
  accessPerson,
  agentsMatching,
  asksInCard,
  audienceChanged,
  audienceDraftOf,
  audienceReady,
  barValueText,
  barWords,
  bleedPoints,
  bleedSeries,
  boardMenuKeys,
  confirmTitle,
  dashboardWaitingCard,
  destinationsOf,
  ditherCells,
  editorsChoices,
  exampleWordsOf,
  formatWidgetNumber,
  formatWithUnit,
  goalShare,
  HOME,
  isDashboardNotice,
  isTall,
  layoutChanged,
  mixHex,
  moveWidgetItem,
  newWidgetAction,
  newWidgetBarLabel,
  phoneRows,
  pickMenuLabel,
  pinDraftNow,
  previewKind,
  realBoardId,
  roleNamesOf,
  roundRectPath,
  setPinDraft,
  shareInputOf,
  shownWidgetTitle,
  sizeFor,
  softCardColor,
  testKeyOf,
  testPhase,
  thumbRects,
  toggledEditRoles,
  toggleRole,
  topRoundedPath,
  widgetPlace,
  widgetPreview,
  widgetsInOrder,
  widgetTones,
  withAudience,
  withEditors,
} from "../../src/features/dashboards/logic";
import { appLinkFromUrl } from "../../src/features/links/app-links";
import {
  boardHref,
  hrefForPush,
  hrefFromUrl,
  notificationHref,
  pushAsNotification,
  widgetHref,
} from "../../src/features/links/logic";
import { routineTitle, targetIcon } from "../../src/features/routines/logic";
import { TAB_GLYPHS } from "../../src/ui/tabGlyphs";
import { notification } from "./fixtures";

const board = (over: Partial<DashboardSummary> & { id: string }): DashboardSummary => ({
  kind: "board",
  title: over.id,
  about: "",
  audience: "workspace",
  roleIds: [],
  editPolicy: "viewers",
  pinned: false,
  position: 0,
  owner: null,
  ownerUserId: null,
  mine: false,
  widgetCount: 0,
  thumbs: [],
  viewerCount: 3,
  canEdit: true,
  canManage: false,
  proposal: null,
  createdAt: "2026-11-01T10:00:00.000Z",
  updatedAt: "2026-11-01T10:00:00.000Z",
  ...over,
});

/** Example words that say their own key: what a preview gets is visible in the test. */
const words = exampleWordsOf((key) => key.replace("widgets.example.", ""));

describe("dashboards on the phone (ADR 0135)", () => {
  test("the three dashboard notices, and no other", () => {
    expect(isDashboardNotice("widget_alert")).toBe(true);
    expect(isDashboardNotice("widget_failed")).toBe(true);
    expect(isDashboardNotice("dashboard_proposal")).toBe(true);
    expect(isDashboardNotice("approval")).toBe(false);
    expect(isDashboardNotice("routine_failed")).toBe(false);
  });

  test("a waiting dashboard notice: its own word and line, by kind", () => {
    const say = (key: string, values?: Record<string, unknown>) => `${key}${values ? JSON.stringify(values) : ""}`;
    const alert = notification({
      id: "n1",
      kind: "widget_alert",
      waiting: true,
      source: { dashboardId: "d1", widgetId: "w1", agentId: "a1", label: "Sales today" },
      latest: { text: "Sales fell 24% below yesterday." },
    });
    expect(dashboardWaitingCard(alert, say)).toEqual({
      kind: "mobile.dashboards.notice.card.alert",
      title: "Sales fell 24% below yesterday.",
    });
    const roles = notification({
      id: "n2",
      kind: "dashboard_proposal",
      waiting: true,
      source: { dashboardId: "d1", agentId: "a1", label: "Black Friday" },
      latest: { statusTo: "roles", names: ["Sales", "Board"], text: "The team asked for it." },
    });
    expect(dashboardWaitingCard(roles, say)?.title).toBe(
      'widgets.notice.proposalRoles{"title":"Black Friday","roles":"Sales, Board"}',
    );
    const workspace = notification({
      id: "n3",
      kind: "dashboard_proposal",
      source: { dashboardId: "d1", label: "Black Friday" },
      latest: { statusTo: "workspace" },
    });
    const line = dashboardWaitingCard(workspace, say)?.title;
    expect(line).toBe('widgets.notice.proposalWorkspace{"title":"Black Friday"}');
    const failed = notification({ id: "n4", kind: "widget_failed", source: { widgetId: "w1", label: "Visits" } });
    expect(dashboardWaitingCard({ ...failed, latest: {} }, say)).toEqual({
      kind: "mobile.dashboards.notice.card.failed",
      title: "Visits",
    });
    expect(dashboardWaitingCard(notification({ id: "n5", kind: "approval" }), say)).toBeNull();
  });

  test("tones: the chat charts' stroke over their near area tone, in both themes", () => {
    expect(widgetTones("indigo", false)).toEqual({ stroke: chartInk("indigo"), fill: chartAreaTones("indigo")[0] });
    expect(widgetTones("indigo", true)).toEqual({
      stroke: chartInk("indigo", true),
      fill: chartAreaTones("indigo", true)[0],
    });
    expect(widgetTones("indigo", true).stroke).not.toBe(widgetTones("indigo", false).stroke);
  });

  test("the dither: a Bayer threshold, denser with more density, empty at zero", () => {
    const count = (cells: Uint8Array) => cells.reduce((a, b) => a + b, 0);
    expect(ditherCells(4, 4, 0).length).toBe(16);
    expect(count(ditherCells(4, 4, 0))).toBe(0);
    expect(count(ditherCells(4, 4, 1))).toBe(16);
    expect(count(ditherCells(8, 8, 0.25))).toBeLessThan(count(ditherCells(8, 8, 0.6)));
    expect(ditherCells(0, 3, 0.5).length).toBe(0);
  });

  test("bar and rounded shapes are finite SVG paths; a bar's outline leaves its bottom open", () => {
    const closed = topRoundedPath(0.75, 0.75, 20, 40, 4);
    const open = topRoundedPath(0.75, 0.75, 20, 40, 4, false);
    expect(closed.endsWith("Z")).toBe(true);
    expect(open.endsWith("Z")).toBe(false);
    expect(closed).not.toContain("NaN");
    // A bar lower than its radius still draws.
    expect(topRoundedPath(0, 0, 10, 2, 4)).not.toContain("NaN");
    expect(roundRectPath(0, 0, 10, 10, 3).startsWith("M3 0")).toBe(true);
    expect(roundRectPath(0, 0, 4, 4, 9)).not.toContain("-");
  });

  test("the 2-column board: 2-wide widgets take a row, 1-wide ones pair up in order", () => {
    const item = (id: string, w: 1 | 2) => ({ id, w });
    const rows = phoneRows([item("a", 1), item("b", 1), item("c", 2), item("d", 1), item("e", 2), item("f", 1)]);
    expect(rows.map((r) => r.map((x) => x.id))).toEqual([["a", "b"], ["c"], ["d"], ["e"], ["f"]]);
    expect(phoneRows([])).toEqual([]);
    expect(phoneRows([item("a", 1), item("b", 1), item("c", 1)]).map((r) => r.length)).toEqual([2, 1]);
  });

  test("widgets in their board's order", () => {
    const w = (id: string, position: number) => ({ id, layout: { position } });
    expect(widgetsInOrder([w("b", 2), w("a", 0), w("c", 1)]).map((x) => x.id)).toEqual(["a", "c", "b"]);
  });

  test("a thumbnail's tiles: two columns, wide ones on a row of their own, cut at the box", () => {
    const rects = thumbRects(
      [
        { agentId: "a1", w: 1 },
        { agentId: "a2", w: 1 },
        { agentId: "a3", w: 2 },
        { agentId: "a4", w: 1 },
        { agentId: "a5", w: 1 },
      ],
      56,
      44,
    );
    expect(rects.map((r) => r.agentId)).toEqual(["a1", "a2", "a3", "a4", "a5"]);
    expect(rects[0]).toEqual({ x: 5, y: 5, w: 21.5, h: 12, agentId: "a1" });
    expect(rects[1]?.x).toBe(29.5);
    expect(rects[2]).toMatchObject({ x: 5, y: 20, w: 46 });
    // The third row is cut to fit the box.
    expect(rects[3]).toMatchObject({ y: 35, h: 4 });
    // Past the box: left out.
    const wide = ["a", "b", "c", "d"].map((agentId) => ({ agentId, w: 2 }));
    expect(thumbRects(wide, 56, 44)).toHaveLength(3);
  });

  test("numbers as people read them, with a unit where a chart puts it", () => {
    expect(formatWidgetNumber(18420, "pt-BR")).toBe("18.420");
    expect(formatWidgetNumber(4.256, "en")).toBe("4.26");
    expect(formatWidgetNumber(186.44, "en")).toBe("186.4");
    expect(formatWithUnit(9200, "R$", "pt-BR")).toBe("R$ 9.200");
    expect(formatWithUnit(42, "%", "en")).toBe("42%");
    expect(formatWithUnit(6, "min", "en")).toBe("6 min");
    expect(formatWithUnit(6, undefined, "en")).toBe("6");
  });

  test("bars keep every label while there's room, else every n-th; values only with room", () => {
    expect(barWords(5, 300)).toEqual({ every: 1, values: true });
    expect(barWords(24, 150).every).toBeGreaterThan(1);
    expect(barWords(24, 150).values).toBe(false);
    expect(barWords(0, 300)).toEqual({ every: 1, values: false });
  });

  test("a goal fills 0 to 1", () => {
    expect(goalShare(62)).toBe(0.62);
    expect(goalShare(140)).toBe(1);
    expect(goalShare(-5)).toBe(0);
  });

  test("the New widget preview: nothing until asked, the format or the suggestion's kind, its width", () => {
    expect(widgetPreview("  ", "auto", null, words)).toBeNull();
    expect(previewKind("auto", null)).toBe("kpi");
    expect(previewKind("auto", "bars")).toBe("bars");
    expect(previewKind("line", "bars")).toBe("line");
    const kpi = widgetPreview("today's sales vs. yesterday", "auto", null, words);
    expect(kpi).toMatchObject({ kind: "kpi", w: 1 });
    // The ask is never the title: the screen names the preview (a suggestion's title, else the kind's word).
    expect(kpi).not.toHaveProperty("title");
    expect(kpi?.spec).toMatchObject({ kind: "kpi", note: "vsYesterday" });
    const line = widgetPreview("visits", "line", null, words);
    expect(line).toMatchObject({ kind: "line", w: 2 });
    const days = [1, 2, 3, 4, 5, 6, 7].map((i) => `days.d${i}`);
    expect(line?.spec.kind === "line" ? line.spec.labels : []).toEqual(days);
  });

  test("a widget's title: its own, else the kind's word or New widget while it is built, never the ask", () => {
    const say = (key: string) => `<${key}>`;
    expect(shownWidgetTitle("Visits on the site", "line", say)).toBe("Visits on the site");
    expect(shownWidgetTitle("  ", "line", say)).toBe("<widgets.kinds.line>");
    expect(shownWidgetTitle("", null, say)).toBe("<dashboards.newWidget.title>");
    expect(shownWidgetTitle(undefined, "auto", say)).toBe("<dashboards.newWidget.title>");
  });

  test("a test covers the ask, the agent and the format, nothing else", () => {
    const key = testKeyOf(" visits today ", "a1", "auto");
    expect(testKeyOf("visits today", "a1", "auto")).toBe(key);
    expect(testKeyOf("visits this week", "a1", "auto")).not.toBe(key);
    expect(testKeyOf("visits today", "a2", "auto")).not.toBe(key);
    expect(testKeyOf("visits today", "a1", "line")).not.toBe(key);
    expect(testKeyOf("visits today", null, "auto")).not.toBe(key);
  });

  test("New widget's test: testing, built, failed, or stale once the ask, agent or format changed", () => {
    const key = testKeyOf("visits", "a1", "auto");
    const at = (status: "building" | "updating" | "ok" | "failed", currentKey = key, pending = false) =>
      testPhase({ pending, draft: { status }, testedKey: key, currentKey });
    expect(testPhase({ pending: false, draft: null, testedKey: null, currentKey: key })).toBe("untested");
    expect(testPhase({ pending: true, draft: null, testedKey: null, currentKey: key })).toBe("testing");
    expect(at("building")).toBe("testing");
    expect(at("updating")).toBe("testing");
    expect(at("ok")).toBe("ok");
    expect(at("failed")).toBe("failed");
    expect(at("ok", testKeyOf("visits", "a1", "line"))).toBe("stale");
    expect(at("failed", testKeyOf("visits", "a2", "auto"))).toBe("stale");
    // Testing again: the new test is under way whatever the old draft was.
    expect(at("ok", key, true)).toBe("testing");
    // Create only after a successful test of what is asked now.
    expect(newWidgetAction("ok")).toBe("create");
    const others = (["untested", "testing", "failed", "stale"] as const).map(newWidgetAction);
    expect(others).toEqual(["test", "test", "test", "test"]);
  });

  test("Create sends the person's title only when it differs from the agent's", () => {
    expect(confirmTitle(null, "Visits on the site")).toBeUndefined();
    expect(confirmTitle("  Visits on the site ", "Visits on the site")).toBeUndefined();
    expect(confirmTitle("   ", "Visits on the site")).toBeUndefined();
    expect(confirmTitle(" Site visits ", "Visits on the site")).toBe("Site visits");
  });

  test("a pick menu's item on one line: the name, then its role", () => {
    expect(pickMenuLabel("Theo", "Sales analyst")).toBe("Theo · Sales analyst");
    expect(pickMenuLabel("Theo", null)).toBe("Theo");
    expect(pickMenuLabel("Theo", "")).toBe("Theo");
  });

  test("where a new widget goes: My Home first, then the boards the person edits", () => {
    const list: DashboardList = {
      home: null,
      dashboards: [
        board({ id: "b", title: "Sales", position: 2 }),
        board({ id: "a", title: "Support", position: 1 }),
        board({ id: "p", title: "Pinned", position: 9, pinned: true }),
        board({ id: "ro", title: "Finance", canEdit: false }),
        board({ id: "h", kind: "home", title: "" }),
      ],
      homeDashboardId: null,
    };
    expect(destinationsOf(list).map((d) => d.id)).toEqual([HOME, "p", "a", "b"]);
    expect(destinationsOf(undefined)).toEqual([{ id: HOME, title: null, home: true }]);
    expect(realBoardId(HOME, "home-1")).toBe("home-1");
    expect(realBoardId(HOME, undefined)).toBeNull();
    expect(realBoardId("b", "home-1")).toBe("b");
  });

  test("Share's draft: roles need one picked, only a roles audience sends them, and what changed", () => {
    const fresh = audienceDraftOf(null);
    expect(fresh).toEqual({ audience: "workspace", roleIds: [], editPolicy: "viewers", editRoleIds: [] });
    const roles = { ...fresh, audience: "roles" as const };
    expect(audienceReady(roles)).toBe(false);
    const picked = toggleRole(roles, "r1");
    expect(audienceReady(picked)).toBe(true);
    expect(toggleRole(picked, "r1").roleIds).toEqual([]);
    expect(shareInputOf(picked)).toEqual({
      audience: "roles",
      roleIds: ["r1"],
      editPolicy: "viewers",
      editRoleIds: [],
    });
    expect(shareInputOf({ ...picked, audience: "private" })).toEqual({
      audience: "private",
      roleIds: [],
      editPolicy: "viewers",
      editRoleIds: [],
    });
    const saved = board({ id: "b", audience: "roles", roleIds: ["r2", "r1"], editPolicy: "owner" });
    expect(audienceChanged(saved, audienceDraftOf(saved))).toBe(false);
    expect(audienceChanged(saved, { ...audienceDraftOf(saved), roleIds: ["r1", "r2"] })).toBe(false);
    expect(audienceChanged(saved, { ...audienceDraftOf(saved), roleIds: ["r1"] })).toBe(true);
    expect(audienceChanged(saved, { ...audienceDraftOf(saved), editPolicy: "viewers" })).toBe(true);
  });

  test("Who edits: its menu, some roles checked on their screen, and roles that stop seeing it leave", () => {
    expect(editorsChoices(0)).toEqual(["viewers", "owner"]);
    expect(editorsChoices(2)).toEqual(["viewers", "owner", "roles"]);
    expect(toggledEditRoles([], "r1")).toEqual(["r1"]);
    expect(toggledEditRoles(["r1", "r2"], "r1")).toEqual(["r2"]);

    const saved = board({
      id: "b",
      audience: "roles",
      roleIds: ["r1", "r2"],
      editPolicy: "roles",
      editRoleIds: ["r2"],
    });
    const draft = audienceDraftOf(saved);
    expect(draft).toEqual({ audience: "roles", roleIds: ["r1", "r2"], editPolicy: "roles", editRoleIds: ["r2"] });
    expect(audienceChanged(saved, draft)).toBe(false);
    expect(audienceChanged(saved, { ...draft, editRoleIds: ["r1"] })).toBe(true);
    expect(shareInputOf(draft)).toEqual({
      audience: "roles",
      roleIds: ["r1", "r2"],
      editPolicy: "roles",
      editRoleIds: ["r2"],
    });
    // A role out of who sees it leaves who edits; none left: only you and admins.
    expect(toggleRole(draft, "r2")).toMatchObject({ roleIds: ["r1"], editPolicy: "owner", editRoleIds: [] });
    expect(toggleRole(draft, "r1")).toMatchObject({ roleIds: ["r2"], editPolicy: "roles", editRoleIds: ["r2"] });
    expect(withAudience(draft, "private")).toMatchObject({ editPolicy: "owner", editRoleIds: [] });
    expect(withAudience(draft, "workspace")).toMatchObject({ editPolicy: "roles", editRoleIds: ["r2"] });
    expect(withEditors(draft, "viewers")).toMatchObject({ editPolicy: "viewers", editRoleIds: [] });
    // Another policy's leftover roles are never read as edit roles.
    expect(audienceDraftOf({ ...saved, editPolicy: "owner" }).editRoleIds).toEqual([]);
  });

  test("who is an admin for Share's access list: an owner or someone with an administrator role", () => {
    const roles = [
      { id: "admin", permissions: ["administrator"] },
      { id: "sales", permissions: ["post"] },
    ];
    expect(accessPerson({ userId: "u1", role: "owner" }, roles)).toEqual({ userId: "u1", roleIds: [], admin: true });
    expect(accessPerson({ userId: "u2", role: "member", roleIds: ["admin"] }, roles).admin).toBe(true);
    expect(accessPerson({ userId: "u3", role: "member", roleIds: ["sales"] }, roles).admin).toBe(false);
    expect(
      roleNamesOf(
        ["b", "x"],
        [
          { id: "a", name: "Sales" },
          { id: "b", name: "Board" },
        ],
      ),
    ).toEqual(["Board"]);
  });

  test("Organize: a widget trades places with the next widget; a home board's tiles keep theirs", () => {
    const tile = (id: string) => ({ id, type: "tile" as const, w: 2, h: 1 });
    const widget = (id: string) => ({ id, type: "widget" as const, w: 1, h: 1 });
    const items = [tile("waiting"), widget("a"), tile("working"), widget("b"), widget("c")];
    const ids = (list: { id: string }[]) => list.map((x) => x.id);
    expect(ids(moveWidgetItem(items, "b", -1))).toEqual(["waiting", "b", "working", "a", "c"]);
    expect(ids(moveWidgetItem(items, "a", 1))).toEqual(["waiting", "b", "working", "a", "c"]);
    expect(ids(moveWidgetItem(items, "c", 1))).toEqual(ids(items));
    expect(ids(moveWidgetItem(items, "a", -1))).toEqual(ids(items));
    expect(ids(moveWidgetItem(items, "zzz", 1))).toEqual(ids(items));
    expect(widgetPlace(items, "b")).toEqual({ at: 2, count: 3 });
    expect(widgetPlace(items, "waiting")).toEqual({ at: 0, count: 3 });
  });

  test("Organize saves only a change: the order or a size", () => {
    const a = { id: "a", w: 1, h: 1 };
    const b = { id: "b", w: 2, h: 1 };
    expect(layoutChanged([a, b], [a, b])).toBe(false);
    expect(layoutChanged([a, b], [b, a])).toBe(true);
    expect(layoutChanged([a, b], [{ ...a, w: 2, h: 2 }, b])).toBe(true);
    expect(layoutChanged([a, b], [a])).toBe(true);
    expect(isTall(2)).toBe(true);
    expect(isTall(1)).toBe(false);
  });

  test("a board's menu offers only what the viewer may do; My Home is only organized", () => {
    const manager = { kind: "board" as const, canEdit: true, canManage: true, audience: "workspace" as const };
    expect(boardMenuKeys({ ...manager, pinned: false })).toEqual([
      "home",
      "organize",
      "share",
      "edit",
      "pin",
      "delete",
    ]);
    expect(boardMenuKeys({ ...manager, pinned: true })).toContain("unpin");
    const privateBoard = { ...manager, audience: "private" as const, pinned: false };
    expect(boardMenuKeys(privateBoard)).toEqual(["home", "organize", "share", "edit", "delete"]);
    expect(boardMenuKeys({ ...manager, canManage: false, pinned: false })).toEqual(["home", "organize", "edit"]);
    expect(boardMenuKeys({ ...manager, canEdit: false, canManage: false, pinned: false })).toEqual(["home"]);
    const home = { ...manager, kind: "home" as const, audience: "private" as const, pinned: false };
    expect(boardMenuKeys(home, true)).toEqual(["organize"]);
  });

  test("a workspace being deleted offers no change to a board: only Use on Home, as on the web", () => {
    const manager = { kind: "board" as const, canEdit: true, canManage: true, audience: "workspace" as const };
    const deleting = { deletion: { dueAt: null, requestedAt: null, requestedBy: null } };
    const board = frozenBoard({ ...manager, pinned: false }, deleting);
    expect(board).toMatchObject({ canEdit: false, canManage: false });
    expect(boardMenuKeys(board)).toEqual(["home"]);
    expect(boardMenuKeys(frozenBoard({ ...manager, kind: "home" as const, pinned: false }, deleting), true)).toEqual(
      [],
    );
    expect(frozenBoard({ ...manager, pinned: false }, { deletion: undefined })).toMatchObject({ canEdit: true });
    // The board's screen and the home's strip read it through this, so "+", Share and a card's long press go too.
    const read = (path: string) => readFileSync(join(import.meta.dir, "../../src/features", path), "utf8");
    expect(read("dashboards/hooks.ts")).toContain("board: q.data && frozenBoard(q.data, org)");
    expect(read("chats/HomeWidgets.tsx")).toContain("const board = home.board && frozenBoard(home.board, org);");
  });

  test("Use on Home: any board seen; on Início it offers Remove; My Home brings Início back", () => {
    const viewer = { kind: "board" as const, canEdit: false, canManage: false, audience: "workspace" as const };
    expect(boardMenuKeys({ ...viewer, pinned: false }, true)).toEqual(["unhome"]);
    const home = { ...viewer, kind: "home" as const, canEdit: true, audience: "private" as const, pinned: false };
    expect(boardMenuKeys(home, false)).toEqual(["home", "organize"]);
  });

  test("a new widget's size: the one picked, else S for a number or a goal and M otherwise", () => {
    expect(sizeFor("kpi", null)).toBe("s");
    expect(sizeFor("goal", null)).toBe("s");
    expect(sizeFor("bars", null)).toBe("m");
    expect(sizeFor("kpi", "l")).toBe("l");
    expect(widgetPreview("sales", "kpi", null, words, "l")).toMatchObject({ size: "l", w: 2, h: 2 });
    expect(widgetPreview("sales", "line", null, words)).toMatchObject({ size: "m", w: 2, h: 1 });
  });

  test("a message's charts reach Pin to a dashboard through its draft", () => {
    setPinDraft({ messageId: "m1", agentId: "a1", blocks: ['{"type":"number","title":"Sales","value":3}'] });
    expect(pinDraftNow()?.messageId).toBe("m1");
    setPinDraft(null);
    expect(pinDraftNow()).toBeNull();
  });
});

describe("dashboards in links, notifications and routines", () => {
  test("a board, My Home, a widget, else the Dashboards list", () => {
    expect(boardHref("d1")).toBe("/board/d1");
    expect(boardHref(HOME)).toBe("/board/home");
    expect(boardHref(undefined)).toBe("/dashboards");
    expect(widgetHref("w1")).toBe("/widget/w1");
    expect(widgetHref(undefined, "d1")).toBe("/board/d1");
    expect(widgetHref("../x", null)).toBe("/dashboards");
  });

  test("agenteschat:// links to dashboards and widgets", () => {
    expect(hrefFromUrl("agenteschat://dashboards")).toBe("/dashboards");
    expect(hrefFromUrl("agenteschat://board/d1")).toBe("/board/d1");
    expect(hrefFromUrl("agenteschat://widget/w1")).toBe("/widget/w1");
    expect(hrefFromUrl("agenteschat://board")).toBeNull();
    expect(hrefFromUrl("agenteschat://widget/../x")).toBeNull();
  });

  test("the web's dashboards, a board and a widget open on Home or a board, as the app's screens", () => {
    const to = (path: string) => {
      const link = appLinkFromUrl(`https://app.agentes.chat/org/org-1${path}`);
      const href = link && "href" in link ? link.href : "";
      return new URLSearchParams(href.slice("/link?".length)).get("to");
    };
    expect(to("/dashboards")).toBe("/dashboards");
    expect(to("/dashboards/d1")).toBe("/board/d1");
    expect(to("/dashboards/d1?widget=w1")).toBe("/widget/w1");
    expect(to("/home?widget=w1")).toBe("/widget/w1");
    expect(to("/home")).toBe("/");
    expect(to("/dashboards/..")).toBeNull();
  });

  test("every dashboards target the web opens has a screen on the phone", () => {
    const screen = (target: OpenTarget) => {
      const link = appLinkFromUrl(`https://app.agentes.chat${targetPath("org-1", target)}`);
      const href = link && "href" in link ? link.href : "";
      return new URLSearchParams(href.slice("/link?".length)).get("to");
    };
    expect(screen({ to: "/org/$orgId/home" })).toBe("/");
    expect(screen({ to: "/org/$orgId/home", search: { widget: "w1" } })).toBe("/widget/w1");
    expect(screen({ to: "/org/$orgId/dashboards" })).toBe("/dashboards");
    expect(screen({ to: "/org/$orgId/dashboards/$dashboardId", params: { dashboardId: "d1" } })).toBe("/board/d1");
    expect(
      screen({ to: "/org/$orgId/dashboards/$dashboardId", params: { dashboardId: "d1" }, search: { widget: "w1" } }),
    ).toBe("/widget/w1");
  });

  test("Dashboards is a screen pushed from the home, never a tab; the tab bar stays as it was", () => {
    const app = join(import.meta.dir, "..", "..", "app", "(app)");
    expect(existsSync(join(app, "dashboards.tsx"))).toBe(true);
    expect(existsSync(join(app, "(tabs)", "dashboards"))).toBe(false);
    expect(readFileSync(join(app, "_layout.tsx"), "utf8")).toContain('name="dashboards"');
    expect(readFileSync(join(app, "(tabs)", "_layout.tsx"), "utf8")).not.toContain("dashboards");
    expect([...TAB_GLYPHS]).toEqual(["chats", "threads", "agents", "activity", "search"]);
  });

  test("an alert or a failure opens its widget; a request to publish, its board", () => {
    const source = { dashboardId: "d1", widgetId: "w1", agentId: "a1", label: "Sales" };
    expect(notificationHref(notification({ id: "n1", kind: "widget_alert", source }))).toBe("/widget/w1");
    expect(notificationHref(notification({ id: "n2", kind: "widget_failed", source }))).toBe("/widget/w1");
    expect(notificationHref(notification({ id: "n3", kind: "widget_failed", source: { dashboardId: "d1" } }))).toBe(
      "/board/d1",
    );
    expect(notificationHref(notification({ id: "n4", kind: "dashboard_proposal", source }))).toBe("/board/d1");
  });

  test("a push for a widget carries its ids and opens it", () => {
    const push = { kind: "widget_alert", dashboardId: "d1", widgetId: "w1", agentId: "a1" };
    expect(pushAsNotification(push).source).toMatchObject({ dashboardId: "d1", widgetId: "w1" });
    expect(hrefForPush(push)).toBe("/widget/w1");
    expect(hrefForPush({ kind: "dashboard_proposal", dashboardId: "d1" })).toBe("/board/d1");
  });

  test("a widget's routine: its widget's title and a chart", () => {
    const widget = { id: "w1", dashboardId: "d1", title: "Sales today" };
    expect(routineTitle({ name: "Refresh Sales today", prompt: "", widget })).toBe("Sales today");
    expect(routineTitle({ name: "Daily report", prompt: "", widget: null })).toBe("Daily report");
    expect(targetIcon({ type: "widget", widgetId: "w1", dashboardId: "d1" })).toBe("chart");
  });
});

describe("the widget card", () => {
  test("a soft surface: the raised white on the light board, 78% of the raised tone over the dark one", () => {
    expect(softCardColor("#ffffff", "#f2f2f7", false)).toBe("#ffffff");
    expect(softCardColor("#1c1c1b", "#0f0f0e", true)).toBe(mixHex("#1c1c1b", "#0f0f0e", 0.78));
    expect(mixHex("#ffffff", "#000000", 0.5)).toBe("#808080");
    expect(mixHex("#1c1c1b", "#0f0f0e", 1)).toBe("#1c1c1b");
    // Not a hex color: the first one back.
    expect(mixHex("red", "#000000", 0.5)).toBe("red");
  });

  test("a number's trend and a bare line run along the card's bottom; a line with labels or a note doesn't", () => {
    expect(bleedSeries({ kind: "kpi", value: 3, spark: [1, 2, 3] }, false)).toEqual([1, 2, 3]);
    expect(bleedSeries({ kind: "kpi", value: 3, spark: [1, 2, 3] }, true)).toEqual([1, 2, 3]);
    expect(bleedSeries({ kind: "kpi", value: 3, spark: [1] }, false)).toBeNull();
    expect(bleedSeries({ kind: "kpi", value: 3 }, false)).toBeNull();
    const line = { kind: "line" as const, labels: ["a", "b"], values: [1, 2] };
    expect(bleedSeries(line, false)).toEqual([1, 2]);
    expect(bleedSeries(line, true)).toBeNull();
    expect(bleedSeries({ ...line, note: "up" }, false)).toBeNull();
    expect(bleedSeries({ kind: "bars", labels: ["a"], values: [1] }, false)).toBeNull();
    expect(bleedSeries(null, false)).toBeNull();
  });

  test("the edge-to-edge line starts at the left edge, leaves room for its square and for the fade", () => {
    const points = bleedPoints([0, 5, 10], 206, 50);
    expect(points[0]?.[0]).toBe(0);
    expect(points[2]?.[0]).toBe(200);
    // The highest value at the top padding, the lowest at 62% of the height.
    expect(points[2]?.[1]).toBe(6);
    expect(points[0]?.[1]).toBe(31);
    expect(points.every(([, y]) => y >= 6 && y <= 31)).toBe(true);
    // A flat series sits low, all on one line.
    const flat = bleedPoints([4, 4], 100, 50);
    expect(flat[0]?.[1]).toBe(flat[1]?.[1]);
    expect(bleedPoints([], 100, 50)).toEqual([]);
    expect(bleedPoints([1, 2], 0, 50)).toEqual([]);
  });

  test("a bar's value is only the number, whole when it fits, else short; never cut", () => {
    expect(barValueText(48, "en", 40)).toBe("48");
    expect(barValueText(18420, "en", 60)).toBe("18,420");
    expect(barValueText(18420, "en", 30)).toBe("18.4K");
    expect(barValueText(1250000, "en", 20)).toBe("1.3M");
    expect(barValueText(48, "en", 30)).not.toContain("…");
  });
});

describe("New widget: the card is the form", () => {
  test("the ask is a field before the first test and while it's edited; else a folded line", () => {
    expect(asksInCard("untested", false)).toBe(true);
    expect(asksInCard("ok", false)).toBe(false);
    expect(asksInCard("stale", false)).toBe(false);
    expect(asksInCard("failed", false)).toBe(false);
    expect(asksInCard("testing", false)).toBe(false);
    expect(asksInCard("ok", true)).toBe(true);
  });

  test("the bar says Create after a good test, Test again after a stale or failed one, else Test", () => {
    expect(newWidgetBarLabel("ok")).toBe("create");
    expect(newWidgetBarLabel("stale")).toBe("testAgain");
    expect(newWidgetBarLabel("failed")).toBe("testAgain");
    expect(newWidgetBarLabel("untested")).toBe("test");
    expect(newWidgetBarLabel("testing")).toBe("test");
  });
});

describe("Who looks after it", () => {
  const agents = [
    { id: "a1", name: "Theo", role: "Sales analyst" },
    { id: "a2", name: "Nina", role: "Atendimento" },
    { id: "a3", name: "Lia", role: null },
  ];

  test("a search keeps agents by name or role, accents and case aside, in their order", () => {
    expect(agentsMatching(agents, "").map((a) => a.id)).toEqual(["a1", "a2", "a3"]);
    expect(agentsMatching(agents, "  ").map((a) => a.id)).toEqual(["a1", "a2", "a3"]);
    expect(agentsMatching(agents, "THEO").map((a) => a.id)).toEqual(["a1"]);
    expect(agentsMatching(agents, "sales").map((a) => a.id)).toEqual(["a1"]);
    expect(agentsMatching(agents, "atendímento").map((a) => a.id)).toEqual(["a2"]);
    expect(agentsMatching(agents, "zzz")).toEqual([]);
  });

  test("the search shows only past a handful of agents", () => {
    expect(AGENT_SEARCH_FROM).toBeGreaterThan(6);
  });

  test("the picked agent goes back to the card at once, and nothing goes back once it closed", () => {
    const applied: string[] = [];
    openAgentPick({ agentId: "a1", apply: (id) => applied.push(id) });
    chooseAgent("a2");
    expect(applied).toEqual(["a2"]);
    expect(agentPickNow()?.agentId).toBe("a2");
    closeAgentPick();
    chooseAgent("a3");
    expect(applied).toEqual(["a2"]);
    expect(agentPickNow()).toBeNull();
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { orgTopic, type RealtimeEvent, userTopic } from "@agenteschat/adapters";
import { and, eq, schema, sql } from "@agenteschat/db";
import { DASHBOARDS_MAX, WIDGET_SCHEDULED_MAX, WIDGETS_PER_DASHBOARD_MAX } from "@agenteschat/ui/widgets/spec";
import {
  assertScheduledRoom,
  createDashboard,
  createRole,
  createWidget,
  type DashboardDeps,
  DEFAULT_HOME_TILES,
  dashboardRights,
  dashboardViewerCount,
  deleteDashboard,
  deleteRole,
  getDashboard,
  getOrCreateHome,
  getWidget,
  insertDashboard,
  listDashboards,
  removeMember,
  removeWidget,
  requireDashboard,
  saveDashboardLayout,
  setDashboardAudience,
  setHomeDashboard,
  setMemberRoles,
  shareDashboard,
  updateDashboard,
  updateWidget,
  widensDashboardAudience,
  widgetHistory,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
let deps: DashboardDeps;
beforeEach(async () => {
  f = await setup();
  deps = { db: f.db, pubsub: f.pubsub, context: f.context };
});
afterEach(() => f.close());

const role = (name: string) => createRole(f.db, f.owner.id, f.org.id, { name });

const board = (actorId: string, over: Partial<Parameters<typeof createDashboard>[3]> = {}) =>
  createDashboard(deps, actorId, f.org.id, { title: "Sales", audience: "workspace", editPolicy: "owner", ...over });

/** A widget row written directly: no routine, no first build (what the refresh stage does is tested apart). */
async function widgetRow(dashboardId: string, over: Partial<typeof schema.dashboardWidgets.$inferInsert> = {}) {
  const [row] = await f.db
    .insert(schema.dashboardWidgets)
    .values({
      orgId: f.org.id,
      dashboardId,
      agentId: f.agent.id,
      title: "Revenue today",
      status: "ok",
      kind: "kpi",
      format: "kpi",
      spec: { kind: "kpi", value: 18420, prefix: "R$" },
      ...over,
    })
    .returning();
  if (!row) throw new Error("widget insert failed");
  return row;
}

const titles = async (userId: string) =>
  (await listDashboards(deps, userId, f.org.id)).dashboards.map((d) => d.title).sort();

describe("who sees a board (ADR 0135 §8)", () => {
  test("a workspace board: every member sees it; with `owner` only its owner and admins edit", async () => {
    const nina = await addMember(f.db, f.org.id, "member", "nina");
    const theo = await addMember(f.db, f.org.id, "member", "theo");
    const lia = await addMember(f.db, f.org.id, "admin", "lia");
    const made = await board(nina.id);
    expect(made).toMatchObject({ audience: "workspace", mine: true, canEdit: true, canManage: true });
    expect(made.owner).toEqual({ kind: "person", id: nina.id, name: "nina" });

    const seen = await getDashboard(deps, theo.id, f.org.id, made.id);
    expect(seen).toMatchObject({ mine: false, canEdit: false, canManage: false });
    expect((await getDashboard(deps, lia.id, f.org.id, made.id)).canManage).toBe(true);
    await expect(requireDashboard(f.db, theo.id, f.org.id, made.id, "edit")).rejects.toMatchObject({
      code: "dashboard.forbidden",
    });
    await expect(updateDashboard(deps, theo.id, f.org.id, made.id, { title: "Mine now" })).rejects.toMatchObject({
      code: "dashboard.forbidden",
    });
    expect(await titles(theo.id)).toEqual(["Sales"]);
  });

  test("`viewers`: whoever sees it edits it, but only its owner and admins pin, share or delete it", async () => {
    const nina = await addMember(f.db, f.org.id, "member", "nina");
    const theo = await addMember(f.db, f.org.id, "member", "theo");
    const made = await board(nina.id, { editPolicy: "viewers" });
    const renamed = await updateDashboard(deps, theo.id, f.org.id, made.id, { title: "  Sales\n today ", about: "x" });
    expect(renamed).toMatchObject({ title: "Sales today", about: "x", canEdit: true, canManage: false });
    await expect(updateDashboard(deps, theo.id, f.org.id, made.id, { pinned: true })).rejects.toMatchObject({
      code: "dashboard.forbidden",
    });
    await expect(
      shareDashboard(deps, theo.id, f.org.id, made.id, { audience: "private", roleIds: [], editPolicy: "owner" }),
    ).rejects.toMatchObject({ code: "dashboard.forbidden" });
    await expect(deleteDashboard(deps, theo.id, f.org.id, made.id)).rejects.toMatchObject({
      code: "dashboard.forbidden",
    });
  });

  test("a roles board: its people and admins see it, the rest get a 404; losing the role hides it", async () => {
    const sales = await role("Sales");
    const nina = await addMember(f.db, f.org.id, "member", "nina");
    const theo = await addMember(f.db, f.org.id, "member", "theo");
    const lia = await addMember(f.db, f.org.id, "admin", "lia");
    await setMemberRoles(f.db, f.owner.id, f.org.id, theo.id, [sales.id]);
    const made = await board(nina.id, { title: "Pipeline", audience: "roles", roleIds: [sales.id] });
    expect(made.roleIds).toEqual([sales.id]);

    expect(await titles(theo.id)).toEqual(["Pipeline"]);
    expect(await titles(lia.id)).toEqual(["Pipeline"]);
    expect(await titles(nina.id)).toEqual(["Pipeline"]);
    const outsider = await addMember(f.db, f.org.id, "member", "bia");
    expect(await titles(outsider.id)).toEqual([]);
    await expect(getDashboard(deps, outsider.id, f.org.id, made.id)).rejects.toMatchObject({
      code: "dashboard.not_found",
    });

    // Their roles are read at the time: without the role, the board is gone for them.
    await setMemberRoles(f.db, f.owner.id, f.org.id, theo.id, []);
    expect(await titles(theo.id)).toEqual([]);
    await expect(getDashboard(deps, theo.id, f.org.id, made.id)).rejects.toMatchObject({
      code: "dashboard.not_found",
    });
  });

  test("a private board is its owner's alone, admins included", async () => {
    const nina = await addMember(f.db, f.org.id, "member", "nina");
    const lia = await addMember(f.db, f.org.id, "admin", "lia");
    const made = await board(nina.id, { title: "Mine", audience: "private" });
    expect(made.viewerCount).toBe(1);
    expect(await titles(nina.id)).toEqual(["Mine"]);
    expect(await titles(lia.id)).toEqual([]);
    expect(await titles(f.owner.id)).toEqual([]);
    await expect(getDashboard(deps, lia.id, f.org.id, made.id)).rejects.toMatchObject({ code: "dashboard.not_found" });
    await expect(getDashboard(deps, f.owner.id, f.org.id, made.id)).rejects.toMatchObject({
      code: "dashboard.not_found",
    });
  });

  test("the rule on the row alone", () => {
    const row = {
      kind: "board",
      audience: "roles",
      audienceRoleIds: ["r1"],
      editPolicy: "owner",
      editRoleIds: [] as string[],
      ownerUserId: "u-nina",
      deletedAt: null,
    } satisfies Parameters<typeof dashboardRights>[0];
    const viewer = (over: Partial<Parameters<typeof dashboardRights>[1]> = {}) => ({
      userId: "u-theo",
      roleIds: [] as string[],
      admin: false,
      mayPublish: true,
      ...over,
    });
    expect(dashboardRights(row, viewer())).toEqual({ see: false, edit: false, manage: false });
    expect(dashboardRights(row, viewer({ roleIds: ["r1"] }))).toEqual({ see: true, edit: false, manage: false });
    expect(dashboardRights(row, viewer({ admin: true }))).toEqual({ see: true, edit: true, manage: true });
    expect(dashboardRights(row, viewer({ userId: "u-nina" }))).toEqual({ see: true, edit: true, manage: true });
    expect(dashboardRights({ ...row, editPolicy: "viewers" }, viewer({ roleIds: ["r1"] })).edit).toBe(true);
    // Edit roles: who sees it and holds one edits; one who only holds it, without seeing, gets nothing.
    const byRoles = { ...row, audienceRoleIds: ["r1", "r2"], editPolicy: "roles", editRoleIds: ["r2", "r3"] };
    expect(dashboardRights(byRoles, viewer({ roleIds: ["r2"] }))).toEqual({ see: true, edit: true, manage: false });
    expect(dashboardRights(byRoles, viewer({ roleIds: ["r1"] }))).toEqual({ see: true, edit: false, manage: false });
    expect(dashboardRights(byRoles, viewer({ roleIds: ["r3"] }))).toEqual({ see: false, edit: false, manage: false });
    expect(dashboardRights({ ...byRoles, audience: "workspace" }, viewer({ roleIds: ["r3"] })).edit).toBe(true);
    expect(dashboardRights({ ...row, deletedAt: new Date() }, viewer({ userId: "u-nina" })).see).toBe(false);
    // A role board with no role left: its owner and admins.
    expect(dashboardRights({ ...row, audienceRoleIds: [] }, viewer({ roleIds: ["r1"] })).see).toBe(false);
    // Home: its owner alone, admins too are out.
    const home = { ...row, kind: "home", audience: "private" };
    expect(dashboardRights(home, viewer({ admin: true })).see).toBe(false);
    expect(dashboardRights(home, viewer({ userId: "u-nina" }))).toEqual({ see: true, edit: true, manage: true });
  });

  test("who sees it is counted: everyone, or the role's people with its owner and admins", async () => {
    const sales = await role("Sales");
    const nina = await addMember(f.db, f.org.id, "member", "nina");
    const theo = await addMember(f.db, f.org.id, "member", "theo");
    await addMember(f.db, f.org.id, "admin", "lia");
    await addMember(f.db, f.org.id, "member", "bia");
    await setMemberRoles(f.db, f.owner.id, f.org.id, theo.id, [sales.id]);
    const wide = await board(nina.id);
    const narrow = await board(nina.id, { title: "Pipeline", audience: "roles", roleIds: [sales.id] });
    // ana (owner), nina, theo, lia, bia.
    expect(wide.viewerCount).toBe(5);
    // nina (owner), theo (role), ana and lia (admins).
    expect(narrow.viewerCount).toBe(4);
    const list = await listDashboards(deps, nina.id, f.org.id);
    expect(Object.fromEntries(list.dashboards.map((d) => [d.title, d.viewerCount]))).toEqual({ Sales: 5, Pipeline: 4 });
    const [row] = await f.db.select().from(schema.dashboards).where(eq(schema.dashboards.id, narrow.id));
    if (!row) throw new Error("no board");
    expect(await dashboardViewerCount(f.db, row)).toBe(4);
  });

  test("widening is what needs `post`: private to anything, roles to workspace, a new role", () => {
    const at = (audience: string, roleIds: string[] = []) => ({ audience, roleIds });
    expect(widensDashboardAudience(at("private"), at("roles", ["a"]))).toBe(true);
    expect(widensDashboardAudience(at("roles", ["a"]), at("workspace"))).toBe(true);
    expect(widensDashboardAudience(at("roles", ["a"]), at("roles", ["a", "b"]))).toBe(true);
    expect(widensDashboardAudience(at("roles", ["a", "b"]), at("roles", ["a"]))).toBe(false);
    expect(widensDashboardAudience(at("workspace"), at("roles", ["a"]))).toBe(false);
    expect(widensDashboardAudience(at("roles", ["a"]), at("private"))).toBe(false);
  });
});

describe("boards", () => {
  test("showing a board to others needs `post`; a private one only membership", async () => {
    const nina = await addMember(f.db, f.org.id, "member", "nina");
    await f.db
      .update(schema.orgRoles)
      .set({ permissions: sql`array_remove(${schema.orgRoles.permissions}, 'post')` })
      .where(and(eq(schema.orgRoles.orgId, f.org.id), eq(schema.orgRoles.kind, "everyone")));
    await expect(board(nina.id)).rejects.toMatchObject({ code: "dashboard.publish_forbidden" });
    const mine = await board(nina.id, { audience: "private" });
    await expect(
      shareDashboard(deps, nina.id, f.org.id, mine.id, { audience: "workspace", roleIds: [], editPolicy: "owner" }),
    ).rejects.toMatchObject({ code: "dashboard.publish_forbidden" });
  });

  test("a roles board takes 1 to 100 of the workspace's own roles", async () => {
    await expect(board(f.owner.id, { audience: "roles", roleIds: [] })).rejects.toMatchObject({
      code: "dashboard.roles_required",
    });
    await expect(
      board(f.owner.id, { audience: "roles", roleIds: ["00000000-0000-4000-8000-000000000000"] }),
    ).rejects.toMatchObject({ code: "dashboard.role_unknown" });
    await expect(board(f.owner.id, { audience: "roles", roleIds: ["not-a-uuid"] })).rejects.toMatchObject({
      code: "dashboard.role_unknown",
    });
    await expect(board(f.owner.id, { title: "   " })).rejects.toMatchObject({ code: "dashboard.title_required" });
    // Roles only count for `roles`.
    const sales = await role("Sales");
    expect((await board(f.owner.id, { roleIds: [sales.id] })).roleIds).toEqual([]);
  });

  test("a workspace keeps at most DASHBOARDS_MAX boards; home boards don't count", async () => {
    await f.db.insert(schema.dashboards).values(
      Array.from({ length: DASHBOARDS_MAX - 1 }, (_, i) => ({
        orgId: f.org.id,
        title: `Board ${i}`,
        ownerUserId: f.owner.id,
      })),
    );
    await getOrCreateHome(deps, f.owner.id, f.org.id);
    await board(f.owner.id, { title: "Last one" });
    await expect(board(f.owner.id, { title: "One too many" })).rejects.toMatchObject({
      code: "dashboard.too_many",
      params: { max: DASHBOARDS_MAX },
    });
  });

  test("the list: pinned first, then by position and title; the home apart", async () => {
    const a = await board(f.owner.id, { title: "Alpha" });
    await board(f.owner.id, { title: "Beta" });
    const c = await board(f.owner.id, { title: "Gamma" });
    await updateDashboard(deps, f.owner.id, f.org.id, c.id, { pinned: true });
    let list = await listDashboards(deps, f.owner.id, f.org.id);
    expect(list.home).toBeNull();
    expect(list.dashboards.map((d) => d.title)).toEqual(["Gamma", "Alpha", "Beta"]);
    await getOrCreateHome(deps, f.owner.id, f.org.id);
    list = await listDashboards(deps, f.owner.id, f.org.id);
    expect(list.home?.kind).toBe("home");
    expect(list.dashboards.map((d) => d.title)).toEqual(["Gamma", "Alpha", "Beta"]);
    expect(list.dashboards[1]?.id).toBe(a.id);
  });

  test("share: wider and back; it drops an agent's pending request and tells everyone", async () => {
    const nina = await addMember(f.db, f.org.id, "member", "nina");
    const theo = await addMember(f.db, f.org.id, "member", "theo");
    const org: RealtimeEvent[] = [];
    f.pubsub.subscribe(orgTopic(f.org.id), (e) => org.push(e));
    const made = await board(nina.id, { audience: "private" });
    await f.db
      .update(schema.dashboards)
      .set({
        proposal: {
          audience: "workspace",
          roleIds: [],
          agentId: f.agent.id,
          runId: null,
          why: "The team asked",
          at: new Date().toISOString(),
        },
      })
      .where(eq(schema.dashboards.id, made.id));
    const mine = await getDashboard(deps, nina.id, f.org.id, made.id);
    expect(mine.proposal).toMatchObject({ audience: "workspace", agentId: f.agent.id, canDecide: true });

    const shared = await shareDashboard(deps, nina.id, f.org.id, made.id, {
      audience: "workspace",
      roleIds: [],
      editPolicy: "viewers",
    });
    expect(shared).toMatchObject({ audience: "workspace", editPolicy: "viewers", proposal: null });
    expect(await titles(theo.id)).toEqual(["Sales"]);
    expect(org.some((e) => e.type === "org.broadcast")).toBe(true);

    await shareDashboard(deps, nina.id, f.org.id, made.id, { audience: "private", roleIds: [], editPolicy: "owner" });
    expect(await titles(theo.id)).toEqual([]);
  });

  test("delete: gone from every list and page; only its owner and admins", async () => {
    const nina = await addMember(f.db, f.org.id, "member", "nina");
    const lia = await addMember(f.db, f.org.id, "admin", "lia");
    const made = await board(nina.id);
    await widgetRow(made.id);
    await deleteDashboard(deps, lia.id, f.org.id, made.id);
    expect(await titles(nina.id)).toEqual([]);
    await expect(getDashboard(deps, nina.id, f.org.id, made.id)).rejects.toMatchObject({
      code: "dashboard.not_found",
    });
    const [row] = await f.db.select().from(schema.dashboards).where(eq(schema.dashboards.id, made.id));
    expect(row?.deletedAt).not.toBeNull();
  });

  test("a private board's changes go to its owner only; a shared one's to the workspace", async () => {
    const nina = await addMember(f.db, f.org.id, "member", "nina");
    const own: RealtimeEvent[] = [];
    const org: RealtimeEvent[] = [];
    f.pubsub.subscribe(userTopic(f.org.id, nina.id), (e) => own.push(e));
    f.pubsub.subscribe(orgTopic(f.org.id), (e) => org.push(e));
    const made = await board(nina.id, { audience: "private" });
    expect(own).toContainEqual({ type: "dashboard.changed", orgId: f.org.id, dashboardId: made.id });
    expect(org).toEqual([]);
    await board(nina.id, { title: "Team" });
    expect(org).toHaveLength(1);
  });

  test("an agent's board is private, owned by the person it is for and shown as the agent's", async () => {
    const nina = await addMember(f.db, f.org.id, "member", "nina");
    const runId = crypto.randomUUID();
    const row = await insertDashboard(
      deps,
      f.org.id,
      { agentId: f.agent.id, runId, personId: nina.id, accountableUserId: nina.id },
      { title: "Black Friday" },
    );
    expect(row).toMatchObject({ audience: "private", ownerUserId: nina.id, ownerAgentId: f.agent.id });
    const view = await getDashboard(deps, nina.id, f.org.id, row.id);
    expect(view.owner).toEqual({ kind: "agent", id: f.agent.id, name: "Dev" });
    expect(view.mine).toBe(true);
    // A decision opens it to the workspace (no check here: the caller decided).
    await setDashboardAudience(deps, row, "workspace", []);
    expect((await getDashboard(deps, f.owner.id, f.org.id, row.id)).audience).toBe("workspace");
  });

  test("who edits by roles: the roles' people who see it edit; checked like the audience's roles", async () => {
    const sales = await role("Sales");
    const boardRole = await role("Board");
    const nina = await addMember(f.db, f.org.id, "member", "nina");
    const theo = await addMember(f.db, f.org.id, "member", "theo");
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await setMemberRoles(f.db, f.owner.id, f.org.id, theo.id, [sales.id]);
    await setMemberRoles(f.db, f.owner.id, f.org.id, bia.id, [boardRole.id]);
    const made = await board(nina.id, { title: "Pipeline", editPolicy: "roles", editRoleIds: [sales.id] });
    expect(made).toMatchObject({ editPolicy: "roles", editRoleIds: [sales.id] });
    expect((await getDashboard(deps, theo.id, f.org.id, made.id)).canEdit).toBe(true);
    expect((await getDashboard(deps, bia.id, f.org.id, made.id)).canEdit).toBe(false);
    await updateDashboard(deps, theo.id, f.org.id, made.id, { about: "By Sales" });
    await expect(updateDashboard(deps, bia.id, f.org.id, made.id, { about: "x" })).rejects.toMatchObject({
      code: "dashboard.forbidden",
    });
    // Editing isn't seeing: shown only to Board, Sales' people don't see it, so they edit nothing.
    const shared = await shareDashboard(deps, nina.id, f.org.id, made.id, {
      audience: "roles",
      roleIds: [boardRole.id],
      editPolicy: "roles",
      editRoleIds: [sales.id, boardRole.id],
    });
    expect(shared.editRoleIds.sort()).toEqual([sales.id, boardRole.id].sort());
    await expect(getDashboard(deps, theo.id, f.org.id, made.id)).rejects.toMatchObject({
      code: "dashboard.not_found",
    });
    expect((await getDashboard(deps, bia.id, f.org.id, made.id)).canEdit).toBe(true);
    // Another policy keeps no roles.
    const owner = await shareDashboard(deps, nina.id, f.org.id, made.id, {
      audience: "workspace",
      roleIds: [],
      editPolicy: "owner",
      editRoleIds: [sales.id],
    });
    expect(owner).toMatchObject({ editPolicy: "owner", editRoleIds: [] });
    // `roles` needs a role of the workspace.
    await expect(board(nina.id, { title: "None", editPolicy: "roles", editRoleIds: [] })).rejects.toMatchObject({
      code: "dashboard.roles_required",
    });
    await expect(
      board(nina.id, { title: "Unknown", editPolicy: "roles", editRoleIds: [crypto.randomUUID()] }),
    ).rejects.toMatchObject({ code: "dashboard.role_unknown" });
  });

  test("a deleted role leaves who edits; with none left, its owner and admins edit", async () => {
    const sales = await role("Sales");
    const ops = await role("Ops");
    const nina = await addMember(f.db, f.org.id, "member", "nina");
    const two = await board(nina.id, { title: "Two", editPolicy: "roles", editRoleIds: [sales.id, ops.id] });
    const one = await board(nina.id, { title: "One", editPolicy: "roles", editRoleIds: [sales.id] });
    await deleteRole(f.db, f.owner.id, f.org.id, sales.id);
    const rows = await f.db.select().from(schema.dashboards).where(eq(schema.dashboards.orgId, f.org.id));
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(two.id)).toMatchObject({ editPolicy: "roles", editRoleIds: [ops.id] });
    expect(byId.get(one.id)).toMatchObject({ editPolicy: "owner", editRoleIds: [] });
  });
});

describe("My Home (ADR 0135 §9)", () => {
  test("made once on first use, private, with the fixed tiles; nobody else sees it", async () => {
    const nina = await addMember(f.db, f.org.id, "member", "nina");
    const lia = await addMember(f.db, f.org.id, "admin", "lia");
    const [first, second] = await Promise.all([
      getOrCreateHome(deps, nina.id, f.org.id),
      getOrCreateHome(deps, nina.id, f.org.id),
    ]);
    expect(first.id).toBe(second.id);
    expect(first).toMatchObject({ kind: "home", title: "", audience: "private", mine: true, canEdit: true });
    expect(first.tiles).toEqual(DEFAULT_HOME_TILES.map((t) => ({ ...t })));
    const rows = await f.db
      .select()
      .from(schema.dashboards)
      .where(and(eq(schema.dashboards.orgId, f.org.id), eq(schema.dashboards.kind, "home")));
    expect(rows).toHaveLength(1);
    await expect(getDashboard(deps, lia.id, f.org.id, first.id)).rejects.toMatchObject({
      code: "dashboard.not_found",
    });
    expect((await listDashboards(deps, lia.id, f.org.id)).home).toBeNull();
  });

  test("never shared, renamed, pinned or deleted; its tiles move with Organize", async () => {
    const home = await getOrCreateHome(deps, f.owner.id, f.org.id);
    await expect(
      shareDashboard(deps, f.owner.id, f.org.id, home.id, { audience: "workspace", roleIds: [], editPolicy: "owner" }),
    ).rejects.toMatchObject({ code: "dashboard.home_fixed" });
    await expect(updateDashboard(deps, f.owner.id, f.org.id, home.id, { title: "Mine" })).rejects.toMatchObject({
      code: "dashboard.home_fixed",
    });
    await expect(updateDashboard(deps, f.owner.id, f.org.id, home.id, { pinned: true })).rejects.toMatchObject({
      code: "dashboard.home_fixed",
    });
    await expect(deleteDashboard(deps, f.owner.id, f.org.id, home.id)).rejects.toMatchObject({
      code: "dashboard.home_fixed",
    });
    const w = await widgetRow(home.id, { position: 1 });
    const saved = await saveDashboardLayout(deps, f.owner.id, f.org.id, home.id, {
      widgets: [{ id: w.id, position: 0, w: 2, h: 2 }],
      tiles: [
        { key: "waiting", position: 1, w: 1, h: 1 },
        { key: "working", position: 2, w: 2, h: 1 },
      ],
    });
    expect(saved.tiles).toEqual([
      { key: "waiting", position: 1, w: 1, h: 1 },
      { key: "working", position: 2, w: 2, h: 1 },
    ]);
    expect(saved.widgets[0]?.layout).toEqual({ position: 0, w: 2, h: 2 });
  });
});

describe("a board on Início (ADR 0135 §18)", () => {
  test("any board the person sees, for them only; null is their own home again", async () => {
    const nina = await addMember(f.db, f.org.id, "member", "nina");
    const sales = await board(f.owner.id);
    expect((await listDashboards(deps, nina.id, f.org.id)).homeDashboardId).toBeNull();
    expect(await setHomeDashboard(deps, nina.id, f.org.id, sales.id)).toEqual({ homeDashboardId: sales.id });
    expect((await listDashboards(deps, nina.id, f.org.id)).homeDashboardId).toBe(sales.id);
    expect((await listDashboards(deps, f.owner.id, f.org.id)).homeDashboardId).toBeNull();
    await setHomeDashboard(deps, nina.id, f.org.id, null);
    expect((await listDashboards(deps, nina.id, f.org.id)).homeDashboardId).toBeNull();
  });

  test("never a board they can't see, nor a home board", async () => {
    const nina = await addMember(f.db, f.org.id, "member", "nina");
    const mine = await board(f.owner.id, { audience: "private" });
    await expect(setHomeDashboard(deps, nina.id, f.org.id, mine.id)).rejects.toMatchObject({
      code: "dashboard.not_found",
    });
    const home = await getOrCreateHome(deps, nina.id, f.org.id);
    await expect(setHomeDashboard(deps, nina.id, f.org.id, home.id)).rejects.toMatchObject({
      code: "dashboard.home_fixed",
    });
  });

  test("a board deleted or no longer shown to them falls back to their own home", async () => {
    const nina = await addMember(f.db, f.org.id, "member", "nina");
    const sales = await board(f.owner.id);
    const ops = await board(f.owner.id, { title: "Ops" });
    await setHomeDashboard(deps, nina.id, f.org.id, sales.id);
    await deleteDashboard(deps, f.owner.id, f.org.id, sales.id);
    expect((await listDashboards(deps, nina.id, f.org.id)).homeDashboardId).toBeNull();
    await setHomeDashboard(deps, nina.id, f.org.id, ops.id);
    await shareDashboard(deps, f.owner.id, f.org.id, ops.id, { audience: "private", roleIds: [], editPolicy: "owner" });
    expect((await listDashboards(deps, nina.id, f.org.id)).homeDashboardId).toBeNull();
  });
});

describe("layout", () => {
  test("Organize saves order and sizes; only this board's widgets, sizes of 1 or 2, tiles only at home", async () => {
    const made = await board(f.owner.id);
    const a = await widgetRow(made.id, { title: "A", position: 0 });
    const b = await widgetRow(made.id, { title: "B", position: 1 });
    const saved = await saveDashboardLayout(deps, f.owner.id, f.org.id, made.id, {
      widgets: [
        { id: a.id, position: 1, w: 2, h: 1 },
        { id: b.id, position: 0, w: 1, h: 2 },
      ],
    });
    expect(saved.widgets.map((w) => [w.title, w.layout])).toEqual([
      ["B", { position: 0, w: 1, h: 2 }],
      ["A", { position: 1, w: 2, h: 1 }],
    ]);
    const other = await board(f.owner.id, { title: "Other" });
    const stranger = await widgetRow(other.id);
    await expect(
      saveDashboardLayout(deps, f.owner.id, f.org.id, made.id, {
        widgets: [{ id: stranger.id, position: 0, w: 1, h: 1 }],
      }),
    ).rejects.toMatchObject({ code: "widget.not_found" });
    await expect(
      saveDashboardLayout(deps, f.owner.id, f.org.id, made.id, {
        widgets: [{ id: a.id, position: 0, w: 3 as 1, h: 1 }],
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      saveDashboardLayout(deps, f.owner.id, f.org.id, made.id, {
        widgets: [],
        tiles: [{ key: "waiting", position: 0, w: 1, h: 1 }],
      }),
    ).rejects.toMatchObject({ code: "dashboard.home_fixed" });
  });

  test("someone who only sees it can't organize it", async () => {
    const nina = await addMember(f.db, f.org.id, "member", "nina");
    const made = await board(f.owner.id);
    const a = await widgetRow(made.id);
    await expect(
      saveDashboardLayout(deps, nina.id, f.org.id, made.id, { widgets: [{ id: a.id, position: 0, w: 1, h: 1 }] }),
    ).rejects.toMatchObject({ code: "dashboard.forbidden" });
  });
});

describe("widgets", () => {
  test("+ Widget: the agent builds it, untitled until it names it; the alert is for who set it", async () => {
    const made = await board(f.owner.id);
    const prompt = "Today's sales compared with yesterday at the same hour, from the store's orders";
    const view = await createWidget(deps, f.owner.id, f.org.id, made.id, {
      agentId: f.agent.id,
      prompt,
      format: "auto",
      schedule: "manual",
      alert: { enabled: true, condition: "drops 20% below yesterday" },
    });
    expect(view).toMatchObject({
      dashboardId: made.id,
      agentId: f.agent.id,
      title: "",
      prompt,
      format: "auto",
      kind: null,
      spec: null,
      schedule: "manual",
      alert: { enabled: true, condition: "drops 20% below yesterday" },
      layout: { position: 0, w: 2, h: 1 },
      createdBy: { kind: "person", id: f.owner.id },
    });
    expect(["building", "updating"]).toContain(view.status);
    const [row] = await f.db.select().from(schema.dashboardWidgets).where(eq(schema.dashboardWidgets.id, view.id));
    expect(row?.alertUserId).toBe(f.owner.id);
  });

  test("+ Widget refuses: no ask, an agent the person can't talk to, an archived one", async () => {
    const nina = await addMember(f.db, f.org.id, "member", "nina");
    const made = await board(nina.id, { editPolicy: "viewers" });
    const input = { agentId: f.agent.id, prompt: "Open tickets", format: "auto" as const, schedule: "manual" as const };
    await expect(createWidget(deps, nina.id, f.org.id, made.id, { ...input, prompt: "  " })).rejects.toMatchObject({
      code: "widget.prompt_required",
    });
    await f.db.update(schema.agents).set({ audienceMode: "owner" }).where(eq(schema.agents.id, f.agent.id));
    await expect(createWidget(deps, nina.id, f.org.id, made.id, input)).rejects.toMatchObject({
      code: "widget.agent_unreachable",
    });
    await f.db
      .update(schema.agents)
      .set({ audienceMode: "everyone", archivedAt: new Date() })
      .where(eq(schema.agents.id, f.agent.id));
    await expect(createWidget(deps, nina.id, f.org.id, made.id, input)).rejects.toMatchObject({
      code: "widget.agent_archived",
    });
  });

  test("a board holds at most WIDGETS_PER_DASHBOARD_MAX widgets", async () => {
    const made = await board(f.owner.id);
    for (let i = 0; i < WIDGETS_PER_DASHBOARD_MAX; i++) await widgetRow(made.id, { position: i });
    await expect(
      createWidget(deps, f.owner.id, f.org.id, made.id, {
        agentId: f.agent.id,
        prompt: "One more",
        format: "kpi",
        schedule: "manual",
      }),
    ).rejects.toMatchObject({ code: "widget.too_many", params: { max: WIDGETS_PER_DASHBOARD_MAX } });
  });

  test("at most WIDGET_SCHEDULED_MAX scheduled widgets; manual ones and deleted boards don't count", async () => {
    const boards: { id: string }[] = [];
    for (let i = 0; i < 3; i++) boards.push(await board(f.owner.id, { title: `B${i}` }));
    let n = 0;
    for (const b of boards) {
      for (let i = 0; i < WIDGETS_PER_DASHBOARD_MAX && n < WIDGET_SCHEDULED_MAX; i++, n++) {
        await widgetRow(b.id, { schedule: "hour", position: i });
      }
    }
    const spare = await board(f.owner.id, { title: "Spare" });
    const manual = await widgetRow(spare.id, { schedule: "manual" });
    const ask = { agentId: f.agent.id, prompt: "Orders", format: "kpi" as const, schedule: "hour" as const };
    await expect(createWidget(deps, f.owner.id, f.org.id, spare.id, ask)).rejects.toMatchObject({
      code: "widget.scheduled_cap",
      params: { max: WIDGET_SCHEDULED_MAX },
    });
    await expect(updateWidget(deps, f.owner.id, f.org.id, manual.id, { schedule: "day" })).rejects.toMatchObject({
      code: "widget.scheduled_cap",
    });
    // A deleted board's widgets update no more: they free their places.
    const first = boards[0];
    if (!first) throw new Error("no board");
    await f.db.update(schema.dashboards).set({ deletedAt: new Date() }).where(eq(schema.dashboards.id, first.id));
    await assertScheduledRoom(f.db, f.org.id);
  });

  test("change a widget: title, size, alert recipient, another board the person edits", async () => {
    const nina = await addMember(f.db, f.org.id, "member", "nina");
    const shared = await board(f.owner.id, { editPolicy: "viewers" });
    const w = await widgetRow(shared.id);
    const changed = await updateWidget(deps, nina.id, f.org.id, w.id, {
      title: "Revenue",
      size: "l",
      alert: { enabled: true, condition: "below R$ 10k" },
    });
    expect(changed).toMatchObject({
      title: "Revenue",
      layout: { w: 2, h: 2 },
      alert: { enabled: true, condition: "below R$ 10k" },
    });
    const [row] = await f.db.select().from(schema.dashboardWidgets).where(eq(schema.dashboardWidgets.id, w.id));
    expect(row?.alertUserId).toBe(nina.id);

    // Moving needs edit on the target too.
    const closed = await board(f.owner.id, { title: "Closed" });
    await expect(updateWidget(deps, nina.id, f.org.id, w.id, { dashboardId: closed.id })).rejects.toMatchObject({
      code: "dashboard.forbidden",
    });
    const hers = await board(nina.id, { title: "Hers", audience: "private" });
    await widgetRow(hers.id, { position: 0 });
    const moved = await updateWidget(deps, nina.id, f.org.id, w.id, { dashboardId: hers.id });
    expect(moved).toMatchObject({ dashboardId: hers.id, layout: { position: 1 } });
    expect((await getDashboard(deps, f.owner.id, f.org.id, shared.id)).widgets).toEqual([]);
    await expect(updateWidget(deps, nina.id, f.org.id, w.id, { title: " " })).rejects.toMatchObject({
      code: "dashboard.title_required",
    });
  });

  test("a widget on a board the person can't see doesn't exist for them", async () => {
    const nina = await addMember(f.db, f.org.id, "member", "nina");
    const mine = await board(f.owner.id, { audience: "private" });
    const w = await widgetRow(mine.id);
    await expect(getWidget(deps, nina.id, f.org.id, w.id)).rejects.toMatchObject({ code: "widget.not_found" });
    await expect(removeWidget(deps, nina.id, f.org.id, w.id)).rejects.toMatchObject({ code: "widget.not_found" });
  });

  test("remove: the widget and its history go", async () => {
    const made = await board(f.owner.id);
    const w = await widgetRow(made.id);
    await f.db.insert(schema.dashboardWidgetUpdates).values({ orgId: f.org.id, widgetId: w.id, status: "ok" });
    await removeWidget(deps, f.owner.id, f.org.id, w.id);
    expect(await f.db.select().from(schema.dashboardWidgets).where(eq(schema.dashboardWidgets.id, w.id))).toEqual([]);
    expect(
      await f.db.select().from(schema.dashboardWidgetUpdates).where(eq(schema.dashboardWidgetUpdates.widgetId, w.id)),
    ).toEqual([]);
    expect((await getDashboard(deps, f.owner.id, f.org.id, made.id)).widgetCount).toBe(0);
  });

  test("the panel: the widget, its board, the right to edit and its latest updates newest first", async () => {
    const nina = await addMember(f.db, f.org.id, "member", "nina");
    const made = await board(f.owner.id);
    const w = await widgetRow(made.id, { status: "failed", failureCode: "agent_reported", failureDetail: "No access" });
    const base = Date.parse("2026-11-01T10:00:00Z");
    await f.db.insert(schema.dashboardWidgetUpdates).values(
      Array.from({ length: 25 }, (_, i) => ({
        orgId: f.org.id,
        widgetId: w.id,
        status: i % 5 === 0 ? "failed" : "ok",
        summary: `update ${i}`,
        costNanoUsd: i % 2 === 0 ? 0 : 2_000_000,
        createdAt: new Date(base + i * 60_000),
      })),
    );
    const detail = await getWidget(deps, nina.id, f.org.id, w.id);
    expect(detail).toMatchObject({
      dashboard: { id: made.id, kind: "board", title: "Sales" },
      canEdit: false,
      status: "failed",
      failure: { code: "agent_reported", detail: "No access" },
      spec: { kind: "kpi", value: 18420, prefix: "R$" },
    });
    expect(detail.history).toHaveLength(20);
    expect(detail.history[0]).toMatchObject({ summary: "update 24", status: "ok", costUsd: null });
    expect(detail.history[1]).toMatchObject({ summary: "update 23", costUsd: 0.002 });
    expect(detail.history.at(-1)?.summary).toBe("update 5");
    expect((await widgetHistory(f.db, f.org.id, w.id, 3)).map((u) => u.summary)).toEqual([
      "update 24",
      "update 23",
      "update 22",
    ]);
  });

  test("the board's view: thumbs, counts and its later update", async () => {
    const made = await board(f.owner.id);
    const refreshed = new Date(Date.now() + 60_000);
    for (let i = 0; i < 8; i++) {
      await widgetRow(made.id, { position: i, w: i % 2 === 0 ? 2 : 1, refreshedAt: refreshed });
    }
    const view = await getDashboard(deps, f.owner.id, f.org.id, made.id);
    expect(view.widgetCount).toBe(8);
    expect(view.thumbs).toHaveLength(6);
    expect(view.thumbs[0]).toEqual({ agentId: f.agent.id, w: 2 });
    expect(view.updatedAt).toBe(refreshed.toISOString());
    expect(view.widgets.map((w) => w.layout.position)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(view.widgets[0]?.nextRunAt).toBeNull();
  });

  test("in a workspace being deleted no widget says when it refreshes next: its routine's slots pass", async () => {
    const made = await board(f.owner.id);
    const [routine] = await f.db
      .insert(schema.routines)
      .values({
        orgId: f.org.id,
        agentId: f.agent.id,
        name: "Revenue today",
        prompt: "Revenue",
        target: { type: "widget", widgetId: crypto.randomUUID(), dashboardId: made.id },
        triggerType: "schedule",
        cron: "0 * * * *",
        nextRunAt: new Date(Date.now() + 3600_000),
        createdByUserId: f.owner.id,
      })
      .returning();
    if (!routine) throw new Error("no routine");
    await widgetRow(made.id, { routineId: routine.id, schedule: "hour" });
    const next = async () => (await getDashboard(deps, f.owner.id, f.org.id, made.id)).widgets[0]?.nextRunAt;
    expect(await next()).toBe(routine.nextRunAt?.toISOString() ?? "");
    await f.db
      .update(schema.organizations)
      .set({ deletionDueAt: new Date(Date.now() + 7 * 86_400_000) })
      .where(eq(schema.organizations.id, f.org.id));
    expect(await next()).toBeNull();
  });
});

describe("someone leaving (ADR 0135 Consequences)", () => {
  test("their home and private boards go with their widgets' routines; shared ones stay", async () => {
    const nina = await addMember(f.db, f.org.id, "member", "nina");
    const home = await getOrCreateHome(deps, nina.id, f.org.id);
    const mine = await board(nina.id, { title: "Mine", audience: "private" });
    const team = await board(nina.id, { title: "Team" });
    const [routine] = await f.db
      .insert(schema.routines)
      .values({
        orgId: f.org.id,
        agentId: f.agent.id,
        name: "Revenue today",
        prompt: "Revenue",
        target: { type: "widget", widgetId: crypto.randomUUID(), dashboardId: mine.id },
        triggerType: "schedule",
        cron: "0 * * * *",
        nextRunAt: new Date(Date.now() + 3600_000),
        createdByUserId: nina.id,
      })
      .returning();
    if (!routine) throw new Error("no routine");
    await widgetRow(mine.id, { routineId: routine.id, schedule: "hour" });
    await removeMember(f.db, f.owner.id, f.org.id, nina.id);
    const rows = await f.db.select().from(schema.dashboards).where(eq(schema.dashboards.orgId, f.org.id));
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(home.id)?.deletedAt).not.toBeNull();
    expect(byId.get(mine.id)?.deletedAt).not.toBeNull();
    expect(byId.get(team.id)?.deletedAt).toBeNull();
    const [gone] = await f.db.select().from(schema.routines).where(eq(schema.routines.id, routine.id));
    expect(gone).toMatchObject({ active: false, nextRunAt: null });
    expect(gone?.deletedAt).not.toBeNull();
    expect(await titles(f.owner.id)).toEqual(["Team"]);
  });
});

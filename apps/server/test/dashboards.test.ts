import { afterEach, beforeEach, expect, test } from "bun:test";
import { orgTopic, userTopic } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import { insertMessage, notify, proposeDashboardAudience } from "@agenteschat/engine";
import { type Browser, browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

/** The boards and widgets routes (ADR 0135): who sees and changes what, and what each route answers. */

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
});
afterEach(() => t.close());

type Layout = { position: number; w: 1 | 2; h: 1 | 2 };
type Widget = {
  id: string;
  dashboardId: string;
  agentId: string;
  title: string;
  prompt: string;
  format: string;
  kind: string | null;
  spec: Record<string, unknown> | null;
  layout: Layout;
  schedule: string;
  alert: { enabled: boolean; condition: string };
  status: string;
  routineId: string | null;
  sourceMessageId: string | null;
  createdBy: { kind: string; id: string } | null;
  draft: boolean;
  lastCostUsd: number | null;
};
type Tile = { key: "waiting" | "working" } & Layout;
type Proposal = { audience: string; roleIds: string[]; agentId: string; why: string; canDecide: boolean };
type Board = {
  id: string;
  kind: string;
  title: string;
  about: string;
  audience: string;
  roleIds: string[];
  editPolicy: string;
  editRoleIds: string[];
  pinned: boolean;
  owner: { kind: string; id: string; name: string } | null;
  mine: boolean;
  widgetCount: number;
  canEdit: boolean;
  canManage: boolean;
  proposal: Proposal | null;
  widgets: Widget[];
  tiles: Tile[];
};
type List = { home: Board | null; dashboards: Board[]; homeDashboardId: string | null };
type Detail = Widget & {
  dashboard: { id: string; kind: string; title: string };
  canEdit: boolean;
  step: { tool: string; connector: string | null; service: string | null; at: string } | null;
  history: { id: string; status: string; summary: string; failureCode: string | null; costUsd: number | null }[];
};

const userIdOf = async (b: Browser) => ((await (await b("/api/app/me")).json()) as { user: { id: string } }).user.id;
const codeOf = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
async function read<T>(res: Response, status = 200): Promise<T> {
  if (res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

/**
 * The owner's workspace with the agent Dev in #general, and three people invited: Ana and Bia (members) and Lia
 * (an admin).
 */
async function start() {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId, channelId } = await seedOrg(owner);
  const ana = await joinByInvitation(t, owner, orgId, "ana@example.com");
  const bia = await joinByInvitation(t, owner, orgId, "bia@example.com");
  const lia = await joinByInvitation(t, owner, orgId, "lia@example.com", { role: "admin" });
  const api = (b: Browser, path: string, init?: Parameters<Browser>[1]) =>
    b(`/api/app/organizations/${orgId}${path}`, init);
  const newBoard = async (b: Browser, input: Record<string, unknown>) =>
    read<Board>(await api(b, "/dashboards", { json: { audience: "workspace", editPolicy: "owner", ...input } }), 201);
  const newWidget = async (b: Browser, dashboardId: string, input: Record<string, unknown> = {}) =>
    read<Widget>(
      await api(b, `/dashboards/${dashboardId}/widgets`, {
        json: { agentId, prompt: "Today's sales vs. yesterday", format: "auto", schedule: "manual", ...input },
      }),
      201,
    );
  const board = async (b: Browser, id: string) => api(b, `/dashboards/${id}`);
  const list = async (b: Browser) => read<List>(await api(b, "/dashboards"));
  return {
    owner,
    ana,
    bia,
    lia,
    orgId,
    agentId,
    channelId,
    ownerId: await userIdOf(owner),
    anaId: await userIdOf(ana),
    api,
    newBoard,
    newWidget,
    board,
    list,
  };
}

const chart = (title: string) =>
  JSON.stringify({ type: "bar", title, labels: ["Mon", "Tue"], series: [{ name: "Sales", values: [3, 5] }] });
const withChart = (text: string, block: string) => `${text}\n\n\`\`\`chart\n${block}\n\`\`\``;
const agentAuthor = (agentId: string) => ({ type: "agent" as const, agentId, runId: null, hop: 0, stretchId: null });

test("the routes need a session and our origin; people outside the workspace see none of it", async () => {
  const s = await start();
  const anon = browser(t);
  expect((await anon(`/api/app/organizations/${s.orgId}/dashboards`)).status).toBe(401);
  const crossSite = await s.api(s.owner, "/dashboards", {
    json: { title: "Sales", audience: "workspace", editPolicy: "owner" },
    origin: "https://evil.example",
  });
  expect(crossSite.status).toBe(403);
  expect(await codeOf(crossSite)).toBe("bad_origin");

  const sales = await s.newBoard(s.owner, { title: "Sales" });
  const widget = await s.newWidget(s.owner, sales.id);

  // Zed has a workspace of his own, not this one.
  const zed = browser(t);
  await signUp(zed, "zed@example.com");
  expect((await s.api(zed, "/dashboards")).status).toBe(403);
  expect([403, 404]).toContain((await s.api(zed, `/dashboards/${sales.id}`)).status);
  expect([403, 404]).toContain((await s.api(zed, `/widgets/${widget.id}`)).status);
  const zedOrg = await seedOrg(zed);
  const elsewhere = (path: string) => zed(`/api/app/organizations/${zedOrg.orgId}${path}`);
  const board = await elsewhere(`/dashboards/${sales.id}`);
  expect(board.status).toBe(404);
  expect(await codeOf(board)).toBe("dashboard.not_found");
  const other = await elsewhere(`/widgets/${widget.id}`);
  expect(other.status).toBe(404);
  expect(await codeOf(other)).toBe("widget.not_found");
  expect((await read<List>(await elsewhere("/dashboards"))).dashboards).toEqual([]);
});

test("a workspace board: every member sees it; with edit policy owner, its owner and admins change it", async () => {
  const s = await start();
  const sales = await s.newBoard(s.owner, { title: "Sales", about: "Numbers of the shop" });
  expect(sales).toMatchObject({
    kind: "board",
    title: "Sales",
    about: "Numbers of the shop",
    audience: "workspace",
    roleIds: [],
    editPolicy: "owner",
    pinned: false,
    mine: true,
    canEdit: true,
    canManage: true,
    widgetCount: 0,
    widgets: [],
    tiles: [],
    proposal: null,
    editRoleIds: [],
    owner: { kind: "person", id: s.ownerId },
  });

  expect((await s.list(s.ana)).dashboards.map((d) => d.id)).toContain(sales.id);
  const seen = await read<Board>(await s.board(s.ana, sales.id));
  expect(seen).toMatchObject({ id: sales.id, mine: false, canEdit: false, canManage: false });

  const refusals = [
    await s.api(s.ana, `/dashboards/${sales.id}`, { method: "PATCH", json: { title: "Mine now" } }),
    await s.api(s.ana, `/dashboards/${sales.id}/layout`, { method: "PUT", json: { widgets: [] } }),
    await s.api(s.ana, `/dashboards/${sales.id}/widgets`, {
      json: { agentId: s.agentId, prompt: "Open tickets", format: "kpi", schedule: "manual" },
    }),
    await s.api(s.ana, `/dashboards/${sales.id}/share`, {
      method: "PUT",
      json: { audience: "private", roleIds: [], editPolicy: "owner" },
    }),
    await s.api(s.ana, `/dashboards/${sales.id}`, { method: "DELETE" }),
  ];
  for (const res of refusals) {
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe("dashboard.forbidden");
  }

  // An admin may change, pin, share and delete what they see.
  const renamed = await read<Board>(
    await s.api(s.lia, `/dashboards/${sales.id}`, { method: "PATCH", json: { title: "Sales 2026", pinned: true } }),
  );
  expect(renamed).toMatchObject({ title: "Sales 2026", pinned: true, canEdit: true, canManage: true });

  // Whoever sees it edits it once its owner says so; sharing, pinning and deleting stay its owner's and admins'.
  const opened = await read<Board>(
    await s.api(s.owner, `/dashboards/${sales.id}/share`, {
      method: "PUT",
      json: { audience: "workspace", roleIds: [], editPolicy: "viewers" },
    }),
  );
  expect(opened.editPolicy).toBe("viewers");
  const edited = await s.api(s.ana, `/dashboards/${sales.id}`, { method: "PATCH", json: { about: "Daily" } });
  expect((await read<Board>(edited)).about).toBe("Daily");
  const unpinned = await s.api(s.ana, `/dashboards/${sales.id}`, { method: "PATCH", json: { pinned: false } });
  expect(unpinned.status).toBe(403);
  expect((await s.api(s.ana, `/dashboards/${sales.id}`, { method: "DELETE" })).status).toBe(403);

  expect((await s.api(s.lia, `/dashboards/${sales.id}`, { method: "DELETE" })).status).toBe(204);
  const gone = await s.board(s.owner, sales.id);
  expect(gone.status).toBe(404);
  expect(await codeOf(gone)).toBe("dashboard.not_found");
  expect((await s.list(s.owner)).dashboards.map((d) => d.id)).not.toContain(sales.id);
});

test("a private board is its owner's alone, admins included", async () => {
  const s = await start();
  const mine = await s.newBoard(s.ana, { title: "My numbers", audience: "private" });
  expect(mine).toMatchObject({ audience: "private", mine: true, canEdit: true, canManage: true });
  expect((await s.list(s.ana)).dashboards.map((d) => d.id)).toContain(mine.id);

  for (const b of [s.owner, s.lia, s.bia]) {
    const res = await s.board(b, mine.id);
    expect(res.status).toBe(404);
    expect(await codeOf(res)).toBe("dashboard.not_found");
    expect((await s.list(b)).dashboards.map((d) => d.id)).not.toContain(mine.id);
  }
  const renamed = await s.api(s.owner, `/dashboards/${mine.id}`, { method: "PATCH", json: { title: "x" } });
  expect(renamed.status).toBe(404);
  expect((await s.api(s.lia, `/dashboards/${mine.id}`, { method: "DELETE" })).status).toBe(404);
  const added = await s.api(s.lia, `/dashboards/${mine.id}/widgets`, {
    json: { agentId: s.agentId, prompt: "Open tickets", format: "kpi", schedule: "manual" },
  });
  expect(added.status).toBe(404);
});

test("a roles board: whoever holds one of its roles sees it, admins too, nobody else", async () => {
  const s = await start();
  const finance = await read<{ id: string }>(await s.api(s.owner, "/roles", { json: { name: "Finance" } }), 201);
  const given = await s.api(s.owner, `/members/${s.anaId}/roles`, { method: "PUT", json: { roleIds: [finance.id] } });
  expect(given.status).toBe(200);

  const cash = await s.newBoard(s.owner, {
    title: "Cash",
    audience: "roles",
    roleIds: [finance.id],
    editPolicy: "viewers",
  });
  expect(cash).toMatchObject({ audience: "roles", roleIds: [finance.id] });

  expect(await read<Board>(await s.board(s.ana, cash.id))).toMatchObject({ canEdit: true, canManage: false });
  expect((await s.list(s.ana)).dashboards.map((d) => d.id)).toContain(cash.id);
  const hidden = await s.board(s.bia, cash.id);
  expect(hidden.status).toBe(404);
  expect(await codeOf(hidden)).toBe("dashboard.not_found");
  expect((await s.list(s.bia)).dashboards.map((d) => d.id)).not.toContain(cash.id);
  expect(await read<Board>(await s.board(s.lia, cash.id))).toMatchObject({ canEdit: true, canManage: true });

  const noRole = await s.api(s.owner, "/dashboards", {
    json: { title: "Nobody", audience: "roles", roleIds: [], editPolicy: "owner" },
  });
  expect(noRole.status).toBe(400);
  expect(await codeOf(noRole)).toBe("dashboard.roles_required");
  const unknown = await s.api(s.owner, "/dashboards", {
    json: { title: "Nobody", audience: "roles", roleIds: [crypto.randomUUID()], editPolicy: "owner" },
  });
  expect(unknown.status).toBe(400);
  expect(await codeOf(unknown)).toBe("dashboard.role_unknown");
  const empty = await s.api(s.owner, `/dashboards/${cash.id}/share`, {
    method: "PUT",
    json: { audience: "roles", roleIds: [], editPolicy: "viewers" },
  });
  expect(empty.status).toBe(400);
  expect(await codeOf(empty)).toBe("dashboard.roles_required");
  const untitled = await s.api(s.owner, "/dashboards", {
    json: { title: "   ", audience: "workspace", editPolicy: "owner" },
  });
  expect(untitled.status).toBe(400);
  expect(await codeOf(untitled)).toBe("invalid_request");
});

test("Use on Home: a board Ana sees goes on her Início alone; one she can't see is a 404", async () => {
  const s = await start();
  const sales = await s.newBoard(s.owner, { title: "Sales" });
  const hidden = await s.newBoard(s.owner, { title: "Mine", audience: "private" });
  const choose = (b: Browser, homeDashboardId: string | null) =>
    s.api(b, "/dashboards/home-choice", { method: "PUT", json: { homeDashboardId } });
  expect(await read<{ homeDashboardId: string | null }>(await choose(s.ana, sales.id))).toEqual({
    homeDashboardId: sales.id,
  });
  expect((await s.list(s.ana)).homeDashboardId).toBe(sales.id);
  expect((await s.list(s.owner)).homeDashboardId).toBeNull();
  const refused = await choose(s.ana, hidden.id);
  expect(refused.status).toBe(404);
  expect(await codeOf(refused)).toBe("dashboard.not_found");
  await read(await choose(s.ana, null));
  expect((await s.list(s.ana)).homeDashboardId).toBeNull();
});

test("My Home: made on first read, then the same board, its person's alone, never shared or deleted", async () => {
  const s = await start();
  const home = await read<Board>(await s.api(s.ana, "/dashboards/home"));
  expect(home).toMatchObject({
    kind: "home",
    title: "",
    audience: "private",
    mine: true,
    canEdit: true,
    widgets: [],
  });
  expect(home.tiles.map((tile) => tile.key).sort()).toEqual(["waiting", "working"]);
  expect((await read<Board>(await s.api(s.ana, "/dashboards/home"))).id).toBe(home.id);
  const listed = await s.list(s.ana);
  expect(listed.home?.id).toBe(home.id);
  expect(listed.dashboards.map((d) => d.id)).not.toContain(home.id);
  // Someone else's home is another board.
  expect((await read<Board>(await s.api(s.bia, "/dashboards/home"))).id).not.toBe(home.id);

  for (const b of [s.owner, s.lia]) expect((await s.board(b, home.id)).status).toBe(404);
  const deleted = await s.api(s.ana, `/dashboards/${home.id}`, { method: "DELETE" });
  expect(deleted.status).toBe(400);
  expect(await codeOf(deleted)).toBe("dashboard.home_fixed");
  const shared = await s.api(s.ana, `/dashboards/${home.id}/share`, {
    method: "PUT",
    json: { audience: "workspace", roleIds: [], editPolicy: "owner" },
  });
  expect(shared.status).toBe(400);
  expect(await codeOf(shared)).toBe("dashboard.home_fixed");

  const tiles: Tile[] = [
    { key: "waiting", position: 1, w: 1, h: 1 },
    { key: "working", position: 0, w: 2, h: 2 },
  ];
  const arranged = await read<Board>(
    await s.api(s.ana, `/dashboards/${home.id}/layout`, { method: "PUT", json: { widgets: [], tiles } }),
  );
  expect([...arranged.tiles].sort((a, b) => a.key.localeCompare(b.key))).toEqual(tiles);
  const elsewhere = await s.api(s.owner, `/dashboards/${home.id}/layout`, { method: "PUT", json: { widgets: [] } });
  expect(elsewhere.status).toBe(404);
});

test("+ Widget: checked input, an agent the person may talk to, room on the board and under the cap", async () => {
  const s = await start();
  const sales = await s.newBoard(s.owner, { title: "Sales", editPolicy: "viewers" });
  const path = `/dashboards/${sales.id}/widgets`;
  const valid = { agentId: s.agentId, prompt: "Today's sales vs. yesterday", format: "auto", schedule: "hour" };
  for (const json of [
    { ...valid, prompt: undefined },
    { ...valid, prompt: "   " },
    { ...valid, prompt: "x".repeat(2001) },
    { ...valid, format: "pie" },
    { ...valid, schedule: "minute" },
    { ...valid, size: "xl" },
    { ...valid, agentId: "not-an-id" },
    { ...valid, alert: { enabled: true, condition: "x".repeat(201) } },
  ]) {
    const res = await s.api(s.owner, path, { json });
    expect(res.status).toBe(400);
    expect(await codeOf(res)).toBe("invalid_request");
  }

  const made = await read<Widget>(
    await s.api(s.owner, path, {
      json: { ...valid, alert: { enabled: true, condition: "drops 20% below yesterday" } },
    }),
    201,
  );
  expect(made).toMatchObject({
    dashboardId: sales.id,
    agentId: s.agentId,
    // Untitled until its agent names it on its first build (ADR 0135 §17).
    title: "",
    prompt: "Today's sales vs. yesterday",
    format: "auto",
    spec: null,
    schedule: "hour",
    alert: { enabled: true, condition: "drops 20% below yesterday" },
    status: "building",
    layout: { w: 2, h: 1 },
    createdBy: { kind: "person", id: s.ownerId },
  });
  expect(made.routineId).toEqual(expect.any(String));
  // A number starts small; a size asked for wins.
  const kpi = await s.newWidget(s.ana, sales.id, { prompt: "Open tickets", format: "kpi" });
  expect(kpi.layout).toMatchObject({ w: 1, h: 1 });
  expect(kpi.createdBy).toEqual({ kind: "person", id: s.anaId });
  const big = await s.newWidget(s.ana, sales.id, { prompt: "Orders by hour", format: "line", size: "l" });
  expect(big.layout).toMatchObject({ w: 2, h: 2 });
  expect((await read<Board>(await s.board(s.owner, sales.id))).widgetCount).toBe(3);

  // An agent the person can't talk to, or one no longer in the team, never looks after a widget.
  const rex = await read<{ id: string }>(
    await s.api(s.owner, "/agents", {
      json: { name: "Rex", handle: "rex", audience: { mode: "people", userIds: [] } },
    }),
    201,
  );
  const unreachable = await s.api(s.ana, path, { json: { ...valid, agentId: rex.id } });
  expect(unreachable.status).toBe(403);
  expect(await codeOf(unreachable)).toBe("widget.agent_unreachable");
  const max = await read<{ id: string }>(
    await s.api(s.owner, "/agents", { json: { name: "Max", handle: "max" } }),
    201,
  );
  expect((await s.api(s.owner, `/agents/${max.id}`, { method: "DELETE" })).status).toBe(204);
  const archived = await s.api(s.owner, path, { json: { ...valid, agentId: max.id } });
  expect(archived.status).toBe(400);
  expect(await codeOf(archived)).toBe("widget.agent_archived");

  // 60 widgets updating on a schedule in the workspace: another scheduled one waits, a manual one doesn't count.
  const filler = await s.newBoard(s.owner, { title: "Filler", audience: "private" });
  await t.db.insert(schema.dashboardWidgets).values(
    Array.from({ length: 59 }, (_, i) => ({
      orgId: s.orgId,
      dashboardId: filler.id,
      agentId: s.agentId,
      title: `Filler ${i}`,
      schedule: "day",
      status: "ok",
      position: i,
    })),
  );
  const capped = await s.api(s.owner, path, { json: { ...valid, schedule: "half" } });
  expect(capped.status).toBe(400);
  expect(await read<{ error: { code: string; params?: Record<string, unknown> } }>(capped, 400)).toMatchObject({
    error: { code: "widget.scheduled_cap", params: { max: 60 } },
  });
  expect((await s.api(s.owner, path, { json: { ...valid, schedule: "manual" } })).status).toBe(201);
  // A board holds at most 24 widgets.
  const full = await s.api(s.owner, `/dashboards/${filler.id}/widgets`, { json: { ...valid, schedule: "manual" } });
  expect(full.status).toBe(400);
  expect(await codeOf(full)).toBe("widget.too_many");
});

test("Pin keeps a chart an agent sent where the person reads; never one from a conversation they don't", async () => {
  const s = await start();
  const salesBlock = chart("Sales by day");
  const inGeneral = await insertMessage(t.db, {
    orgId: s.orgId,
    channelId: s.channelId,
    author: agentAuthor(s.agentId),
    body: withChart("Here is the week:", salesBlock),
    createdAt: new Date(Date.now() - 120_000),
  });
  const secret = await read<{ id: string }>(
    await s.api(s.owner, "/channels", { json: { name: "finance", visibility: "private" } }),
    201,
  );
  const cashBlock = chart("Cash by day");
  const inSecret = await insertMessage(t.db, {
    orgId: s.orgId,
    channelId: secret.id,
    author: agentAuthor(s.agentId),
    body: withChart("Cash this week:", cashBlock),
    createdAt: new Date(Date.now() - 60_000),
  });
  const byPerson = await insertMessage(t.db, {
    orgId: s.orgId,
    channelId: s.channelId,
    author: { type: "person", userId: s.ownerId },
    body: withChart("My own chart:", chart("Mine")),
  });

  const sales = await s.newBoard(s.owner, { title: "Sales" });
  const pin = (b: Browser, dashboardId: string, json: Record<string, unknown>) =>
    s.api(b, `/dashboards/${dashboardId}/widgets/pin`, { json: { schedule: "manual", ...json } });

  const pinned = await read<Widget>(await pin(s.owner, sales.id, { messageId: inGeneral.id, block: salesBlock }), 201);
  expect(pinned).toMatchObject({
    dashboardId: sales.id,
    agentId: s.agentId,
    title: "Sales by day",
    kind: "bars",
    spec: { kind: "bars", labels: ["Mon", "Tue"], values: [3, 5] },
    status: "ok",
    schedule: "manual",
    sourceMessageId: inGeneral.id,
  });
  const updating = await read<Widget>(
    await pin(s.owner, sales.id, { messageId: inSecret.id, block: cashBlock, schedule: "day", title: "Cash" }),
    201,
  );
  expect(updating).toMatchObject({ title: "Cash", schedule: "day", status: "ok" });
  expect(updating.routineId).toEqual(expect.any(String));

  // Ana doesn't read #finance: its chart isn't hers to pin, not even on her own home.
  const anaHome = await read<Board>(await s.api(s.ana, "/dashboards/home"));
  const refused = await pin(s.ana, anaHome.id, { messageId: inSecret.id, block: cashBlock });
  expect(refused.status).toBe(404);
  expect(await codeOf(refused)).toBe("widget.block_not_found");
  expect((await pin(s.ana, anaHome.id, { messageId: inGeneral.id, block: salesBlock })).status).toBe(201);
  // A block the message doesn't hold, a person's chart, a board Ana may not change.
  const notThere = await pin(s.owner, sales.id, { messageId: inGeneral.id, block: chart("Something else") });
  expect(notThere.status).toBe(404);
  expect(await codeOf(notThere)).toBe("widget.block_not_found");
  const notAgent = await pin(s.owner, sales.id, { messageId: byPerson.id, block: chart("Mine") });
  expect(notAgent.status).toBe(400);
  expect(await codeOf(notAgent)).toBe("widget.not_agent_message");
  const notHers = await pin(s.ana, sales.id, { messageId: inGeneral.id, block: salesBlock });
  expect(notHers.status).toBe(403);
  expect(await codeOf(notHers)).toBe("dashboard.forbidden");
  expect((await pin(s.owner, sales.id, { messageId: inGeneral.id, block: "{" })).status).toBe(400);

  // "Pin from chat" lists the agents' charts where each person reads, newest first.
  type Pinnable = { messageId: string; block: string; title: string };
  const blocks = async (b: Browser, query = "") =>
    (await read<{ blocks: Pinnable[] }>(await s.api(b, `/widget-pinnable${query}`))).blocks;
  const owners = await blocks(s.owner);
  expect(owners.map((b) => b.messageId)).toEqual([inSecret.id, inGeneral.id]);
  expect(owners[0]).toMatchObject({ block: cashBlock, title: "Cash by day" });
  expect((await blocks(s.ana)).map((b) => b.messageId)).toEqual([inGeneral.id]);
  expect((await blocks(s.owner, "?limit=1")).map((b) => b.messageId)).toEqual([inSecret.id]);
  expect((await s.api(s.owner, "/widget-pinnable?limit=0")).status).toBe(400);
});

test("Organize saves the order and sizes of a board's widgets in one batch", async () => {
  const s = await start();
  const sales = await s.newBoard(s.owner, { title: "Sales" });
  const first = await s.newWidget(s.owner, sales.id, { prompt: "Open tickets", format: "kpi" });
  const second = await s.newWidget(s.owner, sales.id, { prompt: "Orders by hour", format: "line" });
  const saved = await read<Board>(
    await s.api(s.owner, `/dashboards/${sales.id}/layout`, {
      method: "PUT",
      json: {
        widgets: [
          { id: second.id, position: 0, w: 2, h: 2 },
          { id: first.id, position: 1, w: 1, h: 1 },
        ],
      },
    }),
  );
  const order = [...saved.widgets].sort((a, b) => a.layout.position - b.layout.position);
  expect(order.map((w) => [w.id, w.layout.w, w.layout.h])).toEqual([
    [second.id, 2, 2],
    [first.id, 1, 1],
  ]);
  const again = await read<Board>(await s.board(s.owner, sales.id));
  expect(again.widgets.find((w) => w.id === second.id)?.layout).toMatchObject({ w: 2, h: 2 });

  // Only this board's widgets, and only the sizes the grid has.
  const other = await s.newBoard(s.owner, { title: "Other" });
  const stranger = await s.newWidget(s.owner, other.id);
  const foreign = await s.api(s.owner, `/dashboards/${sales.id}/layout`, {
    method: "PUT",
    json: { widgets: [{ id: stranger.id, position: 0, w: 1, h: 1 }] },
  });
  expect([400, 404]).toContain(foreign.status);
  const wide = await s.api(s.owner, `/dashboards/${sales.id}/layout`, {
    method: "PUT",
    json: { widgets: [{ id: first.id, position: 0, w: 3, h: 1 }] },
  });
  expect(wide.status).toBe(400);
  expect(await codeOf(wide)).toBe("invalid_request");
});

test("Share changes who sees a board, and the change reaches the right people live", async () => {
  const s = await start();
  const ownerEvents: Record<string, unknown>[] = [];
  const orgEvents: Record<string, unknown>[] = [];
  t.adapters.pubsub.subscribe(userTopic(s.orgId, s.ownerId), (e) => {
    ownerEvents.push(e as Record<string, unknown>);
  });
  t.adapters.pubsub.subscribe(orgTopic(s.orgId), (e) => {
    const inner = (e as { type?: string; event?: Record<string, unknown> }).event;
    if ((e as { type?: string }).type === "org.broadcast" && inner) orgEvents.push(inner);
  });
  const about = (events: Record<string, unknown>[], id: string, type: string) =>
    events.filter((e) => e.dashboardId === id && e.type === type);

  // A private board's changes go to its owner alone.
  const plan = await s.newBoard(s.owner, { title: "Plan", audience: "private" });
  const widget = await s.newWidget(s.owner, plan.id);
  expect(about(ownerEvents, plan.id, "dashboard.changed").length).toBeGreaterThan(0);
  expect(about(ownerEvents, plan.id, "dashboard.widget").map((e) => e.widgetId)).toContain(widget.id);
  expect(about(orgEvents, plan.id, "dashboard.changed")).toEqual([]);
  expect((await s.board(s.ana, plan.id)).status).toBe(404);

  const shared = await read<Board>(
    await s.api(s.owner, `/dashboards/${plan.id}/share`, {
      method: "PUT",
      json: { audience: "workspace", roleIds: [], editPolicy: "viewers" },
    }),
  );
  expect(shared).toMatchObject({ audience: "workspace", editPolicy: "viewers" });
  expect(about(orgEvents, plan.id, "dashboard.changed").length).toBeGreaterThan(0);
  expect((await s.list(s.ana)).dashboards.map((d) => d.id)).toContain(plan.id);
  expect(await read<Board>(await s.board(s.ana, plan.id))).toMatchObject({ canEdit: true, canManage: false });

  // Taking it back tells everyone, so the lists that showed it drop it.
  orgEvents.length = 0;
  await read<Board>(
    await s.api(s.owner, `/dashboards/${plan.id}/share`, {
      method: "PUT",
      json: { audience: "private", roleIds: [], editPolicy: "owner" },
    }),
  );
  expect(about(orgEvents, plan.id, "dashboard.changed").length).toBeGreaterThan(0);
  expect((await s.board(s.ana, plan.id)).status).toBe(404);
});

test("an agent's request to show a board to more people waits on its owner: Publish or Keep only for me", async () => {
  const s = await start();
  const finance = await read<{ id: string }>(await s.api(s.owner, "/roles", { json: { name: "Finance" } }), 201);
  await s.api(s.owner, `/members/${s.anaId}/roles`, { method: "PUT", json: { roleIds: [finance.id] } });
  const cash = await s.newBoard(s.owner, { title: "Cash", audience: "roles", roleIds: [finance.id] });
  const deps = { db: t.db, pubsub: t.adapters.pubsub };
  const ask = (dashboardId: string) =>
    proposeDashboardAudience(deps, {
      orgId: s.orgId,
      dashboardId,
      agentId: s.agentId,
      runId: null,
      audience: "workspace",
      roleIds: [],
      why: "The whole team follows the cash",
    });

  // Nothing waits on it: the board keeps its audience until its owner decides.
  const before = await s.api(s.owner, `/dashboards/${cash.id}/proposal`, { json: { decision: "publish" } });
  expect(before.status).toBe(409);
  expect(await codeOf(before)).toBe("dashboard.proposal_none");
  await ask(cash.id);
  const asked = await read<Board>(await s.board(s.owner, cash.id));
  expect(asked).toMatchObject({
    audience: "roles",
    proposal: { audience: "workspace", agentId: s.agentId, why: "The whole team follows the cash", canDecide: true },
  });
  expect((await read<Board>(await s.board(s.ana, cash.id))).proposal).toMatchObject({ canDecide: false });
  expect((await s.board(s.bia, cash.id)).status).toBe(404);

  // It waits on the owner in their inbox, with the board.
  const inbox = await read<{ items: { kind: string; waiting: boolean; source: Record<string, unknown> }[] }>(
    await s.api(s.owner, "/notifications"),
  );
  expect(inbox.items.find((i) => i.kind === "dashboard_proposal")).toMatchObject({
    waiting: true,
    source: { dashboardId: cash.id, agentId: s.agentId },
  });

  const notYours = await s.api(s.ana, `/dashboards/${cash.id}/proposal`, { json: { decision: "publish" } });
  expect(notYours.status).toBe(403);
  expect(await codeOf(notYours)).toBe("dashboard.proposal_not_yours");
  expect((await s.api(s.owner, `/dashboards/${cash.id}/proposal`, { json: { decision: "maybe" } })).status).toBe(400);

  const published = await read<Board>(
    await s.api(s.owner, `/dashboards/${cash.id}/proposal`, { json: { decision: "publish" } }),
  );
  expect(published).toMatchObject({ audience: "workspace", proposal: null });
  expect((await s.board(s.bia, cash.id)).status).toBe(200);
  const twice = await s.api(s.owner, `/dashboards/${cash.id}/proposal`, { json: { decision: "keep" } });
  expect(twice.status).toBe(409);
  expect(await codeOf(twice)).toBe("dashboard.proposal_none");

  // Keep only for me: the audience stays, the request goes.
  const plan = await s.newBoard(s.owner, { title: "Plan", audience: "private" });
  await ask(plan.id);
  const kept = await read<Board>(
    await s.api(s.owner, `/dashboards/${plan.id}/proposal`, { json: { decision: "keep" } }),
  );
  expect(kept).toMatchObject({ audience: "private", proposal: null });
  expect((await s.board(s.ana, plan.id)).status).toBe(404);
});

test("a widget's page: its board, whether the person edits it, and its latest updates newest first", async () => {
  const s = await start();
  const sales = await s.newBoard(s.owner, { title: "Sales" });
  const widget = await s.newWidget(s.owner, sales.id);
  await t.db.insert(schema.dashboardWidgetUpdates).values([
    {
      orgId: s.orgId,
      widgetId: widget.id,
      status: "ok",
      summary: "18,420 today",
      costNanoUsd: 2_000_000,
      tokens: 9000,
      createdAt: new Date(Date.now() - 3_600_000),
    },
    { orgId: s.orgId, widgetId: widget.id, status: "failed", failureCode: "no_update", summary: "" },
  ]);

  const detail = await read<Detail>(await s.api(s.owner, `/widgets/${widget.id}`));
  expect(detail).toMatchObject({
    id: widget.id,
    dashboard: { id: sales.id, kind: "board", title: "Sales" },
    canEdit: true,
  });
  expect(detail.history.map((h) => [h.status, h.failureCode])).toEqual([
    ["failed", "no_update"],
    ["ok", null],
  ]);
  expect(detail.history[1]?.summary).toBe("18,420 today");
  expect(detail.history[1]?.costUsd).toBeCloseTo(0.002, 6);

  expect(await read<Detail>(await s.api(s.bia, `/widgets/${widget.id}`))).toMatchObject({ canEdit: false });
  const plan = await s.newBoard(s.ana, { title: "Plan", audience: "private" });
  const hers = await s.newWidget(s.ana, plan.id);
  const hidden = await s.api(s.owner, `/widgets/${hers.id}`);
  expect(hidden.status).toBe(404);
  expect(await codeOf(hidden)).toBe("widget.not_found");
});

test("Update now, Ask for a change, change, move and remove a widget: its board's editors only", async () => {
  const s = await start();
  const sales = await s.newBoard(s.owner, { title: "Sales" });
  const widget = await s.newWidget(s.owner, sales.id);

  const refreshed = await read<Widget>(await s.api(s.owner, `/widgets/${widget.id}/refresh`, { json: {} }));
  expect(["building", "updating"]).toContain(refreshed.status);
  expect(refreshed.routineId).toEqual(expect.any(String));
  const changed = await read<Widget>(
    await s.api(s.owner, `/widgets/${widget.id}/change`, { json: { text: "Show it by week" } }),
  );
  expect(changed.id).toBe(widget.id);
  expect((await s.api(s.owner, `/widgets/${widget.id}/change`, { json: { text: "  " } })).status).toBe(400);
  for (const res of [
    await s.api(s.ana, `/widgets/${widget.id}/refresh`, { json: {} }),
    await s.api(s.ana, `/widgets/${widget.id}/change`, { json: { text: "Make it red" } }),
    await s.api(s.ana, `/widgets/${widget.id}`, { method: "PATCH", json: { title: "Mine" } }),
    await s.api(s.ana, `/widgets/${widget.id}`, { method: "DELETE" }),
  ]) {
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe("dashboard.forbidden");
  }

  const patched = await read<Widget>(
    await s.api(s.owner, `/widgets/${widget.id}`, {
      method: "PATCH",
      json: { title: "Sales today", schedule: "day", size: "l", alert: { enabled: true, condition: "below 10k" } },
    }),
  );
  expect(patched).toMatchObject({
    title: "Sales today",
    schedule: "day",
    layout: { w: 2, h: 2 },
    alert: { enabled: true, condition: "below 10k" },
  });
  const often = await s.api(s.owner, `/widgets/${widget.id}`, { method: "PATCH", json: { schedule: "often" } });
  expect(often.status).toBe(400);

  // Moved to another board the person edits; never onto one they can't see.
  const other = await s.newBoard(s.owner, { title: "Other" });
  const moved = await read<Widget>(
    await s.api(s.owner, `/widgets/${widget.id}`, { method: "PATCH", json: { dashboardId: other.id } }),
  );
  expect(moved.dashboardId).toBe(other.id);
  const hers = await s.newBoard(s.ana, { title: "Hers", audience: "private" });
  const away = await s.api(s.owner, `/widgets/${widget.id}`, { method: "PATCH", json: { dashboardId: hers.id } });
  expect(away.status).toBe(404);
  expect(await codeOf(away)).toBe("dashboard.not_found");

  expect((await s.api(s.owner, `/widgets/${widget.id}`, { method: "DELETE" })).status).toBe(204);
  const gone = await s.api(s.owner, `/widgets/${widget.id}`);
  expect(gone.status).toBe(404);
  expect(await codeOf(gone)).toBe("widget.not_found");
  expect((await read<Board>(await s.board(s.owner, other.id))).widgetCount).toBe(0);
});

test("+ Widget's cost line and suggestions, for an agent the person may talk to", async () => {
  const s = await start();
  type Cost = {
    agentId: string;
    schedule: string;
    runsPerDay: number;
    perRunUsd: number | null;
    perDayUsd: number | null;
    perWeekUsd: number | null;
    basis: string;
    billedTo: string;
  };
  const cost = (b: Browser, agentId: string, schedule: string) =>
    s.api(b, `/widget-cost?${new URLSearchParams({ agentId, schedule })}`);

  // No routine runs yet: its model's price for a typical refresh.
  const hourly = await read<Cost>(await cost(s.ana, s.agentId, "hour"));
  expect(hourly).toMatchObject({
    agentId: s.agentId,
    schedule: "hour",
    runsPerDay: 24,
    basis: "model",
    billedTo: "api",
  });
  expect(hourly.perRunUsd).toBeGreaterThan(0);
  expect(hourly.perDayUsd).toBeCloseTo((hourly.perRunUsd ?? 0) * 24, 6);
  const weekly = await read<Cost>(await cost(s.ana, s.agentId, "week"));
  expect(weekly.runsPerDay).toBeCloseTo(1 / 7, 6);
  expect(weekly.perWeekUsd).toBeCloseTo(hourly.perRunUsd ?? 0, 6);
  expect((await read<Cost>(await cost(s.ana, s.agentId, "manual"))).runsPerDay).toBe(0);
  expect((await cost(s.ana, s.agentId, "minute")).status).toBe(400);
  expect((await s.api(s.ana, "/widget-cost?schedule=hour")).status).toBe(400);

  const rex = await read<{ id: string }>(
    await s.api(s.owner, "/agents", {
      json: { name: "Rex", handle: "rex", audience: { mode: "people", userIds: [] } },
    }),
    201,
  );
  const unreachable = await cost(s.ana, rex.id, "hour");
  expect(unreachable.status).toBe(403);
  expect(await codeOf(unreachable)).toBe("widget.agent_unreachable");

  const ideas = await read<{ agentId: string; sources: string[]; suggestions: unknown[] }>(
    await s.api(s.ana, `/widget-suggestions/${s.agentId}`),
  );
  expect(ideas.agentId).toBe(s.agentId);
  expect(Array.isArray(ideas.sources)).toBe(true);
  expect(Array.isArray(ideas.suggestions)).toBe(true);
  expect(ideas.suggestions.length).toBeLessThanOrEqual(3);
  const hidden = await s.api(s.ana, `/widget-suggestions/${rex.id}`);
  expect(hidden.status).toBe(403);
  expect(await codeOf(hidden)).toBe("widget.agent_unreachable");
});

test("who edits by roles: the role's people who see the board edit it; checked as the audience's roles", async () => {
  const s = await start();
  const finance = await read<{ id: string }>(await s.api(s.owner, "/roles", { json: { name: "Finance" } }), 201);
  const given = await s.api(s.owner, `/members/${s.anaId}/roles`, { method: "PUT", json: { roleIds: [finance.id] } });
  expect(given.status).toBe(200);
  const cash = await s.newBoard(s.owner, { title: "Cash", editPolicy: "roles", editRoleIds: [finance.id] });
  expect(cash).toMatchObject({ audience: "workspace", editPolicy: "roles", editRoleIds: [finance.id] });

  // Ana holds Finance and sees it: she edits. Bia only sees it.
  expect(await read<Board>(await s.board(s.ana, cash.id))).toMatchObject({ canEdit: true, canManage: false });
  expect(await read<Board>(await s.board(s.bia, cash.id))).toMatchObject({ canEdit: false });
  const renamed = await s.api(s.ana, `/dashboards/${cash.id}`, { method: "PATCH", json: { about: "Daily" } });
  expect(renamed.status).toBe(200);
  const refused = await s.api(s.bia, `/dashboards/${cash.id}`, { method: "PATCH", json: { about: "Mine" } });
  expect(refused.status).toBe(403);
  expect(await codeOf(refused)).toBe("dashboard.forbidden");

  // Editing isn't seeing: made private, Finance's people neither see nor edit it.
  const narrowed = await read<Board>(
    await s.api(s.owner, `/dashboards/${cash.id}/share`, {
      method: "PUT",
      json: { audience: "private", roleIds: [], editPolicy: "roles", editRoleIds: [finance.id] },
    }),
  );
  expect(narrowed).toMatchObject({ audience: "private", editPolicy: "roles", editRoleIds: [finance.id] });
  expect((await s.board(s.ana, cash.id)).status).toBe(404);

  const none = await s.api(s.owner, `/dashboards/${cash.id}/share`, {
    method: "PUT",
    json: { audience: "workspace", roleIds: [], editPolicy: "roles", editRoleIds: [] },
  });
  expect(none.status).toBe(400);
  expect(await codeOf(none)).toBe("dashboard.roles_required");
  const unknown = await s.api(s.owner, "/dashboards", {
    json: { title: "Nobody", audience: "workspace", editPolicy: "roles", editRoleIds: [crypto.randomUUID()] },
  });
  expect(unknown.status).toBe(400);
  expect(await codeOf(unknown)).toBe("dashboard.role_unknown");

  // A deleted role leaves who edits; with none left, its owner and admins edit.
  await s.api(s.owner, `/dashboards/${cash.id}/share`, {
    method: "PUT",
    json: { audience: "workspace", roleIds: [], editPolicy: "roles", editRoleIds: [finance.id] },
  });
  expect((await s.api(s.owner, `/roles/${finance.id}`, { method: "DELETE" })).status).toBeLessThan(300);
  expect(await read<Board>(await s.board(s.owner, cash.id))).toMatchObject({ editPolicy: "owner", editRoleIds: [] });
  expect(await read<Board>(await s.board(s.ana, cash.id))).toMatchObject({ canEdit: false });
});

test("a widget's routine shows in Routines with its widget; notifications carry the board and the widget", async () => {
  const s = await start();
  const sales = await s.newBoard(s.owner, { title: "Sales" });
  const widget = await s.newWidget(s.owner, sales.id, { title: "Sales today", schedule: "hour" });

  const { routines } = await read<{ routines: { id: string; target: Record<string, unknown>; widget?: unknown }[] }>(
    await s.api(s.owner, "/routines"),
  );
  expect(routines.find((r) => r.id === widget.routineId)).toMatchObject({
    target: { type: "widget", widgetId: widget.id, dashboardId: sales.id },
    widget: { id: widget.id, dashboardId: sales.id, title: "Sales today" },
  });

  await notify(
    { db: t.db, pubsub: t.adapters.pubsub },
    {
      orgId: s.orgId,
      userIds: [s.ownerId],
      kind: "widget_alert",
      groupKey: `widget-alert:${widget.id}`,
      waiting: true,
      actor: { type: "agent", id: s.agentId },
      source: { dashboardId: sales.id, widgetId: widget.id, agentId: s.agentId, label: "Sales today" },
      latest: { text: "Sales dropped 20% below yesterday" },
    },
  );
  const inbox = await read<{ items: { kind: string; source: Record<string, unknown> }[] }>(
    await s.api(s.owner, "/notifications"),
  );
  expect(inbox.items.find((i) => i.kind === "widget_alert")?.source).toMatchObject({
    dashboardId: sales.id,
    widgetId: widget.id,
    agentId: s.agentId,
  });
});

test("the OpenAPI document lists the dashboards routes", async () => {
  const doc = (await (await t.app.request("/api/openapi.json")).json()) as {
    paths: Record<string, Record<string, unknown>>;
  };
  const org = "/app/organizations/{orgId}";
  const expected: [string, string[]][] = [
    [`${org}/dashboards`, ["get", "post"]],
    [`${org}/dashboards/home`, ["get"]],
    [`${org}/dashboards/{dashboardId}`, ["get", "patch", "delete"]],
    [`${org}/dashboards/{dashboardId}/share`, ["put"]],
    [`${org}/dashboards/{dashboardId}/layout`, ["put"]],
    [`${org}/dashboards/{dashboardId}/proposal`, ["post"]],
    [`${org}/dashboards/{dashboardId}/widgets`, ["post"]],
    [`${org}/dashboards/{dashboardId}/widgets/pin`, ["post"]],
    [`${org}/dashboards/{dashboardId}/widgets/test`, ["post"]],
    [`${org}/widgets/{widgetId}/confirm`, ["post"]],
    [`${org}/widgets/{widgetId}`, ["get", "patch", "delete"]],
    [`${org}/widgets/{widgetId}/refresh`, ["post"]],
    [`${org}/widgets/{widgetId}/change`, ["post"]],
    [`${org}/widget-cost`, ["get"]],
    [`${org}/widget-suggestions/{agentId}`, ["get"]],
    [`${org}/widget-pinnable`, ["get"]],
  ];
  for (const [path, methods] of expected) {
    expect(Object.keys(doc.paths[path] ?? {}).sort()).toEqual([...methods].sort());
  }
});

test("Test, then Create widget: a draft only its creator sees, confirmed once its test worked", async () => {
  const s = await start();
  const sales = await s.newBoard(s.owner, { title: "Sales", editPolicy: "viewers" });
  const ask = { agentId: s.agentId, prompt: "Site visits this week", format: "auto", schedule: "hour" };
  // The same checks as + Widget.
  const blank = await s.api(s.owner, `/dashboards/${sales.id}/widgets/test`, { json: { ...ask, prompt: " " } });
  expect(blank.status).toBe(400);
  const closed = await s.newBoard(s.owner, { title: "Closed" });
  const refused = await s.api(s.ana, `/dashboards/${closed.id}/widgets/test`, { json: ask });
  expect(refused.status).toBe(403);

  const draft = await read<Widget>(await s.api(s.ana, `/dashboards/${sales.id}/widgets/test`, { json: ask }), 202);
  expect(draft).toMatchObject({ draft: true, status: "building", dashboardId: sales.id, title: "", lastCostUsd: null });
  // On no board; nobody but Ana knows it exists.
  expect((await read<Board>(await s.board(s.owner, sales.id))).widgets).toEqual([]);
  expect((await s.api(s.owner, `/widgets/${draft.id}`)).status).toBe(404);
  expect((await s.api(s.owner, `/widgets/${draft.id}`, { method: "DELETE" })).status).toBe(404);
  // Its creator's view carries the step its build is in: none while it waits to start.
  expect(await read<Detail>(await s.api(s.ana, `/widgets/${draft.id}`))).toMatchObject({ draft: true, step: null });

  const confirm = {
    dashboardId: sales.id,
    size: "s",
    schedule: "day",
    alert: { enabled: true, condition: "drops 20%" },
  };
  // Not tested yet.
  const early = await s.api(s.ana, `/widgets/${draft.id}/confirm`, { json: confirm });
  expect(early.status).toBe(409);
  expect(await codeOf(early)).toBe("widget.not_tested");

  // Its test build worked (as an agent's `update_widget` leaves it).
  await t.db
    .update(schema.dashboardWidgets)
    .set({ status: "ok", kind: "kpi", spec: { kind: "kpi", value: 1284 }, title: "Site visits" })
    .where(eq(schema.dashboardWidgets.id, draft.id));
  // Only its creator confirms it, on a board they edit.
  expect((await s.api(s.owner, `/widgets/${draft.id}/confirm`, { json: confirm })).status).toBe(404);
  const toClosed = { ...confirm, dashboardId: closed.id };
  const elsewhere = await s.api(s.ana, `/widgets/${draft.id}/confirm`, { json: toClosed });
  expect(elsewhere.status).toBe(403);
  const bad = await s.api(s.ana, `/widgets/${draft.id}/confirm`, { json: { ...confirm, size: "xl" } });
  expect(bad.status).toBe(400);

  const made = await read<Widget>(await s.api(s.ana, `/widgets/${draft.id}/confirm`, { json: confirm }));
  expect(made).toMatchObject({
    id: draft.id,
    draft: false,
    dashboardId: sales.id,
    title: "Site visits",
    schedule: "day",
    alert: { enabled: true, condition: "drops 20%" },
    layout: { w: 1, h: 1 },
  });
  const shown = await read<Board>(await s.board(s.owner, sales.id));
  expect(shown.widgets.map((w) => w.id)).toEqual([draft.id]);
  expect((await s.api(s.ana, `/widgets/${draft.id}/confirm`, { json: confirm })).status).toBe(404);
});

test("cancelling a test deletes the draft; a person keeps five", async () => {
  const s = await start();
  const sales = await s.newBoard(s.owner, { title: "Sales" });
  const ask = { agentId: s.agentId, prompt: "Open orders", format: "list", schedule: "manual" };
  const ids: string[] = [];
  for (let i = 0; i < 6; i++) {
    const res = await s.api(s.owner, `/dashboards/${sales.id}/widgets/test`, { json: ask });
    ids.push((await read<Widget>(res, 202)).id);
  }
  // The oldest went.
  expect((await s.api(s.owner, `/widgets/${ids[0]}`)).status).toBe(404);
  const last = ids.at(-1) ?? "";
  expect((await s.api(s.owner, `/widgets/${last}`, { method: "DELETE" })).status).toBe(204);
  expect((await s.api(s.owner, `/widgets/${last}`)).status).toBe(404);
  const drafts = await t.db.select().from(schema.dashboardWidgets).where(eq(schema.dashboardWidgets.draft, true));
  expect(drafts).toHaveLength(4);
});

test("Rename keeps a person's title (ADR 0135 §17)", async () => {
  const s = await start();
  const sales = await s.newBoard(s.owner, { title: "Sales" });
  const w = await s.newWidget(s.owner, sales.id, { prompt: "Open orders by channel" });
  expect(w.title).toBe("");
  const renamed = await read<Widget>(
    await s.api(s.owner, `/widgets/${w.id}`, { method: "PATCH", json: { title: "Open orders" } }),
  );
  expect(renamed.title).toBe("Open orders");
  const [row] = await t.db.select().from(schema.dashboardWidgets).where(eq(schema.dashboardWidgets.id, w.id));
  expect(row?.titleSetByUser).toBe(true);
});

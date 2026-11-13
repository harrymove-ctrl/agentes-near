import { afterEach, expect, test } from "bun:test";
import {
  PERSONAL_SIDEBAR_ITEMS,
  PERSONAL_SIDEBAR_SECTIONS,
  SIDEBAR_COUNTED,
  SIDEBAR_ITEMS,
  SIDEBAR_SECTIONS,
  type SidebarItem,
  sidebarItemsOf,
  sidebarOrderOf,
  sidebarPlaceAllowed,
  sidebarToolOrderOf,
  sidebarViewOf,
} from "@agenteschat/engine";
import {
  SIDEBAR_COUNTED as APP_COUNTED,
  SIDEBAR_ITEMS as APP_ITEMS,
  PERSONAL_SIDEBAR_ITEMS as APP_PERSONAL_ITEMS,
  PERSONAL_SIDEBAR_SECTIONS as APP_PERSONAL_SECTIONS,
  SIDEBAR_SECTIONS as APP_SECTIONS,
  PERSONAL_SIDEBAR_DEFAULTS,
  SIDEBAR_DEFAULTS,
} from "../../../packages/client/src/lib/sidebar-items";
import { browser, createTestServer, joinByInvitation, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(() => t?.close());

test("the sidebar's tools: the engine and the apps know the same ones, and the apps' defaults are places it takes", () => {
  expect([...APP_ITEMS]).toEqual([...SIDEBAR_ITEMS]);
  expect([...APP_COUNTED]).toEqual([...SIDEBAR_COUNTED]);
  expect([...APP_SECTIONS]).toEqual([...SIDEBAR_SECTIONS]);
  for (const [item, place] of Object.entries(SIDEBAR_DEFAULTS))
    expect(sidebarPlaceAllowed(item as SidebarItem, place)).toBe(true);
});

test("a personal workspace's defaults (ADR 0159): the engine and the apps agree, every tool once, places it takes", () => {
  expect([...APP_PERSONAL_ITEMS]).toEqual([...PERSONAL_SIDEBAR_ITEMS]);
  expect([...APP_PERSONAL_SECTIONS]).toEqual([...PERSONAL_SIDEBAR_SECTIONS]);
  expect([...PERSONAL_SIDEBAR_ITEMS].sort()).toEqual([...SIDEBAR_ITEMS].sort());
  expect([...PERSONAL_SIDEBAR_SECTIONS].sort()).toEqual([...SIDEBAR_SECTIONS].sort());
  for (const [item, place] of Object.entries(PERSONAL_SIDEBAR_DEFAULTS))
    expect(sidebarPlaceAllowed(item as SidebarItem, place)).toBe(true);
  // A stored order still wins; nothing stored reads as the given default.
  expect(sidebarOrderOf(undefined, PERSONAL_SIDEBAR_SECTIONS)).toEqual([...PERSONAL_SIDEBAR_SECTIONS]);
  expect(sidebarOrderOf([...SIDEBAR_SECTIONS], PERSONAL_SIDEBAR_SECTIONS)).toEqual([...SIDEBAR_SECTIONS]);
  expect(sidebarToolOrderOf(undefined, PERSONAL_SIDEBAR_ITEMS)).toEqual([...PERSONAL_SIDEBAR_ITEMS]);
});

test("a stored tools' order is never trusted as is: unknown tools dropped, repeats once, new tools at the end", () => {
  expect(sidebarToolOrderOf(["calendar", "nope", "calendar", "drive"])).toEqual([
    "calendar",
    "drive",
    ...SIDEBAR_ITEMS.filter((i) => i !== "calendar" && i !== "drive"),
  ]);
  expect(sidebarToolOrderOf("drive")).toEqual([...SIDEBAR_ITEMS]);
});

test("a saved layout holding a removed tool and an unknown one reads as the tools this build knows", () => {
  expect(sidebarItemsOf({ forum: "always", from_a_newer_server: "more", wiki: "always" })).toEqual({ wiki: "always" });
  expect(sidebarToolOrderOf(["forum", "drive", "from_a_newer_server"])).toEqual([
    "drive",
    ...SIDEBAR_ITEMS.filter((i) => i !== "drive"),
  ]);
  expect(sidebarOrderOf(["forum", "tools", "channels", "agents", "people"])).toEqual([...SIDEBAR_SECTIONS]);
});

test("a stored sidebar view is never trusted as is: known orders only, each pin once, five at most", () => {
  expect(sidebarViewOf(undefined)).toEqual({ agentSort: "workspace", showAllAgents: false, pins: null });
  expect(
    sidebarViewOf({
      agentSort: "nope",
      showAllAgents: "yes",
      pins: { agents: ["a", "a", 3, "b"], channels: ["1", "2", "3", "4", "5", "6"], extra: ["x"] },
    }),
  ).toEqual({
    agentSort: "workspace",
    showAllAgents: false,
    pins: { agents: ["a", "b"], channels: ["1", "2", "3", "4", "5"], people: [] },
  });
});

/** A new workspace, set up (one still in its onboarding would come back instead of another). */
async function workspace(b: ReturnType<typeof browser>, name: string) {
  const created = (await (await b("/api/app/organizations", { json: { name } })).json()) as {
    organization: { id: string };
  };
  const orgId = created.organization.id;
  await b(`/api/app/organizations/${orgId}/onboarding`, { method: "PATCH", json: { finished: true } });
  return orgId;
}

test("the sidebar's tools: each person's own, per workspace, known tools and places only", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const orgId = await workspace(owner, "Acme");
  const sidebar = `/api/app/organizations/${orgId}/me/sidebar`;
  const items = async (b = owner, path = sidebar) => ((await (await b(path)).json()) as { items: unknown }).items;

  // Nothing moved yet: every tool on the app's default.
  expect(await items()).toEqual({});

  const saved = await owner(sidebar, { method: "PUT", json: { items: { wiki: "always", approvals: "more" } } });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual({ items: { wiki: "always", approvals: "more" } });
  expect(await items()).toEqual({ wiki: "always", approvals: "more" });

  // A tool or a place the app doesn't know, or "when there's something" for a tool with no count: refused, kept.
  for (const bad of [{ settings: "always" }, { wiki: "hidden" }, { wiki: "auto" }, { approvals: null }])
    expect((await owner(sidebar, { method: "PUT", json: { items: bad } })).status).toBe(400);
  expect(await items()).toEqual({ wiki: "always", approvals: "more" });
  expect((await owner(sidebar, { method: "PUT", json: { items: { threads: "auto" } } })).status).toBe(200);

  // Someone else in the workspace keeps their own; so does the owner in another workspace.
  const member = await joinByInvitation(t, owner, orgId, "member@example.com");
  expect(await items(member)).toEqual({});
  await member(sidebar, { method: "PUT", json: { items: { calendar: "always" } } });
  expect(await items()).toEqual({ threads: "auto" });
  const other = await workspace(owner, "Beta");
  expect(await items(owner, `/api/app/organizations/${other}/me/sidebar`)).toEqual({});

  // "Restaurar o padrão".
  expect(await (await owner(sidebar, { method: "PUT", json: { items: {} } })).json()).toEqual({ items: {} });
  expect(await items(member)).toEqual({ calendar: "always" });

  // Not a member (invited, not in yet): refused.
  await owner(`/api/app/organizations/${orgId}/invitations`, { json: { email: "stranger@example.com" } });
  const stranger = browser(t);
  await signUp(stranger, "stranger@example.com");
  expect((await stranger(sidebar)).status).toBe(403);
  expect((await stranger(sidebar, { method: "PUT", json: { items: {} } })).status).toBe(403);
});

test("one tool at a time: the server keeps the other choices, so a device that never heard of them can't undo them", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const orgId = await workspace(owner, "Acme");
  const sidebar = `/api/app/organizations/${orgId}/me/sidebar`;
  const move = (json: unknown, b = owner) => b(sidebar, { method: "PATCH", json });
  const items = async () => ((await (await owner(sidebar)).json()) as { items: unknown }).items;

  // The browser puts Wiki in the list; the desktop app, loaded before that, moves Drive to More.
  expect(await (await move({ item: "wiki", place: "always" })).json()).toEqual({ items: { wiki: "always" } });
  expect(await (await move({ item: "drive", place: "more" })).json()).toEqual({
    items: { wiki: "always", drive: "more" },
  });
  expect(await (await move({ item: "approvals", place: "auto" })).json()).toEqual({
    items: { wiki: "always", drive: "more", approvals: "auto" },
  });

  // Back on its default: the tool leaves the choices, the others stay.
  expect(await (await move({ item: "wiki", place: null })).json()).toEqual({
    items: { drive: "more", approvals: "auto" },
  });

  // A tool or a place the app doesn't know, "when there's something" for a tool with no count, no place: refused, kept.
  for (const bad of [
    { item: "settings", place: "always" },
    { item: "wiki", place: "hidden" },
    { item: "wiki", place: "auto" },
    { item: "wiki" },
  ])
    expect((await move(bad)).status).toBe(400);
  expect(await items()).toEqual({ drive: "more", approvals: "auto" });

  // Not a member (invited, not in yet): refused.
  await owner(`/api/app/organizations/${orgId}/invitations`, { json: { email: "stranger@example.com" } });
  const stranger = browser(t);
  await signUp(stranger, "stranger@example.com");
  expect((await move({ item: "wiki", place: "always" }, stranger)).status).toBe(403);
  expect(await items()).toEqual({ drive: "more", approvals: "auto" });
});

test("the sections' order: each person's own, per workspace, every section once, beside the tools' places", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const orgId = await workspace(owner, "Acme");
  const sidebar = `/api/app/organizations/${orgId}/me/sidebar`;
  const order = async (b = owner) => ((await (await b(`${sidebar}/order`)).json()) as { order: unknown }).order;
  const put = (json: unknown, b = owner) => b(`${sidebar}/order`, { method: "PUT", json });

  expect(await order()).toEqual(["tools", "channels", "agents", "people"]);
  await owner(sidebar, { method: "PATCH", json: { item: "wiki", place: "always" } });

  const agentsFirst = ["agents", "people", "tools", "channels"];
  const saved = await put({ order: agentsFirst });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual({ order: agentsFirst });
  expect(await order()).toEqual(agentsFirst);
  // The tools' places stay, and a reset of the tools keeps the order.
  expect(((await (await owner(sidebar)).json()) as { items: unknown }).items).toEqual({ wiki: "always" });
  await owner(sidebar, { method: "PUT", json: { items: {} } });
  expect(await order()).toEqual(agentsFirst);
  await owner(sidebar, { method: "PATCH", json: { item: "drive", place: "more" } });
  expect(await order()).toEqual(agentsFirst);

  // A section missing, twice or unknown: refused, kept.
  for (const bad of [
    ["agents", "people", "tools"],
    ["agents", "agents", "tools", "channels"],
    ["agents", "people", "tools", "drive"],
  ])
    expect((await put({ order: bad })).status).toBe(400);
  expect(await order()).toEqual(agentsFirst);

  // Someone else keeps their own.
  const member = await joinByInvitation(t, owner, orgId, "member@example.com");
  expect(await order(member)).toEqual(["tools", "channels", "agents", "people"]);

  // "Restaurar ordem padrão".
  expect(await (await put({ order: null })).json()).toEqual({ order: ["tools", "channels", "agents", "people"] });
  expect(((await (await owner(sidebar)).json()) as { items: unknown }).items).toEqual({ drive: "more" });
});

test("the tools' order: each person's own, per workspace, every tool once, beside the places and the sections", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const orgId = await workspace(owner, "Acme");
  const sidebar = `/api/app/organizations/${orgId}/me/sidebar`;
  const order = async (b = owner) => ((await (await b(`${sidebar}/tools`)).json()) as { order: unknown }).order;
  const put = (json: unknown, b = owner) => b(`${sidebar}/tools`, { method: "PUT", json });

  expect(await order()).toEqual([...SIDEBAR_ITEMS]);
  await owner(sidebar, { method: "PATCH", json: { item: "wiki", place: "always" } });
  await owner(`${sidebar}/order`, { method: "PUT", json: { order: ["people", "tools", "channels", "agents"] } });

  const driveFirst = [
    "drive",
    "approvals",
    "proposals",
    "threads",
    "issues",
    "wiki",
    "routines",
    "calendar",
    "team",
    "dashboards",
    "taskManager",
  ];
  const saved = await put({ order: driveFirst });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual({ order: driveFirst });
  expect(await order()).toEqual(driveFirst);
  // The places and the sections' order stay; a reset of the places, or one place moved, keeps the tools' order.
  expect(((await (await owner(sidebar)).json()) as { items: unknown }).items).toEqual({ wiki: "always" });
  await owner(sidebar, { method: "PUT", json: { items: {} } });
  await owner(sidebar, { method: "PATCH", json: { item: "calendar", place: "always" } });
  expect(await order()).toEqual(driveFirst);
  expect(((await (await owner(`${sidebar}/order`)).json()) as { order: unknown }).order).toEqual([
    "people",
    "tools",
    "channels",
    "agents",
  ]);

  // A tab left open across a deploy: a tool it never knew drops, one it lacks goes to the end, a repeat counts once.
  const forgotten = [...driveFirst.slice(1), "drive"];
  for (const stale of [driveFirst.slice(1), ["settings", ...driveFirst.slice(1)], [...forgotten, "drive"]]) {
    const res = await put({ order: stale });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ order: forgotten });
  }
  expect((await put({ order: "drive" })).status).toBe(400);
  await put({ order: driveFirst });
  expect(await order()).toEqual(driveFirst);

  // Someone else keeps their own.
  const member = await joinByInvitation(t, owner, orgId, "member@example.com");
  expect(await order(member)).toEqual([...SIDEBAR_ITEMS]);

  // Back to the default; the places stay.
  expect(await (await put({ order: null })).json()).toEqual({ order: [...SIDEBAR_ITEMS] });
  expect(((await (await owner(sidebar)).json()) as { items: unknown }).items).toEqual({ calendar: "always" });
});

test("the sidebar view: each person's own, per workspace, beside the tools' places and both orders", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const orgId = await workspace(owner, "Acme");
  const sidebar = `/api/app/organizations/${orgId}/me/sidebar`;
  const view = async (b = owner) => ((await (await b(`${sidebar}/view`)).json()) as { view: unknown }).view;
  const put = (json: unknown, b = owner) => b(`${sidebar}/view`, { method: "PUT", json });

  // Never saved: no pins yet, so the apps pin the person's own agents.
  expect(await view()).toEqual({ agentSort: "workspace", showAllAgents: false, pins: null });
  await owner(sidebar, { method: "PATCH", json: { item: "wiki", place: "always" } });
  const mine = {
    agentSort: "mine",
    showAllAgents: true,
    pins: { agents: ["agent-1"], channels: ["channel-1", "channel-2"], people: [] },
  };
  const saved = await put({ view: mine });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual({ view: mine });
  expect(await view()).toEqual(mine);
  // Resetting the tools' places keeps the view, and the view keeps the places.
  await owner(sidebar, { method: "PUT", json: { items: {} } });
  expect(await view()).toEqual(mine);

  // Six pins in a section, or an order the apps don't know: refused, kept.
  const six = { ...mine, pins: { ...mine.pins, channels: ["1", "2", "3", "4", "5", "6"] } };
  expect((await put({ view: six })).status).toBe(400);
  expect((await put({ view: { ...mine, agentSort: "alphabetical" } })).status).toBe(400);
  expect(await view()).toEqual(mine);

  // Someone else keeps their own.
  const member = await joinByInvitation(t, owner, orgId, "member@example.com");
  expect(await view(member)).toEqual({ agentSort: "workspace", showAllAgents: false, pins: null });
});

test("a personal workspace reads its own default orders (ADR 0159); a saved order stays, the team's included", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const orgId = await workspace(owner, "Acme");
  const sidebar = `/api/app/organizations/${orgId}/me/sidebar`;
  const read = async (path: string) => ((await (await owner(path)).json()) as { order: unknown }).order;
  const setMode = (mode: string) =>
    owner(`/api/app/organizations/${orgId}/settings`, { method: "PATCH", json: { mode } });

  expect((await setMode("personal")).status).toBe(200);
  expect(await read(`${sidebar}/order`)).toEqual([...PERSONAL_SIDEBAR_SECTIONS]);
  expect(await read(`${sidebar}/tools`)).toEqual([...PERSONAL_SIDEBAR_ITEMS]);

  // The agents under the channels, as a team has them, is a choice here: it stays.
  await owner(`${sidebar}/order`, { method: "PUT", json: { order: [...SIDEBAR_SECTIONS] } });
  expect(await read(`${sidebar}/order`)).toEqual([...SIDEBAR_SECTIONS]);
  // Back to the default: the personal one.
  expect(await (await owner(`${sidebar}/order`, { method: "PUT", json: { order: null } })).json()).toEqual({
    order: [...PERSONAL_SIDEBAR_SECTIONS],
  });

  // A team again: the team's defaults, for what nobody saved.
  expect((await setMode("team")).status).toBe(200);
  expect(await read(`${sidebar}/order`)).toEqual([...SIDEBAR_SECTIONS]);
  expect(await read(`${sidebar}/tools`)).toEqual([...SIDEBAR_ITEMS]);
});

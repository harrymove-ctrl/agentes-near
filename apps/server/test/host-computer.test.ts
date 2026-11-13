import { afterEach, expect, test } from "bun:test";
import { ConfigError, testConfig } from "@agenteschat/config";
import { eq, schema } from "@agenteschat/db";
import { authenticateMachine, retireHostTokens } from "@agenteschat/engine";
import { type Browser, browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

const TOKEN = "host-computer-token-".padEnd(48, "h");
let t: TestServer;
afterEach(() => t.close());

type Synced = { orgs: { orgId: string; orgName: string; machineId: string; token?: string }[] };

/** The runner's call: no cookie, its bearer. */
const sync = (body: Record<string, unknown> = {}, token = TOKEN) =>
  t.app.request("/api/machines/host/sync", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.20",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      name: "Servidor",
      hostname: "srv",
      os: "linux",
      arch: "x64",
      runnerVersion: "1.0",
      ...body,
    }),
  });

async function synced(body: Record<string, unknown> = {}) {
  const res = await sync(body);
  expect(res.status).toBe(200);
  return ((await res.json()) as Synced).orgs;
}

const userId = async (email: string) =>
  (await t.db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email)))[0]?.id ?? "";

async function start() {
  t = await createTestServer({ env: { HOST_COMPUTER_TOKEN: TOKEN } });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const seeded = await seedOrg(owner);
  const api = (path: string, init?: Parameters<Browser>[1]) =>
    owner(`/api/app/organizations/${seeded.orgId}${path}`, init);
  return { owner, api, ...seeded };
}

test("off without HOST_COMPUTER_TOKEN: the sync is 404 and no organization gets the computer", async () => {
  t = await createTestServer();
  expect((await sync()).status).toBe(404);
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  expect((await owner(`/api/app/organizations/${orgId}/machines/host`)).status).toBe(404);
  expect(await t.db.select().from(schema.machines)).toEqual([]);
});

test("a wrong or missing token is 401; the server won't start with it and open sign-up", async () => {
  await start();
  expect((await sync({}, "x".repeat(48))).status).toBe(401);
  expect((await sync({}, "")).status).toBe(401);
  expect(() => testConfig({ HOST_COMPUTER_TOKEN: TOKEN, ALLOW_SIGNUP: "true" })).toThrow(ConfigError);
  expect(() => testConfig({ HOST_COMPUTER_TOKEN: "too-short" })).toThrow(ConfigError);
});

test("one computer per organization of the first account, its own token each; nobody else's organizations", async () => {
  const { owner, api, orgId, agentId } = await start();
  // The row is there with the organization (onboarding offers it); its token comes with the sync.
  const before = (await (await api("/machines")).json()) as { machines: { id: string; kind: string }[] };
  expect(before.machines).toEqual([expect.objectContaining({ kind: "host", online: false, agents: [] })]);
  expect(await (await api("/machines/host")).json()).toEqual({ machineId: before.machines[0]?.id, on: true });

  // Someone invited makes an organization of their own: it isn't served.
  const bia = await joinByInvitation(t, owner, orgId, "bia@example.com");
  const created = (await (await bia("/api/app/organizations", { json: { name: "Beta" } })).json()) as {
    organization: { id: string };
  };
  const betaId = created.organization.id;

  const [acme, ...rest] = await synced();
  expect(rest).toEqual([]);
  expect(acme).toMatchObject({ orgId, orgName: "Acme", machineId: before.machines[0]?.id });
  expect(acme?.token).toStartWith("agm_");
  const row = await authenticateMachine(t.db, acme?.token ?? "");
  expect(row).toMatchObject({ kind: "host", orgId, pairedByUserId: await userId("owner@example.com") });
  // The agent with no computer uses it now.
  const list = (await (await api("/machines")).json()) as { machines: { kind: string; agents: { id: string }[] }[] };
  expect(list.machines).toEqual([
    expect.objectContaining({ kind: "host", name: "Servidor", agents: [expect.objectContaining({ id: agentId })] }),
  ]);
  expect(await t.db.select().from(schema.machines).where(eq(schema.machines.orgId, betaId))).toEqual([]);

  // Holding it: no token. Refused (rotate) or lost (not in `have`): a new one, and the old one stops working.
  expect(await synced({ have: [orgId] })).toEqual([{ orgId, orgName: "Acme", machineId: row?.id ?? "" }]);
  const [rotated] = await synced({ have: [orgId], rotate: [orgId] });
  expect(rotated?.token).toStartWith("agm_");
  expect(await authenticateMachine(t.db, acme?.token ?? "")).toBeNull();
  const [lost] = await synced();
  expect(lost?.token).not.toBe(rotated?.token);
  expect(await authenticateMachine(t.db, rotated?.token ?? "")).toBeNull();

  // Bia can make the first account an admin (the Admin role), even an owner, of Beta on her own: Beta still isn't
  // served.
  await joinByInvitation(t, bia, betaId, "owner@example.com", { role: "admin", as: owner });
  const ownerId = await userId("owner@example.com");
  const biaId = await userId("bia@example.com");
  expect((await synced({ have: [orgId] })).map((o) => o.orgId)).toEqual([orgId]);
  const setRole = async (by: Browser, org: string, who: string, role: "owner" | "member") =>
    (await by(`/api/app/organizations/${org}/members/${who}`, { method: "PATCH", json: { role } })).status;
  expect(await setRole(bia, betaId, ownerId, "owner")).toBe(204);
  expect((await synced({ have: [orgId] })).map((o) => o.orgId)).toEqual([orgId]);
  expect(await t.db.select().from(schema.machines).where(eq(schema.machines.orgId, betaId))).toEqual([]);

  // Acme, which the first account made: served while it runs it; made a member there, its token stops working.
  expect(await setRole(owner, orgId, biaId, "owner")).toBe(204);
  expect(await setRole(bia, orgId, ownerId, "member")).toBe(204);
  expect(await synced({ have: [orgId] })).toEqual([]);
  expect(await authenticateMachine(t.db, lost?.token ?? "")).toBeNull();
});

test("an admin stops it in an organization (skipped from then on) and turns it back on", async () => {
  const { owner, api, orgId, agentId } = await start();
  const [first] = await synced();
  const machineId = first?.machineId ?? "";
  expect((await api(`/machines/${machineId}`, { method: "DELETE" })).status).toBe(204);
  expect(await (await api("/machines/host")).json()).toEqual({ machineId, on: false });
  expect(await synced({ have: [orgId] })).toEqual([]);
  expect(await authenticateMachine(t.db, first?.token ?? "")).toBeNull();
  const [agent] = await t.db.select().from(schema.agents).where(eq(schema.agents.id, agentId));
  expect(agent?.machineId).toBeNull();

  // Members can't turn it back on.
  const bia = await joinByInvitation(t, owner, orgId, "bia@example.com");
  expect((await bia(`/api/app/organizations/${orgId}/machines/host`, { json: {} })).status).toBe(403);

  expect(await (await api("/machines/host", { json: {} })).json()).toEqual({ machineId, on: true });
  // The same row, a new token at the next sync, and the agent back on it.
  const [back] = await synced({ have: [orgId] });
  expect(back).toMatchObject({ orgId, machineId });
  expect(back?.token).toStartWith("agm_");
  const [again] = await t.db.select().from(schema.agents).where(eq(schema.agents.id, agentId));
  expect(again?.machineId).toBe(machineId);
});

test("a server started with another HOST_COMPUTER_TOKEN (or none) retires every organization's token", async () => {
  const { orgId } = await start();
  const [first] = await synced();
  expect(await retireHostTokens(t.db, TOKEN)).toBe(0);
  expect(await authenticateMachine(t.db, first?.token ?? "")).not.toBeNull();
  expect(await retireHostTokens(t.db, "another-host-token-".padEnd(48, "z"))).toBe(1);
  expect(await authenticateMachine(t.db, first?.token ?? "")).toBeNull();
  // The runner with the right token gets a new one at its next sync, though it still holds the old one.
  const [again] = await synced({ have: [orgId] });
  expect(again?.token).toStartWith("agm_");
  expect(await retireHostTokens(t.db, undefined)).toBe(1);
  expect(await authenticateMachine(t.db, again?.token ?? "")).toBeNull();
});

test("the OpenAPI document lists the sync and the organization's switch", async () => {
  await start();
  const doc = (await (await t.app.request("/api/openapi.json")).json()) as { paths: Record<string, unknown> };
  expect(Object.keys(doc.paths)).toContain("/machines/host/sync");
  expect(Object.keys(doc.paths)).toContain("/app/organizations/{orgId}/machines/host");
});

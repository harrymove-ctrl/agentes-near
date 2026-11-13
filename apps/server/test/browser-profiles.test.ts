import { afterEach, beforeEach, expect, test } from "bun:test";
import { BROWSER_PROFILE_PROTOCOL, type MachineRequest } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import { parseBrowserClientFrame } from "../src/realtime/browser";
import { browser, createTestServer, joinByInvitation, pairComputer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
});
afterEach(async () => {
  await t.close();
});

/** An owner, its agent on a computer at the profiles protocol, and the computer's answers recorded. */
async function seeded() {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const org = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${org.orgId}${path}`, init);
  const machine = await pairComputer(t, api, { os: "linux", arch: "x64", hostname: "box", version: "0.3.0" });
  await t.db
    .update(schema.machines)
    .set({ protocol: BROWSER_PROFILE_PROTOCOL })
    .where(eq(schema.machines.id, machine.machineId));
  const hub = t.engine.machineHub;
  const asked: MachineRequest[] = [];
  hub.call = (async (_machineId: string, request: MachineRequest) => {
    asked.push(request);
    if (request.op === "browser.warm") return { started: true };
    if (request.op === "browser.profile.delete") return { deleted: true };
    return { success: true, data: { url: "https://chat.example/" } };
  }) as typeof hub.call;
  return { owner, org, api, machine, asked };
}

const json = async <T>(res: Response) => (await res.json()) as T;
type Profile = { id: string; name: string; agentIds: string[]; holder: { type: string } | null };

test("profiles: created for the chosen agents, renamed, regranted, deleted; only apps-and-computers people may", async () => {
  const { owner, org, api, machine, asked } = await seeded();
  const member = await joinByInvitation(t, owner, org.orgId, "rui@example.com");
  const asMember = (path: string, init?: Parameters<typeof member>[1]) =>
    member(`/api/app/organizations/${org.orgId}${path}`, init);
  const body = { machineId: machine.machineId, name: "Shop chat", agentIds: [] as string[] };
  expect((await asMember("/browser-profiles", { json: body })).status).toBe(403);
  const created = await api("/browser-profiles", { json: body });
  expect(created.status).toBe(200);
  const p = await json<Profile>(created);
  expect(p).toMatchObject({ name: "Shop chat", agentIds: [], holder: null });
  expect((await api("/browser-profiles", { json: body })).status).toBe(409);
  // Everyone sees the list.
  expect((await json<{ profiles: Profile[] }>(await asMember("/browser-profiles"))).profiles.map((x) => x.id)).toEqual([
    p.id,
  ]);
  expect(
    (await asMember(`/browser-profiles/${p.id}`, { method: "PATCH", json: { agentIds: [org.agentId] } })).status,
  ).toBe(403);
  const granted = await api(`/browser-profiles/${p.id}`, {
    method: "PATCH",
    json: { name: "Shop chat · sales", agentIds: [org.agentId] },
  });
  expect(await json<Profile>(granted)).toMatchObject({ name: "Shop chat · sales", agentIds: [org.agentId] });
  // The agent's default, among the profiles it has.
  expect(
    (await api(`/agents/${org.agentId}/browser-profile`, { method: "PUT", json: { profileId: p.id } })).status,
  ).toBe(204);
  expect((await json<{ profileId: string | null }>(await api(`/agents/${org.agentId}/browser`))).profileId).toBe(p.id);
  expect((await asMember(`/browser-profiles/${p.id}`, { method: "DELETE" })).status).toBe(403);
  expect((await api(`/browser-profiles/${p.id}`, { method: "DELETE" })).status).toBe(204);
  expect(asked.some((r) => r.op === "browser.profile.delete" && r.profile?.id === p.id)).toBe(true);
  expect((await json<{ profileId: string | null }>(await api(`/agents/${org.agentId}/browser`))).profileId).toBeNull();
  const actions = await t.db
    .select({ action: schema.auditLog.action })
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.orgId, org.orgId), eq(schema.auditLog.targetId, p.id)));
  expect(actions.map((a) => a.action).sort()).toEqual(
    ["browser_profile.created", "browser_profile.deleted", "browser_profile.granted", "browser_profile.renamed"].sort(),
  );
});

test("Fazer login: control, open a site only while in control, Devolver; the live view's key parses", async () => {
  const { org, api, machine, asked } = await seeded();
  const p = await json<Profile>(
    await api("/browser-profiles", { json: { machineId: machine.machineId, name: "Shop chat" } }),
  );
  const open = { json: { url: "chat.example" } };
  expect((await api(`/browser-profiles/${p.id}/open`, open)).status).toBe(409);
  const taken = await api(`/browser-profiles/${p.id}/takeover`, { json: {} });
  expect(taken.status).toBe(200);
  expect((await json<Profile>(taken)).holder).toMatchObject({ type: "person" });
  expect(asked.some((r) => r.op === "browser.warm" && r.profile?.id === p.id)).toBe(true);
  expect((await api(`/browser-profiles/${p.id}/open`, open)).status).toBe(204);
  expect(asked.find((r) => r.op === "browser.act")).toMatchObject({
    command: "open",
    args: ["https://chat.example/"],
    profile: { id: p.id },
  });
  expect((await json<Profile>(await api(`/browser-profiles/${p.id}/handback`, { json: {} }))).holder).toBeNull();
  expect(parseBrowserClientFrame(JSON.stringify({ type: "browser.watch", agentId: `profile:${p.id}` }))).toEqual({
    type: "browser.watch",
    agentId: `profile:${p.id}`,
  });
  expect(parseBrowserClientFrame(JSON.stringify({ type: "browser.watch", agentId: "profile:../x" }))).toBeNull();
  void org;
});

test("an agent's owner asks for a profile but can't grant one", async () => {
  const { owner, org, api, machine } = await seeded();
  const member = await joinByInvitation(t, owner, org.orgId, "ana@example.com");
  const [ana] = await t.db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, "ana@example.com"));
  await t.db
    .update(schema.agents)
    .set({ ownerUserId: ana?.id ?? "" })
    .where(eq(schema.agents.id, org.agentId));
  const p = await json<Profile>(
    await api("/browser-profiles", { json: { machineId: machine.machineId, name: "Shop chat" } }),
  );
  const asAna = (path: string, init?: Parameters<typeof member>[1]) =>
    member(`/api/app/organizations/${org.orgId}${path}`, init);
  expect(
    (await asAna(`/browser-profiles/${p.id}`, { method: "PATCH", json: { agentIds: [org.agentId] } })).status,
  ).toBe(403);
  // Not granted yet: it can't be her agent's default.
  expect(
    (await asAna(`/agents/${org.agentId}/browser-profile`, { method: "PUT", json: { profileId: p.id } })).status,
  ).toBe(400);
  expect((await asAna(`/agents/${org.agentId}/browser-profile/request`, { json: {} })).status).toBe(204);
  const asked = await t.db
    .select({ kind: schema.notifications.kind })
    .from(schema.notifications)
    .where(eq(schema.notifications.kind, "browser_profile_request"));
  expect(asked.length).toBe(1);
});

test("an agent's owner can take their own agent off a profile, but not someone else's", async () => {
  const { owner, org, api, machine } = await seeded();
  const member = await joinByInvitation(t, owner, org.orgId, "ana@example.com");
  const [ana] = await t.db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, "ana@example.com"));
  const p = await json<Profile>(
    await api("/browser-profiles", {
      json: { machineId: machine.machineId, name: "Shop chat", agentIds: [org.agentId] },
    }),
  );
  const asAna = (path: string, init?: Parameters<typeof member>[1]) =>
    member(`/api/app/organizations/${org.orgId}${path}`, init);
  // Not her agent yet.
  expect((await asAna(`/browser-profiles/${p.id}`, { method: "PATCH", json: { agentIds: [] } })).status).toBe(403);
  await t.db
    .update(schema.agents)
    .set({ ownerUserId: ana?.id ?? "" })
    .where(eq(schema.agents.id, org.agentId));
  const res = await asAna(`/browser-profiles/${p.id}`, { method: "PATCH", json: { agentIds: [] } });
  expect(res.status).toBe(200);
  expect((await json<Profile>(res)).agentIds).toEqual([]);
  // Taking off is all she may do: giving it back is still an admin's.
  expect(
    (await asAna(`/browser-profiles/${p.id}`, { method: "PATCH", json: { agentIds: [org.agentId] } })).status,
  ).toBe(403);
});

test("a system-mode computer refuses every profile call: create, list, change, Fazer login, default", async () => {
  const { org, api, machine } = await seeded();
  const p = await json<Profile>(
    await api("/browser-profiles", {
      json: { machineId: machine.machineId, name: "Shop chat", agentIds: [org.agentId] },
    }),
  );
  await t.db
    .update(schema.machines)
    .set({ executors: { mode: "system" } })
    .where(eq(schema.machines.id, machine.machineId));
  const refused = async (res: Response) => {
    expect(res.status).toBe(400);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("browser_profile.system_mode");
  };
  await refused(await api("/browser-profiles", { json: { machineId: machine.machineId, name: "Other" } }));
  await refused(await api(`/browser-profiles?machineId=${machine.machineId}`));
  await refused(await api(`/browser-profiles/${p.id}`, { method: "PATCH", json: { name: "Renamed" } }));
  await refused(await api(`/browser-profiles/${p.id}/takeover`, { json: {} }));
  await refused(await api(`/browser-profiles/${p.id}/open`, { json: { url: "chat.example" } }));
  await refused(await api(`/agents/${org.agentId}/browser-profile`, { method: "PUT", json: { profileId: p.id } }));
  expect((await json<{ profiles: Profile[] }>(await api("/browser-profiles"))).profiles).toEqual([]);
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import { currentSubscriptions } from "../src/realtime/ws";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["Feito."] }) });
});
afterEach(() => t.close());

type B = ReturnType<typeof browser>;
type Issue = { id: string; number: number; title: string; audience: { mode: string; userIds: string[] } };

/** The owner, two members and an administrator who is in nothing, with the workspace's API for each. */
async function team() {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const ana = await joinByInvitation(t, owner, orgId, "ana@example.com");
  const bia = await joinByInvitation(t, owner, orgId, "bia@example.com");
  const adm = await joinByInvitation(t, owner, orgId, "adm@example.com", { role: "admin" });
  const api = (b: B, path: string, init?: Parameters<B>[1]) => b(`/api/app/organizations/${orgId}${path}`, init);
  const { members } = (await (await api(owner, "/members")).json()) as {
    members: { userId: string; email: string }[];
  };
  const id = (email: string) => members.find((m) => m.email === email)?.userId ?? "";
  return {
    orgId,
    owner,
    ana,
    bia,
    adm,
    api,
    anaId: id("ana@example.com"),
    biaId: id("bia@example.com"),
    admId: id("adm@example.com"),
  };
}

test("a task's audience through the routes: create, every read, change, activity, the old share", async () => {
  const { ana, bia, adm, api, anaId, biaId } = await team();
  const made = await api(ana, "/issues", {
    json: { title: "Só minha", audience: { mode: "people", userIds: [anaId] } },
  });
  expect(made.status).toBe(201);
  const task = (await made.json()) as Issue;
  expect(task.audience).toMatchObject({ mode: "people", userIds: [anaId], channelId: null });

  const titles = async (b: B) =>
    ((await (await api(b, "/issues")).json()) as { issues: Issue[] }).issues.map((i) => i.title);
  expect(await titles(ana)).toEqual(["Só minha"]);
  expect(await titles(adm)).toEqual(["Só minha"]);
  expect(await titles(bia)).toEqual([]);
  expect((await api(bia, `/issues/by-number/${task.number}`)).status).toBe(404);
  expect((await api(bia, `/issues/${task.id}/activity`)).status).toBe(404);
  expect((await api(bia, `/issues/${task.id}/conversation`, { method: "POST", json: {} })).status).toBe(404);
  expect((await api(bia, `/issues/${task.id}`, { method: "PATCH", json: { status: "done" } })).status).toBe(404);
  const changing = { method: "PUT" as const, json: { mode: "everyone" } };
  expect((await api(bia, `/issues/${task.id}/audience`, changing)).status).toBe(404);

  const shared = await api(ana, `/issues/${task.id}/audience`, {
    method: "PUT",
    json: { mode: "people", userIds: [anaId, biaId] },
  });
  expect(shared.status).toBe(200);
  expect(await titles(bia)).toEqual(["Só minha"]);
  const refused = await api(ana, `/issues/${task.id}/audience`, {
    method: "PUT",
    json: { mode: "people", userIds: ["nobody"] },
  });
  expect(refused.status).toBe(200);
  expect(((await refused.json()) as Issue).audience.userIds).toEqual([anaId]);

  expect((await api(ana, `/issues/${task.id}/share`, { method: "POST", json: {} })).status).toBe(200);
  expect(await titles(bia)).toEqual(["Só minha"]);
  const { activity } = (await (await api(ana, `/issues/${task.id}/activity`)).json()) as {
    activity: { event?: string; textCode?: string }[];
  };
  expect(activity.filter((a) => a.event === "audience_changed").map((a) => a.textCode)).toEqual([
    "audience_people",
    "audience_people",
    "audience_everyone",
  ]);
});

test("administrators through the routes: a private channel opens and joins; a DM of others never; the socket too", async () => {
  const { orgId, ana, bia, adm, api, biaId, admId } = await team();
  const room = (await (await api(ana, "/channels", { json: { name: "secreto", visibility: "private" } })).json()) as {
    id: string;
  };
  await api(ana, `/channels/${room.id}/messages`, { json: { body: "Fusão" } });
  const { channelId: dm } = (await (await api(ana, "/dms", { json: { userId: biaId } })).json()) as {
    channelId: string;
  };
  await api(ana, `/channels/${dm}/messages`, { json: { body: "Reservado" } });

  const listed = async (b: B) =>
    (
      (await (await api(b, "/channels")).json()) as {
        channels: { id: string; isMember: boolean; seenAsAdmin?: boolean }[];
      }
    ).channels;
  expect((await listed(adm)).find((c) => c.id === room.id)).toMatchObject({ isMember: false, seenAsAdmin: true });
  expect((await listed(bia)).some((c) => c.id === room.id)).toBe(false);
  expect((await api(adm, `/channels/${room.id}/messages`)).status).toBe(200);
  expect((await api(bia, `/channels/${room.id}/messages`)).status).toBe(403);
  expect((await api(adm, `/channels/${dm}/messages`)).status).toBe(403);

  const subscribed = await currentSubscriptions(t.db, admId, orgId, [room.id, dm]);
  expect([...(subscribed ?? [])]).toEqual([room.id]);

  expect((await api(adm, `/channels/${dm}/join`, { method: "POST", json: {} })).status).toBe(403);
  expect((await api(bia, `/channels/${room.id}/join`, { method: "POST", json: {} })).status).toBe(403);
  expect((await api(adm, `/channels/${room.id}/join`, { method: "POST", json: {} })).status).toBeLessThan(300);
  expect((await listed(adm)).find((c) => c.id === room.id)).toMatchObject({ isMember: true, seenAsAdmin: false });
});

test("an administrator opens the threads and missions of a channel they aren't in; a DM's stay closed", async () => {
  const { ana, bia, adm, api, biaId } = await team();
  const room = (await (await api(ana, "/channels", { json: { name: "secreto", visibility: "private" } })).json()) as {
    id: string;
  };
  const root = (await (await api(ana, `/channels/${room.id}/messages`, { json: { body: "Pergunta" } })).json()) as {
    id: string;
  };
  await api(ana, `/channels/${room.id}/messages`, { json: { body: "Resposta", threadId: root.id } });
  const { channelId: dm } = (await (await api(ana, "/dms", { json: { userId: biaId } })).json()) as {
    channelId: string;
  };
  const threads = await api(adm, `/channels/${room.id}/threads`);
  expect(threads.status).toBe(200);
  expect(((await threads.json()) as { threads: { id: string }[] }).threads.map((x) => x.id)).toEqual([root.id]);
  expect((await api(bia, `/channels/${room.id}/threads`)).status).toBe(403);
  expect((await api(adm, `/channels/${dm}/threads`)).status).toBe(403);
});

test("the audit route keeps a limited task's title from view_audit alone, not from an administrator", async () => {
  const { owner, ana, adm, api, anaId, biaId, bia } = await team();
  const { id: role } = (await (
    await api(owner, "/roles", { json: { name: "Auditoria", permissions: ["view_audit"] } })
  ).json()) as { id: string };
  expect((await api(owner, `/members/${biaId}/roles`, { method: "PUT", json: { roleIds: [role] } })).status).toBe(200);
  const page = await api(ana, "/wiki/pages", {
    json: { title: "Plano secreto", body: "x", audience: { mode: "people", userIds: [anaId] } },
  });
  expect(page.status).toBe(201);
  const rows = async (b: B) => JSON.stringify(await (await api(b, "/audit")).json());
  expect(await rows(adm)).toContain("Plano secreto");
  const seen = await rows(bia);
  expect(seen).toContain("wiki.page_created");
  expect(seen).not.toContain("Plano secreto");
  expect((await api(ana, "/audit")).status).toBe(403);
});

test("an administrator demoted through the route stops reading at once, the socket's check included", async () => {
  const { orgId, owner, ana, adm, api, admId } = await team();
  const room = (await (await api(ana, "/channels", { json: { name: "secreto", visibility: "private" } })).json()) as {
    id: string;
  };
  expect((await api(adm, `/channels/${room.id}/messages`)).status).toBe(200);
  expect((await api(owner, `/members/${admId}/roles`, { method: "PUT", json: { roleIds: [] } })).status).toBe(200);
  expect((await api(adm, `/channels/${room.id}/messages`)).status).toBe(403);
  expect([...((await currentSubscriptions(t.db, admId, orgId, [room.id])) ?? [])]).toEqual([]);
});

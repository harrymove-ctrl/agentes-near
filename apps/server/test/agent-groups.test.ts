import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  type Browser,
  browser,
  createTestServer,
  joinByInvitation,
  listen,
  ORIGIN,
  seedOrg,
  signUp,
  type TestServer,
} from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer();
});
afterEach(() => t.close());

type Groups = {
  groups: {
    id: string;
    name: string;
    agentIds: string[];
    color: string;
    icon: string;
    leadUserId: string | null;
    backupUserId: string | null;
  }[];
};

/** The owner's workspace with @dev and @ops, and a member. */
async function workspace() {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId: dev } = await seedOrg(owner);
  const api = (b: Browser, path: string, init?: Parameters<Browser>[1]) =>
    b(`/api/app/organizations/${orgId}${path}`, init);
  const ops = (await (await api(owner, "/agents", { json: { name: "Ops", handle: "ops" } })).json()) as { id: string };
  const member = await joinByInvitation(t, owner, orgId, "member@example.com");
  return { owner, member, orgId, api, dev, ops: ops.id };
}

test("agent groups API: owners and admins change them, members read them, agents move in order", async () => {
  const { owner, member, api, dev, ops } = await workspace();
  expect(await (await api(member, "/agent-groups")).json()).toEqual({ groups: [] });

  const created = await api(owner, "/agent-groups", { json: { name: "Integrations", agentIds: [ops, dev] } });
  expect(created.status).toBe(201);
  const { groups } = (await created.json()) as Groups;
  expect(groups).toEqual([
    {
      id: expect.any(String),
      name: "Integrations",
      agentIds: [ops, dev],
      color: "graphite",
      icon: "person",
      leadUserId: null,
      backupUserId: null,
    },
  ]);
  const id = groups[0]?.id ?? "";
  // A setor's look and people (ADR 0148): a lead in the workspace, a known color.
  const people = (await (await api(owner, "/members")).json()) as { members: { userId: string; email: string }[] };
  const memberId = people.members.find((m) => m.email === "member@example.com")?.userId;
  expect(memberId).toBeTruthy();
  const lead = await api(owner, `/agent-groups/${id}`, {
    method: "PATCH",
    json: { color: "teal", icon: "code", leadUserId: memberId },
  });
  expect(((await lead.json()) as Groups).groups[0]).toMatchObject({
    color: "teal",
    icon: "code",
    leadUserId: memberId,
  });
  expect((await api(owner, `/agent-groups/${id}`, { method: "PATCH", json: { color: "sky" } })).status).toBe(400);
  await api(owner, `/agent-groups/${id}`, {
    method: "PATCH",
    json: { color: "graphite", icon: "person", leadUserId: null },
  });

  expect((await api(member, "/agent-groups", { json: { name: "Meu" } })).status).toBe(403);
  expect((await api(member, `/agent-groups/${id}`, { method: "PATCH", json: { name: "Outro" } })).status).toBe(403);
  expect((await api(member, `/agent-groups/${id}`, { method: "DELETE" })).status).toBe(403);
  expect((await api(member, `/agents/${dev}/group`, { method: "PUT", json: { groupId: null } })).status).toBe(403);
  expect(((await (await api(member, "/agent-groups")).json()) as Groups).groups).toEqual(groups);

  const moved = await api(owner, `/agents/${dev}/group`, { method: "PUT", json: { groupId: id, index: 0 } });
  expect(((await moved.json()) as Groups).groups[0]?.agentIds).toEqual([dev, ops]);
  const second = (await (await api(owner, "/agent-groups", { json: { name: "Produto" } })).json()) as Groups;
  const reordered = await api(owner, `/agent-groups/${second.groups[1]?.id}`, {
    method: "PATCH",
    json: { index: 0, name: "Produto e marketing" },
  });
  expect(((await reordered.json()) as Groups).groups.map((g) => g.name)).toEqual([
    "Produto e marketing",
    "Integrations",
  ]);
  const out = await api(owner, `/agents/${ops}/group`, { method: "PUT", json: { groupId: null } });
  expect(((await out.json()) as Groups).groups[1]?.agentIds).toEqual([dev]);

  const deleted = await api(owner, `/agent-groups/${id}`, { method: "DELETE" });
  expect(((await deleted.json()) as Groups).groups.map((g) => g.name)).toEqual(["Produto e marketing"]);
  const gone = await api(owner, `/agent-groups/${id}`, { method: "DELETE" });
  expect(gone.status).toBe(404);
  expect(await gone.json()).toMatchObject({ error: { code: "agent_group.not_found" } });
  expect((await api(owner, "/agent-groups", { json: { name: "  " } })).status).toBe(400);
});

test("a change reaches every open app of the workspace over its socket", async () => {
  const { owner, member, orgId, api, dev } = await workspace();
  const server = listen(t);
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/api/ws?orgId=${orgId}`, {
    headers: { origin: ORIGIN, cookie: member.cookie() },
  } as unknown as string[]);
  const frames: { type?: string; scope?: string; event?: { type?: string } }[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data)) as (typeof frames)[number];
        frames.push(frame);
        if (frame.type === "ready") resolve();
      });
      socket.addEventListener("error", () => reject(new Error("socket did not open")), { once: true });
    });
    expect((await api(owner, "/agent-groups", { json: { name: "Integrations", agentIds: [dev] } })).status).toBe(201);
    const heard = async () => {
      for (let i = 0; i < 40; i++) {
        const frame = frames.find((f) => f.scope === "org" && f.event?.type === "agent.groups");
        if (frame) return frame;
        await Bun.sleep(50);
      }
      return null;
    };
    // A bare signal (NOTIFY payloads stay small): each app reads the groups again.
    expect(await heard()).toEqual({ type: "event", scope: "org", event: { type: "agent.groups" } });
  } finally {
    socket.close();
    await Promise.race([server.stop(true), Bun.sleep(500)]);
  }
});

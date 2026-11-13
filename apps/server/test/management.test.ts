import { afterEach, beforeEach, expect, test } from "bun:test";
import { type Browser, browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["done"], usage: { inputTokens: 100, outputTokens: 10 } }) });
});
afterEach(() => t.close());

test("management API: settings, overview, people, invitations, credentials, agent detail, runs, usage, channels", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId, agentId, credentialId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);

  const patched = await api("/settings", {
    method: "PATCH",
    json: { context: "We ship on Tuesdays.", timezone: "America/Sao_Paulo" },
  });
  expect(await patched.json()).toMatchObject({
    context: "We ship on Tuesdays.",
    timezone: "America/Sao_Paulo",
    routerModel: null,
  });
  expect((await api("/settings", { method: "PATCH", json: { routerModel: "nope" } })).status).toBe(400);

  await api(`/channels/${channelId}/messages`, { json: { body: "@dev status?" } });
  await t.drain();

  const overview = (await (await api("/overview")).json()) as Record<string, number>;
  // Dev and the workspace's right hand, which the sidebar lists under this count too.
  expect(overview).toMatchObject({ people: 1, agents: 2, approvalsWaitingForMe: 0 });
  // A percentage of the budgets (dev has US$ 50), never money.
  expect(overview.budgetUsedPercent).toBe(0);
  expect(overview).not.toHaveProperty("myAgentsSpendUsd");

  const people = (await (await api("/people")).json()) as { people: { email: string; online: boolean }[] };
  expect(people.people).toEqual([expect.objectContaining({ email: "owner@example.com", online: false })]);

  const batch = (await (
    await api("/invitations/batch", { json: { emails: ["a@example.com", "bad", "b@example.com"] } })
  ).json()) as { results: { email: string; status: string; url?: string; invitationId?: string }[] };
  expect(batch.results.map((r) => r.status)).toEqual(["invited", "invalid_email", "invited"]);
  expect(batch.results[0]?.url).toContain("/invite/");
  const resent = (await (await api(`/invitations/${batch.results[0]?.invitationId}/resend`, { json: {} })).json()) as {
    url: string;
  };
  // Sending it again keeps its link (ADR 0090).
  expect(resent.url).toBe(batch.results[0]?.url ?? "");
  const all = (await (await api("/invitations/all")).json()) as { invitations: { status: string }[] };
  expect(all.invitations.map((i) => i.status)).toEqual(["pending", "pending"]);

  const rotated = await api(`/credentials/${credentialId}/rotate`, { json: { apiKey: "sk-ant-new-key-7777" } });
  expect(await rotated.json()).toMatchObject({ id: credentialId, keyHint: "7777" });
  expect(await (await api("/credentials/platform")).json()).toEqual({ available: false });
  expect((await api(`/credentials/${credentialId}?purge=true`, { method: "DELETE" })).status).toBe(409);

  const detail = (await (await api(`/agents/${agentId}`)).json()) as Record<string, unknown>;
  expect(detail).toMatchObject({
    handle: "dev",
    runsThisMonth: 1,
    budgetUsedPercent: 0,
    monthlyBudgetUsd: 50,
    channels: [{ id: channelId, name: "general", autoReply: true }],
  });

  const runs = (await (await api(`/runs?agentId=${agentId}`)).json()) as {
    runs: { id: string; status: string }[];
  };
  expect(runs.runs).toHaveLength(1);
  expect(runs.runs[0]?.status).toBe("done");
  expect(runs.runs[0]).not.toHaveProperty("costUsd");
  const run = (await (await api(`/runs/${runs.runs[0]?.id}`)).json()) as {
    steps: { kind: string; data: Record<string, unknown> }[];
  };
  expect(run.steps.map((s) => s.kind)).toEqual(["context", "model_call", "context", "message"]);
  expect(run.steps.find((s) => s.kind === "model_call")?.data).not.toHaveProperty("costNanoUsd");

  const usage = (await (await api("/usage/report")).json()) as {
    byKind: { kind: string; calls: number }[];
    totalUsd: number;
    defaultAgentBudgetUsd: number;
    agents: { handle: string; monthlyBudgetUsd: number; budgetIsDefault: boolean }[];
  };
  // Each key saved made one real call, on the organization: it counts as a `summary` call.
  expect(usage.byKind).toEqual([
    expect.objectContaining({ kind: "agent", calls: 1 }),
    expect.objectContaining({ kind: "summary", calls: 2 }),
  ]);
  expect(usage.totalUsd).toBeCloseTo((100 * 2000 + 10 * 10000) / 1e9);
  expect(usage.defaultAgentBudgetUsd).toBe(50);
  expect(usage.agents).toEqual([
    expect.objectContaining({ handle: "dev", monthlyBudgetUsd: 50, budgetIsDefault: false }),
    // The right hand is listed like any agent, on the workspace's default budget (ADR 0137).
    expect.objectContaining({ handle: "lodi", calls: 0, budgetIsDefault: true }),
  ]);

  const renamed = await api(`/channels/${channelId}`, { method: "PATCH", json: { topic: "All hands" } });
  expect(await renamed.json()).toMatchObject({ topic: "All hands" });
  const roster = (await (await api(`/channels/${channelId}/roster`)).json()) as {
    members: { type: string; name: string; handle: string | null }[];
  };
  expect(roster.members.map((m) => [m.type, m.name, m.handle])).toEqual([
    ["person", "owner", null],
    ["agent", "Dev", "dev"],
  ]);

  const set = await api(`/agents/${agentId}/channels`, {
    method: "PUT",
    json: { channels: [{ channelId, autoReply: false }] },
  });
  expect(await set.json()).toEqual({ channels: [{ id: channelId, name: "general", autoReply: false }] });
});

test("PUT an agent's channels: its owner with Create agents alone, in the channels they're in; Manage agents for anyone's", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId: general, agentId: dev } = await seedOrg(owner);
  const ana = await joinByInvitation(t, owner, orgId, "ana@example.com");
  const as = (b: Browser) => (path: string, init?: Parameters<Browser>[1]) =>
    b(`/api/app/organizations/${orgId}${path}`, init);
  const json = async <T>(res: Promise<Response>) => (await (await res).json()) as T;
  const { id: makers } = await json<{ id: string }>(
    as(owner)("/roles", { json: { name: "Makers", permissions: ["create_agents"] } }),
  );
  const { user } = await json<{ user: { id: string } }>(ana("/api/app/me"));
  await as(owner)(`/members/${user.id}/roles`, { method: "PUT", json: { roleIds: [makers] } });
  const { id: bot } = await json<{ id: string }>(as(ana)("/agents", { json: { name: "Bot", handle: "bot" } }));
  const { id: squad } = await json<{ id: string }>(as(owner)("/channels", { json: { name: "squad" } }));
  const { id: sales } = await json<{ id: string }>(as(owner)("/channels", { json: { name: "sales" } }));
  expect((await as(ana)(`/channels/${squad}/join`, { json: {} })).status).toBe(204);
  const put = (b: Browser, agentId: string, ids: string[]) =>
    as(b)(`/agents/${agentId}/channels`, {
      method: "PUT",
      json: { channels: ids.map((channelId) => ({ channelId })) },
    });

  // Her own agent, in a channel she's in.
  const res = await put(ana, bot, [squad]);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ channels: [{ id: squad, name: "squad", autoReply: true }] });
  // Not in one she isn't in, and not someone else's agent.
  expect((await put(ana, bot, [squad, sales])).status).toBe(403);
  expect((await put(ana, dev, [general, squad])).status).toBe(403);
  // The workspace's owner: anyone's agent, anywhere.
  expect((await put(owner, bot, [squad, sales])).status).toBe(200);
  const listed = await json<{ channels: { name: string }[] }>(as(owner)(`/agents/${bot}/channels`));
  expect(listed.channels.map((c) => c.name)).toEqual(["sales", "squad"]);
});

test("POST an agent with Create agents alone: her own, never someone else's or nobody's, and nothing is left behind", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const ana = await joinByInvitation(t, owner, orgId, "ana@example.com");
  const as = (b: Browser) => (path: string, init?: Parameters<Browser>[1]) =>
    b(`/api/app/organizations/${orgId}${path}`, init);
  const json = async <T>(res: Promise<Response>) => (await (await res).json()) as T;
  const { id: makers } = await json<{ id: string }>(
    as(owner)("/roles", { json: { name: "Makers", permissions: ["create_agents"] } }),
  );
  const { user } = await json<{ user: { id: string } }>(ana("/api/app/me"));
  const { user: boss } = await json<{ user: { id: string } }>(owner("/api/app/me"));
  await as(owner)(`/members/${user.id}/roles`, { method: "PUT", json: { roleIds: [makers] } });
  // What Criar agente sends: the owner, who can talk to it and its look.
  const make = (ownerUserId: string | null) =>
    as(ana)("/agents", {
      json: {
        name: "Iris",
        handle: "iris",
        ownerUserId,
        audience: { mode: "everyone", userIds: [] },
        appearance: { color: "violet", eyes: "round", accessory: "headset" },
      },
    });
  expect((await make(boss.id)).status).toBe(403);
  expect((await make(null)).status).toBe(403);
  const team = await json<{ agents: { handle: string }[] }>(as(owner)("/agents"));
  expect(team.agents.map((a) => a.handle)).not.toContain("iris");
  const res = await make(user.id);
  expect(res.status).toBe(201);
  expect(await res.json()).toMatchObject({ handle: "iris", ownerUserId: user.id });
});

test("channel members API: add an agent with autoReply off, turn it on, roster shows it", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const room = (await (await api("/channels", { json: { name: "squad", visibility: "private" } })).json()) as {
    id: string;
  };
  expect((await api(`/channels/${room.id}/members`, { json: { agentId, autoReply: false } })).status).toBe(204);
  const roster = async () =>
    ((await (await api(`/channels/${room.id}/roster`)).json()) as { members: { autoReply: boolean | null }[] }).members;
  expect((await roster()).map((m) => m.autoReply)).toContain(false);
  const res = await api(`/channels/${room.id}/members/agents/${agentId}`, {
    method: "PATCH",
    json: { autoReply: true },
  });
  expect(res.status).toBe(204);
  expect((await roster()).map((m) => m.autoReply)).not.toContain(false);
  expect(
    (
      await api(`/channels/${room.id}/members/agents/${crypto.randomUUID()}`, {
        method: "PATCH",
        json: { autoReply: true },
      })
    ).status,
  ).toBe(404);
});

test("onboarding keeps the team size and time zone; settings change them", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const created = (await (
    await owner("/api/app/organizations", {
      json: { name: "Beta", teamSize: "small", timezone: "America/Sao_Paulo" },
    })
  ).json()) as { organization: { id: string } };
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${created.organization.id}${path}`, init);
  expect(await (await api("/settings")).json()).toMatchObject({ teamSize: "small", timezone: "America/Sao_Paulo" });
  expect(await (await api("/settings", { method: "PATCH", json: { teamSize: "medium" } })).json()).toMatchObject({
    teamSize: "medium",
  });
  expect((await api("/settings", { method: "PATCH", json: { teamSize: "huge" } })).status).toBe(400);
});

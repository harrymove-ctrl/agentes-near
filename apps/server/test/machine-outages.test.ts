import { afterEach, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import { browser, createTestServer, pairComputer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(() => t.close());

const RUNNER = {
  hostname: "mac",
  os: "darwin",
  arch: "arm64",
  version: "0.8.0",
  protocol: MACHINE_PROTOCOL_VERSION,
  workspace: "/Users/w/agentes",
  exec: true,
};
const CLAUDE = { claude: { version: "2.1.300", loggedIn: true }, detectedAt: new Date().toISOString() };

async function start() {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" }, reply: () => ({ chunks: ["ok"] }) });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const seeded = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${seeded.orgId}${path}`, init);
  const pair = async (name: string, online: boolean, ip: string) => {
    const { machineId } = await pairComputer(t, api, RUNNER, { name, ip });
    await t.db
      .update(schema.machines)
      .set({ online, lastSeenAt: online ? new Date() : new Date(Date.now() - 600_000), executors: CLAUDE })
      .where(eq(schema.machines.id, machineId));
    return machineId;
  };
  return { api, pair, ...seeded };
}

test("outages and move-agents over HTTP: the contract the apps read", async () => {
  const { api, pair, agentId, orgId, channelId } = await start();
  const air = await pair("MacBook Air", false, "203.0.113.21");
  const pro = await pair("MacBook Pro", true, "203.0.113.22");
  const off = await pair("PC", false, "203.0.113.23");

  let res = await api("/machines/outages");
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ outages: [], targets: expect.any(Array) });

  await t.db.update(schema.agents).set({ machineId: air, brain: "claude_code" }).where(eq(schema.agents.id, agentId));
  const [run] = await t.db
    .insert(schema.agentRuns)
    .values({
      orgId,
      agentId,
      channelId,
      threadRootId: crypto.randomUUID(),
      triggerMessageId: crypto.randomUUID(),
      trigger: "mention",
      hop: 1,
      status: "waiting_input",
      waitingMachineId: air,
      transcript: {
        messages: [],
        waitingForBrain: { kind: "claude_code", machineId: air, code: "machine_offline", waitId: "w1" },
      },
    })
    .returning();

  res = await api("/machines/outages");
  const body = (await res.json()) as { outages: unknown[]; targets: unknown[] };
  expect(body.outages).toEqual([
    {
      machineId: air,
      name: "MacBook Air",
      platform: "mac",
      managed: false,
      offlineSince: expect.any(String),
      agents: [{ agentId, name: "Dev", brain: "claude_code", waiting: { routines: 0, conversations: 1 } }],
      waitingRuns: 1,
    },
  ]);
  expect(body.targets).toEqual([
    {
      kind: "machine",
      machineId: pro,
      name: "MacBook Pro",
      platform: "mac",
      managed: false,
      online: true,
      brains: ["claude_code"],
      reasonOff: null,
    },
    {
      kind: "machine",
      machineId: off,
      name: "PC",
      platform: "mac",
      managed: false,
      online: false,
      brains: ["claude_code"],
      reasonOff: "offline",
    },
  ]);

  // A bad body, an offline target.
  res = await api(`/machines/${air}/move-agents`, {
    json: { agentIds: [], target: { kind: "machine", machineId: off } },
  });
  expect(res.status).toBe(400);
  res = await api(`/machines/${air}/move-agents`, {
    json: { agentIds: [agentId], target: { kind: "machine", machineId: off } },
  });
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: { code: string } }).error.code).toBe("machine.target_offline");

  res = await api(`/machines/${air}/move-agents`, {
    json: { agentIds: [agentId], target: { kind: "machine", machineId: pro } },
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ moved: [agentId], skipped: [], resumed: 1, stillWaiting: 0 });
  const [moved] = await t.db
    .select()
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.id, run?.id ?? ""));
  expect(moved?.waitingMachineId).toBe(pro);
  expect(((await (await api("/machines/outages")).json()) as { outages: unknown[] }).outages).toEqual([]);

  // Only this org's members.
  const stranger = browser(t);
  await signUp(stranger, "x@example.com");
  expect((await stranger(`/api/app/organizations/${orgId}/machines/outages`)).status).toBe(403);
});

test("a computer's queue over HTTP: every member reads it, only the org's own computers", async () => {
  const { api, pair, agentId, orgId, channelId } = await start();
  const pro = await pair("MacBook Pro", true, "203.0.113.22");
  const trigger = crypto.randomUUID();
  const [run] = await t.db
    .insert(schema.agentRuns)
    .values({
      orgId,
      agentId,
      channelId,
      threadRootId: trigger,
      triggerMessageId: trigger,
      trigger: "mention",
      hop: 1,
      status: "waiting_input",
      waitingMachineId: pro,
      transcript: {
        messages: [],
        waitingForBrain: { kind: "claude_code", machineId: pro, code: "busy", waitId: "w1" },
        roomWaitSince: Date.now(),
      },
    })
    .returning();

  const res = await api(`/machines/${pro}/queue`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    machineId: pro,
    name: "MacBook Pro",
    working: [],
    waiting: [
      {
        runId: run?.id,
        agentId,
        purpose: { kind: "person", userId: null },
        where: { channelId, threadId: null, agents: false },
        people: false,
        position: 1,
        estimatedStartAt: null,
        after: [],
        canOpen: true,
        canStop: true,
      },
    ],
  });
  expect((await api(`/machines/${crypto.randomUUID()}/queue`)).status).toBe(404);
  const stranger = browser(t);
  await signUp(stranger, "x@example.com");
  expect((await stranger(`/api/app/organizations/${orgId}/machines/${pro}/queue`)).status).toBe(403);
});

test("the OpenAPI document lists both routes", async () => {
  await start();
  const doc = (await (await t.app.request("/api/openapi.json")).json()) as { paths: Record<string, unknown> };
  expect(Object.keys(doc.paths)).toContain("/app/organizations/{orgId}/machines/outages");
  expect(Object.keys(doc.paths)).toContain("/app/organizations/{orgId}/machines/{machineId}/move-agents");
  expect(Object.keys(doc.paths)).toContain("/app/organizations/{orgId}/machines/{machineId}/queue");
});

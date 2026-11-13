import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { browser, createTestServer, joinByInvitation, pairComputer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(async () => {
  await t.close();
});

const RUNNER = {
  hostname: "box",
  os: "darwin",
  arch: "arm64",
  version: "0.1.0",
  protocol: 54,
  workspace: "/srv/agentes",
};

async function start() {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" }, reply: () => ({ chunks: ["ok"] }) });
  const owner = browser(t);
  await signUp(owner, "ana@example.com");
  const seeded = await seedOrg(owner);
  const sam = await joinByInvitation(t, owner, seeded.orgId, "sam@example.com");
  const userId = async (email: string) =>
    (await t.db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email)))[0]?.id ?? "";
  const samApi = (path: string, init?: Parameters<typeof sam>[1]) =>
    sam(`/api/app/organizations/${seeded.orgId}${path}`, init);
  const mac = await pairComputer(t, samApi, { ...RUNNER, exec: true }, { name: "Sam's MacBook" });
  return { owner, sam, ...seeded, mac, anaId: await userId("ana@example.com"), samId: await userId("sam@example.com") };
}

test("only a device's owner answers an agent's request to use it; Always adds the person to who can use it", async () => {
  const { owner, sam, orgId, mac, anaId } = await start();
  const [request] = await t.db
    .insert(schema.deviceAccessRequests)
    .values({ orgId, machineId: mac.machineId, requesterUserId: anaId, expiresAt: new Date(Date.now() + 3600_000) })
    .returning();
  const decide = (b: typeof owner, decision: string) =>
    b(`/api/app/organizations/${orgId}/devices/access-requests/${request?.id}/decide`, { json: { decision } });

  expect((await decide(owner, "always")).status).toBe(403);
  expect((await decide(sam, "sometimes")).status).toBe(400);
  expect((await decide(sam, "always")).status).toBe(204);
  const [machine] = await t.db.select().from(schema.machines).where(eq(schema.machines.id, mac.machineId));
  expect(machine).toMatchObject({ audienceMode: "people", audienceUserIds: [anaId] });
  // Answered once: a second answer is refused.
  expect((await decide(sam, "no")).status).toBe(400);
});

test("Try now on a run waiting for a device hands the run its answer; a run waiting on nothing is a 404", async () => {
  const { owner, orgId, channelId, mac } = await start();
  const posted = await owner(`/api/app/organizations/${orgId}/channels/${channelId}/messages`, {
    json: { body: "@dev record the pixel" },
  });
  expect(posted.status).toBe(201);
  const [run] = await t.db.select().from(schema.agentRuns);
  if (!run) throw new Error("no run");
  const action = (runId: string, body: unknown) =>
    owner(`/api/app/organizations/${orgId}/runs/${runId}/device-wait`, { json: body });
  expect((await action(run.id, { action: "retry" })).status).toBe(404);

  const waitId = `device:${mac.machineId}:-:${crypto.randomUUID()}`;
  await t.db
    .update(schema.agentRuns)
    .set({
      status: "waiting_input",
      transcript: { pending: { calls: [{ toolUseId: "tu_1", name: "wait_for_device", waitId }] } },
    })
    .where(eq(schema.agentRuns.id, run.id));
  expect((await action(run.id, { action: "later" })).status).toBe(400);
  expect((await action(run.id, { action: "retry" })).status).toBe(204);
  const [after] = await t.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.id));
  const call = (after?.transcript as { pending: { calls: { result?: { content: string } }[] } } | undefined)?.pending
    .calls[0];
  expect(call?.result?.content).toStartWith("ana pressed Try now: check The device again");
});

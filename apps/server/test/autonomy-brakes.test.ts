import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { costlyGate } from "@agenteschat/engine";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

/** Autonomy brakes over the API (ADR 0131): an agent's `brakes`, and a proposal card decided by its person. */

let t: TestServer;
afterEach(() => t.close());

type Brakes = { costly: string; maxUnrequested: number; callAgents: string; callAgentIds: string[]; never: string[] };

test("an agent's brakes: defaults on the agent, merged on PATCH, and a proposal decided only by who may", async () => {
  t = await createTestServer();
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const bia = await joinByInvitation(t, owner, orgId, "bia@example.com");
  const org = `/api/app/organizations/${orgId}`;
  const created = (await (await owner(`${org}/agents`, { json: { name: "Ada", handle: "ada" } })).json()) as {
    id: string;
    brakes: Brakes;
  };
  expect(created.brakes).toMatchObject({ costly: "go", maxUnrequested: 2, callAgents: "all" });

  const patched = await owner(`${org}/agents/${created.id}`, {
    method: "PATCH",
    json: { brakes: { callAgents: "none", maxUnrequested: 5 } },
  });
  expect(patched.status).toBe(200);
  const again = await owner(`${org}/agents/${created.id}`, { method: "PATCH", json: { brakes: { costly: "ask" } } });
  expect(((await again.json()) as { brakes: Brakes }).brakes).toMatchObject({
    costly: "ask",
    maxUnrequested: 5,
    callAgents: "none",
  });

  // A run nobody asked for wants to install packages: the card is for the agent's owner.
  await t.db
    .update(schema.agents)
    .set({ autonomyBrakes: { costly: "ask" } })
    .where(eq(schema.agents.id, created.id));
  const [general] = await t.db.select().from(schema.channels).where(eq(schema.channels.orgId, orgId));
  if (!general) throw new Error("no channel");
  const triggerId = Bun.randomUUIDv7();
  const [run] = await t.db
    .insert(schema.agentRuns)
    .values({
      orgId,
      agentId: created.id,
      channelId: general.id,
      threadRootId: triggerId,
      triggerMessageId: triggerId,
      trigger: "mention",
      hop: 2,
      status: "running",
    })
    .returning();
  if (!run) throw new Error("no run");
  const at = { orgId, agentId: created.id, runId: run.id, channelId: general.id, threadRootId: triggerId };
  expect(
    (await costlyGate({ db: t.db }, at, { kind: "unattended", personId: null, reason: "agent" }, "install", "npm i"))
      ?.code,
  ).toBe("autonomy.needs_go");
  const [signal] = await t.db.select().from(schema.autonomySignals);
  if (!signal) throw new Error("no proposal");

  expect((await bia(`${org}/autonomy-proposals/${signal.id}`, { json: { decision: "go" } })).status).toBe(404);
  const decided = await owner(`${org}/autonomy-proposals/${signal.id}`, { json: { decision: "never" } });
  expect(decided.status).toBe(200);
  expect(await decided.json()).toEqual({ state: "never" });
  expect((await owner(`${org}/autonomy-proposals/${signal.id}`, { json: { decision: "go" } })).status).toBe(409);
  const list = (await (await owner(`${org}/agents`)).json()) as { agents: { id: string; brakes: Brakes }[] };
  expect(list.agents.find((a) => a.id === created.id)?.brakes.never).toEqual(["install"]);
});

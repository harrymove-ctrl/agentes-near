import { afterEach, beforeEach, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { openPersonAgentDm, RIGHT_HAND } from "@agenteschat/engine";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

/** Lodi's weekly card (ADR 0137 §9) over HTTP: my own schedule, and a row applied as me, never as someone else. */

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer();
});
afterEach(() => t.close());

test("my day and hour or off; a row of my card applied as me, put away, and refused to anyone else", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const ownerId = ((await (await owner("/api/app/me")).json()) as { user: { id: string } }).user.id;
  const { orgId, agentId } = await seedOrg(owner);
  const base = `/api/app/organizations/${orgId}/team-week`;

  expect(await (await owner(base)).json()).toMatchObject({ off: false, day: 5, hour: 17 });
  const moved = await owner(base, { method: "PUT", json: { day: 1, hour: 9 } });
  expect(await moved.json()).toMatchObject({ off: false, day: 1, hour: 9 });
  expect((await owner(base, { method: "PUT", json: { hour: 30 } })).status).toBe(400);

  const [lodi] = await t.db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, orgId), eq(schema.agents.builtin, RIGHT_HAND)));
  if (!lodi) throw new Error("no right hand");
  const dm = await openPersonAgentDm(t.db, orgId, ownerId, lodi.id);
  const card = {
    kind: "team_week",
    forUserId: ownerId,
    from: "2026-10-30",
    to: "2026-11-06",
    timezone: "UTC",
    stats: { done: 3, stuck: 0, waiting: 0, spentNanoUsd: 0, budgetNanoUsd: 0 },
    worked: [],
    rows: [
      {
        id: "routine:x",
        kind: "routine",
        agentId,
        channelId: dm.id,
        dm: true,
        text: "Resumo do dia",
        count: 3,
        hour: 18,
      },
    ],
    proposalIds: [],
    done: {},
    dismissedAt: null,
  };
  const [m] = await t.db
    .insert(schema.messages)
    .values({
      orgId,
      channelId: dm.id,
      authorType: "agent",
      authorAgentId: lodi.id,
      body: "card",
      meta: { actionCard: card },
    })
    .returning();
  const row = `${base}/${m?.id}`;

  const nina = await joinByInvitation(t, owner, orgId, "nina@example.com");
  expect((await nina(row, { json: { dismiss: true } })).status).toBe(403);

  expect((await owner(row, { json: { rowId: "routine:x" } })).status).toBe(204);
  const routines = await t.db.select().from(schema.routines).where(eq(schema.routines.orgId, orgId));
  expect(routines.map((r) => r.prompt)).toEqual(["Resumo do dia"]);
  expect((await owner(row, { json: { rowId: "routine:x" } })).status).toBe(409);
  expect((await owner(row, { json: { dismiss: true } })).status).toBe(204);
  const [after] = await t.db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.id, m?.id ?? ""));
  const saved = after?.meta.actionCard as { dismissedAt: string | null; done: Record<string, unknown> };
  expect(saved.dismissedAt).not.toBeNull();
  expect(Object.keys(saved.done)).toEqual(["routine:x"]);
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { grantScopes, openPersonAgentDm, RIGHT_HAND, type ToolSource } from "@agenteschat/engine";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

/** The right hand's approvals and people cards (ADR 0137 §4): applied through the usual routes, audited via it. */

const github: ToolSource = {
  name: "test-github",
  tools: async () => [
    {
      name: "github_merge_pr",
      description: "Merge a pull request",
      scope: "github:pr.merge",
      inputSchema: { type: "object", properties: { pr: { type: "integer" } }, required: ["pr"] },
      describe: (i) => ({ title: `Merge PR #${i.pr}` }),
      execute: async () => ({ content: "merged" }),
    },
  ],
};

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({
    toolSources: [github],
    reply: (req) =>
      JSON.stringify(req.messages.at(-1)?.content).includes("merged")
        ? { chunks: ["Merge done."] }
        : {
            chunks: [],
            toolUses: [
              {
                name: "github_merge_pr",
                input: { pr: 42, why: "CI passed and the review is done: merging ships the fix today." },
              },
            ],
          },
  });
});
afterEach(() => t.close());

/** Posts Lodi's card in the owner's DM with it, as its tools do. */
async function lodiCard(orgId: string, userId: string, actionCard: Record<string, unknown>) {
  const [lodi] = await t.db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, orgId), eq(schema.agents.builtin, RIGHT_HAND)));
  if (!lodi) throw new Error("no right hand");
  const dm = await openPersonAgentDm(t.db, orgId, userId, lodi.id);
  const [m] = await t.db
    .insert(schema.messages)
    .values({
      orgId,
      channelId: dm.id,
      authorType: "agent",
      authorAgentId: lodi.id,
      body: "card",
      meta: { actionCard },
    })
    .returning();
  return { lodiId: lodi.id, messageId: m?.id ?? "" };
}

const viaRows = async (orgId: string, lodiId: string) =>
  (await t.db.select().from(schema.auditLog).where(eq(schema.auditLog.orgId, orgId)))
    .filter((r) => (r.details as { via?: string }).via === lodiId)
    .map((r) => r.action)
    .sort();

test("an approval decided from the right hand's card, and people changed from its card, are audited via it", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const ownerId = ((await (await owner("/api/app/me")).json()) as { user: { id: string } }).user.id;
  const { orgId, channelId, agentId } = await seedOrg(owner);
  await grantScopes(t.db, orgId, agentId, [{ connectionId: null, scope: "github:pr.merge" }]);
  await owner(`/api/app/organizations/${orgId}/channels/${channelId}/messages`, { json: { body: "@dev merge 42" } });
  await t.drain();
  const [approval] = await t.db.select().from(schema.approvals).where(eq(schema.approvals.orgId, orgId));
  if (!approval) throw new Error("no approval");

  const nina = await joinByInvitation(t, owner, orgId, "nina@example.com");
  const ninaId = ((await (await nina("/api/app/me")).json()) as { user: { id: string } }).user.id;
  const { lodiId, messageId } = await lodiCard(orgId, ownerId, {
    kind: "approvals",
    forUserId: ownerId,
    params: { approvalIds: [approval.id], why: "x" },
  });
  const people = await lodiCard(orgId, ownerId, {
    kind: "member_changes",
    forUserId: ownerId,
    params: { rows: [{ userId: ninaId, role: "owner" }], why: "x" },
  });

  const approved = await owner(`/api/app/organizations/${orgId}/approvals/${approval.id}/approve`, {
    json: { via: messageId },
  });
  expect(approved.status).toBe(200);
  // A member's click is refused at the click, card or not.
  const refused = await nina(`/api/app/organizations/${orgId}/members/${ninaId}?via=${people.messageId}`, {
    method: "PATCH",
    json: { role: "owner" },
  });
  expect(refused.status).toBe(403);
  const made = await owner(`/api/app/organizations/${orgId}/members/${ninaId}?via=${people.messageId}`, {
    method: "PATCH",
    json: { role: "owner" },
  });
  expect(made.status).toBe(204);
  // A card that has no row for that person adds no via.
  const back = await owner(`/api/app/organizations/${orgId}/members/${ninaId}?via=${messageId}`, {
    method: "PATCH",
    json: { role: "member" },
  });
  expect(back.status).toBe(204);
  expect(await viaRows(orgId, lodiId)).toEqual(["approval.approved", "member.role_changed"]);
});

test("a card of a workspace change: read, refused, sent to whoever may, applied as them and undone, through the routes", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const ownerId = ((await (await owner("/api/app/me")).json()) as { user: { id: string } }).user.id;
  const { orgId } = await seedOrg(owner);
  const nina = await joinByInvitation(t, owner, orgId, "nina@example.com");
  const ninaId = ((await (await nina("/api/app/me")).json()) as { user: { id: string } }).user.id;
  const card = {
    kind: "workspace_action",
    forUserId: ninaId,
    params: {
      action: "create_role",
      input: { name: "Marketing", permissions: ["talk_to_agents", "edit_wiki"] },
      words: { name: "Marketing" },
      needs: "manage_roles",
      why: "Cargo de marketing",
    },
    state: "pending",
    decidedByUserId: null,
    decidedAt: null,
  };
  const { messageId } = await lodiCard(orgId, ninaId, card);
  const url = `/api/app/organizations/${orgId}/action-cards/${messageId}`;
  const roles = async () =>
    (await t.db.select().from(schema.orgRoles).where(eq(schema.orgRoles.orgId, orgId))).map((r) => r.name);

  expect(((await (await nina(url)).json()) as { card: { state: string } }).card.state).toBe("pending");
  // The owner can't read her DM, and her own click is refused by the roles screen's check.
  expect((await owner(url)).status).toBe(403);
  expect((await nina(`${url}/apply`, { json: {} })).status).toBe(403);
  expect(await roles()).not.toContain("Marketing");
  expect((await nina(`${url}/ask`, { json: {} })).status).toBe(200);
  const applied = await owner(`${url}/apply`, { json: {} });
  expect(applied.status).toBe(200);
  expect(((await applied.json()) as { card: { state: string; decidedByUserId: string } }).card).toMatchObject({
    state: "applied",
    decidedByUserId: ownerId,
  });
  expect(await roles()).toContain("Marketing");
  expect((await owner(`${url}/apply`, { json: {} })).status).toBe(409);
  const [receipt] = await t.db.select().from(schema.agentActions).where(eq(schema.agentActions.messageId, messageId));
  expect((await owner(`/api/app/organizations/${orgId}/actions/${receipt?.id}/undo`, { json: {} })).status).toBe(200);
  expect(await roles()).not.toContain("Marketing");
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { createReminder, grantScopes, type ToolSource } from "@agenteschat/engine";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

const merged: Record<string, unknown>[] = [];
const github: ToolSource = {
  name: "test-github",
  tools: async () => [
    {
      name: "github_merge_pr",
      description: "Merge a pull request",
      scope: "github:pr.merge",
      inputSchema: { type: "object", properties: { pr: { type: "integer" } }, required: ["pr"] },
      describe: (i) => ({ title: `Merge PR #${i.pr}` }),
      execute: async (input) => {
        merged.push(input);
        return { content: "merged" };
      },
    },
  ],
};

let t: TestServer;
beforeEach(async () => {
  merged.length = 0;
  t = await createTestServer({
    toolSources: [github],
    reply: (req) => {
      const last = JSON.stringify(req.messages.at(-1)?.content);
      if (last.includes("merged")) return { chunks: ["Merge done."] };
      if (last.includes("refused")) return { chunks: ["OK, leaving it."] };
      return {
        chunks: [],
        toolUses: [
          {
            name: "github_merge_pr",
            input: { pr: 42, why: "CI passed and the review is done: merging ships the fix today." },
          },
        ],
      };
    },
  });
});
afterEach(() => t.close());

test("approvals API: list, approve (resumes the run), and decisions are final", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId, agentId } = await seedOrg(owner);
  await grantScopes(t.db, orgId, agentId, [{ connectionId: null, scope: "github:pr.merge" }]);
  await owner(`/api/app/organizations/${orgId}/channels/${channelId}/messages`, { json: { body: "@dev merge 42" } });
  await t.drain();

  const list = (await (await owner(`/api/app/organizations/${orgId}/approvals?status=pending`)).json()) as {
    approvals: { id: string; title: string; canDecide: boolean; params: unknown; messageId: string }[];
  };
  expect(list.approvals).toHaveLength(1);
  expect(list.approvals[0]).toMatchObject({ title: "Merge PR #42", canDecide: true, params: { pr: 42 } });
  const id = list.approvals[0]?.id;

  // Asked in the channel: the card is in the main timeline.
  const messages = (await (await owner(`/api/app/organizations/${orgId}/channels/${channelId}/messages`)).json()) as {
    messages: { body: string; meta: Record<string, unknown> }[];
  };
  expect(messages.messages.at(-1)).toMatchObject({ body: "Approval request: Merge PR #42", meta: { approvalId: id } });

  const approved = await owner(`/api/app/organizations/${orgId}/approvals/${id}/approve`, { json: {} });
  expect(approved.status).toBe(200);
  expect(await approved.json()).toMatchObject({ status: "approved", canDecide: false });
  await t.drain();
  expect(merged).toEqual([{ pr: 42 }]);
  expect((await owner(`/api/app/organizations/${orgId}/approvals/${id}/refuse`, { json: {} })).status).toBe(409);
  const one = (await (await owner(`/api/app/organizations/${orgId}/approvals/${id}`)).json()) as { status: string };
  expect(one.status).toBe("approved");
});

test("approvals API: an action approved ahead is on its routine and withdrawn with cancel before its time", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const ownerId = ((await (await owner("/api/app/me")).json()) as { user: { id: string } }).user.id;
  const { orgId, channelId, agentId } = await seedOrg(owner);
  const at = new Date(Date.now() + 2 * 3600_000);
  const routine = await createReminder({ db: t.db, pubsub: t.adapters.pubsub }, ownerId, orgId, {
    agentId,
    channelId,
    threadId: null,
    at,
    timezone: "UTC",
    description: "in two hours",
    message: "Post de lançamento",
    askAgent: true,
  });
  const row = (id: string, runAt: Date | null) => ({
    id,
    orgId,
    agentId,
    channelId,
    threadRootId: crypto.randomUUID(),
    toolUseId: `call-${id}`,
    tool: "composio_COMPOSIO_MULTI_EXECUTE_TOOL",
    scope: "custom:x:write",
    params: { tools: [{ tool_slug: "LINKEDIN_PUBLISH_POST" }] },
    actionHash: "hash",
    title: "Composio: LINKEDIN_PUBLISH_POST",
    status: "approved" as const,
    expiresAt: at,
    ownerUserId: ownerId,
    routineId: runAt ? routine.id : null,
    runAt,
  });
  const ahead = crypto.randomUUID();
  const now = crypto.randomUUID();
  await t.db.insert(schema.approvals).values([row(ahead, at), row(now, null)]);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const listed = (await (await api("/routines")).json()) as { routines: { id: string; ahead: unknown[] }[] };
  expect(listed.routines.find((r) => r.id === routine.id)?.ahead).toEqual([
    expect.objectContaining({ id: ahead, status: "approved", runAt: at.toISOString(), canCancel: true }),
  ]);

  const canceled = await api(`/approvals/${ahead}/cancel`, { json: {} });
  expect(canceled.status).toBe(200);
  expect(await canceled.json()).toMatchObject({ status: "canceled", runAt: at.toISOString(), canCancel: false });
  const after = (await (await api("/routines")).json()) as {
    routines: { id: string; active: boolean; ahead: unknown[] }[];
  };
  // Its one-off had nothing else to do: it no longer fires.
  expect(after.routines.find((r) => r.id === routine.id)).toMatchObject({ active: false, ahead: [] });
  const again = await api(`/approvals/${ahead}/cancel`, { json: {} });
  expect(again.status).toBe(409);
  expect(await again.json()).toMatchObject({ error: { code: "approval.not_cancelable" } });
  const plain = await api(`/approvals/${now}/cancel`, { json: {} });
  expect(plain.status).toBe(409);
  expect(await plain.json()).toMatchObject({ error: { code: "approval.not_ahead" } });
});

test("approvals API: 'Aprovar tudo' decides exactly the ids sent and resumes the run once", async () => {
  await t.close();
  t = await createTestServer({
    toolSources: [github],
    reply: (req) => {
      const last = JSON.stringify(req.messages.at(-1)?.content);
      if (last.includes("merged")) return { chunks: ["Both merged."] };
      const why = "CI passed and the review is done: merging ships the fix today.";
      return {
        chunks: [],
        toolUses: [
          { name: "github_merge_pr", input: { pr: 42, why } },
          { name: "github_merge_pr", input: { pr: 43, why } },
        ],
      };
    },
  });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId, agentId } = await seedOrg(owner);
  await grantScopes(t.db, orgId, agentId, [{ connectionId: null, scope: "github:pr.merge" }]);
  await owner(`/api/app/organizations/${orgId}/channels/${channelId}/messages`, { json: { body: "@dev merge both" } });
  await t.drain();
  const list = (await (await owner(`/api/app/organizations/${orgId}/approvals?status=pending`)).json()) as {
    approvals: { id: string; messageId: string }[];
  };
  expect(list.approvals).toHaveLength(2);
  // One card for both.
  expect(new Set(list.approvals.map((a) => a.messageId)).size).toBe(1);
  // The card's requests by the card, wherever the org's list stops.
  const cardId = list.approvals[0]?.messageId ?? "";
  const onCard = (await (await owner(`/api/app/organizations/${orgId}/approvals?messageId=${cardId}`)).json()) as {
    approvals: unknown[];
  };
  expect(onCard.approvals).toHaveLength(2);
  const elsewhere = (await (
    await owner(`/api/app/organizations/${orgId}/approvals?messageId=${crypto.randomUUID()}`)
  ).json()) as { approvals: unknown[] };
  expect(elsewhere.approvals).toHaveLength(0);
  const ids = list.approvals.map((a) => a.id);
  const res = await owner(`/api/app/organizations/${orgId}/approvals/decide`, {
    json: { ids, decision: "approve" },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { approvals: { status: string }[]; skipped: string[] };
  expect(body.approvals.map((a) => a.status)).toEqual(["approved", "approved"]);
  expect(body.skipped).toEqual([]);
  await t.drain();
  expect(merged.map((m) => m.pr).sort()).toEqual([42, 43]);
  expect(
    (await owner(`/api/app/organizations/${orgId}/approvals/decide`, { json: { ids: [], decision: "approve" } }))
      .status,
  ).toBe(400);
});

test("approvals API: who approves for me decides my approvals in my name while I'm out, and may say no", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId, agentId } = await seedOrg(owner);
  await grantScopes(t.db, orgId, agentId, [{ connectionId: null, scope: "github:pr.merge" }]);
  const ana = await joinByInvitation(t, owner, orgId, "ana@example.com");
  const bruno = await joinByInvitation(t, owner, orgId, "bruno@example.com");
  const idOf = async (email: string) =>
    (await t.db.select().from(schema.users).where(eq(schema.users.email, email)))[0]?.id ?? "";
  const [anaId, brunoId] = [await idOf("ana@example.com"), await idOf("bruno@example.com")];
  await t.db.update(schema.agents).set({ ownerUserId: anaId }).where(eq(schema.agents.id, agentId));
  const cover = `/api/app/organizations/${orgId}/me/approval-cover`;

  const self = await ana(cover, {
    method: "PUT",
    json: { userId: anaId, mode: "while_out", risky: true, endsAt: null },
  });
  expect(self.status).toBe(400);
  const set = await ana(cover, {
    method: "PUT",
    json: { userId: brunoId, mode: "while_out", risky: true, endsAt: null },
  });
  expect(set.status).toBe(200);
  expect(await set.json()).toMatchObject({ cover: { userId: brunoId, mode: "while_out", risky: true, active: false } });
  await t.db
    .update(schema.organizationMembers)
    .set({ availability: "out" })
    .where(eq(schema.organizationMembers.userId, anaId));
  expect(await (await bruno(cover)).json()).toMatchObject({ cover: null, covering: [{ userId: anaId, active: true }] });

  await owner(`/api/app/organizations/${orgId}/channels/${channelId}/messages`, { json: { body: "@dev merge 42" } });
  await t.drain();
  const list = (await (await bruno(`/api/app/organizations/${orgId}/approvals?status=pending`)).json()) as {
    approvals: { id: string; canDecide: boolean }[];
  };
  expect(list.approvals).toMatchObject([{ canDecide: true }]);
  const id = list.approvals[0]?.id;
  const always = await bruno(`/api/app/organizations/${orgId}/approvals/${id}/approve`, { json: { always: true } });
  expect(always.status).toBe(409);
  const approved = await bruno(`/api/app/organizations/${orgId}/approvals/${id}/approve`, { json: {} });
  expect(await approved.json()).toMatchObject({
    status: "approved",
    decidedByUserId: brunoId,
    decidedForUserId: anaId,
  });

  expect((await bruno(`/api/app/organizations/${orgId}/approval-covers/${anaId}`, { method: "DELETE" })).status).toBe(
    204,
  );
  expect(await (await ana(cover)).json()).toMatchObject({ cover: null });
});

test("approvals API: the right hand approves for me, within what I set (ADR 0139 §2)", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const ana = await joinByInvitation(t, owner, orgId, "ana@example.com");
  const path = `/api/app/organizations/${orgId}/me/right-hand-approvals`;

  expect(await (await ana(path)).json()).toMatchObject({
    enabled: false,
    newAgents: true,
    agentChanges: true,
    budgetCapNanoUsd: 20_000_000_000,
    mayDecide: { newAgents: false },
    caps: { decisionsPerDay: 10, newAgentsPerDay: 2, monthNanoUsd: 50_000_000_000 },
  });
  expect((await ana(path, { method: "PUT", json: { budgetCapNanoUsd: 60_000_000_000 } })).status).toBe(400);
  const set = await ana(path, {
    method: "PUT",
    json: { enabled: true, newAgents: false, budgetCapNanoUsd: 10_000_000_000, guidance: "Nada duplicado." },
  });
  expect(set.status).toBe(200);
  expect(await set.json()).toMatchObject({ enabled: true, newAgents: false, guidance: "Nada duplicado." });
  const undo = `/api/app/organizations/${orgId}/right-hand-decisions/${crypto.randomUUID()}/undo`;
  expect((await ana(undo, { json: {} })).status).toBe(404);
});

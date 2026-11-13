import { afterEach, beforeEach, expect, test } from "bun:test";
import { channelTopic } from "@agenteschat/adapters";
import { createIssueToolSource, insertMessage, linkRunActions } from "@agenteschat/engine";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["ok"] }) });
});
afterEach(() => t.close());

type Action = { id: string; kind: string; undoneAt: string | null; target: { number?: number } };

test("receipts: listed on the agent's reply, undo/redo/undo-all over the API, conflicts as 409, live event", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId, agentId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const ownerId = ((await (await owner("/api/app/me")).json()) as { user: { id: string } }).user.id;

  // An agent run: the person asked, the agent created two issues and replied.
  const ask = await insertMessage(t.db, {
    orgId,
    channelId,
    author: { type: "person", userId: ownerId },
    body: "organiza isso",
  });
  const ctx = {
    db: t.db,
    orgId,
    agentId,
    runId: crypto.randomUUID(),
    channelId,
    threadRootId: ask.id,
    triggerMessageId: ask.id,
  };
  const [create] = (await createIssueToolSource(t.engine.artifacts).tools(ctx)).filter(
    (x) => x.name === "create_issue",
  );
  await create?.execute({ title: "Uma" }, ctx);
  await create?.execute({ title: "Outra" }, ctx);
  // Asked in the channel: the reply is in the main timeline.
  const reply = await insertMessage(t.db, {
    orgId,
    channelId,
    author: { type: "agent", agentId, runId: ctx.runId, hop: 0 },
    body: "Abri duas issues.",
  });
  await linkRunActions(t.db, orgId, ctx.runId, reply.id);
  const events: { type: string; messageId?: string }[] = [];
  await t.adapters.pubsub.subscribe(channelTopic(channelId), (e) => events.push(e as (typeof events)[number]));

  const timeline = (await (await api(`/channels/${channelId}/messages`)).json()) as {
    messages: { id: string; actions?: Action[] }[];
  };
  const actions = timeline.messages.find((m) => m.id === reply.id)?.actions ?? [];
  expect(actions.map((a) => [a.kind, a.target.number])).toEqual([
    ["issue.created", 1],
    ["issue.created", 2],
  ]);
  const [first] = actions;

  const undo = await api(`/actions/${first?.id}/undo`, { json: {} });
  expect(undo.status).toBe(200);
  expect(((await undo.json()) as Action).undoneAt).not.toBeNull();
  const again = await api(`/actions/${first?.id}/undo`, { json: {} });
  expect(again.status).toBe(409);
  expect(((await again.json()) as { error: { code: string } }).error.code).toBe("action.already_undone");
  const redo = await api(`/actions/${first?.id}/redo`, { json: {} });
  expect(((await redo.json()) as Action).undoneAt).toBeNull();

  const all = await api(`/messages/${reply.id}/actions/undo`, { json: {} });
  expect(all.status).toBe(200);
  const body = (await all.json()) as { actions: Action[]; failed: unknown[] };
  expect(body.failed).toEqual([]);
  expect(body.actions.every((a) => a.undoneAt)).toBe(true);
  await Bun.sleep(5);
  expect(events.some((e) => e.type === "message.actions" && e.messageId === reply.id)).toBe(true);

  const doc = (await (await t.app.request("/api/openapi.json")).json()) as { paths: Record<string, unknown> };
  for (const path of [
    "/app/organizations/{orgId}/actions/{actionId}/undo",
    "/app/organizations/{orgId}/actions/{actionId}/redo",
    "/app/organizations/{orgId}/messages/{messageId}/actions/undo",
  ]) {
    expect(Object.keys(doc.paths)).toContain(path);
  }
});

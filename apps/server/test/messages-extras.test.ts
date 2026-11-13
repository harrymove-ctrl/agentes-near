import { afterEach, beforeEach, expect, test } from "bun:test";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["done"], usage: { inputTokens: 100, outputTokens: 10 } }) });
});
afterEach(() => t.close());

test("agent messages carry model, tokens and cost; include=replies summarizes threads", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const root = (await (await api(`/channels/${channelId}/messages`, { json: { body: "@dev status?" } })).json()) as {
    id: string;
  };
  await t.drain();
  await api(`/channels/${channelId}/messages`, { json: { body: "valeu", threadId: root.id } });
  await api(`/channels/${channelId}/messages`, { json: { body: "até mais", threadId: root.id } });
  await api(`/channels/${channelId}/messages`, { json: { body: "sem thread" } });

  type Msg = {
    id: string;
    body: string;
    author: { type: string };
    usage?: { model: string; inputTokens: number; outputTokens: number; costUsd?: number };
    replies?: { count: number; lastAt: string | null; latest: { body: string }[] };
  };
  // Asked in the channel: the agent answers in the main timeline.
  const plain = (await (await api(`/channels/${channelId}/messages`)).json()) as { messages: Msg[] };
  const reply = plain.messages.find((m) => m.author.type === "agent");
  expect(reply?.usage).toMatchObject({ model: "claude-sonnet-5-5", inputTokens: 100, outputTokens: 10 });
  // Everyone in the channel reads it: tokens, never money.
  expect(reply?.usage).not.toHaveProperty("costUsd");
  expect(plain.messages.find((m) => m.id === root.id)?.usage).toBeUndefined();

  expect(plain.messages.every((m) => m.replies === undefined)).toBe(true);
  const top = (await (await api(`/channels/${channelId}/messages?include=replies`)).json()) as { messages: Msg[] };
  const summary = top.messages.find((m) => m.id === root.id)?.replies;
  expect(summary?.count).toBe(2);
  expect(summary?.latest.map((m) => m.body)).toEqual(["valeu", "até mais"]);
  expect(summary?.lastAt).toBeTruthy();
  const others = top.messages.filter((m) => m.id !== root.id);
  expect(others.map((m) => m.body)).toEqual(["done", "sem thread"]);
  for (const m of others) expect(m.replies).toEqual({ count: 0, lastAt: null, latest: [] });
});

test("quote reply over HTTP: meta.replyTo from the server, other channels refused; reactions come with the list", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const post = (channel: string, json: Record<string, unknown>) => api(`/channels/${channel}/messages`, { json });
  const original = (await (await post(channelId, { body: "o build quebrou" })).json()) as { id: string };
  const res = await post(channelId, { body: "já vi", replyTo: original.id, meta: { replyTo: { excerpt: "forjado" } } });
  expect(res.status).toBe(201);
  const reply = (await res.json()) as { meta: { replyTo?: { messageId: string; excerpt: string } } };
  // The client's own `meta` is ignored: the server quotes the real message.
  expect(reply.meta.replyTo).toMatchObject({ messageId: original.id, excerpt: "o build quebrou" });

  const other = (await (await api("/channels", { json: { name: "random" } })).json()) as { id: string };
  const wrong = await post(other.id, { body: "oi", replyTo: original.id });
  expect(wrong.status).toBe(400);
  expect(((await wrong.json()) as { error: { code: string } }).error.code).toBe("message.reply_not_found");
  // No text and no files: refused.
  expect((await post(channelId, { body: "  " })).status).toBe(400);

  await api(`/messages/${original.id}/reactions`, { json: { reaction: "🎉" } });
  const list = (await (await api(`/channels/${channelId}/messages`)).json()) as {
    messages: { id: string; reactions?: { reaction: string; count: number }[] }[];
  };
  expect(list.messages.find((m) => m.id === original.id)?.reactions).toMatchObject([{ reaction: "🎉", count: 1 }]);
});

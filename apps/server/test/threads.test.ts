import { afterEach, beforeEach, expect, test } from "bun:test";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" }, reply: () => ({ chunks: ["ok"] }) });
});
afterEach(() => t.close());

interface Thread {
  id: string;
  title: string | null;
  state: string;
  context: { count: number; moved: boolean } | null;
}

test("threads API: sign-in and same-origin; from a range, list, move, close, archive is read only", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const post = async (body: string, threadId?: string) => {
    const res = await api(`/channels/${channelId}/messages`, { json: { body, ...(threadId ? { threadId } : {}) } });
    return (await res.json()) as { id: string };
  };
  const a = await post("Onboarding is too long");
  const b = await post("Cut step 3");

  const anon = browser(t);
  expect((await anon(`/api/app/organizations/${orgId}/threads`)).status).toBe(401);
  const range = { channelId, firstMessageId: a.id, lastMessageId: b.id };
  expect((await api("/threads", { json: range, origin: "https://evil.example" })).status).toBe(403);
  const stranger = browser(t);
  await signUp(stranger, "stranger@example.com");
  expect((await stranger(`/api/app/organizations/${orgId}/threads`)).status).toBe(403);

  const created = await api("/threads", { json: range });
  expect(created.status).toBe(201);
  const thread = (await created.json()) as Thread;
  expect(thread).toMatchObject({ title: "Onboarding is too long", state: "open", context: { count: 2, moved: false } });

  const list = (await (await api("/threads")).json()) as { threads: Thread[]; nextCursor: string | null };
  expect(list.threads.map((x) => x.id)).toEqual([thread.id]);
  expect(list.nextCursor).toBeNull();
  const inChannel = (await (await api(`/channels/${channelId}/threads`)).json()) as { threads: Thread[] };
  expect(inChannel.threads.map((x) => x.id)).toEqual([thread.id]);
  expect((await api("/threads?tab=nope")).status).toBe(400);
  expect((await api("/threads?cursor=bad")).status).toBe(400);

  const moved = await api(`/threads/${thread.id}/move`, { json: {} });
  expect(moved.status).toBe(200);
  expect(((await moved.json()) as Thread).context?.moved).toBe(true);
  const top = (await (await api(`/channels/${channelId}/messages`)).json()) as { messages: { id: string }[] };
  expect(top.messages.map((m) => m.id)).toEqual([thread.id]);
  expect((await api(`/threads/${thread.id}/return`, { json: {} })).status).toBe(200);

  const renamed = await api(`/threads/${thread.id}`, { method: "PATCH", json: { title: "Lighter onboarding" } });
  expect(((await renamed.json()) as Thread).title).toBe("Lighter onboarding");

  await post("still talking", thread.id);
  const closed = await api(`/threads/${thread.id}/close`, { json: {} });
  expect(((await closed.json()) as Thread).state).toBe("closed");
  const archived = await api(`/threads/${thread.id}/archive`, { json: {} });
  expect(((await archived.json()) as Thread).state).toBe("archived");
  const late = await api(`/channels/${channelId}/messages`, { json: { body: "late", threadId: thread.id } });
  expect(late.status).toBe(409);
  expect(((await late.json()) as { error: { code: string } }).error.code).toBe("thread.archived");
  const tabs = (await (await api("/threads?tab=archived")).json()) as { threads: Thread[] };
  expect(tabs.threads.map((x) => x.id)).toEqual([thread.id]);
  const back = await api(`/threads/${thread.id}/unarchive`, { json: {} });
  expect(((await back.json()) as Thread).state).toBe("closed");
  expect(((await (await api(`/threads/${thread.id}`)).json()) as Thread).state).toBe("closed");
});

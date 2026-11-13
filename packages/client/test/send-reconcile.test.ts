import { afterEach, expect, test } from "bun:test";
import { MutationObserver, onlineManager, QueryClient, QueryObserver } from "@tanstack/react-query";
import type { ApiClient, Message } from "../src/index";
import { cacheMessage, catchUpChannel, keys, messagesQuery, outbox, postMessageMutation } from "../src/index";
import { answerWithin, sendWaits } from "../src/lib/errors";

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const server = (clientId: string, over: Partial<Message> = {}): Message => ({
  id: `real-${clientId}`,
  channelId: "c1",
  threadId: null,
  author: { type: "person", id: "u1" },
  body: "oi",
  mentionedAgentIds: [],
  agentRunId: null,
  meta: { clientId },
  clientId,
  createdAt: new Date(Date.now() + 1000).toISOString(),
  ...over,
});

/** `chat.post` answers when the test says; `chat.messages` reads what the test gives. */
function setup() {
  const qc = new QueryClient();
  const answer = deferred<Message>();
  let read: () => Promise<Message[]> = async () => [];
  const api = {
    chat: {
      post: () => answer.promise,
      messages: () => read(),
    },
  } as unknown as ApiClient;
  const observer = new MutationObserver(qc, postMessageMutation(api, qc, "o1", "c1", { me: { id: "u1" } }));
  const send = (clientId: string, threadId: string | null = null) => {
    void observer.mutate({ body: "oi", clientId, threadId }).catch(() => {});
  };
  const list = () => qc.getQueryData<Message[]>(keys.messages("o1", "c1")) ?? [];
  const thread = (root: string) => qc.getQueryData<Message[]>(keys.thread("o1", "c1", root)) ?? [];
  const tick = () => new Promise((r) => setTimeout(r, 5));
  return {
    qc,
    api,
    answer,
    send,
    list,
    thread,
    tick,
    reads: (next: () => Promise<Message[]>) => {
      read = next;
    },
  };
}

const ids = (list: Message[]) => list.map((m) => `${m.id}${m.local ? `:${m.local}` : ""}`);

afterEach(() => {
  onlineManager.setOnline(true);
  for (const m of outbox.of("o1")) outbox.remove(m.clientId ?? "");
});

test("the POST answers, then the socket's copy comes: one sent message", async () => {
  const s = setup();
  s.qc.setQueryData(keys.messages("o1", "c1"), []);
  s.send("k1");
  await s.tick();
  expect(ids(s.list())).toEqual(["local-k1:pending"]);
  s.answer.resolve(server("k1"));
  await s.tick();
  cacheMessage(s.qc, "o1", server("k1"));
  expect(ids(s.list())).toEqual(["real-k1"]);
});

test("the socket's copy comes first, then the POST answers: one sent message", async () => {
  const s = setup();
  s.qc.setQueryData(keys.messages("o1", "c1"), []);
  s.send("k1");
  await s.tick();
  cacheMessage(s.qc, "o1", server("k1"));
  expect(ids(s.list())).toEqual(["real-k1"]);
  s.answer.resolve(server("k1"));
  await s.tick();
  expect(ids(s.list())).toEqual(["real-k1"]);
});

test("only the socket's copy comes (the POST hangs): sent", async () => {
  const s = setup();
  s.qc.setQueryData(keys.messages("o1", "c1"), []);
  s.send("k1");
  await s.tick();
  cacheMessage(s.qc, "o1", server("k1"));
  expect(ids(s.list())).toEqual(["real-k1"]);
});

test("only the POST answers (the socket's copy never comes): sent", async () => {
  const s = setup();
  s.qc.setQueryData(keys.messages("o1", "c1"), []);
  s.send("k1");
  await s.tick();
  s.answer.resolve(server("k1"));
  await s.tick();
  expect(ids(s.list())).toEqual(["real-k1"]);
});

test("a thread reply, socket first or POST first: out of the channel, once in the thread", async () => {
  for (const socketFirst of [true, false]) {
    const s = setup();
    s.qc.setQueryData(keys.messages("o1", "c1"), []);
    s.qc.setQueryData(keys.thread("o1", "c1", "root"), []);
    s.send("k1", "root");
    await s.tick();
    const real = server("k1", { threadId: "root" });
    if (socketFirst) cacheMessage(s.qc, "o1", real);
    s.answer.resolve(real);
    await s.tick();
    if (!socketFirst) cacheMessage(s.qc, "o1", real);
    expect(ids(s.list())).toEqual([]);
    expect(ids(s.thread("root"))).toEqual(["real-k1"]);
  }
});

test("a read made before my message was written, answered after its copy came live, keeps that copy", async () => {
  const s = setup();
  s.qc.setQueryData(keys.messages("o1", "c1"), []);
  const stale = deferred<Message[]>();
  s.reads(() => stale.promise);
  const reading = s.qc.fetchQuery({ ...messagesQuery(s.api, "o1", "c1"), staleTime: 0 });
  s.send("k1");
  await s.tick();
  cacheMessage(s.qc, "o1", server("k1"));
  s.answer.resolve(server("k1"));
  await s.tick();
  stale.resolve([]);
  await reading;
  expect(ids(s.list())).toEqual(["real-k1"]);
});

test("a read answered while my message is on its way keeps it sending; one that has it replaces it", async () => {
  const s = setup();
  s.qc.setQueryData(keys.messages("o1", "c1"), []);
  s.send("k1");
  await s.tick();
  s.reads(async () => []);
  await s.qc.fetchQuery({ ...messagesQuery(s.api, "o1", "c1"), staleTime: 0 });
  expect(ids(s.list())).toEqual(["local-k1:pending"]);
  s.reads(async () => [server("k1")]);
  await s.qc.fetchQuery({ ...messagesQuery(s.api, "o1", "c1"), staleTime: 0 });
  expect(ids(s.list())).toEqual(["real-k1"]);
});

test("a reconnect's catch-up finds my message written while the POST hangs: sent", async () => {
  const s = setup();
  s.qc.setQueryData(keys.messages("o1", "c1"), []);
  s.send("k1");
  await s.tick();
  // The channel is open on screen: its list is an active query, which the catch-up reads again.
  const stop = new QueryObserver(s.qc, messagesQuery(s.api, "o1", "c1")).subscribe(() => {});
  s.reads(async () => [server("k1")]);
  await catchUpChannel(s.api, s.qc, "o1", "c1");
  expect(ids(s.list())).toEqual(["real-k1"]);
  stop();
});

test("offline as the browser says, the POST still goes: no answer waits in the outbox instead of a paused send", async () => {
  const qc = new QueryClient();
  qc.setQueryData(keys.messages("o1", "c1"), []);
  let posted = 0;
  const api = {
    chat: {
      post: async () => {
        posted++;
        throw new TypeError("Failed to fetch");
      },
    },
  } as unknown as ApiClient;
  onlineManager.setOnline(false);
  const observer = new MutationObserver(qc, postMessageMutation(api, qc, "o1", "c1", { me: { id: "u1" } }));
  void observer.mutate({ body: "oi", clientId: "k1" }).catch(() => {});
  await new Promise((r) => setTimeout(r, 5));
  expect(posted).toBe(1);
  expect(outbox.has("k1")).toBe(true);
  expect(ids(qc.getQueryData<Message[]>(keys.messages("o1", "c1")) ?? [])).toEqual(["local-k1:failed"]);
});

test("a request with no answer in time fails as unanswered, so the send waits in the outbox; one that answers passes", async () => {
  const hung = answerWithin(new Promise<never>(() => {}), 5).catch((e: unknown) => e);
  expect(sendWaits(await hung)).toBe(true);
  expect(await answerWithin(Promise.resolve("ok"), 50)).toBe("ok");
});

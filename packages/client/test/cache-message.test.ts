import { expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { ApiClient, Message, ThreadInfo } from "../src/index";
import {
  cacheMessage,
  cacheReceipts,
  catchUpChannel,
  keys,
  loadThreadRange,
  messagesQuery,
  outbox,
  refreshRepliedThread,
  repliedThread,
  startThreadCache,
} from "../src/index";
import { withLocalCopies } from "../src/lib/timeline";

const msg = (over: Partial<Message>): Message => ({
  id: "m",
  channelId: "c1",
  threadId: null,
  author: { type: "person", id: "u1" },
  body: "muito bom",
  mentionedAgentIds: [],
  agentRunId: null,
  meta: {},
  createdAt: "2026-10-16T04:24:00.000Z",
  ...over,
});

test("a reply that starts a thread replaces its 'sending…' copy (which waits in the channel list)", () => {
  const qc = new QueryClient();
  const root = msg({ id: "root", body: "carrossel pronto", createdAt: "2026-10-16T04:19:00.000Z" });
  const local = msg({ id: "local-k1", threadId: "root", clientId: "k1", local: "pending" });
  qc.setQueryData(keys.messages("o1", "c1"), [root, local]);

  cacheMessage(qc, "o1", msg({ id: "real", threadId: "root", clientId: "k1" }));

  expect(qc.getQueryData<Message[]>(keys.messages("o1", "c1"))?.map((m) => m.id)).toEqual(["root"]);
});

test("a new top-level message starts its thread's list with itself; a list already there stays", () => {
  const qc = new QueryClient();
  const sticker = msg({ id: "s1", body: "", meta: { media: { kind: "sticker", agentId: "a1", mood: "love" } } });
  startThreadCache(qc, "o1", sticker);
  expect(qc.getQueryData<Message[]>(keys.thread("o1", "c1", "s1"))?.map((m) => m.id)).toEqual(["s1"]);
  const kept = [sticker, msg({ id: "r1", threadId: "s1" })];
  qc.setQueryData(keys.thread("o1", "c1", "s1"), kept);
  startThreadCache(qc, "o1", sticker);
  expect(qc.getQueryData<Message[]>(keys.thread("o1", "c1", "s1"))?.map((m) => m.id)).toEqual(["s1", "r1"]);
  // A reply starts no thread of its own.
  startThreadCache(qc, "o1", msg({ id: "r2", threadId: "s1" }));
  expect(qc.getQueryData(keys.thread("o1", "c1", "r2"))).toBeUndefined();
});

test("a live reply to a thread nobody read starts no list: one reply must not pass for the whole thread", () => {
  const qc = new QueryClient();
  qc.setQueryData(keys.messages("o1", "c1"), [msg({ id: "root" })]);
  cacheMessage(qc, "o1", msg({ id: "r1", threadId: "root" }));
  expect(qc.getQueryData(keys.thread("o1", "c1", "root"))).toBeUndefined();
});

test("a live reply while the thread's first read is on its way: under its root, and that read keeps it", async () => {
  const qc = new QueryClient();
  const root = msg({ id: "old" });
  const reply = msg({ id: "r1", threadId: "old", createdAt: "2026-10-16T04:25:00.000Z" });
  qc.setQueryData(keys.messages("o1", "c1"), [msg({ id: "new" })]);
  qc.setQueryData(keys.olderPages("o1", "c1"), { pages: [root], done: false });
  let answer = (_: Message[]) => {};
  const read = new Promise<Message[]>((resolve) => {
    answer = resolve;
  });
  const key = keys.thread("o1", "c1", "old");
  const reading = qc.fetchQuery({
    queryKey: key,
    queryFn: async ({ client, queryKey }) => {
      const start = client.getQueryData<Message[]>(queryKey);
      return withLocalCopies(await read, client.getQueryData<Message[]>(queryKey), () => false, start);
    },
  });
  cacheMessage(qc, "o1", reply);
  expect(qc.getQueryData<Message[]>(key)?.map((m) => m.id)).toEqual(["old", "r1"]);
  answer([root]);
  await reading;
  expect(qc.getQueryData<Message[]>(key)?.map((m) => m.id)).toEqual(["old", "r1"]);
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a live reply to a thread open on a read that failed: it reads again, nothing is lost", async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const key = keys.thread("o1", "c1", "root");
  let up = false;
  const observer = new QueryObserver<Message[]>(qc, {
    queryKey: key,
    queryFn: async () => {
      if (!up) throw new Error("down");
      return [msg({ id: "root" }), msg({ id: "r1", threadId: "root" })];
    },
  });
  const off = observer.subscribe(() => {});
  await tick();
  expect(observer.getCurrentResult().isError).toBe(true);
  up = true;
  cacheMessage(qc, "o1", msg({ id: "r1", threadId: "root" }));
  await tick();
  expect(qc.getQueryData<Message[]>(key)?.map((m) => m.id)).toEqual(["root", "r1"]);
  off();
});

test("catching up: only a reply it added refreshes the thread lists", async () => {
  const qc = new QueryClient();
  const key = keys.thread("o1", "c1", "root");
  const line = keys.channelThreads("o1", "c1", "all");
  const root = msg({ id: "root" });
  const reply = msg({ id: "r1", threadId: "root" });
  qc.setQueryData(key, [root]);
  qc.setQueryData(line, {});
  const observer = new QueryObserver(qc, { queryKey: key, queryFn: async () => [root], staleTime: Infinity });
  const off = observer.subscribe(() => {});
  let read = [root];
  const api = { chat: { messages: async () => read } } as unknown as ApiClient;
  await catchUpChannel(api, qc, "o1", "c1");
  expect(qc.getQueryState(line)?.isInvalidated).toBe(false);
  read = [root, reply];
  await catchUpChannel(api, qc, "o1", "c1");
  expect(qc.getQueryState(line)?.isInvalidated).toBe(true);
  off();
});

test("the event of a reply says its thread; too big for it too; an agent's sticker after its reply none", () => {
  const event = (over: object) => ({ type: "message.created" as const, channelId: "c1", messageId: "m", ...over });
  expect(repliedThread(event({ message: msg({ threadId: "t1" }) }))).toBe("t1");
  expect(repliedThread(event({ threadId: "t1" }))).toBe("t1");
  expect(repliedThread(event({ message: msg({}) }))).toBeNull();
  expect(repliedThread(event({ threadId: null }))).toBeNull();
  expect(repliedThread(event({ message: msg({ threadId: "t1", meta: { mediaInRun: true } }) }))).toBeNull();
});

test("a moved range reads what came before its root: its replies since can't push it out", async () => {
  const seen: unknown[] = [];
  const old = msg({ id: "moved", threadId: "root", createdAt: "2026-10-16T04:00:00.000Z" });
  const api = {
    chat: {
      messages: async (_o: string, _c: string, options: unknown) => {
        seen.push(options);
        return [msg({ id: "root", createdAt: "2026-10-16T05:00:00.000Z" }), old];
      },
    },
  } as unknown as ApiClient;
  const thread = {
    id: "root",
    channelId: "c1",
    createdAt: "2026-10-16T05:00:00.000Z",
    context: { moved: true },
  } as unknown as ThreadInfo;
  expect((await loadThreadRange(api, "o1", thread)).map((m) => m.id)).toEqual(["moved"]);
  expect(seen).toEqual([{ threadId: "root", before: thread.createdAt, limit: 200 }]);
});

test("a reply refreshes the thread lists and its own thread's header, no other; a task's also its count", () => {
  const qc = new QueryClient();
  const stale = (key: readonly unknown[]) => qc.getQueryState(key)?.isInvalidated;
  const line = keys.channelThreads("o1", "c1", "all");
  const mine = keys.threadInfo("o1", "t1");
  const other = keys.threadInfo("o1", "t2");
  const task = keys.issues("o1");
  for (const key of [line, mine, other, task]) qc.setQueryData(key, {});
  refreshRepliedThread(qc, "o1", "t1");
  expect([stale(line), stale(mine), stale(other), stale(task)]).toEqual([true, true, false, false]);
  qc.setQueryData(mine, { channelKind: "task" });
  refreshRepliedThread(qc, "o1", "t1");
  expect(stale(task)).toBe(true);
});

test("reading a conversation again (after a reconnect) keeps my messages still sending or waiting to go out, not one the server refused", async () => {
  const qc = new QueryClient();
  const before = msg({ id: "before", createdAt: "2026-10-16T04:10:00.000Z" });
  const waiting = msg({ id: "local-k1", clientId: "k1", local: "failed", createdAt: "2026-10-16T04:20:00.000Z" });
  const sending = msg({ id: "local-k2", clientId: "k2", local: "pending", createdAt: "2026-10-16T04:25:00.000Z" });
  const landed = msg({ id: "local-k3", clientId: "k3", local: "pending", createdAt: "2026-10-16T04:26:00.000Z" });
  const refused = msg({ id: "local-k4", clientId: "k4", local: "failed", createdAt: "2026-10-16T04:27:00.000Z" });
  qc.setQueryData(keys.messages("o1", "c1"), [before, waiting, sending, landed, refused]);
  outbox.add("o1", waiting);
  // The server has the third already (its own copy, by `clientId`), and a message written meanwhile.
  const server = [
    before,
    msg({ id: "other", author: { type: "person", id: "u2" }, createdAt: "2026-10-16T04:22:00.000Z" }),
    msg({ id: "real-k3", clientId: "k3", createdAt: "2026-10-16T04:26:01.000Z" }),
  ];
  const api = { chat: { messages: async () => structuredClone(server) } } as unknown as ApiClient;

  await qc.fetchQuery({ ...messagesQuery(api, "o1", "c1"), staleTime: 0 });
  outbox.remove("k1");

  // The one still on its way goes last: the server stamps it when it writes it, after everything it has.
  expect(qc.getQueryData<Message[]>(keys.messages("o1", "c1"))?.map((m) => m.id)).toEqual([
    "before",
    "local-k1",
    "other",
    "real-k3",
    "local-k2",
  ]);
});

test("catching up a channel adds what its open lists lack and keeps what they hold; a read's receipts go on their copies", async () => {
  const qc = new QueryClient();
  const asked = msg({ id: "asked", body: "@ada e o login?", createdAt: "2026-10-16T04:20:00.000Z" });
  const agent = (id: string, body: string, createdAt: string, threadId: string | null = null) =>
    msg({ id, threadId, author: { type: "agent", id: "ada" }, body, createdAt });
  const live = agent("live", "Olhando agora.", "2026-10-16T04:30:00.000Z");
  const receipts = {
    seenBy: ["ada"],
    pickedBy: ["ada"],
    handled: [{ agentId: "ada", runId: "r1", status: "done" as const }],
    blocked: [],
  };
  // What the server has: what was written before the channel's events reached us, never `live` (its read was
  // made before it). Each read is new copies, as over HTTP.
  const server = [
    { ...asked, receipts },
    agent("missed", "Deploy revertido.", "2026-10-16T04:21:00.000Z"),
    agent("reply", "Corrigido.", "2026-10-16T04:22:00.000Z", "asked"),
  ];
  const api = {
    chat: {
      messages: async (_orgId: string, _channelId: string, options: { threadId?: string }) =>
        structuredClone(
          server.filter((m) =>
            options.threadId ? m.id === options.threadId || m.threadId === options.threadId : !m.threadId,
          ),
        ),
    },
  } as unknown as ApiClient;
  // The page's open lists: the latest page, with a message heard live since, and the thread under `asked`.
  qc.setQueryData(keys.messages("o1", "c1"), [asked, live]);
  qc.setQueryData(keys.thread("o1", "c1", "asked"), [asked]);
  const open = [keys.messages("o1", "c1"), keys.thread("o1", "c1", "asked")].map((queryKey) =>
    new QueryObserver(qc, { queryKey, queryFn: async () => [], staleTime: Number.POSITIVE_INFINITY }).subscribe(
      () => {},
    ),
  );
  const ids = (key: readonly unknown[]) => qc.getQueryData<Message[]>(key)?.map((m) => m.id);

  const read = await catchUpChannel(api, qc, "o1", "c1");
  expect(ids(keys.messages("o1", "c1"))).toEqual(["asked", "missed", "live"]);
  expect(ids(keys.thread("o1", "c1", "asked"))).toEqual(["asked", "reply"]);
  expect(qc.getQueryData<Message[]>(keys.messages("o1", "c1"))?.[0]?.receipts).toBeUndefined();

  cacheReceipts(qc, "o1", "c1", read);
  for (const key of [keys.messages("o1", "c1"), keys.thread("o1", "c1", "asked")]) {
    const copy = qc.getQueryData<Message[]>(key)?.[0];
    expect(copy?.receipts).toEqual(receipts);
    expect(copy?.body).toBe("@ada e o login?");
  }
  expect(qc.getQueryData<Message[]>(keys.messages("o1", "c1"))?.at(-1)).toBe(live);
  for (const off of open) off();
});

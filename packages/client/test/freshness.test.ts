import { expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { ApiClient, Message } from "../src/index";
import {
  catchUpChannel,
  createHttpApi,
  createRequester,
  keys,
  messagesQuery,
  NetworkError,
  openConversation,
  READ_TIMEOUT_MS,
} from "../src/index";
import { LiveQueryClient } from "../src/lib/live-query-client";

/*
 * A conversation's caches stay true to the server: a read never hangs forever, a catch-up that fails leaves its lists
 * to the query client, and a conversation no screen listens to reads again when it is shown.
 */

const msg = (over: Partial<Message>): Message => ({
  id: "m",
  channelId: "c1",
  threadId: null,
  author: { type: "person", id: "u1" },
  body: "oi",
  mentionedAgentIds: [],
  agentRunId: null,
  meta: {},
  createdAt: "2026-11-08T21:00:00.000Z",
  ...over,
});

/** A fetch whose calls wait until answered; an aborted one rejects as a browser's does. */
function heldFetch() {
  const calls: { url: string; init: RequestInit; answer: (body: unknown) => void }[] = [];
  const fetch = (url: string, init: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      init.signal?.addEventListener("abort", () =>
        reject(new DOMException("The operation was aborted.", "AbortError")),
      );
      calls.push({ url, init, answer: (body) => resolve(new Response(JSON.stringify(body), { status: 200 })) });
    });
  return { fetch, calls };
}

test("a read that never answers ends as a NetworkError once its deadline passes; a write waits", async () => {
  expect(READ_TIMEOUT_MS).toBe(30_000);
  const { fetch, calls } = heldFetch();
  const request = createRequester({ fetch, readTimeoutMs: 20 });
  const read = request("/api/app/x").catch((e: unknown) => e);
  const write = request("/api/app/y", { json: { a: 1 } });
  const error = await read;
  expect(error).toBeInstanceOf(NetworkError);
  expect(calls[1]?.init.signal).toBeUndefined();
  calls[1]?.answer({ ok: true });
  expect(await write).toEqual({ ok: true });
});

test("a read answered in time is untouched by its deadline", async () => {
  const { fetch, calls } = heldFetch();
  const request = createRequester({ fetch, readTimeoutMs: 1000 });
  const read = request("/api/app/x");
  calls[0]?.answer({ ok: 1 });
  expect(await read).toEqual({ ok: 1 });
});

test("a conversation shown while its last read hangs: the deadline ends it, the next try lands, the loading ends", async () => {
  const { fetch, calls } = heldFetch();
  const api = createHttpApi({ fetch, readTimeoutMs: 20 }) as ApiClient;
  const qc = new LiveQueryClient({ defaultOptions: { queries: { retry: 1, retryDelay: 0 } } });
  qc.setQueryData(keys.messages("o1", "c1"), [msg({ id: "old" })]);
  // A read of it on its way that will never answer (a dead connection), then the screen shows it and joins that read.
  void qc.prefetchQuery({ ...messagesQuery(api, "o1", "c1"), staleTime: 0 });
  const observer = new QueryObserver(qc, { ...messagesQuery(api, "o1", "c1"), refetchOnMount: "always" });
  const seen: string[][] = [];
  const off = observer.subscribe((r) => seen.push((r.data ?? []).map((m) => m.id)));
  for (let i = 0; i < 50 && calls.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
  expect(calls).toHaveLength(2);
  calls[1]?.answer({ messages: [msg({ id: "old" }), msg({ id: "new", createdAt: "2026-11-08T21:05:00.000Z" })] });
  for (let i = 0; i < 50 && observer.getCurrentResult().fetchStatus !== "idle"; i++)
    await new Promise((r) => setTimeout(r, 10));
  expect(observer.getCurrentResult().fetchStatus).toBe("idle");
  expect(seen.at(-1)).toEqual(["old", "new"]);
  off();
});

test("a catch-up whose read fails leaves the conversation's open lists to the query client, which reads them again", async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const server = [msg({ id: "root" }), msg({ id: "r-1", threadId: "root", createdAt: "2026-11-08T21:05:00.000Z" })];
  let failing = true;
  const reads: string[] = [];
  const api = {
    chat: {
      messages: async (_o: string, _c: string, options?: { threadId?: string }) => {
        reads.push(options?.threadId ?? "channel");
        if (options?.threadId && failing) {
          failing = false;
          throw new NetworkError(new TypeError("Failed to fetch"));
        }
        return server.filter((m) => (options?.threadId ? m.id === "root" || m.threadId === "root" : !m.threadId));
      },
    },
  } as unknown as ApiClient;
  const threadKey = keys.thread("o1", "c1", "root");
  qc.setQueryData(threadKey, [server[0]]);
  const observer = new QueryObserver(qc, {
    queryKey: threadKey,
    queryFn: () => api.chat.messages("o1", "c1", { threadId: "root" }),
    staleTime: 30_000,
  });
  const off = observer.subscribe(() => {});
  await catchUpChannel(api, qc, "o1", "c1");
  for (let i = 0; i < 20 && qc.getQueryState(threadKey)?.fetchStatus !== "idle"; i++)
    await new Promise((r) => setTimeout(r, 5));
  expect(qc.getQueryData<Message[]>(threadKey)?.map((m) => m.id)).toEqual(["root", "r-1"]);
  expect(reads).toEqual(["root", "root"]);
  off();
});

test("a read still on its way when a conversation's last screen closes is dropped: the next showing asks anew", async () => {
  const qc = new QueryClient();
  const key = keys.thread("o1", "c1", "root");
  qc.setQueryData(key, [msg({ id: "root" })]);
  const answers: ((list: Message[]) => void)[] = [];
  const queryFn = () => new Promise<Message[]>((resolve) => answers.push(resolve));
  const close = openConversation(qc, "o1", "c1");
  void qc.prefetchQuery({ queryKey: key, queryFn, staleTime: 0 });
  expect(qc.getQueryState(key)?.fetchStatus).toBe("fetching");
  close();
  expect(qc.getQueryState(key)?.fetchStatus).toBe("idle");
  expect(qc.getQueryData<Message[]>(key)?.map((m) => m.id)).toEqual(["root"]);
  // The old answer comes after all: nothing takes it.
  answers[0]?.([msg({ id: "root" })]);
  const observer = new QueryObserver(qc, { queryKey: key, queryFn, refetchOnMount: "always" });
  const off = observer.subscribe(() => {});
  expect(answers).toHaveLength(2);
  answers[1]?.([msg({ id: "root" }), msg({ id: "r-1", threadId: "root" })]);
  await new Promise((r) => setTimeout(r, 5));
  expect(qc.getQueryData<Message[]>(key)?.map((m) => m.id)).toEqual(["root", "r-1"]);
  off();
});

test("a conversation whose last screen closed reads again when shown; one still open beside it keeps it as it is", async () => {
  const qc = new QueryClient();
  const list = keys.messages("o1", "c1");
  const lines = keys.channelThreads("o1", "c1", "all");
  qc.setQueryData(list, [msg({ id: "m-1" })]);
  qc.setQueryData(lines, { threads: [], nextCursor: null });
  const channel = openConversation(qc, "o1", "c1");
  const thread = openConversation(qc, "o1", "c1");
  thread();
  expect(qc.getQueryState(list)?.isInvalidated).toBe(false);
  channel();
  channel();
  expect(qc.getQueryState(list)?.isInvalidated).toBe(true);
  expect(qc.getQueryState(lines)?.isInvalidated).toBe(true);
  // Marked, never read while nothing shows it.
  expect(qc.getQueryState(list)?.fetchStatus).toBe("idle");
  // Opened again, counted from one: its next close marks it again.
  qc.setQueryData(list, [msg({ id: "m-1" })]);
  const again = openConversation(qc, "o1", "c1");
  expect(qc.getQueryState(list)?.isInvalidated).toBe(false);
  again();
  expect(qc.getQueryState(list)?.isInvalidated).toBe(true);
});

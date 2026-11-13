import { afterEach, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { ApiClient, ConnectionStatus, Me, Message, OutboxStorage } from "../src/index";
import { ApiError, flushOutbox, keepSending, keys, outbox } from "../src/index";
import { sendWaits } from "../src/lib/errors";

const msg = (clientId: string, over: Partial<Message> = {}): Message => ({
  id: `local-${clientId}`,
  channelId: "c1",
  threadId: null,
  author: { type: "person", id: "u1" },
  body: clientId,
  mentionedAgentIds: [],
  agentRunId: null,
  meta: {},
  clientId,
  local: "failed",
  createdAt: "2026-10-29T10:00:00.000Z",
  ...over,
});

const me = (id: string) => ({ user: { id }, organizations: [] }) as unknown as Me;

const memory = (value: string | null = null) => {
  const store: OutboxStorage & { value: () => string | null } = {
    read: () => value,
    write: (v) => {
      value = v;
    },
    value: () => value,
  };
  return store;
};

afterEach(() => {
  for (const m of outbox.of("o1")) outbox.remove(m.clientId ?? "");
});

/** `chat.post` that answers with the server's copy, or throws what `fail` gives for that message. */
function fakeApi(fail: (body: { clientId: string }) => unknown = () => null) {
  const posts: { channelId: string; clientId: string }[] = [];
  const api = {
    chat: {
      post: async (_orgId: string, channelId: string, body: { clientId: string; body: string }) => {
        posts.push({ channelId, clientId: body.clientId });
        await new Promise((r) => setTimeout(r, 1));
        const error = fail(body);
        if (error) throw error;
        return { ...msg(body.clientId, { channelId }), id: `real-${body.clientId}`, local: undefined };
      },
    },
  } as unknown as ApiClient;
  return { api, posts };
}

test("no answer at all, or only the proxy's while the server restarts, waits; the server refusing it, or a bug, fails", () => {
  expect(sendWaits(new TypeError("Failed to fetch"))).toBe(true);
  expect(sendWaits(new TypeError("Network request failed"))).toBe(true);
  for (const status of [502, 503, 504, 520, 521, 522, 523, 524]) {
    expect(sendWaits(new ApiError(status, `http_${status}`, "Bad Gateway"))).toBe(true);
  }
  // The server's own errors carry their code: a refusal, or a bug (500), fails.
  expect(sendWaits(new ApiError(503, "unavailable", "Try again"))).toBe(false);
  expect(sendWaits(new ApiError(502, "machine.offline", "The computer is offline"))).toBe(false);
  expect(sendWaits(new ApiError(500, "http_500", "Internal Server Error"))).toBe(false);
  expect(sendWaits(new ApiError(409, "thread.archived", "The thread was archived"))).toBe(false);
  expect(sendWaits(new Error("boom"))).toBe(false);
});

test("what waits goes out in order from wherever the person is, once; a refused one leaves, someone else's never goes", async () => {
  const qc = new QueryClient();
  qc.setQueryData(keys.me, me("u1"));
  const here = msg("k1");
  qc.setQueryData(keys.messages("o1", "c1"), [here]);
  outbox.add("o1", here);
  // A conversation the cache let go meanwhile (30 min away), a refusal, and a message of another account.
  outbox.add("o1", msg("k2", { channelId: "c2" }));
  outbox.add("o1", msg("k3", { channelId: "c2" }));
  outbox.add("o1", msg("k4", { author: { type: "person", id: "u9" } }));
  const { api, posts } = fakeApi(({ clientId }) =>
    clientId === "k3" ? new ApiError(409, "thread.archived", "The thread was archived") : null,
  );
  const refused: unknown[] = [];

  // Two triggers at once (the socket opening, a retry): each message goes once.
  const [waits] = await Promise.all([
    flushOutbox(api, qc, "o1", (e) => refused.push(e)),
    flushOutbox(api, qc, "o1", (e) => refused.push(e)),
  ]);

  expect(waits).toBe(false);
  expect(posts).toEqual([
    { channelId: "c1", clientId: "k1" },
    { channelId: "c2", clientId: "k2" },
    { channelId: "c2", clientId: "k3" },
  ]);
  expect(refused.map((e) => (e as ApiError).code)).toEqual(["thread.archived"]);
  expect(outbox.size).toBe(0);
  expect(qc.getQueryData<Message[]>(keys.messages("o1", "c1"))?.map((m) => m.id)).toEqual(["real-k1"]);
  // Not made up from one message: that conversation reads the server when it opens.
  expect(qc.getQueryData(keys.messages("o1", "c2"))).toBeUndefined();
});

test("while the server still answers through the proxy only, the first keeps waiting and the rest after it", async () => {
  const qc = new QueryClient();
  qc.setQueryData(keys.me, me("u1"));
  outbox.add("o1", msg("k1"));
  outbox.add("o1", msg("k2"));
  const { api, posts } = fakeApi(() => new ApiError(502, "http_502", "Bad Gateway"));

  expect(await flushOutbox(api, qc, "o1")).toBe(true);

  expect(posts.map((p) => p.clientId)).toEqual(["k1"]);
  expect(outbox.of("o1").map((m) => m.clientId)).toEqual(["k1", "k2"]);
});

test("it tries when the connection opens, again while it stays open and something waits, and stops with it", async () => {
  const listeners = new Set<(s: ConnectionStatus) => void>();
  const connection = {
    status: "connecting" as ConnectionStatus,
    onStatus(listener: (s: ConnectionStatus) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const to = (status: ConnectionStatus) => {
    connection.status = status;
    for (const l of listeners) l(status);
  };
  const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
  outbox.add("o1", msg("k1"));
  let tries = 0;
  const stop = keepSending(
    connection,
    async () => {
      tries++;
      return outbox.size > 0;
    },
    20,
  );

  expect(tries).toBe(0);
  to("open");
  expect(tries).toBe(1);
  await tick(50);
  expect(tries).toBeGreaterThanOrEqual(2);
  to("reconnecting");
  await tick(10);
  const down = tries;
  await tick(50);
  expect(tries).toBe(down);
  to("open");
  expect(tries).toBe(down + 1);
  outbox.remove("k1");
  await tick(50);
  expect(tries).toBe(down + 1);
  stop();
  to("reconnecting");
  to("open");
  expect(tries).toBe(down + 1);
});

test("kept through a reload and shown again in its conversation; gone with the signed-in person", () => {
  const first = new QueryClient();
  const saved = memory();
  const stopFirst = outbox.keep(first, saved);
  outbox.add("o1", msg("k1", { local: "pending" }));
  expect(JSON.parse(saved.value() ?? "[]")).toEqual([{ orgId: "o1", message: msg("k1") }]);
  stopFirst();
  outbox.remove("k1");

  // The page loads again: the snapshot brought the conversation back, without the message.
  const qc = new QueryClient();
  qc.setQueryData(keys.me, me("u1"));
  const other = msg("x", { id: "other", local: undefined, createdAt: "2026-10-29T09:00:00.000Z" });
  qc.setQueryData(keys.messages("o1", "c1"), [other]);
  const store = memory(saved.value());
  const stop = outbox.keep(qc, store);
  outbox.show(qc);
  expect(outbox.has("k1")).toBe(true);
  expect(qc.getQueryData<Message[]>(keys.messages("o1", "c1"))?.map((m) => m.id)).toEqual(["other", "local-k1"]);

  qc.clear();
  expect(outbox.size).toBe(0);
  expect(store.value()).toBe("[]");
  stop();
});

test("what the device kept that can't be sent is left out, and what's behind it still goes", async () => {
  const qc = new QueryClient();
  qc.setQueryData(keys.me, me("u1"));
  const unreadable = { ...msg("k1"), author: undefined };
  const store = memory(JSON.stringify([{ orgId: "o1", message: unreadable }, { orgId: "o1", message: msg("k2") }, 7]));
  const stop = outbox.keep(qc, store);
  const { api, posts } = fakeApi();

  expect(outbox.of("o1").map((m) => m.clientId)).toEqual(["k2"]);
  expect(await flushOutbox(api, qc, "o1")).toBe(false);
  expect(posts.map((p) => p.clientId)).toEqual(["k2"]);
  stop();
});

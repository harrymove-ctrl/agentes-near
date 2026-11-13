import { afterEach, beforeEach, expect, test } from "bun:test";
import { typingTopic } from "@agenteschat/adapters";
import { schema } from "@agenteschat/db";
import { consolidateItem } from "@agenteschat/engine";
import { parseClientFrame } from "../src/realtime/ws";
import { browser, createTestServer, listen, ORIGIN, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
let server: ReturnType<typeof listen>;
beforeEach(async () => {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" }, reply: () => ({ chunks: ["oi"] }) });
  server = listen(t);
});
afterEach(async () => {
  await Promise.race([server.stop(true), Bun.sleep(500)]);
  await t.close();
});

function connect(url: string, headers: Record<string, string>) {
  const frames: Record<string, unknown>[] = [];
  const ws = new WebSocket(url, { headers } as unknown as string[]);
  ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)) as Record<string, unknown>);
  const opened = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("refused"));
  });
  const until = async (pred: (f: Record<string, unknown>) => boolean, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const found = frames.find(pred);
      if (found) return found;
      await Bun.sleep(10);
    }
    throw new Error(`timeout; frames: ${JSON.stringify(frames)}`);
  };
  return { ws, frames, opened, until, send: (f: unknown) => ws.send(JSON.stringify(f)) };
}

test("typing frames fan out to subscribers of the channel (throttled), never to other channels", async () => {
  expect(
    parseClientFrame(JSON.stringify({ type: "typing", channelId: "0193a2b4-0000-7000-8000-000000000000" })),
  ).toEqual({
    type: "typing",
    channelId: "0193a2b4-0000-7000-8000-000000000000",
    threadId: null,
  });
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId } = await seedOrg(owner);
  const url = `ws://127.0.0.1:${server.port}/api/ws?orgId=${orgId}`;
  const a = connect(url, { origin: ORIGIN, cookie: owner.cookie() });
  const b = connect(url, { origin: ORIGIN, cookie: owner.cookie() });
  await Promise.all([a.opened, b.opened]);
  // Typing into a channel this connection didn't subscribe to is ignored.
  a.send({ type: "typing", channelId });
  b.send({ type: "subscribe", channelId });
  await b.until((f) => f.type === "subscribed");
  a.send({ type: "subscribe", channelId });
  await a.until((f) => f.type === "subscribed");
  // The server hears them too, for an agent's quiet window, whoever subscribed (ADR 0112).
  const heard: unknown[] = [];
  t.adapters.pubsub.subscribe(typingTopic, (e) => heard.push(e));
  // Three in a row: two get through (one every 3 s from the apps, one more on a new message's first keystroke).
  a.send({ type: "typing", channelId });
  a.send({ type: "typing", channelId });
  a.send({ type: "typing", channelId });
  const typing = await b.until((f) => f.type === "event" && (f.event as { type: string }).type === "user.typing");
  expect(typing.event).toMatchObject({ type: "user.typing", channelId, threadId: null, ttlMs: 5000 });
  await Bun.sleep(100);
  expect(
    b.frames.filter((f) => f.type === "event" && (f.event as { type: string }).type === "user.typing"),
  ).toHaveLength(2);
  expect(heard).toHaveLength(2);
  expect(heard[0]).toMatchObject({ type: "user.typing", channelId, threadId: null });
  // Typed in a thread: the frame says which, so only that thread's view shows it.
  const threadId = "0193a2b4-0000-7000-8000-0000000000aa";
  b.send({ type: "typing", channelId, threadId });
  const inThread = await a.until(
    (f) => f.type === "event" && (f.event as { threadId?: unknown }).threadId === threadId,
  );
  expect(inThread.event).toMatchObject({ type: "user.typing", channelId, threadId, ttlMs: 5000 });
  a.ws.close();
  b.ws.close();
});

test("send: 201 with the clientId echoed and a Server-Timing for the commit + event", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, channelId } = await seedOrg(owner);
  const res = await owner(`/api/app/organizations/${orgId}/channels/${channelId}/messages`, {
    json: { body: "hello", clientId: "c-1" },
  });
  expect(res.status).toBe(201);
  expect(((await res.json()) as { clientId: string }).clientId).toBe("c-1");
  expect(res.headers.get("server-timing")).toMatch(/^created;dur=\d+(\.\d+)?$/);
});

test("DM API: open, list with unread, read, agent replies; memory undo API", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const opened = (await (await api("/dms", { json: { agentId } })).json()) as { channelId: string; dm: unknown };
  // The DM as the list has it, so an app shows it there without asking for the list again.
  expect(opened.dm).toEqual(((await (await api("/dms")).json()) as { dms: unknown[] }).dms[0]);
  expect(((await (await api("/dms", { json: { agentId } })).json()) as { channelId: string }).channelId).toBe(
    opened.channelId,
  );
  await api(`/channels/${opened.channelId}/messages`, { json: { body: "oi Dev" } });
  await t.drain();
  const dms = (await (await api("/dms")).json()) as {
    dms: { channelId: string; unread: number; with: { type: string } }[];
  };
  expect(dms.dms).toEqual([
    expect.objectContaining({
      channelId: opened.channelId,
      unread: 1,
      with: expect.objectContaining({ type: "agent" }),
    }),
  ]);
  expect((await api(`/channels/${opened.channelId}/read`, { json: {} })).status).toBe(204);
  expect(((await (await api("/dms")).json()) as { dms: { unread: number }[] }).dms[0]?.unread).toBe(0);
  const channels = (await (await api("/channels")).json()) as { channels: { name: string }[] };
  expect(channels.channels.map((c) => c.name)).toEqual(["general"]);

  const item = await consolidateItem(t.db, {
    orgId,
    kind: "fact",
    scopeType: "agent",
    agentId,
    channelIds: [opened.channelId],
    content: "Deploys only after 6pm",
  });
  await t.db.update(schema.contextItems).set({ status: "archived" });
  const undone = await api(`/memories/${item.item.id}/revert`, { json: {} });
  expect(await undone.json()).toMatchObject({ id: item.item.id, archived: false });
});

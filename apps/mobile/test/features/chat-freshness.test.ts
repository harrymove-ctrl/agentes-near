import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { keys, type Message, openConversation } from "@agenteschat/client";
import { LiveQueryClient } from "@agenteschat/client/lib/live-query-client";
import { focusManager, QueryObserver } from "@tanstack/react-query";
import { message } from "./fixtures";

const src = (f: string) => readFileSync(new URL(`../../src/${f}`, import.meta.url), "utf8");

afterEach(() => focusManager.setFocused(undefined));

/** The phone's query client as `createQueryClient` (providers/query.ts) makes it. */
const phoneClient = () =>
  new LiveQueryClient({
    defaultOptions: { queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: true }, mutations: { retry: 0 } },
  });

const until = async (done: () => boolean) => {
  for (let i = 0; i < 50 && !done(); i++) await new Promise((r) => setTimeout(r, 5));
};
const settled = (qc: LiveQueryClient, key: readonly unknown[]) =>
  until(() => qc.getQueryState(key)?.fetchStatus === "idle");

test("the phone's query client: fresh for 30 s, read again when the app comes back", () => {
  const query = src("providers/query.ts");
  expect(query).toContain("staleTime: 30_000");
  expect(query).toContain("refetchOnWindowFocus: true");
});

test("back from the background, the socket opened again counts as a reconnect: every screen reads again", () => {
  const provider = src("providers/realtime.tsx").replace(/\s+/g, " ");
  expect(provider).toContain("if (opened.current === orgId) void queryClient.invalidateQueries();");
  expect(provider).toContain("c.onReconnect(() => void queryClient.invalidateQueries())");
});

test("a chat screen listens while open, and its closing marks the conversation stale", () => {
  const live = src("features/chat/live.ts").replace(/\s+/g, " ");
  expect(live).toContain("const close = openConversation(qc, orgId, channelId);");
  expect(live).toContain("return () => { off(); close(); };");
});

test("back from the background within 30 s: the open chat reads what was said while its socket was closed", async () => {
  const qc = phoneClient();
  // As its provider does: the app's coming back reaches the client.
  qc.mount();
  const key = keys.messages("o1", "c1");
  const server: Message[] = [message({ id: "m-1", channelId: "c1" })];
  let reads = 0;
  const observer = new QueryObserver(qc, {
    queryKey: key,
    queryFn: async () => {
      reads++;
      return [...server];
    },
  });
  const off = observer.subscribe(() => {});
  await settled(qc, key);
  expect(reads).toBe(1);
  // The app goes to the background: its socket closes, and with it the chat's listening.
  focusManager.setFocused(false);
  openConversation(qc, "o1", "c1")();
  server.push(message({ id: "m-2", channelId: "c1", body: "dita com o app fechado" }));
  focusManager.setFocused(true);
  // The client hears of the focus a moment later, then reads.
  await until(() => reads === 2 && qc.getQueryState(key)?.fetchStatus === "idle");
  expect(reads).toBe(2);
  expect(qc.getQueryData<Message[]>(key)?.map((m) => m.id)).toEqual(["m-1", "m-2"]);
  off();
  qc.unmount();
});

test("a chat opened again within 30 s reads again; one still open under a thread doesn't", async () => {
  const qc = phoneClient();
  const key = keys.messages("o1", "c1");
  let reads = 0;
  const options = {
    queryKey: key,
    queryFn: async () => {
      reads++;
      return [message({ id: "m-1", channelId: "c1" })];
    },
  };
  const channel = openConversation(qc, "o1", "c1");
  const first = new QueryObserver(qc, options);
  const offFirst = first.subscribe(() => {});
  await settled(qc, key);
  // A thread pushed over the chat: the chat stays open under it.
  const thread = openConversation(qc, "o1", "c1");
  thread();
  const again = new QueryObserver(qc, options);
  const offAgain = again.subscribe(() => {});
  await settled(qc, key);
  expect(reads).toBe(1);
  offAgain();
  // Back out of the chat, then into it again.
  offFirst();
  channel();
  const reopened = new QueryObserver(qc, options);
  const offReopened = reopened.subscribe(() => {});
  await settled(qc, key);
  expect(reads).toBe(2);
  offReopened();
});

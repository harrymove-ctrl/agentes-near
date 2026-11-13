import { afterEach, expect, test } from "bun:test";
import { grantScopes, notify, type ToolSource } from "@agenteschat/engine";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
afterEach(() => t?.close());

interface Item {
  id: string;
  kind: string;
  waiting: boolean;
  readAt: string | null;
  doneAt: string | null;
  snoozedUntil: string | null;
  source: Record<string, unknown>;
  latest: Record<string, unknown>;
}
interface Page {
  items: Item[];
  counts: Record<string, number>;
  nextCursor: string | null;
}

async function signedIn() {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const seeded = await seedOrg(owner);
  const me = (await (await owner("/api/app/me")).json()) as { user: { id: string } };
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${seeded.orgId}${path}`, init);
  return { owner, api, userId: me.user.id, ...seeded };
}

const github: ToolSource = {
  name: "test-github",
  tools: async () => [
    {
      name: "github_merge_pr",
      description: "Merge a pull request",
      scope: "github:pr.merge",
      inputSchema: { type: "object", properties: { pr: { type: "integer" } }, required: ["pr"] },
      describe: (i) => ({ title: `Merge PR #${i.pr}` }),
      execute: async () => ({ content: "merged" }),
    },
  ],
};

test("an approval waits in the inbox of whoever may decide, and leaves it once decided", async () => {
  t = await createTestServer({
    toolSources: [github],
    reply: (req) => {
      const last = JSON.stringify(req.messages.at(-1)?.content);
      if (last.includes("merged")) return { chunks: ["Merge done."] };
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
  const { api, orgId, channelId, agentId } = await signedIn();
  await grantScopes(t.db, orgId, agentId, [{ connectionId: null, scope: "github:pr.merge" }]);
  await api(`/channels/${channelId}/messages`, { json: { body: "@dev merge 42" } });
  await t.drain();

  const waiting = (await (await api("/notifications?filter=waiting")).json()) as Page;
  expect(waiting.items).toHaveLength(1);
  const [n] = waiting.items;
  expect(n).toMatchObject({ kind: "approval", waiting: true, latest: { title: "Merge PR #42" } });
  expect(typeof n?.source.approvalId).toBe("string");
  expect(typeof n?.latest.expiresAt).toBe("string");
  expect(await (await api("/notifications/count")).json()).toMatchObject({ waiting: 1 });

  expect((await api(`/approvals/${n?.source.approvalId}/approve`, { json: {} })).status).toBe(200);
  const after = (await (await api("/notifications?filter=waiting")).json()) as Page;
  expect(after.items).toEqual([]);
  expect(after.counts.waiting).toBe(0);
});

test("an agent's question waits for the person who asked; answering resolves it", async () => {
  t = await createTestServer({
    reply: (req) => {
      const last = JSON.stringify(req.messages.at(-1)?.content);
      if (last.includes("tool_result")) return { chunks: ["ok"] };
      return {
        chunks: [],
        toolUses: [
          {
            name: "ask_user",
            input: {
              why: "I need a person's answer before I go on: this decides what I change next.",
              question: "Qual ambiente?",
              choices: ["staging", "production"],
            },
          },
        ],
      };
    },
  });
  const { api, channelId } = await signedIn();
  await api(`/channels/${channelId}/messages`, { json: { body: "@dev deploy it" } });
  await t.drain();
  const page = (await (await api("/notifications?filter=mentions")).json()) as Page;
  const q = page.items.find((i) => i.kind === "agent_question");
  expect(q).toMatchObject({
    waiting: true,
    source: { channelId },
    latest: { text: "Qual ambiente?", suggestions: ["staging", "production"] },
  });
  // Asked in the channel: the question is in the main timeline, not a thread.
  expect(q?.source.threadId).toBeUndefined();
  const res = await api(`/questions/${q?.source.questionId}/answer`, { json: { choice: "production" } });
  expect(res.status).toBe(200);
  const after = (await (await api("/notifications")).json()) as Page;
  expect(after.items.some((i) => i.kind === "agent_question")).toBe(false);
});

test("notifications API: read, done and undo, snooze, read-all; session, CSRF and ownership", async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["ok"] }) });
  const { owner, api, orgId, userId, agentId } = await signedIn();
  const deps = { db: t.db, pubsub: t.adapters.pubsub };
  for (const key of ["a", "b", "c"]) {
    await notify(deps, {
      orgId,
      userIds: [userId],
      kind: "dm",
      groupKey: `dm:${key}`,
      actor: { type: "agent", id: agentId },
      source: { label: key },
    });
  }
  const page = (await (await api("/notifications?limit=2")).json()) as Page;
  expect(page.items).toHaveLength(2);
  expect(page.counts).toEqual({ all: 3, mentions: 3, waiting: 0, unread: 3, reactions: 0 });
  expect(page.nextCursor).not.toBeNull();
  const rest = (await (await api(`/notifications?limit=2&cursor=${page.nextCursor}`)).json()) as Page;
  expect(rest.items).toHaveLength(1);
  expect((await api("/notifications?filter=everything")).status).toBe(400);

  const id = page.items[0]?.id ?? "";
  const read = await api(`/notifications/${id}/read`, { json: { read: true } });
  expect(read.status).toBe(200);
  expect(((await read.json()) as Item).readAt).not.toBeNull();
  expect(await (await api("/notifications/count")).json()).toEqual({ unread: 2, waiting: 0 });
  // Every workspace's counts in one call, for the apps' list across servers (ADR 0154); signed out, refused.
  expect(await (await owner("/api/app/me/unread")).json()).toEqual({
    organizations: [{ orgId, unread: 2, waiting: 0 }],
  });
  expect((await browser(t)("/api/app/me/unread")).status).toBe(401);
  expect(
    ((await (await api(`/notifications/${id}/read`, { json: { read: false } })).json()) as Item).readAt,
  ).toBeNull();

  expect(
    ((await (await api(`/notifications/${id}/done`, { json: { done: true } })).json()) as Item).doneAt,
  ).not.toBeNull();
  expect(((await (await api("/notifications")).json()) as Page).counts.all).toBe(2);
  // "Concluídas" lists it.
  expect(((await (await api("/notifications?filter=done")).json()) as Page).items.map((n) => n.id)).toEqual([id]);
  await api(`/notifications/${id}/done`, { json: { done: false } });
  expect(((await (await api("/notifications?filter=done")).json()) as Page).items).toEqual([]);
  expect(((await (await api("/notifications")).json()) as Page).counts.all).toBe(3);

  const until = new Date(Date.now() + 3600_000).toISOString();
  const snoozed = await api(`/notifications/${id}/snooze`, { json: { until } });
  expect(snoozed.status).toBe(200);
  expect(((await snoozed.json()) as Item).snoozedUntil).toBe(until);
  expect(((await (await api("/notifications")).json()) as Page).counts.all).toBe(2);
  expect((await api(`/notifications/${id}/snooze`, { json: { until: "2001-01-01T00:00:00Z" } })).status).toBe(400);

  // Undo the snooze: back in the inbox, nothing else changed; then snooze it again.
  const unsnoozed = (await (await api(`/notifications/${id}/snooze`, { json: { until: null } })).json()) as Item;
  expect(unsnoozed).toMatchObject({ id, snoozedUntil: null, readAt: null, doneAt: null });
  expect(((await (await api("/notifications")).json()) as Page).counts.all).toBe(3);
  expect((await api(`/notifications/${id}/snooze`, { json: { until } })).status).toBe(200);

  const all = (await (await api("/notifications/read-all", { json: {} })).json()) as { ids: string[] };
  expect(all.ids).toHaveLength(2); // the snoozed one is not in the inbox
  expect(await (await api("/notifications/count")).json()).toEqual({ unread: 0, waiting: 0 });

  // CSRF: another origin, or not JSON, is refused before anything changes.
  expect(
    (await api(`/notifications/${id}/read`, { json: { read: true }, origin: "https://evil.example" })).status,
  ).toBe(403);
  // Without a session.
  expect((await browser(t)(`/api/app/organizations/${orgId}/notifications`)).status).toBe(401);
  // Another person: not a member here; and a member can't touch someone else's notification.
  // Invited, never accepted: signed up but not a member.
  await owner(`/api/app/organizations/${orgId}/invitations`, { json: { email: "other@example.com", role: "member" } });
  const other = browser(t);
  await signUp(other, "other@example.com");
  expect((await other(`/api/app/organizations/${orgId}/notifications`)).status).toBe(403);
  expect(
    (await other(`/api/app/organizations/${orgId}/notifications/${id}/done`, { json: { done: true } })).status,
  ).toBe(403);
});

test("notification prefs: every category with its default, one switched per call, mine only", async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["ok"] }) });
  const { owner, api, orgId } = await signedIn();
  type Prefs = { categories: { id: string; on: boolean }[]; phones: number };
  const first = (await (await api("/notification-prefs")).json()) as Prefs;
  expect(first.phones).toBe(0);
  expect(first.categories.map((c) => [c.id, c.on])).toEqual([
    ["waiting", true],
    ["replies", true],
    ["mentions", true],
    ["threads", false],
    ["tasks", false],
    ["routines", true],
    ["computers", true],
    ["reactions", false],
  ]);
  const res = await api("/notification-prefs", { method: "PUT", json: { category: "threads", on: true } });
  expect(res.status).toBe(200);
  expect(((await res.json()) as Prefs).categories.find((c) => c.id === "threads")?.on).toBe(true);
  const again = (await (await api("/notification-prefs")).json()) as Prefs;
  expect(again.categories.find((c) => c.id === "threads")?.on).toBe(true);
  const bad = await api("/notification-prefs", { method: "PUT", json: { category: "everything", on: true } });
  expect(bad.status).toBe(400);
  // Not a member: refused, as for the inbox.
  await owner(`/api/app/organizations/${orgId}/invitations`, { json: { email: "other@example.com", role: "member" } });
  const other = browser(t);
  await signUp(other, "other@example.com");
  expect((await other(`/api/app/organizations/${orgId}/notification-prefs`)).status).toBe(403);
});

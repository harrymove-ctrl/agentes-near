import { afterEach, expect, test } from "bun:test";
import { type RealtimeEvent, userTopic } from "@agenteschat/adapters";
import { and, eq, schema, sql } from "@agenteschat/db";
import {
  addAgentReaction,
  addChannelMember,
  addReaction,
  commentIssue,
  createIssue,
  drainOutbox,
  getThread,
  insertMessage,
  listChannels,
  listDms,
  listMembers,
  listMessages,
  listNotifications,
  type MachineTaskRow,
  markAllNotificationsRead,
  markChannelRead,
  markNotificationDone,
  markNotificationRead,
  NotFoundError,
  notificationCounts,
  notificationCountsByOrg,
  notificationSnippet,
  notify,
  notifyMessage,
  openDm,
  postPersonMessage,
  resolveNotifications,
  setNoticePref,
  snoozeNotification,
  taskEndNotice,
  updateIssue,
  ValidationError,
  wakeSnoozedNotifications,
} from "../src";
import { deliverNotice } from "../src/delivery";
import { addMember, type Fixture, makeAdmin, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const deps = () => ({ db: f.db, pubsub: f.pubsub });

/** Two more people in #general, with handles (`@bia`, `@caio`). */
async function people() {
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const caio = await addMember(f.db, f.org.id, "member", "caio");
  await listMembers(f.db, f.org.id); // assigns their handles
  for (const u of [bia, caio]) await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: u.id });
  return { bia, caio };
}

const post = async (userId: string, body: string, threadId?: string, channelId = f.general.id) => {
  const m = await postPersonMessage(deps(), userId, f.org.id, channelId, { body, threadId });
  await drainOutbox(f.db, f.handlers);
  return m;
};

const inbox = (userId: string, filter?: "all" | "mentions" | "waiting" | "unread" | "reactions") =>
  listNotifications(deps(), userId, f.org.id, { filter });

const hear = (userId: string) => {
  const events: RealtimeEvent[] = [];
  f.pubsub.subscribe(userTopic(f.org.id, userId), (e) => events.push(e));
  return events;
};

test("thread replies merge into one unread row per thread; reading it starts a new one", async () => {
  f = await setup();
  const { bia, caio } = await people();
  const root = await post(f.owner.id, "Release 2.4.1 checklist");
  await post(bia.id, "Build is green", root.id);
  await post(caio.id, "**Smoke** tests pass", root.id);

  const { items } = await inbox(f.owner.id);
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    kind: "thread_reply",
    waiting: false,
    count: 2,
    actors: [
      { type: "user", id: caio.id },
      { type: "user", id: bia.id },
    ],
    source: { channelId: f.general.id, threadId: root.id, label: "Release 2.4.1 checklist" },
    latest: { text: "Smoke tests pass" },
    readAt: null,
  });
  // Bia wrote in the thread: she hears Caio's reply, not her own.
  expect((await inbox(bia.id)).items.map((n) => [n.kind, n.count])).toEqual([["thread_reply", 1]]);
  // Nobody is notified of their own reply.
  expect((await inbox(caio.id)).items).toEqual([]);

  await markNotificationRead(deps(), f.owner.id, f.org.id, items[0]?.id ?? "", true);
  await post(bia.id, "Tagging the release", root.id);
  const after = await inbox(f.owner.id);
  expect(after.items.map((n) => [n.kind, n.count, n.readAt === null])).toEqual([
    ["thread_reply", 1, true],
    ["thread_reply", 2, false],
  ]);
});

test("mentions, DMs, filters and counts; the actor never hears their own action", async () => {
  f = await setup();
  const { bia } = await people();
  await post(f.owner.id, "@bia can you check this? @ana too");
  const dm = await openDm(f.db, f.owner.id, f.org.id, { userId: bia.id });
  await post(f.owner.id, "Te mandei o contrato", undefined, dm.id);

  const all = await inbox(bia.id);
  expect(all.items.map((n) => n.kind).sort()).toEqual(["dm", "mention"]);
  expect(all.items.find((n) => n.kind === "dm")).toMatchObject({
    actors: [{ type: "user", id: f.owner.id }],
    source: { dmId: dm.id, channelId: dm.id },
    latest: { text: "Te mandei o contrato" },
  });
  expect(all.items.find((n) => n.kind === "mention")?.source.label).toBe("general");
  expect(all.counts).toEqual({ all: 2, mentions: 2, waiting: 0, unread: 2, reactions: 0 });
  expect((await inbox(bia.id, "reactions")).items).toEqual([]);
  // "@ana" is the author herself.
  expect((await inbox(f.owner.id)).items).toEqual([]);
  expect(await notificationCounts(deps(), bia.id, f.org.id)).toEqual({ unread: 2, waiting: 0 });
  // Every workspace she reads in one call: the apps' list of workspaces across servers (ADR 0154).
  expect(await notificationCountsByOrg(deps(), bia.id)).toEqual([{ orgId: f.org.id, unread: 2, waiting: 0 }]);
});

test("an agent's answer reaches the person who asked, merged per conversation; reading it there resolves it", async () => {
  f = await setup();
  const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
  await post(f.owner.id, "Faz o relatório?", undefined, dm.id);

  const first = await inbox(f.owner.id);
  expect(first.items.map((n) => [n.kind, n.count])).toEqual([["agent_reply", 1]]);
  expect(first.items[0]).toMatchObject({
    actors: [{ type: "agent", id: f.agent.id }],
    source: { dmId: dm.id, channelId: dm.id },
  });
  expect(first.counts.mentions).toBe(1);

  // A second answer while the first is unread merges into it (and pushes nothing new: only count 1 does).
  await post(f.owner.id, "E o gráfico?", undefined, dm.id);
  expect((await inbox(f.owner.id)).items.map((n) => [n.kind, n.count])).toEqual([["agent_reply", 2]]);

  // Read in the conversation: it leaves the inbox.
  await markChannelRead(f.db, f.owner.id, f.org.id, dm.id, new Date(), f.pubsub);
  expect((await inbox(f.owner.id)).items).toEqual([]);
});

test("the realtime event says whether it reaches the person's devices, by their choices", async () => {
  f = await setup();
  const { bia } = await people();
  const events = hear(bia.id);
  await post(f.owner.id, "@bia olha isso");
  await setNoticePref(f.db, f.org.id, bia.id, "mentions", false);
  await post(f.owner.id, "@bia e isso");
  const alerts = events.filter((e) => e.type === "notification.upserted").map((e) => e.alert);
  expect(alerts).toEqual([true, false]);
});

test("reactions to my message merge (also within 30 min after reading); my own reactions don't count", async () => {
  f = await setup();
  const { bia, caio } = await people();
  const mine = await post(f.owner.id, "Shipped the new onboarding");
  await addReaction(f.db, f.owner.id, f.org.id, mine.id, "🎉", f.pubsub);
  expect((await inbox(f.owner.id)).items).toEqual([]);
  await addReaction(f.db, bia.id, f.org.id, mine.id, "+1", f.pubsub);
  await addReaction(f.db, caio.id, f.org.id, mine.id, "🎉", f.pubsub);
  let [n] = (await inbox(f.owner.id, "reactions")).items;
  expect(n).toMatchObject({
    kind: "reaction",
    count: 2,
    actors: [
      { type: "user", id: caio.id },
      { type: "user", id: bia.id },
    ],
    latest: { emojis: ["👍", "🎉"], quote: "Shipped the new onboarding" },
  });
  await markNotificationRead(deps(), f.owner.id, f.org.id, n?.id ?? "", true);
  await addReaction(f.db, caio.id, f.org.id, mine.id, "🚀", f.pubsub);
  const list = (await inbox(f.owner.id, "reactions")).items;
  expect(list).toHaveLength(1);
  n = list[0];
  expect(n).toMatchObject({ count: 3, readAt: null });
  expect(n?.latest.emojis).toContain("🚀");

  // An agent's reaction (the `react` tool) reaches the author too, with the agent as actor.
  await addAgentReaction(f.db, { orgId: f.org.id, agentId: f.agent.id, messageId: mine.id, reaction: "🙌" }, f.pubsub);
  const [after] = (await inbox(f.owner.id, "reactions")).items;
  expect(after).toMatchObject({ count: 4 });
  expect(after?.actors[0]).toEqual({ type: "agent", id: f.agent.id });
  expect(after?.latest.emojis).toContain("🙌");
});

test("one-off notifications are idempotent; done, undo, read-all and the cursor", async () => {
  f = await setup();
  const { bia } = await people();
  const base = Date.now() - 60_000;
  for (let i = 0; i < 5; i++) {
    // One second apart: the order is by time.
    await notify(
      { ...deps(), now: () => new Date(base + i * 1000) },
      {
        orgId: f.org.id,
        userIds: [bia.id],
        kind: "mention",
        groupKey: `mention:test-${i}`,
        actor: { type: "agent", id: f.agent.id },
        source: { channelId: f.general.id },
        latest: { text: `n${i}` },
      },
    );
  }
  // The same key again (a retried job) changes nothing.
  await notify(deps(), {
    orgId: f.org.id,
    userIds: [bia.id],
    kind: "mention",
    groupKey: "mention:test-0",
    source: {},
  });
  // An approval waits: it comes first (for who may decide it).
  await makeAdmin(f.db, f.org.id, bia.id);
  const [approval] = await f.db
    .insert(schema.approvals)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: crypto.randomUUID(),
      toolUseId: "tool-1",
      tool: "github_merge",
      scope: "github:pr.merge",
      params: { pr: 42 },
      actionHash: "hash",
      title: "Merge PR #42",
      expiresAt: new Date(Date.now() + 3_600_000),
    })
    .returning();
  await notify(deps(), {
    orgId: f.org.id,
    userIds: [bia.id, f.agent.id],
    kind: "approval",
    groupKey: "approval:test",
    waiting: true,
    actor: { type: "agent", id: f.agent.id },
    source: { approvalId: approval?.id },
  });
  expect(await f.db.select().from(schema.notifications)).toHaveLength(6); // never for an agent id

  const page1 = await listNotifications(deps(), bia.id, f.org.id, { limit: 4 });
  expect(page1.items.map((n) => n.latest.text ?? n.kind)).toEqual(["approval", "n4", "n3", "n2"]);
  expect(page1.counts).toMatchObject({ all: 6, waiting: 1, unread: 6 });
  const page2 = await listNotifications(deps(), bia.id, f.org.id, { limit: 4, cursor: page1.nextCursor });
  expect(page2.items.map((n) => n.latest.text)).toEqual(["n1", "n0"]);
  expect(page2.nextCursor).toBeNull();
  await expect(listNotifications(deps(), bia.id, f.org.id, { cursor: "nope" })).rejects.toBeInstanceOf(ValidationError);

  const target = page2.items[0]?.id ?? "";
  expect((await markNotificationDone(deps(), bia.id, f.org.id, target, true)).doneAt).not.toBeNull();
  expect((await inbox(bia.id)).counts.all).toBe(5);
  await markNotificationDone(deps(), bia.id, f.org.id, target, false);
  expect((await inbox(bia.id)).counts.all).toBe(6);

  const { ids } = await markAllNotificationsRead(deps(), bia.id, f.org.id, "mentions");
  expect(ids).toHaveLength(5);
  expect((await inbox(bia.id)).counts).toMatchObject({ unread: 1, waiting: 1 });

  // Someone else's notification is not found.
  await expect(markNotificationRead(deps(), f.owner.id, f.org.id, target, true)).rejects.toBeInstanceOf(NotFoundError);
});

test("Concluídas lists what the person marked done for 30 days, the latest first; Mover de volta brings it back", async () => {
  f = await setup();
  const { bia } = await people();
  const base = Date.parse("2026-03-01T12:00:00Z");
  const at = (ms: number) => ({ ...deps(), now: () => new Date(base + ms) });
  for (const [i, text] of ["old", "a", "b", "auto"].entries())
    await notify(at(i * 1000), {
      orgId: f.org.id,
      userIds: [bia.id],
      kind: "mention",
      groupKey: `mention:${text}`,
      source: {},
      latest: { text },
    });
  const ids = Object.fromEntries((await inbox(bia.id)).items.map((n) => [n.latest.text, n.id]));
  const day = 24 * 3600_000;
  await markNotificationDone(at(0), bia.id, f.org.id, ids.old ?? "", true);
  await markNotificationDone(at(29 * day), bia.id, f.org.id, ids.a ?? "", true);
  await markNotificationDone(at(30 * day), bia.id, f.org.id, ids.b ?? "", true);
  // Resolved on its own (question answered, approval decided): not something the person marked done.
  await resolveNotifications(at(30 * day), f.org.id, { groupKey: "mention:auto" });

  const done = (cursor?: string | null) =>
    listNotifications(at(31 * day), bia.id, f.org.id, { filter: "done", limit: 1, cursor });
  const first = await done();
  expect(first.items.map((n) => n.latest.text)).toEqual(["b"]);
  const second = await done(first.nextCursor);
  expect(second.items.map((n) => n.latest.text)).toEqual(["a"]);
  // `old` was marked done 31 days before: out of the window.
  expect(second.nextCursor).toBeNull();
  // "Marcar tudo como lido" never reaches into what is done.
  expect((await markAllNotificationsRead(at(31 * day), bia.id, f.org.id, "done")).ids).toEqual([]);

  await markNotificationDone(at(31 * day), bia.id, f.org.id, ids.b ?? "", false);
  expect((await done()).items.map((n) => n.latest.text)).toEqual(["a"]);
  expect((await inbox(bia.id)).items.map((n) => n.latest.text)).toEqual(["b"]);
});

test("the backfill puts in Concluídas the kinds only a person closes, done before done_by_user", async () => {
  f = await setup();
  const { bia } = await people();
  const ago = (days: number) => new Date(Date.now() - days * 24 * 3600_000);
  const rows: [string, string, Date | null][] = [
    ["mention", "mention", ago(2)],
    ["reaction", "reaction", ago(3)],
    ["thread_reply", "thread", ago(1)],
    ["dm", "dm", ago(4)],
    ["mention", "old", ago(31)],
    ["mention", "open", null],
    // Auto-resolved kinds stay out: the person never marked them done.
    ["agent_question", "answered", ago(1)],
    ["agent_reply", "seen", ago(1)],
  ];
  for (const [kind, text, doneAt] of rows)
    await f.db.insert(schema.notifications).values({
      orgId: f.org.id,
      userId: bia.id,
      kind,
      groupKey: `${kind}:${text}`,
      latest: { text },
      doneAt,
      readAt: doneAt,
    });

  const file = await Bun.file(
    new URL("../../db/migrations/0187_notifications_done_backfill.sql", import.meta.url),
  ).text();
  await f.db.execute(sql.raw(file));
  await f.db.execute(sql.raw(file));

  const done = await listNotifications(deps(), bia.id, f.org.id, { filter: "done" });
  expect(done.items.map((n) => n.latest.text)).toEqual(["thread", "mention", "reaction", "dm"]);
  expect((await inbox(bia.id)).items.map((n) => n.latest.text)).toEqual(["open"]);
});

test("Mover de volta while a newer unread row of the same thread is open brings it back read", async () => {
  f = await setup();
  const { bia, caio } = await people();
  const root = await post(f.owner.id, "Deploy notes");
  await post(bia.id, "First reply", root.id);
  const [first] = (await inbox(f.owner.id)).items;
  await markNotificationDone(deps(), f.owner.id, f.org.id, first?.id ?? "", true);
  await post(caio.id, "Second reply", root.id);
  expect((await inbox(f.owner.id)).items).toHaveLength(1);

  const restored = await markNotificationDone(deps(), f.owner.id, f.org.id, first?.id ?? "", false);
  expect(restored.doneAt).toBeNull();
  expect(restored.readAt).not.toBeNull();
  expect((await inbox(f.owner.id)).items).toHaveLength(2);
  expect((await listNotifications(deps(), f.owner.id, f.org.id, { filter: "done" })).items).toEqual([]);
});

test("a merged request-to-join notice keeps the first two names, each once, and counts every ask", async () => {
  f = await setup();
  for (const name of ["Ana Souza", "Ana Souza", "Bruno Lima", "Carla Dias"])
    await notify(deps(), {
      orgId: f.org.id,
      userIds: [f.owner.id],
      kind: "join_request",
      groupKey: `join_requests:${f.org.id}`,
      waiting: true,
      source: { label: "Acme" },
      latest: { title: name, names: [name] },
    });
  const [row] = (await inbox(f.owner.id)).items;
  expect([row?.count, row?.latest]).toEqual([4, { title: "Carla Dias", names: ["Ana Souza", "Bruno Lima"] }]);
});

test("snoozed notifications leave the inbox and come back on top when their time comes", async () => {
  f = await setup();
  const { bia } = await people();
  const [first] = await notify(deps(), {
    orgId: f.org.id,
    userIds: [bia.id],
    kind: "dm",
    groupKey: "dm:a",
    source: {},
  });
  await notify(deps(), { orgId: f.org.id, userIds: [bia.id], kind: "dm", groupKey: "dm:b", source: {} });
  await expect(snoozeNotification(deps(), bia.id, f.org.id, first?.id ?? "", new Date(0))).rejects.toBeInstanceOf(
    ValidationError,
  );
  const events = hear(bia.id);
  const until = new Date(Date.now() + 3600_000);
  await snoozeNotification(deps(), bia.id, f.org.id, first?.id ?? "", until);
  expect(events.map((e) => e.type)).toEqual(["notification.removed", "notification.counts"]);
  expect((await inbox(bia.id)).items).toHaveLength(1);
  expect((await inbox(bia.id)).counts.all).toBe(1);

  // Undo: back now, with `upserted` and the counts.
  const undone = await snoozeNotification(deps(), bia.id, f.org.id, first?.id ?? "", null);
  expect(undone.snoozedUntil).toBeNull();
  expect(events.map((e) => e.type).slice(2)).toEqual(["notification.upserted", "notification.counts"]);
  expect((await inbox(bia.id)).counts.all).toBe(2);
  await snoozeNotification(deps(), bia.id, f.org.id, first?.id ?? "", until);

  expect(await wakeSnoozedNotifications(deps())).toBe(0); // not yet
  expect(await wakeSnoozedNotifications({ ...deps(), now: () => new Date(until.getTime() + 1000) })).toBe(1);
  const back = await inbox(bia.id);
  expect(back.items.map((n) => n.id)[0]).toBe(first?.id);
  expect(back.items[0]?.snoozedUntil).toBeNull();
  expect(events.map((e) => e.type)).toContain("notification.upserted");
});

test("realtime goes to the recipient only; auto-resolve removes for everyone", async () => {
  f = await setup();
  const { bia, caio } = await people();
  const biaEvents = hear(bia.id);
  const caioEvents = hear(caio.id);
  const ownerEvents = hear(f.owner.id);
  await notify(deps(), {
    orgId: f.org.id,
    userIds: [bia.id, f.owner.id],
    kind: "routine_failed",
    groupKey: "routine_failed:routine-1:2",
    actor: { type: "user", id: f.owner.id },
    source: { routineId: "routine-1" },
  });
  expect(biaEvents.map((e) => e.type)).toEqual(["notification.upserted", "notification.counts"]);
  expect(biaEvents[1]).toMatchObject({ unread: 1 });
  expect(caioEvents).toEqual([]);
  expect(ownerEvents).toEqual([]); // the actor

  expect(await resolveNotifications(deps(), f.org.id, { groupKeyPrefix: "routine_failed:routine-1:" })).toBe(1);
  expect(biaEvents.map((e) => e.type).slice(2)).toEqual(["notification.removed", "notification.counts"]);
  expect((await inbox(bia.id)).items).toEqual([]);
  // Another group with the same start is untouched.
  expect(await resolveNotifications(deps(), f.org.id, { groupKeyPrefix: "routine_failed:routine-12:" })).toBe(0);
});

test("issues: assigned (resolved when unassigned), status by others, comments merge, mentions in comments", async () => {
  f = await setup();
  const { bia, caio } = await people();
  const owner = { type: "person" as const, userId: f.owner.id };
  const issue = await createIssue(deps(), owner, f.org.id, {
    title: "Export report as CSV",
    assignee: { type: "person", id: bia.id },
  });
  const [assigned] = (await inbox(bia.id)).items;
  expect(assigned).toMatchObject({
    kind: "issue_assigned",
    source: { issueId: issue.id, issueNumber: issue.number, label: "Export report as CSV" },
  });

  // An agent moves it: the people who follow it hear (author and assignee).
  const agentActor = { type: "agent" as const, agentId: f.agent.id, channelId: f.general.id };
  await updateIssue(deps(), agentActor, f.org.id, issue.id, { status: "in_review" });
  const status = (await inbox(f.owner.id)).items.find((n) => n.kind === "issue_status");
  expect(status).toMatchObject({
    actors: [{ type: "agent", id: f.agent.id }],
    latest: { statusFrom: "todo", statusTo: "in_review" },
  });

  // Comments: followers merge per issue; a mention is its own `mention`.
  // A comment is a reply in the task's conversation (ADR 0145): its notifications come from the message's job.
  await commentIssue(deps(), { type: "person", userId: caio.id }, f.org.id, issue.id, "Looks good");
  await drainOutbox(f.db, f.handlers);
  await commentIssue(deps(), agentActor, f.org.id, issue.id, "PR opened");
  await drainOutbox(f.db, f.handlers);
  await commentIssue(deps(), owner, f.org.id, issue.id, "@caio can you review?");
  await drainOutbox(f.db, f.handlers);
  const ownerComments = (await inbox(f.owner.id)).items.find((n) => n.kind === "issue_comment");
  expect(ownerComments).toMatchObject({ count: 2, latest: { text: "PR opened" } });
  const caioInbox = await inbox(caio.id);
  expect(caioInbox.items.find((n) => n.kind === "mention")).toMatchObject({
    source: { issueId: issue.id },
    latest: { text: "@caio can you review?" },
  });
  expect(caioInbox.items.find((n) => n.kind === "issue_comment")?.count).toBe(1); // the agent's, not the mention

  // Unassigned: "assigned to you" leaves Bia's inbox.
  await updateIssue(deps(), owner, f.org.id, issue.id, { assignee: null });
  const [row] = await f.db
    .select()
    .from(schema.notifications)
    .where(and(eq(schema.notifications.userId, bia.id), eq(schema.notifications.kind, "issue_assigned")));
  expect(row?.doneAt).not.toBeNull();
});

test("a task's end in a thread names its computer only where the workspace has more than one", async () => {
  f = await setup();
  const { bia } = await people();
  const root = await post(bia.id, "Can someone run the tests?");
  const computer = "agentes.chat's computer";
  await f.db.insert(schema.machines).values({ orgId: f.org.id, name: computer, kind: "managed" });
  const task = {
    id: "00000000-0000-4000-8000-000000000001",
    title: "Run the tests",
    status: "done",
    exitCode: 0,
    seconds: 134,
    endedAt: new Date(),
    executor: "claude",
    files: [],
  } as unknown as MachineTaskRow;
  const end = async () => {
    const m = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      threadId: root.id,
      author: { type: "agent", agentId: f.agent.id, runId: null, hop: 0, stretchId: null },
      ...taskEndNotice(task, computer),
    });
    await notifyMessage(deps(), f.org.id, m.id);
    return m;
  };
  const latest = async () => (await inbox(bia.id)).items.find((n) => n.kind === "thread_reply")?.latest.text;
  // The Cloud's one computer: Bia hears how it ended, not where. The agent still reads where.
  const first = await end();
  expect(first.body).toBe(`“Run the tests” finished on ${computer}.`);
  expect(await latest()).toBe("“Run the tests” finished.");
  // A second computer: the line says which.
  await f.db.insert(schema.machines).values({ orgId: f.org.id, name: "MacBook" });
  await end();
  expect(await latest()).toBe(`“Run the tests” finished on ${computer}.`);
});

test("in a DM, a reminder and a routine's report reach the person, in their own words", async () => {
  f = await setup();
  const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
  const say = async (body: string, meta: Record<string, unknown>) => {
    await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: dm.id,
      threadId: null,
      author: { type: "agent", agentId: f.agent.id, runId: null, hop: 0, stretchId: null },
      body,
      meta,
    });
    await drainOutbox(f.db, f.handlers);
  };
  const routine = { id: "00000000-0000-4000-8000-000000000002", name: "Bom dia", runId: "r" };
  await say("Reminder: call the bank", { reminderText: "call the bank", reminder: true, routine });
  await say("Good morning!", { routine });
  const dms = (await inbox(f.owner.id)).items.filter((n) => n.kind === "dm");
  expect(dms.map((n) => n.latest.text).sort()).toEqual(["Good morning!", "call the bank"]);
  // The agent's replies in a DM are still the conversation itself.
  await say("Just talking", {});
  expect((await inbox(f.owner.id)).items.filter((n) => n.kind === "dm").length).toBe(2);
});

test("a body the server wrote keeps its code: the apps say it in the reader's language, never the push", async () => {
  f = await setup();
  const { bia } = await people();
  const m = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    threadId: null,
    author: { type: "agent", agentId: f.agent.id, runId: null, hop: 0, stretchId: null },
    body: `@bia I can't answer now: the plan I think with reached its limit.`,
    meta: { bodyCode: "no_ai", noAi: { reason: "plan_limit" } },
  });
  await notifyMessage(deps(), f.org.id, m.id);
  const row = (await inbox(bia.id)).items.find((n) => n.kind === "mention");
  expect(row?.latest.meta).toMatchObject({ bodyCode: "no_ai", noAi: { reason: "plan_limit" } });
});

test("snippets are plain text and at most 280 characters", () => {
  expect(notificationSnippet("**Bold** and [a link](https://x.y) in `code`\n\n```ts\nconst a = 1\n```")).toBe(
    "Bold and a link in code const a = 1",
  );
  const long = notificationSnippet("x".repeat(500));
  expect(long).toHaveLength(280);
  expect(long.endsWith("…")).toBe(true);
});

test("a notice only its agent reads notifies nobody, counts for nobody and is no preview", async () => {
  f = await setup();
  const { bia } = await people();
  const root = await post(f.owner.id, "Cria um agente que lê meus emails");
  // What a person decided on its proposal, another agent's note, the late result of a wait: in the thread people follow.
  for (const kind of ["proposal_result", "agent_note", "wait_result"] as const) {
    await f.db.transaction((tx) =>
      deliverNotice(tx, {
        orgId: f.org.id,
        agentId: f.agent.id,
        channelId: f.general.id,
        threadId: root.id,
        hop: 1,
        stretchId: null,
        notice: { kind, from: "Your proposal of the agent «Caio»", text: "ana created it: @caio (Caio)." },
        wake: false,
      }),
    );
  }
  // And one at the channel's top level.
  await f.db.transaction((tx) =>
    deliverNotice(tx, {
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadId: null,
      hop: 1,
      stretchId: null,
      notice: { kind: "proposal_result", text: "bia said no." },
      wake: false,
    }),
  );
  await drainOutbox(f.db, f.handlers);
  expect((await inbox(f.owner.id)).items).toEqual([]);
  const general = (await listChannels(f.db, bia.id, f.org.id)).find((c) => c.id === f.general.id);
  expect(general?.lastMessage?.preview).toBe("Cria um agente que lê meus emails");
  expect(general?.unreadCount).toBe(1);
  // Its author follows the thread: nothing in it is unread for her, and it has no reply.
  expect((await listChannels(f.db, f.owner.id, f.org.id)).find((c) => c.id === f.general.id)?.unreadCount).toBe(0);
  const thread = await getThread(f.db, f.owner.id, f.org.id, root.id);
  expect(thread.replyCount).toBe(0);
  // Nor the thread's last line or a participant in it, here or in the channel's replies.
  expect(thread.lastMessage).toBeNull();
  expect(thread.participants.map((a) => a.id)).toEqual([f.owner.id]);
  const [listed] = await listMessages(f.db, f.owner.id, f.org.id, f.general.id, { includeReplies: true });
  expect(listed?.replies).toEqual({ count: 0, lastAt: null, latest: [] });
  // A DM with the agent: the same.
  const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
  await f.db.transaction((tx) =>
    deliverNotice(tx, {
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: dm.id,
      threadId: null,
      hop: 1,
      stretchId: null,
      notice: { kind: "proposal_result", text: "ana created it." },
      wake: false,
    }),
  );
  const [mine] = (await listDms(f.db, f.owner.id, f.org.id)).filter((d) => d.channelId === dm.id);
  expect(mine).toMatchObject({ lastMessage: null, unread: 0 });
});

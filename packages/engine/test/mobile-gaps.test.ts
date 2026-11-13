import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema, sql } from "@agenteschat/db";
import {
  addChannelMember,
  createChannel,
  createOrganization,
  createReminderFromApp,
  drainOutbox,
  getThread,
  listChannels,
  listDms,
  listMessages,
  listMyReminders,
  listPins,
  listThreads,
  listWorkingRuns,
  markChannelRead,
  openDm,
  pinMessage,
  postPersonMessage,
  setThreadFollow,
  unpinMessage,
} from "../src";
import { addMember, addUser, answerSteering, type Fixture, setup } from "./fixtures";

/**
 * What the phone app needed from the API: unread and last message per
 * channel, following threads, pins, "Trabalhando agora" for members and
 * "Lembrar".
 */

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const deps = () => ({ db: f.db, pubsub: f.pubsub });
const post = (userId: string, channelId: string, body: string, threadId?: string) =>
  postPersonMessage(deps(), userId, f.org.id, channelId, { body, ...(threadId ? { threadId } : {}) });
const general = async (userId: string) => {
  const list = await listChannels(f.db, userId, f.org.id);
  const found = list.find((c) => c.id === f.general.id);
  if (!found) throw new Error("general not listed");
  return found;
};

/** Bia, a member, in #general. */
async function withBia() {
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
  await nextMillisecond();
  return bia;
}

/**
 * PGlite's clock counts whole milliseconds, so a message posted in the same millisecond as a join or a
 * read ties with it and isn't unread; waiting for the next one keeps what a test posts next after it.
 */
const nextMillisecond = () => Bun.sleep(2);

const threadReplies = async (userId: string) =>
  f.db
    .select()
    .from(schema.notifications)
    .where(and(eq(schema.notifications.userId, userId), eq(schema.notifications.kind, "thread_reply")));

describe("channel list: unread and last message", () => {
  test("counts others' messages since the last read; the last message is the latest top-level one", async () => {
    f = await setup();
    const bia = await withBia();
    expect(await general(bia.id)).toMatchObject({ isMember: true, unreadCount: 0, lastMessage: null });
    await post(f.owner.id, f.general.id, "first");
    await post(f.owner.id, f.general.id, `**Deploy** ${"x".repeat(300)}`);
    await post(bia.id, f.general.id, "mine doesn't count for me");
    const before = await general(bia.id);
    expect(before.unreadCount).toBe(2);
    expect(before.lastMessage).toMatchObject({ authorType: "person", authorId: bia.id, authorName: "bia" });
    await markChannelRead(f.db, bia.id, f.org.id, f.general.id);
    await nextMillisecond();
    expect((await general(bia.id)).unreadCount).toBe(0);
    const last = await post(f.owner.id, f.general.id, `**Deploy** ${"y".repeat(300)}`);
    const after = await general(bia.id);
    expect(after.unreadCount).toBe(1);
    expect(after.lastMessage?.id).toBe(last.id);
    expect(after.lastMessage?.authorName).toBe("ana");
    expect(after.lastMessage?.preview.startsWith("Deploy y")).toBe(true);
    expect(after.lastMessage?.preview.length).toBeLessThanOrEqual(140);
  });

  test("a routine's call (hidden in the chat) is never the preview, in a channel or a DM", async () => {
    f = await setup();
    const bia = await withBia();
    const answer = await post(f.owner.id, f.general.id, "the agent's answer");
    const routine = { routine: { id: "r1", name: "Daily", runId: "rr1" } };
    await postPersonMessage(deps(), f.owner.id, f.org.id, f.general.id, { body: "@atlas check", meta: routine });
    expect((await general(bia.id)).lastMessage?.id).toBe(answer.id);
    const dm = await openDm(f.db, f.owner.id, f.org.id, { userId: bia.id });
    const said = await post(f.owner.id, dm.id, "hi");
    await postPersonMessage(deps(), f.owner.id, f.org.id, dm.id, { body: "check", meta: routine });
    const dms = await listDms(f.db, f.owner.id, f.org.id);
    expect(dms.find((d) => d.channelId === dm.id)?.lastMessage?.id).toBe(said.id);
  });

  test("a thread reply counts only in a thread I follow (wrote there, or followed; muting wins)", async () => {
    f = await setup();
    const bia = await withBia();
    const root = await post(f.owner.id, f.general.id, "Release checklist");
    const mine = await post(bia.id, f.general.id, "My question");
    await markChannelRead(f.db, bia.id, f.org.id, f.general.id);
    await nextMillisecond();

    await post(f.owner.id, f.general.id, "reply in ana's thread", root.id);
    expect((await general(bia.id)).unreadCount).toBe(0);
    // Bia started `mine`: replies there count.
    await post(f.owner.id, f.general.id, "answer", mine.id);
    expect((await general(bia.id)).unreadCount).toBe(1);

    await setThreadFollow(deps(), bia.id, f.org.id, root.id, true);
    expect((await general(bia.id)).unreadCount).toBe(2);
    await setThreadFollow(deps(), bia.id, f.org.id, mine.id, false);
    expect((await general(bia.id)).unreadCount).toBe(1);
    // The last message stays the latest top-level one.
    expect((await general(bia.id)).lastMessage?.id).toBe(mine.id);
  });

  test("public channels I'm not in show nothing of theirs; private ones I'm not in aren't listed", async () => {
    f = await setup();
    const bia = await withBia();
    const open = await createChannel(f.db, f.owner.id, f.org.id, { name: "design" });
    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "secret", visibility: "private" });
    await post(f.owner.id, open.id, "public talk");
    await post(f.owner.id, secret.id, "private talk");
    const list = await listChannels(f.db, bia.id, f.org.id);
    expect(list.map((c) => c.name)).toEqual(["design", "general"]);
    expect(list.find((c) => c.id === open.id)).toMatchObject({ isMember: false, unreadCount: 0, lastMessage: null });
    // The owner sees the private one, with its last message.
    const owners = await listChannels(f.db, f.owner.id, f.org.id);
    expect(owners.find((c) => c.id === secret.id)?.lastMessage?.preview).toBe("private talk");
  });

  test("never read: counted from when I joined", async () => {
    f = await setup();
    await post(f.owner.id, f.general.id, "before bia");
    const bia = await withBia();
    // PGlite's clock counts whole milliseconds: posted in the join's millisecond, the message would tie with it.
    await Bun.sleep(2);
    await post(f.owner.id, f.general.id, "after bia");
    expect((await general(bia.id)).unreadCount).toBe(1);
  });

  test("someone outside the organization gets nothing", async () => {
    f = await setup();
    const stranger = await addUser(f.db, "zed");
    await expect(listChannels(f.db, stranger.id, f.org.id)).rejects.toThrow();
  });
});

describe("following threads", () => {
  test("views carry following: started or wrote there by default, explicit choices win", async () => {
    f = await setup();
    const bia = await withBia();
    const root = await post(f.owner.id, f.general.id, "Release checklist");
    await post(f.owner.id, f.general.id, "step 1", root.id);
    expect((await getThread(f.db, f.owner.id, f.org.id, root.id)).following).toBe(true);
    expect((await getThread(f.db, bia.id, f.org.id, root.id)).following).toBe(false);
    expect(await setThreadFollow(deps(), bia.id, f.org.id, root.id, true)).toEqual({
      threadId: root.id,
      channelId: f.general.id,
      following: true,
    });
    expect((await getThread(f.db, bia.id, f.org.id, root.id)).following).toBe(true);
    const { threads } = await listThreads(f.db, bia.id, { orgId: f.org.id });
    expect(threads.find((t) => t.id === root.id)?.following).toBe(true);
    await setThreadFollow(deps(), f.owner.id, f.org.id, root.id, false);
    expect((await getThread(f.db, f.owner.id, f.org.id, root.id)).following).toBe(false);
    // A message without replies yet: its author follows it.
    const lone = await post(bia.id, f.general.id, "anyone?");
    expect((await getThread(f.db, bia.id, f.org.id, lone.id)).following).toBe(true);
  });

  test("following adds reply notifications; unfollowing mutes them even where you wrote", async () => {
    f = await setup();
    const bia = await withBia();
    const caio = await addMember(f.db, f.org.id, "member", "caio");
    await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: caio.id });
    const root = await post(f.owner.id, f.general.id, "Release checklist");
    await post(caio.id, f.general.id, "I'll take QA", root.id);
    await setThreadFollow(deps(), bia.id, f.org.id, root.id, true);
    await setThreadFollow(deps(), caio.id, f.org.id, root.id, false);
    await drainOutbox(f.db, f.handlers);
    await post(f.owner.id, f.general.id, "QA done?", root.id);
    await drainOutbox(f.db, f.handlers);
    expect(await threadReplies(bia.id)).toHaveLength(1);
    expect(await threadReplies(caio.id)).toHaveLength(0);
  });

  test("only who reads the channel: private channel, someone else's DM, other organization", async () => {
    f = await setup();
    const bia = await withBia();
    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "secret", visibility: "private" });
    const hidden = await post(f.owner.id, secret.id, "private plan");
    await expect(setThreadFollow(deps(), bia.id, f.org.id, hidden.id, true)).rejects.toThrow();
    const caio = await addMember(f.db, f.org.id, "member", "caio");
    const dm = await openDm(f.db, f.owner.id, f.org.id, { userId: caio.id });
    const said = await post(f.owner.id, dm.id, "just between us");
    await expect(setThreadFollow(deps(), bia.id, f.org.id, said.id, true)).rejects.toThrow();
    const other = await addUser(f.db, "zed");
    const { organization } = await createOrganization(f.db, other.id, { name: "Other" });
    await expect(setThreadFollow(deps(), other.id, organization.id, said.id, true)).rejects.toThrow();
    await expect(setThreadFollow(deps(), other.id, f.org.id, said.id, true)).rejects.toThrow();
    expect(await f.db.select().from(schema.threadFollows)).toEqual([]);
  });
});

describe("pins", () => {
  test("pin, list newest first, the message's mark, live events, unpin", async () => {
    f = await setup();
    const bia = await withBia();
    const events = f.listen(f.general.id);
    const a = await post(f.owner.id, f.general.id, "Runbook: deploy");
    const b = await post(f.owner.id, f.general.id, "Runbook: rollback");
    const pinA = await pinMessage(deps(), bia.id, f.org.id, f.general.id, a.id);
    expect(pinA).toMatchObject({ messageId: a.id, channelId: f.general.id, pinnedByUserId: bia.id, threadId: null });
    expect(pinA.message.body).toBe("Runbook: deploy");
    await pinMessage(deps(), f.owner.id, f.org.id, f.general.id, b.id);
    // Pinning again keeps the first pin.
    expect((await pinMessage(deps(), f.owner.id, f.org.id, f.general.id, a.id)).pinnedByUserId).toBe(bia.id);
    expect((await listPins(f.db, bia.id, f.org.id, f.general.id)).map((p) => p.messageId)).toEqual([b.id, a.id]);
    const listed = await listMessages(f.db, bia.id, f.org.id, f.general.id);
    expect(listed.find((m) => m.id === a.id)?.pinned).toBe(true);
    expect(
      events.filter((e) => e.type === "message.pinned").map((e) => (e as unknown as { messageId: string }).messageId),
    ).toEqual([a.id, b.id]);

    await unpinMessage(deps(), bia.id, f.org.id, f.general.id, a.id);
    await unpinMessage(deps(), bia.id, f.org.id, f.general.id, a.id); // not pinned: nothing
    expect((await listPins(f.db, bia.id, f.org.id, f.general.id)).map((p) => p.messageId)).toEqual([b.id]);
    expect((await listMessages(f.db, bia.id, f.org.id, f.general.id)).find((m) => m.id === a.id)?.pinned).toBe(
      undefined,
    );
    expect(events.filter((e) => e.type === "message.unpinned")).toHaveLength(1);
  });

  test("a message stored with microseconds is pinned and listed", async () => {
    f = await setup();
    const a = await post(f.owner.id, f.general.id, "Runbook: deploy");
    // Postgres stores now() with microseconds; read back, `createdAt` is cut to milliseconds.
    await f.db
      .update(schema.messages)
      .set({ createdAt: sql`${schema.messages.createdAt} + interval '456 microseconds'` })
      .where(eq(schema.messages.id, a.id));
    expect((await pinMessage(deps(), f.owner.id, f.org.id, f.general.id, a.id)).message.body).toBe("Runbook: deploy");
    expect((await listPins(f.db, f.owner.id, f.org.id, f.general.id)).map((p) => p.messageId)).toEqual([a.id]);
  });

  test("a reply in a thread can be pinned; a message of another channel can't", async () => {
    f = await setup();
    const root = await post(f.owner.id, f.general.id, "Release checklist");
    const reply = await post(f.owner.id, f.general.id, "step 1", root.id);
    expect((await pinMessage(deps(), f.owner.id, f.org.id, f.general.id, reply.id)).threadId).toBe(root.id);
    const other = await createChannel(f.db, f.owner.id, f.org.id, { name: "design" });
    await expect(pinMessage(deps(), f.owner.id, f.org.id, other.id, reply.id)).rejects.toMatchObject({
      code: "not_found",
    });
  });

  test("only who can post there: not a member, private channel, someone else's DM, other organization", async () => {
    f = await setup();
    const bia = await withBia();
    const open = await createChannel(f.db, f.owner.id, f.org.id, { name: "design" });
    const inOpen = await post(f.owner.id, open.id, "public talk");
    await expect(pinMessage(deps(), bia.id, f.org.id, open.id, inOpen.id)).rejects.toThrow();
    await expect(listPins(f.db, bia.id, f.org.id, open.id)).rejects.toThrow();

    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "secret", visibility: "private" });
    const inSecret = await post(f.owner.id, secret.id, "private plan");
    await expect(pinMessage(deps(), bia.id, f.org.id, secret.id, inSecret.id)).rejects.toThrow();

    const caio = await addMember(f.db, f.org.id, "member", "caio");
    const dm = await openDm(f.db, f.owner.id, f.org.id, { userId: caio.id });
    const said = await post(f.owner.id, dm.id, "just between us");
    await expect(pinMessage(deps(), bia.id, f.org.id, dm.id, said.id)).rejects.toThrow();
    // The two of them can.
    expect((await pinMessage(deps(), caio.id, f.org.id, dm.id, said.id)).messageId).toBe(said.id);
    await expect(listPins(f.db, bia.id, f.org.id, dm.id)).rejects.toThrow();
    await expect(unpinMessage(deps(), bia.id, f.org.id, dm.id, said.id)).rejects.toThrow();

    const other = await addUser(f.db, "zed");
    await expect(listPins(f.db, other.id, f.org.id, f.general.id)).rejects.toThrow();
    expect(await f.db.select().from(schema.messagePins)).toHaveLength(1);
  });
});

describe("working now (any member)", () => {
  test("runs in progress where I am; never someone else's DM or a private channel I'm not in", async () => {
    f = await setup();
    const bia = await withBia();
    const run = async (channelId: string, triggerMessageId: string, status: "running" | "done" = "running") => {
      const [row] = await f.db
        .insert(schema.agentRuns)
        .values({
          orgId: f.org.id,
          agentId: f.agent.id,
          channelId,
          threadRootId: triggerMessageId,
          triggerMessageId,
          trigger: "router",
          hop: 1,
          status,
          startedAt: new Date(),
        })
        .returning();
      // The same person's next message in the channel goes into a running one.
      if (row?.status === "running") answerSteering(f, row);
    };
    const ask = await post(f.owner.id, f.general.id, "Dev, can you check the deploy?");
    await run(f.general.id, ask.id);
    const old = await post(f.owner.id, f.general.id, "older");
    await run(f.general.id, old.id, "done");
    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "secret", visibility: "private" });
    await addChannelMember(f.db, f.owner.id, f.org.id, secret.id, { agentId: f.agent.id });
    const hidden = await post(f.owner.id, secret.id, "private plan");
    await run(secret.id, hidden.id);
    // Ana's DM with the agent starts a run by itself.
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    await post(f.owner.id, dm.id, "summarize my week");

    const mine = await listWorkingRuns(f.db, bia.id, f.org.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      agentId: f.agent.id,
      channelId: f.general.id,
      channelKind: "channel",
      channelName: "general",
      // Asked in the channel: it answers there.
      threadId: null,
      status: "running",
      // Never the ask's own words: with no thread title the apps say where it is.
      label: null,
    });
    expect(Object.keys(mine[0] ?? {})).not.toContain("costUsd");

    const anas = await listWorkingRuns(f.db, f.owner.id, f.org.id);
    expect(anas.map((r) => r.channelId).sort()).toEqual([f.general.id, secret.id, dm.id].sort());
    expect(anas.find((r) => r.channelId === dm.id)).toMatchObject({
      channelKind: "dm",
      channelName: null,
      threadId: null,
    });

    const stranger = await addUser(f.db, "zed");
    await expect(listWorkingRuns(f.db, stranger.id, f.org.id)).rejects.toThrow();
  });
});

describe("reminders from the app", () => {
  const inAnHour = () => new Date(Date.now() + 3600_000);

  test("about a message: a one-off routine in its thread, by the conversation's agent; listed as mine", async () => {
    f = await setup();
    const bia = await withBia();
    const message = await post(f.owner.id, f.general.id, "Ship the release notes on Friday");
    const at = inAnHour();
    const reminder = await createReminderFromApp({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, {
      channelId: f.general.id,
      messageId: message.id,
      at,
      timezone: "UTC",
    });
    expect(reminder).toMatchObject({
      message: "Ship the release notes on Friday",
      at: at.toISOString(),
      forUserId: bia.id,
      channelId: f.general.id,
      threadId: message.id,
      done: false,
    });
    const [routine] = await f.db.select().from(schema.routines).where(eq(schema.routines.id, reminder.id));
    expect(routine).toMatchObject({ agentId: f.agent.id, triggerType: "once", createdByUserId: bia.id });
    expect((await listMyReminders(f.db, bia.id, f.org.id)).map((r) => r.id)).toEqual([reminder.id]);
    expect(await listMyReminders(f.db, f.owner.id, f.org.id)).toEqual([]);
  });

  test("refused: the past, no agent there, a channel or DM I can't read", async () => {
    f = await setup();
    const bia = await withBia();
    const routineDeps = { db: f.db, pubsub: f.pubsub };
    const base = { channelId: f.general.id, text: "Check the deploy" };
    await expect(
      createReminderFromApp(routineDeps, bia.id, f.org.id, { ...base, at: new Date(Date.now() - 60_000) }),
    ).rejects.toMatchObject({ code: "when.past" });

    const quiet = await createChannel(f.db, bia.id, f.org.id, { name: "quiet" });
    await expect(
      createReminderFromApp(routineDeps, bia.id, f.org.id, { channelId: quiet.id, text: "x", at: inAnHour() }),
    ).rejects.toMatchObject({ code: "reminder.no_agent" });

    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "secret", visibility: "private" });
    await expect(
      createReminderFromApp(routineDeps, bia.id, f.org.id, { channelId: secret.id, text: "x", at: inAnHour() }),
    ).rejects.toThrow();

    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    const said = await post(f.owner.id, dm.id, "my private note");
    await expect(
      createReminderFromApp(routineDeps, bia.id, f.org.id, { channelId: dm.id, messageId: said.id, at: inAnHour() }),
    ).rejects.toThrow();
    // Ana can, in her DM (flat: no thread).
    const mine = await createReminderFromApp(routineDeps, f.owner.id, f.org.id, {
      channelId: dm.id,
      messageId: said.id,
      at: inAnHour(),
    });
    expect(mine).toMatchObject({ channelId: dm.id, threadId: null, message: "my private note" });
    expect(await listMyReminders(f.db, bia.id, f.org.id)).toEqual([]);
    expect((await listMyReminders(f.db, f.owner.id, f.org.id)).map((r) => r.id)).toEqual([mine.id]);
  });
});

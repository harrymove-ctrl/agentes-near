import { afterEach, describe, expect, test } from "bun:test";
import { chatActivityTopic, type RealtimeEvent, userTopic } from "@agenteschat/adapters";
import {
  activityAudience,
  addChannelMember,
  countUnreadThreads,
  createThreadFromRange,
  getThread,
  insertMessage,
  listChannels,
  listDms,
  listMembers,
  markChannelRead,
  markThreadRead,
  messageView,
  moveContextIntoThread,
  openDm,
  postPersonMessage,
  publishMessageCreated,
  setChannelMuted,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

/** Unread marks: mentions, muting, threads I follow, and every device hearing reads. */

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
  const found = (await listChannels(f.db, userId, f.org.id)).find((c) => c.id === f.general.id);
  if (!found) throw new Error("general not listed");
  return found;
};
/** PGlite counts whole milliseconds: what comes next lands after a join or a read. */
const nextMillisecond = () => Bun.sleep(2);
const heard = (userId: string) => {
  const events: RealtimeEvent[] = [];
  f.pubsub.subscribe(userTopic(f.org.id, userId), (e) => events.push(e));
  return events;
};

async function withBia() {
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  await listMembers(f.db, f.org.id); // assigns handles: "@bia" resolves
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
  await nextMillisecond();
  return bia;
}

describe("channels: mentions and muting", () => {
  test("mentions of me are counted apart; muting keeps them and says so", async () => {
    f = await setup();
    const bia = await withBia();
    await post(f.owner.id, f.general.id, "hello all");
    await post(f.owner.id, f.general.id, "@bia can you look?");
    expect(await general(bia.id)).toMatchObject({ unreadCount: 2, mentionCount: 1, muted: false });
    // Mine never count, mention or not.
    expect(await general(f.owner.id)).toMatchObject({ unreadCount: 0, mentionCount: 0 });

    const events = heard(bia.id);
    await setChannelMuted(f.db, bia.id, f.org.id, f.general.id, true, f.pubsub);
    expect(events).toContainEqual({ type: "channel.muted", channelId: f.general.id, muted: true });
    expect((await general(bia.id)).muted).toBe(true);
    await nextMillisecond();
    await post(f.owner.id, f.general.id, "@bia again");
    expect((await general(bia.id)).mentionCount).toBeGreaterThanOrEqual(1);
    // Reading keeps the choice.
    await markChannelRead(f.db, bia.id, f.org.id, f.general.id);
    expect(await general(bia.id)).toMatchObject({ unreadCount: 0, mentionCount: 0, muted: true });
    await setChannelMuted(f.db, bia.id, f.org.id, f.general.id, false, f.pubsub);
    expect((await general(bia.id)).muted).toBe(false);
  });

  test("muting a channel I never opened keeps what's unread there, mentions included", async () => {
    f = await setup();
    const bia = await withBia();
    await post(f.owner.id, f.general.id, "@bia welcome");
    await nextMillisecond();
    await setChannelMuted(f.db, bia.id, f.org.id, f.general.id, true, f.pubsub);
    expect(await general(bia.id)).toMatchObject({ unreadCount: 1, mentionCount: 1, muted: true });
    await setChannelMuted(f.db, bia.id, f.org.id, f.general.id, false, f.pubsub);
    expect(await general(bia.id)).toMatchObject({ unreadCount: 1, mentionCount: 1, muted: false });
  });

  test("a mention past the first 100 unread still counts", async () => {
    f = await setup();
    const bia = await withBia();
    for (let i = 0; i < 120; i++)
      await insertMessage(f.db, {
        orgId: f.org.id,
        channelId: f.general.id,
        author: { type: "agent", agentId: f.agent.id, runId: null, hop: 1, stretchId: null },
        body: `step ${i}`,
      });
    await post(f.owner.id, f.general.id, "@bia one for you");
    expect(await general(bia.id)).toMatchObject({ unreadCount: 100, mentionCount: 1 });
  });

  test("only members mute", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await expect(setChannelMuted(f.db, bia.id, f.org.id, f.general.id, true)).rejects.toThrow("Channel not found");
  });

  test("a DM can't be muted (its lists count every unread message)", async () => {
    f = await setup();
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    await expect(setChannelMuted(f.db, f.owner.id, f.org.id, dm.id, true)).rejects.toMatchObject({
      code: "channel.mute_dm",
    });
  });
});

describe("reads reach my other devices", () => {
  test("reading a channel or a DM is heard on my own topic", async () => {
    f = await setup();
    const events = heard(f.owner.id);
    const at = new Date("2026-11-02T10:00:00.000Z");
    await markChannelRead(f.db, f.owner.id, f.org.id, f.general.id, at, f.pubsub);
    expect(events).toContainEqual({
      type: "channel.read",
      channelId: f.general.id,
      userId: f.owner.id,
      lastReadAt: at.toISOString(),
    });
  });
});

describe("DMs with agents", () => {
  test("the agent's messages are unread for me; mine never", async () => {
    f = await setup();
    const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
    await markChannelRead(f.db, f.owner.id, f.org.id, dm.id);
    await nextMillisecond();
    await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: dm.id,
      author: { type: "person", userId: f.owner.id },
      body: "status?",
    });
    for (const body of ["on it", "done"])
      await insertMessage(f.db, {
        orgId: f.org.id,
        channelId: dm.id,
        author: { type: "agent", agentId: f.agent.id, runId: null, hop: 1, stretchId: null },
        body,
      });
    const found = (await listDms(f.db, f.owner.id, f.org.id)).find((d) => d.channelId === dm.id);
    expect(found?.unread).toBe(2);
  });
});

describe("threads I follow", () => {
  test("a reply is unread in the thread until I read it there; the channel's count follows", async () => {
    f = await setup();
    const bia = await withBia();
    const root = await post(bia.id, f.general.id, "Release checklist");
    await markChannelRead(f.db, bia.id, f.org.id, f.general.id);
    await nextMillisecond();
    await post(f.owner.id, f.general.id, "first reply", root.id);
    await post(f.owner.id, f.general.id, "second reply", root.id);
    expect((await getThread(f.db, bia.id, f.org.id, root.id)).unread).toBe(2);
    expect(await countUnreadThreads(f.db, bia.id, f.org.id)).toBe(1);
    expect((await general(bia.id)).unreadCount).toBe(2);
    // Ana wrote the replies: nothing unread for her.
    expect((await getThread(f.db, f.owner.id, f.org.id, root.id)).unread).toBe(0);

    const events = heard(bia.id);
    await markThreadRead(deps(), bia.id, f.org.id, root.id);
    expect(events.map((e) => e.type)).toContain("thread.read");
    expect((await getThread(f.db, bia.id, f.org.id, root.id)).unread).toBe(0);
    expect(await countUnreadThreads(f.db, bia.id, f.org.id)).toBe(0);
    expect((await general(bia.id)).unreadCount).toBe(0);

    await nextMillisecond();
    await post(f.owner.id, f.general.id, "third reply", root.id);
    expect(await countUnreadThreads(f.db, bia.id, f.org.id)).toBe(1);
  });

  test("reading the channel leaves a followed thread's replies unread (they aren't shown there)", async () => {
    f = await setup();
    const bia = await withBia();
    const root = await post(bia.id, f.general.id, "Release checklist");
    await nextMillisecond();
    await post(f.owner.id, f.general.id, "a reply", root.id);
    await nextMillisecond();
    await markChannelRead(f.db, bia.id, f.org.id, f.general.id);
    expect((await getThread(f.db, bia.id, f.org.id, root.id)).unread).toBe(1);
    expect(await countUnreadThreads(f.db, bia.id, f.org.id)).toBe(1);
    expect((await general(bia.id)).unreadCount).toBe(0);
  });

  test("a thread I don't follow is never unread", async () => {
    f = await setup();
    const bia = await withBia();
    const root = await post(f.owner.id, f.general.id, "Ana's topic");
    await post(f.owner.id, f.general.id, "a reply", root.id);
    expect((await getThread(f.db, bia.id, f.org.id, root.id)).unread).toBe(0);
    expect(await countUnreadThreads(f.db, bia.id, f.org.id)).toBe(0);
  });
});

describe("threads I don't follow", () => {
  test("a mention of me in one still counts, red, and reaches my sockets", async () => {
    f = await setup();
    const bia = await withBia();
    const root = await post(f.owner.id, f.general.id, "Ana's topic");
    await markChannelRead(f.db, bia.id, f.org.id, f.general.id);
    await nextMillisecond();
    await post(f.owner.id, f.general.id, "just a reply", root.id);
    await post(f.owner.id, f.general.id, "@bia can you check?", root.id);
    expect(await general(bia.id)).toMatchObject({ unreadCount: 1, mentionCount: 1 });
    expect((await activityAudience(f.db, f.general.id, root.id, [bia.id])).userIds.has(bia.id)).toBe(true);
    expect((await activityAudience(f.db, f.general.id, root.id)).userIds.has(bia.id)).toBe(false);
  });
});

describe("messages moved into a thread (Tirar do canal)", () => {
  test("aren't unread replies for the people who follow it", async () => {
    f = await setup();
    const bia = await withBia();
    const a = await post(f.owner.id, f.general.id, "Onboarding is too long");
    await post(bia.id, f.general.id, "Agree, step 3");
    const c = await post(f.owner.id, f.general.id, "Cut it to 2 steps");
    const thread = await createThreadFromRange(deps(), f.owner.id, {
      orgId: f.org.id,
      channelId: f.general.id,
      firstMessageId: a.id,
      lastMessageId: c.id,
    });
    await moveContextIntoThread(deps(), f.owner.id, f.org.id, thread.id);
    expect((await getThread(f.db, bia.id, f.org.id, thread.id)).unread).toBe(0);
    expect(await countUnreadThreads(f.db, bia.id, f.org.id)).toBe(0);
    await nextMillisecond();
    await post(f.owner.id, f.general.id, "a real reply", thread.id);
    expect((await getThread(f.db, bia.id, f.org.id, thread.id)).unread).toBe(1);
  });
});

describe("live", () => {
  test("a new message says which channel moved (no content) for the sockets to relay", async () => {
    f = await setup();
    const events: RealtimeEvent[] = [];
    f.pubsub.subscribe(chatActivityTopic, (e) => events.push(e));
    const m = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: f.owner.id },
      body: "secret plans",
    });
    await publishMessageCreated(f.pubsub, messageView(m));
    expect(events).toEqual([
      {
        type: "channel.activity",
        channelId: f.general.id,
        threadId: null,
        authorUserId: f.owner.id,
        mentionedUserIds: [],
      },
    ]);
  });
});

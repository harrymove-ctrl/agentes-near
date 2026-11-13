import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { keys } from "../src/api/keys";
import { applyUnreadEvent, UNREAD_REFRESH_MS } from "../src/api/queries";
import type { Channel, DirectMessage, ThreadInfo } from "../src/api/types";
import { looksUnread, titledWithUnread, unreadTotal } from "../src/lib/unread";

const channel = (id: string, extra: Partial<Channel> = {}) =>
  ({ id, name: id, isMember: true, unreadCount: 0, mentionCount: 0, muted: false, ...extra }) as Channel;
const dm = (channelId: string, unread: number) =>
  ({
    channelId,
    unread,
    with: { type: "agent", id: `a-${channelId}`, name: "Atlas", handle: "atlas" },
  }) as DirectMessage;

describe("what looks unread", () => {
  test("something new I haven't muted, in a channel I'm in", () => {
    expect(looksUnread(channel("c", { unreadCount: 3 }))).toBe(true);
    expect(looksUnread(channel("c", { unreadCount: 3, muted: true }))).toBe(false);
    expect(looksUnread(channel("c", { unreadCount: 3, isMember: false }))).toBe(false);
    expect(looksUnread(channel("c"))).toBe(false);
  });

  test("the total is DM messages plus mentions of me (muted channels' too), never plain channel messages", () => {
    const channels = [
      channel("busy", { unreadCount: 40 }),
      channel("named", { unreadCount: 5, mentionCount: 2 }),
      channel("quiet", { unreadCount: 1, mentionCount: 1, muted: true }),
      channel("left", { isMember: false, mentionCount: 9 }),
    ];
    expect(unreadTotal(channels, [dm("d1", 3), dm("d2", 0)])).toBe(6);
  });

  test("DMs with agents my lists hide add nothing (the web title and the phone icon agree)", () => {
    expect(unreadTotal([], [dm("d1", 4), dm("d2", 1)], new Set(["a-d1"]))).toBe(1);
  });

  test("the tab title carries the total in front, replaced, gone at zero, 99+ past 99", () => {
    expect(titledWithUnread("agentes.chat", 3)).toEqual({ title: "(3) agentes.chat", prefix: "(3) " });
    expect(titledWithUnread("(3) agentes.chat", 5, "(3) ").title).toBe("(5) agentes.chat");
    expect(titledWithUnread("(99+) #geral", 0, "(99+) ").title).toBe("#geral");
    expect(titledWithUnread("#geral", 120).title).toBe("(99+) #geral");
    // A page's own count (the Notifications page) stays, whatever the total.
    expect(titledWithUnread("(3) Notificações", 0, "(5) ")).toEqual({ title: "(3) Notificações", prefix: "" });
    expect(titledWithUnread("(3) Notificações", 7).title).toBe("(3) Notificações");
  });
});

describe("live unread on my own topic", () => {
  const ORG = "org-1";
  const seeded = () => {
    const qc = new QueryClient();
    qc.setQueryData(keys.channels(ORG), [channel("c1", { unreadCount: 4, mentionCount: 1 })]);
    qc.setQueryData(keys.dms(ORG), [dm("d1", 2)]);
    qc.setQueryData(keys.threadInfo(ORG, "t1"), { id: "t1", unread: 3 } as ThreadInfo);
    return qc;
  };
  const stale = (qc: QueryClient, key: readonly unknown[]) => qc.getQueryState(key)?.isInvalidated === true;

  test("a read on another device clears the conversation at once", () => {
    const qc = seeded();
    applyUnreadEvent(qc, ORG, { type: "channel.read", channelId: "c1", userId: "me", lastReadAt: "" } as never);
    applyUnreadEvent(qc, ORG, { type: "channel.read", channelId: "d1", userId: "me", lastReadAt: "" } as never);
    expect(qc.getQueryData<Channel[]>(keys.channels(ORG))?.[0]).toMatchObject({ unreadCount: 0, mentionCount: 0 });
    expect(qc.getQueryData<DirectMessage[]>(keys.dms(ORG))?.[0]?.unread).toBe(0);
  });

  test("a mute from another device, and a thread read there", () => {
    const qc = seeded();
    applyUnreadEvent(qc, ORG, { type: "channel.muted", channelId: "c1", muted: true } as never);
    expect(qc.getQueryData<Channel[]>(keys.channels(ORG))?.[0]?.muted).toBe(true);
    applyUnreadEvent(qc, ORG, { type: "thread.read", threadId: "t1", channelId: "c1", lastReadAt: "" } as never);
    expect(qc.getQueryData<ThreadInfo>(keys.threadInfo(ORG, "t1"))?.unread).toBe(0);
  });

  test("new messages have the lists read again once per burst", async () => {
    const qc = seeded();
    for (let i = 0; i < 5; i++)
      applyUnreadEvent(qc, ORG, { type: "channel.activity", channelId: "c1", threadId: null } as never);
    expect(stale(qc, keys.channels(ORG))).toBe(false);
    await Bun.sleep(UNREAD_REFRESH_MS + 50);
    expect(stale(qc, keys.channels(ORG))).toBe(true);
    // Only the list that moved reads again.
    expect(stale(qc, keys.dms(ORG))).toBe(false);
  });

  test("a DM's message reads only the DMs again", async () => {
    const qc = seeded();
    applyUnreadEvent(qc, ORG, { type: "channel.activity", channelId: "d1", threadId: null, dm: true } as never);
    await Bun.sleep(UNREAD_REFRESH_MS + 50);
    expect(stale(qc, keys.dms(ORG))).toBe(true);
    expect(stale(qc, keys.channels(ORG))).toBe(false);
  });
});

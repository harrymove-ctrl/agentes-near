import { describe, expect, test } from "bun:test";
import type { AppNotification } from "../src/api/types";
import { createIsland, islandLead, isOnScreen, noticeLine, raisesIsland, settledBy } from "../src/lib/island";

const now = Date.parse("2026-11-03T12:00:00Z");
const notice = (over: Partial<AppNotification> = {}): AppNotification => ({
  id: "n1",
  kind: "agent_reply",
  waiting: false,
  actors: [{ type: "agent", id: "a1" }],
  count: 1,
  source: { channelId: "c1", messageId: "m1", label: "suporte" },
  latest: { text: "Pronto: o cupom tinha vencido." },
  readAt: null,
  doneAt: null,
  snoozedUntil: null,
  createdAt: "2026-11-03T11:59:00Z",
  updatedAt: "2026-11-03T11:59:00Z",
  ...over,
});
const upserted = (n: AppNotification, alert?: boolean) =>
  ({ type: "notification.upserted", notification: n, ...(alert === undefined ? {} : { alert }) }) as const;
const ids = (island: ReturnType<typeof createIsland>) => island.get().items.map((i) => i.n.id);

describe("what raises the island", () => {
  test("news the person keeps on, about a conversation not on screen", () => {
    expect(raisesIsland(upserted(notice(), true), [], now)).toBe(true);
    // Older servers send no `alert`: it shows, as the desktop app's banner does.
    expect(raisesIsland(upserted(notice()), [], now)).toBe(true);
  });

  test("not a kind the person turned off, nor something already read, done or snoozed", () => {
    expect(raisesIsland(upserted(notice(), false), [], now)).toBe(false);
    expect(raisesIsland(upserted(notice({ readAt: "2026-11-03T11:59:30Z" })), [], now)).toBe(false);
    expect(raisesIsland(upserted(notice({ doneAt: "2026-11-03T11:59:30Z" })), [], now)).toBe(false);
    expect(raisesIsland(upserted(notice({ snoozedUntil: "2026-11-03T13:00:00Z" })), [], now)).toBe(false);
    // A snooze that ran out brings it back.
    expect(raisesIsland(upserted(notice({ snoozedUntil: "2026-11-03T11:00:00Z" })), [], now)).toBe(true);
  });

  test("nothing for the conversation on screen: the channel, or the thread when it is a thread's", () => {
    const channel = [{ channelId: "c1", threadId: null }];
    expect(raisesIsland(upserted(notice()), channel, now)).toBe(false);
    // A reply in one of its threads isn't on screen while only the channel is.
    const reply = notice({ kind: "thread_reply", source: { channelId: "c1", threadId: "t1" } });
    expect(raisesIsland(upserted(reply), channel, now)).toBe(true);
    expect(raisesIsland(upserted(reply), [...channel, { channelId: "c1", threadId: "t1" }], now)).toBe(false);
    // A DM is its channel.
    const dm = notice({ kind: "dm", source: { dmId: "d1" } });
    expect(isOnScreen(dm, [{ channelId: "d1", threadId: null }])).toBe(true);
    // Nothing to compare with (an approval, a task): never on screen.
    expect(isOnScreen(notice({ kind: "approval", source: { approvalId: "p1" } }), channel)).toBe(false);
  });

  test("what takes one off: read, done or snoozed elsewhere, or removed", () => {
    expect(settledBy({ type: "notification.removed", id: "n9" }, now)).toBe("n9");
    expect(settledBy(upserted(notice({ readAt: "2026-11-03T12:00:00Z" })), now)).toBe("n1");
    expect(settledBy(upserted(notice()), now)).toBeNull();
    expect(settledBy({ type: "notification.counts", unread: 0, waiting: 0 } as never, now)).toBeNull();
  });
});

describe("the line under the headline", () => {
  const word = (kind: string) => `[${kind}]`;
  test("the snippet; an approval's action; the word for media without text", () => {
    expect(noticeLine(notice(), word)).toBe("Pronto: o cupom tinha vencido.");
    expect(noticeLine(notice({ kind: "approval", latest: { title: "Merge do PR #212", text: "porque" } }), word)).toBe(
      "Merge do PR #212",
    );
    expect(noticeLine(notice({ latest: { media: "gif" } }), word)).toBe("[gif]");
    // A voice message's words are the agents': people read its name.
    expect(noticeLine(notice({ latest: { media: "voice", text: "olá" } }), word)).toBe("[voice]");
  });
});

describe("the island's list", () => {
  test("newest on top; the same notification again moves up with its time back", () => {
    const island = createIsland({ life: 1000 });
    island.arrive(notice({ id: "a" }));
    island.arrive(notice({ id: "b" }));
    island.tick(600);
    island.arrive(notice({ id: "a", count: 2 }));
    expect(ids(island)).toEqual(["a", "b"]);
    expect(island.get().items[0]?.n.count).toBe(2);
    island.tick(500);
    // "b" ran out; "a" came back with its whole time.
    expect(ids(island)).toEqual(["a"]);
  });

  test("time runs out: what isn't waiting leaves, what is shrinks and stays", () => {
    const island = createIsland({ life: 1000 });
    island.arrive(notice({ id: "reply" }));
    island.arrive(notice({ id: "ask", kind: "approval", waiting: true }));
    island.tick(1000);
    expect(ids(island)).toEqual(["ask"]);
    expect(island.get().items[0]?.small).toBe(true);
    island.tick(60_000);
    expect(ids(island)).toEqual(["ask"]);
  });

  test("counting down alone draws nothing", () => {
    const island = createIsland({ life: 1000 });
    island.arrive(notice());
    const before = island.get();
    let calls = 0;
    island.subscribe(() => calls++);
    island.tick(100);
    expect(calls).toBe(0);
    expect(island.get()).toBe(before);
  });

  test("paused for any reason, time stops", () => {
    const island = createIsland({ life: 1000 });
    island.arrive(notice());
    island.pause("hover", true);
    island.pause("typing", true);
    island.tick(5000);
    island.pause("hover", false);
    island.tick(5000);
    expect(ids(island)).toEqual(["n1"]);
    island.pause("typing", false);
    island.tick(1000);
    expect(ids(island)).toEqual([]);
  });

  test("×: waiting shrinks first, then leaves; anything else leaves at once", () => {
    const island = createIsland();
    island.arrive(notice({ id: "reply" }));
    island.arrive(notice({ id: "ask", kind: "agent_question", waiting: true }));
    island.dismiss("reply");
    island.dismiss("ask");
    expect(island.get().items.map((i) => [i.n.id, i.small])).toEqual([["ask", true]]);
    island.dismiss("ask");
    expect(ids(island)).toEqual([]);
  });

  test("put away (swipe up, Esc): the waiting ones shrink, the rest leave", () => {
    const island = createIsland();
    island.arrive(notice({ id: "reply" }));
    island.arrive(notice({ id: "ask", kind: "approval", waiting: true }));
    island.putAway();
    expect(island.get().items.map((i) => [i.n.id, i.small])).toEqual([["ask", true]]);
  });

  test("settled elsewhere: it leaves; unknown ids change nothing", () => {
    const island = createIsland();
    island.arrive(notice());
    const before = island.get();
    island.settle("other");
    expect(island.get()).toBe(before);
    island.settle("n1");
    expect(ids(island)).toEqual([]);
  });

  test("past the limit the oldest that isn't waiting leaves first", () => {
    const island = createIsland({ max: 3 });
    island.arrive(notice({ id: "ask", kind: "approval", waiting: true }));
    island.arrive(notice({ id: "r1" }));
    island.arrive(notice({ id: "r2" }));
    island.arrive(notice({ id: "r3" }));
    expect(ids(island)).toEqual(["r3", "r2", "ask"]);
  });

  test("the closed island leads with the newest still in its time; small only when all are", () => {
    const island = createIsland({ life: 1000 });
    island.arrive(notice({ id: "ask", kind: "approval", waiting: true }));
    island.tick(1000);
    island.arrive(notice({ id: "reply" }));
    let lead = islandLead(island.get().items);
    expect([lead.lead?.n.id, lead.small, lead.others]).toEqual(["reply", false, 1]);
    island.tick(1000);
    lead = islandLead(island.get().items);
    expect([lead.lead?.n.id, lead.small, lead.others]).toEqual(["ask", true, 0]);
    expect(islandLead([]).lead).toBeNull();
  });
});

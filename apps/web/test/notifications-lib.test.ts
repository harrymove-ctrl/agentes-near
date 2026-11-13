import { describe, expect, test } from "bun:test";
import type { AppNotification, NotificationPage } from "@agenteschat/client";
import {
  dayGroupOf,
  groupByDay,
  headlineNames,
  homeTarget,
  isExpandable,
  matchesFilter,
  type NotificationPages,
  opensOnComputer,
  openTarget,
  removeFromPages,
  replyTarget,
  snoozeTimes,
  sortWaiting,
  stepCells,
  targetPath,
  upsertInPages,
  waitingCardOf,
  widgetNoticeOf,
} from "@agenteschat/client/lib/notifications";
import { notification } from "./fakes/notifications";

const NOW = new Date(2026, 9, 16, 15, 30); // Friday 15:30, local time
const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();

const page = (items: AppNotification[], counts: Partial<NotificationPage["counts"]> = {}): NotificationPages => ({
  pages: [
    {
      items,
      counts: { all: items.length, mentions: 0, waiting: 0, unread: 0, reactions: 0, ...counts },
      nextCursor: null,
    },
  ],
  pageParams: [""],
});

describe("filters", () => {
  test("mentions are mentions, DMs and agents' questions; done and snoozed ones are hidden everywhere", () => {
    const now = NOW.getTime();
    expect(matchesFilter(notification({ id: "a", kind: "dm" }), "mentions", now)).toBe(true);
    expect(matchesFilter(notification({ id: "b", kind: "agent_question" }), "mentions", now)).toBe(true);
    expect(matchesFilter(notification({ id: "c", kind: "thread_reply" }), "mentions", now)).toBe(false);
    expect(matchesFilter(notification({ id: "d", kind: "reaction" }), "reactions", now)).toBe(true);
    expect(matchesFilter(notification({ id: "e", kind: "mention", readAt: at(1) }), "unread", now)).toBe(false);
    expect(matchesFilter(notification({ id: "f", kind: "mention", doneAt: at(1) }), "all", now)).toBe(false);
    const snoozed = notification({ id: "g", kind: "mention", snoozedUntil: at(-60) });
    expect(matchesFilter(snoozed, "all", now)).toBe(false);
    // Back once the time passes.
    expect(matchesFilter(snoozed, "all", now + 2 * 3_600_000)).toBe(true);
  });
});

describe("live changes on a loaded list", () => {
  const a = notification({ id: "a", kind: "mention", updatedAt: at(30) });
  const b = notification({ id: "b", kind: "dm", updatedAt: at(10), readAt: at(5) });

  test("a new one lands in order (waiting first, then newest) and the counts move", () => {
    const data = page([b, a], { all: 2, mentions: 2, unread: 1 });
    const w = notification({ id: "w", kind: "approval", waiting: true, updatedAt: at(600) });
    const next = upsertInPages(data, "all", w, undefined, NOW.getTime());
    expect(next.pages[0]?.items.map((n) => n.id)).toEqual(["w", "b", "a"]);
    expect(next.pages[0]?.counts).toMatchObject({ all: 3, waiting: 1, unread: 2, mentions: 2 });
  });

  test("done leaves the list and every count it was in; read only moves unread", () => {
    const data = page([b, a], { all: 2, mentions: 2, unread: 1 });
    const done = upsertInPages(data, "all", { ...a, doneAt: at(0) }, undefined, NOW.getTime());
    expect(done.pages[0]?.items.map((n) => n.id)).toEqual(["b"]);
    expect(done.pages[0]?.counts).toMatchObject({ all: 1, mentions: 1, unread: 0 });
    const read = upsertInPages(data, "all", { ...a, readAt: at(0) }, undefined, NOW.getTime());
    expect(read.pages[0]?.items.map((n) => n.id)).toEqual(["b", "a"]);
    expect(read.pages[0]?.counts).toMatchObject({ all: 2, unread: 0 });
    // The unread list drops it.
    const unreadList = upsertInPages(page([a], { all: 2, unread: 1 }), "unread", { ...a, readAt: at(0) });
    expect(unreadList.pages[0]?.items).toEqual([]);
  });

  test("Concluídas: done joins it, the latest done first; Mover de volta takes it out; the counts stay the inbox's", () => {
    const old = notification({ id: "old", kind: "mention", doneAt: at(60) });
    const data = page([old], { all: 3, mentions: 3 });
    const done = upsertInPages(data, "done", { ...a, doneAt: at(0) }, a, NOW.getTime());
    expect(done.pages[0]?.items.map((n) => n.id)).toEqual(["a", "old"]);
    expect(done.pages[0]?.counts).toMatchObject({ all: 2, mentions: 2 });
    const back = upsertInPages(done, "done", { ...old, doneAt: null }, undefined, NOW.getTime());
    expect(back.pages[0]?.items.map((n) => n.id)).toEqual(["a"]);
    expect(
      groupByDay([old, { ...a, doneAt: at(0) }], NOW, (n) => n.doneAt ?? "").map(([, l]) => l.map((n) => n.id)),
    ).toEqual([["a", "old"]]);
  });

  test("removed (auto-resolved) goes away with its counts", () => {
    const data = page([b, a], { all: 2, mentions: 2, unread: 1 });
    const next = removeFromPages(data, "a", undefined, NOW.getTime());
    expect(next.pages[0]?.items.map((n) => n.id)).toEqual(["b"]);
    expect(next.pages[0]?.counts).toMatchObject({ all: 1, mentions: 1, unread: 0 });
  });
});

describe("grouping and order", () => {
  test("Hoje, Ontem, Esta semana, Mais antigas by the last update in local time", () => {
    expect(dayGroupOf(at(10), NOW)).toBe("today");
    expect(dayGroupOf(new Date(2026, 9, 15, 23, 59).toISOString(), NOW)).toBe("yesterday");
    expect(dayGroupOf(new Date(2026, 9, 11, 9).toISOString(), NOW)).toBe("week");
    expect(dayGroupOf(new Date(2026, 9, 9, 9).toISOString(), NOW)).toBe("older");
    const groups = groupByDay(
      [
        notification({ id: "old", kind: "mention", updatedAt: new Date(2026, 8, 1).toISOString() }),
        notification({ id: "now", kind: "mention", updatedAt: at(1) }),
      ],
      NOW,
    );
    expect(groups.map(([g, l]) => [g, l.map((n) => n.id)])).toEqual([
      ["today", ["now"]],
      ["older", ["old"]],
    ]);
  });

  test("waiting: an agent's question, then an approval", () => {
    const list = sortWaiting([
      notification({ id: "ap", kind: "approval", waiting: true }),
      notification({ id: "q", kind: "agent_question", waiting: true }),
    ]);
    expect(list.map((n) => n.id)).toEqual(["q", "ap"]);
  });

  test("a thread with several replies (or an issue with several comments) expands", () => {
    expect(
      isExpandable(
        notification({ id: "t", kind: "thread_reply", count: 3, source: { channelId: "c", threadId: "r" } }),
      ),
    ).toBe(true);
    expect(isExpandable(notification({ id: "t", kind: "thread_reply", count: 1, source: { threadId: "r" } }))).toBe(
      false,
    );
    expect(isExpandable(notification({ id: "i", kind: "issue_comment", count: 2, source: { issueId: "i1" } }))).toBe(
      true,
    ); // A shared failure row expands on the agents it lists, whatever its count says.
    const failure = (agentId: string) => ({ key: agentId, agentId, channelId: "c", messageId: "m" });
    expect(
      isExpandable(
        notification({ id: "rf", kind: "run_failed", count: 1, latest: { failures: [failure("a1"), failure("a2")] } }),
      ),
    ).toBe(true);
  });
});

describe("answering and opening", () => {
  test("reply goes through the endpoint of the source", () => {
    expect(replyTarget(notification({ id: "1", kind: "agent_question", source: { questionId: "q" } }))).toEqual({
      kind: "question",
      questionId: "q",
    });
    expect(replyTarget(notification({ id: "3", kind: "issue_comment", source: { issueId: "i" } }))).toEqual({
      kind: "issue",
      issueId: "i",
    });
    expect(replyTarget(notification({ id: "4", kind: "dm", source: { dmId: "d" } }))).toEqual({
      kind: "message",
      channelId: "d",
      threadId: null,
    });
    expect(replyTarget(notification({ id: "5", kind: "mention", source: { channelId: "c", threadId: "r" } }))).toEqual({
      kind: "message",
      channelId: "c",
      threadId: "r",
    });
    expect(replyTarget(notification({ id: "6", kind: "approval", source: { approvalId: "a" } }))).toBeNull();
    expect(replyTarget(notification({ id: "7", kind: "reaction", source: { channelId: "c" } }))).toBeNull();
  });

  test("Abrir: the thread, the message in its channel, the DM, the issue, the topic, Aprovações", () => {
    expect(
      openTarget(notification({ id: "1", kind: "thread_reply", source: { channelId: "c", threadId: "r" } })),
    ).toEqual({ to: "/org/$orgId/threads/$threadId", params: { threadId: "r" } });
    expect(openTarget(notification({ id: "2", kind: "mention", source: { channelId: "c", messageId: "m" } }))).toEqual({
      to: "/org/$orgId/c/$channelId",
      params: { channelId: "c" },
      search: { m: "m" },
    });
    expect(
      openTarget(notification({ id: "3", kind: "dm", actors: [{ type: "agent", id: "ada" }], source: { dmId: "d" } })),
    ).toEqual({ to: "/org/$orgId/dm/agent/$agentId", params: { agentId: "ada" } });
    // An agent's request in my DM with it: that DM (the web has no channel page for a DM).
    const asked = notification({
      id: "3h",
      kind: "browser_handoff",
      actors: [{ type: "agent", id: "ada" }],
      source: { channelId: "d", dmId: "d", messageId: "h", handoffId: "h", agentId: "ada" },
    });
    expect(openTarget(asked)).toEqual({
      to: "/org/$orgId/dm/agent/$agentId",
      params: { agentId: "ada" },
      search: { m: "h" },
    });
    expect(opensOnComputer(asked)).toBeNull();
    // One whose conversation I can't open names none: it opens on the agent's computer.
    expect(opensOnComputer({ ...asked, source: { handoffId: "h", agentId: "ada" } })).toBe("ada");
    expect(openTarget(notification({ id: "4", kind: "issue_assigned", source: { issueNumber: 131 } }))).toEqual({
      to: "/org/$orgId/issues/$number",
      params: { number: "131" },
    });
    expect(openTarget(notification({ id: "6", kind: "approval", source: { approvalId: "a" } }))).toEqual({
      to: "/org/$orgId/approvals",
      search: { open: "a" },
    });
    // The right hand paused what it does without asking: its own page, by the address that leads there. Who approves
    // for whom stays in the person's settings.
    expect(openTarget(notification({ id: "7", kind: "right_hand_paused", source: {} }))).toEqual({
      to: "/org/$orgId/settings/$section",
      params: { section: "right_hand" },
    });
    expect(openTarget(notification({ id: "8", kind: "approval_cover", source: {} }))).toEqual({
      to: "/org/$orgId/settings/$section",
      params: { section: "approvals" },
    });
  });

  test("at the message itself: in a thread, a DM, a channel", () => {
    expect(
      openTarget(
        notification({ id: "1", kind: "thread_reply", source: { channelId: "c", threadId: "r", messageId: "m" } }),
      ),
    ).toEqual({ to: "/org/$orgId/threads/$threadId", params: { threadId: "r" }, search: { m: "m" } });
    expect(
      openTarget(
        notification({
          id: "2",
          kind: "dm",
          actors: [{ type: "user", id: "u" }],
          source: { dmId: "d", messageId: "m" },
        }),
      ),
    ).toEqual({ to: "/org/$orgId/dm/person/$userId", params: { userId: "u" }, search: { m: "m" } });
    // A reply in a thread of a DM is only in that thread: the thread opens at it, not the DM.
    for (const kind of ["agent_reply", "dm"] as const)
      expect(
        openTarget(
          notification({
            id: "4",
            kind,
            actors: [{ type: "agent", id: "ada" }],
            source: { dmId: "d", threadId: "r", messageId: "m" },
          }),
        ),
      ).toEqual({ to: "/org/$orgId/threads/$threadId", params: { threadId: "r" }, search: { m: "m" } });
    expect(openTarget(notification({ id: "3", kind: "reaction", source: { channelId: "c", messageId: "m" } }))).toEqual(
      { to: "/org/$orgId/c/$channelId", params: { channelId: "c" }, search: { m: "m" } },
    );
  });

  test("an agent's hold opens the agent; the workspace's billing hold, Cobrança", () => {
    expect(openTarget(notification({ id: "1", kind: "org_standing", source: { agentId: "a" } }))).toEqual({
      to: "/org/$orgId/agents/$agentId",
      params: { agentId: "a" },
    });
    expect(
      openTarget(notification({ id: "2", kind: "org_standing", source: {}, latest: { billingHold: "payment" } })),
    ).toEqual({ to: "/org/$orgId/settings/$section", params: { section: "billing" } });
  });

  test("a target as the web's address", () => {
    expect(targetPath("o", { to: "/org/$orgId/c/$channelId", params: { channelId: "c 1" }, search: { m: "m" } })).toBe(
      "/org/o/c/c%201?m=m",
    );
    expect(targetPath("o", { to: "/org/$orgId/approvals" })).toBe("/org/o/approvals");
  });

  test("the headline names the place: nothing beside it says it again", () => {
    const reply = notification({ id: "1", kind: "agent_reply", source: { channelId: "c", label: "general" } });
    expect(headlineNames(reply, "general")).toBe(true);
    expect(headlineNames(reply, "random")).toBe(false);
    expect(headlineNames({ ...reply, kind: "mention" }, "general")).toBe(false);
    expect(headlineNames({ ...reply, kind: "mention", source: { ...reply.source, threadId: "t" } }, "general")).toBe(
      true,
    );
    expect(headlineNames({ ...reply, source: {} }, "")).toBe(false);
  });
});

describe("pieces", () => {
  test("steps: done, the one it stopped at, the rest to do", () => {
    expect(stepCells({ done: 3, total: 5, failedAt: 4 })).toEqual(["done", "done", "done", "stopped", "todo"]);
    expect(stepCells({ done: 4, total: 4 })).toEqual(["done", "done", "done", "done"]);
  });

  test("Lembrar depois: in 1 hour, tomorrow at 9, next Monday at 9 (local time)", () => {
    const friday = snoozeTimes(NOW);
    expect(friday.hour.getTime() - NOW.getTime()).toBe(3_600_000);
    expect([friday.tomorrow.getDay(), friday.tomorrow.getHours(), friday.tomorrow.getMinutes()]).toEqual([6, 9, 0]);
    expect([friday.nextWeek.getDay(), friday.nextWeek.getDate(), friday.nextWeek.getHours()]).toEqual([1, 19, 9]);
    // From a Monday, the Monday after.
    const monday = snoozeTimes(new Date(2026, 9, 19, 8, 0));
    expect([monday.nextWeek.getDay(), monday.nextWeek.getDate()]).toEqual([1, 26]);
  });
});

describe("a board's notices (ADR 0135)", () => {
  const alert = notification({
    id: "a",
    kind: "widget_alert",
    waiting: true,
    actors: [{ type: "agent", id: "ada" }],
    source: { dashboardId: "d1", widgetId: "w1", agentId: "ada", label: "Vendas hoje" },
    latest: { text: "Caiu 24%." },
  });

  test("open the board with the widget's panel; on my home board, Home", () => {
    const target = openTarget(alert);
    expect(target).toEqual({
      to: "/org/$orgId/dashboards/$dashboardId",
      params: { dashboardId: "d1" },
      search: { widget: "w1" },
    });
    if (!target) throw new Error("no target");
    expect(homeTarget(target, "d1")).toEqual({ to: "/org/$orgId/home", search: { widget: "w1" } });
    expect(homeTarget(target, "other")).toBe(target);
    expect(targetPath("o", target)).toBe("/org/o/dashboards/d1?widget=w1");
    // Without a board, the boards.
    expect(openTarget(notification({ id: "b", kind: "dashboard_proposal" }))).toEqual({ to: "/org/$orgId/dashboards" });
  });

  test("proposals waiting open their tab in Aprovações", () => {
    expect(openTarget(notification({ id: "p", kind: "proposal_waiting" }))).toEqual({ to: "/org/$orgId/proposals" });
  });

  test("what each says and offers: an alert's words, a failure's reason, a request's audience", () => {
    expect(widgetNoticeOf(alert)).toMatchObject({ kind: "alert", widgetId: "w1", agentId: "ada", text: "Caiu 24%." });
    expect(
      widgetNoticeOf(notification({ id: "f", kind: "widget_failed", latest: { reason: "budget_exceeded" } })),
    ).toMatchObject({ kind: "failed", reason: "budget_exceeded", text: null });
    expect(
      widgetNoticeOf(
        notification({ id: "p", kind: "dashboard_proposal", latest: { statusTo: "roles", names: ["Vendas"] } }),
      ),
    ).toMatchObject({ kind: "proposal", audience: "roles", roles: ["Vendas"] });
    expect(widgetNoticeOf(notification({ id: "m", kind: "mention" }))).toBeNull();
  });

  test("waiting, they open (the widget or the board): nobody to answer", () => {
    expect(waitingCardOf(alert)).toMatchObject({ action: "open", title: "Caiu 24%." });
    for (const kind of ["widget_failed", "dashboard_proposal"] as const)
      expect(waitingCardOf(notification({ id: kind, kind, waiting: true })).action).toBe("open");
  });
});

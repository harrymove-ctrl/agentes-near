import { describe, expect, test } from "bun:test";
import type { Channel, DirectMessage, OrgSummary } from "@agenteschat/client";
import { previewBody, serverBody } from "@agenteschat/client/lib/message-body";
import { resources } from "@agenteschat/i18n";
import i18next from "i18next";
import {
  appBadgeCount,
  buildConversations,
  hiddenAgentIds,
  homeSections,
  isListedThread,
  isListKind,
  isQuietGeneral,
  missionState,
  missionsWaiting,
  missionWaitingItems,
  openQuestions,
  parseCollapsed,
  rowBadge,
  rowName,
  rowPlace,
  rowsOfKind,
  THREAD_SECTIONS,
  threadRowLines,
  threadRows,
  threadSections,
  toggleCollapsed,
  unreadConversationCount,
  unreadConversations,
  unreadThreadCount,
  waitingTotal,
  withoutQuietGeneral,
} from "../../src/features/chats/logic";
import {
  waitingChipKey,
  waitingCount,
  waitingInThreads,
  waitingItems,
  waitingMinutes,
  waitingStack,
  waitingVerbKey,
} from "../../src/features/chats/waiting";
import { approval, at, mission as missionOf, notification, thread } from "./fixtures";

const channel = (id: string, name: string, isMember = true, over: Partial<Channel> = {}): Channel => ({
  id,
  name,
  topic: "",
  visibility: "public",
  isMember,
  createdAt: at(1000),
  ...over,
});

const dm = (channelId: string, name: string, unread: number, minutesAgo: number | null): DirectMessage => ({
  channelId,
  with: { type: "agent", id: `a-${name}`, name, handle: name.toLowerCase() },
  lastMessage:
    minutesAgo === null
      ? null
      : { id: `m-${channelId}`, body: "**Feito!** Já anotei.", createdAt: at(minutesAgo), authorType: "agent" },
  unread,
});

describe("which threads are conversations of their own", () => {
  test("a mission, a titled thread, or two people talking", () => {
    expect(
      isListedThread(
        thread({
          id: "t",
          mission: { id: "m", agentId: "a", status: "active", planDone: 1, planTotal: 3, waitingYou: 0 },
        }),
      ),
    ).toBe(true);
    expect(isListedThread(thread({ id: "t", title: "Erro no login" }))).toBe(true);
    expect(
      isListedThread(
        thread({
          id: "t",
          participants: [
            { type: "person", id: "u1" },
            { type: "person", id: "u2" },
          ],
        }),
      ),
    ).toBe(true);
  });
  test("an agent answering one person is not a thread to list; archived ones never are", () => {
    expect(
      isListedThread(
        thread({
          id: "t",
          participants: [
            { type: "person", id: "u1" },
            { type: "agent", id: "a1" },
          ],
        }),
      ),
    ).toBe(false);
    expect(isListedThread(thread({ id: "t", title: "x", state: "archived" }))).toBe(false);
  });
});

describe("the list", () => {
  const rows = buildConversations({
    channels: [channel("c2", "marketing"), channel("c1", "geral"), channel("c3", "secreto", false)],
    dms: [dm("d1", "Dev", 0, 60), dm("d2", "Ana", 2, 5)],
    threads: [
      thread({ id: "t1", title: "Erro no login", lastActivityAt: at(30) }),
      thread({ id: "t2", lastActivityAt: at(1) }),
    ],
  });

  test("newest activity first, channels without activity last by name, not-joined channels left out", () => {
    expect(rows.map((r) => r.key)).toEqual(["d:d2", "t:t1", "d:d1", "c:c1", "c:c2"]);
  });

  test("previews drop Markdown marks", () => {
    const dev = rows.find((r) => r.key === "d:d1");
    expect(dev?.kind === "dm" ? dev.last?.text : null).toBe("Feito! Já anotei.");
  });

  test("rows by kind, in the list's order", () => {
    expect(rowsOfKind(rows, "threads").map((r) => r.key)).toEqual(["t:t1"]);
    expect(rowsOfKind(rows, "agents").map((r) => r.key)).toEqual(["d:d2", "d:d1"]);
    expect(rowsOfKind(rows, "channels").map((r) => r.key)).toEqual(["c:c1", "c:c2"]);
    expect(rowsOfKind(rows, "people")).toEqual([]);
    expect(unreadConversations(rows)).toBe(1);
  });
});

describe("a personal workspace's #general (ADR 0159)", () => {
  const rows = (general: Partial<Channel>) =>
    buildConversations({
      channels: [channel("c1", "general", true, general), channel("c2", "family")],
      dms: [dm("d1", "Dev", 0, 10)],
      threads: [],
    });

  test("while its person is alone, a quiet #general leaves the home and the list; every other row stays", () => {
    const quiet = rows({ unreadCount: 0 });
    expect(quiet.filter(isQuietGeneral).map((r) => r.key)).toEqual(["c:c1"]);
    expect(withoutQuietGeneral(quiet, true).map((r) => r.key)).toEqual(["d:d1", "c:c2"]);
    // With family in it (or in a team's workspace), it shows.
    expect(withoutQuietGeneral(quiet, false).map((r) => r.key)).toEqual(quiet.map((r) => r.key));
  });

  test("something new there, a message or a mention of me, keeps it in sight", () => {
    expect(withoutQuietGeneral(rows({ unreadCount: 2 }), true).some((r) => r.key === "c:c1")).toBe(true);
    expect(withoutQuietGeneral(rows({ mentionCount: 1 }), true).some((r) => r.key === "c:c1")).toBe(true);
  });
});

describe("where a thread or mission lives", () => {
  const mission = { id: "m", agentId: "a-theo", status: "active", planDone: 3, planTotal: 8, waitingYou: 0 } as const;
  const rows = buildConversations({
    channels: [],
    dms: [dm("dm-67aa", "Theo", 0, 50)],
    threads: [
      thread({ id: "t1", channelId: "c1", channelName: "vendas", mission, lastActivityAt: at(1) }),
      thread({ id: "t2", channelId: "dm-67aa", channelName: "dm-67aa4c9adff8625b9433", channelKind: "dm", mission }),
      thread({ id: "t3", channelId: "dm-zz", channelName: "dm-zz", channelKind: "dm", mission }),
    ],
  });
  const place = (key: string, nameOf?: (who: { type: string; id: string | null }) => string) => {
    const r = rows.find((x) => x.key === key);
    return r && (r.kind === "thread" || r.kind === "mission") ? rowPlace(r, nameOf) : "missing";
  };

  test("a channel by its name", () => {
    expect(place("t:t1")).toEqual({ kind: "channel", name: "vendas" });
  });
  test("a DM by who it is with, never its internal name", () => {
    expect(place("t:t2")).toEqual({ kind: "with", name: "Theo" });
  });
  test("a DM not in the list falls back to the mission's agent, else nothing", () => {
    expect(place("t:t3", (w) => (w.id === "a-theo" ? "Theo" : ""))).toEqual({ kind: "with", name: "Theo" });
    expect(place("t:t3")).toBeNull();
    expect(place("t:t3", () => "")).toBeNull();
  });
});

describe("channels with their last message and unread", () => {
  const rows = buildConversations({
    channels: [
      channel("c1", "geral", true, {
        unreadCount: 3,
        lastMessage: {
          id: "m1",
          authorType: "person",
          authorId: "u2",
          authorName: "Ana",
          preview: "**Subiu** a página nova",
          createdAt: at(2),
        },
      }),
      channel("c2", "marketing", true, { unreadCount: 0, lastMessage: null }),
      channel("c3", "secreto", false, { unreadCount: 7 }),
    ],
    dms: [dm("d1", "Dev", 1, 10), dm("d2", "Iris", 0, 20)],
    threads: [],
  });

  test("a channel sorts by its last message and says who wrote it", () => {
    expect(rows.map((r) => r.key)).toEqual(["c:c1", "d:d1", "d:d2", "c:c2"]);
    const geral = rows[0];
    expect(geral?.kind === "channel" ? geral.last : null).toEqual({
      author: { type: "person", id: "u2" },
      name: "Ana",
      text: "Subiu a página nova",
    });
    expect(geral?.unread).toBe(3);
  });

  test("Não lidas and the tab badge count channels and DMs with something unread", () => {
    expect(unreadConversations(rows)).toBe(2);
    expect(
      unreadConversationCount({
        channels: [
          channel("c1", "geral", true, { unreadCount: 3 }),
          channel("c2", "marketing", true),
          channel("c3", "secreto", false, { unreadCount: 7 }),
        ],
        dms: [dm("d1", "Dev", 1, 10), dm("d2", "Iris", 0, 20)],
      }),
    ).toBe(2);
  });

  test("after reading a channel its row has nothing unread", () => {
    const read = buildConversations({
      channels: [channel("c1", "geral", true, { unreadCount: 0 })],
      dms: [],
      threads: [],
    });
    expect(unreadConversations(read)).toBe(0);
  });
});

describe("agents at work in the list", () => {
  test("an agent DM says it is working when the agent has a run there; a person DM never does", () => {
    const person: DirectMessage = {
      ...dm("d3", "Ana", 0, 3),
      with: { type: "person", id: "u2", name: "Ana", handle: "ana" },
    };
    const rows = buildConversations({
      channels: [channel("c1", "geral")],
      dms: [dm("d1", "Dev", 0, 10), dm("d2", "Iris", 0, 20), person],
      threads: [],
      workingChannels: new Set(["d1", "d3", "c1"]),
    });
    const working = Object.fromEntries(rows.map((r) => [r.key, r.kind === "dm" ? r.working : null]));
    expect(working).toEqual({ "d:d3": false, "d:d1": true, "d:d2": false, "c:c1": null });
  });

  test("a DM opened with no message yet is on top, by when it began", () => {
    const now = new Date().toISOString();
    const rows = buildConversations({
      channels: [channel("c1", "geral")],
      dms: [dm("d1", "Dev", 0, 10), { ...dm("d2", "Iris", 0, null), openedAt: now }, dm("d3", "Ana", 0, null)],
      threads: [],
    });
    expect(rows.map((r) => r.key)).toEqual(["d:d2", "d:d1", "d:d3", "c:c1"]);
  });

  test("without who is working, nobody is", () => {
    const rows = buildConversations({ channels: [], dms: [dm("d1", "Dev", 0, 10)], threads: [] });
    expect(rows[0]?.kind === "dm" && rows[0].working).toBe(false);
  });
});

describe("Esperando você", () => {
  const mission = (id: string, canAct: boolean, reviews: number, decisions: number) => ({
    id,
    canAct,
    pending: { reviews, decisions },
  });

  test("missions you can act on with something pending, and their items", () => {
    const list = [mission("m1", true, 1, 1), mission("m2", false, 2, 0), mission("m3", true, 0, 0)];
    expect(missionsWaiting(list).map((m) => m.id)).toEqual(["m1"]);
    expect(missionWaitingItems(mission("m", true, 2, 3))).toBe(5);
  });

  test("open agent questions only", () => {
    const items = [
      { id: "1", kind: "agent_question", doneAt: null },
      { id: "2", kind: "agent_question", doneAt: at(1) },
      { id: "3", kind: "mention", doneAt: null },
    ] as const;
    expect(openQuestions([...items]).map((n) => n.id)).toEqual(["1"]);
  });

  test("the count: requests, mission items and questions", () => {
    expect(waitingTotal({ approvals: 2, missions: [mission("m", true, 1, 2)], questions: 1 })).toBe(6);
    expect(waitingTotal({ approvals: 0, missions: [], questions: 0 })).toBe(0);
  });
});

describe("the home by kind", () => {
  const person = (channelId: string, name: string, minutesAgo: number): DirectMessage => ({
    ...dm(channelId, name, 0, minutesAgo),
    with: { type: "person", id: `u-${name}`, name, handle: null },
  });
  const rows = buildConversations({
    channels: [channel("c1", "geral", true, { lastMessage: undefined })],
    dms: [
      ...["A", "B", "C", "D", "E", "F", "G"].map((n, i) => dm(`d${i}`, n, i === 6 ? 2 : 0, (i + 1) * 10)),
      person("p1", "Ana", 15),
    ],
    threads: [
      thread({ id: "t1", title: "Fechamento de setembro", lastActivityAt: at(3) }),
      thread({
        id: "t2",
        lastActivityAt: at(40),
        mission: { id: "m", agentId: "a-A", status: "active", planDone: 1, planTotal: 3, waitingYou: 0 },
      }),
    ],
  });

  test("Agentes, Canais, Pessoas: the first five by latest activity and how many in all; threads stay out", () => {
    const s = homeSections(rows);
    expect(s.map((x) => [x.key, x.total, x.more])).toEqual([
      ["agents", 7, true],
      ["channels", 1, false],
      ["people", 1, false],
    ]);
    expect(s[0]?.rows.map((r) => r.key)).toEqual(["d:d0", "d:d1", "d:d2", "d:d3", "d:d4"]);
    expect(s.flatMap((x) => x.rows).some((r) => r.kind === "thread" || r.kind === "mission")).toBe(false);
  });

  test("empty sections are left out", () => {
    const only = buildConversations({ channels: [], dms: [person("p1", "Ana", 1)], threads: [] });
    expect(homeSections(only).map((x) => x.key)).toEqual(["people"]);
    expect(homeSections([])).toEqual([]);
  });

  test("Agentes leaves out the agents that don't answer me, and who manages agents sees all", () => {
    const agents = [
      { id: "a-A", canTalk: false },
      { id: "a-B", canTalk: true },
    ];
    const dms = [dm("d0", "A", 1, 5), dm("d1", "B", 0, 9), person("p1", "Ana", 1)];
    const member: OrgSummary = { id: "o1", name: "Acme", role: "member", permissions: ["read", "talk_to_agents"] };
    const manager: OrgSummary = { ...member, permissions: ["read", "talk_to_agents", "manage_agents"] };
    expect([...hiddenAgentIds(member, agents)]).toEqual(["a-A"]);
    expect([...hiddenAgentIds(manager, agents)]).toEqual([]);
    const hiddenAgents = (org: OrgSummary) => hiddenAgentIds(org, agents);
    const agentRows = (org: OrgSummary) =>
      homeSections(buildConversations({ channels: [], dms, threads: [], hiddenAgents: hiddenAgents(org) })).map((x) => [
        x.key,
        x.rows.map((r) => r.key),
      ]);
    expect(agentRows(member)).toEqual([
      ["agents", ["d:d1"]],
      ["people", ["d:p1"]],
    ]);
    expect(agentRows(manager)).toEqual([
      ["agents", ["d:d0", "d:d1"]],
      ["people", ["d:p1"]],
    ]);
    // The tab's badge counts what the home lists: A's unread stays out for the member.
    expect(unreadConversationCount({ channels: [], dms, hiddenAgents: hiddenAgents(member) })).toBe(0);
    expect(unreadConversationCount({ channels: [], dms, hiddenAgents: hiddenAgents(manager) })).toBe(1);
  });

  test("the Threads tab: threads and missions by latest activity", () => {
    expect(threadRows(rows).map((r) => [r.key, r.kind])).toEqual([
      ["t:t1", "thread"],
      ["t:t2", "mission"],
    ]);
    expect(threadRows([])).toEqual([]);
  });

  test("the Threads badge counts only its own unread rows (an unread DM is Conversas')", () => {
    expect(unreadThreadCount(rows)).toBe(0);
    const withUnread = rows.map((r) => (r.key === "t:t2" || r.key === "d:d0" ? { ...r, unread: 2 } : r));
    expect(unreadThreadCount(withUnread)).toBe(1);
    expect(unreadThreadCount(withUnread.filter((r) => r.kind !== "mission"))).toBe(0);
  });

  test("a thread's unread replies (threads I follow) come from the server and light its row", () => {
    const built = buildConversations({
      channels: [],
      dms: [],
      threads: [thread({ id: "t9", title: "Deploy", unread: 2 })],
    });
    expect(built[0]?.unread).toBe(2);
    expect(unreadThreadCount(built)).toBe(1);
  });

  test("the pushed lists are the sections' Ver todos; threads are a tab", () => {
    expect(["agents", "channels", "people"].every(isListKind)).toBe(true);
    expect(isListKind("threads")).toBe(false);
    expect(isListKind("nope")).toBe(false);
  });

  test("collapsed sections are remembered as a list; anything unreadable is none", () => {
    expect(parseCollapsed(null)).toEqual([]);
    expect(parseCollapsed("{oops")).toEqual([]);
    expect(parseCollapsed('{"a":1}')).toEqual([]);
    expect(parseCollapsed('["people","x","agents"]')).toEqual(["agents", "people"]);
    expect(toggleCollapsed([], "people")).toEqual(["people"]);
    expect(toggleCollapsed(["people"], "agents")).toEqual(["agents", "people"]);
    expect(toggleCollapsed(["agents", "people"], "agents")).toEqual(["people"]);
  });

  test("collapsed groups of agents take any ids: one workspace's stay when another's change", () => {
    // Workspace A collapses its group a1, then workspace B its b1, on the one remembered list.
    let raw = JSON.stringify(toggleCollapsed(parseCollapsed(null, null), "a1", null));
    raw = JSON.stringify(toggleCollapsed(parseCollapsed(raw, null), "b1", null));
    expect(parseCollapsed(raw, null)).toEqual(["a1", "b1"]);
    expect(toggleCollapsed(parseCollapsed(raw, null), "b1", null)).toEqual(["a1"]);
    expect(parseCollapsed('["a1",2,null]', null)).toEqual(["a1"]);
  });
});

describe("the Esperando você strip", () => {
  const now = Date.parse("2026-10-17T15:00:00.000Z");
  const req = approval({
    id: "ap1",
    agentId: "theo",
    title: "Enviar a campanha",
    threadId: "t-camp",
    createdAt: new Date(now - 14 * 60_000).toISOString(),
    expiresAt: new Date(now + 46 * 60_000).toISOString(),
  });
  const mis = missionOf({
    id: "m1",
    agentId: "dev",
    title: "Migrar o banco",
    channelId: "c9",
    threadId: "t-mis",
    pending: { decisions: 1, provisional: 0, reviews: 2, suggestions: 0, joinRequests: 0, commands: 0 },
  });
  const question = notification({
    id: "n1",
    kind: "agent_question",
    waiting: true,
    actors: [{ type: "agent", id: "nina" }],
    latest: { text: "Qual mês?" },
    source: { channelId: "c3", threadId: "t-q" },
  });
  const items = waitingItems({ approvals: [req], missions: [mis], questions: [question] });

  test("a request first, then a mission, then a question, each opening its own place", () => {
    expect(items.map((i) => [i.kind, i.agentId, i.title, i.href])).toEqual([
      ["approval", "theo", "Enviar a campanha", "/approval/ap1"],
      ["mission", "dev", "Migrar o banco", "/chat/c9?thread=t-mis"],
      ["question", "nina", "Qual mês?", "/chat/c3?thread=t-q"],
    ]);
  });

  test("the count adds each item waiting in a mission, like the old shortcut", () => {
    expect(waitingCount(items)).toBe(5);
    expect(waitingCount(items)).toBe(waitingTotal({ approvals: 1, missions: [mis], questions: 1 }));
  });

  test("the verb and the chip follow the kind", () => {
    expect(items.map((i) => waitingVerbKey(i.kind))).toEqual([
      "mobile.chats.wait.verb.approval",
      "mobile.chats.wait.verb.mission",
      "mobile.chats.wait.verb.question",
    ]);
    expect(waitingChipKey("question")).toBe("mobile.chats.wait.chip.question");
  });

  test("'expira em' only for a request, in minutes", () => {
    expect(items.map((i) => waitingMinutes(i, now))).toEqual([46, null, null]);
  });

  test("the copies behind show only while more waits; 'e mais N' and the next agents' faces", () => {
    const all = waitingStack(items);
    expect(all.first?.key).toBe("a:ap1");
    expect([all.count, all.rest, all.stacked]).toEqual([5, 4, true]);
    expect(all.faces).toEqual(["dev", "nina"]);
    const one = waitingStack(items.slice(0, 1));
    expect([one.count, one.rest, one.stacked, one.faces]).toEqual([1, 0, false, []]);
    const none = waitingStack([]);
    expect([none.first, none.count, none.stacked]).toEqual([null, 0, false]);
  });

  test("the Threads tab keeps what waits in a mission or one of its threads", () => {
    expect(waitingInThreads(items, new Set(["t-q"])).map((i) => i.key)).toEqual(["m:m1", "q:n1"]);
    expect(waitingInThreads(items, new Set(["t-camp", "t-q"])).map((i) => i.key)).toEqual(["a:ap1", "m:m1", "q:n1"]);
  });
});

describe("the Threads tab", () => {
  const ms = (id: string, over: Partial<NonNullable<Parameters<typeof thread>[0]["mission"]>>, working = false) =>
    thread({
      id,
      title: `Missão ${id}`,
      working,
      mission: { id: `m-${id}`, agentId: "theo", status: "active", planDone: 2, planTotal: 5, waitingYou: 0, ...over },
    });
  const rows = buildConversations({
    channels: [],
    dms: [],
    threads: [
      ms("run", {}, true),
      ms("wait", { planDone: 4, planTotal: 9, waitingYou: 2 }),
      ms("paused", { status: "paused", planDone: 3, planTotal: 8 }),
      ms("done", { status: "done", planDone: 10, planTotal: 10 }),
      ms("closing", { status: "awaiting_close", planDone: 6, planTotal: 6 }),
      thread({
        id: "th",
        title: "Fechamento",
        lastMessage: { author: { type: "agent", id: "nina" }, excerpt: "Pronto", createdAt: at(1) },
      }),
    ],
  });
  const byId = (id: string) => {
    const r = rows.find((x) => x.key === `t:${id}`);
    if (!r || (r.kind !== "thread" && r.kind !== "mission")) throw new Error(id);
    return r;
  };

  test("a mission's state: working, waiting on you, paused, done", () => {
    expect(["run", "wait", "paused", "done", "closing"].map((id) => missionState(byId(id)))).toEqual([
      "working",
      "waiting",
      "paused",
      "done",
      "done",
    ]);
    expect(missionState(byId("th"))).toBeNull();
    // needsYou alone also means waiting on you; canceled is its own.
    expect(missionState({ ...byId("paused"), needsYou: true })).toBe("waiting");
    const done = byId("done");
    if (!done.mission) throw new Error("mission");
    expect(missionState({ ...done, mission: { ...done.mission, status: "canceled" } })).toBe("canceled");
  });

  test("a mission row: where, the items and what waits on you as its badge", () => {
    expect(threadRowLines(byId("wait"))).toEqual({
      kind: "mission",
      where: "#produto",
      state: "waiting",
      progress: { done: 4, total: 9 },
      badge: 2,
    });
  });

  test("a thread row: where, no state, its unread as the badge, the last reply's author as the face", () => {
    const r = byId("th");
    expect(threadRowLines(r)).toEqual({ kind: "thread", where: "#produto", state: null, progress: null, badge: 0 });
    expect(threadRowLines({ ...r, unread: 3 }).badge).toBe(3);
    expect(r.face).toEqual({ type: "agent", id: "nina" });
    expect(byId("run").face).toEqual({ type: "person", id: "u1" });
  });

  test("in a DM, a mission says who it is with", () => {
    const r = { ...byId("run"), channelKind: "dm" as const, dmWith: null };
    expect(threadRowLines(r, (w) => (w.id === "theo" ? "Theo" : "")).where).toBe("Theo");
  });

  test("sections: Missões, then Threads; empty ones left out", () => {
    expect(threadSections(rows).map((s) => [s.key, s.rows.length])).toEqual([
      ["missions", 5],
      ["threads", 1],
    ]);
    expect(threadSections(rows.filter((r) => r.kind !== "mission")).map((s) => s.key)).toEqual(["threads"]);
    expect(threadSections([])).toEqual([]);
  });

  test("a finished mission goes after the live ones (the row carries no mark of it)", () => {
    const missions = threadSections(rows).find((s) => s.key === "missions")?.rows ?? [];
    expect(missions.at(-1)?.key).toBe("t:done");
    expect(missions.slice(0, -1).some((r) => r.key === "t:done")).toBe(false);
  });

  test("its collapsed sections are remembered on their own keys", () => {
    expect(parseCollapsed('["threads","agents"]', THREAD_SECTIONS)).toEqual(["threads"]);
    expect(toggleCollapsed(["threads"], "missions", THREAD_SECTIONS)).toEqual(["missions", "threads"]);
  });
});

describe("last-message previews in the reader's language", () => {
  test("a body the server wrote reads like the message itself (pt-BR and en); plain text stays", async () => {
    const away: DirectMessage = {
      ...dm("d1", "Ada", 0, 1),
      lastMessage: {
        id: "m1",
        body: "Claude Code on macbook air is offline. I'll answer when it's back.",
        meta: { bodyCode: "brain_unavailable", bodyParams: { brain: "Claude Code" } },
        createdAt: at(1),
        authorType: "agent",
      },
    };
    const [row] = buildConversations({ channels: [], dms: [away], threads: [] });
    const last = row?.last;
    expect(last?.meta).toMatchObject({ bodyCode: "brain_unavailable" });
    const i18n = i18next.createInstance();
    await i18n.init({ lng: "pt-BR", fallbackLng: "pt-BR", resources });
    expect(previewBody(i18n.t, last?.text ?? "", last?.meta ?? null)).toBe(
      "O Claude Code não está disponível agora. Respondo quando ele voltar.",
    );
    await i18n.changeLanguage("en");
    expect(previewBody(i18n.t, last?.text ?? "", last?.meta ?? null)).toBe(
      "Claude Code can't answer right now. I'll answer when it's back.",
    );
    // A channel's preview carries it too; a plain message is shown as is.
    const [ch] = buildConversations({
      channels: [
        channel("c1", "tech", true, {
          lastMessage: {
            id: "m2",
            authorType: "agent",
            authorId: "ada",
            authorName: "Ada",
            preview: "Claude Code on macbook air is offline.",
            meta: { bodyCode: "brain_unavailable", bodyParams: { brain: "Claude Code" } },
            createdAt: at(1),
          },
        }),
      ],
      dms: [],
      threads: [],
    });
    expect(previewBody(i18n.t, ch?.last?.text ?? "", ch?.last?.meta ?? null)).toBe(
      "Claude Code can't answer right now. I'll answer when it's back.",
    );
    expect(previewBody(i18n.t, "Feito! Já anotei.", null)).toBe("Feito! Já anotei.");
  });

  test("a task's end names its computer only where the workspace has more than one; a preview never does", async () => {
    const i18n = i18next.createInstance();
    await i18n.init({ lng: "pt-BR", fallbackLng: "pt-BR", resources });
    const done = {
      bodyCode: "machine_task_done",
      bodyParams: { title: "Rodar os testes", computer: "Computador da Acme", seconds: "120" },
    };
    const english = 'Task "Rodar os testes" finished on Computador da Acme.';
    expect(serverBody(i18n.t, english, done)).toBe("“Rodar os testes” terminou.");
    expect(serverBody(i18n.t, english, done, undefined, true)).toBe(
      "“Rodar os testes” terminou no Computador da Acme.",
    );
    expect(previewBody(i18n.t, english, done)).toBe("“Rodar os testes” terminou.");
    const plan = { bodyCode: "mission_plan", bodyParams: { title: "App", computer: "Computador da Acme" } };
    expect(serverBody(i18n.t, 'Plan for "App"', plan)).toBe("Plano para “App”");
    // A computer that is the news itself keeps its name.
    const back = { bodyCode: "machine_task_resumed", bodyParams: { title: "App", computer: "MacBook" } };
    expect(serverBody(i18n.t, "…", back)).toBe("MacBook voltou: “App” retomou de onde parou.");
    await i18n.changeLanguage("en");
    expect(serverBody(i18n.t, english, done)).toBe("“Rodar os testes” finished.");
  });
});

describe("unread marks, as on the web", () => {
  test("a muted channel never looks unread; its mentions of me still count", () => {
    const channels = [
      channel("c1", "geral", true, { unreadCount: 4, mentionCount: 1 }),
      channel("c2", "ruido", true, { unreadCount: 9, mentionCount: 2, muted: true }),
    ];
    const rows = buildConversations({ channels, dms: [], threads: [] });
    expect(rows.map((r) => (r.kind === "channel" ? [r.name, r.unread, r.mentions] : null))).toEqual([
      ["geral", 4, 1],
      ["ruido", 0, 2],
    ]);
    expect(unreadConversationCount({ channels, dms: [] })).toBe(1);
  });

  test("a group conversation shows its number: mentions of me in red (even muted), else how many wait", () => {
    const channels = [
      channel("c1", "geral", true, { unreadCount: 4, mentionCount: 1 }),
      channel("c2", "lojas", true, { unreadCount: 9, mentionCount: 0 }),
      channel("c3", "ruido", true, { unreadCount: 9, mentionCount: 2, muted: true }),
      channel("c4", "quieto", true, { unreadCount: 5, mentionCount: 0, muted: true }),
    ];
    const rows = buildConversations({ channels, dms: [dm("d1", "Atlas", 3, 1)], threads: [] });
    const byName = Object.fromEntries(rows.map((r) => [rowName(r), rowBadge(r)]));
    expect(byName).toEqual({
      geral: { count: 1, mention: true },
      lojas: { count: 9, mention: false },
      ruido: { count: 2, mention: true },
      quieto: { count: 0, mention: false },
      Atlas: { count: 3, mention: false },
    });
  });

  test("the app icon's number: DM messages and mentions of me, DMs the home hides left out", () => {
    const channels = [channel("c1", "geral", true, { unreadCount: 30, mentionCount: 2 })];
    const dms = [dm("d1", "Atlas", 3, 1), dm("d2", "Hidden", 5, 1)];
    expect(appBadgeCount({ channels, dms })).toBe(10);
    expect(appBadgeCount({ channels, dms, hiddenAgents: new Set(["a-Hidden"]) })).toBe(5);
  });
});

describe("the app icon's number", () => {
  test("goes back to 0 when the app's stack goes away (signed out)", async () => {
    const src = await Bun.file(new URL("../../src/features/shared/queries.ts", import.meta.url)).text();
    const hook = src.slice(src.indexOf("export function useAppIconBadge"));
    expect(hook).toContain("() => () => void Notifications.setBadgeCountAsync(0)");
  });
});

import { describe, expect, test } from "bun:test";
import { light as lightTokens } from "@agenteschat/tokens";
import { nextRoutine, sortWaiting, upcomingDay, waitingCardOf } from "../../src/features/activity/logic";
import type { WorkItem } from "../../src/features/agents/logic";
import type { ConversationRow } from "../../src/features/chats/logic";
import {
  agentRowState,
  confirmFinished,
  endedWork,
  type FinishedItem,
  finishedFromInbox,
  finishedKey,
  greetingLine,
  keepFinished,
  latestFinished,
} from "../../src/features/chats/now";
import { chatHref, notificationHref } from "../../src/features/links/logic";
import { appColors, appShadows } from "../../src/ui/palette";
import { countStyle, weights } from "../../src/ui/type-scale";
import { at, notification } from "./fixtures";

const NOW = new Date(2026, 9, 17, 15, 0);

const work = (key: string, agentId: string, over: Partial<WorkItem> = {}): WorkItem => ({
  key,
  agentId,
  kind: "run",
  what: "Corrige o login com Google",
  channelId: "d1",
  threadId: null,
  where: { kind: "dm", name: null },
  missionId: null,
  plan: null,
  since: at(30),
  waiting: false,
  ...over,
});

const dm = (channelId: string, agentId: string, over: Partial<Extract<ConversationRow, { kind: "dm" }>> = {}) =>
  ({
    kind: "dm",
    key: `d:${channelId}`,
    channelId,
    with: { type: "agent", id: agentId, name: agentId },
    last: { author: { type: "agent", id: agentId }, text: "Pronto, abri o PR #128." },
    at: at(5),
    unread: 2,
    working: false,
    ...over,
  }) as ConversationRow;

describe("an agent's row says what matters", () => {
  test("waiting on you wins over working; it carries the exact request", () => {
    const state = agentRowState(
      "theo",
      "d1",
      [work("r:1", "theo")],
      [{ agentId: "theo", kind: "approval", title: "Fazer merge do PR #128 em main" }],
    );
    expect(state).toEqual({ kind: "waiting", wait: "approval", title: "Fazer merge do PR #128 em main" });
  });

  test("working: the item in this conversation first, else the agent's first", () => {
    const here = work("r:2", "nina", { channelId: "d2" });
    const elsewhere = work("r:3", "nina", { channelId: "c9" });
    expect(agentRowState("nina", "d2", [elsewhere, here], [])).toEqual({ kind: "working", work: here });
    expect(agentRowState("nina", "d7", [elsewhere, here], [])).toEqual({ kind: "working", work: elsewhere });
  });

  test("nothing to say: null (the last message shows)", () => {
    expect(
      agentRowState("iris", "d3", [work("r:1", "theo")], [{ agentId: "theo", kind: "question", title: "?" }]),
    ).toBe(null);
  });
});

describe("what finished", () => {
  test("ended work: items in progress before and not now", () => {
    const a = work("r:1", "theo");
    const b = work("r:2", "nina");
    expect(endedWork([a, b], [b]).map((w) => w.key)).toEqual(["r:1"]);
    expect(endedWork([], [a])).toEqual([]);
  });

  test("finished only when the agent answered there after it started, and it is still unread", () => {
    const ended = work("r:1", "theo", { since: at(30) });
    const found = confirmFinished([ended], [dm("d1", "theo")]);
    expect(found).toEqual([
      {
        key: "r:1",
        agentId: "theo",
        kind: "run",
        what: "Corrige o login com Google",
        at: at(5),
        href: "/chat/d1",
      },
    ]);
    // A failed or stopped run leaves no answer: the last word is someone else's, or older than the work.
    expect(confirmFinished([ended], [dm("d1", "theo", { last: { author: null, text: "e aí?" } })])).toEqual([]);
    expect(confirmFinished([ended], [dm("d1", "theo", { at: at(60) })])).toEqual([]);
    // Already read: no news.
    expect(confirmFinished([ended], [dm("d1", "theo", { unread: 0 })])).toEqual([]);
    // It said its computer is away: it waits for it, it didn't finish.
    const away = { author: { type: "agent" as const, id: "theo" }, text: "x", meta: { bodyCode: "brain_unavailable" } };
    expect(confirmFinished([ended], [dm("d1", "theo", { last: away })])).toEqual([]);
  });

  test("a run in a thread is confirmed by the thread's row and opens the thread", () => {
    const ended = work("r:4", "theo", { channelId: "c1", threadId: "t1" });
    const row = {
      kind: "thread",
      key: "t:t1",
      channelId: "c1",
      threadId: "t1",
      title: "Login",
      channelName: "produto",
      channelKind: "channel",
      dmWith: null,
      closed: false,
      working: false,
      needsYou: false,
      face: { type: "agent", id: "theo" },
      last: { author: { type: "agent", id: "theo" }, text: "Feito." },
      at: at(2),
      unread: 0,
      mission: null,
    } as ConversationRow;
    expect(confirmFinished([ended], [row]).map((f) => f.href)).toEqual(["/chat/c1?thread=t1"]);
  });

  test("missions and routines finished come from the unread inbox, by an agent", () => {
    const items = [
      notification({
        id: "n1",
        kind: "mission_finished",
        actors: [{ type: "agent", id: "dev" }],
        source: { missionId: "m1", label: "Lançar a página de preços" },
      }),
      notification({
        id: "n2",
        kind: "routine_finished",
        actors: [{ type: "agent", id: "iris" }],
        source: { routineId: "x1", label: "Saúde dos servidores" },
        readAt: at(1),
      }),
      notification({ id: "n3", kind: "mention" }),
    ];
    expect(finishedFromInbox(items)).toEqual([
      {
        key: "n:n1",
        agentId: "dev",
        kind: "mission",
        what: "Lançar a página de preços",
        at: at(20),
        href: "/mission/m1",
      },
    ]);
  });

  test("the newest fresh one that wasn't tapped", () => {
    const f = (key: string, minutesAgo: number): FinishedItem => ({
      key,
      agentId: "theo",
      kind: "run",
      what: null,
      at: at(minutesAgo),
      href: null,
    });
    const now = NOW.getTime();
    const list = [f("a", 10), f("b", 2), f("c", 500)];
    expect(latestFinished(list, new Set(), now)?.key).toBe("b");
    expect(latestFinished(list, new Set(["b"]), now)?.key).toBe("a");
    expect(latestFinished([f("c", 500)], new Set(), now)).toBe(null);
    expect(keepFinished([f("a", 10)], [f("b", 2), f("a", 10)]).map((x) => x.key)).toEqual(["b", "a"]);
  });

  test("the greeting's line and the finished phrase", () => {
    const f: FinishedItem = { key: "a", agentId: "theo", kind: "run", what: "Login", at: at(1), href: null };
    expect(greetingLine(f, 2)).toEqual({ kind: "finished", finished: f, working: 2 });
    expect(greetingLine(null, 2)).toEqual({ kind: "working", working: 2 });
    expect(greetingLine(null, 0)).toEqual({ kind: "idle" });
    expect(finishedKey(f)).toBe("mobile.homeNow.finished.run");
    expect(finishedKey({ kind: "mission", what: "X" })).toBe("mobile.homeNow.finished.mission");
    expect(finishedKey({ kind: "routine", what: null })).toBe("mobile.homeNow.finished.plain");
  });
});

describe("Atividade: cards and what comes next", () => {
  test("a request: its exact action, its deadline, Revisar", () => {
    const expiresAt = at(-40);
    const card = waitingCardOf(
      notification({ id: "n1", kind: "approval", latest: { title: "Fazer merge do PR #128 em main", expiresAt } }),
    );
    expect(card).toEqual({ kind: "approval", title: "Fazer merge do PR #128 em main", expiresAt, action: "review" });
  });

  test("a question: Responder, no deadline", () => {
    expect(
      waitingCardOf(notification({ id: "n2", kind: "agent_question", latest: { text: "Devolvo o reembolso?" } })),
    ).toEqual({ kind: "question", title: "Devolvo o reembolso?", expiresAt: null, action: "answer" });
  });

  test("someone asking to join: the newest name (no actor, not a member yet), Revisar, after the rest", () => {
    const join = notification({
      id: "j",
      kind: "join_request",
      waiting: true,
      actors: [],
      count: 2,
      latest: { title: "Ana Souza" },
      updatedAt: at(1),
    });
    expect(waitingCardOf(join)).toEqual({ kind: "join", title: "Ana Souza", expiresAt: null, action: "review" });
    const approval = notification({ id: "a", kind: "approval", waiting: true, updatedAt: at(30) });
    const question = notification({ id: "q", kind: "agent_question", waiting: true, updatedAt: at(60) });
    expect(sortWaiting([join, approval, question]).map((n) => n.id)).toEqual(["q", "a", "j"]);
  });

  test("an agent waiting for a secret: its name and what for, its deadline, Abrir (typed in its card), on top", () => {
    const expiresAt = at(-12);
    const secret = notification({
      id: "s",
      kind: "secret_request",
      waiting: true,
      actors: [{ type: "agent", id: "theo" }],
      source: { channelId: "c1", threadId: "t1", messageId: "m1" },
      latest: { title: "NPM_TOKEN", text: "publicar o pacote", expiresAt },
      updatedAt: at(90),
    });
    expect(waitingCardOf(secret)).toEqual({
      kind: "secret",
      title: "NPM_TOKEN · publicar o pacote",
      expiresAt,
      action: "open",
    });
    // Its conversation opens, at the thread it was asked in, at its card.
    expect(notificationHref(secret)).toBe(chatHref("c1", "t1", "m1"));
    const question = notification({ id: "q", kind: "agent_question", waiting: true, updatedAt: at(1) });
    const approval = notification({ id: "a", kind: "approval", waiting: true, updatedAt: at(2) });
    expect(sortWaiting([approval, question, secret]).map((n) => n.id)).toEqual(["s", "q", "a"]);
  });

  test("the next routine: active, ahead, the soonest", () => {
    const now = NOW.getTime();
    const r = (id: string, minutesAhead: number | null, active = true) => ({
      id,
      active,
      nextRunAt: minutesAhead === null ? null : at(-minutesAhead, NOW),
    });
    expect(nextRoutine([r("a", 180), r("b", 60), r("c", 10, false), r("d", null), r("e", -5)], now)?.id).toBe("b");
    expect(nextRoutine([r("c", 10, false)], now)).toBe(null);
  });

  test("when the next event is: today, tomorrow, later", () => {
    expect(upcomingDay(new Date(2026, 9, 17, 18, 0).toISOString(), NOW)).toBe("today");
    expect(upcomingDay(new Date(2026, 9, 18, 9, 0).toISOString(), NOW)).toBe("tomorrow");
    expect(upcomingDay(new Date(2026, 9, 21, 9, 0).toISOString(), NOW)).toBe("later");
  });
});

describe("the native look", () => {
  test("light: white lists, grouped gray apart, darker secondary text, amber for waiting", () => {
    const c = appColors("light");
    expect(c.bg).toBe("#ffffff");
    expect(c.raised).toBe("#ffffff");
    expect(c.grouped).toBe("#f2f2f7");
    expect(c.muted).toBe("#48484d");
    expect(c.amber).toBe("#b26a00");
    // What it doesn't change stays the tokens' (the agent blue, danger).
    expect(c.agent).toBe(lightTokens.agent);
    expect(c.danger).toBe(lightTokens.danger);
  });

  test("dark stays the tokens' (grouped is the background)", () => {
    const c = appColors("dark");
    expect(c.grouped).toBe(c.bg);
    expect(c.bubble).toBe(c.raised);
    expect(appShadows("dark").e1.length).toBeGreaterThan(0);
  });

  test("light elevations are a hairline and a short shadow", () => {
    expect(appShadows("light").e1.at(-1)?.spread).toBe(0.5);
  });

  test("counts: system font, semibold, tabular figures (no Doto)", () => {
    const s = countStyle(14);
    expect(s).toEqual({ fontSize: 14, lineHeight: 17, fontWeight: weights.semibold, fontVariant: ["tabular-nums"] });
    expect("fontFamily" in s).toBe(false);
  });
});

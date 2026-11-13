import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import type { RunConsultation } from "../src/api/types";
import {
  asExchanges,
  consultAskedKey,
  consultBlocksNearEnd,
  consultGroupSummary,
  consultLineKey,
  consultLineState,
  consultLineTarget,
  consultNoticeFolds,
  consultOriginKey,
  consultPair,
  consultSeconds,
  consultsForLine,
  EXCHANGE_GAP_MS,
  exchangeIds,
  firstOfRun,
  foldsNotice,
  groupsByRun,
  pairItemOf,
  shownConsultations,
} from "../src/lib/consult-group";
import { consultTimeText } from "../src/lib/consultations";

const T0 = Date.parse("2026-10-29T10:00:00Z");
const iso = (s: number) => new Date(T0 + s * 1000).toISOString();

const q = (over: Partial<RunConsultation> = {}): RunConsultation => ({
  id: "q1",
  runId: "r1",
  agentId: "lia",
  consultedAgentId: "theo",
  consultedRunId: "r-theo",
  status: "open",
  waiting: null,
  question: "How are rates today?",
  answer: null,
  createdAt: iso(0),
  answeredAt: null,
  expiresAt: iso(900),
  ...over,
});

describe("consultLineState", () => {
  const now = T0 + 60_000;
  test("open: working, or waiting on a person", () => {
    expect(consultLineState(q(), now)).toBe("working");
    expect(consultLineState(q({ waiting: "approval" }), now)).toBe("waiting");
    expect(consultLineState(q({ waiting: "input" }), now)).toBe("waiting");
  });
  test("open, waiting for its computer to come back: still out, not on a person", () => {
    expect(consultLineState(q({ waiting: "computer" }), now)).toBe("offline");
    expect(consultLineState(q({ waiting: "computer" }), T0 + 901_000)).toBe("expired");
  });
  test("open, parked because its AI provider is down: still out, not working and not on a person", () => {
    expect(consultLineState(q({ waiting: "outage" }), now)).toBe("offline");
    expect(consultLineKey("offline", q({ waiting: "outage" }))).toBe("chat.consultGroup.waitingProvider");
  });
  test("open past its deadline reads as expired before the worker closes it", () => {
    expect(consultLineState(q(), T0 + 901_000)).toBe("expired");
  });
  test("closed: answered (with words), failed, expired", () => {
    expect(consultLineState(q({ status: "answered", answer: "Up 6 bp" }), now)).toBe("answered");
    expect(consultLineState(q({ status: "answered", answer: "  " }), now)).toBe("failed");
    expect(consultLineState(q({ status: "failed", answer: "no reply" }), now)).toBe("failed");
    expect(consultLineState(q({ status: "expired" }), now)).toBe("expired");
  });
  test("open, its part done, on what it handed to other agents: still out, on no person", () => {
    expect(consultLineState(q({ waiting: "agents" }), now)).toBe("handedOn");
    expect(consultGroupSummary([q({ waiting: "agents" })], now)).toMatchObject({ open: true, waiting: false });
  });
});

describe("the words of a block, by what its run asked or handed off (ADR 0095)", () => {
  const note = (over: Partial<RunConsultation> = {}) => q({ kind: "note", ...over });
  test("each line by its state; only a note that couldn't finish says so its own way", () => {
    expect(consultLineKey("working", note())).toBe("chat.consultGroup.working");
    expect(consultLineKey("waiting", note({ waiting: "approval" }))).toBe("chat.consultGroup.waitingApproval");
    expect(consultLineKey("waiting", note({ waiting: "input" }))).toBe("chat.consultGroup.waitingInput");
    expect(consultLineKey("offline", note())).toBe("chat.consultGroup.waitingComputer");
    expect(consultLineKey("handedOn", note())).toBe("chat.consultGroup.waitingAgents");
    expect(consultLineKey("answered", note())).toBe("chat.consultation.answered");
    expect(consultLineKey("expired", note())).toBe("chat.consultation.expired");
    expect(consultLineKey("failed", note())).toBe("chat.consultation.failedNote");
    expect(consultLineKey("failed", q())).toBe("chat.consultation.failed");
  });
  test("what was asked or handed, and where it came from", () => {
    expect(consultAskedKey(note())).toBe("chat.consultation.wrote");
    expect(consultAskedKey(q())).toBe("chat.consultation.asked");
    expect(consultOriginKey(note(), true)).toBe("chat.consultPanel.originNote");
    expect(consultOriginKey(note(), false)).toBe("chat.consultPanel.originNoteDm");
    expect(consultOriginKey(q(), true)).toBe("chat.consultPanel.origin");
    expect(consultOriginKey(q(), false)).toBe("chat.consultPanel.originDm");
  });
});

describe("groupsByRun", () => {
  test("by the asking run, each run's oldest first", () => {
    const groups = groupsByRun([
      q({ id: "b", createdAt: iso(5) }),
      q({ id: "x", runId: "r2" }),
      q({ id: "a", createdAt: iso(1) }),
    ]);
    expect([...groups.keys()]).toEqual(["r1", "r2"]);
    expect(groups.get("r1")?.map((c) => c.id)).toEqual(["a", "b"]);
  });
});

describe("an exchange between two agents: one row, one conversation", () => {
  // Lia asks Theo, Theo hands Lia a note while answering, Lia hands Theo a note into that same run: three asking runs.
  const exchange = [
    q({ id: "ask", runId: "r1", status: "answered", answer: "ok", answeredAt: iso(187) }),
    q({
      id: "back",
      kind: "note",
      runId: "r2",
      agentId: "theo",
      consultedAgentId: "lia",
      status: "answered",
      answer: "ok",
      createdAt: iso(41),
      answeredAt: iso(97),
    }),
    q({
      id: "into",
      kind: "note",
      runId: "r3",
      status: "answered",
      answer: "ok",
      createdAt: iso(55),
      answeredAt: iso(187),
    }),
  ];

  test("its questions draw on the first asking run's reply, with the whole exchange's time and the other face", () => {
    const groups = groupsByRun(asExchanges(exchange));
    expect([...groups.keys()]).toEqual(["r1"]);
    expect(groups.get("r1")?.map((c) => c.id)).toEqual(["ask", "back", "into"]);
    const pair = consultPair(groups.get("r1") ?? [], T0 + 300_000, "lia");
    expect(pair?.faces).toEqual([{ agentId: "theo", off: false }]);
    expect(pair?.seconds).toBe(187);
  });

  test("its row opens all of it, whichever question opens it", () => {
    expect(exchangeIds(exchange, "into")).toEqual(["ask", "back", "into"]);
    expect(exchangeIds(exchange, "missing")).toEqual(["missing"]);
  });

  test("another pair, or the same pair a while after it ended, is its own row", () => {
    const later = q({ id: "later", runId: "r4", createdAt: iso(187 + EXCHANGE_GAP_MS / 1000 + 1) });
    const others = q({ id: "others", runId: "r5", agentId: "lia", consultedAgentId: "rio", createdAt: iso(60) });
    const groups = groupsByRun(asExchanges([...exchange, later, others]));
    expect([...groups.keys()].sort()).toEqual(["r1", "r4", "r5"]);
    // While one is still out, the next between the same two joins it.
    const open = q({ id: "open", runId: "r6", createdAt: iso(1000) });
    const joins = q({ id: "joins", runId: "r7", agentId: "theo", consultedAgentId: "lia", createdAt: iso(5000) });
    expect(asExchanges([open, joins]).map((c) => c.runId)).toEqual(["r6", "r6"]);
  });
});

describe("consultGroupSummary", () => {
  test("counts what came back and whether some question is still out", () => {
    const now = T0 + 60_000;
    const s = consultGroupSummary(
      [
        q({ id: "1", status: "answered", answer: "A" }),
        q({ id: "2", status: "failed" }),
        q({ id: "3", waiting: "approval" }),
        q({ id: "4" }),
      ],
      now,
    );
    expect(s).toEqual({ total: 4, closed: 2, answered: 1, open: true, waiting: true });
    expect(consultGroupSummary([q({ status: "answered", answer: "A" })], now)).toMatchObject({
      closed: 1,
      open: false,
      waiting: false,
    });
  });
  test("an agent waiting for its computer keeps the question out, but no one is waited on", () => {
    const now = T0 + 60_000;
    expect(consultGroupSummary([q({ waiting: "computer" })], now)).toEqual({
      total: 1,
      closed: 0,
      answered: 0,
      open: true,
      waiting: false,
    });
  });
});

describe("foldsNotice", () => {
  const notice = (consultationId?: string) => ({
    notice: { kind: "consult_reply", text: "…", refs: consultationId ? { consultationId } : {} },
  });
  test("a consult_reply whose question a reply here shows", () => {
    expect(foldsNotice(notice("q1"), new Set(["q1"]))).toBe(true);
    expect(foldsNotice(notice("q9"), new Set(["q1"]))).toBe(false);
    expect(foldsNotice(notice(), new Set(["q1"]))).toBe(false);
  });
  test("other notices and plain messages never fold", () => {
    const note = { notice: { kind: "agent_note", text: "hi", refs: { consultationId: "q1" } } };
    expect(foldsNotice(note, new Set(["q1"]))).toBe(false);
    expect(foldsNotice(undefined, new Set(["q1"]))).toBe(false);
  });
});

describe("shownConsultations", () => {
  test("only the questions of runs with a reply in view", () => {
    const list = [q({ id: "a", runId: "r1" }), q({ id: "b", runId: "r2" })];
    expect([...shownConsultations(list, new Set(["r1"]))]).toEqual(["a"]);
    expect(shownConsultations(list, new Set()).size).toBe(0);
  });
});

describe("consultSeconds", () => {
  test("until it closed, or until now while open", () => {
    expect(consultSeconds(q({ status: "answered", answeredAt: iso(80) }), T0 + 999_000)).toBe(80);
    expect(consultSeconds(q(), T0 + 12_400)).toBe(12);
  });
});

describe("firstOfRun", () => {
  test("the run's earliest message, whatever the list's order", () => {
    const list = [
      { id: "m3", agentRunId: "r1", createdAt: iso(30) },
      { id: "m1", agentRunId: "r1", createdAt: iso(10) },
      { id: "m2", agentRunId: "r2", createdAt: iso(1) },
    ];
    expect(firstOfRun(list, "r1")).toBe("m1");
    expect(firstOfRun(list, "r9")).toBeNull();
  });
});

describe("consultLineTarget ('Ver' on the phone)", () => {
  const fold = { fold: "line" as const, consultation: q(), messageId: "m3" };
  test("the run's first message, which draws its block, not the one nearest the notice", () => {
    const shown = [
      { id: "m1", agentRunId: "r1", createdAt: iso(10) },
      { id: "x", agentRunId: null, createdAt: iso(20) },
      { id: "m3", agentRunId: "r1", createdAt: iso(30) },
    ];
    expect(consultLineTarget(shown, fold)).toBe("m1");
  });
  test("none of the run's messages shown: the one the fold names", () => {
    expect(consultLineTarget([{ id: "x", agentRunId: "r2", createdAt: iso(1) }], fold)).toBe("m3");
  });
});

// Rows as the conversation draws them: the reply that asked (run r1), others' messages, the answers' notices.
const asked = (id = "ask", runId = "r1") => ({ id, agentRunId: runId });
const said = (id: string) => ({ id, agentRunId: null });
const answerOf = (id: string, consultationId = "q1") => ({
  id,
  agentRunId: null,
  meta: { notice: { kind: "consult_reply", text: "…", refs: { consultationId, runId: "r1" } } },
});

describe("consultNoticeFolds", () => {
  const list = [q({ status: "answered", answer: "Up 6 bp", answeredAt: iso(80) })];

  test("the reply that asked close above: the notice folds away", () => {
    expect(consultNoticeFolds([asked(), answerOf("n1")], list).get("n1")).toEqual({ fold: "hide" });
    // Two messages between them: still close (CONSULT_NEAR_ROWS).
    expect(consultNoticeFolds([asked(), said("a"), said("b"), answerOf("n1")], list).get("n1")).toEqual({
      fold: "hide",
    });
  });

  test("farther up: one line that leads to it", () => {
    const folds = consultNoticeFolds([asked(), said("a"), said("b"), said("c"), answerOf("n1")], list);
    expect(folds.get("n1")).toEqual({ fold: "line", consultation: list[0] as RunConsultation, messageId: "ask" });
  });

  test("the reply isn't loaded, or the question isn't in the list: the notice keeps its card", () => {
    expect(consultNoticeFolds([said("a"), answerOf("n1")], list).get("n1")).toEqual({ fold: "card" });
    expect(consultNoticeFolds([asked(), answerOf("n1", "q9")], list).get("n1")).toEqual({ fold: "card" });
    expect(consultNoticeFolds([asked(), answerOf("n1")], []).get("n1")).toEqual({ fold: "card" });
  });

  test("a live block is at the end, under everything: its answers fold", () => {
    const rows = [answerOf("n1"), said("a"), said("b"), said("c"), said("d")];
    expect(consultNoticeFolds(rows, list, new Set(["r1"])).get("n1")).toEqual({ fold: "hide" });
  });

  test("answers to several questions in a row don't push their reply away; only notices are listed", () => {
    const four = ["q1", "q2", "q3", "q4"].map((id) => q({ id, status: "answered", answer: "ok" }));
    const rows = [asked(), ...four.map((c, i) => answerOf(`n${i}`, c.id))];
    const folds = consultNoticeFolds(rows, four);
    expect([...folds.values()].map((f) => f.fold)).toEqual(["hide", "hide", "hide", "hide"]);
    expect(folds.has("ask")).toBe(false);
  });

  test("a run that posted several messages: only the one that draws the block counts (web last, phone first)", () => {
    const rows = [asked("first"), said("a"), said("b"), said("c"), said("d"), answerOf("n1")];
    // The web draws the block on the run's last message: a later one right after the notice is close.
    expect(consultNoticeFolds([...rows, asked("later")], list).get("n1")).toEqual({ fold: "hide" });
    const after = [...rows, said("e"), said("f"), said("g"), asked("later")];
    expect(consultNoticeFolds(after, list).get("n1")).toMatchObject({ fold: "line", messageId: "later" });
    // The phone draws it on the first: far up, whatever came later; "Ver" goes to that first message.
    expect(consultNoticeFolds([...rows, asked("later")], list, undefined, "first").get("n1")).toMatchObject({
      fold: "line",
      messageId: "first",
    });
  });

  test("the working line: near the end means the message that draws the block", () => {
    const rows = [asked("first"), said("a"), said("b"), said("c"), asked("later")];
    expect([...consultBlocksNearEnd(rows, list)]).toEqual(["r1"]);
    expect(consultBlocksNearEnd(rows, list, undefined, "first").size).toBe(0);
  });
});

describe("consultBlocksNearEnd", () => {
  const list = [q()];

  test("a reply that asked among the last rows, or a live block", () => {
    expect([...consultBlocksNearEnd([said("a"), asked()], list)]).toEqual(["r1"]);
    expect([...consultBlocksNearEnd([asked(), said("a"), said("b")], list)]).toEqual(["r1"]);
    expect(consultBlocksNearEnd([asked(), said("a"), said("b"), said("c")], list).size).toBe(0);
    expect([...consultBlocksNearEnd([said("a")], list, new Set(["r1"]))]).toEqual(["r1"]);
  });

  test("only runs that asked something; an answer it shows takes no row", () => {
    expect(consultBlocksNearEnd([asked("x", "r2")], list).size).toBe(0);
    expect(consultBlocksNearEnd([said("a")], list, new Set(["r2"])).size).toBe(0);
    const answered = [q({ status: "answered", answer: "ok" })];
    expect([...consultBlocksNearEnd([asked(), said("a"), said("b"), answerOf("n1")], answered)]).toEqual(["r1"]);
  });
});

describe("consultsForLine", () => {
  test("the working line leaves out the runs whose block near the end shows their questions", () => {
    const live = [
      { runId: "r1", agentId: "lia" },
      { runId: "r2", agentId: "dev" },
    ];
    expect(consultsForLine(live, new Set(["r1"]))).toEqual([{ runId: "r2", agentId: "dev" }]);
    expect(consultsForLine(live, new Set())).toBe(live);
  });
});

describe("consultPair (the row before the reply)", () => {
  const now = T0 + 42_000;
  test("one question answered: the two agents and how long it took, no word", () => {
    const pair = consultPair([q({ status: "answered", answer: "Up 6 bp", answeredAt: iso(120) })], now);
    expect(pair).toEqual({
      faces: [{ agentId: "theo", off: false }],
      opens: "q1",
      word: null,
      tone: null,
      seconds: 120,
    });
  });
  test("still out: a short word by where it is and the clock since it went out", () => {
    expect(consultPair([q()], now)).toMatchObject({
      word: { key: "chat.consultPair.asking" },
      tone: "live",
      seconds: 42,
    });
    expect(consultPair([q({ kind: "note" })], now)?.word?.key).toBe("chat.consultPair.working");
    expect(consultPair([q({ waiting: "approval" })], now)?.word?.key).toBe("chat.consultPair.waitingApproval");
    expect(consultPair([q({ waiting: "input" })], now)?.word?.key).toBe("chat.consultPair.waitingInput");
    expect(consultPair([q({ waiting: "computer" })], now)?.word?.key).toBe("chat.consultPair.waitingComputer");
    expect(consultPair([q({ waiting: "outage" })], now)?.word?.key).toBe("chat.consultPair.waitingProvider");
    expect(consultPair([q({ waiting: "agents" })], now)?.word?.key).toBe("chat.consultPair.handedOn");
  });
  test("unanswered: 'não respondeu' (a note: 'não terminou'), its face dimmed, no time", () => {
    expect(consultPair([q({ status: "expired" })], now)).toEqual({
      faces: [{ agentId: "theo", off: true }],
      opens: "q1",
      word: { key: "chat.consultPair.noAnswer" },
      tone: "bad",
      seconds: null,
    });
    expect(consultPair([q({ kind: "note", status: "failed" })], now)?.word?.key).toBe("chat.consultPair.notFinished");
  });
  test("several fold into one row: each agent once, the count while out, the whole span once in", () => {
    const three = [
      q({ id: "a", consultedAgentId: "atlas", status: "answered", answer: "A", answeredAt: iso(30) }),
      q({ id: "b", consultedAgentId: "iris", createdAt: iso(5) }),
      q({ id: "c", consultedAgentId: "rio", createdAt: iso(10) }),
    ];
    expect(consultPair(three, now)).toMatchObject({
      faces: [
        { agentId: "atlas", off: false },
        { agentId: "iris", off: false },
        { agentId: "rio", off: false },
      ],
      // The first still out opens.
      opens: "b",
      word: { key: "chat.consultGroup.progress", values: { done: 1, total: 3 } },
      tone: "live",
      seconds: 42,
    });
    const done = [
      q({ id: "a", consultedAgentId: "atlas", status: "answered", answer: "A", answeredAt: iso(30) }),
      q({ id: "b", consultedAgentId: "iris", status: "answered", answer: "B", answeredAt: iso(240) }),
    ];
    expect(consultPair(done, now)).toMatchObject({ opens: "a", word: null, tone: null, seconds: 240 });
    const some = [done[0], q({ id: "b", consultedAgentId: "iris", status: "failed" })] as RunConsultation[];
    expect(consultPair(some, now)).toMatchObject({
      faces: [
        { agentId: "atlas", off: false },
        { agentId: "iris", off: true },
      ],
      word: { key: "chat.consultPair.someAnswered", values: { done: 1, total: 2 } },
      tone: "bad",
      seconds: null,
    });
  });
  test("a reply's `meta.consulted` entry: closed, no times", () => {
    const item = pairItemOf({ agentId: "theo", consultationId: "k1", status: "answered", question: "?", answer: "!" });
    expect(consultPair([item], now)).toEqual({
      faces: [{ agentId: "theo", off: false }],
      opens: "k1",
      word: null,
      tone: null,
      seconds: null,
    });
    expect(consultPair([], now)).toBeNull();
  });
});

test("a row's time: its clock while it's out, how long it took once it's back, in hours past the first", () => {
  const t = ((key: string, values: { time: string }) => `${key} ${values.time}`) as unknown as TFunction;
  expect(consultTimeText(t, "en", true, 42)).toBe("42 s");
  expect(consultTimeText(t, "en", false, 1446 * 60)).toBe("chat.consultPair.took 24 h");
});

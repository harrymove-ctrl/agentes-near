import { describe, expect, test } from "bun:test";
import type { LiveConsult, LiveRun, LiveWork, Message, RunConsultation, SecretRequest } from "@agenteschat/client";
import { activitySentence, barElapsed, barFaces, barWords } from "@agenteschat/client/lib/activity";
import { questionWaitsOn } from "@agenteschat/client/lib/agent-questions";
import { runAround, runPosition } from "@agenteschat/client/lib/chat";
import { consultBlocksNearEnd, consultsForLine } from "@agenteschat/client/lib/consult-group";
import { formatInt } from "@agenteschat/client/lib/format";
import { issueTakenOf, issueWorkOf } from "@agenteschat/client/lib/issues";
import {
  latestSecret,
  secretClosedBy,
  secretLabel,
  secretRefusalKey,
  secretRequestOf,
  secretValueProblem,
  secretWhere,
} from "@agenteschat/client/lib/secret-requests";
import { secretOutcome } from "@agenteschat/client/lib/secret-words";
import { toolCalls, toolNow, toolPhrase, toolWhy } from "@agenteschat/client/lib/work";
import {
  AGENT_WORDS_MIN,
  artifactsOf,
  awayRun,
  buildRows,
  consultationsOf,
  eventLineOf,
  hangsUnder,
  hidesBody,
  type LineWords,
  leavingWords,
  lineFit,
  lineStops,
  markedParts,
  markName,
  mayStopRun,
  mentionTint,
  mergeTimeline,
  missionCardRef,
  missionPlanOf,
  narrowDrawn,
  PHRASE_FADE_MS,
  type PhraseTurn,
  parseBlocks,
  parseInline,
  parseSlash,
  questionOf,
  reactionEmoji,
  reactionName,
  reactionPills,
  readMark,
  standsAlone,
  stoppableInLine,
  TABLE_COL_MAX,
  TABLE_COL_MIN,
  tableColumnWidths,
  tableHidden,
  threadFaces,
  threadTitleFrom,
  turnPhrase,
  workingEntries,
  workStepsOf,
} from "../../src/features/chat/logic";
import {
  outputTail,
  recentTurn,
  rememberTurn,
  stepLimitOf,
  stoppedOf,
  turnItems,
  turnOpener,
  turnRuns,
  turnSignature,
  withContinued,
  withOpacity,
} from "../../src/features/chat/turn";
import { pacedClock } from "../../src/features/shared/logic";
import { at, message, translator } from "./fixtures";

/** A screen's source, for the wiring a test can't render (React Native). */
const source = (path: string) => Bun.file(new URL(`../../src/${path}`, import.meta.url).pathname).text();

describe("timeline", () => {
  test("top-level messages and loaded thread replies, in time order, no duplicates", () => {
    const a = message({ id: "a", createdAt: at(10) });
    const b = message({ id: "b", createdAt: at(8), threadId: "a", author: { type: "agent", id: "dev" } });
    const c = message({ id: "c", createdAt: at(5) });
    expect(mergeTimeline([a, c], [[b, a]]).map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  test("a reply to a message starts its own block, and the next one groups under it", () => {
    const quote = { replyTo: { messageId: "1", excerpt: "oi", author: { type: "person", id: "u" } } };
    const rows = buildRows([message({ id: "1" }), message({ id: "2", meta: quote }), message({ id: "3" })]).flatMap(
      (r) => (r.kind === "message" ? [[r.message.id, r.grouped]] : []),
    );
    expect(rows).toEqual([
      ["1", false],
      ["2", false],
      ["3", true],
    ]);
  });

  test("same author within 5 minutes groups; a day starts a new group; cards stand alone", () => {
    const rows = buildRows([
      message({ id: "1", createdAt: "2026-10-16T12:00:00.000Z" }),
      message({ id: "2", createdAt: "2026-10-17T12:00:00.000Z" }),
      message({ id: "3", createdAt: "2026-10-17T12:02:00.000Z" }),
      message({ id: "4", createdAt: "2026-10-17T12:03:00.000Z", meta: { approvalId: "ap1" } }),
      message({ id: "5", createdAt: "2026-10-17T12:04:00.000Z" }),
      message({ id: "6", createdAt: "2026-10-17T12:20:00.000Z" }),
    ]);
    const shape = rows.map((r) => (r.kind === "day" ? "day" : `${r.message.id}${r.grouped ? "+" : ""}`));
    expect(shape).toEqual(["day", "1", "day", "2", "3+", "4", "5", "6"]);
  });

  test("a run of one author's rows: start, mid, end, and solo for one alone (my bubbles' corners and time)", () => {
    const rows = buildRows([
      message({ id: "1", createdAt: "2026-10-17T12:00:00.000Z" }),
      message({ id: "2", createdAt: "2026-10-17T12:01:00.000Z" }),
      message({ id: "3", createdAt: "2026-10-17T12:02:00.000Z" }),
      message({ id: "4", createdAt: "2026-10-17T12:03:00.000Z", author: { type: "agent", id: "dev" } }),
      message({ id: "5", createdAt: "2026-10-17T12:04:00.000Z" }),
      message({ id: "6", createdAt: "2026-10-17T12:20:00.000Z" }),
      message({ id: "7", createdAt: "2026-10-17T12:21:00.000Z" }),
    ]);
    const runs = rows.flatMap((r) =>
      r.kind === "message" ? [`${r.message.id}:${runPosition(r.grouped, r.continued ?? false)}`] : [],
    );
    expect(runs).toEqual(["1:start", "2:mid", "3:end", "4:solo", "5:solo", "6:start", "7:end"]);
    expect([
      runPosition(false, false),
      runPosition(false, true),
      runPosition(true, true),
      runPosition(true, false),
    ]).toEqual(["solo", "start", "mid", "end"]);
  });

  test("what hangs under a bubble (reactions, a thread, files, a send in flight) cuts the run there", () => {
    const rows = buildRows([
      message({ id: "1", createdAt: "2026-10-17T12:00:00.000Z" }),
      message({
        id: "2",
        createdAt: "2026-10-17T12:01:00.000Z",
        reactions: [{ reaction: "+1", count: 1, userIds: ["joao"] }] as Message["reactions"],
      }),
      message({ id: "3", createdAt: "2026-10-17T12:02:00.000Z" }),
      message({ id: "4", createdAt: "2026-10-17T12:03:00.000Z" }),
    ]);
    const runs = rows.flatMap((r) =>
      r.kind === "message"
        ? [
            runAround(
              runPosition(r.grouped, r.continued ?? false),
              r.above ? hangsUnder(r.above, false, undefined, "me") : false,
              hangsUnder(r.message, false, undefined, "me"),
            ),
          ]
        : [],
    );
    expect(runs).toEqual(["start", "end", "start", "end"]);
    const plain = message({ id: "5" });
    expect([
      hangsUnder(plain, false, undefined, "me"),
      hangsUnder(plain, true, undefined, "me"),
      hangsUnder({ ...plain, local: "pending" } as Message, false, undefined, "me"),
      hangsUnder(plain, false, [{ reaction: "+1", count: 1, userIds: ["joao"] }] as Message["reactions"], "me"),
    ]).toEqual([false, true, true, true]);
    expect(runAround("mid", true, true)).toBe("solo");
  });

  test("my row takes its place in the run: the bubble's corners and the time under the run's last", async () => {
    expect(await source("features/chat/ChatScreen.tsx")).toContain(
      "run={runPosition(item.grouped, item.continued ?? false)}",
    );
    const row = await source("features/chat/MessageRow.tsx");
    expect(row).toContain("BUBBLE_RUN[run]");
    expect(row).toContain('(run === "end" || run === "solo")');
  });

  test("reading marks read up to the message posted last, wherever its place, and counts a reply placed above as new", async () => {
    const screen = await source("features/chat/ChatScreen.tsx");
    expect(screen).toContain("const postedNow = useMemo(() => lastPostedId(list), [list]);");
    expect(screen).toContain("if (peeking || !member || !postedNow) return;");
    expect(screen).toContain("unseenBelow(scrollRows, seenKey, seenPostedId)");
  });

  test("hidden messages leave no row", () => {
    const rows = buildRows([message({ id: "1" }), message({ id: "2", threadId: "t" })], (m) => m.threadId === "t");
    expect(rows.filter((r) => r.kind === "message")).toHaveLength(1);
  });

  test("a notice only its agent reads (a proposal's result, a note, a wait's result) leaves no row", () => {
    const agent = { type: "agent" as const, id: "dev" };
    const notice = (id: string, kind: string) =>
      message({ id, author: agent, meta: { notice: { kind, text: "ana created it: @caio (Caio)." } } });
    const rows = buildRows([
      message({ id: "1" }),
      notice("2", "proposal_result"),
      notice("3", "agent_note"),
      notice("4", "wait_result"),
      notice("5", "routine_handoff"),
    ]);
    expect(rows.flatMap((r) => (r.kind === "message" ? [r.message.id] : []))).toEqual(["1", "5"]);
  });
});

describe("what a message carries", () => {
  test("consultations, keeping only well-formed ones", () => {
    const meta = {
      consulted: [
        { agentId: "infra", consultationId: "k1", status: "answered", question: "Livre?", answer: "Livre." },
        { agentId: "infra", status: "answered", question: "E?", answer: "  " },
        { status: "answered" },
        "nope",
      ],
    };
    const list = consultationsOf(meta);
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({
      agentId: "infra",
      consultationId: "k1",
      status: "answered",
      question: "Livre?",
      answer: "Livre.",
    });
    // Answered with nothing to show reads as "couldn't answer".
    expect(list[1]?.status).toBe("failed");
  });

  test("mission cards, plan, steps and files", () => {
    expect(missionCardRef({ missionReview: { id: "r1", missionId: "m1" } }, "missionReview")).toEqual({
      id: "r1",
      missionId: "m1",
    });
    expect(missionCardRef({ missionReview: { id: "r1" } }, "missionReview")).toBeNull();
    expect(missionPlanOf({ missionPlan: { missionId: "m1", title: "App", goal: "Fazer" } })).toEqual({
      missionId: "m1",
      title: "App",
      goal: "Fazer",
    });
    expect(workStepsOf({ work: { steps: 3, connectors: [] } })).toBe(3);
    expect(workStepsOf({ work: { steps: 0 } })).toBeNull();
    expect(
      artifactsOf({ artifacts: [{ id: "f1", version: 2, title: "Relatório" }, { id: "f2", deleted: true }, {}] }),
    ).toEqual([
      { id: "f1", version: 2, title: "Relatório", deleted: false },
      { id: "f2", title: "", deleted: true },
    ]);
  });
});

describe("working line", () => {
  const run = (over: Partial<LiveRun> & { runId: string; agentId: string }): LiveRun => ({
    channelId: "c1",
    threadId: "m1",
    status: "thinking",
    ...over,
  });
  const names: Record<string, string> = { atlas: "Atlas", ada: "Ada", infra: "Infra" };
  const name = (id: string) => names[id] ?? id;

  test("one entry per agent: a provisional row plus the real run, or two runs, show one face", () => {
    const entries = workingEntries(
      [
        run({ runId: "pending:atlas:m1", agentId: "atlas", provisional: true }),
        run({ runId: "r1", agentId: "atlas", threadId: "m2", status: "running", tool: "sentry_list_issues" }),
        run({ runId: "r2", agentId: "ada" }),
      ],
      [],
      name,
    );
    expect(entries.map((e) => e.id)).toEqual(["atlas", "ada"]);
  });

  test("an agent asking another is one entry (with its consult), not also a working run", () => {
    const consult: LiveConsult = {
      runId: "r1",
      agentId: "atlas",
      consultedAgentId: "infra",
      channelId: "c1",
      threadId: "m1",
      status: "asking",
      since: 1,
      at: 1,
    };
    const entries = workingEntries([run({ runId: "r1", agentId: "atlas" })], [consult], name);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.consult).toMatchObject({ to: "infra", toName: "Infra", status: "asking" });
  });

  test("a question its reply shows near the end leaves the line; farther up, the line still says it", () => {
    const consult: LiveConsult = {
      runId: "r1",
      agentId: "atlas",
      consultedAgentId: "infra",
      channelId: "c1",
      threadId: "m1",
      status: "asking",
      since: 1,
      at: 1,
    };
    const asked: RunConsultation = {
      id: "q1",
      runId: "r1",
      agentId: "atlas",
      consultedAgentId: "infra",
      consultedRunId: "r-infra",
      status: "open",
      waiting: null,
      question: "Como está o deploy?",
      answer: null,
      createdAt: at(5),
      answeredAt: null,
      expiresAt: at(-10),
    };
    // The phone's rows: saved replies only (a turn at work doesn't show its questions yet).
    const reply = message({ id: "m-ask", author: { type: "agent", id: "atlas" }, agentRunId: "r1" });
    const near = consultBlocksNearEnd([message({ id: "m0" }), reply], [asked]);
    // Atlas at work on a new turn: its own entry, not the question.
    const entries = workingEntries([run({ runId: "r2", agentId: "atlas" })], consultsForLine([consult], near), name);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.consult).toBeUndefined();
    const far = consultBlocksNearEnd([reply, ...["a", "b", "c"].map((id) => message({ id }))], [asked]);
    expect(workingEntries([], consultsForLine([consult], far), name)[0]?.consult?.status).toBe("asking");
  });

  test("a writing agent stays on the line ('escrevendo'); failed and waiting runs leave it", () => {
    const entries = workingEntries(
      [
        run({ runId: "w", agentId: "atlas", status: "running" }),
        run({ runId: "f", agentId: "ada", status: "failed" }),
        run({ runId: "a", agentId: "infra", status: "waiting_approval" }),
      ],
      [],
      name,
    );
    expect(entries.map((e) => [e.id, e.activity.kind])).toEqual([["atlas", "writing"]]);
  });

  test("the tool step comes through (what it is doing, as on the web)", () => {
    const [e] = workingEntries([run({ runId: "r", agentId: "atlas", tool: "sentry_list_issues" })], [], name);
    expect(e?.activity).toEqual({ kind: "consulting", app: "Sentry" });
  });

  test("people typing join the one line after the agents, with three faces at most (as on the web)", async () => {
    const t = await translator("pt-BR");
    const people: Record<string, string> = { u1: "Marina", u2: "Bia", u3: "Caio" };
    const personName = (id: string) => people[id];
    const agents = ["atlas", "ada", "infra"].map((agentId) => run({ runId: `r-${agentId}`, agentId }));
    // Someone the directory doesn't know (gone from the workspace) isn't named.
    const entries = workingEntries(agents, [], name, ["u1", "u2", "u3", "gone"], personName);
    expect(entries.map((e) => `${e.type}:${e.id}`)).toEqual([
      "agent:atlas",
      "agent:ada",
      "agent:infra",
      "person:u1",
      "person:u2",
      "person:u3",
    ]);
    expect(activitySentence(t, entries)).toBe("Atlas e mais 2 estão trabalhando · Marina e mais 2 estão digitando…");
    expect(barFaces(entries).map((e) => e.id)).toEqual(["atlas", "ada", "u1"]);
    expect(activitySentence(t, workingEntries([], [], name, ["u1"], personName))).toBe("Marina está digitando…");
  });

  test("beside a long name typing, the agents' words give way first and leave whole when only a sliver would show", async () => {
    const t = await translator("en");
    const people: Record<string, string> = { u1: "Maria Fernanda Albuquerque" };
    const entries = workingEntries([run({ runId: "r", agentId: "ada" })], [], name, ["u1"], (id) => people[id]);
    // The shared pieces, in the order they give way: the agents' words (and their " · "), then the names.
    expect(barWords(t, entries)).toEqual(["Ada is working", " · ", "Maria Fernanda Albuquerque", " is typing…"]);
    // What iOS drew of each: a cut-off "A" beside someone typing leaves, " · " with it.
    expect(lineFit({ agents: 4.7, typers: 170.3 }, true)).toEqual({ agents: null, typers: 171 });
    expect(lineFit({ agents: AGENT_WORDS_MIN }, true).agents).toBe(AGENT_WORDS_MIN);
    // Alone on the line they are all it says: never dropped, and nothing follows them to keep close to.
    expect(lineFit({ agents: 4.7 }, false)).toEqual({});
  });

  test("a piece cut short keeps to what it drew, so the next comes right after its '…' (no gap)", () => {
    // "Theo and 3…" drew 74.5 of a 79.3 box: kept to 75, " · " follows it.
    expect(lineFit({ agents: 74.51 }, true)).toEqual({ agents: 75, typers: undefined });
    // It only narrows: kept to its "…" it draws the same again, and a narrower room cuts it again.
    const drawn = narrowDrawn({}, "agents", 74.51);
    expect(narrowDrawn(drawn, "agents", 74.51)).toBe(drawn);
    expect(narrowDrawn(drawn, "agents", 80)).toBe(drawn);
    expect(narrowDrawn(drawn, "agents", 60)).toEqual({ agents: 60 });
    expect(narrowDrawn(drawn, "typers", 100)).toEqual({ agents: 74.51, typers: 100 });
  });

  test("the phrase turns as on the web: only the one shown and the one leaving are drawn, each shown whole", () => {
    const words = (agents: string): LineWords => [agents, "", "", ""];
    const drawn = ({ was, now }: PhraseTurn) => [was, now].flatMap((w) => (w ? [w[0]] : []));
    const first: PhraseTurn = { now: words("Ada is working…"), was: null, n: 0, since: 1_000 };
    // A fast tool's start turns it...
    const searching = turnPhrase(first, words("Ada is searching memory…"), 5_000);
    expect(searching.wait).toBe(0);
    expect(drawn(searching.shown)).toEqual(["Ada is working…", "Ada is searching memory…"]);
    // ...its end 30 ms later, and the next tool's start and end, wait while that phrase comes in.
    for (const [next, at] of [
      ["Ada is working…", 5_030],
      ["Ada is running code…", 5_060],
      ["Ada is working…", 5_090],
    ] as const) {
      const held = turnPhrase(searching.shown, words(next), at);
      expect(held.shown).toBe(searching.shown);
      expect(held.wait).toBe(5_000 + PHRASE_FADE_MS - at);
    }
    // Shown whole, it leaves for the newest words, and the first phrase is gone: never three.
    const back = turnPhrase(searching.shown, words("Ada is working…"), 5_000 + PHRASE_FADE_MS);
    expect(back.wait).toBe(0);
    expect(drawn(back.shown)).toEqual(["Ada is searching memory…", "Ada is working…"]);
    expect(back.shown.n).toBe(2);
    expect(turnPhrase(back.shown, words("Ada is working…"), 9_000)).toEqual({ shown: back.shown, wait: 0 });
  });

  test("a leaving phrase is drawn only during its crossfade, never under Reduce Motion, so it can't come back whole", () => {
    const words = (agents: string): LineWords => [agents, "", "", ""];
    const turned: PhraseTurn = {
      now: words("Ada is working…"),
      was: words("Ada is checking GitHub…"),
      n: 3,
      since: 2_000,
    };
    expect(leavingWords(turned, false, 2_000)).toEqual(words("Ada is checking GitHub…"));
    expect(leavingWords(turned, false, 2_000 + PHRASE_FADE_MS - 1)).toEqual(words("Ada is checking GitHub…"));
    // Over: turning Reduce Motion off later mounts nothing over the phrase shown.
    expect(leavingWords(turned, false, 2_000 + PHRASE_FADE_MS)).toBeNull();
    expect(leavingWords(turned, false, 9_000)).toBeNull();
    // Reduce Motion swaps plainly: nothing leaving, even mid-crossfade.
    expect(leavingWords(turned, true, 2_100)).toBeNull();
    expect(leavingWords({ ...turned, was: null }, false, 2_100)).toBeNull();
  });

  test("one agent on its own shows how long it has been at it, as on the web; several, or a question out, don't", async () => {
    const [pt, en] = await Promise.all([translator("pt-BR"), translator("en")]);
    const now = 1_000_000;
    const ada = run({ runId: "r", agentId: "ada", status: "running", startedAt: now - 16_400 });
    const one = workingEntries([ada], [], name);
    expect(barElapsed(pt, one, [ada], now)).toBe("16 s");
    expect(barElapsed(en, one, [ada], now)).toBe("16s");
    expect(barElapsed(pt, one, [ada], now + 49_000)).toBe("1 min 5 s");
    expect(barElapsed(en, one, [ada], now - 15_000)).toBeNull();
    // Someone typing beside it doesn't take its time away, nor does a turn of its own that failed before.
    const typing = workingEntries([ada], [], name, ["u1"], () => "Marina");
    expect(barElapsed(en, typing, [ada], now)).toBe("16s");
    const failed = run({ runId: "r0", agentId: "ada", status: "failed", startedAt: now - 90_000 });
    expect(barElapsed(en, workingEntries([failed, ada], [], name), [failed, ada], now)).toBe("16s");
    const atlas = run({ runId: "r2", agentId: "atlas", status: "running", startedAt: now - 30_000 });
    expect(barElapsed(en, workingEntries([ada, atlas], [], name), [ada, atlas], now)).toBeNull();
    const asking: LiveConsult = {
      runId: "r",
      agentId: "ada",
      consultedAgentId: "infra",
      channelId: "c1",
      threadId: "m1",
      status: "asking",
      since: now - 5_000,
      at: now - 5_000,
    };
    expect(barElapsed(en, workingEntries([ada], [asking], name), [ada], now)).toBeNull();
  });

  test("left on its own mid-turn, an agent's seconds are right from the first draw and step evenly: one clock, read afresh as the line narrows", async () => {
    const en = await translator("en");
    const U = 1_000_000;
    const ada = run({ runId: "r", agentId: "ada", status: "running", startedAt: U - 148_700 });
    // Atlas is done. With two at work the clock moved once a minute, so it can be 50 s old: the new pace reads it afresh.
    const alone = workingEntries([ada], [], name);
    let clock = pacedClock({ every: 60_000, now: U - 50_000 }, 1000, U);
    const shown = [{ at: U, took: barElapsed(en, alone, [ada], clock.now) }];
    expect(shown[0]?.took).toBe("2m 28s");
    // Each second its interval reads the time; an event redraws the line in between (every 2.6 s here).
    const reads = Array.from({ length: 12 }, (_, k) => U + 4 + (k + 1) * 1000);
    const turns = Array.from({ length: 4 }, (_, k) => U + 4 + (k + 1) * 2600);
    for (const at of [...reads, ...turns].sort((a, b) => a - b)) {
      clock = reads.includes(at) ? { every: 1000, now: at } : pacedClock(clock, 1000, at);
      const took = barElapsed(en, alone, [ada], clock.now);
      if (took !== shown.at(-1)?.took) shown.push({ at, took });
    }
    expect(shown.slice(1, -1).map((s, i) => (shown[i + 2]?.at ?? 0) - s.at)).toEqual(Array(11).fill(1000));
    // The line shows that clock, never a time read at each draw.
    const lines = await source("features/chat/LiveRows.tsx");
    const line = lines.slice(lines.indexOf("export function WorkingLine("), lines.indexOf("type LinePiece"));
    expect(line).toContain("const now = useNow(asking || solo ? 1000 : 60_000);");
    expect(line).not.toContain("Date.now()");
  });

  test("one agent on its own: the line says its name, its face opening the line", async () => {
    const en = await translator("en");
    const ada = run({ runId: "r", agentId: "ada" });
    const atlas = run({ runId: "s", agentId: "atlas" });
    expect(barWords(en, workingEntries([ada], [], name), markName)[0]).toBe(markName("Ada"));
    expect(barWords(en, workingEntries([ada, atlas], [], name))[0]).toBe("Ada and Atlas are working…");
    // The agents at work lead it with their faces (no orbit).
    const lines = await source("features/chat/LiveRows.tsx");
    const line = lines.slice(lines.indexOf("export function WorkingLine("), lines.indexOf("type LinePiece"));
    expect(line).toContain("const faces = barFaces(entries);");
    expect(line).not.toContain("PixelOrbit");
  });

  test("the line speaks for one agent at work: its step, its time right after it, and its stop", async () => {
    const en = await translator("en");
    const now = 1_000_000;
    const ada = run({ runId: "r", agentId: "ada", status: "running", startedAt: now - 16_000 });
    const atlas = run({ runId: "s", agentId: "atlas", status: "running" });
    const alone = workingEntries([ada], [], name);
    expect(awayRun(alone, [ada])?.runId).toBe("r");
    expect(barElapsed(en, alone, [ada], now)).toBe("16s");
    expect(lineStops(alone, [ada], () => true).map((r) => r.runId)).toEqual(["r"]);
    // Two agents at work: the line can't say whose time or stop.
    const both = workingEntries([ada, atlas], [], name);
    expect(awayRun(both, [ada, atlas])).toBeUndefined();
    expect(lineStops(both, [ada, atlas], () => true)).toEqual([]);
    // The step takes its own width, so its time follows the words instead of floating after a fixed gap; short of room
    // it gives way first. The name is never cut: no line cap, no width cap, it wraps.
    const lines = await source("features/chat/LiveRows.tsx");
    expect(lines).toContain("barStep: { flexShrink: 1000, minWidth: 0 },");
    expect(lines).toContain("awayName: { flexShrink: 1 },");
    const away = lines.slice(lines.indexOf("function AwayStep("), lines.indexOf("const TURN"));
    expect(away.slice(0, away.indexOf("{name}"))).not.toContain("numberOfLines");
    // No "Ver": no row to go back to while it works. "Parar", the word, is the one stop: the composer keeps only its send.
    const line = lines.slice(lines.indexOf("export function WorkingLine("), lines.indexOf("type LinePiece"));
    expect(line).not.toContain("seeable");
    expect(line).toContain("const stopHere = stop?.runs ?? [];");
    expect(line).toContain('<LineStop runs={stopHere} onStop={stop.onStop} place="word" />');
    const screen = await source("features/chat/ChatScreen.tsx");
    expect(screen).toContain(
      "const working = useMemo<ComposerWorking | null>(() => (busyRuns.length === 0 ? null : {}), [busyRuns]);",
    );
  });

  test("no row of its own while it works, writing or not: the line speaks; the reply rises in whole once posted", async () => {
    const lines = await source("features/chat/LiveRows.tsx");
    expect(lines).not.toContain("TurnRow");
    expect(lines).not.toContain("RevealText");
    expect(lines).not.toContain("WaitLine");
    const screen = await source("features/chat/ChatScreen.tsx");
    expect(screen).not.toContain('kind: "run"');
    expect(screen).toContain("entering={isFresh(item.key) ? ENTER : undefined}");
    // 24 points drawn, 44 to the finger.
    expect(lines).toContain("hitSlop={10}");
  });

  test("Parar: real runs at work, also while they write (not a guess, not one waiting)", () => {
    const list = stoppableInLine([
      run({ runId: "p", agentId: "atlas", provisional: true }),
      run({ runId: "r", agentId: "atlas", status: "running" }),
      run({ runId: "w", agentId: "ada", status: "running" }),
      run({ runId: "a", agentId: "infra", status: "waiting_approval" }),
      run({ runId: "s", agentId: "infra", status: "failed" }),
    ]);
    expect(list.map((r) => r.runId)).toEqual(["r", "w"]);
  });

  test("who may stop: admins, the agent's owner, or who sent the message that started it", () => {
    const r = run({ runId: "r", agentId: "atlas", triggerMessageId: "m1" });
    const messages = [message({ id: "m1", author: { type: "person", id: "me" } })];
    const base = { meId: "me", manageAgents: false, agentOwnerId: null, messages: [] as Message[] };
    expect(mayStopRun(r, base)).toBe(false);
    expect(mayStopRun(r, { ...base, manageAgents: true })).toBe(true);
    expect(mayStopRun(r, { ...base, agentOwnerId: "me" })).toBe(true);
    expect(mayStopRun(r, { ...base, messages })).toBe(true);
    expect(mayStopRun(r, { ...base, meId: "other", messages })).toBe(false);
  });

  test("names come back bold from the marked sentence", () => {
    expect(markedParts(`${markName("Atlas")} está trabalhando…`)).toEqual([
      { text: "Atlas", bold: true },
      { text: " está trabalhando…", bold: false },
    ]);
    expect(markedParts(`${markName("Theo")} e ${markName("Iris")}`)).toEqual([
      { text: "Theo", bold: true },
      { text: " e ", bold: false },
      { text: "Iris", bold: true },
    ]);
  });
});

describe("routine messages", () => {
  const atlas = { type: "agent" as const, id: "atlas" };
  const told = { routine: { id: "rt1", name: "Erros do Sentry", runId: "rr1", noticeId: "rep" } };

  test("a routine's call written as its creator is left out; only the agent's answer shows", () => {
    const call = message({ id: "call", body: "@atlas Verificar no Sentry…", meta: told, createdAt: at(10) });
    const answer = message({ id: "ans", threadId: "call", author: atlas, createdAt: at(9) });
    const rows = buildRows([call, answer]);
    expect(rows.filter((r) => r.kind === "message").map((r) => (r.kind === "message" ? r.message.id : ""))).toEqual([
      "ans",
    ]);
  });

  test("what a routine found stands alone with its own header; the report it answers folds into it", () => {
    const before = message({ id: "a", author: atlas, createdAt: at(10) });
    const report = message({
      id: "rep",
      author: atlas,
      meta: { notice: { kind: "routine_handoff", text: "3 erros", refs: { routineName: "Erros do Sentry" } } },
      createdAt: at(9),
    });
    const routine = message({ id: "b", author: atlas, meta: told, createdAt: at(8) });
    const after = message({ id: "c", author: atlas, createdAt: at(7) });
    const rows = buildRows([before, report, routine, after]).flatMap((r) =>
      r.kind === "message" ? [[r.message.id, r.grouped] as const] : [],
    );
    expect(rows).toEqual([
      ["a", false],
      ["b", false],
      ["c", false],
    ]);
    expect(standsAlone(routine)).toBe(true);
    // Without its answer, the report is still there, as its line.
    expect(buildRows([report]).filter((r) => r.kind === "message")).toHaveLength(1);
  });
});

describe("reactions", () => {
  test("👍 and 👎 travel by name", () => {
    expect(reactionEmoji("+1")).toBe("👍");
    expect(reactionName("👍")).toBe("+1");
    expect(reactionName("🎉")).toBe("🎉");
  });
  test("people's pills count people; agents show their faces; mine is marked", () => {
    const pills = reactionPills(
      [
        { reaction: "🎉", count: 1, userIds: [], agentIds: ["nina"] },
        { reaction: "+1", count: 2, userIds: ["me", "ana"] },
        { reaction: "👀", count: 0, userIds: [] },
      ],
      "me",
    );
    expect(pills).toEqual([
      { reaction: "🎉", emoji: "🎉", people: 0, agentIds: ["nina"], mine: false },
      { reaction: "+1", emoji: "👍", people: 2, agentIds: [], mine: true },
    ]);
  });
  test("every count reads as the person's language writes it (1.284), a capped one too (99+)", async () => {
    expect(formatInt("pt-BR", 1284)).toBe("1.284");
    const count = await source("ui/Count.tsx");
    expect(count).toContain("formatInt(i18n.language, value)");
    expect(count).toContain("formatInt(i18n.language, max)}+");
  });
});

describe("composer", () => {
  test("the send button pops in on the glyph it shows: its value is born with it, never left by the last button", async () => {
    const composer = await source("ui/Composer.tsx");
    const box = composer.slice(composer.indexOf("export function Composer("), composer.indexOf("function SendButton("));
    // The box keeps no glyph of its own: one kept there would be the send arrow's whenever a button hid, so a stop
    // square popping in would grow as the arrow first.
    expect(box).not.toContain("useSharedValue");
    expect(box).toMatch(/\{button \? \(\s*<SendButton/);
    expect(composer.slice(composer.indexOf("function SendButton("))).toContain(
      "const mode = useSharedValue(stop ? 1 : 0);",
    );
  });

  test("slash commands stay English identifiers", () => {
    expect(parseSlash("/mission Página de preços nova")).toEqual({ command: "mission", arg: "Página de preços nova" });
    expect(parseSlash("  /summary ")).toEqual({ command: "summary", arg: "" });
    expect(parseSlash("/missão x")).toBeNull();
    expect(parseSlash("/unknown")).toBeNull();
    expect(parseSlash("oi /mission")).toBeNull();
  });
  test("a thread's title from its first words", () => {
    expect(threadTitleFrom("Achei a causa: o Google mudou o endereço de retorno.")).toBe(
      "Achei a causa: o Google mudou",
    );
  });
  test("thread faces: distinct, known, at most two", () => {
    expect(
      threadFaces([
        { type: "person", id: "u1" },
        { type: "person", id: "u1" },
        { type: "agent", id: null },
        { type: "agent", id: "dev" },
        { type: "person", id: "u2" },
      ]),
    ).toEqual([
      { type: "person", id: "u1" },
      { type: "agent", id: "dev" },
    ]);
  });
});

describe("markdown", () => {
  test("inline marks, links, mentions", () => {
    expect(parseInline("Oi @theo, veja **isto** e `npm i` em [docs](https://x)")).toEqual([
      { kind: "text", text: "Oi " },
      { kind: "mention", text: "@theo" },
      { kind: "text", text: ", veja " },
      { kind: "bold", text: "isto" },
      { kind: "text", text: " e " },
      { kind: "code", text: "npm i" },
      { kind: "text", text: " em " },
      { kind: "link", text: "docs", href: "https://x" },
    ]);
    expect(parseInline("e-mail ana@x.com não é menção")).toEqual([
      { kind: "text", text: "e-mail ana@x.com não é menção" },
    ]);
  });
  test("bare addresses are links, without trailing punctuation; only web and e-mail open", () => {
    expect(parseInline("Aqui: https://github.com/acme/app/pull/76.")).toEqual([
      { kind: "text", text: "Aqui: " },
      { kind: "link", text: "https://github.com/acme/app/pull/76", href: "https://github.com/acme/app/pull/76" },
      { kind: "text", text: "." },
    ]);
    expect(parseInline("(veja https://x.com/a_b_c)")).toEqual([
      { kind: "text", text: "(veja " },
      { kind: "link", text: "https://x.com/a_b_c", href: "https://x.com/a_b_c" },
      { kind: "text", text: ")" },
    ]);
    expect(parseInline("[x](ftp://h) e ![logo](https://x/l.png) e `https://y`")).toEqual([
      { kind: "text", text: "x e logo e " },
      { kind: "code", text: "https://y" },
    ]);
  });
  test("blocks: paragraphs, lists, headings, quotes, code", () => {
    const blocks = parseBlocks(
      "# Título\nLinha um\nlinha dois\n\n- item\n2. outro\n> citação\n```ts\nconst a = 1;\n```",
    );
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "paragraph", "bullet", "bullet", "quote", "code"]);
    expect(blocks[1]).toEqual({ kind: "paragraph", inline: [{ kind: "text", text: "Linha um\nlinha dois" }] });
    expect(blocks[3]).toMatchObject({ kind: "bullet", ordinal: "2" });
    expect(blocks[5]).toEqual({ kind: "code", lang: "ts", text: "const a = 1;" });
  });
  test("blocks: <details> is one collapsed block whose body stays Markdown; a fenced one is code (ADR 0147)", () => {
    const blocks = parseBlocks(
      "Falta dar acesso.\n<details>\n<summary>Detalhes</summary>\n\nO app recebeu `403`.\n```\n</details>\n```\n</details>\nPronto.",
    );
    expect(blocks.map((b) => b.kind)).toEqual(["paragraph", "details", "paragraph"]);
    expect(blocks[1]).toEqual({
      kind: "details",
      summary: [{ kind: "text", text: "Detalhes" }],
      body: "O app recebeu `403`.\n```\n</details>\n```",
    });
    expect(parseBlocks("```\n<details>\n```").map((b) => b.kind)).toEqual(["code"]);
    // Still being written: it runs to the end.
    expect(parseBlocks("<details><summary>Mais</summary>\nlinha")).toEqual([
      { kind: "details", summary: [{ kind: "text", text: "Mais" }], body: "linha" },
    ]);
  });
  test("blocks: a fence never closed runs to the end as code; a fence still opening is hidden", () => {
    expect(parseBlocks('Aqui:\n```chart\n{"type":"bar","ti')).toEqual([
      { kind: "paragraph", inline: [{ kind: "text", text: "Aqui:" }] },
      { kind: "code", lang: "chart", text: '{"type":"bar","ti' },
    ]);
    expect(parseBlocks("```ts\nconst a = 1;\n``").at(-1)).toEqual({
      kind: "code",
      lang: "ts",
      text: "const a = 1;",
    });
    expect(parseBlocks("Aqui:\n```cha")).toEqual([{ kind: "paragraph", inline: [{ kind: "text", text: "Aqui:" }] }]);
    expect(parseBlocks("use `npm` e pronto `x`").map((b) => b.kind)).toEqual(["paragraph"]);
  });
  test("blocks: a table right under a sentence, with inline marks in cells and numbers aligned right", () => {
    const blocks = parseBlocks(
      "Usei a semana desde 18/10:\n| Gatilho | Exibições | Taxa |\n|---|---|---|\n| `generic` | 435 | ~6,7% |\nDepois.",
    );
    expect(blocks.map((b) => b.kind)).toEqual(["paragraph", "table", "paragraph"]);
    expect(blocks[1]).toEqual({
      kind: "table",
      header: [
        [{ kind: "text", text: "Gatilho" }],
        [{ kind: "text", text: "Exibições" }],
        [{ kind: "text", text: "Taxa" }],
      ],
      rows: [[[{ kind: "code", text: "generic" }], [{ kind: "text", text: "435" }], [{ kind: "text", text: "~6,7%" }]]],
      align: ["left", "right", "right"],
    });
  });
});

describe("a wide table in a message scrolls sideways", () => {
  const cell = (text: string) => [{ kind: "text" as const, text }];
  const header = [cell("Nome"), cell("Descrição"), cell("Qtd")];
  const rows = [[cell("Ana"), cell("uma descrição bem longa ".repeat(8)), cell("3")]];

  test("columns as drawn, a point more so a short cell never wraps; between the min and the max", () => {
    expect(tableColumnWidths(header, rows, { 0: 70.2, 1: 900, 2: 20 })).toEqual([72, TABLE_COL_MAX, TABLE_COL_MIN]);
  });

  test("before measuring, a guess by letters; the max grows with the text size, up to twice", () => {
    const [name, words] = tableColumnWidths(header, rows, {});
    expect(name).toBeGreaterThan(TABLE_COL_MIN);
    expect(words).toBe(TABLE_COL_MAX);
    expect(tableColumnWidths(header, rows, { 1: 900 }, 1.5)[1]).toBe(TABLE_COL_MAX * 1.5);
    expect(tableColumnWidths(header, rows, { 1: 2000 }, 3.1)[1]).toBe(TABLE_COL_MAX * 2);
    // A smaller text size never makes a column narrower than the default max allows.
    expect(tableColumnWidths(header, rows, { 1: 900 }, 0.8)[1]).toBe(TABLE_COL_MAX);
  });

  test("the hidden side: right while there is more, left once scrolled, none when it fits or isn't laid out", () => {
    expect(tableHidden(0, 300, 600)).toEqual({ left: false, right: true });
    expect(tableHidden(150, 300, 600)).toEqual({ left: true, right: true });
    expect(tableHidden(300, 300, 600)).toEqual({ left: true, right: false });
    expect(tableHidden(0, 300, 280)).toEqual({ left: false, right: false });
    expect(tableHidden(0, 0, 600)).toEqual({ left: false, right: false });
  });
});

describe("an agent's question (ask_user)", () => {
  const question = {
    id: "q1",
    agentId: "dev",
    channelId: "c1",
    threadId: null,
    messageId: "m1",
    text: "Publico agora ou depois das 18h?",
    choices: ["Agora", "Depois das 18h", 3],
    status: "open",
    answer: null,
    answeredByUserId: null,
  };

  test("meta.question becomes the card's data; bad shapes are ignored", () => {
    expect(questionOf({ question })).toEqual({ ...question, choices: ["Agora", "Depois das 18h"] });
    expect(questionOf({ question: { ...question, choices: [] } })?.choices).toBeNull();
    expect(questionOf({ question: { ...question, status: "answered", answer: "Agora" } })).toMatchObject({
      status: "answered",
      answer: "Agora",
    });
    // Taken back by the agent: the card says it no longer needs an answer.
    expect(
      questionOf({ question: { ...question, status: "answered", answer: null, withdrawn: true } })?.withdrawn,
    ).toBe(true);
    // Skipped by a person: the card says who skipped it.
    expect(
      questionOf({ question: { ...question, status: "answered", answer: null, dismissed: true } })?.dismissed,
    ).toBe(true);
    // For one person: it keeps who, and waits on them alone.
    const forBia = questionOf({ question: { ...question, requestedForUserId: "bia" } });
    expect(forBia?.requestedForUserId).toBe("bia");
    expect(questionWaitsOn(forBia ?? question, "bia")).toBe(true);
    expect(questionWaitsOn(forBia ?? question, "ana")).toBe(false);
    expect(questionWaitsOn(question, "ana")).toBe(true);
    expect(questionOf({ question: { id: "q", text: "" } })).toBeNull();
    expect(questionOf({})).toBeNull();
    expect(questionOf(undefined)).toBeNull();
  });

  test("the question stands alone and its text is not repeated above the card", () => {
    const asked = message({
      id: "m1",
      author: { type: "agent", id: "dev" },
      body: "Publico agora ou depois das 18h?",
      meta: { question },
    });
    expect(hidesBody(asked)).toBe(true);
    expect(hidesBody({ ...asked, body: "Antes, uma pergunta." })).toBe(false);
    // An agent's proposal of a new agent is its card (ADR 0081); a Connect card, with no card here, keeps its text.
    const draft = { name: "Nina", handle: "nina", role: "", instructions: "x", appearance: null, channelIds: [] };
    const proposal = {
      kind: "agent_proposal",
      forUserId: null,
      params: { draft: { ...draft, access: [], ai: { kind: "none" } }, why: "x" },
      state: "pending",
      expiresAt: at(30),
    };
    expect(hidesBody(message({ id: "a1", author: { type: "agent", id: "dev" }, meta: { actionCard: proposal } }))).toBe(
      true,
    );
    const connect = { kind: "connect_ai", forUserId: null, params: { agentIds: [], why: "x" } };
    expect(hidesBody(message({ id: "a2", author: { type: "agent", id: "dev" }, meta: { actionCard: connect } }))).toBe(
      false,
    );
    // A stretch's pause card says who stopped and why itself (ADR 0089).
    const paused = { kind: "stretch_paused", state: "paused", reason: "runs", limit: 50, agentIds: ["ada"] };
    expect(hidesBody(message({ id: "a3", author: { type: "agent", id: "dev" }, meta: { actionCard: paused } }))).toBe(
      true,
    );
    const rows = buildRows([message({ id: "p", author: { type: "agent", id: "dev" }, createdAt: at(11) }), asked]);
    expect(rows.filter((r) => r.kind === "message").map((r) => r.kind === "message" && r.grouped)).toEqual([
      false,
      false,
    ]);
  });
});

describe("asking an agent to implement an issue", () => {
  const work = { issueId: "iss_1", number: 24, title: "Checkout quebra", agentId: "dev" };
  test("the DM thread's root is the issue card: no text, it stands alone", () => {
    const root = message({ id: "root", body: "Issue #24: Checkout quebra", meta: { issueWork: work } });
    expect(issueWorkOf(root.meta)).toEqual(work);
    expect(hidesBody(root)).toBe(true);
    expect(standsAlone(root)).toBe(true);
  });

  test("the line where the issue came from is its own row; anything else is not an issue line", () => {
    const line = message({
      id: "line",
      author: { type: "agent", id: "dev" },
      body: "Took issue #24: Checkout quebra",
      meta: { issueTaken: work, bodyCode: "issue_taken", bodyParams: { number: 24 } },
    });
    expect(issueTakenOf(line.meta)).toEqual(work);
    expect(standsAlone(line)).toBe(true);
    expect(issueTakenOf({ issueTaken: { issueId: "x" } })).toBeNull();
    expect(issueWorkOf(message({ id: "plain" }).meta)).toBeNull();
  });
});

describe("an agent's turn: nothing drawn while it works, its work kept for the reply", () => {
  const run = (over: Partial<LiveRun> & { runId: string }): LiveRun => ({
    agentId: "theo",
    channelId: "c1",
    threadId: "m1",
    status: "thinking",
    ...over,
  });
  const call = (id: string, tool: string, running: boolean) => ({
    kind: "call" as const,
    id,
    tool,
    connector: null,
    detail: null,
    code: null,
    output: [],
    running,
  });

  test("a call refused for its arguments: quiet once made right, plain when the run ends without it", () => {
    const slip = { ...call("1", "offer_connect_app", false), failed: true, slip: true };
    const made = turnItems(run({ runId: "r", work: [slip, call("2", "offer_connect_app", false)] }));
    expect(made.map((x) => x.kind === "call" && x.line.state)).toEqual(["stop", "done"]);
    expect(toolNow(turnItems(run({ runId: "r", work: [slip] })))?.state).toBe("run");
    expect(toolNow(turnItems(run({ runId: "r", work: [slip] }), true))?.state).toBe("fail");
    expect(toolNow(turnItems(run({ runId: "r", status: "failed", work: [slip] })))?.state).toBe("fail");
  });

  test("what the saved reply keeps changes with a call's state and count", () => {
    const sig = (running: boolean) =>
      turnSignature(turnItems(run({ runId: "r", work: [call("1", "drive_read", running)] })));
    expect(sig(true)).not.toBe(sig(false));
  });

  test("its work in order, as the tool block's items: calls (running or done) and what it read, never what it said", () => {
    const items = turnItems(
      run({
        runId: "r",
        work: [
          call("1", "sentry_list_issues", false),
          { kind: "steer", messageId: "m2", now: true },
          call("2", "drive_read", true),
        ],
      }),
    );
    expect(items.map((x) => x.kind)).toEqual(["call", "steer", "call"]);
    expect(items[0]).toMatchObject({ kind: "call", line: { state: "done", kind: "consulting", app: "Sentry" } });
    expect(items[1]).toMatchObject({ kind: "steer", messageId: "m2", now: true });
    expect(items[2]).toMatchObject({ kind: "call", line: { state: "run" } });
    expect(toolCalls(items)).toBe(2);
  });

  test("a reaction already shows on the message: a turn that only reacted has no block, other tools count alone", () => {
    expect(toolNow(turnItems(run({ runId: "r", status: "done", work: [call("1", "react", false)] })))).toBeNull();
    const items = turnItems(
      run({ runId: "r", work: [call("1", "mcp__agentes__react", false), call("2", "sentry_list_issues", false)] }),
    );
    expect(items.map((x) => (x.kind === "call" ? x.line.kind : x.kind))).toEqual(["consulting"]);
    expect(toolCalls(items)).toBe(1);
  });

  test("the same call again, nothing said between: one line counting both", () => {
    const items = turnItems(
      run({ runId: "r", work: [call("1", "sentry_list_issues", false), call("2", "sentry_list_issues", true)] }),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "call", line: { state: "run", count: 2 } });
  });

  test("a computer command in the phone's words: what it ran, a refusal and why", async () => {
    const pt = await translator("pt-BR");
    const en = await translator("en");
    const check = (id: string, detail: string, more: Partial<Extract<LiveWork, { kind: "call" }>> = {}) => ({
      ...call(id, "permission_prompt", false),
      detail,
      ...more,
    });
    const items = turnItems(
      run({
        runId: "r",
        work: [
          check("1", "Rerun new unit tests after formatting", { command: "npx jest a.test.ts" }),
          check("2", "rm /etc/agentes", {
            failed: true,
            why: "This command was refused because it changes files outside the mission folder. Do it another way.",
            refusal: "outside",
          }),
        ],
      }),
    );
    const lines = items.flatMap((x) => (x.kind === "call" ? [x.line] : []));
    expect(lines.map((l) => toolPhrase(pt, l))).toEqual([
      "Rodou: Rerun new unit tests after formatting",
      "Recusado: rm /etc/agentes",
    ]);
    expect(lines.map((l) => toolPhrase(en, l))).toEqual([
      "Ran: Rerun new unit tests after formatting",
      "Refused: rm /etc/agentes",
    ]);
    expect(lines[0]?.input).toBe("npx jest a.test.ts");
    expect(lines.map((l) => [toolWhy(pt, l), toolWhy(en, l)])).toEqual([
      [null, null],
      ["Mexe em arquivos fora da pasta do agente", "It changes files outside the agent's folder"],
    ]);
  });

  test("the saved reply's tools: no line said before them, none from the work it kept", () => {
    const quiet = run({ runId: "r", work: [call("1", "sentry_list_issues", false)] });
    const opened = turnOpener(turnItems(quiet), "Vou pedir pro Josh.");
    expect(opened.said).toBeNull();
    expect(opened.lines.map((x) => x.kind)).toEqual(["call"]);
  });

  test("a failed run's call that was running shows as stopped", () => {
    const items = turnItems(run({ runId: "r", status: "failed", work: [call("1", "sentry_list_issues", true)] }));
    expect(items[0]).toMatchObject({ kind: "call", line: { state: "stop" } });
  });

  test("an open code line shows what it printed, its end when long", () => {
    expect(outputTail([{ text: "a\n" }, { text: "b" }])).toBe("a\nb");
    const long = outputTail([{ text: "x".repeat(50) }, { text: "end" }], 10);
    expect(long).toHaveLength(10);
    expect(long.startsWith("…")).toBe(true);
    expect(long.endsWith("end")).toBe(true);
  });

  test("at work: every run (a guess too) but one in its browser, which has its card; none draws a row", () => {
    const runs = [
      run({ runId: "p", provisional: true }),
      run({ runId: "q", status: "queued" }),
      run({ runId: "w", status: "running" }),
      run({ runId: "a", status: "waiting_approval" }),
      run({ runId: "f", status: "failed" }),
      run({ runId: "b", status: "running" }),
    ];
    expect(turnRuns(runs, new Set(["b"])).map((r) => r.runId)).toEqual(["p", "q", "w"]);
  });

  test("a color's fade: hex gets an alpha, rgba is multiplied", () => {
    expect(withOpacity("#000000", 0.5)).toBe("#00000080");
    expect(withOpacity("rgba(10, 20, 30, 0.5)", 0.5)).toBe("rgba(10, 20, 30, 0.25)");
    expect(withOpacity("rgb(1, 2, 3)", 1)).toBe("rgba(1, 2, 3, 1)");
    expect(withOpacity("red", 0.5)).toBe("red");
  });

  test("the saved reply finds the work its run did, heard a moment ago", () => {
    const items = turnItems(run({ runId: "r9", work: [call("1", "sentry_list_issues", false)] }));
    rememberTurn("r9", { items, quotes: {}, at: 1000 });
    expect(recentTurn("r9", 2000)?.items).toEqual(items);
    expect(recentTurn("r9", 1000 + 60_000)).toBeNull();
    expect(recentTurn("nope", 2000)).toBeNull();
  });

  test("a stopped reply: who stopped it and whether it was continued", () => {
    expect(stoppedOf({ canceled: { byUserId: "u1" } })).toEqual({ byUserId: "u1", continuedRunId: null });
    expect(stoppedOf({ canceled: true })).toEqual({ byUserId: null, continuedRunId: null });
    expect(stoppedOf({})).toBeNull();
    const next = withContinued({ canceled: { byUserId: "u1", text: "Oi" }, other: 1 }, "r2");
    expect(next).toEqual({ canceled: { byUserId: "u1", text: "Oi", continuedRunId: "r2" }, other: 1 });
    expect(stoppedOf(next)?.continuedRunId).toBe("r2");
  });

  test("a reply at the step limit: whether it was continued, marked in its own meta", () => {
    expect(stepLimitOf({ stepLimit: {}, bodyCode: "step_limit" })).toEqual({ continuedRunId: null, stuck: false });
    expect(stepLimitOf({ canceled: { byUserId: "u1" } })).toBeNull();
    expect(stepLimitOf({})).toBeNull();
    const next = withContinued({ stepLimit: {}, bodyCode: "step_limit" }, "r3");
    expect(next).toEqual({ stepLimit: { continuedRunId: "r3" }, bodyCode: "step_limit" });
    expect(stepLimitOf(next)?.continuedRunId).toBe("r3");
    expect(stoppedOf(next)).toBeNull();
  });

  test("a reply of a run that stopped because it got stuck: said apart, and still once it was continued", () => {
    const stuck = { stepLimit: { stuck: true }, bodyCode: "stuck" };
    expect(stepLimitOf(stuck)).toEqual({ continuedRunId: null, stuck: true });
    expect(stepLimitOf(withContinued(stuck, "r4"))).toEqual({ continuedRunId: "r4", stuck: true });
  });

  test("a long work's end its AI provider failed: continued in its own meta", () => {
    const end = { workEnd: { id: "w1", status: "failed", errorCode: "run.provider_error" } };
    expect(withContinued(end, "r5")).toEqual({ workEnd: { ...end.workEnd, continuedRunId: "r5" } });
  });
});

describe("automatic lines (notices) and fast replies", () => {
  const handles: Record<string, string> = { infra: "Infra", dev: "Dev" };
  const names = { author: "Ada", agentByHandle: (handle: string) => handles[handle] ?? null };
  const agentMsg = (id: string, meta: Record<string, unknown>, over: Partial<Message> = {}) =>
    message({ id, author: { type: "agent", id: "ada" }, body: "", meta, ...over });

  test("a routine's report: «name» from the refs or `from`; the text on demand", () => {
    const own = eventLineOf(
      agentMsg("n1", {
        notice: { kind: "routine_handoff", text: "3 erros novos", refs: { routineName: "Sentry diário" } },
      }),
      names,
    );
    expect(own).toEqual({
      kind: "notice",
      icon: "clock",
      key: "chat.notice.routineHandoff",
      values: { routine: "Sentry diário" },
      detail: { content: "3 erros novos" },
      pending: false,
      answer: false,
    });
    const fromOnly = eventLineOf(
      agentMsg("n2", { notice: { kind: "routine_handoff", text: "x", from: "Rotina «Bom dia»" } }),
      names,
    );
    expect(fromOnly?.values).toEqual({ routine: "Bom dia" });
    const anon = eventLineOf(agentMsg("n3", { notice: { kind: "routine_handoff", text: "x" } }), names);
    expect(anon?.key).toBe("chat.notice.routineHandoffAnon");
  });

  test("what someone wrote on GitHub: its line, their words and the link, and a way to ask for a reply", () => {
    const refs = { event: "comment", item: "issue", who: "drive-by", number: "5", repo: "acme/app" };
    const line = eventLineOf(
      agentMsg("n4", {
        notice: {
          kind: "github_event",
          text: "Pode revisar?",
          refs: { ...refs, url: "https://github.com/acme/app/issues/5", outside: "1" },
        },
      }),
      names,
    );
    expect(line).toMatchObject({
      key: "chat.notice.github.commentIssue",
      values: { who: "drive-by", number: "5", repo: "acme/app" },
      detail: { content: "Pode revisar?\n\nhttps://github.com/acme/app/issues/5" },
      answer: true,
    });
  });

  test("another agent's answer and note say its name, not the agent-facing handle (no @)", () => {
    const reply = eventLineOf(agentMsg("n1", { notice: { kind: "consult_reply", text: "ok", from: "@infra" } }), names);
    expect(reply).toMatchObject({ icon: "agent", key: "chat.notice.consultReply", values: { from: "Infra" } });
    const unknown = eventLineOf(
      agentMsg("n2", { notice: { kind: "agent_note", text: "ok", refs: { agentHandle: "@zed" } } }),
      names,
    );
    expect(unknown).toMatchObject({ icon: "chat", key: "chat.notice.agentNote", values: { from: "zed" } });
    const anon = eventLineOf(agentMsg("n3", { notice: { kind: "consult_reply", text: "ok" } }), names);
    expect(anon?.key).toBe("chat.notice.consultReplyAnon");
  });

  test("a mention that couldn't wake its agents says whose mention and whom, by name", () => {
    const line = eventLineOf(
      agentMsg("n1", {
        notice: { kind: "wake_skipped", text: "@infra wasn't woken", refs: { agentHandles: "infra,zed" } },
      }),
      names,
    );
    expect(line).toMatchObject({
      key: "chat.notice.wakeSkipped",
      values: { name: "Ada", agents: "Infra, zed" },
      // What it opens is people's words for why, never the line written for the agent.
      detail: { words: { key: "chat.notice.wakeSkippedAudience", values: { name: "Ada", agents: "Infra, zed" } } },
    });
  });

  test("an agent's follow-up: when it will be back and for what (Cancel while it is to come), then the line that woke it", () => {
    // Today, so the line needs no day.
    const at = new Date(new Date().setHours(12, 0, 0, 0)).toISOString();
    const when = { time: (iso: string) => (iso === at ? "12:00" : "?"), locale: "pt-BR" };
    const refs = { runId: "r1", at, about: "ver o CI" };
    const set = eventLineOf(
      agentMsg("n1", { notice: { kind: "follow_up", text: "Check CI run 42", refs: { ...refs, state: "pending" } } }),
      names,
      when,
    );
    expect(set).toEqual({
      kind: "notice",
      icon: "clock",
      key: "chat.notice.followUp",
      values: { name: "Ada", about: "ver o CI", time: "12:00", day: "" },
      // Its note to itself is the agent's: nothing to open.
      detail: null,
      pending: true,
      answer: false,
    });
    const canceled = eventLineOf(
      agentMsg("n2", { notice: { kind: "follow_up", text: "x", refs: { ...refs, state: "canceled" } } }),
      names,
      when,
    );
    expect(canceled?.key).toBe("chat.notice.followUpCanceled");
    expect(canceled?.pending).toBe(false);
    const woke = eventLineOf(
      agentMsg("n3", { notice: { kind: "follow_up", text: "x", refs: { ...refs, wake: "1", followUpId: "n1" } } }),
      names,
      when,
    );
    expect(woke).toMatchObject({ key: "chat.notice.followUpWake", values: { name: "Ada", about: "ver o CI" } });
  });

  test("as on the web, a follow-up that came leaves the conversation once the agent's turn is over", () => {
    const refs = { runId: "r1", at: "x", about: "ver o CI" };
    const at = (minute: number) => new Date(Date.UTC(2026, 10, 6, 20, minute)).toISOString();
    const list = [
      agentMsg(
        "set",
        { notice: { kind: "follow_up", text: "x", refs: { ...refs, state: "done" } } },
        { createdAt: at(0) },
      ),
      agentMsg(
        "woke",
        { notice: { kind: "follow_up", text: "x", refs: { ...refs, wake: "1" } } },
        { createdAt: at(20) },
      ),
    ];
    const ids = (rows: ReturnType<typeof buildRows>) =>
      rows.flatMap((r) => (r.kind === "message" ? [r.message.id] : []));
    // At work: the line that woke it stays.
    expect(ids(buildRows(list, undefined, new Set(["ada"])))).toEqual(["woke"]);
    const reply = message({
      id: "reply",
      author: { type: "agent", id: "ada" },
      body: "O CI passou.",
      createdAt: at(21),
    });
    expect(ids(buildRows([...list, reply]))).toEqual(["reply"]);
  });

  test("a wait's result names the agent that waited, and opens nothing written for the agent", () => {
    const line = eventLineOf(
      agentMsg("n1", { notice: { kind: "wait_result", text: "notice text" } }, { body: "  o deploy terminou  " }),
      names,
    );
    expect(line).toMatchObject({
      icon: "check",
      key: "chat.notice.waitResult",
      values: { name: "Ada" },
      detail: null,
    });
    expect(eventLineOf(agentMsg("n2", { notice: { kind: "new_kind", text: "x" } }), names)).toMatchObject({
      icon: "bell",
      key: "chat.notice.other",
    });
  });

  test("a talker reply is the agent's message, never a line (it carries both meta.talker and a notice)", () => {
    const talker = agentMsg("t1", {
      talker: { runId: "r1", inReplyTo: "m1" },
      notice: { kind: "talker_reply", text: "Já vejo isso" },
    });
    expect(eventLineOf(talker, names)).toBeNull();
    expect(standsAlone(talker)).toBe(false);
  });

  test("a routine's firing written as its creator (before its own room) is never shown, nor a line", () => {
    const start = message({
      id: "bg",
      body: "@ada veja os erros",
      meta: { background: true, routineId: "rt1", routine: { id: "rt1", name: "Sentry diário" } },
    });
    expect(eventLineOf(start, names)).toBeNull();
    expect(buildRows([start]).filter((r) => r.kind === "message")).toHaveLength(0);
    expect(eventLineOf(message({ id: "plain" }), names)).toBeNull();
  });

  test("lines never group; a fast reply keeps its header (enquanto trabalha)", () => {
    const ada = { type: "agent" as const, id: "ada" };
    const rows = buildRows([
      message({ id: "a", author: ada, createdAt: at(10) }),
      message({ id: "n", author: ada, meta: { notice: { kind: "routine_handoff", text: "x" } }, createdAt: at(9) }),
      message({ id: "b", author: ada, createdAt: at(8) }),
      message({ id: "t", author: ada, meta: { talker: { runId: "r1" } }, createdAt: at(7) }),
      message({ id: "c", author: ada, createdAt: at(6) }),
    ]).flatMap((r) => (r.kind === "message" ? [r.grouped] : []));
    expect(rows).toEqual([false, false, false, false, true]);
  });
});

describe("an agent's secret request (ADR 0027), as its card reads it", () => {
  const request = {
    id: "s1",
    agentId: "theo",
    channelId: "c1",
    threadId: null,
    messageId: "m1",
    requestedForUserId: "u1",
    name: "SHOP_PASSWORD",
    purpose: "entrar na loja (shop.example.com)",
    target: { kind: "site", site: "https://shop.example.com" },
    site: "https://shop.example.com",
    machineId: "mac1",
    publicKey: "BPk",
    status: "pending",
    expiresAt: at(-15),
    deliveredAt: null,
    removed: false,
  } as const;

  test("its card stands alone, and its message's text isn't repeated above it", () => {
    const card = message({ id: "m1", author: { type: "agent", id: "theo" }, body: "Secret request: SHOP_PASSWORD" });
    const asked = { ...card, meta: { secretRequest: request } };
    expect(secretRequestOf(asked.meta)).toEqual(request);
    expect(hidesBody(asked)).toBe(true);
    expect(standsAlone(asked)).toBe(true);
    expect(hidesBody(card)).toBe(false);
    // Anything else under its name is no card.
    expect(secretRequestOf({ secretRequest: { ...request, target: { kind: "ssh" } } })).toBeNull();
    expect(secretRequestOf({ secretRequest: { ...request, status: "opened" } })).toBeNull();
    expect(secretRequestOf({ secretRequest: "SHOP_PASSWORD" })).toBeNull();
    expect(secretRequestOf(undefined)).toBeNull();
  });

  test("where the value goes, said truly for each kind, in both languages", async () => {
    const en = await translator("en");
    const pt = await translator("pt-BR");
    expect(secretWhere(en, request, "Theo")).toBe(
      "Only Theo's browser types it, on shop.example.com. It stays out of Theo's commands.",
    );
    expect(secretWhere(pt, request, "Theo")).toBe(
      "Só o navegador de Theo digita, em shop.example.com. Fica fora dos comandos de Theo.",
    );
    expect(secretWhere(en, { ...request, name: "NPM_TOKEN", target: { kind: "env" } }, "Theo")).toBe(
      "Goes to Theo's computer, for its commands.",
    );
    expect(secretWhere(pt, { ...request, target: { kind: "file", path: ".npmrc" } }, "Theo")).toBe(
      "Vai para o arquivo .npmrc no computador de Theo.",
    );
    // Asked again under a name the agent holds (a key that was refused): the card says it replaces that one.
    const again = { ...request, name: "TYPESAFE_API_KEY", target: { kind: "env" as const }, replaces: true };
    expect(secretWhere(pt, again, "Theo")).toBe(
      "Vai para o computador de Theo, para os comandos. Substitui a chave com esse nome que Theo já tem.",
    );
    expect(secretWhere(en, again, "Theo")).toBe(
      "Goes to Theo's computer, for its commands. Replaces the key Theo already has under this name.",
    );
    // Answered or closed, nothing is being replaced: the details say only where it goes.
    for (const status of ["delivered", "declined", "expired"] as const) {
      expect(secretWhere(pt, { ...again, status }, "Theo")).toBe("Vai para o computador de Theo, para os comandos.");
    }
  });

  test("people read a label, never the agent's own name for it", async () => {
    const pt = await translator("pt-BR");
    expect(secretLabel(pt, { ...request, label: "Senha da Conta Google" }, "Theo")).toBe("Senha da Conta Google");
    expect(secretLabel(pt, request, "Theo")).toBe("Senha de shop.example.com");
    expect(secretLabel(pt, { ...request, codeDigits: 6 }, "Theo")).toBe("Código de shop.example.com");
    expect(secretLabel(pt, { ...request, site: null, target: { kind: "env" } }, "Theo")).toBe(
      "Chave para o computador de Theo",
    );
    expect(secretLabel(pt, { ...request, site: null, target: { kind: "file", path: ".npmrc" } }, "Theo")).toBe(
      "O arquivo .npmrc",
    );
  });

  test("an ended request says what happened and what's next, for each way it ends", async () => {
    const pt = await translator("pt-BR");
    const said = (r: Partial<SecretRequest>) => secretOutcome(pt, { ...request, ...r }, true, "Ana", "Theo");
    expect(said({ status: "delivered" })).toBe("Entregue por você");
    expect(said({ status: "declined" })).toBe("Recusado. Theo segue sem isso.");
    expect(said({ status: "expired" })).toContain("Ninguém respondeu a tempo.");
    // Past its deadline before any event: the same words.
    expect(said({ status: "pending" })).toContain("Ninguém respondeu a tempo.");
    expect(said({ status: "canceled", endReason: "run_stopped" })).toContain("A tarefa de Theo parou");
    expect(said({ status: "canceled", endReason: "superseded" })).toContain("num pedido mais novo");
    // Its run stopped and the agent asked again: the newer one is what's next.
    expect(said({ status: "canceled", endReason: "run_stopped", supersededBy: "r2" })).toContain(
      "num pedido mais novo",
    );
    expect(said({ status: "canceled", endReason: "computer_changed" })).toContain("o computador que pediu mudou");
    expect(said({ status: "canceled", endReason: "person_left" })).toContain("Ana saiu do workspace");
    expect(said({ status: "canceled", withdrawn: true })).toBe("Theo não precisa mais disso.");
    expect(said({ status: "canceled" })).toContain("Este pedido fechou antes da resposta.");
  });

  test("a closed copy beats an open one, and only a computer that can't take it keeps the card open", () => {
    const closed = { ...request, status: "canceled" as const };
    expect(latestSecret(request, closed)).toBe(closed);
    expect(latestSecret(closed, request)).toBe(closed);
    expect(latestSecret(undefined, request)).toBe(request);
    expect(secretRefusalKey({ code: "machine.offline" })).toBe("secret.computerAway");
    expect(secretRefusalKey({ code: "machine.paused" })).toBe("secret.computerPaused");
    expect(secretRefusalKey({ code: "secret.closed" })).toBeNull();
  });

  test("a 409 ends the card as the request really ended, and an open one stays open", () => {
    const r = request as SecretRequest;
    const refusal = (params?: object) => ({ code: "secret.closed", status: 409, params });
    const ended = { ...r, status: "declined" as const };
    expect(secretClosedBy(refusal(), r, ended)).toBe(ended);
    // Reading it again failed: the refusal itself says how it ended.
    const changed = secretClosedBy(refusal({ status: "canceled", endReason: "computer_changed" }), r, null);
    expect(changed).toMatchObject({ status: "canceled", endReason: "computer_changed", publicKey: null });
    expect(secretClosedBy(refusal({ status: "expired" }), r, null)?.status).toBe("expired");
    // Still open: nothing says it ended, so the card doesn't either.
    expect(secretClosedBy({ code: "conflict", status: 409 }, r, r)).toBeNull();
    expect(secretClosedBy(refusal(), r, null)).toBeNull();
  });

  test("an empty or too large value is caught before it is sealed", async () => {
    const en = await translator("en");
    expect(secretValueProblem("")).toBe("secret.empty");
    expect(secretValueProblem("é".repeat(8 * 1024 + 1))).toBe("secret.tooLarge");
    expect(secretValueProblem("hunter2")).toBeNull();
    expect(en("secret.tooLarge")).toBe("Too large (16 KB at most).");
  });
});

describe("reading a conversation", () => {
  test("a thread view marks only its thread read, never its channel", () => {
    expect(readMark("c1", "t1")).toEqual({ kind: "thread", id: "t1" });
    expect(readMark("c1", null)).toEqual({ kind: "channel", id: "c1" });
  });
});

describe("an agent's @mention", () => {
  const agents = [{ handle: "Theo", previousHandles: ["teo"], appearance: { color: "rose" } }, { handle: "ada" }];

  test("takes the agent's tone per theme, sky with no look; a person or an unknown handle gets none", () => {
    const light = mentionTint("theo", agents, "light");
    expect(light?.backgroundColor).toMatch(/^#[0-9a-f]{6}$/);
    expect(mentionTint("theo", agents, "dark")?.backgroundColor).not.toBe(light?.backgroundColor);
    expect(mentionTint("ada", agents, "light")?.color).not.toBe(light?.color);
    expect(mentionTint("maria", agents, "light")).toBeUndefined();
    expect(mentionTint("teo", agents, "light")).toEqual(light);
  });
});

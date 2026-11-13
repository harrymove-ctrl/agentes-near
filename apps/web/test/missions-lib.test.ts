import { describe, expect, test } from "bun:test";
import type { MachineTask, Mission } from "@agenteschat/client";
import {
  appendOutputLine,
  cellsFromCounts,
  editDiff,
  executorName,
  executorOnText,
  formatSpan,
  isOpenMission,
  lastLines,
  machineTaskOf,
  mdLines,
  missionCardRef,
  missionCells,
  missionLinkOf,
  missionPlanChangeOf,
  missionPlanOf,
  missionReportOf,
  missionSetupOf,
  missionSuggestionOf,
  missionTasks,
  newLineIndexes,
  parseMissionCommand,
  planCells,
  planCellTitles,
  planChangeParts,
  planCounts,
  prOf,
  shortSha,
  summaryParts,
  taskNoticeOf,
  taskPr,
  taskRange,
  taskSeconds,
  tickFor,
  viaText,
  waitingParts,
  waitingText,
} from "@agenteschat/client/lib/missions";
import { bodyTones, type PlanStripCell, planCellPixel, STRIP_CELL } from "@agenteschat/ui";
import type { TFunction } from "i18next";
import { executorOptions } from "@/components/missions/MissionBits";
import { createI18n } from "@/i18n";

const pt = createI18n("pt-BR");
const t = pt.t.bind(pt) as TFunction;
const enI18n = createI18n("en");
const te = enI18n.t.bind(enI18n) as TFunction;

const mission = (over: Partial<Mission> = {}): Mission => ({
  id: "m1",
  threadId: "root",
  channelId: "c",
  agentId: "a",
  ownerId: "u1",
  executor: "claude",
  title: "App mobile",
  goal: "Build the app.",
  findings: [],
  openQuestion: null,
  status: "active",
  repoDir: "",
  resumeTasks: true,
  commandApproval: "low_risk_auto",
  plan: { version: 1, done: 4, total: 12, waiting: 1, doing: 2, items: [] },
  pending: { decisions: 2, provisional: 0, reviews: 1, suggestions: 0, joinRequests: 0, commands: 0 },
  joinRequested: false,
  runningTasks: 2,
  machine: {
    id: "mac",
    name: "MacBook do Walter",
    online: true,
    lentBy: null,
    executors: ["claude", "agent"],
    codexTooOld: false,
  },
  needsComputer: false,
  role: "owner",
  canAct: true,
  canManage: true,
  createdAt: "2026-10-16T10:00:00.000Z",
  startedAt: "2026-10-16T10:41:00.000Z",
  pausedAt: null,
  closedAt: null,
  closeReason: null,
  wikiPageId: null,
  ...over,
});

const task = (over: Partial<MachineTask> = {}): MachineTask => ({
  id: "t1",
  agentId: "a",
  machineId: "mac",
  channelId: "c",
  threadId: "root",
  missionId: "m1",
  title: "Tela de chat",
  executor: "claude",
  status: "running",
  exitCode: null,
  seconds: null,
  lastLine: null,
  files: [],
  branch: "mission/app-mobile/chat",
  cwd: null,
  resumedFromId: null,
  resumedTaskId: null,
  startedAt: "2026-10-16T11:00:00.000Z",
  endedAt: null,
  lastEventAt: null,
  createdAt: "2026-10-16T11:00:00.000Z",
  ...over,
});

describe("the plan strip", () => {
  test("one cell per item, in order; doing stops with the computer", () => {
    const items = [
      { status: "done" as const },
      { status: "doing" as const },
      { status: "waiting_you" as const },
      { status: "dropped" as const },
      { status: "todo" as const },
    ];
    // Dropped items are left out, like "N de M itens".
    expect(planCells(items)).toEqual(["done", "doing", "waiting", "todo"]);
    expect(planCells(items, { offline: true })[1]).toBe("stopped");
    expect(planCounts(items).total).toBe(4);
  });

  test("tooltips: the item titles in the strip's order, dropped left out", () => {
    expect(
      planCellTitles([
        { status: "done", title: "Ler o app" },
        { status: "dropped", title: "Velho" },
        { status: "waiting_you", title: "Push" },
      ]),
    ).toEqual(["Ler o app", "Push"]);
  });

  test("cell kinds: all the same square, in the agent's tones; only dropped is broken up", () => {
    const tones = bodyTones("sky");
    const pixels = (kind: PlanStripCell) =>
      Array.from({ length: STRIP_CELL * STRIP_CELL }, (_, k) =>
        planCellPixel(kind, "sky", k % STRIP_CELL, Math.floor(k / STRIP_CELL)),
      );
    // Every kind but dropped fills the whole square (no size change for waiting).
    for (const kind of ["todo", "doing", "done", "waiting", "stopped"] as const) {
      expect(pixels(kind).every(Boolean)).toBe(true);
    }
    expect(pixels("dropped").some((p) => p === null)).toBe(true);
    // To do: a faint solid cell, one tone, low opacity (never dotted).
    const todo = pixels("todo");
    expect(new Set(todo.map((p) => p?.color)).size).toBe(1);
    expect(todo.every((p) => (p?.alpha ?? 1) < 0.5)).toBe(true);
    // Done: full opacity, dithered across the agent's tones.
    const done = pixels("done");
    expect(done.every((p) => p?.alpha === 1 && tones.includes(p.color))).toBe(true);
    expect(new Set(done.map((p) => p?.color)).size).toBeGreaterThan(1);
    // Waiting for you: the outline in the agent's mid tone (never black), the inside faint.
    const corner = planCellPixel("waiting", "sky", 0, 0);
    expect(corner?.color).toBe(tones[2]);
    expect(corner?.color).not.toBe("#000000");
    expect(planCellPixel("waiting", "sky", 3, 3)?.alpha).toBeLessThan(0.5);
  });

  test("from counts: done, waiting, running, then the rest; never more cells than items", () => {
    expect(cellsFromCounts({ done: 2, total: 6, waiting: 1 }, 2)).toEqual([
      "done",
      "done",
      "waiting",
      "doing",
      "doing",
      "todo",
    ]);
    expect(cellsFromCounts({ done: 1, total: 2, waiting: 3 }, 5)).toEqual(["done", "waiting"]);
    expect(cellsFromCounts({ done: 0, total: 3, waiting: 0 }, 1, { offline: true })).toEqual([
      "stopped",
      "todo",
      "todo",
    ]);
    expect(cellsFromCounts({ done: 0, total: 0, waiting: 0 })).toEqual([]);
  });

  test("counts leave dropped items out", () => {
    expect(
      planCounts([{ status: "done" }, { status: "dropped" }, { status: "doing" }, { status: "waiting_you" }]),
    ).toEqual({ total: 3, done: 1, doing: 1, waiting: 1 });
  });
});

describe("what waits for you", () => {
  test("only for whoever can act, in the card's order", () => {
    expect(waitingParts(mission())).toEqual([
      { key: "decisions", count: 2 },
      { key: "reviews", count: 1 },
    ]);
    expect(waitingText(t, mission())).toBe("2 decisões, 1 revisão");
    expect(waitingText(te, mission())).toBe("2 decisions, 1 review");
    expect(waitingParts(mission({ canAct: false }))).toEqual([]);
  });

  test("command cards count too ('Esperando você: 2 decisões, 1 revisão, 3 comandos')", () => {
    const m = mission({
      pending: { decisions: 2, provisional: 0, reviews: 1, suggestions: 0, joinRequests: 0, commands: 3 },
    });
    expect(waitingParts(m).at(-1)).toEqual({ key: "commands", count: 3 });
    expect(waitingText(t, m)).toBe("2 decisões, 1 revisão, 3 comandos");
    expect(waitingText(te, m)).toBe("2 decisions, 1 review, 3 commands");
    const one = mission({
      pending: { decisions: 0, provisional: 0, reviews: 0, suggestions: 0, joinRequests: 0, commands: 1 },
    });
    expect(waitingText(t, one)).toBe("1 comando");
  });

  test("the strip of a view: its plan items when sent, else the counts with what is in progress", () => {
    const withItems = mission({
      plan: {
        version: 2,
        done: 1,
        total: 3,
        waiting: 1,
        doing: 1,
        items: [
          { id: "a", title: "A", status: "done" },
          { id: "b", title: "B", status: "doing" },
          { id: "c", title: "C", status: "waiting_you" },
          { id: "d", title: "D", status: "dropped" },
        ],
      },
    });
    expect(missionCells(withItems)).toEqual(["done", "doing", "waiting"]);
    expect(missionCells(withItems, { offline: true })).toEqual(["done", "stopped", "waiting"]);
    // No items (an older server): the counts, with `doing` as the moving cells.
    expect(missionCells(mission({ plan: { version: 1, done: 1, total: 4, waiting: 0, doing: 2, items: [] } }))).toEqual(
      ["done", "doing", "doing", "todo"],
    );
  });

  test("open missions", () => {
    expect(isOpenMission(mission())).toBe(true);
    expect(isOpenMission(mission({ status: "proposed" }))).toBe(true);
    expect(isOpenMission(mission({ status: "done" }))).toBe(false);
  });
});

describe("time and sessions", () => {
  test("spans read as designed", () => {
    expect(formatSpan(t, 40)).toBe("40 s");
    expect(formatSpan(t, 14 * 60)).toBe("14 min");
    expect(formatSpan(t, 85 * 60)).toBe("1 h 25");
    expect(formatSpan(t, 2 * 3600)).toBe("2 h");
    expect(formatSpan(t, 50 * 3600)).toBe("2 dias");
  });

  test("a running task's time comes from its start; an ended one from its seconds", () => {
    const now = Date.parse("2026-10-16T11:09:05.000Z");
    expect(taskSeconds(task(), now)).toBe(545);
    expect(taskSeconds(task({ status: "done", seconds: 840 }), now)).toBe(840);
  });

  test("a mission's sessions: running first, newest next; resumed ones show as their next task", () => {
    const list = missionTasks(
      [
        task({ id: "old", status: "done", createdAt: "2026-10-16T10:00:00.000Z" }),
        task({ id: "new", status: "done", createdAt: "2026-10-16T10:30:00.000Z" }),
        task({ id: "run", status: "running", createdAt: "2026-10-16T09:00:00.000Z" }),
        task({ id: "gone", status: "interrupted", resumedTaskId: "run" }),
        task({ id: "other", missionId: "m2" }),
      ],
      "m1",
    ).map((x) => x.id);
    expect(list).toEqual(["run", "new", "old"]);
  });

  test("a PR named in a line", () => {
    expect(prOf("✓ gh pr create --draft · PR #431")).toEqual({ number: "431", url: null });
    expect(prOf("Opened https://github.com/acme/app/pull/12 as a draft")).toEqual({
      number: "12",
      url: "https://github.com/acme/app/pull/12",
    });
    expect(prOf("Writing apps/mobile/app.json")).toBeNull();
    expect(prOf(null)).toBeNull();
  });

  test("a session's PR: the server's prUrl first, the last line only for older rows", () => {
    expect(taskPr(task({ prUrl: "https://github.com/acme/app/pull/431", lastLine: "PR #9" }))).toEqual({
      number: "431",
      url: "https://github.com/acme/app/pull/431",
    });
    expect(taskPr(task({ prUrl: "https://gitlab.com/acme/app/-/merge_requests/7" }))?.number).toBe("7");
    expect(taskPr(task({ prUrl: null, lastLine: "✓ gh pr create · PR #12" }))).toEqual({ number: "12", url: null });
    expect(taskPr(task({ lastLine: "Reading a.ts" }))).toBeNull();
  });

  test("Ver saída while it runs: a new live line joins the log once", () => {
    expect(appendOutputLine(["a", "b"], "c")).toEqual(["a", "b", "c"]);
    expect(appendOutputLine(["a", "b"], "b")).toEqual(["a", "b"]);
    expect(appendOutputLine(["a"], "  ")).toEqual(["a"]);
    expect(appendOutputLine(["a"], null)).toEqual(["a"]);
    expect(appendOutputLine(["a", "b", "c"], "d", 3)).toEqual(["b", "c", "d"]);
  });
});

describe("plan changes and the summary", () => {
  test("the plan-change line's parts", () => {
    expect(
      planChangeParts({
        added: [{ id: "1", title: "Build de desenvolvimento" }],
        removed: [{ id: "2", title: "Drawer lateral" }],
        changed: [
          { id: "3", title: "Login", from: "doing", to: "done" },
          { id: "4", title: "Tabs embaixo", from: "todo", to: "todo", renamedFrom: "Navegação" },
        ],
      }),
    ).toEqual({
      added: ["Build de desenvolvimento"],
      removed: ["Drawer lateral"],
      done: ["Login"],
      renamed: [{ from: "Navegação", to: "Tabs embaixo" }],
    });
  });

  test("the summary in the person's language: the plan always, the rest when there is some", () => {
    const parts = summaryParts({
      missionId: "m1",
      text: "English text from the server",
      plan: { done: 4, total: 12, doing: 2, waiting: 0 },
      running: 2,
      pendingDecisions: 1,
      provisionalDecisions: 0,
      pendingReviews: 0,
    });
    expect(parts.map((p) => p.key)).toEqual(["plan", "doing", "running", "decisions"]);
    expect(parts.map((p) => t(`missions.summary.${p.key}`, { count: p.count, total: p.total ?? 0 }))).toEqual([
      "4 de 12 itens prontos",
      "2 itens em andamento",
      "2 sessões rodando no computador",
      "1 decisão esperando",
    ]);
  });
});

describe("composer commands", () => {
  test("/mission needs a goal; the others take none", () => {
    expect(parseMissionCommand("/mission construir o app mobile")).toEqual({
      command: "mission",
      arg: "construir o app mobile",
    });
    expect(parseMissionCommand("/mission")).toBeNull();
    expect(parseMissionCommand("/stop")).toEqual({ command: "stop", arg: "" });
    expect(parseMissionCommand(" /Summary ")).toEqual({ command: "summary", arg: "" });
    expect(parseMissionCommand("/stop now please")).toBeNull();
    expect(parseMissionCommand("please /stop")).toBeNull();
    expect(parseMissionCommand("/relatório")).toBeNull();
  });
});

describe("message meta", () => {
  test("cards and lines read their meta (and ignore broken ones)", () => {
    expect(
      missionPlanOf({ missionPlan: { missionId: "m1", title: "App", goal: "G", computer: "Mac", executor: "claude" } }),
    ).toEqual({ missionId: "m1", title: "App", goal: "G", computer: "Mac", executor: "claude" });
    expect(missionPlanOf({ missionPlan: { title: "no id" } })).toBeNull();
    expect(missionCardRef({ missionDecision: { id: "d1", missionId: "m1" } }, "missionDecision")).toEqual({
      id: "d1",
      missionId: "m1",
    });
    expect(missionCardRef({ missionReview: { id: "r1" } }, "missionReview")).toBeNull();
    expect(
      missionReportOf({
        missionReport: { missionId: "m1", taskId: "t1", status: "working", executor: "claude", computer: "Mac" },
      }),
    ).toMatchObject({ missionId: "m1", taskId: "t1", main: false, computer: "Mac" });
    expect(missionSuggestionOf({ missionSuggestion: { status: "pending", missionId: "m1" } })).toEqual({
      status: "pending",
      missionId: "m1",
    });
    expect(missionSuggestionOf({ missionSuggestion: { status: "weird", missionId: "m1" } })).toBeNull();
    expect(
      missionPlanChangeOf({
        missionPlanChange: { missionId: "m1", version: 2, added: [{ id: "x", title: "A" }], removed: [], changed: [] },
      })?.added,
    ).toEqual([{ id: "x", title: "A" }]);
    expect(
      machineTaskOf({ machineTask: { id: "t1", title: "T", status: "done", seconds: 9, computer: "Mac" } }),
    ).toMatchObject({ id: "t1", status: "done", seconds: 9 });
  });

  test("the computer's notices become lines; other codes don't", () => {
    expect(taskNoticeOf({ bodyCode: "machine_offline", bodyParams: { computer: "Mac", count: 2 } })).toEqual({
      code: "machine_offline",
      params: { computer: "Mac", count: "2" },
    });
    expect(taskNoticeOf({ bodyCode: "machine_task_done", bodyParams: {} })?.code).toBe("machine_task_done");
    expect(taskNoticeOf({ bodyCode: "mission_plan" })).toBeNull();
    expect(taskNoticeOf(undefined)).toBeNull();
  });
});

describe("the .agentes/ files", () => {
  test("headings, the server's checklist marks, bullets, quotes and paragraphs", () => {
    const lines = mdLines(
      [
        "# App mobile",
        "## Plano",
        "- [x] Protótipos",
        "- [~] Tela de chat",
        "- [!] Navegação (tabs ou drawer)",
        "- [-] Drawer lateral",
        "- [ ] Notificações",
        "- Até 3 tarefas em paralelo",
        "> Resumo da conversa",
        "",
        "Texto",
      ].join("\n"),
    );
    expect(lines).toEqual([
      { kind: "h1", text: "App mobile" },
      { kind: "h2", text: "Plano" },
      { kind: "check", state: "done", text: "Protótipos" },
      { kind: "check", state: "doing", text: "Tela de chat" },
      { kind: "check", state: "waiting", text: "Navegação", note: "tabs ou drawer" },
      { kind: "check", state: "dropped", text: "Drawer lateral" },
      { kind: "check", state: "todo", text: "Notificações" },
      { kind: "li", text: "Até 3 tarefas em paralelo" },
      { kind: "quote", text: "Resumo da conversa" },
      { kind: "blank" },
      { kind: "p", text: "Texto" },
    ]);
  });

  test("new lines since the last look (none the first time)", () => {
    expect([...newLineIndexes(undefined, "a\nb")]).toEqual([]);
    expect([...newLineIndexes("# Notas\n- a", "# Notas\n- a\n- b\n\n- c")]).toEqual([2, 4]);
    expect([...newLineIndexes("- a\n- a", "- a\n- a\n- a")]).toEqual([2]);
  });

  test("the edit found on the computer as a small diff", () => {
    expect(editDiff("- ## Jotai para o estado local\n+ ## Zustand para o estado local\nnoise")).toEqual([
      { kind: "del", text: "## Jotai para o estado local" },
      { kind: "add", text: "## Zustand para o estado local" },
    ]);
    expect(editDiff(undefined)).toEqual([]);
  });
});

describe("who programs (ADR 0029, executor agent)", () => {
  test("labels: via Claude Code / Codex on a computer, or the agent itself on it; options only for what the computer has", () => {
    expect(executorName("claude")).toBe("Claude Code");
    expect(executorName("codex")).toBe("Codex");
    expect(executorName("agent", "Dev")).toBe("Dev");
    expect(viaText(t, "claude", "Dev", "MacBook")).toBe("via Claude Code no MacBook");
    expect(viaText(t, "agent", "Dev", "MacBook")).toBe("Dev no MacBook");
    expect(viaText(te, "agent", "Dev", "MacBook")).toBe("Dev on MacBook");
    expect(viaText(t, "codex", "Dev", null)).toBe("via Codex");
    const options = executorOptions(t, ["codex", "agent"], "Dev");
    expect(options.map((o) => o.label)).toEqual(["Codex", "Dev (o próprio agente)"]);
    expect(executorOptions(te, ["claude"], "Dev")[0]?.description).toContain("Claude Code plans and codes");
  });
});

describe("the elapsed clock", () => {
  test("ticks every second under a minute, then every 15 s, then every minute", () => {
    expect(tickFor(0)).toBe(1000);
    expect(tickFor(58)).toBe(1000);
    expect(tickFor(60)).toBe(15_000);
    expect(tickFor(3599)).toBe(15_000);
    expect(tickFor(7200)).toBe(60_000);
  });
});

describe("the mission link card", () => {
  test("reads meta.missionLink; anything else is no card", () => {
    expect(missionLinkOf({ missionLink: { missionId: "m1", threadId: "t1" } })).toEqual({
      missionId: "m1",
      threadId: "t1",
    });
    expect(missionLinkOf({ missionLink: { missionId: "m1" } })).toBeNull();
    expect(missionLinkOf({})).toBeNull();
  });
});

describe("who programs, as a mark", () => {
  test("'Claude Code no mac' (no 'via'), the agent's name when it works itself; options carry the mark", () => {
    expect(executorOnText(t, "claude", "Ada", "mac")).toBe("Claude Code no mac");
    expect(executorOnText(te, "codex", "Ada", "mac")).toBe("Codex on mac");
    expect(executorOnText(t, "agent", "Ada", "mac")).toBe("Ada no mac");
    expect(executorOnText(t, "claude", "Ada", null)).toBe("Claude Code");
    const options = executorOptions(t, ["claude", "codex", "agent"], "Ada", "a1");
    expect(options.map((o) => o.label)).toEqual(["Claude Code", "Codex", "Ada (o próprio agente)"]);
    expect(options.every((o) => o.leading)).toBe(true);
  });
});

describe("the mission's copy of the project (ADR 0044)", () => {
  test("meta.missionSetup: only a failed setup makes the card; the mission id is optional", () => {
    expect(missionSetupOf({ missionSetup: { state: "failed", error: "boom" } })).toEqual({
      state: "failed",
      reason: "setup",
      error: "boom",
    });
    expect(
      missionSetupOf({ missionSetup: { state: "failed", reason: "branch_missing", error: "", branch: "agentes/x/y" } }),
    ).toEqual({ state: "failed", reason: "branch_missing", error: "", branch: "agentes/x/y" });
    expect(missionSetupOf({ missionSetup: { state: "failed", error: "x", missionId: "m1" } })?.missionId).toBe("m1");
    expect(missionSetupOf({ missionSetup: { state: "ready" } })).toBeNull();
    expect(missionSetupOf({})).toBeNull();
    expect(missionSetupOf(undefined)).toBeNull();
  });

  test("the error's last lines, without trailing blanks", () => {
    const text = ["", "one", "two", "three", "four", ""].join("\n");
    expect(lastLines(text, 2)).toBe("three\nfour");
    expect(lastLines(text)).toBe("one\ntwo\nthree\nfour");
    expect(lastLines(null)).toBe("");
  });

  test("short commits and a session's range only when both ends differ", () => {
    expect(shortSha("0123456789abcdef")).toBe("0123456");
    expect(shortSha(null)).toBe("");
    expect(taskRange({ startSha: "aaaaaaaaaa", endSha: "bbbbbbbbbb" })).toBe("aaaaaaa..bbbbbbb");
    expect(taskRange({ startSha: "aaaaaaaaaa", endSha: "aaaaaaaaaa" })).toBeNull();
    expect(taskRange({ startSha: "aaaaaaaaaa", endSha: null })).toBeNull();
    expect(taskRange({})).toBeNull();
  });
});

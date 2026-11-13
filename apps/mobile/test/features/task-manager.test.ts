import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EndedTask, ManagedTask } from "@agenteschat/client";
import { taskTitle, taskWaitGroups, taskWaitGroupText } from "@agenteschat/client/lib/task-manager";
import {
  agentTasksHref,
  agentTasksOf,
  computerLine,
  doneTodayOf,
  endedLatestFirst,
  endedText,
  groupLine,
  isHere,
  rowState,
  taskStateWords,
  taskSubline,
  tasksBadge,
} from "../../src/features/task-manager/logic";
import { translator } from "./fixtures";

const APP = join(import.meta.dir, "../../app/(app)");

const task = (over: Partial<ManagedTask> & { runId: string }): ManagedTask => ({
  agentId: "dev",
  channelId: "dm1",
  channelKind: "dm",
  channelName: null,
  threadId: null,
  status: "running",
  startedAt: null,
  createdAt: "2026-11-02T14:00:00.000Z",
  label: null,
  background: false,
  routine: null,
  plan: null,
  requester: null,
  brain: "model",
  machine: null,
  now: null,
  steps: 0,
  pendingMessageIds: [],
  canStop: true,
  ...over,
});

const ended = (over: Partial<EndedTask> & { runId: string }): EndedTask => ({
  agentId: "dev",
  channelId: "c1",
  channelKind: "channel",
  channelName: "produto",
  threadId: null,
  status: "done",
  label: "Revisar o PR #231",
  background: false,
  routine: null,
  startedAt: "2026-11-02T13:00:00.000Z",
  finishedAt: "2026-11-02T13:20:00.000Z",
  stoppedBy: null,
  ...over,
});

const NONE: ReadonlySet<string> = new Set();

describe("a task's row (ADR 0128)", () => {
  test("its state: working, waiting on an ok or an answer, queued, and stopping once asked here", async () => {
    const t = await translator("pt-BR");
    const said = (over: Partial<ManagedTask>, stopping = NONE) =>
      taskStateWords(t, "pt-BR", task({ runId: "r1", ...over }), rowState(task({ runId: "r1", ...over }), stopping), 0)
        .state;
    expect(said({ status: "running" })).toBe("Trabalhando");
    expect(said({ status: "waiting_approval" })).toBe("Espera seu ok");
    expect(said({ status: "waiting_input" })).toBe("Espera resposta");
    expect(said({ status: "queued" })).toBe("Na fila");
    expect(said({ status: "waiting_approval" }, new Set(["r1"]))).toBe("Parando…");
  });

  test("under the title: where, who asked and the plan; where is left out when it already is the title", async () => {
    const t = await translator("pt-BR");
    const asked = task({
      runId: "r1",
      channelKind: "channel",
      channelName: "produto",
      label: "Corrigir o link de cancelar",
      requester: { userId: "me", name: "Bia" },
      plan: { done: 9, total: 14 },
    });
    expect(taskSubline(t, asked, "me", taskTitle(t, asked))).toBe("#produto · Você pediu · 9 de 14 feitos");
    expect(taskSubline(t, { ...asked, plan: null }, "other", taskTitle(t, asked))).toBe("#produto · Bia pediu");
    // A DM's task with no label of its own is titled by where it is: said once.
    const dm = task({ runId: "r2", requester: { userId: "me", name: "Bia" } });
    expect(taskTitle(t, dm)).toBe("Conversa direta");
    expect(taskSubline(t, dm, "me", taskTitle(t, dm))).toBe("Você pediu");
  });

  test("a task agents asked of each other says who asked and what started it; helpers are counted", async () => {
    const t = await translator("pt-BR");
    const helper = task({
      runId: "r3",
      betweenAgents: true,
      label: "Vê o log",
      requester: null,
      delegation: { agentId: "a1", origin: { kind: "person", userId: "u2", name: "Ana" } },
    });
    const name = (id: string) => (id === "a1" ? "Theo" : undefined);
    expect(taskSubline(t, helper, "me", "Vê o log", name)).toBe(
      "Conversa entre agentes · a pedido de Theo · começou com Ana",
    );
    const boss = task({ runId: "r4", label: "Bugs", requester: null, helpers: 3 });
    expect(taskSubline(t, boss, "me", "Bugs")).toContain("3 ajudantes");
  });

  test("an agent's row: how its tasks stand, or queued when they only wait their turn", async () => {
    const t = await translator("pt-BR");
    expect(groupLine(t, { working: 1, waiting: 1 })).toEqual({
      mark: "working",
      text: "1 trabalhando · 1 espera você",
    });
    expect(groupLine(t, { working: 0, waiting: 2 })).toEqual({ mark: "waiting", text: "2 esperam você" });
    expect(groupLine(t, { working: 0, waiting: 0 })).toEqual({ mark: "queued", text: "Na fila" });
    expect(groupLine(t, { working: 0, waiting: 0 }, "Pausada: plano a 95% da semana").text).toBe(
      "Pausada: plano a 95% da semana",
    );
  });
});

describe("rows with a face (#41)", () => {
  const read = (f: string) => readFileSync(join(import.meta.dir, "../../src/features/task-manager", f), "utf8");

  test("a routine's task is a MediaRow: its agent, where and who asked on the face's line, the rest under them", () => {
    const screen = read("TaskManagerScreen.tsx");
    expect(screen).toContain("<AgentFace agentId={task.agentId} size={MEDIA_ROW.card.face} live={false} />");
    expect(screen).toMatch(/name=\{agent\}\s*meta=\{sub \|\| undefined\}\s*>/);
    // The row opens the task (stopping lives on its screen): the title whole, never cut, its state as words under it,
    // and a chevron, never a stop button squeezing the title.
    expect(screen).toMatch(
      /<Text variant="body">\{title\}<\/Text>\s*<StateLine task=\{task\} state=\{state\} now=\{now\} \/>\s*<\/MediaRow>/,
    );
    expect(screen).not.toMatch(/numberOfLines=\{\d\}[^>]*>\s*\{(title|line\.text)\}/);
    expect(screen).not.toContain("end={stop}");
    expect(screen).toContain('<Icon name="right" size={15} color={c.faint} />');
    expect(screen).toContain(
      'flatTask: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 16 }',
    );
  });

  test("an agent's tasks stay folded under its row until it is tapped; the row says how long, as its tasks do", () => {
    const screen = read("TaskManagerScreen.tsx");
    expect(screen).toContain("useState<ReadonlySet<string>>(() => new Set())");
    expect(screen).toContain("open={opened.has(g.agentId)}");
    expect(screen).toContain("open={opened.has(`by:");
    expect(screen).not.toContain("closed.has(");
    expect(screen).toContain("taskTime(t, groupLead(group), now)");
    // A task's time is its clock at work, how long it has waited otherwise: never "82:07:59".
    expect(read("parts.tsx")).toContain("taskTime(t, task, now)");
    expect(read("parts.tsx")).not.toContain("taskClock");
  });

  test("stopping several asks with the agent's face and the question on one line, what happens under them", () => {
    const parts = read("parts.tsx");
    expect(parts).toMatch(
      /<MediaRow\s*size="row"\s*face=\{<AgentFace agentId=\{agentId\} size=\{MEDIA_ROW\.row\.face\}/,
    );
    expect(parts).not.toContain("confirmHead");
  });
});

describe("what ended today", () => {
  test("how each ended, and who stopped it", async () => {
    const t = await translator("pt-BR");
    expect(endedText(t, ended({ runId: "a" }), "me")).toBe("Terminou");
    expect(endedText(t, ended({ runId: "b", status: "failed" }), "me")).toBe("Não conseguiu");
    const byMe = ended({ runId: "c", status: "canceled", stoppedBy: { userId: "me", name: "Bia" } });
    expect(endedText(t, byMe, "me")).toBe("Você parou");
    const byAna = ended({ runId: "d", status: "canceled", stoppedBy: { userId: "ana", name: "Ana" } });
    expect(endedText(t, byAna, "me")).toBe("Ana parou");
    expect(endedText(t, ended({ runId: "e", status: "canceled" }), "me")).toBe("Parada");
  });

  test("the latest first", () => {
    const list = [
      ended({ runId: "old", finishedAt: "2026-11-02T09:00:00.000Z" }),
      ended({ runId: "new", finishedAt: "2026-11-02T15:00:00.000Z" }),
    ];
    expect(endedLatestFirst(list).map((e) => e.runId)).toEqual(["new", "old"]);
  });
});

describe("an agent's tasks, from its DM's header", () => {
  const here = task({ runId: "here", createdAt: "2026-11-02T14:00:00.000Z" });
  const review = task({
    runId: "review",
    channelId: "c1",
    channelKind: "channel",
    channelName: "produto",
    status: "waiting_approval",
    createdAt: "2026-11-02T13:50:00.000Z",
  });
  const routine = task({
    runId: "routine",
    channelId: "room",
    background: true,
    routine: { id: "rt1", name: "Atualizar as dependências" },
    createdAt: "2026-11-02T13:00:00.000Z",
  });
  const other = task({ runId: "other", agentId: "infra", channelId: "c2" });
  const place = { channelId: "dm1", threadId: null };

  test("people's tasks first, then the routines', the ones asked here tagged; how many work, wait, can stop", () => {
    const view = agentTasksOf([here, review, routine, other], "dev", place, NONE);
    expect(view?.rows.map((r) => [r.task.runId, r.here])).toEqual([
      ["review", false],
      ["here", true],
      ["routine", false],
    ]);
    expect(view?.working).toBe(2);
    expect(view?.waiting).toBe(1);
    expect(view?.stoppable).toEqual(["review", "here", "routine"]);
  });

  test("one asked to stop, or one they may not stop, isn't stopped again by 'Parar todas'", () => {
    const view = agentTasksOf([here, { ...review, canStop: false }, routine], "dev", place, new Set(["here"]));
    expect(view?.stoppable).toEqual(["routine"]);
  });

  test("nothing while the agent has no tasks; nothing tagged when opened from nowhere", () => {
    expect(agentTasksOf([other], "dev", place, NONE)).toBeNull();
    expect(agentTasksOf([here], "dev", null, NONE)?.rows.map((r) => r.here)).toEqual([false]);
  });

  test("in a thread, here is that thread; the DM's main timeline is elsewhere", () => {
    const inThread = task({ runId: "thread", threadId: "t1" });
    expect(isHere(inThread, { channelId: "dm1", threadId: "t1" })).toBe(true);
    expect(isHere(here, { channelId: "dm1", threadId: "t1" })).toBe(false);
    const view = agentTasksOf([here, inThread], "dev", { channelId: "dm1", threadId: "t1" }, NONE);
    expect(view?.rows.filter((r) => r.here).map((r) => r.task.runId)).toEqual(["thread"]);
  });

  test("the header's count: the orbit while some work, the waiting mark otherwise, and who waits when both", () => {
    const both = agentTasksOf([here, review], "dev", place, NONE);
    expect(both && tasksBadge(both)).toEqual({ count: 2, mark: "working", waiting: 1, room: 1.9 });
    const waits = agentTasksOf([review], "dev", place, NONE);
    expect(waits && tasksBadge(waits)).toEqual({ count: 1, mark: "ok", waiting: null, room: 1.3 });
    const queued = agentTasksOf([{ ...here, status: "queued" }], "dev", place, NONE);
    expect(queued && tasksBadge(queued).mark).toBe("queued");
  });

  test("'Feitas hoje' counts what the agent finished, not what was stopped or failed", () => {
    const list = [
      ended({ runId: "a" }),
      ended({ runId: "b", status: "canceled" }),
      ended({ runId: "c", status: "failed" }),
      ended({ runId: "d", agentId: "infra" }),
    ];
    expect(doneTodayOf(list, "dev")).toBe(1);
  });

  test("its screen knows the conversation it came from", () => {
    expect(agentTasksHref("dev", { channelId: "dm1", threadId: null })).toBe("/agent-tasks/dev?channel=dm1");
    expect(agentTasksHref("dev", { channelId: "dm1", threadId: "t1" })).toBe("/agent-tasks/dev?channel=dm1&thread=t1");
    expect(agentTasksHref("dev", null)).toBe("/agent-tasks/dev");
  });
});

describe("a computer's line (ADR 0128)", () => {
  const now = Date.parse("2026-11-02T14:00:00.000Z");
  const full = { machineId: "m1", position: 2, of: 3, people: false, estimatedStartAt: null };

  test("a task waiting for room on its computer says its place, not just that the computer is full", async () => {
    const t = await translator("pt-BR");
    const inLine = task({ runId: "r1", status: "waiting_input", held: "computer_busy", line: full });
    const said = (x: ManagedTask) => taskStateWords(t, "pt-BR", x, rowState(x, NONE), now).state;
    expect(said(inLine)).toBe("Na fila · 2º");
    expect(said({ ...inLine, line: null })).toBe("Computador cheio");
    expect(said(task({ runId: "r2" }))).toBe("Trabalhando");
  });

  test("a computer on the task manager: full with how many wait, or room, and how many run", async () => {
    const t = await translator("pt-BR");
    expect(computerLine(t, { working: 3, inLine: 2 })).toBe("Cheio · 2 na fila · 3 trabalhando");
    expect(computerLine(t, { working: 1, inLine: 0 })).toBe("Tem espaço · 1 trabalhando");
    expect(computerLine(t, { working: 0, inLine: 0 })).toBe("Tem espaço");
  });

  test("under its place, when it should start, in the computer line's words; no made-up time without an estimate", async () => {
    const t = await translator("pt-BR");
    const soon = task({
      runId: "r1",
      status: "waiting_input",
      held: "computer_busy",
      line: { ...full, estimatedStartAt: "2026-11-02T14:03:00.000Z" },
    });
    const next = (x: ManagedTask) => taskStateWords(t, "pt-BR", x, rowState(x, NONE), now).next;
    expect(next(soon)).toBe("começa em ~3 min");
    expect(next({ ...soon, line: full })).toBe("Começa quando tiver espaço");
    expect(next(task({ runId: "r2" }))).toBeNull();
  });
});

describe("why a task waits", () => {
  const now = new Date(2026, 10, 5, 10, 0).getTime();
  const resetsAt = new Date(2026, 10, 7, 18, 0).toISOString();
  const wait = {
    code: "usage_pause",
    key: "plan:m1:claude_code:a1",
    plan: "Claude",
    model: null,
    scope: null,
    percent: 95,
    window: "seven_day",
    resetsAt,
    canContinue: true,
  };
  const routine = (runId: string, canContinue: boolean) =>
    task({
      runId,
      status: "waiting_input",
      held: "plan",
      background: true,
      wait: { ...wait, canContinue },
    });

  test("the row says the same as the web's: what holds it, when it's back", async () => {
    const t = await translator("pt-BR");
    const paused = routine("r1", true);
    expect(taskStateWords(t, "pt-BR", paused, rowState(paused, NONE), now)).toEqual({
      state: "Pausada: plano a 95% da semana",
      next: "Volta sáb às 18:00",
    });
  });

  test("the line over rows on the same limit, and who may continue", async () => {
    const t = await translator("pt-BR");
    const [group] = taskWaitGroups([routine("r1", true), routine("r2", false)]);
    if (!group) throw new Error("no group");
    expect(taskWaitGroupText(t, "pt-BR", group, now)).toBe(
      "2 rotinas pausadas: o plano do Claude está em 95% da semana e volta sáb às 18:00. O restante fica para as conversas.",
    );
    expect(group.continuable).toEqual(["r1"]);
  });
});

describe("navigation", () => {
  test("the task manager, a task and an agent's tasks are pushed screens, in the stack", () => {
    const layout = readFileSync(join(APP, "_layout.tsx"), "utf8");
    expect(layout).toContain(`name="task-manager/index" options={{ ...pushed, ...scrollUnder }}`);
    expect(layout).toContain(`name="task-manager/[runId]" options={{ ...pushed, ...scrollUnder }}`);
    expect(layout).toContain(`name="agent-tasks/[agentId]" options={{ ...pushed, ...scrollUnder }}`);
  });
});

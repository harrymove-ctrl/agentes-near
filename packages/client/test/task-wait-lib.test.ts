import { expect, test } from "bun:test";
import type { TFunction } from "i18next";
import type { ManagedTask, TaskWait } from "../src/api/types";
import {
  agentCardLine,
  delegationText,
  groupTasks,
  hiddenCount,
  taskPlace,
  taskTime,
  taskWaitGroups,
  taskWaitGroupText,
  taskWaitWords,
  taskWhere,
} from "../src/lib/task-manager";

/** Says the key and its values, so a test reads which words were picked. */
const t = ((key: string, values: Record<string, unknown> = {}) => {
  const { defaultValue: _, ...rest } = values;
  return Object.keys(rest).length ? `${key} ${JSON.stringify(rest)}` : key;
}) as unknown as TFunction;

const now = new Date(2026, 10, 5, 10, 0).getTime();
const resetsAt = new Date(2026, 10, 7, 18, 0).toISOString();
const wait = (over: Partial<TaskWait> = {}): TaskWait => ({
  code: "usage_pause",
  key: "plan:m1:claude_code:a1",
  plan: "Claude",
  model: null,
  scope: null,
  percent: 95,
  window: "seven_day",
  resetsAt,
  canContinue: true,
  ...over,
});
const task = (held: ManagedTask["held"], w: TaskWait | null, over: Partial<ManagedTask> = {}) =>
  ({ runId: "r1", status: "waiting_input", held, line: null, wait: w, background: true, ...over }) as ManagedTask;
const words = (x: ManagedTask, at = now) => taskWaitWords(t, "en", x, at);

test("not waiting: nothing to say", () => {
  expect(words(task(null, null, { status: "running" }))).toBeNull();
});

test("a pause says how far along and when it's back; past the reset, a moment; unknown, when it renews", () => {
  const paused = words(task("plan", wait()));
  expect(paused?.state).toContain("taskManager.wait.pausedPlan");
  expect(paused?.state).toContain('"percent":95');
  expect(paused?.next).toContain("taskManager.wait.back");
  expect(paused?.next).toContain("chat.usageWhen.on");
  expect(words(task("plan", wait()), Date.parse(resetsAt) + 1000)?.next).toContain("taskManager.wait.whenSoon");
  expect(words(task("plan", wait({ resetsAt: null })))?.next).toContain("taskManager.wait.whenRenews");
});

test("a limit: the plan's, a model's own, the region it needs, the budget", () => {
  const limit = { code: "plan_limit", percent: null, window: null };
  expect(words(task("plan", wait(limit)))?.state).toContain("taskManager.wait.planLimit");
  const own = wait({ ...limit, scope: "model", model: "GLM-5.3" });
  expect(words(task("plan", own))?.state).toContain("taskManager.wait.modelLimit");
  const region = words(task("plan", wait({ ...limit, scope: "region", model: "GLM-5.3" })));
  expect(region?.state).toContain("taskManager.wait.modelRegion");
  expect(region?.next).toBe("taskManager.wait.modelRegionNext");
  const off = words(task("plan", wait({ ...limit, scope: "off", model: "MiniMax M3" })));
  expect(off?.state).toContain("taskManager.wait.modelOff");
  expect(off?.next).toBe("taskManager.wait.modelOffNext");
  const inactive = words(task("plan", wait({ ...limit, scope: "inactive", model: "MiniMax M3" })));
  expect(inactive?.state).toBe("taskManager.wait.planInactive");
  expect(inactive?.next).toBe("taskManager.wait.planInactiveNext");
  const budget = wait({ code: "budget", percent: null, plan: null });
  expect(words(task("budget", budget))?.state).toBe("taskManager.wait.budgetOut");
  const reserved = words(task("budget", { ...budget, resetsAt: null }));
  expect(reserved?.state).toBe("taskManager.state.budget");
  expect(reserved?.next).toContain("taskManager.wait.whenSoon");
  const pausedReserved = words(task("budget", wait({ resetsAt: null, plan: null })));
  expect(pausedReserved?.state).toContain("taskManager.wait.pausedBudget");
  expect(pausedReserved?.next).toContain("taskManager.wait.whenSoon");
});

test("a wait on no limit: the agent's line of work, a computer gone, one not ready, a person", () => {
  const on = (code: string) => words(task("computer_offline", wait({ code, key: null })));
  expect(on("work_queue")?.state).toBe("taskManager.wait.workLine");
  expect(on("machine_offline")?.state).toBe("taskManager.state.computerOffline");
  expect(on("machine_dropped")?.next).toBe("taskManager.wait.computerOfflineNext");
  expect(on("not_logged_in")?.state).toBe("taskManager.wait.computerWait");
  expect(on("no_computer")?.state).toBe("taskManager.wait.computerWait");
  expect(words(task(null, null))?.next).toBe("taskManager.wait.answerNext");
  expect(words(task(null, null, { status: "waiting_approval" }))?.next).toBe("taskManager.wait.okNext");
});

test("Tempo: a clock at work or in the queue; waiting, how long since it paused, else since it started", () => {
  const ago = (ms: number) => ({
    startedAt: new Date(now - ms).toISOString(),
    createdAt: new Date(now - ms).toISOString(),
  });
  const hour = 3_600_000;
  expect(taskTime(t, task(null, null, { status: "running", ...ago(372_000) }), now)).toBe("6:12");
  expect(taskTime(t, task(null, null, { status: "queued", ...ago(hour + 130_000) }), now)).toBe("1:02:10");
  // Paused for two days of the 82 hours since it started: never "82:07:59".
  const paused = wait({ since: new Date(now - 50 * hour).toISOString() });
  expect(taskTime(t, task("plan", paused, ago(82 * hour)), now)).toBe('format.inDays {"count":2}');
  expect(taskTime(t, task("plan", wait(), ago(82 * hour)), now)).toBe('format.inDays {"count":3}');
  expect(taskTime(t, task(null, null, { status: "waiting_approval", ...ago(18 * 60_000) }), now)).toBe(
    'format.inMinutes {"count":18}',
  );
});

test("an older server sends no wait: the plain words, no second line", () => {
  expect(words(task("plan", null))).toEqual({ state: "taskManager.state.plan", next: null });
  expect(words(task("budget", null))).toEqual({ state: "taskManager.state.budget", next: null });
  expect(words(task("computer_offline", null))?.state).toBe("taskManager.state.computerOffline");
});

test("a group needs two rows on the same limit; a computer, a person or a region isn't one", () => {
  const two = [task("plan", wait(), { runId: "a" }), task("plan", wait({ percent: 97 }), { runId: "b" })];
  const [group] = taskWaitGroups(two);
  expect(group?.wait.percent).toBe(97);
  expect(group?.continuable).toEqual(["a", "b"]);
  expect(taskWaitGroups(two.slice(0, 1))).toEqual([]);
  expect(
    taskWaitGroups([task("plan", wait(), { runId: "a" }), task("plan", wait({ key: "other" }), { runId: "b" })]),
  ).toEqual([]);
  const region = wait({ code: "plan_limit", scope: "region" });
  expect(taskWaitGroups([task("plan", region), task("plan", region)])).toEqual([]);
  const off = wait({ code: "plan_limit", scope: "off" });
  expect(taskWaitGroups([task("plan", off), task("plan", off)])).toEqual([]);
  const reserved = wait({ code: "budget", key: "budget:a", percent: null, resetsAt: null });
  expect(taskWaitGroups([task("budget", reserved), task("budget", reserved)])).toEqual([]);
  const away = wait({ code: "machine_offline", key: null });
  expect(taskWaitGroups([task("computer_offline", away), task("computer_offline", away)])).toEqual([]);
});

test("the group's words: routines or tasks, by what holds them", () => {
  const group = (x: ManagedTask) => {
    const [g] = taskWaitGroups([x, { ...x, runId: "b" }]);
    return g ? taskWaitGroupText(t, "en", g, now) : "";
  };
  expect(group(task("plan", wait()))).toContain("taskManager.waitGroup.pausedPlan");
  expect(group(task("plan", wait()))).toContain("taskManager.waitGroup.routines");
  expect(group(task("plan", wait(), { background: false }))).toContain("taskManager.tasks");
  expect(group(task("budget", wait({ plan: null })))).toContain("taskManager.waitGroup.pausedBudget");
  expect(group(task("plan", wait({ code: "plan_limit", percent: null })))).toContain("taskManager.waitGroup.planLimit");
  const own = wait({ code: "plan_limit", percent: null, scope: "model", model: "GLM-5.3" });
  expect(group(task("plan", own))).toContain("taskManager.waitGroup.modelLimit");
  expect(group(task("budget", wait({ code: "budget", percent: null })))).toContain("taskManager.waitGroup.budgetOut");
});

test("a task agents asked of each other: its own section, by who asked, saying what started it", () => {
  const delegated = (runId: string, by: string): ManagedTask =>
    ({
      runId,
      agentId: "rio",
      status: "running",
      background: false,
      startedAt: new Date(now).toISOString(),
      createdAt: new Date(now).toISOString(),
      canStop: true,
      delegation: { agentId: by, origin: { kind: "person", userId: "me", name: "Ana" } },
    }) as ManagedTask;
  const asked = { ...delegated("r0", ""), delegation: null, agentId: "theo" };
  const out = groupTasks([asked, delegated("r1", "theo"), delegated("r2", "theo"), delegated("r3", "bia")]);
  expect(out.groups.map((g) => g.agentId)).toEqual(["theo"]);
  expect(out.delegated.map((g) => [g.agentId, g.tasks.length])).toEqual([
    ["theo", 2],
    ["bia", 1],
  ]);

  const name = (id: string) => (id === "theo" ? "Theo" : undefined);
  const by = delegated("r1", "theo");
  expect(delegationText(t, by, name, "me")).toBe('queue.purpose.agent {"name":"Theo"} · taskManager.delegated.fromYou');
  expect(delegationText(t, by, name, "other")).toContain('taskManager.delegated.fromPerson {"name":"Ana"}');
  const routine = { delegation: { agentId: "bia", origin: { kind: "routine" as const, name: "Bugs" } } };
  expect(delegationText(t, routine, name, "me")).toBe(
    'queue.purpose.someAgent · taskManager.delegated.fromRoutine {"name":"Bugs"}',
  );
  expect(delegationText(t, { delegation: { agentId: "theo", origin: { kind: "agent" } } }, name, "me")).toBe(
    'queue.purpose.agent {"name":"Theo"}',
  );
  expect(delegationText(t, { delegation: null }, name, "me")).toBeNull();
  expect(taskWhere(t, { routine: null, channelKind: "dm", channelName: null, betweenAgents: true })).toBe(
    "chat.consultPanel.whereDm",
  );
});

test("an agent busy out of the viewer's sight is never free: its card counts it, without saying what", () => {
  const hidden = { total: 3, working: 2, byAgent: { rio: 3 } };
  expect(hiddenCount(hidden, "rio")).toBe(3);
  expect(hiddenCount(hidden, "bia")).toBe(0);
  expect(hiddenCount(hidden, null)).toBe(3);
  expect(hiddenCount(undefined, null)).toBe(0);
  expect(agentCardLine(t, 0, 3)).toBe('taskManager.hiddenTasks {"count":3}');
  expect(agentCardLine(t, 1, 3)).toBe('taskManager.tasks {"count":4}');
  expect(agentCardLine(t, 0, 0)).toBe("taskManager.free");
});

test("a task with no title of its own is called by its place, said once", () => {
  const base = { routine: null, channelKind: "channel" as const, channelName: "eng", betweenAgents: false };
  expect(taskPlace(t, { ...base, label: null })).toBeNull();
  expect(taskPlace(t, { ...base, label: "Release 8 na loja" })).toBe("#eng");
});

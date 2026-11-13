import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import type { AgentAction, AppNotification, Routine, RoutineRun } from "../src/api/types";
import { actionTextValues } from "../src/lib/actions";
import { approvalOriginWords, approvalWhy, approvalWords } from "../src/lib/approval-origin";
import { openTarget } from "../src/lib/notifications";
import {
  busyOnComputer,
  healthWords,
  isStoppable,
  pausedFix,
  routineChannelOf,
  routineNotificationWords,
  routineStateTime,
  routineStateWords,
  runMessageLink,
  runOutcome,
  runPixelStatus,
  runPixels,
  runsPerDay,
  stopWordsKey,
  usageContinueBlock,
  usageContinueOffered,
  usageParts,
  usagePauseRefetchMs,
  whereItRuns,
} from "../src/lib/routine-view";

const run = (over: Partial<RoutineRun> & Pick<RoutineRun, "status">): RoutineRun => ({
  id: "run",
  at: "2026-10-23T09:00:00.000Z",
  code: null,
  summary: "",
  brain: "model",
  link: null,
  finishedAt: null,
  ...over,
});

const state = (over: Partial<Routine>) => ({
  state: "active" as Routine["state"],
  active: true,
  pausedReason: null,
  failuresInRow: 0,
  waitingFor: null,
  target: { type: "channel" as const, channelId: "c1" },
  trigger: { type: "event", event: "issue.created" } as Routine["trigger"],
  ...over,
});

describe("a routine's runs", () => {
  test("every status as a pixel; at work is the strip's own 'running'", () => {
    expect(runPixelStatus("reported")).toBe("ok");
    expect(runPixelStatus("silent")).toBe("silent");
    expect(runPixelStatus("failed")).toBe("failed");
    for (const s of ["canceled", "superseded", "missed", "skipped"] as const) expect(runPixelStatus(s)).toBe("skipped");
    for (const s of ["queued", "running", "waiting"] as const) expect(runPixelStatus(s)).toBeNull();
    expect(
      runPixels([run({ status: "running" }), run({ status: "reported", weight: 0.5 }), run({ status: "missed" })]).map(
        (p) => [p.status, p.weight],
      ),
    ).toEqual([
      ["ok", 0.5],
      ["skipped", undefined],
    ]);
  });

  test("outcomes in plain words: the status, or why it ended (its code)", () => {
    const names: Record<string, string> = { "u-joao": "João" };
    const say = (r: RoutineRun) => runOutcome(r, (id) => names[id] ?? null);
    expect(say(run({ status: "reported" }))).toEqual({ key: "routines.outcome.reported", values: {} });
    // A provider's failure by its cause, with the conversation's words; without the provider, the plain failure.
    const params = { provider: "OpenRouter", detail: "Insufficient credits" };
    expect(say(run({ status: "failed", code: "provider_no_credit", codeParams: params }))).toEqual({
      key: "agentPage.activity.errors.provider_no_credit",
      values: params,
      fallback: "routines.outcome.failed",
    });
    expect(say(run({ status: "failed", code: "provider_no_credit" })).key).toBe("routines.outcome.failed");
    // A run that told people says so, whatever its code (its final text became the report).
    expect(say(run({ status: "reported", code: "auto_report" })).key).toBe("routines.outcome.reported");
    expect(say(run({ status: "silent" })).key).toBe("routines.outcome.silent");
    expect(say(run({ status: "queued" })).key).toBe("routines.outcome.queued");
    expect(say(run({ status: "waiting", approvalId: "ap" })).key).toBe("routines.outcome.waitingApproval");
    expect(say(run({ status: "waiting", code: "waiting_computer" })).key).toBe("routines.outcome.waitingComputer");
    expect(say(run({ status: "waiting" })).key).toBe("routines.outcome.waiting");
    expect(say(run({ status: "skipped", code: "previous_running" }))).toEqual({
      key: "routines.code.previous_running",
      values: {},
      fallback: "routines.outcome.skipped",
    });
    expect(say(run({ status: "superseded", code: "superseded" })).key).toBe("routines.code.superseded");
    expect(say(run({ status: "missed", code: "stale" })).key).toBe("routines.code.stale");
    expect(say(run({ status: "failed", code: "budget_exceeded" })).key).toBe("routines.code.budget_exceeded");
    expect(say(run({ status: "failed", code: "no_report" })).key).toBe("routines.code.no_report");
    // A report it couldn't deliver says why, not "Não rodou"; every code the ledger writes has its words.
    expect(say(run({ status: "skipped", code: "creator_no_access" })).key).toBe("routines.code.creator_no_access");
    expect(say(run({ status: "canceled", code: "creator_left" })).key).toBe("routines.code.creator_left");
    for (const code of [
      "empty_reply",
      "model_refused",
      "credential_wrong_provider",
      "model_unlisted",
      "gave_up",
      "cli_failed",
    ])
      expect(say(run({ status: "failed", code })).key).toBe(`routines.code.${code}`);
    // Stopped by a person: their name; an unknown id as is; nobody named: "alguém".
    expect(say(run({ status: "canceled", code: "stopped", codeParams: { by: "u-joao" } }))).toEqual({
      key: "routines.code.stoppedBy",
      values: { name: "João" },
    });
    expect(say(run({ status: "canceled", code: "stopped", codeParams: { by: "u-x" } })).values).toEqual({
      name: "u-x",
    });
    expect(say(run({ status: "canceled", code: "stopped" })).key).toBe("routines.code.stopped");
    // A code the app doesn't know: the status's own words.
    expect(say(run({ status: "failed", code: "brand_new" }))).toEqual({ key: "routines.outcome.failed", values: {} });
    expect(say(run({ status: "skipped" })).key).toBe("routines.outcome.skipped");
  });

  test("Abrir na conversa: the agent's message, in its thread when it has one", () => {
    expect(runMessageLink(run({ status: "reported" }))).toBeNull();
    expect(
      runMessageLink(run({ status: "reported", link: { channelId: "c1", threadId: null, messageId: "m1" } })),
    ).toEqual({ channelId: "c1", threadId: null, messageId: "m1" });
    expect(
      runMessageLink(run({ status: "reported", link: { channelId: "c1", threadId: "t1", messageId: "m2" } })),
    ).toEqual({ channelId: "c1", threadId: "t1", messageId: "m2" });
  });
});

describe("a routine's state and its one-tap fix", () => {
  test("paused near its plan's limit: until its reset, quietly; who may continue it now", () => {
    const now = new Date(2026, 10, 1, 11, 0);
    const resetsAt = new Date(2026, 10, 1, 14, 0).toISOString();
    const t = ((key: string) => key) as unknown as TFunction;
    const plan = state({ state: "usage_paused", usagePause: { source: "plan", resetsAt, extraOff: false } });
    const until = routineStateTime(t, "pt-BR", plan, now);
    expect(until).toBe("14:00");
    expect(routineStateWords(plan, until)).toEqual({
      key: "routines.state.usagePaused",
      values: { until: "14:00" },
      icon: "pause",
      tone: "neutral",
    });
    const budget = state({ state: "usage_paused", usagePause: { source: "budget", resetsAt, extraOff: false } });
    expect(routineStateWords(budget, until).key).toBe("routines.state.usagePausedBudget");
    const unknown = state({ state: "usage_paused", usagePause: { source: "plan", resetsAt: null, extraOff: false } });
    expect(routineStateTime(t, "pt-BR", unknown, now)).toBe("");
    expect(routineStateWords(unknown, "").key).toBe("routines.state.usagePausedUnknown");
    expect(usageContinueBlock({ canManage: true, usagePause: plan.usagePause })).toBeNull();
    expect(usageContinueBlock({ canManage: false, usagePause: plan.usagePause })).toBe("forbidden");
    expect(usageContinueBlock({ canManage: true, usagePause: { source: "plan", resetsAt, extraOff: true } })).toBe(
      "extra_off",
    );
    expect(
      usageContinueBlock({
        canManage: true,
        usagePause: { source: "plan", resetsAt, extraOff: false, extraUsedUp: true },
      }),
    ).toBe("extra_used_up");
  });

  test("waiting at the plan's own limit: it says which plan and when it runs; Don't run it, no Continuar", () => {
    const now = new Date(2026, 10, 2, 8, 35);
    const resetsAt = new Date(2026, 10, 2, 9, 0).toISOString();
    const t = ((key: string) => key) as unknown as TFunction;
    const waiting = state({
      state: "usage_paused",
      usagePause: { source: "plan", resetsAt, limit: true, plan: "Claude", extraOff: false },
    });
    const until = routineStateTime(t, "pt-BR", waiting, now);
    expect(routineStateWords(waiting, until)).toEqual({
      key: "routines.state.waitingPlan",
      values: { plan: "Claude", until: "09:00" },
      icon: "pause",
      tone: "neutral",
    });
    const unknown = state({
      state: "usage_paused",
      usagePause: { source: "plan", resetsAt: null, limit: true, plan: "ChatGPT", extraOff: false },
    });
    expect(routineStateWords(unknown, "")).toMatchObject({
      key: "routines.state.waitingPlanUnknown",
      values: { plan: "ChatGPT", until: "" },
    });
    expect(usageContinueOffered(waiting)).toBe(false);
    expect(
      usageContinueOffered(state({ state: "usage_paused", usagePause: { source: "plan", resetsAt, extraOff: false } })),
    ).toBe(true);
    expect(stopWordsKey(waiting)).toBe("routines.usagePause.dontRun");
    expect(stopWordsKey({ state: "running" })).toBe("routines.stop");
    // Its run in the timeline: waiting on the plan, not "working now".
    expect(runOutcome(run({ status: "waiting", code: "waiting_plan" })).key).toBe("routines.outcome.waitingPlan");
    expect(runOutcome(run({ status: "waiting", code: "waiting_budget" })).key).toBe("routines.outcome.waitingBudget");
  });

  test("a run paused near its limit is stopped with Parar, and the list is read again at its reset", () => {
    expect(isStoppable({ state: "usage_paused" })).toBe(true);
    expect(isStoppable({ state: "running" })).toBe(true);
    expect(isStoppable({ state: "waiting_person" })).toBe(false);
    const now = Date.parse("2026-11-01T11:00:00.000Z");
    const pause = (resetsAt: string | null) => ({ source: "plan" as const, resetsAt, extraOff: false });
    expect(usagePauseRefetchMs(undefined, now)).toBe(false);
    expect(usagePauseRefetchMs([{ state: "active", usagePause: null }], now)).toBe(false);
    expect(usagePauseRefetchMs([{ state: "usage_paused", usagePause: pause(null) }], now)).toBe(false);
    expect(
      usagePauseRefetchMs(
        [
          { state: "usage_paused", usagePause: pause("2026-11-01T14:00:00.000Z") },
          { state: "usage_paused", usagePause: pause("2026-11-01T12:00:00.000Z") },
        ],
        now,
      ),
    ).toBe(3_600_000 + 1000);
    // Already past: its run picks up within minutes, read again every 30 s (not every second).
    expect(usagePauseRefetchMs([{ state: "usage_paused", usagePause: pause("2026-11-01T10:00:00.000Z") }], now)).toBe(
      30_000,
    );
  });

  test("the chip for each state", () => {
    expect(routineStateWords(state({}))).toMatchObject({ key: "routines.state.active", tone: "neutral" });
    expect(routineStateWords(state({ state: "running" }))).toMatchObject({ key: "routines.state.running" });
    expect(routineStateWords(state({ state: "failing", failuresInRow: 3 }))).toMatchObject({
      key: "routines.state.failing",
      values: { count: 3 },
      tone: "waiting",
    });
    const mac = { machineId: "m", machineName: "MacBook do Walter", since: "2026-10-23T08:00:00.000Z" };
    expect(routineStateWords(state({ state: "waiting_computer", waitingFor: mac }), "08:00", true)).toMatchObject({
      key: "routines.state.waitingComputerSince",
      values: { machine: "MacBook do Walter", since: "08:00" },
    });
    // The workspace's only computer (the Cloud's own): "Esperando o computador desde 08:00".
    expect(routineStateWords(state({ state: "waiting_computer", waitingFor: mac }), "08:00")).toMatchObject({
      key: "routines.state.waitingAnyComputerSince",
      values: { since: "08:00" },
    });
    expect(routineStateWords(state({ state: "waiting_computer" }), "", true).key).toBe(
      "routines.state.waitingAnyComputer",
    );
    expect(routineStateWords(state({ state: "waiting_person" })).key).toBe("routines.state.waitingPerson");
    // Its event comes through a webhook the workspace doesn't have: it can't run yet, and says whose.
    const pr = { type: "event", event: "github.pr_opened" } as const;
    expect(routineStateWords(state({ state: "needs_webhook", trigger: pr }))).toMatchObject({
      key: "routines.state.needsWebhook",
      values: { provider: "GitHub" },
      icon: "alert",
      tone: "waiting",
    });
    const sentry = { type: "event", event: "sentry.issue_created" } as const;
    expect(routineStateWords(state({ state: "needs_webhook", trigger: sentry })).values).toEqual({
      provider: "Sentry",
    });
    expect(
      routineStateWords(state({ state: "paused", active: false, pausedReason: "agent_not_in_channel" })),
    ).toMatchObject({ key: "routines.pausedReason.agent_not_in_channel", tone: "waiting" });
    // Paused by a person, or for a reason the app doesn't know: a plain pause.
    expect(routineStateWords(state({ state: "paused", active: false }))).toMatchObject({
      key: "routines.state.paused",
      tone: "neutral",
    });
    expect(routineStateWords(state({ state: "paused", active: false, pausedReason: "new_reason" })).key).toBe(
      "routines.state.paused",
    );
  });

  test("add the agent back, take it over, or resume", () => {
    const paused = (pausedReason: string | null, target: Routine["target"] = { type: "channel", channelId: "c1" }) =>
      pausedFix({ active: false, pausedReason, target });
    expect(paused("agent_not_in_channel")).toBe("add_agent");
    // A DM has no channel to add it to.
    expect(paused("agent_not_in_channel", { type: "dm" })).toBeNull();
    expect(paused("creator_left")).toBe("take_over");
    expect(paused("creator_no_access")).toBe("take_over");
    expect(paused("audience")).toBe("take_over");
    expect(paused("agent_archived")).toBeNull();
    expect(paused("failing")).toBe("resume");
    expect(paused(null)).toBe("resume");
    expect(pausedFix({ active: true, pausedReason: null, target: { type: "dm" } })).toBeNull();
    expect(routineChannelOf({ type: "conversation", channelId: "c2", threadId: "t" })).toBe("c2");
    expect(routineChannelOf({ type: "artifact" })).toBeNull();
  });
});

describe("a routine's week", () => {
  test("health: OK counts reports and nothing-new; skips include missed slots", () => {
    expect(healthWords({ ok: 10, silent: 2, failed: 1, skipped: 1, missed: 1, total: 15 })).toEqual([
      { key: "routines.health.ok", values: { ok: 12, total: 15 } },
      { key: "routines.health.skipped", values: { count: 2 } },
      { key: "routines.health.failed", values: { count: 1 } },
    ]);
    expect(healthWords({ ok: 14, silent: 0, failed: 0, skipped: 0, missed: 0, total: 14 })).toHaveLength(1);
    expect(healthWords({ ok: 0, silent: 0, failed: 0, skipped: 0, missed: 0, total: 0 })).toBeNull();
  });

  test("where it runs, and its usage: tokens on a plan, cost on the API, never money for members", () => {
    // The computer by its name alone, only where the workspace has more than one; else nothing to say.
    expect(whereItRuns({ kind: "claude_code", machineName: "MacBook do Walter" }, true)).toBe("MacBook do Walter");
    expect(whereItRuns({ kind: "claude_code", machineName: "Computador da Acme" }, false)).toBeNull();
    expect(whereItRuns({ kind: "model", machineName: null }, true)).toBeNull();
    const usage = (billedTo: Routine["usage"]["billedTo"]) => ({
      runs: 7,
      tokens: 50_000,
      costNanoUsd: 420_000_000,
      billedTo,
    });
    expect(usageParts(usage("plan"), true)).toEqual({ runs: 7, tokens: 50_000, costUsd: null });
    expect(usageParts(usage("api"), true)).toEqual({ runs: 7, tokens: null, costUsd: 0.42 });
    expect(usageParts(usage("mixed"), true)).toEqual({ runs: 7, tokens: 50_000, costUsd: 0.42 });
    expect(usageParts(usage("api"), false)).toEqual({ runs: 7, tokens: null, costUsd: null });
    expect(usageParts({ ...usage("api"), runs: 0 }, true)).toBeNull();
  });

  test("how often it wakes someone's computer", () => {
    expect(runsPerDay({ freq: "hourly", interval: 1, times: ["00:15"] })).toBe(24);
    expect(runsPerDay({ freq: "hourly", interval: 3, times: ["00:15"] })).toBe(8);
    expect(runsPerDay({ freq: "daily", times: ["09:00", "18:00"] })).toBe(2);
    expect(runsPerDay({ freq: "once", times: ["09:00"] })).toBe(1);
    expect(runsPerDay(null, "*/15 * * * *")).toBe(96);
    expect(runsPerDay(null, "0 9 * * 1-5")).toBe(1);
    const mac = { kind: "claude_code", machineName: "MacBook do Walter" };
    const two = { selfHost: true, namesComputer: true };
    expect(busyOnComputer(mac, 24, two)).toEqual({
      key: "routines.busyComputer",
      values: { count: 24, machine: "MacBook do Walter" },
    });
    // A server with one computer: it still has to stay on, unnamed.
    expect(busyOnComputer(mac, 24, { selfHost: true, namesComputer: false })).toEqual({
      key: "routines.busyAnyComputer",
      values: { count: 24 },
    });
    expect(busyOnComputer({ kind: "codex", machineName: null }, 96, two)?.key).toBe("routines.busyAnyComputer");
    expect(busyOnComputer(mac, 8, two)).toBeNull();
    // The Cloud's own computer is always on.
    expect(busyOnComputer(mac, 24, { selfHost: false, namesComputer: false })).toBeNull();
    // The API doesn't wake anyone's computer.
    expect(busyOnComputer({ kind: "model", machineName: null }, 96, two)).toBeNull();
    expect(busyOnComputer(undefined, 96, two)).toBeNull();
  });
});

describe("approvals asked while nobody watched", () => {
  test("the routine that asked, or nobody; the why trimmed", () => {
    expect(approvalOriginWords({ origin: { kind: "routine", routineId: "r", routineName: "Revisar PRs" } })).toEqual({
      key: "approval.origin.routine",
      values: { name: "Revisar PRs" },
    });
    expect(approvalOriginWords({ origin: { kind: "unattended" } })).toEqual({
      key: "approval.origin.unattended",
      values: {},
    });
    expect(approvalOriginWords({ origin: null })).toBeNull();
    expect(approvalOriginWords({})).toBeNull();
    expect(approvalWhy({ why: "  O teste passou.  " })).toBe("O teste passou.");
    expect(approvalWhy({ why: "   " })).toBeNull();
    expect(approvalWhy({})).toBeNull();
    // A card draws the agent's marks: its why on one line keeps them, where a preview's loses them.
    expect(approvalWords({ why: "  Rodo `bun test`\n**agora**.  " })).toBe("Rodo `bun test` **agora**.");
    expect(approvalWords({ why: "   " })).toBeNull();
    expect(approvalWords({})).toBeNull();
  });
});

describe("routine notifications in the person's words", () => {
  const n = (kind: AppNotification["kind"], reason?: string) => ({ kind, latest: reason ? { reason } : {} });

  test("a failure by its run's code, else the plain failure; a pause by its reason", () => {
    expect(routineNotificationWords(n("routine_failed", "budget_exceeded"))).toEqual({
      key: "routines.code.budget_exceeded",
      values: {},
      fallback: "routines.outcome.failed",
    });
    expect(routineNotificationWords(n("routine_failed", "brand_new"))?.key).toBe("routines.outcome.failed");
    expect(routineNotificationWords(n("routine_failed"))?.key).toBe("routines.outcome.failed");
    expect(routineNotificationWords(n("routine_paused", "agent_not_in_channel"))).toEqual({
      key: "routines.pausedReason.agent_not_in_channel",
      values: {},
    });
    // A pause without a reason keeps its own text; other kinds have none.
    expect(routineNotificationWords(n("routine_paused"))).toBeNull();
    expect(routineNotificationWords(n("mention", "failing"))).toBeNull();
  });
});

describe("routine notifications open where they belong", () => {
  const n = (over: Partial<AppNotification> & Pick<AppNotification, "kind">): AppNotification => ({
    id: "n",
    waiting: false,
    actors: [{ type: "agent", id: "atlas" }],
    count: 1,
    source: { routineId: "rt1", label: "Sentry diário" },
    latest: {},
    readAt: null,
    doneAt: null,
    snoozedUntil: null,
    createdAt: "2026-10-23T09:00:00.000Z",
    updatedAt: "2026-10-23T09:00:00.000Z",
    ...over,
  });

  test("what it found: the agent's message in its conversation", () => {
    const told = { routineId: "rt1", channelId: "c1" };
    expect(openTarget(n({ kind: "routine_finished", source: { ...told, messageId: "m1" } }))).toEqual({
      to: "/org/$orgId/c/$channelId",
      params: { channelId: "c1" },
      search: { m: "m1" },
    });
    expect(openTarget(n({ kind: "routine_finished", source: { ...told, threadId: "t1" } }))).toEqual({
      to: "/org/$orgId/threads/$threadId",
      params: { threadId: "t1" },
    });
    // No message to open: the routine itself.
    expect(openTarget(n({ kind: "routine_finished" }))).toEqual({
      to: "/org/$orgId/routines",
      search: { open: "rt1" },
    });
  });

  test("its trouble: the routine in Rotinas, even when it names a conversation", () => {
    for (const kind of ["routine_failed", "routine_paused", "routine_stalled"] as const) {
      expect(openTarget(n({ kind, source: { routineId: "rt1", channelId: "c1", machineId: "mac" } }))).toEqual({
        to: "/org/$orgId/routines",
        search: { open: "rt1" },
      });
    }
    expect(openTarget(n({ kind: "routine_paused", source: {} }))).toEqual({ to: "/org/$orgId/routines" });
  });
});

describe("the routine.created receipt", () => {
  const t = ((key: string) => key) as unknown as TFunction;
  const created = (params: AgentAction["params"]) =>
    actionTextValues({ kind: "routine.created", target: { type: "routine", id: "r", title: "Bom dia" }, params }, t);

  test("the schedule from its rule in the person's language; never the server's English", () => {
    const rule = { freq: "daily" as const, times: ["09:00"], timezone: "America/Sao_Paulo" };
    const params = { name: "Bom dia", schedule: "Every day at 09:00", rule };
    expect(
      actionTextValues({ kind: "routine.created", target: { type: "routine", id: "r" }, params }, t, undefined, {
        schedule: (r) => `todo dia às ${r.times?.[0]}`,
      }),
    ).toEqual({ name: "Bom dia", schedule: "todo dia às 09:00" });
    // Without a way to say the rule (or without a rule): just the name.
    expect(created(params)).toEqual({ name: "Bom dia", context: "bare" });
    expect(created({ name: "Bom dia", schedule: "Every day at 09:00" })).toEqual({ name: "Bom dia", context: "bare" });
  });
});

test("a routine that couldn't call an agent opens the agent's page, where who talks to it is set", () => {
  expect(
    openTarget({
      kind: "agent_unreached",
      source: { routineId: "r1", agentId: "a1", userId: "u1", channelId: "c1", messageId: "m1" },
    } as AppNotification),
  ).toEqual({ to: "/org/$orgId/agents/$agentId", params: { agentId: "a1" } });
});

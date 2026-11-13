import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Routine, RoutineRun } from "@agenteschat/client";
import {
  cleanFilter,
  draftChanges,
  draftInput,
  draftOf,
  draftTrigger,
  everyMinutes,
  futureRuns,
  hasFired,
  horizonLanes,
  horizonPos,
  horizonRange,
  horizonTicks,
  inboxOf,
  isAtWork,
  isDoneOnce,
  isEventDriven,
  isPaused,
  laneTag,
  mailTrouble,
  nextLine,
  routineAgents,
  routineSections,
  routineTitle,
  ruleOf,
  runCaption,
  targetChoice,
  targetIcon,
  toastParts,
  whenIcon,
  zoneOf,
} from "../../src/features/routines/logic";
import {
  defaultRule,
  fromApiRule,
  onceAt,
  onceRule,
  proposedRoutineWhen,
  type RecurrenceRule,
  ruleSentence,
  runLabel,
  toApiRule,
  upcomingLabels,
} from "../../src/features/routines/rule";
import { translator } from "./fixtures";

const SP = "America/Sao_Paulo";
const NOW = new Date("2026-10-28T15:00:00.000Z");
const later = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const daily = {
  type: "schedule" as const,
  rule: { freq: "daily" as const, interval: 1, times: ["09:00"], timezone: SP, start: "2026-10-01" },
  cron: "0 9 * * *",
  timezone: SP,
  description: "Every day at 09:00",
};

function routine(over: Partial<Routine> & { id: string }): Routine {
  return {
    name: "Resumo do dia",
    agentId: "dev",
    prompt: "Resuma o que aconteceu no canal.",
    target: { type: "channel", channelId: "c1" },
    trigger: daily,
    active: true,
    nextRunAt: null,
    createdAt: "2026-10-01T12:00:00.000Z",
    access: "read",
    report: "when_new",
    pausedReason: null,
    failuresInRow: 0,
    state: "active",
    waitingFor: null,
    brain: { kind: "model", machineName: null },
    health: { ok: 0, silent: 0, failed: 0, skipped: 0, missed: 0, total: 0 },
    canSeeDetails: true,
    canManage: true,
    lastRun: null,
    recentRuns: [],
    usage: { runs: 0, tokens: 0, costNanoUsd: 0, billedTo: "api" },
    ...over,
  };
}

function run(over: Partial<RoutineRun> & Pick<RoutineRun, "id" | "at" | "status">): RoutineRun {
  return { code: null, summary: "", brain: null, link: null, finishedAt: null, ...over };
}

const once = (at: string) => ({ type: "once" as const, at, timezone: SP, description: "" });
const event = { type: "event" as const, event: "github.pr_opened" as const };
const email = { type: "email" as const, accountId: "m1", folder: "INBOX", filter: {} };
const webhook = { type: "webhook" as const, url: "https://app.agentes.test/api/hooks/x", signed: false };

describe("what a routine is", () => {
  test("a title: the name, or the first line of a prompt it was named with", () => {
    expect(routineTitle({ name: "Resumo diário", prompt: "Resuma o dia" })).toBe("Resumo diário");
    const chat = "Primeira linha curta\nsegunda linha com mais detalhes";
    expect(routineTitle({ name: chat, prompt: chat })).toBe("Primeira linha curta");
    const words = (n: number) => Array.from({ length: n }, () => "abcdefghi").join(" ");
    expect(routineTitle({ name: words(7), prompt: words(7) })).toBe(`${words(6)}…`);
    // A name over 80 characters is cut too, whatever the prompt.
    expect(routineTitle({ name: words(9), prompt: "x" })).toBe(`${words(6)}…`);
  });

  test("every N minutes, kept as a cron", () => {
    expect(everyMinutes("*/30 * * * *")).toBe(30);
    expect(everyMinutes(" */15 * * * * ")).toBe(15);
    expect(everyMinutes("* * * * *")).toBe(1);
    expect(everyMinutes("0 9 * * 1")).toBeNull();
  });

  test("live, paused, a one-off that ran, at work, a mailbox in trouble", () => {
    const fired = routine({ id: "o", trigger: once(later(-DAY)), active: false });
    expect([hasFired(fired), isDoneOnce(fired), isPaused(fired)]).toEqual([true, true, false]);
    // While its run works, a fired one-off is still live.
    expect(isDoneOnce({ ...fired, state: "running" })).toBe(false);
    expect(isPaused(routine({ id: "p", active: false }))).toBe(true);
    const states: Routine["state"][] = ["running", "waiting_person", "waiting_computer", "failing"];
    expect(states.map((state) => isAtWork({ state }))).toEqual([true, true, true, false]);
    expect(mailTrouble(routine({ id: "e", trigger: { ...email, status: "needs_reconnect" } }))).toBe("needs_reconnect");
    expect(mailTrouble(routine({ id: "e", trigger: { ...email, status: "active" } }))).toBeNull();
    expect(mailTrouble(routine({ id: "s" }))).toBeNull();
  });

  test("icons: where it delivers and what starts it", () => {
    expect(targetIcon({ type: "channel", channelId: "c1" })).toBe("hash");
    expect(targetIcon({ type: "dm" })).toBe("chat");
    expect(targetIcon({ type: "conversation", channelId: "c1", threadId: "t1" })).toBe("reply");
    expect(targetIcon({ type: "conversation", channelId: "c1", threadId: null })).toBe("hash");
    expect(targetIcon({ type: "artifact" })).toBe("doc");
    expect(whenIcon(routine({ id: "a", trigger: event }))).toBe("bolt");
    expect(whenIcon(routine({ id: "a", trigger: email }))).toBe("mail");
    const reminder = { type: "conversation" as const, channelId: "c1", threadId: null, reminder: true };
    expect(whenIcon(routine({ id: "a", trigger: once(later(HOUR)), target: reminder }))).toBe("bell");
    expect(whenIcon(routine({ id: "a", trigger: once(later(HOUR)) }))).toBe("clock");
    expect(whenIcon(routine({ id: "a" }))).toBe("clock");
  });
});

describe("the list", () => {
  const a = routine({ id: "a", name: "Resumo do dia" });
  const b = routine({ id: "b", name: "Backup", agentId: "infra", active: false });
  const c = routine({ id: "c", name: "Revisar PRs", trigger: event });
  const d = routine({ id: "d", name: "Lembrete", agentId: "infra", trigger: once(later(-DAY)), active: false });
  const e = routine({ id: "e", name: "Faturas", agentId: "infra", trigger: email });
  const list = [a, b, c, d, e];
  const whenOf = (r: Routine) => r.trigger.type;
  const ids = (rs: Routine[]) => rs.map((r) => r.id);

  test("everything: live, paused and the one-offs that ran apart, with the counts", () => {
    const s = routineSections(list, { status: "all", agentId: null, query: "" }, whenOf);
    expect([ids(s.live), ids(s.paused), ids(s.done)]).toEqual([["a", "c", "e"], ["b"], ["d"]]);
    expect(s.counts).toEqual({ all: 4, active: 3, paused: 1, event: 2 });
    expect(s.filtered).toBe(false);
  });

  test("a status narrows the groups, not the counts", () => {
    const s = routineSections(list, { status: "event", agentId: null, query: "" }, whenOf);
    expect([ids(s.live), ids(s.paused)]).toEqual([["c", "e"], []]);
    expect(s.counts.all).toBe(4);
    expect(s.filtered).toBe(true);
    expect(ids(routineSections(list, { status: "paused", agentId: null, query: "" }, whenOf).paused)).toEqual(["b"]);
  });

  test("an agent and a search narrow everything, the counts too", () => {
    const s = routineSections(list, { status: "all", agentId: "infra", query: "" }, whenOf);
    expect([ids(s.live), ids(s.paused), ids(s.done)]).toEqual([["e"], ["b"], ["d"]]);
    expect(s.counts).toEqual({ all: 2, active: 1, paused: 1, event: 1 });
    expect(ids(routineSections(list, { status: "all", agentId: null, query: " BACKUP " }, whenOf).paused)).toEqual([
      "b",
    ]);
    // The "when" in words is searched too.
    expect(ids(routineSections(list, { status: "all", agentId: null, query: "email" }, whenOf).live)).toEqual(["e"]);
  });

  test("the agents with routines, once each, in order", () => {
    expect(routineAgents(list)).toEqual(["dev", "infra"]);
  });
});

describe("the row's lines", () => {
  test("the next run: within the hour, within 20 hours, else the day", () => {
    const at = (ms: number) => nextLine(routine({ id: "r", nextRunAt: later(ms) }), NOW);
    expect(at(30_000)).toEqual({ kind: "soon" });
    expect(at(MIN)).toEqual({ kind: "soon" });
    expect(at(10 * MIN + 5_000)).toEqual({ kind: "minutes", minutes: 10 });
    expect(at(2 * HOUR + 10 * MIN)).toEqual({ kind: "hours", h: 2, m: 10 });
    expect(at(3 * HOUR)).toEqual({ kind: "hours", h: 3, m: 0 });
    expect(at(25 * HOUR)).toEqual({ kind: "at", iso: later(25 * HOUR) });
    expect(nextLine(routine({ id: "r" }), NOW)).toEqual({ kind: "none" });
  });

  test("working, a one-off that ran or was cancelled, paused, an event's week", () => {
    expect(nextLine(routine({ id: "r", state: "running", nextRunAt: later(HOUR) }), NOW)).toEqual({ kind: "running" });
    const ran = run({ id: "x", at: later(-HOUR), status: "reported" });
    const fired = routine({ id: "o", trigger: once(later(-HOUR)), active: false, lastRun: ran });
    expect(nextLine(fired, NOW)).toEqual({ kind: "fired", at: ran.at });
    expect(nextLine({ ...fired, lastRun: null }, NOW)).toEqual({ kind: "canceled" });
    expect(nextLine(routine({ id: "p", active: false, nextRunAt: later(HOUR) }), NOW)).toEqual({ kind: "paused" });
    const recentRuns = [
      run({ id: "1", at: later(-HOUR), status: "reported" }),
      run({ id: "2", at: later(-2 * DAY), status: "silent" }),
      run({ id: "3", at: later(-8 * DAY), status: "reported" }),
    ];
    expect(nextLine(routine({ id: "ev", trigger: event, recentRuns }), NOW)).toEqual({ kind: "event", week: 2 });
    expect(nextLine(routine({ id: "em", trigger: email }), NOW)).toEqual({ kind: "email", week: 0 });
  });

  test("the runs' caption", () => {
    expect(runCaption(routine({ id: "r", state: "running" }))).toEqual({ kind: "running" });
    expect(runCaption(routine({ id: "r" }))).toEqual({ kind: "never" });
    const t0 = later(-3 * HOUR);
    const t1 = later(-2 * HOUR);
    const t2 = later(-HOUR);
    const silent = [
      run({ id: "3", at: t2, status: "silent" }),
      run({ id: "2", at: t1, status: "silent" }),
      run({ id: "1", at: t0, status: "reported" }),
    ];
    expect(runCaption(routine({ id: "r", recentRuns: silent }))).toEqual({ kind: "silentOf", count: 2, total: 3 });
    const stopped = [run({ id: "2", at: t1, status: "canceled" }), run({ id: "1", at: t0, status: "reported" })];
    expect(runCaption(routine({ id: "r", recentRuns: stopped }))).toEqual({ kind: "stopped", at: t1 });
    expect(runCaption(routine({ id: "r", recentRuns: [run({ id: "1", at: t0, status: "failed" })] }))).toEqual({
      kind: "last",
      status: "failed",
      at: t0,
    });
    // A run still at work isn't the last one; without recent runs, the last run.
    const working = [run({ id: "2", at: t1, status: "queued" }), run({ id: "1", at: t0, status: "reported" })];
    expect(runCaption(routine({ id: "r", recentRuns: working }))).toEqual({ kind: "last", status: "ok", at: t0 });
    expect(runCaption(routine({ id: "r", lastRun: run({ id: "1", at: t0, status: "superseded" }) }))).toEqual({
      kind: "last",
      status: "skipped",
      at: t0,
    });
  });

  test("a long toast: its first sentence as the title, the rest under it", () => {
    expect(toastParts("Rotina pausada. Ela não roda até você ligar de novo.")).toEqual({
      title: "Rotina pausada.",
      subtitle: "Ela não roda até você ligar de novo.",
    });
    expect(toastParts("Rotina apagada.")).toEqual({ title: "Rotina apagada." });
  });
});

describe("the form", () => {
  const today = new Date(2026, 9, 28, 15);

  test("where it delivers, as the form's choice", () => {
    expect(targetChoice({ type: "channel", channelId: "c9" })).toBe("c9");
    expect(targetChoice({ type: "dm" })).toBe("dm");
    expect(targetChoice({ type: "artifact" })).toBe("artifact");
    expect(targetChoice({ type: "conversation", channelId: "c1", threadId: "t1" })).toBe("keep");
    expect(targetChoice(undefined)).toBe("");
  });

  test("a new routine: weekly on today's weekday at 09:00, in my zone, read only, speaking when there is news", () => {
    const d = draftOf(undefined, SP, today);
    expect(d.rule).toEqual({
      freq: "weekly",
      interval: 1,
      byWeekday: ["WE"],
      times: ["09:00"],
      timezone: SP,
      start: "2026-10-28",
    });
    expect([d.kind, d.event, d.active, d.report]).toEqual(["schedule", "sentry.issue_created", true, "when_new"]);
    const input = draftInput({ ...d, agentId: "dev", target: "c1", prompt: "  Resuma o dia  ", name: " " });
    expect(input).toEqual({
      agentId: "dev",
      prompt: "Resuma o dia",
      target: { type: "channel", channelId: "c1" },
      trigger: { type: "schedule", rule: toApiRule(d.rule) },
      report: "when_new",
    });
    expect(draftInput({ ...d, agentId: "dev", target: "dm", prompt: "x", name: " Bom dia " }).name).toBe("Bom dia");
  });

  test("what starts it, as the API takes it", () => {
    const d = draftOf(undefined, SP, today);
    expect(draftTrigger({ ...d, kind: "event", event: "deploy.succeeded" })).toEqual({
      type: "event",
      event: "deploy.succeeded",
    });
    const mail = { accountId: "m1", folder: "", filter: { subject: " fatura ", from: [] } };
    expect(draftTrigger({ ...d, kind: "email", email: mail })).toEqual({
      type: "email",
      accountId: "m1",
      folder: "INBOX",
      filter: { subject: "fatura" },
    });
    // A one-off: its instant in its zone (São Paulo is UTC−3).
    expect(draftTrigger({ ...d, rule: onceRule("2026-11-02T12:00:00.000Z", SP) })).toEqual({
      type: "once",
      at: "2026-11-02T12:00:00.000Z",
      timezone: SP,
    });
  });

  test("editing sends only what changed", () => {
    const r = routine({ id: "r" });
    const saved = JSON.stringify(toApiRule(ruleOf(r, SP, today)));
    const d = draftOf(r, SP, today);
    expect(draftChanges(r, d, saved)).toEqual({});
    expect(draftChanges(r, { ...d, name: "  Novo nome " }, saved)).toEqual({ name: "Novo nome" });
    expect(draftChanges(r, { ...d, target: "dm" }, saved)).toEqual({ target: { type: "dm" } });
    expect(draftChanges(r, { ...d, active: false, report: "always" }, saved)).toEqual({
      active: false,
      report: "always",
    });
    const later10 = { ...d.rule, times: ["10:00"] };
    expect(draftChanges(r, { ...d, rule: later10 }, saved)).toEqual({
      trigger: { type: "schedule", rule: toApiRule(later10) },
    });
    expect(draftChanges(r, { ...d, kind: "event" }, saved)).toEqual({
      trigger: { type: "event", event: "sentry.issue_created" },
    });
    // A prompt the viewer can't see is never sent.
    const hidden = routine({ id: "h", prompt: null });
    expect(draftChanges(hidden, draftOf(hidden, SP, today), saved)).toEqual({});
  });

  test("a chat-made routine keeps its conversation", () => {
    const chat = routine({ id: "k", target: { type: "conversation", channelId: "c1", threadId: "t1" } });
    const saved = JSON.stringify(toApiRule(ruleOf(chat, SP, today)));
    expect(draftOf(chat, SP, today).target).toBe("keep");
    expect(draftChanges(chat, draftOf(chat, SP, today), saved)).toEqual({});
  });

  test("a webhook routine: what starts it, never a zone, and only a switch to or from it is a change", () => {
    const d = draftOf(undefined, SP, today);
    expect(draftTrigger({ ...d, kind: "webhook" })).toEqual({ type: "webhook" });
    const r = routine({ id: "w", trigger: webhook });
    const saved = JSON.stringify(toApiRule(ruleOf(r, SP, today)));
    const form = draftOf(r, SP, today);
    expect(form.kind).toBe("webhook");
    expect(zoneOf(r)).toBe("");
    expect(draftChanges(r, form, saved)).toEqual({});
    expect(draftChanges(routine({ id: "s" }), { ...form, kind: "webhook" }, saved)).toMatchObject({
      trigger: { type: "webhook" },
    });
    expect(whenIcon(r)).toBe("globe");
    expect(isEventDriven(r)).toBe(true);
    expect(nextLine(r, NOW)).toEqual({ kind: "webhook", week: 0 });
  });

  test("a one-off and an email routine left as they were change nothing", () => {
    const one = routine({ id: "o", trigger: once("2026-11-02T12:00:00.000Z") });
    const saved = JSON.stringify(toApiRule(ruleOf(one, SP, today)));
    expect(draftChanges(one, draftOf(one, SP, today), saved)).toEqual({});
    const mail = routine({ id: "m", trigger: email });
    const d = draftOf(mail, SP, today);
    expect(draftChanges(mail, d, saved)).toEqual({});
    expect(draftChanges(mail, { ...d, email: { ...d.email, filter: { subject: "fatura" } } }, saved)).toEqual({
      trigger: { type: "email", accountId: "m1", folder: "INBOX", filter: { subject: "fatura" } },
    });
  });

  test("a one-off that already ran, saved as it was, sends no time: the server's instant has seconds", () => {
    // Fired at 12:03:27 (made with "em 10 minutos"); the form shows 12:03.
    const fired = routine({ id: "o", active: false, trigger: once("2026-10-20T12:03:27.512Z") });
    const saved = JSON.stringify(toApiRule(ruleOf(fired, SP, today)));
    const d = draftOf(fired, SP, today);
    expect(draftChanges(fired, d, saved)).toEqual({});
    expect(draftChanges(fired, { ...d, name: "Lembrete" }, saved)).toEqual({ name: "Lembrete" });
    // Moved to another minute: sent.
    const moved = { ...d.rule, times: ["12:30"] };
    expect(draftChanges(fired, { ...d, rule: moved }, saved)).toEqual({ trigger: draftTrigger({ ...d, rule: moved }) });
  });

  test("a cron (every 15 minutes) changes only with a phrase read into a rule, never to the form's placeholder", () => {
    const cron = routine({
      id: "c",
      trigger: { type: "schedule", rule: null, cron: "*/15 * * * *", timezone: "UTC", description: "Every 15 minutes" },
    });
    const saved = JSON.stringify(toApiRule(ruleOf(cron, "UTC", today)));
    // Read in UTC, the form starts in my zone: still nothing to send.
    const d = draftOf(cron, SP, today);
    expect(draftChanges(cron, d, saved)).toEqual({});
    expect(draftChanges(cron, { ...d, name: "Checagem" }, saved)).toEqual({ name: "Checagem" });
    const typed = { ...d.rule, freq: "daily" as const, times: ["08:00"] };
    expect(draftChanges(cron, { ...d, rule: typed }, saved, true)).toEqual({
      trigger: { type: "schedule", rule: toApiRule(typed) },
    });
  });

  test("the mailbox's inbox and the filters that say something", () => {
    expect(
      inboxOf([
        { id: "Clientes", name: "Clientes" },
        { id: "x", name: "Entrada", role: "inbox" },
      ]),
    ).toBe("x");
    expect(inboxOf([{ id: "inbox", name: "Inbox" }])).toBe("inbox");
    expect(inboxOf(undefined)).toBe("INBOX");
    expect(cleanFilter({ from: [], subject: "  ", text: " fatura " })).toEqual({ text: "fatura" });
    expect(cleanFilter({ from: ["@acme.com"] })).toEqual({ from: ["@acme.com"] });
  });
});

describe("the horizon", () => {
  test("lanes: active routines on the clock, not a one-off that already ran", () => {
    const list = [
      routine({ id: "a" }),
      routine({ id: "b", active: false }),
      routine({ id: "c", trigger: event }),
      routine({ id: "d", trigger: once(later(-DAY)), active: false }),
      routine({ id: "f", trigger: once(later(HOUR)) }),
    ];
    expect(horizonLanes(list).map((r) => r.id)).toEqual(["a", "f"]);
  });

  test("the calendar is asked from this hour on, once an hour", () => {
    expect(horizonRange(new Date("2026-10-28T15:42:00.000Z"))).toEqual({
      from: "2026-10-28T15:00:00.000Z",
      to: "2026-10-29T12:00:00.000Z",
    });
  });

  test("a routine's coming runs: the calendar's within the window, else its next run", () => {
    const to = new Date(NOW.getTime() + 20 * HOUR);
    const slots = [
      { routineId: "r", at: later(3 * HOUR) },
      { routineId: "r", at: later(HOUR) },
      { routineId: "r", at: later(-HOUR) },
      { routineId: "r", at: later(25 * HOUR) },
      { routineId: "other", at: later(2 * HOUR) },
    ];
    expect(futureRuns({ id: "r", nextRunAt: null }, slots, NOW, to)).toEqual([later(HOUR), later(3 * HOUR)]);
    expect(futureRuns({ id: "s", nextRunAt: later(5 * HOUR) }, [], NOW, to)).toEqual([later(5 * HOUR)]);
    expect(futureRuns({ id: "s", nextRunAt: later(30 * HOUR) }, [], NOW, to)).toEqual([]);
  });

  test("the scale: every three hours, off the edges and away from now", () => {
    const from = new Date(NOW.getTime() - 4 * HOUR);
    const to = new Date(NOW.getTime() + 20 * HOUR);
    const ticks = horizonTicks(from, to, NOW);
    expect(ticks.length).toBeGreaterThan(4);
    for (const k of ticks) {
      expect(k.pos).toBeGreaterThanOrEqual(0.03);
      expect(k.pos).toBeLessThanOrEqual(0.97);
      expect(Math.abs(k.at.getTime() - NOW.getTime())).toBeGreaterThanOrEqual(1.2 * HOUR);
      expect(k.at.getMinutes()).toBe(0);
      expect(k.at.getHours() % 3).toBe(0);
      expect(k.day).toBe(k.at.getHours() === 0);
      expect(k.pos).toBeCloseTo(horizonPos(k.at, from, to), 10);
    }
    expect(horizonPos(NOW, from, to)).toBeCloseTo(4 / 24, 10);
  });

  test("a lane's tag: minutes within the hour, else the time; hourly ones only within the hour", () => {
    const r = routine({ id: "r" });
    expect(laneTag(r, [later(30 * MIN)], NOW)).toEqual({ kind: "soon", minutes: 30, at: later(30 * MIN) });
    expect(laneTag(r, [later(10_000)], NOW)).toEqual({ kind: "soon", minutes: 1, at: later(10_000) });
    expect(laneTag(r, [later(3 * HOUR)], NOW)).toEqual({ kind: "at", at: later(3 * HOUR) });
    expect(laneTag(r, [], NOW)).toBeNull();
    expect(laneTag({ ...r, state: "running" }, [later(HOUR)], NOW)).toBeNull();
    const hourly = routine({ id: "h", trigger: { ...daily, rule: { ...daily.rule, freq: "hourly" as const } } });
    expect(laneTag(hourly, [later(3 * HOUR)], NOW)).toBeNull();
    expect(laneTag(hourly, [later(20 * MIN)], NOW)).toEqual({ kind: "soon", minutes: 20, at: later(20 * MIN) });
  });
});

describe("the rule in words (the web's sentence, on the phone)", () => {
  const base: RecurrenceRule = { freq: "weekly", interval: 1, times: ["09:00"], timezone: SP, start: "2026-10-12" };
  const now = new Date(2026, 9, 15);

  test("the sentence, with and without the zone", async () => {
    const t = await translator("pt-BR");
    expect(ruleSentence(t, "pt-BR", { ...base, interval: 2, byWeekday: ["MO", "WE"], until: "2026-12-31" }, now)).toBe(
      "A cada 2 semanas, seg e qua, às 09:00 (horário de Brasília), até 31/12",
    );
    const weekdays: RecurrenceRule = {
      ...base,
      freq: "daily",
      byWeekday: ["MO", "TU", "WE", "TH", "FR"],
      times: ["18:00"],
    };
    expect(ruleSentence(t, "pt-BR", weekdays, now)).toBe("De segunda a sexta, às 18:00 (horário de Brasília)");
    expect(ruleSentence(t, "pt-BR", { ...base, freq: "monthly", byWeekday: ["TU"], bySetPos: 2 }, now)).toBe(
      "Todo mês na 2ª terça-feira, às 09:00 (horário de Brasília)",
    );
    expect(ruleSentence(t, "pt-BR", { ...base, freq: "hourly", interval: 6, times: ["06:00"] }, now, false)).toBe(
      "A cada 6 horas, a partir das 06:00",
    );
    expect(ruleSentence(t, "pt-BR", defaultRule(SP, new Date(2026, 9, 28, 15)), now, false)).toBe(
      "Toda semana, qua, às 09:00",
    );
  });

  test("a proposed agent's routine: its rule in words, else the schedule as the agent wrote it", async () => {
    const t = await translator("pt-BR");
    const routine = {
      name: "E-mails do dia",
      prompt: "Resume a caixa de entrada.",
      schedule: "todo dia ao meio-dia",
      rule: { freq: "daily" as const, interval: 1, times: ["12:00"], timezone: SP },
      cron: "0 12 * * *",
      timezone: SP,
      description: "Every day, at 12:00 (Brasília time)",
      report: "when_new" as const,
      access: "read" as const,
    };
    expect(proposedRoutineWhen(t, "pt-BR", routine, now)).toBe("Todos os dias, às 12:00 (horário de Brasília)");
    expect(proposedRoutineWhen(t, "pt-BR", { ...routine, rule: null, schedule: "*/15 9-18 * * 1-5" }, now)).toBe(
      "*/15 9-18 * * 1-5",
    );
  });

  test("the API's rule and back give the same rule (the rule is what's sent, never a phrase)", () => {
    const rules: RecurrenceRule[] = [
      { ...base, interval: 2, byWeekday: ["MO", "WE"] },
      { ...base, freq: "daily", byWeekday: ["MO", "TU", "WE", "TH", "FR"], times: ["08:30"] },
      { ...base, freq: "monthly", byMonthDay: [15] },
      { ...base, freq: "monthly", byWeekday: ["TU"], bySetPos: 2 },
      { ...base, freq: "daily", interval: 3 },
    ];
    for (const r of rules) expect(toApiRule(fromApiRule(toApiRule(r), base.start))).toEqual(toApiRule(r));
    const nth = fromApiRule({ freq: "monthly", byWeekday: ["2TU"], times: ["09:00"], timezone: SP }, "2026-10-01");
    expect(nth).toMatchObject({ byWeekday: ["TU"], bySetPos: 2, start: "2026-10-01" });
    expect(toApiRule(nth).byWeekday).toEqual(["2TU"]);
    expect(toApiRule({ ...base, freq: "yearly", start: "2026-03-15" })).toMatchObject({
      byMonth: [3],
      byMonthDay: [15],
    });
  });

  test("the next runs in the rule's zone; a one-off's moment and back", () => {
    expect(upcomingLabels("pt-BR", { ...base, freq: "daily" }, new Date("2026-10-12T10:00:00-03:00"), 2)).toEqual([
      "ter, 13 out · 09:00",
      "qua, 14 out · 09:00",
    ]);
    expect(runLabel("pt-BR", "2026-10-20T12:00:00.000Z", SP)).toBe("ter, 20 out · 09:00");
    const one = onceRule("2026-11-02T12:00:00.000Z", SP);
    expect(one).toEqual({ freq: "once", interval: 1, times: ["09:00"], timezone: SP, start: "2026-11-02" });
    expect(onceAt(one)).toBe("2026-11-02T12:00:00.000Z");
  });
});

test("a run's Abrir na conversa keeps off the Mostrar mais right above it: no slop on top", () => {
  const screen = readFileSync(join(import.meta.dir, "../../src/features/routines/RoutineScreen.tsx"), "utf8");
  const open = screen.slice(0, screen.indexOf(`t("routines.openInChat")`));
  expect(open.slice(open.lastIndexOf("<Pressable"))).toContain("hitSlop={{ bottom: 13, left: 13, right: 13 }}");
});

test("Nova rotina's templates: one row opens the search, by area, and picking one fills the draft", async () => {
  // The screens are components the tests can't render: what they wire in, as text.
  const read = (f: string) => Bun.file(new URL(`../../src/features/routines/${f}`, import.meta.url).pathname).text();
  const [form, picker] = await Promise.all([read("RoutineForm.tsx"), read("TemplatePicker.tsx")]);
  expect(form).toContain("<TemplatePicker value={template?.value} onPick={pickTemplate} />");
  // The person's own words are never written over unasked, and a part in brackets holds "Criar" back.
  expect(form).toContain("if (!ownWords(d.prompt, template)) return applyTemplate(o);");
  expect(form).toContain("!unfilled &&");
  expect(form).toContain('t("routines.presets.fillBlank")');
  expect(form).toContain("rule: templateRule(picked, x.rule)");
  expect(form).not.toContain("PRESETS");
  expect(picker).toContain("routineTemplateOptions(t, catalog)");
  expect(picker).toContain("<PickList");
  // An app not connected yet has its way there, as a mailbox does.
  expect(picker).toContain('router.push("/connectors")');
});

test('a routine\'s row and its runs line show their words whole: they wrap, never end in a "…" that hides them', async () => {
  // The screens are components the tests can't render: what they hold back, as text.
  const read = (f: string) => Bun.file(new URL(`../../src/features/routines/${f}`, import.meta.url).pathname).text();
  const [parts, screen] = await Promise.all([read("parts.tsx"), read("RoutineScreen.tsx")]);
  const row = parts.slice(parts.indexOf("export const RoutineRow"), parts.indexOf("const styles = StyleSheet.create"));
  expect(row).toContain("{title}");
  expect(row).not.toContain("numberOfLines");
  // Where it delivers keeps its icon on its first line as it wraps.
  expect(row).toContain('<LineIcon variant="footnote" name={targetIcon(r.target)}');
  expect(screen.slice(screen.indexOf("<RunStrip"))).not.toMatch(/numberOfLines=\{1\}[^>]*>\s*\{words\.caption/);
});

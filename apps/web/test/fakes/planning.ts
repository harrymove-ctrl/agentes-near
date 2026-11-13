/**
 * Test fake — issues, routines and calendar.
 * Mirrors these endpoints (shapes in `api/types.ts`):
 * - Issues: `GET …/issues?q`, `GET …/issues/{number}`, `POST …/issues`, `PATCH …/issues/{id}`,
 *   `PUT …/issues/{id}/criteria/{criterionId} { done }`, `GET|POST …/issues/{id}/activity`,
 *   `POST …/issues/{id}/ask-agent { agentId }` (assigns, moves to "Em andamento", starts the run);
 *   board columns: `GET|POST …/issue-columns`, `PATCH|DELETE …/issue-columns/{id}`.
 * - Routines: `GET|POST …/routines`, `POST …/routines/parse-schedule|parse-rule { phrase }` → cron, rule and
 *   description in the workspace time zone (phrases looked up in a table, standing in for the model),
 *   `PATCH …/routines/{id} { active }`, `POST …/routines/{id}/run`, `GET …/routines/{id}/runs`.
 * - Calendar: `GET …/calendar?from&to` → events, routine runs, issue deadlines and agent proposals;
 *   `POST …/calendar/events`, `POST …/calendar/proposals/{id}/confirm|dismiss`.
 * Nothing runs: "Rodar agora" and "Pedir à Ada" only change local state. Seeded in development only.
 */

import type {
  Actor,
  ApiClient,
  ApiRule,
  CalendarEvent,
  CalendarProposal,
  Issue,
  IssueActivity,
  IssueColumn,
  IssuePatch,
  IssueStatus,
  Routine,
  RoutineHook,
  RoutineRun,
  RuleInfo,
  ScheduleParse,
  WebhookProvider,
  WebhookSetup,
} from "@agenteschat/client";
import { nextOccurrences } from "@agenteschat/ui";
import { fromApiRule } from "@/lib/recurrence";
import { clone, type MockContext, MockNotFoundError, minutesAgo, mockId, perOrg } from "./context";

const DAY_LABEL = [
  "Todo domingo",
  "Toda segunda-feira",
  "Toda terça-feira",
  "Toda quarta-feira",
  "Toda quinta-feira",
  "Toda sexta-feira",
  "Todo sábado",
];
const WEEKDAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const WORKDAYS = ["MO", "TU", "WE", "TH", "FR"];
const pad = (n: number) => String(n).padStart(2, "0");

/**
 * What the mock server's schedule reader answers for the phrases tests type:
 * a lookup table standing in for the model (the browser never reads phrases).
 */
const PHRASES: Record<string, Omit<ApiRule, "timezone">> = {
  "toda segunda às 9h": { freq: "weekly", byWeekday: ["MO"], times: ["09:00"] },
  "dias úteis às 18h": { freq: "daily", byWeekday: WORKDAYS, times: ["18:00"] },
  "dias úteis às 8h30": { freq: "daily", byWeekday: WORKDAYS, times: ["08:30"] },
  "dia 1 às 8h": { freq: "monthly", byMonthDay: [1], times: ["08:00"] },
};
const UNREADABLE = "Não entendi. Tente “toda segunda às 9h” ou “dias úteis às 18h”.";

/** A webhook routine's address, as the server makes them (a 43-character token). */
const hookUrl = () => `https://app.agentes.test/api/hooks/${mockId("hook").padEnd(43, "x").slice(0, 43)}`;
/** The workspace's webhook of a service: none made yet until `ensureWebhook`. */
const webhookOf = (s: { webhooks: Map<WebhookProvider, WebhookSetup> }, provider: WebhookProvider) => {
  const setup = s.webhooks.get(provider) ?? {
    provider,
    id: null,
    url: null,
    secret: null,
    receivedAt: null,
    refusedAt: null,
    secretSet: false,
    canManage: true,
    oneClick: false,
  };
  s.webhooks.set(provider, setup);
  return setup;
};

const hookOf = (s: { hooks: Map<string, RoutineHook> }, routineId: string) => {
  const hook = s.hooks.get(routineId) ?? { url: hookUrl(), signed: false, methods: ["POST"], calls: [] };
  s.hooks.set(routineId, hook);
  return hook;
};

/** What a new routine carries besides what it was made with (ADR 0053: state, week, where it runs). */
const routineDefaults = (): Pick<
  Routine,
  | "access"
  | "report"
  | "pausedReason"
  | "failuresInRow"
  | "state"
  | "waitingFor"
  | "brain"
  | "health"
  | "canSeeDetails"
  | "canManage"
  | "lastRun"
  | "recentRuns"
  | "usage"
> => ({
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
});

/** A finished run of the new shape. */
export const routineRun = (over: Partial<RoutineRun> & Pick<RoutineRun, "at" | "status">): RoutineRun => ({
  id: mockId("run"),
  code: null,
  summary: "",
  brain: "model",
  link: null,
  finishedAt: over.at,
  ...over,
});

const isWorkdays = (days: string[] | undefined) => days?.length === 5 && WORKDAYS.every((d) => days.includes(d));

/** A rule's `m h dom * dow` (the mock's own cron, from the structure). */
function cronOf(rule: Pick<ApiRule, "freq" | "byWeekday" | "byMonthDay" | "times">) {
  const [h, m] = (rule.times?.[0] ?? "09:00").split(":").map(Number);
  const days = rule.byWeekday ?? [];
  const dow = isWorkdays(days) ? "1-5" : days.length ? days.map((d) => WEEKDAY_CODES.indexOf(d)).join(",") : "*";
  const dom = rule.freq === "monthly" && rule.byMonthDay?.length ? String(rule.byMonthDay[0]) : "*";
  return `${m} ${h} ${dom} * ${dow}`;
}

/** A rule's description, in Portuguese (the mock's own wording, from the structure). */
function describeOf(rule: Pick<ApiRule, "freq" | "byWeekday" | "byMonthDay" | "times">) {
  const at = `às ${rule.times?.[0] ?? "09:00"}`;
  const days = rule.byWeekday ?? [];
  if (isWorkdays(days)) return `De segunda a sexta, ${at}`;
  if (days.length === 1) return `${DAY_LABEL[WEEKDAY_CODES.indexOf(days[0] as string)]}, ${at}`;
  if (rule.freq === "monthly" && rule.byMonthDay?.length) return `Todo dia ${rule.byMonthDay[0]}, ${at}`;
  return `Todos os dias, ${at}`;
}

/** The mock's `parse-schedule`: a phrase looked up in the table. */
export function parseSchedulePhrase(phrase: string, timezone = "America/Sao_Paulo"): ScheduleParse {
  const rule = PHRASES[phrase.trim().toLowerCase()];
  if (!phrase.trim()) return { ok: false, error: "Escreva quando a rotina deve rodar." };
  if (!rule) return { ok: false, error: UNREADABLE };
  return { ok: true, cron: cronOf(rule), description: describeOf(rule), timezone };
}

/** Next time a `m h dom * dow` cron fires after `from` (local time). */
export function nextCronRun(cron: string, from: Date): Date | null {
  const [m, h, dom, , dow] = cron.split(" ");
  const minute = Number(m);
  const hour = Number(h);
  if (Number.isNaN(minute) || Number.isNaN(hour)) return null;
  const okDay = (d: Date) => {
    if (dom && dom !== "*" && d.getDate() !== Number(dom)) return false;
    if (dow === "1-5") return d.getDay() >= 1 && d.getDay() <= 5;
    if (dow && dow !== "*") return d.getDay() === Number(dow);
    return true;
  };
  const d = new Date(from);
  d.setSeconds(0, 0);
  for (let i = 0; i < 400; i++) {
    const c = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, hour, minute);
    if (c > from && okDay(c)) return c;
  }
  return null;
}

export function startOfWeek(d: Date) {
  const day = (d.getDay() + 6) % 7; // Monday = 0
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - day);
}

const STAGES: IssueStatus[] = ["todo", "in_progress", "in_review", "done", "canceled"];
/** Every org starts with one unnamed column per stage (ids `col-<stage>`). */
const defaultColumns = (): IssueColumn[] =>
  STAGES.map((stage) => ({ id: `col-${stage}`, stage, name: null, position: 0 }));
/** Board order: by stage, then position. */
const boardOrder = (cols: IssueColumn[]) =>
  [...cols].sort((a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage) || a.position - b.position);

interface Store {
  issues: Issue[];
  columns: IssueColumn[];
  activity: Map<string, IssueActivity[]>;
  routines: Routine[];
  runs: Map<string, RoutineRun[]>;
  /** Webhook routines' addresses and calls. */
  hooks: Map<string, RoutineHook>;
  /** GitHub's and Sentry's webhooks of the workspace. */
  webhooks: Map<WebhookProvider, WebhookSetup>;
  events: CalendarEvent[];
  proposals: CalendarProposal[];
}

export function createMockPlanning(
  ctx: MockContext,
  record: (method: string, ...args: unknown[]) => void = () => {},
): Pick<ApiClient, "issues" | "routines" | "calendar"> {
  const me = async (): Promise<Actor> => ({ type: "person", id: (await ctx.lookup.me())?.user.id ?? "me" });
  const store = perOrg<Store>(async (orgId) => {
    const s: Store = {
      issues: [],
      columns: defaultColumns(),
      activity: new Map(),
      routines: [],
      runs: new Map(),
      hooks: new Map(),
      webhooks: new Map(),
      events: [],
      proposals: [],
    };
    if (!ctx.seed) return s;
    const [agents, members, channels] = await Promise.all([
      ctx.lookup.agents(orgId),
      ctx.lookup.members(orgId),
      ctx.lookup.channels(orgId),
    ]);
    const now = ctx.now();
    const agent = (i: number): Actor => ({ type: "agent", id: agents[i % Math.max(1, agents.length)]?.id ?? "agent" });
    const person = (i: number): Actor => ({
      type: "person",
      id: members[i % Math.max(1, members.length)]?.userId ?? "me",
    });
    /** These members, none past the last: a list of people names each one once, as the server keeps them. */
    const people = (...at: number[]): Actor[] =>
      at.flatMap((i) => members[i] ?? []).map((m) => ({ type: "person" as const, id: m.userId }));
    const day = (offset: number) => {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    };
    const channel = channels[0]?.id ?? null;
    let n = 125;
    const issue = (over: Partial<Issue> & Pick<Issue, "title" | "status">): Issue => ({
      id: mockId("iss"),
      number: ++n,
      columnId: `col-${over.status}`,
      boardRank: -n,
      description: "",
      priority: "normal",
      assignee: null,
      labels: [],
      dueDate: null,
      criteria: [],
      createdBy: person(0),
      source: { type: "manual" },
      channelId: null,
      pullRequests: [],
      githubUrl: null,
      artifacts: [],
      createdAt: minutesAgo(now, 3000 - n),
      updatedAt: minutesAgo(now, 600 - n),
      ...over,
    });
    s.issues.push(
      issue({ title: "Organizar o roadmap do trimestre", status: "done", assignee: agent(3) }),
      issue({
        title: "Resumo semanal de erros do Sentry no #eng",
        status: "done",
        assignee: agent(1),
        labels: ["ops"],
      }),
      issue({
        title: "Login devolve 401 depois do deploy das 9h",
        status: "in_review",
        assignee: agent(0),
        priority: "high",
        labels: ["bug"],
        dueDate: day(0),
        pullRequests: [{ number: 42, url: "https://github.com/acme/app/pull/42", openedBy: agent(0) }],
      }),
      issue({
        title: "Timeout no agendamento em horários de pico",
        status: "in_progress",
        assignee: agent(0),
        labels: ["bug"],
        dueDate: day(2),
        pullRequests: [{ number: 44, url: "https://github.com/acme/app/pull/44", openedBy: agent(0) }],
        criteria: [
          { id: mockId("crit"), text: "Responde em 2 s no pico", done: true, doneBy: agent(0) },
          { id: mockId("crit"), text: "Teste de carga", done: false },
        ],
        // The agent is on it now (a live run): the board shows it under "Agentes trabalhando agora".
        work: {
          agentId: agent(0).id,
          runId: null,
          state: "running",
          since: minutesAgo(now, 6),
          steps: [{ tool: "update_issue", detail: "#129", at: minutesAgo(now, 2) }],
        },
      }),
      issue({ title: "Revisar textos do onboarding", status: "in_progress", assignee: person(1), labels: ["produto"] }),
      issue({
        title: "Confirmação do agendamento por WhatsApp",
        status: "todo",
        priority: "high",
        assignee: person(1),
        labels: ["produto", "agendamento"],
        dueDate: day(4),
        description:
          "31 reviews da semana pedem confirmação por WhatsApp; 12 citam faltas de pacientes. Enviar uma mensagem 24 h antes da consulta com botões para confirmar ou remarcar.",
        criteria: [
          "Mensagem enviada 24 h antes da consulta, no fuso da clínica",
          "Botões “Confirmar” e “Remarcar”; a resposta atualiza a agenda",
          "Paciente sem WhatsApp recebe SMS",
          "Relatório semanal de faltas no Drive",
        ].map((text) => ({ id: mockId("crit"), text, done: false })),
        createdBy: person(1),
        source: channel ? { type: "message", channelId: channel, messageId: "m-1" } : { type: "manual" },
        channelId: channel,
      }),
      issue({
        title: "Tabela de concorrentes atualizada",
        status: "todo",
        assignee: agent(2),
        labels: ["pesquisa"],
        dueDate: day(10),
      }),
    );
    const wa = s.issues.find((i) => i.criteria.length) as Issue;
    s.activity.set(wa.id, [
      {
        id: mockId("act"),
        kind: "comment",
        author: person(1),
        text: "Os números estão na tabela de reviews. Prioridade alta para o trimestre.",
        createdAt: minutesAgo(now, 1400),
      },
    ]);
    const target = channel ? ({ type: "channel", channelId: channel } as const) : ({ type: "dm" } as const);
    const routine = (over: Partial<Routine> & Pick<Routine, "name" | "agentId" | "trigger">): Routine => {
      const r: Routine = {
        ...routineDefaults(),
        id: mockId("rt"),
        prompt: "",
        target,
        active: true,
        nextRunAt: null,
        createdAt: minutesAgo(now, 20000),
        ...over,
      };
      if (!r.active) r.state = "paused";
      if (r.active && r.trigger.type === "schedule")
        r.nextRunAt = nextCronRun(r.trigger.cron, now)?.toISOString() ?? null;
      return r;
    };
    const sched = (phrase: string) => {
      const p = parseSchedulePhrase(phrase) as Extract<ScheduleParse, { ok: true }>;
      const rule = { ...(PHRASES[phrase] as Omit<ApiRule, "timezone">), timezone: p.timezone };
      return {
        type: "schedule" as const,
        phrase,
        rule,
        cron: p.cron,
        timezone: p.timezone,
        description: p.description,
      };
    };
    const run = (mins: number, summary: string, status: RoutineRun["status"] = "reported", code?: string): RoutineRun =>
      routineRun({ at: minutesAgo(now, mins), status, summary, ...(code ? { code } : {}) });
    const weekly = routine({
      name: "Resumo da semana",
      agentId: agent(3).id,
      prompt: "Resuma o que aconteceu na semana: decisões, issues fechadas e o que ficou pendente.",
      trigger: sched("toda segunda às 9h"),
      ownActions: ["SLACK_SEND_MESSAGE"],
    });
    const errors = routine({
      name: "Erros do Sentry do dia",
      agentId: agent(1).id,
      trigger: sched("dias úteis às 18h"),
    });
    const pr = routine({
      name: "Revisar PR aberto",
      agentId: agent(0).id,
      target: { type: "artifact" },
      trigger: { type: "event", event: "github.pr_opened" },
    });
    const monthly = routine({
      name: "Relatório mensal de reviews",
      agentId: agent(2).id,
      target: { type: "artifact" },
      trigger: sched("dia 1 às 8h"),
      active: false,
    });
    s.routines.push(weekly, errors, pr, monthly);
    s.runs.set(weekly.id, [
      run(7 * 1440, "Resumo postado no canal"),
      run(14 * 1440, "Resumo postado no canal"),
      run(21 * 1440, "", "failed", "budget_exceeded"),
      run(28 * 1440, "Resumo postado no canal"),
    ]);
    s.runs.set(errors.id, [run(1440, "Abriu 1 issue")]);
    s.runs.set(pr.id, [run(180, "Revisou o PR #42")]);
    s.runs.set(monthly.id, [run(13 * 1440, "Relatório no Drive")]);
    for (const r of s.routines) {
      r.lastRun = s.runs.get(r.id)?.[0] ?? null;
      r.recentRuns = (s.runs.get(r.id) ?? []).slice(0, 14).map((x, i) => ({ ...x, weight: i % 2 ? 0.5 : 1 }));
    }

    const monday = startOfWeek(now);
    const at = (dayOffset: number, h: number, m = 0) =>
      new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + dayOffset, h, m).toISOString();
    const event = (over: Partial<CalendarEvent> & Pick<CalendarEvent, "title" | "start" | "end">): CalendarEvent => ({
      id: mockId("ev"),
      description: "",
      allDay: false,
      timezone: "America/Sao_Paulo",
      recurrence: "none",
      participants: [],
      rsvp: [],
      channelId: null,
      issueId: null,
      createdBy: person(0),
      ...over,
    });
    s.events.push(
      event({
        title: "Daily de produto",
        start: at(0, 10),
        end: at(0, 11),
        description: "Pauta preparada no canal.",
        participants: [...people(0, 1), agent(3)],
      }),
      event({
        title: "Revisão de design",
        start: at(1, 14),
        end: at(1, 15, 30),
        participants: people(1, 0),
        createdBy: person(1),
      }),
      event({
        title: "Retro da sprint",
        start: at(4, 11),
        end: at(4, 12),
        participants: [...people(0, 2), agent(0)],
      }),
    );
    s.proposals.push({
      id: mockId("prop"),
      agentId: agent(3).id,
      title: "Revisão do roadmap",
      start: at(3, 15),
      end: at(3, 15, 45),
      participants: people(0, 1, 2),
      note: "livre para todos",
      status: "pending",
    });
    return s;
  });

  const findIssue = async (orgId: string, id: string) => {
    const i = (await store(orgId)).issues.find((x) => x.id === id);
    if (!i) throw new MockNotFoundError("Issue não encontrada.");
    return i;
  };
  const log = async (orgId: string, issue: Issue, entry: Omit<IssueActivity, "id" | "createdAt">) => {
    const s = await store(orgId);
    const list = s.activity.get(issue.id) ?? [];
    const a: IssueActivity = { ...entry, id: mockId("act"), createdAt: ctx.now().toISOString() };
    list.push(a);
    s.activity.set(issue.id, list);
    issue.updatedAt = a.createdAt;
    return a;
  };
  /** Renumbers a stage's columns in their current order (positions 0, 1, 2…). */
  const renumber = (cols: IssueColumn[], stage: IssueStatus) => {
    cols
      .filter((c) => c.stage === stage)
      .forEach((c, k) => {
        c.position = k;
      });
  };
  const columnsOf = async (orgId: string) => {
    const s = await store(orgId);
    s.columns = boardOrder(s.columns);
    return s;
  };
  /** On, off: a pause stops a run in progress; resuming clears the pause reason and the failure streak. */
  const setActive = (r: Routine, active: boolean) => {
    r.active = active;
    r.state = active ? "active" : "paused";
    if (active) {
      r.pausedReason = null;
      r.failuresInRow = 0;
    }
  };
  const findRoutine = async (orgId: string, id: string) => {
    const r = (await store(orgId)).routines.find((x) => x.id === id);
    if (!r) throw new MockNotFoundError("Rotina não encontrada.");
    return r;
  };

  return {
    issues: {
      list: async (orgId, filters = {}) => {
        const q = filters.q?.trim().toLowerCase();
        return clone(
          (await store(orgId)).issues
            .filter((i) => !q || `${i.title} #${i.number}`.toLowerCase().includes(q))
            .sort((a, b) => b.number - a.number),
        );
      },
      get: async (orgId, number) => {
        const i = (await store(orgId)).issues.find((x) => x.number === number);
        if (!i) throw new MockNotFoundError("Issue não encontrada.");
        return clone(i);
      },
      create: async (orgId, input) => {
        const s = await store(orgId);
        const at = ctx.now().toISOString();
        const author = await me();
        const issue: Issue = {
          id: mockId("iss"),
          number: Math.max(0, ...s.issues.map((i) => i.number)) + 1,
          title: input.title.trim(),
          description: input.description?.trim() ?? "",
          status: "todo",
          columnId: boardOrder(s.columns).find((c) => c.stage === "todo")?.id ?? null,
          boardRank: -ctx.now().getTime(),
          priority: input.priority ?? "normal",
          assignee: input.assignee ?? null,
          labels: input.labels ?? [],
          dueDate: input.dueDate ?? null,
          criteria: (input.criteria ?? []).map((text) => ({ id: mockId("crit"), text, done: false })),
          createdBy: author,
          source: { type: "manual" },
          channelId: null,
          pullRequests: [],
          githubUrl: null,
          // Files from the new-task box: linked, and kept on the "created" event (their Drive titles stand in as ids).
          artifacts: (input.attachmentIds ?? []).map((id) => ({ id, title: id, createdBy: author })),
          createdAt: at,
          updatedAt: at,
        };
        s.issues.push(issue);
        if (input.attachmentIds?.length)
          await log(orgId, issue, {
            kind: "event",
            author,
            event: "created",
            text: "criou a tarefa",
            attachments: input.attachmentIds.map((id) => ({ id, title: id })),
          });
        return clone(issue);
      },
      update: async (orgId, id, patch) => {
        const i = await findIssue(orgId, id);
        const author = await me();
        const s = await columnsOf(orgId);
        const { columnId, criteria, ...rest } = patch;
        let change: Omit<IssuePatch, "columnId" | "criteria"> = rest;
        // The whole list, as the backend takes it: an id keeps that criterion (and its check), none is a new one.
        if (criteria) {
          const list = criteria.filter((c) => c.text.trim());
          i.criteria = list.map((c) => {
            const kept = i.criteria.find((x) => x.id === c.id);
            return kept ? { ...kept, text: c.text.trim() } : { id: mockId("crit"), text: c.text.trim(), done: false };
          });
          await log(orgId, i, {
            kind: "event",
            author,
            event: "criteria_changed",
            text: "editou os critérios de aceite",
          });
        }
        if (change.title && change.title !== i.title)
          await log(orgId, i, { kind: "event", author, event: "renamed", text: "renomeou a tarefa" });
        if (change.description !== undefined && change.description !== i.description)
          await log(orgId, i, { kind: "event", author, event: "description_changed", text: "editou a descrição" });
        // A column carries its stage; a bare status lands on top of that stage's first column.
        const column = columnId ? s.columns.find((c) => c.id === columnId) : undefined;
        if (columnId && !column) throw new MockNotFoundError("Coluna não encontrada.");
        if (column) {
          change = { ...change, status: column.stage };
          i.columnId = column.id;
        } else if (change.status && change.status !== i.status) {
          i.columnId = s.columns.find((c) => c.stage === change.status)?.id ?? null;
          if (change.boardRank === undefined) i.boardRank = -ctx.now().getTime();
        }
        if (change.status && change.status !== i.status) {
          // Same words as the backend (packages/engine/src/issues.ts).
          const words = {
            todo: "A fazer",
            in_progress: "Em andamento",
            in_review: "Em revisão",
            done: "Concluída",
            canceled: "Cancelada",
          };
          await log(orgId, i, {
            kind: "event",
            author,
            event: "status_changed",
            text: `mudou o status para ${words[change.status]}`,
          });
        }
        Object.assign(i, change, { updatedAt: ctx.now().toISOString() });
        return clone(i);
      },
      setCriterion: async (orgId, id, criterionId, done) => {
        const i = await findIssue(orgId, id);
        const c = i.criteria.find((x) => x.id === criterionId);
        if (!c) throw new MockNotFoundError("Critério não encontrado.");
        c.done = done;
        return clone(i);
      },
      share: async (orgId, id) => {
        const i = await findIssue(orgId, id);
        i.channelId = null;
        return clone(i);
      },
      setAudience: async (orgId, id, audience) => {
        const i = await findIssue(orgId, id);
        i.channelId = null;
        i.audience =
          audience.mode === "everyone"
            ? { mode: "everyone", userIds: [], channelId: null }
            : { mode: "people", userIds: audience.userIds, channelId: null };
        return clone(i);
      },
      activity: async (orgId, id) => clone((await store(orgId)).activity.get(id) ?? []),
      comment: async (orgId, id, text, attachmentIds) => {
        const i = await findIssue(orgId, id);
        const author = await me();
        // As the server does: a comment's files are linked to the task (its Anexos).
        for (const a of attachmentIds ?? [])
          if (!i.artifacts.some((f) => f.id === a)) i.artifacts.push({ id: a, title: a, createdBy: author });
        return clone(
          await log(orgId, i, {
            kind: "comment",
            author,
            text: text.trim(),
            ...(attachmentIds?.length ? { attachments: attachmentIds.map((a) => ({ id: a, title: a })) } : {}),
          }),
        );
      },
      askAgent: async (orgId, id, agentId) => {
        const i = await findIssue(orgId, id);
        i.assignee = { type: "agent", id: agentId };
        if (i.status !== "in_progress") {
          i.status = "in_progress";
          i.columnId = (await columnsOf(orgId)).columns.find((c) => c.stage === "in_progress")?.id ?? null;
          i.boardRank = -ctx.now().getTime();
        }
        const agentName = (await ctx.lookup.agents(orgId)).find((a) => a.id === agentId)?.name ?? "o agente";
        await log(orgId, i, {
          kind: "event",
          author: await me(),
          event: "agent_asked",
          text: `pediu a ${agentName} para fazer`,
        });
        return clone(i);
      },
      // Like the server (ADR 0145): a channel of its own and a root message, made on first use; the chat fake holds them.
      conversation: async (orgId, id) => {
        const i = await findIssue(orgId, id);
        if (!i.conversation) {
          const root = {
            id: mockId("msg"),
            channelId: mockId("task"),
            threadId: null,
            author: { type: i.createdBy.type, id: i.createdBy.id },
            body: `Task #${i.number}: ${i.title}`,
            mentionedAgentIds: [],
            agentRunId: null,
            clientId: null,
            meta: { taskConversation: { issueId: i.id, number: i.number, title: i.title } },
            createdAt: i.createdAt,
          };
          (await ctx.lookup.messages?.(orgId))?.push(root);
          i.conversation = {
            channelId: root.channelId,
            rootId: root.id,
            count: 0,
            lastAt: null,
            participants: [],
            working: false,
          };
        }
        return { channelId: i.conversation.channelId, rootId: i.conversation.rootId };
      },
      columns: async (orgId) => clone((await columnsOf(orgId)).columns),
      addColumn: async (orgId, input) => {
        record("issues.addColumn", input);
        const s = await columnsOf(orgId);
        const col: IssueColumn = { id: mockId("col"), stage: input.stage, name: input.name.trim(), position: 0 };
        const after = input.afterId ? s.columns.find((c) => c.id === input.afterId) : undefined;
        const at =
          after && after.stage === input.stage
            ? s.columns.indexOf(after) + 1
            : s.columns.reduce((k, c, j) => (c.stage === input.stage ? j + 1 : k), 0);
        s.columns.splice(at, 0, col);
        renumber(s.columns, input.stage);
        return clone(s.columns);
      },
      updateColumn: async (orgId, columnId, patch) => {
        record("issues.updateColumn", columnId, patch);
        const s = await columnsOf(orgId);
        const col = s.columns.find((c) => c.id === columnId);
        if (!col) throw new MockNotFoundError("Coluna não encontrada.");
        if (patch.name !== undefined) col.name = patch.name.trim() || null;
        if (patch.index !== undefined) {
          const sib = s.columns.filter((c) => c.stage === col.stage && c !== col);
          sib.splice(Math.max(0, Math.min(patch.index, sib.length)), 0, col);
          sib.forEach((c, k) => {
            c.position = k;
          });
          s.columns = boardOrder(s.columns);
        }
        return clone(s.columns);
      },
      delete: async (orgId, id) => {
        record("issues.delete", orgId, id);
        const s = await store(orgId);
        s.issues = s.issues.filter((i) => i.id !== id);
      },
      deleteColumn: async (orgId, columnId, moveTo) => {
        record("issues.deleteColumn", columnId, moveTo);
        const s = await columnsOf(orgId);
        const col = s.columns.find((c) => c.id === columnId);
        const dest = s.columns.find((c) => c.id === moveTo && c.id !== columnId);
        if (!col || !dest) throw new MockNotFoundError("Coluna não encontrada.");
        if (s.columns.filter((c) => c.stage === col.stage).length === 1)
          throw new Error("Cada etapa precisa de pelo menos uma coluna.");
        for (const i of s.issues)
          if (i.columnId === columnId) {
            i.columnId = dest.id;
            i.status = dest.stage;
          }
        s.columns = s.columns.filter((c) => c !== col);
        renumber(s.columns, col.stage);
        return clone(s.columns);
      },
    },
    routines: {
      list: async (orgId) => clone((await store(orgId)).routines),
      parseSchedule: async (_orgId, phrase, timezone) => parseSchedulePhrase(phrase, timezone),
      parseRule: async (_orgId, phrase, timezone = "America/Sao_Paulo") => {
        const rule = PHRASES[phrase.trim().toLowerCase()];
        if (!rule) return { ok: false, error: UNREADABLE };
        const today = ctx.now();
        return ruleInfo({ ...rule, timezone, start: localYmd(today), until: null, count: null }, today);
      },
      describeRule: async (_orgId, rule) => ruleInfo(rule, ctx.now()),
      create: async (orgId, input) => {
        const s = await store(orgId);
        let trigger: Routine["trigger"];
        if (input.trigger.type === "schedule") trigger = scheduleOf(input.trigger);
        else if (input.trigger.type === "once")
          trigger = {
            type: "once",
            at: input.trigger.at,
            timezone: input.trigger.timezone ?? "America/Sao_Paulo",
            description: input.trigger.at,
          };
        else if (input.trigger.type === "webhook")
          trigger = { type: "webhook", url: null, signed: false, methods: input.trigger.methods ?? ["POST"] };
        else if (input.trigger.type === "connector") trigger = { ...input.trigger, status: "active", lastError: null };
        else trigger = input.trigger;
        const agents = await ctx.lookup.agents(orgId);
        const id = mockId("rt");
        if (trigger.type === "webhook") {
          trigger.url = hookOf(s, id).url;
          hookOf(s, id).methods = trigger.methods;
        }
        const r: Routine = {
          ...routineDefaults(),
          id,
          name: input.name?.trim() || `Rotina de ${agents.find((a) => a.id === input.agentId)?.name ?? "agente"}`,
          agentId: input.agentId,
          prompt: input.prompt,
          target: input.target,
          trigger,
          active: true,
          nextRunAt: trigger.type === "schedule" ? (nextCronRun(trigger.cron, ctx.now())?.toISOString() ?? null) : null,
          createdAt: ctx.now().toISOString(),
          access: "act",
          report: input.report ?? "when_new",
        };
        s.routines.push(r);
        return clone(r);
      },
      update: async (orgId, id, patch) => {
        record("routines.update", id, patch);
        const r = await findRoutine(orgId, id);
        if (patch.name !== undefined) r.name = patch.name;
        if (patch.prompt !== undefined) r.prompt = patch.prompt;
        if (patch.agentId !== undefined) r.agentId = patch.agentId;
        if (patch.target !== undefined) r.target = patch.target;
        if (patch.report !== undefined) r.report = patch.report;
        if (patch.ownActions !== undefined) r.ownActions = patch.ownActions;
        if (patch.active !== undefined) setActive(r, patch.active);
        if (patch.trigger?.type === "schedule") r.trigger = scheduleOf(patch.trigger);
        else if (patch.trigger?.type === "once")
          r.trigger = {
            type: "once",
            at: patch.trigger.at,
            timezone: patch.trigger.timezone ?? "America/Sao_Paulo",
            description: r.trigger.type === "once" ? r.trigger.description : patch.trigger.at,
          };
        else if (patch.trigger?.type === "webhook") {
          const hook = hookOf(await store(orgId), id);
          if (patch.trigger.methods) hook.methods = patch.trigger.methods;
          r.trigger = { type: "webhook", url: hook.url, signed: false, methods: hook.methods };
        } else if (patch.trigger?.type === "connector")
          r.trigger = { ...patch.trigger, status: "active", lastError: null };
        else if (patch.trigger) r.trigger = patch.trigger;
        r.nextRunAt =
          r.active && r.trigger.type === "schedule"
            ? (nextCronRun(r.trigger.cron, ctx.now())?.toISOString() ?? null)
            : null;
        return clone(r);
      },
      remove: async (orgId, id) => {
        record("routines.remove", id);
        await findRoutine(orgId, id);
        const s = await store(orgId);
        s.routines = s.routines.filter((x) => x.id !== id);
      },
      duplicate: async (orgId, id, name) => {
        record("routines.duplicate", id);
        const r = await findRoutine(orgId, id);
        const copy: Routine = {
          ...clone(r),
          id: mockId("rt"),
          name: name ?? `${r.name} (copy)`,
          active: false,
          state: "paused",
          nextRunAt: null,
          lastRun: null,
          recentRuns: [],
          createdAt: ctx.now().toISOString(),
        };
        (await store(orgId)).routines.push(copy);
        return clone(copy);
      },
      setActive: async (orgId, id, active) => {
        record("routines.setActive", id, active);
        const r = await findRoutine(orgId, id);
        setActive(r, active);
        r.nextRunAt =
          active && r.trigger.type === "schedule"
            ? (nextCronRun(r.trigger.cron, ctx.now())?.toISOString() ?? null)
            : null;
        return clone(r);
      },
      runNow: async (orgId, id) => {
        const r = await findRoutine(orgId, id);
        r.state = "running";
        return clone(r);
      },
      stop: async (orgId, id) => {
        record("routines.stop", id);
        const r = await findRoutine(orgId, id);
        r.state = r.active ? "active" : "paused";
        const by = (await ctx.lookup.me())?.user.id ?? "me";
        const stopped = routineRun({
          at: ctx.now().toISOString(),
          status: "canceled",
          code: "stopped",
          codeParams: { by },
        });
        const s = await store(orgId);
        s.runs.set(id, [stopped, ...(s.runs.get(id) ?? [])]);
        r.recentRuns = [stopped, ...r.recentRuns];
        r.lastRun = stopped;
        return clone(r);
      },
      takeOver: async (orgId, id) => {
        record("routines.takeOver", id);
        const r = await findRoutine(orgId, id);
        return clone(r);
      },
      continueUsage: async (orgId, id) => {
        record("routines.continueUsage", id);
        const r = await findRoutine(orgId, id);
        if (r.state === "usage_paused") Object.assign(r, { state: "running", usagePause: null });
        return clone(r);
      },
      runs: async (orgId, id) => {
        await findRoutine(orgId, id);
        return clone((await store(orgId)).runs.get(id) ?? []);
      },
      hook: async (orgId, id) => clone(hookOf(await store(orgId), id)),
      newHookAddress: async (orgId, id) => {
        record("routines.newHookAddress", id);
        const hook = hookOf(await store(orgId), id);
        hook.url = hookUrl();
        return clone(hook);
      },
      newHookSecret: async (orgId, id) => {
        record("routines.newHookSecret", id);
        const hook = hookOf(await store(orgId), id);
        hook.signed = true;
        return { secret: mockId("secret"), hook: clone(hook) };
      },
      removeHookSecret: async (orgId, id) => {
        record("routines.removeHookSecret", id);
        const hook = hookOf(await store(orgId), id);
        hook.signed = false;
        return clone(hook);
      },
      testHook: async (orgId, id) => {
        record("routines.testHook", id);
        const hook = hookOf(await store(orgId), id);
        hook.calls.unshift({
          id: mockId("call"),
          at: ctx.now().toISOString(),
          outcome: "accepted",
          status: 202,
          bytes: 74,
          runId: null,
          test: true,
        });
        return { runId: null, hook: clone(hook) };
      },
      webhookSetup: async (orgId, provider) => clone(webhookOf(await store(orgId), provider)),
      ensureWebhook: async (orgId, provider) => {
        record("routines.ensureWebhook", provider);
        const setup = webhookOf(await store(orgId), provider);
        if (!setup.id) {
          setup.id = mockId("webhook");
          setup.url = `https://app.agentes.test/api/webhooks/${provider}/${setup.id}`;
          setup.secret = provider === "github" ? "gh-secret-1234" : null;
        }
        return clone(setup);
      },
      setWebhookSecret: async (orgId, provider, secret) => {
        record("routines.setWebhookSecret", provider, secret);
        const setup = webhookOf(await store(orgId), provider);
        setup.secretSet = true;
        setup.refusedAt = null;
        return clone(setup);
      },
      addWebhookToRepo: async (orgId, repo) => {
        record("routines.addWebhookToRepo", repo);
        return clone(webhookOf(await store(orgId), "github"));
      },
    },
    calendar: {
      range: async (orgId, from, to) => {
        const s = await store(orgId);
        const a = new Date(from);
        const b = new Date(to);
        const inRange = (iso: string) => new Date(iso) >= a && new Date(iso) < b;
        const routines: Awaited<ReturnType<ApiClient["calendar"]["range"]>>["routines"] = [];
        for (const r of s.routines) {
          if (!r.active || r.trigger.type !== "schedule") continue;
          let next = nextCronRun(r.trigger.cron, new Date(a.getTime() - 60_000));
          while (next && next < b) {
            routines.push({
              routineId: r.id,
              name: r.name,
              agentId: r.agentId,
              at: next.toISOString(),
              target: r.target,
            });
            next = nextCronRun(r.trigger.cron, next);
          }
        }
        const day = (d: string) => new Date(`${d}T12:00:00`);
        return clone({
          events: expandEvents(s.events, a, b),
          routines,
          deadlines: s.issues
            .filter(
              (i) =>
                i.dueDate &&
                i.status !== "done" &&
                i.status !== "canceled" &&
                day(i.dueDate) >= a &&
                day(i.dueDate) < b,
            )
            .map((i) => ({
              issueId: i.id,
              number: i.number,
              title: i.title,
              date: i.dueDate as string,
              assignee: i.assignee,
            })),
          proposals: s.proposals.filter((p) => inRange(p.start)),
        });
      },
      create: async (orgId, input) => {
        const e: CalendarEvent = {
          id: mockId("ev"),
          title: input.title.trim(),
          description: input.description ?? "",
          start: input.start,
          end: input.end,
          allDay: input.allDay ?? false,
          timezone: input.timezone ?? "America/Sao_Paulo",
          recurrence: input.recurrence,
          participants: input.participants,
          rsvp: input.participants
            .filter((p) => p.type === "person")
            .map((p) => ({ ...p, status: "needs_action" as const })),
          channelId: input.channelId ?? null,
          issueId: input.issueId ?? null,
          createdBy: await me(),
          rule: input.rule ?? null,
          location: input.location ?? null,
          exdates: [],
        };
        record("calendar.create", input);
        (await store(orgId)).events.push(e);
        return clone(e);
      },
      confirmProposal: async (orgId, id) => {
        const s = await store(orgId);
        const p = s.proposals.find((x) => x.id === id);
        if (!p) throw new MockNotFoundError("Proposta não encontrada.");
        s.proposals = s.proposals.filter((x) => x.id !== id);
        const e: CalendarEvent = {
          id: mockId("ev"),
          title: p.title,
          description: "",
          start: p.start,
          end: p.end,
          allDay: false,
          timezone: "America/Sao_Paulo",
          recurrence: "none",
          participants: [...p.participants, { type: "agent", id: p.agentId }],
          rsvp: [],
          channelId: null,
          issueId: null,
          createdBy: await me(),
        };
        s.events.push(e);
        return clone(e);
      },
      dismissProposal: async (orgId, id) => {
        const s = await store(orgId);
        s.proposals = s.proposals.filter((x) => x.id !== id);
      },
      respond: async (orgId, id, status) => {
        record("calendar.respond", orgId, id, status);
        const e = (await store(orgId)).events.find((x) => x.id === id);
        const mine = (await me()).id;
        const row = e?.rsvp.find((r) => r.type === "person" && r.id === mine);
        if (!e || !row) throw new MockNotFoundError("You are not invited to this event");
        row.status = status;
        return clone(e);
      },
      update: async (orgId, id, patch, series) => {
        record("calendar.update", id, patch, series);
        const s = await store(orgId);
        const master = s.events.find((e) => e.id === id);
        if (!master) throw new MockNotFoundError("Evento não encontrado.");
        if (!series || series.scope === "all" || !master.rule || master.rule.freq === "once") {
          // A whole series moves by how much this occurrence moved.
          if (series && patch.start && master.rule && master.rule.freq !== "once") {
            const delta = new Date(patch.start).getTime() - new Date(series.occurrenceStart).getTime();
            const dur = patch.end
              ? new Date(patch.end).getTime() - new Date(patch.start).getTime()
              : new Date(master.end).getTime() - new Date(master.start).getTime();
            const start = new Date(new Date(master.start).getTime() + delta);
            Object.assign(master, {
              ...patch,
              start: start.toISOString(),
              end: new Date(start.getTime() + dur).toISOString(),
            });
            master.rule = { ...master.rule, start: localYmd(start), times: [localHm(start)] };
          } else Object.assign(master, patch);
          return clone(master);
        }
        const occurrence = new Date(series.occurrenceStart);
        if (series.scope === "this") {
          master.exdates = [...(master.exdates ?? []), localYmd(occurrence)];
          const dur = new Date(master.end).getTime() - new Date(master.start).getTime();
          const override: CalendarEvent = {
            ...clone(master),
            start: occurrence.toISOString(),
            end: new Date(occurrence.getTime() + dur).toISOString(),
            ...patch,
            id: mockId("ev"),
            rule: null,
            exdates: [],
            seriesId: master.id,
            occurrenceStart: series.occurrenceStart,
          };
          s.events.push(override);
          return clone(override);
        }
        // "Este e os próximos": the series ends the day before; a new one starts here.
        const until = localYmd(new Date(occurrence.getTime() - 86_400_000));
        const rule = master.rule;
        master.rule = { ...rule, until };
        const start = new Date(patch.start ?? series.occurrenceStart);
        const dur = new Date(patch.end ?? master.end).getTime() - new Date(patch.start ?? master.start).getTime();
        const next: CalendarEvent = {
          ...clone(master),
          ...patch,
          id: mockId("ev"),
          start: start.toISOString(),
          end: new Date(start.getTime() + dur).toISOString(),
          rule: { ...(patch.rule ?? rule), start: localYmd(start), times: [localHm(start)], until: rule.until ?? null },
          exdates: [],
        };
        s.events.push(next);
        return clone(next);
      },
      remove: async (orgId, id, series) => {
        record("calendar.remove", id, series);
        const s = await store(orgId);
        const master = s.events.find((e) => e.id === id);
        if (!master) throw new MockNotFoundError("Evento não encontrado.");
        if (!series || series.scope === "all" || !master.rule) {
          s.events = s.events.filter((e) => e.id !== id && e.seriesId !== id);
          return;
        }
        const day = localYmd(new Date(series.occurrenceStart));
        if (series.scope === "this") master.exdates = [...(master.exdates ?? []), day];
        else
          master.rule = {
            ...master.rule,
            until: localYmd(new Date(new Date(series.occurrenceStart).getTime() - 86_400_000)),
          };
      },
    },
  };
}

/** A schedule trigger from a phrase (looked up in the table) or a rule. */
function scheduleOf(
  input: { type: "schedule"; phrase: string; timezone?: string } | { type: "schedule"; rule: ApiRule },
): Routine["trigger"] {
  if ("rule" in input) {
    return {
      type: "schedule",
      phrase: null,
      rule: input.rule,
      cron: cronOf(input.rule),
      timezone: input.rule.timezone,
      description: describeOf(input.rule),
    };
  }
  const p = parseSchedulePhrase(input.phrase, input.timezone);
  if (!p.ok) throw new Error(p.error);
  const rule = { ...(PHRASES[input.phrase.trim().toLowerCase()] as Omit<ApiRule, "timezone">), timezone: p.timezone };
  return {
    type: "schedule",
    phrase: input.phrase,
    rule,
    cron: p.cron,
    timezone: p.timezone,
    description: p.description,
  };
}

/** The mock's `parse-rule` / `describe-rule` answer. */
function ruleInfo(api: ApiRule, now: Date): RuleInfo {
  const rule = fromApiRule(api, localYmd(now));
  return {
    ok: true,
    rule: api,
    description: describeOf(api),
    cron: cronOf(api),
    nextRuns: nextOccurrences(rule, now, 5).map((d) => d.toISOString()),
  };
}

const localYmd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localHm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Events in [a, b): single ones that overlap it, and each occurrence of the recurring ones. */
function expandEvents(events: CalendarEvent[], a: Date, b: Date): CalendarEvent[] {
  const out: CalendarEvent[] = [];
  for (const e of events) {
    const start = new Date(e.start);
    const end = new Date(e.end);
    if (!e.rule || e.rule.freq === "once") {
      if (start < b && end > a) out.push(e);
      continue;
    }
    const dur = end.getTime() - start.getTime();
    const skip = new Set(e.exdates ?? []);
    for (const at of nextOccurrences(fromApiRule(e.rule, localYmd(start)), new Date(a.getTime() - dur), 400)) {
      if (at >= b) break;
      if (skip.has(localYmd(at))) continue;
      out.push({
        ...e,
        start: at.toISOString(),
        end: new Date(at.getTime() + dur).toISOString(),
        seriesId: e.id,
        occurrenceStart: at.toISOString(),
      });
    }
  }
  return out;
}

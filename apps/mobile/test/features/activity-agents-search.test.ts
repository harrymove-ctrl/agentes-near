import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentAccess, AppNotification, WorkingRun } from "@agenteschat/client";
import { resources } from "@agenteschat/i18n";
import i18next from "i18next";
import {
  activitySections,
  dayGroupOf,
  emojisOf,
  type SayWords,
  subtitleOf,
  whoOf,
} from "../../src/features/activity/logic";
import {
  agoOf,
  busyAgents,
  busyChannels,
  canUse,
  spendOf,
  teamLines,
  workingNow,
} from "../../src/features/agents/logic";
import { featureKeysEn } from "../../src/features/i18n/keys.en";
import { featureKeysPtBR } from "../../src/features/i18n/keys.pt-BR";
import { filterResults, fold, isEmpty, matches, searchCounts, searchResults } from "../../src/features/search/logic";
import { withMobileKeys } from "../../src/i18n/merge";
import { agent, mission, notification } from "./fixtures";

const NOW = new Date(2026, 9, 17, 15, 0);
const ago = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

/** Says coded words as the screen does, in pt-BR. */
async function sayer(): Promise<SayWords> {
  const i18n = i18next.createInstance();
  await i18n.init({
    lng: "pt-BR",
    resources: withMobileKeys(resources, { "pt-BR": featureKeysPtBR, en: featureKeysEn }),
    interpolation: { escapeValue: false },
  });
  const tt = i18n.t as unknown as (key: string, options?: Record<string, unknown>) => string;
  return (w, otherwise = "") => tt(w.key, { ...w.values, defaultValue: w.fallback ? tt(w.fallback) : otherwise });
}

describe("Atividade", () => {
  const items = [
    notification({ id: "approval", kind: "approval", waiting: true, updatedAt: ago(1) }),
    notification({ id: "question", kind: "agent_question", waiting: true, updatedAt: ago(3) }),
    notification({ id: "today", updatedAt: ago(1) }),
    notification({ id: "yesterday", updatedAt: ago(24) }),
    notification({ id: "week", updatedAt: ago(24 * 4) }),
    notification({ id: "old", updatedAt: ago(24 * 30) }),
    notification({ id: "done", updatedAt: ago(1), doneAt: ago(0.5) }),
    notification({ id: "snoozed", updatedAt: ago(1), snoozedUntil: new Date(NOW.getTime() + 3_600_000).toISOString() }),
  ];

  test("waiting on top (a question before an approval), the rest by day; done and snoozed leave", () => {
    const s = activitySections(items, "all", NOW);
    expect(s.waiting.map((n) => n.id)).toEqual(["question", "approval"]);
    expect(s.days.map(([g, list]) => [g, list.map((n) => n.id)])).toEqual([
      ["today", ["today"]],
      ["yesterday", ["yesterday"]],
      ["week", ["week"]],
      ["older", ["old"]],
    ]);
  });

  test("waiting cards speak the chat card's words, decide an approval on the card, count once", () => {
    const screen = readFileSync(join(import.meta.dir, "../../src/features/activity/ActivityScreen.tsx"), "utf8");
    // The kinds the chat asks keep the chat's words and icons ("Pede sua aprovação" with the shield).
    expect(screen).toContain("label: t(`ask.kind.");
    expect(screen).toContain("icon: ASK_ICON[ask]");
    // One request this person may decide is decided on the card (the page's one primary on its first card); the rest
    // open where they are decided.
    expect(screen).toContain("request?.canDecide && onCard <= 1 ? request : null");
    expect(screen).toContain("decision={decidable ? <ApproveHere approval={decidable} primary={first} /> : undefined}");
    // How many wait is said once, on the section, not again on the filter.
    expect(screen).toContain('<SectionHeader title={t("mobile.home.waiting")} count={waitingCount} />');
    expect(screen).not.toContain("count: waitingCount");
  });

  test("the waiting filter shows only what waits", () => {
    const s = activitySections(items, "waiting", NOW);
    expect(s.waiting).toHaveLength(2);
    expect(s.days).toEqual([]);
  });

  test("Concluídas: only what is done, by when it was marked done, waiting or not", () => {
    const done = [
      notification({ id: "asked", kind: "approval", waiting: true, updatedAt: ago(1), doneAt: ago(30) }),
      notification({ id: "recent", updatedAt: ago(24 * 9), doneAt: ago(2) }),
    ];
    const s = activitySections([...items, ...done], "done", NOW);
    expect(s.waiting).toEqual([]);
    expect(s.days.map(([g, list]) => [g, list.map((n) => n.id)])).toEqual([
      ["today", ["done", "recent"]],
      ["yesterday", ["asked"]],
    ]);
  });

  test("day groups in local time", () => {
    expect(dayGroupOf(ago(2), NOW)).toBe("today");
    expect(dayGroupOf(ago(20), NOW)).toBe("yesterday");
  });

  test("who did it: up to two names and how many more", () => {
    const names: Record<string, string> = { u1: "Theo", u2: "Ana", u3: "Luíza", u4: "" };
    const nameOf = (a: { id: string }) => names[a.id] ?? "";
    expect(whoOf([{ type: "agent", id: "u1" }], nameOf)).toEqual({ first: "Theo", second: null, more: 0, total: 1 });
    expect(
      whoOf(
        [
          { type: "agent", id: "u1" },
          { type: "user", id: "u2" },
          { type: "user", id: "u3" },
          { type: "user", id: "u4" },
        ],
        nameOf,
      ),
    ).toEqual({ first: "Theo", second: "Ana", more: 1, total: 3 });
  });

  test("the line under the title", async () => {
    const say = await sayer();
    expect(
      subtitleOf(
        notification({ id: "r", kind: "reaction", latest: { quote: "a campanha bateu a meta", emojis: ["🎉"] } }),
        say,
      ),
    ).toBe("a campanha bateu a meta");
    expect(subtitleOf(notification({ id: "a", kind: "approval", latest: { title: "Publicar o ajuste" } }), say)).toBe(
      "Publicar o ajuste",
    );
    expect(emojisOf(notification({ id: "r", kind: "reaction", latest: { emojis: ["🎉", "👏"] } }))).toEqual([
      "🎉",
      "👏",
    ]);
  });

  test("a routine's trouble in the person's words, never the server's English", async () => {
    const say = await sayer();
    const routine = (kind: AppNotification["kind"], latest: AppNotification["latest"]) =>
      subtitleOf(notification({ id: kind, kind, source: { routineId: "rt1", label: "Sentry diário" }, latest }), say);
    expect(routine("routine_failed", { title: "Sentry diário", reason: "budget_exceeded" })).toBe(
      "O orçamento do mês acabou",
    );
    expect(routine("routine_failed", { title: "Sentry diário", reason: "creator_no_access" })).toBe(
      "Não pôde contar: quem criou não pode mais escrever ali",
    );
    // A code the app doesn't know, or none: the plain failure.
    expect(routine("routine_failed", { title: "Sentry diário", reason: "brand_new" })).toBe("Não deu certo");
    expect(routine("routine_failed", { title: "Sentry diário", text: "It failed several times" })).toBe(
      "Não deu certo",
    );
    expect(routine("routine_paused", { title: "Sentry diário", reason: "agent_not_in_channel" })).toBe(
      "Pausada: o agente não está mais no canal",
    );
  });

  test("an approval asked while nobody watched says who asked before the action", async () => {
    const say = await sayer();
    const approval = (origin: AppNotification["latest"]["origin"]) =>
      subtitleOf(
        notification({
          id: "a",
          kind: "approval",
          waiting: true,
          latest: { title: "Fazer merge do PR #42", text: "Os testes passaram e a correção é pequena.", origin },
        }),
        say,
      );
    expect(approval({ kind: "routine", routineId: "rt1", routineName: "Revisar PRs" })).toBe(
      "Pedido pela rotina «Revisar PRs» enquanto ninguém acompanhava · Fazer merge do PR #42",
    );
    expect(approval({ kind: "unattended" })).toBe("Pedido enquanto ninguém acompanhava · Fazer merge do PR #42");
    // A person was there: only the action.
    expect(approval(undefined)).toBe("Fazer merge do PR #42");
  });
});

describe("who is working", () => {
  const run = (
    runId: string,
    agentId: string,
    status: WorkingRun["status"],
    threadId: string | null,
    createdAt = ago(1),
    over: Partial<WorkingRun> = {},
  ): WorkingRun => ({
    runId,
    agentId,
    status,
    threadId,
    channelId: "c1",
    channelKind: "channel",
    channelName: "vendas",
    label: "Cruzando as vendas",
    startedAt: null,
    createdAt,
    ...over,
  });

  test("active missions first, then runs in progress (newest first, one per agent and conversation)", () => {
    const work = workingNow(
      [
        run("r1", "nina", "running", "t9"),
        run("r2", "nina", "queued", "t9", ago(2)),
        run("r3", "dev", "running", "t1"),
        run("r5", "theo", "waiting_approval", null, ago(3), { channelId: "d1", channelKind: "dm", channelName: null }),
      ],
      [mission({ id: "m1", agentId: "dev", threadId: "t1" }), mission({ id: "m2", status: "paused", agentId: "iris" })],
    );
    expect(work.map((w) => w.key)).toEqual(["m:m1", "r:r1", "r:r5"]);
    expect([...busyAgents(work)]).toEqual(["dev", "nina", "theo"]);
  });

  test("a run stopped on a person is marked waiting (it isn't counted as working)", () => {
    const work = workingNow(
      [
        run("r1", "nina", "running", "t9"),
        run("r5", "theo", "waiting_approval", null, ago(3), { channelId: "d1", channelKind: "dm", channelName: null }),
        run("r6", "lisa", "waiting_input", null, ago(4), { channelId: "d2", channelKind: "dm", channelName: null }),
      ],
      [mission({ id: "m1", agentId: "dev", threadId: "t1" })],
    );
    expect(work.map((w) => [w.key, w.waiting])).toEqual([
      ["m:m1", false],
      ["r:r1", false],
      ["r:r5", true],
      ["r:r6", true],
    ]);
  });

  test("a routine's background run is never working (no row, the DM doesn't say trabalhando)", () => {
    const work = workingNow(
      [
        run("bg", "nina", "running", null, ago(1), { channelId: "d1", channelKind: "dm", background: true }),
        run("r1", "dev", "running", "t1"),
      ],
      [],
    );
    expect(work.map((w) => w.key)).toEqual(["r:r1"]);
    expect([...busyChannels(work)]).toEqual(["c1"]);
  });

  test("a run says what it works on, else where it is", () => {
    const [labeled, bare, dm] = workingNow(
      [
        run("r1", "nina", "running", "t9", ago(1)),
        run("r2", "dev", "running", null, ago(2), { label: "  " }),
        run("r3", "theo", "running", null, ago(3), {
          channelId: "d1",
          channelKind: "dm",
          channelName: null,
          label: null,
        }),
      ],
      [],
    );
    expect(labeled).toMatchObject({
      what: "Cruzando as vendas",
      threadId: "t9",
      where: { kind: "channel", name: "vendas" },
    });
    expect(bare).toMatchObject({ what: null, threadId: null, where: { kind: "channel", name: "vendas" } });
    expect(dm).toMatchObject({ what: null, channelId: "d1", where: { kind: "dm", name: null } });
  });

  test("since when: the run's start, else when it was queued; a mission's start, else its creation", () => {
    const [m, started, queued] = workingNow(
      [run("r1", "nina", "running", "t9", ago(5), { startedAt: ago(1) }), run("r2", "theo", "queued", null, ago(2))],
      [mission({ id: "m1", agentId: "dev", threadId: "t1", startedAt: null, createdAt: ago(3) })],
    );
    expect(m?.since).toBe(ago(3));
    expect(started?.since).toBe(ago(1));
    expect(queued?.since).toBe(ago(2));
  });

  test("Agentes: working ones with since when, then free ones by their last conversation, then by name", () => {
    const agents = [
      agent({ id: "bento", name: "Bento" }),
      agent({ id: "nina", name: "Nina" }),
      agent({ id: "iris", name: "Iris" }),
      agent({ id: "ana", name: "Ana" }),
      agent({ id: "theo", name: "Theo" }),
    ];
    const work = workingNow([run("r1", "theo", "running", "t9", ago(0.1)), run("r2", "ghost", "running", "t2")], []);
    const dm = (id: string, hours: number | null, body = "**Pronto**, mandei.") => ({
      with: { type: "agent" as const, id, name: id, handle: id },
      lastMessage: hours === null ? null : { id: `m-${id}`, body, createdAt: ago(hours), authorType: "agent" },
    });
    const { working, free } = teamLines(agents, work, [
      dm("nina", 5),
      dm("iris", 1),
      dm("theo", 0.5),
      dm("ana", null),
      { ...dm("x", 1), with: { type: "person" as const, id: "bento", name: "B", handle: null } },
    ]);
    expect(working.map((l) => [l.agent.id, l.at])).toEqual([["theo", ago(0.1)]]);
    expect(free.map((l) => [l.agent.id, l.at, l.preview])).toEqual([
      ["iris", ago(1), "Pronto, mandei."],
      ["nina", ago(5), "Pronto, mandei."],
      ["ana", null, null],
      ["bento", null, null],
    ]);
  });

  test("how long ago, in the largest whole unit", () => {
    const now = NOW.getTime();
    expect(agoOf(ago(0.001), now)).toEqual({ unit: "now" });
    expect(agoOf(new Date(now + 60_000).toISOString(), now)).toEqual({ unit: "now" });
    expect(agoOf(ago(4 / 60), now)).toEqual({ unit: "minutes", count: 4 });
    expect(agoOf(ago(2.5), now)).toEqual({ unit: "hours", count: 2 });
    expect(agoOf(ago(50), now)).toEqual({ unit: "days", count: 2 });
  });

  test("this month: money only when the API shows it, else the share of the budget", () => {
    expect(
      spendOf({
        budgetUsedPercent: 25,
        monthlyBudgetUsd: 50,
        usage: { agentId: "a", handle: "a", calls: 1, inputTokens: 1, outputTokens: 1, costUsd: 12.4 },
      }),
    ).toEqual({
      kind: "money",
      spentUsd: 12.4,
      budgetUsd: 50,
      fraction: 12.4 / 50,
    });
    const part = spendOf({ budgetUsedPercent: 41.6 });
    // As the server says it: the screen formats it ("42%", "<1%"), never rounding a little down to 0%.
    expect(part).toMatchObject({ kind: "percent", percent: 41.6 });
    expect(spendOf({ budgetUsedPercent: 0.3 })).toMatchObject({ kind: "percent", percent: 0.3 });
    expect(part.fraction).toBeCloseTo(0.416);
    expect(spendOf({ budgetUsedPercent: 140, usage: null })).toMatchObject({ kind: "percent", fraction: 1 });
  });

  test("what it may use: apps and built-in groups that are on", () => {
    const access = {
      all: false,
      builtins: [
        { scope: "drive", label: "Drive", state: "granted", tools: [] },
        { scope: "issues", label: "Issues", state: "off", tools: [] },
      ],
      connectors: [
        { connectionId: "c1", connector: "github", label: "GitHub", custom: false, state: "inherited", scopes: [] },
        { connectionId: "c2", connector: "stripe", label: "Stripe", custom: false, state: "off", scopes: [] },
      ],
    } as unknown as AgentAccess;
    expect(canUse(access).map((x) => x.label)).toEqual(["GitHub", "Drive"]);
    expect(canUse(null)).toEqual([]);
  });
});

describe("Busca", () => {
  test("accents and case don't matter", () => {
    expect(fold("Ação")).toBe("acao");
    expect(matches("acao", "Nova Ação")).toBe(true);
    expect(matches("", "x")).toBe(true);
  });

  test("actions, agents, conversations and only message hits", () => {
    const r = searchResults("nova", {
      actionLabels: { newConversation: "Nova conversa", newTask: "Pedir uma tarefa", newAgent: "Criar agente" },
      agents: [agent({ id: "n", name: "Nina", role: "Dados" })],
      channels: [{ id: "c", name: "nova-loja", topic: "", visibility: "public", isMember: true, createdAt: "" }],
      dms: [],
      hits: [
        {
          kind: "message",
          sourceId: "m1",
          channelIds: ["c"],
          title: "",
          snippet: "nova versão",
          score: 1,
          createdAt: "",
        },
        { kind: "issue", sourceId: "i1", channelIds: [], title: "Nova issue", snippet: "", score: 1, createdAt: "" },
      ],
    });
    expect(r.actions).toEqual(["newConversation"]);
    expect(r.agents).toEqual([]);
    expect(r.channels.map((c) => c.id)).toEqual(["c"]);
    expect(r.messages.map((h) => h.sourceId)).toEqual(["m1"]);
    expect(r.files).toEqual([]);
    expect(isEmpty(r)).toBe(false);
  });

  test("files come from the search API too; chips count each group", () => {
    const file = {
      kind: "file" as const,
      sourceId: "f1",
      channelIds: [],
      title: "Nova proposta.pdf",
      snippet: "",
      score: 1,
      createdAt: "",
    };
    const r = searchResults("nova", {
      actionLabels: { newConversation: "Nova conversa", newTask: "Pedir uma tarefa", newAgent: "Criar agente" },
      agents: [agent({ id: "n", name: "Nova", role: "Dados" })],
      channels: [],
      dms: [],
      hits: [file, { ...file, kind: "message", sourceId: "m1", channelIds: ["c"] }],
    });
    expect(r.files.map((h) => h.sourceId)).toEqual(["f1"]);
    expect(searchCounts(r)).toEqual({ all: 3, chats: 1, team: 0, messages: 1, files: 1 });
    const onlyFiles = filterResults(r, "files");
    expect(onlyFiles.files).toHaveLength(1);
    expect(onlyFiles.actions.length + onlyFiles.agents.length + onlyFiles.messages.length).toBe(0);
    expect(filterResults(r, "chats").agents).toHaveLength(1);
    expect(filterResults(r, "all")).toBe(r);
    // No words: no hits at all, whatever the API still holds.
    expect(
      searchResults("", {
        actionLabels: { newConversation: "a", newTask: "b", newAgent: "c" },
        agents: [],
        channels: [],
        dms: [],
        hits: [file],
      }).files,
    ).toEqual([]);
  });

  test("the team's actions (ADR 0064): only those that open where they happened, with their own chip", () => {
    const action = {
      kind: "action" as const,
      sourceId: "a1",
      channelIds: ["c"],
      title: "open_pull_request",
      snippet: "GitHub · Nova tela de login",
      score: 1,
      createdAt: "",
      author: { type: "agent" as const, id: "ada", name: "Ada" },
    };
    const r = searchResults("nova", {
      actionLabels: { newConversation: "x", newTask: "y", newAgent: "z" },
      agents: [],
      channels: [],
      dms: [],
      hits: [action, { ...action, sourceId: "a2", channelIds: [] }],
    });
    expect(r.team.map((h) => h.sourceId)).toEqual(["a1"]);
    expect(searchCounts(r)).toMatchObject({ all: 1, team: 1 });
    expect(filterResults(r, "team").team).toHaveLength(1);
    expect(filterResults(r, "messages").team).toEqual([]);
  });
});

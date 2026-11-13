import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { ApiClient, Routine, RoutineRun } from "@agenteschat/client";
import { ApiError } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { clockAt } from "@agenteschat/client/lib/format";
import { RUN_CODES, runOutcome } from "@agenteschat/client/lib/routine-view";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import type { TFunction } from "i18next";
import { createI18n } from "@/i18n";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, type FakeState, fakeMachinesOf, ORG_ID, seedState } from "./fake-api";
import { routineRun } from "./fakes/planning";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const rule = { freq: "daily" as const, times: ["09:00"], timezone: "America/Sao_Paulo" };
const daily = {
  type: "schedule" as const,
  phrase: null,
  rule,
  cron: "0 9 * * *",
  timezone: "America/Sao_Paulo",
  description: "Todos os dias, às 09:00",
};

/** A routine as the server sends it (ADR 0053 §11), active by default. */
const routine = (over: Partial<Routine> & Pick<Routine, "id" | "name">): Routine => ({
  agentId: ATLAS_ID,
  prompt: "Olhe os erros novos do Sentry e conte o que achar.",
  target: { type: "channel", channelId: ENG_ID },
  trigger: daily,
  active: true,
  nextRunAt: new Date(Date.now() + 3_600_000).toISOString(),
  createdAt: ago(60 * 24 * 10),
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
});

/** The fake backend, with these routines and runs in Rotinas; every routine call is recorded. */
function withRoutines(list: Routine[], runs: Record<string, RoutineRun[]> = {}, state: FakeState = seedState()) {
  const base = createFakeApi(state);
  const calls: string[] = [];
  const find = (id: string) => list.find((r) => r.id === id) as Routine;
  const api: ApiClient = {
    ...base,
    routines: {
      ...base.routines,
      list: async () => structuredClone(list),
      runs: async (_orgId, id) => structuredClone(runs[id] ?? []),
      setActive: async (_orgId, id, active) => {
        calls.push(`active:${id}:${active}`);
        const r = find(id);
        Object.assign(r, { active, state: active ? "active" : "paused" }, active ? { pausedReason: null } : {});
        return structuredClone(r);
      },
      stop: async (_orgId, id) => {
        calls.push(`stop:${id}`);
        const r = find(id);
        r.state = "active";
        return structuredClone(r);
      },
      takeOver: async (_orgId, id) => {
        calls.push(`takeOver:${id}`);
        return structuredClone(find(id));
      },
      continueUsage: async (_orgId, id) => {
        calls.push(`continueUsage:${id}`);
        const r = find(id);
        Object.assign(r, { state: "running", usagePause: null });
        return structuredClone(r);
      },
    },
  };
  return { api, calls, state, machines: fakeMachinesOf.get(base) };
}

const open = async (list: Routine[], runs?: Record<string, RoutineRun[]>, state?: FakeState) => {
  const r = withRoutines(list, runs, state);
  await renderApp(`/org/${ORG_ID}/routines`, { api: r.api });
  await settle(8);
  return r;
};
/** Rotinas in a workspace with these computers (`GET …/machines`); on the Cloud, its own one. */
const openOn = async (list: Routine[], computers: string[], runs?: Record<string, RoutineRun[]>, cloud = false) => {
  const r = withRoutines(list, runs);
  if (cloud) r.machines?.setSetup({ state: "ready" });
  for (const name of computers) r.machines?.pair({ name, ...(cloud ? { kind: "managed" as const } : {}) });
  const view = await renderApp(`/org/${ORG_ID}/routines`, { api: r.api });
  await settle(8);
  return view;
};
const card = (name: string) => screen().getByRole("article", { name });
const details = async (name: string) => {
  await click(within(card(name)).getByRole("button", { name }));
  await settle(4);
  return screen().getByRole("dialog", { name });
};
/** The details' strip under its head: "No ar" and the fields that change at once. */
const asideOf = (panel: HTMLElement) => within(panel).getByRole("group", { name: /^Detalhes: / });
/** What a control means: its description to a screen reader, the words its tip shows. */
const meaning = (el: HTMLElement) =>
  (el.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ")
    .trim();
/** The details' "Execuções" tab (Radix tabs switch on mouse down). */
const runsTab = async (panel: HTMLElement) => {
  await act(async () => fireEvent.mouseDown(within(panel).getByRole("tab", { name: /^Execuções/ }), { button: 0 }));
  await settle(2);
};

describe("Rotinas: each routine's state, with its one-tap fix", () => {
  test("paused because the agent left the channel: the reason and 'Adicionar agente ao canal'", async () => {
    const { calls, state } = await open([
      routine({
        id: "rt-left",
        name: "Vigiar erros",
        active: false,
        state: "paused",
        pausedReason: "agent_not_in_channel",
        nextRunAt: null,
      }),
    ]);
    const row = card("Vigiar erros");
    expect(row.textContent).toContain("Pausada: o agente não está mais no canal");
    await click(within(row).getByRole("button", { name: "Adicionar agente ao canal" }));
    await settle(6);
    // The agent joins the channel it reports to, then the routine runs again.
    expect(state.calls.find((c) => c.method === "chat.addMember")?.args).toEqual([
      ORG_ID,
      ENG_ID,
      { agentId: ATLAS_ID },
    ]);
    expect(calls).toContain("active:rt-left:true");
    expect(screen().getByText("Atlas voltou ao canal e a rotina está ativa de novo.")).toBeTruthy();
  });

  test("paused because its creator left: someone takes it over", async () => {
    const { calls } = await open([
      routine({ id: "rt-gone", name: "Resumo diário", active: false, state: "paused", pausedReason: "creator_left" }),
    ]);
    const row = card("Resumo diário");
    expect(row.textContent).toContain("Pausada: quem criou saiu do workspace");
    await click(within(row).getByRole("button", { name: "Assumir rotina" }));
    await settle(6);
    expect(calls).toEqual(["takeOver:rt-gone", "active:rt-gone:true"]);
  });

  test("failing, waiting for the computer: said on the row; a plain pause stays quiet", async () => {
    const waiting = routine({
      id: "rt-mac",
      name: "Relatório de vendas",
      state: "waiting_computer",
      waitingFor: { machineId: "mac-1", machineName: "MacBook do Walter", since: ago(40) },
      brain: { kind: "claude_code", machineName: "MacBook do Walter" },
    });
    // The computer by its name only where the workspace has more than one.
    const two = await openOn([structuredClone(waiting)], ["MacBook do Walter", "Mac mini"]);
    expect(card("Relatório de vendas").textContent).toContain("Esperando o MacBook do Walter desde");
    two.unmount();
    await open([
      routine({ id: "rt-fail", name: "Caixa de entrada", state: "failing", failuresInRow: 3 }),
      waiting,
      routine({ id: "rt-off", name: "Pausada à mão", active: false, state: "paused", nextRunAt: null }),
    ]);
    expect(card("Caixa de entrada").textContent).toContain("Falhando (3 seguidas)");
    expect(card("Relatório de vendas").textContent).toContain("Esperando o computador desde");
    expect(card("Relatório de vendas").textContent).not.toContain("MacBook");
    // Paused by a person: "Pausada" as before, no fix button on the row.
    const off = card("Pausada à mão");
    expect(off.querySelector(".ac-chip--waiting")).toBeNull();
    expect(within(off).queryByRole("button", { name: "Retomar" })).toBeNull();
  });

  test("paused near its plan's limit: until when, quietly; Continuar agora for its people, greyed with the reason for others", async () => {
    const resetsAt = new Date(Date.now() + 2 * 3_600_000).toISOString();
    const clock = clockAt("pt-BR", resetsAt);
    const paused = (over: Partial<Routine> & Pick<Routine, "id" | "name">) =>
      routine({
        state: "usage_paused",
        usagePause: { source: "plan", resetsAt, extraOff: false },
        brain: { kind: "claude_code", machineName: null },
        ...over,
      });
    const { calls, state } = await open([
      paused({ id: "rt-plan", name: "Revisar deploys" }),
      paused({ id: "rt-other", name: "Resumo do suporte", canManage: false }),
      paused({
        id: "rt-extra",
        name: "Triagem de issues",
        usagePause: { source: "plan", resetsAt, extraOff: true },
      }),
    ]);
    const row = card("Revisar deploys");
    expect(row.textContent).toContain(`Pausada até ${clock} (limite do plano)`);
    // Quiet: no chip asking for a look, no fix on the row.
    expect(row.querySelector(".ac-chip--waiting")).toBeNull();
    // Its run is still at work: "Não rodar" cancels it, not "Rodar agora" (which would throw its progress away).
    expect(within(row).getByRole("button", { name: "Não rodar Revisar deploys quando o limite voltar" })).toBeTruthy();
    expect(within(row).queryByRole("button", { name: "Rodar agora" })).toBeNull();

    const mine = await details("Revisar deploys");
    expect(mine.textContent).toContain(`Pausada até ${clock} (limite do plano)`);
    expect(within(mine).getByRole("button", { name: "Não rodar" })).toBeTruthy();
    expect(within(mine).queryByRole("button", { name: "Rodar agora" })).toBeNull();
    const go = within(mine).getByRole("button", { name: "Continuar agora" }) as HTMLButtonElement;
    expect(go.disabled).toBe(false);
    await click(go);
    await settle(6);
    expect(calls).toEqual(["continueUsage:rt-plan"]);
    expect(screen().getByText("Execução continuando.")).toBeTruthy();
    // Nothing is posted in the conversation.
    expect(state.calls.some((c) => c.method.startsWith("chat."))).toBe(false);
    await click(within(mine).getByRole("button", { name: "Fechar detalhes" }));
    await settle(4);

    const theirs = await details("Resumo do suporte");
    expect((within(theirs).getByRole("button", { name: "Continuar agora" }) as HTMLButtonElement).disabled).toBe(true);
    expect(theirs.textContent).toContain("Só quem criou a rotina, o dono do agente ou um admin pode continuar agora");
    await click(within(theirs).getByRole("button", { name: "Fechar detalhes" }));
    await settle(4);

    const off = await details("Triagem de issues");
    expect((within(off).getByRole("button", { name: "Continuar agora" }) as HTMLButtonElement).disabled).toBe(true);
    expect(off.textContent).toContain(
      "A janela deste plano acabou e o trabalho longo deste agente não usa o uso extra pago",
    );
  });

  test("waiting at the plan's own limit: which plan and when it runs, no Continuar agora, and Não rodar cancels it", async () => {
    const resetsAt = new Date(Date.now() + 25 * 60_000).toISOString();
    const clock = clockAt("pt-BR", resetsAt);
    const { calls } = await open([
      routine({
        id: "rt-limit",
        name: "Resumo da manhã",
        state: "usage_paused",
        usagePause: { source: "plan", resetsAt, limit: true, plan: "Claude", extraOff: false },
        brain: { kind: "claude_code", machineName: null },
      }),
    ]);
    const row = card("Resumo da manhã");
    expect(row.textContent).toContain(`Esperando o plano do Claude · roda às ${clock}`);
    expect(row.textContent).not.toContain("Rodando");
    const panel = await details("Resumo da manhã");
    expect(panel.textContent).toContain("Roda sozinha quando o limite voltar");
    expect(within(panel).queryByRole("button", { name: "Continuar agora" })).toBeNull();
    await click(within(panel).getByRole("button", { name: "Não rodar" }));
    await settle(6);
    expect(calls).toEqual(["stop:rt-limit"]);
    expect(screen().getByText("Cancelado. Não vai rodar quando o limite voltar.")).toBeTruthy();
  });

  test("Continuar agora on a run its timed job already holds: no 'Execução continuando.'", async () => {
    const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
    const r = withRoutines([
      routine({
        id: "rt-late",
        name: "Revisar deploys",
        state: "usage_paused",
        usagePause: { source: "plan", resetsAt, extraOff: false },
      }),
    ]);
    const routines = r.api.routines;
    r.api.routines = {
      ...routines,
      continueUsage: async (_orgId, id) => {
        r.calls.push(`continueUsage:${id}`);
        return structuredClone((await routines.list(ORG_ID)).find((x) => x.id === id) as Routine);
      },
    };
    await renderApp(`/org/${ORG_ID}/routines`, { api: r.api });
    await settle(8);
    const panel = await details("Revisar deploys");
    await click(within(panel).getByRole("button", { name: "Continuar agora" }));
    await settle(6);
    expect(r.calls).toEqual(["continueUsage:rt-late"]);
    expect(screen().queryByText("Execução continuando.")).toBeNull();
  });

  test("a run a person stopped reads 'Parada', not 'Não rodou'; every N minutes in Portuguese", async () => {
    const stopped = routineRun({ at: ago(5), status: "canceled", code: "stopped" });
    await open([
      routine({ id: "rt-stop", name: "Issues da Ada", lastRun: stopped, recentRuns: [stopped] }),
      routine({
        id: "rt-30",
        name: "Avaliações",
        trigger: {
          type: "schedule",
          cron: "*/30 * * * *",
          timezone: "America/Sao_Paulo",
          description: "Every 30 minutes",
        },
      }),
    ]);
    expect(card("Issues da Ada").textContent).toContain("Parada há 5 min");
    expect(card("Issues da Ada").textContent).not.toContain("Não rodou");
    expect(card("Avaliações").textContent).toContain("A cada 30 minutos");
    expect(card("Avaliações").textContent).not.toContain("Every");
  });

  test("a run's record reads as Markdown, folded when long, with the rest a click away", async () => {
    const record = `Contou o que achou\n\n- **Verificado:** PRs abertos em \`agentes.chat\`\n- ${"Nada novo. ".repeat(40)}`;
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, value: 400 });
    await open([routine({ id: "rt-md", name: "Revisar PRs" })], {
      "rt-md": [routineRun({ at: ago(5), status: "silent", summary: record })],
    });
    const panel = await details("Revisar PRs");
    await runsTab(panel);
    const words = panel.querySelector(".routine-runs__words") as HTMLElement;
    expect(words.querySelector("strong")?.textContent).toBe("Verificado:");
    expect(words.querySelector("code")?.textContent).toBe("agentes.chat");
    expect(words.textContent).not.toContain("**");
    expect(words.querySelector("[data-folded]")).toBeTruthy();
    await click(within(words).getByRole("button", { name: "Mostrar mais" }));
    expect(words.querySelector("[data-folded]")).toBeNull();
    expect(within(words).getByRole("button", { name: "Mostrar menos" })).toBeTruthy();
    Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
  });

  test("a record's mentions say the name, as in a message", async () => {
    await open([routine({ id: "rt-name", name: "Revisar PRs" })], {
      "rt-name": [routineRun({ at: ago(5), status: "silent", summary: "Falei com @ada." })],
    });
    const panel = await details("Revisar PRs");
    await runsTab(panel);
    expect(panel.querySelector(".routine-runs__words")?.textContent).toContain("@Ada");
  });

  test("a long record that fits this width shows whole: no button, no fade", async () => {
    await open([routine({ id: "rt-fits", name: "Revisar PRs" })], {
      "rt-fits": [routineRun({ at: ago(5), status: "silent", summary: "Nada novo. ".repeat(40) })],
    });
    const panel = await details("Revisar PRs");
    await runsTab(panel);
    const words = panel.querySelector(".routine-runs__words") as HTMLElement;
    expect(within(words).queryByRole("button")).toBeNull();
    expect(words.querySelector("[data-cut]")).toBeNull();
  });

  test("a short record shows whole, with no button", async () => {
    await open([routine({ id: "rt-short", name: "Revisar PRs" })], {
      "rt-short": [routineRun({ at: ago(5), status: "silent", summary: "Nada novo." })],
    });
    const panel = await details("Revisar PRs");
    await runsTab(panel);
    expect(within(panel.querySelector(".routine-runs__words") as HTMLElement).queryByRole("button")).toBeNull();
  });

  test("the strip's last runs read as sentences: each after the first starts with a capital", async () => {
    const now = routineRun({ at: ago(0.5), status: "reported" });
    const yesterday = routineRun({ at: ago(24 * 60), status: "silent" });
    await open([routine({ id: "rt-runs", name: "Erros do Sentry", lastRun: now, recentRuns: [now, yesterday] })]);
    const strip = within(card("Erros do Sentry")).getByRole("img", { name: /^Últimas execuções/ });
    expect(strip.getAttribute("aria-label")).toMatch(
      /^Últimas execuções: agora: respondeu\. Ontem \d{1,2}:\d{2}: nada novo, ficou em silêncio$/,
    );
  });
});

describe("Rotinas: a routine's details", () => {
  const busy = routine({
    id: "rt-run",
    name: "Revisar PRs",
    agentId: ADA_ID,
    state: "running",
    access: "act",
    report: "always",
    trigger: { ...daily, rule: { freq: "hourly", interval: 1, times: ["00:15"], timezone: "America/Sao_Paulo" } },
    brain: { kind: "claude_code", machineName: "MacBook do Walter" },
    health: { ok: 10, silent: 2, failed: 0, skipped: 1, missed: 1, total: 14 },
    usage: { runs: 14, tokens: 120_000, costNanoUsd: 0, billedTo: "plan" },
  });
  const runs = {
    "rt-run": [
      routineRun({ at: ago(5), status: "running" }),
      routineRun({
        at: ago(60),
        status: "reported",
        summary: "3 erros novos no checkout",
        link: { channelId: ENG_ID, threadId: null, messageId: "m-1" },
      }),
      routineRun({ at: ago(120), status: "skipped", code: "previous_running" }),
      routineRun({ at: ago(180), status: "waiting", approvalId: "ap-merge" }),
      routineRun({ at: ago(240), status: "canceled", code: "stopped", codeParams: { by: "u-joao" } }),
      routineRun({ at: ago(300), status: "failed", code: "something_new" }),
    ],
  };

  test("waiting for its computer: 'Trocar computador' where people connect their own, none on the Cloud", async () => {
    const waiting = routine({
      id: "rt-mac",
      name: "Relatório de vendas",
      state: "waiting_computer",
      waitingFor: { machineId: "mac-1", machineName: "MacBook do Walter", since: ago(40) },
      brain: { kind: "claude_code", machineName: "MacBook do Walter" },
    });
    const agents = [
      { agentId: ATLAS_ID, name: "Atlas", brain: "claude_code" as const, waiting: { routines: 1, conversations: 0 } },
    ];
    for (const cloud of [false, true]) {
      const r = withRoutines([structuredClone(waiting)]);
      r.machines?.setOutages({
        outages: [
          {
            machineId: "mac-1",
            name: "MacBook do Walter",
            platform: "darwin",
            offlineSince: ago(40),
            agents,
            waitingRuns: 1,
          },
        ],
        targets: [],
      });
      if (cloud) r.machines?.setSetup({ state: "ready" });
      const view = await renderApp(`/org/${ORG_ID}/routines`, { api: r.api });
      await settle(8);
      const panel = await details("Relatório de vendas");
      expect(within(panel).queryByRole("button", { name: "Trocar computador" }) !== null).toBe(!cloud);
      view.unmount();
    }
  });

  test("the week, where it runs, how it works and each run in plain words", async () => {
    await openOn([busy], ["MacBook do Walter", "Mac mini"], runs);
    const panel = await details("Revisar PRs");
    const region = (name: string) => within(panel).getByRole("region", { name });
    const aside = asideOf(panel);
    // This week in its well: how many went right, then what else happened; the usage on the strip's quiet line.
    const week = panel.querySelector(".routine-week") as HTMLElement;
    expect(week.querySelector("b")?.textContent).toBe("12 de 14 OK esta semana");
    expect(week.textContent).toContain("2 puladas");
    expect(panel.querySelector(".routine-props__line")?.textContent).toContain(
      "Uso esta semana: 14 execuções · 120 mil tokens do plano",
    );
    // Two computers: where it runs is the computer, by its name alone.
    expect(aside.textContent).toContain("Onde roda: MacBook do Walter");
    expect(panel.textContent).not.toContain("Claude Code no");
    // Hourly on someone's computer: how often it wakes it, with when it runs.
    expect(region("Próximas").textContent).toContain("Roda 24 vezes por dia no MacBook do Walter");
    // Every routine does what its agent can (ADR 0109): no access section.
    expect(panel.textContent).not.toContain("Pode agir");
    // When it posts: the answer, its line as its meaning, and what the choice means behind its ⓘ.
    const posts = within(aside).getByRole("combobox", { name: "Quando posta" });
    expect(posts.textContent).toContain("Toda vez");
    expect(meaning(posts)).toBe("Mesmo sem novidade");
    const about = within(aside).getByRole("button", { name: "Sobre Quando posta" });
    expect(document.getElementById(about.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "Posta depois de toda execução, mesmo quando nada mudou, ou só quando encontra algo novo.",
    );
    // Where it delivers, with who sees it.
    expect(meaning(within(aside).getByRole("combobox", { name: "Onde entrega" }))).toBe("Todo mundo do canal vê");
    // The runs are their own tab.
    expect(panel.textContent).not.toContain("Contou o que achou");
    await runsTab(panel);
    const text = panel.textContent ?? "";
    expect(text).toContain("Trabalhando agora");
    expect(text).toContain("Contou o que achou");
    expect(text).toContain("3 erros novos no checkout");
    expect(text).toContain("Pulada: a anterior ainda estava rodando");
    expect(text).toContain("Parada por João");
    // An unknown code still says what happened.
    expect(text).toContain("Não deu certo");
    expect(within(panel).getByRole("link", { name: "Abrir na conversa" }).getAttribute("href")).toContain(
      `/c/${ENG_ID}?m=m-1`,
    );
    expect(within(panel).getByRole("link", { name: "Esperando sua aprovação" }).getAttribute("href")).toContain(
      "open=ap-merge",
    );
    // No internal names anywhere.
    expect(text).not.toMatch(/runner|MCP|Jev/);
  });

  test("one computer says nothing about where it runs; the Cloud's, always on, no busy note either", async () => {
    const one = await openOn([structuredClone(busy)], ["MacBook do Walter"], runs);
    let panel = await details("Revisar PRs");
    expect(asideOf(panel).textContent).not.toContain("Onde roda");
    // Still someone's computer, which has to stay on: unnamed.
    expect(within(panel).getByRole("region", { name: "Próximas" }).textContent).toContain(
      "Roda 24 vezes por dia no computador, que precisa ficar ligado.",
    );
    expect(panel.textContent).not.toContain("MacBook");
    one.unmount();
    const cloud = {
      ...structuredClone(busy),
      brain: { kind: "claude_code" as const, machineName: "Computador da Acme" },
    };
    await openOn([cloud], ["Computador da Acme"], runs, true);
    panel = await details("Revisar PRs");
    expect(asideOf(panel).textContent).not.toContain("Onde roda");
    expect(panel.textContent).not.toContain("Computador da Acme");
    expect(panel.textContent).not.toContain("Roda 24 vezes");
  });

  test("running: Parar stops it quietly", async () => {
    const { calls } = await open([busy], runs);
    await click(within(card("Revisar PRs")).getByRole("button", { name: "Parar Revisar PRs" }));
    await settle(4);
    expect(calls).toContain("stop:rt-run");
    expect(screen().getByText("Execução parada.")).toBeTruthy();
  });

  test("someone who may only see outcomes: no prompt, no text, no actions", async () => {
    await open(
      [routine({ id: "rt-priv", name: "Caixa do suporte", prompt: null, canSeeDetails: false, canManage: false })],
      { "rt-priv": [routineRun({ at: ago(30), status: "reported", summary: "" })] },
    );
    const row = card("Caixa do suporte");
    expect(within(row).queryByRole("switch")).toBeNull();
    expect(within(row).queryByRole("button", { name: "Rodar agora" })).toBeNull();
    const panel = await details("Caixa do suporte");
    expect(panel.textContent).toContain("Só quem criou, o dono do agente, admins e quem está na conversa veem isto.");
    expect(within(panel).queryByRole("button", { name: "Editar" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Editar o nome" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Rodar agora" })).toBeNull();
    // Every routine does what its agent can (ADR 0109): no access section; when it posts: the answer, its meaning behind the ⓘ.
    expect(within(panel).queryByRole("region", { name: "O que pode fazer sozinha" })).toBeNull();
    const aside = asideOf(panel);
    expect(within(aside).queryByRole("switch")).toBeNull();
    expect(within(aside).queryByRole("combobox")).toBeNull();
    expect(within(aside).getByRole("button", { name: "Sobre Quando posta" })).toBeTruthy();
    expect(aside.textContent).toContain("Só quando tiver novidade");
    await runsTab(panel);
    expect(panel.textContent).toContain("Contou o que achou");
  });

  test("who may see it but not change it: the values in the strip, the prompt as text, no pencils", async () => {
    await open([routine({ id: "rt-ro", name: "Erros do dia", canManage: false })]);
    const panel = await details("Erros do dia");
    const aside = asideOf(panel);
    expect(within(aside).queryByRole("switch")).toBeNull();
    expect(within(aside).queryByRole("combobox")).toBeNull();
    expect(within(aside).queryByRole("button", { name: /^Quando/ })).toBeNull();
    expect(aside.textContent).toContain("No ar");
    expect(aside.textContent).toContain("Quem faz");
    expect(aside.textContent).toContain("Atlas");
    expect(aside.textContent).toContain("#eng");
    expect(aside.textContent).toContain("Todo mundo do canal vê");
    expect(aside.textContent).toContain("Só quando tiver novidade");
    expect(panel.textContent).toContain("Olhe os erros novos do Sentry e conte o que achar.");
    expect(within(panel).queryByRole("button", { name: "Editar o nome" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Editar o que ela faz" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Rodar agora" })).toBeNull();
  });

  test("a routine made in a DM says only you see it there, not everyone in the channel", async () => {
    const state = seedState({
      dms: [{ channelId: "dm-jorge", with: { type: "person", id: "u-joao", name: "Jorge", handle: "jorge" } }],
    });
    await open(
      [
        routine({
          id: "rt-dm",
          name: "Lembrar do fornecedor",
          target: { type: "conversation", channelId: "dm-jorge", threadId: null },
        }),
      ],
      {},
      state,
    );
    const panel = await details("Lembrar do fornecedor");
    const where = within(asideOf(panel)).getByRole("combobox", { name: "Onde entrega" });
    expect(where.textContent).toContain("Na DM com o Jorge");
    expect(meaning(where)).toBe("Só você vê");
  });
});

describe("Rotinas: a run at work, whatever the routine says", () => {
  test("a paused routine's manual run and a fired one-off's run read as running, with Parar", async () => {
    const once = { type: "once" as const, at: ago(5), timezone: "America/Sao_Paulo", description: "" };
    const { calls } = await open([
      routine({ id: "rt-paused", name: "Resumo pausado", active: false, state: "running", nextRunAt: null }),
      routine({
        id: "rt-once",
        name: "Resumo de hoje",
        active: false,
        state: "running",
        nextRunAt: null,
        trigger: once,
      }),
    ]);
    // The one-off isn't done while its run works: it is in the list, not under "Concluídos".
    expect(screen().queryByRole("button", { name: /Concluídos/ })).toBeNull();
    expect(within(card("Resumo pausado")).getByRole("button", { name: "Parar Resumo pausado" })).toBeTruthy();
    const fired = card("Resumo de hoje");
    // Nothing to turn on or run again: only Parar.
    expect(within(fired).queryByRole("switch")).toBeNull();
    expect(within(fired).queryByRole("button", { name: "Rodar agora" })).toBeNull();
    await click(within(fired).getByRole("button", { name: "Parar Resumo de hoje" }));
    await settle(4);
    expect(calls).toContain("stop:rt-once");
    // The details say it runs, with Parar, instead of "Pausada".
    const panel = await details("Resumo pausado");
    expect(panel.textContent).toContain("Rodando");
    expect(within(panel).getByRole("button", { name: "Parar" })).toBeTruthy();
  });
});

describe("Rotinas: every code in the person's words", () => {
  test("each run code the server writes has its own words; a report it couldn't deliver isn't 'Não rodou'", () => {
    const i18n = createI18n("pt-BR");
    const said = (lng: string, code: string) => i18n.getResource(lng, "translation", `routines.code.${code}`);
    const missing = ["pt-BR", "en"].flatMap((lng) => RUN_CODES.filter((c) => !said(lng, c)).map((c) => `${lng}:${c}`));
    expect(missing).toEqual([]);
    const say = i18n.t.bind(i18n) as unknown as (key: string) => string;
    expect(say(runOutcome({ status: "skipped", code: "creator_no_access" }).key)).toBe(
      "Não pôde contar: quem criou não pode mais escrever ali",
    );
    expect(say(runOutcome({ status: "failed", code: "empty_reply" }).key)).toBe("O modelo não respondeu nada");
  });

  test("a routine refused by the server says why in the person's language", () => {
    const i18n = createI18n("pt-BR");
    const t = i18n.t.bind(i18n) as TFunction;
    const refused = (status: number, code: string) => errorText(t, new ApiError(status, code, "English message"));
    expect(refused(400, "routine.creator_cannot_post")).toBe(
      "Quem cria a rotina precisa estar na conversa e poder escrever nela.",
    );
    expect(refused(403, "routine.take_over_no_access")).toBe("Entre na conversa da rotina antes de assumi-la.");
    expect(refused(400, "routine.agent_not_in_channel")).toBe("Adicione o agente à conversa antes.");
    const en = createI18n("en");
    expect(errorText(en.t.bind(en) as TFunction, new ApiError(400, "routine.agent_not_in_channel", "x"))).toBe(
      "Add the agent to the conversation first.",
    );
  });
});

describe("Rotinas: the form's two plain questions", () => {
  test("no routines: what they give, and the one Nova rotina in the middle of the page", async () => {
    await open([]);
    const empty = document.querySelector(".ac-empty") as HTMLElement;
    expect(empty.querySelector(".ac-empty__title")?.textContent).toBe("Deixe o trabalho repetido com os agentes");
    expect(within(empty).getByRole("button", { name: "Nova rotina" })).toBeTruthy();
    expect(screen().getAllByRole("button", { name: "Nova rotina" })).toHaveLength(1);
    expect(document.querySelector(".ac-pagehead")?.querySelectorAll("p")).toHaveLength(1);
  });

  test("Quando posta, sent with the routine; no access choice", async () => {
    const api = createFakeApi(seedState());
    await renderApp(`/org/${ORG_ID}/routines`, { api });
    await settle(8);
    await click(screen().getByRole("button", { name: "Nova rotina" }));
    await settle(4);
    const dialog = screen().getByRole("dialog", { name: "Nova rotina" });
    // The default: only when there's news. Every routine does what its agent can: nothing to choose there.
    expect(within(dialog).getByRole("radio", { name: "Só quando tiver novidade" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(within(dialog).queryByRole("radio", { name: "Só olhar e contar" })).toBeNull();
    expect(within(dialog).queryByRole("radio", { name: "Pode agir" })).toBeNull();
    // What each answer means is one ⓘ beside the question; no line under it.
    const posts = within(dialog).getByRole("button", { name: "Sobre Quando posta" });
    expect(document.getElementById(posts.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "Posta depois de toda execução, mesmo quando nada mudou, ou só quando encontra algo novo.",
    );
    await click(within(dialog).getByRole("radio", { name: "Toda vez" }));
    expect(posts.closest(".ac-field")?.querySelectorAll(".ac-field__example")).toHaveLength(0);
    await act(async () =>
      fireEvent.change(within(dialog).getByLabelText("O que fazer"), { target: { value: "Revise os PRs abertos." } }),
    );
    await act(async () =>
      fireEvent.change(within(dialog).getByLabelText("Nome (opcional)"), { target: { value: "PRs abertos" } }),
    );
    await click(within(dialog).getByRole("button", { name: "Criar rotina" }));
    await settle(6);
    const made = (await api.routines.list(ORG_ID)).find((r) => r.name === "PRs abertos");
    expect(made).toMatchObject({ report: "always" });
    expect(made?.access).toBe("act");
  });
});

describe("Approval cards: why, and asked while nobody watched", () => {
  test("the request: the agent's why in its words, then the action, then the routine that asked", async () => {
    const state = seedState();
    const first = state.approvals[0];
    if (first) {
      first.why = "O PR #42 corrige o login que quebrou no deploy das 9h; os testes passaram.";
      first.origin = { kind: "routine", routineId: "rt-1", routineName: "Revisar PRs" };
    }
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(6);
    const group = screen().getByRole("group", { name: "Pedido de aprovação" });
    // Where it came from is with the rest of the action, behind "Ver detalhes".
    await act(async () => fireEvent.click(within(group).getByRole("button", { name: "Ver detalhes" })));
    const text = group.textContent ?? "";
    const why = text.indexOf("O PR #42 corrige o login");
    const action = text.indexOf("Fazer um merge");
    const origin = text.indexOf("rotina «Revisar PRs»");
    expect(why).toBeGreaterThan(-1);
    expect(action).toBeGreaterThan(why);
    expect(origin).toBeGreaterThan(action);
  });
});

describe("Chat: what a routine found", () => {
  test("the agent's message is tagged with the routine; the report it answers folds into it", async () => {
    const state = seedState();
    const at = (minutes: number) => ago(minutes);
    state.messages.push(
      {
        id: "m-report",
        channelId: ENG_ID,
        threadId: null,
        author: { type: "agent", id: ATLAS_ID },
        body: "",
        mentionedAgentIds: [],
        agentRunId: null,
        meta: {
          notice: {
            kind: "routine_handoff",
            text: "Relatório: 3 erros novos no checkout desde ontem.",
            refs: { routineName: "Sentry diário", routineId: "rt-s" },
          },
        },
        createdAt: at(3),
      },
      {
        id: "m-told",
        channelId: ENG_ID,
        threadId: null,
        author: { type: "agent", id: ATLAS_ID },
        body: "Achei 3 erros novos no checkout; o maior afeta 12% dos pagamentos.",
        mentionedAgentIds: [],
        agentRunId: null,
        meta: { routine: { id: "rt-s", name: "Sentry diário", runId: "rr-1", noticeId: "m-report" } },
        createdAt: at(2),
      },
    );
    const { api } = withRoutines([routine({ id: "rt-s", name: "Sentry diário" })], {}, state);
    const { router } = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(6);
    // The report's own line is folded into the message that tells it.
    expect(screen().queryByText(/Rotina «Sentry diário» entregou um relatório/)).toBeNull();
    const row = screen()
      .getAllByRole("article")
      .find((a) => a.textContent?.includes("Achei 3 erros novos")) as HTMLElement;
    const tag = within(row).getByRole("link", { name: "Rotina «Sentry diário»" });
    // A new tab still lands on Rotinas with the routine open; a click opens it here, over the conversation.
    expect(tag.getAttribute("href")).toContain("open=rt-s");
    await click(tag);
    await settle(4);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);
    const dialog = screen().getByRole("dialog", { name: "Sentry diário" });
    expect(within(dialog).getByRole("heading", { level: 1, name: "Sentry diário" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Editar o nome" })).toBeTruthy();
    await click(within(dialog).getByRole("button", { name: "Fechar detalhes" }));
    expect(screen().queryByRole("dialog", { name: "Sentry diário" })).toBeNull();
    expect(
      screen()
        .getAllByRole("article")
        .some((a) => a === row),
    ).toBe(true);
    expect(row.textContent).not.toContain("Relatório: 3 erros novos");
    await click(within(row).getByRole("button", { name: "Ver relatório" }));
    expect(row.textContent).toContain("Relatório: 3 erros novos no checkout desde ontem.");
  });

  test("a run's Abrir na conversa into the conversation underneath closes the details over it", async () => {
    const state = seedState();
    state.messages.push({
      id: "m-told",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: ATLAS_ID },
      body: "Bom dia, time!",
      mentionedAgentIds: [],
      agentRunId: null,
      meta: { routine: { id: "rt-bd", name: "Resumo da manhã", runId: "rr-1" } },
      createdAt: ago(2),
    });
    const runs = {
      "rt-bd": [
        routineRun({
          at: ago(2),
          status: "reported",
          summary: "Resumo da manhã",
          link: { channelId: ENG_ID, threadId: null, messageId: "m-told" },
        }),
      ],
    };
    const { api } = withRoutines([routine({ id: "rt-bd", name: "Resumo da manhã" })], runs, state);
    const { router } = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(6);
    await click(screen().getByRole("link", { name: "Rotina «Resumo da manhã»" }));
    await settle(4);
    const dialog = screen().getByRole("dialog", { name: "Resumo da manhã" });
    await runsTab(dialog);
    await click(within(dialog).getByRole("link", { name: "Abrir na conversa" }));
    await settle(4);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);
    expect(router.state.location.search).toEqual({ m: "m-told" });
    expect(screen().queryByRole("dialog", { name: "Resumo da manhã" })).toBeNull();
  });
});

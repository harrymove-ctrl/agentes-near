import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { ptBR } from "@agenteschat/i18n/pt-BR";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { STORAGE_KEYS, storage } from "@/lib/storage";
import { ADA_ID, createFakeApi, type FakeState, ORG_ID, seedState, withRightHand } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};
/** Acme with its right hand and nothing else made yet; `permissions`: mine, as a plain member. */
function fresh(permissions?: string[]) {
  const state = seedState();
  withRightHand(state, { ownerUserId: "u-walter" });
  state.connections = [];
  if (permissions) Object.assign(state.me?.organizations[0] ?? {}, { role: "member", permissions });
  return state;
}
const go = async (state: FakeState, path: string) => {
  const r = await renderApp(`/org/${ORG_ID}/${path}`, { api: createFakeApi(state, { seed: false }) });
  await settle(8);
  return r;
};
const empty = () => document.querySelector(".ac-empty") as HTMLElement;
const title = () => empty().querySelector(".ac-empty__title")?.textContent;
const buttons = () => within(empty()).queryAllByRole("button");

describe("first use: what the place gives, and the one next step", () => {
  test("Tarefas: the agent, one Nova tarefa, and Lodi with the ask already written", async () => {
    const { router } = await go(fresh(), "issues");
    expect(empty().querySelector(".ac-empty__agent canvas")).not.toBeNull();
    expect(title()).toBe("Dê dono e prazo ao trabalho");
    expect(screen().getAllByRole("button", { name: "Nova tarefa" })).toHaveLength(1);
    await click(within(empty()).getByRole("button", { name: "Peça ao Lodi" }));
    expect(router.state.location.pathname).toContain("/dm/agent/");
    expect(document.body.textContent).toContain("Me ajuda a criar as primeiras tarefas do time.");
  });
});

describe("who can't act gets an honest line and no button that fails", () => {
  test("Tarefas without post", async () => {
    await go(fresh(["read", "talk_to_agents"]), "issues");
    expect(title()).toBe("Veja quem faz o quê");
    expect(buttons()).toEqual([]);
    expect(screen().queryByRole("button", { name: "Nova tarefa" })).toBeNull();
  });

  test("Peça ao Lodi goes with talk_to_agents, the task stays", async () => {
    await go(fresh(["read", "post"]), "issues");
    expect(buttons().map((b) => b.textContent)).toEqual(["Nova tarefa"]);
  });

  test("Rotinas: an agent's owner may, who has no agent and no manage_routines may not", async () => {
    const owner = fresh(["read"]);
    for (const a of owner.agents) a.ownerUserId = owner.me?.user.id ?? null;
    await go(owner, "routines");
    expect(title()).toBe("Deixe o trabalho repetido com os agentes");
    cleanup();
    const other = fresh(["read"]);
    for (const a of other.agents) a.ownerUserId = "u-joao";
    await go(other, "routines");
    expect(title()).toBe("Veja o que roda sozinho");
    expect(screen().queryByRole("button", { name: "Nova rotina" })).toBeNull();
  });

  test("Drive without upload_files", async () => {
    await go(fresh(["read"]), "drive");
    expect(empty().textContent).toContain("O que agentes e pessoas fazem nas conversas fica guardado aqui.");
    expect(screen().queryByRole("button", { name: "Enviar arquivo" })).toBeNull();
  });

  test("Conectores without manage_connectors", async () => {
    await go(fresh(["read"]), "settings/connectors");
    expect(title()).toBe("Veja o que os agentes podem usar");
    expect(buttons()).toEqual([]);
  });

  test("an agent that doesn't answer me: its files say what they are, with nothing to ask", async () => {
    const state = fresh(["read", "talk_to_agents", "manage_agents"]);
    // Who manages agents sees the ones that don't answer them.
    Object.assign(state.me?.organizations[0] ?? {}, { role: "admin" });
    for (const a of state.agents) if (a.id === ADA_ID) a.audience = { mode: "owner", userIds: [], roleIds: [] };
    await go(state, `agents/${ADA_ID}?tab=files`);
    expect(title()).toBeUndefined();
    expect(empty().textContent).toContain("Tudo o que Ada entregar numa conversa fica guardado aqui.");
    expect(buttons()).toEqual([]);
  });
});

describe("no results: no agent, a line and the way out", () => {
  test("Tarefas with a filter that hides every task", async () => {
    const api = createFakeApi(fresh(), { seed: false });
    await api.issues.create(ORG_ID, { title: "Fechar o mês" });
    await renderApp(`/org/${ORG_ID}/issues`, { api });
    await settle(8);
    const search = screen().getByRole("searchbox", { name: /Buscar/ });
    await act(async () => fireEvent.change(search, { target: { value: "xyzzy" } }));
    await settle(6);
    expect(empty().querySelector(".ac-empty__agent")).toBeNull();
    await click(within(empty()).getByRole("button", { name: "Limpar filtros" }));
    expect((search as HTMLInputElement).value).toBe("");
  });
});

describe("all clear: a calm win, nothing to do", () => {
  test("Aprovações with nothing waiting", async () => {
    const state = fresh();
    state.approvals = [];
    await go(state, "approvals");
    expect(title()).toBe("Tudo decidido");
    expect(empty().querySelector(".ac-empty__agent canvas")).not.toBeNull();
    expect(buttons()).toEqual([]);
  });
});

describe("never empty before the answer, and never on an error", () => {
  const never = () => new Promise<never>(() => {});

  test("Equipe: no setor state while the setores load", async () => {
    const api = createFakeApi(fresh(), { seed: false });
    api.agentGroups.list = never;
    storage.set(STORAGE_KEYS.teamView, "sectors");
    await renderApp(`/org/${ORG_ID}/team`, { api });
    await settle(8);
    expect(document.body.textContent).not.toContain("Organize o time por área");
  });

  test("Mapa: no map state while the channels load", async () => {
    const api = createFakeApi(fresh(), { seed: false });
    api.chat.channels = never;
    storage.set(STORAGE_KEYS.teamView, "map");
    await renderApp(`/org/${ORG_ID}/team`, { api });
    await settle(8);
    expect(document.body.textContent).not.toContain("Veja onde cada agente trabalha");
  });

  test("Agenda: nothing said while the range loads, and an error stands alone", async () => {
    const api = createFakeApi(fresh(), { seed: false });
    api.calendar.range = never;
    await renderApp(`/org/${ORG_ID}/calendar`, { api });
    await settle(6);
    await click(screen().getByRole("radio", { name: "Agenda" }));
    expect(empty()).toBeNull();
    cleanup();
    const failing = createFakeApi(fresh(), { seed: false });
    failing.calendar.range = async () => {
      throw new Error("offline");
    };
    await renderApp(`/org/${ORG_ID}/calendar`, { api: failing });
    await settle(6);
    await click(screen().getByRole("radio", { name: "Agenda" }));
    expect(document.body.textContent).not.toContain("Agenda livre");
  });

  test("an agent's files that didn't load are not an agent with no files", async () => {
    const api = createFakeApi(fresh(), { seed: false });
    api.artifacts.list = async () => {
      throw new Error("offline");
    };
    api.artifacts.page = async () => {
      throw new Error("offline");
    };
    await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}?tab=files`, { api });
    await settle(8);
    expect(document.body.textContent).not.toContain("Peça um relatório");
  });
});

describe("a head button and a shortcut follow the empty state's gate", () => {
  test("Missões: one Nova missão for who may, none for who may not", async () => {
    await go(fresh(), "threads?tab=missions");
    expect(screen().getAllByRole("button", { name: "Nova missão" })).toHaveLength(1);
    cleanup();
    await go(fresh(["read"]), "threads?tab=missions");
    expect(screen().queryByRole("button", { name: "Nova missão" })).toBeNull();
  });

  test("Calendário without post: no Novo evento, and N opens nothing", async () => {
    await go(fresh(["read"]), "calendar");
    expect(screen().queryByRole("button", { name: /Novo evento/ })).toBeNull();
    await act(async () => fireEvent.keyDown(window, { key: "n" }));
    await settle(2);
    expect(screen().queryByRole("dialog")).toBeNull();
  });

  test("Tarefas without post: N opens nothing", async () => {
    await go(fresh(["read"]), "issues");
    await act(async () => fireEvent.keyDown(window, { key: "n" }));
    await settle(2);
    expect(screen().queryByRole("dialog")).toBeNull();
  });

  test("Rotinas with routines: no Nova rotina for who can't create one", async () => {
    const state = fresh(["read"]);
    for (const a of state.agents) a.ownerUserId = "u-joao";
    const api = createFakeApi(state, { seed: false });
    api.routines.list = async () => [
      {
        id: "r-1",
        name: "Resumo",
        agentId: ADA_ID,
        prompt: "Resuma a semana.",
        target: { type: "dm" },
        trigger: {
          type: "schedule",
          phrase: null,
          rule: { freq: "daily", times: ["09:00"], timezone: "America/Sao_Paulo" },
          cron: "0 9 * * *",
          timezone: "America/Sao_Paulo",
          description: "Todos os dias, às 09:00",
        },
        active: true,
        nextRunAt: new Date(Date.now() + 3_600_000).toISOString(),
        createdAt: new Date().toISOString(),
        access: "read",
        report: "when_new",
        pausedReason: null,
        failuresInRow: 0,
        state: "active",
        waitingFor: null,
        brain: { kind: "model", machineName: null },
        health: { ok: 0, silent: 0, failed: 0, skipped: 0, missed: 0, total: 0 },
        canSeeDetails: true,
        canManage: false,
        lastRun: null,
        recentRuns: [],
        usage: { runs: 0, tokens: 0, costNanoUsd: 0, billedTo: "api" },
      } as never,
    ];
    await renderApp(`/org/${ORG_ID}/routines`, { api });
    await settle(8);
    expect(document.body.textContent).toContain("Resumo");
    expect(screen().queryByRole("button", { name: "Nova rotina" })).toBeNull();
  });
});

describe("the right words for the right empty", () => {
  test("a filter that hides the agenda says so and clears", async () => {
    await go(fresh(), "calendar");
    await click(screen().getByRole("radio", { name: "Agenda" }));
    expect(title()).toBe("Agenda livre nos próximos 30 dias");
    expect(screen().getAllByRole("button", { name: /Novo evento/ })).toHaveLength(1);
    // Under 1440 the side panel starts closed, so the sources are in the Filtros popover.
    await click(screen().getByRole("button", { name: "Filtros" }));
    await click(screen().getByRole("button", { name: /^Pessoas/ }));
    await act(async () => fireEvent.keyDown(document.activeElement ?? window, { key: "Escape" }));
    await settle(2);
    expect(empty().querySelector(".ac-empty__agent")).toBeNull();
    await click(within(empty()).getByRole("button", { name: "Limpar filtros" }));
    expect(title()).toBe("Agenda livre nos próximos 30 dias");
  });

  test("Arquivadas empty beside a memory that exists: a line, not a first use", async () => {
    const state = fresh();
    state.memories = state.memories.filter((m) => !m.archived);
    const api = createFakeApi(state, { seed: false });
    await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}/memory`, { api });
    await settle(8);
    const known = await api.memory.list(ORG_ID, ADA_ID);
    expect(known.length).toBeGreaterThan(0);
    await act(async () => fireEvent.mouseDown(screen().getByRole("tab", { name: /Arquivad/ }), { button: 0 }));
    await settle(2);
    expect(empty().querySelector(".ac-empty__agent")).toBeNull();
    expect(empty().textContent).toContain("Nada aqui por enquanto.");
  });

  test("the task's own Ask line kept its words, the first ask has its own", () => {
    expect(ptBR.issues.askText).toContain("comenta o plano aqui");
    expect(ptBR.issues.askFirst).toBe("Me ajuda a criar as primeiras tarefas do time.");
  });

  test("a plain member connects a plan for their right hand", async () => {
    const api = createFakeApi(fresh(["read", "talk_to_agents"]), { seed: false });
    api.orgs.planUsage = async () => ({ month: "2026-10", money: false, accounts: [], api: [] });
    await renderApp(`/org/${ORG_ID}/settings/usage`, { api });
    await settle(8);
    expect(within(empty()).getByRole("button", { name: "Conectar uma IA" })).toBeDefined();
  });

  test("a channel I only read: no greeting, no chips for a composer that isn't there", async () => {
    const state = fresh();
    const c = state.channels[0];
    if (c) c.can = { post: false, talkToAgents: true, manage: false } as never;
    state.messages = [];
    await go(state, `c/${c?.id}`);
    expect(document.body.textContent).toContain("As mensagens aparecem aqui");
    expect(document.body.textContent).not.toContain("Diga oi");
    expect(document.querySelector(".channel__suggestions")).toBeNull();
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { MissionSettings } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const click = (el: Element) => act(async () => fireEvent.click(el));

/** A running mission in its thread (the fake keeps every change), with optional settings overrides. */
async function missionThread(patch: (s: MissionSettings) => MissionSettings = (s) => s) {
  const state = seedState();
  const api = createFakeApi(state);
  const mission = await api.missions.create(ORG_ID, {
    agentId: ADA_ID,
    goal: "App mobile",
    title: "App mobile",
    channelId: ENG_ID,
    threadId: "root-app",
  });
  await api.missions.control(ORG_ID, mission.id, "start");
  state.messages.push({
    id: "root-app",
    channelId: ENG_ID,
    threadId: null,
    author: { type: "person", id: "u-walter" },
    body: "Vamos fazer o app mobile",
    mentionedAgentIds: [],
    agentRunId: null,
    meta: {},
    createdAt: new Date().toISOString(),
  });
  await api.threads.create(ORG_ID, {
    id: "root-app",
    channelId: ENG_ID,
    firstMessageId: "root-app",
    lastMessageId: "root-app",
    title: "App mobile",
    mission: { id: mission.id, agentId: ADA_ID, status: "active", planDone: 0, planTotal: 0, waitingYou: 0 },
  } as Parameters<typeof api.threads.create>[1]);
  api.missions.threadTasks = async () => [];
  const settings = api.missions.settings;
  api.missions.settings = async (orgId, missionId) => patch(await settings(orgId, missionId));
  return { api, state, mission };
}

async function render(api: ReturnType<typeof createFakeApi>) {
  await renderApp(`/org/${ORG_ID}/threads/root-app`, { api });
  await settle(10);
}

const openMenu = async () => {
  const header = document.querySelector("header.mh") as HTMLElement;
  const trigger = within(header).getByRole("button", { name: "Mais ações da missão" });
  trigger.focus();
  await act(async () => {
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.keyUp(trigger, { key: "Enter" });
  });
  await act(() => new Promise((r) => setTimeout(r, 0)));
  return screen().getByRole("menu");
};

const openSettings = async () => {
  const menu = await openMenu();
  await click(within(menu).getByRole("menuitem", { name: /Configurações da missão/ }));
  await settle(6);
  return screen().getByRole("dialog", { name: "Configurações" });
};

const calls = (state: ReturnType<typeof seedState>, method: string) =>
  state.calls.filter((c) => c.method === method).map((c) => c.args);

describe("the mission's ⋯ menu: actions only", () => {
  test("Pausar, Parar agora, Compartilhar, Fechar missão, each with one line; then Configurações with the autonomy", async () => {
    const { api } = await missionThread();
    await render(api);
    const menu = await openMenu();
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((i) => i.querySelector(".ac-menu__label")?.firstChild?.textContent)).toEqual([
      "Pausar",
      "Parar agora",
      "Compartilhar…",
      "Fechar missão",
      "Configurações da missão…",
    ]);
    expect(items[0]?.textContent).toContain("Nada novo começa. O que está rodando termina.");
    expect(items[1]?.textContent).toContain("Interrompe as tarefas rodando e pausa a missão.");
    expect(items[2]?.textContent).toContain("Chamar alguém para ver ou decidir.");
    expect(items[3]?.textContent).toContain("Termina a missão. Nada mais roda.");
    expect(items[4]?.querySelector(".ac-menu__hint")?.textContent).toBe("Só o que é arriscado");
    // No settings inside the menu any more.
    expect(within(menu).queryAllByRole("menuitemradio")).toHaveLength(0);
    expect(menu.textContent).not.toContain("Pedir aprovação");
    expect(menu.querySelector(".ac-menu__separator")).toBeTruthy();
  });
});

describe("Configurações da missão", () => {
  test("the sections: Autonomia with pixel illustrations, the example, the stats; rules; the agent's default; Mais opções", async () => {
    const { api } = await missionThread((s) => ({ ...s, stats: { auto: 14, asked: 3, blocked: 0 } }));
    await render(api);
    const dialog = await openSettings();
    expect(dialog.textContent).toContain("Missão");
    expect(dialog.textContent).toContain("App mobile");
    const group = within(dialog).getByRole("radiogroup", { name: "Autonomia" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((r) => r.querySelector(".ac-optrow__title")?.firstChild?.textContent)).toEqual([
      "Pergunta sempre",
      "Só o que é arriscado",
      "Não pergunta",
    ]);
    expect(radios[1]?.getAttribute("aria-checked")).toBe("true");
    expect(radios[1]?.textContent).toContain("Recomendado");
    expect(radios[1]?.textContent).toContain("Faz o simples sozinho e pergunta no resto.");
    // Each row leads with the agent's pixel illustration; only the chosen one is alive.
    const pixels = [...group.querySelectorAll(".ac-autonomy")];
    expect(pixels.map((c) => c.getAttribute("data-kind"))).toEqual(["always", "low_risk_auto", "never"]);
    expect(pixels.map((c) => c.hasAttribute("data-alive"))).toEqual([false, true, false]);
    expect(dialog.textContent).toContain("apagar arquivos fora da pasta da missão pergunta");
    expect(dialog.textContent).toContain("Publicar e mexer na versão principal sempre pedem você.");
    expect(dialog.textContent).toContain("Nesta missão: 14 liberados automaticamente · 3 perguntados · 0 bloqueados");
    expect(dialog.textContent).toContain("O que já foi liberado");
    expect(dialog.textContent).toContain("Nada liberado ainda");
    expect(dialog.textContent).toContain("Próximas missões da Ada");
    // Mais opções is folded: who does the work and the switch appear when opened, locked after start.
    expect(within(dialog).queryByRole("switch")).toBeNull();
    await click(within(dialog).getByRole("button", { name: /Mais opções/ }));
    const who = within(dialog).getByRole("radiogroup", { name: "Quem faz o trabalho" });
    expect(
      within(who)
        .getAllByRole("radio")
        .map((r) => r.textContent),
    ).toEqual([
      expect.stringContaining("Claude Code"),
      expect.stringContaining("Codex"),
      expect.stringContaining("Ada"),
    ]);
    expect(within(who).getAllByRole("radio")[1]?.textContent).not.toContain("Em teste");
    expect(within(who).getAllByRole("radio")[0]?.hasAttribute("disabled")).toBe(true);
    expect(dialog.textContent).toContain("Não dá para trocar depois que a missão começa.");
    expect(dialog.textContent).toContain("MacBook");
    expect(within(dialog).getByRole("switch", { name: "Retomar sozinho quando ele voltar" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Pronto" })).toBeTruthy();
    expect(dialog.textContent).toContain("As mudanças valem na hora para esta missão");
  });

  test("changing the autonomy saves at once: a glass 'Salvo' toast with Desfazer, the footer says so", async () => {
    const { api, state } = await missionThread();
    await render(api);
    const dialog = await openSettings();
    const group = within(dialog).getByRole("radiogroup", { name: "Autonomia" });
    await click(within(group).getByRole("radio", { name: /^Pergunta sempre/ }));
    await settle(6);
    expect(calls(state, "missions.setCommandApproval").map((a) => a[2])).toEqual(["always"]);
    expect(
      within(group)
        .getByRole("radio", { name: /^Pergunta sempre/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(dialog.textContent).toContain("instalar algo ou rodar os testes espera você");
    expect(dialog.textContent).toContain("Salvo agora");
    const toast = document.querySelector(".ac-toasts .ac-toast") as HTMLElement;
    expect(toast.textContent).toContain("Salvo");
    expect(toast.textContent).toContain("Autonomia: Pergunta sempre");
    await click(within(toast).getByRole("button", { name: "Desfazer" }));
    await settle(6);
    expect(calls(state, "missions.setCommandApproval").map((a) => a[2])).toEqual(["always", "low_risk_auto"]);
  });

  test("O que já foi liberado: the rule in mono with who and when; × removes it and the empty state shows", async () => {
    const { api, state, mission } = await missionThread();
    await api.missions.retryCommand(ORG_ID, mission.id, {
      taskId: "00000000-0000-4000-8000-00000000aa01",
      command: "swift build -c release",
    });
    await render(api);
    const dialog = await openSettings();
    const list = within(dialog).getByRole("list", { name: "O que já foi liberado" });
    expect(list.querySelector("code")?.textContent).toBe("swift …");
    await click(within(list).getByRole("button", { name: "Remover swift …" }));
    await settle(6);
    expect(calls(state, "missions.removeCommandRule").map((a) => a[2])).toEqual(["rule:Bash(swift *)"]);
    expect(within(dialog).queryByRole("list", { name: "O que já foi liberado" })).toBeNull();
    expect(dialog.textContent).toContain("Nada liberado ainda");
    expect((document.querySelector(".ac-toasts") as HTMLElement).textContent).toContain(
      "“swift …” volta a ser conferido a cada vez",
    );
  });

  test("Próximas missões: 'Padrão' when equal; Usar como padrão stores it for the agent; disabled with a reason otherwise", async () => {
    const { api, state } = await missionThread();
    await render(api);
    let dialog = await openSettings();
    expect(dialog.textContent).toContain("Começar com “Só o que é arriscado”");
    expect(dialog.textContent).toContain("Já é o padrão da Ada.");
    expect(dialog.querySelector(".ac-setrow .ac-chip")?.textContent).toBe("Padrão");
    await click(within(dialog).getByRole("radio", { name: /^Não pergunta/ }));
    await settle(6);
    expect(dialog.textContent).toContain("Hoje começam com “Só o que é arriscado”. As atuais não mudam.");
    await click(within(dialog).getByRole("button", { name: "Usar como padrão" }));
    await settle(8);
    expect(calls(state, "missions.setAgentDefault")).toEqual([[ORG_ID, ADA_ID, "never"]]);
    expect(dialog.querySelector(".ac-setrow .ac-chip")?.textContent).toBe("Padrão");
    expect(within(dialog).queryByRole("button", { name: "Usar como padrão" })).toBeNull();
    expect((document.querySelector(".ac-toasts") as HTMLElement).textContent).toContain("Padrão da Ada atualizado");

    // Someone who doesn't look after the agent: the button is there, disabled, with why.
    cleanup();
    const other = await missionThread((s) => ({
      ...s,
      agentDefault: { commandApproval: "always", canSet: false, ownerId: "u-someone" },
    }));
    await render(other.api);
    dialog = await openSettings();
    const button = within(dialog).getByRole("button", { name: "Usar como padrão" });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(dialog.textContent).toContain("Só quem cuida da Ada ou um admin muda o padrão.");
  });

  test("Quem faz o trabalho: the executor's model, changeable after start; saves at once", async () => {
    const { api, state } = await missionThread();
    await render(api);
    const dialog = await openSettings();
    await click(within(dialog).getByRole("button", { name: /Mais opções/ }));
    await settle(4);
    const trigger = within(dialog).getByRole("combobox", { name: "Modelo" });
    expect(trigger.textContent).toContain("Sonnet");
    expect(trigger.hasAttribute("disabled")).toBe(false);
    expect(dialog.textContent).toContain("Dá para trocar a qualquer momento");
    trigger.focus();
    await act(async () => fireEvent.keyDown(trigger, { key: "Enter" }));
    await click(screen().getByRole("option", { name: /^Opus/ }));
    await settle(4);
    expect(calls(state, "missions.setBrain").map((a) => a[2])).toEqual([{ model: "opus" }]);
    expect(within(dialog).getByRole("combobox", { name: "Modelo" }).textContent).toContain("Opus");
    expect(document.body.textContent).toContain("Modelo: Opus");
  });

  test("an agent on Automático: the mission's model reads 'Automático', never the raw value", async () => {
    const { api } = await missionThread();
    // The mission follows the agent's own Claude Code model, which is "auto".
    const brain = api.missions.brain;
    api.missions.brain = async (orgId, missionId) => ({
      ...(await brain(orgId, missionId)),
      model: null,
      effectiveModel: "auto",
    });
    await render(api);
    const dialog = await openSettings();
    await click(within(dialog).getByRole("button", { name: /Mais opções/ }));
    await settle(4);
    const trigger = within(dialog).getByRole("combobox", { name: "Modelo" });
    expect(trigger.textContent).toContain("Automático");
    expect(trigger.textContent).not.toContain("auto");
  });

  test("an agent on one of its coding plan's models: the mission's model reads its name, never its id", async () => {
    const { api } = await missionThread();
    const brain = api.missions.brain;
    api.missions.brain = async (orgId, missionId) => ({
      ...(await brain(orgId, missionId)),
      model: null,
      effectiveModel: "deepseek-v4.1-flash",
    });
    await render(api);
    const dialog = await openSettings();
    await click(within(dialog).getByRole("button", { name: /Mais opções/ }));
    await settle(4);
    const trigger = within(dialog).getByRole("combobox", { name: "Modelo" });
    expect(trigger.textContent).toBe("DeepSeek V4.1 Flash");
  });

  test("Retomar sozinho: the switch saves resumeTasks", async () => {
    const { api, state } = await missionThread();
    await render(api);
    const dialog = await openSettings();
    await click(within(dialog).getByRole("button", { name: /Mais opções/ }));
    const toggle = within(dialog).getByRole("switch", { name: "Retomar sozinho quando ele voltar" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await click(toggle);
    await settle(6);
    expect(calls(state, "missions.setResumeTasks").map((a) => a[2])).toEqual([false]);
    expect(
      within(dialog).getByRole("switch", { name: "Retomar sozinho quando ele voltar" }).getAttribute("aria-checked"),
    ).toBe("false");
  });
});

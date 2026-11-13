import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Agent } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, GENERAL_ID, ORG_ID, seedState, withRightHand } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(3);
};
const calls = (state: ReturnType<typeof seedState>, method: string) =>
  state.calls.filter((c) => c.method === method).map((c) => c.args.slice(1));
const go = async (state: ReturnType<typeof seedState>, path: string) => {
  await renderApp(`/org/${ORG_ID}/${path}`, { api: createFakeApi(state) });
  await settle(8);
  return state;
};
const team = (state: ReturnType<typeof seedState>, shown: "chart" | "map" | "sectors" | "list") => {
  localStorage.setItem("agentes.team.view", shown);
  return go(state, "team");
};
const pick = async (label: string, option: string) => {
  const field = screen().getByRole("combobox", { name: label });
  field.focus();
  await act(async () => fireEvent.keyDown(field, { key: "Enter" }));
  await click(screen().getByRole("option", { name: option }));
};
/** A drag the browser would make: the data the handlers set, kept for the drop. */
const transfer = () => {
  const data = new Map<string, string>();
  return {
    setData: (k: string, v: string) => data.set(k, v),
    getData: (k: string) => data.get(k) ?? "",
    types: [] as string[],
    dropEffect: "none",
    effectAllowed: "all",
  };
};
const drag = async (from: Element, to: Element) => {
  const dataTransfer = transfer();
  await act(async () => {
    fireEvent.dragStart(from, { dataTransfer });
  });
  await act(async () => {
    fireEvent.dragOver(to, { dataTransfer });
  });
  await act(async () => {
    fireEvent.drop(to, { dataTransfer });
  });
  await settle(4);
};
const BIA = "00000000-0000-4000-8000-0000000000b7";
/** Ada reports to Atlas; Lodi is the workspace's right hand. */
const lined = () => {
  const state = withRightHand(seedState());
  const ada = state.agents.find((a) => a.id === ADA_ID);
  if (ada) ada.reportsToAgentId = ATLAS_ID;
  return state;
};

describe("Responde a, by clicking (ADR 0148 addendum)", () => {
  test("the agent's page sets it at once and Desfazer puts it back", async () => {
    const state = await go(withRightHand(seedState()), `agents/${ADA_ID}?tab=settings&sec=identity`);
    expect(document.body.textContent).toContain("Só diz a quem este agente presta contas. Não dá nenhuma permissão.");
    // Lodi is never a choice.
    const field = screen().getByRole("combobox", { name: "Responde a" });
    field.focus();
    await act(async () => fireEvent.keyDown(field, { key: "Enter" }));
    expect(screen().queryByRole("option", { name: "Lodi" })).toBeNull();
    await click(screen().getByRole("option", { name: "Atlas" }));
    expect(calls(state, "agents.setLines")).toEqual([[[{ agentId: ADA_ID, reportsToAgentId: ATLAS_ID }]]]);
    // No save bar: it applied.
    expect(screen().queryByRole("region", { name: "Alterações não salvas" })).toBeNull();
    expect(document.body.textContent).toContain("Ada agora responde a Atlas");
    await click(screen().getByRole("button", { name: "Desfazer" }));
    expect(calls(state, "agents.setLines").at(-1)).toEqual([[{ agentId: ADA_ID, reportsToAgentId: null }]]);
  });

  test("a supervisor's page lists who reports to it", async () => {
    await go(lined(), `agents/${ATLAS_ID}?tab=settings&sec=identity`);
    expect(document.body.textContent).toContain("Quem responde a Atlas");
    expect(document.querySelector(".team-reports")?.textContent).toContain("Ada");
  });

  test("Organograma: the line indented under its supervisor, counted, and Lodi out of it", async () => {
    await team(lined(), "chart");
    const line = document.querySelector(".team-line__reports") as HTMLElement;
    expect(line.textContent).toContain("Ada");
    expect(line.textContent).toContain("1 agente");
    const chip = document.querySelector(".team-lodi-chip") as HTMLElement;
    expect(chip.textContent).toContain("Lodi");
    expect(chip.textContent).toContain("acompanha tudo com você");
  });

  test("Organograma: dragging an agent onto another makes it report there, onto a person clears it", async () => {
    const state = await team(withRightHand(seedState()), "chart");
    const node = (id: string) => document.querySelector(`.team-tree [data-agent-row="${id}"]`) as HTMLElement;
    await drag(node(ADA_ID), node(ATLAS_ID));
    expect(calls(state, "agents.setLines")).toEqual([[[{ agentId: ADA_ID, reportsToAgentId: ATLAS_ID }]]]);
    expect(document.body.textContent).toContain("Ada agora responde a Atlas");
    await settle(6);
    const person = document.querySelector(".team-tree .team-node--person") as HTMLElement;
    await drag(node(ADA_ID), person);
    expect(calls(state, "agents.setLines").at(-1)).toEqual([[{ agentId: ADA_ID, reportsToAgentId: null }]]);
  });

  test("Mapa: a band of supervisors appears, and dropping an agent on one sets it", async () => {
    const inGeneral = (state: ReturnType<typeof seedState>) => {
      state.agents.push({
        ...(state.agents.find((a) => a.id === ADA_ID) as Agent),
        id: BIA,
        name: "Bia",
        handle: "bia",
        reportsToAgentId: null,
      });
      state.channelMembers[GENERAL_ID] = [
        ...(state.channelMembers[GENERAL_ID] ?? []),
        ...[ADA_ID, ATLAS_ID, BIA].map((id) => ({ type: "agent", id })),
      ] as never;
      return state;
    };
    const first = await team(inGeneral(withRightHand(seedState())), "map");
    expect(screen().queryByRole("region", { name: "Supervisores" })).toBeNull();
    // With no supervisor yet, a drag offers the agents it may report to: the first one is made on the Mapa too.
    const dataTransfer = transfer();
    await act(async () => {
      fireEvent.dragStart(document.querySelector(`[data-map-agent="${BIA}"]`) as HTMLElement, { dataTransfer });
    });
    const offered = screen().getByRole("region", { name: "Supervisores" });
    expect(offered.querySelector(`[data-map-sup="${BIA}"]`)).toBeNull();
    const atlas = offered.querySelector(`[data-map-sup="${ATLAS_ID}"]`) as HTMLElement;
    await act(async () => {
      fireEvent.dragOver(atlas, { dataTransfer });
    });
    await act(async () => {
      fireEvent.drop(atlas, { dataTransfer });
    });
    await settle(4);
    expect(calls(first, "agents.setLines")).toEqual([[[{ agentId: BIA, reportsToAgentId: ATLAS_ID }]]]);
    cleanup();
    const state = await team(inGeneral(lined()), "map");
    const band = screen().getByRole("region", { name: "Supervisores" });
    expect(band.textContent).toContain("Atlas");
    // Below 720 px the card says it in words.
    expect(document.querySelector(".team-map__reports-to")?.textContent).toBe("Responde a Atlas");
    const sup = band.querySelector(`[data-map-sup="${ATLAS_ID}"]`) as HTMLElement;
    await drag(document.querySelector(`[data-map-agent="${BIA}"]`) as HTMLElement, sup);
    expect(calls(state, "agents.setLines")).toEqual([[[{ agentId: BIA, reportsToAgentId: ATLAS_ID }]]]);
  });

  test("Setores: the Supervisor row sets every agent of the setor, and Aplicar brings in the one off it", async () => {
    const state = withRightHand(seedState());
    state.agentGroups = [{ id: "g-int", name: "Integrations", agentIds: [ADA_ID, ATLAS_ID] }];
    await team(state, "sectors");
    await pick("Supervisor de Integrations", "Atlas");
    expect(calls(state, "agents.setLines")).toEqual([[[{ agentId: ADA_ID, reportsToAgentId: ATLAS_ID }]]]);
    expect(document.body.textContent).toContain("1 agente de Integrations agora responde a Atlas");
    cleanup();
    const off = withRightHand(seedState());
    off.agentGroups = [{ id: "g-int", name: "Integrations", agentIds: [ADA_ID, ATLAS_ID, BIA] }];
    off.agents.push({
      ...(off.agents.find((a) => a.id === ADA_ID) as Agent),
      id: BIA,
      name: "Bia",
      handle: "bia",
      reportsToAgentId: null,
    });
    const ada = off.agents.find((a) => a.id === ADA_ID);
    if (ada) ada.reportsToAgentId = ATLAS_ID;
    await team(off, "sectors");
    expect(document.body.textContent).toContain("1 agente sem supervisor");
    await click(screen().getByRole("button", { name: "Aplicar" }));
    expect(calls(off, "agents.setLines")).toEqual([[[{ agentId: BIA, reportsToAgentId: ATLAS_ID }]]]);
  });

  test("Lista: the row's menu has Responde a, the way without a mouse", async () => {
    const state = await team(withRightHand(seedState()), "list");
    const button = screen().getByRole("button", { name: "Opções de Ada" });
    button.focus();
    await act(async () => {
      fireEvent.keyDown(button, { key: "Enter" });
      fireEvent.keyUp(button, { key: "Enter" });
    });
    await settle(2);
    const menu = screen().getByRole("menu");
    await click(within(menu).getByRole("menuitemradio", { name: "Atlas" }));
    expect(calls(state, "agents.setLines")).toEqual([[[{ agentId: ADA_ID, reportsToAgentId: ATLAS_ID }]]]);
  });
});

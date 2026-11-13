import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { AgentGroup } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, GENERAL_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(3);
};
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const INTEGRATIONS = "00000000-0000-4000-8000-0000000000e1";

/** Acme with a group, Integrations, holding Atlas (Ada in none); `role`: mine. */
function withGroups(groups: AgentGroup[] = [{ id: INTEGRATIONS, name: "Integrations", agentIds: [ATLAS_ID] }]) {
  const state = seedState();
  state.agentGroups = groups;
  return state;
}
const asMember = (state = seedState()) => {
  if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
  return state;
};
const go = async (state = seedState(), path = `c/${GENERAL_ID}`) => {
  const r = await renderApp(`/org/${ORG_ID}/${path}`, { api: createFakeApi(state) });
  await settle(8);
  return { ...r, state };
};
/** Equipe › Setores (ADR 0148): a card per group, the agents in none last. */
const view = () => screen().getByRole("region", { name: "Setores" });
const group = (title: string) => {
  const root = within(view()).getByRole("region", { name: title });
  const agents = () => [...root.querySelectorAll("[data-agent-row]")].map((el) => el.textContent);
  return { root, agents };
};
const groupTitles = () => [...view().querySelectorAll(".team-sector-card h3")].map((h) => h.textContent);
/** Opens a "…" menu (Radix: keyboard) and gives the menu. */
const openMenu = async (name: string, within$ = view()) => {
  const button = within(within$).getByRole("button", { name });
  button.focus();
  await act(async () => {
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.keyUp(button, { key: "Enter" });
  });
  await settle(2);
  return screen().getByRole("menu");
};
const calls = (state: ReturnType<typeof seedState>, method: string) =>
  state.calls.filter((c) => c.method === method).map((c) => c.args.slice(1));
/** Equipe on one of its views (remembered in this browser). */
const team = (state = seedState(), shown: "sectors" | "list" = "sectors") => {
  localStorage.setItem("agentes.team.view", shown);
  return go(state, "team");
};
const pick = async (label: string, option: string) => {
  const field = screen().getByRole("combobox", { name: label });
  field.focus();
  await act(async () => fireEvent.keyDown(field, { key: "Enter" }));
  await click(screen().getByRole("option", { name: option }));
};

describe("setores on Equipe (ADR 0083, ADR 0148)", () => {
  test("no groups: an empty state that says what setores are, and a way to create one", async () => {
    await team();
    expect(view().textContent).toContain("Organize o time por área");
    expect(within(view()).getByRole("button", { name: "Criar setor" })).toBeTruthy();
  });

  test("each setor is a card; the agents in none are under Sem setor", async () => {
    await team(
      withGroups([
        { id: INTEGRATIONS, name: "Integrations", agentIds: [ATLAS_ID] },
        { id: "00000000-0000-4000-8000-0000000000e2", name: "Lumen | Gestão e Financeiro", agentIds: [] },
      ]),
    );
    expect(groupTitles()).toEqual(["Integrations", "Lumen | Gestão e Financeiro", "Sem setor"]);
    expect(group("Sem setor").agents()).toEqual(["Ada"]);
    expect(group("Integrations").agents()).toEqual(["Atlas"]);
    // An empty setor says where its agents go, to whoever organizes them; one with no lead says so.
    expect(group("Lumen | Gestão e Financeiro").root.textContent).toContain("Arraste agentes para cá");
    expect(group("Integrations").root.textContent).toContain("Sem responsável. Escolha quem cuida deste setor.");
  });

  test("owners and admins create, edit, reorder and delete setores; deleting puts its agents back", async () => {
    const { state } = await team(withGroups());
    await click(within(view()).getByRole("button", { name: "Novo setor" }));
    const dialog = screen().getByRole("dialog", { name: "Novo setor" });
    await type(within(dialog).getByLabelText("Nome"), "  Produto ");
    await click(within(dialog).getByRole("radio", { name: /green/ }));
    await click(within(dialog).getByRole("button", { name: "Criar setor" }));
    expect(calls(state, "agentGroups.create")).toEqual([[{ name: "Produto", color: "green", icon: "person" }]]);
    expect(groupTitles()).toEqual(["Integrations", "Produto", "Sem setor"]);

    await click(within(await openMenu("Opções de Produto")).getByRole("menuitem", { name: "Mover para cima" }));
    expect(groupTitles()).toEqual(["Produto", "Integrations", "Sem setor"]);

    await click(within(await openMenu("Opções de Integrations")).getByRole("menuitem", { name: "Editar" }));
    const edit = screen().getByRole("dialog", { name: "Editar setor" });
    const name = within(edit).getByLabelText("Nome") as HTMLInputElement;
    expect(name.value).toBe("Integrations");
    await type(name, "APIs");
    await click(within(edit).getByRole("button", { name: "Salvar" }));
    expect(calls(state, "agentGroups.update").at(-1)).toEqual([
      INTEGRATIONS,
      { name: "APIs", color: "graphite", icon: "person" },
    ]);

    await click(within(await openMenu("Opções de APIs")).getByRole("menuitem", { name: "Excluir setor" }));
    const sure = screen().getByRole("dialog", { name: "Excluir o setor APIs?" });
    expect(sure.textContent).toContain("Os agentes dele voltam para Agentes.");
    await click(within(sure).getByRole("button", { name: "Excluir setor" }));
    expect(calls(state, "agentGroups.remove")).toEqual([[INTEGRATIONS]]);
    expect(groupTitles()).toEqual(["Produto", "Sem setor"]);
    expect(group("Sem setor").agents()).toEqual(["Ada", "Atlas"]);
  });

  test("the lead and the substitute are picked on the card", async () => {
    const { state } = await team(withGroups());
    await pick("Responsável por Integrations", "João");
    expect(calls(state, "agentGroups.update").at(-1)).toEqual([INTEGRATIONS, { leadUserId: "u-joao" }]);
    expect(group("Integrations").root.textContent).toContain("Sem substituto.");
    await pick("Substituto em Integrations", "Walter");
    expect(calls(state, "agentGroups.update").at(-1)).toEqual([INTEGRATIONS, { backupUserId: "u-walter" }]);
    expect(group("Integrations").root.querySelector(".team-sector-card__gap")).toBeNull();
  });

  test("an agent moves by dragging between cards, and from its row's menu in Lista", async () => {
    const { state } = await team(withGroups());
    // Dragged onto Sem setor: out of any setor.
    const atlas = within(group("Integrations").root).getByRole("link", { name: /Atlas/ });
    expect(atlas.getAttribute("draggable")).toBe("true");
    const dataTransfer = { setData: () => {}, getData: () => "" };
    await act(async () => fireEvent.dragStart(atlas, { dataTransfer }));
    const none = group("Sem setor").root;
    await act(async () => fireEvent.dragOver(none, { dataTransfer }));
    expect(none.getAttribute("data-drop")).toBe("true");
    await act(async () => fireEvent.drop(none, { dataTransfer }));
    await settle(3);
    expect(calls(state, "agentGroups.move").at(-1)).toEqual([ATLAS_ID, { groupId: null }]);
    expect(group("Sem setor").agents()).toEqual(["Ada", "Atlas"]);
    cleanup();

    const list = await team(withGroups(), "list");
    const table = screen().getByRole("table");
    const menu = await openMenu("Opções de Ada", table);
    expect(
      within(menu)
        .getAllByRole("menuitemradio")
        .map((o) => o.textContent),
      // Then Responde a (ADR 0148 addendum): nobody, or the agents it may report to.
    ).toEqual(["Sem setor", "Integrations", "Ninguém", "Atlas"]);
    await click(within(menu).getByRole("menuitemradio", { name: "Integrations" }));
    expect(calls(list.state, "agentGroups.move")).toEqual([[ADA_ID, { groupId: INTEGRATIONS }]]);
    // A new setor made from a row takes that agent.
    await click(within(await openMenu("Opções de Atlas", table)).getByRole("menuitem", { name: "Novo setor…" }));
    const dialog = screen().getByRole("dialog", { name: "Novo setor" });
    await type(within(dialog).getByLabelText("Nome"), "Ops");
    await click(within(dialog).getByRole("button", { name: "Criar setor" }));
    expect(calls(list.state, "agentGroups.create")).toEqual([
      [{ name: "Ops", agentIds: [ATLAS_ID], color: "graphite", icon: "person" }],
    ]);
  });

  test("members read the setores and have nothing to change them", async () => {
    await team(asMember(withGroups()));
    expect(groupTitles()).toEqual(["Integrations", "Sem setor"]);
    expect(group("Integrations").agents()).toEqual(["Atlas"]);
    expect(within(view()).queryByRole("button", { name: "Novo setor" })).toBeNull();
    expect(within(view()).queryByRole("button", { name: "Opções de Integrations" })).toBeNull();
    expect(within(view()).queryByRole("combobox")).toBeNull();
    expect(within(view()).getByRole("link", { name: /Atlas/ }).getAttribute("draggable")).toBeNull();
  });

  test("a change made elsewhere shows at once (the workspace's realtime)", async () => {
    const { sockets, state } = await team(withGroups());
    const socket = sockets.last();
    await act(async () => socket.open());
    await settle(3);
    // Someone else moved Ada into Integrations: the event says the groups changed, Equipe reads them again.
    state.agentGroups = [{ id: INTEGRATIONS, name: "Integrations", agentIds: [ADA_ID, ATLAS_ID] }];
    await act(async () => socket.push({ type: "event", scope: "org", event: { type: "agent.groups" } }));
    await settle(3);
    expect(group("Integrations").agents()).toEqual(["Ada", "Atlas"]);
    expect(group("Sem setor").agents()).toEqual([]);
  });
});

describe("Organograma › Por setor with no setor", () => {
  const bySector = async (state: ReturnType<typeof seedState>) => {
    state.agentGroups = [];
    localStorage.setItem("agentes.team.view", "chart");
    await go(state, "team");
    await click(screen().getByRole("radio", { name: "Por setor" }));
  };

  test("says what setores give, and its button creates the first one in place", async () => {
    const state = seedState();
    await bySector(state);
    const empty = document.querySelector(".team-chart .ac-empty--page") as HTMLElement;
    expect(empty.textContent).toContain("Organize o time por área");
    expect(empty.querySelector(".ac-sticker")).not.toBeNull();
    await click(within(empty).getByRole("button", { name: "Criar setor" }));
    const dialog = screen().getByRole("dialog", { name: "Novo setor" });
    await type(within(dialog).getByLabelText("Nome"), "Vendas");
    await click(within(dialog).getByRole("button", { name: "Criar setor" }));
    expect(calls(state, "agentGroups.create")).toEqual([[{ name: "Vendas", color: "graphite", icon: "person" }]]);
    expect(screen().queryByRole("dialog")).toBeNull();
    expect(document.querySelector(".team-chart .ac-empty")).toBeNull();
    expect(screen().getByRole("region", { name: "Vendas" })).toBeTruthy();
  });

  test("who can't manage agents gets the honest line and no button", async () => {
    const state = asMember();
    await bySector(state);
    const empty = document.querySelector(".team-chart .ac-empty--page") as HTMLElement;
    expect(empty.textContent).toContain("Quem gerencia os agentes cria os setores");
    expect(within(empty).queryByRole("button")).toBeNull();
  });
});

describe("the Group field on the agent's page", () => {
  test("owners and admins pick it in Configurações and it saves with the page", async () => {
    const { state } = await go(withGroups(), `agents/${ADA_ID}?tab=settings&sec=identity`);
    const field = screen().getByRole("combobox", { name: "Setor" });
    expect(field.textContent).toBe("Sem setor");
    field.focus();
    await act(async () => fireEvent.keyDown(field, { key: "Enter" }));
    await click(screen().getByRole("option", { name: "Integrations" }));
    const bar = screen().getByRole("region", { name: "Alterações não salvas" });
    expect(bar.textContent).toContain("Setor");
    await click(within(bar).getByRole("button", { name: /^Salvar/ }));
    await settle(4);
    expect(calls(state, "agentGroups.move")).toEqual([[ADA_ID, { groupId: INTEGRATIONS }]]);
    expect(screen().getByRole("combobox", { name: "Setor" }).textContent).toBe("Integrations");
  });

  test("with no groups there is no field; a member reads the agent's group", async () => {
    await go(seedState(), `agents/${ADA_ID}?tab=settings&sec=identity`);
    expect(screen().queryByRole("combobox", { name: "Setor" })).toBeNull();
    cleanup();
    await go(asMember(withGroups()), `agents/${ATLAS_ID}?tab=settings&sec=identity`);
    expect(screen().queryByRole("combobox", { name: "Setor" })).toBeNull();
    expect(document.querySelector(".agp-id")?.textContent).toContain("Integrations");
  });
});

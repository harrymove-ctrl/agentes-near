import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, GENERAL_ID, ORG_ID, seedDm, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/**
 * AGENTES (ADR 0083 and its 2026-11 addendum): the agents that talk to me, my pinned ones on top, the ones in no group,
 * then each group as a header that opens and closes; my order; Mudar de grupo and dragging for who manages agents, with
 * Desfazer. "Fixar no topo" in every section, five at most, my own agents on day one.
 */

afterEach(() => {
  cleanup();
  localStorage.clear();
  for (const sheet of document.querySelectorAll("style[data-layout]")) sheet.remove();
});

type State = ReturnType<typeof seedState>;
const INTEGRATIONS = "00000000-0000-4000-8000-0000000000e1";
const BOARD = "00000000-0000-4000-8000-0000000000e2";
const withGroups = (state: State = seedState()) => {
  state.agentGroups = [
    { id: INTEGRATIONS, name: "Integrations", agentIds: [ATLAS_ID] },
    { id: BOARD, name: "Diretoria", agentIds: [] },
  ];
  return state;
};
const asMember = (state: State) => {
  if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
  return state;
};
const go = async (state: State = seedState()) => {
  const r = await renderApp(`/org/${ORG_ID}/c/${GENERAL_ID}`, { api: createFakeApi(state) });
  await settle(8);
  return { ...r, state };
};
const nav = () => screen().getByRole("navigation", { name: "Navegação do workspace" });
const head = (name: string) =>
  within(nav()).getByRole("button", { name }).closest(".sidebar__section-head") as HTMLElement;
const section = (name: string) => head(name).closest(".sidebar__section") as HTMLElement;
const rowsIn = (el: HTMLElement) =>
  [...el.querySelectorAll("[data-agent-row] .sidebar__item-label")].map((l) => l.textContent);
const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};
const items = () =>
  within(screen().getByRole("menu", { name: "Ações" }))
    .getAllByRole("menuitem")
    .map((i) => i.textContent);
const rightClick = async (el: Element) => {
  await act(async () => void el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
  await settle(2);
};
const pick = (name: string) =>
  click(within(screen().getByRole("menu", { name: "Ações" })).getByRole("menuitem", { name }));
const openMenu = async (label: string) => {
  const button = within(nav()).getByRole("button", { name: label });
  await act(async () => {
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.keyUp(button, { key: "Enter" });
  });
  await settle(2);
  return screen().getByRole("menu", { name: label });
};
const views = (state: State) => state.calls.filter((c) => c.method === "orgs.setSidebarView").map((c) => c.args[1]);
const withLayout = async () => {
  const sheet = document.createElement("style");
  sheet.dataset.layout = "";
  sheet.textContent = await Bun.file(join(import.meta.dir, "../src/layout.css")).text();
  document.head.append(sheet);
};
const shown = (el: Element) => {
  for (let e: Element | null = el; e; e = e.parentElement)
    if (window.getComputedStyle(e).display === "none") return false;
  return true;
};

describe("Agentes and its groups", () => {
  test("the agents in no group first, with no header; each group a header with its count", async () => {
    await go(withGroups());
    expect(rowsIn(section("Agentes"))).toEqual(["Ada"]);
    expect(rowsIn(section("Integrations"))).toEqual(["Atlas"]);
    expect(head("Integrations").querySelector(".sidebar__section-count")?.textContent).toBe("1");
    // An empty group is for who arranges the agents: it says where they go.
    expect(section("Diretoria").textContent).toContain("Arraste agentes para cá");
    // Every agent is listed: no row under them says so again.
    expect(nav().querySelector(".sidebar__see-all")).toBeNull();
  });

  test("a member never sees an empty group, nor drags agents", async () => {
    await go(asMember(withGroups()));
    expect(within(nav()).queryByRole("button", { name: "Diretoria" })).toBeNull();
    expect(nav().querySelector("[draggable='true'][data-agent-row], [data-agent-row] [draggable='true']")).toBeNull();
    expect(within(nav()).queryByRole("button", { name: "Novo agente ou setor" })).toBeNull();
  });

  test("closed, a group still shows the agent that wrote to me, and the working count while one works", async () => {
    await withLayout();
    const state = withGroups();
    seedDm(state, { type: "agent", id: ATLAS_ID }, { ago: 1, unread: 2 });
    const r = await go(state);
    const socket = r.sockets.last();
    await act(async () => socket.open());
    await click(within(nav()).getByRole("button", { name: "Integrations" }));
    const atlas = nav().querySelector(`[data-agent-row="${ATLAS_ID}"]`) as HTMLElement;
    expect(atlas.dataset.live).toBe("true");
    expect(shown(atlas)).toBe(true);
    await act(async () =>
      socket.push({
        type: "event",
        channelId: GENERAL_ID,
        event: {
          channelId: GENERAL_ID,
          type: "agent.run",
          threadId: null,
          runId: "r-1",
          agentId: ATLAS_ID,
          status: "running",
        },
      }),
    );
    await settle(4);
    expect(head("Integrations").querySelector(".sidebar__section-working")?.textContent).toBe("1 trabalhando");
    // Working: the pixel orbit beside its name, labelled with where, in place of the pill; the row keeps its height.
    expect(atlas.querySelector(".sidebar__item-label .ac-pixspin")?.getAttribute("aria-label")).toBe(
      "trabalhando em #general",
    );
    expect(atlas.querySelector(".sidebar__busy")).toBeNull();
  });

  test("Meus primeiro, from Agentes' ⋯: the agents I'm responsible for lead each group, saved for me", async () => {
    const state = seedState();
    const atlas = state.agents.find((a) => a.id === ATLAS_ID);
    if (atlas) atlas.ownerUserId = "u-walter";
    // Day one would pin Atlas (mine): a person who already chose their pins.
    state.sidebarView = {
      agentSort: "workspace",
      showAllAgents: false,
      pins: { agents: [], channels: [], people: [] },
    };
    await go(state);
    expect(rowsIn(section("Agentes"))).toEqual(["Ada", "Atlas"]);
    const menu = await openMenu("Opções de Agentes");
    await click(within(menu).getByRole("menuitemradio", { name: "Meus primeiro" }));
    expect(rowsIn(section("Agentes"))).toEqual(["Atlas", "Ada"]);
    expect(views(state).at(-1)).toMatchObject({ agentSort: "mine" });
  });

  test("an owner shows the agents that don't talk to them from the ⋯; a member has no such choice", async () => {
    const state = seedState();
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada) ada.audience = { mode: "owner", userIds: [] };
    await go(state);
    expect(rowsIn(section("Agentes"))).toEqual(["Atlas"]);
    // The one not listed is in Equipe, and the row under the agents says how many.
    expect(within(nav()).getByRole("link", { name: "Mais 1 agente na Equipe" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/team`,
    );
    const menu = await openMenu("Opções de Agentes");
    await click(within(menu).getByRole("menuitemcheckbox", { name: "Mostrar agentes que não falam comigo" }));
    await act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
    await settle(2);
    expect(rowsIn(section("Agentes"))).toEqual(["Ada", "Atlas"]);
    expect(nav().querySelector(".sidebar__see-all")).toBeNull();
    expect(views(state).at(-1)).toMatchObject({ showAllAgents: true });
    cleanup();
    await go(asMember(seedState()));
    const theirs = await openMenu("Opções de Agentes");
    expect(within(theirs).queryByRole("menuitemcheckbox")).toBeNull();
  });
});

describe("Mudar de setor", () => {
  test("the row's right click moves the agent, and the toast's Desfazer puts it back", async () => {
    const { state } = await go(withGroups());
    await rightClick(within(nav()).getByRole("link", { name: /^Ada/ }));
    expect(items()).toEqual(expect.arrayContaining(["Sem setor", "Integrations", "Diretoria", "Novo setor com Ada"]));
    await pick("Integrations");
    expect(rowsIn(section("Integrations"))).toEqual(["Atlas", "Ada"]);
    const toast = screen()
      .getByText("Ada foi para o setor Integrations")
      .closest("[role='status'], li, div") as HTMLElement;
    await click(within(toast.parentElement as HTMLElement).getByRole("button", { name: "Desfazer" }));
    expect(rowsIn(section("Agentes"))).toEqual(["Ada"]);
    const moves = state.calls.filter((c) => c.method === "agentGroups.move").map((c) => c.args.slice(1));
    expect(moves.map(([agentId, to]) => [agentId, (to as { groupId: string | null }).groupId])).toEqual([
      [ADA_ID, INTEGRATIONS],
      [ADA_ID, null],
    ]);
  });
});

describe("Dragging into a setor", () => {
  const dataTransfer = () => {
    const data = new Map<string, string>();
    return { setData: (k: string, v: string) => data.set(k, v), getData: (k: string) => data.get(k) ?? "" };
  };
  const dragInto = async (agentId: string, zone: HTMLElement, at: { clientY?: number } = {}) => {
    const dt = dataTransfer();
    const row = nav().querySelector(`[data-agent-row="${agentId}"] a`) as HTMLElement;
    await act(async () => fireEvent.dragStart(row, { dataTransfer: dt }));
    await act(async () => fireEvent.dragOver(zone, { dataTransfer: dt, ...at }));
    await act(async () => fireEvent.drop(zone, { dataTransfer: dt, ...at }));
    await settle(6);
  };
  const pinned = (state: State, agents: string[]) => {
    state.sidebarView = { agentSort: "workspace", showAllAgents: false, pins: { agents, channels: [], people: [] } };
    return state;
  };

  test("an agent pinned on top lands in the empty setor it's dropped on and leaves the pins; Desfazer pins it back", async () => {
    const { state } = await go(pinned(withGroups(), [ADA_ID]));
    expect(rowsIn(section("Agentes"))).toEqual(["Ada"]);
    await dragInto(ADA_ID, section("Diretoria"));
    expect(screen().getByText("Ada foi para o setor Diretoria")).toBeTruthy();
    expect(rowsIn(section("Diretoria"))).toEqual(["Ada"]);
    expect(rowsIn(section("Agentes"))).toEqual([]);
    expect(views(state).at(-1)).toMatchObject({ pins: { agents: [] } });
    const toast = screen()
      .getByText("Ada foi para o setor Diretoria")
      .closest("[role='status'], li, div") as HTMLElement;
    await click(within(toast.parentElement as HTMLElement).getByRole("button", { name: "Desfazer" }));
    expect(rowsIn(section("Agentes"))).toEqual(["Ada"]);
    expect(within(nav()).getByRole("img", { name: "Fixado no topo" })).toBeTruthy();
    expect(views(state).at(-1)).toMatchObject({ pins: { agents: [ADA_ID] } });
  });

  test("dropped under a setor's last row, it lands after it, past the setor's agents pinned on top", async () => {
    const state = withGroups();
    const caio = { ...(state.agents[0] as State["agents"][number]), id: "00000000-0000-4000-8000-0000000000a3" };
    state.agents.push({ ...caio, name: "Caio", handle: "caio" });
    state.agentGroups = [{ id: INTEGRATIONS, name: "Integrations", agentIds: [ATLAS_ID, caio.id] }];
    pinned(state, [ATLAS_ID]);
    await go(state);
    expect(rowsIn(section("Integrations"))).toEqual(["Atlas", "Caio"]);
    await dragInto(ADA_ID, section("Integrations"), { clientY: 9999 });
    const moves = state.calls.filter((c) => c.method === "agentGroups.move").map((c) => c.args[2]);
    expect(moves).toEqual([{ groupId: INTEGRATIONS, index: 2 }]);
    expect(rowsIn(section("Integrations"))).toEqual(["Atlas", "Caio", "Ada"]);
  });
});

describe("a setor's ⋯ in the sidebar", () => {
  const calls = (state: State, method: string) =>
    state.calls.filter((c) => c.method === method).map((c) => c.args.slice(1));

  test("owners and admins edit and delete a setor from its header, as on Equipe", async () => {
    const { state } = await go(withGroups());
    const menu = await openMenu("Opções de Integrations");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual(["Editar", "Mover para cima", "Mover para baixo", "Excluir setor"]);
    await click(within(menu).getByRole("menuitem", { name: "Editar" }));
    const edit = screen().getByRole("dialog", { name: "Editar setor" });
    await act(async () => fireEvent.change(within(edit).getByLabelText("Nome"), { target: { value: "APIs" } }));
    await click(within(edit).getByRole("button", { name: "Salvar" }));
    expect(calls(state, "agentGroups.update")).toEqual([
      [INTEGRATIONS, { name: "APIs", color: "graphite", icon: "person" }],
    ]);
    expect(rowsIn(section("APIs"))).toEqual(["Atlas"]);

    await click(within(await openMenu("Opções de APIs")).getByRole("menuitem", { name: "Excluir setor" }));
    const sure = screen().getByRole("dialog", { name: "Excluir o setor APIs?" });
    await click(within(sure).getByRole("button", { name: "Excluir setor" }));
    expect(calls(state, "agentGroups.remove")).toEqual([[INTEGRATIONS]]);
    expect(rowsIn(section("Agentes"))).toEqual(["Ada", "Atlas"]);
  });

  test("Organizar setores na Equipe opens Equipe on its setores, whatever view it showed last", async () => {
    localStorage.setItem("agentes.team.view", "list");
    await go(withGroups());
    await click(
      within(await openMenu("Opções de Agentes")).getByRole("menuitem", { name: "Organizar setores na Equipe" }),
    );
    await settle(6);
    expect(screen().getByRole("region", { name: "Setores" })).toBeTruthy();
  });

  test("its header's right click has the same; a member has neither", async () => {
    await go(withGroups());
    await rightClick(head("Integrations"));
    expect(items()).toEqual(["Editar", "Mover para cima", "Mover para baixo", "Excluir setor"]);
    cleanup();
    await go(asMember(withGroups()));
    expect(within(nav()).queryByRole("button", { name: "Opções de Integrations" })).toBeNull();
  });
});

describe("Fixar no topo", () => {
  test("day one: my own agents on top of Agentes, with no tip about pins (the row's menu has Fixar no topo)", async () => {
    const state = seedState();
    const atlas = state.agents.find((a) => a.id === ATLAS_ID);
    if (atlas) atlas.ownerUserId = "u-walter";
    await go(state);
    expect(rowsIn(section("Agentes"))).toEqual(["Atlas", "Ada"]);
    const pinned = nav().querySelector(`[data-agent-row="${ATLAS_ID}"]`) as HTMLElement;
    expect(within(pinned).getByRole("img", { name: "Fixado no topo" })).toBeTruthy();
    expect(section("Agentes").querySelector(".sidebar__pins-end")).not.toBeNull();
    expect(section("Agentes").querySelector('[role="note"]')).toBeNull();
    expect(section("Agentes").textContent).not.toContain("Seus agentes ficam no topo.");
  });

  test("day one leaves my agents in their groups: an agent writing in its DM keeps its group", async () => {
    const state = withGroups();
    const atlas = state.agents.find((a) => a.id === ATLAS_ID);
    if (atlas) atlas.ownerUserId = "u-walter";
    state.agentGroups?.[1]?.agentIds.push(ADA_ID);
    seedDm(state, { type: "agent", id: ATLAS_ID }, { ago: 1 });
    seedDm(state, { type: "agent", id: ADA_ID }, { ago: 2 });
    await go(state);
    expect(rowsIn(section("Integrations"))).toEqual(["Atlas"]);
    expect(rowsIn(section("Diretoria"))).toEqual(["Ada"]);
    expect(within(nav()).queryByRole("img", { name: "Fixado no topo" })).toBeNull();
  });

  test("an agent pinned before it went into a setor shows in that setor, on top, whoever put it there", async () => {
    const state = withGroups();
    state.sidebarView = {
      agentSort: "workspace",
      showAllAgents: false,
      pins: { agents: [ADA_ID], channels: [], people: [] },
    };
    const r = await go(state);
    const socket = r.sockets.last();
    await act(async () => socket.open());
    await settle(3);
    expect(rowsIn(section("Agentes"))).toEqual(["Ada"]);
    // Someone else puts Ada in Integrations (another admin, her page, the right hand): my pin is still there.
    state.agentGroups = [
      { id: INTEGRATIONS, name: "Integrations", agentIds: [ATLAS_ID, ADA_ID] },
      { id: BOARD, name: "Diretoria", agentIds: [] },
    ];
    await act(async () => socket.push({ type: "event", scope: "org", event: { type: "agent.groups" } }));
    await settle(4);
    expect(rowsIn(section("Integrations"))).toEqual(["Ada", "Atlas"]);
    expect(head("Integrations").querySelector(".sidebar__section-count")?.textContent).toBe("2");
    const ada = nav().querySelector(`[data-agent-row="${ADA_ID}"]`) as HTMLElement;
    expect(within(ada).getByRole("img", { name: "Fixado no topo" })).toBeTruthy();
    expect(rowsIn(section("Agentes"))).toEqual([]);
  });

  test("Fixar no topo puts the agent first, so the row moves where the person looks", async () => {
    const state = seedState();
    state.sidebarView = {
      agentSort: "workspace",
      showAllAgents: false,
      pins: { agents: [ATLAS_ID], channels: [], people: [] },
    };
    await go(state);
    expect(rowsIn(section("Agentes"))).toEqual(["Atlas", "Ada"]);
    await rightClick(within(nav()).getByRole("link", { name: /^Ada/ }));
    await pick("Fixar no topo");
    expect(rowsIn(section("Agentes"))).toEqual(["Ada", "Atlas"]);
    expect(views(state).at(-1)).toMatchObject({ pins: { agents: [ADA_ID, ATLAS_ID] } });
  });

  test("a pin of an agent no longer here holds no place: no one could take it off the top", async () => {
    const state = seedState();
    const gone = ["b1", "b2", "b3", "b4"].map((n) => `00000000-0000-4000-8000-0000000000${n}`);
    state.sidebarView = {
      agentSort: "workspace",
      showAllAgents: false,
      pins: { agents: [...gone, ATLAS_ID], channels: [], people: [] },
    };
    await go(state);
    await rightClick(within(nav()).getByRole("link", { name: /^Ada/ }));
    await pick("Fixar no topo");
    expect(screen().queryByText("Você já fixou 5 agentes. Tire um do topo para fixar este.")).toBeNull();
    expect(rowsIn(section("Agentes"))).toEqual(["Ada", "Atlas"]);
    expect(views(state).at(-1)).toMatchObject({ pins: { agents: [ADA_ID, ATLAS_ID] } });
  });

  test("a channel pinned from its right click goes on top of Canais; Tirar do topo puts it back", async () => {
    const { state } = await go();
    const eng = () => nav().querySelector(`a.sidebar__item[title="#eng"]`) as HTMLElement;
    await rightClick(eng());
    await pick("Fixar no topo");
    const canais = section("Canais");
    expect(canais.querySelector("a.sidebar__item")?.getAttribute("title")).toBe("#eng");
    expect(canais.querySelector(".sidebar__pins-end")).not.toBeNull();
    expect(views(state).at(-1)).toMatchObject({ pins: { channels: [ENG_ID] } });
    await rightClick(eng());
    await pick("Tirar do topo");
    expect(canais.querySelector(".sidebar__pins-end")).toBeNull();
  });

  test("a person pinned stays on top of Mensagens diretas even before a conversation", async () => {
    const state = seedState();
    state.sidebarView = {
      agentSort: "workspace",
      showAllAgents: false,
      pins: { agents: [], channels: [], people: ["u-joao"] },
    };
    await go(state);
    expect(
      [...section("Mensagens diretas").querySelectorAll("a .sidebar__item-label")].map((l) => l.textContent),
    ).toEqual(["João"]);
  });

  test("five per section: the sixth says so and pins nothing", async () => {
    const state = seedState();
    const five = [1, 2, 3, 4, 5].map((n) => `00000000-0000-4000-8000-0000000000d${n}`);
    for (const [i, id] of five.entries())
      state.channels.push({
        id,
        name: `sala-${i + 1}`,
        topic: "",
        visibility: "public",
        isMember: true,
        createdAt: state.channels[0]?.createdAt ?? "",
      });
    state.sidebarView = {
      agentSort: "workspace",
      showAllAgents: false,
      pins: { agents: [], channels: five, people: [] },
    };
    await go(state);
    await rightClick(nav().querySelector(`a.sidebar__item[title="#eng"]`) as HTMLElement);
    await pick("Fixar no topo");
    expect(screen().getByText("Você já fixou 5 canais. Tire um do topo para fixar este.")).toBeTruthy();
    expect(views(state)).toEqual([]);
  });
});

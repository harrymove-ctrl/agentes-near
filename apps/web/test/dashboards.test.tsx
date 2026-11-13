import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Routine } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import {
  ADA_ID,
  ADMIN_ROLE_ID,
  ATLAS_ID,
  createFakeApi,
  type FakeState,
  fakeDashboardsOf,
  NOW,
  ORG_ID,
  seedState,
  withRightHand,
} from "./fake-api";
import type { FakeDashboards } from "./fakes/dashboards";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const key = async (el: Element, k: string) => {
  await act(async () => {
    fireEvent.keyDown(el, { key: k });
    fireEvent.keyUp(el, { key: k });
  });
  await settle(1);
};
const nav = () => document.getElementById("app-nav") as HTMLElement;

/** The fake backend with boards the test adds before the app reads them. */
function setup(prepare?: (fake: FakeDashboards) => void, state: FakeState = seedState()) {
  const api = createFakeApi(state);
  const fake = fakeDashboardsOf.get(api) as FakeDashboards;
  prepare?.(fake);
  return { api, fake, state };
}
const open = async (path: string, prepare?: (fake: FakeDashboards) => void, state?: FakeState) => {
  const s = setup(prepare, state);
  const view = await renderApp(path, { api: s.api });
  await settle(8);
  return { ...s, router: view.router };
};
const section = (name: string) => screen().getByRole("region", { name });

describe("Dashboards: in the sidebar's More, and the list (ADR 0135 §14)", () => {
  test("More opens the Dashboards page, which then shows under More, on a board's page too", async () => {
    const { router } = await open(`/org/${ORG_ID}/home`, (fake) => {
      fake.addBoard({ id: "dash-m", title: "Metas", audience: "workspace" });
    });
    const tools = [...nav().querySelectorAll(".sidebar__tools > a.sidebar__item .sidebar__item-label")].map(
      (l) => l.textContent,
    );
    expect(tools).not.toContain("Painéis");
    const active = () =>
      [...nav().querySelectorAll('.sidebar__more-active > [data-status="active"] .sidebar__item-label')].map(
        (l) => l.textContent,
      );
    expect(active()).toEqual([]);
    await click(within(nav()).getByRole("button", { name: "Mais" }));
    await settle(3);
    const more = screen().getByRole("dialog", { name: "Mais" });
    const row = within(more).getByRole("link", { name: /Painéis/ });
    expect(row.getAttribute("href")).toBe(`/org/${ORG_ID}/dashboards`);
    expect(row.textContent).toContain("Números e gráficos que os agentes mantêm em dia");
    await click(row);
    await settle(6);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/dashboards`);
    expect(screen().getByRole("heading", { name: "Painéis", level: 1 })).toBeTruthy();
    expect(active()).toEqual(["Painéis"]);
    await act(() =>
      router.navigate({ to: "/org/$orgId/dashboards/$dashboardId", params: { orgId: ORG_ID, dashboardId: "dash-m" } }),
    );
    await settle(6);
    expect(screen().getByRole("heading", { name: "Metas", level: 1 })).toBeTruthy();
    expect(active()).toEqual(["Painéis"]);
  });

  test("My Home first, then the workspace's, the roles' and only mine, each card with who made it", async () => {
    await open(`/org/${ORG_ID}/dashboards`, (fake) => {
      fake.addBoard({
        title: "Acme hoje",
        audience: "workspace",
        owner: { kind: "person", id: "u-walter", name: "Walter" },
      });
      fake.addBoard({
        title: "Comercial",
        audience: "roles",
        roleIds: [ADMIN_ROLE_ID],
        ownerUserId: "u-joao",
        owner: { kind: "agent", id: ADA_ID, name: "Ada" },
        canManage: false,
      });
      const mine = fake.addBoard({ title: "Minhas metas", audience: "private" });
      fake.addWidget(mine.id, { agentId: ATLAS_ID, title: "Meta", layout: { position: 0, w: 2, h: 1 } });
    });
    const home = within(section("Meu Início")).getByRole("link", { name: /Meu Início/ });
    expect(home.getAttribute("href")).toBe(`/org/${ORG_ID}/home`);
    const workspace = section("Do workspace");
    expect(workspace.textContent).toContain("todo mundo vê");
    expect(within(workspace).getByRole("link", { name: "Acme hoje" }).textContent).toContain("Criado por você");
    const roles = section("Dos seus papéis");
    const comercial = within(roles).getByRole("link", { name: "Comercial" });
    expect(comercial.textContent).toContain("Criado por Ada");
    expect(comercial.getAttribute("href")).toMatch(new RegExp(`^/org/${ORG_ID}/dashboards/`));
    const mine = within(section("Só seus")).getByRole("link", { name: "Minhas metas" });
    expect(mine.textContent).toContain("1 widget");
    // The thumbnail: one tile per widget, as wide as the widget.
    const tiles = mine.querySelectorAll(".db-thumb__tile");
    expect(tiles).toHaveLength(1);
    expect((tiles[0] as HTMLElement).style.gridColumn).toBe("span 2");
    expect(document.querySelector(".db-group__only")).toBeNull();
  });

  test("a thumbnail's tiles stay inside the picture: an empty board's dashed tile fills it, a third row fits", async () => {
    const css = (await Bun.file(new URL("../src/pages/dashboards.css", import.meta.url).pathname).text()).replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    // 96px tall with 12px of padding: two 26px rows and a gap leave 16px, too little for a third whole one.
    expect(css).toMatch(/\.db-thumb \{[^}]*grid-auto-rows: minmax\(0, 26px\);/);
    expect(css).toMatch(/\.db-thumb:has\(> \.db-thumb__tile--empty\) \{\s*grid-auto-rows: 1fr;/);
  });

  test("only My Home: under it the right hand says what a dashboard is, with Novo painel and an ask to it", async () => {
    await open(
      `/org/${ORG_ID}/dashboards`,
      (fake) => {
        fake.addBoard({ kind: "home" });
      },
      withRightHand(seedState()),
    );
    const home = section("Meu Início");
    expect(within(home).getByRole("link", { name: /Meu Início/ })).toBeTruthy();
    const empty = document.querySelector(".ac-empty") as HTMLElement;
    expect(empty.querySelector(".ac-empty__agent")).not.toBeNull();
    expect(empty.querySelector(".ac-empty__title")?.textContent).toBe("Monte o primeiro painel do time");
    expect(empty.querySelector(".ac-empty__text")?.textContent).toBe(
      "Um painel junta números e gráficos numa página, e os agentes mantêm tudo em dia.",
    );
    // One way in: the empty state's Novo painel, the header's steps aside.
    expect(screen().getAllByRole("button", { name: "Novo painel" })).toHaveLength(1);
    expect(document.querySelector(".ac-pagehead__actions")).toBeNull();
    expect(within(empty).getByRole("button", { name: "Peça ao Lodi" })).toBeTruthy();
    await act(async () => fireEvent.click(within(empty).getByRole("button", { name: "Novo painel" })));
    expect(screen().getByRole("dialog", { name: "Novo painel" })).toBeTruthy();
  });
});

describe("a board's page", () => {
  test("its title, who sees it, who made it, how many widgets; empty: Add widget", async () => {
    const { router } = await open(`/org/${ORG_ID}/dashboards/dash-m`, (fake) => {
      fake.addBoard({
        id: "dash-m",
        title: "Metas",
        about: "O que importa neste trimestre.",
        audience: "workspace",
        owner: { kind: "person", id: "u-walter", name: "Walter" },
      });
    });
    expect(screen().getByRole("heading", { name: "Metas", level: 1 })).toBeTruthy();
    expect(screen().getByText("O que importa neste trimestre.")).toBeTruthy();
    const meta = document.querySelector(".db-meta") as HTMLElement;
    expect(meta.textContent).toContain("Todo o workspace");
    expect(meta.textContent).toContain("Criado por você");
    // Portuguese counts 0 as one ("0 widget").
    expect(meta.textContent).toMatch(/0 widgets?/);
    expect(screen().getByText("Acompanhe seus números")).toBeTruthy();
    expect(screen().getAllByRole("button", { name: "Adicionar widget" })).toHaveLength(2);
    // Organize needs widgets to move.
    expect(screen().queryByRole("button", { name: "Organizar" })).toBeNull();
    const crumb = document.querySelector(".db-crumb") as HTMLAnchorElement;
    expect(crumb.textContent).toBe("Painéis");
    await click(crumb);
    await settle(6);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/dashboards`);
  });

  test("a board that isn't there, or that I don't see, says so", async () => {
    await open(`/org/${ORG_ID}/dashboards/00000000-0000-4000-8000-0000000000ff`);
    expect(screen().getByText("Este painel não existe, ou você não o vê.")).toBeTruthy();
  });

  test("an agent's request: Publish shows it to the workspace; only the person asked decides", async () => {
    const { state } = await open(`/org/${ORG_ID}/dashboards/dash-bf`, (fake) => {
      fake.addBoard({
        id: "dash-bf",
        title: "Black Friday",
        owner: { kind: "agent", id: ADA_ID, name: "Ada" },
        proposal: {
          audience: "workspace",
          roleIds: [],
          agentId: ADA_ID,
          why: "",
          at: NOW.toISOString(),
          canDecide: true,
        },
      });
    });
    const banner = screen().getByRole("region", { name: "Ada montou este painel para você" });
    expect(banner.textContent).toContain("E sugere publicar para todo o workspace. Hoje só você vê.");
    expect((document.querySelector(".db-meta") as HTMLElement).textContent).toContain("Só você");
    await click(within(banner).getByRole("button", { name: "Publicar para o workspace" }));
    await settle(6);
    const call = state.calls.find((c) => c.method === "dashboards.decideProposal");
    expect(call?.args).toEqual([ORG_ID, "dash-bf", "publish"]);
    expect(screen().getByText("“Black Friday” foi publicado")).toBeTruthy();
    expect(screen().queryByRole("region", { name: "Ada montou este painel para você" })).toBeNull();
    expect((document.querySelector(".db-meta") as HTMLElement).textContent).toContain("Todo o workspace");
  });

  test("someone else sees the request without the buttons", async () => {
    await open(`/org/${ORG_ID}/dashboards/dash-bf`, (fake) => {
      fake.addBoard({
        id: "dash-bf",
        title: "Black Friday",
        audience: "workspace",
        ownerUserId: "u-joao",
        owner: { kind: "agent", id: ADA_ID, name: "Ada" },
        canManage: false,
        proposal: {
          audience: "roles",
          roleIds: [ADMIN_ROLE_ID],
          agentId: ADA_ID,
          why: "",
          at: NOW.toISOString(),
          canDecide: false,
        },
      });
    });
    const banner = screen().getByRole("region", { name: "Ada montou este painel para você" });
    expect(banner.textContent).toContain("E sugere mostrar para Admin. Hoje só você vê.");
    expect(within(banner).queryByRole("button")).toBeNull();
    // Not its owner nor an admin: no Share.
    expect(screen().queryByRole("button", { name: "Compartilhar" })).toBeNull();
  });

  test("the board's menu: rename, pin to the top and delete", async () => {
    const s = await open(`/org/${ORG_ID}/dashboards/dash-m`, (fake) => {
      fake.addBoard({ id: "dash-m", title: "Metas", owner: { kind: "person", id: "u-walter", name: "Walter" } });
    });
    const more = () =>
      screen()
        .getAllByRole("button", { name: "Mais" })
        .find((b) => b.closest(".ac-pagehead__actions")) as Element;
    const pick = async (item: string) => {
      const trigger = more();
      (trigger as HTMLElement).focus();
      await key(trigger, "Enter");
      await click(within(screen().getByRole("menu")).getByRole("menuitem", { name: item }));
      await settle(4);
    };
    await pick("Renomear");
    const rename = screen().getByRole("dialog", { name: "Renomear" });
    await act(async () => fireEvent.change(within(rename).getByLabelText("Nome"), { target: { value: "Metas 2027" } }));
    await click(within(rename).getByRole("button", { name: "Salvar" }));
    await settle(4);
    expect(s.state.calls.find((c) => c.method === "dashboards.update")?.args).toEqual([
      ORG_ID,
      "dash-m",
      { title: "Metas 2027", about: "" },
    ]);
    expect(screen().getByRole("heading", { name: "Metas 2027", level: 1 })).toBeTruthy();

    await pick("Fixar no topo");
    expect(s.state.calls.filter((c) => c.method === "dashboards.update").at(-1)?.args[2]).toEqual({ pinned: true });

    await pick("Apagar painel");
    const confirm = screen().getByRole("dialog", { name: "Apagar “Metas 2027”?" });
    await click(within(confirm).getByRole("button", { name: "Apagar" }));
    await settle(6);
    expect(s.state.calls.find((c) => c.method === "dashboards.remove")?.args).toEqual([ORG_ID, "dash-m"]);
    expect(s.router.state.location.pathname).toBe(`/org/${ORG_ID}/dashboards`);
    expect(screen().getByText("“Metas 2027” apagado")).toBeTruthy();
  });
});

describe("a board in a workspace being deleted (ADR 0088 §7)", () => {
  test("offers no change: no Compartilhar, Organizar or Widget, only Usar no Início, and its widgets only open", async () => {
    const shown = async (deleting: boolean) => {
      const state = seedState();
      if (deleting && state.me) {
        const deletion = {
          dueAt: new Date(Date.now() + 6 * 86_400_000).toISOString(),
          requestedAt: null,
          requestedBy: null,
        };
        state.me.organizations = state.me.organizations.map((o) => (o.id === ORG_ID ? { ...o, deletion } : o));
      }
      await open(
        `/org/${ORG_ID}/dashboards/dash-m`,
        (fake) => {
          fake.addBoard({ id: "dash-m", title: "Metas", owner: { kind: "person", id: "u-walter", name: "Walter" } });
          fake.addWidget("dash-m", { agentId: ATLAS_ID, title: "Receita hoje", layout: { position: 0, w: 1, h: 1 } });
        },
        state,
      );
      const page = {
        share: screen().queryByRole("button", { name: "Compartilhar" }) !== null,
        organize: screen().queryByRole("group", { name: "Metas" }) !== null,
        refresh: screen().queryAllByRole("button", { name: "Atualizar agora" }).length > 0,
      };
      // The open menu hides the page from these queries: it is read last.
      const trigger = screen()
        .getAllByRole("button", { name: "Mais" })
        .find((b) => b.closest(".ac-pagehead__actions")) as HTMLElement;
      trigger.focus();
      await key(trigger, "Enter");
      const menu = within(screen().getByRole("menu"))
        .getAllByRole("menuitem")
        .map((i) => i.textContent);
      cleanup();
      return { ...page, menu };
    };
    expect(await shown(false)).toEqual({
      share: true,
      organize: true,
      refresh: true,
      menu: ["Usar no Início", "Renomear", "Fixar no topo", "Apagar painel"],
    });
    expect(await shown(true)).toEqual({ share: false, organize: false, refresh: false, menu: ["Usar no Início"] });
  });
});

describe("a board on Início (ADR 0135 §18)", () => {
  const metas = (fake: FakeDashboards) => {
    fake.addBoard({ id: "dash-m", title: "Metas", owner: { kind: "person", id: "u-walter", name: "Walter" } });
    fake.addWidget("dash-m", { agentId: ATLAS_ID, title: "Receita hoje", layout: { position: 0, w: 1, h: 1 } });
  };

  test("Use on Home in the board's menu, for whoever sees it", async () => {
    const s = await open(`/org/${ORG_ID}/dashboards/dash-m`, metas);
    const trigger = screen()
      .getAllByRole("button", { name: "Mais" })
      .find((b) => b.closest(".ac-pagehead__actions")) as HTMLElement;
    trigger.focus();
    await key(trigger, "Enter");
    await click(within(screen().getByRole("menu")).getByRole("menuitem", { name: "Usar no Início" }));
    await settle(4);
    expect(s.state.calls.find((c) => c.method === "dashboards.setHome")?.args).toEqual([ORG_ID, "dash-m"]);
    expect(screen().getByText("O Início agora mostra este painel")).toBeTruthy();
    trigger.focus();
    await key(trigger, "Enter");
    expect(within(screen().getByRole("menu")).getByRole("menuitem", { name: "Tirar do Início" })).toBeTruthy();
  });

  test("Início shows the board with See all; Dashboards marks it and My Home is a page", async () => {
    await open(`/org/${ORG_ID}/home`, (fake) => {
      metas(fake);
      fake.homeDashboardId = "dash-m";
    });
    const mural = section("Metas");
    expect(mural.textContent).toContain("Receita hoje");
    // One grid: the fixed tiles among the board's widgets, so either moves anywhere in it.
    const grids = mural.querySelectorAll(".wgrid");
    expect(grids).toHaveLength(1);
    expect(grids[0]?.textContent).toContain("Esperando você");
    expect(grids[0]?.textContent).toContain("Receita hoje");
    expect(within(mural).getByRole("link", { name: "Ver todos" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/dashboards`,
    );
    cleanup();
    await open(`/org/${ORG_ID}/dashboards`, (fake) => {
      metas(fake);
      fake.homeDashboardId = "dash-m";
    });
    const home = within(section("Meu Início")).getByRole("link", { name: /Meu Início/ });
    expect(home.getAttribute("href")).toBe(`/org/${ORG_ID}/dashboards/home`);
    expect(within(section("Só seus")).getByRole("link", { name: "Metas" }).textContent).toContain("No Início");
  });
});

/** A routine as the server sends it (ADR 0053 §11). */
const routine = (over: Partial<Routine> & Pick<Routine, "id" | "name">): Routine => ({
  agentId: ADA_ID,
  prompt: "Quantos PRs esperam revisão.",
  target: { type: "widget", widgetId: "w-1", dashboardId: "dash-1" },
  trigger: {
    type: "schedule",
    phrase: null,
    rule: null,
    cron: "0 * * * *",
    timezone: "America/Sao_Paulo",
    description: "A cada hora",
  },
  active: true,
  nextRunAt: new Date(Date.now() + 3_600_000).toISOString(),
  createdAt: new Date(Date.now() - 86_400_000).toISOString(),
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

describe("Routines: a widget's routine", () => {
  test("reads as its widget, tagged; Open widget instead of Edit; no copy; its fields stay as they are", async () => {
    const s = setup();
    const list = [
      routine({
        id: "rt-w",
        name: "PRs esperando revisão",
        widget: { id: "w-1", dashboardId: "dash-1", title: "PRs esperando revisão" },
      }),
    ];
    const api = { ...s.api, routines: { ...s.api.routines, list: async () => structuredClone(list) } };
    const view = await renderApp(`/org/${ORG_ID}/routines`, { api });
    await settle(8);
    const card = screen().getByRole("article", { name: "PRs esperando revisão" });
    expect(card.textContent).toContain("Ada · atualiza o widget, sem mensagem");
    expect(card.textContent).toContain("Widget de painel");
    expect(card.textContent).not.toContain("Drive");
    const trigger = within(card).getByRole("button", { name: "Mais ações: PRs esperando revisão" });
    trigger.focus();
    await key(trigger, "Enter");
    const menu = screen().getByRole("menu");
    expect(within(menu).queryByRole("menuitem", { name: "Editar" })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: "Duplicar" })).toBeNull();
    await click(within(menu).getByRole("menuitem", { name: "Abrir widget" }));
    await settle(6);
    expect(view.router.state.location.pathname).toBe(`/org/${ORG_ID}/dashboards/dash-1`);
    expect(view.router.state.location.search).toEqual({ widget: "w-1" });
  });

  test("its page: the widget named as where it goes, what it does read-only, no report choice", async () => {
    const s = setup();
    const list = [
      routine({
        id: "rt-w",
        name: "PRs esperando revisão",
        widget: { id: "w-1", dashboardId: "dash-1", title: "PRs esperando revisão" },
      }),
    ];
    const api = { ...s.api, routines: { ...s.api.routines, list: async () => structuredClone(list) } };
    await renderApp(`/org/${ORG_ID}/routines`, { api });
    await settle(8);
    await click(
      within(screen().getByRole("article", { name: "PRs esperando revisão" })).getByRole("button", {
        name: "PRs esperando revisão",
      }),
    );
    await settle(6);
    const page = screen().getByRole("dialog", { name: "PRs esperando revisão" });
    expect(page.textContent).toContain("O widget “PRs esperando revisão”");
    expect(page.textContent).toContain("Atualiza o widget dela, sem mensagem");
    expect(page.textContent).toContain("O que mostra, quando atualiza e quem cuida mudam pelo widget.");
    expect(within(page).getByRole("link", { name: "Abrir widget" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/dashboards/dash-1?widget=w-1`,
    );
    // Only pausing, resuming and running stay here: no agent, schedule, target or report to pick.
    expect(within(page).queryByRole("combobox")).toBeNull();
    expect(page.textContent).not.toContain("Quando posta");
  });
});

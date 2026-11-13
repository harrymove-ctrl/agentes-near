import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Dashboard, DashboardLayoutInput, Widget, WidgetSpec } from "@agenteschat/client";
import { box, place } from "@agenteschat/ui/testing";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, type FakeState, fakeDashboardsOf, ORG_ID, seedState } from "./fake-api";
import type { FakeDashboards } from "./fakes/dashboards";
import { notification } from "./fakes/notifications";
import { pick } from "./new-agent-flow";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const click = (el: Element) => act(async () => fireEvent.click(el));
const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const soon = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

const SALES: WidgetSpec = {
  kind: "kpi",
  value: 18420,
  prefix: "R$",
  delta: { text: "+12%", up: true },
  note: "vs. ontem até agora",
};
const ORDERS: WidgetSpec = { kind: "bars", labels: ["Novos", "Enviados", "Atrasados"], values: [14, 31, 2] };
const BUILDS: WidgetSpec = { kind: "line", labels: ["1", "2", "3"], values: [6.1, 4.9, 3.9] };

/** My Home with its two tiles and three widgets of Ada's: sales (S), orders (S), builds (M, failed). */
function setup(state: FakeState = seedState()) {
  const api = createFakeApi(state);
  const fake = fakeDashboardsOf.get(api) as FakeDashboards;
  const home = fake.addBoard({
    kind: "home",
    tiles: [
      { key: "waiting", position: 0, w: 2, h: 1 },
      { key: "working", position: 3, w: 2, h: 1 },
    ],
  });
  const sales = fake.addWidget(home.id, {
    agentId: ADA_ID,
    title: "Vendas hoje",
    spec: SALES,
    schedule: "hour",
    refreshedAt: ago(12),
    nextRunAt: soon(40),
    sources: ["Loja", "Planilha de metas"],
    alert: { enabled: true, condition: "cair 20% abaixo de ontem" },
    layout: { position: 1, w: 1, h: 1 },
  });
  const orders = fake.addWidget(home.id, {
    agentId: ADA_ID,
    title: "Pedidos por status",
    spec: ORDERS,
    schedule: "day",
    refreshedAt: ago(90),
    layout: { position: 2, w: 1, h: 1 },
  });
  const builds = fake.addWidget(home.id, {
    agentId: ADA_ID,
    title: "Tempo de build",
    spec: BUILDS,
    schedule: "week",
    layout: { position: 4, w: 2, h: 1 },
  });
  Object.assign(builds, { status: "failed", failure: { code: "no_update", detail: null } });
  return { api, fake, state, home, sales, orders, builds };
}

const open = async (path: string, s = setup()) => {
  const view = await renderApp(path, { api: s.api });
  await settle(8);
  return { ...s, router: view.router };
};

const mural = () => screen().getByRole("region", { name: "Meu Início" });
const order = () => [...mural().querySelectorAll(".wb-cell")].map((c) => c.getAttribute("data-item"));
const widget = (title: string) => within(mural()).getByRole("article", { name: title });
const cellOf = (id: string) => mural().querySelector(`.wb-cell[data-item="${id}"]`) as HTMLElement;
const calls = (state: FakeState, method: string) => state.calls.filter((c) => c.method === method);
const last = (state: FakeState, method: string) => calls(state, method).at(-1)?.args;
const live = () => mural().querySelector("p.ac-visually-hidden[aria-live]")?.textContent ?? "";
/** The click a drop swallows (only on the board) waits a moment for its click; tests send none. */
const pause = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));
const gripIn = (title: string) => within(widget(title)).getByRole("button", { name: "Arraste para mover" });

/** happy-dom lays nothing out: the cells in the board's order, 4 a row, 200×160 with 10px between them. */
function layGrid() {
  order().forEach((id, k) => {
    place(cellOf(id ?? ""), box((k % 4) * 210, 300 + Math.floor(k / 4) * 170, 200, 160));
  });
}
const at = (x: number, y: number) => ({ clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: "mouse" });
/** A mouse press on a cell, a move past the slop (it lifts), then on to the point. */
async function dragTo(cell: HTMLElement, x: number, y: number) {
  await act(async () => {
    fireEvent.pointerDown(cell, at(100, 550));
    fireEvent.pointerMove(document, at(110, 560));
    fireEvent.pointerMove(document, at(x, y));
  });
  await settle(2);
}
const press = async (key: string, el: Element = document.activeElement ?? document.body) => {
  await act(async () => fireEvent.keyDown(el, { key }));
  await settle(3);
};
/** Each widget's saved place and size, by id. */
const savedWidgets = (state: FakeState) =>
  (last(state, "dashboards.saveLayout") as [string, string, { widgets: { id: string; position: number }[] }])[2]
    .widgets;

describe("My Home as a mural (ADR 0135)", () => {
  test("Waiting on you and Working now are fixed tiles among my widgets, in the board's order", async () => {
    const { sales, orders, builds } = await open(`/org/${ORG_ID}/home`);
    expect(order()).toEqual(["waiting", sales.id, orders.id, "working", builds.id]);
    // The tiles keep their own sections' names and bodies.
    expect(within(mural()).getByRole("region", { name: "Esperando você" })).toBeTruthy();
    expect(within(mural()).getByRole("region", { name: "Trabalhando agora" })).toBeTruthy();
    // A widget: its title, its number in the app's bold tabular style, who looks after it, when and how often.
    const card = widget("Vendas hoje");
    expect(card.querySelector(".wk-num")?.textContent).toBe("R$18.420");
    expect(card.querySelector(".wg__foot")?.textContent).toContain("Ada");
    expect(card.querySelector(".wg__foot")?.textContent).toContain("a cada hora");
    // Her face leads the title; the footer only says who and when.
    expect(card.querySelector(".wg__head > .wg__face .ac-avatar")).toBeTruthy();
    expect(card.querySelector(".wg__foot .ac-avatar")).toBeNull();
    expect(card.getAttribute("data-w")).toBe("1");
    // The bars, and the failed one with its reason and Resolve.
    expect(widget("Pedidos por status").querySelectorAll(".wk-bar")).toHaveLength(3);
    const failed = widget("Tempo de build");
    expect(failed.getAttribute("data-state")).toBe("failed");
    expect(failed.textContent).toContain("A última atualização terminou sem dados.");
    // A widget is added from the header's pill (Organize and + Widget, one control): the board has no add tile.
    const pill = within(mural()).getByRole("group", { name: "Meu Início" });
    expect(within(pill).getByRole("button", { name: "Organizar" }).getAttribute("aria-pressed")).toBe("false");
    expect(within(pill).getByRole("button", { name: "Adicionar widget" }).textContent).toBe("Widget");
    expect(within(mural()).getAllByRole("button", { name: "Adicionar widget" })).toHaveLength(1);
    expect(mural().querySelector(".wgrid")?.querySelector("button[aria-label='Adicionar widget']")).toBeNull();
  });

  test("Resolve runs a failed widget again; Update now runs any", async () => {
    const { state, builds, sales } = await open(`/org/${ORG_ID}/home`);
    await click(within(widget("Tempo de build")).getByRole("button", { name: "Resolver" }));
    await settle(3);
    expect(last(state, "dashboards.refreshWidget")).toEqual([ORG_ID, builds.id]);
    expect(widget("Tempo de build").getAttribute("data-state")).toBe("updating");
    await click(within(widget("Vendas hoje")).getByRole("button", { name: "Atualizar agora" }));
    await settle(3);
    expect(last(state, "dashboards.refreshWidget")).toEqual([ORG_ID, sales.id]);
    expect(widget("Vendas hoje").getAttribute("data-state")).toBe("updating");
    // The last data stays under the sweep while it updates.
    expect(widget("Vendas hoje").querySelector(".wk-num")?.textContent).toBe("R$18.420");
  });

  test("Organize: size, grip arrows and drag, each saved at once; Remove takes it off", async () => {
    const { state, home, sales, orders, builds } = await open(`/org/${ORG_ID}/home`);
    await click(within(mural()).getByRole("button", { name: "Organizar" }));
    // The fixed tiles say so; widgets show their size, remove and grip instead of their actions.
    expect(within(mural()).getAllByText("Fixo")).toHaveLength(2);
    expect(within(widget("Vendas hoje")).queryByRole("button", { name: "Atualizar agora" })).toBeNull();

    // S → M.
    await click(within(widget("Vendas hoje")).getByRole("button", { name: "Tamanho: P" }));
    await settle(3);
    const sized = last(state, "dashboards.saveLayout") as [string, string, DashboardLayoutInput];
    expect(sized[1]).toBe(home.id);
    expect(sized[2].widgets.find((w) => w.id === sales.id)).toEqual({ id: sales.id, position: 1, w: 2, h: 1 });
    expect(within(widget("Vendas hoje")).getByRole("button", { name: "Tamanho: M" })).toBeTruthy();

    // The grip's left arrow: before "Waiting on you".
    const grip = within(widget("Vendas hoje")).getByRole("button", { name: "Arraste para mover" });
    await act(async () => fireEvent.keyDown(grip, { key: "ArrowLeft" }));
    await settle(3);
    expect(order()).toEqual([sales.id, "waiting", orders.id, "working", builds.id]);
    const moved = last(state, "dashboards.saveLayout") as [string, string, { tiles?: unknown[] }];
    expect(moved[2].tiles).toEqual([
      { key: "waiting", position: 1, w: 2, h: 1 },
      { key: "working", position: 3, w: 2, h: 1 },
    ]);

    // Dragged with the pointer onto another: a copy lifts, a well with its span (M: 2 wide) marks where it lands,
    // and on the drop it takes that place, saved once.
    layGrid();
    const before = calls(state, "dashboards.saveLayout").length;
    await dragTo(cellOf(builds.id), 520, 380);
    expect(document.querySelector(".wb-ghost")).toBeTruthy();
    expect(cellOf(builds.id).hidden).toBe(true);
    const spot = mural().querySelector("[data-spot]") as HTMLElement;
    expect(spot.getAttribute("data-w")).toBe("2");
    expect([...mural().querySelectorAll(".wgrid > *")].map((c) => c.getAttribute("data-item") ?? "spot")).toEqual([
      sales.id,
      "waiting",
      "spot",
      orders.id,
      "working",
      builds.id,
    ]);
    expect(calls(state, "dashboards.saveLayout")).toHaveLength(before);
    await act(async () => fireEvent.pointerUp(document, at(520, 380)));
    await settle(6);
    expect(document.querySelector(".wb-ghost")).toBeNull();
    expect(mural().querySelector("[data-spot]")).toBeNull();
    expect(order()).toEqual([sales.id, "waiting", builds.id, orders.id, "working"]);
    expect(calls(state, "dashboards.saveLayout")).toHaveLength(before + 1);
    expect(savedWidgets(state).find((w) => w.id === builds.id)?.position).toBe(2);
    await pause(80);

    // Remove asks first (its agent's routine stops, its history goes), then it leaves, and its routine with it.
    await click(within(widget("Pedidos por status")).getByRole("button", { name: "Tirar do Início" }));
    await settle(3);
    const confirm = screen().getByRole("dialog", { name: "Tirar “Pedidos por status”?" });
    expect(confirm.textContent).toContain("A rotina de Ada que o atualiza para");
    expect(calls(state, "dashboards.removeWidget")).toHaveLength(0);
    await click(within(confirm).getByRole("button", { name: "Tirar" }));
    await settle(4);
    expect(last(state, "dashboards.removeWidget")).toEqual([ORG_ID, orders.id]);
    expect(screen().queryByRole("dialog", { name: "Tirar “Pedidos por status”?" })).toBeNull();
    expect(within(mural()).queryByRole("article", { name: "Pedidos por status" })).toBeNull();
    expect(document.body.textContent).toContain("“Pedidos por status” saiu do Início e a rotina de Ada parou");

    await click(within(mural()).getByRole("button", { name: "Pronto" }));
    expect(within(mural()).getByRole("button", { name: "Organizar" })).toBeTruthy();
  });

  test("Remove from a card's menu asks first; Cancel keeps the widget", async () => {
    const { state } = await open(`/org/${ORG_ID}/home`);
    await act(async () =>
      fireEvent.pointerDown(within(widget("Tempo de build")).getByRole("button", { name: "Mais" }), {
        button: 0,
        ctrlKey: false,
      }),
    );
    await settle(2);
    const menu = screen().getByRole("menu", { name: "Mais" });
    await click(within(menu).getByRole("menuitem", { name: "Tirar do Início" }));
    await settle(3);
    const confirm = screen().getByRole("dialog", { name: "Tirar “Tempo de build”?" });
    expect(confirm.textContent).toContain("A rotina de Ada que o atualiza para");
    await click(within(confirm).getByRole("button", { name: "Cancelar" }));
    await settle(3);
    expect(screen().queryByRole("dialog", { name: "Tirar “Tempo de build”?" })).toBeNull();
    expect(calls(state, "dashboards.removeWidget")).toHaveLength(0);
    expect(widget("Tempo de build")).toBeTruthy();
  });

  test("Organize with the keys: Space picks a widget up, the arrows carry it, Enter drops it and saves", async () => {
    const { state, sales, orders, builds } = await open(`/org/${ORG_ID}/home`);
    await click(within(mural()).getByRole("button", { name: "Organizar" }));
    const grip = gripIn("Pedidos por status");
    grip.focus();
    await press(" ", grip);
    expect(cellOf(orders.id).classList.contains("is-picked")).toBe(true);
    expect(live()).toBe("Você pegou “Pedidos por status”. As setas movem, Espaço solta, Esc cancela.");
    const before = calls(state, "dashboards.saveLayout").length;
    await press("ArrowLeft");
    // Carried, not saved yet: before the sales widget, second of five.
    expect(order()).toEqual(["waiting", orders.id, sales.id, "working", builds.id]);
    expect(live()).toBe("“Pedidos por status”: posição 2 de 5.");
    expect(document.activeElement).toBe(gripIn("Pedidos por status"));
    expect(calls(state, "dashboards.saveLayout")).toHaveLength(before);
    await press("Enter");
    expect(live()).toBe("Você soltou “Pedidos por status” na posição 2 de 5.");
    expect(cellOf(orders.id).classList.contains("is-picked")).toBe(false);
    expect(calls(state, "dashboards.saveLayout")).toHaveLength(before + 1);
    expect(savedWidgets(state).find((w) => w.id === orders.id)?.position).toBe(1);
    expect(order()).toEqual(["waiting", orders.id, sales.id, "working", builds.id]);

    // Esc puts it back and saves nothing.
    const sold = gripIn("Vendas hoje");
    sold.focus();
    await press("Enter", sold);
    await press("ArrowRight");
    expect(order()).toEqual(["waiting", orders.id, "working", sales.id, builds.id]);
    await press("Escape");
    expect(live()).toBe("“Vendas hoje” voltou para o lugar.");
    expect(order()).toEqual(["waiting", orders.id, sales.id, "working", builds.id]);
    expect(document.activeElement).toBe(gripIn("Vendas hoje"));
    expect(calls(state, "dashboards.saveLayout")).toHaveLength(before + 1);
  });

  test("Organize: Esc while dragging sends the widget back and saves nothing", async () => {
    const { state, sales, orders, builds } = await open(`/org/${ORG_ID}/home`);
    await click(within(mural()).getByRole("button", { name: "Organizar" }));
    layGrid();
    await dragTo(cellOf(builds.id), 110, 380);
    expect(mural().querySelector("[data-spot]")).toBeTruthy();
    await press("Escape", document.body);
    await settle(4);
    expect(document.querySelector(".wb-ghost")).toBeNull();
    expect(mural().querySelector("[data-spot]")).toBeNull();
    expect(order()).toEqual(["waiting", sales.id, orders.id, "working", builds.id]);
    // The release after Esc drops nothing.
    await act(async () => fireEvent.pointerUp(document, at(110, 380)));
    await settle(4);
    expect(calls(state, "dashboards.saveLayout")).toHaveLength(0);
    // Outside Organize nothing lifts.
    await click(within(mural()).getByRole("button", { name: "Pronto" }));
    await dragTo(cellOf(builds.id), 110, 380);
    expect(document.querySelector(".wb-ghost")).toBeNull();
    await act(async () => fireEvent.pointerUp(document, at(110, 380)));
  });
});

describe("a widget's side panel", () => {
  test("big, how it updates, its history; the schedule changes there, a change goes to its agent", async () => {
    const s = setup();
    s.fake.history.set(s.sales.id, [
      {
        id: "u2",
        at: ago(12),
        status: "ok",
        summary: "R$ 18.420 · +12%",
        alert: "pico de pedidos no app",
        failureCode: null,
        change: null,
        costUsd: 0.01,
      },
      {
        id: "u1",
        at: ago(72),
        status: "failed",
        summary: "",
        alert: null,
        failureCode: "no_update",
        change: null,
        costUsd: null,
      },
      {
        id: "u0",
        at: ago(132),
        status: "failed",
        summary: "A fonte **não** respondeu",
        alert: null,
        failureCode: "agent_reported",
        change: null,
        costUsd: null,
      },
    ]);
    const { state, router, sales } = await open(`/org/${ORG_ID}/home`, s);
    await click(within(widget("Vendas hoje")).getByRole("button", { name: "Vendas hoje" }));
    await settle(4);
    expect((router.state.location.search as { widget?: string }).widget).toBe(sales.id);
    const panel = screen().getByRole("dialog", { name: "Vendas hoje" });
    expect(panel.textContent).toContain("Ada cuida deste widget");
    expect(panel.textContent).toContain("A fonte não respondeu");
    expect(within(panel).getByRole("article", { name: "Vendas hoje" }).querySelector(".wk-num")?.textContent).toBe(
      "R$18.420",
    );
    const how = within(panel).getByRole("region", { name: "Como atualiza" });
    expect(how.textContent).toContain("A cada hora");
    expect(how.textContent).toContain("Rotina de Ada · próxima");
    expect(how.textContent).toContain("Avisar se cair 20% abaixo de ontem");
    expect(how.textContent).toContain("Loja · Planilha de metas");
    const history = within(within(panel).getByRole("region", { name: "Últimas atualizações" })).getAllByRole(
      "listitem",
    );
    expect(history[0]?.textContent).toContain("R$ 18.420 · +12%");
    expect(history[0]?.textContent).toContain("avisou: pico de pedidos no app");
    expect(history[1]?.textContent).toContain("A última atualização terminou sem dados.");

    await pick(within(how).getByRole("combobox", { name: "Mudar quando atualiza" }), "Todo dia · 8h");
    expect(last(state, "dashboards.updateWidget")).toEqual([ORG_ID, sales.id, { schedule: "day" }]);

    const ask = within(panel).getByRole("textbox", { name: "Pedir mudança" });
    await act(async () => fireEvent.change(ask, { target: { value: "Separa por canal" } }));
    await act(async () => fireEvent.keyDown(ask, { key: "Enter" }));
    await settle(3);
    expect(last(state, "dashboards.askWidgetChange")).toEqual([ORG_ID, sales.id, "Separa por canal"]);
    expect(document.body.textContent).toContain("Ada está refazendo o widget.");

    // Closed: the address forgets it.
    await click(within(panel).getByRole("button", { name: "Fechar" }));
    await settle(2);
    expect((router.state.location.search as { widget?: string }).widget).toBeUndefined();
  });

  test("its title is renamed in place: Enter saves, Esc cancels and keeps the panel open", async () => {
    const s = setup();
    const { state } = await open(`/org/${ORG_ID}/home?widget=${s.sales.id}`, s);
    const panel = screen().getByRole("dialog", { name: "Vendas hoje" });
    await click(within(panel).getByRole("button", { name: "Renomear" }));
    const field = within(panel).getByRole("textbox", { name: "Título do widget" }) as HTMLInputElement;
    expect(field.value).toBe("Vendas hoje");
    await act(async () => fireEvent.change(field, { target: { value: "Vendas do dia" } }));
    await act(async () => fireEvent.keyDown(field, { key: "Enter" }));
    await settle(4);
    expect(last(state, "dashboards.updateWidget")).toEqual([ORG_ID, s.sales.id, { title: "Vendas do dia" }]);
    expect(within(panel).queryByRole("textbox", { name: "Título do widget" })).toBeNull();
    expect(screen().getByRole("dialog", { name: "Vendas do dia" })).toBeTruthy();

    // A press on the title opens the field too; Esc leaves it as it was.
    await click(panel.querySelector(".wd__title") as HTMLElement);
    const again = within(panel).getByRole("textbox", { name: "Título do widget" });
    await act(async () => fireEvent.change(again, { target: { value: "Outra coisa" } }));
    await act(async () => fireEvent.keyDown(again, { key: "Escape" }));
    await settle(4);
    expect(calls(state, "dashboards.updateWidget")).toHaveLength(1);
    expect(screen().getByRole("dialog", { name: "Vendas do dia" })).toBeTruthy();
  });

  test("a widget its agent hasn't named yet shows its format's name, never the ask", async () => {
    const s = setup();
    s.fake.addWidget(s.home.id, {
      agentId: ADA_ID,
      title: "ultimas visitas no site",
      prompt: "ultimas visitas no site",
      format: "line",
      layout: { position: 5, w: 2, h: 1 },
    });
    await open(`/org/${ORG_ID}/home`, s);
    expect(within(mural()).queryByRole("article", { name: "ultimas visitas no site" })).toBeNull();
    expect(within(mural()).getByRole("article", { name: "Linha" }).getAttribute("data-state")).toBe("building");
  });

  test("opened by its address; Remove takes it off My Home and closes", async () => {
    const s = setup();
    const { state } = await open(`/org/${ORG_ID}/home?widget=${s.orders.id}`, s);
    const panel = screen().getByRole("dialog", { name: "Pedidos por status" });
    await click(within(panel).getByRole("button", { name: "Tirar do Início" }));
    await settle(3);
    expect(calls(state, "dashboards.removeWidget")).toHaveLength(0);
    const confirm = screen().getByRole("dialog", { name: "Tirar “Pedidos por status”?" });
    await click(within(confirm).getByRole("button", { name: "Tirar" }));
    await settle(4);
    expect(last(state, "dashboards.removeWidget")).toEqual([ORG_ID, s.orders.id]);
    expect(screen().queryByRole("dialog", { name: "Tirar “Pedidos por status”?" })).toBeNull();
    expect(screen().queryByRole("dialog", { name: "Pedidos por status" })).toBeNull();
  });
});

describe("a board's notices in Waiting on you", () => {
  /** Ada built "Black Friday" for me and asks to publish it; the sales widget alerted; the build one stopped. */
  function noticed() {
    const s = setup();
    const board: Dashboard = s.fake.addBoard({
      title: "Black Friday",
      ownerUserId: "u-walter",
      proposal: {
        audience: "workspace",
        roleIds: [],
        agentId: ADA_ID,
        why: "O time comercial acompanha isso",
        at: ago(20),
        canDecide: true,
      },
    });
    s.state.notifications = [
      notification({
        id: "n-proposal",
        kind: "dashboard_proposal",
        waiting: true,
        actors: [{ type: "agent", id: ADA_ID }],
        source: { dashboardId: board.id, agentId: ADA_ID, label: "Black Friday" },
        latest: { statusTo: "workspace", text: "O time comercial acompanha isso" },
        updatedAt: ago(20),
      }),
      notification({
        id: "n-alert",
        kind: "widget_alert",
        waiting: true,
        actors: [{ type: "agent", id: ADA_ID }],
        source: { dashboardId: s.home.id, widgetId: s.sales.id, agentId: ADA_ID, label: "Vendas hoje" },
        latest: { text: "As vendas caíram 24% abaixo de ontem." },
        updatedAt: ago(5),
      }),
      notification({
        id: "n-failed",
        kind: "widget_failed",
        actors: [{ type: "agent", id: ADA_ID }],
        source: { dashboardId: s.home.id, widgetId: s.builds.id, agentId: ADA_ID, label: "Tempo de build" },
        latest: { reason: "no_update" },
        updatedAt: ago(30),
      }),
    ];
    return { ...s, board };
  }

  test("each with what can be done right there: Publish or Keep only for me, Open widget, Resolve", async () => {
    const s = noticed();
    const { state, router } = await open(`/org/${ORG_ID}/home`, s);
    const waiting = within(mural()).getByRole("region", { name: "Esperando você" });
    const rows = within(waiting).getAllByRole("listitem");
    const text = rows.map((r) => r.textContent ?? "");
    const proposal = rows[text.findIndex((x) => x.includes("Ada quer publicar um painel"))] as HTMLElement;
    expect(proposal.textContent).toContain("“Black Friday” para todo o workspace · hoje só você vê");
    const alert = rows[text.findIndex((x) => x.includes("Ada avisou sobre “Vendas hoje”"))] as HTMLElement;
    expect(alert.textContent).toContain("As vendas caíram 24% abaixo de ontem.");
    const failed = rows[
      text.findIndex((x) => x.includes("Ada não conseguiu atualizar “Tempo de build”"))
    ] as HTMLElement;
    expect(failed.textContent).toContain("A última atualização terminou sem dados.");

    await click(within(proposal).getByRole("button", { name: "Manter só para mim" }));
    await settle(3);
    expect(last(state, "dashboards.decideProposal")).toEqual([ORG_ID, s.board.id, "keep"]);
    expect(document.body.textContent).toContain("Só você vê “Black Friday”");

    await click(within(failed).getByRole("button", { name: "Resolver" }));
    await settle(3);
    expect(last(state, "dashboards.refreshWidget")).toEqual([ORG_ID, s.builds.id]);

    // One action at the row's end, as on every other row: Resolve on a failure; on an alert the row itself opens
    // the widget ("Open widget" at its end), on Home (it is on my home board).
    expect(within(failed).getAllByRole("button")).toHaveLength(2);
    expect(within(alert).getAllByRole("button")).toHaveLength(1);
    expect(alert.querySelector(".home-row__act")?.textContent).toBe("Abrir widget");
    await click(within(alert).getByRole("button"));
    await settle(4);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/home`);
    expect((router.state.location.search as { widget?: string }).widget).toBe(s.sales.id);
    expect(screen().getByRole("dialog", { name: "Vendas hoje" })).toBeTruthy();
    expect(state.calls).toContainEqual({ method: "notifications.read", args: [ORG_ID, "n-alert", true] });
  });

  test("in the inbox too: a dashboard's chip, and the request decided in its row", async () => {
    const s = noticed();
    const { state } = await open(`/org/${ORG_ID}/notifications`, s);
    const row = document.querySelector('[data-n="n-proposal"]') as HTMLElement;
    expect(row.textContent).toContain("Ada quer publicar um painel");
    expect(row.textContent).toContain("Painel");
    await click(within(row).getByRole("button", { name: "Publicar para o workspace" }));
    await settle(3);
    expect(last(state, "dashboards.decideProposal")).toEqual([ORG_ID, s.board.id, "publish"]);
    const failed = document.querySelector('[data-n="n-failed"]') as HTMLElement;
    expect(failed.textContent).toContain("A última atualização terminou sem dados.");
    expect(within(failed).getByRole("button", { name: "Resolver" })).toBeTruthy();
  });
});

describe("Pin from the chat", () => {
  const CHART = JSON.stringify({
    type: "bar",
    title: "Pedidos por canal",
    labels: ["Site", "App", "WhatsApp"],
    series: [{ name: "Pedidos", values: [41, 26, 9] }],
  });

  test("an agent's chart goes to My Home as a widget, with its data, kept updated when asked", async () => {
    const state = seedState();
    state.messages.push({
      id: "m-chart",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: ADA_ID },
      body: `Aqui os pedidos:\n\n\`\`\`chart\n${CHART}\n\`\`\``,
      mentionedAgentIds: [],
      agentRunId: null,
      createdAt: ago(3),
    });
    const s = setup(state);
    s.fake.pinnable = [
      {
        messageId: "m-chart",
        channelId: ENG_ID,
        threadId: null,
        agentId: ADA_ID,
        at: ago(3),
        block: CHART,
        title: "Pedidos por canal",
        spec: { kind: "bars", labels: ["Site", "App", "WhatsApp"], values: [41, 26, 9] },
        place: { kind: "channel", name: "eng" },
      },
    ];
    await open(`/org/${ORG_ID}/c/${ENG_ID}`, s);
    const chart = document.querySelector(".chart-card") as HTMLElement;
    await click(within(chart).getByRole("button", { name: "Fixar num painel" }));
    await settle(4);
    const dialog = screen().getByRole("dialog", { name: "Fixar num painel" });
    // The chart as it will look: bars with its numbers, Ada's.
    expect([...dialog.querySelectorAll(".wk-bar__v")].map((v) => v.textContent)).toEqual(["41", "26", "9"]);
    await click(within(dialog).getByRole("switch", { name: "Manter atualizado" }));
    expect(dialog.textContent).toContain("Ada refaz todo dia às 8h");
    await click(within(dialog).getByRole("button", { name: "Fixar" }));
    await settle(4);
    const pinned = last(state, "dashboards.pinWidget");
    expect(pinned).toEqual([ORG_ID, s.home.id, { messageId: "m-chart", block: CHART, schedule: "day", size: "m" }]);
    expect(document.body.textContent).toContain("Fixado em Meu Início · Ada refaz todo dia às 8h");
    const added = s.fake.boards.find((b) => b.id === s.home.id)?.widgets.find((w: Widget) => w.sourceMessageId);
    expect(added?.title).toBe("Pedidos por canal");
  });
});

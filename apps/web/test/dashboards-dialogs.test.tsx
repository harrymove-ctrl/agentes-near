import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type { OrgRole } from "@agenteschat/client";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import {
  ADA_ID,
  ADMIN_ROLE_ID,
  createFakeApi,
  ENG_ID,
  type FakeState,
  fakeDashboardsOf,
  NOW,
  ORG_ID,
  seedRoles,
  seedState,
} from "./fake-api";
import type { FakeDashboards } from "./fakes/dashboards";
import { pick } from "./new-agent-flow";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));

const open = async (
  path: string,
  prepare?: (fake: FakeDashboards) => void,
  prepareState?: (state: FakeState) => void,
) => {
  const state = seedState();
  prepareState?.(state);
  const api = createFakeApi(state);
  const fake = fakeDashboardsOf.get(api) as FakeDashboards;
  prepare?.(fake);
  const view = await renderApp(path, { api });
  await settle(8);
  return { state, fake, api, router: view.router, services: view.services };
};
const callOf = (state: { calls: { method: string; args: unknown[] }[] }, method: string) =>
  state.calls.find((c) => c.method === method);
const callsOf = (state: { calls: { method: string; args: unknown[] }[] }, method: string) =>
  state.calls.filter((c) => c.method === method);
/** One choice of a radio group (a segmented control, the blocks to pin) by the group's name. */
const segment = (dialog: HTMLElement, group: string, name: string | RegExp) =>
  within(within(dialog).getByRole("radiogroup", { name: group })).getByRole("radio", { name });
const myBoard = (fake: FakeDashboards) =>
  fake.addBoard({ id: "dash-m", title: "Metas", owner: { kind: "person", id: "u-walter", name: "Walter" } });
const SALES_ROLE_ID = "role-sales";
/** A second role, "Vendas", and Lia, who holds it. */
const withSales = (state: FakeState) => {
  const [admin, everyone] = seedRoles() as [OrgRole, OrgRole];
  const sales: OrgRole = { ...admin, id: SALES_ROLE_ID, name: "Vendas", color: "amber", position: 1, permissions: [] };
  state.roles = [admin, { ...sales, hoist: false }, { ...everyone, position: 2 }];
  state.members.push({
    userId: "u-lia",
    name: "Lia",
    email: "lia@acme.com.br",
    image: null,
    role: "member",
    roleIds: [SALES_ROLE_ID],
    joinedAt: NOW.toISOString(),
    handle: "lia",
    timezone: "America/Sao_Paulo",
  });
};
/** "Who edits": its dropdown, opened from the keys. */
const openEditors = async (dialog: HTMLElement) => {
  const trigger = within(dialog).getByRole("button", { name: /^Quem edita/ });
  trigger.focus();
  await act(async () => fireEvent.keyDown(trigger, { key: "Enter" }));
  return screen().getByRole("menu");
};
const closeMenu = () => act(async () => fireEvent.keyDown(screen().getByRole("menu"), { key: "Escape" }));
const editorsShown = (dialog: HTMLElement) =>
  within(dialog)
    .getByRole("button", { name: /^Quem edita/ })
    .querySelector(".ac-select__value")?.textContent;

describe("New dashboard (ADR 0135 §8, §10)", () => {
  const start = async (prepareState?: (state: FakeState) => void) => {
    const opened = await open(`/org/${ORG_ID}/dashboards`, undefined, prepareState);
    await click(screen().getAllByRole("button", { name: "Novo painel" })[0] as Element);
    await settle(4);
    return { ...opened, dialog: screen().getByRole("dialog", { name: "Novo painel" }) };
  };

  test("a name, only for me by default: Create dashboard makes it empty and opens it", async () => {
    const { state, router, dialog } = await start();
    const create = within(dialog).getByRole("button", { name: "Criar painel" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    expect(
      within(dialog)
        .getByRole("radio", { name: /^Só você/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    // No "How to start": an agent builds a dashboard when asked in a chat, as the line under the name says.
    expect(dialog.textContent).not.toContain("Como começar");
    expect(dialog.textContent).not.toContain("Pedir a um agente");
    expect(dialog.textContent).toContain("Você também pode pedir a um agente, numa conversa, que monte um.");
    expect(editorsShown(dialog)).toBe("Só você e a administração");
    // What whoever sees it sees, said where the audience is chosen (ADR 0135 §12).
    expect(dialog.textContent).toContain("Quem vê o painel vê o que os agentes trouxeram");
    await type(within(dialog).getByLabelText("Nome"), "Metas do trimestre");
    await click(create);
    await settle(6);
    expect(callOf(state, "dashboards.create")?.args[1]).toEqual({
      title: "Metas do trimestre",
      audience: "private",
      roleIds: [],
      editPolicy: "owner",
      editRoleIds: [],
    });
    expect(router.state.location.pathname).toMatch(new RegExp(`^/org/${ORG_ID}/dashboards/.+`));
    expect(screen().getByRole("heading", { name: "Metas do trimestre", level: 1 })).toBeTruthy();
    expect(screen().getByText("“Metas do trimestre” criado")).toBeTruthy();
  });

  test("for roles: each role with its people; who edits offers only the roles that see it", async () => {
    const { state, dialog } = await start(withSales);
    await type(within(dialog).getByLabelText("Nome"), "Diretoria");
    await click(within(dialog).getByRole("radio", { name: /^Papéis/ }));
    await settle(2);
    const chips = within(dialog).getByRole("group", { name: "Papéis" });
    const admin = within(chips).getByRole("button", { name: /^Admin/ });
    expect(admin.getAttribute("aria-pressed")).toBe("false");
    const create = within(dialog).getByRole("button", { name: "Criar painel" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    await click(admin);
    expect(create.disabled).toBe(false);

    // Whoever sees it, only you and admins, then the roles: Vendas doesn't see the board, so it can't edit it.
    let menu = await openEditors(dialog);
    const items = within(menu).getAllByRole("menuitemcheckbox");
    expect(items.map((i) => i.textContent)).toEqual([
      "Quem vê",
      "Só você e a administração",
      "Admin",
      "VendasNão vê este painel",
    ]);
    expect(items[1]?.getAttribute("aria-checked")).toBe("true");
    expect(items[3]?.getAttribute("aria-disabled")).toBe("true");
    await click(within(menu).getByRole("menuitemcheckbox", { name: /^Admin/ }));
    await closeMenu();
    expect(editorsShown(dialog)).toBe("Admin");

    // Admin leaves who sees: it leaves who edits too, back to you and admins.
    await click(admin);
    expect(editorsShown(dialog)).toBe("Só você e a administração");
    await click(admin);
    menu = await openEditors(dialog);
    await click(within(menu).getByRole("menuitemcheckbox", { name: /^Admin/ }));
    await closeMenu();
    await click(create);
    await settle(6);
    expect(callOf(state, "dashboards.create")?.args[1]).toEqual({
      title: "Diretoria",
      audience: "roles",
      roleIds: [ADMIN_ROLE_ID],
      editPolicy: "roles",
      editRoleIds: [ADMIN_ROLE_ID],
    });
  });

  test("whoever sees it closes the menu and edits", async () => {
    const { state, dialog } = await start();
    await type(within(dialog).getByLabelText("Nome"), "Comercial");
    await click(within(dialog).getByRole("radio", { name: /^Todo o workspace/ }));
    const menu = await openEditors(dialog);
    await click(within(menu).getByRole("menuitemcheckbox", { name: "Quem vê" }));
    await settle(2);
    expect(screen().queryByRole("menu")).toBeNull();
    expect(editorsShown(dialog)).toBe("Quem vê");
    await click(within(dialog).getByRole("button", { name: "Criar painel" }));
    await settle(6);
    expect(callOf(state, "dashboards.create")?.args[1]).toMatchObject({ editPolicy: "viewers", editRoleIds: [] });
  });
});

describe("Share (ADR 0135 §8, §12)", () => {
  const share = async () => {
    const opened = await open(`/org/${ORG_ID}/dashboards/dash-m`, myBoard, withSales);
    await click(screen().getByRole("button", { name: "Compartilhar" }));
    await settle(4);
    const dialog = screen().getByRole("dialog", { name: "Compartilhar “Metas”" });
    const people = () => within(dialog).getByRole("list", { name: "Quem tem acesso" });
    const row = (name: RegExp) =>
      within(people())
        .getAllByRole("listitem")
        .find((li) => name.test(li.textContent ?? "")) as HTMLElement;
    return { ...opened, dialog, row };
  };

  test("who has access follows the choice on screen; Save sends it", async () => {
    const { state, dialog, row } = await share();
    expect(row(/Walter \(você\)/).textContent).toContain("Edita");
    expect(row(/João/).textContent).toContain("Não vê");
    await click(within(dialog).getByRole("radio", { name: /^Todo o workspace/ }));
    await settle(2);
    // João holds Admin: admins see every board but private ones, and edit what they see.
    expect(row(/João/).textContent).toContain("Edita");
    expect(row(/João/).textContent).toContain("Admin");
    expect(row(/Lia/).textContent).toContain("Vê");
    await click(within(dialog).getByRole("button", { name: "Salvar" }));
    await settle(6);
    expect(callOf(state, "dashboards.share")?.args).toEqual([
      ORG_ID,
      "dash-m",
      { audience: "workspace", roleIds: [], editPolicy: "owner", editRoleIds: [] },
    ]);
    expect(screen().getByText("“Metas” agora é do workspace")).toBeTruthy();
    expect((document.querySelector(".db-meta") as HTMLElement).textContent).toContain("Todo o workspace");
  });

  test("who edits by roles: their people edit, the dropdown names them, Save sends them", async () => {
    const { state, dialog, row } = await share();
    await click(within(dialog).getByRole("radio", { name: /^Todo o workspace/ }));
    const menu = await openEditors(dialog);
    await click(within(menu).getByRole("menuitemcheckbox", { name: "Vendas" }));
    expect(screen().getByRole("menu")).toBeTruthy();
    await click(within(menu).getByRole("menuitemcheckbox", { name: "Admin" }));
    await closeMenu();
    expect(editorsShown(dialog)).toBe("Admin e Vendas");
    expect(row(/Lia/).textContent).toContain("Edita");
    await click(within(dialog).getByRole("button", { name: "Salvar" }));
    await settle(6);
    expect(callOf(state, "dashboards.share")?.args).toEqual([
      ORG_ID,
      "dash-m",
      { audience: "workspace", roleIds: [], editPolicy: "roles", editRoleIds: [SALES_ROLE_ID, ADMIN_ROLE_ID] },
    ]);
  });
});

describe("New widget (ADR 0135 §3)", () => {
  const withSuggestions = (fake: FakeDashboards) => {
    myBoard(fake);
    fake.suggestions.set(ADA_ID, {
      agentId: ADA_ID,
      sources: ["GitHub", "Sentry"],
      suggestions: [
        {
          title: "PRs esperando revisão",
          prompt: "Os PRs que esperam revisão há mais de um dia",
          kind: "list",
          alert: "algum esperar mais de 2 dias",
        },
      ],
    });
  };
  const start = async (prepare: (fake: FakeDashboards) => void = withSuggestions) => {
    const opened = await open(`/org/${ORG_ID}/dashboards/dash-m`, prepare);
    await click(screen().getAllByRole("button", { name: "Adicionar widget" })[0] as Element);
    await settle(6);
    return { ...opened, dialog: screen().getByRole("dialog", { name: "Novo widget" }) };
  };

  const button = (dialog: HTMLElement, name: string | RegExp) => within(dialog).queryByRole("button", { name });
  /** The widget being made: the card in the dialog, named by its title. */
  const card = (dialog: HTMLElement) => dialog.querySelector("article.nwc") as HTMLElement;
  const ask = (dialog: HTMLElement) => within(dialog).getByLabelText("O que você quer acompanhar?");
  const combo = (dialog: HTMLElement, name: string) => within(dialog).getByRole("combobox", { name });
  /** The bell's popover: the alert's switch and its condition. */
  const openAlert = async (dialog: HTMLElement) => {
    await click(within(card(dialog)).getByRole("button", { name: "Aviso" }));
    await settle(2);
    return screen().getByRole("dialog", { name: "Aviso" });
  };
  const closeAlert = async () => {
    await click(within(screen().getByRole("dialog", { name: "Aviso" })).getByRole("button", { name: "Pronto" }));
    await settle(2);
  };
  /** "Who looks after it": the agent in the card's footer opens a dialog of agents. */
  const openAgents = async (dialog: HTMLElement, current: string) => {
    await click(within(card(dialog)).getByRole("button", { name: `Quem cuida: ${current}` }));
    await settle(4);
    return screen().getByRole("dialog", { name: "Quem cuida" });
  };
  const agentRow = (picker: HTMLElement, name: string) =>
    within(picker)
      .getAllByRole("button")
      .find((b) => b.classList.contains("apk-row") && b.querySelector("b")?.textContent === name) as HTMLElement;

  test("the card is the form: the ask in its body, suggestions, the format and the schedule as dropdowns", async () => {
    const { dialog } = await start();
    // Nothing asked yet: nothing to test, and the other way to make one under the card.
    expect((button(dialog, "Testar") as HTMLButtonElement).disabled).toBe(true);
    expect(button(dialog, "Criar widget")).toBeNull();
    expect(button(dialog, "Ou fixe um bloco que já veio no chat")).toBeTruthy();
    // The title is written on the card; the agent names it on the test.
    expect((within(card(dialog)).getByLabelText("Título") as HTMLInputElement).placeholder).toBe(
      "Título · Ada sugere ao testar",
    );

    // A suggestion fills the ask (and the alert's condition); the suggestions go once something is asked.
    await click(within(dialog).getByRole("button", { name: "PRs esperando revisão" }));
    await settle(3);
    expect((ask(dialog) as HTMLTextAreaElement).value).toBe("Os PRs que esperam revisão há mais de um dia");
    expect(within(dialog).queryByRole("group", { name: "Sugestões" })).toBeNull();
    const alert = await openAlert(dialog);
    expect(within(alert).getByRole("switch", { name: "Me avisar quando algo fugir do normal" })).toBeTruthy();
    expect((within(alert).getByLabelText("Avisar se") as HTMLInputElement).value).toBe("algum esperar mais de 2 dias");
    await closeAlert();

    // The format: Automatic first, each with what it shows.
    const format = combo(dialog, "Formato");
    expect(format.textContent).toContain("Formato automático");
    format.focus();
    await act(async () => fireEvent.keyDown(format, { key: "Enter" }));
    const formats = screen().getAllByRole("option");
    expect(formats[0]?.textContent).toContain("Ada escolhe o que mostra melhor");
    expect(formats.some((o) => o.textContent?.includes("Um número grande e como ele mudou"))).toBe(true);
    await click(formats[0] as HTMLElement);
    await settle(2);

    // How often it updates: only the schedules, no cost anywhere in the dialog.
    const schedule = combo(dialog, "Atualiza");
    expect(schedule.textContent).toContain("a cada hora");
    schedule.focus();
    await act(async () => fireEvent.keyDown(schedule, { key: "Enter" }));
    expect(
      screen()
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["A cada 30 min", "A cada hora", "Todo dia às 8h", "Toda segunda às 8h", "Só quando eu pedir"]);
    await click(screen().getByRole("option", { name: "A cada hora" }));
    await settle(2);
    expect(dialog.textContent).not.toMatch(/US\$|orçamento/);
    expect((button(dialog, "Testar") as HTMLButtonElement).disabled).toBe(false);
  });

  test("the agent in the card's footer opens a dialog of agents with their roles and connectors", async () => {
    const { api, dialog } = await start();
    await act(async () => {
      await api.access.set(ORG_ID, ADA_ID, {
        all: false,
        connectors: { "conn-gh": true },
        scopes: [],
        tools: { allow: [], deny: [] },
      });
    });
    const picker = await openAgents(dialog, "Ada");
    await settle(4);
    const ada = agentRow(picker, "Ada");
    const atlas = agentRow(picker, "Atlas");
    // Each one's face, name and role; the chosen one checked; what each reads with, by its connectors.
    expect(ada.getAttribute("aria-pressed")).toBe("true");
    expect(ada.querySelector(".ac-avatar")).toBeTruthy();
    expect(ada.textContent).toContain("Dev");
    expect([...ada.querySelectorAll(".ac-chip__text")].map((c) => c.textContent)).toEqual(["GitHub"]);
    expect(ada.querySelector(".connector-icon")).toBeTruthy();
    expect(atlas.getAttribute("aria-pressed")).toBe("false");
    expect(atlas.textContent).toContain("Ops");
    expect(atlas.textContent).toContain("Sem conectores");
    // Two agents: no search.
    expect(within(picker).queryByRole("searchbox")).toBeNull();
    // Choosing closes it and the card is Atlas's.
    await click(atlas);
    await settle(4);
    expect(screen().queryByRole("dialog", { name: "Quem cuida" })).toBeNull();
    expect(within(card(dialog)).getByRole("button", { name: "Quem cuida: Atlas" })).toBeTruthy();
  });

  test("Test builds the card in place with real data; Create widget puts it on the board as titled", async () => {
    const { state, fake, dialog } = await start();
    await click(within(dialog).getByRole("button", { name: "PRs esperando revisão" }));
    await pick(combo(dialog, "Formato"), /^Número/);
    await pick(combo(dialog, "Atualiza"), "Todo dia às 8h");
    await pick(combo(dialog, "Tamanho"), /^Grande/);
    await settle(3);

    await click(button(dialog, "Testar") as HTMLElement);
    await settle(6);
    expect(callOf(state, "dashboards.testWidget")?.args).toEqual([
      ORG_ID,
      "dash-m",
      {
        agentId: ADA_ID,
        prompt: "Os PRs que esperam revisão há mais de um dia",
        title: "PRs esperando revisão",
        format: "kpi",
        schedule: "day",
        alert: { enabled: true, condition: "algum esperar mais de 2 dias" },
        size: "l",
      },
    ]);
    // The draft, built with real data in the card itself; the ask folds into one line that opens it again.
    const draftId = fake.drafts[0]?.id as string;
    expect(fake.drafts).toHaveLength(1);
    const built = card(dialog);
    expect(within(built).getByRole("img", { name: "Dados de verdade · agora" })).toBeTruthy();
    expect(built.querySelector(".wk-num")).toBeTruthy();
    expect(within(dialog).queryByLabelText("O que você quer acompanhar?")).toBeNull();
    expect(
      within(built).getByRole("button", { name: "Mudar o pedido: Os PRs que esperam revisão há mais de um dia" }),
    ).toBeTruthy();
    // What it reads and how it keeps up, under the card; no cost.
    expect(dialog.textContent).toContain("Lê GitHub e Sentry · a rotina aparece em Rotinas");
    expect(dialog.textContent).not.toMatch(/US\$|custou/);
    expect(button(dialog, "Testar")).toBeNull();

    // Its title, the agent's, is edited on the card; the schedule changes without a new test.
    const title = within(built).getByLabelText("Título") as HTMLInputElement;
    expect(title.value).toBe("PRs esperando revisão");
    await type(title, "PRs parados");
    await pick(combo(dialog, "Atualiza"), "A cada hora");
    expect(card(dialog).getAttribute("aria-label")).toBe("PRs parados");
    await click(button(dialog, "Criar widget") as HTMLElement);
    await settle(6);
    expect(callOf(state, "dashboards.confirmWidget")?.args).toEqual([
      ORG_ID,
      draftId,
      {
        dashboardId: "dash-m",
        title: "PRs parados",
        size: "l",
        schedule: "hour",
        alert: { enabled: true, condition: "algum esperar mais de 2 dias" },
      },
    ]);
    // Created: kept (not deleted with the dialog), on the board, and the dialog closed.
    expect(callOf(state, "dashboards.removeWidget")).toBeUndefined();
    expect(callOf(state, "dashboards.createWidget")).toBeUndefined();
    expect(screen().getByText("Widget adicionado em Metas")).toBeTruthy();
    expect(screen().queryByRole("dialog", { name: "Novo widget" })).toBeNull();
    expect(screen().getByRole("article", { name: "PRs parados" })).toBeTruthy();
  });

  test("Enter tests; the agent's title is kept when nobody edits it, and no title is sent", async () => {
    const { state, dialog } = await start();
    await type(ask(dialog), "erros em produção hoje");
    await act(async () => fireEvent.keyDown(ask(dialog), { key: "Enter" }));
    await settle(6);
    expect(callsOf(state, "dashboards.testWidget")).toHaveLength(1);
    expect((within(card(dialog)).getByLabelText("Título") as HTMLInputElement).value).toBe("Erros em produção hoje");
    await click(button(dialog, "Criar widget") as HTMLElement);
    await settle(6);
    const sent = callOf(state, "dashboards.confirmWidget")?.args[2] as Record<string, unknown>;
    expect(sent).toEqual({
      dashboardId: "dash-m",
      size: "m",
      schedule: "hour",
      alert: { enabled: true, condition: "" },
    });
  });

  test("while it builds: the agent at it in the card, Test waits; then the real result and Create widget", async () => {
    const { fake, services, dialog } = await start((fake) => {
      withSuggestions(fake);
      fake.holdDrafts = true;
    });
    await type(ask(dialog), "erros em produção hoje");
    await click(button(dialog, "Testar") as HTMLElement);
    await settle(6);
    const building = card(dialog);
    // Between calls it is thinking; who is at it, for how long and the way out sit in the card's footer.
    expect(within(building).getByRole("status").textContent).toBe("Pensando");
    expect(building.querySelector(".wg__foot")?.textContent).toBe("Ada montando…0:00Parar");
    expect((button(dialog, "Testando…") as HTMLButtonElement).disabled).toBe(true);
    expect(button(dialog, "Criar widget")).toBeNull();
    // Unnamed while the agent hasn't named it: never the ask.
    expect(building.getAttribute("aria-label")).toBe("Novo widget");

    const draftId = fake.drafts[0]?.id as string;
    fake.finish(draftId, {
      spec: { kind: "kpi", value: 3, note: "desde as 8h" },
      title: "Erros hoje",
    });
    await act(async () => services.queryClient.invalidateQueries());
    await settle(6);
    expect(within(card(dialog)).getByRole("img", { name: /^Dados de verdade/ })).toBeTruthy();
    expect(card(dialog).getAttribute("aria-label")).toBe("Erros hoje");
    expect(button(dialog, "Criar widget")).toBeTruthy();
  });

  test("while it builds: the step its agent is in, in words, the time it takes, and one more line past 45 s", async () => {
    const began = Date.now();
    setSystemTime(new Date(began));
    try {
      const { fake, services, dialog } = await start((fake) => {
        withSuggestions(fake);
        fake.holdDrafts = true;
      });
      await type(ask(dialog), "MRR em real");
      await click(button(dialog, "Testar") as HTMLElement);
      await settle(6);
      const draftId = fake.drafts[0]?.id as string;
      const line = () => within(card(dialog)).getByRole("status").textContent;
      const step = async (tool: string, connector: string | null) => {
        fake.steps.set(draftId, { tool, connector, service: null, at: new Date().toISOString() });
        // What a `dashboard.widget` event does to the draft (and the 2 s poll, without one).
        await act(async () => services.queryClient.invalidateQueries());
        await settle(6);
      };
      expect(line()).toBe("Pensando");
      // The connected app by its name, our own tools by what they do: never a tool's name.
      await step("stripe_list_subscriptions", "Stripe");
      expect(line()).toBe("Consultando o Stripe");
      await step("web_fetch", null);
      expect(line()).toBe("Lendo uma página da web");
      await step("update_widget", null);
      expect(line()).toBe("Montando o widget");
      expect(card(dialog).textContent).not.toMatch(/update_widget|web_fetch|stripe_list/);
      // The worst case: a server connected by address with a long name, whole, wrapping inside the card.
      const long = "Painel Financeiro Consolidado da Controladoria Regional Sul";
      await step("custom_abc_query_everything", long);
      expect(line()).toBe(`Consultando o ${long}`);
      fake.steps.delete(draftId);
      await act(async () => services.queryClient.invalidateQueries());
      await settle(6);
      expect(line()).toBe("Pensando");

      const still = card(dialog).querySelector(".nw-build__still") as HTMLElement;
      const clock = () => within(card(dialog)).getByRole("timer").textContent;
      const tick = async (seconds: number) => {
        setSystemTime(new Date(began + seconds * 1000));
        await act(async () => {
          await new Promise((r) => setTimeout(r, 1100));
        });
      };
      expect(still.hasAttribute("data-on")).toBe(false);
      expect(still.getAttribute("aria-hidden")).toBe("true");
      await tick(40);
      expect(clock()).toMatch(/^0:4[0-2]$/);
      expect(still.hasAttribute("data-on")).toBe(false);
      await tick(106);
      expect(clock()).toMatch(/^1:4[6-8]$/);
      expect(still.hasAttribute("data-on")).toBe(true);
      expect(still.getAttribute("aria-hidden")).toBe("false");
      expect(still.textContent).toBe("Ainda trabalhando. Dados de verdade podem levar um ou dois minutos.");
    } finally {
      setSystemTime();
    }
  });

  test("Parar stops the build: the draft goes, what was typed stays to change and test again", async () => {
    const { state, fake, dialog } = await start((fake) => {
      withSuggestions(fake);
      fake.holdDrafts = true;
    });
    await type(ask(dialog), "MRR em real");
    await click(button(dialog, "Testar") as HTMLElement);
    await settle(6);
    const draftId = fake.drafts[0]?.id as string;
    await click(within(card(dialog)).getByRole("button", { name: "Parar" }));
    await settle(6);
    expect(callsOf(state, "dashboards.removeWidget").map((c) => c.args)).toEqual([[ORG_ID, draftId]]);
    expect(fake.drafts).toHaveLength(0);
    // The dialog stays, with the ask as written, in focus, ready to test again.
    expect((ask(dialog) as HTMLTextAreaElement).value).toBe("MRR em real");
    expect(document.activeElement).toBe(ask(dialog));
    expect(within(card(dialog)).queryByRole("status")).toBeNull();
    expect(button(dialog, "Parar")).toBeNull();
    await type(ask(dialog), "MRR em dólar");
    const again = button(dialog, "Testar") as HTMLButtonElement;
    expect(again.disabled).toBe(false);
    await click(again);
    await settle(6);
    expect(callsOf(state, "dashboards.testWidget")).toHaveLength(2);
    expect(within(card(dialog)).getByRole("status").textContent).toBe("Pensando");
    // Closing drops the second draft only: the stopped one is already gone.
    const second = fake.drafts[0]?.id as string;
    await click(within(dialog).getByRole("button", { name: "Cancelar" }));
    await settle(6);
    expect(callsOf(state, "dashboards.removeWidget").map((c) => c.args)).toEqual([
      [ORG_ID, draftId],
      [ORG_ID, second],
    ]);
  });

  test("a changed ask, agent or format makes the test stale; a new test drops the old draft", async () => {
    const { state, fake, dialog } = await start();
    await type(ask(dialog), "erros em produção hoje");
    await pick(combo(dialog, "Atualiza"), "Só quando eu pedir");
    const alert = await openAlert(dialog);
    await click(within(alert).getByRole("switch", { name: "Me avisar quando algo fugir do normal" }));
    await closeAlert();
    expect(within(card(dialog)).getByRole("button", { name: "Aviso" }).getAttribute("title")).toBe("Sem avisos");
    await click(button(dialog, "Testar") as HTMLElement);
    await settle(6);
    expect(callOf(state, "dashboards.testWidget")?.args[2]).toEqual({
      agentId: ADA_ID,
      prompt: "erros em produção hoje",
      format: "auto",
      schedule: "manual",
      alert: { enabled: false, condition: "" },
      size: "m",
    });
    const first = fake.drafts[0]?.id as string;
    expect(dialog.textContent).toContain("Sem rotina: atualiza quando você pedir");
    expect(button(dialog, "Criar widget")).toBeTruthy();

    // The size doesn't touch the test; another agent does (and back, it holds again).
    await pick(combo(dialog, "Tamanho"), /^Pequeno/);
    await settle(2);
    expect(button(dialog, "Criar widget")).toBeTruthy();
    await click(agentRow(await openAgents(dialog, "Ada"), "Atlas"));
    await settle(3);
    expect(card(dialog).querySelector(".nwc__stale")?.textContent).toContain(
      "Mudou desde o teste. Teste de novo para ver como fica.",
    );
    expect(button(dialog, "Criar widget")).toBeNull();
    await click(agentRow(await openAgents(dialog, "Atlas"), "Ada"));
    await settle(3);
    expect(card(dialog).querySelector(".nwc__stale")).toBeNull();
    expect(button(dialog, "Criar widget")).toBeTruthy();

    // The folded ask opens again: a changed ask is stale, the same one holds.
    await click(within(card(dialog)).getByRole("button", { name: "Mudar o pedido: erros em produção hoje" }));
    await settle(2);
    expect(dialog.textContent).toContain("Enter testa de novo");
    await type(ask(dialog), "erros em produção desta semana");
    expect(button(dialog, "Criar widget")).toBeNull();
    expect(button(dialog, "Testar de novo")).toBeTruthy();
    await type(ask(dialog), "erros em produção hoje");
    expect(button(dialog, "Criar widget")).toBeTruthy();
    // The format too.
    await pick(combo(dialog, "Formato"), /^Lista/);
    expect(button(dialog, "Criar widget")).toBeNull();

    await click(button(dialog, "Testar de novo") as HTMLElement);
    await settle(6);
    expect(callsOf(state, "dashboards.testWidget")).toHaveLength(2);
    expect(callsOf(state, "dashboards.removeWidget").map((c) => c.args)).toEqual([[ORG_ID, first]]);
    expect(fake.drafts.map((d) => d.id)).not.toContain(first);
    expect(button(dialog, "Criar widget")).toBeTruthy();
    expect(within(dialog).queryByLabelText("O que você quer acompanhar?")).toBeNull();
  });

  test("a test that fails says why in the card, with Try again; closing the dialog drops the draft", async () => {
    const { state, fake, dialog } = await start();
    await type(ask(dialog), "status do failover");
    await click(button(dialog, "Testar") as HTMLElement);
    await settle(6);
    const failedCard = card(dialog);
    expect(failedCard.textContent).toContain("Ada não conseguiu montar");
    expect(failedCard.textContent).toContain("The source isn't connected for me.");
    expect((button(dialog, "Criar widget") as HTMLButtonElement).disabled).toBe(true);
    const first = fake.drafts[0]?.id as string;
    await click(within(failedCard).getByRole("button", { name: "Tentar de novo" }));
    await settle(6);
    expect(callsOf(state, "dashboards.testWidget")).toHaveLength(2);
    expect(callsOf(state, "dashboards.removeWidget").map((c) => c.args)).toEqual([[ORG_ID, first]]);
    const second = fake.drafts[0]?.id as string;
    expect(second).not.toBe(first);

    await click(within(dialog).getByRole("button", { name: "Cancelar" }));
    await settle(6);
    expect(screen().queryByRole("dialog", { name: "Novo widget" })).toBeNull();
    expect(callsOf(state, "dashboards.removeWidget").map((c) => c.args)).toEqual([
      [ORG_ID, first],
      [ORG_ID, second],
    ]);
    expect(fake.drafts).toHaveLength(0);
  });

  test("pinning a chart from the chat: pick it in the card, keep it updated or not, Pin", async () => {
    const { state, dialog } = await start((fake) => {
      myBoard(fake);
      fake.pinnable = [
        {
          messageId: "m-2",
          channelId: ENG_ID,
          threadId: null,
          agentId: ADA_ID,
          at: NOW.toISOString(),
          block: JSON.stringify({
            type: "bar",
            title: "Deploys da semana",
            labels: ["seg", "ter", "qua"],
            series: [{ name: "deploys", values: [3, 5, 2] }],
          }),
          title: "Deploys da semana",
          spec: { kind: "bars", labels: ["seg", "ter", "qua"], values: [3, 5, 2] },
          place: { kind: "channel", name: "eng" },
        },
      ];
    });
    await click(button(dialog, "Ou fixe um bloco que já veio no chat") as HTMLElement);
    await settle(4);
    expect(within(dialog).getByRole("heading", { name: "Fixar um bloco do chat" })).toBeTruthy();
    const pin = within(dialog).getByRole("button", { name: "Fixar" }) as HTMLButtonElement;
    expect(pin.disabled).toBe(true);
    expect(dialog.textContent).toContain("Escolha um bloco que um agente já mandou:");
    const block = segment(dialog, "Blocos que os agentes mandaram no chat", /Deploys da semana/);
    expect(block.textContent).toContain("Ada em #eng");
    await click(block);
    await settle(3);
    const pinned = card(dialog);
    expect((within(pinned).getByLabelText("Título") as HTMLInputElement).value).toBe("Deploys da semana");
    expect([...pinned.querySelectorAll(".wk-bar__v")].map((v) => v.textContent)).toEqual(["3", "5", "2"]);
    expect(within(pinned).queryByRole("button", { name: "Aviso" })).toBeNull();
    await pick(combo(dialog, "Atualiza"), "Não atualizar");
    expect(dialog.textContent).toContain("Fica como está, sem rotina");
    await click(pin);
    await settle(6);
    const call = callOf(state, "dashboards.pinWidget");
    expect(call?.args[1]).toBe("dash-m");
    expect(call?.args[2]).toMatchObject({ messageId: "m-2", schedule: "manual", size: "m" });
  });
});

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { ApiError, type Issue, type IssueWork } from "@agenteschat/client";
import { toYmd } from "@agenteschat/client/lib/format";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { mondayOf } from "@/pages/CalendarPage";
import { splitCriteria } from "@/pages/IssuesPage";
import { ADA_ID, createFakeApi, ORG_ID, seedState } from "./fake-api";
import { nextCronRun, parseSchedulePhrase } from "./fakes/planning";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const key = async (el: Element, k: string) => {
  await act(async () => {
    fireEvent.keyDown(el, { key: k });
    fireEvent.keyUp(el, { key: k });
  });
  await act(() => new Promise((r) => setTimeout(r, 0)));
};
const pick = async (combobox: HTMLElement, option: string | RegExp) => {
  combobox.focus();
  await key(combobox, "Enter");
  await click(within(screen().getByRole("listbox")).getByRole("option", { name: option }));
  await settle(3);
};
const go = async (path: string, api = createFakeApi(seedState())) => {
  const r = await renderApp(`/org/${ORG_ID}/${path}`, { api });
  await settle(8);
  return { ...r, api };
};
const column = (name: string) => screen().getByRole("region", { name });
// The title after its number ("#131 Confirmação…" on one row).
const cardTitles = (el: HTMLElement) =>
  Array.from(el.querySelectorAll(".issue-card__title")).map((x) => x.textContent?.replace(/^#\d+ /, ""));
/** Radix tabs switch on mouse down. */
const tab = async (name: string | RegExp) => {
  await act(async () => fireEvent.mouseDown(screen().getByRole("tab", { name }), { button: 0 }));
  await settle(3);
};

describe("Issues (board and list)", () => {
  test("board by status with counts, summary, PR, priority and due date", async () => {
    await go("issues");
    expect(screen().getByRole("heading", { level: 1, name: "Tarefas" })).toBeTruthy();
    expect(screen().getByText("5 em aberto · 3 com agentes")).toBeTruthy();
    expect(cardTitles(column("A fazer"))).toEqual([
      "Tabela de concorrentes atualizada",
      "Confirmação do agendamento por WhatsApp",
    ]);
    expect(column("Em revisão").textContent).toContain("PR #42");
    const wa = screen().getByRole("link", { name: "#131 Confirmação do agendamento por WhatsApp" });
    expect(wa.textContent).toContain("Alta");
    expect(wa.textContent).toContain("produto");
    expect(wa.textContent).toContain("João");
    expect(column("Feito").textContent).toContain("2");
    // The route title link goes to the detail.
    expect(wa.getAttribute("href")).toBe(`/org/${ORG_ID}/issues/131`);
    // An agent with a live run: "working now" with its step; on the card, its one state and the criteria done.
    const now = screen().getByRole("region", { name: "Agentes trabalhando agora" });
    expect(now.textContent).toContain("Timeout no agendamento em horários de pico");
    expect(now.textContent).toContain("Atualizou uma tarefa · #129");
    const timeout = screen().getByRole("link", {
      name: "#129 Timeout no agendamento em horários de pico, Trabalhando",
    });
    expect(timeout.querySelector('[title="1 de 2 critérios de aceite"]')?.textContent).toBe("1/2");
  });

  test("ten agents at work over the board: every card shows, and the board still ends its page for the page to scroll down to", async () => {
    const state = seedState();
    const [ada] = state.agents;
    if (!ada) throw new Error("no agent");
    const names = ["Bento", "Cora", "Davi", "Elis", "Faro", "Gael", "Hana", "Iris", "Juno"];
    state.agents.push(
      ...names.map((name, k) => ({ ...ada, id: `agent-at-work-${k}`, name, handle: name.toLowerCase() })),
    );
    const states: IssueWork["state"][] = ["running", "waiting_approval", "running", "waiting_input", "running"];
    const api = createFakeApi(state);
    const list = api.issues.list;
    api.issues.list = async (orgId, filters) => {
      const all = await list(orgId, filters);
      const at = all.find((i) => i.work);
      const work = at?.work;
      if (!at || !work) return all;
      const extra = names.map(
        (name, k): Issue => ({
          ...at,
          id: `iss-at-work-${k}`,
          number: 200 + k,
          title: `${name} revisa a integração do agendamento com o calendário da clínica, etapa ${k + 1} de ${names.length}`,
          assignee: { type: "agent", id: `agent-at-work-${k}` },
          pullRequests: [],
          work: {
            ...work,
            agentId: `agent-at-work-${k}`,
            state: k === names.length - 1 ? "stalled" : (states[k % states.length] ?? "running"),
            steps: [{ tool: "update_issue", detail: `#${200 + k}`, at: work.since }],
          },
        }),
      );
      return [...all, ...extra];
    };
    await go("issues", api);
    const now = screen().getByRole("region", { name: "Agentes trabalhando agora" });
    expect(now.querySelectorAll(".issues-now__card")).toHaveLength(10);
    // Nothing comes after the board's split, up to the work area: when the cards above squeeze it, it keeps a window's
    // height and the page scrolls down to it (over-pages.css), with nothing for its columns to run over.
    let el: Element | null = document.querySelector(".issues-boardframe.page-split");
    expect(el).toBeTruthy();
    for (; el && !el.matches(".shell__main"); el = el.parentElement) expect(el.nextElementSibling).toBeNull();
  });

  test("a click opens the details dialog (kept in the URL); Escape closes it", async () => {
    const { router } = await go("issues");
    await click(screen().getByRole("link", { name: "#131 Confirmação do agendamento por WhatsApp" }));
    await settle(4);
    const dialog = screen().getByRole("dialog", { name: "Confirmação do agendamento por WhatsApp" });
    expect(dialog.textContent).toContain("#131");
    expect(within(dialog).getByRole("region", { name: "Pedir a um agente" })).toBeTruthy();
    expect(within(dialog).getByRole("group", { name: "Detalhes da tarefa" })).toBeTruthy();
    expect(within(dialog).queryByRole("complementary", { name: "Detalhes da tarefa" })).toBeNull();
    expect(router.state.location.href).toContain("?open=131");
    await act(async () => fireEvent.keyDown(document.body, { key: "Escape" }));
    await settle(2);
    expect(screen().queryByRole("dialog")).toBeNull();
    expect(router.state.location.href).not.toContain("open=");
  });

  test("the dialog's bar: #131 and the title, then one ⋯ beside the × with the conversation, its page and Excluir", async () => {
    const { router } = await go("issues?open=131");
    const dialog = screen().getByRole("dialog", { name: "Confirmação do agendamento por WhatsApp" });
    const close = dialog.querySelector(".ac-details__close") as HTMLElement;
    expect([...close.querySelectorAll(".ac-btn")].map((b) => b.getAttribute("aria-label"))).toEqual([
      "Mais opções",
      "Fechar",
    ]);
    // Nothing else on the bar: no buttons above or beside the title to squeeze it.
    expect(dialog.querySelector(".ac-details__actions")).toBeNull();
    const more = within(close).getByRole("button", { name: "Mais opções" });
    more.focus();
    await key(more, "Enter");
    const items = within(screen().getByRole("menu")).getAllByRole("menuitem");
    expect(items.map((m) => m.textContent)).toEqual(["Conversa", "Abrir página da tarefa", "Excluir tarefa"]);
    await click(items[1] as HTMLElement);
    await settle(4);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/issues/131`);
  });

  test("an issue's link with ?open= reopens its details", async () => {
    await go("issues?open=131");
    expect(screen().getByRole("dialog", { name: "Confirmação do agendamento por WhatsApp" })).toBeTruthy();
  });

  test("Filtro: who has it and the priority, as chips; the search; the list from Exibição", async () => {
    const state = seedState();
    await go("issues", createFakeApi(state));
    const filterMenu = async (name: string) => {
      const trigger = screen().getByRole("button", { name });
      trigger.focus();
      await key(trigger, "Enter");
      return screen().getByRole("menu");
    };
    const pickIn = async (menu: HTMLElement, name: string) => {
      await click(within(menu).getByRole("menuitemcheckbox", { name }));
      await settle(3);
    };
    const closeMenu = async () => {
      await act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
      await settle(2);
    };
    // Me first, then the agents and the people with a task here, then nobody; then the priorities.
    let menu = await filterMenu("Filtro");
    expect(
      within(menu)
        .getAllByRole("menuitemcheckbox")
        .map((o) => o.querySelector(".ac-menu__label")?.textContent),
    ).toEqual(["Eu", "Ada", "Atlas", "João", "Sem responsável", "Alta", "Normal", "Baixa"]);
    await pickIn(menu, "Ada");
    // An open menu hides the rest of the page from the accessibility tree: read the board once it closes.
    await closeMenu();
    expect(cardTitles(column("A fazer"))).toEqual(["Tabela de concorrentes atualizada"]);
    expect(cardTitles(column("Em andamento"))).toEqual(["Timeout no agendamento em horários de pico"]);
    // In use: a chip that reads it and opens the same menu; kept for me.
    expect(screen().getByRole("button", { name: "Responsável: Ada" })).toBeTruthy();
    expect(state.issuesView?.assignees).toEqual([`agent:${ADA_ID}`]);
    await click(screen().getByRole("button", { name: "Limpar Ada" }));
    await settle(3);
    expect(screen().queryByRole("button", { name: "Responsável: Ada" })).toBeNull();
    expect(state.issuesView?.assignees).toEqual([]);
    // Mine: none here.
    menu = await filterMenu("Filtro");
    await pickIn(menu, "Eu");
    expect(screen().getByText("Nenhuma tarefa com esses filtros.")).toBeTruthy();
    await pickIn(menu, "Eu");
    await pickIn(menu, "Alta");
    await closeMenu();
    expect(
      screen()
        .getAllByRole("link", { name: /^#\d+/ })
        .map((l) => l.getAttribute("aria-label")),
    ).toEqual(["#131 Confirmação do agendamento por WhatsApp", "#128 Login devolve 401 depois do deploy das 9h"]);
    await click(screen().getByRole("button", { name: "Limpar Alta" }));
    await settle(3);
    await type(screen().getByRole("searchbox", { name: "Buscar tarefas" }), "#128");
    await settle(4);
    expect(screen().getAllByRole("link", { name: /^#\d+/ })).toHaveLength(1);
    await type(screen().getByRole("searchbox", { name: "Buscar tarefas" }), "");
    await settle(4);
    await click(screen().getByRole("button", { name: "Exibição: Quadro · Etapa" }));
    await settle(2);
    await click(within(screen().getByRole("dialog", { name: "Exibição" })).getByRole("button", { name: "Lista" }));
    await settle(3);
    const rows = screen().getAllByRole("listitem");
    expect(rows).toHaveLength(7);
    expect(rows[0]?.textContent).toContain("#132");
    expect(rows.find((r) => r.textContent?.includes("#126"))?.textContent).toContain("Feito");
    expect(state.issuesView?.layout).toBe("list");
  });

  test("Nova tarefa: title, criteria from '-' lines, assignee (each by its face), priority and a pasted print", async () => {
    const state = seedState();
    const [ada, atlas] = state.agents;
    if (ada) ada.appearance = { color: "green", accessory: "headphones" };
    if (atlas) atlas.appearance = { color: "rose", accessory: "crown" };
    const { api } = await go("issues", createFakeApi(state));
    await click(screen().getByRole("button", { name: "Nova tarefa" }));
    const dialog = screen().getByRole("dialog", { name: "Nova tarefa" });
    const create = within(dialog).getByRole("button", { name: "Criar tarefa" });
    expect(create.hasAttribute("disabled")).toBe(true);
    await type(within(dialog).getByLabelText("Título"), "Exportar agenda em PDF");
    const text = within(dialog).getByLabelText("Descrição e critérios de aceite");
    await type(text, "Pedido de 18 reviews.\n- Botão na agenda\n- PDF com o logo da clínica");
    expect(dialog.textContent).toContain("2 critérios de aceite");
    // A print pasted into the box goes to the Drive at once and shows under the text.
    const print = new File(["png"], "image.png", { type: "image/png" });
    await act(async () => fireEvent.paste(text, { clipboardData: { files: [print] } }));
    await settle(4);
    expect(within(dialog).getByRole("button", { name: "Remover image.png" })).toBeTruthy();
    // Who takes it: a small button, each one by their face.
    const who = within(dialog).getByRole("button", { name: "Responsável" });
    who.focus();
    await key(who, "Enter");
    const leads = within(screen().getByRole("menu"))
      .getAllByRole("menuitem")
      .map((o) => {
        const lead = o.querySelector<HTMLElement | SVGElement>(".ac-menu__leading > *");
        const kind = lead?.getAttribute("data-kind");
        return [
          o.querySelector(".ac-menu__label")?.firstChild?.textContent,
          kind === "agent" ? lead?.getAttribute("data-accessory") : kind ? lead?.textContent : lead?.style.width,
        ];
      });
    expect(leads).toEqual([
      ["Sem responsável", "18px"],
      ["Walter", "W"],
      ["João", "J"],
      ["Ada", "headphones"],
      ["Atlas", "crown"],
    ]);
    await click(within(screen().getByRole("menu")).getByRole("menuitem", { name: "Ada" }));
    await settle(3);
    expect(dialog.textContent).toContain("com a descrição, os critérios e os anexos");
    const priority = within(dialog).getByRole("button", { name: "Prioridade: Normal" });
    priority.focus();
    await key(priority, "Enter");
    await click(within(screen().getByRole("menu")).getByRole("menuitem", { name: "Alta" }));
    await settle(3);
    await click(create);
    await settle(5);
    expect(screen().getByText("Tarefa #133 criada.")).toBeTruthy();
    // An agent picked at creation starts right away ("Pedir"): in progress.
    expect(cardTitles(column("Em andamento"))).toContain("Exportar agenda em PDF");
    const created = await api.issues.get(ORG_ID, 133);
    expect(created).toMatchObject({
      description: "Pedido de 18 reviews.",
      priority: "high",
      assignee: { type: "agent" },
    });
    expect(created.criteria.map((c) => c.text)).toEqual(["Botão na agenda", "PDF com o logo da clínica"]);
    expect(created.artifacts).toHaveLength(1);
  });

  test("Nova tarefa with an agent that can't start: created, why it didn't start, and Pedir de novo starts it", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const ask = api.issues.askAgent;
    let refusals = 1;
    api.issues.askAgent = async (orgId, id, agentId) => {
      if (refusals-- > 0)
        throw new ApiError(403, "audience.only", "Ada only replies to Walter.", {
          agentName: "Ada",
          names: ["Walter"],
        });
      return ask(orgId, id, agentId);
    };
    await go("issues", api);
    await click(screen().getByRole("button", { name: "Nova tarefa" }));
    const dialog = screen().getByRole("dialog", { name: "Nova tarefa" });
    await type(within(dialog).getByLabelText("Título"), "Exportar agenda em PDF");
    const who = within(dialog).getByRole("button", { name: "Responsável" });
    who.focus();
    await key(who, "Enter");
    await click(within(screen().getByRole("menu")).getByRole("menuitem", { name: "Ada" }));
    await settle(3);
    await click(within(dialog).getByRole("button", { name: "Criar tarefa" }));
    await settle(8);
    const toast = () => [...document.querySelectorAll<HTMLElement>(".ac-toast")].at(-1) as HTMLElement;
    expect(toast().textContent).toContain("Tarefa #133 criada, mas a Ada não começou.");
    expect(toast().textContent).toContain("A Ada só responde a Walter.");
    // It stays hers, waiting in A fazer.
    expect((await api.issues.get(ORG_ID, 133)).assignee).toEqual({ type: "agent", id: ADA_ID });
    await click(within(toast()).getByRole("button", { name: "Pedir de novo" }));
    await settle(8);
    expect(toast().textContent).toContain("Pedido enviado. A Ada trabalha na conversa da tarefa");
    expect(cardTitles(column("Em andamento"))).toContain("Exportar agenda em PDF");
  });

  test("Nova tarefa: a stray press outside or Esc keeps what was written; × still closes it", async () => {
    await go("issues");
    await click(screen().getByRole("button", { name: "Nova tarefa" }));
    const dialog = screen().getByRole("dialog", { name: "Nova tarefa" });
    // Empty, Esc closes it as before.
    await key(within(dialog).getByLabelText("Título"), "Escape");
    await settle(2);
    expect(screen().queryByRole("dialog", { name: "Nova tarefa" })).toBeNull();
    await click(screen().getByRole("button", { name: "Nova tarefa" }));
    const again = screen().getByRole("dialog", { name: "Nova tarefa" });
    await type(within(again).getByLabelText("Título"), "Exportar agenda");
    await key(within(again).getByLabelText("Título"), "Escape");
    const scrim = document.querySelector(".ac-dialog__scrim") as HTMLElement;
    await act(async () => {
      fireEvent.pointerDown(scrim);
      fireEvent.click(scrim);
      await new Promise((r) => setTimeout(r, 0));
    });
    await settle(2);
    expect((within(again).getByLabelText("Título") as HTMLInputElement).value).toBe("Exportar agenda");
    await click(within(again).getByRole("button", { name: "Fechar" }));
    await settle(2);
    expect(screen().queryByRole("dialog", { name: "Nova tarefa" })).toBeNull();
  });

  test("Nova tarefa → formulário completo: the text splits into description and criteria, and comes back", async () => {
    await go("issues");
    await click(screen().getByRole("button", { name: "Nova tarefa" }));
    const dialog = screen().getByRole("dialog", { name: "Nova tarefa" });
    await type(within(dialog).getByLabelText("Título"), "Exportar agenda");
    await type(
      within(dialog).getByLabelText("Descrição e critérios de aceite"),
      "Pedido de clientes.\n- Botão na agenda",
    );
    await click(within(dialog).getByRole("button", { name: "Abrir o formulário completo" }));
    const field = (label: string, tag: string) =>
      within(dialog)
        .getAllByLabelText(label)
        .filter((e) => e.tagName === tag) as HTMLInputElement[];
    expect((within(dialog).getByLabelText("Título") as HTMLInputElement).value).toBe("Exportar agenda");
    expect(field("Descrição", "TEXTAREA")[0]?.value).toBe("Pedido de clientes.");
    expect(field("Critérios de aceite", "INPUT").map((e) => e.value)).toEqual(["Botão na agenda"]);
    // Its fields as the quick form's strip, under the title and over the description: no side column.
    expect(dialog.querySelector(".issue-new__side, aside")).toBeNull();
    const strip = dialog.querySelector(".issue-new__props") as HTMLElement;
    expect(strip.classList.contains("ac-props")).toBe(true);
    expect(strip.previousElementSibling?.getAttribute("aria-label")).toBe("Título");
    expect([...strip.querySelectorAll("button")].map((b) => b.getAttribute("aria-label")?.replace(/:.*$/, ""))).toEqual(
      ["Responsável", "Prioridade", "Quem vê", "Prazo"],
    );
    const add = within(dialog).getByPlaceholderText("Adicionar critério");
    await type(add, "PDF com o logo");
    await key(add, "Enter");
    expect(field("Critérios de aceite", "INPUT").map((e) => e.value)).toEqual(["Botão na agenda", "PDF com o logo"]);
    expect(within(dialog).getByRole("region", { name: "Anexos" })).toBeTruthy();
    await click(within(dialog).getByRole("button", { name: "Voltar ao formulário rápido" }));
    expect((within(dialog).getByLabelText("Descrição e critérios de aceite") as HTMLTextAreaElement).value).toBe(
      "Pedido de clientes.\n\n- Botão na agenda\n- PDF com o logo",
    );
  });
});

describe("Tarefas: custom board columns", () => {
  const openMenu = async (name: string) => {
    const trigger = screen().getByRole("button", { name });
    trigger.focus();
    await key(trigger, "Enter");
    return screen().getByRole("menu");
  };

  test("Mais opções → Adicionar coluna: a name and the stage; the board then groups columns under stages", async () => {
    const { api } = await go("issues");
    // The default board: one column per stage, no stage headers.
    expect(screen().queryByRole("region", { name: "Ideias" })).toBeNull();
    await click(within(await openMenu("Mais opções")).getByRole("menuitem", { name: "Adicionar coluna" }));
    await settle(3);
    const dialog = screen().getByRole("dialog", { name: "Nova coluna" });
    const add = within(dialog).getByRole("button", { name: "Adicionar coluna" });
    expect(add.hasAttribute("disabled")).toBe(true);
    await type(within(dialog).getByLabelText("Nome"), "Ideias");
    await click(within(dialog).getByRole("radio", { name: /Em revisão/ }));
    expect(dialog.textContent).toContain("Fica no fim de Em revisão.");
    expect(dialog.textContent).toContain("primeira coluna de Em revisão");
    await click(add);
    await settle(5);
    expect(screen().getByText("Coluna Ideias criada")).toBeTruthy();
    const columns = await api.issues.columns(ORG_ID);
    expect(columns.filter((c) => c.stage === "in_review").map((c) => c.name)).toEqual([null, "Ideias"]);
    // Customized: the stage groups its two columns under a header.
    // (The stage comes first; its unnamed column carries the same name.)
    const stage = screen().getAllByRole("region", { name: "Em revisão" })[0] as HTMLElement;
    expect(within(stage).getByRole("region", { name: "Ideias" })).toBeTruthy();
  });

  test("a stage with the most columns says so in the dialog, before any refusal", async () => {
    const api = createFakeApi(seedState());
    for (let i = 1; i < 10; i++) await api.issues.addColumn(ORG_ID, { name: `C${i}`, stage: "todo" });
    await go("issues", api);
    await click(within(await openMenu("Mais opções")).getByRole("menuitem", { name: "Adicionar coluna" }));
    await settle(3);
    const dialog = screen().getByRole("dialog", { name: "Nova coluna" });
    await type(within(dialog).getByLabelText("Nome"), "Mais uma");
    await click(within(dialog).getByRole("radio", { name: /A fazer/ }));
    expect(dialog.textContent).toContain("A fazer já tem 10 colunas, o máximo de uma etapa. Exclua uma delas antes.");
    expect(within(dialog).getByRole("button", { name: "Adicionar coluna" }).hasAttribute("disabled")).toBe(true);
  });

  test("a column's menu: the first one says what lands there; the only one can't be deleted", async () => {
    await go("issues");
    const menu = await openMenu("Opções da coluna A fazer");
    expect(menu.textContent).toContain("Tarefas novas entram aqui.");
    expect(within(menu).getByRole("menuitem", { name: "Excluir coluna" }).getAttribute("aria-disabled")).toBe("true");
    expect(menu.textContent).toContain("Cada etapa precisa de pelo menos uma coluna.");
  });

  test("the task's column picker moves it (keyboard way); grouped by stage", async () => {
    const { api } = await go("issues");
    await api.issues.addColumn(ORG_ID, { name: "Esta semana", stage: "todo" });
    await click(screen().getByRole("link", { name: "#131 Confirmação do agendamento por WhatsApp" }));
    await settle(6);
    const dialog = screen().getByRole("dialog", { name: "Confirmação do agendamento por WhatsApp" });
    await pick(within(dialog).getByRole("combobox", { name: "Coluna" }), "Esta semana");
    await settle(4);
    const moved = await api.issues.get(ORG_ID, 131);
    const week = (await api.issues.columns(ORG_ID)).find((c) => c.name === "Esta semana");
    expect(moved.columnId).toBe(week?.id ?? "");
    expect(moved.status).toBe("todo");
  });
});

describe("Issue detail", () => {
  test("source, description, criteria with progress, its fields as one strip under who made it", async () => {
    await go("issues/131");
    expect(screen().getByRole("heading", { level: 1, name: "Confirmação do agendamento por WhatsApp" })).toBeTruthy();
    expect(screen().getByText(/#131 · criada por João/).textContent).toContain("a partir de uma mensagem no #eng");
    expect(screen().getByRole("link", { name: "uma mensagem no #eng" })).toBeTruthy();
    const criteria = screen().getByRole("region", { name: "Critérios de aceite" });
    expect(criteria.textContent).toContain("0 de 4");
    await click(within(criteria).getByLabelText("Paciente sem WhatsApp recebe SMS"));
    await settle(4);
    expect(screen().getByRole("region", { name: "Critérios de aceite" }).textContent).toContain("1 de 4");
    const strip = screen().getByRole("group", { name: "Detalhes da tarefa" });
    expect(within(strip).getByRole("combobox", { name: "Coluna" }).textContent).toContain("A fazer");
    expect(within(strip).getByRole("combobox", { name: "Prioridade" }).textContent).toContain("Alta");
    expect(strip.textContent).toContain("agendamento");
    // "Ver no calendário" went from under the field to the date's own popover.
    await click(within(strip).getByRole("button", { name: "Prazo" }));
    expect(screen().getByRole("link", { name: "Ver no calendário" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/calendar`,
    );
  });

  test("at every width the fields are one strip under who made it, in the order Coluna, Responsável, Prioridade, Prazo, Quem vê", async () => {
    await go("issues/131");
    // No side column, however wide the window.
    expect(screen().queryByRole("complementary", { name: "Detalhes da tarefa" })).toBeNull();
    expect(document.querySelector(".issue-aside, .issue-layout")).toBeNull();
    const strip = screen().getByRole("group", { name: "Detalhes da tarefa" });
    expect(strip.classList.contains("ac-props")).toBe(true);
    // Under "Criada por", over the tabs.
    expect(strip.previousElementSibling?.classList.contains("issue-details__head")).toBe(true);
    expect(strip.nextElementSibling?.querySelector('[role="tablist"]')).toBeTruthy();
    expect([...strip.querySelectorAll(".issue-prop")].map((p) => p.getAttribute("title"))).toEqual([
      "Coluna",
      "Responsável",
      "Prioridade",
      "Prazo",
      "Quem vê",
    ]);
    // A face in Responsável, the stage's mark in Coluna, the priority's in Prioridade.
    expect(within(strip).getByRole("combobox", { name: "Responsável" }).querySelector(".ac-avatar")).toBeTruthy();
    expect(within(strip).getByRole("combobox", { name: "Coluna" }).querySelector(".ac-icon")).toBeTruthy();
    expect(within(strip).getByRole("combobox", { name: "Prioridade" }).querySelector(".ac-icon")).toBeTruthy();
    // Then a hairline, its labels and "GitHub" to link one.
    expect(strip.querySelector(".ac-props__sep")).toBeTruthy();
    expect(within(strip).getByRole("button", { name: "Adicionar link do GitHub" }).textContent).toBe("GitHub");
  });

  test("Coluna never shows an empty box: the task's stage until the board's columns come, then its column", async () => {
    const api = createFakeApi(seedState());
    const columns = api.issues.columns;
    let release: () => void = () => {};
    const held = new Promise<void>((done) => {
      release = done;
    });
    api.issues.columns = async (orgId) => {
      await held;
      return columns(orgId);
    };
    await go("issues/129", api);
    const coluna = () =>
      within(screen().getByRole("group", { name: "Detalhes da tarefa" })).getByRole("combobox", { name: "Coluna" });
    expect(coluna().textContent).toBe("Em andamento");
    await act(async () => release());
    await settle(6);
    expect(coluna().textContent).toBe("Em andamento");
    expect(coluna().hasAttribute("data-placeholder")).toBe(false);
  });

  test("on the plain board Coluna lists the columns alone: each is its stage, never its stage's name over it again", async () => {
    await go("issues/131");
    const coluna = within(screen().getByRole("group", { name: "Detalhes da tarefa" })).getByRole("combobox", {
      name: "Coluna",
    });
    coluna.focus();
    await key(coluna, "Enter");
    const list = screen().getByRole("listbox");
    expect(within(list).getByRole("option", { name: "Em andamento" })).toBeTruthy();
    expect(list.querySelector(".ac-menu__heading")).toBeNull();
  });

  test("title, description and criteria are edited where they are; leaving the field saves (Salvo)", async () => {
    const { api } = await go("issues/131");
    await click(screen().getByRole("heading", { level: 1, name: "Confirmação do agendamento por WhatsApp" }));
    const title = screen().getByRole("textbox", { name: "Título" });
    await type(title, "Confirmação por WhatsApp e SMS");
    await act(async () => fireEvent.blur(title));
    await settle(4);
    expect((await api.issues.get(ORG_ID, 131)).title).toBe("Confirmação por WhatsApp e SMS");
    expect(screen().getByRole("heading", { level: 1, name: "Confirmação por WhatsApp e SMS" })).toBeTruthy();
    expect(screen().getByText("Salvo")).toBeTruthy();

    await click(screen().getByRole("button", { name: "Editar a descrição" }));
    const description = screen().getByRole("textbox", { name: "Descrição" });
    await type(description, "Mandar a confirmação 24 h antes da consulta.");
    await act(async () => fireEvent.blur(description));
    await settle(4);
    expect((await api.issues.get(ORG_ID, 131)).description).toBe("Mandar a confirmação 24 h antes da consulta.");

    const criteria = () => screen().getByRole("region", { name: "Critérios de aceite" });
    await click(
      within(criteria()).getByRole("button", { name: 'Editar o critério "Paciente sem WhatsApp recebe SMS"' }),
    );
    const row = within(criteria()).getByRole("textbox", { name: "Critérios de aceite" });
    await type(row, "Paciente sem WhatsApp recebe um SMS");
    await act(async () => fireEvent.blur(row));
    await settle(4);
    const add = within(criteria()).getByRole("textbox", { name: "Adicionar critério" });
    await type(add, "Funciona no fim de semana");
    await key(add, "Enter");
    await settle(4);
    const saved = await api.issues.get(ORG_ID, 131);
    expect(saved.criteria).toHaveLength(5);
    expect(saved.criteria.map((c) => c.text)).toContain("Paciente sem WhatsApp recebe um SMS");
    expect(saved.criteria.at(-1)?.text).toBe("Funciona no fim de semana");
    expect(criteria().textContent).toContain("0 de 5");
  });

  test("in the dialog: the task's page at full height; Esc in the title being edited saves it and stays", async () => {
    const { api } = await go("issues?open=131");
    const dialog = screen().getByRole("dialog", { name: "Confirmação do agendamento por WhatsApp" });
    expect(dialog.className).toContain("ac-details--fill");
    expect(
      within(dialog).getByRole("heading", { level: 1, name: "Confirmação do agendamento por WhatsApp" }),
    ).toBeTruthy();
    expect(within(dialog).getByText(/^Criada por João/)).toBeTruthy();
    // "#131" and the title on one row, on the bar that never scrolls; "Criada por…" under it, in the body.
    const bar = dialog.querySelector(".ac-details__bar") as HTMLElement;
    const row = bar.querySelector(".issue-bartitle") as HTMLElement;
    expect(row.firstElementChild?.textContent).toBe("#131");
    expect(within(row).getByRole("heading", { level: 1 }).textContent).toBe("Confirmação do agendamento por WhatsApp");
    expect(dialog.querySelectorAll(".issue-details__title")).toHaveLength(1);
    expect(bar.textContent).not.toContain("Criada por");
    await click(within(dialog).getByRole("button", { name: "Editar o título" }));
    const title = within(dialog).getByRole("textbox", { name: "Título" });
    await type(title, "Confirmação por WhatsApp");
    await act(async () => fireEvent.keyDown(title, { key: "Escape" }));
    await settle(4);
    expect(screen().getByRole("dialog")).toBeTruthy();
    expect((await api.issues.get(ORG_ID, 131)).title).toBe("Confirmação por WhatsApp");
  });

  test("Pedir à Ada: assigns the agent, moves to Em andamento and logs it", async () => {
    await go("issues/131");
    const ask = screen().getByRole("region", { name: "Pedir a um agente" });
    expect(ask.textContent).toContain("Pedir à Ada para fazer esta tarefa");
    expect(ask.textContent).toContain("A Ada lê o que precisa, comenta o plano aqui e faz.");
    await click(within(ask).getByRole("button", { name: "Pedir à Ada" }));
    await settle(6);
    expect(screen().queryByRole("region", { name: "Pedir a um agente" })).toBeNull();
    const aside = screen().getByRole("group", { name: "Detalhes da tarefa" });
    expect(within(aside).getByRole("combobox", { name: "Coluna" }).textContent).toContain("Em andamento");
    expect(within(aside).getByRole("combobox", { name: "Responsável" }).textContent).toContain("Ada");
    await tab("Histórico");
    expect(screen().getByRole("region", { name: "Histórico" }).textContent).toContain("Walter pediu a Ada para fazer");
  });

  test("change the status: the history says it", async () => {
    await go("issues/131");
    const aside = screen().getByRole("group", { name: "Detalhes da tarefa" });
    await pick(within(aside).getByRole("combobox", { name: "Coluna" }), "Em revisão");
    await settle(4);
    await tab("Histórico");
    expect(screen().getByRole("region", { name: "Histórico" }).textContent).toContain("mudou o status para Em revisão");
  });

  test("the conversation (variant B): Conversa in the bar's ⋯ opens the thread panel beside the details, chat's own box", async () => {
    const { api } = await go("issues?open=131");
    const dialog = screen().getByRole("dialog", { name: "Confirmação do agendamento por WhatsApp" });
    // Where Discussão was: one line that opens it.
    const summary = within(dialog).getByRole("button", { name: /Conversar sobre a tarefa/ });
    expect(summary).toBeTruthy();
    const more = within(dialog).getByRole("button", { name: "Mais opções" });
    more.focus();
    await key(more, "Enter");
    await click(within(screen().getByRole("menu")).getByRole("menuitem", { name: "Conversa" }));
    await settle(6);
    expect(dialog.className).toContain("ac-details--side");
    expect(within(dialog).getByRole("heading", { name: "Conversa da tarefa" })).toBeTruthy();
    // The chat's composer, never locked while sending; the message shows in the panel, oldest first.
    const box = within(dialog).getByRole("combobox", { name: "Comentar na tarefa · use @ para chamar um agente" });
    await type(box, "Começo amanhã.");
    await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
    await settle(5);
    expect((box as HTMLTextAreaElement).disabled).toBe(false);
    const at = (await api.issues.get(ORG_ID, 131)).conversation;
    expect(at).toBeTruthy();
    const posted = (await api.chat.messages(ORG_ID, at?.channelId ?? "", { threadId: at?.rootId })).map((m) => m.body);
    expect(posted.at(-1)).toBe("Começo amanhã.");
    expect(within(dialog).getByText("Começo amanhã.")).toBeTruthy();
    // Its root stands for the task: never drawn in the panel.
    expect(within(dialog).queryByText(/^Task #131/)).toBeNull();
    // Closing the panel gives the details their width back.
    await click(within(dialog).getByRole("button", { name: "Fechar a conversa" }));
    expect(dialog.className).not.toContain("ac-details--side");
  });

  test("a card with a conversation counts its messages among its facts; a turn live in it is the card's one state", async () => {
    const api = createFakeApi(seedState());
    const list = api.issues.list;
    const conversation = {
      channelId: "task_c",
      rootId: "root_r",
      count: 6,
      lastAt: new Date().toISOString(),
      participants: [
        { type: "person" as const, id: "u-joao" },
        { type: "agent" as const, id: ADA_ID },
      ],
      working: true,
    };
    api.issues.list = async (orgId, filters) =>
      (await list(orgId, filters)).map((i) => (i.number === 131 ? { ...i, conversation } : i));
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      await go("issues", api);
      expect(logged.mock.calls.some((c) => String(c[0]).includes('unique "key"'))).toBe(false);
    } finally {
      logged.mockRestore();
    }
    const card = document.querySelector('[data-card="131"]') as HTMLElement;
    expect(card.querySelector('.ac-factline__fact[title="6 mensagens"]')?.textContent).toBe("6");
    expect(card.querySelector(".issue-card__state")?.textContent).toBe("Trabalhando");
    // The faces and the time of the old thread line live in the task's details now.
    expect(card.querySelector(".thread-line")).toBeNull();
    expect(document.querySelector('[data-card="132"] .ac-factline__fact[title$="mensagens"]')).toBeNull();
  });

  test("a link with a message opens the task's conversation at it", async () => {
    const api = createFakeApi(seedState());
    const at = await api.issues.conversation(ORG_ID, (await api.issues.get(ORG_ID, 131)).id);
    const said = await api.chat.post(ORG_ID, at.channelId, { body: "Olhem isto", threadId: at.rootId });
    await go(`issues/131?m=${said.id}`, api);
    expect(screen().getByRole("complementary", { name: "Conversa da tarefa" })).toBeTruthy();
    expect(screen().getByText("Olhem isto")).toBeTruthy();
  });

  test("a missing issue says so", async () => {
    await go("issues/999");
    expect(screen().getByText("Esta tarefa não existe ou você não tem acesso.")).toBeTruthy();
  });

  test("the agent's work: the same step in a row once with how many; a refused command says so", async () => {
    const api = createFakeApi(seedState());
    const get = api.issues.get;
    const step = (detail: string, minutes: number, outcome?: "refused") => ({
      tool: "permission_prompt",
      detail,
      at: new Date(Date.now() - minutes * 60_000).toISOString(),
      ...(outcome ? { outcome } : {}),
    });
    api.issues.get = async (orgId, number) => {
      const issue = await get(orgId, number);
      if (!issue.work) return issue;
      const steps = [3, 2, 1].map((m) => step("Run the unit tests", m)).concat(step("rm /etc/agentes", 0, "refused"));
      return { ...issue, work: { ...issue.work, steps } };
    };
    await go("issues/129", api);
    const lines = [...document.querySelectorAll(".issue-work__steps li")];
    // Each line: its mark, its words, its time.
    expect(lines.map((li) => li.children[1]?.textContent)).toEqual([
      "Rodou: Run the unit tests ×3",
      "Recusado: rm /etc/agentes",
    ]);
  });
});

describe("Rotinas", () => {
  test("rows with agent, target, schedule, next and last run; no money", async () => {
    await go("routines");
    const weekly = screen().getByRole("article", { name: "Resumo da semana" });
    expect(weekly.textContent).toContain("entrega em #eng");
    expect(weekly.textContent).toContain("Toda semana, seg, às 09:00");
    expect(weekly.textContent).toMatch(/Próxima/);
    // No money on the rows.
    expect(weekly.textContent).not.toContain("US$");
    // The last runs as a pixel strip, said in words.
    expect(within(weekly).getByRole("img", { name: /^(Últimas execuções|Nenhuma execução)/ })).toBeTruthy();
    const pr = screen().getByRole("article", { name: "Revisar PR aberto" });
    expect(pr.textContent).toContain("PR aberto no GitHub");
    expect(pr.textContent).toMatch(/Espera/);
    // My own zone isn't repeated on the row.
    expect(weekly.textContent).not.toContain("Brasília");
    expect(within(weekly).getByRole("switch", { name: "Ativa: Resumo da semana" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    const monthly = screen().getByRole("article", { name: "Relatório mensal de reviews" });
    expect(monthly.getAttribute("data-paused")).toBe("true");
    expect(within(monthly).getByText("Pausada")).toBeTruthy();
    expect(within(monthly).queryByRole("checkbox")).toBeNull();
    // The horizon: one lane per scheduled, active routine.
    expect(screen().getByRole("region", { name: "Próximas horas" })).toBeTruthy();
  });

  test("pause with the switch, run now, stop, and see runs in the details", async () => {
    await go("routines");
    const weekly = () => screen().getByRole("article", { name: "Resumo da semana" });
    await click(within(weekly()).getByRole("switch", { name: "Ativa: Resumo da semana" }));
    await settle(5);
    expect(weekly().getAttribute("data-paused")).toBe("true");
    expect(within(weekly()).getByText("Pausada")).toBeTruthy();
    expect(screen().getByText(/Rotina pausada\./)).toBeTruthy();
    await click(within(weekly()).getByRole("switch", { name: "Ativa: Resumo da semana" }));
    await settle(5);
    expect(weekly().hasAttribute("data-paused")).toBe(false);
    const run = within(weekly()).getByRole("button", { name: "Rodar agora" });
    expect(run.getAttribute("title")).toBe("Rodar agora");
    await click(run);
    await settle(4);
    // Running: "Parar" takes the place of "Rodar agora", and stops it quietly.
    expect(weekly().getAttribute("data-state")).toBe("running");
    await click(within(weekly()).getByRole("button", { name: "Parar Resumo da semana" }));
    await settle(4);
    expect(screen().getByText("Execução parada.")).toBeTruthy();
    expect(weekly().getAttribute("data-state")).toBe("active");
    // The title opens the details: what it does, when, where, and the run history in plain words.
    await click(within(weekly()).getByRole("button", { name: "Resumo da semana" }));
    await settle(4);
    const details = screen().getByRole("dialog", { name: "Resumo da semana" });
    expect(details.textContent).toContain("Resuma o que");
    // The runs are their own tab (Radix tabs switch on mouse down).
    await act(async () => fireEvent.mouseDown(within(details).getByRole("tab", { name: /^Execuções/ }), { button: 0 }));
    await settle(2);
    expect(details.textContent).toContain("Parada por");
    expect(details.textContent).toContain("O orçamento do mês acabou");
    expect(details.textContent).toContain("Contou o que achou");
    expect(details.textContent).toContain("Resumo postado no canal");
    await click(within(details).getByRole("button", { name: "Fechar detalhes" }));
    expect(screen().queryByRole("dialog", { name: "Resumo da semana" })).toBeNull();
  });

  test("Nova rotina: natural-language schedule is parsed before creating", async () => {
    await go("routines");
    await click(screen().getByRole("button", { name: "Nova rotina" }));
    const dialog = screen().getByRole("dialog", { name: "Nova rotina" });
    await settle(4);
    expect(dialog.textContent).toContain("Toda semana, seg, às 09:00");
    // The zone has its own select, so the person can change it.
    expect(within(dialog).getByRole("combobox", { name: "Fuso horário" }).textContent).toContain(
      "Horário de Brasília · UTC−3",
    );
    await type(within(dialog).getByLabelText("Frequência"), "quando der");
    await settle(4);
    expect(dialog.textContent).toContain("Não entendi.");
    expect(within(dialog).getByRole("button", { name: "Criar rotina" }).hasAttribute("disabled")).toBe(true);
    await type(within(dialog).getByLabelText("Frequência"), "dias úteis às 8h30");
    await settle(4);
    expect(dialog.textContent).toContain("De segunda a sexta, às 08:30");
    await click(within(dialog).getByRole("button", { name: "Criar rotina" }));
    expect(dialog.textContent).toContain("Diga o que o agente deve fazer.");
    await type(within(dialog).getByLabelText("O que fazer"), "Liste os PRs abertos há mais de 2 dias.");
    await type(within(dialog).getByLabelText("Nome (opcional)"), "PRs parados");
    await click(within(dialog).getByRole("button", { name: "Criar rotina" }));
    await settle(5);
    const card = screen().getByRole("article", { name: "PRs parados" });
    expect(card.textContent).toContain("De segunda a sexta, às 08:30");
    expect(card.textContent).toContain("Ainda não rodou");
  });

  test("Nova rotina: a template from one search fills the form, and all of it stays editable", async () => {
    const { api } = await go("routines");
    await click(screen().getByRole("button", { name: "Nova rotina" }));
    const dialog = screen().getByRole("dialog", { name: "Nova rotina" });
    await settle(4);
    const select = within(dialog).getByRole("combobox", { name: "Começar de um modelo" });
    expect(select.textContent).toContain("Escolher um modelo");
    select.focus();
    await key(select, "Enter");
    await settle(3);
    // Sections by area, plain work first; PRs live under Tecnologia, the last one.
    const groups = within(screen().getByRole("listbox"))
      .getAllByRole("group")
      .map((g) => g.getAttribute("aria-label"));
    expect(groups[0]).toBe("Equipe e rotina do dia");
    expect(groups.at(-1)).toBe("Tecnologia");
    const search = screen().getByRole("combobox", { name: "Buscar modelos" });
    await type(search, "sentry");
    const found = within(screen().getByRole("listbox")).getAllByRole("option");
    expect(found.map((o) => o.textContent)).toEqual([expect.stringContaining("Vigiar erros novos")]);
    expect(found[0]?.textContent).toContain("Precisa deste app: Sentry");
    await type(search, "fechamento semana");
    await click(within(screen().getByRole("listbox")).getByRole("option", { name: /Fechamento da semana/ }));
    await settle(4);
    expect((within(dialog).getByLabelText("O que fazer") as HTMLTextAreaElement).value).toContain("Resuma a semana");
    expect((within(dialog).getByLabelText("Nome (opcional)") as HTMLInputElement).value).toBe("Fechamento da semana");
    expect(dialog.textContent).toContain("Toda semana, sex, às 17:00");
    expect(within(dialog).getByRole("radio", { name: "Toda vez" }).getAttribute("aria-checked")).toBe("true");
    expect(select.textContent).toContain("Fechamento da semana");
    await type(within(dialog).getByLabelText("Nome (opcional)"), "Sexta da equipe");
    await click(within(dialog).getByRole("button", { name: "Criar rotina" }));
    await settle(5);
    const card = screen().getByRole("article", { name: "Sexta da equipe" });
    expect(card.textContent).toContain("Toda semana, sex, às 17:00");
    const made = (await api.routines.list(ORG_ID)).find((r) => r.name === "Sexta da equipe");
    expect(made?.report).toBe("always");
  });

  test("Nova rotina: a template's app says so once picked, with a way to connect one not connected", async () => {
    await go("routines");
    await click(screen().getByRole("button", { name: "Nova rotina" }));
    const dialog = screen().getByRole("dialog", { name: "Nova rotina" });
    await settle(4);
    await pick(within(dialog).getByRole("combobox", { name: "Começar de um modelo" }), /Vigiar erros novos/);
    expect(dialog.textContent).toContain("Precisa deste app: Sentry");
    expect(dialog.textContent).toContain("A cada hora");
    // The fake workspace has Sentry on neither list, so its page is one click away.
    expect(within(dialog).getByRole("link", { name: "Abrir Conectores" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/settings/connectors`,
    );
    await pick(within(dialog).getByRole("combobox", { name: "Começar de um modelo" }), /Resumo diário de um canal/);
    expect(dialog.textContent).not.toContain("Precisa deste app");
    expect(dialog.textContent).toContain("De segunda a sexta, às 09:00");
    await pick(within(dialog).getByRole("combobox", { name: "Começar de um modelo" }), /Organizar tarefas novas/);
    expect(within(dialog).getByRole("radio", { name: "Evento" }).getAttribute("aria-checked")).toBe("true");
    expect(within(dialog).getByRole("combobox", { name: "Evento" }).textContent).toContain("Tarefa criada no agentes");
    // A mailbox is the email trigger's own: the workspace has none, so its note and its link say what to do.
    await pick(within(dialog).getByRole("combobox", { name: "Começar de um modelo" }), /Preparar respostas de email/);
    expect(within(dialog).getByRole("radio", { name: "Email" }).getAttribute("aria-checked")).toBe("true");
    expect(dialog.textContent).toContain("Conecte uma caixa de email em Conectores primeiro.");
    expect(within(dialog).getByRole("button", { name: "Criar rotina" }).hasAttribute("disabled")).toBe(true);
  });

  test("Nova rotina: a template never writes over the person's words unasked", async () => {
    await go("routines");
    await click(screen().getByRole("button", { name: "Nova rotina" }));
    const dialog = screen().getByRole("dialog", { name: "Nova rotina" });
    await settle(4);
    const what = within(dialog).getByLabelText("O que fazer") as HTMLTextAreaElement;
    const select = () => within(dialog).getByRole("combobox", { name: "Começar de um modelo" });
    await type(what, "Minhas palavras");
    await pick(select(), /Plano do dia/);
    const ask = screen().getByRole("dialog", { name: "Trocar o que você escreveu por este modelo?" });
    await click(within(ask).getByRole("button", { name: "Cancelar" }));
    await settle(2);
    expect(what.value).toBe("Minhas palavras");
    expect(select().textContent).toContain("Escolher um modelo");
    await pick(select(), /Plano do dia/);
    await click(
      within(screen().getByRole("dialog", { name: /Trocar o que você escreveu/ })).getByRole("button", {
        name: "Trocar",
      }),
    );
    await settle(2);
    expect(what.value).toContain("Liste as tarefas abertas");
    // Untouched, it changes for another with nothing to ask.
    await pick(select(), /Tarefas atrasadas/);
    expect(screen().queryByRole("dialog", { name: /Trocar o que você escreveu/ })).toBeNull();
    expect(what.value).toContain("prazo vencido");
  });

  test("Nova rotina: a template's part in brackets holds the routine back, and says so", async () => {
    const { api } = await go("routines");
    await click(screen().getByRole("button", { name: "Nova rotina" }));
    const dialog = screen().getByRole("dialog", { name: "Nova rotina" });
    await settle(4);
    await pick(within(dialog).getByRole("combobox", { name: "Começar de um modelo" }), /Vigiar uma página/);
    const before = (await api.routines.list(ORG_ID)).length;
    await click(within(dialog).getByRole("button", { name: "Criar rotina" }));
    await settle(3);
    expect(dialog.textContent).toContain("Troque o texto entre parênteses primeiro.");
    expect((await api.routines.list(ORG_ID)).length).toBe(before);
    await type(within(dialog).getByLabelText("O que fazer"), "Abra exemplo.com e diga se o preço mudou.");
    await click(within(dialog).getByRole("button", { name: "Criar rotina" }));
    await settle(5);
    expect((await api.routines.list(ORG_ID)).length).toBe(before + 1);
  });

  test("Nova rotina: the search finds templates by words of their instructions, without accents", async () => {
    await go("routines");
    await click(screen().getByRole("button", { name: "Nova rotina" }));
    const dialog = screen().getByRole("dialog", { name: "Nova rotina" });
    await settle(4);
    const select = within(dialog).getByRole("combobox", { name: "Começar de um modelo" });
    select.focus();
    await key(select, "Enter");
    await settle(3);
    const search = screen().getByRole("combobox", { name: "Buscar modelos" });
    const found = () =>
      within(screen().getByRole("listbox"))
        .queryAllByRole("option")
        .map((o) => o.textContent ?? "");
    await type(search, "reunioes");
    expect(found()).toEqual([expect.stringContaining("Plano do dia")]);
    await type(search, "CONCORRENCIA");
    expect(found()).toEqual([expect.stringContaining("De olho na concorrência")]);
    await type(search, "sem resultado aqui");
    expect(found()).toEqual([]);
    expect(screen().getByRole("listbox").textContent).toContain("Nenhum modelo encontrado");
  });

  test("Nova rotina: the templates work from the keyboard alone, and Esc leaves the form open", async () => {
    await go("routines");
    await click(screen().getByRole("button", { name: "Nova rotina" }));
    const dialog = screen().getByRole("dialog", { name: "Nova rotina" });
    await settle(4);
    const select = within(dialog).getByRole("combobox", { name: "Começar de um modelo" });
    select.focus();
    await key(select, "Enter");
    await settle(3);
    const search = screen().getByRole("combobox", { name: "Buscar modelos" });
    await key(search, "Escape");
    await settle(3);
    expect(screen().queryByRole("listbox")).toBeNull();
    expect(screen().getByRole("dialog", { name: "Nova rotina" })).toBe(dialog);
    await key(select, "ArrowDown");
    await settle(3);
    const again = screen().getByRole("combobox", { name: "Buscar modelos" });
    await type(again, "pagamento");
    await key(again, "ArrowDown");
    await key(again, "Enter");
    await settle(4);
    expect(screen().queryByRole("listbox")).toBeNull();
    expect((within(dialog).getByLabelText("Nome (opcional)") as HTMLInputElement).value).not.toBe("");
    expect(select.textContent).not.toContain("Escolher um modelo");
  });

  test("an event-driven routine", async () => {
    await go("routines");
    await click(screen().getByRole("button", { name: "Nova rotina" }));
    const dialog = screen().getByRole("dialog", { name: "Nova rotina" });
    await click(within(dialog).getByRole("radio", { name: "Evento" }));
    // Where events come from: the Event field's ⓘ, which also describes the select.
    const about = within(dialog).getByRole("button", { name: "Sobre Evento" });
    expect(document.getElementById(about.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "Vem pelos conectores da Acme. O agente recebe o evento como contexto.",
    );
    await pick(within(dialog).getByRole("combobox", { name: "Evento" }), "Deploy concluído");
    await type(within(dialog).getByLabelText("O que fazer"), "Confira os erros depois do deploy.");
    await click(within(dialog).getByRole("button", { name: "Criar rotina" }));
    await settle(5);
    expect(
      screen()
        .getAllByRole("article")
        .some((a) => a.textContent?.includes("Deploy concluído")),
    ).toBe(true);
  });
});

describe("Calendário", () => {
  const openPanel = async () => {
    const show = screen().queryByRole("button", { name: "Mostrar painel" });
    if (show) await click(show);
  };
  test("week of 7 days with events, routine runs and issue due dates; filter chips hide them", async () => {
    const api = createFakeApi(seedState());
    const monday = mondayOf(new Date());
    await api.issues.create(ORG_ID, { title: "Fechar a release", dueDate: toYmd(monday) });
    await go("calendar", api);
    expect(screen().getByRole("heading", { level: 1, name: "Calendário" })).toBeTruthy();
    expect(document.querySelectorAll(".cal-week__col")).toHaveLength(7);
    expect(screen().getByRole("button", { name: "Daily de produto, 10:00–11:00" })).toBeTruthy();
    expect(screen().getAllByRole("button", { name: "Rotina Erros do Sentry do dia, 18:00" })).toHaveLength(5);
    expect(screen().getByRole("button", { name: "#133 Fechar a release, dia todo" })).toBeTruthy();
    // A routine's run is a row at its time with its agent's face and name, never a pixel dot; a click opens it.
    const routine = screen().getByRole("button", { name: "Rotina Resumo da semana, 09:00" });
    expect(routine.classList.contains("cal-chip--run")).toBe(true);
    expect(routine.querySelector(".ac-run-mark")).toBeNull();
    expect(routine.querySelector(".cal-chip__title")?.textContent).toBe("Resumo da semana");
    await click(routine);
    await settle(2);
    const runs = screen().getByRole("region", { name: "Resumo da semana" });
    expect(runs.querySelector(".cal-details__owner")?.textContent).toBe("Atlas · Ops");
    expect(runs.textContent).toContain("última: respondeu");
    expect(within(runs).getByRole("link", { name: "Abrir rotina" }).getAttribute("href")).toContain("?open=");
    await act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
    await settle(2);

    await openPanel();
    const filters = screen().getByRole("group", { name: "Filtros" });
    await click(within(filters).getByRole("button", { name: /^Rotinas/ }));
    expect(screen().queryByRole("button", { name: /Resumo da semana/ })).toBeNull();
    await click(within(filters).getByRole("button", { name: /^Prazos de tarefas/ }));
    expect(screen().queryByRole("button", { name: /Fechar a release/ })).toBeNull();
    expect(screen().getByRole("button", { name: "Daily de produto, 10:00–11:00" })).toBeTruthy();
    // "Dias úteis": Monday to Friday only.
    await click(screen().getByRole("button", { name: "Dias úteis" }));
    expect(document.querySelectorAll(".cal-week__col")).toHaveLength(5);
  });

  test("an event opens its details in a popover; an agent's proposal is confirmed by a person", async () => {
    await go("calendar");
    await click(screen().getByRole("button", { name: "Daily de produto, 10:00–11:00" }));
    await settle(2);
    const details = screen().getByRole("region", { name: "Daily de produto" });
    // Whose it is, first: who made it, their face and name.
    const owner = details.firstElementChild as HTMLElement;
    expect(owner.querySelector(".ac-who > .ac-avatar")?.getAttribute("data-kind")).toBe("person");
    expect(owner.querySelector(".ac-who > b")?.textContent).toBe("Walter");
    expect(within(details).getByRole("button", { name: "Editar" })).toBeTruthy();
    await act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
    await settle(2);
    await openPanel();
    const side = screen().getByRole("complementary", { name: "Painel do calendário" });
    // Who sends invitations is background (the approvals help page), not a note in the panel.
    expect(side.textContent).not.toContain("Agentes só propõem horários.");
    const proposal = within(side).getByRole("group", { name: "Proposta de evento" });
    expect(proposal.textContent).toContain("Revisão do roadmap");
    expect(proposal.textContent).toContain("livre para todos");
    // Each person once.
    expect(proposal.textContent).toContain(" · Walter e João · ");
    await click(within(proposal).getByRole("button", { name: "Confirmar e convidar" }));
    await settle(5);
    expect(screen().getByText("Evento criado e convites enviados.")).toBeTruthy();
    expect(screen().getByRole("button", { name: "Revisão do roadmap, 15:00–15:45" })).toBeTruthy();
  });
});

describe("sidebar", () => {
  test("Issues, Rotinas and Calendário are in the workspace navigation", async () => {
    await go("issues");
    const nav = screen().getByRole("navigation", { name: "Navegação do workspace" });
    for (const [name, path] of [
      ["Tarefas", "issues"],
      ["Rotinas", "routines"],
      ["Calendário", "calendar"],
    ]) {
      expect(within(nav).getByRole("link", { name }).getAttribute("href")).toBe(`/org/${ORG_ID}/${path}`);
    }
  });
});

describe("planning helpers", () => {
  test("the mock's schedule table and next runs", () => {
    expect(parseSchedulePhrase("toda segunda às 9h")).toMatchObject({ ok: true, cron: "0 9 * * 1" });
    expect(parseSchedulePhrase("dias úteis às 18h")).toMatchObject({ ok: true, cron: "0 18 * * 1-5" });
    expect(parseSchedulePhrase("dia 1 às 8h")).toMatchObject({ ok: true, cron: "0 8 1 * *" });
    expect(parseSchedulePhrase("")).toMatchObject({ ok: false });
    expect(parseSchedulePhrase("quando der")).toMatchObject({ ok: false });
    const wed = new Date(2026, 9, 14, 12, 0);
    expect(nextCronRun("0 9 * * 1", wed)?.toDateString()).toBe(new Date(2026, 9, 19).toDateString());
    expect(nextCronRun("0 18 * * 1-5", wed)?.getHours()).toBe(18);
  });

  test("criteria come from list lines", () => {
    expect(splitCriteria("Contexto.\n- um\n* dois\n[ ] três")).toEqual({
      description: "Contexto.",
      criteria: ["um", "dois", "três"],
    });
  });
});

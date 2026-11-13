import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Issue, IssuesView } from "@agenteschat/client";
import { ISSUES_VIEW_DEFAULT } from "@agenteschat/client/lib/issues-view";
import { box, place } from "@agenteschat/ui/testing";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const view = (over: Partial<IssuesView>): IssuesView => ({ ...structuredClone(ISSUES_VIEW_DEFAULT), ...over });
const go = async (state = seedState(), api = createFakeApi(state)) => {
  const r = await renderApp(`/org/${ORG_ID}/issues`, { api });
  await settle(8);
  return { ...r, api, state };
};
const column = (name: string) => screen().getByRole("region", { name });
// The title after its number ("#131 Confirmação…" on one row).
const cardTitles = (el: HTMLElement) =>
  Array.from(el.querySelectorAll(".issue-card__title")).map((x) => x.textContent?.replace(/^#\d+ /, ""));
const cardOf = (number: number) => document.querySelector<HTMLElement>(`[data-card="${number}"]`) as HTMLElement;
const toast = () => document.querySelector(".ac-toast")?.textContent ?? "";
const live = () => document.querySelector(".issues-body [aria-live]")?.textContent ?? "";

/** happy-dom lays nothing out: each column a box side by side, its cards stacked inside, 90px apart. */
function layBoard() {
  const cols = [...document.querySelectorAll<HTMLElement>("[data-col]")];
  cols.forEach((col, k) => {
    const left = 40 + k * 260;
    place(col, box(left, 200, 250, 600));
    for (const [j, slot] of [...col.querySelectorAll<HTMLElement>("[data-slot]")].entries())
      place(slot, box(left + 8, 240 + j * 90, 234, 80));
  });
  return cols.map((c) => c.getAttribute("aria-label"));
}

const at = (x: number, y: number) => ({ clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: "mouse" });
/** A mouse press on the card, a move past the slop (it lifts), then on to the point. */
async function drag(card: HTMLElement, x: number, y: number) {
  await act(async () => {
    fireEvent.pointerDown(card, at(60, 250));
    fireEvent.pointerMove(document, at(70, 262));
    fireEvent.pointerMove(document, at(x, y));
  });
  await settle(2);
}
const drop = async (x: number, y: number) => {
  await act(async () => fireEvent.pointerUp(document, at(x, y)));
  await settle(6);
};
const press = async (k: string, el: Element = document.activeElement ?? document.body) => {
  await act(async () => fireEvent.keyDown(el, { key: k }));
  await settle(3);
};

describe("Tarefas: how I left it", () => {
  test("Exibição keeps layout, grouping, fields and canceled ones; they come back, the search doesn't", async () => {
    const state = seedState();
    const { api } = await go(state);
    const trigger = screen().getByRole("button", { name: "Exibição: Quadro · Etapa" });
    await click(trigger);
    await settle(2);
    const dialog = screen().getByRole("dialog", { name: "Exibição" });
    expect(within(dialog).getByRole("button", { name: "Quadro" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(dialog).queryByRole("button", { name: "Voltar ao padrão" })).toBeNull();
    expect(dialog.textContent).toContain("Salvo para você neste workspace");
    await click(within(dialog).getByRole("button", { name: "Lista" }));
    const groupBy = within(dialog).getByRole("radiogroup", { name: "Agrupar por" });
    await click(within(groupBy).getByRole("radio", { name: "Prioridade" }));
    await click(within(dialog).getByRole("button", { name: "Prazo" }));
    await click(within(dialog).getByRole("switch", { name: "Mostrar canceladas" }));
    await settle(5);
    expect(within(dialog).getByRole("button", { name: "Voltar ao padrão" })).toBeTruthy();
    const fields = { ...ISSUES_VIEW_DEFAULT.fields, due: false };
    expect(state.issuesView).toEqual(view({ layout: "list", group: "priority", showCanceled: true, fields }));
    // Grouped by priority in the list, without the due dates.
    expect(screen().getByRole("region", { name: "Alta" }).textContent).toContain("#131");
    expect(screen().getByRole("region", { name: "Normal" }).textContent).toContain("#132");
    expect(document.querySelector('.ac-factline__fact[title="Prazo"]')).toBeNull();
    await act(async () =>
      fireEvent.change(screen().getByRole("searchbox", { name: "Buscar tarefas" }), { target: { value: "#128" } }),
    );
    await settle(4);

    // Another visit (a reload, the desktop app, a new tab): the same view, an empty search.
    cleanup();
    await renderApp(`/org/${ORG_ID}/issues`, { api });
    await settle(8);
    expect(screen().getByRole("button", { name: "Exibição: Lista · Prioridade" })).toBeTruthy();
    expect((screen().getByRole("searchbox", { name: "Buscar tarefas" }) as HTMLInputElement).value).toBe("");
    expect(screen().getAllByRole("link", { name: /^#\d+/ })).toHaveLength(7);
    expect(screen().getByRole("region", { name: "Alta" })).toBeTruthy();

    // "Voltar ao padrão": the board by stage again, for every device.
    await click(screen().getByRole("button", { name: "Exibição: Lista · Prioridade" }));
    await settle(2);
    const display = screen().getByRole("dialog", { name: "Exibição" });
    await click(within(display).getByRole("button", { name: "Voltar ao padrão" }));
    await settle(3);
    expect(state.issuesView).toEqual(ISSUES_VIEW_DEFAULT);
    expect(screen().getByRole("button", { name: "Exibição: Quadro · Etapa" })).toBeTruthy();
    expect(column("A fazer")).toBeTruthy();
  });

  test("grouped by Etapa the column menu stays; grouped otherwise there is no column to add", async () => {
    await go(seedState({ issuesView: view({ group: "assignee" }) }));
    expect(screen().queryByRole("button", { name: "Mais opções" })).toBeNull();
    cleanup();
    await go();
    expect(screen().getByRole("button", { name: "Mais opções" })).toBeTruthy();
  });
});

describe("Tarefas: a card", () => {
  /** The fake's tasks with some changed (a work state, a conversation, labels), as the server would send them. */
  const withTasks = (change: Record<number, Partial<Issue>>, state = seedState()) => {
    const api = createFakeApi(state);
    const list = api.issues.list;
    api.issues.list = async (orgId, filters) =>
      (await list(orgId, filters)).map((i) => (change[i.number] ? { ...i, ...change[i.number] } : i));
    return api;
  };
  const facts = (card: HTMLElement) =>
    [...card.querySelectorAll(".issue-card__facts > .ac-factline__fact")].map((f) => f.textContent);
  const work = (state: NonNullable<Issue["work"]>["state"]): Issue["work"] => ({
    agentId: ADA_ID,
    runId: "run-1",
    state,
    since: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    steps: [],
  });

  test("three parts on its left edge: the title whole, one line of facts starting with its number, who has it", async () => {
    await go();
    const card = cardOf(128);
    const parts = [...card.children].filter((c) => !(c as HTMLElement).hidden).map((c) => c.className.split(" ")[0]);
    expect(parts).toEqual(["issue-card__title", "ac-factline", "issue-card__who"]);
    // The title is the title: no number in front of it, never cut.
    expect((card.querySelector(".issue-card__title") as HTMLElement).textContent).toBe(
      "Login devolve 401 depois do deploy das 9h",
    );
    expect(facts(card)).toEqual(["#128", "bug", "Alta", "hoje", "PR #42"]);
    // The label is the line's one pill; today's date in the attention tone.
    expect(card.querySelector('.ac-factline__fact[data-tone="label"]')?.textContent).toBe("bug");
    expect(card.querySelector('.ac-factline__fact[title="Prazo"]')?.getAttribute("data-tone")).toBe("warn");
    // Who has it: the face as the first word, the name.
    const who = card.querySelector(".issue-card__who") as HTMLElement;
    expect(who.querySelector(".ac-who > .ac-avatar")).toBeTruthy();
    expect(who.querySelector(".ac-who > b")?.textContent).toBe("Ada");
    expect(who.querySelector(".issue-card__state")).toBeNull();
  });

  test("a second label is +1 after the pill; the criteria say how many are done, green when all are", async () => {
    await go();
    expect(facts(cardOf(131))).toEqual(["#131", "produto", "+1", "Alta", expect.any(String), "0/4"]);
    expect(cardOf(131).querySelector('.ac-factline__fact[title="agendamento"]')?.textContent).toBe("+1");
    expect(cardOf(129).querySelector('.ac-factline__fact[title="1 de 2 critérios de aceite"]')?.textContent).toBe(
      "1/2",
    );
  });

  test("one state from one place: an agent's question wins over a turn live in its conversation", async () => {
    const conversation = {
      channelId: "task_c",
      rootId: "root_r",
      count: 22,
      lastAt: new Date().toISOString(),
      participants: [],
      working: true,
    };
    await go(undefined, withTasks({ 129: { work: work("waiting_input"), conversation } }));
    const card = cardOf(129);
    expect(card.querySelector(".issue-card__state")?.textContent).toBe("Pergunta algo");
    expect(card.textContent).not.toContain("Trabalhando");
    expect(card.getAttribute("aria-label")).toBe("#129 Timeout no agendamento em horários de pico, Pergunta algo");
    // Who has it, for a screen reader: the link's description, before how to move it.
    const [whoId, helpId] = card.getAttribute("aria-describedby")?.split(" ") ?? [];
    expect(document.getElementById(whoId ?? "")?.textContent).toBe("Responsável: Ada");
    expect(helpId).toBeTruthy();
    // Waiting on a person: the approval card's sky at its top, and no sweep, which is for an agent at work.
    expect(card.firstElementChild?.className).toBe("ac-approval__sky");
    expect(card.querySelector(".ac-work-sweep")).toBeNull();
    expect(facts(card)).toContain("22");
  });

  test("an agent at work: its face moves, Trabalhando in its color, the sweep along the bottom, no sky", async () => {
    await go();
    const card = cardOf(129);
    expect(card.querySelector(".issue-card__state")?.getAttribute("data-tone")).toBe("agent");
    expect(card.querySelector(".issue-card__state")?.textContent).toBe("Trabalhando");
    // Its mark is the kit's inline glyph, on the capitals of the words it sits in.
    expect(card.querySelector(".issue-card__state > svg")?.getAttribute("class")).toBe("ac-icon ac-icon--inline");
    expect(card.querySelector(".ac-work-sweep")).toBeTruthy();
    expect(card.querySelector(".ac-approval__sky")).toBeNull();
  });

  test("stopped for two days, and approval asked", async () => {
    await go(undefined, withTasks({ 129: { work: work("stalled") }, 128: { work: work("waiting_approval") } }));
    expect(cardOf(129).querySelector(".issue-card__state")?.textContent).toBe("Parado há 2 dias");
    expect(cardOf(129).querySelector(".ac-approval__sky")).toBeNull();
    expect(cardOf(128).querySelector(".issue-card__state")?.textContent).toBe("Pede aprovação");
    expect(cardOf(128).querySelector(".ac-approval__sky")).toBeTruthy();
  });

  test("each fact goes with its toggle in Exibição; the number and the conversation always show", async () => {
    const fields = { assignee: false, priority: false, due: false, criteria: false, pullRequest: false, label: false };
    const state = seedState({ issuesView: view({ fields }) });
    await go(state, withTasks({ 129: { work: work("waiting_input") } }, state));
    expect(facts(cardOf(128))).toEqual(["#128"]);
    expect(cardOf(128).querySelector(".issue-card__who")).toBeNull();
    // Responsável off hides who has it, never what the task asks of the person.
    expect(cardOf(129).querySelector(".issue-card__who .ac-who")).toBeNull();
    expect(cardOf(129).querySelector(".issue-card__state")?.textContent).toBe("Pergunta algo");
  });

  test("nobody on it and nothing going on: no third part, no placeholder", async () => {
    await go(undefined, withTasks({ 132: { assignee: null } }));
    expect(cardOf(132).querySelector(".issue-card__who")).toBeNull();
    expect(cardOf(132).textContent).not.toContain("Sem responsável");
    expect(cardOf(131).querySelector(".issue-card__who .ac-who > b")?.textContent).toBe("João");
  });

  test("the card's CSS: the title wraps whole, a long name wraps under the face, the state moves whole", async () => {
    const css = await Bun.file(new URL("../src/pages/issues.css", import.meta.url).pathname).text();
    const rule = (selector: string) => css.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";
    expect(rule(".issue-card__title")).toContain("overflow-wrap: anywhere");
    expect(rule(".issue-card__title")).not.toContain("line-clamp");
    expect(rule(".issue-card__who")).toContain("--who-face: 24px");
    expect(rule(".issue-card__who")).toContain("display: block");
    // The state moves whole to the next line, and one longer than the card wraps inside itself.
    expect(rule(".issue-card__state")).toContain("display: inline-block");
    expect(rule(".issue-card__state")).toContain("max-width: 100%");
    expect(rule(".issue-card__state")).not.toContain("white-space: nowrap");
    expect(rule(".issue-card > .ac-approval__sky")).toContain("height: 64px");
    // Fades in, never pops (none under reduced motion).
    expect(css).toMatch(/@starting-style \{\s*\.issue-card > \.ac-approval__sky \{\s*opacity: 0;/);
  });

  test("while the tasks load, the board's columns wait in its own frame and sideways scroller", async () => {
    const api = createFakeApi(seedState());
    api.issues.list = () => new Promise(() => {});
    await go(undefined, api);
    const loading = document.querySelector(".issues-boardframe .issues-boardwrap > .issues-board") as HTMLElement;
    expect(loading.querySelectorAll(".issues-col")).toHaveLength(4);
    expect(loading.querySelector(".loading-cards")).toBeTruthy();
  });
});

describe("Tarefas: + in a column's head", () => {
  test("A fazer's head has + left of its ⋯, 8 apart; it opens Nova tarefa in that column; no button under the cards", async () => {
    await go();
    const head = column("A fazer").querySelector(".issues-col__head") as HTMLElement;
    const buttons = [...head.querySelectorAll("button")];
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Nova tarefa em A fazer",
      "Opções da coluna A fazer",
    ]);
    expect(column("A fazer").querySelector(".issues-col__add")).toBeNull();
    expect(within(column("A fazer")).queryByText("Nova tarefa")).toBeNull();
    // Only A fazer's columns take one.
    expect(within(column("Em andamento")).queryByRole("button", { name: /^Nova tarefa/ })).toBeNull();
    await click(buttons[0] as HTMLElement);
    await settle(3);
    expect(screen().getByRole("dialog", { name: "Nova tarefa" })).toBeTruthy();
    const css = await Bun.file(new URL("../src/pages/issues.css", import.meta.url).pathname).text();
    expect(css.split("\n.issues-col__head {")[1]?.split("}")[0]).toContain("gap: 8px");
  });

  test("a custom column of A fazer gets its own +; who may not create tasks sees none", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    await api.issues.addColumn(ORG_ID, { name: "Benachrichtigungseinstellungen", stage: "todo" });
    await go(state, api);
    expect(screen().getByRole("button", { name: "Nova tarefa em Benachrichtigungseinstellungen" })).toBeTruthy();
    cleanup();
    const viewer = seedState();
    const org = viewer.me?.organizations[0];
    if (org) org.permissions = ["read"];
    await go(viewer);
    expect(screen().queryByRole("button", { name: /^Nova tarefa em/ })).toBeNull();
  });
});

describe("Tarefas: moving a card", () => {
  test("grouped by assignee: dropped in another column, the task changes hands, with Desfazer", async () => {
    const { api } = await go(seedState({ issuesView: view({ group: "assignee" }) }));
    // Everyone with a task, by name, then nobody.
    expect(layBoard()).toEqual(["Ada", "Atlas", "João", "Sem responsável"]);
    expect(cardTitles(column("Ada"))).toEqual([
      "Tabela de concorrentes atualizada",
      "Timeout no agendamento em horários de pico",
      "Login devolve 401 depois do deploy das 9h",
    ]);
    // At rest an empty column is quiet; while a card moves it says what a drop there does.
    expect(column("Sem responsável").textContent).toContain("Nada aqui.");
    await drag(cardOf(132), 600, 760);
    expect(document.querySelector(".issue-ghost")).toBeTruthy();
    expect(column("Sem responsável").textContent).toContain("Solte para tirar o responsável");
    expect(column("João").classList.contains("is-over")).toBe(true);
    expect(column("João").querySelector("[data-spot]")).toBeTruthy();
    await drop(600, 760);
    expect(document.querySelector(".issue-ghost")).toBeNull();
    expect((await api.issues.get(ORG_ID, 132)).assignee).toEqual({ type: "person", id: "u-joao" });
    expect(cardTitles(column("João"))).toContain("Tabela de concorrentes atualizada");
    expect(toast()).toContain("#132 agora está com João.");
    await click(screen().getByRole("button", { name: "Desfazer" }));
    await settle(10);
    expect((await api.issues.get(ORG_ID, 132)).assignee).toEqual({ type: "agent", id: ADA_ID });
  });

  test("dropped on Sem responsável the task has nobody", async () => {
    const { api } = await go(seedState({ issuesView: view({ group: "assignee" }) }));
    layBoard();
    await drag(cardOf(130), 900, 300);
    await drop(900, 300);
    expect((await api.issues.get(ORG_ID, 130)).assignee).toBeNull();
    expect(toast()).toContain("#130 ficou sem responsável.");
    // The card without anyone: no third part, no placeholder.
    expect(cardOf(130).querySelector(".issue-card__who")).toBeNull();
  });

  test("a press and a release without moving is a click: the task opens", async () => {
    const { router } = await go();
    layBoard();
    await act(async () => {
      fireEvent.pointerDown(cardOf(131), at(60, 250));
      fireEvent.pointerMove(document, at(62, 251));
      fireEvent.pointerUp(document, at(62, 251));
      fireEvent.click(cardOf(131));
    });
    await settle(4);
    expect(document.querySelector(".issue-ghost")).toBeNull();
    expect(router.state.location.href).toContain("?open=131");
  });

  test("grouped by priority: the drop sets the priority", async () => {
    const { api } = await go(seedState({ issuesView: view({ group: "priority" }) }));
    expect(layBoard()).toEqual(["Alta", "Normal", "Baixa"]);
    await drag(cardOf(132), 560, 300);
    await drop(560, 300);
    expect((await api.issues.get(ORG_ID, 132)).priority).toBe("low");
    expect(toast()).toContain("#132 agora tem prioridade baixa.");
  });

  test("by stage: Esc while dragging sends the card back and saves nothing", async () => {
    const { api } = await go();
    expect(layBoard()).toEqual(["A fazer", "Em andamento", "Em revisão", "Feito"]);
    await drag(cardOf(131), 560, 760);
    expect(column("Em revisão").classList.contains("is-over")).toBe(true);
    await press("Escape", document.body);
    expect(document.querySelector(".issue-ghost")).toBeNull();
    expect(document.querySelector("[data-spot]")).toBeNull();
    expect(cardTitles(column("A fazer"))).toContain("Confirmação do agendamento por WhatsApp");
    expect((await api.issues.get(ORG_ID, 131)).status).toBe("todo");
    // The release after Esc drops nothing.
    await drop(560, 760);
    expect((await api.issues.get(ORG_ID, 131)).status).toBe("todo");
  });

  test("by stage: dropped in Feito the task is done, at that place", async () => {
    const { api } = await go();
    layBoard();
    // Feito has two cards: between them.
    await drag(cardOf(131), 860, 300);
    await drop(860, 300);
    const moved = await api.issues.get(ORG_ID, 131);
    expect(moved.status).toBe("done");
    expect(cardTitles(column("Feito"))).toEqual([
      "Resumo semanal de erros do Sentry no #eng",
      "Confirmação do agendamento por WhatsApp",
      "Organizar o roadmap do trimestre",
    ]);
    expect(toast()).toContain("Movida para Feito");
  });

  test("the keyboard: Space picks the card up, the arrows move it, Enter drops it; Esc puts it back", async () => {
    const { api } = await go();
    const card = cardOf(131);
    card.focus();
    await press(" ", card);
    expect(cardOf(131).classList.contains("is-picked")).toBe(true);
    expect(live()).toBe("Você pegou a #131. As setas movem, Espaço solta, Esc cancela.");
    await press("ArrowRight");
    // In Em andamento now, at the place it had in its column: second of three.
    expect(cardTitles(column("Em andamento"))).toContain("Confirmação do agendamento por WhatsApp");
    expect(live()).toBe("#131: Em andamento, posição 2 de 3.");
    expect(document.activeElement === cardOf(131)).toBe(true);
    await press("ArrowUp");
    expect(live()).toBe("#131: Em andamento, posição 1 de 3.");
    await press("Enter");
    expect(live()).toBe("Você soltou a #131 em Em andamento.");
    const moved = await api.issues.get(ORG_ID, 131);
    expect(moved.status).toBe("in_progress");
    expect(cardTitles(column("Em andamento"))[0]).toBe("Confirmação do agendamento por WhatsApp");

    // Esc: back where it was, nothing saved.
    const other = cardOf(132);
    other.focus();
    await press(" ", other);
    await press("ArrowRight");
    await press("ArrowRight");
    expect(cardTitles(column("Em revisão"))).toContain("Tabela de concorrentes atualizada");
    await press("Escape");
    expect(live()).toBe("A #132 voltou para o lugar.");
    expect(cardTitles(column("A fazer"))).toContain("Tabela de concorrentes atualizada");
    expect((await api.issues.get(ORG_ID, 132)).status).toBe("todo");
  });

  test("in the list the arrows go on into the next group", async () => {
    const { api } = await go(seedState({ issuesView: view({ layout: "list", group: "priority" }) }));
    const row = cardOf(131);
    row.focus();
    await press(" ", row);
    // Alta has #131 and #128: down below #128, then on to the top of Normal (five there).
    await press("ArrowDown");
    await press("ArrowDown");
    expect(live()).toBe("#131: Normal, posição 1 de 6.");
    await press(" ");
    expect((await api.issues.get(ORG_ID, 131)).priority).toBe("normal");
  });
});

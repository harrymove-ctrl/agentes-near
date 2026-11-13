import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { join } from "node:path";
import { modelChoices } from "@agenteschat/client/lib/providers";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { channelNameError, toChannelName } from "@/components/NewChannelDialog";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, ORG_ID, seedDm, seedState } from "./fake-api";
import { proceed, startAs } from "./new-agent-flow";
import { endExit, exitsLast, renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const go = async (path: string, state = seedState(), api = createFakeApi(state)) => {
  const r = await renderApp(`/org/${ORG_ID}/${path}`, { api });
  await settle(5);
  const socket = r.sockets.last();
  await act(async () => socket.open());
  await settle(2);
  return { ...r, socket, state };
};
const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const pick = async (combobox: HTMLElement, option: RegExp | string) => {
  combobox.focus();
  await act(async () => fireEvent.keyDown(combobox, { key: "Enter" }));
  await act(async () => fireEvent.click(screen().getByRole("option", { name: option })));
  await settle();
};
const nav = () => screen().getByRole("navigation", { name: "Navegação do workspace" });

describe("receipt on the right of the header line", () => {
  test("a person's message carries the check in the header aside", async () => {
    await go(`c/${ENG_ID}`);
    const ask = screen()
      .getAllByRole("article")
      .find((a) => a.textContent?.includes("o login está devolvendo 401")) as HTMLElement;
    expect(ask.querySelector(".ac-msg__head .ac-msg__aside .ac-receipt__check")).not.toBeNull();
  });
});

describe("sidebar: no agent twice", () => {
  test("an agent's DM is its row under Agentes, with its unread; 'Mensagens diretas' lists the people", async () => {
    const state = seedState();
    seedDm(state, { type: "agent", id: ADA_ID }, { ago: 1, unread: 3 });
    seedDm(state, { type: "person", id: "u-joao" }, { ago: 5, unread: 1 });
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(6);
    const adaLinks = within(nav())
      .getAllByRole("link")
      .filter((l) => l.textContent?.includes("Ada"));
    expect(adaLinks).toHaveLength(1);
    expect(adaLinks[0]?.getAttribute("href")).toBe(`/org/${ORG_ID}/dm/agent/${ADA_ID}`);
    expect(within(adaLinks[0] as HTMLElement).getByLabelText("3 mensagens não lidas").textContent).toBe("3");
    const dmsGroup = within(nav()).getByText("Mensagens diretas").closest(".sidebar__group") as HTMLElement;
    expect([...dmsGroup.querySelectorAll("a .sidebar__item-label")].map((l) => l.textContent)).toEqual(["João"]);
  });
});

/** Canais' + → Novo canal. */
const newChannel = async () => {
  const plus = within(nav()).getByRole("button", { name: "Novo canal ou categoria" });
  await act(async () => {
    fireEvent.keyDown(plus, { key: "Enter" });
    fireEvent.keyUp(plus, { key: "Enter" });
  });
  await settle(2);
  await click(within(screen().getByRole("menu")).getByRole("menuitem", { name: "Novo canal" }));
  await settle(2);
};

describe("Criar canal", () => {
  /** Opens "Criar canal" in a workspace with `count` agents. */
  const openWith = async (count: number) => {
    const state = seedState();
    const [first] = state.agents;
    for (let i = state.agents.length; first && i < count; i++) {
      state.agents.push({ ...first, id: `agent-${i}`, name: `Agente ${i}`, handle: `agente${i}` });
    }
    await go(`c/${ENG_ID}`, state);
    await newChannel();
    return screen().getByRole("dialog", { name: "Criar canal" });
  };
  const sheet = (path: string) => Bun.file(join(import.meta.dir, path)).text();
  const rule = (css: string, selector: string) => css.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";

  for (const count of [2, 30]) {
    test(`one column with ${count} agents: name, description, then the members; the footer outside the scroll`, async () => {
      const dialog = await openWith(count);
      const [body, ...more] = dialog.querySelectorAll(".ac-dialog__body");
      expect(more).toEqual([]);
      const list = within(dialog).getByRole("region", { name: "Buscar pessoa ou agente" });
      const column = [
        within(dialog).getByLabelText("Nome"),
        within(dialog).getByLabelText("Descrição"),
        within(dialog).getByText("Membros iniciais"),
        within(dialog).getByRole("searchbox", { name: "Buscar pessoa ou agente" }),
        list,
      ];
      for (const el of column) expect(body?.contains(el)).toBe(true);
      for (const [i, el] of column.slice(1).entries()) {
        expect((column[i]?.compareDocumentPosition(el) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      }
      // Every agent and the other person, in the list's own scroll box under the search.
      expect(within(list).getAllByRole("checkbox")).toHaveLength(count + 1);
      expect(list.className).toBe("people-picker__results");
      // The footer is the dialog's own, outside the scroll: the count, Cancelar and Criar stay in view.
      const foot = dialog.querySelector(".ac-dialog__foot") as HTMLElement;
      expect(body?.contains(foot)).toBe(false);
      expect(foot.closest(".ac-dialog__body, .ac-dialog__list")).toBeNull();
      expect(foot.textContent).toContain("0 selecionado");
      expect(within(foot).getByRole("button", { name: "Cancelar" })).toBeTruthy();
      expect(within(foot).getByRole("button", { name: "Criar #canal" })).toBeTruthy();
      // The column scrolls when the screen is short (a phone's sheet too); the list scrolls in its box; the footer
      // never shrinks.
      const ui = await sheet("../../../packages/ui/src/styles/components.css");
      const app = await sheet("../src/layout.css");
      expect(rule(ui, ".ac-dialog__body")).toContain("overflow-y: auto;");
      expect(rule(ui, ".ac-dialog__body")).toContain("flex-direction: column;");
      expect(rule(app, ".people-picker__results")).toMatch(/max-height: \d+px;[\s\S]*overflow-y: auto;/);
      expect(ui).toMatch(/\.ac-dialog__foot \{\n {2}flex: none;/);
      // The list ends the body, right over the footer's line: it drops its own, so one line shows there, not two.
      expect(body?.lastElementChild?.classList.contains("people-picker")).toBe(true);
      expect(foot.classList.contains("ac-dialog__foot--bar")).toBe(true);
      expect(rule(ui, ".ac-dialog__foot--bar")).toContain("border-top: 1px solid");
      expect(rule(app, ".people-picker__results")).toContain("border-bottom: 1px solid");
      expect(rule(app, ".ac-dialog__body > .people-picker:last-child .people-picker__results")).toContain(
        "border-bottom: 0;",
      );
    });
  }

  test("name rules", () => {
    expect(toChannelName("Marketing Brasil")).toBe("marketing-brasil");
    expect(toChannelName("Ação!")).toBe("acao");
    expect(channelNameError("eng", new Set(["eng"]))).toBe("taken");
    expect(channelNameError("-x", new Set())).toBe("invalid");
    expect(channelNameError("vendas", new Set(["eng"]))).toBeNull();
  });

  test("dialog from the '+': validates, picks initial members, creates and opens the channel", async () => {
    const { state, router } = await go(`c/${ENG_ID}`);
    await newChannel();
    const dialog = screen().getByRole("dialog", { name: "Criar canal" });
    const name = within(dialog).getByLabelText("Nome");
    await type(name, "eng");
    expect(dialog.textContent).toContain("Já existe um canal #eng.");
    await type(name, "Vendas Sul");
    expect((name as HTMLInputElement).value).toBe("vendas-sul");
    await type(within(dialog).getByLabelText("Descrição"), "Leads e propostas");
    // "Quem pode entrar" is a dropdown.
    const access = within(dialog).getByRole("combobox", { name: "Quem pode entrar" });
    access.focus();
    await act(async () => fireEvent.keyDown(access, { key: "Enter" }));
    await click(screen().getByRole("option", { name: /Privado/ }));
    await type(within(dialog).getByRole("searchbox", { name: "Buscar pessoa ou agente" }), "ada");
    await click(within(dialog).getByRole("checkbox", { name: /Ada/ }));
    expect(dialog.textContent).toContain("1 selecionado");
    await click(within(dialog).getByRole("button", { name: "Criar #vendas-sul" }));
    await settle(6);
    expect(state.calls.find((c) => c.method === "chat.createChannel")?.args[1]).toEqual({
      name: "vendas-sul",
      topic: "Leads e propostas",
      visibility: "private",
      audienceRoleIds: [],
    });
    const created = state.channels.find((c) => c.name === "vendas-sul");
    expect(state.calls.find((c) => c.method === "chat.addMember")?.args).toEqual([
      ORG_ID,
      created?.id,
      { agentId: ADA_ID },
    ]);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${created?.id}`);
  });
});

describe("Detalhes do canal: membros", () => {
  const openDetails = async () => {
    await click(within(screen().getByRole("main")).getByRole("button", { name: "Configurações do canal" }));
    await settle(3);
    const dialog = screen().getByRole("dialog", { name: "#eng" });
    // Who manages it lands on Visão geral (ADR 0134); a member sees the members alone.
    const members = within(dialog).queryByRole("button", { name: "Membros" });
    if (members) {
      await click(members);
      await settle(2);
    }
    return dialog;
  };
  /** Opens a row's "⋯" (Radix: keyboard) and returns its menu. */
  const openMenu = async (name: string) => {
    const button = screen().getByRole("button", { name: `Opções de ${name}` });
    button.focus();
    await act(async () => {
      fireEvent.keyDown(button, { key: "Enter" });
      fireEvent.keyUp(button, { key: "Enter" });
    });
    await act(() => new Promise((r) => setTimeout(r, 0)));
    return screen().getByRole("menu");
  };

  /** Picks "Quando alguém chama" in an open "⋯" menu and returns what the app sent. */
  const mentionOnly = async (state: ReturnType<typeof seedState>, menu: HTMLElement) => {
    await click(within(menu).getByRole("menuitemradio", { name: /^Quando alguém chama/ }));
    await settle(4);
    return {
      patch: state.calls.find((c) => c.method === "chat.setAutoReply")?.args,
      put: state.calls.some((c) => c.method === "agents.setChannels"),
    };
  };

  test("'⋯' sets how an agent replies in this channel alone; remove and add members", async () => {
    const state = seedState();
    await go(`c/${ENG_ID}`, state);
    let dialog = await openDetails();
    expect(dialog.textContent).toContain("Entra na conversa por conta própria");
    const menu = await openMenu("Atlas");
    expect(
      within(menu)
        .getByRole("menuitemradio", { name: /^Por conta própria/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(await mentionOnly(state, menu)).toEqual({ patch: [ORG_ID, ENG_ID, ATLAS_ID, false], put: false });
    expect(screen().getByRole("dialog", { name: "#eng" }).textContent).toContain("Espera alguém chamar @atlas");
    // Not on my own row; on another, it asks first.
    expect(within(dialog).queryByRole("button", { name: "Opções de Walter" })).toBeNull();
    await click(within(await openMenu("João")).getByRole("menuitem", { name: "Tirar do canal" }));
    const confirm = screen().getByRole("dialog", { name: "Tirar João de #eng?" });
    expect(state.calls.find((c) => c.method === "chat.removeMember")).toBeUndefined();
    await click(within(confirm).getByRole("button", { name: "Tirar do canal" }));
    await settle(4);
    expect(state.calls.find((c) => c.method === "chat.removeMember")?.args).toEqual([
      ORG_ID,
      ENG_ID,
      { userId: "u-joao" },
    ]);
    dialog = screen().getByRole("dialog", { name: "#eng" });
    await click(within(dialog).getByRole("button", { name: "Adicionar pessoa ou agente" }));
    const add = screen().getByRole("dialog", { name: "Adicionar a #eng" });
    // Only who isn't in the channel.
    expect(
      within(add)
        .getAllByRole("checkbox")
        .map((c) => c.getAttribute("id")),
    ).toEqual(["pick-person-u-joao"]);
    await click(within(add).getByRole("checkbox", { name: /João/ }));
    await click(within(add).getByRole("button", { name: "Adicionar 1" }));
    await settle(4);
    expect(state.calls.filter((c) => c.method === "chat.addMember").at(-1)?.args).toEqual([
      ORG_ID,
      ENG_ID,
      { userId: "u-joao" },
    ]);
    dialog = screen().getByRole("dialog", { name: "#eng" });
    expect(dialog.textContent).toContain("João");
  });

  test("Adicionar: the ones being added keep their rows, and nobody reads as in already, while it adds and closes", async () => {
    const state = seedState();
    // João isn't in #eng yet: the one person to add.
    state.channelMembers[ENG_ID] = (state.channelMembers[ENG_ID] ?? []).filter((m) => m.id !== "u-joao");
    const api = createFakeApi(state);
    const addMember = api.chat.addMember;
    let answer = () => {};
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    api.chat.addMember = async (...args) => {
      await addMember(...args);
      await answered;
    };
    const { socket } = await go(`c/${ENG_ID}`, state, api);
    const dialog = await openDetails();
    await click(within(dialog).getByRole("button", { name: "Adicionar pessoa ou agente" }));
    const add = screen().getByRole("dialog", { name: "Adicionar a #eng" });
    exitsLast();
    await click(within(add).getByRole("checkbox", { name: /João/ }));
    await click(within(add).getByRole("button", { name: "Adicionar 1" }));
    // Added on the server, which says so on the socket before it answers.
    await act(async () => socket.push({ type: "event", scope: "org", event: { type: "channels.changed" } }));
    await settle(6);
    expect(state.channelMembers[ENG_ID]?.some((m) => m.id === "u-joao")).toBe(true);
    const joao = () => add.querySelector("#pick-person-u-joao");
    expect(joao()).not.toBeNull();
    expect(add.textContent).not.toContain("já está em");
    await act(async () => answer());
    await settle(6);
    expect(add.getAttribute("data-state")).toBe("closed");
    expect(joao()).not.toBeNull();
    expect(add.textContent).not.toContain("já está em");
    await endExit(add);
    expect(add.isConnected).toBe(false);
  });

  test("members see it read-only", async () => {
    const state = seedState();
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
    await go(`c/${ENG_ID}`, state);
    const dialog = await openDetails();
    expect(within(dialog).queryByRole("button", { name: "Adicionar pessoa ou agente" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /^Opções de/ })).toBeNull();
    expect(within(dialog).queryByRole("textbox", { name: "Descrição do canal" })).toBeNull();
    expect(dialog.textContent).toContain("Só quem criou o canal e os admins mudam os membros.");
  });

  test("the channel's creator, not an admin, sets how an agent replies here", async () => {
    const state = seedState();
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
    const eng = state.channels.find((c) => c.id === ENG_ID);
    if (eng) eng.createdByUserId = "u-walter";
    await go(`c/${ENG_ID}`, state);
    await openDetails();
    expect(await mentionOnly(state, await openMenu("Atlas"))).toEqual({
      patch: [ORG_ID, ENG_ID, ATLAS_ID, false],
      put: false,
    });
  });

  test("an agent's owner sets how it replies here, and nothing else of the channel", async () => {
    const state = seedState();
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
    const atlas = state.agents.find((a) => a.id === ATLAS_ID);
    if (atlas) atlas.ownerUserId = "u-walter";
    await go(`c/${ENG_ID}`, state);
    const dialog = await openDetails();
    expect(
      within(dialog)
        .queryAllByRole("button", { name: /^Opções de/ })
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Opções de Atlas"]);
    expect(within(dialog).queryByRole("button", { name: "Adicionar pessoa ou agente" })).toBeNull();
    const menu = await openMenu("Atlas");
    expect(within(menu).queryByRole("menuitem", { name: "Tirar do canal" })).toBeNull();
    expect(await mentionOnly(state, menu)).toEqual({ patch: [ORG_ID, ENG_ID, ATLAS_ID, false], put: false });
  });
});

describe("agent owner is optional", () => {
  test("Criar agente: 'Sem responsável' sends ownerUserId null, with the help text", async () => {
    const { state } = await go("agents/new");
    await startAs("QA");
    await proceed(3);
    await pick(screen().getByRole("combobox", { name: "Responsável" }), /Sem responsável/);
    expect(document.body.textContent).toContain(
      "Sem responsável, os admins recebem os avisos e aprovam as ações sensíveis.",
    );
    expect(screen().getByRole("combobox", { name: "Responsável" }).textContent).toContain("Sem responsável");
    await proceed(2);
    await click(screen().getByRole("button", { name: "Criar Iris" }));
    await settle(6);
    expect(state.calls.find((c) => c.method === "agents.create")?.args[1]).toMatchObject({ ownerUserId: null });
  });

  test("profile: Responsável is chosen in Configurações and saved with the bar", async () => {
    const state = seedState();
    const { state: s } = await go(`agents/${ADA_ID}?tab=settings&sec=owner`, state);
    await pick(screen().getByRole("combobox", { name: "Responsável" }), /Sem responsável/);
    await click(
      within(screen().getByRole("region", { name: "Alterações não salvas" })).getByRole("button", { name: /^Salvar/ }),
    );
    await settle(4);
    expect(s.calls.find((c) => c.method === "agents.update")?.args[2]).toEqual({ ownerUserId: null });
    expect(screen().getByRole("combobox", { name: "Responsável" }).textContent).toContain("Sem responsável");
  });
});

describe("models by provider and the default key", () => {
  const models = [
    {
      id: "claude-sonnet-5-5",
      label: "Claude Sonnet 5.5",
      provider: "anthropic",
      inputUsdPerMTok: 2,
      outputUsdPerMTok: 10,
    },
    { id: "gpt-5", label: "GPT-5", provider: "openai", inputUsdPerMTok: 1.25, outputUsdPerMTok: 10 },
  ];
  const cred = { id: "k", provider: "anthropic", label: "A", keyHint: "1", createdAt: "", revokedAt: null };

  test("availability comes from the keys (or the server's flag)", () => {
    expect(modelChoices(models, [cred], false).map(([p, c]) => [p, c.map((x) => x.available)])).toEqual([
      ["anthropic", [true]],
      ["openai", [false]],
    ]);
    expect(
      modelChoices([{ ...models[1], available: true } as (typeof models)[number]], [], false)[0]?.[1][0]?.available,
    ).toBe(true);
  });

  test("Criar agente: Quem pensa by provider, OpenAI disabled without a key; key defaults to the workspace's", async () => {
    await go("agents/new");
    await startAs("QA");
    await proceed(4);
    await act(async () => fireEvent.click(screen().getByRole("combobox", { name: "Quem pensa" })));
    const list = screen().getByRole("listbox", { name: "Modelos" });
    const options = within(list).getAllByRole("option");
    // "Automático" first and chosen, then the models by provider.
    expect(options[0]?.querySelector(".ac-menu__label span")?.textContent).toBe("Automático");
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");
    const groups = within(list)
      .getAllByRole("group")
      .map((g) => g.getAttribute("aria-label"));
    expect(groups.slice(0, 2)).toEqual(["Claude", "OpenAI"]);
    const gpt = within(list).getAllByRole("option", { name: /GPT-5/ })[0] as HTMLElement;
    expect(gpt.getAttribute("aria-disabled")).toBe("true");
    expect(gpt.textContent).toContain("Precisa de uma chave de API OpenAI");
    await act(async () =>
      fireEvent.keyDown(screen().getByRole("combobox", { name: "Buscar modelos" }), { key: "Escape" }),
    );
    const key = screen().getByRole("combobox", { name: "Chave" });
    expect(key.textContent).toContain("Chave padrão do workspace");
  });
});

describe("agent questions (ask_user)", () => {
  test("choices answer it; 'Outra resposta' opens a field in the card; the receipt waits for your answer", async () => {
    const state = seedState();
    const question = {
      id: "q1",
      agentId: ADA_ID,
      channelId: ENG_ID,
      threadId: null,
      messageId: "msg-q",
      text: "Faço o deploy agora ou depois das 18h?",
      choices: ["Agora", "Depois das 18h"],
      status: "open",
      answer: null,
      answeredByUserId: null,
    };
    state.messages.push({
      id: "msg-q",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: ADA_ID },
      body: "",
      mentionedAgentIds: [],
      agentRunId: "r-q",
      meta: { question },
      createdAt: new Date().toISOString(),
    });
    // Asked in the channel: the question has no thread, so the receipt follows the run that answers m-1.
    const asked = state.messages.find((m) => m.id === "m-1");
    if (asked)
      asked.receipts = { seenBy: [], pickedBy: [], handled: [{ agentId: ADA_ID, runId: "r-q", status: "running" }] };
    const { socket } = await go(`c/${ENG_ID}`, state);
    await act(async () =>
      socket.push({
        type: "event",
        channelId: ENG_ID,
        event: { type: "question.asked", channelId: ENG_ID, threadId: null, question },
      }),
    );
    await act(async () =>
      socket.push({
        type: "event",
        channelId: ENG_ID,
        event: {
          type: "agent.run",
          channelId: ENG_ID,
          threadId: null,
          runId: "r-q",
          agentId: ADA_ID,
          status: "waiting_input",
        },
      }),
    );
    await settle();
    const root = screen()
      .getAllByRole("article")
      .find((a) => a.textContent?.includes("o login está devolvendo 401")) as HTMLElement;
    expect(root.querySelector(".ac-receipt__check")?.getAttribute("aria-label")).toBe(
      "Vista por Ada. Ada está esperando uma resposta",
    );
    const card = screen().getByRole("group", { name: "Pergunta de Ada" });
    expect(card.textContent).toContain("Faço o deploy agora ou depois das 18h?");
    // A request card: what kind of request (waiting for me needs no words); the choices in its footer.
    expect(card.getAttribute("data-ask-kind")).toBe("question");
    expect(card.querySelector(".rq__head")?.textContent).toBe("Pergunta");
    // With choices, writing another answer is "Outra resposta": a field opens in the card, focused.
    await click(within(card).getByRole("button", { name: "Outra resposta" }));
    expect(document.activeElement === within(card).getByRole("textbox", { name: "Sua resposta" })).toBe(true);
    await click(within(card).getByRole("button", { name: "Depois das 18h" }));
    await settle(4);
    // Answered: one line takes its place (another element), the answer bold, the question still in the open.
    const done = screen().getByRole("group", { name: "Pergunta de Ada" });
    expect(done.textContent).toContain("Você respondeu: Depois das 18h");
    expect(done.querySelector(".rq-done__mark[data-done]")).not.toBeNull();
    expect(done.querySelector("b")?.textContent).toBe("Depois das 18h");
    expect(done.closest("article")?.textContent).toContain("Faço o deploy agora ou depois das 18h?");
    expect(state.calls.find((c) => c.method === "questions.answer")?.args).toEqual([
      ORG_ID,
      "q1",
      { choice: "Depois das 18h" },
    ]);
  });

  test("the choices are a list, one a line with its number key; with the focus in it, a number answers", async () => {
    const state = seedState();
    const question = {
      id: "q-keys",
      agentId: ADA_ID,
      channelId: ENG_ID,
      threadId: null,
      messageId: "msg-keys",
      text: "Para qual faixa a versão 8 deve ir?",
      choices: ["Teste fechado", "Teste aberto", "Produção"],
      status: "open",
      answer: null,
      answeredByUserId: null,
    };
    state.messages.push({
      id: "msg-keys",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: ADA_ID },
      body: "",
      mentionedAgentIds: [],
      agentRunId: "r-keys",
      meta: { question },
      createdAt: new Date().toISOString(),
    });
    await go(`c/${ENG_ID}`, state);
    await settle();
    const card = screen().getByRole("group", { name: "Pergunta de Ada" });
    const list = card.querySelector(".rq__choices") as HTMLElement;
    // Each choice its key and words; "Outra resposta" the list's last line; the footer says the keys.
    expect([...list.querySelectorAll(".rq__choice")].map((b) => b.textContent)).toEqual([
      "1Teste fechado",
      "2Teste aberto",
      "3Produção",
      "Outra resposta",
    ]);
    expect(card.querySelector(".rq__foot .rq__keys")?.textContent).toBe("Tecle 1–3 para responder");
    within(list).getByRole("button", { name: "Teste fechado" }).focus();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "2" });
    await settle(4);
    expect(state.calls.find((c) => c.method === "questions.answer")?.args).toEqual([
      ORG_ID,
      "q-keys",
      { choice: "Teste aberto" },
    ]);
  });

  test("'Responder' on a question without choices opens a field; its text answers the question", async () => {
    const state = seedState();
    const question = {
      id: "q4",
      agentId: ADA_ID,
      channelId: ENG_ID,
      threadId: null,
      messageId: "msg-q4",
      text: "Qual é o endereço da API do serviço de cobrança?",
      choices: null,
      status: "open",
      answer: null,
      answeredByUserId: null,
    };
    state.messages.push({
      id: "msg-q4",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: ADA_ID },
      body: "",
      mentionedAgentIds: [],
      agentRunId: "r-q4",
      meta: { question },
      createdAt: new Date().toISOString(),
    });
    await go(`c/${ENG_ID}`, state);
    await settle();
    const card = screen().getByRole("group", { name: "Pergunta de Ada" });
    expect(within(card).queryByRole("textbox")).toBeNull();
    await click(within(card).getByRole("button", { name: "Responder" }));
    const field = within(card).getByRole("textbox", { name: "Sua resposta" });
    expect(document.activeElement === field).toBe(true);
    await type(field, "https://api.example.test/v1");
    // Enter twice while the first answer is on its way sends it once.
    let release = () => {};
    state.answerHold = new Promise<void>((resolve) => {
      release = resolve;
    });
    await act(async () => fireEvent.keyDown(field, { key: "Enter" }));
    await act(async () => fireEvent.keyDown(field, { key: "Enter" }));
    release();
    await settle(4);
    expect(state.calls.filter((c) => c.method === "questions.answer")).toHaveLength(1);
    expect(state.calls.find((c) => c.method === "questions.answer")?.args).toEqual([
      ORG_ID,
      "q4",
      { text: "https://api.example.test/v1" },
    ]);
    const done = screen().getByRole("group", { name: "Pergunta de Ada" });
    expect(done.textContent).toContain("Você respondeu: https://api.example.test/v1");
  });

  test("Cancelar leaves the answer field for the card; Pular closes the question without an answer", async () => {
    const state = seedState();
    const question = {
      id: "q5",
      agentId: ADA_ID,
      channelId: ENG_ID,
      threadId: null,
      messageId: "msg-q5",
      text: "Qual ambiente?",
      choices: null,
      status: "open",
      answer: null,
      answeredByUserId: null,
    };
    state.messages.push({
      id: "msg-q5",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: ADA_ID },
      body: "",
      mentionedAgentIds: [],
      agentRunId: "r-q5",
      meta: { question },
      createdAt: new Date().toISOString(),
    });
    await go(`c/${ENG_ID}`, state);
    await settle();
    const card = screen().getByRole("group", { name: "Pergunta de Ada" });
    await click(within(card).getByRole("button", { name: "Responder" }));
    await type(within(card).getByRole("textbox", { name: "Sua resposta" }), "staging");
    await click(within(card).getByRole("button", { name: "Cancelar" }));
    expect(within(card).queryByRole("textbox")).toBeNull();
    expect(within(card).getByRole("button", { name: "Responder" })).toBeTruthy();
    await click(within(card).getByRole("button", { name: "Pular" }));
    await settle(4);
    expect(state.calls.filter((c) => c.method === "questions.answer")).toHaveLength(0);
    expect(state.calls.find((c) => c.method === "questions.dismiss")?.args).toEqual([ORG_ID, "q5"]);
    expect(screen().getByRole("group", { name: "Pergunta de Ada" }).textContent).toContain("Você pulou esta pergunta.");
  });

  test("the question shows once: its card, not its text above it too", async () => {
    const state = seedState();
    const text = "Quais datas eu coloco na viagem para o Chile?";
    const question = {
      id: "q3",
      agentId: ADA_ID,
      channelId: ENG_ID,
      threadId: null,
      messageId: "msg-q3",
      text,
      choices: null,
      status: "answered",
      answer: "Ainda não sei as datas",
      answeredByUserId: null,
    };
    state.messages.push({
      id: "msg-q3",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: ADA_ID },
      body: text,
      mentionedAgentIds: [],
      agentRunId: "r-q3",
      meta: { question },
      createdAt: new Date().toISOString(),
    });
    await go(`c/${ENG_ID}`, state);
    const card = screen().getByRole("group", { name: "Pergunta de Ada" });
    const message = card.closest("article") as HTMLElement;
    expect(message.textContent?.split(text).length).toBe(2);
  });

  test("a question someone already answered (409) is explained on the card", async () => {
    const state = seedState();
    const question = {
      id: "q2",
      agentId: ADA_ID,
      channelId: ENG_ID,
      threadId: null,
      messageId: "msg-q2",
      text: "Uso a branch main ou staging?",
      choices: ["main", "staging"],
      status: "open",
      answer: null,
      answeredByUserId: null,
    };
    state.messages.push({
      id: "msg-q2",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: ADA_ID },
      body: "",
      mentionedAgentIds: [],
      agentRunId: "r-q2",
      meta: { question: { ...question } },
      createdAt: new Date().toISOString(),
    });
    await go(`c/${ENG_ID}`, state);
    await settle();
    // Someone else answers on the server first; this tab still shows it open.
    state.answeredElsewhere = new Set(["q2"]);
    const card = screen().getByRole("group", { name: "Pergunta de Ada" });
    await click(within(card).getByRole("button", { name: "staging" }));
    await settle(4);
    // The card ends where it stands: no choice left to press.
    const after = screen().getByRole("group", { name: "Pergunta de Ada" });
    expect(after.textContent).toContain("Esta pergunta já foi respondida ou encerrada.");
    expect(within(after).queryByRole("button", { name: "staging" })).toBeNull();
  });

  test("a question closed without an answer (its run stopped) says so, not who answered", async () => {
    const state = seedState();
    const question = {
      id: "q5",
      agentId: ADA_ID,
      channelId: ENG_ID,
      threadId: null,
      messageId: "msg-q5",
      text: "Qual conta eu uso?",
      choices: null,
      status: "answered",
      answer: null,
      answeredByUserId: null,
    };
    state.messages.push({
      id: "msg-q5",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: ADA_ID },
      body: "",
      mentionedAgentIds: [],
      agentRunId: "r-q5",
      meta: { question },
      createdAt: new Date().toISOString(),
    });
    await go(`c/${ENG_ID}`, state);
    const card = screen().getByRole("group", { name: "Pergunta de Ada" });
    expect(card.textContent).toContain("Encerrada sem resposta.");
    expect(card.textContent).not.toContain("Você respondeu");
    expect(within(card).queryByRole("button", { name: "Responder" })).toBeNull();
  });
});

describe("flat DM replies", () => {
  test("an agent reply without a thread lands in the timeline and clears the typing bar", async () => {
    const { socket, state } = await go(`dm/agent/${ADA_ID}`);
    await settle(4);
    const composer = screen().getByRole("combobox", { name: /Mensagem para/ });
    await act(async () => fireEvent.change(composer, { target: { value: "oi" } }));
    await act(async () => fireEvent.keyDown(composer, { key: "Enter" }));
    expect(document.querySelector(".ac-typing__text")?.textContent).toBe("Ada pensando…");
    await settle(4);
    const dm = state.dms[0];
    await act(async () =>
      socket.push({
        type: "event",
        channelId: dm?.channelId,
        event: {
          type: "message.created",
          channelId: dm?.channelId,
          messageId: "flat-1",
          message: {
            id: "flat-1",
            channelId: dm?.channelId,
            threadId: null,
            author: { type: "agent", id: ADA_ID },
            body: "Oi! Em que posso ajudar?",
            mentionedAgentIds: [],
            agentRunId: "r-flat",
            createdAt: new Date().toISOString(),
          },
        },
      }),
    );
    await settle();
    expect(document.querySelector(".ac-typing__text")).toBeNull();
    const rows = screen().getAllByRole("article");
    expect(rows[rows.length - 1]?.textContent).toContain("Oi! Em que posso ajudar?");
  });
});

describe("DM composer", () => {
  test("names the person or agent without '#'; channels keep '#nome'", async () => {
    await go(`dm/agent/${ADA_ID}`);
    await settle(4);
    const box = screen().getByRole("combobox", { name: "Mensagem para Ada" });
    expect(box.getAttribute("placeholder")).toBe("Mensagem para Ada");
    cleanup();
    await go(`c/${ENG_ID}`);
    const channel = screen().getByRole("combobox", { name: "Mensagem para #eng" });
    expect(channel.getAttribute("placeholder")).toContain("Mensagem para #eng");
  });
});

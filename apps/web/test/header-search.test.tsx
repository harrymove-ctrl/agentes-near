import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { keys, messagesQuery } from "@agenteschat/client";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, GENERAL_ID, ORG_ID, seedDm, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const box = () =>
  within(document.querySelector(".channel__header") as HTMLElement).getByRole("combobox", {
    name: "Buscar",
  }) as HTMLInputElement;
const typeIn = async (value: string) => {
  await act(async () => fireEvent.change(box(), { target: { value } }));
  // The search runs a beat after the last key.
  await act(() => new Promise((r) => setTimeout(r, 300)));
  await settle(4);
};
const enter = async () => {
  await act(async () => fireEvent.keyDown(box(), { key: "Enter" }));
  await act(() => new Promise((r) => setTimeout(r, 300)));
  await settle(4);
};
const results = () => screen().queryByRole("complementary", { name: "Resultados da busca" });
const row = (id: string) => document.querySelector(`article[data-message-id="${id}"]`) as HTMLElement;

const seeded = () => {
  const state = seedState();
  const at = new Date().toISOString();
  state.messages.push(
    {
      id: "m-reply",
      channelId: ENG_ID,
      threadId: "m-1",
      author: { type: "agent", id: ADA_ID },
      body: "zebra na resposta",
      mentionedAgentIds: [],
      agentRunId: null,
      createdAt: at,
    },
    {
      id: "m-general",
      channelId: GENERAL_ID,
      threadId: null,
      author: { type: "agent", id: ADA_ID },
      body: "uma Zebra no general",
      mentionedAgentIds: [],
      agentRunId: null,
      createdAt: at,
    },
  );
  return state;
};

describe("the header search (Discord's)", () => {
  test("Esc in the box closes the results and keeps the words", async () => {
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seeded()) });
    await settle(6);
    await typeIn("zebra");
    await enter();
    expect(results()).toBeTruthy();
    await act(async () => fireEvent.keyDown(box(), { key: "Escape" }));
    await settle(2);
    expect(results()).toBeNull();
    expect(box().value).toBe("zebra");
  });

  test("focused: the filters with an example, the rest folded under Mais filtros; de: lists agents, then people", async () => {
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seedState()) });
    await settle(6);
    // It starts in this channel, a small chip the person may remove; then it is the whole workspace's.
    const header = document.querySelector(".channel__header") as HTMLElement;
    expect(header.querySelector(".ac-token--sm")?.textContent).toBe("em: #eng");
    expect(box().getAttribute("placeholder")).toBe("");
    await act(async () => fireEvent.keyDown(box(), { key: "Backspace" }));
    expect(header.querySelector(".ac-token")).toBeNull();
    expect(box().getAttribute("placeholder")).toBe("Buscar em Acme");
    await act(async () => fireEvent.focus(box()));
    const menu = screen().getByRole("listbox", { name: "Opções de busca" });
    expect(within(menu).getByRole("option", { name: /De uma pessoa ou agente\s*de: nome/ })).toBeTruthy();
    expect(within(menu).queryByRole("option", { name: /Antes de uma data/ })).toBeNull();
    await act(async () => fireEvent.click(within(menu).getByRole("option", { name: /Mais filtros/ })));
    expect(screen().getByRole("option", { name: /Antes de uma data/ })).toBeTruthy();

    await typeIn("de:");
    const headings = [...document.querySelectorAll(".search-menu .ac-menu__heading")].map((h) => h.textContent);
    expect(headings).toEqual(["Agentes", "Pessoas"]);
    expect(screen().getByRole("option", { name: /^Ada/ })).toBeTruthy();
  });

  test("Enter floats the results over the window, words marked; Ir para shows the message and closes them", async () => {
    const state = seeded();
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(6);
    await typeIn("achei");
    expect(results()).toBeNull();
    await enter();
    const panel = results() as HTMLElement;
    expect(panel.className).toContain("thread-panel");
    expect(panel.previousElementSibling?.className).toBe("thread-panel__scrim");
    // The conversation is under the scrim, out of reach until the panel closes.
    expect((document.querySelector(".channel__col") as HTMLElement).closest("[inert]")).toBeTruthy();
    expect(within(panel).getByRole("heading", { level: 1 }).textContent).toBe("1 resultado");
    const group = within(panel).getByRole("region", { name: "eng" });
    expect([...group.querySelectorAll(".search-hit__mark")].map((m) => m.textContent)).toEqual(["Achei"]);
    await act(async () => fireEvent.click(within(group).getByRole("button", { name: "Ir para a mensagem de Ada" })));
    await settle(4);
    expect(results()).toBeNull();
    expect(row("m-2").classList.contains("ac-msg--focus")).toBe(true);
    expect((document.querySelector(".channel__col") as HTMLElement).inert).toBe(false);
    // The words stay in the field: Enter brings the results back.
    expect(box().value).toBe("achei");
    await enter();
    expect(results()).toBeTruthy();
  });

  // Many renders/tool calls in one test: over 5 s on a loaded CI runner, well under alone.
  test("a message older than what's loaded: the conversation pages back to it, the buttons waiting meanwhile, then they close", async () => {
    const state = seedState();
    const at = Date.now() - 3_600_000;
    for (let i = 0; i < 400; i++)
      state.messages.push({
        id: `h-${i}`,
        channelId: GENERAL_ID,
        threadId: null,
        author: { type: "agent", id: ADA_ID },
        body: i === 3 ? "a agulha no palheiro" : `Mensagem ${i}`,
        mentionedAgentIds: [],
        agentRunId: null,
        createdAt: new Date(at + i * 1000).toISOString(),
      });
    const api = createFakeApi(state);
    await renderApp(`/org/${ORG_ID}/c/${GENERAL_ID}`, { api });
    await settle(6);
    expect(row("h-3")).toBeNull();
    await typeIn("agulha");
    await enter();
    const jump = within(results() as HTMLElement).getByRole("button", { name: "Ir para a mensagem de Ada" });
    const load = api.chat.messages.bind(api.chat);
    let release = () => {};
    const held = new Promise<void>((go) => {
      release = go;
    });
    const pages = spyOn(api.chat, "messages").mockImplementation(async (...args) => {
      await held;
      return load(...args);
    });
    await act(async () => fireEvent.click(jump));
    expect((jump as HTMLButtonElement).disabled).toBe(true);
    release();
    await waitFor(() => expect(row("h-3")?.classList.contains("ac-msg--focus")).toBe(true), { timeout: 10_000 });
    expect(pages.mock.calls.at(-1)?.[2]?.limit).toBe(200);
    expect(results()).toBeNull();
  }, 15_000);

  test("a message no longer there says so, and the results stay", async () => {
    const api = createFakeApi(seeded());
    const query = api.search.query.bind(api.search);
    spyOn(api.search, "query").mockImplementation(async (...args) =>
      (await query(...args)).map((h) => ({ ...h, messageId: "m-gone", sourceId: "m-gone" })),
    );
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(6);
    await typeIn("achei");
    await enter();
    const panel = results() as HTMLElement;
    await act(async () => fireEvent.click(within(panel).getByRole("button", { name: "Ir para a mensagem de Ada" })));
    await settle(8);
    expect(document.body.textContent).toContain("Não deu para chegar a essa mensagem aqui.");
    expect(results()).toBeTruthy();
  });

  test("a reply opens its thread over the results: back keeps them, Esc too, the × closes both", async () => {
    const { router } = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seeded()) });
    await settle(6);
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Remover em: #eng" })));
    await typeIn("zebra");
    await enter();
    const thread = () => screen().queryByRole("complementary", { name: "Thread" });
    const group = within(results() as HTMLElement).getByRole("region", { name: /^@ada o login está devolvendo 401/ });
    expect(group.textContent).toContain("thread em #eng");
    expect(within(results() as HTMLElement).getByRole("region", { name: "general" })).toBeTruthy();
    const goToReply = async () => {
      const panel = results() as HTMLElement;
      const reply = within(panel).getByRole("region", { name: /^@ada o login está devolvendo 401/ });
      await act(async () => fireEvent.click(within(reply).getByRole("button", { name: "Ir para a mensagem de Ada" })));
      await settle(6);
    };
    await goToReply();
    expect(row("m-reply").classList.contains("ac-msg--focus")).toBe(true);
    expect(within(thread() as HTMLElement).getByRole("heading", { level: 1 })).toBeTruthy();
    expect(router.state.location.search).toEqual({ thread: "m-1", tm: "m-reply" });

    await act(async () =>
      fireEvent.click(within(thread() as HTMLElement).getByRole("button", { name: "Voltar aos resultados" })),
    );
    await settle(2);
    expect(thread()).toBeNull();
    expect(results()).toBeTruthy();
    expect(router.state.location.search).toEqual({});

    await goToReply();
    await act(async () => fireEvent.keyDown(document.body, { key: "Escape" }));
    await settle(2);
    expect(thread()).toBeNull();
    expect(results()).toBeTruthy();

    await goToReply();
    const panes = thread() as HTMLElement;
    await act(async () =>
      fireEvent.click(
        within(panes.querySelector("section:not([hidden]) .thread-head") as HTMLElement).getByRole("button", {
          name: /^Fechar/,
        }),
      ),
    );
    await settle(2);
    expect(thread()).toBeNull();
    expect(results()).toBeNull();
  });

  test("a thread opened from the conversation replaces the results, and the results replace it", async () => {
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seeded()) });
    await settle(6);
    await typeIn("achei");
    await enter();
    expect(results()).toBeTruthy();
    const message = row("m-2");
    await act(async () => fireEvent.click(within(message).getByRole("button", { name: "Responder" })));
    await settle(6);
    expect(results()).toBeNull();
    expect(screen().getByRole("complementary", { name: "Thread" })).toBeTruthy();
    expect(screen().queryByRole("button", { name: "Voltar aos resultados" })).toBeNull();
    await enter();
    expect(screen().queryByRole("complementary", { name: "Thread" })).toBeNull();
    expect(results()).toBeTruthy();
  });

  test("a thread the URL opens stands alone, and the results take its place and the URL's", async () => {
    const { router } = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}?thread=m-1`, { api: createFakeApi(seeded()) });
    await settle(6);
    expect(screen().getByRole("complementary", { name: "Thread" })).toBeTruthy();
    expect(screen().queryByRole("button", { name: "Voltar aos resultados" })).toBeNull();
    await typeIn("achei");
    await enter();
    await settle(2);
    expect(screen().queryByRole("complementary", { name: "Thread" })).toBeNull();
    expect(results()).toBeTruthy();
    expect(router.state.location.search).toEqual({});
  });

  test("another conversation's hit: there with the results closed, the query kept, ready for the next", async () => {
    const { router } = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seeded()) });
    await settle(6);
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Remover em: #eng" })));
    await typeIn("zebra");
    await enter();
    const general = within(results() as HTMLElement).getByRole("region", { name: "general" });
    await act(async () => fireEvent.click(within(general).getByRole("button", { name: "Ir para a mensagem de Ada" })));
    await settle(8);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${GENERAL_ID}`);
    expect(router.state.location.search).toEqual({ m: "m-general" });
    expect(row("m-general").classList.contains("ac-msg--focus")).toBe(true);
    expect(results()).toBeNull();
    expect(box().value).toBe("zebra");

    // The next hit, a reply back in #eng: that channel with its thread over the results.
    await enter();
    const reply = within(results() as HTMLElement).getByRole("region", { name: /^@ada o login está devolvendo 401/ });
    await act(async () => fireEvent.click(within(reply).getByRole("button", { name: "Ir para a mensagem de Ada" })));
    await settle(8);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);
    expect(router.state.location.search).toEqual({ thread: "m-1", tm: "m-reply" });
    expect(row("m-reply").classList.contains("ac-msg--focus")).toBe(true);
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Voltar aos resultados" })));
    await settle(2);
    expect(results()).toBeTruthy();

    // Remembered: emptied, the box offers it under the recent searches.
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Limpar busca" })));
    await typeIn("");
    await act(async () => fireEvent.focus(box()));
    expect(screen().getByRole("option", { name: "zebra" })).toBeTruthy();
    // The trash forgets them.
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Limpar buscas recentes" })));
    expect(screen().queryByRole("option", { name: "zebra" })).toBeNull();
  });

  test("a hit newer than another conversation's cached page: found once the page refreshes, no false alarm", async () => {
    const state = seeded();
    const api = createFakeApi(state);
    const { services, router } = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(6);
    await services.queryClient.prefetchQuery(messagesQuery(api, ORG_ID, GENERAL_ID));
    await services.queryClient.invalidateQueries({ queryKey: keys.messages(ORG_ID, GENERAL_ID), refetchType: "none" });
    state.messages.push({
      id: "m-new",
      channelId: GENERAL_ID,
      threadId: null,
      author: { type: "agent", id: ADA_ID },
      body: "uma zebra recente",
      mentionedAgentIds: [],
      agentRunId: null,
      createdAt: new Date().toISOString(),
    });
    const load = api.chat.messages.bind(api.chat);
    spyOn(api.chat, "messages").mockImplementation(async (...args) => {
      if (!args[2]?.before && !args[2]?.threadId) await new Promise((r) => setTimeout(r, 60));
      return load(...args);
    });
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Remover em: #eng" })));
    await typeIn("recente");
    await enter();
    await act(async () =>
      fireEvent.click(within(results() as HTMLElement).getByRole("button", { name: "Ir para a mensagem de Ada" })),
    );
    await act(() => new Promise((r) => setTimeout(r, 200)));
    await settle(6);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${GENERAL_ID}`);
    expect(row("m-new").classList.contains("ac-msg--focus")).toBe(true);
    expect(document.body.textContent).not.toContain("Não deu para chegar a essa mensagem aqui.");
  });

  test("back from a hit's thread: the focus returns to its Ir para", async () => {
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seeded()) });
    await settle(6);
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Remover em: #eng" })));
    await typeIn("zebra");
    await enter();
    const group = within(results() as HTMLElement).getByRole("region", { name: /^@ada o login está devolvendo 401/ });
    const jump = within(group).getByRole("button", { name: "Ir para a mensagem de Ada" });
    jump.focus();
    await act(async () => fireEvent.click(jump));
    await settle(6);
    const back = screen().getByRole("button", { name: "Voltar aos resultados" });
    back.focus();
    await act(async () => fireEvent.click(back));
    await settle(2);
    expect(document.activeElement).toBe(jump);
  });

  test("Ver em #canal in a hit's thread closes the results too", async () => {
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seeded()) });
    await settle(6);
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Remover em: #eng" })));
    await typeIn("zebra");
    await enter();
    const group = within(results() as HTMLElement).getByRole("region", { name: /^@ada o login está devolvendo 401/ });
    await act(async () => fireEvent.click(within(group).getByRole("button", { name: "Ir para a mensagem de Ada" })));
    await settle(6);
    const pane = screen().getByRole("complementary", { name: "Thread" });
    const more = within(pane).getByRole("button", { name: "Mais ações da thread" });
    more.focus();
    await act(async () => {
      fireEvent.keyDown(more, { key: "Enter" });
      fireEvent.keyUp(more, { key: "Enter" });
    });
    await settle(1);
    await act(async () => fireEvent.click(screen().getByRole("menuitem", { name: "Ver em #eng" })));
    await settle(4);
    expect(screen().queryByRole("complementary", { name: "Thread" })).toBeNull();
    expect(results()).toBeNull();
    expect(row("m-1").classList.contains("ac-msg--focus")).toBe(true);
  });

  test("a DM's hit: there with the results closed, the words kept; Enter brings them back, the × closes them", async () => {
    const state = seeded();
    const dm = seedDm(state, { type: "agent", id: ADA_ID }, { body: "uma zebra na DM" });
    const { router } = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle(6);
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Remover em: #eng" })));
    await typeIn("zebra");
    await enter();
    const inDm = within(results() as HTMLElement).getByRole("region", { name: "DM com Ada" });
    await act(async () => fireEvent.click(within(inDm).getByRole("button", { name: "Ir para a mensagem de Ada" })));
    await settle(8);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/dm/agent/${ADA_ID}`);
    expect(row(`m-${dm}`).classList.contains("ac-msg--focus")).toBe(true);
    expect(results()).toBeNull();
    expect(box().value).toBe("zebra");
    await enter();
    const panel = results() as HTMLElement;
    expect(within(panel).getByRole("region", { name: "DM com Ada" })).toBeTruthy();
    await act(async () => fireEvent.click(within(panel).getByRole("button", { name: "Fechar" })));
    await settle(4);
    expect(results()).toBeNull();
  });

  test("moving to another channel scopes an untouched search there; words typed keep the search as it is", async () => {
    const api = createFakeApi(seedState());
    const query = spyOn(api.search, "query");
    const { router } = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(6);
    const chip = () => document.querySelector(".channel__header .ac-token")?.textContent;
    expect(chip()).toBe("em: #eng");
    // The starting chip alone runs no search until the results show.
    expect(query).not.toHaveBeenCalled();
    await act(() =>
      router.navigate({ to: "/org/$orgId/c/$channelId", params: { orgId: ORG_ID, channelId: GENERAL_ID } }),
    );
    await settle(6);
    expect(chip()).toBe("em: #general");
    await typeIn("zebra");
    await act(() => router.navigate({ to: "/org/$orgId/c/$channelId", params: { orgId: ORG_ID, channelId: ENG_ID } }));
    await settle(6);
    expect(chip()).toBe("em: #general");
  });

  test("Mais filtros opens from the keyboard too", async () => {
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seedState()) });
    await settle(6);
    await act(async () => fireEvent.focus(box()));
    const active = () => document.getElementById(box().getAttribute("aria-activedescendant") ?? "")?.textContent ?? "";
    for (let i = 0; i < 20 && !active().includes("Mais filtros"); i++)
      await act(async () => fireEvent.keyDown(box(), { key: "ArrowDown" }));
    expect(active()).toContain("Mais filtros");
    await act(async () => fireEvent.keyDown(box(), { key: "Enter" }));
    expect(screen().getByRole("option", { name: /Antes de uma data/ })).toBeTruthy();
  });

  test("on a phone, the search icon opens it over the whole screen; Enter shows the results in the panel", async () => {
    const media = spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: query === "(max-width: 760px)",
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList,
    );
    try {
      await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seeded()) });
      await settle(6);
      const header = document.querySelector(".channel__header") as HTMLElement;
      expect(within(header).queryByRole("combobox")).toBeNull();
      await act(async () => fireEvent.click(within(header).getByRole("button", { name: "Buscar" })));
      await settle(2);
      const sheet = screen().getByRole("dialog", { name: "Buscar" });
      expect(sheet.getAttribute("aria-modal")).toBe("true");
      const field = within(sheet).getByRole("combobox", { name: "Buscar" });
      expect(document.activeElement === field).toBe(true);
      await act(async () => fireEvent.change(field, { target: { value: "zebra" } }));
      await act(async () => fireEvent.keyDown(field, { key: "Enter" }));
      await act(() => new Promise((r) => setTimeout(r, 300)));
      await settle(4);
      expect(screen().queryByRole("dialog", { name: "Buscar" })).toBeNull();
      expect(results()?.textContent).toContain("zebra na resposta");
      // The results' head is icons only: the filters, the sort as a menu.
      const panel = results() as HTMLElement;
      expect(within(panel).getByRole("button", { name: /^Filtros/ }).textContent).toBe("");
      expect(within(panel).queryByRole("combobox", { name: "Ordenar" })).toBeNull();
      expect(within(panel).getByRole("button", { name: "Ordenar" })).toBeTruthy();
    } finally {
      media.mockRestore();
    }
  });

  test("on a phone, Esc closes the search sheet and the focus is back on the search icon", async () => {
    const media = spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: query === "(max-width: 760px)",
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList,
    );
    try {
      await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(seeded()) });
      await settle(6);
      const header = document.querySelector(".channel__header") as HTMLElement;
      const icon = within(header).getByRole("button", { name: "Buscar" });
      icon.focus();
      await act(async () => fireEvent.click(icon));
      await settle(2);
      const field = within(screen().getByRole("dialog", { name: "Buscar" })).getByRole("combobox", { name: "Buscar" });
      expect(
        (screen().getByRole("main") as HTMLElement).querySelector(".chat-messages, .ac-msg")?.closest("[inert]"),
      ).toBeTruthy();
      // The first Esc closes the open menu, the next one the sheet.
      await act(async () => fireEvent.keyDown(field, { key: "Escape" }));
      await act(async () => fireEvent.keyDown(field, { key: "Escape" }));
      await settle(1);
      expect(screen().queryByRole("dialog", { name: "Buscar" })).toBeNull();
      expect(document.activeElement === icon).toBe(true);
    } finally {
      media.mockRestore();
    }
  });
});

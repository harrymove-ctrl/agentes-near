import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { channelQuery, trackInput } from "@agenteschat/ui";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ENG_ID, GENERAL_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const go = async (path: string, state = seedState()) => {
  const r = await renderApp(`/org/${ORG_ID}/${path}`, { api: createFakeApi(state) });
  await settle(8);
  return { ...r, state };
};
const typeIn = (el: HTMLTextAreaElement, value: string) =>
  act(async () => {
    fireEvent.change(el, { target: { value, selectionStart: value.length, selectionEnd: value.length } });
  });
const keyDown = (el: Element, key: string) => act(async () => fireEvent.keyDown(el, { key }));
const composer = () => screen().getByRole("combobox", { name: /Mensagem para/ }) as HTMLTextAreaElement;
const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

/** The seed plus one message of João in #general with `body` (and `meta`). */
const withMessage = (body: string, meta?: Record<string, unknown>) => {
  const state = seedState();
  state.messages.push({
    id: "m-ref",
    channelId: GENERAL_ID,
    threadId: null,
    author: { type: "person", id: "u-joao" },
    body,
    mentionedAgentIds: [],
    agentRunId: null,
    ...(meta ? { meta } : {}),
    createdAt: new Date().toISOString(),
  });
  return state;
};

describe("#channel autocomplete", () => {
  test("query right before the caret", () => {
    expect(channelQuery("veja #en", 8)).toEqual({ start: 5, query: "en" });
    expect(channelQuery("#", 1)).toEqual({ start: 0, query: "" });
    expect(channelQuery("a#b", 3)).toBeNull();
    expect(channelQuery("#eng ", 5)).toBeNull();
  });

  test("filters as you type; arrows and Enter insert #name + space", async () => {
    await go(`c/${GENERAL_ID}`);
    const box = composer();
    await typeIn(box, "veja #");
    const list = screen().getByRole("listbox", { name: "Canais" });
    const options = within(list).getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[0]?.textContent).toContain("#eng");
    expect(options[0]?.textContent).toContain("Código, erros e deploys");
    expect(options[1]?.textContent).toContain("#general");
    await keyDown(box, "ArrowDown");
    expect(box.getAttribute("aria-activedescendant")).toBe(options[1]?.id ?? null);
    await typeIn(box, "veja #ge");
    expect(within(screen().getByRole("listbox", { name: "Canais" })).getAllByRole("option")).toHaveLength(1);
    await keyDown(box, "Enter");
    expect(box.value).toBe("veja #general ");
    expect(box.getAttribute("aria-expanded")).toBe("false");
  });

  test("Esc closes the list until another # is typed", async () => {
    await go(`c/${GENERAL_ID}`);
    const box = composer();
    await typeIn(box, "#e");
    await keyDown(box, "Escape");
    expect(box.getAttribute("aria-expanded")).toBe("false");
    await typeIn(box, "#en");
    expect(box.getAttribute("aria-expanded")).toBe("false");
    await typeIn(box, "#en #g");
    expect(box.getAttribute("aria-expanded")).toBe("true");
  });
});

describe("@mention autocomplete", () => {
  test("Enter on a name typed in full picks it and posts nothing; the next Enter sends", async () => {
    const { state } = await go(`c/${GENERAL_ID}`);
    const box = composer();
    await typeIn(box, "oi @ada");
    expect(screen().getByRole("listbox", { name: "Pessoas e agentes" })).toBeTruthy();
    await keyDown(box, "Enter");
    expect(box.value).toBe("oi @ada ");
    expect(box.getAttribute("aria-expanded")).toBe("false");
    expect(state.calls.filter((c) => c.method === "chat.post")).toHaveLength(0);
    await typeIn(box, "oi @ada pode revisar?");
    await keyDown(box, "Enter");
    await settle(4);
    expect(
      state.calls.filter((c) => c.method === "chat.post").map((c) => (c.args[2] as { body: string }).body),
    ).toEqual(["oi @ada pode revisar?"]);
  });
});

describe("#channel links in messages", () => {
  test("a #name of a channel I see links to it (any case); code and other words stay text", async () => {
    await go(`c/${GENERAL_ID}`, withMessage("Leva para #ENG, não `#eng` nem #nada"));
    const link = screen().getByRole("link", { name: "Canal #eng" });
    expect(link.getAttribute("href")).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);
    expect(link.textContent).toBe("#eng");
    const text = link.closest(".ac-msg__text")?.textContent ?? "";
    expect(text).toContain("#nada");
    expect(screen().queryByRole("link", { name: "Canal #nada" })).toBeNull();
    expect(link.closest(".ac-msg__text")?.querySelector("code")?.textContent).toBe("#eng");
  });

  test("the stored channel wins: a renamed channel shows its new name; one I can't see stays plain text", async () => {
    const state = withMessage("Entregue em #engenharia e #segredo", {
      channelRefs: { engenharia: ENG_ID, segredo: "00000000-0000-4000-8000-0000000000ff" },
    });
    await go(`c/${GENERAL_ID}`, state);
    await settle(4);
    expect(screen().getByRole("link", { name: "Canal #eng" }).textContent).toBe("#eng");
    expect(screen().queryByRole("link", { name: /segredo/ })).toBeNull();
    expect(screen().getByText(/#segredo/)).toBeTruthy();
  });

  test("hovering shows the card: topic, counts, membership and Open", async () => {
    await go(`c/${GENERAL_ID}`, withMessage("veja #eng"));
    const link = screen().getByRole("link", { name: "Canal #eng" });
    await act(async () => fireEvent.pointerEnter(link, { pointerType: "mouse" }));
    await wait(450);
    await settle(4);
    const card = screen().getByRole("dialog", { name: "Sobre #eng" });
    expect(card.textContent).toContain("Código, erros e deploys");
    expect(card.textContent).toContain("2 pessoas · 2 agentes · você participa");
    expect(within(card).getByRole("button", { name: "Abrir" })).toBeTruthy();
    expect(within(card).queryByRole("button", { name: "Entrar" })).toBeNull();
  });

  test("a click on the link opens the channel, also while its hover card shows", async () => {
    const { router } = await go(`c/${GENERAL_ID}`, withMessage("veja #eng"));
    const link = screen().getByRole("link", { name: "Canal #eng" });
    await act(async () => fireEvent.pointerEnter(link, { pointerType: "mouse" }));
    await wait(450);
    await settle(4);
    expect(screen().getByRole("dialog", { name: "Sobre #eng" })).toBeTruthy();
    await act(async () => fireEvent.click(link, { button: 0 }));
    await settle(6);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);
    expect(screen().queryByRole("dialog", { name: "Sobre #eng" })).toBeNull();
  });

  test("from the keyboard: focus shows the card, ArrowDown moves into it and Tab reaches Open", async () => {
    await go(`c/${GENERAL_ID}`, withMessage("veja #eng"));
    const link = screen().getByRole("link", { name: "Canal #eng" });
    // Focus a script hands back (a panel closing) opens nothing; the keys' does.
    trackInput();
    // Other test files in the same process may have pressed keys: start from a press, as a page load with the mouse would.
    fireEvent.pointerDown(document.body, { pointerType: "mouse" });
    await act(async () => link.focus());
    await settle(4);
    expect(screen().queryByRole("dialog", { name: "Sobre #eng" })).toBeNull();
    await act(async () => link.blur());
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "Tab" });
      link.focus();
      fireEvent.keyUp(document.body, { key: "Tab" });
    });
    await keyDown(link, "ArrowDown");
    await settle(4);
    const card = screen().getByRole("dialog", { name: "Sobre #eng" });
    expect(card.contains(document.activeElement)).toBe(true);
    await wait(250);
    expect(screen().getByRole("dialog", { name: "Sobre #eng" })).toBeTruthy();
    expect(document.activeElement?.textContent).toBe("Abrir");
    await act(async () => fireEvent.pointerDown(document.body));
  });
});

describe("an archived #channel", () => {
  test("its card offers Restaurar to who may bring it back, which opens it again", async () => {
    const state = withMessage("veja #lancamento", { channelRefs: { lancamento: "ch-old" } });
    state.archivedChannels = [
      { id: "ch-old", name: "lancamento", topic: "", visibility: "public", archivedAt: "2026-11-01T12:00:00.000Z" },
    ];
    const api = createFakeApi(state);
    const card = api.chat.card;
    api.chat.card = async (orgId, channelId) =>
      channelId === "ch-old"
        ? {
            id: "ch-old",
            name: "lancamento",
            topic: "",
            visibility: "public",
            isMember: true,
            archived: true,
            people: 1,
            agents: 0,
          }
        : card(orgId, channelId);
    const { router } = await renderApp(`/org/${ORG_ID}/c/${GENERAL_ID}`, { api });
    await settle(8);
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Canal #lancamento, arquivado" })));
    await settle(6);
    const sheet = screen().getByRole("dialog", { name: "Sobre #lancamento" });
    await act(async () => fireEvent.click(within(sheet).getByRole("button", { name: "Restaurar" })));
    await settle(6);
    expect(state.calls.find((c) => c.method === "chat.unarchive")?.args).toEqual([ORG_ID, "ch-old"]);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/ch-old`);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import {
  ADA_ID,
  createFakeApi,
  type FakeState,
  GENERAL_ID,
  LODI_ID,
  ORG_ID,
  seedDm,
  seedState,
  withRightHand,
} from "./fake-api";
import { renderApp, screen, settle } from "./render";

/** A DM's header: who it is with as one button to their profile, and the channel's search held to the DM. */

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const go = async (state: FakeState, path: string) => {
  await renderApp(`/org/${ORG_ID}/${path}`, { api: createFakeApi(state) });
  await settle(8);
  return document.querySelector(".channel__header") as HTMLElement;
};
const click = async (el: Element, rounds = 6) => {
  await act(async () => fireEvent.click(el));
  await settle(rounds);
};

describe("who the DM is with, one button", () => {
  test("an agent's opens its page in the panel; no Ver perfil beside it; the name stays the heading", async () => {
    const header = await go(seedState(), `dm/agent/${ADA_ID}`);
    expect(within(header).getByRole("heading", { level: 1, name: "Ada" })).toBeTruthy();
    expect(within(header).queryByRole("button", { name: "Ver perfil" })).toBeNull();
    await click(within(header).getByRole("button", { name: "Perfil de Ada" }));
    expect(screen().getByRole("complementary", { name: "Perfil da Ada" })).toBeTruthy();
  });

  test("a person's opens their profile card, as their name in a message does", async () => {
    const header = await go(seedState(), "dm/person/u-joao");
    await click(within(header).getByRole("button", { name: "Perfil de João" }));
    const card = screen().getByRole("dialog", { name: "Perfil" });
    expect(card.textContent).toContain("João");
  });
});

describe("the header's glyphs, one group after who it is with", () => {
  test("an agent's: the face and the name, then the search and the side panel's toggle, in an action line", async () => {
    const header = await go(seedState(), `dm/agent/${ADA_ID}`);
    const line = header.querySelector(":scope > .ac-actline.channel__line") as HTMLElement;
    expect(header.querySelectorAll(":scope > :not(.nav-toggle, .channel__line)")).toHaveLength(0);
    expect(line.firstElementChild?.matches(".dm-who")).toBe(true);
    const acts = line.querySelector(":scope > .channel__acts") as HTMLElement;
    expect(line.lastElementChild).toBe(acts);
    expect(within(acts).getByRole("combobox", { name: "Buscar" })).toBeTruthy();
    expect(within(acts).getByRole("button", { name: "Detalhes" }).classList.contains("dm-side-toggle")).toBe(true);
  });

  test("a person's: the face, the name and the email, then the search", async () => {
    const header = await go(seedState(), "dm/person/u-joao");
    const acts = header.querySelector(":scope > .channel__line > .channel__acts") as HTMLElement;
    expect(within(acts).getByRole("combobox", { name: "Buscar" })).toBeTruthy();
    expect(header.querySelector(".dm-who .channel__topic")?.textContent).toBe("joao@acme.com.br");
  });
});

describe("the DM's search is the channel's, held to the DM", () => {
  const seeded = () => {
    const state = seedState();
    const dm = seedDm(state, { type: "agent", id: ADA_ID }, { body: "zebra na DM" });
    state.messages.push({
      id: "m-general",
      channelId: GENERAL_ID,
      threadId: null,
      author: { type: "agent", id: ADA_ID },
      body: "uma zebra no general",
      mentionedAgentIds: [],
      agentRunId: null,
      createdAt: new Date().toISOString(),
    });
    return { state, dm };
  };

  test("the field with no chip to remove and no who or where; Enter finds only the DM's messages", async () => {
    const { state, dm } = seeded();
    const header = await go(state, `dm/agent/${ADA_ID}`);
    expect(within(header).queryByRole("link", { name: "Buscar nesta conversa" })).toBeNull();
    const box = within(header).getByRole("combobox", { name: "Buscar" }) as HTMLInputElement;
    expect(header.querySelector(".ac-token")).toBeNull();
    expect(box.getAttribute("placeholder")).toBe("Buscar nesta conversa");
    await act(async () => fireEvent.focus(box));
    const menu = screen().getByRole("listbox", { name: "Opções de busca" });
    expect(within(menu).queryByRole("option", { name: /De uma pessoa ou agente/ })).toBeNull();
    expect(within(menu).queryByRole("option", { name: /Enviada em um canal ou DM/ })).toBeNull();
    expect(within(menu).getByRole("option", { name: /Com link, arquivo, imagem ou cartão/ })).toBeTruthy();
    await click(within(menu).getByRole("option", { name: /Mais filtros/ }), 1);
    expect(screen().getByRole("option", { name: /Antes de uma data/ })).toBeTruthy();
    expect(screen().queryByRole("option", { name: /Escrita por pessoas ou por agentes/ })).toBeNull();

    await act(async () => fireEvent.change(box, { target: { value: "zebra" } }));
    await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
    await act(() => new Promise((r) => setTimeout(r, 300)));
    await settle(4);
    const panel = screen().getByRole("complementary", { name: "Resultados da busca" });
    expect(panel.textContent).toContain("zebra na DM");
    expect(panel.textContent).not.toContain("uma zebra no general");
    // Ir para lands on the message in the DM, the results closing over it.
    await click(within(panel).getByRole("button", { name: "Ir para a mensagem de Ada" }));
    expect(screen().queryByRole("complementary", { name: "Resultados da busca" })).toBeNull();
    const row = document.querySelector(`article[data-message-id="m-${dm}"]`);
    expect(row?.classList.contains("ac-msg--focus")).toBe(true);
  });

  test("a DM opened for the first time, after the DM list loaded, holds its search to it too", async () => {
    const { state } = seeded();
    const { router } = await renderApp(`/org/${ORG_ID}/c/${GENERAL_ID}`, { api: createFakeApi(state) });
    await settle(8);
    await act(() =>
      router.navigate({ to: "/org/$orgId/dm/person/$userId", params: { orgId: ORG_ID, userId: "u-joao" } }),
    );
    await settle(8);
    const header = document.querySelector(".channel__header") as HTMLElement;
    const box = within(header).getByRole("combobox", { name: "Buscar" }) as HTMLInputElement;
    await act(async () => fireEvent.change(box, { target: { value: "zebra" } }));
    await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
    await act(() => new Promise((r) => setTimeout(r, 300)));
    await settle(4);
    const panel = screen().getByRole("complementary", { name: "Resultados da busca" });
    expect(panel.textContent).not.toContain("uma zebra no general");
  });
});

describe("where Lodi's name comes from", () => {
  const story = "O nome vem de lodestar, a estrela que guia os navegantes.";
  const cardOf = async (state: FakeState) => {
    seedDm(state, { type: "agent", id: LODI_ID });
    await go(state, `dm/agent/${LODI_ID}`);
    await click(document.querySelector("article .profile-trigger--name") as HTMLElement);
    return screen().getByRole("dialog", { name: "Perfil" });
  };

  test("its profile card and its page tell it while it keeps its name", async () => {
    const card = await cardOf(withRightHand(seedState()));
    expect(card.textContent).toContain(story);
    cleanup();
    const header = await go(withRightHand(seedState()), `dm/agent/${LODI_ID}`);
    await click(within(header).getByRole("button", { name: "Perfil de Lodi" }));
    expect(document.body.textContent).toContain(story);
  });

  test("renamed, it has another story: none is told", async () => {
    const card = await cardOf(withRightHand(seedState(), { name: "Tuca", handle: "tuca" }));
    expect(card.textContent).toContain("Tuca");
    expect(card.textContent).not.toContain(story);
  });
});

describe("the profile in the panel closes", () => {
  const PANEL = { name: "Perfil da Ada" };
  const openAda = async (state = seedState()) => {
    const header = await go(state, `dm/agent/${ADA_ID}`);
    const trigger = within(header).getByRole("button", { name: "Perfil de Ada" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    trigger.focus();
    await click(trigger);
    return { trigger, panel: screen().getByRole("complementary", PANEL) };
  };

  test("by Esc inside it: it had the focus, the trigger gets it back", async () => {
    const { trigger, panel } = await openAda();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(panel);
    await act(async () => fireEvent.keyDown(panel, { key: "Escape" }));
    await settle(2);
    expect(screen().queryByRole("complementary", PANEL)).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  test("by its trigger again, and by its × at the top", async () => {
    const { trigger } = await openAda();
    await click(trigger);
    expect(screen().queryByRole("complementary", PANEL)).toBeNull();
    await click(trigger);
    const panel = screen().getByRole("complementary", PANEL);
    const close = within(panel).getByRole("button", { name: "Fechar" });
    expect(close.classList.contains("thread-panel__close")).toBe(true);
    expect(within(panel).getAllByRole("button", { name: "Fechar" })).toHaveLength(1);
    await click(close);
    expect(screen().queryByRole("complementary", PANEL)).toBeNull();
  });

  test("an agent's public card closes too, by its ×, and by a click on its scrim", async () => {
    const state = seedState();
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada) ada.seesDetails = false;
    const { trigger, panel } = await openAda(state);
    await click(within(panel).getByRole("button", { name: "Fechar" }));
    expect(screen().queryByRole("complementary", PANEL)).toBeNull();
    await click(trigger);
    await click(screen().getByRole("complementary", PANEL).previousElementSibling as HTMLElement);
    expect(screen().queryByRole("complementary", PANEL)).toBeNull();
  });

  test("Lodi's, for an admin (its settings, no tabs): its × and Esc close it", async () => {
    const state = withRightHand(seedState());
    seedDm(state, { type: "agent", id: LODI_ID });
    const header = await go(state, `dm/agent/${LODI_ID}`);
    const trigger = within(header).getByRole("button", { name: "Perfil de Lodi" });
    await click(trigger);
    const panel = () => screen().queryByRole("complementary", { name: /Lodi/ });
    await click(within(panel() as HTMLElement).getByRole("button", { name: "Fechar" }));
    expect(panel()).toBeNull();
    await click(trigger);
    await act(async () => fireEvent.keyDown(panel() as HTMLElement, { key: "Escape" }));
    await settle(2);
    expect(panel()).toBeNull();
  });
});

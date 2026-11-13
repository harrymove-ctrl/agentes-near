import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Message } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const openMenu = async (trigger: HTMLElement) => {
  trigger.focus();
  await act(async () => {
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.keyUp(trigger, { key: "Enter" });
  });
  await act(() => new Promise((r) => setTimeout(r, 0)));
  return screen().getByRole("menu");
};
const panel = () => screen().queryByRole("complementary", { name: "Thread" });

test("a pinned reply opens its thread in the panel; Ver em #eng closes it and highlights the thread's message here", async () => {
  const state = seedState();
  const reply: Message = {
    id: "m-reply",
    channelId: ENG_ID,
    threadId: "m-1",
    author: { type: "agent", id: ADA_ID },
    body: "Corrigido no refresh",
    mentionedAgentIds: [],
    agentRunId: null,
    createdAt: new Date().toISOString(),
  };
  state.messages.push(reply);
  const api = createFakeApi(state);
  const pin = {
    messageId: reply.id,
    channelId: ENG_ID,
    threadId: "m-1",
    pinnedByUserId: "u-joao",
    pinnedAt: "2026-11-01T10:00:00.000Z",
    message: reply,
  };
  api.pins = { list: async () => [pin], pin: async () => ({}) as never, unpin: async () => {} };
  const { router } = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
  await settle(8);

  await click(screen().getByRole("button", { name: /^Mensagens fixadas \(/ }));
  await settle(2);
  const list = screen().getByRole("dialog", { name: "Mensagens fixadas em #eng" });
  await click(list.querySelector(".thread-pop__row") as HTMLElement);
  await settle(6);
  const side = panel() as HTMLElement;
  expect(side).toBeTruthy();

  const menu = await openMenu(within(side).getByRole("button", { name: "Mais ações da thread" }));
  await click(within(menu).getByRole("menuitem", { name: "Ver em #eng" }));
  await settle(4);
  expect(panel()).toBeNull();
  // The channel stays where it is: no navigation, the thread's message scrolled to and highlighted.
  expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);
  expect(router.state.location.search).toEqual({});
  const root = document.querySelector('article[data-message-id="m-1"]') as HTMLElement;
  expect(root.classList.contains("ac-msg--focus")).toBe(true);
});

import { afterEach, expect, spyOn, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Message } from "@agenteschat/client";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { DESKTOP_QUERY } from "@/components/NavDrawer";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

let media: { mockRestore: () => void } | null = null;
afterEach(() => {
  cleanup();
  media?.mockRestore();
  media = null;
  localStorage.clear();
});

const click = (el: Element) => act(async () => fireEvent.click(el));
const thread = () => screen().queryByRole("complementary", { name: "Thread" });
const members = () => screen().queryByRole("complementary", { name: "Membros de #eng" });

/** A desktop, #eng open, and a thread opened from its pinned reply. */
async function openThread() {
  media = spyOn(window, "matchMedia").mockImplementation(
    (q: string) =>
      ({
        matches: q === DESKTOP_QUERY,
        media: q,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
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
  const { router, services } = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
  await settle(8);
  expect(members()).toBeTruthy();
  await click(screen().getByRole("button", { name: /^Mensagens fixadas \(/ }));
  await settle(2);
  const list = screen().getByRole("dialog", { name: "Mensagens fixadas em #eng" });
  await click(list.querySelector(".thread-pop__row") as HTMLElement);
  await settle(6);
  return { router, services };
}

test("a thread floats over a scrim: everything behind it is out of reach, the toasts aside, until its × closes it", async () => {
  const { router, services } = await openThread();
  const side = thread() as HTMLElement;
  expect(side).toBeTruthy();
  expect(side.classList.contains("thread-panel")).toBe(true);
  // Its scrim right before it; the members column stays under both, so nothing moves behind the scrim.
  expect(side.previousElementSibling?.classList.contains("thread-panel__scrim")).toBe(true);
  expect(members()).toBeTruthy();
  // The sidebar, the conversation and the members are inert; the toasts (a Desfazer) stay live.
  const sidebar = document.querySelector(".sidebar") as HTMLElement;
  expect(sidebar.closest("[inert]")).toBeTruthy();
  expect((document.querySelector(".channel__col") as HTMLElement).closest("[inert]")).toBeTruthy();
  expect(side.closest("[inert]")).toBeNull();
  await act(async () => services.toasts.show("Salvo"));
  expect((document.querySelector(".ac-toasts") as HTMLElement).closest("[inert]")).toBeNull();
  // Its own page is one click away.
  expect(within(side).getByRole("button", { name: "Abrir em tela cheia" })).toBeTruthy();

  await click(within(side).getByRole("button", { name: "Fechar a thread" }));
  await settle(3);
  expect(thread()).toBeNull();
  expect(document.querySelector(".thread-panel__scrim")).toBeNull();
  expect(sidebar.closest("[inert]")).toBeNull();
  expect((document.querySelector(".channel__col") as HTMLElement).closest("[inert]")).toBeNull();
  expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);
});

test("a click on the scrim closes it, and so does Esc, the focus back where it was", async () => {
  await openThread();
  await click(document.querySelector(".thread-panel__scrim") as HTMLElement);
  await settle(3);
  expect(thread()).toBeNull();

  const reply = within(document.querySelector(".channel__col") as HTMLElement).getAllByRole("button", {
    name: "Responder",
  })[0] as HTMLElement;
  reply.focus();
  await click(reply);
  await settle(6);
  const side = thread() as HTMLElement;
  expect(side.contains(document.activeElement)).toBe(true);
  await act(async () => fireEvent.keyDown(document.activeElement as Element, { key: "Escape" }));
  await settle(3);
  expect(thread()).toBeNull();
  expect(document.activeElement).toBe(reply);
});

test("over the agent's page with unsaved edits, a click on the scrim asks first and keeps the page", async () => {
  await openThread();
  // From inside the thread: everything outside the panel is out of reach.
  await click(within(thread() as HTMLElement).getAllByRole("button", { name: "Perfil de Ada" })[0] as HTMLElement);
  await settle(6);
  const card = screen().getByRole("dialog", { name: "Perfil" });
  await act(async () =>
    fireEvent.pointerDown(within(card).getByRole("button", { name: "Mais" }), { button: 0, ctrlKey: false }),
  );
  await settle(2);
  await click(within(screen().getByRole("menu", { name: "Mais" })).getByRole("menuitem", { name: "Ver perfil" }));
  await settle(6);
  const side = screen().getByRole("complementary", { name: "Perfil da Ada" });
  // The agent's page took the thread's place in the one panel.
  expect(thread()).toBeNull();
  expect(document.querySelectorAll(".thread-panel")).toHaveLength(1);
  expect(document.querySelectorAll(".thread-panel__scrim")).toHaveLength(1);
  // Configurações is in the tabs' More menu (Radix opens it on pointer down).
  await act(async () =>
    fireEvent.pointerDown(within(side).getByRole("button", { name: /^Mais$/ }), { button: 0, ctrlKey: false }),
  );
  await settle(2);
  await click(within(screen().getByRole("menu", { name: "Mais" })).getByRole("menuitem", { name: /^Configurações/ }));
  await settle(4);
  await click(within(within(side).getByRole("group", { name: "Cor" })).getByRole("button", { name: "Rosa" }));
  await click(side.previousElementSibling as HTMLElement);
  await settle(2);
  expect(document.querySelector(".thread-panel--wide")).toBeTruthy();
  expect(screen().getByRole("button", { name: "Continuar editando" })).toBeTruthy();
});

test("in <body>, over everything: a page's entrance can't hold it inside the page, and a toast stays live", async () => {
  await openThread();
  const side = thread() as HTMLElement;
  // The panel and its scrim are the body's own children, as is the toasts' host; the app (#root's place) is inert.
  expect(side.parentElement).toBe(document.body);
  expect(side.previousElementSibling?.classList.contains("thread-panel__scrim")).toBe(true);
  expect((document.querySelector(".ac-toasts") as HTMLElement).parentElement).toBe(document.body);
  expect((document.querySelector(".shell") as HTMLElement).closest("[inert]")).toBeTruthy();
});

test("Ver perfil from a thread, then closed: the focus goes back to what opened the thread", async () => {
  await openThread();
  await click(document.querySelector(".thread-panel__scrim") as HTMLElement);
  await settle(3);
  const reply = within(document.querySelector(".channel__col") as HTMLElement).getAllByRole("button", {
    name: "Responder",
  })[0] as HTMLElement;
  reply.focus();
  await click(reply);
  // Responder takes the caret to the thread's composer a beat later (ThreadPage): a card opened before then would lose
  // the focus to it and close.
  await waitFor(() => expect(document.activeElement?.id).toBe("composer-m-1"));
  await click(within(thread() as HTMLElement).getAllByRole("button", { name: "Perfil de Ada" })[0] as HTMLElement);
  await settle(6);
  const card = screen().getByRole("dialog", { name: "Perfil" });
  await act(async () =>
    fireEvent.pointerDown(within(card).getByRole("button", { name: "Mais" }), { button: 0, ctrlKey: false }),
  );
  await settle(2);
  await click(within(screen().getByRole("menu", { name: "Mais" })).getByRole("menuitem", { name: "Ver perfil" }));
  await settle(6);
  // The menu that opened the agent's page is gone; closing the page brings the focus back to Responder.
  await click(document.querySelector(".thread-panel__scrim") as HTMLElement);
  await settle(4);
  expect(document.querySelector(".thread-panel")).toBeNull();
  expect(document.activeElement).toBe(reply);
});

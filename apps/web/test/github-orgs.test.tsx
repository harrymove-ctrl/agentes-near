import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { focusManager } from "@tanstack/react-query";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { setNavigateAway } from "@/lib/navigate";
import { service } from "./catalog";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

const KEY = "agentes.github-orgs";
const PAGE = "https://github.com/settings/connections/applications/client-id";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});

const click = (el: Element) => act(async () => fireEvent.click(el));
const backToTab = async () => {
  await act(async () => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
  await settle(4);
};
const reconnectDialog = () => screen().getByRole("dialog", { name: "Reconectar GitHub" });
const open = async (state = seedState(), search = "") => {
  await renderApp(`/org/${ORG_ID}/settings/connectors${search}`, { api: createFakeApi(state) });
  await settle(10);
  return state;
};
const openReconnect = async (state: ReturnType<typeof seedState>) => {
  await open(state);
  await click(screen().getByRole("button", { name: "Adicionar conector" }));
  await click(
    within(screen().getByRole("dialog", { name: "Adicionar conector" })).getByRole("button", {
      name: "GitHub, conectado",
    }),
  );
  await click(within(service("GitHub")).getByRole("button", { name: "Reconectar GitHub" }));
  await settle(4);
};

describe("Reconectar GitHub", () => {
  test("says which organizations it reaches, why the sign-in won't ask again, and links to GitHub's page", async () => {
    const state = seedState();
    state.githubAccess = { orgs: ["acme"], manageUrl: PAGE };
    await openReconnect(state);
    const dialog = reconnectDialog();
    expect(dialog.textContent).toContain("acme");
    expect(dialog.textContent).toContain("O GitHub só pergunta pelas organizações na primeira vez");
    const link = within(dialog).getByRole("link", { name: "Liberar organizações no GitHub" });
    expect(link.getAttribute("href")).toBe(PAGE);
    expect(link.getAttribute("target")).toBe("_blank");
  });

  test("back in the tab it says what changed, and that nothing did", async () => {
    const state = seedState();
    state.githubAccess = { orgs: ["acme"], manageUrl: PAGE };
    await openReconnect(state);
    const link = within(reconnectDialog()).getByRole("link", { name: "Liberar organizações no GitHub" });
    await click(link);
    await backToTab();
    expect(reconnectDialog().textContent).toContain("Nada mudou nas organizações.");
    state.githubAccess = { orgs: ["acme", "beta"], manageUrl: PAGE };
    await backToTab();
    expect(reconnectDialog().textContent).toContain("Agora também: beta.");
  });

  test("GitHub didn't answer: it says so, with a way to try again", async () => {
    const state = seedState();
    state.githubAccess = { orgs: null, manageUrl: PAGE };
    await openReconnect(state);
    const dialog = reconnectDialog();
    expect(dialog.textContent).toContain("Não deu para ler as organizações agora.");
    state.githubAccess = { orgs: ["acme"], manageUrl: PAGE };
    await click(within(dialog).getByRole("button", { name: "Tentar de novo" }));
    await settle(4);
    expect(reconnectDialog().textContent).toContain("acme");
  });

  test("on an API key there's no app page: it lists the organizations and offers no words about one", async () => {
    const state = seedState();
    state.githubAccess = { orgs: ["acme"], manageUrl: null };
    await openReconnect(state);
    const dialog = reconnectDialog();
    expect(dialog.textContent).toContain("acme");
    expect(dialog.textContent).not.toContain("O GitHub só pergunta");
  });

  test("the sign-in comes straight back: the dialog opens again and says nothing changed, never a silent refresh", async () => {
    const state = seedState();
    state.githubAccess = { orgs: ["acme"], manageUrl: PAGE };
    await openReconnect(state);
    const went: string[] = [];
    setNavigateAway((to) => went.push(to));
    await click(within(reconnectDialog()).getByRole("button", { name: "Continuar no GitHub" }));
    await settle(3);
    expect(went).toHaveLength(1);
    expect(sessionStorage.getItem(KEY)).toBe('["acme"]');
    cleanup();

    await open(state, "?connected=github&outcome=reconnected");
    await settle(4);
    expect(reconnectDialog().textContent).toContain("Nada mudou nas organizações.");
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });
});

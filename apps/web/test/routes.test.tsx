import { describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { afterEach } from "bun:test";
import { cleanup } from "@testing-library/react";
import {
  ADA_ID,
  ATLAS_ID,
  createFakeApi,
  ENG_ID,
  GENERAL_ID,
  ORG_ID,
  seedDm,
  seedState,
  withRightHand,
} from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("route guards", () => {
  test("signed out: / goes to sign-in (the landing page is its own site), or to sign-up on first run", async () => {
    const signedOut = (authConfig: { firstRun?: boolean }) => createFakeApi(seedState({ me: null, authConfig }));
    const { router } = await renderApp("/", { api: signedOut({}) });
    expect(router.state.location.pathname).toBe("/login");
    expect(screen().getByRole("heading", { name: "Oi. Qual é o seu e-mail?" })).toBeTruthy();
    cleanup();
    const first = await renderApp("/", { api: signedOut({ firstRun: true }) });
    expect(first.router.state.location.pathname).toBe("/signup");
  });

  test("signed in without organizations: / goes to onboarding", async () => {
    const state = seedState();
    if (state.me) state.me.organizations = [];
    const { router } = await renderApp("/", { api: createFakeApi(state) });
    expect(router.state.location.pathname).toBe("/onboarding");
    expect(screen().getByRole("heading", { name: "Para que você vai usar o agentes.chat?" })).toBeTruthy();
  });

  test("a workspace still being set up resumes in the onboarding for its owner, at its next step; never for someone invited", async () => {
    const as = (role: "owner" | "member") => {
      // Left at the older onboarding's agents step.
      const state = withRightHand(seedState({ agents: [] }));
      const onboarding = { step: "agents" as const, generalChannelId: GENERAL_ID };
      if (state.me) state.me.organizations = [{ id: ORG_ID, name: "Acme", role, onboarding }];
      return createFakeApi(state);
    };
    for (const path of ["/", `/org/${ORG_ID}`, `/org/${ORG_ID}/drive`]) {
      const { router } = await renderApp(path, { api: as("owner") });
      await settle(10);
      expect(router.state.location.pathname).toBe("/onboarding");
      // At what it does, its next step (ADR 0162): never the questions that would make another workspace.
      expect(screen().getByRole("heading", { name: "O que a Acme faz?" })).toBeTruthy();
      expect(screen().queryByRole("heading", { name: "Como se chama o seu workspace?" })).toBeNull();
      expect(screen().queryByRole("heading", { name: "Para que você vai usar o agentes.chat?" })).toBeNull();
      cleanup();
    }
    const { router } = await renderApp(`/org/${ORG_ID}/drive`, { api: as("member") });
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/drive`);
  });

  test("signed in: / → the organization → Início (ADR 0108)", async () => {
    const { router } = await renderApp("/", { api: createFakeApi() });
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/home`);
    expect(screen().getByRole("heading", { level: 1 }).textContent).toMatch(/, Walter$/);
    expect(screen().getByRole("navigation", { name: "Navegação do workspace" })).toBeTruthy();
  });

  test("/login when already signed in goes to the redirect target", async () => {
    const { router } = await renderApp(`/login?redirect=/org/${ORG_ID}/drive`, { api: createFakeApi() });
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/drive`);
  });

  test("a redirect back to a deep link keeps its query, out of the last parameter", async () => {
    const target = `/org/${ORG_ID}/agents/${ADA_ID}?tab=settings&sec=budget`;
    const { router } = await renderApp(`/login?redirect=${encodeURIComponent(target)}`, { api: createFakeApi() });
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/agents/${ADA_ID}`);
    expect(router.state.location.search).toEqual({ tab: "settings", sec: "budget" });
  });

  test("an email's Connect your AI: Início with the dialog open, and the address drops the request", async () => {
    const { router } = await renderApp(`/org/${ORG_ID}?connect=ai`, { api: createFakeApi() });
    await settle();
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/home`);
    expect(screen().getByRole("dialog", { name: "Conectar uma IA" })).toBeTruthy();
    expect(router.state.location.search).toEqual({});
  });

  test("open redirects are dropped", async () => {
    const { router } = await renderApp("/login?redirect=//evil.example", {
      api: createFakeApi(seedState({ me: null })),
    });
    expect(router.state.location.search).toEqual({});
  });

  test("an organization you're not in shows a designed state, not a crash", async () => {
    await renderApp("/org/someone-else/drive", { api: createFakeApi() });
    expect(screen().getByRole("heading", { name: "Você não faz parte deste workspace" })).toBeTruthy();
  });

  test("Threads: the page, and a thread that doesn't exist (designed states)", async () => {
    await renderApp(`/org/${ORG_ID}/threads`, { api: createFakeApi() });
    await settle();
    expect(screen().getByRole("heading", { level: 1, name: "Threads" })).toBeTruthy();
    expect(document.querySelector(".ac-pagehead__meta")?.textContent).toBe("Assuntos que saíram dos canais e das DMs.");
    expect(screen().getByText("Cada assunto na sua própria conversa")).toBeTruthy();
    // All teaches how a thread starts; the other tabs only say they're empty and lead back to All.
    expect(document.querySelector(".ac-empty__text")?.textContent).toBe(
      "Responda a uma mensagem para abrir uma thread, e o canal continua limpo.",
    );
    cleanup();
    for (const [tab, title] of [
      ["working", "Nenhum agente trabalhando agora"],
      ["closed", "Nada fechado por aqui"],
      ["archived", "Nenhuma thread arquivada"],
    ]) {
      await renderApp(`/org/${ORG_ID}/threads?tab=${tab}`, { api: createFakeApi() });
      await settle();
      const empty = document.querySelector(".ac-empty") as HTMLElement;
      expect(empty.querySelector(".ac-empty__title")?.textContent).toBe(title);
      expect(empty.querySelector(".ac-empty__text")).toBeNull();
      expect(screen().getByRole("button", { name: "Ver todas as threads" })).toBeTruthy();
      cleanup();
    }
    await renderApp(`/org/${ORG_ID}/threads/x`, { api: createFakeApi() });
    await settle();
    expect(screen().getByText("Thread não encontrada")).toBeTruthy();
    cleanup();
  });

  test("unknown paths show the not-found page", async () => {
    await renderApp("/nada/aqui", { api: createFakeApi() });
    expect(screen().getByRole("heading", { name: "Página não encontrada" })).toBeTruthy();
  });

  test("the sidebar lists channels, DMs (people and agents) and the pending approvals count, proposals in it", async () => {
    const state = seedState();
    for (const id of [ADA_ID, ATLAS_ID]) seedDm(state, { type: "agent", id });
    seedDm(state, { type: "person", id: "u-joao" });
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
    await settle();
    const nav = screen().getByRole("navigation", { name: "Navegação do workspace" });
    expect(nav.textContent).toContain("Acme");
    expect(nav.textContent).toContain("2 membros · 2 agentes");
    // Two approvals and the two proposals waiting: proposals count in Aprovações unless they have a row of their own.
    expect(screen().getByLabelText("4 aprovações pendentes").textContent).toBe("4");
    for (const name of ["Canais", "eng", "general", "Mensagens diretas", "Ada", "Atlas", "João"]) {
      expect(nav.textContent).toContain(name);
    }
    // Money never shows in the sidebar (US$ 15,40 of US$ 60); the budget's use is the account menu's.
    expect(nav.textContent).not.toContain("US$");
    expect(screen().getByRole("button", { name: /^Conta: / })).toBeTruthy();
  });

  test("under the person's name only their status line: no budget bar (ADR 0084)", async () => {
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi() });
    await settle();
    expect(document.querySelector(".sidebar__user .sidebar__usage")).toBeNull();
    expect(document.querySelector(".sidebar__user")?.textContent).not.toContain("26%");
  });
});

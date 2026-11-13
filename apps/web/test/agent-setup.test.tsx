import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, type FakeState, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/** A new agent's setup checklist (ADR 0155 §2): the top of its DM, in its voice, for whoever sets it up. */

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const withSetup = (state: FakeState, done: ("ai" | "apps" | "where" | "who" | "how")[] = []) => {
  const ada = state.agents.find((a) => a.id === ADA_ID);
  if (ada) ada.setup = { role: "dev", done };
  return state;
};
const openDm = async (state: FakeState) => {
  await renderApp(`/org/${ORG_ID}/dm/agent/${ADA_ID}`, { api: createFakeApi(state) });
  await settle(8);
};
const card = () => document.body.querySelector<HTMLElement>(".setup-cl");
const click = async (el: Element, rounds = 6) => {
  await act(async () => fireEvent.click(el));
  await settle(rounds);
};

describe("the setup checklist in a new agent's DM", () => {
  test("its greeting and its steps; a step its data already says is done shows done", async () => {
    const state = withSetup(seedState());
    await openDm(state);
    const c = card();
    expect(c).toBeTruthy();
    expect(document.body.textContent).toContain("Pra eu começar, me ajuda com estas coisas rápidas:");
    // In its chat (ADR 0164): its AI, apps and channels, and who it talks to as a line that only informs; how it
    // works stays on its page.
    expect(c?.querySelectorAll(".setup-row")).toHaveLength(4);
    expect(c?.querySelectorAll(".setup-cl__meter i")).toHaveLength(3);
    // It thinks already (the AI status says ready) and it is in #eng: two of the three counted done.
    expect(c?.textContent).toContain("Já tenho uma IA para pensar");
    expect(c?.textContent).toContain("2 de 3");
    // On top, its sky, awake (it can think).
    expect(c?.querySelector(".nac-band[data-lit]")).toBeTruthy();
  });

  test("made from its card it says what it said there, in its own voice (ADR 0164)", async () => {
    const state = seedState();
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada) ada.setup = { role: "dev", done: ["who", "how"], hello: "Programo, reviso PRs e investigo bugs." };
    await openDm(state);
    const text = document.body.textContent ?? "";
    expect(text).toContain("Programo, reviso PRs e investigo bugs.");
    expect(text).not.toContain("Você me pediu");
    expect(text).not.toContain("bugs..");
  });

  test("a step's button opens its dialog; saving confirms the step", async () => {
    const state = withSetup(seedState());
    await openDm(state);
    const who = [...(card()?.querySelectorAll<HTMLElement>(".setup-row") ?? [])].find((r) =>
      r.textContent?.includes("Falar com todos de Acme"),
    );
    expect(who).toBeTruthy();
    await click(within(who as HTMLElement).getByRole("button", { name: "Escolher" }));
    const dialog = screen().getByRole("dialog");
    await click(within(dialog).getByRole("button", { name: "Salvar" }));
    expect(state.calls).toContainEqual({ method: "agents.confirmSetup", args: [ORG_ID, ADA_ID, "who"] });
    expect(card()?.textContent).toContain("Falo com todos de Acme");
  });

  test("with nothing left, its greeting asks for no help over a card that is all done", async () => {
    const state = withSetup(seedState(), ["apps", "who", "how"]);
    await openDm(state);
    expect(card()?.textContent).toContain("3 de 3");
    expect(document.body.textContent).not.toContain("Pra eu começar");
  });

  test("an agent made before the checklist shows none: its empty conversation as before", async () => {
    const state = seedState();
    await openDm(state);
    expect(card()).toBeNull();
  });

  test("alone in a personal workspace nobody else could talk to it, nor a channel to join: neither step, back once someone joins (ADR 0159)", async () => {
    const personal = (alone: boolean) => {
      const state = withSetup(seedState());
      const org = state.me?.organizations[0];
      if (org) org.mode = "personal";
      if (alone) state.members = state.members.filter((m) => m.userId === state.me?.user.id);
      return state;
    };
    await openDm(personal(true));
    expect(card()?.querySelectorAll(".setup-row")).toHaveLength(2);
    cleanup();
    await openDm(personal(false));
    expect(card()?.querySelectorAll(".setup-row")).toHaveLength(4);
  });
});

describe("a template agent's greeting", () => {
  test("in its own role, never 'Você me pediu', and never a doubled period", async () => {
    const state = seedState();
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada) {
      ada.setup = { role: null, done: [] };
      ada.role = "Atendimento";
      ada.instructions = "Responde os clientes no WhatsApp.";
    }
    await openDm(state);
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("Você me pediu");
    expect(text).toContain("a nova de atendimento");
  });

  test("an agent with no role says back what it was asked, closing its sentence once", async () => {
    const state = seedState();
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada) {
      ada.setup = { role: null, done: [] };
      ada.role = "";
      ada.instructions = "Responde os clientes no WhatsApp.";
    }
    await openDm(state);
    expect(document.body.textContent).toContain("Você me pediu: “Responde os clientes no WhatsApp”.");
    expect(document.body.textContent).not.toContain(".”.");
  });

  test("apps skipped on the right hand's card stay skipped for the team's agents", async () => {
    const state = seedState();
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada) ada.setup = { role: "dev", done: [] };
    if (ada)
      state.agents.push({
        ...ada,
        id: "lodi-x",
        name: "Lodi",
        handle: "lodi",
        builtin: "right_hand",
        setup: { role: null, done: ["apps"] },
      });
    await openDm(state);
    expect(card()?.textContent).toContain("Sem apps por enquanto");
  });
});

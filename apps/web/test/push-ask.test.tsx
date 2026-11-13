import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent } from "@testing-library/react";
import { ADA_ID, createFakeApi, type FakeState, GENERAL_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/*
 * Our notifications ask (ADR 0071) waits until the person has used the app a bit: under the first answer from an
 * agent they wrote to, never on arrival, never as a dialog over the screen, never on a billing hold.
 */

beforeAll(async () => {
  // An app opened before in a browser that takes no notifications (another test file, in the same process) decides
  // nothing for the ones below.
  await open(seedState());
  cleanup();
  // A browser that takes notifications: secure, with service workers, push and the permission still unasked.
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  const worker = {
    addEventListener: () => {},
    removeEventListener: () => {},
    startMessages: () => {},
    getRegistration: async () => undefined,
    register: async () => ({}),
    ready: new Promise(() => {}),
  };
  Object.defineProperty(navigator, "serviceWorker", { value: worker, configurable: true });
  const browser = { PushManager: () => {}, Notification: { permission: "default" } };
  Object.assign(window, browser);
  // The page reads `Notification` as a global too.
  Object.assign(globalThis, browser);
});
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
});

const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
/** #general where Walter asked Ada something and Ada answered (`answered` false: only the question). */
function general(answered: boolean) {
  const state = seedState();
  state.webPushKey = "BPublicKey";
  state.channelMembers[GENERAL_ID] = [
    { type: "person", id: "u-walter" },
    { type: "agent", id: ADA_ID },
  ];
  state.messages.push({
    id: "m-ask",
    channelId: GENERAL_ID,
    threadId: null,
    author: { type: "person", id: "u-walter" },
    body: "@ada qual é o prazo de entrega para o bairro?",
    mentionedAgentIds: [ADA_ID],
    agentRunId: null,
    createdAt: at(3),
  });
  if (answered)
    state.messages.push({
      id: "m-answer",
      channelId: GENERAL_ID,
      threadId: null,
      author: { type: "agent", id: ADA_ID },
      body: "Entregamos no mesmo dia para pedidos até as 14h.",
      mentionedAgentIds: [],
      agentRunId: "r-9",
      createdAt: at(2),
    });
  return state;
}
const open = async (state: FakeState) => {
  await renderApp(`/org/${ORG_ID}/c/${GENERAL_ID}`, { api: createFakeApi(state) });
  await settle(14);
};
const ask = () => document.querySelector(".push-ask");

describe("the notifications ask", () => {
  test("under the agent's first answer to the person, in place, once; Agora não puts it away", async () => {
    await open(general(true));
    expect(screen().queryByRole("dialog")).toBeNull();
    expect(ask()?.textContent).toContain("Quer saber na hora quando a Ada responder?");
    // Under the answer it follows.
    const text = document.body.textContent ?? "";
    expect(text.indexOf("Quer saber na hora")).toBeGreaterThan(text.indexOf("Entregamos no mesmo dia"));
    expect(localStorage.getItem("agentes.push.offers")).toBe("1");
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Agora não" })));
    await settle(4);
    expect(ask()).toBeNull();
    cleanup();
    // Counted once: the same answer doesn't bring it back.
    await open(general(true));
    expect(ask()).toBeNull();
  });

  test("not before an agent answered, and never on a billing hold", async () => {
    await open(general(false));
    expect(ask()).toBeNull();
    cleanup();
    const held = general(true);
    if (held.me)
      held.me.organizations = held.me.organizations.map((o) => ({
        ...o,
        standing: { state: "hold" as const, reason: "payment" },
      }));
    await open(held);
    expect(ask()).toBeNull();
  });
});

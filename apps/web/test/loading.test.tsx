import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { ApiError, type Message } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { stepAt } from "@/components/Loading";
import { createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};
const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

describe("loading states", () => {
  test("a conversation: message-shaped skeleton while it loads, then the messages (composer stays put)", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const held = deferred<Message[]>();
    const real = api.chat.messages;
    let first = true;
    api.chat.messages = (orgId, channelId, options) => {
      if (first && !options?.threadId) {
        first = false;
        return held.promise;
      }
      return real(orgId, channelId, options);
    };
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(6);
    const skeleton = screen().getByRole("status", { name: "Carregando mensagens" });
    expect(skeleton.querySelectorAll(".ac-skeleton-msg").length).toBeGreaterThan(2);
    // The composer is already there: nothing jumps when the messages arrive.
    const composer = screen().getByRole("combobox", { name: /Mensagem para|#eng/ });
    await wait(200);
    expect(skeleton.hasAttribute("data-visible")).toBe(true);
    await act(async () => held.resolve(await real(ORG_ID, ENG_ID)));
    await settle(6);
    expect(screen().queryByRole("status", { name: "Carregando mensagens" })).toBeNull();
    expect(screen().getByRole("combobox", { name: /Mensagem para|#eng/ })).toBe(composer);
  });

  test("an error: a friendly line and Tentar de novo", async () => {
    const api = createFakeApi(seedState());
    let calls = 0;
    const real = api.issues.list;
    api.issues.list = async (...args) => {
      calls += 1;
      if (calls === 1) throw new Error("offline");
      return real(...args);
    };
    await renderApp(`/org/${ORG_ID}/issues`, { api });
    await settle(10);
    const retry = screen().queryByRole("button", { name: "Tentar de novo" });
    if (retry) {
      await act(async () => fireEvent.click(retry));
      await settle(6);
    }
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(screen().queryByRole("status", { name: "Carregando a lista" })).toBeNull();
  });

  test("something gone: what happened, and no Tentar de novo that could never work", async () => {
    const api = createFakeApi(seedState());
    api.issues.list = async () => {
      throw new ApiError(404, "not_found", "Not found");
    };
    await renderApp(`/org/${ORG_ID}/issues`, { api });
    await settle(10);
    expect(screen().getByText("Isso não está mais aqui. Foi apagado, ou você não tem mais acesso.")).toBeTruthy();
    expect(screen().queryByRole("button", { name: "Tentar de novo" })).toBeNull();
  });

  test("an old link to an archived agent's DM says it was archived, in words, with no Tentar de novo", async () => {
    const api = createFakeApi(seedState());
    api.dms.open = async () => {
      throw new ApiError(404, "not_found", "Agent not found");
    };
    await renderApp(`/org/${ORG_ID}/dm/agent/gone-agent`, { api });
    await settle(10);
    expect(screen().getByText("Este agente não existe ou foi arquivado.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("Agent not found");
    expect(screen().queryByRole("button", { name: "Tentar de novo" })).toBeNull();
  });

  test("long actions: the step follows the clock (fake time)", () => {
    expect(stepAt(0, 0, 3)).toBe(0);
    expect(stepAt(0, 2499, 3)).toBe(0);
    expect(stepAt(0, 2500, 3)).toBe(1);
    expect(stepAt(0, 60_000, 3)).toBe(2);
  });

  test("the sidebar shows placeholder rows while channels load", async () => {
    const api = createFakeApi(seedState());
    const held = deferred<Awaited<ReturnType<typeof api.chat.channels>>>();
    const real = api.chat.channels;
    api.chat.channels = () => held.promise;
    await renderApp(`/org/${ORG_ID}/issues`, { api });
    await settle(4);
    const nav = screen().getByRole("navigation", { name: "Navegação do workspace" });
    expect(within(nav).getAllByRole("status", { name: "Carregando a lista" }).length).toBeGreaterThan(0);
    await act(async () => held.resolve(await real(ORG_ID)));
    await settle(6);
    expect(within(nav).getByRole("link", { name: /eng/ })).toBeTruthy();
  });
});

describe("a thread opening in the panel", () => {
  const click = (el: Element) => act(async () => fireEvent.click(el));
  /** The thread's own reads (its info and its messages) held until `release`. */
  const holdThread = (api: ReturnType<typeof createFakeApi>) => {
    const info = deferred<void>();
    const realGet = api.threads.get;
    const realMessages = api.chat.messages;
    api.threads.get = async (...args) => {
      await info.promise;
      return realGet(...args);
    };
    api.chat.messages = async (orgId, channelId, options) => {
      if (options?.threadId) await info.promise;
      return realMessages(orgId, channelId, options);
    };
    return () => act(async () => info.resolve());
  };

  test("Responder: the header, the message and the composer are real at once, with no skeleton", async () => {
    const api = createFakeApi(seedState());
    const release = holdThread(api);
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(8);
    const bar = screen().getByRole("toolbar", { name: "Ações da mensagem de João" });
    await click(within(bar).getByRole("button", { name: "Responder" }));
    await settle(2);
    const panel = screen().getByRole("complementary", { name: "Thread" });
    expect(within(panel).getByRole("button", { name: "Fechar a thread" })).toBeTruthy();
    expect(panel.querySelector('article[data-message-id="m-1"]')?.textContent).toContain("o login está devolvendo 401");
    const composer = within(panel).getByRole("combobox", { name: "Responder na thread" });
    expect(within(panel).queryByRole("status", { name: "Carregando mensagens" })).toBeNull();
    await release();
    await settle(6);
    // The read lands in place: the same composer, the same root, still no skeleton.
    expect(within(panel).getByRole("combobox", { name: "Responder na thread" })).toBe(composer);
    expect(panel.querySelectorAll('article[data-message-id="m-1"]')).toHaveLength(1);
    expect(within(panel).queryByRole("status", { name: "Carregando mensagens" })).toBeNull();
  });

  test("a thread with replies: only its replies wait, under its real root", async () => {
    const state = seedState();
    state.messages.push({
      id: "m-3",
      channelId: ENG_ID,
      threadId: "m-1",
      author: { type: "person", id: "u-walter" },
      body: "vou olhar o refresh",
      mentionedAgentIds: [],
      agentRunId: null,
      createdAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    });
    const api = createFakeApi(state);
    await state.openThread?.(ORG_ID, "m-1", state.messages.at(-1)?.createdAt ?? "");
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(8);
    const release = holdThread(api);
    await click(screen().getByRole("button", { name: /1 resposta/ }));
    await settle(2);
    const panel = screen().getByRole("complementary", { name: "Thread" });
    expect(panel.querySelector(".thread-title")?.textContent).toContain("o login está devolvendo 401");
    expect(panel.querySelector('article[data-message-id="m-1"]')).toBeTruthy();
    const waiting = within(panel).getByRole("status", { name: "Carregando mensagens" });
    expect(waiting.querySelectorAll(".ac-skeleton-msg")).toHaveLength(1);
    // Nothing of the whole-conversation skeleton: the header and the composer are the real ones.
    expect(panel.querySelector(".channel__skeleton")).toBeNull();
    expect(within(panel).getByRole("combobox", { name: "Responder na thread" })).toBeTruthy();
    await release();
    await settle(6);
    expect(panel.textContent).toContain("vou olhar o refresh");
    expect(within(panel).queryByRole("status", { name: "Carregando mensagens" })).toBeNull();
  });

  test("a thread no list holds yet: one skeleton shaped like it, the composer's box with no bar in it", async () => {
    const api = createFakeApi(seedState());
    const release = holdThread(api);
    await renderApp(`/org/${ORG_ID}/threads/m-1`, { api });
    await settle(6);
    const skeleton = document.querySelector(".channel__skeleton") as HTMLElement;
    expect(skeleton.querySelector(".thread-head")).toBeTruthy();
    expect(skeleton.querySelectorAll(".ac-skeleton-msg")).toHaveLength(6);
    const box = skeleton.querySelector(".channel__composer-skeleton") as HTMLElement;
    expect(box.querySelectorAll(".ac-skeleton")).toHaveLength(1);
    expect(box.querySelector(".ac-composer__tools .channel__composer-skeleton-send")).toBeTruthy();
    await release();
    await settle(8);
    expect(document.querySelector(".channel__skeleton")).toBeNull();
    expect(screen().getByRole("combobox", { name: "Responder na thread" })).toBeTruthy();
  });
});

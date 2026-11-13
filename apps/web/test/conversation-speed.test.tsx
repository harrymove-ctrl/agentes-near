import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Message } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, GENERAL_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

/** `count` old person messages in #general, one minute apart, oldest first. */
const history = (count: number): Message[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `h-${i}`,
    channelId: GENERAL_ID,
    threadId: null,
    author: { type: "person" as const, id: "u-walter" },
    body: `Mensagem antiga ${i}`,
    mentionedAgentIds: [],
    agentRunId: null,
    createdAt: new Date(Date.UTC(2026, 9, 1, 8, 0) + i * 60_000).toISOString(),
  }));

describe("conversations load fast", () => {
  test("hovering a channel in the sidebar loads its messages before the click", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const asked: string[] = [];
    const real = api.chat.messages;
    api.chat.messages = (orgId, channelId, options) => {
      if (!options?.threadId) asked.push(channelId);
      return real(orgId, channelId, options);
    };
    await renderApp(`/org/${ORG_ID}/issues`, { api });
    await settle(6);
    const nav = screen().getByRole("navigation", { name: "Navegação do workspace" });
    await act(async () => fireEvent.mouseEnter(within(nav).getByRole("link", { name: /general/ })));
    await settle(3);
    expect(asked).toContain(GENERAL_ID);
  });

  test("scrolling to the top loads the previous page, older first, without losing the newer ones", async () => {
    const state = seedState();
    state.messages = [...history(130), ...state.messages];
    const api = createFakeApi(state);
    const pages: { before?: string; limit?: number }[] = [];
    const real = api.chat.messages;
    api.chat.messages = (orgId, channelId, options) => {
      if (channelId === GENERAL_ID && !options?.threadId)
        pages.push({ before: options?.before, limit: options?.limit });
      return real(orgId, channelId, options);
    };
    await renderApp(`/org/${ORG_ID}/c/${GENERAL_ID}`, { api });
    await settle(8);
    expect(document.body.textContent).toContain("Mensagem antiga 129");
    expect(document.body.textContent).not.toContain("Mensagem antiga 29");
    const list = screen().getByRole("region", { name: "Mensagens" });
    await act(async () => {
      fireEvent.wheel(list);
      fireEvent.scroll(list, { target: { scrollTop: 0 } });
    });
    await settle(6);
    expect(pages.at(-1)).toEqual({ before: history(130)[30]?.createdAt, limit: 50 });
    expect(document.body.textContent).toContain("Mensagem antiga 29");
    expect(document.body.textContent).toContain("Mensagem antiga 129");
    // 180 messages rendered twice: ~2 s on a runner, more when it's busy; past 5 s the timeout broke the next files.
  }, 15_000);

  test("older pages stay with the session that loaded them: the next one opens the channel without them", async () => {
    const state = seedState();
    state.messages = [...history(130), ...state.messages];
    await renderApp(`/org/${ORG_ID}/c/${GENERAL_ID}`, { api: createFakeApi(state) });
    await settle(8);
    const list = screen().getByRole("region", { name: "Mensagens" });
    await act(async () => {
      fireEvent.wheel(list);
      fireEvent.scroll(list, { target: { scrollTop: 0 } });
    });
    await settle(6);
    expect(document.body.textContent).toContain("Mensagem antiga 29");
    cleanup();
    await renderApp(`/org/${ORG_ID}/c/${GENERAL_ID}`, { api: createFakeApi(seedState()) });
    await settle(8);
    expect(document.body.textContent).not.toContain("Mensagem antiga");
    expect(document.querySelector(".ac-empty__title")?.textContent).toBe("Diga oi em #general");
  }, 15_000);

  test("opening lands at the latest message (also after the skeleton); layout scrolls never unpin", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    let release: (m: Message[]) => void = () => {};
    const real = api.chat.messages;
    let first = true;
    api.chat.messages = (orgId, channelId, options) => {
      if (first && channelId === GENERAL_ID && !options?.threadId) {
        first = false;
        return new Promise((r) => {
          release = r;
        });
      }
      return real(orgId, channelId, options);
    };
    state.messages = [...history(20), ...state.messages];
    const r = await renderApp(`/org/${ORG_ID}/c/${GENERAL_ID}`, { api });
    await settle(4);
    // happy-dom has no layout: fake a tall list before anything arrives.
    const list = screen().getByRole("region", { name: "Mensagens" });
    Object.defineProperty(list, "scrollHeight", { configurable: true, value: 3000 });
    Object.defineProperty(list, "clientHeight", { configurable: true, value: 500 });
    expect(screen().getByRole("status", { name: "Carregando mensagens" })).toBeTruthy();
    await act(async () => release(await real(ORG_ID, GENERAL_ID, { limit: 100 })));
    await settle(6);
    expect(screen().queryByRole("status", { name: "Carregando mensagens" })).toBeNull();
    expect(list.scrollTop).toBe(3000);
    // The socket opens after the first page (opening it may refetch; still at the bottom).
    const socket = r.sockets.last();
    await act(async () => socket.open());
    await settle(2);
    expect(list.scrollTop).toBe(3000);
    // Something above grew and the browser moved the scroll: not the person, so it stays pinned.
    list.scrollTop = 1200;
    await act(async () => fireEvent.scroll(list));
    await act(async () =>
      socket.push({
        type: "event",
        channelId: GENERAL_ID,
        event: {
          type: "message.created",
          channelId: GENERAL_ID,
          messageId: "m-new",
          message: {
            id: "m-new",
            channelId: GENERAL_ID,
            threadId: null,
            author: { type: "person", id: "u-joao" },
            body: "chegou",
            mentionedAgentIds: [],
            agentRunId: null,
            createdAt: new Date().toISOString(),
          },
        },
      }),
    );
    await settle(4);
    expect(list.scrollTop).toBe(3000);
  });

  test("?m= (a copied link): pages back to the message, scrolls to it, centres it again once the rows around it are drawn, and highlights it", async () => {
    const state = seedState();
    state.messages = [...history(130), ...state.messages];
    // A browser frame: its animation callbacks run, then it is drawn (only then do rows near the screen get their
    // real height, `content-visibility`).
    let drawn = 0;
    let ids = 0;
    const frame = new Map<number, FrameRequestCallback>();
    const realFrames = {
      requestAnimationFrame: globalThis.requestAnimationFrame,
      cancelAnimationFrame: globalThis.cancelAnimationFrame,
    };
    Object.assign(globalThis, {
      requestAnimationFrame: (cb: FrameRequestCallback) => {
        if (frame.size === 0)
          setTimeout(() => {
            const run = [...frame.values()];
            frame.clear();
            for (const f of run) f(performance.now());
            drawn += 1;
          }, 0);
        frame.set(++ids, cb);
        return ids;
      },
      cancelAnimationFrame: (id: number) => frame.delete(id),
    });
    const scrolled: string[] = [];
    const drawnAt: number[] = [];
    const proto = HTMLElement.prototype as unknown as { scrollIntoView?: () => void };
    const before = proto.scrollIntoView;
    proto.scrollIntoView = function (this: HTMLElement) {
      const id = this.getAttribute("data-message-id") ?? "";
      scrolled.push(id);
      if (id === "h-10") drawnAt.push(drawn);
    };
    // The highlight lasts a couple of seconds: seen at any point, not only at the end (a slow CI).
    let highlighted = false;
    const watch = new MutationObserver(() => {
      if (document.querySelector('[data-message-id="h-10"].ac-msg--focus')) highlighted = true;
    });
    watch.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
    try {
      await renderApp(`/org/${ORG_ID}/c/${GENERAL_ID}?m=h-10`, { api: createFakeApi(state) });
      await settle(12);
      // h-10 isn't in the latest page (h-30…h-129): one older page brings it.
      expect(document.body.textContent).toContain("Mensagem antiga 10");
      expect(scrolled).toContain("h-10");
      // Not in an animation callback, which runs before its frame draws them.
      expect(drawnAt.at(-1) ?? 0).toBeGreaterThan(drawnAt[0] ?? 0);
      expect(highlighted).toBe(true);
    } finally {
      watch.disconnect();
      proto.scrollIntoView = before;
      Object.assign(globalThis, realFrames);
    }
  });
});

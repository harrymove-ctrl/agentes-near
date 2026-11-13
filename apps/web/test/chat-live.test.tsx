import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { ApiError } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, comfortable, createFakeApi, ENG_ID, GENERAL_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const open = async (state = seedState(), path = `c/${ENG_ID}`) => {
  const r = await renderApp(`/org/${ORG_ID}/${path}`, { api: createFakeApi(state) });
  await settle(5);
  const socket = r.sockets.last();
  await act(async () => socket.open());
  await settle(2);
  return { ...r, socket, state };
};
const composer = () => screen().getByRole("combobox", { name: /Mensagem para/ });
const sendText = async (text: string) => {
  await act(async () => fireEvent.change(composer(), { target: { value: text } }));
  await act(async () => fireEvent.keyDown(composer(), { key: "Enter" }));
};
const push = (socket: { push: (f: unknown) => void }, event: Record<string, unknown>, channelId = ENG_ID) =>
  act(async () => socket.push({ type: "event", channelId, event: { channelId, ...event } }));
const rowsWith = (text: string) =>
  screen()
    .queryAllByRole("article")
    .filter((a) => a.textContent?.includes(text));

describe("optimistic send", () => {
  test("appears at once as pending, then reconciles by clientId with the server copy (no duplicate)", async () => {
    let release = () => {};
    const state = seedState();
    state.holdPosts = new Promise<void>((r) => {
      release = r;
    });
    const { socket } = await open(state);
    await sendText("bom dia");
    const pending = rowsWith("bom dia");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.className).toContain("ac-msg--pending");
    expect(pending[0]?.textContent).toContain("enviando…");
    // Focus stays in the composer, which is empty again.
    expect(document.activeElement === composer()).toBe(true);
    expect((composer() as HTMLTextAreaElement).value).toBe("");
    // The WebSocket echo (with clientId) can arrive before the HTTP response.
    const posted = state.calls.find((c) => c.method === "chat.post")?.args[2] as { clientId: string } | undefined;
    const clientId = posted?.clientId ?? "";
    await push(socket, {
      type: "message.created",
      messageId: `srv-${clientId}`,
      message: {
        id: `srv-${clientId}`,
        channelId: ENG_ID,
        threadId: null,
        author: { type: "person", id: "u-walter" },
        body: "bom dia",
        mentionedAgentIds: [],
        agentRunId: null,
        clientId,
        createdAt: new Date().toISOString(),
      },
    });
    await settle();
    expect(rowsWith("bom dia")).toHaveLength(1);
    expect(rowsWith("bom dia")[0]?.className).not.toContain("ac-msg--pending");
    await act(async () => release());
    await settle(4);
    expect(rowsWith("bom dia")).toHaveLength(1);
  });

  test("failure says 'Não enviada · Tentar de novo'; retry sends the same text", async () => {
    const state = seedState({ failPosts: true });
    await open(state);
    await sendText("vai falhar");
    await settle(4);
    const row = rowsWith("vai falhar")[0] as HTMLElement;
    expect(row.className).toContain("ac-msg--failed");
    expect(within(row).getByRole("alert").textContent).toBe("Não enviada·Tentar de novo");
    state.failPosts = false;
    await act(async () => fireEvent.click(within(row).getByRole("button", { name: "Tentar de novo" })));
    await settle(4);
    expect(state.calls.filter((c) => c.method === "chat.post")).toHaveLength(2);
    expect(rowsWith("vai falhar")).toHaveLength(1);
    expect(rowsWith("vai falhar")[0]?.className).not.toContain("ac-msg--failed");
  });

  test("the server restarting (the proxy's 502): it waits instead of failing, then goes out by itself with its clientId", async () => {
    const state = seedState({ failPosts: new ApiError(502, "http_502", "Bad Gateway") });
    const { sockets } = await open(state);
    await sendText("durante o deploy");
    await settle(4);
    const row = () => rowsWith("durante o deploy")[0] as HTMLElement;
    expect(row().className).not.toContain("ac-msg--failed");
    expect(row().textContent).toContain("sai quando a conexão voltar");
    // The new server is up: the socket drops with the old one and reconnects.
    state.failPosts = false;
    await act(async () => sockets.last().drop());
    await act(() => new Promise((r) => setTimeout(r, 650)));
    await act(async () => sockets.last().open());
    await settle(4);
    const clientIds = state.calls
      .filter((c) => c.method === "chat.post")
      .map((c) => (c.args[2] as { clientId: string }).clientId);
    expect(clientIds).toHaveLength(2);
    expect(clientIds[0]).toBeTruthy();
    expect(clientIds[1]).toBe(clientIds[0]);
    expect(rowsWith("durante o deploy")).toHaveLength(1);
    expect(row().className).not.toContain("ac-msg--pending");
    expect(row().className).not.toContain("ac-msg--failed");
  });

  test("a message waiting in one conversation goes out once the server is back, while the person is in another", async () => {
    const state = seedState({ failPosts: new ApiError(502, "http_502", "Bad Gateway") });
    const { sockets, router } = await open(state);
    const go = (channelId: string) =>
      act(() => router.navigate({ to: "/org/$orgId/c/$channelId", params: { orgId: ORG_ID, channelId } }));
    await sendText("antes do deploy");
    await settle(4);
    expect(rowsWith("antes do deploy")[0]?.textContent).toContain("sai quando a conexão voltar");
    await go(GENERAL_ID);
    await settle(4);
    state.failPosts = false;
    await act(async () => sockets.last().drop());
    await act(() => new Promise((r) => setTimeout(r, 650)));
    await act(async () => sockets.last().open());
    await settle(4);
    const posts = () =>
      state.calls
        .filter((c) => c.method === "chat.post")
        .map((c) => `${c.args[1]}:${(c.args[2] as { clientId: string }).clientId}`);
    expect(posts()).toHaveLength(2);
    expect(posts()[1]).toBe(posts()[0] as string);
    // Back in that conversation: the message is there, sent, and nothing goes out again.
    await go(ENG_ID);
    await settle(4);
    expect(rowsWith("antes do deploy")).toHaveLength(1);
    expect(rowsWith("antes do deploy")[0]?.className).not.toContain("ac-msg--failed");
    expect(rowsWith("antes do deploy")[0]?.className).not.toContain("ac-msg--pending");
    expect(posts()).toHaveLength(2);
  });
});

const typingBar = () => document.querySelector(".ac-typing") as HTMLElement;
/** The bar's words (without avatar initials); "" when nobody is typing. */
const bar = () => ({ textContent: typingBar().querySelector(".ac-typing__text")?.textContent ?? "" });
const lastPerson = (state: ReturnType<typeof seedState>) => state.messages[state.messages.length - 1];

describe("typing bar above the composer", () => {
  test("mention → the bar says 'Atlas pensando…', then 'escrevendo…'; none of its words in the conversation until its reply", async () => {
    const { socket } = await open();
    await sendText("@atlas olha o deploy");
    expect(bar().textContent).toBe("Atlas pensando…");
    // Agents at work: their faces open the pill, no pixel orbit beside them (the dots are for people typing).
    expect(typingBar().querySelector(".ac-pixspin")).toBeNull();
    expect(typingBar().querySelector(".ac-typing__dots")).toBeNull();
    // Its row isn't in the conversation yet: the bar has its face.
    expect(typingBar().querySelector(".ac-avatar--agent")).not.toBeNull();
    // The words are the bar's.
    expect(rowsWith("Atlas está")).toHaveLength(0);
    await settle(4);
    const run = { threadId: null, runId: "r-live", agentId: ATLAS_ID };
    await push(socket, { type: "agent.thinking", ...run });
    expect(bar().textContent).toBe("Atlas pensando…");
    await push(socket, { type: "agent.typing", ...run });
    await push(socket, { type: "agent.delta", ...run, seq: 1, text: "Deploy ok" });
    await settle();
    // Nothing of it in the conversation: the card above the box speaks for it (its face and what it does now).
    expect(document.querySelector(".ac-msg--streaming")).toBeNull();
    expect(rowsWith("Deploy ok")).toHaveLength(0);
    expect(bar().textContent).toBe("Atlas escrevendo…");
    expect(typingBar().querySelector(".ac-avatar--agent")).not.toBeNull();
    await push(socket, { type: "agent.idle", ...run });
    await settle();
    expect(bar().textContent).toBe("");
  });

  test("an agent out of view and people: 'Atlas pensando… · João digitando…'; our typing frames are throttled", async () => {
    const { socket } = await open();
    await sendText("@atlas tudo certo?");
    await settle(2);
    await push(socket, { type: "user.typing", userId: "u-joao", threadId: null, ttlMs: 6000 });
    await settle();
    expect(bar().textContent).toBe("Atlas pensando…");
    // Who is typing comes after the agent's own words and time, on the pill as wide as the composer.
    expect(typingBar().querySelector(".ac-typing__also")?.textContent).toBe("João digitando…");
    await push(socket, { type: "agent.typing", threadId: null, runId: "r-g", agentId: ATLAS_ID });
    await settle();
    // Atlas writes now; it stays on the card while it works.
    expect(bar().textContent).toBe("Atlas escrevendo…");
    expect(typingBar().querySelector(".ac-typing__also")?.textContent).toBe("João digitando…");
    for (const v of ["o", "oi", "oi ", "oi j"])
      await act(async () => fireEvent.change(composer(), { target: { value: v } }));
    // One frame per new message (the first one's, then this one's first keystroke), its next keystrokes throttled.
    expect(socket.sent.filter((f) => (f as { type: string }).type === "typing")).toEqual([
      { type: "typing", channelId: ENG_ID },
      { type: "typing", channelId: ENG_ID },
    ]);
  });

  test("someone typing alone: the dots, their face and 'João está digitando…', gone once their message comes", async () => {
    const { socket } = await open();
    expect(typingBar().dataset.active).toBe("false");
    await push(socket, { type: "user.typing", userId: "u-joao", threadId: null, ttlMs: 6000 });
    await settle();
    expect(typingBar().dataset.active).toBe("true");
    expect(bar().textContent).toBe("João está digitando…");
    // People only: the typing dots lead (the orbit is for agents), their face in the stack, no clock and no stop.
    expect(typingBar().querySelector(".ac-typing__dots")).not.toBeNull();
    expect(typingBar().querySelector(".ac-pixspin")).toBeNull();
    expect(typingBar().querySelectorAll(".ac-typing__tok .ac-avatar")).toHaveLength(1);
    expect(typingBar().querySelector(".ac-typing__elapsed, .stop-run")).toBeNull();
    await push(socket, {
      type: "message.created",
      messageId: "m-joao",
      message: {
        id: "m-joao",
        channelId: ENG_ID,
        threadId: null,
        author: { type: "person", id: "u-joao" },
        body: "pronto, subiu",
        mentionedAgentIds: [],
        agentRunId: null,
        createdAt: new Date().toISOString(),
      },
    });
    await settle();
    expect(typingBar().dataset.active).toBe("false");
  });

  test("my own typing never shows, and someone typing in a thread shows in that thread, not here", async () => {
    const { socket } = await open();
    await push(socket, { type: "user.typing", userId: "u-walter", threadId: null, ttlMs: 6000 });
    await push(socket, { type: "user.typing", userId: "u-joao", threadId: "m-1", ttlMs: 6000 });
    await settle();
    expect(typingBar().dataset.active).toBe("false");
  });

  test("in a thread: who types there shows (not who types in the channel), and my typing frames name the thread", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    await api.threads.create(ORG_ID, {
      id: "m-1",
      channelId: ENG_ID,
      firstMessageId: "m-1",
      lastMessageId: "m-1",
      title: "Login com 401",
    } as Parameters<typeof api.threads.create>[1]);
    const { sockets } = await renderApp(`/org/${ORG_ID}/threads/m-1`, { api });
    await settle(8);
    const socket = sockets.last();
    await act(async () => socket.open());
    await settle(2);
    await push(socket, { type: "user.typing", userId: "u-joao", threadId: null, ttlMs: 6000 });
    await settle();
    expect(typingBar().dataset.active).toBe("false");
    await push(socket, { type: "user.typing", userId: "u-joao", threadId: "m-1", ttlMs: 6000 });
    await settle();
    expect(bar().textContent).toBe("João está digitando…");
    const reply = screen().getByRole("combobox", { name: /Responder na thread/ });
    await act(async () => fireEvent.change(reply, { target: { value: "vou olhar" } }));
    expect(socket.sent.filter((f) => (f as { type: string }).type === "typing")).toEqual([
      { type: "typing", channelId: ENG_ID, threadId: "m-1" },
    ]);
  });

  test("several agents and people: one short line, three small faces at most, no clock or stop", async () => {
    const { socket } = await open();
    const a = { threadId: null, runId: "r-a", agentId: ADA_ID };
    await push(socket, {
      type: "agent.run",
      ...a,
      status: "running",
      startedAt: new Date(Date.now() - 13_000).toISOString(),
    });
    await push(socket, { type: "agent.tool", ...a, tool: "github_list_prs" });
    await push(socket, { type: "agent.run", threadId: null, runId: "r-b", agentId: ATLAS_ID, status: "running" });
    await push(socket, { type: "user.typing", userId: "u-joao", threadId: null, ttlMs: 6000 });
    await settle();
    expect(bar().textContent).toBe("Ada e Atlas estão trabalhando · João está digitando…");
    // Who is typing is a piece of its own, after the agents' words and their " · " (which give way first on a short
    // bar), then the names, never what they do.
    expect(typingBar().querySelector(".ac-typing__agents")?.textContent).toBe("Ada e Atlas estão trabalhando · ");
    const people = typingBar().querySelector(".ac-typing__people");
    expect(people?.textContent).toBe("João está digitando…");
    expect(people?.querySelector(".ac-typing__typers")?.textContent).toBe("João");
    expect(typingBar().querySelectorAll(".ac-typing__tok")).toHaveLength(3);
    expect(typingBar().querySelector(".ac-pixspin")).toBeNull();
    // The time, "Ver" and the stop are one agent's: with two at work the line shows none (the composer still stops).
    expect(typingBar().querySelector(".ac-typing__elapsed")).toBeNull();
    expect(within(typingBar()).queryByRole("button", { name: "Ver" })).toBeNull();
    expect(within(typingBar()).queryByRole("button", { name: "Parar" })).toBeNull();
    // One leaves: the other gets its own line back, with its time.
    await push(socket, { type: "agent.idle", threadId: null, runId: "r-b", agentId: ATLAS_ID });
    await push(socket, { type: "run.finished", threadId: null, runId: "r-b", agentId: ATLAS_ID, status: "done" });
    await settle();
    expect(bar().textContent).toStartWith("Ada consultando o GitHub");
    const took = typingBar().querySelector(".ac-typing__elapsed") as HTMLElement;
    expect(took.textContent).toMatch(/^1\d s$/);
    // Who is typing after its time; the time and the stop stay the agent's.
    expect(took.nextElementSibling?.textContent).toBe("João digitando…");
    // Tabular figures: the seconds tick without nudging what is beside them.
    expect(took.classList.contains("ac-num")).toBe(true);
  });
});

describe("bottom anchoring", () => {
  test("short channels sit above the composer; new rows follow while at the bottom; scrolled up shows the round button", async () => {
    const { socket } = await open();
    const log = screen().getByRole("region", { name: "Mensagens" });
    expect(log.firstElementChild?.className).toBe("channel__spacer");
    // happy-dom has no layout: fake a tall scroll area.
    Object.defineProperty(log, "scrollHeight", { configurable: true, value: 2000 });
    Object.defineProperty(log, "clientHeight", { configurable: true, value: 500 });
    await sendText("primeira");
    await settle(3);
    expect(log.scrollTop).toBe(2000);
    // The person scrolls up.
    log.scrollTop = 100;
    await act(async () => {
      fireEvent.wheel(log);
      fireEvent.scroll(log);
    });
    await push(socket, {
      type: "message.created",
      messageId: "m-new",
      message: {
        id: "m-new",
        channelId: ENG_ID,
        threadId: null,
        author: { type: "person", id: "u-joao" },
        body: "chegou algo novo",
        mentionedAgentIds: [],
        agentRunId: null,
        createdAt: new Date().toISOString(),
      },
    });
    await settle();
    expect(log.scrollTop).toBe(100);
    const pill = screen().getByRole("button", { name: /Ir para as mensagens mais recentes/ });
    await act(async () => fireEvent.click(pill));
    expect(log.scrollTop).toBe(2000);
    expect(screen().queryByRole("button", { name: /Ir para as mensagens mais recentes/ })).toBeNull();
  });

  test("the round button: more than a screen up with nothing new, then a count, red for a mention of me", async () => {
    const { socket } = await open();
    const log = screen().getByRole("region", { name: "Mensagens" });
    Object.defineProperty(log, "scrollHeight", { configurable: true, value: 3000 });
    Object.defineProperty(log, "clientHeight", { configurable: true, value: 500 });
    await sendText("primeira");
    await settle(3);
    const latest = () => screen().queryByRole("button", { name: /Ir para as mensagens mais recentes/ });
    expect(latest()).toBeNull();
    // Less than a screen up: nothing new, no button.
    log.scrollTop = 2200;
    await act(async () => {
      fireEvent.wheel(log, { deltaY: -40 });
      fireEvent.scroll(log);
    });
    expect(latest()).toBeNull();
    // More than a screen up: the button, keyboard reachable, with no count yet.
    log.scrollTop = 600;
    await act(async () => {
      fireEvent.wheel(log, { deltaY: -40 });
      fireEvent.scroll(log);
    });
    const button = latest() as HTMLElement;
    expect(button.getAttribute("aria-label")).toBe("Ir para as mensagens mais recentes");
    expect(button.tabIndex).toBe(0);
    // At the list's bottom edge: right after the messages, right before the composer and its working bar.
    const dock = button.closest(".channel__latest") as HTMLElement;
    expect(dock.previousElementSibling).toBe(log);
    expect(dock.nextElementSibling?.className).toBe("channel__composer");
    const at = button.parentElement as HTMLElement;
    expect(at.querySelector(".channel__latest-count")).toBeNull();
    await push(socket, {
      type: "message.created",
      messageId: "m-call",
      message: {
        id: "m-call",
        channelId: ENG_ID,
        threadId: null,
        author: { type: "person", id: "u-joao" },
        body: "@walter dá uma olhada",
        mentionedAgentIds: [],
        agentRunId: null,
        createdAt: new Date().toISOString(),
      },
    });
    await settle();
    expect(at.querySelector(".channel__latest-count")?.textContent).toBe("1");
    expect(at.querySelector(".channel__latest-count")?.hasAttribute("data-mention")).toBe(true);
    expect(latest()?.getAttribute("aria-label")).toBe(
      "Ir para as mensagens mais recentes: 1 nova · João · mencionaram você",
    );
    await act(async () => fireEvent.click(latest() as HTMLElement));
    expect(log.scrollTop).toBe(3000);
    expect(latest()).toBeNull();
    expect(at.querySelector(".channel__latest-count")).toBeNull();
    // A frame of the glide down, still far up: the button does not come back.
    log.scrollTop = 1200;
    await act(async () => fireEvent.scroll(log));
    expect(latest()).toBeNull();
  });

  test("a small scroll up lets go at once: new messages don't pull it back down", async () => {
    const { socket } = await open();
    const log = screen().getByRole("region", { name: "Mensagens" });
    Object.defineProperty(log, "scrollHeight", { configurable: true, value: 2000 });
    Object.defineProperty(log, "clientHeight", { configurable: true, value: 500 });
    await sendText("primeira");
    await settle(3);
    expect(log.scrollTop).toBe(2000);
    // A browser reports the scroll to the bottom too (happy-dom doesn't on its own).
    await act(async () => fireEvent.scroll(log));
    // Still inside the "near bottom" band, but moving up.
    log.scrollTop = 1960;
    await act(async () => {
      fireEvent.wheel(log, { deltaY: -40 });
      fireEvent.scroll(log);
    });
    await push(socket, {
      type: "message.created",
      messageId: "m-near",
      message: {
        id: "m-near",
        channelId: ENG_ID,
        threadId: null,
        author: { type: "person", id: "u-joao" },
        body: "mais uma",
        mentionedAgentIds: [],
        agentRunId: null,
        createdAt: new Date().toISOString(),
      },
    });
    await settle();
    expect(log.scrollTop).toBe(1960);
    expect(screen().getByRole("button", { name: /Ir para as mensagens mais recentes/ })).not.toBeNull();
  });

  test("the end shrinking right after a wheel down or a click on a row keeps the list at the bottom", async () => {
    const { socket } = await open();
    const log = screen().getByRole("region", { name: "Mensagens" });
    const height = (value: number) => Object.defineProperty(log, "scrollHeight", { configurable: true, value });
    height(2000);
    Object.defineProperty(log, "clientHeight", { configurable: true, value: 500 });
    await sendText("primeira");
    await settle(3);
    await act(async () => fireEvent.scroll(log));
    const said = (id: string) =>
      push(socket, {
        type: "message.created",
        messageId: id,
        message: {
          id,
          channelId: ENG_ID,
          threadId: null,
          author: { type: "person", id: "u-joao" },
          body: `mensagem ${id}`,
          mentionedAgentIds: [],
          agentRunId: null,
          createdAt: new Date().toISOString(),
        },
      });
    // Wheel down at the bottom, then something at the end gets shorter: the browser clamps scrollTop lower.
    await act(async () => fireEvent.wheel(log, { deltaY: 40 }));
    height(1800);
    log.scrollTop = 1300;
    await act(async () => fireEvent.scroll(log));
    height(2400);
    await said("m-after-wheel");
    await settle();
    expect(log.scrollTop).toBe(2400);
    // A click inside a row (a tools block folding) then the same clamp.
    const row = rowsWith("primeira")[0] as HTMLElement;
    await act(async () => fireEvent.pointerDown(row));
    height(2000);
    log.scrollTop = 1500;
    await act(async () => fireEvent.scroll(log));
    height(2600);
    await said("m-after-click");
    await settle();
    expect(log.scrollTop).toBe(2600);
    expect(screen().queryByRole("button", { name: /Ir para as mensagens mais recentes/ })).toBeNull();
  });

  test("a window without focus still scrolled by the wheel is being read: a new message doesn't pull the list", async () => {
    const { socket } = await open();
    const log = screen().getByRole("region", { name: "Mensagens" });
    Object.defineProperty(log, "scrollHeight", { configurable: true, value: 2000 });
    Object.defineProperty(log, "clientHeight", { configurable: true, value: 500 });
    await sendText("primeira");
    await settle(3);
    // Past the opening, when a new message may bring an idle list to it.
    await act(() => new Promise((r) => setTimeout(r, 1600)));
    const hasFocus = document.hasFocus;
    document.hasFocus = () => false;
    try {
      log.scrollTop = 100;
      await act(async () => {
        fireEvent.wheel(log, { deltaY: -1900 });
        fireEvent.scroll(log);
      });
      await push(socket, {
        type: "message.created",
        messageId: "m-unfocused",
        message: {
          id: "m-unfocused",
          channelId: ENG_ID,
          threadId: null,
          author: { type: "person", id: "u-joao" },
          body: "enquanto lia",
          mentionedAgentIds: [],
          agentRunId: null,
          createdAt: new Date().toISOString(),
        },
      });
      await settle();
      expect(log.scrollTop).toBe(100);
    } finally {
      document.hasFocus = hasFocus;
    }
  });
});

describe("bottom anchoring: reading without a wheel", () => {
  const said = (socket: Parameters<typeof push>[0], id: string) =>
    push(socket, {
      type: "message.created",
      messageId: id,
      message: {
        id,
        channelId: ENG_ID,
        threadId: null,
        author: { type: "person", id: "u-joao" },
        body: `mensagem ${id}`,
        mentionedAgentIds: [],
        agentRunId: null,
        createdAt: new Date().toISOString(),
      },
    });

  test("dragging a selection up from a row lets go of the bottom, even inside the near-bottom band", async () => {
    const { socket } = await open();
    const log = screen().getByRole("region", { name: "Mensagens" });
    const height = (value: number) => Object.defineProperty(log, "scrollHeight", { configurable: true, value });
    height(2000);
    Object.defineProperty(log, "clientHeight", { configurable: true, value: 500 });
    await sendText("primeira");
    await settle(3);
    await act(async () => fireEvent.scroll(log));
    const row = rowsWith("primeira")[0] as HTMLElement;
    const selection = window.getSelection() as Selection;
    try {
      await act(async () => fireEvent.pointerDown(row));
      const range = document.createRange();
      range.selectNodeContents(row);
      selection.removeAllRanges();
      selection.addRange(range);
      // The browser's selection autoscroll moves the list up a little.
      log.scrollTop = 1960;
      await act(async () => fireEvent.scroll(log));
      height(2400);
      await said(socket, "m-while-selecting");
      await settle();
      expect(log.scrollTop).toBe(1960);
    } finally {
      selection.removeAllRanges();
    }
  });

  test("a click on a row doesn't count as reading a window without focus: a new message still brings the list to it", async () => {
    const { socket } = await open();
    const log = screen().getByRole("region", { name: "Mensagens" });
    Object.defineProperty(log, "scrollHeight", { configurable: true, value: 2000 });
    Object.defineProperty(log, "clientHeight", { configurable: true, value: 500 });
    await sendText("primeira");
    await settle(3);
    await act(() => new Promise((r) => setTimeout(r, 1600)));
    // Up by the keys (no wheel), then a click inside a row, then the window loses focus.
    log.scrollTop = 100;
    await act(async () => {
      fireEvent.keyDown(log, { key: "PageUp" });
      fireEvent.scroll(log);
    });
    await act(async () => fireEvent.pointerDown(rowsWith("primeira")[0] as HTMLElement));
    const hasFocus = document.hasFocus;
    document.hasFocus = () => false;
    try {
      await said(socket, "m-away");
      await settle(3);
      expect(log.scrollTop).toBe(2000);
    } finally {
      document.hasFocus = hasFocus;
    }
  });
});

describe("receipts: a check with a popover", () => {
  const checkOf = (text: string) => rowsWith(text)[0]?.querySelector(".ac-receipt__check") as HTMLButtonElement;
  const icon = (b: HTMLElement) => b.querySelector("path")?.getAttribute("d");

  test("clock (nobody picked it up yet) → one check (on it, waiting) → two checks (answered); popover lists each agent", async () => {
    const { socket, state } = await open();
    await sendText("@ada e o login?");
    await settle(4);
    const root = lastPerson(state);
    const check = () => checkOf("e o login?");
    expect(check().getAttribute("aria-label")).toBe("Vista por Ada. Ada vai responder");
    expect(icon(check())).toBe("M10 6v4l2.6 1.8");
    const run = { threadId: root?.id, runId: "r-rc", agentId: ADA_ID };
    await push(socket, { type: "agent.run", ...run, status: "running" });
    expect(check().getAttribute("aria-label")).toBe("Vista por Ada. Ada está respondendo");
    expect(icon(check())).toBe("m5.5 10.5 3 3 6-7");
    await push(socket, { type: "agent.run", ...run, status: "waiting_approval" });
    expect(check().getAttribute("aria-label")).toBe("Vista por Ada. Ada está esperando aprovação");
    expect(icon(check())).toBe("m5.5 10.5 3 3 6-7");
    await push(socket, {
      type: "message.handled",
      messageId: root?.id,
      agentId: ADA_ID,
      runId: "r-rc",
      status: "done",
    });
    expect(check().getAttribute("aria-label")).toBe("Vista por Ada. Ada respondeu");
    expect(icon(check())).toBe("m2 10.5 3 3 6-7M10 12.5l1 1 7-8");
    // Keyboard-openable popover; Esc closes.
    check().focus();
    await act(async () => fireEvent.click(check()));
    const pop = screen().getByRole("dialog", { name: "Agentes" });
    expect(pop.textContent).toContain("Ada");
    expect(pop.textContent).toContain("Respondeu");
    expect(pop.querySelector(".ac-avatar--agent")).not.toBeNull();
    await act(async () => fireEvent.keyDown(pop, { key: "Escape" }));
    await act(() => new Promise((r) => setTimeout(r, 0)));
    expect(screen().queryByRole("dialog", { name: "Agentes" })).toBeNull();
  });

  test("failure: alert icon + 'Não conseguiu responder · Tentar de novo'; nobody: two checks, its popover says it with 'Chamar um agente', each by its face", async () => {
    const seeded = seedState();
    const [ada, atlas] = seeded.agents;
    if (ada) ada.appearance = { color: "green", eyes: "happy", accessory: "headphones" };
    if (atlas) atlas.appearance = { color: "rose", eyes: "sleepy", accessory: "crown" };
    const { socket, state } = await open(seeded);
    await sendText("alguém viu o erro?");
    await settle(4);
    const root = lastPerson(state);
    const receipt = () => rowsWith("alguém viu o erro?")[0]?.querySelector(".ac-receipt") as HTMLElement;
    await push(socket, { type: "message.routed", messageId: root?.id, seenBy: [ADA_ID, ATLAS_ID], pickedBy: [] });
    expect(checkOf("alguém viu o erro?").getAttribute("aria-label")).toBe(
      "Vista por Ada e Atlas. Nenhum agente vai responder",
    );
    // Everyone it was for decided: two checks, and no line in the timeline.
    expect(icon(checkOf("alguém viu o erro?"))).toBe("m2 10.5 3 3 6-7M10 12.5l1 1 7-8");
    expect(receipt().textContent).toBe("");
    expect(rowsWith("alguém viu o erro?")[0]?.querySelector(".ac-msg__foot")?.textContent ?? "").toBe("");
    await act(async () => fireEvent.click(checkOf("alguém viu o erro?")));
    const pop = screen().getByRole("dialog", { name: "Agentes" });
    expect(pop.querySelector(".who-by")?.textContent).toBe("Nenhum agente vai responder·Chamar um agente");
    await act(async () => {
      const call = within(pop).getByRole("button", { name: "Chamar um agente" });
      call.focus();
      fireEvent.keyDown(call, { key: "Enter" });
    });
    // Each agent leads with its own face (its look), not one glyph for all.
    const menu = screen().getByRole("menu");
    const face = (name: RegExp) =>
      within(menu).getByRole("menuitem", { name }).querySelector(":scope > .ac-menu__leading > .ac-avatar--agent");
    expect([face(/Ada/)?.getAttribute("data-eyes"), face(/Ada/)?.getAttribute("data-accessory")]).toEqual([
      "happy",
      "headphones",
    ]);
    expect([face(/Atlas/)?.getAttribute("data-eyes"), face(/Atlas/)?.getAttribute("data-accessory")]).toEqual([
      "sleepy",
      "crown",
    ]);
    expect(menu.querySelector(".ac-menu__item > .ac-icon")).toBeNull();
    await act(async () => fireEvent.click(within(menu).getByRole("menuitem", { name: /Atlas/ })));
    await settle();
    expect((composer() as HTMLTextAreaElement).value).toBe("@atlas ");

    await push(socket, { type: "message.claimed", messageId: root?.id, agentId: ATLAS_ID });
    await push(socket, { type: "message.handled", messageId: root?.id, agentId: ATLAS_ID, status: "failed" });
    expect(icon(checkOf("alguém viu o erro?"))).toBe("M10 6.5v4M10 13.5v.01");
    expect(receipt().textContent).toContain("Não conseguiu responder·Tentar de novo");
    await act(async () => fireEvent.click(within(receipt()).getByRole("button", { name: "Tentar de novo" })));
    await settle(4);
    expect(
      state.calls.filter((c) => c.method === "chat.post").map((c) => (c.args[2] as { body: string }).body),
    ).toEqual(["alguém viu o erro?", "alguém viu o erro?"]);
  });
});

describe("receipts: an agent's reaction is its answer", () => {
  test("'bom dia amigos' that Ada reacted to: two checks, no line in the timeline, the popover says Reagiu and nobody will answer", async () => {
    const { socket, state } = await open();
    await sendText("bom dia amigos");
    await settle(4);
    const root = lastPerson(state);
    await push(socket, {
      type: "message.routed",
      messageId: root?.id,
      seenBy: [ADA_ID],
      pickedBy: [],
      strategy: "router",
    });
    await push(socket, {
      type: "message.reactions",
      messageId: root?.id,
      reactions: [{ reaction: "☀️", count: 1, userIds: [], agentIds: [ADA_ID] }],
    });
    await settle();
    const row = rowsWith("bom dia amigos")[0] as HTMLElement;
    expect(row.textContent).not.toContain("Nenhum agente vai responder");
    expect(row.textContent).not.toContain("Chamar um agente");
    const check = row.querySelector(".ac-receipt__check") as HTMLElement;
    expect(check.querySelector("path")?.getAttribute("d")).toBe("m2 10.5 3 3 6-7M10 12.5l1 1 7-8");
    await act(async () => fireEvent.click(check));
    const pop = screen().getByRole("dialog", { name: "Agentes" });
    expect(pop.querySelector(".ac-popover__row-status")?.textContent).toBe("Reagiu");
    expect(pop.querySelector(".who-by")?.textContent).toBe("Nenhum agente vai responder·Chamar um agente");
  });
});

describe("receipts: an agent the router picked that passed", () => {
  test("'Não respondeu' on its row and 'Ninguém respondeu' with 'Chamar um agente', never 'Respondeu'", async () => {
    const { socket, state } = await open();
    await sendText("alguém sabe onde rodam os builds?");
    await settle(4);
    const root = lastPerson(state);
    const run = { threadId: root?.id, runId: "r-pass", agentId: ADA_ID };
    await push(socket, {
      type: "message.routed",
      messageId: root?.id,
      seenBy: [ADA_ID],
      pickedBy: [ADA_ID],
      runs: [{ agentId: ADA_ID, runId: "r-pass" }],
      strategy: "router",
    });
    // What the executor sends when it passes and posts nothing.
    await push(socket, { type: "agent.run", ...run, status: "running" });
    await push(socket, { type: "agent.passed", ...run });
    await push(socket, { type: "agent.run", ...run, status: "done" });
    await push(socket, { type: "run.finished", ...run, status: "done" });
    await push(socket, {
      type: "message.handled",
      messageId: root?.id,
      agentId: ADA_ID,
      runId: "r-pass",
      status: "done",
      passed: true,
    });
    await settle();
    const check = rowsWith("alguém sabe onde rodam os builds?")[0]?.querySelector(".ac-receipt__check") as HTMLElement;
    expect(check.getAttribute("aria-label")).toContain("Ninguém respondeu");
    expect(check.querySelector("path")?.getAttribute("d")).toBe("m2 10.5 3 3 6-7M10 12.5l1 1 7-8");
    await act(async () => fireEvent.click(check));
    const pop = screen().getByRole("dialog", { name: "Agentes" });
    expect(pop.querySelector(".ac-popover__row-status")?.textContent).toBe("Não respondeu");
    expect(pop.textContent).not.toContain("Respondeu");
    expect(pop.querySelector(".who-by")?.textContent).toBe("Ninguém respondeu·Chamar um agente");
    expect(within(pop).getByRole("button", { name: "Chamar um agente" })).toBeTruthy();
  });

  test("a run that only reacted reads 'Reagiu', not 'Respondeu'", async () => {
    const { socket, state } = await open();
    await sendText("bom dia, time");
    await settle(4);
    const root = lastPerson(state);
    await push(socket, {
      type: "message.routed",
      messageId: root?.id,
      seenBy: [ADA_ID],
      pickedBy: [ADA_ID],
      runs: [{ agentId: ADA_ID, runId: "r-react" }],
      strategy: "router",
    });
    await push(socket, {
      type: "message.reactions",
      messageId: root?.id,
      reactions: [{ reaction: "☀️", count: 1, userIds: [], agentIds: [ADA_ID] }],
    });
    await push(socket, {
      type: "message.handled",
      messageId: root?.id,
      agentId: ADA_ID,
      runId: "r-react",
      status: "done",
    });
    await settle();
    const check = rowsWith("bom dia, time")[0]?.querySelector(".ac-receipt__check") as HTMLElement;
    await act(async () => fireEvent.click(check));
    const pop = screen().getByRole("dialog", { name: "Agentes" });
    expect(pop.querySelector(".ac-popover__row-status")?.textContent).toBe("Reagiu");
  });
});

describe("receipts: the clock from the moment it is sent", () => {
  test("no mention in a channel with agents: the clock at once, before the server says anything, then the router's word", async () => {
    const { socket, state } = await open();
    await sendText("alguém por aí?");
    await settle(4);
    const clock = rowsWith("alguém por aí?")[0]?.querySelector(".ac-receipt__check") as HTMLElement;
    expect(clock.getAttribute("aria-label")).toBe("Escolhendo quem responde");
    expect(clock.querySelector("path")?.getAttribute("d")).toBe("M10 6v4l2.6 1.8");
    await push(socket, {
      type: "message.routed",
      messageId: lastPerson(state)?.id,
      seenBy: [ADA_ID],
      pickedBy: [],
      strategy: "router",
    });
    const checks = rowsWith("alguém por aí?")[0]?.querySelector(".ac-receipt__check") as HTMLElement;
    expect(checks.querySelector("path")?.getAttribute("d")).toBe("m2 10.5 3 3 6-7M10 12.5l1 1 7-8");
  });
});

describe("receipts: who picked the agents for a message nobody mentioned", () => {
  const receiptOf = (text: string) => rowsWith(text)[0]?.querySelector(".ac-receipt") as HTMLElement;
  const popoverOf = async (text: string) => {
    await act(async () => fireEvent.click(receiptOf(text).querySelector(".ac-receipt__check") as HTMLElement));
    return screen().getByRole("dialog", { name: "Agentes" });
  };
  const closePopover = async (pop: HTMLElement) => {
    await act(async () => fireEvent.keyDown(pop, { key: "Escape" }));
    await act(() => new Promise((r) => setTimeout(r, 0)));
  };

  test("no step could pick: its popover says 'sem @', why, Chamar um agente and how agents are picked", async () => {
    const { socket, state } = await open();
    await sendText("alguém sabe?");
    await settle(4);
    const root = lastPerson(state);
    await push(socket, {
      type: "message.routed",
      messageId: root?.id,
      seenBy: [ADA_ID, ATLAS_ID],
      pickedBy: [],
      strategy: "router",
      reason: "mention_needed",
    });
    const receipt = receiptOf("alguém sabe?");
    expect(receipt.querySelector(".ac-receipt__check")?.getAttribute("aria-label")).toBe(
      "Vista por Ada e Atlas. Nenhum agente vai responder sem @",
    );
    // Nothing in the timeline: the words are the mark's popover's.
    expect(receipt.textContent).toBe("");
    const pop = await popoverOf("alguém sabe?");
    const lines = [...pop.querySelectorAll(".who-by")];
    expect(lines.map((l) => l.textContent)).toEqual([
      "Nenhum agente vai responder sem @·Chamar um agente",
      "Nenhuma IA aqui conseguiu escolher um agente para esta mensagem. Mencione um agente para chamá-lo.Como os agentes são escolhidos",
    ]);
    expect(within(pop).getByRole("button", { name: "Chamar um agente" })).toBeTruthy();
    expect(within(pop).getByRole("link", { name: "Como os agentes são escolhidos" }).getAttribute("href")).toBe(
      "https://agentes.chat/pt/docs/who-answers",
    );
  });

  test("'Escolhendo quem responde': the clock where the check goes while the author's plan reads it, then who picked", async () => {
    const { socket, state } = await open();
    await sendText("revisa o PR?");
    await settle(4);
    const root = lastPerson(state);
    await push(socket, { type: "message.routing", messageId: root?.id, step: "plan" });
    // A mark, not a line: its words are its name and its popover's line, with "Chamar um agente".
    const clock = receiptOf("revisa o PR?").querySelector(".ac-receipt__check") as HTMLElement;
    expect(clock.getAttribute("aria-label")).toBe("Escolhendo quem responde");
    expect(clock.querySelector("path")?.getAttribute("d")).toBe("M10 6v4l2.6 1.8");
    expect(rowsWith("revisa o PR?")[0]?.querySelector(".ac-msg__foot")?.textContent).toBe("");
    const picking = await popoverOf("revisa o PR?");
    expect(picking.querySelector(".who-by")?.textContent).toBe("Escolhendo quem responde·Chamar um agente");
    await act(async () => {
      const call = within(picking).getByRole("button", { name: "Chamar um agente" });
      call.focus();
      fireEvent.keyDown(call, { key: "Enter" });
    });
    await act(async () => fireEvent.click(screen().getByRole("menuitem", { name: /Atlas/ })));
    await settle();
    expect((composer() as HTMLTextAreaElement).value).toBe("@atlas ");
    await closePopover(picking);
    await push(socket, {
      type: "message.routed",
      messageId: root?.id,
      seenBy: [ADA_ID, ATLAS_ID],
      pickedBy: [ADA_ID],
      strategy: "router",
      decidedBy: { step: "plan", brand: "claude", ownerId: "u-walter" },
    });
    // Picked, still in line: the clock stays until Ada is on it.
    const check = receiptOf("revisa o PR?").querySelector(".ac-receipt__check") as HTMLElement;
    expect(check.getAttribute("aria-label")).toBe("Vista por Ada e Atlas. Ada vai responder");
    expect(check.querySelector("path")?.getAttribute("d")).toBe("M10 6v4l2.6 1.8");
    const pop = await popoverOf("revisa o PR?");
    expect(pop.textContent).not.toContain("Escolhendo");
    // Which AI picked (here the person's own plan) isn't said.
    expect(pop.querySelector(".who-by")).toBeNull();
  });

  test("the popover's last line says the rule that picked, with our icon; an AI's pick, a decision for nobody or from before says nothing", async () => {
    const { socket, state } = await open();
    const cases: [Record<string, unknown>, string | null][] = [
      [{ step: "jev" }, null],
      [{ step: "model", model: "claude-haiku-5-5", provider: "anthropic" }, null],
      [{ step: "plan", brand: "chatgpt", ownerId: "u-joao" }, null],
      [{ step: "rule", rule: "reply" }, "Uma resposta para a Ada"],
      [{ step: "rule", rule: "only_agent" }, "Só a Ada responde aqui sem menção"],
      [{ step: "rule", rule: "follow_up" }, "Segue a conversa com a Ada"],
      // Alone with the team: no line, the decision stays stored.
      [{ step: "rule", rule: "alone" }, null],
      // Stored before the team's coordinator was retired (ADR 0137): the default rule's line.
      [{ step: "rule", rule: "coordinator" }, "Ninguém foi chamado, então a Ada respondeu"],
    ];
    for (const [i, [decidedBy, words]] of cases.entries()) {
      const text = `pergunta ${i + 1}`;
      await sendText(text);
      await settle(4);
      await push(socket, {
        type: "message.routed",
        messageId: lastPerson(state)?.id,
        seenBy: [ADA_ID],
        pickedBy: [ADA_ID],
        strategy: "router",
        decidedBy,
      });
      const pop = await popoverOf(text);
      const by = pop.querySelector(".who-by") as HTMLElement | null;
      expect([text, by?.textContent ?? null]).toEqual([text, words]);
      if (!by) {
        expect(pop.textContent).not.toContain("Escolhido");
        await closePopover(pop);
        continue;
      }
      expect(by.className).toContain("ac-iconline");
      expect(by.firstElementChild?.classList.contains("ac-icon")).toBe(true);
      await closePopover(pop);
    }
    for (const [text, routed] of [
      ["de antes", { pickedBy: [ADA_ID] }],
      ["ninguém pegou", { pickedBy: [], decidedBy: { step: "jev" } }],
    ] as const) {
      await sendText(text);
      await settle(4);
      await push(socket, { type: "message.routed", messageId: lastPerson(state)?.id, seenBy: [ADA_ID], ...routed });
      const pop = await popoverOf(text);
      // Nobody picked: the line says so, never who picked.
      expect([text, [...pop.querySelectorAll(".who-by")].map((l) => l.textContent)]).toEqual([
        text,
        text === "ninguém pegou" ? ["Nenhum agente vai responder·Chamar um agente"] : [],
      ]);
      await closePopover(pop);
    }
    expect(rowsWith("ninguém pegou")[0]?.textContent).not.toContain("Nenhum agente vai responder");
  });
});

describe("regression: the router picks nobody (production #general, 'oi' after 'oi @Theo')", () => {
  test("a mention answered, then a no-mention message: no thinking shown, receipt says nobody", async () => {
    // #general with exactly one person and one agent: it is NOT a DM.
    const state = comfortable(seedState());
    state.channelMembers[GENERAL_ID] = [
      { type: "person", id: "u-walter" },
      { type: "agent", id: ADA_ID },
    ];
    const { socket } = await open(state, `c/${GENERAL_ID}`);
    const pushG = (e: Record<string, unknown>) => push(socket, e, GENERAL_ID);

    // With the @ list open the first Enter picks the name; the next one sends.
    await sendText("oi @ada");
    await act(async () => fireEvent.keyDown(composer(), { key: "Enter" }));
    await settle(4);
    const first = lastPerson(state);
    expect(bar().textContent).toBe("Ada pensando…");
    const run = { threadId: first?.id, runId: "r-1st", agentId: ADA_ID };
    await pushG({ type: "agent.typing", ...run });
    await pushG({
      type: "message.created",
      messageId: "reply-1",
      message: {
        id: "reply-1",
        channelId: GENERAL_ID,
        threadId: first?.id,
        author: { type: "agent", id: ADA_ID },
        body: "Oi, tudo bem?",
        mentionedAgentIds: [],
        agentRunId: "r-1st",
        createdAt: new Date().toISOString(),
      },
    });
    await pushG({ type: "message.handled", messageId: first?.id, agentId: ADA_ID, runId: "r-1st", status: "done" });
    await settle();
    expect(bar().textContent).toBe("");

    await sendText("oi");
    // No mention: nothing is assumed before the router decides.
    expect(bar().textContent).toBe("");
    await settle(4);
    const second = lastPerson(state);
    expect(second?.body).toBe("oi");
    // Only the clock until then: sent, nobody picked it up yet.
    expect(rowsWith("oi").at(-1)?.querySelector(".ac-receipt__check")?.getAttribute("aria-label")).toBe(
      "Escolhendo quem responde",
    );
    await pushG({ type: "message.routed", messageId: second?.id, seenBy: [ADA_ID], pickedBy: [], strategy: "router" });
    await settle();
    expect(bar().textContent).toBe("");
    const receipt = rowsWith("oi").at(-1)?.querySelector(".ac-receipt") as HTMLElement;
    expect(rowsWith("oi").at(-1)?.textContent).not.toContain("Nenhum agente vai responder");
    expect(receipt.querySelector(".ac-receipt__check")?.getAttribute("aria-label")).toBe(
      "Vista por Ada. Nenhum agente vai responder",
    );
    // The first message is now an earlier bubble of the turn: the mark stands under its last one.
    expect(rowsWith("oi @Ada")[0]?.querySelector(".ac-receipt__check")).toBeNull();
  });
});

describe("empty conversations", () => {
  test("a channel: its greeting, its line and the suggestions; a DM with a person: the greeting alone", async () => {
    await open(seedState(), `c/${GENERAL_ID}`);
    await settle(4);
    const channel = document.querySelector(".ac-empty") as HTMLElement;
    expect(channel.querySelector(".ac-empty__title")?.textContent).toBe("Diga oi em #general");
    expect(channel.querySelector(".ac-empty__text")?.textContent).toBe(
      "Mencione um agente com @ e ele entra na conversa.",
    );
    cleanup();
    await open(seedState(), "dm/person/u-joao");
    await settle(4);
    const dm = document.querySelector(".ac-empty") as HTMLElement;
    expect(dm.querySelector(".ac-empty__title")?.textContent).toBe("Diga oi para João");
    expect(dm.querySelector(".ac-empty__text")).toBeNull();
  });

  test("a channel's suggestions go to the first agent with a handle someone chose, by name; with none, to the first agent", async () => {
    const state = seedState();
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (!ada) throw new Error("no Ada");
    const imported = "00000000-0000-4000-8000-0000000000a9";
    const alsoImported = "00000000-0000-4000-8000-0000000000aa";
    state.agents.push(
      { ...ada, id: imported, name: "New agent", handle: "agent-e9665a97-c8d5-423f-ae59-25", role: "" },
      { ...ada, id: alsoImported, name: "Rita Revisão", handle: "agent-925ca021-21e4-4053-9e0a-23", role: "" },
    );
    state.channelMembers[GENERAL_ID] = [
      { type: "person", id: "u-walter" },
      { type: "agent", id: imported },
      { type: "agent", id: ADA_ID },
    ];
    await open(state, `c/${GENERAL_ID}`);
    await settle(4);
    const suggestion = screen().getByRole("button", { name: "@Ada O que quebrou desde o último deploy?" });
    expect(document.querySelector(".channel__suggestions")?.textContent).not.toContain("agent-");
    await act(async () => fireEvent.click(suggestion));
    expect((composer() as HTMLTextAreaElement).value).toBe("@ada O que quebrou desde o último deploy?");
    cleanup();

    state.channelMembers[GENERAL_ID] = [
      { type: "person", id: "u-walter" },
      { type: "agent", id: imported },
      { type: "agent", id: alsoImported },
    ];
    await open(state, `c/${GENERAL_ID}`);
    await settle(4);
    await act(async () =>
      fireEvent.click(screen().getByRole("button", { name: "@New agent Oi, o que você sabe fazer?" })),
    );
    expect((composer() as HTMLTextAreaElement).value).toBe(
      "@agent-e9665a97-c8d5-423f-ae59-25 Oi, o que você sabe fazer?",
    );
  });
});

test("a DM's head: the name with a line under it rises to the face's top, a person's as an agent's", async () => {
  await open(seedState(), "dm/person/u-joao");
  await settle(4);
  const person = screen().getByRole("heading", { level: 1, name: "João" });
  expect(person.className).toBe("channel__title ac-captop");
  expect(person.nextElementSibling?.textContent).toBe("joao@acme.com.br");
  cleanup();
  await open(seedState(), `dm/agent/${ADA_ID}`);
  await settle(4);
  const ada = screen().getByRole("heading", { level: 1, name: "Ada" });
  expect(ada.className).toBe("channel__title ac-captop");
  // The name in a span of its own, so a phone's title keeps its line and a pill goes under it when both don't fit.
  expect(ada.firstElementChild?.className).toBe("channel__name");
  expect(ada.firstElementChild?.textContent).toBe("Ada");
});

describe("direct messages with an agent", () => {
  test("empty DM: 'Diga oi para a Ada' with first messages from her role; one goes to the composer", async () => {
    await open(seedState(), `dm/agent/${ADA_ID}`);
    await settle(4);
    expect(document.body.textContent).toContain("Diga oi para a Ada");
    const suggestion = screen().getByRole("button", { name: "O que quebrou desde o último deploy?" });
    await act(async () => fireEvent.click(suggestion));
    expect((composer() as HTMLTextAreaElement).value).toBe("O que quebrou desde o último deploy?");
    expect(document.activeElement === composer()).toBe(true);
  });

  test("a plan thinks for the agent: the DM header says its model by that plan, with its mark", async () => {
    const state = seedState();
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada) ada.brain = { kind: "claude_code", model: "Sonnet", computer: "MacBook" };
    await open(state, `dm/agent/${ADA_ID}`);
    await settle(4);
    expect(document.body.textContent).toContain("Dev · de João · Sonnet pelo plano do Claude");
    expect(document.body.textContent).not.toContain("Claude Sonnet 5.5");
    const brain = document.querySelector(".channel__brain") as HTMLElement;
    expect(brain.querySelector(".ac-brand[data-mark='claude']")).not.toBeNull();
    cleanup();
    // Who doesn't see its computer (a member) reads whose plan it is.
    const member = seedState();
    const codex = member.agents.find((a) => a.id === ADA_ID);
    if (codex) codex.brain = { kind: "codex", model: "GPT-6 Sol" };
    await open(member, `dm/agent/${ADA_ID}`);
    await settle(4);
    expect(document.body.textContent).toContain("Dev · de João · GPT-6 Sol pelo plano do ChatGPT de João");
  });

  test("sidebar agent → DM via POST /dms: header with role, owner and model; empty state; the agent answers without a mention", async () => {
    const state = seedState();
    await open(state, `dm/agent/${ADA_ID}`);
    await settle(4);
    expect(state.calls.find((c) => c.method === "dms.open")?.args).toEqual([ORG_ID, { agentId: ADA_ID }]);
    expect(screen().getByRole("heading", { level: 1, name: "Ada" })).toBeTruthy();
    expect(document.body.textContent).toContain("Dev · de João · Claude Sonnet 5.5");
    // The header's face and name: the agent's page in the panel beside the conversation (like a thread's), closed by its ×.
    const header = document.querySelector(".channel__header") as HTMLElement;
    await act(async () => fireEvent.click(within(header).getByRole("button", { name: "Perfil de Ada" })));
    await settle(4);
    const side = screen().getByRole("complementary", { name: "Perfil da Ada" });
    await act(async () => fireEvent.click(within(side).getByRole("button", { name: "Fechar" })));
    expect(screen().queryByRole("complementary", { name: "Perfil da Ada" })).toBeNull();
    expect(document.querySelector(".ac-empty__text")?.textContent).toBe(
      "Peça para lembrar, esquecer ou trabalhar de outro jeito.",
    );
    // Empty or not, the DM is Ada's row under Agentes.
    await settle(4);
    const nav = screen().getByRole("navigation", { name: "Navegação do workspace" });
    const dmLinks = () =>
      within(nav)
        .queryAllByRole("link", { name: /Ada/ })
        .map((l) => l.getAttribute("href"));
    expect(dmLinks()).toContain(`/org/${ORG_ID}/dm/agent/${ADA_ID}`);
    await sendText("lembra que deploy é só de segunda a quinta");
    expect(bar().textContent).toBe("Ada pensando…");
  });
});

describe("memory changes and proposals in the chat", () => {
  test("'memória atualizada' card (memory.updated) with a link to that memory, and nothing to undo", async () => {
    const { socket } = await open();
    await push(socket, {
      type: "memory.updated",
      threadId: "m-1",
      agentId: ADA_ID,
      runId: "r-mem",
      update: {
        action: "remembered",
        itemId: "mem-5",
        text: "O login usa tokens de 15 minutos.",
        requestedByUserId: "u-walter",
        undo: { method: "POST", path: `/api/app/organizations/${ORG_ID}/memories/mem-5/revert` },
      },
    });
    await settle();
    const card = screen().getByRole("group", { name: "Memória atualizada por Ada" });
    expect(card.textContent).toContain("Ada lembrou");
    expect(card.textContent).toContain("O login usa tokens de 15 minutos.");
    expect(within(card).getByRole("link", { name: "O que a Ada sabe" }).getAttribute("href")).toBe(
      `/org/${ORG_ID}/agents/${ADA_ID}/memory?item=mem-5`,
    );
    expect(within(card).queryAllByRole("button")).toHaveLength(0);
  });

  test("after a reload, cards come from meta.memoryUpdates on the agent's message", async () => {
    const state = seedState();
    state.messages.push({
      id: "msg-mem",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: ADA_ID },
      body: "Pronto, esqueci.",
      mentionedAgentIds: [],
      agentRunId: "r-mem",
      meta: {
        memoryUpdates: [
          {
            action: "forgot",
            itemId: "mem-7",
            text: "O staging fica em staging.acme.com.br.",
            requestedByUserId: "u-walter",
            undo: { method: "POST", path: "/x" },
          },
        ],
      },
      createdAt: new Date().toISOString(),
    });
    await open(state);
    const card = screen().getByRole("group", { name: "Memória atualizada por Ada" });
    expect(card.textContent).toContain("Ada esqueceu");
    expect(card.querySelector(".struck")?.textContent).toBe("O staging fica em staging.acme.com.br.");
    expect(within(card).queryAllByRole("button")).toHaveLength(0);
  });

  test("a proposed change (memory.updated, proposed) shows the proposal inline", async () => {
    const { socket } = await open();
    await push(socket, {
      type: "memory.updated",
      threadId: "m-1",
      agentId: ADA_ID,
      runId: "r-p",
      update: {
        action: "proposed",
        itemId: "x",
        text: "",
        requestedByUserId: "u-walter",
        proposalId: "prop-1",
        canDecide: true,
      },
    });
    await settle();
    expect(screen().getByRole("group", { name: "Proposta de mudança de Ada" })).toBeTruthy();
  });

  test("a proposal in the chat: Ver a mudança opens the diff, Editar there, Aceitar / Recusar in the footer", async () => {
    const state = seedState();
    state.messages.push({
      id: "msg-prop",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: ADA_ID },
      body: "",
      mentionedAgentIds: [],
      agentRunId: "r-prop",
      meta: { proposalId: "prop-1" },
      createdAt: new Date().toISOString(),
    });
    await open(state);
    const card = screen().getByRole("group", { name: "Proposta de mudança de Ada" });
    expect(card.getAttribute("data-ask-kind")).toBe("proposal");
    // The change is behind "Ver a mudança", drawn as its Markdown in green and red blocks; Editar lives there too.
    expect(card.querySelector(".ac-diff__block--add")).toBeNull();
    await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Ver a mudança" })));
    expect(card.querySelectorAll(".ac-diff__block--add").length).toBeGreaterThan(0);
    await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Editar" })));
    await act(async () =>
      fireEvent.change(within(card).getByLabelText("Texto final das instruções"), {
        target: { value: "Só PRs pequenos." },
      }),
    );
    await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Aceitar com ajustes" })));
    await settle(4);
    expect(state.calls.find((c) => c.method === "proposals.accept")?.args).toEqual([
      ORG_ID,
      "prop-1",
      "Só PRs pequenos.",
    ]);
    // Decided: one line takes its place (another element).
    const done = screen().getByRole("group", { name: "Proposta de mudança de Ada" });
    expect(done.querySelector(".rq-done__mark[data-done]")).not.toBeNull();
    expect(done.textContent).toContain("Aceita");
  });
});

describe("caught up once the server confirms the channel's subscription", () => {
  test("a message written before then is added; one heard live while that read was on its way stays", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    // Each read is made when asked; its answer can be held back, as on a slow link.
    let held: Promise<void> | null = null;
    const read = api.chat.messages;
    api.chat.messages = async (orgId, channelId, options) => {
      const list = await read(orgId, channelId, options);
      if (held) await held;
      return list;
    };
    const { sockets } = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(5);
    const socket = sockets.last();
    await act(async () => socket.open());
    await settle(2);
    // Atlas wrote while the socket opened: no event carries it.
    state.messages.push({
      id: "m-before",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: ATLAS_ID },
      body: "Deploy das 9h revertido.",
      mentionedAgentIds: [],
      agentRunId: "r-before",
      createdAt: new Date().toISOString(),
    });
    expect(rowsWith("Deploy das 9h revertido.")).toHaveLength(0);
    let release = () => {};
    held = new Promise<void>((r) => {
      release = r;
    });
    await act(async () => socket.push({ type: "subscribed", channelId: ENG_ID }));
    await settle(2);
    // Ada answers live while that read, made before her answer, is on its way.
    await push(socket, {
      type: "message.created",
      messageId: "m-live",
      message: {
        id: "m-live",
        channelId: ENG_ID,
        threadId: null,
        author: { type: "agent", id: ADA_ID },
        body: "Login de volta ao normal.",
        mentionedAgentIds: [],
        agentRunId: "r-live",
        createdAt: new Date(Date.now() + 1000).toISOString(),
      },
    });
    await settle();
    expect(rowsWith("Login de volta ao normal.")).toHaveLength(1);
    await act(async () => release());
    await settle(4);
    expect(rowsWith("Deploy das 9h revertido.")).toHaveLength(1);
    expect(rowsWith("Login de volta ao normal.")).toHaveLength(1);
  });

  test("an open thread's replies too", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    await api.threads.create(ORG_ID, {
      id: "m-1",
      channelId: ENG_ID,
      firstMessageId: "m-1",
      lastMessageId: "m-1",
      title: "Login com 401",
    } as Parameters<typeof api.threads.create>[1]);
    const { sockets } = await renderApp(`/org/${ORG_ID}/threads/m-1`, { api });
    await settle(8);
    const socket = sockets.last();
    await act(async () => socket.open());
    await settle(2);
    state.messages.push({
      id: "m-reply",
      channelId: ENG_ID,
      threadId: "m-1",
      author: { type: "agent", id: ADA_ID },
      body: "Corrigido: o refresh usa segundos agora.",
      mentionedAgentIds: [],
      agentRunId: "r-reply",
      createdAt: new Date().toISOString(),
    });
    expect(rowsWith("Corrigido: o refresh usa segundos agora.")).toHaveLength(0);
    await act(async () => socket.push({ type: "subscribed", channelId: ENG_ID }));
    await settle(4);
    expect(rowsWith("Corrigido: o refresh usa segundos agora.")).toHaveLength(1);
  });

  /** João's message to Ada, read while her run was at `status`. */
  const askedAda = (state: ReturnType<typeof seedState>, status: "running" | "waiting_input") => {
    const m1 = state.messages.find((m) => m.id === "m-1");
    if (m1)
      m1.receipts = {
        seenBy: [ADA_ID],
        pickedBy: [ADA_ID],
        handled: [{ agentId: ADA_ID, runId: "r-ada", status }],
        blocked: [],
      };
  };
  const question = {
    id: "q1",
    agentId: ADA_ID,
    runId: "r-ada",
    channelId: ENG_ID,
    threadId: null,
    messageId: "msg-q",
    text: "Reverto o deploy das 9h?",
    choices: ["Sim", "Não"],
    status: "open",
    answer: null,
    answeredByUserId: null,
  };
  const questionCard = {
    id: "msg-q",
    channelId: ENG_ID,
    threadId: null,
    author: { type: "agent" as const, id: ADA_ID },
    body: "",
    mentionedAgentIds: [],
    agentRunId: "r-ada",
    meta: { question },
    createdAt: new Date().toISOString(),
  };
  const receiptOfM1 = () =>
    rowsWith("o login está devolvendo 401")[0]?.querySelector(".ac-receipt__check")?.getAttribute("aria-label");
  const event = (e: Record<string, unknown>) => ({
    type: "event",
    channelId: ENG_ID,
    event: { channelId: ENG_ID, ...e },
  });

  test("her question after then: the receipt waits for the answer, and the page seeding its list again keeps that", async () => {
    const state = seedState();
    askedAda(state, "running");
    const { socket } = await open(state);
    await act(async () => socket.push({ type: "subscribed", channelId: ENG_ID }));
    await settle(4);
    expect(receiptOfM1()).toBe("Vista por Ada. Ada está respondendo");
    // Her card, her question and her run's wait arrive together, before the page draws the card.
    await act(async () => {
      socket.push(event({ type: "message.created", messageId: "msg-q", message: questionCard }));
      socket.push(event({ type: "question.asked", threadId: null, question }));
      socket.push(
        event({ type: "agent.run", threadId: null, runId: "r-ada", agentId: ADA_ID, status: "waiting_input" }),
      );
    });
    await settle(4);
    expect(screen().getByRole("group", { name: "Pergunta de Ada" })).toBeTruthy();
    expect(receiptOfM1()).toBe("Vista por Ada. Ada está esperando uma resposta");
  });

  test("her question before then: its card and the wait for the answer show, and stay as the list changes", async () => {
    const state = seedState();
    askedAda(state, "running");
    const { socket } = await open(state);
    expect(receiptOfM1()).toBe("Vista por Ada. Ada está respondendo");
    // She asks while the channel's subscription opens: no event carries it.
    state.messages.push(questionCard);
    askedAda(state, "waiting_input");
    await act(async () => socket.push({ type: "subscribed", channelId: ENG_ID }));
    await settle(4);
    expect(screen().getByRole("group", { name: "Pergunta de Ada" })).toBeTruthy();
    expect(receiptOfM1()).toBe("Vista por Ada. Ada está esperando uma resposta");
    await push(socket, {
      type: "message.created",
      messageId: "m-atlas",
      message: {
        id: "m-atlas",
        channelId: ENG_ID,
        threadId: null,
        author: { type: "agent", id: ATLAS_ID },
        body: "Deploy das 9h no ar.",
        mentionedAgentIds: [],
        agentRunId: "r-atlas",
        createdAt: new Date(Date.now() + 1000).toISOString(),
      },
    });
    await settle(4);
    expect(rowsWith("Deploy das 9h no ar.")).toHaveLength(1);
    expect(receiptOfM1()).toBe("Vista por Ada. Ada está esperando uma resposta");
  });
});

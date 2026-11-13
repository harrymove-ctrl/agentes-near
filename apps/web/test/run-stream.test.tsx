import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Message } from "@agenteschat/client";
import { applyChannelEvent, emptyStreams, runsInChannel, type StreamsState } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const base = { channelId: "c", threadId: "t", agentId: "ada", runId: "r" };
type Ev = Parameters<typeof applyChannelEvent>[1];
const run = (events: Ev[], s: StreamsState = emptyStreams) => events.reduce(applyChannelEvent, s);

describe("a reply with tools in between: its words wait for its message", () => {
  test("agent.typing says it writes; an older server's deltas add no words", () => {
    const s = run([
      { type: "agent.run", ...base, status: "running" } as Ev,
      { type: "agent.typing", ...base } as Ev,
      { type: "agent.delta", ...base, seq: 0, text: "Primeiro pedaço. " },
      { type: "agent.delta", ...base, seq: 1, text: "Segundo." },
    ]);
    expect(runsInChannel(s, "c")[0]?.status).toBe("running");
    expect(JSON.stringify(runsInChannel(s, "c")[0])).not.toContain("pedaço");
  });

  test("3 model calls: the calls and their output are its work, nothing it said; the final message ends it", () => {
    let s = run([
      { type: "agent.run", ...base, status: "running" } as Ev,
      { type: "agent.typing", ...base } as Ev,
      {
        type: "agent.tool",
        ...base,
        tool: "run_code",
        toolUseId: "t1",
        code: { language: "bash", source: "go version" },
      },
      { type: "agent.tool.output", ...base, toolUseId: "t1", stream: "stderr", text: "go: not found" },
      { type: "agent.tool", ...base, tool: null },
      {
        type: "agent.tool",
        ...base,
        tool: "run_code",
        toolUseId: "t2",
        code: { language: "bash", source: "gcc --version" },
      },
      { type: "agent.tool", ...base, tool: null },
      { type: "agent.typing", ...base } as Ev,
    ]);
    const r = runsInChannel(s, "c")[0];
    expect(r?.status).toBe("running");
    expect(
      (r?.work ?? []).map((c) => (c.kind === "call" ? [c.id, c.running, c.output.map((o) => o.text).join("")] : [])),
    ).toEqual([
      ["t1", false, "go: not found"],
      ["t2", false, ""],
    ]);
    s = applyChannelEvent(s, {
      type: "message.created",
      channelId: "c",
      messageId: "m",
      message: { agentRunId: "r", author: { type: "agent", id: "ada" }, threadId: "t" } as Message,
    });
    expect(runsInChannel(s, "c")).toHaveLength(0);
  });
});

describe("live row and Parar", () => {
  const open = async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(5);
    const socket = r.sockets.last();
    await act(async () => socket.open());
    await settle(2);
    const ev = (event: Record<string, unknown>) =>
      act(async () => socket.push({ type: "event", channelId: ENG_ID, event: { channelId: ENG_ID, ...event } }));
    return { state, api, ev };
  };
  const ids = { threadId: null, runId: "r-live", agentId: ADA_ID };

  test("its tools: the bar says the one running; its reply, posted whole, keeps them folded in its steps", async () => {
    const { ev } = await open();
    await ev({ type: "agent.run", ...ids, status: "running" });
    await ev({ type: "agent.typing", ...ids });
    await ev({
      type: "agent.tool",
      ...ids,
      tool: "run_code",
      toolUseId: "t1",
      code: { language: "python", source: "print(1)" },
    });
    await ev({ type: "agent.tool", ...ids, tool: null, toolUseId: "t1" });
    await ev({
      type: "agent.tool",
      ...ids,
      tool: "run_code",
      toolUseId: "t2",
      code: { language: "python", source: "print(2)" },
    });
    await ev({ type: "agent.tool.output", ...ids, toolUseId: "t2", stream: "stdout", text: "2\n" });
    await settle(3);
    // Nothing of it in the conversation while it works: the bar says the step.
    expect(document.querySelector(".ac-msg--streaming")).toBeNull();
    expect(document.querySelector(".ac-typing__text")?.textContent).toContain("rodando código");
    await ev({ type: "agent.tool", ...ids, tool: null, toolUseId: "t2" });
    await ev({
      type: "message.created",
      messageId: "m-reply",
      message: {
        id: "m-reply",
        channelId: ENG_ID,
        threadId: null,
        author: { type: "agent", id: ADA_ID },
        body: "Deu 2.",
        mentionedAgentIds: [],
        agentRunId: "r-live",
        createdAt: new Date(Date.now() + 10_000).toISOString(),
      },
    });
    await ev({ type: "agent.run", ...ids, status: "done" });
    await settle(4);
    const reply = document.querySelector('[data-message-id="m-reply"]') as HTMLElement;
    expect(reply.querySelector(".ac-msg__text")?.textContent).toBe("Deu 2.");
    const head = reply.querySelector(".ac-tools__head") as HTMLElement;
    expect(head.getAttribute("aria-expanded")).toBe("false");
    await act(async () => fireEvent.click(head));
    const lines = [...reply.querySelectorAll<HTMLElement>("button.ac-tools__row")];
    expect(lines).toHaveLength(2);
    expect(lines.at(-1)?.textContent).toContain("Rodou 1 linha de python · saída 2 B");
  });

  test("Parar: one click on the composer's stop, its row goes, then its stopped message: 'You stopped Ada | Continue'", async () => {
    const { state, ev } = await open();
    await ev({ type: "agent.run", ...ids, status: "running" });
    await ev({ type: "agent.typing", ...ids });
    await settle(2);
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Parar a Ada" })));
    await settle(2);
    // Nothing asked: it stops at once.
    expect(screen().queryByRole("dialog")).toBeNull();
    expect(state.calls.find((c) => c.method === "agents.cancelRun")?.args).toEqual([ORG_ID, "r-live"]);
    await ev({ type: "run.canceled", ...ids, byUserId: "u-walter" });
    await settle(2);
    // What it wrote comes whole in the message the server posts for the stop.
    expect(document.body.textContent).not.toContain("Começando a análise");
    await ev({
      type: "message.created",
      messageId: "m-stopped",
      message: {
        id: "m-stopped",
        channelId: ENG_ID,
        threadId: null,
        author: { type: "agent", id: ADA_ID },
        body: "Começando a análise\n\n_Stopped by Walter._",
        mentionedAgentIds: [],
        agentRunId: "r-live",
        meta: { canceled: { byUserId: "u-walter", text: "Começando a análise" } },
        createdAt: new Date(Date.now() + 10_000).toISOString(),
      },
    });
    await settle(3);
    const stopped = screen()
      .getAllByRole("article")
      .find((a) => a.textContent?.includes("Começando a análise")) as HTMLElement;
    expect(stopped.textContent).toContain("Você parou a Ada");
    expect(within(stopped).getByRole("button", { name: "Continuar" })).toBeTruthy();
    expect(stopped.querySelector('.ac-avatar[data-state="idle"]')).not.toBeNull();
  });

  test("a reply too big to ride its event shows once its copy read over HTTP lands, whole", async () => {
    const { state, api, ev } = await open();
    await ev({ type: "agent.run", ...ids, status: "running" });
    await ev({ type: "agent.typing", ...ids });
    await settle(2);
    const body = `Resposta longa sobre o Azure. ${"Mais detalhes. ".repeat(400)}`;
    state.messages.push({
      id: "m-big",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: ADA_ID },
      body,
      mentionedAgentIds: [],
      mentionedUserIds: [],
      agentRunId: "r-live",
      meta: {},
      clientId: null,
      createdAt: new Date().toISOString(),
    } as Message);
    // The conversation's read is slow to come back.
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = api.chat.messages;
    api.chat.messages = async (...args) => {
      await gate;
      return read(...args);
    };
    // Past the pub/sub's size, the server sends the message's id without the message.
    await ev({ type: "message.created", messageId: "m-big", agentRunId: "r-live", threadId: null });
    await ev({ type: "agent.run", ...ids, status: "done" });
    await ev({ type: "agent.idle", ...ids });
    await ev({ type: "run.finished", ...ids, status: "done" });
    await settle(3);
    // Nothing of it before its copy is read: no part of it shows, then changes.
    expect(document.body.textContent).not.toContain("Resposta longa sobre o Azure");
    await act(async () => release());
    await settle(5);
    const answers = screen()
      .getAllByRole("article")
      .filter((a) => a.textContent?.includes("Resposta longa sobre o Azure"));
    expect(answers).toHaveLength(1);
    expect(answers[0]?.textContent).toContain("Mais detalhes.");
    expect(document.querySelector(".ac-msg--streaming")).toBeNull();
  });

  test("back to the tab after a while, the conversation is read again: an answer whose end never came lands", async () => {
    const { state, ev } = await open();
    await ev({ type: "agent.run", ...ids, status: "running" });
    await ev({ type: "agent.typing", ...ids });
    await settle(2);
    // While the tab was away, the run ended and its events never reached this page (the socket still looks open).
    state.activeRuns = { [ENG_ID]: [] };
    state.messages.push({
      id: "m-done",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: ADA_ID },
      body: "Começando a resposta, e aqui está o fim dela.",
      mentionedAgentIds: [],
      mentionedUserIds: [],
      agentRunId: "r-live",
      meta: {},
      clientId: null,
      createdAt: new Date().toISOString(),
    } as Message);
    const visibility = (value: "hidden" | "visible") =>
      act(async () => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value });
        document.dispatchEvent(new Event("visibilitychange"));
      });
    try {
      await visibility("hidden");
      setSystemTime(new Date(Date.now() + 60_000));
      await visibility("visible");
      await settle(5);
      expect(document.querySelector(".ac-msg--streaming")).toBeNull();
      expect(document.body.textContent).toContain("e aqui está o fim dela.");
    } finally {
      setSystemTime();
      Reflect.deleteProperty(document, "visibilityState");
    }
  });

  test("Esc with an empty composer stops the latest run I may stop, right away", async () => {
    const { state, ev } = await open();
    await ev({ type: "agent.run", ...ids, status: "running" });
    await settle(2);
    await act(async () => fireEvent.keyDown(window, { key: "Escape" }));
    await settle(2);
    expect(screen().queryByRole("dialog")).toBeNull();
    expect(state.calls.find((c) => c.method === "agents.cancelRun")?.args).toEqual([ORG_ID, "r-live"]);
  });
});

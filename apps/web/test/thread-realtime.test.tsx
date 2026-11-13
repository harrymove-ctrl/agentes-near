import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { type ActiveRun, type Message, UNREAD_REFRESH_MS } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createStreamsStore } from "@/realtime/context";
import { ADA_ID, createFakeApi, ENG_ID, GENERAL_ID, ORG_ID, seedDm, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

type Surface = "panel" | "page";

const reply = (id: string, body: string, over: Partial<Message> = {}): Message => ({
  id,
  channelId: ENG_ID,
  threadId: "m-1",
  author: { type: "person", id: "u-joao" },
  body,
  mentionedAgentIds: [],
  agentRunId: null,
  createdAt: new Date().toISOString(),
  ...over,
});

const row = (id: string) => document.querySelector(`article[data-message-id="${id}"]`) as HTMLElement;

async function openChannel(state: ReturnType<typeof seedState>, api = createFakeApi(state)) {
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
  await settle(5);
  const socket = r.sockets.last();
  await act(async () => socket.open());
  await act(async () => socket.push({ type: "subscribed", channelId: ENG_ID }));
  await settle(3);
  return { ...r, socket };
}

async function openPanel(rootId = "m-1") {
  await act(async () => fireEvent.mouseEnter(row(rootId)));
  await act(async () =>
    fireEvent.click(within(within(row(rootId)).getByRole("toolbar")).getByRole("button", { name: "Responder" })),
  );
  await settle(8);
  return screen().getByRole("complementary", { name: "Thread" });
}

async function open(surface: Surface, state: ReturnType<typeof seedState>) {
  if (surface === "panel") {
    const r = await openChannel(state);
    return { ...r, view: await openPanel() };
  }
  const r = await renderApp(`/org/${ORG_ID}/threads/m-1`, { api: createFakeApi(state) });
  await settle(8);
  const socket = r.sockets.last();
  await act(async () => socket.open());
  await act(async () => socket.push({ type: "subscribed", channelId: ENG_ID }));
  await settle(3);
  return { ...r, socket, view: document.body };
}

type Pushes = { push: (frame: unknown) => void };
const event = (socket: Pushes, e: Record<string, unknown>) =>
  act(async () => socket.push({ type: "event", channelId: ENG_ID, event: { channelId: ENG_ID, ...e } }));
const created = (socket: Pushes, m: Message) => event(socket, { type: "message.created", messageId: m.id, message: m });
const inView = (view: HTMLElement, text: string) =>
  [...view.querySelectorAll("article")].filter((a) => a.textContent?.includes(text));

describe.each(["panel", "page"] as const)("%s", (surface) => {
  test("a person's reply", async () => {
    const state = seedState();
    const { socket, view } = await open(surface, state);
    const m = reply("r-1", "resposta da pessoa");
    state.messages.push(m);
    await created(socket, m);
    await settle(3);
    expect(inView(view, "resposta da pessoa")).toHaveLength(1);
  });

  test("a reply from my other device", async () => {
    const state = seedState();
    const { socket, view } = await open(surface, state);
    const m = reply("r-1", "do meu celular", {
      author: { type: "person", id: state.me?.user.id ?? null },
      clientId: "other-device",
    });
    state.messages.push(m);
    await created(socket, m);
    await settle(3);
    expect(inView(view, "do meu celular")).toHaveLength(1);
  });

  test("an agent's reply", async () => {
    const state = seedState();
    const { socket, view } = await open(surface, state);
    const m = reply("r-1", "resposta da Ada", { author: { type: "agent", id: ADA_ID }, agentRunId: "run-a" });
    state.messages.push(m);
    await created(socket, m);
    await settle(3);
    expect(inView(view, "resposta da Ada")).toHaveLength(1);
  });

  test("a live run: thinking, its tool once, its output once, writing with no words, then its saved message in one row", async () => {
    const state = seedState();
    const { socket, view } = await open(surface, state);
    const run = { runId: "run-a", agentId: ADA_ID, threadId: "m-1" };
    await event(socket, { type: "agent.thinking", ...run });
    await settle(2);
    expect(view.textContent).toContain("Ada");
    await event(socket, {
      type: "agent.tool",
      ...run,
      tool: "run_code",
      toolUseId: "t1",
      code: { language: "bash", source: "echo oi" },
    });
    await event(socket, { type: "agent.tool.output", ...run, toolUseId: "t1", stream: "stdout", text: "saida\n" });
    await settle(2);
    await act(async () => fireEvent.click(within(view).getByRole("button", { name: "Ver código da Ada" })));
    const live = view.querySelector(".live-code") as HTMLElement;
    expect(within(live).getByLabelText("Saída").querySelector(".live-code__stdout")?.textContent).toBe("saida\n");
    await event(socket, { type: "agent.tool", ...run, tool: null, toolUseId: "t1" });
    await event(socket, { type: "agent.typing", ...run });
    await event(socket, { type: "agent.delta", ...run, seq: 0, text: "escrevendo a resposta" });
    await settle(2);
    // It writes: the bar says so, its words wait for its message.
    expect(view.textContent).not.toContain("escrevendo a resposta");
    const m = reply("r-1", "escrevendo a resposta final", {
      author: { type: "agent", id: ADA_ID },
      agentRunId: "run-a",
    });
    state.messages.push(m);
    await created(socket, m);
    await event(socket, { type: "run.finished", ...run, status: "done" });
    await settle(3);
    expect(inView(view, "escrevendo a resposta final")).toHaveLength(1);
  });

  test("a message too big for its event", async () => {
    const state = seedState();
    const { socket, view } = await open(surface, state);
    const m = reply("r-1", "resposta grande", { author: { type: "agent", id: ADA_ID }, agentRunId: "run-a" });
    state.messages.push(m);
    await event(socket, { type: "message.created", messageId: m.id, threadId: "m-1", agentRunId: "run-a" });
    await settle(5);
    expect(inView(view, "resposta grande")).toHaveLength(1);
  });

  test("a reaction on a reply", async () => {
    const state = seedState();
    const m = reply("r-1", "para reagir");
    state.messages.push(m);
    const { socket } = await open(surface, state);
    await event(socket, {
      type: "message.reactions",
      messageId: "r-1",
      reactions: [{ reaction: "🚀", count: 1, userIds: ["u-joao"] }],
    });
    await settle(3);
    const pills = within(row("r-1")).getByRole("group", { name: "Reações" });
    expect(within(pills).getByRole("button", { name: "João reagiu com 🚀" })).toBeTruthy();
  });

  test("a reconnect: what came meanwhile shows", async () => {
    const state = seedState();
    const { socket, sockets, view } = await open(surface, state);
    await act(async () => socket.drop());
    state.messages.push(reply("r-1", "enquanto caiu"));
    await act(() => new Promise((r) => setTimeout(r, 650)));
    const next = sockets.last();
    await act(async () => next.open());
    await act(async () => next.push({ type: "subscribed", channelId: ENG_ID }));
    await settle(5);
    expect(inView(view, "enquanto caiu")).toHaveLength(1);
  });

  test("a reconnect: the header counts what came meanwhile", async () => {
    const state = seedState();
    const { socket, sockets, view } = await open(surface, state);
    await act(async () => socket.drop());
    state.messages.push(reply("r-1", "enquanto caiu"));
    await act(() => new Promise((r) => setTimeout(r, 650)));
    const next = sockets.last();
    await act(async () => next.open());
    await act(async () => next.push({ type: "subscribed", channelId: ENG_ID }));
    await settle(5);
    expect(view.querySelector(".thread-head__meta")?.textContent).toContain("1 resposta");
  });

  test("a tab hidden a while: what came meanwhile shows", async () => {
    const state = seedState();
    const { view } = await open(surface, state);
    const visibility = (value: "hidden" | "visible") =>
      act(async () => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value });
        document.dispatchEvent(new Event("visibilitychange"));
      });
    try {
      await visibility("hidden");
      state.messages.push(reply("r-1", "enquanto escondida"));
      setSystemTime(new Date(Date.now() + 60_000));
      await visibility("visible");
      await settle(5);
      expect(inView(view, "enquanto escondida")).toHaveLength(1);
      expect(view.querySelector(".thread-head__meta")?.textContent).toContain("1 resposta");
    } finally {
      setSystemTime();
      Reflect.deleteProperty(document, "visibilityState");
    }
  });

  test("the header's count follows the replies", async () => {
    const state = seedState();
    const { socket, view } = await open(surface, state);
    const m = reply("r-1", "a primeira");
    state.messages.push(m);
    await created(socket, m);
    await settle(5);
    expect(view.querySelector(".thread-head__meta")?.textContent).toContain("1 resposta");
  });

  test("@ada in a thread: her row at once, there and not beside it, one row once the server says", async () => {
    const state = seedState();
    const { socket, view } = await open(surface, state);
    const box = within(view).getByRole("combobox", { name: /Responder na thread/ });
    await act(async () => fireEvent.change(box, { target: { value: "@ada olha aqui" } }));
    await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
    await settle(3);
    const bars = () => [...document.querySelectorAll(".ac-typing__text")].map((b) => b.textContent).filter(Boolean);
    expect(view.querySelector(".ac-typing__text")?.textContent).toBe("Ada pensando…");
    expect(bars()).toEqual(["Ada pensando…"]);
    await event(socket, { type: "agent.thinking", runId: "run-a", agentId: ADA_ID, threadId: "m-1" });
    await settle(3);
    expect(bars()).toEqual(["Ada pensando…"]);
  });

  test("a receipt on a reply follows the router", async () => {
    const state = seedState();
    const m = reply("r-1", "minha resposta", { author: { type: "person", id: state.me?.user.id ?? null } });
    state.messages.push(m);
    const { socket } = await open(surface, state);
    await event(socket, { type: "message.routed", messageId: "r-1", seenBy: [ADA_ID], pickedBy: [] });
    await settle(3);
    expect(row("r-1").querySelector(".ac-receipt__check")).toBeTruthy();
  });
});

test("a run already live when the panel opens: the panel's bar says it works, and none of its words", async () => {
  const state = seedState();
  const api = createFakeApi(state);
  const run = { runId: "run-a", agentId: ADA_ID, threadId: "m-1" };
  api.agents.activeRuns = async () => [{ ...run, channelId: ENG_ID, status: "running" } as ActiveRun];
  const { socket } = await openChannel(state, api);
  await event(socket, { type: "agent.thinking", ...run });
  await event(socket, { type: "agent.typing", ...run });
  await event(socket, { type: "agent.delta", ...run, seq: 0, text: "ja escrevendo" });
  await settle(2);
  const side = await openPanel();
  expect(side.textContent).not.toContain("ja escrevendo");
  expect(side.querySelector('.ac-typing[data-active="true"]')?.textContent).toContain("Ada");
});

test("the panel closed while a run works: reopened, its message once, whole", async () => {
  const state = seedState();
  const api = createFakeApi(state);
  const run = { runId: "run-a", agentId: ADA_ID, threadId: "m-1" };
  api.agents.activeRuns = async () => [{ ...run, channelId: ENG_ID, status: "running" } as ActiveRun];
  const { socket } = await openChannel(state, api);
  const side = await openPanel();
  await event(socket, { type: "agent.thinking", ...run });
  await event(socket, { type: "agent.typing", ...run });
  await settle(2);
  await act(async () => fireEvent.click(within(side).getByRole("button", { name: "Fechar a thread" })));
  await settle(3);
  const open1 = await openPanel();
  expect(open1.querySelector('.ac-typing[data-active="true"]')?.textContent).toContain("Ada");
  await act(async () => fireEvent.click(within(open1).getByRole("button", { name: "Fechar a thread" })));
  await settle(3);
  const m = reply("r-1", "antes de fechar depois de fechar, salvo", {
    author: { type: "agent", id: ADA_ID },
    agentRunId: "run-a",
  });
  state.messages.push(m);
  api.agents.activeRuns = async () => [];
  await created(socket, m);
  await event(socket, { type: "run.finished", ...run, status: "done" });
  await settle(3);
  const open2 = await openPanel();
  expect(inView(open2, "salvo")).toHaveLength(1);
  expect(open2.textContent?.split("depois de fechar")).toHaveLength(2);
});

test("a reply heard during the panel's first read: root, earlier replies and it, each once", async () => {
  const state = seedState();
  state.messages.push(reply("r-old", "resposta antiga"));
  const api = createFakeApi(state);
  const read = api.chat.messages;
  let answer = () => {};
  const held = new Promise<void>((resolve) => {
    answer = resolve;
  });
  api.chat.messages = async (o, c, opts) => {
    const list = await read(o, c, opts);
    if (opts?.threadId) await held;
    return list;
  };
  const { socket } = await openChannel(state, api);
  await act(async () => fireEvent.mouseEnter(row("m-1")));
  await act(async () =>
    fireEvent.click(within(within(row("m-1")).getByRole("toolbar")).getByRole("button", { name: "Responder" })),
  );
  await settle(3);
  const m = reply("r-new", "resposta nova");
  state.messages.push(m);
  await created(socket, m);
  await settle(2);
  await act(async () => answer());
  await settle(5);
  const side = screen().getByRole("complementary", { name: "Thread" });
  expect([...side.querySelectorAll("article")].map((a) => a.getAttribute("data-message-id"))).toEqual([
    "m-1",
    "r-old",
    "r-new",
  ]);
});

describe("what a channel opening and a catch-up read", () => {
  const counted = (state: ReturnType<typeof seedState>) => {
    const api = createFakeApi(state);
    const list = api.threads.inChannel;
    const reads = { n: 0 };
    api.threads.inChannel = async (...args) => {
      reads.n++;
      return list(...args);
    };
    return { api, reads };
  };

  test("the server confirming the channel reads no thread list again", async () => {
    const state = seedState();
    const { api, reads } = counted(state);
    const { socket } = await openChannel(state, api);
    const before = reads.n;
    await act(async () => socket.push({ type: "subscribed", channelId: ENG_ID }));
    await settle(5);
    expect(reads.n).toBe(before);
  });

  test("a top-level message too big for its event reads no thread list again", async () => {
    const state = seedState();
    const { api, reads } = counted(state);
    const { socket } = await openChannel(state, api);
    const before = reads.n;
    const m = reply("m-big", "mensagem grande", { threadId: null });
    state.messages.push(m);
    await event(socket, { type: "message.created", messageId: m.id, threadId: null, agentRunId: null });
    await settle(5);
    expect(inView(document.body, "mensagem grande")).toHaveLength(1);
    expect(reads.n).toBe(before);
  });

  test("a reconnect with no thread open: the channel's thread lines read again", async () => {
    const state = seedState();
    const { api, reads } = counted(state);
    const { socket, sockets } = await openChannel(state, api);
    const before = reads.n;
    await act(async () => socket.drop());
    await act(() => new Promise((r) => setTimeout(r, 650)));
    await act(async () => sockets.last().open());
    await settle(5);
    expect(reads.n).toBeGreaterThan(before);
  });
});

describe("a thread opened after the live events began its list", () => {
  const withEarlier = () => {
    const state = seedState();
    state.messages.push(reply("r-old-1", "resposta antiga um"), reply("r-old-2", "resposta antiga dois"));
    return state;
  };

  test("a reply heard before opening: the earlier ones show too", async () => {
    const state = withEarlier();
    const { socket } = await openChannel(state);
    const m = reply("r-new", "resposta nova");
    state.messages.push(m);
    await created(socket, m);
    await settle(3);
    const side = await openPanel();
    await settle(5);
    expect(inView(side, "resposta nova")).toHaveLength(1);
    expect(inView(side, "resposta antiga um")).toHaveLength(1);
    expect(inView(side, "resposta antiga dois")).toHaveLength(1);
  });

  test("replies said while away from the channel: the hole before the one heard live fills", async () => {
    const state = seedState();
    const { socket, router } = await openChannel(state);
    const go = (channelId: string) =>
      act(() => router.navigate({ to: "/org/$orgId/c/$channelId", params: { orgId: ORG_ID, channelId } }));
    const side = await openPanel();
    expect(side).toBeTruthy();
    await act(async () => fireEvent.click(within(side).getByRole("button", { name: "Fechar a thread" })));
    await settle(3);
    await go(GENERAL_ID);
    await settle(4);
    state.messages.push(reply("r-away", "enquanto fora do canal"));
    await go(ENG_ID);
    await settle(4);
    const m = reply("r-new", "resposta nova");
    state.messages.push(m);
    await created(socket, m);
    await settle(3);
    const again = await openPanel();
    await settle(5);
    expect(inView(again, "resposta nova")).toHaveLength(1);
    expect(inView(again, "enquanto fora do canal")).toHaveLength(1);
  });
});

describe("other conversations shown as a thread", () => {
  test("a thread whose root the channel's list doesn't hold: live replies land", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const read = api.chat.messages;
    api.chat.messages = async (o, c, opts) => (await read(o, c, opts)).filter((m) => opts?.threadId || m.id !== "m-1");
    const old = reply("r-old", "fixada na thread", { author: { type: "agent", id: ADA_ID } });
    state.messages.push(old);
    api.pins = {
      list: async () => [
        {
          messageId: old.id,
          channelId: ENG_ID,
          threadId: "m-1",
          pinnedByUserId: "u-joao",
          pinnedAt: old.createdAt,
          message: old,
        },
      ],
      pin: async () => ({}) as never,
      unpin: async () => {},
    };
    const { socket } = await openChannel(state, api);
    await act(async () => fireEvent.click(screen().getByRole("button", { name: /^Mensagens fixadas \(/ })));
    await settle(2);
    const list = screen().getByRole("dialog", { name: "Mensagens fixadas em #eng" });
    await act(async () => fireEvent.click(list.querySelector(".thread-pop__row") as HTMLElement));
    await settle(8);
    const side = screen().getByRole("complementary", { name: "Thread" });
    const m = reply("r-1", "ao vivo");
    state.messages.push(m);
    await created(socket, m);
    await settle(3);
    expect(inView(side, "ao vivo")).toHaveLength(1);
    expect(inView(side, "fixada na thread")).toHaveLength(1);
  });

  test("a DM's thread: a live reply lands", async () => {
    const state = seedState();
    seedDm(state, { type: "agent", id: ADA_ID });
    const channelId = `dm-${ADA_ID}`;
    const rootId = `m-${channelId}`;
    const r = await renderApp(`/org/${ORG_ID}/threads/${rootId}`, { api: createFakeApi(state) });
    await settle(8);
    const socket = r.sockets.last();
    await act(async () => socket.open());
    await act(async () => socket.push({ type: "subscribed", channelId }));
    await settle(3);
    const m = reply("r-1", "no dm", { channelId, threadId: rootId, author: { type: "agent", id: ADA_ID } });
    state.messages.push(m);
    await act(async () =>
      socket.push({
        type: "event",
        channelId,
        event: { channelId, type: "message.created", messageId: m.id, message: m },
      }),
    );
    await settle(3);
    expect(inView(document.body, "no dm")).toHaveLength(1);
  });

  test("a DM's thread in the panel: a live reply lands", async () => {
    const state = seedState();
    seedDm(state, { type: "agent", id: ADA_ID });
    const channelId = `dm-${ADA_ID}`;
    const rootId = `m-${channelId}`;
    const r = await renderApp(`/org/${ORG_ID}/dm/agent/${ADA_ID}`, { api: createFakeApi(state) });
    await settle(8);
    const socket = r.sockets.last();
    await act(async () => socket.open());
    await act(async () => socket.push({ type: "subscribed", channelId }));
    await settle(3);
    const side = await openPanel(rootId);
    const m = reply("r-1", "no dm", { channelId, threadId: rootId, author: { type: "agent", id: ADA_ID } });
    state.messages.push(m);
    await act(async () =>
      socket.push({
        type: "event",
        channelId,
        event: { channelId, type: "message.created", messageId: m.id, message: m },
      }),
    );
    await settle(3);
    expect(inView(side, "no dm")).toHaveLength(1);
  });

  test("a task's conversation: a live reply lands, its header and the task's line count it", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    const at = await api.issues.conversation(ORG_ID, (await api.issues.get(ORG_ID, 131)).id);
    let said = 0;
    const list = api.issues.list;
    api.issues.list = async (o, f) =>
      (await list(o, f)).map((i) => (i.conversation ? { ...i, conversation: { ...i.conversation, count: said } } : i));
    const r = await renderApp(`/org/${ORG_ID}/issues?open=131`, { api });
    await settle(8);
    const socket = r.sockets.last();
    await act(async () => socket.open());
    await settle(4);
    const dialog = screen().getByRole("dialog", { name: "Confirmação do agendamento por WhatsApp" });
    // Conversa is in the bar's ⋯, beside the ×.
    const more = within(dialog).getByRole("button", { name: "Mais opções" });
    more.focus();
    await act(async () => fireEvent.keyDown(more, { key: "Enter" }));
    await settle(2);
    await act(async () =>
      fireEvent.click(within(screen().getByRole("menu")).getByRole("menuitem", { name: "Conversa" })),
    );
    await settle(8);
    await act(async () => socket.push({ type: "subscribed", channelId: at.channelId }));
    await settle(3);
    const m = reply("r-1", "na tarefa", {
      channelId: at.channelId,
      threadId: at.rootId,
      author: { type: "agent", id: ADA_ID },
    });
    state.messages.push(m);
    said = 1;
    await act(async () =>
      socket.push({
        type: "event",
        channelId: at.channelId,
        event: { channelId: at.channelId, type: "message.created", messageId: m.id, message: m },
      }),
    );
    await settle(5);
    expect(inView(dialog, "na tarefa")).toHaveLength(1);
    expect(dialog.querySelector(".thread-head__meta")?.textContent).toContain("1 mensagem");
    expect(dialog.querySelector(".task-talk__summary")?.textContent).toContain("1 mensagem");
  });

  test("a board: a reply in a task's conversation moves its card's count, the conversation closed", async () => {
    const api = createFakeApi(seedState());
    const conversation = {
      channelId: "tc",
      rootId: "root_r",
      count: 3,
      lastAt: new Date().toISOString(),
      participants: [{ type: "person" as const, id: "u-joao" }],
      working: false,
    };
    const list = api.issues.list;
    api.issues.list = async (orgId, filters) =>
      (await list(orgId, filters)).map((i) => (i.number === 131 ? { ...i, conversation: { ...conversation } } : i));
    const r = await renderApp(`/org/${ORG_ID}/issues`, { api });
    await settle(8);
    const socket = r.sockets.last();
    await act(async () => socket.open());
    await settle(4);
    const talking = () =>
      document.querySelector('[data-card="131"] .ac-factline__fact[title$="mensagens"]')?.textContent;
    expect(talking()).toBe("3");
    conversation.count = 4;
    await act(async () => socket.push({ type: "event", scope: "org", event: { type: "issue.updated" } }));
    await act(() => new Promise((done) => setTimeout(done, UNREAD_REFRESH_MS + 100)));
    await settle(5);
    expect(talking()).toBe("4");
  });

  test("a mission's thread: a live reply lands", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    await api.missions.create(ORG_ID, { agentId: ADA_ID, goal: "Construir o app", channelId: ENG_ID, threadId: "m-1" });
    const r = await renderApp(`/org/${ORG_ID}/threads/m-1`, { api });
    await settle(8);
    const socket = r.sockets.last();
    await act(async () => socket.open());
    await act(async () => socket.push({ type: "subscribed", channelId: ENG_ID }));
    await settle(3);
    const m = reply("r-1", "na missao", { author: { type: "agent", id: ADA_ID } });
    state.messages.push(m);
    await created(socket, m);
    await settle(3);
    expect(inView(document.body, "na missao")).toHaveLength(1);
  });
});

describe("a guessed row for a reply in a thread", () => {
  const guessed = () => {
    const store = createStreamsStore();
    store.expect("c", "local-1", ["ada"], "root");
    store.retarget("local-1", "m-1");
    return store;
  };
  const ids = (store: ReturnType<typeof guessed>) => Object.keys(store.get().streams.runs);

  test("the router not picking its agent drops it", () => {
    const store = guessed();
    expect(ids(store)).toEqual(["pending:ada:root"]);
    store.apply({ type: "message.routed", channelId: "c", messageId: "m-1", pickedBy: [], seenBy: [] } as never);
    expect(ids(store)).toEqual([]);
  });

  test("an agent that won't answer me drops it", () => {
    const store = guessed();
    store.unavailable({
      type: "agent.unavailable",
      agentId: "ada",
      channelId: "c",
      threadId: "root",
      messageId: "m-1",
      text: "",
    });
    expect(ids(store)).toEqual([]);
  });

  test("never confirmed: it goes with its message's receipt", () => {
    const store = guessed();
    expect(store.get().receipts["m-1"]).toBeTruthy();
    expect(store.sweep(Date.now() + 60_000)).toEqual(["c"]);
    expect(ids(store)).toEqual([]);
    expect(store.get().receipts["m-1"]).toBeUndefined();
  });

  test("the real run says which message started it", () => {
    const store = guessed();
    store.apply({ type: "agent.thinking", channelId: "c", runId: "run-a", agentId: "ada", threadId: "root" } as never);
    expect(ids(store)).toEqual(["run-a"]);
    expect(store.get().streams.runs["run-a"]?.triggerMessageId).toBe("m-1");
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Message } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, NOW, ORG_ID, seedDm, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const esc = (el: Element) => act(async () => fireEvent.keyDown(el, { key: "Escape" }));

const inThread = (id: string, body: string, minutes: number, author: Message["author"], meta = {}) =>
  ({
    id,
    channelId: ENG_ID,
    threadId: "m-1",
    author,
    body,
    mentionedAgentIds: [],
    agentRunId: null,
    createdAt: new Date(NOW.getTime() - minutes * 60_000).toISOString(),
    meta,
  }) as Message;

/** A thread under João's message: Ada answered, and João wrote after her. */
const seeded = (extra: Message[] = []) => {
  const state = seedState();
  state.messages.push(
    inThread("t-1", "o token expira em 15 minutos", 30, { type: "agent", id: ADA_ID }),
    inThread("t-2", "e o refresh?", 29, { type: "person", id: "u-joao" }),
    ...extra,
  );
  return state;
};
const URL_OF = (search = "") => `/org/${ORG_ID}/c/${ENG_ID}${search}`;
const panel = () => screen().getByRole("complementary", { name: "Thread" });
const row = (id: string) => panel().querySelector(`[data-message-id="${id}"]`) as HTMLElement;
const box = () => within(panel()).getByRole("combobox", { name: "Responder na thread" }) as HTMLTextAreaElement;
const replyTo = async (id: string) => {
  await click(within(row(id)).getByRole("button", { name: "Responder" }));
  await settle(2);
};
const searchOf = (r: { router: { state: { location: { search: unknown } } } }) =>
  r.router.state.location.search as Record<string, unknown>;

describe("the thread in the URL", () => {
  test("opening adds it, closing removes it, and Back and Forward keep it", async () => {
    const r = await renderApp(URL_OF(), { api: createFakeApi(seeded()) });
    await settle(8);
    const bar = screen().getByRole("toolbar", { name: "Ações da mensagem de João" });
    await click(within(bar).getByRole("button", { name: "Responder" }));
    await settle(6);
    expect(searchOf(r)).toMatchObject({ thread: "m-1", reply: true });
    await click(within(panel()).getByRole("button", { name: "Fechar a thread" }));
    await settle(6);
    expect(searchOf(r).thread).toBeUndefined();
    expect(screen().queryByRole("complementary", { name: "Thread" })).toBeNull();
    await act(async () => r.router.history.back());
    await settle(6);
    expect(panel()).toBeTruthy();
    await act(async () => r.router.history.forward());
    await settle(6);
    expect(screen().queryByRole("complementary", { name: "Thread" })).toBeNull();
  });

  test("a reload or a shared link opens it, at its message", async () => {
    await renderApp(URL_OF("?thread=m-1&tm=t-2"), { api: createFakeApi(seeded()) });
    await settle(10);
    expect(panel().textContent).toContain("e o refresh?");
    expect(row("t-2").className).toContain("ac-msg--focus");
  });

  test("a thread that isn't there closes calmly and leaves no way back to it", async () => {
    const r = await renderApp(URL_OF("?thread=gone"), { api: createFakeApi(seeded()) });
    await settle(10);
    expect(screen().queryByRole("complementary", { name: "Thread" })).toBeNull();
    expect(searchOf(r).thread).toBeUndefined();
    expect(document.body.textContent).toContain("Thread não encontrada");
    expect(r.router.history.length).toBe(1);
  });

  test("Back to a thread takes the panel from what replaced it: one panel at a time", async () => {
    const state = seeded();
    const r = await renderApp(URL_OF("?thread=m-1"), { api: createFakeApi(state) });
    await settle(10);
    const search = within(document.querySelector(".channel__header") as HTMLElement).getByRole("combobox", {
      name: "Buscar",
    });
    await act(async () => fireEvent.change(search, { target: { value: "token" } }));
    await act(() => new Promise((done) => setTimeout(done, 300)));
    await act(async () => fireEvent.keyDown(search, { key: "Enter" }));
    await act(() => new Promise((done) => setTimeout(done, 300)));
    await settle(6);
    const results = () => screen().queryByRole("complementary", { name: "Resultados da busca" });
    expect(results()).toBeTruthy();
    expect(searchOf(r).thread).toBeUndefined();
    await act(async () => r.router.history.back());
    await settle(8);
    expect(panel()).toBeTruthy();
    expect(results()).toBeNull();
  });

  test("a DM's link by its channel keeps the thread on the way to the DM's page", async () => {
    const state = seedState();
    const dm = seedDm(state, { type: "agent", id: ADA_ID });
    const r = await renderApp(`/org/${ORG_ID}/c/${dm}?thread=m-${dm}&tm=m-${dm}`, { api: createFakeApi(state) });
    await settle(12);
    expect(r.router.state.location.pathname).toBe(`/org/${ORG_ID}/dm/agent/${ADA_ID}`);
    expect(searchOf(r)).toMatchObject({ thread: `m-${dm}`, tm: `m-${dm}` });
    expect(panel()).toBeTruthy();
  });

  test("the conversation's thread view doesn't take the page's `?thread=` for a panel of its own", async () => {
    await renderApp(URL_OF("?thread=m-1"), { api: createFakeApi(seeded()) });
    await settle(10);
    expect(screen().getAllByRole("complementary", { name: "Thread" })).toHaveLength(1);
  });
});

describe("Responder inside a thread", () => {
  const open = async (state = seeded()) => {
    const r = await renderApp(URL_OF("?thread=m-1"), { api: createFakeApi(state) });
    await settle(10);
    return { ...r, state };
  };

  test("the bar names who, and the message goes out with the original", async () => {
    const { state } = await open();
    await replyTo("t-1");
    expect(panel().querySelector(".composer-quote")?.textContent).toContain("Respondendo a Ada");
    expect(document.activeElement).toBe(box());
    await act(async () => fireEvent.change(box(), { target: { value: "quanto tempo?" } }));
    await click(within(panel()).getByRole("button", { name: "Enviar" }));
    await settle(8);
    expect(state.calls.find((c) => c.method === "chat.post")?.args[2]).toMatchObject({
      body: "quanto tempo?",
      threadId: "m-1",
      replyTo: "t-1",
    });
    expect(panel().querySelector(".composer-quote")).toBeNull();
    const quote = within(panel()).getByRole("button", { name: /Resposta a Ada: o token expira/ });
    expect(quote.textContent).toContain("@Ada");
    expect(quote.querySelector(".ac-avatar")).toBeTruthy();
  });

  test("Esc drops the reply, not the thread, whatever is in the box; the next Esc closes the thread", async () => {
    await open();
    await replyTo("t-1");
    await act(async () => fireEvent.change(box(), { target: { value: "rascunho" } }));
    await esc(box());
    await settle(2);
    expect(panel().querySelector(".composer-quote")).toBeNull();
    expect(box().value).toBe("rascunho");
    await act(async () => fireEvent.change(box(), { target: { value: "" } }));
    await esc(box());
    await settle(6);
    expect(screen().queryByRole("complementary", { name: "Thread" })).toBeNull();
  });

  test("× drops it and the next message is a plain one", async () => {
    const { state } = await open();
    await replyTo("t-2");
    await click(within(panel()).getByRole("button", { name: "Cancelar resposta" }));
    expect(panel().querySelector(".composer-quote")).toBeNull();
    await act(async () => fireEvent.change(box(), { target: { value: "ok" } }));
    await click(within(panel()).getByRole("button", { name: "Enviar" }));
    await settle(8);
    expect(state.calls.find((c) => c.method === "chat.post")?.args[2]).not.toHaveProperty("replyTo");
  });

  test("the quote line jumps to the original and lights it", async () => {
    const quoted = {
      replyTo: {
        messageId: "t-1",
        threadId: "m-1",
        author: { type: "agent", id: ADA_ID },
        authorName: "Ada",
        excerpt: "o token expira em 15 minutos",
      },
    };
    await open(seeded([inThread("t-3", "quanto tempo?", 20, { type: "person", id: "u-walter" }, quoted)]));
    expect(row("t-1").className).not.toContain("ac-msg--focus");
    await click(within(row("t-3")).getByRole("button", { name: /Resposta a Ada/ }));
    expect(row("t-1").className).toContain("ac-msg--focus");
  });

  test("an original this view can't reach says so, and the person stays where they were", async () => {
    const far = {
      replyTo: {
        messageId: "t-far",
        threadId: "m-1",
        author: { type: "agent", id: ADA_ID },
        authorName: "Ada",
        excerpt: "lá atrás",
      },
    };
    await open(seeded([inThread("t-3", "sobre aquilo", 20, { type: "person", id: "u-walter" }, far)]));
    const scroller = panel().querySelector(".channel__messages") as HTMLElement;
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 900 });
    scroller.scrollTop = 40;
    await click(within(row("t-3")).getByRole("button", { name: /Resposta a Ada/ }));
    await settle(6);
    expect(document.body.textContent).toContain("Essa mensagem está longe demais para abrir daqui.");
    expect(scroller.scrollTop).toBe(40);
  });

  test("in the channel, a quote of a thread's reply opens that thread at it", async () => {
    const state = seeded([
      {
        ...inThread(
          "c-1",
          "sobre o token",
          20,
          { type: "person", id: "u-walter" },
          {
            replyTo: {
              messageId: "t-1",
              threadId: "m-1",
              author: { type: "agent", id: ADA_ID },
              authorName: "Ada",
              excerpt: "o token expira em 15 minutos",
            },
          },
        ),
        threadId: null,
      },
    ]);
    const r = await renderApp(URL_OF(), { api: createFakeApi(state) });
    await settle(10);
    await click(screen().getByRole("button", { name: /Resposta a Ada/ }));
    await settle(8);
    expect(searchOf(r)).toMatchObject({ thread: "m-1", tm: "t-1" });
    expect(row("t-1").className).toContain("ac-msg--focus");
  });

  test("a reply never groups under the row before it: its face stands under the quote", async () => {
    const quoted = {
      replyTo: {
        messageId: "t-2",
        threadId: "m-1",
        author: { type: "person", id: "u-joao" },
        authorName: "João",
        excerpt: "e o refresh?",
      },
    };
    await open(seeded([inThread("t-3", "resposta", 28.5, { type: "person", id: "u-joao" }, quoted)]));
    expect(row("t-3").className).not.toContain("ac-msg--grouped");
  });

  test("a deleted original says so: no words, nothing to press", async () => {
    const gone = {
      replyTo: {
        messageId: "t-9",
        threadId: "m-1",
        author: { type: "person", id: null },
        authorName: "",
        excerpt: "",
        deleted: true,
      },
    };
    await open(seeded([inThread("t-3", "sobre aquilo", 20, { type: "person", id: "u-walter" }, gone)]));
    const line = row("t-3").querySelector(".msg-quote") as HTMLElement;
    expect(line.textContent).toBe("Mensagem original apagada");
    expect(line.tagName).toBe("SPAN");
  });

  test("the original gone while I wrote: the toast says it", async () => {
    const state = seeded();
    await open(state);
    await replyTo("t-1");
    state.messages = state.messages.filter((m) => m.id !== "t-1");
    await act(async () => fireEvent.change(box(), { target: { value: "ainda vale?" } }));
    await click(within(panel()).getByRole("button", { name: "Enviar" }));
    await settle(8);
    expect(document.body.textContent).toContain("A mensagem que você estava respondendo não está mais aqui.");
  });

  test("answering a mission's plan and a message are one at a time: the words go to the one on the composer", async () => {
    const state = seeded();
    const api = createFakeApi(state);
    const mission = await api.missions.create(ORG_ID, {
      agentId: ADA_ID,
      goal: "Fotos",
      title: "Fotos",
      channelId: ENG_ID,
    });
    api.missions.get = async () => ({ ...mission, status: "proposed", canAct: true });
    state.messages.push(
      inThread(
        "t-3",
        "o plano",
        25,
        { type: "agent", id: ADA_ID },
        {
          missionPlan: { missionId: mission.id, title: "Fotos", goal: "Fotos", computer: "mac", executor: "claude" },
        },
      ),
    );
    await renderApp(URL_OF("?thread=m-1"), { api });
    await settle(10);
    const pill = () => panel().querySelector(".composer-reply");
    const change = () => within(panel()).getByRole("button", { name: "Mudar algo" });
    await replyTo("t-1");
    await click(change());
    await settle(2);
    expect(panel().querySelector(".composer-quote")).toBeNull();
    expect(pill()).toBeTruthy();
    await replyTo("t-1");
    expect(panel().querySelector(".composer-quote")).toBeTruthy();
    expect(pill()).toBeNull();
  });

  test("an archived thread has no composer, so no Responder", async () => {
    const state = seeded();
    const api = createFakeApi(state);
    await state.openThread?.(ORG_ID, "m-1", NOW.toISOString());
    await api.threads.act(ORG_ID, "m-1", "archive");
    await renderApp(URL_OF("?thread=m-1"), { api });
    await settle(10);
    expect(within(row("t-1")).queryByRole("button", { name: "Responder" })).toBeNull();
  });
});

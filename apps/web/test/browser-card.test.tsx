import { afterEach, describe, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

/** noVNC as the screen drives it, connected to nothing: `emit` plays its events. */
class FakeRfb {
  static all: FakeRfb[] = [];
  viewOnly = false;
  private listeners = new Map<string, (() => void)[]>();
  constructor() {
    FakeRfb.all.push(this);
  }
  addEventListener(type: string, fn: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type: string) {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
  sendKey() {}
  clipboardPasteFrom() {}
  focus() {}
  disconnect() {}
}
mock.module("@novnc/novnc", () => ({ default: FakeRfb }));

import { BROWSER_STUCK_MS, type BrowserHandoff, type DesktopStatus, type SocketFactory } from "@agenteschat/client";
import { icons, isApple } from "@agenteschat/ui";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { useState } from "react";
import { BrowserCard, titleKind } from "@/components/browser/BrowserCard";
import { HandBackFoot } from "@/components/computer/control";
import { ADA_ID, createFakeApi, ENG_ID, fakeBrowserOf, ORG_ID, seedState } from "./fake-api";
import { fakeSockets } from "./fake-socket";
import { onScreen, renderApp, renderPage, screen, settle } from "./render";

let untouch: (() => void) | undefined;
afterEach(() => {
  cleanup();
  untouch?.();
  untouch = undefined;
});

/** A touch screen until the test ends: `(pointer: coarse)` matches. */
const onTouch = () => {
  const real = window.matchMedia.bind(window);
  const media = spyOn(window, "matchMedia").mockImplementation((query: string) =>
    query === "(pointer: coarse)"
      ? ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} } as unknown as MediaQueryList)
      : real(query),
  );
  untouch = () => media.mockRestore();
};

const HANDOFF_ID = "h-card";

/** Ada asked for help in its browser: the request card in #eng (its id is the handoff's). */
function seedRequest(expiresAt = Date.now() + 10 * 60_000) {
  const state = seedState();
  const handoff: BrowserHandoff = {
    id: HANDOFF_ID,
    agentId: ADA_ID,
    runId: "r-ask",
    machineId: "machine-1",
    kind: "ask",
    instructions: "Entrar no painel com a conta de teste",
    status: "pending",
    requestedForUserId: "u-walter",
    controllerUserId: null,
    note: null,
    expiresAt: new Date(expiresAt).toISOString(),
    createdAt: new Date().toISOString(),
    resolvedAt: null,
  };
  state.messages.push({
    id: HANDOFF_ID,
    channelId: ENG_ID,
    threadId: null,
    author: { type: "agent", id: ADA_ID },
    body: "Help needed in the browser: Entrar no painel com a conta de teste",
    mentionedAgentIds: [],
    agentRunId: "r-ask",
    createdAt: new Date().toISOString(),
    meta: { browserHandoff: handoff, bodyCode: "browser_handoff", bodyParams: { instructions: handoff.instructions } },
  } as (typeof state.messages)[number]);
  return { state, handoff };
}

/** The waiting request: a request card (a labelled group with the handoff's id). */
const waitingRequest = () => document.querySelector(`[data-ask-id="${HANDOFF_ID}"]`) as HTMLElement;

describe("a help request opens the agent's browser in its card", () => {
  // Real time passes in it (the request's own timer), so it gets more than the default 5 s.
  test("nobody opens it: at its time it stops waiting for you, even with no event", async () => {
    const expiresAt = Date.now() + 3_000;
    const { state, handoff } = seedRequest(expiresAt);
    const api = createFakeApi(state);
    fakeBrowserOf.get(api)?.handoffs.set(handoff.id, handoff);
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(6);
    expect(waitingRequest().hasAttribute("data-ask-mine")).toBe(true);
    // Nothing comes from the server: the card's own timer closes it at that moment.
    await act(() => new Promise((r) => setTimeout(r, Math.max(0, expiresAt - Date.now()) + 50)));
    await settle(2);
    expect(waitingRequest()).toBeNull();
    expect(document.querySelector(".brw-rq--settled")?.textContent).toContain("pediu ajuda · expirou");
  }, 15_000);

  test("Abrir aqui takes control in place: Pronto under the page, on touch the app's own text field, no page change", async () => {
    onTouch();
    const { state, handoff } = seedRequest();
    const api = createFakeApi(state);
    fakeBrowserOf.get(api)?.handoffs.set(handoff.id, handoff);
    const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(6);
    const request = waitingRequest();
    expect(request).toBeTruthy();
    expect(request.getAttribute("role")).toBe("group");
    expect(request.getAttribute("data-ask-kind")).toBe("browser");
    expect(request.textContent).toContain("Precisa de você no navegador");
    // Waiting for me needs no words on the card (its buttons say it).
    expect(request.textContent).not.toContain("esperando você");
    expect(request.textContent).toContain("Entrar no painel com a conta de teste");
    const openHere = within(request).getByRole("button", { name: "Abrir aqui" });
    expect(openHere.getAttribute("title")).toBe("Abre neste card, sem sair do chat.");

    await act(async () => fireEvent.click(openHere));
    await settle(4);
    expect(state.calls.some((c) => c.method === "browser.takeControl")).toBe(true);
    expect(r.router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);

    const card = document.querySelector(".brw-ac") as HTMLElement;
    expect(card.classList.contains("is-open")).toBe(true);
    expect(card.classList.contains("is-control")).toBe(true);
    // The request is the frame's title, with nothing to end it in its top; the request above says who is helping.
    const top = card.querySelector(".brw-mf__top") as HTMLElement;
    expect(top.querySelector("b")?.textContent).toBe("Entrar no painel com a conta de teste");
    expect(within(top).queryByRole("button", { name: "Pronto" })).toBeNull();
    const field = within(card).getByRole("textbox", { name: "Texto para a página" }) as HTMLInputElement;
    // Nothing marked yet: the field says where to start, the line before it only its pointer.
    expect(field.placeholder).toBe("Toque num campo da página e digite aqui");
    expect(card.querySelector(".brw-tfield__to")?.textContent).toBe("");
    // The address bar is always at the page's top, as a browser's own: nothing toggles it.
    expect(card.querySelector(".brw-go")?.nextElementSibling?.classList.contains("brw-ac__body")).toBe(true);
    expect(within(card).getByRole("textbox", { name: "Endereço do site" })).toBeTruthy();
    expect(within(card).queryByRole("button", { name: "Abrir um site" })).toBeNull();
    // The bar under the field, always there: Desistir beside Pronto, the main one on the right, nothing to go back from.
    const row = card.querySelector(".brw-type + .brw-ac__back") as HTMLElement;
    expect(card.lastElementChild === row).toBe(true);
    expect([...row.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "Deixar um recado",
      "Desistir",
      "Pronto",
    ]);
    expect(row.textContent).toContain("Devolver à Ada");
    expect(within(card).queryByRole("button", { name: "Não consegui" })).toBeNull();
    expect(document.querySelector(".brw-rq")?.textContent).toContain("Você está ajudando · neste card");

    // The typing bar: one field, Senha as a lock toggle, the keys behind a keyboard button.
    const lock = within(card).getByRole("button", { name: "Esconder o texto (senha)" });
    await act(async () => fireEvent.click(lock));
    expect(within(card).getByRole("button", { name: "Mostrar o texto" }).getAttribute("aria-pressed")).toBe("true");
    expect(card.querySelector(".brw-keycaps")).toBeNull();
    await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Teclas" })));
    const keys = within(card).getByRole("group", { name: "Teclas" });
    expect(
      within(keys)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Tab", "Enter", "Apagar", "Esc"]);

    // Desistir asks what happened: its note is one line in the middle of its field that grows as it wraps.
    await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Desistir" })));
    expect(card.textContent).toContain("O que aconteceu?");
    const why = within(card).getByPlaceholderText("Conte com suas palavras") as HTMLTextAreaElement;
    expect([why.getAttribute("rows"), why.className]).toEqual(["1", "ac-input brw-ac__note"]);
    expect(card.querySelector(".brw-ac__back")).toBeNull();
    await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Voltar" })));

    // Ada asked nothing, so no note field until "Deixar um recado".
    expect(within(card).queryByRole("textbox", { name: "Recado para a Ada" })).toBeNull();
    const foot = card.querySelector(".brw-ac__back") as HTMLElement;
    // The word for Ada (Enter sends), then it hands back: the card folds away.
    await act(async () => fireEvent.click(within(foot).getByRole("button", { name: "Deixar um recado" })));
    // Opened by mistake, Esc closes it while it's empty, and it opens again.
    await act(async () =>
      fireEvent.keyDown(within(card).getByRole("textbox", { name: "Recado para a Ada" }), { key: "Escape" }),
    );
    expect(within(card).queryByRole("textbox", { name: "Recado para a Ada" })).toBeNull();
    await act(async () => fireEvent.click(within(foot).getByRole("button", { name: "Deixar um recado" })));
    const note = within(card).getByRole("textbox", { name: "Recado para a Ada" }) as HTMLTextAreaElement;
    expect(document.activeElement === note).toBe(true);
    // The same note as on the screen: one line in the middle of its field that grows as it wraps, with no grip.
    expect([note.tagName, note.getAttribute("rows"), note.className]).toEqual([
      "TEXTAREA",
      "1",
      "ac-input brw-ac__note",
    ]);
    await act(async () => fireEvent.change(note, { target: { value: "Entrei com a conta de teste" } }));
    // Shift+Enter adds a line, as in the chat; Enter sends the note, and adds no line to it.
    expect(fireEvent.keyDown(note, { key: "Enter", shiftKey: true })).toBe(true);
    let typed = true;
    await act(async () => {
      typed = fireEvent.keyDown(note, { key: "Enter" });
    });
    expect(typed).toBe(false);
    await settle(4);
    expect(state.calls.filter((c) => c.method === "browser.done").map((c) => c.args)).toEqual([
      [ORG_ID, HANDOFF_ID, "Entrei com a conta de teste"],
    ]);
    expect(document.querySelector(".brw-ac")).toBeNull();
  });

  test("its window on the agent's screen and I may drive the screen: Abrir aqui opens the whole screen, not the page", async () => {
    const { state, handoff } = seedRequest();
    const api = createFakeApi(state);
    const fake = fakeBrowserOf.get(api);
    fake?.handoffs.set(handoff.id, handoff);
    fake?.desktops.set(ADA_ID, { available: true, reason: null, running: true, canControl: true });
    fake?.sameWindow.add(ADA_ID);
    // The screen's sockets never connect here: what opens is the point, not the stream.
    const realtime = fakeSockets();
    const screens: string[] = [];
    const createSocket: SocketFactory = (url) => {
      if (!url.includes("/api/desktop")) return realtime.factory(url);
      screens.push(url);
      return { addEventListener() {}, close() {}, binaryType: "blob" } as unknown as ReturnType<SocketFactory>;
    };
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api, createSocket });
    await settle(6);
    await act(async () => realtime.last().open());
    await act(async () => fireEvent.click(within(waitingRequest()).getByRole("button", { name: "Abrir aqui" })));
    await settle(6);
    expect(state.calls.filter((c) => c.method === "browser.takeControl").map((c) => c.args)).toEqual([
      [ORG_ID, HANDOFF_ID],
    ]);
    expect(screen().getByRole("dialog", { name: "Computador da Ada" })).toBeTruthy();
    expect(document.querySelector(".brw-ac")).toBeNull();
    expect(screens.at(-1)).toContain("mode=control");
  });

  test("with a mouse: no text bar (keys go to the page), the address bar with Colar on top, one click on Devolver hands back", async () => {
    const { state, handoff } = seedRequest();
    const active: BrowserHandoff = { ...handoff, kind: "takeover", status: "active", controllerUserId: "u-walter" };
    const api = createFakeApi(state);
    fakeBrowserOf.get(api)?.handoffs.set(handoff.id, active);
    await renderPage(<BrowserCard agentId={ADA_ID} name="Ada" handoff={active} canTakeOver />, { api, org: true });
    await settle(6);
    const card = document.querySelector(".brw-ac") as HTMLElement;
    expect(card.querySelector(".brw-type")).toBeNull();
    expect(within(card).queryByRole("textbox", { name: "Texto para a página" })).toBeNull();
    const top = card.querySelector(".brw-mf__top") as HTMLElement;
    expect(within(card).queryByRole("button", { name: "Abrir um site" })).toBeNull();
    const bar = card.querySelector(".brw-go") as HTMLElement;
    expect(within(bar).getByRole("textbox", { name: "Endereço do site" })).toBeTruthy();
    expect(within(bar).getByRole("button", { name: "Colar" }).getAttribute("title")).toBe(
      "Colar na página o que você copiou",
    );
    expect(card.textContent).toContain("Devolver à Ada");
    expect(within(card).queryByRole("textbox", { name: "Recado para a Ada" })).toBeNull();
    expect(within(card).getByRole("button", { name: "Deixar um recado" })).toBeTruthy();
    expect(within(top).queryByRole("button", { name: "Devolver" })).toBeNull();
    // The last of the card, so nothing of it covers the page; a take over has one way out, and nothing else closes it.
    const row = card.lastElementChild as HTMLElement;
    expect(row.classList.contains("brw-ac__back")).toBe(true);
    expect(within(row).queryByRole("button", { name: "Voltar" })).toBeNull();
    expect(within(row).queryByRole("button", { name: "Desistir" })).toBeNull();
    expect(row.contains(document.activeElement)).toBe(false);
    expect(state.calls.filter((c) => c.method === "browser.done")).toEqual([]);
    await act(async () => fireEvent.click(within(row).getByRole("button", { name: "Devolver" })));
    await settle(4);
    expect(state.calls.filter((c) => c.method === "browser.done").map((c) => c.args)).toEqual([[ORG_ID, HANDOFF_ID]]);
  });

  test("a request that asked the person something has its note open, with the keys still on the page", async () => {
    const { state, handoff } = seedRequest();
    const asked: BrowserHandoff = {
      ...handoff,
      instructions: "Entrar no painel e me dizer qual plano aparece?",
      status: "active",
      controllerUserId: "u-walter",
    };
    const api = createFakeApi(state);
    fakeBrowserOf.get(api)?.handoffs.set(handoff.id, asked);
    await renderPage(<BrowserCard agentId={ADA_ID} name="Ada" handoff={asked} canTakeOver />, { api, org: true });
    await settle(6);
    const card = document.querySelector(".brw-ac") as HTMLElement;
    const note = within(card).getByRole("textbox", { name: "Recado para a Ada" });
    expect(document.activeElement === note).toBe(false);
    expect(within(card).queryByRole("button", { name: "Deixar um recado" })).toBeNull();
    // The answer is its reason to be open: Esc leaves it.
    await act(async () => fireEvent.keyDown(note, { key: "Escape" }));
    expect(within(card).getByRole("textbox", { name: "Recado para a Ada" })).toBeTruthy();
  });

  test("a note left from an earlier turn shows, but takes no keys: Enter there would hand back", async () => {
    const { state } = seedRequest();
    await renderPage(
      <HandBackFoot
        title="Devolver à Ada"
        label="Devolver"
        grammar={{ name: "Ada", context: "female" }}
        note="Deixei aberto"
        onNote={() => {}}
        noteFirst={false}
        pending={false}
        onBack={() => {}}
      />,
      { api: createFakeApi(state) },
    );
    await settle(2);
    const note = screen().getByRole("textbox", { name: "Recado para a Ada" }) as HTMLTextAreaElement;
    expect(note.value).toBe("Deixei aberto");
    expect(document.activeElement === note).toBe(false);
  });

  test("Desistir keeps the words written in the bar, and a form left open goes with control", async () => {
    const { state, handoff } = seedRequest();
    const active: BrowserHandoff = { ...handoff, status: "active", controllerUserId: "u-walter" };
    let turn = (_: BrowserHandoff) => {};
    function Turns() {
      const [now, setNow] = useState(active);
      turn = setNow;
      return <BrowserCard agentId={ADA_ID} name="Ada" handoff={now} canTakeOver />;
    }
    await renderPage(<Turns />, { api: createFakeApi(state), org: true });
    await settle(6);
    const card = document.querySelector(".brw-ac") as HTMLElement;
    await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Deixar um recado" })));
    await act(async () =>
      fireEvent.change(within(card).getByRole("textbox", { name: "Recado para a Ada" }), {
        target: { value: "O código venceu" },
      }),
    );
    await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Desistir" })));
    const why = within(card).getByPlaceholderText("Conte com suas palavras") as HTMLTextAreaElement;
    expect(why.value).toBe("O código venceu");

    // Control ends with the form open: the next turn starts at the bar, not at why this one failed.
    await act(async () => turn({ ...active, id: "someone-else", controllerUserId: "u-other" }));
    await settle(2);
    expect(card.querySelector(".brw-ac__fail")).toBeNull();
    await act(async () => turn({ ...active, id: "next-turn", kind: "takeover" }));
    await settle(2);
    expect(within(card).queryByPlaceholderText("Conte com suas palavras")).toBeNull();
    expect(card.querySelector(".brw-ac__back")).not.toBeNull();
  });
});

/** A JPEG's first bytes (SOI + a start-of-frame for 1280×800): enough for the page's size. */
const FRAME_DATA = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 3, 32, 5, 0, 3, 0, 0, 0));

describe("the card in the message", () => {
  test("always open, its page in a frame of the agent's color: full screen and back, in control too", async () => {
    const { state, handoff } = seedRequest();
    const api = createFakeApi(state);
    fakeBrowserOf.get(api)?.handoffs.set(handoff.id, handoff);
    const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(6);
    const socket = r.sockets.last();
    await act(async () => socket.open());
    // Taking over from the request: the card is the control.
    await act(async () => fireEvent.click(within(waitingRequest()).getByRole("button", { name: "Abrir aqui" })));
    await settle(4);
    const card = document.querySelector(".brw-ac") as HTMLElement;
    await act(async () =>
      socket.push({
        type: "browser.frame",
        agentId: ADA_ID,
        seq: 1,
        data: FRAME_DATA,
        metadata: { deviceWidth: 1280, deviceHeight: 800 },
      }),
    );
    // The page in its frame, with no small form to fold it into.
    expect(card.classList.contains("brw-mf")).toBe(true);
    expect(card.querySelector(".brw-ac__page img")).toBeTruthy();
    expect(within(card).queryByRole("button", { name: "Recolher" })).toBeNull();
    // Full screen and back, as in the computer's window: corners pulled apart, then pushed together.
    const glyph = (name: string) => within(card).getByRole("button", { name }).querySelector("path")?.getAttribute("d");
    expect(glyph("Tela cheia")).toBe(icons.expand[0]?.[1].d);
    await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Tela cheia" })));
    expect(glyph("Sair da tela cheia")).toBe(icons.shrink[0]?.[1].d);
    await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Sair da tela cheia" })));
    expect(card.classList.contains("is-full")).toBe(false);
    expect(card.classList.contains("brw-mf")).toBe(true);
  });

  /**
   * The person in control of Ada's page (1280×800, shown at 640×400 from the window's corner: twice as small), and
   * what the card sends the page from here on ("pressed@200,200", "moved+left@…", "wheel@…:dx,dy").
   */
  async function inControlOfPage(view: "card" | "dialog" = "card") {
    const { state, handoff } = seedRequest();
    const api = createFakeApi(state);
    fakeBrowserOf.get(api)?.handoffs.set(handoff.id, handoff);
    let socket: ReturnType<Awaited<ReturnType<typeof renderApp>>["sockets"]["last"]>;
    if (view === "card") {
      const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
      await settle(6);
      socket = r.sockets.last();
      await act(async () => socket.open());
      await act(async () => fireEvent.click(within(waitingRequest()).getByRole("button", { name: "Abrir aqui" })));
      await settle(4);
    } else {
      // The computer dialog's page: the same card, bigger (`surface`), with the request already taken.
      const active: BrowserHandoff = { ...handoff, kind: "takeover", status: "active", controllerUserId: "u-walter" };
      fakeBrowserOf.get(api)?.handoffs.set(handoff.id, active);
      const r = await renderPage(<BrowserCard agentId={ADA_ID} name="Ada" handoff={active} surface canTakeOver />, {
        api,
        org: true,
      });
      await settle(6);
      socket = r.sockets.last();
      await act(async () => socket.open());
      await settle(4);
    }
    await act(async () =>
      socket.push({
        type: "browser.frame",
        agentId: ADA_ID,
        seq: 1,
        data: FRAME_DATA,
        metadata: { deviceWidth: 1280, deviceHeight: 800 },
      }),
    );
    await settle(2);
    const card = document.querySelector(".brw-ac") as HTMLElement;
    const page = card.querySelector(".brw-ac__page") as HTMLElement;
    const img = page.querySelector("img") as HTMLImageElement;
    img.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 640,
        height: 400,
        right: 640,
        bottom: 400,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    const before = socket.sent.length;
    type Sent = { type: string; events?: Record<string, unknown>[] };
    const sentToPage = () =>
      (socket.sent.slice(before) as Sent[])
        .filter((f) => f.type === "browser.input")
        .flatMap((f) => f.events ?? [])
        .map((e) =>
          e.type === "mouseWheel"
            ? `wheel@${e.x},${e.y}:${e.deltaX},${e.deltaY}`
            : `${String(e.type).replace("mouse", "").toLowerCase()}${e.type === "mouseMoved" ? `+${e.button}` : ""}@${e.x},${e.y}`,
        );
    // The card sends a drag's moves every 25 ms: this waits for them.
    const flushed = () => act(() => new Promise((r) => setTimeout(r, 40)));
    /** The input frames sent since, each as its events. */
    const frames = () =>
      (socket.sent.slice(before) as Sent[]).filter((f) => f.type === "browser.input").map((f) => f.events ?? []);
    return { card, page, img, socket, sentToPage, flushed, frames, state };
  }
  const pointer = (pointerId: number, x: number, y: number, pointerType = "mouse") => ({
    pointerId,
    pointerType,
    button: 0,
    buttons: 1,
    clientX: x,
    clientY: y,
  });

  const HINT = "Rolar agora move a página. Esc para sair";
  const wheelOnPage = async (page: HTMLElement) => {
    const e = new WheelEvent("wheel", { deltaY: 120, clientX: 100, clientY: 100, bubbles: true, cancelable: true });
    await act(async () => page.dispatchEvent(e));
    return e;
  };

  test("a page the agent shows as a phone: centred with its size said, and the person in control can end it", async () => {
    const { card, page, socket, state } = await inControlOfPage();
    expect(card.querySelector(".brw-emu")).toBeNull();
    await act(async () =>
      socket.push({
        type: "browser.frame",
        agentId: ADA_ID,
        seq: 2,
        data: FRAME_DATA,
        metadata: { deviceWidth: 390, deviceHeight: 844, emulated: "phone" },
      }),
    );
    const label = card.querySelector(".brw-emu") as HTMLElement;
    expect(label.textContent).toContain("Celular · 390×844");
    expect(page.classList.contains("is-emulated")).toBe(true);
    // Its button is off the page: pressing it sends the page nothing.
    expect(page.contains(label)).toBe(false);
    await act(async () => fireEvent.click(within(label).getByRole("button", { name: "Tamanho normal" })));
    await settle(2);
    expect(state.calls.filter((c) => c.method === "browser.open").map((c) => c.args)).toEqual([
      [ORG_ID, ADA_ID, { go: "normalSize" }],
    ]);
    // Back at the window's size: no label.
    await act(async () =>
      socket.push({
        type: "browser.frame",
        agentId: ADA_ID,
        seq: 3,
        data: FRAME_DATA,
        metadata: { deviceWidth: 1280, deviceHeight: 800 },
      }),
    );
    expect(card.querySelector(".brw-emu")).toBeNull();
    expect(page.classList.contains("is-emulated")).toBe(false);
  });

  test("the wheel scrolls the conversation until the page is pressed; Esc gives it back", async () => {
    const { card, page } = await inControlOfPage();
    const hint = () => card.querySelector(".brw-ac__capture")?.textContent ?? null;

    // Not pressed yet: the wheel is the conversation's (not taken by the page).
    expect((await wheelOnPage(page)).defaultPrevented).toBe(false);
    expect(hint()).toBeNull();

    // A click into the page takes the wheel, with no hint for the click itself; the hint shows once it scrolls.
    await act(async () => fireEvent.pointerDown(page, pointer(1, 100, 100)));
    await act(async () => fireEvent.pointerUp(page, pointer(1, 100, 100)));
    expect(hint()).toBeNull();
    expect((await wheelOnPage(page)).defaultPrevented).toBe(true);
    expect(hint()).toBe(HINT);

    // Esc gives the wheel back to the conversation, also with the focus outside the page.
    await act(async () => fireEvent.keyDown(document.body, { key: "Escape" }));
    expect(hint()).toBeNull();
    expect((await wheelOnPage(page)).defaultPrevented).toBe(false);
  });

  test("the scroll hint goes on its own after the wheel stops, on a click and when the mouse leaves", async () => {
    const { card, page, sentToPage } = await inControlOfPage();
    const hint = () => card.querySelector(".brw-ac__capture")?.textContent ?? null;
    await act(async () => fireEvent.pointerDown(page, pointer(1, 100, 100)));
    await act(async () => fireEvent.pointerUp(page, pointer(1, 100, 100)));

    await wheelOnPage(page);
    expect(hint()).toBe(HINT);
    await act(() => new Promise((r) => setTimeout(r, 1300)));
    expect(hint()).toBeNull();
    // Still the page's wheel: idle only hides the hint.
    expect((await wheelOnPage(page)).defaultPrevented).toBe(true);

    // A click while it shows: the hint goes and the click reaches the page.
    expect(hint()).toBe(HINT);
    await act(async () => fireEvent.pointerDown(page, pointer(1, 10, 20)));
    expect(hint()).toBeNull();
    await act(async () => fireEvent.pointerUp(page, pointer(1, 10, 20)));
    expect(hint()).toBeNull();
    expect(sentToPage().slice(-2)).toEqual(["pressed@20,40", "released@20,40"]);

    // The mouse leaving the page: the hint goes and the wheel is the conversation's again.
    await wheelOnPage(page);
    expect(hint()).toBe(HINT);
    await act(async () => fireEvent.pointerLeave(page, { pointerId: 1, pointerType: "mouse" }));
    expect(hint()).toBeNull();
    expect((await wheelOnPage(page)).defaultPrevented).toBe(false);
  });

  test("Esc with no hint showing still reaches the page", async () => {
    const { page, sentToPage } = await inControlOfPage();
    await act(async () => fireEvent.pointerDown(page, pointer(1, 100, 100)));
    await act(async () => fireEvent.pointerUp(page, pointer(1, 100, 100)));
    await act(async () => fireEvent.keyDown(page, { key: "Escape" }));
    expect(sentToPage().filter((m) => m.startsWith("key"))).not.toHaveLength(0);
    // And the wheel is the conversation's again.
    expect((await wheelOnPage(page)).defaultPrevented).toBe(false);
  });

  test("a press and a move drag on the page with the button held, past its edge too; a click stays a click", async () => {
    const { page, sentToPage, flushed } = await inControlOfPage();
    // A slider's handle at (100, 100) on the screen, (200, 200) on the page: pressed at once, dragged right.
    await act(async () => fireEvent.pointerDown(page, pointer(1, 100, 100)));
    expect(sentToPage()).toEqual(["moved+none@200,200", "pressed@200,200"]);
    await act(async () => fireEvent.pointerMove(page, pointer(1, 150, 100)));
    await flushed();
    await act(async () => fireEvent.pointerMove(page, pointer(1, 700, 100)));
    await act(async () => fireEvent.pointerUp(page, pointer(1, 720, 100)));
    // Out of the picture the drag stays at its right edge, and lets go there.
    expect(sentToPage().slice(2)).toEqual(["moved+left@300,200", "moved+left@1280,200", "released@1280,200"]);

    await act(async () => fireEvent.pointerDown(page, pointer(1, 10, 20)));
    await act(async () => fireEvent.pointerUp(page, pointer(1, 10, 20)));
    expect(sentToPage().slice(5)).toEqual(["moved+none@20,40", "pressed@20,40", "released@20,40"]);
  });

  for (const view of ["card", "dialog"] as const) {
    test(`a slider captcha in the ${view}: a slow press-and-drag 200 px right reaches the page held, never as a scroll`, async () => {
      const { card, page, sentToPage, flushed } = await inControlOfPage(view);
      if (view === "dialog") expect(card.classList.contains("is-surface")).toBe(true);
      await act(async () => fireEvent.pointerDown(page, pointer(1, 50, 100)));
      // 100 px of the shown frame (200 of the page) in 5 px steps, a person's pace.
      for (let x = 55; x <= 150; x += 5) {
        await act(async () => fireEvent.pointerMove(page, pointer(1, x, 100)));
        await flushed();
      }
      await act(async () => fireEvent.pointerUp(page, pointer(1, 150, 100)));
      await flushed();
      const sent = sentToPage();
      expect(sent.slice(0, 2)).toEqual(["moved+none@100,200", "pressed@100,200"]);
      expect(sent.at(-1)).toBe("released@300,200");
      const moves = sent.slice(2, -1);
      expect(moves).toHaveLength(20);
      expect(moves.every((m) => m.startsWith("moved+left@"))).toBe(true);
      expect(moves.at(-1)).toBe("moved+left@300,200");
      expect(sent.some((m) => m.startsWith("wheel"))).toBe(false);
    });
  }

  test("no scroll hint for a press, a drag or its release", async () => {
    const { card, page } = await inControlOfPage();
    await act(async () => fireEvent.pointerDown(page, pointer(1, 50, 100)));
    await act(async () => fireEvent.pointerMove(page, pointer(1, 90, 100)));
    expect(card.querySelector(".brw-ac__capture")).toBeNull();
    await act(async () => fireEvent.pointerUp(page, pointer(1, 90, 100)));
    expect(card.querySelector(".brw-ac__capture")).toBeNull();
  });

  test("a release lost elsewhere: the next move with no button down lets go, never drags", async () => {
    const { page, sentToPage, flushed } = await inControlOfPage();
    await act(async () => fireEvent.pointerDown(page, pointer(1, 50, 100)));
    await act(async () => fireEvent.pointerMove(page, { ...pointer(1, 80, 100), buttons: 0 }));
    await act(async () => fireEvent.pointerMove(page, { ...pointer(1, 120, 100), buttons: 0 }));
    await flushed();
    expect(sentToPage()).toEqual(["moved+none@100,200", "pressed@100,200", "released@160,200"]);
  });

  test("on a touch screen a finger that moves drags, two fingers scroll the page, and the hint says so", async () => {
    const { card, page, sentToPage, flushed } = await inControlOfPage();
    const hint = () => card.querySelector(".brw-ac__capture")?.textContent ?? null;
    // In control the page takes the fingers, not the conversation.
    expect(page.classList.contains("is-control")).toBe(true);
    const css = await Bun.file(new URL("../src/components/browser/browser.css", import.meta.url).pathname).text();
    expect(css.split("\n.brw-ac__page.is-control {")[1]?.split("}")[0]).toContain("touch-action: none");
    await act(async () => fireEvent.pointerDown(page, pointer(1, 100, 100, "touch")));
    expect(sentToPage()).toEqual([]);
    await act(async () => fireEvent.pointerMove(page, pointer(1, 130, 100, "touch")));
    expect(sentToPage()).toEqual(["moved+none@200,200", "pressed@200,200", "moved+left@260,200"]);
    expect(hint()).toBe("Arraste com um dedo. Role com dois");
    await act(async () => fireEvent.pointerUp(page, pointer(1, 130, 100, "touch")));
    expect(sentToPage().slice(3)).toEqual(["released@260,200"]);
    expect(hint()).toBeNull();

    // Two fingers up by 30 px: the page scrolls down by 60 of its own, and nothing is pressed.
    await act(async () => fireEvent.pointerDown(page, pointer(2, 100, 100, "touch")));
    await act(async () => fireEvent.pointerDown(page, pointer(3, 200, 100, "touch")));
    await act(async () => fireEvent.pointerMove(page, pointer(2, 100, 70, "touch")));
    await act(async () => fireEvent.pointerMove(page, pointer(3, 200, 70, "touch")));
    await flushed();
    expect(sentToPage().slice(4)).toEqual(["wheel@300,140:0,60"]);
    await act(async () => fireEvent.pointerUp(page, pointer(2, 100, 70, "touch")));
    await act(async () => fireEvent.pointerUp(page, pointer(3, 200, 70, "touch")));
    expect(sentToPage()).toHaveLength(5);

    // A finger whose lift never came doesn't make the next touch a second finger: that one drags.
    await act(async () => fireEvent.pointerDown(page, { ...pointer(4, 100, 100, "touch"), isPrimary: true }));
    await act(async () => fireEvent.pointerDown(page, { ...pointer(5, 100, 100, "touch"), isPrimary: true }));
    await act(async () => fireEvent.pointerMove(page, pointer(5, 130, 100, "touch")));
    expect(sentToPage().slice(5)).toEqual(["moved+none@200,200", "pressed@200,200", "moved+left@260,200"]);
  });

  const pasteOn = (el: Element, text: string) =>
    act(
      async () =>
        void fireEvent.paste(el, { clipboardData: { getData: (type: string) => (type === "text/plain" ? text : "") } }),
    );
  const toast = () => [...document.querySelectorAll(".ac-toast")].at(-1)?.textContent ?? null;

  test("in control with the focus nowhere, keys go to the page without a click first", async () => {
    const { page } = await inControlOfPage();
    expect(document.activeElement).toBe(page);
  });

  test("what the person does that can't reach the page: the card says so, again when a try fails again", async () => {
    const { socket } = await inControlOfPage();
    expect(toast()).toBeNull();
    const refused = async (code: string) => {
      await act(async () => socket.push({ type: "error", agentId: ADA_ID, code }));
      await settle(2);
      return [...document.querySelectorAll(".ac-toast")].at(-1);
    };
    const first = await refused("input_failed");
    expect(toast()).toContain("não chegou à página");
    // Nothing repaints after a try that failed, so no picture clears the first refusal.
    expect(await refused("input_failed")).not.toBe(first);
    await refused("no_field");
    expect(toast()).toContain("Nenhum campo está selecionado");
  });

  test("the person's paste keys paste their text into the page's field as text, in pieces a frame carries", async () => {
    const { page, frames } = await inControlOfPage("dialog");
    await act(async () => page.focus());
    // ⌘V (Ctrl+V elsewhere) is the browser's own paste: not sent as keys, not stopped, into the field nobody sees.
    const keys = isApple() ? { metaKey: true } : { ctrlKey: true };
    expect(fireEvent.keyDown(page, { key: "v", code: "KeyV", ...keys })).toBe(true);
    const field = page.querySelector("textarea.brw-paste") as HTMLTextAreaElement;
    expect(document.activeElement).toBe(field);
    expect(frames()).toEqual([]);
    await pasteOn(field, "Olá, ação: 日本 😀\r\nfim");
    expect(frames()).toEqual([[{ kind: "text", text: "Olá, ação: 日本 😀\nfim" }]]);
    // The page has the keys again.
    expect(document.activeElement).toBe(page);
    // Longer than one event carries: pieces of 10,000, each in a frame of its own, an emoji never split.
    const long = `${"x".repeat(9_999)}😀${"y".repeat(12_000)}`;
    await pasteOn(page, long);
    const pieces = frames()
      .slice(1)
      .map((f) => f.map((e) => (e as { text: string }).text));
    expect(pieces.map((f) => f.length)).toEqual([1, 1, 1]);
    expect(pieces.flat().join("")).toBe(long);
    expect(pieces.flat()[0]).toBe("x".repeat(9_999));
    // No text (a picture), or more than the computer takes: said, nothing sent.
    await pasteOn(page, "");
    expect(toast()).toBe("No computador da Ada só dá para colar texto.");
    await pasteOn(page, "x".repeat(262_144));
    expect(toast()).toContain("No máximo 256 KB.");
    expect(frames()).toHaveLength(4);
  });

  test("Colar pastes the person's clipboard where their browser lets the page read it, else says how", async () => {
    const { card, page, frames } = await inControlOfPage("dialog");
    const colar = within(card.querySelector(".brw-go") as HTMLElement).getByRole("button", { name: "Colar" });
    const real = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    let readText: () => Promise<string> = async () => "senha-de-teste";
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText: () => readText() } });
    try {
      await act(async () => fireEvent.click(colar));
      await settle(2);
      expect(frames()).toEqual([[{ kind: "text", text: "senha-de-teste" }]]);
      expect(document.activeElement).toBe(page);
      readText = () => Promise.reject(new DOMException("Read permission denied.", "NotAllowedError"));
      await act(async () => fireEvent.click(colar));
      await settle(2);
      expect(toast()).toBe(
        `O navegador não deixou ler o que você copiou. Use ${isApple() ? "⌘V" : "Ctrl+V"} na página.`,
      );
      expect(frames()).toHaveLength(1);
    } finally {
      if (real) Object.defineProperty(navigator, "clipboard", real);
      else delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });

  test("its Chrome on the agent's desktop: Ver a tela inteira over the page, and in the frame's top in control", async () => {
    const api = createFakeApi(seedState());
    fakeBrowserOf.get(api)?.desktops.set(ADA_ID, { available: true, running: true });
    const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(5);
    const socket = r.sockets.last();
    await act(async () => socket.open());
    const run = { channelId: ENG_ID, threadId: null, runId: "r-desktop", agentId: ADA_ID };
    await act(async () => socket.push({ type: "event", channelId: ENG_ID, event: { type: "agent.thinking", ...run } }));
    await act(async () =>
      socket.push({ type: "event", channelId: ENG_ID, event: { type: "agent.tool", tool: "browser_open", ...run } }),
    );
    await settle(3);
    const card = document.querySelector(".brw-ac") as HTMLElement;
    const over = card.querySelector(".brw-mf__over") as HTMLElement;
    expect(within(over).getByRole("button", { name: "Ver a tela inteira" })).toBeTruthy();

    await act(async () => fireEvent.click(within(over).getByRole("button", { name: "Assumir" })));
    await settle(3);
    const top = card.querySelector(".brw-mf__top") as HTMLElement;
    await act(async () => fireEvent.click(within(top).getByRole("button", { name: "Ver a tela inteira" })));
    await settle(6);
    expect(screen().getByRole("dialog", { name: "Computador da Ada" })).toBeTruthy();
  });
});

describe("the frame's stop", () => {
  test("asks 'Parar a Ada?' with her name, its words off the toolbar's edge; the frame's top is a dark surface", async () => {
    const api = createFakeApi(seedState());
    const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(5);
    const socket = r.sockets.last();
    await act(async () => socket.open());
    const run = { channelId: ENG_ID, threadId: null, runId: "r-stop", agentId: ADA_ID };
    await act(async () => socket.push({ type: "event", channelId: ENG_ID, event: { type: "agent.thinking", ...run } }));
    await act(async () =>
      socket.push({ type: "event", channelId: ENG_ID, event: { type: "agent.tool", tool: "browser_open", ...run } }),
    );
    await settle(3);
    const card = document.querySelector(".brw-ac") as HTMLElement;
    expect(card.querySelector(".brw-mf__top")?.classList.contains("ac-on-dark")).toBe(true);
    const over = card.querySelector(".brw-mf__over") as HTMLElement;
    await act(async () => fireEvent.click(within(over).getByRole("button", { name: "Parar" })));
    await settle(2);
    const ask = over.querySelector(".brw-stopask") as HTMLElement;
    expect(ask.textContent).toBe("Parar a Ada?");
    expect(within(over).getByRole("button", { name: "Não" })).toBeTruthy();
  });
});

describe("the card's title", () => {
  test("'opening' only until the first frame; then the site, or the agent's browser when none is known", () => {
    expect(titleKind({ inControl: false, ask: null, host: "", opening: true })).toBe("opening");
    // A frame arrived (no longer opening) without an address yet: never stuck on "Abrindo".
    expect(titleKind({ inControl: false, ask: null, host: "", opening: false })).toBe("agent");
    expect(titleKind({ inControl: false, ask: null, host: "acme.example", opening: false })).toBe("host");
    expect(titleKind({ inControl: true, ask: "Entrar no painel", host: "acme.example", opening: false })).toBe("ask");
    expect(titleKind({ inControl: true, ask: null, host: "acme.example", opening: false })).toBe("host");
  });
});

describe("a card whose page doesn't come never stays on Opening", () => {
  let offScreen = () => {};
  afterEach(() => {
    setSystemTime();
    offScreen();
    offScreen = () => {};
  });

  const page = (seq = 1) => ({
    type: "browser.frame",
    agentId: ADA_ID,
    seq,
    data: FRAME_DATA,
    metadata: { deviceWidth: 1280, deviceHeight: 800 },
  });
  const watches = (socket: { sent: unknown[] }) =>
    socket.sent.filter((f) => (f as { type: string }).type === "browser.watch").length;
  const later = () => setSystemTime(new Date(Date.now() + BROWSER_STUCK_MS + 1000));

  test("after a server restart the page never comes: in 75 s it says so, and Tentar de novo restarts the browser", async () => {
    const { state, handoff } = seedRequest();
    const api = createFakeApi(state);
    fakeBrowserOf.get(api)?.handoffs.set(handoff.id, handoff);
    const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(6);
    await act(async () => r.sockets.last().open());
    await act(async () => fireEvent.click(within(waitingRequest()).getByRole("button", { name: "Abrir aqui" })));
    await settle(4);
    const card = document.querySelector(".brw-ac") as HTMLElement;
    const cover = () => card.querySelector(".brw-dim__box")?.textContent ?? "";
    expect(cover()).toContain("Na primeira vez neste computador pode levar um minuto.");
    // The server restarts: the socket comes back and the card watches again, but its page doesn't come.
    await act(async () => r.sockets.last().drop());
    await act(() => new Promise((done) => setTimeout(done, 650)));
    const socket = r.sockets.last();
    await act(async () => socket.open());
    await settle(2);
    expect(watches(socket)).toBe(1);
    const active = { ...handoff, status: "active", controllerUserId: "u-walter", expiresAt: null };
    const status = { type: "browser.status", agentId: ADA_ID, mode: "control", controllerUserId: "u-walter" };
    await act(async () => socket.push({ ...status, handoff: active, hidden: false }));
    expect(cover()).toContain("Abrindo o navegador da Ada…");
    later();
    // The client's retries are answered with the computer's reason, with no page.
    await act(async () =>
      socket.push({
        type: "browser.unavailable",
        agentId: ADA_ID,
        reason: "unavailable",
        message: "the computer VPS did not answer within 120 s",
      }),
    );
    expect(cover()).toContain("Não deu para abrir o navegador da Ada.");
    expect(cover()).toContain("Tentar de novo reinicia o navegador. Os logins continuam salvos.");
    expect(card.querySelector(".brw-mf__top b")?.textContent).toBe("Entrar no painel com a conta de teste");
    const before = watches(socket);
    await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Tentar de novo" })));
    await settle(3);
    expect(state.calls.filter((c) => c.method === "browser.restart").map((c) => c.args)).toEqual([[ORG_ID, ADA_ID]]);
    // And it watches again: its own watch may be what the server refused.
    expect(watches(socket)).toBe(before + 1);
    // It waits again, from the start, and the page shows when it comes.
    expect(cover()).toContain("Abrindo o navegador da Ada…");
    await act(async () => socket.push(page()));
    expect(card.querySelector(".brw-dim")).toBeNull();
    expect(card.querySelector(".brw-ac__page img")).toBeTruthy();
  });

  test("Abrir aqui while the agent's own card watches its browser: the request's card gets the page too", async () => {
    offScreen = onScreen(".brw-ac");
    const { state, handoff } = seedRequest();
    const api = createFakeApi(state);
    fakeBrowserOf.get(api)?.handoffs.set(handoff.id, handoff);
    const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(6);
    const socket = r.sockets.last();
    await act(async () => socket.open());
    /** The server answers each `browser.watch` on the socket: who is in control, and the newest page. */
    let answered = 0;
    const serve = async (status: Record<string, unknown>) => {
      for (; answered < watches(socket); answered++) {
        await act(async () => socket.push({ type: "browser.status", agentId: ADA_ID, hidden: false, ...status }));
        await act(async () => socket.push(page()));
      }
    };
    // Ada works in its browser: its run's card watches it, and shows the page (one that isn't repainting).
    const run = { channelId: ENG_ID, threadId: null, runId: "r-ask", agentId: ADA_ID };
    await act(async () => socket.push({ type: "event", channelId: ENG_ID, event: { type: "agent.thinking", ...run } }));
    await act(async () =>
      socket.push({ type: "event", channelId: ENG_ID, event: { type: "agent.tool", tool: "browser_open", ...run } }),
    );
    await settle(3);
    await serve({ mode: "watch", controllerUserId: null, handoff: null });
    expect(document.querySelector(".brw-ac .brw-ac__page img")).toBeTruthy();
    // It asked for help; Abrir aqui opens the request's own card, in control.
    await act(async () => fireEvent.click(within(waitingRequest()).getByRole("button", { name: "Abrir aqui" })));
    await settle(4);
    const active = { ...handoff, status: "active", controllerUserId: "u-walter", expiresAt: null };
    await serve({ mode: "control", controllerUserId: "u-walter", handoff: active });
    const cards = [...document.querySelectorAll(".brw-ac")] as HTMLElement[];
    expect(cards).toHaveLength(1);
    expect(cards[0]?.classList.contains("is-control")).toBe(true);
    expect(cards[0]?.querySelector(".brw-dim")).toBeNull();
    expect(cards[0]?.querySelector(".brw-ac__page img")).toBeTruthy();
  });

  test("Reconectando… for 75 s says it couldn't open: someone who only watches tries again by watching", async () => {
    offScreen = onScreen(".brw-ac");
    const state = seedState();
    const api = createFakeApi(state);
    fakeBrowserOf.get(api)?.watchOnly.add(ADA_ID);
    const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(5);
    const socket = r.sockets.last();
    await act(async () => socket.open());
    const run = { channelId: ENG_ID, threadId: null, runId: "r-watch", agentId: ADA_ID };
    await act(async () => socket.push({ type: "event", channelId: ENG_ID, event: { type: "agent.thinking", ...run } }));
    await act(async () =>
      socket.push({ type: "event", channelId: ENG_ID, event: { type: "agent.tool", tool: "browser_open", ...run } }),
    );
    await settle(3);
    const card = document.querySelector(".brw-ac") as HTMLElement;
    const cover = () => card.querySelector(".brw-dim__box")?.textContent ?? "";
    // The agent's computer restarted and doesn't come back.
    await act(async () => socket.push({ type: "browser.unavailable", agentId: ADA_ID, reason: "reconnecting" }));
    expect(cover()).toContain("Reconectando");
    later();
    await act(async () => socket.push({ type: "browser.unavailable", agentId: ADA_ID, reason: "reconnecting" }));
    expect(cover()).toContain("Não deu para abrir o navegador da Ada.");
    // Watching doesn't restart anyone's browser: no word about it.
    expect(cover()).not.toContain("reinicia");
    const before = watches(socket);
    await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Tentar de novo" })));
    await settle(2);
    expect(watches(socket)).toBe(before + 1);
    expect(state.calls.some((c) => c.method === "browser.restart")).toBe(false);
    await act(async () =>
      socket.push({ type: "browser.status", agentId: ADA_ID, mode: "watch", controllerUserId: null, handoff: null }),
    );
    // A server that paces the view asks for answers (`ack: true`): it takes rate changes too.
    await act(async () => socket.push({ ...page(), ack: true }));
    expect(card.querySelector(".brw-dim")).toBeNull();
    // In the conversation and full screen alike the page gets the stream's own rate (ADR 0040 §7.1): no limit asked,
    // and going full screen changes nothing, never a new watch, which would restart the view.
    const asked = socket.sent.filter((f) => (f as { type: string }).type === "browser.watch");
    expect(asked.every((f) => (f as { maxFps?: number }).maxFps === undefined)).toBe(true);
    const watched = watches(socket);
    const rates = () => socket.sent.filter((f) => (f as { type: string }).type === "browser.fps");
    await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Tela cheia" })));
    await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Sair da tela cheia" })));
    expect(rates()).toHaveLength(0);
    expect(watches(socket)).toBe(watched);
    // Closed, nothing waiting: the cover says so plainly, and the logins sentence once, not under the title too.
    await act(async () => socket.push({ type: "browser.unavailable", agentId: ADA_ID, reason: "closed" }));
    expect(cover()).toContain("O navegador da Ada está fechado.");
    expect(card.textContent?.split("Os logins continuam salvos").length).toBe(2);
  });

  test("off screen the wait doesn't count: shown after 75 s it's still opening; too many browsers says so", async () => {
    // The card's observer, answered by the test: off screen until shown.
    let show = () => {};
    const native = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = class {
      constructor(readonly answer: IntersectionObserverCallback) {}
      observe(target: Element) {
        if (!target.matches(".brw-ac")) return;
        show = () => this.answer([{ isIntersecting: true, target } as IntersectionObserverEntry], this as never);
      }
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    } as unknown as typeof IntersectionObserver;
    offScreen = () => {
      globalThis.IntersectionObserver = native;
    };
    const state = seedState();
    const api = createFakeApi(state);
    const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(5);
    const socket = r.sockets.last();
    await act(async () => socket.open());
    const run = { channelId: ENG_ID, threadId: null, runId: "r-off", agentId: ADA_ID };
    await act(async () => socket.push({ type: "event", channelId: ENG_ID, event: { type: "agent.thinking", ...run } }));
    await act(async () =>
      socket.push({ type: "event", channelId: ENG_ID, event: { type: "agent.tool", tool: "browser_open", ...run } }),
    );
    await settle(3);
    const card = document.querySelector(".brw-ac") as HTMLElement;
    const cover = () => card.querySelector(".brw-dim__box")?.textContent ?? "";
    later();
    await act(async () => show());
    await settle(2);
    expect(cover()).toContain("Abrindo o navegador da Ada…");
    // Its watch refused (a fifth browser on this socket): that, not an opening that never ends.
    await act(async () => socket.push({ type: "error", agentId: ADA_ID, code: "too_many_browsers" }));
    expect(cover()).toContain("Muitos navegadores abertos ao mesmo tempo. Este aparece quando outro fechar.");
    later();
    await act(async () => socket.push({ type: "error", agentId: ADA_ID, code: "too_many_browsers" }));
    expect(cover()).not.toContain("Não deu para abrir");
    // Let in (another view left): the page shows.
    await act(async () =>
      socket.push({ type: "browser.status", agentId: ADA_ID, mode: "watch", controllerUserId: null, handoff: null }),
    );
    await act(async () => socket.push(page()));
    expect(card.querySelector(".brw-dim")).toBeNull();
  });
});

/** A person's socket to the agent's screen: the server side closes it with a code. */
class ScreenSocket {
  binaryType = "blob";
  readyState = 1;
  closed = false;
  private listeners = new Map<string, ((e: unknown) => void)[]>();
  constructor(readonly url: string) {}
  addEventListener(type: string, fn: (e: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  send() {}
  close() {
    this.closed = true;
  }
  serverClose(code: number, reason = "") {
    this.closed = true;
    for (const fn of this.listeners.get("close") ?? []) fn({ code, reason });
  }
}

describe("its browser on the agent's screen: the card shows the whole screen (ADR 0058 §7)", () => {
  let offScreen = () => {};
  afterEach(() => {
    offScreen();
    offScreen = () => {};
    FakeRfb.all = [];
  });

  const watches = (socket: { sent: unknown[] }) =>
    socket.sent.filter((f) => (f as { type: string }).type === "browser.watch").length;

  /** Ada works in her browser, which runs on her screen; her run's card in #eng, on screen. */
  async function working(desktop: Partial<DesktopStatus> = {}) {
    offScreen = onScreen(".brw-ac");
    const state = seedState();
    const api = createFakeApi(state);
    const fake = fakeBrowserOf.get(api);
    fake?.desktops.set(ADA_ID, { available: true, reason: null, running: true, canControl: true, ...desktop });
    fake?.sameWindow.add(ADA_ID);
    const realtime = fakeSockets();
    const screens: ScreenSocket[] = [];
    const createSocket: SocketFactory = (url) => {
      if (!url.includes("/api/desktop")) return realtime.factory(url);
      const s = new ScreenSocket(url);
      screens.push(s);
      return s as unknown as ReturnType<SocketFactory>;
    };
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api, createSocket });
    await settle(5);
    const socket = realtime.last();
    await act(async () => socket.open());
    const run = { channelId: ENG_ID, threadId: null, runId: "r-screen", agentId: ADA_ID };
    await act(async () => socket.push({ type: "event", channelId: ENG_ID, event: { type: "agent.thinking", ...run } }));
    await act(async () =>
      socket.push({ type: "event", channelId: ENG_ID, event: { type: "agent.tool", tool: "browser_open", ...run } }),
    );
    await settle(6);
    const card = document.querySelector(".brw-ac") as HTMLElement;
    return { state, socket, screens, card };
  }

  test("the screen in the card, watching only, on a card's own socket; no frames watched meanwhile", async () => {
    const { socket, screens, card } = await working();
    expect(screens).toHaveLength(1);
    expect(screens[0]?.url).toContain("preview=1&mode=watch");
    expect(screens[0]?.url).not.toContain("switch=1");
    expect(watches(socket)).toBe(0);
    expect(card.querySelector(".brw-ac__stage > .dsk.dsk--card")).not.toBeNull();
    expect(card.querySelector(".brw-ac__page")).toBeNull();
    // Take over and Stop go over it once it shows.
    expect(card.querySelector(".brw-mf__over")).toBeNull();
    await act(async () => FakeRfb.all.at(-1)?.emit("connect"));
    await settle(3);
    const over = card.querySelector(".brw-mf__over") as HTMLElement;
    expect(within(over).getByRole("button", { name: "Assumir" })).toBeTruthy();
    expect(within(over).getByRole("button", { name: "Parar" })).toBeTruthy();
    expect(FakeRfb.all.at(-1)?.viewOnly).toBe(true);
    expect(watches(socket)).toBe(0);
  });

  test("a screen that can't show (not available, not running): the browser's frames, never its socket", async () => {
    for (const desktop of [{ available: false, reason: "offline" }, { running: false }]) {
      const { socket, screens, card } = await working(desktop);
      expect(screens).toHaveLength(0);
      expect(watches(socket)).toBeGreaterThan(0);
      expect(card.querySelector(".dsk--card")).toBeNull();
      cleanup();
      offScreen();
    }
  });

  test("its view refused (a person opening the screen took its place): back to the browser's frames at once", async () => {
    const { socket, screens, card } = await working();
    await act(async () => FakeRfb.all.at(-1)?.emit("connect"));
    await settle(3);
    await act(async () => screens[0]?.serverClose(4429, "preview_yield"));
    await settle(6);
    expect(card.querySelector(".dsk--card")).toBeNull();
    expect(watches(socket)).toBeGreaterThan(0);
    // No new socket to the screen by itself.
    expect(screens).toHaveLength(1);
  });

  test("Assumir: the person drives the browser on its frames, watched again to keep their control", async () => {
    const { state, socket, card } = await working();
    await act(async () => FakeRfb.all.at(-1)?.emit("connect"));
    await settle(3);
    const over = card.querySelector(".brw-mf__over") as HTMLElement;
    await act(async () => fireEvent.click(within(over).getByRole("button", { name: "Assumir" })));
    await settle(6);
    expect(state.calls.filter((c) => c.method === "browser.takeover").map((c) => c.args)).toEqual([
      [ORG_ID, ADA_ID, "r-screen"],
    ]);
    expect(card.classList.contains("is-control")).toBe(true);
    expect(card.querySelector(".dsk--card")).toBeNull();
    expect(watches(socket)).toBeGreaterThan(0);
  });

  test("a shared profile's card never shows the screen", async () => {
    offScreen = onScreen(".brw-ac");
    const state = seedState();
    const api = createFakeApi(state);
    const fake = fakeBrowserOf.get(api);
    fake?.desktops.set(ADA_ID, { available: true, reason: null, running: true, canControl: true });
    fake?.sameWindow.add(ADA_ID);
    const screens: string[] = [];
    const realtime = fakeSockets();
    const createSocket: SocketFactory = (url) => {
      if (!url.includes("/api/desktop")) return realtime.factory(url);
      screens.push(url);
      return new ScreenSocket(url) as unknown as ReturnType<SocketFactory>;
    };
    await renderPage(
      <BrowserCard
        agentId={ADA_ID}
        name="Loja"
        profile={{ id: "p-loja", name: "Loja", agentIds: [ADA_ID], canDrive: true }}
      />,
      { api, org: true, createSocket },
    );
    await settle(6);
    expect(screens).toEqual([]);
    expect(document.querySelector(".dsk--card")).toBeNull();
    expect(state.calls.some((c) => c.method === "desktop.status")).toBe(false);
  });
});

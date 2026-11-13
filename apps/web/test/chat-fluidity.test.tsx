import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { domWindow, setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { MessageBody } from "@/chat/MessageBody";
import { ADA_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const open = async (state = seedState()) => {
  const r = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(5);
  await act(async () => r.sockets.last().open());
  await settle(2);
  const ev = (event: Record<string, unknown>) =>
    act(async () =>
      r.sockets.last().push({ type: "event", channelId: ENG_ID, event: { channelId: ENG_ID, ...event } }),
    );
  return { ...r, ev, state };
};

describe("a reply shows whole, once", () => {
  test("its blocks are siblings in one wrapper, drawn once", () => {
    const view = render(<MessageBody body={"Primeiro parágrafo.\n\nSegundo parágrafo.\n\nTerceiro."} />);
    const wrappers = view.container.querySelectorAll(".md");
    expect(wrappers).toHaveLength(1);
    const wrapper = wrappers[0] as HTMLElement;
    expect(wrapper.classList.contains("md--message")).toBe(true);
    expect([...wrapper.children].map((c) => c.tagName)).toEqual(["P", "P", "P"]);
  });

  test("while it works nothing of its words shows; its message brings them, once", async () => {
    const { ev } = await open();
    const ids = { threadId: null, runId: "r-live", agentId: ADA_ID };
    const body = "O cache do relatório expirou.\n\nVou refazer a consulta";
    await ev({ type: "agent.run", ...ids, status: "running" });
    await ev({ type: "agent.typing", ...ids });
    await ev({ type: "agent.delta", ...ids, seq: 0, text: body });
    await settle(3);
    expect(document.querySelector('[data-run-id="r-live"]')).toBeNull();
    expect(document.body.textContent).not.toContain("cache do relatório");
    await ev({
      type: "message.created",
      messageId: "m-ada",
      message: {
        id: "m-ada",
        channelId: ENG_ID,
        threadId: null,
        author: { type: "agent", id: ADA_ID },
        body,
        mentionedAgentIds: [],
        agentRunId: "r-live",
        createdAt: new Date().toISOString(),
      },
    });
    await ev({ type: "run.finished", ...ids, status: "done" });
    await settle(3);
    const shown = [...document.querySelectorAll(".ac-msg__text")].filter((t) =>
      t.textContent?.includes("cache do relatório"),
    );
    expect(shown).toHaveLength(1);
    expect(shown[0]?.closest(".ac-msg")?.classList.contains("ac-msg--streaming")).toBe(false);
  });
});

describe("following the bottom", () => {
  test("what grew while the list glided down (the activity bar opening) is followed once the glide ends, by a glide", async () => {
    const device = domWindow().happyDOM.settings.device;
    device.prefersReducedMotion = "no-preference";
    const native = globalThis.ResizeObserver;
    const observers: ResizeObserverCallback[] = [];
    globalThis.ResizeObserver = class {
      constructor(cb: ResizeObserverCallback) {
        observers.push(cb);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    try {
      await open();
      const log = screen().getByRole("region", { name: "Mensagens" });
      let height = 2000;
      Object.defineProperty(log, "scrollHeight", { configurable: true, get: () => height });
      Object.defineProperty(log, "clientHeight", { configurable: true, value: 500 });
      // A browser's glide ends where it was told to, even when the end moved on the way.
      const glides: (ScrollBehavior | undefined)[] = [];
      log.scrollTo = ((opts: ScrollToOptions) => {
        glides.push(opts.behavior);
        log.scrollTop = opts.top ?? 0;
      }) as typeof log.scrollTo;
      await act(() => new Promise((r) => setTimeout(r, 1600)));
      // The bar opens within the glide's 600ms, whatever a loaded machine takes to send and settle: the clock stands
      // still from the send until it opens.
      setSystemTime(new Date());
      const composer = screen().getByRole("combobox", { name: /Mensagem para/ });
      await act(async () => fireEvent.change(composer, { target: { value: "bom dia" } }));
      await act(async () => fireEvent.keyDown(composer, { key: "Enter" }));
      await settle(3);
      expect(log.scrollTop).toBe(2000);
      // The bar above the composer opens mid-glide: the end is 32px further.
      height = 2032;
      await act(async () => {
        for (const cb of observers) cb([], {} as ResizeObserver);
      });
      setSystemTime();
      expect(log.scrollTop).toBe(2000);
      await act(() => new Promise((r) => setTimeout(r, 700)));
      expect(log.scrollTop).toBe(2032);
      // It glides on to the new end: no jump there after the glide (a shift the eye catches after every send).
      expect(glides.at(-1)).toBe("smooth");
      // What grows during that second glide is caught up at once after it, not by a third one.
      const glided = glides.length;
      height = 2060;
      await act(async () => {
        for (const cb of observers) cb([], {} as ResizeObserver);
      });
      await act(() => new Promise((r) => setTimeout(r, 700)));
      expect(log.scrollTop).toBe(2060);
      expect(glides.length).toBe(glided);
    } finally {
      setSystemTime();
      globalThis.ResizeObserver = native;
      device.prefersReducedMotion = "reduce";
    }
  });

  test("rows that only report their first size during the glide start no second one; what grows next is followed at once", async () => {
    const device = domWindow().happyDOM.settings.device;
    device.prefersReducedMotion = "no-preference";
    const native = globalThis.ResizeObserver;
    const observers: ResizeObserverCallback[] = [];
    globalThis.ResizeObserver = class {
      constructor(cb: ResizeObserverCallback) {
        observers.push(cb);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    try {
      await open();
      const log = screen().getByRole("region", { name: "Mensagens" });
      let height = 2000;
      Object.defineProperty(log, "scrollHeight", { configurable: true, get: () => height });
      Object.defineProperty(log, "clientHeight", { configurable: true, value: 500 });
      const glides: (ScrollBehavior | undefined)[] = [];
      log.scrollTo = ((opts: ScrollToOptions) => {
        glides.push(opts.behavior);
        log.scrollTop = opts.top ?? 0;
      }) as typeof log.scrollTo;
      await act(() => new Promise((r) => setTimeout(r, 1600)));
      const composer = screen().getByRole("combobox", { name: /Mensagem para/ });
      await act(async () => fireEvent.change(composer, { target: { value: "bom dia" } }));
      await act(async () => fireEvent.keyDown(composer, { key: "Enter" }));
      await settle(3);
      const glided = glides.length;
      // The new row's first size, mid-glide: the end is where the glide was going.
      await act(async () => {
        for (const cb of observers) cb([], {} as ResizeObserver);
      });
      await act(() => new Promise((r) => setTimeout(r, 700)));
      expect(glides.length).toBe(glided);
      // The reply's first words right after: followed then, not held for a glide's end.
      height = 2040;
      await act(async () => {
        for (const cb of observers) cb([], {} as ResizeObserver);
      });
      expect(log.scrollTop).toBe(2040);
    } finally {
      globalThis.ResizeObserver = native;
      device.prefersReducedMotion = "reduce";
    }
  });
});

describe("a message's attachments", () => {
  const withFiles = async (files: [name: string, type: string][], hold = false) => {
    const state = seedState();
    const api = createFakeApi(state);
    const refs = [];
    for (const [name, type] of files) {
      const file = await api.artifacts.upload(ORG_ID, new File([new Uint8Array([1, 2, 3])], name, { type }));
      refs.push({ id: file.id, version: 1, title: name });
    }
    const base = state.messages[0] as (typeof state.messages)[number];
    state.messages.push({
      ...base,
      id: "m-files",
      threadId: null,
      body: "Os arquivos:",
      mentionedAgentIds: [],
      meta: { artifacts: refs },
      createdAt: new Date().toISOString(),
    });
    // The files' details never arrive: what the tiles are before them.
    if (hold) api.artifacts.get = () => new Promise(() => {});
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api });
    await settle(10);
    return [...document.querySelectorAll<HTMLElement>(".artifact-cards > *")];
  };
  /** What decides a tile's box: its classes and kind, and whether it has a cover, a name under it, a player. */
  const shape = (tile: HTMLElement) => ({
    tile: tile.classList.contains("artifact-tile"),
    media: tile.dataset.media ?? null,
    kind: tile.dataset.kind === "video" ? "video" : null,
    cover: [...tile.children].some((c) => c.classList.contains("artifact-tile__cover")),
    name: tile.querySelector(".artifact-tile__foot .artifact-tile__title")?.textContent ?? null,
    player: tile.querySelector(".ac-video--tile .ac-video__media") !== null,
  });
  const FILES: [string, string][] = [
    ["motor.zip", "application/zip"],
    ["tela.png", "image/png"],
    ["clipe.mp4", "video/mp4"],
    ["notas.pdf", "application/pdf"],
  ];

  test("each kind has its box before its details load: a file its cover and name, a picture its cover alone, a video its player's box", async () => {
    const [zip, picture, video, pdf] = (await withFiles(FILES, true)).map(shape);
    expect(zip).toEqual({ tile: true, media: null, kind: null, cover: true, name: "motor.zip", player: false });
    expect(picture).toEqual({ tile: true, media: "true", kind: null, cover: true, name: null, player: false });
    expect(video).toEqual({ tile: true, media: null, kind: "video", cover: false, name: null, player: true });
    expect(pdf).toEqual({ tile: true, media: null, kind: null, cover: true, name: "notas.pdf", player: false });
    for (const tile of document.querySelectorAll(".artifact-cards > *")) {
      expect(tile.classList.contains("artifact-tile--loading")).toBe(true);
      expect(tile.getAttribute("aria-busy")).toBe("true");
    }
  });

  test("and keeps that box once they do, and once the picture is in: no tile changes shape", async () => {
    const before = (await withFiles(FILES, true)).map(shape);
    cleanup();
    const tiles = await withFiles(FILES);
    expect(tiles.map(shape)).toEqual(before);
    expect(document.querySelector(".artifact-tile--loading")).toBeNull();
    const picture = tiles[1]?.querySelector(".artifact-tile__picture") as HTMLElement;
    const img = picture.querySelector("img") as HTMLImageElement;
    expect(img.getAttribute("src")).toStartWith("blob:");
    // No attribute, class or size of its own marks the picture as loading or loaded: the tile's box is its box.
    const marks = () => [picture.className, picture.getAttribute("style"), img.getAttribute("style"), img.className];
    const loading = marks();
    await act(async () => fireEvent.load(img));
    expect(marks()).toEqual(loading);
    expect(picture.dataset.loading).toBeUndefined();
    expect(document.querySelector(".ac-video")?.hasAttribute("data-ready")).toBe(false);
  });

  test("a file whose name doesn't say what it is keeps a file's box, its name wrapping as it will", async () => {
    const [tile] = await withFiles([["Relatório do trimestre (versão final para a diretoria)", "image/png"]], true);
    expect(shape(tile as HTMLElement).name).toBe("Relatório do trimestre (versão final para a diretoria)");
    expect(shape(tile as HTMLElement).media).toBeNull();
  });
});

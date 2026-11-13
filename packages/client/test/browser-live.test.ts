import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import {
  BROWSER_DRAG_FLUSH_MS,
  BROWSER_FPS,
  BROWSER_HOVER_MS,
  BROWSER_INPUT_BATCH,
  BROWSER_UNWATCH_DELAY_MS,
  type BrowserInputEvent,
  browserFps,
  browserHandoffOf,
  browserSiteUrl,
  browserSteps,
  clickEvents,
  createBrowserLiveConnection,
  createBrowserWatches,
  createTouchInput,
  dragEvent,
  fitFrame,
  frameMetadata,
  framePoint,
  handoffFuse,
  handoffTimeLeft,
  handoffWantsWords,
  inputProblem,
  jpegSize,
  keyboardEvents,
  keyEvents,
  modifiersOf,
  pagePoint,
  parseBrowserLiveMessage,
  pasteEvents,
  pressEvents,
  releaseEvent,
  usesBrowser,
  wheelEvent,
} from "../src/browser";
import { PASTE_MAX_BYTES, pasteBytes } from "../src/desktop";
import { toolActivity } from "../src/lib/activity";
import { shownAddress } from "../src/lib/sites";

const AGENT = "11111111-1111-4111-8111-111111111111";

function fakeTimers() {
  const pending: { fn: () => void; ms: number; id: number }[] = [];
  let next = 1;
  return {
    pending,
    timers: {
      setTimeout: (fn: () => void, ms: number) => {
        const id = next++;
        pending.push({ fn, ms, id });
        return id;
      },
      clearTimeout: (id: unknown) => {
        const i = pending.findIndex((p) => p.id === id);
        if (i >= 0) pending.splice(i, 1);
      },
    },
    run() {
      const all = pending.splice(0);
      for (const p of all) p.fn();
    },
  };
}

describe("agent browser input (ADR 0040)", () => {
  test("a click on the shown frame lands on the page, scaled to the viewport", () => {
    const meta = { deviceWidth: 1280, deviceHeight: 720 };
    expect(framePoint({ x: 320, y: 180 }, { width: 640, height: 360 }, meta)).toEqual({ x: 640, y: 360 });
    expect(framePoint({ x: 0, y: 0 }, { width: 640, height: 360 }, meta)).toEqual({ x: 0, y: 0 });
    // Outside the frame, or a frame with no size: nothing.
    expect(framePoint({ x: 700, y: 10 }, { width: 640, height: 360 }, meta)).toBeNull();
    expect(framePoint({ x: 1, y: 1 }, { width: 0, height: 360 }, meta)).toBeNull();
  });

  test("a frame fits a box without distortion, centered", () => {
    expect(fitFrame({ width: 1000, height: 1000 }, { deviceWidth: 1000, deviceHeight: 500 })).toEqual({
      width: 1000,
      height: 500,
      left: 0,
      top: 250,
    });
  });

  test("Command becomes Control unless the agent's computer is a Mac", () => {
    expect(modifiersOf({ metaKey: true }, false)).toBe(2);
    expect(modifiersOf({ metaKey: true }, true)).toBe(4);
    expect(modifiersOf({ shiftKey: true, altKey: true }, false)).toBe(9);
  });

  test("special keys and shortcuts go as keys; characters as text; modifiers alone not at all", () => {
    expect(keyEvents("Enter").map((e) => e.kind === "key" && [e.type, e.code])).toEqual([
      ["keyDown", "Enter"],
      ["keyUp", "Enter"],
    ]);
    expect(keyboardEvents({ key: "a", metaKey: true }, false)).toEqual(keyEvents("a", 2));
    expect(keyboardEvents({ key: "é" }, false)).toEqual([{ kind: "text", text: "é" }]);
    expect(keyboardEvents({ key: "Shift" }, false)).toBeNull();
    expect(clickEvents({ x: 5, y: 6 }).map((e) => e.kind === "mouse" && e.type)).toEqual([
      "mouseMoved",
      "mousePressed",
      "mouseReleased",
    ]);
  });

  test("a click on a letterboxed frame lands on the page; the bands around it don't", () => {
    // A 1280×720 page shown in a 1000×1000 box: drawn 1000×562.5, 218.75 px of band above and below.
    const meta = { deviceWidth: 1280, deviceHeight: 720 };
    const box = { left: 100, top: 50, width: 1000, height: 1000 };
    expect(pagePoint({ x: 100 + 500, y: 50 + 218.75 + 281.25 }, box, meta)).toEqual({ x: 640, y: 360 });
    expect(pagePoint({ x: 100, y: 50 + 218.75 }, box, meta)).toEqual({ x: 0, y: 0 });
    // In the band above the image: not on the page.
    expect(pagePoint({ x: 600, y: 60 }, box, meta)).toBeNull();
    // An element exactly the image's size (fill) maps straight.
    expect(pagePoint({ x: 420, y: 230 }, { left: 100, top: 50, width: 640, height: 360 }, meta, "fill")).toEqual({
      x: 640,
      y: 360,
    });
  });
});

/** What the page's mouse gets, short: "pressed@10,20", "moved+left@…", "wheel@…:dx,dy". */
const said = (events: BrowserInputEvent[]) =>
  events.map((e) =>
    e.kind !== "mouse"
      ? e.kind
      : e.type === "mouseWheel"
        ? `wheel@${e.x},${e.y}:${e.deltaX},${e.deltaY}`
        : `${e.type.replace("mouse", "").toLowerCase()}${e.type === "mouseMoved" ? `+${e.button}` : ""}@${e.x},${e.y}`,
  );

describe("dragging on the page (ADR 0040 §14)", () => {
  test("a press stays down until let go, and the moves between carry the button: the page sees a drag", () => {
    expect(
      said([...pressEvents({ x: 10, y: 20 }), dragEvent({ x: 60, y: 20 }), releaseEvent({ x: 60, y: 20 })]),
    ).toEqual(["moved+none@10,20", "pressed@10,20", "moved+left@60,20", "released@60,20"]);
    expect(pressEvents({ x: 1, y: 2 })[1]).toMatchObject({ button: "left", clickCount: 1 });
    expect(dragEvent({ x: 1, y: 2 }, 8)).toEqual({
      kind: "mouse",
      type: "mouseMoved",
      x: 1,
      y: 2,
      button: "left",
      modifiers: 8,
    });
    // A click is the same press, let go where it went down.
    expect(said(clickEvents({ x: 5, y: 6 }))).toEqual(["moved+none@5,6", "pressed@5,6", "released@5,6"]);
  });

  test("a drag that leaves the frame stays at its edge; a press there is off the page", () => {
    const meta = { deviceWidth: 1280, deviceHeight: 720 };
    const box = { left: 0, top: 0, width: 640, height: 360 };
    expect(pagePoint({ x: 700, y: 400 }, box, meta)).toBeNull();
    expect(pagePoint({ x: 700, y: 400 }, box, meta, "contain", true)).toEqual({ x: 1280, y: 720 });
    expect(pagePoint({ x: -20, y: 180 }, box, meta, "contain", true)).toEqual({ x: 0, y: 360 });
    expect(framePoint({ x: 320, y: -5 }, { width: 640, height: 360 }, meta, true)).toEqual({ x: 640, y: 0 });
  });
});

describe("fingers on the page (ADR 0040 §14)", () => {
  // A 640×360 page shown at half size, with 20 px of band above it: page = (frame - band) × 2.
  const toPage = (p: { x: number; y: number }, clamp: boolean) =>
    pagePoint(
      p,
      { left: 0, top: 0, width: 320, height: 220 },
      { deviceWidth: 640, deviceHeight: 360 },
      "contain",
      clamp,
    );

  test("a tap clicks where the finger landed, even after a small wiggle", () => {
    const touch = createTouchInput(toPage);
    expect(touch.down(1, { x: 50, y: 70 })).toEqual([]);
    expect(touch.move(1, { x: 53, y: 72 })).toEqual([]);
    expect(touch.mode).toBe("pending");
    expect(said(touch.up(1, { x: 53, y: 72 }))).toEqual(["moved+none@100,100", "pressed@100,100", "released@100,100"]);
    expect(touch.mode).toBe("idle");
  });

  test("a finger that moves drags from where it landed and lets go where it lifts, at the edge past it", () => {
    const touch = createTouchInput(toPage);
    touch.down(1, { x: 50, y: 70 });
    expect(said(touch.move(1, { x: 70, y: 70 }))).toEqual([
      "moved+none@100,100",
      "pressed@100,100",
      "moved+left@140,100",
    ]);
    expect(touch.mode).toBe("drag");
    expect(said(touch.move(1, { x: 200, y: 70 }))).toEqual(["moved+left@400,100"]);
    // Off the right of the frame: the drag stays at the page's edge, and lets go there.
    expect(said(touch.move(1, { x: 400, y: 70 }))).toEqual(["moved+left@640,100"]);
    expect(said(touch.up(1, { x: 420, y: 70 }))).toEqual(["released@640,100"]);
  });

  test("a slider captcha: a finger held still, then moved slowly 100 px right, drags the whole way, never scrolls", () => {
    const touch = createTouchInput(toPage);
    touch.down(1, { x: 50, y: 70 });
    // A long press: the finger rests, trembling within the slop.
    expect(touch.move(1, { x: 51, y: 70 })).toEqual([]);
    expect(touch.move(1, { x: 50, y: 71 })).toEqual([]);
    const out: string[] = [];
    for (let x = 51; x <= 150; x += 1) out.push(...said(touch.move(1, { x, y: 70 })));
    out.push(...said(touch.up(1, { x: 150, y: 70 })));
    expect(out.slice(0, 2)).toEqual(["moved+none@100,100", "pressed@100,100"]);
    expect(out.at(-1)).toBe("released@300,100");
    const moves = out.slice(2, -1);
    expect(moves.every((m) => m.startsWith("moved+left@"))).toBe(true);
    expect(moves.at(-1)).toBe("moved+left@300,100");
    expect(out.some((m) => m.startsWith("wheel"))).toBe(false);
  });

  test("two fingers scroll the page as they move, and nothing is pressed or clicked", () => {
    const touch = createTouchInput(toPage);
    touch.down(1, { x: 100, y: 150 });
    touch.down(2, { x: 200, y: 150 });
    expect(touch.mode).toBe("scroll");
    // Both fingers up by 30 px of the frame (60 of the page): the page scrolls down by 60, half per finger.
    expect(said(touch.move(1, { x: 100, y: 120 }))).toEqual(["wheel@300,230:0,30"]);
    expect(said(touch.move(2, { x: 200, y: 120 }))).toEqual(["wheel@300,200:0,30"]);
    expect(touch.up(1, { x: 100, y: 120 })).toEqual([]);
    // The finger left behind doesn't start a drag.
    expect(touch.move(2, { x: 260, y: 160 })).toEqual([]);
    expect(touch.up(2, { x: 260, y: 160 })).toEqual([]);
    expect(touch.mode).toBe("idle");
  });

  test("a finger on the band around the picture starts nothing; a drag taken away is let go where it was", () => {
    const touch = createTouchInput(toPage);
    touch.down(1, { x: 50, y: 5 });
    expect(touch.move(1, { x: 120, y: 90 })).toEqual([]);
    expect(touch.up(1, { x: 120, y: 90 })).toEqual([]);
    touch.down(3, { x: 50, y: 70 });
    touch.move(3, { x: 80, y: 70 });
    expect(said(touch.cancel())).toEqual(["released@160,100"]);
    expect(touch.mode).toBe("idle");
  });
});

describe("agent browser live connection (ADR 0040)", () => {
  test("watches, forwards its own frames and status, ignores other agents", () => {
    const sent: unknown[] = [];
    const frames: number[] = [];
    const statuses: string[] = [];
    const live = createBrowserLiveConnection({
      send: (f) => sent.push(f),
      agentId: AGENT,
      onFrame: (f) => frames.push(f.seq),
      onStatus: (s) => statuses.push(s.mode),
    });
    live.start();
    expect(sent).toEqual([{ type: "browser.watch", agentId: AGENT }]);
    live.handleMessage({
      type: "browser.frame",
      agentId: AGENT,
      seq: 3,
      data: "abc",
      metadata: { deviceWidth: 10, deviceHeight: 10 },
    });
    live.handleMessage({
      type: "browser.frame",
      agentId: "other",
      seq: 4,
      data: "abc",
      metadata: { deviceWidth: 10, deviceHeight: 10 },
    });
    live.handleMessage({
      type: "browser.status",
      agentId: AGENT,
      mode: "control",
      controllerUserId: "u1",
      handoff: null,
    });
    expect(frames).toEqual([3]);
    expect(statuses).toEqual(["control"]);
    live.close();
    expect(sent.at(-1)).toEqual({ type: "browser.unwatch", agentId: AGENT });
  });

  test("retries the watch with backoff while the computer is reconnecting; close stops it", () => {
    const sent: { type: string; agentId?: string }[] = [];
    const t = fakeTimers();
    const live = createBrowserLiveConnection({
      send: (f) => sent.push(f),
      agentId: AGENT,
      onFrame: () => {},
      onStatus: () => {},
      timers: t.timers,
      backoffMs: [100, 200],
    });
    live.start();
    live.handleMessage({ type: "browser.unavailable", agentId: AGENT, reason: "reconnecting" });
    expect(t.pending[0]?.ms).toBe(100);
    t.run();
    expect(sent.filter((f) => f.type === "browser.watch")).toHaveLength(2);
    live.handleMessage({ type: "browser.unavailable", agentId: AGENT, reason: "reconnecting" });
    expect(t.pending[0]?.ms).toBe(200);
    live.close();
    expect(t.pending).toHaveLength(0);
    // Forbidden never retries.
    const again = createBrowserLiveConnection({
      send: () => {},
      agentId: AGENT,
      onFrame: () => {},
      onStatus: () => {},
      timers: t.timers,
    });
    again.start();
    again.handleMessage({ type: "browser.unavailable", agentId: AGENT, reason: "forbidden" });
    expect(t.pending).toHaveLength(0);
    // Too many browsers watched on the socket: tried again the same way, for when another view leaves.
    const crowded = createBrowserLiveConnection({
      send: () => {},
      agentId: AGENT,
      onFrame: () => {},
      onStatus: () => {},
      timers: t.timers,
      backoffMs: [100],
    });
    crowded.start();
    crowded.handleMessage({ type: "error", agentId: AGENT, code: "too_many_browsers" });
    expect(t.pending[0]?.ms).toBe(100);
  });

  test("an ended stream (the browser closed) is watched again after a backoff; a stop we asked for isn't", () => {
    const sent: { type: string; agentId?: string }[] = [];
    const t = fakeTimers();
    const live = createBrowserLiveConnection({
      send: (f) => sent.push(f),
      agentId: AGENT,
      onFrame: () => {},
      onStatus: () => {},
      timers: t.timers,
      backoffMs: [100],
    });
    live.start();
    live.handleMessage({ type: "browser.ended", agentId: AGENT, reason: "stopped" });
    expect(t.pending).toHaveLength(0);
    live.handleMessage({ type: "browser.ended", agentId: AGENT, reason: "closed" });
    expect(t.pending[0]?.ms).toBe(100);
    t.run();
    expect(sent.filter((f) => f.type === "browser.watch")).toHaveLength(2);
    live.close();
  });

  test("a Parar says who pressed it and when", () => {
    const ended: unknown[] = [];
    const live = createBrowserLiveConnection({
      send: () => {},
      agentId: AGENT,
      onFrame: () => {},
      onStatus: () => {},
      onEnded: (...args) => ended.push(args),
      timers: fakeTimers().timers,
    });
    live.start();
    live.handleMessage({
      type: "browser.ended",
      agentId: AGENT,
      reason: "stopped",
      byUserId: "u-joao",
      at: "2026-10-20T12:00:00.000Z",
    });
    live.handleMessage({ type: "browser.ended", agentId: AGENT, reason: "closed" });
    expect(ended).toEqual([
      ["stopped", undefined, { userId: "u-joao", at: "2026-10-20T12:00:00.000Z" }],
      ["closed", undefined, undefined],
    ]);
    live.close();
  });

  test("input goes in batches the server accepts", () => {
    const sent: { events?: unknown[] }[] = [];
    const live = createBrowserLiveConnection({
      send: (f) => sent.push(f as { events?: unknown[] }),
      agentId: AGENT,
      onFrame: () => {},
      onStatus: () => {},
    });
    const events = Array.from({ length: BROWSER_INPUT_BATCH + 5 }, () => ({ kind: "text" as const, text: "a" }));
    expect(live.sendInput(events)).toBe(true);
    expect(sent.map((f) => f.events?.length)).toEqual([BROWSER_INPUT_BATCH, 5]);
    expect(live.sendInput([])).toBe(false);
    // A long paste: its pieces, one event's worth of text a frame (the server drops larger frames).
    sent.length = 0;
    const long = `${"x".repeat(9_999)}😀${"y".repeat(12_000)}\r\nfim`;
    const pieces = pasteEvents(long);
    expect(pieces.map((e) => (e as { text: string }).text.length)).toEqual([9_999, 10_000, 2_006]);
    expect(pieces.map((e) => (e as { text: string }).text).join("")).toBe(long.replace("\r\n", "\n"));
    live.sendInput(pieces);
    expect(sent.map((f) => f.events?.length)).toEqual([1, 1, 1]);
    expect(pasteEvents("")).toEqual([]);
    // The longest paste the apps send fits in the frames the server takes in a second (60), so none is dropped.
    expect(pasteBytes("x".repeat(PASTE_MAX_BYTES))).toBeGreaterThan(PASTE_MAX_BYTES);
    expect(pasteEvents("x".repeat(PASTE_MAX_BYTES)).length).toBeLessThan(60);
  });

  test("the address bar at rest: where the page is, as a browser shows it", () => {
    expect(shownAddress("https://www.google.com/search?q=test")).toBe("www.google.com/search?q=test");
    expect(shownAddress("https://loja.example.com/")).toBe("loja.example.com");
    expect(shownAddress("http://intranet:8080/a/")).toBe("intranet:8080/a/");
    expect(shownAddress("about:blank")).toBe("");
    expect(shownAddress(null)).toBe("");
  });

  test("messages are checked", () => {
    expect(parseBrowserLiveMessage({ type: "browser.frame", agentId: AGENT, seq: 1 })).toBeNull();
    expect(parseBrowserLiveMessage({ type: "error", agentId: AGENT, code: "forbidden" })).toEqual({
      type: "error",
      agentId: AGENT,
      code: "forbidden",
    });
  });

  test("a closed browser is its own reason, retried with backoff so the view picks it up once it opens", () => {
    expect(parseBrowserLiveMessage({ type: "browser.unavailable", agentId: AGENT, reason: "closed" })).toEqual({
      type: "browser.unavailable",
      agentId: AGENT,
      reason: "closed",
    });
    // A reason this app doesn't know yet reads as unavailable.
    expect(parseBrowserLiveMessage({ type: "browser.unavailable", agentId: AGENT, reason: "asleep" })).toMatchObject({
      reason: "unavailable",
    });
    const sent: { type: string }[] = [];
    const reasons: string[] = [];
    const t = fakeTimers();
    const live = createBrowserLiveConnection({
      send: (f) => sent.push(f),
      agentId: AGENT,
      onFrame: () => {},
      onStatus: () => {},
      onUnavailable: (reason) => reasons.push(reason),
      timers: t.timers,
      backoffMs: [100, 200],
    });
    live.start();
    live.handleMessage({ type: "browser.unavailable", agentId: AGENT, reason: "closed" });
    expect(reasons).toEqual(["closed"]);
    expect(t.pending[0]?.ms).toBe(100);
    t.run();
    expect(sent.filter((f) => f.type === "browser.watch")).toHaveLength(2);
    // As the server answers a watch: a status first, then the browser is still closed. The wait still grows.
    live.handleMessage({
      type: "browser.status",
      agentId: AGENT,
      mode: "watch",
      controllerUserId: null,
      handoff: null,
    });
    live.handleMessage({ type: "browser.unavailable", agentId: AGENT, reason: "closed" });
    expect(t.pending[0]?.ms).toBe(200);
    // It opened meanwhile (a person opened a site): the view works, so the retry is dropped.
    live.handleMessage({
      type: "browser.status",
      agentId: AGENT,
      mode: "control",
      controllerUserId: "u1",
      handoff: null,
    });
    expect(t.pending).toHaveLength(0);
    // Frames flow again: the next closed browser starts the wait over.
    live.handleMessage({
      type: "browser.frame",
      agentId: AGENT,
      seq: 1,
      data: "abc",
      metadata: { deviceWidth: 10, deviceHeight: 10 },
    });
    live.handleMessage({ type: "browser.unavailable", agentId: AGENT, reason: "closed" });
    expect(t.pending[0]?.ms).toBe(100);
    live.close();
  });

  test("a status says when someone else's control hides the page; a frame carries the tab's title", () => {
    expect(
      parseBrowserLiveMessage({
        type: "browser.status",
        agentId: AGENT,
        mode: "watch",
        controllerUserId: "u-ana",
        handoff: null,
        hidden: true,
      }),
    ).toMatchObject({ controllerUserId: "u-ana", hidden: true });
    // An older server says nothing: nothing is hidden.
    expect(
      parseBrowserLiveMessage({ type: "browser.status", agentId: AGENT, mode: "watch", controllerUserId: null }),
    ).toMatchObject({ hidden: false });
    expect(
      parseBrowserLiveMessage({
        type: "browser.frame",
        agentId: AGENT,
        seq: 1,
        data: "abc",
        metadata: { deviceWidth: 10, deviceHeight: 10, url: "https://shop.example.com/", title: "Loja" },
      }),
    ).toMatchObject({ metadata: { url: "https://shop.example.com/", title: "Loja" } });
  });
});

describe("agent browser requests (ADR 0040)", () => {
  const base = {
    id: "h1",
    agentId: AGENT,
    status: "pending",
    createdAt: "2026-10-19T10:00:00.000Z",
    expiresAt: "2026-10-19T10:10:00.000Z",
  };

  test("the card's request is read from the message meta", () => {
    expect(browserHandoffOf({ browserHandoff: base })?.id).toBe("h1");
    expect(browserHandoffOf({ browserHandoff: { id: 1 } })).toBeNull();
    expect(browserHandoffOf(null)).toBeNull();
  });

  test("time left and the fuse", () => {
    const now = new Date("2026-10-19T10:05:00.000Z").getTime();
    const t = ((key: string, o?: { count?: number }) => `${o?.count} ${key}`) as unknown as TFunction;
    expect(handoffTimeLeft(t, base, now)).toBe("5 format.inMinutes");
    expect(handoffFuse(base, now)).toBeCloseTo(0.5);
    expect(handoffTimeLeft(t, { expiresAt: null }, now)).toBeNull();
    expect(handoffTimeLeft(t, base, now + 6 * 60_000)).toBeNull();
  });

  test("the watching log keeps the browser calls only", () => {
    expect(
      browserSteps([
        { kind: "steer", messageId: "m1" },
        {
          kind: "call",
          id: "c1",
          tool: "browser_open",
          connector: null,
          detail: "shop.example",
          code: null,
          output: [],
          running: false,
        },
        {
          kind: "call",
          id: "c2",
          tool: "read_file",
          connector: null,
          detail: null,
          code: null,
          output: [],
          running: false,
        },
      ]).map((s) => s.tool),
    ).toEqual(["browser_open"]);
  });
});

describe("one watch per agent on a socket (no stream flapping)", () => {
  const live = (watcher: ReturnType<typeof createBrowserWatches>, sent: unknown[]) =>
    createBrowserLiveConnection({
      send: (f) => sent.push(f),
      watcher,
      agentId: AGENT,
      onFrame: () => {},
      onStatus: () => {},
    });

  test("views of the same agent share one watch; it ends a moment after the last leaves", () => {
    const sent: { type: string; agentId?: string }[] = [];
    const t = fakeTimers();
    const watches = createBrowserWatches({ send: (f) => sent.push(f), timers: t.timers });
    const card = live(watches, sent);
    const full = live(watches, sent);
    card.start();
    full.start();
    // Each view asks (so each hears the server's answer); the server keeps one watch per agent and socket.
    expect(sent).toEqual([
      { type: "browser.watch", agentId: AGENT },
      { type: "browser.watch", agentId: AGENT },
    ]);
    card.close();
    full.close();
    // Not yet: a view coming back meanwhile keeps the stream.
    expect(sent.filter((f) => f.type === "browser.unwatch")).toHaveLength(0);
    expect(t.pending[0]?.ms).toBe(BROWSER_UNWATCH_DELAY_MS);
    t.run();
    expect(sent.at(-1)).toEqual({ type: "browser.unwatch", agentId: AGENT });
    expect(watches.watching()).toEqual([]);
  });

  test("a remount (StrictMode, a re-render) never unwatches; it watches again, for the page it hasn't seen", () => {
    const sent: { type: string; agentId?: string }[] = [];
    const t = fakeTimers();
    const watches = createBrowserWatches({ send: (f) => sent.push(f), timers: t.timers });
    const first = live(watches, sent);
    first.start();
    first.close();
    const again = live(watches, sent);
    again.start();
    t.run();
    expect(sent.map((f) => f.type)).toEqual(["browser.watch", "browser.watch"]);
    expect(watches.watching()).toEqual([AGENT]);
    // After the socket comes back, every agent someone looks at is watched again, once.
    watches.resumeAll();
    expect(sent.filter((f) => f.type === "browser.watch")).toHaveLength(3);
    again.close();
  });

  test("a view that starts after another got the page (Abrir aqui, the computer dialog) gets it too", () => {
    const sent: { type: string }[] = [];
    const watches = createBrowserWatches({ send: (f) => sent.push(f) });
    const views: ReturnType<typeof createBrowserLiveConnection>[] = [];
    const seen: Record<"first" | "second", string[]> = { first: [], second: [] };
    const view = (name: "first" | "second") => {
      const v = createBrowserLiveConnection({
        send: (f) => sent.push(f),
        watcher: watches,
        agentId: AGENT,
        onFrame: () => seen[name].push("frame"),
        onStatus: () => seen[name].push("status"),
      });
      views.push(v);
      v.start();
    };
    /** The server's answer to each `browser.watch`, to every view on the socket: who is in control, the newest page. */
    let answered = 0;
    const serve = () => {
      for (; answered < sent.filter((f) => f.type === "browser.watch").length; answered++) {
        const status = { type: "browser.status", mode: "watch", controllerUserId: null, handoff: null, hidden: false };
        const frame = {
          type: "browser.frame",
          seq: 1,
          data: "/9j/",
          metadata: { deviceWidth: 1280, deviceHeight: 720 },
        };
        for (const m of [status, frame]) for (const v of views) v.handleMessage({ agentId: AGENT, ...m });
      }
    };
    view("first");
    serve();
    // The page isn't repainting: nothing else comes by itself.
    view("second");
    serve();
    expect(seen.second).toEqual(["status", "frame"]);
  });

  test("each view says the rate it needs: the socket asks for the most any of them needs, in place when it changes", () => {
    const sent: Record<string, unknown>[] = [];
    const t = fakeTimers();
    const watches = createBrowserWatches({ send: (f) => sent.push(f), timers: t.timers });
    // A closed card: one frame a second is all its small picture needs.
    const card = watches.acquire(AGENT, BROWSER_FPS.preview);
    expect(sent).toEqual([{ type: "browser.watch", agentId: AGENT, maxFps: 1 }]);
    // The open view: whatever the stream sends (no limit of its own, so none said).
    const open = watches.acquire(AGENT);
    expect(sent.at(-1)).toEqual({ type: "browser.watch", agentId: AGENT });
    // It folds into a preview too: said in place, never a new watch (that would restart the view).
    open.setMaxFps(BROWSER_FPS.preview);
    expect(sent.at(-1)).toEqual({ type: "browser.fps", agentId: AGENT, maxFps: 1 });
    // A change that leaves the most anyone needs as it was says nothing.
    card.setMaxFps(1);
    expect(sent).toHaveLength(3);
    open.setMaxFps(BROWSER_FPS.control);
    expect(sent.at(-1)).toEqual({ type: "browser.fps", agentId: AGENT, maxFps: 15 });
    // The view that needed the most leaves: the others' rate.
    open();
    expect(sent.at(-1)).toEqual({ type: "browser.fps", agentId: AGENT, maxFps: 1 });
    // Watched again (Try again, the socket back): with the rate needed now.
    watches.rewatch(AGENT);
    expect(sent.at(-1)).toEqual({ type: "browser.watch", agentId: AGENT, maxFps: 1 });
    watches.resumeAll();
    expect(sent.at(-1)).toEqual({ type: "browser.watch", agentId: AGENT, maxFps: 1 });
    card();
    t.run();
    expect(sent.at(-1)).toEqual({ type: "browser.unwatch", agentId: AGENT });
    // A view that left changes nothing.
    card.setMaxFps(BROWSER_FPS.control);
    expect(sent.at(-1)).toEqual({ type: "browser.unwatch", agentId: AGENT });
    // Out of range asks for what the server takes.
    expect([browserFps(0), browserFps(60), browserFps(undefined), browserFps(5)]).toEqual([1, 15, 15, 5]);
  });

  test("a live view passes its rate to the watch, and changes it in place, with a shared watcher or without", () => {
    const sent: Record<string, unknown>[] = [];
    const watches = createBrowserWatches({ send: (f) => sent.push(f) });
    const shared = createBrowserLiveConnection({
      send: (f) => sent.push(f),
      watcher: watches,
      agentId: AGENT,
      onFrame: () => {},
      onStatus: () => {},
      maxFps: BROWSER_FPS.preview,
    });
    shared.start();
    expect(sent).toEqual([{ type: "browser.watch", agentId: AGENT, maxFps: 1 }]);
    shared.setMaxFps(undefined);
    expect(sent.at(-1)).toEqual({ type: "browser.fps", agentId: AGENT, maxFps: 15 });
    shared.close();

    const own: Record<string, unknown>[] = [];
    const alone = createBrowserLiveConnection({
      send: (f) => own.push(f),
      agentId: AGENT,
      onFrame: () => {},
      onStatus: () => {},
    });
    // Not watching yet: the rate goes with the watch.
    alone.setMaxFps(BROWSER_FPS.preview);
    expect(own).toEqual([]);
    alone.start();
    expect(own).toEqual([{ type: "browser.watch", agentId: AGENT, maxFps: 1 }]);
    alone.setMaxFps(BROWSER_FPS.control);
    expect(own.at(-1)).toEqual({ type: "browser.fps", agentId: AGENT, maxFps: 15 });
    alone.close();
    alone.setMaxFps(BROWSER_FPS.preview);
    expect(own.at(-1)).toEqual({ type: "browser.unwatch", agentId: AGENT });
  });

  test("Try again watches again at once, after a retry was set for later", () => {
    const sent: { type: string }[] = [];
    const t = fakeTimers();
    const conn = createBrowserLiveConnection({
      send: (f) => sent.push(f),
      agentId: AGENT,
      onFrame: () => {},
      onStatus: () => {},
      timers: t.timers,
    });
    conn.start();
    conn.handleMessage({ type: "browser.unavailable", agentId: AGENT, reason: "unavailable" });
    expect(t.pending).toHaveLength(1);
    conn.retry();
    expect(sent.map((f) => f.type)).toEqual(["browser.watch", "browser.watch"]);
    expect(t.pending).toHaveLength(0);
  });
});

describe("input in bursts, not one message per event", () => {
  type Sent = { type: string; events?: { kind: string; type?: string; deltaY?: number; x?: number; at?: number }[] };
  const make = (t: ReturnType<typeof fakeTimers>, clock: { now: number }) => {
    const sent: Sent[] = [];
    const conn = createBrowserLiveConnection({
      send: (f) => sent.push(f as Sent),
      agentId: AGENT,
      onFrame: () => {},
      onStatus: () => {},
      timers: t.timers,
      now: () => clock.now,
    });
    return { sent, conn };
  };
  const at = (x: number) => ({ x, y: 1 });

  test("wheel ticks add up into one event per frame", () => {
    const t = fakeTimers();
    const { sent, conn } = make(t, { now: 0 });
    for (let i = 0; i < 10; i++) conn.sendInput([wheelEvent(at(i), 0, 10)]);
    expect(sent).toHaveLength(0);
    expect(t.pending[0]?.ms).toBe(BROWSER_DRAG_FLUSH_MS);
    t.run();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.events).toHaveLength(1);
    expect(sent[0]?.events?.[0]?.deltaY).toBe(100);
    expect(sent[0]?.events?.[0]?.x).toBe(9);
  });

  test("a drag's moves merge; the click after them goes at once, in order", () => {
    const t = fakeTimers();
    const { sent, conn } = make(t, { now: 0 });
    const move = (x: number) => ({
      kind: "mouse" as const,
      type: "mouseMoved" as const,
      button: "left" as const,
      ...at(x),
    });
    conn.sendInput([move(1)]);
    conn.sendInput([move(2)]);
    conn.sendInput([move(3)]);
    conn.sendInput(clickEvents(at(4)));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.events?.map((e) => `${e.type}:${e.x}`)).toEqual([
      "mouseMoved:3",
      "mouseMoved:4",
      "mousePressed:4",
      "mouseReleased:4",
    ]);
  });

  test("a click's hover move is sent with it, before the press, even right after another hover", () => {
    const t = fakeTimers();
    const clock = { now: 1000 };
    const { sent, conn } = make(t, clock);
    conn.sendInput([{ kind: "mouse", type: "mouseMoved", ...at(1) }]);
    clock.now += 5;
    conn.sendInput(clickEvents(at(7)));
    const types = sent.flatMap((s) => s.events?.map((e) => `${e.type}:${e.x}`) ?? []);
    expect(types.slice(-3)).toEqual(["mouseMoved:7", "mousePressed:7", "mouseReleased:7"]);
  });

  test("hovering sends the latest position at most every 66 ms", () => {
    const t = fakeTimers();
    const clock = { now: 1000 };
    const { sent, conn } = make(t, clock);
    const hover = (x: number) => ({ kind: "mouse" as const, type: "mouseMoved" as const, ...at(x) });
    conn.sendInput([hover(1)]);
    expect(sent).toHaveLength(1);
    clock.now += 10;
    conn.sendInput([hover(2)]);
    conn.sendInput([hover(3)]);
    expect(sent).toHaveLength(1);
    expect(t.pending[0]?.ms).toBe(BROWSER_HOVER_MS - 10);
    t.run();
    expect(sent).toHaveLength(2);
    expect(sent[1]?.events?.[0]?.x).toBe(3);
  });

  test("each mouse event says when it was made; a drag's merged moves keep the newest one's time", () => {
    const t = fakeTimers();
    const clock = { now: 1000 };
    const { sent, conn } = make(t, clock);
    conn.sendInput(pressEvents(at(1)));
    clock.now = 1010;
    conn.sendInput([dragEvent(at(2))]);
    clock.now = 1020;
    conn.sendInput([dragEvent(at(3))]);
    clock.now = 1030;
    conn.sendInput([releaseEvent(at(3)), ...keyEvents("Enter")]);
    expect(sent.flatMap((s) => s.events?.map((e) => `${e.type}:${e.at}`) ?? [])).toEqual([
      "mouseMoved:1000",
      "mousePressed:1000",
      "mouseMoved:1020",
      "mouseReleased:1030",
      "keyDown:undefined",
      "keyUp:undefined",
    ]);
  });

  test("closing drops what was still waiting", () => {
    const t = fakeTimers();
    const { sent, conn } = make(t, { now: 0 });
    conn.sendInput([wheelEvent(at(1), 0, 5)]);
    conn.close();
    t.run();
    expect(sent.filter((f) => f.type === "browser.input")).toHaveLength(0);
  });
});

describe("the agent is in its browser", () => {
  test("its current tool, or its latest call, is a browser tool (also through the computer's bridge)", () => {
    expect(usesBrowser({ tool: "browser_click" })).toBe(true);
    expect(usesBrowser({ tool: "mcp__agentes__browser_read" })).toBe(true);
    const call = (id: string, tool: string) => ({ kind: "call", id, tool, detail: null, running: false });
    expect(
      usesBrowser({ tool: null, work: [call("1", "browser_open"), { kind: "steer", messageId: "m1" }] as never }),
    ).toBe(true);
    expect(usesBrowser({ work: [call("1", "browser_open"), call("2", "run_code")] as never })).toBe(false);
    expect(usesBrowser({})).toBe(false);
  });

  test("the bar says 'usando o navegador', not 'consultando o browser'", () => {
    expect(toolActivity("browser_open")).toEqual({ kind: "browsing" });
    expect(toolActivity("mcp__agentes__browser_click")).toEqual({ kind: "browsing" });
  });
});

describe("the agent's site for the card", () => {
  test("a computer brain's prefixed calls are steps by their plain names; the site comes from the frame, else the latest open", () => {
    const steps = browserSteps([
      { kind: "call", id: "1", tool: "mcp__agentes__browser_open", detail: "acme.example", running: false },
      { kind: "call", id: "2", tool: "mcp__agentes__browser_click", detail: null, running: true },
    ] as never);
    expect(steps.map((s) => s.tool)).toEqual(["browser_open", "browser_click"]);
    expect(browserSiteUrl(null, steps)).toBe("acme.example");
    expect(browserSiteUrl("about:blank", steps)).toBe("acme.example");
    expect(browserSiteUrl("https://www.acme.example/pt", steps)).toBe("https://www.acme.example/pt");
    expect(browserSiteUrl(null, [])).toBeNull();
  });
});

describe("the frame's real size", () => {
  // A JPEG's start: SOI, then a start-of-frame segment with height 577 and width 1280.
  const jpeg = (width: number, height: number) =>
    btoa(
      String.fromCharCode(
        0xff,
        0xd8,
        0xff,
        0xc0,
        0x00,
        0x11,
        0x08,
        height >> 8,
        height & 255,
        width >> 8,
        width & 255,
        3,
        0,
        0,
        0,
      ),
    );

  test("reads the size from the picture", () => {
    expect(jpegSize(jpeg(1280, 577))).toEqual({ width: 1280, height: 577 });
    expect(jpegSize("not a jpeg")).toBeNull();
  });

  test("a stream that reports 720 for a 577-high page maps clicks to the page, not a quarter lower", () => {
    const meta = frameMetadata({ data: jpeg(1280, 577), metadata: { deviceWidth: 1280, deviceHeight: 720 } });
    expect(meta.deviceHeight).toBe(577);
    // The middle of a 640×288.5 picture is the middle of the page.
    expect(pagePoint({ x: 320, y: 144 }, { left: 0, top: 0, width: 640, height: 288.5 }, meta)).toEqual({
      x: 640,
      y: 288,
    });
  });
});

describe("handoffWantsWords", () => {
  test("a request that asks the person something, or to tell it something, opens the hand back with its note", () => {
    const ask = (instructions: string) => handoffWantsWords({ kind: "ask", instructions });
    expect(ask("Entrar no painel com a conta de teste")).toBe(false);
    expect(ask("Faça login no Stripe. Qual plano aparece?")).toBe(true);
    expect(ask("Entre no banco e me diga o saldo")).toBe(true);
    expect(ask("Sign in and let me know which plan shows")).toBe(true);
    expect(ask("Inicia sesión y dime el código")).toBe(true);
    expect(ask("ログインしてください。どのプランですか？")).toBe(true);
    // The person's own take over asked nothing.
    expect(handoffWantsWords({ kind: "takeover", instructions: "Qual?" })).toBe(false);
    expect(handoffWantsWords(null)).toBe(false);
  });
});

test("what a person's lost input says, by the server's code", () => {
  expect(inputProblem("input_failed")).toBe("browser.inCard.inputLost");
  expect(inputProblem("not_in_control")).toBe("browser.inCard.inputLost");
  expect(inputProblem("no_field")).toBe("browser.inCard.noField");
  expect(inputProblem("rate_limited")).toBeNull();
  expect(inputProblem(null)).toBeNull();
});

import { expect, test } from "bun:test";
import type { StreamSocket } from "../../runner/browser";
import { type CrashedPage, countChromeTraffic, emulationCommands } from "../../runner/browser-traffic";

/** Chrome's end of the counter's DevTools socket: what the counter sent, and events pushed to it. */
class FakeCdp implements StreamSocket {
  readonly sent: { id: number; method: string; params: Record<string, unknown>; sessionId?: string }[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
    this.onclose?.();
  }
  event(method: string, params: Record<string, unknown>, sessionId?: string) {
    this.onmessage?.({ data: JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) }) });
  }
  reply(id: number, result: Record<string, unknown> = {}) {
    this.onmessage?.({ data: JSON.stringify({ id, result }) });
  }
  attach(sessionId: string, type = "page") {
    this.event("Target.attachedToTarget", {
      sessionId,
      targetInfo: { targetId: `t-${sessionId}`, type, url: "" },
      waitingForDebugger: false,
    });
  }
}

function counter(onCrash?: (page: CrashedPage) => void) {
  let cdp: FakeCdp | undefined;
  const c = countChromeTraffic(
    "ws://127.0.0.1:9222/devtools/browser/abc",
    (url) => {
      cdp = new FakeCdp(url);
      return cdp;
    },
    onCrash,
  );
  if (!cdp) throw new Error("no socket");
  return { c, cdp };
}

const AUTO_ATTACH = {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
  filter: [{ type: "browser_ui", exclude: true }, { type: "tab", exclude: true }, {}],
};
/** Under a target: never the service and shared workers the browser level already attached (counted once). */
const RELATED = {
  ...AUTO_ATTACH,
  filter: [{ type: "service_worker", exclude: true }, { type: "shared_worker", exclude: true }, {}],
};

test("one socket to the browser endpoint: auto-attach without pausing, then network events with no bodies on every session", async () => {
  const { c, cdp } = counter();
  expect(cdp.url).toBe("ws://127.0.0.1:9222/devtools/browser/abc");
  let attached = false;
  void c.attached.then(() => {
    attached = true;
  });
  cdp.onopen?.();
  expect(cdp.sent).toEqual([{ id: 1, method: "Target.setAutoAttach", params: AUTO_ATTACH }]);
  await Bun.sleep(5);
  expect(attached).toBe(false);
  cdp.reply(1);
  await c.attached;
  // A page, then a frame and a worker inside it: each gets the same, on its own session.
  cdp.attach("page-1");
  cdp.event(
    "Target.attachedToTarget",
    { sessionId: "frame-1", targetInfo: { type: "iframe" }, waitingForDebugger: false },
    "page-1",
  );
  cdp.attach("worker-1", "worker");
  const network = { maxPostDataSize: 1, maxResourceBufferSize: 1, maxTotalBufferSize: 1 };
  expect(cdp.sent.slice(1).map(({ method, params, sessionId }) => ({ method, params, sessionId }))).toEqual([
    { method: "Network.enable", params: network, sessionId: "page-1" },
    { method: "Target.setAutoAttach", params: RELATED, sessionId: "page-1" },
    { method: "Network.enable", params: network, sessionId: "frame-1" },
    { method: "Target.setAutoAttach", params: RELATED, sessionId: "frame-1" },
    { method: "Network.enable", params: network, sessionId: "worker-1" },
    { method: "Target.setAutoAttach", params: RELATED, sessionId: "worker-1" },
  ]);
  // It never resumes or pauses a target, and asks for nothing else.
  expect(new Set(cdp.sent.map((m) => m.method))).toEqual(new Set(["Target.setAutoAttach", "Network.enable"]));
  expect(cdp.sent.every((m) => m.method !== "Network.enable" || m.sessionId)).toBe(true);
});

test("received: each finished response's encoded size; a failed one, what had arrived; never below zero", () => {
  const { c, cdp } = counter();
  cdp.onopen?.();
  cdp.attach("p");
  cdp.event("Network.responseReceived", { requestId: "r1", response: { status: 200 } }, "p");
  cdp.event("Network.dataReceived", { requestId: "r1", dataLength: 9000, encodedDataLength: 4000 }, "p");
  cdp.event("Network.loadingFinished", { requestId: "r1", encodedDataLength: 4321 }, "p");
  cdp.event("Network.dataReceived", { requestId: "r2", encodedDataLength: 700 }, "p");
  cdp.event("Network.dataReceived", { requestId: "r2", encodedDataLength: 300 }, "p");
  cdp.event("Network.loadingFailed", { requestId: "r2", errorText: "net::ERR_ABORTED" }, "p");
  // A component extension's worker says -1.
  cdp.event("Network.loadingFinished", { requestId: "r3", encodedDataLength: -1 }, "p");
  cdp.event("Network.dataReceived", { requestId: "r4", encodedDataLength: -50 }, "p");
  cdp.event("Network.loadingFailed", { requestId: "r4" }, "p");
  expect(c.take()).toEqual({ up: 0, down: 5321 });
  // Taken: the next take starts from zero.
  expect(c.take()).toEqual({ up: 0, down: 0 });
});

test("sent: each request's headers as lines, plus the body its Content-Length says", () => {
  const { c, cdp } = counter();
  cdp.onopen?.();
  cdp.attach("p");
  cdp.event(
    "Network.requestWillBeSentExtraInfo",
    {
      requestId: "r1",
      headers: { ":method": "POST", "content-type": "application/octet-stream", "Content-Length": "2000000" },
    },
    "p",
  );
  cdp.event("Network.requestWillBeSentExtraInfo", { requestId: "r2", headers: { accept: "*/*" } }, "p");
  const lines = (h: Record<string, string>) =>
    Object.entries(h).reduce((n, [k, v]) => n + Buffer.byteLength(k) + Buffer.byteLength(v) + 4, 0);
  expect(c.take()).toEqual({
    up:
      lines({ ":method": "POST", "content-type": "application/octet-stream", "Content-Length": "2000000" }) +
      2_000_000 +
      lines({ accept: "*/*" }),
    down: 0,
  });
});

test("a response a service worker served counts nothing: the worker's own fetch is counted on its target", () => {
  const { c, cdp } = counter();
  cdp.onopen?.();
  cdp.attach("page");
  cdp.attach("sw", "service_worker");
  // The worker fetches from the network…
  cdp.event("Network.responseReceived", { requestId: "w1", response: { fromServiceWorker: false } }, "sw");
  cdp.event("Network.loadingFinished", { requestId: "w1", encodedDataLength: 10_000 }, "sw");
  // …and answers the page from it.
  cdp.event("Network.responseReceived", { requestId: "p1", response: { fromServiceWorker: true } }, "page");
  cdp.event("Network.dataReceived", { requestId: "p1", encodedDataLength: 10_000 }, "page");
  cdp.event("Network.loadingFinished", { requestId: "p1", encodedDataLength: 10_200 }, "page");
  cdp.event("Network.responseReceived", { requestId: "p2", response: { fromServiceWorker: true } }, "page");
  cdp.event("Network.dataReceived", { requestId: "p2", encodedDataLength: 800 }, "page");
  cdp.event("Network.loadingFailed", { requestId: "p2" }, "page");
  expect(c.take()).toEqual({ up: 0, down: 10_000 });
});

test("WebSocket frames: their payload, text as UTF-8 and binary as decoded bytes", () => {
  const { c, cdp } = counter();
  cdp.onopen?.();
  cdp.attach("p");
  const frame = (opcode: number, payloadData: string) => ({
    requestId: "ws",
    response: { opcode, mask: false, payloadData },
  });
  cdp.event("Network.webSocketFrameSent", frame(1, "olá"), "p");
  cdp.event("Network.webSocketFrameReceived", frame(1, "ação ✓"), "p");
  cdp.event("Network.webSocketFrameReceived", frame(2, Buffer.alloc(10, 7).toString("base64")), "p");
  cdp.event("Network.webSocketFrameSent", frame(2, Buffer.alloc(3).toString("base64")), "p");
  // A close or a ping isn't payload.
  cdp.event("Network.webSocketFrameReceived", frame(8, "AAA="), "p");
  expect(c.take()).toEqual({ up: Buffer.byteLength("olá") + 3, down: Buffer.byteLength("ação ✓") + 10 });
});

test("a detached session drops what it had in flight; garbage and unknown events are ignored", () => {
  const { c, cdp } = counter();
  cdp.onopen?.();
  cdp.attach("p");
  cdp.event("Network.dataReceived", { requestId: "r1", encodedDataLength: 500 }, "p");
  cdp.event("Target.detachedFromTarget", { sessionId: "p", targetId: "t-p" });
  // Whatever still came for it finds nothing kept.
  cdp.event("Network.loadingFailed", { requestId: "r1" }, "p");
  for (const data of ["not json", "[1,2]", "null", JSON.stringify({ method: "Network.loadingFinished" }), 42]) {
    cdp.onmessage?.({ data });
  }
  cdp.event("Network.loadingFinished", { requestId: 5, encodedDataLength: "lots" }, "p");
  cdp.event("Network.requestWillBeSentExtraInfo", { requestId: "x", headers: "accept: */*" }, "p");
  cdp.event("Page.frameNavigated", { frame: { url: "https://example.com" } }, "p");
  expect(c.take()).toEqual({ up: 0, down: 0 });
});

test("a tab whose page died: said once per crash, opened again at its address by a fresh visit, or shown another page", () => {
  const crashes: CrashedPage[] = [];
  const { cdp } = counter((page) => crashes.push(page));
  cdp.onopen?.();
  cdp.reply(1);
  cdp.attach("tab");
  // A frame inside it, and a worker: their renderers dying isn't the tab's page dying.
  cdp.event("Target.attachedToTarget", { sessionId: "frame", targetInfo: { targetId: "f", type: "iframe" } }, "tab");
  cdp.attach("worker", "worker");
  cdp.event("Inspector.targetCrashed", {}, "frame");
  cdp.event("Inspector.targetCrashed", {}, "worker");
  cdp.event("Inspector.targetCrashed", {});
  expect(crashes).toEqual([]);
  cdp.event("Inspector.targetCrashed", {}, "tab");
  expect(crashes.map((p) => p.targetId)).toEqual(["t-tab"]);
  const asked = () => cdp.sent.filter((m) => m.method.startsWith("Page."));

  // Opened again at the address it was on, found in its history: a form's answer is fetched, never posted again.
  crashes[0]?.reopen();
  const history = asked().at(-1);
  expect(history).toMatchObject({ method: "Page.getNavigationHistory", params: {}, sessionId: "tab" });
  const entries = [
    { id: 1, url: "https://shop.example/cart", title: "Cart" },
    { id: 2, url: "https://shop.example/order", title: "Order" },
  ];
  cdp.reply(history?.id ?? 0, { currentIndex: 1, entries });
  expect(asked().at(-1)).toMatchObject({
    method: "Page.navigate",
    params: { url: "https://shop.example/order" },
    sessionId: "tab",
  });
  // A history it can't read opens nothing.
  crashes[0]?.reopen();
  cdp.reply(asked().at(-1)?.id ?? 0, { currentIndex: 5, entries });
  expect(asked().at(-1)?.method).toBe("Page.getNavigationHistory");

  crashes[0]?.show("data:text/html,notice");
  expect(asked().at(-1)).toMatchObject({
    method: "Page.navigate",
    params: { url: "data:text/html,notice" },
    sessionId: "tab",
  });
  // Gone: its crash isn't anyone's anymore.
  cdp.event("Target.detachedFromTarget", { sessionId: "tab", targetId: "t-tab" });
  cdp.event("Inspector.targetCrashed", {}, "tab");
  expect(crashes).toHaveLength(1);
});

test("a socket that fails or closes settles the attach and keeps what was counted", async () => {
  const { c, cdp } = counter();
  cdp.onopen?.();
  cdp.attach("p");
  cdp.event("Network.loadingFinished", { requestId: "r", encodedDataLength: 77 }, "p");
  cdp.onerror?.();
  await c.attached;
  c.close();
  expect(cdp.closed).toBe(true);
  expect(c.take()).toEqual({ up: 0, down: 77 });
  // A socket that can't even be made counts nothing and doesn't hold anyone up.
  const broken = countChromeTraffic("ws://127.0.0.1:1/devtools/browser/x", () => {
    throw new Error("no sockets here");
  });
  await broken.attached;
  expect(broken.take()).toEqual({ up: 0, down: 0 });
  broken.close();
});

test("the GET guard (ADR 0144): only while armed, every session's requests pause; one carrying the value fails", async () => {
  const { c, cdp } = counter();
  cdp.onopen?.();
  cdp.reply(1);
  await c.attached;
  cdp.attach("page-1");
  const sent = (method: string) => cdp.sent.filter((m) => m.method === method);
  // Not armed: nothing pauses.
  expect(sent("Fetch.enable")).toEqual([]);
  let blocked = 0;
  c.guard(["hunter2-guarded value"], 60, () => {
    blocked++;
  });
  expect(sent("Fetch.enable").map((m) => m.sessionId)).toEqual(["page-1"]);
  // A frame that opens meanwhile is guarded too.
  cdp.event("Target.attachedToTarget", { sessionId: "frame-1", targetInfo: { type: "iframe" } }, "page-1");
  expect(sent("Fetch.enable").map((m) => m.sessionId)).toEqual(["page-1", "frame-1"]);
  const pause = (requestId: string, url: string, sessionId = "page-1") =>
    cdp.event("Fetch.requestPaused", { requestId, request: { url } }, sessionId);
  pause("a", `https://shop.example/?${new URLSearchParams({ pw: "hunter2-guarded value" })}`);
  pause("b", `https://evil.example/c?d=${encodeURIComponent("hunter2-guarded value")}`, "frame-1");
  pause("c", "https://shop.example/app.js");
  expect(sent("Fetch.failRequest")).toEqual([
    expect.objectContaining({ sessionId: "page-1", params: { requestId: "a", errorReason: "BlockedByClient" } }),
    expect.objectContaining({ sessionId: "frame-1", params: { requestId: "b", errorReason: "BlockedByClient" } }),
  ]);
  expect(sent("Fetch.continueRequest")).toEqual([
    expect.objectContaining({ sessionId: "page-1", params: { requestId: "c" } }),
  ]);
  expect(blocked).toBe(2);
  // Its time over: every session lets go, and a request paused just then still goes on.
  await Bun.sleep(100);
  expect(sent("Fetch.disable").map((m) => m.sessionId)).toEqual(["page-1", "frame-1"]);
  pause("d", `https://shop.example/?pw=${encodeURIComponent("hunter2-guarded value")}`);
  expect(sent("Fetch.continueRequest").map((m) => (m.params as { requestId: string }).requestId)).toEqual(["c", "d"]);
  expect(blocked).toBe(2);
  // A value too short to tell apart from ordinary addresses arms nothing.
  c.guard(["123"], 60, () => {});
  expect(sent("Fetch.enable")).toHaveLength(2);
  c.close();
});

test("the GET guard is ready only once Chrome answered Fetch.enable on every session; released, it lets go", async () => {
  const { c, cdp } = counter();
  cdp.onopen?.();
  cdp.reply(1);
  await c.attached;
  cdp.attach("page-1");
  cdp.event("Target.attachedToTarget", { sessionId: "frame-1", targetInfo: { type: "iframe" } }, "page-1");
  cdp.event("Target.attachedToTarget", { sessionId: "worker-1", targetInfo: { type: "shared_worker" } }, "page-1");
  const sent = (method: string) => cdp.sent.filter((m) => m.method === method);
  let ready: boolean | null = null;
  const first = c.guard(["hunter2-first value"], 60_000, () => {});
  void first.ready.then((ok) => {
    ready = ok;
  });
  const [page, frame, worker] = sent("Fetch.enable");
  expect([page?.sessionId, frame?.sessionId, worker?.sessionId]).toEqual(["page-1", "frame-1", "worker-1"]);
  cdp.reply(page?.id ?? 0);
  // A session that went away answers with an error: nothing is left there to pause.
  cdp.event("Target.detachedFromTarget", { sessionId: "worker-1" });
  cdp.onmessage?.({ data: JSON.stringify({ id: worker?.id, error: { code: -32001, message: "Session not found" } }) });
  await Bun.sleep(5);
  // One session still paused nothing: not ready, so nothing may be typed yet.
  expect(ready).toBeNull();
  cdp.reply(frame?.id ?? 0);
  expect(await first.ready).toBe(true);
  // Armed again meanwhile: ready at once, nothing asked of Chrome again.
  const second = c.guard(["hunter2-second value"], 60_000, () => {});
  expect(await second.ready).toBe(true);
  expect(sent("Fetch.enable")).toHaveLength(3);
  // A fill that was refused takes its value back out; the other stays guarded.
  second.release();
  const pause = (requestId: string, value: string) =>
    cdp.event("Fetch.requestPaused", { requestId, request: { url: `https://shop.example/?pw=${value}` } }, "page-1");
  pause("a", encodeURIComponent("hunter2-second value"));
  pause("b", encodeURIComponent("hunter2-first value"));
  const ids = (method: string) => sent(method).map((m) => (m.params as { requestId: string }).requestId);
  expect(ids("Fetch.continueRequest")).toEqual(["a"]);
  expect(ids("Fetch.failRequest")).toEqual(["b"]);
  expect(sent("Fetch.disable")).toEqual([]);
  // The last one released: every session lets go at once.
  first.release();
  expect(sent("Fetch.disable").map((m) => m.sessionId)).toEqual(["page-1", "frame-1"]);
  c.close();
});

test("a guard Chrome doesn't confirm isn't ready (after a while, or once the socket closes); the next one asks again", async () => {
  const { c, cdp } = counter();
  cdp.onopen?.();
  cdp.reply(1);
  await c.attached;
  cdp.attach("page-1");
  const enables = () => cdp.sent.filter((m) => m.method === "Fetch.enable");
  expect(await c.guard(["hunter2-slow chrome"], 60_000, () => {}, 20).ready).toBe(false);
  const again = c.guard(["hunter2-slow chrome"], 60_000, () => {}, 1_000);
  expect(enables()).toHaveLength(2);
  cdp.reply(enables()[1]?.id ?? 0);
  expect(await again.ready).toBe(true);
  c.close();

  const other = counter();
  other.cdp.onopen?.();
  other.cdp.reply(1);
  await other.c.attached;
  other.cdp.attach("page-1");
  const waiting = other.c.guard(["hunter2-closing chrome"], 60_000, () => {}, 60_000);
  other.cdp.close();
  expect(await waiting.ready).toBe(false);
  // Closed: never ready again.
  expect(await other.c.guard(["hunter2-after close"], 60_000, () => {}).ready).toBe(false);
});

test("a session that answers Fetch.enable with an error isn't paused: the guard isn't ready, and the next one asks it again", async () => {
  const { c, cdp } = counter();
  cdp.onopen?.();
  cdp.reply(1);
  await c.attached;
  cdp.attach("page-1");
  cdp.event("Target.attachedToTarget", { sessionId: "frame-1", targetInfo: { type: "iframe" } }, "page-1");
  const enables = () => cdp.sent.filter((m) => m.method === "Fetch.enable");
  const first = c.guard(["hunter2-refused fetch"], 60_000, () => {});
  const [page, frame] = enables();
  cdp.reply(page?.id ?? 0);
  // Still attached, so its requests would leave unchecked: nothing may be typed (the runner says `unguarded`).
  cdp.onmessage?.({ data: JSON.stringify({ id: frame?.id, error: { code: -32000, message: "Fetch unavailable" } }) });
  expect(await first.ready).toBe(false);
  // The next guard asks that session again (the page stays paused, not asked twice).
  const again = c.guard(["hunter2-refused fetch"], 60_000, () => {});
  expect(enables().map((m) => m.sessionId)).toEqual(["page-1", "frame-1", "frame-1"]);
  cdp.reply(enables()[2]?.id ?? 0);
  expect(await again.ready).toBe(true);
  c.close();
});

test("a dedicated worker has no Fetch of its own and doesn't hold the guard back: its requests pause on its page", async () => {
  const { c, cdp } = counter();
  cdp.onopen?.();
  cdp.reply(1);
  await c.attached;
  cdp.attach("page-1");
  cdp.event("Target.attachedToTarget", { sessionId: "worker-1", targetInfo: { type: "worker" } }, "page-1");
  const enables = () => cdp.sent.filter((m) => m.method === "Fetch.enable");
  const guard = c.guard(["hunter2-page with a worker"], 60_000, () => {});
  for (const m of enables()) {
    const noFetch = m.sessionId === "worker-1";
    cdp.onmessage?.({
      data: JSON.stringify(
        noFetch
          ? { id: m.id, error: { code: -32601, message: "'Fetch.enable' wasn't found" } }
          : { id: m.id, result: {} },
      ),
    });
  }
  expect(await guard.ready).toBe(true);
  // One that opens while the guard is armed isn't asked either.
  cdp.event("Target.attachedToTarget", { sessionId: "worker-2", targetInfo: { type: "worker" } }, "page-1");
  expect(enables().map((m) => m.sessionId)).toEqual(["page-1"]);
  c.close();
});

test("a session attached after a guard was ready: the next guard waits for its Fetch.enable too", async () => {
  const { c, cdp } = counter();
  cdp.onopen?.();
  cdp.reply(1);
  await c.attached;
  cdp.attach("page-1");
  const enables = () => cdp.sent.filter((m) => m.method === "Fetch.enable");
  const first = c.guard(["hunter2-first fill"], 60_000, () => {});
  cdp.reply(enables()[0]?.id ?? 0);
  expect(await first.ready).toBe(true);
  // A frame opens while the guard is armed: paused like the rest, but Chrome hasn't said so yet.
  cdp.event("Target.attachedToTarget", { sessionId: "frame-1", targetInfo: { type: "iframe" } }, "page-1");
  expect(enables().map((m) => m.sessionId)).toEqual(["page-1", "frame-1"]);
  let ready: boolean | null = null;
  const second = c.guard(["hunter2-second fill"], 60_000, () => {});
  void second.ready.then((ok) => {
    ready = ok;
  });
  await Bun.sleep(5);
  expect(ready).toBeNull();
  // Nothing asked twice: the frame's own acknowledgement is what it waits for.
  expect(enables()).toHaveLength(2);
  cdp.reply(enables()[1]?.id ?? 0);
  expect(await second.ready).toBe(true);
  c.close();
});

test("a page size holds on every tab, new ones too, on the counter's own sessions; null ends it on each", async () => {
  const { c, cdp } = counter();
  cdp.onopen?.();
  cdp.reply(1);
  await c.attached;
  cdp.attach("page-1");
  const phone = emulationCommands({ device: "phone", width: 390, height: 844 }, "156.0.8078.79");
  const before = cdp.sent.length;
  c.emulate(phone);
  const on = (sessionId: string, from: number) =>
    cdp.sent
      .slice(from)
      .filter((m) => m.sessionId === sessionId && m.method.startsWith("Emulation."))
      .map((m) => ({ method: m.method, params: m.params }));
  expect(on("page-1", before)).toEqual(phone);
  // A frame inside the page takes its page's size: nothing of its own.
  const frameAt = cdp.sent.length;
  cdp.event(
    "Target.attachedToTarget",
    { sessionId: "frame-1", targetInfo: { type: "iframe" }, waitingForDebugger: false },
    "page-1",
  );
  expect(on("frame-1", frameAt)).toEqual([]);
  // A tab that opens later gets it as it attaches.
  const tabAt = cdp.sent.length;
  cdp.attach("page-2");
  expect(on("page-2", tabAt)).toEqual(phone);
  const clearAt = cdp.sent.length;
  c.emulate(null);
  const cleared = [
    { method: "Emulation.clearDeviceMetricsOverride", params: {} },
    { method: "Emulation.setTouchEmulationEnabled", params: { enabled: false } },
    { method: "Emulation.setUserAgentOverride", params: { userAgent: "" } },
  ];
  expect(on("page-1", clearAt)).toEqual(cleared);
  expect(on("page-2", clearAt)).toEqual(cleared);
  const laterAt = cdp.sent.length;
  cdp.attach("page-3");
  expect(on("page-3", laterAt)).toEqual([]);
});

test("a phone is mobile with touch and Chrome on Android of the same version; a desktop size changes the size alone", () => {
  const [metrics, touch, agent] = emulationCommands({ device: "phone", width: 390, height: 844 }, "156.0.8078.79");
  expect(metrics).toEqual({
    method: "Emulation.setDeviceMetricsOverride",
    params: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true, screenWidth: 390, screenHeight: 844 },
  });
  expect(touch).toEqual({ method: "Emulation.setTouchEmulationEnabled", params: { enabled: true, maxTouchPoints: 5 } });
  expect(agent?.params.userAgent).toBe(
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36",
  );
  expect(agent?.params.userAgentMetadata).toMatchObject({ platform: "Android", mobile: true });
  // A tablet: Android without "Mobile", its own pixel ratio.
  const tablet = emulationCommands({ device: "tablet", width: 820, height: 1180 }, "156.0.8078.79");
  expect(tablet[0]?.params).toMatchObject({ deviceScaleFactor: 2, mobile: true });
  expect(String(tablet[2]?.params.userAgent)).not.toContain("Mobile");
  expect(tablet[2]?.params.userAgentMetadata).toMatchObject({ mobile: false });
  // A desktop size: the screen's own pixel ratio, no touch, the user agent Chrome started with.
  expect(emulationCommands({ device: "desktop", width: 1440, height: 900 }, "156.0.8078.79")).toEqual([
    {
      method: "Emulation.setDeviceMetricsOverride",
      params: { width: 1440, height: 900, deviceScaleFactor: 0, mobile: false, screenWidth: 1440, screenHeight: 900 },
    },
    { method: "Emulation.setTouchEmulationEnabled", params: { enabled: false } },
    { method: "Emulation.setUserAgentOverride", params: { userAgent: "" } },
  ]);
  // Chrome's version unknown: the size and touch, never a made-up version.
  const unknown = emulationCommands({ device: "phone", width: 390, height: 844 }, null);
  expect(unknown[2]).toEqual({ method: "Emulation.setUserAgentOverride", params: { userAgent: "" } });
});

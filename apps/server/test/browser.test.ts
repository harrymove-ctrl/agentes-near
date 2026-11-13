import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BROWSER_VIEW, decodeBrowserFrame, type MachineRequest } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import { BROWSER_SCOPE, grantScopes, MachineRequestError } from "@agenteschat/engine";
import {
  createViewerPacer,
  FRAME_RENEW_MS,
  fpsInterval,
  parseBrowserClientFrame,
  parseFrameSocketMessage,
} from "../src/realtime/browser";
import { parseClientFrame } from "../src/realtime/ws";
import { browser, createTestServer, listen, ORIGIN, pairComputer, seedOrg, signUp, type TestServer } from "./harness";

const AGENT = "0193a2b4-0000-7000-8000-000000000000";

describe("parseBrowserClientFrame: frame windows", () => {
  test("a watch says whether the client answers frames; an ack names the agent", () => {
    expect(parseBrowserClientFrame(JSON.stringify({ type: "browser.watch", agentId: AGENT, acks: true }))).toEqual({
      type: "browser.watch",
      agentId: AGENT,
      acks: true,
    });
    // Only `true` asks for a window: an older client's watch gets frames as before.
    expect(parseBrowserClientFrame(JSON.stringify({ type: "browser.watch", agentId: AGENT, acks: "yes" }))).toEqual({
      type: "browser.watch",
      agentId: AGENT,
    });
    expect(parseBrowserClientFrame(JSON.stringify({ type: "browser.ack", agentId: AGENT, seq: 4 }))).toEqual({
      type: "browser.ack",
      agentId: AGENT,
    });
    expect(parseBrowserClientFrame(JSON.stringify({ type: "browser.ack", agentId: "dev" }))).toBeNull();
    // Frames on their own socket come in a window: only with acks.
    expect(
      parseBrowserClientFrame(JSON.stringify({ type: "browser.watch", agentId: AGENT, acks: true, frames: true })),
    ).toEqual({ type: "browser.watch", agentId: AGENT, acks: true, frames: true });
    expect(parseBrowserClientFrame(JSON.stringify({ type: "browser.watch", agentId: AGENT, frames: true }))).toEqual({
      type: "browser.watch",
      agentId: AGENT,
    });
    // A frame socket takes only an ack.
    expect(parseFrameSocketMessage('{"type":"ack"}')).toEqual({ type: "ack" });
    expect(parseFrameSocketMessage('{"type":"input"}')).toBeNull();
    expect(parseFrameSocketMessage(Buffer.from('{"type":"ack"}'))).toBeNull();
  });

  test("a rate: on a watch with acks and on its own, kept within 1..15; a renew names the agent", () => {
    const watch = (extra: Record<string, unknown>) =>
      parseBrowserClientFrame(JSON.stringify({ type: "browser.watch", agentId: AGENT, acks: true, ...extra }));
    expect(watch({ maxFps: 1 })).toEqual({ type: "browser.watch", agentId: AGENT, acks: true, maxFps: 1 });
    expect(watch({ maxFps: 60 })).toMatchObject({ maxFps: 15 });
    expect(watch({ maxFps: 0 })).toMatchObject({ maxFps: 1 });
    expect(watch({ maxFps: "5" })).toEqual({ type: "browser.watch", agentId: AGENT, acks: true });
    // An app that answers no frames gets the old rate whatever it asks.
    expect(parseBrowserClientFrame(JSON.stringify({ type: "browser.watch", agentId: AGENT, maxFps: 15 }))).toEqual({
      type: "browser.watch",
      agentId: AGENT,
    });
    expect(parseBrowserClientFrame(JSON.stringify({ type: "browser.fps", agentId: AGENT, maxFps: 2.5 }))).toEqual({
      type: "browser.fps",
      agentId: AGENT,
      maxFps: 2.5,
    });
    expect(parseBrowserClientFrame(JSON.stringify({ type: "browser.fps", agentId: AGENT, maxFps: 99 }))).toMatchObject({
      maxFps: 15,
    });
    expect(parseBrowserClientFrame(JSON.stringify({ type: "browser.fps", agentId: AGENT }))).toBeNull();
    expect(parseBrowserClientFrame(JSON.stringify({ type: "browser.fps", agentId: AGENT, maxFps: null }))).toBeNull();
    expect(parseBrowserClientFrame(JSON.stringify({ type: "browser.frames.renew", agentId: AGENT }))).toEqual({
      type: "browser.frames.renew",
      agentId: AGENT,
    });
    expect(parseBrowserClientFrame(JSON.stringify({ type: "browser.frames.renew", agentId: "dev" }))).toBeNull();
  });
});

/** A clock and timers the test moves by hand. */
function fakeClock() {
  let now = 0;
  let ids = 0;
  const due: { at: number; id: number; fn: () => void }[] = [];
  return {
    now: () => now,
    timers: {
      setTimeout(fn: () => void, ms: number) {
        const id = ++ids;
        due.push({ at: now + ms, id, fn });
        return id;
      },
      clearTimeout(id: unknown) {
        const i = due.findIndex((d) => d.id === id);
        if (i >= 0) due.splice(i, 1);
      },
    },
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        due.sort((a, b) => a.at - b.at);
        const next = due[0];
        if (!next || next.at > until) break;
        due.shift();
        now = next.at;
        next.fn();
      }
      now = until;
    },
  };
}

describe("createViewerPacer", () => {
  type Message = { type: string; [key: string]: unknown };
  const frame = (seq: number): Message => ({ type: "browser.frame", agentId: AGENT, seq });
  const seqs = (got: Message[]) => got.flatMap((m) => (m.type === "browser.frame" ? [m.seq] : []));

  test("at most the window's frames go undrawn; only the newest waits, and goes at the next ack", () => {
    const got: Message[] = [];
    const pacer = createViewerPacer<Message>((m) => got.push(m), { window: 2 });
    for (const seq of [1, 2, 3, 4]) pacer.send(frame(seq));
    expect(seqs(got)).toEqual([1, 2]);
    // Other messages never wait behind frames.
    pacer.send({ type: "browser.status", agentId: AGENT, mode: "watch" });
    expect(got.at(-1)?.type).toBe("browser.status");
    pacer.ack();
    expect(seqs(got)).toEqual([1, 2, 4]);
    pacer.ack();
    pacer.ack();
    pacer.send(frame(5));
    expect(seqs(got)).toEqual([1, 2, 4, 5]);
    pacer.close();
  });

  test("a view that ends or hides drops the frame waiting; a closed pacer sends nothing", () => {
    const got: Message[] = [];
    const pacer = createViewerPacer<Message>((m) => got.push(m), { window: 1 });
    pacer.send(frame(1));
    pacer.send(frame(2));
    pacer.send({ type: "browser.status", agentId: AGENT, hidden: true });
    pacer.ack();
    expect(seqs(got)).toEqual([1]);
    pacer.send(frame(3));
    pacer.send(frame(4));
    pacer.send({ type: "browser.ended", agentId: AGENT, reason: "stopped" });
    pacer.ack();
    expect(seqs(got)).toEqual([1, 3]);
    pacer.close();
    pacer.send(frame(5));
    pacer.send({ type: "browser.status", agentId: AGENT });
    expect(seqs(got)).toEqual([1, 3]);
    expect(got.at(-1)?.type).toBe("browser.ended");
  });

  test("a rate of its own: a frame sooner than its interval waits (newest wins) and goes when it ends", () => {
    const clock = fakeClock();
    const got: Message[] = [];
    let rooms = 0;
    const pacer = createViewerPacer<Message>((m) => got.push(m), {
      minIntervalMs: 1000,
      onRoom: () => rooms++,
      now: clock.now,
      timers: clock.timers,
    });
    pacer.send(frame(1));
    clock.advance(100);
    pacer.send(frame(2));
    pacer.send(frame(3));
    expect(seqs(got)).toEqual([1]);
    // Drawn, but its rate says not yet: no room for the computer's next frame either.
    pacer.ack();
    expect(pacer.room()).toBe(false);
    clock.advance(900);
    expect(seqs(got)).toEqual([1, 3]);
    clock.advance(1000);
    // The interval after 3 ended: room again, and the computer hears it.
    expect(pacer.room()).toBe(true);
    expect(rooms).toBeGreaterThanOrEqual(2);
    // A card opened: a faster rate, in place; the frame waiting goes at once.
    pacer.send(frame(4));
    pacer.send(frame(5));
    expect(seqs(got)).toEqual([1, 3, 4]);
    pacer.setMinInterval(0);
    expect(seqs(got)).toEqual([1, 3, 4, 5]);
    pacer.close();
  });

  test("a rate's interval: the top rate is none at all, as a watch that names no rate", () => {
    expect(fpsInterval(1)).toBe(1000);
    expect(fpsInterval(5)).toBe(200);
    expect(fpsInterval(BROWSER_VIEW.maxFps)).toBe(0);
    const got: Message[] = [];
    const pacer = createViewerPacer<Message>((m) => got.push(m), {
      minIntervalMs: fpsInterval(BROWSER_VIEW.maxFps),
      now: () => 0,
    });
    // Two frames in the same instant (jitter): both go, the window has room.
    pacer.send(frame(1));
    pacer.send(frame(2));
    expect(seqs(got)).toEqual([1, 2]);
    expect(pacer.room()).toBe(true);
    pacer.close();
  });

  test("a view hidden while a frame waits for its interval drops it, and its timer", () => {
    const clock = fakeClock();
    const got: Message[] = [];
    const pacer = createViewerPacer<Message>((m) => got.push(m), {
      minIntervalMs: 500,
      now: clock.now,
      timers: clock.timers,
    });
    pacer.send(frame(1));
    pacer.send(frame(2));
    pacer.send({ type: "browser.status", agentId: AGENT, hidden: true });
    clock.advance(2000);
    expect(seqs(got)).toEqual([1]);
    pacer.close();
  });

  test("an app that answers no frames: the newest once a second, never held back by acks", () => {
    const clock = fakeClock();
    const got: Message[] = [];
    const pacer = createViewerPacer<Message>((m) => got.push(m), {
      window: Number.POSITIVE_INFINITY,
      minIntervalMs: 1000,
      now: clock.now,
      timers: clock.timers,
    });
    for (let seq = 1; seq <= 10; seq++) {
      pacer.send(frame(seq));
      clock.advance(250);
    }
    // 2.5 s of frames at 4 a second, no ack at all: one a second, each the newest when it went.
    expect(seqs(got)).toEqual([1, 4, 8]);
    clock.advance(1000);
    expect(seqs(got)).toEqual([1, 4, 8, 10]);
    pacer.close();
  });

  test("reset: frames that will never be acked (their socket closed) don't hold the window shut", () => {
    const got: Message[] = [];
    let rooms = 0;
    const pacer = createViewerPacer<Message>((m) => got.push(m), { window: 2, onRoom: () => rooms++ });
    for (const seq of [1, 2, 3]) pacer.send(frame(seq));
    expect(seqs(got)).toEqual([1, 2]);
    expect(pacer.room()).toBe(false);
    pacer.reset();
    expect(seqs(got)).toEqual([1, 2, 3]);
    expect(pacer.room()).toBe(true);
    expect(rooms).toBe(1);
    pacer.close();
    pacer.reset();
    expect(pacer.room()).toBe(false);
  });

  test("an ack for nothing on its way lets nothing go; a frame its socket couldn't take holds no room", () => {
    const got: Message[] = [];
    let rooms = 0;
    let backedUp = false;
    const pacer = createViewerPacer<Message>(
      (m) => {
        if (backedUp && m.type === "browser.frame") return false;
        got.push(m);
        return true;
      },
      { window: 1, onRoom: () => rooms++ },
    );
    pacer.ack();
    expect(rooms).toBe(0);
    backedUp = true;
    pacer.send(frame(1));
    expect(seqs(got)).toEqual([]);
    // Skipped, not on its way: the next one goes as soon as the socket drains.
    expect(pacer.room()).toBe(true);
    backedUp = false;
    pacer.send(frame(2));
    expect(seqs(got)).toEqual([2]);
    pacer.close();
  });

  test("a frame sent once its interval ended, before the late timer fired, is never followed by an older one", () => {
    let now = 0;
    let ids = 0;
    const pending = new Map<number, () => void>();
    const timers = {
      setTimeout(fn: () => void) {
        pending.set(++ids, fn);
        return ids;
      },
      clearTimeout: (id: unknown) => void pending.delete(id as number),
    };
    const fire = () => {
      for (const [id, fn] of [...pending]) {
        pending.delete(id);
        fn();
      }
    };
    const got: Message[] = [];
    const pacer = createViewerPacer<Message>((m) => got.push(m), {
      window: Number.POSITIVE_INFINITY,
      minIntervalMs: 1000,
      now: () => now,
      timers,
    });
    pacer.send(frame(1));
    now = 500;
    pacer.send(frame(2));
    // The interval ended, its timer runs late: the newer frame goes now.
    now = 1001;
    pacer.send(frame(3));
    expect(seqs(got)).toEqual([1, 3]);
    fire();
    now = 3000;
    fire();
    expect(seqs(got)).toEqual([1, 3]);
    pacer.close();
  });

  test("a frame its backed-up socket refused waits (newest wins) and goes once the socket drains", () => {
    const clock = fakeClock();
    const got: Message[] = [];
    let backedUp = true;
    const pacer = createViewerPacer<Message>(
      (m) => {
        if (backedUp && m.type === "browser.frame") return false;
        got.push(m);
        return true;
      },
      { window: 3, retryMs: 100, now: clock.now, timers: clock.timers },
    );
    pacer.send(frame(1));
    pacer.send(frame(2));
    clock.advance(100);
    expect(seqs(got)).toEqual([]);
    // The page went idle: nothing newer comes, and the last one still shows once the socket drains.
    backedUp = false;
    clock.advance(100);
    expect(seqs(got)).toEqual([2]);
    clock.advance(1000);
    expect(seqs(got)).toEqual([2]);
    pacer.close();
  });

  test("a viewer that draws nothing for a while (a hidden tab) gets the newest frame anyway", async () => {
    const got: Message[] = [];
    const pacer = createViewerPacer<Message>((m) => got.push(m), { window: 1, stallMs: 5 });
    for (const seq of [1, 2, 3]) pacer.send(frame(seq));
    expect(seqs(got)).toEqual([1]);
    await Bun.sleep(20);
    expect(seqs(got)).toEqual([1, 3]);
    pacer.close();
  });
});

describe("parseBrowserClientFrame", () => {
  test("watch, unwatch and input with checked events; the rest is not a browser frame", () => {
    expect(parseBrowserClientFrame(JSON.stringify({ type: "browser.watch", agentId: AGENT }))).toEqual({
      type: "browser.watch",
      agentId: AGENT,
    });
    const input = parseBrowserClientFrame(
      JSON.stringify({
        type: "browser.input",
        agentId: AGENT,
        events: [
          { kind: "mouse", type: "mousePressed", x: 10, y: 20, button: "left", clickCount: 1 },
          { kind: "text", text: "olá ção" },
        ],
      }),
    );
    expect(input).toMatchObject({
      type: "browser.input",
      events: [{ kind: "mouse" }, { kind: "text", text: "olá ção" }],
    });
    // When the person made a mouse event goes on to the computer (it keeps a drag's gaps); a time that isn't one doesn't.
    const timed = parseBrowserClientFrame(
      JSON.stringify({
        type: "browser.input",
        agentId: AGENT,
        events: [
          { kind: "mouse", type: "mouseMoved", x: 1, y: 2, button: "left", at: 1234.5 },
          { kind: "mouse", type: "mouseMoved", x: 1, y: 2, at: -1 },
        ],
      }),
    );
    expect(timed?.type === "browser.input" && timed.events).toEqual([
      { kind: "mouse", type: "mouseMoved", x: 1, y: 2, button: "left", at: 1234.5 },
      { kind: "mouse", type: "mouseMoved", x: 1, y: 2 },
    ]);
    expect(parseBrowserClientFrame(JSON.stringify({ type: "browser.input", agentId: AGENT, events: [] }))).toBeNull();
    expect(
      parseBrowserClientFrame(JSON.stringify({ type: "browser.input", agentId: AGENT, events: [{ kind: "nope" }] })),
    ).toBeNull();
    expect(parseBrowserClientFrame(JSON.stringify({ type: "browser.watch", agentId: "dev" }))).toBeNull();
    expect(parseBrowserClientFrame(JSON.stringify({ type: "subscribe", channelId: AGENT }))).toBeNull();
    // A text paste larger than the 4 KB channel frames still parses as a browser frame.
    const big = JSON.stringify({
      type: "browser.input",
      agentId: AGENT,
      events: [{ kind: "text", text: "x".repeat(8000) }],
    });
    expect(parseClientFrame(big)).toBeNull();
    expect(parseBrowserClientFrame(big)).not.toBeNull();
  });
});

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
});
afterEach(async () => {
  await t.close();
});

async function seeded() {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const org = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${org.orgId}${path}`, init);
  const machine = await pairComputer(t, api, { os: "darwin", arch: "arm64", hostname: "mac", version: "0.3.0" });
  await t.db.update(schema.agents).set({ machineId: machine.machineId }).where(eq(schema.agents.id, org.agentId));
  return { owner, org, api, machine };
}

const JPEG = new Uint8Array([0xff, 0xd8, 1, 2, 0xff, 0xd9]);
const picture = (agentId: string, seq: number) => ({
  type: "browser.frame" as const,
  agentId,
  seq,
  data: Buffer.from(JPEG).toString("base64"),
  metadata: { deviceWidth: 1280, deviceHeight: 800 },
});

const opened = (socket: WebSocket) =>
  new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error("refused"));
  });

/** The person's realtime socket, ready: what it got, and a wait for one frame. */
async function realtimeSocket(port: number | undefined, cookie: string, orgId: string) {
  const frames: Record<string, unknown>[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws?orgId=${orgId}`, {
    headers: { cookie, origin: ORIGIN },
  } as unknown as string[]);
  ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)) as Record<string, unknown>);
  await opened(ws);
  const until = async (pred: (f: Record<string, unknown>) => boolean) => {
    for (let i = 0; i < 100 && !frames.some(pred); i++) await Bun.sleep(20);
    return frames.find(pred);
  };
  await until((f) => f.type === "ready");
  return { ws, frames, until };
}

/** A view's frame socket: the frames it got as bytes, and how it closed. */
function frameSocket(port: number | undefined, ticket: string) {
  const got: Uint8Array[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/browser/frames?ticket=${ticket}`);
  socket.binaryType = "arraybuffer";
  socket.onmessage = (e) => got.push(new Uint8Array(e.data as ArrayBuffer));
  let code: number | null = null;
  const closed = new Promise<number>((resolve) => {
    socket.onclose = (e) => {
      code = e.code;
      resolve(e.code);
    };
  });
  return {
    socket,
    got,
    closed,
    closedCode: () => code,
    seqs: () => got.map((bytes) => decodeBrowserFrame(bytes)?.seq),
    until: async (count: number) => {
      for (let i = 0; i < 100 && got.length < count; i++) await Bun.sleep(10);
    },
  };
}

/**
 * The live view's `watch` replaced: each viewer the realtime layer hands it is kept (the newest is `viewer()`), and
 * it says whether it streams here. `first`: the first watch answers only once it settles (a slow one).
 */
function stubWatch(opts: { streaming?: boolean; first?: Promise<void> } = {}) {
  const live = t.engine.browserLive;
  const watch = live.watch;
  const viewers: Parameters<typeof watch>[0][] = [];
  live.watch = async (viewer, _orgId, agentId) => {
    viewers.push(viewer);
    if (viewers.length === 1 && opts.first) await opts.first;
    const streaming = opts.streaming ?? true;
    if (!streaming) viewer.send({ type: "browser.unavailable", agentId, reason: "reconnecting" });
    return { stop: () => {}, streaming };
  };
  return {
    viewer: (i = viewers.length - 1) => viewers[i],
    calls: () => viewers.length,
    restore: () => {
      live.watch = watch;
    },
  };
}

describe("handoff routes", () => {
  test("take over, read who is in control, hand back; outsiders get 403", async () => {
    const { org, api } = await seeded();
    expect(await (await api(`/agents/${org.agentId}/browser/handoff`)).json()).toEqual({ handoff: null });

    const takeover = await api(`/agents/${org.agentId}/browser/takeover`, { json: {} });
    expect(takeover.status).toBe(200);
    const h = (await takeover.json()) as { id: string; kind: string; status: string; controllerUserId: string };
    expect(h).toMatchObject({ kind: "takeover", status: "active" });
    const open = (await (await api(`/agents/${org.agentId}/browser/handoff`)).json()) as { handoff: { id: string } };
    expect(open.handoff.id).toBe(h.id);
    expect((await api(`/browser/handoffs/${h.id}`)).status).toBe(200);

    const other = browser(t);
    await signUp(other, "zed@example.com");
    const outsider = await other(`/api/app/organizations/${org.orgId}/browser/handoffs/${h.id}`);
    expect(outsider.status).toBe(403);

    const done = await api(`/browser/handoffs/${h.id}/done`, { json: {} });
    expect(done.status).toBe(200);
    expect(((await done.json()) as { status: string }).status).toBe("done");
    expect((await api(`/browser/handoffs/${h.id}/done`, { json: {} })).status).toBe(409);
    expect(await (await api(`/agents/${org.agentId}/browser/handoff`)).json()).toEqual({ handoff: null });
  });

  test("the agent's browser settings and its open handoff are two routes, each with its own answer", async () => {
    const { org, api } = await seeded();
    const settings = (await (await api(`/agents/${org.agentId}/browser`)).json()) as Record<string, unknown>;
    expect(settings).toHaveProperty("allowedDomains");
    expect(settings).toHaveProperty("available");
    expect(settings).not.toHaveProperty("handoff");
    expect(await (await api(`/agents/${org.agentId}/browser/handoff`)).json()).toEqual({ handoff: null });
  });

  test("couldn't takes a note, and so does a hand back; cancel ends it", async () => {
    const { org, api } = await seeded();
    const takeover = async () =>
      (await (await api(`/agents/${org.agentId}/browser/takeover`, { json: {} })).json()) as { id: string };
    const first = await takeover();
    const failed = await api(`/browser/handoffs/${first.id}/failed`, { json: { note: "pediu o código da Ana" } });
    expect(await failed.json()).toMatchObject({ status: "failed", note: "pediu o código da Ana" });
    const second = await takeover();
    const canceled = await api(`/browser/handoffs/${second.id}/cancel`, { json: {} });
    expect(await canceled.json()).toMatchObject({ status: "cancelled" });
    const third = await takeover();
    const handedBack = await api(`/browser/handoffs/${third.id}/done`, {
      json: { note: "Entrei com a conta da loja" },
    });
    expect(await handedBack.json()).toMatchObject({ status: "done", note: "Entrei com a conta da loja" });
  });

  test("open a site: only the person in control; outside the agent's sites 403; a bad address 400", async () => {
    const { org, api } = await seeded();
    const path = `/api/app/organizations/${org.orgId}/agents/${org.agentId}/browser/open`;
    const json = { url: "https://shop.example.com" };
    expect((await browser(t)(path, { json })).status).toBe(401);
    const other = browser(t);
    await signUp(other, "zed@example.com");
    expect((await other(path, { json })).status).toBe(403);
    const notInControl = await api(`/agents/${org.agentId}/browser/open`, { json });
    expect(notInControl.status).toBe(409);
    expect(((await notInControl.json()) as { error: { code: string } }).error.code).toBe("browser.not_in_control");

    // The computer answers here: its browser is on, and it opens the page (starting the browser when closed) or refuses the site.
    const hub = t.engine.machineHub;
    const { call, status } = hub;
    const asked: MachineRequest[] = [];
    hub.status = (async (id: string) => ({
      id,
      orgId: org.orgId,
      name: "mac",
      online: true,
      execAllowed: true,
      os: "darwin",
      protocol: 12,
      executors: { browser: { available: true, version: "0.39.1" } },
      paused: null,
      access: { folders: [], tools: { claude: true, codex: true, commands: true, browser: true } },
    })) as unknown as typeof hub.status;
    hub.call = (async (_machineId: string, request: MachineRequest) => {
      asked.push(request);
      if (request.op !== "browser.act") return { success: false, data: null };
      if (request.command !== "open") return { success: true, data: null };
      if (request.args[0]?.includes("evil")) {
        throw new MachineRequestError("not_allowed", "evil.example is outside the sites this agent may use");
      }
      return { success: true, data: { url: request.args[0] } };
    }) as typeof hub.call;
    try {
      await api(`/agents/${org.agentId}/browser/takeover`, { json: {} });
      // Not while the agent may not use its browser (`browser:use` taken away), as for its own tools.
      await t.db
        .delete(schema.agentScopes)
        .where(and(eq(schema.agentScopes.agentId, org.agentId), eq(schema.agentScopes.scope, BROWSER_SCOPE)));
      expect((await api(`/agents/${org.agentId}/browser/open`, { json })).status).toBe(403);
      expect(asked.some((r) => r.op === "browser.act" && r.command === "open")).toBe(false);
      await grantScopes(t.db, org.orgId, org.agentId, [{ connectionId: null, scope: BROWSER_SCOPE }]);
      expect(
        (await api(`/agents/${org.agentId}/browser/open`, { json: { url: "shop.example.com/login" } })).status,
      ).toBe(204);
      expect(asked.find((r) => r.op === "browser.act" && r.command === "open")).toMatchObject({
        args: ["https://shop.example.com/login"],
      });
      const refused = await api(`/agents/${org.agentId}/browser/open`, { json: { url: "https://evil.example" } });
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("browser.not_allowed");
      const bad = await api(`/agents/${org.agentId}/browser/open`, { json: { url: "file:///etc/passwd" } });
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("browser.bad_address");
      // The address bar's arrows and reload: the browser's own commands, nothing else.
      for (const go of ["back", "forward", "reload"]) {
        expect((await api(`/agents/${org.agentId}/browser/open`, { json: { go } })).status).toBe(204);
        expect(asked.at(-1)).toMatchObject({ op: "browser.act", command: go, args: [] });
      }
      // The page at the window's own size again, after the agent emulated a phone: the person in control keeps that
      // size until they choose this.
      expect((await api(`/agents/${org.agentId}/browser/open`, { json: { go: "normalSize" } })).status).toBe(204);
      expect(asked.at(-1)).toMatchObject({ op: "browser.act", command: "agentes:viewport", args: ["desktop"] });
      expect((await api(`/agents/${org.agentId}/browser/open`, { json: { go: "close" } })).status).toBe(400);
    } finally {
      hub.call = call;
      hub.status = status;
    }
  });

  test("stop: refused to outsiders; for the owner it reaches the computer (offline here)", async () => {
    const { org, api } = await seeded();
    const other = browser(t);
    await signUp(other, "zed@example.com");
    const outsider = await other(`/api/app/organizations/${org.orgId}/agents/${org.agentId}/browser/stop`, {
      json: {},
    });
    expect(outsider.status).toBe(403);
    // The computer isn't connected in this test: the owner's stop gets as far as the computer.
    const stop = await api(`/agents/${org.agentId}/browser/stop`, { json: {} });
    expect([204, 409, 503]).toContain(stop.status);
  });

  test("restart: only who may drive it; the browser closes, answers, and opens again on the page it showed", async () => {
    const { org, api } = await seeded();
    const path = `/api/app/organizations/${org.orgId}/agents/${org.agentId}/browser/restart`;
    expect((await browser(t)(path, { json: {} })).status).toBe(401);
    const other = browser(t);
    await signUp(other, "zed@example.com");
    expect((await other(path, { json: {} })).status).toBe(403);
    const hub = t.engine.machineHub;
    const { call } = hub;
    const asked: MachineRequest[] = [];
    hub.call = (async (_machineId: string, request: MachineRequest) => {
      asked.push(request);
      if (request.op !== "browser.act") return { stopped: true };
      return { success: true, data: request.command === "get" ? { url: "https://shop.example.com/cart" } : {} };
    }) as typeof hub.call;
    try {
      expect((await api(`/agents/${org.agentId}/browser/restart`, { json: {} })).status).toBe(204);
      // Opening again goes on after the answer.
      for (let i = 0; i < 50 && asked.length < 3; i++) await Bun.sleep(2);
      expect(asked.map((r) => (r.op === "browser.act" ? `act:${r.command}` : r.op))).toEqual([
        "act:get",
        "browser.stop",
        "act:open",
      ]);
      expect(asked.at(-1)).toMatchObject({ args: ["https://shop.example.com/cart"] });
    } finally {
      hub.call = call;
    }
  });
});

describe("live view socket", () => {
  test("watching an agent whose computer isn't connected here says so; another org's agent is refused", async () => {
    const { owner, org } = await seeded();
    const server = listen(t);
    try {
      const frames: Record<string, unknown>[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/ws?orgId=${org.orgId}`, {
        headers: { cookie: owner.cookie(), origin: ORIGIN },
      } as unknown as string[]);
      ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)) as Record<string, unknown>);
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error("refused"));
      });
      const until = async (pred: (f: Record<string, unknown>) => boolean) => {
        for (let i = 0; i < 100 && !frames.some(pred); i++) await Bun.sleep(20);
        return frames.find(pred);
      };
      await until((f) => f.type === "ready");
      // A watch that fails (a database hiccup) doesn't stick: the next one tries again.
      const live = t.engine.browserLive;
      const watch = live.watch;
      live.watch = async () => {
        throw new Error("database hiccup");
      };
      ws.send(JSON.stringify({ type: "browser.watch", agentId: org.agentId }));
      expect(await until((f) => f.type === "browser.unavailable")).toMatchObject({
        agentId: org.agentId,
        reason: "unavailable",
      });
      live.watch = watch;
      frames.length = 0;
      ws.send(JSON.stringify({ type: "browser.watch", agentId: org.agentId }));
      expect(await until((f) => f.type === "browser.unavailable")).toMatchObject({
        agentId: org.agentId,
        reason: "offline",
      });
      // Offline: the client's retry (watching again) is answered again, not ignored.
      frames.length = 0;
      ws.send(JSON.stringify({ type: "browser.watch", agentId: org.agentId }));
      expect(await until((f) => f.type === "browser.unavailable")).toMatchObject({
        agentId: org.agentId,
        reason: "offline",
      });
      ws.send(JSON.stringify({ type: "browser.watch", agentId: AGENT }));
      expect(await until((f) => f.type === "error" && f.agentId === AGENT)).toMatchObject({ code: "not_found" });
      ws.send(JSON.stringify({ type: "browser.input", agentId: org.agentId, events: [{ kind: "text", text: "a" }] }));
      expect(await until((f) => f.code === "not_in_control")).toBeTruthy();
      // In control, and the computer couldn't put it on the page: the view hears that too.
      const realInput = t.engine.browserLive.input;
      t.engine.browserLive.input = async () => ({ accepted: 0, refused: false, failed: 1 });
      ws.send(JSON.stringify({ type: "browser.watch", agentId: org.agentId }));
      await until((f) => f.type === "browser.unavailable");
      ws.send(JSON.stringify({ type: "browser.input", agentId: org.agentId, events: [{ kind: "text", text: "a" }] }));
      expect(await until((f) => f.code === "input_failed")).toMatchObject({ agentId: org.agentId });
      t.engine.browserLive.input = async () => ({ accepted: 1, refused: false, nowhere: true });
      ws.send(JSON.stringify({ type: "browser.input", agentId: org.agentId, events: [{ kind: "text", text: "a" }] }));
      expect(await until((f) => f.code === "no_field")).toMatchObject({ agentId: org.agentId });
      t.engine.browserLive.input = realInput;
      ws.close();
    } finally {
      await Promise.race([server.stop(true), Bun.sleep(500)]);
    }
  });
  test("a client that answers frames gets them on a socket of their own, as bytes, in a window", async () => {
    const { owner, org } = await seeded();
    const server = listen(t);
    const stub = stubWatch();
    try {
      const { ws, frames, until } = await realtimeSocket(server.port, owner.cookie(), org.orgId);
      ws.send(JSON.stringify({ type: "browser.watch", agentId: org.agentId, acks: true, frames: true }));
      const ticket = (await until((f) => f.type === "browser.frames"))?.ticket;
      if (typeof ticket !== "string") throw new Error("no ticket");
      // Before the frame socket is open, a picture comes here as base64, saying it wants an ack.
      stub.viewer()?.send(picture(org.agentId, 1));
      const first = await until((f) => f.type === "browser.frame");
      expect(first).toMatchObject({ seq: 1, data: Buffer.from(JPEG).toString("base64"), ack: true });
      expect(first).not.toHaveProperty("bytes");
      ws.send(JSON.stringify({ type: "browser.ack", agentId: org.agentId, seq: 1 }));

      const pictures = frameSocket(server.port, ticket);
      await opened(pictures.socket);
      // A ticket opens one socket, once.
      expect(
        await opened(frameSocket(server.port, ticket).socket).then(
          () => "open",
          () => "refused",
        ),
      ).toBe("refused");
      for (const seq of [2, 3, 4, 5, 6]) stub.viewer()?.send(picture(org.agentId, seq));
      await pictures.until(3);
      await Bun.sleep(30);
      // Three on their way (`BROWSER_VIEW.window`); 5 was replaced by 6 while the window was full.
      expect(pictures.seqs()).toEqual([2, 3, 4]);
      expect([...(decodeBrowserFrame(pictures.got[0] as Uint8Array)?.jpeg ?? [])]).toEqual([...JPEG]);
      pictures.socket.send(JSON.stringify({ type: "ack" }));
      await pictures.until(4);
      expect(pictures.seqs()).toEqual([2, 3, 4, 6]);
      // None of them came on the realtime socket.
      expect(frames.filter((f) => f.type === "browser.frame")).toHaveLength(1);
      // Unwatching ends the view, and its frame socket closes.
      ws.send(JSON.stringify({ type: "browser.unwatch", agentId: org.agentId }));
      expect(await pictures.closed).toBe(1000);
      ws.close();
    } finally {
      stub.restore();
      await Promise.race([server.stop(true), Bun.sleep(500)]);
    }
  });

  test("the frame socket stays open across watches of the same agent: no new ticket, the new window", async () => {
    const { owner, org } = await seeded();
    const server = listen(t);
    const stub = stubWatch();
    try {
      const { ws, frames, until } = await realtimeSocket(server.port, owner.cookie(), org.orgId);
      const watch = JSON.stringify({ type: "browser.watch", agentId: org.agentId, acks: true, frames: true });
      ws.send(watch);
      const ticket = (await until((f) => f.type === "browser.frames"))?.ticket;
      if (typeof ticket !== "string") throw new Error("no ticket");
      const pictures = frameSocket(server.port, ticket);
      await opened(pictures.socket);
      // The card remounted: it watches again.
      ws.send(watch);
      for (let i = 0; i < 100 && stub.calls() < 2; i++) await Bun.sleep(10);
      await Bun.sleep(50);
      expect(stub.calls()).toBe(2);
      expect(frames.filter((f) => f.type === "browser.frames")).toHaveLength(1);
      expect(pictures.closedCode()).toBeNull();
      // The old view sends nothing any more; the new one sends there, and the acks there are its own.
      stub.viewer(0)?.send(picture(org.agentId, 1));
      for (const seq of [2, 3, 4, 5]) stub.viewer()?.send(picture(org.agentId, seq));
      await pictures.until(3);
      await Bun.sleep(30);
      expect(pictures.seqs()).toEqual([2, 3, 4]);
      pictures.socket.send(JSON.stringify({ type: "ack" }));
      await pictures.until(4);
      expect(pictures.seqs()).toEqual([2, 3, 4, 5]);
      expect(frames.filter((f) => f.type === "browser.frame")).toHaveLength(0);
      ws.close();
      // The realtime socket's close takes its frame sockets with it.
      expect(await pictures.closed).toBe(1000);
    } finally {
      stub.restore();
      await Promise.race([server.stop(true), Bun.sleep(500)]);
    }
  });

  test("a frame socket that drops: its window starts again here, and a renew gets a new ticket", async () => {
    const { owner, org } = await seeded();
    const server = listen(t);
    const stub = stubWatch();
    try {
      const { ws, frames, until } = await realtimeSocket(server.port, owner.cookie(), org.orgId);
      ws.send(JSON.stringify({ type: "browser.watch", agentId: org.agentId, acks: true, frames: true }));
      const ticket = (await until((f) => f.type === "browser.frames"))?.ticket;
      if (typeof ticket !== "string") throw new Error("no ticket");
      const pictures = frameSocket(server.port, ticket);
      await opened(pictures.socket);
      await Bun.sleep(20);
      // A full window on the frame socket, and one waiting: then the socket drops before any ack.
      for (const seq of [1, 2, 3, 4]) stub.viewer()?.send(picture(org.agentId, seq));
      await pictures.until(3);
      pictures.socket.close();
      // The frame waiting goes at once, here, instead of after the stall.
      expect(await until((f) => f.type === "browser.frame")).toMatchObject({ seq: 4, ack: true });
      const tickets = () => frames.filter((f) => f.type === "browser.frames").map((f) => f.ticket);
      const renew = JSON.stringify({ type: "browser.frames.renew", agentId: org.agentId });
      ws.send(renew);
      await until((f) => f.type === "browser.frames" && f.ticket !== ticket);
      // At most one a second.
      ws.send(renew);
      await Bun.sleep(100);
      expect(tickets()).toHaveLength(2);
      await Bun.sleep(FRAME_RENEW_MS);
      ws.send(renew);
      for (let i = 0; i < 100 && tickets().length < 3; i++) await Bun.sleep(10);
      const [, older, newest] = tickets();
      // Only the newest ticket of a view opens it.
      expect(
        await opened(frameSocket(server.port, String(older)).socket).then(
          () => "open",
          () => "refused",
        ),
      ).toBe("refused");
      const again = frameSocket(server.port, String(newest));
      await opened(again.socket);
      // Still open here, but the client says its own closed (a socket left half-open by a network change): a renew
      // gets a ticket all the same, once the last one is a second old (only the condition under test could refuse).
      await Bun.sleep(FRAME_RENEW_MS);
      ws.send(renew);
      for (let i = 0; i < 100 && tickets().length < 4; i++) await Bun.sleep(10);
      expect(tickets()).toHaveLength(4);
      const replacing = frameSocket(server.port, String(tickets()[3]));
      await opened(replacing.socket);
      // The new socket takes over: the old one closes, and the pictures go to the new one.
      expect(await again.closed).toBe(1000);
      stub.viewer()?.send(picture(org.agentId, 5));
      await replacing.until(1);
      expect(replacing.seqs()).toEqual([5]);
      expect(again.got).toHaveLength(0);
      ws.close();
    } finally {
      stub.restore();
      await Promise.race([server.stop(true), Bun.sleep(500)]);
    }
  }, 15_000);

  test("a view whose browser streams on no server here gets no frame socket ticket", async () => {
    const { owner, org } = await seeded();
    const server = listen(t);
    const stub = stubWatch({ streaming: false });
    try {
      const { ws, frames, until } = await realtimeSocket(server.port, owner.cookie(), org.orgId);
      ws.send(JSON.stringify({ type: "browser.watch", agentId: org.agentId, acks: true, frames: true }));
      await until((f) => f.type === "browser.unavailable");
      await Bun.sleep(50);
      expect(frames.some((f) => f.type === "browser.frames")).toBe(false);
      // Nor on a renew.
      ws.send(JSON.stringify({ type: "browser.frames.renew", agentId: org.agentId }));
      await Bun.sleep(50);
      expect(frames.some((f) => f.type === "browser.frames")).toBe(false);
      ws.close();
    } finally {
      stub.restore();
      await Promise.race([server.stop(true), Bun.sleep(500)]);
    }
  });

  test("a slow watch that ends after a newer one leaves the newer one's frame socket alone", async () => {
    const { owner, org } = await seeded();
    const server = listen(t);
    let release!: () => void;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stub = stubWatch({ first: slow });
    try {
      const { ws, until } = await realtimeSocket(server.port, owner.cookie(), org.orgId);
      const watch = JSON.stringify({ type: "browser.watch", agentId: org.agentId, acks: true, frames: true });
      ws.send(watch);
      for (let i = 0; i < 100 && stub.calls() < 1; i++) await Bun.sleep(10);
      // Unwatched while it starts, then watched again: the newer view gets its frame socket.
      ws.send(JSON.stringify({ type: "browser.unwatch", agentId: org.agentId }));
      await Bun.sleep(30);
      ws.send(watch);
      const ticket = (await until((f) => f.type === "browser.frames"))?.ticket;
      if (typeof ticket !== "string") throw new Error("no ticket");
      const pictures = frameSocket(server.port, ticket);
      await opened(pictures.socket);
      // The first watch ends at last: it stops at once, and leaves the newer view as it is.
      release();
      await Bun.sleep(50);
      expect(pictures.closedCode()).toBeNull();
      stub.viewer()?.send(picture(org.agentId, 1));
      await pictures.until(1);
      expect(pictures.seqs()).toEqual([1]);
      ws.close();
    } finally {
      stub.restore();
      await Promise.race([server.stop(true), Bun.sleep(500)]);
    }
  });

  test("an app that answers no frames gets the newest one a second, as before, with no ack asked", async () => {
    const { owner, org } = await seeded();
    const server = listen(t);
    const stub = stubWatch();
    try {
      const { ws, frames, until } = await realtimeSocket(server.port, owner.cookie(), org.orgId);
      ws.send(JSON.stringify({ type: "browser.watch", agentId: org.agentId, frames: true }));
      for (let i = 0; i < 100 && stub.calls() < 1; i++) await Bun.sleep(10);
      for (const seq of [1, 2, 3]) stub.viewer()?.send(picture(org.agentId, seq));
      const seqs = () => frames.flatMap((f) => (f.type === "browser.frame" ? [f.seq] : []));
      await until((f) => f.type === "browser.frame");
      await Bun.sleep(100);
      expect(seqs()).toEqual([1]);
      expect(frames.find((f) => f.type === "browser.frame")).not.toHaveProperty("ack");
      for (let i = 0; i < 150 && seqs().length < 2; i++) await Bun.sleep(10);
      expect(seqs()).toEqual([1, 3]);
      // No frame socket for an app that answers nothing.
      expect(frames.some((f) => f.type === "browser.frames")).toBe(false);
      // In control the person driving gets the stream's own rate, as before: every frame at once.
      const status = (controllerUserId: string | null) => ({
        type: "browser.status" as const,
        agentId: org.agentId,
        mode: controllerUserId ? ("control" as const) : ("watch" as const),
        controllerUserId,
        handoff: null,
        hidden: false,
      });
      const me = (await until((f) => f.type === "ready"))?.userId;
      if (typeof me !== "string") throw new Error("no ready");
      await Bun.sleep(1100);
      stub.viewer()?.send(status(me));
      for (const seq of [4, 5, 6]) stub.viewer()?.send(picture(org.agentId, seq));
      for (let i = 0; i < 50 && seqs().length < 5; i++) await Bun.sleep(10);
      expect(seqs()).toEqual([1, 3, 4, 5, 6]);
      // Handed back: once a second again.
      stub.viewer()?.send(status(null));
      await Bun.sleep(1100);
      for (const seq of [7, 8]) stub.viewer()?.send(picture(org.agentId, seq));
      await Bun.sleep(100);
      expect(seqs()).toEqual([1, 3, 4, 5, 6, 7]);
      ws.close();
    } finally {
      stub.restore();
      await Promise.race([server.stop(true), Bun.sleep(500)]);
    }
    // About 3.3 s of real waits on the legacy one-second rate, on top of the seed.
  }, 15_000);

  test("browser.fps changes a view's rate in place: no new watch", async () => {
    const { owner, org } = await seeded();
    const server = listen(t);
    const stub = stubWatch();
    try {
      const { ws, frames } = await realtimeSocket(server.port, owner.cookie(), org.orgId);
      // A closed card: one frame a second.
      ws.send(JSON.stringify({ type: "browser.watch", agentId: org.agentId, acks: true, maxFps: 1 }));
      for (let i = 0; i < 100 && stub.calls() < 1; i++) await Bun.sleep(10);
      const seqs = () => frames.flatMap((f) => (f.type === "browser.frame" ? [f.seq] : []));
      stub.viewer()?.send(picture(org.agentId, 1));
      stub.viewer()?.send(picture(org.agentId, 2));
      await Bun.sleep(100);
      expect(seqs()).toEqual([1]);
      // Opened: as the window allows. The frame waiting goes without waiting out the second.
      ws.send(JSON.stringify({ type: "browser.fps", agentId: org.agentId, maxFps: 15 }));
      for (let i = 0; i < 50 && seqs().length < 2; i++) await Bun.sleep(10);
      expect(seqs()).toEqual([1, 2]);
      expect(stub.calls()).toBe(1);
      // The top rate is no limit at all, as a watch that names none: two frames back to back both go at once (the
      // window has room once they're drawn), none held for a fifteenth of a second.
      const ack = JSON.stringify({ type: "browser.ack", agentId: org.agentId });
      ws.send(ack);
      ws.send(ack);
      await Bun.sleep(30);
      stub.viewer()?.send(picture(org.agentId, 3));
      stub.viewer()?.send(picture(org.agentId, 4));
      for (let i = 0; i < 50 && seqs().length < 4; i++) await Bun.sleep(10);
      expect(seqs()).toEqual([1, 2, 3, 4]);
      ws.close();
    } finally {
      stub.restore();
      await Promise.race([server.stop(true), Bun.sleep(500)]);
    }
  });

  test("a rate sent right after a watch wins over it, even while the watch's checks still await", async () => {
    const { owner, org } = await seeded();
    const server = listen(t);
    const stub = stubWatch();
    const limiter = t.adapters.rateLimiter;
    const realConsume = limiter.consume;
    try {
      const { ws, frames } = await realtimeSocket(server.port, owner.cookie(), org.orgId);
      // The watch's checks are slow: the rate sent after it is handled first.
      limiter.consume = async (key, rule) => {
        if (key.startsWith("ws:")) await Bun.sleep(50);
        return realConsume(key, rule);
      };
      // A closed card and an opened view mounted together: the client watches at 1 fps, then asks for the top rate.
      ws.send(JSON.stringify({ type: "browser.watch", agentId: org.agentId, acks: true, maxFps: 1 }));
      ws.send(JSON.stringify({ type: "browser.fps", agentId: org.agentId, maxFps: 15 }));
      for (let i = 0; i < 100 && stub.calls() < 1; i++) await Bun.sleep(10);
      const seqs = () => frames.flatMap((f) => (f.type === "browser.frame" ? [f.seq] : []));
      stub.viewer()?.send(picture(org.agentId, 1));
      stub.viewer()?.send(picture(org.agentId, 2));
      // Both at once, not the second after a second.
      for (let i = 0; i < 20 && seqs().length < 2; i++) await Bun.sleep(10);
      expect(seqs()).toEqual([1, 2]);
      ws.close();
    } finally {
      limiter.consume = realConsume;
      stub.restore();
      await Promise.race([server.stop(true), Bun.sleep(500)]);
    }
  });

  test("a second watch with a higher rate, while the first still starts, sets the rate (no browser.fps)", async () => {
    const { owner, org } = await seeded();
    const server = listen(t);
    let release: () => void = () => {};
    const first = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const stub = stubWatch({ first });
    try {
      const { ws, frames } = await realtimeSocket(server.port, owner.cookie(), org.orgId);
      // A thumbnail watches at 1 fps; its card opens before the stream started: a watch at the top rate.
      ws.send(JSON.stringify({ type: "browser.watch", agentId: org.agentId, acks: true, maxFps: 1 }));
      for (let i = 0; i < 100 && stub.calls() < 1; i++) await Bun.sleep(10);
      ws.send(JSON.stringify({ type: "browser.watch", agentId: org.agentId, acks: true }));
      await Bun.sleep(50);
      release();
      await Bun.sleep(30);
      // The second watch is a no-op for the view: still one watch.
      expect(stub.calls()).toBe(1);
      const seqs = () => frames.flatMap((f) => (f.type === "browser.frame" ? [f.seq] : []));
      stub.viewer()?.send(picture(org.agentId, 1));
      stub.viewer()?.send(picture(org.agentId, 2));
      // Both at once, not the second after a second.
      for (let i = 0; i < 20 && seqs().length < 2; i++) await Bun.sleep(10);
      expect(seqs()).toEqual([1, 2]);
      ws.close();
    } finally {
      release();
      stub.restore();
      await Promise.race([server.stop(true), Bun.sleep(500)]);
    }
  });

  test("input frames enter the live view in the order they came, even when a later one's checks end first", async () => {
    const { owner, org } = await seeded();
    const server = listen(t);
    const live = t.engine.browserLive;
    const limiter = t.adapters.rateLimiter;
    const realConsume = limiter.consume;
    const realInput = live.input;
    try {
      const frames: Record<string, unknown>[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/ws?orgId=${org.orgId}`, {
        headers: { cookie: owner.cookie(), origin: ORIGIN },
      } as unknown as string[]);
      ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)) as Record<string, unknown>);
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error("refused"));
      });
      const until = async (pred: (f: Record<string, unknown>) => boolean) => {
        for (let i = 0; i < 100 && !frames.some(pred); i++) await Bun.sleep(20);
        return frames.find(pred);
      };
      await until((f) => f.type === "ready");
      ws.send(JSON.stringify({ type: "browser.watch", agentId: org.agentId }));
      await until((f) => f.type === "browser.unavailable");
      // The first frames' checks are the slowest: each later one would finish its await first.
      let n = 0;
      limiter.consume = async (key, rule) => {
        if (key.startsWith("ws-browser:")) await Bun.sleep(Math.max(0, 60 - 10 * n++));
        return realConsume(key, rule);
      };
      const typed: string[] = [];
      let answered = 0;
      live.input = async (_userId, _orgId, _agentId, events) => {
        for (const e of events) if (e.kind === "text") typed.push(e.text);
        // The computer's answer is slow too: it never holds back the frames behind it.
        await Bun.sleep(1000);
        answered++;
        return { accepted: events.length, refused: false };
      };
      const word = "abcdef";
      for (const ch of word) {
        ws.send(JSON.stringify({ type: "browser.input", agentId: org.agentId, events: [{ kind: "text", text: ch }] }));
      }
      for (let i = 0; i < 50 && typed.length < word.length; i++) await Bun.sleep(10);
      expect(typed.join("")).toBe(word);
      expect(answered).toBe(0);
      ws.close();
    } finally {
      limiter.consume = realConsume;
      live.input = realInput;
      await Promise.race([server.stop(true), Bun.sleep(500)]);
    }
  });
  test("an input frame whose checks fail (the rate limiter is away) answers unavailable instead of vanishing", async () => {
    const { owner, org } = await seeded();
    const server = listen(t);
    const limiter = t.adapters.rateLimiter;
    const realConsume = limiter.consume;
    try {
      const frames: Record<string, unknown>[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/ws?orgId=${org.orgId}`, {
        headers: { cookie: owner.cookie(), origin: ORIGIN },
      } as unknown as string[]);
      ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)) as Record<string, unknown>);
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error("refused"));
      });
      const until = async (pred: (f: Record<string, unknown>) => boolean) => {
        for (let i = 0; i < 100 && !frames.some(pred); i++) await Bun.sleep(20);
        return frames.find(pred);
      };
      await until((f) => f.type === "ready");
      limiter.consume = async (key, rule) => {
        if (key.startsWith("ws-browser:")) throw new Error("limiter down");
        return realConsume(key, rule);
      };
      ws.send(JSON.stringify({ type: "browser.input", agentId: org.agentId, events: [{ kind: "text", text: "a" }] }));
      expect(await until((f) => f.type === "browser.unavailable")).toMatchObject({
        agentId: org.agentId,
        reason: "unavailable",
      });
      ws.close();
    } finally {
      limiter.consume = realConsume;
      await Promise.race([server.stop(true), Bun.sleep(500)]);
    }
  });
});

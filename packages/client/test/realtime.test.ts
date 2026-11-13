import { describe, expect, test } from "bun:test";
import type { ChannelEvent, Message } from "../src/index";
import {
  agentStateIn,
  agentStateOfRun,
  applyChannelEvent,
  BROWSER_UNWATCH_DELAY_MS,
  emptyStreams,
  expectReply,
  MISSED_MESSAGE_GRACE_MS,
  parseServerFrame,
  RealtimeConnection,
  realtimeUrl,
  retargetProvisional,
  runningAgents,
  runsInChannel,
  type Timers,
} from "../src/index";
import { barEntries } from "../src/lib/activity";
import { type FakeSocket, fakeSockets } from "./fake-socket";

/** A frame socket's message as the server writes it (`encodeBrowserFrame`): version, header length, header, JPEG. */
function frameBytes(seq: number, jpeg: number[], capturedAt?: number) {
  const metadata = { deviceWidth: 1280, deviceHeight: 800, ...(capturedAt ? { capturedAt } : {}) };
  const head = new TextEncoder().encode(JSON.stringify({ seq, metadata }));
  const bytes = new Uint8Array(5 + head.byteLength + jpeg.length);
  bytes[0] = 1;
  new DataView(bytes.buffer).setUint32(1, head.byteLength);
  bytes.set(head, 5);
  bytes.set(jpeg, 5 + head.byteLength);
  return bytes;
}

function manualTimers() {
  const pending: { fn: () => void; ms: number; id: number }[] = [];
  let next = 1;
  const timers: Timers = {
    setTimeout: (fn, ms) => {
      const id = next++;
      pending.push({ fn, ms, id });
      return id;
    },
    clearTimeout: (id) => {
      const i = pending.findIndex((p) => p.id === id);
      if (i >= 0) pending.splice(i, 1);
    },
    setInterval: () => next++,
    clearInterval: () => {},
  };
  return { timers, pending, runNext: () => pending.shift()?.fn() };
}

describe("RealtimeConnection", () => {
  test("url uses ws/wss and the org id", () => {
    expect(realtimeUrl({ protocol: "https:", host: "agentes.chat" }, "o 1")).toBe(
      "wss://agentes.chat/api/ws?orgId=o%201",
    );
    expect(realtimeUrl({ protocol: "http:", host: "localhost:5173" }, "o1")).toBe(
      "ws://localhost:5173/api/ws?orgId=o1",
    );
    expect(realtimeUrl("https://app.agentes.chat/", "o1")).toBe("wss://app.agentes.chat/api/ws?orgId=o1");
    expect(realtimeUrl("http://192.168.0.2:3000", "o1")).toBe("ws://192.168.0.2:3000/api/ws?orgId=o1");
    expect(() => realtimeUrl("agentes.chat", "o1")).toThrow();
  });

  test("watches agents' browsers answering frames: on the realtime socket, then on their own frame socket", async () => {
    const { factory, sockets } = fakeSockets();
    const conn = new RealtimeConnection({
      url: "wss://app.example.com/api/ws?orgId=o",
      createSocket: factory,
      pingMs: 0,
    });
    const views: Record<string, unknown>[] = [];
    conn.onBrowserFrame((frame) => views.push(frame));
    conn.onBrowserFrame(() => {});
    conn.start();
    const socket = sockets[0] as FakeSocket;
    socket.open();
    const release = conn.browserWatcher.acquire("a1");
    expect(socket.sent).toEqual([{ type: "browser.watch", agentId: "a1", acks: true, frames: true }]);
    // A frame on the realtime socket that asks for an answer: answered once, after the views got it (at the next
    // animation frame where there is one, at once otherwise).
    socket.push({ type: "browser.frame", agentId: "a1", seq: 9, data: "/9j/", metadata: {}, ack: true });
    socket.push({ type: "browser.status", agentId: "a1", mode: "watch" });
    for (let i = 0; i < 20 && socket.sent.length < 2; i++) await Bun.sleep(5);
    expect(views).toHaveLength(2);
    expect(socket.sent.slice(1)).toEqual([{ type: "browser.ack", agentId: "a1", seq: 9 }]);

    // The ticket for its own socket: opened on the same server; its bytes reach the views as frames with `jpeg`.
    socket.push({ type: "browser.frames", agentId: "a1", ticket: "t/1" });
    const frames = sockets[1] as FakeSocket;
    expect(frames.url).toBe("wss://app.example.com/api/browser/frames?ticket=t%2F1");
    frames.open();
    frames.onmessage?.({ data: frameBytes(10, [0xff, 0xd8, 7], 1_700_000_000_000).buffer });
    for (let i = 0; i < 20 && frames.sent.length < 1; i++) await Bun.sleep(5);
    expect(views.at(-1)).toMatchObject({
      type: "browser.frame",
      agentId: "a1",
      seq: 10,
      metadata: { deviceWidth: 1280, deviceHeight: 800, capturedAt: 1_700_000_000_000 },
    });
    expect([...((views.at(-1)?.jpeg as Uint8Array) ?? [])]).toEqual([0xff, 0xd8, 7]);
    expect(frames.sent).toEqual([{ type: "ack" }]);
    // Not answered twice: nothing more on the realtime socket.
    expect(socket.sent).toHaveLength(2);

    // The last view leaves: its frame socket goes with the unwatch.
    release();
    for (let i = 0; i < 400 && !frames.closed; i++) await Bun.sleep(5);
    expect(frames.closed).toBe(true);
    conn.stop();
  });

  test("a server that doesn't ask for answers (one from before acks) gets none, so it never counts them as bad", async () => {
    const { factory, sockets } = fakeSockets();
    const conn = new RealtimeConnection({ url: "ws://x/api/ws?orgId=o", createSocket: factory, pingMs: 0 });
    const views: Record<string, unknown>[] = [];
    conn.onBrowserFrame((frame) => views.push(frame));
    conn.start();
    const socket = sockets[0] as FakeSocket;
    socket.open();
    conn.browserWatcher.acquire("a1");
    for (let seq = 1; seq <= 5; seq++) {
      socket.push({ type: "browser.frame", agentId: "a1", seq, data: "/9j/", metadata: {} });
    }
    await Bun.sleep(30);
    expect(views).toHaveLength(5);
    expect(socket.sent.map((f) => (f as { type: string }).type)).toEqual(["browser.watch"]);
    conn.stop();
  });

  test("without frame sockets (the phone) a watch asks for answers but no frame socket; a ticket opens none", async () => {
    const { factory, sockets } = fakeSockets();
    const conn = new RealtimeConnection({
      url: "ws://x/api/ws?orgId=o",
      createSocket: factory,
      pingMs: 0,
      browserFrameSockets: false,
    });
    const views: Record<string, unknown>[] = [];
    conn.onBrowserFrame((frame) => views.push(frame));
    conn.start();
    const socket = sockets[0] as FakeSocket;
    socket.open();
    conn.browserWatcher.acquire("a1", 1);
    expect(socket.sent).toEqual([{ type: "browser.watch", agentId: "a1", maxFps: 1, acks: true }]);
    socket.push({ type: "browser.frames", agentId: "a1", ticket: "t1" });
    expect(sockets).toHaveLength(1);
    // Its pictures stay base64 on this socket, each answered once drawn.
    socket.push({ type: "browser.frame", agentId: "a1", seq: 3, data: "/9j/", metadata: {}, ack: true });
    for (let i = 0; i < 20 && socket.sent.length < 2; i++) await Bun.sleep(5);
    expect(views).toHaveLength(1);
    expect(socket.sent.at(-1)).toEqual({ type: "browser.ack", agentId: "a1", seq: 3 });
    conn.stop();
  });

  test("a lost realtime socket takes the frame sockets with it", () => {
    const { factory, sockets } = fakeSockets();
    const conn = new RealtimeConnection({ url: "ws://x/api/ws?orgId=o", createSocket: factory, pingMs: 0 });
    conn.start();
    const socket = sockets[0] as FakeSocket;
    socket.open();
    conn.browserWatcher.acquire("a1");
    socket.push({ type: "browser.frames", agentId: "a1", ticket: "t1" });
    const frames = sockets[1] as FakeSocket;
    expect(frames.url).toBe("ws://x/api/browser/frames?ticket=t1");
    socket.drop();
    expect(frames.closed).toBe(true);
    conn.stop();
  });

  test("the frame socket stays across watches of the same agent; a picture from before it is never drawn over it", async () => {
    const { factory, sockets } = fakeSockets();
    const conn = new RealtimeConnection({ url: "ws://x/api/ws?orgId=o", createSocket: factory, pingMs: 0 });
    const seqs: unknown[] = [];
    conn.onBrowserFrame((frame) => {
      if (frame.type === "browser.frame") seqs.push(frame.seq);
    });
    conn.start();
    const socket = sockets[0] as FakeSocket;
    socket.open();
    const card = conn.browserWatcher.acquire("a1");
    socket.push({ type: "browser.frames", agentId: "a1", ticket: "t1" });
    const frames = sockets[1] as FakeSocket;
    frames.open();
    frames.onmessage?.({ data: frameBytes(10, [0xff, 0xd8]).buffer });
    // A picture sent here before the switch arrives late: answered (the server counts it), never drawn.
    socket.push({ type: "browser.frame", agentId: "a1", seq: 9, data: "/9j/", metadata: {}, ack: true });
    for (let i = 0; i < 20 && socket.sent.length < 2; i++) await Bun.sleep(5);
    expect(seqs).toEqual([10]);
    expect(socket.sent.at(-1)).toEqual({ type: "browser.ack", agentId: "a1", seq: 9 });

    // Another view of the same agent watches again: the frame socket stays, and the view starts over, so the next
    // picture is drawn whichever way it comes.
    const full = conn.browserWatcher.acquire("a1");
    expect(socket.sent.filter((f) => (f as { type: string }).type === "browser.watch")).toHaveLength(2);
    expect(frames.closed).toBe(false);
    expect(sockets).toHaveLength(2);
    socket.push({ type: "browser.frame", agentId: "a1", seq: 11, data: "/9j/", metadata: {} });
    expect(seqs).toEqual([10, 11]);
    frames.onmessage?.({ data: frameBytes(12, [0xff, 0xd8]).buffer });
    socket.push({ type: "browser.frame", agentId: "a1", seq: 11, data: "/9j/", metadata: {} });
    expect(seqs).toEqual([10, 11, 12]);

    // The frame socket closes on its own: its pictures come here again, and are drawn.
    frames.drop();
    socket.push({ type: "browser.frame", agentId: "a1", seq: 13, data: "/9j/", metadata: {} });
    expect(seqs).toEqual([10, 11, 12, 13]);
    card();
    full();
    conn.stop();
  });

  test("a frame socket that closes on its own is asked for again after 1, 2 and 4 s, then not; a frame starts over", () => {
    const { factory, sockets } = fakeSockets();
    const clock = manualTimers();
    const conn = new RealtimeConnection({
      url: "ws://x/api/ws?orgId=o",
      createSocket: factory,
      timers: clock.timers,
      pingMs: 0,
    });
    conn.start();
    const socket = sockets[0] as FakeSocket;
    socket.open();
    const release = conn.browserWatcher.acquire("a1");
    const renewals = () => socket.sent.filter((f) => (f as { type: string }).type === "browser.frames.renew");
    const ticket = (name: string) => {
      socket.push({ type: "browser.frames", agentId: "a1", ticket: name });
      return sockets[sockets.length - 1] as FakeSocket;
    };
    const waits = () => clock.pending.map((p) => p.ms);

    let frames = ticket("t1");
    frames.open();
    frames.drop();
    // Never a new watch (that restarts the view): a new ticket for the same one, after a second.
    expect(waits()).toEqual([1000]);
    clock.runNext();
    expect(renewals()).toEqual([{ type: "browser.frames.renew", agentId: "a1" }]);
    expect(socket.sent.filter((f) => (f as { type: string }).type === "browser.watch")).toHaveLength(1);
    // Each new socket that closes before a frame came waits longer, up to three asks.
    for (const wait of [2000, 4000]) {
      frames = ticket(`t${wait}`);
      frames.drop();
      expect(waits()).toEqual([wait]);
      clock.runNext();
    }
    expect(renewals()).toHaveLength(3);
    frames = ticket("t4");
    frames.drop();
    expect(waits()).toEqual([]);

    // A socket that brings a frame: the next close starts again from a second.
    frames = ticket("t5");
    frames.open();
    frames.onmessage?.({ data: frameBytes(1, [0xff, 0xd8]).buffer });
    frames.drop();
    expect(waits()).toEqual([1000]);
    // The view leaves before then: nothing is asked for.
    release();
    expect(waits()).toEqual([1000, BROWSER_UNWATCH_DELAY_MS]);
    clock.runNext();
    expect(renewals()).toHaveLength(3);
    conn.stop();
  });

  test("a watch again starts the frame socket's renewals over; one already waiting still goes, as the first", () => {
    const { factory, sockets } = fakeSockets();
    const clock = manualTimers();
    const conn = new RealtimeConnection({
      url: "ws://x/api/ws?orgId=o",
      createSocket: factory,
      timers: clock.timers,
      pingMs: 0,
    });
    conn.start();
    const socket = sockets[0] as FakeSocket;
    socket.open();
    const release = conn.browserWatcher.acquire("a1");
    const renewals = () => socket.sent.filter((f) => (f as { type: string }).type === "browser.frames.renew");
    const ticket = (name: string) => {
      socket.push({ type: "browser.frames", agentId: "a1", ticket: name });
      return sockets[sockets.length - 1] as FakeSocket;
    };
    const waits = () => clock.pending.map((p) => p.ms);

    // Three asks, each socket closing before a frame came: no more.
    for (const [i, wait] of [1000, 2000, 4000].entries()) {
      ticket(`t${i}`).drop();
      expect(waits()).toEqual([wait]);
      clock.runNext();
    }
    ticket("t3").drop();
    expect(waits()).toEqual([]);
    expect(renewals()).toHaveLength(3);

    // Try again (a watch again): the next socket that closes is asked for after a second.
    conn.browserWatcher.rewatch("a1");
    ticket("t4").drop();
    expect(waits()).toEqual([1000]);
    // A watch while that ask waits leaves it waiting; the socket it brings counts as the second.
    conn.browserWatcher.rewatch("a1");
    expect(waits()).toEqual([1000]);
    clock.runNext();
    expect(renewals()).toHaveLength(4);
    ticket("t5").drop();
    expect(waits()).toEqual([2000]);
    release();
    conn.stop();
  });

  test("a picture here newer than the frame socket's last one is drawn: the server went back to this socket first", async () => {
    const { factory, sockets } = fakeSockets();
    const conn = new RealtimeConnection({ url: "ws://x/api/ws?orgId=o", createSocket: factory, pingMs: 0 });
    const seqs: unknown[] = [];
    conn.onBrowserFrame((frame) => {
      if (frame.type === "browser.frame") seqs.push(frame.seq);
    });
    conn.start();
    const socket = sockets[0] as FakeSocket;
    socket.open();
    const release = conn.browserWatcher.acquire("a1");
    socket.push({ type: "browser.frames", agentId: "a1", ticket: "t1" });
    const frames = sockets[1] as FakeSocket;
    frames.open();
    frames.onmessage?.({ data: frameBytes(10, [0xff, 0xd8]).buffer });
    // The same picture here (sent before the switch): answered, not drawn again.
    socket.push({ type: "browser.frame", agentId: "a1", seq: 10, data: "/9j/", metadata: {}, ack: true });
    expect(seqs).toEqual([10]);
    // The server's side of the frame socket closed first and it sent the next one here: drawn, though this side
    // hasn't heard the close yet (maybe never: half-open). That socket goes here too.
    socket.push({ type: "browser.frame", agentId: "a1", seq: 11, data: "/9j/", metadata: {}, ack: true });
    expect(seqs).toEqual([10, 11]);
    expect(frames.closed).toBe(true);
    // Both answered on this socket, each once.
    const acks = () => socket.sent.filter((f) => (f as { type: string }).type === "browser.ack");
    for (let i = 0; i < 20 && acks().length < 2; i++) await Bun.sleep(5);
    expect(acks()).toEqual([
      { type: "browser.ack", agentId: "a1", seq: 10 },
      { type: "browser.ack", agentId: "a1", seq: 11 },
    ]);
    // Its numbers are forgotten: a stream that starts again from 0 here is drawn.
    socket.push({ type: "browser.frame", agentId: "a1", seq: 0, data: "/9j/", metadata: {}, ack: true });
    expect(seqs).toEqual([10, 11, 0]);
    // A new ticket: bytes again, and a picture here from before them is not drawn over them.
    socket.push({ type: "browser.frames", agentId: "a1", ticket: "t2" });
    const next = sockets[2] as FakeSocket;
    next.open();
    next.onmessage?.({ data: frameBytes(12, [0xff, 0xd8]).buffer });
    socket.push({ type: "browser.frame", agentId: "a1", seq: 11, data: "/9j/", metadata: {} });
    expect(seqs).toEqual([10, 11, 0, 12]);
    release();
    conn.stop();
  });

  test("a half-open frame socket: a stream started again here is drawn, and a new frame socket asked for", () => {
    const { factory, sockets } = fakeSockets();
    const clock = manualTimers();
    const conn = new RealtimeConnection({
      url: "ws://x/api/ws?orgId=o",
      createSocket: factory,
      timers: clock.timers,
      pingMs: 0,
    });
    const seqs: unknown[] = [];
    conn.onBrowserFrame((frame) => {
      if (frame.type === "browser.frame") seqs.push(frame.seq);
    });
    conn.start();
    const socket = sockets[0] as FakeSocket;
    socket.open();
    const release = conn.browserWatcher.acquire("a1");
    socket.push({ type: "browser.frames", agentId: "a1", ticket: "t1" });
    const frames = sockets[1] as FakeSocket;
    frames.open();
    frames.onmessage?.({ data: frameBytes(500, [0xff, 0xd8], 1_700_000_000_000).buffer });
    // Captured at the same moment, sent here before the switch: not drawn over it.
    const here = (seq: number, capturedAt: number) =>
      socket.push({ type: "browser.frame", agentId: "a1", seq, data: "/9j/", metadata: { capturedAt }, ack: true });
    here(499, 1_700_000_000_000 - 100);
    here(0, 1_700_000_000_000 + 500);
    expect(seqs).toEqual([500]);
    expect(frames.closed).toBe(false);
    // The server lost that socket; the agent's browser started again (numbered from 0), captured long after.
    here(0, 1_700_000_000_000 + 60_000);
    expect(seqs).toEqual([500, 0]);
    expect(frames.closed).toBe(true);
    here(1, 1_700_000_000_000 + 61_000);
    expect(seqs).toEqual([500, 0, 1]);
    // A new ticket for the same view, never a new watch.
    expect(clock.pending.map((p) => p.ms)).toContain(1000);
    clock.pending.find((p) => p.ms === 1000)?.fn();
    expect(socket.sent.filter((f) => (f as { type: string }).type === "browser.frames.renew")).toEqual([
      { type: "browser.frames.renew", agentId: "a1" },
    ]);
    expect(socket.sent.filter((f) => (f as { type: string }).type === "browser.watch")).toHaveLength(1);
    release();
    conn.stop();
  });

  test("pictures late on the frame socket after the view ended are answered but held until it runs again", async () => {
    const { factory, sockets } = fakeSockets();
    const conn = new RealtimeConnection({ url: "ws://x/api/ws?orgId=o", createSocket: factory, pingMs: 0 });
    const seen: string[] = [];
    conn.onBrowserFrame((frame) => {
      seen.push(frame.type === "browser.frame" ? `frame ${String(frame.seq)}` : String(frame.type));
    });
    conn.start();
    const socket = sockets[0] as FakeSocket;
    socket.open();
    const release = conn.browserWatcher.acquire("a1");
    socket.push({ type: "browser.frames", agentId: "a1", ticket: "t1" });
    const frames = sockets[1] as FakeSocket;
    frames.open();
    frames.onmessage?.({ data: frameBytes(1, [0xff, 0xd8]).buffer });
    for (let i = 0; i < 20 && frames.sent.length < 1; i++) await Bun.sleep(5);
    expect(seen).toEqual(["frame 1"]);

    // The computer reconnects: the view ends on the realtime socket, then pictures sent before that arrive late on
    // the frame socket. Not drawn (the view would look live and cancel its retry), answered at once all the same.
    socket.push({ type: "browser.unavailable", agentId: "a1", reason: "reconnecting" });
    frames.onmessage?.({ data: frameBytes(2, [0xff, 0xd8]).buffer });
    frames.onmessage?.({ data: frameBytes(3, [0xff, 0xd8]).buffer });
    expect(seen).toEqual(["frame 1", "browser.unavailable"]);
    expect(frames.sent).toEqual([{ type: "ack" }, { type: "ack" }, { type: "ack" }]);
    // Its stream starts again by itself: the status, then the newest picture held meanwhile.
    socket.push({ type: "browser.status", agentId: "a1", mode: "watch" });
    expect(seen).toEqual(["frame 1", "browser.unavailable", "browser.status", "frame 3"]);
    frames.onmessage?.({ data: frameBytes(4, [0xff, 0xd8]).buffer });
    expect(seen.at(-1)).toBe("frame 4");

    // Ended (closed), with a late picture: held; watching again drops it (the watch brings the newest page).
    socket.push({ type: "browser.ended", agentId: "a1", reason: "closed" });
    frames.onmessage?.({ data: frameBytes(5, [0xff, 0xd8]).buffer });
    conn.browserWatcher.rewatch("a1");
    socket.push({ type: "browser.status", agentId: "a1", mode: "watch" });
    expect(seen.slice(-2)).toEqual(["browser.ended", "browser.status"]);
    frames.onmessage?.({ data: frameBytes(0, [0xff, 0xd8]).buffer });
    expect(seen.at(-1)).toBe("frame 0");

    // An input's refusal ends nothing: pictures go on.
    socket.push({ type: "error", agentId: "a1", code: "not_in_control" });
    frames.onmessage?.({ data: frameBytes(1, [0xff, 0xd8]).buffer });
    expect(seen.at(-1)).toBe("frame 1");
    release();
    conn.stop();
  });

  test("rate changes wait for a server that paces the view: an older one never hears browser.fps", () => {
    const { factory, sockets } = fakeSockets();
    const clock = manualTimers();
    const conn = new RealtimeConnection({
      url: "ws://x/api/ws?orgId=o",
      createSocket: factory,
      timers: clock.timers,
      pingMs: 0,
    });
    conn.start();
    const socket = sockets[0] as FakeSocket;
    socket.open();
    const rates = (s: FakeSocket) => s.sent.filter((f) => (f as { type: string }).type === "browser.fps");
    const view = conn.browserWatcher.acquire("a1", 1);
    view.setMaxFps(15);
    // Frames that ask for no answer (a server from before rates): nothing about rates goes.
    socket.push({ type: "browser.frame", agentId: "a1", seq: 1, data: "/9j/", metadata: {} });
    view.setMaxFps(1);
    view.setMaxFps(15);
    expect(rates(socket)).toEqual([]);
    // A frame that asks for an answer: the server paces the view, so the rate needed now goes, once.
    socket.push({ type: "browser.frame", agentId: "a1", seq: 2, data: "/9j/", metadata: {}, ack: true });
    expect(rates(socket)).toEqual([{ type: "browser.fps", agentId: "a1", maxFps: 15 }]);
    // From then on, at once.
    view.setMaxFps(1);
    expect(rates(socket).at(-1)).toEqual({ type: "browser.fps", agentId: "a1", maxFps: 1 });
    expect(rates(socket)).toHaveLength(2);

    // A new socket may reach another server: it shows again whether it paces. The watch made again says the rate.
    socket.drop();
    clock.runNext();
    const next = sockets[1] as FakeSocket;
    next.open();
    expect(next.sent).toEqual([{ type: "browser.watch", agentId: "a1", maxFps: 1, acks: true, frames: true }]);
    view.setMaxFps(15);
    expect(rates(next)).toEqual([]);
    // A frame socket's ticket shows it too.
    next.push({ type: "browser.frames", agentId: "a1", ticket: "t1" });
    expect(rates(next)).toEqual([{ type: "browser.fps", agentId: "a1", maxFps: 15 }]);
    view();
    conn.stop();
  });

  test("subscribes once per channel after open, routes events, unsubscribes when the last listener leaves", () => {
    const { factory, last } = fakeSockets();
    const conn = new RealtimeConnection({ url: "ws://x/api/ws?orgId=o", createSocket: factory, pingMs: 0 });
    const got: ChannelEvent[] = [];
    const offA = conn.subscribe("c1", (e) => got.push(e));
    const offB = conn.subscribe("c1", () => {});
    conn.start();
    const socket = last();
    expect(socket.sent).toEqual([]);
    socket.open();
    expect(socket.sent).toEqual([{ type: "subscribe", channelId: "c1" }]);
    const event = { type: "agent.delta", channelId: "c1", threadId: "t", runId: "r", agentId: "a", seq: 1, text: "Oi" };
    socket.push({ type: "event", channelId: "c1", event });
    socket.push({ type: "event", channelId: "other", event });
    socket.push("not json");
    expect(got).toEqual([event as ChannelEvent]);
    offA();
    expect(socket.sent).toHaveLength(1);
    offB();
    expect(socket.sent).toEqual([
      { type: "subscribe", channelId: "c1" },
      { type: "unsubscribe", channelId: "c1" },
    ]);
  });

  test("reconnects with backoff, re-subscribes, and asks to catch up over HTTP", () => {
    const { factory, sockets } = fakeSockets();
    const clock = manualTimers();
    const conn = new RealtimeConnection({
      url: "ws://x",
      createSocket: factory,
      timers: clock.timers,
      pingMs: 0,
      backoffMs: [100, 200],
    });
    let caughtUp = 0;
    const statuses: string[] = [];
    conn.onReconnect(() => caughtUp++);
    conn.onStatus((s) => statuses.push(s));
    conn.subscribe("c1", () => {});
    conn.start();
    sockets[0]?.open();
    expect(caughtUp).toBe(0);
    sockets[0]?.drop();
    expect(clock.pending.map((p) => p.ms)).toEqual([100]);
    clock.runNext();
    sockets[1]?.drop();
    expect(clock.pending.map((p) => p.ms)).toEqual([200]);
    clock.runNext();
    sockets[2]?.open();
    expect(sockets[2]?.sent).toEqual([{ type: "subscribe", channelId: "c1" }]);
    expect(caughtUp).toBe(1);
    expect(statuses).toEqual(["connecting", "open", "reconnecting", "open"]);
  });

  test("says when the server confirms a channel's subscription, again after a reconnect: its events start there", () => {
    const { factory, sockets } = fakeSockets();
    const clock = manualTimers();
    const conn = new RealtimeConnection({ url: "ws://x", createSocket: factory, timers: clock.timers, pingMs: 0 });
    const live: string[] = [];
    const off = conn.onSubscribed((channelId) => live.push(channelId));
    conn.subscribe("c1", () => {});
    conn.start();
    sockets[0]?.open();
    // Asked for, not confirmed yet: whatever the channel sends meanwhile doesn't reach us.
    expect(live).toEqual([]);
    sockets[0]?.push({ type: "subscribed", channelId: "c1" });
    expect(live).toEqual(["c1"]);
    sockets[0]?.drop();
    clock.runNext();
    sockets[1]?.open();
    sockets[1]?.push({ type: "subscribed", channelId: "c1" });
    expect(live).toEqual(["c1", "c1"]);
    off();
    sockets[1]?.push({ type: "subscribed", channelId: "c1" });
    expect(live).toEqual(["c1", "c1"]);
  });

  test("a socket that stops answering (asleep, a network change) is replaced, re-subscribes and catches up", () => {
    const { factory, sockets } = fakeSockets();
    const clock = manualTimers();
    let ping: (() => void) | null = null;
    clock.timers.setInterval = (fn) => {
      ping = fn;
      return 999;
    };
    const conn = new RealtimeConnection({
      url: "ws://x",
      createSocket: factory,
      timers: clock.timers,
      pingMs: 30_000,
      pongTimeoutMs: 10_000,
      backoffMs: [100],
    });
    let caughtUp = 0;
    conn.onReconnect(() => caughtUp++);
    const got: unknown[] = [];
    conn.subscribe("c1", (e) => got.push(e));
    conn.start();
    sockets[0]?.open();
    // Answered: still the same socket.
    (ping as unknown as () => void)();
    sockets[0]?.push({ type: "pong" });
    expect(clock.pending).toEqual([]);
    // Silent (half-open: the browser never fires close): replaced.
    conn.checkAlive();
    expect(sockets[0]?.sent.at(-1)).toEqual({ type: "ping" });
    expect(clock.pending.map((p) => p.ms)).toEqual([10_000]);
    clock.runNext();
    expect(sockets[0]?.closed).toBe(true);
    expect(conn.status).toBe("reconnecting");
    clock.runNext();
    sockets[1]?.open();
    expect(sockets[1]?.sent).toEqual([{ type: "subscribe", channelId: "c1" }]);
    expect(caughtUp).toBe(1);
    // A late close of the dead socket changes nothing.
    sockets[0]?.drop();
    expect(conn.status).toBe("open");
    const event = { type: "agent.thinking", channelId: "c1", threadId: null, agentId: "a", runId: "r" };
    sockets[1]?.push({ type: "event", channelId: "c1", event });
    expect(got).toEqual([event]);
  });

  test("a channel the server drops or refuses on a live socket is asked for again and caught up", () => {
    const { factory, sockets } = fakeSockets();
    const clock = manualTimers();
    const conn = new RealtimeConnection({
      url: "ws://x",
      createSocket: factory,
      timers: clock.timers,
      pingMs: 0,
      backoffMs: [100, 200],
    });
    const live: string[] = [];
    conn.onSubscribed((channelId) => live.push(channelId));
    const got: unknown[] = [];
    conn.subscribe("c1", (e) => got.push(e));
    conn.subscribe("c2", () => {});
    conn.start();
    const socket = sockets[0];
    if (!socket) throw new Error("no socket");
    socket.open();
    socket.push({ type: "subscribed", channelId: "c1" });
    socket.push({ type: "subscribed", channelId: "c2" });
    socket.sent.length = 0;
    // Dropped server-side (after a membership recheck): the socket stays up, the channel goes silent.
    socket.push({ type: "unsubscribed", channelId: "c1", reason: "revoked" });
    expect(clock.pending.map((p) => p.ms)).toEqual([100]);
    clock.runNext();
    expect(socket.sent).toEqual([{ type: "subscribe", channelId: "c1" }]);
    // Refused once, then allowed.
    socket.push({ type: "error", code: "forbidden", channelId: "c1" });
    expect(clock.pending.map((p) => p.ms)).toEqual([200]);
    clock.runNext();
    socket.push({ type: "subscribed", channelId: "c1" });
    expect(live).toEqual(["c1", "c2", "c1"]);
    const event = { type: "agent.thinking", channelId: "c1", threadId: null, agentId: "a", runId: "r" };
    socket.push({ type: "event", channelId: "c1", event });
    expect(got).toEqual([event]);
    // A real refusal stops after the last backoff step.
    socket.push({ type: "unsubscribed", channelId: "c1", reason: "archived" });
    clock.runNext();
    socket.push({ type: "error", code: "forbidden", channelId: "c1" });
    clock.runNext();
    socket.push({ type: "error", code: "forbidden", channelId: "c1" });
    expect(clock.pending).toEqual([]);
    // No listener left: nothing to ask for.
    socket.push({ type: "unsubscribed", channelId: "gone" });
    expect(clock.pending).toEqual([]);
  });

  test("a subscribe refused by the rate limit (no channel id) is sent again for the channels not confirmed", () => {
    const { factory, sockets } = fakeSockets();
    const clock = manualTimers();
    const conn = new RealtimeConnection({
      url: "ws://x",
      createSocket: factory,
      timers: clock.timers,
      pingMs: 0,
      backoffMs: [100],
    });
    conn.subscribe("c1", () => {});
    conn.subscribe("c2", () => {});
    conn.start();
    const socket = sockets[0];
    if (!socket) throw new Error("no socket");
    socket.open();
    socket.push({ type: "subscribed", channelId: "c1" });
    socket.push({ type: "error", code: "rate_limited" });
    socket.sent.length = 0;
    clock.runNext();
    expect(socket.sent).toEqual([{ type: "subscribe", channelId: "c2" }]);
  });

  test("a notification for a message whose message.created never came subscribes its channel anew and catches up", () => {
    const { factory, sockets } = fakeSockets();
    const clock = manualTimers();
    const conn = new RealtimeConnection({ url: "ws://x", createSocket: factory, timers: clock.timers, pingMs: 0 });
    const caughtUp: string[] = [];
    conn.onSubscribed((channelId) => caughtUp.push(channelId));
    conn.subscribe("c1", () => {});
    conn.start();
    const socket = sockets[0];
    if (!socket) throw new Error("no socket");
    socket.open();
    socket.push({ type: "subscribed", channelId: "c1" });
    socket.sent.length = 0;
    const reply = (messageId: string, channelId = "c1", readAt: string | null = null) =>
      socket.push({
        type: "event",
        scope: "user",
        event: { type: "notification.upserted", notification: { source: { channelId, messageId }, readAt } },
      });
    // Heard live first: nothing to do.
    socket.push({
      type: "event",
      channelId: "c1",
      event: { type: "message.created", channelId: "c1", messageId: "m1" },
    });
    reply("m1");
    // Read already, or in a channel nobody here listens to: nothing either.
    reply("m2", "c1", "2026-11-01T21:10:00Z");
    reply("m3", "c9");
    expect(clock.pending.map((p) => p.ms)).toEqual([]);
    // The channel went silent: the reply's notification comes, its message.created doesn't.
    reply("m4");
    expect(clock.pending.map((p) => p.ms)).toEqual([MISSED_MESSAGE_GRACE_MS]);
    clock.runNext();
    expect(socket.sent).toEqual([
      { type: "unsubscribe", channelId: "c1" },
      { type: "subscribe", channelId: "c1" },
    ]);
    socket.push({ type: "unsubscribed", channelId: "c1" });
    socket.push({ type: "subscribed", channelId: "c1" });
    expect(caughtUp).toEqual(["c1", "c1"]);
    // The answer to its own unsubscribe asked for no extra retry once the channel was confirmed.
    expect(clock.pending).toEqual([]);
    // The message.created arriving within the grace cancels it.
    reply("m5");
    socket.push({
      type: "event",
      channelId: "c1",
      event: { type: "message.created", channelId: "c1", messageId: "m5" },
    });
    socket.sent.length = 0;
    clock.runNext();
    expect(socket.sent).toEqual([]);
  });

  test("stop closes the socket and never reconnects", () => {
    const { factory, last } = fakeSockets();
    const clock = manualTimers();
    const conn = new RealtimeConnection({ url: "ws://x", createSocket: factory, timers: clock.timers, pingMs: 0 });
    conn.start();
    last().open();
    conn.stop();
    expect(last().closed).toBe(true);
    expect(clock.pending).toEqual([]);
    expect(conn.status).toBe("closed");
  });

  test("server errors reach error listeners; unknown frames are ignored", () => {
    expect(parseServerFrame('{"type":"error","code":"forbidden","channelId":"c"}')).toEqual({
      type: "error",
      code: "forbidden",
      channelId: "c",
    });
    expect(parseServerFrame("{}")).toBeNull();
    expect(parseServerFrame(42)).toBeNull();
    const { factory, last } = fakeSockets();
    const conn = new RealtimeConnection({ url: "ws://x", createSocket: factory, pingMs: 0 });
    const errors: string[] = [];
    conn.onError((code) => errors.push(code));
    conn.start();
    last().open();
    last().push({ type: "error", code: "forbidden", channelId: "c" });
    last().push({ type: "membership.revoked" });
    expect(errors).toEqual(["forbidden"]);
  });
});

describe("live agent runs: their words show whole, once posted", () => {
  const base = { channelId: "c1", threadId: "m1", runId: "r1", agentId: "atlas" };
  const delta = (seq: number, text: string): ChannelEvent => ({ type: "agent.delta", ...base, seq, text });
  type Ev = Parameters<typeof applyChannelEvent>[1];
  const tool = (name: string | null, id: string) => ({ type: "agent.tool", ...base, tool: name, toolUseId: id }) as Ev;
  const play = (events: Ev[], from = emptyStreams) => events.reduce((s, e) => applyChannelEvent(s, e), from);

  test("thinking, at a tool, writing: the run says what it does, never what it writes", () => {
    let s = applyChannelEvent(emptyStreams, { type: "agent.run", ...base, status: "running" });
    expect(runsInChannel(s, "c1")[0]?.status).toBe("thinking");
    expect(agentStateIn(s, "atlas")).toBe("thinking");
    s = play([tool("github_list_prs", "t1")], s);
    expect(runsInChannel(s, "c1")[0]).toMatchObject({ status: "thinking", tool: "github_list_prs" });
    s = play([tool(null, "t1"), { type: "agent.typing", ...base } as Ev], s);
    expect(runsInChannel(s, "c1")[0]?.status).toBe("running");
    expect(agentStateIn(s, "atlas")).toBe("writing");
    // The run event of a run that writes keeps it writing.
    s = applyChannelEvent(s, { type: "agent.run", ...base, status: "running" });
    expect(runsInChannel(s, "c1")[0]?.status).toBe("running");
    expect(Object.keys(runsInChannel(s, "c1")[0] ?? {})).not.toContain("text");
  });

  test("an older server's deltas only say it writes: their text is never kept, so nothing can show then change", () => {
    let s = applyChannelEvent(emptyStreams, { type: "agent.run", ...base, status: "running" });
    expect(runningAgents(s)).toEqual(new Set(["atlas"]));
    s = play([delta(1, "Os 401 no Sentry "), delta(2, "caíram de 312 para"), tool("azure_monitor", "t1")], s);
    const [row] = runsInChannel(s, "c1");
    expect(row?.status).toBe("thinking");
    expect(row?.work).toMatchObject([{ kind: "call", tool: "azure_monitor", running: true }]);
    expect(JSON.stringify(row)).not.toContain("Sentry");
    // Its call ended, then its message: the run is over.
    s = play([tool(null, "t1")], s);
    const message = { id: "m9", agentRunId: "r1", channelId: "c1" } as Message;
    s = applyChannelEvent(s, { type: "message.created", channelId: "c1", messageId: "m9", message });
    expect(runsInChannel(s, "c1")).toEqual([]);
    // Late events for a finished run don't bring it back.
    s = applyChannelEvent(s, delta(3, "x"));
    s = applyChannelEvent(s, { type: "agent.run", ...base, status: "done" });
    expect(runsInChannel(s, "c1")).toEqual([]);
  });

  test("a message read mid-run joins its work, and the work never holds what it said", () => {
    const read = { type: "agent.run.read", ...base, messageIds: ["m9"] } as Ev;
    const s = play([{ type: "agent.typing", ...base } as Ev, tool("check_env", "t1"), tool(null, "t1"), read]);
    const work = runsInChannel(s, "c1")[0]?.work ?? [];
    expect(work.map((w) => w.kind)).toEqual(["call", "steer"]);
  });

  test("stopped: its row goes at once, whatever it did; the message the server posts says what it wrote and who stopped it", () => {
    let s = play([{ type: "agent.typing", ...base } as Ev, tool("check_env", "t1")]);
    s = applyChannelEvent(s, { type: "run.canceled", ...base, byUserId: "u1" } as Ev);
    expect(runsInChannel(s, "c1")).toEqual([]);
  });

  test("waiting (for its computer, or an answer) isn't working: the row goes and the agent rests", () => {
    let s = applyChannelEvent(emptyStreams, { type: "agent.run", ...base, status: "running" });
    expect(agentStateIn(s, "atlas")).toBe("thinking");
    s = applyChannelEvent(s, { type: "agent.run", ...base, status: "waiting_input" } as unknown as ChannelEvent);
    expect(runsInChannel(s, "c1")).toEqual([]);
    expect(runningAgents(s)).toEqual(new Set());
    expect(agentStateIn(s, "atlas")).toBe("idle");
    // A row that still says waiting_input (an older event order) rests too.
    const row = { ...base, status: "waiting_input" } as unknown as Parameters<typeof agentStateOfRun>[0];
    expect(agentStateOfRun(row)).toBe("idle");
    // Back: the resumed run works again.
    s = applyChannelEvent(s, { type: "agent.run", ...base, status: "running" });
    expect(agentStateIn(s, "atlas")).toBe("thinking");
  });

  test("a delta before the run event still opens the run; failures keep the reason", () => {
    let s = applyChannelEvent(emptyStreams, delta(1, "Oi"));
    expect(runsInChannel(s, "c1")[0]).toMatchObject({ status: "running" });
    s = applyChannelEvent(s, { type: "agent.run", ...base, status: "failed", error: "budget_exceeded" });
    expect(runsInChannel(s, "c1")[0]).toMatchObject({ status: "failed", error: "budget_exceeded" });
    expect(runningAgents(s).size).toBe(0);
  });

  test("what a run posts inside a call (a tool's card, a DM) doesn't end it: the call's end and the reply still come", () => {
    const posted = (id: string, channelId: string, meta: Record<string, unknown>) =>
      ({
        type: "message.created",
        channelId,
        messageId: id,
        message: {
          id,
          agentRunId: "r1",
          channelId,
          threadId: channelId === "c1" ? "m1" : null,
          author: { type: "agent", id: "atlas" },
          meta,
        } as unknown as Message,
      }) as ChannelEvent;
    let s = applyChannelEvent(emptyStreams, { type: "agent.run", ...base, status: "running" });
    // As in production: the card propose_agent posts, while its call runs.
    s = applyChannelEvent(s, tool("propose_agent", "tu1"));
    s = applyChannelEvent(s, posted("m8", "c1", { actionCard: { kind: "agent_proposal" } }));
    s = applyChannelEvent(s, tool(null, "tu1"));
    // Any tool's post: a Connect card here, a DM to another agent.
    s = applyChannelEvent(s, tool("offer_connect_app", "tu2"));
    s = applyChannelEvent(s, posted("m7", "c1", { actionCard: { kind: "connect_app" } }));
    s = applyChannelEvent(s, posted("m6", "dm1", { agentNote: { runId: "r1" } }));
    s = applyChannelEvent(s, tool(null, "tu2"));
    s = applyChannelEvent(s, { type: "agent.typing", ...base } as ChannelEvent);
    const [row] = runsInChannel(s, "c1");
    expect(row?.work).toMatchObject([
      { kind: "call", tool: "propose_agent", running: false },
      { kind: "call", tool: "offer_connect_app", running: false },
    ]);
    expect(row?.status).toBe("running");
    // Its reply, with no call running, ends it.
    s = applyChannelEvent(s, posted("m9", "c1", {}));
    expect(runsInChannel(s, "c1")).toEqual([]);
  });

  test("a new run of the same agent in the channel clears its failed row", () => {
    let s = applyChannelEvent(emptyStreams, { type: "agent.run", ...base, status: "failed", error: "budget_exceeded" });
    // Another agent's run leaves it.
    s = applyChannelEvent(s, { type: "agent.run", ...base, runId: "r2", agentId: "iris", status: "running" });
    expect(runsInChannel(s, "c1").map((r) => r.runId)).toEqual([base.runId, "r2"]);
    s = applyChannelEvent(s, { type: "agent.run", ...base, runId: "r3", status: "running" });
    expect(runsInChannel(s, "c1").map((r) => r.runId)).toEqual(["r2", "r3"]);
  });
});

describe("the guessed 'pensando…' when the server is faster than the send", () => {
  test("the real run already shows: the guess goes instead of moving to the server id", () => {
    let s = expectReply(emptyStreams, { channelId: "dm", threadId: "local-1", agentId: "theo" }, 1000);
    // The run starts with the insert, so its event beats the POST answer.
    s = applyChannelEvent(s, {
      type: "agent.run",
      channelId: "dm",
      threadId: "m1",
      runId: "r1",
      agentId: "theo",
      status: "running",
    });
    expect(runsInChannel(s, "dm")).toHaveLength(2);
    s = retargetProvisional(s, "local-1", "m1");
    expect(runsInChannel(s, "dm").map((r) => r.runId)).toEqual(["r1"]);
  });

  test("no run yet: the guess moves to the server id", () => {
    let s = expectReply(emptyStreams, { channelId: "dm", threadId: "local-1", agentId: "theo" }, 1000);
    s = retargetProvisional(s, "local-1", "m1");
    expect(runsInChannel(s, "dm").map((r) => r.runId)).toEqual(["pending:theo:m1"]);
  });

  test("the send answers first, then a flat DM run starts: the run takes the guess's place", () => {
    let s = expectReply(emptyStreams, { channelId: "dm", threadId: "local-1", agentId: "theo" }, 1000);
    s = retargetProvisional(s, "local-1", "m1");
    s = applyChannelEvent(s, {
      type: "agent.run",
      channelId: "dm",
      threadId: null,
      runId: "r1",
      agentId: "theo",
      status: "running",
    } as unknown as ChannelEvent);
    const runs = runsInChannel(s, "dm");
    expect(runs.map((r) => r.runId)).toEqual(["r1"]);
    expect(runs[0]?.triggerMessageId).toBe("m1");
  });
});

describe("a run parked waiting for its computer (never 'working' forever)", () => {
  test("a flat DM's 'pensando…' rows go when the agent's run stops; a waiting run is not in the working bar", () => {
    // Two quick messages to Ada in a DM: provisional rows on each message.
    let s = expectReply(emptyStreams, { channelId: "dm", threadId: "m1", agentId: "ada" });
    s = expectReply(s, { channelId: "dm", threadId: "m2", agentId: "ada" });
    s = expectReply(s, { channelId: "other", threadId: "m3", agentId: "ada" });
    expect(runsInChannel(s, "dm")).toHaveLength(2);
    // The server looked again and the run parks (flat DM: no thread).
    s = applyChannelEvent(s, {
      type: "agent.run",
      channelId: "dm",
      threadId: null,
      runId: "r1",
      agentId: "ada",
      status: "waiting_input",
    } as unknown as ChannelEvent);
    const names = (id: string) => id;
    expect(
      barEntries(
        runsInChannel(s, "dm").filter((r) => !r.provisional),
        [],
        names,
        names,
      ),
    ).toEqual([]);
    s = applyChannelEvent(s, {
      type: "agent.idle",
      channelId: "dm",
      threadId: null,
      runId: "r1",
      agentId: "ada",
    } as unknown as ChannelEvent);
    expect(runsInChannel(s, "dm")).toEqual([]);
    // Another channel's row is not this run's.
    expect(runsInChannel(s, "other")).toHaveLength(1);
  });
});

describe("user events and resumed runs", () => {
  test("user-scope frames reach onUserEvent, not channel listeners", () => {
    const { factory, last } = fakeSockets();
    const conn = new RealtimeConnection({ url: "ws://x", createSocket: factory, pingMs: 0 });
    const user: unknown[] = [];
    const channel: unknown[] = [];
    conn.onUserEvent((e) => user.push(e));
    conn.subscribe("c1", (e) => channel.push(e));
    conn.start();
    last().open();
    const budget = { type: "budget.warning", agentId: "a", percent: 80 };
    last().push({ type: "event", scope: "user", event: budget });
    expect(user).toEqual([budget]);
    expect(channel).toEqual([]);
  });

  test("a run resumed after an approval works again", () => {
    const base = { channelId: "c1", threadId: "m1", runId: "r1", agentId: "ada" };
    let s = applyChannelEvent(emptyStreams, { type: "agent.typing", ...base } as ChannelEvent);
    s = applyChannelEvent(s, {
      type: "message.created",
      channelId: "c1",
      messageId: "m2",
      message: { id: "m2", agentRunId: "r1" } as Message,
    });
    expect(runsInChannel(s, "c1")).toEqual([]);
    s = applyChannelEvent(s, { type: "agent.run", ...base, status: "running" });
    s = applyChannelEvent(s, { type: "agent.typing", ...base } as ChannelEvent);
    expect(runsInChannel(s, "c1")[0]?.status).toBe("running");
  });
});

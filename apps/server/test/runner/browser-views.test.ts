import { expect, test } from "bun:test";
import {
  BROWSER_VIEW,
  decodeBrowserFrame,
  type RunnerFrame,
  STREAM_CLOSE,
} from "@agenteschat/adapters/machine-protocol";
import { BrowserViews } from "../../runner/browser-views";
import type { DataListener, DataSocket } from "../../runner/streams";
import { waitFor } from "./helpers";

type Frame = Extract<RunnerFrame, { type: "browser.frame" }>;

/** A view's data socket in memory: what went out on it, how it closed, and the server's side to answer on. */
class FakeData {
  sent: Uint8Array[] = [];
  closed: { code?: number; reason?: string } | null = null;
  listener: DataListener | null = null;
  /** Bytes still waiting to leave (the socket's `bufferedAmount`). */
  buffered = 0;
  readonly socket: DataSocket;
  constructor() {
    const fake = this;
    this.socket = {
      send: (data) => {
        if (typeof data !== "string") fake.sent.push(data);
      },
      close: (code, reason) => {
        if (fake.closed) return;
        fake.closed = { code, reason };
        fake.listener?.closed();
      },
      get bufferedAmount() {
        return fake.buffered;
      },
      listen: (on) => {
        fake.listener = on;
      },
    };
  }
  /** The server answers a frame. */
  ack() {
    this.listener?.control?.({ type: "ack" });
  }
  /** The frames sent, as their `seq`. */
  seqs() {
    return this.sent.map((bytes) => decodeBrowserFrame(bytes)?.seq);
  }
}

const frame = (agentId: string, seq: number): Frame => ({
  type: "browser.frame",
  agentId,
  seq,
  data: Buffer.from([0xff, 0xd8, seq, 0xff, 0xd9]).toString("base64"),
  metadata: { deviceWidth: 1280, deviceHeight: 800, url: "https://shop.example.com/" },
});

function setup(opts: { window?: number; stallMs?: number } = {}) {
  const dialed: { streamId: string; data: FakeData }[] = [];
  const logs: string[] = [];
  const rooms: string[] = [];
  const handed: Frame[] = [];
  const views = new BrowserViews({
    ...opts,
    fallback: (frame) => void handed.push(frame),
    dial: async (streamId) => {
      const data = new FakeData();
      dialed.push({ streamId, data });
      return data.socket;
    },
    log: (line) => logs.push(line),
  });
  views.onRoom = (agentId) => rooms.push(agentId);
  return { views, dialed, logs, rooms, handed, last: () => dialed.at(-1)?.data as FakeData };
}

test("an agent with no view: its frames are the caller's to send as before", () => {
  const { views } = setup();
  expect(views.push(frame("ana", 1))).toBe(false);
});

test("a view's frames go as bytes, at most the window's on their way; only the newest waits for an ack", async () => {
  const { views, dialed, last } = setup({ window: 2 });
  expect(await views.open("ana", "S".repeat(43))).toEqual({ opened: true });
  expect(dialed[0]?.streamId).toBe("S".repeat(43));
  const data = last();
  for (const seq of [1, 2, 3, 4]) expect(views.push(frame("ana", seq))).toBe(true);
  // 3 never goes: 4 came while the window was still full.
  expect(data.seqs()).toEqual([1, 2]);
  const sent = decodeBrowserFrame(data.sent[0] as Uint8Array);
  expect(sent?.metadata).toEqual(frame("ana", 1).metadata);
  expect([...(sent?.jpeg ?? [])]).toEqual([0xff, 0xd8, 1, 0xff, 0xd9]);
  data.ack();
  expect(data.seqs()).toEqual([1, 2, 4]);
  // Acks with nothing waiting free the window for what comes next.
  data.ack();
  data.ack();
  views.push(frame("ana", 5));
  views.push(frame("ana", 6));
  expect(data.seqs()).toEqual([1, 2, 4, 5, 6]);
  // Another agent's frames aren't this view's.
  expect(views.push(frame("bia", 1))).toBe(false);
});

test("the window is the contract's on every hop", async () => {
  const { views, last } = setup();
  await views.open("ana", "S".repeat(43));
  for (let seq = 1; seq <= BROWSER_VIEW.window + 2; seq++) views.push(frame("ana", seq));
  expect(last().seqs()).toHaveLength(BROWSER_VIEW.window);
  views.end("ana");
});

test("a full window with no ack for a while is a dead socket: the view ends, and frames go as before", async () => {
  const { views, last, logs, rooms } = setup({ window: 1, stallMs: 5 });
  await views.open("ana", "S".repeat(43));
  for (const seq of [1, 2, 3]) expect(views.push(frame("ana", seq))).toBe(true);
  expect(last().seqs()).toEqual([1]);
  await waitFor(() => last().closed !== null);
  // Never written into the dead socket: the server opens a new view.
  expect(last().seqs()).toEqual([1]);
  expect(last().closed?.code).toBe(STREAM_CLOSE.viewTooSlow);
  expect(views.viewing()).toEqual([]);
  expect(views.push(frame("ana", 4))).toBe(false);
  // Its stream sends its next frame, now on the machine socket.
  expect(rooms).toEqual(["ana"]);
  // One line says what it did: 1 sent, 2 waited and 3 took its place.
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain("no acknowledgement");
  expect(logs[0]).toContain("1 frames");
  expect(logs[0]).toContain("1 skipped");
  // A late ack of the dead socket changes nothing.
  last().ack();
  expect(rooms).toEqual(["ana"]);
});

test("a full window stalls with nothing waiting too: a paced stream sends nothing until there is room", async () => {
  const { views, last, rooms } = setup({ window: 1, stallMs: 5 });
  await views.open("ana", "S".repeat(43));
  views.push(frame("ana", 1));
  await waitFor(() => last().closed !== null);
  expect(last().closed?.code).toBe(STREAM_CLOSE.viewTooSlow);
  expect(rooms).toEqual(["ana"]);
});

test("a full window whose bytes are still leaving is a slow uplink, not a dead socket: it waits for the ack", async () => {
  const { views, last } = setup({ window: 1, stallMs: 50 });
  await views.open("ana", "S".repeat(43));
  const data = last();
  data.buffered = 300_000;
  views.push(frame("ana", 1));
  views.push(frame("ana", 2));
  // Past one stall: half of it left meanwhile.
  data.buffered = 150_000;
  await new Promise((r) => setTimeout(r, 75));
  expect(data.closed).toBeNull();
  data.buffered = 0;
  data.ack();
  expect(data.seqs()).toEqual([1, 2]);
  // Then nothing leaves and no ack comes: a dead socket.
  await waitFor(() => data.closed !== null);
  expect(data.closed?.code).toBe(STREAM_CLOSE.viewTooSlow);
});

test("a socket that keeps draining but never acks still ends, after a few stalls", async () => {
  const { views, last } = setup({ window: 1, stallMs: 10 });
  await views.open("ana", "S".repeat(43));
  const data = last();
  data.buffered = 1_000_000;
  const start = Date.now();
  views.push(frame("ana", 1));
  const draining = setInterval(() => {
    data.buffered = Math.max(1, data.buffered - 1000);
  }, 2);
  try {
    await waitFor(() => data.closed !== null);
  } finally {
    clearInterval(draining);
  }
  expect(data.closed?.code).toBe(STREAM_CLOSE.viewTooSlow);
  expect(Date.now() - start).toBeGreaterThanOrEqual(30);
});

test("a new view starts with the agent's newest frame, until its stream ends", async () => {
  const { views, dialed } = setup({ window: 1, stallMs: 5 });
  await views.open("ana", "A".repeat(43));
  const first = dialed[0]?.data as FakeData;
  for (const seq of [1, 2, 3]) views.push(frame("ana", seq));
  await waitFor(() => first.closed !== null);
  // 3 waited in the dead view and never went: an idle page sends nothing newer, so the next view starts with it.
  await views.open("ana", "B".repeat(43));
  expect((dialed[1] as { data: FakeData }).data.seqs()).toEqual([3]);
  // The server closed it; frames meanwhile went on the machine socket, and the newest of them is the next view's.
  (dialed[1] as { data: FakeData }).data.socket.close(STREAM_CLOSE.restarting);
  expect(views.push(frame("ana", 4))).toBe(false);
  await views.open("ana", "C".repeat(43));
  expect((dialed[2] as { data: FakeData }).data.seqs()).toEqual([4]);
  // The stream ended: a view of its next stream waits for that stream's frames.
  views.end("ana");
  await views.open("ana", "D".repeat(43));
  expect((dialed[3] as { data: FakeData }).data.seqs()).toEqual([]);
  // So does one after the connection dropped.
  views.push(frame("ana", 5));
  views.closeAll();
  await views.open("ana", "E".repeat(43));
  expect((dialed[4] as { data: FakeData }).data.seqs()).toEqual([]);
  views.closeAll();
});

test("room: said when an ack frees the window with nothing waiting, and when the view ends", async () => {
  const { views, last, rooms } = setup({ window: 2 });
  // No view: always room.
  expect(views.room("ana")).toBe(true);
  expect(views.has("ana")).toBe(false);
  await views.open("ana", "S".repeat(43));
  expect(views.has("ana")).toBe(true);
  views.push(frame("ana", 1));
  expect(views.room("ana")).toBe(true);
  views.push(frame("ana", 2));
  expect(views.room("ana")).toBe(false);
  views.push(frame("ana", 3));
  expect(views.room("ana")).toBe(false);
  // The ack sends 3, which fills the window again: no room to say yet.
  last().ack();
  expect(last().seqs()).toEqual([1, 2, 3]);
  expect(rooms).toEqual([]);
  last().ack();
  expect(views.room("ana")).toBe(true);
  expect(rooms).toEqual(["ana"]);
  // Another agent's room is its own.
  expect(views.room("bia")).toBe(true);
  views.end("ana");
  expect(rooms).toEqual(["ana", "ana"]);
  expect(views.room("ana")).toBe(true);
});

test("a view ends with its stream, its socket, the connection, or a new view of the same agent", async () => {
  const { views, dialed } = setup();
  await views.open("ana", "A".repeat(43));
  await views.open("bia", "B".repeat(43));
  const [ana, bia] = dialed.map((d) => d.data) as [FakeData, FakeData];
  // The stream ended: its view closes, and frames go back to the caller.
  views.end("ana");
  expect(ana.closed?.code).toBe(STREAM_CLOSE.normal);
  expect(views.push(frame("ana", 1))).toBe(false);
  // The server closed it.
  bia.socket.close(STREAM_CLOSE.restarting);
  expect(views.push(frame("bia", 1))).toBe(false);
  // A new view of the same agent replaces the one it had.
  await views.open("ana", "C".repeat(43));
  await views.open("ana", "D".repeat(43));
  expect(dialed[2]?.data.closed?.code).toBe(STREAM_CLOSE.normal);
  expect(views.viewing()).toEqual(["ana"]);
  views.closeAll();
  expect(dialed[3]?.data.closed?.code).toBe(STREAM_CLOSE.normal);
  expect(views.viewing()).toEqual([]);
});

test("a view that dies while its stream runs hands its newest frame to the machine socket; one that ends doesn't", async () => {
  const { views, dialed, handed } = setup({ window: 1, stallMs: 5 });
  await views.open("ana", "A".repeat(43));
  for (const seq of [1, 2]) views.push(frame("ana", seq));
  // No ack: dead. The newest (2, held and never sent) goes the other way, once.
  await waitFor(() => handed.length === 1);
  expect(handed.map((f) => f.seq)).toEqual([2]);
  // The server closed a view: the same.
  await views.open("ana", "B".repeat(43));
  views.push(frame("ana", 3));
  (dialed[1] as { data: FakeData }).data.socket.close(STREAM_CLOSE.restarting);
  expect(handed.map((f) => f.seq)).toEqual([2, 3]);
  // A view replaced by a new one, or ended with its stream, hands nothing over.
  await views.open("ana", "C".repeat(43));
  await views.open("ana", "D".repeat(43));
  views.end("ana");
  expect(handed.map((f) => f.seq)).toEqual([2, 3]);
});

test("a dial that fails leaves no view: frames go as before", async () => {
  const views = new BrowserViews({ dial: () => Promise.reject(new Error("refused")) });
  await expect(views.open("ana", "S".repeat(43))).rejects.toThrow("refused");
  expect(views.push(frame("ana", 1))).toBe(false);
});

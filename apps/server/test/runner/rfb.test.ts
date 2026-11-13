import { afterEach, expect, test } from "bun:test";
import type net from "node:net";
import path from "node:path";
import { type AgentScope, STREAM_CLOSE } from "@agenteschat/adapters/machine-protocol";
import { connectVnc, openDesktopStream, serveNone, vncAuthResponse } from "../../runner/rfb";
import {
  desktopOn,
  errorCode,
  fakeXvnc as fakeXvncIn,
  memoryDataSocket,
  VNC_PASSWORDS as PASSWORDS,
  removeDirs,
  tempDir,
  waitFor,
} from "./helpers";

const dirs: string[] = [];
const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
  removeDirs(dirs);
});

async function fakeXvnc() {
  const dir = tempDir("rfb-");
  dirs.push(dir);
  const x = await fakeXvncIn(dir);
  closers.push(x.close);
  return x;
}

const dev: AgentScope = { id: "01a142cb-489d-7000-87a3-efb5adb382ca", handle: "dev", name: "Dev" };
const VERSION = "RFB 003.008\n";

/** The runner's side of the handshake and the desktop's ServerInit ("Dev"): 12 + 2 + 4 + 24 + 3 bytes. */
const SERVER_SIDE = 45;

/**
 * The viewer's side of the handshake (as noVNC does it): the runner's whole side comes before the viewer says
 * anything, then the version, None and ClientInit; returns the ServerInit.
 */
async function viewerHandshake(data: ReturnType<typeof memoryDataSocket>, shared = 0) {
  await waitFor(() => data.bytes().length >= SERVER_SIDE);
  expect([...data.bytes().subarray(0, 18)]).toEqual([...Buffer.from(VERSION, "latin1"), 1, 1, 0, 0, 0, 0]);
  data.send(VERSION);
  data.send(Uint8Array.of(1));
  data.send(Uint8Array.of(shared));
  return data.bytes().subarray(18);
}

/**
 * noVNC 1.7's handshake as its socket's messages drive it (`_handleMessage` → `_initMsg`, core/rfb.js): one pass a
 * frame, which goes from step to step while their bytes are there, except that the version's step ends its pass.
 * What it answers, and whether it connected (its ServerInit read).
 */
function noVnc() {
  let q = Buffer.alloc(0);
  let step: "version" | "security" | "result" | "init" | "connected" = "version";
  const answers: number[][] = [];
  const pass = () => {
    for (;;) {
      if (step === "version") {
        if (q.length < 12) return;
        q = q.subarray(12);
        answers.push([...Buffer.from(VERSION, "latin1")]);
        step = "security";
        return;
      }
      if (step === "security") {
        const n = q[0];
        if (n === undefined || q.length < 1 + n) return;
        q = q.subarray(1 + n);
        answers.push([1]);
        step = "result";
      } else if (step === "result") {
        if (q.length < 4) return;
        q = q.subarray(4);
        answers.push([1]);
        step = "init";
      } else if (step === "init") {
        if (q.length < 24 || q.length < 24 + q.readUInt32BE(20)) return;
        q = q.subarray(24 + q.readUInt32BE(20));
        step = "connected";
      } else return;
    }
  };
  return {
    message: (frame: Buffer) => {
      q = Buffer.concat([q, frame]);
      pass();
    },
    answers,
    connected: () => step === "connected",
  };
}

test("the runner's side of the handshake and the desktop's ServerInit go before the viewer answers anything, a frame a step: noVNC connects on them alone", async () => {
  const x = await fakeXvnc();
  const { desktops } = desktopOn(x.socketPath);
  const data = memoryDataSocket();
  await openDesktopStream(desktops, dev, "watch", async () => data.socket);
  // Nothing from the viewer yet: one trip to the person, where waiting for each answer made it four.
  await waitFor(() => data.bytes().length >= SERVER_SIDE);
  const frames = data.sent.map((f) => Buffer.from(f));
  expect(frames.slice(0, 3).map((f) => [...f])).toEqual([[...Buffer.from(VERSION, "latin1")], [1, 1], [0, 0, 0, 0]]);
  expect(x.logins[0]).toMatchObject({ password: "view", shared: 1 });
  const viewer = noVnc();
  for (const frame of frames) viewer.message(frame);
  expect(viewer.connected()).toBe(true);

  // Its answers, then a request: the desktop gets the request once the answers checked out, and its update comes.
  for (const answer of viewer.answers) data.send(Uint8Array.from(answer));
  const before = data.bytes().length;
  data.send(Uint8Array.of(3, 0, 0, 0, 0, 0, 5, 0, 3, 32));
  await waitFor(() => data.bytes().length === before + 4);
  expect(x.logins[0]?.got[0]).toBe(3);
});

test("VncAuth: DES-ECB of the challenge, the password as the key with each byte's bits reversed", () => {
  const challenge = Uint8Array.from({ length: 16 }, (_, i) => i);
  expect(vncAuthResponse("password", challenge).toString("hex")).toBe("b866924125c8eebb9debc1db61c538e2");
  // A password is 8 bytes at most: what follows never counts.
  expect(vncAuthResponse("password-and-more", challenge)).toEqual(vncAuthResponse("password", challenge));
});

test("connectVnc logs in with the password it is given; a wrong one is refused with the desktop's reason", async () => {
  const x = await fakeXvnc();
  const full = await connectVnc(x.socketPath, PASSWORDS.full);
  const view = await connectVnc(x.socketPath, PASSWORDS.view);
  expect(x.logins.map((l) => l.password)).toEqual(["full", "view"]);
  expect(full.leftover.length).toBe(0);
  full.socket.destroy();
  view.socket.destroy();
  await expect(connectVnc(x.socketPath, "Wrong234")).rejects.toThrow("refused the runner's password: bad password");
  expect(await errorCode(() => connectVnc(path.join(path.dirname(x.socketPath), "gone.sock"), "x"))).toBe(
    "desktop_off",
  );
});

test("a watcher: RFB 3.8 with security None, its ClientInit passed on as shared, the view-only login; its pointer is ignored", async () => {
  const x = await fakeXvnc();
  const { desktops, holds } = desktopOn(x.socketPath);
  const data = memoryDataSocket();
  await openDesktopStream(desktops, dev, "watch", async () => data.socket);
  expect(holds).toEqual({ taken: 1, released: 0 });
  const init = await viewerHandshake(data, 0);
  expect(init.readUInt16BE(0)).toBe(1280);
  expect(init.readUInt16BE(2)).toBe(800);
  expect(init.subarray(24).toString()).toBe("Dev");
  expect(x.logins[0]).toMatchObject({ password: "view", shared: 1 });

  data.send(Uint8Array.of(5, 0, 0, 100, 0, 120));
  await waitFor(() => (x.logins[0]?.got.length ?? 0) >= 6);
  expect(x.desktop.pointer).toEqual([640, 400]);
});

test("the person in control logs in with the full password; bytes go both ways as they are", async () => {
  const x = await fakeXvnc();
  const { desktops } = desktopOn(x.socketPath);
  const data = memoryDataSocket();
  await openDesktopStream(desktops, dev, "control", async () => data.socket);
  await viewerHandshake(data, 1);
  expect(x.logins[0]).toMatchObject({ password: "full", shared: 1 });

  data.send(Uint8Array.of(5, 0, 0, 100, 0, 120));
  await waitFor(() => x.desktop.pointer[0] === 100);
  expect(x.desktop.pointer).toEqual([100, 120]);
  const before = data.bytes().length;
  x.logins[0]?.socket.write(Uint8Array.of(0, 0, 0, 1, 9, 9));
  await waitFor(() => data.bytes().length === before + 6);
  expect([...data.bytes().subarray(before)]).toEqual([0, 0, 0, 1, 9, 9]);
});

/** What the runner sent from frame `from` on: text frames as they are, binary ones as their bytes. */
const framesFrom = (data: ReturnType<typeof memoryDataSocket>, from: number) =>
  data.sent.slice(from).map((f) => (typeof f === "string" ? f : [...f]));

test("the server's switch, in place: the old login goes with nothing more of it sent, the frame back marks where its session ends, and a new session in that mode follows on the same socket", async () => {
  const x = await fakeXvnc();
  const { desktops, holds } = desktopOn(x.socketPath);
  const data = memoryDataSocket();
  await openDesktopStream(desktops, dev, "watch", async () => data.socket);
  await viewerHandshake(data);
  const pointer = Uint8Array.of(5, 0, 0, 100, 0, 120);
  data.send(pointer);
  await waitFor(() => (x.logins[0]?.got.length ?? 0) >= 6);
  expect(x.desktop.pointer).toEqual([640, 400]);

  let from = data.sent.length;
  data.control({ type: "mode", mode: "control" });
  await waitFor(() => data.bytes().length >= 2 * SERVER_SIDE);
  await waitFor(() => x.logins[0]?.socket.destroyed === true);
  expect(x.logins[1]).toMatchObject({ password: "full", shared: 1 });
  expect(framesFrom(data, from).slice(0, 4)).toEqual([
    '{"type":"mode","mode":"control"}',
    [...Buffer.from(VERSION, "latin1")],
    [1, 1],
    [0, 0, 0, 0],
  ]);
  // The new session's answers, then the person's pointer: the desktop takes it now.
  data.send(VERSION);
  data.send(Uint8Array.of(1));
  data.send(Uint8Array.of(1));
  data.send(pointer);
  await waitFor(() => x.desktop.pointer[0] === 100);

  // Handed back: a view-only login again, the person's pointer ignored, the same stream all along.
  from = data.sent.length;
  data.control({ type: "mode", mode: "watch" });
  await waitFor(() => data.bytes().length >= 3 * SERVER_SIDE);
  expect(framesFrom(data, from)[0]).toBe('{"type":"mode","mode":"watch"}');
  expect(x.logins[2]).toMatchObject({ password: "view", shared: 1 });
  await waitFor(() => x.logins[1]?.socket.destroyed === true);
  data.send(Buffer.concat([Buffer.from(VERSION, "latin1"), Buffer.from([1, 1, 5, 0, 0, 7, 0, 9])]));
  await waitFor(() => (x.logins[2]?.got.length ?? 0) >= 6);
  expect(x.desktop.pointer).toEqual([100, 120]);
  expect(data.closed).toBeNull();
  expect(holds).toEqual({ taken: 1, released: 0 });
});

test("a switch the computer can't take now (control on a paused computer) closes the stream with 1011: the viewer opens it again", async () => {
  const x = await fakeXvnc();
  const { desktops, holds } = desktopOn(x.socketPath);
  const data = memoryDataSocket();
  const paused = (mode: string) => {
    if (mode === "control") throw new Error("paused");
  };
  await openDesktopStream(desktops, dev, "watch", async () => data.socket, paused);
  await viewerHandshake(data);
  data.control({ type: "mode", mode: "control" });
  await waitFor(() => data.closed !== null);
  expect(data.closed?.code).toBe(STREAM_CLOSE.internal);
  expect(x.logins).toHaveLength(1);
  await waitFor(() => holds.released === 1);
});

test("either side closing ends the stream: the desktop's end closes the data socket with 1011, the viewer's the desktop's connection", async () => {
  const x = await fakeXvnc();
  const { desktops, holds } = desktopOn(x.socketPath);
  const first = memoryDataSocket();
  await openDesktopStream(desktops, dev, "watch", async () => first.socket);
  await viewerHandshake(first);
  x.logins[0]?.socket.destroy();
  await waitFor(() => first.closed !== null);
  expect(first.closed?.code).toBe(STREAM_CLOSE.internal);
  await waitFor(() => holds.released === 1);

  const second = memoryDataSocket();
  await openDesktopStream(desktops, dev, "watch", async () => second.socket);
  await viewerHandshake(second);
  const closed = new Promise<void>((resolve) => x.logins[1]?.socket.once("close", () => resolve()));
  second.end();
  await closed;
  await waitFor(() => holds.released === 2);
});

test("a viewer that speaks anything but RFB 3.8 with None is closed (1000: no retry), and the desktop got nothing of it", async () => {
  const x = await fakeXvnc();
  const { desktops } = desktopOn(x.socketPath);
  const request = [3, 0, 0, 0, 0, 0, 5, 0, 3, 32];
  const data = memoryDataSocket();
  await openDesktopStream(desktops, dev, "watch", async () => data.socket);
  await waitFor(() => data.bytes().length >= SERVER_SIDE);
  data.send(Buffer.concat([Buffer.from("RFB 003.003\n", "latin1"), Buffer.from([1, 1, ...request])]));
  await waitFor(() => data.closed !== null);
  expect(data.closed).toEqual({ code: STREAM_CLOSE.normal, reason: "RFB 3.8 only" });

  const other = memoryDataSocket();
  await openDesktopStream(desktops, dev, "watch", async () => other.socket);
  await waitFor(() => other.bytes().length >= SERVER_SIDE);
  other.send(Buffer.concat([Buffer.from(VERSION, "latin1"), Buffer.from([2, 1, ...request])]));
  await waitFor(() => other.closed !== null);
  expect(other.closed).toEqual({ code: STREAM_CLOSE.normal, reason: "security type None only" });
  await waitFor(() => x.logins.every((l) => l.socket.destroyed));
  expect(x.logins.map((l) => l.got.length)).toEqual([0, 0]);
});

test("reading from the desktop pauses while the data socket holds more than its limit, and goes on once it drained", async () => {
  const x = await fakeXvnc();
  const vnc = await connectVnc(x.socketPath, PASSWORDS.view);
  const data = memoryDataSocket();
  void serveNone(data.socket, vnc, { bufferedMax: 100 });
  await viewerHandshake(data);
  const desktopSide = x.logins[0]?.socket as net.Socket;
  const sent = () => data.bytes().length;
  const start = sent();
  data.buffered = 1000;
  desktopSide.write(Uint8Array.of(1, 1, 1));
  await waitFor(() => sent() === start + 3);
  desktopSide.write(Uint8Array.of(2, 2));
  await Bun.sleep(100);
  expect(sent()).toBe(start + 3);
  data.buffered = 0;
  await waitFor(() => sent() === start + 5);
  expect([...data.bytes().subarray(start)]).toEqual([1, 1, 1, 2, 2]);
});

test("refused: a desktop that isn't running, one with as many viewers as it takes; a failed dial lets go of the desktop", async () => {
  const x = await fakeXvnc();
  const off = desktopOn(x.socketPath, { running: false });
  expect(
    await errorCode(() => openDesktopStream(off.desktops, dev, "watch", async () => memoryDataSocket().socket)),
  ).toBe("desktop_off");
  const on = desktopOn(x.socketPath);
  for (let i = 0; i < 4; i++) await openDesktopStream(on.desktops, dev, "watch", async () => memoryDataSocket().socket);
  expect(
    await errorCode(() => openDesktopStream(on.desktops, dev, "watch", async () => memoryDataSocket().socket)),
  ).toBe("too_many_streams");

  const lone = desktopOn(x.socketPath);
  const failing = openDesktopStream(lone.desktops, dev, "control", async () => {
    throw new Error("no data socket");
  });
  await expect(failing).rejects.toThrow("no data socket");
  expect(lone.holds).toEqual({ taken: 1, released: 1 });
  const last = x.logins.at(-1)?.socket as net.Socket;
  await waitFor(() => last.destroyed);
});

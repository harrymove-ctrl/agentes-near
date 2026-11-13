import { afterEach, expect, test } from "bun:test";
import { decodeBrowserFrame, encodeBrowserFrame, type ServerFrame, STREAM_CLOSE } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  BROWSER_SCOPE,
  type BrowserLiveDeps,
  type BrowserLiveMessage,
  browserFrameBase64,
  browserFrameBytes,
  createBrowserLive,
  createBrowserToolSource,
  grantScopes,
  type MachineCaller,
  MachineDroppedError,
  type MachineHub,
  MachineOfflineError,
  withConnectedMachine,
} from "../src";
import { type Fixture, setup } from "./fixtures";
import { pairMachine, RUNNER } from "./machine-fixtures";
import { runContext } from "./mail-fixtures";
import { fakeSocket } from "./stream-fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.machineHub?.stop();
  await f?.close();
  f = undefined as never;
});

type Request = Extract<ServerFrame, { type: "request" }>;

/** What the fake runner's browser shows after any command. */
const PAGE = { snapshot: '- heading "agentes.chat" [ref=e1]', origin: "https://app.agentes.chat/" };

/**
 * A runner over an in-memory socket that answers the live view's ops. `dead`: its socket's close never
 * arrives (a runner that restarted behind a proxy). `closedBrowser`: its agent's browser isn't open.
 * `viewError`: what it answers `browser.view.open` with.
 */
function browserRunner(hub: MachineHub, opts: { dead?: boolean; closedBrowser?: boolean; viewError?: string } = {}) {
  const got: Request[] = [];
  const reply = (frame: unknown) => hub.message(conn, JSON.stringify(frame));
  const socket = {
    send(text: string) {
      const frame = JSON.parse(text) as ServerFrame;
      if (frame.type !== "request") return;
      got.push(frame);
      setTimeout(() => {
        const ok = (data: unknown) => void reply({ type: "result", id: frame.id, ok: true, data });
        if (frame.op === "browser.stream.start") {
          if (!opts.closedBrowser) return ok({ mode: (frame as unknown as { mode: string }).mode });
          return void reply({
            type: "result",
            id: frame.id,
            ok: false,
            error: { code: "browser_closed", message: "The agent's browser isn't open" },
          });
        }
        if (frame.op === "browser.stream.stop") return ok({ stopped: true });
        if (frame.op === "browser.view.open" && opts.viewError) {
          return void reply({
            type: "result",
            id: frame.id,
            ok: false,
            error: { code: opts.viewError, message: "no view socket" },
          });
        }
        if (frame.op === "browser.warm") return ok({ started: false });
        if (frame.op === "browser.batch") {
          const { commands } = frame as unknown as { commands: { command: string }[] };
          return ok({ answers: commands.map((c) => ({ success: true, data: c.command === "snapshot" ? PAGE : {} })) });
        }
        return ok({ success: true, data: { url: "https://facebook.com/login" } });
      }, 1);
    },
    close() {
      if (!opts.dead) void hub.close(conn);
    },
  };
  const conn = hub.open(socket);
  return {
    conn,
    starts: () => got.filter((r) => r.op === "browser.stream.start"),
    views: () => got.filter((r) => r.op === "browser.view.open") as (Request & { streamId: string })[],
    batches: () => got.filter((r) => r.op === "browser.batch"),
    hello: (token: string) =>
      hub.message(
        conn,
        JSON.stringify({
          type: "hello",
          token,
          ...RUNNER,
          exec: true,
          browser: { available: true, version: "0.39.1" },
          access: { folders: [], tools: { claude: true, codex: true, commands: true, browser: true } },
        }),
      ),
    frame: (seq: number) =>
      reply({
        type: "browser.frame",
        agentId: f.agent.id,
        seq,
        data: "/9j/AAAA",
        metadata: { deviceWidth: 1280, deviceHeight: 720 },
      }),
  };
}

async function liveSetup(extra: Partial<BrowserLiveDeps> = {}) {
  f = await setup({ machines: true });
  const hub = f.machineHub as MachineHub;
  const paired = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "VPS" });
  await f.db.update(schema.agents).set({ machineId: paired.machineId }).where(eq(schema.agents.id, f.agent.id));
  await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: BROWSER_SCOPE }]);
  const live = createBrowserLive({ db: f.db, pubsub: f.pubsub, hub, stopDelayMs: 1, ...extra });
  hub.setBrowserHooks(live.hubHooks);
  const got: BrowserLiveMessage[] = [];
  const viewer = { userId: f.owner.id, send: (m: BrowserLiveMessage) => got.push(m) };
  return { hub, paired, live, got, viewer };
}

const kinds = (got: BrowserLiveMessage[]) =>
  got.map((m) => (m.type === "browser.unavailable" ? `unavailable:${m.reason}` : m.type));

const until = async (done: () => boolean) => {
  for (let i = 0; i < 100 && !done(); i++) await Bun.sleep(5);
};

test("a runner at protocol 49 gets the view's own socket: frames come as bytes, each acknowledged", async () => {
  const { hub, paired, live, got, viewer } = await liveSetup();
  const runner = browserRunner(hub);
  await runner.hello(paired.token);
  const { stop, streaming } = await live.watch(viewer, f.org.id, f.agent.id);
  expect(streaming).toBe(true);
  await until(() => runner.views().length === 1 && runner.starts().length === 1);
  const open = runner.views()[0] as Request & { streamId: string };
  expect(open).toMatchObject({ op: "browser.view.open", agent: { id: f.agent.id } });
  const seqs = () => got.flatMap((m) => (m.type === "browser.frame" ? [m.seq] : []));
  // Until its socket is there, frames on the machine socket show.
  await runner.frame(1);
  // Only its own computer takes it, and only once.
  expect(live.claimView(open.streamId, "another-machine", fakeSocket().socket)).toBeNull();
  const socket = fakeSocket();
  const view = live.claimView(open.streamId, paired.machineId, socket.socket);
  expect(view).not.toBeNull();
  expect(live.claimView(open.streamId, paired.machineId, fakeSocket().socket)).toBeNull();
  const jpeg = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
  // When the computer captured it goes on with it, to measure how late pictures arrive.
  const metadata = {
    deviceWidth: 1280,
    deviceHeight: 800,
    capturedAt: 1_760_000_000_000,
    url: "https://shop.example.com/",
  };
  view?.data(encodeBrowserFrame({ seq: 2, metadata }, jpeg));
  // Answered at once (a viewer with no window always has room), so the runner may send the next.
  expect(socket.sent).toEqual(['{"type":"ack"}']);
  expect(seqs()).toEqual([1, 2]);
  const last = [...got].reverse().find((m) => m.type === "browser.frame");
  if (last?.type !== "browser.frame") throw new Error("no frame");
  expect(last.metadata).toEqual(metadata);
  // Neither base64 nor bytes are made before a viewer needs them; then once, on the frame every viewer shares.
  expect(last.data).toBeUndefined();
  expect(last.bytes).toBeUndefined();
  expect(browserFrameBase64(last)).toBe(Buffer.from(jpeg).toString("base64"));
  expect(last.data).toBe(Buffer.from(jpeg).toString("base64"));
  const bytes = browserFrameBytes(last);
  expect(browserFrameBytes(last)).toBe(bytes);
  expect(decodeBrowserFrame(bytes)).toMatchObject({ seq: 2, metadata });
  // Garbage is answered too (it must not hold the window shut), and shows nothing.
  view?.data(new Uint8Array([9, 9, 9]));
  expect(socket.sent).toHaveLength(2);
  // A frame still on the machine socket was sent before the view's own (no newer than it): dropped.
  await runner.frame(2);
  expect(seqs()).toEqual([1, 2]);
  // Its socket closed: newer frames on the machine socket show again.
  view?.closed();
  await runner.frame(4);
  expect(seqs()).toEqual([1, 2, 4]);
  stop();
  live.close();
});

test("a newer frame on the machine socket: the computer left the view, so it shows and the view closes", async () => {
  const { hub, paired, live, got, viewer } = await liveSetup({ viewRetryMs: [5] });
  const runner = browserRunner(hub);
  await runner.hello(paired.token);
  const { stop } = await live.watch(viewer, f.org.id, f.agent.id);
  await until(() => runner.views().length === 1);
  const seqs = () => got.flatMap((m) => (m.type === "browser.frame" ? [m.seq] : []));
  const socket = fakeSocket();
  const view = live.claimView(runner.views()[0]?.streamId ?? "", paired.machineId, socket.socket);
  const frame = (seq: number) =>
    encodeBrowserFrame({ seq, metadata: { deviceWidth: 1280, deviceHeight: 800 } }, new Uint8Array([0xff, 0xd8]));
  view?.data(frame(5));
  // The runner closed the view as too slow, but its close never came (a half-open socket).
  await runner.frame(6);
  expect(seqs()).toEqual([5, 6]);
  expect(socket.closed).not.toBeNull();
  // The old view's late frames show nothing, nor does a machine-socket frame from before it.
  view?.data(frame(7));
  await runner.frame(4);
  expect(seqs()).toEqual([5, 6]);
  // It is opened again.
  await until(() => runner.views().length === 2);
  expect(runner.views()).toHaveLength(2);
  stop();
  live.close();
});

test("after a view closes, a machine-socket frame older than what it brought is never drawn", async () => {
  const { hub, paired, live, got, viewer } = await liveSetup({ viewRetryMs: [] });
  const runner = browserRunner(hub);
  await runner.hello(paired.token);
  const { stop } = await live.watch(viewer, f.org.id, f.agent.id);
  await until(() => runner.views().length === 1);
  const seqs = () => got.flatMap((m) => (m.type === "browser.frame" ? [m.seq] : []));
  const view = live.claimView(runner.views()[0]?.streamId ?? "", paired.machineId, fakeSocket().socket);
  const metadata = { deviceWidth: 1280, deviceHeight: 800 };
  view?.data(encodeBrowserFrame({ seq: 20, metadata }, new Uint8Array([0xff, 0xd8])));
  view?.closed(STREAM_CLOSE.tooSlow);
  // Sent before the view opened, late behind a big reply on the machine socket.
  await runner.frame(3);
  expect(seqs()).toEqual([20]);
  // What the computer sends after the view's end shows.
  await runner.frame(21);
  expect(seqs()).toEqual([20, 21]);
  stop();
  live.close();
});

test("a view frame's ack waits for a viewer with room, and goes after ackOwedMs at the latest", async () => {
  const { hub, paired, live, got } = await liveSetup({ viewAckOwedMs: 40 });
  const runner = browserRunner(hub);
  await runner.hello(paired.token);
  // A viewer whose window is full: the test says when it has room again.
  let room = false;
  const viewer = { userId: f.owner.id, send: (m: BrowserLiveMessage) => got.push(m), room: () => room };
  const { stop } = await live.watch(viewer, f.org.id, f.agent.id);
  await until(() => runner.views().length === 1);
  const socket = fakeSocket();
  const view = live.claimView(runner.views()[0]?.streamId ?? "", paired.machineId, socket.socket);
  const frame = (seq: number) =>
    encodeBrowserFrame({ seq, metadata: { deviceWidth: 1280, deviceHeight: 800 } }, new Uint8Array([0xff, 0xd8]));
  view?.data(frame(1));
  // Shown, but nobody here could take another: the computer is not let send more yet.
  expect(got.some((m) => m.type === "browser.frame" && m.seq === 1)).toBe(true);
  expect(socket.sent).toEqual([]);
  live.viewerReady(f.agent.id);
  expect(socket.sent).toEqual([]);
  // The viewer drew it: the ack it owed goes.
  room = true;
  live.viewerReady(f.agent.id);
  expect(socket.sent).toEqual(['{"type":"ack"}']);
  // Nothing more owed: another ready sends nothing.
  live.viewerReady(f.agent.id);
  expect(socket.sent).toHaveLength(1);
  // A viewer that never draws again (a hidden tab): the owed ack goes anyway, before the runner gives up on it.
  room = false;
  view?.data(frame(2));
  expect(socket.sent).toHaveLength(1);
  await until(() => socket.sent.length === 2);
  expect(socket.sent).toHaveLength(2);
  stop();
  live.close();
});

test("a view socket that drops while its stream runs is opened again, with backoff", async () => {
  const { hub, paired, live, viewer } = await liveSetup({ viewRetryMs: [5, 30] });
  const runner = browserRunner(hub);
  await runner.hello(paired.token);
  const { stop } = await live.watch(viewer, f.org.id, f.agent.id);
  await until(() => runner.views().length === 1);
  const { machineId } = paired;
  const claim = (i: number) => live.claimView(runner.views()[i]?.streamId ?? "", machineId, fakeSocket().socket);
  // A blip: the first wait.
  claim(0)?.closed();
  await until(() => runner.views().length === 2);
  expect(runner.views()).toHaveLength(2);
  // It brings a frame, so it works: the next drop starts the waits again from the first.
  const second = claim(1);
  const metadata = { deviceWidth: 1280, deviceHeight: 800 };
  second?.data(encodeBrowserFrame({ seq: 1, metadata }, new Uint8Array([0xff, 0xd8])));
  second?.closed();
  await until(() => runner.views().length === 3);
  expect(runner.views()).toHaveLength(3);
  claim(2)?.closed();
  await Bun.sleep(15);
  // The second wait is longer.
  expect(runner.views()).toHaveLength(3);
  await until(() => runner.views().length === 4);
  expect(runner.views()).toHaveLength(4);
  // Out of tries: its frames stay on the machine socket until the next stream.
  claim(3)?.closed();
  await Bun.sleep(60);
  expect(runner.views()).toHaveLength(4);
  stop();
  live.close();
});

test("a view closed as too slow for its link keeps its backoff, even when the next one brings a frame", async () => {
  const { hub, paired, live, viewer } = await liveSetup({ viewRetryMs: [5, 30] });
  const runner = browserRunner(hub);
  await runner.hello(paired.token);
  const { stop } = await live.watch(viewer, f.org.id, f.agent.id);
  await until(() => runner.views().length === 1);
  const { machineId } = paired;
  const claim = (i: number) => live.claimView(runner.views()[i]?.streamId ?? "", machineId, fakeSocket().socket);
  const metadata = { deviceWidth: 1280, deviceHeight: 800 };
  claim(0)?.closed(STREAM_CLOSE.viewTooSlow);
  await until(() => runner.views().length === 2);
  // Its first frame proves nothing about the link: the next drop waits the longer time.
  const second = claim(1);
  second?.data(encodeBrowserFrame({ seq: 1, metadata }, new Uint8Array([0xff, 0xd8])));
  second?.closed(STREAM_CLOSE.viewTooSlow);
  await Bun.sleep(15);
  expect(runner.views()).toHaveLength(2);
  await until(() => runner.views().length === 3);
  // Out of tries.
  claim(2)?.closed(STREAM_CLOSE.viewTooSlow);
  await Bun.sleep(60);
  expect(runner.views()).toHaveLength(3);
  stop();
  live.close();
});

test("a view the computer refuses stays on the machine socket: no other try", async () => {
  const { hub, paired, live, viewer } = await liveSetup({ viewRetryMs: [5] });
  const runner = browserRunner(hub, { viewError: "not_allowed" });
  await runner.hello(paired.token);
  const { stop } = await live.watch(viewer, f.org.id, f.agent.id);
  await until(() => runner.views().length === 1);
  await Bun.sleep(40);
  expect(runner.views()).toHaveLength(1);
  stop();
  live.close();
});

test("a view the computer couldn't open (away for a moment) is tried again", async () => {
  const { hub, paired, live, viewer } = await liveSetup({ viewRetryMs: [5] });
  const runner = browserRunner(hub, { viewError: "unreachable" });
  await runner.hello(paired.token);
  const { stop } = await live.watch(viewer, f.org.id, f.agent.id);
  await until(() => runner.views().length === 2);
  expect(runner.views()).toHaveLength(2);
  // Out of tries.
  await Bun.sleep(40);
  expect(runner.views()).toHaveLength(2);
  stop();
  live.close();
});

test("the stream's own socket closes when the stream stops", async () => {
  const { hub, paired, live, viewer } = await liveSetup();
  const runner = browserRunner(hub);
  await runner.hello(paired.token);
  const { stop } = await live.watch(viewer, f.org.id, f.agent.id);
  await until(() => runner.views().length === 1);
  const socket = fakeSocket();
  live.claimView((runner.views()[0] as Request & { streamId: string }).streamId, paired.machineId, socket.socket);
  stop();
  await until(() => socket.closed !== null);
  expect(socket.closed?.code).toBe(1000);
  live.close();
});

test("a runner that restarts and says hello before its old socket's close is asked for the stream: the page comes back", async () => {
  const { hub, paired, live, got, viewer } = await liveSetup();
  const old = browserRunner(hub, { dead: true });
  await old.hello(paired.token);
  await live.watch(viewer, f.org.id, f.agent.id);
  await old.frame(1);
  got.length = 0;
  // A machine update restarts the runner: the new one dials in while the old socket is still open here.
  const fresh = browserRunner(hub);
  await fresh.hello(paired.token);
  await until(() => kinds(got).includes("browser.status"));
  expect(fresh.starts()).toHaveLength(1);
  expect(kinds(got)).toEqual(["browser.status"]);
  await fresh.frame(2);
  expect(got.flatMap((m) => (m.type === "browser.frame" ? [m.seq] : []))).toEqual([2]);
  live.close();
});

test("a runner that restarts after its socket closed: the views hear it reconnect, then its new runner is asked at once", async () => {
  const { hub, paired, live, got, viewer } = await liveSetup();
  const old = browserRunner(hub);
  await old.hello(paired.token);
  await live.watch(viewer, f.org.id, f.agent.id);
  await old.frame(1);
  await hub.close(old.conn);
  expect(kinds(got).at(-1)).toBe("unavailable:reconnecting");
  // The new runner closed the agent's Chrome when it started: the views are told so, without waiting on a retry.
  const fresh = browserRunner(hub, { closedBrowser: true });
  await fresh.hello(paired.token);
  await until(() => kinds(got).includes("unavailable:closed"));
  expect(fresh.starts()).toHaveLength(1);
  expect(kinds(got).at(-1)).toBe("unavailable:closed");
  live.close();
});

/** The agent's browser tools on the fixture's hub, the workspace's own computer "VPS" as its computer. */
async function toolSetup() {
  const holder: { hub?: MachineHub } = {};
  const hub = () => holder.hub as MachineHub;
  /** The ops of the tools' calls that found the computer gone, and when the first one did. */
  const offline: string[] = [];
  let found!: () => void;
  const foundOffline = new Promise<void>((resolve) => {
    found = resolve;
  });
  f = await setup({
    machines: true,
    toolSources: [
      createBrowserToolSource({
        machines: {
          hub: {
            status: (id) => hub().status(id),
            call: (id, request, options) =>
              hub()
                .call(id, request, options)
                .catch((error: unknown) => {
                  if (error instanceof MachineOfflineError) {
                    offline.push(request.op);
                    found();
                  }
                  throw error;
                }),
          },
        },
      }),
    ],
  });
  holder.hub = f.machineHub as MachineHub;
  const paired = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "VPS" });
  await f.db.update(schema.machines).set({ kind: "managed" }).where(eq(schema.machines.id, paired.machineId));
  await f.db.update(schema.agents).set({ machineId: paired.machineId }).where(eq(schema.agents.id, f.agent.id));
  await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: BROWSER_SCOPE }]);
  const ctx = await runContext(f);
  const open = async () => {
    const r = await (f.tools as NonNullable<Fixture["tools"]>).invoke(ctx, {
      toolUseId: `tu_${crypto.randomUUID()}`,
      name: "browser_do",
      input: { steps: [{ do: "open", url: "https://app.agentes.chat/" }] },
    });
    if (r.type !== "result") throw new Error("expected a result");
    return r.output;
  };
  return { hub: hub(), paired, open, offline, foundOffline };
}

test("a computer whose runner is dialing again: the browser waits for it and opens the page; one away for minutes is said at once", async () => {
  const { hub, paired, open, offline, foundOffline } = await toolSetup();
  const old = browserRunner(hub);
  await old.hello(paired.token);
  // Its socket drops (a restart, the network): nothing the agent sends gets there until it says hello again.
  await hub.close(old.conn);
  const opening = open();
  // The runner is back only once the open has found it gone.
  await foundOffline;
  const fresh = browserRunner(hub);
  await fresh.hello(paired.token);
  const out = await opening;
  expect(offline).toEqual(["browser.batch"]);
  expect(out.content).not.toContain("isn't answering");
  expect(out.isError).toBeFalsy();
  expect(out.content).toContain("agentes.chat");
  expect(fresh.batches()).toHaveLength(1);

  await hub.close(fresh.conn);
  await f.db
    .update(schema.machines)
    .set({ lastSeenAt: new Date(Date.now() - 3 * 60_000) })
    .where(eq(schema.machines.id, paired.machineId));
  const started = Date.now();
  const away = await open();
  expect(Date.now() - started).toBeLessThan(1000);
  expect(away.isError).toBe(true);
  expect(away.content).toContain("The computer VPS isn't answering right now.");
  // Asked once, not again.
  expect(offline).toEqual(["browser.batch", "browser.batch"]);
});

test("a request whose socket closes while the hub checks it fails at once as never sent, not as a timeout", async () => {
  const { hub, paired } = await toolSetup();
  const runner = browserRunner(hub);
  await runner.hello(paired.token);
  // `hub.call` reads the workspace's standing first: the socket closes meanwhile.
  const sent = hub.call(paired.machineId, { op: "list", path: "", depth: 1 }, { timeoutMs: 3_000 });
  await hub.close(runner.conn);
  const error = await sent.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(MachineOfflineError);
  expect(error).not.toBeInstanceOf(MachineDroppedError);
  expect((error as Error).message).toBe(
    "The computer VPS isn't answering right now. It usually comes back within minutes.",
  );
});

test("a run's call on a computer just gone waits for its runner to say hello again; a person's is answered at once", async () => {
  const { hub, paired } = await toolSetup();
  const old = browserRunner(hub);
  await old.hello(paired.token);
  await hub.close(old.conn);
  let found!: () => void;
  const foundOffline = new Promise<void>((resolve) => {
    found = resolve;
  });
  const watched: MachineCaller = {
    call: (id, request, options) => hub.call(id, request, options),
    status: async (id) => {
      const status = await hub.status(id);
      if (status && !status.online) found();
      return status;
    },
  };
  const target = { machineId: paired.machineId, handle: "dev" };
  const run = { orgId: f.org.id, agentId: f.agent.id, signal: new AbortController().signal };
  const reached = withConnectedMachine(watched, run, target, async (computer) => computer.machineId);
  await foundOffline;
  const fresh = browserRunner(hub);
  await fresh.hello(paired.token);
  expect(await reached).toBe(paired.machineId);

  await hub.close(fresh.conn);
  const started = Date.now();
  const person = { orgId: f.org.id, agentId: f.agent.id };
  const refused = await withConnectedMachine(hub, person, target, async () => "reached").catch((e: unknown) => e);
  expect(Date.now() - started).toBeLessThan(1000);
  expect(refused).toBeInstanceOf(MachineOfflineError);
});

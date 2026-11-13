import { afterEach, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { AgentScope, MachineRequest, RunnerAccess } from "@agenteschat/adapters/machine-protocol";
import type { ServerWebSocket } from "bun";
import type { DesktopSessions } from "../../runner/desktop-session";
import { type HandlerContext, handleRequest, type RequestScope } from "../../runner/handlers";
import { DataSockets, openDataSocket, RELAYED_FILE, RelayCount } from "../../runner/streams";
import type { Terminals } from "../../runner/terminal";
import { desktopOn, errorCode, fakeXvnc, removeDirs, tempDir, waitFor } from "./helpers";

const servers: { stop(force?: boolean): unknown }[] = [];
const dirs: string[] = [];
const closers: (() => void)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) close();
  removeDirs(dirs);
  for (const s of servers.splice(0)) await Promise.race([s.stop(true), Bun.sleep(300)]);
});

const TOKEN = "agm_test-token";
const STREAM_ID = "A".repeat(43);
const dev: AgentScope = { id: "01a142cb-489d-7000-87a3-efb5adb382ca", handle: "dev", name: "Dev" };

/**
 * The server's side of data sockets: it reads each `stream.hello`, then (by
 * default) answers `stream.ready` and keeps what comes after.
 */
function streamServer(answer: "ready" | "close" | "garbage" | "silent" = "ready") {
  const hellos: unknown[] = [];
  const origins: (string | null)[] = [];
  const got: (string | Buffer)[] = [];
  const closes: number[] = [];
  let peer: ServerWebSocket<unknown> | null = null;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      origins.push(req.headers.get("origin"));
      return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
    },
    websocket: {
      message(ws, message) {
        if (peer !== ws) {
          peer = ws;
          hellos.push(JSON.parse(String(message)));
          if (answer === "ready") ws.send(JSON.stringify({ type: "stream.ready" }));
          if (answer === "close") ws.close(4401, "bad token");
          if (answer === "garbage") ws.send("hello?");
          return;
        }
        got.push(typeof message === "string" ? message : Buffer.from(message));
      },
      close(_ws, code) {
        closes.push(code);
      },
    },
  });
  servers.push(server);
  return {
    url: `ws://127.0.0.1:${server.port}/api/machines/stream`,
    hellos,
    origins,
    got,
    closes,
    peer: () => peer as ServerWebSocket<unknown>,
  };
}

test("the data socket names its stream with the machine's token, is ready on stream.ready, then carries bytes and control frames", async () => {
  const s = streamServer();
  const socket = await openDataSocket({ url: s.url, token: TOKEN, streamId: STREAM_ID });
  expect(s.hellos).toEqual([{ type: "stream.hello", token: TOKEN, streamId: STREAM_ID }]);
  // No web page can open one: the server refuses a request with an Origin.
  expect(s.origins).toEqual([null]);

  // What the person sends before the runner listens waits for it.
  s.peer().send(new Uint8Array([1, 2, 3]));
  s.peer().send(JSON.stringify({ type: "resize", cols: 132, rows: 40 }));
  s.peer().send(JSON.stringify({ type: "resize", cols: 9999, rows: 40 }));
  await Bun.sleep(50);
  const heard: unknown[] = [];
  let closed = false;
  socket.listen({
    bytes: (b) => heard.push([...b]),
    control: (f) => heard.push(f),
    closed: () => {
      closed = true;
    },
  });
  expect(heard).toEqual([[1, 2, 3], { type: "resize", cols: 132, rows: 40 }]);

  socket.send(new Uint8Array([9, 8]));
  socket.send(JSON.stringify({ type: "exit", code: 0 }));
  await waitFor(() => s.got.length === 2);
  expect(s.got[0]).toEqual(Buffer.from([9, 8]));
  expect(s.got[1]).toBe('{"type":"exit","code":0}');
  s.peer().close(1000);
  await waitFor(() => closed);
});

test("the dial fails when the server refuses the stream, answers something else, never answers, or the request is canceled", async () => {
  const refused = streamServer("close");
  await expect(openDataSocket({ url: refused.url, token: TOKEN, streamId: STREAM_ID })).rejects.toThrow(
    "The server refused the stream (4401 bad token)",
  );
  const garbage = streamServer("garbage");
  await expect(openDataSocket({ url: garbage.url, token: TOKEN, streamId: STREAM_ID })).rejects.toThrow(
    "answered the stream with something else",
  );
  const silent = streamServer("silent");
  await expect(openDataSocket({ url: silent.url, token: TOKEN, streamId: STREAM_ID, timeoutMs: 100 })).rejects.toThrow(
    "didn't take the stream in time",
  );
  const ac = new AbortController();
  const dialing = openDataSocket({ url: silent.url, token: TOKEN, streamId: STREAM_ID, signal: ac.signal });
  ac.abort();
  await expect(dialing).rejects.toThrow("Canceled");
});

test("the data sockets of a session all close when it ends", async () => {
  const s = streamServer();
  const sockets = new DataSockets({ url: s.url, token: TOKEN });
  const a = await sockets.dial(STREAM_ID, "desktop");
  await sockets.dial("B".repeat(43), "terminal");
  a.close();
  await waitFor(() => s.closes.length === 1);
  sockets.closeAll();
  await waitFor(() => s.closes.length === 2);
  expect(s.closes).toEqual([1000, 1001]);
});

test("what root relayed: each kind's payload both ways once the stream is ready, written whole only when it changed", async () => {
  const s = streamServer();
  const t = streamServer();
  const relayed = new RelayCount();
  const desktops = new DataSockets({ url: s.url, token: TOKEN, relayed });
  const terminals = new DataSockets({ url: t.url, token: TOKEN, relayed });
  const desktop = await desktops.dial(STREAM_ID, "desktop");
  const terminal = await terminals.dial(STREAM_ID, "terminal");
  // The handshake isn't the stream's.
  expect([relayed.desktop, relayed.terminal]).toEqual([
    { up: 0, down: 0 },
    { up: 0, down: 0 },
  ]);
  desktop.listen({ bytes: () => {}, closed: () => {} });
  desktop.send(new Uint8Array(1000));
  s.peer().send(new Uint8Array(70_000));
  terminal.send("olá");
  await waitFor(() => relayed.desktop.down === 70_000 && s.got.length === 1 && t.got.length === 1);
  expect(relayed.desktop).toEqual({ up: 1000, down: 70_000 });
  expect(relayed.terminal).toEqual({ up: Buffer.byteLength("olá"), down: 0 });
  expect(relayed.browserView).toEqual({ up: 0, down: 0 });

  const dir = tempDir("relayed-");
  dirs.push(dir);
  const file = path.join(dir, RELAYED_FILE);
  relayed.save(file);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
    startedAt: relayed.startedAt,
    desktop: { up: 1000, down: 70_000 },
    terminal: { up: 4, down: 0 },
    browserView: { up: 0, down: 0 },
  });
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(relayed.startedAt).toBeGreaterThan(Date.now() - 60_000);
  // Nothing new: the file isn't touched.
  const at = statSync(file).mtimeMs;
  await Bun.sleep(20);
  relayed.save(file);
  expect(statSync(file).mtimeMs).toBe(at);
  relayed.browserView.up += 5;
  relayed.save(file);
  expect(JSON.parse(readFileSync(file, "utf8")).browserView).toEqual({ up: 5, down: 0 });
  desktops.closeAll();
  terminals.closeAll();
});

const ACCESS = (tools: Partial<RunnerAccess["tools"]>): RunnerAccess => ({
  folders: [],
  tools: { claude: false, codex: false, commands: true, ...tools },
});
const scope: RequestScope = { signal: new AbortController().signal, output: () => undefined };

test("stream.open: each kind behind its switch; a desktop that isn't running starts when asked to, unless paused", async () => {
  const s = streamServer();
  const dir = tempDir("streams-x-");
  dirs.push(dir);
  const x = await fakeXvnc(dir);
  closers.push(x.close);
  const desktop = desktopOn(x.socketPath, { running: false });
  const opened: string[] = [];
  const taken: string[] = [];
  let paused = false;
  let tools: Partial<RunnerAccess["tools"]> = { desktop: true, terminal: true };
  const ctx: HandlerContext = {
    desktopTaken: (agentId) => taken.push(agentId),
    workspaceReal: "/srv/agentes",
    exec: true,
    token: TOKEN,
    access: () => ACCESS(tools),
    paused: () => paused,
    streams: new DataSockets({ url: s.url, token: TOKEN }),
    desktops: desktop.desktops as unknown as DesktopSessions,
    terminals: {
      open: async (_agent: AgentScope, size: { cols: number }, dial: () => Promise<unknown>) => {
        await dial();
        opened.push(`terminal ${size.cols}`);
      },
    } as unknown as Terminals,
  };
  const open = (req: Record<string, unknown>) =>
    errorCode(() =>
      handleRequest(ctx, { op: "stream.open", streamId: STREAM_ID, agent: dev, ...req } as MachineRequest, scope),
    );
  const watch = { kind: "desktop", mode: "watch", start: true };
  const control = { kind: "desktop", mode: "control", start: true };
  const terminal = { kind: "terminal", cols: 80, rows: 24 };

  expect(await open(terminal)).toBe("ok");
  expect(opened).toEqual(["terminal 80"]);
  expect(s.hellos).toEqual([{ type: "stream.hello", token: TOKEN, streamId: STREAM_ID }]);

  // Nothing new starts on a paused computer: not even the desktop for a viewer.
  paused = true;
  expect(await open(watch)).toBe("paused");
  expect(await open(control)).toBe("paused");
  expect(await open(terminal)).toBe("paused");
  expect(desktop.state.started).toEqual([]);
  paused = false;

  // Not asked to start it (its agent is held): it stays as it is.
  expect(await open({ kind: "desktop", mode: "watch" })).toBe("desktop_off");
  expect(desktop.state.started).toEqual([]);

  // A viewer of a desktop that isn't running starts it, then watches it (logged in view-only).
  expect(await open(watch)).toBe("ok");
  expect(desktop.state.started).toEqual(["dev"]);
  expect(x.logins.map((l) => l.password)).toEqual(["view"]);
  // Running: watched on a paused computer as before.
  paused = true;
  expect(await open(watch)).toBe("ok");
  paused = false;
  expect(taken).toEqual([]);
  expect(await open(control)).toBe("ok");
  expect(taken).toEqual([dev.id]);

  tools = { desktop: false, terminal: false };
  expect(await open(watch)).toBe("not_allowed");
  expect(await open(terminal)).toBe("not_allowed");
  tools = { desktop: true, terminal: true };
  expect(await open({ ...terminal, cols: 5 })).toBe("bad_request");
  expect(await open({ ...watch, streamId: "short" })).toBe("bad_request");
  expect(await open({ kind: "printer" })).toBe("bad_request");
  // A phone's screen goes to the phones, which a computer without them doesn't reach.
  expect(await open({ kind: "phone", mode: "watch" })).toBe("phone_missing");
});

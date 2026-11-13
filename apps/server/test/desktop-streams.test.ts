import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  BROWSER_WARM_PROTOCOL,
  DESKTOP_PROTOCOL,
  DESKTOP_SWITCH_PROTOCOL,
  PHONE_SCREEN_PROTOCOL,
  type RunnerAccess,
  type RunnerInfo,
  STREAM_CLOSE,
} from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import { BROWSER_SCOPE, DESKTOP_SCOPE, grantScopes } from "@agenteschat/engine";
import { connectUrl } from "../runner/config";
import { RunnerConnection } from "../runner/connection";
import type { DesktopSessions } from "../runner/desktop-session";
import { DataSockets } from "../runner/streams";
import { type SpawnPty, Terminals } from "../runner/terminal";
import { checkDesktop, signInForDesktop } from "../scripts/smoke-desktop";
import {
  type Browser,
  browser,
  createTestServer,
  joinByInvitation,
  listen,
  ORIGIN,
  pairComputer,
  seedOrg,
  signUp,
  type TestServer,
  upgradeStatus,
} from "./harness";
import { desktopOn, fakeXvnc, removeDirs, tempDir } from "./runner/helpers";

let t: TestServer;
let server: ReturnType<typeof listen>;
beforeEach(async () => {
  t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
  server = listen(t);
});
afterEach(async () => {
  // Bun never resolves stop(true) after the server itself closed a socket whose client lives in the same process.
  await Promise.race([server.stop(true), Bun.sleep(500)]);
  await t.close();
});

const ACCESS = { folders: [], tools: { claude: false, codex: false, commands: true, desktop: true, terminal: true } };
const RUNNER = {
  version: "0.1.0",
  protocol: DESKTOP_PROTOCOL,
  os: "linux",
  arch: "x64",
  hostname: "box",
  workspace: "/srv/agentes",
  exec: true,
  access: ACCESS,
  desktop: { available: true, width: 1280, height: 800 },
  terminal: { available: true },
};

const base = () => `ws://127.0.0.1:${server.port}`;

/** The test server again, where sessions are screened. */
async function screenedServer() {
  await Promise.race([server.stop(true), Bun.sleep(500)]);
  await t.close();
  t = await createTestServer({
    env: { ALLOW_SIGNUP: "true", SESSION_SCREENING: "true", OPERATOR_API_TOKEN: "operator-".padEnd(40, "x") },
  });
  server = listen(t);
}

async function until(done: () => boolean | Promise<boolean>, what = "condition") {
  for (let i = 0; i < 250; i++) {
    if (await done()) return;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The owner's workspace, its agent on a Linux computer the owner paired, allowed to use its desktop. */
async function seeded() {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const org = await seedOrg(owner);
  const api = (path: string, init?: Parameters<Browser>[1]) =>
    owner(`/api/app/organizations/${org.orgId}${path}`, init);
  const machine = await pairComputer(t, api, { os: "linux", arch: "x64", hostname: "box", version: "0.1.0" });
  await t.db.update(schema.agents).set({ machineId: machine.machineId }).where(eq(schema.agents.id, org.agentId));
  await grantScopes(t.db, org.orgId, org.agentId, [{ connectionId: null, scope: DESKTOP_SCOPE }]);
  const desktop = `${base()}/api/desktop?orgId=${org.orgId}&agentId=${org.agentId}&mode=watch`;
  const terminal = `${base()}/api/terminal?orgId=${org.orgId}&agentId=${org.agentId}&cols=80&rows=24`;
  /** Someone the owner invites, signed in (`admin`: with the workspace's Admin role). */
  const invite = (email: string, role: "admin" | "member") => joinByInvitation(t, owner, org.orgId, email, { role });
  return { owner, org, machine, desktop, terminal, invite };
}

/** What the runner answers about a desktop that runs. */
const SESSION: Record<string, unknown> = {
  "desktop.session.status": { running: true, startedAt: "2026-10-24T10:00:00.000Z", streams: 0 },
  "desktop.session.start": {
    display: 20,
    width: 1280,
    height: 800,
    startedAt: "2026-10-24T10:00:00.000Z",
    started: false,
  },
  "desktop.session.stop": { stopped: true },
  "browser.warm": { started: true },
};

/**
 * A runner on real sockets: its machine socket says hello; each `stream.open`
 * dials a data socket, says hello and answers once it got `stream.ready`; a
 * desktop's own requests get the answers of one that runs. `refuseOpens`: the
 * first opens get `desktop_off`, as a runner from before desktops stayed on;
 * `hello`: what its hello says besides `RUNNER`.
 */
async function connectRunner(token: string, options: { refuseOpens?: number; hello?: Partial<RunnerInfo> } = {}) {
  let refuse = options.refuseOpens ?? 0;
  const ws = new WebSocket(`${base()}/api/machines/connect`);
  const requests: string[] = [];
  const asked: Record<string, unknown>[] = [];
  const opened: Record<string, unknown>[] = [];
  const data: { socket: WebSocket; ready: boolean; got: (string | ArrayBuffer)[]; closed: number | null }[] = [];
  const welcome = new Promise<void>((resolve, reject) => {
    ws.onmessage = (e) => {
      const frame = JSON.parse(String(e.data)) as Record<string, unknown>;
      if (frame.type === "welcome") resolve();
      if (frame.type === "ping") ws.send(JSON.stringify({ type: "pong", at: frame.at }));
      if (frame.type === "request") requests.push(String(frame.op));
      if (frame.type === "request") asked.push(frame);
      if (frame.type === "request" && String(frame.op) in SESSION) {
        ws.send(JSON.stringify({ type: "result", id: frame.id, ok: true, data: SESSION[String(frame.op)] }));
      }
      if (frame.type !== "request" || frame.op !== "stream.open") return;
      if (refuse-- > 0) {
        const error = { code: "desktop_off", message: "The agent's desktop isn't running" };
        return void ws.send(JSON.stringify({ type: "result", id: frame.id, ok: false, error }));
      }
      opened.push(frame);
      const socket = new WebSocket(`${base()}/api/machines/stream`);
      socket.binaryType = "arraybuffer";
      const link = { socket, ready: false, got: [] as (string | ArrayBuffer)[], closed: null as number | null };
      data.push(link);
      socket.onopen = () => socket.send(JSON.stringify({ type: "stream.hello", token, streamId: frame.streamId }));
      socket.onmessage = (m) => {
        if (m.data !== '{"type":"stream.ready"}') return void link.got.push(m.data);
        link.ready = true;
        ws.send(JSON.stringify({ type: "result", id: frame.id, ok: true, data: { opened: true } }));
      };
      socket.onclose = (c) => {
        link.closed = c.code;
      };
    };
    ws.onclose = (e) => reject(new Error(`closed ${e.code}`));
  });
  await new Promise<void>((resolve) => {
    ws.onopen = () => resolve();
  });
  ws.send(JSON.stringify({ type: "hello", token, ...RUNNER, ...options.hello }));
  await welcome;
  return { ws, requests, asked, opened, data };
}

/** A person's stream socket in the web app: what it got and how it closed. */
function openViewer(url: string, person: Browser) {
  const socket = new WebSocket(url, { headers: { origin: ORIGIN, cookie: person.cookie() } } as unknown as string[]);
  socket.binaryType = "arraybuffer";
  const viewer = {
    socket,
    got: [] as (string | ArrayBuffer)[],
    closed: null as { code: number; reason: string } | null,
  };
  socket.onmessage = (e) => viewer.got.push(e.data);
  socket.onclose = (e) => {
    viewer.closed = { code: e.code, reason: e.reason };
  };
  return viewer;
}

test("before the upgrade: a session, our Origin, membership and sane parameters; a data socket never from a page", async () => {
  const { owner, desktop, terminal } = await seeded();
  const cookie = owner.cookie();
  expect(await upgradeStatus(desktop, { origin: ORIGIN })).toBe(401);
  expect(await upgradeStatus(desktop, { origin: "https://evil.example", cookie })).toBe(403);
  const stranger = browser(t);
  await signUp(stranger, "zed@example.com");
  expect(await upgradeStatus(desktop, { origin: ORIGIN, cookie: stranger.cookie() })).toBe(403);
  expect(await upgradeStatus(desktop.replace("mode=watch", "mode=drive"), { origin: ORIGIN, cookie })).toBe(400);
  expect(await upgradeStatus(terminal.replace("cols=80", "cols=10"), { origin: ORIGIN, cookie })).toBe(400);
  expect(await upgradeStatus(`${base()}/api/machines/stream`, { origin: ORIGIN })).toBe(403);
});

test("someone opening the agent's desktop gets its browser ready for the agent's next command, on that desktop", async () => {
  const { owner, org, machine, desktop } = await seeded();
  await grantScopes(t.db, org.orgId, org.agentId, [{ connectionId: null, scope: BROWSER_SCOPE }]);
  // A runner from before it: nothing asked.
  const old = await connectRunner(machine.token, {
    hello: { browser: { available: true }, access: { ...ACCESS, tools: { ...ACCESS.tools, browser: true } } },
  });
  let viewer = openViewer(desktop, owner);
  await until(() => old.data[0]?.ready === true, "the data socket");
  viewer.socket.close();
  await until(() => viewer.closed !== null, "the viewer to close");
  old.ws.close();
  await Bun.sleep(50);
  expect(old.requests).not.toContain("browser.warm");
  const runner = await connectRunner(machine.token, {
    hello: {
      protocol: BROWSER_WARM_PROTOCOL,
      browser: { available: true },
      access: { ...ACCESS, tools: { ...ACCESS.tools, browser: true } },
    },
  });
  viewer = openViewer(desktop, owner);
  await until(() => runner.data[0]?.ready === true, "the data socket");
  await until(() => runner.requests.includes("browser.warm"), "the browser started ahead");
  expect(runner.asked.find((r) => r.op === "browser.warm")).toMatchObject({
    agent: { id: org.agentId, handle: "dev" },
    desktop: true,
  });
  viewer.socket.close();
});

test("a browser card's view of the screen (ADR 0058 §7): watch only, never started or switched, no browser warmed, audited as the card's", async () => {
  const { owner, org, machine, desktop } = await seeded();
  const cookie = owner.cookie();
  const card = desktop.replace("mode=watch", "preview=1&mode=watch");
  const control = desktop.replace("mode=watch", "preview=1&mode=control");
  expect(await upgradeStatus(control, { origin: ORIGIN, cookie })).toBe(400);
  await grantScopes(t.db, org.orgId, org.agentId, [{ connectionId: null, scope: BROWSER_SCOPE }]);
  const runner = await connectRunner(machine.token, {
    refuseOpens: 1,
    hello: {
      protocol: DESKTOP_SWITCH_PROTOCOL,
      browser: { available: true },
      access: { ...ACCESS, tools: { ...ACCESS.tools, browser: true } },
    },
  });
  // A desktop that isn't running: the card's view is refused, and nothing starts it.
  const stopped = openViewer(card, owner);
  await until(() => stopped.closed !== null, "the refusal");
  expect(stopped.closed).toEqual({ code: STREAM_CLOSE.refused, reason: "desktop_off" });
  expect(runner.requests).not.toContain("desktop.session.start");

  // `switch` is ignored with it: no mode frame, and no `start` asked of the computer.
  const viewer = openViewer(`${card}&switch=1`, owner);
  await until(() => runner.data[0]?.ready === true, "the data socket");
  expect(runner.opened[0]).toMatchObject({ op: "stream.open", kind: "desktop", mode: "watch" });
  expect(runner.opened[0]).not.toHaveProperty("start");
  await Bun.sleep(50);
  expect(viewer.got).toEqual([]);
  // A card that only looks never starts the agent's browser.
  expect(runner.requests).not.toContain("browser.warm");
  expect(runner.requests).not.toContain("desktop.session.start");

  viewer.socket.close();
  await until(() => runner.data[0]?.closed !== null, "the data socket's close");
  const audit = () => t.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "desktop.watched"));
  await until(async () => (await audit()).length === 1, "the audit");
  expect((await audit())[0]?.details).toMatchObject({ machineId: machine.machineId, preview: true });
  runner.ws.close();
});

test("bytes go both ways through the computer's data socket; the audit keeps who, how long and how many bytes", async () => {
  const { owner, org, machine, desktop } = await seeded();
  const runner = await connectRunner(machine.token);
  const viewer = openViewer(desktop, owner);
  await until(() => runner.data[0]?.ready === true, "the data socket");
  expect(runner.opened[0]).toMatchObject({
    op: "stream.open",
    kind: "desktop",
    mode: "watch",
    agent: { id: org.agentId, handle: "dev" },
  });
  const link = runner.data[0] as (typeof runner.data)[number];
  link.socket.send(new Uint8Array([82, 70, 66]));
  await until(() => viewer.got.length === 1, "bytes to the person");
  expect(new Uint8Array(viewer.got[0] as ArrayBuffer)).toEqual(new Uint8Array([82, 70, 66]));
  viewer.socket.send(new Uint8Array([1, 2]));
  await until(() => link.got.length === 1, "bytes to the computer");
  expect(new Uint8Array(link.got[0] as ArrayBuffer)).toEqual(new Uint8Array([1, 2]));

  // The person leaves: the computer's data socket closes, and the audit says how much went each way, never what.
  viewer.socket.close();
  await until(() => link.closed !== null, "the data socket's close");
  expect(link.closed).toBe(STREAM_CLOSE.normal);
  const audit = () => t.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "desktop.watched"));
  await until(async () => (await audit()).length === 1, "the audit");
  const [user] = await t.db.select().from(schema.users).where(eq(schema.users.email, "owner@example.com"));
  expect((await audit())[0]).toMatchObject({
    orgId: org.orgId,
    actorType: "person",
    actorId: user?.id,
    targetType: "agent",
    targetId: org.agentId,
    details: { machineId: machine.machineId, bytesIn: 2, bytesOut: 3 },
  });
  runner.ws.close();
});

test("a phone's screen through the server: its pictures to the person (base64 for the phone app), their input back in control", async () => {
  const { owner, org, machine, invite } = await seeded();
  const pixel = {
    platform: "android",
    serial: "emulator-5554",
    kind: "emulator",
    model: "Pixel 8",
    osVersion: "16",
    state: "ready",
  } as const;
  const runner = await connectRunner(machine.token, { hello: { protocol: PHONE_SCREEN_PROTOCOL, phones: [pixel] } });
  let phoneId = "";
  await until(async () => {
    const [row] = await t.db.select().from(schema.machinePhones).where(eq(schema.machinePhones.orgId, org.orgId));
    phoneId = row?.id ?? "";
    return phoneId !== "";
  }, "the phone's row");
  const url = (mode: string, text = false) =>
    `${base()}/api/phone-screen?orgId=${org.orgId}&phoneId=${phoneId}&mode=${mode}${text ? "&text=1" : ""}`;
  const [user] = await t.db.select().from(schema.users).where(eq(schema.users.email, "owner@example.com"));

  const viewer = openViewer(url("control"), owner);
  await until(() => runner.data[0]?.ready === true, "the data socket");
  expect(runner.opened[0]).toMatchObject({
    op: "stream.open",
    kind: "phone",
    mode: "control",
    phoneId,
    phone: { platform: "android", serial: "emulator-5554", holder: { runId: null, agentId: null, userId: user?.id } },
  });
  expect(runner.opened[0]?.agent).toBeUndefined();
  const link = runner.data[0] as (typeof runner.data)[number];
  link.socket.send(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  await until(() => viewer.got.length === 1, "the picture");
  expect(new Uint8Array(viewer.got[0] as ArrayBuffer)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  viewer.socket.send(JSON.stringify({ type: "ack" }));
  viewer.socket.send(JSON.stringify({ type: "tap", x: 0.5, y: 0.25 }));
  await until(() => link.got.length === 2, "the ack and the tap");
  expect(link.got).toEqual(['{"type":"ack"}', '{"type":"tap","x":0.5,"y":0.25}']);
  viewer.socket.close();
  await until(() => link.closed !== null, "the data socket's close");
  const audit = () => t.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "device.phone_controlled"));
  await until(async () => (await audit()).length === 1, "the audit");
  expect((await audit())[0]).toMatchObject({ targetType: "phone", targetId: phoneId });

  // The phone app watches: pictures as base64 text.
  const app = openViewer(url("watch", true), owner);
  await until(() => runner.data[1]?.ready === true, "the watcher's data socket");
  (runner.data[1] as (typeof runner.data)[number]).socket.send(new Uint8Array([0xff, 0xd8, 0xff]));
  await until(() => app.got.length === 1, "the watcher's picture");
  expect(app.got).toEqual(["/9j/"]);
  app.socket.close();

  // A member the phone isn't shared with (Only its owner, by default): refused after the upgrade.
  const ana = await invite("ana@example.com", "member");
  const refused = openViewer(url("watch"), ana);
  await until(() => refused.closed !== null, "the refusal");
  expect(refused.closed?.code).toBe(STREAM_CLOSE.forbidden);
  runner.ws.close();
});

test("signing out stops terminal input on its next frame and closes an idle desktop stream", async () => {
  const { owner, machine, desktop, terminal } = await seeded();
  const runner = await connectRunner(machine.token);
  const watch = openViewer(desktop, owner);
  const shell = openViewer(terminal, owner);
  await until(() => runner.data.length === 2 && runner.data.every((link) => link.ready), "both data sockets");
  const watchClosed = new Promise<number>((resolve) =>
    watch.socket.addEventListener("close", (event) => resolve(event.code)),
  );
  const shellClosed = new Promise<number>((resolve) =>
    shell.socket.addEventListener("close", (event) => resolve(event.code)),
  );
  expect((await owner("/api/auth/sign-out", { json: {} })).status).toBe(200);
  await Bun.sleep(2_100); // Incoming frames recheck the session at most every two seconds.
  shell.socket.send(new Uint8Array([65]));
  expect(await Promise.race([shellClosed, Bun.sleep(5_000).then(() => -1)])).toBe(STREAM_CLOSE.forbidden);
  expect(runner.data.every((link) => link.got.length === 0)).toBe(true);
  expect(await Promise.race([watchClosed, Bun.sleep(20_000).then(() => -1)])).toBe(STREAM_CLOSE.forbidden);
  await until(() => runner.data.every((link) => link.closed !== null), "both runner stream closes");
  expect(runner.data.map((link) => link.closed)).toEqual([STREAM_CLOSE.forbidden, STREAM_CLOSE.forbidden]);
  runner.ws.close();
}, 30_000);

test("a terminal: the resize reaches the computer and the shell's exit the person; only who paired it opens one", async () => {
  const { owner, machine, terminal, invite } = await seeded();
  const runner = await connectRunner(machine.token);
  const bia = await invite("bia@example.com", "admin");
  const refused = openViewer(terminal, bia);
  await until(() => refused.closed !== null, "the refusal");
  expect(refused.closed?.code).toBe(STREAM_CLOSE.forbidden);
  expect(runner.opened).toHaveLength(0);

  const viewer = openViewer(terminal, owner);
  await until(() => runner.data[0]?.ready === true, "the data socket");
  expect(runner.opened[0]).toMatchObject({ kind: "terminal", cols: 80, rows: 24 });
  const link = runner.data[0] as (typeof runner.data)[number];
  viewer.socket.send(JSON.stringify({ type: "resize", cols: 132, rows: 40 }));
  await until(() => link.got.length === 1, "the resize");
  expect(link.got[0]).toBe('{"type":"resize","cols":132,"rows":40}');
  link.socket.send(JSON.stringify({ type: "exit", code: 0 }));
  link.socket.close(1000);
  await until(() => viewer.closed !== null, "the end");
  expect(viewer.got).toEqual(['{"type":"exit","code":0}']);
  expect(viewer.closed?.code).toBe(STREAM_CLOSE.normal);
  runner.ws.close();
});

test("where sessions are screened no terminal opens: refused as not found, nothing asked of the computer", async () => {
  // Without the switch nothing is screened, and a terminal opens (above).
  expect(t.engine.sessions).toBeNull();
  await screenedServer();
  expect(t.engine.sessions).not.toBeNull();
  const { owner, machine, terminal } = await seeded();
  const runner = await connectRunner(machine.token);
  const viewer = openViewer(terminal, owner);
  await until(() => viewer.closed !== null, "the refusal");
  expect(viewer.closed).toEqual({ code: STREAM_CLOSE.notFound, reason: "no_terminal" });
  expect(runner.opened).toEqual([]);
  runner.ws.close();
});

test("after the upgrade, refusals are close codes: a member who may not watch, a computer held by another server", async () => {
  const { owner, machine, desktop, invite } = await seeded();
  const ana = await invite("ana@example.com", "member");
  const forbidden = openViewer(desktop, ana);
  await until(() => forbidden.closed !== null, "the refusal");
  expect(forbidden.closed?.code).toBe(STREAM_CLOSE.forbidden);

  // Its runner reached another server: streams only go through the one holding its socket (the panel retries).
  await t.db
    .update(schema.machines)
    .set({
      online: true,
      connectedReplica: "replica-b",
      lastSeenAt: new Date(),
      protocol: DESKTOP_PROTOCOL,
      access: ACCESS,
      executors: { desktop: { available: true }, terminal: { available: true } },
    })
    .where(eq(schema.machines.id, machine.machineId));
  const elsewhere = openViewer(desktop, owner);
  await until(() => elsewhere.closed !== null, "the refusal");
  expect(elsewhere.closed).toEqual({ code: STREAM_CLOSE.unreachable, reason: "other_server" });
});

const bytesOf = (viewer: ReturnType<typeof openViewer>) =>
  Buffer.concat(viewer.got.filter((f): f is ArrayBuffer => typeof f !== "string").map((f) => Buffer.from(f)));

/** The runner's own connection and stream code on real sockets, its desktop a fake Xvnc and its shells `spawn`. */
function runnerOn(token: string, dir: string, vncSocket: string, spawn: SpawnPty, hello: Partial<RunnerInfo> = {}) {
  const http = `http://127.0.0.1:${server.port}`;
  const runner = new RunnerConnection({
    url: connectUrl(http),
    token,
    info: { ...RUNNER, ...hello } as RunnerInfo,
    context: {
      workspaceReal: dir,
      exec: true,
      token,
      access: () => ACCESS as RunnerAccess,
      desktops: desktopOn(vncSocket).desktops as unknown as DesktopSessions,
      terminals: new Terminals({
        user: async () => ({ prefix: [], env: { PATH: "/usr/bin:/bin" }, cwd: dir }),
        log: () => undefined,
        spawn,
        system: { platform: "linux", pty: true, runtime: "Bun 1.4.4", uid: 1000 },
      }),
      streams: new DataSockets({ url: connectUrl(http, "stream"), token }),
    },
  });
  void runner.run();
  return runner;
}

test("the runner's own stream code through the server: a watcher's RFB handshake to the desktop, a terminal's bytes and exit", async () => {
  const { owner, machine, desktop, terminal } = await seeded();
  const dir = tempDir("streams-e2e-");
  const xvnc = await fakeXvnc(dir);
  const shells: { written: string; sizes: [number, number][]; print(text: string): void; exit(code: number): void }[] =
    [];
  const spawn: SpawnPty = (_argv, opts) => {
    let settle: (code: number | null) => void = () => undefined;
    const exited = new Promise<number | null>((resolve) => {
      settle = resolve;
    });
    const shell = {
      written: "",
      sizes: [] as [number, number][],
      print: (text: string) => opts.data(Buffer.from(text)),
      exit: (code: number) => settle(code),
    };
    shells.push(shell);
    return {
      write: (data) => {
        shell.written += Buffer.from(data).toString();
      },
      resize: (cols, rows) => {
        shell.sizes.push([cols, rows]);
      },
      hangup: () => settle(null),
      kill: () => settle(null),
      exited,
    };
  };
  const runner = runnerOn(machine.token, dir, xvnc.socketPath, spawn);
  try {
    await until(() => runner.online, "the runner");

    // noVNC's side: the runner offers RFB 3.8 and security None, the desktop's ServerInit right behind, all before
    // the viewer answers anything; each its own frame through the server, as noVNC takes one step a frame.
    const viewer = openViewer(desktop, owner);
    const sendBytes = (bytes: Uint8Array | string) =>
      viewer.socket.send(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes);
    await until(() => bytesOf(viewer).length >= 18 + 27, "the runner's side of the handshake");
    expect(viewer.got.slice(0, 3).map((f) => [...new Uint8Array(f as ArrayBuffer)])).toEqual([
      [...new TextEncoder().encode("RFB 003.008\n")],
      [1, 1],
      [0, 0, 0, 0],
    ]);
    expect(
      bytesOf(viewer)
        .subarray(18 + 24)
        .toString(),
    ).toBe("Dev");
    expect(xvnc.logins[0]).toMatchObject({ password: "view", shared: 1 });
    sendBytes("RFB 003.008\n");
    sendBytes(Uint8Array.of(1));
    sendBytes(Uint8Array.of(0));
    // A request once the answers checked out: the desktop's update comes back.
    sendBytes(Uint8Array.of(3, 0, 0, 0, 0, 0, 5, 0, 3, 32));
    await until(() => bytesOf(viewer).length === 18 + 27 + 4, "the update");
    viewer.socket.close();
    await until(() => xvnc.logins[0]?.socket.destroyed === true, "the desktop's connection to close");

    // xterm.js's side: the shell's bytes, keys and a resize, then its exit.
    const term = openViewer(terminal, owner);
    await until(() => shells.length === 1, "the shell");
    const shell = shells[0] as (typeof shells)[number];
    shell.print("$ ");
    await until(() => bytesOf(term).toString() === "$ ", "the prompt");
    term.socket.send(new TextEncoder().encode("ls\r"));
    term.socket.send(JSON.stringify({ type: "resize", cols: 132, rows: 40 }));
    await until(() => shell.written === "ls\r" && shell.sizes.length === 1, "the keys and the resize");
    expect(shell.sizes).toEqual([[132, 40]]);
    shell.exit(0);
    await until(() => term.closed !== null, "the end");
    expect(term.got.filter((f) => typeof f === "string")).toEqual(['{"type":"exit","code":0}']);
    expect(term.closed?.code).toBe(STREAM_CLOSE.normal);
  } finally {
    runner.stop();
    xvnc.close();
    removeDirs([dir]);
  }
});

test("taking control and handing back change the stream's mode in place, through the runner's own code: one socket, the desktop's full login, then its view-only one again", async () => {
  const { owner, org, machine } = await seeded();
  const dir = tempDir("streams-switch-");
  const xvnc = await fakeXvnc(dir);
  const noShell: SpawnPty = () => {
    throw new Error("no terminal here");
  };
  const runner = runnerOn(machine.token, dir, xvnc.socketPath, noShell, { protocol: DESKTOP_SWITCH_PROTOCOL });
  const MODE = (mode: string) => JSON.stringify({ type: "mode", mode });
  const VERSION = new TextEncoder().encode("RFB 003.008\n");
  const pointer = Uint8Array.of(5, 0, 0, 100, 0, 120);
  try {
    await until(() => runner.online, "the runner");
    const viewer = openViewer(
      `${base()}/api/desktop?orgId=${org.orgId}&agentId=${org.agentId}&switch=1&mode=watch`,
      owner,
    );
    const answer = () => {
      viewer.socket.send(VERSION);
      viewer.socket.send(Uint8Array.of(1));
      viewer.socket.send(Uint8Array.of(1));
    };
    await until(() => bytesOf(viewer).length >= 45, "the runner's side of the handshake");
    expect(viewer.got[0]).toBe(MODE("watch"));
    answer();
    viewer.socket.send(pointer);
    await until(() => (xvnc.logins[0]?.got.length ?? 0) >= 6, "the pointer at the desktop");
    expect(xvnc.desktop.pointer).toEqual([640, 400]);

    const api = (path: string, init?: Parameters<Browser>[1]) =>
      owner(`/api/app/organizations/${org.orgId}${path}`, init);
    const taken = (await (await api(`/agents/${org.agentId}/desktop/takeover`, { json: {} })).json()) as { id: string };
    await until(() => viewer.got.includes(MODE("control")), "the switch");
    viewer.socket.send(MODE("control"));
    await until(() => bytesOf(viewer).length >= 90, "the new session's handshake");
    answer();
    viewer.socket.send(pointer);
    await until(() => xvnc.desktop.pointer[0] === 100, "the person's pointer");
    expect(xvnc.logins.map((l) => l.password)).toEqual(["view", "full"]);

    expect((await api(`/browser/handoffs/${taken.id}/done`, { json: {} })).status).toBe(200);
    await until(() => viewer.got.filter((f) => f === MODE("watch")).length === 2, "the switch back");
    viewer.socket.send(MODE("watch"));
    await until(() => bytesOf(viewer).length >= 135, "the watching session's handshake");
    expect(xvnc.logins.map((l) => l.password)).toEqual(["view", "full", "view"]);
    expect(viewer.closed).toBeNull();
    viewer.socket.close();
  } finally {
    runner.stop();
    xvnc.close();
    removeDirs([dir]);
  }
});

test("bun run smoke --desktop-agent: signed in as who paired the computer, one framebuffer update, the terminal's user, never root", async () => {
  const { machine } = await seeded();
  const dir = tempDir("smoke-desktop-");
  const xvnc = await fakeXvnc(dir);
  let user = "dwrun";
  // A shell whose prompt comes first, which echoes what it is typed and answers the smoke's line as `user`.
  const spawn: SpawnPty = (_argv, opts) => {
    let settle: (code: number | null) => void = () => undefined;
    const exited = new Promise<number | null>((resolve) => {
      settle = resolve;
    });
    opts.data(Buffer.from("$ "));
    return {
      write: (data) => {
        const line = Buffer.from(data).toString();
        if (line.includes("id -un")) opts.data(Buffer.from(`${line}\nSMOKEUSER=${user}\r\n$ `));
        if (line.startsWith("exit")) settle(0);
      },
      resize: () => undefined,
      hangup: () => settle(null),
      kill: () => settle(null),
      exited,
    };
  };
  const runner = runnerOn(machine.token, dir, xvnc.socketPath, spawn);
  try {
    await until(() => runner.online, "the runner");
    const where = { db: t.db, auth: t.auth, base: `http://127.0.0.1:${server.port}`, origin: ORIGIN };
    const sessions = async () => (await t.db.select().from(schema.sessions)).length;
    const before = await sessions();
    const session = await signInForDesktop(where, "@dev");
    expect(await sessions()).toBe(before + 1);
    expect(session).toMatchObject({ handle: "dev", person: "owner" });
    const lines: string[] = [];
    await checkDesktop(session, (line) => lines.push(line));
    expect(lines).toEqual([
      expect.stringContaining('desktop: RFB 003.008, security None, 1280×800 "Dev"'),
      expect.stringContaining("terminal: as dwrun"),
    ]);
    // The watcher's login, and the whole screen asked for (FramebufferUpdateRequest, not incremental).
    expect(xvnc.logins[0]).toMatchObject({ password: "view", shared: 1 });
    expect([...(xvnc.logins[0]?.got ?? [])].slice(-10)).toEqual([3, 0, 0, 0, 0, 0, 5, 0, 3, 32]);

    user = "root";
    await expect(checkDesktop(session, () => undefined)).rejects.toThrow("@dev's terminal runs as root");
    await session.signOut();
    expect(await sessions()).toBe(before);
    await expect(signInForDesktop(where, "nobody")).rejects.toThrow("No agent nobody");
  } finally {
    runner.stop();
    xvnc.close();
    removeDirs([dir]);
  }
});

test("bun run smoke --desktop-agent where sessions are screened: the desktop, then the terminal's refusal, which passes", async () => {
  await screenedServer();
  const { machine } = await seeded();
  const dir = tempDir("smoke-desktop-");
  const xvnc = await fakeXvnc(dir);
  const runner = runnerOn(machine.token, dir, xvnc.socketPath, () => {
    throw new Error("no shell opens where sessions are screened");
  });
  try {
    await until(() => runner.online, "the runner");
    const where = { db: t.db, auth: t.auth, base: `http://127.0.0.1:${server.port}`, origin: ORIGIN };
    const session = await signInForDesktop(where, "@dev");
    const lines: string[] = [];
    await checkDesktop(session, (line) => lines.push(line));
    expect(lines).toEqual([
      expect.stringContaining('desktop: RFB 003.008, security None, 1280×800 "Dev"'),
      "terminal: refused on this server, sessions are screened",
    ]);
    await session.signOut();
  } finally {
    runner.stop();
    xvnc.close();
    removeDirs([dir]);
  }
});

test("the desktop's REST: its state for who may watch it, nothing to turn on or off, take over through the screen's routes", async () => {
  const { owner, org, machine, invite } = await seeded();
  const runner = await connectRunner(machine.token);
  const api = (path: string, init?: Parameters<Browser>[1]) =>
    owner(`/api/app/organizations/${org.orgId}/agents/${org.agentId}${path}`, init);
  expect(await (await api("/desktop")).json()).toEqual({
    available: true,
    reason: null,
    detail: null,
    running: true,
    startedAt: "2026-10-24T10:00:00.000Z",
    controllerUserId: null,
    handoff: null,
    viewers: 0,
    canControl: true,
    controlRefusal: null,
    held: false,
    browserOnDesktop: true,
  });
  // Its picture is for the same people; asking for one never starts anything.
  expect((await api("/desktop/picture")).status).toBe(200);
  expect(runner.requests).not.toContain("desktop.session.start");
  // It stays on: no route turns it on or off (the browser still closes).
  expect((await api("/desktop/start", { json: {} })).status).toBe(404);
  expect((await api("/desktop/stop", { json: {} })).status).toBe(404);
  const taken = (await (await api("/desktop/takeover", { json: {} })).json()) as {
    id: string;
    controllerUserId: string;
  };
  expect(taken).toMatchObject({ screen: "desktop", status: "active" });
  expect(await (await api("/desktop")).json()).toMatchObject({
    controllerUserId: taken.controllerUserId,
    handoff: { id: taken.id, screen: "desktop" },
  });
  // An older app's keyboard layout never reaches the computer: Xvnc types what the person's own layout made.
  openViewer(`${base()}/api/desktop?orgId=${org.orgId}&agentId=${org.agentId}&mode=control&keyboard=br`, owner);
  await until(() => runner.opened.length === 1, "the control stream");
  expect(runner.opened[0]).toMatchObject({ kind: "desktop", mode: "control" });
  expect(runner.opened[0]).not.toHaveProperty("keyboard");
  expect(runner.requests).toContain("desktop.session.status");
  expect(runner.requests).not.toContain("desktop.session.stop");

  // A member the agent's work doesn't involve sees nothing of it.
  const ana = await invite("ana@example.com", "member");
  expect((await ana(`/api/app/organizations/${org.orgId}/agents/${org.agentId}/desktop`)).status).toBe(403);
  expect((await ana(`/api/app/organizations/${org.orgId}/agents/${org.agentId}/desktop/picture`)).status).toBe(403);
  runner.ws.close();
}, 30_000);

test("a runner from before desktops stayed on refuses one that isn't running: the server starts it and opens again", async () => {
  const { owner, machine, desktop } = await seeded();
  const runner = await connectRunner(machine.token, { refuseOpens: 1 });
  const viewer = openViewer(desktop, owner);
  await until(() => runner.data.some((d) => d.ready), "the data socket");
  expect(runner.requests.filter((op) => op !== "desktop.session.status")).toEqual([
    "stream.open",
    "desktop.session.start",
    "stream.open",
  ]);
  expect(viewer.closed).toBeNull();
  runner.ws.close();
});

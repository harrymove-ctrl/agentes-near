import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { createConnection } from "node:net";
import path from "node:path";
import type { AgentScope, MachineRequest, RunnerAccess } from "@agenteschat/adapters/machine-protocol";
import { systemLauncher } from "../../runner/agent-users";
import {
  KEEPER_STATE,
  LOOK_MARKER,
  LOOK_SCRIPT,
  type LookOptions,
  lookCommand,
  lookFiles,
  lookId,
  TERMINAL_NOTE_ENV,
} from "../../runner/desktop-look";
import {
  abstractDisplays,
  DesktopSessions,
  type DesktopSessionsOptions,
  type DesktopSpawnOptions,
  type DesktopSystem,
  type DesktopUser,
  memAvailableBytes,
  PARK_AFTER_MS,
  type ProcessStat,
  procStat,
  runnerUser,
  systemDesktopUser,
  terminalNote,
  vncPasswordFile,
} from "../../runner/desktop-session";
import { RunnerError } from "../../runner/errors";
import { handleRequest, type RequestScope } from "../../runner/handlers";
import { errorCode, removeDirs, tempDir, waitFor } from "./helpers";

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

const posix = process.platform !== "win32";
const dev: AgentScope = { id: "01a142cb-489d-7000-87a3-efb5adb382ca", handle: "dev", name: "Dev" };
const ops: AgentScope = { id: "9f00aa11-0000-7000-8000-000000000000", handle: "ops" };
const GiB = 1024 ** 3;

interface FakeProc {
  pid: number;
  argv: string[];
  opts: DesktopSpawnOptions;
  alive: boolean;
  exit(code: number | null): void;
}

const commandOf = (p: FakeProc) =>
  (["agentes-look", "agentes-xvnc", "agentes-app"] as const).find((name) => p.argv.includes(name)) ??
  p.argv.map((a) => path.basename(a)).find((a) => a === "sh" || a === "Xtigervnc" || a === "dbus-launch");

/**
 * A computer with no X: the prepare script makes its folders, the look's
 * script and the one that sets Xtigervnc's flags only answer (`exits`),
 * "Xtigervnc" takes its display's lock and socket, and every process lives
 * until killed (`hangs`: the prepare's, the look's or the flags' too).
 */
function fakeComputer(lockDir: string) {
  const procs: FakeProc[] = [];
  /** Live processes that aren't ours (pid → command line). */
  const others = new Map<number, string[]>();
  const kills: [number, string][] = [];
  let nextPid = 4000;
  let xvncFails: string | null = null;
  const exits = new Map<string, number>();
  const files = new Set<string>();
  const hangs = new Set<string>();
  const stats: ProcessStat[] = [];
  const cwds = new Map<number, string>();
  const envs = new Map<number, Record<string, string>>();
  const system: DesktopSystem = {
    platform: "linux",
    pty: true,
    runtime: "Bun 1.4.4",
    uid: 1000,
    which: (command) => `/usr/bin/${command}`,
    exists: (file) => files.has(file),
    spawn(argv, opts) {
      let settle: (code: number | null) => void = () => undefined;
      const exited = new Promise<number | null>((resolve) => {
        settle = resolve;
      });
      const p: FakeProc = {
        pid: nextPid++,
        argv,
        opts,
        alive: true,
        exit(code) {
          if (!p.alive) return;
          p.alive = false;
          settle(code);
        },
      };
      procs.push(p);
      const command = commandOf(p);
      if (hangs.has(command ?? "")) {
        // held up: it ends only when killed
      } else if (command === "agentes-look" || command === "agentes-xvnc") {
        queueMicrotask(() => p.exit(exits.get(command) ?? 0));
      } else if (command === "sh") {
        for (const dir of argv.slice(-4, -2)) mkdirSync(dir, { recursive: true });
        queueMicrotask(() => p.exit(0));
      } else if (command === "Xtigervnc" && xvncFails !== null) {
        if (opts.log !== undefined) writeSync(opts.log, `${xvncFails}\n`);
        queueMicrotask(() => p.exit(1));
      } else if (command === "Xtigervnc") {
        const display = argv[argv.findIndex((a) => path.basename(a) === "Xtigervnc") + 1] ?? "";
        writeFileSync(path.join(lockDir, `.X${display.slice(1)}-lock`), `${String(p.pid).padStart(10)}\n`);
        writeFileSync(argv[argv.indexOf("-rfbunixpath") + 1] as string, "");
      }
      return { pid: p.pid, exited };
    },
    cmdline(pid) {
      const p = procs.find((x) => x.pid === pid);
      if (p?.alive) return p.argv.slice(p.argv.findIndex((a) => commandOf({ ...p, argv: [a] }) !== undefined));
      return others.get(pid) ?? null;
    },
    cwd: (pid) => cwds.get(pid) ?? null,
    environ: (pid) => envs.get(pid) ?? null,
    kill(pid, signal) {
      kills.push([pid, signal]);
      procs.find((x) => x.pid === pid)?.exit(null);
    },
    processes: () => stats,
  };
  const of = (command: string) => procs.filter((p) => commandOf(p) === command);
  return {
    system,
    procs,
    others,
    kills,
    of,
    failXvnc(message: string | null) {
      xvncFails = message;
    },
    failLook(fails: boolean) {
      exits.set("agentes-look", fails ? 1 : 0);
    },
    /** What the look's script and the flags' exit with (default 0). */
    exits,
    /** Files the computer has (`exists`). */
    files,
    /** Commands that never end by themselves ("sh": the prepare, "agentes-look"). */
    hangs,
    /** What `/proc` lists, and each process's folder and environment there. */
    stats,
    cwds,
    envs,
  };
}

/** A runner that is gone: it never hears its desktops end. */
const gone = (system: DesktopSystem): DesktopSystem => ({
  ...system,
  spawn(argv, opts) {
    const p = system.spawn(argv, opts);
    return opts.detached ? { pid: p.pid, exited: new Promise<number | null>(() => undefined) } : p;
  },
});

const RUNNER = ["/opt/agentes-runner/agentes-runner"];

/** `xLockDir`: where the fake X servers keep their locks (an agent's own /tmp), when it isn't the computer's. */
function setup(over: Partial<DesktopSessionsOptions> = {}, xLockDir?: string) {
  // Short: Browser's socket goes in the runner's home, and a Unix socket's path has at most 103 bytes on macOS.
  const home = tempDir("dsk-");
  const lockDir = tempDir("desk-x-");
  const folders = tempDir("desk-ws-");
  dirs.push(home, lockDir, folders);
  const fake = fakeComputer(xLockDir ?? lockDir);
  const logs: string[] = [];
  const clock = { now: 1_000_000 };
  const opts: DesktopSessionsOptions = {
    home,
    log: (line) => logs.push(line),
    user: async (agent) => runnerUser(home, path.join(folders, agent.handle), agent),
    system: fake.system,
    lockDir,
    // Plenty free: parking only where a test says memory runs short.
    memAvailable: () => 4 * GiB,
    now: () => clock.now,
    runner: RUNNER,
    ...over,
  };
  const desktops = new DesktopSessions(opts);
  return { home, lockDir, folders, fake, logs, clock, opts, desktops };
}

/** The look a desktop of `agent` gets on this computer (single-user: Browser's socket in the runner's home). */
async function lookOf(t: ReturnType<typeof setup>, agent: AgentScope, over: Partial<LookOptions> = {}) {
  const user = await t.opts.user(agent);
  return {
    theme: "stock",
    dock: "panel",
    agent,
    shell: user.env.SHELL ?? "",
    browser: [...RUNNER, "desktop-browser", path.join(user.dir, "browser.sock")],
    ...over,
  } satisfies LookOptions;
}

/** What Browser's socket answers one click (`open`). */
function click(socket: string): Promise<string> {
  return new Promise((resolve) => {
    let got = "";
    const conn = createConnection(socket);
    conn.setEncoding("utf8");
    conn.on("connect", () => conn.write("open\n"));
    conn.on("data", (chunk: string) => {
      got += chunk;
    });
    conn.on("error", (err) => resolve(`${got}${err.message}`));
    conn.on("close", () => resolve(got));
  });
}

const flagValue = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];

test("the password file: each password DES-encrypted with VNC's fixed key, the full one first", () => {
  expect(vncPasswordFile("password", "password").toString("hex")).toBe("dbd83cfd727a1458dbd83cfd727a1458");
  const file = vncPasswordFile("password", "Viewpw34");
  expect(file.length).toBe(16);
  expect(file.subarray(0, 8).toString("hex")).toBe("dbd83cfd727a1458");
  expect(file.subarray(8)).toEqual(vncPasswordFile("Viewpw34", "x").subarray(0, 8));
});

test("the memory available: MemAvailable from /proc/meminfo, in bytes; none when it isn't there", () => {
  const meminfo =
    "MemTotal:        8131956 kB\nMemFree:          912340 kB\nMemAvailable:    5932248 kB\nBuffers: 1 kB\n";
  expect(memAvailableBytes(meminfo)).toBe(5932248 * 1024);
  expect(memAvailableBytes("MemTotal:        8131956 kB\n")).toBeNull();
});

test("info: Linux, the runner on Bun 1.3.5 or newer, and the packages (installed without recommends)", () => {
  const t = setup();
  expect(t.desktops.info()).toEqual({ available: true, width: 1280, height: 900 });
  const ask = (system: Partial<DesktopSystem>) =>
    new DesktopSessions({ ...t.opts, system: { ...t.fake.system, ...system } }).info();
  expect(ask({ platform: "darwin" })).toMatchObject({ available: false, reason: expect.stringContaining("Linux") });
  expect(ask({ pty: false, runtime: "Node 22.12.0" }).reason).toContain("Bun 1.3.5 or newer (it runs on Node 22.12.0)");
  const missing = ask({ which: (c) => (c === "Xtigervnc" || c === "dbus-launch" ? null : `/usr/bin/${c}`) });
  expect(missing.available).toBe(false);
  expect(missing.reason).toContain(
    "sudo apt install --no-install-recommends tigervnc-standalone-server xauth dbus-x11",
  );
  expect(missing.reason).toContain("(missing: tigervnc-standalone-server, dbus-x11)");
  expect(missing.code).toBe("desktop_install");
  expect(ask({ platform: "darwin" }).code).toBe("desktop_linux");
  expect(missing.reason?.length).toBeLessThanOrEqual(500);
  expect(ask({ uid: 0 }).reason).toContain("never run as root");
});

test("a runner running as root starts a desktop only through a launcher that runs it as the agent", async () => {
  const t = setup();
  const root = { ...t.fake.system, uid: 0 };
  expect(await errorCode(() => new DesktopSessions({ ...t.opts, system: root }).ensure(dev))).toBe(
    "desktop_unavailable",
  );
  // Said to run agents as their own users, yet given no launcher: still never as root.
  const unlaunched = new DesktopSessions({ ...t.opts, system: root, agentUsers: true });
  expect(unlaunched.info().available).toBe(true);
  expect(await errorCode(() => unlaunched.ensure(dev))).toBe("desktop_unavailable");
  expect(t.fake.procs).toHaveLength(0);
  const prefix = ["/usr/sbin/runuser", "-u", "ag-01a142cb", "--"];
  const user = async (agent: AgentScope) => ({ ...(await t.opts.user(agent)), prefix });
  const launched = new DesktopSessions({ ...t.opts, system: root, agentUsers: true, user });
  await launched.ensure(dev);
  expect(t.fake.procs.length).toBeGreaterThan(0);
  for (const p of t.fake.procs) expect(p.argv.slice(0, prefix.length)).toEqual(prefix);
  launched.close();
});

test("start: Xvnc on a Unix socket only, VncAuth, never resized; the cookie and passwords never in an argument", async () => {
  const t = setup();
  const reply = await t.desktops.ensure(dev);
  expect(reply).toMatchObject({ display: 20, width: 1280, height: 900, started: true });
  const [prepare] = t.fake.of("sh");
  const [xvnc] = t.fake.of("Xtigervnc");
  const [session] = t.fake.of("dbus-launch");
  if (!prepare || !xvnc || !session) throw new Error("not started");
  const dir = path.join(t.home, "desktop", "01a142cb");

  // The cookie goes to xauth on stdin; the folder and HOME are made by the agent's user.
  expect(prepare.opts.input).toMatch(/^add :20 \. [0-9a-f]{32}\n$/);
  expect(prepare.argv.slice(-4, -2)).toEqual([dir, path.join(t.folders, "dev", ".agentes", "home")]);
  // The session starts neither agent: ssh-agent outlives the desktop, and gpg-agent's restart holds up its start.
  for (const agent of ["ssh-agent", "gpg-agent"]) {
    expect(prepare.argv.at(-2)).toContain(
      `<property name="${agent}" type="empty">\n      <property name="enabled" type="bool" value="false"/>`,
    );
  }
  expect(prepare.argv.at(-1)).toContain('<property name="vblank_mode" type="string" value="off"/>');
  const cookie = prepare.opts.input?.split(" ")[3]?.trim() ?? "";
  expect(cookie).toMatch(/^[0-9a-f]{32}$/);

  expect(xvnc.argv[0]).toBe("/usr/bin/Xtigervnc");
  expect(xvnc.argv[1]).toBe(":20");
  expect(flagValue(xvnc.argv, "-rfbport")).toBe("-1");
  expect(flagValue(xvnc.argv, "-rfbunixpath")).toBe(path.join(dir, "vnc.sock"));
  expect(flagValue(xvnc.argv, "-rfbunixmode")).toBe("0600");
  expect(flagValue(xvnc.argv, "-SecurityTypes")).toBe("VncAuth");
  expect(flagValue(xvnc.argv, "-PasswordFile")).toBe(path.join(dir, "passwd"));
  expect(flagValue(xvnc.argv, "-auth")).toBe(path.join(dir, "Xauthority"));
  expect(flagValue(xvnc.argv, "-nolisten")).toBe("tcp");
  expect(flagValue(xvnc.argv, "-geometry")).toBe("1280x900");
  expect(flagValue(xvnc.argv, "-desktop")).toBe("Dev");
  for (const flag of [
    "-AcceptSetDesktopSize=0",
    "-SendPrimary=0",
    "-FrameRate=30",
    "-UseBlacklist=0",
    "-AlwaysShared",
  ]) {
    expect(xvnc.argv).toContain(flag);
  }
  for (const flag of ["-ac", "-nopw", "-localhost", "-interface", "-rfbauth"]) expect(xvnc.argv).not.toContain(flag);
  expect(xvnc.opts.detached).toBe(true);

  const live = t.desktops.session(dev.id);
  if (!live) throw new Error("no session");
  expect(live.passwords.full).toMatch(/^[A-Za-z2-9]{8}$/);
  expect(live.passwords.view).not.toBe(live.passwords.full);
  const passwd = path.join(dir, "passwd");
  expect(readFileSync(passwd).toString("hex")).toBe(
    vncPasswordFile(live.passwords.full, live.passwords.view).toString("hex"),
  );
  expect(statSync(passwd).mode & 0o777).toBe(0o600);
  for (const p of t.fake.procs) {
    for (const part of [...p.argv, ...Object.values(p.opts.env)]) {
      for (const secret of [cookie, live.passwords.full, live.passwords.view]) expect(part).not.toContain(secret);
    }
  }

  // XFCE gets only the session's variables: nothing of the runner's own environment.
  expect(session.argv.slice(1)).toEqual(["--exit-with-session", "xfce4-session"]);
  expect(session.opts.detached).toBe(true);
  expect(Object.keys(session.opts.env).sort()).toEqual(
    [
      "ACCESSIBILITY_ENABLED",
      "DISPLAY",
      "HOME",
      "LANG",
      "LC_ALL",
      "LOGNAME",
      "PATH",
      "QT_LINUX_ACCESSIBILITY_ALWAYS_ON",
      "SHELL",
      "USER",
      "XAUTHORITY",
      "XDG_CURRENT_DESKTOP",
      "XDG_SESSION_TYPE",
    ].sort(),
  );
  expect(session.opts.env).toMatchObject({
    DISPLAY: ":20",
    XAUTHORITY: path.join(dir, "Xauthority"),
    HOME: path.join(t.folders, "dev", ".agentes", "home"),
    ACCESSIBILITY_ENABLED: "1",
    QT_LINUX_ACCESSIBILITY_ALWAYS_ON: "1",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    XDG_CURRENT_DESKTOP: "XFCE",
  });
  expect(statSync(path.join(t.home, "desktop", "01a142cb.json")).mode & 0o777).toBe(0o600);

  // Idempotent: a running desktop is only marked used.
  t.clock.now += 60_000;
  expect(await t.desktops.ensure(dev)).toMatchObject({ display: 20, started: false });
  expect(t.fake.of("Xtigervnc")).toHaveLength(1);
  expect(t.desktops.status(dev)).toEqual({
    running: true,
    startedAt: new Date(1_000_000).toISOString(),
    lastUsedAt: new Date(1_060_000).toISOString(),
    streams: 0,
  });
  t.desktops.close();
});

test("prepare: xfwm4 never waits for a vblank, in a fresh home and in the settings file xfwm4 already wrote", async () => {
  // The real scripts (the prepare and the look's), with an xauth that only takes its cookie.
  const bin = tempDir("desk-bin-");
  dirs.push(bin);
  writeFileSync(path.join(bin, "xauth"), "#!/bin/sh\ncat > /dev/null\n", { mode: 0o755 });
  const t = setup();
  const system: DesktopSystem = {
    ...t.fake.system,
    spawn(argv, opts) {
      if (path.basename(argv[0] ?? "") !== "sh") return t.fake.system.spawn(argv, opts);
      const run = Bun.spawnSync(argv, { env: { PATH: `${bin}:/usr/bin:/bin` }, stdin: Buffer.from(opts.input ?? "") });
      return { pid: 1, exited: Promise.resolve(run.exitCode) };
    },
  };
  const desktops = new DesktopSessions({ ...t.opts, system });
  const xfconf = path.join(t.folders, "dev", ".agentes", "home", ".config", "xfce4", "xfconf", "xfce-perchannel-xml");
  const settings = path.join(xfconf, "xfwm4.xml");

  await desktops.ensure(dev);
  expect(readFileSync(settings, "utf8")).toContain('<property name="vblank_mode" type="string" value="off"/>');
  expect(readFileSync(path.join(xfconf, "xfce4-session.xml"), "utf8")).toContain('name="ssh-agent"');
  expect(readFileSync(path.join(xfconf, "xfce4-session.xml"), "utf8")).toContain('name="gpg-agent"');
  // The look's own xfwm4 settings came after, the vblank still off.
  expect(readFileSync(settings, "utf8")).toContain('name="margin_bottom"');
  const home = path.join(t.folders, "dev", ".agentes", "home");
  expect(readFileSync(path.join(home, LOOK_MARKER), "utf8")).toBe(`${lookId(home, await lookOf(t, dev))}\n`);

  // xfwm4 writes every setting it has on its first start; the next start changes that one only.
  const own = [
    '<?xml version="1.1" encoding="UTF-8"?>',
    "",
    '<channel name="xfwm4" version="1.0">',
    '  <property name="general" type="empty">',
    '    <property name="use_compositing" type="bool" value="true"/>',
    '    <property name="vblank_mode" type="string" value="auto"/>',
    '    <property name="workspace_count" type="int" value="4"/>',
    "  </property>",
    "</channel>",
    "",
  ].join("\n");
  writeFileSync(settings, own);
  await desktops.stop(dev);
  await desktops.ensure(dev);
  expect(readFileSync(settings, "utf8")).toBe(own.replace('value="auto"', 'value="off"'));
  desktops.close();
});

test("the look: written as the agent into its desktop's HOME, after the prepare, while X starts", async () => {
  const t = setup();
  await t.desktops.ensure(dev);
  const [prepare] = t.fake.of("sh");
  const [look] = t.fake.of("agentes-look");
  const [xvnc] = t.fake.of("Xtigervnc");
  if (!prepare || !look || !xvnc) throw new Error("not started");
  expect(t.fake.procs.indexOf(prepare)).toBeLessThan(t.fake.procs.indexOf(look));
  expect(t.fake.procs.indexOf(look)).toBeLessThan(t.fake.procs.indexOf(xvnc));
  const home = path.join(t.folders, "dev", ".agentes", "home");
  const stock = await lookOf(t, dev);
  // Browser runs this runner's own command, with the desktop's socket next to its cookie and password file.
  expect(stock.browser).toEqual([
    ...RUNNER,
    "desktop-browser",
    path.join(t.home, "desktop", "01a142cb", "browser.sock"),
  ]);
  expect(look.argv).toEqual([
    "/bin/sh",
    "-c",
    LOOK_SCRIPT,
    "agentes-look",
    home,
    lookId(home, stock),
    LOOK_MARKER,
    String(lookFiles(home, stock).length),
  ]);
  expect(look.opts).toMatchObject({ cwd: "/", env: { HOME: home } });
  expect(look.opts.input?.startsWith(".config/xfce4/xfconf/xfce-perchannel-xml/xfce4-panel.xml ")).toBe(true);
  // What it has is recorded, so a later runner knows it needs nothing more (`refresh`).
  const state = path.join(t.home, "desktop", "01a142cb.json");
  expect(JSON.parse(readFileSync(state, "utf8"))).toMatchObject({
    look: lookId(home, stock),
    params: ["SendPrimary=0"],
  });
  await t.desktops.stop(dev);

  // A computer with Orchis and gdk-pixbuf's SVG loader gets its theme; one with docklike, its dock.
  t.fake.files.add("/usr/share/themes/Orchis-Light/xfwm4/themerc");
  t.fake.files.add("/usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0/2.10.0/loaders/libpixbufloader_svg.so");
  await t.desktops.ensure(dev);
  expect(t.fake.of("agentes-look").at(-1)?.argv[5]).toBe(lookId(home, await lookOf(t, dev, { theme: "orchis" })));
  await t.desktops.stop(dev);
  t.fake.files.add("/usr/share/xfce4/panel/plugins/docklike.desktop");
  t.fake.files.add("/usr/lib/x86_64-linux-gnu/xfce4/panel/plugins/libdocklike.so");
  await t.desktops.ensure(dev);
  expect(t.fake.of("agentes-look").at(-1)?.argv[5]).toBe(
    lookId(home, await lookOf(t, dev, { theme: "orchis", dock: "docklike" })),
  );
  t.desktops.close();
});

test.if(posix)(
  "Browser on the desktop: a socket while the desktop runs, and a click on it asks the runner for that agent's browser",
  async () => {
    const asked: string[] = [];
    let refusal: string | null = null;
    const t = setup({
      openBrowser: async (agent, installing) => {
        asked.push(agent.handle);
        if (refusal) throw new RunnerError("not_allowed", refusal);
        if (agent.handle === "ops") installing();
      },
    });
    await t.desktops.ensure(dev);
    const socket = path.join(t.home, "desktop", "01a142cb", "browser.sock");
    expect(statSync(socket).isSocket()).toBe(true);
    expect(await click(socket)).toBe("ok\n");
    expect(asked).toEqual(["dev"]);
    // Refused: the launcher hears the code, the runner's log the reason.
    refusal = "The browser is turned off on this computer";
    expect(await click(socket)).toBe("error not_allowed\n");
    expect(t.logs).toContain("Browser on the desktop of dev didn't open: The browser is turned off on this computer");
    refusal = null;
    asked.length = 0;
    expect(await click(socket)).toBe("ok\n");
    expect(asked).toEqual(["dev"]);
    // Each desktop its own: ops's click is ops's.
    await t.desktops.ensure(ops);
    expect(await click(path.join(t.home, "desktop", "9f00aa11", "browser.sock"))).toBe("installing\nok\n");
    expect(asked).toEqual(["dev", "ops"]);
    // Gone with its desktop.
    await t.desktops.stop(dev);
    expect(existsSync(socket)).toBe(false);
    t.desktops.close();
    await t.desktops.stopAll();

    // A runner that can't open the agent's browser makes no socket for it.
    const none = setup();
    await none.desktops.ensure(dev);
    expect(existsSync(path.join(none.home, "desktop", "01a142cb", "browser.sock"))).toBe(false);
    none.desktops.close();
  },
);

test.if(posix)("a desktop taken back by the next runner gets its Browser's socket again", async () => {
  const asked: string[] = [];
  const t = setup();
  const before = new DesktopSessions({ ...t.opts, system: gone(t.fake.system) });
  await before.ensure(dev);
  before.close();
  const next = new DesktopSessions({ ...t.opts, openBrowser: async (agent) => void asked.push(agent.handle) });
  next.restore();
  expect(next.hasActivity(dev.id)).toBe(true);
  const socket = path.join(t.home, "desktop", "01a142cb", "browser.sock");
  await waitFor(() => existsSync(socket));
  expect(await click(socket)).toBe("ok\n");
  expect(asked).toEqual(["dev"]);
  await next.stopAll();
});

test("a look that can't be written never stops the desktop: it starts as its HOME has it", async () => {
  const t = setup();
  t.fake.failLook(true);
  expect(await t.desktops.ensure(dev)).toMatchObject({ started: true });
  expect(t.desktops.status(dev).running).toBe(true);
  expect(t.logs.some((l) => l.includes("keeps the look its home has"))).toBe(true);
  // Its session doesn't show this look: a sweep tries it in place.
  expect(JSON.parse(readFileSync(path.join(t.home, "desktop", "01a142cb.json"), "utf8"))).not.toHaveProperty("look");
  t.desktops.close();
});

test("a step before X that is held up (a pipe in the HOME, a hung disk) is stopped: never the agent's desktop", async () => {
  const t = setup({ stepMs: 30 });
  t.fake.hangs.add("agentes-look");
  expect(await t.desktops.ensure(dev)).toMatchObject({ started: true });
  const [look] = t.fake.of("agentes-look");
  expect(t.fake.kills).toContainEqual([look?.pid ?? 0, "SIGTERM"]);
  expect(t.logs).toContainEqual(expect.stringContaining("writing the agentes.chat look was stopped after 0.03 s"));
  await t.desktops.stop(dev);

  // The prepare held up: that start fails, the display is free again, and the next start goes on.
  t.fake.hangs.clear();
  t.fake.hangs.add("sh");
  expect(await errorCode(() => t.desktops.ensure(dev))).toBe("internal");
  const [, prepare] = t.fake.of("sh");
  expect(t.fake.kills).toContainEqual([prepare?.pid ?? 0, "SIGTERM"]);
  t.fake.hangs.clear();
  expect(await t.desktops.ensure(dev)).toMatchObject({ display: 20, started: true });
  t.desktops.close();
});

test("the screen server starts while the look is written; the session waits for both", async () => {
  const t = setup();
  t.fake.hangs.add("agentes-look");
  const starting = t.desktops.ensure(dev);
  expect(t.desktops.hasActivity(dev.id)).toBe(true);
  expect(t.desktops.processId(dev.id)).toBeNull();
  await waitFor(() => t.fake.of("Xtigervnc").length === 1);
  // X is up and the look still writes XFCE's files: XFCE doesn't start before they are all there.
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(t.fake.of("dbus-launch")).toHaveLength(0);
  t.fake.of("agentes-look")[0]?.exit(0);
  expect(await starting).toMatchObject({ started: true });
  expect(t.fake.of("dbus-launch")).toHaveLength(1);
  await t.desktops.stop(dev);
  expect(t.desktops.hasActivity(dev.id)).toBe(false);

  // A screen server that doesn't start fails the start once the look is done, never under it.
  t.fake.failXvnc("no display");
  let failed = false;
  const failing = t.desktops.ensure(dev).catch(() => {
    failed = true;
  });
  await waitFor(() => t.fake.of("agentes-look").length === 2);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(failed).toBe(false);
  t.fake.of("agentes-look")[1]?.exit(0);
  await failing;
  expect(failed).toBe(true);
  t.desktops.close();
});

test("a start that fails before its screen server is up, its password file unwritable, ends after the look too", async () => {
  const t = setup();
  t.fake.hangs.add("agentes-look");
  // A folder where the password file goes: writing it fails.
  mkdirSync(path.join((await t.opts.user(dev)).dir, "passwd"), { recursive: true });
  let failed = false;
  const failing = t.desktops.ensure(dev).catch(() => {
    failed = true;
  });
  await waitFor(() => t.fake.of("agentes-look").length === 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(failed).toBe(false);
  expect(t.fake.of("Xtigervnc")).toHaveLength(0);
  t.fake.of("agentes-look")[0]?.exit(0);
  await failing;
  expect(failed).toBe(true);
  t.desktops.close();
});

test("each start's line says where its time went; its session's programs follow once it settled, from /proc", async () => {
  const t = setup();
  await t.desktops.ensure(dev);
  expect(t.logs).toContain(
    "the desktop of dev started on :20 in 0.00 s: room and its user 0.00 s, prepared in 0.00 s, its screen in 0.00 s (the look in 0.00 s meanwhile), its session in 0.00 s",
  );
  const [launched] = t.fake.of("dbus-launch");
  if (!launched) throw new Error("not started");
  // dbus-launch became the session (system mode: runuser's child); another desktop's programs aren't its own.
  t.fake.stats.push(
    { pid: launched.pid, ppid: 1, name: "xfce4-session", start: 5000, cpu: 0.2 },
    { pid: 9001, ppid: launched.pid, name: "xfwm4", start: 5000.31, cpu: 0.4 },
    { pid: 9002, ppid: launched.pid, name: "xfsettingsd", start: 5000.88, cpu: 3.1 },
    { pid: 9003, ppid: launched.pid, name: "xfce4-panel", start: 5003.9, cpu: 0.5 },
    // docklike's and another plugin's: one program, their CPU time together.
    { pid: 9004, ppid: 9003, name: "wrapper-2.0", start: 5004.1, cpu: 0.3 },
    { pid: 9006, ppid: 9003, name: "wrapper-2.0", start: 5004.2, cpu: 0.05 },
    { pid: 9005, ppid: launched.pid, name: "Thunar", start: 5003.95, cpu: 0.1 },
    { pid: 9100, ppid: 4242, name: "xfdesktop", start: 4000, cpu: 9 },
  );
  const told = () => t.logs.filter((l) => l.startsWith("the desktop of dev: its session started"));
  t.clock.now += 14_000;
  await t.desktops.sweep();
  expect(told()).toEqual([]);
  t.clock.now += 1000;
  await t.desktops.sweep();
  expect(told()).toEqual([
    "the desktop of dev: its session started xfwm4 at 0.31 s (0.40 s of CPU), xfsettingsd at 0.88 s (3.10 s of CPU), xfce4-panel at 3.90 s (0.50 s of CPU), wrapper-2.0 at 4.10 s (0.35 s of CPU), Thunar at 3.95 s (0.10 s of CPU), xfdesktop not yet",
  ]);
  // Once.
  t.clock.now += 60_000;
  await t.desktops.sweep();
  expect(told()).toHaveLength(1);

  // A desktop the next runner takes back has no start of its own to tell.
  const next = new DesktopSessions({ ...t.opts, system: gone(t.fake.system) });
  next.restore();
  t.clock.now += 60_000;
  await next.sweep();
  expect(told()).toHaveLength(1);
  next.close();
  t.desktops.close();
});

test("a process in /proc: its parent, its name with spaces and parentheses, its start since boot and its CPU time", () => {
  // The 52 fields of /proc/<pid>/stat, in hundredths of a second: its time in user and kernel mode the 14th and 15th,
  // its start the 22nd.
  const rest = (start: number, user = 0, kernel = 0) =>
    `S 4321 ${[...Array(9).fill(0), user, kernel, ...Array(6).fill(0)].join(" ")} ${start} ${Array(30).fill(0).join(" ")}`;
  expect(procStat(`1234 (xfce4-panel) ${rest(503390, 250, 61)}`)).toEqual({
    pid: 1234,
    ppid: 4321,
    name: "xfce4-panel",
    start: 5033.9,
    cpu: 3.11,
  });
  expect(procStat(`77 (Web Content (x) y) ${rest(10)}`)).toMatchObject({ name: "Web Content (x) y", start: 0.1 });
  expect(procStat("not a stat line")).toBeNull();
});

test("system mode: every process as the agent, and the password file root's (readable by the agent's group only)", async () => {
  const root = tempDir("desk-sys-");
  // Root's own folder for the desktops (`/run/agentes-desktop`); short, as a socket's path has at most 103 bytes.
  const runDir = tempDir("ads-");
  dirs.push(root, runDir);
  const home = path.join(root, "home", "ag-01a142cb");
  const gid = process.getgid?.() ?? 0;
  const prefix = ["/usr/sbin/runuser", "-u", "ag-01a142cb", "--"];
  const user: DesktopUser = {
    prefix,
    env: {
      HOME: home,
      USER: "ag-01a142cb",
      LOGNAME: "ag-01a142cb",
      SHELL: "/bin/bash",
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
    },
    home,
    dir: path.join(home, ".agentes", "desktop"),
    ids: { uid: 21001, gid },
  };
  const asked: string[] = [];
  const t = setup({ user: async () => user, runDir, openBrowser: async (agent) => void asked.push(agent.handle) });
  await t.desktops.ensure(dev);
  for (const p of t.fake.procs) expect(p.argv.slice(0, prefix.length)).toEqual(prefix);
  // The look goes into the agent's own home, written by the agent.
  expect(t.fake.of("agentes-look")[0]?.argv[prefix.length + 4]).toBe(home);
  // Browser's socket is root's, next to the password file, where only the agent's group may write to it; the
  // agent's own folders, which the agent could swap under root, have none.
  const socket = path.join(runDir, "21001", "browser.sock");
  const sock = statSync(socket);
  expect([sock.isSocket(), sock.mode & 0o777, sock.gid]).toEqual([true, 0o660, gid]);
  expect(existsSync(path.join(home, ".agentes", "desktop", "browser.sock"))).toBe(false);
  if (posix) {
    expect(await click(socket)).toBe("ok\n");
    expect(asked).toEqual(["dev"]);
  }
  const [xvnc] = t.fake.of("Xtigervnc");
  const passwd = path.join(runDir, "21001", "passwd");
  expect(flagValue(xvnc?.argv ?? [], "-PasswordFile")).toBe(passwd);
  expect(flagValue(xvnc?.argv ?? [], "-rfbunixpath")).toBe(path.join(home, ".agentes", "desktop", "vnc.sock"));
  const live = t.desktops.session(dev.id);
  const written = vncPasswordFile(live?.passwords.full ?? "", live?.passwords.view ?? "");
  expect(readFileSync(passwd).toString("hex")).toBe(written.toString("hex"));
  const file = statSync(passwd);
  expect([file.mode & 0o777, file.uid, file.gid]).toEqual([0o440, process.getuid?.() ?? 0, gid]);
  const folder = statSync(path.dirname(passwd));
  expect([folder.mode & 0o777, folder.gid]).toEqual([0o750, gid]);
  expect(statSync(runDir).mode & 0o777).toBe(0o711);
  // Nothing of the runner's is written into the agent's own folders.
  expect(existsSync(path.join(home, ".agentes", "desktop", "passwd"))).toBe(false);

  expect(await t.desktops.stop(dev)).toEqual({ stopped: true });
  expect(existsSync(passwd)).toBe(false);
  expect(existsSync(socket)).toBe(false);
});

test("system mode's desktop user: the agent's launcher and home; the cookie and the socket in ~/.agentes/desktop", () => {
  const launcher = systemLauncher({ id: dev.id, user: "ag-01a142cb", uid: 21001 }, true);
  expect(systemDesktopUser(launcher, { uid: 21001, gid: 21004 })).toEqual({
    prefix: launcher.prefix,
    env: launcher.env,
    home: "/home/ag-01a142cb",
    dir: "/home/ag-01a142cb/.agentes/desktop",
    ids: { uid: 21001, gid: 21004 },
    // Its X server's lock is in its own /tmp, where root looks for it.
    tmp: "/run/agentes-runner-tmp/21001/tmp",
  });
  expect(launcher.prefix.at(-2)).toBe("ag-01a142cb");
  expect(launcher.env.HOME).toBe("/home/ag-01a142cb");
});

test("slots: an agent keeps its display; one held by another process is skipped, a stale lock is cleared", async () => {
  const t = setup();
  // :20 is held by a live X server that isn't ours; :21's server is gone.
  writeFileSync(path.join(t.lockDir, ".X20-lock"), "       777\n");
  t.fake.others.set(777, ["/usr/lib/xorg/Xorg", ":20"]);
  writeFileSync(path.join(t.lockDir, ".X21-lock"), "       778\n");
  mkdirSync(path.join(t.lockDir, ".X11-unix"));
  writeFileSync(path.join(t.lockDir, ".X11-unix", "X21"), "");

  expect((await t.desktops.ensure(dev)).display).toBe(21);
  expect(existsSync(path.join(t.lockDir, ".X11-unix", "X21"))).toBe(false);
  expect((await t.desktops.ensure(ops)).display).toBe(22);
  expect(JSON.parse(readFileSync(path.join(t.home, "desktop", "slots.json"), "utf8"))).toEqual({
    [dev.id]: 1,
    [ops.id]: 2,
  });

  // Both stop; dev comes back first and still gets its own display, not ops's.
  await t.desktops.stop(dev);
  await t.desktops.stop(ops);
  expect((await t.desktops.ensure(ops)).display).toBe(22);
  expect((await t.desktops.ensure(dev)).display).toBe(21);
  t.desktops.close();
});

test("an agent's own /tmp: its X server's lock is read there, never in the computer's", async () => {
  const own = tempDir("desk-own-");
  dirs.push(own);
  const t = setup({}, own);
  const user = t.opts.user;
  const desktops = new DesktopSessions({ ...t.opts, user: async (agent) => ({ ...(await user(agent)), tmp: own }) });
  expect((await desktops.ensure(dev)).display).toBe(20);
  expect(existsSync(path.join(own, ".X20-lock"))).toBe(true);
  expect(existsSync(path.join(t.lockDir, ".X20-lock"))).toBe(false);
  desktops.close();
});

test("a display whose abstract X socket someone holds is taken: an X server's, or the name an agent squats", async () => {
  const t = setup();
  const unix = [
    "Num       RefCount Protocol Flags    Type St Inode Path",
    "0000000000000000: 00000002 00000000 00010000 0001 01 23456 @/tmp/.X11-unix/X20",
    "0000000000000000: 00000002 00000000 00010000 0001 01 23457 /tmp/.X11-unix/X21",
    "0000000000000000: 00000003 00000000 00000000 0001 03 23458 @/tmp/.X11-unix/X220",
    "0000000000000000: 00000003 00000000 00000000 0001 03 23459 @/tmp/.X11-unix/X22-other",
  ].join("\n");
  expect([...abstractDisplays(unix)]).toEqual([20, 220]);
  t.fake.system.unixSockets = () => unix;
  expect((await t.desktops.ensure(dev)).display).toBe(21);
  t.desktops.close();
});

test.if(posix)("a display lock that is a pipe or a link never stalls root: read as no lock at all", async () => {
  const t = setup();
  expect(spawnSync("mkfifo", [path.join(t.lockDir, ".X20-lock")]).status).toBe(0);
  symlinkSync("/etc/passwd", path.join(t.lockDir, ".X21-lock"));
  expect((await t.desktops.ensure(dev)).display).toBe(20);
  expect((await t.desktops.ensure(ops)).display).toBe(21);
  t.desktops.close();
});

test("restore: a desktop left running is taken back only when its pid is still that display's Xtigervnc", async () => {
  const t = setup();
  const before = new DesktopSessions({ ...t.opts, system: gone(t.fake.system) });
  await before.ensure(dev);
  await before.ensure(ops);
  before.close();
  const stateOf = (agent: string) => path.join(t.home, "desktop", `${agent}.json`);
  // ops's pid now belongs to something else (reused); a third file names a display its pid isn't on.
  const opsXvnc = t.fake.of("Xtigervnc")[1];
  if (!opsXvnc) throw new Error("ops not started");
  opsXvnc.alive = false;
  t.fake.others.set(opsXvnc.pid, ["/bin/bash"]);
  const qa = { id: "77aa0000-0000-7000-8000-000000000000", handle: "qa" };
  const devState = JSON.parse(readFileSync(stateOf("01a142cb"), "utf8"));
  writeFileSync(stateOf("77aa0000"), JSON.stringify({ ...devState, agent: qa, display: 25 }));

  const next = new DesktopSessions(t.opts);
  next.restore();
  expect(next.status(dev).running).toBe(true);
  expect(next.status(ops).running).toBe(false);
  expect(next.status(qa).running).toBe(false);
  expect(existsSync(stateOf("01a142cb"))).toBe(true);
  expect(existsSync(stateOf("9f00aa11"))).toBe(false);
  expect(existsSync(stateOf("77aa0000"))).toBe(false);
  expect(next.session(dev.id)?.passwords).toEqual(before.session(dev.id)?.passwords);
  // Taken back as it is: nothing new starts. :21's lock still names a live process (the reused pid).
  expect(await next.ensure(dev)).toMatchObject({ display: 20, started: false });
  expect(t.fake.of("Xtigervnc")).toHaveLength(2);
  expect((await next.ensure(qa)).display).toBe(22);
  next.close();
});

test("Terminals open when the computer restarted open again at the desktop's next start: new shells in their folders, saying why", async () => {
  const t = setup();
  const before = new DesktopSessions({ ...t.opts, system: gone(t.fake.system) });
  const { display } = await before.ensure(dev);
  // Two shells in the Terminal on its display (the dock starts it apart from the session), one on another desktop.
  const site = path.join(t.folders, "dev", "site");
  const notes = path.join(t.folders, "dev", "notes");
  t.fake.stats.push(
    { pid: 7000, ppid: 1, name: "xfce4-terminal", start: 50, cpu: 1 },
    { pid: 7002, ppid: 7000, name: "bash", start: 52, cpu: 0 },
    { pid: 7001, ppid: 7000, name: "bash", start: 51, cpu: 0 },
    { pid: 7100, ppid: 1, name: "xfce4-terminal", start: 50, cpu: 1 },
    { pid: 7101, ppid: 7100, name: "bash", start: 51, cpu: 0 },
  );
  t.fake.envs.set(7000, { DISPLAY: `:${display}` });
  t.fake.envs.set(7100, { DISPLAY: `:${display + 1}` });
  t.fake.cwds.set(7001, site);
  t.fake.cwds.set(7002, notes);
  t.fake.cwds.set(7101, path.join(t.folders, "ops"));
  await before.sweep();
  before.close();

  // The computer restarts: nothing of the desktop runs anymore, and `notes` didn't come back.
  for (const p of t.fake.procs) p.alive = false;
  t.fake.stats.length = 0;
  t.fake.files.add(site);
  const next = new DesktopSessions(t.opts);
  next.restore();
  expect(next.status(dev).running).toBe(false);
  await next.ensure(dev);
  const terminals = () => t.fake.procs.filter((p) => p.argv.some((a) => path.basename(a) === "xfce4-terminal"));
  // Not before its session settled.
  await next.sweep();
  expect(terminals()).toEqual([]);
  const session = t.fake.of("dbus-launch").at(-1);
  if (!session) throw new Error("no session");
  t.fake.stats.push(
    { pid: session.pid, ppid: 1, name: "dbus-launch", start: 99, cpu: 0 },
    { pid: 9000, ppid: session.pid, name: "xfce4-session", start: 100, cpu: 1 },
  );
  t.fake.envs.set(9000, { DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/dbus-0f1e,guid=0f1e", LD_PRELOAD: "/tmp/x.so" });
  t.clock.now += 15_000;
  await next.sweep();
  expect(terminals().map((p) => p.argv)).toEqual([
    ["/usr/bin/xfce4-terminal", "--disable-server", `--working-directory=${site}`],
  ]);
  // On the session's bus (the Terminal's settings: the look's prompt says the note), and nothing else of its
  // environment: the agent's processes never hand the launcher anything.
  const env = terminals()[0]?.opts.env;
  expect(env).toMatchObject({
    DISPLAY: `:${display}`,
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/dbus-0f1e,guid=0f1e",
    [TERMINAL_NOTE_ENV]: terminalNote(false),
  });
  expect(env).not.toHaveProperty("LD_PRELOAD");
  // Once: later sweeps keep what is open now and open nothing more; a desktop stopped on purpose forgets it.
  t.clock.now += 60_000;
  await next.sweep();
  expect(terminals()).toHaveLength(1);
  t.fake.stats.push({ pid: 9100, ppid: 1, name: "xfce4-terminal", start: 120, cpu: 1 });
  t.fake.stats.push({ pid: 9101, ppid: 9100, name: "bash", start: 121, cpu: 0 });
  t.fake.envs.set(9100, { DISPLAY: `:${display}` });
  t.fake.cwds.set(9101, site);
  await next.sweep();
  const open = path.join(t.home, "desktop", "01a142cb.open");
  expect(JSON.parse(readFileSync(open, "utf8"))).toEqual({ terminals: [site] });
  await next.stop(dev);
  expect(existsSync(open)).toBe(false);
});

/** The keeper's list of the desktop's app windows in the agent's HOME (`desktop-keeper.py` writes it). */
function keeperList(home: string, list: unknown) {
  const file = path.join(home, KEEPER_STATE);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(list));
  return file;
}

test("after a move the desktop opens again its browser and its other apps as the keeper listed them, each as the agent in its folder, and its Terminals say the computer moved", async () => {
  const opened: string[] = [];
  const openBrowser = async (agent: AgentScope) => {
    opened.push(agent.id);
  };
  const t = setup();
  const here = { ...t.fake.system, machineId: () => "machine-a" };
  const before = new DesktopSessions({ ...t.opts, system: gone(here) });
  const { display } = await before.ensure(dev);
  const home = (await t.opts.user(dev)).home;
  const notes = path.join(t.folders, "dev", "notes");
  t.fake.stats.push(
    { pid: 7000, ppid: 1, name: "xfce4-terminal", start: 50, cpu: 1 },
    { pid: 7001, ppid: 7000, name: "bash", start: 51, cpu: 0 },
  );
  t.fake.envs.set(7000, { DISPLAY: `:${display}` });
  t.fake.cwds.set(7001, notes);
  keeperList(home, {
    v: 1,
    browser: true,
    apps: [
      { argv: ["mousepad", "todo.txt"], cwd: notes },
      { argv: ["thunar"], cwd: home },
      // What a list may not hold is left out: a relative folder, no command, a command line too long.
      { argv: ["evil"], cwd: "relative" },
      { argv: [], cwd: home },
      { argv: ["big", "x".repeat(5000)], cwd: home },
    ],
  });
  await before.sweep();
  const open = path.join(t.home, "desktop", "01a142cb.open");
  expect(JSON.parse(readFileSync(open, "utf8"))).toEqual({
    terminals: [notes],
    apps: [
      { argv: ["mousepad", "todo.txt"], cwd: notes },
      { argv: ["thunar"], cwd: home },
    ],
    browser: true,
    machine: "machine-a",
  });
  before.close();

  // The workspace moved to another computer: its files came along, nothing of the desktop runs.
  for (const p of t.fake.procs) p.alive = false;
  t.fake.stats.length = 0;
  t.fake.files.add(notes);
  const next = new DesktopSessions({
    ...t.opts,
    openBrowser,
    system: { ...t.fake.system, machineId: () => "machine-b" },
  });
  next.restore();
  await next.ensure(dev);
  const session = t.fake.of("dbus-launch").at(-1);
  if (!session) throw new Error("no session");
  t.fake.stats.push(
    { pid: session.pid, ppid: 1, name: "dbus-launch", start: 99, cpu: 0 },
    { pid: 9000, ppid: session.pid, name: "xfce4-session", start: 100, cpu: 1 },
  );
  t.fake.envs.set(9000, { DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/dbus-0f1e,guid=0f1e", API_TOKEN: "t0ps3cret" });
  t.clock.now += 15_000;
  await next.sweep();
  expect(opened).toEqual([dev.id]);
  const terminal = t.fake.procs.find((p) => p.argv.some((a) => path.basename(a) === "xfce4-terminal"));
  expect(terminal?.opts.env).toMatchObject({ [TERMINAL_NOTE_ENV]: terminalNote(true) });
  expect(terminalNote(true)).toBe("The computer moved to another server: this is a new shell in the same folder.");
  const apps = t.fake.of("agentes-app");
  expect(apps.map((p) => p.argv.slice(4))).toEqual([
    [notes, "mousepad", "todo.txt"],
    [home, "thunar"],
  ]);
  // Root never enters the folder: the agent's own shell does, and falls back to its home.
  expect(apps[0]?.argv.slice(0, 4)).toEqual([
    "/bin/sh",
    "-c",
    'cd "$1" 2>/dev/null || cd; shift; exec "$@"',
    "agentes-app",
  ]);
  expect(apps[0]?.opts.cwd).toBe("/");
  expect(apps[0]?.opts.env).toMatchObject({
    DISPLAY: `:${display}`,
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/dbus-0f1e,guid=0f1e",
  });
  expect(apps[0]?.opts.env).not.toHaveProperty("API_TOKEN");
  expect(apps[0]?.opts.env).not.toHaveProperty(TERMINAL_NOTE_ENV);
  expect(t.logs).toContainEqual(
    "the desktop of dev opened again after the computer moved: 1 terminals, 2 other apps, its browser",
  );
  // Once.
  t.clock.now += 60_000;
  await next.sweep();
  expect(opened).toEqual([dev.id]);
  expect(t.fake.of("agentes-app")).toHaveLength(2);
  await next.stop(dev);
});

test("the keeper's list is read only as a plain file of the HOME's owner, never through a link", async () => {
  const t = setup();
  await t.desktops.ensure(dev);
  const home = (await t.opts.user(dev)).home;
  const elsewhere = path.join(t.folders, "elsewhere.json");
  writeFileSync(elsewhere, JSON.stringify({ v: 1, browser: true, apps: [{ argv: ["leak"], cwd: home }] }));
  const file = path.join(home, KEEPER_STATE);
  mkdirSync(path.dirname(file), { recursive: true });
  symlinkSync(elsewhere, file);
  await t.desktops.sweep();
  expect(existsSync(path.join(t.home, "desktop", "01a142cb.open"))).toBe(false);
  rmSync(file);
  keeperList(home, { v: 1, browser: true, apps: [] });
  await t.desktops.sweep();
  expect(JSON.parse(readFileSync(path.join(t.home, "desktop", "01a142cb.open"), "utf8"))).toEqual({
    terminals: [],
    browser: true,
  });
});

test("a desktop that ends once the runner is stopping keeps what was open and isn't started again: a reboot stops both", async () => {
  const t = setup();
  const { display } = await t.desktops.ensure(dev);
  const notes = path.join(t.folders, "dev", "notes");
  t.fake.stats.push(
    { pid: 7000, ppid: 1, name: "xfce4-terminal", start: 50, cpu: 1 },
    { pid: 7001, ppid: 7000, name: "bash", start: 51, cpu: 0 },
  );
  t.fake.envs.set(7000, { DISPLAY: `:${display}` });
  t.fake.cwds.set(7001, notes);
  await t.desktops.sweep();
  const open = path.join(t.home, "desktop", "01a142cb.open");
  expect(existsSync(open)).toBe(true);
  const xvncs = t.fake.of("Xtigervnc").length;
  t.desktops.close();
  // The computer shuts down: the desktop's processes end while the runner is still stopping.
  for (const p of t.fake.procs) p.exit(null);
  await Bun.sleep(10);
  expect(existsSync(open)).toBe(true);
  expect(t.fake.of("Xtigervnc")).toHaveLength(xvncs);
});

/**
 * The agent's desktop as an earlier runner left it running: its Xtigervnc without the flags added since, and
 * nothing recorded of its flags or its look. Its `<id8>.json`.
 */
async function leftByEarlierRunner(t: ReturnType<typeof setup>, agent: AgentScope) {
  const before = new DesktopSessions({ ...t.opts, system: gone(t.fake.system) });
  await before.ensure(agent);
  before.close();
  const xvnc = t.fake.of("Xtigervnc").at(-1);
  if (!xvnc) throw new Error("not started");
  xvnc.argv = xvnc.argv.filter((a) => a !== "-SendPrimary=0");
  const state = path.join(t.home, "desktop", `${agent.id.slice(0, 8)}.json`);
  const { look: _look, params: _params, ...earlier } = JSON.parse(readFileSync(state, "utf8"));
  writeFileSync(state, JSON.stringify(earlier));
  return state;
}

/** The look written into a running session (`lookCommand`'s live mode). */
const live = (p: FakeProc) => p.argv.at(-1) === "/proc";

test("a desktop an earlier runner left running gets this runner's flags at once and its look once unused for a minute, as its agent, once", async () => {
  const t = setup();
  const state = await leftByEarlierRunner(t, dev);
  const home = path.join(t.folders, "dev", ".agentes", "home");
  const dir = path.join(t.home, "desktop", "01a142cb");
  // Until the runner reaches the server its agents' users aren't known: the next sweep tries again.
  let connected = false;
  const next = new DesktopSessions({
    ...t.opts,
    user: async (agent) => {
      if (!connected) throw new RunnerError("internal", "This runner isn't connected to a workspace");
      return t.opts.user(agent);
    },
  });
  next.restore();
  // Its agent as the earlier runner knew it may be out of date: nothing until this runner hears of it.
  await next.sweep();
  expect(t.fake.of("agentes-xvnc")).toHaveLength(0);
  await next.serve([dev]);
  await next.sweep();
  expect(t.fake.of("agentes-xvnc")).toHaveLength(0);
  connected = true;
  await next.sweep();

  // Xtigervnc takes SendPrimary=0 while it runs, from the agent on its display; the look waits for a quiet minute.
  const [flags] = t.fake.of("agentes-xvnc");
  expect(flags?.argv.slice(-2)).toEqual(["agentes-xvnc", "SendPrimary=0"]);
  expect(flags?.opts.env).toMatchObject({ DISPLAY: ":20", XAUTHORITY: path.join(dir, "Xauthority"), HOME: home });
  expect(t.fake.of("agentes-look").filter(live)).toHaveLength(0);
  expect(JSON.parse(readFileSync(state, "utf8"))).toMatchObject({ params: ["SendPrimary=0"] });
  expect(t.logs).toContain("the desktop of dev took SendPrimary=0 while running");

  t.clock.now += 60_000;
  await next.sweep();
  const want = lookCommand(home, await lookOf(t, dev), true);
  const [look] = t.fake.of("agentes-look").filter(live);
  expect(look?.argv).toEqual(want.argv);
  expect(look?.opts.input).toBe(want.input);
  expect(look?.opts.env).toMatchObject({ DISPLAY: ":20", HOME: home });
  expect(JSON.parse(readFileSync(state, "utf8")).look).toBe(want.id);
  expect(t.logs).toContain("the desktop of dev has this runner's look");

  // Once: neither again, in this runner or the next; and nothing of it stopped or started the desktop.
  t.clock.now += 60_000;
  await next.sweep();
  const after = new DesktopSessions(t.opts);
  after.restore();
  await after.serve([dev]);
  t.clock.now += 60_000;
  await after.sweep();
  expect(t.fake.of("agentes-xvnc")).toHaveLength(1);
  expect(t.fake.of("agentes-look").filter(live)).toHaveLength(1);
  expect(t.fake.kills).toEqual([]);
  expect(t.fake.of("Xtigervnc")).toHaveLength(1);
  next.close();
  after.close();
});

test("a running desktop's new look waits while someone watches it, its agent's browser is in use there, or a request touched it within the minute", async () => {
  let chrome = false;
  const t = setup({ inUse: () => chrome });
  await leftByEarlierRunner(t, dev);
  const next = new DesktopSessions(t.opts);
  next.restore();
  await next.serve([dev]);
  const looks = () => t.fake.of("agentes-look").filter(live).length;
  const release = next.hold(dev.id);
  t.clock.now += 2 * 60_000;
  await next.sweep();
  expect(looks()).toBe(0);
  // The flags don't wait: setting them shows nothing.
  expect(t.fake.of("agentes-xvnc")).toHaveLength(1);
  release?.();
  chrome = true;
  t.clock.now += 2 * 60_000;
  await next.sweep();
  expect(looks()).toBe(0);
  chrome = false;
  await next.ensure(dev);
  t.clock.now += 30_000;
  await next.sweep();
  expect(looks()).toBe(0);
  t.clock.now += 30_000;
  await next.sweep();
  expect(looks()).toBe(1);
  next.close();
});

test("a running desktop that can't take the flags or the look keeps what it has, says why, and the next runner tries again", async () => {
  const t = setup();
  const state = await leftByEarlierRunner(t, dev);
  t.fake.exits.set("agentes-xvnc", 1);
  t.fake.exits.set("agentes-look", 2);
  const next = new DesktopSessions(t.opts);
  next.restore();
  await next.serve([dev]);
  t.clock.now += 60_000;
  await next.sweep();
  expect(t.logs).toContain(
    "the desktop of dev keeps its earlier SendPrimary until it starts again: setting it failed (exit 1)",
  );
  expect(t.logs).toContain("the desktop of dev keeps its earlier look until it starts again: its session wasn't found");
  const saved = JSON.parse(readFileSync(state, "utf8"));
  expect([saved.look, saved.params]).toEqual([undefined, undefined]);
  // Not again from this runner.
  t.clock.now += 60_000;
  await next.sweep();
  expect(t.fake.of("agentes-xvnc")).toHaveLength(1);
  expect(t.fake.of("agentes-look").filter(live)).toHaveLength(1);
  next.close();

  // The next one tries again; one held up is stopped, and says so. It has six steps' time: its settings take seconds.
  t.fake.exits.clear();
  t.fake.hangs.add("agentes-look");
  const after = new DesktopSessions({ ...t.opts, stepMs: 30 });
  after.restore();
  await after.serve([dev]);
  t.clock.now += 60_000;
  await after.sweep();
  expect(t.fake.of("agentes-xvnc")).toHaveLength(2);
  const [, held] = t.fake.of("agentes-look").filter(live);
  expect(t.fake.kills).toContainEqual([held?.pid ?? 0, "SIGTERM"]);
  expect(t.logs).toContain(
    "the desktop of dev keeps its earlier look until it starts again: writing it was stopped after 0.18 s",
  );
  expect(after.status(dev).running).toBe(true);
  after.close();
});

test("a viewer who comes while a running desktop's flags are set holds its new look back: its dock would start over", async () => {
  const t = setup();
  await leftByEarlierRunner(t, dev);
  t.fake.hangs.add("agentes-xvnc");
  const next = new DesktopSessions(t.opts);
  next.restore();
  await next.serve([dev]);
  t.clock.now += 60_000;
  const swept = next.sweep();
  await waitFor(() => t.fake.of("agentes-xvnc").length === 1);
  const release = next.hold(dev.id);
  t.fake.of("agentes-xvnc")[0]?.exit(0);
  await swept;
  const looks = () => t.fake.of("agentes-look").filter(live).length;
  expect(looks()).toBe(0);
  release?.();
  t.clock.now += 60_000;
  await next.sweep();
  expect(looks()).toBe(1);
  next.close();
});

test("a runner running as root refreshes a running desktop only through the agent's launcher; with none, it sets nothing and says why", async () => {
  const t = setup();
  await leftByEarlierRunner(t, dev);
  const root = { ...t.fake.system, uid: 0 };
  // Desktops taken back from a home that isn't system mode's (`sudo -E`, say): the agent's user is the runner's own.
  const unlaunched = new DesktopSessions({ ...t.opts, system: root });
  unlaunched.restore();
  await unlaunched.serve([dev]);
  t.clock.now += 60_000;
  await unlaunched.sweep();
  t.clock.now += 60_000;
  await unlaunched.sweep();
  expect(t.fake.of("agentes-xvnc")).toHaveLength(0);
  expect(t.fake.of("agentes-look").filter(live)).toHaveLength(0);
  expect(t.logs.filter((l) => l.includes("runs as root"))).toEqual([
    "the desktop of dev stays as it is: the runner runs as root, and nothing on a desktop does",
  ]);
  unlaunched.close();

  // System mode: as the agent, through its launcher.
  const prefix = ["/usr/sbin/runuser", "-u", "ag-01a142cb", "--"];
  const user = async (agent: AgentScope) => ({ ...(await t.opts.user(agent)), prefix });
  const launched = new DesktopSessions({ ...t.opts, system: root, agentUsers: true, user });
  launched.restore();
  await launched.serve([dev]);
  t.clock.now += 60_000;
  await launched.sweep();
  const refreshed = [...t.fake.of("agentes-xvnc"), ...t.fake.of("agentes-look").filter(live)];
  expect(refreshed).toHaveLength(2);
  for (const p of refreshed) expect(p.argv.slice(0, prefix.length)).toEqual(prefix);
  launched.close();
});

test.if(posix)(
  "the flags' own script sets each with tigervncconfig on the desktop's display and reads it back: 1.15's off, 1.12's 0",
  async () => {
    // A tigervncconfig that notes what it was asked on which display, and answers -get with what the server says.
    const bin = tempDir("desk-bin-");
    dirs.push(bin);
    const calls = path.join(bin, "calls");
    writeFileSync(
      path.join(bin, "tigervncconfig"),
      ["#!/bin/sh", 'echo "$DISPLAY $*" >> "$CALLS"', '[ "$1" = -get ] && echo "$SAYS"', "exit 0", ""].join("\n"),
      { mode: 0o755 },
    );
    for (const says of ["off", "0", "on"]) {
      const t = setup();
      await leftByEarlierRunner(t, dev);
      const system: DesktopSystem = {
        ...t.fake.system,
        spawn(argv, opts) {
          if (!argv.includes("agentes-xvnc")) return t.fake.system.spawn(argv, opts);
          const env = { ...opts.env, PATH: `${bin}:/usr/bin:/bin`, CALLS: calls, SAYS: says };
          return { pid: 1, exited: Promise.resolve(Bun.spawnSync(argv, { env }).exitCode) };
        },
      };
      const next = new DesktopSessions({ ...t.opts, system });
      next.restore();
      await next.serve([dev]);
      await next.sweep();
      expect(readFileSync(calls, "utf8").split("\n").slice(-3)).toEqual([
        ":20 -set SendPrimary=0",
        ":20 -get SendPrimary",
        "",
      ]);
      // A server that still says on refused it, though tigervncconfig exited 0.
      expect(t.logs.at(-1)).toBe(
        says === "on"
          ? "the desktop of dev keeps its earlier SendPrimary until it starts again: setting it failed (exit 2)"
          : "the desktop of dev took SendPrimary=0 while running",
      );
      next.close();
    }
  },
);

test("running desktops take a new look one after another; one renamed takes it again, one whose home moved keeps its own", async () => {
  const t = setup();
  // With bash, the look's terminal prompt says the agent's name.
  const user = t.opts.user;
  t.opts.user = async (agent) => {
    const u = await user(agent);
    return { ...u, env: { ...u.env, SHELL: "/bin/bash" } };
  };
  await leftByEarlierRunner(t, dev);
  await leftByEarlierRunner(t, ops);
  t.fake.hangs.add("agentes-look");
  const next = new DesktopSessions(t.opts);
  next.restore();
  await next.serve([dev, ops]);
  t.clock.now += 60_000;
  const swept = next.sweep();
  const looks = () => t.fake.of("agentes-look").filter(live);
  await waitFor(() => looks().length === 1);
  await new Promise((r) => setTimeout(r, 30));
  expect(looks()).toHaveLength(1);
  looks()[0]?.exit(0);
  await waitFor(() => looks().length === 2);
  looks()[1]?.exit(0);
  await swept;
  expect(t.logs.filter((l) => l.endsWith("has this runner's look"))).toHaveLength(2);
  t.fake.hangs.clear();

  // Renamed (the server's list says so), dev's terminal prompt names it anew.
  const renamed = { ...dev, name: "Dev Two" };
  await next.serve([renamed, ops]);
  t.clock.now += 60_000;
  await next.sweep();
  const home = path.join(t.folders, "dev", ".agentes", "home");
  expect(looks()[2]?.argv).toEqual(lookCommand(home, await lookOf(t, renamed), true).argv);

  // Single-user mode moved ops's folder with its new handle (a request had it): its session still has the old HOME.
  await next.ensure({ ...ops, handle: "ops2", name: "Ops" });
  t.clock.now += 60_000;
  await next.sweep();
  expect(looks()).toHaveLength(3);
  expect(t.logs).toContain(
    "the desktop of ops2 keeps its earlier look until it starts again: its home moved while it ran",
  );
  next.close();
});

test("a desktop stays on: a day with no viewer and no use, and it still runs; a viewer is counted", async () => {
  // Each viewer that comes or goes is told (system mode: the agent's worker learns it).
  const viewers: number[] = [];
  const t = setup({ onViewers: (agentId) => viewers.push(t.desktops.status({ id: agentId }).streams) });
  await t.desktops.ensure(dev);
  const release = t.desktops.hold(dev.id);
  expect(t.desktops.status(dev).streams).toBe(1);
  release?.();
  release?.();
  expect(t.desktops.status(dev).streams).toBe(0);
  expect(viewers).toEqual([1, 0]);
  for (let hour = 0; hour < 24; hour++) {
    t.clock.now += 3_600_000;
    await t.desktops.sweep();
  }
  expect(t.desktops.status(dev).running).toBe(true);
  expect(t.fake.kills).toEqual([]);
  expect(t.fake.of("Xtigervnc")).toHaveLength(1);
  // Started by this runner, it has this runner's flags and look: nothing is set again.
  expect(t.fake.of("agentes-xvnc")).toHaveLength(0);
  expect(t.fake.of("agentes-look")).toHaveLength(1);
  t.desktops.close();
});

test("parking: short of memory, the least recently used desktop untouched for an hour goes first; never one watched, in use or just used", async () => {
  const agent = (handle: string, i: number): AgentScope => ({ id: `0000000${i}-0000-7000-8000-000000000000`, handle });
  const [a, b, watched, busy, recent, c, d, e] = ["a", "b", "watched", "busy", "recent", "c", "d", "e"].map(agent) as [
    AgentScope,
    AgentScope,
    AgentScope,
    AgentScope,
    AgentScope,
    AgentScope,
    AgentScope,
    AgentScope,
  ];
  // Each desktop takes 0.4 GiB of what this computer has; 1.5 GiB must stay free when one more starts.
  const running = () => t.fake.of("Xtigervnc").filter((p) => p.alive).length;
  const t = setup({ memAvailable: () => 3.4 * GiB - running() * 0.4 * GiB, inUse: (id) => id === busy.id });
  await t.desktops.ensure(a);
  t.clock.now += 60_000;
  for (const next of [b, watched, busy]) await t.desktops.ensure(next);
  // Watched since then: only its viewer keeps it.
  t.desktops.hold(watched.id);
  t.clock.now += 2 * PARK_AFTER_MS;
  await t.desktops.ensure(recent);
  const runs = (of: AgentScope) => t.desktops.status(of).running;

  await t.desktops.ensure(c);
  expect([a, b, c].map(runs)).toEqual([false, true, true]);
  await t.desktops.ensure(d);
  expect([b, d].map(runs)).toEqual([false, true]);
  expect(t.logs.filter((l) => l.includes("was parked"))).toHaveLength(2);
  // Nothing left to park (watched, in use, or used within the hour): refused, and nothing else stops.
  expect(await errorCode(() => t.desktops.ensure(e))).toBe("desktop_busy");
  expect([watched, busy, recent, c, d].map(runs)).toEqual([true, true, true, true, true]);
  // The agent's Chrome is about to start on its running desktop: the same room is needed.
  expect(await errorCode(() => t.desktops.ensure(recent, { chrome: true }))).toBe("desktop_busy");
  expect(runs(recent)).toBe(true);

  // An hour on, a parked desktop starts again like a first time.
  t.clock.now += PARK_AFTER_MS;
  expect(await t.desktops.ensure(a)).toMatchObject({ started: true });
  expect(runs(watched) && runs(busy)).toBe(true);
  t.desktops.close();
});

test("parking: with every display taken, the least recently used desktop untouched for an hour makes room", async () => {
  const t = setup();
  // Every display but the first two is held by programs that aren't ours.
  for (let slot = 2; slot < 50; slot++) {
    writeFileSync(path.join(t.lockDir, `.X${20 + slot}-lock`), `${String(9000 + slot).padStart(10)}\n`);
    t.fake.others.set(9000 + slot, ["/usr/lib/xorg/Xorg", `:${20 + slot}`]);
  }
  const qa: AgentScope = { id: "77aa0000-0000-7000-8000-000000000000", handle: "qa" };
  await t.desktops.ensure(dev);
  t.clock.now += 60_000;
  await t.desktops.ensure(ops);
  // Both used within the hour: no room, and both go on.
  expect(await errorCode(() => t.desktops.ensure(qa))).toBe("desktop_busy");
  t.clock.now += PARK_AFTER_MS;
  expect(await t.desktops.ensure(qa)).toMatchObject({ display: 20, started: true });
  expect([dev, ops, qa].map((a) => t.desktops.status(a).running)).toEqual([false, true, true]);
  expect(t.logs.filter((l) => l.includes("was parked"))).toHaveLength(1);
  t.desktops.close();
});

test("the agent's Chrome in use on its desktop touches it: parked an hour after that use, not as Chrome closes", async () => {
  let chromeInUse = true;
  // Short of memory while dev's desktop runs: only parking it makes room.
  const t = setup({
    memAvailable: () => (t.desktops.status(dev).running ? GiB : 4 * GiB),
    inUse: (id) => id === dev.id && chromeInUse,
  });
  await t.desktops.ensure(dev);
  // Hours of browsing on it, the sweep once a minute; then its Chrome closes.
  for (let minute = 0; minute < 180; minute++) {
    t.clock.now += 60_000;
    t.desktops.sweep();
  }
  chromeInUse = false;
  expect(await errorCode(() => t.desktops.ensure(ops))).toBe("desktop_busy");
  expect(t.desktops.status(dev).running).toBe(true);
  t.clock.now += PARK_AFTER_MS;
  expect((await t.desktops.ensure(ops)).started).toBe(true);
  expect(t.desktops.status(dev).running).toBe(false);
  t.desktops.close();
});

test("the desktops of agents this computer no longer serves stop; the others go on", async () => {
  const t = setup();
  await t.desktops.ensure(dev);
  await t.desktops.ensure(ops);
  await t.desktops.serve([ops]);
  expect([dev, ops].map((a) => t.desktops.status(a).running)).toEqual([false, true]);
  await t.desktops.stopAll();
  expect(t.desktops.status(ops).running).toBe(false);
});

test("where the memory isn't known there is always room", async () => {
  const t = setup({ memAvailable: () => null });
  for (const agent of [dev, ops]) expect((await t.desktops.ensure(agent)).started).toBe(true);
  t.desktops.close();
});

test("supervision: a desktop that ends by itself starts again, 3 times in 10 minutes at most", async () => {
  const t = setup();
  await t.desktops.ensure(dev);
  for (let restart = 1; restart <= 3; restart++) {
    t.fake.of("dbus-launch").at(-1)?.exit(0);
    await waitFor(() => t.fake.of("Xtigervnc").length === restart + 1 && t.desktops.status(dev).running);
  }
  // The X server of the crashed session went with it.
  expect(t.fake.of("Xtigervnc").filter((p) => p.alive)).toHaveLength(1);
  t.fake.of("Xtigervnc").at(-1)?.exit(1);
  await waitFor(() => t.logs.some((l) => l.includes("too often")));
  expect(t.desktops.status(dev).running).toBe(false);
  expect(t.fake.of("Xtigervnc")).toHaveLength(4);

  // Asked for again, it starts; ten minutes later the count starts over.
  await t.desktops.ensure(dev);
  t.clock.now += 10 * 60_000;
  t.fake.of("dbus-launch").at(-1)?.exit(0);
  await waitFor(() => t.fake.of("Xtigervnc").length === 6 && t.desktops.status(dev).running);
  t.desktops.close();
});

test("a desktop found gone by the sweep (taken back, so no exit event) starts again", async () => {
  const t = setup();
  const before = new DesktopSessions({ ...t.opts, system: gone(t.fake.system) });
  await before.ensure(dev);
  before.close();
  const next = new DesktopSessions(t.opts);
  next.restore();
  const session = t.fake.of("dbus-launch")[0];
  if (session) session.alive = false;
  next.sweep();
  await waitFor(() => t.fake.of("Xtigervnc").length === 2 && next.status(dev).running);
  next.close();
});

test("limits and failures: short of memory, Xvnc that doesn't start, a computer without the packages", async () => {
  let free = 4 * GiB;
  const t = setup({ memAvailable: () => free });
  await t.desktops.ensure(dev);
  free = GiB;
  expect(await errorCode(() => t.desktops.ensure(ops))).toBe("desktop_busy");
  free = 4 * GiB;
  await t.desktops.stop(dev);

  t.fake.failXvnc("(EE) Fatal server error: vncExtInit: Failed to bind socket");
  const failed = await t.desktops.ensure(ops).catch((err: Error) => err.message);
  expect(failed).toContain("Failed to bind socket");
  expect(t.desktops.status(ops).running).toBe(false);
  t.fake.failXvnc(null);
  expect((await t.desktops.ensure(ops)).started).toBe(true);
  // The failed start's log is kept beside the new one's.
  expect(readFileSync(path.join(t.home, "desktop", "9f00aa11.log.1"), "utf8")).toContain("Failed to bind socket");
  await t.desktops.stop(ops);

  const bare = new DesktopSessions({ ...t.opts, system: { ...t.fake.system, which: () => null } });
  expect(await errorCode(() => bare.ensure(dev))).toBe("desktop_unavailable");
});

test("requests: starting needs the desktop switch and an unpaused computer; stopping and asking always go", async () => {
  const t = setup();
  const ws = tempDir("desk-req-");
  dirs.push(ws);
  const tools = { claude: false, codex: false, commands: true, browser: true, desktop: false };
  const access: RunnerAccess = { folders: [], tools };
  let paused = false;
  const ctx = { workspaceReal: ws, exec: true, token: "agm_x", access: () => access, paused: () => paused };
  const scope: RequestScope = { signal: new AbortController().signal, output: () => {} };
  const run = (req: MachineRequest) => handleRequest({ ...ctx, desktops: t.desktops }, req, scope);

  expect(await errorCode(() => run({ op: "desktop.session.start", agent: dev }))).toBe("not_allowed");
  tools.desktop = true;
  expect(await run({ op: "desktop.session.start", agent: dev })).toMatchObject({ display: 20, started: true });
  expect(await errorCode(() => run({ op: "desktop.session.start" }))).toBe("bad_request");
  const none = { op: "desktop.session.start" as const, agent: ops };
  expect(await errorCode(() => handleRequest(ctx, none, scope))).toBe("desktop_unavailable");

  paused = true;
  expect(await errorCode(() => run({ op: "desktop.session.start", agent: dev }))).toBe("paused");
  tools.desktop = false;
  expect(await run({ op: "desktop.session.status", agent: dev })).toMatchObject({ running: true, streams: 0 });
  expect(await run({ op: "desktop.session.stop", agent: dev })).toEqual({ stopped: true });
  expect(await run({ op: "desktop.session.stop", agent: dev })).toEqual({ stopped: false });
  expect(await run({ op: "desktop.session.status", agent: dev })).toEqual({ running: false, streams: 0 });
});

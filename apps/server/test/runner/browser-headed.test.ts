import { afterEach, expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  type AgentScope,
  CHROME_FAILURES,
  type MachineRequest,
  type RunnerAccess,
} from "@agenteschat/adapters/machine-protocol";
import {
  BrowserManager,
  type BrowserManagerOptions,
  ChromeStartError,
  chromeEnv,
  chromeLaunchArgs,
  type OwnChrome,
  prepareProfile,
  type StreamSocket,
} from "../../runner/browser";
import { BROWSER_SOCKET, closeBrowser, serveBrowser } from "../../runner/desktop-browser";
import { RunnerError } from "../../runner/errors";
import { handleRequest, type RequestScope } from "../../runner/handlers";
import { agentWorkspace } from "../../runner/paths";
import { removeDirs, socketAnswer, tempDir, waitFor } from "./helpers";

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

const posix = process.platform !== "win32";
const FAKE = path.join(import.meta.dir, "fake-agent-browser.mjs");
const EXE = "/opt/google/chrome/chrome";
const VERSION = "156.0.8078.79";
const dev: AgentScope = { id: "01a142cb-489d-7000-87a3-efb5adb382ca", handle: "dev" };
const XAUTH = "/runner/desktop/01a142cb/Xauthority";

interface FakeChrome {
  args: string[];
  env: Record<string, string> | undefined;
  killed: boolean;
  /** It exits by itself (the person closed it, it crashed). */
  quit: () => void;
}

/** The agent's desktop as the browser sees it: `log` keeps the order of its starts and Chrome's. */
function fakeDesktops(log: string[]) {
  const d = { viewers: 0, fails: null as string | null };
  const desktops: NonNullable<BrowserManagerOptions["desktops"]> = {
    async ensure(agent) {
      log.push(`desktop ${agent.handle}`);
      if (d.fails) throw new RunnerError("desktop_busy", d.fails);
      return { display: 21, width: 1280, height: 900, startedAt: new Date(0).toISOString(), started: true };
    },
    session: () => ({
      display: 21,
      socket: "/runner/desktop/01a142cb/vnc.sock",
      xauthority: XAUTH,
      home: "/ws/dev-01a142cb/.agentes/home",
      passwords: { full: "Fullpw23", view: "Viewpw34" },
    }),
    status: () => ({ running: true, streams: d.viewers }),
  };
  return Object.assign(d, { desktops });
}

function setup(over: Partial<BrowserManagerOptions> = {}) {
  const ws = tempDir();
  const home = tempDir("runner-home-");
  dirs.push(ws, home);
  process.env.FAKE_AB_LOG = path.join(home, "ab.log");
  process.env.FAKE_AB_STATE = path.join(home, "ab-state.json");
  const log: string[] = [];
  /** Every line the runner logged. */
  const lines: string[] = [];
  const chromes: FakeChrome[] = [];
  const desk = fakeDesktops(log);
  /**
   * Headed starts still to fail, as a Chrome does when its display goes away under it; and whether every start
   * fails as one missing a library does.
   */
  const fails = { headed: 0, libraries: false };
  let clock = 1_000_000;
  const manager = new BrowserManager({
    home,
    log: (line) => {
      lines.push(line);
      if (line.includes("didn't start")) log.push(line);
    },
    send: () => true,
    secret: async () => null,
    command: [process.execPath, FAKE],
    chrome: () => EXE,
    isOurChrome: async () => false,
    desktops: desk.desktops,
    now: () => clock,
    idleMs: 60_000,
    // A started Chrome lists its window's page at once.
    fetch: fakeDevTools().fetchFn,
    windowDrawMs: 0,
    async startChrome(_exe, args, _profile, env): Promise<OwnChrome> {
      if (fails.libraries) {
        log.push("chrome failed");
        throw new ChromeStartError(
          "This computer is missing system libraries Chrome needs (libnspr4.so). Install them on it, then try again.",
          `missing libnspr4.so: ${EXE}: error while loading shared libraries: libnspr4.so`,
          ["libnspr4.so"],
        );
      }
      if (fails.headed > 0 && !args.includes("--headless=new")) {
        fails.headed--;
        log.push("chrome failed");
        throw new Error("Chrome closed while starting");
      }
      const c: FakeChrome = { args, env, killed: false, quit: () => {} };
      chromes.push(c);
      log.push("chrome");
      const exited = new Promise<void>((resolve) => {
        c.quit = resolve;
      });
      return {
        pid: 40_000 + chromes.length,
        port: 9300 + chromes.length,
        exited,
        kill: () => {
          c.killed = true;
          c.quit();
        },
      };
    },
    connectStream: () => {
      const socket: StreamSocket = {
        send() {},
        close() {
          socket.onclose?.();
        },
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
      };
      queueMicrotask(() => socket.onopen?.());
      return socket;
    },
    ...over,
  });
  const act = async (command: string, args: string[], desktop: boolean) =>
    manager.act(dev, await agentWorkspace(ws, dev), { op: "browser.act", command, args, timeoutSeconds: 30, desktop });
  const pids = () => JSON.parse(readFileSync(path.join(home, "browser", "chromes.json"), "utf8"));
  const tick = (ms: number) => {
    clock += ms;
  };
  return { ws, home, manager, log, lines, chromes, desk, fails, act, pids, tick };
}

const last = (t: { chromes: FakeChrome[] }) => t.chromes.at(-1) as FakeChrome;
const headed = (c: FakeChrome) => !c.args.includes("--headless=new");

test("headed: maximized on the agent's display, no automation bars, the debugging port still Chrome's pick", () => {
  const args = chromeLaunchArgs(VERSION, "/p", "linux", null, true);
  for (const flag of ["--start-maximized", "--test-type", "--ozone-platform=x11", "--remote-debugging-port=0"]) {
    expect(args).toContain(flag);
  }
  expect(args).toContain("--disable-blink-features=AutomationControlled");
  // Pages hold still (an animated one would keep the computer's cores busy whether anyone watches or not), and the
  // chip asking to sign in to Chrome itself stays off (Chrome 147 at least to 155; later ones read the profile's
  // switch).
  expect(args).toContain("--force-prefers-reduced-motion");
  expect(args).toContain("--disable-features=SigninPromoOnAvatarPill");
  expect(args).not.toContain("--headless=new");
  expect(args.some((a) => a.startsWith("--window-size"))).toBe(false);
  // Its windows' class is the dock's Browser's, so the dock shows them on Browser.
  expect(args).toContain("--class=agentes-browser");
  expect(args.at(-1)).toBe("about:blank");
  expect(chromeLaunchArgs(VERSION, "/p", "linux", null, true, "https://shop.example/cart").at(-1)).toBe(
    "https://shop.example/cart",
  );
  // The runner's own Wayland display and session bus stay out: nothing it opens reaches the person's screen.
  expect(
    chromeEnv(
      { display: 21, xauthority: XAUTH },
      { PATH: "/usr/bin", HOME: "/home/r", WAYLAND_DISPLAY: "wayland-0", DBUS_SESSION_BUS_ADDRESS: "unix:path=/b" },
    ),
  ).toEqual({ PATH: "/usr/bin", HOME: "/home/r", DISPLAY: ":21", XAUTHORITY: XAUTH });
});

test("headless as before: its own window size, none of the headed flags", () => {
  const args = chromeLaunchArgs(VERSION, "/p", "linux", null);
  expect(args).toContain("--headless=new");
  expect(args).toContain("--window-size=1280,800");
  expect(args).toContain("--screen-info={1280x800}");
  expect(args.some((a) => a.startsWith("--test-type"))).toBe(false);
  for (const flag of ["--start-maximized", "--ozone-platform=x11", "--class=agentes-browser"]) {
    expect(args).not.toContain(flag);
  }
  expect(args.at(-1)).toBe("about:blank");
});

/** Chrome's password manager, its sign-in with saved passwords, its leak check and its autofill: off (ADR 0144). */
const NO_SAVED_LOGINS = {
  credentials_enable_service: false,
  credentials_enable_autosignin: false,
  profile: { password_manager_enabled: false, password_manager_leak_detection: false },
  autofill: { profile_enabled: false, credit_card_enabled: false },
};

test("the profile: Chrome's own frame, whenever its window manager came up, no sign-in to Chrome itself and no footer under the start page; its other settings stay", () => {
  const profile = tempDir("profile-");
  dirs.push(profile);
  const prefs = path.join(profile, "Default", "Preferences");
  prepareProfile(profile);
  expect(JSON.parse(readFileSync(prefs, "utf8"))).toEqual({
    browser: { custom_chrome_frame: true },
    signin: { allowed_on_next_startup: false },
    NewTabPage: { FooterVisible: false },
    ...NO_SAVED_LOGINS,
  });
  // A profile Chrome already ran with its sign-in allowed: Chrome sets `signin.allowed` from the next-startup switch
  // as it starts.
  writeFileSync(
    prefs,
    JSON.stringify({
      browser: { window_placement: { maximized: true } },
      signin: { allowed: true, allowed_on_next_startup: true },
      NewTabPage: { FooterVisible: true, PrevNavigationTime: "1" },
      intl: { a: 1 },
    }),
  );
  prepareProfile(profile);
  expect(JSON.parse(readFileSync(prefs, "utf8"))).toEqual({
    browser: { window_placement: { maximized: true }, custom_chrome_frame: true },
    signin: { allowed: true, allowed_on_next_startup: false },
    NewTabPage: { FooterVisible: false, PrevNavigationTime: "1" },
    intl: { a: 1 },
    ...NO_SAVED_LOGINS,
  });
  // A profile whose password manager was on (Chrome's default) has it off, its other settings kept.
  writeFileSync(
    prefs,
    JSON.stringify({
      credentials_enable_service: true,
      profile: { password_manager_enabled: true, name: "Person 1", exit_type: "Normal" },
      autofill: { profile_enabled: true, last_version_deduped: 150 },
    }),
  );
  prepareProfile(profile);
  const saved = JSON.parse(readFileSync(prefs, "utf8"));
  expect(saved.credentials_enable_service).toBe(false);
  expect(saved.credentials_enable_autosignin).toBe(false);
  expect(saved.profile).toEqual({
    name: "Person 1",
    exit_type: "Normal",
    password_manager_enabled: false,
    password_manager_leak_detection: false,
  });
  expect(saved.autofill).toEqual({ last_version_deduped: 150, profile_enabled: false, credit_card_enabled: false });
  // The old start page extension no longer answers new tabs (Google Chrome doesn't load it); others' entries stay.
  const old = { entry: "chrome-extension://mbgkclemiokgppkieijlfaoehgdjlhbl/start.html", active: true };
  const other = { entry: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/tab.html", active: false };
  writeFileSync(prefs, JSON.stringify({ extensions: { chrome_url_overrides: { newtab: [old, other] }, alerts: {} } }));
  prepareProfile(profile);
  expect(JSON.parse(readFileSync(prefs, "utf8")).extensions).toEqual({
    chrome_url_overrides: { newtab: [other] },
    alerts: {},
  });
  // Nothing to change: the file isn't written again.
  const written = statSync(prefs).mtimeMs;
  prepareProfile(profile);
  expect(statSync(prefs).mtimeMs).toBe(written);
  // Not JSON: Chrome's own business.
  writeFileSync(prefs, "{broken");
  prepareProfile(profile);
  expect(readFileSync(prefs, "utf8")).toBe("{broken");
});

test.if(posix)(
  "on its desktop: the desktop starts first, then Chrome on its display; chromes.json says which",
  async () => {
    const t = setup();
    expect(await t.act("open", ["https://shop.example/"], true)).toMatchObject({ success: true });
    expect(t.log).toEqual(["desktop dev", "chrome"]);
    expect(headed(last(t))).toBe(true);
    expect(last(t).env).toMatchObject({ DISPLAY: ":21", XAUTHORITY: XAUTH });
    const profile = path.join(await agentWorkspace(t.ws, dev), ".agentes", "browser");
    expect(t.pids()).toEqual([{ pid: 40_001, profile, display: 21 }]);
    expect(readFileSync(path.join(profile, "Default", "Preferences"), "utf8")).toContain('"custom_chrome_frame":true');
    // The same Chrome for the next commands: no new desktop start, no new Chrome.
    await t.act("click", ["@e1"], true);
    expect(t.log).toEqual(["desktop dev", "chrome"]);

    // Without the desktop: headless as before, with the runner's own environment.
    const other = setup();
    await other.act("open", ["https://shop.example/"], false);
    expect(other.log).toEqual(["chrome"]);
    expect(headed(last(other))).toBe(false);
    expect(last(other).env).toBeUndefined();
    expect(other.pids()[0].display).toBeUndefined();
    const otherProfile = path.join(await agentWorkspace(other.ws, dev), ".agentes", "browser");
    // Headless too: no sign-in to Chrome itself (Google Chrome would offer it to an agent signed in to google.com).
    expect(readFileSync(path.join(otherProfile, "Default", "Preferences"), "utf8")).toContain(
      '"allowed_on_next_startup":false',
    );
  },
);

test.if(posix)("a Chrome in the other mode starts again in this one, on the same profile and page", async () => {
  const t = setup();
  await t.act("open", ["https://shop.example/cart"], false);
  // Reads never move it.
  await t.act("snapshot", [], true);
  expect(t.chromes).toHaveLength(1);
  // The next command that may start Chrome does.
  await t.act("click", ["@e1"], true);
  expect(t.chromes).toHaveLength(2);
  expect(t.chromes[0]?.killed).toBe(true);
  expect(headed(last(t))).toBe(true);
  expect(last(t).args.at(-1)).toBe("https://shop.example/cart");
  const profileOf = (c?: FakeChrome) => c?.args.find((a) => a.startsWith("--user-data-dir="));
  expect(profileOf(last(t))).toBe(profileOf(t.chromes[0]) ?? "no profile");
  expect(t.pids()).toEqual([expect.objectContaining({ pid: 40_002, display: 21 })]);
  // And back off its desktop.
  await t.act("click", ["@e1"], false);
  expect(t.chromes).toHaveLength(3);
  expect(headed(last(t))).toBe(false);
  expect(last(t).env).toBeUndefined();
});

test.if(posix)("never moved while someone watches it or a person's turn is open", async () => {
  const t = setup();
  await t.act("open", ["https://shop.example/"], true);
  // Its live view on the browser card.
  await t.manager.streamStart(dev, "watch");
  await t.act("click", ["@e1"], false);
  expect(t.chromes).toHaveLength(1);
  await t.manager.streamStop(dev);
  // A person's turn.
  t.manager.setHandoff(dev.id, { status: "active", controller: "Ana" });
  await t.act("click", ["@e1"], false);
  expect(t.chromes).toHaveLength(1);
  t.manager.setHandoff(dev.id, null);
  // Someone on its desktop, where it is.
  t.desk.viewers = 1;
  await t.act("click", ["@e1"], false);
  expect(t.chromes).toHaveLength(1);
  t.desk.viewers = 0;
  await t.act("click", ["@e1"], false);
  expect(t.chromes).toHaveLength(2);
  // A headless one comes onto a desktop someone watches: nobody watched the browser itself.
  t.desk.viewers = 1;
  await t.act("click", ["@e1"], true);
  expect(t.chromes).toHaveLength(3);
  expect(headed(last(t))).toBe(true);
});

test.if(posix)(
  "a desktop that can't start leaves Chrome headless, and isn't tried again at every command",
  async () => {
    const t = setup();
    t.desk.fails = "This computer already runs as many desktops as its memory allows";
    expect(await t.act("open", ["https://shop.example/"], true)).toMatchObject({ success: true });
    expect(headed(last(t))).toBe(false);
    await t.act("click", ["@e1"], true);
    expect(t.log).toEqual(["desktop dev", "chrome"]);
    t.desk.fails = null;
    t.tick(5 * 60_000);
    await t.act("click", ["@e1"], true);
    expect(t.log).toEqual(["desktop dev", "chrome", "desktop dev", "chrome"]);
    expect(headed(last(t))).toBe(true);
  },
);

test.if(posix)(
  "a Chrome whose desktop goes away while it starts there runs headless, the desktop tried later",
  async () => {
    const t = setup();
    t.fails.headed = 1;
    expect(await t.act("open", ["https://shop.example/"], true)).toMatchObject({ success: true });
    expect(t.log).toEqual(["desktop dev", "chrome failed", "chrome"]);
    expect(headed(last(t))).toBe(false);
    expect(t.pids()).toEqual([expect.objectContaining({ pid: 40_001 })]);
    expect(t.pids()[0].display).toBeUndefined();
    await t.act("click", ["@e1"], true);
    expect(t.chromes).toHaveLength(1);
    t.tick(5 * 60_000);
    await t.act("click", ["@e1"], true);
    expect(t.log).toEqual(["desktop dev", "chrome failed", "chrome", "desktop dev", "chrome"]);
    expect(headed(last(t))).toBe(true);
  },
);

test.if(posix)(
  "a Chrome missing libraries says so, isn't tried headless, and its desktop isn't blamed for it",
  async () => {
    const t = setup();
    t.fails.libraries = true;
    const failed = await t.act("open", ["https://shop.example/"], true).then(
      () => null,
      (e: unknown) => e as RunnerError,
    );
    expect(failed?.code).toBe("browser_unavailable");
    expect(failed?.message).toBe(
      `${CHROME_FAILURES.start} This computer is missing system libraries Chrome needs (libnspr4.so). Install them on it, then try again.`,
    );
    expect(t.log).toEqual([
      "desktop dev",
      "chrome failed",
      `the browser of dev didn't start: This computer is missing system libraries Chrome needs (libnspr4.so). Install them on it, then try again. (missing libnspr4.so: ${EXE}: error while loading shared libraries: libnspr4.so)`,
    ]);
    // Once they're installed, the next command starts it on its desktop.
    t.fails.libraries = false;
    expect(await t.act("open", ["https://shop.example/"], true)).toMatchObject({ success: true });
    expect(headed(last(t))).toBe(true);
  },
);

test.if(posix)("in use on its desktop keeps the desktop; its desktop's viewers keep it", async () => {
  const t = setup();
  await t.act("open", ["https://a.example/"], false);
  // Headless: nothing to keep on the desktop.
  expect(t.manager.onDesktopInUse(dev.id)).toBe(false);
  await t.act("open", ["https://a.example/"], true);
  expect(t.manager.onDesktopInUse(dev.id)).toBe(true);
  t.tick(61_000);
  expect(t.manager.onDesktopInUse(dev.id)).toBe(false);
  // Its live view on the browser card keeps it in use however long nobody commands it.
  await t.manager.streamStart(dev, "watch");
  expect(t.manager.onDesktopInUse(dev.id)).toBe(true);
  await t.manager.streamStop(dev);

  // A person working in it through the desktop sends no command: the desktop's viewers count as use.
  t.desk.viewers = 1;
  await t.manager.sweep();
  expect(last(t).killed).toBe(false);
  t.desk.viewers = 0;
  t.tick(59_000);
  await t.manager.sweep();
  expect(last(t).killed).toBe(false);
  t.tick(2_000);
  await t.manager.sweep();
  expect(last(t).killed).toBe(true);
});

test.if(posix)("the request's desktop counts only while the machine's desktop switch is on", async () => {
  const t = setup();
  let access: RunnerAccess = {
    folders: [],
    tools: { claude: false, codex: false, commands: true, browser: true, desktop: false },
  };
  const scope: RequestScope = { signal: new AbortController().signal, output: () => {} };
  const ctx = { workspaceReal: t.ws, exec: true, token: "agm_x", access: () => access, browser: t.manager };
  const open: MachineRequest = {
    agent: dev,
    op: "browser.act",
    command: "open",
    args: ["https://a.example"],
    timeoutSeconds: 5,
    desktop: true,
  };
  await handleRequest(ctx, open, scope);
  expect(t.log).toEqual(["chrome"]);
  access = { ...access, tools: { ...access.tools, desktop: true } };
  await handleRequest(ctx, open, scope);
  expect(t.log).toEqual(["chrome", "desktop dev", "chrome"]);
  expect(headed(last(t))).toBe(true);
  // A batch too.
  access = { ...access, tools: { ...access.tools, desktop: false } };
  await handleRequest(
    ctx,
    {
      agent: dev,
      op: "browser.batch",
      commands: [{ command: "click", args: ["@e1"], timeoutSeconds: 5 }],
      desktop: true,
    },
    scope,
  );
  expect(t.chromes).toHaveLength(3);
  expect(headed(last(t))).toBe(false);
});

/** Chrome's own debugging endpoint, as `show` asks it to bring a window to the front; `stalled`, it never answers. */
function fakeDevTools() {
  const d = {
    urls: [] as string[],
    targets: [
      { id: "SW1", type: "service_worker", url: "https://shop.example/sw.js" },
      { id: "P7", type: "page", url: "https://shop.example/cart" },
      { id: "P2", type: "page", url: "https://shop.example/" },
    ],
    stalled: false,
  };
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    d.urls.push(`${init?.method ?? "GET"} ${url}`);
    if (d.stalled) throw new DOMException("The operation timed out.", "TimeoutError");
    if (url.endsWith("/json/list")) return new Response(JSON.stringify(d.targets));
    if (url.includes("/json/new?")) d.targets = [...d.targets, { id: "N1", type: "page", url: "about:blank" }];
    return new Response("Target activated");
  }) as typeof fetch;
  return Object.assign(d, { fetchFn });
}

test.if(posix)(
  "Browser on its desktop: the agent's own Chrome there, started, moved even while watched or a turn is open, or in front",
  async () => {
    const devtools = fakeDevTools();
    const t = setup({ fetch: devtools.fetchFn });
    const folder = await agentWorkspace(t.ws, dev);
    let installs = 0;
    const installing = () => void installs++;

    // Not running: started on the desktop, with the agent's profile; nothing installs.
    // Answered once Chrome lists its window's page.
    await t.manager.show(dev, folder, installing);
    expect(t.log).toEqual(["desktop dev", "chrome"]);
    expect(headed(last(t))).toBe(true);
    expect(last(t).args).toContain(`--user-data-dir=${path.join(folder, ".agentes", "browser")}`);
    expect(installs).toBe(0);
    expect(devtools.urls).toEqual(["GET http://127.0.0.1:9301/json/list"]);
    devtools.urls = [];

    // Already there: no other Chrome, its window to the front on its most recent page.
    await t.manager.show(dev, folder, installing);
    expect(t.chromes).toHaveLength(1);
    expect(devtools.urls).toEqual([
      "GET http://127.0.0.1:9301/json/list",
      "GET http://127.0.0.1:9301/json/activate/P7",
    ]);
    // Its last tab closed and Chrome still up: the offline start page, in a window of its own.
    devtools.targets = devtools.targets.filter((x) => x.type !== "page");
    devtools.urls = [];
    await t.manager.show(dev, folder, installing);
    expect(t.chromes).toHaveLength(1);
    expect(devtools.urls).toEqual([
      "GET http://127.0.0.1:9301/json/list",
      "PUT http://127.0.0.1:9301/json/new?chrome://newtab/",
    ]);

    // Headless while a person's turn is open and its live view is watched: a click from the desktop moves it there,
    // on the page it showed.
    await t.act("open", ["https://shop.example/cart"], false);
    expect(headed(last(t))).toBe(false);
    t.manager.setHandoff(dev.id, { status: "active", controller: "Ana" });
    await t.manager.streamStart(dev, "watch");
    await t.manager.show(dev, folder, installing);
    expect(t.chromes).toHaveLength(3);
    expect(headed(last(t))).toBe(true);
    expect(last(t).args.at(-1)).toBe("https://shop.example/cart");
    expect(t.chromes.filter((c) => !c.killed)).toHaveLength(1);
  },
);

test.if(posix)(
  "Browser on its desktop: a desktop that failed a moment ago is tried again; one that can't take Chrome says why",
  async () => {
    const t = setup();
    const folder = await agentWorkspace(t.ws, dev);
    t.desk.fails = "This computer has no room for another desktop";
    await t.act("open", ["https://shop.example/"], true);
    expect(headed(last(t))).toBe(false);
    // The agent's own commands wait 5 minutes before trying its desktop again; a person on that desktop doesn't.
    t.desk.fails = null;
    await t.manager.show(dev, folder, () => {});
    expect(t.log).toEqual(["desktop dev", "chrome", "desktop dev", "chrome"]);
    expect(headed(last(t))).toBe(true);

    const failure = (p: Promise<void>) =>
      p.then(
        () => null,
        (err: unknown) => [(err as RunnerError).code, (err as RunnerError).message],
      );
    // No room for Chrome on its desktop: the click fails with the desktop's own reason, and starts no Chrome
    // headless instead, nor stops the one the agent runs.
    const other = setup();
    const otherFolder = await agentWorkspace(other.ws, dev);
    other.desk.fails = "This computer is short of memory for the agent's browser on its desktop";
    expect(await failure(other.manager.show(dev, otherFolder, () => {}))).toEqual([
      "desktop_busy",
      "This computer is short of memory for the agent's browser on its desktop",
    ]);
    expect(other.chromes).toHaveLength(0);
    await other.act("open", ["https://shop.example/"], false);
    expect(await failure(other.manager.show(dev, otherFolder, () => {}))).toEqual([
      "desktop_busy",
      "This computer is short of memory for the agent's browser on its desktop",
    ]);
    expect(other.chromes).toHaveLength(1);
    expect(other.chromes[0]?.killed).toBe(false);
    // Chrome itself fails to start there: that is the answer, not a headless one.
    const third = setup();
    third.fails.headed = 1;
    expect(await failure(third.manager.show(dev, await agentWorkspace(third.ws, dev), () => {}))).toEqual([
      "browser_unavailable",
      CHROME_FAILURES.start,
    ]);
    expect(third.chromes).toHaveLength(0);
  },
);

test.if(posix)(
  "Browser on its desktop without Google Chrome: the click says so plainly, and nothing installs",
  async () => {
    const t = setup({ chrome: () => null });
    const folder = await agentWorkspace(t.ws, dev);
    let installing = 0;
    const err = await t.manager
      .show(dev, folder, () => void installing++)
      .then(
        () => null,
        (e: unknown) => e as RunnerError,
      );
    expect([err?.code, err?.message]).toEqual(["browser_unavailable", CHROME_FAILURES.missing]);
    expect(installing).toBe(0);
    expect(t.chromes).toHaveLength(0);
  },
);

test.if(posix)(
  "Browser on its desktop: answered once Chrome's window shows (its page listed, then drawn); each click's outcome in the log",
  async () => {
    const devtools = fakeDevTools();
    // Still starting: Chrome lists no page until its first window is up.
    devtools.targets = [];
    const t = setup({ fetch: devtools.fetchFn, windowDrawMs: 150 });
    const folder = await agentWorkspace(t.ws, dev);
    let answered = false;
    const shown = t.manager
      .show(dev, folder, () => {})
      .then(() => {
        answered = true;
      });
    await waitFor(() => devtools.urls.length >= 2);
    expect(t.chromes).toHaveLength(1);
    expect(answered).toBe(false);
    devtools.targets = [{ id: "P1", type: "page", url: "about:blank" }];
    const listedAt = Date.now();
    await shown;
    // Drawn before the launcher's note closes under it.
    expect(Date.now() - listedAt).toBeGreaterThanOrEqual(140);
    const outcomes = () => t.lines.filter((l) => l.startsWith("Browser on the desktop"));
    expect(outcomes()).toEqual(["Browser on the desktop of dev: opened in 0.0 s"]);
    // Already there (a click from the apps menu: docklike handles a plain one on Browser itself): to the front at
    // once, without waiting for a window.
    devtools.urls = [];
    await t.manager.show(dev, folder, () => {});
    expect(devtools.urls).toEqual([
      "GET http://127.0.0.1:9301/json/list",
      "GET http://127.0.0.1:9301/json/activate/P1",
    ]);
    expect(outcomes()).toEqual([
      "Browser on the desktop of dev: opened in 0.0 s",
      "Browser on the desktop of dev: already open: brought to the front",
    ]);
    // Chrome's endpoint doesn't answer: Chrome stays behind, and the log doesn't say it came to the front.
    devtools.stalled = true;
    await t.manager.show(dev, folder, () => {});
    expect(outcomes().at(-1)).toBe("Browser on the desktop of dev: already open; it didn't come to the front");
    devtools.stalled = false;
    // Closed by the person: the next click starts it again, and waits for its window again.
    last(t).quit();
    await waitFor(() => t.manager.chromePid(dev.id) === null);
    await t.manager.show(dev, folder, () => {});
    expect(t.chromes).toHaveLength(2);
    expect(outcomes().at(-1)).toBe("Browser on the desktop of dev: opened in 0.0 s");
  },
);

test.if(posix)(
  "Browser on its desktop: a Chrome whose window never shows is stopped and the click fails; one that closes meanwhile fails too",
  async () => {
    const failure = (p: Promise<void>) =>
      p.then(
        () => null,
        (err: unknown) => [(err as RunnerError).code, (err as RunnerError).message],
      );
    const devtools = fakeDevTools();
    devtools.targets = [];
    const t = setup({ fetch: devtools.fetchFn, windowMs: 300 });
    const folder = await agentWorkspace(t.ws, dev);
    expect(await failure(t.manager.show(dev, folder, () => {}))).toEqual([
      "internal",
      "Chrome's window didn't show in time",
    ]);
    expect(last(t).killed).toBe(true);
    expect(t.manager.chromePid(dev.id)).toBeNull();
    // The caller logs a failure with its reason: no outcome of the runner's own.
    expect(t.lines.filter((l) => l.startsWith("Browser on the desktop"))).toEqual([]);

    const other = setup({ fetch: devtools.fetchFn });
    const shown = failure(other.manager.show(dev, await agentWorkspace(other.ws, dev), () => {}));
    await waitFor(() => other.chromes.length === 1);
    last(other).quit();
    expect(await shown).toEqual(["internal", "Chrome closed before its window showed"]);
    expect(last(other).killed).toBe(false);
  },
);

test.if(posix)(
  "Browser on its desktop: a second click while Chrome's window is still coming is told busy and starts nothing",
  async () => {
    const devtools = fakeDevTools();
    devtools.targets = [];
    const t = setup({ fetch: devtools.fetchFn });
    const folder = await agentWorkspace(t.ws, dev);
    const dir = tempDir("dbs-");
    dirs.push(dir);
    const socket = path.join(dir, BROWSER_SOCKET);
    const server = await serveBrowser(socket, (installing) => t.manager.show(dev, folder, installing));
    try {
      const first = socketAnswer(socket, "open\n");
      await waitFor(() => devtools.urls.length >= 1);
      // Chrome is up (its port open), its window not yet: the first click isn't answered.
      expect(await socketAnswer(socket, "open\n")).toBe("busy\n");
      devtools.targets = [{ id: "P1", type: "page", url: "about:blank" }];
      expect(await first).toBe("ok\n");
      expect(t.chromes).toHaveLength(1);
      expect(devtools.urls.every((u) => u.endsWith("/json/list"))).toBe(true);
    } finally {
      closeBrowser(server, socket);
    }
  },
);

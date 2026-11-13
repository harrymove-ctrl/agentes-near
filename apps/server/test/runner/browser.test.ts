import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import {
  AGENT_BROWSER_VERSION,
  agentBrowserUrl,
  BROWSER_LIMITS,
  BROWSER_PROTOCOL,
  browserSetupOf,
  CHROME_FAILURES,
  CHROMIUM_LINUX,
  chromeFailureKind,
  decodeBrowserFrame,
  MACHINE_PROTOCOL_VERSION,
  type MachineRequest,
  parseRunnerFrame,
  parseServerFrame,
  type RunnerAccess,
  type RunnerFrame,
  usesChromium,
} from "@agenteschat/adapters/machine-protocol";
import { sealSecret, secretAad, vaultAad } from "@agenteschat/adapters/secret-box";
import { browserErrorText, formatPlanReport, runPlan } from "@agenteschat/engine";
import { type BrowserLink, type BrowserReply, browserSurface } from "../../../../packages/engine/src/browser/surface";
import { reduceAccess, setTool, TOOL_NAMES, widens } from "../../runner/access";
import {
  agentBrowserTarget,
  type BrowserAnswer,
  BrowserManager,
  type BrowserManagerOptions,
  browserSetupText,
  CHROME_ARGS,
  ChromeStartError,
  captureMarks,
  captureTime,
  chromeCandidates,
  chromeLaunchArgs,
  chromeName,
  chromeUserAgent,
  chromeVersion,
  confinedChrome,
  crashPage,
  DRAG_GAP_MAX_MS,
  DRAG_LAG_MAX_MS,
  defaultMaxSessions,
  domainAllowed,
  dragDelay,
  findChrome,
  type InputState,
  isWebPage,
  jpegSize,
  launchChrome,
  NAME_CONTROLS,
  type OwnChrome,
  readableDisplay,
  relayCommands,
  type StreamSocket,
  selectFieldScript,
} from "../../runner/browser";
import { BrowserViews } from "../../runner/browser-views";
import { handleRequest, type RequestScope } from "../../runner/handlers";
import { agentWorkspace } from "../../runner/paths";
import { handleSecret, secretValue } from "../../runner/secrets";
import { FILL_MARK_ATTR, GET_BLOCKED, runnerVault, UNGUARDED } from "../../runner/vault";
import { errorCode, removeDirs, tempDir, waitFor } from "./helpers";

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

const posix = process.platform !== "win32";
const FAKE = path.join(import.meta.dir, "fake-agent-browser.mjs");
/** The computer's Google Chrome in these tests, and the version on disk. */
const CHROME_EXE = "/opt/google/chrome/chrome";
const CHROME_VERSION = "156.0.8078.79";
const dev = { id: "01a142cb-489d-7000-87a3-efb5adb382ca", handle: "dev" };
const ops = { id: "9f00aa11-0000-7000-8000-000000000000", handle: "ops" };

interface Logged {
  args: string[];
  stdin: string;
  cwd: string;
}

/**
 * A Chrome the fake "starts": records its command line, answers on a port, and quits when killed or when it closes
 * itself (`close`, what its DevTools' `Browser.close` does). What it finds in
 * its profile as it starts follows Chrome's own rules, as measured on Chrome for Testing 155: the cookies of the
 * sites' sessions (`session`) stay only with `--restore-last-session`, and with it the tabs it saved come back
 * beside the page it starts on. The profile's `Default/cookies.json` and `Default/Sessions/tabs.json` stand for
 * what Chrome keeps there.
 */
interface FakeChrome {
  exe: string;
  args: string[];
  profile: string;
  port: number;
  /** Signaled while it ran. */
  killed: boolean;
  /** It closed itself. */
  closed: boolean;
  close: () => void;
  /** The cookies it started with, by name. */
  cookies: string[];
  /** The tabs it opened as it started. */
  tabs: string[];
}

function chromeStartsWith(profile: string, args: string[]) {
  const restore = args.includes("--restore-last-session");
  const jar = path.join(profile, "Default", "cookies.json");
  const all = existsSync(jar) ? (JSON.parse(readFileSync(jar, "utf8")) as { name: string; session?: boolean }[]) : [];
  const kept = restore ? all : all.filter((c) => !c.session);
  if (existsSync(jar)) writeFileSync(jar, JSON.stringify(kept));
  const saved = path.join(profile, "Default", "Sessions", "tabs.json");
  const restored = restore && existsSync(saved) ? (JSON.parse(readFileSync(saved, "utf8")) as string[]) : [];
  return { cookies: kept.map((c) => c.name), tabs: [...restored, args.at(-1) ?? ""] };
}

function fakeChromes() {
  const started: FakeChrome[] = [];
  const start = async (exe: string, args: string[], profile: string): Promise<OwnChrome> => {
    let quit = () => {};
    let gone = false;
    const exited = new Promise<void>((resolve) => {
      quit = () => {
        gone = true;
        resolve();
      };
    });
    const c: FakeChrome = {
      exe,
      args,
      profile,
      port: 9300 + started.length,
      killed: false,
      closed: false,
      close: () => {
        c.closed = true;
        quit();
      },
      ...chromeStartsWith(profile, args),
    };
    started.push(c);
    return {
      pid: 40_000 + started.length,
      port: c.port,
      // As `launchChrome`'s: a Chrome that is gone isn't signaled.
      kill: () => {
        if (gone) return;
        c.killed = true;
        quit();
      },
      exited,
    };
  };
  return { started, start };
}

function setup(over: Partial<BrowserManagerOptions> = {}, secrets: Record<string, string> = {}) {
  const ws = tempDir();
  const home = tempDir("runner-home-");
  dirs.push(ws, home);
  const log = path.join(home, "ab.log");
  const stateFile = path.join(home, "ab-state.json");
  process.env.FAKE_AB_LOG = log;
  process.env.FAKE_AB_STATE = stateFile;
  const frames: RunnerFrame[] = [];
  const sockets: FakeSocket[] = [];
  const chromes = fakeChromes();
  const manager = new BrowserManager({
    home,
    log: () => {},
    send: (f) => {
      frames.push(f);
      return true;
    },
    secret: async (_agent, name) => (name in secrets ? { value: secrets[name] as string, site: null } : null),
    command: [process.execPath, FAKE],
    chrome: () => CHROME_EXE,
    chromeVersion: () => CHROME_VERSION,
    userHome: home,
    startChrome: chromes.start,
    isOurChrome: async () => false,
    connectStream: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      queueMicrotask(() => s.onopen?.());
      return s;
    },
    ...over,
  });
  const folder = async (agent = dev) => agentWorkspace(ws, agent);
  const act = async (
    command: string,
    args: string[] = [],
    extra: { allowedDomains?: string[]; agent?: typeof dev } = {},
  ) =>
    manager.act(extra.agent ?? dev, await folder(extra.agent), {
      op: "browser.act",
      command,
      args,
      timeoutSeconds: 30,
      ...(extra.allowedDomains ? { allowedDomains: extra.allowedDomains } : {}),
    });
  // The fake appends one line per call: a line still being written (no newline yet) is left for the next read.
  const logged = (): Logged[] =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .split("\n")
          .slice(0, -1)
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Logged)
      : [];
  const page = (patch: Record<string, unknown>) => {
    const cur = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {};
    writeFileSync(stateFile, JSON.stringify({ ...cur, ...patch }));
  };
  return { ws, home, manager, frames, sockets, folder, act, logged, page, chromes: chromes.started };
}

class FakeSocket implements StreamSocket {
  sent: Record<string, unknown>[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
  push(o: unknown) {
    this.onmessage?.({ data: JSON.stringify(o) });
  }
}

// ── Pure parts ───────────────────────────────────────────────────────────────

test("the runner speaks the browser's protocol (12) or later, and the browser is a fourth machine switch", () => {
  expect(MACHINE_PROTOCOL_VERSION).toBeGreaterThanOrEqual(BROWSER_PROTOCOL);
  expect(TOOL_NAMES).toContain("browser");
  const off: RunnerAccess = { folders: [], tools: { claude: true, codex: false, commands: true } };
  const on = setTool(off, "browser", true);
  expect(on.tools.browser).toBe(true);
  // The server can only turn it off, never on.
  expect(reduceAccess(on, { disableTool: "browser" }).tools.browser).toBe(false);
  expect(widens(reduceAccess(off, { disableTool: "browser" }), off)).toBe(false);
  expect(widens(on, off)).toBe(true);
});

test("release target, session cap and Chrome names", () => {
  expect(agentBrowserTarget("darwin", "arm64")).toBe("darwin-arm64");
  expect(agentBrowserTarget("linux", "x64")).toBe("linux-x64");
  expect(agentBrowserTarget("win32", "x64")).toBe("win32-x64");
  expect(agentBrowserTarget("win32", "arm64")).toBeNull();
  expect(agentBrowserTarget("freebsd", "x64")).toBeNull();
  const GB = 1024 ** 3;
  expect(defaultMaxSessions(2 * GB)).toBe(1);
  expect(defaultMaxSessions(8 * GB)).toBe(6);
  expect(defaultMaxSessions(64 * GB)).toBe(8);
});

test("only the computer's Google Chrome is driven, at its standard path on each system", () => {
  const home = tempDir("chrome-home-");
  dirs.push(home);
  const app = path.join("Google Chrome.app", "Contents", "MacOS", "Google Chrome");
  expect(chromeCandidates(home, "darwin")).toEqual([
    path.join("/Applications", app),
    path.join(home, "Applications", app),
  ]);
  expect(chromeCandidates(home, "linux", {}, "x64")).toEqual(["/opt/google/chrome/chrome"]);
  // Linux on ARM, where Google makes no Chrome: Debian's Chromium, then Ubuntu's snap (ADR 0153).
  expect(chromeCandidates(home, "linux", {}, "arm64")).toEqual([
    "/opt/google/chrome/chrome",
    "/usr/bin/chromium",
    "/snap/bin/chromium",
  ]);
  expect(usesChromium("linux", "arm64")).toBe(true);
  expect(usesChromium("linux", "x64")).toBe(false);
  expect(usesChromium("darwin", "arm64")).toBe(false);
  expect(chromeName("/opt/google/chrome/chrome")).toBe("Google Chrome");
  for (const exe of CHROMIUM_LINUX) expect(chromeName(exe)).toBe("Chromium");
  // Only the snap reads no hidden folder at the top of the home, so its start pages move.
  expect(confinedChrome("/snap/bin/chromium")).toBe(true);
  expect(confinedChrome("/usr/bin/chromium")).toBe(false);
  expect(confinedChrome(null)).toBe(false);
  expect(
    chromeCandidates(home, "win32", {
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      LOCALAPPDATA: "C:\\Users\\ana\\AppData\\Local",
    }),
  ).toEqual([
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Users\\ana\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
  ]);
  // No Chrome for Testing, ever: one in agent-browser's folder isn't looked at.
  mkdirSync(path.join(home, ".agent-browser", "browsers", "chrome-155.0.1", "chrome-linux64"), { recursive: true });
  writeFileSync(path.join(home, ".agent-browser", "browsers", "chrome-155.0.1", "chrome-linux64", "chrome"), "");
  const mine = path.join(home, "Applications", app);
  if (!existsSync(path.join("/Applications", app))) {
    expect(findChrome(home, "darwin")).toBeNull();
    mkdirSync(path.dirname(mine), { recursive: true });
    writeFileSync(mine, "");
    expect(findChrome(home, "darwin")).toBe(mine);
  }
  // The version on disk: the app's Info.plist on a Mac, the newest version folder on Windows, `--version` on Linux.
  mkdirSync(path.dirname(mine), { recursive: true });
  writeFileSync(
    path.join(home, "Applications", "Google Chrome.app", "Contents", "Info.plist"),
    "<plist><dict><key>CFBundleShortVersionString</key>\n\t<string>157.0.7000.2</string></dict></plist>",
  );
  expect(chromeVersion(mine, "darwin")).toBe("157.0.7000.2");
  const win = path.join(home, "win");
  for (const d of ["156.0.8078.79", "157.0.8100.9", "157.0.8100.10", "SetupMetrics"]) {
    mkdirSync(path.join(win, d), { recursive: true });
  }
  expect(chromeVersion(path.join(win, "chrome.exe"), "win32")).toBe("157.0.8100.10");
  const linux = path.join(home, "chrome");
  writeFileSync(linux, '#!/bin/sh\necho "Google Chrome 156.0.8078.79 "\n', { mode: 0o755 });
  if (process.platform !== "win32") expect(chromeVersion(linux, "linux")).toBe("156.0.8078.79");
  expect(chromeVersion(path.join(home, "missing"), "linux")).toBeNull();
  // On every launch: nothing updating Chrome's components and no updater started by our Chrome, pages asked to hold
  // still (`prefers-reduced-motion`), no chip asking to sign in to Chrome itself, and the sites' sessions kept across
  // its restarts.
  expect(CHROME_ARGS).toEqual([
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",
    "--disable-component-update",
    "--disable-updater-scheduler",
    "--disable-search-engine-choice-screen",
    "--force-prefers-reduced-motion",
    "--disable-features=SigninPromoOnAvatarPill",
    "--restore-last-session",
  ]);
});

test("what a browser request waited on, as the server keeps it: known steps, whole milliseconds up to an hour", () => {
  expect(browserSetupOf({ worker: 1200, install: 28_100, queued: 0, desktop: 2300, launch: 1400 })).toEqual({
    worker: 1200,
    install: 28_100,
    queued: 0,
    desktop: 2300,
    launch: 1400,
  });
  expect(browserSetupOf({ launch: 1.5, install: -1, desktop: 3_600_001, queued: "9", chrome: 5 })).toBeNull();
  expect(browserSetupOf({ launch: 3_600_000, other: 1 })).toEqual({ launch: 3_600_000 });
  for (const v of [null, undefined, 7, "x", []]) expect(browserSetupOf(v)).toBeNull();
});

test("site allowlist: exact hosts, *. wildcards with the bare domain, blank pages always", () => {
  expect(domainAllowed("https://evil.com", [])).toBe(true);
  const list = ["shop.example.com", "*.stripe.com"];
  expect(domainAllowed("https://shop.example.com/cart", list)).toBe(true);
  expect(domainAllowed("https://www.shop.example.com", list)).toBe(false);
  expect(domainAllowed("https://stripe.com", list)).toBe(true);
  expect(domainAllowed("https://checkout.stripe.com/pay", list)).toBe(true);
  expect(domainAllowed("https://notstripe.com", list)).toBe(false);
  expect(domainAllowed("about:blank", list)).toBe(true);
  expect(domainAllowed("file:///etc/passwd", list)).toBe(false);
  expect(domainAllowed("not a url", list)).toBe(false);
});

test("only web pages: local files, view-source, browser pages and scripts are refused whatever their case", () => {
  expect(isWebPage("https://shop.example.com")).toBe(true);
  expect(isWebPage("HTTP://shop.example.com")).toBe(true);
  expect(isWebPage("about:blank")).toBe(true);
  for (const url of [
    "file:///etc/passwd",
    "FILE:///etc/passwd",
    " File:///Users/x/.ssh/id_rsa",
    "view-source:file:///etc/passwd",
    "VIEW-SOURCE:https://x.com",
    "chrome://settings",
    "devtools://devtools/bundled/inspector.html",
    "javascript:alert(1)",
    "data:text/html,hi",
    "about:settings",
  ]) {
    expect(isWebPage(url)).toBe(false);
  }
});

test("relay input: clicks as input_mouse, keys through press (chords), text inserted, taps as clicks", () => {
  const state: InputState = { held: new Set() };
  expect(relayCommands({ kind: "mouse", type: "mousePressed", x: 10, y: 20 }, state)).toEqual([
    {
      action: "input_mouse",
      type: "mousePressed",
      x: 10,
      y: 20,
      button: "left",
      buttons: 1,
      clickCount: 1,
      deltaX: 0,
      deltaY: 0,
      modifiers: 0,
    },
  ]);
  expect(relayCommands({ kind: "key", type: "keyDown", key: "Enter" }, state)).toEqual([
    { action: "press", key: "Enter" },
  ]);
  // press already released it.
  expect(relayCommands({ kind: "key", type: "keyUp", key: "Enter" }, state)).toEqual([]);
  expect(relayCommands({ kind: "key", type: "keyDown", key: "a", modifiers: 2 }, state)).toEqual([
    { action: "press", key: "Control+a" },
  ]);
  expect(relayCommands({ kind: "key", type: "keyDown", key: "A", modifiers: 8 }, state)).toEqual([
    { action: "press", key: "A" },
  ]);
  // A modifier on its own is held and released as raw keys; an unmatched release sends nothing.
  expect(relayCommands({ kind: "key", type: "keyDown", key: "Shift", code: "ShiftLeft" }, state)).toEqual([
    { action: "input_keyboard", type: "keyDown", key: "Shift", code: "ShiftLeft" },
  ]);
  expect(relayCommands({ kind: "key", type: "keyUp", key: "Shift" }, state)).toEqual([
    { action: "input_keyboard", type: "keyUp", key: "Shift" },
  ]);
  expect(relayCommands({ kind: "key", type: "keyUp", key: "Shift" }, state)).toEqual([]);
  expect(relayCommands({ kind: "text", text: "olá" }, state)).toEqual([
    { action: "keyboard", subaction: "insertText", text: "olá" },
  ]);
  const tap = relayCommands({ kind: "touch", type: "touchStart", touchPoints: [{ x: 1, y: 2 }] }, state);
  expect(tap.map((c) => [c.type, c.x, c.y, c.button])).toEqual([
    // The press above never got its release: it lets go where it was first.
    ["mouseReleased", 10, 20, "left"],
    ["mouseMoved", 1, 2, "none"],
    ["mousePressed", 1, 2, "left"],
  ]);
  // The release has no points: it lands where the touch was.
  expect(relayCommands({ kind: "touch", type: "touchEnd", touchPoints: [] }, state)).toMatchObject([
    { action: "input_mouse", type: "mouseReleased", x: 1, y: 2, button: "left" },
  ]);
});

test("relay input: every move between a press and its release says the button is down, a finger's too", () => {
  const state: InputState = { held: new Set() };
  const buttons = (e: Parameters<typeof relayCommands>[0]) => relayCommands(e, state).map((c) => c.buttons);
  expect(buttons({ kind: "mouse", type: "mouseMoved", x: 1, y: 1 })).toEqual([0]);
  expect(buttons({ kind: "mouse", type: "mousePressed", x: 1, y: 1, button: "left" })).toEqual([1]);
  expect(buttons({ kind: "mouse", type: "mouseMoved", x: 5, y: 1, button: "left" })).toEqual([1]);
  // A move that names no button (an older app) still drags while the press holds.
  expect(buttons({ kind: "mouse", type: "mouseMoved", x: 9, y: 1 })).toEqual([1]);
  expect(buttons({ kind: "mouse", type: "mouseReleased", x: 9, y: 1, button: "left" })).toEqual([0]);
  expect(buttons({ kind: "mouse", type: "mouseMoved", x: 12, y: 1 })).toEqual([0]);
  expect(buttons({ kind: "touch", type: "touchStart", touchPoints: [{ x: 1, y: 1 }] })).toEqual([0, 1]);
  expect(buttons({ kind: "touch", type: "touchMove", touchPoints: [{ x: 9, y: 1 }] })).toEqual([1]);
  expect(buttons({ kind: "touch", type: "touchEnd", touchPoints: [] })).toEqual([0]);
});

test("relay input: a press whose release was lost lets go where it was, before the next click", () => {
  const state: InputState = { held: new Set() };
  const sent = (e: Parameters<typeof relayCommands>[0]) =>
    relayCommands(e, state).map((c) => [c.type, c.x, c.button, c.buttons]);
  sent({ kind: "mouse", type: "mousePressed", x: 10, y: 10, button: "left" });
  sent({ kind: "mouse", type: "mouseMoved", x: 60, y: 10, button: "left" });
  // The release never came. The next click doesn't drag from there to its own point.
  expect(sent({ kind: "mouse", type: "mouseMoved", x: 300, y: 200, button: "none" })).toEqual([
    ["mouseReleased", 60, "left", 0],
    ["mouseMoved", 300, "none", 0],
  ]);
  expect(sent({ kind: "mouse", type: "mousePressed", x: 300, y: 200, button: "left" })).toEqual([
    ["mousePressed", 300, "left", 1],
  ]);
  // Pressed again while still down (its release lost too): it lets go first.
  expect(sent({ kind: "mouse", type: "mousePressed", x: 400, y: 200, button: "left" })).toEqual([
    ["mouseReleased", 300, "left", 0],
    ["mousePressed", 400, "left", 1],
  ]);
});

test("a drag keeps the gaps the person made, each at most 100 ms; a click and the hovering pointer go at once", () => {
  const state: InputState = { held: new Set() };
  const mouse = (type: "mouseMoved" | "mousePressed" | "mouseReleased", at?: number, button?: "left") =>
    ({ kind: "mouse", type, x: 1, y: 1, ...(button ? { button } : {}), ...(at === undefined ? {} : { at }) }) as const;
  expect(dragDelay(mouse("mouseMoved", 0), state, 1000)).toBe(0);
  expect(dragDelay(mouse("mousePressed", 0, "left"), state, 1000)).toBe(0);
  // The drag's moves came in one batch: each waits its own gap after the one before it went.
  expect(dragDelay(mouse("mouseMoved", 40, "left"), state, 1001)).toBe(39);
  expect(dragDelay(mouse("mouseMoved", 80, "left"), state, 1040)).toBe(40);
  // A two second pause plays as 100 ms; a move that came late goes at once.
  expect(DRAG_GAP_MAX_MS).toBe(100);
  expect(dragDelay(mouse("mouseMoved", 2080, "left"), state, 1080)).toBe(100);
  expect(dragDelay(mouse("mouseMoved", 2100, "left"), state, 1500)).toBe(0);
  expect(dragDelay(mouse("mouseReleased", 2110, "left"), state, 1500)).toBe(10);
  // After the release the pointer only hovers; a click's events all say the same time.
  expect(dragDelay(mouse("mouseMoved", 2400), state, 1501)).toBe(0);
  expect(dragDelay(mouse("mousePressed", 2500, "left"), state, 1600)).toBe(0);
  expect(dragDelay(mouse("mouseReleased", 2500, "left"), state, 1601)).toBe(0);
  // A sender that says nothing of time (an older app) goes at once.
  expect(dragDelay(mouse("mousePressed", undefined, "left"), state, 1700)).toBe(0);
  expect(dragDelay(mouse("mouseMoved", 3000, "left"), state, 1700)).toBe(0);
  // Never past `until`, and what was cut stays cut: the next gap counts from when its event really went.
  expect(dragDelay(mouse("mousePressed", 0, "left"), state, 2000, 2150)).toBe(0);
  expect(dragDelay(mouse("mouseMoved", 100, "left"), state, 2000, 2150)).toBe(100);
  expect(dragDelay(mouse("mouseMoved", 200, "left"), state, 2100, 2150)).toBe(50);
  expect(dragDelay(mouse("mouseMoved", 300, "left"), state, 2150, 2150)).toBe(0);
  expect(dragDelay(mouse("mouseMoved", 400, "left"), state, 2160)).toBe(90);
});

// ── Commands ─────────────────────────────────────────────────────────────────

test.if(posix)("the runner starts the agent's Chrome itself and every command connects to it", async () => {
  const t = setup();
  expect(await t.act("open", ["https://shop.example.com"])).toMatchObject({ success: true });
  // One Google Chrome, on the agent's profile, with our flags and none of the automation markers.
  expect(t.chromes).toHaveLength(1);
  const chrome = t.chromes[0] as FakeChrome;
  const profile = path.join(await t.folder(), ".agentes", "browser");
  expect(chrome.exe).toBe(CHROME_EXE);
  expect(chrome.profile).toBe(profile);
  for (const f of CHROME_ARGS) expect(chrome.args).toContain(f);
  expect(chrome.args).toContain("--headless=new");
  expect(chrome.args).toContain("--disable-blink-features=AutomationControlled");
  expect(chrome.args).toContain("--remote-debugging-port=0");
  expect(chrome.args).toContain(`--user-data-dir=${profile}`);
  expect(chrome.args.some((a) => a.includes("enable-automation"))).toBe(false);
  // Headless, it would say "HeadlessChrome": the version on disk's own user agent instead.
  const ua = chrome.args.find((a) => a.startsWith("--user-agent="));
  expect(ua).toContain("Chrome/156.0.0.0");
  expect(ua).not.toContain("Headless");
  // The agent's start page file, no extension.
  expect(chrome.args.at(-1)).toMatch(/^file:\/\/.+\/agentes-start\.html$/);
  expect(chrome.args.some((a) => a.startsWith("--load-extension"))).toBe(false);

  const [call] = t.logged();
  const args = call?.args ?? [];
  const flag = (name: string) => args[args.indexOf(name) + 1];
  expect(flag("--cdp")).toBe(String(chrome.port));
  expect(flag("--session")).toBe("agent-01a142cb");
  expect(flag("--config")).toBe(path.join(t.home, "browser", "config.json"));
  expect(flag("--namespace")).toMatch(/^agentes-[0-9a-f]{8}$/);
  expect(args).toContain("--json");
  expect(args).toContain("--content-boundaries");
  expect(args).toContain("--no-webmcp");
  // agent-browser never launches a Chrome of its own.
  expect(args).not.toContain("--executable-path");
  expect(args).not.toContain("--profile");
  expect(args).not.toContain("--args");
  expect(args.slice(-2)).toEqual(["open", "https://shop.example.com"]);
  expect(readFileSync(path.join(t.home, "browser", "config.json"), "utf8").trim()).toBe("{}");
  // The same Chrome for the next command; its pid is remembered for a crash.
  await t.act("click", ["@e1"]);
  expect(t.chromes).toHaveLength(1);
  expect(JSON.parse(readFileSync(path.join(t.home, "browser", "chromes.json"), "utf8"))).toEqual([
    { pid: 40_001, profile },
  ]);
  // Another agent: its own Chrome, session and profile.
  await t.act("open", ["https://a.example"], { agent: ops });
  const other = t.logged().at(-1)?.args ?? [];
  expect(other[other.indexOf("--session") + 1]).toBe("agent-9f00aa11");
  expect(t.chromes).toHaveLength(2);
  expect(other[other.indexOf("--cdp") + 1]).toBe(String(t.chromes[1]?.port));
});

test("a click goes as a person's: the box, then a pointer path into it, a check and a held press; a covered one the plain way", async () => {
  const t = setup();
  await t.act("open", ["https://shop.example.com"]);
  t.page({
    boxes: { "@e1": { x: 600, y: 400, width: 120, height: 40 } },
    viewport: [1280, 800],
    hit: { tag: "BUTTON", box: [600, 400, 720, 440] },
  });
  expect(await t.act("click", ["@e1"])).toMatchObject({ success: true, data: { clicked: "@e1" } });
  const batches = t
    .logged()
    .filter((c) => c.args.includes("batch"))
    .map((c) => JSON.parse(c.stdin) as string[][]);
  // In view: the page stays where it is.
  expect(batches[0]).toEqual([
    ["get", "box", "@e1"],
    ["eval", "[window.innerWidth, window.innerHeight]"],
  ]);
  const human = batches[1] ?? [];
  expect(human[0]?.slice(0, 2)).toEqual(["mouse", "move"]);
  expect(human.at(-4)?.[0]).toBe("eval");
  const moves = human.filter((c) => c[0] === "mouse" && c[1] === "move");
  expect(moves.length).toBeGreaterThan(8);
  const [x, y] = (moves.at(-1) ?? []).slice(2, 4).map(Number);
  expect(x).toBeGreaterThan(600);
  expect(x).toBeLessThan(720);
  expect(y).toBeGreaterThan(400);
  expect(y).toBeLessThan(440);
  expect(human.slice(-3).map((c) => c.slice(0, 2).join(" "))).toEqual([
    "mouse down",
    `wait ${human.at(-2)?.[1]}`,
    "mouse up",
  ]);
  expect(t.logged().some((c) => c.args.at(-2) === "click")).toBe(false);
  // The next path starts where this one ended.
  await t.act("click", ["@e1"]);
  const next = JSON.parse(
    t
      .logged()
      .filter((c) => c.args.includes("batch"))
      .at(-1)?.stdin ?? "[]",
  ) as string[][];
  const start = next.find((c) => c[1] === "move") ?? [];
  expect(Math.abs(Number(start[2]) - (x ?? 0)) + Math.abs(Number(start[3]) - (y ?? 0))).toBeLessThan(60);
  // Covered (a banner over it) once the pointer is there: the browser's own click, which says what covers it.
  const lastBatch = () =>
    JSON.parse(
      t
        .logged()
        .filter((c) => c.args.includes("batch"))
        .at(-1)?.stdin ?? "[]",
    ) as string[][];
  t.page({ hit: { tag: "DIV", box: [0, 300, 1280, 800] } });
  expect(await t.act("click", ["@e1"])).toMatchObject({ success: true });
  expect(lastBatch()).toEqual([["click", "@e1"]]);
  // In a frame its box is in that frame's coordinates: what the top page has there isn't it.
  t.page({ hit: { tag: "A", box: [620, 410, 700, 430] } });
  await t.act("click", ["@e1"]);
  expect(lastBatch()).toEqual([["click", "@e1"]]);
  // Not all in view: scrolled there, and looked at again where it went.
  t.page({
    hit: { tag: "BUTTON", box: [600, 400, 720, 440] },
    boxes: { "@e1": { x: 600, y: 1400, width: 120, height: 40 } },
  });
  await t.act("click", ["@e1"]);
  const looks = t
    .logged()
    .filter((c) => c.args.includes("batch"))
    .map((c) => JSON.parse(c.stdin) as string[][])
    .slice(-4);
  expect(looks[0]?.[0]).toEqual(["get", "box", "@e1"]);
  expect(looks[1]?.slice(0, 2)).toEqual([
    ["scrollintoview", "@e1"],
    ["get", "box", "@e1"],
  ]);
  t.page({ boxes: { "@e1": { x: 600, y: 400, width: 120, height: 40 } } });
  // No box (not found), or a flag: the plain command.
  await t.act("click", ["@e9"]);
  expect(t.logged().at(-1)?.args.slice(-2)).toEqual(["click", "@e9"]);
  await t.act("click", ["@e1", "--new-tab"]);
  expect(t.logged().at(-1)?.args.slice(-3)).toEqual(["click", "@e1", "--new-tab"]);
  // A drag goes along the browser's own eased curve.
  await t.act("drag", ["@e1", "@e2"]);
  expect(t.logged().at(-1)?.args.slice(-4)).toEqual(["drag", "@e1", "@e2", "--human"]);
});

test("an action on a point of the page: the pointer goes along a path, text as keys when a field has the focus", async () => {
  const t = setup();
  await t.act("open", ["https://shop.example.com"]);
  t.page({ viewport: [1280, 800] });
  expect(await t.act("mouse", ["move", "900", "300"])).toMatchObject({ success: true, data: { x: 900, y: 300 } });
  const batch = () =>
    JSON.parse(
      t
        .logged()
        .filter((c) => c.args.includes("batch"))
        .at(-1)?.stdin ?? "[]",
    ) as string[][];
  const path = batch();
  expect(path.length).toBeGreaterThan(8);
  expect(path.every((c) => c[1] === "move")).toBe(true);
  expect(path.at(-1)?.slice(2, 4)).toEqual(["900", "300"]);
  // The next one starts from there, and a press goes as it came.
  await t.act("mouse", ["move", "920", "310"]);
  const next = batch()[0] ?? [];
  expect(Math.abs(Number(next[2]) - 900)).toBeLessThan(25);
  await t.act("mouse", ["down", "left"]);
  expect(t.logged().at(-1)?.args.slice(-3)).toEqual(["mouse", "down", "left"]);
  await t.act("mouse", ["up", "left"]);
  expect(t.logged().at(-1)?.args.slice(-3)).toEqual(["mouse", "up", "left"]);
  t.page({ focusedRef: "@e2", attrs: { "@e2": { tag: "INPUT", type: "search" } } });
  expect(await t.act("keyboard", ["inserttext", "oi"])).toMatchObject({ success: true });
  expect(
    batch()
      .filter((c) => c[0] === "press")
      .map((c) => c[1]),
  ).toEqual(["o", "i"]);
  // No field has the focus: keys would be the page's shortcuts.
  t.page({ focusedRef: null });
  await t.act("keyboard", ["inserttext", "oi"]);
  expect(t.logged().at(-1)?.args.slice(-3)).toEqual(["keyboard", "inserttext", "oi"]);
});

test("fill clicks the field, selects it and types over it with a person's gaps; a date field is filled at once", async () => {
  const t = setup();
  await t.act("open", ["https://shop.example.com"]);
  t.page({
    boxes: { "@e2": { x: 100, y: 100, width: 300, height: 30 } },
    viewport: [1280, 800],
    hit: { tag: "INPUT", type: "email", box: [100, 100, 400, 130], ref: "@e2" },
  });
  expect(await t.act("fill", ["@e2", "a@b.co"])).toMatchObject({ success: true, data: { filled: "@e2" } });
  const human = JSON.parse(
    t
      .logged()
      .filter((c) => c.args.includes("batch"))
      .at(-1)?.stdin ?? "[]",
  ) as string[][];
  const at = human.map((c) => c[0]).lastIndexOf("eval");
  const landed = human.filter((c) => c[1] === "move").at(-1) ?? [];
  expect(human[at]).toEqual(["eval", selectFieldScript({ x: Number(landed[2]), y: Number(landed[3]) })]);
  expect(human.some((c) => c[0] === "fill")).toBe(false);
  expect(human.slice(at - 3, at).map((c) => `${c[0]}${c[1]}`)).toEqual([
    "mousedown",
    `wait${human[at - 2]?.[1]}`,
    "mouseup",
  ]);
  const keys = human.slice(at + 1);
  expect(keys.filter((c) => c[0] === "press").map((c) => c[1])).toEqual([..."a@b.co"]);
  const waits = keys.filter((c) => c[0] === "wait").map((c) => Number(c[1]));
  expect(waits).toHaveLength(6);
  expect(new Set(waits).size).toBeGreaterThan(1);
  t.page({ hit: { tag: "INPUT", type: "date", box: [100, 100, 400, 130] } });
  await t.act("fill", ["@e2", "2026-11-05"]);
  const plain = JSON.parse(
    t
      .logged()
      .filter((c) => c.args.includes("batch"))
      .at(-1)?.stdin ?? "[]",
  ) as string[][];
  expect(plain).toEqual([["fill", "@e2", "2026-11-05"]]);
  // The click moved the focus off the field: nothing is typed anywhere else, the command goes as given.
  t.page({ hit: { tag: "INPUT", type: "text", box: [100, 100, 400, 130] } });
  expect(await t.act("fill", ["@e2", "oi"])).toMatchObject({ success: true });
  const asGiven = JSON.parse(
    t
      .logged()
      .filter((c) => c.args.includes("batch"))
      .at(-1)?.stdin ?? "[]",
  ) as string[][];
  expect(asGiven).toEqual([["fill", "@e2", "oi"]]);
});

describe("a person takes control while the agent's pointer and keys are going", () => {
  const typingPage = {
    boxes: { "@e2": { x: 100, y: 100, width: 300, height: 30 } },
    viewport: [1280, 800],
    hit: { tag: "INPUT", type: "email", box: [100, 100, 400, 130], ref: "@e2" },
  };
  const started = async (command: string, args: string[]) => {
    const t = setup();
    await t.act("open", ["https://shop.example.com"]);
    t.page({ ...typingPage, typingMs: 20_000 });
    const before = t.logged().length;
    const going = t.act(command, args);
    await waitFor(() =>
      t
        .logged()
        .slice(before)
        .some((c) => /"press"|"move"/.test(c.stdin ?? "")),
    );
    return { t, before, going };
  };

  test("a person's turn stops a fill: told so, not typed again, and no button stays down", async () => {
    const { t, before, going } = await started("fill", ["@e2", "a@b.co"]);
    t.manager.setHandoff(dev.id, { status: "pending" });
    await Bun.sleep(50);
    t.manager.setHandoff(dev.id, { status: "active", controller: "Maria" });
    const answer = await going;
    expect(answer).toMatchObject({ success: false, data: null });
    expect(answer.error).toContain("A person took control of your browser");
    const after = t.logged().slice(before);
    expect(after.at(-1)?.args.slice(-2)).toEqual(["mouse", "up"]);
    expect(after.filter((c) => c.args.includes("batch")).map((c) => c.stdin)).not.toContain(
      JSON.stringify([["fill", "@e2", "a@b.co"]]),
    );
  });

  test("taking control stops a command under way even with no stream open yet, which queues behind it", async () => {
    const { t, going } = await started("mouse", ["move", "900", "300"]);
    const control = t.manager.streamStart(dev, "control");
    expect((await going).error).toContain("A person took control");
    await control;
  });
});

test("after a hover the pointer goes straight to the next element, and curves again once it left", async () => {
  const t = setup();
  await t.act("open", ["https://shop.example.com"]);
  t.page({
    boxes: {
      "@e1": { x: 100, y: 100, width: 40, height: 40 },
      "@e2": { x: 700, y: 500, width: 40, height: 40 },
    },
    viewport: [1280, 800],
  });
  const lastMoves = () =>
    (
      JSON.parse(
        t
          .logged()
          .filter((c) => c.stdin.includes('"move"'))
          .at(-1)?.stdin ?? "[]",
      ) as string[][]
    )
      .filter((c) => c[1] === "move")
      .map((c) => ({ x: Number(c[2]), y: Number(c[3]) }));
  const offLine = (path: { x: number; y: number }[]) => {
    const a = path[0] as { x: number; y: number };
    const b = path.at(-1) as { x: number; y: number };
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    return Math.max(...path.map((p) => Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / d));
  };
  await t.act("hover", ["@e1"]);
  await t.act("hover", ["@e2"]);
  expect(offLine(lastMoves())).toBeLessThan(3);
  await t.act("click", ["@e1"]);
  await t.act("click", ["@e2"]);
  expect(offLine(lastMoves())).toBeGreaterThan(8);
});

test("a normal Chrome user agent for the platform, and the whole launch line per browser kind", () => {
  const version = "155.0.8059.84";
  expect(chromeUserAgent(version, "darwin")).toBe(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
  );
  expect(chromeUserAgent(version, "win32")).toContain("Windows NT 10.0; Win64; x64");
  expect(chromeUserAgent(version, "linux")).toContain("X11; Linux x86_64");
  expect(chromeUserAgent(null, "linux")).toBeNull();
  const args = chromeLaunchArgs(version, "/p", "darwin", "pt-BR");
  expect(args).toContain("--lang=pt-BR");
  expect(args).toContain("--user-data-dir=/p");
  // The key to the agent's cookies and saved logins stays where Chrome for Testing kept it, so sign-ins carry over:
  // never the person's keychain (macOS would ask for their password), a fixed one on Linux, Windows' own per user.
  expect(args).toContain("--use-mock-keychain");
  expect(chromeLaunchArgs(version, "/p", "linux", null)).toContain("--password-store=basic");
  const windows = chromeLaunchArgs(version, "/p", "win32", null);
  expect(windows.some((a) => a.startsWith("--password-store") || a === "--use-mock-keychain")).toBe(false);
  expect(args.at(-1)).toBe("about:blank");
  // Headless: our user agent, as "HeadlessChrome" would be refused. Headed (the agent's desktop): Chrome's own.
  expect(args).toContain("--headless=new");
  expect(args.some((a) => a.startsWith("--user-agent=") && a.includes("Chrome/155.0.0.0"))).toBe(true);
  const headed = chromeLaunchArgs(version, "/p", "linux", null, true);
  expect(headed).not.toContain("--headless=new");
  expect(headed.some((a) => a.startsWith("--user-agent"))).toBe(false);
  // The automation flag's bar hidden; no flag only Chrome for Testing knew, nothing starting Google's updater.
  expect(headed).toContain("--test-type");
  expect(headed).not.toContain("--test-type=gpu");
  for (const a of [args, headed]) {
    expect(a).toContain("--disable-updater-scheduler");
    expect(a.some((x) => x.startsWith("--load-extension"))).toBe(false);
  }
  expect(chromeLaunchArgs(null, "/p", "linux", null).some((a) => a.startsWith("--user-agent"))).toBe(false);
});

/** Starts a fake Chrome that runs `body` (sh) and exits; what `launchChrome` threw. */
async function failedStart(body: string): Promise<ChromeStartError> {
  const dir = tempDir("chrome-");
  dirs.push(dir);
  const exe = path.join(dir, "chrome");
  writeFileSync(exe, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const err = await launchChrome(exe, ["--headless=new"], dir).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ChromeStartError);
  return err as ChromeStartError;
}

test.if(posix)(
  "a Chrome that can't load its libraries says which, in words for people; a profile in use only when Chrome says so",
  async () => {
    const loader = `echo "$0: error while loading shared libraries: libnspr4.so: cannot open shared object file: No such file or directory" >&2; exit 127`;
    let err = await failedStart(loader);
    expect(err.missing).toEqual(["libnspr4.so"]);
    expect(err.message).toBe(
      "This computer is missing system libraries Chrome needs (libnspr4.so). Install them on it, then try again.",
    );
    expect(err.detail).toMatch(
      /^missing libnspr4\.so: \/.+\/chrome: error while loading shared libraries: libnspr4\.so:/,
    );

    // The loader stops at the first one: ldd lists them all, and people read the first few.
    const bin = tempDir("ldd-");
    dirs.push(bin);
    const libs = ["libglib-2.0.so.0", "libnss3.so", "libnssutil3.so", "libsmime3.so", "libnspr4.so", "libX11.so.6"];
    const all = [...libs, "libasound.so.2"];
    writeFileSync(
      path.join(bin, "ldd"),
      `#!/bin/sh\nprintf '\\tlibc.so.6 => /lib/libc.so.6 (0x7f00)\\n'\nfor l in ${all.join(" ")}; do printf '\\t%s => not found\\n' "$l"; done\n`,
      { mode: 0o755 },
    );
    const PATH = process.env.PATH;
    process.env.PATH = `${bin}:${PATH}`;
    try {
      err = await failedStart(loader);
    } finally {
      process.env.PATH = PATH;
    }
    expect(err.missing).toEqual(all);
    expect(err.message).toContain(`(${libs.slice(0, 5).join(", ")} and 2 more). Install them on it`);
    expect(err.detail).toStartWith(`missing ${all.join(", ")}: `);

    // A profile another Chrome holds, as Chrome says it and exits.
    const held =
      "Failed to create a ProcessSingleton for your profile directory. Aborting now to avoid profile corruption.";
    err = await failedStart(`echo "${held}" >&2; exit 21`);
    expect(err.missing).toEqual([]);
    expect(err.message).toBe("Chrome closed while starting (another Chrome is using this profile)");
    expect(err.profile).toBe(true);
    expect(err.detail).toBe(held);

    // Any other exit, a loader error among them, gets no guess at why; what Chrome said goes to the logs.
    err = await failedStart(`echo "$0: /lib/libc.so.6: version 'GLIBC_2.38' not found (required by $0)" >&2; exit 1`);
    expect(err.missing).toEqual([]);
    expect(err.message).toBe("Chrome closed while starting");
    expect(err.detail).toContain("version 'GLIBC_2.38' not found");
  },
);

test.if(posix)("a started Chrome's browser endpoint comes from the second line of its port file", async () => {
  const dir = tempDir("chrome-");
  dirs.push(dir);
  const exe = path.join(dir, "chrome");
  // `$1` is the profile; `$2` what the port file holds.
  writeFileSync(exe, `#!/bin/sh\nprintf "$2" > "$1/DevToolsActivePort"\nexec sleep 30\n`, { mode: 0o755 });
  const start = async (content: string) => {
    const chrome = await launchChrome(exe, [dir, content], dir);
    chrome.kill();
    await chrome.exited;
    return chrome;
  };
  expect(await start("45678\\n/devtools/browser/0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0")).toMatchObject({
    port: 45678,
    wsPath: "/devtools/browser/0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0",
  });
  // A port alone, or anything else on the second line, gives no endpoint: its traffic isn't counted.
  expect(await start("45679")).not.toHaveProperty("wsPath");
  expect(await start("45680\\nws://elsewhere/devtools/browser/x")).not.toHaveProperty("wsPath");
});

test.if(posix)("a fixed CDP port accepts only its owned listener and ignores a stale port file", async () => {
  const dir = tempDir("chrome-fixed-");
  dirs.push(dir);
  const exe = path.join(dir, "chrome");
  writeFileSync(exe, '#!/bin/sh\nprintf "45678\\n/devtools/browser/stale" > "$1/DevToolsActivePort"\nexec sleep 30\n', {
    mode: 0o755,
  });
  const server = createServer((socket) => {
    socket.once("data", () => {
      const body = JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/owned` });
      socket.end(
        `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no listener");
  const port = addr.port;
  try {
    const chrome = await launchChrome(
      exe,
      [dir, `--remote-debugging-port=${port}`],
      dir,
      undefined,
      undefined,
      () => true,
    );
    expect(chrome).toMatchObject({ port, wsPath: "/devtools/browser/owned" });
    chrome.kill();
    await chrome.exited;
  } finally {
    server.close();
  }
});

/**
 * A Chrome's DevTools endpoint on this computer, for the traffic counter: each connection's first
 * auto-attach is answered when `answer` lets it, then a page attaches, and once its network events are on
 * it says it received the next of `down` (bytes) and sent a request of 100 bytes of body. `crash(n)` says the
 * page of connection `n` died; its history is one entry at `https://heavy.example/`, and where it is sent
 * (`Page.navigate`) is kept in `navigated`.
 */
function fakeDevtools(down: number[], answer: (reply: () => void) => void = (reply) => reply()) {
  const asked: string[] = [];
  /** `Browser.close` on connection `n` (`chromesAt` closes that Chrome). */
  const closing = { on: (_n: number) => {} };
  const navigated: string[] = [];
  const sockets: { send(data: string): unknown }[] = [];
  let connections = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("upgrade", { status: 426 })),
    websocket: {
      open(ws) {
        (ws as unknown as { data: number }).data = connections++;
        sockets.push(ws);
      },
      message(ws, raw) {
        const msg = JSON.parse(String(raw)) as {
          id: number;
          method: string;
          params?: { url?: string };
          sessionId?: string;
        };
        asked.push(msg.sessionId ? `${msg.method} ${msg.sessionId}` : msg.method);
        const n = (ws as unknown as { data: number }).data;
        const event = (method: string, params: object, sessionId?: string) =>
          ws.send(JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) }));
        const result = (r: object) => ws.send(JSON.stringify({ id: msg.id, result: r }));
        if (msg.method === "Target.setAutoAttach" && !msg.sessionId) {
          answer(() => {
            result({});
            event("Target.attachedToTarget", {
              sessionId: `page-${n}`,
              targetInfo: { type: "page", targetId: `tab-${n}` },
            });
          });
        } else if (msg.method === "Network.enable") {
          event(
            "Network.requestWillBeSentExtraInfo",
            { requestId: "r", headers: { "content-length": "100" } },
            msg.sessionId,
          );
          event("Network.loadingFinished", { requestId: "r", encodedDataLength: down[n] ?? 0 }, msg.sessionId);
        } else if (msg.method === "Page.getNavigationHistory") {
          result({ currentIndex: 0, entries: [{ id: 1, url: "https://heavy.example/", title: "Heavy" }] });
        } else if (msg.method === "Page.navigate") {
          navigated.push(msg.params?.url ?? "");
          result({ frameId: "main" });
        } else if (msg.method === "Browser.close") {
          result({});
          closing.on(n);
        }
      },
    },
  });
  const crash = (n: number) =>
    sockets[n]?.send(JSON.stringify({ method: "Inspector.targetCrashed", params: {}, sessionId: `page-${n}` }));
  return { port: server.port as number, asked, navigated, crash, closing, stop: () => server.stop(true) };
}

/** Fake Chromes whose endpoint is `devtools`, one connection each: `Browser.close` on it closes that Chrome. */
function chromesAt(devtools: { port: number; closing: { on: (n: number) => void } }) {
  const chromes = fakeChromes();
  devtools.closing.on = (n) => chromes.started[n]?.close();
  const start = async (exe: string, args: string[], profile: string): Promise<OwnChrome> => ({
    ...(await chromes.start(exe, args, profile)),
    port: devtools.port,
    wsPath: "/devtools/browser/fake",
  });
  return { started: chromes.started, start };
}

const SENT = Buffer.byteLength("content-length") + 3 + 4 + 100;

test.if(posix)("a new Chrome's first command waits for its traffic counter to attach, a second at most", async () => {
  let reply = () => {};
  const held = fakeDevtools([], (r) => {
    reply = r;
  });
  try {
    const t = setup({ startChrome: chromesAt(held).start });
    const opened = t.act("open", ["https://a.example/"]);
    await waitFor(() => held.asked.includes("Target.setAutoAttach"));
    await Bun.sleep(300);
    expect(t.logged()).toEqual([]);
    reply();
    expect(await opened).toMatchObject({ success: true });
    expect(t.logged().map((l) => l.args.at(-1))).toEqual(["https://a.example/"]);
  } finally {
    held.stop();
  }

  // An endpoint that never answers holds the first command a second, no more.
  const silent = fakeDevtools([], () => {});
  try {
    const t = setup({ startChrome: chromesAt(silent).start });
    const at = Date.now();
    expect(await t.act("open", ["https://b.example/"])).toMatchObject({ success: true });
    expect(Date.now() - at).toBeGreaterThanOrEqual(950);
  } finally {
    silent.stop();
  }
});

test.if(posix)("takeTraffic: what each Chrome moved, across a restart and after it exits, taken once", async () => {
  const devtools = fakeDevtools([1000, 500]);
  try {
    const chromes = chromesAt(devtools);
    const t = setup({ startChrome: chromes.start });
    expect(t.manager.takeTraffic()).toEqual({ up: 0, down: 0 });
    // The endpoint says what each Chrome moved as soon as its network events are on.
    const counted = async (n: number) => {
      await waitFor(() => devtools.asked.includes(`Network.enable page-${n}`));
      await Bun.sleep(100);
    };
    await t.act("open", ["https://a.example/"]);
    await counted(0);
    // It stops and starts again: what the first one moved waits to be taken.
    await t.manager.stop(dev);
    await t.act("open", ["https://a.example/again"]);
    await counted(1);
    expect(chromes.started.map((c) => c.closed)).toEqual([true, false]);
    expect(t.manager.takeTraffic()).toEqual({ up: 2 * SENT, down: 1500 });
    expect(t.manager.takeTraffic()).toEqual({ up: 0, down: 0 });
    await t.manager.close();
    expect(chromes.started.map((c) => c.closed)).toEqual([true, true]);
    expect(t.manager.takeTraffic()).toEqual({ up: 0, down: 0 });
  } finally {
    devtools.stop();
  }
});

/** Said to the command after the page died, which didn't run. */
const RELOADED = "The page crashed and was reloaded, so this wasn't done. Read it again before you go on.";
/** Said to the command the page died under. */
const RELOADED_UNDER = "The page crashed while this ran, and was reloaded. Read it again before you go on.";
const OUT_OF_MEMORY_UNDER =
  "The page ran out of memory while this ran, and was reloaded. Read it again before you go on.";

test.if(posix)(
  "a page that dies while a newer Chrome waits on disk restarts Chrome on it, on that page, instead of reloading",
  async () => {
    const devtools = fakeDevtools([]);
    try {
      let version = CHROME_VERSION;
      const chromes = chromesAt(devtools);
      const t = setup({ startChrome: chromes.start, chromeVersion: () => version });
      await t.act("open", ["https://heavy.example/"]);
      await waitFor(() => devtools.asked.includes("Network.enable page-0"));
      // The update replaced Chrome's files under it, and its page died.
      version = "157.0.8100.10";
      devtools.crash(0);
      await waitFor(() => chromes.started.length === 2);
      expect(chromes.started[1]?.args.at(-1)).toBe("https://heavy.example/");
      expect(chromes.started[0]?.closed || chromes.started[0]?.killed).toBe(true);
      expect(devtools.navigated).toEqual([]);
      // The agent's next action hears its page changed under it.
      expect(await t.act("click", ["@e1"])).toMatchObject({ success: false, error: RELOADED });
    } finally {
      devtools.stop();
    }
  },
);

test.if(posix)(
  "a page that dies is opened again once: a look runs on it, and the agent's next action is told instead of running",
  async () => {
    const devtools = fakeDevtools([]);
    try {
      const logs: string[] = [];
      const t = setup({ startChrome: chromesAt(devtools).start, log: (l) => logs.push(l) });
      await t.act("open", ["https://heavy.example/"]);
      await waitFor(() => devtools.asked.includes("Network.enable page-0"));
      devtools.crash(0);
      // Opened again at the address it was on.
      await waitFor(() => devtools.navigated.length === 1);
      expect(devtools.asked).toContain("Page.getNavigationHistory page-0");
      expect(devtools.navigated).toEqual(["https://heavy.example/"]);
      // A look and a wait run on the page as it is now: the server ignores their failures (its own looks too).
      expect(await t.act("snapshot")).toMatchObject({ success: true });
      expect(await t.act("wait", ["100"])).toMatchObject({ success: true });
      // A person in control opening a site isn't told either: the agent hears it after their turn.
      t.manager.setHandoff(dev.id, { status: "active", controller: "Ana" });
      expect(await t.act("open", ["https://heavy.example/"])).toMatchObject({ success: true });
      t.manager.setHandoff(dev.id, null);
      const clicks = () => t.logged().filter((l) => l.args.includes("click")).length;
      expect(await t.act("click", ["@e1"])).toMatchObject({ success: false, data: null, error: RELOADED });
      expect(clicks()).toBe(0);
      expect(await t.act("click", ["@e1"])).toMatchObject({ success: true });

      // The agent heard: the next one is reloaded too. Dying twice before it hears shows our notice, no loop.
      devtools.crash(0);
      await waitFor(() => devtools.navigated.length === 2);
      devtools.crash(0);
      await waitFor(() => devtools.navigated.length === 3);
      expect(devtools.navigated[2]).toBe(crashPage(false));
      expect(devtools.asked.filter((a) => a === "Page.getNavigationHistory page-0")).toHaveLength(2);
      // Our notice died too (a page that can't start there at all): Chrome's own page stays, nothing opens again.
      devtools.crash(0);
      await waitFor(() => logs.filter((l) => l.includes(": a page crashed, ")).length === 4);
      expect(logs.at(-1)).toEndWith("a page crashed, left on Chrome's page");
      expect(await t.act("click", ["@e1"])).toMatchObject({
        success: false,
        error: "The page crashed again, so it wasn't reloaded a second time. Open it again only if you need it.",
      });
      // That click ran nothing; this one runs, long enough for a navigation sent at the crash to have arrived.
      expect(await t.act("click", ["@e1"])).toMatchObject({ success: true });
      expect(devtools.navigated).toHaveLength(3);
      expect(devtools.asked.filter((a) => a === "Page.getNavigationHistory page-0")).toHaveLength(2);
      // Our notice, in both languages, in the app's look.
      const notice = decodeURIComponent(crashPage(true).slice("data:text/html;charset=utf-8,".length));
      expect(notice).toContain("<title>A página ficou sem memória</title>");
      expect(notice).toContain("The page ran out of memory");
      expect(notice).toContain("background:#fbfbfa");
      expect(decodeURIComponent(crashPage(false))).toContain("The page stopped working");
    } finally {
      devtools.stop();
    }
  },
);

test.if(posix)(
  "a page that died of memory says so to the action it died under; in a batch, the action's answer says it",
  async () => {
    const dir = tempDir("cgroup-");
    dirs.push(dir);
    // The agent's own slice and all the agents', whose memory they share.
    const agent = path.join(dir, "agent.events");
    const agents = path.join(dir, "agents.events");
    writeFileSync(agent, "low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n");
    writeFileSync(agents, "low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n");
    const devtools = fakeDevtools([]);
    try {
      const t = setup({ startChrome: chromesAt(devtools).start, memoryEvents: { agent, agents } });
      await t.act("open", ["https://heavy.example/"]);
      await waitFor(() => devtools.asked.includes("Network.enable page-0"));
      const ran = (command: string) => t.logged().filter((l) => l.args.includes(command)).length;
      t.page({ delayMs: 400 });
      // The agents reached their limit and the kernel stopped the page while a click ran.
      const clicked = t.act("click", ["@e1"]);
      await waitFor(() => ran("click") === 1);
      writeFileSync(agent, "low 0\nhigh 0\nmax 0\noom 0\noom_kill 1\n");
      writeFileSync(agents, "low 0\nhigh 0\nmax 2\noom 1\noom_kill 1\n");
      devtools.crash(0);
      expect(await clicked).toMatchObject({ success: false, data: null, error: OUT_OF_MEMORY_UNDER });
      // From here the agents' cache sits at their limit (`max` rises at every allocation) and another agent's process
      // is stopped for memory: neither says this agent's page died of it.
      writeFileSync(agents, "low 0\nhigh 0\nmax 900\noom 1\noom_kill 2\n");

      const folder = await t.folder();
      const batch = () =>
        t.manager.batch(dev, folder, {
          op: "browser.batch",
          commands: [
            { command: "click", args: ["@e1"], timeoutSeconds: 30 },
            { command: "eval", args: ["true"], timeoutSeconds: 5, tolerate: true },
            { command: "snapshot", args: [], timeoutSeconds: 30 },
          ],
        });
      // Under the batch's action: that answer says it, and nothing more runs. Its slice didn't reach its limit again.
      const first = batch();
      await waitFor(() => ran("click") === 2);
      devtools.crash(0);
      expect((await first).answers).toEqual([{ success: false, data: null, error: RELOADED_UNDER }]);
      // Under the settling after it, whose failure the server ignores: the action's answer says it, in place of its
      // own and the settling's, and the look doesn't run.
      const second = batch();
      await waitFor(() => ran("eval") === 1);
      devtools.crash(0);
      expect((await second).answers).toEqual([{ success: false, data: null, error: RELOADED_UNDER }]);
      t.page({ delayMs: 0 });
      expect(ran("snapshot")).toBe(0);
      // Before a batch: one with no action (a pause) runs, and the next one's action is told instead of running.
      devtools.crash(0);
      await waitFor(() => devtools.navigated.length === 4);
      const pause = await t.manager.batch(dev, folder, {
        op: "browser.batch",
        commands: [{ command: "wait", args: ["100"], timeoutSeconds: 5 }],
      });
      expect(pause.answers).toEqual([expect.objectContaining({ success: true })]);
      expect((await batch()).answers).toEqual([{ success: false, data: null, error: RELOADED }]);
      expect(ran("click")).toBe(3);
      expect(devtools.navigated).toEqual(Array(4).fill("https://heavy.example/"));
    } finally {
      devtools.stop();
    }
  },
);

test.if(posix)(
  "a plan's click whose page dies while it settles stops there, and the agent's report says so",
  async () => {
    const devtools = fakeDevtools([]);
    try {
      const t = setup({ startChrome: chromesAt(devtools).start });
      await t.act("open", ["https://heavy.example/"]);
      await waitFor(() => devtools.asked.includes("Network.enable page-0"));
      const folder = await t.folder();
      // The server's link to the runner, as its browser tools make it.
      const reply = (a: BrowserAnswer): BrowserReply =>
        a.success ? { ok: true, data: a.data } : { ok: false, text: browserErrorText(a.error || "the command failed") };
      const link: BrowserLink = {
        act: async (c) =>
          reply(
            await t.manager.act(dev, folder, {
              op: "browser.act",
              command: c.command,
              args: c.args,
              timeoutSeconds: c.timeoutSeconds,
            }),
          ),
        batch: async (commands) =>
          (await t.manager.batch(dev, folder, { op: "browser.batch", commands })).answers.map(reply),
        capture: async () => null,
      };
      const ran = (command: string) => t.logged().filter((l) => l.args.includes(command)).length;
      const evals = ran("eval");
      t.page({ delayMs: 400 });
      const judge = { name: "none", ask: () => Promise.reject(new Error("no judge here")) };
      const plan = runPlan({ judge, orgId: "o", surface: browserSurface({ link }), scope: "s" }, [
        { do: "click", target: "e1" },
      ]);
      // The click went through, and the page died while the plan waited for it to settle.
      await waitFor(() => ran("eval") === evals + 1);
      devtools.crash(0);
      const report = await plan;
      expect(report.steps.map((s) => s.status)).toEqual(["failed"]);
      expect(formatPlanReport(report).summary).toBe(`Couldn't click "e1": The browser said: ${RELOADED_UNDER}`);
    } finally {
      devtools.stop();
    }
  },
);

test.if(posix)("flags that reach outside the agent's browser, and unknown commands, are refused", async () => {
  const t = setup();
  expect(await errorCode(() => t.act("open", ["https://x.com", "--profile", "Default"]))).toBe("bad_request");
  expect(await errorCode(() => t.act("open", ["https://x.com", "--cdp=9222"]))).toBe("bad_request");
  expect(await errorCode(() => t.act("auth", ["login", "github"]))).toBe("bad_request");
  expect(await errorCode(() => t.act("chat", ["hi"]))).toBe("bad_request");
  expect(await errorCode(() => t.act("plugin", ["add", "x"]))).toBe("bad_request");
  expect(await errorCode(() => t.act("open", ["file:///etc/passwd"]))).toBe("not_allowed");
  expect(await errorCode(() => t.act("open", ["FILE:///etc/passwd"]))).toBe("not_allowed");
  expect(await errorCode(() => t.act("open", ["view-source:file:///etc/passwd"]))).toBe("not_allowed");
  expect(await errorCode(() => t.act("goto", ["chrome://settings"]))).toBe("not_allowed");
  expect(await errorCode(() => t.act("tab", ["new", "File:///Users/x/.ssh/id_rsa"]))).toBe("not_allowed");
  expect(t.logged()).toHaveLength(0);
});

test.if(posix)("reads never start a browser: they say it isn't open", async () => {
  const t = setup();
  expect(await t.act("snapshot")).toMatchObject({ success: false, error: expect.stringContaining("isn't open") });
  // No Chrome started, and agent-browser never asked (it would launch one of its own).
  expect(t.chromes).toHaveLength(0);
  expect(t.logged()).toHaveLength(0);
  await t.act("open", ["https://shop.example.com"]);
  expect(await t.act("snapshot", ["-i"])).toMatchObject({ success: true, data: { snapshot: expect.any(String) } });
});

test.if(posix)(
  "a read right after a command that worked skips the open check; after an error it checks again",
  async () => {
    const t = setup();
    await t.act("open", ["https://shop.example.com"]);
    await t.act("snapshot");
    await t.act("snapshot");
    const commands = () => t.logged().map((c) => c.args.slice(-2).join(" "));
    expect(commands().filter((c) => c === "stream status")).toHaveLength(0);
    // A command that failed: the browser may be gone, so the next read asks first.
    await t.act("press", ["NoSuchKeyForTheFake"]).catch(() => undefined);
    await t.act("frame", ["x"]);
    await t.act("snapshot");
    expect(commands().filter((c) => c === "stream status")).toHaveLength(1);
  },
);

test.if(posix)("every snapshot names the page's unnamed icon buttons first", async () => {
  const t = setup();
  await t.act("open", ["https://shop.example.com"]);
  await t.act("snapshot", ["-i"]);
  const tail = t.logged().map((c) => c.args.slice(-2));
  expect(tail.at(-1)).toEqual(["snapshot", "-i"]);
  expect(tail.at(-2)).toEqual(["eval", NAME_CONTROLS]);
});

test("NAME_CONTROLS labels an icon button from its tooltip, and leaves named ones alone", () => {
  type Fake = {
    attrs: Record<string, string>;
    textContent: string;
    icon?: boolean;
    img?: boolean;
    shadowRoot?: { querySelectorAll: (s: string) => Fake[]; getElementById: (id: string) => unknown };
  };
  const el = (attrs: Record<string, string>, textContent = "", more: Partial<Fake> = {}): Fake => ({
    attrs,
    textContent,
    ...more,
  });
  const live = (e: Fake) =>
    Object.assign(e, {
      hasAttribute: (n: string) => n in e.attrs,
      getAttribute: (n: string) => e.attrs[n] ?? null,
      setAttribute: (n: string, v: string) => {
        e.attrs[n] = v;
      },
      querySelector: (s: string) => (s.includes("icon") && e.icon ? {} : s.startsWith("img") && e.img ? {} : null),
    });
  const described = el({ "aria-describedby": "tip1" });
  const ligature = el({ title: "Copy SHA-256" }, "content_copy", { icon: true });
  const tooltip = el({ "data-tooltip": "Download" });
  const words = el({ "data-tooltip": "Ignored" }, "Copy");
  const labeled = el({ "aria-label": "Close" });
  const picture = el({ title: "Ignored" }, "", { img: true });
  const nothing = el({});
  const inShadow = el({ materialtooltip: "Settings" });
  const host = el({}, "", {
    shadowRoot: { querySelectorAll: (s) => (s === "*" ? [] : [live(inShadow)]), getElementById: () => null },
  });
  const controls = [described, ligature, tooltip, words, labeled, picture, nothing].map(live);
  const document = {
    querySelectorAll: (s: string) => (s === "*" ? [host] : controls),
    getElementById: (id: string) => (id === "tip1" ? { textContent: " Copy  SHA-1 " } : null),
  };
  const named = new Function("document", `return ${NAME_CONTROLS}`)(document);
  expect(named).toBe(4);
  expect(described.attrs["aria-label"]).toBe("Copy SHA-1");
  expect(ligature.attrs["aria-label"]).toBe("Copy SHA-256");
  expect(tooltip.attrs["aria-label"]).toBe("Download");
  expect(inShadow.attrs["aria-label"]).toBe("Settings");
  expect(words.attrs["aria-label"]).toBeUndefined();
  expect(labeled.attrs["aria-label"]).toBe("Close");
  expect(picture.attrs["aria-label"]).toBeUndefined();
  expect(nothing.attrs["aria-label"]).toBeUndefined();
});

test("jpegSize reads a JPEG's frame header; captureMarks keeps only well-formed marks", () => {
  // SOI, an APP0 segment to skip, then SOF0 with 800 × 1280.
  const jpeg = Uint8Array.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x20, 0x05, 0x00, 0x03, 0, 0, 0,
    0, 0, 0,
  ]);
  expect(jpegSize(jpeg)).toEqual({ width: 1280, height: 800 });
  expect(jpegSize(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  expect(
    captureMarks([
      { ref: "@e2", number: 2, role: "link", box: { x: 1, y: 2, width: 3, height: 4 } },
      { ref: "not-a-ref", box: {} },
      "nope",
    ]),
  ).toEqual([{ ref: "e2", number: 2, role: "link", box: { x: 1, y: 2, width: 3, height: 4 } }]);
});

test.if(posix)(
  "a batch runs back to back in the agent's session and stops at a failure it doesn't tolerate",
  async () => {
    const t = setup();
    const res = await t.manager.batch(dev, await t.folder(), {
      op: "browser.batch",
      commands: [
        { command: "open", args: ["https://shop.example.com"], timeoutSeconds: 30 },
        // The fake knows neither: one tolerated, one not.
        { command: "fill", args: ["@e1", "x"], timeoutSeconds: 30, tolerate: true },
        { command: "snapshot", args: ["-c"], timeoutSeconds: 30 },
        { command: "press", args: ["Enter"], timeoutSeconds: 30 },
        { command: "click", args: ["@e1"], timeoutSeconds: 30 },
      ],
    });
    expect(res.answers.map((a) => a.success)).toEqual([true, false, true, false]);
    expect(res.answers[2]).toMatchObject({ data: { snapshot: '- button "Go" [ref=e1]' } });
    // The command after the failure never ran.
    expect(t.logged().some((c) => c.args.slice(-2).join(" ") === "click @e1")).toBe(false);
  },
);

test.if(posix)("a command that throws mid-batch keeps the answers of what already ran", async () => {
  const t = setup();
  const res = await t.manager.batch(dev, await t.folder(), {
    op: "browser.batch",
    commands: [
      { command: "open", args: ["https://shop.example.com"], timeoutSeconds: 30 },
      // Checked when it runs: a bad ref throws there.
      { command: "agentes:type_secret", args: ["not-a-ref", "X"], timeoutSeconds: 30 },
      { command: "snapshot", args: [], timeoutSeconds: 30 },
    ],
  });
  expect(res.answers.map((a) => a.success)).toEqual([true, false]);
  expect(res.answers[1]?.error).toContain("agentes:type_secret takes a ref");
});

test.if(posix)("a capture of a page outside the agent's sites is refused (like every read)", async () => {
  const t = setup();
  await t.act("open", ["https://shop.example.com"]);
  expect(await errorCode(async () => t.manager.capture(dev, await t.folder(), ["other.example"]))).toBe("not_allowed");
  expect(t.logged().some((c) => c.args.includes("--annotate"))).toBe(false);
});

test.if(posix)("a batch with one command that wouldn't pass is refused before anything runs", async () => {
  const t = setup();
  const folder = await t.folder();
  const batch = (commands: { command: string; args: string[] }[], allowedDomains?: string[]) =>
    errorCode(() =>
      t.manager.batch(dev, folder, {
        op: "browser.batch",
        commands: commands.map((c) => ({ ...c, timeoutSeconds: 30 })),
        ...(allowedDomains ? { allowedDomains } : {}),
      }),
    );
  expect(
    await batch(
      [
        { command: "open", args: ["https://shop.example.com"] },
        { command: "open", args: ["https://evil.example"] },
      ],
      ["shop.example.com"],
    ),
  ).toBe("not_allowed");
  expect(await batch([{ command: "open", args: ["https://x.com", "--profile", "Default"] }])).toBe("bad_request");
  expect(await batch([{ command: "chat", args: ["hi"] }])).toBe("bad_request");
  expect(await batch([])).toBe("bad_request");
  expect(t.logged()).toHaveLength(0);
});

test.if(posix)("capture: the page as a JPEG with its numbered elements, and the file gone at once", async () => {
  const t = setup();
  expect(await errorCode(async () => t.manager.capture(dev, await t.folder()))).toBe("bad_request");
  await t.act("open", ["https://shop.example.com"]);
  const shot = await t.manager.capture(dev, await t.folder());
  expect(shot).toMatchObject({
    width: 1280,
    height: 800,
    viewport: { width: 1280, height: 800 },
    url: "https://shop.example.com",
    marks: [{ ref: "e1", number: 1, role: "button", name: "Go", box: { x: 10, y: 20, width: 100, height: 40 } }],
  });
  expect([...Buffer.from(shot.data, "base64").subarray(0, 2)]).toEqual([0xff, 0xd8]);
  expect(readdirSync(path.join(await t.folder(), ".agentes", "captures"))).toEqual([]);
  const call = t.logged().find((c) => c.args.includes("--annotate"));
  expect(call?.args).toContain("jpeg");
});

test.if(posix)("the first screenshot works: its folder is made before", async () => {
  const t = setup();
  await t.act("open", ["https://shop.example.com"]);
  const res = await t.act("screenshot", ["screenshots/2026/first.png"]);
  expect(res).toMatchObject({ success: true });
  expect(existsSync(path.join(await t.folder(), "screenshots", "2026", "first.png"))).toBe(true);
  expect(existsSync(path.join(await t.folder(), "downloads"))).toBe(true);
});

test.if(posix)("the allowlist stops navigations before they go and pages that wander off after an action", async () => {
  const t = setup();
  const allowedDomains = ["shop.example.com"];
  expect(await errorCode(() => t.act("open", ["https://evil.com"], { allowedDomains }))).toBe("not_allowed");
  expect(await t.act("open", ["shop.example.com/login"], { allowedDomains })).toMatchObject({ success: true });
  t.page({ clickTo: "https://evil.com/phish" });
  const res = await t.act("click", ["@e1"], { allowedDomains });
  expect(res).toMatchObject({ success: false, error: expect.stringContaining("evil.com") });
  expect(t.logged().some((c) => c.args.at(-1) === "back")).toBe(true);
  expect(JSON.parse(readFileSync(process.env.FAKE_AB_STATE as string, "utf8")).url).toBe(
    "https://shop.example.com/login",
  );
});

test.if(posix)("with an allowlist, an off-list page is never read and never left open", async () => {
  const t = setup();
  const allowedDomains = ["shop.example.com"];
  await t.act("open", ["https://shop.example.com/"], { allowedDomains });
  // A script moved the page by itself: reading it is refused, and with no history to go back to it goes blank.
  t.page({ url: "https://evil.com/x", noHistory: true });
  const read = await t.act("snapshot", ["-c"], { allowedDomains });
  expect(read).toMatchObject({ success: false, error: expect.stringContaining("now blank") });
  expect(t.logged().some((c) => c.args.includes("snapshot"))).toBe(false);
  expect(JSON.parse(readFileSync(process.env.FAKE_AB_STATE as string, "utf8")).url).toBe("about:blank");
  // Switching to a new tab a link opened on another site: checked too, and blanked.
  t.page({ url: "https://shop.example.com/", tabTo: "https://evil.com/phish", noHistory: true });
  expect(await t.act("tab", ["1"], { allowedDomains })).toMatchObject({
    success: false,
    error: expect.stringContaining("evil.com"),
  });
  expect(JSON.parse(readFileSync(process.env.FAKE_AB_STATE as string, "utf8")).url).toBe("about:blank");
});

test.if(posix)("uploads and screenshots stay in the agent's folder", async () => {
  const t = setup();
  const folder = await t.folder();
  writeFileSync(path.join(folder, "logo.png"), "x");
  expect(await t.act("upload", ["@e2", "logo.png"])).toMatchObject({
    success: true,
    data: { files: [path.join(folder, "logo.png")] },
  });
  expect(await errorCode(() => t.act("upload", ["@e2", "../../etc/passwd"]))).toBe("outside_workspace");
  expect(await errorCode(() => t.act("screenshot", ["/tmp/out.png"]))).toBe("outside_workspace");
});

test.if(posix)("the per-machine cap refuses one browser too many", async () => {
  const t = setup({ maxSessions: 1 });
  await t.act("open", ["https://a.example"]);
  expect(await errorCode(() => t.act("open", ["https://b.example"], { agent: ops }))).toBe("browser_unavailable");
  await t.manager.stop(dev);
  expect(await t.act("open", ["https://b.example"], { agent: ops })).toMatchObject({ success: true });
});

test.if(posix)("a secret is typed through stdin into a password field only, and never comes back", async () => {
  const secret = "hunter2-very-secret";
  const t = setup({}, { SHOP_PASSWORD: secret });
  const typeSecret = (ref: string, name: string, site = "https://shop.example.com") =>
    t.act("agentes:type_secret", [ref, name, site]);
  await t.act("open", ["https://shop.example.com/login"]);
  expect(await typeSecret("@e3", "MISSING_ONE")).toMatchObject({
    success: false,
    error: expect.stringContaining("request_secret"),
  });
  t.page({ attrs: { "@e3": { type: "text", autocomplete: "username" }, "@e4": { type: "password" } } });
  expect(await typeSecret("@e3", "SHOP_PASSWORD")).toMatchObject({
    success: false,
    error: expect.stringContaining("isn't a password"),
  });
  const ok = await typeSecret("e4", "SHOP_PASSWORD");
  expect(ok).toEqual({ success: true, data: { typed: "SHOP_PASSWORD", into: "@e4" } });
  expect(JSON.stringify(ok)).not.toContain(secret);
  const calls = t.logged();
  expect(calls.some((c) => c.args.join(" ").includes(secret))).toBe(false);
  const batch = calls.find((c) => c.args.includes("batch"));
  expect(JSON.parse(batch?.stdin ?? "[]")).toEqual([["fill", "@e4", secret]]);
  // One-time codes count too.
  t.page({ attrs: { "@e5": { type: "text", autocomplete: "one-time-code" } } });
  expect(await typeSecret("@e5", "SHOP_PASSWORD")).toMatchObject({ success: true });
  expect(await errorCode(() => typeSecret("#password", "SHOP_PASSWORD"))).toBe("bad_request");
  // Only on the site it was asked for: another site (an injected page) never gets it.
  const typedBefore = t.logged().filter((c) => c.args.includes("batch")).length;
  expect(await typeSecret("e4", "SHOP_PASSWORD", "https://bank.example")).toMatchObject({
    success: false,
    error: expect.stringContaining("only for bank.example"),
  });
  expect(await errorCode(() => t.act("agentes:type_secret", ["e4", "SHOP_PASSWORD"]))).toBe("bad_request");
  expect(t.logged().filter((c) => c.args.includes("batch")).length).toBe(typedBefore);
});

test.if(posix)(
  "a site's password: out of every command's environment, typed only by the browser and only on its site",
  async () => {
    const secretsDir = path.join(tempDir("secrets-"), "secrets");
    dirs.push(path.dirname(secretsDir));
    const t = setup({ secret: (agent, name) => secretValue(secretsDir, agent, name) });
    const value = "hunter2-signed-in-for-real";
    // Delivered as the server does: sealed to the computer's key, bound to its site, then activated.
    const requestId = "req-site-0001";
    const target = { kind: "site" as const, site: "https://shop.example.com" };
    const keypair = await handleSecret(secretsDir, dev, t.ws, { action: "keypair", requestId });
    expect(keypair.sites).toBe(true);
    const aad = secretAad({ requestId, orgId: "org-1", name: "SHOP_PASSWORD", target });
    const box = await sealSecret(keypair.publicKey ?? "", value, aad);
    await handleSecret(secretsDir, dev, t.ws, {
      action: "deliver",
      requestId,
      name: "SHOP_PASSWORD",
      target,
      aad,
      box,
    });
    await handleSecret(secretsDir, dev, t.ws, {
      action: "activate",
      requestId,
      order: `2026-10-31T12:00:00.000Z|${requestId}`,
    });

    // The agent's commands never see it, by name or in their whole environment.
    const ctx = { workspaceReal: t.ws, exec: true, token: "agm_x", secretsDir };
    const scope: RequestScope = { signal: new AbortController().signal, output: () => {} };
    const ran = (await handleRequest(
      ctx,
      { agent: dev, op: "exec", command: 'echo "[$SHOP_PASSWORD]"; env', timeoutSeconds: 10, stream: false },
      scope,
    )) as { stdout: string };
    expect(ran.stdout.split("\n")[0]).toBe("[]");
    expect(ran.stdout).not.toContain(value);
    expect(ran.stdout).not.toContain("SHOP_PASSWORD");

    // The browser types it on its site.
    await t.act("open", ["https://shop.example.com/login"]);
    t.page({ attrs: { "@e4": { type: "password" } } });
    expect(await t.act("agentes:type_secret", ["e4", "SHOP_PASSWORD", "https://shop.example.com"])).toEqual({
      success: true,
      data: { typed: "SHOP_PASSWORD", into: "@e4" },
    });
    const batch = t.logged().find((c) => c.args.includes("batch"));
    expect(JSON.parse(batch?.stdin ?? "[]")).toEqual([["fill", "@e4", value]]);
    // A request naming another site never gets it, even with the page there: the person sealed it to this one.
    await t.act("open", ["https://bank.example/login"]);
    expect(await t.act("agentes:type_secret", ["e4", "SHOP_PASSWORD", "https://bank.example"])).toMatchObject({
      success: false,
      error: expect.stringContaining("only for shop.example.com"),
    });
    expect(t.logged().filter((c) => c.args.includes("batch"))).toHaveLength(1);
    // What the browser reads back (a field just typed into, a page that shows it) leaves the machine redacted.
    t.page({ attrs: { "@e4": { type: "text", autocomplete: "one-time-code", value } } });
    const browserCtx = { ...ctx, browser: t.manager };
    const act = (command: string, args: string[]) =>
      handleRequest(browserCtx, { agent: dev, op: "browser.act", command, args, timeoutSeconds: 5 }, scope);
    await act("open", ["https://shop.example.com/login"]);
    expect(await act("get", ["attr", "@e4", "value"])).toMatchObject({
      success: true,
      data: { value: "[secret:SHOP_PASSWORD]" },
    });
  },
);

test.if(posix)("stop closes the agent's browser and its Chrome; a second stop finds nothing", async () => {
  const t = setup();
  await t.act("open", ["https://a.example"]);
  expect(await t.manager.stop(dev)).toEqual({ stopped: true });
  expect(t.logged().at(-1)?.args.at(-1)).toBe("close");
  expect(t.chromes[0]?.killed).toBe(true);
  expect(JSON.parse(readFileSync(path.join(t.home, "browser", "chromes.json"), "utf8"))).toEqual([]);
  expect(await t.manager.stop(dev)).toEqual({ stopped: false });
  // The agent's own close stops its Chrome too; the next page starts a new one on the same profile.
  await t.act("open", ["https://a.example"]);
  expect(await t.act("close")).toMatchObject({ success: true });
  expect(t.chromes[1]?.killed).toBe(true);
  await t.act("open", ["https://b.example"]);
  expect(t.chromes).toHaveLength(3);
  expect(t.chromes[2]?.profile).toBe(t.chromes[0]?.profile);
});

test.if(posix)("an idle browser's Chrome stops, but not while someone watches or a help request is open", async () => {
  let now = 1_000_000;
  const t = setup({ now: () => now, idleMs: 60_000 });
  await t.act("open", ["https://a.example"]);
  await t.act("open", ["https://b.example"], { agent: ops });
  t.manager.setHandoff(ops.id, { status: "pending" });
  now += 61_000;
  await t.manager.sweep();
  expect(t.chromes[0]?.killed).toBe(true);
  expect(t.chromes[1]?.killed).toBe(false);
  t.manager.setHandoff(ops.id, null);
  await t.manager.sweep();
  expect(t.chromes[1]?.killed).toBe(true);
});

test.if(posix)(
  "a Chrome that updated itself restarts on the new version once idle, on the same page, once; never mid-task",
  async () => {
    let now = 1_000_000;
    let version = CHROME_VERSION;
    const logs: string[] = [];
    const t = setup({ now: () => now, chromeVersion: () => version, log: (l) => logs.push(l) });
    await t.act("open", ["https://a.example/"], { agent: ops });
    await t.act("open", ["https://shop.example/cart"]);
    const of = (agent: { id: string }) => t.chromes.filter((c) => c.profile.includes(agent.id.slice(0, 8)));
    expect(of(dev)).toHaveLength(1);
    // The update lands on disk; the runner reads the version again every few minutes.
    version = "157.0.8100.10";
    now += 60_000;
    await t.manager.sweep();
    expect(t.chromes).toHaveLength(2);
    // Read again 6 minutes on: an agent may pause that long mid-task (a build, a reply), so nothing restarts yet.
    now += 5 * 60_000;
    await t.manager.sweep();
    await Bun.sleep(50);
    expect(t.chromes).toHaveLength(2);
    // 11 minutes on: the agent idle since restarts; the one that just acted doesn't.
    now += 5 * 60_000;
    await t.act("click", ["@e1"], { agent: ops });
    await t.manager.sweep();
    await waitFor(() => of(dev).length === 2);
    const [before, after] = of(dev);
    expect(before?.killed || before?.closed).toBe(true);
    expect(after?.args.at(-1)).toBe("https://shop.example/cart");
    expect(after?.profile).toBe(before?.profile);
    expect(after?.args.find((a) => a.startsWith("--user-agent="))).toContain("Chrome/157.0.0.0");
    expect(logs).toContain(
      `the browser of agent-01a142cb restarts on Google Chrome 157.0.8100.10 (was ${CHROME_VERSION})`,
    );
    expect(of(ops)).toHaveLength(1);
    // A person's turn holds the other one off, however idle; the restart wasn't a use, so the first one's idle stop
    // still counts from its last command (once per version: it never restarted again).
    now += 60_000;
    t.manager.setHandoff(ops.id, { status: "pending" });
    now += 11 * 60_000;
    await t.manager.sweep();
    expect(of(dev)[1]?.killed || of(dev)[1]?.closed).toBe(true);
    expect(of(dev)).toHaveLength(2);
    expect(of(ops)).toHaveLength(1);
    // Their turn just over: the agent may carry on where they left it, so it doesn't restart then.
    t.manager.setHandoff(ops.id, null);
    await t.manager.sweep();
    await Bun.sleep(50);
    expect(of(ops)).toHaveLength(1);
    expect(of(ops)[0]?.killed || of(ops)[0]?.closed).toBe(false);
  },
);

test.if(posix)(
  "a help request forgotten on a dropped connection still holds its browser for the idle time",
  async () => {
    let now = 1_000_000;
    const t = setup({ now: () => now, idleMs: 60_000 });
    await t.act("open", ["https://b.example"], { agent: ops });
    now += 50_000;
    t.manager.setHandoff(ops.id, { status: "pending" });
    t.manager.clearHandoffs();
    now += 20_000;
    await t.manager.sweep();
    expect(t.chromes[0]?.killed).toBe(false);
    now += 41_000;
    await t.manager.sweep();
    expect(t.chromes[0]?.killed).toBe(true);
  },
);

test.if(posix)("while a help request is open, agent-browser's own idle timeout never comes", async () => {
  let now = 1_000_000;
  const t = setup({ now: () => now, idleMs: 300_000 });
  await t.act("open", ["https://b.example"]);
  t.manager.setHandoff(dev.id, { status: "pending" });
  const touches = () => t.logged().filter((c) => c.args.slice(-2).join(" ") === "stream status").length;
  now += 100_000;
  await t.manager.sweep();
  expect(touches()).toBe(0);
  now += 100_000;
  await t.manager.sweep();
  expect(touches()).toBe(1);
  // Touched: not again until it nears the timeout once more.
  now += 60_000;
  await t.manager.sweep();
  expect(touches()).toBe(1);
  expect(t.chromes[0]?.killed).toBe(false);
});

test.if(posix)(
  "a watched page's frames don't hold off agent-browser's own idle timeout under a help request",
  async () => {
    let now = 1_000_000;
    const t = setup({ now: () => now, idleMs: 300_000 });
    await t.act("open", ["https://b.example"]);
    t.manager.setHandoff(dev.id, { status: "pending" });
    await t.manager.streamStart(dev, "watch");
    const touches = () => t.logged().filter((c) => c.args.slice(-2).join(" ") === "stream status").length;
    const before = touches();
    const frame = (seq: number) =>
      t.sockets[0]?.push({ type: "frame", seq, data: "/9j/A", metadata: { deviceWidth: 1280, deviceHeight: 720 } });
    now += 150_000;
    frame(1);
    await t.manager.sweep();
    expect(touches()).toBe(before);
    // Frames kept coming (a spinner), but agent-browser got no command for nearly its timeout.
    now += 100_000;
    frame(2);
    await t.manager.sweep();
    expect(touches()).toBe(before + 1);
  },
);

test.if(posix)(
  "under an open help request, a view after agent-browser let go of Chrome opens the page again",
  async () => {
    const t = setup();
    await t.act("open", ["https://shop.example.com/login"], { allowedDomains: ["shop.example.com"] });
    t.manager.setHandoff(dev.id, { status: "pending", request: "Sign in" });
    t.page({ open: false });
    expect(await t.manager.streamStart(dev, "watch")).toEqual({ mode: "watch" });
    expect(t.logged().some((c) => c.args.slice(-2).join(" ") === "open https://shop.example.com/login")).toBe(true);
    await t.manager.streamStop(dev);
    // No request open: it says the browser is closed.
    t.manager.setHandoff(dev.id, null);
    t.page({ open: false });
    expect(await errorCode(() => t.manager.streamStart(dev, "watch"))).toBe("browser_closed");
  },
);

test.if(posix)(
  "a browser reopened for a help request never goes back to a page off the agent's allowed sites",
  async () => {
    const t = setup();
    await t.act("open", ["https://shop.example.com/login"], { allowedDomains: ["shop.example.com"] });
    // The page moved off the sites (a redirect seen in the live view), then Chrome crashed.
    t.manager.setHandoff(dev.id, { status: "pending", request: "Sign in" });
    await t.manager.streamStart(dev, "watch");
    t.sockets[0]?.push({ type: "url", url: "https://evil.example/x" });
    await t.manager.streamStop(dev);
    t.chromes[0]?.close();
    await new Promise((r) => setTimeout(r, 0));
    expect(await t.manager.streamStart(dev, "watch")).toEqual({ mode: "watch" });
    const opens = t
      .logged()
      .filter((c) => c.args.at(-2) === "open")
      .map((c) => c.args.at(-1));
    expect(opens).toEqual(["https://shop.example.com/login", "about:blank"]);
  },
);

test.if(posix)(
  "a browser that closed under an open help request opens again on its last page for the view",
  async () => {
    const t = setup();
    await t.act("open", ["https://shop.example.com/login"]);
    t.manager.setHandoff(dev.id, { status: "pending", request: "Sign in" });
    t.chromes[0]?.close();
    await new Promise((r) => setTimeout(r, 0));
    expect(await t.manager.streamStart(dev, "watch")).toEqual({ mode: "watch" });
    expect(t.chromes).toHaveLength(2);
    expect(t.logged().some((c) => c.args.slice(-2).join(" ") === "open https://shop.example.com/login")).toBe(true);
    await t.manager.streamStop(dev);
    // With no request open, a closed browser stays closed: the view says so.
    t.manager.setHandoff(dev.id, null);
    t.chromes[1]?.close();
    await new Promise((r) => setTimeout(r, 0));
    expect(await errorCode(() => t.manager.streamStart(dev, "watch"))).toBe("browser_closed");
  },
);

test.if(posix)(
  "a site's session (kept only until the browser closes) outlives an idle stop, and the last tabs don't come back",
  async () => {
    let now = 1_000_000;
    const t = setup({ now: () => now, idleMs: 60_000 });
    await t.act("open", ["https://shop.example.com/login"]);
    const profile = t.chromes[0]?.profile ?? "";
    // Signed in without "remember me": a session cookie. Chrome saved its tabs meanwhile too.
    mkdirSync(path.join(profile, "Default", "Sessions"), { recursive: true });
    writeFileSync(
      path.join(profile, "Default", "cookies.json"),
      JSON.stringify([{ name: "shop_session", session: true }, { name: "shop_prefs" }]),
    );
    writeFileSync(
      path.join(profile, "Default", "Sessions", "tabs.json"),
      JSON.stringify(["https://shop.example.com/cart", "https://shop.example.com/orders"]),
    );
    now += 61_000;
    await t.manager.sweep();
    expect(t.chromes[0]?.killed).toBe(true);

    await t.act("open", ["https://shop.example.com/orders"]);
    expect(t.chromes).toHaveLength(2);
    expect(t.chromes[1]?.profile).toBe(profile);
    expect(t.chromes[1]?.cookies).toEqual(["shop_session", "shop_prefs"]);
    // One page, as before: the agent's command goes on it.
    expect(t.chromes[1]?.tabs).toEqual([expect.stringMatching(/^file:\/\/.+\/agentes-start\.html$/)]);
  },
);

test.if(posix)(
  "a stop asks Chrome to close itself first, so its last cookies reach the profile; one that stays is killed",
  async () => {
    const devtools = fakeDevtools([]);
    try {
      const chromes = chromesAt(devtools);
      const t = setup({ startChrome: chromes.start });
      await t.act("open", ["https://shop.example.com/"]);
      await t.manager.stop(dev);
      expect(devtools.asked).toContain("Browser.close");
      expect(chromes.started[0]).toMatchObject({ closed: true, killed: false });

      // A Chrome that doesn't close (hung) is signaled after a while.
      devtools.closing.on = () => {};
      await t.act("open", ["https://shop.example.com/again"]);
      const at = Date.now();
      await t.manager.stop(dev);
      expect(chromes.started[1]).toMatchObject({ closed: false, killed: true });
      expect(Date.now() - at).toBeGreaterThanOrEqual(1900);
    } finally {
      devtools.stop();
    }
  },
);

test.if(posix)(
  "the runner stopping stops its Chromes; one a crashed run left is stopped on the next start",
  async () => {
    const t = setup();
    await t.act("open", ["https://a.example"]);
    await t.manager.close();
    expect(t.chromes[0]?.killed).toBe(true);

    // A leftover in chromes.json: stopped only when it is still that Chrome (a reused pid is left alone).
    const home = tempDir("runner-home-");
    dirs.push(home);
    mkdirSync(path.join(home, "browser"), { recursive: true });
    writeFileSync(
      path.join(home, "browser", "chromes.json"),
      JSON.stringify([
        { pid: 999_999_901, profile: "/x/.agentes/browser" },
        { pid: 999_999_902, profile: "/y/.agentes/browser" },
      ]),
    );
    const asked: number[] = [];
    const manager = new BrowserManager({
      home,
      log: () => {},
      send: () => true,
      secret: async () => null,
      command: [process.execPath, FAKE],
      chrome: () => null,
      isOurChrome: async (pid) => {
        asked.push(pid);
        return false;
      },
    });
    await manager.closeAll();
    expect(asked).toEqual([999_999_901, 999_999_902]);
    expect(JSON.parse(readFileSync(path.join(home, "browser", "chromes.json"), "utf8"))).toEqual([]);
  },
);

test.if(posix)("a command while the browsers close (a runner that just started) starts its Chrome after", async () => {
  const chromes = fakeChromes();
  let closing = true;
  const startedWhileClosing: boolean[] = [];
  const t = setup({
    startChrome: (exe, args, profile) => {
      startedWhileClosing.push(closing);
      return chromes.start(exe, args, profile);
    },
  });
  const closed = t.manager.closeAll().then(() => {
    closing = false;
  });
  expect(await t.act("open", ["https://a.example/"])).toMatchObject({ success: true });
  await closed;
  expect(startedWhileClosing).toEqual([false]);
  expect(t.logged().map((l) => l.args.at(-1))).toEqual(["--all", "https://a.example/"]);
});

test.if(posix)(
  "no Google Chrome: the agent is told plainly what to do, nothing is installed, and a Chrome installed later just works",
  async () => {
    let installed = false;
    const t = setup({ chrome: () => (installed ? CHROME_EXE : null) });
    const folder = await t.folder();
    const open = () =>
      t.manager.act(dev, folder, { op: "browser.act", command: "open", args: ["https://a/"], timeoutSeconds: 30 });
    const err = await open().then(
      () => null,
      (e: unknown) => e as { code?: string; message?: string },
    );
    // On Linux on ARM the agent is told to install Chromium instead (ADR 0153), read as missing all the same.
    const missing = usesChromium() ? CHROME_FAILURES.missingChromium : CHROME_FAILURES.missing;
    expect(err).toMatchObject({ code: "browser_unavailable", message: missing });
    expect(chromeFailureKind(err?.message ?? "")).toBe("missing");
    // No Chrome for Testing fallback: agent-browser is never asked to install one, and no Chrome started.
    expect(t.logged().some((l) => l.args.includes("install"))).toBe(false);
    expect(t.chromes).toHaveLength(0);
    // The computer says it can browse (so the agent tries, and tells), and that Chrome is missing (the server tells
    // the person once).
    expect(t.manager.info()).toEqual({ available: true, version: AGENT_BROWSER_VERSION, chromeMissing: true });
    installed = true;
    expect(await open()).toMatchObject({ success: true });
    expect(t.manager.info()).toMatchObject({ available: true, chrome: `Google Chrome ${CHROME_VERSION}` });
    expect(t.manager.info().chromeMissing).toBeUndefined();
    // In system mode root installs Chrome: the installer is what to run again.
    const root = setup({ chrome: () => null, installedByRoot: true });
    expect(await errorCode(() => root.act("open", ["https://a/"]))).toBe("browser_unavailable");
    const said = await root.act("open", ["https://a/"]).catch((e: Error) => e.message);
    expect(said).toBe(CHROME_FAILURES.missingServer);
    expect(chromeFailureKind(CHROME_FAILURES.missingServer)).toBe("missing");
  },
);

test.if(posix)(
  "a Chrome that won't start, or whose profile won't open, is told in plain words; Chrome's own output stays in the log",
  async () => {
    const lines: string[] = [];
    let failure = new ChromeStartError("Chrome closed while starting", "[1:1:ERROR] some crash text");
    const t = setup({
      log: (l) => lines.push(l),
      startChrome: async () => {
        throw failure;
      },
    });
    const said = () => t.act("open", ["https://a/"]).catch((e: { code: string; message: string }) => e);
    expect(await said()).toMatchObject({ code: "browser_unavailable", message: CHROME_FAILURES.start });
    expect(lines.join("\n")).toContain("[1:1:ERROR] some crash text");
    failure = new ChromeStartError("Chrome closed while starting (another Chrome is using this profile)", "", [], true);
    expect(await said()).toMatchObject({ code: "browser_unavailable", message: CHROME_FAILURES.profile });
    expect(chromeFailureKind(CHROME_FAILURES.profile)).toBe("profile");
    failure = new ChromeStartError("libs", "", ["libnss3.so"]);
    const libs = (await said()) as { message: string };
    expect(libs.message).toStartWith(`${CHROME_FAILURES.start} This computer is missing system libraries`);
    expect(chromeFailureKind(libs.message)).toBe("start");
    // Anything else of the browser's (a busy computer) isn't a Chrome failure.
    expect(chromeFailureKind("This computer already has 8 browsers open (its limit).")).toBeNull();
  },
);

test.if(posix)(
  "a Chrome a major version older than the one that last ran on the agent's profile doesn't start on it, and says so",
  async () => {
    const t = setup({ chromeVersion: () => "155.0.7000.1" });
    const folder = await t.folder();
    const prefs = path.join(folder, ".agentes", "browser", "Default", "Preferences");
    mkdirSync(path.dirname(prefs), { recursive: true });
    const lastRan = (version: string) =>
      writeFileSync(prefs, JSON.stringify({ extensions: { last_chrome_version: version } }));
    const open = () =>
      t.manager
        .act(dev, folder, { op: "browser.act", command: "open", args: ["https://a/"], timeoutSeconds: 30 })
        .catch((e: { code: string; message: string }) => e);
    lastRan("156.0.8078.80");
    const err = (await open()) as { code: string; message: string };
    expect(err).toMatchObject({ code: "browser_unavailable", message: CHROME_FAILURES.outdated });
    expect(chromeFailureKind(err.message)).toBe("outdated");
    expect(t.chromes).toHaveLength(0);
    // Older within its major version (Chrome for Testing 156.0.8078.80 to Google Chrome 156.0.8078.79): it starts.
    lastRan("155.0.7100.0");
    expect(await open()).toMatchObject({ success: true });
  },
);

/** The agent's desktop as the browser sees it, starting in `startMs`. */
function fakeDesktop(startMs = 0): NonNullable<BrowserManagerOptions["desktops"]> {
  return {
    async ensure() {
      await sleep(startMs);
      return { display: 21, width: 1280, height: 900, startedAt: new Date(0).toISOString(), started: true };
    },
    session: () => ({ display: 21, xauthority: "/runner/desktop/01a142cb/Xauthority" }),
    status: () => ({ running: true, streams: 0 }),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const headless = (c?: FakeChrome) => !!c?.args.includes("--headless=new");

test.if(posix)(
  "an agent whose folder moved (its handle changed) gets a session there, not one in the old folder",
  async () => {
    const t = setup();
    const old = await t.folder();
    expect(
      await t.manager.act(dev, old, { op: "browser.act", command: "open", args: ["https://a/"], timeoutSeconds: 30 }),
    ).toMatchObject({ success: true });
    // The handle changed: its folder is renamed, and the next request names the new one.
    const moved = path.join(path.dirname(old), "renamed-agent");
    renameSync(old, moved);
    expect(
      await t.manager.act(dev, moved, { op: "browser.act", command: "open", args: ["https://b/"], timeoutSeconds: 30 }),
    ).toMatchObject({ success: true });
    const last = t
      .logged()
      .filter((l) => l.args.includes("https://b/"))
      .at(-1);
    expect(last?.cwd).toBe(moved);
    expect(t.chromes.at(-1)?.args).toContain(`--user-data-dir=${path.join(moved, ".agentes", "browser")}`);
  },
);

test.if(posix)("Ubuntu's snap Chromium on a desktop: a copy of its Xauthority it can read, the agent's alone", () => {
  const home = tempDir("xauth-");
  dirs.push(home);
  const source = path.join(home, ".agentes-runner", "desktop", "d1", "Xauthority");
  mkdirSync(path.dirname(source), { recursive: true });
  writeFileSync(source, "cookie 1", { mode: 0o600 });
  const folder = path.join(home, "agentes", "plano");
  const on = readableDisplay({ display: 7, xauthority: source }, folder);
  expect(on).toEqual({ display: 7, xauthority: path.join(folder, ".agentes", "Xauthority") });
  expect(readFileSync(on.xauthority, "utf8")).toBe("cookie 1");
  expect(statSync(on.xauthority).mode & 0o777).toBe(0o600);
  // The desktop started again with a new cookie: the next start copies it again.
  writeFileSync(source, "cookie 2");
  expect(readFileSync(readableDisplay({ display: 7, xauthority: source }, folder).xauthority, "utf8")).toBe("cookie 2");
});

test.if(posix)(
  "Ubuntu's snap Chromium: the start page goes in the agent's own folder, which the snap can read (ADR 0153)",
  async () => {
    const snap = setup({ chrome: () => "/snap/bin/chromium" });
    const folder = await snap.folder();
    await snap.manager.warm(dev, folder, false);
    const page = new URL(snap.chromes[0]?.args.at(-1) ?? "");
    expect(page.protocol).toBe("file:");
    expect(decodeURIComponent(page.pathname)).toBe(path.join(folder, ".agentes", "start", "agentes-start.html"));
    expect(existsSync(path.join(folder, ".agentes", "start", "agentes-start.html"))).toBe(true);
    // Any other browser keeps it under the runner's home, out of the agent's folder.
    const other = setup();
    const otherFolder = await other.folder();
    await other.manager.warm(dev, otherFolder, false);
    const kept = decodeURIComponent(new URL(other.chromes[0]?.args.at(-1) ?? "").pathname);
    expect(kept.startsWith(path.join(other.home, "start"))).toBe(true);
    expect(existsSync(path.join(otherFolder, ".agentes", "start"))).toBe(false);
  },
);

test.if(posix)(
  "warm: the agent's Chrome starts ahead, once, on a blank page, without agent-browser or a stream",
  async () => {
    const t = setup({ maxSessions: 4 });
    const folder = await t.folder();
    const twice = await Promise.all([t.manager.warm(dev, folder, false), t.manager.warm(dev, folder, false)]);
    expect(twice.map((w) => w.started).sort()).toEqual([false, true]);
    expect(t.chromes).toHaveLength(1);
    expect(headless(t.chromes[0])).toBe(true);
    expect(t.chromes[0]?.args.at(-1)).toMatch(/^file:\/\/.+\/agentes-start\.html$/);
    expect(t.logged()).toEqual([]);
    expect(t.sockets).toHaveLength(0);
    expect(t.frames).toEqual([]);
    // Not the agent using its browser: the desktop app's tray shows nothing yet.
    expect(t.manager.states()).toEqual([]);
    // Running: nothing more. The agent's first command connects to that Chrome.
    expect(await t.manager.warm(dev, folder, false)).toEqual({ started: false });
    expect(await t.act("open", ["https://a.example/"])).toMatchObject({ success: true });
    expect(t.chromes).toHaveLength(1);
    expect(t.manager.states().map((s) => s.agentId)).toEqual([dev.id]);
  },
);

test.if(posix)(
  "a command that comes while its Chrome starts ahead waits for it in the queue, and starts none",
  async () => {
    const chromes = fakeChromes();
    const t = setup({
      maxSessions: 4,
      startChrome: async (exe, args, profile) => {
        await sleep(30);
        return chromes.start(exe, args, profile);
      },
    });
    const folder = await t.folder();
    const [warmed, opened] = await Promise.all([t.manager.warm(dev, folder, false), t.act("open", ["https://a/"])]);
    expect(warmed.started).toBe(true);
    expect(warmed.setup?.launch).toBeGreaterThanOrEqual(20);
    expect(opened).toMatchObject({ success: true });
    expect(opened.setup?.queued).toBeGreaterThanOrEqual(20);
    expect(opened.setup?.launch).toBeUndefined();
    expect(chromes.started).toHaveLength(1);
  },
);

test.if(posix)(
  "warm starts nothing while a person has the browser, while Chrome runs, or into the computer's last free browser",
  async () => {
    const t = setup({ maxSessions: 2, desktops: fakeDesktop() });
    const folder = await t.folder();
    t.manager.setHandoff(dev.id, { status: "pending", request: "Sign in" });
    expect(await t.manager.warm(dev, folder, false)).toEqual({ started: false });
    t.manager.setHandoff(dev.id, { status: "active", controller: "Ana" });
    expect(await t.manager.warm(dev, folder, false)).toEqual({ started: false });
    expect(t.chromes).toHaveLength(0);
    t.manager.setHandoff(dev.id, null);
    // Another agent's browser is open: this one would take the last of two.
    await t.act("open", ["https://a.example/"], { agent: ops });
    expect(await t.manager.warm(dev, folder, false)).toEqual({ started: false });
    expect(t.chromes).toHaveLength(1);
    // A command still takes it; once its session is open, a warm takes nothing more (and Chrome runs: none).
    expect(await t.act("open", ["https://b.example/"])).toMatchObject({ success: true });
    expect(await t.manager.warm(dev, folder, true)).toEqual({ started: false });
    expect(t.chromes).toHaveLength(2);
    // On its desktop, where the server says it belongs: headed there.
    await t.manager.stop(dev);
    await t.manager.stop(ops);
    expect(await t.manager.warm(dev, folder, true)).toMatchObject({ started: true });
    expect(headless(t.chromes[2])).toBe(false);
    expect(t.chromes[2]?.args).toContain("--start-maximized");
  },
);

test.if(posix)(
  "a command says what it waited on: the first, getting the browser ready, its desktop and its Chrome; the next nothing",
  async () => {
    const chromes = fakeChromes();
    const t = setup({
      startChrome: async (exe, args, profile) => {
        await sleep(25);
        return chromes.start(exe, args, profile);
      },
      desktops: fakeDesktop(25),
    });
    const folder = await t.folder();
    const act = (command: string, args: string[]) =>
      t.manager.act(dev, folder, { op: "browser.act", command, args, timeoutSeconds: 30, desktop: true });
    const first = await act("open", ["https://a.example/"]);
    expect(first).toMatchObject({ success: true });
    expect(Object.keys(first.setup ?? {}).sort()).toEqual(["desktop", "launch"]);
    for (const ms of Object.values(first.setup ?? {})) expect(ms).toBeGreaterThanOrEqual(10);
    expect((await act("click", ["@e1"])).setup).toBeUndefined();
    // A batch says it too; the runner's log puts it in words.
    await t.manager.stop(dev);
    const batch = await t.manager.batch(dev, folder, {
      op: "browser.batch",
      commands: [{ command: "open", args: ["https://b.example/"], timeoutSeconds: 30 }],
      desktop: true,
    });
    expect(batch.setup?.desktop).toBeGreaterThanOrEqual(10);
    expect(batch.setup?.launch).toBeGreaterThanOrEqual(10);
    expect(browserSetupText({ install: 28_140, desktop: 2300, launch: 1400 })).toBe(
      "install 28.1 s, desktop 2.3 s, launch 1.4 s",
    );
  },
);

test.if(posix)(
  "outside system mode agent-browser gets ready as the runner starts: one that fails says nothing against the browser",
  async () => {
    const home = tempDir("runner-home-");
    dirs.push(home);
    const failing = new BrowserManager({
      home,
      log: () => {},
      send: () => true,
      secret: async () => null,
      command: ["/bin/sh", "-c", ":"],
      chrome: () => null,
      userHome: home,
    });
    await failing.prepareInBackground();
    expect(failing.info()).toMatchObject({ available: true });
  },
);

// ── Live view ────────────────────────────────────────────────────────────────

test.if(posix)("the stream relays frames with the page's URL, changes mode, and ends with a frame", async () => {
  const t = setup();
  expect(await errorCode(() => t.manager.streamStart(dev, "watch"))).toBe("browser_closed");
  await t.act("open", ["https://shop.example.com"]);
  expect(await t.manager.streamStart(dev, "watch")).toEqual({ mode: "watch" });
  const socket = t.sockets[0] as FakeSocket;
  // One frame at a time, each once the last is acknowledged (ADR 0040 §7.1).
  expect(socket.url).toBe("ws://127.0.0.1:41234/?pacing=ack&maxFps=5");
  socket.push({ type: "url", url: "https://shop.example.com/cart" });
  socket.push({
    type: "frame",
    seq: 7,
    data: "/9j/AAA",
    metadata: { deviceWidth: 1280, deviceHeight: 720, pageScaleFactor: 1 },
  });
  socket.push({ type: "frame", seq: 8, data: "/9j/AAA", metadata: {} }); // no size: dropped
  expect(t.frames).toEqual([
    {
      type: "browser.frame",
      agentId: dev.id,
      seq: 7,
      data: "/9j/AAA",
      metadata: {
        deviceWidth: 1280,
        deviceHeight: 720,
        pageScaleFactor: 1,
        capturedAt: expect.any(Number),
        url: "https://shop.example.com/cart",
      },
    },
  ]);
  expect(await t.manager.streamStart(dev, "control")).toEqual({ mode: "control" });
  expect(t.sockets).toHaveLength(1);
  // Each frame acknowledged, the one dropped too (nothing comes after it until it is).
  expect(socket.sent).toEqual([
    { type: "ack", seq: 7 },
    { type: "ack", seq: 8 },
    { type: "config", pacing: "ack", maxFps: 15 },
  ]);
  expect(await t.manager.streamStop(dev)).toEqual({ stopped: true });
  expect(socket.closed).toBe(true);
  expect(t.frames.at(-1)).toEqual({ type: "browser.stream.ended", agentId: dev.id, reason: "stopped" });
  expect(await t.manager.streamStop(dev)).toEqual({ stopped: false });
});

test.if(posix)("system mode refuses an agent-browser stream that fell back to an unassigned port", async () => {
  const t = setup({ fixedPorts: { cdp: 12000, stream: 12001 } });
  await t.act("open", ["https://shop.example.com"]);
  expect(t.chromes[0]?.args).toContain("--remote-debugging-port=12000");
  expect(await errorCode(() => t.manager.streamStart(dev, "watch"))).toBe("browser_unavailable");
  expect(t.sockets).toHaveLength(0);
});

test.if(posix)("a stream can't start on a closed browser, never opened or closed since: browser_closed", async () => {
  const t = setup();
  expect(await errorCode(() => t.manager.streamStart(dev, "watch"))).toBe("browser_closed");
  await t.act("open", ["https://shop.example.com"]);
  await t.act("close");
  expect(await errorCode(() => t.manager.streamStart(dev, "control"))).toBe("browser_closed");
  expect(t.sockets).toHaveLength(0);
  // Opening a page (the agent, or a person in control) starts it again, and it streams.
  await t.act("open", ["https://shop.example.com"]);
  expect(await t.manager.streamStart(dev, "watch")).toEqual({ mode: "watch" });
  await t.manager.streamStop(dev);
});

test.if(posix)(
  "an idle page shows at once: a stream with no frame sends one screenshot, with the tab's address and title",
  async () => {
    const t = setup({ firstFrameMs: 5 });
    await t.act("open", ["https://shop.example.com"]);
    await t.manager.streamStart(dev, "watch");
    const socket = t.sockets[0] as FakeSocket;
    // What the stream says on connect: the page's size, then the tabs (the active one's title).
    socket.push({ type: "status", connected: true, viewportWidth: 1280, viewportHeight: 720 });
    socket.push({
      type: "tabs",
      tabs: [
        { url: "https://x.example/", title: "X", active: false },
        { url: "https://shop.example.com/", title: "Loja", active: true },
      ],
    });
    await waitFor(() => t.frames.some((f) => f.type === "browser.frame"));
    expect(t.frames[0]).toEqual({
      type: "browser.frame",
      agentId: dev.id,
      seq: 0,
      data: expect.stringMatching(/^\/9j\//), // the JPEG the fake writes for a .jpg
      metadata: {
        deviceWidth: 1280,
        deviceHeight: 720,
        capturedAt: expect.any(Number),
        url: "https://shop.example.com/",
        title: "Loja",
      },
    });
    const shot = t.logged().find((c) => c.args.includes("screenshot"));
    expect(shot?.args.slice(-6)).toEqual([
      "screenshot",
      path.join(t.home, "browser", "agent-01a142cb-frame.jpg"),
      "--screenshot-format",
      "jpeg",
      "--screenshot-quality",
      "70",
    ]);
    // The screenshot is removed after the frame goes out, not before.
    await waitFor(() => !existsSync(path.join(t.home, "browser", "agent-01a142cb-frame.jpg")));
    // Another page: frames carry its address; its title comes with the next tab list.
    socket.push({ type: "url", url: "https://shop.example.com/cart" });
    socket.push({ type: "frame", seq: 3, data: "/9j/B", metadata: { deviceWidth: 1280, deviceHeight: 720 } });
    expect(t.frames.at(-1)).toEqual({
      type: "browser.frame",
      agentId: dev.id,
      seq: 3,
      data: "/9j/B",
      metadata: {
        deviceWidth: 1280,
        deviceHeight: 720,
        capturedAt: expect.any(Number),
        url: "https://shop.example.com/cart",
      },
    });
    await t.manager.streamStop(dev);
  },
);

test.if(posix)("a page that repaints by itself gets no screenshot", async () => {
  const t = setup({ firstFrameMs: 5 });
  await t.act("open", ["https://shop.example.com"]);
  await t.manager.streamStart(dev, "watch");
  const socket = t.sockets[0] as FakeSocket;
  socket.push({ type: "status", connected: true, viewportWidth: 1280, viewportHeight: 720 });
  socket.push({ type: "frame", seq: 1, data: "/9j/A", metadata: { deviceWidth: 1280, deviceHeight: 720 } });
  await Bun.sleep(40);
  expect(t.logged().some((c) => c.args.includes("screenshot"))).toBe(false);
  expect(t.frames.filter((f) => f.type === "browser.frame")).toHaveLength(1);
  await t.manager.streamStop(dev);
});

test.if(posix)(
  "a start on a stream already running sends the page again: a server that lost it gets it even for an idle page",
  async () => {
    const t = setup({ firstFrameMs: 5 });
    await t.act("open", ["https://facebook.com/login"]);
    await t.manager.streamStart(dev, "watch");
    const socket = t.sockets[0] as FakeSocket;
    socket.push({ type: "status", connected: true, viewportWidth: 1280, viewportHeight: 720 });
    const pages = () => t.frames.filter((f) => f.type === "browser.frame").length;
    await waitFor(() => pages() === 1);
    // The server asks again (a new process after a deploy, a watch again after its stop failed): same mode.
    expect(await t.manager.streamStart(dev, "watch")).toEqual({ mode: "watch" });
    await waitFor(() => pages() === 2);
    // And when a person takes control.
    expect(await t.manager.streamStart(dev, "control")).toEqual({ mode: "control" });
    await waitFor(() => pages() === 3);
    expect(t.sockets).toHaveLength(1);
    await t.manager.streamStop(dev);
  },
);

test.if(posix)("two starts at once open one socket; a stop sent meanwhile closes it", async () => {
  const t = setup();
  await t.act("open", ["https://shop.example.com"]);
  const [a, b] = await Promise.all([t.manager.streamStart(dev, "watch"), t.manager.streamStart(dev, "control")]);
  expect(a).toEqual({ mode: "watch" });
  expect(b).toEqual({ mode: "control" });
  expect(t.sockets).toHaveLength(1);
  expect((t.sockets[0] as FakeSocket).sent).toEqual([{ type: "config", pacing: "ack", maxFps: 15 }]);
  await t.manager.streamStop(dev);
  const opening = t.manager.streamStart(dev, "watch");
  const stopped = t.manager.streamStop(dev);
  await opening;
  expect(await stopped).toEqual({ stopped: true });
  expect(t.sockets).toHaveLength(2);
  expect((t.sockets[1] as FakeSocket).closed).toBe(true);
});

test.if(posix)("a stream that closes on the machine says so; one dropped with the connection doesn't", async () => {
  const t = setup();
  await t.act("open", ["https://shop.example.com"]);
  await t.manager.streamStart(dev, "watch");
  (t.sockets[0] as FakeSocket).close();
  expect(t.frames.at(-1)).toEqual({ type: "browser.stream.ended", agentId: dev.id, reason: "closed" });
  await t.manager.streamStart(dev, "watch");
  const count = t.frames.length;
  t.manager.stopStreams();
  expect((t.sockets[1] as FakeSocket).closed).toBe(true);
  expect(t.frames).toHaveLength(count);
});

test("a frame's capture time: epoch seconds as CDP gives it, or milliseconds; never another clock", () => {
  expect(captureTime(1_762_300_000.25)).toBe(1_762_300_000_250);
  expect(captureTime(1_762_300_000_250)).toBe(1_762_300_000_250);
  // Seconds since the browser started, or nothing usable.
  expect(captureTime(12_345.6)).toBeNull();
  expect(captureTime(undefined)).toBeNull();
  expect(captureTime("1762300000")).toBeNull();
  expect(captureTime(Number.NaN)).toBeNull();
  expect(captureTime(-1)).toBeNull();
});

test.if(posix)(
  "pacing: agent-browser's next frame comes once there is room for it; a start or a skipped frame never hold it",
  async () => {
    let room = true;
    const t = setup({ frameRoom: () => room, sourceAckMs: 60_000 });
    await t.act("open", ["https://shop.example.com"]);
    await t.manager.streamStart(dev, "watch");
    const socket = t.sockets[0] as FakeSocket;
    const acks = () => socket.sent.filter((m) => m.type === "ack").map((m) => m.seq);
    const size = { deviceWidth: 1280, deviceHeight: 720 };
    const frame = (seq: number, metadata: Record<string, unknown> = {}) =>
      socket.push({ type: "frame", seq, data: "/9j/A", metadata: { ...size, ...metadata } });
    frame(1);
    expect(acks()).toEqual([1]);
    // No room: acknowledged only when there is.
    room = false;
    frame(2);
    expect(acks()).toEqual([1]);
    t.manager.room("someone-else");
    expect(acks()).toEqual([1]);
    t.manager.room(dev.id);
    expect(acks()).toEqual([1, 2]);
    // Nothing waits: room says nothing more.
    t.manager.room(dev.id);
    expect(acks()).toEqual([1, 2]);
    // A start again (the server's new view, or none) never leaves a frame waiting.
    frame(3);
    expect(await t.manager.streamStart(dev, "control")).toEqual({ mode: "control" });
    expect(acks()).toEqual([1, 2, 3]);
    // A frame that isn't relayed is acknowledged all the same.
    socket.push({ type: "frame", seq: 4, data: "/9j/A", metadata: {} });
    expect(acks()).toEqual([1, 2, 3, 4]);
    // Frames say when Chrome captured them.
    frame(5, { timestamp: 1_762_300_000.5 });
    const last = t.frames.at(-1);
    expect(last?.type === "browser.frame" && last.metadata.capturedAt).toBe(1_762_300_000_500);
    room = true;
    t.manager.room(dev.id);
    expect(acks()).toEqual([1, 2, 3, 4, 5]);
    // A frame with no usable seq is acknowledged as the last one: the next frame still comes.
    const relayed = t.frames.length;
    socket.push({ type: "frame", data: "/9j/A", metadata: size });
    expect(acks()).toEqual([1, 2, 3, 4, 5, 5]);
    expect(t.frames).toHaveLength(relayed);
    frame(6);
    expect(acks()).toEqual([1, 2, 3, 4, 5, 5, 6]);
    // A stream that ended owes nothing: no ack after its stop.
    await t.manager.streamStop(dev);
    t.manager.room(dev.id);
    expect(acks()).toEqual([1, 2, 3, 4, 5, 5, 6]);
  },
);

test.if(posix)("pacing: a frame whose room never comes is acknowledged after a while anyway", async () => {
  const t = setup({ frameRoom: () => false, sourceAckMs: 5 });
  await t.act("open", ["https://shop.example.com"]);
  await t.manager.streamStart(dev, "watch");
  const socket = t.sockets[0] as FakeSocket;
  socket.push({ type: "frame", seq: 1, data: "/9j/A", metadata: { deviceWidth: 1280, deviceHeight: 720 } });
  expect(socket.sent).toEqual([]);
  await waitFor(() => socket.sent.length === 1);
  expect(socket.sent).toEqual([{ type: "ack", seq: 1 }]);
  await t.manager.streamStop(dev);
});

test.if(posix)(
  "pacing with a live view: Chrome's next frame waits while the view's window is full, and never outlives the view",
  async () => {
    const server = { ack: () => {}, closed: () => {} };
    const viewed: number[] = [];
    const views = new BrowserViews({
      window: 2,
      dial: async () => ({
        send: (bytes) => {
          if (typeof bytes !== "string") viewed.push(decodeBrowserFrame(bytes)?.seq ?? -1);
        },
        close: () => server.closed(),
        bufferedAmount: 0,
        listen: (on) => {
          server.ack = () => on.control?.({ type: "ack" });
          server.closed = () => on.closed();
        },
      }),
    });
    // As the runner wires them: a viewed agent's frames go to its view, which says when it has room.
    const t = setup({
      send: (f) => {
        if (f.type === "browser.frame") views.push(f);
        return true;
      },
      frameRoom: (agentId) => views.room(agentId),
      sourceAckMs: 60_000,
    });
    views.onRoom = (agentId) => t.manager.room(agentId);
    await t.act("open", ["https://shop.example.com"]);
    await t.manager.streamStart(dev, "watch");
    await views.open(dev.id, "S".repeat(43));
    const socket = t.sockets[0] as FakeSocket;
    const acks = () => socket.sent.filter((m) => m.type === "ack").map((m) => m.seq);
    const frame = (seq: number) =>
      socket.push({ type: "frame", seq, data: "/9j/A", metadata: { deviceWidth: 1280, deviceHeight: 720 } });
    frame(1);
    expect(acks()).toEqual([1]);
    // The window is full: Chrome sends nothing more until the server answers.
    frame(2);
    expect(viewed).toEqual([1, 2]);
    expect(acks()).toEqual([1]);
    server.ack();
    expect(acks()).toEqual([1, 2]);
    // The view ends: the frame waiting is acknowledged, and the next ones go as before.
    frame(3);
    expect(acks()).toEqual([1, 2]);
    views.end(dev.id);
    expect(acks()).toEqual([1, 2, 3]);
    frame(4);
    expect(acks()).toEqual([1, 2, 3, 4]);
    expect(viewed).toEqual([1, 2, 3]);
    await t.manager.streamStop(dev);
  },
);

/** agent-browser's command relay on the stream port: records each command and answers like the daemon. */
function fakeRelay(answer: (body: Record<string, unknown>) => Record<string, unknown> = () => ({ success: true })) {
  const received: {
    body: Record<string, unknown>;
    origin: string | null;
    type: string | null;
    path: string;
    /** When it reached the page (ms). */
    at: number;
  }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const body = (await req.json()) as Record<string, unknown>;
      received.push({
        body,
        at: performance.now(),
        origin: req.headers.get("origin"),
        type: req.headers.get("content-type"),
        path: new URL(req.url).pathname,
      });
      // A little delay so out-of-order sends would show.
      await Bun.sleep(body.type === "mousePressed" ? 15 : 1);
      return Response.json({ data: { dispatched: body.type ?? body.action }, ...answer(body) });
    },
  });
  return { server, received, port: server.port as number };
}

test.if(posix)("a person's input goes through the daemon's command relay, in order, confirmed", async () => {
  const t = setup();
  const relay = fakeRelay();
  try {
    await t.act("open", ["https://shop.example.com"]);
    t.page({ port: relay.port });
    expect(await errorCode(() => t.manager.input(dev, [{ kind: "text", text: "x" }]))).toBe("bad_request");
    await t.manager.streamStart(dev, "control");
    const socket = t.sockets[0] as FakeSocket;
    const res = await t.manager.input(dev, [
      { kind: "mouse", type: "mouseMoved", x: 5, y: 6 },
      { kind: "mouse", type: "mousePressed", x: 5, y: 6, button: "left", clickCount: 1 },
      { kind: "mouse", type: "mouseReleased", x: 5, y: 6, button: "left", clickCount: 1 },
      { kind: "key", type: "keyDown", key: "Enter" },
      { kind: "key", type: "keyUp", key: "Enter" },
      { kind: "text", text: "senha-ção" },
      { kind: "nonsense" },
    ]);
    expect(res).toEqual({ accepted: 6 });
    // Nothing goes over the stream socket but the frame rate.
    expect(socket.sent).toEqual([]);
    expect(relay.received.map((r) => r.path)).toEqual(Array(6).fill("/api/command"));
    expect(relay.received.map((r) => r.origin)).toEqual(Array(6).fill(`http://127.0.0.1:${relay.port}`));
    expect(relay.received.every((r) => r.type === "application/json")).toBe(true);
    expect(relay.received.map((r) => r.body.type ?? r.body.action)).toEqual([
      "mouseMoved",
      "mousePressed",
      "mouseReleased",
      "press",
      "keyboard",
      "evaluate",
    ]);
    expect(relay.received[1]?.body).toMatchObject({ action: "input_mouse", x: 5, y: 6, button: "left", clickCount: 1 });
    expect(relay.received[3]?.body).toMatchObject({ action: "press", key: "Enter" });
    expect(relay.received[4]?.body).toMatchObject({ subaction: "insertText", text: "senha-ção" });
    expect(new Set(relay.received.map((r) => r.body.id)).size).toBe(6);
    // Never typed text on a command line.
    expect(t.logged().some((c) => c.args.join(" ").includes("senha") || c.stdin.includes("senha"))).toBe(false);
    // Two batches sent at once still reach the browser in the order they came.
    relay.received.length = 0;
    await Promise.all([
      t.manager.input(dev, [{ kind: "mouse", type: "mousePressed", x: 1, y: 1 }]),
      t.manager.input(dev, [{ kind: "mouse", type: "mouseReleased", x: 1, y: 1 }]),
    ]);
    expect(relay.received.map((r) => r.body.type)).toEqual(["mousePressed", "mouseReleased"]);
  } finally {
    relay.server.stop(true);
  }
});

test.if(posix)("text with nothing on the page to take it is said, and the picture is taken again", async () => {
  const t = setup({ firstFrameMs: 5 });
  let takes: unknown = false;
  const relay = fakeRelay((body) => (body.action === "evaluate" ? { data: { result: takes } } : { success: true }));
  try {
    await t.act("open", ["https://shop.example.com"]);
    t.page({ port: relay.port });
    await t.manager.streamStart(dev, "control");
    const socket = t.sockets[0] as FakeSocket;
    socket.push({ type: "status", connected: true, viewportWidth: 1280, viewportHeight: 720 });
    socket.push({ type: "frame", seq: 7, data: "/9j/B", metadata: { deviceWidth: 1280, deviceHeight: 720 } });
    const pictures = () => t.frames.filter((f) => f.type === "browser.frame").length;
    const before = pictures();
    // Chrome answers `Input.insertText` the same whether or not the text landed.
    expect(await t.manager.input(dev, [{ kind: "text", text: "a" }])).toEqual({ accepted: 1, nowhere: true });
    await waitFor(() => pictures() > before);
    // Once per batch, and only for text.
    relay.received.length = 0;
    await t.manager.input(dev, [
      { kind: "text", text: "a" },
      { kind: "text", text: "b" },
      { kind: "key", type: "keyDown", key: "Enter" },
    ]);
    expect(relay.received.filter((r) => r.body.action === "evaluate")).toHaveLength(1);
    relay.received.length = 0;
    await t.manager.input(dev, [{ kind: "key", type: "keyDown", key: "Enter" }]);
    expect(relay.received.some((r) => r.body.action === "evaluate")).toBe(false);
    takes = true;
    expect(await t.manager.input(dev, [{ kind: "text", text: "a" }])).toEqual({ accepted: 1 });
    // The page couldn't be asked: nothing is said on a guess.
    takes = undefined;
    expect(await t.manager.input(dev, [{ kind: "text", text: "a" }])).toEqual({ accepted: 1 });
  } finally {
    relay.server.stop(true);
  }
});

test.if(posix)("a drag in one batch reaches the page in order, its button held, with its gaps", async () => {
  const t = setup();
  const relay = fakeRelay();
  try {
    await t.act("open", ["https://shop.example.com"]);
    t.page({ port: relay.port });
    await t.manager.streamStart(dev, "control");
    // A slider dragged right over 120 ms, its events bunched by a slow link.
    const res = await t.manager.input(dev, [
      { kind: "mouse", type: "mouseMoved", x: 10, y: 50, button: "none", at: 5000 },
      { kind: "mouse", type: "mousePressed", x: 10, y: 50, button: "left", clickCount: 1, at: 5000 },
      { kind: "mouse", type: "mouseMoved", x: 60, y: 50, button: "left", at: 5060 },
      { kind: "mouse", type: "mouseMoved", x: 110, y: 50, button: "left", at: 5120 },
      { kind: "mouse", type: "mouseReleased", x: 110, y: 50, button: "left", clickCount: 1, at: 5120 },
    ]);
    expect(res).toEqual({ accepted: 5 });
    // Every move between the press and the release says the left button is down.
    const sent = relay.received.map((r) => [r.body.type, r.body.x, r.body.button, r.body.buttons, r.body.clickCount]);
    expect(sent).toEqual([
      ["mouseMoved", 10, "none", 0, 0],
      ["mousePressed", 10, "left", 1, 1],
      ["mouseMoved", 60, "left", 1, 0],
      ["mouseMoved", 110, "left", 1, 0],
      ["mouseReleased", 110, "left", 0, 1],
    ]);
    const at = relay.received.map((r) => r.at);
    const gap = (i: number) => (at[i] ?? 0) - (at[i - 1] ?? 0);
    // Each move 60 ms after the one before it (a little less for the timer's rounding), not all at once.
    expect(gap(2)).toBeGreaterThan(50);
    expect(gap(3)).toBeGreaterThan(50);
  } finally {
    relay.server.stop(true);
  }
});

test.if(posix)("a drag's gaps hold input a second at most, and none reaches the page once control ends", async () => {
  const t = setup();
  const relay = fakeRelay();
  try {
    await t.act("open", ["https://shop.example.com"]);
    t.page({ port: relay.port });
    await t.manager.streamStart(dev, "control");
    // Moves 100 ms apart by the `at` their sender wrote: as written, one batch would hold the queue 5 s.
    const drag = (x: number) => [
      { kind: "mouse", type: "mousePressed", x, y: 1, button: "left", clickCount: 1, at: 0 },
      ...Array.from({ length: 50 }, (_, i) => ({
        kind: "mouse",
        type: "mouseMoved",
        x: x + i + 1,
        y: 1,
        button: "left",
        at: (i + 1) * 100,
      })),
      { kind: "mouse", type: "mouseReleased", x: x + 50, y: 1, button: "left", clickCount: 1, at: 5000 },
    ];
    const start = performance.now();
    expect(await t.manager.input(dev, drag(0))).toEqual({ accepted: 52 });
    expect(performance.now() - start).toBeLessThan(DRAG_LAG_MAX_MS * 2.5);
    // Handed back mid-drag: the rest is dropped at once, and the page lets go where the pointer was.
    relay.received.length = 0;
    const queued = t.manager.input(dev, drag(100));
    await waitFor(() => relay.received.length === 3);
    const back = performance.now();
    await t.manager.streamStart(dev, "watch");
    expect(await queued).toEqual({ accepted: 3, failed: 49 });
    expect(performance.now() - back).toBeLessThan(500);
    await waitFor(() => relay.received.length === 4);
    expect(relay.received.map((r) => [r.body.type, r.body.x, r.body.buttons])).toEqual([
      ["mousePressed", 100, 1],
      ["mouseMoved", 101, 1],
      ["mouseMoved", 102, 1],
      ["mouseReleased", 102, 0],
    ]);
  } finally {
    relay.server.stop(true);
  }
});

test.if(posix)("a button still down when control ends lets go where the pointer was", async () => {
  const t = setup();
  const relay = fakeRelay();
  const sent = () => relay.received.map((r) => [r.body.type, r.body.x, r.body.y, r.body.buttons]);
  const press = (x: number) => [{ kind: "mouse", type: "mousePressed", x, y: 8, button: "left", clickCount: 1 }];
  try {
    await t.act("open", ["https://shop.example.com"]);
    t.page({ port: relay.port });
    await t.manager.streamStart(dev, "control");
    // Handed back mid-press.
    await t.manager.input(dev, press(7));
    await t.manager.streamStart(dev, "watch");
    await waitFor(() => relay.received.length === 2);
    // Nobody watches any more mid-press.
    await t.manager.streamStart(dev, "control");
    await t.manager.input(dev, press(9));
    await t.manager.streamStop(dev);
    await waitFor(() => relay.received.length === 4);
    expect(sent()).toEqual([
      ["mousePressed", 7, 8, 1],
      ["mouseReleased", 7, 8, 0],
      ["mousePressed", 9, 8, 1],
      ["mouseReleased", 9, 8, 0],
    ]);
  } finally {
    relay.server.stop(true);
  }
});

test.if(posix)("input the browser doesn't confirm is counted as failed", async () => {
  const t = setup();
  const relay = fakeRelay((body) =>
    body.type === "mousePressed" ? { success: false, error: "Browser not launched" } : {},
  );
  try {
    await t.act("open", ["https://shop.example.com"]);
    t.page({ port: relay.port });
    await t.manager.streamStart(dev, "control");
    const res = await t.manager.input(dev, [
      { kind: "mouse", type: "mousePressed", x: 1, y: 1 },
      { kind: "mouse", type: "mouseReleased", x: 1, y: 1 },
    ]);
    expect(res).toEqual({ accepted: 1, failed: 1 });
    // The stream ended: the rest of a batch is not sent to a browser that isn't there.
    (t.sockets[0] as FakeSocket).close();
    relay.received.length = 0;
    expect(await errorCode(() => t.manager.input(dev, [{ kind: "text", text: "x" }]))).toBe("bad_request");
    expect(relay.received).toEqual([]);
  } finally {
    relay.server.stop(true);
  }
});

// ── Readiness ────────────────────────────────────────────────────────────────

test("a download that doesn't match its pinned checksum is never used", async () => {
  const home = tempDir("runner-home-");
  const bin = tempDir("runner-bin-");
  dirs.push(home, bin);
  if (!agentBrowserTarget()) return;
  let fetched = "";
  const manager = new BrowserManager({
    home,
    log: () => {},
    send: () => true,
    secret: async () => null,
    execPath: path.join(bin, "agentes-runner"),
    sharedDir: path.join(bin, "no-shared-install"),
    chrome: () => "/fake/chrome",
    fetch: (async (url: string) => {
      fetched = url;
      return new Response("not the real binary");
    }) as unknown as typeof fetch,
  });
  expect(manager.info()).toMatchObject({ available: true, version: AGENT_BROWSER_VERSION, chrome: "Google Chrome" });
  const ws = tempDir();
  dirs.push(ws);
  const act = () =>
    manager.act(dev, ws, { op: "browser.act", command: "open", args: ["https://a.example"], timeoutSeconds: 5 });
  expect(await errorCode(act)).toBe("browser_unavailable");
  expect(fetched).toContain(`/releases/download/v${AGENT_BROWSER_VERSION}/agent-browser-`);
  expect(existsSync(path.join(home, "bin"))).toBe(false);
  expect(manager.info()).toMatchObject({
    available: false,
    reason: expect.stringContaining("checksum"),
    code: "browser_checksum",
  });
  // Not tried again right away.
  fetched = "";
  expect(await errorCode(act)).toBe("browser_unavailable");
  expect(fetched).toBe("");
});

/** The shared install `install.sh --system` makes: its agent-browser (a script noting what it ran). */
function sharedInstall(parts: { agentBrowser?: boolean } = {}) {
  const dir = tempDir("shared-browser-");
  const ran = `${dir}.log`;
  dirs.push(dir, ran);
  if (parts.agentBrowser !== false) {
    writeFileSync(
      path.join(dir, `agent-browser-${AGENT_BROWSER_VERSION}`),
      `#!/bin/sh\necho "$@" >> '${ran}'\necho '{"success":true,"data":null}'\n`,
      { mode: 0o755 },
    );
  }
  return { dir, ran: () => (existsSync(ran) ? readFileSync(ran, "utf8").trim().split("\n") : []) };
}

/** A runner with nothing of its own (no sidecar, nothing in the user's home) and `shared` as its shared install. */
function withShared(shared: string) {
  const [home, bin, user, ws] = ["runner-home-", "runner-bin-", "user-home-", "runner-"].map((p) => tempDir(p));
  dirs.push(home as string, bin as string, user as string, ws as string);
  const fetched: string[] = [];
  const chromes = fakeChromes();
  const manager = new BrowserManager({
    home: home as string,
    log: () => {},
    send: () => true,
    secret: async () => null,
    execPath: path.join(bin as string, "agentes-runner"),
    userHome: user as string,
    sharedDir: shared,
    chrome: () => CHROME_EXE,
    chromeVersion: () => CHROME_VERSION,
    startChrome: chromes.start,
    isOurChrome: async () => false,
    fetch: (async (url: string) => {
      fetched.push(url);
      return new Response("not the real binary");
    }) as unknown as typeof fetch,
  });
  const act = () =>
    manager.act(dev, ws as string, {
      op: "browser.act",
      command: "open",
      args: ["https://a.example/"],
      timeoutSeconds: 5,
    });
  return { manager, fetched, chromes: chromes.started, act, user: user as string };
}

test.if(posix)(
  "the shared install's agent-browser and the computer's Chrome are used as they are: nothing is downloaded or installed",
  async () => {
    const shared = sharedInstall();
    const r = withShared(shared.dir);
    expect(r.manager.info()).toMatchObject({ available: true, chrome: `Google Chrome ${CHROME_VERSION}` });
    expect(await r.act()).toMatchObject({ success: true });
    expect(r.fetched).toEqual([]);
    expect(r.chromes.map((c) => c.exe)).toEqual([CHROME_EXE]);
    expect(shared.ran().some((line) => line.split(" ").includes("install"))).toBe(false);
    expect(shared.ran().at(-1)).toEndWith(" open https://a.example/");
    expect(readdirSync(r.user)).toEqual([]);
  },
);

test.if(posix)(
  "a shared install others could change is never used, and without one the runner downloads as before",
  async () => {
    const target = agentBrowserTarget();
    if (!target) return;
    // Its agent-browser missing: downloaded (refused here, not being the pinned file).
    const noBinary = sharedInstall({ agentBrowser: false });
    let r = withShared(noBinary.dir);
    expect(await errorCode(r.act)).toBe("browser_unavailable");
    expect(r.fetched).toEqual([agentBrowserUrl(target)]);
    // A folder its group may write: neither is used.
    const open = sharedInstall();
    chmodSync(open.dir, 0o775);
    r = withShared(open.dir);
    expect(await errorCode(r.act)).toBe("browser_unavailable");
    expect(r.fetched).toEqual([agentBrowserUrl(target)]);
    // An agent-browser anyone may rewrite: never run.
    const loose = sharedInstall();
    chmodSync(path.join(loose.dir, `agent-browser-${AGENT_BROWSER_VERSION}`), 0o777);
    r = withShared(loose.dir);
    expect(await errorCode(r.act)).toBe("browser_unavailable");
    expect(r.fetched).toEqual([agentBrowserUrl(target)]);
    // None at all.
    r = withShared(path.join(open.dir, "missing"));
    expect(await errorCode(r.act)).toBe("browser_unavailable");
    expect(r.fetched).toEqual([agentBrowserUrl(target)]);
    expect([...open.ran(), ...loose.ran()]).toEqual([]);
  },
);

test.if(posix)("the desktop app's sidecar is used as is, and closeAll closes this runner's browsers only", async () => {
  const home = tempDir("runner-home-");
  const bin = tempDir("runner-bin-");
  dirs.push(home, bin);
  const log = path.join(home, "sidecar.log");
  const sidecar = path.join(bin, "agent-browser");
  writeFileSync(sidecar, `#!/bin/sh\necho "$@" >> '${log}'\necho '{"success":true,"data":null}'\n`);
  chmodSync(sidecar, 0o755);
  const manager = new BrowserManager({
    home,
    log: () => {},
    send: () => true,
    secret: async () => null,
    execPath: path.join(bin, "agentes-runner"),
    chrome: () => null,
  });
  expect(manager.info()).toMatchObject({ available: true });
  await manager.closeAll();
  const line = readFileSync(log, "utf8").trim();
  expect(line).toMatch(/^--namespace agentes-[0-9a-f]{8} --json close --all$/);
});

// ── Requests ─────────────────────────────────────────────────────────────────

test.if(posix)("browser ops need the machine's browser switch, except stopping", async () => {
  const t = setup();
  let access: RunnerAccess = { folders: [], tools: { claude: false, codex: false, commands: true } };
  const scope: RequestScope = { signal: new AbortController().signal, output: () => {} };
  const ctx = { workspaceReal: t.ws, exec: true, token: "agm_x", access: () => access, browser: t.manager };
  const call = (req: MachineRequest) => handleRequest(ctx, req, scope);
  const open: MachineRequest = {
    agent: dev,
    op: "browser.act",
    command: "open",
    args: ["https://a.example"],
    timeoutSeconds: 5,
  };
  const warm: MachineRequest = { agent: dev, op: "browser.warm" };
  expect(await errorCode(() => call(open))).toBe("not_allowed");
  expect(await errorCode(() => call(warm))).toBe("not_allowed");
  expect(t.chromes).toHaveLength(0);
  access = { ...access, tools: { ...access.tools, browser: true } };
  expect(await call(warm)).toMatchObject({ started: true });
  expect(await call(open)).toMatchObject({ success: true });
  expect(t.chromes).toHaveLength(1);
  // The agent's own folder was used.
  expect(existsSync(path.join(t.ws, "dev-01a142cb", ".agentes", "browser"))).toBe(true);
  access = { ...access, tools: { ...access.tools, browser: false } };
  expect(await call({ agent: dev, op: "browser.stop" })).toEqual({ stopped: true });
  expect(await errorCode(() => call({ op: "browser.stop" }))).toBe("bad_request");
  expect(await errorCode(() => handleRequest({ ...ctx, browser: undefined }, open, scope))).toBe("browser_unavailable");
});

test.if(posix)("a paused computer starts no browser work", async () => {
  const t = setup();
  const scope: RequestScope = { signal: new AbortController().signal, output: () => {} };
  const ctx = {
    workspaceReal: t.ws,
    exec: true,
    token: "agm_x",
    paused: () => true,
    access: (): RunnerAccess => ({
      folders: [],
      tools: { claude: false, codex: false, commands: true, browser: true },
    }),
    browser: t.manager,
  };
  const req: MachineRequest = {
    agent: dev,
    op: "browser.act",
    command: "open",
    args: ["https://a.example"],
    timeoutSeconds: 5,
  };
  expect(await errorCode(() => handleRequest(ctx, req, scope))).toBe("paused");
  expect(await errorCode(() => handleRequest(ctx, { agent: dev, op: "browser.warm" }, scope))).toBe("paused");
  expect(t.logged()).toHaveLength(0);
  expect(t.chromes).toHaveLength(0);
});

test("a frame reaches the server with the page's address and title, the title cut to its limit", () => {
  const frame = (metadata: Record<string, unknown>) =>
    parseRunnerFrame(JSON.stringify({ type: "browser.frame", agentId: dev.id, seq: 1, data: "/9j/A", metadata }));
  const size = { deviceWidth: 1280, deviceHeight: 720 };
  expect(frame({ ...size, url: "https://shop.example.com/", title: "Loja" })).toMatchObject({
    metadata: { ...size, url: "https://shop.example.com/", title: "Loja" },
  });
  const long = frame({ ...size, title: "x".repeat(BROWSER_LIMITS.title + 50) });
  expect(long?.type === "browser.frame" && long.metadata.title?.length).toBe(BROWSER_LIMITS.title);
  // An older runner sends none; an empty one isn't kept.
  const none = frame({ ...size, title: "" });
  expect(none?.type === "browser.frame" && "title" in none.metadata).toBe(false);
});

// ── For the desktop app's tray ───────────────────────────────────────────────

test("browser.handoff from the server parses; a malformed one is dropped", () => {
  const ok = parseServerFrame(
    JSON.stringify({ type: "browser.handoff", agentId: dev.id, handoff: { status: "pending", request: "Entrar" } }),
  );
  expect(ok).toEqual({ type: "browser.handoff", agentId: dev.id, handoff: { status: "pending", request: "Entrar" } });
  expect(parseServerFrame(JSON.stringify({ type: "browser.handoff", agentId: dev.id, handoff: null }))).not.toBeNull();
  expect(parseServerFrame(JSON.stringify({ type: "browser.handoff", handoff: null }))).toBeNull();
  expect(parseServerFrame(JSON.stringify({ type: "browser.handoff", agentId: dev.id, handoff: "x" }))).toBeNull();
});

test.skipIf(!posix)(
  "tray state: open with host, what it did and the conversation; a person's turn; closed",
  async () => {
    let changes = 0;
    const now = 1_000_000;
    const t = setup({ onChange: () => changes++, now: () => now });
    expect(t.manager.states()).toEqual([]);
    await t.manager.act(dev, await t.folder(), {
      op: "browser.act",
      command: "open",
      args: ["https://app.acme.example/login"],
      timeoutSeconds: 30,
      link: "/org/o1/c/c1",
    });
    await t.act("click", ["@e3"]);
    expect(t.manager.states()).toEqual([
      {
        agentId: dev.id,
        open: true,
        host: "app.acme.example",
        doing: "clicking",
        actedAt: new Date(now).toISOString(),
        link: "/org/o1/c/c1",
      },
    ]);
    expect(changes).toBeGreaterThan(0);

    // The server says a person was asked; then that one is in control; a link elsewhere is dropped.
    t.manager.setHandoff(dev.id, { status: "pending", request: "Entrar na Acme", link: "https://evil.example/x" });
    expect(t.manager.states()[0]?.handoff).toEqual({ status: "pending", request: "Entrar na Acme" });
    t.manager.setHandoff(dev.id, { status: "active", controller: "Walter", link: "/org/o1/c/c1?m=h1" });
    expect(t.manager.states()[0]?.handoff).toEqual({
      status: "active",
      controller: "Walter",
      link: "/org/o1/c/c1?m=h1",
    });

    // Closed with a request still open: it stays listed (not open) so the tray can say "precisa de você".
    await t.manager.stop(dev);
    expect(t.manager.states()).toEqual([
      { agentId: dev.id, open: false, handoff: { status: "active", controller: "Walter", link: "/org/o1/c/c1?m=h1" } },
    ]);
    t.manager.setHandoff(dev.id, null);
    expect(t.manager.states()).toEqual([]);

    // Offline: what the server told is forgotten (it tells again on reconnect).
    t.manager.setHandoff(ops.id, { status: "pending" });
    t.manager.clearHandoffs();
    expect(t.manager.states()).toEqual([]);
  },
);

test.skipIf(!posix)("tray state: a browser left idle stops counting as open", async () => {
  let now = 1_000_000;
  const t = setup({ now: () => now, idleMs: 60_000 });
  await t.act("open", ["https://a.example"]);
  expect(t.manager.states()[0]?.open).toBe(true);
  now += 61_000;
  expect(t.manager.states()).toEqual([]);
});

// ── Browser profiles (ADR 0110) ─────────────────────────────────────────────

const PROFILE = "0b1d2c3e-4f50-7000-8000-00000000abcd";
const profileScope = { signal: new AbortController().signal, output: () => {} } satisfies RequestScope;
const browserOn = (): RunnerAccess => ({
  folders: [],
  tools: { claude: false, codex: false, commands: true, browser: true },
});

test.if(posix)(
  "two agents' commands in one profile share one session and one Chrome, in the profile's own folder",
  async () => {
    const t = setup();
    const ctx = { workspaceReal: t.ws, exec: true, token: "agm_x", access: browserOn, browser: t.manager };
    const open = (agent: typeof dev, url: string): MachineRequest => ({
      agent,
      profile: { id: PROFILE },
      op: "browser.act",
      command: "open",
      args: [url],
      timeoutSeconds: 5,
      desktop: true,
    });
    await Promise.all([
      handleRequest(ctx, open(dev, "https://a.example"), profileScope),
      handleRequest(ctx, open(ops, "https://b.example"), profileScope),
    ]);
    expect(t.chromes).toHaveLength(1);
    const chrome = t.chromes[0] as FakeChrome;
    // Its folder is under the runner's home, in no agent's folder; asked for a desktop, it still runs headless.
    expect(chrome.profile).toBe(path.join(t.home, "browser-profiles", PROFILE, ".agentes", "browser"));
    expect(chrome.args.some((a) => a.startsWith("--headless"))).toBe(true);
    const sessions = new Set(
      t
        .logged()
        .map((l) => l.args[l.args.indexOf("--session") + 1])
        .filter(Boolean),
    );
    expect([...sessions]).toEqual([`profile-${PROFILE.slice(0, 8)}`]);
    // No agent folder was made for it.
    expect(readdirSync(t.ws).some((d) => d.includes("profile"))).toBe(false);
    // A person's "show it on the desktop" is refused for a profile.
    expect(
      await errorCode(() =>
        t.manager.show(
          { id: `profile:${PROFILE}`, handle: "dev" },
          path.join(t.home, "browser-profiles", PROFILE),
          () => {},
        ),
      ),
    ).toBe("not_allowed");
  },
);

test.if(posix)(
  "a stale Chrome lock (a restore onto another computer) is cleared before the profile's Chrome starts",
  async () => {
    const t = setup();
    const folder = path.join(t.home, "browser-profiles", PROFILE, ".agentes", "browser");
    mkdirSync(folder, { recursive: true });
    for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket"])
      writeFileSync(path.join(folder, f), "old-host-4242");
    const ctx = { workspaceReal: t.ws, exec: true, token: "agm_x", access: browserOn, browser: t.manager };
    await handleRequest(ctx, { agent: dev, profile: { id: PROFILE }, op: "browser.warm" }, profileScope);
    expect(t.chromes).toHaveLength(1);
    expect(readdirSync(folder).filter((f) => f.startsWith("Singleton"))).toEqual([]);
  },
);

test.if(posix)(
  "a start never hands its start page to a Chrome still running on the profile: that leftover stops first",
  async () => {
    // What an overlapping runner left: a Chrome it recorded on the agent's profile, still running, that no session
    // holds. Started beside it, Chrome would open its start page there as one more tab and exit.
    const leftover = Bun.spawn(["sleep", "60"]);
    const gone = () => leftover.exitCode !== null || leftover.signalCode !== null;
    try {
      const chromes = fakeChromes();
      const leftoverAtStart: boolean[] = [];
      const t = setup({
        isOurChrome: async (pid) => pid === leftover.pid && !gone(),
        startChrome: (exe, args, profile) => {
          leftoverAtStart.push(!gone());
          return chromes.start(exe, args, profile);
        },
      });
      const profile = path.join(await t.folder(), ".agentes", "browser");
      mkdirSync(profile, { recursive: true });
      writeFileSync(path.join(profile, "SingletonLock"), `computer-${leftover.pid}`);
      mkdirSync(path.join(t.home, "browser"), { recursive: true });
      writeFileSync(path.join(t.home, "browser", "chromes.json"), JSON.stringify([{ pid: leftover.pid, profile }]));

      expect(await t.act("open", ["https://shop.example.com"])).toMatchObject({ success: true });
      expect(leftoverAtStart).toEqual([false]);
      expect(chromes.started.map((c) => c.tabs)).toEqual([[expect.stringMatching(/\/agentes-start\.html$/)]]);
      const recorded = JSON.parse(readFileSync(path.join(t.home, "browser", "chromes.json"), "utf8")) as {
        pid: number;
      }[];
      expect(recorded.map((c) => c.pid)).not.toContain(leftover.pid);
    } finally {
      leftover.kill("SIGKILL");
    }
  },
);

test.if(posix)("deleting a profile stops its Chrome and removes its folder; system mode refuses profiles", async () => {
  const t = setup();
  const ctx = { workspaceReal: t.ws, exec: true, token: "agm_x", access: browserOn, browser: t.manager };
  await handleRequest(ctx, { agent: dev, profile: { id: PROFILE }, op: "browser.warm" }, profileScope);
  const root = path.join(t.home, "browser-profiles", PROFILE);
  expect(existsSync(root)).toBe(true);
  expect(await handleRequest(ctx, { profile: { id: PROFILE }, op: "browser.profile.delete" }, profileScope)).toEqual({
    deleted: true,
  });
  expect(existsSync(root)).toBe(false);
  expect((t.chromes[0] as FakeChrome).killed || (t.chromes[0] as FakeChrome).closed).toBe(true);
  // Not a profile id: refused before anything touches the disk.
  expect(await errorCode(() => handleRequest(ctx, { profile: { id: "../x" }, op: "browser.warm" }, profileScope))).toBe(
    "bad_request",
  );
  const system = { ...ctx, systemMode: () => true, workers: { run: async () => ({}) } };
  expect(
    await errorCode(() =>
      handleRequest(system, { agent: dev, profile: { id: PROFILE }, op: "browser.warm" }, profileScope),
    ),
  ).toBe("not_allowed");
});

// ── The Vault (ADR 0144) ─────────────────────────────────────────────────────

/** An agent of these tests only: what it arms in this process's Vault stays its own. */
const keeper = { id: "5e5e5e5e-0135-7000-8000-000000000003", handle: "keeper" };
const SHOP_RULE = "exact:https://shop.example.com";

/** A login's password sealed as the server does: to a one-use key of the agent, for one rule. */
async function sealLogin(agentId: string, rule: string, password: string) {
  const { keyId, publicKey } = await runnerVault.issueKey(agentId);
  const box = await sealSecret(publicKey, password, vaultAad({ keyId, agentId, use: { kind: "fill", rule } }));
  return JSON.stringify({ keyId, box });
}

const batchesOf = (t: ReturnType<typeof setup>) => t.logged().filter((c) => c.args.includes("batch"));

test.if(posix)("a Vault login is typed once on its site, checked in the page between focus and fill", async () => {
  const t = setup();
  const password = "correct-horse-battery-staple";
  const act = (command: string, args: string[]) => t.act(command, args, { agent: keeper });
  await act("open", ["https://shop.example.com/login"]);
  t.page({ attrs: { "@e3": { type: "email", autocomplete: "username" }, "@e4": { type: "password" } } });
  const box = await sealLogin(keeper.id, SHOP_RULE, password);
  const typed = await act("agentes:type_vault", ["e4", SHOP_RULE, box]);
  expect(typed).toEqual({ success: true, data: { typed: "vault", into: "@e4", origin: "https://shop.example.com" } });
  expect(JSON.stringify(typed)).not.toContain(password);
  // One invocation, the value on stdin only: focus, the check (which marks the field it let through), the fill by
  // that one-time mark (never the ref, looked up again), then the mark taken off; it stops at the first failure.
  expect(batchesOf(t)).toHaveLength(1);
  expect(batchesOf(t)[0]?.args).toContain("--bail");
  const commands = JSON.parse(batchesOf(t)[0]?.stdin ?? "[]") as string[][];
  expect(commands.map((c) => c[0])).toEqual(["focus", "eval", "fill", "eval"]);
  expect(commands[0]).toEqual(["focus", "@e4"]);
  const mark = /^\[data-agentes-fill="([0-9a-f]{32})"\]$/.exec(commands[2]?.[1] ?? "")?.[1];
  expect(mark).toBeDefined();
  expect(commands[2]).toEqual(["fill", `[${FILL_MARK_ATTR}="${mark}"]`, password]);
  expect(commands[1]?.[1]).toContain(mark as string);
  expect(commands[3]?.[1]).toContain(mark as string);
  expect(commands[1]?.[1]).not.toContain(password);
  // It went into the field the check let through, and the mark came off.
  const state = JSON.parse(readFileSync(path.join(t.home, "ab-state.json"), "utf8"));
  expect(state.filled).toEqual([{ ref: "@e4", url: "https://shop.example.com/login" }]);
  expect(state.marks).toEqual({});
  expect(t.logged().some((c) => c.args.join(" ").includes(password))).toBe(false);
  // Its key went at its first use: the same box again types nothing.
  expect(await act("agentes:type_vault", ["e4", SHOP_RULE, box])).toMatchObject({
    success: false,
    code: "key_expired",
  });
  expect(batchesOf(t)).toHaveLength(1);
  // What the browser reads back afterwards leaves redacted (a field that shows it).
  t.page({ attrs: { "@e4": { type: "text", value: password } } });
  const ctx = { workspaceReal: t.ws, exec: true, token: "agm_x", browser: t.manager };
  const scope: RequestScope = { signal: new AbortController().signal, output: () => {} };
  const get = { agent: keeper, op: "browser.act" as const, command: "get", args: ["attr", "@e4", "value"] };
  expect(await handleRequest(ctx, { ...get, timeoutSeconds: 5 }, scope)).toMatchObject({
    success: true,
    data: { value: "[secret:VAULT_PASSWORD]" },
  });
});

test.if(posix)("a Vault login isn't typed off its sites, outside a password field, into a GET form", async () => {
  const t = setup();
  const rule = "site:example.com";
  const act = (command: string, args: string[]) => t.act(command, args, { agent: keeper });
  const type = async (ref = "e4") =>
    act("agentes:type_vault", [ref, rule, await sealLogin(keeper.id, rule, "hunter2-vault-refusals")]);
  await act("open", ["https://evil.test/login"]);
  t.page({ attrs: { "@e4": { type: "password" } } });
  expect(await type()).toMatchObject({
    success: false,
    code: "wrong_site",
    error: expect.stringContaining("This login is for example.com, and the page is on evil.test"),
  });
  await act("open", ["https://example.com.evil.test/login"]);
  expect(await type()).toMatchObject({ success: false, code: "wrong_site" });
  // The page's own address said no: nothing reached the page.
  expect(batchesOf(t)).toHaveLength(0);
  await act("open", ["https://shop.example.com/login"]);
  t.page({
    attrs: {
      "@e3": { type: "text" },
      "@e4": { type: "password", method: "get" },
      "@e5": { tag: "IFRAME" },
      "@e6": { type: "password" },
    },
  });
  expect(await type("e3")).toMatchObject({ success: false, code: "not_password_field" });
  expect(await type("e4")).toMatchObject({ success: false, code: "get_form" });
  // A form without a method (a script signs in) is fine; one whose submit button says formmethod="get" isn't.
  t.page({ attrs: { "@e4": { type: "password", submitMethod: "get" }, "@e6": { type: "password", method: "" } } });
  expect(await type("e4")).toMatchObject({ success: false, code: "get_form" });
  expect(await type("e6")).toMatchObject({ success: true });
  t.page({
    attrs: {
      "@e3": { type: "text" },
      "@e4": { type: "password", method: "get" },
      "@e5": { tag: "IFRAME" },
      "@e6": { type: "password" },
    },
  });
  // The ref is a frame's element: its own code, for the server to send the person through the hand-off.
  expect(await type("e5")).toMatchObject({
    success: false,
    code: "in_frame",
    error: expect.stringContaining("inside an embedded frame"),
  });
  // The field in a frame from another site, inside the right page.
  t.page({ frame: { origin: "https://ads.test", ancestors: ["https://shop.example.com"] } });
  expect(await type("e6")).toMatchObject({ success: false, code: "wrong_site" });
  // In a frame of the login's own site: typed.
  t.page({ frame: { origin: "https://login.example.com", ancestors: ["https://shop.example.com"] } });
  expect(await type("e6")).toMatchObject({ success: true, data: { typed: "vault", into: "@e6" } });
});

test.if(posix)("malformed Vault input is refused before anything runs; a box for another use won't open", async () => {
  const t = setup();
  const folder = await t.folder(keeper);
  await t.act("open", ["https://shop.example.com/login"], { agent: keeper });
  t.page({ attrs: { "@e4": { type: "password" } } });
  const before = t.logged().length;
  const batch = (args: string[]) =>
    t.manager.batch(keeper, folder, {
      op: "browser.batch",
      commands: [
        { command: "click", args: ["@e1"], timeoutSeconds: 5 },
        { command: "agentes:type_vault", args, timeoutSeconds: 5 },
      ],
    });
  expect(await errorCode(() => batch(["e4", SHOP_RULE, "{}"]))).toBe("bad_request");
  expect(await errorCode(() => batch(["e4", "exact:http://shop.example.com", "{}"]))).toBe("bad_request");
  expect(t.logged().length).toBe(before);
  // Sealed for the exact address, asked for the whole site: it doesn't open.
  const narrow = await sealLogin(keeper.id, SHOP_RULE, "hunter2-wrong-rule");
  const widened = () => t.act("agentes:type_vault", ["e4", "site:example.com", narrow], { agent: keeper });
  expect(await errorCode(widened)).toBe("bad_request");
  // Another agent's key opens nothing here.
  const theirs = await sealLogin(dev.id, SHOP_RULE, "hunter2-their-box");
  expect(await t.act("agentes:type_vault", ["e4", SHOP_RULE, theirs], { agent: keeper })).toMatchObject({
    success: false,
    code: "key_expired",
  });
  expect(batchesOf(t)).toHaveLength(0);
});

test.if(posix)("in a profile's session a login opens for the agent whose turn it is, redacted for all", async () => {
  const t = setup();
  const ctx = { workspaceReal: t.ws, exec: true, token: "agm_x", access: browserOn, browser: t.manager };
  const act = (agent: typeof dev, command: string, args: string[]) =>
    handleRequest(
      ctx,
      { agent, profile: { id: PROFILE }, op: "browser.act", command, args, timeoutSeconds: 5 },
      profileScope,
    );
  const password = "hunter2-profile-session";
  await act(keeper, "open", ["https://shop.example.com/login"]);
  t.page({ attrs: { "@e4": { type: "password" } } });
  const box = await sealLogin(keeper.id, SHOP_RULE, password);
  expect(await act(keeper, "agentes:type_vault", ["e4", SHOP_RULE, box])).toMatchObject({ success: true });
  // Another agent acting in the same profile reads the field redacted.
  t.page({ attrs: { "@e4": { type: "text", value: password } } });
  expect(await act(dev, "get", ["attr", "@e4", "value"])).toMatchObject({
    success: true,
    data: { value: "[secret:VAULT_PASSWORD]" },
  });
  // A picture of the page names its address redacted too, as the agent's own browser does.
  t.page({ url: `https://shop.example.com/after?pw=${password}` });
  const shot = (await handleRequest(
    ctx,
    { agent: dev, profile: { id: PROFILE }, op: "browser.capture" },
    profileScope,
  )) as { url?: string };
  expect(shot.url).not.toContain(password);
  expect(shot.url).toContain("[secret:VAULT_PASSWORD]");
});

test.if(posix)("a code goes one character per field, each field checked where it is typed", async () => {
  const code = "482913";
  const t = setup({
    secret: async (_agent, name) => (name === "SHOP_CODE" ? { value: code, site: "https://shop.example.com" } : null),
  });
  const refs = ["@e1", "@e2", "@e3", "@e4", "@e5", "@e6"];
  const boxes = (over: Record<string, unknown> = {}) => ({
    ...Object.fromEntries(refs.map((r) => [r, { type: "tel", autocomplete: "one-time-code" }])),
    ...over,
  });
  const typeCode = (fields: string[]) =>
    t.act("agentes:type_secret", [fields[0] as string, "SHOP_CODE", "https://shop.example.com", ...fields.slice(1)], {
      agent: keeper,
    });
  await t.act("open", ["https://shop.example.com/verify"], { agent: keeper });
  t.page({ attrs: boxes() });
  expect(await typeCode(refs.map((r) => r.slice(1)))).toEqual({
    success: true,
    data: { typed: "SHOP_CODE", into: "@e1", fields: refs },
  });
  const commands = JSON.parse(batchesOf(t).at(-1)?.stdin ?? "[]") as string[][];
  expect(commands.slice(0, 4).map((c) => c[0])).toEqual(["focus", "eval", "fill", "eval"]);
  // Each character into the box its check marked, each mark new.
  const fills = commands.filter((c) => c[0] === "fill");
  expect(fills.map((c) => c[2])).toEqual(Array.from(code));
  expect(new Set(fills.map((c) => c[1])).size).toBe(refs.length);
  const filled = JSON.parse(readFileSync(path.join(t.home, "ab-state.json"), "utf8")).filled as { ref: string }[];
  expect(filled.map((f) => f.ref)).toEqual(refs);
  // As many fields as characters, each one once.
  expect(await typeCode(refs.slice(0, 4))).toMatchObject({
    success: false,
    error: expect.stringContaining("A password goes in one field at a time"),
  });
  expect(await errorCode(() => typeCode(["@e1", "@e1", "@e2", "@e3", "@e4", "@e5"]))).toBe("bad_request");
  // A field that isn't a code's stops it there.
  t.page({ attrs: boxes({ "@e3": { type: "password" } }) });
  expect(await typeCode(refs)).toMatchObject({
    success: false,
    code: "not_code_field",
    error: expect.stringContaining("@e3"),
  });
  // A box that is a frame's element: its own code, never "switch to that frame".
  t.page({ attrs: boxes({ "@e2": { tag: "IFRAME" } }) });
  expect(await typeCode(refs)).toMatchObject({
    success: false,
    code: "in_frame",
    error: expect.stringContaining("@e2 is inside an embedded frame"),
  });
  // A site's password from request_secret lives in memory only: once gone, the answer says so plainly.
  const missing = await t.act("agentes:type_secret", ["e1", "SHOP_PASSWORD", "https://shop.example.com"], {
    agent: keeper,
  });
  expect(missing).toMatchObject({ success: false });
  expect(missing.error).toContain("kept in its memory only, for 15 minutes");
  expect(missing.error).toContain("save it to the Vault");
});

/**
 * A Chrome whose DevTools socket answers the counter's first command, and `Fetch.enable` as `fetch` says: acknowledged
 * (noting how many `agent-browser` batches had run by then), never, or by closing.
 */
function guardedChrome(fetch: { answer: "reply" | "close" | "never" }) {
  const devtools: FakeSocket[] = [];
  const acknowledgedAfter: number[] = [];
  const chromes = fakeChromes();
  const t = setup({
    startChrome: async (exe, args, profile) => ({
      ...(await chromes.start(exe, args, profile)),
      wsPath: "/devtools/browser/guarded",
    }),
    connectDevtools: (url) => {
      const s = new FakeSocket(url);
      const send = s.send.bind(s);
      s.send = (data: string) => {
        send(data);
        const m = JSON.parse(data) as { id: number; method: string };
        if (m.method !== "Fetch.enable" || fetch.answer === "never") return;
        queueMicrotask(() => {
          if (fetch.answer === "close") return s.close();
          acknowledgedAfter.push(batchesOf(t).length);
          s.push({ id: m.id, result: {} });
        });
      };
      devtools.push(s);
      queueMicrotask(() => {
        s.onopen?.();
        s.push({ id: 1, result: {} });
      });
      return s;
    },
  });
  return { t, devtools, acknowledgedAfter };
}

test.if(posix)("a request carrying a typed login in its address is stopped; the next action says so", async () => {
  const { t, devtools, acknowledgedAfter } = guardedChrome({ answer: "reply" });
  const password = "hunter2 & the get form";
  const act = (command: string, args: string[]) => t.act(command, args, { agent: keeper });
  await act("open", ["https://shop.example.com/login"]);
  const cdp = devtools[0] as FakeSocket;
  const page = { sessionId: "page-1", targetInfo: { type: "page", targetId: "t1" } };
  cdp.push({ method: "Target.attachedToTarget", params: page });
  t.page({ attrs: { "@e3": { type: "text" }, "@e4": { type: "password" } } });
  expect(cdp.sent.some((m) => m.method === "Fetch.enable")).toBe(false);
  const methods = () => cdp.sent.map((m) => m.method).filter((m) => String(m).startsWith("Fetch."));
  // A refused fill (not a password field) takes its guard back: nothing stays paused.
  const wrong = await sealLogin(keeper.id, SHOP_RULE, password);
  expect(await act("agentes:type_vault", ["e3", SHOP_RULE, wrong])).toMatchObject({
    success: false,
    code: "not_password_field",
  });
  expect(methods()).toEqual(["Fetch.enable", "Fetch.disable"]);
  const box = await sealLogin(keeper.id, SHOP_RULE, password);
  expect(await act("agentes:type_vault", ["e4", SHOP_RULE, box])).toMatchObject({ success: true });
  // Armed before the fill: Chrome acknowledged Fetch.enable on the page before any batch typed (each time).
  expect(methods()).toEqual(["Fetch.enable", "Fetch.disable", "Fetch.enable"]);
  expect(acknowledgedAfter).toEqual([batchesOf(t).length - 2, batchesOf(t).length - 1]);
  expect(cdp.sent).toContainEqual(expect.objectContaining({ method: "Fetch.enable", sessionId: "page-1" }));
  const paused = (requestId: string, url: string) =>
    cdp.push({ method: "Fetch.requestPaused", sessionId: "page-1", params: { requestId, request: { url } } });
  // A GET form's submission (form-encoded), a script's own address (encodeURIComponent), a file of the page.
  paused("r1", `https://shop.example.com/session?${new URLSearchParams({ user: "ana", password })}`);
  paused("r2", `https://shop.example.com/session?password=${encodeURIComponent(password)}`);
  paused("r3", "https://shop.example.com/assets/app.js");
  const answered = (method: string, requestId: string) =>
    cdp.sent.some((m) => {
      const params = m.params as { requestId?: string } | undefined;
      return m.method === method && m.sessionId === "page-1" && params?.requestId === requestId;
    });
  expect(answered("Fetch.failRequest", "r1")).toBe(true);
  expect(answered("Fetch.failRequest", "r2")).toBe(true);
  expect(answered("Fetch.continueRequest", "r3")).toBe(true);
  expect(answered("Fetch.continueRequest", "r1")).toBe(false);
  // The agent's next action hears it, once.
  expect(await act("click", ["@e1"])).toMatchObject({ success: false, code: "get_blocked", error: GET_BLOCKED });
  expect(await act("click", ["@e1"])).toMatchObject({ success: true });
});

test.if(posix)("a login isn't typed when Chrome doesn't confirm the guard first", async () => {
  const { t, devtools } = guardedChrome({ answer: "close" });
  const act = (command: string, args: string[]) => t.act(command, args, { agent: keeper });
  await act("open", ["https://shop.example.com/login"]);
  const cdp = devtools[0] as FakeSocket;
  cdp.push({ method: "Target.attachedToTarget", params: { sessionId: "page-1", targetInfo: { type: "page" } } });
  t.page({ attrs: { "@e4": { type: "password" } } });
  const box = await sealLogin(keeper.id, SHOP_RULE, "hunter2-unconfirmed guard");
  expect(await act("agentes:type_vault", ["e4", SHOP_RULE, box])).toMatchObject({
    success: false,
    code: "unguarded",
    error: UNGUARDED,
  });
  // Nothing reached the page.
  expect(batchesOf(t)).toHaveLength(0);
});

test.if(posix)(
  "a page that moves on between the check and the fill gets nothing: the fill finds no marked field",
  async () => {
    const t = setup();
    const act = (command: string, args: string[]) => t.act(command, args, { agent: keeper });
    await act("open", ["https://shop.example.com/login"]);
    t.page({ attrs: { "@e4": { type: "password" } }, navigateAfterCheck: "https://evil.test/login" });
    const password = "hunter2-moved-page";
    const out = await act("agentes:type_vault", ["e4", SHOP_RULE, await sealLogin(keeper.id, SHOP_RULE, password)]);
    expect(out).toMatchObject({ success: false });
    expect(JSON.stringify(out)).not.toContain(password);
    const state = JSON.parse(readFileSync(path.join(t.home, "ab-state.json"), "utf8"));
    expect(state.url).toBe("https://evil.test/login");
    expect(state.filled ?? []).toEqual([]);
  },
);

/** A Chrome whose DevTools socket the runner keeps (its traffic counter), and every such socket opened. */
function chromeWithDevtools() {
  const devtools: FakeSocket[] = [];
  const chromes = fakeChromes();
  const t = setup({
    startChrome: async (exe, args, profile) => ({
      ...(await chromes.start(exe, args, profile)),
      wsPath: "/devtools/browser/sized",
    }),
    connectDevtools: (url) => {
      const s = new FakeSocket(url);
      devtools.push(s);
      queueMicrotask(() => {
        s.onopen?.();
        s.push({ id: 1, result: {} });
      });
      return s;
    },
  });
  return { t, devtools, chromes: chromes.started };
}

const emulationOn = (socket: FakeSocket | undefined, sessionId: string) =>
  (socket?.sent ?? []).filter((m) => m.sessionId === sessionId && String(m.method).startsWith("Emulation."));

test.if(posix)(
  "agentes:viewport: every tab at a phone's size until changed back, the frames say so, and a closed browser forgets it",
  async () => {
    const { t, devtools, chromes } = chromeWithDevtools();
    // Refused before anything runs: no device, half a size, a size off the bounds.
    for (const args of [["watch"], ["phone", "375"], ["phone", "100", "667"]]) {
      expect(await errorCode(() => t.act("agentes:viewport", args))).toBe("bad_request");
    }
    expect(chromes).toHaveLength(0);
    // Chrome starts for it; the size goes to its tabs on the runner's own DevTools socket, never to agent-browser.
    expect(await t.act("agentes:viewport", ["phone"])).toMatchObject({
      success: true,
      data: { device: "phone", width: 390, height: 844 },
    });
    expect(t.logged().some((c) => c.args.includes("agentes:viewport"))).toBe(false);
    const cdp = devtools[0];
    cdp?.push({
      method: "Target.attachedToTarget",
      params: { sessionId: "tab-1", targetInfo: { type: "page", targetId: "t1" } },
    });
    expect(emulationOn(cdp, "tab-1").map((m) => m.method)).toEqual([
      "Emulation.setDeviceMetricsOverride",
      "Emulation.setTouchEmulationEnabled",
      "Emulation.setUserAgentOverride",
    ]);
    expect(emulationOn(cdp, "tab-1")[0]?.params).toMatchObject({
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true,
    });
    // The user agent is this Chrome's version, as Chrome on Android says it.
    expect(JSON.stringify(emulationOn(cdp, "tab-1")[2]?.params)).toContain("Chrome/156.0.0.0 Mobile Safari");
    // Every answer says it, so an agent in a later run is told.
    expect(await t.act("open", ["https://shop.example.com/"])).toMatchObject({
      emulated: { device: "phone", width: 390, height: 844 },
    });
    const dir = await t.folder();
    expect(
      await t.manager.batch(dev, dir, {
        op: "browser.batch",
        commands: [{ command: "get", args: ["url"], timeoutSeconds: 30 }],
      }),
    ).toMatchObject({ emulated: { device: "phone" } });
    // A full-page shot sizes the page itself (agent-browser leaves it at the window's pixel ratio): the size goes back.
    const sent = emulationOn(cdp, "tab-1").length;
    await t.act("screenshot", ["screenshots/whole.png"]);
    expect(emulationOn(cdp, "tab-1")).toHaveLength(sent);
    await t.act("screenshot", ["screenshots/whole.png", "--full"]);
    expect(emulationOn(cdp, "tab-1").slice(sent)[0]).toMatchObject({
      method: "Emulation.setDeviceMetricsOverride",
      params: { width: 390, deviceScaleFactor: 3, mobile: true },
    });
    await t.manager.streamStart(dev, "watch");
    t.sockets[0]?.push({ type: "frame", seq: 1, data: "/9j/A", metadata: { deviceWidth: 390, deviceHeight: 844 } });
    const frames = () => t.frames.filter((f) => f.type === "browser.frame");
    expect(frames().at(-1)).toMatchObject({ metadata: { deviceWidth: 390, deviceHeight: 844, emulated: "phone" } });
    // Chrome quits under it (a crash, an update): the next Chrome's tabs get the same size.
    chromes[0]?.close();
    await t.act("open", ["https://shop.example.com/"]);
    await waitFor(() => devtools.length === 2);
    devtools[1]?.push({
      method: "Target.attachedToTarget",
      params: { sessionId: "tab-2", targetInfo: { type: "page", targetId: "t2" } },
    });
    expect(emulationOn(devtools[1], "tab-2")[0]?.params).toMatchObject({ width: 390, mobile: true });
    // `desktop` alone ends it on every tab.
    const ended = await t.act("agentes:viewport", ["desktop"]);
    expect(ended).toMatchObject({ success: true, data: { device: "desktop" } });
    expect(ended).not.toHaveProperty("emulated");
    expect(
      emulationOn(devtools[1], "tab-2")
        .slice(3)
        .map((m) => m.method),
    ).toEqual([
      "Emulation.clearDeviceMetricsOverride",
      "Emulation.setTouchEmulationEnabled",
      "Emulation.setUserAgentOverride",
    ]);
    // An exact size, then the agent closes its browser: the next one opens at the window's own size.
    expect(await t.act("agentes:viewport", ["desktop", "1440", "900"])).toMatchObject({ success: true });
    await t.act("close");
    await t.act("open", ["https://shop.example.com/"]);
    await waitFor(() => devtools.length === 3);
    devtools[2]?.push({
      method: "Target.attachedToTarget",
      params: { sessionId: "tab-3", targetInfo: { type: "page", targetId: "t3" } },
    });
    expect(emulationOn(devtools[2], "tab-3")).toEqual([]);
  },
);

import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { EventEmitter } from "node:events";
import { realpath } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type AgentScope,
  DESKTOP_LIMITS,
  DESKTOP_TEXT_MAX,
  type DesktopAction,
  type DesktopLookReply,
  type DesktopPoint,
  type DesktopRegion,
  MAX_FRAME_BYTES,
  type MachineReplies,
  type RunnerDesktopInfo,
  type RunnerDesktopUseInfo,
} from "@agenteschat/adapters/machine-protocol";
import {
  HELPER_ENV,
  HELPER_TEXT_MAX,
  type HelperBox,
  type HelperErrorCode,
  type HelperHello,
  type HelperOp,
  type HelperRequests,
  type HelperSettle,
  type HelperSnapshot,
  type HelperStep,
  type HelperWindow,
  helperCommand,
} from "./desktop-helper";
import { type DesktopSystem, hostSystem } from "./desktop-session";
import {
  centerOf,
  contains,
  coveringWindow,
  type DesktopLook,
  type DesktopLookOptions,
  type DesktopRefs,
  type DesktopTarget,
  desktopLook,
  desktopRefs,
  intersect,
  type Point,
  quote,
  screenText,
  windowKey,
} from "./desktop-tree";
import { RunnerError } from "./errors";
import { readLines } from "./lines";
import { isAbsoluteRequest, resolveInRoots, resolveInWorkspace } from "./paths";
import { KeyedQueue } from "./queue";

/**
 * Desktop use (ADR 0062): the agent drives its own desktop (ADR 0058)
 * through a helper (`desktop-helper.py`), one per agent, started on its first
 * use and stopped after `HELPER_IDLE_MS` without one (its desktop stays on).
 *
 * - The helper runs as this process's own user, so desktop use is served
 *   only where this process is the agent's own OS user (system mode: the
 *   agent's worker, ADR 0057), never the runner's user nor one another agent
 *   shares (`ownUserRefusal`). The desktop itself is root's there (ADR 0058
 *   §10): the worker gets it through the supervisor (`WorkerLink.desktop`).
 * - One request at a time per agent. An action is checked against the screen
 *   as it is right then (the element still there, where the last look saw
 *   it, on the screen, nothing above it), done, settled and looked at again,
 *   in one op.
 * - Targets that would end the session are refused inside the session's and
 *   the panel's own apps. That is a convenience: the session's own config is
 *   the guard.
 * - The helper is the agent's process: its lines are capped and its replies
 *   checked, and it starts again after any violation or 3 failures in a row.
 */

const NEEDS_LINUX = "Desktop use runs on Linux computers with the agents' desktops only";
const RUNNER_USER =
  "Desktop use needs each agent to work as its own user on this computer (system mode): here every agent works as the runner's own user";
const INSTALL = "sudo apt install --no-install-recommends python3 python3-gi python3-xlib xdotool scrot at-spi2-core";
/** The command in backticks: the computer's page shows it to copy (`commandInReason`). */
const installReason = (missing: readonly string[]) =>
  `Install what desktop use needs: \`${INSTALL}\` (missing: ${missing.join(", ")})`;
const NO_TESSERACT =
  "Reading the screen's text needs tesseract: `sudo apt install --no-install-recommends tesseract-ocr tesseract-ocr-por`";
/** Reading a screen's text: at the lowest priority, in English and Portuguese, killed after this long. */
const OCR_MS = 10_000;
const OCR_LANGUAGES = "eng+por";
const userPath = () => process.env.PATH || "/usr/local/bin:/usr/bin:/bin";

/** After an action, the browser's numbers: quiet 120 ms after its first change, 400 ms for a late one, 2 s at most. */
const SETTLE: HelperSettle = { lateMs: 400, quietMs: 120, capMs: 2000 };
/**
 * Starting an app or opening a file: its window (or a change of the active one) is waited for first. A double
 * click doesn't wait for one: it mostly opens a folder in place, which would wait the whole 10 s.
 */
const APP_SETTLE: HelperSettle = { ...SETTLE, windowMs: 10_000 };
/** A helper request unanswered this long is a helper that hangs (its own calls give up within seconds). */
const REQUEST_MS = 30_000;
/** Keys go at a person's pace, about 85 ms apart (`typing_delays` in the helper): what each typed character may add to a request's time. */
const MS_PER_CHARACTER = 120;
/** A desktop just started: its session's accessibility bus comes up within seconds. */
const SESSION_READY_MS = 20_000;
const SESSION_POLL_MS = 300;
const FAILURES_MAX = 3;
const SWEEP_MS = 60_000;
/** A helper nobody used for this long stops; its desktop goes on. */
export const HELPER_IDLE_MS = 15 * 60_000;
/** About what one wheel click scrolls, and the most clicks one action sends. */
const WHEEL_PIXELS = 60;
const WHEEL_MAX = 50;
const APPS_MAX = 500;
const JPEG_QUALITY = 70;
const REF = /^e\d{1,9}$/;
const APP_ID = /^[A-Za-z0-9_.+-]+\.desktop$/;
const PACKAGE = /^[a-z0-9][a-z0-9.+-]{0,40}$/;
/** What a list opened by `select` offers. */
const OPTIONS = new Set(["menuitem", "menuitemradio", "menuitemcheckbox", "listitem", "cell", "treeitem"]);

/** The session's and the panel's own apps, and the desktop's menu: their Log Out ends the agent's desktop. */
const SESSION_APPS = /^(xfce4-panel|xfce4-session(-logout)?|xfdesktop|wrapper-[\d.]+)$/i;
/** What ends the session, in English and pt-BR, as `plain` writes it. */
const SESSION_ENDING = new Set([
  "log out",
  "logout",
  "log off",
  "shut down",
  "shutdown",
  "power off",
  "restart",
  "reboot",
  "suspend",
  "hibernate",
  "hybrid sleep",
  "lock screen",
  "lock",
  "switch user",
  "sair",
  "encerrar sessao",
  "terminar sessao",
  "desligar",
  "reiniciar",
  "suspender",
  "hibernar",
  "suspensao hibrida",
  "bloquear tela",
  "bloquear",
  "trocar usuario",
  "trocar de usuario",
  "alternar usuario",
]);
/** XFCE's keys that log out and lock, and X's own zap, as `xKey` writes them. */
const SESSION_KEYS = new Set(["ctrl+alt+Delete", "ctrl+alt+l", "ctrl+alt+BackSpace"]);
/** Desktop entries that log out or lock. */
const SESSION_ENTRIES = /^(xfce4-session-logout|xflock4)\.desktop$/i;

/** A name as compared: no accents, lowercase, single spaces, no dots or ellipsis at the end. */
const plain = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[\s.…]+$/u, "")
    .replace(/\s+/g, " ")
    .trim();

const MODIFIERS: Record<string, string> = {
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  option: "alt",
  shift: "shift",
  super: "super",
  meta: "super",
  cmd: "super",
  command: "super",
  win: "super",
};
const MODIFIER_ORDER = ["ctrl", "alt", "shift", "super"];
const KEY_NAMES: Record<string, string> = {
  enter: "Return",
  return: "Return",
  esc: "Escape",
  escape: "Escape",
  tab: "Tab",
  space: "space",
  backspace: "BackSpace",
  delete: "Delete",
  del: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  pageup: "Page_Up",
  pagedown: "Page_Down",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  arrowup: "Up",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
  menu: "Menu",
  contextmenu: "Menu",
  print: "Print",
  printscreen: "Print",
  capslock: "Caps_Lock",
  plus: "plus",
  ".": "period",
  ",": "comma",
  "/": "slash",
  "\\": "backslash",
  "-": "minus",
  "=": "equal",
  ";": "semicolon",
  "'": "apostrophe",
  "`": "grave",
  "[": "bracketleft",
  "]": "bracketright",
};

/**
 * A key combination as xdotool names it, modifiers first in one order (`Control+Shift+T` → `ctrl+shift+t`,
 * `Enter` → `Return`, `alt+ctrl+del` → `ctrl+alt+Delete`); null when it isn't one.
 */
export function xKey(input: string): string | null {
  const raw = input.trim();
  if (!raw || raw.length > DESKTOP_LIMITS.key) return null;
  const parts = (raw === "+" ? "plus" : raw.replace(/\+\+$/, "+plus")).split("+").map((p) => p.trim());
  const key = parts.pop() ?? "";
  const mods = new Set<string>();
  for (const p of parts) {
    const m = MODIFIERS[p.toLowerCase()];
    if (!m) return null;
    mods.add(m);
  }
  let name = KEY_NAMES[key] ?? KEY_NAMES[key.toLowerCase().replace(/[\s_-]/g, "")] ?? MODIFIERS[key.toLowerCase()];
  if (!name) {
    if (/^f([1-9]|1\d|2[0-4])$/i.test(key)) name = key.toUpperCase();
    // With a modifier, a capital would add Shift to the combination.
    else if (/^[A-Za-z0-9]$/.test(key)) name = mods.size > 0 ? key.toLowerCase() : key;
    else if (/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) name = key;
    else return null;
  }
  return [...MODIFIER_ORDER.filter((m) => mods.has(m)), name].join("+");
}

/** System mode: the uid each agent works as, and the runner's own (ADR 0058 §10). */
export interface AgentUids {
  runner: number;
  agents: ReadonlyMap<string, number>;
}

/**
 * Why an agent can't use its desktop here, or null when it can (ADR 0062 §3). The helper runs as `own` (this
 * process's uid, or its launcher's), which must be the agent's own user: neither the runner's nor any other agent's. A
 * desktop has a terminal, and whoever drives it reads everything its user can; the runner's user holds every
 * agent's delivered secrets and the computer's token. `agentId` null: whether this process could serve any.
 */
export function ownUserRefusal(agentId: string | null, own: number | null, uids: AgentUids | null): string | null {
  if (!uids || own === null || own === 0 || own === uids.runner) return RUNNER_USER;
  if (agentId === null) return null;
  if (uids.agents.get(agentId) !== own) {
    return "Desktop use runs as the agent's own user on this computer, and this agent works as another user";
  }
  for (const [id, uid] of uids.agents) {
    if (id !== agentId && uid === own) {
      return "This agent shares its user on this computer with another agent: desktop use needs a user of its own";
    }
  }
  return null;
}

/** The ops of desktop use: system mode runs them in the agent's worker (`OP_ROUTES`). */
export const DESKTOP_USE_OPS: ReadonlySet<string> = new Set([
  "desktop.look",
  "desktop.act",
  "desktop.capture",
  "desktop.apps",
  "desktop.text",
]);

/**
 * The agents' desktops as desktop use needs them (`DesktopSessions`, or in a worker the supervisor's): the
 * agent's starts on its first use and is kept up while it is used; where it runs, never its VNC passwords.
 */
export interface DesktopUseSessions {
  info(): RunnerDesktopInfo;
  ensure(agent: AgentScope): Promise<MachineReplies["desktop.session.start"]>;
  session(agentId: string): { display: number; xauthority: string; home: string } | null;
}

export interface DesktopManagerOptions {
  desktops: DesktopUseSessions;
  /** System mode: who each agent works as (`ownUserRefusal`). Absent or null: every agent is the runner's user. */
  uids?: () => AgentUids | null;
  /**
   * System mode, in root: each agent's worker serves its desktop use as the agent's own user (`OP_ROUTES`), so
   * this one only says whether the computer can (`info`) and serves none itself.
   */
  workers?: boolean;
  /** Root (system mode's `desktop-check`): the helper starts through the agent's launcher, as its `uid`. */
  launcher?: { prefix: string[]; uid: number };
  /** The agent's delivered secrets: everything it reads is redacted with them (`agentSecrets`). */
  secrets?: (agent: AgentScope) => Promise<DesktopLookOptions["secrets"]>;
  /** The agent browser's Chrome while it runs: its window is one line in a look, and its tree isn't read. */
  browserPid?: (agentId: string) => number | null;
  /**
   * How many refs each agent was given (`desktopRefs`), from whoever outlives this manager (the daemon,
   * across connections): numbers never come back for other elements. Default: this manager's own.
   */
  numbered?: Map<string, { last: number }>;
  log: (line: string) => void;
  /** Tests: the computer. */
  system?: Pick<DesktopSystem, "platform" | "uid" | "which">;
  /** Tests: how a helper starts (default: `python3 -I -c <source>`). */
  command?: string[];
  idleMs?: number;
  requestMs?: number;
  now?: () => number;
}

/** Where `open_file` may look: the agent's folder (relative paths) and the folders allowed for it (real paths). */
export interface DesktopWhere {
  folder: string;
  grants?: string[];
}

/** One agent's use of its desktop. */
interface Use {
  agent: AgentScope;
  display: number;
  xauthority: string;
  home: string;
  /** When the desktop started (ms). */
  since: number;
  refs: DesktopRefs;
  /** The last look, with the windows it saw. */
  last: { look: DesktopLook; windows: HelperWindow[] } | null;
  helper: Helper | null;
  lastUsed: number;
  /** The helper's own failures in a row (`internal`, `unavailable`). */
  failures: number;
  /** The hash of the last capture whose text `desktop.text` read. */
  read?: string;
  /** A person took control during the `act` under way. */
  taken?: boolean;
}

/** Where an action lands: a point, and the element of the last look it is on. */
interface Spot {
  point: Point;
  ref?: string;
  target?: DesktopTarget;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => Number.isInteger(v);
const isString = (v: unknown): v is string => typeof v === "string";
const isBox = (v: unknown): v is HelperBox => Array.isArray(v) && v.length === 4 && v.every(isInt);
const isPair = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && v.every(isInt);
const isWindow = (w: unknown): w is HelperWindow =>
  isRecord(w) &&
  isInt(w.xid) &&
  isInt(w.stack) &&
  typeof w.active === "boolean" &&
  typeof w.override === "boolean" &&
  Array.isArray(w.class) &&
  w.class.length === 2 &&
  w.class.every(isString) &&
  isString(w.title) &&
  (w.pid === null || isInt(w.pid)) &&
  isBox(w.box) &&
  Array.isArray(w.types) &&
  w.types.every(isString);
const isNode = (n: unknown) =>
  isRecord(n) &&
  isString(n.path) &&
  (n.parent === null || isString(n.parent)) &&
  isInt(n.index) &&
  isInt(n.children) &&
  isString(n.role) &&
  isString(n.name) &&
  Array.isArray(n.states) &&
  n.states.length <= 2 &&
  n.states.every(isInt) &&
  Array.isArray(n.ifaces) &&
  n.ifaces.every(isString) &&
  (n.box === undefined || isBox(n.box)) &&
  (n.text === undefined || isString(n.text));
const isSnapshot = (s: unknown): s is HelperSnapshot =>
  isRecord(s) &&
  isPair(s.screen) &&
  Array.isArray(s.windows) &&
  s.windows.every(isWindow) &&
  Array.isArray(s.apps) &&
  s.apps.every(
    (a) =>
      isRecord(a) &&
      isString(a.bus) &&
      (a.pid === null || isInt(a.pid)) &&
      isString(a.name) &&
      (a.nodes === undefined || (Array.isArray(a.nodes) && a.nodes.every(isNode))) &&
      (a.error === undefined || isString(a.error)),
  );
const isHello = (h: unknown): h is HelperHello =>
  isRecord(h) &&
  (h.screen === null || isPair(h.screen)) &&
  typeof h.a11y === "boolean" &&
  Array.isArray(h.missing) &&
  h.missing.every(isString) &&
  (h.problem === undefined || isString(h.problem));
const isRegion = (r: unknown): r is DesktopRegion =>
  isRecord(r) && isInt(r.x) && isInt(r.y) && isInt(r.width) && isInt(r.height);

const bad = (message: string) => new RunnerError("bad_request", message);
const staleRef = (ref: string) => new RunnerError("not_found", `stale ref: ${ref} is no longer on the screen`);
const sessionRefused = (what: string) =>
  bad(`${quote(what)} would end the agent's desktop session; that is refused (log in and out by taking control)`);
const endsSession = (t: DesktopTarget) =>
  t.xid === undefined && SESSION_APPS.test(t.app) && SESSION_ENDING.has(plain(t.name));
const sameBox = (a: HelperBox, b: HelperBox) => a.every((v, i) => v === b[i]);
const lookReply = (l: DesktopLook): DesktopLookReply => ({
  snapshot: l.snapshot,
  refs: l.refs,
  address: l.address,
  title: l.title,
  screen: l.screen,
});

/** A refusal in the helper's own words. */
class HelperFailure extends Error {
  constructor(
    readonly code: HelperErrorCode,
    message: string,
  ) {
    super(message);
  }
}
const HELPER_CODES: readonly HelperErrorCode[] = [
  "bad_request",
  "unavailable",
  "stale",
  "failed",
  "mismatch",
  "stopped",
  "internal",
];

const tookOver = () =>
  bad(
    "A person took control of your desktop, so this stopped where it was. What it typed so far stays there: don't type it again, look at the screen before going on.",
  );

/** The helper's refusal as the agent reads it; a gone element is named by its ref, in the plan's words. */
function helperError(err: HelperFailure, ref?: string): RunnerError {
  switch (err.code) {
    case "stale":
      return ref ? staleRef(ref) : new RunnerError("not_found", `stale: ${err.message}`);
    case "mismatch":
      return bad("the text didn't come out as written");
    case "stopped":
      return tookOver();
    case "failed":
    case "bad_request":
      return bad(err.message);
    case "unavailable":
      return new RunnerError("desktop_unavailable", err.message);
    default:
      return new RunnerError("internal", `The desktop helper failed: ${err.message}`);
  }
}

/** A running helper: one request at a time, each answered by one line. */
class Helper {
  private readonly child: ChildProcessWithoutNullStreams;
  private next = 1;
  private pending: {
    id: number;
    op: HelperOp;
    resolve: (data: unknown) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private stderr = "";
  private exited = false;
  gone = false;

  constructor(
    command: string[],
    opts: { cwd: string; env: Record<string, string> },
    private readonly onGone: (helper: Helper, why: string | null) => void,
  ) {
    const [file = "", ...args] = command;
    this.child = spawn(file, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] });
    readLines(
      this.child.stdout,
      MAX_FRAME_BYTES,
      (line) => this.line(line),
      () => this.violation("a line too long"),
    );
    this.child.stderr.on("data", (d: Buffer) => {
      this.stderr = (this.stderr + d.toString("utf8")).slice(-2000);
    });
    this.child.stdin.on("error", () => undefined);
    const events = this.child as unknown as EventEmitter;
    events.once("error", (err: Error) => {
      this.exited = true;
      const why = `it couldn't start (${err.message})`;
      this.finish(new RunnerError("desktop_unavailable", `The desktop helper ${why}`), why);
    });
    events.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      this.exited = true;
      const last = this.stderr.trim().split("\n").pop()?.slice(0, 200) ?? "";
      const why = `it exited (${signal ?? `code ${code}`})${last ? `: ${last}` : ""}`;
      this.finish(
        new RunnerError("desktop_unavailable", "The desktop helper stopped. It starts again on the next use."),
        why,
      );
    });
  }

  request(op: HelperOp, body: object, timeoutMs: number): Promise<unknown> {
    if (this.gone) return Promise.reject(new RunnerError("desktop_unavailable", "The desktop helper stopped"));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.violation(`no answer to ${op} in ${Math.round(timeoutMs / 1000)} s`),
        timeoutMs,
      );
      this.pending = { id, op, resolve, reject, timer };
      this.child.stdin.write(`${JSON.stringify({ ...body, id, op })}\n`);
    });
  }

  /** Its `input` under way, if any, stops at its next key or step. It reads no request until that one is done. */
  stopInput() {
    if (this.pending?.op === "input") this.child.kill("SIGUSR1");
  }

  /** Stops it (stdin closed and SIGTERM: it removes its own files), SIGKILL when it doesn't go. */
  kill() {
    this.finish(new RunnerError("desktop_unavailable", "The desktop helper was stopped"), null);
    this.child.stdin.end();
    if (this.exited) return;
    this.child.kill("SIGTERM");
    setTimeout(() => {
      if (!this.exited) this.child.kill("SIGKILL");
    }, 2000).unref?.();
  }

  private line(raw: string) {
    let reply: unknown;
    try {
      reply = JSON.parse(raw);
    } catch {
      this.violation("a line that isn't JSON");
      return;
    }
    const p = this.pending;
    if (!p || !isRecord(reply) || reply.id !== p.id) {
      this.violation("an answer to nothing it was asked");
      return;
    }
    this.pending = null;
    clearTimeout(p.timer);
    if (reply.ok === true) p.resolve(reply.data);
    else {
      const code = HELPER_CODES.find((c) => c === reply.code) ?? "internal";
      p.reject(new HelperFailure(code, isString(reply.error) ? reply.error.slice(0, 500) : "it failed"));
    }
  }

  private violation(why: string) {
    this.finish(
      new RunnerError("internal", `The desktop helper misbehaved (${why}). It starts again on the next use.`),
      why,
    );
    this.child.kill("SIGKILL");
  }

  private finish(error: RunnerError, why: string | null) {
    if (this.gone) return;
    this.gone = true;
    const p = this.pending;
    this.pending = null;
    if (p) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.onGone(this, why);
  }
}

/**
 * Each agent's use of its own desktop (ADR 0062): `desktop.look`, `desktop.act`, `desktop.capture`, `desktop.apps`;
 * and `desktop.text`, its screen's text for screening a person in control (ADR 0076).
 */
export class DesktopManager {
  private readonly uses = new Map<string, Use>();
  private readonly queue = new KeyedQueue();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  /** What a helper found missing (Python's gi and Xlib, which a PATH lookup can't see), until one finds nothing. */
  private missing: string[] = [];
  private readonly sys: Pick<DesktopSystem, "platform" | "uid" | "which">;
  private readonly now: () => number;
  private readonly requestMs: number;
  private readonly numbered: Map<string, { last: number }>;

  constructor(private readonly opts: DesktopManagerOptions) {
    this.sys = opts.system ?? hostSystem();
    this.now = opts.now ?? Date.now;
    this.requestMs = opts.requestMs ?? REQUEST_MS;
    this.numbered = opts.numbered ?? new Map();
  }

  /** Who the helper runs as. */
  private get helperUid() {
    return this.opts.launcher?.uid ?? this.sys.uid;
  }

  /** `hello.desktopUse`: whether agents can use their desktops here, and what is missing when they can't. */
  info(): RunnerDesktopUseInfo {
    if (this.sys.platform !== "linux") return { available: false, reason: NEEDS_LINUX, code: "desktop_use_linux" };
    const refusal = this.opts.workers ? null : ownUserRefusal(null, this.helperUid, this.opts.uids?.() ?? null);
    if (refusal) return { available: false, reason: refusal, code: "desktop_use_own_user" };
    const desktops = this.opts.desktops.info();
    if (!desktops.available) {
      return {
        available: false,
        reason: desktops.reason ?? "The agents' desktops can't run on this computer",
        code: desktops.code ?? "desktop_unavailable",
      };
    }
    const tools = ["python3", "xdotool", "scrot"].filter((c) => !this.sys.which(c));
    const missing = [...new Set([...tools, ...this.missing])];
    return missing.length > 0
      ? { available: false, reason: installReason(missing), code: "desktop_use_install" }
      : { available: true };
  }

  look(agent: AgentScope): Promise<DesktopLookReply> {
    return this.serial(agent, async (use) => lookReply(await this.lookNow(use)));
  }

  /** One action, checked against the screen as it is now; with `settle`, the screen settles and is looked at. */
  async act(
    agent: AgentScope,
    action: unknown,
    settle: boolean,
    where: DesktopWhere,
  ): Promise<MachineReplies["desktop.act"]> {
    const a = parseAction(action);
    return this.serial(agent, (use) => {
      use.taken = false;
      return this.actNow(use, a, settle, where);
    });
  }

  /** A person took control of the agent's desktop: its keys and pointer path under way stop at the next key or step. */
  stopInput(agentId: string) {
    const use = this.uses.get(agentId);
    if (!use) return;
    use.taken = true;
    use.helper?.stopInput();
  }

  /** The screen (or a region of it) as a JPEG, with the last look's elements. */
  async capture(agent: AgentScope, region: unknown): Promise<MachineReplies["desktop.capture"]> {
    const r = region === undefined || region === null ? null : parseRegion(region);
    return this.serial(agent, async (use) => {
      const look = use.last?.look ?? (await this.lookNow(use));
      const shot = await this.call(
        use,
        "capture",
        r ? { region: r, quality: JPEG_QUALITY } : { quality: JPEG_QUALITY },
      );
      if (
        !isRecord(shot) ||
        !isString(shot.jpeg) ||
        !isInt(shot.width) ||
        !isInt(shot.height) ||
        !(shot.region === null || isRegion(shot.region))
      ) {
        throw this.malformed(use, "screenshot");
      }
      return {
        data: shot.jpeg,
        width: shot.width,
        height: shot.height,
        screen: look.screen,
        region: shot.region,
        marks: look.marks,
      };
    });
  }

  /**
   * The screen's text, read here by tesseract as the agent's own user from a capture; the image never leaves.
   * No look is taken, so the agent's refs and its last look stay as they were.
   */
  async text(agent: AgentScope): Promise<MachineReplies["desktop.text"]> {
    const tesseract = this.sys.which("tesseract");
    if (!tesseract) throw new RunnerError("desktop_unavailable", NO_TESSERACT);
    return this.serial(agent, async (use) => {
      const shot = await this.call(use, "capture", { quality: JPEG_QUALITY });
      if (!isRecord(shot) || !isString(shot.jpeg)) throw this.malformed(use, "screenshot");
      const hash = createHash("sha256").update(shot.jpeg).digest("base64");
      if (hash === use.read) return { same: true };
      const text = await this.ocr(use, tesseract, Buffer.from(shot.jpeg, "base64"));
      use.read = hash;
      return { text };
    });
  }

  /** The apps a person could start from the menu, by name; those that end the session aren't offered. */
  apps(agent: AgentScope): Promise<MachineReplies["desktop.apps"]> {
    return this.serial(agent, async (use) => {
      const list = await this.call(use, "apps", {});
      if (!Array.isArray(list)) throw this.malformed(use, "app list");
      const apps = list
        .filter(
          (a): a is { id: string; name: string; generic: unknown } =>
            isRecord(a) &&
            isString(a.id) &&
            a.id.length <= DESKTOP_LIMITS.path &&
            APP_ID.test(a.id) &&
            !SESSION_ENTRIES.test(a.id) &&
            isString(a.name),
        )
        .map((a) => {
          const generic = isString(a.generic) ? screenText(a.generic).slice(0, 200) : "";
          return { id: a.id, name: screenText(a.name).slice(0, 200), ...(generic ? { generic } : {}) };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      return { apps: apps.slice(0, APPS_MAX) };
    });
  }

  /** Helpers nobody used for the idle time stop (their desktops go on). */
  sweep() {
    const idleMs = this.opts.idleMs ?? HELPER_IDLE_MS;
    for (const use of this.uses.values()) {
      if (!use.helper || this.queue.busy(use.agent.id) || this.now() - use.lastUsed < idleMs) continue;
      this.opts.log(
        `the desktop helper of ${use.agent.handle} stopped: nobody used it for ${Math.round(idleMs / 60_000)} minutes`,
      );
      this.stop(use);
    }
    if (![...this.uses.values()].some((u) => u.helper)) this.disarm();
  }

  /** Every helper stops (the session ended, or a switch went off). */
  stopAll() {
    for (const use of this.uses.values()) this.stop(use);
    this.uses.clear();
    this.disarm();
  }

  private serial<T>(agent: AgentScope, fn: (use: Use) => Promise<T>): Promise<T> {
    return this.queue.run(agent.id, async () => fn(await this.use(agent)));
  }

  /** The agent's desktop, started when it isn't running; a desktop that started afresh gets a new helper and refs. */
  private async use(agent: AgentScope): Promise<Use> {
    if (this.sys.platform !== "linux") throw new RunnerError("desktop_unavailable", NEEDS_LINUX);
    // Root in system mode serves none: `OP_ROUTES` sends these to the agent's worker.
    const refusal = this.opts.workers
      ? RUNNER_USER
      : ownUserRefusal(agent.id, this.helperUid, this.opts.uids?.() ?? null);
    if (refusal) throw new RunnerError("desktop_unavailable", refusal);
    const started = await this.opts.desktops.ensure(agent);
    const s = this.opts.desktops.session(agent.id);
    if (!s) throw new RunnerError("desktop_unavailable", "The agent's desktop stopped. Try again.");
    const at = Date.parse(started.startedAt);
    const since = Number.isFinite(at) ? at : 0;
    let use = this.uses.get(agent.id);
    // Another desktop than the helper's (started again, by a person or after it ended): what was on it is gone.
    if (
      !use ||
      started.started ||
      use.since !== since ||
      use.display !== s.display ||
      use.xauthority !== s.xauthority
    ) {
      if (use) this.stop(use);
      let numbered = this.numbered.get(agent.id);
      if (!numbered) {
        numbered = { last: 0 };
        this.numbered.set(agent.id, numbered);
      }
      use = {
        agent,
        display: s.display,
        xauthority: s.xauthority,
        home: s.home,
        since,
        refs: desktopRefs(numbered),
        last: null,
        helper: null,
        lastUsed: 0,
        failures: 0,
      };
      this.uses.set(agent.id, use);
    }
    use.agent = agent;
    use.lastUsed = this.now();
    return use;
  }

  private async lookNow(use: Use): Promise<DesktopLook> {
    const pid = this.opts.browserPid?.(use.agent.id) ?? null;
    const browserPids = pid ? [pid] : [];
    const secrets = (await this.opts.secrets?.(use.agent)) ?? null;
    for (;;) {
      const snap = await this.call(use, "snapshot", { scope: "front", textMax: HELPER_TEXT_MAX, skip: browserPids });
      if (!isSnapshot(snap)) throw this.malformed(use, "snapshot");
      let look: DesktopLook;
      try {
        look = desktopLook(snap, use.refs, { browserPids, secrets, textMax: HELPER_TEXT_MAX });
      } catch {
        throw this.malformed(use, "snapshot");
      }
      // A desktop that just started has nothing to act on until its panel's elements answer (seconds).
      if (Object.keys(look.refs).length > 0 || !this.fresh(use)) {
        use.last = { look, windows: snap.windows };
        return look;
      }
      await sleep(SESSION_POLL_MS);
    }
  }

  private async actNow(
    use: Use,
    a: DesktopAction,
    settle: boolean,
    where: DesktopWhere,
  ): Promise<MachineReplies["desktop.act"]> {
    let steps: HelperStep[];
    let spec = SETTLE;
    let ref: string | undefined;
    switch (a.kind) {
      case "click":
      case "double_click":
      case "right_click":
      case "hover":
      case "focus":
      case "check":
      case "uncheck": {
        const spot = await this.spot(use, a.at, a.kind);
        ref = spot.ref;
        steps = pointerSteps(a.kind, spot);
        break;
      }
      case "drag": {
        const [from, to] = (await this.spots(use, [a.from, a.to], a.kind)) as [Spot, Spot];
        steps = [{ drag: [...from.point, ...to.point] }];
        break;
      }
      case "fill": {
        const spot = await this.spot(use, a.at, a.kind);
        ref = spot.ref;
        const node = spot.target?.editable ? spot.target.node : undefined;
        steps = node
          ? [{ fill: node, text: a.text }]
          : [{ click: spot.point }, { key: "ctrl+a" }, a.text ? { type: a.text } : { key: "BackSpace" }];
        break;
      }
      case "type": {
        const spot = a.at ? await this.spot(use, a.at, a.kind) : null;
        ref = spot?.ref;
        steps = [...(spot ? [{ click: spot.point }] : []), { type: a.text }];
        break;
      }
      case "select":
        ref = a.at.ref;
        steps = await this.optionSteps(use, a.at.ref, a.value);
        break;
      case "press":
        steps = [{ key: a.key }];
        break;
      case "scroll": {
        const spot = a.at ? await this.spot(use, a.at, a.kind) : null;
        ref = spot?.ref;
        const clicks = Math.min(WHEEL_MAX, Math.max(1, Math.round(a.pixels / WHEEL_PIXELS)));
        const signed = a.direction === "up" || a.direction === "left" ? -clicks : clicks;
        const point = spot?.point ?? this.activeCenter(use);
        steps = [
          a.direction === "up" || a.direction === "down"
            ? { scroll: point, dy: signed }
            : { scroll: point, dx: signed },
        ];
        break;
      }
      case "launch":
        steps = [{ launch: a.app }];
        spec = APP_SETTLE;
        break;
      case "open_file":
        steps = [{ open: await this.openable(use, a.path, where) }];
        spec = APP_SETTLE;
        break;
      case "pause":
        steps = [{ pause: a.ms }];
        break;
    }
    let settled: boolean | undefined;
    if (steps.length > 0) settled = await this.input(use, steps, settle ? spec : null, ref);
    if (!settle) return {};
    const look = await this.lookNow(use);
    return { look: lookReply(look), ...(settled === false ? { settled: false } : {}) };
  }

  /** Sends input steps; `settled`: whether the screen settled before the wait's cap (with a settle). */
  private async input(use: Use, steps: HelperStep[], spec: HelperSettle | null, ref?: string) {
    if (use.taken) throw tookOver();
    let typed = 0;
    let paused = 0;
    for (const s of steps) {
      if ("type" in s) typed += s.type.length;
      if ("pause" in s) paused += s.pause;
    }
    const wait = spec ? (spec.windowMs ?? 0) + (spec.capMs ?? 0) : 0;
    const timeout = this.requestMs + typed * MS_PER_CHARACTER + paused + wait;
    const out = await this.call(use, "input", spec ? { steps, settle: spec } : { steps }, timeout, ref);
    if (!isRecord(out) || !isInt(out.ms)) throw this.malformed(use, "answer to input");
    return typeof out.settled === "boolean" ? out.settled : undefined;
  }

  /**
   * Where each point lands, checked against the screen as it is right now: an element is still there, has
   * the box the last look saw, is on the screen and nothing is above it (a window to activate only needs to
   * be there); a point is on the screen. Neither may end the session.
   */
  private async spots(use: Use, points: DesktopPoint[], kind: DesktopAction["kind"]): Promise<Spot[]> {
    const last = lastLook(use, points);
    const { look } = last;
    const screen: HelperBox = [0, 0, look.screen.width, look.screen.height];
    const wanted = points.map((p): Spot => {
      if ("ref" in p) {
        const target = look.targets[p.ref];
        if (!target) throw staleRef(p.ref);
        return { ref: p.ref, target, point: [0, 0] };
      }
      const point: Point = [Math.round(p.x), Math.round(p.y)];
      if (!contains(screen, point)) {
        throw bad(`${point[0]}, ${point[1]} is off the screen (${look.screen.width}×${look.screen.height})`);
      }
      return { point };
    });
    for (const w of wanted) {
      const t = w.target ?? elementAt(look, w.point);
      if (t && endsSession(t)) throw sessionRefused(t.name);
      if (kind === "focus" && w.target?.xid === undefined) {
        throw bad("focus takes a window: a window's line, or the panel's button for it");
      }
    }
    if (wanted.every((w) => !w.target)) return wanted;
    const nodes = wanted.flatMap((w) => (w.target?.node ? [w.target.node] : []));
    const fresh = await this.call(use, "extents", { nodes });
    if (
      !isRecord(fresh) ||
      !isRecord(fresh.boxes) ||
      !Object.values(fresh.boxes).every((b) => b === null || isBox(b)) ||
      !Array.isArray(fresh.windows) ||
      !fresh.windows.every(isWindow)
    ) {
      throw this.malformed(use, "answer to extents");
    }
    const boxes = fresh.boxes as Record<string, HelperBox | null>;
    const windows = fresh.windows as HelperWindow[];
    return wanted.map((w): Spot => {
      const { ref, target: t } = w;
      if (!ref || !t) return w;
      const box = t.node ? boxes[`${t.node[0]} ${t.node[1]}`] : undefined;
      if (activates(kind, t)) {
        // A panel's button for a window says it is there (minimized too); a window's own line needs it showing.
        if (t.node ? !box : !windows.some((x) => x.xid === t.xid)) throw staleRef(ref);
        return w;
      }
      const own = windows.find((x) => x.xid === t.window);
      if (!own) throw staleRef(ref);
      const now = t.node ? box : own.box;
      if (!now || now[2] <= 0 || now[3] <= 0) throw staleRef(ref);
      // GTK4 answers every screen position as (0, 0): the look took its boxes from window coordinates.
      const gtk4 = now[0] === 0 && now[1] === 0 && now[2] === t.extents[2] && now[3] === t.extents[3];
      if (!sameBox(now, t.extents) && !gtk4) {
        throw new RunnerError("not_found", `stale ref: ${ref} moved since the last look`);
      }
      const center = centerOf(t.box);
      if (!contains(intersect(own.box, screen), center)) throw staleRef(ref);
      const cover = coveringWindow(windows, own, center);
      if (cover) throw bad(`covered by ${this.coverName(use, cover)}`);
      return { ref, target: t, point: [Math.round(center[0]), Math.round(center[1])] };
    });
  }

  private async spot(use: Use, at: DesktopPoint, kind: DesktopAction["kind"]): Promise<Spot> {
    return (await this.spots(use, [at], kind))[0] as Spot;
  }

  /** `select`: the element's list opened, then its option named `value` clicked; closed again when it has none. */
  private async optionSteps(use: Use, ref: string, value: string): Promise<HelperStep[]> {
    const opener = await this.spot(use, { ref }, "click");
    await this.input(use, [{ click: opener.point }], SETTLE, ref);
    const look = await this.lookNow(use);
    const popups = new Set(use.last?.windows.filter((w) => w.override).map((w) => w.xid));
    const want = plain(value);
    const named = Object.entries(look.targets).filter(([, t]) => OPTIONS.has(t.role) && plain(t.name) === want);
    const option = named.find(([, t]) => popups.has(t.window)) ?? named[0];
    if (!option) {
      await this.input(use, [{ key: "Escape" }], SETTLE);
      throw bad(`There is no option ${quote(value)} in ${ref}`);
    }
    const pick = await this.spot(use, { ref: option[0] }, "click");
    return [{ click: pick.point }];
  }

  /**
   * What covers a target, as the plan says it: a window by the number its line has in a look, never its
   * title, since this reaches the agent outside the untrusted screen text and a title is screen text (a
   * web page sets its window's).
   */
  private coverName(use: Use, w: HelperWindow): string {
    if (w.override) return "a menu or popup";
    if (w.types.includes("dock")) return "the panel";
    if (w.pid !== null && w.pid === this.opts.browserPid?.(use.agent.id)) return "your browser's window";
    return `window ${use.refs(windowKey(w.xid))}`;
  }

  /** The active window's center (a scroll with no element), else the screen's. */
  private activeCenter(use: Use): Point {
    const last = lastLook(use, []);
    const screen: HelperBox = [0, 0, last.look.screen.width, last.look.screen.height];
    const active = last.windows.find((w) => w.active && !w.override);
    const [x, y] = centerOf(active ? intersect(active.box, screen) : screen);
    return [Math.round(x), Math.round(y)];
  }

  /** `open_file`: an existing file in the agent's folder, or an absolute path in its desktop's home or a granted folder. */
  private async openable(use: Use, input: string, where: DesktopWhere): Promise<string> {
    const found = isAbsoluteRequest(input)
      ? await resolveInRoots([await realpath(use.home), ...(where.grants ?? [])], input)
      : await resolveInWorkspace(where.folder, input);
    if (!found.exists) throw new RunnerError("not_found", `There is no file ${input}`);
    return found.abs;
  }

  /** One helper request; a helper starts when there is none. Its own failures map to the agent's words. */
  private async call<K extends HelperOp>(
    use: Use,
    op: K,
    body: HelperRequests[K],
    timeoutMs = this.requestMs,
    ref?: string,
  ): Promise<unknown> {
    const helper = use.helper ?? (await this.start(use));
    try {
      const data = await helper.request(op, body, timeoutMs);
      use.failures = 0;
      return data;
    } catch (err) {
      if (!(err instanceof HelperFailure)) throw err;
      if (err.code === "internal" || err.code === "unavailable") {
        use.failures++;
        if (use.failures >= FAILURES_MAX) {
          this.opts.log(
            `the desktop helper of ${use.agent.handle} failed ${FAILURES_MAX} times in a row; starting it again`,
          );
          this.stop(use);
        }
      } else use.failures = 0;
      throw helperError(err, ref);
    }
  }

  /** tesseract on a capture, as this process's user (or the launcher's). The error never carries its output. */
  private ocr(use: Use, tesseract: string, jpeg: Buffer): Promise<string> {
    const [file = "", ...args] = [
      ...(this.opts.launcher?.prefix ?? []),
      ...["nice", "-n", "19", tesseract, "stdin", "stdout", "-l", OCR_LANGUAGES],
    ];
    return new Promise((resolve, reject) => {
      const child = execFile(
        file,
        args,
        {
          cwd: use.home,
          env: { HOME: use.home, PATH: userPath() },
          timeout: OCR_MS,
          killSignal: "SIGKILL",
          maxBuffer: 1024 * 1024,
        },
        (err, stdout) => {
          if (!err) return resolve(stdout.trim().slice(0, DESKTOP_TEXT_MAX));
          const why = err.killed ? `took over ${OCR_MS / 1000} s` : `failed (${err.code ?? "no exit code"})`;
          reject(new RunnerError("internal", `Reading the screen's text ${why}`));
        },
      );
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(jpeg);
    });
  }

  /**
   * A helper for the agent's desktop, as this process's user (or the launcher's), with the desktop's display and
   * cookie and a UTF-8 locale. A desktop that just started gets a few seconds for its accessibility bus to come up.
   */
  private async start(use: Use): Promise<Helper> {
    const python = this.opts.command ? null : this.sys.which("python3");
    if (!this.opts.command && !python) throw new RunnerError("desktop_unavailable", installReason(["python3"]));
    const env: Record<string, string> = {
      HOME: use.home,
      PATH: userPath(),
      DISPLAY: `:${use.display}`,
      XAUTHORITY: use.xauthority,
      ...HELPER_ENV,
    };
    const helper = new Helper(
      this.opts.command ?? [...(this.opts.launcher?.prefix ?? []), ...helperCommand(python ?? "python3")],
      { cwd: use.home, env },
      (h, why) => {
        if (use.helper === h) use.helper = null;
        if (why) this.opts.log(`the desktop helper of ${use.agent.handle} stopped: ${why}`);
      },
    );
    use.helper = helper;
    use.failures = 0;
    this.arm();
    const hello = async () => {
      try {
        return await helper.request("hello", {}, this.requestMs);
      } catch (err) {
        throw err instanceof HelperFailure ? helperError(err) : err;
      }
    };
    let h = await hello();
    while (isHello(h) && h.screen !== null && !h.a11y && this.fresh(use)) {
      await sleep(SESSION_POLL_MS);
      h = await hello();
    }
    if (!isHello(h)) throw this.malformed(use, "hello");
    if (h.missing.length > 0) {
      this.missing = h.missing.filter((m) => PACKAGE.test(m)).slice(0, 10);
      this.stop(use);
      throw new RunnerError("desktop_unavailable", installReason(this.missing));
    }
    this.missing = [];
    if (h.screen === null || !h.a11y) {
      this.stop(use);
      throw new RunnerError(
        "desktop_unavailable",
        (h.problem ?? "The agent's desktop can't be read yet").slice(0, 300),
      );
    }
    return helper;
  }

  /** The desktop started moments ago: its session may still be coming up. */
  private fresh(use: Use) {
    return Date.now() < use.since + SESSION_READY_MS;
  }

  /** The helper broke the protocol: it stops (starting again on the next use), and the request fails. */
  private malformed(use: Use, what: string) {
    this.stop(use);
    return new RunnerError("internal", `The desktop helper sent a malformed ${what}. It starts again on the next use.`);
  }

  private stop(use: Use) {
    use.helper?.kill();
    use.helper = null;
  }

  private arm() {
    this.sweepTimer ??= setInterval(() => this.sweep(), SWEEP_MS);
    (this.sweepTimer as { unref?: () => void }).unref?.();
  }

  private disarm() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }
}

/**
 * The look an action's refs and points come from. Without one (the desktop started again since, or there was
 * none) they are stale: the plan looks again and finds its targets there.
 */
function lastLook(use: Use, points: DesktopPoint[]): NonNullable<Use["last"]> {
  if (use.last) return use.last;
  const ref = points.find((p) => "ref" in p);
  throw ref && "ref" in ref
    ? staleRef(ref.ref)
    : new RunnerError("not_found", "stale: the desktop isn't as last seen. Look at it again.");
}

/** A window is activated by its id: what `focus` does, and a click on a window's own line. */
const activates = (kind: DesktopAction["kind"], t: DesktopTarget) =>
  t.xid !== undefined && (kind === "focus" || (!t.node && (kind === "click" || kind === "double_click")));

function pointerSteps(kind: DesktopAction["kind"], spot: Spot): HelperStep[] {
  const t = spot.target;
  if (t?.xid !== undefined && activates(kind, t)) return [{ activate: t.xid }];
  if (kind === "hover") return [{ move: spot.point }];
  // Already as asked: nothing to click.
  if ((kind === "check" || kind === "uncheck") && t?.checked === (kind === "check")) return [];
  return [
    {
      click: spot.point,
      ...(kind === "right_click" ? { button: 3 as const } : {}),
      ...(kind === "double_click" ? { count: 2 as const } : {}),
    },
  ];
}

/** The smallest element of a look under a point. */
function elementAt(look: DesktopLook, point: Point): DesktopTarget | undefined {
  let best: DesktopTarget | undefined;
  for (const t of Object.values(look.targets)) {
    if (contains(t.box, point) && (!best || t.box[2] * t.box[3] < best.box[2] * best.box[3])) best = t;
  }
  return best;
}

function parsePoint(v: unknown): DesktopPoint {
  if (isRecord(v) && isString(v.ref) && REF.test(v.ref)) return { ref: v.ref };
  if (isRecord(v) && Number.isFinite(v.x) && Number.isFinite(v.y)) return { x: v.x as number, y: v.y as number };
  throw bad("An action lands on an element (its ref, like e12) or a point on the screen (x and y)");
}

function parseText(v: unknown, empty = false): string {
  if (!isString(v) || (!empty && v.length === 0) || v.length > DESKTOP_LIMITS.text) {
    throw bad(`The text is ${empty ? "at most" : "1 to"} ${DESKTOP_LIMITS.text} characters`);
  }
  return v;
}

function parseRegion(v: unknown): DesktopRegion {
  if (!isRecord(v) || ![v.x, v.y, v.width, v.height].every(Number.isFinite)) {
    throw bad("A region is x, y, width and height in pixels");
  }
  const [x, y, width, height] = [v.x, v.y, v.width, v.height].map((n) => Math.round(n as number)) as [
    number,
    number,
    number,
    number,
  ];
  if (width < 1 || height < 1) throw bad("A region is at least 1 pixel a side");
  return { x, y, width, height };
}

/** A `desktop.act` action, checked: its kind, where it lands, its text, key, app, path or wait. */
export function parseAction(v: unknown): DesktopAction {
  if (!isRecord(v) || !isString(v.kind)) throw bad("An action has a kind");
  const { kind } = v;
  switch (kind) {
    case "click":
    case "double_click":
    case "right_click":
    case "hover":
    case "focus":
    case "check":
    case "uncheck":
      return { kind, at: parsePoint(v.at) };
    case "drag":
      return { kind, from: parsePoint(v.from), to: parsePoint(v.to) };
    case "fill":
      return { kind, at: parsePoint(v.at), text: parseText(v.text, true) };
    case "type":
      return { kind, text: parseText(v.text), ...(v.at !== undefined ? { at: parsePoint(v.at) } : {}) };
    case "select": {
      const at = parsePoint(v.at);
      if (!("ref" in at)) throw bad("select takes an element's ref");
      return { kind, at, value: parseText(v.value) };
    }
    case "press": {
      const key = isString(v.key) ? xKey(v.key) : null;
      if (!key) throw bad("press takes key names joined by +, like ctrl+s, Enter or alt+F4");
      if (SESSION_KEYS.has(key)) throw sessionRefused(key);
      return { kind, key };
    }
    case "scroll": {
      const { direction } = v;
      if (direction !== "up" && direction !== "down" && direction !== "left" && direction !== "right") {
        throw bad("scroll goes up, down, left or right");
      }
      if (!isInt(v.pixels) || v.pixels < 1) throw bad("scroll takes pixels, a whole number");
      return { kind, direction, pixels: v.pixels, ...(v.at !== undefined ? { at: parsePoint(v.at) } : {}) };
    }
    case "launch":
      if (!isString(v.app) || v.app.length > DESKTOP_LIMITS.path || !APP_ID.test(v.app)) {
        throw bad("launch takes an app's id from desktop.apps, like thunar.desktop");
      }
      if (SESSION_ENTRIES.test(v.app)) throw sessionRefused(v.app);
      return { kind, app: v.app };
    case "open_file":
      if (!isString(v.path) || !v.path.trim() || v.path.length > DESKTOP_LIMITS.path || v.path.includes("\0")) {
        throw bad(`open_file takes a path of at most ${DESKTOP_LIMITS.path} characters`);
      }
      return { kind, path: v.path };
    case "pause":
      if (!isInt(v.ms) || v.ms < 0 || v.ms > DESKTOP_LIMITS.pauseMs) {
        throw bad(`pause takes 0 to ${DESKTOP_LIMITS.pauseMs} ms`);
      }
      return { kind, ms: v.ms };
    default:
      throw bad(`Unknown desktop action ${kind.slice(0, 40)}`);
  }
}

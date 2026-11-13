import { spawn } from "node:child_process";
import { createCipheriv, randomBytes, randomInt } from "node:crypto";
import type { EventEmitter } from "node:events";
import {
  chmodSync,
  chownSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { Server } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type AgentScope,
  DESKTOP_SIZE,
  type MachineReplies,
  type RunnerDesktopInfo,
} from "@agenteschat/adapters/machine-protocol";
import type { Launcher } from "./agent-users";
import { BROWSER_SOCKET, closeBrowser, serveBrowser } from "./desktop-browser";
import {
  desktopName,
  KEEPER_STATE,
  type LookOptions,
  lookCommand,
  lookDock,
  lookTheme,
  TERMINAL_NOTE_ENV,
} from "./desktop-look";
import { RunnerError } from "./errors";
import { resolveCommand } from "./executors";
import { readJson, readSmallJson, writeJson } from "./json-file";
import { hasBunTerminal, runtimeName, thisRunner } from "./launch";
import { seconds, tailLines } from "./logfile";
import { agentFolderName } from "./paths";
import { KeyedQueue } from "./queue";

/**
 * The agents' desktops (ADR 0058 §1): per agent, one Xtigervnc (the X server
 * and the VNC server in one process) and an XFCE session, on Linux.
 *
 * - Xvnc listens on a Unix socket only (0600, its user's): a loopback port can
 *   be taken first by another agent's process, which would then show the
 *   people watching a fake screen and read what the person in control types.
 * - Two random passwords per start (full and view-only) that never leave the
 *   computer: the runner logs in with one of them for each viewer.
 * - It runs as the agent's OS user: the runner's own in single-user mode, the
 *   agent's own in system mode (through its launcher), where the password file
 *   is root's: Xvnc reads it on every connection, so an agent that could
 *   write it would swap the two passwords and turn its watchers into
 *   controllers.
 * - Its look (`desktop-look.ts`) is XFCE's settings in its HOME, written there
 *   as the agent while its screen server starts, when the HOME's marker names
 *   another look.
 *   Its Browser reaches the runner on a socket next to the password file
 *   (`desktop-browser.ts`), open while the desktop runs.
 * - One that runs on gets what changed since it started without a restart
 *   (`refresh`, from the sweep): Xtigervnc's flags a running server takes
 *   (`LIVE_PARAMS`), and the look, once nobody watches it and its agent
 *   isn't using it. Each records what it has, so it happens once.
 * - Started the first time it is needed (`ensure`: the agent's screen or
 *   browser, a person opening it), then left on: none stops for being idle,
 *   so what a person left open on it is still there later. Started again (at
 *   most 3 times in 10 minutes) when it ends by itself. It stops when its
 *   agent leaves this computer, or its workspace is suspended.
 * - Parked only when room runs short (`makeRoom`, before a desktop or a
 *   headed Chrome starts): the least recently used ones nobody watches or
 *   uses, untouched for `PARK_AFTER_MS`, until `MIN_FREE_BYTES` are free and,
 *   for a new desktop, a display. One parked starts again like a first time.
 * - Desktops outlive the runner (their own sessions; the service has
 *   `KillMode=process`): the next runner takes them back from
 *   `<runner home>/desktop/<id8>.json` once the pid there is still that
 *   display's Xtigervnc.
 * - What is open on one is kept beside it (`<id8>.open`, `recordOpen`, at each
 *   sweep), so a desktop that the computer's restart or move ended opens it
 *   again at its next start (`reopen`, ADR 0168): its Terminals, as new shells
 *   in the folders theirs were in, each with a line saying why; its other
 *   apps, as the desktop's keeper listed their windows (`desktop-keeper.py`);
 *   and the agent's Chrome, when it showed there, which opens its last tabs.
 *   A desktop that ends while the runner runs (stopped, parked, crashed)
 *   forgets it; one that ends once the runner is stopping (a reboot stops both
 *   at once) keeps it.
 */

/** Memory left free before a desktop or a headed Chrome starts: desktops are parked to keep it. */
export const MIN_FREE_BYTES = 1.5 * 1024 ** 3;
/** A desktop untouched this long, unwatched and unused, may be parked (an open request keeps it touched). */
export const PARK_AFTER_MS = 60 * 60_000;
const SWEEP_MS = 60_000;
/** Xvnc listens within a few hundred ms. */
const XVNC_START_MS = 5000;
/**
 * The steps before its session, run as the agent (the prepare, the look), take milliseconds: one still running
 * after this is held up (a pipe in its HOME, a hung disk), and is stopped rather than left to block the agent's
 * desktop.
 */
const STEP_MS = 10_000;
const KILL_WAIT_MS = 3000;
/** A running desktop takes a new look only after a minute without a request (its agent's steps come closer). */
const REFRESH_IDLE_MS = 60_000;
/**
 * XFCE's session starts its programs one priority after another, each once the one before has registered (or
 * after 8 s): the window manager, the settings daemon, the panel (and the dock's own process), Thunar's daemon,
 * then xfdesktop and its wallpaper. When each started, from the session's own start, goes in the log at the first
 * sweep this long after the desktop started: where its seconds before the picture went.
 */
const SESSION_PROGRAMS = ["xfwm4", "xfsettingsd", "xfce4-panel", "wrapper-2.0", "Thunar", "xfdesktop"];
const SESSION_SETTLED_MS = 15_000;
/** Terminals a desktop opens again after a restart, at most: each is a process of its own there. */
const REOPEN_MAX = 8;
/** Other apps a desktop opens again, at most, and the keeper's list read for them (`KEEPER_STATE`). */
const APPS_MAX = 20;
const KEEPER_STATE_BYTES = 64 * 1024;
/** An app's command line kept to open it again: at most this many arguments, and characters in all. */
const APP_ARGS_MAX = 64;
const APP_CHARS_MAX = 4096;
/**
 * Each app opened again is the agent's own process changing into its folder (its home, where that is gone), so root
 * never enters a folder the agent could swap for a link: `sh -c APP_SCRIPT agentes-app <folder> <command line…>`.
 */
const APP_SCRIPT = 'cd "$1" 2>/dev/null || cd; shift; exec "$@"';
/**
 * What a Terminal opened again says above its first prompt (`TERMINAL_NOTE_ENV`): the computer restarted, or moved to
 * another server (the desktop's record names the computer it was kept on, `/etc/machine-id`).
 */
export const terminalNote = (moved: boolean) =>
  `The computer ${moved ? "moved to another server" : "restarted"}: this is a new shell in the same folder.`;
/**
 * The look written into a running session (`refresh`) also sets some 70 settings, an `xfconf-query` each through
 * the session's bus, and restarts its dock: seconds on a busy computer, so it gets this many steps' time.
 */
const LIVE_LOOK_STEPS = 6;
/**
 * Xtigervnc's flags that a running server takes from `tigervncconfig -set` (through its VNC extension), as
 * `<param>=<value>`: TigerVNC 1.12 to 1.15 let it set only desktop, AcceptPointerEvents, SendCutText,
 * AcceptCutText, SendPrimary and SetPrimary (`AllowOverride`'s default, which the runner keeps). A desktop
 * started before one of these changed gets it while it runs; any other flag waits for the desktop's next start.
 */
const LIVE_PARAMS = ["SendPrimary=0"];
/**
 * Run as the agent with the desktop's DISPLAY and cookie: sets each of its arguments (`LIVE_PARAMS`) and reads it
 * back, since tigervncconfig exits 0 even when the server refuses a set. tigervncconfig comes with
 * tigervnc-common, which tigervnc-standalone-server depends on; TigerVNC 1.15 says a flag is on or off where 1.12
 * and 1.13 say 1 or 0.
 */
const PARAMS_SCRIPT = [
  'for a in "$@"; do',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameters, not a template literal
  "  n=${a%%=*} want=${a#*=}",
  '  got=$(tigervncconfig -set "$a" && tigervncconfig -get "$n") || exit 1',
  '  case "$want:$got" in "$got:$got" | 0:off | 1:on) ;; *) exit 2 ;; esac',
  "done",
].join("\n");
/** Why a running desktop keeps its earlier look (`LOOK_SCRIPT`'s exit codes). */
const LOOK_FAILED: Record<number, string> = {
  1: "its files couldn't be written",
  2: "its session wasn't found",
  3: "its settings weren't taken",
  4: "its dock didn't start over",
};
/** A desktop that ended by itself starts again this many times within the window, then stays off. */
const RESTARTS = { max: 3, windowMs: 10 * 60_000 };
/** Agents' displays are :20 to :69, one slot each. */
const FIRST_DISPLAY = 20;
const SLOT_COUNT = 50;
const SLOTS_FILE = "slots.json";
/** System mode: where root keeps each agent's password file (`<uid>/passwd`). */
const SYSTEM_RUN_DIR = "/run/agentes-desktop";
/** Where X servers keep their display locks and sockets. */
const X_LOCK_DIR = "/tmp";

/** A command each of the desktop's Debian packages installs, to tell which are missing. */
const PACKAGES: readonly (readonly [command: string, pkg: string])[] = [
  ["Xtigervnc", "tigervnc-standalone-server"],
  ["xauth", "xauth"],
  ["dbus-launch", "dbus-x11"],
  ["xfce4-session", "xfce4-session"],
  ["xfwm4", "xfwm4"],
  ["xfce4-panel", "xfce4-panel"],
  ["xfdesktop", "xfdesktop4"],
  ["xfsettingsd", "xfce4-settings"],
  ["thunar", "thunar"],
  ["xfce4-terminal", "xfce4-terminal"],
];
/**
 * Without `--no-install-recommends` the desktop gets a screen locker nobody
 * can unlock, more daemons, and eight folders in every agent's home.
 */
const INSTALL = `sudo apt install --no-install-recommends ${[
  ...PACKAGES.map(([, pkg]) => pkg),
  "adwaita-icon-theme",
  "elementary-xfce-icon-theme",
  "fonts-noto-core",
  "fonts-noto-cjk",
].join(" ")}`;

/**
 * Run as the agent: its desktop folder (0700), HOME and XFCE's settings
 * there (the session's when it has none, `$3`; xfwm4's vblank off, `$4`, or
 * that one setting changed in the file xfwm4 keeps), and a fresh cookie file.
 * The cookie comes on stdin (`xauth source -`), never in an argument.
 */
const PREPARE = [
  'umask 077 && mkdir -p "$1" "$2" && chmod 700 "$1"',
  'x="$2/.config/xfce4/xfconf/xfce-perchannel-xml" && w="$x/xfwm4.xml" && mkdir -p "$x"',
  '{ [ -e "$x/xfce4-session.xml" ] || printf %s "$3" > "$x/xfce4-session.xml"; }',
  // xfwm4 writes every one of its settings to its file on its first start, so a desktop that ran before has it.
  // A failure here only leaves the vblank on: the desktop still starts.
  String.raw`{ if [ -e "$w" ]; then sed 's/\(name="vblank_mode" type="string" value="\)[^"]*/\1off/' "$w" > "$w.new" && mv "$w.new" "$w"; else printf %s "$4" > "$w"; fi || true; }`,
  'rm -f "$1/Xauthority" && exec xauth -q -f "$1/Xauthority" source -',
].join(" && ");

/**
 * XFCE's session starts an ssh-agent that daemonizes on its own and outlives
 * the desktop (one more process left at every start), and before any of its
 * programs it waits for gpg-agent's restart (`gpgconf --kill`, then
 * `gpg-agent --daemon`, each run to its end): both off. gpg starts its own
 * agent when something uses it.
 */
const XFCE_SESSION_SETTINGS = `<?xml version="1.0" encoding="UTF-8"?>
<channel name="xfce4-session" version="1.0">
  <property name="startup" type="empty">
    <property name="ssh-agent" type="empty">
      <property name="enabled" type="bool" value="false"/>
    </property>
    <property name="gpg-agent" type="empty">
      <property name="enabled" type="bool" value="false"/>
    </property>
  </property>
</channel>
`;

/**
 * xfwm4's compositor shows nothing new before the screen's next vblank, and
 * Xtigervnc's vblank clock ticks once a second while no viewer is connected:
 * with nobody watching, what an app drew reached the agent's screen (and its
 * screenshots) up to 2 s late. A virtual screen has no refresh to wait for:
 * off.
 */
const XFWM4_SETTINGS = `<?xml version="1.0" encoding="UTF-8"?>
<channel name="xfwm4" version="1.0">
  <property name="general" type="empty">
    <property name="vblank_mode" type="string" value="off"/>
  </property>
</channel>
`;

/**
 * A desktop or a terminal is a shell for whoever drives it: as root that is the whole computer, every agent's
 * files and the runner's token. Only a launcher that runs it as the agent's own user may start one from root.
 */
export const NOT_AS_ROOT = "The agents' desktops and terminals never run as root: run the runner as a normal user";

/** VNC's fixed key for password files, each byte's bits reversed as DES wants them. */
const VNC_FILE_KEY = Buffer.from("e84ad660c4721ae0", "hex");
const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

/**
 * TigerVNC's password file: each password (8 bytes, zero padded)
 * DES-encrypted with VNC's fixed key, the full one first, then the view-only one.
 */
export function vncPasswordFile(full: string, view: string): Buffer {
  const block = (password: string) => {
    const key = Buffer.alloc(8);
    Buffer.from(password, "latin1").copy(key, 0, 0, 8);
    const des = createCipheriv("des-ecb", VNC_FILE_KEY, null).setAutoPadding(false);
    return Buffer.concat([des.update(key), des.final()]);
  };
  return Buffer.concat([block(full), block(view)]);
}

const newPassword = () =>
  Array.from({ length: 8 }, () => PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)]).join("");

/** `MemAvailable` from `/proc/meminfo`'s text, in bytes; null when it isn't there. */
export function memAvailableBytes(meminfo: string): number | null {
  const kb = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo)?.[1];
  return kb === undefined ? null : Number(kb) * 1024;
}

/** The memory Linux says is available now; null elsewhere. */
export function hostMemAvailable(): number | null {
  try {
    return memAvailableBytes(readFileSync("/proc/meminfo", "utf8"));
  } catch {
    return null;
  }
}

/** Where and as whom an agent's desktop runs. */
export interface DesktopUser {
  /** Runs a command as the agent (`[]`: as the runner's own user). */
  prefix: string[];
  /** Its processes' whole environment; the desktop adds its own variables. */
  env: Record<string, string>;
  /** The desktop session's HOME (XFCE's settings and files). */
  home: string;
  /** The agent's folder for the desktop's cookie and socket (made 0700 by the agent). */
  dir: string;
  /** System mode: the agent's uid and gid; the password file is then the runner's (root), readable by that group. */
  ids?: { uid: number; gid: number };
  /** Where the agent's own /tmp is on the computer, when it has one: its X server's display lock is there. */
  tmp?: string;
}

/** The agent's id as it names files on the machine (`<handle>-<id8>`'s part). */
const id8 = (agent: AgentScope) => agentFolderName(agent).suffix.slice(1);

/**
 * Single-user mode: the whole environment of an agent's desktop or a
 * terminal as the agent, with `home` as HOME. Of the runner's own
 * environment, only PATH.
 */
export function runnerEnv(home: string): Record<string, string> {
  const me = os.userInfo();
  return {
    HOME: home,
    USER: me.username,
    LOGNAME: me.username,
    SHELL: me.shell || "/bin/sh",
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
  };
}

/**
 * Single-user mode: the runner's own user runs the agent's desktop. Its HOME
 * is in the agent's folder (XFCE's files stay out of the agent's work); its
 * cookie and socket are in the runner's home, since a socket's path has at
 * most 107 bytes and an agent's folder can be deeper than that.
 */
export function runnerUser(runnerHome: string, agentFolder: string, agent: AgentScope): DesktopUser {
  const home = path.join(agentFolder, ".agentes", "home");
  return { prefix: [], env: runnerEnv(home), home, dir: path.join(runnerHome, "desktop", id8(agent)) };
}

/**
 * System mode: the agent's own OS user runs its desktop, through its launcher, with its own home as HOME and
 * its cookie and socket in `~/.agentes/desktop`; the password file is root's, readable by the agent's group.
 */
export function systemDesktopUser(launcher: Launcher, ids: { uid: number; gid: number }): DesktopUser {
  return { ...launcher, dir: path.join(launcher.home, ".agentes", "desktop"), ids };
}

/** A process a desktop started. */
export interface DesktopProcess {
  /** 0 when it couldn't start. */
  pid: number;
  /** Settles with its exit code (null: a signal, or it never started). */
  exited: Promise<number | null>;
}

export interface DesktopSpawnOptions {
  cwd: string;
  env: Record<string, string>;
  /** Written to its stdin, which is then closed. */
  input?: string;
  /** An open file for its output (none: discarded). */
  log?: number;
  /** In its own session, outliving the runner. */
  detached?: boolean;
}

/** What the desktops need from the computer (tests: a fake). */
export interface DesktopSystem {
  platform: string;
  /** `Bun.Terminal` is there: the runner runs on Bun 1.3.5 or newer. */
  pty: boolean;
  /** The runner's runtime, for people ("Node 22.12.0"). */
  runtime: string;
  /** The runner's own uid (null where there is none). */
  uid: number | null;
  /** A command's full path on `pathList` (default: the runner's PATH); null when it isn't there. */
  which(command: string, pathList?: string): string | null;
  /** A file is there (the look's theme). */
  exists(file: string): boolean;
  spawn(argv: string[], opts: DesktopSpawnOptions): DesktopProcess;
  /** A process's command line; null when it isn't running. */
  cmdline(pid: number): string[] | null;
  /** A process's folder and its environment; null when it isn't running (none where there is no `/proc`). */
  cwd?(pid: number): string | null;
  environ?(pid: number): Record<string, string> | null;
  /** This computer's id (`/etc/machine-id`): another one where a desktop's record was kept means it moved. */
  machineId?(): string | null;
  kill(pid: number, signal: NodeJS.Signals): void;
  /** Every process on the computer (none where there is no `/proc`). */
  processes(): ProcessStat[];
  /** The computer's Unix sockets as `/proc/net/unix` lists them (none known: empty). */
  unixSockets?(): string;
}

/**
 * The displays whose abstract X socket (`@/tmp/.X11-unix/X<n>`, in `/proc/net/unix`) someone holds. An agent's X
 * server keeps its lock in the agent's own /tmp, out of sight of the others, but that name is the whole computer's:
 * held by an X server, or squatted by an agent, it keeps the display taken.
 */
export function abstractDisplays(unix: string): Set<number> {
  const held = new Set<number>();
  for (const m of unix.matchAll(/ @\/tmp\/\.X11-unix\/X(\d+)$/gm)) held.add(Number(m[1]));
  return held;
}

/** A process as `/proc/<pid>/stat` has it: `start` in seconds since the computer booted, `cpu` in seconds it ran. */
export interface ProcessStat {
  pid: number;
  ppid: number;
  name: string;
  start: number;
  cpu: number;
}

/** USER_HZ, what `/proc/<pid>/stat` counts a process's start and CPU time in: 100 on every Linux the runner runs on. */
const TICKS_PER_SECOND = 100;

/** One `/proc/<pid>/stat` line; null when it isn't one. Its name can hold spaces and parentheses: it ends at the last ")". */
export function procStat(line: string): ProcessStat | null {
  const open = line.indexOf("(");
  const close = line.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  // From the field after the name: state, ppid, … utime and stime (the stat's 14th and 15th), starttime (its 22nd).
  const fields = line.slice(close + 2).split(" ");
  const [pid, ppid, start] = [Number(line.slice(0, open)), Number(fields[1]), Number(fields[19])];
  const cpu = Number(fields[11]) + Number(fields[12]);
  if (!isPid(pid) || !Number.isInteger(ppid) || !Number.isFinite(start) || !Number.isFinite(cpu)) return null;
  return { pid, ppid, name: line.slice(open + 1, close), start: start / TICKS_PER_SECOND, cpu: cpu / TICKS_PER_SECOND };
}

function spawnProcess(argv: string[], opts: DesktopSpawnOptions): DesktopProcess {
  const [file = "", ...args] = argv;
  const out = opts.log ?? "ignore";
  const child = spawn(file, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: [opts.input === undefined ? "ignore" : "pipe", out, out],
    detached: opts.detached === true,
  });
  const events = child as unknown as EventEmitter;
  const exited = new Promise<number | null>((resolve) => {
    events.once("exit", (code: number | null) => resolve(code));
    events.once("error", () => resolve(null));
  });
  if (child.stdin) {
    child.stdin.on("error", () => undefined);
    child.stdin.end(opts.input);
  }
  if (opts.detached) child.unref();
  return { pid: child.pid ?? 0, exited };
}

export const hostSystem = (): DesktopSystem => ({
  platform: process.platform,
  pty: hasBunTerminal(),
  runtime: runtimeName(),
  uid: process.getuid?.() ?? null,
  which(command, pathList) {
    const found = resolveCommand(command, pathList);
    return path.isAbsolute(found) ? found : null;
  },
  exists: existsSync,
  spawn: spawnProcess,
  cmdline(pid) {
    try {
      const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      if (argv.at(-1) === "") argv.pop();
      return argv.length > 0 ? argv : null;
    } catch {
      return null;
    }
  },
  cwd(pid) {
    try {
      return readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  },
  environ(pid) {
    try {
      const vars = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
      return Object.fromEntries(
        vars.flatMap((v) => (v.includes("=") ? [[v.slice(0, v.indexOf("=")), v.slice(v.indexOf("=") + 1)]] : [])),
      );
    } catch {
      return null;
    }
  },
  machineId() {
    try {
      return readFileSync("/etc/machine-id", "utf8").trim() || null;
    } catch {
      return null;
    }
  },
  kill(pid, signal) {
    try {
      process.kill(pid, signal);
    } catch {
      // gone
    }
  },
  processes() {
    let pids: string[];
    try {
      pids = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
    } catch {
      return [];
    }
    return pids.flatMap((pid) => {
      try {
        return procStat(readFileSync(`/proc/${pid}/stat`, "utf8")) ?? [];
      } catch {
        return [];
      }
    });
  },
  unixSockets() {
    try {
      return readFileSync("/proc/net/unix", "utf8");
    } catch {
      return "";
    }
  },
});

export interface DesktopSessionsOptions {
  /** The runner's home: `desktop/` keeps the slots, each desktop's state and its log. */
  home: string;
  log: (line: string) => void;
  /** Where and as whom the agent's desktop runs (single-user: `runnerUser`). */
  user: (agent: AgentScope) => Promise<DesktopUser>;
  /** System mode: `user` runs each agent as its own OS user (its launcher), so a runner running as root may serve. */
  agentUsers?: boolean;
  /** Tests: the computer. */
  system?: DesktopSystem;
  /** Tests: where X keeps display locks (`/tmp`), and system mode's password folders (`/run/agentes-desktop`). */
  lockDir?: string;
  runDir?: string;
  /** Tests: the memory available now (default: `/proc/meminfo`; null: not known, never short). */
  memAvailable?: () => number | null;
  now?: () => number;
  /** Tests: `STEP_MS`. */
  stepMs?: number;
  /** Whether the agent's Chrome on its desktop is in use (its commands, its live view's viewers): never parked then. */
  inUse?: (agentId: string) => boolean;
  /** A viewer of the agent's desktop came or went (`status().streams`). */
  onViewers?: (agentId: string) => void;
  /** Browser on the agent's desktop was clicked (`desktop-browser.ts`); without it the desktop has no socket for it. */
  openBrowser?: (agent: AgentScope, installing: () => void) => Promise<void>;
  /** How this runner starts itself, which Browser runs (default: this process). */
  runner?: string[];
  /** The computer's shared folder (ADR 0115), bookmarked in the desktop's file manager. */
  shared?: () => string | null;
}

/** What `<runner home>/desktop/<id8>.json` keeps of a running desktop. */
interface Saved {
  agent: AgentScope;
  display: number;
  /** Xvnc's own pid (its display's lock file says it). */
  pid: number;
  /** The session as started (xfce4-session, or the launcher that runs it as the agent). */
  sessionPid: number;
  home: string;
  socket: string;
  xauthority: string;
  passwd: string;
  passwords: { full: string; view: string };
  startedAt: number;
  /** The look its session shows (`lookId`), from its start or a `refresh`; none from an earlier runner. */
  look?: string;
  /** Its Xtigervnc has these `LIVE_PARAMS`, from its flags or a `refresh`; none from an earlier runner. */
  params?: string[];
}

interface Desktop extends Saved {
  /** Its `<id8>.json`. */
  file: string;
  lastUsed: number;
  /** Open viewers: a desktop being watched is never parked. */
  streams: number;
  /** Being stopped on purpose: its processes ending isn't a crash. */
  ending?: boolean;
  /** Its Browser's socket, while it listens. */
  browser?: Server;
  /**
   * Its `refresh`: whether its agent is known as it is now (`current`), one waits for its turn, and what of it this
   * runner has settled, its `LIVE_PARAMS` and its look (done, or failed and left to the next runner).
   */
  refresh: { current: boolean; queued: boolean; params: boolean; look: boolean };
  /** Started by this runner, its session's start not in the log yet (`sessionStart`). */
  untold?: boolean;
  /** What was open on it before the computer restarted, opened again once its session settled (`reopen`). */
  reopen?: OpenOnDesktop;
  /** What `recordOpen` last kept of it, as written. */
  recorded?: string;
}

/**
 * What is open on a desktop, in `<id8>.open`: its Terminals as the folders their shells were in, oldest first; its other
 * apps as the keeper listed their windows; whether the agent's Chrome showed there (its tabs are its own session's,
 * which it opens again); and the computer it was kept on. Background work comes back through the server (ADR 0168).
 */
export interface OpenOnDesktop {
  terminals: string[];
  apps?: OpenApp[];
  browser?: boolean;
  machine?: string;
}

/** An app the desktop opens again: its command line and the folder it ran in. */
export interface OpenApp {
  argv: string[];
  cwd: string;
}

const isOpenApp = (v: unknown): v is OpenApp =>
  isRecord(v) &&
  Array.isArray(v.argv) &&
  v.argv.length > 0 &&
  v.argv.length <= APP_ARGS_MAX &&
  v.argv.every((a) => typeof a === "string") &&
  v.argv.join("").length <= APP_CHARS_MAX &&
  typeof v.cwd === "string" &&
  path.isAbsolute(v.cwd);

/** A list's apps, checked: what the keeper writes is the agent's own file, so anything may be in it. */
const appsOf = (v: unknown): OpenApp[] =>
  Array.isArray(v)
    ? v
        .filter(isOpenApp)
        .slice(0, APPS_MAX)
        .map(({ argv, cwd }) => ({ argv, cwd }))
    : [];

/** The environment of a desktop's session, and of what the runner opens in it as the session would (`reopen`). */
const sessionEnv = (env: Record<string, string>, display: number, xauthority: string) => ({
  ...env,
  DISPLAY: `:${display}`,
  XAUTHORITY: xauthority,
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  XDG_CURRENT_DESKTOP: "XFCE",
  XDG_SESSION_TYPE: "x11",
  // The agents' desktop computer use reads apps through the accessibility tree.
  ACCESSIBILITY_ENABLED: "1",
  QT_LINUX_ACCESSIBILITY_ALWAYS_ON: "1",
});

function parseOpen(v: unknown): OpenOnDesktop | null {
  if (!isRecord(v)) return null;
  const terminals = Array.isArray(v.terminals)
    ? v.terminals.filter((f): f is string => typeof f === "string" && path.isAbsolute(f)).slice(0, REOPEN_MAX)
    : [];
  const apps = appsOf(v.apps);
  const browser = v.browser === true;
  if (terminals.length === 0 && apps.length === 0 && !browser) return null;
  return {
    terminals,
    ...(apps.length > 0 ? { apps } : {}),
    ...(browser ? { browser } : {}),
    ...(typeof v.machine === "string" && v.machine ? { machine: v.machine } : {}),
  };
}

/** Browser's socket: in the password file's folder, root's for the agent in system mode. */
const browserSocket = (passwd: string) => path.join(path.dirname(passwd), BROWSER_SOCKET);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isPid = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
const isSlot = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) < SLOT_COUNT;

function parseSaved(v: unknown): Saved | null {
  if (!isRecord(v) || !isRecord(v.agent) || !isRecord(v.passwords)) return null;
  const { agent, passwords } = v;
  const texts = [agent.id, agent.handle, v.home, v.socket, v.xauthority, v.passwd, passwords.full, passwords.view];
  if (!texts.every((t) => typeof t === "string" && t !== "")) return null;
  if (!isPid(v.pid) || !isPid(v.sessionPid) || !Number.isInteger(v.display) || !Number.isFinite(v.startedAt)) {
    return null;
  }
  // A look or flags that can't be read are taken as not there: a refresh sets them again.
  const params = Array.isArray(v.params) && v.params.every((p) => typeof p === "string") ? v.params : undefined;
  return { ...(v as unknown as Saved), look: typeof v.look === "string" ? v.look : undefined, params };
}

/** What `<id8>.json` keeps of a desktop: its `Saved` part alone. */
const savedOf = (d: Desktop): Saved => ({
  agent: d.agent,
  display: d.display,
  pid: d.pid,
  sessionPid: d.sessionPid,
  home: d.home,
  socket: d.socket,
  xauthority: d.xauthority,
  passwd: d.passwd,
  passwords: d.passwords,
  startedAt: d.startedAt,
  look: d.look,
  params: d.params,
});

const iso = (ms: number) => new Date(ms).toISOString();

/** The agents' desktops on this computer: started, used, watched, stopped (ADR 0058 §1). */
export class DesktopSessions {
  private readonly desktops = new Map<string, Desktop>();
  /** Each agent's starts, stops and restarts, one after another. */
  private readonly queue = new KeyedQueue();
  private readonly operations = new Map<string, number>();
  /** When each agent's desktop was started again after ending by itself. */
  private readonly restarts = new Map<string, number[]>();
  /** Displays of desktops being started. */
  private readonly claimed = new Set<number>();
  /** Refreshes run one after another: each starts dozens of short processes on the computer. */
  private refreshes: Promise<void> = Promise.resolve();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  /** The runner is stopping (`close`). */
  private stopping = false;
  private readonly sys: DesktopSystem;
  private readonly dir: string;
  private readonly now: () => number;
  private readonly stepMs: number;
  private readonly runner: string[];

  constructor(private readonly opts: DesktopSessionsOptions) {
    this.sys = opts.system ?? hostSystem();
    this.dir = path.join(opts.home, "desktop");
    this.now = opts.now ?? Date.now;
    this.stepMs = opts.stepMs ?? STEP_MS;
    this.runner = opts.runner ?? thisRunner();
  }

  /** `hello.desktop`: whether this computer can run the agents' desktops, and what to install when it can't. */
  info(): RunnerDesktopInfo {
    if (this.sys.platform !== "linux") {
      return { available: false, reason: "The agents' desktops run on Linux computers only", code: "desktop_linux" };
    }
    if (this.sys.uid === 0 && !this.opts.agentUsers)
      return { available: false, reason: NOT_AS_ROOT, code: "not_as_root" };
    if (!this.sys.pty) {
      return {
        available: false,
        reason: `The agents' desktops need the runner on Bun 1.3.5 or newer (it runs on ${this.sys.runtime})`,
        code: "runner_bun_old",
      };
    }
    const missing = PACKAGES.filter(([command]) => !this.sys.which(command)).map(([, pkg]) => pkg);
    if (missing.length > 0) {
      return {
        available: false,
        reason: `Install the agents' desktops: \`${INSTALL}\` (missing: ${missing.join(", ")})`,
        code: "desktop_install",
      };
    }
    return { available: true, ...DESKTOP_SIZE };
  }

  /**
   * Starts the agent's desktop, or only marks it used when it runs (`desktop.session.start`, a stream opening).
   * `chrome`: the agent's Chrome is about to start on it, so there must be room for that too.
   */
  ensure(agent: AgentScope, opts: { chrome?: boolean } = {}): Promise<MachineReplies["desktop.session.start"]> {
    return this.serial(agent.id, async () => {
      let d = this.desktops.get(agent.id);
      const running = d !== undefined && this.alive(d);
      if (d && running) {
        this.current(d, agent);
        d.lastUsed = this.now();
      } else {
        if (d) await this.end(d);
        const info = this.info();
        if (!info.available) throw new RunnerError("desktop_unavailable", info.reason ?? "Desktops can't run here");
        d = await this.start(agent);
      }
      if (opts.chrome && !(await this.makeRoom(agent.id))) {
        throw new RunnerError(
          "desktop_busy",
          "This computer is short of memory for the agent's browser on its desktop",
        );
      }
      return this.started(d, !running);
    });
  }

  /**
   * Room for a headed Chrome, or with `display` for one more desktop: while less than `MIN_FREE_BYTES` is
   * available, or no display is free, parks desktops (`parkable`), least recently used first. False: still no
   * room, with nothing left to park. Where the memory isn't known (not Linux) only the displays count.
   */
  async makeRoom(forAgentId: string, display = false): Promise<boolean> {
    const full = () => {
      const free = (this.opts.memAvailable ?? hostMemAvailable)();
      return (free !== null && free < MIN_FREE_BYTES) || (display && this.freeSlots().length === 0);
    };
    while (full()) {
      const [oldest] = [...this.desktops.values()]
        .filter((d) => this.parkable(d, forAgentId))
        .sort((a, b) => a.lastUsed - b.lastUsed);
      if (!oldest) return false;
      await this.serial(oldest.agent.id, async () => {
        if (this.desktops.get(oldest.agent.id) !== oldest || !this.parkable(oldest, forAgentId)) return;
        this.opts.log(`the desktop of ${oldest.agent.handle} was parked to make room: nobody used it for an hour`);
        await this.end(oldest);
      });
    }
    return true;
  }

  /**
   * Nobody watches it, its agent doesn't use it, and nothing touched it for `PARK_AFTER_MS`.
   * ponytail: parking closes what was left open on the least-used desktops, which on 8 GB happens only with many
   * agents browsing at once; a per-agent memory measure replaces the hour rule if that ever bites.
   */
  private parkable(d: Desktop, forAgentId: string) {
    return (
      d.agent.id !== forAgentId &&
      d.streams === 0 &&
      this.now() - d.lastUsed >= PARK_AFTER_MS &&
      !this.opts.inUse?.(d.agent.id)
    );
  }

  stop(agent: Pick<AgentScope, "id">): Promise<MachineReplies["desktop.session.stop"]> {
    return this.serial(agent.id, async () => {
      const d = this.desktops.get(agent.id);
      if (!d) return { stopped: false };
      await this.end(d);
      return { stopped: true };
    });
  }

  /** Root's scope identity: live desktops hold their network context until they end or an explicit drain expires. */
  hasActivity(agentId: string): boolean {
    return (this.operations.get(agentId) ?? 0) > 0 || this.processId(agentId) !== null;
  }

  processId(agentId: string): number | null {
    const d = this.desktops.get(agentId);
    return d && this.alive(d) ? d.pid : null;
  }

  status(agent: Pick<AgentScope, "id">): MachineReplies["desktop.session.status"] {
    const d = this.desktops.get(agent.id);
    if (!d || !this.alive(d)) return { running: false, streams: 0 };
    return { running: true, startedAt: iso(d.startedAt), lastUsedAt: iso(d.lastUsed), streams: d.streams };
  }

  /** The running desktop's display, socket, cookie, HOME and passwords (for the runner's own use only). */
  session(agentId: string) {
    const d = this.desktops.get(agentId);
    if (!d) return null;
    const { display, socket, xauthority, home, passwords } = d;
    return { display, socket, xauthority, home, passwords };
  }

  /** A viewer on the agent's desktop: it isn't parked until the returned release is called. */
  hold(agentId: string): (() => void) | null {
    const d = this.desktops.get(agentId);
    if (!d) return null;
    d.streams++;
    d.lastUsed = this.now();
    this.opts.onViewers?.(agentId);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      d.streams--;
      d.lastUsed = this.now();
      this.opts.onViewers?.(agentId);
    };
  }

  /**
   * Every desktop stops (the machine's desktop switch went off), or every one but those of `keep`: the agents
   * this computer still serves (one archived or moved to another computer leaves).
   */
  async stopAll(keep: ReadonlySet<string> = new Set()) {
    const leaving = [...this.desktops.values()].filter((d) => !keep.has(d.agent.id));
    await Promise.all(leaving.map((d) => this.stop(d.agent).catch(() => undefined)));
  }

  /**
   * The agents this computer serves now (the server's list, at each connection and change): the desktops of the
   * others stop (`stopAll`), and each running one takes its agent's current name and handle.
   */
  serve(agents: readonly AgentScope[]) {
    for (const { id, handle, name } of agents) {
      const d = this.desktops.get(id);
      if (d) this.current(d, { id, handle, ...(name === undefined ? {} : { name }) });
    }
    return this.stopAll(new Set(agents.map((a) => a.id)));
  }

  /**
   * Desktops a previous run of the runner left running are taken back when
   * the pid it saved is still that display's Xtigervnc (a pid can be
   * reused); the others' files go.
   */
  restore() {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".json") || name === SLOTS_FILE) continue;
      const file = path.join(this.dir, name);
      const saved = parseSaved(readJson(file));
      if (saved && !this.desktops.has(saved.agent.id) && this.isXvnc(saved.pid, saved.display)) {
        const d: Desktop = {
          ...saved,
          file,
          lastUsed: this.now(),
          streams: 0,
          refresh: { current: false, queued: false, params: false, look: false },
        };
        this.add(d);
        void this.listenBrowser(d);
        this.opts.log(`the desktop of ${saved.agent.handle} on :${saved.display} is running; taken back`);
      } else {
        rmSync(file, { force: true });
      }
    }
  }

  /**
   * Desktops that ended by themselves start again (one taken back from an earlier runner has no exit to wait
   * on). The agent's Chrome in use on one touches it, so it isn't parked as soon as that Chrome closes. A running
   * one gets what changed since it started (`refresh`); the promise settles once those refreshes are over. One this
   * runner started says how its session's start went (`sessionStart`), once that is over.
   */
  sweep(): Promise<void> {
    let procs: ProcessStat[] | undefined;
    const processes = () => {
      procs ??= this.sys.processes();
      return procs;
    };
    for (const d of [...this.desktops.values()]) {
      if (!this.alive(d)) {
        this.ended(d);
        continue;
      }
      if (this.opts.inUse?.(d.agent.id)) d.lastUsed = this.now();
      const settled = this.now() - d.startedAt >= SESSION_SETTLED_MS;
      if (d.untold && settled) this.sessionStart(d, processes());
      const open = d.reopen;
      if (open && settled) {
        d.reopen = undefined;
        this.refreshes = this.refreshes.then(() =>
          this.serial(d.agent.id, () => this.reopen(d, open)).catch(() => {
            // Its agent's user isn't known while the runner isn't connected: the next sweep tries again.
            d.reopen ??= open;
          }),
        );
      } else if (!open) this.recordOpen(d, processes());
      if (d.refresh.current && !d.refresh.queued && !(d.refresh.params && d.refresh.look)) {
        d.refresh.queued = true;
        // One that throws (its agent's user isn't known while the runner isn't connected) is tried again at the next
        // sweep.
        this.refreshes = this.refreshes.then(() => this.serial(d.agent.id, () => this.refresh(d)).catch(() => {}));
      }
    }
    return this.refreshes;
  }

  /**
   * When each of XFCE's programs (`SESSION_PROGRAMS`) started, from its session's own start, and the CPU time its
   * processes used so far (a program building a cache shows seconds; one waiting on another, none): the processes
   * under the one this runner started, as `/proc` has them. Once per desktop it started.
   */
  private sessionStart(d: Desktop, procs: readonly ProcessStat[]) {
    d.untold = false;
    const tree = this.sessionTree(d, procs);
    const base = tree.find((p) => p.name === "xfce4-session")?.start;
    if (base === undefined) return;
    const parts = SESSION_PROGRAMS.map((name) => {
      const own = tree.filter((p) => p.name === name);
      const at = Math.min(...own.map((p) => p.start));
      const cpu = own.reduce((sum, p) => sum + p.cpu, 0);
      return Number.isFinite(at)
        ? `${name} at ${seconds((at - base) * 1000)} (${seconds(cpu * 1000)} of CPU)`
        : `${name} not yet`;
    });
    this.opts.log(`the desktop of ${d.agent.handle}: its session started ${parts.join(", ")}`);
  }

  /** The processes under the session this runner started, as `/proc` has them. */
  private sessionTree(d: Desktop, procs: readonly ProcessStat[]) {
    const tree = procs.filter((p) => p.pid === d.sessionPid);
    for (let i = 0; i < tree.length; i++) tree.push(...procs.filter((p) => p.ppid === tree[i]?.pid));
    return tree;
  }

  private openFile(agent: AgentScope) {
    return path.join(this.dir, `${id8(agent)}.open`);
  }

  /** What is open on the desktop now, in its `<id8>.open` when that changed: what a start after a restart reopens. */
  private recordOpen(d: Desktop, procs: readonly ProcessStat[]) {
    const kept = this.keeperList(d);
    const apps = appsOf(kept?.apps);
    const machine = this.sys.machineId?.();
    const open: OpenOnDesktop = {
      terminals: this.terminalFolders(d, procs),
      ...(apps.length > 0 ? { apps } : {}),
      ...(kept?.browser === true ? { browser: true } : {}),
    };
    const text = JSON.stringify(open);
    if (text === d.recorded) return;
    try {
      if (open.terminals.length > 0 || open.apps || open.browser) {
        writeJson(this.openFile(d.agent), { ...open, ...(machine ? { machine } : {}) });
      } else rmSync(this.openFile(d.agent), { force: true });
      d.recorded = text;
    } catch {
      // the next sweep writes it
    }
  }

  /**
   * The keeper's list of the desktop's app windows (`desktop-keeper.py`, in its HOME), or null. The agent's own file:
   * read only when it is a plain file of the HOME's owner, never through a link, so another user's list never becomes
   * this agent's.
   */
  private keeperList(d: Desktop): Record<string, unknown> | null {
    try {
      const home = lstatSync(d.home);
      if (!home.isDirectory()) return null;
      const list = readSmallJson(path.join(d.home, KEEPER_STATE), KEEPER_STATE_BYTES, false, home.uid);
      return isRecord(list) && list.v === 1 ? list : null;
    } catch {
      return null;
    }
  }

  /**
   * The folders of the desktop's Terminals, oldest first: the shells of the `xfce4-terminal`s on its display (the
   * dock starts them apart from its session, so they aren't in its tree).
   */
  private terminalFolders(d: Desktop, procs: readonly ProcessStat[]) {
    const terminals = new Set(
      procs
        .filter((p) => p.name === "xfce4-terminal" && this.sys.environ?.(p.pid)?.DISPLAY === `:${d.display}`)
        .map((p) => p.pid),
    );
    return procs
      .filter((p) => terminals.has(p.ppid))
      .sort((a, b) => a.start - b.start)
      .flatMap((p) => {
        const folder = this.sys.cwd?.(p.pid);
        return folder && path.isAbsolute(folder) && !folder.endsWith(" (deleted)") ? [folder] : [];
      })
      .slice(0, REOPEN_MAX);
  }

  /**
   * What was open on the desktop before the computer restarted or moved opens again, on the session's bus, where its
   * settings and the look's prompt are: the agent's Chrome when it showed there (the runner's own, through Browser's
   * way, which opens its last tabs); each Terminal a new shell in its folder (one that is gone is left out), with
   * `terminalNote` above its first prompt; each other app with its command line in its folder. Only the bus comes from
   * the session's environment: what the agent's processes hold is never handed to the launcher, which starts as root
   * in system mode.
   */
  private async reopen(d: Desktop, open: OpenOnDesktop) {
    if (this.desktops.get(d.agent.id) !== d || !this.alive(d)) return;
    const user = await this.opts.user(d.agent);
    if (this.asRoot(user)) return;
    // Not awaited: Browser's way waits for this desktop, whose operations run one after another.
    if (open.browser) void this.opts.openBrowser?.(d.agent, () => undefined).catch(() => undefined);
    const terminal = this.sys.which("xfce4-terminal", user.env.PATH);
    const folders = terminal ? open.terminals.filter((f) => this.sys.exists(f)) : [];
    const apps = open.apps ?? [];
    if (folders.length === 0 && apps.length === 0) return;
    const machine = this.sys.machineId?.();
    const moved = Boolean(open.machine && machine && open.machine !== machine);
    const session = this.sessionTree(d, this.sys.processes()).find((p) => p.name === "xfce4-session");
    const bus = session ? this.sys.environ?.(session.pid)?.DBUS_SESSION_BUS_ADDRESS : undefined;
    const env = {
      ...sessionEnv({ ...user.env, HOME: d.home }, d.display, d.xauthority),
      ...(bus && /^unix:[\w=/.,%-]+$/.test(bus) ? { DBUS_SESSION_BUS_ADDRESS: bus } : {}),
    };
    for (const folder of folders) {
      this.sys.spawn([...user.prefix, terminal as string, "--disable-server", `--working-directory=${folder}`], {
        cwd: "/",
        env: { ...env, [TERMINAL_NOTE_ENV]: terminalNote(moved) },
        detached: true,
      });
    }
    for (const app of apps) {
      this.sys.spawn([...user.prefix, "/bin/sh", "-c", APP_SCRIPT, "agentes-app", app.cwd, ...app.argv], {
        cwd: "/",
        env,
        detached: true,
      });
    }
    this.opts.log(
      `the desktop of ${d.agent.handle} opened again after the computer ${moved ? "moved" : "restarted"}: ${folders.length} terminals, ${apps.length} other apps${open.browser ? ", its browser" : ""}`,
    );
  }

  /**
   * The runner stops: desktops go on running (the next runner takes them back). One that ends from now on is left as
   * it is, what was open on it kept: when the computer itself stops, its desktops end with the runner, not before it.
   */
  close() {
    this.stopping = true;
    this.stopSweeps();
  }

  private stopSweeps() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  private started(d: Desktop, started: boolean): MachineReplies["desktop.session.start"] {
    return { display: d.display, ...DESKTOP_SIZE, startedAt: iso(d.startedAt), started };
  }

  private serial<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    this.operations.set(agentId, (this.operations.get(agentId) ?? 0) + 1);
    return this.queue.run(agentId, fn).finally(() => {
      const left = (this.operations.get(agentId) ?? 1) - 1;
      if (left) this.operations.set(agentId, left);
      else this.operations.delete(agentId);
    });
  }

  private add(d: Desktop) {
    this.desktops.set(d.agent.id, d);
    this.sweepTimer ??= setInterval(() => void this.sweep(), SWEEP_MS);
    (this.sweepTimer as { unref?: () => void }).unref?.();
  }

  private async start(agent: AgentScope): Promise<Desktop> {
    const began = this.now();
    if (!(await this.makeRoom(agent.id, true))) {
      throw new RunnerError(
        "desktop_busy",
        "This computer has no room for another desktop, and every one on it is in use",
      );
    }
    let display: number | null = null;
    try {
      const user = await this.opts.user(agent);
      const userAt = this.now();
      if (this.asRoot(user)) throw new RunnerError("desktop_unavailable", NOT_AS_ROOT);
      const xvnc = this.sys.which("Xtigervnc", user.env.PATH);
      const dbus = this.sys.which("dbus-launch", user.env.PATH);
      if (!xvnc || !dbus) {
        throw new RunnerError(
          "desktop_unavailable",
          `The agent's user can't find Xtigervnc or dbus-launch (${INSTALL})`,
        );
      }
      display = this.pickDisplay(agent.id);
      const passwords = { full: newPassword(), view: newPassword() };
      while (passwords.view === passwords.full) passwords.view = newPassword();
      const files = {
        socket: path.join(user.dir, "vnc.sock"),
        xauthority: path.join(user.dir, "Xauthority"),
        passwd: user.ids
          ? path.join(this.opts.runDir ?? SYSTEM_RUN_DIR, String(user.ids.uid), "passwd")
          : path.join(user.dir, "passwd"),
      };
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const logFile = path.join(this.dir, `${id8(agent)}.log`);
      // A desktop that ended by itself starts again at once: the log of the start that ended stays (`.log.1`).
      try {
        renameSync(logFile, `${logFile}.1`);
      } catch {
        // no earlier start
      }
      const log = openSync(logFile, "w", 0o600);
      try {
        const script = [
          ...user.prefix,
          "/bin/sh",
          "-c",
          PREPARE,
          "sh",
          user.dir,
          user.home,
          XFCE_SESSION_SETTINGS,
          XFWM4_SETTINGS,
        ];
        const prepare = this.sys.spawn(script, {
          cwd: "/",
          env: user.env,
          input: `add :${display} . ${randomBytes(16).toString("hex")}\n`,
          log,
        });
        const prepared = await this.step(prepare);
        if (prepared !== 0) {
          throw new RunnerError(
            "internal",
            `The agent's desktop couldn't be prepared: ${prepared === "late" ? `still running after ${this.stepMs / 1000} s` : tailLines(logFile, 3).join(" ")}`,
          );
        }
        const preparedAt = this.now();
        // The agentes.chat look (desktop-look.ts), as the agent, while the screen server starts: it writes only
        // into HOME, which XFCE reads and Xtigervnc doesn't. Without it the desktop starts as its HOME has it.
        const look = lookCommand(user.home, this.lookOptions(agent, user, files.passwd));
        const looking = this.step(
          this.sys.spawn([...user.prefix, ...look.argv], { cwd: "/", env: user.env, input: look.input, log }),
        ).then((code) => ({ code, ms: this.now() - preparedAt }));
        const env = { ...user.env, HOME: user.home };
        let x: DesktopProcess;
        let pid: number;
        try {
          this.writePasswords(files.passwd, vncPasswordFile(passwords.full, passwords.view), user.ids);
          x = this.sys.spawn([...user.prefix, xvnc, `:${display}`, ...xvncArgs(files, desktopName(agent))], {
            cwd: user.home,
            env,
            detached: true,
            log,
          });
          pid = await this.waitForXvnc(x, display, files.socket, logFile, user.tmp);
        } catch (err) {
          // Its next start's prepare renames files the look still writes (xfwm4's settings among them).
          await looking;
          throw err;
        }
        const screenAt = this.now();
        const { code: looked, ms: lookMs } = await looking;
        if (looked !== 0) {
          this.opts.log(
            `the desktop of ${agent.handle} keeps the look its home has: writing the agentes.chat look ${looked === "late" ? `was stopped after ${this.stepMs / 1000} s` : `failed (exit ${looked})`}`,
          );
        }
        const sessionAt = this.now();
        const session = this.sys.spawn([...user.prefix, dbus, "--exit-with-session", "xfce4-session"], {
          cwd: user.home,
          env: sessionEnv(env, display, files.xauthority),
          detached: true,
          log,
        });
        const saved: Saved = {
          agent,
          display,
          pid,
          sessionPid: session.pid,
          home: user.home,
          ...files,
          passwords,
          startedAt: this.now(),
          ...(looked === 0 ? { look: look.id } : {}),
          params: LIVE_PARAMS,
        };
        const d: Desktop = {
          ...saved,
          file: path.join(this.dir, `${id8(agent)}.json`),
          lastUsed: saved.startedAt,
          streams: 0,
          refresh: { current: true, queued: false, params: true, look: looked === 0 },
          untold: true,
        };
        writeJson(d.file, saved);
        // Left by a desktop the computer's restart or move ended: any that ended while a runner ran forgot it.
        const open = parseOpen(readJson(this.openFile(agent)));
        if (open) d.reopen = open;
        this.add(d);
        void x.exited.then(() => this.ended(d));
        void session.exited.then(() => this.ended(d));
        await this.listenBrowser(d);
        const now = this.now();
        this.opts.log(
          `the desktop of ${agent.handle} started on :${display} in ${seconds(now - began)}: room and its user ${seconds(userAt - began)}, prepared in ${seconds(preparedAt - userAt)}, its screen in ${seconds(screenAt - preparedAt)} (the look in ${seconds(lookMs)} meanwhile), its session in ${seconds(now - sessionAt)}`,
        );
        return d;
      } finally {
        closeSync(log);
      }
    } finally {
      if (display !== null) this.claimed.delete(display);
    }
  }

  /**
   * Browser on the desktop reaches the runner on its socket (`desktop-browser.ts`), for as long as the desktop runs.
   * Why a click failed goes in the log: the desktop's note says it in a person's words.
   */
  private async listenBrowser(d: Desktop) {
    const open = this.opts.openBrowser;
    if (!open) return;
    const socket = browserSocket(d.passwd);
    try {
      const server = await serveBrowser(socket, (installing) =>
        open(d.agent, installing).catch((err: unknown) => {
          this.opts.log(
            `Browser on the desktop of ${d.agent.handle} didn't open: ${err instanceof Error ? err.message : String(err)}`,
          );
          throw err;
        }),
      );
      if (d.ending) closeBrowser(server, socket);
      else d.browser = server;
    } catch (err) {
      this.opts.log(
        `Browser on the desktop of ${d.agent.handle} can't reach the runner: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** A step run as the agent: its exit code, or "late" once it has run `ms` (`STEP_MS`; then it is stopped). */
  private async step(p: DesktopProcess, ms = this.stepMs): Promise<number | null | "late"> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), ms);
    });
    const code = await Promise.race([p.exited, late]);
    clearTimeout(timer);
    if (code === "late" && p.pid) this.sys.kill(p.pid, "SIGTERM");
    return code;
  }

  /**
   * The agent of a running desktop as it is now (a request, the server's list). Renamed, its look is due again: the
   * terminal's prompt names it. A refresh waits for this: a single-user agent's user (`opts.user`) is found by its
   * handle, and one taken back from an earlier runner may be stale, its folder since moved to a new handle.
   */
  private current(d: Desktop, agent: AgentScope) {
    if (desktopName(agent) !== desktopName(d.agent)) d.refresh.look = false;
    d.agent = agent;
    d.refresh.current = true;
  }

  /** What its look depends on besides its HOME (desktop-look.ts), on this computer, from this runner. */
  private lookOptions(agent: AgentScope, user: DesktopUser, passwd: string): LookOptions {
    const exists = (file: string) => this.sys.exists(file);
    return {
      theme: lookTheme(exists),
      dock: lookDock(exists),
      agent,
      shell: user.env.SHELL ?? "",
      browser: [...this.runner, "desktop-browser", browserSocket(passwd)],
      shared: this.opts.shared?.() ?? null,
    };
  }

  /**
   * A running desktop gets what changed since it started, without a restart, so nothing open on it closes: the
   * `LIVE_PARAMS` its Xtigervnc lacks (as soon as it can), and a newer look (`lookCommand` live), once nobody
   * watches it and its agent hasn't used it for a minute, since its dock starts over. Each is recorded in its
   * `<id8>.json`, so it happens once; what fails is said in the log, and the next runner tries again.
   */
  private async refresh(d: Desktop) {
    try {
      if (this.desktops.get(d.agent.id) !== d || !this.alive(d)) return;
      const has = d.params ?? this.sys.cmdline(d.pid)?.map((arg) => arg.slice(1)) ?? [];
      const missing = d.refresh.params ? [] : LIVE_PARAMS.filter((p) => !has.includes(p));
      if (missing.length === 0) d.refresh.params = true;
      const idle = () =>
        d.streams === 0 && !this.opts.inUse?.(d.agent.id) && this.now() - d.lastUsed >= REFRESH_IDLE_MS;
      if (missing.length === 0 && (d.refresh.look || !idle())) return;
      const user = await this.opts.user(d.agent);
      const who = `the desktop of ${d.agent.handle}`;
      if (this.asRoot(user)) {
        d.refresh.params = d.refresh.look = true;
        this.opts.log(`${who} stays as it is: the runner runs as root, and nothing on a desktop does`);
        return;
      }
      const log = openSync(path.join(this.dir, `${id8(d.agent)}.log`), "a", 0o600);
      try {
        const env = { ...user.env, HOME: d.home, DISPLAY: `:${d.display}`, XAUTHORITY: d.xauthority };
        const run = (argv: string[], input?: string, ms = this.stepMs) =>
          this.step(this.sys.spawn([...user.prefix, ...argv], { cwd: "/", env, log, ...(input ? { input } : {}) }), ms);
        const why = (code: number | null | "late", ms = this.stepMs) =>
          code === "late" ? `was stopped after ${ms / 1000} s` : `failed (exit ${code})`;
        if (missing.length > 0) {
          const set = await run(["/bin/sh", "-c", PARAMS_SCRIPT, "agentes-xvnc", ...missing]);
          if (set === 0) {
            d.params = LIVE_PARAMS;
            this.persist(d);
            this.opts.log(`${who} took ${missing.join(" ")} while running`);
          } else {
            const names = missing.map((p) => p.split("=")[0]).join(", ");
            this.opts.log(`${who} keeps its earlier ${names} until it starts again: setting it ${why(set)}`);
          }
          d.refresh.params = true;
        }
        // Asked again: a viewer who came while the flags were set would see the dock start over.
        if (d.refresh.look || !idle()) return;
        const look = lookCommand(d.home, this.lookOptions(d.agent, user, d.passwd), true);
        if (d.look !== look.id) {
          const ms = this.stepMs * LIVE_LOOK_STEPS;
          // Single-user mode moves an agent's folder with its handle: its session still has the old HOME.
          const looked = user.home === d.home ? await run(look.argv, look.input, ms) : "moved";
          if (looked === 0) {
            d.look = look.id;
            this.persist(d);
            this.opts.log(`${who} has this runner's look`);
          } else {
            const reason =
              looked === "moved"
                ? "its home moved while it ran"
                : (typeof looked === "number" && LOOK_FAILED[looked]) || `writing it ${why(looked, ms)}`;
            this.opts.log(`${who} keeps its earlier look until it starts again: ${reason}`);
          }
        }
        d.refresh.look = true;
      } finally {
        closeSync(log);
      }
    } finally {
      d.refresh.queued = false;
    }
  }

  private persist(d: Desktop) {
    writeJson(d.file, savedOf(d));
  }

  /** What runs as `user` would run as root: the runner is root, with no launcher for the agent (`NOT_AS_ROOT`). */
  private asRoot(user: DesktopUser) {
    return this.sys.uid === 0 && user.prefix.length === 0;
  }

  /** Xvnc's own pid once it holds the display and its socket is there; its output says why when it doesn't. */
  private async waitForXvnc(
    x: DesktopProcess,
    display: number,
    socket: string,
    logFile: string,
    lockDir?: string,
  ): Promise<number> {
    let gone = !x.pid;
    void x.exited.then(() => {
      gone = true;
    });
    const deadline = Date.now() + XVNC_START_MS;
    while (!gone && Date.now() < deadline) {
      const pid = this.lockPid(display, lockDir);
      if (pid !== null && this.isXvnc(pid, display) && existsSync(socket)) return pid;
      await sleep(25);
    }
    if (x.pid) this.sys.kill(x.pid, "SIGTERM");
    const pid = this.lockPid(display, lockDir);
    if (pid !== null && this.isXvnc(pid, display)) this.sys.kill(pid, "SIGTERM");
    throw new RunnerError(
      "internal",
      `The agent's desktop didn't start: ${tailLines(logFile, 3).join(" ") || "no answer in time"}`.slice(0, 500),
    );
  }

  /**
   * The password file Xvnc reads. In system mode it is the runner's (root),
   * readable by the agent's group, in folders only root writes: the agent
   * can read it, never change it.
   */
  private writePasswords(file: string, bytes: Buffer, ids: DesktopUser["ids"]) {
    if (!ids) {
      writeFileSync(file, bytes, { mode: 0o600 });
      chmodSync(file, 0o600);
      return;
    }
    const owner = process.getuid?.() ?? 0;
    const dir = path.dirname(file);
    mkdirSync(dir, { recursive: true, mode: 0o750 });
    chmodSync(path.dirname(dir), 0o711);
    chownSync(dir, owner, ids.gid);
    chmodSync(dir, 0o750);
    const tmp = `${file}.tmp`;
    rmSync(tmp, { force: true });
    writeFileSync(tmp, bytes, { mode: 0o440 });
    chownSync(tmp, owner, ids.gid);
    chmodSync(tmp, 0o440);
    renameSync(tmp, file);
  }

  /**
   * A desktop's processes ended (or were found gone): it starts again unless
   * it was stopped on purpose, replaced, or already restarted too often.
   */
  private ended(d: Desktop) {
    if (d.ending || this.stopping) return;
    const { agent } = d;
    void this.serial(agent.id, async () => {
      if (d.ending || this.desktops.get(agent.id) !== d) return;
      await this.end(d);
      const now = this.now();
      const recent = (this.restarts.get(agent.id) ?? []).filter((t) => now - t < RESTARTS.windowMs);
      if (recent.length >= RESTARTS.max) {
        this.opts.log(
          `the desktop of ${agent.handle} ended by itself too often; it stays off until it is asked for again`,
        );
        return;
      }
      this.restarts.set(agent.id, [...recent, now]);
      this.opts.log(`the desktop of ${agent.handle} ended by itself; starting it again`);
      await this.start(agent);
    }).catch((err: unknown) => {
      this.opts.log(
        `the desktop of ${agent.handle} didn't start again: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  /** Stops the desktop's processes (pids checked first: one could be reused) and forgets it, and what was open on it. */
  private async end(d: Desktop) {
    d.ending = true;
    if (this.desktops.get(d.agent.id) === d) this.desktops.delete(d.agent.id);
    if (this.isSession(d.sessionPid)) this.sys.kill(d.sessionPid, "SIGTERM");
    if (this.isXvnc(d.pid, d.display)) {
      this.sys.kill(d.pid, "SIGTERM");
      const deadline = Date.now() + KILL_WAIT_MS;
      while (this.isXvnc(d.pid, d.display) && Date.now() < deadline) await sleep(50);
      if (this.isXvnc(d.pid, d.display)) this.sys.kill(d.pid, "SIGKILL");
    }
    if (d.browser) closeBrowser(d.browser, browserSocket(d.passwd));
    rmSync(d.file, { force: true });
    rmSync(this.openFile(d.agent), { force: true });
    rmSync(d.passwd, { force: true });
    if (this.desktops.size === 0) this.stopSweeps();
  }

  private alive(d: Desktop) {
    return this.isXvnc(d.pid, d.display) && this.isSession(d.sessionPid);
  }

  private isXvnc(pid: number, display: number) {
    const argv = this.sys.cmdline(pid);
    return !!argv && path.basename(argv[0] ?? "") === "Xtigervnc" && argv[1] === `:${display}`;
  }

  private isSession(pid: number) {
    return pid > 0 && (this.sys.cmdline(pid)?.some((a) => path.basename(a) === "xfce4-session") ?? false);
  }

  /** The pid in a display's lock (an agent's own /tmp, or the computer's): never a link or a pipe an agent put there. */
  private lockPid(display: number, dir = this.opts.lockDir ?? X_LOCK_DIR): number | null {
    const pid = readSmallJson(path.join(dir, `.X${display}-lock`), 64);
    return isPid(pid) ? pid : null;
  }

  /**
   * Nobody holds the display (`held`: whose abstract socket someone holds). A lock whose server is gone is removed,
   * with its socket.
   */
  private displayFree(display: number, held: ReadonlySet<number>): boolean {
    if (held.has(display)) return false;
    const lockDir = this.opts.lockDir ?? X_LOCK_DIR;
    const lock = path.join(lockDir, `.X${display}-lock`);
    if (!existsSync(lock)) return true;
    const pid = this.lockPid(display);
    if (pid !== null && this.sys.cmdline(pid) !== null) return false;
    try {
      rmSync(lock, { force: true });
      rmSync(path.join(lockDir, ".X11-unix", `X${display}`), { force: true });
      return true;
    } catch {
      return false;
    }
  }

  /** The display slots no desktop of ours and no other process holds. */
  private freeSlots(): number[] {
    const ours = new Set([...this.claimed, ...[...this.desktops.values()].map((d) => d.display)]);
    const held = abstractDisplays(this.sys.unixSockets?.() ?? "");
    return [...Array(SLOT_COUNT).keys()].filter(
      (slot) => !ours.has(FIRST_DISPLAY + slot) && this.displayFree(FIRST_DISPLAY + slot, held),
    );
  }

  /**
   * The agent's display: the one it had before (`slots.json`) when nobody
   * holds it, else the first free one no other agent had, else any free one.
   */
  private pickDisplay(agentId: string): number {
    const file = path.join(this.dir, SLOTS_FILE);
    const saved = readJson<unknown>(file);
    const slots = new Map(
      isRecord(saved) ? Object.entries(saved).filter((e): e is [string, number] => isSlot(e[1])) : [],
    );
    const open = this.freeSlots();
    const own = slots.get(agentId);
    let slot = own !== undefined && open.includes(own) ? own : undefined;
    if (slot === undefined) {
      const others = new Set([...slots].filter(([id]) => id !== agentId).map(([, s]) => s));
      slot = open.find((s) => !others.has(s)) ?? open[0];
    }
    if (slot === undefined) throw new RunnerError("desktop_busy", "Every display for the agents' desktops is taken");
    for (const [id, s] of slots) if (s === slot) slots.delete(id);
    slots.set(agentId, slot);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeJson(file, Object.fromEntries(slots));
    this.claimed.add(FIRST_DISPLAY + slot);
    return FIRST_DISPLAY + slot;
  }
}

/**
 * Xtigervnc's flags (after `:N`): its fixed size; VNC only on the Unix
 * socket, 0600; VncAuth with the password file (never `-ac` or `-nopw`);
 * viewers never resize it; only a copy reaches the person in control, never
 * a selection (PRIMARY is still set from what they paste, for Shift+Insert
 * in a terminal); no blacklist (TigerVNC counts attempts, not
 * failures, so a burst of reconnects after a deploy would lock everyone out,
 * and behind a 0600 socket it protects nothing); X only through the cookie
 * file, no TCP; no screen saver.
 */
function xvncArgs(files: { socket: string; xauthority: string; passwd: string }, name: string): string[] {
  return [
    "-geometry",
    `${DESKTOP_SIZE.width}x${DESKTOP_SIZE.height}`,
    "-depth",
    "24",
    "-rfbport",
    "-1",
    "-rfbunixpath",
    files.socket,
    "-rfbunixmode",
    "0600",
    "-SecurityTypes",
    "VncAuth",
    "-PasswordFile",
    files.passwd,
    "-AlwaysShared",
    "-AcceptSetDesktopSize=0",
    ...LIVE_PARAMS.map((p) => `-${p}`),
    "-FrameRate=30",
    "-UseBlacklist=0",
    "-auth",
    files.xauthority,
    "-nolisten",
    "tcp",
    "-s",
    "0",
    "-desktop",
    name,
  ];
}

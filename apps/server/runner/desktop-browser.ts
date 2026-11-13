import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { chmodSync, chownSync, rmSync, statSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import path from "node:path";
import type { MachineErrorCode } from "@agenteschat/adapters/machine-protocol";
import { BROWSER_ICON, NOTE_ICON, NOTE_WM_CLASS, WAIT_WM_CLASS } from "./desktop-look";
import { toMachineError } from "./errors";

/**
 * Browser on an agent's desktop (ADR 0058 §7): the dock's and the apps menu's Browser runs
 * `agentes-runner desktop-browser <socket>`, which asks the runner, over that desktop's socket, to bring the
 * agent's own Chrome onto it.
 *
 * - The runner owns that Chrome (its debugging port, its pids, its profile), so the runner starts or moves it:
 *   never a second Chrome on the profile. Its sign-ins are the agent's, so whoever signs in to a site there
 *   signs the agent in.
 * - The socket sits next to the desktop's password file: in system mode in root's folder for that agent, which
 *   only the agent's group may enter, so only the agent's own user reaches it (and it may already run anything as
 *   itself). It takes one word, `open`: no address, no flag, nothing that widens what the browser reaches. The
 *   agent's own code can connect too: it answers one click at a time and holds a few connections at most.
 * - The runner answers once Chrome's window is on the desktop. When that takes more than a moment, a small window
 *   on the desktop says the browser is opening (or, before the agent's first browser, that `agent-browser`
 *   downloads) until then; when the browser can't open, one says why.
 */

/** The socket's name, in the folder of the desktop's password file. */
export const BROWSER_SOCKET = "browser.sock";
/** The one word the launcher says. */
const OPEN = "open";
/** A connection that hasn't said it by then is dropped. */
const ASK_MS = 5000;
/** Connections held at once: each is one of the runner's open files (root's, in system mode). */
const CONNECTIONS_MAX = 4;
/** `agent-browser`'s download, then Chrome's start: a click is given up after this. */
export const SHOW_MS = 16 * 60_000;
/**
 * A click answered sooner (Chrome already open, brought to the front: from the apps menu, say, since docklike handles
 * a plain click on Browser while Chrome has a window itself) shows no window of its own: Chrome's is the answer. A
 * Chrome that starts takes seconds, and the note itself most of a second to show on a small computer.
 */
const QUIET_MS = 300;

/**
 * Answers the Browser of one agent's desktop on `socket`: `open` in; `installing` while `agent-browser`
 * downloads first, then `ok` (its window is on the desktop) or `error <code>`. One click at a time, until its
 * answer: one that comes meanwhile is told `busy` and starts nothing, and the first one's launcher shows what
 * happens. The socket takes its folder's group (the agent's, in system mode), and only that group may write to it.
 */
export async function serveBrowser(socket: string, open: (installing: () => void) => Promise<void>): Promise<Server> {
  let busy = false;
  const say = (conn: Socket, line: string) => {
    if (!conn.destroyed) conn.write(`${line}\n`);
  };
  const end = (conn: Socket, line: string) => {
    if (!conn.destroyed) conn.end(`${line}\n`);
  };
  const show = (conn: Socket) => {
    if (busy) return end(conn, "busy");
    busy = true;
    (async () => open(() => say(conn, "installing")))()
      .finally(() => {
        busy = false;
      })
      .then(
        () => end(conn, "ok"),
        (err: unknown) => end(conn, `error ${toMachineError(err).code}`),
      );
  };
  rmSync(socket, { force: true });
  const server = createServer((conn) => {
    let heard = "";
    const late = setTimeout(() => conn.destroy(), ASK_MS);
    conn.setEncoding("utf8");
    conn.on("error", () => undefined);
    conn.on("close", () => clearTimeout(late));
    const listen = (chunk: string) => {
      heard += chunk;
      const at = heard.indexOf("\n");
      if (at < 0) {
        if (heard.length > OPEN.length) conn.destroy();
        return;
      }
      clearTimeout(late);
      conn.off("data", listen);
      if (heard.slice(0, at) === OPEN) show(conn);
      else conn.destroy();
    };
    conn.on("data", listen);
  });
  server.maxConnections = CONNECTIONS_MAX;
  const events = server as unknown as EventEmitter;
  await new Promise<void>((resolve, reject) => {
    events.once("error", reject);
    server.listen(socket, () => {
      events.off("error", reject);
      resolve();
    });
  });
  events.on("error", () => undefined);
  try {
    const { gid } = statSync(path.dirname(socket));
    if (gid !== process.getgid?.()) chownSync(socket, process.getuid?.() ?? 0, gid);
    chmodSync(socket, 0o660);
  } catch (err) {
    closeBrowser(server, socket);
    throw err;
  }
  return server;
}

/** Closes a Browser socket and removes its file. */
export function closeBrowser(server: Server, socket: string) {
  server.close();
  rmSync(socket, { force: true });
}

/** A small window on the desktop: the wait while the browser opens, or why it didn't. */
export type DesktopNote = (kind: "wait" | "error", text: string) => { close(): void };

const OPENING = "Opening the browser…";
const INSTALLING = "Getting the browser ready…\nThe first time takes about a minute. It opens by itself.";
const FAILED = "The browser didn't open.";
/** Why, by the runner's error code, in the words of the person who clicked; the runner's log keeps its own. */
const REASONS = new Map<string, string>([
  ["not_allowed", "The browser is turned off on this computer."],
  ["paused", "This computer is paused. Open the browser again once it resumes."],
  ["desktop_busy", "This computer is short of memory right now. Try again in a few minutes."],
  ["browser_unavailable", "The browser can't run on this computer right now. Try again in a few minutes."],
] satisfies [MachineErrorCode, string][]);
const AGAIN = "Something went wrong. Try again in a minute.";
/** A note's text columns; its window has two more on each side. */
const NOTE_COLUMNS = 56;

/**
 * The note as an xfce4-terminal of its own (every desktop has one), small, with no menu or bars: the text
 * wrapped and indented, the cursor hidden, a row free above and below. The wait stays until closed, with Browser's
 * icon; the reason until Enter. Each has a window class of its own (`desktop-look.ts`), so a click on Browser
 * always reaches the runner: told `busy` during the wait, trying again after the reason.
 */
export function noteArgs(kind: "wait" | "error", text: string): string[] {
  const error = kind === "error";
  const rows = text.split("\n").reduce((n, line) => n + Math.max(1, Math.ceil(line.length / NOTE_COLUMNS)), 0);
  const end = error ? "printf '\\n  %s' 'Press Enter to close.'; read -r _" : `exec sleep ${SHOW_MS / 1000}`;
  return [
    "--disable-server",
    `--class=${error ? NOTE_WM_CLASS : WAIT_WM_CLASS}`,
    "--title=Browser",
    `--icon=${error ? NOTE_ICON : BROWSER_ICON}`,
    "--hide-menubar",
    "--hide-toolbar",
    "--hide-scrollbar",
    `--geometry=${NOTE_COLUMNS + 4}x${rows + (error ? 4 : 2)}`,
    "-x",
    "/bin/sh",
    "-c",
    `printf '\\033[?25l\\n'; printf '%s\\n' "$1" | fold -s -w ${NOTE_COLUMNS} | sed 's/^/  /'; ${end}`,
    "sh",
    text,
  ];
}

const terminalNote: DesktopNote = (kind, text) => {
  const child = spawn("xfce4-terminal", noteArgs(kind, text), { stdio: "ignore", detached: kind === "error" });
  (child as unknown as EventEmitter).on("error", () => undefined);
  if (kind === "error") child.unref();
  return { close: () => child.kill() };
};

/** The runner's answer: null once the browser is open (or another click's launcher shows it), else why not. */
function ask(socket: string, installing: () => void, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let buffer = "";
    let done = false;
    const conn = createConnection(socket);
    const finish = (reason: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      conn.destroy();
      resolve(reason);
    };
    const timer = setTimeout(() => finish("It is taking too long. Try again in a minute."), timeoutMs);
    conn.setEncoding("utf8");
    conn.on("connect", () => conn.write(`${OPEN}\n`));
    conn.on("data", (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (line === "installing") installing();
        else if (line === "ok" || line === "busy") return finish(null);
        else if (line.startsWith("error ")) return finish(REASONS.get(line.slice("error ".length)) ?? AGAIN);
      }
    });
    conn.on("error", () => finish("agentes.chat isn't running on this computer right now. Try again in a minute."));
    conn.on("close", () => finish("agentes.chat stopped before it opened. Try again in a minute."));
  });
}

/**
 * `agentes-runner desktop-browser <socket>`, from the desktop (its session's environment): asks for the agent's
 * browser on it. A note says it is opening once that takes more than a moment, and that `agent-browser`
 * downloads first as soon as the runner says so; another one says why when it doesn't open.
 */
export async function runDesktopBrowser(
  socket: string,
  o: { note?: DesktopNote; timeoutMs?: number; quietMs?: number } = {},
): Promise<number> {
  const note = o.note ?? terminalNote;
  let wait: ReturnType<DesktopNote> | null = null;
  let installing = false;
  const quiet = setTimeout(() => {
    wait ??= note("wait", OPENING);
  }, o.quietMs ?? QUIET_MS);
  const reason = await ask(
    socket,
    () => {
      if (installing) return;
      installing = true;
      wait?.close();
      wait = note("wait", INSTALLING);
    },
    o.timeoutMs ?? SHOW_MS,
  );
  clearTimeout(quiet);
  (wait as ReturnType<DesktopNote> | null)?.close();
  if (reason === null) return 0;
  note("error", `${FAILED}\n${reason}`);
  return 1;
}

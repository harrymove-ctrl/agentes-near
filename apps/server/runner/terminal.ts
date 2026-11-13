import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type AgentScope,
  type RunnerTerminalInfo,
  STREAM_CLOSE,
  STREAM_LIMITS,
} from "@agenteschat/adapters/machine-protocol";
import type { Launcher } from "./agent-users";
import { type DesktopSystem, NOT_AS_ROOT, runnerEnv } from "./desktop-session";
import { RunnerError } from "./errors";
import { hasBunTerminal, runtimeName } from "./launch";
import { agentFolderName } from "./paths";
import type { DataSocket } from "./streams";

/**
 * Terminals people open on an agent's computer (ADR 0058 §6): the login
 * shell of the agent's OS user in a PTY (`Bun.Terminal`), in the agent's
 * folder, with none of the agent's secrets in its environment. Its bytes go
 * both ways over the stream's data socket; a resize comes as a control frame,
 * and how the shell ended goes back as `exit` before the socket closes.
 *
 * - A PTY can't stop reading, so output the data socket can't take (more than
 *   `terminalBufferMax` queued) is dropped, and a marker says so once it
 *   drained.
 * - Hung up after `terminalIdleMs` with nothing either way, and after
 *   `terminalMaxMs` in any case. Nothing is kept: a new stream is a new shell.
 */

const encode = (text: string) => new TextEncoder().encode(text);
const SKIPPED = encode("\r\n[output skipped: too fast]\r\n");
/** A shell told to hang up is killed this long after. */
const KILL_GRACE_MS = 3000;
/** A shell's last output is read right after it exits: it is waited for this long at most. */
const LAST_OUTPUT_MS = 500;
/** How often a terminal that skips output looks whether the data socket drained. */
const DRAIN_POLL_MS = 50;

/** As whom and where an agent's terminal runs. */
export interface TerminalUser {
  /** Runs the shell as the agent (`[]`: as the runner's own user). */
  prefix: string[];
  /** The shell's whole environment; the terminal adds TERM and COLORTERM. */
  env: Record<string, string>;
  cwd: string;
}

/** Single-user mode: the runner's own user, HOME as the agent's commands have it, in the agent's folder. */
export const runnerTerminalUser = (agentFolder: string): TerminalUser => ({
  prefix: [],
  env: { ...runnerEnv(os.homedir()), LANG: process.env.LANG || "C.UTF-8" },
  cwd: agentFolder,
});

/**
 * System mode: the agent's own OS user through its launcher, in the agent's folder in its home once its
 * worker made it, else in its home. Root changes only into the home, which root made where the agent can't
 * replace it; the agent can swap its folder for a link at any moment, even between a check and the spawn,
 * so the agent's own user changes into it. Root never makes that folder (it would be root's).
 */
export function systemTerminalUser(launcher: Launcher, agent: AgentScope): TerminalUser {
  const folder = path.join(launcher.home, agentFolderName(agent).name);
  return {
    prefix: [...launcher.prefix, "/bin/sh", "-c", 'cd "$1" 2>/dev/null; shift; exec "$@"', "sh", folder],
    env: launcher.env,
    cwd: launcher.home,
  };
}

export interface PtyOptions {
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  /** The shell's output. */
  data(bytes: Uint8Array): void;
}

/** A process in a PTY. */
export interface Pty {
  write(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  /** Closes the PTY: the shell and what runs in it get SIGHUP, as when a terminal window closes. */
  hangup(): void;
  kill(): void;
  /** Settles once it exited and its last output was read: its exit code, or null after a signal. */
  exited: Promise<number | null>;
}

export type SpawnPty = (argv: string[], opts: PtyOptions) => Pty;

const spawnPty: SpawnPty = (argv, o) => {
  let eof: () => void = () => undefined;
  const lastOutput = new Promise<void>((resolve) => {
    eof = () => resolve();
  });
  const proc = Bun.spawn(argv, {
    cwd: o.cwd,
    env: o.env,
    terminal: { cols: o.cols, rows: o.rows, data: (_t, bytes) => o.data(bytes), exit: () => eof() },
  });
  const terminal = proc.terminal;
  if (!terminal) {
    proc.kill("SIGKILL");
    throw new RunnerError("terminal_unavailable", "This runtime opened no terminal");
  }
  const close = () => {
    try {
      terminal.close();
    } catch {
      // closed already
    }
  };
  return {
    write: (data) => {
      terminal.write(data);
    },
    resize: (cols, rows) => terminal.resize(cols, rows),
    hangup: () => {
      close();
      proc.kill("SIGHUP");
    },
    kill: () => proc.kill("SIGKILL"),
    exited: proc.exited.then(async (code) => {
      await Promise.race([lastOutput, sleep(LAST_OUTPUT_MS)]);
      close();
      return proc.signalCode === null ? code : null;
    }),
  };
};

/** The user's login shell when it is there, else bash, else sh. */
const loginShell = (shell: string | undefined) =>
  [shell, "/bin/bash"].find((s): s is string => !!s && path.isAbsolute(s) && existsSync(s)) ?? "/bin/sh";

export interface TerminalLimits {
  /** Output queued on the data socket beyond which it is dropped. */
  bufferMax: number;
  idleMs: number;
  maxMs: number;
  perAgent: number;
  perMachine: number;
}

export interface TerminalsOptions {
  /** As whom and where the agent's terminal runs (single-user mode: `runnerTerminalUser`). */
  user(agent: AgentScope): Promise<TerminalUser>;
  /** System mode: `user` runs each agent as its own OS user (its launcher), so a runner running as root may serve. */
  agentUsers?: boolean;
  log(line: string): void;
  /** Tests: the PTY, the computer and shorter limits. */
  spawn?: SpawnPty;
  system?: Pick<DesktopSystem, "platform" | "pty" | "runtime" | "uid">;
  limits?: Partial<TerminalLimits>;
}

/** One open terminal: whose, and how to end it with a word for the person. */
interface Live {
  agentId: string;
  end(why: string): void;
}

export class Terminals {
  private readonly live = new Set<Live>();
  private readonly limits: TerminalLimits;

  constructor(private readonly opts: TerminalsOptions) {
    this.limits = {
      bufferMax: STREAM_LIMITS.terminalBufferMax,
      idleMs: STREAM_LIMITS.terminalIdleMs,
      maxMs: STREAM_LIMITS.terminalMaxMs,
      perAgent: STREAM_LIMITS.terminalsPerAgent,
      perMachine: STREAM_LIMITS.terminalsPerMachine,
      ...opts.limits,
    };
  }

  private get system() {
    return (
      this.opts.system ?? {
        platform: process.platform,
        pty: hasBunTerminal(),
        runtime: runtimeName(),
        uid: process.getuid?.() ?? null,
      }
    );
  }

  /** `hello.terminal`: whether people can open terminals here, and what is missing when they can't. */
  info(): RunnerTerminalInfo {
    const sys = this.system;
    if (sys.platform === "win32") {
      return {
        available: false,
        reason: "Terminals run on Linux and Mac computers only",
        code: "terminal_unsupported",
      };
    }
    if (sys.uid === 0 && !this.opts.agentUsers) return { available: false, reason: NOT_AS_ROOT, code: "not_as_root" };
    if (!sys.pty) {
      return {
        available: false,
        reason: `The terminal needs the runner on Bun 1.3.5 or newer (it runs on ${sys.runtime})`,
        code: "runner_bun_old",
      };
    }
    return { available: true };
  }

  /** Open terminals: an agent's, or all of them. */
  count(agentId?: string): number {
    if (agentId === undefined) return this.live.size;
    let n = 0;
    for (const t of this.live) if (t.agentId === agentId) n++;
    return n;
  }

  closeAgent(agentId: string, why: string) {
    for (const terminal of [...this.live]) if (terminal.agentId === agentId) terminal.end(why);
  }

  /** Every terminal hangs up (the machine's terminal switch went off). */
  closeAll(why = "the terminal was turned off on this computer") {
    for (const t of [...this.live]) t.end(why);
  }

  /**
   * `stream.open` of a terminal: the shell as the agent in a PTY of that
   * size, then its data socket (`dial`); resolves once both are up, and the
   * bytes go on flowing until either ends. What the shell prints before the
   * socket is ready waits for it.
   */
  async open(agent: AgentScope, size: { cols: number; rows: number }, dial: () => Promise<DataSocket>) {
    const info = this.info();
    if (!info.available) throw new RunnerError("terminal_unavailable", info.reason ?? "No terminal here");
    const limits = this.limits;
    if (this.count(agent.id) >= limits.perAgent || this.live.size >= limits.perMachine) {
      throw new RunnerError("too_many_streams", "As many terminals are open here as this computer takes");
    }
    // Ended while it opens (the switch went off): it ends once it is up.
    let endWhenUp: string | null = null;
    const live: Live = {
      agentId: agent.id,
      end: (why) => {
        endWhenUp ??= why;
      },
    };
    this.live.add(live);
    let pty: Pty | null = null;
    try {
      const user = await this.opts.user(agent);
      if (this.system.uid === 0 && user.prefix.length === 0) throw new RunnerError("terminal_unavailable", NOT_AS_ROOT);
      let socket: DataSocket | null = null;
      let socketOpen = false;
      const early: Uint8Array[] = [];
      let earlyBytes = 0;
      let skipping = false;
      let drain: ReturnType<typeof setInterval> | undefined;
      let last = Date.now();
      const drained = () => {
        if (!socket || socket.bufferedAmount > limits.bufferMax / 2) return;
        clearInterval(drain);
        drain = undefined;
        skipping = false;
        if (socketOpen) socket.send(SKIPPED);
      };
      const output = (bytes: Uint8Array) => {
        last = Date.now();
        // Skipping, or the person left and the shell is hanging up.
        if (skipping || (socket && !socketOpen)) return;
        if ((socket ? socket.bufferedAmount : earlyBytes) > limits.bufferMax) {
          skipping = true;
          drain = setInterval(drained, DRAIN_POLL_MS);
          return;
        }
        if (socket) socket.send(bytes);
        else {
          early.push(bytes.slice());
          earlyBytes += bytes.byteLength;
        }
      };
      const shell = loginShell(user.env.SHELL);
      pty = (this.opts.spawn ?? spawnPty)([...user.prefix, shell, "-l"], {
        cwd: user.cwd,
        env: { ...user.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
        ...size,
        data: output,
      });
      const shellPty = pty;
      socket = await dial();
      const data = socket;
      socketOpen = true;
      for (const chunk of early.splice(0)) data.send(chunk);
      earlyBytes = 0;

      let ending: string | null = null;
      let exited = false;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const end = (why: string) => {
        if (ending !== null || exited) return;
        ending = why;
        if (socketOpen) data.send(encode(`\r\n[${why}]\r\n`));
        shellPty.hangup();
        killTimer = setTimeout(() => shellPty.kill(), KILL_GRACE_MS);
      };
      live.end = end;
      const idle = () => {
        const left = limits.idleMs - (Date.now() - last);
        if (left > 0) idleTimer = setTimeout(idle, left);
        else end(`closed after ${Math.round(limits.idleMs / 60_000)} minutes with nothing typed or shown`);
      };
      idleTimer = setTimeout(idle, limits.idleMs);
      const maxTimer = setTimeout(
        () => end(`closed: a terminal stays open ${Math.round(limits.maxMs / 3_600_000)} hours at most`),
        limits.maxMs,
      );
      data.listen({
        bytes: (bytes) => {
          last = Date.now();
          shellPty.write(bytes);
        },
        control: (frame) => {
          if (frame.type === "resize") shellPty.resize(frame.cols, frame.rows);
        },
        closed: () => {
          socketOpen = false;
          end("the person closed it");
        },
      });
      this.opts.log(`a terminal as ${agent.handle} opened (${size.cols}×${size.rows})`);
      if (endWhenUp !== null) end(endWhenUp);
      const openedAt = Date.now();
      void shellPty.exited.then((code) => {
        exited = true;
        clearTimeout(idleTimer);
        clearTimeout(maxTimer);
        clearTimeout(killTimer);
        clearInterval(drain);
        this.live.delete(live);
        if (socketOpen) {
          socketOpen = false;
          data.send(JSON.stringify({ type: "exit", code }));
          data.close(STREAM_CLOSE.normal, "the shell ended");
        }
        const minutes = Math.round((Date.now() - openedAt) / 60_000);
        this.opts.log(
          `the terminal as ${agent.handle} ended after ${minutes} min (${ending ?? (code === null ? "a signal" : `exit ${code}`)})`,
        );
      });
    } catch (err) {
      this.live.delete(live);
      if (pty) {
        pty.hangup();
        pty.kill();
      }
      if (err instanceof RunnerError) throw err;
      throw new RunnerError(
        "internal",
        `The terminal couldn't start: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500),
      );
    }
  }
}

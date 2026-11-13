import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { StreamControl } from "@agenteschat/adapters/machine-protocol";
import { RunnerError } from "../../runner/errors";
import { vncAuthResponse } from "../../runner/rfb";
import type { DataListener, DataSocket } from "../../runner/streams";

/** A fresh temp folder (real path, so macOS /var → /private/var doesn't matter). */
export function tempDir(prefix = "runner-"): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

export function removeDirs(dirs: string[]) {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

/** git is on this computer (the tests that read a repository need it). */
export const hasGit = spawnSync("git", ["--version"]).status === 0;

/**
 * A clone (`work`, at `into` or in a new folder) of a bare remote whose default branch is `develop`, so
 * nothing may assume main; `main` and the pull request's branch `cursor/pap-582-fix` are there too, and the
 * clone is on that branch, tracking it. `git` runs in the clone and returns its stdout.
 */
export function gitRepo(dirs: string[], into?: string) {
  const root = tempDir("git-");
  dirs.push(root);
  const run = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const src = path.join(root, "src");
  run(root, "init", "-q", "-b", "develop", src);
  writeFileSync(path.join(src, "README.md"), "hi\n");
  run(src, "add", ".");
  run(src, "commit", "-qm", "first");
  run(src, "branch", "main");
  run(src, "branch", "cursor/pap-582-fix");
  const remote = path.join(root, "remote.git");
  run(root, "clone", "-q", "--bare", src, remote);
  const work = into ?? path.join(root, "work");
  run(root, "clone", "-q", remote, work);
  run(work, "checkout", "-q", "-b", "cursor/pap-582-fix", "--track", "origin/cursor/pap-582-fix");
  return { root, remote, work, git: (...args: string[]) => run(work, ...args) };
}

/** The RunnerError code a promise or function fails with (or "ok"). */
export async function errorCode(fn: () => unknown): Promise<string> {
  try {
    await fn();
    return "ok";
  } catch (err) {
    return err instanceof RunnerError ? err.code : `other: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * `fn` run with this process's environment a client of an agent's containers service, as `systemLauncher` makes every
 * launch of the agent (its runtime dir, Podman's socket): what a sandboxed CLI must not get (ADR 0169).
 */
export async function withContainersClient<T>(fn: () => Promise<T>): Promise<T> {
  const socket = "unix:///run/user/21003/podman/podman.sock";
  const client = { CONTAINER_HOST: socket, DOCKER_HOST: socket, XDG_RUNTIME_DIR: "/run/user/21003" };
  const saved = Object.keys(client).map((k) => [k, process.env[k]] as const);
  Object.assign(process.env, client);
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

export async function waitFor(cond: () => boolean, timeoutMs = 3000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Everything a Unix socket answers one connection that says `word`, until it closes. */
export function socketAnswer(socket: string, word: string): Promise<string> {
  return new Promise((resolve) => {
    let got = "";
    const conn = net.createConnection(socket);
    conn.setEncoding("utf8");
    conn.on("connect", () => conn.write(word));
    conn.on("data", (chunk: string) => {
      got += chunk;
    });
    conn.on("error", () => resolve(got));
    conn.on("close", () => resolve(got));
  });
}

/**
 * A stream's data socket in memory, the person's side in the test's hands:
 * what the runner sent, how it closed, how much it "holds" queued.
 */
export function memoryDataSocket() {
  let listener: DataListener | null = null;
  const mem = {
    sent: [] as (string | Buffer)[],
    closed: null as { code?: number; reason?: string } | null,
    buffered: 0,
    socket: {
      send: (data) => {
        mem.sent.push(typeof data === "string" ? data : Buffer.from(data));
      },
      close: (code, reason) => {
        if (mem.closed) return;
        mem.closed = { code, reason };
        listener?.closed();
      },
      get bufferedAmount() {
        return mem.buffered;
      },
      listen: (on) => {
        listener = on;
      },
    } as DataSocket,
    /** Every binary frame the runner sent, joined. */
    bytes: () => Buffer.concat(mem.sent.filter((f): f is Buffer => typeof f !== "string")),
    texts: () => mem.sent.filter((f): f is string => typeof f === "string"),
    /** The person sends bytes (a string as latin1). */
    send: (data: string | Uint8Array) => listener?.bytes(typeof data === "string" ? Buffer.from(data, "latin1") : data),
    control: (frame: StreamControl) => listener?.control?.(frame),
    /** The person (or the server) closes it. */
    end: () => {
      if (mem.closed) return;
      mem.closed = {};
      listener?.closed();
    },
  };
  return mem;
}

/** The two passwords of a desktop that `fakeXvnc` takes. */
export const VNC_PASSWORDS = { full: "Full2345", view: "View2345" };

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

/** One connection to `fakeXvnc`. */
export interface VncLogin {
  socket: net.Socket;
  password: "full" | "view" | null;
  /** ClientInit's shared flag. */
  shared?: number;
  /** What came after ClientInit. */
  got: Buffer;
}

/** A viewer's message size from its first bytes (RFB 3.8); a type it doesn't know takes what came; null: too few yet. */
function clientMessageSize(b: Buffer): number | null {
  if (b.length === 0) return null;
  if (b[0] === 2) return b.length < 4 ? null : 4 + 4 * b.readUInt16BE(2);
  if (b[0] === 6) return b.length < 8 ? null : 8 + b.readUInt32BE(4);
  return ({ 0: 20, 3: 10, 4: 8, 5: 6 } as Record<number, number>)[b[0] as number] ?? b.length;
}

/**
 * An Xvnc on a Unix socket in `dir`: RFB 3.8, VncAuth with `VNC_PASSWORDS`,
 * then a ServerInit of 1280×800 "Dev". A PointerEvent moves the desktop's
 * pointer only from a full login, as Xvnc does.
 */
export async function fakeXvnc(dir: string) {
  const socketPath = path.join(dir, "vnc.sock");
  const logins: VncLogin[] = [];
  const desktop = { pointer: [640, 400] as [number, number] };
  const server = net.createServer((socket) => {
    const login: VncLogin = { socket, password: null, got: Buffer.alloc(0) };
    logins.push(login);
    const challenge = randomBytes(16);
    let buf = Buffer.alloc(0);
    let step: "version" | "type" | "auth" | "init" | "messages" = "version";
    const take = (n: number) => {
      if (buf.length < n) return null;
      const out = buf.subarray(0, n);
      buf = buf.subarray(n);
      return out;
    };
    socket.on("error", () => undefined);
    socket.write("RFB 003.008\n");
    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (step === "version") {
          if (!take(12)) return;
          socket.write(Uint8Array.of(1, 2));
          step = "type";
        } else if (step === "type") {
          if (!take(1)) return;
          socket.write(challenge);
          step = "auth";
        } else if (step === "auth") {
          const answer = take(16);
          if (!answer) return;
          const is = (password: string) => answer.equals(vncAuthResponse(password, challenge));
          login.password = is(VNC_PASSWORDS.full) ? "full" : is(VNC_PASSWORDS.view) ? "view" : null;
          if (!login.password) return void socket.end(Buffer.concat([u32(1), u32(12), Buffer.from("bad password")]));
          socket.write(u32(0));
          step = "init";
        } else if (step === "init") {
          const init = take(1);
          if (!init) return;
          login.shared = init[0];
          const pixelFormat = Buffer.alloc(16);
          socket.write(Buffer.concat([Buffer.from([5, 0, 3, 32]), pixelFormat, u32(3), Buffer.from("Dev")]));
          step = "messages";
        } else {
          const size = clientMessageSize(buf);
          if (size === null || buf.length < size) return;
          const message = take(size) as Buffer;
          login.got = Buffer.concat([login.got, message]);
          if (message[0] === 5 && login.password === "full") {
            desktop.pointer = [message.readUInt16BE(2), message.readUInt16BE(4)];
          }
          // A FramebufferUpdateRequest: an update of no rectangles.
          if (message[0] === 3) socket.write(Uint8Array.of(0, 0, 0, 0));
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const close = () => {
    for (const l of logins) l.socket.destroy();
    server.close();
  };
  return { socketPath, logins, desktop, close };
}

/**
 * An agent's desktop as `openDesktopStream` sees it: running on that socket (or not yet: `state.running`, which
 * `ensure` sets, recording who it started for), counting its viewers.
 */
export function desktopOn(socketPath: string, over: { running?: boolean } = {}) {
  const holds = { taken: 0, released: 0 };
  const state = { running: over.running ?? true, started: [] as string[] };
  const desktops = {
    status: () => ({ running: state.running, streams: holds.taken - holds.released }),
    ensure: async (agent: { handle: string }) => {
      if (!state.running) state.started.push(agent.handle);
      state.running = true;
      return { display: 20, width: 1280, height: 900, startedAt: "2026-10-24T10:00:00.000Z", started: true };
    },
    session: () => ({ display: 20, socket: socketPath, xauthority: "", home: "", passwords: VNC_PASSWORDS }),
    hold: () => {
      holds.taken++;
      let held = true;
      return () => {
        if (held) holds.released++;
        held = false;
      };
    },
  };
  return { desktops, holds, state };
}

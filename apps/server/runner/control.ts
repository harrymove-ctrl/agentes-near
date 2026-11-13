import { createInterface } from "node:readline";
import { MACHINE_PROTOCOL_VERSION } from "@agenteschat/adapters/machine-protocol";
import {
  CONTROL_MAX_LINE,
  CONTROL_PROTOCOL_VERSION,
  type ControlErrorCode,
  type ControlIn,
  type ControlOut,
  parseControlIn,
} from "@agenteschat/adapters/runner-control";
import { ControlError } from "./access";
import { type DaemonOptions, RunnerDaemon } from "./daemon";
import { RUNNER_VERSION, RunnerError } from "./errors";
import { type LockInfo, lockedMessage } from "./lock";

/**
 * `agentes-runner app` (ADR 0036 §3): the runner as the desktop app's child.
 * stdin carries one request per line, stdout one reply or event per line,
 * `hello` first (`packages/adapters/src/runner-control.ts`). Nothing else
 * goes to stdout in this mode; logs go to `<home>/logs/runner.log`. When
 * stdin closes (the app quit or died) the runner stops; background tasks go on.
 */

/** Exit code when another runner already holds this home's lock. */
export const EXIT_LOCKED = 4;
/** How long a locked runner keeps answering (so the app reads why) before it exits. */
const LOCKED_LINGER_MS = 5000;

function toControlError(err: unknown): { code: ControlErrorCode; message: string } {
  if (err instanceof ControlError) return { code: err.code, message: err.message };
  if (err instanceof RunnerError) {
    const code: ControlErrorCode =
      err.code === "bad_request" || err.code === "not_found"
        ? err.code
        : err.code === "outside_workspace"
          ? "invalid_path"
          : "internal";
    return { code, message: err.message };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: "internal", message: message.slice(0, 2000) || "Unexpected error" };
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Answers the app's requests with the daemon. */
export class ControlServer {
  constructor(
    private readonly daemon: RunnerDaemon,
    private readonly write: (out: ControlOut) => void,
    private readonly onShutdown: () => void,
  ) {}

  async handle(msg: ControlIn): Promise<void> {
    try {
      const data = await this.dispatch(msg);
      this.write({ type: "reply", id: msg.id, ok: true, data });
    } catch (err) {
      this.write({ type: "reply", id: msg.id, ok: false, error: toControlError(err) });
    }
    if (msg.type === "shutdown") this.onShutdown();
  }

  private async dispatch(m: ControlIn): Promise<unknown> {
    const d = this.daemon;
    switch (m.type) {
      case "status":
        return d.status();
      case "jobs":
        return { jobs: d.jobList() };
      case "pause":
        return { paused: d.pause(m.until ?? null) };
      case "resume":
        return { paused: d.resume() };
      case "activity":
        return d.activity.page({
          ...(typeof m.before === "string" ? { before: m.before } : {}),
          ...(typeof m.limit === "number" ? { limit: m.limit } : {}),
          ...(typeof m.agentId === "string" && m.agentId ? { agentId: m.agentId } : {}),
        });
      case "config.get":
        return d.configGet();
      case "config.set":
        return d.configSet(m.patch);
      case "pair.start":
        return d.pairStart(
          str(m.server),
          typeof m.name === "string" ? m.name : undefined,
          m.tools,
          // A link that isn't a string is refused, never dropped: without it the pairing waits for a confirm instead.
          m.link === undefined ? undefined : str(m.link),
        );
      case "pair.cancel":
        return d.pairCancel();
      case "unpair":
        return d.unpair();
      case "org.logo":
        return d.orgLogo();
      case "diagnostics":
        return { text: d.diagnostics() };
      case "access.get":
        return d.access();
      case "folders.add":
        return d.foldersAdd(str(m.path), m.agents);
      case "folders.remove":
        return d.foldersRemove(str(m.path), typeof m.agentId === "string" ? m.agentId : undefined);
      case "folders.setAgents":
        return d.foldersSetAgents(str(m.path), m.agents);
      case "tools.set":
        return d.toolsSet(m.tool, m.on);
      case "executors.check":
        return d.executorsCheck();
      case "access.pending":
        return { requests: d.accessPending() };
      case "access.answer":
        return d.accessAnswer(str(m.requestId), m.decision, m.scope === "all" ? "all" : "agent");
      case "reconnect":
        return d.reconnect();
      case "browser.stop":
        return d.browserStop(str(m.agentId));
      case "accounts.list":
        return d.accountsList();
      case "account.begin":
        return d.accountBegin(m.kind);
      case "account.status":
        return d.accountStatus(str(m.loginId));
      case "account.cancel":
        return d.accountCancel(str(m.loginId));
      case "account.remove":
        return d.accountRemove(m.kind, str(m.accountId));
      case "iphone.setup":
        return d.iphoneSetup().check();
      case "iphone.download":
        return d.iphoneSetup().start();
      case "iphone.open":
        return d.iphoneSetup().open(m.app === "xcode" ? "xcode" : "appStore");
      case "shutdown":
        return { stopping: true };
      default:
        throw new ControlError("bad_request", `Unknown request ${String((m as { type: unknown }).type).slice(0, 60)}`);
    }
  }
}

export interface RunControlOptions {
  home: string;
  input: NodeJS.ReadableStream;
  output: { write(chunk: string, cb?: (err?: Error | null) => void): unknown };
  /** The daemon's options (mode and events are set here). */
  daemon: Omit<DaemonOptions, "home" | "mode" | "onEvent">;
  /** Another runner holds this home's lock: say so to every request, then exit `EXIT_LOCKED`. */
  locked?: LockInfo | null;
  /** Aborted on SIGTERM/SIGINT: same as stdin closing. */
  signal?: AbortSignal;
}

/** Runs the control protocol until stdin closes or the app asks to shut down. Returns the exit code. */
export async function runControl(opts: RunControlOptions): Promise<number> {
  const write = (out: ControlOut) => {
    try {
      opts.output.write(`${JSON.stringify(out)}\n`);
    } catch {
      // the app is gone; stdin closing ends us
    }
  };
  const flush = () =>
    new Promise<void>((resolve) => {
      try {
        opts.output.write("", () => resolve());
      } catch {
        resolve();
      }
      setTimeout(resolve, 500).unref?.();
    });
  write({
    type: "hello",
    control: CONTROL_PROTOCOL_VERSION,
    version: RUNNER_VERSION,
    protocol: MACHINE_PROTOCOL_VERSION,
    home: opts.home,
  });
  const rl = createInterface({ input: opts.input, crlfDelay: Number.POSITIVE_INFINITY });

  if (opts.locked) {
    const message = lockedMessage(opts.home, opts.locked);
    opts.daemon.log(message);
    const timer = setTimeout(() => rl.close(), LOCKED_LINGER_MS);
    for await (const line of rl) {
      const msg = parseControlIn(line);
      if (msg) write({ type: "reply", id: msg.id, ok: false, error: { code: "internal", message } });
    }
    clearTimeout(timer);
    await flush();
    return EXIT_LOCKED;
  }

  let stopping: Promise<void> | null = null;
  const daemon = new RunnerDaemon({
    ...opts.daemon,
    home: opts.home,
    mode: "app",
    onEvent: (event) => {
      if (!stopping) write({ type: "event", event });
    },
  });
  const stop = (graceful: boolean) => {
    if (!stopping) stopping = graceful ? daemon.shutdown() : daemon.stop();
    rl.close();
    return stopping;
  };
  const server = new ControlServer(daemon, write, () => {
    void stop(true);
  });
  opts.signal?.addEventListener("abort", () => void stop(true), { once: true });
  daemon.start();
  const inflight = new Set<Promise<void>>();
  for await (const line of rl) {
    if (stopping) break;
    if (!line.trim()) continue;
    if (line.length > CONTROL_MAX_LINE) {
      opts.daemon.log("control: a line too long was ignored");
      continue;
    }
    const msg = parseControlIn(line);
    if (!msg) {
      opts.daemon.log(`control: ignored a line that isn't a request (${line.slice(0, 80)})`);
      continue;
    }
    const p = server.handle(msg).finally(() => inflight.delete(p));
    inflight.add(p);
  }
  // stdin closed (the app quit or died) or the app asked to shut down.
  await Promise.all(inflight);
  await stop(false);
  await flush();
  return 0;
}

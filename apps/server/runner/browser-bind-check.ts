import type { EventEmitter } from "node:events";
import { statSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";

/**
 * `agentes-runner bind-check`: run as the agent, in its slice, before each of its workers starts, so the kernel
 * itself shows its isolation holds on this computer: its bind policy, that it reaches its own listeners on any
 * port (bind(0) included), and that root's listeners refuse it. Then it prints its /tmp, for root to check it is
 * the agent's own.
 */
export interface BindCheck {
  /** Ports of other agents' pairs at each end of the band: binding them must be refused. */
  forbidden: [first: number, last: number];
  /** The agent's own pair (0: already listening, skipped), a port below the band and one above it: they must bind. */
  allowed: [cdp: number, stream: number, below: number, above: number];
  /** The browser pairs of the computer's uid range: bind(0) must land outside them. */
  band: [number, number];
  /** Root's listeners on 127.0.0.1 and ::1, which must refuse the agent. */
  decoys: [number, number];
}

/**
 * The probe's exit code when a bind came out other than the slice's policy says: the kernel still enforces an
 * older policy there (`ensureBrowserBindPolicy`).
 */
export const POLICY_NOT_IN_FORCE_EXIT = 3;

/** A bind the slice's policy would have decided otherwise. */
export class PolicyNotInForce extends Error {}

const isPort = (n: number, min = 1) => Number.isInteger(n) && n >= min && n <= 65_535;

/** The probe's command-line words. */
export const bindCheckArgs = (c: BindCheck) => [
  ...c.forbidden.map(String),
  ...c.allowed.map(String),
  `${c.band[0]}-${c.band[1]}`,
  ...c.decoys.map(String),
];

/** The probe's words back into a check; null when they aren't one. */
export function parseBindCheck(args: string[]): BindCheck | null {
  if (args.length !== 9) return null;
  const [first, last, cdp, stream, below, above, band = "", v4, v6] = args;
  const [bandFirst, bandLast] = band.split("-").map(Number);
  const c: BindCheck = {
    forbidden: [Number(first), Number(last)],
    allowed: [Number(cdp), Number(stream), Number(below), Number(above)],
    band: [Number(bandFirst), Number(bandLast)],
    decoys: [Number(v4), Number(v6)],
  };
  const ok =
    c.forbidden.every((p) => isPort(p)) &&
    c.allowed.every((p) => isPort(p, 0)) &&
    c.band.every((p) => isPort(p)) &&
    c.band[0] <= c.band[1] &&
    c.decoys.every((p) => isPort(p));
  return ok ? c : null;
}

/** What the probe does to the kernel (tests: fakes). */
export interface BindProbes {
  /** `bound` with the port the kernel gave, or the errno's name. */
  bind(host: string, port: number): Promise<{ result: string; port?: number }>;
  /** Listens on `host:0` and connects to it: `connected`, `timeout` or the errno's name. */
  ownConnect(host: string, ms: number): Promise<string>;
  /** Connects to `host:port`: `connected`, `timeout` or the errno's name. */
  connect(host: string, port: number, ms: number): Promise<string>;
  /** `<device>:<inode>` of /tmp as this process sees it. */
  tmp(): string;
  sleep(ms: number): Promise<void>;
  now(): number;
}

const errorName = (error: NodeJS.ErrnoException) => error.code ?? "error";

function listen(host: string, port: number): Promise<{ server: Server; port: number } | { error: string }> {
  return new Promise((resolve) => {
    const server = createServer((socket) => socket.destroy());
    (server as unknown as EventEmitter).once("error", (error: NodeJS.ErrnoException) =>
      resolve({ error: errorName(error) }),
    );
    server.listen({ host, port, exclusive: true }, () => {
      const address = server.address();
      resolve({ server, port: typeof address === "object" && address ? address.port : 0 });
    });
  });
}

function connectTo(host: string, port: number, ms: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (result: string) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => done("timeout"), ms);
    socket.once("connect", () => done("connected"));
    socket.once("error", (error: NodeJS.ErrnoException) => done(errorName(error)));
  });
}

export const kernelProbes: BindProbes = {
  async bind(host, port) {
    const r = await listen(host, port);
    if ("error" in r) return { result: r.error };
    await new Promise((resolve) => r.server.close(resolve));
    return { result: "bound", port: r.port };
  },
  async ownConnect(host, ms) {
    const r = await listen(host, 0);
    if ("error" in r) return r.error;
    try {
      return await connectTo(host, r.port, ms);
    } finally {
      r.server.close();
    }
  },
  connect: connectTo,
  tmp() {
    const st = statSync("/tmp", { bigint: true });
    return `${st.dev}:${st.ino}`;
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: Date.now,
};

/** The guard on a computer that hosts several organizations maps a new slice at its next scan (2 s). */
const OWN_MS = 5000;
/** A refusal in drop mode is a connection that never comes. */
const DECOY_MS = 2000;

const refused = (result: string) => result === "EPERM" || result === "EACCES";

/**
 * The checks, on 127.0.0.1 and ::1; throws on the first that fails, `PolicyNotInForce` when a bind came out other
 * than the policy says (a refusal for a taken port is no proof either way). Returns this process's /tmp.
 */
export async function verifyBrowserBindPolicy(c: BindCheck, probes: BindProbes = kernelProbes): Promise<string> {
  for (const host of ["127.0.0.1", "::1"]) {
    for (const port of c.forbidden) {
      const { result } = await probes.bind(host, port);
      if (refused(result)) continue;
      const message = `Browser bind isolation failed for ${host}:${port}: ${result}`;
      throw result === "bound" ? new PolicyNotInForce(message) : new Error(message);
    }
    for (const port of c.allowed) {
      if (port === 0) continue; // An already-running browser owns this port.
      const { result } = await probes.bind(host, port);
      if (result === "bound") continue;
      const message = `Browser bind allow failed for ${host}:${port}: ${result}`;
      throw refused(result) ? new PolicyNotInForce(message) : new Error(message);
    }
    const any = await probes.bind(host, 0);
    if (any.result !== "bound" || any.port === undefined) {
      const message = `An agent's bind(0) failed on ${host}: ${any.result}`;
      throw refused(any.result) ? new PolicyNotInForce(message) : new Error(message);
    }
    if (any.port >= c.band[0] && any.port <= c.band[1]) {
      throw new Error(`bind(0) gave ${host}:${any.port}, a reserved browser port`);
    }
    const deadline = probes.now() + OWN_MS;
    let own = await probes.ownConnect(host, 1000);
    while (own !== "connected" && probes.now() < deadline) {
      await probes.sleep(100);
      own = await probes.ownConnect(host, 1000);
    }
    if (own !== "connected") throw new Error(`An agent can't reach its own listener on ${host}: ${own}`);
    const decoy = c.decoys[host === "::1" ? 1 : 0];
    if ((await probes.connect(host, decoy, DECOY_MS)) === "connected") {
      throw new Error(`An agent reached root's listener on ${host}:${decoy}: the loopback guard isn't holding`);
    }
  }
  return probes.tmp();
}

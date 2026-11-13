import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { type AgentUser, networkPrefix, systemLauncher } from "./agent-users";
import { bindCheckArgs, POLICY_NOT_IN_FORCE_EXIT, PolicyNotInForce } from "./browser-bind-check";
import { browserBand, browserPortsForUid, checkEphemeralRange, EPHEMERAL_RANGE_FILE } from "./browser-ports";
import { agentSlice, agentTmp, type RunCommand, systemdBooted } from "./service";

/**
 * A systemd unit property or a loaded table is only a claim until a process in the slice proves what the kernel
 * does. The probe waits up to 5 s for its own listener and 2 s on each of root's when refusals are drops.
 */
const runBounded: RunCommand = (file, args) => {
  const result = spawnSync(file, args, { encoding: "utf8", timeout: 30_000 });
  if (result.error) return { code: 127, output: result.error.message };
  return { code: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
};

/** A listener on an assigned browser port must belong to that port's agent (`ss -Htln -e` output). */
export function conflictingBrowserPorts(ssOutput: string, uidRange: [number, number]): number[] {
  const [first, last] = browserBand(uidRange);
  const conflicts = new Set<number>();
  const bucket = Math.floor(uidRange[0] / 10_000) * 10_000;
  for (const line of ssOutput.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] !== "LISTEN" || !cols[3]) continue;
    const port = Number(cols[3].slice(cols[3].lastIndexOf(":") + 1));
    if (!Number.isInteger(port) || port < first || port > last) continue;
    const owner = bucket + Math.floor((port - 10_000) / 2);
    const actual = Number(/\buid:(\d+)\b/.exec(line)?.[1] ?? 0);
    if (actual !== owner) conflicts.add(port);
  }
  return [...conflicts].sort((a, b) => a - b);
}

/** Root's own listeners on 127.0.0.1 and ::1, for the probe to be refused by. */
export interface Decoys {
  ports: [number, number];
  close(): void;
}

/**
 * Bound before `Bun.listen` returns. While root waits on the probe its event loop is blocked, but the kernel still
 * completes handshakes into the backlog: a rule that let the agent in shows as a completed connect.
 */
export function rootDecoys(): Decoys {
  if (typeof Bun === "undefined") throw new Error("System mode runs the runner on Bun");
  const open = (hostname: string) => Bun.listen({ hostname, port: 0, socket: { data() {} } });
  const v4 = open("127.0.0.1");
  try {
    const v6 = open("::1");
    return {
      ports: [v4.port, v6.port],
      close: () => {
        v4.stop(true);
        v6.stop(true);
      },
    };
  } catch (err) {
    v4.stop(true);
    throw err;
  }
}

export interface BindPolicyOptions {
  /** The computer's agent uid range: its browser pairs are the band no agent binds in but on its own pair. */
  uidRange: [number, number];
  /** Root's loopback guard (`LoopbackGuard.reconcile`): maps the slice systemd just made before the probe. */
  refresh?: () => void;
  run?: RunCommand;
  /** Tests: the computer. */
  systemd?: boolean;
  ephemeralRange?: () => string;
  decoys?: () => Decoys;
  /** `<device>:<inode>` of a folder, or null. */
  folderId?: (dir: string) => string | null;
}

const folderId = (dir: string) => {
  try {
    const st = statSync(dir, { bigint: true });
    return `${st.dev}:${st.ino}`;
  } catch {
    return null;
  }
};

/** Without it systemd ignores `SocketBindAllow=`/`SocketBindDeny=`, and an agent could bind any browser port. */
const BPF_FRAMEWORK = /\+BPF_FRAMEWORK\b/;

/**
 * The agent's slice and its policy, before any of its processes starts: only the band is denied, its own pair
 * excepted. bind(0) matches no rule with ports, so it binds (outside the band, by the ephemeral range).
 */
export function applyBindPolicy(user: AgentUser, opts: BindPolicyOptions) {
  const run = opts.run ?? runBounded;
  const band = browserBand(opts.uidRange);
  const { cdp, stream } = browserPortsForUid(user.uid);
  const slice = agentSlice(user.uid);
  // A newly allocated agent has no active slice yet. Start the empty slice as
  // root so set-property has a loaded unit to update before any worker enters.
  const started = run("systemctl", ["start", slice]);
  if (started.code !== 0) {
    throw new Error(`Cannot start ${slice} for browser bind policy: ${started.output.slice(0, 200)}`);
  }
  // A slice made now is a new cgroup: mapped at once, so the agent's connections are its own from the probe on.
  opts.refresh?.();
  // Clearing and replacing the lists in one call avoids duplicates on restarts.
  const configured = run("systemctl", [
    "set-property",
    "--runtime",
    slice,
    "SocketBindAllow=",
    `SocketBindAllow=tcp:${cdp}-${stream}`,
    "SocketBindDeny=",
    `SocketBindDeny=tcp:${band[0]}-${band[1]}`,
  ]);
  if (configured.code !== 0) {
    throw new Error(`Cannot set ${slice} browser bind policy: ${configured.output.slice(0, 200)}`);
  }
}

/**
 * Must run as root before this agent's worker can start or restart: the bind policy on its slice, then a probe in
 * it (`bind-check`, launched as every agent process is) that proves on this kernel what the agent may bind and
 * reach, and that its /tmp is its own. `PolicyNotInForce` when the kernel still enforces another policy there.
 */
export function ensureBrowserBindPolicy(user: AgentUser, runner: string[], opts: BindPolicyOptions) {
  if (!(opts.systemd ?? systemdBooted())) {
    throw new Error("System agent browsers require systemd cgroup socket-bind enforcement");
  }
  const run = opts.run ?? runBounded;
  if (!BPF_FRAMEWORK.test(run("systemctl", ["--version"]).output)) {
    throw new Error(
      "System mode needs systemd built with BPF_FRAMEWORK (systemctl --version shows +BPF_FRAMEWORK, as on Debian 13; Ubuntu's isn't): without it an agent could bind another agent's browser ports",
    );
  }
  const band = browserBand(opts.uidRange);
  // Read again each time: bind(0) must never land in the band, which the bind policy can't see.
  checkEphemeralRange((opts.ephemeralRange ?? (() => readFileSync(EPHEMERAL_RANGE_FILE, "utf8")))(), band);
  const { cdp, stream } = browserPortsForUid(user.uid);
  const slice = agentSlice(user.uid);
  applyBindPolicy(user, opts);
  // Pick currently unused ports. EADDRINUSE is not proof of
  // enforcement, and the child only succeeds for EPERM/EACCES on IPv4+6.
  const network = networkPrefix(user);
  const socketsInNetwork = () =>
    network.length
      ? run(network[0] as string, [...network.slice(1), "/usr/bin/ss", "-Htln", "-e"])
      : run("ss", ["-Htln", "-e"]);
  const sockets = socketsInNetwork();
  if (sockets.code !== 0) throw new Error(`Cannot inspect browser bind test ports: ${sockets.output.slice(0, 200)}`);
  const wrongOwner = conflictingBrowserPorts(sockets.output, [user.uid, user.uid]);
  if (wrongOwner.length)
    throw new Error(`Agent ${user.uid}'s browser ports have the wrong listener owner: ${wrongOwner.join(", ")}`);
  const occupied = new Set<number>();
  for (const line of sockets.output.split("\n")) {
    const local = line.trim().split(/\s+/)[3];
    if (line.trim().startsWith("LISTEN") && local) {
      const port = Number(local.slice(local.lastIndexOf(":") + 1));
      if (Number.isInteger(port)) occupied.add(port);
    }
  }
  // Another agent's port at each end of the band, and one on each side of it: a policy left from before a change
  // of the band (wider, narrower, or the earlier runner's deny of every port) gets one of them wrong.
  const freeOther = (port: number) => port !== cdp && port !== stream && !occupied.has(port);
  let first = band[0];
  while (first <= band[1] && !freeOther(first)) first++;
  let last = band[1];
  while (last >= band[0] && !freeOther(last)) last--;
  if (first > band[1]) throw new Error("No free reserved port for browser bind policy self-check");
  let below = 3000;
  while (below < band[0] && occupied.has(below)) below++;
  if (below >= band[0]) throw new Error("No free development port for browser bind policy self-check");
  let above = band[1] + 1;
  while (above <= 65_535 && occupied.has(above)) above++;
  if (above > 65_535) throw new Error("No free port above the band for browser bind policy self-check");
  // As every agent process starts: its slice, its private temporary folders, its user.
  const [launch = "", ...prefix] = systemLauncher(user, true).prefix;
  const decoys = (opts.decoys ?? rootDecoys)();
  let verified: ReturnType<RunCommand>;
  try {
    verified = run(launch, [
      ...prefix,
      ...runner,
      "bind-check",
      ...bindCheckArgs({
        forbidden: [first, last],
        allowed: [occupied.has(cdp) ? 0 : cdp, occupied.has(stream) ? 0 : stream, below, above],
        band,
        decoys: decoys.ports,
      }),
    ]);
  } finally {
    decoys.close();
  }
  if (verified.code === POLICY_NOT_IN_FORCE_EXIT) {
    throw new PolicyNotInForce(
      `Agent ${user.uid}'s isolation doesn't hold in ${slice}: ${verified.output.slice(0, 300)} (systemd still enforces an earlier bind policy there, until systemctl daemon-reexec or a restart)`,
    );
  }
  if (verified.code !== 0) {
    throw new Error(`Agent ${user.uid}'s isolation doesn't hold in ${slice}: ${verified.output.slice(0, 300)}`);
  }
  const seen = /^tmp (\d+:\d+)$/m.exec(verified.output)?.[1];
  const own = (opts.folderId ?? folderId)(agentTmp(user.uid));
  if (!seen || seen !== own) {
    throw new Error(`Agent ${user.uid}'s /tmp isn't its own (${seen ?? "not said"}, its folder ${own ?? "missing"})`);
  }
  const finalSockets = socketsInNetwork();
  if (finalSockets.code !== 0)
    throw new Error(`Cannot recheck browser listener owners: ${finalSockets.output.slice(0, 200)}`);
  const finalWrongOwner = conflictingBrowserPorts(finalSockets.output, [user.uid, user.uid]);
  if (finalWrongOwner.length) {
    throw new Error(`Agent ${user.uid}'s browser ports have the wrong listener owner: ${finalWrongOwner.join(", ")}`);
  }
}

/**
 * At the runner's start, the listed agents: every policy first, then each agent's `prepare` (its
 * `ensureBrowserBindPolicy`). An agent that fails is logged and left out, and the others serve; its processes stay
 * refused, since each of them proves its isolation again before it starts.
 *
 * systemd up to v258 neither re-attaches an active slice's bind programs when its policy changes nor detaches the
 * ones it replaces when it realizes the slice again (fixed upstream after v258): a slice with processes keeps the
 * earlier policy, and copies of it, all enforced. Re-executing systemd closes the copies (on exec) and attaches each
 * slice's program anew from its policy, stopping nothing; a reload keeps the copies. With every policy set first,
 * the agents whose probe found an older one share one re-execution.
 *
 * Setting the policy (`systemctl set-property` on the slice) also applies the rest of the slice's drop-ins to it,
 * which neither a reload nor a re-execution does for a running slice (systemd 257, checked 2026-11-02): so an agent
 * already running gets new limits (`agentLimits`) here, as the runner starts.
 */
export function prepareAgents(
  users: AgentUser[],
  prepare: (user: AgentUser) => void,
  opts: BindPolicyOptions,
  log: (line: string) => void,
) {
  const failed = (user: AgentUser, err: unknown) =>
    log(`couldn't prepare ${user.user}: ${err instanceof Error ? err.message : String(err)}`);
  const applied = users.filter((user) => {
    try {
      applyBindPolicy(user, opts);
      return true;
    } catch (err) {
      failed(user, err);
      return false;
    }
  });
  const stale = applied.filter((user) => {
    try {
      prepare(user);
    } catch (err) {
      if (err instanceof PolicyNotInForce) return true;
      failed(user, err);
    }
    return false;
  });
  if (!stale.length) return;
  log(`systemd still enforces an earlier bind policy for ${stale.map((u) => u.user).join(", ")}: re-executing it`);
  const reexec = (opts.run ?? runBounded)("systemctl", ["daemon-reexec"]);
  if (reexec.code !== 0) log(`systemctl daemon-reexec failed: ${reexec.output.slice(0, 200)}`);
  for (const user of stale) {
    try {
      prepare(user);
    } catch (err) {
      failed(user, err);
    }
  }
}

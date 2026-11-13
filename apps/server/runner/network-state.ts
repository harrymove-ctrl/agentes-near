import { lstatSync, readdirSync, readFileSync, readlinkSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface NetworkConfig {
  networkLauncher?: string;
  networkMark?: number;
  networkRevision?: number;
}
export const networkConfig = (value: NetworkConfig): NetworkConfig => ({
  ...(value.networkLauncher ? { networkLauncher: value.networkLauncher } : {}),
  ...(value.networkMark ? { networkMark: value.networkMark } : {}),
  ...(value.networkRevision ? { networkRevision: value.networkRevision } : {}),
});
export const networkKey = (value: NetworkConfig) =>
  JSON.stringify([value.networkLauncher ?? null, value.networkMark ?? null, value.networkRevision ?? 0]);
export const NETWORK_STATE_FILE = "network-state.json";
export const NETWORK_STATE_MAX_BYTES = 4 * 1024 * 1024;
export interface NetworkState {
  version: 1;
  pid: number;
  startTicks: string;
  updatedAt: string;
  networkLauncher: string | null;
  networkMark: number | null;
  networkRevision: number;
  pendingUids: number[];
  uidNetworks: UidNetwork[];
  transitions: NetworkTransition[];
}
export interface UidNetwork extends NetworkConfig {
  uid: number;
}

export interface NetworkTransition {
  uid: number;
  agentId: string;
  target: string;
  startedAt: string;
  deadline: string;
  state: "draining" | "restart_required";
}

/** A root-chosen finite drain; repeating the same policy or restarting cannot extend its deadline. */
export class NetworkDrain {
  private entries = new Map<number, NetworkTransition>();
  constructor(saved: NetworkTransition[] = []) {
    for (const item of saved) this.entries.set(item.uid, item);
  }
  update(pending: { uid: number; agentId: string }[], target: string, seconds: number | undefined, now: number) {
    const active = new Set(pending.map((p) => p.uid));
    for (const [uid, item] of this.entries) {
      if (!seconds || !active.has(uid) || item.target !== target) this.entries.delete(uid);
    }
    if (seconds)
      for (const item of pending) {
        const old = this.entries.get(item.uid);
        const next = old ?? {
          ...item,
          target,
          startedAt: new Date(now).toISOString(),
          deadline: new Date(now + seconds * 1000).toISOString(),
          state: "draining" as const,
        };
        if (now >= Date.parse(next.deadline)) next.state = "restart_required";
        this.entries.set(item.uid, next);
      }
    return this.snapshot();
  }
  snapshot() {
    return [...this.entries.values()].sort((a, b) => a.uid - b.uid);
  }
}

/** Root-written deadlines outlive the daemon just like its UID network pins. */
export function readNetworkTransitions(home: string): NetworkTransition[] {
  if (process.platform !== "linux" || process.getuid?.() !== 0) return [];
  try {
    trustedDirectory(home);
    const file = path.join(home, NETWORK_STATE_FILE);
    const st = lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.uid !== 0 || st.mode & 0o077 || st.size > NETWORK_STATE_MAX_BYTES)
      return [];
    const state = JSON.parse(readFileSync(file, "utf8"));
    return state.version === 1 && Array.isArray(state.transitions)
      ? state.transitions.filter(
          (r: NetworkTransition) =>
            r &&
            Number.isSafeInteger(r.uid) &&
            r.uid > 0 &&
            typeof r.agentId === "string" &&
            typeof r.target === "string" &&
            Number.isFinite(Date.parse(r.startedAt)) &&
            Number.isFinite(Date.parse(r.deadline)) &&
            (r.state === "draining" || r.state === "restart_required"),
        )
      : [];
  } catch {
    return [];
  }
}

/** Pins all launches for one UID until its worker, desktop and terminals have drained. */
export class AgentNetworks {
  private readonly pins = new Map<number, NetworkConfig>();
  constructor(
    private current: NetworkConfig,
    saved: UidNetwork[] = [],
  ) {
    this.current = networkConfig(current);
    for (const row of saved) this.pins.set(row.uid, networkConfig(row));
  }
  set(value: NetworkConfig) {
    this.current = networkConfig(value);
  }
  resolve(uid: number, held: boolean): NetworkConfig {
    const old = this.pins.get(uid);
    const next = old && held ? old : this.current;
    this.pins.set(uid, next);
    return next;
  }
  seed(uid: number, value: NetworkConfig) {
    if (!this.pins.has(uid)) this.pins.set(uid, networkConfig(value));
  }
  has(uid: number) {
    return this.pins.has(uid);
  }
  snapshot(): UidNetwork[] {
    return [...this.pins].map(([uid, value]) => ({ uid, ...value }));
  }
  pending(held: (uid: number) => boolean): number[] {
    const pending: number[] = [];
    for (const [uid, value] of this.pins) {
      if (!held(uid)) this.pins.delete(uid);
      else if (networkKey(value) !== networkKey(this.current)) pending.push(uid);
    }
    return pending;
  }
}

function trustedDirectory(home: string) {
  let dir = path.resolve(home);
  for (;;) {
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== 0 || st.mode & 0o022)
      throw new Error("Unsafe runner network state directory");
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

/** Previous root-written pins are useful after a restart; they do not prove any process's namespace. */
export function readNetworkPins(home: string): UidNetwork[] {
  if (process.platform !== "linux" || process.getuid?.() !== 0) return [];
  try {
    trustedDirectory(home);
    const file = path.join(home, NETWORK_STATE_FILE);
    const st = lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.uid !== 0 || st.mode & 0o077 || st.size > NETWORK_STATE_MAX_BYTES)
      return [];
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (data.version !== 1 || !Array.isArray(data.uidNetworks)) return [];
    return data.uidNetworks.filter(
      (row: UidNetwork) =>
        row &&
        Number.isSafeInteger(row.uid) &&
        row.uid > 0 &&
        (row.networkLauncher === undefined ||
          (typeof row.networkLauncher === "string" && path.isAbsolute(row.networkLauncher))) &&
        (row.networkMark === undefined ||
          (Number.isSafeInteger(row.networkMark) && row.networkMark > 0 && row.networkMark <= 0xffffffff)) &&
        (row.networkRevision === undefined || (Number.isSafeInteger(row.networkRevision) && row.networkRevision >= 0)),
    );
  } catch {
    return [];
  }
}

/** Legacy desktops started before runtime pins existed can be adopted only in the runner's own namespace. */
export function desktopUsesHostNetwork(pid: number): boolean {
  try {
    return readlinkSync(`/proc/${pid}/ns/net`) === readlinkSync(`/proc/${process.pid}/ns/net`);
  } catch {
    return false;
  }
}

/** /proc's 22nd field, independent of spaces and parentheses in the process name. */
export function processStartTicks(stat: string): string | null {
  const end = stat.lastIndexOf(")");
  const ticks =
    end >= 0
      ? stat
          .slice(end + 1)
          .trim()
          .split(/\s+/)[19]
      : undefined;
  return ticks && /^\d+$/.test(ticks) ? ticks : null;
}
/** A privileged service observation, never a credential or proof that other processes moved namespaces. */
export function writeNetworkState(
  home: string,
  network: NetworkConfig,
  pendingUids: number[],
  uidNetworks: UidNetwork[] = [],
  transitions: NetworkTransition[] = [],
): NetworkState | null {
  if (process.platform !== "linux" || process.getuid?.() !== 0) return null;
  trustedDirectory(home);
  const startTicks = processStartTicks(readFileSync(`/proc/${process.pid}/stat`, "utf8"));
  if (!startTicks) throw new Error("Cannot identify runner network state process");
  const state: NetworkState = {
    version: 1,
    pid: process.pid,
    startTicks,
    updatedAt: new Date().toISOString(),
    networkLauncher: network.networkLauncher ?? null,
    networkMark: network.networkMark ?? null,
    networkRevision: network.networkRevision ?? 0,
    pendingUids: [...new Set(pendingUids)].sort((a, b) => a - b),
    uidNetworks,
    transitions,
  };
  const body = JSON.stringify(state);
  if (Buffer.byteLength(body) > NETWORK_STATE_MAX_BYTES) throw new Error("Too many active network contexts");
  const dest = path.join(home, NETWORK_STATE_FILE);
  const temp = `${dest}.${process.pid}.tmp`;
  // An old file is never opened: create exclusively in a root-controlled directory, then replace atomically.
  try {
    unlinkSync(temp);
  } catch {
    /* absent */
  }
  writeFileSync(temp, body, { mode: 0o600, flag: "wx" });
  renameSync(temp, dest);
  return state;
}

export interface NetworkProcess {
  pid: number;
  ppid: number;
  uids: number[];
}
/** A root-only observation. Incomplete scans must never authorize a UID network change. */
export function readNetworkProcesses(procRoot = "/proc"): NetworkProcess[] | null {
  try {
    const found: NetworkProcess[] = [];
    for (const name of readdirSync(procRoot)) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const status = readFileSync(path.join(procRoot, name, "status"), "utf8");
        if (/^State:\s+[ZX]/m.test(status)) continue;
        const uids = /^Uid:\s+([\d\s]+)$/m.exec(status)?.[1]?.trim().split(/\s+/).map(Number);
        const parent = /^PPid:\s+(\d+)/m.exec(status)?.[1];
        if (!uids?.length || !parent) return null;
        found.push({ pid: Number(name), ppid: Number(parent), uids });
      } catch (err) {
        if ((err as { code?: string }).code !== "ENOENT" && (err as { code?: string }).code !== "ESRCH") return null;
      }
    }
    return found;
  } catch {
    return null;
  }
}

/** Only the launch wrapper's first UID-owned child is the worker; all its children and unrelated services hold. */
export function uidHasOtherProcesses(processes: NetworkProcess[] | null, uid: number, wrapperPid?: number): boolean {
  if (!processes) return true;
  const byPid = new Map(processes.map((proc) => [proc.pid, proc]));
  const own = processes.filter((proc) => proc.uids.includes(uid));
  const worker = own.filter((proc) => {
    if (proc.pid === wrapperPid) return true;
    let parent = proc.ppid;
    const seen = new Set<number>();
    while (parent > 0 && !seen.has(parent)) {
      if (parent === wrapperPid) return true;
      seen.add(parent);
      const ancestor = byPid.get(parent);
      if (!ancestor || ancestor.uids.includes(uid)) return false;
      parent = ancestor.ppid;
    }
    return false;
  });
  // More than one first UID child means the wrapper's identity is ambiguous: retain the old context.
  return own.some((proc) => worker.length !== 1 || proc !== worker[0]);
}

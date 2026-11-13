/**
 * How big this computer is and how busy it gets, for the usage report: the server samples its own host,
 * and the runner its computer (protocol 22) and its agents' browsers' traffic (protocol 23). Node's `os`
 * and `fs` only, so the runner bundle can use it.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statfsSync } from "node:fs";
import { statfs } from "node:fs/promises";
import os from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { type BrowserTraffic, LOAD_SAMPLE_MS, type MachineLoad, type MachineSize } from "./machine-protocol";

const GIB = 2 ** 30;
const DAY_MS = 24 * 3600_000;
const round2 = (n: number) => Math.round(n * 100) / 100;
const halfGb = (bytes: number) => Math.round((bytes / GIB) * 2) / 2;
const round1 = (n: number) => Math.round(n * 10) / 10;
/** The hours `n` samples cover, at most a day. */
const hoursOf = (n: number) => Math.min(24, round1((n * LOAD_SAMPLE_MS) / 3600_000));
const execFileAsync = promisify(execFile);

/**
 * The whole machine's logical CPUs. `availableParallelism()` follows a container's CPU limit, but the
 * load average and the memory figures are the whole machine's, so loads are measured against this.
 */
const machineCpus = () => os.cpus().length || os.availableParallelism();

/**
 * The machine's logical CPUs, memory (to 0.5 GB) and the disk holding `dir` (to 1 GB), with `limit`
 * when this process may use less of them (a container's CPU or memory limit).
 */
export function machineSize(dir: string): MachineSize {
  let diskGb = 0;
  try {
    const fs = statfsSync(dir);
    diskGb = Math.round((fs.blocks * fs.bsize) / GIB);
  } catch {
    // a folder that went away: size unknown, the rest still says something
  }
  const cpus = machineCpus();
  const memory = os.totalmem();
  const size: MachineSize = { cpus, memoryGb: halfGb(memory), diskGb };
  const limitCpus = Math.min(cpus, os.availableParallelism());
  // 0 (Node with no limit) or more than the machine has (an unlimited cgroup): no limit.
  const limitMemory = Math.min(memory, process.constrainedMemory?.() || memory);
  if (limitCpus < cpus || limitMemory < memory) size.limit = { cpus: limitCpus, memoryGb: halfGb(limitMemory) };
  return size;
}

/**
 * The disk holding `dir`, in bytes: its size and what this process may still write there. A folder not made yet is
 * read through the nearest one that is, where it will be made. Null when nothing on the path can be read. Never
 * blocks the event loop, so a network share that stalls (a Windows `\\server\share`, NFS) holds up only its caller.
 */
export async function diskSpace(dir: string): Promise<{ sizeBytes: number; freeBytes: number } | null> {
  for (let path = resolve(dir); ; path = dirname(path)) {
    try {
      const fs = await statfs(path);
      return { sizeBytes: fs.blocks * fs.bsize, freeBytes: fs.bavail * fs.bsize };
    } catch {
      if (dirname(path) === path) return null;
    }
  }
}

/** Docker, Podman or Kubernetes: the host is shared with whatever else runs there. */
export const inContainer = () =>
  existsSync("/.dockerenv") || existsSync("/run/.containerenv") || process.env.KUBERNETES_SERVICE_HOST !== undefined;

/** `MemAvailable` from `/proc/meminfo`, in bytes. */
export function memAvailable(meminfo: string): number | null {
  return meminfoBytes(meminfo, "MemAvailable");
}

/** A line of `/proc/meminfo` (`MemAvailable`, `SwapTotal`…), in bytes; null when it isn't there. */
export function meminfoBytes(meminfo: string, key: string): number | null {
  const kb = new RegExp(`^${key}:\\s+(\\d+) kB`, "m").exec(meminfo)?.[1];
  return kb ? Number(kb) * 1024 : null;
}

/** What macOS hands out without swapping, from `vm_stat`: free, inactive and speculative pages, in bytes. */
export function vmStatAvailable(vmStat: string): number | null {
  const page = Number(/page size of (\d+) bytes/.exec(vmStat)?.[1]);
  const pages = (name: string) => Number(new RegExp(`^Pages ${name}:\\s+(\\d+)`, "m").exec(vmStat)?.[1] ?? Number.NaN);
  const n = (pages("free") + pages("inactive") + pages("speculative")) * page;
  return Number.isFinite(n) ? n : null;
}

/** The share of the machine's memory in use now. `os.freemem()` counts the cache the system would hand back as used. */
async function memoryInUse(): Promise<number> {
  const total = os.totalmem();
  let available: number | null = null;
  try {
    if (process.platform === "linux") available = memAvailable(readFileSync("/proc/meminfo", "utf8"));
    else if (process.platform === "darwin") {
      available = vmStatAvailable((await execFileAsync("vm_stat", { encoding: "utf8", timeout: 5000 })).stdout);
    }
  } catch {
    // fall back to what the runtime says
  }
  return Math.min(1, Math.max(0, 1 - (available ?? os.freemem()) / total));
}

/** A cgroup's counters (`memory.events`: `name value` lines), or null where there is no such cgroup. */
export function cgroupCounters(file: string): Record<string, number> | null {
  try {
    const lines = readFileSync(file, "utf8").matchAll(/^(\w+) (\d+)$/gm);
    return Object.fromEntries([...lines].map((m) => [m[1], Number(m[2])]));
  } catch {
    return null;
  }
}

export interface LoadSample {
  /** Epoch milliseconds. */
  at: number;
  load: number;
  memory: number;
  /** How many processes the kernel had stopped for memory in the agents' slices so far, where there are any. */
  oomKills?: number;
}

/** What a counter rose by from each sample to the next that has it; one that went down started again (a reboot). */
function risen(counts: readonly (number | undefined)[]): number {
  let total = 0;
  let prev: number | undefined;
  for (const c of counts) {
    if (c === undefined) continue;
    if (prev !== undefined) total += c >= prev ? c - prev : c;
    prev = c;
  }
  return total;
}

/** One sample: the 5-minute load average per logical CPU of the machine and the share of memory in use. Null on Windows. */
export async function sampleLoad(): Promise<Omit<LoadSample, "at"> | null> {
  if (process.platform === "win32") return null;
  const [, fiveMinutes = 0] = os.loadavg();
  return { load: fiveMinutes / machineCpus(), memory: await memoryInUse() };
}

type DiskFigures = Pick<MachineLoad, "diskFreeGb" | "diskUse" | "sharedGb">;

/** `diskSpace`'s bytes as `pong.load` carries them: free GB (one decimal) and the share in use. */
export const diskFigures = (d: { sizeBytes: number; freeBytes: number } | null): DiskFigures =>
  d && d.sizeBytes > 0
    ? {
        diskFreeGb: round1(d.freeBytes / GIB),
        diskUse: round2(Math.min(1, Math.max(0, 1 - d.freeBytes / d.sizeBytes))),
      }
    : {};

/**
 * The last day of samples, summarized; `summary()` is the same object until the next sample. A new
 * process starts from the `samples` the last one kept, so a restart keeps the day.
 */
export class LoadWindow {
  private last: MachineLoad | null = null;

  constructor(private kept: readonly LoadSample[] = []) {}

  get samples(): readonly LoadSample[] {
    return this.kept;
  }

  /** `disk`: the disk's latest figures (ADR 0115), carried as they are, never averaged. */
  add(sample: Omit<LoadSample, "at"> | null, at = Date.now(), disk: DiskFigures = {}) {
    if (!sample) return;
    this.kept = [...this.kept, { at, ...sample }].filter((s) => s.at > at - DAY_MS);
    const n = this.kept.length;
    const avg = (pick: (s: LoadSample) => number) => round2(this.kept.reduce((sum, s) => sum + pick(s), 0) / n);
    const peak = (pick: (s: LoadSample) => number) => round2(Math.max(...this.kept.map(pick)));
    this.last = {
      loadAvg: avg((s) => s.load),
      loadPeak: peak((s) => s.load),
      memoryAvg: avg((s) => s.memory),
      memoryPeak: peak((s) => s.memory),
      hours: hoursOf(n),
      ...(sample.oomKills === undefined ? {} : { oomKills: risen(this.kept.map((s) => s.oomKills)) }),
      ...disk,
    };
  }

  summary(): MachineLoad | null {
    return this.last;
  }
}

/**
 * Several computers' days as one, for the usage report: their averages averaged and the highest peaks; null
 * when none said. A computer's OOM kills stay out of it, as for one computer alone.
 */
export function combineLoads(loads: readonly (MachineLoad | null)[]): MachineLoad | null {
  const known = loads.filter((l): l is MachineLoad => l !== null);
  if (known.length === 0) return null;
  const mean = (pick: (l: MachineLoad) => number) => known.reduce((sum, l) => sum + pick(l), 0) / known.length;
  const peak = (pick: (l: MachineLoad) => number) => known.reduce((max, l) => Math.max(max, pick(l)), 0);
  return {
    loadAvg: round2(mean((l) => l.loadAvg)),
    loadPeak: round2(peak((l) => l.loadPeak)),
    memoryAvg: round2(mean((l) => l.memoryAvg)),
    memoryPeak: round2(peak((l) => l.memoryPeak)),
    hours: round1(mean((l) => l.hours)),
  };
}

/**
 * The last day of what the agents' browsers sent and received, a sample every `LOAD_SAMPLE_MS` (an
 * empty one too, so `hours` says how long it was counted); `summary()` is the same object until the
 * next sample.
 */
export class TrafficWindow {
  private kept: { at: number; up: number; down: number }[] = [];
  private last: BrowserTraffic | null = null;

  add(bytes: { up: number; down: number }, at = Date.now()) {
    this.kept = [...this.kept, { at, up: bytes.up, down: bytes.down }].filter((s) => s.at > at - DAY_MS);
    const sum = (pick: (s: { up: number; down: number }) => number) => this.kept.reduce((n, s) => n + pick(s), 0);
    this.last = { up: sum((s) => s.up), down: sum((s) => s.down), hours: hoursOf(this.kept.length) };
  }

  summary(): BrowserTraffic | null {
    return this.last;
  }
}

/** Computers' browser traffic as the usage report has it: MB (10^6 bytes), the hours counted, how many said. */
export interface CombinedTraffic {
  upMb: number;
  downMb: number;
  hours: number;
  computers: number;
}

/** Several computers' browser traffic as one: the bytes summed, their hours averaged; null when none said. */
export function combineTraffic(traffic: readonly (BrowserTraffic | null)[]): CombinedTraffic | null {
  const known = traffic.filter((t): t is BrowserTraffic => t !== null);
  if (known.length === 0) return null;
  const sum = (pick: (t: BrowserTraffic) => number) => known.reduce((n, t) => n + pick(t), 0);
  return {
    upMb: Math.round(sum((t) => t.up) / 1e6),
    downMb: Math.round(sum((t) => t.down) / 1e6),
    hours: round1(sum((t) => t.hours) / known.length),
    computers: known.length,
  };
}

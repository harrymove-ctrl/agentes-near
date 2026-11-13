import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, statfsSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cgroupCounters,
  combineLoads,
  combineTraffic,
  diskFigures,
  diskSpace,
  LoadWindow,
  machineSize,
  memAvailable,
  sampleLoad,
  TrafficWindow,
  vmStatAvailable,
} from "../src/host-stats";
import { LOAD_SAMPLE_MS, parseBrowserTraffic, parseRunnerFrame } from "../src/machine-protocol";

const HOUR = 3600_000;
const GIB = 2 ** 30;
afterEach(() => mock.restore());

describe("the load sampler", () => {
  test("averages and peaks the last day of samples; older ones drop out", () => {
    const w = new LoadWindow();
    expect(w.summary()).toBeNull();
    const t0 = Date.UTC(2026, 9, 25, 12);
    w.add({ load: 2, memory: 0.9 }, t0);
    w.add({ load: 0.5, memory: 0.4 }, t0 + LOAD_SAMPLE_MS);
    w.add({ load: 0.3, memory: 0.5 }, t0 + 2 * LOAD_SAMPLE_MS);
    expect(w.summary()).toEqual({ loadAvg: 0.93, loadPeak: 2, memoryAvg: 0.6, memoryPeak: 0.9, hours: 0.3 });
    // A day later the first sample (the peak) is gone.
    w.add({ load: 0.1, memory: 0.2 }, t0 + 24 * HOUR);
    expect(w.summary()).toEqual({ loadAvg: 0.3, loadPeak: 0.5, memoryAvg: 0.37, memoryPeak: 0.5, hours: 0.3 });
  });

  test("the summary is the same object until the next sample; a missing sample changes nothing", () => {
    const w = new LoadWindow();
    w.add({ load: 1, memory: 0.5 }, 1);
    const first = w.summary();
    expect(w.summary()).toBe(first);
    w.add(null, 2);
    expect(w.summary()).toBe(first);
    w.add({ load: 1, memory: 0.5 }, 3);
    expect(w.summary()).not.toBe(first);
    expect(w.summary()?.hours).toBe(0.2);
  });

  test("a full day is 24 hours, never more", () => {
    const w = new LoadWindow();
    for (let i = 0; i < 400; i++) w.add({ load: 0.5, memory: 0.5 }, i * LOAD_SAMPLE_MS);
    expect(w.summary()?.hours).toBe(24);
  });

  test("memory in use reads what the system can hand out, not just free pages", () => {
    expect(
      memAvailable("MemTotal:       16314404 kB\nMemFree:          412012 kB\nMemAvailable:    9311148 kB\n"),
    ).toBe(9311148 * 1024);
    expect(memAvailable("MemTotal: 1 kB\n")).toBeNull();
    const vmStat = [
      "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
      "Pages free:                                   125104.",
      "Pages active:                                 784048.",
      "Pages inactive:                               776509.",
      "Pages speculative:                             23421.",
      "Pages wired down:                             253987.",
    ].join("\n");
    expect(vmStatAvailable(vmStat)).toBe((125104 + 776509 + 23421) * 16384);
    expect(vmStatAvailable("nothing here")).toBeNull();
  });

  test("a restarted process starts from the samples the last one kept", () => {
    const t0 = Date.UTC(2026, 9, 25, 12);
    const before = new LoadWindow();
    before.add({ load: 2, memory: 0.9 }, t0);
    before.add({ load: 1, memory: 0.5 }, t0 + LOAD_SAMPLE_MS);
    const after = new LoadWindow(JSON.parse(JSON.stringify(before.samples)));
    expect(after.summary()).toBeNull();
    after.add({ load: 0, memory: 0.1 }, t0 + 3 * HOUR);
    expect(after.summary()).toEqual({ loadAvg: 1, loadPeak: 2, memoryAvg: 0.5, memoryPeak: 0.9, hours: 0.3 });
  });

  test("several computers' days as one: the averages averaged, the highest peaks", () => {
    const a = { loadAvg: 0.2, loadPeak: 0.8, memoryAvg: 0.4, memoryPeak: 0.6, hours: 24 };
    const b = { loadAvg: 0.6, loadPeak: 1.9, memoryAvg: 0.7, memoryPeak: 0.95, hours: 12 };
    expect(combineLoads([a, null, b])).toEqual({
      loadAvg: 0.4,
      loadPeak: 1.9,
      memoryAvg: 0.55,
      memoryPeak: 0.95,
      hours: 18,
    });
    expect(combineLoads([null, a])).toEqual(a);
    expect(combineLoads([null])).toBeNull();
    // What else a computer says stays out of the usage report, one computer or several.
    expect(combineLoads([{ ...a, oomKills: 4 }])).toEqual(a);
    expect(combineLoads([{ ...a, oomKills: 4 }, b])).not.toHaveProperty("oomKills");
  });

  test("the agents' slices' OOM kills: what the kernel's counter rose by over the day, a reboot's reset included", () => {
    const dir = mkdtempSync(join(tmpdir(), "cgroup-"));
    const events = join(dir, "memory.events");
    writeFileSync(events, "low 0\nhigh 12\nmax 3\noom 2\noom_kill 7\noom_group_kill 0\n");
    expect(cgroupCounters(events)).toEqual({ low: 0, high: 12, max: 3, oom: 2, oom_kill: 7, oom_group_kill: 0 });
    // No such cgroup here (a runner outside system mode, or no systemd).
    expect(cgroupCounters(join(dir, "none", "memory.events"))).toBeNull();

    const w = new LoadWindow();
    const t0 = Date.UTC(2026, 10, 1, 12);
    // Kills before the first sample aren't the day's: unknown when they were.
    w.add({ load: 0.2, memory: 0.3, oomKills: 7 }, t0);
    expect(w.summary()?.oomKills).toBe(0);
    w.add({ load: 0.2, memory: 0.3, oomKills: 9 }, t0 + LOAD_SAMPLE_MS);
    // A sample whose counter couldn't be read is skipped over.
    w.add({ load: 0.2, memory: 0.3 }, t0 + 2 * LOAD_SAMPLE_MS);
    w.add({ load: 0.2, memory: 0.3, oomKills: 10 }, t0 + 3 * LOAD_SAMPLE_MS);
    // Rebooted: the counter started again from zero.
    w.add({ load: 0.2, memory: 0.3, oomKills: 1 }, t0 + 4 * LOAD_SAMPLE_MS);
    expect(w.summary()?.oomKills).toBe(4);
    // A day later only the rises inside the day count.
    w.add({ load: 0.2, memory: 0.3, oomKills: 1 }, t0 + 24 * HOUR + LOAD_SAMPLE_MS);
    expect(w.summary()?.oomKills).toBe(1);
    // Where agents have no slices, nothing is said.
    const plain = new LoadWindow();
    plain.add({ load: 0.2, memory: 0.3 }, t0);
    expect(plain.summary()).not.toHaveProperty("oomKills");
  });

  test("the disk's latest figures and the shared folder's size ride on the summary as they are (ADR 0115)", () => {
    expect(diskFigures({ sizeBytes: 100 * GIB, freeBytes: 12.34 * GIB })).toEqual({ diskFreeGb: 12.3, diskUse: 0.88 });
    expect(diskFigures(null)).toEqual({});
    expect(diskFigures({ sizeBytes: 0, freeBytes: 0 })).toEqual({});
    const w = new LoadWindow();
    const t0 = Date.UTC(2026, 10, 1, 12);
    w.add({ load: 0.2, memory: 0.3 }, t0, { diskFreeGb: 40, diskUse: 0.6, sharedGb: 3.5 });
    w.add({ load: 0.4, memory: 0.3 }, t0 + LOAD_SAMPLE_MS, { diskFreeGb: 10, diskUse: 0.9, sharedGb: 33 });
    expect(w.summary()).toMatchObject({ loadAvg: 0.3, diskFreeGb: 10, diskUse: 0.9, sharedGb: 33 });
    // Through the protocol: sane numbers kept, others dropped.
    const pong = (load: Record<string, unknown>) => parseRunnerFrame(JSON.stringify({ type: "pong", at: 1, load }));
    const base = { loadAvg: 0.3, loadPeak: 0.4, memoryAvg: 0.3, memoryPeak: 0.3, hours: 0.2 };
    expect(pong({ ...base, diskFreeGb: 10, diskUse: 0.9, sharedGb: 33 })).toEqual({
      type: "pong",
      at: 1,
      load: { ...base, diskFreeGb: 10, diskUse: 0.9, sharedGb: 33 },
    });
    expect(pong({ ...base, diskFreeGb: -1, diskUse: 2, sharedGb: "x" })).toEqual({ type: "pong", at: 1, load: base });
  });

  test("in a container with limits: the machine's size with the limit beside it, the load per machine CPU", async () => {
    // A 4-CPU, 8 GB machine running `docker run --cpus=1 --memory=1g`.
    spyOn(os, "cpus").mockReturnValue(Array.from({ length: 4 }, () => os.cpus()[0] as os.CpuInfo));
    spyOn(os, "availableParallelism").mockReturnValue(1);
    spyOn(os, "totalmem").mockReturnValue(8 * GIB);
    spyOn(process, "constrainedMemory").mockReturnValue(GIB);
    spyOn(os, "loadavg").mockReturnValue([4, 3.2, 2]);
    const dir = mkdtempSync(join(tmpdir(), "stats-"));
    expect(machineSize(dir)).toMatchObject({ cpus: 4, memoryGb: 8, limit: { cpus: 1, memoryGb: 1 } });
    if (process.platform !== "win32") expect((await sampleLoad())?.load).toBe(0.8);
    // No limit: none said.
    spyOn(os, "availableParallelism").mockReturnValue(4);
    spyOn(process, "constrainedMemory").mockReturnValue(8 * GIB);
    expect(machineSize(dir)).not.toHaveProperty("limit");
    spyOn(process, "constrainedMemory").mockReturnValue(0);
    expect(machineSize(dir)).not.toHaveProperty("limit");
  });

  test("a sample doesn't hold up the process while the system answers", async () => {
    let ticks = 0;
    const tick = setInterval(() => ticks++, 0);
    await sampleLoad();
    clearInterval(tick);
    // macOS reads its memory from `vm_stat`, a program; on Linux it is a file read.
    if (process.platform === "darwin") expect(ticks).toBeGreaterThan(0);
  });

  test("this computer: a sample and a size", async () => {
    const s = await sampleLoad();
    if (process.platform !== "win32") {
      expect(s?.load).toBeGreaterThanOrEqual(0);
      expect(s?.memory).toBeGreaterThan(0);
      expect(s?.memory).toBeLessThanOrEqual(1);
    }
    const size = machineSize(mkdtempSync(join(tmpdir(), "stats-")));
    expect(size.cpus).toBeGreaterThanOrEqual(1);
    expect(size.memoryGb).toBeGreaterThan(0);
    expect(size.diskGb).toBeGreaterThan(0);
    expect(Number.isInteger(size.diskGb)).toBe(true);
    expect(machineSize("/no/such/folder").diskGb).toBe(0);
  });

  test("the disk holding a folder: its size and what is free, through the nearest folder for one not made yet", async () => {
    const dir = mkdtempSync(join(tmpdir(), "disk-"));
    const disk = await diskSpace(dir);
    const fs = statfsSync(dir);
    expect(disk?.sizeBytes).toBe(fs.blocks * fs.bsize);
    expect(disk?.freeBytes).toBeGreaterThan(0);
    expect(disk?.freeBytes).toBeLessThanOrEqual(disk?.sizeBytes ?? 0);
    expect((await diskSpace(join(dir, "files", "orgs")))?.sizeBytes).toBe(disk?.sizeBytes);
  });
});

describe("protocol 22 on the wire", () => {
  const hello = (extra: Record<string, unknown>) =>
    parseRunnerFrame(JSON.stringify({ type: "hello", token: "t", version: "1", protocol: 22, ...extra }));

  test("hello carries the size; nonsense or an older runner's hello has none", () => {
    expect(hello({ size: { cpus: 2, memoryGb: 4, diskGb: 80 } })).toMatchObject({
      size: { cpus: 2, memoryGb: 4, diskGb: 80 },
    });
    const limited = { cpus: 4, memoryGb: 8, diskGb: 80, limit: { cpus: 1, memoryGb: 1 } };
    expect(hello({ size: limited })).toMatchObject({ size: limited });
    // A limit above the machine itself isn't one.
    expect((hello({ size: { ...limited, limit: { cpus: 8, memoryGb: 1 } } }) as { size: object }).size).toEqual({
      cpus: 4,
      memoryGb: 8,
      diskGb: 80,
    });
    expect(hello({})).not.toHaveProperty("size");
    expect(hello({ size: { cpus: 0, memoryGb: 4, diskGb: 80 } })).not.toHaveProperty("size");
    expect(hello({ size: { cpus: 2, memoryGb: "4", diskGb: 80 } })).not.toHaveProperty("size");
  });

  test("a pong carries the load; without one, or a bad one, it is a plain pong", () => {
    const load = { loadAvg: 0.4, loadPeak: 1.2, memoryAvg: 0.5, memoryPeak: 0.7, hours: 6 };
    expect(parseRunnerFrame(JSON.stringify({ type: "pong", at: 1, load }))).toEqual({ type: "pong", at: 1, load });
    expect(parseRunnerFrame(JSON.stringify({ type: "pong", at: 1 }))).toEqual({ type: "pong", at: 1 });
    expect(parseRunnerFrame(JSON.stringify({ type: "pong", at: 1, load: { ...load, memoryPeak: 3 } }))).toEqual({
      type: "pong",
      at: 1,
    });
  });

  test("the load carries the agents' OOM kills when the runner counts them; a bad count is left out", () => {
    const load = { loadAvg: 0.4, loadPeak: 1.2, memoryAvg: 0.5, memoryPeak: 0.7, hours: 6 };
    const pong = (l: Record<string, unknown>) => parseRunnerFrame(JSON.stringify({ type: "pong", at: 1, load: l }));
    expect(pong({ ...load, oomKills: 3 })).toEqual({ type: "pong", at: 1, load: { ...load, oomKills: 3 } });
    for (const bad of [-1, 1.5, "3", 2e9])
      expect(pong({ ...load, oomKills: bad })).toEqual({ type: "pong", at: 1, load });
  });
});

describe("the agents' browsers' traffic (protocol 23)", () => {
  test("the window sums the last day of samples, empty ones too, and says the hours it covers", () => {
    const w = new TrafficWindow();
    expect(w.summary()).toBeNull();
    const t0 = Date.UTC(2026, 9, 27, 12);
    w.add({ up: 1000, down: 50_000 }, t0);
    w.add({ up: 0, down: 0 }, t0 + LOAD_SAMPLE_MS);
    w.add({ up: 500, down: 7000 }, t0 + 2 * LOAD_SAMPLE_MS);
    expect(w.summary()).toEqual({ up: 1500, down: 57_000, hours: 0.3 });
    const same = w.summary();
    expect(w.summary()).toBe(same);
    // A day after the first sample, it is gone.
    w.add({ up: 1, down: 2 }, t0 + 24 * HOUR);
    expect(w.summary()).toEqual({ up: 501, down: 7002, hours: 0.3 });
    expect(w.summary()).not.toBe(same);
  });

  test("a full day is 24 hours, never more", () => {
    const w = new TrafficWindow();
    for (let i = 0; i < 400; i++) w.add({ up: 1, down: 1 }, i * LOAD_SAMPLE_MS);
    expect(w.summary()).toEqual({ up: 288, down: 288, hours: 24 });
  });

  test("several computers as one: bytes summed into MB, hours averaged, how many said", () => {
    const a = { up: 1_400_000, down: 250_600_000, hours: 24 };
    const b = { up: 600_000, down: 900_000, hours: 12.5 };
    expect(combineTraffic([a, null, b])).toEqual({ upMb: 2, downMb: 252, hours: 18.3, computers: 2 });
    expect(combineTraffic([null, { up: 0, down: 0, hours: 0.1 }])).toEqual({
      upMb: 0,
      downMb: 0,
      hours: 0.1,
      computers: 1,
    });
    expect(combineTraffic([null])).toBeNull();
    expect(combineTraffic([])).toBeNull();
  });

  test("a pong carries it; one out of bounds is dropped whole", () => {
    const traffic = { up: 12_000, down: 3_400_000, hours: 23.9 };
    expect(parseRunnerFrame(JSON.stringify({ type: "pong", at: 1, browserTraffic: traffic }))).toEqual({
      type: "pong",
      at: 1,
      browserTraffic: traffic,
    });
    expect(parseBrowserTraffic({ up: 0, down: 1e15, hours: 0 })).toEqual({ up: 0, down: 1e15, hours: 0 });
    for (const bad of [
      { ...traffic, up: -1 },
      { ...traffic, down: 1e15 + 1 },
      { ...traffic, up: 1.5 },
      { ...traffic, down: "3400000" },
      { ...traffic, hours: 24.1 },
      { ...traffic, hours: -0.1 },
      { up: 1, down: 1 },
      null,
      "traffic",
    ]) {
      expect(parseBrowserTraffic(bad)).toBeNull();
    }
    expect(
      parseRunnerFrame(JSON.stringify({ type: "pong", at: 1, browserTraffic: { ...traffic, hours: 25 } })),
    ).toEqual({ type: "pong", at: 1 });
  });
});

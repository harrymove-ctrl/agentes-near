import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { computerNow, cpuTimes } from "../../runner/computer-now";
import { removeDirs, tempDir } from "./helpers";

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

const GIB = 2 ** 30;

/** A computer as the command reads it: the agents' slice and theirs, /proc and /etc, in a folder of its own. */
function computer() {
  const root = tempDir("computer-");
  dirs.push(root);
  const cgroup = path.join(root, "agents.slice");
  const proc = path.join(root, "proc");
  const etc = path.join(root, "etc");
  for (const d of [cgroup, proc, etc]) mkdirSync(d, { recursive: true });
  const put = (dir: string, files: Record<string, string>) => {
    mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
  };
  /** An agent's slice: memory in use with its cache, swap, and CPU time so far (whole numbers, as the kernel's). */
  const agent = (uid: number, o: { bytes: number; cache?: number; swap?: number; usec: number }) => {
    const [bytes, cache, swap] = [Math.round(o.bytes), Math.round(o.cache ?? 0), Math.round(o.swap ?? 0)];
    put(path.join(cgroup, `agents-${uid}.slice`), {
      "memory.current": `${bytes + cache}\n`,
      "memory.stat": `anon ${bytes}\ninactive_file ${cache}\n`,
      "memory.swap.current": `${swap}\n`,
      "cpu.stat": `usage_usec ${o.usec}\nuser_usec 0\n`,
    });
  };
  const cpuStat = (busy: number, idle: number) => `cpu  ${busy} 0 0 ${idle} 0 0 0 0 0 0\ncpu0 1 2 3 4\n`;
  const meminfo = (availGb: number, swapGb: number) =>
    `MemTotal: 8000000 kB\nMemAvailable: ${availGb * 1024 * 1024} kB\nSwapTotal: ${swapGb * 1024 * 1024} kB\n`;
  put(proc, { stat: cpuStat(1000, 9000), meminfo: meminfo(3, 4) });
  put(etc, {
    passwd: [
      "root:x:0:0:root:/root:/bin/bash",
      "ag-aaaaaaaa:x:20000:20000:Ada:/home/ag-aaaaaaaa:/bin/bash",
      "ag-bbbbbbbb:x:20001:20001:Bia, the builder:/home/ag-bbbbbbbb:/bin/bash",
      "ag-cccccccc:x:20002:20002::/home/ag-cccccccc:/bin/bash",
      "ag-dddddddd:x:21000:21000:Dora:/home/ag-dddddddd:/bin/bash",
    ].join("\n"),
    // One runner (a workspace's computer): Dora hasn't joined the shared group yet, and is one of its agents all the same.
    group: ["root:x:0:", "agentes-shared:x:997:ag-aaaaaaaa,ag-bbbbbbbb,ag-cccccccc"].join("\n"),
  });
  return { root, cgroup, proc, etc, agent, put, cpuStat, meminfo };
}

test("cpuTimes: busy and all of /proc/stat's CPU line, guest time left out (it is in user time already)", () => {
  expect(cpuTimes("cpu  10 2 3 80 5 1 1 2 7 7\n")).toEqual({ busy: 19, total: 104 });
  expect(cpuTimes("cpu0 1 2 3\n")).toBeNull();
  expect(cpuTimes("")).toBeNull();
});

test("what the agents share, what is free for new work, and who uses the most, by name", async () => {
  const c = computer();
  c.put(c.cgroup, {
    "memory.current": `${5.5 * GIB}\n`,
    "memory.stat": `inactive_file ${0.5 * GIB}\n`,
    "memory.max": `${6 * GIB}\n`,
    "memory.swap.current": `${0.75 * GIB}\n`,
    "memory.swap.max": `${2 * GIB}\n`,
  });
  // Bia builds, Ada (the caller) reads a page, the agent with no name does nothing, Dora holds a little.
  c.agent(20001, { bytes: 3.5 * GIB, cache: 0.3 * GIB, swap: 0.6 * GIB, usec: 1_000_000 });
  c.agent(20000, { bytes: 0.4 * GIB, usec: 500_000 });
  c.agent(20002, { bytes: 0.01 * GIB, usec: 0 });
  c.agent(21000, { bytes: 0.6 * GIB, usec: 0 });
  const io = {
    cgroup: c.cgroup,
    proc: c.proc,
    etc: c.etc,
    uid: 20000,
    groups: [20000, 997],
    cpus: 4,
    totalBytes: 7.76 * GIB,
    sampleMs: 500,
    // One second later by /proc/stat's clock (a late wake, so not the half second asked for): the computer was busy
    // for 3 of its 4 CPUs, Bia used 2.5 of them, Ada 0.2.
    sleep: async () => {
      writeFileSync(path.join(c.proc, "stat"), c.cpuStat(1000 + 300, 9000 + 100));
      c.agent(20001, { bytes: 3.5 * GIB, cache: 0.3 * GIB, swap: 0.6 * GIB, usec: 3_500_000 });
      c.agent(20000, { bytes: 0.4 * GIB, usec: 700_000 });
    },
  };
  expect((await computerNow(io)).split("\n")).toEqual([
    "This computer: 4 CPUs and 7.8 GB of memory, shared by all its agents.",
    "Now: 3.0 of 4 CPUs busy. The agents use 5.0 GB of the 6.0 GB they may use together (swap: 0.8 GB of 2.0 GB).",
    // The agents' room (1 GB) is less than what the computer has free (3 GB): theirs counts.
    "Free for new work: about 1.0 GB of memory.",
    "Using the most now:",
    "- Bia: 3.5 GB (and 0.6 GB in swap), 2.5 CPUs",
    "- Dora: 0.6 GB, 0.0 CPUs",
    "- Ada (you): 0.4 GB, 0.2 CPUs",
  ]);

  // The server's own computer: each organization's runner has a group, and another one's agents go unnamed.
  writeFileSync(
    path.join(c.etc, "group"),
    ["agentes-sh-aaaaaaaa:x:996:ag-aaaaaaaa,ag-bbbbbbbb,ag-cccccccc", "agentes-sh-dddddddd:x:995:ag-dddddddd"].join(
      "\n",
    ),
  );
  const still = { ...io, sleep: async () => {} };
  const host = await computerNow({ ...still, groups: [20000, 996] });
  expect(host).toContain("\n- Bia: 3.5 GB (and 0.6 GB in swap), 0.0 CPUs\n- Ada (you): 0.4 GB, 0.0 CPUs\n");
  expect(host).toEndWith("\n- Other agents: 0.6 GB, 0.0 CPUs");
  // Before the caller joined its organization's group: only itself by name.
  const alone = await computerNow({ ...still, groups: [20000] });
  expect(alone).toContain("\n- Ada (you): 0.4 GB, 0.0 CPUs\n- Other agents: 4.1 GB (and 0.6 GB in swap), 0.0 CPUs");
  // As a person (root): every agent by name, and the computer's free memory when it is less than the agents' room;
  // the swap they may use is no more than the computer has.
  writeFileSync(path.join(c.proc, "meminfo"), c.meminfo(0.5, 1));
  const asRoot = await computerNow({ ...still, uid: 0, groups: [0] });
  expect(asRoot).toContain(" together (swap: 0.8 GB of 1.0 GB).\nFree for new work: about 0.5 GB of memory.\n");
  expect(asRoot).toContain("\n- Dora: 0.6 GB, 0.0 CPUs");
  expect(asRoot).not.toContain("(you)");
});

test("no limit on the agents, nobody busy, and a computer whose agents don't have slices of their own", async () => {
  const c = computer();
  c.put(c.cgroup, { "memory.current": `${GIB}\n`, "memory.stat": "inactive_file 0\n", "memory.max": "max\n" });
  const io = { cgroup: c.cgroup, proc: c.proc, etc: c.etc, uid: 20000, groups: [997], cpus: 2, totalBytes: 4 * GIB };
  const idle = await computerNow({ ...io, sleep: async () => {} });
  expect(idle.split("\n").slice(1)).toEqual([
    "Now: 0.0 of 2 CPUs busy. The agents use 1.0 GB of memory (swap: 0.0 GB of 4.0 GB).",
    "Free for new work: about 3.0 GB of memory.",
    "No agent is using it now.",
  ]);
  // A computer with no swap: none to tell of, whatever the slice may hold.
  writeFileSync(path.join(c.proc, "meminfo"), c.meminfo(3, 0));
  expect(await computerNow({ ...io, sleep: async () => {} })).toContain(" The agents use 1.0 GB of memory.\n");
  // Single-user mode: the computer's own figures only.
  const alone = await computerNow({ ...io, cgroup: path.join(c.root, "none"), sleep: async () => {} });
  expect(alone.split("\n")).toEqual([
    "This computer: 2 CPUs and 4.0 GB of memory.",
    "Now: 0.0 of 2 CPUs busy, 3.0 GB of memory free.",
  ]);
  // Not Linux (no /proc): its size alone.
  const elsewhere = { ...io, cgroup: path.join(c.root, "none"), proc: path.join(c.root, "none") };
  expect(await computerNow({ ...elsewhere, sleep: async () => {} })).toBe(
    "This computer: 2 CPUs and 4.0 GB of memory.",
  );
});

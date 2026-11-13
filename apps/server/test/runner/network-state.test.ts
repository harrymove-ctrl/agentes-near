import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  AgentNetworks,
  NetworkDrain,
  networkConfig,
  networkKey,
  processStartTicks,
  readNetworkProcesses,
  uidHasOtherProcesses,
} from "../../runner/network-state";
import { removeDirs, tempDir } from "./helpers";

test("runtime identity reads start ticks after the whole process name, including spaces and parentheses", () => {
  const fields = Array.from({ length: 25 }, () => "0");
  fields[0] = "S";
  fields[19] = "123456789";
  expect(processStartTicks(`42 (runner (service)) ${fields.join(" ")}`)).toBe("123456789");
  expect(processStartTicks("bad")).toBeNull();
  expect(processStartTicks("42 (runner) S 1 2")).toBeNull();
});
test("network configuration comparison excludes credentials and represents removals", () => {
  expect(networkConfig({ networkLauncher: "/root/net", networkMark: 0x08000000 })).toEqual({
    networkLauncher: "/root/net",
    networkMark: 0x08000000,
  });
  expect(networkKey({})).toBe("[null,null,0]");
  expect(networkKey({ networkMark: 1 })).not.toBe(networkKey({}));
});

test("a UID keeps one network while a worker, opening desktop or terminal holds it, including after restart", () => {
  const namespaced = { networkLauncher: "/root/net", networkMark: 0x08000000 };
  const pins = new AgentNetworks({});
  expect(pins.resolve(21000, false)).toEqual({});
  pins.set(namespaced);
  expect(pins.resolve(21000, true)).toEqual({});
  expect(pins.resolve(21001, true)).toEqual(namespaced);
  expect(pins.pending((uid) => uid === 21000)).toEqual([21000]);
  expect(pins.snapshot()).toEqual([{ uid: 21000 }]);
  const restored = new AgentNetworks(namespaced, pins.snapshot());
  expect(restored.resolve(21000, true)).toEqual({});
  expect(restored.resolve(21000, false)).toEqual(namespaced);
  restored.set({ networkMark: 0x08000000 });
  expect(restored.resolve(21000, true)).toEqual(namespaced);
  expect(restored.pending(() => true)).toContain(21000);
  expect(restored.resolve(21000, false)).toEqual({ networkMark: 0x08000000 });
});

test("UID drain keeps daemonized and child services, excluding only the trusted launcher's worker", () => {
  const root = { pid: 10, ppid: 1, uids: [0] };
  const runuser = { pid: 11, ppid: 10, uids: [0] };
  const worker = { pid: 12, ppid: 11, uids: [21000] };
  expect(uidHasOtherProcesses([root, runuser, worker], 21000, 10)).toBe(false);
  expect(uidHasOtherProcesses([root, runuser, worker, { pid: 13, ppid: 12, uids: [21000] }], 21000, 10)).toBe(true);
  expect(uidHasOtherProcesses([root, runuser, worker, { pid: 14, ppid: 1, uids: [21000] }], 21000, 10)).toBe(true);
  expect(uidHasOtherProcesses([{ pid: 14, ppid: 1, uids: [21000] }], 21000)).toBe(true);
  expect(uidHasOtherProcesses([root, { pid: 14, ppid: 1, uids: [21001] }], 21000)).toBe(false);
  expect(uidHasOtherProcesses([root, worker], 21000, 99)).toBe(true);
  expect(uidHasOtherProcesses(null, 21000, 10)).toBe(true);
});

const processDirs: string[] = [];
afterEach(() => removeDirs(processDirs));
test("process observation uses kernel UIDs, ignores zombies and exits, and refuses incomplete data", () => {
  const root = tempDir("network-proc-");
  processDirs.push(root);
  mkdirSync(path.join(root, "1"));
  writeFileSync(path.join(root, "1", "status"), "State:\tS (sleeping)\nPPid:\t0\nUid:\t0\t0\t0\t0\nGid:\t0\n");
  mkdirSync(path.join(root, "2"));
  writeFileSync(
    path.join(root, "2", "status"),
    "State:\tS (sleeping)\nPPid:\t1\nUid:\t21000\t21000\t21000\t21000\nGid:\t21000\n",
  );
  mkdirSync(path.join(root, "3"));
  writeFileSync(path.join(root, "3", "status"), "State:\tZ (zombie)\n");
  mkdirSync(path.join(root, "4")); // exited after listing
  expect(readNetworkProcesses(root)?.sort((a, b) => a.pid - b.pid)).toEqual([
    { pid: 1, ppid: 0, uids: [0, 0, 0, 0] },
    { pid: 2, ppid: 1, uids: [21000, 21000, 21000, 21000] },
  ]);
  writeFileSync(path.join(root, "2", "status"), "State:\tS (sleeping)\n");
  expect(readNetworkProcesses(root)).toBeNull();
});

test("a finite drain survives restart and never extends when the same policy repeats", () => {
  const now = Date.parse("2026-11-01T00:00:00Z");
  const pending = [{ uid: 21000, agentId: "a1" }];
  const drain = new NetworkDrain();
  const first = drain.update(pending, "target", 60, now);
  expect(first[0]).toMatchObject({ state: "draining", deadline: "2026-11-01T00:01:00.000Z" });
  const resumed = new NetworkDrain(first);
  expect(resumed.update(pending, "target", 120, now + 60_000)[0]).toMatchObject({
    state: "restart_required",
    deadline: first[0]?.deadline,
  });
  expect(resumed.update([], "target", 60, now + 61_000)).toEqual([]);
  expect(new NetworkDrain().update(pending, "target", undefined, now)).toEqual([]);
});

test("a higher isolation revision drains a live UID even when launcher and mark stay the same", () => {
  const old = { networkLauncher: "/root/net", networkMark: 0x08000000, networkRevision: 1 };
  const next = { ...old, networkRevision: 2 };
  const pins = new AgentNetworks(old, [{ uid: 21000, ...old }]);
  pins.set(next);
  expect(pins.resolve(21000, true)).toEqual(old);
  expect(pins.pending(() => true)).toEqual([21000]);
  expect(networkKey(old)).not.toBe(networkKey(next));
  expect(networkKey({})).toBe(networkKey({ networkRevision: 0 }));
  expect(pins.resolve(21000, false)).toEqual(next);
});

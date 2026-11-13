import { expect, test } from "bun:test";
import {
  type BindCheck,
  type BindProbes,
  bindCheckArgs,
  kernelProbes,
  PolicyNotInForce,
  parseBindCheck,
  verifyBrowserBindPolicy,
} from "../../runner/browser-bind-check";

const CHECK: BindCheck = {
  forbidden: [10002, 11999],
  allowed: [10000, 10001, 3000, 12000],
  band: [10000, 11999],
  decoys: [41000, 41001],
};

type Answer = (host: string, port: number) => string;

/** A kernel that keeps the agent's isolation, unless told otherwise; records each probe. */
function kernel(o: { bind?: Answer; ownConnect?: Answer; connect?: Answer } = {}) {
  const calls: string[] = [];
  let clock = 0;
  const probes: BindProbes = {
    async bind(host, port) {
      calls.push(`bind ${host}:${port}`);
      const result = o.bind?.(host, port) ?? (CHECK.forbidden.includes(port) ? "EPERM" : "bound");
      return result === "bound" ? { result, port: port || 45123 } : { result };
    },
    async ownConnect(host) {
      calls.push(`own ${host}`);
      return o.ownConnect?.(host, 0) ?? "connected";
    },
    async connect(host, port) {
      calls.push(`connect ${host}:${port}`);
      return o.connect?.(host, port) ?? "ECONNREFUSED";
    },
    tmp: () => "2049:131073",
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
  return { probes, calls };
}

test("the probe's words, both ways", () => {
  expect(bindCheckArgs(CHECK)).toEqual([
    "10002",
    "11999",
    "10000",
    "10001",
    "3000",
    "12000",
    "10000-11999",
    "41000",
    "41001",
  ]);
  expect(parseBindCheck(bindCheckArgs(CHECK))).toEqual(CHECK);
  expect(
    parseBindCheck(["10002", "11999", "0", "0", "3000", "12000", "10000-11999", "41000", "41001"])?.allowed,
  ).toEqual([0, 0, 3000, 12000]);
  for (const bad of [
    ["10002", "11999", "10000", "10001", "3000", "12000", "10000-11999", "41000"],
    ["0", "11999", "10000", "10001", "3000", "12000", "10000-11999", "41000", "41001"],
    ["10002", "11999", "10000", "10001", "3000", "12000", "11999-10000", "41000", "41001"],
    ["10002", "11999", "10000", "10001", "3000", "12000", "10000-11999", "41000", "70000"],
    ["10002", "11999", "10000", "x", "3000", "12000", "10000-11999", "41000", "41001"],
  ]) {
    expect(parseBindCheck(bad)).toBeNull();
  }
});

test("on 127.0.0.1 and ::1: others' pairs at both ends of the band refused, its own and a port on each side of the band bound, bind(0) outside the band, its own listener reached, root's refused", async () => {
  const k = kernel();
  expect(await verifyBrowserBindPolicy(CHECK, k.probes)).toBe("2049:131073");
  const each = (host: string) => [
    `bind ${host}:10002`,
    `bind ${host}:11999`,
    `bind ${host}:10000`,
    `bind ${host}:10001`,
    `bind ${host}:3000`,
    `bind ${host}:12000`,
    `bind ${host}:0`,
    `own ${host}`,
    `connect ${host}:${host === "::1" ? 41001 : 41000}`,
  ];
  expect(k.calls).toEqual([...each("127.0.0.1"), ...each("::1")]);
});

test("a port its browser already holds is skipped", async () => {
  const k = kernel();
  await verifyBrowserBindPolicy({ ...CHECK, allowed: [0, 10001, 3000, 12000] }, k.probes);
  expect(k.calls).not.toContain("bind 127.0.0.1:10000");
});

test("every way the isolation isn't there fails the check, before the worker starts", async () => {
  const check = (k: ReturnType<typeof kernel>) => verifyBrowserBindPolicy(CHECK, k.probes);
  /** The error, and whether it says the slice's policy isn't the one in force. */
  const failure = async (k: ReturnType<typeof kernel>) => {
    const err = (await check(k).catch((e: unknown) => e)) as Error;
    return [err.message, err instanceof PolicyNotInForce];
  };
  // Another agent's pair binds: no bind policy at all (a systemd without BPF_FRAMEWORK), or a narrower one still
  // enforced after the band grew.
  expect(await failure(kernel({ bind: () => "bound" }))).toEqual([
    "Browser bind isolation failed for 127.0.0.1:10002: bound",
    true,
  ]);
  const narrower: Answer = (_h, p) => (p === 10002 ? "EPERM" : "bound");
  expect(await failure(kernel({ bind: narrower }))).toEqual([
    "Browser bind isolation failed for 127.0.0.1:11999: bound",
    true,
  ]);
  // Its own pair taken by someone else: no proof either way.
  const taken: Answer = (_h, p) => (CHECK.forbidden.includes(p) ? "EPERM" : p === 10000 ? "EADDRINUSE" : "bound");
  expect(await failure(kernel({ bind: taken }))).toEqual([
    "Browser bind allow failed for 127.0.0.1:10000: EADDRINUSE",
    false,
  ]);
  // A wider band still enforced (the band narrowed): the port past its end is refused.
  const wider: Answer = (_h, p) => (CHECK.forbidden.includes(p) || p === 12000 ? "EPERM" : "bound");
  expect(await failure(kernel({ bind: wider }))).toEqual([
    "Browser bind allow failed for 127.0.0.1:12000: EPERM",
    true,
  ]);
  // bind(0) refused (as by the earlier runner's policy), or handed a port in the band (the ephemeral range moved).
  const noAny: Answer = (_h, p) => (CHECK.forbidden.includes(p) || p === 0 ? "EPERM" : "bound");
  expect(await failure(kernel({ bind: noAny }))).toEqual(["An agent's bind(0) failed on 127.0.0.1: EPERM", true]);
  const inBand = kernel();
  inBand.probes.bind = async (_h, p) =>
    CHECK.forbidden.includes(p) ? { result: "EPERM" } : { result: "bound", port: p || 11000 };
  expect(await failure(inBand)).toEqual(["bind(0) gave 127.0.0.1:11000, a reserved browser port", false]);
  // Root's listener let it in: the guard isn't holding.
  await expect(check(kernel({ connect: () => "connected" }))).rejects.toThrow(
    "An agent reached root's listener on 127.0.0.1:41000: the loopback guard isn't holding",
  );
});

test("root's listener refusing by reset, or never answering (drop), passes", async () => {
  for (const answer of ["ECONNREFUSED", "timeout", "EPERM"]) {
    expect(await verifyBrowserBindPolicy(CHECK, kernel({ connect: () => answer }).probes)).toBe("2049:131073");
  }
});

test("its own listener: tried again every 100 ms for 5 s (a new slice is mapped at the guard's next scan), then required", async () => {
  let tries = 0;
  const late = kernel({ ownConnect: () => (++tries < 4 ? "ECONNREFUSED" : "connected") });
  await verifyBrowserBindPolicy(CHECK, late.probes);
  expect(late.calls.filter((c) => c === "own 127.0.0.1")).toHaveLength(4);
  const never = kernel({ ownConnect: () => "timeout" });
  await expect(verifyBrowserBindPolicy(CHECK, never.probes)).rejects.toThrow(
    "An agent can't reach its own listener on 127.0.0.1: timeout",
  );
  expect(never.calls.filter((c) => c === "own 127.0.0.1")).toHaveLength(51);
});

test.if(process.platform !== "win32")(
  "the kernel probes themselves, here: bind(0) gives a port, its own listener is reached",
  async () => {
    const any = await kernelProbes.bind("127.0.0.1", 0);
    expect(any.result).toBe("bound");
    expect(any.port).toBeGreaterThan(0);
    expect(await kernelProbes.ownConnect("127.0.0.1", 1000)).toBe("connected");
  },
);

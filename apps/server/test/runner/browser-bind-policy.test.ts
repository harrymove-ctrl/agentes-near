import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { systemLauncher } from "../../runner/agent-users";
import { PolicyNotInForce } from "../../runner/browser-bind-check";
import {
  type BindPolicyOptions,
  conflictingBrowserPorts,
  ensureBrowserBindPolicy,
  prepareAgents,
  rootDecoys,
} from "../../runner/browser-bind-policy";
import type { RunCommand } from "../../runner/service";

/** A root-owned executable that is no link: `/usr/bin/true` is one where coreutils is a multicall binary (Ubuntu 26.04). */
const ROOT_TOOL = realpathSync("/usr/bin/true");

const user = { id: "agent-1", user: "ag-a1b2c3d4", uid: 20001 };
const runner = ["/usr/bin/bun", "/opt/agentes/runner.ts"];
const TMP = "2049:131073";
const SYSTEMD = "systemd 257 (257.9-1~deb13u1)\n+PAM +AUDIT +SELINUX +APPARMOR +IMA +SMACK +SECCOMP +BPF_FRAMEWORK";

/** The computer around the policy: what ran, in order, with the probe answering as a kernel that holds. */
function computer(
  o: {
    ss?: (scan: number) => string;
    fail?: string;
    probe?: string;
    /** The probe's exit code, by uid. */
    probeCode?: (uid: number) => number;
    tmp?: string | null;
    version?: string;
  } = {},
) {
  const calls: { file: string; args: string[] }[] = [];
  const order: string[] = [];
  let scans = 0;
  const run: RunCommand = (file, args) => {
    calls.push({ file, args });
    order.push(file === "systemctl" ? `systemctl ${args[0]}` : file);
    if (file === o.fail || args[0] === o.fail) return { code: 1, output: "denied" };
    if (file === "systemctl" && args[0] === "--version") return { code: 0, output: o.version ?? SYSTEMD };
    if (file === "ss") return { code: 0, output: o.ss?.(++scans) ?? "" };
    if (file === "/usr/bin/systemd-run") {
      const uid = Number(/--slice=agents-(\d+)\.slice/.exec(args.join(" "))?.[1]);
      const code = o.probeCode?.(uid) ?? 0;
      return { code, output: code ? "An agent's bind(0) failed on 127.0.0.1: EPERM" : (o.probe ?? `tmp ${TMP}`) };
    }
    return { code: 0, output: "" };
  };
  const decoys = { opened: 0, closed: 0 };
  const opts: BindPolicyOptions = {
    uidRange: [20000, 20999],
    run,
    systemd: true,
    refresh: () => order.push("refresh"),
    ephemeralRange: () => "32768 60999",
    decoys: () => {
      decoys.opened++;
      order.push("decoys");
      return { ports: [41000, 41001], close: () => decoys.closed++ };
    },
    folderId: (dir) => (/^\/run\/agentes-runner-tmp\/\d+\/tmp$/.test(dir) ? (o.tmp === undefined ? TMP : o.tmp) : null),
  };
  return { run, calls, order, decoys, opts };
}

test("the slice, the guard's map, a band-only deny, then the probe as every agent process starts", () => {
  const pc = computer({
    ss: () =>
      "LISTEN 0 0 127.0.0.1:10000 0.0.0.0:* uid:20000 ino:1 sk:0\n" +
      "LISTEN 0 0 127.0.0.1:3000 0.0.0.0:* uid:20005 ino:2 sk:0",
  });
  ensureBrowserBindPolicy(user, runner, pc.opts);
  expect(pc.order).toEqual([
    "systemctl --version",
    "systemctl start",
    "refresh",
    "systemctl set-property",
    "ss",
    "decoys",
    "/usr/bin/systemd-run",
    "ss",
  ]);
  expect(pc.calls[1]).toEqual({ file: "systemctl", args: ["start", "agents-20001.slice"] });
  // Only the band (the browser pairs of 20000-20999), its own pair excepted: bind(0) matches no rule with ports.
  expect(pc.calls[2]).toEqual({
    file: "systemctl",
    args: [
      "set-property",
      "--runtime",
      "agents-20001.slice",
      "SocketBindAllow=",
      "SocketBindAllow=tcp:10002-10003",
      "SocketBindDeny=",
      "SocketBindDeny=tcp:10000-11999",
    ],
  });
  const [launch, ...prefix] = systemLauncher(user, true).prefix;
  expect(pc.calls[4]).toEqual({
    file: launch as string,
    // Other agents' free pair ports at both ends of the band, its own pair, a free port below the band and one above
    // it, the band, root's two decoys.
    args: [
      ...prefix,
      ...runner,
      "bind-check",
      "10001",
      "11999",
      "10002",
      "10003",
      "3001",
      "12000",
      "10000-11999",
      "41000",
      "41001",
    ],
  });
  expect(pc.decoys).toEqual({ opened: 1, closed: 1 });
});

test("the default range: the whole of 10000-29999 is the band", () => {
  const pc = computer();
  ensureBrowserBindPolicy(user, runner, { ...pc.opts, uidRange: [20000, 29999] });
  expect(pc.calls[2]?.args.at(-1)).toBe("SocketBindDeny=tcp:10000-29999");
  expect(pc.calls[4]?.args.slice(-8)).toEqual([
    "29999",
    "10002",
    "10003",
    "3000",
    "30000",
    "10000-29999",
    "41000",
    "41001",
  ]);
});

test("its own port a browser already holds is skipped in the probe", () => {
  const pc = computer({ ss: () => "LISTEN 0 0 127.0.0.1:10002 0.0.0.0:* uid:20001" });
  ensureBrowserBindPolicy(user, runner, pc.opts);
  expect(pc.calls[4]?.args.slice(-9)).toEqual([
    "10000",
    "11999",
    "0",
    "10003",
    "3000",
    "12000",
    "10000-11999",
    "41000",
    "41001",
  ]);
});

test("every failure refuses the launch, and root's decoys always close", () => {
  for (const fail of ["start", "set-property", "ss", "/usr/bin/systemd-run"]) {
    const pc = computer({ fail });
    expect(() => ensureBrowserBindPolicy(user, runner, pc.opts)).toThrow();
    expect(pc.decoys.opened).toBe(pc.decoys.closed);
  }
  expect(() => ensureBrowserBindPolicy(user, runner, { ...computer().opts, systemd: false })).toThrow(
    "require systemd",
  );
  // Ubuntu's systemd ignores SocketBind*: refused before anything is set.
  const ubuntu = computer({ version: "systemd 255 (255.4-1ubuntu8.18)\n+PAM +AUDIT -BPF_FRAMEWORK" });
  expect(() => ensureBrowserBindPolicy(user, runner, ubuntu.opts)).toThrow("systemd built with BPF_FRAMEWORK");
  expect(ubuntu.order).toEqual(["systemctl --version"]);
  // bind(0) could land in the band: an ephemeral range read again at each start.
  expect(() =>
    ensureBrowserBindPolicy(user, runner, { ...computer().opts, ephemeralRange: () => "11000 60999" }),
  ).toThrow("overlaps reserved browser ports 10000-11999");
});

test("a probe that finds another policy still in force says so, for the start to re-execute systemd", () => {
  const pc = computer({ probeCode: () => 3 });
  const err = (() => {
    try {
      ensureBrowserBindPolicy(user, runner, pc.opts);
    } catch (e) {
      return e as Error;
    }
  })();
  expect(err).toBeInstanceOf(PolicyNotInForce);
  expect(err?.message).toBe(
    "Agent 20001's isolation doesn't hold in agents-20001.slice: An agent's bind(0) failed on 127.0.0.1: EPERM (systemd still enforces an earlier bind policy there, until systemctl daemon-reexec or a restart)",
  );
  expect(pc.decoys.opened).toBe(pc.decoys.closed);
  // Any other failure of the probe is just that.
  expect(() => ensureBrowserBindPolicy(user, runner, computer({ probeCode: () => 1 }).opts)).toThrow(
    new Error(
      "Agent 20001's isolation doesn't hold in agents-20001.slice: An agent's bind(0) failed on 127.0.0.1: EPERM",
    ),
  );
});

test("at the runner's start: every agent's policy, then each probe; one that fails is left out, the others serve", () => {
  const ana = { id: "agent-1", user: "ag-aaaaaaaa", uid: 20001 };
  const bia = { id: "agent-2", user: "ag-bbbbbbbb", uid: 20002 };
  const cid = { id: "agent-3", user: "ag-cccccccc", uid: 20003 };
  const pc = computer({ probeCode: (uid) => (uid === 20002 ? 1 : 0) });
  const logs: string[] = [];
  const prepared: number[] = [];
  prepareAgents(
    [ana, bia, cid],
    (u) => {
      ensureBrowserBindPolicy(u, runner, pc.opts);
      prepared.push(u.uid);
    },
    pc.opts,
    (line) => logs.push(line),
  );
  const sets = pc.calls.flatMap((c, i) => (c.args[0] === "set-property" ? [[i, c.args[2]]] : []));
  const firstProbe = pc.calls.findIndex((c) => c.file === "/usr/bin/systemd-run");
  // Every slice has its policy before the first probe runs.
  expect(sets.slice(0, 3).map(([, slice]) => slice)).toEqual([
    "agents-20001.slice",
    "agents-20002.slice",
    "agents-20003.slice",
  ]);
  expect(sets.slice(0, 3).every(([i]) => (i as number) < firstProbe)).toBe(true);
  expect(prepared).toEqual([20001, 20003]);
  expect(logs).toEqual([
    "couldn't prepare ag-bbbbbbbb: Agent 20002's isolation doesn't hold in agents-20002.slice: An agent's bind(0) failed on 127.0.0.1: EPERM",
  ]);
  expect(pc.order).not.toContain("systemctl daemon-reexec");
});

test("at the runner's start, slices still under an earlier policy: systemd re-executed once for all, then probed again", () => {
  const stale = new Set([20001, 20002]);
  const pc = computer({ probeCode: (uid) => (stale.has(uid) ? 3 : 0) });
  const run = pc.opts.run as RunCommand;
  const opts: BindPolicyOptions = {
    ...pc.opts,
    run: (file, args) => {
      const r = run(file, args);
      if (args[0] === "daemon-reexec") stale.clear();
      return r;
    },
  };
  const users = [20001, 20002, 20003].map((uid) => ({ id: `agent-${uid}`, user: `ag-0000${uid}`, uid }));
  const logs: string[] = [];
  const prepared: number[] = [];
  prepareAgents(
    users,
    (u) => {
      ensureBrowserBindPolicy(u, runner, opts);
      prepared.push(u.uid);
    },
    opts,
    (line) => logs.push(line),
  );
  expect(pc.order.filter((step) => step === "systemctl daemon-reexec")).toHaveLength(1);
  expect(prepared).toEqual([20003, 20001, 20002]);
  expect(logs).toEqual([
    "systemd still enforces an earlier bind policy for ag-000020001, ag-000020002: re-executing it",
  ]);
  // Still not in force after it: left out like any other failure.
  const stuck = computer({ probeCode: (uid) => (uid === 20001 ? 3 : 0) });
  const stuckLogs: string[] = [];
  prepareAgents(
    [users[0] as (typeof users)[0]],
    (u) => ensureBrowserBindPolicy(u, runner, stuck.opts),
    stuck.opts,
    (line) => stuckLogs.push(line),
  );
  expect(stuck.order.filter((step) => step === "systemctl daemon-reexec")).toHaveLength(1);
  expect(stuckLogs.at(-1)).toStartWith("couldn't prepare ag-000020001: Agent 20001's isolation doesn't hold");
});

test("the probe's /tmp must be the agent's own folder", () => {
  for (const [probe, tmp, why] of [
    ["tmp 2049:2", TMP, "Agent 20001's /tmp isn't its own (2049:2, its folder 2049:131073)"],
    ["", TMP, "Agent 20001's /tmp isn't its own (not said, its folder 2049:131073)"],
    [`tmp ${TMP}`, null, `Agent 20001's /tmp isn't its own (${TMP}, its folder missing)`],
  ] as const) {
    expect(() => ensureBrowserBindPolicy(user, runner, computer({ probe, tmp }).opts)).toThrow(why);
  }
});

test("a reserved browser port held by another uid fails before or after the kernel probe", () => {
  for (const onScan of [1, 2]) {
    const pc = computer({
      ss: (scan) => (scan === onScan ? "LISTEN 0 0 127.0.0.1:10002 0.0.0.0:* uid:20005 ino:1 sk:0" : ""),
    });
    expect(() => ensureBrowserBindPolicy(user, runner, pc.opts)).toThrow("wrong listener owner");
  }
});

test.if(process.platform !== "win32")("namespace diagnostics use the same launcher as the agent bind check", () => {
  const pc = computer();
  const hook = ROOT_TOOL;
  ensureBrowserBindPolicy({ ...user, networkLauncher: hook }, runner, pc.opts);
  const look = pc.calls.filter((c) => c.file === hook);
  expect(look).toHaveLength(2);
  expect(look[0]?.args).toEqual([String(user.uid), "--", "/usr/bin/ss", "-Htln", "-e"]);
  const args = pc.calls.find((c) => c.file === "/usr/bin/systemd-run")?.args ?? [];
  expect(args.slice(args.indexOf(hook), args.indexOf(hook) + 6)).toEqual([
    hook,
    String(user.uid),
    "--",
    "/usr/sbin/runuser",
    "-u",
    user.user,
  ]);
});

test("a listener on a browser port must be its owner's: only that agent's pair is looked at", () => {
  const ss = [
    "LISTEN 0 0 127.0.0.1:10002 0.0.0.0:* uid:20001",
    "LISTEN 0 0 [::1]:10003 [::]:* uid:20004",
    "LISTEN 0 0 127.0.0.1:10004 0.0.0.0:* uid:20001",
    "ESTAB 0 0 127.0.0.1:10003 127.0.0.1:5000 uid:20004",
  ].join("\n");
  expect(conflictingBrowserPorts(ss, [20001, 20001])).toEqual([10003]);
  expect(conflictingBrowserPorts(ss, [20000, 20999])).toEqual([10003, 10004]);
});

test("root's decoys: bound before Bun.listen returns, and a handshake completes while root waits on the probe", () => {
  const decoys = rootDecoys();
  const connect = (host: string, port: number) =>
    spawnSync(
      process.execPath,
      [
        "-e",
        `Bun.connect({ hostname: ${JSON.stringify(host)}, port: ${port}, socket: { open() { console.log("connected"); process.exit(0) }, data() {}, connectError() { console.log("refused"); process.exit(0) } } })`,
      ],
      { encoding: "utf8", timeout: 10_000 },
    ).stdout.trim();
  try {
    expect(decoys.ports.every((p) => p > 0)).toBe(true);
    // This process's event loop is blocked in spawnSync, as root's is in the probe: the kernel still accepts.
    expect(connect("127.0.0.1", decoys.ports[0])).toBe("connected");
    expect(connect("::1", decoys.ports[1])).toBe("connected");
  } finally {
    decoys.close();
  }
  expect(connect("127.0.0.1", decoys.ports[0])).toBe("refused");
});

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import type { EventEmitter } from "node:events";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  type AgentUser,
  AgentUsers,
  adbServerPort,
  agentGid,
  agentSubids,
  readAgentUsers,
  systemLauncher,
} from "../../runner/agent-users";
import {
  applyBindPolicy,
  type BindPolicyOptions,
  ensureBrowserBindPolicy,
  prepareAgents,
} from "../../runner/browser-bind-policy";
import { browserBand, browserPortsForUid } from "../../runner/browser-ports";
import { LoopbackGuard, RUNNER_NFT_TABLE } from "../../runner/loopback-guard";
import {
  AGENT_RAM_ROOT,
  AGENT_TMP_CLEANUP,
  AGENT_TMP_ROOT,
  agentCgroup,
  agentSlice,
  agentTmp,
  runSync,
} from "../../runner/service";

/**
 * System mode's isolation on a real Linux computer, as root: real agent users and slices, the runner's loopback
 * table and bind policy, and what each agent's processes reach, on 127.0.0.1 and ::1. It changes the computer it
 * runs on (users, slices, nftables, a bridge and a network namespace, systemd re-executed), so it runs only with
 * AGENTES_ROOT_TESTS=1: in CI's isolation-root job, or on a disposable VM. AGENTES_TEST_RUNNER is the runner bundle
 * the agents' bind check runs. Where Gradle, Kotlin, adb, Chrome and Xtigervnc are installed, two agents also run
 * them at once, and the abstract Unix sockets they hold are looked at.
 */
const ROOT = process.platform === "linux" && process.getuid?.() === 0 && process.env.AGENTES_ROOT_TESTS === "1";

setDefaultTimeout(120_000);

/** The Cloud's range: its browser pairs, the band, are ports 10000-11999. */
const RANGE: [number, number] = [20000, 20999];
const HOME = "/var/lib/agentes-isolation-test";
/** Where the agents' users can run Bun and the runner bundle from (a CI checkout's home isn't theirs to read). */
const OPT = "/opt/agentes-isolation-test";
const RUNNER = [path.join(OPT, "bun"), path.join(OPT, "agentes-runner.mjs")];
const PYTHON = "/usr/bin/python3";
const HOSTS = ["127.0.0.1", "::1"];
/** Root's stand-in resolver, on a loopback address of its own (127.0.0.53 may be systemd-resolved's). */
const DNS = "127.0.0.7";
const GUEST = { ns: "agentes-guest", bridge: "agentes-br", veth: "agentes-veth", ip: "10.99.0.2", host: "10.99.0.1" };

/** One socket operation, as whoever runs it; prints its outcome (an errno's name on failure). */
const PY = `
import errno, os, socket, struct, sys
def err(e):
    return errno.errorcode.get(e.errno, type(e).__name__) if isinstance(e, OSError) and e.errno else type(e).__name__
mode = sys.argv[1]
if mode in ("connect", "bind", "listen", "udp-listen", "udp-send", "udplite-listen", "udplite-send"):
    host, port = sys.argv[2], int(sys.argv[3])
    fam = socket.AF_INET6 if ":" in host else socket.AF_INET
if mode == "connect":
    s = socket.socket(fam, socket.SOCK_STREAM)
    s.settimeout(3)
    try:
        s.connect((host, port))
        print("connected")
    except socket.timeout:
        print("timeout")
    except OSError as e:
        print(err(e))
elif mode == "bind":
    s = socket.socket(fam, socket.SOCK_STREAM)
    try:
        s.bind((host, port))
        print("bound", s.getsockname()[1])
    except OSError as e:
        print(err(e))
elif mode == "listen":
    s = socket.socket(fam, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        s.bind((host, port))
        s.listen(64)
    except OSError as e:
        print(err(e), flush=True)
        sys.exit(1)
    print(s.getsockname()[1], flush=True)
    while True:
        c, _ = s.accept()
        c.close()
elif mode in ("udp-listen", "udplite-listen"):
    proto = socket.IPPROTO_UDPLITE if mode == "udplite-listen" else 0
    try:
        s = socket.socket(fam, socket.SOCK_DGRAM, proto)
        s.bind((host, port))
    except OSError as e:
        print(err(e), flush=True)
        sys.exit(1)
    print(s.getsockname()[1], flush=True)
    while True:
        data, _ = s.recvfrom(256)
        print(data.decode(), flush=True)
elif mode in ("udp-send", "udplite-send"):
    proto = socket.IPPROTO_UDPLITE if mode == "udplite-send" else 0
    try:
        s = socket.socket(fam, socket.SOCK_DGRAM, proto)
        s.sendto(sys.argv[4].encode(), (host, port))
        print("sent")
    except OSError as e:
        print(err(e))
elif mode == "unix-listen":
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.bind(sys.argv[2])
    os.chmod(sys.argv[2], 0o777)
    s.listen(8)
    print(0, flush=True)
    while True:
        c, _ = s.accept()
        c.close()
elif mode == "unix-connect":
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        s.connect(sys.argv[2])
        print("connected")
    except OSError as e:
        print(err(e))
elif mode == "abstract-listen":
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        s.bind("\\0" + sys.argv[2])
        s.listen(8)
    except OSError as e:
        print(err(e), flush=True)
        sys.exit(1)
    print(0, flush=True)
    while True:
        c, _ = s.accept()
        c.close()
elif mode == "x11":
    # An X11 connection setup on the abstract socket, with a cookie or none: the server's first byte says.
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(5)
    try:
        s.connect("\\0" + sys.argv[2])
    except OSError as e:
        print(err(e))
        sys.exit(0)
    name = b"MIT-MAGIC-COOKIE-1" if len(sys.argv) > 3 else b""
    data = bytes.fromhex(sys.argv[3]) if len(sys.argv) > 3 else b""
    pad = lambda b: b + b"\\0" * (-len(b) % 4)
    s.sendall(struct.pack("<cxHHHHxx", b"l", 11, 0, len(name), len(data)) + pad(name) + pad(data))
    reply = s.recv(8)
    print({0: "failed", 1: "success", 2: "authenticate"}.get(reply[0] if reply else -1, "closed"))
`;

/** systemd here can enforce the bind policy (`SocketBindDeny=`); Ubuntu's can't. */
const BPF = ROOT && /\+BPF_FRAMEWORK/.test(runSync("systemctl", ["--version"]).output);
const has = (file: string) => ROOT && existsSync(file);
/** GitHub's Android SDK, or Debian's package. */
const ADB = ["/usr/local/lib/android/sdk/platform-tools/adb", "/usr/bin/adb"].find(has) ?? "/usr/bin/adb";
const GRADLE = "/usr/bin/gradle";
const CHROME = "/usr/bin/google-chrome";
const XVNC = "/usr/bin/Xtigervnc";
const XAUTH = "/usr/bin/xauth";

let users: AgentUsers;
let A: AgentUser;
let B: AgentUser;
/** The third agent: the in-place upgrade's. */
let C: AgentUser | undefined;
let guard: LoopbackGuard;
let policy: BindPolicyOptions;
const running: ChildProcess[] = [];

/** `argv` as `user` through its launcher (its slice, its own /tmp, its user, its environment), or as root (null). */
function launch(user: AgentUser | null, argv: string[]) {
  if (!user) return { argv, env: { ...process.env } as Record<string, string> };
  const l = systemLauncher(user);
  return { argv: [...l.prefix, ...argv], env: l.env };
}

function runAs(user: AgentUser | null, argv: string[], timeout = 30_000) {
  const c = launch(user, argv);
  const r = spawnSync(c.argv[0] as string, c.argv.slice(1), { cwd: "/", env: c.env, encoding: "utf8", timeout });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

const lastLine = (out: string) => out.trim().split("\n").at(-1) ?? "";

/** A probe's outcome: the last line it printed. */
function probe(user: AgentUser | null, ...args: string[]): string {
  const { argv, env } = launch(user, [PYTHON, "-c", PY, ...args]);
  const r = spawnSync(argv[0] as string, argv.slice(1), { cwd: "/", env, encoding: "utf8", timeout: 30_000 });
  return lastLine(r.stdout ?? "") || `nothing (${(r.stderr ?? "").trim().slice(0, 300)})`;
}

/** As `runuser -u <name>` alone, the way cron or at start it: outside every agent's slice. */
function probeOutside(name: string, ...args: string[]): string {
  const r = spawnSync("/usr/sbin/runuser", ["-u", name, "--", PYTHON, "-c", PY, ...args], {
    cwd: "/",
    encoding: "utf8",
    timeout: 30_000,
  });
  return lastLine(r.stdout ?? "") || `nothing (${(r.stderr ?? "").trim().slice(0, 300)})`;
}

async function until(cond: () => boolean, ms: number) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

/** A process held running (`argv` as `user`, or as root), and the lines it printed. */
async function hold(user: AgentUser | null, argv: string[], ready: (lines: string[]) => boolean) {
  const c = launch(user, argv);
  const child = spawn(c.argv[0] as string, c.argv.slice(1), {
    cwd: "/",
    env: c.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  running.push(child);
  const lines: string[] = [];
  let rest = "";
  const take = (chunk: string) => {
    const parts = (rest + chunk).split("\n");
    rest = parts.pop() ?? "";
    lines.push(...parts);
  };
  child.stdout?.setEncoding("utf8").on("data", take);
  child.stderr?.setEncoding("utf8").on("data", take);
  await until(() => ready(lines), 30_000).catch((err: Error) => {
    throw new Error(`${err.message}: ${argv[0]} said ${JSON.stringify([...lines, rest].slice(-15))}`);
  });
  return lines;
}

/** A listener held by a process of `user`'s (null: root's): its port, and what it received after it. */
async function serve(user: AgentUser | null, ...args: string[]): Promise<{ port: number; lines: string[] }> {
  const lines = await hold(user, [PYTHON, "-u", "-c", PY, ...args], (l) => l.length > 0);
  const port = Number(lines[0]);
  if (!Number.isInteger(port)) throw new Error(`no listener for ${args.join(" ")}: ${lines[0]}`);
  return { port, lines };
}

/** Root's stand-in resolver on 127.0.0.7:53, TCP and UDP (started once): what it received over UDP. */
let resolver: Promise<string[]> | null = null;
const dnsStandIn = () => {
  resolver ??= serve(null, "listen", DNS, "53").then(() => serve(null, "udp-listen", DNS, "53").then((u) => u.lines));
  return resolver;
};

const must = (file: string, args: string[]) => {
  const r = runSync(file, args);
  if (r.code !== 0) throw new Error(`${file} ${args.join(" ")}: ${r.output}`);
  return r.output;
};

const nft = (text: string) => {
  const file = path.join(HOME, "test.nft");
  writeFileSync(file, text);
  must("nft", ["-f", file]);
};

/** Root's own address on its way out (the runner's eth0, the VM's NIC). */
const hostAddress = () => /\bsrc (\S+)/.exec(must("ip", ["-4", "route", "get", "1.1.1.1"]))?.[1] ?? "";

/** How many socket-bind programs (IPv4's) are attached to `user`'s slice; null without bpftool. */
function bindPrograms(user: AgentUser): number | null {
  const r = runSync("bpftool", ["cgroup", "show", agentCgroup(user.uid)]);
  return r.code === 0 ? r.output.split("\n").filter((line) => /\bcgroup_inet4_bind\b/.test(line)).length : null;
}

/**
 * The abstract Unix socket names (`@…`) the processes in `user`'s slice listen on, each with the program that
 * holds it: abstract names belong to the network namespace, so every agent reaches them.
 */
function abstractListeners(user: AgentUser): string[] {
  const names = new Map<string, string>();
  for (const line of readFileSync("/proc/net/unix", "utf8").split("\n").slice(1)) {
    const [, , , flags, , , inode, name] = line.trim().split(/\s+/);
    // __SO_ACCEPTCON: listening.
    if (flags === "00010000" && inode && name?.startsWith("@")) names.set(inode, name);
  }
  const held = new Set<string>();
  for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
    try {
      if (!readFileSync(`/proc/${pid}/cgroup`, "utf8").includes(`/${agentSlice(user.uid)}/`)) continue;
      const comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
      for (const fd of readdirSync(`/proc/${pid}/fd`)) {
        const inode = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`))?.[1];
        const name = inode && names.get(inode);
        if (name) held.add(`${name} (${comm})`);
      }
    } catch {
      // gone meanwhile
    }
  }
  return [...held].sort();
}

describe.if(ROOT)("the agents' isolation on this computer, as root", () => {
  beforeAll(() => {
    rmSync(HOME, { recursive: true, force: true });
    mkdirSync(HOME, { recursive: true, mode: 0o700 });
    mkdirSync(OPT, { recursive: true, mode: 0o755 });
    chmodSync(OPT, 0o755);
    copyFileSync(realpathSync(process.execPath), RUNNER[0] as string);
    chmodSync(RUNNER[0] as string, 0o755);
    copyFileSync(process.env.AGENTES_TEST_RUNNER ?? "", RUNNER[1] as string);
    chmodSync(RUNNER[1] as string, 0o644);
    users = new AgentUsers({ home: HOME, range: RANGE });
    A = users.ensure({ id: "a0000000-0000-4000-8000-000000000001", handle: "a", name: "Agent A" });
    B = users.ensure({ id: "b0000000-0000-4000-8000-000000000002", handle: "b", name: "Agent B" });
    guard = new LoopbackGuard({
      home: HOME,
      agentUids: () => readAgentUsers(HOME).map((u) => u.uid),
      uidRange: RANGE,
      log: (line) => console.log(`guard: ${line}`),
    });
    // The real start: modules, every agent's slice, the table. Then each case says when the guard looks again.
    guard.start();
    guard.stop();
    policy = { uidRange: RANGE, refresh: () => void guard.reconcile() };
    if (BPF) for (const u of [A, B]) ensureBrowserBindPolicy(u, RUNNER, policy);
    console.log(`agents ${A.uid} and ${B.uid}; bind policy ${BPF ? "on" : "not enforced by this systemd"}`);
  });

  afterAll(() => {
    for (const child of running) child.kill("SIGTERM");
    guard?.stop();
    for (const table of [`inet ${RUNNER_NFT_TABLE}`, "inet agentes_test_notrack", "ip agentes_test_dnat"]) {
      runSync("nft", ["delete", "table", ...table.split(" ")]);
    }
    runSync("ip", ["link", "del", GUEST.bridge]);
    runSync("ip", ["link", "del", GUEST.veth]);
    runSync("ip", ["netns", "del", GUEST.ns]);
    for (const u of [A, B, C]) {
      if (!u) continue;
      runSync("systemctl", ["stop", agentSlice(u.uid)]);
      runSync("userdel", ["-r", u.user]);
      runSync("umount", ["-l", path.join(AGENT_RAM_ROOT, String(u.uid))]);
      rmSync(path.join(AGENT_RAM_ROOT, String(u.uid)), { recursive: true, force: true });
      rmSync(path.join(AGENT_TMP_ROOT, String(u.uid)), { recursive: true, force: true });
    }
    rmSync(HOME, { recursive: true, force: true });
    rmSync(OPT, { recursive: true, force: true });
  });

  test("1. an agent's listen(0) binds outside the band, and it reaches it", async () => {
    const [first, last] = browserBand(RANGE);
    for (const host of HOSTS) {
      const own = await serve(A, "listen", host, "0");
      expect(own.port < first || own.port > last).toBe(true);
      expect(probe(A, "connect", host, String(own.port))).toBe("connected");
    }
  });

  test("2. a new listener is its owner's at once: another agent is refused before any scan", async () => {
    for (const host of HOSTS) {
      const own = await serve(A, "listen", host, "45000");
      expect(probe(A, "connect", host, String(own.port))).toBe("connected");
      expect(probe(B, "connect", host, String(own.port))).toBe("ECONNREFUSED");
    }
  });

  test("3. one port number, two agents on different addresses: each reaches only its own", async () => {
    await serve(A, "listen", "127.0.0.1", "45100");
    await serve(B, "listen", "127.0.0.2", "45100");
    await serve(B, "listen", "::1", "45100");
    expect(probe(A, "connect", "127.0.0.1", "45100")).toBe("connected");
    expect(probe(B, "connect", "127.0.0.1", "45100")).toBe("ECONNREFUSED");
    expect(probe(B, "connect", "127.0.0.2", "45100")).toBe("connected");
    expect(probe(A, "connect", "127.0.0.2", "45100")).toBe("ECONNREFUSED");
    expect(probe(B, "connect", "::1", "45100")).toBe("connected");
    expect(probe(A, "connect", "::1", "45100")).toBe("ECONNREFUSED");
  });

  test("4. another agent's browser port can't be bound; the Kotlin daemon's 17001 can, with the Cloud's range", () => {
    const { cdp } = browserPortsForUid(B.uid);
    for (const host of HOSTS) {
      if (BPF) expect(probe(A, "bind", host, String(cdp))).toBe("EPERM");
      expect(probe(A, "bind", host, "17001")).toBe("bound 17001");
    }
  });

  test("5. an agent's browser port: root gets in, another agent doesn't", async () => {
    const { cdp } = browserPortsForUid(A.uid);
    for (const host of HOSTS) {
      await serve(A, "listen", host, String(cdp));
      expect(probe(B, "connect", host, String(cdp))).toBe("ECONNREFUSED");
      expect(probe(null, "connect", host, String(cdp))).toBe("connected");
    }
  });

  test("6. root's own listeners refuse agents; another local user stays out of an agent's", async () => {
    for (const host of HOSTS) {
      const root = await serve(null, "listen", host, "0");
      expect(probe(A, "connect", host, String(root.port))).toBe("ECONNREFUSED");
      expect(probeOutside("nobody", "connect", host, String(root.port))).toBe("connected");
      const own = await serve(A, "listen", host, "0");
      expect(probeOutside("nobody", "connect", host, String(own.port))).toBe("ECONNREFUSED");
    }
  });

  test("7. DNS on this computer stays open to agents, over TCP and UDP", async () => {
    const received = await dnsStandIn();
    expect(probe(A, "connect", DNS, "53")).toBe("connected");
    expect(probe(A, "udp-send", DNS, "53", "query-a")).toBe("sent");
    await until(() => received.includes("query-a"), 3000);
  });

  test("8. UDP: only the agent's own datagrams reach its socket", async () => {
    for (const host of HOSTS) {
      const own = await serve(A, "udp-listen", host, "0");
      probe(B, "udp-send", host, String(own.port), "from-b");
      expect(probe(A, "udp-send", host, String(own.port), "from-a")).toBe("sent");
      await until(() => own.lines.includes("from-a"), 3000);
      await Bun.sleep(300);
      expect(own.lines.slice(1)).toEqual(["from-a"]);
    }
  });

  test("9. a setuid-root program an agent runs is still that agent", async () => {
    const suid = path.join(OPT, "python3-suid");
    copyFileSync(realpathSync(PYTHON), suid);
    chmodSync(suid, 0o4755);
    const mine = await serve(A, "listen", "127.0.0.1", "0");
    const theirs = await serve(B, "listen", "127.0.0.1", "0");
    const roots = await serve(null, "listen", "127.0.0.1", "0");
    const asRoot = (port: number) => lastLine(runAs(A, [suid, "-c", PY, "connect", "127.0.0.1", String(port)]).out);
    expect(asRoot(mine.port)).toBe("connected");
    expect(asRoot(theirs.port)).toBe("ECONNREFUSED");
    expect(asRoot(roots.port)).toBe("ECONNREFUSED");
  });

  test("10. an agent's user outside its slice (cron, at) owns nothing: refused at its own listener, DNS still works", async () => {
    const own = await serve(A, "listen", "127.0.0.1", "0");
    expect(probeOutside(A.user, "connect", "127.0.0.1", String(own.port))).toBe("ECONNREFUSED");
    await dnsStandIn();
    expect(probeOutside(A.user, "connect", DNS, "53")).toBe("connected");
  });

  test("11. a slice made anew is mapped before its first process: its own listener at once", async () => {
    must("systemctl", ["stop", agentSlice(A.uid)]);
    if (BPF) ensureBrowserBindPolicy(A, RUNNER, policy);
    else {
      must("systemctl", ["start", agentSlice(A.uid)]);
      guard.reconcile();
    }
    for (const host of HOSTS) {
      const own = await serve(A, "listen", host, "0");
      expect(probe(A, "connect", host, String(own.port))).toBe("connected");
      expect(probe(B, "connect", host, String(own.port))).toBe("ECONNREFUSED");
    }
  });

  test("12. the table deleted by hand is back at the guard's next look", async () => {
    const own = await serve(A, "listen", "127.0.0.1", "0");
    must("nft", ["delete", "table", "inet", RUNNER_NFT_TABLE]);
    expect(probe(B, "connect", "127.0.0.1", String(own.port))).toBe("connected");
    expect(guard.reconcile()).toBe(true);
    expect(probe(B, "connect", "127.0.0.1", String(own.port))).toBe("ECONNREFUSED");
    expect(probe(A, "connect", "127.0.0.1", String(own.port))).toBe("connected");
  });

  test("13. loopback traffic made untracked: agents are refused, root isn't", async () => {
    const own = await serve(A, "listen", "127.0.0.1", "0");
    const roots = await serve(null, "listen", "127.0.0.1", "0");
    nft(`table inet agentes_test_notrack {
  chain pre { type filter hook prerouting priority raw; iif "lo" notrack; }
  chain out { type filter hook output priority raw; oif "lo" notrack; }
}
`);
    try {
      expect(probe(A, "connect", "127.0.0.1", String(own.port))).toBe("ECONNREFUSED");
      expect(probe(null, "connect", "127.0.0.1", String(roots.port))).toBe("connected");
    } finally {
      must("nft", ["delete", "table", "inet", "agentes_test_notrack"]);
    }
    expect(probe(A, "connect", "127.0.0.1", String(own.port))).toBe("connected");
  });

  test("14. a container's network on this computer: refused but for what is published beyond it", async () => {
    const host = hostAddress();
    for (const args of [
      ["netns", "add", GUEST.ns],
      ["link", "add", GUEST.bridge, "type", "bridge"],
      ["link", "add", GUEST.veth, "type", "veth", "peer", "name", `${GUEST.veth}-g`],
      ["link", "set", GUEST.veth, "master", GUEST.bridge],
      ["link", "set", `${GUEST.veth}-g`, "netns", GUEST.ns],
      ["addr", "add", `${GUEST.host}/24`, "dev", GUEST.bridge],
      ["link", "set", GUEST.bridge, "up"],
      ["link", "set", GUEST.veth, "up"],
      ["-n", GUEST.ns, "addr", "add", `${GUEST.ip}/24`, "dev", `${GUEST.veth}-g`],
      ["-n", GUEST.ns, "link", "set", `${GUEST.veth}-g`, "up"],
      ["-n", GUEST.ns, "link", "set", "lo", "up"],
      ["-n", GUEST.ns, "route", "add", "default", "via", GUEST.host],
    ]) {
      must("ip", args);
    }
    must("sysctl", ["-qw", `net.ipv4.conf.${GUEST.bridge}.route_localnet=1`]);
    nft(`table ip agentes_test_dnat {
  chain out {
    type nat hook output priority dstnat;
    ip daddr ${host} tcp dport 15432 dnat to ${GUEST.ip}:5432
    ip daddr 127.0.0.1 tcp dport 15433 dnat to ${GUEST.ip}:5432
  }
  chain post { type nat hook postrouting priority srcnat; ip daddr ${GUEST.ip} ip saddr 127.0.0.0/8 masquerade; }
}
`);
    await hold(null, ["ip", "netns", "exec", GUEST.ns, PYTHON, "-u", "-c", PY, "listen", GUEST.ip, "5432"], (l) =>
      l.includes("5432"),
    );
    expect(probe(null, "connect", GUEST.ip, "5432")).toBe("connected");
    expect(probe(null, "connect", "127.0.0.1", "15433")).toBe("connected");
    expect(probe(A, "connect", GUEST.ip, "5432")).toBe("ECONNREFUSED");
    expect(probe(A, "connect", host, "15432")).toBe("connected");
    expect(probe(A, "connect", "127.0.0.1", "15433")).toBe("ECONNREFUSED");
  });

  test("15. no other protocol across lo for an agent (UDP-Lite here)", async () => {
    const roots = await serve(null, "udplite-listen", "127.0.0.1", "0").catch(() => null);
    if (!roots) return console.log("no UDP-Lite in this kernel: nothing to send it with");
    expect(probe(null, "udplite-send", "127.0.0.1", String(roots.port), "from-root")).toBe("sent");
    await until(() => roots.lines.includes("from-root"), 3000);
    probe(A, "udplite-send", "127.0.0.1", String(roots.port), "from-a");
    await Bun.sleep(300);
    expect(roots.lines.slice(1)).toEqual(["from-root"]);
  });

  test.if(BPF)("16. the bind check passes for both agents, with reject and with drop", () => {
    for (const u of [A, B]) ensureBrowserBindPolicy(u, RUNNER, policy);
    const dropping = new LoopbackGuard({
      home: HOME,
      agentUids: () => readAgentUsers(HOME).map((u) => u.uid),
      uidRange: RANGE,
      log: (line) => console.log(`guard (drop): ${line}`),
      reject: false,
    });
    dropping.start();
    dropping.stop();
    try {
      for (const u of [A, B])
        ensureBrowserBindPolicy(u, RUNNER, { uidRange: RANGE, refresh: () => void dropping.reconcile() });
    } finally {
      must("nft", ["delete", "table", "inet", RUNNER_NFT_TABLE]);
      expect(guard.reconcile()).toBe(true);
    }
  });

  test("17. each agent's /tmp and /dev/shm are its own: its sockets there are out of other agents' reach", async () => {
    for (const dir of ["/tmp", "/dev/shm"]) {
      const sock = path.join(dir, "agentes-isolation-a.sock");
      await serve(A, "unix-listen", sock);
      expect(probe(A, "unix-connect", sock)).toBe("connected");
      expect(probe(B, "unix-connect", sock)).toBe("ENOENT");
      expect(existsSync(sock)).toBe(false);
    }
    expect(existsSync(path.join(agentTmp(A.uid), "agentes-isolation-a.sock"))).toBe(true);
    expect(runAs(B, ["/bin/ls", "-a", "/tmp"]).out).not.toContain("agentes-isolation-a.sock");
    // Nor by the socket's own absolute path on the computer: the tmpfs root is root-owned and 0700, so another
    // agent can't traverse into it even knowing the path.
    expect(probe(B, "unix-connect", path.join(agentTmp(A.uid), "agentes-isolation-a.sock"))).toBe("EACCES");
    // In memory as the computer's are, on a tmpfs of the agent's own; /var/tmp on disk as the computer's is.
    expect(runSync("findmnt", ["-n", "-o", "FSTYPE", path.join(AGENT_RAM_ROOT, String(A.uid))]).output).toBe("tmpfs");
    expect(runAs(A, ["/usr/bin/stat", "-f", "-c", "%T", "/tmp", "/dev/shm", "/run/lock"]).out.split("\n")).toEqual([
      "tmpfs",
      "tmpfs",
      "tmpfs",
    ]);
    expect(runAs(A, ["/usr/bin/stat", "-f", "-c", "%T", "/var/tmp"]).out).toBe(
      runSync("stat", ["-f", "-c", "%T", "/var/tmp"]).output,
    );
  });

  test.if(BPF)(
    "18. an in-place upgrade: a running slice under the earlier runner's policy takes the new one at the runner's start",
    async () => {
      C = users.ensure({ id: "c0000000-0000-4000-8000-000000000003", handle: "c", name: "Agent C" });
      const agent = C;
      const slice = agentSlice(agent.uid);
      const { cdp, stream } = browserPortsForUid(agent.uid);
      // The earlier runner's policy: every TCP port denied but 1-9999, 30000-65535 and its own pair, port 0 too.
      const earlier = () =>
        must("systemctl", [
          "set-property",
          "--runtime",
          slice,
          "SocketBindAllow=",
          "SocketBindAllow=tcp:1-9999",
          "SocketBindAllow=tcp:30000-65535",
          `SocketBindAllow=tcp:${cdp}-${stream}`,
          "SocketBindDeny=",
          "SocketBindDeny=tcp",
        ]);
      // Its processes come and go, each time realizing the slice again, then one keeps running (a task).
      const busy = async () => {
        for (let i = 0; i < 2; i++) runAs(agent, ["/bin/true"]);
        await hold(agent, ["/bin/sh", "-c", "echo ready; exec sleep 600"], (lines) => lines.includes("ready"));
        return running.at(-1) as ChildProcess;
      };
      const start = () => {
        const logs: string[] = [];
        prepareAgents(
          [agent],
          (u) => ensureBrowserBindPolicy(u, RUNNER, policy),
          policy,
          (line) => logs.push(line),
        );
        console.log(`upgrade: the runner's start said ${JSON.stringify(logs)}; ${bindPrograms(agent)} programs`);
        return logs;
      };
      must("systemctl", ["start", slice]);
      guard.reconcile();
      earlier();
      let task = await busy();
      expect(probe(agent, "bind", "127.0.0.1", "0")).toBe("EPERM");
      console.log(`upgrade: ${bindPrograms(agent)} bind programs on ${slice} under the earlier policy`);

      expect(start().filter((line) => line.startsWith("couldn't"))).toEqual([]);
      for (const host of HOSTS) {
        expect(probe(agent, "bind", host, "0")).toMatch(/^bound \d+$/);
        // The earlier policy's whole 10000-29999 is gone: the Kotlin daemon's ports bind.
        expect(probe(agent, "bind", host, "17001")).toBe("bound 17001");
      }
      if (bindPrograms(agent) !== null) expect(bindPrograms(agent)).toBe(1);

      // Rolled back: the earlier runner's set-property alone leaves the new programs in force, so its bind check
      // (which wants bind(0) refused) fails until a reload; its policy is the stricter, so a reload is enough.
      earlier();
      expect(probe(agent, "bind", "127.0.0.1", "0")).toMatch(/^bound \d+$/);
      must("systemctl", ["daemon-reload"]);
      expect(probe(agent, "bind", "127.0.0.1", "0")).toBe("EPERM");

      // Forward again, after the earlier runner ran a while: its programs pile up as the slice is realized again,
      // and a reload replaces only the latest of them.
      task.kill("SIGTERM");
      await until(() => task.exitCode !== null || task.signalCode !== null, 10_000);
      task = await busy();
      applyBindPolicy(agent, policy);
      must("systemctl", ["daemon-reload"]);
      console.log(
        `upgrade: with the new policy set and a reload, bind(0) ${probe(agent, "bind", "127.0.0.1", "0")}; ${bindPrograms(agent)} programs`,
      );
      expect(start().filter((line) => line.startsWith("couldn't"))).toEqual([]);
      expect(probe(agent, "bind", "127.0.0.1", "0")).toMatch(/^bound \d+$/);
      expect(probe(agent, "bind", "::1", "17001")).toBe("bound 17001");
      if (bindPrograms(agent) !== null) expect(bindPrograms(agent)).toBe(1);
      task.kill("SIGTERM");
    },
    300_000,
  );

  test("19. an agent's user can't schedule cron or at jobs, which would run outside its slice and its own /tmp", () => {
    const as = (argv: string[]) => {
      const r = spawnSync("/usr/sbin/runuser", ["-u", A.user, "--", ...argv], { cwd: "/", encoding: "utf8" });
      return { code: r.status, out: `${r.stdout}${r.stderr}` };
    };
    if (has("/usr/bin/crontab")) {
      const cron = as(["/usr/bin/crontab", "-l"]);
      expect(cron.out).toContain("not allowed");
      expect(cron.code).not.toBe(0);
    } else console.log("no cron here");
    if (has("/usr/bin/at")) {
      const at = as(["/usr/bin/at", "-l"]);
      expect(at.out).toMatch(/permission|not allowed/i);
      expect(at.code).not.toBe(0);
    } else console.log("no at here");
  });

  test("each agent's subordinate ids: its own block alone in /etc/subuid and /etc/subgid, by the real usermod (ADR 0169)", () => {
    for (const u of [A, B]) {
      const [first, last] = agentSubids(u.uid);
      for (const file of ["/etc/subuid", "/etc/subgid"]) {
        const rows = readFileSync(file, "utf8")
          .split("\n")
          .map((line) => line.split(":"))
          .filter((row) => row.length === 3);
        expect(rows.filter(([owner]) => owner === u.user)).toEqual([[u.user, String(first), "65536"]]);
        // Nobody else's range over it.
        const over = rows.filter(([owner, start, count]) => {
          const a = Number(start);
          return owner !== u.user && a <= last && a + Number(count) - 1 >= first;
        });
        expect(over).toEqual([]);
      }
    }
  });

  test("systemd-tmpfiles takes the cleanup line for the agents' own folders, and keeps what is fresh", () => {
    const conf = path.join(HOME, "agentes-runner.conf");
    writeFileSync(conf, AGENT_TMP_CLEANUP);
    const fresh = path.join(agentTmp(A.uid), "agentes-isolation-fresh");
    writeFileSync(fresh, "");
    const cleaned = runSync("systemd-tmpfiles", ["--clean", conf]);
    expect(cleaned.output).not.toMatch(/fail|invalid|unknown/i);
    expect(cleaned.code).toBe(0);
    expect(existsSync(fresh)).toBe(true);
  });

  test.if(has(ADB))("adb: each agent its own server, at once", () => {
    const servers = [A, B].map((u) => runAs(u, [ADB, "start-server"], 60_000));
    try {
      for (const s of servers) expect(s.code).toBe(0);
      for (const u of [A, B]) {
        const devices = runAs(u, [ADB, "devices"], 30_000);
        expect(devices.code).toBe(0);
        expect(devices.out).toContain("List of devices attached");
        expect(probe(u, "connect", "127.0.0.1", String(adbServerPort(u.uid)))).toBe("connected");
        // Its server listens on TCP alone.
        expect(abstractListeners(u)).toEqual([]);
      }
      expect(probe(B, "connect", "127.0.0.1", String(adbServerPort(A.uid)))).toBe("ECONNREFUSED");
    } finally {
      for (const u of [A, B]) runAs(u, [ADB, "kill-server"], 30_000);
    }
  });

  test("a dev server on port 0, then curl: its agent gets in, another doesn't", async () => {
    const lines = await hold(A, [PYTHON, "-u", "-m", "http.server", "0", "--bind", "127.0.0.1"], (l) =>
      l.some((x) => /port \d+/.test(x)),
    );
    const port = /port (\d+)/.exec(lines.join("\n"))?.[1] ?? "";
    const curl = (u: AgentUser) =>
      runAs(u, ["/usr/bin/curl", "-sS", "-o", "/dev/null", "-w", "%{http_code}", `http://127.0.0.1:${port}/`]);
    expect(curl(A).out).toBe("200");
    const refused = curl(B);
    expect(refused.code).toBe(7);
  });

  test("a wildcard listener is still only its own agent's, over loopback and the computer's own address", async () => {
    // A dev server an agent starts often binds 0.0.0.0, which the kernel's socket lookup matches for every local
    // address; a connection to the computer's own address routes over lo too, so it is marked the same way.
    const own = await serve(A, "listen", "0.0.0.0", "0");
    for (const via of ["127.0.0.1", hostAddress()].filter(Boolean)) {
      expect(probe(A, "connect", via, String(own.port))).toBe("connected");
      expect(probe(B, "connect", via, String(own.port))).toBe("ECONNREFUSED");
    }
  });

  test.if(has(GRADLE))(
    "Gradle and the Kotlin daemon: two agents build at once, each with its own daemons",
    async () => {
      const kotlin = /kotlinc-jvm (\d+\.\d+\.\d+)/.exec(runSync("kotlinc", ["-version"]).output)?.[1] ?? "2.2.21";
      const builds = [A, B].map((u) => {
        const dir = path.join(systemLauncher(u).home, "app");
        mkdirSync(path.join(dir, "src/main/kotlin"), { recursive: true });
        writeFileSync(path.join(dir, "settings.gradle.kts"), 'rootProject.name = "app"\n');
        writeFileSync(
          path.join(dir, "build.gradle.kts"),
          `plugins { kotlin("jvm") version "${kotlin}" }\nrepositories { mavenCentral() }\n`,
        );
        writeFileSync(path.join(dir, "src/main/kotlin/Main.kt"), 'fun main() = println("hi")\n');
        must("chown", ["-R", `${u.uid}:${agentGid(u.user)}`, dir]);
        const c = launch(u, ["/bin/sh", "-c", `cd ${dir} && ${GRADLE} build --console=plain 2>&1`]);
        return new Promise<{ code: number | null; out: string }>((resolve) => {
          const child = spawn(c.argv[0] as string, c.argv.slice(1), {
            cwd: "/",
            env: c.env,
            stdio: ["ignore", "pipe", "pipe"],
          });
          let out = "";
          child.stdout?.setEncoding("utf8").on("data", (d: string) => {
            out += d;
          });
          (child as unknown as EventEmitter).once("exit", (code: number | null) => resolve({ code, out }));
        });
      });
      for (const [i, r] of (await Promise.all(builds)).entries()) {
        if (r.code !== 0) console.log(r.out);
        expect(r.out).toContain("BUILD SUCCESSFUL");
        expect(r.out).not.toMatch(/fallback strategy|Could not connect to Kotlin compile daemon/i);
        const status = runAs([A, B][i] as AgentUser, [GRADLE, "--status"], 60_000).out;
        expect(status).toMatch(/\d+\s+(IDLE|BUSY)/);
        // The Gradle and Kotlin daemons, still running, listen on TCP alone.
        expect(abstractListeners([A, B][i] as AgentUser)).toEqual([]);
      }
    },
    600_000,
  );

  test.if(has(CHROME))("Chrome as an agent holds no abstract Unix socket", async () => {
    const profile = path.join(systemLauncher(A).home, "chrome-abstract");
    // Without its sandbox its renderers share the computer's network namespace too: the most it could hold.
    await hold(
      A,
      [
        CHROME,
        "--headless=new",
        "--no-sandbox",
        "--no-first-run",
        `--user-data-dir=${profile}`,
        `--remote-debugging-port=${browserPortsForUid(A.uid).cdp}`,
        "about:blank",
      ],
      (lines) => lines.some((line) => line.includes("DevTools listening")),
    );
    const chrome = running.at(-1) as ChildProcess;
    try {
      await Bun.sleep(2000);
      expect(abstractListeners(A)).toEqual([]);
    } finally {
      chrome.kill("SIGTERM");
    }
  });

  test.if(has(XVNC) && has(XAUTH))(
    "an agent's X server: its abstract socket refuses another agent without the cookie; a name another agent holds keeps that display from starting",
    async () => {
      const cookie = "0123456789abcdef0123456789abcdef";
      const auth = path.join(systemLauncher(A).home, "x-abstract-auth");
      expect(runAs(A, [XAUTH, "-f", auth, "add", ":61", "MIT-MAGIC-COOKIE-1", cookie]).code).toBe(0);
      // The desktops' own flags (`xvncArgs`), but for VNC's password: its screen only on a 0600 Unix socket.
      const xvnc = (display: number) => [
        XVNC,
        `:${display}`,
        "-geometry",
        "800x600",
        "-depth",
        "24",
        "-rfbport",
        "-1",
        "-rfbunixpath",
        path.join(systemLauncher(A).home, `vnc-${display}.sock`),
        "-rfbunixmode",
        "0600",
        "-SecurityTypes",
        "None",
        "-auth",
        auth,
        "-nolisten",
        "tcp",
        "-s",
        "0",
      ];
      // Up once its file socket is in the agent's own /tmp; whether it holds the abstract name is what's looked at.
      await hold(A, xvnc(61), () => existsSync(path.join(agentTmp(A.uid), ".X11-unix", "X61")));
      const x61 = running.at(-1) as ChildProcess;
      const squatter: ChildProcess[] = [];
      try {
        console.log(`abstract sockets of an agent running Xtigervnc: ${JSON.stringify(abstractListeners(A))}`);
        expect(abstractListeners(A)).toContain("@/tmp/.X11-unix/X61 (Xtigervnc)");
        expect(probe(B, "x11", "/tmp/.X11-unix/X61")).toBe("failed");
        expect(probe(B, "x11", "/tmp/.X11-unix/X61", "ffffffffffffffffffffffffffffffff")).toBe("failed");
        expect(probe(A, "x11", "/tmp/.X11-unix/X61", cookie)).toBe("success");
        // Another agent takes display 62's name first: A's X server there can't start (no listener of B's is
        // reached by A's X clients, since that server never runs).
        await serve(B, "abstract-listen", "/tmp/.X11-unix/X62");
        squatter.push(running.at(-1) as ChildProcess);
        expect(abstractListeners(B)).toEqual([expect.stringMatching(/^@\/tmp\/\.X11-unix\/X62 \(python3/)]);
        const refused = runAs(A, xvnc(62), 30_000);
        console.log(
          `X server on a display whose name another agent holds: exit ${refused.code}: ${refused.out.slice(-300)}`,
        );
        expect(refused.code).not.toBe(0);
        expect(refused.out).toMatch(/already running|already active|listening sockets/i);
      } finally {
        x61.kill("SIGTERM");
        for (const child of squatter) child.kill("SIGTERM");
      }
    },
  );
});

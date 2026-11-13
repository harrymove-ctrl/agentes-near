import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  browserBand,
  browserPortsForUid,
  checkEphemeralRange,
  validateBrowserUidRange,
} from "../../runner/browser-ports";
import {
  agentMark,
  defaultRouteInterfaces,
  LoopbackGuard,
  loopbackEndpoints,
  NO_OWNER_MARK,
  OTHER_USER_MARK,
  ROOT_MARK,
  RUNNER_NFT_TABLE,
  renderRuleset,
  runnerEndpoints,
} from "../../runner/loopback-guard";
import { AGENTS_CGROUP, agentCgroup, type RunCommand } from "../../runner/service";
import { removeDirs, tempDir } from "./helpers";

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

const RANGE: [number, number] = [20000, 29999];
const base = { agents: [20001, 20002], uidRange: RANGE, services: [], uplinks: [], reject: true };

// ── the table ─────────────────────────────────────────────────────────────

test("the table for two agents: each mapped from its slice, and only its own listeners let it in", () => {
  expect(renderRuleset(base)).toBe(`table inet agentes_runner {}
delete table inet agentes_runner
table inet agentes_runner {
	map agent_of {
		typeof socket cgroupv2 level 2 : ct mark
		elements = { "agents.slice/agents-20001.slice" : 0x41004e21, "agents.slice/agents-20002.slice" : 0x41004e22 }
	}
	set services {
		type inet_proto . inet_service
		elements = { tcp . 53, udp . 53 }
	}
	set uplinks {
		type ifname
	}
	chain output {
		type filter hook output priority filter; policy accept;
		oif "lo" meta l4proto { tcp, udp } ct state new jump sender
		ct state { new, untracked } socket cgroupv2 level 1 "agents.slice" jump agent_out
		ct state { new, untracked } meta skuid 20000-29999 socket cgroupv2 level 1 != "agents.slice" jump agent_out
	}
	chain sender {
		socket cgroupv2 level 1 "agents.slice" ct mark set 0x41ffffff
		ct mark set socket cgroupv2 level 2 map @agent_of return
		socket cgroupv2 level 1 "agents.slice" return
		meta skuid 20000-29999 ct mark set 0x41ffffff return
		meta skuid 0 ct mark set 0x41000000 return
		ct mark set 0x41fffffe
	}
	chain agent_out {
		oif "lo" ct state untracked goto refuse
		oif "lo" meta l4proto != { tcp, udp, icmp, ipv6-icmp } goto refuse
		ct status dnat ct original ip daddr 127.0.0.0/8 ct reply ip saddr != 127.0.0.0/8 goto refuse
		ct status dnat ct original ip6 daddr ::1 ct reply ip6 saddr != ::1 goto refuse
		meta oifkind { "bridge", "veth" } oifname != @uplinks goto refuse
	}
	chain input {
		type filter hook input priority filter; policy accept;
		iif "lo" meta l4proto { tcp, udp } ct state new jump local
	}
	chain local {
		ct mark 0x41000000 accept
		ct mark 0x41004e21 socket cgroupv2 level 2 "agents.slice/agents-20001.slice" accept
		ct mark 0x41004e22 socket cgroupv2 level 2 "agents.slice/agents-20002.slice" accept
		socket cgroupv2 level 1 "agents.slice" goto refuse
		ct mark != { 0x41004e20-0x4100752f, 0x41ffffff } accept
		meta l4proto . th dport @services accept
		goto refuse
	}
	chain refuse {
		meta l4proto tcp reject with tcp reset
		reject
	}
}
`);
  // Marks carry a tag in their top byte: one another tool writes never reads as root's or an agent's.
  expect([ROOT_MARK, agentMark(20001), NO_OWNER_MARK, OTHER_USER_MARK].map((m) => m >>> 24)).toEqual([
    0x41, 0x41, 0x41, 0x41,
  ]);
});

test("the range, the services, the uplinks and the drop fallback come from what it is given", () => {
  const text = renderRuleset({
    agents: [],
    uidRange: [20000, 20999],
    services: ["tcp/11434", "UDP/8125", "tcp/53", "tcp/0", "sctp/5", "nonsense"],
    uplinks: ["vmbr0"],
    reject: false,
  });
  expect(text).toContain("meta skuid 20000-20999 ct mark set 0x41ffffff return");
  expect(text).toContain("ct mark != { 0x41004e20-0x41005207, 0x41ffffff } accept");
  // DNS once, each listed port once, nothing that isn't one TCP or UDP port.
  expect(text).toContain("elements = { tcp . 53, udp . 53, tcp . 11434, udp . 8125 }");
  expect(text).toContain('elements = { "vmbr0" }');
  // No agent with a slice yet: an empty map, and no agent's own rule.
  expect(text).toContain("map agent_of {\n\t\ttypeof socket cgroupv2 level 2 : ct mark\n\t}");
  expect(text).not.toMatch(/ct mark 0x4100[0-9a-f]{4} socket/);
  expect(text).toContain("chain refuse {\n\t\tdrop\n\t}");
  expect(text).not.toContain("reject");
  // One uid: a value, never a range nft would refuse.
  expect(renderRuleset({ ...base, agents: [21000], uidRange: [21000, 21000] })).toContain(
    "ct mark != { 0x41005208, 0x41ffffff } accept",
  );
  expect(() => renderRuleset({ ...base, uidRange: [20000, 30000] })).toThrow("one 10,000-uid block");
});

test("the loopback endpoints the runner hands agents: proxies and the server where they are on this computer", () => {
  expect(
    loopbackEndpoints([
      "http://127.0.0.1:3128",
      "https://localhost",
      "socks5://[::1]:1080",
      "127.0.0.2:8888",
      "http://10.0.0.5:3128",
      "https://proxy.example.com:8443",
      "",
      undefined,
      "not a url ::",
    ]),
  ).toEqual(["tcp/3128", "tcp/443", "tcp/1080", "tcp/8888"]);
  expect(
    runnerEndpoints({
      HTTPS_PROXY: "http://127.0.0.1:3128",
      all_proxy: "socks5://localhost:9050",
      NO_PROXY: "127.0.0.1",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:4000",
    }),
  ).toEqual(["tcp/3128", "tcp/9050", "tcp/4000"]);
});

test("uplinks: the interfaces with a default route, IPv4 or IPv6, never lo's reject routes", () => {
  const header = "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT";
  const route4 = [
    header,
    "vmbr0\t00000000\t0101A8C0\t0003\t0\t0\t0\t00000000\t0\t0\t0",
    "vmbr0\t0001A8C0\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0",
    "docker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0",
  ].join("\n");
  const route6 = [
    "00000000000000000000000000000000 00 00000000000000000000000000000000 00 fe800000000000000000000000000001 00000400 00000001 00000000 00000003     eth1",
    "00000000000000000000000000000000 00 00000000000000000000000000000000 00 00000000000000000000000000000000 ffffffff 00000001 00000000 00200200       lo",
    "fe800000000000000000000000000000 40 00000000000000000000000000000000 00 00000000000000000000000000000000 00000100 00000001 00000000 00000001   docker0",
  ].join("\n");
  expect(defaultRouteInterfaces(route4, route6)).toEqual(["eth1", "vmbr0"]);
  expect(defaultRouteInterfaces(`${header}\neth0\t00000000\t0102A8C0\t0003\t0\t0\t100\t00000000`, "")).toEqual([
    "eth0",
  ]);
  expect(defaultRouteInterfaces("", "")).toEqual([]);
});

// ── the guard ─────────────────────────────────────────────────────────────

/** A fake root toolbox and cgroup tree: records calls, keeps what nft loaded. */
function computer(opts: { nft?: boolean; refuse?: (text: string) => string | null } = {}) {
  const calls: string[] = [];
  const loaded: string[] = [];
  const state = {
    tables: true,
    slices: new Map<string, string>([[AGENTS_CGROUP, "100"]]),
    route4: "",
    services: [] as string[],
    uids: [20001, 20002],
  };
  const run: RunCommand = (file, args) => {
    calls.push([file, ...args].join(" "));
    if (file !== "nft") return { code: 0, output: "" };
    if (args[0] === "--version") return { code: opts.nft === false ? 127 : 0, output: "nftables v1.1.3" };
    if (args[0] === "list") {
      return { code: 0, output: state.tables ? `table inet agentes_guard\ntable inet ${RUNNER_NFT_TABLE}\n` : "" };
    }
    const text = readFileSync(args.at(-1) ?? "", "utf8");
    const why = opts.refuse?.(text) ?? null;
    if (why) return { code: 1, output: why };
    if (args[0] === "-f") {
      loaded.push(text);
      state.tables = true;
    }
    return { code: 0, output: "" };
  };
  const logs: string[] = [];
  const guard = (o: { uidRange?: [number, number]; ephemeralRange?: string } = {}) => {
    const home = tempDir("loopback-guard-");
    dirs.push(home);
    return new LoopbackGuard({
      home,
      agentUids: () => state.uids,
      uidRange: RANGE,
      services: () => state.services,
      log: (l) => logs.push(l),
      run,
      systemd: true,
      ephemeralRange: "32768 60999",
      cgroupId: (dir) => state.slices.get(dir) ?? null,
      routes: () => [state.route4, ""],
      ...o,
    });
  };
  return { calls, loaded, state, logs, guard };
}

test("start: modules, every listed agent's slice, then the table, before any agent process", () => {
  const pc = computer();
  pc.state.slices.set(agentCgroup(20001), "201");
  const g = pc.guard();
  g.start();
  expect(pc.calls.slice(0, 3)).toEqual([
    "nft --version",
    "modprobe -a nft_ct nft_socket nft_reject_inet",
    "systemctl start agents.slice agents-20001.slice agents-20002.slice",
  ]);
  // Checked, then loaded.
  expect(pc.calls.slice(3).map((c) => c.split(" ").slice(0, 2).join(" "))).toEqual(["nft -c", "nft -f"]);
  // Only the agent whose slice is there is mapped: the other owns nothing until its slice comes.
  expect(pc.loaded.at(-1)).toContain('elements = { "agents.slice/agents-20001.slice" : 0x41004e21 }');
  expect(pc.loaded.at(-1)).not.toContain("agents-20002.slice");
  g.stop();
});

test("a check loads it again only when what it is made of changed, or when it is gone", () => {
  const pc = computer();
  pc.state.slices.set(agentCgroup(20001), "201");
  const g = pc.guard();
  g.start();
  expect(pc.loaded).toHaveLength(1);
  // Nothing changed: no load, and one `nft list tables` (never a listing of the table, which walks the cgroup tree).
  const before = pc.calls.length;
  g.reconcile();
  expect(pc.loaded).toHaveLength(1);
  expect(pc.calls.slice(before)).toEqual(["nft list tables"]);
  // A new agent's slice, a slice made anew, agents.slice made anew, a service, an uplink, a new agent: each loads.
  const changes: (() => void)[] = [
    () => pc.state.slices.set(agentCgroup(20002), "202"),
    () => pc.state.slices.set(agentCgroup(20001), "301"),
    () => pc.state.slices.set(AGENTS_CGROUP, "300"),
    () => {
      pc.state.services = ["tcp/11434"];
    },
    () => {
      pc.state.route4 =
        "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\nvmbr0\t00000000\t0101A8C0\t0003\t0\t0\t0\t00000000";
    },
    () => {
      pc.state.uids = [20001, 20002, 20003];
      pc.state.slices.set(agentCgroup(20003), "203");
    },
  ];
  for (const [i, change] of changes.entries()) {
    change();
    g.reconcile();
    expect(pc.loaded).toHaveLength(i + 2);
  }
  expect(pc.loaded.at(-1)).toContain('"agents.slice/agents-20003.slice" : 0x41004e23');
  expect(pc.loaded.at(-1)).toContain("tcp . 11434");
  expect(pc.loaded.at(-1)).toContain('elements = { "vmbr0" }');
  // Someone deleted it (`nft flush ruleset`): back at the next check.
  pc.state.tables = false;
  g.reconcile();
  expect(pc.loaded).toHaveLength(changes.length + 2);
  g.stop();
});

test("a slice gone between the look and the load: looked at again once; else what is loaded stays, never flushed", () => {
  const gone = "Error: cgroupv2 path fails: No such file or directory";
  const pc = computer({ refuse: (text) => (text.includes("agents-20002.slice") ? gone : null) });
  pc.state.slices.set(agentCgroup(20001), "201");
  const g = pc.guard();
  g.start();
  // There at the first look, gone at the load: the second look leaves it out.
  let looks = 0;
  const slices = pc.state.slices;
  const get = slices.get.bind(slices);
  slices.get = (dir: string) => (dir === agentCgroup(20002) ? (looks++ === 0 ? "202" : undefined) : get(dir));
  expect(g.reconcile()).toBe(true);
  expect(pc.loaded).toHaveLength(2);
  expect(pc.loaded.at(-1)).not.toContain("agents-20002.slice");
  // There at both looks and refused both times: the old table stays, with one warning.
  slices.get = (dir: string) => (dir === agentCgroup(20002) ? "202" : get(dir));
  expect(g.reconcile()).toBe(false);
  expect(g.reconcile()).toBe(false);
  expect(pc.loaded).toHaveLength(2);
  expect(pc.logs).toEqual([`couldn't apply the loopback guard (${gone}); it keeps its last rules`]);
  expect(pc.calls.some((c) => c.includes("flush"))).toBe(false);
  g.stop();
});

test("no agents.slice: started again, since the table names it", () => {
  const pc = computer();
  const g = pc.guard();
  g.start();
  pc.state.slices.delete(AGENTS_CGROUP);
  expect(g.reconcile()).toBe(false);
  expect(pc.calls.at(-1)).toBe("systemctl start agents.slice");
  expect(pc.logs).toEqual(["the loopback guard can't find agents.slice; it keeps its last rules"]);
  g.stop();
});

test("drop where the kernel refuses reject, and it sticks", () => {
  const pc = computer({ refuse: (text) => (text.includes("reject") ? "Error: Could not process rule" : null) });
  const g = pc.guard();
  g.start();
  expect(pc.loaded.at(-1)).toContain("chain refuse {\n\t\tdrop\n\t}");
  pc.state.services = ["udp/8125"];
  g.reconcile();
  expect(pc.loaded.at(-1)).toContain("udp . 8125");
  expect(pc.loaded.at(-1)).not.toContain("reject");
  g.stop();
});

test("start refuses before any agent process: no nft, a kernel without socket matching, bad uids, an overlapping range", () => {
  let pc = computer({ nft: false });
  expect(() => pc.guard().start()).toThrow("requires nft");
  pc = computer({ refuse: () => "Error: Could not process rule: No such file or directory" });
  expect(() => pc.guard().start()).toThrow(
    "System mode needs Linux 5.13 or later with nft_socket, and nftables 1.0 or later, so each agent reaches only its own local ports: Error: Could not process rule",
  );
  expect(pc.loaded).toHaveLength(0);
  for (const uids of [
    [20000, 30000],
    [20000, 20000],
  ]) {
    pc = computer();
    pc.state.uids = uids;
    expect(() => pc.guard().start()).toThrow("Persisted agent UIDs overlap or fall outside");
    expect(pc.loaded).toHaveLength(0);
  }
  pc = computer();
  pc.state.uids = [];
  expect(() => pc.guard({ uidRange: [20000, 20999], ephemeralRange: "10000 60999" }).start()).toThrow(
    "Linux's ephemeral port range 10000-60999 overlaps reserved browser ports 10000-11999",
  );
  expect(() => pc.guard({ uidRange: [20000, 20999], ephemeralRange: "12000 60999" }).start()).not.toThrow();
});

// ── the band ──────────────────────────────────────────────────────────────

test("the band is the browser pairs of the computer's range: the Cloud's leaves the Kotlin daemon's ports free", () => {
  expect(browserPortsForUid(20000)).toEqual({ cdp: 10000, stream: 10001 });
  expect(browserBand([20000, 29999])).toEqual([10000, 29999]);
  expect(browserBand([20000, 20999])).toEqual([10000, 11999]);
  expect(browserBand([21000, 21099])).toEqual([12000, 12199]);
  expect(() => validateBrowserUidRange([20000, 30000])).toThrow("one 10,000-uid block");
  expect(() => checkEphemeralRange("32768 60999", [10000, 29999])).not.toThrow();
  expect(() => checkEphemeralRange("11000 60999", [10000, 11999])).toThrow(
    "overlaps reserved browser ports 10000-11999",
  );
  expect(() => checkEphemeralRange("nonsense", [10000, 11999])).toThrow("Cannot read");
});

test("routing exemptions precede both local-port hooks and retain cgroup ownership protection", () => {
  expect(renderRuleset(base)).not.toContain("meta mark &");
  const marked = renderRuleset({ ...base, networkMark: 0x08000000 });
  const rule = "meta mark & 0x08000000 == 0x08000000 ct status != dnat fib daddr type != local return";
  for (const hook of ["output", "input"]) {
    const chain = marked.split(`chain ${hook} {`)[1]?.split("\t}")[0] ?? "";
    expect(chain).toContain(rule);
    expect(chain.indexOf(rule)).toBeLessThan(chain.indexOf(hook === "output" ? 'oif "lo"' : 'iif "lo"'));
  }
  expect(marked).not.toContain("fib daddr . mark");
  expect(marked).toContain('socket cgroupv2 level 1 "agents.slice" goto refuse');
  expect(() => renderRuleset({ ...base, networkMark: 0 })).toThrow("networkMark");
});

test("network mark reconciliation remains atomic and restores the previous setting on failure", () => {
  let fail = false;
  const pc = computer({ refuse: () => (fail ? "unavailable" : null) });
  const g = pc.guard();
  expect(g.reconcile()).toBe(true);
  expect(g.setNetworkMark(0x08000000)).toBe(true);
  const applied = pc.loaded.at(-1);
  expect(applied).toContain("agentes network mark 134217728");
  fail = true;
  expect(g.setNetworkMark(0x10000000)).toBe(false);
  expect(pc.loaded.at(-1)).toBe(applied);
  fail = false;
  expect(g.reconcile()).toBe(true);
  expect(pc.loaded.at(-1)).toBe(applied);
});

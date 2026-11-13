import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { NETWORK_ENV } from "./accounts";
import { browserBand, checkEphemeralRange, EPHEMERAL_RANGE_FILE, validateBrowserUidRange } from "./browser-ports";
import { parseService } from "./config";
import { networkMarkExemption, validateNetworkMark } from "./network-mark";
import { AGENTS_CGROUP, agentCgroup, agentSlice, type RunCommand, runSync, systemdBooted } from "./service";

/**
 * System mode: an agent reaches a local listener only when that listener was made inside its own slice
 * (`agents.slice/agents-<uid>.slice`, at any level below it: its worker, Chrome, AI CLIs, terminals, desktop and
 * tasks). The agent itself is told by the cgroup its socket was made in, never by its uid, so a setuid-root
 * program it runs is still that agent.
 *
 * On the way out, each new local TCP or UDP connection gets its sender in the conntrack mark; on the way in, the
 * kernel's own socket lookup finds where it goes (for a SYN, the listener), and it gets in only when that socket
 * is the sender's own. A connection across `lo` keeps its conntrack entry but loses its socket, so the way in
 * reads the mark the way out set. Agents get the computer's own listeners only for DNS and the listed services,
 * and no container or VM network on this computer. Ports don't matter.
 *
 * nft resolves a cgroup's path to its id when it loads the table, so the table is loaded again whenever an
 * agent's slice appears or is made anew (`reconcile`, every 2 s and right after a slice starts).
 */

/** Our table; the Cloud guard has its own (`inet agentes_guard`). */
export const RUNNER_NFT_TABLE = "agentes_runner";
/** How often the guard checks what the table is made of (a stat per slice, `nft list tables`). */
export const GUARD_RESCAN_MS = 2000;

/**
 * Who opened a connection, in its conntrack mark: a fixed tag in the top byte, so a mark another tool writes never
 * reads as root's or an agent's, then an agent's uid (at most 59999), 0 for root, or one of two codes.
 */
const MARK_TAG = 0x41000000;
export const ROOT_MARK = MARK_TAG;
/** An agent that owns nothing: its uid outside its slice (cron, at), or its slice not mapped yet. */
export const NO_OWNER_MARK = MARK_TAG + 0xffffff;
/** Another local user. */
export const OTHER_USER_MARK = MARK_TAG + 0xfffffe;
export const agentMark = (uid: number) => MARK_TAG + uid;

/** Always open to agents: their resolver (the Cloud's unbound, systemd-resolved). */
const DNS = ["tcp/53", "udp/53"];
/** What the runner hands the AI CLIs as their way out (`accountSettingsEnv`): open to agents where it is local. */
const ENDPOINT_ENV = [...NETWORK_ENV.filter((k) => /^(https?|all)_proxy$/i.test(k)), "ANTHROPIC_BASE_URL"];
const DEFAULT_PORTS: Record<string, number> = { "http:": 80, "https:": 443, "socks:": 1080, "socks5:": 1080 };

const hex = (n: number) => `0x${n.toString(16).padStart(8, "0")}`;
const span = (a: number | string, b: number | string) => (a === b ? `${a}` : `${a}-${b}`);
const sliceOf = (uid: number) => `agents.slice/${agentSlice(uid)}`;

/** `tcp/11434` → `tcp . 11434`, the set's element; null when it isn't one TCP or UDP port. */
const serviceElement = (spec: string) => parseService(spec)?.replace("/", " . ") ?? null;

/** The port of each URL here that is on this computer itself: `http://127.0.0.1:8080` → `tcp/8080`. */
export function loopbackEndpoints(urls: readonly (string | undefined)[]): string[] {
  const found = new Set<string>();
  for (const raw of urls) {
    const text = raw?.trim();
    if (!text) continue;
    let url: URL;
    try {
      url = new URL(/^[a-z][\w+.-]*:\/\//i.test(text) ? text : `http://${text}`);
    } catch {
      continue;
    }
    if (!/^(localhost|127(\.\d+){3}|\[::1\])$/i.test(url.hostname)) continue;
    const port = url.port ? Number(url.port) : DEFAULT_PORTS[url.protocol];
    if (port) found.add(`tcp/${port}`);
  }
  return [...found];
}

/** The local ports of the proxies and the Claude endpoint in the runner's environment. */
export const runnerEndpoints = (env: NodeJS.ProcessEnv = process.env) =>
  loopbackEndpoints(ENDPOINT_ENV.map((k) => env[k]));

/**
 * The interfaces with a default route, from `/proc/net/route` and `/proc/net/ipv6_route`: a bridge that is this
 * computer's way out (Proxmox's vmbr0, an LXC container's veth) is no guest network.
 */
export function defaultRouteInterfaces(route4: string, route6: string): string[] {
  const found = new Set<string>();
  for (const line of route4.split("\n").slice(1)) {
    const [iface, dest, , flags, , , , mask] = line.trim().split(/\s+/);
    if (iface && dest === "00000000" && mask === "00000000" && Number.parseInt(flags ?? "0", 16) & 0x1)
      found.add(iface);
  }
  for (const line of route6.split("\n")) {
    const [dest, len, , , , , , , flagText, iface] = line.trim().split(/\s+/);
    const flags = Number.parseInt(flagText ?? "0", 16);
    // Up, and not a reject route (the kernel's own `unreachable` defaults on lo).
    if (dest === "0".repeat(32) && len === "00" && flags & 0x1 && !(flags & 0x200) && iface && iface !== "lo") {
      found.add(iface);
    }
  }
  return [...found].sort();
}

export interface RulesetInput {
  /** The agents whose slice exists now. */
  agents: number[];
  /** The computer's whole agent uid range: a uid in it outside every slice is an agent that owns nothing. */
  uidRange: [number, number];
  /** What agents may reach of the computer's own listeners besides DNS (`tcp/11434`). */
  services: string[];
  networkMark?: number;
  /** Interfaces with a default route (`defaultRouteInterfaces`). */
  uplinks: string[];
  /** False where the kernel has no `nft_reject_inet`: a refused connection is dropped (it hangs, then fails). */
  reject: boolean;
}

const elements = (items: string[]) => (items.length ? `\n\t\telements = { ${items.join(", ")} }` : "");

/**
 * The whole `nft -f` script. The create-then-delete-then-create idiom replaces the table atomically whatever
 * state it was in, without touching any other table (never `flush ruleset`). Only new connections are judged.
 */
export function renderRuleset(i: RulesetInput): string {
  validateBrowserUidRange(i.uidRange);
  const [first, last] = i.uidRange;
  const uids = span(first, last);
  const agentMarks = span(hex(agentMark(first)), hex(agentMark(last)));
  const services = [...new Set([...DNS, ...i.services].map(serviceElement).filter((s) => s !== null))];
  const owners = i.agents.map((uid) => `${JSON.stringify(sliceOf(uid))} : ${hex(agentMark(uid))}`);
  return [
    `table inet ${RUNNER_NFT_TABLE} {}`,
    `delete table inet ${RUNNER_NFT_TABLE}`,
    `table inet ${RUNNER_NFT_TABLE} {`,
    `\tmap agent_of {\n\t\ttypeof socket cgroupv2 level 2 : ct mark${elements(owners)}\n\t}`,
    `\tset services {\n\t\ttype inet_proto . inet_service${elements(services)}\n\t}`,
    `\tset uplinks {\n\t\ttype ifname${elements(i.uplinks.map((name) => JSON.stringify(name)))}\n\t}`,
    "\tchain output {",
    "\t\ttype filter hook output priority filter; policy accept;",
    ...networkMarkExemption(i.networkMark),
    '\t\toif "lo" meta l4proto { tcp, udp } ct state new jump sender',
    '\t\tct state { new, untracked } socket cgroupv2 level 1 "agents.slice" jump agent_out',
    `\t\tct state { new, untracked } meta skuid ${uids} socket cgroupv2 level 1 != "agents.slice" jump agent_out`,
    "\t}",
    // Who opened it. A lookup that misses ends its rule there, and the next one decides.
    "\tchain sender {",
    `\t\tsocket cgroupv2 level 1 "agents.slice" ct mark set ${hex(NO_OWNER_MARK)}`,
    "\t\tct mark set socket cgroupv2 level 2 map @agent_of return",
    '\t\tsocket cgroupv2 level 1 "agents.slice" return',
    `\t\tmeta skuid ${uids} ct mark set ${hex(NO_OWNER_MARK)} return`,
    `\t\tmeta skuid 0 ct mark set ${hex(ROOT_MARK)} return`,
    `\t\tct mark set ${hex(OTHER_USER_MARK)}`,
    "\t}",
    // In this hook `oif` is where the route went before any DNAT: a loopback port DNAT'ed into a container still
    // reads as lo here, so it is told by its conntrack entry (where it was sent, and where it goes now).
    "\tchain agent_out {",
    '\t\toif "lo" ct state untracked goto refuse',
    '\t\toif "lo" meta l4proto != { tcp, udp, icmp, ipv6-icmp } goto refuse',
    "\t\tct status dnat ct original ip daddr 127.0.0.0/8 ct reply ip saddr != 127.0.0.0/8 goto refuse",
    "\t\tct status dnat ct original ip6 daddr ::1 ct reply ip6 saddr != ::1 goto refuse",
    // A container's or a VM's network on this computer, but for what is published on its other addresses.
    '\t\tmeta oifkind { "bridge", "veth" } oifname != @uplinks goto refuse',
    "\t}",
    "\tchain input {",
    "\t\ttype filter hook input priority filter; policy accept;",
    ...networkMarkExemption(i.networkMark),
    '\t\tiif "lo" meta l4proto { tcp, udp } ct state new jump local',
    "\t}",
    // Where it goes: the socket the kernel delivers it to (for a SYN, the listener).
    "\tchain local {",
    `\t\tct mark ${hex(ROOT_MARK)} accept`,
    ...i.agents.map(
      (uid) => `\t\tct mark ${hex(agentMark(uid))} socket cgroupv2 level 2 ${JSON.stringify(sliceOf(uid))} accept`,
    ),
    '\t\tsocket cgroupv2 level 1 "agents.slice" goto refuse',
    `\t\tct mark != { ${agentMarks}, ${hex(NO_OWNER_MARK)} } accept`,
    "\t\tmeta l4proto . th dport @services accept",
    "\t\tgoto refuse",
    "\t}",
    "\tchain refuse {",
    ...(i.reject ? ["\t\tmeta l4proto tcp reject with tcp reset", "\t\treject"] : ["\t\tdrop"]),
    "\t}",
    "}",
    "",
  ].join("\n");
}

export interface LoopbackGuardOptions {
  /** The runner home: the rendered ruleset is written here (root-owned, 0600). */
  home: string;
  /** The agents' uids right now (`agents.json`). */
  agentUids: () => number[];
  /** The computer's whole configured agent uid range, agents not created yet included. */
  uidRange: [number, number];
  /** What else of the computer agents may reach (`tcp/11434`), read at every check. */
  services?: () => string[];
  networkMark?: number;
  log: (line: string) => void;
  run?: RunCommand;
  /** Tests: the computer's state. */
  systemd?: boolean;
  ephemeralRange?: string;
  /** A cgroup's id (its inode), or null when it isn't there. */
  cgroupId?: (dir: string) => string | null;
  routes?: () => [route4: string, route6: string];
  /** Tests: drop from the start, as where the kernel has no `nft_reject_inet`. */
  reject?: boolean;
}

const cgroupInode = (dir: string) => {
  try {
    return String(statSync(dir, { bigint: true }).ino);
  } catch {
    return null;
  }
};

const readOr = (file: string) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

const procRoutes = (): [string, string] => [readOr("/proc/net/route"), readOr("/proc/net/ipv6_route")];

/**
 * Keeps `table inet agentes_runner` matching the agents' slices, the services and the uplinks. Lives in the root
 * process; agents' processes can't touch nftables.
 */
export class LoopbackGuard {
  private readonly run: RunCommand;
  private readonly rulesetFile: string;
  private reject: boolean;
  /** What the table loaded now was made of. */
  private applied = "";
  private timer: ReturnType<typeof setInterval> | null = null;
  /** One warning per failure streak, cleared on the next success. */
  private warned = false;
  private lastError = "";

  constructor(private readonly opts: LoopbackGuardOptions) {
    if (opts.networkMark !== undefined) validateNetworkMark(opts.networkMark);
    this.run = opts.run ?? runSync;
    this.rulesetFile = path.join(opts.home, "loopback-guard.nft");
    this.reject = opts.reject ?? true;
  }

  /** Whether `nft` is here to run (single-user self-hosts have no system-mode guard). */
  available(): boolean {
    return this.run("nft", ["--version"]).code === 0;
  }

  /** Loads the table before any agent process can start, then keeps it current. Throws when it can't load. */
  start() {
    if (!(this.opts.systemd ?? systemdBooted())) {
      throw new Error("System mode requires systemd socket-bind enforcement for agent browsers");
    }
    validateBrowserUidRange(this.opts.uidRange);
    const uids = this.opts.agentUids();
    if (!this.validExistingUids(uids)) {
      throw new Error("Persisted agent UIDs overlap or fall outside the configured browser port range");
    }
    checkEphemeralRange(
      this.opts.ephemeralRange ?? readFileSync(EPHEMERAL_RANGE_FILE, "utf8"),
      browserBand(this.opts.uidRange),
    );
    if (!this.available()) throw new Error("System mode requires nft so each agent reaches only its own local ports");
    // Best effort: an explicit load works whatever kernel.modprobe says, and a kernel with them built in needs none.
    this.run("modprobe", ["-a", "nft_ct", "nft_socket", "nft_reject_inet"]);
    // Every listed agent's slice there at the first load: each is mapped before any of its processes starts.
    this.run("systemctl", ["start", "agents.slice", ...uids.map(agentSlice)]);
    if (!this.reconcile()) {
      throw new Error(
        `System mode needs Linux 5.13 or later with nft_socket, and nftables 1.0 or later, so each agent reaches only its own local ports: ${this.lastError.slice(0, 500)}`,
      );
    }
    this.timer = setInterval(() => {
      try {
        this.reconcile();
      } catch (err) {
        this.warnOnce(`the loopback guard keeps its last rules: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, GUARD_RESCAN_MS);
    this.timer.unref?.();
  }

  setNetworkMark(mark: number | undefined): boolean {
    if (mark !== undefined) validateNetworkMark(mark);
    if (this.opts.networkMark === mark) return true;
    const before = this.opts.networkMark;
    this.opts.networkMark = mark;
    if (this.reconcile()) return true;
    this.opts.networkMark = before;
    return false;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Loads the table again when what it is made of changed (an agent, a slice made anew, the services, the uplinks)
   * or it is gone. A load that fails keeps the table loaded before: never flushed.
   */
  reconcile(): boolean {
    const uids = this.opts.agentUids();
    if (!this.validExistingUids(uids)) {
      this.warnOnce("agent UIDs overlap or fall outside the configured browser port range");
      return false;
    }
    let inputs = this.inputs(uids);
    if (inputs === null) {
      // agents.slice stopped by hand: the table names it, so it starts again.
      this.run("systemctl", ["start", "agents.slice"]);
      inputs = this.inputs(uids);
    }
    if (inputs === null) {
      this.lastError = `${AGENTS_CGROUP} isn't there`;
      this.warnOnce("the loopback guard can't find agents.slice; it keeps its last rules");
      return false;
    }
    if (inputs.key === this.applied && this.loaded()) return true;
    if (this.load(inputs)) return true;
    // A slice that went between the stat and the load fails it: looked at again, once.
    const again = this.inputs(uids);
    if (again && again.key !== inputs.key && this.load(again)) return true;
    this.warnOnce(`couldn't apply the loopback guard (${this.lastError.slice(0, 300)}); it keeps its last rules`);
    return false;
  }

  /** What the table is made of now; null without `agents.slice`. */
  private inputs(uids: number[]) {
    const id = this.opts.cgroupId ?? cgroupInode;
    const root = id(AGENTS_CGROUP);
    if (root === null) return null;
    const agents: number[] = [];
    const ids: string[] = [];
    for (const uid of [...uids].sort((a, b) => a - b)) {
      const slice = id(agentCgroup(uid));
      if (slice === null) continue;
      agents.push(uid);
      ids.push(`${uid}:${slice}`);
    }
    let listed: string[] = [];
    try {
      listed = this.opts.services?.() ?? [];
    } catch {
      // An unreadable config.json opens nothing more than DNS.
    }
    const services = listed.filter((s) => serviceElement(s) !== null).sort();
    const uplinks = defaultRouteInterfaces(...(this.opts.routes ?? procRoutes)());
    const input = { agents, uidRange: this.opts.uidRange, services, uplinks, networkMark: this.opts.networkMark };
    return { key: JSON.stringify({ ...input, root, ids }), input };
  }

  /** Whether our table is loaded (`nft list tables`: listing the table itself would walk the whole cgroup tree). */
  private loaded(): boolean {
    const r = this.run("nft", ["list", "tables"]);
    return r.code !== 0 || r.output.split("\n").some((line) => line.trim() === `table inet ${RUNNER_NFT_TABLE}`);
  }

  /** Loads with reject, or with drop where the kernel refuses reject (which then sticks). */
  private load({ key, input }: { key: string; input: Omit<RulesetInput, "reject"> }): boolean {
    let ok = this.apply(renderRuleset({ ...input, reject: this.reject }));
    if (!ok && this.reject && this.apply(renderRuleset({ ...input, reject: false }))) {
      this.reject = false;
      ok = true;
    }
    if (ok) {
      this.applied = key;
      this.warned = false;
    }
    return ok;
  }

  private warnOnce(line: string) {
    if (this.warned) return;
    this.warned = true;
    this.opts.log(line);
  }

  private validExistingUids(uids: number[]): boolean {
    const [first, last] = this.opts.uidRange;
    return (
      new Set(uids).size === uids.length && uids.every((uid) => Number.isInteger(uid) && uid >= first && uid <= last)
    );
  }

  /** Writes the script and applies it (checked first). True when it took. */
  private apply(text: string): boolean {
    try {
      writeFileSync(this.rulesetFile, text, { mode: 0o600 });
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return false;
    }
    for (const args of [
      ["-c", "-f", this.rulesetFile],
      ["-f", this.rulesetFile],
    ]) {
      const r = this.run("nft", args);
      if (r.code !== 0) {
        this.lastError = r.output;
        return false;
      }
    }
    return true;
  }
}

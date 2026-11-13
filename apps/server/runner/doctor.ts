import { spawnSync } from "node:child_process";
import { accessSync, constants, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { machineSize } from "@agenteschat/adapters/host-stats";
import type { RunnerInfo, RunnerPhone, RunnerToolchains } from "@agenteschat/adapters/machine-protocol";
import type { Term } from "@agenteschat/setup/src/term";
import { TOOL_LABELS } from "./access";
import { effectiveAccess, readStoredConfig } from "./config";
import { shortTime } from "./daemon";
import { errnoCode } from "./errors";
import { detectExecutors } from "./executors";
import { pidAlive, readLock } from "./lock";
import { labelOf, PhoneManager, POLL_MS, phoneNotReady } from "./phones";
import { probeToolchains } from "./toolchains";

/**
 * `agentes-runner doctor`: what this computer gives agents, and what needs the person. It only looks: its
 * connections (the default home and the agentes app's, `<home>/orgs/*`), the agent apps on the PATH, the toolchains,
 * and the phones, worded as the phone ops word them. With `wait` it looks at what needs the person every `POLL_MS`
 * until nothing does.
 */

type Executors = NonNullable<RunnerInfo["executors"]>;

export interface DoctorConnection {
  home: string;
  name: string;
  server: string;
  org: string;
  running: boolean;
  managedBy?: "desktop" | "host";
  system: boolean;
  commands: boolean;
}

export interface DoctorPhone extends RunnerPhone {
  /** Held by a runner of this OS user since then (ISO). */
  inUseSince?: string;
}

export interface DoctorSources {
  platform: NodeJS.Platform;
  /** "macOS 26.1 · Apple M3 Pro · 12 CPU · 36 GB". */
  system: string;
  user: string;
  /** Null: this user can't read the runner's home (system mode's is root's alone). */
  connections(): DoctorConnection[] | null;
  apps(): Promise<Executors>;
  toolchains(): Promise<RunnerToolchains>;
  phones(): Promise<DoctorPhone[]>;
}

export interface Check {
  key: string;
  /** `needs`: the person has to do something before agents can use it. */
  status: "ok" | "needs" | "skip";
  title: string;
  /** Facts, quiet under it. */
  detail: string[];
  /** What to do (with `needs`), and the command for it. */
  fix?: string;
  command?: string;
  /** "Developer Mode on Sam's iPhone 16": what a wait waits for. None: waiting wouldn't change it. */
  waitFor?: string;
}

const deviceWord = (platform: NodeJS.Platform) =>
  platform === "darwin" ? "Mac" : platform === "win32" ? "PC" : "computer";

function connectionChecks(s: DoctorSources): Check[] {
  const list = s.connections();
  const word = deviceWord(s.platform);
  if (list === null) {
    return [
      {
        key: "computer",
        status: "needs",
        title: `Only root can see this ${word}'s connection`,
        detail: [s.system],
        fix: "Run it as root:",
        command: "sudo agentes-runner doctor",
      },
    ];
  }
  if (list.length === 0) {
    return [
      {
        key: "computer",
        status: "needs",
        title: `This ${word} isn't connected to a workspace`,
        detail: [s.system],
        fix: "Connect it in agentes.chat, under Settings › Devices.",
      },
    ];
  }
  return list.map((c, i): Check => {
    const where = c.org || c.server;
    const facts = [
      ...(i === 0 ? [s.system] : []),
      c.system
        ? `${c.server} · each agent works here as a user of its own`
        : `${c.server} · ${c.commands ? `commands run as ${s.user}` : "commands off"}`,
    ];
    if (c.running)
      return { key: `computer:${c.home}`, status: "ok", title: `${c.name}, connected to ${where}`, detail: facts };
    return {
      key: `computer:${c.home}`,
      status: "needs",
      title: `${c.name} is connected to ${where} but isn't running`,
      detail: facts,
      waitFor: `${c.name} to start`,
      ...(c.managedBy === "desktop"
        ? { fix: "Open the agentes.chat app." }
        : c.managedBy === "host"
          ? { fix: "This server's own computer keeps it: check that its service runs." }
          : { fix: "Run it in the background:", command: "agentes-runner service install" }),
    };
  });
}

/** `2.1.4 (Claude Code)` → `2.1.4`. */
const versionOf = (line: string) => /\d+(?:\.\d+)+/.exec(line)?.[0] ?? line;

const APPS = ["claude", "codex", "cursor", "opencode", "grok", "antigravity"] as const;

function appChecks(found: Executors): Check[] {
  const checks = APPS.flatMap((name): Check[] => {
    const app = found[name];
    if (!app) return [];
    const title = `${TOOL_LABELS[name]} ${versionOf(app.version)}`;
    if (app.loggedIn === false)
      return [{ key: `app:${name}`, status: "skip", title: `${title}, not signed in`, detail: [] }];
    return [{ key: `app:${name}`, status: "ok", title: app.loggedIn ? `${title}, signed in` : title, detail: [] }];
  });
  if (checks.length) return checks;
  const names = APPS.map((a) => TOOL_LABELS[a]);
  return [{ key: "apps", status: "skip", title: `No agent apps here (${names.join(", ")})`, detail: [] }];
}

const TOOLCHAINS = [
  ["xcode", "Xcode"],
  ["java", "JDK"],
  ["androidSdk", "Android SDK"],
  ["adb", "adb"],
  ["maestro", "Maestro"],
  ["scrcpy", "scrcpy"],
  ["git", "Git"],
  ["node", "Node"],
] as const;

function toolchainChecks(t: RunnerToolchains, platform: NodeJS.Platform): Check[] {
  const checks: Check[] = [];
  const missing: string[] = [];
  for (const [key, label] of TOOLCHAINS) {
    if (key === "xcode" && platform !== "darwin") continue;
    const value = t[key];
    if (!value) missing.push(label);
    // The SDK is a folder, not a version.
    else if (key === "androidSdk") checks.push({ key: `tool:${key}`, status: "ok", title: label, detail: [value] });
    else checks.push({ key: `tool:${key}`, status: "ok", title: `${label} ${value}`, detail: [] });
  }
  if (missing.length)
    checks.push({ key: "tools", status: "skip", title: `Not found: ${missing.join(", ")}`, detail: [] });
  return checks;
}

/** What a wait for each reason waits for ("Waiting for Developer Mode on Sam's iPhone 16"). */
const WAIT_FOR: Partial<Record<NonNullable<RunnerPhone["reason"]>, (phone: string) => string>> = {
  unauthorized: (phone) => `USB debugging to be allowed on ${phone}`,
  untrusted: (phone) => `Trust on ${phone}`,
  developer_mode_off: (phone) => `Developer Mode on ${phone}`,
  locked: (phone) => `${phone} to be unlocked`,
};

function phoneChecks(phones: DoctorPhone[]): Check[] {
  if (phones.length === 0) return [{ key: "phones", status: "skip", title: "No phones attached", detail: [] }];
  return phones.map((p): Check => {
    const key = `phone:${p.platform}:${p.serial}`;
    const label = labelOf(p);
    const system = p.osVersion ? `${p.platform === "ios" ? "iOS" : "Android"} ${p.osVersion}` : null;
    const link =
      p.transport === "usb"
        ? "USB"
        : p.transport === "wifi"
          ? "Wi-Fi"
          : p.kind === "simulator"
            ? "Simulator"
            : p.kind === "emulator"
              ? "Emulator"
              : null;
    const facts = [[system, link].filter(Boolean).join(" · ")].filter(Boolean);
    const problem = phoneNotReady(p);
    if (!problem) {
      const now = p.inUseSince ? `in use since ${shortTime(p.inUseSince)}` : "ready";
      return { key, status: "ok", title: `${label}: ${now}`, detail: facts };
    }
    // Nothing the person can do: it ends by itself (an emulator still starting), or never (an Android too old).
    if (p.state === "preparing" || p.state === "unsupported")
      return { key, status: "skip", title: `${problem.title}. ${problem.fix}`, detail: [] };
    const waitFor = (p.reason && WAIT_FOR[p.reason]?.(label)) || label;
    return {
      key,
      status: "needs",
      title: problem.title,
      detail: [],
      fix: problem.fix,
      ...(p.state === "needs_you" ? { waitFor } : {}),
    };
  });
}

function show(term: Term, c: Check) {
  if (c.status === "ok") term.step(c.title, ...c.detail);
  else if (c.status === "skip") term.skipped(c.title);
  else {
    term.fail(c.title, c.fix);
    if (c.command) term.command(c.command);
    if (c.detail.length) term.quiet(c.detail);
  }
}

const needing = (checks: Check[]) => checks.filter((c) => c.status === "needs");
const ending = (n: number) => (n === 0 ? "Every check passed" : `${n} ${n === 1 ? "thing needs" : "things need"} you`);

export interface DoctorOptions {
  term: Term;
  sources: DoctorSources;
  /** Keep looking at what needs the person until nothing does (what waiting can change). */
  wait: boolean;
  /** One JSON object on `write`, once it's settled, instead of the lines. */
  json?: boolean;
  write?: (text: string) => void;
  pollMs?: number;
}

/** 0 when nothing needs the person, 1 otherwise. */
export async function runDoctor(o: DoctorOptions): Promise<number> {
  const { term, sources } = o;
  const print = o.json ? () => undefined : (c: Check) => show(term, c);
  if (!o.json) term.intro(`check this ${deviceWord(sources.platform)}`, false);
  const [apps, toolchains, firstPhones] = await Promise.all([sources.apps(), sources.toolchains(), sources.phones()]);
  let phones = firstPhones;
  const fixed = [...appChecks(apps), ...toolchainChecks(toolchains, sources.platform)];
  // What a wait looks at again: the connections and the phones.
  let live = [...connectionChecks(sources), ...phoneChecks(phones)];
  const all = () => [
    ...live.filter((c) => c.key.startsWith("computer")),
    ...fixed,
    ...live.filter((c) => c.key.startsWith("phone")),
  ];
  for (const c of all()) print(c);
  const waitable = () => needing(live).filter((c) => c.waitFor);
  if (o.wait && waitable().length) {
    const label = () => `Waiting for ${waitable()[0]?.waitFor}`;
    const spinner = o.json ? null : term.spin(label(), "Ctrl-C to stop");
    while (waitable().length) {
      await sleep(o.pollMs ?? POLL_MS);
      phones = await sources.phones();
      const before = new Map(live.map((c) => [c.key, c]));
      live = [...connectionChecks(sources), ...phoneChecks(phones)];
      for (const c of live) {
        const was = before.get(c.key);
        // Fixed, newly needing the person, or needing something else now (an iPhone trusted, then Developer Mode).
        if (was?.status === "needs" ? c.status !== "needs" || c.fix !== was.fix : c.status === "needs") print(c);
      }
      spinner?.update(label());
    }
    if (!o.json) term.close();
  }
  const checks = all();
  const needs = needing(checks).length;
  if (o.json) {
    o.write?.(`${JSON.stringify({ ok: needs === 0, needsYou: needs, checks, apps, toolchains, phones })}\n`);
  } else {
    term.gap();
    term.end(ending(needs));
  }
  return needs === 0 ? 0 : 1;
}

// ── What it looks at, on this computer ──────────────────────────────────────────

/** "macOS 26.1", "Ubuntu 24.04", "Windows 11". */
function systemName(platform: NodeJS.Platform): string {
  if (platform === "darwin") {
    const v = spawnSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).stdout?.trim();
    return v ? `macOS ${v}` : "macOS";
  }
  if (platform === "win32") return Number(os.release().split(".")[2]) >= 22000 ? "Windows 11" : "Windows 10";
  if (platform === "linux") {
    try {
      const text = readFileSync("/etc/os-release", "utf8");
      const field = (k: string) => new RegExp(`^${k}="?([^"\\n]+)`, "m").exec(text)?.[1];
      return [field("NAME"), field("VERSION_ID")].filter(Boolean).join(" ") || "Linux";
    } catch {
      return "Linux";
    }
  }
  return os.type();
}

/** `AMD Ryzen 9 7950X 16-Core Processor` → `AMD Ryzen 9 7950X`; `Intel(R) Xeon(R) CPU E5-2680 @ 2.40GHz` → `Intel Xeon E5-2680`. */
export const cpuName = (model: string) =>
  model
    .replace(/\((R|TM)\)/gi, "")
    .replace(/\s*@.*$/, "")
    .replace(/\s+\d+-Core Processor$/i, "")
    .replace(/\bCPU\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

export function systemLine(platform: NodeJS.Platform = process.platform): string {
  const size = machineSize(os.homedir());
  const cpu = cpuName(os.cpus()[0]?.model ?? "");
  return [systemName(platform), cpu, `${size.cpus} CPU`, `${size.memoryGb} GB`].filter(Boolean).join(" · ");
}

/** The connections kept here: `home`'s, and the agentes app's and this server's own (`<home>/orgs/*`, `<home>/host/orgs/*`). */
export function connections(home: string): DoctorConnection[] | null {
  try {
    accessSync(home, constants.R_OK | constants.X_OK);
  } catch (err) {
    if (errnoCode(err) === "EACCES") return null;
  }
  const sub = (dir: string) => {
    try {
      return readdirSync(dir).map((name) => path.join(dir, name));
    } catch {
      return [];
    }
  };
  const homes = [home, ...sub(path.join(home, "orgs")), ...sub(path.join(home, "host", "orgs"))];
  return homes.flatMap((h): DoctorConnection[] => {
    let stored: ReturnType<typeof readStoredConfig>;
    try {
      stored = readStoredConfig(h);
    } catch {
      return [];
    }
    if (!stored?.token || !stored.server) return [];
    const lock = readLock(h);
    return [
      {
        home: h,
        name: stored.name ?? os.hostname(),
        server: stored.server,
        org: stored.orgName ?? "",
        running: lock !== null && pidAlive(lock.pid),
        ...(stored.managedBy ? { managedBy: stored.managedBy } : {}),
        system: stored.mode === "system",
        commands: effectiveAccess(stored).tools.commands,
      },
    ];
  });
}

/** The sources on this computer: the phones through a manager that only looks. */
export function localSources(home: string): DoctorSources {
  const phones = new PhoneManager({
    log: () => undefined,
    onChange: () => undefined,
    caffeinate: false,
    readOnly: true,
  });
  return {
    platform: process.platform,
    system: systemLine(),
    user: os.userInfo().username,
    connections: () => connections(home),
    apps: async () => (await detectExecutors()).found,
    toolchains: () => probeToolchains(),
    phones: async () => {
      await phones.poll();
      return phones.list().map((p) => {
        const since = phones.heldElsewhere(p);
        return since ? { ...p, inUseSince: since } : p;
      });
    },
  };
}

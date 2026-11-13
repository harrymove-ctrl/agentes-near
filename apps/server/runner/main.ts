/**
 * agentes-runner: connects this computer to an agentes.chat organization
 * (ADR 0025). Bundled to one file for Node.js 22+ and Bun:
 *   bun build apps/server/runner/main.ts --target=node --banner '#!/usr/bin/env node' --outfile apps/web/dist/runner/agentes-runner.mjs
 * or compiled to one executable for the desktop app (ADR 0036), no runtime needed:
 *   bun build --compile --target=bun-darwin-arm64 apps/server/runner/main.ts --outfile agentes-runner
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type AgentScope,
  browserNeeded,
  MACHINE_PROTOCOL_VERSION,
  type RunnerTools,
} from "@agenteschat/adapters/machine-protocol";
import { createTerm, type Spinner, type Term } from "@agenteschat/setup/src/term";
import {
  addFolder,
  ControlError,
  checkFolder,
  readAgents,
  removeFolder,
  resolveAgentHandle,
  setTool,
  TOOL_LABELS,
  TOOL_NAMES,
} from "./access";
import { type AgentUser, AgentUsers, agentGid, denySchedulers, systemLauncher } from "./agent-users";
import { findChrome } from "./browser";
import {
  POLICY_NOT_IN_FORCE_EXIT,
  PolicyNotInForce,
  parseBindCheck,
  verifyBrowserBindPolicy,
} from "./browser-bind-check";
import { ensureBrowserBindPolicy, prepareAgents } from "./browser-bind-policy";
import { browserPortsForUid } from "./browser-ports";
import { computerNow } from "./computer-now";
import {
  accessToStore,
  configPath,
  DEFAULT_AGENT_UID_RANGE,
  effectiveAccess,
  expandHome,
  normalizeServerUrl,
  pairedConfig,
  parseService,
  parseUidRange,
  readConfig,
  readStoredConfig,
  runnerHome,
  type StoredConfig,
  updateConfig,
  writeConfig,
} from "./config";
import { TOKEN_REFUSED_EXIT } from "./connection";
import { runControl } from "./control";
import { configFromGrant, deviceInfo, prepareWorkspace, previousMachineFor, RunnerDaemon } from "./daemon";
import { DesktopManager } from "./desktop";
import { runDesktopBrowser } from "./desktop-browser";
import { DesktopSessions, type DesktopSessionsOptions, runnerUser, systemDesktopUser } from "./desktop-session";
import { localSources, runDoctor } from "./doctor";
import { RUNNER_VERSION } from "./errors";
import { defaultHostState, HostComputer, readTokenFile, runnerChild } from "./host";
import { writeJson } from "./json-file";
import { hasBunTerminal, runningCompiled, thisRunner } from "./launch";
import { acquireLock, lockedMessage, pidAlive, readLock } from "./lock";
import { RotatingFile } from "./logfile";
import { adoptLoginPath } from "./login-path";
import { LoopbackGuard, loopbackEndpoints, runnerEndpoints } from "./loopback-guard";
import { MCP_TOKEN_FILE, mcpSocketPath, runMcpRelay, runMcpServer } from "./mcp";
import {
  type DeviceGrant,
  devicePair,
  formatUserCode,
  LINK_CODE,
  PairingError,
  redeemIssuedCode,
  takeEnrollCode,
  whoCanUse,
} from "./pairing";
import { agentWorkspace } from "./paths";
import { connectVnc, type VncConnection, vncInit } from "./rfb";
import { installService, installSystemService, serviceStatus, uninstallService } from "./service";
import type { DataListener, DataSocket } from "./streams";
import { runTaskWrapper } from "./tasks";
import { runnerTerminalUser, systemTerminalUser, Terminals, type TerminalsOptions } from "./terminal";
import { probeToolchains, TOOLCHAINS_FILE } from "./toolchains";
import { runWorker } from "./worker";

const HELP = `agentes-runner ${RUNNER_VERSION}: connects this computer to agentes.chat

Usage:
  agentes-runner pair --server <url> [--dir <workspace>] [--name <name>] [--no-exec] [--new]
      Shows a code and a link. Confirm it on the site, signed in, and this computer is connected.
      Paired with that server before (even if it was removed there): it comes back as the same
      computer, with its name, permissions and agents, when you may manage it.
      --dir      the folder agents work in (default ~/agentes)
      --no-exec  files and uploads only (agents can't run commands)
      --new      connect as a new computer instead
  agentes-runner pair --server <url> --enroll-file <path> [--dir <workspace>] [--name <name>] [--no-exec]
      Connects with a code issued for this computer by whoever provisions it. Nobody confirms it.
      The file is removed as soon as it is read.
  agentes-runner pair --server <url> --link <code> [--dir <workspace>] [--name <name>] [--no-exec]
      Connects with the code of a link made under Settings > Devices (what curl <server>/i/<code> | sh
      runs). The link's maker lets this computer join, or says no.
  agentes-runner start
      Connects and stays connected (reconnects on its own).
  agentes-runner service install|uninstall
      Runs it in the background at login (systemd user unit, launchd agent, or Task Scheduler on Windows).
  agentes-runner service install --system [--agent-uid-range <first-last>] [--no-start]
      Linux, as root: the runner for the whole computer, each agent as its own user
      (uids 20000-29999 unless given). install.sh --system runs it.
  agentes-runner host --server <url> --token-file <path> | --token-env <NAME> [--state <dir>] [--name <name>] [--no-exec]
      This server's own computer (HOST_COMPUTER_TOKEN on the server, the same token here): one
      connection per organization of the person who installed the server, each agent as its own
      user on Linux (run it as root). Organizations come and go with the server, checked every minute.
      --state    where it keeps each organization's connection (default: the home, or <home>/host on a Mac)
      --no-exec  agents can't run commands here (Claude Code, Codex and the browser stay on)
  agentes-runner host --once --server <url> --token-file <path> [--state <dir>] [--name <name>] [--rotate <orgId>]...
      One sync for a program that runs the organizations' connections itself (the agentes.chat app):
      writes them, every tool off, as this computer's user (Linux included), starts nothing, and prints
      one JSON line: {"status", "homes": [{"orgId", "orgName", "machineId", "home", "new"}], "gone": [orgId]}.
      --state    where it writes them (default: the home, on a Mac too, where the app keeps its own)
      --rotate   asks for a new token for that organization's connection (the server refused its own)
  agentes-runner service install --host --server <url> --token-file <path> [--state <dir>] [--no-exec] [--no-start]
      Runs host as this computer's service: the root unit from boot on Linux, at login on macOS.
  agentes-runner update
      Downloads the latest runner from the server and restarts the service (keeps the pairing).
  agentes-runner status
      The connection, the service, and whether the agents' desktops and the terminal can run here.
  agentes-runner doctor [--wait | --no-wait] [--json]
      What this computer gives agents: its connections, the agent apps, the toolchains and the phones,
      with the fix for whatever needs you. On a terminal it then waits for those fixes (--wait anywhere,
      --no-wait never). Exits 0 when nothing needs you, 1 otherwise.
  agentes-runner computer
      What this computer has, what is free now, and which agents use the most of it (they share it).
      Agents run it before something heavy.
  agentes-runner folders [list | allow <path> [--agent <handle>]... | remove <path> [--agent <handle>]...]
      Folders agents may use besides their own (an agent's handle, as on the site).
  agentes-runner tools [list | enable <tool> | disable <tool>]
      Turns claude (Claude Code), codex (Codex), commands, browser, desktop or terminal on or off on
      this computer.
  agentes-runner services [list | allow <tcp|udp>/<port> | remove <tcp|udp>/<port>]
      System mode: what of this computer's own servers agents may reach besides DNS (an Ollama on
      tcp/11434, say). Each agent always reaches its own local ports, never another agent's.
  agentes-runner desktop-check --agent <handle>
      Checks an agent's desktop and terminal here (Linux): starts its desktop, logs in to it as the
      person in control and as a watcher (who can't move the pointer), reads it and acts on it the
      way the agent does (with how long each takes), opens a terminal as the agent, then stops what
      it started. Stop the runner first.
  agentes-runner app --home <dir>
      The desktop app's runner (a JSON-lines protocol on stdin/stdout, not for people).
  agentes-runner mcp --task <taskId> | --run <runId>
      The agentes MCP server of a mission task (started by Claude Code or Codex, not by people).
  agentes-runner worker --agent <id> --dir <folder> --home <dir>
      System mode: one agent's work, as that agent's own user (started by the runner, not by people).
  agentes-runner desktop-browser <socket>
      Browser on an agent's desktop: the agent's own browser there (started by that desktop, not by people).
  agentes-runner --help | --version

Every command takes --home <dir> (default $AGENTES_RUNNER_HOME or ~/.agentes-runner).
Config: <home>/config.json, mode 600. For background tasks, optional "maxConcurrentTasks" (default 3)
and "taskMaxSeconds" (default 14400). For agents thinking with Claude Code, optional "brainIdleMinutes"
(default 3) and "brainMaxProcesses" (default 1). Changes apply while it runs.
Background tasks keep running when the runner restarts. Their logs are in tasks/.
Commands run as the user that runs the runner. Consider a dedicated OS user.`;

const stamp = (line: string) => `${new Date().toISOString()} ${line}`;
const log = (line: string) => console.log(stamp(line));

interface Parsed {
  positional: string[];
  flags: Map<string, string | true>;
  /** Flags that may repeat (`--agent a --agent b`). */
  lists: Map<string, string[]>;
}

const VALUE_FLAGS = new Set([
  "server",
  "dir",
  "name",
  "task",
  "run",
  "home",
  "agent",
  "code",
  "agent-uid-range",
  "token-env",
  "token-file",
  "state",
  "enroll-file",
  "rotate",
  "link",
]);
const LIST_FLAGS = new Set(["agent", "rotate"]);

function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const lists = new Map<string, string[]>();
  const set = (key: string, value: string | true) => {
    flags.set(key, value);
    if (LIST_FLAGS.has(key) && typeof value === "string") lists.set(key, [...(lists.get(key) ?? []), value]);
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "-h") flags.set("help", true);
    else if (arg === "-v") flags.set("version", true);
    else if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const key = eq > 0 ? arg.slice(2, eq) : arg.slice(2);
      if (eq > 0) set(key, arg.slice(eq + 1));
      else if (VALUE_FLAGS.has(key)) {
        const value = argv[i + 1];
        if (value === undefined) throw new Error(`--${key} needs a value`);
        set(key, value);
        i++;
      } else set(key, true);
    } else positional.push(arg);
  }
  return { positional, flags, lists };
}

const flagString = (p: Parsed, key: string) => {
  const v = p.flags.get(key);
  return typeof v === "string" ? v : undefined;
};

const DESKTOP_MANAGED =
  "This computer's connection is managed by the agentes app. Use the app (it ships the runner and keeps it running).";
const HOST_MANAGED =
  "This connection is one organization's on this server's own computer: agentes-runner host keeps it (and its service). Turn it off for the organization on the site, in Settings > Computers.";

/** Why a command can't change this home: something else keeps it. Null when nothing does. */
const managedMessage = (stored: StoredConfig | null) =>
  stored?.managedBy === "desktop" ? DESKTOP_MANAGED : stored?.managedBy === "host" ? HOST_MANAGED : null;

function storedOrNull(home = runnerHome()): StoredConfig | null {
  try {
    return readStoredConfig(home);
  } catch {
    return null;
  }
}

/**
 * The device-code connection from a terminal (ADR 0036 §5): prints a code and a link, waits for the site.
 * With `--enroll-file`, redeems a code issued for this computer instead (ADR 0056 §10). Inside the
 * installer's frame (AGENTES_FRAME=1) it draws on its line and leaves the end to the installer.
 */
async function pair(p: Parsed): Promise<number> {
  const usage =
    "Usage: agentes-runner pair --server <url> [--enroll-file <path> | --link <code>] [--dir <workspace>] [--name <name>] [--no-exec] [--new]";
  const term = createTerm();
  term.intro("connect this computer");
  // Typed wide: the code's callback sets it, and TypeScript would keep it narrowed to null.
  let wait = null as Spinner | null;
  /** A refusal in its own words; without a terminal, the last line of stderr, where a provisioner reads why. */
  const refuse = (message: string) => {
    term.refuse(message);
    if (!term.inherited) term.stop();
    return 1;
  };
  let enrollCode: string | undefined;
  if (p.flags.has("enroll-file")) {
    // Taken first, so no failure below leaves the code on disk.
    try {
      enrollCode = takeEnrollCode(flagString(p, "enroll-file") ?? "");
    } catch (err) {
      return refuse(err instanceof Error ? err.message : String(err));
    }
  }
  const link = p.flags.has("link") ? (flagString(p, "link") ?? "") : undefined;
  if (link !== undefined && !LINK_CODE.test(link)) {
    return refuse("--link takes the code at the end of the link (like 7KQ2-M9XD)");
  }
  if (link !== undefined && enrollCode) return refuse("--link and --enroll-file each connect this computer: use one");
  if (p.flags.has("code")) {
    return refuse(
      "Pairing codes from the site are gone: run agentes-runner pair --server <url> and confirm the code it shows.",
    );
  }
  const serverRaw = flagString(p, "server");
  if (!serverRaw) return refuse(usage);
  let server: string;
  try {
    server = normalizeServerUrl(serverRaw);
  } catch (err) {
    return refuse(err instanceof Error ? err.message : String(err));
  }
  const home = runnerHome();
  const prev = storedOrNull(home);
  const managed = managedMessage(prev);
  if (managed) return refuse(managed);
  // Created only once the connection worked.
  const workspace = expandHome(flagString(p, "dir") ?? prev?.workspace ?? "~/agentes");
  const exec = !p.flags.has("no-exec");
  const name = flagString(p, "name");
  const ac = new AbortController();
  const onSignal = () => ac.abort();
  process.once("SIGINT", onSignal);
  // Looked at while the person confirms, so the first connection already says what this computer builds with.
  const toolchains = probeToolchains().catch(() => null);
  let grant: DeviceGrant;
  try {
    if (enrollCode) {
      wait = term.spin("Connecting with the code issued for this computer");
      grant = await redeemIssuedCode(server, enrollCode, { signal: ac.signal });
    } else {
      grant = await devicePair(
        server,
        {
          ...deviceInfo(name, p.flags.has("new") ? undefined : previousMachineFor(prev, server)),
          ...(link ? { link } : {}),
        },
        (code) => {
          if (link) {
            const who = code.maker ?? "the person who made the link";
            wait = term.spin(
              `Waiting for ${who} to let this computer join${code.orgName ? ` ${code.orgName}` : ""}…`,
              "Let it join under Settings › Devices.",
            );
            return;
          }
          term.info(
            `To connect this computer, open this link and confirm the code ${term.accent(formatUserCode(code.userCode))}:`,
          );
          term.command(code.verificationUrl);
          wait = term.spin(
            "Waiting for the confirmation",
            `The code expires in ${Math.max(1, Math.round(code.expiresIn / 60))} minutes.`,
          );
        },
        { signal: ac.signal },
      );
    }
  } catch (err) {
    if (err instanceof PairingError) {
      if (err.code === "canceled") {
        if (wait) wait.fail("Canceled");
        else term.fail("Canceled");
        // An installer that started this stops on 130 without a word: this closes the frame.
        term.end();
        return 130;
      }
      if (enrollCode) return refuse(err.message);
      if (link && err.code === "denied")
        return refuse("The link's maker didn't let this computer join. Nothing changed.");
      if (link && err.code === "expired") {
        return refuse("Nobody let this computer join in time. Make a new link under Settings › Devices.");
      }
      if (err.code === "denied") return refuse("The connection was refused on the site. Nothing changed.");
      if (err.code === "expired") return refuse("The code expired before it was confirmed. Run this again.");
      return refuse(err.message);
    }
    throw err;
  } finally {
    process.off("SIGINT", onSignal);
  }
  const workspaceReal = prepareWorkspace(workspace);
  const next = configFromGrant(prev, {
    server,
    grant,
    workspace: workspaceReal,
    ...(name ? { name } : {}),
    tools: { claude: exec, codex: exec, cursor: exec, opencode: exec, grok: exec, antigravity: exec, commands: exec },
    desktop: false,
  });
  writeConfig(next, home);
  const found = await toolchains;
  if (found) {
    try {
      writeJson(path.join(home, TOOLCHAINS_FILE), found);
    } catch {
      // the first session looks again
    }
  }
  const connected = `Connected${grant.org.name ? ` to ${grant.org.name}` : ""} as "${next.name}"`;
  const details = [`Workspace: ${workspaceReal}${exec ? "" : " (commands off)"}`, `Config: ${configPath(home)}`];
  if (wait) wait.done(connected, ...details);
  else term.step(connected, ...details);
  // An issued code is a provisioner's (the workspace computer): its rule is the workspace's, not a person's choice.
  const who = enrollCode ? null : whoCanUse(grant, next.name ?? grant.name);
  if (who && grant.url) {
    term.info(`${who} Change it on its page:`);
    term.command(grant.url);
  }
  // Agents run as this OS user unless each has its own (system mode), so other people's read this user's files.
  if (who && grant.audience !== "owner" && next.mode !== "system" && exec) {
    const user = os.userInfo().username;
    term.warn(`Other people's agents will run as ${user} and can read ${user}'s files.`);
  }
  if (!term.inherited) {
    term.gap();
    term.info("Next: start it, or run it in the background");
    term.command("agentes-runner start");
    term.command("agentes-runner service install");
    term.gap();
    term.end("Done");
  }
  return 0;
}

async function start(): Promise<number> {
  const home = runnerHome();
  const config = readConfig(home);
  if (!config) {
    console.error(`This computer isn't connected yet (${configPath(home)}). Run: agentes-runner pair --server <url>`);
    return 1;
  }
  if (typeof WebSocket === "undefined") {
    console.error(`This runtime has no WebSocket client (${process.version}). Use Node.js 22 or newer, or Bun.`);
    return 1;
  }
  const lock = acquireLock(home, "start");
  if (!lock.ok) {
    console.error(lockedMessage(home, lock.holder));
    return serviceSafe(4);
  }
  const daemon = new RunnerDaemon({ home, mode: "start", log, print: (line) => console.log(line) });
  const stop = () => void daemon.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const outcome = await daemon.runStart();
    switch (outcome.reason) {
      case "stopped":
        log("stopped");
        return 0;
      case "replaced":
        log("Another runner connected with this computer's token and took over. This one stops.");
        return 0;
      case "outdated":
        log("This runner is too old for the server. Update it: agentes-runner update");
        return serviceSafe(3);
      default:
        log("Connect this computer again: agentes-runner pair --server <url>");
        return serviceSafe(TOKEN_REFUSED_EXIT);
    }
  } finally {
    await daemon.stop();
    lock.release();
  }
}

/** Under launchd (KeepAlive unless it exits cleanly), a refusal exits 0 so it isn't restarted in a loop. */
function serviceSafe(code: number) {
  return process.env.AGENTES_RUNNER_SERVICE === "launchd" ? 0 : code;
}

/**
 * `agentes-runner app`: the desktop app's child (ADR 0036 §3). stdout is the
 * control protocol only; everything that would be printed goes to the log.
 */
async function app(): Promise<number> {
  const home = runnerHome();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const logFile = path.join(home, "logs", "runner.log");
  const file = new RotatingFile(logFile);
  const write = (line: string) => {
    try {
      file.append(`${stamp(line)}\n`);
    } catch {
      // a full disk never stops the runner
    }
  };
  // Nothing but protocol lines on stdout, whatever a module prints.
  const toLog = (...args: unknown[]) => write(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
  console.log = toLog;
  console.info = toLog;
  console.warn = toLog;
  console.debug = toLog;
  console.error = toLog;
  process.stdout.on("error", () => {});
  const lock = acquireLock(home, "app");
  const ac = new AbortController();
  process.once("SIGTERM", () => ac.abort());
  process.once("SIGINT", () => ac.abort());
  write(`agentes-runner ${RUNNER_VERSION} (app mode, home ${home})`);
  // Opened from Finder: the bare macOS PATH finds neither the coding CLIs nor the person's tools.
  adoptLoginPath(write);
  try {
    return await runControl({
      home,
      input: process.stdin,
      output: process.stdout,
      locked: lock.ok ? null : lock.holder,
      daemon: { log: write, logFile, refreshPath: () => adoptLoginPath() },
      signal: ac.signal,
    });
  } finally {
    if (lock.ok) lock.release();
  }
}

/**
 * `agentes-runner worker` (system mode): stdout is the link to the root
 * runner, so it carries frames only; anything printed goes to stderr, which
 * the root runner logs.
 */
async function worker(p: Parsed): Promise<number> {
  const agentId = flagString(p, "agent");
  const dir = flagString(p, "dir");
  if (!agentId || !dir || !flagString(p, "home")) {
    console.error("Usage: agentes-runner worker --agent <id> --dir <folder> --home <dir>");
    return 1;
  }
  if (process.getuid?.() === 0) {
    console.error("A worker runs as its agent's own user, never as root.");
    return 1;
  }
  const toStderr = (...args: unknown[]) =>
    process.stderr.write(`${args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ")}\n`);
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  process.stdout.on("error", () => {});
  return runWorker({
    agentId,
    browserPorts: browserPortsForUid(process.getuid?.() ?? 0),
    home: runnerHome(),
    dir: expandHome(dir),
    input: process.stdin,
    output: process.stdout,
    // The root runner's log stamps it.
    log: (line) => toStderr(line),
  });
}

/** Internal kernel self-check run by root in the candidate agent slice; prints the /tmp it sees for root to check. */
async function bindCheck(args: string[]): Promise<number> {
  const check = parseBindCheck(args);
  if (!check || process.getuid?.() === 0) {
    console.error("bind-check runs as an agent, started by the runner");
    return 1;
  }
  try {
    console.log(`tmp ${await verifyBrowserBindPolicy(check)}`);
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return err instanceof PolicyNotInForce ? POLICY_NOT_IN_FORCE_EXIT : 1;
  }
}

const HOST_USAGE =
  "Usage: agentes-runner host [--once] --server <url> --token-file <path> | --token-env <NAME> [--state <dir>] [--name <name>] [--no-exec] [--rotate <orgId>]...";

/** `host`'s own flags, checked, for the command and for its service. */
function hostFlags(p: Parsed, defaultState = defaultHostState()) {
  const server = flagString(p, "server");
  const tokenFile = flagString(p, "token-file");
  const tokenEnv = flagString(p, "token-env");
  if (!server || (tokenFile === undefined) === (tokenEnv === undefined)) return null;
  return {
    server: normalizeServerUrl(server),
    tokenFile: tokenFile === undefined ? undefined : path.resolve(expandHome(tokenFile)),
    tokenEnv,
    state: path.resolve(expandHome(flagString(p, "state") ?? defaultState)),
    name: flagString(p, "name"),
    exec: !p.flags.has("no-exec"),
  };
}

/** Whether this computer can be the server's computer, and why not. */
function hostRefusal(): string | null {
  if (process.platform === "win32") return "The server's computer runs on Linux or macOS.";
  return null;
}

/**
 * Whether `host` runs its agents each as its own user (system mode): on Linux as root. On Linux as another user it is
 * the simple mode the self-host setup offers where system mode can't run (no BPF_FRAMEWORK, ADR 0153 §5): its agents
 * share that user, as on a Mac.
 */
const hostSystemMode = () => process.platform === "linux" && process.getuid?.() === 0;

/** `agentes-runner host`: this server's own computer (`host.ts`). */
async function host(p: Parsed): Promise<number> {
  const once = p.flags.has("once");
  // `--once` writes the homes the agentes app runs itself, and the app keeps those in the home on a Mac too.
  const flags = once ? hostFlags(p, runnerHome()) : hostFlags(p);
  if (!flags) {
    console.error(HOST_USAGE);
    return 1;
  }
  if (once) return hostOnce(flags, p.lists.get("rotate") ?? []);
  const refusal = hostRefusal();
  if (refusal) {
    console.error(refusal);
    return 1;
  }
  // Read once, then out of the environment: the organizations' runners (and their agents) never see it.
  const envToken = flags.tokenEnv ? process.env[flags.tokenEnv]?.trim() || null : null;
  if (flags.tokenEnv) delete process.env[flags.tokenEnv];
  const lock = acquireLock(flags.state, "host");
  if (!lock.ok) {
    console.error(lockedMessage(flags.state, lock.holder));
    return 4;
  }
  const system = hostSystemMode();
  const computer = new HostComputer({
    server: flags.server,
    token: () => (flags.tokenFile ? readTokenFile(flags.tokenFile) : envToken),
    state: flags.state,
    name: flags.name ?? os.hostname(),
    system,
    exec: flags.exec,
    log,
    start: runnerChild(thisRunner(), (line) => console.log(line)),
  });
  // One guard for every organization's agents: a guard per child would replace the others' table with its own.
  // Agents reach the server itself where it is on this computer (its git proxy, its pages).
  const guard = system
    ? new LoopbackGuard({
        home: flags.state,
        agentUids: () => computer.agentUids(),
        uidRange: DEFAULT_AGENT_UID_RANGE,
        services: () => [
          ...(storedOrNull(flags.state)?.services ?? []),
          ...runnerEndpoints(),
          ...loopbackEndpoints([flags.server]),
        ],
        log,
      })
    : null;
  const stop = () => void computer.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  log(`agentes-runner ${RUNNER_VERSION}: this server's computer for ${flags.server} (${flags.state})`);
  try {
    guard?.start();
    if (system) {
      const policy = { uidRange: DEFAULT_AGENT_UID_RANGE, refresh: () => void guard?.reconcile() };
      const prepare = (user: AgentUser) => {
        denySchedulers(user.user);
        ensureBrowserBindPolicy(user, thisRunner(), policy);
      };
      prepareAgents(computer.agentUsers(), prepare, policy, log);
    }
    await computer.run();
    log("stopped");
    return 0;
  } finally {
    guard?.stop();
    lock.release();
  }
}

/**
 * `host --once`: the sync of the desktop app, which runs the homes' runners itself. Single-user homes
 * everywhere, so as the person on Linux too (system mode stays root's service).
 */
async function hostOnce(flags: NonNullable<ReturnType<typeof hostFlags>>, rotate: string[]): Promise<number> {
  const envToken = flags.tokenEnv ? process.env[flags.tokenEnv]?.trim() || null : null;
  const computer = new HostComputer({
    server: flags.server,
    token: () => (flags.tokenFile ? readTokenFile(flags.tokenFile) : envToken),
    state: flags.state,
    name: flags.name ?? os.hostname(),
    system: false,
    exec: false,
    rotate,
    // stdout is the one JSON line.
    log: (line) => console.error(stamp(line)),
    start: () => {
      throw new Error("host --once starts nothing");
    },
  });
  console.log(JSON.stringify(await computer.once()));
  return 0;
}

/** `service install --host`: `agentes-runner host` as this computer's service (the token from a file). */
function installHost(p: Parsed, print: (line: string) => void): number {
  const flags = hostFlags(p);
  if (!flags?.tokenFile) {
    print(
      "Usage: agentes-runner service install --host --server <url> --token-file <path> [--state <dir>] [--no-exec] [--no-start]",
    );
    return 1;
  }
  const refusal = hostRefusal();
  if (refusal) {
    print(refusal);
    return 1;
  }
  const args = [
    "host",
    "--server",
    flags.server,
    "--token-file",
    flags.tokenFile,
    "--state",
    flags.state,
    ...(flags.name ? ["--name", flags.name] : []),
    ...(flags.exec ? [] : ["--no-exec"]),
  ];
  if (hostSystemMode()) return installSystemService({ print, args, start: !p.flags.has("no-start") });
  return installService({ print, args });
}

/**
 * What the service functions print, drawn: the first line ◇ (■ when it failed), the rest quiet, and the lines
 * they indent as commands. Inside the installer's frame it draws on its line; by hand, in a frame of its own.
 * `done` is a step that went well before `run`, `warning` what went less well after it.
 */
function printed(
  term: Term,
  title: string,
  run: (print: (line: string) => void) => number,
  done?: string,
  warning?: string,
): number {
  term.intro(title, false);
  if (done) term.step(done);
  const lines: string[] = [];
  const code = run((line) => lines.push(line));
  const [first, ...rest] = lines;
  if (first !== undefined) {
    if (code === 0) term.step(first);
    else term.fail(first);
  }
  for (const line of rest) {
    if (line.startsWith("  ")) term.command(line.trim());
    else term.text(line, true);
  }
  if (warning) term.warn(warning);
  if (!term.inherited) {
    if (code !== 0) term.stop();
    else {
      term.gap();
      term.end("Done");
    }
  }
  return code;
}

/** Replaces this script with the server's latest bundle; the pairing and the workspace stay. */
async function update(): Promise<number> {
  const term = createTerm();
  const refuse = (message: string) => {
    term.intro("update", false);
    term.refuse(message);
    if (!term.inherited) term.stop();
    return 1;
  };
  const stored = storedOrNull();
  if (stored?.managedBy === "desktop")
    return refuse(`${DESKTOP_MANAGED} To update, install the new version of the app.`);
  if (stored?.managedBy === "host") return refuse(HOST_MANAGED);
  // A root runner never replaces itself with whatever the server sends.
  if (stored?.mode === "system") {
    return refuse(
      `This computer runs the runner for all its agents: update it with the installer, as root (curl -fsSL ${stored.server ?? "<server>"}/api/machines/install.sh | sh -s -- --system).`,
    );
  }
  if (runningCompiled()) {
    return refuse(
      "This runner is a single executable: install its new version instead (agentes-runner update replaces the script only).",
    );
  }
  const config = readConfig();
  if (!config) return refuse("Not connected yet: run the install command from Settings > Computers.");
  const script = thisRunner()[1] ?? "";
  const url = `${config.server}/runner/agentes-runner.mjs`;
  const res = await fetch(url);
  if (!res.ok) return refuse(`Download failed: ${res.status} ${url}`);
  const text = await res.text();
  if (!text.startsWith("#!") || !text.includes("agentes-runner")) {
    return refuse(`${url} doesn't look like the runner. Nothing changed.`);
  }
  writeFileSync(`${script}.new`, text, { mode: 0o755 });
  renameSync(`${script}.new`, script);
  // Runners from ADR 0133 on drive the computer's own Google Chrome (Chromium on Linux on ARM, ADR 0153), which this
  // user can't install.
  const chrome = findChrome() ? undefined : browserNeeded();
  if (!serviceStatus()) {
    return printed(
      term,
      "update",
      (print) => {
        print(`Updated ${script}.`);
        print("Restart the runner (agentes-runner start) to use it.");
        return 0;
      },
      undefined,
      chrome,
    );
  }
  return printed(term, "update", (print) => installService({ print }), `Updated ${script}.`, chrome);
}

function status(): number {
  const term = createTerm();
  const home = runnerHome();
  const stored = storedOrNull(home);
  const config = readConfig(home);
  const bun = (process.versions as { bun?: string }).bun;
  term.intro(
    `agentes-runner ${RUNNER_VERSION} (protocol ${MACHINE_PROTOCOL_VERSION}) on ${bun ? `bun ${bun}` : `${process.release.name} ${process.version}`}${runningCompiled() ? " (compiled)" : ""}`,
    false,
  );
  if (config) {
    term.step(
      `Connected${stored?.orgName ? ` to ${stored.orgName}` : ""} as "${config.name}"`,
      `${config.server} · workspace ${config.workspace}`,
    );
  } else term.fail("Not connected.");
  const holder = readLock(home);
  if (holder && pidAlive(holder.pid)) term.step(`Running: pid ${holder.pid}${holder.mode ? ` (${holder.mode})` : ""}`);
  else term.warn("Running: no");
  const service = serviceStatus(undefined, stored?.mode === "system");
  // systemd says how the unit is ("(active)", "(inactive)", "(failed)"); launchd and Windows only that it's there.
  if (service && (service.endsWith("(active)") || !service.endsWith(")"))) term.step(`Service: ${service}`);
  else term.warn(service ? `Service: ${service}` : "Service: not installed");
  printDesktopAndTerminal(term, home, stored ? effectiveAccess(stored).tools : undefined, stored?.mode === "system");
  term.gap();
  term.text(`Config: ${configPath(home)}`, true);
  if (stored) {
    const { token: _token, ...visible } = stored;
    term.quiet(JSON.stringify(visible, null, 2).split("\n"));
  }
  term.end();
  return 0;
}

/**
 * `status`: whether the agents' desktops and the terminal can run here (what `hello` tells the server), and
 * their switches. In system mode root runs them as each agent's own user, so being root is no reason.
 */
function printDesktopAndTerminal(term: Term, home: string, tools: RunnerTools | undefined, agentUsers: boolean) {
  const log = () => undefined;
  const infos = [
    [
      "desktop",
      "Desktops",
      new DesktopSessions({ home, log, user: async (a) => runnerUser(home, home, a), agentUsers }).info(),
    ],
    ["terminal", "Terminal", new Terminals({ log, user: async () => runnerTerminalUser(home), agentUsers }).info()],
  ] as const;
  for (const [tool, label, info] of infos) {
    if (!info.available) term.warn(`${label}: unavailable: ${info.reason}`);
    else if (tools?.[tool]) term.step(`${label}: on`);
    else term.warn(`${label}: off (agentes-runner tools enable ${tool})`);
  }
  if (!hasBunTerminal() && !runningCompiled() && process.platform !== "win32") {
    term.text(
      "The install command from Settings > Computers, run again, puts the runner on Bun 1.3.5 or newer (this computer stays connected).",
      true,
    );
  }
}

/** For `folders` and `tools`: the paired config, or a message. */
function pairedOrExit(home: string) {
  const stored = storedOrNull(home);
  const config = stored ? pairedConfig(stored, configPath(home)) : null;
  if (!config || !stored) {
    console.error("This computer isn't connected yet. Run: agentes-runner pair --server <url>");
    return null;
  }
  return { stored, config };
}

function saveAccess(home: string, access: ReturnType<typeof effectiveAccess>) {
  updateConfig((c) => ({ ...c, access: accessToStore(c, access), exec: access.tools.commands }), home);
}

/** What `--agent <handle>` says when no agent by that handle uses this computer. */
const unknownAgent = (given: string, agents: ReturnType<typeof readAgents>) =>
  `No agent @${given.replace(/^@/, "")} uses this computer.${agents.length ? ` Known: ${agents.map((x) => `@${x.handle}`).join(", ")}` : " (The list comes from the server: start the runner once.)"}`;

/** `agentes-runner folders …`: the same config the app edits (a running runner applies it at once). */
function folders(p: Parsed): number {
  const home = runnerHome();
  const paired = pairedOrExit(home);
  if (!paired) return 1;
  const [, sub = "list", target] = p.positional;
  const access = effectiveAccess(paired.stored);
  const agents = readAgents(home);
  const nameOf = (id: string) => {
    const a = agents.find((x) => x.id === id);
    return a ? `${a.name} (@${a.handle})` : id;
  };
  const handles = p.lists.get("agent") ?? [];
  const ids: string[] = [];
  for (const h of handles) {
    const a = resolveAgentHandle(agents, h);
    if (!a) {
      console.error(unknownAgent(h, agents));
      return 1;
    }
    ids.push(a.id);
  }
  try {
    switch (sub) {
      case "list": {
        if (access.folders.length === 0) console.log("No folders allowed besides each agent's own folder.");
        for (const f of access.folders) {
          console.log(`${f.path}\n    ${f.agents.length ? f.agents.map(nameOf).join(", ") : "no agent uses it yet"}`);
        }
        return 0;
      }
      case "allow": {
        if (!target) {
          console.error("Usage: agentes-runner folders allow <path> [--agent <handle>]...");
          return 1;
        }
        const real = checkFolder(target, { runnerHome: home, workspace: paired.config.workspace });
        saveAccess(home, addFolder(access, real, ids));
        console.log(
          ids.length
            ? `Allowed ${real} for ${ids.map(nameOf).join(", ")}.`
            : `Allowed ${real}. No agent uses it yet. Add one with --agent <handle>.`,
        );
        return 0;
      }
      case "remove": {
        if (!target) {
          console.error("Usage: agentes-runner folders remove <path> [--agent <handle>]...");
          return 1;
        }
        const abs = expandHome(target);
        const found = access.folders.find((f) => f.path === abs || f.path === target || f.path === safeReal(abs));
        if (!found) {
          console.error(`${target} is not an allowed folder (see agentes-runner folders list).`);
          return 1;
        }
        let next = access;
        if (ids.length) for (const id of ids) next = removeFolder(next, found.path, id);
        else next = removeFolder(next, found.path);
        saveAccess(home, next);
        console.log(ids.length ? `Removed ${found.path} for ${ids.map(nameOf).join(", ")}.` : `Removed ${found.path}.`);
        return 0;
      }
      default:
        console.error(
          "Usage: agentes-runner folders [list | allow <path> [--agent <handle>]... | remove <path> [--agent <handle>]...]",
        );
        return 1;
    }
  } catch (err) {
    if (err instanceof ControlError) {
      console.error(err.message);
      return 1;
    }
    throw err;
  }
}

function safeReal(p: string) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** `agentes-runner tools …`. */
function tools(p: Parsed): number {
  const home = runnerHome();
  const paired = pairedOrExit(home);
  if (!paired) return 1;
  const [, sub = "list", tool] = p.positional;
  const access = effectiveAccess(paired.stored);
  if (sub === "list") {
    for (const t of TOOL_NAMES) console.log(`${t.padEnd(9)} ${access.tools[t] ? "on " : "off"}  ${TOOL_LABELS[t]}`);
    return 0;
  }
  if ((sub === "enable" || sub === "disable") && tool && (TOOL_NAMES as readonly string[]).includes(tool)) {
    const t = tool as keyof RunnerTools;
    saveAccess(home, setTool(access, t, sub === "enable"));
    console.log(`${TOOL_LABELS[t]} ${sub === "enable" ? "on" : "off"}.`);
    return 0;
  }
  console.error(
    `Usage: agentes-runner tools [list | enable <tool> | disable <tool>] (tools: ${TOOL_NAMES.join(", ")})`,
  );
  return 1;
}

const SERVICES_USAGE = "Usage: agentes-runner services [list | allow <tcp|udp>/<port> | remove <tcp|udp>/<port>]";

/**
 * `agentes-runner services …`: what of this computer's own listeners agents may reach besides DNS. The running
 * runner's guard reads it within 2 s.
 */
function services(p: Parsed): number {
  const home = runnerHome();
  const [, sub = "list", spec] = p.positional;
  const listed = storedOrNull(home)?.services ?? [];
  if (sub === "list") {
    console.log("Agents reach DNS on this computer (tcp/53, udp/53), the runner's own local proxies, and:");
    console.log(listed.length ? listed.map((s) => `  ${s}`).join("\n") : "  nothing else");
    return 0;
  }
  const service = spec === undefined ? null : parseService(spec);
  if ((sub !== "allow" && sub !== "remove") || !service) {
    console.error(SERVICES_USAGE);
    return 1;
  }
  if (sub === "remove" && !listed.includes(service)) {
    console.error(`${service} isn't allowed (see agentes-runner services list).`);
    return 1;
  }
  const next = sub === "allow" ? [...new Set([...listed, service])] : listed.filter((s) => s !== service);
  updateConfig((c) => ({ ...c, services: next }), home);
  console.log(
    sub === "allow"
      ? `Agents can reach ${service} on this computer.`
      : `Agents can't reach ${service} on this computer any more.`,
  );
  return 0;
}

/**
 * `agentes-runner desktop-check --agent <handle>` (ADR 0058): the agent's
 * desktop and terminal on this computer, through the runner's own code, as
 * the user the runner would run them as (in system mode the agent's own). It
 * holds the runner's lock: it starts and stops the agent's desktop itself.
 */
async function desktopCheck(p: Parsed): Promise<number> {
  const home = runnerHome();
  const handle = flagString(p, "agent");
  const term = createTerm();
  term.intro(handle ? `desktop-check @${handle.replace(/^@/, "")}` : "desktop-check", false);
  const stopped = (message: string) => {
    term.refuse(message);
    term.stop();
    return 1;
  };
  if (!handle) return stopped("Usage: agentes-runner desktop-check --agent <handle>");
  const agents = readAgents(home);
  const agent = resolveAgentHandle(agents, handle);
  const stored = storedOrNull(home);
  const workspace = stored?.workspace;
  if (!agent || !workspace) return stopped(unknownAgent(handle, agents));
  const lock = acquireLock(home, "desktop-check");
  if (!lock.ok) return stopped(lockedMessage(home, lock.holder));
  let failed = 0;
  const report: Report = {
    ok: (text) => term.step(text),
    fail: (text) => {
      failed++;
      term.fail(text);
    },
    skip: (text) => term.skipped(text),
    log: (line) => term.quiet([line]),
  };
  let passed: boolean;
  try {
    if (stored?.mode === "system") {
      const u = new AgentUsers({ home, range: stored.agentUidRange ?? DEFAULT_AGENT_UID_RANGE }).ensure(agent);
      const launcher = systemLauncher({
        ...u,
        networkLauncher: stored.networkLauncher,
        networkMark: stored.networkMark,
        networkRevision: stored.networkRevision,
      });
      const desktop = await checkDesktop(
        report,
        home,
        agent,
        { user: async () => systemDesktopUser(launcher, { uid: u.uid, gid: agentGid(u.user) }), agentUsers: true },
        { prefix: launcher.prefix, uid: u.uid },
      );
      const terminal = await checkTerminal(report, agent, {
        user: async () => systemTerminalUser(launcher, agent),
        agentUsers: true,
      });
      passed = desktop && terminal;
    } else {
      const folder = await agentWorkspace(prepareWorkspace(workspace), agent);
      const desktop = await checkDesktop(report, home, agent, { user: async (a) => runnerUser(home, folder, a) });
      const terminal = await checkTerminal(report, agent, { user: async () => runnerTerminalUser(folder) });
      passed = desktop && terminal;
    }
  } finally {
    lock.release();
  }
  term.gap();
  term.end(failed ? `${failed} ${failed === 1 ? "check" : "checks"} failed` : "Every check passed");
  return passed ? 0 : 1;
}

/** How a check says what it found: done, failed, left out, and the lines of what it runs. */
interface Report {
  ok(text: string): void;
  fail(text: string): void;
  skip(text: string): void;
  log(line: string): void;
}

const since = (t0: number) => `${Math.round(performance.now() - t0)} ms`;
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Its desktop starts (or runs), both logins work, and a watcher's pointer is ignored; a desktop it started stops. */
async function checkDesktop(
  report: Report,
  home: string,
  agent: AgentScope,
  as: Pick<DesktopSessionsOptions, "user" | "agentUsers">,
  launcher?: { prefix: string[]; uid: number },
): Promise<boolean> {
  const desktops = new DesktopSessions({ home, log: report.log, ...as });
  desktops.restore();
  const info = desktops.info();
  if (!info.available) {
    report.fail(`desktop: ${info.reason}`);
    return false;
  }
  const opened: VncConnection[] = [];
  let started = false;
  try {
    const t0 = performance.now();
    const reply = await desktops.ensure(agent);
    started = reply.started;
    report.ok(
      `desktop: ${started ? "started" : "running already"} on :${reply.display} (${reply.width}×${reply.height}) in ${since(t0)}`,
    );
    const session = desktops.session(agent.id);
    if (!session) throw new Error("the desktop has no session");
    const login = async (what: string, password: string) => {
      const t = performance.now();
      const vnc = await connectVnc(session.socket, password);
      opened.push(vnc);
      const init = await vncInit(vnc);
      report.ok(`${what}: logged in in ${since(t)}, ${init.width}×${init.height} "${init.name}"`);
      return vnc;
    };
    const control = await login("control (the full password)", session.passwords.full);
    const watch = await login("watch (the view-only password)", session.passwords.view);
    // RFB PointerEvent: type 5, no buttons, x and y.
    const point = async (vnc: VncConnection, x: number, y: number) => {
      vnc.socket.write(Uint8Array.of(5, 0, x >> 8, x & 255, y >> 8, y & 255));
      await sleep(300);
      const found = spawnSync("xdotool", ["getmouselocation"], {
        env: { ...process.env, DISPLAY: `:${session.display}`, XAUTHORITY: session.xauthority },
        encoding: "utf8",
      });
      const m = /x:(\d+) y:(\d+)/.exec(found.stdout ?? "");
      return m ? `${m[1]},${m[2]}` : null;
    };
    const moved = await point(control, 100, 120);
    if (moved === null) report.skip("view-only: not checked (install xdotool to check it)");
    else if (moved !== "100,120") throw new Error(`the person in control moved the pointer to ${moved}, not 100,120`);
    else {
      const after = await point(watch, 640, 400);
      if (after !== "100,120") throw new Error(`a watcher moved the pointer (to ${after})`);
      report.ok("view-only: a watcher's pointer is ignored, the controller's moves it");
    }
    return await checkDesktopUse(report, desktops, agent, launcher);
  } catch (err) {
    report.fail(`desktop: ${errorText(err)}`);
    return false;
  } finally {
    for (const vnc of opened) vnc.socket.destroy();
    if (started) {
      await desktops.stop(agent);
      report.ok("desktop: stopped");
    }
    desktops.close();
  }
}

/**
 * Desktop use on that desktop through the runner's own code (ADR 0062), with how long each part takes: a
 * look, an action that settles and looks again, a screenshot and a close-up, the apps. It runs as this
 * command's user, the person at this computer, or in system mode as the agent's own (`launcher`); whether
 * agents may use their desktops here is said first.
 */
async function checkDesktopUse(
  report: Report,
  desktops: DesktopSessions,
  agent: AgentScope,
  launcher?: { prefix: string[]; uid: number },
): Promise<boolean> {
  const forAgents = new DesktopManager({ desktops, workers: launcher !== undefined, log: () => undefined }).info();
  if (forAgents.available) report.ok("desktop use: agents can use their desktops here");
  else report.skip(`desktop use: agents can't use their desktops here: ${forAgents.reason}`);
  const uid = launcher?.uid ?? process.getuid?.() ?? null;
  const use = new DesktopManager({
    desktops,
    log: report.log,
    // The person at this computer drives the desktop this check started, as its own user (or the agent's).
    uids: () => (uid === null ? null : { runner: -1, agents: new Map([[agent.id, uid]]) }),
    ...(launcher ? { launcher } : {}),
  });
  try {
    let t0 = performance.now();
    const first = await use.look(agent);
    const elements = Object.keys(first.refs);
    report.ok(
      `desktop use: a look in ${since(t0)} with the helper starting (${first.snapshot.split("\n").length} lines, ${elements.length} elements, ${first.address})`,
    );
    t0 = performance.now();
    await use.look(agent);
    report.ok(`desktop use: a look in ${since(t0)}`);
    const ref = elements[0];
    if (ref) {
      t0 = performance.now();
      const acted = await use.act(agent, { kind: "hover", at: { ref } }, true, { folder: process.cwd() });
      report.ok(
        `desktop use: a hover on ${ref} (${first.refs[ref]?.role}), settled${acted.settled === false ? " at the cap" : ""} and looked at, in ${since(t0)}`,
      );
    } else report.skip("desktop use: nothing on the screen to act on");
    t0 = performance.now();
    const shot = await use.capture(agent, null);
    report.ok(
      `desktop use: a screenshot in ${since(t0)} (${shot.width}×${shot.height}, ${Math.round((shot.data.length * 3) / 4 / 1024)} KB, ${shot.marks.length} elements marked)`,
    );
    t0 = performance.now();
    const close = await use.capture(agent, { x: 400, y: 250, width: 480, height: 300 });
    report.ok(`desktop use: a close-up in ${since(t0)} (${close.width}×${close.height})`);
    const { apps } = await use.apps(agent);
    report.ok(
      `desktop use: ${apps.length} apps to start (${apps
        .slice(0, 5)
        .map((a) => a.name)
        .join(", ")})`,
    );
    return true;
  } catch (err) {
    report.fail(`desktop use: ${errorText(err)}`);
    return false;
  } finally {
    use.stopAll();
  }
}

/** A terminal opens as the agent's OS user in its folder, at its size, and ends with its shell. */
async function checkTerminal(
  report: Report,
  agent: AgentScope,
  as: Pick<TerminalsOptions, "user" | "agentUsers">,
): Promise<boolean> {
  const terminals = new Terminals({ log: () => undefined, ...as });
  const info = terminals.info();
  if (!info.available) {
    report.fail(`terminal: ${info.reason}`);
    return false;
  }
  const decoder = new TextDecoder();
  let output = "";
  let firstAt = 0;
  const peer: { on?: DataListener; closed?: () => void } = {};
  const closed = new Promise<void>((resolve) => {
    peer.closed = resolve;
  });
  // The data socket's place, here on the computer: the shell's bytes come to this check.
  const local: DataSocket = {
    bufferedAmount: 0,
    send: (data) => {
      if (typeof data === "string") return;
      firstAt ||= performance.now();
      output += decoder.decode(data, { stream: true });
    },
    close: () => peer.closed?.(),
    listen: (on) => {
      peer.on = on;
    },
  };
  try {
    const t0 = performance.now();
    await terminals.open(agent, { cols: 80, rows: 24 }, async () => local);
    // Quoted apart, so the echo of the typed line never matches.
    peer.on?.bytes(new TextEncoder().encode('echo "CHECK""=$(id -un)=$(tput cols)=$PWD"; exit\n'));
    await Promise.race([closed, sleep(10_000)]);
    const m = /CHECK=([^=\r\n]+)=(\d+)=([^\r\n]*)/.exec(output);
    if (!m) throw new Error(`no answer from the shell: ${JSON.stringify(output.slice(-300))}`);
    report.ok(
      `terminal: a shell as ${m[1]} in ${m[3]}, ${m[2]} columns, first output in ${Math.round(firstAt - t0)} ms`,
    );
    return true;
  } catch (err) {
    report.fail(`terminal: ${errorText(err)}`);
    return false;
  } finally {
    terminals.closeAll();
  }
}

async function main(argv: string[]): Promise<number> {
  let p: Parsed;
  try {
    p = parseArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  // One home per organization (the desktop app passes its own); child processes inherit it.
  const home = flagString(p, "home");
  if (home) process.env.AGENTES_RUNNER_HOME = expandHome(home);
  const [command, sub] = p.positional;
  if (p.flags.has("version")) {
    console.log(RUNNER_VERSION);
    return 0;
  }
  if (p.flags.has("help") || !command || command === "help") {
    console.log(HELP);
    return command || p.flags.has("help") ? 0 : 1;
  }
  switch (command) {
    case "pair":
      return pair(p);
    case "start":
      return start();
    case "app":
      return app();
    case "status":
      return status();
    case "doctor": {
      const json = p.flags.has("json");
      const interactive = process.stdout.isTTY === true && process.stdin.isTTY === true;
      return runDoctor({
        // Ctrl-C while it waits: something still needs the person.
        term: createTerm({ canceled: () => process.exit(1) }),
        sources: localSources(runnerHome()),
        wait: p.flags.has("wait") || (!p.flags.has("no-wait") && !json && interactive),
        json,
        write: (text) => process.stdout.write(text),
      });
    }
    case "computer":
      console.log(await computerNow());
      return 0;
    case "folders":
      return folders(p);
    case "tools":
      return tools(p);
    case "desktop-check":
      return desktopCheck(p);
    case "mcp": {
      // `--task <taskId>`: a mission task's or a Claude Code brain process's server.
      // `--run <runId>`: a Codex brain turn's (its token only in the env). Neither: the run in `AGENTES_MCP_RUN`, for a
      // CLI whose config can't name it per turn (Grok Build's and the Antigravity CLI's, shared by an account's turns).
      const runId =
        flagString(p, "run") ?? (flagString(p, "task") ? undefined : process.env.AGENTES_MCP_RUN || undefined);
      const taskId = runId ?? flagString(p, "task");
      if (!taskId || !/^[a-zA-Z0-9-]{8,64}$/.test(taskId)) {
        console.error("Usage: agentes-runner mcp --task <taskId> | --run <runId>");
        return 1;
      }
      if (p.flags.has("relay")) {
        const { AGENTES_MCP_SOCKET: socketPath, AGENTES_MCP_TOKEN: token } = process.env;
        if (!socketPath || !token) return 1;
        return runMcpRelay({ taskId, socketPath, token });
      }
      return runMcpServer({
        taskId,
        socketPath: process.env.AGENTES_MCP_SOCKET || mcpSocketPath(runnerHome()),
        token: process.env.AGENTES_MCP_TOKEN || null,
        ...(runId ? {} : { tokenFile: path.join(runnerHome(), "tasks", taskId, MCP_TOKEN_FILE) }),
      });
    }
    case "worker":
      return worker(p);
    case "bind-check":
      return bindCheck(p.positional.slice(1));
    case "services":
      return services(p);
    case "desktop-browser":
      if (!sub) {
        console.error("Usage: agentes-runner desktop-browser <socket>");
        return 1;
      }
      return runDesktopBrowser(sub);
    case "host":
      return host(p);
    case "task-wrapper": {
      // A compiled runner's background task wrapper (tasks.ts); it exits on its own when the task ends.
      if (!sub) return 1;
      runTaskWrapper(path.resolve(sub));
      return new Promise<number>(() => {});
    }
    case "update":
      return update();
    case "service": {
      const stored = storedOrNull();
      const hostService = p.flags.has("host");
      const system =
        p.flags.has("system") || stored?.mode === "system" || (hostService && process.platform === "linux");
      const term = createTerm();
      if (sub === "install") {
        return printed(term, "service install", (print) => {
          const managed = managedMessage(stored);
          if (managed) {
            print(managed);
            return 1;
          }
          if (hostService) return installHost(p, print);
          if (!system) return installService({ print });
          const range = flagString(p, "agent-uid-range");
          const agentUidRange = range === undefined ? undefined : parseUidRange(range);
          if (agentUidRange === null) {
            print(
              "--agent-uid-range takes two uids between 1000 and 59999, the first not above the second, like 20000-29999",
            );
            return 1;
          }
          return installSystemService({
            print,
            start: !p.flags.has("no-start"),
            ...(agentUidRange ? { agentUidRange } : {}),
          });
        });
      }
      if (sub === "uninstall")
        return printed(term, "service uninstall", (print) => uninstallService({ print, system }));
      console.error("Usage: agentes-runner service install|uninstall");
      return 1;
    }
    default:
      console.error(`Unknown command: ${command}\n\n${HELP}`);
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(`(home: ${runnerHome()})`);
    process.exit(1);
  },
);

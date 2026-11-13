import { execFile } from "node:child_process";
import { type lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import {
  ACCOUNT_STORES,
  type AccountUsers,
  type AgentUser,
  accountLauncher,
  agentHome,
  PROBE_AGENT_UID,
  readAgentUsers,
  trustedRootFile,
  underMaskedRoot,
} from "./agent-users";
import type { StoredConfig } from "./config";
import { resolveCommand } from "./executors";
import { CLAUDE_PROBE_ARGS, jsonLines } from "./plan-usage";
import { type RunCommand, runSync, systemdBooted } from "./service";

/**
 * Whether this computer may offer Claude's own login for all agents, asked at the runner's start and every
 * `SELF_CHECK_EVERY_MS`: every barrier it relies on, tried for real on a stand-in sign-in and agent.
 */
export const SELF_CHECK_EVERY_MS = 6 * 3600_000;
/** After a failed check: soon, and again while it keeps failing. */
export const SELF_CHECK_RETRY_MS = 5 * 60_000;
const PROBE_ACCOUNT = "00000000-0000-4000-8000-000000000000";
const PROBE_AGENT: AgentUser = { id: PROBE_ACCOUNT, user: "ag-00000000", uid: PROBE_AGENT_UID };
const PROBE_TIMEOUT_MS = 20_000;

/**
 * Run as the stand-in agent (`$1` the sign-in's folder, `$2` the probe CLI's pid); succeeds only when the kernel
 * refused each. Opening `/proc/<pid>/mem` takes the same check as a ptrace attach, with no tool for it installed.
 * Refused means refused: a path or process that isn't there would otherwise pass. The one exception is `/proc/<pid>`:
 * under `hidepid=invisible`, as on the Cloud's machines, the kernel answers another user that it doesn't exist. `kill`
 * comes last and tells the two apart: only a process that is there, and not this user's, gives "not permitted".
 */
export const REFUSED = [
  "export LC_ALL=C",
  'refused() { o=$("$@" 2>&1) && return 1; case "$o" in *"ermission denied"*|*"not permitted"*) ;; *) return 1 ;; esac; }',
  'hidden() { o=$("$@" 2>&1) && return 1; case "$o" in *"No such file"*|*"ermission denied"*) ;; *) return 1 ;; esac; }',
  'refused ls "$1/config" && refused ls "$1/run" && hidden cat "/proc/$2/environ" && hidden head -c1 "/proc/$2/mem" && refused kill -0 "$2"',
].join("\n");

type Exec = (argv: string[], env: NodeJS.ProcessEnv) => Promise<boolean>;

const execOk: Exec = ([file, ...args], env) =>
  new Promise((resolve) => {
    execFile(file as string, args, { env, timeout: PROBE_TIMEOUT_MS }, (error) => resolve(!error));
  });

export interface SelfCheck {
  config: StoredConfig;
  users: Pick<AccountUsers, "ensure" | "room">;
  home: string;
  /** The runner's own command, a runtime and its script unless compiled: the relay the CLI starts, all of it as its user. */
  relay: string[];
  /** Tests. */
  cli?: string[];
  systemd?: boolean;
  run?: RunCommand;
  stat?: typeof lstatSync;
  launcher?: typeof accountLauncher;
  exec?: Exec;
}

/** Bytes that left a route uncounted by the relay, on the computer and in the agent's namespace. */
function directBytes(uid: number, run: RunCommand): number {
  const list = ["-j", "list", "counter", "inet", "agentes_egress", "legacy_direct"];
  let bytes = 0;
  for (const r of [run("nft", list), run("nsenter", [`--net=/run/netns/agentes-${uid}`, "nft", ...list])]) {
    try {
      const rows = (JSON.parse(r.output) as { nftables: { counter?: { bytes?: number } }[] }).nftables;
      bytes += rows.reduce((sum, row) => sum + (row.counter?.bytes ?? 0), 0);
    } catch {
      // no such table here
    }
  }
  return bytes;
}

/** Null when everything held; otherwise why not, for the machine's status. */
export async function accountSelfCheck(c: SelfCheck): Promise<string | null> {
  const spec = c.config.claudeSharedLogin;
  if (!spec) return "The feature is off";
  if (spec.refresh === "B" && !spec.refreshLock) return "Refresh mode B needs the name of the CLI's lock (refreshLock)";
  const run = c.run ?? runSync;
  const launcher = c.launcher ?? accountLauncher;
  if (!(c.systemd ?? systemdBooted())) return "It needs systemd";

  const [claude = "claude", ...pre] = c.cli ?? [];
  const file = resolveCommand(claude, process.env.PATH);
  const cli = c.cli ? file : realpathSync(file);
  try {
    trustedRootFile(cli, "Claude CLI", c.stat);
    for (const [i, part] of c.relay.entries()) trustedRootFile(realpathSync(part), "runner", c.stat, i > 0);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  if (underMaskedRoot(cli)) return `The Claude CLI is inside a folder its own view hides (${cli})`;
  // Any version runs: the one installed only goes with a failure, so a report shows which CLI changed what.
  const version = /\d+\.\d+\.\d+/.exec(run(cli, [...pre, "--version"]).output)?.[0];
  const why = await probe(c, cli, pre, run, launcher);
  return why && version ? `${why} (Claude CLI ${version})` : why;
}

/** The stand-in agent against the sign-in's user, then the network route. */
async function probe(
  c: SelfCheck,
  cli: string,
  pre: string[],
  run: RunCommand,
  launcher: typeof accountLauncher,
): Promise<string | null> {
  const account = c.users.ensure(PROBE_ACCOUNT);
  c.users.room(account, PROBE_AGENT.uid);
  const view = launcher(account, PROBE_AGENT, path.join(agentHome(PROBE_AGENT.user), "probe"));
  const said = await jsonLines<string>(
    { command: [...view.prefix, cli, ...pre], cwd: view.home, env: view.env, timeoutMs: PROBE_TIMEOUT_MS },
    [...CLAUDE_PROBE_ARGS, "--tools", "ToolSearch"],
    (send) => send({ type: "user", message: { role: "user", content: "." } }),
    (msg) => {
      if (msg.type !== "system" || msg.subtype !== "init") return undefined;
      const tools = Array.isArray(msg.tools) ? msg.tools : null;
      const extra = tools?.find((t) => t !== "ToolSearch" && !String(t).startsWith("mcp__agentes__"));
      if (!tools || extra !== undefined) return `The Claude CLI kept a tool of its own (${String(extra)})`;
      const pid = /^\d+$/m.exec(run("pgrep", ["-o", "-U", String(account.uid)]).output)?.[0];
      if (!pid) return "The Claude CLI's process wasn't found";
      const probe = [`--reuid=${PROBE_AGENT.uid}`, `--regid=${PROBE_AGENT.uid}`, "--clear-groups", "--"];
      const store = path.join(ACCOUNT_STORES, account.id);
      const refused = run("/usr/bin/setpriv", [...probe, "/bin/sh", "-c", REFUSED, "sh", store, pid]);
      return refused.code === 0 ? "" : "An agent's user reached the sign-in's folders or process";
    },
  );
  if (said === null) return "The Claude CLI didn't start as the sign-in's user";
  if (said) return said;

  const { networkLauncher, networkMark, networkRevision, networkAuthRoute, server } = c.config;
  if (!networkLauncher) return null;
  if (!networkAuthRoute) return "The agents' networks don't route the sign-in's user";
  // Only a real agent's uid: the network hook starts namespaces for nothing else.
  const agent = readAgentUsers(c.home)[0];
  if (!agent) return "No agent here yet to try the network with";
  c.users.room(account, agent.uid);
  const routed: AgentUser = { ...agent, networkLauncher, networkMark, networkRevision };
  const egress = launcher(account, routed, path.join(agentHome(agent.user), "probe"));
  const before = directBytes(agent.uid, run);
  const left = await (c.exec ?? execOk)(
    [
      ...egress.prefix,
      "/usr/bin/curl",
      "-q",
      "--noproxy",
      "*",
      "--silent",
      "--fail",
      "--output",
      "/dev/null",
      "--max-time",
      "10",
      `${server ?? ""}/api/machines/ip`,
    ],
    egress.env,
  );
  if (!left) return "The sign-in's user has no way out of the agent's network";
  return directBytes(agent.uid, run) === before ? null : "The sign-in's user left outside the relay";
}

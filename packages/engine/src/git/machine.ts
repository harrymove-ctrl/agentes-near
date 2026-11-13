import {
  type AgentScope,
  GIT_CHECKOUTS_DIR,
  GIT_DIRECT_PROTOCOL,
  GIT_PROTOCOL,
  GIT_STATELESS_TOKEN_PROTOCOL,
  GIT_SYNC_LIMITS,
  GITHUB_APP_TOKEN,
  type GitSyncRepo,
  type GitSyncRequest,
  gitCheckoutDir,
  isGitRepoName,
} from "@agenteschat/adapters";
import { and, type Database, eq, isNull, schema } from "@agenteschat/db";
import { getAgentCached } from "../agents";
import { recordAudit } from "../audit";
import { activeConnections } from "../connectors/connections";
import type { MachineCaller, MachineCallOptions, MachineStatus } from "../machine-hub";
import { MachineOfflineError, MachinePausedError, REMOVED_COMPUTER_MESSAGE } from "../machines";
import { missionOfRun } from "../mission-context";
import { runnerUpdateWay } from "../runner-update";
import { standingRefusal } from "../standing";
import { grantedScopeKeys } from "../tools/scopes";
import { agentCommitEmail, GIT_TOKEN_TTL_SECONDS, gitProxyBase, issueGitToken, machineGitGen } from "./credential";
import { appTokenForRepo, botIdentity, boundInstallations, type GitHubAppConfig, type GitHubHttp } from "./github-app";
import { gitAccess } from "./proxy";
import { agentRepositoryList, type CodeCheckout, codePrompt, repoInList } from "./repos";
import { runCoAuthor } from "./signature";

/**
 * Git on a connected machine through our proxy (ADR 0024 addendum):
 * the server issues the proxy credential for that machine and agent, and the
 * runner clones or updates the agent's checkouts in its own folder
 * (`repos/<owner>/<name>`) with `git.sync` (protocol 11). Only our
 * credential reaches the machine (revocable, scoped to the agent's granted
 * repositories, pushes only to `agentes/<handle>/…`); GitHub's token stays here.
 *
 * ADR 0116: with our GitHub App installed for a repository, a runner on
 * protocol 53 also gets a one-hour installation token for that repository
 * alone (contents: read), so its fetches go straight to GitHub instead of
 * through this server; pushes still go through the proxy. Never the
 * connection's own (OAuth or pasted) token: without the App, all of it goes
 * through the proxy.
 */
export interface MachineGitDeps {
  db: Database;
  hub: MachineCaller;
  /** Our public URL and AGENTES_SECRET (the proxy credential is an HMAC of it). */
  git: { publicUrl: string; secret: string };
  /** Our GitHub App (ADR 0116): fetches straight from GitHub where it is installed. */
  github?: { app: GitHubAppConfig; http: GitHubHttp } | null;
  now?: () => Date;
}

/** An older runner's clone may take this long (partial clone, but a big checkout on a slow link). */
export const MACHINE_CLONE_SECONDS = 1800;
/** A runner on protocol 35 answers `cloning` after this long and the download goes on there. */
export const MACHINE_CLONE_WAIT_SECONDS = 600;
/** Before a chat turn: every fetch of the agent's checkouts together, at most this long. */
export const PRE_TURN_SYNC_SECONDS = 20;

/** Why git can't run on the machine now (said to the agent), or null. */
export function machineGitUnavailable(status: MachineStatus | null, orgId: string): Error | null {
  if (!status || status.orgId !== orgId) {
    return new Error(REMOVED_COMPUTER_MESSAGE);
  }
  if (!status.online) return new MachineOfflineError(status.name, status.kind);
  if (status.paused) return new MachinePausedError(status.name, status.paused.until, status.paused.timezone);
  if (status.protocol < GIT_PROTOCOL) {
    return new Error(
      `The agentes app (runner) on the computer ${status.name} is too old to clone repositories. ${runnerUpdateWay(status)}`,
    );
  }
  return null;
}

/**
 * The `proxy` and `author` of a `git.sync` for this agent on this machine:
 * a fresh proxy credential (6 h) bound to the machine and the agent. Null
 * when the org has no GitHub connection or the agent has no git access.
 * With the GitHub App installed for the workspace (ADR 0156), commits are
 * authored as the app's bot, so GitHub shows them as the app's.
 */
export async function machineGitSetup(
  deps: MachineGitDeps,
  orgId: string,
  agentId: string,
  machineId: string,
): Promise<(Pick<GitSyncRequest, "proxy" | "author"> & { agent: AgentScope }) | null> {
  const connection = (await activeConnections(deps.db, orgId)).find((c) => c.connector === "github");
  if (!connection) return null;
  const keys = await grantedScopeKeys(deps.db, orgId, agentId);
  if (!gitAccess(keys, connection.id).read) return null;
  const agent = await getAgentCached(deps.db, orgId, agentId);
  if (!agent || agent.machineId !== machineId) return null;
  const [machine] = await deps.db
    .select({ tokenHash: schema.machines.tokenHash })
    .from(schema.machines)
    .where(and(eq(schema.machines.id, machineId), eq(schema.machines.orgId, orgId), isNull(schema.machines.deletedAt)));
  if (!machine?.tokenHash) return null;
  const now = deps.now?.() ?? new Date();
  const token = issueGitToken(deps.git.secret, {
    orgId,
    agentId,
    sandboxId: machineId,
    gen: machineGitGen(machine.tokenHash),
    exp: Math.floor(now.getTime() / 1000) + GIT_TOKEN_TTL_SECONDS,
    kind: "machine",
  });
  const github = deps.github;
  const bot =
    github && (await boundInstallations(deps.db, orgId)).length > 0 ? await botIdentity(github.app, github.http) : null;
  return {
    proxy: { base: gitProxyBase(deps.git.publicUrl, orgId, connection.id), token },
    author: bot
      ? { name: `${agent.name} (agentes.chat)`, email: bot.email }
      : { name: `${agent.name} (agentes)`, email: agentCommitEmail(deps.git.publicUrl, agent.handle) },
    agent: { id: agent.id, handle: agent.handle, name: agent.name },
  };
}

/**
 * Single-repository read tokens of our GitHub App for the repositories among `repos` the agent may use, keyed by
 * repository; empty without the App, on an older runner, where the App isn't installed, or for an agent that is
 * archived, held or suspended (as the proxy refuses it). Only what the runner takes as an installation token
 * (`GITHUB_APP_TOKEN`), never the connection's own. Never throws: a repository without a token fetches through the
 * proxy. Each token handed out is audited as a fetch (`via: github-direct`): the fetches themselves no longer pass
 * through us.
 */
export async function directFetchTokens(
  deps: MachineGitDeps,
  target: { orgId: string; agentId: string; machineId: string },
  protocol: number,
  repos: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const github = deps.github;
  if (!github || protocol < GIT_STATELESS_TOKEN_PROTOCOL || repos.length === 0) return out;
  try {
    const [agent] = await deps.db
      .select({ archivedAt: schema.agents.archivedAt })
      .from(schema.agents)
      .where(and(eq(schema.agents.id, target.agentId), eq(schema.agents.orgId, target.orgId)));
    if (!agent || agent.archivedAt || (await standingRefusal(deps.db, target.orgId, target.agentId))) return out;
    const list = await agentRepositoryList(deps.db, target.orgId, target.agentId);
    const tenant = { db: deps.db, orgId: target.orgId };
    await Promise.all(
      repos.map(async (repo) => {
        const [owner = "", name = ""] = repo.split("/");
        if (!repoInList(list, owner, name)) return;
        const token = await appTokenForRepo(github.app, github.http, tenant, owner, name, { contents: "read" }).catch(
          () => null,
        );
        // The runner refuses a whole `git.sync` over one token it doesn't take.
        if (!token || !GITHUB_APP_TOKEN.test(token)) return;
        out.set(repo, token);
        await recordAudit(deps.db, {
          orgId: target.orgId,
          actor: { type: "agent", id: target.agentId },
          action: "git.fetch",
          target: { type: "git_repo", id: repo },
          details: { via: "github-direct", machineId: target.machineId },
        }).catch(() => undefined);
      }),
    );
  } catch {
    // The database didn't answer: no tokens this time, and the sync still goes (through the proxy).
  }
  return out;
}

/** The `owner/name` folders under the agent's `repos/` on the computer (`list`); none when it can't say. */
async function checkoutsOnMachine(
  hub: MachineCaller,
  machineId: string,
  agent: AgentScope,
  signal?: AbortSignal,
): Promise<string[]> {
  try {
    const { entries } = await hub.call(
      machineId,
      { op: "list", agent, path: GIT_CHECKOUTS_DIR, depth: 2 },
      { timeoutMs: 10_000, ...(signal ? { signal } : {}) },
    );
    return entries.flatMap((e) => {
      const parts = e.path.split("/");
      const repo = parts.slice(1).join("/");
      return e.isDir && parts.length === 3 && parts[0] === GIT_CHECKOUTS_DIR && isGitRepoName(repo) ? [repo] : [];
    });
  } catch {
    return [];
  }
}

/** `git_clone` on a connected machine: clones (or, when it is there, updates) one repository in the agent's folder. */
export async function cloneOnMachine(
  deps: MachineGitDeps,
  target: { orgId: string; agentId: string; machineId: string },
  input: { repo: string; dir?: string; signal?: AbortSignal; onOutput?: MachineCallOptions["onOutput"] },
): Promise<GitSyncRepo> {
  const status = await deps.hub.status(target.machineId);
  const unavailable = machineGitUnavailable(status, target.orgId);
  if (unavailable || !status) throw unavailable;
  const setup = await machineGitSetup(deps, target.orgId, target.agentId, target.machineId);
  if (!setup)
    throw new Error("You have no git access to GitHub here (scope github:git.read), or GitHub isn't connected.");
  const { agent, ...rest } = setup;
  const github = (await directFetchTokens(deps, target, status.protocol, [input.repo])).get(input.repo);
  const reply = await deps.hub.call(
    target.machineId,
    {
      op: "git.sync",
      agent,
      ...rest,
      repos: [
        { repo: input.repo, dir: input.dir || gitCheckoutDir(input.repo), clone: true, ...(github ? { github } : {}) },
      ],
      timeoutSeconds: status.protocol >= GIT_DIRECT_PROTOCOL ? MACHINE_CLONE_WAIT_SECONDS : MACHINE_CLONE_SECONDS,
      stream: Boolean(input.onOutput),
    },
    { ...(input.signal ? { signal: input.signal } : {}), ...(input.onOutput ? { onOutput: input.onOutput } : {}) },
  );
  const result = reply.repos[0];
  if (!result) throw new Error("The computer answered without the repository.");
  return result;
}

/** The repository the conversation names (newest text first), among `repos` (`owner/name`); null when none. */
export function namedRepo(repos: readonly string[], texts: readonly string[]): string | null {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const text of texts) {
    let best: { repo: string; at: number } | null = null;
    for (const repo of repos) {
      const name = repo.split("/")[1] ?? "";
      const patterns = [new RegExp(`(^|[^A-Za-z0-9_.-])${esc(repo)}(?![A-Za-z0-9_-])`, "i")];
      if (name.length >= 3) patterns.push(new RegExp(`(^|[^A-Za-z0-9_./-])${esc(name)}(?![A-Za-z0-9_/-])`, "i"));
      for (const p of patterns) {
        const m = p.exec(text);
        if (m && (!best || m.index < best.at)) best = { repo, at: m.index };
      }
    }
    if (best) return best.repo;
  }
  return null;
}

/** What `prepareAgentCode` gives a turn: where it starts, "# Your code" for the system text, and the start line. */
export interface CodeSetup {
  cwd: string;
  prompt: string;
  /** "You start in …" for the turn's prompt; absent or "" when it starts in no checkout. */
  start?: string;
  /** What the start was picked from, to pick it again for other words (`codeStart`) without syncing again. */
  pick?: { present: CodeStartRepo[]; primary?: string; credit?: string };
}

type CodeStartRepo = { repo: string; dir: string; path?: string };

/**
 * Where a turn starts among the synced checkouts: the repository the conversation names (its trigger first, then
 * its last messages, newest first), else the agent's first repository, else the first checkout.
 */
export function codeStart(
  pick: NonNullable<CodeSetup["pick"]>,
  turn: Pick<CodeTurn, "trigger" | "messages">,
): Pick<CodeSetup, "cwd" | "start"> {
  const texts = [
    turn.trigger,
    ...turn.messages
      .slice(-8)
      .map((m) => m.content)
      .reverse(),
  ];
  const named = namedRepo(
    pick.present.map((r) => r.repo),
    texts,
  );
  const start =
    pick.present.find((r) => r.repo === named) ??
    pick.present.find((r) => r.repo.toLowerCase() === pick.primary?.toLowerCase()) ??
    pick.present[0];
  const lines = [start ? `You start in ${start.path ?? start.dir}.` : "", pick.credit ?? ""];
  return { cwd: start?.dir ?? "", start: lines.filter(Boolean).join("\n") };
}

/**
 * The turn's commits credit the person behind its run (ADR 0156), as the run's commits through GitHub's API do, when
 * they linked GitHub to sign in: the line that says so, next to where the turn starts.
 */
async function creditLine(deps: MachineGitDeps, turn: CodeTurn) {
  // ponytail: an instruction the agent follows; a `prepare-commit-msg` hook written by `git.sync` if it forgets.
  const http = deps.github?.http ?? { fetch, apiUrl: "https://api.github.com" };
  const trailer = await runCoAuthor({ db: deps.db, http }, turn).catch(() => null);
  return trailer ? `Commits you make this turn: end each commit message with the line ${trailer}` : "";
}

/** What a chat turn needs from `prepareAgentCode`. */
export interface CodeTurn {
  orgId: string;
  agentId: string;
  threadRootId: string | null;
  trigger: string;
  messages: ReadonlyArray<{ content: string }>;
  session?: { machineId: string; cwd: string; ownFolder?: boolean } | undefined;
  /** Its run: the person behind it gets the credit for its commits. */
  runId?: string;
}

/**
 * Before a chat turn of a computer brain (Claude Code, Codex) on a connected
 * machine: updates the agent's checkouts (fetch + fast-forward of the default
 * branch, bounded, never failing the turn), picks where the turn starts (the
 * repository the conversation names, else the agent's first repository, else
 * its first checkout) and writes the "# Your code" block for the system text, and where it starts ("You start in …")
 * for the turn's own prompt: the system text stays the same from turn to turn. Null when there is
 * nothing to do: a mission turn (it has its own folder; only the computer's proxy credential is refreshed), an
 * older runner, no GitHub or no git access, or nothing granted or checked out.
 */
export async function prepareAgentCode(
  deps: MachineGitDeps,
  turn: CodeTurn,
  options: { signal?: AbortSignal } = {},
): Promise<CodeSetup | null> {
  const machineId = turn.session?.machineId;
  if (!machineId) return null;
  try {
    const status = await deps.hub.status(machineId);
    if (!status || machineGitUnavailable(status, turn.orgId)) return null;
    const setup = await machineGitSetup(deps, turn.orgId, turn.agentId, machineId);
    if (!setup) return null;
    const { agent, ...rest } = setup;
    const sync = (repos: GitSyncRequest["repos"], existing: boolean) =>
      deps.hub.call(
        machineId,
        {
          op: "git.sync",
          agent,
          ...rest,
          repos,
          ...(existing ? { existing } : {}),
          timeoutSeconds: PRE_TURN_SYNC_SECONDS,
        },
        { timeoutMs: (PRE_TURN_SYNC_SECONDS + 15) * 1000, ...(options.signal ? { signal: options.signal } : {}) },
      );
    // A chat turn starts in the agent's folder (""); a mission's turn (its thread) works in the mission's own folder;
    // a session started afresh there because its folder was gone stays there. Those update no checkout, but their
    // pushes go through the proxy too: the computer's credential (6 h) is refreshed before them all the same.
    const chat =
      turn.session?.cwd === "" &&
      !turn.session.ownFolder &&
      !(turn.threadRootId && (await missionOfRun({ db: deps.db, ...turn, threadRootId: turn.threadRootId })));
    if (!chat) {
      await sync([], false);
      return null;
    }
    const credit = await creditLine(deps, turn);
    const list = await agentRepositoryList(deps.db, turn.orgId, turn.agentId);
    const explicit = list.filter((r) => !r.endsWith("/*"));
    // An `owner/*` (or all) grant names no repository: its checkouts are found on the computer, so they fetch
    // straight from GitHub too instead of going back to the proxy.
    const wildcard = list.length === 0 || list.length > explicit.length;
    const found =
      wildcard && deps.github && status.protocol >= GIT_STATELESS_TOKEN_PROTOCOL
        ? await checkoutsOnMachine(deps.hub, machineId, agent, options.signal)
        : [];
    const lowerExplicit = new Set(explicit.map((r) => r.toLowerCase()));
    const repos = [...explicit, ...found.filter((r) => !lowerExplicit.has(r.toLowerCase()))].slice(
      0,
      GIT_SYNC_LIMITS.repos,
    );
    // Fresh each turn (GitHub's tokens last an hour; cached until a few minutes before), so the agent's own
    // `git fetch` keeps working between syncs.
    const tokens = await directFetchTokens(deps, { ...turn, machineId }, status.protocol, repos);
    const reply = await sync(
      repos.map((repo) => {
        const github = tokens.get(repo);
        return { repo, dir: gitCheckoutDir(repo), clone: false, ...(github ? { github } : {}) };
      }),
      true,
    );
    const present = reply.repos.filter((r) => {
      const [owner = "", name = ""] = r.repo.split("/");
      const there = r.status === "cloned" || r.status === "updated" || (r.status === "failed" && Boolean(r.head));
      // Only what the agent may still use (a repository removed from its list stays on disk, unmentioned).
      return there && repoInList(list, owner, name);
    });
    const downloading = reply.repos
      .filter((r) => {
        const [owner = "", name = ""] = r.repo.split("/");
        return r.status === "cloning" && repoInList(list, owner, name);
      })
      .map((r) => r.repo);
    const lower = new Set(present.map((r) => r.repo.toLowerCase()));
    const coming = new Set(downloading.map((r) => r.toLowerCase()));
    const notCloned = explicit.filter((r) => !lower.has(r.toLowerCase()) && !coming.has(r.toLowerCase()));
    if (present.length === 0 && notCloned.length === 0 && downloading.length === 0) {
      return credit ? { cwd: "", prompt: "", start: credit, pick: { present: [], credit } } : null;
    }
    const primary = explicit.find((r) => lower.has(r.toLowerCase()));
    const pick = {
      present: present.map((r) => ({ repo: r.repo, dir: r.dir, ...(r.path ? { path: r.path } : {}) })),
      ...(primary ? { primary } : {}),
      ...(credit ? { credit } : {}),
    };
    const checkouts: CodeCheckout[] = present.map((r) => ({
      repo: r.repo,
      path: r.path ?? r.dir,
      ...(r.defaultBranch ? { defaultBranch: r.defaultBranch } : {}),
      ...(r.status === "failed" ? { stale: r.message || "the update failed" } : {}),
    }));
    const prompt = codePrompt({ handle: agent.handle, checkouts, notCloned, downloading });
    return { ...codeStart(pick, turn), prompt, pick };
  } catch {
    // Offline, slow, refused: the turn goes on in the agent's folder, as before.
    return null;
  }
}

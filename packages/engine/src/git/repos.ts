import type { MergeDone } from "@agenteschat/adapters";
import { and, asc, type Database, type Executor, eq, schema } from "@agenteschat/db";
import { recordAgentActions } from "../agent-actions";
import { getAgent } from "../agents";
import { recordAudit } from "../audit";
import { fedByRoutine, runAuthorityById } from "../authority";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { can, requirePermission } from "../organizations";
import type { ToolContext } from "../tools/types";

const { agentRepositories: table, agents } = schema;

/**
 * The GitHub repositories an agent may use (`agent_repositories`): an
 * ordered list of `owner/name` or `owner/*` (a whole account). No list =
 * every repository the organization's GitHub reaches. The first entry is
 * where the agent starts when nobody names a repository. The git proxy and
 * the Tool Gateway check it on every GitHub call, reads included.
 */

export const MAX_AGENT_REPOSITORIES = 100;
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** "owner/name", "owner/*", a GitHub URL or "owner/name.git" → "owner/name" or "owner/*"; null when it isn't one. */
export function normalizeRepoEntry(input: string): string | null {
  const s = input
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  const [owner, name, ...rest] = s.split("/");
  if (rest.length > 0 || !owner || !name || !NAME.test(owner)) return null;
  if (name === "*") return `${owner}/*`;
  if (!NAME.test(name) || name === "." || name === "..") return null;
  return `${owner}/${name}`;
}

const REPO = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?$/;

/** "owner/name", "https://github.com/owner/name(.git)" → { owner, repo } or null. */
export function parseRepo(input: string) {
  const s = input
    .trim()
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/^git@github\.com:/, "")
    .replace(/\/$/, "");
  const m = REPO.exec(s);
  return m ? { owner: m[1] as string, repo: m[2] as string } : null;
}

/** Whether `owner/repo` is in the list (an empty list allows everything). Case-insensitive, like GitHub. */
export function repoInList(list: readonly string[], owner: string, repo: string) {
  if (list.length === 0) return true;
  const o = owner.toLowerCase();
  const full = `${o}/${repo.toLowerCase()}`;
  return list.some((entry) => {
    const e = entry.toLowerCase();
    return e === full || e === `${o}/*`;
  });
}

/**
 * The list as it is saved: valid entries, no repeats, no repository that an
 * `owner/*` of the list already covers. The order is kept.
 */
export function cleanRepoList(input: readonly string[]): { list: string[]; invalid: string[] } {
  const invalid: string[] = [];
  const valid: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const entry = normalizeRepoEntry(raw);
    if (!entry) {
      invalid.push(raw);
      continue;
    }
    if (seen.has(entry.toLowerCase())) continue;
    seen.add(entry.toLowerCase());
    valid.push(entry);
  }
  const wholes = new Set(valid.filter((e) => e.endsWith("/*")).map((e) => e.slice(0, -2).toLowerCase()));
  const list = valid.filter((e) => e.endsWith("/*") || !wholes.has(e.split("/")[0]?.toLowerCase() ?? ""));
  return { list, invalid };
}

/** The agent's repositories in order (no permission check: for the proxy, the gateway and the prompt). */
export async function agentRepositoryList(db: Executor, orgId: string, agentId: string): Promise<string[]> {
  const rows = await db
    .select({ repo: table.repo })
    .from(table)
    .where(and(eq(table.orgId, orgId), eq(table.agentId, agentId)))
    .orderBy(asc(table.position));
  return rows.map((r) => r.repo);
}

/** Whether every entry of `next` was already in reach with `current` (empty = every repository). */
function withinRepos(current: readonly string[], next: readonly string[]) {
  if (current.length === 0) return true;
  if (next.length === 0) return false;
  const have = new Set(current.map((e) => e.toLowerCase()));
  return next.every((entry) => {
    const lower = entry.toLowerCase();
    return have.has(lower) || have.has(`${lower.split("/")[0]}/*`);
  });
}

/** `GET …/agents/{id}/repositories` (any member). Empty = every repository. */
export async function getAgentRepositories(db: Database, actorId: string, orgId: string, agentId: string) {
  await requirePermission(db, actorId, orgId, "read");
  if (!(await getAgent(db, orgId, agentId))) throw new NotFoundError("Agent not found");
  return agentRepositoryList(db, orgId, agentId);
}

/**
 * `PUT …/agents/{id}/repositories`: replaces the list. Empty = every
 * repository. Admins set anything; the agent's owner may only narrow it (each
 * repository already in reach), like its access. Audited.
 */
export async function setAgentRepositories(
  db: Database,
  actorId: string,
  orgId: string,
  agentId: string,
  repositories: readonly string[],
) {
  const membership = await requirePermission(db, actorId, orgId, "read");
  const agent = await getAgent(db, orgId, agentId);
  if (!agent) throw new NotFoundError("Agent not found");
  const admin = can(membership, "manage_agents");
  if (!admin && agent.ownerUserId !== actorId) {
    throw new ForbiddenError("Only an admin or the agent's owner can change its repositories");
  }
  const { list, invalid } = cleanRepoList(repositories);
  if (invalid.length > 0) throw new ValidationError(`Not a repository (owner/name or owner/*): ${invalid.join(", ")}`);
  if (!admin && !withinRepos(await agentRepositoryList(db, orgId, agentId), list)) {
    throw new ForbiddenError("Only an admin can give an agent more repositories. Its owner can only take some away.");
  }
  if (list.length > MAX_AGENT_REPOSITORIES) {
    throw new ValidationError(`At most ${MAX_AGENT_REPOSITORIES} repositories per agent`);
  }
  await db.transaction(async (tx) => {
    await tx.delete(table).where(and(eq(table.orgId, orgId), eq(table.agentId, agentId)));
    if (list.length > 0) {
      await tx.insert(table).values(list.map((repo, position) => ({ orgId, agentId, repo, position })));
    }
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "agent.repositories_changed",
      target: { type: "agent", id: agentId },
      details: { repositories: list },
    });
  });
  return list;
}

/** Where "merge without asking" is on, as chosen, whether or not the agent still reaches each repository. */
async function chosenMergeRepos(db: Executor, orgId: string, agentId: string) {
  const [row] = await db
    .select({ repos: agents.mergeRepos })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), eq(agents.id, agentId)));
  return row?.repos ?? [];
}

const inReach = (list: readonly string[], entry: string) => {
  const [owner = "", repo = ""] = entry.split("/");
  return repoInList(list, owner, repo);
};

/**
 * The repositories this agent merges in without asking: what its owner or an admin chose, within its repositories
 * now (one taken away from the agent stops at once). Read fresh on every merge: turning one off asks at once.
 */
export async function agentMergeRepos(db: Executor, orgId: string, agentId: string): Promise<string[]> {
  const chosen = await chosenMergeRepos(db, orgId, agentId);
  if (chosen.length === 0) return [];
  const list = await agentRepositoryList(db, orgId, agentId);
  return chosen.filter((entry) => inReach(list, entry));
}

/**
 * Where this call may merge without asking: none outside a run (a mission keeps its own gates, and a receipt needs a
 * run), nor in a run a routine's reading woke, where text nobody checked feeds it and every write asks a person
 * (ADR 0053).
 */
export async function mergeReposOfCall(ctx: Pick<ToolContext, "db" | "orgId" | "agentId" | "runId">) {
  if (!ctx.runId) return [];
  const repos = await agentMergeRepos(ctx.db, ctx.orgId, ctx.agentId);
  if (repos.length === 0) return repos;
  const authority = await runAuthorityById(ctx.db, ctx.orgId, ctx.runId);
  return authority.kind === "unattended" && fedByRoutine(authority) ? [] : repos;
}

/** `GET …/agents/{id}/merge-repositories` (who sees the agent's details). */
export async function getAgentMergeRepositories(db: Database, actorId: string, orgId: string, agentId: string) {
  await requirePermission(db, actorId, orgId, "read");
  if (!(await getAgent(db, orgId, agentId))) throw new NotFoundError("Agent not found");
  return agentMergeRepos(db, orgId, agentId);
}

/**
 * `PUT …/agents/{id}/merge-repositories`: replaces the list. Its owner or an admin; exact repositories only (never a
 * whole account), each one the agent may use. Audited.
 */
export async function setAgentMergeRepositories(
  db: Database,
  actorId: string,
  orgId: string,
  agentId: string,
  repositories: readonly string[],
) {
  const membership = await requirePermission(db, actorId, orgId, "read");
  const agent = await getAgent(db, orgId, agentId);
  if (!agent) throw new NotFoundError("Agent not found");
  if (!can(membership, "manage_agents") && agent.ownerUserId !== actorId) {
    throw new ForbiddenError("Only an admin or the agent's owner can change where it merges without asking");
  }
  const { list, invalid } = cleanRepoList(repositories);
  const whole = list.filter((entry) => entry.endsWith("/*"));
  if (invalid.length + whole.length > 0) {
    throw new ValidationError(`Not a repository (owner/name): ${[...invalid, ...whole].join(", ")}`);
  }
  const reach = await agentRepositoryList(db, orgId, agentId);
  const outside = list.filter((entry) => !inReach(reach, entry));
  if (outside.length > 0) throw new ValidationError(`The agent doesn't use ${outside.join(", ")}`);
  if (list.length > MAX_AGENT_REPOSITORIES) {
    throw new ValidationError(`At most ${MAX_AGENT_REPOSITORIES} repositories per agent`);
  }
  await db.transaction(async (tx) => {
    await tx
      .update(agents)
      .set({ mergeRepos: list })
      .where(and(eq(agents.orgId, orgId), eq(agents.id, agentId)));
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "agent.merge_repositories_changed",
      target: { type: "agent", id: agentId },
      details: { repositories: list },
    });
  });
  return list;
}

/** A merge done without a card: its line in the audit, and its receipt under the agent's reply (nothing to undo). */
export async function recordMergeDone(ctx: ToolContext, merge: MergeDone, tool: string) {
  await recordAudit(ctx.db, {
    orgId: ctx.orgId,
    actor: { type: "agent", id: ctx.agentId },
    action: "agent.merged_without_asking",
    target: { type: "repository", id: merge.repo },
    details: { pr: merge.pr, ref: merge.ref, tool },
    runId: ctx.runId || null,
    channelId: ctx.channelId || null,
  });
  await recordAgentActions(ctx.db, ctx, [
    {
      kind: "pr.merged",
      target: { type: "repository", id: merge.repo, title: merge.repo },
      params: { repo: merge.repo, ...(merge.pr ? { number: merge.pr } : {}), ...(merge.ref ? { ref: merge.ref } : {}) },
      final: true,
    },
  ]);
}

/**
 * The repositories a GitHub tool call names: `owner` + `repo` (GitHub's MCP
 * tools), `repo: "owner/name"` (git_clone, open_pull_request) or `repo:`
 * qualifiers of a search query. Null when it names none, or when a search
 * also reaches whole accounts (`org:`, `user:`).
 */
export function reposOfGithubCall(input: Record<string, unknown>): string[] | null {
  const owner = str(input.owner);
  const repo = str(input.repo);
  if (owner && repo) return NAME.test(owner) && NAME.test(repo) ? [`${owner}/${repo}`] : null;
  if (repo) {
    const entry = normalizeRepoEntry(repo);
    return entry && !entry.endsWith("/*") ? [entry] : null;
  }
  const query = str(input.query) || str(input.q);
  if (!query || /(^|\s)-?(org|user|owner):/i.test(query)) return null;
  const named = [...query.matchAll(/(?:^|\s)repo:(\S+)/gi)].map((m) => normalizeRepoEntry(m[1] ?? ""));
  if (named.length === 0 || named.some((r) => !r || r.endsWith("/*"))) return null;
  return named as string[];
}

export type GithubCallCheck =
  | { ok: true; repo: string | null }
  | { ok: false; repo: string | null; message: string; list: string[] };

/** Checks a GitHub tool call against the agent's repositories (the Tool Gateway, before running or asking). */
export async function checkGithubCall(
  db: Executor,
  orgId: string,
  agentId: string,
  input: Record<string, unknown>,
): Promise<GithubCallCheck> {
  const named = reposOfGithubCall(input);
  const list = await agentRepositoryList(db, orgId, agentId);
  if (list.length === 0) return { ok: true, repo: named?.[0] ?? null };
  if (!named) {
    return {
      ok: false,
      repo: null,
      list,
      message: `Not allowed: you may only use these GitHub repositories: ${list.join(", ")}. Name one of them in the call (owner and repo; in a search, repo: qualifiers only).`,
    };
  }
  const denied = named.find((full) => {
    const [o = "", r = ""] = full.split("/");
    return !repoInList(list, o, r);
  });
  if (denied) {
    return {
      ok: false,
      repo: denied,
      list,
      message: `Not allowed: ${denied} isn't one of your GitHub repositories (${list.join(", ")}). Tell the person; whoever can edit you can add it in your access settings. Don't try another way.`,
    };
  }
  return { ok: true, repo: named[0] ?? null };
}

/** The prompt block for an agent limited to some repositories (English). Empty when it has no list. */
export function repositoriesPrompt(list: readonly string[]): string {
  if (list.length === 0) return "";
  const say = (r: string) => (r.endsWith("/*") ? `every repository of ${r.slice(0, -2)} (${r})` : r);
  const first = list[0] as string;
  return [
    "# Your GitHub repositories",
    `You may only use these GitHub repositories, reading included: ${list.map(say).join(", ")}.`,
    first.endsWith("/*")
      ? `When nobody names a repository, search the repositories of ${first.slice(0, -2)} first (search_code) and pick the one that fits; ask only if it stays unclear.`
      : `When nobody names a repository, work in ${first}.`,
    "Anything else is refused: say which repository you would need and that whoever can edit you can add it in your access settings.",
  ].join("\n");
}

/** A checkout of a repository on the agent's connected machine, as `git.sync` reported it. */
export interface CodeCheckout {
  /** `owner/name`. */
  repo: string;
  /** Where it is on the machine (absolute when the runner said, else relative to the agent's folder). */
  path: string;
  defaultBranch?: string;
  /** Why it couldn't be updated before this turn (offline, refused…); absent when it was. */
  stale?: string;
}

/**
 * The "# Your code" prompt block for an agent whose computer is a connected
 * machine (English): its checkouts (updated before the turn), how to change
 * code (its own branch, a push through our proxy, a pull request), and the
 * granted repositories not cloned yet. Empty when there is nothing to say.
 */
export function codePrompt(input: {
  handle: string;
  checkouts: readonly CodeCheckout[];
  /** Granted repositories (`owner/name`) with no checkout yet. */
  notCloned: readonly string[];
  /** Repositories still downloading on the computer (ADR 0116). */
  downloading?: readonly string[];
}): string {
  const downloading = input.downloading ?? [];
  if (input.checkouts.length === 0 && input.notCloned.length === 0 && downloading.length === 0) return "";
  const lines = ["# Your code"];
  for (const c of input.checkouts) {
    const branch = c.defaultBranch ? `default branch ${c.defaultBranch}` : "default branch";
    lines.push(
      c.stale
        ? `${c.repo} is checked out at ${c.path} (${branch}; it couldn't be updated before this turn: ${c.stale}).`
        : `${c.repo} is checked out at ${c.path} (${branch}, updated before this turn).`,
    );
  }
  if (input.checkouts.length > 0) {
    lines.push(
      `Read it freely; to change code, create a branch agentes/${input.handle}/<topic> there, push it (git push -u origin agentes/${input.handle}/<topic>) and open a PR with open_pull_request. Delete branches with delete_branches; to push to someone else's branch, ask with request_branch_push first.`,
    );
  }
  if (input.notCloned.length > 0) {
    lines.push(
      `Not cloned yet: ${input.notCloned.join(", ")}. To work on one, call git_clone first; it needs no approval.`,
    );
  }
  if (downloading.length > 0) {
    lines.push(
      `Still downloading on your computer: ${downloading.join(", ")}. It goes on by itself; call git_clone for one when you need it, to wait for it.`,
    );
  }
  return lines.join("\n");
}

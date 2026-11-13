import { and, type Database, desc, type Executor, eq, gt, gte, inArray, schema } from "@agenteschat/db";
import { RULE_REMOVED_AUDIT } from "../approval-rules";
import { connectorScope } from "../connectors/catalog";
import { type ConnectorConnection, type ConnectorDeps, connectionHeaders } from "../connectors/connections";
import { type AppPermissions, appTokenForRepo, type GitHubAppConfig, type GitHubHttp } from "./github-app";
import { parseRepo } from "./repos";

const { approvalRules, approvals, auditLog } = schema;

/**
 * Branches that aren't the agent's own (ADR 0024, addendum of 2026-10-31): a person approves deleting them
 * (`delete_branches`, on GitHub's API) or pushing to one (`request_branch_push`, then a plain push through the
 * proxy), and GitHub is asked first that none is the default branch or protected. Shared by the git tools and the
 * proxy.
 */
export const DELETE_BRANCHES_TOOL = "delete_branches";
export const BRANCH_PUSH_TOOL = "request_branch_push";
/** How long a person's approval of `request_branch_push` lets the agent push there, from the decision. */
export const PUSH_GRANT_MS = 24 * 3600_000;

type Repo = { owner: string; repo: string };

/** What `git check-ref-format` refuses in a branch name, plus a full ref, `HEAD` or `@` (the tools take names). */
const NOT_A_BRANCH = /[^\x21-\x7e -￿]|[~^:?*[\\]|\.\.|@\{|\/\/|^[/.-]|\/\.|[/.]$|\.lock(\/|$)|^refs\/|^(HEAD|@)$/;
export const validBranch = (name: string) => name.length > 0 && name.length <= 200 && !NOT_A_BRANCH.test(name);

/** What a push grant is kept and compared by: `owner/repo:branch`, the repository in lower case as GitHub reads it. */
export const pushGrantKey = (repo: Repo, branch: string) =>
  `${repo.owner.toLowerCase()}/${repo.repo.toLowerCase()}:${branch}`;

/** The grant key a `request_branch_push` call names (its input, or an approval's params); null when it names none. */
export function pushGrantKeyOf(input: Record<string, unknown>): string | null {
  const repo = typeof input.repo === "string" ? parseRepo(input.repo) : null;
  const branch = typeof input.branch === "string" ? input.branch : "";
  return repo && validBranch(branch) ? pushGrantKey(repo, branch) : null;
}

export const githubHeaders = (token: string) => ({
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "user-agent": "agentes.chat",
});

/** A branch name in a REST path: each part escaped, the slashes kept. */
export const branchPath = (name: string) => name.split("/").map(encodeURIComponent).join("/");

/**
 * The server's GitHub token for one repository: the GitHub App's installation token when the app is installed there
 * for this organization, else the connection's own. Null when neither works.
 */
export async function githubToken(
  deps: { connectors: ConnectorDeps; app?: GitHubAppConfig | null },
  http: GitHubHttp,
  tenant: { db: Database; orgId: string },
  connection: ConnectorConnection,
  repo: Repo,
  permissions: AppPermissions | AppPermissions[],
): Promise<string | null> {
  const app = deps.app
    ? await appTokenForRepo(deps.app, http, tenant, repo.owner, repo.repo, permissions).catch(() => null)
    : null;
  if (app) return app;
  return connectionToken(deps.connectors, connection).catch(() => null);
}

/**
 * The GitHub connection's own token (a key pasted in Conectores, or OAuth's, refreshed when it is about to expire).
 * Null when it has none. Throws what refreshing it threw: the provider refusing (`ValidationError`), or no answer.
 */
export async function connectionToken(connectors: ConnectorDeps, connection: ConnectorConnection) {
  return (await connectionHeaders(connectors, connection)).authorization?.replace(/^Bearer\s+/i, "") || null;
}

/** A branch as GitHub has it: missing (no branch by that exact name), or its classic protection and ruleset rules. */
export type BranchFact = { exists: false } | { exists: true; protected: boolean; rules: string[] };

export interface BranchFacts {
  defaultBranch: string;
  branches: Map<string, BranchFact>;
}

/** Ruleset rules about creating, deleting or force pushing a branch: the proxy decides those itself. */
const UPDATE_NEUTRAL_RULES = new Set(["creation", "deletion", "non_fast_forward"]);

/** GitHub's rate limits: an answer that says nothing about the branch. */
const limited = (res: Response) =>
  res.status === 429 || res.headers.has("retry-after") || res.headers.get("x-ratelimit-remaining") === "0";

/**
 * What GitHub says about a repository's default branch and each of `names`, asked with the server's token: whether
 * the branch exists under that exact name, its classic protection and the ruleset rules that apply. Null when a
 * question went unanswered, and whoever asked refuses. Rules GitHub won't list for the repository (403 or 404, as on
 * a plan without rulesets) count as none: GitHub still enforces what it has.
 */
export async function branchFacts(
  http: GitHubHttp,
  token: string,
  repo: Repo,
  names: readonly string[],
): Promise<BranchFacts | null> {
  const base = `${http.apiUrl}/repos/${repo.owner}/${repo.repo}`;
  const get = (path: string) =>
    http.fetch(`${base}${path}`, { headers: githubHeaders(token), redirect: "manual" }).catch(() => null);
  const json = (res: Response) => res.json().catch(() => null) as Promise<unknown>;
  const fact = async (name: string): Promise<BranchFact | null> => {
    const [branch, rules] = await Promise.all([
      get(`/branches/${branchPath(name)}`),
      get(`/rules/branches/${branchPath(name)}`),
    ]);
    if (!branch || !rules) return null;
    // A renamed branch answers with a redirect to its new name.
    if (branch.status === 404 || (branch.status >= 300 && branch.status < 400)) return { exists: false };
    if (!branch.ok) return null;
    const body = (await json(branch)) as { name?: unknown; protected?: unknown } | null;
    if (!body) return null;
    if (body.name !== name) return { exists: false };
    let types: string[];
    if (rules.ok) {
      const list = await json(rules);
      if (!Array.isArray(list)) return null;
      types = list.map((r) => String((r as { type?: unknown } | null)?.type ?? ""));
    } else if ((rules.status === 403 || rules.status === 404) && !limited(rules)) types = [];
    else return null;
    return { exists: true, protected: body.protected === true, rules: types };
  };
  const info = get("").then(async (res) => (res?.ok ? ((await json(res)) as { default_branch?: unknown }) : null));
  const branches = new Map<string, BranchFact>();
  // Ten branches at a time: GitHub limits how many requests run at once.
  for (let i = 0; i < names.length; i += 10) {
    const chunk = names.slice(i, i + 10);
    const answers = await Promise.all(chunk.map(fact));
    for (const [j, answer] of answers.entries()) {
      if (!answer) return null;
      branches.set(chunk[j] as string, answer);
    }
  }
  const defaultBranch = (await info)?.default_branch;
  return typeof defaultBranch === "string" && defaultBranch ? { defaultBranch, branches } : null;
}

export type BranchBlock = "missing" | "default" | "protected";

/**
 * What keeps agents off this branch, or null: missing, the default branch, or protected (classic protection, or a
 * ruleset's `deletion` rule when `deleting`, else any ruleset rule that guards updates).
 */
export function branchBlock(facts: BranchFacts, branch: string, deleting: boolean): BranchBlock | null {
  const fact = facts.branches.get(branch);
  if (!fact?.exists) return "missing";
  if (branch === facts.defaultBranch) return "default";
  const ruled = deleting ? fact.rules.includes("deletion") : fact.rules.some((r) => !UPDATE_NEUTRAL_RULES.has(r));
  return fact.protected || ruled ? "protected" : null;
}

export type PushGrant = { approvalId: string } | { ruleId: string };

/**
 * What lets an agent push to branches that aren't its own through the proxy, by grant key: a rule someone approved
 * for good, or a person's approval of `request_branch_push` decided in the last 24 h (its params read through the
 * same key) and after that key's rule was last removed. The proxy has no run, so any of the agent's runs may use it.
 * A key nothing grants is left out. Three queries at most, whatever the number of keys.
 */
export async function pushGrants(
  db: Executor,
  at: { orgId: string; agentId: string; connectionId: string },
  keys: readonly string[],
  now: Date,
): Promise<Map<string, PushGrant>> {
  const grants = new Map<string, PushGrant>();
  if (keys.length === 0) return grants;
  const rules = await db
    .select({ id: approvalRules.id, action: approvalRules.action })
    .from(approvalRules)
    .where(
      and(
        eq(approvalRules.orgId, at.orgId),
        eq(approvalRules.agentId, at.agentId),
        eq(approvalRules.connectionId, at.connectionId),
        eq(approvalRules.tool, BRANCH_PUSH_TOOL),
        inArray(approvalRules.action, [...keys]),
      ),
    );
  for (const rule of rules) grants.set(rule.action, { ruleId: rule.id });
  const wanted = new Set(keys.filter((k) => !grants.has(k)));
  if (wanted.size === 0) return grants;
  const recent = await db
    .select({ id: approvals.id, params: approvals.params, decidedAt: approvals.decidedAt })
    .from(approvals)
    .where(
      and(
        eq(approvals.orgId, at.orgId),
        eq(approvals.agentId, at.agentId),
        eq(approvals.connectionId, at.connectionId),
        eq(approvals.tool, BRANCH_PUSH_TOOL),
        eq(approvals.scope, connectorScope("github", "git.write")),
        eq(approvals.status, "approved"),
        gt(approvals.decidedAt, new Date(now.getTime() - PUSH_GRANT_MS)),
      ),
    )
    .orderBy(desc(approvals.decidedAt));
  const hits = recent.flatMap((a) => {
    const key = pushGrantKeyOf(a.params);
    return key && wanted.has(key) && a.decidedAt ? [{ id: a.id, key, decidedAt: a.decidedAt }] : [];
  });
  const oldest = hits.at(-1);
  if (!oldest) return grants;
  // Removing an "Aprovar sempre" rule ends what was approved for that branch before, the approval it came from too.
  const removals = await db
    .select({ details: auditLog.details, createdAt: auditLog.createdAt })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.orgId, at.orgId),
        eq(auditLog.action, RULE_REMOVED_AUDIT),
        eq(auditLog.targetId, at.agentId),
        gte(auditLog.createdAt, oldest.decidedAt),
      ),
    );
  const removedAt = new Map<string, Date>();
  for (const { details: d, createdAt } of removals) {
    if (d.tool !== BRANCH_PUSH_TOOL || d.connectionId !== at.connectionId || typeof d.action !== "string") continue;
    const last = removedAt.get(d.action);
    if (!last || createdAt > last) removedAt.set(d.action, createdAt);
  }
  for (const hit of hits) {
    const removed = removedAt.get(hit.key);
    if (!grants.has(hit.key) && (!removed || hit.decidedAt > removed)) grants.set(hit.key, { approvalId: hit.id });
  }
  return grants;
}

import type { Database } from "@agenteschat/db";
import { activeConnections, type ConnectorDeps } from "../connectors/connections";
import { NotFoundError } from "../errors";
import { requirePermission } from "../organizations";
import { connectionToken } from "./branches";
import { boundInstallations, type GitHubAppConfig, type GitHubHttp, installationToken } from "./github-app";

export interface GitHubRepositoryView {
  /** `owner/name`, as GitHub spells it. */
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  /** Last push (or update), ISO; null when GitHub didn't say. */
  updatedAt: string | null;
}

export interface GitHubAccountView {
  login: string;
  /** GitHub's `Organization` or `User`. */
  type: string;
  repositories: GitHubRepositoryView[];
}

/** The repositories the organization's GitHub reaches, by account. Never carries a token. */
export interface OrgRepositoryListing {
  /** GitHub is connected (a connection, or the app installed on some account). */
  connected: boolean;
  accounts: GitHubAccountView[];
  /** GitHub had more than we read (very large accounts). */
  truncated: boolean;
}

export interface RepoListingDeps {
  db: Database;
  connectors: ConnectorDeps;
  app?: GitHubAppConfig | null;
  /** GitHub's REST API (tests: a fake). */
  github?: GitHubHttp;
  now?: () => number;
}

const TTL_MS = 60_000;
/** Pages of 100 read per source (connection, each installation). */
const MAX_PAGES = 5;
/** By organization, with the GitHub connection it was read with (null: none). */
const cache = new Map<string, { at: number; connectionId: string | null; value: OrgRepositoryListing }>();

/** Drops an organization's cached listing (an installation changed: a new connection is noticed by itself). */
export function forgetOrgRepositories(orgId: string) {
  cache.delete(orgId);
}

interface GitHubRepo {
  full_name?: string;
  name?: string;
  private?: boolean;
  pushed_at?: string | null;
  updated_at?: string | null;
  owner?: { login?: string; type?: string };
}

/**
 * `GET …/github/repositories`: what the org's GitHub connection sees
 * (`/user/repos`) plus the repositories of the GitHub App installations
 * bound to it (`/installation/repositories`), merged by account. Cached for
 * a minute per organization and GitHub connection; tokens stay on the server.
 */
export async function listOrgRepositories(
  deps: RepoListingDeps,
  actorId: string,
  orgId: string,
): Promise<OrgRepositoryListing> {
  await requirePermission(deps.db, actorId, orgId, "read");
  const now = deps.now?.() ?? Date.now();
  const connection = (await activeConnections(deps.db, orgId)).find((c) => c.connector === "github");
  const connectionId = connection?.id ?? null;
  const hit = cache.get(orgId);
  // A connection made, replaced or removed since shows at once (the app's events forget the listing themselves).
  if (hit && now - hit.at < TTL_MS && hit.connectionId === connectionId) return hit.value;
  const github = deps.github ?? { apiUrl: "https://api.github.com", fetch };
  const found = new Map<string, GitHubRepo>();
  let truncated = false;
  const read = async (token: string, path: (page: number) => string, pick: (body: unknown) => GitHubRepo[]) => {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await github.fetch(`${github.apiUrl}${path(page)}`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "user-agent": "agentes.chat",
        },
      });
      if (!res.ok) return;
      const repos = pick(await res.json().catch(() => null));
      for (const r of repos) if (r.full_name) found.set(r.full_name.toLowerCase(), r);
      if (repos.length < 100) return;
      if (page === MAX_PAGES) truncated = true;
    }
  };

  if (connection) {
    const token = await connectionToken(deps.connectors, connection).catch(() => null);
    if (token) {
      await read(
        token,
        (page) =>
          `/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`,
        (body) => (Array.isArray(body) ? (body as GitHubRepo[]) : []),
      ).catch(() => {});
    }
  }
  const installations = deps.app ? await boundInstallations(deps.db, orgId) : [];
  for (const i of installations) {
    if (!deps.app) break;
    const token = await installationToken(deps.app, github, { db: deps.db, orgId }, i.installationId).catch(() => null);
    if (!token) continue;
    await read(
      token,
      (page) => `/installation/repositories?per_page=100&page=${page}`,
      (body) => (body as { repositories?: GitHubRepo[] } | null)?.repositories ?? [],
    ).catch(() => {});
  }

  const accounts = new Map<string, GitHubAccountView>();
  for (const r of found.values()) {
    const [owner = "", name = r.name ?? ""] = (r.full_name ?? "").split("/");
    const key = owner.toLowerCase();
    const account = accounts.get(key) ?? {
      login: r.owner?.login ?? owner,
      type: r.owner?.type ?? "User",
      repositories: [],
    };
    account.repositories.push({
      fullName: r.full_name ?? `${owner}/${name}`,
      owner: account.login,
      name,
      private: r.private === true,
      updatedAt: r.pushed_at ?? r.updated_at ?? null,
    });
    accounts.set(key, account);
  }
  const recent = (a: GitHubRepositoryView, b: GitHubRepositoryView) =>
    (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.name.localeCompare(b.name);
  const value: OrgRepositoryListing = {
    connected: Boolean(connection) || installations.length > 0,
    accounts: [...accounts.values()]
      .map((a) => ({ ...a, repositories: a.repositories.sort(recent) }))
      // Organizations first, then people; by name.
      .sort(
        (a, b) =>
          Number(a.type !== "Organization") - Number(b.type !== "Organization") || a.login.localeCompare(b.login),
      ),
    truncated,
  };
  cache.set(orgId, { at: now, connectionId, value });
  return value;
}

/** What GitHub shows as the organizations this OAuth sign-in may reach. */
export interface GitHubOrgAccess {
  /** Their logins; null when GitHub didn't answer. */
  orgs: string[] | null;
  /**
   * GitHub's page of our app, where a person grants or requests each organization: its sign-in asks only the first
   * time, so going through it again never brings that choice back. Null on an API key, which isn't our app's.
   */
  manageUrl: string | null;
}

/**
 * `GET …/github/access`: the organizations the GitHub connection reaches now. GitHub lists only those the
 * authorization allows, so a grant shows here as soon as it is made, on the token we already hold.
 */
export async function githubOrgAccess(deps: RepoListingDeps, actorId: string, orgId: string): Promise<GitHubOrgAccess> {
  await requirePermission(deps.db, actorId, orgId, "manage_connectors");
  const connection = (await activeConnections(deps.db, orgId)).find((c) => c.connector === "github");
  if (!connection) throw new NotFoundError("GitHub isn't connected");
  // Read as a person comes back from granting one: its repositories show now, not when the listing expires.
  forgetOrgRepositories(orgId);
  const clientId = connection.authType === "oauth" ? deps.connectors.oauthApps?.github?.clientId : undefined;
  const manageUrl = clientId
    ? `https://github.com/settings/connections/applications/${encodeURIComponent(clientId)}`
    : null;
  const token = await connectionToken(deps.connectors, connection).catch(() => null);
  if (!token) return { orgs: null, manageUrl };
  const github = deps.github ?? { apiUrl: "https://api.github.com", fetch };
  const res = await github
    .fetch(`${github.apiUrl}/user/orgs?per_page=100`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "agentes.chat",
      },
    })
    .catch(() => null);
  const body = res?.ok ? ((await res.json().catch(() => null)) as { login?: unknown }[] | null) : null;
  if (!Array.isArray(body)) return { orgs: null, manageUrl };
  return { orgs: body.flatMap((o) => (typeof o.login === "string" ? [o.login] : [])), manageUrl };
}

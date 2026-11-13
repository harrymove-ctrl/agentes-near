import type { Database } from "@agenteschat/db";
import {
  type ConnectorConnection,
  type ConnectorDeps,
  connectionHeaders,
  GITHUB_APP_AUTH,
} from "../connectors/connections";
import {
  type AppPermissions,
  type AppTokenMiss,
  appRepoToken,
  boundInstallations,
  type GitHubAppConfig,
  type GitHubHttp,
  installationToken,
} from "./github-app";
import { reposOfGithubCall } from "./repos";

/** The server's GitHub App as GitHub calls read it: the app now (env or Settings), and GitHub's REST API. */
export interface GitHubAppAccess {
  app(): GitHubAppConfig | null;
  http: GitHubHttp;
}

/**
 * What an installation token of the app may do for a call, by our scope (ADR 0156), most first: GitHub refuses a set
 * the installation lacks (`workflows` on an older installation, or a permission it hasn't accepted yet) and the next
 * is asked. A scope with none never goes through the app.
 */
const SCOPE_PERMISSIONS: Record<string, AppPermissions[]> = {
  "repo.read": [{ contents: "read" }],
  "git.read": [{ contents: "read" }],
  "repo.write": [{ contents: "write", workflows: "write" }, { contents: "write" }],
  "git.write": [{ contents: "write", workflows: "write" }, { contents: "write" }],
  "repo.admin": [{ administration: "write" }],
  "pr.read": [{ pull_requests: "read", checks: "read", statuses: "read" }],
  "pr.write": [{ pull_requests: "write", contents: "read" }],
  "pr.merge": [{ contents: "write", pull_requests: "write" }],
  // A pull request's number goes through the issues endpoints too (comments, labels, assignees), and GitHub refuses
  // an app token without `pull_requests` there ("Resource not accessible by integration").
  "issues.read": [{ issues: "read", pull_requests: "read" }, { issues: "read" }],
  "issues.write": [{ issues: "write", pull_requests: "write" }, { issues: "write" }],
  "actions.read": [{ actions: "read" }],
  // An installation that hasn't accepted it refuses, and an account's connection runs it.
  "actions.run": [{ actions: "write" }],
  "discussions.read": [{ discussions: "read" }],
  "discussions.write": [{ discussions: "write" }],
  "org.read": [{ members: "read" }],
  // An organization's Projects (`organizationOnly`); an item's title and fields are its issue's or pull request's.
  "projects.read": [
    { organization_projects: "read", issues: "read", pull_requests: "read" },
    { organization_projects: "read" },
  ],
  "projects.write": [
    { organization_projects: "write", issues: "read", pull_requests: "read" },
    { organization_projects: "write" },
  ],
};

/**
 * Tools that need other permissions than their scope's: updating a pull request's branch writes to it, each kind of
 * security alert has its own permission, and a ruleset's evaluations (rule suites) are administration's.
 */
const TOOL_PERMISSIONS: Record<string, AppPermissions[]> = {
  update_pull_request_branch: [{ pull_requests: "write", contents: "write" }],
  repository_ruleset_read: [{ administration: "read" }, { metadata: "read" }],
  list_code_scanning_alerts: [{ security_events: "read" }],
  get_code_scanning_alert: [{ security_events: "read" }],
  list_dependabot_alerts: [{ vulnerability_alerts: "read" }],
  get_dependabot_alert: [{ vulnerability_alerts: "read" }],
  list_secret_scanning_alerts: [{ secret_scanning_alerts: "read" }],
  get_secret_scanning_alert: [{ secret_scanning_alerts: "read" }],
  list_repository_security_advisories: [{ repository_advisories: "read" }],
  // GitHub lists an organization's advisories only to who may write them.
  list_org_repository_security_advisories: [{ repository_advisories: "write" }],
};

export const appPermissionsFor = (tool: string, scope: string): AppPermissions[] | null =>
  TOOL_PERMISSIONS[tool] ?? SCOPE_PERMISSIONS[scope] ?? null;

/**
 * Calls the app makes only on an organization's installation the call names: GitHub Apps can't reach a person's
 * Projects, and create repositories only in an organization. Anywhere else they need an account's connection.
 */
const organizationOnly = (call: { tool: string; scope: string }) =>
  call.scope.startsWith("projects.") || call.tool === "create_repository";

/** Why a call can't reach GitHub through the app here, as the agent is told it: the real cause and the way out. */
export function appMissMessage(target: string, miss: AppTokenMiss | "no_app" | "account_only"): string {
  switch (miss) {
    case "not_installed":
      return `The agentes.chat GitHub app isn't installed on ${target} for this workspace, so GitHub can't be reached there. Tell the person: an admin adds ${target} to the app in Settings › Connectors › GitHub repositories (Manage on GitHub).`;
    case "refused":
      return `GitHub didn't let the agentes.chat app do this on ${target}: its installation there hasn't granted that permission. Tell the person: an admin accepts the app's new permissions on GitHub (Settings › Connectors › GitHub repositories › Manage on GitHub), or connects a GitHub account in Settings › Connectors, and agents then do it as that account.`;
    case "unreachable":
      return `GitHub didn't answer about ${target}. Nothing was done: try again in a moment.`;
    case "account_only":
      return "This needs a GitHub account: the agentes.chat app can't do it. Tell the person: an admin connects a GitHub account in Settings › Connectors.";
    case "no_app":
      return "GitHub reaches this workspace only through the agentes.chat GitHub app, and this server has no app now. Tell the person: the server's owner sets the app up again in Settings › Connectors, or an admin connects a GitHub account there.";
  }
}

/** What our git tools and the proxy say when no token reaches a repository. */
export const noTokenMessage = (connection: Pick<ConnectorConnection, "authType">, repo: string) =>
  connection.authType === GITHUB_APP_AUTH
    ? appMissMessage(repo, "not_installed")
    : "GitHub is connected without a usable token.";

/**
 * The account a call names without a repository: `owner` (an organization's tools say `org` or `organization`), else
 * a search's `org:`, `user:` or `owner:`.
 */
function ownerOfCall(input: Record<string, unknown>): string | null {
  for (const key of ["owner", "org", "organization"]) {
    const named = input[key];
    if (typeof named === "string" && named.trim()) return named.trim();
  }
  const query = typeof input.query === "string" ? input.query : typeof input.q === "string" ? input.q : "";
  return /(?:^|\s)(?:org|user|owner):([A-Za-z0-9_.-]{1,100})/i.exec(query)?.[1] ?? null;
}

/** How a call reaches GitHub: its headers and the token in them, or why it can't (said to the agent). */
export type GitHubCallAuth = { headers: Record<string, string>; token: string | null } | { refused: string };

const bearer = (token: string): GitHubCallAuth => ({ headers: { authorization: `Bearer ${token}` }, token });

/**
 * Who a GitHub tool call goes as (ADR 0156): wherever an installation of the app bound to this workspace covers what
 * the call names, its short token (one repository: that repository's; an account or several of its repositories: the
 * installation's), so what the agent writes comes from the app's bot. Elsewhere the workspace's account connection,
 * as before; GitHub through the app alone says why it can't instead.
 */
export async function githubCallAuth(
  connectors: ConnectorDeps,
  github: GitHubAppAccess | undefined,
  ctx: { db: Database; orgId: string },
  connection: ConnectorConnection,
  call: { tool: string; scope: string; input: Record<string, unknown> },
): Promise<GitHubCallAuth> {
  const appOnly = connection.authType === GITHUB_APP_AUTH;
  const viaAccount = async (): Promise<GitHubCallAuth> => {
    const headers = await connectionHeaders(connectors, connection);
    return { headers, token: headers.authorization?.replace(/^Bearer\s+/i, "") || null };
  };
  const app = github?.app() ?? null;
  const permissions = appPermissionsFor(call.tool, call.scope);
  if (!app || !github || !permissions) {
    if (!appOnly) return viaAccount();
    return { refused: appMissMessage("", app ? "account_only" : "no_app") };
  }
  const tenant = { db: ctx.db, orgId: ctx.orgId };
  const repos = reposOfGithubCall(call.input);
  const only = repos?.length === 1 ? repos[0] : undefined;
  if (only) {
    const [owner = "", repo = ""] = only.split("/");
    const got = await appRepoToken(app, github.http, tenant, owner, repo, permissions);
    if ("token" in got) return bearer(got.token);
    return appOnly ? { refused: appMissMessage(only, got.miss) } : viaAccount();
  }
  const owners = new Set((repos ?? []).map((r) => (r.split("/")[0] ?? "").toLowerCase()));
  const owner = repos ? (owners.size === 1 ? [...owners][0] : null) : ownerOfCall(call.input);
  const accountOnly = async (): Promise<GitHubCallAuth> =>
    appOnly ? { refused: appMissMessage("", "account_only") } : viaAccount();
  const orgOnly = organizationOnly(call);
  if (orgOnly && !owner) return accountOnly();
  const installations = await boundInstallations(ctx.db, ctx.orgId);
  const installation = owner
    ? installations.find((i) => i.accountLogin.toLowerCase() === owner.toLowerCase())
    : appOnly
      ? installations[0]
      : undefined;
  if (orgOnly && installation && installation.accountType !== "Organization") return accountOnly();
  if (installation) {
    const token = await installationToken(app, github.http, tenant, installation.installationId, permissions);
    if (token) return bearer(token);
  }
  if (!appOnly) return viaAccount();
  const target = owner ?? installation?.accountLogin ?? "the workspace's GitHub accounts";
  return { refused: appMissMessage(target, installation ? "refused" : "not_installed") };
}

/**
 * The headers a connection's tools are listed with: GitHub through the app alone lists them with its first
 * installation's token (metadata only); null when it has none to list with.
 */
export async function githubListingHeaders(
  connectors: ConnectorDeps,
  github: GitHubAppAccess | undefined,
  ctx: { db: Database; orgId: string },
  connection: ConnectorConnection,
): Promise<Record<string, string> | null> {
  if (connection.authType !== GITHUB_APP_AUTH) return connectionHeaders(connectors, connection);
  const app = github?.app();
  if (!app || !github) return null;
  for (const i of await boundInstallations(ctx.db, ctx.orgId)) {
    const token = await installationToken(app, github.http, ctx, i.installationId);
    if (token) return { authorization: `Bearer ${token}` };
  }
  return null;
}

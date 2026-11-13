import { createSign } from "node:crypto";
import { and, type Database, eq, isNull, schema } from "@agenteschat/db";

const { githubAppInstallations } = schema;

/**
 * Our GitHub App (ADR 0033, 0156): `GITHUB_APP_*`, else the one the server's owner made from Settings
 * (`github-app-settings.ts`). Short tokens scoped to one repo. The app is public; installations count only for the
 * organization that installed it from agentes.chat (`github_app_installations`, see `github-app-installs.ts`).
 */
export interface GitHubAppConfig {
  appId: string;
  /** PEM (PKCS#1 or PKCS#8). */
  privateKey: string;
  /** `github.com/apps/{slug}`: where organizations install it. */
  slug?: string;
  /** User authorization during installation (proves the installer can see the installation). */
  clientId?: string;
  clientSecret?: string;
  webhookSecret?: string;
  /** The app's page on GitHub, when GitHub said it. */
  htmlUrl?: string;
}

/** Where GitHub sends a person back after installing the app (registered as its callback URL). */
export const githubAppCallbackUri = (publicUrl: string) =>
  `${publicUrl.replace(/\/$/, "")}/api/app/github-app/callback`;

export interface GitHubHttp {
  fetch: typeof fetch;
  /** `https://api.github.com` (tests: a fake). */
  apiUrl: string;
}

/** What an installation token may do, as GitHub names its permissions. */
export type AppPermissions = Record<string, "read" | "write">;

const tokens = new Map<string, { token: string; installationId: number; expiresAt: number }>();

/** Drops cached tokens of an installation (uninstalled, suspended, unbound). */
export function forgetInstallationTokens(installationId: number) {
  for (const [key, value] of tokens) if (value.installationId === installationId) tokens.delete(key);
}

/** Drops every cached token: the server's app changed (made, replaced or removed in Settings). */
export function forgetAllInstallationTokens() {
  tokens.clear();
}

function appJwt(app: GitHubAppConfig, now = Date.now()) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const iat = Math.floor(now / 1000) - 60;
  const payload = Buffer.from(JSON.stringify({ iat, exp: iat + 9 * 60, iss: app.appId })).toString("base64url");
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(app.privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

const appHeaders = (app: GitHubAppConfig) => ({
  authorization: `Bearer ${appJwt(app)}`,
  accept: "application/vnd.github+json",
  "user-agent": "agentes.chat",
});

/** The installation is bound to this organization and not suspended. */
async function boundToOrg(db: Database, orgId: string, installationId: number) {
  const [row] = await db
    .select({ id: githubAppInstallations.id })
    .from(githubAppInstallations)
    .where(
      and(
        eq(githubAppInstallations.installationId, installationId),
        eq(githubAppInstallations.orgId, orgId),
        isNull(githubAppInstallations.suspendedAt),
      ),
    );
  return Boolean(row);
}

/** The installations bound to this organization and not suspended, with the account each is on. */
export function boundInstallations(db: Database, orgId: string) {
  return db
    .select({
      installationId: githubAppInstallations.installationId,
      accountLogin: githubAppInstallations.accountLogin,
      accountType: githubAppInstallations.accountType,
    })
    .from(githubAppInstallations)
    .where(and(eq(githubAppInstallations.orgId, orgId), isNull(githubAppInstallations.suspendedAt)))
    .orderBy(githubAppInstallations.createdAt);
}

/**
 * A token of one installation, the first of `permissions` GitHub grants (an installation that lacks one, such as
 * `workflows`, answers 422 and the next set is asked). Null when none was granted or GitHub didn't answer.
 */
async function mint(
  app: GitHubAppConfig,
  http: GitHubHttp,
  installationId: number,
  permissions: AppPermissions[],
  repositories?: string[],
) {
  for (const set of permissions) {
    const res = await http.fetch(`${http.apiUrl}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: { ...appHeaders(app), "content-type": "application/json" },
      body: JSON.stringify({ ...(repositories ? { repositories } : {}), permissions: set }),
    });
    if (!res.ok) continue;
    const body = (await res.json()) as { token?: string; expires_at?: string };
    if (!body.token) continue;
    return { token: body.token, expiresAt: body.expires_at ? Date.parse(body.expires_at) : Date.now() + 3600_000 };
  }
  return null;
}

const list = (permissions: AppPermissions | AppPermissions[]) =>
  Array.isArray(permissions) ? permissions : [permissions];

/** Why the app has no token for a repository here: not installed there for this workspace, GitHub refused every permission set asked, or GitHub didn't answer. */
export type AppTokenMiss = "not_installed" | "refused" | "unreachable";

/**
 * An installation token for one repository (1 hour, cached until 5 minutes before it expires), only when the
 * repository's installation belongs to this organization; else why not (not installed there, installed by someone
 * else, suspended): the caller falls back to the org's own GitHub connection, or says so.
 */
export async function appRepoToken(
  app: GitHubAppConfig,
  http: GitHubHttp,
  tenant: { db: Database; orgId: string },
  owner: string,
  repo: string,
  permissions: AppPermissions | AppPermissions[],
): Promise<{ token: string } | { miss: AppTokenMiss }> {
  const key = `${tenant.orgId}:${owner}/${repo}:${JSON.stringify(permissions)}`;
  const cached = tokens.get(key);
  if (cached && cached.expiresAt - Date.now() > 5 * 60_000) {
    // The binding can go away before the token expires (unbound, suspended).
    if (await boundToOrg(tenant.db, tenant.orgId, cached.installationId)) return { token: cached.token };
    tokens.delete(key);
    return { miss: "not_installed" };
  }
  try {
    // A workspace with nothing installed (most, on every GitHub call) has nothing to ask GitHub.
    if ((await boundInstallations(tenant.db, tenant.orgId)).length === 0) return { miss: "not_installed" };
    const path = `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const inst = await http.fetch(`${http.apiUrl}/repos/${path}/installation`, { headers: appHeaders(app) });
    if (inst.status === 404) return { miss: "not_installed" };
    if (!inst.ok) return { miss: inst.status >= 500 || inst.status === 429 ? "unreachable" : "refused" };
    const { id } = (await inst.json()) as { id?: number };
    if (!id || !(await boundToOrg(tenant.db, tenant.orgId, id))) return { miss: "not_installed" };
    const minted = await mint(app, http, id, list(permissions), [repo]);
    if (!minted) return { miss: "refused" };
    tokens.set(key, { ...minted, installationId: id });
    return { token: minted.token };
  } catch {
    return { miss: "unreachable" };
  }
}

/** `appRepoToken`'s token, or null whatever the reason. */
export async function appTokenForRepo(
  app: GitHubAppConfig,
  http: GitHubHttp,
  tenant: { db: Database; orgId: string },
  owner: string,
  repo: string,
  permissions: AppPermissions | AppPermissions[],
): Promise<string | null> {
  const got = await appRepoToken(app, http, tenant, owner, repo, permissions);
  return "token" in got ? got.token : null;
}

/**
 * A token for a whole installation of this organization (calls that name an account but no repository, listing its
 * repositories or the tools of GitHub through the app alone), cached like a repository's. Null when the installation
 * isn't bound to the org or GitHub granted none of `permissions`.
 */
export async function installationToken(
  app: GitHubAppConfig,
  http: GitHubHttp,
  tenant: { db: Database; orgId: string },
  installationId: number,
  permissions: AppPermissions | AppPermissions[] = { metadata: "read" },
): Promise<string | null> {
  if (!(await boundToOrg(tenant.db, tenant.orgId, installationId))) return null;
  const key = `${tenant.orgId}:#${installationId}:${JSON.stringify(permissions)}`;
  const cached = tokens.get(key);
  if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return cached.token;
  const minted = await mint(app, http, installationId, list(permissions)).catch(() => null);
  if (!minted) return null;
  tokens.set(key, { ...minted, installationId });
  return minted.token;
}

const bots = new Map<string, { login: string; email: string }>();
const botMisses = new Map<string, number>();

/**
 * The app's bot account (`{slug}[bot]`) and the commit email GitHub links to it, asked once per process. Null when
 * GitHub didn't say (asked again a minute later): an address is never guessed.
 */
export async function botIdentity(app: GitHubAppConfig, http: GitHubHttp) {
  if (!app.slug) return null;
  const known = bots.get(app.slug);
  if (known) return known;
  if (Date.now() - (botMisses.get(app.slug) ?? Number.NEGATIVE_INFINITY) < 60_000) return null;
  const login = `${app.slug}[bot]`;
  const res = await http
    .fetch(`${http.apiUrl}/users/${encodeURIComponent(login)}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "agentes.chat" },
    })
    .catch(() => null);
  const body = res?.ok ? ((await res.json().catch(() => null)) as { id?: unknown } | null) : null;
  if (typeof body?.id !== "number") {
    botMisses.set(app.slug, Date.now());
    return null;
  }
  const bot = { login, email: `${body.id}+${login}@users.noreply.github.com` };
  bots.set(app.slug, bot);
  return bot;
}

/**
 * Uninstalls the app from that GitHub account (`DELETE /app/installations/{id}`, signed as the app): `gone` when it
 * already was, `refused` when GitHub said no or didn't answer.
 */
export async function uninstallInstallation(
  app: GitHubAppConfig,
  http: GitHubHttp,
  installationId: number,
): Promise<"uninstalled" | "gone" | "refused"> {
  const res = await http
    .fetch(`${http.apiUrl}/app/installations/${installationId}`, { method: "DELETE", headers: appHeaders(app) })
    .catch(() => null);
  if (res?.status === 204) return "uninstalled";
  return res?.status === 404 ? "gone" : "refused";
}

/**
 * The app as GitHub has it (`GET /app`, signed as the app): its slug, the account that owns it and the events it is
 * subscribed to. Null when GitHub didn't answer.
 */
export async function appRegistration(app: GitHubAppConfig, http: GitHubHttp) {
  const res = await http.fetch(`${http.apiUrl}/app`, { headers: appHeaders(app) }).catch(() => null);
  const body = (res?.ok ? await res.json().catch(() => null) : null) as {
    slug?: unknown;
    events?: unknown;
    owner?: { login?: unknown; type?: unknown } | null;
  } | null;
  if (!body || !Array.isArray(body.events)) return null;
  return {
    slug: typeof body.slug === "string" ? body.slug : (app.slug ?? ""),
    events: body.events.filter((e): e is string => typeof e === "string"),
    owner: typeof body.owner?.login === "string" ? { login: body.owner.login, type: String(body.owner.type) } : null,
  };
}

export interface InstallationFacts {
  accountLogin: string;
  accountType: string;
  repositorySelection: string;
  suspendedAt: Date | null;
}

/** `GET /app/installations/{id}`, signed as the app: its body, `gone` (uninstalled), or null when GitHub didn't answer. */
async function appInstallation(app: GitHubAppConfig, http: GitHubHttp, installationId: number) {
  const res = await http
    .fetch(`${http.apiUrl}/app/installations/${installationId}`, { headers: appHeaders(app) })
    .catch(() => null);
  if (res?.status === 404) return "gone";
  if (!res?.ok) return null;
  return (await res.json().catch(() => null)) as {
    account?: { id?: number; login?: string; type?: string } | null;
    repository_selection?: string;
    suspended_at?: string | null;
    created_at?: string;
  } | null;
}

/** What GitHub says of an installation now: `gone` (uninstalled), its facts, or null when it didn't answer. */
export async function installationStatus(
  app: GitHubAppConfig,
  http: GitHubHttp,
  installationId: number,
): Promise<InstallationFacts | "gone" | null> {
  const body = await appInstallation(app, http, installationId);
  if (body === "gone") return body;
  if (!body?.account?.login) return null;
  return {
    accountLogin: body.account.login,
    accountType: body.account.type ?? "User",
    repositorySelection: body.repository_selection ?? "selected",
    suspendedAt: body.suspended_at ? new Date(body.suspended_at) : null,
  };
}

/**
 * When GitHub made an installation and the id of the account it is on, which binding one checks (ADR 0156): `gone`
 * (uninstalled), or null when GitHub didn't answer or didn't say.
 */
export async function installationOrigin(
  app: GitHubAppConfig,
  http: GitHubHttp,
  installationId: number,
): Promise<{ createdAt: Date; accountId: number } | "gone" | null> {
  const body = await appInstallation(app, http, installationId);
  if (body === "gone") return body;
  const createdAt = new Date(body?.created_at ?? Number.NaN);
  const accountId = body?.account?.id;
  return typeof accountId === "number" && !Number.isNaN(createdAt.getTime()) ? { createdAt, accountId } : null;
}

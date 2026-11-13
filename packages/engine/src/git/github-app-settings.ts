import { createHmac, timingSafeEqual } from "node:crypto";
import type { KeyWrapper } from "@agenteschat/adapters";
import { type Database, type Executor, eq, schema } from "@agenteschat/db";
import { type AuditEntry, auditEveryOrg } from "../audit";
import { deriveSecret, openSecret, sealSecret } from "../crypto";
import { ConflictError, ValidationError } from "../errors";
import {
  appRegistration,
  forgetAllInstallationTokens,
  type GitHubAppConfig,
  type GitHubHttp,
  githubAppCallbackUri,
} from "./github-app";

const { instanceSecrets } = schema;

/**
 * The server's GitHub App (ADR 0156): `GITHUB_APP_*` when set, else the one the server's pinned owner made from
 * Settings with GitHub's manifest flow, kept like the Jev key (ADR 0073): sealed, never returned (only its public
 * slug and page), read again a minute after the last read, so a server that didn't make it sees it too.
 */

/** `invalid`: a saved app that doesn't open on this server (another `AGENTES_SECRET`). */
export interface GitHubAppSetupView {
  source: "env" | "settings" | null;
  slug: string | null;
  htmlUrl: string | null;
  state: "off" | "ok" | "invalid";
}

export interface GitHubAppSettings {
  /** Resolves once the saved app was read, so `current()` is right from the first request. */
  ready(): Promise<void>;
  /** The app for a call now; null: none. Synchronous: a saved app read a minute ago is read again behind the call. */
  current(): GitHubAppConfig | null;
  view(): Promise<GitHubAppSetupView>;
  /** Keeps the app GitHub made from the manifest (`github_app_env` while the env vars are set). */
  save(app: GitHubAppConfig, userId: string): Promise<GitHubAppSetupView>;
  remove(userId: string): Promise<GitHubAppSetupView>;
}

const NAME = "github_app";
const AAD = `instance-secret|${NAME}`;
const REREAD_MS = 60_000;

const envError = () =>
  new ConflictError("The GitHub App is set in this server's settings (GITHUB_APP_ID).", "github_app_env");

/** Deletes the saved app, with a row in each organization's log. Processes drop it at their next read. */
export async function deleteGitHubAppSettings(tx: Executor, actor: AuditEntry["actor"]) {
  const [gone] = await tx
    .delete(instanceSecrets)
    .where(eq(instanceSecrets.name, NAME))
    .returning({ slug: instanceSecrets.keyHint });
  if (gone) await auditEveryOrg(tx, NAME, actor, "github_app.settings_removed", { slug: gone.slug });
}

function parseSaved(json: string): GitHubAppConfig | null {
  const v = JSON.parse(json) as Partial<GitHubAppConfig>;
  return typeof v.appId === "string" && typeof v.privateKey === "string" ? (v as GitHubAppConfig) : null;
}

export function createGitHubAppSettings(deps: {
  db: Database;
  keyWrapper: KeyWrapper;
  keyWrappers: KeyWrapper[];
  /** `githubAppConfig(config)`: wins over a saved app. */
  env: GitHubAppConfig | null;
  now?: () => number;
}): GitHubAppSettings {
  const now = deps.now ?? Date.now;
  const env = deps.env;
  /** The saved row as last read; `app` is null when it doesn't open. */
  let saved: { app: GitHubAppConfig | null; slug: string; at: number } | null = null;
  let readAt = Number.NEGATIVE_INFINITY;
  let reading: Promise<void> | null = null;
  /** Saves and removals made here: a read that began before one of them is older than what it changed. */
  let changes = 0;

  const changed = (next: typeof saved) => {
    forgetAllInstallationTokens();
    saved = next;
    readAt = now();
    changes++;
  };

  async function read() {
    const before = changes;
    const [row] = await deps.db.select().from(instanceSecrets).where(eq(instanceSecrets.name, NAME));
    const at = row ? row.updatedAt.getTime() : null;
    let opened: GitHubAppConfig | null | undefined;
    if (row && saved?.at !== at) {
      opened = await openSecret(deps.keyWrappers, row, AAD)
        .then(parseSaved)
        .catch(() => null);
    }
    if (before !== changes) return;
    readAt = now();
    if (!row || at === null) {
      if (saved) forgetAllInstallationTokens();
      saved = null;
    } else if (opened !== undefined) {
      forgetAllInstallationTokens();
      saved = { app: opened, slug: row.keyHint, at };
    }
  }
  const refresh = () => {
    if (env || now() - readAt < REREAD_MS) return Promise.resolve();
    reading ??= read().finally(() => {
      reading = null;
    });
    return reading;
  };
  const initial = refresh();
  initial.catch(() => {});

  const snapshot = (): GitHubAppSetupView => {
    if (env) return { source: "env", slug: env.slug ?? null, htmlUrl: env.htmlUrl ?? null, state: "ok" };
    if (!saved) return { source: null, slug: null, htmlUrl: null, state: "off" };
    return {
      source: "settings",
      slug: saved.slug,
      htmlUrl: saved.app?.htmlUrl ?? null,
      state: saved.app ? "ok" : "invalid",
    };
  };

  return {
    ready: () => initial,
    current() {
      if (env) return env;
      refresh().catch(() => {});
      return saved?.app ?? null;
    },
    async view() {
      await refresh();
      return snapshot();
    },
    async save(app, userId) {
      if (env) throw envError();
      const values = {
        ...(await sealSecret(deps.keyWrapper, JSON.stringify(app), AAD)),
        keyHint: app.slug ?? app.appId,
        updatedBy: userId,
        updatedAt: new Date(now()),
      };
      await deps.db.transaction(async (tx) => {
        await tx
          .insert(instanceSecrets)
          .values({ name: NAME, ...values })
          .onConflictDoUpdate({ target: instanceSecrets.name, set: values });
        await auditEveryOrg(tx, NAME, { type: "person", id: userId }, "github_app.settings_saved", {
          slug: values.keyHint,
        });
      });
      changed({ app, slug: values.keyHint, at: values.updatedAt.getTime() });
      return snapshot();
    },
    async remove(userId) {
      if (env) throw envError();
      await deps.db.transaction((tx) => deleteGitHubAppSettings(tx, { type: "person", id: userId }));
      changed(null);
      return snapshot();
    },
  };
}

// ── Manifest flow (https://docs.github.com/apps/sharing-github-apps/registering-a-github-app-from-a-manifest) ──

const APP_NAME_MAX = 34;

export const githubAppManifestCallbackUri = (publicUrl: string) =>
  `${publicUrl.replace(/\/$/, "")}/api/app/github-app/manifest/callback`;

/**
 * agentes.chat's own app's permissions (ADR 0156), by GitHub's manifest names (Variables is `actions_variables`).
 * Never Codespaces (agents have their own computers, and Codespaces bill the organization) nor an organization's
 * administration, secrets, variables, runners or webhooks. Each call's token asks only what its tool needs
 * (`github-call.ts`).
 */
const APP_PERMISSIONS = {
  actions: "write",
  administration: "write",
  attestations: "write",
  checks: "write",
  security_events: "write",
  statuses: "write",
  contents: "write",
  repository_custom_properties: "write",
  vulnerability_alerts: "write",
  dependabot_secrets: "write",
  deployments: "write",
  discussions: "write",
  environments: "write",
  issues: "write",
  merge_queues: "write",
  packages: "write",
  pages: "write",
  repository_projects: "write",
  pull_requests: "write",
  repository_advisories: "write",
  secret_scanning_alerts: "write",
  secrets: "write",
  actions_variables: "write",
  repository_hooks: "write",
  workflows: "write",
  metadata: "read",
  members: "read",
  organization_projects: "write",
} as const;

/**
 * What happens on GitHub that agents hear (`github-events.ts`), by GitHub's event names: comments, reviews and new
 * items that name the app, and items being merged or closed. agentes.chat's own app subscribes to the same.
 */
export const GITHUB_APP_EVENTS = [
  "issues",
  "issue_comment",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "pull_request_review_thread",
  "discussion",
  "discussion_comment",
] as const;

/**
 * The events an app lacks (GitHub keeps the events an app was made with: one made from an older manifest, or by hand,
 * has none), and its page on GitHub where they're ticked. Null when it has them all, or GitHub didn't answer.
 */
export async function missingGitHubAppEvents(app: GitHubAppConfig, http: GitHubHttp) {
  const registered = await appRegistration(app, http);
  if (!registered) return null;
  const missing = GITHUB_APP_EVENTS.filter((e) => !registered.events.includes(e));
  if (missing.length === 0) return null;
  const slug = encodeURIComponent(registered.slug);
  const url =
    registered.owner?.type === "Organization"
      ? `https://github.com/organizations/${encodeURIComponent(registered.owner.login)}/settings/apps/${slug}/permissions`
      : `https://github.com/settings/apps/${slug}/permissions`;
  return { missing: [...missing], url };
}

/**
 * The app a server's owner creates on GitHub: the permissions, events and addresses agentes.chat's own app is
 * registered with, at this server's `PUBLIC_URL`. A webhook GitHub can't deliver to (no https) is left off: reading the
 * GitHub panel reconciles installations instead.
 */
export function githubAppManifest(publicUrl: string) {
  const base = publicUrl.replace(/\/$/, "");
  const host = new URL(base).host;
  const room = APP_NAME_MAX - "agentes.chat ()".length;
  return {
    name: `agentes.chat (${host.slice(0, room)})`,
    url: base,
    redirect_url: githubAppManifestCallbackUri(base),
    callback_urls: [githubAppCallbackUri(base)],
    request_oauth_on_install: true,
    setup_on_update: true,
    public: true,
    hook_attributes: { url: `${base}/api/github-app/webhook`, active: base.startsWith("https://") },
    default_permissions: APP_PERMISSIONS,
    default_events: [...GITHUB_APP_EVENTS],
  };
}

/** GitHub's manifest code lasts an hour: so does the state that comes back with it. */
const MANIFEST_STATE_SECONDS = 3600;

const manifestMac = (secret: string, body: string) =>
  createHmac("sha256", Buffer.from(deriveSecret(secret, "github-app-manifest"), "hex"))
    .update(body)
    .digest();

/**
 * The manifest flow's `state`: who started it and where they land, signed (HMAC of `AGENTES_SECRET`), one hour. The
 * callback needs the same person's session: a leaked state with someone else's code can't plant their app here.
 */
export function issueManifestState(secret: string, claims: { userId: string; returnTo: string }, now = Date.now()) {
  const body = Buffer.from(
    JSON.stringify({ u: claims.userId, r: claims.returnTo, e: Math.floor(now / 1000) + MANIFEST_STATE_SECONDS }),
  ).toString("base64url");
  return `${body}.${manifestMac(secret, body).toString("base64url")}`;
}

/** The claims of a valid, unexpired state; null otherwise. */
export function readManifestState(secret: string, state: string, now = Date.now()) {
  const [body = "", mac = "", ...rest] = state.split(".");
  const given = Buffer.from(mac, "base64url");
  const expected = manifestMac(secret, body);
  if (rest.length > 0 || given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const c = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { u?: unknown; r?: unknown; e?: unknown };
    if (typeof c.u !== "string" || typeof c.r !== "string" || typeof c.e !== "number") return null;
    return c.e * 1000 > now ? { userId: c.u, returnTo: c.r } : null;
  } catch {
    return null;
  }
}

/** GitHub's app for a manifest code (`POST /app-manifests/{code}/conversions`): its id, keys and secrets. */
export async function convertGitHubAppManifest(http: GitHubHttp, code: string): Promise<GitHubAppConfig> {
  const res = await http
    .fetch(`${http.apiUrl}/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: "POST",
      headers: { accept: "application/vnd.github+json", "user-agent": "agentes.chat" },
    })
    .catch(() => null);
  const body = (res?.ok ? await res.json().catch(() => null) : null) as {
    id?: unknown;
    slug?: unknown;
    client_id?: unknown;
    client_secret?: unknown;
    webhook_secret?: unknown;
    pem?: unknown;
    html_url?: unknown;
  } | null;
  const text = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  if (!body || typeof body.id !== "number" || !text(body.pem) || !text(body.slug)) {
    throw new ValidationError(
      `GitHub didn't create the app (${res ? res.status : "no answer"})`,
      "github_app.manifest_failed",
    );
  }
  return {
    appId: String(body.id),
    privateKey: text(body.pem) as string,
    slug: text(body.slug),
    clientId: text(body.client_id),
    clientSecret: text(body.client_secret),
    webhookSecret: text(body.webhook_secret),
    htmlUrl: text(body.html_url),
  };
}

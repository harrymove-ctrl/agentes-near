import { createHmac, timingSafeEqual } from "node:crypto";
import type { KeyWrapper } from "@agenteschat/adapters";
import { and, type Database, desc, eq, isNull, schema } from "@agenteschat/db";
import { recordAudit } from "./audit";
import { activeConnections, type ConnectorDeps } from "./connectors/connections";
import { openSecret, randomToken, sealSecret } from "./crypto";
import { NotFoundError, ValidationError } from "./errors";
import { connectionToken } from "./git/branches";
import { appTokenForRepo, boundInstallations, type GitHubAppConfig, type GitHubHttp } from "./git/github-app";
import { parseRepo } from "./git/repos";
import { can, requirePermission } from "./organizations";
import { fireRoutineEvent, type RoutineEvent } from "./routines";

const { webhookEndpoints } = schema;

export type WebhookProvider = "github" | "sentry";
export const WEBHOOK_PROVIDERS: readonly WebhookProvider[] = ["github", "sentry"];

export interface WebhookDeps {
  db: Database;
  keyWrappers: KeyWrapper[];
  /** Adding the webhook to a GitHub repository from the app: our GitHub App's token, else the GitHub connection's. */
  github?: { app: GitHubAppConfig | null; http: GitHubHttp; connectors: ConnectorDeps };
}

/** The GitHub events routines listen to (`webhookEvent`): what a repository's webhook must send. */
export const GITHUB_HOOK_EVENTS = ["pull_request", "deployment_status"] as const;

const aadFor = (orgId: string, id: string) => `webhook|${orgId}|${id}`;

/** A webhook whose signature doesn't match (401). */
export class ForbiddenSignatureError extends Error {
  constructor() {
    super("Invalid signature");
    this.name = "ForbiddenSignatureError";
  }
}

/**
 * A new incoming webhook for the org (admins). The secret is shown once, to
 * paste into GitHub or Sentry; we keep it sealed to check signatures.
 */
export async function createWebhookEndpoint(
  deps: WebhookDeps,
  actorId: string,
  orgId: string,
  provider: WebhookProvider,
  publicUrl: string,
) {
  await requirePermission(deps.db, actorId, orgId, "manage_connectors");
  if (!WEBHOOK_PROVIDERS.includes(provider)) throw new ValidationError("Unknown provider");
  const wrapper = deps.keyWrappers[0];
  if (!wrapper) throw new Error("no key wrapper");
  const id = crypto.randomUUID();
  const secret = randomToken(32);
  const sealed = await sealSecret(wrapper, secret, aadFor(orgId, id));
  await deps.db.insert(webhookEndpoints).values({
    id,
    orgId,
    provider,
    secretCiphertext: sealed.ciphertext,
    wrappedDataKey: sealed.wrappedDataKey,
    kekId: sealed.kekId,
    createdByUserId: actorId,
  });
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "webhook.created",
    target: { type: "webhook_endpoint", id },
    details: { provider },
  });
  return { id, provider, url: webhookUrl(publicUrl, provider, id), secret };
}

const webhookUrl = (publicUrl: string, provider: string, id: string) =>
  `${publicUrl.replace(/\/$/, "")}/api/webhooks/${provider}/${id}`;

/** What the routine form shows of a service's webhook: whether it works, and for who sets it up, where and with what. */
export interface WebhookSetup {
  provider: WebhookProvider;
  /** None made yet. */
  id: string | null;
  /** Only for who sets webhooks up (`manage_connectors`). */
  url: string | null;
  /** GitHub's secret, to paste there (who sets webhooks up). Sentry's is its own, never shown. */
  secret: string | null;
  /** The last call with a valid signature: it works. */
  receivedAt: string | null;
  /** The last call whose signature didn't match (a different secret where it was set up). */
  refusedAt: string | null;
  /** Sentry: its integration's Client Secret was pasted here. */
  secretSet: boolean;
  canManage: boolean;
  /** GitHub: a token of the workspace (our app, or its GitHub connection) may add the webhook to a repository. */
  oneClick: boolean;
}

/** The webhook of a service people set up now: the newest one still live. */
async function liveEndpoint(db: Database, orgId: string, provider: WebhookProvider) {
  const [row] = await db
    .select()
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.orgId, orgId),
        eq(webhookEndpoints.provider, provider),
        isNull(webhookEndpoints.revokedAt),
      ),
    )
    .orderBy(desc(webhookEndpoints.createdAt))
    .limit(1);
  return row ?? null;
}

const providerOf = (provider: unknown): WebhookProvider => {
  if (!WEBHOOK_PROVIDERS.includes(provider as WebhookProvider)) throw new ValidationError("Unknown provider");
  return provider as WebhookProvider;
};

/** A service's webhook for this workspace as the routine form shows it; its address and secret only to who sets it up. */
export async function webhookSetup(
  deps: WebhookDeps,
  actorId: string,
  orgId: string,
  provider: WebhookProvider,
  publicUrl: string,
): Promise<WebhookSetup> {
  const membership = await requirePermission(deps.db, actorId, orgId, "read");
  const canManage = can(membership, "manage_connectors");
  const row = await liveEndpoint(deps.db, orgId, providerOf(provider));
  const secret =
    row && canManage && provider === "github"
      ? await openSecret(
          deps.keyWrappers,
          { ciphertext: row.secretCiphertext, wrappedDataKey: row.wrappedDataKey, kekId: row.kekId },
          aadFor(orgId, row.id),
        )
      : null;
  return {
    provider,
    id: row?.id ?? null,
    url: row && canManage ? webhookUrl(publicUrl, provider, row.id) : null,
    secret,
    receivedAt: row?.lastDeliveryAt?.toISOString() ?? null,
    refusedAt: row?.lastRefusedAt?.toISOString() ?? null,
    secretSet: Boolean(row?.secretSetAt),
    canManage,
    oneClick: canManage && provider === "github" && (await githubReaches(deps, orgId)),
  };
}

async function githubReaches(deps: WebhookDeps, orgId: string) {
  if (!deps.github) return false;
  if ((await activeConnections(deps.db, orgId)).some((c) => c.connector === "github")) return true;
  return Boolean(deps.github.app) && (await boundInstallations(deps.db, orgId)).length > 0;
}

/** The service's webhook, made when the workspace has none live (who sets webhooks up). */
export async function ensureWebhookEndpoint(
  deps: WebhookDeps,
  actorId: string,
  orgId: string,
  provider: WebhookProvider,
  publicUrl: string,
): Promise<WebhookSetup> {
  await requirePermission(deps.db, actorId, orgId, "manage_connectors");
  if (!(await liveEndpoint(deps.db, orgId, providerOf(provider)))) {
    await createWebhookEndpoint(deps, actorId, orgId, provider, publicUrl);
  }
  return webhookSetup(deps, actorId, orgId, provider, publicUrl);
}

/**
 * The secret the service signs with, pasted from it: Sentry signs with its integration's Client Secret, never one we
 * choose. Its last refusal is forgotten: the next call says whether it matches.
 */
export async function setWebhookSecret(
  deps: WebhookDeps,
  actorId: string,
  orgId: string,
  provider: WebhookProvider,
  secret: string,
  publicUrl: string,
): Promise<WebhookSetup> {
  const value = typeof secret === "string" ? secret.trim() : "";
  if (!/^[\x21-\x7e]{8,200}$/.test(value)) {
    throw new ValidationError("Paste the whole secret: 8 to 200 characters, no spaces", "webhook.invalid_secret");
  }
  await ensureWebhookEndpoint(deps, actorId, orgId, provider, publicUrl);
  const row = await liveEndpoint(deps.db, orgId, provider);
  const wrapper = deps.keyWrappers[0];
  if (!row || !wrapper) throw new NotFoundError("Webhook not found");
  const sealed = await sealSecret(wrapper, value, aadFor(orgId, row.id));
  await deps.db
    .update(webhookEndpoints)
    .set({
      secretCiphertext: sealed.ciphertext,
      wrappedDataKey: sealed.wrappedDataKey,
      kekId: sealed.kekId,
      secretSetAt: new Date(),
      lastRefusedAt: null,
    })
    .where(eq(webhookEndpoints.id, row.id));
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "webhook.secret_set",
    target: { type: "webhook_endpoint", id: row.id },
    details: { provider },
  });
  return webhookSetup(deps, actorId, orgId, provider, publicUrl);
}

/**
 * Adds the workspace's GitHub webhook to a repository (or brings the one already there up to date): with our GitHub
 * App's token when its installation may manage the repository's webhooks, else with the GitHub connection's. GitHub
 * pings it at once, which `handleWebhook` counts as its first delivery. Refused with `webhook.github_no_access` when
 * no token may, so the form keeps the steps to do it by hand.
 */
export async function addGitHubRepoHook(
  deps: WebhookDeps,
  actorId: string,
  orgId: string,
  repository: string,
  publicUrl: string,
): Promise<WebhookSetup> {
  const repo = parseRepo(repository);
  if (!repo) throw new ValidationError("Name the repository as owner/name", "webhook.invalid_repo");
  const setup = await ensureWebhookEndpoint(deps, actorId, orgId, "github", publicUrl);
  const github = deps.github;
  if (!github || !setup.url || !setup.secret) throw noAccess(repository);
  const tokens: (() => Promise<string | null>)[] = [
    async () =>
      github.app
        ? appTokenForRepo(github.app, github.http, { db: deps.db, orgId }, repo.owner, repo.repo, {
            repository_hooks: "write",
          }).catch(() => null)
        : null,
    async () => {
      const connection = (await activeConnections(deps.db, orgId)).find((c) => c.connector === "github");
      return connection ? connectionToken(github.connectors, connection).catch(() => null) : null;
    },
  ];
  const config = { url: setup.url, content_type: "json", secret: setup.secret, insecure_ssl: "0" };
  const body = { active: true, events: [...GITHUB_HOOK_EVENTS], config };
  let failed: number | null = null;
  for (const next of tokens) {
    const token = await next();
    if (!token) continue;
    const call = (path: string, init: { method?: string; body?: unknown } = {}) =>
      github.http.fetch(`${github.http.apiUrl}/repos/${repo.owner}/${repo.repo}/hooks${path}`, {
        method: init.method ?? "GET",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "content-type": "application/json",
          "user-agent": "agentes.chat",
        },
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      });
    const listed = await call("?per_page=100");
    if (listed.status === 403 || listed.status === 404) continue;
    const hooks = listed.ok
      ? ((await listed.json().catch(() => [])) as { id?: number; config?: { url?: string } }[])
      : [];
    const same = Array.isArray(hooks)
      ? hooks.find((h) => h.config?.url === setup.url && typeof h.id === "number")
      : null;
    const done = same
      ? await call(`/${same.id}`, { method: "PATCH", body })
      : await call("", { method: "POST", body: { name: "web", ...body } });
    if (done.ok) {
      await recordAudit(deps.db, {
        orgId,
        actor: { type: "person", id: actorId },
        action: "webhook.github_repository",
        target: { type: "webhook_endpoint", id: setup.id ?? "" },
        details: { repository: `${repo.owner}/${repo.repo}`, updated: Boolean(same) },
      });
      return webhookSetup(deps, actorId, orgId, "github", publicUrl);
    }
    if (done.status !== 403 && done.status !== 404) failed = done.status;
  }
  if (failed !== null) {
    throw new ValidationError(`GitHub refused the webhook (${failed})`, "webhook.github_failed", {
      repo: repository,
      status: String(failed),
    });
  }
  throw noAccess(repository);
}

const noAccess = (repo: string) =>
  new ValidationError(
    "No GitHub access of this workspace may add webhooks to that repository",
    "webhook.github_no_access",
    { repo },
  );

/** GitHub's form content type wraps the JSON in a `payload` field: the same event either way. */
function jsonOf(rawBody: string, headers: Headers) {
  if (!headers.get("content-type")?.includes("application/x-www-form-urlencoded")) return rawBody;
  return new URLSearchParams(rawBody).get("payload") ?? "";
}

function validSignature(secret: string, body: string, given: string | null, prefix: string) {
  if (!given) return false;
  const expected = `${prefix}${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(given.trim());
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * What happened, in our event names, with a one-line summary and its identity (`dedupeKey`: GitHub's
 * delivery id, Sentry's issue id and action), so a redelivered webhook never fires a routine twice.
 * Null = not something routines listen to.
 */
export function webhookEvent(
  provider: WebhookProvider,
  headers: Headers,
  payload: Record<string, unknown>,
): { event: RoutineEvent; summary: string; data: Record<string, unknown>; dedupeKey: string | null } | null {
  const get = (o: unknown, ...path: string[]): unknown =>
    path.reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), o);
  if (provider === "github") {
    const kind = headers.get("x-github-event");
    const delivery = headers.get("x-github-delivery")?.trim();
    const dedupeKey = delivery ? `github:${delivery.slice(0, 100)}` : null;
    const repo = String(get(payload, "repository", "full_name") ?? "");
    if (kind === "pull_request" && payload.action === "opened") {
      const number = Number(get(payload, "pull_request", "number"));
      const title = String(get(payload, "pull_request", "title") ?? "");
      const url = String(get(payload, "pull_request", "html_url") ?? "");
      return {
        event: "github.pr_opened",
        summary: `PR #${number} opened in ${repo}: ${title}`,
        data: { repo, number, url },
        dedupeKey,
      };
    }
    if (kind === "deployment_status" && get(payload, "deployment_status", "state") === "success") {
      const environment = String(get(payload, "deployment", "environment") ?? "");
      return {
        event: "deploy.succeeded",
        summary: `Deploy to ${environment} finished (${repo})`,
        data: { repo, environment },
        dedupeKey,
      };
    }
    return null;
  }
  const resource = headers.get("sentry-hook-resource");
  if (resource === "issue" && payload.action === "created") {
    const issueId = String(get(payload, "data", "issue", "id") ?? "").slice(0, 100);
    const title = String(get(payload, "data", "issue", "title") ?? "");
    const url = String(get(payload, "data", "issue", "web_url") ?? get(payload, "data", "issue", "permalink") ?? "");
    return {
      event: "sentry.issue_created",
      summary: `New Sentry error: ${title}`,
      data: { title, url, ...(issueId ? { issueId } : {}) },
      dedupeKey: issueId ? `sentry:${issueId}:${String(payload.action)}` : null,
    };
  }
  return null;
}

/**
 * An incoming webhook: the signature must match the endpoint's secret
 * (GitHub `X-Hub-Signature-256: sha256=…`, Sentry `Sentry-Hook-Signature`);
 * then routines listening to the event run.
 */
export async function handleWebhook(
  deps: WebhookDeps,
  provider: WebhookProvider,
  endpointId: string,
  headers: Headers,
  rawBody: string,
): Promise<{ fired: number; event: RoutineEvent | null }> {
  const [endpoint] = await deps.db
    .select()
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.id, endpointId),
        eq(webhookEndpoints.provider, provider),
        isNull(webhookEndpoints.revokedAt),
      ),
    );
  if (!endpoint) throw new NotFoundError("Webhook not found");
  const secret = await openSecret(
    deps.keyWrappers,
    { ciphertext: endpoint.secretCiphertext, wrappedDataKey: endpoint.wrappedDataKey, kekId: endpoint.kekId },
    aadFor(endpoint.orgId, endpoint.id),
  );
  const ok =
    provider === "github"
      ? validSignature(secret, rawBody, headers.get("x-hub-signature-256"), "sha256=")
      : validSignature(secret, rawBody, headers.get("sentry-hook-signature"), "");
  await deps.db
    .update(webhookEndpoints)
    .set(ok ? { lastDeliveryAt: new Date() } : { lastRefusedAt: new Date() })
    .where(eq(webhookEndpoints.id, endpoint.id));
  if (!ok) throw new ForbiddenSignatureError();
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(jsonOf(rawBody, headers)) as Record<string, unknown>;
  } catch {
    throw new ValidationError("The body is not JSON");
  }
  const what = webhookEvent(provider, headers, payload);
  if (!what) return { fired: 0, event: null };
  const fired = await fireRoutineEvent(
    deps,
    endpoint.orgId,
    what.event,
    { summary: what.summary, ...what.data },
    { dedupeKey: what.dedupeKey },
  );
  return { fired, event: what.event };
}

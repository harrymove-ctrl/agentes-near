import { createHash } from "node:crypto";
import { and, type Database, type Executor, eq, gt, inArray, isNull, ne, schema } from "@agenteschat/db";
import { recordAudit } from "../audit";
import { sha256 } from "../crypto";
import { emailLocale, modeStamp, queueEmail } from "../email";
import { ConflictError, ForbiddenError, NotFoundError } from "../errors";
import { getMembership, listMemberships } from "../organizations";
import { accountClosed, workRefusal } from "../standing";
import {
  type AppIdentity,
  appIdentity,
  type FetchAppDocument,
  fetchAppDocument,
  redirectUriMatches,
  resolveApp,
  touchApp,
} from "./clients";
import { revokeAppGrants, revokeGrantTokens, revokeMemberApps } from "./revoke";
import {
  ACCESS_TOKEN_PREFIX,
  APP_LIMITS,
  type AppAccess,
  type AppScope,
  appScopesFor,
  appsUrls,
  normalizeResource,
  parseScopes,
  REFRESH_TOKEN_PREFIX,
  randomBase62,
} from "./urls";

const { oauthAppRequests, oauthAppClients, appGrants, appTokens, users } = schema;

/**
 * This server's own OAuth 2.1 authorization server for AI apps (ADR 0119 §1): authorization code with PKCE (S256
 * only), public clients, opaque tokens stored only as sha256, refresh rotation with reuse detection. Ported from
 * Dinzo's authorization server and checked against the edge cases MillionSend and Real Oficial met in production.
 */

export interface OauthDeps {
  db: Database;
  publicUrl: string;
  fetchDocument?: FetchAppDocument;
  /** Whether this grant may refresh again now (60 an hour); absent = always. */
  admitRefresh?: (grantId: string) => Promise<boolean>;
}

const withQuery = (base: string, params: Record<string, string | undefined | null>) => {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
  return url.toString();
};

/** The consent page with an error code it explains (`app_desconhecido`, `endereco_de_retorno`, `pedido_invalido`, `indisponivel`). */
const consentError = (publicUrl: string, code: string) => `${appsUrls(publicUrl).consentPage}?erro=${code}`;

/**
 * `GET /api/oauth/authorize`: where the browser goes next. Errors stay on our own consent page, echoing nothing the
 * request carries, until the app has been issued a token once: anyone can register any https return address (or
 * host a metadata document), so sending a new app's parameter errors straight back would bounce a link through
 * this domain to any address, with no page seen (RFC 9700 §4.11.2). An app that has connected before gets them
 * back with `state` and `iss` (RFC 9207).
 */
export async function startAuthorization(deps: OauthDeps, query: Record<string, string | undefined>): Promise<string> {
  const { db, publicUrl } = deps;
  const urls = appsUrls(publicUrl);
  const clientId = query.client_id ?? "";
  const redirectUri = query.redirect_uri ?? "";
  const client = await resolveApp(db, clientId, deps.fetchDocument ?? fetchAppDocument);
  if (client === "busy") return consentError(publicUrl, "indisponivel");
  if (!client) return consentError(publicUrl, "app_desconhecido");
  if (!redirectUri || !redirectUriMatches(client.redirectUris, redirectUri))
    return consentError(publicUrl, "endereco_de_retorno");
  const state = query.state;
  const fail = (error: string, description?: string) =>
    client.lastUsedAt
      ? withQuery(redirectUri, { error, error_description: description, state, iss: urls.issuer })
      : consentError(publicUrl, "pedido_invalido");
  if (query.response_type !== "code") return fail("unsupported_response_type");
  if (query.code_challenge_method !== "S256") return fail("invalid_request", "code_challenge_method must be S256");
  const challenge = query.code_challenge ?? "";
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) return fail("invalid_request", "code_challenge (S256) is required");
  if (state && state.length > APP_LIMITS.stateChars) return fail("invalid_request", "state is too long");
  if (query.resource !== undefined && normalizeResource(query.resource) !== normalizeResource(urls.resource))
    return fail("invalid_target", "unknown resource");
  try {
    const [row] = await db
      .insert(oauthAppRequests)
      .values({
        clientId: client.id,
        redirectUri,
        state: state ?? null,
        codeChallenge: challenge,
        scopes: parseScopes(query.scope),
        resource: query.resource ? urls.resource : null,
        expiresAt: new Date(Date.now() + APP_LIMITS.requestMs),
      })
      .returning({ id: oauthAppRequests.id });
    if (!row) throw new Error("request not stored");
    return `${urls.consentPage}?req=${row.id}`;
  } catch {
    return consentError(publicUrl, "indisponivel");
  }
}

/** A pending authorization the person may still decide, or why not. */
async function pendingRequest(db: Executor, requestId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw new NotFoundError("Unknown request", "request_unknown");
  const [row] = await db
    .select({ request: oauthAppRequests, client: oauthAppClients })
    .from(oauthAppRequests)
    .innerJoin(oauthAppClients, eq(oauthAppClients.id, oauthAppRequests.clientId))
    .where(eq(oauthAppRequests.id, requestId));
  if (!row) throw new NotFoundError("Unknown request", "request_unknown");
  if (row.request.decidedAt) throw new ConflictError("This request was already used", "request_used");
  if (row.request.expiresAt.getTime() <= Date.now()) throw new ConflictError("This request expired", "request_expired");
  return row;
}

export interface ConsentView {
  request: { id: string; expiresAt: string; access: { requested: AppScope[] }; client: Omit<AppIdentity, "cursor"> };
  account: { name: string; email: string };
  workspaces: {
    id: string;
    name: string;
    logo: string | null;
    paused: boolean;
    current: boolean;
    createdAt?: string;
    deletion?: { dueAt: string };
  }[];
}

/** What the consent page shows (`GET /api/app/authorize/{req}`). */
export async function consentView(deps: OauthDeps, userId: string, requestId: string): Promise<ConsentView> {
  const { request, client } = await pendingRequest(deps.db, requestId);
  const [account] = await deps.db
    .select({ name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, userId));
  if (!account) throw new ForbiddenError("Sign in to continue");
  const { cursor: _cursor, ...identity } = appIdentity(client, request.redirectUri, new URL(deps.publicUrl).hostname);
  const memberships = await listMemberships(deps.db, userId);
  return {
    request: {
      id: request.id,
      expiresAt: request.expiresAt.toISOString(),
      access: { requested: request.scopes as AppScope[] },
      client: identity,
    },
    account,
    workspaces: memberships.map((m, i) => ({
      id: m.orgId,
      name: m.orgName,
      logo: m.orgLogo ?? null,
      paused: !!workRefusal(m.standing),
      current: i === 0,
      createdAt: m.orgCreatedAt?.toISOString(),
      ...(m.standing?.deletionDueAt ? { deletion: { dueAt: m.standing.deletionDueAt.toISOString() } } : {}),
    })),
  };
}

const codeOrTokenHash = (value: string) => sha256(value);

/**
 * The person's answer (`POST /api/app/authorize/{req}`): the address the browser goes to, back in the app. Allow
 * binds the connection to the workspace picked here (checked again on the server), with the access picked here.
 * A request answers once: a second answer (the Back button, a link scanner) is refused and revokes nothing.
 */
export async function decideConsent(
  deps: OauthDeps,
  userId: string,
  requestId: string,
  input: { decision: "allow" | "deny"; orgId?: string; access?: AppAccess },
): Promise<{ redirectTo: string; grantId?: string; created?: boolean }> {
  const { db, publicUrl } = deps;
  const { issuer } = appsUrls(publicUrl);
  const { request, client } = await pendingRequest(db, requestId);
  const back = (params: Record<string, string>) =>
    withQuery(request.redirectUri, { ...params, state: request.state, iss: issuer });
  if (input.decision === "deny") {
    const [used] = await db
      .update(oauthAppRequests)
      .set({ decidedAt: new Date(), userId })
      .where(and(eq(oauthAppRequests.id, requestId), isNull(oauthAppRequests.decidedAt)))
      .returning({ id: oauthAppRequests.id });
    if (!used) throw new ConflictError("This request was already used", "request_used");
    return { redirectTo: back({ error: "access_denied" }) };
  }
  if (!input.orgId) throw new ForbiddenError("Pick a workspace", "not_member");
  const membership = await getMembership(db, userId, input.orgId);
  if (!membership) throw new ForbiddenError("You are not a member of this workspace", "not_member");
  if (workRefusal(membership.standing)) throw new ConflictError("This workspace is paused", "workspace_paused");
  const allowed = appScopesFor(input.access ?? "write");
  const scopes = (request.scopes as AppScope[]).filter((s) => allowed.includes(s));
  const identity = appIdentity(client, request.redirectUri, new URL(publicUrl).hostname);
  const code = randomBase62(43);
  const result = await db.transaction(async (tx) => {
    const [used] = await tx
      .update(oauthAppRequests)
      .set({
        decidedAt: new Date(),
        userId,
        orgId: input.orgId,
        scopes,
        codeHash: codeOrTokenHash(code),
        codeExpiresAt: new Date(Date.now() + APP_LIMITS.codeMs),
      })
      .where(and(eq(oauthAppRequests.id, requestId), isNull(oauthAppRequests.decidedAt)))
      .returning({ id: oauthAppRequests.id });
    if (!used) throw new ConflictError("This request was already used", "request_used");
    const [before] = await tx
      .select({ id: appGrants.id, revokedAt: appGrants.revokedAt, scopes: appGrants.scopes })
      .from(appGrants)
      .where(
        and(
          eq(appGrants.userId, userId),
          eq(appGrants.orgId, input.orgId as string),
          eq(appGrants.clientId, client.id),
          eq(appGrants.kind, "oauth"),
        ),
      );
    const display = {
      displayKind: identity.displayKind,
      displayName: identity.name,
      displayHost: identity.host,
      brand: identity.brand,
      // What the app's connections may do at most, for the list: each connection keeps the access it was given.
      scopes: before && !before.revokedAt ? [...new Set([...before.scopes, ...scopes])] : scopes,
      consentedAt: new Date(),
      revokedAt: null,
      revokedBy: null,
    };
    const [grant] = before
      ? await tx.update(appGrants).set(display).where(eq(appGrants.id, before.id)).returning()
      : await tx
          .insert(appGrants)
          .values({ orgId: input.orgId as string, userId, kind: "oauth", clientId: client.id, ...display })
          .returning();
    if (!grant) throw new Error("grant not stored");
    const created = !before || before.revokedAt !== null;
    // Connected again: whatever the old connection minted stays dead.
    if (before?.revokedAt) await revokeGrantTokens(tx, [before.id]);
    // A live connection given more than it had (read, now write) is a new access too: audited and emailed.
    const widened = !created && grant.scopes.length > (before?.scopes.length ?? 0);
    if (created || widened) {
      await recordAudit(tx, {
        orgId: grant.orgId,
        actor: { type: "person", id: userId },
        action: created ? "apps.connected" : "apps.scopes_changed",
        target: { type: "app_grant", id: grant.id },
        details: { app: grant.displayName, kind: grant.displayKind, host: grant.displayHost, scopes: grant.scopes },
      });
      await queueReceipt(
        tx,
        publicUrl,
        userId,
        grant.orgId,
        membership.orgName,
        grant.displayName,
        `app-connected:${grant.id}:${Date.now()}`,
      );
    }
    return { grantId: grant.id, created };
  });
  return { redirectTo: back({ code }), ...result };
}

/** "App conectado" to the person, through the email job (a server that sends no email skips it there). */
export async function queueReceipt(
  tx: Executor,
  publicUrl: string,
  userId: string,
  orgId: string,
  orgName: string,
  appName: string,
  key: string,
) {
  const [person] = await tx
    .select({ email: users.email, locale: users.locale })
    .from(users)
    .where(eq(users.id, userId));
  if (!person) return;
  await queueEmail(tx, {
    orgId,
    key,
    to: [person.email],
    template: {
      kind: "app_connected",
      locale: emailLocale(person.locale),
      appName,
      orgName,
      url: `${appsUrls(publicUrl).issuer}/org/${orgId}/settings/apps`,
      ...(await modeStamp(tx, orgId)),
    },
  });
}

// ── Tokens ────────────────────────────────────────────────────────────────────

export type TokenResult =
  | {
      ok: true;
      body: { access_token: string; token_type: "Bearer"; expires_in: number; refresh_token: string; scope: string };
    }
  | { ok: false; status: 400 | 401 | 429; error: string; description?: string; grantId?: string };

const tokenError = (error: string, description?: string, status: 400 | 401 = 400): TokenResult => ({
  ok: false,
  status,
  error,
  description,
});

/**
 * A new access + refresh pair in a family (a new family when none is given), with the family's own access and
 * access-token lifetime: the grant is shared by every connection of one app, these are each connection's.
 */
async function mintPair(
  tx: Executor,
  grant: { id: string; orgId: string },
  options: {
    familyId?: string;
    parentId?: string | null;
    requestId?: string | null;
    accessMs: number;
    scopes: string[];
  },
) {
  const access = `${ACCESS_TOKEN_PREFIX}${randomBase62(43)}`;
  const refresh = `${REFRESH_TOKEN_PREFIX}${randomBase62(43)}`;
  const familyId = options.familyId ?? Bun.randomUUIDv7();
  const now = Date.now();
  const family = { scopes: options.scopes, accessSeconds: Math.round(options.accessMs / 1000) };
  await tx.insert(appTokens).values([
    {
      orgId: grant.orgId,
      grantId: grant.id,
      kind: "access",
      tokenHash: codeOrTokenHash(access),
      familyId,
      parentId: options.parentId ?? null,
      requestId: options.requestId ?? null,
      ...family,
      expiresAt: new Date(now + options.accessMs),
    },
    {
      orgId: grant.orgId,
      grantId: grant.id,
      kind: "refresh",
      tokenHash: codeOrTokenHash(refresh),
      familyId,
      parentId: options.parentId ?? null,
      requestId: options.requestId ?? null,
      ...family,
      expiresAt: new Date(now + APP_LIMITS.refreshMs),
    },
  ]);
  return {
    access_token: access,
    token_type: "Bearer" as const,
    expires_in: Math.round(options.accessMs / 1000),
    refresh_token: refresh,
    scope: options.scopes.join(" "),
  };
}

const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

/** Revokes every token of a family (a stolen or replayed refresh token, a replayed code). */
async function revokeFamily(db: Executor, familyIds: string[]) {
  if (familyIds.length === 0) return;
  await db
    .update(appTokens)
    .set({ revokedAt: new Date() })
    .where(and(inArray(appTokens.familyId, familyIds), isNull(appTokens.revokedAt)));
}

/**
 * The grant behind a token can still be used: not revoked, its person still in its workspace. Null: not now, and
 * nothing ends: its account is blocked or waits for its deletion, and comes back with its apps.
 */
async function grantUsable(db: Database, grant: schema.AppGrant) {
  if (grant.revokedAt) return false;
  const membership = await getMembership(db, grant.userId, grant.orgId);
  if (membership) return true;
  if (await accountClosed(db, grant.userId)) return null;
  await db.transaction((tx) => revokeMemberApps(tx, grant.orgId, grant.userId));
  return false;
}

/** `grant_type=authorization_code`. */
export async function exchangeCode(deps: OauthDeps, form: Record<string, string | undefined>): Promise<TokenResult> {
  const { db, publicUrl } = deps;
  const code = form.code ?? "";
  if (!code || !form.code_verifier || !form.client_id)
    return tokenError("invalid_request", "code, code_verifier and client_id are required");
  const hash = codeOrTokenHash(code);
  const [request] = await db
    .update(oauthAppRequests)
    .set({ codeUsedAt: new Date() })
    .where(
      and(
        eq(oauthAppRequests.codeHash, hash),
        isNull(oauthAppRequests.codeUsedAt),
        gt(oauthAppRequests.codeExpiresAt, new Date()),
      ),
    )
    .returning();
  if (!request) {
    // A code used twice: whoever holds it may be replaying a stolen one, so what it minted goes too.
    const [used] = await db
      .select({ id: oauthAppRequests.id, usedAt: oauthAppRequests.codeUsedAt })
      .from(oauthAppRequests)
      .where(eq(oauthAppRequests.codeHash, hash));
    if (used?.usedAt) {
      const families = await db
        .selectDistinct({ familyId: appTokens.familyId })
        .from(appTokens)
        .where(eq(appTokens.requestId, used.id));
      await revokeFamily(
        db,
        families.map((f) => f.familyId),
      );
    }
    return tokenError("invalid_grant", "The code is invalid, used or expired");
  }
  if (request.clientId !== form.client_id) return tokenError("invalid_grant", "The code was issued to another client");
  if (s256(form.code_verifier) !== request.codeChallenge)
    return tokenError("invalid_grant", "PKCE verification failed");
  if (form.redirect_uri !== undefined && form.redirect_uri !== request.redirectUri)
    return tokenError("invalid_grant", "redirect_uri does not match");
  if (
    form.resource !== undefined &&
    normalizeResource(form.resource) !== normalizeResource(appsUrls(publicUrl).resource)
  )
    return tokenError("invalid_target", "unknown resource");
  if (!request.orgId || !request.userId) return tokenError("invalid_grant");
  const [grant] = await db
    .select()
    .from(appGrants)
    .where(
      and(
        eq(appGrants.userId, request.userId),
        eq(appGrants.orgId, request.orgId),
        eq(appGrants.clientId, request.clientId),
        eq(appGrants.kind, "oauth"),
      ),
    );
  if (!grant || !(await grantUsable(db, grant))) return tokenError("invalid_grant", "Authorize the app again");
  const [client] = await db.select().from(oauthAppClients).where(eq(oauthAppClients.id, request.clientId));
  const cursor = client ? appIdentity(client, request.redirectUri).cursor : false;
  const body = await db.transaction((tx) =>
    mintPair(tx, grant, {
      requestId: request.id,
      accessMs: cursor ? APP_LIMITS.cursorAccessMs : APP_LIMITS.accessMs,
      scopes: request.scopes,
    }),
  );
  await touchApp(db, request.clientId);
  return { ok: true, body };
}

/** `grant_type=refresh_token`: rotation in the same family, with a short grace for a client's retry. */
export async function refreshTokens(deps: OauthDeps, form: Record<string, string | undefined>): Promise<TokenResult> {
  const { db } = deps;
  const raw = form.refresh_token ?? "";
  if (!raw.startsWith(REFRESH_TOKEN_PREFIX) || !form.client_id)
    return tokenError("invalid_request", "refresh_token and client_id are required");
  const [row] = await db
    .select({ token: appTokens, grant: appGrants })
    .from(appTokens)
    .innerJoin(appGrants, eq(appGrants.id, appTokens.grantId))
    .where(and(eq(appTokens.tokenHash, codeOrTokenHash(raw)), eq(appTokens.kind, "refresh")));
  if (!row) return tokenError("invalid_grant", "Unknown refresh token");
  const { token, grant } = row;
  if (grant.clientId !== form.client_id) return tokenError("invalid_grant", "The token was issued to another client");
  // Revoked with its family, or a sibling that lost a concurrent refresh (below): nothing left to end.
  if (token.revokedAt) return tokenError("invalid_grant", "The token was revoked");
  if (token.expiresAt && token.expiresAt.getTime() <= Date.now())
    return tokenError("invalid_grant", "The token expired");
  const usable = await grantUsable(db, grant);
  if (!usable) {
    if (usable === false) await revokeFamily(db, [token.familyId]);
    return tokenError("invalid_grant", "Authorize the app again");
  }
  if (deps.admitRefresh && !(await deps.admitRefresh(grant.id)))
    return {
      ok: false,
      status: 429,
      error: "temporarily_unavailable",
      description: "Too many refreshes. Try again later.",
    };
  const family = {
    accessMs: token.accessSeconds ? token.accessSeconds * 1000 : APP_LIMITS.accessMs,
    scopes: token.scopes ?? grant.scopes,
  };
  const outcome = await db.transaction(async (tx) => {
    if (token.usedAt) {
      // Rotated already. Inside the grace and while no pair it minted has been refreshed, this is a client's
      // retry (two calls refreshing at once, a lost answer): a sibling pair under the same parent, the earlier
      // ones left alive, since the client keeps whichever answer came last. The first sibling refreshed revokes
      // the others. Otherwise someone else holds the old token: the whole family goes.
      const children = await tx
        .select({ usedAt: appTokens.usedAt })
        .from(appTokens)
        .where(and(eq(appTokens.parentId, token.id), eq(appTokens.kind, "refresh")));
      const inGrace = Date.now() - token.usedAt.getTime() <= APP_LIMITS.refreshGraceMs;
      if (!inGrace || children.some((c) => c.usedAt)) {
        await revokeFamily(tx, [token.familyId]);
        return null;
      }
      return mintPair(tx, grant, { familyId: token.familyId, parentId: token.id, ...family });
    }
    const [marked] = await tx
      .update(appTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(appTokens.id, token.id), isNull(appTokens.usedAt)))
      .returning({ id: appTokens.id });
    if (!marked) return "race" as const;
    if (token.parentId)
      await tx
        .update(appTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(appTokens.parentId, token.parentId),
            eq(appTokens.kind, "refresh"),
            ne(appTokens.id, token.id),
            isNull(appTokens.usedAt),
            isNull(appTokens.revokedAt),
          ),
        );
    return mintPair(tx, grant, { familyId: token.familyId, parentId: token.id, ...family });
  });
  if (outcome === "race") return refreshTokens(deps, form);
  if (!outcome) return tokenError("invalid_grant", "The token was already used");
  if (grant.clientId) await touchApp(db, grant.clientId);
  return { ok: true, body: outcome };
}

/** `POST /api/oauth/revoke` (RFC 7009): a refresh token takes its family, any other token itself. */
export async function revokeToken(db: Database, raw: string) {
  if (!raw) return;
  const [token] = await db
    .select()
    .from(appTokens)
    .where(eq(appTokens.tokenHash, codeOrTokenHash(raw)));
  if (!token) return;
  if (token.kind === "refresh") return revokeFamily(db, [token.familyId]);
  await db
    .update(appTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(appTokens.id, token.id), isNull(appTokens.revokedAt)));
  // A personal token is its grant: revoking it disconnects it from the list too.
  if (token.kind === "personal")
    await db.transaction((tx) =>
      revokeAppGrants(tx, eq(appGrants.id, token.grantId), { type: "system", reason: "revoked_with_token" }),
    );
}

import { and, type Database, desc, eq, gt, isNull, lt, or, schema, sql } from "@agenteschat/db";
import { recordAudit } from "../audit";
import { sha256 } from "../crypto";
import { ConflictError, ForbiddenError, NotFoundError } from "../errors";
import { can, getMembership, requireActiveMembership } from "../organizations";
import { accountInUse, workRefusal } from "../standing";
import { queueReceipt } from "./oauth";
import { revokeAppGrants, revokeMemberApps } from "./revoke";
import {
  ACCESS_TOKEN_PREFIX,
  APP_LIMITS,
  type AppAccess,
  type AppScope,
  appAccessOf,
  appScopesFor,
  PERSONAL_TOKEN_PREFIX,
  randomBase62,
} from "./urls";

const { appGrants, appTokens, appSends, oauthAppRequests, oauthAppClients, users, organizations } = schema;

/** Who an MCP request acts as, once its bearer token checked out (ADR 0119 §1.9). */
export interface AppPrincipal {
  grantId: string;
  orgId: string;
  orgName: string;
  userId: string;
  personName: string;
  scopes: AppScope[];
  /** How the app is named in "via" tags, audit and the agent's context. */
  app: { name: string; brand: string | null; host: string | null; kind: string };
  /** A reason every tool call is refused with (blocked account, paused workspace), instead of a 401 loop. */
  refusal: string | null;
}

/**
 * The bearer of an MCP request: an access token (`aga_`) or a personal one (`agp_`), alive, its grant not
 * revoked, its person still in the workspace. A person who left loses the grant here (the app signs in again and
 * may pick another workspace). Null: answer with the 401 challenge. Never reads cookies.
 */
export async function authenticateAppBearer(db: Database, header: string | undefined | null) {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  const raw = match?.[1] ?? "";
  if (!raw.startsWith(ACCESS_TOKEN_PREFIX) && !raw.startsWith(PERSONAL_TOKEN_PREFIX)) return null;
  const [row] = await db
    .select({
      grant: appGrants,
      tokenKind: appTokens.kind,
      tokenScopes: appTokens.scopes,
      personName: users.name,
      open: accountInUse,
    })
    .from(appTokens)
    .innerJoin(appGrants, eq(appGrants.id, appTokens.grantId))
    .innerJoin(users, eq(users.id, appGrants.userId))
    .where(
      and(
        eq(appTokens.tokenHash, sha256(raw)),
        isNull(appTokens.revokedAt),
        isNull(appGrants.revokedAt),
        or(isNull(appTokens.expiresAt), gt(appTokens.expiresAt, new Date())),
      ),
    );
  if (!row || row.tokenKind === "refresh") return null;
  return row;
}

/** The second half of the gate, after the rate limit: membership and standing. Null = 401 (grant revoked). */
export async function appPrincipal(
  db: Database,
  row: NonNullable<Awaited<ReturnType<typeof authenticateAppBearer>>>,
): Promise<AppPrincipal | null> {
  const { grant } = row;
  let refusal: string | null = null;
  if (!row.open) {
    refusal = "This agentes.chat account can't be used right now.";
  } else {
    const membership = await getMembership(db, grant.userId, grant.orgId);
    if (!membership) {
      await db.transaction((tx) => revokeMemberApps(tx, grant.orgId, grant.userId));
      return null;
    }
    if (workRefusal(membership.standing))
      refusal = "This workspace is paused in agentes.chat. Nothing can be read or sent through this app now.";
  }
  const [org] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, grant.orgId));
  return {
    grantId: grant.id,
    orgId: grant.orgId,
    orgName: org?.name ?? "",
    userId: grant.userId,
    personName: row.personName,
    // The connection's own access, within the grant's.
    scopes: (row.tokenScopes ?? grant.scopes).filter((s) => grant.scopes.includes(s)) as AppScope[],
    app: { name: grant.displayName, brand: grant.brand, host: grant.displayHost, kind: grant.displayKind },
    refusal,
  };
}

/** Records a use of the grant, at most once a minute (the list shows "Usado há…"). */
export async function touchGrant(db: Database, grantId: string) {
  await db
    .update(appGrants)
    .set({ lastUsedAt: new Date() })
    .where(
      and(
        eq(appGrants.id, grantId),
        or(isNull(appGrants.lastUsedAt), lt(appGrants.lastUsedAt, new Date(Date.now() - 60_000))),
      ),
    );
}

export interface AppsList {
  apps: {
    id: string;
    kind: "oauth";
    displayKind: string;
    name: string;
    host: string | null;
    brand: string | null;
    access: AppAccess;
    person?: { id: string; name: string };
    connectedAt: string;
    lastUsedAt: string | null;
  }[];
  tokens: {
    id: string;
    name: string;
    access: AppAccess;
    createdAt: string;
    expiresAt: string | null;
    lastUsedAt: string | null;
    person?: { id: string; name: string };
  }[];
}

/** Settings → AI apps: my live connections and personal tokens here, or everyone's (`all`, `manage_members`). */
export async function listApps(
  db: Database,
  userId: string,
  orgId: string,
  options: { all?: boolean } = {},
): Promise<AppsList> {
  const membership = await requireActiveMembership(db, userId, orgId);
  if (options.all && !can(membership, "manage_members")) throw new ForbiddenError();
  const rows = await db
    .select({
      grant: appGrants,
      personName: users.name,
      expiresAt: appTokens.expiresAt,
    })
    .from(appGrants)
    .innerJoin(users, eq(users.id, appGrants.userId))
    .leftJoin(appTokens, and(eq(appTokens.grantId, appGrants.id), eq(appTokens.kind, "personal")))
    .where(
      and(
        eq(appGrants.orgId, orgId),
        isNull(appGrants.revokedAt),
        options.all ? undefined : eq(appGrants.userId, userId),
        // A personal token past its date is gone from the list (its row is purged later).
        or(eq(appGrants.kind, "oauth"), isNull(appTokens.expiresAt), gt(appTokens.expiresAt, new Date())),
      ),
    )
    .orderBy(desc(appGrants.consentedAt));
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  const person = (r: (typeof rows)[number]) =>
    options.all ? { person: { id: r.grant.userId, name: r.personName } } : {};
  return {
    apps: rows
      .filter((r) => r.grant.kind === "oauth")
      .map((r) => ({
        id: r.grant.id,
        kind: "oauth" as const,
        displayKind: r.grant.displayKind,
        name: r.grant.displayName,
        host: r.grant.displayHost,
        brand: r.grant.brand,
        access: appAccessOf(r.grant.scopes),
        ...person(r),
        connectedAt: r.grant.consentedAt.toISOString(),
        lastUsedAt: iso(r.grant.lastUsedAt),
      })),
    tokens: rows
      .filter((r) => r.grant.kind === "token")
      .map((r) => ({
        id: r.grant.id,
        name: r.grant.displayName,
        access: appAccessOf(r.grant.scopes),
        createdAt: r.grant.createdAt.toISOString(),
        expiresAt: iso(r.expiresAt),
        lastUsedAt: iso(r.grant.lastUsedAt),
        ...person(r),
      })),
  };
}

/**
 * Disconnects an app or revokes a personal token, now: the grant and every token it has. One's own, or anyone's
 * with `manage_members` (that person isn't told). `kind` keeps the two routes apart.
 */
export async function revokeGrant(
  db: Database,
  actorId: string,
  orgId: string,
  grantId: string,
  kind: "oauth" | "token",
) {
  const membership = await requireActiveMembership(db, actorId, orgId);
  const [grant] = await db
    .select()
    .from(appGrants)
    .where(
      and(eq(appGrants.id, grantId), eq(appGrants.orgId, orgId), eq(appGrants.kind, kind), isNull(appGrants.revokedAt)),
    );
  if (!grant) throw new NotFoundError(kind === "oauth" ? "App not found" : "Token not found");
  if (grant.userId !== actorId && !can(membership, "manage_members")) throw new NotFoundError();
  await db.transaction((tx) => revokeAppGrants(tx, eq(appGrants.id, grant.id), { type: "person", id: actorId }));
}

export const TOKEN_EXPIRY_DAYS = [30, 90, 365] as const;

/**
 * A personal token (`agp_`): for scripts and apps without OAuth sign-in, in this workspace only, on `/mcp` only.
 * The secret is returned here once and stored only as its hash.
 */
export async function createPersonalToken(
  db: Database,
  publicUrl: string,
  userId: string,
  orgId: string,
  input: { name: string; access: AppAccess; expiresInDays: (typeof TOKEN_EXPIRY_DAYS)[number] | null },
) {
  const membership = await requireActiveMembership(db, userId, orgId);
  if (workRefusal(membership.standing)) throw new ConflictError("This workspace is paused", "workspace_paused");
  const name = input.name
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .trim()
    .slice(0, APP_LIMITS.personalTokenNameChars);
  const [{ n = 0 } = {}] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(appGrants)
    .leftJoin(appTokens, and(eq(appTokens.grantId, appGrants.id), eq(appTokens.kind, "personal")))
    .where(
      and(
        eq(appGrants.orgId, orgId),
        eq(appGrants.userId, userId),
        eq(appGrants.kind, "token"),
        isNull(appGrants.revokedAt),
        or(isNull(appTokens.expiresAt), gt(appTokens.expiresAt, new Date())),
      ),
    );
  if (n >= APP_LIMITS.personalTokensPerWorkspace)
    throw new ConflictError(
      `At most ${APP_LIMITS.personalTokensPerWorkspace} personal tokens per workspace. Revoke one first.`,
      "token_limit",
      { limit: APP_LIMITS.personalTokensPerWorkspace },
    );
  const secret = `${PERSONAL_TOKEN_PREFIX}${randomBase62(43)}`;
  const scopes = appScopesFor(input.access);
  const expiresAt = input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null;
  const grant = await db.transaction(async (tx) => {
    const [grant] = await tx
      .insert(appGrants)
      .values({ orgId, userId, kind: "token", displayKind: "token", displayName: name || "Token", scopes })
      .returning();
    if (!grant) throw new Error("grant not stored");
    await tx.insert(appTokens).values({
      orgId,
      grantId: grant.id,
      kind: "personal",
      tokenHash: sha256(secret),
      familyId: grant.id,
      expiresAt,
    });
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: userId },
      action: "apps.token_created",
      target: { type: "app_grant", id: grant.id },
      details: { app: grant.displayName, scopes, expiresAt: expiresAt?.toISOString() ?? null },
    });
    await queueReceipt(tx, publicUrl, userId, orgId, membership.orgName, grant.displayName, `app-token:${grant.id}`);
    return grant;
  });
  return {
    token: { id: grant.id, name: grant.displayName, access: input.access, expiresAt: expiresAt?.toISOString() ?? null },
    secret,
  };
}

/**
 * Hourly cleanup (ADR 0119 §2): requests a day after they ran out, tokens 30 days after they expired or were
 * revoked, registrations with no connection unused for 90 days, sends after 90 days, and grants unused for 90 days
 * (revoked, then their rows go with the tokens).
 */
export async function purgeApps(db: Database, now = new Date()) {
  const ago = (days: number) => new Date(now.getTime() - days * 86_400_000);
  await db.delete(oauthAppRequests).where(lt(oauthAppRequests.expiresAt, ago(1)));
  await db.delete(appTokens).where(or(lt(appTokens.expiresAt, ago(30)), lt(appTokens.revokedAt, ago(30))));
  await revokeAppGrants(
    db,
    and(eq(appGrants.kind, "oauth"), lt(sql`coalesce(${appGrants.lastUsedAt}, ${appGrants.consentedAt})`, ago(90))),
    { type: "system", reason: "unused" },
  );
  await db
    .delete(appGrants)
    .where(
      and(
        lt(appGrants.revokedAt, ago(30)),
        sql`not exists (select 1 from ${appTokens} t where t.grant_id = ${appGrants.id})`,
      ),
    );
  await db.delete(oauthAppClients).where(
    and(
      eq(oauthAppClients.kind, "dcr"),
      // Apps keep their client_id for good and only register again after an invalid_client from the token
      // endpoint, which an abandoned sign-in never reaches: a short life locks them out on their next try.
      lt(sql`coalesce(${oauthAppClients.lastUsedAt}, ${oauthAppClients.createdAt})`, ago(90)),
      sql`not exists (select 1 from ${appGrants} g where g.client_id = ${oauthAppClients.id})`,
    ),
  );
  await db.delete(appSends).where(lt(appSends.createdAt, ago(90)));
}

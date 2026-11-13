import { createHmac, randomUUID } from "node:crypto";
import { type Database, eq, schema, sql } from "@agenteschat/db";
import { appLocale } from "@agenteschat/i18n/locale";
import { operatorOrg } from "./operator";
import { requirePermission, type UserLocale } from "./organizations";

const { organizations, channels, messages, artifacts, wikiPages, issues } = schema;

/** Where in the app a billing link was opened from: the billing service opens on what it came for (ADR 0079). */
export const BILLING_FROM = [
  "settings",
  "hold",
  "onboarding",
  "new_workspace",
  "invite_full",
  "upload_full",
  "storage",
] as const;
export type BillingFrom = (typeof BILLING_FROM)[number];

export interface BillingLinkClaims {
  aud: "agentes-billing";
  /** Single use on the billing service's side. */
  jti: string;
  /** Seconds. */
  iat: number;
  exp: number;
  orgId: string;
  orgName: string;
  userId: string;
  email: string;
  name: string;
  role: "owner" | "admin";
  locale: UserLocale;
  from: BillingFrom;
  /** The plan the person picked in the app (the billing service's own key, `PLAN_CLAIM`), to open its Checkout. */
  plan?: string;
  /** The path on this server the billing service sends the person back to. */
  return: string;
  /**
   * What the workspace holds, as counts only (`totalsOf`). `storageBytes` null: the workspace keeps its files on its
   * own bucket.
   */
  usage: {
    members: number;
    agents: number;
    storageBytes: number | null;
    messages: number;
    channels: number;
    files: number;
    wikiPages: number;
    issues: number;
    /** When the workspace was created, in seconds. */
    since: number;
  };
}

/** A plan's key as the billing service names it: this server passes it on and never reads it. */
export const PLAN_CLAIM = /^[a-z][a-z0-9_]{0,31}$/;

/** How long a link opens the billing service: minted on click, it only has to reach the next page. */
export const BILLING_LINK_SECONDS = 300;

/**
 * `v1.<claims as base64url JSON>.<base64url HMAC-SHA256 of "v1.<claims>">`. The billing service checks the
 * signature over the payload exactly as sent, never over claims it serialized again.
 */
export function signBillingLink(secret: string, claims: BillingLinkClaims): string {
  const signed = `v1.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
  return `${signed}.${createHmac("sha256", secret).update(signed).digest("base64url")}`;
}

/** Where under the workspace each entry point sends people back (the onboarding's opens it again at its AI step). */
const RETURN_TO: Partial<Record<BillingFrom, string>> = {
  settings: "/settings/billing",
  storage: "/settings/storage",
  invite_full: "/members",
  onboarding: "/onboarding",
};

/**
 * The page the person opened the link from (`returnTo`), when it is one of this workspace's: they land back there,
 * not on the entry point's default. Never another workspace or host. The billing service refuses the whole link
 * unless `return` is `/org/<uuid>` plus lowercase path segments (no search, no hash; it adds `?paid=1` itself), so
 * the page's search and hash are dropped and any other shape falls back to the default.
 */
const placeIn = (orgId: string, returnTo: string | undefined) => {
  const path = returnTo?.split(/[?#]/)[0];
  return path?.startsWith(`/org/${orgId}/`) && /^\/org\/[0-9a-f-]{36}(\/[a-z0-9/-]*)?$/.test(path) ? path : null;
};

/**
 * A workspace's messages, those of every conversation a person can read (an agent-only room has no `u:` in its key, as
 * `isAgentOnlyDm` reads it), counted per conversation on each month's `(channel_id, created_at)` index without reading
 * a row: no index of `messages` starts with `org_id` (ADR 0009).
 */
export const orgMessageCount = (orgId: string) =>
  sql<number>`(select coalesce(sum(per.n), 0) from ${channels} c,
      lateral (select count(*) as n from ${messages} m where m.channel_id = c.id) per
    where c.org_id = ${orgId} and (c.kind <> 'dm' or c.dm_key like '%u:%'))`.mapWith(Number);

/**
 * What a workspace holds, for the billing service's pages (ADR 0079 §3): workspace-wide counts, never a name, a word of
 * content, or a figure per channel or person.
 */
const totalsOf = (orgId: string) => ({
  messages: orgMessageCount(orgId),
  channels: sql<number>`(select count(*) from ${channels} where ${channels.orgId} = ${orgId}
    and ${channels.kind} = 'channel' and ${channels.archivedAt} is null)`.mapWith(Number),
  files: sql<number>`(select count(*) from ${artifacts} where ${artifacts.orgId} = ${orgId}
    and ${artifacts.deletedAt} is null)`.mapWith(Number),
  wikiPages: sql<number>`(select count(*) from ${wikiPages} where ${wikiPages.orgId} = ${orgId}
    and ${wikiPages.deletedAt} is null)`.mapWith(Number),
  issues: sql<number>`(select count(*) from ${issues} where ${issues.orgId} = ${orgId}
    and ${issues.status} <> 'canceled')`.mapWith(Number),
});

/**
 * A signed link to the workspace's plan and billing on the billing service, for its owners and admins. A
 * suspended workspace refuses it (`org.suspended`); a held one doesn't, since paying is how a billing hold ends, nor
 * one being deleted, whose payer still reaches its invoices and card.
 */
export async function mintBillingLink(
  db: Database,
  input: {
    secret: string;
    baseUrl: string;
    userId: string;
    orgId: string;
    from: BillingFrom;
    /** The page it was opened from, to come back to (`placeIn`). */
    returnTo?: string;
    /** The plan picked in the app (`PLAN_CLAIM`); anything else is left out. */
    plan?: string;
    now?: Date;
  },
): Promise<{ url: string; expiresAt: Date }> {
  const { userId, orgId, from } = input;
  const membership = await requirePermission(db, userId, orgId, "manage_billing");
  const [org, [user], [totals]] = await Promise.all([
    operatorOrg(db, orgId),
    db
      .select({ email: schema.users.email, name: schema.users.name, locale: schema.users.locale })
      .from(schema.users)
      .where(eq(schema.users.id, userId)),
    db.select(totalsOf(orgId)).from(organizations).where(eq(organizations.id, orgId)),
  ]);
  if (!org || !user || !totals) throw new Error("billing link: the workspace or the account is gone");
  const iat = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const exp = iat + BILLING_LINK_SECONDS;
  const token = signBillingLink(input.secret, {
    aud: "agentes-billing",
    jti: randomUUID(),
    iat,
    exp,
    orgId,
    orgName: org.name,
    userId,
    email: user.email,
    name: user.name,
    role: membership.role === "owner" ? "owner" : "admin",
    locale: appLocale([user.locale], true) ?? "en",
    from,
    ...(input.plan && PLAN_CLAIM.test(input.plan) ? { plan: input.plan } : {}),
    return: placeIn(orgId, input.returnTo) ?? `/org/${orgId}${RETURN_TO[from] ?? ""}`,
    usage: {
      members: org.counts.members,
      agents: org.counts.agents,
      storageBytes: org.meters.ownStorage ? null : org.meters.storageBytes,
      ...totals,
      since: Math.floor(org.createdAt.getTime() / 1000),
    },
  });
  return { url: `${input.baseUrl.replace(/\/+$/, "")}/link?t=${token}`, expiresAt: new Date(exp * 1000) };
}

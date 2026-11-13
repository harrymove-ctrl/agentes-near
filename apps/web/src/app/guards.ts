import type { Me } from "@agenteschat/client";
import { authConfigQuery, instanceQuery, meQuery } from "@agenteschat/client";
import type { LegalKind } from "@agenteschat/i18n/legal";
import { redirect } from "@tanstack/react-router";
import type { RouterContext } from "./router-context";

/** Route guard: the signed-in person, or a redirect to /login that comes back afterwards. */
export async function requireUser(context: RouterContext, href: string): Promise<Me> {
  const me = await context.queryClient.ensureQueryData(meQuery(context.api));
  if (!me) throw redirect({ to: "/login", search: { redirect: href } });
  return me;
}

/**
 * The signed-in person, sure to include `orgId` when they belong to it: the
 * cached list can predate a workspace just created or joined, so a miss asks
 * the server again before saying "you're not part of this organization".
 */
export async function requireUserIn(context: RouterContext, href: string, orgId: string): Promise<Me> {
  const me = await requireUser(context, href);
  if (me.organizations.some((o) => o.id === orgId)) return me;
  const fresh = await context.queryClient.fetchQuery({ ...meQuery(context.api), staleTime: 0 });
  if (!fresh) throw redirect({ to: "/login", search: { redirect: href } });
  return fresh;
}

/**
 * `/terms` and `/privacy`: agentes.chat Cloud's documents where the server says it is the Cloud (true). Any other
 * server sends them to its own page (`TERMS_URL`, `PRIVACY_URL`), or has none (false).
 */
export async function legalPage(context: RouterContext, kind: LegalKind): Promise<boolean> {
  const [instance, config] = await Promise.all([
    context.queryClient.ensureQueryData(instanceQuery(context.api)),
    context.queryClient.ensureQueryData(authConfigQuery(context.api)),
  ]);
  if (instance.cloud) return true;
  const own = kind === "terms" ? config.termsUrl : config.privacyUrl;
  // A page at this same address is this app's, which would land back here.
  if (own && new URL(own, window.location.href).origin !== window.location.origin) throw redirect({ href: own });
  return false;
}

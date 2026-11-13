import { meQuery } from "@agenteschat/client";
import { earlyAccessToken, safeRedirect } from "@agenteschat/client/lib/guards";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { AuthPage } from "@/pages/AuthPage";

/**
 * The same flow as /login (the e-mail decides), worded for someone new. An early-access email links here with its
 * address and its token (`?email=&access=`), which opens sign-up for that address (ADR 0078).
 */
export const Route = createFileRoute("/signup")({
  validateSearch: (search: Record<string, unknown>): { redirect?: string; email?: string; access?: string } => ({
    redirect: safeRedirect(search.redirect),
    email: typeof search.email === "string" ? search.email : undefined,
    access: earlyAccessToken(search.access),
  }),
  beforeLoad: async ({ context, search }) => {
    const me = await context.queryClient.ensureQueryData(meQuery(context.api));
    if (me) throw redirect({ href: search.redirect ?? "/" });
  },
  component: function Signup() {
    const search = Route.useSearch();
    return <AuthPage start="up" redirect={search.redirect} email={search.email} access={search.access} />;
  },
});

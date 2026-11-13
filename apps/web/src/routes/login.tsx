import { authConfigQuery, invitationQuery, meQuery } from "@agenteschat/client";
import { safeRedirect, signInFor } from "@agenteschat/client/lib/guards";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { AuthPage } from "@/pages/AuthPage";

export const Route = createFileRoute("/login")({
  // `error`: a provider sign-in the server refused comes back here with its code.
  validateSearch: (search: Record<string, unknown>): { redirect?: string; email?: string; error?: string } => ({
    redirect: safeRedirect(search.redirect),
    email: typeof search.email === "string" ? search.email : undefined,
    error: typeof search.error === "string" ? search.error : undefined,
  }),
  beforeLoad: async ({ context, search }) => {
    const goal = signInFor(search.redirect);
    const [me, config] = await Promise.all([
      context.queryClient.ensureQueryData(meQuery(context.api)),
      context.queryClient.ensureQueryData(authConfigQuery(context.api)),
      // The page names the invitation's workspace from the first frame (`AuthPage`).
      goal && "invite" in goal ? context.queryClient.prefetchQuery(invitationQuery(context.api, goal.invite)) : null,
    ]);
    // An OAuth callback that waited for a sign-in (under /api/) is the server's: a full load.
    if (me) throw redirect({ href: search.redirect ?? "/", reloadDocument: search.redirect?.startsWith("/api/") });
    // A brand-new instance has nobody to sign in: go straight to the first account.
    if (config.firstRun) throw redirect({ to: "/signup", search: { redirect: search.redirect } });
  },
  component: function Login() {
    const search = Route.useSearch();
    return <AuthPage start="in" redirect={search.redirect} email={search.email} refused={search.error} />;
  },
});

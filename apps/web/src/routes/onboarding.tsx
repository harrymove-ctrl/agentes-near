import { meQuery, useMe } from "@agenteschat/client";
import { isPaidReturn } from "@agenteschat/client/lib/billing";
import { settingUp } from "@agenteschat/client/lib/guards";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { requireUser } from "@/app/guards";
import { useServerLocale } from "@/i18n";
import { ARRIVAL_PARAM } from "@/lib/arrival";
import { OnboardingPage } from "@/pages/OnboardingPage";

export const Route = createFileRoute("/onboarding")({
  // `?resume=<orgId>`: back from that workspace's plan (`/org/$orgId/onboarding`, ADR 0079), `paid` after paying;
  // `?delete=1`: its dialog that deletes the workspace.
  validateSearch: (search: Record<string, unknown>): { resume?: string; paid?: true; delete?: 1 } => ({
    ...(typeof search.resume === "string" ? { resume: search.resume } : {}),
    ...(isPaidReturn(search) ? { paid: true } : {}),
    ...(search.delete === undefined ? {} : { delete: 1 as const }),
  }),
  beforeLoad: ({ context, location }) => requireUser(context, location.href),
  loaderDeps: ({ search }) => ({ resume: search.resume, paid: search.paid }),
  // Back from the billing page, paid or not, the onboarding resumes where its data is: paid, on its plan step, the
  // payment said as received until the hold lifts, then on connecting an AI (ADR 0162, amended 2026-11-10). A
  // workspace set up meanwhile (another tab) opens as it is, on its arrival when it was paid for.
  loader: async ({ context, deps: { resume, paid } }) => {
    if (!resume) return;
    const me = await context.queryClient.fetchQuery(meQuery(context.api)).catch(() => null);
    const org = me?.organizations.find((o) => o.id === resume);
    if (!org || settingUp(org)) return;
    if (paid)
      throw redirect({
        to: "/org/$orgId",
        params: { orgId: resume },
        search: { paid: true as const, [ARRIVAL_PARAM]: 1 } as never,
      });
    throw redirect({ to: "/org/$orgId", params: { orgId: resume } });
  },
  component: function Onboarding() {
    useServerLocale(useMe().data?.user);
    return <OnboardingPage />;
  },
});

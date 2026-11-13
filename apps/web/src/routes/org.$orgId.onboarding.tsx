import { isPaidReturn } from "@agenteschat/client/lib/billing";
import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Where the billing service sends people back from the onboarding (ADR 0079): the first step still waiting for them
 * (`resumeOnboarding`).
 */
export const Route = createFileRoute("/org/$orgId/onboarding")({
  beforeLoad: ({ params, search }) => {
    throw redirect({
      to: "/onboarding",
      search: { resume: params.orgId, ...(isPaidReturn(search) ? { paid: true } : {}) },
    });
  },
});

import { useAuthConfig } from "@agenteschat/client";
import { planOfferOf } from "@agenteschat/client/lib/billing";
import { useQuery } from "@tanstack/react-query";

/** How long the plan list may take: past it the onboarding names no plan rather than wait. */
const PLANS_WAIT_MS = 4000;

/**
 * The plan the onboarding offers, read by the browser from the billing service's public plan list in the person's
 * language: this server never names a plan nor a price (ADR 0079 §6). `offer` is null without a billing service, and
 * when the list can't be read in time: the onboarding then names no plan. `loading` while the list is on its way.
 */
export function usePlanOffer(locale: string) {
  const billingUrl = useAuthConfig().data?.billingUrl ?? null;
  const plans = useQuery({
    queryKey: ["planOffer", billingUrl, locale],
    queryFn: async () => {
      const res = await fetch(`${billingUrl?.replace(/\/+$/, "")}/plans.json?locale=${encodeURIComponent(locale)}`, {
        signal: AbortSignal.timeout(PLANS_WAIT_MS),
      });
      return res.ok ? planOfferOf(await res.json()) : null;
    },
    enabled: billingUrl !== null,
    retry: 0,
    staleTime: 10 * 60_000,
  });
  return { offer: plans.data ?? null, loading: plans.isLoading };
}

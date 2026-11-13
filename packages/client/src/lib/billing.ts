import type { OrgStanding } from "../api/types";

/** Mirror of the server's billing holds (`packages/engine/src/standing.ts`, ADR 0079). */
export const BILLING_HOLDS = ["payment", "unpaid", "ended"] as const;
export type BillingHold = (typeof BILLING_HOLDS)[number];

/**
 * The billing hold a workspace is on, or null: a hold whose told reason is one of the codes, which the apps say in
 * the person's words, never as it comes.
 */
export const billingHoldOf = (
  standing: Pick<OrgStanding, "state" | "reason"> | null | undefined,
): BillingHold | null =>
  standing?.state === "hold" ? (BILLING_HOLDS.find((code) => code === standing.reason) ?? null) : null;

/**
 * Nothing held over the workspace and no suspension: with billing on, the server's only word that its plan is in
 * force.
 */
export const standingActive = (standing: Pick<OrgStanding, "state"> | null | undefined) =>
  (standing?.state ?? "active") === "active";

/**
 * Back from a paid Checkout, the billing service adds `?paid=1` to the return path (ADR 0079). It is the address's
 * word, not the server's: until the hold lifts, the hold banner says the payment arrived, and the onboarding says it's
 * being confirmed, for a minute at most. The router reads `1` as a number, and the onboarding forwards it as `true`.
 */
export const isPaidReturn = (search: Record<string, unknown>) =>
  search.paid === 1 || search.paid === true || search.paid === "1";

/** The plan the onboarding offers: its key for the billing link, its name, and its price as the billing service writes it. */
export interface PlanOffer {
  key: string;
  name: string;
  price?: string;
}

const PLAN_KEY = /^[a-z][a-z0-9_]{0,31}$/;
const shortText = (v: unknown, max: number) =>
  typeof v === "string" && v.trim() && v.length <= max ? v.trim() : undefined;

/**
 * The recommended plan from the billing service's public plan list (`GET {billingUrl}/plans.json`), or null when the
 * list isn't one: the onboarding then names no plan. The core server never names a plan nor a price (ADR 0079 §6).
 */
export function planOfferOf(json: unknown): PlanOffer | null {
  if (!json || typeof json !== "object") return null;
  const { recommended, plans } = json as { recommended?: unknown; plans?: unknown };
  if (typeof recommended !== "string" || !Array.isArray(plans)) return null;
  const plan = plans.find((p) => (p as { key?: unknown } | null)?.key === recommended) as
    | Record<string, unknown>
    | undefined;
  const name = shortText(plan?.name, 40);
  if (!plan || !PLAN_KEY.test(recommended) || !name) return null;
  const price = shortText(plan.price, 24);
  return { key: recommended, name, ...(price ? { price } : {}) };
}

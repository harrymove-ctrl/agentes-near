import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import { ApiError } from "../src/api/http";
import type { AppNotification } from "../src/api/types";
import { BILLING_HOLDS, billingHoldOf, planOfferOf } from "../src/lib/billing";
import { errorText, holdText, restrictionLine } from "../src/lib/errors";
import { workspaceHeadline } from "../src/lib/notifications";
import { can } from "../src/lib/permissions";

/** The key and its values, so a test sees which words were picked (the words themselves: packages/i18n). */
const t = ((key: string, o?: Record<string, unknown>) =>
  o && Object.keys(o).length > 0 ? `${key} ${JSON.stringify(o)}` : key) as unknown as TFunction;

const standingNotice = (latest: AppNotification["latest"]) => ({ kind: "org_standing" as const, latest });

describe("billing holds in words (ADR 0079)", () => {
  test("a hold whose reason is a billing code is one; nothing else is", () => {
    for (const code of BILLING_HOLDS) expect(billingHoldOf({ state: "hold", reason: code })).toBe(code);
    expect(billingHoldOf({ state: "hold", reason: "verificação de pagamento" })).toBeNull();
    expect(billingHoldOf({ state: "hold", reason: null })).toBeNull();
    expect(billingHoldOf({ state: "suspended", reason: "payment" })).toBeNull();
    expect(billingHoldOf(undefined)).toBeNull();
  });

  test("the banner, an API refusal and a refused run say the hold's own words, never its code", () => {
    for (const code of BILLING_HOLDS) {
      const words = `standing.billing.${code}`;
      expect(holdText(t, { state: "hold", reason: code })).toBe(words);
      expect(restrictionLine(t, "run.org_paused", { reason: code })).toBe(words);
      expect(
        errorText(t, new ApiError(403, "org.paused", `This workspace is on hold: ${code}`, { reason: code })),
      ).toBe(words);
    }
    // A suspension's reason is the operator's, whatever it says.
    expect(restrictionLine(t, "org.suspended", { reason: "payment" })).toBe(
      'standing.suspendedFor {"reason":"payment"}',
    );
  });

  test("creating another workspace while one waits for its plan: the facts, never the web's call to pay", () => {
    const refused = new ApiError(403, "org.create_unpaid", "You already have a workspace waiting for a plan", {
      orgId: "o1",
    });
    expect(errorText(t, refused)).toStartWith("standing.createInactive ");
  });

  test("the notification's headline is the hold's, the plain hold's for a code it doesn't know", () => {
    for (const code of BILLING_HOLDS)
      expect(workspaceHeadline(standingNotice({ statusTo: "hold", billingHold: code }))).toBe(
        `standing.notification.billing.${code}`,
      );
    expect(workspaceHeadline(standingNotice({ statusTo: "hold", billingHold: "trial" }))).toBe(
      "standing.notification.hold",
    );
    expect(workspaceHeadline(standingNotice({ statusTo: "active" }))).toBe("standing.notification.active");
  });

  test("whoever holds manage_billing manages billing (the server spreads administrator out)", () => {
    const of = (...permissions: string[]) => ({ permissions });
    expect([
      can(of("manage_billing"), "manage_billing"),
      can(of("post"), "manage_billing"),
      can(null, "manage_billing"),
    ]).toEqual([true, false, false]);
  });
});

describe("the plan the onboarding offers (the billing service's plan list)", () => {
  const list = (plans: unknown[], recommended = "team") => ({ recommended, plans });
  test("the recommended plan, with its price as the billing service writes it", () => {
    const json = list([
      { key: "personal", name: "Pessoal", price: "$29", period: "month" },
      { key: "team", name: "Equipe", price: "$49", period: "month" },
    ]);
    expect(planOfferOf(json)).toEqual({ key: "team", name: "Equipe", price: "$49" });
  });

  test("a plan with no price is named alone", () => {
    expect(planOfferOf(list([{ key: "team", name: "Equipe" }]))).toEqual({ key: "team", name: "Equipe" });
    expect(planOfferOf(list([{ key: "team", name: "Equipe", price: "" }]))).toEqual({ key: "team", name: "Equipe" });
  });

  test("anything else names no plan", () => {
    expect(planOfferOf(null)).toBeNull();
    expect(planOfferOf("plans")).toBeNull();
    expect(planOfferOf({ plans: [] })).toBeNull();
    expect(planOfferOf(list([{ key: "solo", name: "Solo" }]))).toBeNull();
    expect(planOfferOf(list([{ key: "team" }]))).toBeNull();
    expect(planOfferOf(list([{ key: "Team!", name: "Equipe" }], "Team!"))).toBeNull();
    expect(planOfferOf(list([{ key: "team", name: "x".repeat(41) }]))).toBeNull();
  });
});

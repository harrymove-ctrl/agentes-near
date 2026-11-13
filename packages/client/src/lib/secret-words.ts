import type { TFunction } from "i18next";
import type { SecretRequest } from "../api/types";

/**
 * How a closed secret request ended, the same on the web and the phone, in the one line that takes its card's place:
 * what happened and, when something is left to do, what's next. Never its value.
 */
export function secretOutcome(
  t: TFunction,
  r: Pick<SecretRequest, "status" | "withdrawn" | "endReason" | "supersededBy">,
  mine: boolean,
  person: string,
  agent: string,
): string {
  if (r.status === "delivered") return mine ? t("secret.outcomeByYou") : t("secret.outcomeBy", { person });
  if (r.status === "declined") return t("secret.endedDeclined", { agent });
  // Past its deadline before the server's event said so.
  if (r.status === "expired" || r.status === "pending") return t("secret.endedExpired", { agent });
  if (r.endReason === "superseded" || r.supersededBy) return t("secret.endedSuperseded", { agent });
  if (r.withdrawn || r.endReason === "withdrawn") return t("secret.outcomeWithdrawn", { agent });
  if (r.endReason === "run_stopped") return t("secret.endedRunStopped", { agent });
  if (r.endReason === "computer_changed") return t("secret.endedComputer", { agent });
  if (r.endReason === "person_left") return t("secret.endedPersonLeft", { person });
  return t("secret.endedClosed", { agent });
}

/** When a closed secret request ended: its delivery, or its deadline when it ran out. */
export const secretEndedAt = (r: Pick<SecretRequest, "status" | "deliveredAt" | "expiresAt">) =>
  r.status === "delivered" ? r.deliveredAt : r.status === "canceled" || r.status === "declined" ? null : r.expiresAt;

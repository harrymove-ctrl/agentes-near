import type { PeopleUsage } from "@agenteschat/client";
import { capitalize, formatMonth, formatUsd } from "@agenteschat/client/lib/format";
import type { TFunction } from "i18next";

/**
 * Uso por pessoa's month, as the web's line under its title: on plans only every amount is what the same use would
 * cost at the API's list price, said once on this line ("≈ US$ 12,51 pelo preço da API", why behind its ⓘ), so a
 * person's row reads "≈ US$ 3,10".
 */
export function peopleMonthLine(
  t: TFunction,
  locale: string,
  data: Pick<PeopleUsage, "month" | "totalUsd" | "plansOnly"> & { people: readonly unknown[] },
) {
  const month = capitalize(formatMonth(locale, new Date(`${data.month}-15T12:00:00`)), locale);
  const total = formatUsd(locale, data.totalUsd);
  return data.plansOnly
    ? t("peopleUsage.subPlans", {
        month,
        count: data.people.length,
        amount: t("peopleUsage.meter.estimate", { amount: total }),
      })
    : t("peopleUsage.sub", { month, count: data.people.length, amount: total });
}

import type { TFunction } from "i18next";
import type { AppNotification, PeopleUsage } from "../api/types";
import { formatUsd } from "./format";

/** Uso › Pessoas (ADR 0141): what the web and the phone share. */

export type PersonRow = PeopleUsage["people"][number];

/** The periods the report offers; `month`: this month so far, the limits' period. */
export const USAGE_PERIODS = ["month", "last7", "last30", "lastMonth"] as const;
export type UsagePeriodKind = (typeof USAGE_PERIODS)[number];

/** A period as the API takes it (UTC). */
export function usagePeriod(kind: UsagePeriodKind, now = new Date()): { since?: string; until?: string } {
  const day = 24 * 3600_000;
  if (kind === "last7") return { since: new Date(now.getTime() - 7 * day).toISOString() };
  if (kind === "last30") return { since: new Date(now.getTime() - 30 * day).toISOString() };
  if (kind === "lastMonth") {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    return { since: start.toISOString(), until: end.toISOString() };
  }
  return {};
}

/**
 * A person's amount, "≈ US$ 3,10" when any of it was use on a plan: that part is what the same use would cost at the
 * API's list price, which nobody pays (the ⓘ beside it says so). Each person by their own use, so in a workspace
 * with plans and API keys only the estimates read ≈.
 */
export const personAmount = (t: TFunction, locale: string, estimated: boolean, usd: number) =>
  estimated ? t("peopleUsage.meter.approx", { amount: formatUsd(locale, usd) }) : formatUsd(locale, usd);

export const PEOPLE_CHIPS = ["near", "at", "idle"] as const;
export type PeopleChip = (typeof PEOPLE_CHIPS)[number];

/** Whether a row is in a chip: near its limit (80%), at it, or with no use in the period. */
export const inChip = (p: PersonRow, chip: PeopleChip) =>
  chip === "idle" ? p.runs === 0 : chip === "near" ? p.state === "near" : p.state === "at";

/** How many people each chip holds: the summary line and the chips' counts. */
export const chipCounts = (people: PersonRow[]) =>
  Object.fromEntries(PEOPLE_CHIPS.map((c) => [c, people.filter((p) => inChip(p, c)).length])) as Record<
    PeopleChip,
    number
  >;

export interface PeopleFilter {
  roleId?: string | null;
  agentId?: string | null;
  chips?: readonly PeopleChip[];
}

export const filterPeople = (people: PersonRow[], f: PeopleFilter) =>
  people.filter(
    (p) =>
      (!f.roleId || p.roleIds.includes(f.roleId)) &&
      (!f.agentId || p.agents.some((a) => a.agentId === f.agentId)) &&
      (!f.chips?.length || f.chips.some((c) => inChip(p, c))),
  );

export const PEOPLE_SORTS = ["name", "runs", "usage", "created", "last"] as const;
export type PeopleSort = (typeof PEOPLE_SORTS)[number];

/** Every column sorts; ties by name. `usage`: the month's use against the limit, then the amount. */
export function sortPeople(people: PersonRow[], by: PeopleSort, desc: boolean, locale?: string) {
  const key = (p: PersonRow): number | string =>
    by === "name"
      ? p.name
      : by === "runs"
        ? p.runs
        : by === "created"
          ? p.created
          : by === "last"
            ? (p.lastActiveAt ?? "")
            : p.costUsd;
  return [...people].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    const c = typeof x === "string" ? x.localeCompare(String(y), locale) : x - (y as number);
    return (desc ? -c : c) || a.name.localeCompare(b.name, locale);
  });
}

/**
 * Under a person's limit notice to who decides (ADR 0141): this month's requests, the agent most used and where the
 * limit comes from ("64 pedidos este mês, 80% com Zara. Limite do papel Vendas."). Empty for the person's own.
 */
export function usageLimitLine(t: TFunction, n: Pick<AppNotification, "latest" | "source">) {
  const l = n.latest;
  if (l.statusTo !== "reached" && l.statusTo !== "request") return "";
  const runs = t("notifications.usageLimit.runs", { count: l.runs ?? 0 });
  const top = l.title ? t("notifications.usageLimit.top", { share: l.share ?? 0, agent: l.title }) : "";
  const from =
    l.limitFrom === "role"
      ? t("notifications.usageLimit.fromRole", { role: n.source.label ?? "" })
      : l.limitFrom === "raised"
        ? t("notifications.usageLimit.fromRaised")
        : l.limitFrom === "person"
          ? t("notifications.usageLimit.fromPerson")
          : t("notifications.usageLimit.fromDefault");
  return t("notifications.usageLimit.line", { runs: top ? `${runs}, ${top}` : runs, from });
}

/**
 * Dates, numbers, money, lists and plurals through the built-in Intl APIs, for the apps and the engine alike. `locale`
 * is an Intl tag (`intlLocale`) or an app code: both work.
 */

/** A plural form from `forms`: `zero` at 0 when given, else the language's category, else `other`. */
export function plural(
  locale: string,
  n: number,
  forms: Partial<Record<Intl.LDMLPluralRule, string>> & { other: string },
): string {
  if (n === 0 && forms.zero !== undefined) return forms.zero;
  return forms[new Intl.PluralRules(locale).select(n)] ?? forms.other;
}

/** "Ada, Atlas and Theo", "Ada、Atlas、Theo". */
export const formatList = (
  locale: string,
  items: readonly string[],
  type: Intl.ListFormatType = "conjunction",
): string => new Intl.ListFormat(locale, { type, style: "long" }).format(items);

/**
 * US dollars in the language's own way ("$0.42", "US$ 0,42", "0,42 $"), with more decimals for tiny amounts: 3 under
 * a cent, 4 under a tenth of one.
 */
export function formatMoneyUsd(locale: string, n: number): string {
  const abs = Math.abs(n);
  const digits = abs === 0 || abs >= 0.01 ? 2 : abs >= 0.001 ? 3 : 4;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n);
}

export const formatDate = (locale: string, d: Date | string | number, opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(locale, opts).format(new Date(d));

/** "10:42", "10:42 AM", by the language's own clock. */
export const formatTime = (locale: string, d: Date | string | number) =>
  formatDate(locale, d, { hour: "numeric", minute: "2-digit" });

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 86_400_000],
  ["month", 30 * 86_400_000],
  ["week", 7 * 86_400_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

/** "2 min ago", "yesterday", "in 3 days", "now" (under a minute). */
export function relativeTime(locale: string, d: Date | string | number, now: Date = new Date()): string {
  const diff = new Date(d).getTime() - now.getTime();
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  for (const [unit, ms] of UNITS) if (Math.abs(diff) >= ms) return rtf.format(Math.trunc(diff / ms), unit);
  return rtf.format(0, "second");
}

/** Whether the language writes the day before the month ("24/10") or after it ("10/24", "10月24日"). */
export function dayMonthOrder(locale: string): "dm" | "md" {
  const parts = new Intl.DateTimeFormat(locale, { day: "numeric", month: "numeric" }).formatToParts(
    new Date(2026, 9, 24),
  );
  const day = parts.findIndex((p) => p.type === "day");
  const month = parts.findIndex((p) => p.type === "month");
  return day < month ? "dm" : "md";
}

import type { TFunction } from "i18next";
import type { Ago, WorkItem } from "./logic";

/** The line a working item shows: the mission, what the run works on, else where it is. */
export function workTitle(t: TFunction, w: WorkItem): string {
  if (w.kind === "mission") return t("mobile.home.missionTitle", { title: w.what ?? "" });
  if (w.what) return w.what;
  return workWhere(t, w);
}

/** "#produto", or "Conversa direta". */
export function workWhere(t: TFunction, w: WorkItem): string {
  return w.where.kind === "channel" && w.where.name ? `#${w.where.name}` : t("mobile.home.directChat");
}

/** "há 4 min", "há 2 h", "agora". */
export function agoText(t: TFunction, ago: Ago): string {
  if (ago.unit === "now") return t("mobile.time.justNow");
  const key = { minutes: "minutesAgo", hours: "hoursAgo", days: "daysAgo" }[ago.unit];
  return t(`mobile.time.${key}`, { count: ago.count });
}

/** "4 min", "2 h", "3 d", "agora": the figure at a list row's right, where "ago" is already understood. */
export function agoShort(t: TFunction, ago: Ago): string {
  if (ago.unit === "now") return t("mobile.time.short.now");
  return t(`mobile.time.short.${ago.unit}`, { count: ago.count });
}

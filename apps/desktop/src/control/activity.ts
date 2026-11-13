/**
 * Activity across organizations: each runner keeps its own log (newest first, paged with `before`),
 * and "Todas" shows them merged. A page asks every home for `limit` entries before its own cursor,
 * merges them by time and keeps the newest `limit`; each home's cursor moves to the last entry of
 * it that was shown, so what wasn't shown comes again on the next page.
 */
import type { ActivityEntry, ActivitySaid } from "@agenteschat/adapters/runner-control";
import type { TFunction } from "i18next";

export interface HomeEntry extends ActivityEntry {
  homeId: string;
}

export interface HomeCursor {
  /** `at` of the last entry shown from this home; absent: start from the newest. */
  before?: string;
  /** This home may have older entries. */
  more: boolean;
}

export type ActivityCursor = Record<string, HomeCursor>;

export interface HomePage {
  homeId: string;
  entries: ActivityEntry[];
  more: boolean;
}

export const startCursor = (homeIds: readonly string[]): ActivityCursor =>
  Object.fromEntries(homeIds.map((id) => [id, { more: true }]));

/** The homes worth asking for the next page. */
export const homesToFetch = (cursor: ActivityCursor): string[] =>
  Object.entries(cursor)
    .filter(([, c]) => c.more)
    .map(([id]) => id);

export const hasMore = (cursor: ActivityCursor) => Object.values(cursor).some((c) => c.more);

const time = (at: string) => {
  const t = Date.parse(at);
  return Number.isFinite(t) ? t : 0;
};

/** Merges one page from several homes: the newest `limit` entries and the cursor for the next page. */
export function mergePages(
  pages: readonly HomePage[],
  cursor: ActivityCursor,
  limit: number,
): { entries: HomeEntry[]; cursor: ActivityCursor } {
  const all: HomeEntry[] = pages.flatMap((p) => p.entries.map((e) => ({ ...e, homeId: p.homeId })));
  all.sort((a, b) => time(b.at) - time(a.at));
  const shown = all.slice(0, Math.max(0, limit));
  const next: ActivityCursor = { ...cursor };
  for (const p of pages) {
    const mine = shown.filter((e) => e.homeId === p.homeId);
    const last = mine[mine.length - 1];
    const leftOver = p.entries.length > mine.length;
    next[p.homeId] = {
      before: last ? last.at : cursor[p.homeId]?.before,
      more: p.more || leftOver,
    };
  }
  return { entries: shown, cursor: next };
}

export type DayKey = "today" | "yesterday" | "date";

export interface DayGroup<T> {
  key: string;
  kind: DayKey;
  /** Local midnight of that day. */
  day: Date;
  entries: T[];
}

const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** Groups entries (already newest first) by local day: Hoje, Ontem, then dates. */
export function groupByDay<T extends { at: string }>(entries: readonly T[], now: Date = new Date()): DayGroup<T>[] {
  const today = midnight(now).getTime();
  const yesterday = midnight(new Date(today - 12 * 60 * 60 * 1000)).getTime();
  const groups: DayGroup<T>[] = [];
  for (const e of entries) {
    const day = midnight(new Date(time(e.at)));
    const key = `${day.getFullYear()}-${day.getMonth() + 1}-${day.getDate()}`;
    let g = groups[groups.length - 1];
    if (!g || g.key !== key) {
      const t = day.getTime();
      g = { key, kind: t === today ? "today" : t === yesterday ? "yesterday" : "date", day, entries: [] };
      groups.push(g);
    }
    g.entries.push(e);
  }
  return groups;
}

/**
 * An activity line or a job in the person's words (`desktop.prefs.activity.said.<key>`), from what the runner says it
 * was (`said`); one from an older runner, or with words this app doesn't have, reads as it came (`summary`, English).
 * `clock` writes a time the line names (paused until).
 */
export function saidText(
  t: TFunction,
  line: { summary: string; said?: ActivitySaid },
  clock: (iso: string) => string,
): string {
  const said = line.said;
  if (!said?.key) return line.summary;
  const tt = t as unknown as (key: string, options: Record<string, unknown>) => string;
  const words = (key: string) => tt(`desktop.prefs.activity.said.${key}`, { defaultValue: "" });
  const values: Record<string, unknown> = { ...said };
  if (said.executor) values.what = words(`executor.${said.executor}`) || said.executor;
  if (said.tool) values.tool = words(`tools.${said.tool}`) || said.name || said.tool;
  if (said.agents === "") values.agents = words("noAgent");
  if (said.until) values.until = clock(said.until);
  return tt(`desktop.prefs.activity.said.${said.key}`, { ...values, defaultValue: line.summary }) || line.summary;
}

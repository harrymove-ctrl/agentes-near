/**
 * The channel's sky band: on the first visit of a new day to a workspace, the
 * first channel you open greets you and says what its agents did since your
 * last visit. The pure rules; each platform keeps the visits.
 */

/** Greet when the last visit was on another (local) day; never on the very first visit (onboarding does that). */
export function isNewDay(last: number | null, now = new Date()) {
  if (last === null) return false;
  const a = new Date(last);
  return a.getFullYear() !== now.getFullYear() || a.getMonth() !== now.getMonth() || a.getDate() !== now.getDate();
}

export type DayPart = "morning" | "afternoon" | "evening";

export const dayPart = (hour: number): DayPart =>
  hour >= 5 && hour < 12 ? "morning" : hour >= 12 && hour < 18 ? "afternoon" : "evening";

/** Agent messages after `since`: who wrote and how many, most active first. */
export function agentActivitySince(
  messages: { author: { type: string; id: string | null }; createdAt: string }[],
  since: number,
): { agentIds: string[]; count: number } {
  const per = new Map<string, number>();
  let count = 0;
  for (const m of messages) {
    if (m.author.type !== "agent" || !m.author.id || new Date(m.createdAt).getTime() <= since) continue;
    per.set(m.author.id, (per.get(m.author.id) ?? 0) + 1);
    count++;
  }
  const agentIds = [...per.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  return { agentIds, count };
}

import type { AppNotification, MediaKind, NotificationActor, Routine } from "@agenteschat/client";
import { approvalOriginWords } from "@agenteschat/client/lib/approval-origin";
import { namesText } from "@agenteschat/client/lib/format";
import { upcomingRoutines } from "@agenteschat/client/lib/home";
import { mediaKindOf } from "@agenteschat/client/lib/media";
import { askersOf, runFailedGroupOf } from "@agenteschat/client/lib/notifications";
import { routineNotificationWords, type Words } from "@agenteschat/client/lib/routine-view";
import type { TFunction } from "i18next";
import { isDeviceNotice } from "../devices/logic";
import { daysAgo } from "../shared/logic";

/**
 * Atividade: what waits on you on top, then the rest by day. Grouped
 * items (replies of a thread, reactions to a message) are one card that
 * says who and how many.
 */

/** `done`: "Concluídas", what I marked done (the last 30 days), by when. */
export type ActivityFilter = "all" | "waiting" | "done";

/**
 * Waiting ones in this order: an agent stuck in its browser or waiting for a secret (both expire in minutes), an
 * agent's question, my turn at the table, an approval, then someone asking to join (nobody's work waits on it);
 * newest first within a kind.
 */
const WAITING_ORDER: string[] = ["browser_handoff", "secret_request", "agent_question", "approval", "join_request"];

export const isVisible = (n: Pick<AppNotification, "doneAt" | "snoozedUntil">, now = Date.now()) =>
  !n.doneAt && !(n.snoozedUntil && new Date(n.snoozedUntil).getTime() > now);

export function sortWaiting(list: AppNotification[]) {
  return [...list].sort(
    (a, b) => WAITING_ORDER.indexOf(a.kind) - WAITING_ORDER.indexOf(b.kind) || b.updatedAt.localeCompare(a.updatedAt),
  );
}

export type DayGroup = "today" | "yesterday" | "week" | "older";
const DAY_GROUPS: DayGroup[] = ["today", "yesterday", "week", "older"];

export function dayGroupOf(iso: string, now = new Date()): DayGroup {
  const days = daysAgo(iso, now);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return "week";
  return "older";
}

/** The screen's sections: waiting first, then the rest by day (empty groups left out). */
export function activitySections(
  items: AppNotification[],
  filter: ActivityFilter,
  now = new Date(),
): { waiting: AppNotification[]; days: [DayGroup, AppNotification[]][] } {
  if (filter === "done") {
    const done = items.filter((n) => n.doneAt);
    return { waiting: [], days: byDay(done, (n) => n.doneAt ?? n.updatedAt, now) };
  }
  const visible = items.filter((n) => isVisible(n, now.getTime()));
  const waiting = sortWaiting(visible.filter((n) => n.waiting));
  if (filter === "waiting") return { waiting, days: [] };
  return {
    waiting,
    days: byDay(
      visible.filter((x) => !x.waiting),
      (n) => n.updatedAt,
      now,
    ),
  };
}

function byDay(list: AppNotification[], at: (n: AppNotification) => string, now: Date) {
  const groups = new Map<DayGroup, AppNotification[]>(DAY_GROUPS.map((g) => [g, []]));
  for (const n of [...list].sort((a, b) => at(b).localeCompare(at(a)))) groups.get(dayGroupOf(at(n), now))?.push(n);
  return [...groups].filter(([, l]) => l.length > 0);
}

/** Who did it, said short: the first one or two names and how many more. */
export interface Who {
  first: string;
  second: string | null;
  more: number;
  /** People and agents behind it (the verb's number). */
  total: number;
}

export function whoOf(actors: NotificationActor[], nameOf: (a: NotificationActor) => string): Who {
  const names = actors.map(nameOf).filter((n, i, all) => n !== "" && all.indexOf(n) === i);
  const first = names[0] ?? "";
  const second = names[1] ?? null;
  const shown = second ? 2 : first ? 1 : 0;
  return { first, second, more: Math.max(0, names.length - shown), total: Math.max(1, names.length) };
}

/** Says coded words (an i18n key and its values) in the person's language; `otherwise` for an unknown key. */
export type SayWords = (w: Words, otherwise?: string) => string;

/**
 * The line under the title: the snippet, the quote of a reaction, or the request's title. Coded words are
 * said in the person's language (`say`): why a routine paused or failed (its `latest.reason`, never the
 * server's English), and who asked for an approval while nobody watched, leading its title. A GIF or a sticker
 * with no words (`latest.media`, ADR 0091) is said by its word (`mediaWord`: "GIF", "Figurinha").
 */
export function subtitleOf(
  n: AppNotification,
  say: SayWords,
  mediaWord?: (kind: MediaKind) => string,
  /** A message's words in the person's language (`latestText`). */
  written: (l: AppNotification["latest"]) => string | undefined = (l) => l.text,
): string {
  const l = n.latest;
  const media = mediaKindOf(l.media);
  const word = media && mediaWord ? mediaWord(media) : "";
  if (n.kind === "reaction") return l.quote || word;
  // Its title already names who joined (ADR 0090): `latest.title` would say it twice.
  if (n.kind === "invitation_accepted") return "";
  const reason = routineNotificationWords(n);
  if (reason) return say(reason, l.text ?? "");
  if (n.kind === "approval") {
    const origin = approvalOriginWords({ origin: l.origin });
    return [origin ? say(origin) : "", l.title ?? l.text ?? ""].filter(Boolean).join(" · ");
  }
  if (n.kind === "issue_assigned") return l.title ?? l.text ?? "";
  // Its title names the device and whom the agent works for (`latest.title`): only what it is doing goes under it.
  if (isDeviceNotice(n.kind)) return l.text ?? "";
  return written(l) || word || (l.text ?? l.title ?? "");
}

/** Where it happened ("#produto", the thread's title, the mission's name); a device's notice names it already. */
export const placeOf = (n: AppNotification) => (isDeviceNotice(n.kind) ? "" : (n.source.label ?? ""));

/** Emojis a reaction card shows (at most 5, from the server). */
export const emojisOf = (n: AppNotification) => (n.kind === "reaction" ? (n.latest.emojis ?? []).slice(0, 5) : []);

// ── Esperando você as cards, and what comes next ─────────────────────────────────────────────────

export { type WaitingCard, type WaitingCardKind, waitingCardOf } from "@agenteschat/client/lib/notifications";

/**
 * Who asks to join, as the card's line: "Ana asks to join", "Ana and Bruno ask to join", "Ana, Bruno and 2 more ask
 * to join"; and the faces to lead it (the names shown, as they aren't members yet: their initials).
 */
export function joinRequestLine(
  t: TFunction,
  n: Pick<AppNotification, "count" | "latest">,
): { text: string; faces: string[] } {
  const asked = askersOf(n);
  // A member's suggestion says who suggested it (ADR 0090).
  const text =
    asked.total > 1
      ? t("notifications.wait.joinRequestNames", { names: namesText(t, asked.names, 2, asked.total) })
      : n.latest.suggestedBy
        ? t("notifications.wait.joinSuggestion", { by: n.latest.suggestedBy, name: asked.names[0] })
        : t("notifications.wait.joinRequest", { count: 1, name: asked.names[0] });
  return { text, faces: asked.names.slice(0, 2) };
}

/**
 * A row standing for several agents that failed for one cause close together: "15 agents couldn't go on: the Claude
 * account was disconnected" over who they are ("Ada, Atlas and 13 more"). Null for any other row.
 */
export function runFailedLines(
  t: TFunction,
  n: Pick<AppNotification, "kind" | "latest">,
  agentName: (id: string) => string,
): { title: string; sub: string } | null {
  const group = runFailedGroupOf(n);
  if (!group) return null;
  const tt = t as unknown as (key: string, options?: Record<string, unknown>) => string;
  const title = group.cause
    ? tt("notifications.what.runFailedMany", { count: group.agents, cause: tt(group.cause.key, group.cause.values) })
    : tt("notifications.what.runFailedManyAny", { count: group.agents });
  const names = [...new Set(group.failures.map((f) => agentName(f.agentId)))];
  return { title: title.replace(/<\/?b>/g, ""), sub: namesText(t, names, 2, group.agents) };
}

/** The next real thing coming: the soonest run of an active routine, still ahead. */
export const nextRoutine = <T extends Pick<Routine, "active" | "nextRunAt">>(
  routines: readonly T[],
  now = Date.now(),
) => upcomingRoutines(routines, now, 1)[0] ?? null;

/** How "when" is said for the next event: today, tomorrow, or a later day. */
export function upcomingDay(iso: string, now = new Date()): "today" | "tomorrow" | "later" {
  const days = -daysAgo(iso, now);
  if (days <= 0) return "today";
  return days === 1 ? "tomorrow" : "later";
}

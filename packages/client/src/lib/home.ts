import type { AppNotification, Routine, StartChoice } from "../api/types";
import { isVisible, sortWaiting } from "./notifications";
import { can } from "./permissions";

/**
 * Início (ADR 0108): what opens when the app starts and the home's sections. Pure:
 * the web's Início and the phone's start draw them.
 */

export type StartPlace = { kind: "home" } | { kind: "channel"; channelId: string } | { kind: "last"; place: string };

/**
 * Where opening a workspace lands: the chosen channel while the person is in it, the place this device kept
 * (`last`, already checked by the app), else the home. An older server sends no choice: the home.
 */
export function startPlace(
  choice: StartChoice | undefined,
  { last, inChannel }: { last: string | null; inChannel: (channelId: string) => boolean },
): StartPlace {
  if (choice?.page === "channel" && choice.channelId && inChannel(choice.channelId))
    return { kind: "channel", channelId: choice.channelId };
  if (choice?.page === "last" && last) return { kind: "last", place: last };
  return { kind: "home" };
}

/** How many rows a section of Início shows before "Ver tudo". */
export const HOME_ROWS = 5;
/** How long something an agent finished stays news on Início. */
export const DONE_MS = 7 * 86_400_000;

const DONE_KINDS: ReadonlySet<string> = new Set(["mission_finished", "routine_finished", "agent_reply"]);

const isDone = (n: AppNotification) =>
  DONE_KINDS.has(n.kind) || (n.kind === "issue_status" && n.latest.statusTo === "done");

/** "Esperando você", from the inbox: what still waits on me (not done, not snoozed), in the inbox's order. */
export const homeWaiting = (items: AppNotification[], now = Date.now()) =>
  sortWaiting(items.filter((n) => n.waiting && isVisible(n, now)));

/**
 * My widgets that stopped updating (ADR 0135): they show in "Waiting on you" with Resolve until their next good
 * update resolves them, though nothing waits on them. Newest first.
 */
export const homeWidgetFailures = (items: AppNotification[], now = Date.now()) =>
  items
    .filter((n) => n.kind === "widget_failed" && isVisible(n, now))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

/** Mentions of me not read yet. */
export const homeMentions = (items: AppNotification[], now = Date.now()) =>
  items.filter((n) => n.kind === "mention" && n.readAt === null && isVisible(n, now));

/**
 * "Desde a sua última visita": what an agent finished that I haven't seen, newest first. Unread is the inbox's own
 * "not seen yet", on any device, so no visit time is kept.
 */
export const homeDone = (items: AppNotification[], now = Date.now()) =>
  items
    .filter(
      (n) => isDone(n) && n.readAt === null && isVisible(n, now) && now - new Date(n.updatedAt).getTime() <= DONE_MS,
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

/**
 * The next runs of active scheduled routines, soonest first. A widget's own routine (ADR 0135) is left out: it redoes
 * its widget in place, and one every 30 minutes would fill the list.
 */
export function upcomingRoutines<T extends Pick<Routine, "active" | "nextRunAt"> & { target?: Routine["target"] }>(
  routines: readonly T[],
  now = Date.now(),
  max = 3,
): T[] {
  const at = (r: T) => new Date(r.nextRunAt ?? "").getTime();
  return routines
    .filter((r) => r.active && r.target?.type !== "widget" && at(r) > now)
    .sort((a, b) => at(a) - at(b))
    .slice(0, max);
}

/** What this person may do of a new workspace's setup, from this membership and the agents they own. */
export const stepPermissions = (
  org: { permissions?: readonly string[] } | null | undefined,
  meId: string | null | undefined,
  agents: readonly { ownerUserId: string | null }[],
) => ({
  createAgents: can(org, "create_agents"),
  connectAi: can(org, "manage_credentials") || (meId != null && agents.some((a) => a.ownerUserId === meId)),
  talk: can(org, "talk_to_agents"),
  invite: can(org, "invite_people"),
  routines: can(org, "manage_routines"),
  pay: can(org, "manage_billing"),
});

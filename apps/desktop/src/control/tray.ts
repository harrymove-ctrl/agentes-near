import type { ControlJob, ControlStatus } from "@agenteschat/adapters/runner-control";
import { browserBadgeOf } from "./browser";

/**
 * The menu bar icon's states (one template image each, src-tauri/icons/tray). `browsing`: a ring
 * on the symbol while an agent is in its browser; `needs`: a filled dot when one needs a person.
 */
export type TrayState = "idle" | "working" | "paused" | "offline" | "update" | "browsing" | "needs";

export interface TrayInput {
  running: boolean;
  status?: ControlStatus | null;
  jobs: readonly ControlJob[];
}

/** A home that is signed in to an organization (unpaired homes are a sign-in in progress). */
export const isPaired = (h: TrayInput) => h.status?.paired === true;

/** Connected and listening for work. */
export const isOnline = (h: TrayInput) => h.running && h.status?.connection === "online";

/** This Mac's portrait: any organization paused → paused; any online → online. */
export function macStateOf(homes: readonly TrayInput[]): "online" | "paused" | "offline" {
  const paired = homes.filter(isPaired);
  if (paired.some((h) => h.status?.paused.paused)) return "paused";
  return paired.some(isOnline) ? "online" : "offline";
}

/**
 * One icon for the whole computer: an agent needs a person in its browser → needs (the dot wins,
 * even paused); any organization paused → paused; an agent in its browser → browsing; anything
 * running → working; every organization offline → offline; a newer app → update; else idle.
 */
export function trayStateOf(homes: readonly TrayInput[], updateAvailable: boolean): TrayState {
  const paired = homes.filter(isPaired);
  const badge = browserBadgeOf(paired.filter((h) => h.running).map((h) => h.status));
  if (badge === "needs") return "needs";
  if (paired.some((h) => h.status?.paused.paused)) return "paused";
  if (badge === "browsing") return "browsing";
  if (paired.some((h) => h.jobs.length > 0)) return "working";
  if (paired.length > 0 && paired.every((h) => !isOnline(h))) return "offline";
  if (updateAvailable) return "update";
  return "idle";
}

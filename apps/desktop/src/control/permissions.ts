/**
 * The macOS permissions agents need on this computer (ADR 0165 "Prepare this Mac"): Screen Recording, for the
 * screenshots their commands take, Full Disk Access, so no folder prompt stops them mid-task, and Local Network, for
 * Android phones over Wi-Fi. The app asks for them and its runners inherit them. macOS says whether the screen and the
 * disk are allowed without asking. Full Disk Access has no prompt: people turn the app on in System Settings. Local
 * Network has no state at all, only whether the app asked. An ad-hoc signed app loses every grant when it updates.
 */
import type { Host } from "../host/types";

export const MAC_PERMISSIONS = ["screen", "disk", "network"] as const;
export type MacPermission = (typeof MAC_PERMISSIONS)[number];

/**
 * `ask`: not asked in this version yet; `off`: asked and not allowed (the way out is System Settings); `asked`: asked,
 * and macOS never says the answer (Local Network); `none`: not a permission on this macOS (Local Network before 15).
 */
export type Grant = "on" | "off" | "ask" | "asked" | "none";
export type Grants = Record<MacPermission, Grant>;

/** The permissions asked for in a version of the app. */
export const MAC_ASKED_PREF = "macAsked";
export interface Asked {
  version: string;
  asked: MacPermission[];
}

export const askedIn = (saved: Asked | null, version: string): MacPermission[] =>
  saved?.version === version ? saved.asked : [];

export const withAsked = (saved: Asked | null, version: string, p: MacPermission): Asked => {
  const asked = askedIn(saved, version);
  return { version, asked: asked.includes(p) ? asked : [...asked, p] };
};

/** Local Network is a permission from macOS 15 on (`system`: macOS's version). Unread, the row stays. */
export const hasLocalNetwork = (system?: string | null) => !system || Number.parseInt(system, 10) >= 15;

/** Each permission's state, without raising a prompt. `localNetwork`: whether this macOS has that permission. */
export async function readGrants(host: Host, asked: readonly MacPermission[], localNetwork = true): Promise<Grants> {
  const [screen, disk] = await Promise.all([host.screenAccess(), host.diskAccess()]);
  const state = (p: MacPermission, on: boolean): Grant => (on ? "on" : asked.includes(p) ? "off" : "ask");
  return {
    screen: state("screen", screen),
    disk: state("disk", disk),
    network: !localNetwork ? "none" : asked.includes("network") ? "asked" : "ask",
  };
}

/** Nothing left to ask: each permission on, asked where macOS keeps the answer, or not one on this macOS. */
export const allDone = (grants: Grants) =>
  MAC_PERMISSIONS.every((p) => grants[p] === "on" || grants[p] === "asked" || grants[p] === "none");

/** Its button opens System Settings: Full Disk Access always (no prompt asks for it), the others once asked. */
export const viaSettings = (p: MacPermission, grant: Grant) => p === "disk" || grant === "off" || grant === "asked";

/**
 * A setup macOS may quit the app in the middle of (the "Quit & Reopen" after Screen Recording or Full Disk Access),
 * kept in the app's data folder (`prepare.rs`) so the app reopens it: the pairing window's Prepare step for `org`, or
 * Preferences. `resumed`: the app reopened it at launch.
 */
export type SetupState = ({ step: "prepare"; org: string; server: string } | { step: "prefs" }) & {
  resumed?: boolean;
};

/** The site's This computer paired it: the welcome window takes this once and shows the Prepare step. */
export const PREPARE_PREF = "prepare";

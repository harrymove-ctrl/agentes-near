/**
 * The server here ("Run agentes.chat on this computer") as the windows see it: `local_server.rs` keeps it and
 * says how it is; this decides what each window shows (the first run's steps and screens, the popover's
 * banners, the cover's line, Preferences' words). Pure, so it is tested without the app.
 */

import { CLOUD_SERVER } from "@agenteschat/client/lib/server";
import type { Platform } from "./platform";

/** `restarting`: it stopped by itself and starts again in a moment (nobody has to start it). */
export type LocalPhase = "off" | "starting" | "updating" | "running" | "stopped" | "restarting" | "failing";

export interface LocalServerStatus {
  /** This build carries the server (Mac and Linux builds do). */
  bundled: boolean;
  /** What `~/.agentes` holds: the app's own server, or one installed from the terminal. */
  installed: "none" | "app" | "terminal";
  /** The app runs it (it starts with the app). */
  run: boolean;
  /** Its owner's account exists. */
  owner: boolean;
  phase: LocalPhase;
  /** Its loopback address. */
  url: string | null;
  /** Its address for people: the Tailscale one with reach on. */
  publicUrl: string | null;
  reach: boolean;
  /** Usage statistics on (`TELEMETRY`). */
  usage: boolean;
  version: string | null;
  dir: string;
  /** The person's name on this computer (the welcome window only). */
  systemName: string | null;
  /** A terminal install's server runs now (the welcome window only). */
  serving: boolean;
  /** A terminal install still waiting for its owner, and running: its claim (the welcome window only). */
  claim: string | null;
  /** An update didn't start and it went back to this version. */
  backTo: string | null;
  /** Stopped by the person to stay stopped: it doesn't start with the app until Start, or until `heldUntil`. */
  held: boolean;
  /** When a stop for a while ends and it starts again by itself (milliseconds since 1970); null: until Start. */
  heldUntil: number | null;
  /** Reach is on, but Tailscale isn't connected on this computer: nobody else reaches it now. */
  tailnetDown: boolean;
  backups: LocalBackups;
  /** This Mac doesn't sleep while it runs (`caffeinate`). */
  awake: boolean;
}

export interface LocalBackups {
  /** "Back up every night" (at 3:00, local time). */
  nightly: boolean;
  /** "Copy to": each new backup is copied to this folder too. */
  copyTo: string | null;
  /** Its backups, newest first; `at` in milliseconds since 1970. */
  files: { path: string; at: number }[];
  /** The last backup didn't finish, or didn't reach the "Copy to" folder. */
  problem: "backup" | "copy" | null;
}

/** What keeps the server here up after a restart or a power cut; null where the app can't tell (not a Mac, a laptop). */
export interface KeepRunning {
  autoLogin: boolean | null;
  autoRestart: boolean | null;
}

/** `app`: Tailscale's Mac app is there to open, not only its command-line tool (Homebrew's). */
export type Tailnet = { state: "missing" } | { state: "off"; app: boolean } | { state: "on"; device: string };
/**
 * Where Tailscale gets connected on this system: its app, which the app opens (a Mac with that app), its icon by the
 * clock (Windows: tailscale.com/kb/1022/install-windows), or `sudo tailscale up` in the terminal (Linux, and a Mac
 * with only the command-line tool). `tailnet` not read yet: a Mac's app.
 */
export function tailscaleFrom(platform: Platform, tailnet: Tailnet | null): "app" | "tray" | "terminal" {
  if (platform === "windows") return "tray";
  if (platform === "linux") return "terminal";
  return tailnet?.state === "off" && !tailnet.app ? "terminal" : "app";
}
const COVER_TAILNET = { app: "openTailscale", tray: "tailnetTray", terminal: "tailnetUp" } as const;
/** After the cover's "Connect Tailscale on this {{device}}…": the Open Tailscale button, or how it connects. */
export const coverTailnet = (platform: Platform, tailnet: Tailnet | null) =>
  COVER_TAILNET[tailscaleFrom(platform, tailnet)];
/**
 * Why reach didn't turn on: HTTPS off in the tailnet, Tailscale's permission (Linux), Tailscale missing or refusing,
 * Tailscale installed but not connected here (`app`: its Mac app is there to open), the person stopped waiting for
 * HTTPS, or the server didn't answer again at its new address. `back`: turning it off, the server didn't answer again
 * at this computer's own address.
 */
export type ServeProblem =
  | { reason: "https"; url: string | null }
  | { reason: "operator" }
  | { reason: "serve" }
  | { reason: "notConnected"; app: boolean }
  | { reason: "stopped" }
  | { reason: "start" }
  | { reason: "back" };
/**
 * What turning reach on or off is doing now (`local-server://reach`): Tailscale sharing it, Tailscale waiting for
 * HTTPS to be allowed at `url`, the server starting again at its new address, the window signing in there.
 */
export type ReachStage = { stage: "sharing" | "restarting" | "signingIn" } | { stage: "approve"; url: string };
export type ReachResult = { ok: true; url: string } | { ok: false; problem: ServeProblem };

export interface LocalChoice {
  name?: string;
  email?: string;
  reach: boolean;
  usage: boolean;
}

export type SetupStep = "database" | "start" | "account" | "computer" | "reach";
export type StepState = "todo" | "active" | "done" | "failed" | "warn";
export interface StepChange {
  step: SetupStep;
  state: Exclude<StepState, "todo">;
  reason?: ServeProblem;
}

/** Nothing set up yet, not running: how the windows start before the app answers. */
export const NO_SERVER: LocalServerStatus = {
  bundled: false,
  installed: "none",
  run: false,
  owner: false,
  phase: "off",
  url: null,
  publicUrl: null,
  reach: false,
  usage: true,
  version: null,
  dir: "~/.agentes",
  systemName: null,
  serving: false,
  claim: null,
  backTo: null,
  held: false,
  heldUntil: null,
  tailnetDown: false,
  backups: { nightly: true, copyTo: null, files: [], problem: null },
  awake: false,
};

/** "Setting it up", in order; access from other devices only when it was asked for. */
export const setupSteps = (reach: boolean): SetupStep[] => [
  "database",
  "start",
  "account",
  "computer",
  ...(reach ? (["reach"] as const) : []),
];

/** Each step's state from the changes that arrived; a step not heard of yet is still to do. */
export function stepStates(steps: readonly SetupStep[], changes: readonly StepChange[]): Record<SetupStep, StepState> {
  const out = Object.fromEntries(steps.map((s) => [s, "todo"])) as Record<SetupStep, StepState>;
  for (const c of changes) if (c.step in out) out[c.step] = c.state;
  return out;
}

/**
 * A setup normally ends in under 30 s, so a step under way shows its time from 10 s, and from 30 s it is "taking a
 * little longer than expected". The server here updating says "This can take a minute": it is slow only after two.
 */
export const STEP_TIME_MS = 10_000;
export const STEP_SLOW_MS = 30_000;
export const UPDATE_SLOW_MS = 120_000;
export const stepClock = (ms: number, slowAfter = STEP_SLOW_MS) => ({
  time: ms >= STEP_TIME_MS,
  slow: ms >= slowAfter,
});

/** Where a setup that ended in an error stops: the failed step, else the one under way, else the first not done. */
export function failedStep(steps: readonly SetupStep[], states: Record<SetupStep, StepState>): SetupStep {
  return (
    steps.find((s) => states[s] === "failed") ??
    steps.find((s) => states[s] === "active") ??
    steps.find((s) => states[s] !== "done" && states[s] !== "warn") ??
    (steps[steps.length - 1] as SetupStep)
  );
}

/** What a failed step says (`computer` and `reach` never fail on their own: the general line if they ever do). */
export const FAIL_TEXT: Record<SetupStep, string> = {
  database: "desktop.here.fail.database",
  start: "desktop.here.fail.start",
  account: "desktop.here.fail.account",
  computer: "desktop.common.error",
  reach: "desktop.common.error",
};

/** What "Run agentes.chat on this computer" shows. */
export type HereView =
  /** The form; `ask`: the owner's name and email (no owner yet). */
  | { kind: "form"; ask: boolean }
  /** The app runs it already: open it. */
  | { kind: "running"; server: string }
  /** One already runs on this computer, installed from the terminal: use it (its owner page while it waits). */
  | { kind: "already"; server: string; claim: string | null }
  /** One is installed from the terminal but isn't running: it starts there (the app never runs it). */
  | { kind: "stopped" };

/**
 * `answering`: an agentes.chat server that answered on this computer's loopback (Connect's discovery), when the
 * app doesn't run one itself.
 */
export function hereView(status: LocalServerStatus, answering: string | null): HereView {
  if (status.run) return { kind: "running", server: status.publicUrl ?? status.url ?? "" };
  if (status.installed === "terminal")
    return status.serving && status.url
      ? { kind: "already", server: status.url, claim: status.claim }
      : { kind: "stopped" };
  if (status.installed !== "app" && answering) return { kind: "already", server: answering, claim: null };
  return { kind: "form", ask: !(status.installed === "app" && status.owner) };
}

/** Why reach didn't turn on, in `desktop.here.reason.*`'s words. */
export const REASON_TEXT: Record<ServeProblem["reason"], string> = {
  https: "desktop.here.reason.https",
  operator: "desktop.here.reason.operator",
  serve: "desktop.here.reason.serve",
  notConnected: "desktop.here.reason.notConnected",
  stopped: "desktop.here.reason.stopped",
  start: "desktop.here.reason.start",
  back: "desktop.here.reason.back",
};

/** The server here in a few words: "Running · only on this Mac", "Starting", … */
export function hereLine(status: LocalServerStatus): string {
  switch (status.phase) {
    case "running":
      if (!status.reach) return "desktop.server.onlyHere";
      return status.tailnetDown ? "desktop.server.tailnetDown" : "desktop.server.onTailnet";
    case "starting":
      return "desktop.server.starting";
    case "restarting":
      return "desktop.server.restarting";
    case "updating":
      return "desktop.server.updating";
    case "failing":
      return "desktop.server.failing";
    default:
      return "desktop.server.stopped";
  }
}

/** The popover's banner about the server here: stopped (Start it), not starting (Copy details), or an update that went back. */
export function hereBanner(status: LocalServerStatus): "stopped" | "failing" | "back" | null {
  if (!status.run) return null;
  if (status.phase === "failing") return "failing";
  if (status.phase === "stopped") return "stopped";
  return status.backTo ? "back" : null;
}

/**
 * Where the server here keeps uploaded files: `files` in its folder (`FILES_DIR`, apps/server native.ts), written
 * with the folder's own separator (`C:\Users\ana\.agentes` on Windows).
 */
export const filesFolder = (dir: string) => `${dir}${dir.includes("\\") ? "\\" : "/"}files`;

/** Whether `server` is the server here, at either of its addresses. */
export const isHereServer = (status: LocalServerStatus, server: string | null) =>
  status.run && !!server && (server === status.url || server === status.publicUrl);

/** Where a workspace's server runs: on this computer, on agentes.chat's Cloud, or elsewhere. */
export const serverPlace = (status: LocalServerStatus, server: string | null): "here" | "cloud" | "other" =>
  isHereServer(status, server) ? "here" : server === CLOUD_SERVER ? "cloud" : "other";

/**
 * The main window's cover over the server here: starting, updating, stopped, not starting, or running at its
 * Tailscale address while Tailscale isn't connected on this computer (`reachable`: that address answered).
 */
export function coverHere(
  status: LocalServerStatus,
  current: string | null,
  reachable: boolean,
): "starting" | "migrating" | "stopped" | "failing" | "tailnetOff" | null {
  if (!isHereServer(status, current)) return null;
  // Starting again by itself: the same wait as a start, never "stopped".
  if (status.phase === "starting" || status.phase === "restarting") return "starting";
  if (status.phase === "updating") return "migrating";
  if (status.phase === "failing") return "failing";
  if (status.phase !== "running") return "stopped";
  return status.reach && current === status.publicUrl && !reachable ? "tailnetOff" : null;
}

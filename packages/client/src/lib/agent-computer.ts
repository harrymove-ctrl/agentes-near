import type { TFunction } from "i18next";
import type { BrowserHandoff, BrowserUnavailableReason, DesktopStatus, Edition, Machine } from "../api/types";
import { handoffTimeLeft, isWaitingHandoff } from "../browser";
import { drivesOnDesktop } from "../desktop";
import {
  type EtaView,
  etaLine,
  type SetupView,
  setupEta,
  setupPending,
  setupPortrait,
  WORKSPACE_COMPUTER_KIND,
} from "./computer";
import { clockAt, lowerFirst } from "./format";
import { agentGrammar } from "./grammar";
import { type ComputerKind, type ComputerState, computerKind, isPaused } from "./machines";
import { endSentence } from "./text";

/*
 * The agent's computer as one entry and one dialog, on the web and the phone: what its status line says
 * and what the dialog's stage shows, from what the apps already know of the agent.
 */

/** What the entry and the dialog read of an agent's computer. */
export interface AgentComputerFacts {
  edition: Edition;
  /** The agent is held, or the workspace is on hold. */
  held: boolean;
  /** The workspace's own computer (the Cloud's), else null. */
  setup: SetupView | null;
  /** The computer the agent works on, from the computers list; null: none. */
  machine: Pick<Machine, "name" | "online" | "standby" | "lastSeenAt" | "paused" | "desktopUse"> | null;
  /** Its screen as `GET …/desktop` says it; null while unknown. */
  desktop:
    | (Pick<DesktopStatus, "available" | "reason"> & Partial<Pick<DesktopStatus, "canControl" | "handoff">>)
    | null;
  /** Its browser can run on its computer now. */
  browser: boolean;
  /** Why its browser can't, when it can't (`GET …/browser`); absent while unknown. */
  browserReason?: BrowserUnavailableReason | null;
  /** The agent may use its browser (`browser:use`). */
  browserGranted: boolean;
  /** Its open request or take over, on either screen. */
  handoff: BrowserHandoff | null;
  /** Who is looking. */
  userId: string;
  /** A run of the agent works on its computer now. */
  working: boolean;
}

/** The entry's status line, first match wins (the order the dialog's covers follow too). */
export type EntryState =
  | { kind: "held" }
  | { kind: "preparing"; eta: EtaView | null }
  | { kind: "waiting" }
  | { kind: "problem" }
  | { kind: "offline" }
  | { kind: "paused"; until: string | null }
  | { kind: "needsYou"; handoff: BrowserHandoff }
  | { kind: "needsOther"; handoff: BrowserHandoff; userId: string }
  | { kind: "you" }
  | { kind: "other"; userId: string }
  | { kind: "working" }
  | { kind: "unavailable"; cause: CantShow }
  | { kind: "noScreen" }
  /** `noScreen` on a computer with no screens for agents (a Mac, a PC): only its browser could show there. */
  | { kind: "noBrowser" }
  | { kind: "noComputer" }
  | { kind: "available" };

/** Why nothing of the agent's computer can be shown (`unavailable`): what its line says, and its cover. */
export type CantShow =
  /** The program on its computer is too old to show it. */
  | "outdated"
  /** Screens are turned off on its computer. */
  | "screensOff"
  /** Its computer can't show screens yet: something to install there (`DesktopStatus.detail`). */
  | "screensMissing"
  /** Only its browser could show here, and that is turned off on its computer. */
  | "browserOff"
  /** The Cloud's computer is ready and gives itself to the agent at its next hello. */
  | "joining"
  /** Nothing says why: the screen's state didn't load, or a reason this app doesn't know. */
  | "unknown";

/**
 * The cause, from the screen's reason (`GET …/desktop`) and, where only the agent's browser could show (it uses no
 * screen, this person may see only its browser, or its computer has no screens for agents), the browser's.
 */
export function cantShow(f: AgentComputerFacts): CantShow {
  if (!f.machine && f.edition === "cloud") return "joining";
  const reason = f.desktop?.reason;
  const browserOnly =
    reason === "no_desktop" || reason === "browser_only" || f.machine?.desktopUse?.available === false;
  if (browserOnly && f.browserReason === "switched_off") return "browserOff";
  if (reason === "runner_outdated" || (browserOnly && f.browserReason === "outdated")) return "outdated";
  if (browserOnly) return "unknown";
  if (reason === "not_allowed") return "screensOff";
  return reason === "desktop_unavailable" ? "screensMissing" : "unknown";
}

/** The workspace's own computer isn't ready, and the agent has none yet: it waits for that one. */
const waitsForWorkspace = (f: Pick<AgentComputerFacts, "edition" | "setup" | "machine">) =>
  f.edition === "cloud" && f.machine === null && setupPending(f.setup);

/** A request waits for this person: it went to them, or to nobody in particular. */
export const asksMe = (h: BrowserHandoff, userId: string) =>
  h.requestedForUserId === null || h.requestedForUserId === userId;

/**
 * The entry's state. A hold wins over everything: a workspace on hold isn't listed to its provisioner, so a
 * countdown would freeze, then read late. Then the wait, the computer's own trouble, the people on it, the
 * agent at work, and why nothing can be shown. Asleep in standby (ADR 0161) is no trouble: it shows nothing until
 * it wakes, and reads as available.
 */
export function entryState(f: AgentComputerFacts, nowMs = Date.now()): EntryState {
  if (f.held) return { kind: "held" };
  if (waitsForWorkspace(f) && f.setup) {
    if (f.setup.phase === "waiting") return { kind: "waiting" };
    if (f.setup.phase === "problem") return { kind: "problem" };
    return { kind: "preparing", eta: setupEta(f.setup, nowMs) };
  }
  const asleep = f.machine !== null && !f.machine.online && f.machine.standby === true;
  if (f.machine && !f.machine.online && !asleep) return { kind: "offline" };
  if (f.edition === "selfhost" && f.machine && isPaused(f.machine, nowMs)) {
    return { kind: "paused", until: f.machine.paused?.until ?? null };
  }
  const h = f.handoff;
  if (h && isWaitingHandoff(h, nowMs)) {
    return asksMe(h, f.userId)
      ? { kind: "needsYou", handoff: h }
      : { kind: "needsOther", handoff: h, userId: h.requestedForUserId ?? "" };
  }
  if (h?.status === "active" && h.controllerUserId) {
    return h.controllerUserId === f.userId ? { kind: "you" } : { kind: "other", userId: h.controllerUserId };
  }
  if (f.working) return { kind: "working" };
  const neither = f.desktop?.reason === "no_desktop" && !f.browserGranted;
  const shown = f.desktop?.available === true || f.browser;
  if (!shown && !neither && !asleep && (f.machine || f.edition === "cloud")) {
    return { kind: "unavailable", cause: cantShow(f) };
  }
  if (neither) {
    const screens = f.edition === "cloud" || f.machine?.desktopUse?.available !== false;
    return { kind: screens ? "noScreen" : "noBrowser" };
  }
  if (!f.machine && f.edition === "selfhost") return { kind: "noComputer" };
  return { kind: "available" };
}

/** The entry's one button: Help on a request for this person, a picker for an agent with no computer. */
export const entryButton = (s: EntryState): "help" | "choose" | "open" =>
  s.kind === "needsYou" ? "help" : s.kind === "noComputer" ? "choose" : "open";

/** The entry's portrait: the workspace's computer drawn as a server, a connected one by its system. */
export const entryKind = (edition: Edition, machine: Pick<Machine, "kind" | "os"> | null): ComputerKind =>
  edition === "cloud" || machine?.kind === "managed" ? WORKSPACE_COMPUTER_KIND : computerKind(machine?.os);

/** The portrait's light: dimmed while it is prepared, dark when it doesn't answer, paused while held or paused. */
export function entryPortrait(s: EntryState, setup: SetupView | null): ComputerState {
  if (s.kind === "preparing" || s.kind === "waiting" || s.kind === "problem") {
    return setup ? setupPortrait(setup, false) : "paused";
  }
  if (s.kind === "offline") return "offline";
  return s.kind === "paused" || s.kind === "held" ? "paused" : "online";
}

/** What the entry's words need from the platform. */
export interface EntryWords {
  edition: Edition;
  locale: string;
  /** The agent's computer's name (its pause and its update say it). */
  computer: string;
  /** When its computer was last seen (the offline line's time). */
  lastSeenAt: string | null;
  /** A person's name by id (whom a request went to, who is in control). */
  person: (userId: string) => string;
  /** The agent's latest step in words, when this device hears its run. */
  step: string | null;
  /** "We'll email you": only owners hear it, and only when the email is promised (`promisesEmail`). */
  emailPromised: boolean;
  now?: Date;
}

/** "Sign in to gov.br · 4 min": the request and the time it has left. */
export function askLine(t: TFunction, h: BrowserHandoff, nowMs = Date.now()) {
  const left = handoffTimeLeft(t, h, nowMs);
  return left === null ? h.instructions : `${h.instructions} · ${left}`;
}

/** The entry's status line in the person's words (`agentComputer.status.*`). */
export function entryLine(t: TFunction, s: EntryState, w: EntryWords): string {
  const now = w.now ?? new Date();
  switch (s.kind) {
    case "held":
      return t("agentComputer.status.held");
    case "preparing":
      return s.eta
        ? `${t("agentComputer.status.preparingPlain")} · ${lowerFirst(etaLine(t, s.eta), w.locale)}`
        : t("agentComputer.status.preparingPlain");
    case "waiting":
      return w.emailPromised
        ? `${endSentence(t("computerSetup.status.capacity"))} ${t("computerSetup.email.short")}`
        : t("computerSetup.status.capacity");
    case "problem":
      return t("agentComputer.status.problem");
    case "offline":
      if (w.edition === "cloud") return t("agentComputer.status.notAnswering");
      return w.lastSeenAt
        ? t("agentComputer.status.offline", { time: clockAt(w.locale, w.lastSeenAt, now) })
        : t("machines.offline");
    case "paused":
      return s.until
        ? t("agentComputer.status.paused", { computer: w.computer, time: clockAt(w.locale, s.until, now) })
        : t("agentComputer.status.pausedPlain", { computer: w.computer });
    case "needsYou":
      return t("agentComputer.status.needsYou", { ask: askLine(t, s.handoff, now.getTime()) });
    case "needsOther":
      return t("agentComputer.status.needsOther", {
        person: w.person(s.userId),
        ask: askLine(t, s.handoff, now.getTime()),
      });
    case "you":
      return t("agentComputer.status.you");
    case "other":
      return t("agentComputer.status.other", { person: w.person(s.userId) });
    case "working":
      return w.step
        ? t("agentComputer.status.working", { now: lowerFirst(w.step, w.locale) })
        : t("agentComputer.status.workingPlain");
    case "unavailable":
      return cantShowLine(t, s.cause, w) ?? t("agentComputer.status.unavailable");
    case "noScreen":
      return t("agentComputer.status.noScreen");
    case "noBrowser":
      return t("agentComputer.status.noBrowser");
    case "noComputer":
      return t("agentComputer.status.noComputer");
    default:
      return t("agentComputer.status.available");
  }
}

/**
 * Why nothing shows, in the entry's words (`agentComputer.status.*`): the cause, which the entry's button opens the way
 * out of; null when nothing says why. The Cloud's program is updated by itself; a self-hoster updates theirs. Screens
 * and the browser are switched at a self-hoster's own computer: the Cloud's has them on, so it never says they're off.
 */
export function cantShowLine(
  t: TFunction,
  cause: CantShow,
  w: Pick<EntryWords, "edition" | "computer">,
): string | null {
  const computer = { computer: w.computer };
  const own = w.edition === "selfhost";
  switch (cause) {
    case "outdated":
      return own ? t("agentComputer.status.outdated", computer) : t("agentComputer.status.updating");
    case "screensOff":
      return own ? t("agentComputer.status.screensOff", computer) : null;
    case "screensMissing":
      return t("agentComputer.status.screensMissing", computer);
    case "browserOff":
      return own ? t("agentComputer.status.browserOff", computer) : null;
    case "joining":
      return t("agentComputer.status.preparingPlain");
    default:
      return null;
  }
}

/** A picture of the screen is never live: "Agora há pouco" while it is under a minute old, then its time. */
export const pictureWhen = (t: TFunction, locale: string, capturedAt: string, now: Date) =>
  now.getTime() - Date.parse(capturedAt) < 60_000 ? t("agentComputer.pictureNow") : clockAt(locale, capturedAt, now);

/**
 * The dialog's sub-line while its stage is live (`agentComputer.sub.*`, `desktop.sub.*`): who holds the computer, then
 * the agent at work. The hold, the pause and a request waiting each have a banner over the stage that says them, so
 * the line says "Ao vivo" alone.
 */
export function liveSubLine(
  t: TFunction,
  f: AgentComputerFacts,
  w: Pick<EntryWords, "person"> & { name: string; nowMs?: number },
): string {
  const nowMs = w.nowMs ?? Date.now();
  const g = agentGrammar(w.name);
  const h = f.handoff;
  if (h?.status === "active" && h.controllerUserId) {
    if (h.controllerUserId !== f.userId) return t("desktop.sub.hidden", { person: w.person(h.controllerUserId) });
    return t(h.kind === "ask" ? "desktop.sub.controlAsked" : "desktop.sub.control", g);
  }
  const paused = f.edition === "selfhost" && f.machine !== null && isPaused(f.machine, nowMs);
  if (f.held || paused || (h && isWaitingHandoff(h, nowMs))) return t("browser.watch.live");
  return f.working ? t("agentComputer.sub.working", g) : t("agentComputer.sub.watching");
}

/** What the dialog's stage shows (checked in this order). */
export type ComputerSurface =
  /** Held while the workspace's computer isn't ready: the pause alone, no countdown. */
  | "held"
  /** The workspace's computer on its way, the agent without one: the progress. */
  | "preparing"
  /** The agent's browser's page: a computer without screens, or this person in its browser. */
  | "page"
  /** The agent's screen, its browser a window on it. */
  | "screen"
  /** Why nothing shows. */
  | "cover";

/**
 * The dialog's stage. A person helping with a browser request gets the page unless they may drive the screen its
 * window is on (`drivesOnDesktop`): then the whole screen, as everyone who may; a computer that serves screens shows
 * the agent's; one without them (a Mac) its browser's page. An offline computer gets its cover: the browser it last
 * reported can't open there now.
 */
export function surfaceOf(f: AgentComputerFacts): ComputerSurface {
  if (f.held && waitsForWorkspace(f)) return "held";
  if (waitsForWorkspace(f)) return "preparing";
  const h = f.handoff;
  if (h?.status === "active" && h.controllerUserId === f.userId && !drivesOnDesktop(h, f.desktop)) return "page";
  if (f.machine && !f.machine.online) return "cover";
  if (f.desktop?.available) return "screen";
  if (f.browser) return "page";
  return "cover";
}

import {
  type AgentComputerFacts,
  type EntryState,
  entryButton,
  surfaceOf,
} from "@agenteschat/client/lib/agent-computer";
import { type EtaView, etaLine, type SetupView, setupNoticeStatusKey } from "@agenteschat/client/lib/computer";
import { endSentence } from "@agenteschat/client/lib/text";
import type { TFunction } from "i18next";

/*
 * The agent's computer on the phone: the web's entry, states and words (`@agenteschat/client/lib/agent-computer`,
 * ADR 0065), with what only the phone decides. Pure, so it is unit-tested.
 */

/** What the full-screen view's stage shows. */
export type PhoneStage =
  /** Held while the workspace's computer isn't ready: the pause alone. */
  | "held"
  /** The workspace's computer on its way: the wait. */
  | "preparing"
  /** The agent's screen, live: watch, take control (ADR 0098). */
  | "screen"
  /** The agent's page, live, where its computer serves no screen, or for a person helping in its browser. */
  | "page"
  | "offline"
  /**
   * Cloud: the workspace's computer is ready and gives itself to this agent at its next hello, or wakes from standby
   * (ADR 0161).
   */
  | "joining"
  | "noComputer"
  | "noScreen"
  | "unavailable";

/** The stage, in the web's order (`surfaceOf`), this person in the agent's browser included (the page). */
export function phoneStage(f: AgentComputerFacts): PhoneStage {
  const surface = surfaceOf(f);
  if (surface !== "cover") return surface;
  if (f.machine && !f.machine.online) return f.machine.standby ? "joining" : "offline";
  if (!f.machine) return f.edition === "cloud" ? "joining" : "noComputer";
  return f.desktop?.reason === "no_desktop" && !f.browserGranted ? "noScreen" : "unavailable";
}

/** The entry's one button on the phone: no computer picker (Open says why there is none). */
export const phoneEntryButton = (s: EntryState): "help" | "open" => (entryButton(s) === "help" ? "help" : "open");

/** "Trocar computador" on an offline computer: only on self-host (the Cloud has no other), for who manages it. */
export const offersSwitch = (f: Pick<AgentComputerFacts, "edition">, manages: boolean, hasOutage: boolean) =>
  f.edition === "selfhost" && manages && hasOutage;

/**
 * The wait notice's line under "Preparando o computador da Acme": the time left (`setupEta`), else where it is; in
 * the wait for a computer, "Avisamos por e-mail." after it for those who get the email (`emailed`). Null when it
 * would only say the title again (`setupNoticeStatusKey`).
 */
export function setupNoticeLine(t: TFunction, view: SetupView, eta: EtaView | null, emailed: boolean): string | null {
  if (eta) return etaLine(t, eta);
  const status = setupNoticeStatusKey(view);
  if (!status) return null;
  return view.phase === "waiting" && emailed
    ? `${endSentence(t(status))} ${t("computerSetup.email.short")}`
    : t(status);
}

/** The full screen's header while the workspace's computer is on its way: the chip's word ("Na fila"). */
export const setupSub = (t: TFunction, view: SetupView): string => t(view.chipKey);

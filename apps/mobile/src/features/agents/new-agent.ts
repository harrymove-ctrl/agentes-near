import { lowerFirst } from "@agenteschat/client/lib/format";
import { handleProblem, type RoleId } from "@agenteschat/client/lib/new-agent";

/**
 * "Criar agente" on the phone, the pure part: the web's steps that fit a thumb (where it works, its
 * model and budget start at the workspace's defaults and change on its page), and what keeps each one
 * from going on (the same rules as the web's `stepErrors`).
 */

export const NEW_AGENT_PHONE_STEPS = ["role", "identity", "instructions", "review"] as const;
export type PhoneStep = (typeof NEW_AGENT_PHONE_STEPS)[number];

export interface PhoneDraft {
  role: RoleId | null;
  name: string;
  handle: string;
  /** Handles already used, by agents or people. */
  taken: Set<string>;
}

/** Whether a step can't go on yet. */
export function stepBlocked(step: PhoneStep, d: PhoneDraft): boolean {
  if (step === "role") return !d.role;
  if (step === "identity") return !d.name.trim() || handleProblem(d.handle, d.taken) !== null;
  return false;
}

/** The first step that can't go on (-1 when it can be created). */
export const firstBlockedStep = (d: PhoneDraft) => NEW_AGENT_PHONE_STEPS.findIndex((s) => stepBlocked(s, d));

/**
 * A preset's line under its name: what it does, then who it starts as ("Codes, reviews PRs and investigates bugs ·
 * starts as Ada"). Each description is a sentence of its own in every language, so its closing stop goes before
 * the "·", and the part after it starts in lower case, unless it starts with the agent's name ("Adaとして開始").
 */
export function roleLine(desc: string, startsAs: string, name: string, locale?: string): string {
  const after = startsAs.startsWith(name) ? startsAs : lowerFirst(startsAs, locale);
  return `${desc.replace(/[.。．]\s*$/u, "")} · ${after}`;
}

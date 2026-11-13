import type { AgentAudience, AgentInput } from "@agenteschat/client";
import {
  AGENT_ACCESSORIES,
  AGENT_COLORS,
  AGENT_EYES,
  type AgentAccessory,
  type AgentColor,
  type AgentEyes,
  colorOf,
} from "../shared/logic";

/**
 * Editing an agent on the phone, the pure part: who may change what (the server's rules, as the web's
 * agent page), the look with "Nenhum" spelled out, and what a save sends.
 */

export interface FullLook {
  color: AgentColor;
  eyes: AgentEyes;
  accessory: AgentAccessory;
}

const pick = <T extends string>(list: readonly T[], v: unknown, fallback: T): T =>
  typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : fallback;

/** An agent's look with every part set ("none" when it wears nothing). */
export function fullLook(appearance: unknown): FullLook {
  const o = (appearance && typeof appearance === "object" ? appearance : {}) as Record<string, unknown>;
  return {
    color: colorOf(o.color) ?? "sky",
    eyes: pick(AGENT_EYES, o.eyes, "round"),
    accessory: pick(AGENT_ACCESSORIES, o.accessory, "none"),
  };
}

export const sameLook = (a: FullLook, b: FullLook) =>
  a.color === b.color && a.eyes === b.eyes && a.accessory === b.accessory;

/** "Sortear": a random look, different from `current`. */
export function shuffleLook(current: FullLook, rand: () => number = Math.random): FullLook {
  const one = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)] as T;
  for (let i = 0; i < 6; i++) {
    const next = { color: one(AGENT_COLORS), eyes: one(AGENT_EYES), accessory: one(AGENT_ACCESSORIES) };
    if (!sameLook(next, current)) return next;
  }
  return { ...current, color: AGENT_COLORS.find((c) => c !== current.color) ?? current.color };
}

export type AgentEditField = "name" | "role" | "instructions" | "look" | "consultable";

/**
 * Who manages agents changes everything here; the agent's own person, its look and whether other agents may consult
 * it (who talks to it is theirs too, as on the web).
 */
export function editableFields(viewer: { admin: boolean; owner: boolean }): Set<AgentEditField> {
  if (viewer.admin) return new Set(["name", "role", "instructions", "look", "consultable"]);
  if (viewer.owner) return new Set(["look", "consultable"]);
  return new Set();
}

export interface AgentDraft {
  name: string;
  /** Its @: the one typed in Menções, else the one the name gives (`handleAfterRename`). */
  handle: string;
  role: string;
  instructions: string;
  look: FullLook;
  /** Who talks to it; here only its `consultable` switch changes (ADR 0085 addendum). */
  audience: AgentAudience;
}

/** What a save sends: only the fields that changed and may be changed; null when there is nothing. */
export function agentChanges(
  saved: AgentDraft,
  draft: AgentDraft,
  fields: ReadonlySet<AgentEditField>,
): Partial<AgentInput> | null {
  const out: Partial<AgentInput> = {};
  const name = draft.name.trim();
  if (fields.has("name") && name && name !== saved.name) out.name = name;
  // Whoever may rename it moves its @ too.
  if (fields.has("name") && draft.handle !== saved.handle) out.handle = draft.handle;
  if (fields.has("role") && draft.role.trim() !== saved.role.trim()) out.role = draft.role.trim();
  if (fields.has("instructions") && draft.instructions !== saved.instructions) out.instructions = draft.instructions;
  if (fields.has("look") && !sameLook(draft.look, saved.look)) out.appearance = { ...draft.look };
  if (fields.has("consultable") && draft.audience.consultable !== saved.audience.consultable)
    out.audience = draft.audience;
  return Object.keys(out).length > 0 ? out : null;
}

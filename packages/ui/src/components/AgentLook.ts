import {
  AGENT_ACCESSORIES,
  AGENT_COLORS,
  AGENT_EYES,
  type AgentAppearance,
  type AgentColor,
} from "@agenteschat/tokens/look";
import type { CSSProperties } from "react";
import { gradientOf } from "../agent/engine.js";

export {
  AGENT_ACCESSORIES,
  AGENT_COLORS,
  AGENT_EYES,
  type AgentAccessory,
  type AgentAppearance,
  type AgentColor,
  type AgentEyes,
  normalizeAppearance,
} from "@agenteschat/tokens/look";

/** A random look ("Aleatório"), different from `current` when possible. */
export function randomAppearance(current: AgentAppearance = {}, rand: () => number = Math.random): AgentAppearance {
  const one = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)] as T;
  for (let i = 0; i < 5; i++) {
    const next = { color: one(AGENT_COLORS), eyes: one(AGENT_EYES), accessory: one(AGENT_ACCESSORIES) };
    if (next.color !== current.color || next.eyes !== current.eyes || next.accessory !== current.accessory) return next;
  }
  return { color: one(AGENT_COLORS), eyes: one(AGENT_EYES), accessory: one(AGENT_ACCESSORIES) };
}

/** Top and bottom of an agent color as fixed hex (sky as on the landing: the same in both themes). For drawing, e.g. the pixel sky. */
export function agentGradient(color: AgentColor = "sky"): [string, string] {
  return gradientOf(color);
}

/** CSS variables for the symbol's color (none for sky: the tokens). */
export function appearanceStyle(a: AgentAppearance | undefined): CSSProperties | undefined {
  if (!a?.color || a.color === "sky") return undefined;
  const [top, bottom] = gradientOf(a.color);
  return { "--av-top": top, "--av-bottom": bottom } as CSSProperties;
}

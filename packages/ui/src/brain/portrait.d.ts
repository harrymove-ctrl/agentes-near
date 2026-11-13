/** Types for portrait.js (plain JavaScript so plain HTML pages can import it as is). */
import type { AccessoryName, AgentColorName, EyeStyle } from "../agent/engine.js";

/** The engines an agent thinks and works with: Claude Code, Codex, or the agent itself (through the API). */
export type BrainPortraitKind = "claude_code" | "codex" | "agent";
/** `off`: not installed, not logged in, or the computer is offline. */
export type BrainPortraitState = "idle" | "working" | "off";

/** The agent's own look, for the small agent beside the tool (or thinking alone). */
export interface BrainAgentLook {
  color?: AgentColorName | string;
  eyes?: EyeStyle | string;
  accessory?: AccessoryName | "none" | string;
}

/** The 2D context subset the portraits draw with. */
export type BrainCtx = Pick<CanvasRenderingContext2D, "fillRect" | "clearRect"> & { fillStyle: unknown };

export const BRAIN_GRID: 48;
export const BRAIN_KINDS: BrainPortraitKind[];
export const BRAIN_STATES: BrainPortraitState[];

export function drawBrain(
  ctx: BrainCtx,
  kind: BrainPortraitKind,
  state: BrainPortraitState,
  options?: { dark?: boolean; t?: number; agentLook?: BrainAgentLook },
): void;

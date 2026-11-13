import { useLayoutEffect, useRef } from "react";
import { addLiveBrain, drawLiveBrain, type LiveBrain } from "../brain/live";
import { BRAIN_GRID, type BrainPortraitKind, type BrainPortraitState } from "../brain/portrait.js";
import { cx } from "../cx";
import { Icon, type IconName } from "../icons/Icon";
import type { AgentAppearance } from "./AgentLook";
import { ProviderLogo } from "./ProviderLogo";

export type { BrainPortraitKind, BrainPortraitState };

export interface BrainPortraitProps {
  kind: BrainPortraitKind;
  state?: BrainPortraitState;
  /** 48 (option cards, list rows; default), 96 or 144: whole-number scales of the grid. */
  size?: 48 | 96 | 144;
  /** The agent's own look, for its small self beside the tool (the default agent without it). */
  agent?: AgentAppearance;
  /** Accessible name. Without it the portrait is decorative (the text next to it names the engine). */
  label?: string;
  className?: string;
}

/**
 * An engine's portrait, from the one
 * portrait engine (brain/portrait.js): Claude Code's warm console or Codex's
 * cool terminal with the agent's small pixel self beside it, using it, or the
 * agent alone, thinking (through the API). Idle, working, or off (not
 * installed, not logged in, computer offline: dark screen, gray). Pixels on a
 * 48×48 grid scaled by whole numbers; no tile. Below 48 px use `BrainIcon`.
 */
export function BrainPortrait({ kind, state = "idle", size = 48, agent, label, className }: BrainPortraitProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const look = useRef({ kind, state, agentLook: agent });
  look.current = { kind, state, agentLook: agent };
  const live = useRef<LiveBrain | null>(null);
  useLayoutEffect(() => {
    const el = canvas.current;
    if (!el) return;
    live.current = { canvas: el, look: () => look.current };
    const stop = addLiveBrain(live.current);
    return () => {
      live.current = null;
      stop();
    };
  }, []);
  // The loop stands still with reduced motion: a change is drawn at once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: redraw when what is drawn changes
  useLayoutEffect(() => {
    if (live.current) drawLiveBrain(live.current);
  }, [kind, state, agent?.color, agent?.eyes, agent?.accessory]);
  return (
    <canvas
      ref={canvas}
      className={cx("ac-brain", state === "off" && "ac-brain--off", className)}
      width={BRAIN_GRID}
      height={BRAIN_GRID}
      style={{ width: size, height: size }}
      data-kind={kind}
      data-state={state}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}

/**
 * A computer brain by its maker's official mark: Claude for Claude Code, OpenAI for Codex, Cursor's cube for Cursor,
 * OpenCode's for OpenCode, Grok's for Grok Build, Gemini's for the Antigravity CLI.
 */
export function BrainLogo({
  kind,
  ...rest
}: {
  kind: "claude_code" | "codex" | "cursor" | "opencode" | "grok" | "antigravity";
  size?: "xs" | "tile" | "sm";
  off?: boolean;
  label?: string;
  className?: string;
}) {
  return <ProviderLogo id={kind} {...rest} />;
}

/** Each engine's line icon in the icon set. */
export const BRAIN_ICONS: Record<BrainPortraitKind, IconName> = {
  claude_code: "brainClaudeCode",
  codex: "brainCodex",
  agent: "brainAgent",
};

/** An engine's line icon for 14–20 px, next to text (chips, pickers, notes): pixels don't read that small. */
export function BrainIcon({
  kind,
  state = "idle",
  size = 16,
  label,
  className,
}: {
  kind: BrainPortraitKind;
  state?: BrainPortraitState;
  size?: 14 | 16 | 18 | 20;
  label?: string;
  className?: string;
}) {
  return (
    <Icon
      name={BRAIN_ICONS[kind]}
      size={size}
      label={label}
      className={cx("ac-brain-icon", state !== "idle" && `ac-brain-icon--${state}`, className)}
    />
  );
}

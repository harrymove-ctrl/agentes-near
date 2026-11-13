import { type HTMLAttributes, useLayoutEffect, useRef } from "react";
import type { Expression } from "../agent/engine.js";
import { addLiveAgent, drawLive, type LiveAgent } from "../agent/live";
import { cx } from "../cx";
import { initialsOf } from "../names";
import { recipeOfUrl } from "../person/engine.js";
import { canDrawPortraits, PersonPortrait } from "../person/PersonPortrait";
import { type AgentAppearance, appearanceStyle } from "./AgentLook";
import { type BadgePresence, PresenceBadge } from "./PresenceBadge";

export type AvatarKind = "person" | "agent";

/**
 * The agent symbol's state: `idle` blinks now and then, `thinking` looks
 * around (with a halo), `writing` has dash eyes (with a halo), `waiting`
 * looks up at you (waiting on a person's decision, no halo). The halo shows
 * only without the tile (`xs`, `xl`): in a tile the moving face says it. `sleeping` has closed eyes and a pixel zz
 * (paused until its plan or budget is back, no halo).
 */
export type AgentState = "idle" | "thinking" | "writing" | "waiting" | "sleeping";

export interface AvatarProps extends HTMLAttributes<HTMLSpanElement> {
  kind?: AvatarKind;
  /** Display name; initials are derived from it unless `initials` is given. */
  name: string;
  initials?: string;
  /** 18 (receipts), 24, 36 (default), 56 or 112px (the customizer preview). */
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  imageUrl?: string | null;
  /** Agent is executing: the halo (same as `state="thinking"` unless `state` says otherwise). */
  running?: boolean;
  /** The living agent symbol's state (agents only). */
  state?: AgentState;
  /** The agent's look: color, eyes and an accessory (agents only). */
  appearance?: AgentAppearance;
  /**
   * The presence badge on the corner (ADR 0084): a person's (online, away, busy, hidden to themselves, offline) or
   * an agent's, from its work. Null or left out: none.
   */
  presence?: BadgePresence | null;
  /** The presence in words, on hover over the badge ("Ocupado"). */
  presenceLabel?: string;
  /** Set when no visible name is next to the avatar: exposes `name` to screen readers. */
  labelled?: boolean;
  /** A held expression (agents only), e.g. "happy" for a moment of joy. */
  expression?: Expression;
  /** Agents only: plays the face started by `playAgentReaction(reactionKey, …)` (a message id). */
  reactionKey?: string;
  /**
   * The tile: a rounded square with a hairline, the
   * agent standing in its own pixel sky. On by default; off for the 18px
   * receipts (`xs`) and the 112px hero (`xl`), where the agent stands on the
   * page's own sky.
   */
  framed?: boolean;
}

/** A steady number per name, so agents next to each other move out of step. */
const seedOf = (name: string) => {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return (Math.abs(h) % 1000) / 100;
};

/**
 * The agent itself, drawn by the agent engine on a canvas a bit larger than
 * the box (accessories reach past the body), in the shared live loop.
 */
function AgentBody({
  appearance,
  state,
  expression,
  name,
  reactionKey,
  framed,
}: {
  appearance: AgentAppearance | undefined;
  state: AgentState;
  expression: Expression | undefined;
  name: string;
  reactionKey?: string;
  framed: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const look = useRef<ReturnType<LiveAgent["look"]>>({ state, seed: 0 });
  look.current = {
    color: appearance?.color,
    eyes: appearance?.eyes,
    accessory: appearance?.accessory && appearance.accessory !== "none" ? appearance.accessory : undefined,
    state,
    expression,
    seed: seedOf(name),
    reactionKey,
    framed,
  };
  const live = useRef<LiveAgent | null>(null);
  useLayoutEffect(() => {
    // The box is the canvas's parent: a parent's ref is not attached yet when a child's layout effect runs.
    const el = canvas.current;
    const host = el?.parentElement;
    if (!el || !host) return;
    live.current = { canvas: el, box: host, look: () => look.current };
    const stop = addLiveAgent(live.current);
    return () => {
      live.current = null;
      stop();
    };
  }, []);
  // The loop stands still with reduced motion: a new look (or face) is drawn at once.
  const { color, eyes, accessory } = look.current;
  // biome-ignore lint/correctness/useExhaustiveDependencies: redraw when what is drawn changes
  useLayoutEffect(() => {
    if (live.current) drawLive(live.current, typeof performance === "object" ? performance.now() / 1000 : 0);
  }, [color, eyes, accessory, state, expression, framed]);
  return <canvas className="ac-avatar__canvas" ref={canvas} />;
}

/**
 * One tile for everyone: a rounded square (radius 30% of the side) with a
 * hairline and a faint top highlight. People show their photo, their pixel
 * portrait or initials in it, with an optional presence badge on the corner. Agents are the living
 * symbol from the agent engine standing in their own pixel sky: the dithered
 * body with the cut corner, white eyes and a pixel accessory, turning its
 * head, blinking and now and then making a face (see `state` and
 * `expression`). Unframed (`xs`, `xl`), the agent stands on its own.
 */
export function Avatar({
  kind = "person",
  name,
  initials,
  size = "md",
  imageUrl,
  running,
  state,
  appearance,
  presence,
  presenceLabel,
  labelled,
  expression,
  reactionKey,
  framed,
  className,
  style,
  ...rest
}: AvatarProps) {
  const tile = framed ?? (size !== "xs" && size !== "xl");
  const a11y = labelled ? ({ role: "img", "aria-label": name } as const) : ({ "aria-hidden": true } as const);
  const agent = kind === "agent";
  const mood: AgentState = state ?? (running ? "thinking" : "idle");
  // A photo that is a drawn portrait (ADR 0166) is drawn here from its recipe, crisp at this size.
  const portrait = !agent && imageUrl && canDrawPortraits() ? recipeOfUrl(imageUrl) : null;
  return (
    <span
      className={cx(
        "ac-avatar",
        kind === "agent" && "ac-avatar--agent",
        size !== "md" && `ac-avatar--${size}`,
        tile && "ac-avatar--framed",
        agent && mood !== "idle" && mood !== "waiting" && mood !== "sleeping" && "ac-avatar--running",
        agent && mood !== "idle" && `ac-avatar--${mood}`,
        className,
      )}
      {...a11y}
      data-kind={kind}
      data-state={agent ? mood : undefined}
      data-accessory={
        agent && appearance?.accessory && appearance.accessory !== "none" ? appearance.accessory : undefined
      }
      data-eyes={agent && appearance?.eyes && appearance.eyes !== "round" ? appearance.eyes : undefined}
      style={agent ? { ...appearanceStyle(appearance), ...style } : style}
      {...rest}
    >
      {agent ? (
        <AgentBody
          appearance={appearance}
          state={mood}
          expression={expression}
          name={name}
          reactionKey={reactionKey}
          framed={tile}
        />
      ) : portrait ? (
        <PersonPortrait recipe={portrait} />
      ) : imageUrl ? (
        <img src={imageUrl} alt="" />
      ) : (
        <span className="ac-avatar__initials">{initials ?? initialsOf(name)}</span>
      )}
      {presence && (
        // Pixels of 1 px on the small faces, 1.5 px from the profile cards' 56 px up.
        <span className="ac-avatar__badge" title={presenceLabel}>
          <PresenceBadge presence={presence} size={size === "lg" || size === "xl" ? "lg" : "sm"} />
        </span>
      )}
    </span>
  );
}

/** Overlapping avatars (channel header, invitation). A span, so it may sit in a button (a vote's option, a pill). */
export function AvatarStack({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cx("ac-avatar-stack", className)} {...rest} />;
}

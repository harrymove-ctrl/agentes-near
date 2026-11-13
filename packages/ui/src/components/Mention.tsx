import type { CSSProperties, HTMLAttributes } from "react";
import { mentionTone } from "../agent/engine.js";
import { cx } from "../cx";
import type { AgentColor } from "./AgentLook";

/** An @mention: neutral for a person or anything unknown; `tone`, a mentioned agent's color, tints it in both themes. */
export function Mention({
  tone,
  className,
  style,
  ...rest
}: HTMLAttributes<HTMLSpanElement> & { tone?: AgentColor | undefined }) {
  if (!tone) return <span className={cx("ac-mention", className)} style={style} {...rest} />;
  const light = mentionTone(tone);
  const dark = mentionTone(tone, true);
  const vars = {
    "--mention-bg": light.background,
    "--mention-ink": light.ink,
    "--mention-bg-dark": dark.background,
    "--mention-ink-dark": dark.ink,
  } as CSSProperties;
  return <span className={cx("ac-mention ac-mention--agent", className)} style={{ ...vars, ...style }} {...rest} />;
}

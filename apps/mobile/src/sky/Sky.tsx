import type { AgentColorName } from "@agenteschat/ui/agent/engine";
import { skyHourOf, workspaceInk, workspaceTones } from "@agenteschat/ui/sky/workspace";
import type { StyleProp, ViewStyle } from "react-native";
import { useServer } from "@/lib/server";
import { useTheme } from "@/ui/theme";
import { Dither } from "./Dither";
import { fromSurface } from "./math";

export interface SkyProps {
  color?: AgentColorName;
  /** How far the surface goes into the agent's color (default 0.9; the home uses 0.7). */
  depth?: number;
  /** Fade to the bottom from this height share (default 0.55, as on the web). */
  fade?: number;
  /**
   * The surface it blends into: the screen's background (default), a raised card,
   * or the grouped gray.
   */
  surface?: "bg" | "raised" | "grouped";
  style?: StyleProp<ViewStyle>;
}

/** The pixel sky (home greeting, agent cover, auth): a glow low in the middle and a few stars. */
export function Sky({ color = "sky", depth = 0.9, fade = 0.55, surface = "bg", style }: SkyProps) {
  const { colors } = useTheme();
  return <Dither kind="sky" tones={fromSurface(colors[surface], depth, color)} pixel={4} fade={fade} style={style} />;
}

/** The host of a server's address ("" when it isn't one). */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/**
 * The workspace's sky behind Conversas' title (as behind its header on the web): the Cloud's is day with pixel
 * clouds drifting by, a server of one's own the same sky at dusk with a few stars (`@agenteschat/ui` sky/workspace,
 * drawn by the `workspace` shader). Tones 0..3 are the field's, 6 and 7 what is drawn over it.
 */
export function WorkspaceSky({
  fade = 0.55,
  fadeTop = 0,
  host,
  style,
}: {
  fade?: number;
  /** Comes in from nothing down to this height share (a band mid-screen, never a hard top line); 0 = none. */
  fadeTop?: number;
  /** Another server's sky (where a connection leads, a workspace elsewhere: ADR 0154); the current server's by default. */
  host?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors } = useTheme();
  const current = useServer();
  const hour = skyHourOf(host ?? hostOf(current));
  const tones = workspaceTones(hour, colors.bg);
  const ink = workspaceInk(hour, colors.bg);
  const deepest = tones[tones.length - 1] ?? colors.bg;
  return (
    <Dither
      kind="workspace"
      tones={[...tones, deepest, deepest, ink.dim, ink.bright]}
      pixel={4}
      fade={fade}
      fadeTop={fadeTop}
      extra={{ hour: hour === "day" ? 0 : 1, top: tones.length - 1 }}
      style={style}
    />
  );
}

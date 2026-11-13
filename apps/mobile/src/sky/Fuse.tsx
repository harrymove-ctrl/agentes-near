import type { AgentColorName } from "@agenteschat/ui/agent/engine";
import type { StyleProp, ViewStyle } from "react-native";
import { useTheme } from "@/ui/theme";
import { Dither } from "./Dither";
import { fromSurface } from "./math";

export interface FuseProps {
  color: AgentColorName;
  /** Time left, 0..1. */
  remaining: number;
  style?: StyleProp<ViewStyle>;
}

/** A request's fuse burning down to its expiry, in the asking agent's color. */
export function Fuse({ color, remaining, style }: FuseProps) {
  const { colors } = useTheme();
  return (
    <Dither
      kind="fuse"
      tones={fromSurface(colors.raised, 1, color)}
      pixel={2}
      extra={{ remaining: Math.max(0, Math.min(1, remaining)) }}
      style={[{ height: 6, flex: 1, minWidth: 0, borderRadius: 2, overflow: "hidden" }, style]}
    />
  );
}

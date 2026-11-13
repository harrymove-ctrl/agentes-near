import type { AgentColorName } from "@agenteschat/ui/agent/engine";
import type { StyleProp, ViewStyle } from "react-native";
import { useTheme } from "@/ui/theme";
import { Dither } from "./Dither";
import { fromSurface } from "./math";

export interface SpendBarProps {
  color: AgentColorName;
  /** Share of the budget used, 0..1. */
  value: number;
  style?: StyleProp<ViewStyle>;
}

/** An agent's spend against its budget, as pixel cells in its color. */
export function SpendBar({ color, value, style }: SpendBarProps) {
  const { colors } = useTheme();
  return (
    <Dither
      kind="bar"
      tones={fromSurface(colors.raised, 1, color)}
      pixel={2}
      animated={false}
      extra={{ value: Math.max(0, Math.min(1, value)) }}
      style={[{ height: 10, alignSelf: "stretch" }, style]}
    />
  );
}

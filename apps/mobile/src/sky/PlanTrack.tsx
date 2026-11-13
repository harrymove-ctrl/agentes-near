import type { AgentColorName } from "@agenteschat/ui/agent/engine";
import type { StyleProp, ViewStyle } from "react-native";
import { useTheme } from "@/ui/theme";
import { Dither } from "./Dither";
import { fromSurface, MAX_PLAN_ITEMS, type PlanState, statesUniform } from "./math";

export interface PlanTrackProps {
  color: AgentColorName;
  /** One cell per plan item (the first 48). */
  items: PlanState[];
  /** Taller on the mission screen (default 10). */
  height?: number;
  style?: StyleProp<ViewStyle>;
}

/** A mission's plan as pixel cells: done in the agent's tones, the running one breathing, the rest dotted. */
export function PlanTrack({ color, items, height = 10, style }: PlanTrackProps) {
  const { colors } = useTheme();
  const list = items.slice(0, MAX_PLAN_ITEMS);
  return (
    <Dither
      kind="track"
      tones={fromSurface(colors.raised, 1, color)}
      pixel={2}
      extra={{ count: list.length, states: statesUniform(list) }}
      style={[{ height, alignSelf: "stretch" }, style]}
    />
  );
}

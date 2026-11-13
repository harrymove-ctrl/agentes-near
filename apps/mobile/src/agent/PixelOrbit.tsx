import type { AgentColorName } from "@agenteschat/ui/agent/engine";
import { View } from "react-native";
import { useReducedMotion, useTheme } from "@/ui/theme";
import { useFrameTime } from "./live";
import { orbitCells, orbitHead } from "./orbit";

export interface PixelOrbitProps {
  color: AgentColorName;
  /** Side in points (default 12). */
  size?: number;
  /** Held on its first frame (a pull not yet let go): it turns once the work starts. */
  still?: boolean;
}

/** The 3×3 pixel orbit (working, loading) in the agent's tones; still with reduced motion. */
export function PixelOrbit({ color, size = 12, still = false }: PixelOrbitProps) {
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  const t = useFrameTime(!reduced && !still, 0);
  const head = orbitHead(t * 1000, reduced);
  const cell = size / 3;
  const gap = Math.max(0.5, cell * 0.14);
  return (
    <View
      style={{ width: size, height: size }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {orbitCells(color, colors.bg, head).map((c) => (
        <View
          key={`${c.x}-${c.y}`}
          style={{
            position: "absolute",
            left: c.x * cell + gap / 2,
            top: c.y * cell + gap / 2,
            width: cell - gap,
            height: cell - gap,
            backgroundColor: c.color,
            opacity: c.opacity,
          }}
        />
      ))}
    </View>
  );
}

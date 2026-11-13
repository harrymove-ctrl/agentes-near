import Svg, { Circle, Path, Rect } from "react-native-svg";
import { ICONS, type IconName } from "./icons.data";
import { useTheme } from "./theme";

export type { IconName };

export interface IconProps {
  name: IconName;
  /** Points (default 20). */
  size?: number;
  /** Default: the theme's ink2. */
  color?: string;
}

/** A line icon from the design system. */
export function Icon({ name, size = 20, color }: IconProps) {
  const { colors } = useTheme();
  const stroke = color ?? colors.ink2;
  const shapes = ICONS[name] ?? ICONS.circle;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" accessible={false}>
      {shapes.map((s) => {
        if (s.t === "circle")
          return (
            <Circle
              key={`c${s.cx}-${s.cy}-${s.r}`}
              cx={s.cx}
              cy={s.cy}
              r={s.r}
              fill={s.fill ? stroke : "none"}
              stroke={s.fill ? "none" : stroke}
              strokeWidth={1.7}
            />
          );
        if (s.t === "rect")
          return (
            <Rect
              key={`r${s.x}-${s.y}-${s.w}-${s.h}`}
              x={s.x}
              y={s.y}
              width={s.w}
              height={s.h}
              rx={s.rx}
              fill={s.fill ? stroke : "none"}
              stroke={s.fill ? "none" : stroke}
              strokeWidth={1.7}
              opacity={s.opacity}
            />
          );
        return (
          <Path
            key={s.d}
            d={s.d}
            fill="none"
            stroke={stroke}
            strokeWidth={s.sw ?? 1.7}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        );
      })}
    </Svg>
  );
}

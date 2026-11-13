import { type AgentColorName, mixHex } from "@agenteschat/ui/agent/engine";
import { useMemo, useState } from "react";
import { type LayoutChangeEvent, View } from "react-native";
import { useTheme } from "@/ui/theme";
import { CellCanvas } from "../browser/TrailPixels";
import { MONTH_CELL, MONTH_ROWS, type MonthDay, monthCells, monthNow, monthWidth } from "./month-pixels";

/**
 * The agent's month in pixels under "Fez" on its profile (./month-pixels.ts, the web's Atividade drawing), in
 * its own tones. `label` says what it shows: a screen reader hears it as one image.
 */
export function MonthPixels({
  perDay,
  color,
  label,
}: {
  perDay: readonly MonthDay[];
  color: AgentColorName;
  label: string;
}) {
  const { colors } = useTheme();
  const [width, setWidth] = useState(0);
  const { days, today } = monthNow(new Date());
  const w = width ? monthWidth(width, days) : 0;
  const key = perDay.map((d) => `${d.day}:${d.runs}:${d.failed}`).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the days
  const runs = useMemo(
    () =>
      w
        ? monthCells(w, days, today, perDay, color, {
            raised: colors.raised,
            danger: colors.danger,
            dot: mixHex(colors.raised, colors.faint, 0.45),
          })
        : [],
    [w, days, today, key, color, colors.raised, colors.danger, colors.faint],
  );
  const onLayout = (e: LayoutChangeEvent) => setWidth(Math.round(e.nativeEvent.layout.width));
  const height = MONTH_ROWS * MONTH_CELL;
  return (
    <View style={{ height }} onLayout={onLayout} accessible accessibilityRole="image" accessibilityLabel={label}>
      {w ? <CellCanvas runs={runs} width={width} height={height} cx={width / w} cy={MONTH_CELL} /> : null}
    </View>
  );
}

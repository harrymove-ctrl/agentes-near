import type { AgentColorName } from "@agenteschat/ui/agent/engine";
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { CARD_PAD, ComputerSky, Glass, Icon, type IconName, PixelOrbit, Text, useTheme } from "@/ui";
import { withAlpha } from "@/ui/palette";
import { DOCK_HANG, EdgeDock } from "./EdgeDock";
import { DEFAULT_DESKTOP } from "./screen-view";

/** The agent's screen switched off: a device's dark glass, whatever the app's theme. */
const SCREEN_OFF = "#101010";
const ON_SCREEN = { ink: "#efefec", muted: "#a3a39e" };

/**
 * The stage with nothing live on it: the screen itself says what it is and why, in the screen's shape, with no card
 * inside it. Switched off it is dark; on its way, the agent's sky with its pixel spinner. Its one action rides the
 * screen's capsule (`EdgeDock`): across the bottom edge, or inside it when it fills the live screen's box. `clear`
 * dims the live picture instead of covering it (a switch between watching and control, a question), and there the
 * words sit on glass so they read over the picture.
 */
export function Cover({
  icon,
  art,
  spinner = false,
  sky = false,
  color = "sky",
  text,
  help,
  action,
  fill = false,
  clear = false,
}: {
  icon?: IconName;
  art?: ReactNode;
  spinner?: boolean;
  /** The agent's sky behind it, at the screen's shape (a screen opening). */
  sky?: boolean;
  color?: AgentColorName;
  text: string;
  help?: string;
  /** Dimmed: buttons on its glass. Otherwise one of the capsule's (`DockText`). */
  action?: ReactNode;
  /** Over the live screen's box, filling it. */
  fill?: boolean;
  /** Dimmed, not covered: the picture under it stays in sight (a switch between watching and control, a question). */
  clear?: boolean;
}) {
  const { colors: c, shadows } = useTheme();
  const lead = spinner ? (
    <PixelOrbit color={color} size={16} />
  ) : icon ? (
    <Icon name={icon} size={16} color={clear || sky ? c.ink : ON_SCREEN.ink} />
  ) : null;

  if (clear) {
    return (
      <View style={[styles.cover, StyleSheet.absoluteFill, { backgroundColor: withAlpha(c.bg, 0.3) }]}>
        <View style={[styles.lift, { boxShadow: shadows.e2 }]}>
          <Glass style={styles.card}>
            {art}
            <View style={styles.row}>
              {lead}
              <Text variant="subhead" tone="ink" style={styles.text}>
                {text}
              </Text>
            </View>
            {help ? (
              <Text variant="small" tone="muted" style={styles.center}>
                {help}
              </Text>
            ) : null}
            {/* A button keeps to its own start; its box is what the card centers. */}
            {action ? <View>{action}</View> : null}
          </Glass>
        </View>
      </View>
    );
  }

  const screen = (
    <View
      style={[
        styles.cover,
        fill ? StyleSheet.absoluteFill : styles.stage,
        { backgroundColor: sky ? c.sunken : SCREEN_OFF },
      ]}
    >
      {sky ? <ComputerSky color={color} style={StyleSheet.absoluteFill} /> : null}
      <View style={styles.say}>
        {art}
        <View style={styles.row}>
          {lead}
          <Text variant="subhead" style={[styles.text, { color: sky ? c.ink : ON_SCREEN.ink }]}>
            {text}
          </Text>
        </View>
        {help ? (
          <Text variant="small" style={[styles.center, { color: sky ? c.muted : ON_SCREEN.muted }]}>
            {help}
          </Text>
        ) : null}
      </View>
      {fill && action ? <EdgeDock inside>{action}</EdgeDock> : null}
    </View>
  );
  if (fill || !action) return screen;
  return (
    <View style={styles.docked}>
      {screen}
      <EdgeDock>{action}</EdgeDock>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { textAlign: "center" },
  cover: {
    borderRadius: 20,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    padding: CARD_PAD,
  },
  stage: { aspectRatio: DEFAULT_DESKTOP.width / DEFAULT_DESKTOP.height },
  // The capsule's hang and a little air, as the live screen's.
  docked: { marginBottom: DOCK_HANG + 12 },
  say: { alignItems: "center", gap: 8, maxWidth: 300 },
  lift: { maxWidth: "100%", borderRadius: 14 },
  card: { alignItems: "center", gap: 10, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 10 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1 },
  text: { flexShrink: 1, fontWeight: "600", textAlign: "center" },
});

import type { ReactNode } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Glass, Icon, IconButton, type IconName, PressScale, Text, useTheme } from "@/ui";

/** How far the capsule hangs under the screen's edge: half its height, the rest over the picture. */
export const DOCK_HANG = 24;

/**
 * What can be done with the agent's screen right now, on the glass capsule the sideways view docks at its side
 * (`TouchDock`), pinned across the screen's bottom edge: half on the picture, half under it. Its parent leaves
 * `DOCK_HANG` and a little air under the screen. `inside`: within the screen's box, near its bottom (a state that
 * fills the live screen, whose box clips what hangs out).
 */
export function EdgeDock({ children, inside = false }: { children: ReactNode; inside?: boolean }) {
  const { colors, shadows } = useTheme();
  return (
    <View pointerEvents="box-none" style={[styles.dock, inside && styles.inside]}>
      <View style={[styles.lift, { boxShadow: shadows.e2 }]}>
        <Glass liquid intensity={70} style={[styles.glass, { borderColor: colors.line2 }]}>
          {children}
        </Glass>
      </View>
    </View>
  );
}

/** A tool on the capsule: the keyboard, laying the view down. */
export function DockIcon({ icon, label, onPress }: { icon: IconName; label: string; onPress: () => void }) {
  return <IconButton icon={icon} label={label} onPress={onPress} />;
}

/** An action in words on the capsule ("Assumir o controle", "Tentar de novo"). */
export function DockText({
  label,
  icon,
  onPress,
  loading = false,
}: {
  label: string;
  icon?: IconName;
  onPress: () => void;
  loading?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <PressScale
      to={0.94}
      fill={false}
      onPress={onPress}
      disabled={loading}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ busy: loading }}
      style={styles.pill}
      contentStyle={styles.pillIn}
    >
      {loading ? (
        <ActivityIndicator size="small" color={colors.ink2} />
      ) : icon ? (
        <Icon name={icon} size={17} color={colors.ink2} />
      ) : null}
      <Text variant="small" tone="ink" style={styles.label} numberOfLines={1}>
        {label}
      </Text>
    </PressScale>
  );
}

/** The way out of control, in ink: "Pronto" when the agent asked, "Devolver" when the person took it. */
export function DockDone({
  label,
  onPress,
  loading = false,
}: {
  label: string;
  onPress: () => void;
  loading?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <PressScale
      to={0.92}
      fill={false}
      onPress={onPress}
      disabled={loading}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ busy: loading }}
      style={[styles.pill, { backgroundColor: colors.ink }]}
      contentStyle={styles.pillIn}
    >
      {loading ? (
        <ActivityIndicator size="small" color={colors.bg} />
      ) : (
        <Icon name="check" size={17} color={colors.bg} />
      )}
      <Text variant="small" style={[styles.label, { color: colors.bg }]} numberOfLines={1}>
        {label}
      </Text>
    </PressScale>
  );
}

/** Between the tools and the way out. */
export function DockRule() {
  const { colors } = useTheme();
  return <View style={[styles.rule, { backgroundColor: colors.line2 }]} />;
}

const styles = StyleSheet.create({
  dock: { position: "absolute", left: 0, right: 0, bottom: -DOCK_HANG, alignItems: "center" },
  inside: { bottom: 12 },
  // A pill around its 40 pt pills, 4 pt out: concentric with them.
  lift: { borderRadius: 999, maxWidth: "94%" },
  glass: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    padding: 4,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  pill: { borderRadius: 20, flexShrink: 1, overflow: "hidden" },
  pillIn: { height: 40, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14 },
  label: { fontWeight: "600", flexShrink: 1 },
  rule: { width: StyleSheet.hairlineWidth, height: 22, marginHorizontal: 4 },
});

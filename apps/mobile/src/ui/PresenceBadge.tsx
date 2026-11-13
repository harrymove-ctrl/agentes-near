import type { ReactNode } from "react";
import { PixelRatio, StyleSheet, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { type BadgePath, type BadgePresence, badgeCell, badgeFills, badgeOverhang, badgePaths } from "./presence-badge";
import { useTheme } from "./theme";

/** The ten drawings (five presences, with or without the ring), made once. */
const DRAWN = new Map<string, { size: number; paths: BadgePath[] }>();
function drawing(presence: BadgePresence, ring: boolean) {
  const key = `${presence}:${ring}`;
  let d = DRAWN.get(key);
  if (!d) {
    d = badgePaths(presence, ring);
    DRAWN.set(key, d);
  }
  return d;
}

export interface PresenceBadgeProps {
  presence: BadgePresence;
  /** Points per cell (`badgeCell` for an avatar's size); snapped to the screen's pixels so the cells stay crisp. */
  cell?: number;
  /** The surface behind it, drawn as a one-cell ring (default the page's color); null: no ring. */
  ring?: string | null;
}

/**
 * Presence in pixels (ADR 0084): a 9×9 cell badge in the agents' body shape, green online, red busy (a bar),
 * amber away (a clock), an empty outline offline and a dotted one hidden, ringed in the surface behind it.
 * Decorative: the row or the face around it says the presence in words.
 */
export function PresenceBadge({ presence, cell = 1.1, ring }: PresenceBadgeProps) {
  const { scheme, colors } = useTheme();
  const ringColor = ring === undefined ? colors.bg : ring;
  const { size, paths } = drawing(presence, ringColor !== null);
  const fills = badgeFills(presence, scheme === "dark", ringColor ?? "transparent");
  const side = PixelRatio.roundToNearestPixel(cell) * size;
  return (
    <Svg
      width={side}
      height={side}
      viewBox={`0 0 ${size} ${size}`}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {paths.map((p) => (
        <Path key={p.tone} d={p.d} fill={fills[p.tone]} />
      ))}
    </Svg>
  );
}

/**
 * An avatar of `size` points with its presence on the bottom right corner, hanging a little past it (the ring
 * cuts into the avatar's edge). No presence: the avatar alone.
 */
export function WithPresence({
  size,
  presence,
  ring,
  cell,
  inset = 0,
  children,
}: {
  size: number;
  presence: BadgePresence | null | undefined;
  ring?: string | null;
  /** Default by the avatar's size (`badgeCell`). */
  cell?: number;
  /** Points between the box's right edge and the avatar's (an agent standing on its own, narrower than its box). */
  inset?: number;
  children: ReactNode;
}) {
  if (!presence) return <>{children}</>;
  const c = cell ?? badgeCell(size);
  const off = -badgeOverhang(c);
  return (
    <View style={{ width: size, height: size }}>
      {children}
      <View style={[styles.corner, { right: off + inset, bottom: off }]} pointerEvents="none">
        <PresenceBadge presence={presence} cell={c} {...(ring !== undefined ? { ring } : {})} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  corner: { position: "absolute" },
});

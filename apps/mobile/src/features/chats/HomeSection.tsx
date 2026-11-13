import type { ReactNode } from "react";
import { useCallback, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, { FadeIn, LayoutAnimationConfig, useAnimatedStyle, withTiming } from "react-native-reanimated";
import { readValueSync, STORED, writeValue } from "@/lib/storage";
import { Count, Icon, IconButton, LIST_INSET, SCREEN_X, Text, useReducedMotion, weights } from "@/ui";
import { useColors } from "../shared/hooks";
import {
  HOME_SECTIONS,
  type HomeSection,
  parseCollapsed,
  parseHomeCollapsed,
  toggleCollapsed,
  toggleHomeCollapsed,
} from "./logic";

/**
 * The sections the person collapsed, remembered across launches: Conversas' by default, or another list's
 * (`store`, `keys`: the Threads tab's Missões and Threads; null `keys`: any ids, Agentes' groups).
 */
export function useCollapsedSections<K extends string = HomeSection>(
  store: string = STORED.homeCollapsed,
  keys: readonly K[] | null = HOME_SECTIONS as unknown as readonly K[],
) {
  const [collapsed, setCollapsed] = useState<K[]>(() => parseCollapsed(readValueSync(store), keys));
  const toggle = useCallback(
    (key: K) => {
      setCollapsed((list) => {
        const next = toggleCollapsed(list, key, keys);
        void writeValue(store, next.length > 0 ? JSON.stringify(next) : null);
        return next;
      });
    },
    [store, keys],
  );
  return { collapsed, toggle };
}

/** Conversas' closed sections, remembered: the fixed ones and the channel categories (any key, ADR 0080). */
export function useHomeCollapsed() {
  const [collapsed, setCollapsed] = useState<string[]>(() => parseHomeCollapsed(readValueSync(STORED.homeCollapsed)));
  const toggle = useCallback((key: string) => {
    setCollapsed((list) => {
      const next = toggleHomeCollapsed(list, key);
      void writeValue(STORED.homeCollapsed, next.length > 0 ? JSON.stringify(next) : null);
      return next;
    });
  }, []);
  return { collapsed, toggle };
}

/**
 * A section of Conversas: the title, its count (medium, faint) and a chevron that
 * turns when collapsed; tapping the header collapses or opens it.
 */
export function CollapsibleSection({
  title,
  count,
  collapsed,
  onToggle,
  menu,
  kept,
  children,
}: {
  title: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  /**
   * A channel category's or a setor's menu, for who may change it: a long press on the header, and a "…" before the
   * chevron, so it is found without knowing the long press.
   */
  menu?: { label: string; onPress: () => void };
  /** Shown while closed (a category's unread channels). */
  kept?: ReactNode;
  children: ReactNode;
}) {
  const c = useColors();
  const reduced = useReducedMotion();
  const chevron = useAnimatedStyle(() => ({
    transform: [{ rotate: withTiming(collapsed ? "-90deg" : "0deg", { duration: reduced ? 0 : 200 }) }],
  }));
  return (
    <View>
      <Pressable
        onPress={onToggle}
        {...(menu
          ? {
              onLongPress: menu.onPress,
              delayLongPress: 380,
              accessibilityActions: [{ name: "menu", label: menu.label }],
              onAccessibilityAction: (e: { nativeEvent: { actionName: string } }) => {
                if (e.nativeEvent.actionName === "menu") menu.onPress();
              },
            }
          : {})}
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ expanded: !collapsed }}
        style={({ pressed }) => [styles.head, pressed && styles.pressed]}
      >
        <Text variant="small" tone="ink" style={styles.title} accessibilityRole="header" numberOfLines={1}>
          {title}
        </Text>
        <Count value={count} size={15} weight={weights.medium} color={c.faint} />
        <View style={styles.grow} />
        {menu ? (
          <View style={styles.menu}>
            <IconButton icon="more" small label={menu.label} onPress={menu.onPress} />
          </View>
        ) : null}
        <Animated.View style={chevron}>
          <Icon name="chev" size={15} color={c.faint} />
        </Animated.View>
      </Pressable>
      {collapsed ? (kept ?? null) : null}
      {/* Opened while the list shows, its rows fade in; open when the list mounts, they just show. */}
      <LayoutAnimationConfig skipEntering>
        {collapsed ? null : (
          <Animated.View entering={reduced ? undefined : FadeIn.duration(160)}>{children}</Animated.View>
        )}
      </LayoutAnimationConfig>
    </View>
  );
}

/** "Ver todos os agentes" under a section's first rows, aligned with the text column (`.more`). */
export function SeeAllRow({ label, onPress }: { label: string; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.more, pressed && { backgroundColor: c.sunken }]}
    >
      <Text variant="small" tone="muted" style={styles.medium}>
        {label}
      </Text>
      <Icon name="right" size={15} color={c.muted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // The kit's `SectionHeader` box: the screen's sides (SCREEN_X), 24 above and 8 below (the rhythm in eights).
  head: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingTop: 24,
    paddingHorizontal: SCREEN_X,
    paddingBottom: 8,
  },
  pressed: { opacity: 0.6 },
  title: { fontWeight: "600", flexShrink: 1 },
  // The toolbar's 32 over the title's 20-point line: the header keeps its height.
  menu: { marginVertical: -6 },
  grow: { flex: 1 },
  more: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 12,
    paddingLeft: LIST_INSET,
    paddingRight: 16,
  },
  medium: { fontWeight: "500" },
});

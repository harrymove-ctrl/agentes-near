import { type ReactNode, useRef } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import ReanimatedSwipeable, {
  type SwipeableMethods,
  SwipeDirection,
} from "react-native-gesture-handler/ReanimatedSwipeable";
import Animated, {
  interpolate,
  type SharedValue,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";
import { haptics } from "./haptics";
import { Icon, type IconName } from "./Icon";
import { Text } from "./Text";

/** What a swipe does: its word and icon on the pane, the pane's color and the word's color on it. */
export interface SwipeAction {
  label: string;
  icon: IconName;
  color: string;
  ink: string;
  onAction: () => void;
}

/** The pane's width: the row opens this far, and letting go past half of it leaves it open. */
const PANE = 92;
/** Pulled at least this far, the swipe is the action itself (the system's full swipe); short of it, the row waits open. */
const FULL = 200;

/** One action, or two side by side (Fixar · Silenciar), on a side. */
type Side = SwipeAction | readonly SwipeAction[] | undefined;
const actionsOf = (side: Side): readonly SwipeAction[] => (side ? ("label" in side ? [side] : side) : []);

/**
 * A list row that swipes to an action, as the system's lists do: the row follows the finger (on the UI thread),
 * revealing the action's color under all of it and its pane with the icon and the word, always whole. As the system's
 * lists: letting go past half the pane leaves the row open on its panes (a light tap as it catches) and a tap on a pane
 * does it; pulling all the way (`FULL`) with one action on that side is the action itself. A short swipe never acts on
 * its own (it used to, past 46 points: a look at the pane pinned the row and closed it). `left` is revealed by swiping right, `right` by swiping left. The row's content must be opaque (it covers
 * the panes).
 */
export function SwipeRow({ left, right, children }: { left?: Side; right?: Side; children: ReactNode }) {
  const ref = useRef<SwipeableMethods>(null);
  // The farthest the row was pulled in this swipe, read when it settles open.
  const reach = useSharedValue(0);
  const lefts = actionsOf(left);
  const rights = actionsOf(right);
  const run = (action: SwipeAction | undefined) => {
    ref.current?.close();
    if (!action) return;
    haptics.light();
    action.onAction();
  };
  const panes = (actions: readonly SwipeAction[]) => {
    const [only, ...more] = actions;
    if (!only) return undefined;
    if (more.length === 0)
      return (progress: SharedValue<number>, drag: SharedValue<number>) => (
        <>
          <Reach drag={drag} reach={reach} />
          <Pane action={only} progress={progress} onPress={() => run(only)} />
        </>
      );
    // Two: the outer action's color under the whole row, each pane on its own color, side by side.
    const outer = actions[actions.length - 1] ?? only;
    return (progress: SharedValue<number>) => (
      <>
        <Under color={outer.color} progress={progress} />
        <View style={styles.panes}>
          {actions.map((action) => (
            <Pane key={action.label} action={action} progress={progress} fill={false} onPress={() => run(action)} />
          ))}
        </View>
      </>
    );
  };
  const renderLeft = panes(lefts);
  const renderRight = panes(rights);
  return (
    <ReanimatedSwipeable
      ref={ref}
      friction={1}
      // Past the panes the row still follows, at half the finger's pace, so a full pull is reachable and feels heavy.
      overshootFriction={2}
      leftThreshold={(PANE * Math.max(1, lefts.length)) / 2}
      rightThreshold={(PANE * Math.max(1, rights.length)) / 2}
      {...(renderLeft ? { renderLeftActions: renderLeft } : {})}
      {...(renderRight ? { renderRightActions: renderRight } : {})}
      // Settled open: pulled all the way with one action, the swipe was it (the row moved right: the left pane's);
      // otherwise the row waits open and the tap marks the moment it caught.
      onSwipeableOpen={(direction) => {
        const side = direction === SwipeDirection.RIGHT ? lefts : rights;
        const full = reach.value >= FULL;
        reach.value = 0;
        if (full && side.length === 1) run(side[0]);
        else haptics.light();
      }}
      onSwipeableClose={() => {
        reach.value = 0;
      }}
    >
      {children}
    </ReanimatedSwipeable>
  );
}

/** Keeps the farthest the row was pulled (`drag` is its offset, negative when it moves left). */
function Reach({ drag, reach }: { drag: SharedValue<number>; reach: SharedValue<number> }) {
  useAnimatedReaction(
    () => Math.abs(drag.value),
    (now) => {
      if (now > reach.value) reach.value = now;
    },
  );
  return null;
}

/** The action's color under the whole row, only while its side shows. */
function Under({ color, progress }: { color: string; progress: SharedValue<number> }) {
  const shown = useAnimatedStyle(() => ({ opacity: progress.value > 0 ? 1 : 0 }));
  return <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: color }, shown]} />;
}

/** One side's pane: the action's color under the whole row (only while its side shows) and its word at the edge. */
function Pane({
  action,
  progress,
  fill = true,
  onPress,
}: {
  action: SwipeAction;
  progress: SharedValue<number>;
  /** Paint the action's color under the whole row (the outer pane); else only under its own width. */
  fill?: boolean;
  onPress: () => void;
}) {
  // The icon and the word grow in as the pane opens.
  const grow = useAnimatedStyle(() => {
    const k = Math.min(1, progress.value);
    return {
      opacity: interpolate(k, [0, 0.5, 1], [0, 0.6, 1]),
      transform: [{ scale: interpolate(k, [0, 1], [0.7, 1]) }],
    };
  });
  return (
    <>
      {fill ? <Under color={action.color} progress={progress} /> : null}
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={action.label}
        style={({ pressed }) => [
          styles.pane,
          !fill && { backgroundColor: action.color },
          pressed ? { opacity: 0.6 } : null,
        ]}
      >
        <Animated.View style={[styles.in, grow]}>
          <Icon name={action.icon} size={20} color={action.ink} />
          <Text variant="caption" numberOfLines={1} style={[styles.word, { color: action.ink }]}>
            {action.label}
          </Text>
        </Animated.View>
      </Pressable>
    </>
  );
}

const styles = StyleSheet.create({
  panes: { flexDirection: "row" },
  pane: { width: PANE, alignItems: "center", justifyContent: "center" },
  in: { alignItems: "center", gap: 4 },
  word: { fontWeight: "600" },
});

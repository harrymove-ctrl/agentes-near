import type { NativeStackNavigationOptions } from "expo-router";
import type { SFSymbolIcon } from "expo-router/native-tabs";
import { type ReactNode, useLayoutEffect, useMemo, useRef } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { ScrollToTopGuard } from "react-native-screens/experimental";
import { IconButton, usePlateEdge } from "./IconButton";
import type { IconName } from "./icons.data";
import { HeaderSlot, useHeaderSlot } from "./navigation";
import { useTheme } from "./theme";

/** An SF Symbol name (the bar buttons on iOS). */
export type SFSymbolName = Extract<NonNullable<SFSymbolIcon["sf"]>, string>;

/** A button in a native header: the system bar button on iOS (glass on iOS 26), our icon button on Android. */
export interface HeaderAction {
  /** Our line icon (Android). */
  icon: IconName;
  /** The matching SF Symbol (iOS). */
  sf: SFSymbolName;
  label: string;
  onPress: () => void;
}

const IOS = Platform.OS === "ios";

/**
 * Header options for a screen's actions. On iOS the right actions are native `UIBarButtonItem`s
 * (`unstable_headerRightItems`): UIKit places, sizes and groups them in the bar, where a React view in
 * `headerRight` could be laid out in the wrong place on iOS 26. `left` is a custom element (the avatar on
 * Início), shown without the shared glass behind it. On Android both are React views in the bar, the right ones
 * in a `HeaderCapsule` (the floating plate iOS 26 puts them in).
 * The options only change when the actions' icons or labels change; presses always reach the latest
 * handlers.
 */
export function useHeaderActionOptions({
  right,
  left,
  leftActions,
}: {
  right?: HeaderAction[] | undefined;
  left?: ReactNode;
  /** Native buttons on the left (iOS): unlike a custom `left` view, they keep the large title collapsing. */
  leftActions?: HeaderAction[] | undefined;
}): NativeStackNavigationOptions {
  const latest = useRef(right);
  const latestLeft = useRef(leftActions);
  useLayoutEffect(() => {
    latest.current = right;
    latestLeft.current = leftActions;
  });
  const leftSlot = useHeaderSlot(left ?? null);
  const hasLeft = left != null;
  const describe = (list: HeaderAction[] | undefined) =>
    (list ?? []).map(({ icon, sf, label }) => ({ icon, sf, label }));
  const signature = JSON.stringify([describe(right), describe(leftActions)]);
  return useMemo<NativeStackNavigationOptions>(() => {
    const [actions, lefts] = JSON.parse(signature) as Omit<HeaderAction, "onPress">[][];
    const press = (i: number) => () => latest.current?.[i]?.onPress();
    const pressLeft = (i: number) => () => latestLeft.current?.[i]?.onPress();
    const options: NativeStackNavigationOptions = {};
    if (IOS) {
      options.unstable_headerRightItems = actions.length
        ? () =>
            actions.map((a, i) => ({
              type: "button" as const,
              label: a.label,
              accessibilityLabel: a.label,
              icon: { type: "sfSymbol" as const, name: a.sf },
              onPress: press(i),
            }))
        : undefined;
      options.unstable_headerLeftItems = lefts.length
        ? () =>
            lefts.map((a, i) => ({
              type: "button" as const,
              label: a.label,
              accessibilityLabel: a.label,
              icon: { type: "sfSymbol" as const, name: a.sf },
              onPress: pressLeft(i),
            }))
        : hasLeft
          ? () => [
              {
                type: "custom" as const,
                element: (
                  <BarPressable>
                    <HeaderSlot slot={leftSlot} />
                  </BarPressable>
                ),
                hidesSharedBackground: true,
              },
            ]
          : undefined;
    } else {
      options.headerRight = actions.length
        ? () => (
            <HeaderCapsule>
              {actions.map((a, i) => (
                <IconButton key={`${a.icon}:${a.label}`} icon={a.icon} label={a.label} onPress={press(i)} />
              ))}
            </HeaderCapsule>
          )
        : undefined;
      options.headerLeft = hasLeft ? () => <HeaderSlot slot={leftSlot} /> : undefined;
    }
    return options;
  }, [signature, hasLeft, leftSlot]);
}

/**
 * Our own pressable views in a native bar (its buttons, the conversation's pill, Início's avatar). On iPadOS 26 and
 * iPhone iOS 27 a tap on the bar also scrolls the screen's list to its top, a tap on one of them included: the
 * conversation jumped up when its computer or "…" was pressed. The guard keeps the tap theirs (react-native-screens'
 * workaround until React Native fixes it: react-native#56061); nothing on Android.
 */
export function BarPressable({ children }: { children: ReactNode }) {
  return <ScrollToTopGuard>{children}</ScrollToTopGuard>;
}

/**
 * Buttons of a bar floating over the content (Android): one opaque plate with round ends around them, like the
 * glass capsule iOS 26 draws around a bar's buttons; one button makes a circle. Nothing of its own on iOS,
 * where the system draws the capsule.
 */
export function HeaderCapsule({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  const edge = usePlateEdge();
  if (IOS) return <>{children}</>;
  return <View style={[styles.row, styles.capsule, { backgroundColor: colors.glassSolid }, edge]}>{children}</View>;
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 4 },
  capsule: { gap: 0, borderRadius: 20 },
});

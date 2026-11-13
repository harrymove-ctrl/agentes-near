import { useHeaderHeight } from "expo-router/react-navigation";
import type { ReactElement, ReactNode } from "react";
import { Platform, type RefreshControlProps, StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeOutUp, LayoutAnimationConfig } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SCREEN_X, Text } from "@/ui";
import { FadingHeaderTitle, useCoverScroll, useScrollFade } from "@/ui/cover";
import { useColors } from "./hooks";
import { FocusLive, PushedHeader } from "./parts";

/**
 * A pushed screen with a large title (Issues, Drive): the title in Funnel Display is part of the content and
 * scrolls away; the bar's own title fades in as it goes, over a bar the content scrolls under (the system
 * glass on iOS 26). The same shape as the tabs' `LargeTitleScreen`, without the tab bar's room. `collapsed` folds the
 * large title away (a search field under it took the focus, as the system's search bar does); content that should
 * slide up with it carries a `LinearTransition` layout.
 */
export function PushedLargeTitle({
  title,
  right,
  refreshControl,
  onScrollBeginDrag,
  bottomInset = 24,
  collapsed = false,
  grouped = false,
  keyboard = false,
  dock,
  children,
}: {
  title: string;
  right?: ReactNode;
  refreshControl?: ReactElement<RefreshControlProps>;
  onScrollBeginDrag?: () => void;
  /** Room under the content (a bottom bar over it needs more). */
  bottomInset?: number;
  /** The large title folded away (a search in progress). */
  collapsed?: boolean;
  /** The grouped gray background with white cards on it (Dashboards), as `LargeTitleScreen`'s. */
  grouped?: boolean;
  /** A field in the content or the dock: the content makes room for the keyboard and drags it away. */
  keyboard?: boolean;
  /** What stays at the screen's bottom over the content (a widget's "Ask for a change"), absolutely placed. */
  dock?: ReactNode;
  children?: ReactNode;
}) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  // iOS insets the scroll view by the bar (automatic adjustment): at rest the offset is minus its height.
  const { y, onScroll } = useCoverScroll(Platform.OS === "ios" ? headerHeight : 0);
  const titleFade = useScrollFade(y, 0, TITLE_GONE);
  return (
    <View style={[styles.screen, { backgroundColor: grouped ? c.grouped : c.bg }]}>
      <PushedHeader
        title={<FadingHeaderTitle y={y} from={BAR_TITLE_FROM} to={BAR_TITLE_TO} text={title} />}
        right={right}
        solid={false}
        grouped={grouped}
      />
      <FocusLive>
        <Animated.ScrollView
          onScroll={onScroll}
          onScrollBeginDrag={onScrollBeginDrag}
          scrollEventThrottle={16}
          contentInsetAdjustmentBehavior="automatic"
          refreshControl={refreshControl}
          keyboardDismissMode={keyboard ? "interactive" : "on-drag"}
          automaticallyAdjustKeyboardInsets={keyboard}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: insets.bottom + bottomInset }}
        >
          {/* The title shows at once when the screen opens; it fades only when it comes back after a search. */}
          <LayoutAnimationConfig skipEntering>
            {collapsed ? null : (
              <Animated.View entering={FadeIn.duration(200)} exiting={FadeOutUp.duration(180)}>
                <Animated.View style={[styles.head, titleFade]}>
                  <Text variant="display" accessibilityRole="header" numberOfLines={1}>
                    {title}
                  </Text>
                </Animated.View>
              </Animated.View>
            )}
          </LayoutAnimationConfig>
          {children}
        </Animated.ScrollView>
      </FocusLive>
      {dock}
    </View>
  );
}

/** Scroll (from rest) by which the large title has faded out under the bar. */
const TITLE_GONE = 40;
/** The bar's title fades in over this stretch, as the large title leaves. */
const BAR_TITLE_FROM = 28;
const BAR_TITLE_TO = 48;

const styles = StyleSheet.create({
  screen: { flex: 1 },
  head: { paddingHorizontal: SCREEN_X, paddingTop: 2, paddingBottom: 10 },
});

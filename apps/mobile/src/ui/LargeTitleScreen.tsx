import { type NativeStackNavigationOptions, Stack, useIsFocused } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { type ReactElement, type ReactNode, useMemo } from "react";
import { Platform, type RefreshControlProps, StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeOutUp, LayoutAnimationConfig } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LivePause } from "@/agent/live";
import { CoverBarBackdrop, CoverParallax, FadingHeaderTitle, useCoverScroll, useScrollFade } from "./cover";
import { type HeaderAction, useHeaderActionOptions } from "./headerActions";
import { SCREEN_X } from "./rhythm";
import { Text } from "./Text";
import { useTheme } from "./theme";

export interface LargeTitleScreenProps {
  title: string;
  /** A line under the large title (it scrolls with the content). */
  subtitle?: string;
  /** Buttons in the bar (native bar buttons on iOS). */
  actions?: HeaderAction[];
  /** The bar's leading item (the person's avatar, which opens Você). */
  left?: ReactNode;
  /** Native buttons on the bar's leading side (iOS). */
  leftActions?: HeaderAction[];
  /** Under the large title, scrolling with it (Conversas: the greeting and what changed). */
  below?: ReactNode;
  /** Art behind the clear bar, the large title and `below` (Conversas: the sky). */
  backdrop?: ReactNode;
  children?: ReactNode;
  refreshControl?: ReactElement<RefreshControlProps>;
  /**
   * Drawn in the gap a pull-down opens above the content, where the system's wheel would be (pass the refresh
   * control a clear tint on iOS): the pixel orbit (`PullOrbit`).
   */
  pullMark?: ReactNode;
  /** Room under the content (default 24; the system already keeps content clear of the tab bar). */
  bottomInset?: number;
  /** The person starts scrolling the list (Conversas closes its open "Esperando você" card). */
  onScrollBeginDrag?: () => void;
  /**
   * The grouped gray background (settings-like screens) with white cards on it; the tabs, lists and chat
   * stay on the plain (white, in light) background.
   */
  grouped?: boolean;
  /**
   * The large title folded away and the bar's own title in its place (a search field under it took the focus, as
   * the system's search bar rises into the navigation); content that should slide up with it carries a
   * `LinearTransition` layout.
   */
  collapsed?: boolean;
}

/**
 * A tab's root screen (Conversas, Agentes, Atividade): the large title in Funnel Display is part of the
 * content and scrolls away with it; the bar's own title fades in as it goes (like Mail's). We draw it
 * rather than using the native large title: on iOS 26 inside the system tabs the native one stayed
 * expanded while the list scrolled under it. The bar is clear over the large title and
 * turns into the system glass (iOS 26 scroll edge; a blur before; on Android a fade into the screen's color
 * under the floating buttons) once content passes under it. Agents inside stop moving while the screen is not
 * showing.
 */
export function LargeTitleScreen({
  title,
  subtitle,
  actions,
  left,
  leftActions,
  below,
  backdrop,
  children,
  refreshControl,
  pullMark,
  bottomInset = 24,
  onScrollBeginDrag,
  grouped = false,
  collapsed = false,
}: LargeTitleScreenProps) {
  const { colors } = useTheme();
  const focused = useIsFocused();
  const headerHeight = useHeaderHeight();
  const safe = useSafeAreaInsets();
  // On iOS the scroll view is inset by the clear bar ourselves (contentInset, resting at minus the header
  // height): the automatic adjustment didn't apply inside the system tabs, so the list rested under the bar
  // with the large title hidden, shown only while pulled. Android lays it out from the top, under the bar.
  const { y, onScroll } = useCoverScroll(IOS ? headerHeight : 0);
  const titleFade = useScrollFade(y, 0, TITLE_GONE);
  const actionOptions = useHeaderActionOptions({ right: actions, left, leftActions });
  // Stable options: `setOptions` runs when the title or the actions change, not on every render.
  const options = useMemo<NativeStackNavigationOptions>(
    () => ({
      ...actionOptions,
      title,
      // Folded, the bar's plain title stands (no fade to drive; set, not left out, as options merge); else it fades
      // in as the large one leaves.
      headerTitle: collapsed
        ? title
        : () => <FadingHeaderTitle y={y} from={BAR_TITLE_FROM} to={BAR_TITLE_TO} text={title} />,
    }),
    [actionOptions, title, y, collapsed],
  );
  return (
    <View style={[styles.screen, { backgroundColor: grouped ? colors.grouped : colors.bg }]}>
      <Stack.Screen options={options} />
      <LivePause paused={!focused}>
        <Animated.ScrollView
          onScroll={onScroll}
          onScrollBeginDrag={onScrollBeginDrag}
          scrollEventThrottle={16}
          refreshControl={refreshControl}
          contentInsetAdjustmentBehavior="never"
          {...(IOS
            ? {
                contentInset: { top: headerHeight, bottom: safe.bottom + TAB_BAR },
                scrollIndicatorInsets: { top: headerHeight, bottom: safe.bottom + TAB_BAR },
                contentOffset: { x: 0, y: -headerHeight },
              }
            : {})}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingTop: IOS ? 0 : headerHeight, paddingBottom: bottomInset }}
        >
          {/* The art reaches up behind the clear bar and the status bar on both platforms (no band above it). */}
          <View style={backdrop ? { marginTop: -headerHeight, paddingTop: headerHeight } : undefined}>
            {/* As the agent's cover: it lags behind the list, and stretches into the gap a pull-down opens. */}
            {backdrop ? (
              <CoverParallax y={y} style={StyleSheet.absoluteFill}>
                {backdrop}
              </CoverParallax>
            ) : null}
            {/* The title shows at once when the screen opens; it fades only when it comes back after a search. */}
            <LayoutAnimationConfig skipEntering>
              {collapsed ? null : (
                <Animated.View entering={FadeIn.duration(200)} exiting={FadeOutUp.duration(180)}>
                  <Animated.View style={[styles.head, below ? styles.headTight : null, titleFade]}>
                    <Text variant="display" accessibilityRole="header" numberOfLines={1}>
                      {title}
                    </Text>
                    {subtitle ? (
                      <Text variant="small" tone="muted" style={styles.subtitle}>
                        {subtitle}
                      </Text>
                    ) : null}
                  </Animated.View>
                </Animated.View>
              )}
            </LayoutAnimationConfig>
            {below}
          </View>
          {children}
          {pullMark ? (
            // On iOS the content starts under the bar's inset: the gap opens above that.
            <View pointerEvents="none" style={[styles.pullMark, { top: -PULL_MARK - (IOS ? headerHeight : 0) }]}>
              {pullMark}
            </View>
          ) : null}
        </Animated.ScrollView>
      </LivePause>
      <CoverBarBackdrop y={y} from={0} to={12} height={headerHeight} tone={grouped ? colors.grouped : colors.bg} />
    </View>
  );
}

const IOS = Platform.OS === "ios";
/** Room for the system tab bar over the list's end (iOS; the floating bar and its margin), so the last row clears it. */
const TAB_BAR = 76;

/** Scroll (from rest) by which the large title has faded out under the bar. */
const TITLE_GONE = 40;
/** The bar's title fades in over this stretch, as the large title leaves. */
const BAR_TITLE_FROM = 28;
const BAR_TITLE_TO = 48;

/** The pull-down's gap, where the orbit sits (the system's wheel takes about as much). */
const PULL_MARK = 56;

const styles = StyleSheet.create({
  screen: { flex: 1 },
  // At the screen's sides (SCREEN_X), as the lists and cards under it.
  head: { paddingHorizontal: SCREEN_X, paddingTop: 2, paddingBottom: 10 },
  // Above the content's top edge: only a pull-down brings it into view (the system's wheel sits there too).
  pullMark: {
    position: "absolute",
    left: 0,
    right: 0,
    height: PULL_MARK,
    alignItems: "center",
    justifyContent: "center",
  },
  headTight: { paddingBottom: 4 },
  subtitle: { marginTop: 2 },
});

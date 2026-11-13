import { markTerms } from "@agenteschat/client/lib/search-filters";
import * as Clipboard from "expo-clipboard";
import { type NativeStackNavigationOptions, Stack, useIsFocused } from "expo-router";
import { type ReactNode, useLayoutEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Platform, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { needsHeaderBlur, TAB_BADGE } from "@/lib/nav";
import {
  BarPressable,
  Button,
  Count,
  coverBarOptions,
  fonts,
  GROUPED_ROW,
  GroupedList,
  HeaderCapsule,
  HeaderSlot,
  type HeaderSlotStore,
  haptics,
  Icon,
  type IconName,
  LivePause,
  Text,
  ToggleSwitch,
  textLineOf,
  useHeaderSlot,
  useScrollUnderPushedOptions,
  useTheme,
} from "@/ui";
import { withAlpha } from "@/ui/palette";
import { useFontScale } from "@/ui/text-scale";
import { leadBox } from "@/ui/type-scale";
import { useColors } from "./hooks";

/**
 * Small pieces the screens share that the design system doesn't have as
 * primitives: the icon tile, the action list of sheets, the bar of a pushed
 * screen, haptics and the clipboard.
 */

/** Mentions of me not read yet: the tab bar's red badge, as a channel's on the web. Nothing at zero. */
export function MentionCount({ count }: { count: number }) {
  const { t } = useTranslation();
  if (count <= 0) return null;
  return (
    <View accessible accessibilityLabel={t("shell.unreadMentions", { count })}>
      <Count value={count} max={99} inverted fill={TAB_BADGE.background} color={TAB_BADGE.text} />
    </View>
  );
}

/** The rounded square with an icon (channels, threads, missions, sheet actions). */
export function Tile({ icon, size = 36, children }: { icon?: IconName; size?: number; children?: ReactNode }) {
  const c = useColors();
  return (
    <View
      style={[
        styles.tile,
        { width: size, height: size, borderRadius: Math.round(size * 0.3), backgroundColor: c.sunken },
      ]}
    >
      {children ?? (icon ? <Icon name={icon} size={Math.round(size / 2)} color={c.muted} /> : null)}
    </View>
  );
}

export interface ActionItem {
  key: string;
  icon?: IconName;
  leading?: ReactNode;
  label: string;
  /** Search words lit in the label, as the web's results mark them. */
  marks?: readonly string[];
  hint?: string;
  /** The label and the hint each on one line, cut with an ellipsis (a pick list of names and roles). */
  oneLine?: boolean;
  /** A slash command shown on the right (`/mission`), in mono: it is code. */
  code?: string;
  trailing?: ReactNode;
  /** A switch on the right ("Seguir"): the row reads as one, checked or not. */
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onPress?: () => void;
}

/**
 * The list of actions in a sheet, a GroupedList (sheets sit on the grouped gray): an icon or a face in GroupedRow's
 * 32 pt column, the label, a hint under it; the text and the hairline above start together at 58.
 */
export function ActionList({ items }: { items: ActionItem[] }) {
  const c = useColors();
  return (
    <GroupedList>
      {items.map((it) => (
        <ActionRow
          key={it.key}
          item={it}
          // `leading`, as a GroupedRow's: GroupedList starts the hairline after its column.
          leading={
            it.leading ?? (it.icon ? <Icon name={it.icon} size={20} color={it.danger ? c.danger : c.muted} /> : null)
          }
        />
      ))}
    </GroupedList>
  );
}

/** One action, on a GroupedRow's numbers: 14 pt sides, the 32 pt leading column, 12 apart, 50 tall at least. */
function ActionRow({ item: it, leading }: { item: ActionItem; leading: ReactNode }) {
  const c = useColors();
  const fontScale = useFontScale();
  const line = textLineOf("body", fontScale);
  // A hint that may wrap: the icon and what is on the right stay on the label's line, not the row's middle.
  const tall = Boolean(it.hint) && !it.oneLine;
  const onLine = (size: number) => (tall ? leadBox(line, size) : null);
  const press = it.onPress;
  return (
    <Pressable
      // A switch answers the finger as it flips, as `GroupedRow`'s does.
      onPress={
        it.checked !== undefined && press
          ? () => {
              haptics.selection();
              press();
            }
          : press
      }
      disabled={it.disabled || !it.onPress}
      accessibilityRole={it.checked === undefined ? "button" : "switch"}
      {...(it.checked === undefined ? {} : { accessibilityState: { checked: it.checked } })}
      accessibilityLabel={it.hint ? `${it.label}. ${it.hint}` : it.label}
      style={({ pressed }) => [
        styles.action,
        tall && styles.actionTall,
        pressed && { backgroundColor: c.sunken },
        it.disabled && { opacity: 0.5 },
      ]}
    >
      {leading ? (
        <View style={styles.actionLead}>
          {tall && !it.leading ? <View style={onLine(20)}>{leading}</View> : leading}
        </View>
      ) : null}
      <View style={styles.actionText}>
        <Text variant="body" tone={it.danger ? "danger" : "ink"} {...(it.oneLine ? { numberOfLines: 1 } : {})}>
          {it.marks
            ? markTerms(it.label, it.marks).map((part, k) =>
                part.mark ? (
                  // biome-ignore lint/suspicious/noArrayIndexKey: segments of one fixed text
                  <Text key={k} variant="body" style={{ backgroundColor: withAlpha(c.info, 0.22) }}>
                    {part.text}
                  </Text>
                ) : (
                  part.text
                ),
              )
            : it.label}
        </Text>
        {it.hint ? (
          <Text variant="footnote" tone="faint" {...(it.oneLine ? { numberOfLines: 1 } : {})}>
            {it.hint}
          </Text>
        ) : null}
      </View>
      {it.code ? (
        <View style={tall ? [styles.onLine, { minHeight: line.height }] : null}>
          <Text style={[styles.mono, { color: c.faint }]}>{it.code}</Text>
        </View>
      ) : null}
      {it.trailing ? (
        <View style={tall ? [styles.onLine, { minHeight: line.height }] : null}>{it.trailing}</View>
      ) : null}
      {it.checked === undefined ? null : (
        <View style={onLine(28)}>
          <ToggleSwitch value={it.checked} />
        </View>
      )}
    </Pressable>
  );
}

const IOS = Platform.OS === "ios";
/** iOS 26's Liquid Glass bar (a saving word there is a prominent button). */
const liquidGlass = IOS && !needsHeaderBlur(Platform.OS, Platform.Version);

/**
 * The bar of a pushed screen, as the native header (react-native-screens): the system back chevron with
 * the edge swipe, a title (with a subtitle under it when given), an action on the right. Renders nothing
 * itself; it sets the screen's header options, so screens keep calling it where the bar used to be.
 * The bar is opaque by default (`solid`, content lays out below it); `solid={false}` makes content scroll
 * under it (glass on iOS 26, blur before; the screen's scroll view needs
 * `contentInsetAdjustmentBehavior="automatic"`); `plate` puts a clear bar over a full-bleed cover. On Android
 * the right actions float in a `HeaderCapsule` and the back button is a round plate (`usePushedOptions`);
 * its opaque bar takes the screen's color (`grouped`), so no band shows above a grouped gray screen.
 * `action` is a word on the right that saves (Conta's "OK"): the system's bar button on iOS (prominent on
 * iOS 26), our small primary button on Android.
 */
export function PushedHeader({
  title,
  subtitle,
  right,
  action,
  plate = false,
  solid = true,
  grouped = false,
}: {
  title?: ReactNode;
  subtitle?: string;
  right?: ReactNode;
  action?: HeaderWordAction;
  /** Over a sky cover: a clear bar, the back button over the art. */
  plate?: boolean;
  solid?: boolean;
  /** The screen sits on the grouped gray (the bar matches it where it is opaque: Android). */
  grouped?: boolean;
}) {
  const { colors } = useTheme();
  const scrollUnder = useScrollUnderPushedOptions();
  const barTone = grouped && Platform.OS === "android" ? colors.grouped : null;
  const text = typeof title === "string" ? title : "";
  const titleNode = useHeaderSlot(typeof title === "string" ? null : title);
  const rightNode = useHeaderSlot(right);
  const custom = Boolean(subtitle) || (title != null && typeof title !== "string");
  const hasRight = Boolean(right);
  // The action's press always reaches its latest handler; the options change only with its word and state.
  const press = useRef(action?.onPress);
  useLayoutEffect(() => {
    press.current = action?.onPress;
  });
  const word = action?.label ?? null;
  const wordOff = action?.disabled ?? false;
  // Stable options: `setOptions` runs when the title, subtitle or the presence of actions change, not on
  // every render of the screen (a conversation re-renders while agents stream).
  const options = useMemo<NativeStackNavigationOptions>(
    () => ({
      ...(plate ? coverBarOptions : solid ? {} : scrollUnder),
      ...(barTone && !plate ? { headerStyle: { backgroundColor: barTone } } : null),
      title: text,
      headerTitle: custom
        ? () => <HeaderTitle text={text} node={titleNode} subtitle={subtitle} beside={word !== null} />
        : text,
      ...(word !== null && IOS
        ? {
            unstable_headerRightItems: () => [
              {
                type: "button" as const,
                label: word,
                accessibilityLabel: word,
                variant: liquidGlass ? ("prominent" as const) : ("done" as const),
                disabled: wordOff,
                onPress: () => press.current?.(),
              },
            ],
          }
        : null),
      headerRight: hasRight
        ? () => (
            <BarPressable>
              <View style={styles.headerRight}>
                <HeaderCapsule>
                  <HeaderSlot slot={rightNode} />
                </HeaderCapsule>
              </View>
            </BarPressable>
          )
        : word !== null && !IOS
          ? () => (
              <View style={styles.headerRight}>
                <Button size="sm" variant="primary" label={word} disabled={wordOff} onPress={() => press.current?.()} />
              </View>
            )
          : undefined,
    }),
    [plate, solid, scrollUnder, barTone, text, custom, subtitle, titleNode, hasRight, rightNode, word, wordOff],
  );
  return <Stack.Screen options={options} />;
}

/** A word on the right of a pushed screen's bar that saves (`PushedHeader`'s `action`). */
export interface HeaderWordAction {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}

/**
 * A title with a subtitle under it, in the native bar (centered on iOS, leading on Android). `beside`: a word action
 * (Save) on the right, wider than the back button: the centered title keeps clear of it on both sides.
 */
function HeaderTitle({
  text,
  node,
  subtitle,
  beside = false,
}: {
  text: string;
  node: HeaderSlotStore;
  subtitle?: string | undefined;
  beside?: boolean;
}) {
  const { width } = useWindowDimensions();
  return (
    <View style={[styles.headerTitle, { maxWidth: width - (beside ? 200 : 150) }]}>
      {text ? (
        <Text variant="body" numberOfLines={1} style={styles.titleText}>
          {text}
        </Text>
      ) : (
        // A title of our own is pressable (the conversation's pill): its tap is its, not the bar's scroll to top.
        <BarPressable>
          <HeaderSlot slot={node} />
        </BarPressable>
      )}
      {subtitle ? (
        <Text variant="caption" tone="faint" numberOfLines={1}>
          {subtitle}
        </Text>
      ) : null}
    </View>
  );
}

export { goBack } from "@/ui/navigation";

/** A light tap under the thumb (long press, reactions, picks). */
export const tapHaptic = () => haptics.light();

/** Done: approved, sent. */
export const successHaptic = () => haptics.success();

/** Didn't work: a connection that failed. */
export const errorHaptic = () => haptics.error();

/** Puts a text on the clipboard; resolves false when the system refused. */
export function copyText(text: string): Promise<boolean> {
  return Clipboard.setStringAsync(text).then(
    (ok) => ok !== false,
    () => false,
  );
}

/** Code only (branches, commands). */
export const MONO = fonts.mono;

const LOADED_IN = FadeIn.duration(200);

/**
 * What comes in while the screen is watched (what it waited for, in its spinner's place; another tab's rows): it fades
 * in. The page holds it in a `LayoutAnimationConfig skipEntering` (`SettingsPage`, the account pages' `Page`), so what
 * had loaded before the screen opened is simply there; so is everything with reduced motion.
 */
export function Loaded({ children }: { children: ReactNode }) {
  const { reducedMotion } = useTheme();
  return <Animated.View entering={reducedMotion ? undefined : LOADED_IN}>{children}</Animated.View>;
}

/** A screen's one action, pinned under its scroll over the home indicator: always at hand, however long the list. */
export function BottomBar({ bottom, children }: { bottom: number; children: ReactNode }) {
  const c = useColors();
  return (
    <View style={[styles.bar, { paddingBottom: bottom + 10, backgroundColor: c.grouped, borderTopColor: c.line2 }]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { paddingHorizontal: 16, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth },
  tile: { alignItems: "center", justifyContent: "center" },
  action: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: GROUPED_ROW.minHeight,
    paddingHorizontal: GROUPED_ROW.padX,
    paddingVertical: GROUPED_ROW.padY,
  },
  // A wrapping hint: the label starts where a one-line row's does (its 22 points centred in 50), as GroupedRow's.
  actionTall: { alignItems: "flex-start", paddingVertical: 14 },
  onLine: { justifyContent: "center" },
  actionLead: { width: 32, alignItems: "center", justifyContent: "center" },
  actionText: { flex: 1, minWidth: 0 },
  mono: { fontFamily: MONO, fontSize: 13 },
  headerTitle: { alignItems: Platform.OS === "ios" ? "center" : "flex-start", minWidth: 0 },
  titleText: { fontWeight: "600" },
  headerRight: { flexDirection: "row", alignItems: "center" },
});

/**
 * A raised, neutral surface (the cards inside messages): raised background, the e1 shadow (e2 for what
 * asks for you: an approval) and lit top edge.
 */
export function useSurface(elevation: "e1" | "e2" = "e1") {
  const { colors, shadows } = useTheme();
  return useMemo(
    () => ({ backgroundColor: colors.raised, boxShadow: `${shadows[elevation]}, ${shadows.top}` }),
    [colors.raised, shadows, elevation],
  );
}

/** Agents inside stop moving while the screen is not showing (another screen is on top). */
export function FocusLive({ children }: { children: ReactNode }) {
  const focused = useIsFocused();
  return <LivePause paused={!focused}>{children}</LivePause>;
}

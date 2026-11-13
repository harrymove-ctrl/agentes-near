import type { ReactNode } from "react";
import { Platform, Pressable, type PressableProps, StyleSheet, type TextStyle, View } from "react-native";
import { Icon } from "./Icon";
import { Text, textLineOf } from "./Text";
import { useFontScale } from "./text-scale";
import { useTheme } from "./theme";
import { weights } from "./type-scale";

/** The avatar column of a full-width list row (52pt: an agent's body, a person's photo, a tile). */
export const LIST_AVATAR = 52;
/** The row's side margin: the screen's 16, as every list and card. */
const SIDE = 16;
/** The gap between the avatar and the text. */
const GAP = 12;
/** The unread dot sits nearer the text than the row's gap. */
const DOT_GAP = 10;
/** Where the hairline between rows starts: the text column (16 + 52 + 12 = 80). */
export const LIST_INSET = SIDE + LIST_AVATAR + GAP;

const IOS = Platform.OS === "ios";

/**
 * A row's second line on the app's type ruler: the `small` variant (15/20 on iOS, the subhead; Android its 14/20 body
 * medium) on a 20 line. For any text that sits in that line (a preview, what an agent is doing). It sets no size of
 * its own, so it grows with the person's text size like the rest of the row.
 */
export const LIST_PREVIEW: TextStyle = { lineHeight: 20 };
/** The time on line 1: the meta size (`TIME_VARIANT`), tabular figures. */
export const LIST_TIME: TextStyle = { fontVariant: ["tabular-nums"] };
/** The time's variant: the 13-point footnote on iOS, Android's 14 body medium as before. */
const TIME_VARIANT = IOS ? "footnote" : "small";

export interface ListRowProps extends Omit<PressableProps, "style" | "children"> {
  /** The 52pt avatar box's content. */
  leading: ReactNode;
  /** Line 1 (a string is drawn as the semibold name; bold when unread). */
  title: ReactNode;
  /** Lines of the title (default 1). */
  titleLines?: number;
  /** On the right of line 1 (the time, faint; darker when unread). */
  time?: string | null;
  /** A small faint line under the title (what and where: "Missão · #canal"). */
  over?: ReactNode;
  /** Line 2 (a string is drawn in the readable secondary color, up to two lines). */
  sub?: ReactNode;
  /** Lines of a string `sub` (default 2, 0: all of it). */
  subLines?: number;
  /** On the right of line 2 (a count badge, a state). */
  trailing?: ReactNode;
  /** A hairline above, inset to the text column (every row but the first). */
  divider?: boolean;
  /** A red dot on the right, centered on the row (unread), as messaging apps do. */
  dot?: boolean;
  /** Something new in it: the name bold, the time and the preview darker. */
  unread?: boolean;
  /** The row's own background (in a white card on grouped gray: `raised`). Default: clear. */
  background?: string;
  /** A chevron on the right, centered on the row: the row opens a screen of its own. */
  chevron?: boolean;
  /** Pinned on top: a small pin before the time, so what the person pinned reads as pinned. */
  pinned?: boolean;
}

/**
 * One full-width row of a list: no card, the
 * 52pt avatar, the semibold 17 name and the time (13) on line 1, the preview (15/20, up to two lines) with a badge or
 * state on line 2, hairlines inset to the text column at 80, 76pt tall with a one-line preview. Unread: bold name,
 * darker time and preview. Conversas, Atividade and Agentes use it.
 */
export function ListRow({
  leading,
  title,
  titleLines = 1,
  time,
  over,
  sub,
  subLines = 2,
  trailing,
  divider = false,
  dot = false,
  unread = false,
  background,
  chevron = false,
  pinned = false,
  ...press
}: ListRowProps) {
  const { colors: c } = useTheme();
  const fontScale = useFontScale();
  // The badge or state stays on the preview's first line: centred on a two-line preview it sat between lines.
  const previewLine = textLineOf("small", fontScale, LIST_PREVIEW).height;
  // The time likewise stays on the title's first line when the title takes two (Activity's sentences).
  const titleLine = textLineOf("title", fontScale).height;
  return (
    <Pressable
      {...press}
      style={({ pressed }) => [
        styles.row,
        background ? { backgroundColor: background } : null,
        pressed && { backgroundColor: c.sunken },
      ]}
    >
      {divider ? <View style={[styles.divider, { backgroundColor: c.line2 }]} /> : null}
      <View style={styles.avatar}>{leading}</View>
      <View style={styles.tx}>
        <View style={styles.l1}>
          {typeof title === "string" ? (
            <Text variant="title" numberOfLines={titleLines} style={[styles.shrink, unread && styles.unreadName]}>
              {title}
            </Text>
          ) : (
            <View style={styles.shrink}>{title}</View>
          )}
          {time || pinned ? (
            <View style={[styles.time, styles.timeRow, { minHeight: titleLine }]}>
              {pinned ? <Icon name="pin" size={12} color={c.faint} /> : null}
              <Text
                variant={TIME_VARIANT}
                tone={unread ? "ink2" : "faint"}
                style={[LIST_TIME, unread && styles.unreadTime]}
              >
                {time}
              </Text>
            </View>
          ) : null}
        </View>
        {over}
        {sub || trailing ? (
          <View style={styles.l2}>
            <View style={styles.grow}>
              {typeof sub === "string" ? (
                <Text variant="small" tone={unread ? "ink2" : "muted"} numberOfLines={subLines} style={LIST_PREVIEW}>
                  {sub}
                </Text>
              ) : (
                sub
              )}
            </View>
            {trailing ? <View style={[styles.trailing, { minHeight: previewLine }]}>{trailing}</View> : null}
          </View>
        ) : null}
      </View>
      {dot ? <View style={[styles.dot, { backgroundColor: c.badge }]} /> : null}
      {chevron ? <Icon name="right" size={15} color={c.faint} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: GAP,
    paddingVertical: 12,
    paddingHorizontal: SIDE,
    minHeight: 76,
  },
  divider: { position: "absolute", top: 0, left: LIST_INSET, right: 0, height: StyleSheet.hairlineWidth },
  dot: { width: 10, height: 10, borderRadius: 5, marginLeft: DOT_GAP - GAP },
  avatar: { width: LIST_AVATAR, height: LIST_AVATAR, alignItems: "center", justifyContent: "center" },
  tx: { flex: 1, minWidth: 0, gap: 2 },
  // The time and the badge stay on their line's first row when the name or the preview wraps.
  l1: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  l2: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  trailing: { justifyContent: "center" },
  grow: { flex: 1, minWidth: 0 },
  shrink: { flexShrink: 1 },
  unreadName: { fontWeight: weights.bold },
  time: { flexShrink: 0, marginLeft: "auto", justifyContent: "center" },
  timeRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  unreadTime: { fontWeight: weights.medium },
});

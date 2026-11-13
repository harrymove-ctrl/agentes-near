import { Children, createContext, Fragment, isValidElement, type ReactNode, useContext, useState } from "react";
import {
  ActivityIndicator,
  type LayoutChangeEvent,
  Pressable,
  type StyleProp,
  StyleSheet,
  View,
  type ViewStyle,
} from "react-native";
import { ACT_TEXT_MIN } from "./ActLine";
import { haptics } from "./haptics";
import { Icon, type IconName } from "./Icon";
import { LineIcon } from "./LineIcon";
import { withAlpha } from "./palette";
import { Text } from "./Text";
import { useTheme } from "./theme";
import { CHROME_MAX_SCALE } from "./type-scale";

/**
 * The sentence is the `small` variant (15/20): a hair under the messages' words (17), so the event reads as the
 * conversation's, not a voice, and it grows with the person's text size as they do. Its line, for the time beside it.
 */
const WORDS_LINE = 20;
/** Under the sentence (it took more than a line, or the phone is too narrow): the actions are words on its column. */
const UnderContext = createContext(false);
const MARK = 14;
/** The small controls' corner, cut at the bottom left (the app's "cut corner"). */
const RADIUS = 10;
const CUT = 3;

export interface EventPillProps {
  /** The event's mark, quiet: an icon's name (drawn faint), or a node of its own (a pixel mark). */
  mark: IconName | ReactNode;
  /** The mark's color when it is an icon (faint by default; a decided request's check in green). */
  markColor?: string;
  /** One sentence: what happened ("You stopped Ada", "Routine «Sentry» delivered a report"). It wraps. */
  children: ReactNode;
  /** When it happened, after the sentence ("14:16", "4 nov"). */
  time?: string;
  /** Its `EventPillAction`s (a list or a fragment; empty ones left out), inside the frame, each after a hairline. */
  actions?: ReactNode;
  /** Under the frame, never inside it: the opened text (`EventPillText`), a reason's field. */
  below?: ReactNode;
  /**
   * A request still waiting for someone: its sentence in ink (the breathing mark and a `primary` action say the rest).
   * The frame keeps its hairline, never a colored border.
   */
  waiting?: boolean;
  style?: StyleProp<ViewStyle>;
}

/**
 * An automatic event of a conversation (an agent stopped, a follow-up set, a routine's report, a decided request) as
 * one object: a thin frame holding the sentence, its time and what can be done about it. Never a voice, never a
 * card: no fill, one hairline, the small controls' corner cut at the bottom left; left aligned where the caller puts
 * it (the messages' text column). What opens text is an action like the others, with a chevron that turns.
 */
export function EventPill({ mark, markColor, children, time, actions, below, waiting = false, style }: EventPillProps) {
  const { colors: c } = useTheme();
  // On a phone two actions beside a sentence leave it no room: then they go on a row of their own, in the frame.
  const [room, setRoom] = useState(0);
  const [actionsWidth, setActionsWidth] = useState(0);
  const list = actionsOf(actions);
  // A sentence that takes more than one line beside its actions puts them under it: a tall column with one word in it
  // reads as a table. Once under, they stay (with the room they leave, the sentence might fit one line again).
  const [wraps, setWraps] = useState(false);
  const stacked = list.length > 0 && (wraps || (room > 0 && actionsWidth > 0 && room - actionsWidth < ACT_TEXT_MIN));
  const markNode =
    typeof mark === "string" ? (
      <LineIcon name={mark as IconName} size={MARK} color={markColor ?? c.faint} variant="small" />
    ) : (
      <LineIcon size={MARK} variant="small">
        {mark}
      </LineIcon>
    );
  return (
    <View style={[styles.pill, style]} onLayout={(e: LayoutChangeEvent) => setRoom(e.nativeEvent.layout.width)}>
      <View style={[styles.frame, stacked ? styles.frameStacked : null, { borderColor: c.line2 }]}>
        <View style={[styles.main, stacked ? null : styles.mainBeside]}>
          {markNode}
          <Text
            variant="small"
            tone={waiting ? "ink" : "ink2"}
            style={styles.words}
            onTextLayout={(e) => {
              if (!wraps && list.length > 0 && e.nativeEvent.lines.length > 1) setWraps(true);
            }}
          >
            {children}
          </Text>
          {time ? (
            <Text variant="caption" tone="faint" maxFontSizeMultiplier={CHROME_MAX_SCALE} style={styles.time}>
              {time}
            </Text>
          ) : null}
        </View>
        {list.length > 0 ? (
          <View style={stacked ? styles.under : styles.beside}>
            <View
              // Under the sentence, more actions than a phone's width (a request's four answers) wrap to a new line.
              style={[styles.actions, stacked ? styles.actionsWrap : null]}
              // Its own width, beside the sentence or under it: the measure that decides where it goes.
              onLayout={(e: LayoutChangeEvent) => setActionsWidth(e.nativeEvent.layout.width)}
            >
              {list.map((action, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the actions in order, each after its hairline
                <View key={i} style={stacked ? styles.slotUnder : styles.slot}>
                  {/* Beside the sentence, a hairline before each; under it, words on its column with no rule. */}
                  {stacked ? null : <View style={[styles.rule, { backgroundColor: c.line }]} />}
                  <UnderContext.Provider value={stacked}>{action}</UnderContext.Provider>
                </View>
              ))}
            </View>
          </View>
        ) : null}
      </View>
      {below}
    </View>
  );
}

/** The actions one by one: a fragment's own children, never the fragment as one. */
function actionsOf(actions: ReactNode): ReactNode[] {
  return Children.toArray(actions).flatMap((a) =>
    isValidElement<{ children?: ReactNode }>(a) && a.type === Fragment ? actionsOf(a.props.children) : [a],
  );
}

export interface EventPillActionProps {
  label: string;
  onPress: () => void;
  /** Before the label ("play" on Continue). */
  lead?: IconName;
  disabled?: boolean;
  /** Working on it: a spinner in the lead's place, and it can't be pressed again meanwhile. */
  loading?: boolean;
  /** It opens text under the pill ("Show", "See details"): a chevron after the label, turned while open. */
  expanded?: boolean;
  /**
   * What a request waiting for the viewer asks for ("Connect", "Continue now"): a soft attention tint behind the label
   * in ink, no border.
   */
  primary?: boolean;
  accessibilityHint?: string;
}

/** One action inside an `EventPill` ("Continue", "Add a reason", "Cancel", "Show"), after a hairline. */
export function EventPillAction({
  label,
  onPress,
  lead,
  disabled = false,
  loading = false,
  expanded,
  primary = false,
  accessibilityHint,
}: EventPillActionProps) {
  const { colors: c } = useTheme();
  const under = useContext(UnderContext);
  const opens = expanded !== undefined;
  // The attention color at 10%, 18% while pressed: the web's `--attention` mixed into nothing.
  const tint = (pressed: boolean) => withAlpha(c.amber, pressed ? 0.18 : 0.1);
  return (
    <Pressable
      onPress={() => {
        haptics.light();
        onPress();
      }}
      disabled={disabled || loading}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: disabled || loading, busy: loading, expanded: opens ? expanded : undefined }}
      // The frame is 32 points tall: the slop gives a finger its 44.
      hitSlop={{ top: 6, bottom: 6 }}
      style={({ pressed }) => [
        styles.action,
        // Under the sentence a word on its column; the primary keeps its tint, as a small plate.
        under ? (primary ? styles.actionUnderPrimary : styles.actionUnder) : null,
        primary ? { backgroundColor: tint(pressed) } : pressed ? { backgroundColor: c.plate } : null,
        disabled || loading ? styles.dim : null,
      ]}
    >
      {/* Each glyph in a box of the word's line, so it stays on the word's middle when the action sits on top. */}
      {loading ? (
        <View style={styles.onLine}>
          <ActivityIndicator size="small" color={primary ? c.ink : c.ink2} style={styles.spinner} />
        </View>
      ) : lead ? (
        <View style={styles.onLine}>
          <Icon name={lead} size={12} color={primary ? c.ink : c.ink2} />
        </View>
      ) : null}
      <Text variant="label" tone={primary ? "ink" : "ink2"} numberOfLines={1} maxFontSizeMultiplier={CHROME_MAX_SCALE}>
        {label}
      </Text>
      {opens ? (
        <View style={[styles.onLine, expanded ? styles.turned : undefined]}>
          <Icon name="right" size={12} color={c.faint} />
        </View>
      ) : null}
    </Pressable>
  );
}

/** The text an `EventPill` opens, under its frame: the conversation's quiet rule on its left. */
export function EventPillText({ children }: { children: ReactNode }) {
  const { colors: c } = useTheme();
  return <View style={[styles.text, { borderLeftColor: c.line }]}>{children}</View>;
}

const styles = StyleSheet.create({
  pill: { alignSelf: "stretch", alignItems: "flex-start", gap: 4 },
  frame: {
    flexDirection: "row",
    alignItems: "stretch",
    maxWidth: "100%",
    minHeight: 32,
    borderWidth: 1,
    borderTopLeftRadius: RADIUS,
    borderTopRightRadius: RADIUS,
    borderBottomRightRadius: RADIUS,
    borderBottomLeftRadius: CUT,
    // The pressed plate stays inside the corners.
    overflow: "hidden",
  },
  frameStacked: { flexDirection: "column" },
  // The mark and the time on the sentence's first line when it wraps.
  main: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    paddingVertical: 6,
    // The same room on both sides, as the web's pill.
    paddingHorizontal: 12,
  },
  mainBeside: { flexShrink: 1, minWidth: 0 },
  words: { flexShrink: 1, minWidth: 0 },
  time: { lineHeight: WORDS_LINE, fontVariant: ["tabular-nums"] },
  beside: { flexShrink: 0, flexDirection: "row" },
  // Under the sentence: on its column (the frame's 12, the mark, the 8 after it), no hairline. Its label's line ends 7
  // from the frame's outer edge (1 + 5 of the 28 + the border), as the sentence's line starts 7 from the top (6 + 1).
  under: { alignItems: "flex-start", paddingLeft: 12 + MARK + 8, paddingBottom: 1, marginTop: -2 },
  actions: { flexDirection: "row", alignItems: "stretch", minHeight: 30 },
  actionsWrap: { flexWrap: "wrap" },
  // An action with the hairline before it: one piece, so a wrap never leaves a hairline alone at a line's end.
  slot: { flexDirection: "row", alignItems: "stretch", minHeight: 30 },
  rule: { width: 1 },
  action: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 12 },
  // A word on the sentence's column: no plate of its own but the press, 16 between two.
  actionUnder: { paddingHorizontal: 0, minHeight: 28, borderRadius: 6 },
  slotUnder: { flexDirection: "row", marginRight: 16 },
  actionUnderPrimary: { paddingHorizontal: 10, minHeight: 28, borderRadius: 8 },
  onLine: { height: 18, justifyContent: "center" },
  spinner: { transform: [{ scale: 0.7 }] },
  dim: { opacity: 0.6 },
  turned: { transform: [{ rotate: "90deg" }] },
  text: { marginLeft: 10, paddingLeft: 12, borderLeftWidth: 2 },
});

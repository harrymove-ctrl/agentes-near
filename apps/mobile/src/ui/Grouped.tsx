import { Children, isValidElement, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeOut, LayoutAnimationConfig, LinearTransition } from "react-native-reanimated";
import { haptics } from "./haptics";
import { Icon, type IconName } from "./Icon";
import { useInfoHint } from "./InfoHint";
import { MEDIA_ROW } from "./media-row";
import { GROUPED_ROW } from "./rhythm";
import { Text, textLineOf } from "./Text";
import { ToggleSwitch } from "./Toggle";
import { useFontScale } from "./text-scale";
import { motion, useTheme } from "./theme";
import { leadBox } from "./type-scale";

/**
 * The leading column of a row with a face or a mark: whatever leads is centered in it. As wide as a framed face (36,
 * the smaller of the two framed sizes), so a face never spills into the gap before the text.
 */
const LEAD = 36;
/** A row's icon tile; its corner is 30% of it, as every tile's. */
// 32 in the 36 column: 18 from the card's side and 10 from the row's top and bottom, so the tile sits square in its
// corner of the card instead of hugging the top.
const TILE = 32;

/** How far a nested row (`tree`: a phone under its computer) moves in, and where its branch line runs. */
const NEST = 24;
/** The trunk runs down the middle of the lead column, under the computer's portrait. */
const TREE_X = GROUPED_ROW.padX + LEAD / 2;
/** The branch meets a nested row at its 48-point portrait's middle. */
const TREE_ELBOW = GROUPED_ROW.tallPadY + 24;
/** The branch's curve into the nested row; a `mid` row's trunk carries on from where the curve leaves it. */
const TREE_CURVE = 6;

/** A row that comes or goes while the list is on screen fades; what is around it slides into place. */
const ROW_IN = FadeIn.duration(motion.fast);
const ROW_OUT = FadeOut.duration(motion.fast);
const SLIDE = LinearTransition.duration(motion.base);

/**
 * Whether a row of the list has a leading column (an icon's tile, a face): read off the row itself, or off the row a
 * swipe (`SwipeRow`) or an opaque view wraps, so a swipeable row keeps its hairline where the others start.
 */
function leads(props: unknown, depth = 0): boolean {
  if (!props || typeof props !== "object" || depth > 2) return false;
  const p = props as { icon?: unknown; leading?: unknown; children?: unknown };
  if (p.icon || p.leading) return true;
  const inner = isValidElement(p.children) ? p.children.props : null;
  return inner ? leads(inner, depth + 1) : false;
}

/** A nested row's hairline starts at its own text, moved in with it. */
const nests = (props: unknown) => {
  const tree = (props as { tree?: unknown } | null)?.tree;
  return tree === "mid" || tree === "end";
};

/**
 * Settings as on the iPhone: grouped inset lists, radius 14, hairlines inset to
 * the text, an uppercase faint header above and a faint footer below. With no
 * rows it draws nothing, never an empty card.
 */
export function GroupedList({ children }: { children?: ReactNode }) {
  const { colors: c, shadows, reducedMotion } = useTheme();
  const items = Children.toArray(children).filter(isValidElement);
  if (items.length === 0) return null;
  return (
    // The rows it opens with appear with the screen, and when the whole group goes its rows go with it: neither fades.
    <LayoutAnimationConfig skipEntering skipExiting>
      <Animated.View
        layout={reducedMotion ? undefined : SLIDE}
        style={[styles.list, { backgroundColor: c.raised, boxShadow: `${shadows.e1}, ${shadows.top}` }]}
      >
        {items.map((child, i) => (
          <Animated.View
            key={child.key ?? i}
            entering={reducedMotion ? undefined : ROW_IN}
            exiting={reducedMotion ? undefined : ROW_OUT}
            layout={reducedMotion ? undefined : SLIDE}
          >
            {i > 0 ? (
              <View
                style={[
                  styles.divider,
                  {
                    backgroundColor: c.line2,
                    // A tile and a face share one leading column, so the text and its hairline start at one place.
                    marginLeft:
                      (leads(child.props) ? GROUPED_ROW.padX + LEAD + 12 : GROUPED_ROW.padX) +
                      (nests(child.props) ? NEST : 0),
                  },
                ]}
              />
            ) : null}
            {child}
          </Animated.View>
        ))}
      </Animated.View>
    </LayoutAnimationConfig>
  );
}

interface GroupedHeaderProps {
  children: string;
  aside?: ReactNode;
  /** An ⓘ after the header's words with what the whole group is for; its text shows under the header. */
  hint?: { name: string; text: string };
}

/**
 * The small uppercase header of a group (it slides with the groups when one above grows or shrinks), with `aside`
 * at the end of its line: a small text action.
 */
export function GroupedHeader({ children, aside, hint }: GroupedHeaderProps) {
  const { reducedMotion } = useTheme();
  if (hint)
    return (
      <HintedHeader aside={aside} hint={hint}>
        {children}
      </HintedHeader>
    );
  return (
    <Animated.View layout={reducedMotion ? undefined : SLIDE} style={aside ? styles.headerRow : null}>
      <Text variant="footnote" tone="faint" accessibilityRole="header" style={[styles.header, styles.shrink]}>
        {children.toLocaleUpperCase()}
      </Text>
      {aside ? <View style={styles.headerAside}>{aside}</View> : null}
    </Animated.View>
  );
}

/** The header's words and ⓘ on one line, the aside at its end, the hint's text under them inside the header's room. */
function HintedHeader({ children, aside, hint }: GroupedHeaderProps & { hint: { name: string; text: string } }) {
  const { reducedMotion } = useTheme();
  const info = useInfoHint({ ...hint, variant: "footnote" });
  return (
    <Animated.View layout={reducedMotion ? undefined : SLIDE} style={styles.headerRoom}>
      <View style={styles.headerLine}>
        <View style={[styles.headerWords, styles.shrink]}>
          <Text variant="footnote" tone="faint" accessibilityRole="header" style={[styles.headerCaps, styles.shrink]}>
            {children.toLocaleUpperCase()}
          </Text>
          {info.button}
        </View>
        {aside}
      </View>
      {info.text}
    </Animated.View>
  );
}

/** The faint explanation under a group. */
export function GroupedFooter({ children }: { children: ReactNode }) {
  const { reducedMotion } = useTheme();
  return (
    <Animated.View layout={reducedMotion ? undefined : SLIDE}>
      <Text variant="footnote" tone="faint" style={styles.footer}>
        {children}
      </Text>
    </Animated.View>
  );
}

export interface GroupedRowProps {
  label: string;
  /**
   * The label in parts, the ones that matched what was typed in semibold (Novo's filter); the same words as `label`,
   * which still names the row for VoiceOver.
   */
  labelParts?: readonly { text: string; mark?: boolean }[];
  /** Lines the label may take (default 1): a setting's long name beside its switch. */
  labelLines?: number;
  /** A small line under the label. */
  sub?: string;
  /** Lines the small line may take (default 1). */
  subLines?: number;
  /** Under the small line, in the text column (a second line of facts). */
  below?: ReactNode;
  /** A line of facts under the small line, in faint, read out with the label (a `below` node is not). */
  belowText?: string;
  /** A rounded tile with this icon on the left. */
  icon?: IconName;
  /** Anything else on the left (an organization's tile). */
  leading?: ReactNode;
  /** The value on the right, faint ("Ligadas"). */
  value?: string;
  /** A short fact about the value, after it on its line ("Pela API"); a sentence goes in `sub`. */
  valueNote?: string;
  /** Drawn just before the value (a picked agent's face, a format's glyph). */
  valueLeading?: ReactNode;
  /**
   * The value changes in its row through the system's choice (an action list), not on a screen: the small up-down
   * mark after the value, where a chevron would be.
   */
  menu?: boolean;
  /** A chevron: it opens a screen. */
  chevron?: boolean;
  /** Three dots: it opens a sheet of actions. */
  more?: boolean;
  /** A checkmark: the chosen option. */
  checked?: boolean;
  /** A switch on the right (the whole row toggles). */
  toggle?: boolean;
  danger?: boolean;
  /** The label in faint: something listed that won't count. */
  faint?: boolean;
  disabled?: boolean;
  onPress?: () => void;
  /** An ⓘ right after the label: a tap on it shows the note under the row and never presses the row. */
  hint?: { name: string; text: string };
  /** An × at the row's end that takes it off the list; VoiceOver merges it into the row, so it is the row's action too. */
  remove?: { label: string; onPress: () => void };
  /**
   * The web's MediaRow: the lead, the label and what ends it on one line, `sub` and `below` under them at the row's
   * full width. For a row whose lead would otherwise sit beside three lines or more.
   */
  media?: boolean;
  /**
   * A tree of rows (phones under the computer they're plugged into): `host` draws the trunk down from its portrait,
   * `mid` and `end` move in and branch off it (`end` closes the trunk).
   */
  tree?: "host" | "mid" | "end";
}

/** One row of a group: icon tile, label, the value in faint, a chevron, a check or a switch. */
export function GroupedRow(props: GroupedRowProps) {
  return props.hint ? <HintedRow {...props} hint={props.hint} /> : <Row {...props} />;
}

/** VoiceOver merges a button inside the row's button into it: the row reads the note out with its label. */
function HintedRow({ hint, ...props }: GroupedRowProps & { hint: { name: string; text: string } }) {
  // On the label's first line, also when the label wraps.
  const info = useInfoHint({ ...hint, variant: "body" });
  return (
    <View>
      <Row {...props} said={hint.text} labelAfter={info.button} />
      <View style={[styles.hint, info.open ? styles.hintOpen : null]}>{info.text}</View>
    </View>
  );
}

function Row({
  label,
  labelParts,
  labelLines = 1,
  sub,
  subLines = 1,
  below,
  belowText,
  icon,
  leading,
  value,
  valueNote,
  valueLeading,
  chevron = false,
  menu = false,
  more = false,
  checked,
  toggle,
  danger = false,
  faint = false,
  disabled = false,
  onPress,
  remove,
  media = false,
  tree,
  said,
  labelAfter,
}: Omit<GroupedRowProps, "hint"> & { said?: string; labelAfter?: ReactNode }) {
  const { colors: c } = useTheme();
  const fontScale = useFontScale();
  const tone = danger ? c.danger : faint ? c.faint : c.ink;
  // A switch answers the finger as it flips, as `Toggle` does.
  const press =
    toggle !== undefined && onPress
      ? () => {
          haptics.selection();
          onPress();
        }
      : onPress;
  // What goes under the label goes under the lead too: the lead, the label and the end share one centred line.
  const flat = media && Boolean(icon || leading) && Boolean(sub || below || belowText);
  // Text that can take more than one line: the tile sits at the top and what is on the right stays on the
  // label's line (centred on the whole row it floated between lines). One-line rows keep everything centred.
  const tall = !flat && (labelLines > 1 || subLines > 1 || Boolean(below) || Boolean(belowText));
  const line = tall ? textLineOf("body", fontScale) : null;
  const onLine = (size: number) => (line ? [leadBox(line, size), styles.onLine] : null);
  const lead = (
    <>
      {/* One column for whatever leads (an icon's tile, a 24 to 36 face, a mark): the text, and the hairline above,
          start at 64 in every row, so a list mixing tiles and faces reads as one column. */}
      {icon ? (
        <View style={styles.lead}>
          <View style={[styles.tile, { backgroundColor: danger ? c.plate : c.sunken }]}>
            <Icon name={icon} size={16} color={danger ? c.danger : c.ink2} />
          </View>
        </View>
      ) : null}
      {leading ? <View style={styles.lead}>{leading}</View> : null}
    </>
  );
  const labelText = (
    <>
      {labelAfter ? (
        <View style={styles.labelLine}>
          <Text variant="body" numberOfLines={labelLines} style={[styles.shrink, { color: tone }]}>
            {labelParts
              ? labelParts.map((part, i) =>
                  part.mark ? (
                    // biome-ignore lint/suspicious/noArrayIndexKey: segments of one fixed text
                    <Text key={i} variant="body" style={[{ color: tone }, styles.marked]}>
                      {part.text}
                    </Text>
                  ) : (
                    part.text
                  ),
                )
              : label}
          </Text>
          {labelAfter}
        </View>
      ) : (
        <Text variant="body" numberOfLines={labelLines} style={{ color: tone }}>
          {labelParts
            ? labelParts.map((part, i) =>
                part.mark ? (
                  // biome-ignore lint/suspicious/noArrayIndexKey: segments of one fixed text
                  <Text key={i} variant="body" style={[{ color: tone }, styles.marked]}>
                    {part.text}
                  </Text>
                ) : (
                  part.text
                ),
              )
            : label}
        </Text>
      )}
    </>
  );
  const under = (
    <>
      {sub ? (
        <Text variant="footnote" tone="faint" numberOfLines={subLines}>
          {sub}
        </Text>
      ) : null}
      {below}
      {belowText ? (
        <Text variant="footnote" tone="faint" numberOfLines={2}>
          {belowText}
        </Text>
      ) : null}
    </>
  );
  const end = (
    <>
      {valueLeading || valueNote ? (
        <View
          style={[
            styles.value,
            styles.valued,
            valueNote ? styles.noted : null,
            line ? { minHeight: line.height } : null,
          ]}
        >
          {valueLeading}
          {value ? (
            <Text variant="callout" tone="faint" numberOfLines={1} style={styles.shrink}>
              {value}
            </Text>
          ) : null}
          {valueNote ? (
            <Text variant="footnote" tone="faint" numberOfLines={1}>
              {valueNote}
            </Text>
          ) : null}
        </View>
      ) : value ? (
        <View style={[styles.value, line ? { minHeight: line.height, justifyContent: "center" } : null]}>
          <Text variant="callout" tone="faint" numberOfLines={1} style={styles.shrink}>
            {value}
          </Text>
        </View>
      ) : null}
      {menu ? (
        <View style={onLine(14)}>
          <Icon name="swap" size={14} color={c.faint} />
        </View>
      ) : null}
      {checked ? (
        <View style={onLine(18)}>
          <Icon name="check" size={18} color={c.ink} />
        </View>
      ) : null}
      {toggle !== undefined ? (
        <View style={onLine(28)}>
          <ToggleSwitch value={toggle} />
        </View>
      ) : null}
      {chevron ? (
        <View style={onLine(15)}>
          <Icon name="right" size={15} color={c.faint} />
        </View>
      ) : null}
      {more ? (
        <View style={onLine(18)}>
          <Icon name="more" size={18} color={c.faint} />
        </View>
      ) : null}
      {remove ? (
        <Pressable onPress={remove.onPress} accessibilityRole="button" accessibilityLabel={remove.label} hitSlop={12}>
          <Icon name="x" size={16} color={c.faint} />
        </Pressable>
      ) : null}
    </>
  );
  return (
    <Pressable
      onPress={press}
      disabled={disabled || !onPress}
      accessibilityRole={toggle !== undefined ? "switch" : "button"}
      accessibilityLabel={[label, belowText, said, value, valueNote].filter(Boolean).join(", ")}
      {...(remove
        ? {
            accessibilityActions: [{ name: "delete", label: remove.label }],
            onAccessibilityAction: remove.onPress,
          }
        : {})}
      accessibilityState={{
        disabled,
        ...(toggle !== undefined ? { checked: toggle } : {}),
        ...(checked !== undefined ? { selected: checked } : {}),
      }}
      style={({ pressed }) => [
        styles.row,
        flat ? styles.media : tall ? styles.tall : null,
        tree === "mid" || tree === "end" ? styles.nested : null,
        pressed && onPress ? { backgroundColor: c.sunken } : null,
      ]}
    >
      {tree ? <TreeLines tree={tree} color={c.line2} /> : null}
      {flat ? (
        <>
          <View style={styles.mediaHead}>
            {lead}
            <View style={styles.grow}>{labelText}</View>
            {end}
          </View>
          <View>{under}</View>
        </>
      ) : (
        <>
          {lead}
          <View style={styles.grow}>
            {labelText}
            {under}
          </View>
          {end}
        </>
      )}
    </Pressable>
  );
}

/** The trunk and the branch beside a nested row: hairlines in the list's divider color. */
function TreeLines({ tree, color }: { tree: NonNullable<GroupedRowProps["tree"]>; color: string }) {
  if (tree === "host") return <View pointerEvents="none" style={[styles.trunkHost, { backgroundColor: color }]} />;
  return (
    <>
      {tree === "mid" ? <View pointerEvents="none" style={[styles.trunk, { backgroundColor: color }]} /> : null}
      <View pointerEvents="none" style={[styles.branch, { borderColor: color }]} />
    </>
  );
}

interface GroupedFieldProps {
  label: string;
  /** An ⓘ right after the label, with the field's explanation. */
  hint?: { name: string; text: string };
  children: ReactNode;
  onPress?: () => void;
}

/**
 * A labeled field row ("Nome", "Seu @"): the label in a fixed column, the value or an input after it;
 * with `onPress`, the whole row opens a screen (a chevron on the right).
 */
export function GroupedField({ label, hint, children, onPress }: GroupedFieldProps) {
  const { colors: c } = useTheme();
  if (hint)
    return (
      <HintedField label={label} hint={hint} onPress={onPress}>
        {children}
      </HintedField>
    );
  const body = (
    <>
      <Text variant="callout" tone="muted" style={styles.key}>
        {label}
      </Text>
      <View style={styles.grow}>{children}</View>
      {onPress ? <Icon name="right" size={15} color={c.faint} /> : null}
    </>
  );
  if (!onPress) return <View style={styles.field}>{body}</View>;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.field, pressed ? { backgroundColor: c.sunken } : null]}
    >
      {body}
    </Pressable>
  );
}

/**
 * A field whose label has an ⓘ. With `onPress` the row's button lies under the label and the value rather than
 * around them: inside another button the ⓘ would be part of it to VoiceOver, never a button of its own.
 */
function HintedField({ label, hint, children, onPress }: GroupedFieldProps & { hint: { name: string; text: string } }) {
  const { colors: c } = useTheme();
  const info = useInfoHint({ ...hint, variant: "callout" });
  const passive = onPress ? "none" : "auto";
  return (
    <View>
      <View style={styles.field}>
        {onPress ? (
          <Pressable
            onPress={onPress}
            accessibilityRole="button"
            accessibilityLabel={label}
            style={({ pressed }) => [StyleSheet.absoluteFill, pressed ? { backgroundColor: c.sunken } : null]}
          />
        ) : null}
        <View style={[styles.key, styles.keyLine]} pointerEvents="box-none">
          <View
            pointerEvents={passive}
            style={styles.shrink}
            accessibilityElementsHidden={Boolean(onPress)}
            importantForAccessibility={onPress ? "no-hide-descendants" : "auto"}
          >
            <Text variant="callout" tone="muted">
              {label}
            </Text>
          </View>
          {info.button}
        </View>
        <View style={styles.grow} pointerEvents={passive}>
          {children}
        </View>
        {onPress ? (
          <View pointerEvents="none">
            <Icon name="right" size={15} color={c.faint} />
          </View>
        ) : null}
      </View>
      <View style={[styles.hint, info.open ? styles.hintOpen : null]}>{info.text}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  marked: { fontWeight: "600" },
  list: { borderRadius: 14, overflow: "hidden" },
  divider: { height: StyleSheet.hairlineWidth },
  header: { paddingTop: 20, paddingBottom: 8, paddingHorizontal: 16, letterSpacing: 0.4 },
  headerRoom: { paddingTop: 20, paddingBottom: 8, paddingHorizontal: 16 },
  headerLine: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 8 },
  headerWords: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  headerCaps: { letterSpacing: 0.4 },
  headerRow: { flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between" },
  headerAside: { paddingRight: 16 },
  footer: { paddingTop: 8, paddingHorizontal: 16 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: GROUPED_ROW.minHeight,
    paddingHorizontal: GROUPED_ROW.padX,
    paddingVertical: GROUPED_ROW.padY,
  },
  nested: { paddingLeft: GROUPED_ROW.padX + NEST },
  // From just under the drawing (a laptop's base, a tower's foot), not the bottom of its 48-point box.
  trunkHost: { position: "absolute", left: TREE_X, top: GROUPED_ROW.tallPadY + 45, bottom: 0, width: 1 },
  trunk: { position: "absolute", left: TREE_X, top: TREE_ELBOW - TREE_CURVE, bottom: 0, width: 1 },
  branch: {
    position: "absolute",
    left: TREE_X,
    top: 0,
    width: 8,
    height: TREE_ELBOW,
    borderLeftWidth: 1,
    borderBottomWidth: 1,
    borderBottomLeftRadius: TREE_CURVE,
  },
  // Wrapping text starts where a one-line row's label does, not 8 from the top.
  tall: { alignItems: "flex-start", paddingVertical: GROUPED_ROW.tallPadY },
  media: { flexDirection: "column", alignItems: "stretch", gap: MEDIA_ROW.under },
  mediaHead: { flexDirection: "row", alignItems: "center", gap: 12 },
  // A control taller than the label's line (the 28-point switch) is centred on it rather than pushed below it.
  onLine: { justifyContent: "center" },
  tile: {
    width: TILE,
    height: TILE,
    borderRadius: Math.round(TILE * 0.3),
    alignItems: "center",
    justifyContent: "center",
  },
  lead: { width: LEAD, alignItems: "center", justifyContent: "center" },
  grow: { flex: 1, minWidth: 0 },
  labelLine: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  value: { flexShrink: 1, maxWidth: "50%" },
  valued: { flexDirection: "row", alignItems: "center", gap: 6 },
  // A note that doesn't fit beside its value goes under it, so the value isn't cut for it.
  noted: { flexWrap: "wrap", justifyContent: "flex-end" },
  field: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: GROUPED_ROW.minHeight,
    paddingHorizontal: GROUPED_ROW.padX,
  },
  key: { width: 96 },
  keyLine: { flexDirection: "row", alignItems: "flex-start", gap: 4 },
  shrink: { flexShrink: 1, minWidth: 0 },
  hint: { paddingHorizontal: GROUPED_ROW.padX },
  hintOpen: { paddingBottom: 12 },
});

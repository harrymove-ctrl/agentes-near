import { applyFormat, FORMAT_KINDS, type FormatKind } from "@agenteschat/ui/format";
import { Canvas, Group, Path, Skia, vec } from "@shopify/react-native-skia";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Platform,
  Text as RNText,
  ScrollView,
  StyleSheet,
  TextInput,
  type TextInputInstance,
  type TextStyle,
  View,
} from "react-native";
import {
  GestureDetector,
  useExclusiveGestures,
  useLongPressGesture,
  useTapGesture,
} from "react-native-gesture-handler";
import Animated, {
  cancelAnimation,
  Easing,
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withSpring,
  withTiming,
  ZoomIn,
  ZoomOut,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { PixelStop } from "@/agent/PixelMarks";
import { readValueSync, STORED, writeValueSync } from "@/lib/storage";
import { Glass } from "./Glass";
import { haptics } from "./haptics";
import { Icon, type IconName } from "./Icon";
import { PressScale } from "./PressScale";
import { systemText } from "./Text";
import { useTheme } from "./theme";
import { CHROME_MAX_SCALE, weights } from "./type-scale";

/** The "@" being typed and how to finish it (the screen draws the picker). */
/** The "@" (or, with `sigil: "#"`, the channel) being typed right before the caret. */
export interface ComposerToken {
  start: number;
  query: string;
  sigil?: "#";
}

export interface ComposerMentionState {
  /** What follows "@" ("th"), or "#" when `sigil` says so. */
  query: string;
  sigil?: "#";
  /** Replaces "@th" with "@handle " and puts the caret after it. */
  pick: (handle: string) => void;
}

/**
 * How a message goes while an agent works: "join" reaches it at its next pause (a tap on send), "now"
 * makes it stop what it is doing and read the message at once (the send button held). Without an agent at work it is "join".
 */
export type SendHow = "join" | "now";

/**
 * An agent at work in the conversation: with text, the choice shows (to anyone who writes there); the empty
 * field's button stops it, only for who may stop it (`stop` is left out otherwise).
 */
export interface ComposerWorking {
  stop?: {
    /** The stop button's label ("Parar o Theo"). */
    label: string;
    onStop: () => void;
  };
}

export interface ComposerProps {
  placeholder: string;
  onSend: (text: string, how: SendHow) => void;
  /** Someone is working here (null otherwise). */
  working?: ComposerWorking | null;
  /** The "+" for attachments and actions; left out where there are none (the agent's computer). */
  onPlus?: () => void;
  /**
   * Pills above the field while it is empty; tapping one puts its `text` (default: the `label`) in the field
   * ("Pedir revisão do Caio" fills "Pede para o Caio revisar antes").
   */
  suggestions?: { icon: IconName; label: string; text?: string }[];
  /** The field's `nativeID` (the chat links it to the keyboard's drag-to-dismiss area). */
  inputNativeID?: string;
  /** A small face inside the empty field, before the placeholder (a DM with an agent: who you write to). */
  face?: ReactNode;
  /** While "@…" is typed right before the caret (and the field is focused): the card above the field. */
  mention?: (state: ComposerMentionState) => ReactNode;
  /** The "@" (or "#") token at the caret (`mentionQuery`); the composer doesn't know the rules itself. */
  mentionAt?: (text: string, caret: number) => ComposerToken | null;
  /** The text after a pick (`insertMention`). */
  insertMention?: (text: string, token: ComposerToken, handle: string) => { text: string; caret: number };
  /**
   * Text handed in from another screen ("Falar com o Theo" leaves "@theo " here): put in the field when it is
   * empty, and the field focused. Once per request (`at`).
   */
  prefill?: { text: string; at: number } | null;
  /** A change here brings the keyboard up ("Responder" on a message). */
  focusAt?: number;
  /** Right above the field ("Respondendo a Ana"). */
  banner?: ReactNode;
  /** Something waits above the field to go with the message (photos, files): send shows and sends with no words. */
  sendEmpty?: boolean;
  /** Each change that leaves text in the field ("está digitando…" for the others; the screen throttles it). */
  onType?: (text: string) => void;
  /**
   * Where the words wait when the person leaves before sending (a conversation, a thread): they are back in the field
   * when the person returns, until sent or erased. Kept while the app runs.
   */
  draftKey?: string;
  /** The button in the empty field that opens the GIFs and stickers (null where neither can be sent). */
  media?: { label: string; onPress: () => void } | null;
  /**
   * Voice messages (null where they are off): `mic` in the empty field; while the mic is held, `overlay` covers the
   * field. Hands free or paused, `bar` takes the field's place in the field's own capsule (same height, radius, ring
   * and inset), and `leading` is drawn in the "+"'s own plate; `above` sits over the row (the slide-to-cancel hint,
   * the recording line). The text field stays mounted underneath, so the composer never changes height.
   */
  voice?: {
    mic: ReactNode | null;
    overlay: ReactNode | null;
    bar: ReactNode | null;
    leading: { icon: IconName; label: string; onPress: () => void } | null;
    above: ReactNode | null;
    active: boolean;
  } | null;
}

/** The pill's height, the "+" and the send button's. */
const FIELD = 48;
const SEND = 36;
/** Space around the send button inside the pill: it sits centered on the first line. */
const INSET = (FIELD - SEND) / 2;
/** The field's ring and its soft shadow; a voice take's bar wears the same. */
const FIELD_SHADOW = (line: string) => `0px 0px 0px 0.5px ${line}, 0px 6px 18px -10px rgba(0, 0, 0, 0.25)`;
/** How long the send button is held to stop the agent and send; the ring around it fills meanwhile. */
/** Words left in a conversation's field, by `draftKey`, while the app runs. */
const DRAFTS = new Map<string, string>();

const HOLD_SEND_MS = 600;
const RING = 44;
const RING_PATH = (() => {
  // Paths are immutable in this Skia: they are made with a builder.
  const path = Skia.PathBuilder.Make();
  path.addCircle(RING / 2, RING / 2, RING / 2 - 2);
  return path.build();
})();
const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);

/**
 * The center of the app: a round glass "+" for attachments and actions,
 * then the field, a raised pill. Empty, it can show who you write to (a small face) before the
 * placeholder; with text, the round ink send button pops in. One line keeps "+", text and send on the
 * same center line; longer text grows the pill upward and everything stays at the bottom. GIFs and stickers (`media`)
 * have their button at the empty field's end: they go as a message of their own, never with words.
 * Formatting has no button in the row: while words are selected in the field, a bar of them (bold, italic, lists…)
 * shows right over it and writes Markdown around the selection, which stays selected.
 *
 * While an agent works: the empty field's button is "Parar" (a rounded square), one
 * tap and it stops, no question asked (what it did stays and can continue); with text, a tap on send joins
 * what it is doing and holding the button (a ring of ink fills around it) stops it and sends. A light tap on
 * send, a firm one on stop. A line under the field says so until the person has held it once.
 */
export function Composer({
  placeholder,
  onSend,
  working = null,
  onPlus,
  suggestions,
  inputNativeID,
  face,
  mention,
  mentionAt,
  insertMention,
  prefill,
  focusAt,
  banner,
  sendEmpty = false,
  onType,
  draftKey,
  media,
  voice,
}: ComposerProps) {
  const theme = useTheme();
  const { colors, shadows, reducedMotion } = theme;
  const { t } = useTranslation();
  const [text, setText] = useState(() => (draftKey ? (DRAFTS.get(draftKey) ?? "") : ""));
  // Every change of the words is the draft too; an empty field leaves none behind.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key is the conversation the field belongs to
  useEffect(() => {
    if (!draftKey) return;
    if (text.trim()) DRAFTS.set(draftKey, text);
    else DRAFTS.delete(draftKey);
  }, [text]);
  const [caret, setCaret] = useState(0);
  const [selection, setSelection] = useState<{ start: number; end: number } | undefined>(undefined);
  // The words selected in the field: with some, the formatting bar shows over the field.
  const [range, setRange] = useState({ start: 0, end: 0 });
  const [focused, setFocused] = useState(false);
  const [taught, setTaught] = useState(() => readValueSync(STORED.stopSendTaught) === "1");
  const input = useRef<TextInputInstance | null>(null);
  const prefillAt = prefill?.at;
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per request (its time), whatever the text
  useEffect(() => {
    if (!prefill) return;
    const handed = prefill.text;
    setText((current) => (current.trim() ? current : handed));
    input.current?.focus();
  }, [prefillAt]);
  useEffect(() => {
    if (focusAt) input.current?.focus();
  }, [focusAt]);
  const has = text.trim().length > 0 || sendEmpty;
  const token = focused && mention && mentionAt ? mentionAt(text, caret) : null;
  const stopMode = Boolean(working?.stop) && !has && !voice?.active;
  const button = has || stopMode;
  const mediaButton = media && !has ? media : null;
  const mic = voice && !has ? voice.mic : null;

  const put = (next: string, at = next.length) => {
    setText(next);
    setCaret(at);
    setSelection({ start: at, end: at });
  };

  const send = (how: SendHow) => {
    const value = text.trim();
    if (!value && !sendEmpty) return;
    onSend(value, working ? how : "join");
    put("", 0);
  };

  const press = () => {
    if (has) {
      haptics.light();
      send("join");
      return;
    }
    if (!working?.stop) return;
    haptics.firm();
    working.stop.onStop();
  };
  // The button held while an agent works here: it stops and reads this at once. The haptic is the hold's own.
  const holdSend = () => {
    send("now");
    if (taught) return;
    setTaught(true);
    writeValueSync(STORED.stopSendTaught, "1");
  };
  const hold = working && has ? { hint: t("mobile.composer.holdToStop"), onHold: holdSend } : null;

  const formatting = focused && range.end > range.start && !voice?.active;
  const format = (kind: FormatKind) => {
    haptics.selection();
    const next = applyFormat(text, range.start, range.end, kind, { link: t("composer.format.linkText") });
    setText(next.value);
    setCaret(next.end);
    setRange({ start: next.start, end: next.end });
    setSelection({ start: next.start, end: next.end });
  };

  const pick = (handle: string) => {
    if (!token || !insertMention) return;
    haptics.selection();
    const next = insertMention(text, token, handle);
    put(next.text, next.caret);
  };

  return (
    <View>
      {token && mention ? mention({ query: token.query, sigil: token.sigil, pick }) : null}
      {suggestions && suggestions.length > 0 && !token && !has && !voice?.active ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          style={styles.pillsBleed}
          contentContainerStyle={styles.pills}
        >
          {suggestions.map((s) => (
            <PressScale
              key={s.label}
              onPress={() => put(s.text ?? s.label)}
              accessibilityRole="button"
              // 32 tall: the slop reaches 44 without pushing the field down.
              hitSlop={{ top: 6, bottom: 6 }}
              style={[styles.pill, { backgroundColor: colors.raised, boxShadow: `${shadows.e1}, ${shadows.top}` }]}
            >
              <View style={styles.pillIn}>
                <Icon name={s.icon} size={15} color={colors.muted} />
                <RNText
                  maxFontSizeMultiplier={CHROME_MAX_SCALE}
                  style={[systemText("subhead", weights.medium), { color: colors.ink2 }]}
                >
                  {s.label}
                </RNText>
              </View>
            </PressScale>
          ))}
        </ScrollView>
      ) : null}
      {banner}
      {voice?.above ?? null}
      {formatting ? (
        <Animated.View
          entering={reducedMotion ? undefined : FadeIn.duration(140)}
          exiting={reducedMotion ? undefined : FadeOut.duration(100)}
          style={styles.formatBleed}
        >
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="always"
            contentContainerStyle={styles.formatRow}
          >
            <View
              accessibilityRole="toolbar"
              accessibilityLabel={t("composer.format.toolbar")}
              style={[styles.format, { backgroundColor: colors.raised, boxShadow: `${shadows.e1}, ${shadows.top}` }]}
            >
              {FORMAT_KINDS.map((kind) => (
                <PressScale
                  key={kind}
                  to={0.9}
                  haptic={false}
                  onPress={() => format(kind)}
                  accessibilityRole="button"
                  accessibilityLabel={t(`composer.format.${kind}`)}
                  // 36 wide and tall: the slop reaches 44 up and down without pushing the field.
                  hitSlop={{ top: 4, bottom: 4 }}
                  style={styles.formatButton}
                >
                  <View style={styles.center}>
                    <Icon name={kind} size={20} color={colors.ink2} />
                  </View>
                </PressScale>
              ))}
            </View>
          </ScrollView>
        </Animated.View>
      ) : null}
      <View style={styles.row}>
        {/* The "+" plate; while a take is held hands free or paused, the same plate holds its trash. */}
        {voice?.leading ? (
          <PressScale
            to={0.9}
            onPress={voice.leading.onPress}
            accessibilityRole="button"
            accessibilityLabel={voice.leading.label}
            style={[styles.plus, { boxShadow: `0px 0px 0px 0.5px ${colors.line2}, ${shadows.top}` }]}
          >
            <Glass style={styles.plusGlass} intensity={50}>
              <View style={styles.center}>
                <Icon name={voice.leading.icon} size={22} color={colors.danger} />
              </View>
            </Glass>
          </PressScale>
        ) : onPlus ? (
          <PressScale
            to={0.9}
            onPress={onPlus}
            accessibilityRole="button"
            accessibilityLabel={t("mobile.a11y.attach")}
            style={[styles.plus, { boxShadow: `0px 0px 0px 0.5px ${colors.line2}, ${shadows.top}` }]}
          >
            <Glass style={styles.plusGlass} intensity={50}>
              <View style={styles.center}>
                <Icon name="plus" size={24} color={colors.ink2} />
              </View>
            </Glass>
          </PressScale>
        ) : null}
        {voice?.bar ? (
          <View style={[styles.bar, { backgroundColor: colors.raised, boxShadow: FIELD_SHADOW(colors.line2) }]}>
            {voice.bar}
          </View>
        ) : null}
        <View
          style={[
            styles.field,
            {
              backgroundColor: colors.raised,
              boxShadow: FIELD_SHADOW(colors.line2),
              paddingRight: button || mediaButton || mic ? INSET : 14,
            },
            // Kept mounted under a take's bar (the words and the keyboard's focus survive it), never drawn.
            voice?.bar ? styles.hidden : null,
          ]}
        >
          {face && !text ? (
            <Animated.View
              entering={reducedMotion ? undefined : FadeIn.duration(140)}
              exiting={reducedMotion ? undefined : FadeOut.duration(100)}
              style={styles.face}
              pointerEvents="none"
            >
              {face}
            </Animated.View>
          ) : null}
          {/* The placeholder is ours, on one line (cut with "…"): a long one wrapped and grew the empty field. */}
          <View style={styles.inputBox}>
            {!text ? (
              <View style={styles.placeholder} pointerEvents="none">
                <RNText numberOfLines={1} style={[placeholderText, { color: colors.faint }]}>
                  {placeholder}
                </RNText>
              </View>
            ) : null}
            <TextInput
              ref={input}
              {...(inputNativeID ? { nativeID: inputNativeID } : {})}
              value={text}
              onChangeText={(next) => {
                setText(next);
                if (next.trim()) onType?.(next);
              }}
              {...(selection ? { selection } : {})}
              onSelectionChange={(e) => {
                setCaret(e.nativeEvent.selection.end);
                setRange(e.nativeEvent.selection);
                if (selection) setSelection(undefined);
              }}
              multiline
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              accessibilityLabel={placeholder}
              style={[inputText, styles.inputFill, { color: colors.ink }]}
            />
          </View>
          {mediaButton ? (
            <Animated.View
              entering={reducedMotion ? undefined : FadeIn.duration(140)}
              exiting={reducedMotion ? undefined : FadeOut.duration(100)}
              style={styles.sendBox}
            >
              <PressScale
                to={0.9}
                onPress={mediaButton.onPress}
                accessibilityRole="button"
                accessibilityLabel={mediaButton.label}
                hitSlop={6}
                style={styles.media}
              >
                <View style={styles.center}>
                  <Icon name="sticker" size={20} color={colors.muted} />
                </View>
              </PressScale>
            </Animated.View>
          ) : null}
          {button ? (
            <SendButton
              stop={stopMode}
              label={stopMode && working?.stop ? working.stop.label : t("mobile.a11y.send")}
              onPress={press}
              hold={hold}
            />
          ) : null}
          {voice?.overlay ?? null}
          {mic ? <View style={styles.micBox}>{mic}</View> : null}
        </View>
      </View>
      {hold && !taught && !token ? (
        <Animated.View
          entering={reducedMotion ? undefined : FadeIn.duration(140)}
          exiting={reducedMotion ? undefined : FadeOut.duration(100)}
          style={styles.holdHint}
          pointerEvents="none"
        >
          <RNText
            numberOfLines={1}
            maxFontSizeMultiplier={CHROME_MAX_SCALE}
            style={[systemText("footnote"), { color: colors.faint }]}
          >
            {hold.hint}
          </RNText>
        </Animated.View>
      ) : null}
    </View>
  );
}

/**
 * The field's round button: the send arrow, or the stop square. It pops in (ZoomIn) on the glyph it shows, its value
 * born with it: iOS draws a glyph still turning inside that pop blurry. On a button already there the two swap in
 * place, one turning away as the other turns in.
 *
 * With `hold` (an agent at work and text to send), a tap sends and holding fills a ring of ink around the button,
 * linear, for as long as the hold takes; let go early and it empties fast. The ring closed, a firm haptic lands with
 * it and the message goes "now". Both run on the UI thread; React hears of the tap and the hold only.
 */
function SendButton({
  stop,
  label,
  onPress,
  hold = null,
}: {
  stop: boolean;
  label: string;
  onPress: () => void;
  hold?: { hint: string; onHold: () => void } | null;
}) {
  const { colors, reducedMotion, motion } = useTheme();
  const mode = useSharedValue(stop ? 1 : 0);
  const ring = useSharedValue(0);
  const pressed = useSharedValue(0);
  const held = useSharedValue(false);
  const trackOpacity = useDerivedValue(() => (ring.value > 0.001 ? 1 : 0));
  const holdRef = useRef(hold);
  holdRef.current = hold;
  const holdNow = () => {
    haptics.firm();
    holdRef.current?.onHold();
  };
  const longPress = useLongPressGesture({
    enabled: Boolean(hold),
    minDuration: HOLD_SEND_MS,
    maxDistance: 24,
    onBegin: () => {
      "worklet";
      held.value = false;
      pressed.value = reducedMotion ? 1 : withSpring(1, motion.press);
      ring.value = withTiming(1, { duration: HOLD_SEND_MS, easing: Easing.linear });
    },
    onActivate: () => {
      "worklet";
      held.value = true;
      ring.value = withTiming(0, { duration: 200, easing: EASE_OUT });
      scheduleOnRN(holdNow);
    },
    onFinalize: () => {
      "worklet";
      pressed.value = reducedMotion ? 0 : withSpring(0, motion.press);
      if (held.value) return;
      cancelAnimation(ring);
      ring.value = withTiming(0, { duration: 150, easing: EASE_OUT });
    },
  });
  const tap = useTapGesture({
    enabled: Boolean(hold),
    maxDuration: HOLD_SEND_MS - 20,
    onDeactivate: () => {
      "worklet";
      scheduleOnRN(onPress);
    },
  });
  const gesture = useExclusiveGestures(longPress, tap);
  const pressStyle = useAnimatedStyle(() => ({ transform: [{ scale: 1 - 0.1 * pressed.value }] }));
  useEffect(() => {
    const to = stop ? 1 : 0;
    // Both springs give their mass: with Reanimated 4's default of 4 they overshoot by half and take seconds to settle.
    mode.value = reducedMotion ? to : withSpring(to, { damping: 16, stiffness: 320, mass: 1 });
  }, [stop, reducedMotion, mode]);
  const sendGlyph = useAnimatedStyle(() => ({
    opacity: 1 - mode.value,
    transform: [{ scale: 1 - 0.6 * mode.value }, { rotate: `${45 * mode.value}deg` }],
  }));
  const stopGlyph = useAnimatedStyle(() => ({
    opacity: mode.value,
    transform: [{ scale: 0.4 + 0.6 * mode.value }, { rotate: `${-45 * (1 - mode.value)}deg` }],
  }));
  const glyphs = (
    <>
      <Animated.View style={[styles.glyph, sendGlyph]}>
        <Icon name="send" size={18} color={colors.bg} />
      </Animated.View>
      <Animated.View style={[styles.glyph, stopGlyph]}>
        <PixelStop size={13} color={colors.bg} moving={stop} />
      </Animated.View>
    </>
  );
  return (
    <Animated.View
      entering={reducedMotion ? undefined : ZoomIn.springify().damping(14).stiffness(320).mass(1)}
      exiting={reducedMotion ? undefined : ZoomOut.duration(120)}
      style={styles.sendBox}
    >
      {hold ? (
        <>
          <Canvas style={styles.ring} pointerEvents="none">
            <Group origin={vec(RING / 2, RING / 2)} transform={[{ rotate: -Math.PI / 2 }]}>
              <Path path={RING_PATH} style="stroke" strokeWidth={2} color={colors.line2} opacity={trackOpacity} />
              <Path
                path={RING_PATH}
                style="stroke"
                strokeWidth={2.5}
                strokeCap="round"
                color={colors.ink}
                start={0}
                end={ring}
              />
            </Group>
          </Canvas>
          <GestureDetector gesture={gesture}>
            <Animated.View
              accessible
              accessibilityRole="button"
              accessibilityLabel={label}
              accessibilityHint={hold.hint}
              style={[styles.send, { backgroundColor: colors.ink }, pressStyle]}
            >
              {glyphs}
            </Animated.View>
          </GestureDetector>
        </>
      ) : (
        <PressScale
          to={0.9}
          haptic={false}
          onPress={onPress}
          accessibilityRole="button"
          accessibilityLabel={label}
          hitSlop={6}
          style={[styles.send, { backgroundColor: colors.ink }]}
        >
          {glyphs}
        </PressScale>
      )}
    </Animated.View>
  );
}

/**
 * The field's text: one line is exactly the send button's height, so text, "+" and send share a center
 * line. iOS draws a multiline field's `lineHeight` from the top (the text sits low), so there the line
 * keeps the font's own height and the padding centers it; Android centers it itself.
 */
const body = systemText("body");
const inputText: TextStyle = {
  flex: 1,
  minWidth: 0,
  minHeight: SEND,
  maxHeight: 140,
  fontSize: body.fontSize,
  fontWeight: body.fontWeight,
  letterSpacing: body.letterSpacing,
  paddingHorizontal: 0,
  ...Platform.select<TextStyle>({
    ios: { paddingTop: 8, paddingBottom: 8 },
    // The one line centered in the send button's height: the field is exactly as tall.
    default: {
      lineHeight: body.lineHeight,
      paddingTop: (SEND - (body.lineHeight ?? SEND)) / 2,
      paddingBottom: (SEND - (body.lineHeight ?? SEND)) / 2,
      textAlignVertical: "center",
      includeFontPadding: false,
    },
  }),
};

/** The placeholder's words, as the field's own text sits on its first line. */
const placeholderText: TextStyle = {
  fontSize: body.fontSize,
  fontWeight: body.fontWeight,
  letterSpacing: body.letterSpacing,
  ...Platform.select<TextStyle>({ android: { lineHeight: body.lineHeight, includeFontPadding: false } }),
};

const styles = StyleSheet.create({
  inputBox: { flex: 1, minWidth: 0 },
  inputFill: { flex: 0, width: "100%" },
  // Over the empty field's one line, centered on it.
  placeholder: { position: "absolute", left: 0, right: 0, bottom: 0, height: SEND, justifyContent: "center" },
  // The row runs to the screen edges (past the composer's own inset) so a long last chip scrolls instead of
  // being cut at the padding.
  pillsBleed: { marginHorizontal: -10 },
  pills: { gap: 6, paddingHorizontal: 14, paddingBottom: 8 },
  pill: { height: 32, borderRadius: 999 },
  // As the pills: to the screen edges, so on a narrow phone the last buttons scroll in instead of being cut.
  formatBleed: { marginHorizontal: -10 },
  formatRow: { paddingHorizontal: 10, paddingBottom: 8 },
  format: { flexDirection: "row", height: 44, padding: 4, gap: 2, borderRadius: 22 },
  formatButton: { width: SEND, height: SEND, borderRadius: SEND / 2 },
  pillIn: { flexGrow: 1, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12 },
  row: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  plus: { width: FIELD, height: FIELD, borderRadius: FIELD / 2 },
  plusGlass: { flex: 1, borderRadius: FIELD / 2 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  field: {
    flex: 1,
    minWidth: 0,
    minHeight: FIELD,
    borderRadius: FIELD / 2,
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    paddingVertical: INSET,
    paddingLeft: 14,
  },
  // A take's bar: the field's capsule at its one-line height, its 36 controls INSET from every edge.
  bar: {
    flex: 1,
    minWidth: 0,
    height: FIELD,
    borderRadius: FIELD / 2,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: INSET,
  },
  hidden: { display: "none" },
  face: { height: SEND, justifyContent: "center" },
  holdHint: { paddingTop: 8, minHeight: 20, alignItems: "center" },
  sendBox: { width: SEND, height: SEND },
  // Around the button, 4 past it on every side.
  ring: { position: "absolute", left: (SEND - RING) / 2, top: (SEND - RING) / 2, width: RING, height: RING },
  // Above the overlay: the finger that holds it stays on the same button while the field changes.
  micBox: { width: SEND, height: SEND, zIndex: 2 },
  send: { width: SEND, height: SEND, borderRadius: SEND / 2 },
  media: { width: SEND, height: SEND, borderRadius: SEND / 2 },
  glyph: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center" },
});

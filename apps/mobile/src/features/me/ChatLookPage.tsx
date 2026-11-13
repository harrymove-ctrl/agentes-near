import { useSetChatPrefs } from "@agenteschat/client";
import {
  CHAT_RHYTHM,
  CHAT_STYLES,
  CHAT_TEXT_SIZES,
  type ChatPrefs,
  type ChatStyle,
  type ChatTextSize,
  type ChatTone,
  chatLookOf,
  DEFAULT_TEXT_SIZE,
  facesShown,
  mineOnRight,
  openAtOf,
  textSizeOf,
} from "@agenteschat/client/lib/chat-look";
import { isPersonal, modeKey } from "@agenteschat/client/lib/workspace-mode";
import type { AgentColorName } from "@agenteschat/ui/agent/engine";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { GestureDetector, useExclusiveGestures, usePanGesture, useTapGesture } from "react-native-gesture-handler";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { AgentAvatar } from "@/agent/AgentAvatar";
import { useOrg } from "@/providers/org";
import { GroupedHeader, GroupedList, GroupedRow, haptics, Icon, Segmented, Text, useTheme, useToast } from "@/ui";
import {
  bubbleFill,
  CHAT_TEXT,
  CHAT_TEXT_MAX_SCALE,
  chatNameOf,
  chatTimeOf,
  MSG_AVATAR,
  MSG_GAP,
  MSG_INSET,
  nameInk,
} from "../chat/logic";
import { lookRows, RowLookContext, useRowLook } from "../chat/look";
import { MessageText } from "../chat/MessageText";
import { Face } from "../shared/Face";
import { useColors, useDirectory, useMeId } from "../shared/hooks";
import { Page } from "./parts";

/** The agent of the preview: the pixel face a DM has. */
const SAMPLE_COLOR: AgentColorName = "green";
const SAMPLE_AGENT = { color: SAMPLE_COLOR, eyes: "round", accessory: "none" } as const;
const SAMPLE_NAME = "Ada";

const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);
/** My words on a strong bubble. */
const ON_SOLID = "#ffffff";

interface Line {
  mine: boolean;
  text: string;
  time: string;
}

/**
 * One row of the preview, framed as the conversation frames it (`MessageRow`): the same insets, face sizes, name and
 * time sizes per Tamanho do texto, bubbles and fills, and the words drawn by the conversation's own `MessageText`
 * (which reads the size from the look this page provides).
 */
function PreviewRow({ line, first, dm }: { line: Line; first: boolean; dm: boolean }) {
  const c = useColors();
  const { scheme } = useTheme();
  const dir = useDirectory();
  const meId = useMeId();
  const look = useRowLook();
  const { style, tone } = look;
  const text = look.text ?? CHAT_TEXT[DEFAULT_TEXT_SIZE];
  const rhythm = CHAT_RHYTHM[style];
  const name = line.mine ? dir.nameOf({ type: "person", id: meId }) : SAMPLE_NAME;
  const bubbled = style === "bubbles";
  const compact = style === "compact";
  const right = line.mine && mineOnRight(style);
  // As the conversation draws it: a DM whose sides say who spoke has no face.
  const faced = !right && facesShown(style, dm);
  const top = first ? 0 : rhythm.turn;
  const solid = bubbled && tone === "strong" && line.mine ? ON_SOLID : undefined;
  const words = <MessageText body={line.text} selectable={false} {...(solid ? { ink: solid } : {})} />;
  const nameSize = chatNameOf(text);
  const timeSize = chatTimeOf(text);
  const stampTime = (
    <Text variant="caption" tone="muted" style={solid ? { color: solid } : null}>
      {line.time}
    </Text>
  );
  if (right)
    return (
      <View style={[styles.me, { marginTop: top }]}>
        <View
          style={[bubbled ? lookRows.bubble : styles.bubble, { backgroundColor: (bubbled && look.fill) || c.bubble }]}
        >
          <View style={bubbled ? styles.bubbleLine : undefined}>
            {words}
            {bubbled ? <View style={styles.stamp}>{stampTime}</View> : null}
          </View>
        </View>
        {bubbled ? null : (
          <View style={[styles.meTime, { marginTop: rhythm.part / 2 }]}>
            <Text variant="caption" tone="faint">
              {line.time}
            </Text>
          </View>
        )}
      </View>
    );
  const faceSize = compact ? 18 : bubbled ? 30 : MSG_AVATAR;
  const face = line.mine ? (
    <Face who={{ type: "person", id: meId }} size={faceSize} live={false} />
  ) : (
    <AgentAvatar agent={SAMPLE_AGENT} size={faceSize} live={false} name={SAMPLE_NAME} />
  );
  const nameText = (
    <Text
      variant="footnote"
      tone="ink2"
      style={[
        styles.name,
        nameSize,
        bubbled && !line.mine ? { color: nameInk(SAMPLE_COLOR, scheme === "dark") } : null,
      ]}
      maxFontSizeMultiplier={CHAT_TEXT_MAX_SCALE}
      numberOfLines={1}
    >
      {name}
    </Text>
  );
  return (
    <View style={[styles.row, bubbled && lookRows.bubblesRow, compact && lookRows.compactRow, { marginTop: top }]}>
      {compact ? (
        <Text variant="caption" tone="faint" style={lookRows.compactClock}>
          {line.time}
        </Text>
      ) : null}
      {faced ? (
        <View style={[styles.slot, bubbled && lookRows.bubblesSlot, compact && lookRows.compactSlot]}>{face}</View>
      ) : null}
      <View style={styles.body}>
        {bubbled ? (
          <View style={[lookRows.bubble, { backgroundColor: c.bubble }]}>
            {dm ? null : nameText}
            <View style={styles.bubbleLine}>
              {words}
              <View style={styles.stamp}>{stampTime}</View>
            </View>
          </View>
        ) : compact ? (
          <View style={styles.compactLine}>
            {nameText}
            {words}
          </View>
        ) : (
          <>
            <View style={styles.who}>
              {nameText}
              <Text variant="footnote" tone="faint" style={timeSize} maxFontSizeMultiplier={CHAT_TEXT_MAX_SCALE}>
                {line.time}
              </Text>
            </View>
            {words}
          </>
        )}
      </View>
    </View>
  );
}

/**
 * The page's one preview: three lines of a real exchange, drawn as the conversation will draw them in the chosen
 * style, tone and text size. A change dips it and brings it back (opacity only, under 200 ms), so the eye catches
 * what changed without anything sliding.
 */
function ChatPreview({ style, tone, size, dm }: { style: ChatStyle; tone: ChatTone; size: ChatTextSize; dm: boolean }) {
  const { t } = useTranslation();
  const c = useColors();
  const { colors, scheme, reducedMotion } = useTheme();
  const fill = bubbleFill(dm ? SAMPLE_COLOR : "sky", tone, colors.bg, scheme === "dark");
  const look = { style, tone, fill, names: !dm, faces: facesShown(style, dm), text: CHAT_TEXT[size] };
  const lines: Line[] = [
    { mine: true, text: t("settings.account.chat.sample.ask"), time: "14:30" },
    { mine: false, text: t("settings.account.chat.sample.answer"), time: "14:31" },
    { mine: true, text: t("settings.account.chat.sample.go"), time: "14:32" },
  ];
  const shown = useSharedValue(1);
  const key = `${style}-${tone}-${size}-${dm}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the look's key is what changed
  useEffect(() => {
    if (reducedMotion) return;
    shown.set(0.35);
    shown.set(withTiming(1, { duration: 180, easing: EASE_OUT }));
  }, [key]);
  const fade = useAnimatedStyle(() => ({ opacity: shown.get() }));
  return (
    <RowLookContext.Provider value={look}>
      <Animated.View
        style={[styles.preview, { backgroundColor: c.bg, borderColor: c.line2 }, fade]}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {lines.map((line, i) => (
          <PreviewRow key={line.time} line={line} first={i === 0} dm={dm} />
        ))}
      </Animated.View>
    </RowLookContext.Provider>
  );
}

/** A schematic of a style: squares for faces, thin bars for names and words, pills for bubbles. No words, any size. */
function StyleGlyph({ style }: { style: ChatStyle }) {
  const c = useColors();
  const ink = c.faint;
  const soft = c.line2;
  const bar = (width: number | `${number}%`, color = soft, height = 3) => (
    <View style={{ width, height, borderRadius: 2, backgroundColor: color }} />
  );
  const dot = (size = 8) => (
    <View style={{ width: size, height: size, borderRadius: Math.round(size * 0.3), backgroundColor: ink }} />
  );
  const pill = (width: `${number}%`, color: string) => (
    <View style={{ width, height: 9, borderRadius: 4.5, backgroundColor: color }} />
  );
  const left = (words: `${number}%`) => (
    <View style={glyph.row}>
      {dot()}
      <View style={glyph.lines}>
        {bar("40%", ink, 2)}
        {bar(words)}
      </View>
    </View>
  );
  if (style === "comfortable")
    return (
      <View style={glyph.box}>
        <View style={glyph.end}>{pill("46%", soft)}</View>
        {left("72%")}
        <View style={glyph.end}>{pill("34%", soft)}</View>
      </View>
    );
  if (style === "left")
    return (
      <View style={glyph.box}>
        {left("58%")}
        {left("74%")}
        {left("44%")}
      </View>
    );
  if (style === "bubbles")
    return (
      <View style={glyph.box}>
        <View style={glyph.end}>{pill("46%", c.chip)}</View>
        <View style={glyph.row}>
          {dot()}
          {pill("56%", soft)}
        </View>
        <View style={glyph.end}>{pill("34%", c.chip)}</View>
      </View>
    );
  return (
    <View style={[glyph.box, glyph.tight]}>
      {(["62%", "74%", "50%", "68%"] as const).map((w) => (
        <View key={w} style={glyph.row}>
          {bar(6, ink, 2)}
          {dot(5)}
          {bar(w)}
        </View>
      ))}
    </View>
  );
}

/** The four styles side by side, each a schematic, its name and a check on the chosen one. */
function StylePicker({
  value,
  names,
  onPick,
}: {
  value: ChatStyle;
  names: Record<ChatStyle, string>;
  onPick: (style: ChatStyle) => void;
}) {
  const c = useColors();
  return (
    <View style={[styles.card, styles.choices, { backgroundColor: c.raised }]} accessibilityRole="radiogroup">
      {CHAT_STYLES.map((s) => {
        const on = s === value;
        return (
          <Pressable
            key={s}
            onPress={() => {
              if (on) return;
              haptics.selection();
              onPick(s);
            }}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            accessibilityLabel={names[s]}
            style={({ pressed }) => [styles.choice, pressed && !on && styles.pressed]}
          >
            <View style={[styles.glyphFrame, { backgroundColor: c.bg, borderColor: c.line2 }]}>
              <StyleGlyph style={s} />
            </View>
            <Text
              variant="footnote"
              tone={on ? "ink" : "muted"}
              style={[styles.choiceName, on && styles.semibold]}
              numberOfLines={2}
            >
              {names[s]}
            </Text>
            <View
              style={[styles.check, on ? { backgroundColor: c.ink, borderColor: c.ink } : { borderColor: c.line2 }]}
            >
              {on ? <Icon name="check" size={13} color={c.raised} /> : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const THUMB = 26;

/**
 * Tamanho do texto as the system's own: a small A, a stepped track and a big A. The thumb follows the finger one to
 * one, ticks a selection haptic on each step it crosses (the preview follows at once), and on release springs onto
 * its step with the finger's speed; only then is the size saved. A tap jumps to the nearest step.
 */
function SizeSlider({
  value,
  labels,
  onStep,
  onCommit,
}: {
  value: ChatTextSize;
  labels: Record<ChatTextSize, string>;
  onStep: (size: ChatTextSize) => void;
  onCommit: (size: ChatTextSize) => void;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const { reducedMotion } = useTheme();
  const last = CHAT_TEXT_SIZES.length - 1;
  const index = CHAT_TEXT_SIZES.indexOf(value);
  const width = useSharedValue(0);
  const x = useSharedValue(0);
  const step = useSharedValue(index);
  const dragging = useSharedValue(false);
  const [measured, setMeasured] = useState(false);
  // The value changed from outside (saved, or another device), or the track was measured: the thumb on its step.
  useEffect(() => {
    if (!measured || dragging.get()) return;
    step.set(index);
    x.set((index / last) * Math.max(0, width.get() - THUMB));
  }, [index, last, measured, dragging, step, x, width]);
  const crossed = (i: number) => {
    haptics.selection();
    onStep(CHAT_TEXT_SIZES[i] ?? DEFAULT_TEXT_SIZE);
  };
  const commit = (i: number) => onCommit(CHAT_TEXT_SIZES[i] ?? DEFAULT_TEXT_SIZE);
  const follow = (px: number) => {
    "worklet";
    const room = Math.max(1, width.get() - THUMB);
    const at = Math.min(room, Math.max(0, px - THUMB / 2));
    x.set(at);
    const near = Math.round((at / room) * last);
    if (near !== step.get()) {
      step.set(near);
      scheduleOnRN(crossed, near);
    }
  };
  const land = (velocity: number) => {
    "worklet";
    const to = (step.get() / last) * Math.max(0, width.get() - THUMB);
    x.set(
      reducedMotion
        ? withTiming(to, { duration: 120, easing: EASE_OUT })
        : withSpring(to, { duration: 300, dampingRatio: 0.9, velocity }),
    );
    scheduleOnRN(commit, step.get());
  };
  const pan = usePanGesture({
    // Sideways only: a vertical drag stays the page's scroll.
    activeOffsetX: [-4, 4],
    failOffsetY: [-12, 12],
    maxPointers: 1,
    onActivate: (e) => {
      "worklet";
      dragging.set(true);
      follow(e.x);
    },
    onUpdate: (e) => {
      "worklet";
      follow(e.x);
    },
    onDeactivate: (e) => {
      "worklet";
      dragging.set(false);
      land(e.velocityX);
    },
  });
  const tap = useTapGesture({
    onDeactivate: (e) => {
      "worklet";
      if (e.canceled) return;
      follow(e.x);
      land(0);
    },
  });
  const gesture = useExclusiveGestures(pan, tap);
  const thumb = useAnimatedStyle(() => ({ transform: [{ translateX: x.get() }] }));
  const nudge = (by: number) => {
    const next = CHAT_TEXT_SIZES[Math.min(last, Math.max(0, index + by))] ?? value;
    if (next === value) return;
    haptics.selection();
    onStep(next);
    onCommit(next);
  };
  return (
    <View style={[styles.card, styles.sizeCard, { backgroundColor: c.raised }]}>
      <View style={styles.sizeRow}>
        <Text style={[styles.smallA, { color: c.ink2 }]} maxFontSizeMultiplier={1} importantForAccessibility="no">
          A
        </Text>
        <GestureDetector gesture={gesture}>
          <View
            style={styles.track}
            onLayout={(e) => {
              width.set(e.nativeEvent.layout.width);
              setMeasured(true);
            }}
            accessible
            accessibilityRole="adjustable"
            accessibilityLabel={t("settings.account.chat.textSize")}
            accessibilityValue={{ text: labels[value] }}
            accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
            onAccessibilityAction={(e) => nudge(e.nativeEvent.actionName === "increment" ? 1 : -1)}
          >
            <View style={[styles.rail, { backgroundColor: c.line2 }]} />
            <View style={styles.ticks} pointerEvents="none">
              {CHAT_TEXT_SIZES.map((s) => (
                <View key={s} style={[styles.tick, { backgroundColor: c.line2 }]} />
              ))}
            </View>
            {measured ? <Animated.View style={[styles.thumb, { borderColor: c.line2 }, thumb]} /> : null}
          </View>
        </GestureDetector>
        <Text style={[styles.bigA, { color: c.ink2 }]} maxFontSizeMultiplier={1} importantForAccessibility="no">
          A
        </Text>
      </View>
      {/* The default is the middle step: its name sits under it. */}
      <Text
        variant="footnote"
        tone={value === DEFAULT_TEXT_SIZE ? "ink2" : "faint"}
        style={styles.defaultName}
        importantForAccessibility="no"
      >
        {labels[DEFAULT_TEXT_SIZE]}
      </Text>
    </View>
  );
}

/**
 * Conversa, as Sua conta has it on the web: how conversations look to me on every device. One preview on top shows
 * exactly what a conversation will look like; under it the style (Canais and DMs each have their own, Bolhas its Clara
 * or Forte), the size of the words, and where a conversation opens.
 */
export function ChatLookPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const { orgId, org } = useOrg();
  const set = useSetChatPrefs(orgId);
  const [kind, setKind] = useState<"channels" | "dms">("channels");
  const dm = kind === "dms";
  const prefs = org?.chatPrefs;
  // A personal workspace's channels are its group conversations, in bubbles until the person picks (ADR 0159).
  const { style, tone } = chatLookOf(prefs, dm, isPersonal(org));
  const textSize = textSizeOf(prefs);
  // While the slider moves the preview follows it; the size is saved when the thumb lands.
  const [sizeDraft, setSizeDraft] = useState<ChatTextSize | null>(null);
  useEffect(() => {
    if (sizeDraft === textSize) setSizeDraft(null);
  }, [sizeDraft, textSize]);
  const shownSize = sizeDraft ?? textSize;
  const openAt = openAtOf(prefs);
  const save = (patch: ChatPrefs) =>
    set.mutate(patch, {
      onError: () => {
        setSizeDraft(null);
        toast({ title: t("settings.account.activityFailed"), icon: "x" });
      },
    });
  const toneLabel = t(dm ? "settings.account.chat.toneDms" : modeKey(org, "settings.account.chat.toneChannels"));
  const names: Record<ChatStyle, string> = {
    comfortable: t("settings.account.chat.comfortable"),
    left: t("settings.account.chat.left"),
    bubbles: t("settings.account.chat.bubbles"),
    compact: t("settings.account.chat.compact"),
  };
  const sizes: Record<ChatTextSize, string> = {
    xs: t("settings.account.chat.textXs"),
    sm: t("settings.account.chat.textSm"),
    md: t("settings.account.chat.textMd"),
    lg: t("settings.account.chat.textLg"),
    xl: t("settings.account.chat.textXl"),
  };
  return (
    <Page title={t("settings.account.chat.title")}>
      <View style={styles.gap} />
      <Segmented
        wide
        items={[
          { key: "channels", label: t(modeKey(org, "settings.account.chat.channels")) },
          { key: "dms", label: t("settings.account.chat.dms") },
        ]}
        value={kind}
        onChange={(k) => setKind(k as "channels" | "dms")}
      />
      <View style={styles.previewGap} />
      <ChatPreview style={style} tone={tone} size={shownSize} dm={dm} />
      <GroupedHeader
        hint={{
          name: t("common.about", { label: t("settings.account.chat.density") }),
          text: t("settings.account.chat.densityHelp"),
        }}
      >
        {t("settings.account.chat.density")}
      </GroupedHeader>
      <StylePicker value={style} names={names} onPick={(s) => save(dm ? { dmStyle: s } : { channelStyle: s })} />
      {style === "bubbles" ? (
        <>
          <GroupedHeader
            hint={{
              name: t("common.about", { label: toneLabel }),
              text: t(dm ? "settings.account.chat.toneDmsHelp" : "settings.account.chat.toneChannelsHelp"),
            }}
          >
            {toneLabel}
          </GroupedHeader>
          <Segmented
            wide
            items={[
              { key: "light", label: t("settings.account.chat.toneLight") },
              { key: "strong", label: t("settings.account.chat.toneStrong") },
            ]}
            value={tone}
            onChange={(v) => save(dm ? { dmTone: v as ChatTone } : { channelTone: v as ChatTone })}
          />
        </>
      ) : null}
      <GroupedHeader
        hint={{
          name: t("common.about", { label: t("settings.account.chat.textSize") }),
          text: t("settings.account.chat.textSizePhone"),
        }}
      >
        {t("settings.account.chat.textSize")}
      </GroupedHeader>
      <SizeSlider
        value={shownSize}
        labels={sizes}
        onStep={setSizeDraft}
        onCommit={(v) => {
          if (v !== textSize) save({ textSize: v });
        }}
      />
      <GroupedHeader
        hint={{
          name: t("common.about", { label: t("settings.account.chat.openAt") }),
          text: t("mobile.me.chatOpenAtHelp"),
        }}
      >
        {t("settings.account.chat.openAt")}
      </GroupedHeader>
      <GroupedList>
        <GroupedRow
          label={t("settings.account.chat.openRead")}
          checked={openAt === "read"}
          onPress={() => save({ openAt: "read" })}
        />
        <GroupedRow
          label={t("settings.account.chat.openLatest")}
          checked={openAt === "latest"}
          onPress={() => save({ openAt: "latest" })}
        />
      </GroupedList>
    </Page>
  );
}

const glyph = StyleSheet.create({
  box: { flex: 1, justifyContent: "center", gap: 7, paddingHorizontal: 8 },
  tight: { gap: 5 },
  row: { flexDirection: "row", alignItems: "center", gap: 4 },
  lines: { flex: 1, gap: 3 },
  end: { alignItems: "flex-end" },
});

const styles = StyleSheet.create({
  gap: { height: 8 },
  previewGap: { height: 16 },
  // The preview: the conversation's own page color on the grouped gray, a hairline round it.
  preview: { paddingVertical: 14, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  row: { flexDirection: "row", gap: MSG_GAP, paddingLeft: MSG_INSET, paddingRight: 16 },
  slot: { width: MSG_AVATAR, alignItems: "center", paddingTop: 2 },
  body: { flex: 1, minWidth: 0 },
  who: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: 8, marginBottom: 4 },
  name: { fontWeight: "600", flexShrink: 1 },
  compactLine: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: 6 },
  me: { paddingLeft: 64, paddingRight: 16, alignItems: "flex-end" },
  bubble: { maxWidth: "100%", paddingVertical: 10, paddingHorizontal: 14, borderRadius: 20 },
  bubbleLine: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    alignItems: "flex-end",
    columnGap: 8,
  },
  stamp: { flexDirection: "row", alignItems: "center", height: 16, marginLeft: "auto" },
  meTime: { flexDirection: "row", justifyContent: "flex-end", height: 16 },
  // A grouped card, as `GroupedList`'s.
  card: { borderRadius: 14, overflow: "hidden" },
  choices: { flexDirection: "row", paddingHorizontal: 4 },
  choice: { flex: 1, alignItems: "center", gap: 8, paddingVertical: 12, paddingHorizontal: 4 },
  pressed: { opacity: 0.6 },
  glyphFrame: {
    width: "100%",
    maxWidth: 72,
    aspectRatio: 0.82,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  choiceName: { textAlign: "center" },
  semibold: { fontWeight: "600" },
  check: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  sizeCard: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 10 },
  sizeRow: { flexDirection: "row", alignItems: "center", gap: 14 },
  smallA: { fontSize: 13, lineHeight: 18, fontWeight: "500" },
  bigA: { fontSize: 21, lineHeight: 26, fontWeight: "500" },
  track: { flex: 1, height: 36, justifyContent: "center" },
  rail: { position: "absolute", left: THUMB / 2, right: THUMB / 2, height: 3, borderRadius: 2 },
  ticks: {
    position: "absolute",
    left: THUMB / 2 - 1,
    right: THUMB / 2 - 1,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  tick: { width: 2, height: 9, borderRadius: 1 },
  thumb: {
    position: "absolute",
    left: 0,
    width: THUMB,
    height: THUMB,
    borderTopLeftRadius: 9,
    borderTopRightRadius: 9,
    borderBottomRightRadius: 9,
    borderBottomLeftRadius: 3,
    backgroundColor: "#ffffff",
    borderWidth: StyleSheet.hairlineWidth,
    boxShadow: "0px 2px 6px 0px rgba(23, 23, 22, 0.22)",
  },
  defaultName: { textAlign: "center", marginTop: 2 },
});

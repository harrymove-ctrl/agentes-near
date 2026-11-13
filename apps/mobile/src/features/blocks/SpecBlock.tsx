import { type BlockChange, useBlockReply, useBlockValues } from "@agenteschat/client";
import type { ChartSpec } from "@agenteschat/client/lib/chart";
import { clockHour } from "@agenteschat/client/lib/format";
import type { AgentColorName } from "@agenteschat/ui/agent/engine";
import {
  type BlockViewPart,
  type BlockWords,
  compileBlock,
  inputValue,
  parseBlockSpec,
  viewBlock,
} from "@agenteschat/ui/blocks/spec";
import { randomUUID } from "expo-crypto";
import { LinearGradient } from "expo-linear-gradient";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type LayoutChangeEvent, Pressable, StyleSheet, TextInput, View } from "react-native";
import { GestureDetector, useExclusiveGestures, usePanGesture, useTapGesture } from "react-native-gesture-handler";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { Button, fieldText, haptics, Segmented, Text, ToggleSwitch, useReducedMotion, useToast } from "@/ui";
import { ChartView } from "../chat/ChartCard";
import { Table } from "../chat/MessageSpans";
import { useColors, useDirectory, useOrgId } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { tapHaptic } from "../shared/parts";
import { INLINE_HEIGHT } from "./logic";

type Sent = { text: string; at: string };
/** What this person sent from a block and whether they opened it whole, kept while the app runs. */
const kept = new Map<string, { sent?: Sent; open?: boolean }>();
const keptOf = (key: string) => {
  let k = kept.get(key);
  if (!k) {
    k = {};
    kept.set(key, k);
  }
  return k;
};

type Values = ReturnType<typeof useBlockValues>;

/**
 * A live block drawn by the app itself (ADR 0113): the parts the agent described, with the app's own controls, over
 * the state everyone in the conversation shares. Nothing the agent wrote runs on the phone: its words reach the screen
 * only as text, and its formulas are read by our interpreter (`@agenteschat/ui/blocks/spec`). So it needs no web view,
 * draws at once with the message, and any number of them can be on screen.
 */
export function SpecBlock({
  id,
  version,
  spec: raw,
  agentId,
  screen = false,
}: {
  id: string;
  version: number;
  spec: Record<string, unknown>;
  agentId: string;
  screen?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const dir = useDirectory();
  const toast = useToast();
  const agent = dir.agentById.get(agentId);
  const accent = agentLook(agent).color;
  const blockKey = `${id}@${version}`;
  const compiled = useMemo(() => {
    try {
      return compileBlock(parseBlockSpec(raw));
    } catch {
      return null;
    }
  }, [raw]);
  const values = useBlockValues(orgId, id, version);
  const reply = useBlockReply(orgId, id);
  const thousand = t("mobile.blocks.thousand");
  const words = useMemo<BlockWords>(() => ({ locale: i18n.language, thousand }), [i18n.language, thousand]);
  const view = useMemo(
    () => (compiled ? viewBlock(compiled, values.state, words) : null),
    [compiled, values.state, words],
  );
  const [sent, setSent] = useState<Sent | null>(keptOf(blockKey).sent ?? null);
  const [open, setOpen] = useState(keptOf(blockKey).open ?? false);
  const [height, setHeight] = useState(0);

  if (!compiled || !view) {
    return (
      <View style={styles.broken}>
        <Text variant="subhead" style={styles.bold}>
          {t("blocks.brokenTitle")}
        </Text>
        <Text variant="footnote" tone="muted">
          {t("blocks.brokenBody")}
        </Text>
      </View>
    );
  }

  const tall = !screen && height > INLINE_HEIGHT;
  const toggleOpen = () => {
    tapHaptic();
    keptOf(blockKey).open = !open;
    setOpen(!open);
  };
  const send = () => {
    const draft = view.send;
    if (!draft?.ready || reply.isPending) return;
    tapHaptic();
    const text = draft.text;
    reply.mutate(
      { text, clientId: randomUUID() },
      {
        onSuccess: () => {
          const done = { text, at: new Date().toISOString() };
          keptOf(blockKey).sent = done;
          setSent(done);
        },
        onError: () => toast({ title: t("mobile.blocks.sendFailed"), icon: "x" }),
      },
    );
  };
  const same = sent !== null && sent.text === view.send?.text;
  const time = sent
    ? new Intl.DateTimeFormat(i18n.language, { hour: clockHour(i18n.language), minute: "2-digit" }).format(
        new Date(sent.at),
      )
    : "";

  return (
    <View>
      <View style={tall ? [styles.cut, { height: open ? height : INLINE_HEIGHT }] : undefined}>
        <View
          style={styles.body}
          onLayout={(e: LayoutChangeEvent) => setHeight(Math.ceil(e.nativeEvent.layout.height))}
        >
          <Parts parts={view.parts} values={values} accent={accent} />
        </View>
        {tall && !open ? (
          <LinearGradient pointerEvents="none" colors={[`${c.raised}00`, c.raised]} style={styles.fade} />
        ) : null}
      </View>
      {tall ? (
        <View style={styles.more}>
          <Button
            variant="ghost"
            size="sm"
            icon={open ? undefined : "down"}
            label={open ? t("blocks.showLess") : t("blocks.showAll")}
            onPress={toggleOpen}
          />
        </View>
      ) : null}
      {view.send ? (
        same ? (
          <View style={[styles.foot, { borderTopColor: c.line2 }]}>
            <View style={styles.sent}>
              <View style={[styles.mark, { backgroundColor: c.ok }]} />
              <Text variant="footnote" tone="muted">
                {t("mobile.blocks.sentAt", { time })}
              </Text>
            </View>
          </View>
        ) : (
          <View style={[styles.foot, { borderTopColor: c.line2 }]}>
            <Text variant="footnote" tone="muted">
              {view.send.ready
                ? `${t("mobile.blocks.goesTo", { name: agent?.name ?? "" })} ${view.send.text}`
                : view.send.hint}
            </Text>
            <Button
              variant="primary"
              wide
              label={view.send.label}
              disabled={!view.send.ready}
              loading={reply.isPending}
              onPress={send}
            />
          </View>
        )
      ) : null}
    </View>
  );
}

function Parts({ parts, values, accent }: { parts: BlockViewPart[]; values: Values; accent: AgentColorName }) {
  return (
    <>
      {parts.map((p) => (
        <Part key={p.key} part={p} values={values} accent={accent} />
      ))}
    </>
  );
}

function Part({ part: p, values, accent }: { part: BlockViewPart; values: Values; accent: AgentColorName }) {
  const c = useColors();
  const set = (raw: unknown) => {
    const name = "name" in p ? p.name : undefined;
    if (typeof name !== "string") return;
    const v = inputValue(p, raw);
    if (v !== undefined) values.set({ [name]: v });
  };
  switch (p.kind) {
    case "heading":
      return (
        <Text variant="callout" style={styles.heading}>
          {p.text}
        </Text>
      );
    case "text":
      return (
        <Text variant="subhead" tone="ink2">
          {p.text}
        </Text>
      );
    case "note":
      return (
        <Text variant="footnote" tone="faint">
          {p.text}
        </Text>
      );
    case "list":
      return (
        <View style={styles.list}>
          {p.items.map((item, i) => (
            // Lines of one list have no id but their place.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above
            <View key={i} style={styles.listRow}>
              <Text variant="subhead" tone="faint">
                •
              </Text>
              <Text variant="subhead" tone="ink2" style={styles.flex}>
                {item}
              </Text>
            </View>
          ))}
        </View>
      );
    case "slider":
      return (
        <View>
          <Label text={p.label} value={p.shown} />
          <Slider part={p} onChange={set} />
        </View>
      );
    case "choice":
      return (
        <View>
          {p.label ? <Label text={p.label} /> : null}
          <Segmented items={p.options.map((o) => ({ key: o, label: o }))} value={p.value ?? ""} onChange={set} />
        </View>
      );
    case "field":
      return <Field part={p} onChange={set} />;
    case "switch":
      return (
        <Pressable
          onPress={() => {
            haptics.selection();
            set(!p.value);
          }}
          accessibilityRole="switch"
          accessibilityLabel={p.label}
          accessibilityState={{ checked: p.value }}
          style={styles.switch}
        >
          <Text variant="subhead" tone="ink2" style={[styles.flex, styles.semi]}>
            {p.label}
          </Text>
          <ToggleSwitch value={p.value} />
        </Pressable>
      );
    case "stats":
      return (
        <View style={styles.stats}>
          {p.items.map((s) => (
            <View key={s.key} style={[styles.stat, { backgroundColor: c.sunken, borderColor: c.line }]}>
              <Text variant="footnote" tone="muted">
                {s.label}
              </Text>
              <Text variant="title2" numberOfLines={1} adjustsFontSizeToFit style={styles.number}>
                {s.text}
              </Text>
              {s.sub ? (
                <Text variant="caption" tone={s.tone === "up" ? "ok" : s.tone === "down" ? "danger" : "faint"}>
                  {s.sub}
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      );
    case "result":
      return <Result label={p.label} text={p.text} change={p.name ? values.changes[p.name] : undefined} />;
    case "progress":
      return (
        <View>
          <Label text={p.label} value={p.text} />
          <View style={[styles.track, { backgroundColor: c.plate }]}>
            <View style={[styles.fill, { width: `${p.share * 100}%`, backgroundColor: c.ink }]} />
          </View>
        </View>
      );
    case "chart":
      return <BlockChart part={p} accent={accent} />;
    case "table":
      return (
        <Table
          header={p.columns.map((text) => [{ kind: "text", text }])}
          rows={p.rows.map((row) => row.map((text) => [{ kind: "text", text }]))}
          align={p.columns.map(() => "left")}
          surface={c.raised}
        />
      );
    case "more":
      return <More label={p.label} parts={p.parts} values={values} accent={accent} />;
    case "row":
      return (
        <View style={styles.row}>
          {p.parts.map((child) => (
            <View key={child.key} style={styles.rowItem}>
              <Part part={child} values={values} accent={accent} />
            </View>
          ))}
        </View>
      );
    case "card": {
      const inner = (
        <>
          {p.label || p.sub ? (
            <View style={styles.cardHead}>
              {p.label ? (
                <Text variant="subhead" style={styles.bold}>
                  {p.label}
                </Text>
              ) : null}
              {p.sub ? (
                <Text variant="footnote" tone="faint">
                  {p.sub}
                </Text>
              ) : null}
            </View>
          ) : null}
          <Parts parts={p.parts} values={values} accent={accent} />
        </>
      );
      const look = [
        styles.card,
        { backgroundColor: c.raised, borderColor: p.selected ? c.ink : c.line2 },
        p.selected ? styles.cardOn : null,
      ];
      if (!p.pick) return <View style={look}>{inner}</View>;
      const pick = p.pick;
      return (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: p.selected }}
          onPress={() => {
            haptics.selection();
            values.set({ [pick.name]: pick.value });
          }}
          style={({ pressed }) => [look, pressed ? styles.pressed : null]}
        >
          {inner}
        </Pressable>
      );
    }
    case "actions":
      return (
        <View
          style={[
            styles.actions,
            { justifyContent: p.align === "center" ? "center" : p.align === "start" ? "flex-start" : "flex-end" },
          ]}
        >
          {p.buttons.map((b) => (
            <Button
              key={b.key}
              variant={b.lead ? "primary" : "secondary"}
              size="sm"
              label={b.label}
              onPress={() => {
                tapHaptic();
                if (b.set) values.set(b.set);
                if (b.draw) void values.draw(b.draw.name, b.draw.options);
              }}
            />
          ))}
        </View>
      );
  }
}

function Label({ text, value }: { text: string; value?: string }) {
  return (
    <View style={styles.label}>
      <Text variant="footnote" tone="muted" style={[styles.flex, styles.semi]}>
        {text}
      </Text>
      {value !== undefined ? (
        <Text variant="footnote" style={[styles.bold, styles.number]}>
          {value}
        </Text>
      ) : null}
    </View>
  );
}

const THUMB = 22;

/**
 * The kit's slider on the phone: a track that fills with ink and a cut-corner thumb, dragged sideways (a vertical
 * drag stays the conversation's scroll) or tapped. It snaps to the part's step and says each new value as it lands.
 */
function Slider({
  part,
  onChange,
}: {
  part: Extract<BlockViewPart, { kind: "slider" }>;
  onChange: (value: number) => void;
}) {
  const c = useColors();
  const [width, setWidth] = useState(0);
  const { min, max, step, value } = part;
  const share = (value - min) / (max - min);
  const x = useSharedValue(share);
  const track = useSharedValue(0);
  const dragging = useSharedValue(false);
  useEffect(() => {
    if (!dragging.value) x.value = share;
  }, [share, x, dragging]);
  const last = useRef(value);
  const shareNow = useRef(share);
  shareNow.current = share;
  // Let go between two steps: the thumb lands on the step the value took.
  const settle = () => {
    x.value = withTiming(shareNow.current, { duration: 120 });
  };
  const land = (to: number) => {
    const exact = min + Math.round((to * (max - min)) / step) * step;
    const next = Number(Math.min(max, Math.max(min, exact)).toFixed(10));
    if (next === last.current) return;
    last.current = next;
    haptics.selection();
    onChange(next);
  };
  const follow = (px: number) => {
    "worklet";
    const w = track.value;
    if (w <= 0) return;
    const to = Math.min(1, Math.max(0, (px - THUMB / 2) / Math.max(1, w - THUMB)));
    x.value = to;
    scheduleOnRN(land, to);
  };
  const pan = usePanGesture({
    // Sideways only: a vertical drag stays the conversation's scroll.
    activeOffsetX: [-3, 3],
    failOffsetY: [-14, 14],
    maxPointers: 1,
    onActivate: (e) => {
      "worklet";
      dragging.value = true;
      follow(e.x);
    },
    onUpdate: (e) => {
      "worklet";
      follow(e.x);
    },
    onDeactivate: () => {
      "worklet";
      dragging.value = false;
      scheduleOnRN(settle);
    },
  });
  const tap = useTapGesture({
    onDeactivate: (e) => {
      "worklet";
      if (e.canceled) return;
      follow(e.x);
      scheduleOnRN(settle);
    },
  });
  const gesture = useExclusiveGestures(pan, tap);
  const fill = useAnimatedStyle(() => ({ width: THUMB / 2 + x.value * Math.max(0, track.value - THUMB) }));
  const thumb = useAnimatedStyle(() => ({ transform: [{ translateX: x.value * Math.max(0, track.value - THUMB) }] }));
  const nudge = (by: number) => onChange(Math.min(max, Math.max(min, Number((value + by).toFixed(10)))));
  return (
    <GestureDetector gesture={gesture}>
      <View
        style={styles.slider}
        onLayout={(e) => {
          setWidth(e.nativeEvent.layout.width);
          track.value = e.nativeEvent.layout.width;
        }}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={part.label}
        accessibilityValue={{ text: part.shown }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={(e) => nudge(e.nativeEvent.actionName === "increment" ? step : -step)}
      >
        <View style={[styles.rail, { backgroundColor: c.line2 }]} />
        {width > 0 ? (
          <>
            <Animated.View style={[styles.rail, { backgroundColor: c.ink }, fill]} />
            <Animated.View style={[styles.thumb, { borderColor: c.line2 }, thumb]} />
          </>
        ) : null}
      </View>
    </GestureDetector>
  );
}

function Field({
  part,
  onChange,
}: {
  part: Extract<BlockViewPart, { kind: "field" }>;
  onChange: (value: string) => void;
}) {
  const c = useColors();
  const big = part.input === "textarea";
  return (
    <View>
      <Label text={part.label} />
      <TextInput
        value={part.value}
        onChangeText={onChange}
        placeholder={part.placeholder}
        placeholderTextColor={c.faint}
        multiline={big}
        keyboardType={part.input === "number" ? "decimal-pad" : "default"}
        accessibilityLabel={part.label}
        style={[
          styles.field,
          fieldText("body"),
          { color: c.ink, backgroundColor: c.raised, borderColor: c.line2 },
          big ? styles.fieldBig : null,
        ]}
      />
    </View>
  );
}

function More({
  label,
  parts,
  values,
  accent,
}: {
  label: string;
  parts: BlockViewPart[];
  values: Values;
  accent: AgentColorName;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => {
          tapHaptic();
          setOpen((o) => !o);
        }}
        hitSlop={8}
        style={styles.moreHead}
      >
        <Text variant="footnote" tone="muted" style={styles.bold}>
          {open ? "▾" : "▸"} {label || t("mobile.blocks.more")}
        </Text>
      </Pressable>
      {open ? (
        <View style={styles.moreBody}>
          <Parts parts={parts} values={values} accent={accent} />
        </View>
      ) : null}
    </View>
  );
}

/** The block's answer, large. A value the server just drew rolls into place, the same moment for everyone. */
function Result({ label, text, change }: { label: string; text: string; change: BlockChange | undefined }) {
  const c = useColors();
  const reduced = useReducedMotion();
  const y = useSharedValue(0);
  const fade = useSharedValue(1);
  const first = useRef(true);
  const drawnAt = change?.drawn ? change.at : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new draw is a new `at`
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!drawnAt || reduced) return;
    y.value = withSequence(withTiming(-28, { duration: 0 }), withSpring(0, { stiffness: 260, damping: 14 }));
    fade.value = withSequence(
      withTiming(0, { duration: 0 }),
      withTiming(1, { duration: 260, easing: Easing.out(Easing.cubic) }),
    );
    haptics.success();
  }, [drawnAt]);
  const rolled = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }], opacity: fade.value }));
  return (
    <View style={[styles.result, { backgroundColor: c.sunken, borderColor: c.line }]}>
      <Text variant="footnote" tone="muted">
        {label}
      </Text>
      <Animated.View style={rolled}>
        <Text variant="title2" style={styles.number} accessibilityLiveRegion="polite">
          {text}
        </Text>
      </Animated.View>
    </View>
  );
}

/** A chart in the block, drawn like a message's chart. Too few points to draw shows nothing. */
function BlockChart({ part, accent }: { part: Extract<BlockViewPart, { kind: "chart" }>; accent: AgentColorName }) {
  const values = part.chart === "pie" ? part.values.map((v) => Math.max(0, v)) : part.values;
  const spec: ChartSpec = {
    type: part.chart,
    title: part.label,
    labels: part.labels,
    series: [{ name: "", values }],
    ...(part.unit ? { unit: part.unit } : {}),
  };
  const enough =
    part.chart === "bar"
      ? values.length >= 1
      : values.length >= 2 && (part.chart !== "pie" || values.some((v) => v > 0));
  if (!enough) return null;
  return (
    <View>
      {part.label ? <Label text={part.label} /> : null}
      <ChartView spec={spec} accent={accent} still />
    </View>
  );
}

const styles = StyleSheet.create({
  body: { gap: 14, paddingHorizontal: 14, paddingTop: 6, paddingBottom: 14 },
  cut: { overflow: "hidden" },
  fade: { position: "absolute", left: 0, right: 0, bottom: 0, height: 56 },
  more: { alignItems: "center", paddingBottom: 8 },
  foot: { gap: 8, padding: 12, borderTopWidth: StyleSheet.hairlineWidth },
  sent: { flexDirection: "row", alignItems: "center", gap: 8 },
  mark: { width: 5, height: 5 },
  broken: { gap: 2, padding: 14 },
  bold: { fontWeight: "600" },
  semi: { fontWeight: "500" },
  heading: { fontWeight: "600" },
  flex: { flex: 1 },
  number: { fontVariant: ["tabular-nums"], fontWeight: "600" },
  list: { gap: 2 },
  listRow: { flexDirection: "row", gap: 8 },
  label: { flexDirection: "row", alignItems: "baseline", gap: 12, marginBottom: 6 },
  slider: { height: 36, justifyContent: "center" },
  rail: { position: "absolute", left: 0, height: 6, borderRadius: 999, right: 0 },
  thumb: {
    position: "absolute",
    left: 0,
    width: THUMB,
    height: THUMB,
    borderTopLeftRadius: 8,
    borderTopRightRadius: 8,
    borderBottomRightRadius: 8,
    borderBottomLeftRadius: 3,
    backgroundColor: "#ffffff",
    borderWidth: StyleSheet.hairlineWidth,
    boxShadow: "0px 2px 5px 0px rgba(23, 23, 22, 0.2)",
  },
  switch: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 36 },
  stats: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  stat: {
    flexGrow: 1,
    flexBasis: 96,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    borderBottomLeftRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
  },
  result: {
    alignItems: "center",
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 12,
    borderRadius: 14,
    borderBottomLeftRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  track: { height: 8, borderRadius: 999, overflow: "hidden" },
  fill: { height: "100%", borderRadius: 999 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  rowItem: { flexGrow: 1, flexBasis: 140, gap: 12 },
  card: {
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 14,
    borderBottomLeftRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
  },
  cardOn: { borderWidth: 1.6 },
  pressed: { opacity: 0.85 },
  cardHead: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", justifyContent: "space-between", gap: 8 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  field: {
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  fieldBig: { minHeight: 88, textAlignVertical: "top" },
  moreHead: { alignSelf: "flex-start", minHeight: 28, justifyContent: "center" },
  moreBody: { gap: 10, marginTop: 6 },
});

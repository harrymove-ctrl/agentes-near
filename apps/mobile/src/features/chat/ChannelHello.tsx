import type { Agent, RosterMember } from "@agenteschat/client";
import { greetingSuggestions } from "@agenteschat/client/lib/chat";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View } from "react-native";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, {
  Easing,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";
import { WorkspaceSky } from "@/sky/Sky";
import { Button, Text, useReducedMotion } from "@/ui";
import { AgentFace, Face } from "../shared/Face";
import { useMeId } from "../shared/hooks";
import { tapHaptic } from "../shared/parts";

/** The channels whose greeting already played while the app runs: the crew rises once, then just stands there. */
const GREETED = new Set<string>();

const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);
/** At most this many members stand on the horizon (agents first, in their colors, then people). */
const CREW = 6;
/** A framed face, the lists' smaller framed size. */
const FACE = 36;
/** The sky band the crew stands on. */
const BAND = 136;

/*
 * The first open, once per channel while the app runs (never blocking a tap):
 *   sky      decoration  0 ms     400 ms  fade only
 *   faces    lead        60 ms →  360 ms  fade + 14 → 8 pt rise; each a little sooner and from less far than the
 *                                         one before (60, 130, 185, 225, 255, 275), so the crew reads as one wave
 *   words    support     160 ms   280 ms  title and line as one beat, 6 pt rise, over the faces' settle
 *   starts   support     230 ms → 240 ms  5/4/4 pt rise (230, 270, 300)
 * Reduced motion: everything together, one 200 ms fade, nothing moves.
 */
const SKY_MS = 400;
const FACE_AT = [60, 130, 185, 225, 255, 275] as const;
const FACE_RISE = [14, 12, 11, 10, 9, 8] as const;
const FACE_MS = 360;
const WORDS_AT = 160;
const WORDS_MS = 280;
const START_AT = [230, 270, 300] as const;
const START_MS = 240;

/** A part that rises into place as its value goes 0 → 1 (opacity only when it doesn't move). */
function useRise(value: SharedValue<number>, rise: number, moves: boolean) {
  return useAnimatedStyle(() => ({
    opacity: value.get(),
    transform: [{ translateY: moves ? (1 - value.get()) * rise : 0 }],
  }));
}

function play(value: SharedValue<number>, at: number, duration: number) {
  value.set(withDelay(at, withTiming(1, { duration, easing: EASE_OUT })));
}

/**
 * A channel with nothing in it yet (ADR 0108): who is in it, standing on the workspace's sky; "Diga oi em #canal" with
 * what the channel is for (its topic, else how to call an agent, as on the web); and three starts as tactile buttons,
 * each addressed to one of its agents (a different one per start while there are several), that agent's face on the
 * button. Tapping a start sends it, as an agent's first conversation does; the composer stays the other way in.
 *
 * The first time a channel shows it while the app runs, the crew rises onto the horizon; later visits and reduced
 * motion draw it in place.
 */
export function ChannelHello({
  channelId,
  channel,
  topic,
  agents,
  members,
  bottomInset,
  keyboardLift,
  onAsk,
}: {
  channelId: string;
  channel: string;
  /** What the channel is for, when someone wrote it. */
  topic?: string | null;
  /** Its agents one may talk to, the first to greet first. */
  agents: Agent[];
  /** Everyone in it (the roster): agents and people. */
  members: RosterMember[];
  /** Room for the composer floating over the bottom. */
  bottomInset: number;
  /** How much of the composer's bottom padding hides behind the open keyboard. */
  keyboardLift: number;
  onAsk: (text: string) => void;
}) {
  const { t } = useTranslation();
  const meId = useMeId();
  const reduced = useReducedMotion();

  // Agents first (their colors carry the sky), then people; never me, I'm the one looking.
  const crew = useMemo(() => {
    const inAgents = members.filter((m) => m.type === "agent");
    const people = members.filter((m) => m.type !== "agent" && m.id !== meId);
    return [...inAgents, ...people].slice(0, CREW);
  }, [members, meId]);

  // Three starts dealt across the agents: one each while there are agents, then around again, each its own words.
  const starts = useMemo(() => {
    if (agents.length === 0) return [];
    return [0, 1, 2].map((i) => {
      const agent = agents[i % agents.length] as Agent;
      const options = greetingSuggestions(t, agent.role);
      return { agent, words: options[i] ?? options[0] ?? "" };
    });
  }, [agents, t]);

  // Decided once, on the first render: whether this visit is the channel's greeting.
  const [greets] = useState(() => !GREETED.has(channelId));
  const moves = greets && !reduced;
  const start = greets ? 0 : 1;
  const sky = useSharedValue(start);
  const words = useSharedValue(start);
  const f0 = useSharedValue(start);
  const f1 = useSharedValue(start);
  const f2 = useSharedValue(start);
  const f3 = useSharedValue(start);
  const f4 = useSharedValue(start);
  const f5 = useSharedValue(start);
  const s0 = useSharedValue(start);
  const s1 = useSharedValue(start);
  const s2 = useSharedValue(start);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the greeting plays once, on mount
  useEffect(() => {
    if (!greets) return;
    GREETED.add(channelId);
    const faces = [f0, f1, f2, f3, f4, f5];
    const buttons = [s0, s1, s2];
    if (reduced) {
      for (const v of [sky, words, ...faces, ...buttons]) play(v, 0, 200);
      return;
    }
    play(sky, 0, SKY_MS);
    faces.forEach((v, i) => {
      play(v, FACE_AT[i] ?? 0, FACE_MS);
    });
    play(words, WORDS_AT, WORDS_MS);
    buttons.forEach((v, i) => {
      play(v, START_AT[i] ?? 0, START_MS);
    });
  }, []);

  const skyIn = useAnimatedStyle(() => ({ opacity: sky.get() }));
  const faceIn = [
    useRise(f0, FACE_RISE[0], moves),
    useRise(f1, FACE_RISE[1], moves),
    useRise(f2, FACE_RISE[2], moves),
    useRise(f3, FACE_RISE[3], moves),
    useRise(f4, FACE_RISE[4], moves),
    useRise(f5, FACE_RISE[5], moves),
  ];
  const wordsIn = useRise(words, 6, moves);
  const startIn = [useRise(s0, 5, moves), useRise(s1, 4, moves), useRise(s2, 4, moves)];

  // The composer rides the keyboard; the greeting gives way with it instead of staying under the keys.
  const keyboard = useReanimatedKeyboardAnimation();
  const above = useAnimatedStyle(() => ({ paddingBottom: Math.max(0, -keyboard.height.get() - keyboardLift) }));

  const line = topic?.trim() ? topic.trim() : t("chat.sayHiText");

  return (
    <Animated.View style={[styles.grow, above]}>
      <ScrollView
        style={styles.grow}
        contentContainerStyle={[styles.content, { paddingBottom: bottomInset + 16 }]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        {crew.length > 0 ? (
          <View style={styles.band} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <Animated.View style={[StyleSheet.absoluteFill, skyIn]}>
              {/* A band in the middle of the screen: it comes in from nothing over its top half and goes back to the
                  page from 60 % down, so the horizon never starts on a hard line. */}
              <WorkspaceSky fadeTop={0.5} fade={0.6} style={styles.fill} />
            </Animated.View>
            <View style={styles.crew}>
              {crew.map((m, i) => (
                <Animated.View key={`${m.type}:${m.id}`} style={faceIn[i]}>
                  {m.type === "agent" ? (
                    <AgentFace agentId={m.id} size={FACE} framed />
                  ) : (
                    <Face who={{ type: m.type, id: m.id }} size={FACE} />
                  )}
                </Animated.View>
              ))}
            </View>
          </View>
        ) : null}
        <Animated.View style={[styles.words, wordsIn]}>
          <Text variant="title2" style={styles.center} accessibilityRole="header">
            {t("chat.sayHiChannel", { channel })}
          </Text>
          <Text variant="subhead" tone="muted" style={styles.center} numberOfLines={3}>
            {line}
          </Text>
        </Animated.View>
        {starts.length > 0 ? (
          <View style={styles.starts}>
            {starts.map((s, i) => (
              <Animated.View key={`${s.agent.id}:${s.words}`} style={startIn[i]}>
                <Button
                  variant="secondary"
                  size="sm"
                  label={`${s.agent.name}, ${lowerFirst(s.words)}`}
                  hint={t("mobile.chat.intent.sendHint")}
                  leading={() => <AgentFace agentId={s.agent.id} size={20} />}
                  onPress={() => {
                    tapHaptic();
                    onAsk(`@${s.agent.handle} ${s.words}`);
                  }}
                />
              </Animated.View>
            ))}
          </View>
        ) : null}
      </ScrollView>
    </Animated.View>
  );
}

/** After the agent's name the start goes on in lower case ("Bruno, resume o que rolou hoje"), unless it opens with an
 * acronym. */
function lowerFirst(s: string) {
  const first = s.charAt(0);
  const second = s.charAt(1);
  if (!first || (second && second === second.toUpperCase() && second !== second.toLowerCase())) return s;
  return first.toLowerCase() + s.slice(1);
}

const styles = StyleSheet.create({
  grow: { flex: 1 },
  fill: { flex: 1 },
  // The greeting sits at the bottom, over the composer, where a conversation's latest message is.
  content: { flexGrow: 1, justifyContent: "flex-end", paddingTop: 8 },
  band: { height: BAND, marginBottom: 16, justifyContent: "flex-end" },
  // The crew centered on the horizon, 8 apart, standing 16 above the band's foot.
  crew: { flexDirection: "row", justifyContent: "center", gap: 8, paddingHorizontal: 16, paddingBottom: 16 },
  words: { gap: 8, paddingHorizontal: 32 },
  center: { textAlign: "center" },
  // Three tactile starts, wrapping and centered under the words, 8 apart, 24 under the line.
  starts: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 8,
    marginTop: 24,
    paddingHorizontal: 16,
  },
});

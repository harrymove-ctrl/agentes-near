import { type Agent, useMe } from "@agenteschat/client";
import { firstName } from "@agenteschat/client/lib/format";
import { playSound } from "@agenteschat/client/lib/sounds";
import { modeKey } from "@agenteschat/client/lib/workspace-mode";
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
import { useOrg } from "@/providers/org";
import { Button, Text, useReducedMotion } from "@/ui";
import { AgentFace } from "../shared/Face";
import { useColors } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { tapHaptic } from "../shared/parts";
import { agentIntro, firstAskKind, firstAsks, isNewAgent } from "./intent";
import { CHAT_TEXT_MAX_SCALE, chatNameOf, chatTimeOf, MSG_AVATAR, MSG_GAP, MSG_INSET } from "./logic";
import { lookRows, useConversationLook } from "./look";

/** The agents whose first message already arrived while the app runs: it wakes and lands once, then just is. */
const ARRIVED = new Set<string>();

const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);
/** The face sleeps this long before it wakes and its words land. */
const WAKE_MS = 420;
/** The words: a short rise on the strong ease-out. */
const WORDS_MS = 280;
const WORDS_RISE = 8;
/**
 * The starts follow the words (overlap, never a queue): the first a beat after them, each next one sooner and from
 * less far, so the three read as one wave rather than a metronome.
 */
const START_AFTER = [120, 180, 220] as const;
const START_RISE = [6, 5, 4] as const;
const START_MS = 240;

/** A part that rises into place as its value goes from 0 to 1 (only opacity under reduced motion). */
function useRise(value: SharedValue<number>, rise: number, moves: boolean) {
  return useAnimatedStyle(() => ({
    opacity: value.get(),
    transform: [{ translateY: moves ? (1 - value.get()) * rise : 0 }],
  }));
}

/**
 * An agent's first conversation, before anyone wrote: its first message, drawn by the app and never stored. The face,
 * its name, what it does and "agora", a greeting in its words (what it does, else its role) and "Por onde começamos?",
 * then three starts as tactile buttons with short words; a tap sends the whole request and the conversation begins.
 * The composer stays the other way in.
 *
 * For a new agent, the first time its conversation opens while the app runs, the message arrives: the face sleeps a
 * beat and wakes, the words rise in with the reply's sound, and the starts land after them. Later visits, an older
 * agent and reduced motion draw it in place (reduced motion keeps a short fade, no movement, no wait).
 */
export function FirstDay({
  agent,
  bottomInset,
  keyboardLift,
  onAsk,
}: {
  agent: Agent;
  /** Room for the composer floating over the bottom. */
  bottomInset: number;
  /** How much of the composer's bottom padding hides behind the open keyboard. */
  keyboardLift: number;
  onAsk: (text: string) => void;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const me = useMe();
  const { org } = useOrg();
  const reduced = useReducedMotion();
  const look = useConversationLook(true, agentLook(agent).color);
  const text = look.text ?? undefined;
  const nameSize = look.text ? chatNameOf(look.text) : undefined;
  const timeSize = look.text ? chatTimeOf(look.text) : undefined;
  const bubbled = look.style === "bubbles";

  const kind = firstAskKind(agent);
  const asks = useMemo(() => firstAsks(agent), [agent]);
  const intro = agentIntro(agent);
  const person = firstName(me.data?.user.name ?? "");
  const hello = person
    ? t("mobile.chat.intent.hello", { person, name: agent.name })
    : t("mobile.chat.intent.helloNoName", { name: agent.name });
  // A personal workspace's agent is there for its person, not on a team (ADR 0159).
  const about =
    intro.kind === "what"
      ? intro.text
      : intro.kind === "role"
        ? t(modeKey(org, "mobile.chat.intent.helloRole"), { role: intro.role })
        : null;
  const words = [hello, about, t("mobile.chat.intent.helloAsk")].filter(Boolean).join(" ");

  // Decided once, on the first render: whether this visit is the arrival.
  const [arrives] = useState(() => isNewAgent(agent.createdAt) && !ARRIVED.has(agent.id));
  const plays = arrives && !reduced;
  const [awake, setAwake] = useState(!plays);
  const shown = useSharedValue(arrives ? 0 : 1);
  const start0 = useSharedValue(arrives ? 0 : 1);
  const start1 = useSharedValue(arrives ? 0 : 1);
  const start2 = useSharedValue(arrives ? 0 : 1);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the arrival plays once, on mount
  useEffect(() => {
    if (!arrives) return;
    ARRIVED.add(agent.id);
    const starts = [start0, start1, start2];
    if (reduced) {
      // Everything together: a short fade, no movement and no wait.
      const fade = { duration: 200, easing: EASE_OUT };
      shown.set(withTiming(1, fade));
      for (const s of starts) s.set(withTiming(1, fade));
      return;
    }
    shown.set(withDelay(WAKE_MS, withTiming(1, { duration: WORDS_MS, easing: EASE_OUT })));
    starts.forEach((s, i) => {
      s.set(withDelay(WAKE_MS + START_AFTER[i as 0 | 1 | 2], withTiming(1, { duration: START_MS, easing: EASE_OUT })));
    });
    // The face wakes on the frame its words start, with the reply's sound: one cue for one arrival.
    const wake = setTimeout(() => {
      setAwake(true);
      playSound("reply");
    }, WAKE_MS);
    return () => clearTimeout(wake);
  }, []);

  const wordsIn = useRise(shown, WORDS_RISE, plays);
  const startIn = [
    useRise(start0, START_RISE[0], plays),
    useRise(start1, START_RISE[1], plays),
    useRise(start2, START_RISE[2], plays),
  ];

  // The composer rides the keyboard; the message gives way with it instead of staying under the keys.
  const keyboard = useReanimatedKeyboardAnimation();
  const above = useAnimatedStyle(() => ({ paddingBottom: Math.max(0, -keyboard.height.get() - keyboardLift) }));

  const body = (
    <Text variant="body" tone="ink" style={text} maxFontSizeMultiplier={text ? CHAT_TEXT_MAX_SCALE : undefined}>
      {words}
    </Text>
  );

  return (
    <Animated.View style={[styles.grow, above]}>
      <ScrollView
        style={styles.grow}
        contentContainerStyle={[styles.content, { paddingBottom: bottomInset + 16 }]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        <View style={styles.row}>
          <View style={styles.avatar}>
            <AgentFace agentId={agent.id} size={MSG_AVATAR} mode={awake ? "idle" : "sleep"} />
          </View>
          <View style={styles.body}>
            <Animated.View style={wordsIn}>
              {/* Name, what it does and when, on the face's top line, as every message's. */}
              <View style={styles.who}>
                <Text
                  variant="footnote"
                  tone="ink2"
                  style={[styles.name, nameSize]}
                  numberOfLines={1}
                  maxFontSizeMultiplier={nameSize ? CHAT_TEXT_MAX_SCALE : undefined}
                >
                  {agent.name}
                </Text>
                {agent.role ? (
                  <Text
                    variant="footnote"
                    tone="faint"
                    style={[styles.shrink, timeSize]}
                    numberOfLines={1}
                    maxFontSizeMultiplier={timeSize ? CHAT_TEXT_MAX_SCALE : undefined}
                  >
                    {agent.role}
                  </Text>
                ) : null}
                <Text
                  variant="footnote"
                  tone="faint"
                  style={[styles.time, timeSize]}
                  maxFontSizeMultiplier={timeSize ? CHAT_TEXT_MAX_SCALE : undefined}
                >
                  {t("mobile.chat.intent.now")}
                </Text>
              </View>
              {bubbled ? <View style={[lookRows.bubble, { backgroundColor: c.bubble }]}>{body}</View> : body}
            </Animated.View>
            <View style={styles.starts}>
              {asks.map((a, i) => {
                const step = a.key.split(".")[1];
                return (
                  <Animated.View key={a.key} style={startIn[i]}>
                    <Button
                      variant="secondary"
                      size="sm"
                      label={t(`mobile.chat.intent.start.${kind}.${step}`)}
                      onPress={() => {
                        tapHaptic();
                        onAsk(t(`mobile.chat.intent.first.${a.key}`));
                      }}
                    />
                  </Animated.View>
                );
              })}
            </View>
          </View>
        </View>
      </ScrollView>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1 },
  // The message sits at the bottom, over the composer, where a conversation's latest message is.
  content: { flexGrow: 1, justifyContent: "flex-end", paddingTop: 8 },
  // The chat's row: the face at the inset, the words on the chat's text column (MSG_TEXT).
  row: { flexDirection: "row", gap: MSG_GAP, paddingLeft: MSG_INSET, paddingRight: 16 },
  avatar: { width: MSG_AVATAR },
  body: { flex: 1, minWidth: 0 },
  // The name's line on the face's top: its first line and the face start together, as in MessageRow.
  who: { flexDirection: "row", alignItems: "baseline", gap: 6, marginBottom: 2 },
  name: { fontWeight: "600", fontSize: 14, lineHeight: 19, flexShrink: 0, maxWidth: "60%" },
  shrink: { flexShrink: 1 },
  time: { flexShrink: 0, fontVariant: ["tabular-nums"] },
  // Three starts under the words: tactile buttons on the 8 rhythm, wrapping as the words need.
  starts: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12 },
});
